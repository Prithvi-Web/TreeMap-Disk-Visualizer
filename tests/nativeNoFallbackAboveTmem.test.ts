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
isolatedDataDir('treemap-nativeNoFallbackAboveTmem-data-');
process.env.TREEMAP_NO_GDU = '1';

import { countedReal, type Counted, type PollHook } from './fixtures/countedNative';
import {
  MEMORY_CAP_ROWS,
  T_MEM_ENTRIES,
  T_MEM_MARGIN,
  memoryRoom,
  memoryRoomFor,
  noRestartRefusal,
  setMemoryRoomForTests,
} from '../src/services/scan/nativeMemory';
import { setNativeWalkTimingForTests } from '../src/services/scan/nativeEngine';
import { setProjectionForTests, type EntryProjection } from '../src/services/scan/projection';
import { SCAN_CANCELLED_MESSAGE, allScans, cancelScan, getScan, startScan } from '../src/services/diskScanner';
import { updateSettings } from '../src/services/settings';
import type { NativeProgress } from '../native/index';
import type { ScanResult } from '../src/models/types';

/**
 * Track U, U-32: P4-14 now (the owner's U-Q16, 2 Oct 2026: yes). A native
 * walk that fails part-way through a tree known to be above `T_mem` fails the
 * scan with the reason instead of restarting it from zero in the built-in
 * walker — 5.1.0's failure: the count reset, and the tree walked again at a
 * fraction of the speed. Known above means the scan has counted more than
 * `T_mem`, or the previous scan of the folder counted enough that, with T16's
 * margin (1.25 ×), it is (U-D18); the used-inode hint is never such a fact.
 * Below `T_mem` nothing changes. The hooks fake low counts, so each clause is
 * isolated by counts alone; the real module walks underneath (countedNative).
 */

const NOT_RESTARTED = 'TreeMap does not restart a scan this large in the built-in walker on its own: it would walk the tree again from zero at a fraction of the speed.';
/** The way out a failure that did not stall is given. */
const ANYWAY = 'To scan it anyway, set Scan engine to Built-in walker in Settings; the scan is slower.';
/** What a stall adds: where the walk was last seen, as only that, and both ways out. */
const lastSeen = (folder: string): string =>
  `The walk was last seen at ${folder}, which may not be the folder that stopped answering. While a folder does not answer, every scan this large fails this way. `
  + 'To scan it anyway, set Scan engine to Built-in walker in Settings, or add the folder that does not answer to "Don\'t scan", which also hands the scan to the built-in walker; either way the scan is slower.';

/** `folders` folders of `files` files each under a new temp folder. */
function tree(t: TestContext, folders: number, files: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-no-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let f = 0; f < folders; f++) {
    const dir = path.join(root, `folder-${f}`);
    fs.mkdirSync(dir);
    for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `file-${i}.txt`), 'x'.repeat(1 + (i % 50)));
  }
  return root;
}

async function scanned(root: string): Promise<ScanResult> {
  await updateSettings({ engine: 'native' });
  const record = await startScan(root);
  await waitFor(() => getScan(record.scanId)?.status !== 'running', `the scan of ${root} settling`);
  return getScan(record.scanId)!;
}

/** The walk's report rewritten to a running walk that has counted `entries`. */
const running = (real: NativeProgress, entries: number): NativeProgress =>
  ({ ...real, done: false, ceiling: false, error: null, entries, dirs: 0, files: entries, bytes: 0 });

/**
 * A poll hook for walks of `storage`: polls before `throwAt` report a running
 * walk with `entries`; poll `throwAt` throws `message`; later polls — the
 * settle after the throw — report the walk as it is, so its handle is freed.
 */
function failAt(storage: string, throwAt: number, entries: number, message: string, before?: () => void): PollHook {
  return (walk, nth, real) => {
    if (walk !== storage || nth > throwAt) return real;
    if (nth < throwAt) return running(real, entries);
    before?.();
    throw new Error(message);
  };
}

const previousScan = (entries: number): EntryProjection =>
  ({ entries, source: 'previousScan', reason: `the previous scan of this folder counted ${entries} items` });

