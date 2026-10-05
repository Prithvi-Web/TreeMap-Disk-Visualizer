import { test, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-indexReclaim-data-');

import {
  INDEX_RECLAIM_ROWS,
  IndexCapReached,
  buildIndex,
  closeIndex,
  deleteIndex,
  getRoot,
  indexDbPath,
  listRoots,
  openIndex,
  readTree,
  reclaimsSettled,
  rootFor,
  searchIndex,
  setBuildSeamsForTests,
  setReclaimSeamsForTests,
} from '../src/services/indexEngine';

/**
 * Replacing or discarding an index never deletes its rows in one statement
 * (Track U review of the index, finding M1 — the delete half of U-22).
 *
 * A DELETE of a root's rows is synchronous, and the server runs in
 * Electron's main process: measured with the real schema and its nine
 * indexes, 1,000,000 rows took 17.2 s (about 17 µs a row), so replacing a
 * 224,000-row index froze the window for about 3.8 s. After a restart every
 * saved index is stale, so the first scan of an indexed folder runs a capped
 * build whose swap did exactly that; a cancel, a build stopped at its cap,
 * a failure and the open after a crash did the same with the build's rows.
 *
 * Now a root that is no folder's index any more is taken out of every
 * reader's sight in one statement — its path moves into the range every
 * reader already leaves out — and its rows are reclaimed afterwards, at most
 * INDEX_RECLAIM_ROWS a statement, with a turn of the event loop before each.
 * A capped build never deletes the saved index before it is swapped in
 * (U-Q4); an explicit build replaces it up front, as it always has (U-D3):
 * its first transaction sets the saved root aside, and an explicit build
 * that is then cancelled or fails leaves the folder with no index.
 *
 * Every assertion counts rows, roots, slices or turns; nothing is timed.
 */

after(async () => {
  await reclaimsSettled();
  closeIndex();
});

function folder(prefix: string): string {
  return fs.realpathSync(fileTempDir(`treemap-indexReclaim-${prefix}-`));
}

function addFiles(dir: string, files: number, prefix = 'f'): void {
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `${prefix}${String(i).padStart(4, '0')}.txt`), 'x');
}

const count = (sql: string, ...params: unknown[]): number => (openIndex().prepare(sql).get(...params) as { c: number }).c;
const rowsUnder = (rootId: number): number => count('SELECT COUNT(*) c FROM nodes WHERE root_id = ?', rootId);
const rootRow = (rootId: number): { path: string; state: string } | undefined =>
  openIndex().prepare('SELECT path, state FROM roots WHERE id = ?').get(rootId) as { path: string; state: string } | undefined;

interface Slice {
  rootId: number;
  slice: number;
  rows: number;
  /** The setImmediate ticker's count when the slice ran. */
  tick: number;
}

/**
 * Sees every slice of every reclaim, and holds the first reclaim of `rootId`
 * (any root when absent) before its slice numbered `at` until released. A
 * setImmediate ticker counts turns of the event loop.
 */
function watchReclaims(t: TestContext, opts: { rootId?: () => number | undefined; at?: number; rows?: number } = {}) {
  let ticks = 0;
  let ticking = true;
  const tick = (): void => {
    ticks++;
    if (ticking) setImmediate(tick);
  };
  setImmediate(tick);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let heldFor: number | null = null;
  const slices: Slice[] = [];
  setReclaimSeamsForTests({
    ...(opts.rows === undefined ? {} : { rows: opts.rows }),
    beforeSlice: (rootId, slice) => {
      const wanted = opts.rootId?.();
      if (heldFor !== null || slice !== (opts.at ?? 1) || (wanted !== undefined && wanted !== rootId)) return undefined;
      heldFor = rootId;
      return gate;
    },
    afterSlice: (rootId, slice, rows) => { slices.push({ rootId, slice, rows, tick: ticks }); },
  });
  t.after(async () => {
    release();
    ticking = false;
    await reclaimsSettled();
    setReclaimSeamsForTests(null);
  });
  return {
    release: () => release(),
    held: (): number | null => heldFor,
    /** Waits until a reclaim is held. */
    whenHeld: () => waitFor(() => heldFor !== null, 'a reclaim being held before its slice'),
    slices: (rootId: number): Slice[] => slices.filter((s) => s.rootId === rootId),
    /** Every slice of every reclaim, in the order they ran. */
    all: (): Slice[] => [...slices],
  };
}

