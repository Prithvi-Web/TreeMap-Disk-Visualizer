import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { VolumeTopology } from '../src/platform/types';
import { estimateCost } from '../src/services/costIntelligence';
import { buildScanStats } from '../src/api/scanRoutes';
import { ScanResult } from '../src/models/types';

/**
 * The frontend↔backend join — the field names, not the shapes.
 *
 * `frontendContract.test.ts` proves the browser code is *structurally* sound.
 * This file asks the other question: does what the browser READS off a
 * response match what the server actually PUTS there? Those two drift apart
 * silently, because a read of an absent field is `undefined` rather than an
 * error — the panel simply loses a fact, or renders a second measurement of
 * the same thing beside the first.
 *
 * So the payloads below are not hand-written fixtures. Each one is built by
 * the server's own code (`buildScanStats`, `estimateCost`) or typed against
 * the server's own interface (`VolumeTopology`), which is what makes a
 * renamed server field fail here instead of quietly reaching a user.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** A slice of the app between two exact anchors. */
function slice(startAnchor: string, endAnchor: string): string {
  const start = INDEX.indexOf(startAnchor);
  assert.notEqual(start, -1, `anchor "${startAnchor}" exists in index.html`);
  const end = INDEX.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `anchor "${endAnchor}" follows it`);
  return INDEX.slice(start, end);
}

/* ══════════════ Drive health names a drive the topology really reports ══════════════ */

type DeviceFn = (topo: unknown, rootPath: unknown) => string | null;

function smartDeviceFor(): DeviceFn {
  const src = slice('function smartDeviceFor(', 'async function loadDriveHealth(');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`'use strict'; ${src} return smartDeviceFor;`)() as DeviceFn;
}

/**
 * A macOS answer in the server's own shape. Typed as `VolumeTopology`, so
 * renaming `physicalDisks` or `logicalVolumes` server-side fails to compile
 * here rather than leaving the browser reading a field nobody sends.
 */
const MAC_TOPOLOGY: VolumeTopology = {
  physicalDisks: [{ id: 'disk0', name: 'APPLE SSD AP0512Z', sizeBytes: 500_277_792_768, rotational: false }],
  logicalVolumes: [
    {
      id: 'disk3s1', name: 'Macintosh HD', mountPoint: '/', filesystem: 'apfs',
      sizeBytes: 494_384_795_648, freeBytes: 307_812_958_208, usedBytes: 11_000_000_000,
      physicalDiskIds: ['disk0'], kind: 'apfs',
    },
    {
      id: 'disk1s1', name: 'iSCPreboot', mountPoint: '/System/Volumes/iSCPreboot', filesystem: 'apfs',
      sizeBytes: 524_288_000, freeBytes: 506_224_640, usedBytes: 5_844_992,
      physicalDiskIds: ['disk0'], kind: 'apfs',
    },
  ],
  mechanism: 'diskutil list -plist',
};

test('the drive under a scanned folder is found through the fields topology actually answers', () => {
  const fn = smartDeviceFor();
  assert.equal(fn(MAC_TOPOLOGY, '/Users/someone/Movies'), '/dev/disk0');
});

test('the longest mount point wins, since "/" backs every path on the machine', () => {
  const topo: VolumeTopology = {
    physicalDisks: [
      { id: 'disk0', name: 'internal', sizeBytes: 1, rotational: false },
      { id: 'disk4', name: 'external', sizeBytes: 1, rotational: true },
    ],
    logicalVolumes: [
      { id: 'a', name: 'Macintosh HD', mountPoint: '/', filesystem: 'apfs', sizeBytes: 1, freeBytes: 1, usedBytes: 1, physicalDiskIds: ['disk0'], kind: 'apfs' },
      { id: 'b', name: 'Archive', mountPoint: '/Volumes/Archive', filesystem: 'hfs', sizeBytes: 1, freeBytes: 1, usedBytes: 1, physicalDiskIds: ['disk4'], kind: 'simple' },
    ],
    mechanism: 'diskutil list -plist',
  };
  assert.equal(smartDeviceFor()(topo, '/Volumes/Archive/2019'), '/dev/disk4',
    'the folder is on the external drive, not on the one mounted at /');
});

test('a mount point is a folder boundary, never a string prefix', () => {
  const topo: VolumeTopology = {
    physicalDisks: [
      { id: 'disk0', name: 'internal', sizeBytes: 1, rotational: false },
      { id: 'disk4', name: 'external', sizeBytes: 1, rotational: true },
    ],
    logicalVolumes: [
      { id: 'a', name: 'Macintosh HD', mountPoint: '/', filesystem: 'apfs', sizeBytes: 1, freeBytes: 1, usedBytes: 1, physicalDiskIds: ['disk0'], kind: 'apfs' },
      { id: 'b', name: 'Data', mountPoint: '/Volumes/Data', filesystem: 'hfs', sizeBytes: 1, freeBytes: 1, usedBytes: 1, physicalDiskIds: ['disk4'], kind: 'simple' },
    ],
    mechanism: 'diskutil list -plist',
  };
  assert.equal(smartDeviceFor()(topo, '/Volumes/Database/dump'), '/dev/disk0',
    '"/Volumes/Database" is not inside "/Volumes/Data"');
});

test('an id that is already a device node is passed through untouched', () => {
  const topo: VolumeTopology = {
    physicalDisks: [{ id: '/dev/sda', name: 'Samsung', sizeBytes: 1, rotational: false }],
    logicalVolumes: [
      { id: 'sda2', name: null, mountPoint: '/', filesystem: 'ext4', sizeBytes: 1, freeBytes: 1, usedBytes: 1, physicalDiskIds: ['/dev/sda'], kind: 'simple' },
    ],
    mechanism: 'lsblk --json',
  };
  assert.equal(smartDeviceFor()(topo, '/home/someone'), '/dev/sda');
});

