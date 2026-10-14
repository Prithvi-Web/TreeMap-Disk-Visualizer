import { test, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type * as NativeCore from '../native/index';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-scanBoundaryEngines-data-');
process.env.TREEMAP_NO_GDU = '1';

import { skipOrFailOnCi } from './fixtures/ciSkip';
import { createScanRecord, findEmptyFolders, getScan, gduRuleFor, setWalkerDeviceForTests, startScan } from '../src/services/diskScanner';
import { findGduBinary, gduScan } from '../src/services/gduScanner';
import { getSettings, updateSettings } from '../src/services/settings';
import { storeOf, buildStoreFromTree, Flag } from '../src/services/scanStore';
import { settled } from '../src/utils/backgroundWrites';
import { boundaryKeyOf, currentBaseline, listSnapshots } from '../src/services/snapshots';
import { recordScanJournal, readJournal } from '../src/services/journal';
import { computeForecast } from '../src/services/forecast';
import { growthAlertFor } from '../src/services/scheduler';
import { boundaryReport } from '../src/services/boundaryReport';
import { setStorageModeForTests } from '../src/services/storageMode';
import { loadNative, resetNativeForTests, type ScanModule } from '../src/services/scan/native';
import { resetEngineBudgetForTests, setNativeLoadOptionsForTests } from '../src/services/engineBudget';
import { createApp } from '../src/server';
import { ensureWatchSession, stopAllWatchers, subscribe } from '../src/services/watcher';
import { setWatchImplForTests, type WatchListener } from '../src/platform/watchRegistry';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import {
  boundaryRecord,
  exclusionsOf,
  mountOutcome,
  scanBoundary,
  setBoundaryDepsForTests,
  setNeverDescendForTests,
  type MountTable,
  type ScanBoundaryRecord,
} from '../src/utils/mountBoundaries';
import type { FileNode, ScanResult, Snapshot } from '../src/models/types';

/**
 * Track U, U-24: Stay on this drive. With the boundary rule at `stay` (the
 * default) no engine enters a drive mounted inside the scanned folder; with
 * `cross` every one but gdu does, as before.
 *
 * Nothing is mounted: the mount table is injected (`setBoundaryDepsForTests`)
 * and names an ordinary folder, `mnt`, which holds one file. Every engine is
 * handed the same list, so what it does at `mnt` is exactly what it does at a
 * real mount point — and the not-entered count is taken from the list and the
 * walk's own records, never from the shape of the tree.
 */

const REPO = path.join(__dirname, '..');
const PREBUILT_MODULE = path.join(REPO, 'native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node');
const NO_TABLE = process.platform === 'win32' ? 'Windows keeps no mount table, so no scan there has a drive inside it to stop at' : null;

/** A table that names exactly these mount points. */
function tableNaming(paths: string[]): MountTable {
  return {
    source: 'mount',
    entries: paths.map((p) => ({ mountPoint: p, filesystem: 'apfs', options: ['apfs', 'local'], source: '/dev/disk99s1' })),
    reason: null,
  };
}

function useTable(paths: string[]): void {
  setBoundaryDepsForTests({ readTable: async () => tableNaming(paths), aliases: async () => () => [] });
}

after(() => {
  setBoundaryDepsForTests(null);
  setWalkerDeviceForTests(null);
  stopAllWatchers();
  setWatchImplForTests(null);
});

interface Tree {
  root: string;
  mnt: string;
  inside: string;
  other: string;
  plain: string;
}

/** root/{top.txt, mnt/inside.txt, other/plain.txt}, by its real path so the walk spells it as the table does. */
function tree(): Tree {
  const root = fs.realpathSync(fileTempDir('treemap-boundary-'));
  const mnt = path.join(root, 'mnt');
  const other = path.join(root, 'other');
  fs.mkdirSync(mnt);
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(root, 'top.txt'), 'x'.repeat(100));
  const inside = path.join(mnt, 'inside.txt');
  fs.writeFileSync(inside, 'y'.repeat(1500));
  const plain = path.join(other, 'plain.txt');
  fs.writeFileSync(plain, 'z'.repeat(700));
  return { root, mnt, inside, other, plain };
}

async function scanWith(root: string, rule: 'stay' | 'cross', engine: 'walker' | 'native' | 'gdu', opts: { incremental?: boolean } = {}): Promise<ScanResult> {
  await updateSettings({ scanBoundary: rule, engine });
  const s = await startScan(root, opts);
  await waitFor(() => s.status !== 'running', `the ${engine} scan of ${root} settling`);
  assert.equal(s.status, 'complete', s.error);
  return getScan(s.scanId) ?? s;
}

const pathsOf = (list: readonly { path: string }[]): string[] => list.map((m) => m.path).sort();

/* ─────────────────────────────── the walker ─────────────────────────────── */

test('walker, stay: the listed mount is a childless folder, its file is absent, it is not walked, and it is counted as not entered', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  useTable([f.mnt]);
  const s = await scanWith(f.root, 'stay', 'walker');
  const store = storeOf(s);
  const mnt = store.findByPath(f.mnt);
  assert.notEqual(mnt, -1, 'the mount point stays in the tree');
  assert.equal(store.isDir(mnt), true);
  assert.equal(store.childCount(mnt), 0, 'nothing inside it is listed');
  assert.equal(store.findByPath(f.inside), -1, 'the file on the mounted drive is not counted');
  assert.notEqual(store.findByPath(f.plain), -1, 'a folder on this drive is walked');
  assert.equal(s.walkedDirs, s.dirCount - 1, 'every folder but the mount point was listed');
  assert.ok(s.boundary, 'the boundary is kept on the record');
  assert.equal(s.boundary.rule, 'stay');
  assert.deepEqual(pathsOf(mountOutcome(s.boundary).notEntered), [f.mnt]);
  assert.deepEqual(mountOutcome(s.boundary).entered, []);
});

test('walker, cross: the listed mount is walked as before, and counted as entered', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  useTable([f.mnt]);
  const s = await scanWith(f.root, 'cross', 'walker');
  const store = storeOf(s);
  assert.notEqual(store.findByPath(f.inside), -1, 'the file on the mounted drive is counted');
  assert.equal(s.walkedDirs, s.dirCount, 'every folder was listed');
  assert.deepEqual(pathsOf(mountOutcome(s.boundary!).entered), [f.mnt]);
  assert.deepEqual(mountOutcome(s.boundary!).notEntered, []);
});

