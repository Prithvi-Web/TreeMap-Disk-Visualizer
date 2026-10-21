import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-autopilotAdvisory-data-');
process.env.TREEMAP_NO_GDU = '1';

import { approvePolicyForTests, listPolicies, runPolicy, savePolicies, selectCandidates, simulatePolicy } from '../src/services/autopilot';
import { loadRuleCatalog, loadRuleCatalogFrom } from '../src/services/rulePacks';
import { setTrashStepForTests } from '../src/services/cleaner';
import { readJsonFile, writeJsonFile } from '../src/services/storage';
import { AppError } from '../src/middleware/errorHandler';
import type { AutopilotPolicy, AutopilotRun, CleanupSuggestionGroup } from '../src/models/types';
import { withOpenFileCheck } from './fixtures/openFileCheck';
import { INDEX, lift } from './fixtures/liftFrontend';
import { collectCleanupSuggestions } from '../src/services/cleanupRules';
import type { FileNode } from '../src/models/types';

/**
 * A group whose rule only advises (`advisory: true`: a VM disk, Xcode archives, a photo library's
 * derivatives — the file is the data, or the OS owns it) "must never be deleted" (AGENTS.md). Clean Up
 * offers no cart button for one, but an Autopilot suggestion policy took any group id it was given and
 * selected its items like any other's: saved through the API with ['docker-vm-image'], an approved
 * policy trashed the Docker disk image unattended (the final review, F1.11). Now such an id is refused
 * where a person saves it, and a run leaves an advisory group's items alone, saying so.
 *
 * Nothing reaches the machine's Trash: the trash step moves each original into this file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-autopilotAdvisory-trash-');
const trashed: string[] = [];

before(() => {
  setTrashStepForTests(async (p) => {
    trashed.push(p);
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashed.length}-${path.basename(p)}`));
  });
});

after(() => {
  setTrashStepForTests(null);
});

/** Every rule id this platform's packs mark advice-only. */
function advisoryIds(): string[] {
  const c = loadRuleCatalog();
  return [...c.projectDirectory, ...c.directory, ...c.file, ...c.location, ...c.staleFiles].filter((r) => r.action === 'advice').map((r) => r.id);
}

test('a suggestion policy naming an advice-only group is refused where it is saved, naming the group', async () => {
  const [advice] = advisoryIds();
  assert.ok(advice, 'this platform\'s packs have an advice-only rule');
  const dir = fileTempDir('treemap-autopilotAdvisory-save-');
  let refused: unknown = null;
  try {
    await savePolicies([{ id: 'adv', name: 'Docker', path: dir, match: { kind: 'suggestion', groupIds: ['regen-node-modules', advice] }, dryRunFirst: false, enabled: true }]);
  } catch (err) {
    refused = err;
  }
  assert.ok(refused instanceof AppError, String(refused));
  assert.equal(refused.code, 'POLICY_MATCH_ADVISORY', refused.message);
  assert.equal(refused.status, 400);
  assert.match(refused.message, /never deletes/, refused.message);
  assert.deepEqual(await listPolicies(), [], 'nothing was saved');
});

test('an advice-only group is never selected, whatever the policy asks for', () => {
  const group = (id: string, advisory: boolean): CleanupSuggestionGroup => ({
    id, title: id, description: 'a test group', category: 'cache', totalSize: 10, items: [{ path: `/x/${id}`, name: id, size: 10 }],
    ...(advisory ? { advisory: true, adviceCommand: 'use the app' } : {}),
  } as unknown as CleanupSuggestionGroup);
  const picked = selectCandidates([group('vm-disk', true), group('cache', false)], [], { kind: 'suggestion', groupIds: ['vm-disk', 'cache'] });
  assert.deepEqual(picked.map((c) => c.path), ['/x/cache']);
});

/** A folder or file node at `at`, as the walk reads one; a folder's size is its children's. */
function node(at: string, name: string, kids?: FileNode[]): FileNode {
  const here = path.join(at, name);
  if (!kids) return { name, path: here, size: 4_000, type: 'file', modifiedAt: 0, isHidden: name.startsWith('.') };
  return { name, path: here, type: 'dir', modifiedAt: 0, isHidden: name.startsWith('.'), size: kids.reduce((n, k) => n + k.size, 0), children: kids };
}

