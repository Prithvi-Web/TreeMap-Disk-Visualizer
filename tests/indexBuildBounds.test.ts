import { test, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-indexBuildBounds-data-');

import {
  INDEX_BATCH_ROWS,
  buildIndex,
  closeIndex,
  deleteIndex,
  getRoot,
  openIndex,
  pathResolver,
  readTree,
  searchIndex,
  setBuildSeamsForTests,
  setFlushTimersForTests,
  stopWatcher,
  type BuildProgress,
  type IndexedRoot,
  type SearchOptions,
} from '../src/services/indexEngine';
import { platform } from '../src/platform';
import type { RawEntry } from '../src/platform/types';
import type { FileNode } from '../src/models/types';
import { setWatchImplForTests, type WatchListener } from '../src/platform/watchRegistry';
import { formatCount } from '../src/utils/formatCount';
import { oracleRebuild } from './fixtures/indexBuildOracle';

/**
 * The walk-based index build (plan U-15): no per-entry map, no roll-up pass,
 * progress on every write, and the event loop turning between writes.
 *
 * Before it, the build kept a path → id map of every entry (about 240 B an
 * entry: 2,396 MB at 9,372,987 entries) and, once the walk ended, re-read
 * every row it had written to sum the folders and wrote each folder again —
 * `rollUpSizes`, one 111 s block of the server's event loop on the owner's
 * disk, which in the desktop app froze the window (the server runs in
 * Electron's main process). Progress stood still for that whole pass
 * (docs/engine/TRACK-U-DIAGNOSIS.md).
 *
 * Every assertion counts — rows, statements, transactions, progress events,
 * turns of the event loop — and nothing is timed. The builder before U-15 is
 * kept as the oracle (tests/fixtures/indexBuildOracle.ts): the same trees,
 * built by both, give the same rows, tree and search hits.
 */

after(() => closeIndex());

/** A new folder under the temp folder, by its real path (macOS's /var is a link to /private/var). */
function folder(prefix: string): string {
  return fs.realpathSync(fileTempDir(`treemap-indexBuildBounds-${prefix}-`));
}

/** A fixed time for every entry, so two builds of one tree read the same stamps. */
const STAMP = new Date('2024-03-01T12:00:00Z');

function writeFile(p: string, bytes: number): void {
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
}

/** Stamps every entry under `dir` (folders after their contents, links themselves). */
function stampAll(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) fs.lutimesSync(p, STAMP, STAMP);
    else if (st.isDirectory()) stampAll(p);
    else fs.utimesSync(p, STAMP, STAMP);
  }
  fs.utimesSync(dir, STAMP, STAMP);
}

/**
 * The plan's fixture: 40 folders of 130 files, nested folders, a hard-link
 * pair, a symlink, an empty folder and a hidden file — and two additions
 * that make the counts below hold on any machine. 1,100 files sit at the top,
 * so the walk hands over more than two transactions' worth in one listing,
 * with no I/O between them whatever its concurrency; and 560 folders under
 * `many`, so the folders are written in more than one transaction too.
 */
