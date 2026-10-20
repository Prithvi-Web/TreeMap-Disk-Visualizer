import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { isolatedDataDir, fileTempDir } from './fixtures/dataDir';
isolatedDataDir('treemap-cleanupSlices-data-');
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  collectCleanupSuggestions,
  collectCleanupSuggestionsAsync,
  CLEANUP_MAX_ATTEMPTS,
  CLEANUP_SLICE_NODES,
} from '../src/services/cleanupRules';
import {
  cleanupClaimsFor,
  cleanupMemoCountsForTests,
  cleanupSuggestionsFor,
  resetCleanupMemoForTests,
  setCleanupMemoOptionsForTests,
} from '../src/services/cleanupMemo';
import { computeRuleClaims } from '../src/services/reclaimInputs';
import { selectCandidates, simulatePolicy } from '../src/services/autopilot';
import { createScanRecord } from '../src/services/diskScanner';
import { findGitRepos } from '../src/services/gitScanner';
import { buildStoreFromTree, fileNodeToInput, ObjectScanStore, ScanStore } from '../src/services/scanStore';
import { loadRuleCatalog, Rule, RuleCatalog } from '../src/services/rulePacks';
import { compileIgnoreList, CompiledIgnore } from '../src/utils/glob';
import { sanitizePath } from '../src/utils/pathSanitizer';
import { AutopilotMatch, AutopilotPolicy, CleanupSuggestionGroup, FileNode } from '../src/models/types';
import { createApp } from '../src/server';
import { buildMcpServer } from '../src/mcp/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { makeRng } from './fixtures/storeFuzz';
import { oracleCleanupSuggestions } from './fixtures/cleanupOracle';

/**
 * Track U, U-16: cleanup suggestions walked in slices, once per scan version,
 * with the same answer.
 *
 * The diagnosis measured `collectCleanupSuggestions` holding the event loop for
 * 76 % of a 13.4 s stall after a 9M-entry scan (run3/prof-stalls.txt) — in the
 * desktop app that is the window frozen. The matcher now walks with an explicit
 * stack that the sync form drains and the async form cuts into slices of
 * CLEANUP_SLICE_NODES children, under the version guard U-D9 fixes: a store
 * that changes between slices is walked again, at most CLEANUP_MAX_ATTEMPTS
 * times, the last in one turn. A memo per store answers every surface from one
 * walk until the store, the ignore list, the note list, the rule catalog or the
 * clock (a stale-files threshold crossed) changes the answer.
 *
 * "The same answer" is held to the pre-change matcher, copied verbatim as the
 * oracle (tests/fixtures/cleanupOracle.ts), byte for byte and observer order
 * included, on fuzz trees that hit every rule kind. Everything that proves the
 * slicing is counted — turns handed back, walks, attempts, names read — and
 * nothing is timed.
 */

const DAY = 86_400_000;
/** The clock the sliced walk is handed, so a stale-files threshold can sit exactly on a file. */
const T = 1_790_000_000_000;
/** A reading of the real clock, used only as a seed: the drained walk reads the real clock itself. */
const SEED_NOW = Date.now();

/**
 * A folder at the top of this machine's file system, spelled as a scan root is spelled here: `/fz` on
 * macOS and Linux, `D:\fz` on Windows (the working folder's drive). Every scan root on Windows has
 * a drive or a share — sanitizePath resolves it — and a store reads its separator off that
 * (separatorOf). `path.join(path.sep, …)` gave Windows the drive-less `\fz`, which a store reads as
 * "/" while the trees here join their paths with "\": lookups below the top missed, and the packed
 * store spelled paths no rule names (Windows CI run 38345032466).
 */
const absRoot = (...names: string[]): string => path.resolve(path.sep, ...names);

const STORES: ReadonlyArray<readonly [string, (tree: FileNode) => ScanStore]> = [
  ['object store', (tree) => ObjectScanStore.wrap(tree)],
  ['packed store', (tree) => buildStoreFromTree(tree)],
];

/* ───────────────────────────── fuzz trees ───────────────────────────── */

type Rng = () => number;

const DIR_WORDS = [
  'node_modules', 'Node_Modules', 'target', 'TARGET', 'dist', '.next', 'build', '.cache', 'coverage',
  '.venv', 'src', 'proj', 'skipme', 'pkg', 'Downloads', 'downloads',
];
const FILE_WORDS = [
  'Cargo.toml', 'cargo.TOML', 'pom.xml', 'package.json', 'next.config.mjs', 'requirements.txt',
  '.DS_Store', 'thumbs.DB', 'notes.log', 'a.bin', 'b.tmp', 'readme.md',
];

function pick<T>(rng: Rng, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)];
}

function fileAt(at: string, name: string, size: number, modifiedAt: number): FileNode {
  return { name, path: path.join(at, name), size, type: 'file', modifiedAt, isHidden: name.startsWith('.') };
}

function dirAt(at: string, name: string, children: FileNode[], modifiedAt = 0): FileNode {
  return {
    name, path: path.join(at, name), type: 'dir', modifiedAt, isHidden: name.startsWith('.'),
    size: children.reduce((sum, c) => sum + c.size, 0), children,
  };
}

/**
 * A random tree rooted at `root`, its names drawn half from words the test
 * catalog's rules name (in several cases) and half fresh, plus fixed grafts for
 * the location and stale-files rules: a browser cache, a U+0130 folder, an
 * advisory location and a Downloads folder, each in a case the seed picks.
 */
function fuzzTree(seed: number, root: string, budget: number, mtime: (rng: Rng) => number): FileNode {
  const rng = makeRng(seed);
  let serial = 0;
  let left = budget;
  const fresh = (prefix: string): string => `${prefix}${(serial++).toString(36)}`;
  const size = (): number => (rng() < 0.12 ? 0 : 1 + Math.floor(rng() ** 2 * 40_000));
  const files = (at: string, n: number): FileNode[] =>
    Array.from({ length: n }, () => fileAt(at, fresh('g') + '.dat', size(), mtime(rng)));

  const grow = (here: string, depth: number): FileNode[] => {
    const kids: FileNode[] = [];
    const used = new Set<string>();
    const count = depth > 6 ? 0 : Math.floor(rng() * 9);
    for (let i = 0; i < count && left > 0; i++) {
      left--;
      const isDir = rng() < 0.38;
      let name = rng() < 0.5 ? pick(rng, isDir ? DIR_WORDS : FILE_WORDS) : fresh(isDir ? 'd' : 'f');
      if (used.has(name)) name = fresh(`${name}~`);
      used.add(name);
      kids.push(isDir ? dirAt(here, name, grow(path.join(here, name), depth + 1), mtime(rng)) : fileAt(here, name, size(), mtime(rng)));
    }
    return kids;
  };

  const top: FileNode[] = [];
  const lib = path.join(root, 'Library');
  const caches = path.join(lib, 'Caches');
  const browser = pick(rng, ['Firefox', 'firefox', 'FIREFOX']);
  const cachesKids = [dirAt(caches, browser, files(path.join(caches, browser), 3))];
  if (rng() < 0.5) cachesKids.push(dirAt(caches, 'Chromium', files(path.join(caches, 'Chromium'), 2)));
  top.push(dirAt(root, 'Library', [dirAt(lib, 'Caches', cachesKids)]));
  // U+0130 lowercases to two code units ("i" + U+0307): a rule spelled one way
  // must still find the folder spelled the other, wherever case folds.
  const dotted = pick(rng, ['İstanbul', 'i̇stanbul', 'Istanbul']);
  const dottedCache = pick(rng, ['Cache', 'cache']);
  const dottedAt = path.join(root, dotted);
  top.push(dirAt(root, dotted, [dirAt(dottedAt, dottedCache, files(path.join(dottedAt, dottedCache), 2))]));
  top.push(dirAt(root, 'vm', [dirAt(path.join(root, 'vm'), 'disk', files(path.join(root, 'vm', 'disk'), 1))]));
  const downloads = pick(rng, ['Downloads', 'downloads', 'DOWNLOADS']);
  const dl = path.join(root, downloads);
  const dlKids: FileNode[] = [];
  for (let i = 0; i < 12; i++) dlKids.push(fileAt(dl, fresh('dl') + '.zip', pick(rng, [5, 50, 5_000, 50_000]), mtime(rng)));
  dlKids.push(dirAt(dl, 'sub', Array.from({ length: 3 }, () => fileAt(path.join(dl, 'sub'), fresh('s') + '.iso', 50_000, mtime(rng)))));
  top.push(dirAt(root, downloads, dlKids));

  const used = new Set(top.map((n) => n.name));
  while (left > 0) {
    left--;
    const isDir = rng() < 0.85;
    let name = rng() < 0.4 ? pick(rng, isDir ? DIR_WORDS : FILE_WORDS) : fresh(isDir ? 'd' : 'f');
    if (used.has(name)) name = fresh(`${name}~`);
    used.add(name);
    top.push(isDir ? dirAt(root, name, grow(path.join(root, name), 1), mtime(rng)) : fileAt(root, name, size(), mtime(rng)));
  }
  return { name: path.basename(root), path: root, type: 'dir', modifiedAt: 0, isHidden: false, size: top.reduce((s, c) => s + c.size, 0), children: top };
}