test('every kind the policy editor offers is a rule the packs ship on every platform, none advice-only, and a policy of all of them selects one of each (BQL-b1 review F2.6)', () => {
  // Three of its six boxes named ids no pack has - "Web build output"
  // (regen-build-output), "Application caches" (cache-general), "Junk files"
  // (junk-general) - and a policy saved, approved and run from them reported
  // "Nothing matched" every time: the evaluator never matches an unknown id.
  const offered = lift<Array<{ id: string; label: string; hint: string }>>(['AP_GROUPS'], 'AP_GROUPS');
  const packs = path.join(__dirname, '..', 'src', 'services', 'rulepacks');
  const rulesOf = (pack: string): Array<{ id: string; action?: string }> => JSON.parse(fs.readFileSync(path.join(packs, `${pack}.json`), 'utf8')).rules;
  for (const platform of ['macos', 'linux', 'windows']) {
    const rules = [...rulesOf('common'), ...rulesOf(platform)];
    for (const g of offered) {
      const named = rules.filter((r) => r.id === g.id);
      assert.ok(named.length > 0, `${platform}: the box "${g.label}" names ${g.id}, a rule the packs ship`);
      assert.ok(named.every((r) => r.action !== 'advice'), `${platform}: the box "${g.label}" names no advice-only group (${g.id})`);
    }
  }
  // Through the walk and the evaluator a run uses, on this machine.
  const all = { kind: 'suggestion' as const, groupIds: offered.map((g) => g.id) };
  const proj = path.resolve('/apgroups/proj');
  const project = node(path.dirname(proj), 'proj', [
    node(proj, 'node_modules', [node(path.join(proj, 'node_modules'), 'dep.js')]),
    node(proj, '.venv', [node(path.join(proj, '.venv'), 'pyvenv.cfg'), node(path.join(proj, '.venv'), 'lib.bin')]),
    node(proj, 'requirements.txt'), node(proj, 'Cargo.toml'), node(proj, 'package.json'),
    node(proj, 'target', [node(path.join(proj, 'target'), 'o.rlib')]),
    node(proj, '.next', [node(path.join(proj, '.next'), 'b.js')]),
    node(proj, '.pytest_cache', [node(path.join(proj, '.pytest_cache'), 'v.json')]),
    node(proj, '.DS_Store'),
  ]);
  const picked = selectCandidates(collectCleanupSuggestions(project, []), [], all).map((c) => path.basename(c.path)).sort();
  assert.deepEqual(picked, ['.DS_Store', '.next', '.pytest_cache', '.venv', 'node_modules', 'target'],
    'a policy of every box selects one of each project kind');
  const catalog = loadRuleCatalog();
  for (const id of ['browser-caches', 'dev-caches']) {
    const at = catalog.location.find((r) => r.id === id)?.paths[0];
    assert.ok(at, `${id}: this platform's packs name a place`);
    const tree = node(path.dirname(path.dirname(at)), path.basename(path.dirname(at)), [node(path.dirname(at), path.basename(at), [node(at, 'data.bin')])]);
    assert.deepEqual(selectCandidates(collectCleanupSuggestions(tree, []), [], all).map((c) => c.path), [at], `${id}: a policy of every box selects ${at}`);
  }
});

/**
 * A tool each Developer caches place belongs to, as its path names it: the box says "Package-manager and
 * tool caches, and Xcode's on a Mac". A place that names none - Windows' whole Temp folder did - is no
 * such cache, and a policy of that box would trash it with the box's words as its reason.
 */
const DEV_CACHE_TOOLS: Record<string, RegExp> = {
  macos: /\/(npm|yarn|pip|homebrew|\.m2|\.cargo|\.gradle|xcode|coresimulator)(\/|$)|\/\.npm\//i,
  linux: /\/(npm|yarn|pip|\.m2|\.cargo|\.gradle)(\/|$)|\/\.npm\//i,
  windows: /\/(npm-cache|yarn|pip|nuget|\.m2|\.cargo)(\/|$)/i,
};