test('the detector: a folder on another device that the table does not list is counted, and still walked (it counts, it never gates)', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  useTable([]);
  setWalkerDeviceForTests((p, st) => (p === f.other ? st.dev + 1 : st.dev));
  try {
    const s = await scanWith(f.root, 'stay', 'walker');
    assert.equal(s.boundary?.walk.crossedUnlisted.count, 1);
    assert.deepEqual(s.boundary?.walk.crossedUnlisted.examples, [f.other]);
    assert.notEqual(storeOf(s).findByPath(f.plain), -1, 'the folder is walked all the same');
  } finally {
    setWalkerDeviceForTests(null);
  }
});

test('the detector does not count a crossing the table listed, under either rule', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  useTable([f.mnt]);
  setWalkerDeviceForTests((p, st) => (p === f.mnt ? st.dev + 1 : st.dev));
  try {
    for (const rule of ['stay', 'cross'] as const) {
      const s = await scanWith(f.root, rule, 'walker');
      assert.equal(s.boundary?.walk.crossedUnlisted.count, 0, `${rule}: a listed mount is no surprise`);
    }
  } finally {
    setWalkerDeviceForTests(null);
  }
});

/* ─────────────────────────────── the native engine ─────────────────────────────── */

/** The real module, passed through with every scanStart's options kept. */
function nativeRecording(t: TestContext): { starts: NativeCore.ScanStartOptions[] } | null {
  const file = process.env.TREEMAP_NATIVE_MODULE ?? PREBUILT_MODULE;
  if (!fs.existsSync(file)) {
    skipOrFailOnCi(t, `no native module at ${file}; build it with npm run build:native`);
    return null;
  }
  resetNativeForTests();
  resetEngineBudgetForTests();
  const direct = loadNative({ path: file });
  if (!direct.available) assert.fail(direct.reason);
  const core = direct.module as unknown as typeof NativeCore;
  const record = { starts: [] as NativeCore.ScanStartOptions[] };
  const module = {
    ...core,
    scanStart: (root: string, opts: NativeCore.ScanStartOptions): number => {
      record.starts.push(opts);
      return core.scanStart(root, opts);
    },
  };
  resetNativeForTests();
  setNativeLoadOptionsForTests({ path: file, requireModule: () => module });
  assert.equal(loadNative({ path: file, requireModule: () => module }).available, true);
  t.after(() => {
    resetNativeForTests();
    setNativeLoadOptionsForTests(null);
  });
  return record;
}

test('native, stay and cross: handed the scan’s own list, it stops at the mount under stay and enters it under cross', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const recording = nativeRecording(t);
  if (!recording) return;
  const f = tree();
  useTable([f.mnt]);

  const stay = await scanWith(f.root, 'stay', 'native');
  assert.equal(stay.engine, 'native', stay.fallbackReason ?? stay.engineReason);
  assert.ok(recording.starts.at(-1)?.neverDescend.includes(f.mnt), 'the mount is in the list the walk was given');
  let store = storeOf(stay);
  assert.equal(store.childCount(store.findByPath(f.mnt)), 0);
  assert.equal(store.findByPath(f.inside), -1);
  assert.equal(stay.walkedDirs, stay.dirCount - 1);
  assert.deepEqual(pathsOf(mountOutcome(stay.boundary!).notEntered), [f.mnt]);

  const cross = await scanWith(f.root, 'cross', 'native');
  assert.equal(cross.engine, 'native', cross.fallbackReason ?? cross.engineReason);
  assert.ok(!recording.starts.at(-1)?.neverDescend.includes(f.mnt), 'under cross the mount is not in the list');
  store = storeOf(cross);
  assert.notEqual(store.findByPath(f.inside), -1);
  assert.equal(cross.walkedDirs, cross.dirCount);
  assert.deepEqual(pathsOf(mountOutcome(cross.boundary!).entered), [f.mnt]);
});

/* ─────────────────────────────── gdu ─────────────────────────────── */