/** Modification times that sit on, and a millisecond either side of, the test catalog's thresholds at `now`. */
const nearThresholds = (now: number) => (rng: Rng): number =>
  rng() < 0.4 ? now - pick(rng, [90, 30.5]) * DAY + pick(rng, [-2, -1, 0, 1, 2]) : now - Math.floor(rng() * 300 * DAY);

/** Ages at least half a day from both thresholds, for the drained walk, which reads the real clock itself. */
const farFromThresholds = (base: number) => (rng: Rng): number =>
  base - pick(rng, [1, 10, 29, 32, 60, 89, 91, 200, 400]) * DAY - Math.floor(rng() * 6 * 3_600_000);

/** Every folder path in a tree, root excluded, in pre-order. */
function folders(tree: FileNode): string[] {
  const out: string[] = [];
  const walk = (n: FileNode): void => {
    for (const c of n.children ?? []) {
      if (c.type !== 'dir') continue;
      out.push(c.path);
      walk(c);
    }
  };
  walk(tree);
  return out;
}

/** Every path a tree holds, root included, in pre-order. */
function everyPath(tree: FileNode): string[] {
  return [tree.path, ...(tree.children ?? []).flatMap(everyPath)];
}

/* ───────────────────────────── the catalog ───────────────────────────── */

const ruleBase = (id: string, category: 'regenerable' | 'cache' | 'junk' = 'regenerable') => ({
  id, title: `Rule ${id}`, description: `The test rule ${id}.`, category, confidence: 'high' as const, action: 'trash' as const,
});

/**
 * Every rule kind the matcher knows, sibling-gated and not, an advisory rule of
 * two kinds, two location rules sharing a path in different cases (the first
 * must win), and two stale-files rules over the same folder at different ages
 * and sizes (the first that matches wins).
 */
function testCatalog(root: string): RuleCatalog {
  return {
    schemaVersion: 1,
    packs: [{ name: 'test', updated: '2026-10-02', ruleCount: 14 }],
    projectDirectory: [
      { ...ruleBase('p-node'), kind: 'project-directory', names: ['node_modules'], restoreCommand: 'npm install' },
      { ...ruleBase('p-rust'), kind: 'project-directory', names: ['target'], requiresSibling: ['cargo.toml'], restoreCommand: 'cargo build' },
      { ...ruleBase('p-maven'), kind: 'project-directory', names: ['target'], requiresSibling: ['pom.xml'], restoreCommand: 'mvn package' },
      { ...ruleBase('p-web'), kind: 'project-directory', names: ['dist', '.next'], requiresSibling: ['package.json', 'next.config.*'], restoreCommand: 'npm run build' },
      { ...ruleBase('p-venv'), kind: 'project-directory', action: 'advice', adviceCommand: 'conda clean --all', names: ['.venv'], requiresSibling: ['requirements.txt'], restoreCommand: 'pip install -r requirements.txt' },
    ],
    directory: [
      { ...ruleBase('d-build'), kind: 'directory', names: ['dist', 'target', 'build'] },
      { ...ruleBase('d-cache', 'cache'), kind: 'directory', names: ['.cache', 'coverage', '.venv'] },
    ],
    file: [{ ...ruleBase('f-junk', 'junk'), kind: 'file', names: ['.ds_store', 'thumbs.db'] }],
    location: [
      { ...ruleBase('l-browser', 'cache'), kind: 'location', paths: [path.join(root, 'Library', 'Caches', 'Firefox'), path.join(root, 'Library', 'Caches', 'Chromium')] },
      { ...ruleBase('l-dotted', 'cache'), kind: 'location', paths: [path.join(root, 'İstanbul', 'Cache'), path.join(root, 'Library', 'Caches', 'firefox')] },
      { ...ruleBase('l-vm', 'cache'), kind: 'location', action: 'advice', adviceCommand: 'docker system prune', paths: [path.join(root, 'vm', 'disk')] },
    ],
    staleFiles: [
      { ...ruleBase('s-old', 'junk'), kind: 'stale-files', withinPath: path.join(root, 'Downloads'), olderThanDays: 90, minSizeBytes: 1_000 },
      { ...ruleBase('s-small', 'junk'), kind: 'stale-files', withinPath: path.join(root, 'Downloads'), olderThanDays: 30.5, minSizeBytes: 10 },
    ],
    packageCache: [],
  };
}

const RULE_IDS = ['p-node', 'p-rust', 'p-maven', 'p-web', 'p-venv', 'd-build', 'd-cache', 'f-junk', 'l-browser', 'l-dotted', 'l-vm', 's-old', 's-small'];

/** The ignore lists and note lists each tree is matched under, ignores and notes in both containment directions. */
function variantsFor(tree: FileNode, root: string): Array<{ label: string; ignore: CompiledIgnore[]; suppressed: string[] }> {
  const dirs = folders(tree);
  const nodeModules = dirs.find((d) => path.basename(d).toLowerCase() === 'node_modules');
  const inside = nodeModules ? dirs.find((d) => d.startsWith(nodeModules + path.sep)) : undefined;
  const middle = dirs[Math.floor(dirs.length / 2)];
  const notes = [nodeModules, inside, middle, middle?.toUpperCase()].filter((p): p is string => typeof p === 'string');
  return [
    { label: 'plain', ignore: [], suppressed: [] },
    {
      label: 'ignores',
      ignore: compileIgnoreList(['*.log', 'skipme', 'Node_Modules', path.join(root, 'Library', 'Caches', 'Chromium'), path.join(root, 'd1*')]),
      suppressed: [],
    },
    { label: 'notes', ignore: [], suppressed: notes },
  ];
}