test('the Developer caches box says what its rule names on every platform: package-manager and tool caches, never Windows\' Temp folder, which is advice only (BQL-b1 review F3.2)', () => {
  const hint = lift<Array<{ id: string; hint: string }>>(['AP_GROUPS'], 'AP_GROUPS').find((g) => g.id === 'dev-caches')?.hint ?? '';
  assert.match(hint, /^Package-manager and tool caches, and Xcode's on a Mac/, 'the box\'s words, which every place below must bear out');
  const packs = path.join(__dirname, '..', 'src', 'services', 'rulepacks');
  for (const platform of ['macos', 'linux', 'windows']) {
    const rules: Array<{ id: string; paths?: string[]; action?: string }> = JSON.parse(fs.readFileSync(path.join(packs, `${platform}.json`), 'utf8')).rules;
    const places = rules.find((r) => r.id === 'dev-caches')?.paths ?? [];
    assert.ok(places.length > 0, `${platform}: the packs name Developer caches places`);
    for (const place of places) {
      assert.match(place, DEV_CACHE_TOOLS[platform], `${platform}: ${place} is a package manager's or a tool's cache, as the box says`);
      if (platform !== 'macos') assert.doesNotMatch(place, /xcode|coresimulator/i, `${platform}: Xcode's caches only on a Mac, as the box says`);
    }
    assert.ok(places.every((p) => !/\/te?mp$/i.test(p)), `${platform}: no temporary folder is a Developer cache: ${places.join(', ')}`);
  }
  // Windows' Temp folder, through the walk and the evaluator a run uses: shown, advice only, never selected.
  const catalog = loadRuleCatalogFrom(packs, 'win32');
  const temp = catalog.location.find((r) => r.paths.some((p) => /[\\/]AppData[\\/]Local[\\/]Temp$/i.test(p)));
  assert.ok(temp, 'the Windows pack still shows the Temp folder');
  assert.equal(temp.action, 'advice', `its rule (${temp.id}) only advises`);
  assert.match(temp.adviceCommand ?? '', /Settings ▸ System ▸ Storage ▸ Temporary files/, 'and says where Windows clears it');
  const at = temp.paths.find((p) => /Temp$/.test(p))!;
  const tree = node(path.dirname(path.dirname(at)), path.basename(path.dirname(at)), [node(path.dirname(at), path.basename(at), [node(at, 'installer-extract.tmp')])]);
  const groups = collectCleanupSuggestions(tree, [], catalog);
  assert.deepEqual(groups.filter((g) => g.items.some((i) => i.path === at)).map((g) => [g.id, g.advisory === true]), [[temp.id, true]], 'it is offered by its advice-only rule alone');
  assert.deepEqual(selectCandidates(groups, [], { kind: 'suggestion', groupIds: ['dev-caches', temp.id] }), [], 'no policy selects it');
});

const LIGHTROOM = process.platform === 'darwin' || process.platform === 'win32' ? false : 'the Lightroom rules are for macOS and Windows';
/** The Lightroom previews rule's own advice (rulepacks/common.json), as a skipped row gives it. */
const INSTEAD = /Instead: Lightroom Classic ▸ Edit ▸ Catalog Settings ▸ File Handling ▸ Automatically Discard 1:1 Previews/;