function planTree(): { dir: string; files: number; dirs: number; bytes: number } {
  const dir = folder('tree');
  let files = 0;
  let dirs = 1;
  let bytes = 0;
  const file = (p: string, size: number): void => {
    writeFile(p, size);
    files++;
    bytes += size;
  };
  for (let i = 0; i < 40; i++) {
    const sub = path.join(dir, `big-${String(i).padStart(2, '0')}`);
    fs.mkdirSync(sub);
    dirs++;
    for (let j = 0; j < 130; j++) file(path.join(sub, `f${String(j).padStart(3, '0')}.dat`), ((i * 131 + j) % 997) + 1);
  }
  fs.mkdirSync(path.join(dir, 'big-07', 'nested', 'deeper'), { recursive: true });
  dirs += 2;
  file(path.join(dir, 'big-07', 'nested', 'n1.txt'), 4000);
  file(path.join(dir, 'big-07', 'nested', 'deeper', 'n2.txt'), 5000);
  file(path.join(dir, 'big-07', 'nested', 'deeper', 'n3.bin'), 6000);
  for (let k = 0; k < 1100; k++) file(path.join(dir, `loose-${String(k).padStart(4, '0')}.txt`), (k % 50) + 10);
  fs.mkdirSync(path.join(dir, 'many'));
  dirs++;
  for (let k = 0; k < 560; k++) fs.mkdirSync(path.join(dir, 'many', `d${String(k).padStart(3, '0')}`));
  dirs += 560;
  // A hard-link pair: one inode, two names, its bytes counted once.
  file(path.join(dir, 'linked.bin'), 70_000);
  fs.linkSync(path.join(dir, 'linked.bin'), path.join(dir, 'linked-again.bin'));
  files++;
  // A symlink to a folder: a leaf of its own size, never followed.
  fs.symlinkSync(path.join(dir, 'big-00'), path.join(dir, 'pointer'));
  files++;
  bytes += fs.lstatSync(path.join(dir, 'pointer')).size;
  fs.mkdirSync(path.join(dir, 'empty'));
  dirs++;
  file(path.join(dir, '.hidden'), 123);
  stampAll(dir);
  return { dir, files, dirs, bytes };
}

/** The plan's tree, made once for the tests that only read it. */
let planTreeMade: ReturnType<typeof planTree> | null = null;
const sharedPlanTree = (): ReturnType<typeof planTree> => (planTreeMade ??= planTree());

/** A folder of `n` files of `bytes` each, stamped. */
function flatTree(prefix: string, n: number, bytes = 10): string {
  const dir = folder(prefix);
  for (let i = 0; i < n; i++) writeFile(path.join(dir, `${prefix}-${String(i).padStart(4, '0')}.bin`), bytes);
  stampAll(dir);
  return dir;
}

/* ══════════════════ what a build does, counted ══════════════════ */

interface Counted<T> {
  result: T;
  /** Executions of statements that read the nodes table. */
  nodeReads: number;
  /** Executions of UPDATEs of the nodes table. */
  nodeUpdates: number;
  /** Every transaction that wrote rows to nodes: its rows, and the event loop's turn count when it began. */
  writes: { rows: number; turn: number }[];
  /** Map entries set with a path under the tree as their key. */
  pathKeys: number;
}

/**
 * Runs `fn` with the database's statements and transactions counted, every
 * Map.set of a key under `under` counted, and a ticker counting the event
 * loop's turns (a setImmediate that queues itself again).
 */