async function withPlatform<R>(platform: NodeJS.Platform, fn: () => Promise<R>): Promise<R> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  Object.defineProperty(process, 'platform', { ...real, value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

/** Lines the observer heard, in order. */
function recorder(): { seen: string[]; observe: (rule: Rule, nodePath: string) => void } {
  const seen: string[] = [];
  return { seen, observe: (rule, nodePath) => { seen.push(`${rule.id}\t${nodePath}`); } };
}

const immediate = (): Promise<void> => Promise.resolve();

/* ──────────────────────── the same answer, byte for byte ──────────────────────── */

test('the sliced walk and the drained walk give the pre-change answer, observer order included, on fuzz trees with every rule kind', async () => {
  // The rules each kind of store fired, apart: a store whose paths no rule names (a drive-less root
  // read with the wrong separator, as on the Windows runner) passed the differential while the other
  // store fired every rule for it.
  const fired = new Map<string, Set<string>>(STORES.map(([kind]) => [kind, new Set<string>()]));
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    await withPlatform(platform, async () => {
      for (let seed = 1; seed <= 24; seed++) {
        const root = absRoot('fz', `root${seed}`);
        const catalog = testCatalog(root);

        // The sliced walk, on a clock of its own: thresholds land on files.
        const exact = fuzzTree(seed, root, 600, nearThresholds(T));
        for (const v of variantsFor(exact, root)) {
          for (const [kind, make] of STORES) {
            const label = `${platform}, seed ${seed}, ${v.label}, ${kind}`;
            const want = recorder();
            const oracle = oracleCleanupSuggestions(make(exact), v.ignore, catalog, want.observe, v.suppressed, T);
            for (const g of oracle) fired.get(kind)?.add(g.id);
            const got = recorder();
            const sliced = await collectCleanupSuggestionsAsync(make(exact), v.ignore, catalog, got.observe, v.suppressed, {
              now: () => T, sliceNodes: 5, yieldTurn: immediate,
            });
            assert.equal(JSON.stringify(sliced.groups), JSON.stringify(oracle), `${label}: the sliced walk answers what the old walk answered`);
            assert.deepEqual(got.seen, want.seen, `${label}: and tells the observer the same claims in the same order`);
          }
        }

        // The drained walk reads the real clock, so its ages stay clear of every threshold.
        const loose = fuzzTree(seed + 1000, root, 600, farFromThresholds(SEED_NOW));
        for (const v of variantsFor(loose, root)) {
          for (const [kind, make] of STORES) {
            const label = `${platform}, seed ${seed + 1000}, ${v.label}, ${kind}`;
            const want = recorder();
            const oracle = oracleCleanupSuggestions(make(loose), v.ignore, catalog, want.observe, v.suppressed);
            for (const g of oracle) fired.get(kind)?.add(g.id);
            const got = recorder();
            const drained = collectCleanupSuggestions(make(loose), v.ignore, catalog, got.observe, v.suppressed);
            assert.equal(JSON.stringify(drained), JSON.stringify(oracle), `${label}: the drained walk answers what the old walk answered`);
            assert.deepEqual(got.seen, want.seen, `${label}: and tells the observer the same claims in the same order`);
          }
        }
      }
    });
  }
  // A differential that never fires a rule proves nothing about that rule.
  for (const [kind, ids] of fired) {
    assert.deepEqual([...ids].sort(), [...RULE_IDS].sort(), `${kind}: the fuzz trees fired every rule of the test catalog`);
  }
});

test('the shipped rule packs give the pre-change answer through the rewritten walk', async () => {
  const home = path.dirname(loadRuleCatalog().staleFiles[0].withinPath); // {home}, as the packs expanded it
  // The shipped rules each kind of store fired, apart, and the paths it claimed: a packed store
  // joining with the wrong separator spells paths the tree does not hold and fires no location rule,
  // while both walks read the same store and agree (review F1.1).
  const fired = new Map<string, Set<string>>(STORES.map(([kind]) => [kind, new Set<string>()]));
  for (let seed = 1; seed <= 12; seed++) {
    const tree = fuzzTree(seed, home, 900, farFromThresholds(SEED_NOW));
    const held = new Set(everyPath(tree));
    for (const [kind, make] of STORES) {
      const want = recorder();
      const oracle = oracleCleanupSuggestions(make(tree), [], loadRuleCatalog(), want.observe, []);
      const got = recorder();
      const sliced = await collectCleanupSuggestionsAsync(make(tree), [], loadRuleCatalog(), got.observe, [], { sliceNodes: 3, yieldTurn: immediate });
      assert.equal(JSON.stringify(sliced.groups), JSON.stringify(oracle), `seed ${seed}, ${kind}: the shipped packs answer as before`);
      assert.deepEqual(got.seen, want.seen, `seed ${seed}, ${kind}: observer order`);
      assert.equal(JSON.stringify(collectCleanupSuggestions(make(tree), [], loadRuleCatalog())), JSON.stringify(oracle), `seed ${seed}, ${kind}: drained`);
      for (const g of oracle) fired.get(kind)?.add(g.id);
      const strays = oracle.flatMap((g) => g.items.map((item) => item.path)).filter((p) => !held.has(p));
      assert.deepEqual(strays, [], `seed ${seed}, ${kind}: every path the shipped packs claim is a path of the tree`);
    }
  }
  // A differential that fires nothing proves nothing, and two kinds of store reading one tree fire the same rules.
  const [[, objectFired], ...others] = [...fired];
  assert.ok(objectFired.size > 0, 'the fuzz trees fired a shipped rule');
  for (const [kind, ids] of others) {
    assert.deepEqual([...ids].sort(), [...objectFired].sort(), `${kind}: fired every shipped rule the object store fired, and no other`);
  }
});

test('a U+0130 location is found wherever case folds, and only there', async () => {
  const root = absRoot('dotted');
  const catalog = testCatalog(root);
  // The rule says "İstanbul/Cache"; the disk says "i̇stanbul/cache": one code unit longer, the same folded.
  const at = path.join(root, 'i̇stanbul');
  const tree = dirAt(path.dirname(root), 'dotted', [dirAt(root, 'i̇stanbul', [dirAt(at, 'cache', [fileAt(path.join(at, 'cache'), 'x.bin', 10, 0)])])]);
  for (const [platform, expected] of [['darwin', 1], ['win32', 1], ['linux', 0]] as const) {
    await withPlatform(platform, async () => {
      for (const [kind, make] of STORES) {
        const sliced = await collectCleanupSuggestionsAsync(make(tree), [], catalog, undefined, [], { now: () => T, yieldTurn: immediate });
        const hit = sliced.groups.find((g) => g.id === 'l-dotted');
        assert.equal(hit?.items.length ?? 0, expected, `${platform}, ${kind}: the dotted location is ${expected ? 'found' : 'not found — Linux does not fold case'}`);
        assert.equal(JSON.stringify(sliced.groups), JSON.stringify(oracleCleanupSuggestions(make(tree), [], catalog, undefined, [], T)), `${platform}, ${kind}: as the old walk`);
      }
    });
  }
});

test('the Autopilot selects through the rewritten matcher exactly what it selected through the old one', async () => {
  const matches: Array<Extract<AutopilotMatch, { kind: 'suggestion' }>> = [
    { kind: 'suggestion', groupIds: ['p-node', 'd-build', 'f-junk'] },
    { kind: 'suggestion', groupIds: ['s-old', 's-small', 'l-browser', 'l-dotted', 'p-rust', 'p-maven', 'p-web'] },
  ];
  // The groups each kind of store had candidates picked from, per match, apart: a packed store
  // joining with the wrong separator (the Windows runner's break) picked no location or stale-files
  // candidate through either matcher, and the comparison below still held (review F1.1).
  const picked = new Map<string, Array<Set<string>>>(STORES.map(([kind]) => [kind, matches.map(() => new Set<string>())]));
  for (let seed = 1; seed <= 16; seed++) {
    const root = absRoot('ap', `root${seed}`);
    const catalog = testCatalog(root);
    const tree = fuzzTree(seed, root, 700, nearThresholds(T));
    for (const [kind, make] of STORES) {
      const old = oracleCleanupSuggestions(make(tree), [], catalog, undefined, [], T);
      const sliced = await collectCleanupSuggestionsAsync(make(tree), [], catalog, undefined, [], { now: () => T, sliceNodes: 11, yieldTurn: immediate });
      const groupOf = new Map(old.flatMap((g) => g.items.map((item) => [item.path, g.id] as const)));
      for (let i = 0; i < matches.length; i++) {
        const candidates = selectCandidates(sliced.groups, [], matches[i]);
        assert.deepEqual(candidates, selectCandidates(old, [], matches[i]), `seed ${seed}, ${kind}: the same candidates in the same order`);
        for (const c of candidates) picked.get(kind)?.[i].add(groupOf.get(c.path) ?? c.path);
      }
    }
  }
  // A comparison that never picks from a group proves nothing about that group.
  for (const [kind, perMatch] of picked) {
    for (let i = 0; i < matches.length; i++) {
      assert.deepEqual([...perMatch[i]].sort(), [...matches[i].groupIds].sort(), `${kind}: policy ${i + 1} picked from every group it names, over the seeds`);
    }
  }
});

/* ───────────────────────────── slices, counted ───────────────────────────── */

/** A wide tree that matches no rule: every child is examined, so the count of children examined is known. */
function wideTree(root: string, folderCount: number, filesEach: number): { tree: FileNode; examined: number } {
  const kids: FileNode[] = [];
  for (let d = 0; d < folderCount; d++) {
    const at = path.join(root, `d${d}`);
    kids.push(dirAt(root, `d${d}`, Array.from({ length: filesEach }, (_, f) => fileAt(at, `f${f}.dat`, 1 + f, 0))));
  }
  return {
    tree: { name: path.basename(root), path: root, type: 'dir', modifiedAt: 0, isHidden: false, size: kids.reduce((s, c) => s + c.size, 0), children: kids },
    examined: folderCount + folderCount * filesEach,
  };
}

test('the walk hands the loop back once per slice of 16,384 children, and a turn queued before it runs before it answers', async () => {
  assert.equal(CLEANUP_SLICE_NODES, 16_384, 'the slice the plan fixes');
  const { tree, examined } = wideTree(absRoot('wide'), 50, 1_000);
  for (const [kind, make] of STORES) {
    let yields = 0;
    const yieldTurn = (): Promise<void> => new Promise<void>((resolve) => { yields++; setImmediate(resolve); });
    const order: string[] = [];
    setImmediate(() => order.push('probe'));
    const walk = await collectCleanupSuggestionsAsync(make(tree), [], loadRuleCatalog(), undefined, [], { yieldTurn });
    order.push('answered');
    assert.equal(yields, Math.ceil(examined / CLEANUP_SLICE_NODES), `${kind}: one turn per slice of ${CLEANUP_SLICE_NODES} of the ${examined} children`);
    assert.deepEqual(order, ['probe', 'answered'], `${kind}: a turn queued before the walk ran before the walk answered`);
    assert.equal(walk.attempts, 1, `${kind}: an unchanged store is walked once`);
    assert.deepEqual(walk.groups, [], `${kind}: and the wide tree matches nothing`);
  }
});

test('a store other than the packed one answers its own child paths, as a legacy tree spelled them', async () => {
  // A wrapped legacy tree may store a child path that is not parent + sep +
  // name; the matcher must report the path the store holds, as it always did.
  const nm = '/legacy\\proj\\node_modules';
  const tree: FileNode = {
    name: 'legacy', path: '/legacy', type: 'dir', modifiedAt: 0, isHidden: false, size: 10,
    children: [{
      name: 'proj', path: '/legacy/proj', type: 'dir', modifiedAt: 0, isHidden: false, size: 10,
      children: [{ name: 'node_modules', path: nm, type: 'dir', modifiedAt: 0, isHidden: false, size: 10, children: [fileAt(nm, 'i.js', 10, 0)] }],
    }],
  };
  const oracle = JSON.stringify(oracleCleanupSuggestions(ObjectScanStore.wrap(tree), [], loadRuleCatalog()));
  assert.ok(oracle.includes(JSON.stringify(nm).slice(1, -1)), 'the old walk reports the stored spelling');
  assert.equal(JSON.stringify(collectCleanupSuggestions(ObjectScanStore.wrap(tree), [], loadRuleCatalog())), oracle, 'drained');
  const sliced = await collectCleanupSuggestionsAsync(ObjectScanStore.wrap(tree), [], loadRuleCatalog(), undefined, [], { yieldTurn: immediate });
  assert.equal(JSON.stringify(sliced.groups), oracle, 'sliced');
});

test('each name is read once, and a folder\'s names again only when a sibling-gated rule names one of its children', () => {
  const root = absRoot('names');
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  const tree = dirAt(path.dirname(root), 'names', [
    dirAt(root, 'a', Array.from({ length: 5 }, (_, i) => fileAt(a, `f${i}.dat`, 10, 0))),
    dirAt(root, 'b', [dirAt(b, 'target', [fileAt(path.join(b, 'target'), 'o.rlib', 10, 0)]), fileAt(b, 'Cargo.toml', 1, 0), fileAt(b, 'x.dat', 1, 0), fileAt(b, 'y.dat', 1, 0)]),
  ]);
  // Examined: a, b, a's five files, b's four children = 11. Read again: b's four
  // names, once, for the Rust rule's sibling check on `target`.
  for (const [kind, make] of STORES) {
    const store = make(tree);
    let reads = 0;
    const name = store.name.bind(store);
    store.name = (id: number): string => { reads++; return name(id); };
    const groups = collectCleanupSuggestions(store, [], loadRuleCatalog());
    assert.equal(groups.find((g) => g.id === 'regen-rust-target')?.items.length, 1, `${kind}: target beside Cargo.toml is claimed`);
    assert.equal(reads, 11 + 4, `${kind}: 11 names read once each, and b's 4 once more for its sibling check`);
  }
});

test('a folder a rule asks about has its own names read once, however many of the rule\'s conditions ask - a .gradle is judged on what it must hold and what it must not from one read (BQL-b1 review F3.3)', () => {
  // The Gradle project-cache rule names both what a .gradle holds
  // (requiresChild) and what it must not (forbidsChild). Both look at the
  // folder's own child names through one memo; without it each condition read
  // them again, and the test above walks no folder a rule asks this of.
  const root = absRoot('gradlereads');
  const proj = path.join(root, 'proj');
  const dotGradle = path.join(proj, '.gradle');
  const held = ['buildOutputCleanup', 'file-system.probe', 'notes.txt', 'vcs-1', 'x.bin'];
  const tree = dirAt(path.dirname(root), 'gradlereads', [
    dirAt(root, 'proj', [dirAt(proj, '.gradle', held.map((n) => fileAt(dotGradle, n, 10, 0))), fileAt(proj, 'build.gradle', 1, 0)]),
  ]);
  for (const [kind, make] of STORES) {
    const store = make(tree);
    const name = store.name.bind(store);
    const childNamed = (at: number, n: string): number => {
      const id = store.childIds(at).find((c) => name(c) === n);
      assert.ok(id !== undefined, `${kind}: ${n} is in the tree`);
      return id;
    };
    const inside = store.childIds(childNamed(childNamed(store.rootId, 'proj'), '.gradle'));
    const reads = new Map<number, number>();
    store.name = (id: number): string => { reads.set(id, (reads.get(id) ?? 0) + 1); return name(id); };
    const groups = collectCleanupSuggestions(store, [], loadRuleCatalog());
    assert.deepEqual(groups.find((g) => g.id === 'gradle-project-cache')?.items.map((i) => i.path), [dotGradle], `${kind}: the .gradle beside build.gradle is offered`);
    assert.deepEqual(inside.map((c) => [name(c), reads.get(c) ?? 0]).sort(), held.map((n) => [n, 1]),
      `${kind}: each name in it is read once, for both of its rule's conditions`);
  }
});

/**
 * A store that changes during the walk is walked again. `mutateOn` decides,
 * at each turn the walk hands back, whether to change it.
 */
async function walkWhileChanging(store: ScanStore, change: (store: ScanStore, turn: number) => void, mutateOn: (turn: number) => boolean) {
  let turn = 0;
  const yieldsPerAttempt: number[] = [];
  const heard = recorder();
  const result = await collectCleanupSuggestionsAsync(store, [], loadRuleCatalog(), heard.observe, [], {
    sliceNodes: 4,
    yieldTurn: async () => {
      turn++;
      yieldsPerAttempt[yieldsPerAttempt.length - 1]++;
      if (mutateOn(turn)) change(store, turn);
    },
    onAttempt: () => { yieldsPerAttempt.push(0); },
  });
  return { result, yieldsPerAttempt, heard: heard.seen };
}

function projectsTree(root: string): FileNode {
  const kids: FileNode[] = [];
  for (let p = 0; p < 8; p++) {
    const at = path.join(root, `p${p}`);
    const nm = path.join(at, 'node_modules');
    kids.push(dirAt(root, `p${p}`, [
      dirAt(at, 'node_modules', [fileAt(nm, 'index.js', 100 + p, 0)]),
      fileAt(at, 'package.json', 2, 0),
      fileAt(at, 'main.js', 3, 0),
    ]));
  }
  return { name: path.basename(root), path: root, type: 'dir', modifiedAt: 0, isHidden: false, size: kids.reduce((s, c) => s + c.size, 0), children: kids };
}

/** Grows the first project's node_modules — a folder the first slice has already claimed. */
function growFirstClaim(store: ScanStore, turn: number): void {
  const id = store.findByPath(path.join(store.rootPath, 'p0', 'node_modules'));
  store.setSize(id, store.size(id) + 1_000 * turn);
}

/**
 * An ObjectScanStore built node by node, through the class's constructor and
 * `addNode`. One made by `ObjectScanStore.wrap` skips the field initialisers
 * and starts its own version at 0 (U-18); both are walked while changing, so
 * both ways an object store is made count their edits the same.
 */
function builtObjectStore(tree: FileNode): ScanStore {
  const store = new ObjectScanStore(tree.path, path.sep, fileNodeToInput(tree));
  const add = (parent: number, kids: FileNode[] | undefined): void => {
    for (const kid of kids ?? []) add(store.addNode(parent, fileNodeToInput(kid)), kid.children);
  };
  add(store.rootId, tree.children);
  return store;
}

const MUTABLE_STORES: ReadonlyArray<readonly [string, (tree: FileNode) => ScanStore]> = [
  ['object store', builtObjectStore],
  ['wrapped object store', (tree) => ObjectScanStore.wrap(tree)],
  ['packed store', (tree) => buildStoreFromTree(tree)],
];

test('a store changed during a walk is walked again, and the answer is the changed store\'s', async () => {
  for (const [kind, make] of MUTABLE_STORES) {
    const store = make(projectsTree(absRoot('changing')));
    const { result, yieldsPerAttempt, heard } = await walkWhileChanging(store, growFirstClaim, (turn) => turn === 1);
    assert.equal(result.attempts, 2, `${kind}: the change on the first turn started a second walk`);
    assert.equal(yieldsPerAttempt.length, 2, `${kind}: two attempts began`);
    assert.equal(result.version, store.version, `${kind}: the answer describes the store as it is now`);
    const want = recorder();
    const oracle = oracleCleanupSuggestions(store, [], loadRuleCatalog(), want.observe);
    assert.equal(JSON.stringify(result.groups), JSON.stringify(oracle), `${kind}: the changed store's answer, not a mix`);
    assert.deepEqual(heard, want.seen, `${kind}: the observer heard the finished walk only, not the abandoned one's claims as well`);
  }
});

test('a store that keeps changing is walked at most three times, the last in one turn', async () => {
  assert.equal(CLEANUP_MAX_ATTEMPTS, 3, 'U-D9: at most 3 attempts');
  for (const [kind, make] of MUTABLE_STORES) {
    const store = make(projectsTree(absRoot('storm')));
    const { result, yieldsPerAttempt } = await walkWhileChanging(store, growFirstClaim, () => true);
    assert.equal(result.attempts, CLEANUP_MAX_ATTEMPTS, `${kind}: a change on every turn ends at the third attempt`);
    assert.deepEqual(yieldsPerAttempt, [1, 1, 0], `${kind}: the first two gave up at their first turn; the last took none`);
    assert.equal(JSON.stringify(result.groups), JSON.stringify(oracleCleanupSuggestions(store, [], loadRuleCatalog())), `${kind}: and its answer is the final store's`);
  }
});

test('a wrapped object store counts its edits: the memo answers it once per version, and walks it again after every edit', async () => {
  resetCleanupMemoForTests();
  setCleanupMemoOptionsForTests({ yieldTurn: immediate, sliceNodes: 4 });
  try {
    const store = ObjectScanStore.wrap(projectsTree(absRoot('wrapped')));
    const catalog = loadRuleCatalog();
    for (let edits = 0; edits <= 3; edits++) {
      if (edits > 0) growFirstClaim(store, edits);
      const want = JSON.stringify(oracleCleanupSuggestions(store, [], catalog));
      assert.equal(JSON.stringify(await cleanupSuggestionsFor(store, [], catalog, [])), want, `after ${edits} edit(s): the edited store's answer, never an earlier version's`);
      assert.equal(JSON.stringify(await cleanupSuggestionsFor(store, [], catalog, [])), want, `after ${edits} edit(s): asked again, the same answer`);
      assert.deepEqual(cleanupMemoCountsForTests(), { suggestions: edits + 1, claims: 0, reused: edits + 1 },
        `after ${edits} edit(s): one walk per version, and the second request answered from it`);
    }
  } finally {
    setCleanupMemoOptionsForTests(null);
  }
});

test('a second wrap of an edited tree starts at version 0 again, and is answered from its own walk, never from another wrap\'s', async () => {
  resetCleanupMemoForTests();
  setCleanupMemoOptionsForTests({ yieldTurn: immediate, sliceNodes: 4 });
  try {
    const tree = projectsTree(absRoot('rewrapped'));
    const catalog = loadRuleCatalog();
    const first = ObjectScanStore.wrap(tree);
    const before = JSON.stringify(await cleanupSuggestionsFor(first, [], catalog, []));
    // Edit the shared tree through another wrap: the first wrap's memo keeps its version-0 answer.
    growFirstClaim(ObjectScanStore.wrap(tree), 1);
    const later = ObjectScanStore.wrap(tree);
    assert.equal(later.version, first.version, 'the new wrap is at the same version number as the first wrap\'s remembered answer');
    const want = JSON.stringify(oracleCleanupSuggestions(later, [], catalog));
    assert.notEqual(want, before, 'the edit changed the answer');
    assert.equal(JSON.stringify(await cleanupSuggestionsFor(later, [], catalog, [])), want, 'the new wrap gets the edited tree\'s answer');
    assert.equal(cleanupMemoCountsForTests().suggestions, 2, 'from a walk of its own');
  } finally {
    setCleanupMemoOptionsForTests(null);
  }
});

/* ───────────────────────────── one walk per version ───────────────────────────── */

test('two requests at once make one walk; a changed size, ignore list, note list or catalog makes another', async () => {
  for (const [kind, make] of STORES) {
    resetCleanupMemoForTests();
    setCleanupMemoOptionsForTests({ yieldTurn: immediate, sliceNodes: 3 });
    try {
      const root = absRoot('memo');
      const tree = projectsTree(root);
      const store = make(tree);
      const catalog = loadRuleCatalog();
      const [first, second] = await Promise.all([
        cleanupSuggestionsFor(store, [], catalog, []),
        cleanupSuggestionsFor(store, [], catalog, []),
      ]);
      assert.equal(cleanupMemoCountsForTests().suggestions, 1, `${kind}: two requests at once share one walk`);
      assert.equal(cleanupMemoCountsForTests().reused, 1, `${kind}: the second waited for the first's`);
      const want = JSON.stringify(oracleCleanupSuggestions(store, [], catalog));
      assert.equal(JSON.stringify(first), want, `${kind}: the shared answer is the old walk's`);
      assert.equal(JSON.stringify(second), want, `${kind}: for both requests`);

      assert.equal(JSON.stringify(await cleanupSuggestionsFor(store, [], catalog, [])), want, `${kind}: a later request is answered`);
      assert.equal(cleanupMemoCountsForTests().suggestions, 1, `${kind}: from the memo, with no second walk`);

      // Every caller gets its own copy: one that edits its answer edits nobody else's.
      first[0].items.push({ ...first[0].items[0] });
      first[0].totalSize = -1;
      assert.equal(JSON.stringify(await cleanupSuggestionsFor(store, [], catalog, [])), want, `${kind}: an edited answer is not the memo's`);

      growFirstClaim(store, 1);
      assert.equal(JSON.stringify(await cleanupSuggestionsFor(store, [], catalog, [])), JSON.stringify(oracleCleanupSuggestions(store, [], catalog)), `${kind}: a changed store is walked again`);
      assert.equal(cleanupMemoCountsForTests().suggestions, 2, `${kind}: one more walk for the new version`);

      const ignore = compileIgnoreList(['p1']);
      assert.equal(JSON.stringify(await cleanupSuggestionsFor(store, ignore, catalog, [])), JSON.stringify(oracleCleanupSuggestions(store, ignore, catalog)), `${kind}: a changed ignore list`);
      assert.equal(cleanupMemoCountsForTests().suggestions, 3, `${kind}: is walked again`);

      const noted = [path.join(root, 'p2')];
      assert.equal(JSON.stringify(await cleanupSuggestionsFor(store, ignore, catalog, noted)), JSON.stringify(oracleCleanupSuggestions(store, ignore, catalog, undefined, noted)), `${kind}: a changed note list`);
      assert.equal(cleanupMemoCountsForTests().suggestions, 4, `${kind}: is walked again`);

      const other = testCatalog(root);
      assert.equal(JSON.stringify(await cleanupSuggestionsFor(store, ignore, other, noted)), JSON.stringify(oracleCleanupSuggestions(store, ignore, other, undefined, noted)), `${kind}: another catalog`);
      assert.equal(cleanupMemoCountsForTests().suggestions, 5, `${kind}: is walked again`);
    } finally {
      setCleanupMemoOptionsForTests(null);
    }
  }
});

test('a stale-files threshold crossed between two requests gives the fresh answer; until then the memo answers', async () => {
  resetCleanupMemoForTests();
  let clock = T;
  setCleanupMemoOptionsForTests({ yieldTurn: immediate, now: () => clock });
  try {
    const root = absRoot('stale');
    const catalog = testCatalog(root);
    const dl = path.join(root, 'Downloads');
    // 30.5 days and 2 seconds from crossing the small-file rule; the 90-day rule needs far longer.
    const young = T - 30.5 * DAY + 2_000;
    const tree = dirAt(path.dirname(root), 'stale', [dirAt(root, 'Downloads', [fileAt(dl, 'setup.dmg', 5_000, young), fileAt(dl, 'old.iso', 5_000, T - 400 * DAY)])]);
    for (const [kind, make] of STORES) {
      resetCleanupMemoForTests();
      clock = T;
      const store = make(tree);
      const at = async (t: number): Promise<string> => { clock = t; return JSON.stringify(await cleanupSuggestionsFor(store, [], catalog, [])); };
      assert.equal(await at(T), JSON.stringify(oracleCleanupSuggestions(store, [], catalog, undefined, [], T)), `${kind}: the first answer`);
      assert.equal(await at(T + 1_000), JSON.stringify(oracleCleanupSuggestions(store, [], catalog, undefined, [], T + 1_000)), `${kind}: a second before the threshold`);
      assert.equal(cleanupMemoCountsForTests().suggestions, 1, `${kind}: is the memo's answer, with no second walk`);
      const crossed = await at(T + 2_001);
      assert.equal(crossed, JSON.stringify(oracleCleanupSuggestions(store, [], catalog, undefined, [], T + 2_001)), `${kind}: past the threshold the answer is the fresh one`);
      assert.ok(crossed.includes('setup.dmg'), `${kind}: which now offers the file that crossed`);
      assert.equal(cleanupMemoCountsForTests().suggestions, 2, `${kind}: from a second walk`);
      assert.equal(await at(T - 5_000), JSON.stringify(oracleCleanupSuggestions(store, [], catalog, undefined, [], T - 5_000)), `${kind}: a clock set back is answered fresh too`);
      assert.equal(cleanupMemoCountsForTests().suggestions, 3, `${kind}: by a third walk`);
    }
  } finally {
    setCleanupMemoOptionsForTests(null);
  }
});

test('a request that joins a walk begun before a threshold it is already past gets the fresh answer', async () => {
  let clock = T;
  setCleanupMemoOptionsForTests({ yieldTurn: immediate, sliceNodes: 1, now: () => clock });
  try {
    const root = absRoot('joined');
    const catalog = testCatalog(root);
    const dl = path.join(root, 'Downloads');
    const tree = dirAt(path.dirname(root), 'joined', [dirAt(root, 'Downloads', [fileAt(dl, 'setup.dmg', 5_000, T - 30.5 * DAY + 2_000), fileAt(dl, 'old.iso', 5_000, T - 400 * DAY)])]);
    for (const [kind, make] of STORES) {
      resetCleanupMemoForTests();
      clock = T;
      const store = make(tree);
      const early = cleanupSuggestionsFor(store, [], catalog, []); // its walk reads T, then hands back a turn
      clock = T + 2_001; // past setup.dmg's threshold, while that walk is still running
      const late = [0, 1, 2, 3].map(() => cleanupSuggestionsFor(store, [], catalog, []));
      assert.equal(JSON.stringify(await early), JSON.stringify(oracleCleanupSuggestions(store, [], catalog, undefined, [], T)), `${kind}: the first request gets the answer at its own clock`);
      const want = JSON.stringify(oracleCleanupSuggestions(store, [], catalog, undefined, [], T + 2_001));
      for (const answer of await Promise.all(late)) {
        assert.equal(JSON.stringify(answer), want, `${kind}: each later one, the answer at its clock`);
      }
      assert.ok(want.includes('setup.dmg'), `${kind}: which offers the file that crossed`);
      // Review of U-16, finding 1: the four that turned the first walk's answer
      // down share one fresh walk rather than starting four.
      assert.equal(cleanupMemoCountsForTests().suggestions, 2, `${kind}: from one more walk between them`);
    }
  } finally {
    setCleanupMemoOptionsForTests(null);
  }
});

test('a look at the git repos does not cost the next suggestions request a walk', async () => {
  // Review of U-16, finding 2: GET /api/git/repos marks each repo root, and a
  // flag set again bumped store.version even though nothing changed — every
  // Clean Up pane open then threw the memo's answer away.
  resetCleanupMemoForTests();
  setCleanupMemoOptionsForTests({ yieldTurn: immediate });
  try {
    const root = absRoot('repos');
    const repo = (name: string, flagged: boolean): FileNode => {
      const at = path.join(root, name);
      return { ...dirAt(root, name, [dirAt(at, '.git', [fileAt(path.join(at, '.git'), 'HEAD', 23, 0)]), dirAt(at, 'node_modules', [fileAt(path.join(at, 'node_modules'), 'i.js', 40, 0)])]), ...(flagged ? { gitRepo: true } : {}) };
    };
    const tree = dirAt(path.dirname(root), 'repos', [repo('marked', true), repo('unmarked', false)]);
    const store = buildStoreFromTree(tree);
    const catalog = loadRuleCatalog();
    await cleanupSuggestionsFor(store, [], catalog, []);
    findGitRepos(store); // marks `unmarked`, the one repo the scan had not marked: a real change
    const before = store.version;
    await cleanupSuggestionsFor(store, [], catalog, []);
    assert.equal(cleanupMemoCountsForTests().suggestions, 2, 'the real change is walked again');
    findGitRepos(store); // both already marked: nothing changes
    assert.equal(store.version, before, 'a second look at the repos leaves the version alone');
    assert.equal(JSON.stringify(await cleanupSuggestionsFor(store, [], catalog, [])), JSON.stringify(oracleCleanupSuggestions(store, [], catalog)), 'and the next request is answered');
    assert.equal(cleanupMemoCountsForTests().suggestions, 2, 'from the memo, with no third walk');
  } finally {
    setCleanupMemoOptionsForTests(null);
  }
});

test('a walk that fails is not remembered', async () => {
  resetCleanupMemoForTests();
  setCleanupMemoOptionsForTests({ yieldTurn: immediate });
  try {
    const store = ObjectScanStore.wrap(projectsTree(absRoot('failing')));
    const childIds = store.childIds.bind(store);
    let fail = true;
    store.childIds = (id: number): number[] => {
      if (fail) { fail = false; throw new Error('the disk went away'); }
      return childIds(id);
    };
    await assert.rejects(cleanupSuggestionsFor(store, [], loadRuleCatalog(), []), /the disk went away/, 'the failure reaches the caller');
    assert.equal(JSON.stringify(await cleanupSuggestionsFor(store, [], loadRuleCatalog(), [])), JSON.stringify(oracleCleanupSuggestions(store, [], loadRuleCatalog())), 'the next request walks again and answers');
    assert.equal(cleanupMemoCountsForTests().suggestions, 2, 'two walks: the failed one was not kept');
  } finally {
    setCleanupMemoOptionsForTests(null);
  }
});

test('the rule claims are every non-advisory match in walk order, uncapped, and walked once', async () => {
  resetCleanupMemoForTests();
  setCleanupMemoOptionsForTests({ yieldTurn: immediate, sliceNodes: 50 });
  try {
    // 250 node_modules: past the 200 items a group lists, so a capped list would lose 50 claims.
    const root = absRoot('claims');
    const kids: FileNode[] = [];
    for (let p = 0; p < 250; p++) {
      const at = path.join(root, `p${p}`);
      kids.push(dirAt(root, `p${p}`, [dirAt(at, 'node_modules', [fileAt(path.join(at, 'node_modules'), 'i.js', 1 + p, 0)]), fileAt(at, '.DS_Store', 6, 0)]));
    }
    const tree: FileNode = { name: 'claims', path: root, type: 'dir', modifiedAt: 0, isHidden: false, size: kids.reduce((s, c) => s + c.size, 0), children: kids };
    const catalog = testCatalog(root);
    // The test catalog's advisory .venv rule fires beside requirements.txt; it must not be a claim.
    const venvAt = path.join(root, 'p7');
    (kids[7].children as FileNode[]).push(dirAt(venvAt, '.venv', [fileAt(path.join(venvAt, '.venv'), 'python', 9, 0)]), fileAt(venvAt, 'requirements.txt', 1, 0));
    const store = buildStoreFromTree(tree);
    const want = recorder();
    oracleCleanupSuggestions(store, [], catalog, want.observe, [], T);
    const nonAdvisory = want.seen.filter((line) => !line.startsWith('p-venv\t'));
    assert.equal(want.seen.length - nonAdvisory.length, 1, 'the fixture holds one advisory match');

    const [a, b] = await Promise.all([cleanupClaimsFor(store, [], catalog), cleanupClaimsFor(store, [], catalog)]);
    assert.deepEqual(a.map((c) => `${c.rule.id}\t${c.path}`), nonAdvisory, 'every claim but the advisory one, in the old walk\'s order');
    assert.equal(a.filter((c) => c.rule.id === 'p-node').length, 250, 'all 250, not the 200 a group lists');
    assert.deepEqual(b, a, 'both requests have the same claims');
    assert.equal(cleanupMemoCountsForTests().claims, 1, 'from one walk');
    a.length = 0; // a caller that edits its list edits nobody else's
    const c = await cleanupClaimsFor(store, [], catalog);
    assert.deepEqual(c.map((claim) => `${claim.rule.id}\t${claim.path}`), nonAdvisory, 'a later request still has every claim');
    assert.equal(cleanupMemoCountsForTests().claims, 1, 'and is answered from the memo');
    assert.equal(cleanupMemoCountsForTests().suggestions, 0, 'the claims are memoised apart from the suggestions');
  } finally {
    setCleanupMemoOptionsForTests(null);
  }
});

test('the Reclaim Score\'s rule claims come from the memo, walked once for the same store', async () => {
  resetCleanupMemoForTests();
  const store = buildStoreFromTree(projectsTree(absRoot('reclaim')));
  const first = await computeRuleClaims(store);
  const second = await computeRuleClaims(store);
  assert.equal(cleanupMemoCountsForTests().claims, 1, 'two score batches, one walk');
  assert.ok(first.available && second.available, 'the shipped catalog loads');
  const want = recorder();
  oracleCleanupSuggestions(store, [], loadRuleCatalog(), want.observe, []);
  assert.deepEqual([...first.byPath.keys()], want.seen.map((line) => line.split('\t')[1]), 'every claimed path, in the old walk\'s order');
  assert.deepEqual([...second.byPath.entries()], [...first.byPath.entries()], 'the same claims both times');
});

/* ───────────────────────────── every surface, one walk ───────────────────────────── */

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function get(port: number, url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { buf += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) as Record<string, unknown> : {} }));
    }).on('error', reject);
  });
}