/** What every reader says about `dir`: the root it serves, and that `doomed` is in none of their answers. */
function readersSee(dir: string, doomed: number): number | null {
  const served = getRoot(dir);
  assert.ok(!listRoots().some((r) => r.id === doomed), 'listRoots never names a root whose rows are being reclaimed');
  assert.notEqual(served?.id, doomed, 'getRoot never answers with it');
  assert.notEqual(rootFor(path.join(dir, 'needle.txt'))?.id ?? null, doomed, 'nor rootFor');
  const hits = searchIndex('needle', { limit: 50 }).hits.filter((h) => h.rootPath === dir || h.path.startsWith('building-aside'));
  assert.ok(hits.every((h) => h.path === path.join(dir, 'needle.txt')), `search finds only real paths: ${hits.map((h) => h.path).join(', ')}`);
  assert.equal(hits.length, served ? 1 : 0, 'and the needle once, from the root served, or not at all');
  return served?.id ?? null;
}

/* ══════════════════ the swap: out of sight in one transaction, reclaimed in slices ══════════════════ */

test('a capped build swapped in takes the saved index out of sight in its one transaction, deleting no row, and reclaims the saved rows in slices of at most INDEX_RECLAIM_ROWS with a turn of the event loop before each', async (t) => {
  await reclaimsSettled();
  const files = 2 * INDEX_RECLAIM_ROWS + 199; // with needle.txt and the folder: 2 × INDEX_RECLAIM_ROWS + 201 rows
  const dir = folder('swap');
  addFiles(dir, files);
  fs.writeFileSync(path.join(dir, 'needle.txt'), 'x');
  const saved = await buildIndex(dir, { live: false });
  const savedRows = rowsUnder(saved.id);
  assert.equal(savedRows, files + 2);

  const watch = watchReclaims(t, { rootId: () => saved.id });
  const built = await buildIndex(dir, { live: false, maxEntries: files + 100 });
  // The swap has committed; its reclaim turns the event loop before its first slice, and is held there.
  assert.notEqual(built.id, saved.id, 'the build was swapped in');
  assert.equal(rowsUnder(saved.id), savedRows, 'and the swap deleted none of the saved rows');
  await watch.whenHeld();
  const aside = rootRow(saved.id) ?? assert.fail('the saved root\'s row is kept until its rows are gone');
  assert.ok(aside.path.startsWith('building-aside:'), `its path moved into the range every reader leaves out: ${aside.path}`);
  assert.equal(aside.state, 'building', 'and it reads as building, so an open after a crash reclaims the rest');
  assert.equal(readersSee(dir, saved.id), built.id, 'every reader serves the build swapped in');
  assert.equal(readTree(dir)!.root.children!.length, files + 1, 'which reads back whole');

  watch.release();
  await reclaimsSettled();
  const slices = watch.slices(saved.id);
  assert.deepEqual(slices.map((s) => s.rows), [INDEX_RECLAIM_ROWS, INDEX_RECLAIM_ROWS, 201],
    'ceil(rows / INDEX_RECLAIM_ROWS) slices, each at most INDEX_RECLAIM_ROWS, every row reclaimed once');
  for (let i = 1; i < slices.length; i++) {
    assert.ok(slices[i].tick > slices[i - 1].tick, `the event loop turned between slice ${i} and slice ${i + 1}`);
  }
  assert.equal(rowsUnder(saved.id), 0, 'every saved row is reclaimed');
  assert.equal(rootRow(saved.id), undefined, 'and its root row goes last, once nothing is under it');
  assert.equal(getRoot(dir)!.id, built.id);
  assert.equal(rowsUnder(built.id), files + 2, 'the build swapped in keeps every row');
});