test('an id that is not a device node names no drive at all, rather than one that fails', () => {
  const topo: VolumeTopology = {
    physicalDisks: [{ id: 'PhysicalDisk0', name: 'NVMe', sizeBytes: 1, rotational: false }],
    logicalVolumes: [
      { id: 'C:', name: null, mountPoint: 'C:\\', filesystem: 'NTFS', sizeBytes: 1, freeBytes: 1, usedBytes: 1, physicalDiskIds: ['PhysicalDisk0'], kind: 'simple' },
    ],
    mechanism: 'Get-Disk',
  };
  // The server's "No drive was named" is a true sentence; "that drive returned
  // no SMART data" would be a false one, and a guess is what produces it.
  assert.equal(smartDeviceFor()(topo, 'C:\\Users\\someone'), null);
});

test('no topology, no root and no matching volume each name no drive', () => {
  const fn = smartDeviceFor();
  assert.equal(fn(null, '/Users/someone'), null);
  assert.equal(fn(MAC_TOPOLOGY, null), null);
  assert.equal(fn({ physicalDisks: [], logicalVolumes: [] }, '/Users/someone'), null);
});

/* ══════════════ Scan counters come from the response that carries them ══════════════ */

/**
 * Exactly what `GET /api/scan/:scanId/result` answers on a complete scan —
 * the tree plus the counts that route chooses to publish. It is deliberately
 * NOT `buildScanStats`: the point of this fixture is which fields are absent.
 */
const RESULT_PAYLOAD = {
  status: 'complete',
  scanId: 'a-scan',
  rootPath: '/root',
  fileCount: 286,
  dirCount: 22,
  hardlinkedFiles: 0,
  hardlinkedBytes: 0,
  sparseFiles: 0,
  sparseBytes: 0,
  cloudFiles: 0,
  cloudBytes: 0,
  startedAt: 1_000,
  finishedAt: 1_123,
  root: { name: 'root', path: '/root', size: 3_360_905, type: 'dir' },
};

/** The /stats payload, from the server's own single shaping function. */
const STATS_PAYLOAD = {
  scanId: 'a-scan',
  status: 'complete',
  ...buildScanStats({
    scanId: 'a-scan', rootPath: '/root', status: 'complete',
    scanned: 308, fileCount: 286, dirCount: 22,
    engine: 'gdu-turbo', ioThreads: 16,
    startedAt: 1_000, finishedAt: 1_123,
    incremental: false, cachedDirs: 0, walkedDirs: 308,
    hardlinkedFiles: 0, hardlinkedBytes: 0, cloudFiles: 0, cloudBytes: 0,
  } as unknown as ScanResult),
};

type StatsFn = (scanId: string, result: unknown) => Promise<Record<string, unknown>>;

function scanStatsFor(api: (url: string) => Promise<unknown>): StatsFn {
  const src = slice('function statsFromResult(', 'async function finishScan(');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('api', `'use strict'; ${src} return scanStatsFor;`)(api) as StatsFn;
}

test('the counters the result payload does not carry are fetched, not invented', async () => {
  const asked: string[] = [];
  const stats = await scanStatsFor(async (url) => { asked.push(url); return STATS_PAYLOAD; })('a-scan', RESULT_PAYLOAD);
  assert.deepEqual(asked, ['/api/scan/a-scan/stats'], 'the one response that shapes them');
  // These four are absent from /result entirely; reading them off it produced
  // `undefined` and silently cost the dashboard its engine row.
  assert.equal(stats.engine, 'gdu-turbo');
  assert.equal(stats.scanned, 308);
  assert.equal(stats.ioThreads, 16);
  assert.equal(stats.walkedDirs, 308);
  // And what /result does carry still comes through.
  assert.equal(stats.fileCount, 286);
  assert.equal(stats.durationMs, 123);
});

test('a failed stats request costs the extra counters, never the completed scan', async () => {
  const stats = await scanStatsFor(async () => { throw new Error('gone'); })('a-scan', RESULT_PAYLOAD);
  assert.equal(stats.fileCount, 286, 'the result payload still answers what it knows');
  assert.equal(stats.durationMs, 123);
});

test('both fallback paths ask for the counters — the watchdog and the treeless complete frame', () => {
  const follow = slice('function followScanProgress(', 'async function startCloudScan(');
  const calls = follow.match(/scanStatsFor\(/g) || [];
  assert.equal(calls.length, 2, 'the stalled-stream watchdog and the complete frame with no tree');
  assert.doesNotMatch(follow, /statsFromResult\(/,
    'neither path may shape the counters from a payload that does not carry them');
});

/* ══════════════ The cost headline is the number the prices were worked out from ══════════════ */

test('the cost card leads with the bytes the server priced, not a second measurement', () => {
  const fn = slice('async function loadCostEstimate(', 'let dhGauge = null;');
  // Every provider carries the exact figure the estimate was computed from.
  const est = estimateCost(3_360_905, 0, 'USD');
  assert.equal(est.providers[0].bytes, 3_360_905, 'the answer carries its own input');
  assert.match(fn, /est\.providers\[0\]\.bytes/, 'the headline reads it');
  assert.doesNotMatch(fn, /formatBytes\(state\.root \? state\.root\.size : 0\)/,
    'the client tree’s own root size is a different measurement of the same thing');
  assert.match(fn, /pricedBytes === null/, 'and nothing priced is said, never printed as a size');
});