test('the suggestions route, the agent summary and the MCP tool share one walk per scan version', async () => {
  resetCleanupMemoForTests();
  const root = fileTempDir('treemap-cleanupSlices-root-');
  const store = buildStoreFromTree(projectsTree(root));
  const scan = createScanRecord(root);
  scan.store = store;
  scan.status = 'complete';
  scan.fileCount = 24;
  scan.dirCount = 16;
  const want = JSON.stringify(oracleCleanupSuggestions(store, [], loadRuleCatalog()));

  const mcp = buildMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'treemap-cleanupSlices', version: '0.0.0' });
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  const { port, close } = await listen();
  try {
    const one = await get(port, `/api/cleanup/suggestions?scanId=${scan.scanId}`);
    const two = await get(port, `/api/cleanup/suggestions?scanId=${scan.scanId}`);
    const summary = await get(port, `/api/agent/summary?scanId=${scan.scanId}`);
    const tool = (await client.callTool({ name: 'cleanup_suggestions', arguments: { scanId: scan.scanId } })) as { structuredContent?: { totalBytes?: number } };
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(JSON.stringify(one.body.groups), want, 'the route answers what the old walk answered');
    assert.equal(JSON.stringify(two.body.groups), want, 'twice');
    assert.equal(summary.status, 200, JSON.stringify(summary.body));
    const reclaimable = (JSON.parse(want) as CleanupSuggestionGroup[]).reduce((sum, g) => sum + g.totalSize, 0);
    assert.equal((summary.body.cleanup as { reclaimableBytes: number }).reclaimableBytes, reclaimable, 'the summary sums the same groups');
    assert.equal(tool.structuredContent?.totalBytes, reclaimable, 'the MCP tool sums the same groups');
    assert.equal(cleanupMemoCountsForTests().suggestions, 1, 'four answers over three surfaces, one walk');
    assert.equal(cleanupMemoCountsForTests().reused, 3, 'and the other three answers came from the memo, so no surface walked on its own');

    growFirstClaim(store, 1);
    const three = await get(port, `/api/cleanup/suggestions?scanId=${scan.scanId}`);
    assert.equal(JSON.stringify(three.body.groups), JSON.stringify(oracleCleanupSuggestions(store, [], loadRuleCatalog())), 'a watcher\'s change is in the next answer');
    assert.equal(cleanupMemoCountsForTests().suggestions, 2, 'from one more walk');
  } finally {
    await close();
    await client.close();
  }
});

