import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every write here — the history, the scans' snapshots and caches — lands in
// a folder of this file's own; gdu stays off.
import { isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
const DATA = isolatedDataDir('treemap-snapshotCountsIndex-data-');
process.env.TREEMAP_NO_GDU = '1';

import { countedReal } from './fixtures/countedNative';
import {
  forgetSnapshotCountsForTests,
  listSnapshots,
  newestSnapshotCounts,
  saveSnapshot,
  snapshotHistoryReadsForTests,
} from '../src/services/snapshots';
import { initPortableMode, resetPortableMode } from '../src/services/portableMode';
import { createScanRecord, getScan, startScan } from '../src/services/diskScanner';
import { PackedScanStore } from '../src/services/scanStore';
import { statToInput } from '../src/services/scan/nodeInput';
import { rootName } from '../src/services/scan/nativeEngine';
import { settled } from '../src/utils/backgroundWrites';
import { updateSettings } from '../src/services/settings';
import type { ScanResult } from '../src/models/types';

/**
 * Track U, U-30's follow-up: a native scan's projection reads a root's newest
 * snapshot counts from an index snapshots.ts keeps, instead of parsing the
 * whole history — tens of MB on a long-used Mac — at every scan start. The
 * index is built by one read the first time it is asked for in a process,
 * rebuilt with no read from each history a save writes, and read again only
 * when the file is not the one it was built from. Every claim is a count of
 * reads of snapshots.json (`snapshotHistoryReadsForTests`), never a time.
 */

const HISTORY = path.join(DATA, 'snapshots.json');
const reads = (): number => snapshotHistoryReadsForTests();
const record = (rootPath: string, takenAt: number, fileCount: number, dirCount: number): Record<string, unknown> =>
  ({ id: `${rootPath}@${takenAt}`, rootPath, takenAt, totalSize: 1, fileCount, dirCount, topEntries: [] });
const writeHistory = (snapshots: unknown[]): void => fs.writeFileSync(HISTORY, JSON.stringify({ snapshots }, null, 2));

/** A finished scan record of `rootPath` holding `files` files and `dirs` folders, as saveSnapshot takes one. */
function finishedScan(rootPath: string, files: number, dirs: number): ScanResult {
  const scan = createScanRecord(rootPath);
  const store = new PackedScanStore(rootPath, path.sep, statToInput(rootName(rootPath), true, 0, 1_700_000_000_000));
  store.finalize();
  store.sumSizes();
  scan.store = store;
  scan.status = 'complete';
  scan.finishedAt = 1_700_000_000_000 + files;
  scan.fileCount = files;
  scan.dirCount = dirs;
  return scan;
}

/* ─────────────────────────── the index ─────────────────────────── */

test('a root\'s newest counts come from one read of the history; asking again, for it or any other root, reads nothing', async () => {
  writeHistory([
    record('/a', 1_000, 10, 1),
    record('/b', 1_500, 50, 5),
    record('/a', 2_000, 20, 2),
    record('/a', 1_200, 12, 1),
  ]);
  forgetSnapshotCountsForTests();
  const before = reads();
  assert.deepEqual(await newestSnapshotCounts('/a'), { rootPath: '/a', takenAt: 2_000, fileCount: 20, dirCount: 2 });
  assert.equal(reads() - before, 1, 'one read builds the index');
  assert.deepEqual(await newestSnapshotCounts('/b'), { rootPath: '/b', takenAt: 1_500, fileCount: 50, dirCount: 5 });
  assert.equal((await newestSnapshotCounts('/a'))?.fileCount, 20);
  assert.equal(await newestSnapshotCounts('/never-scanned'), null);
  assert.equal(reads() - before, 1, 'every later ask is answered from the index');
});

test('a history changed by anything else — another process, a person — is read again, once; a removed one is none', async () => {
  writeHistory([record('/a', 2_000, 20, 2)]);
  forgetSnapshotCountsForTests();
  assert.equal((await newestSnapshotCounts('/a'))?.fileCount, 20);
  const built = reads();

  writeHistory([record('/a', 2_000, 20, 2), record('/a', 3_000, 30, 3), record('/c', 3_000, 7, 1)]);
  assert.equal((await newestSnapshotCounts('/a'))?.fileCount, 30, 'the file another writer changed is read');
  assert.equal(reads() - built, 1);
  assert.equal((await newestSnapshotCounts('/c'))?.fileCount, 7);
  assert.equal(reads() - built, 1, 'and only once');

  fs.rmSync(HISTORY);
  assert.equal(await newestSnapshotCounts('/a'), null, 'a removed history holds no scan');
  assert.equal(reads() - built, 2);
  assert.equal(await newestSnapshotCounts('/c'), null);
  assert.equal(reads() - built, 2, 'an absent history is not read again while it stays absent');
});

test('scans that start together share one read', async () => {
  writeHistory([record('/a', 2_000, 20, 2), record('/b', 1_500, 50, 5)]);
  forgetSnapshotCountsForTests();
  const before = reads();
  const answers = await Promise.all([newestSnapshotCounts('/a'), newestSnapshotCounts('/b'), newestSnapshotCounts('/a')]);
  assert.deepEqual(answers.map((counts) => counts?.fileCount), [20, 50, 20]);
  assert.equal(reads() - before, 1, 'one read for three asks at once');
});

test('a scan\'s own save updates the index without a read, and two saves at once both keep their snapshot', async () => {
  writeHistory([]);
  forgetSnapshotCountsForTests();
  await newestSnapshotCounts('/x');
  const built = reads();
  // Each save rewrites the whole history: two at once would each write what
  // they read, and the one written second would drop the other's snapshot.
  await Promise.all([saveSnapshot(finishedScan('/saved/one', 100, 10)), saveSnapshot(finishedScan('/saved/two', 200, 20))]);
  assert.equal(reads() - built, 2, 'each save reads the history once, as it always has');
  assert.deepEqual(
    [(await newestSnapshotCounts('/saved/one'))?.fileCount, (await newestSnapshotCounts('/saved/two'))?.fileCount],
    [100, 200],
    'both saved scans are in the index',
  );
  assert.equal(reads() - built, 2, 'the index came from the saves, not from a read');
  assert.equal((await listSnapshots('/saved/one')).length, 1, 'the first save\'s snapshot is still on file');
  assert.equal((await listSnapshots('/saved/two')).length, 1, 'the second save\'s too');
});

const NO_CHMOD = process.platform === 'win32'
  ? 'chmod cannot make a folder unreadable on Windows'
  : process.getuid?.() === 0
    ? 'root may read anywhere: chmod cannot make a folder unreadable for root'
    : false;

test('a history that cannot be looked at is said, not guessed at — not even as the empty history the index last saw there', { skip: NO_CHMOD }, async (t: TestContext) => {
  const locked = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-snapshot-locked-'));
  t.after(() => {
    fs.chmodSync(locked, 0o700);
    fs.rmSync(locked, { recursive: true, force: true });
    process.env.TREEMAP_DATA_DIR = DATA;
    forgetSnapshotCountsForTests();
  });
  process.env.TREEMAP_DATA_DIR = locked;
  forgetSnapshotCountsForTests();
  assert.equal(await newestSnapshotCounts('/a'), null, 'no history there yet: the index holds none');
  // A scan's history appears, and then the folder can no longer be looked into.
  fs.writeFileSync(path.join(locked, 'snapshots.json'), JSON.stringify({ snapshots: [record('/a', 1, 1, 1)] }));
  fs.chmodSync(locked, 0o000);
  await assert.rejects(
    newestSnapshotCounts('/a'),
    (err: NodeJS.ErrnoException) => err.code === 'EACCES',
    'the refusal is thrown: neither read as no history nor answered from the index of the folder as it was',
  );
});

test('a no-trace portable session never looks at a history on disk', { skip: NO_CHMOD }, async (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-snapshot-ro-'));
  const readOnly = path.join(base, 'ro');
  fs.mkdirSync(readOnly);
  fs.chmodSync(readOnly, 0o500);
  t.after(() => {
    fs.chmodSync(readOnly, 0o700);
    fs.rmSync(base, { recursive: true, force: true });
    resetPortableMode();
    forgetSnapshotCountsForTests();
  });
  resetPortableMode();
  const status = initPortableMode({ TREEMAP_PORTABLE: '1', TREEMAP_DATA_DIR: path.join(readOnly, 'TreeMap-Data') } as NodeJS.ProcessEnv);
  assert.equal(status.writable, false, 'the session really is read-only');
  const looked: string[] = [];
  const realStat = fs.promises.stat;
  t.mock.method(fs.promises, 'stat', (target: fs.PathLike, ...rest: unknown[]) => {
    if (String(target).endsWith('snapshots.json')) looked.push(String(target));
    return (realStat as (...args: unknown[]) => Promise<fs.Stats>).call(fs.promises, target, ...rest);
  });
  forgetSnapshotCountsForTests();
  const before = reads();
  assert.equal(await newestSnapshotCounts('/a'), null, 'the session\'s own history is empty');
  await saveSnapshot(finishedScan('/portable/scanned', 40, 4));
  assert.equal((await newestSnapshotCounts('/portable/scanned'))?.fileCount, 40, 'its own save is in the index');
  assert.equal(reads() - before, 2, 'one read to build, one by the save, none after');
  assert.deepEqual(looked, [], 'no history on disk was looked at');
});

/* ─────────────────────────── at a native scan's start ─────────────────────────── */

/** `folders` folders of `files` files each under a new temp folder. */
function tree(t: TestContext, folders: number, files: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-snapshot-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let f = 0; f < folders; f++) {
    const dir = path.join(root, `folder-${f}`);
    fs.mkdirSync(dir);
    for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `file-${i}.txt`), 'x'.repeat(1 + i));
  }
  return root;
}

