import { test, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A1 — the persistent live index.
 *
 * The app-data directory is redirected before the engine is imported, because
 * `appDataDir()` reads the environment at call time and the index database is
 * created inside it. Without this the suite would write into the user's real
 * TreeMap data directory — which is exactly how junk roots ended up in a real
 * snapshots.json once before.
 */
// Loaded for its effect: a plain run of this file is guarded too (src/services/realMachineGuard.ts).
// The data folder is this file's own (tests/testDataIsolation.test.ts, OWN_DATA_DIR).
import './fixtures/dataDir';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-index-data-'));
process.env.TREEMAP_DATA_DIR = DATA_DIR;

import {
  buildIndex,
  getRoot,
  listRoots,
  rootFor,
  readTree,
  deleteIndex,
  openIndex,
  closeIndex,
  indexDbPath,
  startWatcher,
  stopWatcher,
  stopAllWatchers,
  applyPendingChanges,
  watcherEventCount,
  findNodeIdByPath,
  pathOfNode,
  FLAG,
} from '../src/services/indexEngine';
import type { FileNode } from '../src/models/types';
import { awaitWatchLive, silentWatchReason, watchBrings } from './fixtures/watchReady';

const mkTmp = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), 'tm-index-'));

/** The Node file-system calls that read or change the disk — what a scan is made of. */
const DISK_CALLS = {
  sync: ['readdirSync', 'opendirSync', 'statSync', 'lstatSync', 'fstatSync', 'existsSync', 'accessSync', 'readFileSync', 'openSync', 'readSync', 'realpathSync', 'mkdirSync', 'statfsSync'],
  promises: ['readdir', 'opendir', 'stat', 'lstat', 'access', 'readFile', 'open', 'realpath', 'mkdir', 'statfs'],
} as const;

/** Every disk call `fn` made through Node's `fs` and `fs.promises`, by name, in order. */
function diskCallsDuring<T>(fn: () => T): { result: T; calls: string[] } {
  const calls: string[] = [];
  const restore: Array<() => void> = [];
  const wrap = (api: Record<string, unknown>, label: string, names: readonly string[]): void => {
    for (const name of names) {
      const original = api[name];
      if (typeof original !== 'function') continue;
      api[name] = function (this: unknown, ...args: unknown[]): unknown {
        calls.push(`${label}.${name}`);
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      };
      restore.push(() => { api[name] = original; });
    }
  };
  wrap(fs as unknown as Record<string, unknown>, 'fs', DISK_CALLS.sync);
  wrap(fs.promises as unknown as Record<string, unknown>, 'fs.promises', DISK_CALLS.promises);
  try {
    return { result: fn(), calls };
  } finally {
    for (const undo of restore) undo();
  }
}

/**
 * Runs `fn` with `readTree`'s children statement counted: how many times it
 * ran, how many rows it handed back, and how many times anything read a
 * row's `size` — the frontier's comparisons among them, plus each node
 * taking its own size. The statement is found by its SQL, and it must have
 * run: a rewrite of the query fails here rather than counting nothing.
 */
function childReadsDuring<T>(fn: () => T): { result: T; queries: number; rows: number; sizeReads: number } {
  const db = openIndex() as unknown as { prepare: (sql: string) => unknown };
  const original = db.prepare;
  const counts = { queries: 0, rows: 0, sizeReads: 0 };
  db.prepare = function (this: unknown, sql: string) {
    const statement = original.call(this, sql) as { all: (...args: unknown[]) => Record<string, unknown>[] };
    if (!sql.trim().startsWith('SELECT * FROM nodes WHERE parent_id = ?')) return statement;
    return {
      all: (...args: unknown[]) => {
        counts.queries++;
        return statement.all(...args).map((row) => {
          counts.rows++;
          const size = row.size;
          return Object.defineProperty({ ...row }, 'size', { enumerable: true, get: () => { counts.sizeReads++; return size; } });
        });
      },
    };
  } as typeof db.prepare;
  try {
    const result = fn();
    assert.ok(counts.queries > 0, "readTree's children query never ran under its known SQL, so there is nothing to count");
    return { result, ...counts };
  } finally {
    db.prepare = original;
  }
}