test('an Autopilot run matches its suggestion rule through the sliced walk', async () => {
  const dir = sanitizePath(fileTempDir('treemap-cleanupSlices-autopilot-'));
  fs.mkdirSync(path.join(dir, 'app', 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'app', 'package.json'), '{}\n');
  const policy: AutopilotPolicy = {
    id: 'u16', name: 'U-16', path: dir, match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
    maxBytesPerRun: null, maxBytesPerWeek: null, cooldownDays: 7, dryRunFirst: false, requireConfirmationAbove: null, enabled: true,
  };
  resetCleanupMemoForTests();
  const preview = await simulatePolicy(policy);
  assert.deepEqual(preview.items.map((i) => i.path), [path.join(dir, 'app', 'node_modules')], 'the node_modules folder is selected');
  assert.equal(cleanupMemoCountsForTests().suggestions, 1, 'by one walk through the memo');
});

/* ───────────────────────────── the page ───────────────────────────── */

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** `async function name(…) { … }` exactly, out of the built page (its parameter list skipped first). */
function pageFunction(anchor: string): string {
  const start = PAGE.indexOf(anchor);
  assert.notEqual(start, -1, `${anchor} is in the built page`);
  let p = PAGE.indexOf('(', start);
  for (let depth = 0; p < PAGE.length; p++) {
    if (PAGE[p] === '(') depth++;
    else if (PAGE[p] === ')' && --depth === 0) break;
  }
  let depth = 0;
  for (let i = PAGE.indexOf('{', p); i < PAGE.length; i++) {
    if (PAGE[i] === '{') depth++;
    else if (PAGE[i] === '}' && --depth === 0) return PAGE.slice(start, i + 1);
  }
  return assert.fail(`${anchor} never closes`);
}

