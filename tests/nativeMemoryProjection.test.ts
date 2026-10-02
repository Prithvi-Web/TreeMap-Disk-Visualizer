import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every write a scan here causes lands in a folder of this file's own; gdu
// stays off, so a native failure can only ever reach the built-in walker.
import { isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-nativeMemoryProjection-data-');
process.env.TREEMAP_NO_GDU = '1';

import { countedReal, type CountedHooks } from './fixtures/countedNative';
import { MEMORY_CAP_ROWS, RESERVE_FACTOR, memoryRoom, memoryRoomFor, setMemoryRoomForTests, type MemoryRoom } from '../src/services/scan/nativeMemory';
import { rootName, runNativeWalk } from '../src/services/scan/nativeEngine';
import { setProjectionForTests, type EntryProjection } from '../src/services/scan/projection';
import { createScanRecord, getScan, startScan } from '../src/services/diskScanner';
import { PackedScanStore } from '../src/services/scanStore';
import { statToInput } from '../src/services/scan/nodeInput';
import { settled } from '../src/utils/backgroundWrites';
import { updateSettings } from '../src/services/settings';
import type { ScanResult } from '../src/models/types';

/**
 * Track U, U-31 (the owner's U-Q15, 2 Oct 2026: yes): until Phase 4's T16
 * gives large trees spill mode, the memory store's room is sized from the
 * tree's projection — `RESERVE_FACTOR` (2) times it, never below the default —
 * so a folder that outgrew the default room is walked once on its next scan,
 * instead of once to the ceiling and again on the columns path. An over-reserved
 * row costs address space only (P4-11); an under-reserved one costs a second
 * walk, and the ceiling's walk again stays as the net for an under-projection.
 * A sized room the OS refuses is retried at the default room; a default room
 * refused too walks natively on the columns path, which needs no sink — never
 * the built-in walker. Counted through the real module (countedNative).
 */

/** `folders` folders of `files` files each under a new temp folder. */
function tree(t: TestContext, folders: number, files: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-memory-projection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let f = 0; f < folders; f++) {
    const dir = path.join(root, `folder-${f}`);
    fs.mkdirSync(dir);
    for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `file-${i}.txt`), 'x'.repeat(1 + (i % 50)));
  }
  return root;
}

/** 40 folders of 60 files: 2,441 rows with the root, past a 2,048-row room's 1,023 entries. */
const FOLDERS = 40;
const FILES = 60;
const ROWS = 1 + FOLDERS + FOLDERS * FILES;

async function scanned(root: string): Promise<ScanResult> {
  await updateSettings({ engine: 'native' });
  const record = await startScan(root);
  await waitFor(() => getScan(record.scanId)?.status !== 'running', `the scan of ${root} settling`);
  return getScan(record.scanId)!;
}

/** The scan's pruned tree as JSON, access times left out (a later walk sees the times an earlier one left). */
function prunedJson(scan: ScanResult): string {
  assert.ok(scan.store, 'the scan kept a store');
  const pruned = scan.store.prune(scan.store.rootId, { maxNodes: 250_000 }).root;
  return JSON.stringify(pruned, (key, value: unknown) => (key === 'accessedAt' ? undefined : value));
}

/** The room each memory start asked for, in order; null for a columns start. */
function roomsAsked(startOptions: Array<{ store?: { capRows: number } | null }>): Array<number | null> {
  return startOptions.map((opts) => opts.store?.capRows ?? null);
}

const projected = (entries: number, source: EntryProjection['source'] = 'previousScan'): EntryProjection =>
  ({ entries, source, reason: `the test projects ${entries} items` });

/** A start hook that refuses memory starts as the native core refuses a room it cannot reserve. */
function refusing(refuse: (capRows: number) => boolean): CountedHooks {
  return {
    start: (storage, opts) => {
      const capRows = opts.store?.capRows;
      if (storage === 'memory' && typeof capRows === 'number' && refuse(capRows)) {
        throw new Error(`the memory sink cannot be made: the test refuses room for ${capRows} rows`);
      }
    },
  };
}

/* ─────────────────────────── the room, pure ─────────────────────────── */

