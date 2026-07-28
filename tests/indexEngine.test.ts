import { test, before, after } from 'node:test';
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
  FLAG,
} from '../src/services/indexEngine';
import type { FileNode } from '../src/models/types';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mkTmp = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), 'tm-index-'));

/**
 * Wait for a condition the live watcher should bring about.
 *
 * The ceiling is deliberately far above the 2-second acceptance budget the
 * caller asserts against. Filesystem event delivery is scheduling-sensitive —
 * on a machine busy compiling, macOS has been observed to sit on an FSEvents
 * callback for several seconds — so a tight ceiling turns "slow today" into
 * "never happened", which is the least useful failure a CI log can contain.
 * Measuring past the budget lets the assertion report the real latency.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return Date.now() - started;
    await sleep(25);
  }
  return -1;
}

/** Assert a live update landed inside the acceptance budget, saying what it took. */
function assertLanded(elapsedMs: number, what: string, budgetMs = 2000): void {
  assert.notEqual(elapsedMs, -1, `${what} never landed in the index at all`);
  assert.ok(elapsedMs < budgetMs, `${what} took ${String(elapsedMs)}ms, budget is ${String(budgetMs)}ms`);
}

after(() => {
  stopAllWatchers();
  closeIndex();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
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

test('a sparse file is indexed by what it claims, and flagged by what it occupies', async () => {
  const dir = await mkTmp();
  try {
    const sparse = path.join(dir, 'sparse.bin');
    const fd = fs.openSync(sparse, 'w');
    fs.ftruncateSync(fd, 20 * 1024 * 1024);
    fs.closeSync(fd);

    const root = await buildIndex(dir, { live: false });
    const db = openIndex();
    const row = db.prepare('SELECT size, allocated, flags FROM nodes WHERE root_id = ? AND path = ?').get(root.id, sparse) as
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

/* ══════════════════════ Reopen speed (acceptance) ══════════════════════ */

test('reopening an indexed folder answers in well under 200ms', async () => {
  // §A1 acceptance: "Second and later opens of an indexed folder render in
  // under 200ms with no scan spinner."
  const dir = await mkTmp();
  try {
    for (let i = 0; i < 40; i++) {
      await fsp.mkdir(path.join(dir, `d${String(i)}`));
      for (let j = 0; j < 25; j++) {
        await fsp.writeFile(path.join(dir, `d${String(i)}`, `f${String(j)}.bin`), Buffer.alloc(512));
      }
    }
    await buildIndex(dir, { live: false });

    const started = Date.now();
    const tree = readTree(dir)!;
    const elapsed = Date.now() - started;

    assert.equal(tree.nodes, 1041, 'the whole tree came back: 1 root + 40 dirs + 1000 files');
    assert.ok(elapsed < 200, `reopen took ${String(elapsed)}ms, budget is 200ms`);
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════════ Live updates (acceptance) ══════════════════════ */

test('an external create, resize and delete each land within 2 seconds', async () => {
  // §A1 acceptance: "An external file create/delete/resize is reflected within
  // 2 seconds without a user-triggered rescan."
  const dir = await mkTmp();
  try {
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(1000));
    const root = await buildIndex(dir, { live: true });
    assert.equal(root.live, true, 'a live watcher is attached after building');

    const target = path.join(dir, 'new.bin');

    await fsp.writeFile(target, Buffer.alloc(5000));
    assertLanded(await waitFor(() => getRoot(dir)!.totalSize === 6000), 'an external create');

    await fsp.writeFile(target, Buffer.alloc(9000));
    assertLanded(await waitFor(() => getRoot(dir)!.totalSize === 10000), 'an external resize');

    await fsp.unlink(target);
    assertLanded(await waitFor(() => getRoot(dir)!.totalSize === 1000), 'an external delete');
  } finally {
    stopWatcher(dir);
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('deleting a folder removes its whole subtree from the index', async () => {
  const dir = await mkTmp();
  try {
    await fsp.mkdir(path.join(dir, 'doomed', 'inner'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'doomed', 'inner', 'f.bin'), Buffer.alloc(3000));
    await fsp.writeFile(path.join(dir, 'keep.bin'), Buffer.alloc(1000));
    const root = await buildIndex(dir, { live: true });
    assert.equal(root.totalSize, 4000);

    await fsp.rm(path.join(dir, 'doomed'), { recursive: true, force: true });
    const took = await waitFor(() => getRoot(dir)!.totalSize === 1000);
    assert.ok(took >= 0, 'the folder deletion was noticed');

    const db = openIndex();
    const orphans = db
      .prepare("SELECT COUNT(*) c FROM nodes WHERE root_id = ? AND path LIKE ?")
      .get(getRoot(dir)!.id, path.join(dir, 'doomed') + '%') as { c: number };
    assert.equal(orphans.c, 0, 'no descendant rows are left behind');
  } finally {
    stopWatcher(dir);
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a path containing LIKE wildcards is deleted precisely, not by pattern', async () => {
  // `_` and `%` are wildcards in SQL LIKE. A folder called "100%_backup" must
  // delete only itself — an unescaped pattern would take unrelated siblings.
  const dir = await mkTmp();
  try {
    await fsp.mkdir(path.join(dir, '100%_backup'));
    await fsp.writeFile(path.join(dir, '100%_backup', 'inside.bin'), Buffer.alloc(700));
    await fsp.mkdir(path.join(dir, '1002xbackup'));
    await fsp.writeFile(path.join(dir, '1002xbackup', 'survivor.bin'), Buffer.alloc(900));

    const root = await buildIndex(dir, { live: false });
    assert.equal(root.totalSize, 1600);

    startWatcher(dir);
    await fsp.rm(path.join(dir, '100%_backup'), { recursive: true, force: true });
    const took = await waitFor(() => getRoot(dir)!.totalSize === 900);
    assert.ok(took >= 0, 'the wildcard-named folder was removed');

    const db = openIndex();
    const survivor = db
      .prepare('SELECT COUNT(*) c FROM nodes WHERE root_id = ? AND path = ?')
      .get(getRoot(dir)!.id, path.join(dir, '1002xbackup', 'survivor.bin')) as { c: number };
    assert.equal(survivor.c, 1, 'the similarly-named sibling survived');
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