const turns = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve(); };

test('a finished scan asks for the three dashboard lists first and hands their walk to the cost card', async () => {
  const src = pageFunction('async function finishScan(');
  const element = (): Record<string, unknown> => ({ classList: { remove: () => {}, add: () => {} }, dataset: {}, innerHTML: '', textContent: '' });
  const elements = new Map<string, Record<string, unknown>>();
  const $ = (id: string): Record<string, unknown> => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id) as Record<string, unknown>;
  };
  const noop = (): void => {};
  const run = async (scanId: string | null) => {
    const order: string[] = [];
    let handed: unknown = 'nothing';
    let answerLists: () => void = () => {};
    const listsWalk = new Promise<boolean>((resolve) => { answerLists = () => resolve(true); });
    const state = {
      scanId, treemap: { rootPath: '' }, grid: { path: '', selection: new Set() }, apps: { loadedFor: 'x' },
      view: 'dashboard', live: { wanted: false }, scanStats: null, root: null,
    };
    const deps: Record<string, unknown> = {
      $, state, endScanChrome: noop, indexTree: noop, updateSelectionBar: noop, DUP_PAGE: 100, icon: () => '',
      formatCount: (n: number) => String(n), formatBytes: (n: number) => `${n} B`, escapeHtml: (s: string) => s,
      countUp: noop, FxNum: { rollText: noop }, renderDiskNotes: noop, loadWhatsNew: noop, loadDriveHealth: noop,
      loadCostEstimate: (after: unknown) => { order.push('cost card'); handed = after; },
      showListsPending: noop, emit: (topic: string) => { order.push(`emit ${topic}`); }, TOPIC: { scan: 'scan' },
      switchView: noop, toast: noop, fxScanDonePulse: noop,
      // finishScan's switchView runs inside it; where focus goes is tests/firstRun.test.ts's (review F2.6).
      withFocusKept: (change: () => void) => { change(); },
      loadDashboardLists: () => { order.push('lists asked'); return listsWalk; },
      buildIndexInBackground: noop, renderGrowthProjection: noop, loadBudgets: noop, refreshTimebar: noop,
      enableLive: noop, setTimeout: noop, formatClock: () => '10:31 PM',
    };
    const finishScan = new Function(...Object.keys(deps), `'use strict'; ${src} return finishScan;`)(...Object.values(deps)) as
      (root: unknown, ms: number, stats: unknown) => Promise<void>;
    const done = finishScan({ path: '/Users/x', size: 10 }, 50, { fileCount: 1, dirCount: 1 });
    await turns(3);
    const beforeAnswer = [...order];
    answerLists();
    await done;
    return { order, beforeAnswer, handed, listsWalk };
  };

  const scanned = await run('s1');
  assert.deepEqual(scanned.beforeAnswer, ['lists asked', 'cost card'], 'the lists are asked for first; the card is started (to show it is loading) and nothing waits on it');
  assert.equal(scanned.handed, scanned.listsWalk, 'the cost card is handed the lists\' own walk to wait for');
  assert.deepEqual(scanned.order, ['lists asked', 'cost card', 'emit scan'], 'the views and the tour the scan event wakes come after the lists answer');
  const fromIndex = await run(null);
  assert.deepEqual(fromIndex.order, ['emit scan'], 'the index-first paint starts neither the lists nor the cost card');
});

