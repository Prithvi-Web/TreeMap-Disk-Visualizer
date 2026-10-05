import { test, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-indexReclaim-data-');

import {
  INDEX_RECLAIM_ROWS,
  IndexCapReached,
  buildIndex,
  closeIndex,
  getRoot,
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
 * The saved index is never deleted before the new one is swapped in (U-Q4).
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