test('a policy an earlier build saved with an advice-only group is not refused while unchanged, and its runs leave that group alone, saying so', { skip: LIGHTROOM }, async () => {
  const dir = fs.realpathSync(fileTempDir('treemap-autopilotAdvisory-run-'));
  const previews = path.join(dir, 'Lightroom Catalog Previews.lrdata');
  fs.mkdirSync(previews);
  fs.writeFileSync(path.join(previews, 'preview.jpg'), Buffer.alloc(4096, 3));
  // As an earlier build saved it: the refusal is at save time, so it is planted in the store.
  await savePolicies([{ id: 'planted', name: 'Previews', path: dir, match: { kind: 'suggestion', groupIds: ['regen-node-modules'] }, dryRunFirst: false, enabled: true }]);
  const store = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
  store.policies[0].match = { kind: 'suggestion', groupIds: ['media-lightroom-previews'] };
  await writeJsonFile('autopilot.json', store);
  try {
    const [unchanged] = await listPolicies();
    await savePolicies([{ ...unchanged, name: 'Renamed' }]); // an unrelated edit of the list it rides in
    await approvePolicyForTests('planted');
    const preview = await simulatePolicy((await listPolicies())[0]);
    assert.deepEqual(preview.items, [], 'nothing is offered for deletion');
    assert.ok(preview.skipped.some((s) => s.path === previews && /advice only/.test(s.reason)), JSON.stringify(preview.skipped));
    // With the group's own advice, so the refusal says what to do instead (final review F2.10).
    assert.ok(preview.skipped.some((s) => s.path === previews && INSTEAD.test(s.reason)), JSON.stringify(preview.skipped));
    const run = await withOpenFileCheck('clear', async () => runPolicy((await listPolicies())[0]));
    assert.equal(run.bytesDeleted, 0, run.blockedReason);
    assert.deepEqual(trashed, [], 'the Trash step was never reached');
    assert.ok(fs.existsSync(path.join(previews, 'preview.jpg')), 'it is where it was');
    assert.ok(run.skipped.some((s) => s.path === previews && /advice only/.test(s.reason)), JSON.stringify(run.skipped));
    assert.ok(run.skipped.some((s) => s.path === previews && INSTEAD.test(s.reason)), JSON.stringify(run.skipped));
    // Something matched and was left alone, so never "Nothing matched this time." (review round 2, F2.3).
    assert.equal(run.blockedReason, LEFT_ALONE, 'it says why nothing was deleted');
  } finally {
    await savePolicies([]);
  }
});

/**
 * What a run says when everything it matched was left alone, some of it for a reason with no short
 * name of its own. It points at no list: the run's skipped entries carry the reasons, and a page may
 * show only some of them (review round 3, F3.6).
 */
const LEFT_ALONE = 'Everything that matched was left alone — nothing was deleted.';

test('a run that left an advice-only group\'s items alone beside parts of an installed program never says everything it matched was part of an installed program (review round 2, F2.3)', { skip: LIGHTROOM }, async () => {
  const dir = fs.realpathSync(fileTempDir('treemap-autopilotAdvisory-mixed-'));
  const previews = path.join(dir, 'Lightroom Catalog Previews.lrdata');
  fs.mkdirSync(previews);
  fs.writeFileSync(path.join(previews, 'preview.jpg'), Buffer.alloc(4096, 3));
  const inApp = path.join(dir, 'Fake.app', 'Contents', 'Resources', 'app', 'node_modules', 'dep');
  fs.mkdirSync(inApp, { recursive: true });
  fs.writeFileSync(path.join(inApp, 'index.js'), Buffer.alloc(4096, 3));
  // As an earlier build saved it: an advice-only group is refused at save time, so it is planted in the store.
  await savePolicies([{ id: 'planted-mixed', name: 'Previews and build folders', path: dir, match: { kind: 'suggestion', groupIds: ['regen-node-modules'] }, dryRunFirst: false, enabled: true }]);
  const store = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
  store.policies[0].match = { kind: 'suggestion', groupIds: ['media-lightroom-previews', 'regen-node-modules'] };
  await writeJsonFile('autopilot.json', store);
  try {
    await approvePolicyForTests('planted-mixed');
    const run = await withOpenFileCheck('clear', async () => runPolicy((await listPolicies())[0]));
    assert.deepEqual(run.items, [], 'control: nothing is selected');
    assert.ok(run.skipped.some((s) => s.path === previews && /advice only/.test(s.reason)), `control: the advice-only group is left alone: ${JSON.stringify(run.skipped)}`);
    assert.ok(run.skipped.some((s) => /inside the app “Fake”/.test(s.reason)), `control: and the app's own node_modules: ${JSON.stringify(run.skipped)}`);
    assert.equal(run.blockedReason, LEFT_ALONE, 'neither reason alone covers what it left');
    assert.deepEqual(trashed, [], 'the Trash step was never reached');
  } finally {
    await savePolicies([]);
  }
});