async function counted<T>(under: string, fn: () => Promise<T>): Promise<Counted<T>> {
  const proto = Database.prototype as unknown as {
    prepare: (sql: string) => unknown;
    transaction: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown;
  };
  const originalPrepare = proto.prepare;
  const originalTransaction = proto.transaction;
  const originalSet = Map.prototype.set;
  let nodeReads = 0;
  let nodeUpdates = 0;
  let pathKeys = 0;
  const writes: { rows: number; turn: number }[] = [];
  let open: { rows: number; turn: number } | null = null;
  let turn = 0;
  let ticking = true;
  const tick = (): void => {
    turn++;
    if (ticking) setImmediate(tick);
  };
  setImmediate(tick);

  proto.prepare = function (this: unknown, sql: string) {
    const statement = originalPrepare.call(this, sql) as Record<string | symbol, unknown>;
    const reads = /^\s*(?:SELECT|WITH)\b/i.test(sql) && /\b(?:FROM|JOIN)\s+nodes\b/i.test(sql);
    const updates = /^\s*UPDATE\s+nodes\b/i.test(sql);
    const inserts = /^\s*INSERT\s+INTO\s+nodes\b/i.test(sql);
    return new Proxy(statement, {
      get(target, prop) {
        const value = target[prop];
        if (typeof value !== 'function' || !['run', 'get', 'all', 'iterate'].includes(String(prop))) return value;
        return (...args: unknown[]) => {
          if (reads) nodeReads++;
          if (updates) nodeUpdates++;
          if (inserts && open) open.rows++;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  } as typeof proto.prepare;
  proto.transaction = function (this: unknown, body: (...args: unknown[]) => unknown) {
    const run = originalTransaction.call(this, body);
    return function (this: unknown, ...args: unknown[]) {
      const record = { rows: 0, turn };
      const outer = open;
      open = record;
      try {
        return run.apply(this, args);
      } finally {
        open = outer;
        if (record.rows > 0) writes.push(record);
      }
    };
  } as typeof proto.transaction;
  Map.prototype.set = function <K, V>(this: Map<K, V>, key: K, value: V) {
    if (typeof key === 'string' && key.startsWith(under)) pathKeys++;
    return originalSet.call(this, key, value) as Map<K, V>;
  };
  try {
    const result = await fn();
    return { result, nodeReads, nodeUpdates, writes, pathKeys };
  } finally {
    proto.prepare = originalPrepare;
    proto.transaction = originalTransaction;
    Map.prototype.set = originalSet;
    ticking = false;
  }
}

const ceilDiv = (a: number, b: number): number => Math.ceil(a / b);

test('the walk numbers every entry in the order it hands it over, and names each one\'s folder by its number', async () => {
  const dir = folder('ordinals');
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  writeFile(path.join(dir, 'a', 'b', 'deep.txt'), 3);
  writeFile(path.join(dir, 'a', 'mid.txt'), 2);
  writeFile(path.join(dir, 'top.txt'), 1);
  fs.mkdirSync(path.join(dir, 'c'));
  fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'link'));
  const seen: RawEntry[] = [];
  for await (const entry of platform().fastEnumerate(dir)) seen.push(entry);
  assert.equal(seen.length, 8, 'the folder, a, b, deep.txt, mid.txt, top.txt, c and the link — never the link\'s target again');
  const ordinalOf = new Map<string, number>();
  seen.forEach((entry, i) => {
    assert.equal(entry.ordinal, i, `${entry.path} is numbered in the order it was handed over`);
    ordinalOf.set(entry.path, entry.ordinal);
  });
  assert.equal(seen[0].path, dir);
  assert.equal(seen[0].parentOrdinal, -1, 'the folder walked has no folder above it');
  for (const entry of seen.slice(1)) {
    assert.equal(entry.parentOrdinal, ordinalOf.get(path.dirname(entry.path)), `${entry.path} names its own folder`);
    assert.ok(entry.parentOrdinal < entry.ordinal, `${entry.path}: its folder was handed over first`);
  }
});

test('a build keeps no map of paths and makes no roll-up pass: it never reads or updates a row it wrote, and keeps one slot a folder', async (t) => {
  const tree = sharedPlanTree();
  let folderSlots: number[] | null = null;
  setBuildSeamsForTests({ onFolders: (slots) => { folderSlots = slots; } });
  t.after(() => setBuildSeamsForTests(null));

  const shipped = await counted(tree.dir, () => buildIndex(tree.dir, { live: false }));
  assert.equal(shipped.result.fileCount, tree.files);
  assert.equal(shipped.result.dirCount, tree.dirs);
  assert.equal(shipped.result.totalSize, tree.bytes, 'the folder totals are the files\' bytes, the hard link counted once');
  assert.equal(shipped.pathKeys, 0, 'no path was set as a key in any map');
  assert.equal(shipped.nodeReads, 0, 'no statement read the rows back');
  assert.equal(shipped.nodeUpdates, 0, 'and none rewrote one: each folder is written once, with its total');
  assert.ok(folderSlots, 'the build said what it kept for its folders');
  const slots = folderSlots as number[];
  assert.ok(slots.length > 0);
  assert.deepEqual(slots, slots.map(() => tree.dirs), `every per-folder column holds one slot a folder: ${tree.dirs}`);

  // The control: the same counters over the builder before U-15 see its map and its roll-up.
  deleteIndex(tree.dir);
  const before = await counted(tree.dir, () => oracleRebuild(tree.dir, { live: false }));
  assert.equal(before.pathKeys, tree.files + tree.dirs, 'the old build set every entry\'s path in its map');
  assert.ok(before.nodeReads > 0 && before.nodeUpdates >= tree.dirs, `and read every row back to sum the folders (${before.nodeReads} reads, ${before.nodeUpdates} updates)`);
  deleteIndex(tree.dir);
});

test('every write is a transaction of at most 500 rows — ceil(files/500) + ceil(folders/500) of them — with a progress event after each and a turn of the event loop between each two', async (t) => {
  const tree = sharedPlanTree();
  const events: BuildProgress[] = [];
  const build = await counted(tree.dir, () => buildIndex(tree.dir, { live: false, onProgress: (p) => events.push(p) }));
  t.after(() => deleteIndex(tree.dir));

  assert.equal(INDEX_BATCH_ROWS, 500);
  const expected = ceilDiv(tree.files, 500) + ceilDiv(tree.dirs, 500);
  assert.equal(build.writes.length, expected, `${tree.files} files and ${tree.dirs} folders are ${expected} transactions`);
  assert.ok(build.writes.every((w) => w.rows <= 500), `no transaction holds more than 500 rows: ${build.writes.map((w) => w.rows).join(', ')}`);
  assert.equal(build.writes.reduce((sum, w) => sum + w.rows, 0), tree.files + tree.dirs, 'every entry is written once');

  const steps = events.filter((e) => e.phase === 'enumerating' || e.phase === 'summing');
  assert.ok(steps.length >= build.writes.length, `a progress event after every write: ${steps.length} events, ${build.writes.length} writes`);
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i].processed > steps[i - 1].processed, `the count moves on every event: ${steps[i - 1].processed} then ${steps[i].processed}`);
  }
  assert.deepEqual(events.at(-1), { phase: 'done', processed: tree.files + tree.dirs, currentPath: tree.dir });

  for (let i = 1; i < build.writes.length; i++) {
    assert.ok(build.writes[i].turn > build.writes[i - 1].turn,
      `the event loop turned between write ${i} and write ${i + 1} (turns ${build.writes[i - 1].turn} then ${build.writes[i].turn})`);
  }
});

