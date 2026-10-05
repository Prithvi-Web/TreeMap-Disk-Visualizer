import { test, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-indexCapAside-data-');

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { holdIndexBuildsForTests } from '../src/api/indexRoutes';
import { setSharedStreamForTests, setWatchImplForTests, watchPath } from '../src/platform/watchRegistry';
import {
  IndexCapReached,
  buildIndex,
  capStopFor,
  closeIndex,
  deleteIndex,
  getRoot,
  listRoots,
  openIndex,
  reclaimsSettled,
  searchIndex,
  setBuildSeamsForTests,
  stopAllWatchers,
  stopWatcher,
  type BuildProgress,
  type IndexedRoot,
} from '../src/services/indexEngine';

/**
 * A capped build never destroys the index it would replace, and a folder
 * whose build stopped at the cap is remembered (Track U review of U-1,
 * findings 1, 3, 6, 10 and 15).
 *
 * The automatic build the page starts after a scan carries `maxEntries`, and
 * the walk that builds the index counts what the scan's "don't scan"
 * patterns skip, so a folder the scan counted under the cap can walk past
 * it. Before this, the rebuild deleted the folder's saved index first and
 * then stopped at the cap, leaving nothing, and nothing remembered the stop,
 * so every later scan walked the same million entries and threw them away.
 * The owner's rule (plan U-Q4): a saved index is never deleted automatically.
 *
 * Every assertion counts rows, roots, requests or entries; nothing is timed.
 */

after(() => closeIndex());

/** A folder of `files` empty files (`files + 1` entries with the folder itself), with its real path. */
function fixture(files: number, prefix = 'f'): string {
  const dir = fs.realpathSync(fileTempDir('treemap-indexCapAside-tree-'));
  addFiles(dir, files, prefix);
  return dir;
}

function addFiles(dir: string, files: number, prefix: string): void {
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `${prefix}${String(i).padStart(3, '0')}.txt`), 'x');
}

type Row = { id: number; parent_id: number | null; name: string; is_dir: number; size: number; mtime: number; flags: number };
/** Every row of one root, in id order: what "exactly as it was" is compared on. */
function rowsOf(rootId: number): Row[] {
  return openIndex()
    .prepare('SELECT id, parent_id, name, is_dir, size, mtime, flags FROM nodes WHERE root_id = ? ORDER BY id')
    .all(rootId) as Row[];
}
const count = (sql: string, ...params: unknown[]): number => (openIndex().prepare(sql).get(...params) as { c: number }).c;

/* ══════════════════ the saved index survives a build that stops at its cap ══════════════════ */

test('a capped rebuild that stops at its cap leaves the saved index and every row of it exactly as they were', async () => {
  for (const restarted of [false, true]) {
    const dir = fixture(9); // 10 entries
    const saved = await buildIndex(dir, { live: false });
    if (restarted) {
      // What the page usually meets: every ready root is stale after a restart.
      closeIndex();
      openIndex();
    }
    const before = getRoot(dir)!;
    assert.equal(before.state, restarted ? 'stale' : 'ready');
    const rows = rowsOf(saved.id);
    assert.equal(rows.length, 10);
    const allRows = count('SELECT COUNT(*) c FROM nodes');
    const roots = listRoots();

    addFiles(dir, 20, 'g'); // the walk now counts 30: past a cap of 20
    await assert.rejects(buildIndex(dir, { live: false, maxEntries: 20 }), IndexCapReached);

    const label = restarted ? 'a stale saved index' : 'a ready saved index';
    assert.deepEqual(getRoot(dir), before, `${label}: the same root — id, state, date, counts and reason`);
    assert.deepEqual(rowsOf(saved.id), rows, `${label}: and every one of its rows`);
    assert.deepEqual(listRoots(), roots, `${label}: no root added or lost`);
    // What the stopped build wrote is out of sight at once and reclaimed in
    // slices behind it (Track U review M1); once that has settled, nothing is left.
    await reclaimsSettled();
    assert.equal(count('SELECT COUNT(*) c FROM nodes'), allRows, `${label}: nothing the stopped build wrote is left`);
    assert.equal(count('SELECT COUNT(*) c FROM roots'), roots.length, `${label}: nor its root`);
  }
});