test('the room is the default for an unknown projection, twice the projection above it, and clamped to what the store can number', () => {
  setMemoryRoomForTests(null);
  assert.equal(RESERVE_FACTOR, 2, 'the stated policy (U-Q15)');
  assert.deepEqual(memoryRoomFor(null), { capRows: 6_250_000, headroomRows: 62_500, nameBytes: 800_000_000, sizedBy: 'default' });
  assert.deepEqual(memoryRoomFor({ entries: null }), memoryRoomFor(null));
  assert.deepEqual(memoryRoom(), memoryRoomFor(null), 'the room a walk is given without a projection');
  assert.deepEqual(memoryRoomFor({ entries: 9_115_094 }), { capRows: 18_230_188, headroomRows: 182_302, nameBytes: 2_333_464_064, sizedBy: 'projection' });
  assert.deepEqual(memoryRoomFor({ entries: 3_000_000 }), memoryRoomFor(null), 'twice 3,000,000 is under the default: the default stands');
  assert.equal(memoryRoomFor({ entries: 3_125_001 }).capRows, 6_250_002, 'sizing starts just past half the default');
  assert.equal(memoryRoomFor({ entries: 40_000_000 }).nameBytes, 4_294_967_295, 'name bytes stop at what 32-bit offsets reach');
  assert.deepEqual(memoryRoomFor({ entries: 2e9 }), { capRows: 2_147_483_647, headroomRows: 21_474_837, nameBytes: 4_294_967_295, sizedBy: 'projection' });
  for (const nonsense of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(memoryRoomFor({ entries: nonsense }), memoryRoomFor(null), `a projection of ${nonsense} is no projection`);
  }
  assert.equal(MEMORY_CAP_ROWS, 6_250_000);
});

test('a test\'s room is the base the projection sizes from, its name bytes a row honoured', (t) => {
  t.after(() => setMemoryRoomForTests(null));
  setMemoryRoomForTests({ capRows: 2_048, nameBytesPerRow: 64 });
  assert.deepEqual(memoryRoomFor(null), { capRows: 2_048, headroomRows: 1_024, nameBytes: 2_048 * 64, sizedBy: 'default' });
  assert.deepEqual(memoryRoomFor({ entries: 500 }), memoryRoomFor(null), 'a projection of 500 leaves the room at 2,048');
  assert.deepEqual(memoryRoomFor({ entries: ROWS }), { capRows: 2 * ROWS, headroomRows: 1_024, nameBytes: 2 * ROWS * 64, sizedBy: 'projection' });
});

/* ─────────────────────────── one walk on the next scan ─────────────────────────── */

test('a folder that outgrew the room is walked once on its next scan, into the same tree', async (t) => {
  const counted = countedReal(t);
  if (!counted) return;
  t.after(() => setMemoryRoomForTests(null));
  const root = tree(t, FOLDERS, FILES);
  setMemoryRoomForTests({ capRows: 2_048 });

  const first = await scanned(root);
  assert.equal(first.status, 'complete', first.error ?? '');
  assert.deepEqual(counted.starts, ['memory', 'columns'], 'the first scan met the default room\'s ceiling and walked again');
  assert.equal(first.nativePlan?.room?.sizedBy, 'default');
  assert.equal(first.scanned, ROWS);

  await settled(); // the first scan's snapshot is written
  counted.starts.length = 0;
  counted.startOptions.length = 0;
  counted.takes = 0;
  const second = await scanned(root);
  assert.equal(second.status, 'complete', second.error ?? '');
  assert.equal(second.engine, 'native');
  assert.deepEqual(counted.starts, ['memory'], 'one walk');
  assert.deepEqual(roomsAsked(counted.startOptions), [2 * ROWS], 'room for twice the first scan\'s count');
  assert.equal(counted.takes, 1, 'its store taken whole');
  assert.doesNotMatch(second.engineReason, /walked the tree again/);
  assert.match(second.engineReason, new RegExp(`; the memory store was sized for ${(2 * ROWS).toLocaleString('en-US')} rows because the previous scan of this folder counted ${ROWS.toLocaleString('en-US')} items`));
  assert.deepEqual(second.nativePlan?.room, { capRows: 2 * ROWS, headroomRows: 1_024, nameBytes: 2 * ROWS * 128, sizedBy: 'projection' });
  assert.equal(second.fileCount, FOLDERS * FILES);
  assert.equal(prunedJson(second), prunedJson(first), 'the tree is the one the two walks gave');
});

