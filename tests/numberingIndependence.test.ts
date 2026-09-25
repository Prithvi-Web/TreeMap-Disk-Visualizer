import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-numberingIndependence-data-');
// One engine per scan, as the golden harness runs them: gdu never answers.
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../src/server';
import { buildMcpServer } from '../src/mcp/server';
import { updateSettings } from '../src/services/settings';
import { applyEngineBudgetSetting } from '../src/services/engineBudget';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { nativeScanModule, runNativeWalk, type ScanModule } from '../src/services/scan/nativeEngine';
import { createScanRecord, getScan, peekScan, collectEmptyFolders, collectFileTypes, collectLargestFiles, collectLargestFolders, compareTrees } from '../src/services/diskScanner';
import { cancelAllDuplicateJobs, getDuplicateJob } from '../src/services/duplicateFinder';
import { clearFactCache, computeFacts } from '../src/services/facts';
import { executeAgainstScan, type SortKey } from '../src/services/query/execute';
import { parse } from '../src/services/query/parse';
import { reportRows } from '../src/services/reportExport';
import { buildSnapshotTree } from '../src/services/snapshots';
import { aggregateCalendar } from '../src/services/calendarAggregate';
import { collectCloudPlaceholders, lookupNodesInStore } from '../src/services/scanQueries';
import { Flag, NodeInput, PackedScanStore, type StoreColumns } from '../src/services/scanStore';
import { buildTreemapFromStore } from '../src/utils/treemap';
import type { DuplicateGroup, ScanResult } from '../src/models/types';
import { buildPair, makeRng } from './fixtures/storeFuzz';
import { checkBlockInvariants, renumberStore, type Schedule } from './fixtures/renumber';
import { buildGoldenTree, normalize } from './fixtures/goldenHarness';
import { skipOrFailOnCi } from './fixtures/ciSkip';
import { waitFor } from './fixtures/waitFor';

/**
 * Phase 4 design §S.2, test 4: no output may depend on how the store numbered
 * its nodes. The Phase 4 walk numbers each folder's children as one block,
 * in whatever order the workers list the folders, where today's `finalize()`
 * numbers breadth-first. Every consumer below runs on a finished store and on
 * random block renumberings of it (tests/fixtures/renumber.ts), and each
 * answer must be the same bytes. Folder totals are summed again under each new
 * numbering (§S.2 Lemma 2), so sizes large enough to round are in the trees.
 */

/* ------------------------------ the trees ------------------------------ */

/**
 * Names shared between folders, so equal names sit at different paths, and
 * chosen for the consumers' own rules: junk files, tool-owned and OS-owned
 * folders, media extensions, and names whose order differs between UTF-16
 * code units, UTF-8 bytes and a locale.
 */
const NAME_POOL = [
  'a', 'b', 'B', 'a.ts', 'b.ts', 'Z.log', 'z.log', 'x.PNG', 'résumé.txt', '\u{1F600}.png', '\uFF5E.png',
  'node_modules', '.git', 'Tool.app', '.DS_Store', 'Thumbs.db', '.Trash', 'm.mp4', 'p.jpg', 'q.jpg', 'r.mp3', 'data', 'Data',
];
/** Few sizes, so ties are everywhere; the two above 2^52 make folder totals round. */
const SIZE_POOL = [0, 1, 7, 4096, 4096, 65_536, 1_000_000, 2 ** 52 + 1, 2 ** 52 + 3];
const MTIME_POOL = [1_600_000_000_000, 1_700_000_000_000, 1_700_000_000_000, 1_750_000_000_123];
/** Cloud placeholders are this size or twice it, and nothing else is. */
const PLACEHOLDER_SIZE = 3 * 1024 * 1024 + 5;
/**
 * Where the in-memory trees say they are: a folder that is never created. No
 * file under it exists, so the duplicate pass hashes none of them and forms
 * no group: for these trees, as for the fuzz trees (rooted at made-up paths),
 * the duplicate answer's groups are always empty, so of that answer only the
 * not-hashed report is tested. Groups are tested on the tree whose files are
 * on disk (onDiskTree).
 */
const NOWHERE = path.join(os.tmpdir(), `treemap-numbering-absent-${process.pid}`);

function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

/** A tree full of ties: sizes, times, names and placeholders repeat across folders. */
function tieHeavyStore(seed: number, budget: number): PackedScanStore {
  const rng = makeRng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)];
  const name0 = `tree-${seed}`;
  const store = new PackedScanStore(path.join(NOWHERE, name0), path.sep, { name: name0, isDir: true, size: 0, modifiedAt: MTIME_POOL[1], isHidden: false });
  let left = budget;
  const uniqueName = (taken: Set<string>, base: string): string => {
    let name = base;
    for (let k = 1; taken.has(name); k++) {
      const dot = base.lastIndexOf('.');
      name = dot > 0 ? `${base.slice(0, dot)}-${k}${base.slice(dot)}` : `${base}-${k}`;
    }
    taken.add(name);
    return name;
  };
  const fileInput = (name: string): NodeInput => {
    const input: NodeInput = { name, isDir: false, size: pick(SIZE_POOL), modifiedAt: pick(MTIME_POOL), isHidden: name.startsWith('.'), extension: extensionOf(name) };
    if (rng() < 0.5) input.accessedAt = pick(MTIME_POOL);
    const roll = rng();
    if (roll < 0.2) {
      input.cloudPlaceholder = true;
      input.size = rng() < 0.2 ? 2 * PLACEHOLDER_SIZE : PLACEHOLDER_SIZE;
      if (rng() < 0.5) input.cloudProvider = pick(['icloud', 'onedrive', 'dropbox'] as const);
    } else if (roll < 0.25) {
      input.hardlinkDuplicate = true;
      input.size = 0;
    } else if (roll < 0.3) {
      input.isSymlink = true;
      input.size = 12;
    } else if (roll < 0.33) {
      input.container = 'zip';
    }
    return input;
  };
  const grow = (parent: number, depth: number): void => {
    const taken = new Set<string>();
    const kids = depth === 0 ? 10 : Math.floor(rng() * 9);
    for (let i = 0; i < kids && left > 0; i++) {
      left--;
      const name = uniqueName(taken, pick(NAME_POOL));
      if (depth < 6 && rng() < 0.35) {
        const id = store.addNode(parent, { name, isDir: true, size: 0, modifiedAt: pick(MTIME_POOL), isHidden: name.startsWith('.'), gitRepo: rng() < 0.05 || undefined });
        grow(id, depth + 1);
      } else {
        store.addNode(parent, fileInput(name));
      }
    }
  };
  while (left > 0) grow(store.rootId, 0);
  // One folder with enough media of each kind for the human-scale fact.
  const media = store.addNode(store.rootId, { name: 'media', isDir: true, size: 0, modifiedAt: MTIME_POOL[0], isHidden: false });
  for (let k = 0; k < 12; k++) {
    for (const ext of ['jpg', 'mp4', 'mp3']) {
      store.addNode(media, { name: `m${k}.${ext}`, isDir: false, size: pick(SIZE_POOL.slice(3, 7)), modifiedAt: pick(MTIME_POOL), isHidden: false, extension: ext });
    }
  }
  store.finalize();
  store.sumSizes();
  return store;
}

