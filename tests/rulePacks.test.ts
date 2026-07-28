import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-packs-'));
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

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-nopacks-'));
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
  assert.equal(matchReasonFor(rust!), 'A folder named target sitting next to cargo.toml.');
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