/**
 * Assert a live update landed, saying how long it took — and, when it never
 * did, saying WHOSE fault that is.
 *
 * How long is reported, never asserted. §A1's two-second acceptance figure
 * measures the machine as much as the index: a shared CI runner sits on
 * FSEvents callbacks for seconds under load (run #11 measured a miss on a
 * green codebase), so the figure is the bench harness's to hold, and here
 * the wait is bounded only by the shared hang guard (`watchBrings`). What
 * the engine controls of that latency — one flush, FLUSH_MS after the
 * event — lands or it does not.
 *
 * `fs.watch` can attach without error and then deliver nothing at all. That
 * is not a hypothesis: one traced full-suite run on this Mac caught a watcher
 * attached, a file written into the watched directory, and fifteen seconds
 * later the watcher detached having never once fired — while the next root in
 * the same process got its first callback in eleven milliseconds. Nothing in
 * the index can make a silent watch speak.
 *
 * So a miss is triaged rather than blamed. If the OS delivered NOTHING for
 * this root, the run cannot exercise what §A1 is about and says so — the same
 * shape as `cartCommit.test.ts` skipping when a filesystem refuses a sparse
 * file. If the OS DID deliver events and the change still did not land, that
 * is this codebase's bug and it fails, loudly, as it always did.
 *
 * The distinction is the point. Without it, a platform silence and a real
 * regression in `applyPendingChanges` produce the same message, and the last
 * three sessions of this project were spent on exactly that confusion.
 *
 * Counted from `baseline`, the watch's event count once the readiness
 * handshake (`watchLive`) had proved it could report at all: events before
 * that say nothing about the change under test.
 */
async function assertLanded(
  predicate: () => boolean,
  what: string,
  ctx: { t: TestContext; dir: string; baseline: number },
): Promise<boolean> {
  const started = performance.now();
  if (await watchBrings(predicate, what)) {
    ctx.t.diagnostic(`${what} landed ${(performance.now() - started).toFixed(0)} ms after the change`);
    return true;
  }
  const now = watcherEventCount(ctx.dir);
  if (now === null) {
    // No watcher is attached at all, which is a different failure from
    // either of the two below and must not be dressed up as one — the
    // earlier version printed "the OS delivered null event(s)".
    assert.fail(`${what} never landed, and no watcher is attached to ${ctx.dir} — the watch was never established or was stopped early.`);
  }
  const delivered = now - ctx.baseline;
  if (delivered === 0) {
    ctx.t.skip(
      `the OS watch on ${ctx.dir} reported a rewrite made just before, then delivered no events at all ` +
      `before the hang guard ran out, so "${what}" could not be observed — a platform failure, not an index one. ` +
      'See HANDOFF.md, "a watch that attaches and says nothing".',
    );
    return false;
  }
  assert.fail(
    `${what} never landed in the index, and this IS a bug here: the OS delivered ` +
    `${String(delivered)} event(s) for this root after it proved live, and none of them produced the change.`,
  );
}

/**
 * The readiness handshake for a freshly attached watch: rewrite `sentinel` —
 * a file the index already holds — until the OS reports something for `dir`
 * (tests/fixtures/watchReady.ts has the measurements). Returns the event
 * count to measure the real change from, or null having skipped the test
 * with what was measured, when the watch never said a word.
 */
async function watchLive(t: TestContext, dir: string, sentinel: string): Promise<number | null> {
  const ready = await awaitWatchLive(sentinel, () => watcherEventCount(dir));
  if (!ready.live) {
    t.skip(silentWatchReason(dir, ready));
    return null;
  }
  return ready.baseline;
}