interface Tree {
  label: string;
  store: PackedScanStore;
  /** The least size the duplicate pass looks at. */
  dupeMinSize: number;
  /** For a tree whose files are on disk: how many groups of copies it holds. */
  dupeGroups?: number;
}

/** Each content of the on-disk tree, and how many bytes one copy of it holds. */
const CONTENT_BYTES: Record<string, number> = { x: 100, y: 100, z: 50, w: 300, u: 100 };

/**
 * The on-disk tree's files, in the order the store adds them (each folder's
 * child order), every one filled with its content's letter. x, y and z each
 * free 100 bytes (two copies of 100, two of 100, three of 50), so their
 * groups tie on `reclaimable`, and all their copies share one mtime, so their
 * members tie too; w's two copies differ in mtime, and u has no copy. No two
 * copies of a content share a folder, so a renumbering can change which copy
 * has the smaller id. u has a folder of its own: with only a to d under the
 * root, the random schedule of seed 1 listed them breadth-first and moved no id.
 */
const ON_DISK_FILES: Array<{ at: string[]; content: string; mtime: number }> = [
  { at: ['a', 'x1.bin'], content: 'x', mtime: MTIME_POOL[1] },
  { at: ['a', 'z1.bin'], content: 'z', mtime: MTIME_POOL[1] },
  { at: ['a', 'w1.bin'], content: 'w', mtime: MTIME_POOL[0] },
  { at: ['b', 'z2.bin'], content: 'z', mtime: MTIME_POOL[1] },
  { at: ['b', 'y1.bin'], content: 'y', mtime: MTIME_POOL[1] },
  { at: ['c', 'x2.bin'], content: 'x', mtime: MTIME_POOL[1] },
  { at: ['d', 'y2.bin'], content: 'y', mtime: MTIME_POOL[1] },
  { at: ['d', 'deep', 'z3.bin'], content: 'z', mtime: MTIME_POOL[1] },
  { at: ['d', 'deep', 'w2.bin'], content: 'w', mtime: MTIME_POOL[3] },
  { at: ['e', 'u.bin'], content: 'u', mtime: MTIME_POOL[1] },
];

/**
 * A tree whose files exist, under a temp folder, so the duplicate pass hashes
 * them and forms groups. findDuplicates sorts groups by `reclaimable` and each
 * group's copies by mtime; both sorts are stable, so ties stay in the order
 * the pass met the files (stage 1 walks the tree with eachFile). The ties in
 * ON_DISK_FILES are where a pass that met files in id order would answer
 * differently for a renumbered store. Each file has the same name, size and
 * mtime on disk and in the store.
 */
function onDiskTree(): Tree {
  const root = fs.realpathSync(fileTempDir('treemap-numbering-dupes-'));
  const store = new PackedScanStore(root, path.sep, { name: path.basename(root), isDir: true, size: 0, modifiedAt: MTIME_POOL[1], isHidden: false });
  const folderIds = new Map<string, number>();
  const copies = new Map<string, number>();
  for (const { at, content, mtime } of ON_DISK_FILES) {
    let parent = store.rootId;
    for (let depth = 1; depth < at.length; depth++) {
      const key = at.slice(0, depth).join('/');
      let folder = folderIds.get(key);
      if (folder === undefined) {
        folder = store.addNode(parent, { name: at[depth - 1], isDir: true, size: 0, modifiedAt: MTIME_POOL[1], isHidden: false });
        folderIds.set(key, folder);
      }
      parent = folder;
    }
    const file = path.join(root, ...at);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(CONTENT_BYTES[content], content));
    fs.utimesSync(file, new Date(mtime), new Date(mtime));
    store.addNode(parent, { name: at[at.length - 1], isDir: false, size: CONTENT_BYTES[content], modifiedAt: mtime, isHidden: false, extension: 'bin' });
    copies.set(content, (copies.get(content) ?? 0) + 1);
  }
  store.finalize();
  store.sumSizes();
  const dupeGroups = [...copies.values()].filter((count) => count > 1).length;
  return { label: 'on disk, with copies that tie', store, dupeMinSize: 1, dupeGroups };
}

function trees(): Tree[] {
  const out: Tree[] = [];
  for (const seed of [11, 12, 13, 14]) {
    out.push({ label: `tie-heavy seed ${seed}`, store: tieHeavyStore(seed, 700), dupeMinSize: PLACEHOLDER_SIZE });
  }
  // The differential fuzz's trees, POSIX and Windows separators, rooted at
  // made-up paths; its cloud roots carry cloudIds, which are not columns
  // (renumberStore refuses them).
  for (let iter = 0; iter < 10; iter++) {
    if (iter % 5 === 3) continue;
    const { packed } = buildPair(7000 + iter, iter, 500);
    out.push({ label: `fuzz seed ${7000 + iter}`, store: packed, dupeMinSize: 1 });
  }
  out.push(onDiskTree());
  return out;
}