test('a capped rebuild of a live index that stops at its cap leaves it live: its watcher never stopped', async () => {
  const dir = fixture(4);
  const saved = await buildIndex(dir); // watched
  try {
    assert.equal(saved.live, true, 'the saved index is current');
    addFiles(dir, 10, 'g');
    await assert.rejects(buildIndex(dir, { maxEntries: 8 }), IndexCapReached);
    const after = getRoot(dir)!;
    assert.equal(after.id, saved.id);
    assert.equal(after.state, 'ready', 'still ready');
    assert.equal(after.live, true, 'and still watched, so still current — nothing was taken from it');
  } finally {
    stopWatcher(dir);
  }
});

test('while a capped rebuild runs, every reader sees the saved index and never a row being written', async () => {
  // Six hundred files in a subfolder make the build write rows mid-walk:
  // it writes its files INDEX_BATCH_ROWS (500) at a time as the walk hands
  // them over (plan U-15), so by its 560th look at whether to stop it has
  // written some.
  const dir = fixture(6, 'q');
  fs.mkdirSync(path.join(dir, 'sub'));
  addFiles(path.join(dir, 'sub'), 600, 'q');
  const saved = await buildIndex(dir, { live: false });
  const savedHits = searchIndex('q0').total;
  assert.equal(savedHits, 106, 'the saved index holds six files here, and a hundred of sub\'s six hundred (q000 to q099)');
  const roots = listRoots();
  const known = new Set(roots.map((r) => r.id));
  const unlisted = (): number => (openIndex().prepare('SELECT root_id FROM nodes').all() as { root_id: number }[]).filter((r) => !known.has(r.root_id)).length;

  let polls = 0;
  let looked = false;
  const built = await buildIndex(dir, {
    live: false,
    maxEntries: 1000,
    isCancelled: () => {
      if (++polls !== 560) return false;
      // Mid-walk, with rows of the new build already written.
      looked = true;
      assert.equal(count('SELECT COUNT(*) c FROM roots'), roots.length + 1, 'the build writes under a root of its own');
      assert.ok(unlisted() > 0, 'and has written rows under it');
      assert.deepEqual(listRoots(), roots, 'listRoots names the saved roots only');
      assert.equal(getRoot(dir)?.id, saved.id, 'getRoot answers with the saved root');
      assert.equal(getRoot(dir)?.state, 'ready');
      const found = searchIndex('q0');
      assert.equal(found.total, savedHits, 'search finds what the saved index holds, and no row twice');
      assert.ok(found.hits.every((h) => h.path.startsWith(dir + path.sep)), `every hit is a real path under the folder: ${found.hits.map((h) => h.path).join(', ')}`);
      return false;
    },
  });
  assert.equal(looked, true, 'the walk was looked at in the middle');
  assert.notEqual(built.id, saved.id, 'the finished build replaced the saved root');
  assert.equal(getRoot(dir)!.id, built.id);
  // The saved rows are reclaimed in slices behind the swap (Track U review M1).
  await reclaimsSettled();
  assert.equal(count('SELECT COUNT(*) c FROM nodes WHERE root_id = ?', saved.id), 0, 'and the saved rows went with it');
  assert.equal(count('SELECT COUNT(*) c FROM roots'), roots.length, 'one root at the folder, as before');
  assert.equal(searchIndex('q0').total, savedHits, 'search finds the same files once');
});