function assertRestartedInWalker(scan: ScanResult, counted: Counted, failure: RegExp): void {
  assert.equal(scan.status, 'complete', scan.error ?? '');
  assert.equal(scan.engine === 'walker' || scan.engine === 'turbo-walker', true, `today's fallback, the built-in walker: ${String(scan.engine)}`);
  assert.match(scan.fallbackReason ?? '', failure);
  assert.deepEqual(counted.starts, ['memory'], 'one native walk, then the walker');
}

/* ─────────────────────────── the invariant ─────────────────────────── */

test('every room, default or sized, numbers more than T_mem entries before its ceiling', () => {
  setMemoryRoomForTests(null);
  assert.equal(T_MEM_ENTRIES, 5_000_000, 'the owner\'s T_mem (Phase 4 Q3)');
  assert.equal(T_MEM_MARGIN, 1.25);
  assert.equal(MEMORY_CAP_ROWS, T_MEM_MARGIN * T_MEM_ENTRIES, 'the default room is 1.25 × T_mem');
  const rooms = [memoryRoom(), ...[1, 3_125_001, 4_000_000, 5_000_000, 9_115_094, 100_000_000, 2e9].map((entries) => memoryRoomFor({ entries }))];
  for (const room of rooms) {
    assert.ok(room.capRows - room.headroomRows > T_MEM_ENTRIES, `room for ${room.capRows} rows less ${room.headroomRows} of headroom must leave more than T_mem`);
  }
});

/* ─────────────────────────── known above T_mem: no restart ─────────────────────────── */

test('a failure on the walk again after the ceiling, the count held above T_mem, fails the scan: no restart, nothing reset', async (t) => {
  const root = tree(t, 40, 60);
  const counted = countedReal(t, { poll: failAt('columns', 5, 10, 'the test breaks the walk again at its fifth poll') });
  if (!counted) return;
  t.after(() => setMemoryRoomForTests(null));
  // A 2,048-row room stops at its ceiling with the 40 folders and sixteen of
  // their listings counted (1,001 with the root), above a T_mem of 900.
  setMemoryRoomForTests({ capRows: 2_048, tMem: 900 });
  const scan = await scanned(root);
  assert.equal(scan.status, 'error', 'the scan failed rather than restarting');
  assert.equal(scan.error, `The native engine failed part-way past 900 items: the test breaks the walk again at its fifth poll. ${NOT_RESTARTED} ${ANYWAY}`);
  assert.deepEqual(counted.starts, ['memory', 'columns'], 'the memory walk met its ceiling, the walk again failed, and no legacy walk ran');
  assert.equal(scan.engine, 'native');
  assert.equal(scan.fallbackReason, null, 'nothing fell back');
  assert.ok(scan.scanned > 900, `the count the memory walk reached is kept, not reset: ${scan.scanned}`);
});

test('a count above T_mem with no ceiling and no projection fails the scan', async (t) => {
  const root = tree(t, 3, 5);
  const counted = countedReal(t, { poll: failAt('memory', 2, 1_499, 'the test breaks the walk at 1,500 items') });
  if (!counted) return;
  t.after(() => setMemoryRoomForTests(null));
  t.after(() => setProjectionForTests(root, null));
  setMemoryRoomForTests({ capRows: 4_096, tMem: 1_000 });
  setProjectionForTests(root, { entries: null, source: 'none', reason: 'the test projects nothing' });
  const scan = await scanned(root);
  assert.equal(scan.status, 'error');
  assert.equal(scan.error, `The native engine failed part-way past 1,000 items: the test breaks the walk at 1,500 items. ${NOT_RESTARTED} ${ANYWAY}`);
  assert.deepEqual(counted.starts, ['memory']);
  assert.equal(scan.scanned, 1_500, 'kept as counted');
});

test('a previous scan above T_mem fails the scan however little this walk has counted', async (t) => {
  const root = tree(t, 3, 5);
  const counted = countedReal(t, { poll: failAt('memory', 2, 10, 'the test breaks the walk at its second poll') });
  if (!counted) return;
  t.after(() => setMemoryRoomForTests(null));
  t.after(() => setProjectionForTests(root, null));
  setMemoryRoomForTests({ capRows: 2_048, tMem: 1_000 });
  setProjectionForTests(root, previousScan(2_441));
  const scan = await scanned(root);
  assert.equal(scan.status, 'error');
  assert.equal(scan.error, `The native engine failed on a folder whose last scan counted 2,441 items: the test breaks the walk at its second poll. ${NOT_RESTARTED} ${ANYWAY}`);
  assert.deepEqual(counted.starts, ['memory'], 'no fallback');
  assert.equal(scan.scanned, 11);
});