/* ------------------------------ the probes ------------------------------ */

/** What the consumers are asked about, read from the source store by path, so every numbering is asked the same. */
interface Probe {
  folders: string[];
  paths: string[];
  missing: string[];
}

function probeOf(store: PackedScanStore): Probe {
  const folders: string[] = [];
  const paths: string[] = [];
  store.eachNode(store.rootId, (id) => {
    const p = store.path(id);
    paths.push(p);
    if (store.isDir(id)) folders.push(p);
  });
  const sep = store.sep;
  const missing = [
    `${store.rootPath}${sep}no-such-entry`,
    `${folders[folders.length - 1]}${sep}absent.bin`,
    `${store.rootPath}x`,
  ];
  return { folders: folders.slice(0, 60), paths: paths.slice(0, 2000), missing };
}

/* ----------------------------- the consumers ----------------------------- */

const QUERIES: Array<{ q: string; sort: SortKey; limit: number; offset: number }> = [
  { q: 'size>0', sort: 'size', limit: 50, offset: 0 },
  { q: 'size>0', sort: 'size', limit: 50, offset: 50 },
  { q: 'type:file', sort: 'name', limit: 1000, offset: 0 },
  { q: 'type:dir empty:yes', sort: 'path', limit: 1000, offset: 0 },
  { q: 'ext:ts,png,log,mp4', sort: 'modified', limit: 1000, offset: 0 },
  { q: 'size>=4096 -type:dir', sort: 'size', limit: 1000, offset: 0 },
  { q: 'depth<=2', sort: 'size', limit: 1000, offset: 0 },
  { q: 'name:a or name:b', sort: 'path', limit: 1000, offset: 0 },
];

/** A copy of `base` with sizes changed, files removed and files added, by path: the other side of a comparison. */
function changedCopy(base: PackedScanStore, seed: number): PackedScanStore {
  const copy = renumberStore(base, seed, { schedule: 'depthFirst' }).store;
  const files: number[] = [];
  const folders: number[] = [];
  copy.eachNode(copy.rootId, (id) => (copy.isDir(id) ? folders : files).push(id));
  files.forEach((id, k) => {
    if (k % 11 === 5) copy.removeNode(id);
    else if (k % 7 === 3) copy.setSize(id, copy.size(id) + 17);
  });
  folders.forEach((id, k) => {
    if (k % 5 === 1) copy.addNode(id, { name: 'zz-added.bin', isDir: false, size: 4096, modifiedAt: MTIME_POOL[2], isHidden: false, extension: 'bin' });
  });
  copy.sumSizes();
  return copy;
}

/** A fresh duplicate job's answer for `scan`: the not-hashed report, the group count and the groups. */
async function duplicatesOf(scan: ScanResult, minSize: number): Promise<unknown> {
  cancelAllDuplicateJobs();
  const job = getDuplicateJob(scan, minSize);
  await waitFor(() => job.status !== 'running', 'the duplicate job finishing');
  assert.equal(job.status, 'complete', job.error);
  return { notHashed: job.notHashed, groupCount: job.groupCount, groups: job.groups };
}

/**
 * Every answer the app gives from a finished store, as JSON, by name. `scan`
 * is a registered scan record: the query, facts and duplicate passes find
 * their store through it.
 */
async function outputsOf(store: PackedScanStore, probe: Probe, scan: ScanResult, other: PackedScanStore, dupeMinSize: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const put = (key: string, value: unknown): void => {
    out.set(key, JSON.stringify(value));
  };
  scan.store = store;
  clearFactCache(scan.scanId);

  const walked: string[] = [];
  store.eachNode(store.rootId, (id) => walked.push(store.path(id)));
  put('eachNode', walked);
  const files: string[] = [];
  store.eachFile(store.rootId, (id) => files.push(store.path(id)));
  put('eachFile', files);

  for (const maxNodes of [1, 2, 7, 50, 250, 250_000]) put(`prune @${maxNodes}`, store.prune(store.rootId, { maxNodes }));
  for (const maxNodes of [1, 10, 20_000]) {
    put(`subtree @${maxNodes}`, probe.folders.map((p) => store.prune(store.findByPath(p), { maxNodes })));
  }
  put('nodes', lookupNodesInStore(store, [...probe.paths.slice(0, 500), ...probe.missing]));

  put('treemap depth 4', buildTreemapFromStore(store, store.rootId, { maxDepth: 4, minSize: 1, maxNodes: 20_000 }));
  put('treemap depth 8 of 60', buildTreemapFromStore(store, store.rootId, { maxDepth: 8, minSize: 0, maxNodes: 60 }));
  put('treemap of folders', probe.folders.map((p) => buildTreemapFromStore(store, store.findByPath(p), { maxDepth: 3, minSize: 1, maxNodes: 20_000 })));

  for (const limit of [1, 2, 5, 20, 1000]) {
    for (const minSize of [0, 1, 4096]) {
      put(`largest files ${limit} >=${minSize}`, collectLargestFiles(store, limit, minSize));
      put(`largest folders ${limit} >=${minSize}`, collectLargestFolders(store, limit, minSize));
    }
  }
  put('file types', collectFileTypes(store));
  put('empty folders, junk ignored', collectEmptyFolders(store, true));
  put('empty folders', collectEmptyFolders(store, false));
  put('cloud placeholders', collectCloudPlaceholders(store, 5));
  put('compare to another', compareTrees(store, other));
  put('compare from another', compareTrees(other, store));
  put('export files', [...reportRows(store, 'files')]);
  put('export folders', [...reportRows(store, 'folders')]);
  put('calendar', aggregateCalendar(store));
  put('snapshot tree', buildSnapshotTree(store));

  for (const { q, sort, limit, offset } of QUERIES) {
    const parsed = parse(q);
    assert.ok(parsed.ok, `the query ${q} parses`);
    put(`query ${q} by ${sort} ${offset}+${limit}`, await executeAgainstScan(scan.scanId, parsed.ast, { limit, offset, sort, signal: new AbortController().signal }));
  }
  put('facts', await computeFacts(scan.scanId, [...probe.paths, ...probe.missing], ['size', 'subtreeCount', 'humanScale'], new AbortController().signal));
  put('duplicates', await duplicatesOf(scan, dupeMinSize));
  return out;
}

