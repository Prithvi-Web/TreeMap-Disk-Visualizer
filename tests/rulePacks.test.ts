import { test } from 'node:test';
import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

isolatedDataDir('treemap-rulePacks-data-');

import {
  PACK_NAMES,
  RULEPACK_SCHEMA_VERSION,
  RulePackError,
  loadRuleCatalogFrom,
  matchReasonFor,
  packForPlatform,
  validateRulePack,
} from '../src/services/rulePacks';
import { collectCleanupSuggestions } from '../src/services/cleanupRules';
import { FileNode } from '../src/models/types';

/**
 * §C8 — the rule-pack catalog itself.
 *
 * The behavioural half of C8 ("every existing suggestion still fires") lives in
 * cleanupRules.test.ts and was written before the refactor. This file covers
 * the catalog: that the shipped packs are valid on every OS, that a malformed
 * pack fails loudly and completely rather than half-loading, and — the other
 * acceptance criterion — that adding a rule to a pack with no code change
 * produces a new suggestion.
 */

const SHIPPED = path.join(__dirname, '..', 'src', 'services', 'rulepacks');

function readShipped(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(SHIPPED, `${name}.json`), 'utf8'));
}

/* ───────────────────── The shipped packs ───────────────────── */

test('every shipped pack is valid, on any OS', () => {
  // Deliberately OS-agnostic: a macOS machine must still catch a broken
  // windows.json, or the mistake only surfaces on a user's Windows box.
  for (const name of PACK_NAMES) {
    const { rules, updated } = validateRulePack(name, readShipped(name));
    assert.ok(rules.length > 0, `${name} must contain rules`);
    assert.match(updated, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('each platform loads exactly common plus its own pack', () => {
  for (const [platform, expected] of [['darwin', 'macos'], ['win32', 'windows'], ['linux', 'linux']] as const) {
    assert.equal(packForPlatform(platform), expected);
    const catalog = loadRuleCatalogFrom(SHIPPED, platform);
    assert.deepEqual(catalog.packs.map((p) => p.name), ['common', expected]);
    assert.equal(catalog.schemaVersion, RULEPACK_SCHEMA_VERSION);
    assert.ok(catalog.location.length > 0, `${platform} must have known cache locations`);
    assert.ok(catalog.projectDirectory.length > 0, 'the shared project rules load everywhere');
  }
});

test('path tokens expand to real absolute paths for the running platform', () => {
  const catalog = loadRuleCatalogFrom(SHIPPED, process.platform);
  const home = os.homedir();
  for (const rule of catalog.location) {
    for (const p of rule.paths) {
      assert.ok(path.isAbsolute(p), `${rule.id} produced a non-absolute path: ${p}`);
      assert.doesNotMatch(p, /\{[a-zA-Z]+\}/, `${rule.id} left an unexpanded token: ${p}`);
    }
  }
  const stale = catalog.staleFiles.find((r) => r.id === 'old-downloads');
  assert.ok(stale);
  assert.equal(stale.withinPath, path.join(home, 'Downloads'), '{home} expands in stale-file rules too');
});

test('advisory rules always say what to do instead of trashing', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const catalog = loadRuleCatalogFrom(SHIPPED, platform);
    const all = [...catalog.projectDirectory, ...catalog.directory, ...catalog.file, ...catalog.location, ...catalog.staleFiles];
    const advisory = all.filter((r) => r.action === 'advice');
    assert.ok(advisory.length > 0, `${platform} ships at least one advisory rule`);
    for (const rule of advisory) {
      assert.ok(rule.adviceCommand, `${rule.id} must offer a supported alternative`);
    }
  }
});

test('WinSxS is deliberately absent from the Windows pack', () => {
  // Deleting from the component store breaks Windows unrecoverably, and most
  // of its apparent size is hard links. Listing it at all invites the attempt.
  const text = fs.readFileSync(path.join(SHIPPED, 'windows.json'), 'utf8');
  assert.doesNotMatch(text, /WinSxS/i, 'no rule may point at the component store');
  assert.match(fs.readFileSync(path.join(SHIPPED, 'README.md'), 'utf8'), /WinSxS/, 'and the reason is written down');
});

/* ───────────────────── Schema validation ───────────────────── */

/** Build a pack with one rule. A rule key set to `undefined` is REMOVED, not
 *  set to undefined — leaving the key present would trip the unknown-key check
 *  first and hide the assertion the case is actually about. */
function pack(overrides: Record<string, unknown> = {}, rule: Record<string, unknown> = {}): unknown {
  const merged: Record<string, unknown> = {
    id: 'x', kind: 'directory', title: 'X', description: 'x',
    category: 'cache', confidence: 'high', names: ['x'], ...rule,
  };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return { schemaVersion: 1, pack: 'common', updated: '2026-07-28', rules: [merged], ...overrides };
}

const REJECTED: Array<[string, unknown, RegExp]> = [
  ['a non-object file', ['not', 'an', 'object'], /must contain a JSON object/],
  ['an unknown top-level key', pack({ rulez: [] }), /unknown top-level key "rulez"/],
  ['a future schema version', pack({ schemaVersion: 2 }), /schemaVersion must be 1/],
  ['a pack claiming the wrong name', pack({ pack: 'macos' }), /declared as "macos"/],
  ['a non-ISO updated date', pack({ updated: 'yesterday' }), /updated must be an ISO date/],
  ['rules that are not an array', pack({ rules: {} }), /rules must be an array/],
  ['an unknown rule kind', pack({}, { kind: 'folder' }), /rules\[0\]\.kind must be one of/],
  ['a misspelled rule key', pack({}, { restoreComand: 'npm i' }), /unknown key "restoreComand"/],
  ['an empty title', pack({}, { title: '  ' }), /rules\[0\]\.title must be a non-empty string/],
  ['an invalid category', pack({}, { category: 'huge' }), /category must be one of regenerable, cache, junk/],
  ['an invalid confidence', pack({}, { confidence: 'certain' }), /confidence must be one of high, medium, low/],
  ['an empty names list', pack({}, { names: [] }), /names must be a non-empty array/],
  ['an unknown platform', pack({}, { os: ['plan9'] }), /expected darwin, win32, linux/],
  ['advice with nothing to advise', pack({}, { action: 'advice' }), /no adviceCommand to offer instead/],
  ['a project rule with no restore command', pack({}, { kind: 'project-directory', names: ['x'] }), /restoreCommand must be a non-empty string/],
  ['a location rule with no paths', pack({}, { kind: 'location', names: undefined, paths: [] }), /paths must be a non-empty array/],
  ['a stale rule with a zero age', pack({}, { kind: 'stale-files', names: undefined, withinPath: '{home}/D', olderThanDays: 0, minSizeBytes: 1 }), /olderThanDays must be a number >= 1/],
];

for (const [label, input, expected] of REJECTED) {
  test(`a pack is rejected for ${label}`, () => {
    assert.throws(() => validateRulePack('common', input), (err: unknown) => {
      assert.ok(err instanceof RulePackError, 'the error type says which subsystem failed');
      assert.match((err as Error).message, expected);
      assert.match((err as Error).message, /^Rule pack "common" is invalid: /, 'and names the pack');
      return true;
    });
  });
}

test('rules may share an id only when they agree about the group', () => {
  const agreeing = {
    schemaVersion: 1, pack: 'common', updated: '2026-07-28',
    rules: [
      { id: 'web', kind: 'project-directory', title: 'Web', description: 'w', category: 'regenerable', confidence: 'high', names: ['.next'], restoreCommand: 'npm run build' },
      { id: 'web', kind: 'project-directory', title: 'Web', description: 'w', category: 'regenerable', confidence: 'high', names: ['dist'], restoreCommand: 'npm run build' },
    ],
  };
  assert.equal(validateRulePack('common', agreeing).rules.length, 2);

  const disagreeing = JSON.parse(JSON.stringify(agreeing));
  disagreeing.rules[1].description = 'something else entirely';
  assert.throws(() => validateRulePack('common', disagreeing), /reuses id "web" with different text/);
});

/* ───────────────────── Failure isolation and hot data ───────────────────── */

function tempPacks(): string {
  const dir = fileTempDir('tm-packs-');
  for (const name of PACK_NAMES) fs.copyFileSync(path.join(SHIPPED, `${name}.json`), path.join(dir, `${name}.json`));
  return dir;
}

test('one malformed pack fails the whole catalog — never a partial load', () => {
  const dir = tempPacks();
  const good = loadRuleCatalogFrom(dir, process.platform);
  assert.ok(good.projectDirectory.length > 0);

  // Break the OS pack; the perfectly valid common pack must NOT load on its own.
  const osPack = path.join(dir, `${packForPlatform(process.platform)}.json`);
  const broken = JSON.parse(fs.readFileSync(osPack, 'utf8'));
  broken.rules[0].category = 'enormous';
  fs.writeFileSync(osPack, JSON.stringify(broken));

  assert.throws(() => loadRuleCatalogFrom(dir, process.platform), (err: unknown) => {
    assert.ok(err instanceof RulePackError);
    assert.match((err as Error).message, /category must be one of/);
    return true;
  });
});

test('unreadable and unparseable packs each fail with a reason a person can act on', () => {
  const dir = tempPacks();
  fs.writeFileSync(path.join(dir, 'common.json'), '{ "schemaVersion": 1, ');
  assert.throws(() => loadRuleCatalogFrom(dir, process.platform), /is not valid JSON/);

  const empty = fileTempDir('tm-nopacks-');
  assert.throws(() => loadRuleCatalogFrom(empty, process.platform), /could not be read from/);
});

test('adding a rule to a pack JSON, with no code change, produces a new suggestion', () => {
  const dir = tempPacks();
  const ROOT = path.resolve('/acceptance');
  const tree: FileNode = {
    name: 'acceptance', path: ROOT, type: 'dir', modifiedAt: 0, isHidden: false, size: 4096,
    children: [{
      name: 'blorptool-cache', path: path.join(ROOT, 'blorptool-cache'), type: 'dir', modifiedAt: 0, isHidden: false, size: 4096,
      children: [{ name: 'a.bin', path: path.join(ROOT, 'blorptool-cache', 'a.bin'), size: 4096, type: 'file', modifiedAt: 0, isHidden: false, extension: 'bin' }],
    }],
  };

  const before = collectCleanupSuggestions(tree, [], loadRuleCatalogFrom(dir, process.platform));
  assert.equal(before.find((g) => g.id === 'blorptool'), undefined, 'nothing knows about it yet');

  const common = JSON.parse(fs.readFileSync(path.join(dir, 'common.json'), 'utf8'));
  common.rules.push({
    id: 'blorptool',
    kind: 'directory',
    title: 'Blorptool cache',
    description: 'Cache left by blorptool — rebuilt on the next run',
    category: 'cache',
    confidence: 'medium',
    names: ['blorptool-cache'],
  });
  fs.writeFileSync(path.join(dir, 'common.json'), JSON.stringify(common, null, 2));

  const after = collectCleanupSuggestions(tree, [], loadRuleCatalogFrom(dir, process.platform));
  const group = after.find((g) => g.id === 'blorptool');
  assert.ok(group, 'the new rule fires with no code change at all');
  assert.equal(group.title, 'Blorptool cache');
  assert.equal(group.category, 'cache');
  assert.equal(group.confidence, 'medium');
  assert.equal(group.totalSize, 4096);
  assert.deepEqual(group.items.map((i) => i.path), [path.join(ROOT, 'blorptool-cache')]);
});

/* ───────────────────── "Why is this suggested" ───────────────────── */

test('every suggestion can explain itself, from what the rule actually matches', () => {
  const catalog = loadRuleCatalogFrom(SHIPPED, process.platform);
  const all = [...catalog.projectDirectory, ...catalog.directory, ...catalog.file, ...catalog.location, ...catalog.staleFiles];
  for (const rule of all) {
    const why = matchReasonFor(rule);
    assert.ok(why.length > 10, `${rule.id} must produce a real sentence`);
    assert.match(why, /\.$/, `${rule.id}'s reason should read as a sentence`);
  }

  const nodeModules = catalog.projectDirectory.find((r) => r.id === 'regen-node-modules');
  assert.equal(matchReasonFor(nodeModules!), 'A folder named node_modules.');
  const rust = catalog.projectDirectory.find((r) => r.id === 'regen-rust-target');
  assert.equal(matchReasonFor(rust!), 'A folder named target sitting next to Cargo.toml.', 'in the spelling the pack writes, not the lowercased match key (QA D06)');
  const stale = catalog.staleFiles.find((r) => r.id === 'old-downloads');
  assert.match(matchReasonFor(stale!), /at least 1 MB, untouched for 90\+ days\.$/);
});

test('a matched group carries its confidence and its reason', () => {
  const ROOT = path.resolve('/why');
  const tree: FileNode = {
    name: 'why', path: ROOT, type: 'dir', modifiedAt: 0, isHidden: false, size: 100,
    children: [{
      name: 'node_modules', path: path.join(ROOT, 'node_modules'), type: 'dir', modifiedAt: 0, isHidden: false, size: 100,
      children: [{ name: 'p.js', path: path.join(ROOT, 'node_modules', 'p.js'), size: 100, type: 'file', modifiedAt: 0, isHidden: false, extension: 'js' }],
    }],
  };
  const g = collectCleanupSuggestions(tree, [], loadRuleCatalogFrom(SHIPPED, process.platform))[0];
  assert.equal(g.id, 'regen-node-modules');
  assert.equal(g.confidence, 'high');
  assert.equal(g.why, 'A folder named node_modules.');
  assert.equal(g.advisory, undefined, 'a normal group is not advisory');
  assert.equal(g.regenerateCmd, 'npm install');
});

/* ───────────────────── QA D55: prose for people, not routes ───────────────────── */

test('no shipped rule speaks in API routes — its title and description are shown verbatim in Smart Suggestions (QA D55)', () => {
  const packs = fs.readdirSync(SHIPPED).filter((f) => f.endsWith('.json'));
  assert.ok(packs.length >= 4, `every pack is read (${packs.join(', ')})`);
  let rules = 0;
  for (const file of packs) {
    const pack = JSON.parse(fs.readFileSync(path.join(SHIPPED, file), 'utf8')) as { rules: Record<string, unknown>[] };
    for (const rule of pack.rules) {
      rules++;
      for (const field of ['title', 'description'] as const) {
        const text = String(rule[field] ?? '');
        assert.doesNotMatch(text, /\/api\/|\b(?:GET|POST|PUT|DELETE) \//, `${file} ${String(rule.id)}.${field} names a route: "${text}"`);
      }
    }
  }
  assert.ok(rules > 50, `all the rules were read (${rules})`);
});

/* ───────────────────── QA D06: "why" says what matched ───────────────────── */

/** A folder of folders and files for the walk: [name, children] for a folder, a name for a 100-byte file. */
type Spec = string | [string, Spec[]];
function treeOf(root: string, specs: Spec[]): FileNode {
  const build = (parent: string, spec: Spec): FileNode => {
    if (typeof spec === 'string') {
      return { name: spec, path: path.join(parent, spec), size: 100, type: 'file', modifiedAt: 0, isHidden: spec.startsWith('.'), extension: '' };
    }
    const [name, kids] = spec;
    const p = path.join(parent, name);
    const children = kids.map((k) => build(p, k));
    return { name, path: p, type: 'dir', modifiedAt: 0, isHidden: name.startsWith('.'), size: children.reduce((a, c) => a + c.size, 0), children };
  };
  const children = specs.map((sp) => build(root, sp));
  return { name: path.basename(root), path: root, type: 'dir', modifiedAt: 0, isHidden: false, size: children.reduce((a, c) => a + c.size, 0), children };
}

async function served(tree: FileNode) {
  const { cleanupSuggestionsFor, resetCleanupMemoForTests } = await import('../src/services/cleanupMemo');
  const { ObjectScanStore } = await import('../src/services/scanStore');
  resetCleanupMemoForTests();
  return cleanupSuggestionsFor(ObjectScanStore.wrap(tree), [], loadRuleCatalogFrom(SHIPPED, 'darwin'), []);
}

test('the served "why" names the folders that matched, not every name the rule knows (QA D06)', async () => {
  const ROOT = path.resolve('/d06');
  const groups = await served(treeOf(ROOT, [
    ['site', ['package.json', ['.next', ['a.js']]]],
    ['blog', ['package.json', ['.next', ['b.js']]]],
    ['app', ['Podfile', ['Pods', ['x.a']]]],
    ['crate', ['Cargo.toml', ['target', ['y.rlib']]]],
  ]));
  const why = (id: string) => groups.find((g) => g.id === id)?.why;
  assert.equal(why('regen-web-build'), 'A folder named .next.', 'only .next matched — not ".next, .nuxt, .output, .svelte-kit or .angular"');
  assert.equal(why('regen-cocoapods'), 'A folder named Pods sitting next to Podfile.', 'the names as they are on disk and in the pack');
  assert.equal(why('regen-rust-target'), 'A folder named target sitting next to Cargo.toml.');
});

test('several matched names are all named, each once whatever its case, in the order of the items (QA D06)', async () => {
  const ROOT = path.resolve('/d06b');
  const groups = await served(treeOf(ROOT, [
    ['a', [['.pytest_cache', ['1', '2', '3']]]],
    ['b', [['.mypy_cache', ['1']]]],
    ['c', [['.PYTEST_CACHE', ['1']]]],
  ]));
  const g = groups.find((x) => x.id === 'tool-caches');
  assert.ok(g, 'the tool-caches rule matched');
  assert.equal(g!.why, 'A folder named .pytest_cache or .mypy_cache, with no project manifest beside it to say what rebuilds it.');
});

test('a group cut off at its 200 listed items keeps the rule\'s full sentence — a name past the cut is still in its total (review F1.2)', async () => {
  // The walk counts every match in totalSize but lists only the first 200 it
  // meets. Narrowing to the listed names would leave out a folder whose bytes
  // the group's size includes, and which name is left out would depend on walk order.
  const projects = (n: number, folder: string, from = 0): Spec[] =>
    Array.from({ length: n }, (_, i) => [`p${from + i}`, ['package.json', [folder, ['a.js']]]] as Spec);
  const FULL = 'A folder named .next, .nuxt, .output, .svelte-kit or .angular.';
  const cut = await served(treeOf(path.resolve('/f12a'), [...projects(200, '.next'), ...projects(1, '.angular', 200)]));
  const g = cut.find((x) => x.id === 'regen-web-build')!;
  assert.equal(g.items.length, 200, 'the list stops at 200');
  assert.ok(!g.items.some((i) => i.name === '.angular'), 'the .angular folder is past the cut');
  assert.equal(g.totalSize, 201 * 100, 'and its bytes are in the total');
  assert.equal(g.why, FULL, 'so the sentence still names every folder the rule matches');

  const atCap = await served(treeOf(path.resolve('/f12b'), projects(200, '.next')));
  assert.equal(atCap.find((x) => x.id === 'regen-web-build')!.why, FULL,
    'exactly 200 listed cannot tell "all of them" from "the first 200", so it is not narrowed either');

  const under = await served(treeOf(path.resolve('/f12c'), projects(199, '.next')));
  assert.equal(under.find((x) => x.id === 'regen-web-build')!.why, 'A folder named .next.',
    'under the cap every match is listed, and the sentence names what matched');
});

test('a group that two rules share keeps the rule\'s own sentence when its folders came from both (QA D06)', async () => {
  const { withMatchedReasons } = await import('../src/services/rulePacks');
  const catalog = loadRuleCatalogFrom(SHIPPED, 'darwin');
  const group = {
    id: 'regen-web-build', title: 't', description: 'd', totalSize: 2, category: 'regenerable' as const,
    items: [{ name: '.next', path: '/x/.next', size: 1, type: 'dir' as const, modifiedAt: 0 }, { name: 'dist', path: '/y/dist', size: 1, type: 'dir' as const, modifiedAt: 0 }],
    why: 'the walk\'s sentence',
  };
  const [out] = withMatchedReasons([group], catalog, 200);
  assert.equal(out.why, 'the walk\'s sentence', 'no one rule matched both names, so nothing is narrowed');
  const input = { ...group, items: [group.items[1]] };
  const solo = withMatchedReasons([input], catalog, 200)[0];
  assert.match(solo.why!, /^A folder named dist sitting next to package\.json, /, 'one rule\'s names: narrowed with that rule\'s siblings');
  assert.equal(input.why, 'the walk\'s sentence', 'the input is not edited — the memo hands out copies of one answer');
  assert.notEqual(solo, input, 'a narrowed group is a new object');
  assert.equal(withMatchedReasons([{ ...group, id: 'old-downloads' }], catalog, 200)[0].why, 'the walk\'s sentence', 'a rule that is not matched by name is left alone');
});

test('matchReasonFor with matched names says those names; without, the pack\'s own spelling (QA D06)', () => {
  const catalog = loadRuleCatalogFrom(SHIPPED, 'darwin');
  const web = catalog.projectDirectory.find((r) => r.id === 'regen-web-build' && !r.requiresSibling)!;
  assert.equal(matchReasonFor(web, { names: ['.nuxt'] }), 'A folder named .nuxt.');
  const venv = catalog.projectDirectory.find((r) => r.id === 'regen-python-venv')!;
  assert.equal(matchReasonFor(venv), 'A folder named .venv, venv or env sitting next to requirements.txt, pyproject.toml, Pipfile, setup.py, setup.cfg or .python-version.');
  assert.equal(matchReasonFor(venv, { names: ['venv'] }), 'A folder named venv sitting next to requirements.txt, pyproject.toml, Pipfile, setup.py, setup.cfg or .python-version.');
  const pods = catalog.projectDirectory.find((r) => r.id === 'regen-cocoapods')!;
  assert.equal(matchReasonFor(pods), 'A folder named Pods sitting next to Podfile.', 'the folder name too, as the pack writes it');
  const junk = catalog.file.find((r) => r.id === 'os-junk')!;
  assert.equal(matchReasonFor(junk), 'A file named .DS_Store, Thumbs.db or desktop.ini.', 'a file rule\'s names as the pack writes them');
  assert.equal(matchReasonFor(junk, { names: ['.DS_Store'] }), 'A file named .DS_Store.');
  assert.equal(matchReasonFor(junk, { names: [] }), matchReasonFor(junk), 'an empty list is no narrowing');
});

test('the Reclaim Score\'s "regenerable" reason names the folder it scored, not every name its rule knows (QA D06)', async () => {
  const { computeRuleClaims } = await import('../src/services/reclaimInputs');
  const { resetCleanupMemoForTests } = await import('../src/services/cleanupMemo');
  const { ObjectScanStore } = await import('../src/services/scanStore');
  resetCleanupMemoForTests();
  const ROOT = path.resolve('/d06c');
  const claims = await computeRuleClaims(ObjectScanStore.wrap(treeOf(ROOT, [
    ['site', ['package.json', ['.svelte-kit', ['a.js']]]],
    ['crate', ['Cargo.toml', ['target', ['y.rlib']]]],
  ])));
  assert.equal(claims.available, true);
  assert.equal(claims.byPath.get(path.join(ROOT, 'site', '.svelte-kit'))?.why, 'A folder named .svelte-kit.');
  assert.equal(claims.byPath.get(path.join(ROOT, 'crate', 'target'))?.why, 'A folder named target sitting next to Cargo.toml.');
});