/* ══════════════════ the same index as the builder before U-15 ══════════════════ */

/** Every row of a root, in id order, with its path and its folder's path in place of ids. */
function rowsOf(root: IndexedRoot): unknown[] {
  const resolve = pathResolver();
  const rows = openIndex()
    .prepare('SELECT id, parent_id, name, ext, is_dir, size, allocated, mtime, flags, ino, nlink FROM nodes WHERE root_id = ? ORDER BY id')
    .all(root.id) as { id: number; parent_id: number | null }[];
  return rows.map(({ id, parent_id, ...rest }) => ({ path: resolve(id), parent: parent_id === null ? null : resolve(parent_id), ...rest }));
}

/** Every hit of a search, page by page. */
function allHits(q: string, opts: SearchOptions = {}): unknown[] {
  const hits: unknown[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = searchIndex(q, { ...opts, limit: 500, offset });
    hits.push(...page.hits);
    if (!page.truncated) return hits;
  }
}

/** The tree read back, node by node in reading order, each without its children: a list a mismatch can be named in. */
function treeNodes(node: FileNode, out: unknown[] = []): unknown[] {
  const { children, ...own } = node;
  out.push({ ...own, children: children === undefined ? 'absent' : children.length });
  for (const child of children ?? []) treeNodes(child, out);
  return out;
}

interface Snapshot {
  counts: Record<string, unknown>;
  lists: Record<string, unknown[]>;
}

function snapshot(dir: string): Snapshot {
  const root = getRoot(dir);
  assert.ok(root, `${dir} is indexed`);
  const { id: _id, builtAt: _builtAt, ...counts } = root;
  const read = readTree(dir, undefined, 1_000_000);
  assert.ok(read, `${dir} reads back`);
  const queries: [string, SearchOptions][] = [
    ['f0', {}], ['*.dat', {}], ['.txt', {}], ['link', {}], ['d', { type: 'dir' }], ['e', { minSize: 4000 }],
    ['.', { scope: path.join(dir, 'big-07') }], ['hidden', {}], ['pointer', {}],
  ];
  const lists: Record<string, unknown[]> = { rows: rowsOf(root), tree: treeNodes(read.root) };
  for (const [q, opts] of queries) lists[`hits for ${JSON.stringify(q)} ${JSON.stringify(opts)}`] = allHits(q, opts);
  return { counts: { ...counts, nodes: read.nodes, prunedDirs: read.prunedDirs }, lists };
}