/** Where two strings first differ, with some of each around it. */
function whereTheyDiffer(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 80);
  return `at character ${i}:\n  source:     …${a.slice(from, i + 120)}\n  renumbered: …${b.slice(from, i + 120)}`;
}

function assertSameOutputs(want: Map<string, string>, got: Map<string, string>, what: string): void {
  assert.deepEqual([...got.keys()], [...want.keys()], `${what}: the same answers were asked for`);
  for (const [key, bytes] of want) {
    const mine = got.get(key) as string;
    if (mine !== bytes) assert.fail(`${what}: "${key}" differs ${whereTheyDiffer(bytes, mine)}`);
  }
}

/* ------------------------------ the fixture ------------------------------ */

test('renumberStore numbers each folder\'s children as one block, and moves ids unless the schedule is breadth-first', () => {
  const source = tieHeavyStore(21, 600);
  const bfs = renumberStore(source, 1, { schedule: 'breadthFirst' });
  assert.equal(bfs.moved, 0, 'the first-in-first schedule is the numbering finalize() gave');
  for (const schedule of ['random', 'depthFirst'] as Schedule[]) {
    const r = renumberStore(source, 2, { schedule });
    checkBlockInvariants(r.columns);
    assert.equal(r.store.count, source.count);
    assert.ok(r.moved > source.count / 4, `${schedule}: ${r.moved} of ${source.count} ids moved`);
    // Every node keeps its place in the tree and its child order.
    for (let old = 0; old < source.count; old++) {
      const id = r.newIdOf[old];
      assert.equal(r.store.path(id), source.path(old));
      assert.deepEqual(r.store.childIds(id), source.childIds(old).map((kid) => r.newIdOf[kid]), `children of ${source.path(old)}`);
    }
  }
  const [one, again, other] = [renumberStore(source, 5), renumberStore(source, 5), renumberStore(source, 6)];
  assert.deepEqual(one.newIdOf, again.newIdOf, 'a seed gives one numbering');
  assert.notDeepEqual(one.newIdOf, other.newIdOf, 'and another seed another');
  // The dictionary is shuffled: some extension has a different id, the same text.
  const extIds = (cols: typeof one.columns): string => cols.extDict.join('\u0000');
  assert.notEqual(extIds(one.columns), extIds(other.columns));
});