/** The cost card out of the built page, with `api` recording what it asks for. */
function costCard(populated = false) {
  // With the app's one rule for the scan the tree on screen came from (treeScanId), which it prices.
  const src = `${pageFunction('function treeScanId(')}\n${pageFunction('async function loadCostEstimate(')}`;
  const asked: string[] = [];
  const host = {
    innerHTML: '', veiled: false,
    classList: { add: (c: string) => { if (c === 'fx-chart-loading') host.veiled = true; }, remove: (c: string) => { if (c === 'fx-chart-loading') host.veiled = false; } },
    // A card already showing prices finds its rows, so a reload veils it instead of a skeleton.
    querySelector: (): unknown => (populated ? {} : null),
  };
  const state: { scanId: string | null; cost: unknown } = { scanId: 's1', cost: null };
  const $ = (id: string): unknown => (id === 'costBody' ? host : { value: 'USD' });
  const api = async (url: string): Promise<unknown> => {
    asked.push(url);
    if (url.startsWith('/api/cleanup/suggestions')) return { groups: [{ totalSize: 7 }, { totalSize: 100, advisory: true }] };
    return { providers: [], asOf: '2026-09-01', symbol: '$', rateFromUsd: 1, approximate: false };
  };
  const load = new Function(
    '$', 'state', 'api', 'skeletonRows', 'costMoney', 'formatBytes', 'escapeHtml', 'fxBarStyle', 'FxNum', 'fxBarsIn',
    `'use strict'; ${src} return loadCostEstimate;`,
  )($, state, api, (_r: number, _h: number, label: string) => `<skeleton>${label}</skeleton>`, () => '$0', (n: number) => `${n} B`,
    (s: string) => s, () => '', { rollHtml: (el: { innerHTML: string }, html: string) => { el.innerHTML = html; } }, () => {},
  ) as (after?: Promise<unknown>) => Promise<void>;
  return { load, asked, host, state };
}