test('a previous scan is weighed with T16\'s margin: 1.25 × its count against T_mem, strictly above', async (t) => {
  const root = tree(t, 3, 5);
  t.after(() => setMemoryRoomForTests(null));
  t.after(() => setProjectionForTests(root, null));
  // 1.25 × 900 = 1,125 is above a T_mem of 1,000, though 900 is not.
  let counted = countedReal(t, { poll: failAt('memory', 2, 10, 'the test breaks the walk once more') });
  if (!counted) return;
  setMemoryRoomForTests({ capRows: 2_048, tMem: 1_000 });
  setProjectionForTests(root, previousScan(900));
  const within = await scanned(root);
  assert.equal(within.status, 'error', `a previous count of 900 is above T_mem once the margin is applied: ${within.error ?? ''}`);
  assert.match(within.error ?? '', /^The native engine failed on a folder whose last scan counted 900 items: /);
  // 1.25 × 800 = 1,000 is not above 1,000: today's fallback.
  counted = countedReal(t, { poll: failAt('memory', 2, 10, 'the test breaks the walk at the boundary') })!;
  setProjectionForTests(root, previousScan(800));
  const at = await scanned(root);
  assertRestartedInWalker(at, counted, /^the native engine failed part-way: the test breaks the walk at the boundary/);
});

/* ─────────────────────────── below T_mem, or not known: today's fallback ─────────────────────────── */

test('below T_mem a native failure still restarts in the built-in walker, as today', async (t) => {
  const root = tree(t, 3, 5);
  const counted = countedReal(t, { poll: failAt('memory', 1, 0, 'the test breaks the walk at its first poll') });
  if (!counted) return;
  t.after(() => setMemoryRoomForTests(null));
  setMemoryRoomForTests({ capRows: 2_048, tMem: 1_000_000 });
  const scan = await scanned(root);
  assertRestartedInWalker(scan, counted, /^the native engine failed part-way: the test breaks the walk at its first poll/);
  assert.equal(scan.fileCount, 3 * 5);
});

test('the used-inode hint is not a fact: a hint above T_mem leaves today\'s fallback', async (t) => {
  const root = tree(t, 3, 5);
  const counted = countedReal(t, { poll: failAt('memory', 1, 0, 'the test breaks the walk under a hint') });
  if (!counted) return;
  t.after(() => setMemoryRoomForTests(null));
  t.after(() => setProjectionForTests(root, null));
  setMemoryRoomForTests({ capRows: 2_048, tMem: 1_000 });
  setProjectionForTests(root, { entries: 5_000, source: 'usedInodes', reason: 'the test hints 5,000 inodes' });
  const scan = await scanned(root);
  assertRestartedInWalker(scan, counted, /^the native engine failed part-way: the test breaks the walk under a hint/);
});

test('a Stop above T_mem is a stop, not a failure', async (t) => {
  const root = tree(t, 3, 5);
  const stop = (): void => {
    const scan = allScans().find((s) => s.rootPath === root && s.status === 'running');
    assert.ok(scan, 'the running scan');
    assert.equal(cancelScan(scan.scanId), true);
  };
  const counted = countedReal(t, { poll: failAt('memory', 2, 1_499, 'the test breaks the walk as it is stopped', stop) });
  if (!counted) return;
  t.after(() => setMemoryRoomForTests(null));
  setMemoryRoomForTests({ capRows: 4_096, tMem: 1_000 });
  const scan = await scanned(root);
  assert.equal(scan.status, 'error');
  assert.equal(scan.error, SCAN_CANCELLED_MESSAGE, 'a Stop, not the failure');
  assert.equal(scan.cancelled, true);
  assert.deepEqual(counted.starts, ['memory']);
});