/**
 * Holds `now` to `before` list by list, element by element, and names the
 * first element that differs — never a diff of thousands of rows, which on a
 * real regression would take minutes and gigabytes to print.
 */
function sameIndex(now: Snapshot, before: Snapshot): void {
  assert.deepEqual(now.counts, before.counts, 'the root\'s counts and total, and the tree\'s node count');
  assert.deepEqual(Object.keys(now.lists), Object.keys(before.lists));
  for (const [what, expected] of Object.entries(before.lists)) {
    const actual = now.lists[what];
    assert.equal(actual.length, expected.length, `${what}: as many as the builder before U-15 gave`);
    for (let i = 0; i < expected.length; i++) {
      const a = JSON.stringify(actual[i]);
      const e = JSON.stringify(expected[i]);
      if (a !== e) assert.fail(`${what}, at ${String(i)}: ${a.slice(0, 500)} — the builder before U-15 gave ${e.slice(0, 500)}`);
    }
  }
}

test('the same rows, tree and search hits as the builder before U-15, on the plan\'s fixture', async () => {
  const tree = sharedPlanTree();
  await oracleRebuild(tree.dir, { live: false });
  const before = snapshot(tree.dir);
  assert.equal(before.lists.rows.length, tree.files + tree.dirs, 'the oracle indexed every entry');
  assert.equal(before.lists.tree.length, tree.files + tree.dirs, 'and the tree reads back whole');
  deleteIndex(tree.dir);

  await buildIndex(tree.dir, { live: false });
  // Every column of every row in the same order, the tree read back, and every search's hits.
  sameIndex(snapshot(tree.dir), before);
  deleteIndex(tree.dir);
});

test('the same index as the builder before U-15 when the path walked is itself a file', async () => {
  const dir = folder('one-file');
  const file = path.join(dir, 'alone.bin');
  writeFile(file, 4321);
  stampAll(dir);
  await oracleRebuild(file, { live: false });
  const before = snapshot(file);
  assert.equal(before.counts.totalSize, 4321, 'the oracle sized the file');
  deleteIndex(file);
  await buildIndex(file, { live: false });
  // One row, its size the total, as before.
  sameIndex(snapshot(file), before);
  deleteIndex(file);
});

test('a cancel while the folders are being written discards the build: nothing it wrote is left', async (t) => {
  const tree = sharedPlanTree();
  const fileWrites = ceilDiv(tree.files, 500);
  assert.ok(tree.dirs > 500, 'the folders take more than one write, so there is a write after the first');
  let cancelled = false;
  let heldAt = 0;
  setBuildSeamsForTests({
    afterWrite: (n) => {
      if (n !== fileWrites + 1) return undefined;
      // The first folder write has committed: a cancel arrives now.
      heldAt = n;
      cancelled = true;
      return undefined;
    },
  });
  t.after(() => setBuildSeamsForTests(null));
  const events: BuildProgress[] = [];
  await assert.rejects(buildIndex(tree.dir, { live: false, isCancelled: () => cancelled, onProgress: (p) => events.push(p) }), { message: 'cancelled' });
  assert.equal(heldAt, fileWrites + 1, 'the cancel came after the first folder write');
  assert.equal(events.filter((e) => e.phase === 'summing').length, 1, 'and no folder was written after it');
  assert.equal(getRoot(tree.dir), null, 'the cancelled build left no root');
  const orphans = (openIndex().prepare('SELECT COUNT(*) c FROM nodes WHERE root_id NOT IN (SELECT id FROM roots)').get() as { c: number }).c;
  assert.equal(orphans, 0, 'and none of its rows');
});