test('an explicit rebuild takes the saved index out of sight in its first transaction and builds while the saved rows are reclaimed', async (t) => {
  await reclaimsSettled();
  const dir = folder('explicit');
  addFiles(dir, 300);
  fs.writeFileSync(path.join(dir, 'needle.txt'), 'x');
  const saved = await buildIndex(dir, { live: false });
  const savedRows = rowsUnder(saved.id);

  const watch = watchReclaims(t, { rootId: () => saved.id });
  const built = await buildIndex(dir, { live: false }); // runs to the end with the reclaim held
  assert.notEqual(built.id, saved.id);
  assert.equal(rowsUnder(saved.id), savedRows, 'the rebuild deleted none of the saved rows itself');
  await watch.whenHeld();
  assert.ok(rootRow(saved.id)!.path.startsWith('building-aside:'));
  assert.equal(readersSee(dir, saved.id), built.id);

  watch.release();
  await reclaimsSettled();
  assert.equal(watch.slices(saved.id).length, Math.ceil(savedRows / INDEX_RECLAIM_ROWS) + (savedRows % INDEX_RECLAIM_ROWS === 0 ? 1 : 0));
  assert.equal(rowsUnder(saved.id), 0);
  assert.equal(rootRow(saved.id), undefined);
});

/* ══════════════════ a build's own rows: a cap, a cancel, a failure ══════════════════ */

test('a build stopped at its cap, cancelled, or failed is out of sight at once, and its rows are reclaimed in slices, not deleted where it stopped', async (t) => {
  for (const how of ['cap', 'cancel', 'failure'] as const) {
    await reclaimsSettled();
    const dir = folder(how);
    fs.mkdirSync(path.join(dir, 'sub'));
    addFiles(path.join(dir, 'sub'), 1200);
    fs.writeFileSync(path.join(dir, 'needle.txt'), 'x');
    const watch = watchReclaims(t);
    let polls = 0;
    if (how === 'failure') {
      setBuildSeamsForTests({ afterWrite: (n) => { if (n === 2) throw new Error('injected: the disk went away'); } });
    }
    const building = buildIndex(dir, {
      live: false,
      ...(how === 'cancel' ? {} : { maxEntries: 1100 }),
      isCancelled: () => how === 'cancel' && ++polls >= 1100,
    });
    if (how === 'cap') await assert.rejects(building, IndexCapReached);
    else if (how === 'cancel') await assert.rejects(building, { message: 'cancelled' });
    else await assert.rejects(building, { message: 'injected: the disk went away' });
    setBuildSeamsForTests(null);

    const kept = openIndex()
      .prepare("SELECT id FROM roots WHERE path >= 'building-aside:' AND path < 'building-aside;' AND state = 'building'")
      .all() as { id: number }[];
    assert.equal(kept.length, 1, `${how}: the build's root is kept out of sight until its rows are reclaimed`);
    const doomed = kept[0].id;
    await watch.whenHeld();
    assert.equal(watch.held(), doomed, `${how}: and it is that root whose rows are being reclaimed`);
    assert.ok(rowsUnder(doomed) >= 500, `${how}: the build had written rows, and none was deleted where it stopped (${rowsUnder(doomed)})`);
    assert.ok(rootRow(doomed)!.path.startsWith('building-aside:'), `${how}: out of sight at once`);
    assert.equal(readersSee(dir, doomed), null, `${how}: no reader serves it`);
    if (how === 'cancel') {
      // The folder's own path was the cancelled build's; it is free at once.
      const again = await buildIndex(dir, { live: false });
      assert.equal(again.fileCount, 1201, 'a build of the same folder succeeds while the cancelled rows are reclaimed');
    }
    watch.release();
    await reclaimsSettled();
    assert.ok(watch.slices(doomed).length >= 1);
    assert.ok(watch.slices(doomed).every((s) => s.rows <= INDEX_RECLAIM_ROWS));
    assert.equal(rowsUnder(doomed), 0, `${how}: every row it wrote is reclaimed`);
    assert.equal(rootRow(doomed), undefined, `${how}: and its root`);
  }
});

/* ══════════════════ several reclaims at once (review of 5 Oct 2026, L-2) ══════════════════ */