test('an under-projection keeps the default room and still meets the ceiling\'s walk again', async (t) => {
  const counted = countedReal(t);
  if (!counted) return;
  t.after(() => setMemoryRoomForTests(null));
  const root = tree(t, FOLDERS, FILES);
  t.after(() => setProjectionForTests(root, null));
  setMemoryRoomForTests({ capRows: 2_048 });
  setProjectionForTests(root, projected(100));
  const scan = await scanned(root);
  assert.equal(scan.status, 'complete', scan.error ?? '');
  assert.deepEqual(counted.starts, ['memory', 'columns']);
  assert.deepEqual(roomsAsked(counted.startOptions), [2_048, null], 'twice 100 is under the default room');
  assert.match(scan.engineReason, /stopped at its ceiling/);
  assert.doesNotMatch(scan.engineReason, /sized for/, 'no room is claimed that was not sized');
  assert.equal(scan.scanned, ROWS);
});

test('the real module accepts a room sized for 9,115,094 items, whose name bytes pass 2^31', async (t) => {
  const counted = countedReal(t);
  if (!counted) return;
  setMemoryRoomForTests(null);
  const root = tree(t, 3, 5);
  const room = memoryRoomFor({ entries: 9_115_094 });
  assert.ok(room.nameBytes > 2 ** 31, `the name bytes cross napi past 2^31: ${room.nameBytes}`);
  const scan = createScanRecord(root);
  const store = new PackedScanStore(root, path.sep, statToInput(rootName(root), true, 0, fs.lstatSync(root).mtimeMs));
  await runNativeWalk(scan, store, root, counted.module, 'memory', room);
  assert.deepEqual(counted.starts, ['memory']);
  assert.deepEqual(counted.startOptions[0].store && {
    capRows: counted.startOptions[0].store.capRows,
    headroomRows: counted.startOptions[0].store.headroomRows,
    nameBytes: counted.startOptions[0].store.nameBytes,
  }, { capRows: 18_230_188, headroomRows: 182_302, nameBytes: 2_333_464_064 });
  assert.equal(counted.takes, 1);
  assert.equal(scan.fileCount, 3 * 5);
  assert.equal(scan.dirCount, 1 + 3);
});

/* ─────────────────────────── a room the OS refuses ─────────────────────────── */

test('a sized room refused is retried once at the default room, and the scan completes natively', async (t) => {
  const counted = countedReal(t, refusing((capRows) => capRows === 2 * ROWS));
  if (!counted) return;
  t.after(() => setMemoryRoomForTests(null));
  const root = tree(t, FOLDERS, FILES);
  t.after(() => setProjectionForTests(root, null));
  setMemoryRoomForTests({ capRows: 2_048 });
  setProjectionForTests(root, projected(ROWS));
  const scan = await scanned(root);
  assert.equal(scan.status, 'complete', scan.error ?? '');
  assert.equal(scan.engine, 'native');
  assert.equal(scan.fallbackReason, null, 'nothing fell back: the native engine did the scan');
  assert.deepEqual(counted.starts, ['memory', 'memory', 'columns'], 'the sized room refused, the default room met its ceiling, the columns path finished');
  assert.deepEqual(roomsAsked(counted.startOptions), [2 * ROWS, 2_048, null]);
  assert.match(scan.engineReason, new RegExp(`the memory store could not be given room for ${(2 * ROWS).toLocaleString('en-US')} rows \\(the memory sink cannot be made: the test refuses room for ${2 * ROWS} rows\\), so it was given its default room for 2,048`));
  assert.equal(scan.fileCount, FOLDERS * FILES);
});