/** Every rule id this platform's packs ship that a policy may clean up: none advice-only. */
function trashableIds(): string[] {
  const c = loadRuleCatalog();
  return [...new Set([...c.projectDirectory, ...c.directory, ...c.file, ...c.location, ...c.staleFiles].filter((r) => r.action !== 'advice').map((r) => r.id))];
}

test('a suggestion policy naming a kind no rule here has is refused where it is saved, naming the kinds a policy may name (BQL-b1 review F3.1)', async () => {
  // Three boxes of earlier builds' editor named ids no pack ever shipped
  // (regen-build-output, cache-general, junk-general); the evaluator never
  // matches one, so a policy of them matched nothing on every run.
  const dir = fileTempDir('treemap-autopilotAdvisory-unknown-save-');
  for (const groupIds of [['cache-general'], ['regen-node-modules', 'junk-general']]) {
    let refused: unknown = null;
    try {
      await savePolicies([{ id: 'unknown-kinds', name: 'Old boxes', path: dir, match: { kind: 'suggestion', groupIds }, dryRunFirst: false, enabled: true }]);
    } catch (err) {
      refused = err;
    }
    assert.ok(refused instanceof AppError, String(refused));
    assert.equal(refused.code, 'POLICY_MATCH_UNKNOWN', refused.message);
    assert.equal(refused.status, 400);
    const unknown = groupIds.filter((id) => id !== 'regen-node-modules');
    assert.ok(refused.message.startsWith(`The policy "Old boxes" names “${unknown[0]}”, which is no kind of file TreeMap has on this computer`), refused.message);
    for (const id of trashableIds()) assert.ok(refused.message.includes(id), `it names ${id}, a kind a policy may name: ${refused.message}`);
    assert.ok(!advisoryIds().some((id) => refused.message.includes(id)), `and no advice-only kind, which a policy may not name: ${refused.message}`);
  }
  assert.deepEqual(await listPolicies(), [], 'nothing was saved');
});

/** What a run says of a policy that names cache-general, which no rule has: alone, and beside a kind TreeMap has. */
const ONLY_UNKNOWN = 'This policy names only a kind of file TreeMap does not have (cache-general), so it matches nothing: edit the policy and pick again.';
const ALSO_UNKNOWN = 'This policy also names a kind of file TreeMap does not have (cache-general), which matches nothing: edit the policy and pick again.';

