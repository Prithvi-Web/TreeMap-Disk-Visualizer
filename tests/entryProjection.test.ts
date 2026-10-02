import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every write a scan here causes — settings, snapshots, the rescan cache —
// lands in a folder of this file's own, never in the owner's app data; gdu
// stays off, so a native failure can only ever reach the built-in walker.
import { isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-entryProjection-data-');
process.env.TREEMAP_NO_GDU = '1';

import { countedReal } from './fixtures/countedNative';
import {
  projectEntries,
  setProjectionForTests,
  wholeVolumeMounts,
  type EntryProjection,
  type ProjectionDeps,
} from '../src/services/scan/projection';
import { STATFS_TIMEOUT_MS } from '../src/services/diskUsage';
import { allScans, getScan, startScan } from '../src/services/diskScanner';
import { settled } from '../src/utils/backgroundWrites';
import { updateSettings } from '../src/services/settings';
import type { ScanResult } from '../src/models/types';

/**
 * Track U, U-30: before a native scan walks, its size is projected — from the
 * newest scan of exactly the same folder when one is on record, otherwise,
 * for a folder that is a whole volume, from the file system's used-inode
 * count, a hint only. An unknown size is `null` with its reason, never 0 and
 * never a partial sum (U-D13), and the projection never throws: whatever a
 * hand-edited snapshots.json holds, or however a volume answers, the scan
 * still runs. Every fact arrives through injected deps, so each case is
 * counted on any machine: snapshot reads, statfs calls, deadlines.
 */

/** The diagnosis Mac's volume group (Track U plan, U-30): 484,014 + 5,244,164 inodes in use. */
const SYSTEM_VOLUME = { files: 1_668_728_774, ffree: 1_668_244_760 };
const DATA_VOLUME = { files: 1_673_488_924, ffree: 1_668_244_760 };

interface FakeMachine {
  platform: NodeJS.Platform;
  /** What snapshots.json holds, or a read that rejects. */
  snapshots?: unknown[] | Error;
  /** `stat().dev` by path; a path left out cannot be read. */
  devs?: Record<string, number>;
  /** statfs by mount: its inode counts, an error, or `'never'` for a call that never answers. */
  statfs?: Record<string, { files: number; ffree: number } | Error | 'never'>;
}

interface Fake {
  deps: ProjectionDeps;
  calls: { snapshots: number; statfs: string[]; dev: string[] };
  /** Every deadline asked for, its delay and the callback that fires it. */
  timers: Array<{ ms: number; fire: () => void }>;
  /** Deadlines cleared before they fired. */
  cleared: number;
}

function fake(machine: FakeMachine): Fake {
  const out: Fake = { deps: {} as ProjectionDeps, calls: { snapshots: 0, statfs: [], dev: [] }, timers: [], cleared: 0 };
  out.deps = {
    platform: machine.platform,
    snapshots: async () => {
      out.calls.snapshots++;
      if (machine.snapshots instanceof Error) throw machine.snapshots;
      return machine.snapshots ?? [];
    },
    dev: async (target) => {
      out.calls.dev.push(target);
      const dev = machine.devs?.[target];
      if (dev === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${target}'`), { code: 'ENOENT' });
      return dev;
    },
    statfs: (mount) => {
      out.calls.statfs.push(mount);
      const answer = machine.statfs?.[mount];
      if (answer === 'never') return new Promise(() => undefined);
      if (answer === undefined) return Promise.reject(Object.assign(new Error(`ENOENT: no such file or directory, statfs '${mount}'`), { code: 'ENOENT' }));
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer);
    },
    timer: (ms, fire) => {
      out.timers.push({ ms, fire });
      return () => {
        out.cleared++;
      };
    },
  };
  return out;
}

const snapshot = (rootPath: string, takenAt: number, fileCount: unknown, dirCount: unknown): Record<string, unknown> =>
  ({ id: `s${takenAt}`, rootPath, takenAt, totalSize: 1, fileCount, dirCount, topEntries: [] });

/* ─────────────────────────── the previous scan ─────────────────────────── */

test('the previous scan of the same folder gives the projection, read as its file and folder counts, before any inode is counted', async () => {
  const { deps, calls } = fake({
    platform: 'darwin',
    snapshots: [snapshot('/', 1_000, 8_000_000, 1_115_094)],
    statfs: { '/': SYSTEM_VOLUME, '/System/Volumes/Data': DATA_VOLUME },
  });
  const projection = await projectEntries('/', deps);
  assert.deepEqual(projection, {
    entries: 9_115_094,
    source: 'previousScan',
    reason: 'the previous scan of this folder counted 9,115,094 items',
  });
  assert.equal(calls.snapshots, 1, 'one read of the scan history');
  assert.deepEqual(calls.statfs, [], 'no inode count is asked for once a previous scan answers, even for the whole disk');
});

test('the newest scan of exactly this folder is the one used: never an older one, a parent, a subfolder or a name that only starts the same', async () => {
  const { deps } = fake({
    platform: 'linux',
    snapshots: [
      snapshot('/home/ana', 1_500, 15, 1),
      snapshot('/home', 5_000, 900, 9),
      snapshot('/home/ana', 2_000, 20, 2),
      snapshot('/home/ana/src', 6_000, 800, 8),
      snapshot('/home/anabel', 7_000, 700, 7),
      // The oldest, written last: the newest is neither the folder's first record in the file nor its last.
      snapshot('/home/ana', 1_000, 10, 1),
    ],
  });
  const projection = await projectEntries('/home/ana', deps);
  assert.equal(projection.entries, 22, `the newest exact-root snapshot, 20 files and 2 folders: ${projection.reason}`);
  assert.equal(projection.source, 'previousScan');
});

test('of two scans taken at the same time, the one written later is used; a record with no usable time counts as the oldest', async () => {
  const tie = fake({ platform: 'linux', snapshots: [snapshot('/data', 3_000, 30, 3), snapshot('/data', 3_000, 40, 4)] });
  assert.equal((await projectEntries('/data', tie.deps)).entries, 44, 'the later-written of two at the same time');
  const timeless = { ...snapshot('/data', 0, 50, 5), takenAt: 'yesterday' };
  const mixed = fake({ platform: 'linux', snapshots: [snapshot('/data', 3_000, 30, 3), timeless] });
  assert.equal((await projectEntries('/data', mixed.deps)).entries, 33, 'a record whose time is not a number is older than any that has one');
  const only = fake({ platform: 'linux', snapshots: [timeless] });
  assert.equal((await projectEntries('/data', only.deps)).entries, 55, 'and is still a previous scan when it is the only one');
});

test('a previous scan whose counts are not whole numbers from 0 up is unknown with a reason, and is not replaced by the inode hint', async () => {
  const NOT_WHOLE = 'is not a whole number from 0 to 2^53 − 1';
  const bad: Array<[string, unknown, unknown, string]> = [
    ['a file count that is NaN', Number.NaN, 1, `its file count ${NOT_WHOLE}`],
    ['a file count that is a string', '123', 1, 'its file count is not a number'],
    ['a negative file count', -1, 1, `its file count ${NOT_WHOLE}`],
    ['a file count of 2^53', 2 ** 53, 1, `its file count ${NOT_WHOLE}`],
    ['a missing folder count', 10, undefined, 'its folder count is not a number'],
    ['a fractional folder count', 10, 1.5, `its folder count ${NOT_WHOLE}`],
    ['counts that sum past 2^53 − 1', Number.MAX_SAFE_INTEGER, 1, 'its file and folder counts add up past 2^53 − 1'],
  ];
  for (const [what, fileCount, dirCount, why] of bad) {
    const { deps, calls } = fake({
      platform: 'darwin',
      snapshots: [snapshot('/', 1_000, fileCount, dirCount)],
      statfs: { '/': SYSTEM_VOLUME, '/System/Volumes/Data': DATA_VOLUME },
    });
    const projection = await projectEntries('/', deps);
    assert.equal(projection.entries, null, `${what} gives no number: ${String(projection.entries)}`);
    assert.equal(projection.source, 'none', what);
    assert.equal(projection.reason, `the newest scan of this folder on record has no usable size: ${why}`, what);
    assert.deepEqual(calls.statfs, [], `${what}: a previous scan is on record, so the inode hint does not stand in for it`);
  }
});

test('a snapshot record that is not an object, or has no root, is passed over rather than read', async () => {
  const { deps } = fake({ platform: 'linux', snapshots: [null, 7, 'x', { takenAt: 9 }, snapshot('/data', 1, 4, 1)] });
  const projection = await projectEntries('/data', deps);
  assert.equal(projection.entries, 5, projection.reason);
});

/* ─────────────────────────── the used-inode hint ─────────────────────────── */

test('with no previous scan, the whole disk on macOS sums its volume group\'s used inodes: two statfs calls, a hint', async () => {
  const { deps, calls } = fake({ platform: 'darwin', statfs: { '/': SYSTEM_VOLUME, '/System/Volumes/Data': DATA_VOLUME } });
  const projection = await projectEntries('/', deps);
  assert.deepEqual(projection, {
    entries: 5_728_178,
    source: 'usedInodes',
    reason: 'no earlier scan of this folder is on record; 5,728,178 inodes are in use on / and /System/Volumes/Data, which is only a hint: a file with several names uses one inode',
  });
  assert.deepEqual([...calls.statfs].sort(), ['/', '/System/Volumes/Data']);
});

test('a volume of the group that reports no inodes makes the hint unknown, never the other volume\'s count alone, and the reason names it', async () => {
  const { deps } = fake({ platform: 'darwin', statfs: { '/': SYSTEM_VOLUME, '/System/Volumes/Data': { files: 0, ffree: 0 } } });
  const projection = await projectEntries('/', deps);
  assert.equal(projection.entries, null, `not a partial sum: ${String(projection.entries)}`);
  assert.equal(projection.source, 'none');
  assert.match(projection.reason, /the inodes in use on \/System\/Volumes\/Data are unknown: the file system reports no inode count there/);
});

test('a statfs that reports every inode free counts nothing, so the hint is unknown, never 0', async () => {
  const { deps } = fake({ platform: 'linux', statfs: { '/': { files: 500, ffree: 500 } } });
  const projection = await projectEntries('/', deps);
  assert.equal(projection.entries, null, `not a measured 0: ${String(projection.entries)}`);
  assert.match(projection.reason, /the inodes in use on \/ are unknown: the file system reports every inode free there, so it does not count them/);
});

test('a statfs that reports more free inodes than inodes is unknown', async () => {
  const { deps } = fake({ platform: 'linux', statfs: { '/': { files: 100, ffree: 101 } } });
  const projection = await projectEntries('/', deps);
  assert.equal(projection.entries, null);
  assert.match(projection.reason, /the inodes in use on \/ are unknown: statfs reported more free inodes \(101\) than inodes \(100\)/);
});

test('a folder that is not a volume\'s root gets no hint: a subfolder shares its parent\'s device', async () => {
  const { deps, calls } = fake({
    platform: 'darwin',
    devs: { '/Users/ana': 16_777_230, '/Users': 16_777_230 },
    statfs: { '/Users/ana': SYSTEM_VOLUME },
  });
  const projection = await projectEntries('/Users/ana', deps);
  assert.deepEqual(projection, {
    entries: null,
    source: 'none',
    reason: 'no earlier scan of this folder is on record, and it is not the root of a volume, whose used inodes could hint at its size',
  });
  assert.deepEqual(calls.statfs, [], 'a subfolder is never given its volume\'s count');
});

test('the volumes a root covers whole: macOS / is its volume group; a mount point, a Windows drive and Linux / are themselves; anything else none', async () => {
  const machine = (platform: NodeJS.Platform, devs: Record<string, number> = {}): ProjectionDeps => fake({ platform, devs }).deps;
  assert.deepEqual(await wholeVolumeMounts('/', machine('darwin')), ['/', '/System/Volumes/Data']);
  assert.deepEqual(await wholeVolumeMounts('/', machine('linux')), ['/']);
  assert.deepEqual(await wholeVolumeMounts('D:\\', machine('win32')), ['D:\\']);
  assert.deepEqual(await wholeVolumeMounts('D:', machine('win32')), ['D:']);
  assert.deepEqual(await wholeVolumeMounts('/Volumes/Backup', machine('darwin', { '/Volumes/Backup': 16_777_240, '/Volumes': 16_777_230 })), ['/Volumes/Backup']);
  assert.deepEqual(await wholeVolumeMounts('/mnt/data', machine('linux', { '/mnt/data': 2_065, '/mnt': 2_049 })), ['/mnt/data']);
  assert.deepEqual(await wholeVolumeMounts('E:\\Mounted', machine('win32', { 'E:\\Mounted': 7, 'E:\\': 5 })), ['E:\\Mounted']);
  assert.equal(await wholeVolumeMounts('/home/ana', machine('linux', { '/home/ana': 2_049, '/home': 2_049 })), null);
  assert.equal(await wholeVolumeMounts('/gone/folder', machine('linux')), null, 'a device that cannot be read is no proof of a volume');
});

test('a Windows drive whose statfs counts no inodes, as libuv reports them there, is unknown with the reason', async () => {
  const { deps, calls } = fake({ platform: 'win32', statfs: { 'D:\\': { files: 0, ffree: 0 } } });
  const projection = await projectEntries('D:\\', deps);
  assert.equal(projection.entries, null);
  assert.match(projection.reason, /the inodes in use on D:\\ are unknown: the file system reports no inode count there/);
  assert.deepEqual(calls.statfs, ['D:\\']);
});

/* ─────────────────────────── failures never throw ─────────────────────────── */

test('a scan history that cannot be read falls through to the hint, and says why', async () => {
  const emfile = Object.assign(new Error('EMFILE: too many open files, open \'snapshots.json\''), { code: 'EMFILE' });
  const { deps, calls } = fake({ platform: 'darwin', snapshots: emfile, statfs: { '/': SYSTEM_VOLUME, '/System/Volumes/Data': DATA_VOLUME } });
  const projection = await projectEntries('/', deps);
  assert.equal(projection.entries, 5_728_178);
  assert.equal(projection.source, 'usedInodes');
  assert.match(projection.reason, /^the earlier scans on record could not be read \(EMFILE: too many open files/);
  assert.equal(calls.statfs.length, 2);
});

test('a dep that throws instead of rejecting is a reason, not a throw', async () => {
  const { deps } = fake({ platform: 'darwin' });
  const throwing: ProjectionDeps = {
    ...deps,
    snapshots: () => { throw new Error('the history reader broke'); },
    dev: () => { throw new Error('stat broke'); },
    statfs: () => { throw new Error('statfs broke'); },
  };
  const subfolder = await projectEntries('/Users/ana', throwing);
  assert.equal(subfolder.entries, null);
  assert.match(subfolder.reason, /^the earlier scans on record could not be read \(the history reader broke\)/);
  const whole = await projectEntries('/', throwing);
  assert.equal(whole.entries, null);
  assert.match(whole.reason, /the inodes in use on \/ are unknown: statfs failed \(statfs broke\)/);
  const brokenTimer = await projectEntries('/', { ...deps, statfs: () => new Promise(() => undefined), timer: () => { throw new Error('no timers here'); } });
  assert.equal(brokenTimer.entries, null);
  assert.match(brokenTimer.reason, /the inodes in use on \/ are unknown: statfs failed \(no timers here\)/);
});

test('a failure with no string form is still a reason, never a throw', async () => {
  const { deps } = fake({ platform: 'linux', statfs: { '/': { files: 1_000, ffree: 400 } } });
  const projection = await projectEntries('/', { ...deps, snapshots: () => Promise.reject(Object.create(null)) });
  assert.equal(projection.entries, 600, 'the hint still answers');
  assert.match(projection.reason, /^the earlier scans on record could not be read \(a failure with no description\); 600 inodes are in use on \//);
});

test('a dep that answers outside its contract is an unknown with its reason, never a throw', async () => {
  const { deps } = fake({ platform: 'linux' });
  const nothing = await projectEntries('/', { ...deps, statfs: async () => null as unknown as { files: number; ffree: number } });
  assert.equal(nothing.entries, null);
  assert.equal(nothing.source, 'none');
  assert.match(nothing.reason, /^the size of this folder could not be projected \(/);
});

test('a statfs that never answers is unknown once its deadline fires — diskUsage\'s own bound — and an answer clears its deadline', async () => {
  const silent = fake({ platform: 'linux', statfs: { '/': 'never' } });
  const answer: { projection: EntryProjection | null } = { projection: null };
  void projectEntries('/', silent.deps).then((projection) => { answer.projection = projection; });
  // Every deadline asked for is fired as soon as it is set: the statfs call never answers.
  await waitFor(() => {
    for (const timer of silent.timers) timer.fire();
    return answer.projection !== null;
  }, 'the projection answering once its statfs deadline fires');
  assert.equal(silent.timers.length, 1, 'one deadline, for the one statfs call');
  assert.equal(silent.timers[0].ms, STATFS_TIMEOUT_MS, 'the same bound diskUsage.ts gives statfs');
  assert.equal(silent.cleared, 0, 'a deadline that fired is not also cleared');
  const projection = answer.projection;
  assert.ok(projection, 'the projection answered');
  assert.equal(projection.entries, null);
  assert.match(projection.reason, /the inodes in use on \/ are unknown: statfs did not answer within 2 s/);

  const answered = fake({ platform: 'linux', statfs: { '/': { files: 1_000, ffree: 400 } } });
  const quick = await projectEntries('/', answered.deps);
  assert.equal(quick.entries, 600);
  assert.equal(answered.timers.length, 1);
  assert.equal(answered.cleared, 1, 'the answered call cleared its deadline instead of leaving a timer behind');
});

/* ─────────────────────────── in startScan ─────────────────────────── */

/** `folders` folders of `files` files each under a new temp folder. */
function tree(t: TestContext, folders: number, files: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-entry-projection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let f = 0; f < folders; f++) {
    const dir = path.join(root, `folder-${f}`);
    fs.mkdirSync(dir);
    for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `file-${i}.txt`), 'x'.repeat(1 + i));
  }
  return root;
}

async function settledScan(scanId: string): Promise<ScanResult> {
  await waitFor(() => getScan(scanId)?.status !== 'running', `scan ${scanId} settling`);
  return getScan(scanId)!;
}

test('a native scan records its projection before it walks: none for a new folder, the first scan\'s count for the second', async (t) => {
  const counted = countedReal(t);
  if (!counted) return;
  const root = tree(t, 3, 4);
  await updateSettings({ engine: 'native' });
  const first = await settledScan((await startScan(root)).scanId);
  assert.equal(first.status, 'complete', first.error ?? '');
  assert.equal(first.engine, 'native');
  assert.deepEqual(first.nativePlan?.projection, {
    entries: null,
    source: 'none',
    reason: 'no earlier scan of this folder is on record, and it is not the root of a volume, whose used inodes could hint at its size',
  });
  await settled(); // the first scan's snapshot is written
  const second = await settledScan((await startScan(root)).scanId);
  assert.equal(second.status, 'complete', second.error ?? '');
  assert.deepEqual(second.nativePlan?.projection, {
    entries: first.fileCount + first.dirCount,
    source: 'previousScan',
    reason: `the previous scan of this folder counted ${first.fileCount + first.dirCount} items`,
  });
  assert.equal(first.fileCount + first.dirCount, 1 + 3 + 12, 'the root, its folders and their files');
});

test('startScan answers only once the projection has, with the native walk already started: a Stop or a pause always meets a walk', async (t) => {
  const counted = countedReal(t);
  if (!counted) return;
  const root = tree(t, 2, 2);
  t.after(() => setProjectionForTests(root, null));
  await updateSettings({ engine: 'native' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let asked = 0;
  setProjectionForTests(root, async (): Promise<EntryProjection> => {
    asked++;
    await gate;
    return { entries: null, source: 'none', reason: 'held by the test' };
  });
  const state = { answered: false };
  const started = startScan(root).then((scan) => {
    state.answered = true;
    return scan;
  });
  await waitFor(() => asked === 1, 'the projection being asked for');
  assert.equal(state.answered, false, 'startScan waits for the projection');
  assert.equal(allScans().some((s) => s.rootPath === root), false, 'no record exists while the size is projected, so no Stop can land before the walk');
  assert.deepEqual(counted.starts, [], 'no walk before the projection answers');
  release();
  const scan = await started;
  assert.deepEqual(counted.starts, ['memory'], 'the walk has started by the time startScan answers');
  assert.equal(scan.nativePlan?.projection.reason, 'held by the test', 'the test\'s projection is the one recorded');
  const done = await settledScan(scan.scanId);
  assert.equal(done.status, 'complete', done.error ?? '');
});