test('both rooms refused: the tree is walked natively on the columns path, never by the built-in walker', async (t) => {
  const counted = countedReal(t, refusing(() => true));
  if (!counted) return;
  t.after(() => setMemoryRoomForTests(null));
  const root = tree(t, FOLDERS, FILES);
  t.after(() => setProjectionForTests(root, null));
  setMemoryRoomForTests({ capRows: 2_048 });
  setProjectionForTests(root, projected(ROWS));
  const scan = await scanned(root);
  assert.equal(scan.status, 'complete', scan.error ?? '');
  assert.equal(scan.engine, 'native', 'never the legacy walker');
  assert.equal(scan.fallbackReason, null);
  assert.deepEqual(counted.starts, ['memory', 'memory', 'columns']);
  assert.deepEqual(roomsAsked(counted.startOptions), [2 * ROWS, 2_048, null]);
  assert.match(scan.engineReason, /the memory store could not be made \(the memory sink cannot be made: the test refuses room for 2048 rows\), so the tree was walked on the columns path/);
  assert.equal(scan.fileCount, FOLDERS * FILES);
});

test('a default room refused walks the columns path at once: there is no smaller room to retry', async (t) => {
  const counted = countedReal(t, refusing(() => true));
  if (!counted) return;
  const root = tree(t, 3, 5);
  setMemoryRoomForTests(null);
  const scan = await scanned(root);
  assert.equal(scan.status, 'complete', scan.error ?? '');
  assert.equal(scan.engine, 'native');
  assert.deepEqual(counted.starts, ['memory', 'columns']);
  assert.equal(scan.fileCount, 3 * 5);
});

/** A room the native core cannot make — no rows beside its headroom — refused with its own sentence, not the test's. */
const IMPOSSIBLE = { capRows: 1_000, headroomRows: 2_000, nameBytes: 1_000 * 128 } as const;

test('the native core\'s own refusal of a sized room is the one retried: the walk goes on at the default room', async (t) => {
  const counted = countedReal(t);
  if (!counted) return;
  setMemoryRoomForTests(null);
  const root = tree(t, 3, 5);
  const scan = createScanRecord(root);
  const store = new PackedScanStore(root, path.sep, statToInput(rootName(root), true, 0, fs.lstatSync(root).mtimeMs));
  const sized: MemoryRoom = { ...IMPOSSIBLE, sizedBy: 'projection' };
  await runNativeWalk(scan, store, root, counted.module, 'memory', sized);
  assert.deepEqual(counted.starts, ['memory', 'memory'], 'refused by the native core, then the default room');
  assert.deepEqual(roomsAsked(counted.startOptions), [1_000, MEMORY_CAP_ROWS]);
  assert.equal(counted.takes, 1, 'the default room\'s store taken whole');
  assert.match(scan.engineReason, /the memory store could not be given room for 1,000 rows \(the memory sink cannot be made: the memory sink: room for 1000 rows leaves none beside 2000 rows of headroom\), so it was given its default room for 6,250,000/);
  assert.equal(scan.fileCount, 3 * 5);
});

test('the native core\'s own refusal of a default room walks the columns path', async (t) => {
  const counted = countedReal(t);
  if (!counted) return;
  setMemoryRoomForTests(null);
  const root = tree(t, 3, 5);
  const scan = createScanRecord(root);
  const store = new PackedScanStore(root, path.sep, statToInput(rootName(root), true, 0, fs.lstatSync(root).mtimeMs));
  await runNativeWalk(scan, store, root, counted.module, 'memory', { ...IMPOSSIBLE, sizedBy: 'default' });
  assert.deepEqual(counted.starts, ['memory', 'columns']);
  assert.match(scan.engineReason, /the memory store could not be made \(the memory sink cannot be made: the memory sink: room for 1000 rows leaves none beside 2000 rows of headroom\), so the tree was walked on the columns path/);
  assert.equal(scan.fileCount, 3 * 5);
});

test('any other start failure is not retried: one memory attempt, then today\'s fallback', async (t) => {
  const counted = countedReal(t, {
    start: (storage) => {
      if (storage === 'memory') throw new Error('the test breaks the module');
    },
  });
  if (!counted) return;
  const root = tree(t, 3, 5);
  setMemoryRoomForTests(null);
  const scan = await scanned(root);
  assert.equal(scan.status, 'complete', scan.error ?? '');
  assert.deepEqual(counted.starts, ['memory'], 'not retried');
  assert.equal(scan.engine === 'walker' || scan.engine === 'turbo-walker', true, `the built-in walker finished it: ${String(scan.engine)}`);
  assert.match(scan.fallbackReason ?? '', /^the native engine failed part-way: the test breaks the module/);
});