test('a policy an earlier build saved with a kind no rule here has is kept while unchanged, and every run of it says so - never only "Nothing matched" (BQL-b1 review F3.1)', async (t) => {
  const dir = fs.realpathSync(fileTempDir('treemap-autopilotAdvisory-unknown-run-'));
  // The test moves its folder away below; the fixture removes only the name it made (review F2.4).
  t.after(() => fs.rmSync(`${dir}-moved`, { recursive: true, force: true }));
  const deps = path.join(dir, 'proj', 'node_modules', 'dep');
  fs.mkdirSync(deps, { recursive: true });
  fs.writeFileSync(path.join(deps, 'index.js'), Buffer.alloc(4096, 5));
  fs.writeFileSync(path.join(dir, 'proj', 'package.json'), '{}');
  // As an earlier build saved them: the refusal is at save time, so the ids are planted in the store.
  const policy = (id: string) => ({ id, name: id, path: dir, match: { kind: 'suggestion', groupIds: ['regen-node-modules'] }, dryRunFirst: false, enabled: true });
  await savePolicies([policy('old-only'), policy('old-mixed')]);
  const store = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
  store.policies[0].match = { kind: 'suggestion', groupIds: ['cache-general'] };
  store.policies[1].match = { kind: 'suggestion', groupIds: ['regen-node-modules', 'cache-general'] };
  await writeJsonFile('autopilot.json', store);
  const trashedBefore = trashed.length;
  const named = async (id: string): Promise<AutopilotPolicy> => (await listPolicies()).find((p) => p.id === id)!;
  try {
    const listed = await listPolicies();
    await assert.doesNotReject(savePolicies(listed.map((p) => ({ ...p, name: `${p.name} (renamed)` }))), 'an unrelated edit of the list they ride in is not refused');
    assert.deepEqual((await listPolicies()).map((p) => p.match), store.policies.map((p) => p.match), 'an unchanged policy is kept as it was saved');
    let refused: unknown = null;
    try {
      await savePolicies([{ ...listed[0], path: path.join(dir, 'proj') }]);
    } catch (err) {
      refused = err;
    }
    assert.equal((refused as AppError | null)?.code, 'POLICY_MATCH_UNKNOWN', `a changed one is judged as a new one: ${String(refused)}`);

    await approvePolicyForTests('old-only');
    const only = await withOpenFileCheck('clear', async () => runPolicy(await named('old-only')));
    assert.deepEqual(only.items, [], 'control: it selects nothing');
    assert.equal(only.blockedReason, ONLY_UNKNOWN, 'it says the policy names a kind TreeMap does not have, not only that nothing matched');

    await approvePolicyForTests('old-mixed');
    const mixed = await withOpenFileCheck('clear', async () => runPolicy(await named('old-mixed')));
    assert.deepEqual(mixed.items.map((i) => i.path), [path.join(dir, 'proj', 'node_modules')], 'control: the kind it has is cleaned up as before');
    assert.equal(trashed.length, trashedBefore + 1, 'control: through the Trash step');
    assert.equal(mixed.blockedReason, ALSO_UNKNOWN, 'and the run says what else the policy names');
    const again = await withOpenFileCheck('clear', async () => runPolicy(await named('old-mixed'), { ignoreCooldown: true }));
    assert.equal(again.blockedReason, `Nothing matched this time. ${ALSO_UNKNOWN}`, 'nothing left to match: it says both');
    // A run that failed says it too, as a sentence of its own after the failure's.
    fs.renameSync(dir, `${dir}-moved`);
    const failed = await withOpenFileCheck('clear', async () => runPolicy(await named('old-only'), { ignoreCooldown: true }));
    assert.equal(failed.status, 'failed', `control: its folder is gone: ${failed.blockedReason}`);
    const reason = failed.blockedReason ?? '';
    assert.ok(reason.endsWith(`. ${ONLY_UNKNOWN}`) && !reason.startsWith('This policy') && !reason.includes(`.. ${ONLY_UNKNOWN}`),
      `it follows the failure's own words, as a sentence of its own: ${reason}`);
  } finally {
    await savePolicies([]);
  }
});

/** The page's own declarations, as they ship, by name: a function, or a `const`. */
function pageDecl(name: string): string {
  const fn = INDEX.search(new RegExp(`\\n(async )?function ${name}\\(`));
  const at = fn !== -1 ? fn + 1 : INDEX.indexOf(`\nconst ${name} =`) + 1;
  assert.ok(at > 0, `${name} is in the page`);
  const open = INDEX.indexOf(fn !== -1 ? '{' : '[', fn !== -1 ? INDEX.indexOf(')', at) : at);
  const [o, c] = fn !== -1 ? ['{', '}'] : ['[', ']'];
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === o) depth++;
    else if (INDEX[i] === c && --depth === 0) return INDEX.slice(at, i + 1) + (fn === -1 ? ';' : '');
  }
  assert.fail(`${name} does not close`);
}