after(() => {
  stopAllWatchers();
  closeIndex();
  // maxRetries: Windows briefly holds locks on just-closed SQLite WAL and
  // watcher handles, and a bare rmSync throws EBUSY into the after() hook —
  // which node:test reports as the whole FILE failing (CI, first real
  // Windows runs). Retrying is the documented cure and free elsewhere.
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/* ══════════════════════ Build correctness ══════════════════════ */

test('folder sizes are the exact recursive totals of their contents', async () => {
  const dir = await mkTmp();
  try {
    await fsp.mkdir(path.join(dir, 'a', 'b'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'a', 'b', 'deep.bin'), Buffer.alloc(2000));
    await fsp.writeFile(path.join(dir, 'a', 'mid.bin'), Buffer.alloc(1000));
    await fsp.writeFile(path.join(dir, 'top.bin'), Buffer.alloc(500));

    const root = await buildIndex(dir, { live: false });
    assert.equal(root.state, 'ready');
    assert.equal(root.totalSize, 3500, 'the root is the sum of everything beneath it');
    assert.equal(root.fileCount, 3);
    assert.equal(root.dirCount, 3, 'the root itself counts as a directory');

    const tree = readTree(dir)!;
    const byName = new Map(tree.root.children!.map((c) => [c.name, c]));
    assert.equal(byName.get('a')!.size, 3000, 'a nested folder sums its own subtree');
    assert.equal(byName.get('top.bin')!.size, 500);
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a hard link is counted once, not once per name', async () => {
  // Without this, a tree full of hard links reports several times its real size
  // — the same rule the walker and the gdu mapper already enforce.
  const dir = await mkTmp();
  try {
    const original = path.join(dir, 'original.bin');
    await fsp.writeFile(original, Buffer.alloc(4000));
    await fsp.link(original, path.join(dir, 'hardlink.bin'));

    const root = await buildIndex(dir, { live: false });
    assert.equal(root.totalSize, 4000, 'two names, one file, counted once');

    const tree = readTree(dir)!;
    const zeroed = tree.root.children!.filter((c) => c.hardlinkDuplicate === true);
    assert.equal(zeroed.length, 1, 'the second name is marked as the duplicate');
    assert.equal(zeroed[0].size, 0);
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// Skipped on Windows because both halves of the premise are POSIX-shaped:
// libuv leaves `blocks` meaningless there (so `allocated` is NULL in the
// index by design — blocksAreMeaningful), and NTFS allocates truncate-only
// files solid anyway. Windows placeholder detection rides reparse tags via
// the platform layer (A3), not block counts.
test('a sparse file is indexed by what it claims, and flagged by what it occupies', { skip: process.platform === 'win32' && 'blocks is meaningless on Windows; placeholders ride reparse tags there' }, async () => {
  const dir = await mkTmp();
  try {
    const sparse = path.join(dir, 'sparse.bin');
    const fd = fs.openSync(sparse, 'w');
    fs.ftruncateSync(fd, 20 * 1024 * 1024);
    fs.closeSync(fd);

    const root = await buildIndex(dir, { live: false });
    const db = openIndex();
    const nodeId = findNodeIdByPath(root.id, dir, sparse);
    assert.notEqual(nodeId, null, 'the sparse file resolves through the segment descent');
    assert.equal(pathOfNode(nodeId!), sparse, 'and its path reconstructs byte-identically');
    const row = db.prepare('SELECT size, allocated, flags FROM nodes WHERE id = ?').get(nodeId) as
      | { size: number; allocated: number | null; flags: number }
      | undefined;
    assert.ok(row);
    assert.equal(row!.size, 20 * 1024 * 1024, 'the logical size is what it claims');
    // Asserted as a real number, not `?? 0`: a null here would mean "unknown",
    // and coalescing it to zero would let an unknown masquerade as "occupies
    // nothing" — the exact conflation that hid this bug the first time.
    assert.equal(typeof row!.allocated, 'number', 'allocated size is known on this platform, not null');
    assert.ok(row!.allocated! < 1024 * 1024, 'the allocated size is what it really occupies');
    assert.ok((row!.flags & FLAG.PLACEHOLDER) !== 0, 'claiming bytes it does not occupy is flagged');
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('symlinks are recorded as leaves and never followed into a loop', async () => {
  const dir = await mkTmp();
  try {
    await fsp.mkdir(path.join(dir, 'real'));
    await fsp.writeFile(path.join(dir, 'real', 'f.bin'), Buffer.alloc(100));
    // A symlink pointing at its own ancestor: following it would never return.
    await fsp.symlink(dir, path.join(dir, 'loop'));

    const root = await buildIndex(dir, { live: false });
    assert.equal(root.state, 'ready', 'a self-referential symlink does not hang the build');
    const tree = readTree(dir)!;
    const loop = tree.root.children!.find((c) => c.name === 'loop');
    assert.ok(loop, 'the symlink is still listed');
    assert.equal(loop!.isSymlink, true);
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════════ Reopen (acceptance) ══════════════════════ */

test('reopening an indexed folder reads the index, never the disk: one query per folder, each row once', async () => {
  // §A1 acceptance: "Second and later opens of an indexed folder render in
  // under 200ms with no scan spinner." The 200 ms is the bench harness's to
  // measure: asserted here, it measured the runner. What makes it hold on
  // any machine is asserted instead, by count — not one disk call (a disk
  // call is a scan, and the spinner with it), one children query per
  // folder, and every row read exactly once.
  const dir = await mkTmp();
  try {
    for (let i = 0; i < 40; i++) {
      await fsp.mkdir(path.join(dir, `d${String(i)}`));
      for (let j = 0; j < 25; j++) {
        await fsp.writeFile(path.join(dir, `d${String(i)}`, `f${String(j)}.bin`), Buffer.alloc(512));
      }
    }
    await buildIndex(dir, { live: false });

    const reopened = diskCallsDuring(() => childReadsDuring(() => readTree(dir)!));
    const { result: tree, queries, rows } = reopened.result;

    assert.equal(tree.nodes, 1041, 'the whole tree came back: 1 root + 40 dirs + 1000 files');
    assert.deepEqual(reopened.calls, [], 'reopening read the disk: that is a scan, and the spinner §A1 rules out');
    assert.equal(queries, 41, 'one children query per folder: the root and its 40');
    assert.equal(rows, 1040, 'every row below the root read once — none twice, none fetched and thrown away');
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════════ Live updates (acceptance) ══════════════════════ */

test('an external create, resize and delete each land without a rescan', async (t) => {
  // §A1 acceptance: "An external file create/delete/resize is reflected within
  // 2 seconds without a user-triggered rescan."
  const dir = await mkTmp();
  try {
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(1000));
    const root = await buildIndex(dir, { live: true });
    assert.equal(root.live, true, 'a live watcher is attached after building');
    const baseline = await watchLive(t, dir, path.join(dir, 'a.bin'));
    if (baseline === null) return;
    const ctx = { t, dir, baseline };

    const target = path.join(dir, 'new.bin');

    await fsp.writeFile(target, Buffer.alloc(5000));
    if (!(await assertLanded(() => getRoot(dir)!.totalSize === 6000, 'an external create', ctx))) return;

    // Each change is triaged on the events that came after it.
    ctx.baseline = watcherEventCount(dir) ?? ctx.baseline;
    await fsp.writeFile(target, Buffer.alloc(9000));
    if (!(await assertLanded(() => getRoot(dir)!.totalSize === 10000, 'an external resize', ctx))) return;

    ctx.baseline = watcherEventCount(dir) ?? ctx.baseline;
    await fsp.unlink(target);
    if (!(await assertLanded(() => getRoot(dir)!.totalSize === 1000, 'an external delete', ctx))) return;
  } finally {
    stopWatcher(dir);
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('deleting a folder removes its whole subtree from the index', async (t) => {
  const dir = await mkTmp();
  try {
    await fsp.mkdir(path.join(dir, 'doomed', 'inner'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'doomed', 'inner', 'f.bin'), Buffer.alloc(3000));
    await fsp.writeFile(path.join(dir, 'keep.bin'), Buffer.alloc(1000));
    const root = await buildIndex(dir, { live: true });
    assert.equal(root.totalSize, 4000);
    const baseline = await watchLive(t, dir, path.join(dir, 'keep.bin'));
    if (baseline === null) return;

    await fsp.rm(path.join(dir, 'doomed'), { recursive: true, force: true });
    // Same triage as the acceptance test above: a watch that delivered
    // nothing at all is a platform silence, not a subtree bug, and saying so
    // is worth more than a failure that names the wrong thing.
    if (!(await assertLanded(() => getRoot(dir)!.totalSize === 1000, 'the folder deletion', { t, dir, baseline }))) return;

    const db = openIndex();
    const rootId = getRoot(dir)!.id;
    assert.equal(findNodeIdByPath(rootId, dir, path.join(dir, 'doomed')), null, 'the folder itself is gone');
    const remaining = db.prepare('SELECT COUNT(*) c FROM nodes WHERE root_id = ?').get(rootId) as { c: number };
    assert.equal(remaining.c, 2, 'only the root and keep.bin remain — no descendant rows left behind');
  } finally {
    stopWatcher(dir);
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a path containing LIKE wildcards is deleted precisely, not by pattern', async (t) => {
  // `_` and `%` are wildcards in SQL LIKE, and when deletes matched on a
  // stored path this needed careful escaping. v3 deletes by id closure, which
  // makes the hazard structural rather than escaped — this test pins that a
  // folder called "100%_backup" still takes only itself.
  const dir = await mkTmp();
  try {
    await fsp.mkdir(path.join(dir, '100%_backup'));
    await fsp.writeFile(path.join(dir, '100%_backup', 'inside.bin'), Buffer.alloc(700));
    await fsp.mkdir(path.join(dir, '1002xbackup'));
    await fsp.writeFile(path.join(dir, '1002xbackup', 'survivor.bin'), Buffer.alloc(900));

    const root = await buildIndex(dir, { live: false });
    assert.equal(root.totalSize, 1600);

    assert.equal(startWatcher(dir), true, 'the watcher attached at all');
    const baseline = await watchLive(t, dir, path.join(dir, '1002xbackup', 'survivor.bin'));
    if (baseline === null) return;
    await fsp.rm(path.join(dir, '100%_backup'), { recursive: true, force: true });
    // Named for what actually failed. This used to read "the wildcard-named
    // folder was removed", which is a claim about the disk — and the disk had
    // done its part. What can fail here is the watcher noticing, and whether
    // THAT is a bug depends on whether the OS said anything at all.
    if (!(await assertLanded(() => getRoot(dir)!.totalSize === 900, 'the wildcard-named folder’s removal', { t, dir, baseline }))) return;

    const rootId = getRoot(dir)!.id;
    assert.equal(findNodeIdByPath(rootId, dir, path.join(dir, '100%_backup')), null, 'the wildcard-named folder is gone');
    assert.notEqual(
      findNodeIdByPath(rootId, dir, path.join(dir, '1002xbackup', 'survivor.bin')),
      null,
      'the similarly-named sibling survived',
    );
  } finally {
    stopWatcher(dir);
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════════ Crash safety (acceptance) ══════════════════════ */

test('a build interrupted mid-way is discarded, never served as complete', async () => {
  // §A1 acceptance: "Killing the app mid-index and relaunching never produces a
  // corrupt or silently-wrong index." A partial tree reports folder sizes that
  // are simply wrong, so it must not survive as 'ready'.
  const dir = await mkTmp();
  try {
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(1000));
    await buildIndex(dir, { live: false });

    // Simulate the crash: a root left in 'building', exactly as a killed
    // process leaves it.
    const db = openIndex();
    db.prepare("UPDATE roots SET state = 'building' WHERE path = ?").run(dir);
    closeIndex();

    // Reopening is what a relaunch does.
    openIndex();
    assert.equal(getRoot(dir), null, 'the half-built root is gone, not offered as usable');
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a root whose watcher did not survive the restart is marked stale, not ready', async () => {
  // Events are missed while the app is closed, and fs.watch offers no sequence
  // to resume from — so an index that was not watched continuously cannot be
  // vouched for. Saying 'stale' is the honest answer.
  const dir = await mkTmp();
  try {
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(1000));
    await buildIndex(dir, { live: false });
    assert.equal(getRoot(dir)!.state, 'ready');

    closeIndex();
    openIndex(); // a fresh process

    assert.equal(getRoot(dir)!.state, 'stale', 'an unwatched index is stale until reconciled');
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a schema version mismatch rebuilds rather than misreading old rows', async () => {
  // §3.7: "on version mismatch, rebuild the index rather than misreading it".
  const dir = await mkTmp();
  try {
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(1000));
    await buildIndex(dir, { live: false });
    assert.ok(getRoot(dir));

    const db = openIndex();
    db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
    closeIndex();

    openIndex(); // sees a version it does not understand
    assert.deepEqual(listRoots(), [], 'the old database was discarded, not reinterpreted');
    assert.ok(fs.existsSync(indexDbPath()), 'a fresh database took its place');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════════ Tree shape (pruneTree invariants) ══════════════════════ */

test('an empty directory carries children: [], never undefined', async () => {
  // The empty-folder finder distinguishes "no children" from "children
  // withheld" on exactly this.
  const dir = await mkTmp();
  try {
    await fsp.mkdir(path.join(dir, 'empty'));
    await buildIndex(dir, { live: false });
    const tree = readTree(dir)!;
    const empty = tree.root.children!.find((c) => c.name === 'empty')!;
    assert.deepEqual(empty.children, [], 'an empty folder is empty, not unloaded');
    assert.equal(empty.pruned, undefined);
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('pruning withholds whole directories and keeps every size exact', async () => {
  const dir = await mkTmp();
  try {
    for (let i = 0; i < 12; i++) {
      await fsp.mkdir(path.join(dir, `d${String(i)}`));
      for (let j = 0; j < 12; j++) {
        await fsp.writeFile(path.join(dir, `d${String(i)}`, `f${String(j)}.bin`), Buffer.alloc(100));
      }
    }
    const root = await buildIndex(dir, { live: false });

    const full = readTree(dir)!;
    const pruned = readTree(dir, undefined, 20)!;

    assert.ok(pruned.prunedDirs > 0, 'the budget genuinely forced pruning');
    assert.ok(pruned.nodes <= 20, 'the node budget is respected');
    assert.equal(pruned.root.size, full.root.size, 'a pruned tree still reports the true total');
    assert.equal(pruned.root.size, root.totalSize);

    // Invariant 1: a directory carries all of its children, or none of them.
    const check = (node: FileNode): void => {
      assert.ok(!(node.children && node.pruned), 'a node is never both expanded and pruned');
      for (const child of node.children ?? []) check(child);
    };
    check(pruned.root);

    // Invariant 2: a withheld directory still reports its real size.
    const withheld = (pruned.root.children ?? []).find((c) => c.pruned);
    if (withheld) {
      const truth = (full.root.children ?? []).find((c) => c.path === withheld.path)!;
      assert.equal(withheld.size, truth.size, 'drilling in must not change the number just read');
    }
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a subtree can be read on its own, rooted where asked', async () => {
  const dir = await mkTmp();
  try {
    await fsp.mkdir(path.join(dir, 'branch'));
    await fsp.writeFile(path.join(dir, 'branch', 'inner.bin'), Buffer.alloc(2500));
    await fsp.writeFile(path.join(dir, 'other.bin'), Buffer.alloc(100));
    await buildIndex(dir, { live: false });

    const sub = readTree(dir, path.join(dir, 'branch'))!;
    assert.equal(sub.root.name, 'branch');
    assert.equal(sub.root.size, 2500);
    assert.equal(sub.root.children!.length, 1);
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════════ Root resolution and deletion ══════════════════════ */

test('the deepest indexed root wins when several contain a path', async () => {
  const outer = await mkTmp();
  try {
    const inner = path.join(outer, 'inner');
    await fsp.mkdir(inner);
    await fsp.writeFile(path.join(inner, 'f.bin'), Buffer.alloc(200));
    await buildIndex(outer, { live: false });
    await buildIndex(inner, { live: false });

    const chosen = rootFor(path.join(inner, 'f.bin'));
    assert.equal(chosen!.path, inner, 'the smaller, more specific index serves the path');
    assert.equal(rootFor(path.join(outer, 'elsewhere'))!.path, outer);
    assert.equal(rootFor('/somewhere/else/entirely'), null);
  } finally {
    deleteIndex();
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('a sibling folder sharing a name prefix is not mistaken for a child', async () => {
  // "/data/app" must not be treated as containing "/data/application".
  const base = await mkTmp();
  try {
    const app = path.join(base, 'app');
    const application = path.join(base, 'application');
    await fsp.mkdir(app);
    await fsp.mkdir(application);
    await fsp.writeFile(path.join(application, 'f.bin'), Buffer.alloc(100));
    await buildIndex(app, { live: false });

    assert.equal(rootFor(path.join(application, 'f.bin')), null, 'a name prefix is not a path prefix');
  } finally {
    deleteIndex();
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('deleting the index removes every root and its rows', async () => {
  const dir = await mkTmp();
  try {
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(100));
    await buildIndex(dir, { live: false });
    assert.equal(listRoots().length, 1);

    assert.equal(deleteIndex(), 1, 'it reports how many roots it dropped');
    assert.deepEqual(listRoots(), []);

    const db = openIndex();
    const leftover = db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number };
    assert.equal(leftover.c, 0, 'no orphaned node rows survive');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('deleting an index actually returns the disk space, not just the rows', async () => {
  // SQLite frees pages for reuse without shrinking the file. Dropping a large
  // index therefore left the database exactly as big as before — a "delete my
  // index" button that visibly does nothing.
  const dir = await mkTmp();
  try {
    for (let i = 0; i < 40; i++) {
      await fsp.mkdir(path.join(dir, `d${String(i)}`));
      for (let j = 0; j < 60; j++) {
        await fsp.writeFile(path.join(dir, `d${String(i)}`, `some-reasonably-long-filename-${String(j)}.bin`), 'x');
      }
    }
    await buildIndex(dir, { live: false });

    const sizeOf = (): number => {
      let total = 0;
      for (const suffix of ['', '-wal']) {
        try {
          total += fs.statSync(indexDbPath() + suffix).size;
        } catch {
          /* absent */
        }
      }
      return total;
    };
    const before = sizeOf();
    assert.ok(before > 200_000, `the index should be substantial first (was ${String(before)} bytes)`);

    deleteIndex();
    const after = sizeOf();
    assert.ok(after < before / 2, `deleting should shrink the file: ${String(before)} → ${String(after)} bytes`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('reading a folder that was never indexed answers null, not an empty tree', async () => {
  // An empty tree would render as "this folder has nothing in it", which is a
  // different — and wrong — statement from "this folder is not indexed".
  assert.equal(readTree('/definitely/not/indexed'), null);
  assert.equal(getRoot('/definitely/not/indexed'), null);
});

test('applying an empty change queue is a no-op, not an error', async () => {
  assert.equal(await applyPendingChanges('/not/watched'), 0);
});

/* ══════════════════ readTree scales sub-quadratically ══════════════════ */

test('reading a tree stays sub-quadratic as directory count grows', async (t) => {
  /**
   * The bug this pins, found by measuring a real ~/Library rather than a
   * fixture: `readTree` picked the next directory to expand with
   * `frontier.sort(); frontier.shift()`. Correct, but it re-sorted every
   * pending directory on every iteration — ~10^9 comparisons on a root with
   * 47k directories, and **8.5 seconds** to read back 224k nodes. The index
   * exists to make reopening instant; that made it slower than scanning.
   *
   * Asserting "under N milliseconds" would measure the CI runner, not the
   * code, and so did the CPU-time ratio that replaced it (400 → 6400
   * directories, 12–21x for the heap, 44–55x for sort-and-shift, a 30x
   * ceiling between them — CI once read 13.4x where an idle machine read
   * 3.9x). So this counts the work itself: every read of a child row's
   * `size`, which is what the frontier compares. A heap reads at most four
   * sizes per level of the heap for a pop, two per level for a push, and a
   * node reads its own size at most twice (its size, and a file's allocated
   * size beside it) — so the count stays under
   * `2·rows + 6·dirs·⌈log2(dirs + 1)⌉` at every size. Sort-and-shift re-reads
   * the whole frontier on every pop, dirs² reads: 41 million at 6400
   * directories against a bound of about half a million.
   */
  const build = async (dirs: number): Promise<string> => {
    const root = await mkTmp();
    for (let i = 0; i < dirs; i++) {
      const d = path.join(root, `d${String(i).padStart(5, '0')}`);
      await fsp.mkdir(d, { recursive: true });
      // Varying sizes so the biggest-first ordering has real work to do.
      await fsp.writeFile(path.join(d, 'f.bin'), Buffer.alloc(((i * 37) % 512) + 1));
    }
    // live: false — this test only reads trees back, and the default live
    // watcher turned the fixture teardown into a burst of change events
    // whose flush could straddle the suite's closeIndex (Windows CI caught
    // the resulting closed-handle rejection; the engine now also guards it).
    await buildIndex(root, { live: false });
    return root;
  };

  const counts: string[] = [];
  for (const dirs of [400, 6400]) {
    const root = await build(dirs);
    try {
      const { result: tree, rows, sizeReads } = childReadsDuring(() => readTree(root)!);
      assert.equal(tree.nodes, 1 + 2 * dirs, 'the whole tree came back: the root, each folder and its one file');
      assert.equal(rows, 2 * dirs, 'every row below the root read once');
      const bound = 2 * rows + 6 * dirs * Math.ceil(Math.log2(dirs + 1));
      counts.push(`${String(dirs)} dirs: ${String(sizeReads)} size reads (bound ${String(bound)})`);
      assert.ok(
        sizeReads <= bound,
        `${String(dirs)} directories cost ${String(sizeReads)} reads of a row's size, over the heap's ${String(bound)} — that curve is quadratic again`,
      );
      if (dirs === 6400) {
        // And the ordering the heap exists to provide is still biggest-first.
        const sizes = (tree.root.children ?? []).map((c) => c.size);
        assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a), 'children come back biggest-first');
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }
  t.diagnostic(counts.join(' · '));
});

test('a withheld directory is never fetched, only counted past the budget', async () => {
  // readTree withholds a directory whole when its children do not fit the
  // remaining budget — but it used to fetch every one of those children first
  // and then throw them all away. Measured on a real 1,013,072-node index with
  // a 25,000-node budget: 275,876 rows read to keep 25,000, and 427ms of a
  // synchronous, event-loop-blocking read on the one path whose whole purpose
  // is to feel instant.
  //
  // Asserted as a ROW COUNT, not a duration: rows read is the machine-
  // independent invariant, and this repo's wall-clock policy is that timings
  // belong in the notes, not in assertions.
  const dir = await mkTmp();
  try {
    // One small directory that will fit, and one fat one that cannot.
    await fsp.mkdir(path.join(dir, 'small'));
    await fsp.writeFile(path.join(dir, 'small', 'a.bin'), Buffer.alloc(9000));
    await fsp.mkdir(path.join(dir, 'fat'));
    for (let i = 0; i < 400; i++) {
      await fsp.writeFile(path.join(dir, 'fat', `f${i}.bin`), Buffer.alloc(8));
    }
    // live: false, as every test here that reads no live change. A watcher
    // left attached outlives the test: on macOS it is one more watch that
    // every later attach and close in this file interrupts (watchRegistry.ts).
    await buildIndex(dir, { live: false });

    const Database = (await import('better-sqlite3')).default;
    const proto = Database.prototype as unknown as { prepare: (sql: string) => unknown };
    const original = proto.prepare;
    let rowsRead = 0;
    proto.prepare = function patched(this: unknown, sql: string) {
      const stmt = original.call(this, sql) as { all: (...a: unknown[]) => unknown[] };
      if (/parent_id = \? ORDER BY size DESC/.test(sql)) {
        const inner = stmt.all.bind(stmt);
        stmt.all = (...a: unknown[]) => { const r = inner(...a); rowsRead += r.length; return r; };
      }
      return stmt;
    } as typeof original;

    let tree;
    try {
      // Room for the two directories and a little more, but nowhere near 400.
      tree = readTree(dir, dir, 6);
    } finally {
      proto.prepare = original;
    }

    assert.ok(tree, 'a tree is returned');
    assert.ok(tree.prunedDirs >= 1, 'the fat directory is withheld');
    assert.ok(
      rowsRead < 100,
      `a withheld directory must not be read in full: ${rowsRead} rows read for a 6-node budget`,
    );

    // Equivalence: withholding is still whole-directory, and the withheld one
    // is marked so the client knows to ask for it rather than call it empty.
    const fat = tree.root.children?.find((c) => c.name === 'fat');
    assert.ok(fat, 'the fat directory is still present');
    assert.equal(fat.pruned, true, 'and marked as withheld');
    assert.equal(fat.children, undefined, 'with no partial listing');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the index carries the seek paths readTree and the allocation report need', async () => {
  const dir = await mkTmp();
  try {
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(1024));
    await buildIndex(dir, { live: false }); // no watcher to outlive the test — see the one above
    const { openIndex } = await import('../src/services/indexEngine');
    const handle = openIndex();
    const plan = (sql: string, ...params: number[]): string =>
      (handle.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params) as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');

    // Reading one directory, biggest child first — without this the walk
    // builds a temp B-tree per directory, ~29,000 of them on a real index.
    const children = plan('SELECT * FROM nodes WHERE parent_id = ? ORDER BY size DESC LIMIT ?', 1, 10);
    assert.match(children, /idx_nodes_child_size/, `children read must be index-ordered: ${children}`);
    assert.ok(!/TEMP B-TREE/.test(children), `and must not sort: ${children}`);

    // Counting hard-link families: only the few multi-linked rows can match,
    // so a partial index answers it without touching the other million.
    const families = plan(
      'SELECT ino, COUNT(*) c FROM nodes WHERE root_id = ? AND is_dir = 0 AND nlink > 1 GROUP BY ino',
      1,
    );
    assert.match(families, /idx_nodes_family/, `family counting must use the partial index: ${families}`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════════ The watcher's boolean means something ══════════════════════ */

test('startWatcher reports false when no watch could be established', async () => {
  // `startWatcher` promises "a watch attached", and `POST /api/index/watch`
  // and the Live toggle both render that answer. It used to be incapable of
  // saying no: `subscribeToChanges` caught its own failure and returned a
  // no-op unsubscribe, so a permission error, an unsupported filesystem or a
  // descriptor limit all came back as `true` with nothing being watched — an
  // index that quietly never updated, under a control reading "Live".
  const dir = await mkTmp();
  try {
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(100));
    await buildIndex(dir, { live: false });
    assert.equal(startWatcher(dir), true, 'a watchable directory attaches');
    stopWatcher(dir);

    // A path that cannot be watched because it is not there.
    const gone = path.join(dir, 'never-existed');
    assert.equal(startWatcher(gone), false, 'an unwatchable path reports false, not true');
  } finally {
    stopWatcher(dir);
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a failed watch leaves no entry behind to be "stopped" later', async () => {
  const dir = await mkTmp();
  try {
    const gone = path.join(dir, 'never-existed');
    assert.equal(startWatcher(gone), false);
    // The bookkeeping must agree with the answer: a second attempt has to be
    // able to try again rather than short-circuit on a registered no-op.
    assert.equal(startWatcher(gone), false, 'it is not remembered as attached');
    stopWatcher(gone); // must not throw
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
