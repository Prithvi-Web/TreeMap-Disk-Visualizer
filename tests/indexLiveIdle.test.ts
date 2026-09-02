import { test, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The live index at rest.
 *
 * Measured on the owner's machine (2 September 2026): TreeMap's main process
 * sat at 20–60% CPU eighteen minutes after its last scan finished, with the
 * window closed. `sample` put the time in `sqlite3_step` — a `SUM(is_dir)`
 * over every one of the 1.1 million node rows — and the index's own
 * write-ahead log ticked every second or two. The index lives in the app-data
 * directory, the app-data directory lives under the user's home, and the
 * user's home was the indexed root: every flush wrote the WAL, the watcher
 * saw the WAL change, queued it, flushed again 400 ms later, and each flush
 * re-counted the whole table. A perpetual loop, and the machine paid for it
 * whether or not anything else on it ever changed.
 *
 * So the app-data directory here is INSIDE the indexed root, exactly as it is
 * for a user who scans their home folder — and it has to be set before the
 * engine is imported, because `appDataDir()` reads the environment at call
 * time and the database is created inside it.
 */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-live-idle-'));
const DATA_DIR = path.join(ROOT, 'Library', 'Application Support', 'TreeMap');
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.TREEMAP_DATA_DIR = DATA_DIR;

/*
 * Every directory these tests write into exists BEFORE the index is built,
 * and that is a portability requirement, not tidiness. macOS gets a kernel
 * recursive watch (FSEvents); Linux has none, so the provider walks the tree
 * and adds an inotify watch per directory, attaching a watch to a NEW
 * directory only after an lstat resolves — which a file written into that
 * directory immediately afterwards can beat. Creating the skeleton up front
 * removes the race instead of testing around it: what these tests are about
 * is the flush's arithmetic, never how fast a platform notices a mkdir.
 */
for (const d of [['deep', 'er'], ['grove', 'a', 'b'], ['chain', 'b', 'c']]) {
  fs.mkdirSync(path.join(ROOT, ...d), { recursive: true });
}

import {
  buildIndex,
  getRoot,
  openIndex,
  closeIndex,
  deleteIndex,
  stopAllWatchers,
  watcherEventCount,
  findNodeIdByPath,
} from '../src/services/indexEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const WATCH_CEILING_MS = process.env.CI ? 30_000 : 15_000;

async function waitFor(predicate: () => boolean, timeoutMs = WATCH_CEILING_MS): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return Date.now() - started;
    await sleep(25);
  }
  return -1;
}

/** Same triage as indexEngine.test.ts: a watch that delivered nothing is a platform silence, not an index bug. */
function landed(elapsed: number, what: string, t: TestContext): boolean {
  if (elapsed !== -1) return true;
  const delivered = watcherEventCount(ROOT);
  if (delivered === 0) {
    t.skip(`the OS watch on ${ROOT} delivered no events in ${String(WATCH_CEILING_MS)}ms, so "${what}" could not be observed`);
    return false;
  }
  assert.fail(`${what} never landed; the OS delivered ${String(delivered)} event(s) and none produced it`);
}

/** Every SQL text the engine prepares while `fn` runs — the flush's behaviour, as statements. */
async function statementsDuring(fn: () => Promise<void>): Promise<string[]> {
  const db = openIndex() as unknown as { prepare: (sql: string) => unknown };
  const seen: string[] = [];
  const orig = db.prepare;
  db.prepare = function (this: unknown, sql: string) {
    seen.push(sql.replace(/\s+/g, ' ').trim());
    return orig.call(this, sql);
  } as typeof db.prepare;
  try {
    await fn();
  } finally {
    db.prepare = orig;
  }
  return seen;
}

const writes = (sql: string[]): string[] => sql.filter((s) => /^(INSERT|UPDATE|DELETE|WITH RECURSIVE)/i.test(s));
/* An aggregate whose only predicate is the root: `… FROM nodes WHERE root_id = ?` walks every row of the root. A subtree count (`WHERE id IN (SELECT id FROM sub)`) or a per-directory sum (`WHERE parent_id = ?`) is bounded and fine. */
const wholeRootAggregates = (sql: string[]): string[] =>
  sql.filter((s) => /\b(SUM|COUNT)\([^)]*\)[^;]*FROM nodes WHERE root_id = \?\s*$/i.test(s));