test('a policy naming a kind TreeMap does not have says so on its card and in its editor, and counts only the kinds it has (BQL-b1 review F3.1, F3.5)', async () => {
  const html: Record<string, string> = {};
  const $ = (id: string) => ({ set innerHTML(v: string) { html[id] = v; }, get innerHTML() { return html[id] ?? ''; } });
  const served = { policies: [], knownGroupIds: ['regen-node-modules', 'regen-python-venv', 'old-downloads', 'tool-caches'] };
  const state: { autopilot: { policies?: unknown; runs?: unknown; knownGroupIds?: unknown } } = { autopilot: {} };
  const page = new Function('state', '$', 'api', 'fxApBreatheSync', 'renderAutopilot',
    ['escapeHtml', 'AP_GROUPS', 'apUnknownKinds', 'apKindsKnown', 'apCannotTell', 'apKinds', 'describeMatch', 'renderApGroupList', 'loadAutopilot'].map(pageDecl).join('\n') +
    '\nreturn { describeMatch, renderApGroupList, loadAutopilot };',
  )(state, $, async (url: string) => (url.startsWith('/api/autopilot/runs') ? { runs: [] } : served), () => undefined, () => undefined) as {
    describeMatch: (m: unknown) => string; renderApGroupList: (ids: string[]) => void; loadAutopilot: () => Promise<void>;
  };
  await page.loadAutopilot();
  assert.deepEqual(state.autopilot.knownGroupIds, served.knownGroupIds, 'the page keeps the kinds the server says this computer has');

  // The card: a stored policy of the three retired boxes.
  const card = (groupIds: string[]) => page.describeMatch({ kind: 'suggestion', groupIds });
  assert.equal(card(['cache-general', 'junk-general', 'regen-build-output']), 'only 3 kinds of file TreeMap does not have — edit it and pick again',
    'a policy of the three retired boxes says it names only kinds TreeMap does not have');
  assert.equal(card(['regen-node-modules', 'cache-general']), '1 kind of reclaimable file, and 1 kind of file TreeMap does not have — edit it and pick again',
    'a kind it has beside one it does not: each is said');
  assert.equal(card(['regen-node-modules', 'old-downloads']), '2 kinds of reclaimable file', 'control: a kind TreeMap has is a kind, listed in the editor or not');

  // The editor: the boxes it ticks, and a line for what it cannot show.
  page.renderApGroupList(['regen-node-modules', 'cache-general', 'old-downloads']);
  const list = html.apGroupList ?? '';
  assert.ok(list.includes('This policy names a kind of file TreeMap does not have (cache-general), which matches nothing, and a kind of file this list does not offer (old-downloads). Saving keeps only the kinds ticked below.'), `the editor says what its boxes cannot show: ${list}`);
  assert.match(list, /data-ap-group="regen-node-modules" checked/, 'control: the kind it has and the list offers is ticked');
  page.renderApGroupList(['regen-node-modules']);
  assert.doesNotMatch(html.apGroupList ?? '', /This policy names/, 'control: a policy of offered kinds gets no such line');
  page.renderApGroupList(['<img src=x onerror=alert(1)>']);
  assert.ok((html.apGroupList ?? '').includes('(&lt;img src=x onerror=alert(1)&gt;)') && !(html.apGroupList ?? '').includes('<img'), `an id is escaped: ${html.apGroupList}`);

  // Packs the server could not read: no id is counted as a kind TreeMap has, and the card and the editor say
  // plainly that it cannot tell (BQR-1 item 17: the card counted every named id as a kind of reclaimable file).
  served.knownGroupIds = 'unreadable' as unknown as string[];
  await page.loadAutopilot();
  assert.equal(state.autopilot.knownGroupIds, null, 'a list that is not one is no list');
  assert.equal(card(['cache-general']), '1 kind of file — TreeMap could not read its rule packs, so it cannot tell whether it has it',
    'with no list, the card says it cannot judge the kind, never that it is one');
  assert.equal(card(['regen-node-modules', 'cache-general']), '2 kinds of file — TreeMap could not read its rule packs, so it cannot tell which of them it has',
    'in the plural, the boxes\' own kinds among them');
  page.renderApGroupList(['regen-node-modules', 'cache-general']);
  assert.ok((html.apGroupList ?? '').includes('This policy names a kind of file this list does not offer (cache-general), and TreeMap could not read its rule packs, so it cannot tell whether it has it. Saving keeps only the kinds ticked below.'),
    `the editor says it cannot tell either: ${html.apGroupList}`);
  page.renderApGroupList(['regen-node-modules']);
  assert.doesNotMatch(html.apGroupList ?? '', /This policy names/, 'control: a policy of offered kinds gets no such line');
  served.knownGroupIds = ['regen-node-modules'];
  await page.loadAutopilot();
  assert.equal(card(['regen-node-modules']), '1 kind of reclaimable file', 'control: the list back, the kind is counted');
});