test('gdu, stay: no shard is started for the listed mount, and it is counted as not entered all the same', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const real = await findGduBinary();
  if (!real) return skipOrFailOnCi(t, 'gdu not available on this machine');
  const f = tree();
  useTable([f.mnt]);
  // The shard seam: a gdu that writes down the folder each run was given, then is the real gdu.
  const wrapDir = fileTempDir('treemap-boundary-gdu-');
  const log = path.join(wrapDir, 'shards.log');
  const wrapper = path.join(wrapDir, 'gdu');
  fs.writeFileSync(wrapper, `#!/bin/sh\nfor last; do :; done\nprintf '%s\\n' "$last" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });

  const scan = createScanRecord(f.root);
  scan.boundary = boundaryRecord(await scanBoundary(f.root, 'stay'));
  await gduScan(scan, wrapper, () => undefined);
  const shards = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(shards, [f.other], 'one shard, for the folder on this drive');
  const store = storeOf(scan);
  assert.equal(store.findByPath(f.inside), -1);
  assert.deepEqual(pathsOf(mountOutcome(scan.boundary).notEntered), [f.mnt]);
});

test('gdu is not used under cross while drives are mounted inside the folder: it stops at every drive', () => {
  const base = { forced: 'auto' as const, rootIsDir: true, incremental: false, ignoreCount: 0, noGdu: false, platform: 'darwin' as NodeJS.Platform };
  assert.equal(gduRuleFor({ ...base, crossesMounts: false }), null);
  assert.equal(gduRuleFor(base), null, 'nothing to cross: gdu may run');
  assert.match(gduRuleFor({ ...base, crossesMounts: true }) ?? '', /mounted inside the folder.*gdu.*stops at every drive/);
});

/* ─────────────────────────────── the record’s outcome ─────────────────────────────── */

/** A boundary record by hand: these mounts beneath `root`, none under a fixed folder. */
function handRecord(root: string, rule: 'stay' | 'cross', mounts: string[]): ScanBoundaryRecord {
  return boundaryRecord({
    rule,
    source: 'mount',
    reason: null,
    mounts: mounts.map((p) => ({ path: p, filesystem: 'apfs', source: '/dev/disk99s1', underFixed: false })),
    fixed: [],
    neverDescend: rule === 'stay' ? mounts : [],
  });
}

test('the not-entered count comes from the list and the walk’s records, whatever the store holds: aggregate mode, or a store with no row for the mount (gdu drops the mount point)', () => {
  const root = '/r';
  const tree: FileNode = { name: 'r', path: root, size: 3, type: 'dir', modifiedAt: 0, isHidden: false, children: [{ name: 'a.txt', path: '/r/a.txt', size: 3, type: 'file', modifiedAt: 0, isHidden: false }] };
  const scan = createScanRecord(root);
  scan.store = buildStoreFromTree(tree);
  scan.status = 'complete';
  scan.boundary = handRecord(root, 'stay', ['/r/mnt']);
  setStorageModeForTests('aggregate', scan);
  const report = boundaryReport(scan);
  assert.equal(report.rule, 'stay');
  assert.equal(report.notEntered.count, 1, 'no row is no evidence of anything');
  assert.deepEqual(report.notEntered.examples, ['/r/mnt']);
});

test('nested mounts: under cross the outer subtree is counted once; under stay the inner one is not reached at all', () => {
  const root = '/r';
  const cross = mountOutcome(handRecord(root, 'cross', ['/r/mnt', '/r/mnt/inner']));
  assert.deepEqual(pathsOf(cross.entered), ['/r/mnt'], 'only the outermost entered mount carries bytes');
  const stay = mountOutcome(handRecord(root, 'stay', ['/r/mnt', '/r/mnt/inner']));
  assert.deepEqual(pathsOf(stay.notEntered), ['/r/mnt']);
  assert.deepEqual(pathsOf(stay.unreached), ['/r/mnt/inner']);
  const tree: FileNode = {
    name: 'r', path: root, size: 900, type: 'dir', modifiedAt: 0, isHidden: false,
    children: [{
      name: 'mnt', path: '/r/mnt', size: 900, type: 'dir', modifiedAt: 0, isHidden: false,
      children: [
        { name: 'inner', path: '/r/mnt/inner', size: 400, type: 'dir', modifiedAt: 0, isHidden: false, children: [{ name: 'i.bin', path: '/r/mnt/inner/i.bin', size: 400, type: 'file', modifiedAt: 0, isHidden: false }] },
        { name: 'o.bin', path: '/r/mnt/o.bin', size: 500, type: 'file', modifiedAt: 0, isHidden: false },
      ],
    }],
  };
  const scan = createScanRecord(root);
  scan.store = buildStoreFromTree(tree);
  scan.status = 'complete';
  scan.boundary = handRecord(root, 'cross', ['/r/mnt', '/r/mnt/inner']);
  const report = boundaryReport(scan);
  assert.equal(report.entered.count, 1);
  assert.equal(report.entered.bytes, 900, 'the inner mount’s 400 bytes are inside the outer one’s 900, not added again');
});

test('a mount beneath a folder the walk was refused, or one the scan was told not to scan, is not reached — not "not entered"', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  if (process.getuid?.() === 0) return t.skip('root reads a mode-000 folder');
  const f = tree();
  const locked = path.join(f.root, 'locked');
  const behind = path.join(locked, 'drive');
  fs.mkdirSync(behind, { recursive: true });
  const skipped = path.join(f.root, 'skipme', 'drive');
  fs.mkdirSync(skipped, { recursive: true });
  fs.chmodSync(locked, 0o000);
  t.after(() => fs.chmodSync(locked, 0o755));
  useTable([f.mnt, behind, skipped]);
  await updateSettings({ ignore: [{ pattern: 'skipme', scope: 'scan' }] });
  try {
    const s = await scanWith(f.root, 'stay', 'walker');
    const o = mountOutcome(s.boundary!);
    assert.deepEqual(pathsOf(o.notEntered), [f.mnt]);
    assert.deepEqual(pathsOf(o.unreached), [behind, skipped].sort());
  } finally {
    await updateSettings({ ignore: [] });
  }
});

test('a mount beneath a folder the walk could not read (an injected EIO) is not reached either — not "not entered" (TS review R6)', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  const broken = path.join(f.root, 'broken');
  const behind = path.join(broken, 'drive');
  fs.mkdirSync(behind, { recursive: true });
  useTable([f.mnt, behind]);
  const real = fs.promises.readdir;
  (fs.promises as { readdir: unknown }).readdir = function (p: fs.PathLike, ...rest: unknown[]) {
    if (String(p) === broken) {
      return Promise.reject(Object.assign(new Error(`EIO: i/o error, scandir '${broken}'`), { code: 'EIO', errno: -5, syscall: 'scandir', path: broken }));
    }
    return (real as (...a: unknown[]) => Promise<unknown>).call(fs.promises, p, ...rest);
  };
  let s: ScanResult;
  try {
    s = await scanWith(f.root, 'stay', 'walker');
  } finally {
    (fs.promises as { readdir: unknown }).readdir = real;
  }
  assert.equal(s.unreadableDirs, 1, 'the failed listing was counted');
  const o = mountOutcome(s.boundary!);
  assert.deepEqual(pathsOf(o.notEntered), [f.mnt], 'only a drive the walk got to is "not entered"');
  assert.deepEqual(pathsOf(o.unreached), [behind], 'the walk never got near it');
});

/* ─────────────────────────────── incremental rescans ─────────────────────────────── */

test('incremental: a listing cached under cross, then stay with the mount touched — it stays childless', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  useTable([f.mnt]);
  await scanWith(f.root, 'cross', 'walker');
  await settled();
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(f.mnt, later, later);
  const s = await scanWith(f.root, 'stay', 'walker', { incremental: true });
  const store = storeOf(s);
  assert.equal(store.childCount(store.findByPath(f.mnt)), 0);
  assert.equal(store.findByPath(f.inside), -1);
});

test('incremental: stay, then cross with the mount unchanged — the drive is walked, because the cache records the rule', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  useTable([f.mnt]);
  await scanWith(f.root, 'stay', 'walker');
  await settled();
  const s = await scanWith(f.root, 'cross', 'walker', { incremental: true });
  assert.notEqual(storeOf(s).findByPath(f.inside), -1, 'the mounted drive’s file is counted');
});

test('incremental: a listing cached before the drive was mounted is not reused inside it — the walk checks every folder it is handed', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  useTable([]);
  const first = await scanWith(f.root, 'stay', 'walker');
  assert.notEqual(storeOf(first).findByPath(f.inside), -1, 'before the mount, mnt is an ordinary folder');
  await settled();
  useTable([f.mnt]);
  const s = await scanWith(f.root, 'stay', 'walker', { incremental: true });
  assert.ok((s.cachedDirs ?? 0) > 0, 'the cache was used');
  const store = storeOf(s);
  assert.equal(store.childCount(store.findByPath(f.mnt)), 0, 'the cached listing of mnt is not used');
  assert.equal(store.findByPath(f.inside), -1);
});

/* ─────────────────────────────── history ─────────────────────────────── */

test('a snapshot records the boundary when it left a drive out, and a scan with nothing mounted inside records nothing new', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  useTable([f.mnt]);
  await scanWith(f.root, 'stay', 'walker');
  await settled();
  const snaps = await listSnapshots(f.root);
  assert.deepEqual(snaps.at(-1)?.boundary, { rule: 'stay', notEntered: [f.mnt] });

  const plain = tree();
  useTable([]);
  await scanWith(plain.root, 'stay', 'walker');
  await settled();
  const plainSnap = (await listSnapshots(plain.root)).at(-1);
  assert.ok(plainSnap, 'a snapshot was saved');
  assert.equal(Object.prototype.hasOwnProperty.call(plainSnap, 'boundary'), false, 'byte for byte as before');
});

function snapshotFor(root: string, takenAt: number, totalSize: number, boundary?: Snapshot['boundary']): Snapshot {
  return {
    id: `snap-${takenAt}`,
    rootPath: root,
    takenAt,
    totalSize,
    fileCount: 3,
    dirCount: 3,
    topEntries: [{ name: 'other', path: path.join(root, 'other'), size: totalSize, type: 'dir' }],
    hasTree: false,
    coverage: 'complete',
    ...(boundary ? { boundary } : {}),
  };
}

test('the journal writes nothing across a change of boundary, and still records a real change within one', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  useTable([f.mnt]);
  const s = await scanWith(f.root, 'stay', 'walker');
  const big = 500 * 1024 * 1024;
  const before = (await readJournal(1000)).length;
  // The previous scan crossed into the drive: 500 MB more, which is the rule, not a change on disk.
  assert.equal(await recordScanJournal(s, snapshotFor(f.root, Date.now() - 86_400_000, big)), 0);
  assert.equal((await readJournal(1000)).length, before, 'no line was written');
  // The same boundary, and the 500 MB really went: that is an entry.
  assert.ok(await recordScanJournal(s, snapshotFor(f.root, Date.now() - 86_400_000, big, { rule: 'stay', notEntered: [f.mnt] })) >= 1);
});

test('a scheduled scan raises no growth alert across a change of boundary, and still raises one for real growth within one', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  useTable([f.mnt]);
  const crossed = await scanWith(f.root, 'cross', 'walker');
  const sched = { id: 's1', path: f.root, intervalHours: 24, thresholdBytes: 1, enabled: true };
  // The previous scan stayed on the drive: 1,500 bytes fewer, the drive's file.
  const stayedBefore = snapshotFor(f.root, Date.now() - 86_400_000, 800, { rule: 'stay', notEntered: [f.mnt] });
  assert.equal(growthAlertFor(sched, f.root, stayedBefore, crossed), null, 'the drive joining the count is not growth');
  // A previous scan that went into the same drive (a crossing scan records the drives it went into: the SEC-1 review, L2).
  const crossedBefore = snapshotFor(f.root, Date.now() - 86_400_000, 800, { rule: 'cross', entered: [f.mnt] });
  const alert = growthAlertFor(sched, f.root, crossedBefore, crossed);
  assert.ok(alert, 'the same boundary, and the folder grew: that is an alert');
  assert.equal(alert.delta, storeOf(crossed).size(storeOf(crossed).rootId) - 800);
  assert.equal(growthAlertFor(sched, f.root, snapshotFor(f.root, Date.now() - 86_400_000, 800), crossed), null, 'one that met no drive: the drive joining the count is not growth');
  // A snapshot of another folder is no previous size of this one: a link the scheduler resolved
  // and the scan then followed elsewhere (QA D78), or any history read by another path.
  assert.equal(growthAlertFor(sched, f.root, snapshotFor(f.other, Date.now() - 86_400_000, 800, { rule: 'cross', entered: [f.mnt] }), crossed), null, 'another folder’s snapshot is not compared');
});

test('the forecast fits only the scans since the boundary last changed', () => {
  const day = 86_400_000;
  const now = Date.UTC(2026, 9, 2);
  const root = '/r';
  const crossed = [0, 1, 2, 3, 4, 5].map((d) => snapshotFor(root, now - (20 - d) * day, 400e9 + d * 1e9));
  const stayed = [0, 1].map((d) => snapshotFor(root, now - (10 - d) * day, 360e9 + d * 1e9, { rule: 'stay', notEntered: ['/r/mnt'] }));
  const f = computeForecast([...crossed, ...stayed], 100e9, now);
  assert.equal(f.snapshotCount, 2, 'the six earlier scans counted the mounted drives');
  assert.equal(f.status, 'insufficient');
  assert.match(f.reason ?? '', /stopped at different drives/);
  const allSame = computeForecast(crossed, 100e9, now);
  assert.equal(allSame.snapshotCount, 6, 'one boundary throughout: every scan counts');
});

/* ─────────────────────────────── Empty Folders ─────────────────────────────── */

test('Empty Folders never offers a drive the scan did not enter, nor the folder holding it', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  const holder = path.join(f.root, 'Volumes');
  const drive = path.join(holder, 'iOS_22E238');
  fs.mkdirSync(drive, { recursive: true });
  fs.writeFileSync(path.join(drive, 'system.img'), 'q');
  const empty = path.join(f.root, 'really-empty');
  fs.mkdirSync(empty);
  useTable([drive]);
  const s = await scanWith(f.root, 'stay', 'walker');
  // The scan's record of what it never listed is the store's mark (U-4's
  // Flag.Unlisted), set at settle from the scan's own never-descend list.
  const store = storeOf(s);
  assert.equal(store.flag(store.findByPath(drive), Flag.Unlisted), true, 'the drive not entered is marked not listed');
  assert.equal(store.flag(store.findByPath(holder), Flag.Unlisted), false, 'the folder holding it was listed');
  assert.equal(store.flag(store.findByPath(empty), Flag.Unlisted), false);
  // The tree alone (no second look on disk): the mark is what keeps them out.
  const offered = findEmptyFolders(store, true).folders.map((x) => x.path);
  assert.ok(!offered.includes(drive), 'the drive is not empty: it was not looked into');
  assert.ok(!offered.includes(holder), 'nor is the folder holding it');
  assert.ok(offered.includes(empty), 'a genuinely empty folder is still offered');
  const route = await emptyFoldersRoute(s.scanId);
  assert.ok(!route.includes(drive) && !route.includes(holder), 'and the route answers the same');
  assert.ok(route.includes(empty));
});

for (const engine of ['native', 'gdu'] as const) {
  for (const depth of ['directly in the root', 'two folders down'] as const) {
    test(`Empty Folders never offers a drive the scan did not enter, nor a folder holding it — ${engine}, the drive ${depth} (the SEC-1 review, L6)`, async (t) => {
      if (NO_TABLE) return t.skip(NO_TABLE);
      if (engine === 'native' && !nativeRecording(t)) return;
      if (engine === 'gdu' && !(await findGduBinary())) return skipOrFailOnCi(t, 'gdu not available on this machine');
      const root = fs.realpathSync(fileTempDir('treemap-boundary-empty-'));
      const holder = depth === 'directly in the root' ? root : path.join(root, 'a', 'b');
      fs.mkdirSync(holder, { recursive: true });
      // A drive the walk does not enter is, to the volume beneath it, an empty folder.
      const drive = path.join(holder, 'mnt');
      fs.mkdirSync(drive);
      const empty = path.join(root, 'really-empty');
      fs.mkdirSync(empty);
      fs.mkdirSync(path.join(root, 'other'));
      fs.writeFileSync(path.join(root, 'other', 'f.txt'), 'x');
      useTable([drive]);
      const saved = process.env.TREEMAP_NO_GDU;
      if (engine === 'gdu') delete process.env.TREEMAP_NO_GDU;
      let s: ScanResult;
      try {
        s = await scanWith(root, 'stay', engine);
      } finally {
        if (saved === undefined) delete process.env.TREEMAP_NO_GDU;
        else process.env.TREEMAP_NO_GDU = saved;
        await updateSettings({ scanBoundary: 'stay', engine: 'walker' });
      }
      assert.ok(s.engine === engine || s.engine === `${engine}-turbo`, `${s.engine}: ${s.fallbackReason ?? s.engineReason}`);
      const above = depth === 'directly in the root' ? [] : [holder, path.dirname(holder)];
      const offered = findEmptyFolders(storeOf(s), true).folders.map((x) => x.path);
      const route = await emptyFoldersRoute(s.scanId);
      for (const [what, list] of [['the tree', offered], ['the route', route]] as const) {
        assert.ok(!list.includes(drive), `${what}: the drive is not empty, it was not looked into (${list.join(', ')})`);
        for (const p of above) assert.ok(!list.includes(p), `${what}: nor ${p}, which holds it`);
        // The route offers a gdu scan's folders not at all, and says why (GDU_EMPTY_FOLDERS_REASON, U-12).
        if (what === 'the route' && engine === 'gdu') assert.deepEqual(list, [], 'a gdu scan offers none from the route');
        else assert.ok(list.includes(empty), `${what}: a genuinely empty folder is still offered`);
      }
    });
  }
}

async function emptyFoldersRoute(scanId: string): Promise<string[]> {
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(REPO, 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `/api/empty-folders?scanId=${scanId}` }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => resolve(buf));
      }).on('error', reject);
    });
    return (JSON.parse(body) as { folders: { path: string }[] }).folders.map((x) => x.path);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/* ─────────────────────────────── settings ─────────────────────────────── */

test('scanBoundary: Stay on this drive by default; a hand-edited value is forgiven to it; the API is strict', async () => {
  await updateSettings({ scanBoundary: 'stay' });
  assert.equal((await getSettings()).scanBoundary, 'stay');
  for (const [raw, want] of [['cross', 'cross'], ['stay', 'stay'], ['CROSS', 'stay'], [true, 'stay'], [null, 'stay'], [['cross'], 'stay']] as const) {
    assert.equal((await updateSettings({ scanBoundary: raw })).scanBoundary, want, `scanBoundary ${JSON.stringify(raw)}`);
  }
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(REPO, 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const put = (body: unknown): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: '/api/settings', method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
    });
    r.on('error', reject);
    r.end(payload);
  });
  try {
    const ok = await put({ scanBoundary: 'cross' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.scanBoundary, 'cross');
    for (const bad of ['Cross', '', 'off', 1, true, null, ['stay']]) {
      const r = await put({ scanBoundary: bad });
      assert.equal(r.status, 400, `scanBoundary ${JSON.stringify(bad)}`);
      assert.equal(r.body.code, 'BAD_SETTING');
      assert.match(r.body.error, /"scanBoundary" must be "stay" or "cross"/);
    }
    assert.equal((await getSettings()).scanBoundary, 'cross', 'a refused value changed nothing');
    const nothing = await put({});
    assert.match(nothing.body.error, /"scanBoundary"/, 'the key is named among the ones a body may carry');
  } finally {
    await updateSettings({ scanBoundary: 'stay' });
    await new Promise<void>((r) => server.close(() => r()));
  }
});

/* ─────────────────────────────── Live mode ─────────────────────────────── */

test('Live mode drops a change inside a drive the scan did not enter — the tree is unchanged, and the drop is counted', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  useTable([f.mnt]);
  const s = await scanWith(f.root, 'stay', 'walker');
  // The OS watch stands in: the test delivers each change itself, so nothing waits on the operating system.
  const listeners: WatchListener[] = [];
  setWatchImplForTests((_target, _opts, listener) => {
    listeners.push(listener);
    return { close() {}, on() { return undefined; } };
  });
  try {
    const session = await ensureWatchSession(s as ScanResult & { root: FileNode });
    const stop = subscribe(session, () => {});
    t.after(stop);
    assert.equal(listeners.length, 1, 'one recursive watch on the root');
    fs.writeFileSync(path.join(f.mnt, 'new-on-the-drive.bin'), 'n'.repeat(4096));
    fs.writeFileSync(path.join(f.other, 'new-here.bin'), 'h'.repeat(2048));
    listeners[0]('rename', 'mnt/new-on-the-drive.bin');
    listeners[0]('rename', 'other/new-here.bin');
    const store = storeOf(s);
    await waitFor(() => store.findByPath(path.join(f.other, 'new-here.bin')) !== -1, 'the change on this drive reaching the tree');
    assert.equal(session.droppedOutsideBoundary, 1, 'the change on the other drive was dropped, and counted');
    assert.equal(store.findByPath(path.join(f.mnt, 'new-on-the-drive.bin')), -1, 'and is not in the tree');
    assert.equal(store.childCount(store.findByPath(f.mnt)), 0);
  } finally {
    setWatchImplForTests(null);
  }
});

test('Live mode after a scan of the Data volume typed another way — through a link in its parents, or in another case — drops a change under that volume’s /Volumes, where every drive appears, as it does for the root typed as it is', async (t) => {
  if (process.platform !== 'darwin') return t.skip('the Data volume is macOS’s');
  // Live mode took the folders the scan never listed from the root as typed, so for such a root it had
  // none, and a file on a drive under /Volumes — one mounted later, or any when the table was unknown —
  // was added to the live tree (the SEC-2b review, F1.6). A link here to /System stands in for
  // /Volumes/<the boot volume>, which every Mac has.
  const home = fs.realpathSync(fileTempDir('treemap-live-data-volume-'));
  fs.symlinkSync('/System', path.join(home, 'boot'));
  const roots = ['/System/Volumes/Data', path.join(home, 'boot', 'Volumes', 'Data')];
  if (fs.realpathSync.native('/System/volumes') === '/System/Volumes') roots.push('/System/volumes/Data');
  if (fs.realpathSync.native('/System/Volumes/data') === '/System/Volumes/Data') roots.push('/System/Volumes/data');
  const listeners: WatchListener[] = [];
  setWatchImplForTests((_target, _opts, listener) => {
    listeners.push(listener);
    return { close() {}, on() { return undefined; } };
  });
  const dropped: Record<string, number> = {};
  try {
    for (const root of roots) {
      const s = createScanRecord(root);
      s.status = 'complete';
      s.finishedAt = Date.now();
      s.root = { name: path.basename(root), path: root, size: 0, type: 'dir', modifiedAt: 0, isHidden: false, children: [] };
      const fixed = ['/System/Volumes', '/Volumes', '/dev'];
      s.boundary = { ...handRecord(root, 'stay', []), mounts: null, fixed, neverDescend: fixed }; // the table unknown
      listeners.length = 0;
      const session = await ensureWatchSession(s as ScanResult & { root: FileNode });
      const stop = subscribe(session, () => {});
      try {
        listeners[0]('rename', path.join('Volumes', 'MountedLater', 'b.bin')); // dropped, or not, before anything is looked at
        dropped[root] = session.droppedOutsideBoundary;
      } finally {
        stop();
      }
    }
  } finally {
    setWatchImplForTests(null);
  }
  assert.deepEqual(dropped, Object.fromEntries(roots.map((root) => [root, 1])));
});

/* ─────────────────────────────── CI ─────────────────────────────── */

test('the Linux test legs mount a tmpfs inside a folder before the suite, and name it in TREEMAP_TEST_NESTED_MOUNT', () => {
  const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'test.yml'), 'utf8');
  const name = '      - name: Mount a drive inside a folder for the scan-boundary tests (Linux)\n';
  const at = ci.indexOf(name);
  assert.notEqual(at, -1, 'test.yml has the step');
  const end = ci.indexOf('\n      - name: ', at + name.length);
  const step = ci.slice(at, end === -1 ? undefined : end);
  assert.match(step, /if: \$\{\{ !cancelled\(\) && runner\.os == 'Linux'/, 'on the Linux legs only');
  assert.match(step, /sudo mount -t tmpfs -o size=16m,mode=0777 tmpfs "\$root\/mnt"/, 'a real mount, inside a folder');
  assert.match(step, /echo "TREEMAP_TEST_NESTED_MOUNT=\$root\/mnt" >> "\$GITHUB_ENV"/, 'named for the tests');
  assert.ok(at < ci.indexOf('      - name: Run the test suite\n'), 'before the suite runs');
});

/* ─────────────────────────────── comparing two scans ─────────────────────────────── */

test('two scans that stopped at different drives are not compared (409 BOUNDARY_CHANGED); two with one boundary are', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  useTable([f.mnt]);
  const stay = await scanWith(f.root, 'stay', 'walker');
  const cross = await scanWith(f.root, 'cross', 'walker');
  const stayAgain = await scanWith(f.root, 'stay', 'walker');
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(REPO, 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const get = (url: string): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
    }).on('error', reject);
  });
  try {
    const across = await get(`/api/compare?scanIdA=${stay.scanId}&scanIdB=${cross.scanId}`);
    assert.equal(across.status, 409);
    assert.equal(across.body.code, 'BOUNDARY_CHANGED');
    assert.match(across.body.error, /counted different disks/);
    const within = await get(`/api/compare?scanIdA=${stay.scanId}&scanIdB=${stayAgain.scanId}`);
    assert.equal(within.status, 200, JSON.stringify(within.body));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a scan that asks for gdu under cross, with a drive mounted inside, runs on the walker and says why', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  useTable([f.mnt]);
  const saved = process.env.TREEMAP_NO_GDU;
  delete process.env.TREEMAP_NO_GDU;
  try {
    await updateSettings({ scanBoundary: 'cross', engine: 'gdu' });
    const s = await startScan(f.root);
    await waitFor(() => s.status !== 'running', 'the scan settling');
    assert.ok(s.engine === 'walker' || s.engine === 'turbo-walker', `the walker ran, not ${s.engine}`);
    assert.match(s.fallbackReason ?? '', /mounted inside the folder.*gdu stops at every drive.*asked for gdu/);
    assert.notEqual(storeOf(s).findByPath(f.inside), -1, 'and the drive was counted, as the person asked');
  } finally {
    if (saved === undefined) delete process.env.TREEMAP_NO_GDU;
    else process.env.TREEMAP_NO_GDU = saved;
    await updateSettings({ scanBoundary: 'stay', engine: 'walker' });
  }
});

test('exclusionsOf: the fixed folders below the root and, under stay, the drives not entered — a record without a boundary reads the fixed list', () => {
  const drive = '/Library/Developer/CoreSimulator/Volumes/iOS_22E238';
  const stay = { ...handRecord('/', 'stay', [drive]), fixed: ['/Volumes', '/dev'], neverDescend: ['/Volumes', '/dev', drive] };
  assert.deepEqual(exclusionsOf(stay, '/', 'darwin'), ['/Volumes', '/dev', drive]);
  assert.deepEqual(exclusionsOf(stay, '/Library', 'darwin'), [drive], 'only what lies below the root');
  const cross = { ...handRecord('/', 'cross', [drive]), fixed: ['/Volumes'], neverDescend: ['/Volumes'] };
  assert.deepEqual(exclusionsOf(cross, '/', 'darwin'), ['/Volumes'], 'under cross the drive was walked');
  assert.ok(exclusionsOf(undefined, '/', 'darwin').includes('/Volumes'), 'no boundary on the record: the fixed list, which every engine honours');
  assert.deepEqual(exclusionsOf(undefined, '/Volumes/Backup', 'darwin'), [], 'a fixed folder above the root is not this scan’s');
});

test('exclusionsOf: a scan of the Data volume also never lists the fixed folders as that volume spells them — /Volumes, where every drive appears, with or without a mount table (the SEC-1 review, M2)', () => {
  const data = '/System/Volumes/Data';
  const backup = `${data}/Volumes/Backup`;
  const fixed = ['/System/Volumes', '/Volumes', '/dev', '/home'];
  const stay = { ...handRecord(data, 'stay', [backup]), fixed, neverDescend: [...fixed, backup] };
  assert.deepEqual(exclusionsOf(stay, data, 'darwin'), [backup, `${data}/System/Volumes`, `${data}/Volumes`, `${data}/dev`, `${data}/home`]);
  const unknown = { ...stay, mounts: null, neverDescend: [...fixed] };
  assert.deepEqual(exclusionsOf(unknown, data, 'darwin'), [`${data}/System/Volumes`, `${data}/Volumes`, `${data}/dev`, `${data}/home`], 'no table: a drive mounted at any time is under /Volumes all the same');
  assert.ok(exclusionsOf(undefined, data, 'darwin').includes(`${data}/Volumes`), 'no boundary on the record: the fixed list, in both spellings');
  assert.deepEqual(exclusionsOf(stay, `${data}/Users/me`, 'darwin'), [], 'a folder inside the Data volume holds none of them');
  assert.deepEqual(exclusionsOf(stay, `${data}/System`, 'darwin'), [`${data}/System/Volumes`], 'one that holds a fixed folder, in its spelling, does');
  assert.deepEqual(exclusionsOf(stay, '/', 'darwin'), [...fixed, backup], 'a scan of / is as it was');
  assert.deepEqual(exclusionsOf(undefined, data, 'linux'), [], 'Linux has no Data volume');
});

test('Trends and What’s new never compare two snapshots that stopped at different drives (409 BOUNDARY_CHANGED); two with one boundary are compared', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  useTable([f.mnt]);
  for (const rule of ['cross', 'stay', 'stay'] as const) {
    await scanWith(f.root, rule, 'walker');
    await settled();
  }
  const snaps = await listSnapshots(f.root);
  assert.equal(snaps.length, 3, 'one snapshot a scan');
  const [crossed, stayed, stayedAgain] = snaps;
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(REPO, 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const get = (url: string): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
    }).on('error', reject);
  });
  try {
    const across = await get(`/api/snapshots/compare?a=${crossed.id}&b=${stayed.id}`);
    assert.equal(across.status, 409, JSON.stringify(across.body));
    assert.equal(across.body.code, 'BOUNDARY_CHANGED');
    assert.match(across.body.error, /counted different disks/);
    const within = await get(`/api/snapshots/compare?a=${stayed.id}&b=${stayedAgain.id}`);
    assert.equal(within.status, 200, JSON.stringify(within.body));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a drive a crossing scan went into and the next one did not find is a change of boundary, not growth or space freed: 409 BOUNDARY_CHANGED; the same drive twice compares (the SEC-1 review, L2)', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  useTable([f.mnt]);
  await scanWith(f.root, 'cross', 'walker');
  await settled();
  await scanWith(f.root, 'cross', 'walker');
  await settled();
  useTable([]); // the drive was unplugged: the folder the walk meets is no longer a drive
  try {
    await scanWith(f.root, 'cross', 'walker');
    await settled();
  } finally {
    useTable([f.mnt]);
  }
  const [withDrive, again, without] = await listSnapshots(f.root);
  assert.deepEqual(withDrive.boundary, { rule: 'cross', entered: [f.mnt] });
  assert.equal(without.boundary, undefined, 'a scan that met no drive records none — as every scan before U-24 did');
  const across = await apiGet(`/api/snapshots/compare?a=${again.id}&b=${without.id}`);
  assert.deepEqual([across.status, across.body.code], [409, 'BOUNDARY_CHANGED'], JSON.stringify(across.body));
  assert.match(across.body.error, /the first went into 1 drive mounted inside it, the second left no drive out/);
  const within = await apiGet(`/api/snapshots/compare?a=${withDrive.id}&b=${again.id}`);
  assert.equal(within.status, 200, JSON.stringify(within.body));
});

test('the boundary key: a crossing scan names the drives it went into, and a snapshot with no boundary keeps the empty key, so history from before U-24 compares as it did (the SEC-1 review, L2)', () => {
  const x = '/r/mnt';
  const y = '/r/other-drive';
  const crossX = { rule: 'cross' as const, entered: [x] };
  assert.equal(boundaryKeyOf(undefined), '', 'before U-24, or no drive met');
  assert.notEqual(boundaryKeyOf({ ...crossX, entered: [x] }), boundaryKeyOf(undefined), 'a drive went in, then was gone');
  assert.notEqual(boundaryKeyOf(crossX), boundaryKeyOf({ rule: 'cross', entered: [y] }), 'another drive');
  assert.notEqual(boundaryKeyOf(crossX), boundaryKeyOf({ rule: 'stay', notEntered: [x] }), 'one drive counted, and the same drive left out, are two disks');
  assert.equal(boundaryKeyOf(crossX), boundaryKeyOf({ rule: 'cross', entered: [x] }), 'the same drive twice');
  assert.equal(boundaryKeyOf({ rule: 'cross', entered: [] }), '', 'no drive went in: as a scan that met none');
  assert.equal(boundaryKeyOf({ rule: 'stay', notEntered: [x, y] }), `${x}\n${y}`, 'a stay key is as it was');
  const snap = (takenAt: number, boundary?: Snapshot['boundary']): Snapshot => ({ id: String(takenAt), rootPath: '/r', takenAt, totalSize: takenAt, fileCount: 1, dirCount: 1, topEntries: [], coverage: 'complete', ...(boundary ? { boundary } : {}) });
  const ids = (list: Snapshot[]): string[] => list.map((s) => s.id);
  assert.deepEqual(ids(currentBaseline([snap(1), snap(2), snap(3)])), ['1', '2', '3'], 'history from before U-24 is one run, as it was');
  assert.deepEqual(ids(currentBaseline([snap(1), snap(2, crossX), snap(3, crossX)])), ['2', '3'], 'the forecast starts where the drive went in');
  assert.deepEqual(ids(currentBaseline([snap(1, crossX), snap(2, crossX), snap(3)])), ['3'], 'and again where it was gone');
});

/** GET `url` from a fresh server; the body parsed. */
async function apiGet(url: string): Promise<{ status: number; body: any }> {
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(REPO, 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    return await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: url }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
      }).on('error', reject);
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('the time slider never overlays a snapshot that stopped at other drives: no previous sizes across a change of boundary, the overlay within one', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  useTable([f.mnt]);
  for (const rule of ['cross', 'stay', 'stay'] as const) {
    await scanWith(f.root, rule, 'walker');
    await settled();
  }
  const [, stayed, stayedAgain] = await listSnapshots(f.root);
  const at = (s: Snapshot): string => `/api/snapshots/tree?path=${encodeURIComponent(f.root)}&at=${s.takenAt}`;
  const across = await apiGet(at(stayed));
  assert.equal(across.status, 200, JSON.stringify(across.body));
  assert.equal(across.body.snapshot.id, stayed.id);
  assert.equal(across.body.prevTakenAt, null, 'the scan before it went into the drive: its sizes are no overlay for this one');
  assert.ok(
    (across.body.nodes as { prevSize?: unknown }[]).every((n) => n.prevSize === undefined),
    'no node carries a previous size (the mount point would read as 1,500 bytes freed)',
  );
  const within = await apiGet(at(stayedAgain));
  assert.equal(within.body.prevTakenAt, stayed.takenAt, 'one boundary: the overlay is drawn');
  assert.ok((within.body.nodes as { prevSize?: unknown }[]).some((n) => typeof n.prevSize === 'number'));
});

/* ───────── a root on the Data volume, walked by every engine (the SEC-1 review's notes, scan side) ───────── */

/**
 * A scan of /System/Volumes/Data never descends into the fixed folders as that volume spells them —
 * /System/Volumes/Data/Volumes is the root's /Volumes, where every drive appears. A test cannot scan that
 * volume, so it stands in: this file's temp folder by the Data volume's spelling (macOS firmlinks /private
 * there), with one of its folders added to the fixed list by the root's spelling (`setNeverDescendForTests`).
 */
const DATA_VOLUME = '/System/Volumes/Data';

for (const engine of ['walker', 'native', 'gdu'] as const) {
  test(`${engine}: a walk of a folder on the Data volume, by that volume's spelling, does not descend into a fixed folder spelled that way`, async (t) => {
    if (process.platform !== 'darwin') return t.skip('the Data volume is macOS’s');
    if (engine === 'native' && !nativeRecording(t)) return;
    if (engine === 'gdu' && !(await findGduBinary())) return skipOrFailOnCi(t, 'gdu not available on this machine');
    const f = tree();
    const onData = DATA_VOLUME + f.root;
    if (!fs.existsSync(onData)) return t.skip(`${onData} is not this temp folder's Data-volume spelling here`);
    useTable([]);
    setNeverDescendForTests([f.other]);
    if (engine === 'gdu') delete process.env.TREEMAP_NO_GDU;
    try {
      const s = await scanWith(onData, 'stay', engine);
      assert.equal(s.engine, engine === 'gdu' ? 'gdu-turbo' : engine === 'native' ? 'native' : s.engine, `${s.engineReason} — ${s.fallbackReason}`);
      const other = DATA_VOLUME + f.other;
      assert.ok(s.boundary?.neverDescend.includes(other), 'the walk was handed the fixed folder in the Data volume’s spelling');
      const store = storeOf(s);
      assert.notEqual(store.findByPath(other), -1, 'the folder stays, an empty one');
      assert.equal(store.childCount(store.findByPath(other)), 0, 'and nothing inside it was listed');
      assert.equal(store.findByPath(DATA_VOLUME + f.plain), -1);
      assert.notEqual(store.findByPath(DATA_VOLUME + f.inside), -1, 'the rest is walked');
    } finally {
      setNeverDescendForTests(null);
      process.env.TREEMAP_NO_GDU = '1';
    }
  });
}