function truth(rootId: number): { files: number; dirs: number; size: number } {
  const db = openIndex();
  const c = db.prepare('SELECT SUM(is_dir = 0) files, SUM(is_dir = 1) dirs FROM nodes WHERE root_id = ?').get(rootId) as { files: number; dirs: number };
  const s = db.prepare('SELECT size FROM nodes WHERE root_id = ? AND parent_id IS NULL').get(rootId) as { size: number };
  return { files: c.files, dirs: c.dirs, size: s.size };
}

function reported(): { files: number; dirs: number; size: number } {
  const r = getRoot(ROOT)!;
  return { files: r.fileCount, dirs: r.dirCount, size: r.totalSize };
}

after(() => {
  stopAllWatchers();
  closeIndex();
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('the live index never reacts to its own writes: nothing inside the app-data directory is a change', async (t) => {
  await fsp.writeFile(path.join(ROOT, 'outside.bin'), Buffer.alloc(1000));
  await fsp.writeFile(path.join(DATA_DIR, 'marker.txt'), Buffer.alloc(10));
  const root = await buildIndex(ROOT, { live: true });
  assert.equal(root.live, true, 'a live watcher is attached');

  // One legitimate external change, so the flush machinery is demonstrably
  // awake — and so the flush that applies it writes the WAL, which is the
  // first turn of the loop this test exists to forbid.
  await fsp.writeFile(path.join(ROOT, 'later.bin'), Buffer.alloc(5000));
  if (!landed(await waitFor(() => getRoot(ROOT)!.totalSize >= 6000), 'an external create', t)) return;
  // FSEvents may still deliver a coalesced event for the parent directory a
  // moment after the file's own; let that legitimate tail land before the
  // window opens. The loop this forbids runs for ever, so waiting costs it
  // nothing.
  await sleep(1500);

  // A file that lives in the app-data directory changes size. The index must
  // not care: it is the app's own state, and reacting to it is how the loop
  // sustains itself (index.db-wal is such a file).
  const rootId = getRoot(ROOT)!.id;
  const markerId = findNodeIdByPath(rootId, ROOT, path.join(DATA_DIR, 'marker.txt'));
  assert.ok(markerId !== null, 'the build itself indexes the app-data directory like any other');
  await fsp.writeFile(path.join(DATA_DIR, 'marker.txt'), Buffer.alloc(4000));

  // Now: silence. Nothing outside the app-data directory changes for well over
  // the 400 ms flush cadence. A healthy index issues no writes at all here.
  const sql = await statementsDuring(() => sleep(2500));
  const w = writes(sql);
  assert.deepEqual(w, [], `the index wrote ${String(w.length)} statement(s) while nothing outside its own data directory changed:\n  ${w.slice(0, 6).join('\n  ')}`);

  const size = (openIndex().prepare('SELECT size FROM nodes WHERE id = ?').get(markerId) as { size: number }).size;
  assert.equal(size, 10, 'the app-data file keeps its build-time size — it is deliberately not live');
});

test('a watcher flush re-sums the touched ancestors only, never the whole root', async (t) => {
  const root = getRoot(ROOT) ?? (await buildIndex(ROOT, { live: true }));
  assert.equal(root.live, true);
  const before = getRoot(ROOT)!.totalSize;

  const sql = await statementsDuring(async () => {
    await fsp.writeFile(path.join(ROOT, 'deep', 'er', 'leaf.bin'), Buffer.alloc(7000));
    if (!landed(await waitFor(() => getRoot(ROOT)!.totalSize === before + 7000), 'a deep external create', t)) return;
  });
  if (getRoot(ROOT)!.totalSize !== before + 7000) return; // skipped above

  const agg = wholeRootAggregates(sql);
  assert.deepEqual(agg, [], `a flush ran ${String(agg.length)} whole-root aggregate(s) — O(table) per burst on a million-row index:\n  ${agg.join('\n  ')}`);
  assert.ok(sql.some((s) => /SUM\(size\)[^;]*WHERE parent_id = \?/i.test(s)), 'the ancestors it touched are re-summed (the control: the flush did run its roll-up)');
  assert.deepEqual(reported(), truth(getRoot(ROOT)!.id), 'and the counts it reports are exact');
});

test('the root counts stay exact through creates, subtree deletes and a kind change', async (t) => {
  const root = getRoot(ROOT) ?? (await buildIndex(ROOT, { live: true }));
  assert.equal(root.live, true);
  const rootId = getRoot(ROOT)!.id;
  const check = (what: string): void => assert.deepEqual(reported(), truth(rootId), `after ${what}: reported counts must equal a fresh count of the rows`);

  await fsp.writeFile(path.join(ROOT, 'grove', 'a', 'b', 'one.bin'), Buffer.alloc(100));
  await fsp.writeFile(path.join(ROOT, 'grove', 'two.bin'), Buffer.alloc(200));
  if (!landed(await waitFor(() => findNodeIdByPath(rootId, ROOT, path.join(ROOT, 'grove', 'a', 'b', 'one.bin')) !== null && findNodeIdByPath(rootId, ROOT, path.join(ROOT, 'grove', 'two.bin')) !== null), 'a nested create', t)) return;
  await sleep(600); // let the burst that carried the last of them settle
  check('creates');

  await fsp.rm(path.join(ROOT, 'grove', 'a'), { recursive: true, force: true });
  if (!landed(await waitFor(() => findNodeIdByPath(rootId, ROOT, path.join(ROOT, 'grove', 'a')) === null), 'a subtree delete', t)) return;
  await sleep(600);
  check('a subtree delete');

  // A file replaced by a directory of the same name. The row cannot be
  // refreshed in place — a file with children, or a directory without them —
  // so the old one goes and a fresh one takes its place, moving the counts by
  // one in each direction. Asserted on the ROW's kind rather than on a child
  // inside the new directory: that child is the one thing an emulated
  // recursive watch is entitled to miss.
  const kindOf = (p: string): number | null => {
    const id = findNodeIdByPath(rootId, ROOT, p);
    if (id === null) return null;
    return (openIndex().prepare('SELECT is_dir FROM nodes WHERE id = ?').get(id) as { is_dir: number }).is_dir;
  };
  assert.equal(kindOf(path.join(ROOT, 'grove', 'two.bin')), 0, 'it starts life as a file');
  await fsp.rm(path.join(ROOT, 'grove', 'two.bin'));
  await fsp.mkdir(path.join(ROOT, 'grove', 'two.bin'));
  if (!landed(await waitFor(() => kindOf(path.join(ROOT, 'grove', 'two.bin')) === 1), 'a kind change', t)) return;
  await sleep(600);
  check('a kind change');

  // Parents the index has never heard of. The watcher can coalesce a
  // parent's event away or deliver the child's first, and `ensureParents`
  // then materialises the chain from disk. Every folder it creates that way
  // must move the count too. The chain is indexed normally first, then
  // forgotten — rows and counts alike — so the index is exactly as it would
  // be had the folders' own events never arrived.
  assert.notEqual(findNodeIdByPath(rootId, ROOT, path.join(ROOT, 'chain', 'b', 'c')), null, 'the chain was indexed at build time');
  const db = openIndex();
  const chainId = findNodeIdByPath(rootId, ROOT, path.join(ROOT, 'chain'));
  assert.ok(chainId !== null);
  const gone = db.prepare(`WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id) DELETE FROM nodes WHERE id IN (SELECT id FROM sub) RETURNING is_dir`).all(chainId) as { is_dir: number }[];
  db.prepare('UPDATE roots SET dir_count = dir_count - ?, file_count = file_count - ? WHERE id = ?').run(gone.filter((r) => r.is_dir).length, gone.filter((r) => !r.is_dir).length, rootId);
  check('forgetting the chain');
  await fsp.writeFile(path.join(ROOT, 'chain', 'b', 'c', 'leaf.bin'), Buffer.alloc(400));
  if (!landed(await waitFor(() => findNodeIdByPath(rootId, ROOT, path.join(ROOT, 'chain', 'b', 'c', 'leaf.bin')) !== null), 'a leaf under forgotten parents', t)) return;
  await sleep(600);
  assert.ok(findNodeIdByPath(rootId, ROOT, path.join(ROOT, 'chain')) !== null, 'the chain was materialised from disk');
  check('a leaf whose parents the index had to create');
  deleteIndex(ROOT);
});
