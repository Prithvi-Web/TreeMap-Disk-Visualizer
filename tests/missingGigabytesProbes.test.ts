import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-missingGigabytesProbes-data-');

import { buildStatement, assertBalances, type StatementSources } from '../src/services/missingGigabytes';
import type { LogicalVolumeInfo, VolumeTopology } from '../src/platform/types';
import type { ScanResult } from '../src/models/types';
import type { ZombieReport } from '../src/services/zombieHandles';

/**
 * The statement's probes, counted (design pass G06).
 *
 * Measured on the owner's Mac (14 Oct 2026): GET /api/missing-gigabytes spent
 * 400-670 ms in buildStatement, almost all of it in two probes run one after
 * the other — the disk layout (diskutil list, then diskutil info for every
 * disk: 170-270 ms) and the held-space probe (lsof over every open file:
 * 200-370 ms). Neither reads the other's answer. The held-space probe now
 * starts first and runs while the layout and the snapshots are read, so the
 * statement waits for the slower of the two rather than for their sum.
 *
 * Nothing is cached: each line still says what the machine says now. The
 * layout carries the sibling volumes' usage (the VM volume moves all the
 * time), and any program deleting an open file changes the held-space line,
 * so a remembered answer from either could state something untrue about now.
 *
 * Counted, never timed: the order is observed by holding the layout's answer
 * back and counting which probes have been asked meanwhile.
 */

const GB = 1_000_000_000;
const BLOCK = 4096;

const VOLUMES: LogicalVolumeInfo[] = [
  { id: 'disk3s1s1', name: 'Macintosh HD', mountPoint: '/', filesystem: 'apfs', sizeBytes: null, freeBytes: null, usedBytes: 12 * GB, physicalDiskIds: ['disk0'], kind: 'apfs' },
  { id: 'disk3s6', name: 'VM', mountPoint: '/System/Volumes/VM', filesystem: 'apfs', sizeBytes: null, freeBytes: null, usedBytes: 2 * GB, physicalDiskIds: ['disk0'], kind: 'apfs' },
];

function scan(): ScanResult {
  return {
    scanId: 'scan-probes', rootPath: '/', status: 'complete', scanned: 10, fileCount: 8, dirCount: 2, currentPath: '/',
    startedAt: 0, createdAt: 0, cancelled: false, engine: 'walker',
    store: { rootId: 0, size: (id: number) => (id === 0 ? 50 * GB : 0) },
  } as unknown as ScanResult;
}

const HELD: ZombieReport = { processes: [{ pid: 1, command: 'x', files: [] } as never], totalBytes: 3 * GB, unknownSizeCount: 0, fileCount: 1, sharedFileCount: 0, scannedAt: 0 } as unknown as ZombieReport;

/** Sources that count every probe, with the layout's answer held until the test lets it go. */
function counted(zombies: () => Promise<ZombieReport>): { sources: StatementSources; calls: Record<string, number>; releaseLayout: () => void } {
  const calls: Record<string, number> = { topology: 0, statfs: 0, devOf: 0, snapshots: 0, zombies: 0 };
  let releaseLayout = (): void => {};
  const layout = new Promise<VolumeTopology>((resolve) => {
    releaseLayout = () => resolve({ physicalDisks: [], logicalVolumes: VOLUMES, mechanism: 'fixture' });
  });
  const sources: StatementSources = {
    platform: 'darwin',
    topology: () => { calls.topology++; return layout; },
    statfs: () => { calls.statfs++; return Promise.resolve({ blocks: (500 * GB) / BLOCK, bfree: (300 * GB) / BLOCK, bavail: (300 * GB) / BLOCK, bsize: BLOCK }); },
    devOf: (p: string) => { calls.devOf++; return Promise.resolve(p === '/System/Volumes/VM' ? 2 : 1); },
    snapshots: () => { calls.snapshots++; return Promise.resolve({ available: true, platform: 'darwin' as NodeJS.Platform, snapshots: [], totalBytes: null, canPurge: false }); },
    zombies: () => { calls.zombies++; return zombies(); },
  };
  return { sources, calls, releaseLayout };
}

/** Let every pending turn of the event loop run. */
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

test('G06: the held-space probe is asked before the disk layout answers, and every probe once per statement', async () => {
  const { sources, calls, releaseLayout } = counted(() => Promise.resolve(HELD));
  const pending = buildStatement(scan(), sources);
  await settle();
  assert.deepEqual({ topology: calls.topology, zombies: calls.zombies }, { topology: 1, zombies: 1 },
    'with the layout still being read, the held-space probe is already running beside it');
  assert.equal(calls.snapshots, 0, 'control: the snapshots wait for the layout, which names the volume they are read for');
  releaseLayout();
  const statement = await pending;
  assert.deepEqual(calls, { topology: 1, statfs: 1, devOf: 3, snapshots: 1, zombies: 1 }, 'each probe asked once — the root and each mount point read for its device once');
  const held = statement.lines.find((l) => l.id === 'openHandles');
  assert.equal(held?.bytes, 3 * GB, 'and the held-space line is the probe\'s answer');
  assertBalances(statement);
});

test('G06: a held-space probe that fails while the layout is still being read costs its own line and nothing else — never an unhandled rejection', async () => {
  let unhandled = 0;
  const onUnhandled = (): void => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const { sources, releaseLayout } = counted(() => Promise.reject(new Error('lsof: cannot list open files')));
    const pending = buildStatement(scan(), sources);
    await settle(); // the failure lands here, long before the statement reads it
    releaseLayout();
    const statement = await pending;
    await settle();
    assert.equal(unhandled, 0, 'the early failure was held for its line, not left unhandled');
    const held = statement.lines.find((l) => l.id === 'openHandles');
    assert.equal(held?.available, false);
    assert.equal(held?.bytes, null, 'unknown, never a zero');
    assert.match(held?.reason ?? '', /cannot list open files/, 'with the probe\'s own words');
    assertBalances(statement);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('G06: a held-space probe that throws before it returns a promise is the same unavailable line', async () => {
  const { sources, releaseLayout } = counted(() => { throw new Error('lsof is not installed'); });
  const pending = buildStatement(scan(), sources);
  releaseLayout();
  const statement = await pending;
  const held = statement.lines.find((l) => l.id === 'openHandles');
  assert.equal(held?.available, false);
  assert.match(held?.reason ?? '', /lsof is not installed/);
});

test('G06: a disk layout that fails is still the statement\'s failure, and the held-space probe started beside it fails nothing else', async () => {
  let unhandled = 0;
  const onUnhandled = (): void => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const calls = { zombies: 0 };
    const sources: StatementSources = {
      ...counted(() => Promise.resolve(HELD)).sources,
      topology: () => Promise.reject(new Error('diskutil reported no disks at all')),
      zombies: () => { calls.zombies++; return Promise.reject(new Error('lsof failed too')); },
    };
    await assert.rejects(buildStatement(scan(), sources), /diskutil reported no disks at all/, 'the route turns this into its 409');
    await settle();
    assert.equal(calls.zombies, 1);
    assert.equal(unhandled, 0, 'the held-space failure nobody will read is still handled');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