test('a build sets its ids aside above every id before it, and the next id any other insert takes is above them all', async (t) => {
  const dir = flatTree('seq', 3, 10);
  const ranges: { base: number; stride: number }[] = [];
  setBuildSeamsForTests({ onReserve: (base, stride) => { ranges.push({ base, stride }); } });
  t.after(() => setBuildSeamsForTests(null));
  const handle = openIndex();
  for (const fresh of [true, false]) {
    const label = fresh ? 'a database whose nodes never had a row' : 'a database whose nodes have had rows';
    if (fresh) {
      deleteIndex();
      handle.prepare("DELETE FROM sqlite_sequence WHERE name = 'nodes'").run();
    }
    const highest = (handle.prepare('SELECT COALESCE(MAX(id), 0) m FROM nodes').get() as { m: number }).m;
    const built = await buildIndex(dir, { live: false });
    const { base, stride } = ranges.at(-1) ?? assert.fail('the build said which ids it set aside');
    assert.ok(base > highest, `${label}: the range starts above every id before it (${base} > ${highest})`);
    assert.equal(stride, 2 ** 32, `${label}: an uncapped build sets 2^32 ids aside`);
    // An AUTOINCREMENT insert, as a live watcher's: the first id past the range.
    handle.prepare("INSERT INTO roots (path, state, mechanism) VALUES ('/synthetic-seq', 'ready', 'synthetic')").run();
    const other = (handle.prepare("SELECT id FROM roots WHERE path = '/synthetic-seq'").get() as { id: number }).id;
    const next = Number(handle.prepare("INSERT INTO nodes (root_id, parent_id, name, ext, is_dir, size, mtime, flags) VALUES (?, NULL, 'x', '', 1, 0, 0, 0)").run(other).lastInsertRowid);
    assert.equal(next, base + stride, `${label}: the next id taken is the first above the range`);
    deleteIndex('/synthetic-seq');
    assert.equal(built.fileCount, 3);
  }
});

/* ══════════════════ ids set aside (U-D6), and the build held after a write ══════════════════ */

interface HeldFlush { ms: number; fire: () => void; fired: boolean; cleared: boolean }

/** The index's watch and flush timers driven by hand, as tests/indexEngine.test.ts drives them: counted, never timed. */
function handDriven(t: TestContext): { changed: (dir: string, name: string) => void; pending: () => HeldFlush[]; fire: (flush: HeldFlush) => void } {
  class StandInWatch extends EventEmitter {
    close(): void {}
  }
  const listeners = new Map<string, WatchListener>();
  setWatchImplForTests((target, _opts, listener) => {
    listeners.set(target, listener);
    return new StandInWatch();
  });
  const flushes: HeldFlush[] = [];
  setFlushTimersForTests({
    set: (fire, ms) => {
      const held: HeldFlush = { ms, fire, fired: false, cleared: false };
      flushes.push(held);
      return held;
    },
    clear: (handle) => { (handle as HeldFlush).cleared = true; },
  });
  t.after(() => {
    setWatchImplForTests(null);
    setFlushTimersForTests(null);
  });
  return {
    changed: (dir, name) => {
      const listener = listeners.get(dir);
      assert.ok(listener, `the index watches ${dir} through the registry`);
      listener('change', name);
    },
    pending: () => flushes.filter((f) => !f.fired && !f.cleared),
    fire: (flush) => {
      flush.fired = true;
      flush.fire();
    },
  };
}

/** Starts a build that the seam holds after its first write; resolves once it is held, or fails if it ends first. */
async function heldAfterFirstWrite(t: TestContext, dir: string): Promise<{ build: Promise<IndexedRoot>; release: () => void; range: () => { base: number; stride: number } }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  let range: { base: number; stride: number } | null = null;
  setBuildSeamsForTests({
    onReserve: (base, stride) => { range = { base, stride }; },
    afterWrite: (n) => {
      if (n !== 1) return undefined;
      held = true;
      return gate;
    },
  });
  t.after(() => setBuildSeamsForTests(null));
  const build = buildIndex(dir, { live: false });
  let ended = false;
  build.then(() => { ended = true; }, () => { ended = true; });
  await waitFor(() => held || ended, 'the build being held after its first write, or ending');
  assert.equal(held, true, 'the build was held after its first write, before it ended');
  return { build, release, range: () => range ?? assert.fail('the build never said which ids it set aside') };
}

