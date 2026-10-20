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
import { lift } from './fixtures/liftFrontend';
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
