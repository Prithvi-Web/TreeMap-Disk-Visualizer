import { test } from 'node:test';
import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

isolatedDataDir('treemap-rulePacks-data-');

import { execFileSync } from 'node:child_process';
import {
  PACK_NAMES,
  RULEPACK_SCHEMA_VERSION,
  RulePackError,
  fillFolder,
  loadRuleCatalogFrom,
  matchReasonFor,
  packForPlatform,
  REMEDY_PROSE_WORDS,
  remedyIsCommand,
  shellWord,
  validateRulePack,
} from '../src/services/rulePacks';
import { lift } from './fixtures/liftFrontend';
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
  // Hunt HF-L1: what an advice rule's "never trash it" covers is said only by an advice rule, and only as `folder`.
  ['a trash rule saying what its advice covers', pack({}, { adviceCovers: 'folder' }), /has adviceCovers but action "trash": only an advice rule says what it covers/],
  ['an advice rule covering an unknown extent', pack({}, { action: 'advice', adviceCommand: 'x', adviceCovers: 'files' }), /rules\[0\]\.adviceCovers must be one of folder/],
  ['a project rule with no restore command', pack({}, { kind: 'project-directory', names: ['x'] }), /restoreCommand must be a non-empty string/],
  ['a project rule whose required children are none', pack({}, { kind: 'project-directory', names: ['x'], restoreCommand: 'x', requiresChild: [] }), /rules\[0\]\.requiresChild must be a non-empty array/],
  ['a project rule whose required child is not a name', pack({}, { kind: 'project-directory', names: ['x'], restoreCommand: 'x', requiresChild: [' '] }), /rules\[0\]\.requiresChild\[0\] must be a non-empty string/],
  ['a required child on a rule that matches by name alone', pack({}, { requiresChild: ['x.cfg'] }), /unknown key "requiresChild" for kind "directory"/],
  ['a project rule whose refused children are none', pack({}, { kind: 'project-directory', names: ['x'], restoreCommand: 'x', forbidsChild: [] }), /rules\[0\]\.forbidsChild must be a non-empty array/],
  ['a project rule whose refused child is not a name', pack({}, { kind: 'project-directory', names: ['x'], restoreCommand: 'x', forbidsChild: [' '] }), /rules\[0\]\.forbidsChild\[0\] must be a non-empty string/],
  ['a refused child on a rule that matches by name alone', pack({}, { forbidsChild: ['x.cfg'] }), /unknown key "forbidsChild" for kind "directory"/],
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

test('a project rule that names a child matches only a folder holding one of them, matched in any case and said as the pack writes it (BQL-b1 review F1.4)', () => {
  const dir = tempPacks();
  const common = JSON.parse(fs.readFileSync(path.join(dir, 'common.json'), 'utf8'));
  common.rules.unshift({
    id: 'blorp-out', kind: 'project-directory', title: 'Blorp output', description: 'Written by blorp — blorp writes it again',
    category: 'regenerable', confidence: 'high', names: ['out'], requiresSibling: ['blorp.toml'], requiresChild: ['Blorp.Stamp', 'blorp-index'],
    restoreCommand: 'blorp build',
  });
  fs.writeFileSync(path.join(dir, 'common.json'), JSON.stringify(common, null, 2));
  const catalog = loadRuleCatalogFrom(dir, process.platform);
  const rule = catalog.projectDirectory.find((r) => r.id === 'blorp-out')!;
  assert.deepEqual([rule.requiresChild, rule.childLabels], [['blorp.stamp', 'blorp-index'], ['Blorp.Stamp', 'blorp-index']],
    'matched lowercased, said as written');
  const ROOT = path.resolve('/holding');
  const outOf = (project: string, kids: Spec[]): FileNode => treeOf(ROOT, [[project, ['blorp.toml', ['out', kids]]]]);
  const claimed = (t: FileNode) => collectCleanupSuggestions(t, [], catalog).find((g) => g.id === 'blorp-out')?.items.map((i) => i.path) ?? [];
  assert.deepEqual(claimed(outOf('a', ['BLORP.STAMP', 'x.bin'])), [path.join(ROOT, 'a', 'out')], 'a child named in another case is the child');
  assert.deepEqual(claimed(outOf('b', [['blorp-index', ['i']]])), [path.join(ROOT, 'b', 'out')], 'any one of the children will do, a folder too');
  assert.deepEqual(claimed(outOf('c', ['notes.txt'])), [], 'a folder holding none of them is not matched');
  assert.equal(matchReasonFor(rule), 'A folder named out holding Blorp.Stamp or blorp-index, sitting next to blorp.toml.');
});