test('a live watcher writing to another root while the build is held takes ids outside the ones the build set aside, and both roots read back right', async (t) => {
  const drive = handDriven(t);
  const other = flatTree('other', 2, 100);
  await buildIndex(other, { live: true });
  t.after(() => stopWatcher(other));
  const otherBefore = getRoot(other)!;
  const dir = flatTree('held', 1200, 10);

  const { build, release, range } = await heldAfterFirstWrite(t, dir);
  const building = getRoot(dir)!;
  const written = (openIndex().prepare('SELECT COUNT(*) c FROM nodes WHERE root_id = ?').get(building.id) as { c: number }).c;
  assert.equal(building.state, 'building');
  assert.equal(written, 500, 'held after one transaction of 500 rows');
  assert.equal(allHits('held').filter((h) => (h as { rootPath: string }).rootPath === dir).length, 0, 'none of which search returns while it builds');

  // The live path writes 50 rows for the other root, with AUTOINCREMENT ids.
  for (let i = 0; i < 50; i++) writeFile(path.join(other, `new-${String(i).padStart(2, '0')}.bin`), 7);
  for (let i = 0; i < 50; i++) drive.changed(other, `new-${String(i).padStart(2, '0')}.bin`);
  // The provider looks at each change before it queues it, so a change can
  // queue after a flush has taken the queue: every flush that is waiting is
  // fired, at every look, until all fifty have landed.
  await waitFor(() => {
    for (const flush of drive.pending()) drive.fire(flush);
    return getRoot(other)!.fileCount === otherBefore.fileCount + 50;
  }, 'the other root\'s 50 rows landing');

  release();
  const built = await build; // a UNIQUE error would reject here
  assert.equal(built.state, 'ready');
  assert.equal(built.fileCount, 1200);
  assert.equal(built.totalSize, 12_000);

  const { base, stride } = range();
  const idsOf = (rootId: number): number[] => (openIndex().prepare('SELECT id FROM nodes WHERE root_id = ?').all(rootId) as { id: number }[]).map((r) => r.id);
  const inRange = (id: number): boolean => id >= base && id < base + stride;
  assert.ok(idsOf(built.id).every(inRange), 'every row of the build has an id it set aside');
  const otherIds = idsOf(otherBefore.id);
  assert.equal(otherIds.length, 53, 'the other root: its folder, its two files and the 50 the watcher wrote');
  assert.equal(otherIds.filter(inRange).length, 0, 'none of the other root\'s ids falls in the range the build set aside');

  assert.equal(readTree(dir)!.root.children!.length, 1200, 'the build reads back whole');
  const otherTree = readTree(other)!;
  assert.equal(otherTree.root.children!.length, 52);
  assert.equal(getRoot(other)!.totalSize, 2 * 100 + 50 * 7, 'and so does the other root');
});

test('a walk past the ids the build set aside stops with a sentence, and nothing it wrote is served', async (t) => {
  const dir = flatTree('stride', 30, 10);
  let range: { base: number; stride: number } | null = null;
  setBuildSeamsForTests({ stride: 10, onReserve: (base, stride) => { range = { base, stride }; } });
  t.after(() => setBuildSeamsForTests(null));
  const sentence = `The index build stopped at ${formatCount(10)} items, the most it set aside room for.`;
  await assert.rejects(buildIndex(dir, { live: false }), { message: sentence });
  const root = getRoot(dir);
  assert.ok(root, 'an explicit build that fails keeps its root, as every failed build does');
  assert.equal(root.state, 'error');
  assert.equal(root.error, sentence, 'with the sentence as its reason');
  assert.ok(range, 'the build said which ids it set aside');
  const { base } = range as { base: number; stride: number };
  const ids = (openIndex().prepare('SELECT id FROM nodes WHERE root_id = ?').all(root.id) as { id: number }[]).map((r) => r.id);
  assert.ok(ids.every((id) => id >= base && id < base + 10), `no row was written past the ten ids set aside: ${ids.join(', ')}`);
  assert.equal(allHits('stride').filter((h) => (h as { rootPath: string }).rootPath === dir).length, 0, 'and search serves none of it');
});