test('several reclaims at once take turns in one queue: one slice an event-loop turn between them all, never one slice each in the same turn', async (t) => {
  await reclaimsSettled();
  const ids: number[] = [];
  for (const name of ['k1', 'k2', 'k3']) {
    const dir = folder(name);
    addFiles(dir, 250); // 251 rows with the folder: slices of 100, 100 and 51
    ids.push((await buildIndex(dir, { live: false })).id);
  }
  // What a crash leaves: three roots still building, reclaimed together by the next open.
  const mark = openIndex().prepare("UPDATE roots SET state = 'building' WHERE id = ?");
  for (const id of ids) mark.run(id);
  closeIndex();

  const watch = watchReclaims(t, { at: Number.MAX_SAFE_INTEGER, rows: 100 });
  openIndex();
  await reclaimsSettled();
  const slices = watch.all();
  for (const id of ids) assert.deepEqual(watch.slices(id).map((s) => s.rows), [100, 100, 51], `root ${String(id)} is reclaimed whole, in slices`);
  assert.equal(slices.length, 9);
  for (let i = 1; i < slices.length; i++) {
    assert.ok(slices[i].tick > slices[i - 1].tick,
      `the event loop turned between slice ${String(i)} (root ${String(slices[i - 1].rootId)}) and slice ${String(i + 1)} (root ${String(slices[i].rootId)}): ticks ${String(slices[i - 1].tick)} then ${String(slices[i].tick)}`);
  }
  for (const id of ids) assert.equal(rootRow(id), undefined);
});

/* ══════════════════ the open after a crash ══════════════════ */

test('opening an index with a build left mid-way deletes no row: the root is out of sight at once, a build of the folder succeeds meanwhile, and the rows are reclaimed in slices', async (t) => {
  await reclaimsSettled();
  const dir = folder('crash');
  addFiles(dir, 300);
  fs.writeFileSync(path.join(dir, 'needle.txt'), 'x');
  const left = await buildIndex(dir, { live: false });
  const rows = rowsUnder(left.id);
  // What a killed process leaves: the root still building.
  openIndex().prepare("UPDATE roots SET state = 'building' WHERE id = ?").run(left.id);
  closeIndex();

  const watch = watchReclaims(t, { rootId: () => left.id, rows: 100 });
  openIndex(); // the next start
  assert.equal(rowsUnder(left.id), rows, 'the open deleted none of its rows');
  assert.ok(rootRow(left.id)!.path.startsWith('building-aside:'), 'and took it out of sight');
  assert.equal(readersSee(dir, left.id), null);
  const again = await buildIndex(dir, { live: false });
  assert.equal(again.fileCount, 301, 'a build of the same folder succeeds while its rows are reclaimed');
  await watch.whenHeld();

  watch.release();
  await reclaimsSettled();
  assert.deepEqual(watch.slices(left.id).map((s) => s.rows), [100, 100, 100, 2], 'in slices of the size the seam set');
  assert.equal(rowsUnder(left.id), 0);
  assert.equal(rootRow(left.id), undefined);
});

test('a reclaim cut short by a close stops there, and the next open reclaims the rest', async (t) => {
  await reclaimsSettled();
  const dir = folder('cut');
  addFiles(dir, 300);
  const saved = await buildIndex(dir, { live: false });
  const savedRows = rowsUnder(saved.id); // 301

  const first = watchReclaims(t, { rootId: () => saved.id, at: 2, rows: 100 });
  await buildIndex(dir, { live: false, maxEntries: 1000 });
  assert.ok(rowsUnder(saved.id) > 0, 'the swap left the saved rows to be reclaimed');
  await first.whenHeld();
  assert.equal(rowsUnder(saved.id), savedRows - 100, 'one slice reclaimed before the close');
  const logged = t.mock.method(console, 'error', () => {});
  closeIndex();
  first.release();
  await reclaimsSettled();
  assert.deepEqual(first.slices(saved.id).map((s) => s.rows), [100], 'no slice ran on a closed index');
  assert.equal(logged.mock.callCount(), 0, 'and a close is not a failure: the reclaim stops without a word');
  logged.mock.restore();

  setReclaimSeamsForTests(null);
  const second = watchReclaims(t, { rootId: () => saved.id, at: 99, rows: 100 });
  openIndex();
  assert.equal(rowsUnder(saved.id), savedRows - 100, 'the open finds the rest, still out of sight');
  await reclaimsSettled();
  assert.deepEqual(second.slices(saved.id).map((s) => s.rows), [100, 100, 1], 'and reclaims it in slices');
  assert.equal(rootRow(saved.id), undefined);
});