test('only the first native scan start in a process reads the history; the second and third read nothing', async (t) => {
  const counted = countedReal(t);
  if (!counted) return;
  const root = tree(t, 3, 4);
  await updateSettings({ engine: 'native' });
  forgetSnapshotCountsForTests();
  const startReads: number[] = [];
  const scanReads: number[] = [];
  const scans: ScanResult[] = [];
  for (let n = 0; n < 3; n++) {
    const beforeStart = reads();
    // The projection is made before startScan answers; the scan's save comes at its completion.
    const record = await startScan(root);
    startReads.push(reads() - beforeStart);
    await waitFor(() => getScan(record.scanId)?.status !== 'running', `scan ${n + 1} settling`);
    await settled(); // its snapshot is written
    scanReads.push(reads() - beforeStart);
    scans.push(getScan(record.scanId)!);
  }
  for (const scan of scans) assert.equal(scan.status, 'complete', scan.error ?? '');
  assert.deepEqual(startReads, [1, 0, 0], 'the first start builds the index; later starts parse no history');
  assert.deepEqual(scanReads, [2, 1, 1], 'after its start, each scan reads the history once more: its save, as it always has');
  const rows = 1 + 3 + 3 * 4;
  assert.deepEqual(scans.map((scan) => scan.nativePlan?.projection.entries ?? null), [null, rows, rows], 'the later starts still see the earlier scans');
});