/* ─────────────────────────── the folder it was last seen in ─────────────────────────── */

test('a stalled walk\'s refusal names where the walk was last seen, as only that, with both ways out; any other gives the Scan engine way out', () => {
  const stalled = Object.assign(new Error('the native walk made no progress for 30 s at /Volumes/NAS/stuck'), { lastSeenAt: '/Volumes/NAS/stuck' });
  const named = noRestartRefusal(stalled, 6_000_000, null, 5_000_000);
  assert.ok(named, 'a refusal above T_mem');
  assert.equal(
    named.message,
    `The native engine failed part-way past 5,000,000 items: the native walk made no progress for 30 s at /Volumes/NAS/stuck. ${NOT_RESTARTED} ${lastSeen('/Volumes/NAS/stuck')}`,
  );
  const plain = noRestartRefusal(new Error('the walk broke.'), 6_000_000, null, 5_000_000);
  assert.equal(plain?.message, `The native engine failed part-way past 5,000,000 items: the walk broke. ${NOT_RESTARTED} ${ANYWAY}`, 'no folder is named for a failure that did not stall');
  const wordless = noRestartRefusal(Object.create(null), 6_000_000, null, 5_000_000);
  assert.equal(wordless?.message, `The native engine failed part-way past 5,000,000 items: a failure with no description. ${NOT_RESTARTED} ${ANYWAY}`, 'a failure with no string form is still a reason');
  assert.equal(noRestartRefusal(stalled, 5_000_000, null, 5_000_000), null, 'exactly T_mem is not above it');
  assert.equal(noRestartRefusal(stalled, 10, { entries: 9_000_000, source: 'usedInodes', reason: 'a hint' }, 5_000_000), null, 'a hint is never a fact');
});

test('a root that vanished above T_mem is the scan\'s own failure, in its own words, not a refusal', async (t) => {
  const root = tree(t, 3, 5);
  const gone = (): never => {
    throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${root}'`), { code: 'ENOENT', path: root });
  };
  const counted = countedReal(t, {
    poll: (storage, nth, real) => {
      if (storage !== 'memory' || nth > 2) return real;
      return nth < 2 ? running(real, 1_499) : gone();
    },
  });
  if (!counted) return;
  t.after(() => setMemoryRoomForTests(null));
  setMemoryRoomForTests({ capRows: 4_096, tMem: 1_000 });
  const scan = await scanned(root);
  assert.equal(scan.status, 'error');
  assert.equal(scan.error, 'The folder disappeared while TreeMap was scanning it — was a drive unplugged, or the folder moved?');
  assert.deepEqual(counted.starts, ['memory']);
});

test('a walk that stalls above T_mem fails the scan, naming where it was last seen', async (t) => {
  const root = tree(t, 3, 5);
  const wedged = path.join(root, 'folder-1', 'a-folder-that-stopped-answering');
  let clock = 0;
  let counted: Counted | null = null;
  counted = countedReal(t, {
    poll: (storage, _nth, real) => {
      clock += 500;
      // Frozen until the stall is settled: no new entry, no heartbeat, the same folder.
      if (storage !== 'memory' || (counted?.cancels ?? 0) > 0) return real;
      return { ...running(real, 1_499), heartbeat: 1, currentPath: wedged };
    },
  });
  if (!counted) return;
  t.after(() => setMemoryRoomForTests(null));
  t.after(() => setNativeWalkTimingForTests(null));
  setMemoryRoomForTests({ capRows: 4_096, tMem: 1_000 });
  setNativeWalkTimingForTests({ stallMs: 2_500, cancelDeadlineMs: 60_000, now: () => clock });
  const scan = await scanned(root);
  assert.equal(scan.status, 'error');
  assert.match(scan.error ?? '', /^The native engine failed part-way past 1,000 items: the native walk made no progress for 2\.5 s at /);
  assert.ok((scan.error ?? '').endsWith(` ${NOT_RESTARTED} ${lastSeen(wedged)}`), `where the walk was last seen is named, as only that: ${scan.error ?? ''}`);
  assert.deepEqual(counted.starts, ['memory'], 'no legacy walk');
  assert.equal(counted.cancels, 1, 'the stalled walk was settled');
});