test('a quit during a build — cancelled, then the index closed, as the server shuts down — ends it cancelled without a word, and the next open reclaims what it wrote (review L-3)', async (t) => {
  for (const capped of [true, false]) {
    const how = capped ? 'capped' : 'explicit';
    await reclaimsSettled();
    const dir = folder(`quit-${how}`);
    fs.mkdirSync(path.join(dir, 'sub'));
    addFiles(path.join(dir, 'sub'), 600);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    setBuildSeamsForTests({ afterWrite: (n) => { if (n !== 1) return undefined; held = true; return gate; } });
    t.after(() => { release(); setBuildSeamsForTests(null); });
    let cancelled = false;
    const building = buildIndex(dir, { live: false, isCancelled: () => cancelled, ...(capped ? { maxEntries: 5000 } : {}) });
    await waitFor(() => held, `the ${how} build being held after its first write`);
    const logged = t.mock.method(console, 'error', () => {});
    cancelled = true; // cancelAllIndexJobs()
    closeIndex(); // then closeIndex(), as server.ts shutdown() does
    release();
    await assert.rejects(building, { message: 'cancelled' }, `${how}: the build ends cancelled`);
    await reclaimsSettled();
    assert.equal(logged.mock.callCount(), 0, `${how}: a quit is not a failure, and logs nothing: ${logged.mock.calls.map((c) => String(c.arguments[0])).join(' | ')}`);
    logged.mock.restore();
    setBuildSeamsForTests(null);

    openIndex(); // the next start
    await reclaimsSettled();
    assert.equal(count("SELECT COUNT(*) c FROM roots WHERE state = 'building'"), 0, `${how}: the next open reclaims what the build wrote`);
    assert.equal(getRoot(dir), null, `${how}: and the folder has no index`);
  }
});

test('a build that starts while another is running leaves that one alone: only a root no build is writing is reclaimed', async (t) => {
  await reclaimsSettled();
  const held = folder('held');
  fs.mkdirSync(path.join(held, 'sub'));
  addFiles(path.join(held, 'sub'), 1200);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let isHeld = false;
  setBuildSeamsForTests({ afterWrite: (n) => { if (n !== 1) return undefined; isHeld = true; return gate; } });
  t.after(() => { release(); setBuildSeamsForTests(null); });
  const first = buildIndex(held, { live: false, maxEntries: 5000 });
  await waitFor(() => isHeld, 'the first build being held after its first write');
  setBuildSeamsForTests(null);

  const other = folder('other');
  addFiles(other, 3);
  await buildIndex(other, { live: false }); // starts — and looks for leftovers — while the first is held
  release();
  const built = await first;
  assert.equal(built.state, 'ready', 'the first build was not taken for a leftover');
  assert.equal(built.fileCount, 1200);
  await reclaimsSettled();
  assert.equal(rowsUnder(built.id), 1202, 'and keeps every row it wrote');
});

/* ══════════════════ another process on the same index (review of 5 Oct 2026, L-1) ══════════════════ */

/**
 * A second handle on the index file, writing as another TreeMap process
 * would (a development server beside the app): a root left 'building' at
 * `rootPath`, its top row and `rows - 1` files under it. Returns its id.
 */
function foreignBuild(other: Database.Database, rootPath: string, rows: number): number {
  const id = Number(other.prepare("INSERT INTO roots (path, state, mechanism) VALUES (?, 'building', 'readdir + lstat')").run(rootPath).lastInsertRowid);
  const insert = other.prepare('INSERT INTO nodes (root_id, parent_id, name, is_dir, size) VALUES (?, ?, ?, ?, 1)');
  other.transaction(() => {
    const top = Number(insert.run(id, null, 'top', 1).lastInsertRowid);
    for (let i = 1; i < rows; i++) insert.run(id, top, `f${i}`, 0);
  })();
  return id;
}