test('a crash in the middle of a capped rebuild leaves the saved index', async () => {
  const dir = fixture(6);
  fs.mkdirSync(path.join(dir, 'sub'));
  addFiles(path.join(dir, 'sub'), 600, 'f');
  const saved = await buildIndex(dir, { live: false });
  const rows = rowsOf(saved.id);
  const roots = count('SELECT COUNT(*) c FROM roots');
  const savedIds = new Set((openIndex().prepare('SELECT id FROM roots').all() as { id: number }[]).map((r) => r.id));
  let polls = 0;
  let writtenAtCrash = 0;
  // Closing the database mid-walk is what a killed process leaves behind:
  // the new build's root 'building' and some of its rows written (it writes
  // 500 files at a time, so by the 560th look it has).
  const crashed = buildIndex(dir, {
    live: false,
    maxEntries: 1000,
    isCancelled: () => {
      if (++polls === 560) {
        writtenAtCrash = (openIndex().prepare('SELECT root_id FROM nodes').all() as { root_id: number }[]).filter((r) => !savedIds.has(r.root_id)).length;
        closeIndex();
      }
      return false;
    },
  });
  await assert.rejects(crashed);
  assert.ok(writtenAtCrash > 0, `the crash came with some of the build's rows written (${String(writtenAtCrash)})`);
  openIndex(); // the next start
  const after = getRoot(dir);
  assert.ok(after, 'the saved index is still the folder\'s');
  assert.equal(after.id, saved.id);
  assert.equal(after.state, 'stale', 'stale, as every index is after a restart');
  assert.deepEqual(rowsOf(saved.id), rows, 'with every row');
  assert.deepEqual(listRoots().map((r) => r.id).filter((id) => !savedIds.has(id)), [], 'the half-written build is out of sight at once');
  // Its rows are reclaimed in slices behind the open (Track U review M1).
  await reclaimsSettled();
  assert.equal(count("SELECT COUNT(*) c FROM roots WHERE state = 'building'"), 0, 'the half-written build was discarded');
  assert.equal(count('SELECT COUNT(*) c FROM roots'), roots, 'no root added or lost');
  assert.equal(count('SELECT COUNT(*) c FROM nodes WHERE root_id NOT IN (SELECT id FROM roots)'), 0, 'and none of its rows is left');
});

test('a build stopped at its cap walked one entry past it and no further (finding 10: counted, not only the end state)', async () => {
  const dir = fixture(130); // 131 entries
  const progress: BuildProgress[] = [];
  let polled = 0;
  await assert.rejects(
    buildIndex(dir, { live: false, maxEntries: 50, onProgress: (p) => progress.push(p), isCancelled: () => { polled++; return false; } }),
    { message: 'Stopped at 50 items: more than TreeMap indexes on its own.' },
  );
  assert.deepEqual(progress.at(-1), { phase: 'error', processed: 50, currentPath: dir }, 'fifty entries written, not 131');
  // The walk asks whether to stop before it hands over each entry (and once
  // per wave): an enumerator that kept going would be asked 131 times.
  assert.ok(polled >= 50 && polled <= 52, `the walk handed over at most one entry past the cap (asked ${polled} times)`);
  assert.equal(getRoot(dir), null, 'there was no saved index, and none is made');
  await reclaimsSettled(); // what it wrote is reclaimed behind it (Track U review M1)
  assert.equal(count("SELECT COUNT(*) c FROM roots WHERE state = 'building'"), 0);
});

/* ══════════════════ the routes: the stop has its own answer, and is remembered ══════════════════ */