test('a project rule that refuses a child matches only a folder holding none of them, matched in any case and said as the pack writes it (BQL-b1 review F2.2)', () => {
  const dir = tempPacks();
  const common = JSON.parse(fs.readFileSync(path.join(dir, 'common.json'), 'utf8'));
  common.rules.unshift({
    id: 'blorp-out', kind: 'project-directory', title: 'Blorp output', description: 'Written by blorp — blorp writes it again',
    category: 'regenerable', confidence: 'high', names: ['out'], requiresSibling: ['blorp.toml'], requiresChild: ['blorp.stamp'],
    forbidsChild: ['Keep.Me', 'notes'], restoreCommand: 'blorp build',
  }, {
    id: 'blorp-tmp', kind: 'project-directory', title: 'Blorp scratch', description: 'Written by blorp — blorp writes it again',
    category: 'regenerable', confidence: 'high', names: ['tmp'], forbidsChild: ['Keep.Me'], restoreCommand: 'blorp build',
  });
  fs.writeFileSync(path.join(dir, 'common.json'), JSON.stringify(common, null, 2));
  const catalog = loadRuleCatalogFrom(dir, process.platform);
  const rule = catalog.projectDirectory.find((r) => r.id === 'blorp-out')!;
  assert.deepEqual([rule.forbidsChild, rule.forbiddenLabels], [['keep.me', 'notes'], ['Keep.Me', 'notes']], 'matched lowercased, said as written');
  const ROOT = path.resolve('/refusing');
  const outOf = (project: string, kids: Spec[]): FileNode => treeOf(ROOT, [[project, ['blorp.toml', ['out', kids]]]]);
  const claimed = (t: FileNode, id = 'blorp-out') => collectCleanupSuggestions(t, [], catalog).find((g) => g.id === id)?.items.map((i) => i.path) ?? [];
  assert.deepEqual(claimed(outOf('a', ['blorp.stamp', 'x.bin'])), [path.join(ROOT, 'a', 'out')], 'control: a folder holding none of them is matched');
  assert.deepEqual(claimed(outOf('b', ['blorp.stamp', 'KEEP.ME'])), [], 'a folder holding one, named in another case, is not matched');
  assert.deepEqual(claimed(outOf('c', ['blorp.stamp', ['notes', ['n.txt']]])), [], 'any one of them refuses it, a folder too');
  assert.deepEqual(claimed(treeOf(ROOT, [['d', [['tmp', ['t.bin', 'keep.me']]]]]), 'blorp-tmp'), [], 'a rule with no sibling and no required child refuses it too');
  assert.deepEqual(claimed(treeOf(ROOT, [['e', [['tmp', ['t.bin']]]]]), 'blorp-tmp'), [path.join(ROOT, 'e', 'tmp')], 'control: and matches a folder holding none');
  assert.equal(matchReasonFor(rule), 'A folder named out holding blorp.stamp and no Keep.Me or notes, sitting next to blorp.toml.');
  assert.equal(matchReasonFor(catalog.projectDirectory.find((r) => r.id === 'blorp-tmp')!), 'A folder named tmp holding no Keep.Me.',
    'a rule that only refuses a child says so, as the pack writes it');
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
  // The matcher reads the modified time only, so "untouched" (never opened) was untrue; the title is sentence case (the hunt, C65).
  assert.match(matchReasonFor(stale!), /at least 1 MB, not changed in 90\+ days\.$/);
  assert.equal(stale!.title, 'Old downloads');
  assert.equal(stale!.description, 'Files in Downloads not changed in 90+ days');
  // The "1 MB" it says is the decimal megabyte every size is printed in (QA D09).
  assert.equal(stale!.minSizeBytes, 1_000_000, 'the rule matches from 1,000,000 bytes, the 1 MB its sentence names');
  assert.match(matchReasonFor({ ...stale!, minSizeBytes: 250_000_000 }), /at least 250 MB,/, 'and the sentence counts in the same megabytes');
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

test('no shipped rule speaks in API routes — its title and description are shown verbatim in Smart suggestions (QA D55)', () => {
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
  // tool-caches is one rule of many names (a group two rules share is
  // review F2.2's, below).
  const caches = (n: number, folder: string, from = 0): Spec[] =>
    Array.from({ length: n }, (_, i) => [`p${from + i}`, [[folder, ['1']]]] as Spec);
  const FULL = 'A folder named .pytest_cache, .mypy_cache, .ruff_cache, .turbo, .parcel-cache, .eslintcache or .tox, with no project manifest beside it to say what rebuilds it.';
  const cut = await served(treeOf(path.resolve('/f12a'), [...caches(200, '.pytest_cache'), ...caches(1, '.mypy_cache', 200)]));
  const g = cut.find((x) => x.id === 'tool-caches')!;
  assert.equal(g.items.length, 200, 'the list stops at 200');
  assert.ok(!g.items.some((i) => i.name === '.mypy_cache'), 'the .mypy_cache folder is past the cut');
  assert.equal(g.totalSize, 201 * 100, 'and its bytes are in the total');
  assert.equal(g.why, FULL, 'so the sentence still names every folder the rule matches');

  const atCap = await served(treeOf(path.resolve('/f12b'), caches(200, '.pytest_cache')));
  assert.equal(atCap.find((x) => x.id === 'tool-caches')!.why, FULL,
    'exactly 200 listed cannot tell "all of them" from "the first 200", so it is not narrowed either');

  const under = await served(treeOf(path.resolve('/f12c'), caches(199, '.pytest_cache')));
  assert.equal(under.find((x) => x.id === 'tool-caches')!.why, 'A folder named .pytest_cache, with no project manifest beside it to say what rebuilds it.',
    'under the cap every match is listed, and the sentence names what matched');
});

/** regen-web-build is two rules under one id: framework folders anywhere, and dist or .output beside a JS project file. */
const WEB_ALL = 'A folder named .next, .nuxt, .svelte-kit or .angular';
/** The dist rule's sentence, every name: a .output folder, too, is offered only beside a JS project file (BQL item 7b). */
const DIST_ALL = 'a folder named dist or .output sitting next to package.json, next.config.*, nuxt.config.*, vite.config.*, svelte.config.* or angular.json.';
/** The same, narrowed to a group whose only match of that rule is dist. */
const DIST_ONLY = 'a folder named dist sitting next to package.json, next.config.*, nuxt.config.*, vite.config.*, svelte.config.* or angular.json.';

test('a group two rules share names the folders of both, whichever the walk met first (review F2.2)', async () => {
  // The walk writes a group's sentence from the rule that created it, so a
  // group of .next and dist folders named only one of them, and which one
  // depended on the order the walk met them.
  const web = (name: string, folder: string): Spec => [name, ['package.json', [folder, ['a.js']]]];
  for (const order of [[web('site', '.next'), web('lib', 'dist')], [web('lib', 'dist'), web('site', '.next')]]) {
    const g = (await served(treeOf(path.resolve('/f22a'), order))).find((x) => x.id === 'regen-web-build')!;
    assert.equal(g.items.length, 2, 'both folders are in the group');
    assert.equal(g.why, `A folder named .next; or ${DIST_ONLY}`,
      `each rule says the names it matched, in the catalog's order, whatever the walk's (${order[0][0]} first)`);
  }
});

test('a group two rules share, cut off at its 200 listed items, names every folder of both rules — the walk\'s first rule is not the whole of it (review F2.2)', async () => {
  const projects = (n: number, folder: string, from = 0): Spec[] =>
    Array.from({ length: n }, (_, i) => [`p${from + i}`, ['package.json', [folder, ['a.js']]]] as Spec);
  const FULL = `${WEB_ALL}; or ${DIST_ALL}`;
  // One dist project first, then 220 .next ones: the .next folders hold nearly
  // all the bytes, and the walk's own sentence named only dist.
  const distFirst = (await served(treeOf(path.resolve('/f22b'), [...projects(1, 'dist'), ...projects(220, '.next', 1)])))
    .find((x) => x.id === 'regen-web-build')!;
  assert.equal(distFirst.items.length, 200, 'the list stops at 200');
  assert.equal(distFirst.totalSize, 221 * 100, 'every match is in the total');
  assert.equal(distFirst.why, FULL, 'so the sentence names both rules\' folders');
  // 220 .next projects, then a dist past the cut: its bytes are in the total
  // and its name was in no sentence.
  const distLast = (await served(treeOf(path.resolve('/f22c'), [...projects(220, '.next'), ...projects(1, 'dist', 220)])))
    .find((x) => x.id === 'regen-web-build')!;
  assert.ok(!distLast.items.some((i) => i.name === 'dist'), 'the dist folder is past the cut');
  assert.equal(distLast.totalSize, 221 * 100, 'and its bytes are in the total');
  assert.equal(distLast.why, FULL, 'and dist is named all the same');
});

test('a group that two rules share is said rule by rule when its folders came from both (QA D06, review F2.2)', async () => {
  const { withMatchedReasons } = await import('../src/services/rulePacks');
  const catalog = loadRuleCatalogFrom(SHIPPED, 'darwin');
  const group = {
    id: 'regen-web-build', title: 't', description: 'd', totalSize: 2, category: 'regenerable' as const,
    items: [{ name: 'dist', path: '/y/dist', size: 1, type: 'dir' as const, modifiedAt: 0 }, { name: '.next', path: '/x/.next', size: 1, type: 'dir' as const, modifiedAt: 0 }],
    why: 'the walk\'s sentence',
  };
  const [out] = withMatchedReasons([group], catalog, 200);
  assert.equal(out.why, `A folder named .next; or ${DIST_ONLY}`, 'no one rule matched both names, so each says its own');
  const stray = { ...group, items: [group.items[0], { ...group.items[0], name: 'out', path: '/z/out' }] };
  assert.equal(withMatchedReasons([stray], catalog, 200)[0].why, `${WEB_ALL}; or ${DIST_ALL}`,
    'a name no rule of the id names is never narrowed away: the group is said in full');
  const input = { ...group, items: [group.items[0]] };
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
  assert.equal(matchReasonFor(venv), 'A folder named .venv, venv or env holding pyvenv.cfg, sitting next to requirements.txt, pyproject.toml, Pipfile, setup.py, setup.cfg or .python-version.');
  assert.equal(matchReasonFor(venv, { names: ['venv'] }), 'A folder named venv holding pyvenv.cfg, sitting next to requirements.txt, pyproject.toml, Pipfile, setup.py, setup.cfg or .python-version.');
  const pods = catalog.projectDirectory.find((r) => r.id === 'regen-cocoapods')!;
  assert.equal(matchReasonFor(pods), 'A folder named Pods sitting next to Podfile.', 'the folder name too, as the pack writes it');
  // A rule that needs a child and no sibling says the one (BQL-b1 review F1.4); the child as the pack writes it.
  const holding = { ...pods, requiresSibling: undefined, siblingLabels: undefined, requiresChild: ['manifest.lock'], childLabels: ['Manifest.lock'] };
  assert.equal(matchReasonFor(holding), 'A folder named Pods holding Manifest.lock.', 'a rule that needs only a child names it, as the pack writes it');

  const junk = catalog.file.find((r) => r.id === 'os-junk')!;
  assert.equal(matchReasonFor(junk), 'A file named .DS_Store, Thumbs.db or desktop.ini.', 'a file rule\'s names as the pack writes them');
  assert.equal(matchReasonFor(junk, { names: ['.DS_Store'] }), 'A file named .DS_Store.');
  assert.equal(matchReasonFor(junk, { names: [] }), matchReasonFor(junk), 'an empty list is no narrowing');
});

test('the media rules name Final Cut and Lightroom folders as those apps spell them (review F1.7)', () => {
  const catalog = loadRuleCatalogFrom(SHIPPED, 'darwin');
  const fcp = catalog.projectDirectory.find((r) => r.id === 'media-fcp-render-files')!;
  assert.equal(matchReasonFor(fcp),
    'A folder named Render Files or Transcoded Media sitting next to Original Media or CurrentVersion.fcpevent.');
  assert.equal(matchReasonFor(fcp, { names: ['Render Files'] }),
    'A folder named Render Files sitting next to Original Media or CurrentVersion.fcpevent.', 'the siblings too, beside a matched name');
  const previews = catalog.directory.find((r) => r.id === 'media-lightroom-previews')!;
  assert.match(matchReasonFor(previews), /^A folder named Lightroom Catalog Previews\.lrdata, Lightroom Catalog-v10 Previews\.lrdata, /);
  const smart = catalog.directory.find((r) => r.id === 'media-lightroom-smart-previews')!;
  assert.match(matchReasonFor(smart), / or Lightroom Catalog-v14 Smart Previews\.lrdata, with no project manifest/);
});

test('no name or sibling of several words is written all in lowercase — apps capitalise the folders they make (review F1.7)', () => {
  // Names are matched case-insensitively and said as the pack writes them
  // (README), so a lowercase "render files" is printed lowercase.
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const catalog = loadRuleCatalogFrom(SHIPPED, platform);
    for (const r of [...catalog.projectDirectory, ...catalog.directory, ...catalog.file]) {
      const said = [...(r.labels ?? []), ...('siblingLabels' in r ? r.siblingLabels ?? [] : [])];
      for (const label of said) {
        if (label.includes(' ')) assert.notEqual(label, label.toLowerCase(), `${r.id}: "${label}" is spelled as the app spells it`);
      }
    }
  }
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

test('the virtualenv rule says what really makes a virtualenv again — true for .venv, venv and env, with or without a requirements.txt (sixth browser pass H08)', () => {
  const catalog = loadRuleCatalogFrom(SHIPPED, 'darwin');
  const venv = catalog.projectDirectory.find((r) => r.id === 'regen-python-venv')!;
  assert.deepEqual(venv.names, ['.venv', 'venv', 'env'], 'control: one rule for three folder names');
  assert.ok(venv.requiresSibling?.includes('.python-version'), 'control: a .python-version alone is enough to match — no package list need be there');
  // `pip install -r requirements.txt` makes no virtualenv (it installs into whichever Python comes first on
  // PATH) and fails where there is no requirements.txt: the remedy was untrue for a .venv.
  assert.equal(venv.restoreCommand, 'python3 -m venv <folder>, then reinstall the packages it held',
    'the command that makes the environment again, named for whichever folder it was, then the step no command can promise');
  assert.doesNotMatch(venv.restoreCommand, /requirements\.txt/, 'it names no file a project may not have');
  assert.doesNotMatch(venv.description, /manifest/, 'nor does its description promise a manifest a .python-version alone does not give');
  assert.match(venv.description, /packages[^.]*reinstalled/, 'and it says the packages are not made again with it');
});

/* ───────────── A restore command's <folder>, filled in (BQL item 7) ───────────── */

const VENV_CMD = 'python3 -m venv <folder>, then reinstall the packages it held';

/**
 * Names a shell would read otherwise if they were pasted bare: spaces, quotes,
 * every character sh or zsh expands or splits on, `=` (zsh's =command), `~`,
 * a tab and a name that is not ASCII.
 */
const AWKWARD_NAMES = ['my env', "it's", 'a"b', 'a$b', 'a`id`', 'a\\b', '*', 'a?', '~x', '=ls', 'a;b', 'a&b', 'a|b', '<x>', '(x)', '{a,b}', '[x]', '#x', '!x', 'tab\there', 'vénv', ''];

test('a restore command\'s <folder> is filled with each distinct folder name — one command each, in the order met — and is otherwise left as the pack wrote it (BQL item 7)', () => {
  // "python3 -m venv <folder>" pasted into zsh is "no such file or directory: folder": `<` is a redirect.
  assert.equal(fillFolder(VENV_CMD, ['.venv']), 'python3 -m venv .venv, then reinstall the packages it held', 'one name: one command, the step after it kept');
  assert.equal(fillFolder(VENV_CMD, ['.venv', 'env', '.venv']), 'python3 -m venv .venv · python3 -m venv env, then reinstall the packages it held',
    'several: one command per distinct name, as alternatives');
  assert.equal(fillFolder(VENV_CMD, ['my env']), "python3 -m venv 'my env', then reinstall the packages it held", 'a name with a space is quoted');
  assert.equal(fillFolder(VENV_CMD, ['-x']), 'python3 -m venv ./-x, then reinstall the packages it held', 'a name that begins with "-" is never read as an option');
  assert.equal(fillFolder(VENV_CMD, []), VENV_CMD, 'with no name to put in it, the template is left as it is');
  assert.equal(fillFolder('npm install', ['.venv']), 'npm install', 'a command with no placeholder is left as it is');
});

test('a filled-in folder name is one word a POSIX shell and zsh read back exactly as the name, whatever it holds (BQL item 7)', { skip: process.platform === 'win32' ? 'no POSIX shell to ask' : false }, () => {
  assert.equal(shellWord('.venv'), '.venv', 'control: a plain name is as it is');
  assert.equal(shellWord('my env'), "'my env'", 'a name with a space is single-quoted');
  const shells = ['/bin/sh', '/bin/zsh'].filter((s) => fs.existsSync(s));
  assert.ok(shells.includes('/bin/sh'), 'control: there is a /bin/sh to ask');
  /** What `shell` prints for the words of `printf '%s|' <word>`; a shell that refuses the line says so instead. */
  const said = (shell: string, word: string): string => {
    try {
      return execFileSync(shell, ['-c', `printf '%s|' ${word}`], { encoding: 'utf8', env: { ...process.env } });
    } catch (err) {
      return `the shell refused it: ${(err as Error).message}`;
    }
  };
  for (const shell of shells) {
    for (const name of AWKWARD_NAMES) {
      const word = shellWord(name);
      assert.equal(said(shell, word), `${name}|`, `${shell} reads ${JSON.stringify(word)} back as the one name ${JSON.stringify(name)}`);
    }
    // A leading "-" is spelled as a path, so the program reads a folder, not an option.
    assert.equal(said(shell, shellWord('-x')), './-x|', `${shell}: -x as ./-x`);
  }
});

test('the page fills a restore command exactly as the server does: its copy of fillFolder and shellWord is held to this one (BQL item 7)', () => {
  const page = lift<{ fillFolder: typeof fillFolder; shellWord: typeof shellWord }>(['shellWord', 'fillFolder'], '{ fillFolder, shellWord }');
  for (const name of [...AWKWARD_NAMES, '.venv', 'venv', 'ENV', '-x', '--', 'a b c']) {
    assert.equal(page.shellWord(name), shellWord(name), `shellWord(${JSON.stringify(name)})`);
  }
  const commands = [VENV_CMD, 'npm install', 'make <folder>', 'a <folder> b, then c <folder>, then d', 'x <folder>,  then  y'];
  const nameSets = [[], ['.venv'], ['.venv', 'env', '.venv'], ['my env', 'env'], ["it's"], ['-x']];
  for (const command of commands) {
    for (const names of nameSets) {
      assert.equal(page.fillFolder(command, names), fillFolder(command, names), `fillFolder(${JSON.stringify(command)}, ${JSON.stringify(names)})`);
    }
  }
});

test('the server tells a remedy\'s command from its sentence exactly as the page does: its copy of remedyIsCommand is held to this one (BQL-b1 review F1.2, F1.5)', () => {
  // The Reclaim Score's reason sets a command in backticks and a sentence as
  // words, as the Clean Up card sets one in a code pill and the other as text.
  const page = lift<{ remedyIsCommand: (part: string) => boolean; REMEDY_PROSE_WORDS: ReadonlySet<string> }>(
    ['REMEDY_PROSE_WORDS', 'remedyIsCommand'], '{ remedyIsCommand, REMEDY_PROSE_WORDS }');
  // The word lists themselves, equal (BQL-b1 review F2.5): nearly every
  // sentence below holds "it" or "on", so the parity loop alone stayed green
  // with the server's list cut from twenty words to those two.
  assert.deepEqual([...REMEDY_PROSE_WORDS].sort(), [...page.REMEDY_PROSE_WORDS].sort(), 'the server\'s prose words are the page\'s, word for word');
  const shipped = PACK_NAMES.flatMap((name) => (JSON.parse(fs.readFileSync(path.join(SHIPPED, `${name}.json`), 'utf8')) as { rules: Record<string, unknown>[] }).rules)
    .flatMap((r) => [r.restoreCommand, r.adviceCommand, r.clearCommand].filter((t): t is string => typeof t === 'string'))
    .map((t) => fillFolder(t, ['.venv']))
    .flatMap((t) => t.split(/\s+·\s+|,\s+then\s+/));
  assert.deepEqual([remedyIsCommand('npm install'), remedyIsCommand('the next test run with coverage writes it again')], [true, false],
    'control: a command is one, a sentence is not');
  const parts = [...new Set([...shipped, 'npm install', 'python3 -m venv .venv', 'reinstall the packages it held', 'automatic on next run',
    'the next test run with coverage writes it again', 'Final Cut Pro ▸ File', '~/bin/tool --flag', 'Remove-Item -Recurse x', 'Run it again', 'make it.', ''])];
  for (const part of parts) assert.equal(remedyIsCommand(part), page.remedyIsCommand(part), `remedyIsCommand(${JSON.stringify(part)})`);
  // And each word on its own decides: "x the" is words to read, on both sides.
  for (const word of new Set([...REMEDY_PROSE_WORDS, ...page.REMEDY_PROSE_WORDS])) {
    assert.deepEqual([remedyIsCommand(`x ${word}`), page.remedyIsCommand(`x ${word}`)], [false, false], `"x ${word}" is a sentence, on the server and the page`);
  }
  assert.deepEqual([remedyIsCommand('x y'), page.remedyIsCommand('x y')], [true, true], 'control: "x y", with no such word, is a command on both');
});