/** A process id that has ended: a child this test started and waited for. */
function endedPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { env: { ...process.env } });
  assert.equal(child.status, 0, 'the child ran and ended');
  return child.pid as number;
}

test('a build another process is writing in the same index is never reclaimed by a build or a delete here — only by the next open, or once its process has ended', async (t) => {
  await reclaimsSettled();
  openIndex();
  const other = new Database(indexDbPath());
  t.after(() => other.close());
  const elsewhere = folder('elsewhere');
  // A capped build of a live process (the test runner that started this one), and an explicit build: the folder's own path.
  const capped = foreignBuild(other, `building-aside:${String(process.ppid)}:1:${elsewhere}`, 40);
  const explicit = foreignBuild(other, path.join(elsewhere, 'explicit'), 30);
  // A capped build whose process has ended: nothing will ever finish it.
  const orphan = foreignBuild(other, `building-aside:${String(endedPid())}:1:${elsewhere}`, 20);
  // A capped build of a process this one may not signal (pid 1, the system's own): running, all the same.
  const notOurs = process.platform === 'win32' ? null : foreignBuild(other, `building-aside:1:1:${elsewhere}`, 10);

  const dir = folder('here');
  addFiles(dir, 3);
  await buildIndex(dir, { live: false }); // a build start looks for leftovers
  deleteIndex(folder('nothing')); // and so does a delete
  await reclaimsSettled();
  const alive: [string, number, number][] = [["the live process's capped build", capped, 40], ['the explicit build', explicit, 30]];
  if (notOurs !== null) alive.push(["a capped build of a process this one may not signal", notOurs, 10]);
  for (const [what, id, rows] of alive) {
    assert.equal(rowsUnder(id), rows, `${what} keeps every row it wrote`);
    assert.equal(rootRow(id)?.state, 'building', `${what} is still building`);
    assert.ok(!rootRow(id)!.path.startsWith('building-aside:discard:'), `${what} was not set aside: ${rootRow(id)!.path}`);
  }
  assert.equal(rootRow(orphan), undefined, 'the build whose process has ended is reclaimed');
  assert.equal(rowsUnder(orphan), 0, 'with every row it wrote');

  closeIndex();
  openIndex(); // the open: every building root is a leftover, as it always was
  await reclaimsSettled();
  for (const [what, id] of alive) {
    assert.equal(rootRow(id), undefined, `the open reclaims ${what}`);
    assert.equal(rowsUnder(id), 0);
  }
});

test('an explicit build whose discard failed is reclaimed by the next build of another folder: this process knows it is its own', async (t) => {
  await reclaimsSettled();
  const dir = folder('explicit-failed-discard');
  fs.mkdirSync(path.join(dir, 'sub'));
  addFiles(path.join(dir, 'sub'), 600);
  const handle = openIndex();
  handle.exec("CREATE TEMP TRIGGER fail_discard BEFORE UPDATE OF path ON roots WHEN NEW.path LIKE 'building-aside:discard:%' BEGIN SELECT RAISE(ABORT, 'injected: the discard failed'); END");
  const logged = t.mock.method(console, 'error', () => {});
  let polls = 0;
  try {
    await assert.rejects(buildIndex(dir, { live: false, isCancelled: () => ++polls >= 560 }), { message: 'cancelled' });
  } finally {
    handle.exec('DROP TRIGGER IF EXISTS temp.fail_discard');
    logged.mock.restore();
  }
  assert.equal(logged.mock.callCount(), 1, 'the failed discard is logged');
  const left = getRoot(dir) ?? assert.fail('the cancelled build is left where it was');
  assert.equal(left.state, 'building');
  assert.ok(rowsUnder(left.id) >= 500, 'with the rows it wrote');

  await buildIndex(folder('next'), { live: false });
  await reclaimsSettled();
  assert.equal(rootRow(left.id), undefined, 'the next build reclaims it');
  assert.equal(rowsUnder(left.id), 0);
});