/* ══════════════════ the ids a cap sets aside, and a remedy that works (review of U-15) ══════════════════ */

test('a cap above 2^32 sets aside 2^32 ids, as a build without a cap does, so every cap the route accepts builds', async (t) => {
  // The route accepts any positive whole number as `maxEntries`. A cap of
  // 2^53 − 1 set that many ids aside and failed at once; a cap of 10^15
  // spent a ninth of every id there is, so a few such builds left no room
  // for any build after them.
  const dir = flatTree('bigcap', 3, 10);
  const strides: number[] = [];
  setBuildSeamsForTests({ onReserve: (_base, stride) => { strides.push(stride); } });
  t.after(() => setBuildSeamsForTests(null));
  const caps = [Number.MAX_SAFE_INTEGER, 1e15, 2 ** 32, 2 ** 32 - 1];
  for (const maxEntries of caps) {
    const built = await buildIndex(dir, { live: false, maxEntries });
    assert.equal(built.fileCount, 3, `a cap of ${String(maxEntries)} builds the folder`);
  }
  assert.deepEqual(strides, caps.map(() => 2 ** 32), 'and none of them sets aside more than 2^32 ids');
});

test('removing the whole index starts the ids again from 1, so the sentence a build with no room ends with names a remedy that works', async (t) => {
  const dir = flatTree('reset', 3, 10);
  const bases: number[] = [];
  setBuildSeamsForTests({ onReserve: (base) => { bases.push(base); } });
  t.after(() => setBuildSeamsForTests(null));
  await buildIndex(dir, { live: false });
  deleteIndex();
  await buildIndex(dir, { live: false });
  assert.equal(bases.at(-1), 1, 'the first build after the whole index is removed sets its ids aside from 1');

  // No room left: the sequence a step below 2^53.
  openIndex().prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'nodes'").run(Number.MAX_SAFE_INTEGER - 10);
  const sentence = 'The index has no room left for another build: remove the index, then build it again.';
  await assert.rejects(buildIndex(dir, { live: false }), { message: sentence });
  assert.equal(getRoot(dir)?.fileCount, 3, 'the build that had no room left the folder\'s index as it was');
  deleteIndex();
  const again = await buildIndex(dir, { live: false });
  assert.equal(again.fileCount, 3, 'and the remedy the sentence names works: removed, it builds again');
  assert.equal(bases.at(-1), 1);
});

test('an entry the walk hands over without a number of its own fails the build loudly instead of being written outside its ids', async (t) => {
  const dir = flatTree('unnumbered', 2, 10);
  const provider = platform() as unknown as { fastEnumerate: (root: string, opts: object) => AsyncIterable<RawEntry> };
  const real = provider.fastEnumerate.bind(provider);
  t.after(() => { delete (provider as { fastEnumerate?: unknown }).fastEnumerate; });
  for (const bad of [-1, Number.NaN, 1.5]) {
    provider.fastEnumerate = async function* (root: string, opts: object): AsyncIterable<RawEntry> {
      for await (const entry of real(root, opts)) yield entry.isDir ? entry : { ...entry, ordinal: bad };
    };
    await assert.rejects(buildIndex(dir, { live: false }), { message: /without a number of its own/ }, `an entry numbered ${String(bad)}`);
    const root = getRoot(dir);
    assert.equal(root?.state, 'error', `numbered ${String(bad)}: the build failed`);
    assert.equal((openIndex().prepare('SELECT COUNT(*) c FROM nodes WHERE root_id = ?').get(root!.id) as { c: number }).c, 0, `numbered ${String(bad)}: and wrote no row`);
  }
});