test('the cost card shows it is loading at once, and asks for suggestions only once the lists have answered', async () => {
  const card = costCard();
  let answer: () => void = () => {};
  const lists = new Promise<boolean>((resolve) => { answer = () => resolve(true); });
  const done = card.load(lists);
  await turns(5);
  assert.match(card.host.innerHTML, /Working out what keeping this online would cost/, 'the card says it is loading the moment the scan lands');
  assert.equal(card.asked.length, 0, 'and asks the server nothing while the lists are walked');
  answer();
  await done;
  assert.deepEqual(card.asked.map((u) => u.split('?')[0]), ['/api/cleanup/suggestions', '/api/cost/estimate'], 'then the suggestions, then the prices');
  assert.match(card.asked[1], /freeable=7&/, 'priced with what the suggestions found, advisory groups left out');
  assert.match(card.host.innerHTML, /Prices as of/, 'and painted');

  // A newer scan by the time the lists answer loads its own estimate; this one asks nothing.
  const stale = costCard();
  let answerStale: () => void = () => {};
  const staleLists = new Promise<boolean>((resolve) => { answerStale = () => resolve(true); });
  const staleDone = stale.load(staleLists);
  stale.state.scanId = 's2';
  answerStale();
  await staleDone;
  assert.equal(stale.asked.length, 0, 'a superseded card asks for nothing');
  // Review of U-16, finding 3: it does not stay on its loading state either —
  // if that newer scan is stopped, nothing else would ever settle it.
  assert.match(stale.host.innerHTML, /^<div class="muted">Run a scan to see what this data would cost to keep online\.<\/div>$/, 'it shows the card\'s own empty state');
  // A card that was already showing prices is veiled while it waits, and the veil comes off too.
  const veiled = costCard(true);
  let answerVeiled: () => void = () => {};
  const veiledLists = new Promise<boolean>((resolve) => { answerVeiled = () => resolve(true); });
  const veiledDone = veiled.load(veiledLists);
  assert.equal(veiled.host.veiled, true, 'a card with standing prices is veiled while it waits');
  veiled.state.scanId = 's2';
  answerVeiled();
  await veiledDone;
  assert.equal(veiled.host.veiled, false, 'and a superseded one leaves no loading veil on');
  assert.match(veiled.host.innerHTML, /Run a scan to see what this data would cost/, 'and shows the empty state, not another scan\'s prices');

  // Lists that failed still let the card load; the lists say why on their own cards.
  const failed = costCard();
  await failed.load(Promise.reject(new Error('the list walk failed')));
  assert.equal(failed.asked.length, 2, 'the card loads after a failed list walk too');

  // A currency change hands over nothing to wait for, and asks at once.
  const now = costCard();
  const changed = now.load();
  assert.deepEqual(now.asked.map((u) => u.split('?')[0]), ['/api/cleanup/suggestions'], 'with nothing to wait for, the card asks in the same turn');
  await changed;
});