test('checkBlockInvariants names the invariant a column breaks', () => {
  const source = tieHeavyStore(22, 200);
  // Drops the root's last child from the root's block and answers its id. No
  // block holds that row any more, so of the structural checks only the ones
  // of its own parent entry look at it.
  const outOfTheRootsBlock = (c: StoreColumns): number => {
    const last = c.childStart[0] + c.childCnt[0] - 1;
    c.childCnt[0]--;
    return last;
  };
  /** A row numbered before `row` whose block starts after `row`. */
  const beforeWithBlockAfter = (c: StoreColumns, row: number): number => {
    for (let id = 1; id < row; id++) if (c.childStart[id] > row) return id;
    throw new Error(`no row before ${row} has its block after it`);
  };
  /** The folder whose block ends at the last row. */
  const lastBlockOwner = (c: StoreColumns): number => {
    for (let id = 0; id < c.n; id++) if (c.childCnt[id] > 0 && c.childStart[id] + c.childCnt[id] === c.n) return id;
    throw new Error('no block ends at the last row');
  };
  // One spoil for each check, in the checker's order, each pattern anchored at
  // the start of its own message. Where messages share a label (I1, I2, I4)
  // the pattern goes on to the words that tell them apart; the checker also
  // reports "I2/I3: …", which a bare /I3/ would match.
  const spoil: Array<[string, (c: StoreColumns) => void, RegExp]> = [
    // No rows and no name bytes, so the names still end where namesLen says.
    ['no rows at all', (c) => { c.n = 0; c.namesLen = 0; }, /^I1: no rows$/],
    ['the root with a parent', (c) => { c.parent[0] = 0; }, /^I1: the root's parent is /],
    // The root's name ('tree-22') is longer than one byte, so the next name
    // still starts after the first.
    ['the first name starting one byte in', (c) => { c.nameOff[0] = 1; }, /^I4: the first name starts at /],
    ['names that end before namesLen', (c) => { c.namesLen += 1; }, /^I4: the names end at /],
    ['names out of id order', (c) => { c.nameOff[1] = c.nameOff[2] + 1; }, /^I4: nameOff falls /],
    // The membership check would reject this block too (the root is not its
    // own child), but the range check runs first, so only the label says
    // which check caught it.
    ['a block that starts at its owner', (c) => { c.childStart[0] = 0; }, /^I2\/I3: node \d+'s children /],
    // The last block one row long, into the columns' spare capacity. The
    // spare row names the block's owner as its parent, so the block-membership
    // check accepts it: only the range check ("inside the n rows") rejects it.
    ['a block that runs past the last row', (c) => {
      assert.ok(c.capacity > c.n, 'the columns have a spare row for the block to run into');
      const owner = lastBlockOwner(c);
      c.childCnt[owner]++;
      c.parent[c.n] = owner;
    }, /^I2\/I3: node \d+'s children /],
    ['a block that holds a stranger', (c) => { const f = c.childStart[0]; c.parent[f] = c.n - 1; }, /^I2: node \d+ lies in node \d+'s block /],
    // A parent of -1 has no block (childStart[-1] is undefined, so both I2
    // comparisons are false): only the I3 check rejects it.
    ['a row in no block, whose parent is -1', (c) => { c.parent[outOfTheRootsBlock(c)] = -1; }, /^I3: /],
    ['a child numbered before its parent', (c) => { c.parent[outOfTheRootsBlock(c)] = c.n - 1; }, /^I3: /],
    // The dropped row names as its parent a row numbered before it, so the
    // I3 check passes it, but that row's block starts after it.
    ['a row before its parent\'s block', (c) => { const row = outOfTheRootsBlock(c); c.parent[row] = beforeWithBlockAfter(c, row); }, /^I2: node \d+ lies outside its parent /],
    // The root's block one row short: the row it drops still names the root,
    // numbered before it, as its parent, so the I3 check passes it.
    ['a row its parent\'s block does not hold', (c) => { outOfTheRootsBlock(c); }, /^I2: node \d+ lies outside its parent /],
  ];
  for (const [what, harm, message] of spoil) {
    const { columns } = renumberStore(source, 3);
    harm(columns);
    // Matched against the message: a bare pattern is matched against
    // String(error), which starts "Error: ".
    assert.throws(() => checkBlockInvariants(columns), { message }, what);
  }
});

test('renumberStore refuses what adoptColumns would lose: a tombstone, a cloudId, a logicalSize', () => {
  const removed = tieHeavyStore(23, 100);
  removed.removeNode(removed.childIds(removed.rootId)[0]);
  assert.throws(() => renumberStore(removed, 1), /tombstoned or detached/);
  const { packed: cloud } = buildPair(7003, 3, 60);
  assert.throws(() => renumberStore(cloud, 1), /cloudId or logicalSize/);
  // A container's listing, grafted through ingestSubtree as container
  // expansion grafts one: its entry is virtual and carries its uncompressed
  // size. Nothing in this store has a cloudId, and the error names the node.
  const listed = new PackedScanStore(path.join(NOWHERE, 'listed'), path.sep, { name: 'listed', isDir: true, size: 0, modifiedAt: MTIME_POOL[1], isHidden: false });
  listed.addNode(listed.rootId, { name: 'box.zip', isDir: false, size: 4096, modifiedAt: MTIME_POOL[1], isHidden: false, extension: 'zip', container: 'zip' });
  listed.finalize();
  const box = listed.childIds(listed.rootId)[0];
  listed.ingestSubtree(box, [{
    name: 'inner.txt', path: `${listed.path(box)}${listed.sep}inner.txt`, size: 90, type: 'file',
    modifiedAt: MTIME_POOL[1], isHidden: false, extension: 'txt', virtual: true, logicalSize: 400,
  }]);
  assert.throws(() => renumberStore(listed, 1), /inner\.txt\) carries a cloudId or logicalSize/);
});

/* ------------------------------ the battery ------------------------------ */

test('every answer is the same bytes after the store is renumbered in blocks', async () => {
  let compared = 0;
  let tiesAtTheListEdge = 0;
  for (const tree of trees()) {
    const { store: source, label } = tree;
    const probe = probeOf(source);
    const scan = createScanRecord(source.rootPath);
    scan.status = 'complete';
    const other = changedCopy(source, 99);
    const want = await outputsOf(source, probe, scan, other, tree.dupeMinSize);
    if (tree.dupeGroups !== undefined) {
      // The groups are compared with every other answer below, and their
      // order only tests the numbering where two groups, or two copies, tie.
      const { groupCount, groups } = JSON.parse(want.get('duplicates') as string) as { groupCount: number; groups: DuplicateGroup[] };
      assert.equal(groupCount, tree.dupeGroups, `${label}: every group of copies formed`);
      assert.ok(new Set(groups.map((g) => g.reclaimable)).size < groups.length, `${label}: two groups free the same bytes`);
      assert.ok(groups.some((g) => new Set(g.files.map((f) => f.modifiedAt)).size < g.files.length), `${label}: two copies in one group share an mtime`);
    }
    for (const [seed, schedule] of [[1, 'random'], [2, 'random'], [3, 'depthFirst']] as Array<[number, Schedule]>) {
      const r = renumberStore(source, seed, { schedule, folderTotals: 'zeroed' });
      r.store.sumSizes();
      assert.ok(r.moved > 0, `${label}: the ${schedule} schedule moved ids`);
      assertSameOutputs(want, await outputsOf(r.store, probe, scan, other, tree.dupeMinSize), `${label}, ${schedule} seed ${seed}`);
      compared++;
    }
    // The not-hashed list names twenty; a tie between the twentieth and the
    // twenty-first biggest placeholder is where a numbering could decide.
    const placeholderSizes: number[] = [];
    source.eachFile(source.rootId, (id) => {
      if (source.flag(id, Flag.CloudPlaceholder) && source.size(id) >= tree.dupeMinSize) placeholderSizes.push(source.size(id));
    });
    placeholderSizes.sort((a, b) => b - a);
    if (placeholderSizes.length > 20 && placeholderSizes[19] === placeholderSizes[20]) tiesAtTheListEdge++;
  }
  assert.equal(compared, 3 * 13);
  assert.ok(tiesAtTheListEdge >= 4, `${tiesAtTheListEdge} trees tie at the twentieth not-hashed name; every tie-heavy one should`);
});

test('in the tie-heavy trees some folder totals depend on the order their children are added in', () => {
  // So summing again under a new numbering (§S.2 Lemma 2) is a check with
  // teeth: an order that differed would show in the totals.
  for (const seed of [11, 12, 13, 14]) {
    const store = tieHeavyStore(seed, 700);
    let orderShows = 0;
    store.eachNode(store.rootId, (id) => {
      if (!store.isDir(id)) return;
      const sizes = store.childIds(id).map((kid) => store.size(kid));
      const forward = sizes.reduce((sum, size) => sum + size, 0);
      const backward = [...sizes].reverse().reduce((sum, size) => sum + size, 0);
      if (forward !== backward) orderShows++;
    });
    assert.ok(orderShows > 0, `seed ${seed}: ${orderShows} folders whose total depends on the order of the sum`);
  }
});

/* ------------------------- the scans of real trees ------------------------- */

interface Reply { status: number; body: unknown }

/** One API request. The rate limiter is emptied first: these legs ask hundreds of questions, and a 429 is no answer about numbering. */
function request(port: number, method: string, url: string, body?: unknown): Promise<Reply> {
  resetRateLimiter();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => {
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* CSV and other text stay text */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** The body of a 200 answer: an error body would compare equal to itself and prove nothing. */
async function answer(port: number, method: string, url: string, body?: unknown): Promise<unknown> {
  const reply = await request(port, method, url, body);
  assert.equal(reply.status, 200, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 300)}`);
  return reply.body;
}

/** The progress stream's last frame; a finished scan sends it at once. */
function finalSseFrame(port: number, scanId: string): Promise<unknown> {
  resetRateLimiter();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/api/scan/${scanId}/progress` }, (res) => {
      let text = '';
      let last: unknown = null;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
        let end: number;
        while ((end = text.indexOf('\n\n')) !== -1) {
          for (const line of text.slice(0, end).split('\n')) {
            if (line.startsWith('data: ')) last = JSON.parse(line.slice(6));
          }
          text = text.slice(end + 2);
        }
      });
      res.on('end', () => resolve(last));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** An app server on a free port, for as long as `use` runs. */
async function withServer<T>(use: (port: number) => Promise<T>): Promise<T> {
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await use((server.address() as { port: number }).port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Scans `root` through the API with `engine` and waits for the result; answers the scan record. */
async function scanThroughApi(port: number, root: string, engine: 'walker' | 'native'): Promise<ScanResult> {
  await updateSettings({
    engine,
    // The golden harness's budgets, so the budgets answer has rows.
    budgets: [
      { path: path.join(root, 'docs'), maxBytes: 10_000 },
      { path: path.join(root, 'media'), maxBytes: 999_999_999 },
    ],
  });
  const started = await request(port, 'POST', '/api/scan', { path: root });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const scanId = (started.body as { scanId: string }).scanId;
  await waitFor(() => peekScan(scanId)?.status !== 'running', `the ${engine} scan of ${root} finishing`);
  const scan = getScan(scanId);
  assert.ok(scan, 'the scan is registered');
  assert.equal(scan.status, 'complete', scan.error);
  // The walker reports itself as 'walker' or 'turbo-walker' (nativeEquivalence.test.ts's WALKER_ENGINES).
  const ran = engine === 'walker' ? ['walker', 'turbo-walker'] : ['native'];
  assert.ok(ran.includes(String(scan.engine)), `the scan ran on ${scan.engine}, not the ${engine} engine: ${scan.engineReason} ${scan.fallbackReason ?? ''}`);
  return scan;
}

/**
 * The golden lock's answers (tests/fixtures/goldenHarness.ts, captureGolden),
 * asked the same way of any scan of the golden tree: the keys and the
 * requests are the harness's own, and on macOS the walker's answers are
 * checked against the recorded file, so this copy cannot drift from it.
 */
async function goldenAnswers(port: number, scanId: string, treeRoot: string): Promise<Record<string, unknown>> {
  const enc = encodeURIComponent;
  return {
    result: await answer(port, 'GET', `/api/scan/${scanId}/result`),
    sseComplete: await finalSseFrame(port, scanId),
    subtreeCode: await answer(port, 'GET', `/api/scan/${scanId}/subtree?path=${enc(path.join(treeRoot, 'code'))}`),
    subtreePruned: await answer(port, 'GET', `/api/scan/${scanId}/subtree?path=${enc(treeRoot)}&maxNodes=25`),
    subtreeSingle: await answer(port, 'GET', `/api/scan/${scanId}/subtree?path=${enc(treeRoot)}&maxNodes=1`),
    treemap: await answer(port, 'GET', `/api/scan/${scanId}/treemap?minSize=1&maxDepth=4`),
    treemapMedia: await answer(port, 'GET', `/api/scan/${scanId}/treemap?minSize=1&maxDepth=3&root=${enc(path.join(treeRoot, 'media'))}`),
    largeFiles: await answer(port, 'GET', `/api/large-files?scanId=${scanId}&limit=10&minSize=1`),
    fileTypes: await answer(port, 'GET', `/api/file-types?scanId=${scanId}`),
    nodes: await answer(port, 'POST', `/api/scan/${scanId}/nodes`, {
      paths: [
        path.join(treeRoot, 'docs'),
        path.join(treeRoot, 'media', 'pics'),
        path.join(treeRoot, 'empty'),
        path.join(treeRoot, 'hard-b.bin'),
        path.join(treeRoot, 'definitely-missing.bin'),
      ],
    }),
    budgets: await answer(port, 'GET', `/api/scan/${scanId}/budgets`),
  };
}

/** More answers the API and the MCP tools read from a scan's tree, beyond the golden lock's. */
async function moreAnswers(port: number, mcp: Client, scan: ScanResult, treeRoot: string): Promise<Record<string, unknown>> {
  const id = scan.scanId;
  const store = scan.store as PackedScanStore;
  const every: string[] = [];
  store.eachNode(store.rootId, (n) => every.push(store.path(n)));
  let duplicates: Reply = { status: 0, body: null };
  await waitFor(async () => {
    duplicates = await request(port, 'GET', `/api/duplicates?scanId=${id}&minSize=1`);
    return duplicates.status !== 202;
  }, 'the duplicate pass finishing');
  assert.equal(duplicates.status, 200, JSON.stringify(duplicates.body));
  const tool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const reply = await mcp.callTool({ name, arguments: args });
    assert.ok(!reply.isError && reply.structuredContent, `${name}: ${JSON.stringify(reply.content).slice(0, 300)}`);
    return reply.structuredContent;
  };
  const answers: Record<string, unknown> = {
    largeFilesAll: await answer(port, 'GET', `/api/large-files?scanId=${id}&limit=1000&minSize=0`),
    largeFolders: await answer(port, 'GET', `/api/large-folders?scanId=${id}&limit=500&minSize=0`),
    emptyFolders: await answer(port, 'GET', `/api/empty-folders?scanId=${id}`),
    emptyFoldersWithJunk: await answer(port, 'GET', `/api/empty-folders?scanId=${id}&ignoreJunk=false`),
    treemapAll: await answer(port, 'GET', `/api/scan/${id}/treemap?minSize=0&maxDepth=8`),
    calendar: await answer(port, 'GET', `/api/scan/${id}/calendar`),
    exportFiles: await answer(port, 'GET', `/api/scan/${id}/export?format=csv&mode=files`),
    exportFolders: await answer(port, 'GET', `/api/scan/${id}/export?format=csv&mode=folders`),
    gitRepos: await answer(port, 'GET', `/api/git/repos?scanId=${id}`),
    suggestions: await answer(port, 'GET', `/api/cleanup/suggestions?scanId=${id}`),
    facts: await answer(port, 'POST', '/api/facts', { scanId: id, paths: every, providers: ['size', 'subtreeCount', 'humanScale'] }),
    duplicates: duplicates.body,
    mcpLargestFiles: await tool('get_largest', { scanId: id, kind: 'files', limit: 500, minSizeBytes: 0 }),
    mcpLargestFolders: await tool('get_largest', { scanId: id, kind: 'folders', limit: 500, minSizeBytes: 0 }),
    mcpSuggestions: await tool('cleanup_suggestions', { scanId: id }),
  };
  for (const { q, sort, limit, offset } of QUERIES) {
    answers[`query ${q} by ${sort} ${offset}+${limit}`] = await answer(port, 'POST', '/api/query', { scanId: id, q, sort, limit, offset });
  }
  return normalize(answers, treeRoot) as Record<string, unknown>;
}

/** A second scan record of the same scan, over `store`: its own id, so nothing cached for the first can answer for it. */
function twinScan(scan: ScanResult, store: PackedScanStore): ScanResult {
  const twin = createScanRecord(scan.rootPath);
  const keep = new Set(['scanId', 'root', 'store', 'createdAt']);
  const from = scan as unknown as Record<string, unknown>;
  const to = twin as unknown as Record<string, unknown>;
  for (const key of Object.keys(scan)) if (!keep.has(key)) to[key] = from[key];
  twin.store = store;
  return twin;
}

function assertSameAnswers(want: Record<string, unknown>, got: Record<string, unknown>, what: string): void {
  assert.deepEqual(Object.keys(got), Object.keys(want), `${what}: the same answers were asked for`);
  for (const key of Object.keys(want)) {
    const [a, b] = [JSON.stringify(want[key]), JSON.stringify(got[key])];
    if (a !== b) assert.fail(`${what}: "${key}" differs ${whereTheyDiffer(a, b)}`);
  }
}

/** The golden tree at a fresh place whose last component is the recorded root's name (it appears unscrubbed in the answers). */
async function goldenTree(): Promise<string> {
  const root = path.join(fs.realpathSync(fileTempDir('treemap-numbering-golden-')), 'treemap-golden-fixture');
  await buildGoldenTree(root);
  return root;
}

const recordedGolden = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'golden', 'responses.json'), 'utf8')) as Record<string, unknown>;

test('the golden answers, and every other answer of the API and the MCP tools, are the same bytes for a renumbered scan', async () => {
  const treeRoot = await goldenTree();
  const server = buildMcpServer();
  const mcp = new Client({ name: 'treemap-numbering-test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  try {
    await withServer(async (port) => {
      const scan = await scanThroughApi(port, treeRoot, 'walker');
      const source = scan.store;
      assert.ok(source instanceof PackedScanStore, 'a walker scan keeps a packed store');
      const golden = normalize(await goldenAnswers(port, scan.scanId, treeRoot), treeRoot) as Record<string, unknown>;
      assert.deepEqual(Object.keys(golden), Object.keys(recordedGolden()), 'every key of the golden lock is asked, in its order');
      if (process.platform === 'darwin') {
        // This copy of the harness's requests answers as the harness did.
        assertSameAnswers(recordedGolden(), golden, 'the walker against tests/fixtures/golden/responses.json');
      }
      const more = await moreAnswers(port, mcp, scan, treeRoot);
      let renumbered = 0;
      for (const [seed, schedule] of [[1, 'random'], [2, 'random'], [3, 'depthFirst']] as Array<[number, Schedule]>) {
        const r = renumberStore(source, seed, { schedule, folderTotals: 'zeroed' });
        r.store.sumSizes();
        assert.ok(r.moved > 0, `the ${schedule} schedule moved ids`);
        const twin = twinScan(scan, r.store);
        const what = `the golden tree, ${schedule} seed ${seed}`;
        assertSameAnswers(golden, normalize(await goldenAnswers(port, twin.scanId, treeRoot), treeRoot) as Record<string, unknown>, what);
        assertSameAnswers(more, await moreAnswers(port, mcp, twin, treeRoot), what);
        renumbered++;
      }
      assert.equal(renumbered, 3);
    });
  } finally {
    await mcp.close();
    await server.close();
  }
});

/** The native module, or null with the test skipped (failed on CI, where every leg builds it). */
function nativeOrSkip(t: TestContext): ScanModule | null {
  const surface = nativeScanModule();
  if (!surface.available) {
    skipOrFailOnCi(t, surface.reason);
    return null;
  }
  return surface.module;
}

test('the native engine\'s golden answers equal the recorded golden file byte for byte', { skip: process.platform !== 'darwin' && 'goldens are recorded against APFS readdir order and macOS paths' }, async (t) => {
  if (!nativeOrSkip(t)) return;
  const treeRoot = await goldenTree();
  try {
    await withServer(async (port) => {
      const scan = await scanThroughApi(port, treeRoot, 'native');
      const answers = normalize(await goldenAnswers(port, scan.scanId, treeRoot), treeRoot) as Record<string, unknown>;
      assertSameAnswers(recordedGolden(), answers, 'the native engine against tests/fixtures/golden/responses.json');
    });
  } finally {
    await updateSettings({ engine: 'auto' });
  }
});

/**
 * A tree whose hard-link families span folders at different depths, one
 * member at the end of a folder of 3,000 entries and one at the bottom of a
 * chain of small folders. One worker lists the big folder first (the queue is
 * first in, first out); with several, the bottom of the chain was reached
 * first in every run on this Mac (M3, 24 Sep 2026), so a hard-link winner
 * chosen in discovery order differs between the two walks.
 */
async function determinismTree(): Promise<string> {
  const root = fileTempDir('treemap-numbering-determinism-');
  const at = (...parts: string[]): string => path.join(root, ...parts);
  const stamp = (p: string, ms: number): void => fs.utimesSync(p, new Date(ms), new Date(ms));
  const write = (rel: string[], bytes: number, ms = MTIME_POOL[1]): void => {
    fs.mkdirSync(path.dirname(at(...rel)), { recursive: true });
    fs.writeFileSync(at(...rel), Buffer.alloc(bytes, 0x62));
    stamp(at(...rel), ms);
  };
  for (let i = 0; i < 3000; i++) write(['a-wide', `f${String(i).padStart(4, '0')}.bin`], i % 3 === 0 ? 0 : 7);
  write(['a-wide', 'zz-link.bin'], 4096);
  fs.mkdirSync(at('b-chain', 'c1', 'c2', 'c3', 'c4', 'c5'), { recursive: true });
  fs.linkSync(at('a-wide', 'zz-link.bin'), at('b-chain', 'c1', 'c2', 'c3', 'c4', 'c5', 'deep-link.bin'));
  fs.mkdirSync(at('c-mid', 'd1'), { recursive: true });
  fs.linkSync(at('a-wide', 'zz-link.bin'), at('c-mid', 'd1', 'mid-link.bin'));
  for (let p = 0; p < 16; p++) {
    for (let q = 0; q < 3; q++) {
      for (let f = 0; f < 8; f++) {
        const name = ['a.ts', 'b.ts', 'Z.log', 'résumé.txt', '\u{1F600}.png', 'm.mp4', 'p.jpg', 'r.mp3'][f];
        write([`p${String(p).padStart(2, '0')}`, `q${q}`, name], [0, 7, 4096, 65_536][(p + q + f) % 4], MTIME_POOL[(p + f) % MTIME_POOL.length]);
      }
    }
  }
  write(['p03', 'q1', 'twin-a.bin'], 4096);
  fs.linkSync(at('p03', 'q1', 'twin-a.bin'), at('p11', 'q2', 'twin-b.bin'));
  fs.mkdirSync(at('empty', 'deeper', 'deepest'), { recursive: true });
  write(['junk-only', '.DS_Store'], 6148);
  fs.mkdirSync(at('p05', '.git', 'refs', 'tags'), { recursive: true });
  return root;
}

test('one worker and eight workers give the same answers for the same tree', async (t) => {
  const real = nativeOrSkip(t);
  if (!real) return;
  const root = await determinismTree();
  const peaks: number[] = [];
  // A listing can move a folder's access time between the two walks, so
  // neither asks for access times.
  const pinned = (workers: number): ScanModule => ({
    ...real,
    scanStart: (rootPath, opts) => real.scanStart(rootPath, { ...opts, wantAtime: false, maxWorkers: workers }),
    scanTake: (handle) => {
      const cols = real.scanTake(handle);
      peaks.push(cols.stats.workersPeak);
      return cols;
    },
  });
  const walk = async (workers: number): Promise<{ scan: ScanResult; store: PackedScanStore }> => {
    const scan = createScanRecord(root);
    const store = new PackedScanStore(root, path.sep, { name: path.basename(root), isDir: true, size: 0, modifiedAt: 0, isHidden: false });
    await runNativeWalk(scan, store, root, pinned(workers));
    scan.store = store;
    scan.status = 'complete';
    return { scan, store };
  };
  // Turbo lets a walk run as many workers as the machine has cores; Balanced
  // allows half of them, which is one on a three-core runner.
  applyEngineBudgetSetting({ preset: 'turbo', cpuPercent: null });
  let one: { scan: ScanResult; store: PackedScanStore };
  let eight: { scan: ScanResult; store: PackedScanStore };
  try {
    one = await walk(1);
    eight = await walk(8);
  } finally {
    applyEngineBudgetSetting({ preset: 'auto', cpuPercent: null });
  }
  assert.equal(peaks[0], 1, 'the first walk ran on one worker');
  assert.ok(peaks[1] >= 2, `the second walk ran on ${peaks[1]} workers at once`);

  const counters = (scan: ScanResult): unknown => [
    scan.scanned, scan.fileCount, scan.dirCount, scan.hardlinkedFiles, scan.hardlinkedBytes, scan.sparseFiles, scan.sparseBytes,
    scan.slackBytes, scan.cloudFiles, scan.cloudBytes, scan.walkedDirs, scan.deniedDirs, scan.vanishedDirs, scan.placeholdersSkipped,
  ];
  assert.deepEqual(counters(eight.scan), counters(one.scan), 'the scan counters');
  const laterNames = fs.lstatSync(path.join(root, 'a-wide', 'zz-link.bin')).nlink - 1 + fs.lstatSync(path.join(root, 'p03', 'q1', 'twin-a.bin')).nlink - 1;
  assert.equal(laterNames, 3, 'the file system holds two families with three later names');
  assert.equal(one.scan.hardlinkedFiles, laterNames, 'the walk found each later name');
  const probe = probeOf(one.store);
  const other = changedCopy(one.store, 99);
  const want = await outputsOf(one.store, probe, one.scan, other, 1);
  assertSameOutputs(want, await outputsOf(eight.store, probe, eight.scan, other, 1), 'eight workers against one');
});