async function listen(): Promise<{ base: string; close: () => Promise<void> }> {
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function call(base: string, method: string, url: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  resetRateLimiter();
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Polls a job's result until it is not 202; the bound is a hang guard, never a measurement. */
async function settle(base: string, jobId: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  let settled: { status: number; json: Record<string, unknown> } | undefined;
  await waitFor(async () => {
    const r = await call(base, 'GET', `/api/index/${String(jobId)}/result`);
    if (r.status === 202) return false;
    settled = r;
    return true;
  }, `index job ${String(jobId)} settling`, 20);
  return settled ?? assert.fail(`index job ${String(jobId)} never settled`);
}

const statusOf = (base: string, dir: string) => call(base, 'GET', '/api/index/status?path=' + encodeURIComponent(dir));

test('/result answers a build stopped at its cap 409 INDEX_CAP_REACHED with the sentence, a failure still 500, and the stream says which', async () => {
  const dir = fixture(30);
  const { base, close } = await listen();
  try {
    const started = await call(base, 'POST', '/api/index/build', { path: dir, maxEntries: 10 });
    const stopped = await settle(base, started.json.jobId);
    assert.equal(stopped.status, 409, 'not a server failure: the folder is larger than TreeMap indexes on its own');
    assert.deepEqual(stopped.json, { error: 'Stopped at 10 items: more than TreeMap indexes on its own.', code: 'INDEX_CAP_REACHED', maxEntries: 10 });

    const res = await fetch(`${base}/api/index/${String(started.json.jobId)}/progress`);
    const frame = JSON.parse((await res.text()).trim().replace(/^data: /, '')) as Record<string, unknown>;
    assert.deepEqual(frame, { type: 'error', message: 'Stopped at 10 items: more than TreeMap indexes on its own.', code: 'INDEX_CAP_REACHED', maxEntries: 10 },
      'the progress stream\'s last frame names the cap too, beside the sentence it always carried');

    const missing = path.join(dir, 'not-there');
    const failed = await settle(base, (await call(base, 'POST', '/api/index/build', { path: missing, maxEntries: 10 })).json.jobId);
    assert.equal(failed.status, 500, 'a build that failed is still a failure');
    assert.equal(failed.json.code, 'INDEX_BUILD_FAILED');
    await reclaimsSettled(); // reclaimed behind the job (Track U review M1)
    assert.equal(count("SELECT COUNT(*) c FROM roots WHERE state = 'building'"), 0, 'and nothing it began is left behind');
  } finally {
    await close();
  }
});

test('the cap is remembered: status?path= says so, across a restart, until a build of that folder completes or its index is deleted', async () => {
  const dir = fixture(30);
  const { base, close } = await listen();
  try {
    const fresh = await statusOf(base, dir);
    assert.deepEqual(Object.keys(fresh.json), ['path', 'indexed', 'root', 'running', 'autoBuild', 'stoppedAtCap'], 'one key more, at the end');
    assert.equal(fresh.json.stoppedAtCap, null, 'nothing stopped yet');

    await settle(base, (await call(base, 'POST', '/api/index/build', { path: dir, maxEntries: 10 })).json.jobId);
    const stopped = (await statusOf(base, dir)).json.stoppedAtCap as Record<string, unknown> | null;
    assert.ok(stopped, 'the stop is remembered for the folder');
    assert.equal(stopped.maxEntries, 10);
    assert.equal(stopped.reason, 'Stopped at 10 items: more than TreeMap indexes on its own.');
    assert.equal(typeof stopped.at, 'number');
    assert.equal((await statusOf(base, path.join(dir, 'f001.txt'))).json.stoppedAtCap, null, 'for exactly that folder, not what is inside it');

    closeIndex();
    openIndex();
    assert.deepEqual((await statusOf(base, dir)).json.stoppedAtCap, stopped, 'kept with the index, so a restart does not forget it');

    const full = await settle(base, (await call(base, 'POST', '/api/index/build', { path: dir })).json.jobId);
    assert.equal(full.status, 200, 'an explicit build is not capped');
    assert.equal((await statusOf(base, dir)).json.stoppedAtCap, null, 'and a completed build forgets the stop');

    await settle(base, (await call(base, 'POST', '/api/index/build', { path: dir, maxEntries: 10 })).json.jobId);
    assert.notEqual((await statusOf(base, dir)).json.stoppedAtCap, null, 'stopped again');
    assert.equal(getRoot(dir)!.fileCount, 30, 'and the full index built before it is still there');
    await call(base, 'DELETE', '/api/index?path=' + encodeURIComponent(dir));
    assert.equal((await statusOf(base, dir)).json.stoppedAtCap, null, 'deleting the folder\'s index forgets it too');
  } finally {
    await close();
  }
});

test('of two stops the larger cap is kept: a walk past twenty entries is past five as well', async () => {
  const dir = fixture(30);
  await assert.rejects(buildIndex(dir, { live: false, maxEntries: 20 }), IndexCapReached);
  await assert.rejects(buildIndex(dir, { live: false, maxEntries: 5 }), IndexCapReached);
  assert.equal(capStopFor(dir)?.maxEntries, 20, 'the stop at five does not make the page forget the stop at twenty');
  await assert.rejects(buildIndex(dir, { live: false, maxEntries: 25 }), IndexCapReached);
  assert.equal(capStopFor(dir)?.maxEntries, 25);
});

/* ══════════════════ a request never inherits another build's cap (finding 3) ══════════════════ */

test('an uncapped build that arrives while a capped build of the folder runs is not capped by it', async () => {
  const dir = fixture(30);
  const { base, close } = await listen();
  let release!: () => void;
  holdIndexBuildsForTests(new Promise<void>((resolve) => { release = resolve; }));
  try {
    const capped = await call(base, 'POST', '/api/index/build', { path: dir, maxEntries: 10 });
    const explicit = await call(base, 'POST', '/api/index/build', { path: dir });
    assert.equal(explicit.status, 202);
    assert.notEqual(explicit.json.jobId, capped.json.jobId, 'a job of its own, not the capped one');
    assert.equal(explicit.json.alreadyRunning, undefined);
    release();
    assert.equal((await settle(base, capped.json.jobId)).status, 409, 'the capped build stopped');
    const done = await settle(base, explicit.json.jobId);
    assert.equal(done.status, 200, 'the explicit one ran after it, uncapped');
    assert.equal((done.json.root as IndexedRoot).fileCount, 30);
    assert.equal(getRoot(dir)!.fileCount, 30);
  } finally {
    holdIndexBuildsForTests(null);
    await close();
  }
});

test('a request joins a running build whose cap is no tighter than its own, and is told that cap', async () => {
  const dir = fixture(5);
  const { base, close } = await listen();
  let release!: () => void;
  holdIndexBuildsForTests(new Promise<void>((resolve) => { release = resolve; }));
  try {
    const first = await call(base, 'POST', '/api/index/build', { path: dir, maxEntries: 1000 });
    const tighter = await call(base, 'POST', '/api/index/build', { path: dir, maxEntries: 500 });
    assert.deepEqual(tighter.json, { jobId: first.json.jobId, status: 'running', alreadyRunning: true, maxEntries: 1000 });
    const looser = await call(base, 'POST', '/api/index/build', { path: dir, maxEntries: 2000 });
    assert.deepEqual(Object.keys(looser.json), ['jobId', 'status'], 'a looser cap is not joined to a tighter one: a job of its own');
    const between = await call(base, 'POST', '/api/index/build', { path: dir, maxEntries: 1500 });
    assert.deepEqual(between.json, { jobId: looser.json.jobId, status: 'running', alreadyRunning: true, maxEntries: 2000 });
    // At most one job waits behind a running build of a folder (Track U
    // review L3c): a request the waiting job does not cover widens it, so
    // one walk answers both, instead of a second job queued behind it.
    const uncapped = await call(base, 'POST', '/api/index/build', { path: dir });
    assert.deepEqual(uncapped.json, { jobId: looser.json.jobId, status: 'running', alreadyRunning: true, maxEntries: null },
      'an uncapped request widens the job already waiting, and is told it now has no cap');
    const again = await call(base, 'POST', '/api/index/build', { path: dir });
    assert.deepEqual(again.json, { jobId: looser.json.jobId, status: 'running', alreadyRunning: true, maxEntries: null },
      'an uncapped build is joined by an uncapped one, and says it has no cap');
    const capped = await call(base, 'POST', '/api/index/build', { path: dir, maxEntries: 5000 });
    assert.equal(capped.json.jobId, looser.json.jobId, 'and so is any capped one');
    release();
    const a = await settle(base, first.json.jobId);
    const b = await settle(base, looser.json.jobId);
    assert.equal(a.status, 200);
    // The first build completed under its cap, so the folder fits every cap
    // after it: the job waiting takes its index rather than walk it again.
    assert.deepEqual(b.json, a.json, 'the build waiting on it adopts its index');
    assert.equal(count('SELECT COUNT(*) c FROM roots WHERE path = ?', dir), 1);
  } finally {
    holdIndexBuildsForTests(null);
    await close();
  }
});

/* ══════════════════ the swap: what it leaves when it fails, or when something throws after it (Track U review L1, L2, L7) ══════════════════ */

/** Every watch through a stand-in for fs.watch: nothing waits on the OS. */
function standInWatches(t: TestContext): void {
  class StandInWatch extends EventEmitter {
    close(): void {}
  }
  setWatchImplForTests(() => new StandInWatch());
  t.after(() => {
    stopAllWatchers();
    setWatchImplForTests(null);
    setSharedStreamForTests(null);
  });
}

/** A live root made stale by another watch attaching on a shared stream: watched, and with a reason of its own. */
function liveAndStale(t: TestContext, dir: string): void {
  setSharedStreamForTests(true);
  const lease = watchPath(fileTempDir('treemap-indexCapAside-other-'), { recursive: true, owner: 'test:other' }, () => {});
  t.after(() => lease.close());
  const root = getRoot(dir)!;
  assert.equal(root.state, 'stale');
  assert.match(root.staleReason ?? '', /another folder/);
  assert.equal(root.live, true);
}

/** Fails, in the index's own connection, every statement that sets a root 'ready': the swap's, and an explicit build's last. */
function failTheSwap(t: TestContext): void {
  openIndex().exec("CREATE TEMP TRIGGER fail_swap BEFORE UPDATE OF state ON roots WHEN NEW.state = 'ready' BEGIN SELECT RAISE(ABORT, 'injected: the swap failed'); END");
  t.after(() => { openIndex().exec('DROP TRIGGER IF EXISTS temp.fail_swap'); });
}

test('a swap that fails leaves the saved index exactly as it was: its rows, its watcher, and its reason for being stale', async (t) => {
  standInWatches(t);
  setSharedStreamForTests(false);
  const dir = fixture(6);
  fs.mkdirSync(path.join(dir, 'sub'));
  addFiles(path.join(dir, 'sub'), 600, 'f');
  await buildIndex(dir); // live
  liveAndStale(t, dir);
  const before = getRoot(dir)!;
  const rows = rowsOf(before.id);

  failTheSwap(t);
  await assert.rejects(buildIndex(dir, { maxEntries: 1000 }), { message: 'injected: the swap failed' });
  assert.deepEqual(getRoot(dir), before, 'the same root: id, state, counts, its watcher (live) and its reason for being stale');
  assert.deepEqual(rowsOf(before.id), rows, 'and every one of its rows');
  await reclaimsSettled();
  assert.equal(count("SELECT COUNT(*) c FROM roots WHERE state = 'building'"), 0, 'what the failed build wrote is discarded');
  assert.equal(count('SELECT COUNT(*) c FROM nodes WHERE root_id NOT IN (SELECT id FROM roots)'), 0);
});

test('an explicit rebuild that cannot begin leaves the saved index its watcher and its reason for being stale', async (t) => {
  standInWatches(t);
  setSharedStreamForTests(false);
  const dir = fixture(6);
  await buildIndex(dir); // live
  liveAndStale(t, dir);
  const before = getRoot(dir)!;
  // No room left for another build's ids: the first transaction fails.
  const handle = openIndex();
  const seq = (handle.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'nodes'").get() as { seq: number }).seq;
  handle.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'nodes'").run(Number.MAX_SAFE_INTEGER - 10);
  t.after(() => { openIndex().prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'nodes'").run(seq); });
  await assert.rejects(buildIndex(dir), /no room left/);
  assert.deepEqual(getRoot(dir), before, 'still watched, still stale for the reason it had');
});

test('a discard that fails is logged, the stop still answers with its own sentence, and the next build or a delete reclaims what it left', async (t) => {
  for (const retry of ['the next build', 'a delete'] as const) {
    await reclaimsSettled();
    const dir = fixture(6);
    fs.mkdirSync(path.join(dir, 'sub'));
    addFiles(path.join(dir, 'sub'), 600, 'f');
    const handle = openIndex();
    handle.exec("CREATE TEMP TRIGGER fail_discard BEFORE UPDATE OF path ON roots WHEN NEW.path LIKE 'building-aside:discard:%' BEGIN SELECT RAISE(ABORT, 'injected: the discard failed'); END");
    const logged = t.mock.method(console, 'error', () => {});
    try {
      await assert.rejects(buildIndex(dir, { live: false, maxEntries: 550 }), IndexCapReached, `${retry}: the stop answers as a stop`);
    } finally {
      handle.exec('DROP TRIGGER IF EXISTS temp.fail_discard');
      logged.mock.restore();
    }
    assert.equal(logged.mock.callCount(), 1, `${retry}: the failed discard is logged`);
    assert.match(String(logged.mock.calls[0].arguments[0]), /could not be discarded/);
    const left = handle.prepare("SELECT id FROM roots WHERE state = 'building'").all() as { id: number }[];
    assert.equal(left.length, 1, `${retry}: the build's root is left building`);
    assert.ok(count('SELECT COUNT(*) c FROM nodes WHERE root_id = ?', left[0].id) >= 500, 'with the rows it wrote');
    assert.ok(!listRoots().some((r) => r.id === left[0].id), 'and out of every reader\'s sight');

    if (retry === 'the next build') await buildIndex(fixture(2), { live: false });
    else deleteIndex(fixture(2)); // a folder with no index: the delete still reclaims what was left
    await reclaimsSettled();
    assert.equal(count('SELECT COUNT(*) c FROM roots WHERE id = ?', left[0].id), 0, `${retry} reclaims what the failed discard left`);
    assert.equal(count('SELECT COUNT(*) c FROM nodes WHERE root_id = ?', left[0].id), 0);
  }
});

test('a throw after the swap has committed leaves the build swapped in: the index is the folder\'s, and nothing undoes it', async () => {
  for (const capped of [true, false]) {
    const label = capped ? 'a capped build' : 'an explicit build';
    const dir = fixture(8);
    const saved = await buildIndex(dir, { live: false });
    const thrown = new Error('the caller\'s own progress handler threw');
    await assert.rejects(
      buildIndex(dir, {
        live: false,
        ...(capped ? { maxEntries: 100 } : {}),
        onProgress: (p) => { if (p.phase === 'done') throw thrown; },
      }),
      thrown,
    );
    const now = getRoot(dir);
    assert.ok(now, `${label}: the folder still has an index`);
    assert.notEqual(now.id, saved.id, `${label}: the one swapped in`);
    assert.equal(now.state, 'ready', `${label}: ready, not failed`);
    await reclaimsSettled();
    assert.equal(count('SELECT COUNT(*) c FROM nodes WHERE root_id = ?', now.id), 9, `${label}: with every row`);
  }
});

/* ══════════════════ a cancelled build, and a delete while a build runs (Track U review L3, L6) ══════════════════ */

test('a request never joins a build that was cancelled: it gets a job of its own, and that one builds', async () => {
  const dir = fixture(5);
  const { base, close } = await listen();
  let release!: () => void;
  holdIndexBuildsForTests(new Promise<void>((resolve) => { release = resolve; }));
  try {
    const first = await call(base, 'POST', '/api/index/build', { path: dir, maxEntries: 1000 });
    await call(base, 'POST', `/api/index/${String(first.json.jobId)}/cancel`);
    const second = await call(base, 'POST', '/api/index/build', { path: dir, maxEntries: 1000 });
    assert.notEqual(second.json.jobId, first.json.jobId, 'not the cancelled job');
    assert.equal(second.json.alreadyRunning, undefined);
    release();
    const cancelled = await settle(base, first.json.jobId);
    assert.equal(cancelled.json.error, 'cancelled');
    const built = await settle(base, second.json.jobId);
    assert.equal(built.status, 200, 'the request is answered with an index');
    assert.equal((built.json.root as IndexedRoot).fileCount, 5);
  } finally {
    holdIndexBuildsForTests(null);
    await close();
  }
});

/** Holds every build after its write numbered `at`; `held()` says whether one is held. */
function holdAfterWrite(t: TestContext, at: number): { held: () => boolean; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  setBuildSeamsForTests({ afterWrite: (n) => { if (n !== at) return undefined; held = true; return gate; } });
  t.after(() => { release(); setBuildSeamsForTests(null); });
  return { held: () => held, release: () => release() };
}

test('removing a folder\'s index while a build of it runs or waits stops that build: the index stays removed', async (t) => {
  // Six files beside `sub` and six hundred in it: its writes are 500 files,
  // then 106, then its two folders — the last, after which comes the swap.
  for (const heldAt of [1, 3]) {
    const dir = fixture(6);
    fs.mkdirSync(path.join(dir, 'sub'));
    addFiles(path.join(dir, 'sub'), 600, 'f');
    await buildIndex(dir, { live: false });
    const { base, close } = await listen();
    const hold = holdAfterWrite(t, heldAt);
    try {
      const capped = await call(base, 'POST', '/api/index/build', { path: dir, maxEntries: 1000 });
      await waitFor(hold.held, `the capped build being held after write ${String(heldAt)}`);
      const queued = await call(base, 'POST', '/api/index/build', { path: dir }); // uncapped: waits behind it
      assert.notEqual(queued.json.jobId, capped.json.jobId);
      const removed = await call(base, 'DELETE', '/api/index?path=' + encodeURIComponent(dir));
      assert.deepEqual(removed.json, { removed: 1, path: dir });
      hold.release();
      for (const job of [capped, queued]) {
        const settled = await settle(base, job.json.jobId);
        assert.equal(settled.json.error, 'cancelled', `held after write ${String(heldAt)}: the build ${job === capped ? 'running' : 'waiting'} is cancelled`);
      }
      assert.equal((await statusOf(base, dir)).json.indexed, false, `held after write ${String(heldAt)}: the index stays removed`);
      assert.equal(getRoot(dir), null);
      await reclaimsSettled();
      assert.equal(count("SELECT COUNT(*) c FROM roots WHERE state = 'building'"), 0, 'and nothing the stopped build wrote is left');
    } finally {
      hold.release();
      setBuildSeamsForTests(null);
      await close();
    }
  }
});

test('removing an index under a running build, by any caller, counts only the folders\' indexes and stops the build: nothing it wrote comes back', async (t) => {
  for (const whole of [false, true]) {
    const label = whole ? 'the whole index' : 'one folder\'s index';
    const dir = fixture(6);
    fs.mkdirSync(path.join(dir, 'sub'));
    addFiles(path.join(dir, 'sub'), 600, 'f');
    await buildIndex(dir, { live: false });
    const hold = holdAfterWrite(t, 1);
    const building = buildIndex(dir, { live: false, maxEntries: 1000 });
    building.catch(() => {}); // settled below
    await waitFor(hold.held, 'the capped build being held after its first write');
    const folders = listRoots().length;
    assert.equal(deleteIndex(whole ? undefined : dir), whole ? folders : 1, `${label}: the count names the folders' indexes, never a build written aside`);
    hold.release();
    await assert.rejects(building, { message: 'cancelled' }, `${label}: the build stops`);
    setBuildSeamsForTests(null);
    assert.equal(getRoot(dir), null, `${label}: and is not swapped in`);
    await reclaimsSettled();
    assert.equal(count("SELECT COUNT(*) c FROM roots WHERE state = 'building'"), 0, `${label}: nothing it wrote is left`);
    if (whole) assert.equal(count('SELECT COUNT(*) c FROM nodes'), 0);
  }
});

test('a job that has started building is never widened: a request it does not cover waits behind it in a job of its own', async (t) => {
  const dir = fixture(6);
  fs.mkdirSync(path.join(dir, 'sub'));
  addFiles(path.join(dir, 'sub'), 600, 'f');
  const { base, close } = await listen();
  const hold = holdAfterWrite(t, 1);
  try {
    const stops = await call(base, 'POST', '/api/index/build', { path: dir, maxEntries: 10 }); // stops at its cap before any write
    const next = await call(base, 'POST', '/api/index/build', { path: dir, maxEntries: 2000 }); // waits behind it, then builds
    assert.equal((await settle(base, stops.json.jobId)).status, 409);
    await waitFor(hold.held, 'the second build being held after its first write');
    const uncapped = await call(base, 'POST', '/api/index/build', { path: dir });
    assert.notEqual(uncapped.json.jobId, next.json.jobId, 'the running job keeps the cap it started with');
    assert.equal(uncapped.json.alreadyRunning, undefined);
    hold.release();
    const built = await settle(base, next.json.jobId);
    assert.equal(built.status, 200);
    assert.deepEqual((await settle(base, uncapped.json.jobId)).json, built.json, 'and the job behind it adopts its index');
  } finally {
    hold.release();
    setBuildSeamsForTests(null);
    await close();
  }
});