test('walker: a walk of a folder on the Data volume whose boundary could not be composed is still handed the Data volume’s spelling of the fixed list', async (t) => {
  if (process.platform !== 'darwin') return t.skip('the Data volume is macOS’s');
  const f = tree();
  const onData = DATA_VOLUME + f.root;
  if (!fs.existsSync(onData)) return t.skip(`${onData} is not this temp folder's Data-volume spelling here`);
  // A drive listed inside whose kind cannot be asked: composing the boundary fails, and the scan takes the unknown one.
  setBoundaryDepsForTests({ readTable: async () => tableNaming([DATA_VOLUME + f.mnt]), aliases: async () => () => [], isDirectory: async () => { throw new Error('the stat could not be asked'); } });
  setNeverDescendForTests([f.other]);
  try {
    const s = await scanWith(onData, 'stay', 'walker');
    assert.equal(s.boundary?.mounts, null, 'the boundary is unknown');
    assert.match(s.boundary?.reason ?? '', /the stat could not be asked/);
    assert.ok(s.boundary?.neverDescend.includes(DATA_VOLUME + f.other), 'and still names the fixed folder as the Data volume spells it');
    const store = storeOf(s);
    assert.equal(store.childCount(store.findByPath(DATA_VOLUME + f.other)), 0);
  } finally {
    setNeverDescendForTests(null);
  }
});
