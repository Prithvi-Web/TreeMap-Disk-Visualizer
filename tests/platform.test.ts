import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { platform, platformNameOf } from '../src/platform';
import { getCapabilities, invalidateCapabilities } from '../src/platform/capabilities';
import { parseLsofRecords, resolveZombies, openHandlesFor } from '../src/platform/macos/lsofGuard';
import { parseQuarantine, hostOf } from '../src/platform/macos/provenance';
import { mapTopology, enrichTopology, wholeDiskOf, isImpossiblyEmpty, volumeTopology } from '../src/platform/macos/diskutil';
import { parseSnapshotList, parseSnapshotDate } from '../src/platform/macos/tmutil';
import { decodeICloudStubName, providerForPath } from '../src/platform/macos/allocation';
import { mapSmartctl } from '../src/platform/macos';

/**
 * Platform abstraction layer (Phase 0).
 *
 * Two layers of test, per §9:
 *
 *  - **Unit** over the pure parsers, driven by output recorded from real tools.
 *    These are the parts that carry the correctness risk and the only parts
 *    that can be asserted for a platform this machine is not.
 *  - **Integration** against a real temp filesystem — real open descriptors,
 *    real unlinked inodes, real sparse files. §9 is explicit that mocking the
 *    filesystem here would test nothing that matters, and it is right: every
 *    bug found while building this layer (lsof's exit-1-with-output, macOS
 *    emitting no `(deleted)` marker) was invisible to a mock and obvious to a
 *    real file.
 */

const IS_MAC = process.platform === 'darwin';
const mkTmp = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), 'tm-platform-'));

/* ══════════════════ Factory and capability contract ══════════════════ */

test('platformNameOf maps Node platforms onto the three TreeMap supports', () => {
  assert.equal(platformNameOf('darwin'), 'macos');
  assert.equal(platformNameOf('win32'), 'windows');
  assert.equal(platformNameOf('linux'), 'linux');
  assert.equal(platformNameOf('freebsd'), null);
});

test('the provider is memoized — probes must not re-run per call site', () => {
  assert.equal(platform(), platform());
});

test('every capability reports one of the three honest states, never a bare blank', async () => {
  invalidateCapabilities();
  const caps = await getCapabilities();

  for (const [key, value] of Object.entries(caps)) {
    if (key === 'platform') continue;
    const state = value as { available: boolean; mechanism: string; reason?: string };

    assert.equal(typeof state.available, 'boolean', `${key} must state availability`);
    assert.ok(state.mechanism.length > 0, `${key} must name its mechanism`);

    // §2.2: unavailable is never allowed to be silent. It must carry a reason,
    // and that reason has to be a sentence a person can act on — not a code.
    if (!state.available) {
      assert.ok(state.reason && state.reason.length > 20, `${key} is unavailable and must explain why`);
      assert.match(state.reason, /[a-z]\s[a-z]/i, `${key}'s reason must be prose, not an error code`);
    }
  }
});

test('capabilities are cached, and invalidate() genuinely drops the cache', async () => {
  invalidateCapabilities();
  const first = await getCapabilities();
  assert.equal(await getCapabilities(), first, 'a second call inside the TTL returns the same object');
  invalidateCapabilities();
  assert.notEqual(await getCapabilities(), first, 'after invalidation a fresh detection runs');
});

/* ══════════════════ lsof parsing (unit) ══════════════════ */

test('parseLsofRecords reads field output, including names containing spaces', () => {
  // Recorded from `lsof -F pcnfsi` on macOS 15.
  const sample = ['p1234', 'cGoogle Chrome Helper', 'f7', 's4096', 'i991', 'n/Users/me/a file.txt', ''].join('\n');
  const [rec] = parseLsofRecords(sample);
  assert.equal(rec.pid, 1234);
  assert.equal(rec.processName, 'Google Chrome Helper');
  assert.equal(rec.path, '/Users/me/a file.txt');
  assert.equal(rec.size, 4096);
  assert.equal(rec.ino, 991);
  assert.equal(rec.markedDeleted, false);
});

test('parseLsofRecords honours the Linux (deleted) marker and strips it', () => {
  const sample = ['p9', 'cnode', 'f3', 's100', 'i42', 'n/tmp/gone.bin (deleted)'].join('\n');
  const [rec] = parseLsofRecords(sample);
  assert.equal(rec.markedDeleted, true);
  assert.equal(rec.path, '/tmp/gone.bin', 'the marker is not part of the path');
});

test('parseLsofRecords ignores sockets, pipes and cwd entries', () => {
  const sample = ['p5', 'cfoo', 'f1', 'nsocket', 'f2', 'npipe', 'f3', 'n->0x1234', 'f4', 'n/real/file'].join('\n');
  const paths = parseLsofRecords(sample).map((r) => r.path);
  assert.deepEqual(paths, ['/real/file']);
});

test('per-descriptor fields reset, so one fd cannot inherit another fd size', () => {
  // Without the reset on `f`, fd 4 would inherit fd 3's 999-byte size.
  const sample = ['p7', 'cx', 'f3', 's999', 'i1', 'n/a', 'f4', 'i2', 'n/b'].join('\n');
  const recs = parseLsofRecords(sample);
  assert.equal(recs[0].size, 999);
  assert.equal(recs[1].size, null, 'fd 4 reported no size, so none may be attributed to it');
});

test('resolveZombies flags an unlinked inode and spares a live one', async () => {
  const records = parseLsofRecords(
    ['p1', 'ca', 'f3', 's500', 'i100', 'n/live.bin', 'p2', 'cb', 'f3', 's900', 'i200', 'n/gone.bin'].join('\n'),
  );
  // /live.bin still holds inode 100; /gone.bin's inode was replaced.
  const zombies = await resolveZombies(records, async (p) => (p === '/live.bin' ? 100 : 777));
  assert.equal(zombies.length, 1);
  assert.equal(zombies[0].path, '/gone.bin');
  assert.equal(zombies[0].bytes, 900);
});

test('resolveZombies counts one unlinked inode once, however many descriptors hold it', async () => {
  // A browser holding the same deleted file on four descriptors is one leak of
  // 900 bytes, not four — counting it per-descriptor would overstate by 4×.
  const records = parseLsofRecords(
    ['p1', 'ca', 'f3', 's900', 'i200', 'n/gone.bin', 'f4', 's900', 'i200', 'n/gone.bin'].join('\n'),
  );
  const zombies = await resolveZombies(records, async () => {
    throw new Error('ENOENT');
  });
  assert.equal(zombies.length, 1);
  assert.equal(zombies[0].bytes, 900);
});

test('resolveZombies stays silent when it cannot know — no inode, no claim', async () => {
  const records = parseLsofRecords(['p1', 'ca', 'f3', 'n/mystery.bin'].join('\n'));
  assert.deepEqual(await resolveZombies(records, async () => 5), []);
});

/* ══════════════════ Provenance (unit) ══════════════════ */

test('parseQuarantine reads the real four-field record', () => {
  // Recorded from a genuine Chrome download on macOS 15.
  const parsed = parseQuarantine('0281;6a3cbf22;Chrome;E30D49EA-EABB-4EA0-B01A-982E19CF317B');
  assert.equal(parsed.agent, 'Chrome');
  assert.equal(parsed.downloadedAt, 0x6a3cbf22 * 1000);
  assert.equal(new Date(parsed.downloadedAt!).getUTCFullYear(), 2026);
});

test('parseQuarantine refuses to invent a date from a malformed record', () => {
  assert.deepEqual(parseQuarantine('garbage'), { downloadedAt: null, agent: null });
  assert.equal(parseQuarantine('0281;zzzz;Chrome;x').downloadedAt, null);
});

test('hostOf survives hostile URL input without throwing', () => {
  assert.equal(hostOf('https://docs.google.com/a?b=c'), 'docs.google.com');
  assert.equal(hostOf('not a url'), null);
  assert.equal(hostOf(null), null);
  assert.equal(hostOf('javascript:alert(1)'), null);
});

/* ══════════════════ Topology mapping (unit) ══════════════════ */

test('wholeDiskOf strips partition and snapshot suffixes alike', () => {
  assert.equal(wholeDiskOf('disk0s2'), 'disk0');
  // The case a naive "strip the last sN" gets wrong.
  assert.equal(wholeDiskOf('disk3s1s1'), 'disk3');
  assert.equal(wholeDiskOf('disk10'), 'disk10');
});

test('mapTopology attributes APFS volumes to the drive, not to the partition', () => {
  // Shape recorded from `diskutil list -plist` on macOS 15.
  const topo = mapTopology({
    AllDisksAndPartitions: [
      { DeviceIdentifier: 'disk0', Size: 500_277_792_768, Content: 'GUID_partition_scheme', Partitions: [] },
      {
        DeviceIdentifier: 'disk3',
        Size: 494_384_795_648,
        APFSPhysicalStores: [{ DeviceIdentifier: 'disk0s2' }],
        APFSVolumes: [
          { DeviceIdentifier: 'disk3s1s1', VolumeName: 'Macintosh HD', MountPoint: '/', CapacityInUse: 12 },
          { DeviceIdentifier: 'disk3s5', VolumeName: 'Data', MountPoint: '/System/Volumes/Data', CapacityInUse: 9 },
        ],
      },
    ],
  });

  assert.deepEqual(
    topo.physicalDisks.map((d) => d.id),
    ['disk0'],
    'the synthesised APFS container is not a physical disk',
  );
  assert.equal(topo.logicalVolumes.length, 2);
  for (const v of topo.logicalVolumes) {
    assert.deepEqual(v.physicalDiskIds, ['disk0'], 'both volumes trace back to the one real drive');
  }
  // A5: the volume's own consumption rides along from the same diskutil call —
  // it is the only per-volume number that may be summed within a container.
  assert.deepEqual(
    topo.logicalVolumes.map((v) => v.usedBytes),
    [12, 9],
    'CapacityInUse becomes usedBytes',
  );
});

test('mapTopology collapses the system volume and its boot snapshot into one', () => {
  // Measured on this Mac: a booted machine lists "Macintosh HD" twice — the
  // volume (disk3s1, unmounted) and the sealed snapshot it boots from
  // (disk3s1s1, mounted at /), each carrying the same CapacityInUse. Keeping
  // both would count the system volume twice in any per-disk sum.
  const topo = mapTopology({
    AllDisksAndPartitions: [
      {
        DeviceIdentifier: 'disk3',
        Size: 494_384_795_648,
        APFSPhysicalStores: [{ DeviceIdentifier: 'disk0s2' }],
        APFSVolumes: [
          { DeviceIdentifier: 'disk3s1', VolumeName: 'Macintosh HD', CapacityInUse: 12_570_664_960 },
          { DeviceIdentifier: 'disk3s1s1', VolumeName: 'Macintosh HD', MountPoint: '/', CapacityInUse: 12_570_664_960 },
          { DeviceIdentifier: 'disk3s5', VolumeName: 'Data', MountPoint: '/System/Volumes/Data', CapacityInUse: 9 },
        ],
      },
    ],
  });
  assert.deepEqual(
    topo.logicalVolumes.map((v) => v.id),
    ['disk3s1s1', 'disk3s5'],
    'the mounted view survives; the unmounted twin goes',
  );

  // The mirror case — snapshot listed but not mounted, base volume mounted —
  // must keep the base instead. Order in the document must not matter either.
  const mirrored = mapTopology({
    AllDisksAndPartitions: [
      {
        DeviceIdentifier: 'disk3',
        APFSPhysicalStores: [{ DeviceIdentifier: 'disk0s2' }],
        APFSVolumes: [
          { DeviceIdentifier: 'disk3s1s1', VolumeName: 'Macintosh HD', CapacityInUse: 7 },
          { DeviceIdentifier: 'disk3s1', VolumeName: 'Macintosh HD', MountPoint: '/', CapacityInUse: 7 },
        ],
      },
    ],
  });
  assert.deepEqual(mirrored.logicalVolumes.map((v) => v.id), ['disk3s1']);
});

/**
 * The empty answer that exits 0.
 *
 * Measured on this Mac: 9 of 180 concurrent `diskutil list -plist` calls came
 * back exit 0, stderr empty, and every array in the document empty. Nothing but
 * the content distinguishes it from a real answer, and the content cannot be
 * true — a running Mac runs from a disk. See the header on `isImpossiblyEmpty`.
 */
test('an impossibly empty diskutil answer is recognised, and a real one is not', () => {
  // The recorded shape, verbatim in structure: every array present and empty.
  assert.equal(isImpossiblyEmpty({ AllDisksAndPartitions: [], WholeDisks: [] }), true);
  // Absent keys are the same failure wearing a different hat.
  assert.equal(isImpossiblyEmpty({}), true);
  // A real answer, however sparse, is not empty: one bare disk with no
  // partitions is a legitimate machine (a freshly erased external drive).
  assert.equal(isImpossiblyEmpty({ AllDisksAndPartitions: [{ DeviceIdentifier: 'disk0' }], WholeDisks: [] }), false);
  assert.equal(isImpossiblyEmpty({ AllDisksAndPartitions: [], WholeDisks: ['disk0'] }), false);
});

test('volumeTopology re-asks when diskutil answers the impossible, and never returns it', async () => {
  const real = { AllDisksAndPartitions: [{ DeviceIdentifier: 'disk0', Size: 8 }], WholeDisks: ['disk0'] };
  const empty = { AllDisksAndPartitions: [], WholeDisks: [] };

  // Transient: every empty answer measured recovered on the immediate retry.
  let calls = 0;
  const flaky = await volumeTopology(() => {
    calls++;
    return Promise.resolve(calls === 1 ? empty : real);
  });
  assert.equal(calls, 2, 'the impossible answer is re-asked, not accepted');
  assert.equal(flaky.physicalDisks.length, 1, 'and the real answer is what comes back');

  // Persistent: this must FAIL, loudly. An empty topology returned as a success
  // would be a zero, and §10 forbids a zero standing in for an unknown.
  let attempts = 0;
  await assert.rejects(
    () =>
      volumeTopology(() => {
        attempts++;
        return Promise.resolve(empty);
      }),
    /cannot be true on a running system/,
    'a layout that will not read is an error, never an empty list of drives',
  );
  assert.equal(attempts, 3, 'bounded — it does not retry forever');
});

test('enrichTopology fills free space from the real filesystem and never overwrites APFS usage', { skip: !IS_MAC }, async () => {
  const topology = {
    physicalDisks: [{ id: 'disk0', name: null, sizeBytes: null, rotational: null }],
    logicalVolumes: [
      // An APFS volume arrives with its own CapacityInUse; statfs on it sees the
      // whole container, so enrich must fill free space but leave usage alone.
      { id: 'v1', name: 'root', mountPoint: '/', filesystem: 'apfs', sizeBytes: null, freeBytes: null, usedBytes: 5, physicalDiskIds: ['disk0'], kind: 'apfs' },
      // A volume with no usage figure gets the statfs-derived one.
      { id: 'v2', name: 'root2', mountPoint: '/', filesystem: 'hfs', sizeBytes: null, freeBytes: null, usedBytes: null, physicalDiskIds: ['disk0'], kind: 'partition' },
      // Unmounted: everything stays null rather than becoming a guess.
      { id: 'v3', name: 'ghost', mountPoint: null, filesystem: 'apfs', sizeBytes: null, freeBytes: null, usedBytes: null, physicalDiskIds: ['disk0'], kind: 'apfs' },
    ],
    mechanism: 'fixture',
  };
  const enriched = await enrichTopology(topology);
  const st = await fsp.statfs('/');
  const expectFree = Number(st.bavail) * Number(st.bsize);

  const [v1, v2, v3] = enriched.logicalVolumes;
  assert.equal(v1.usedBytes, 5, 'statfs must not replace the per-volume APFS figure with the container-wide one');
  assert.ok(v1.freeBytes! > 0, 'free space filled for a mounted volume');
  // Same volume asked twice within one call: tolerate drift from concurrent writes.
  assert.ok(Math.abs(v1.freeBytes! - expectFree) < 256 * 1024 * 1024, 'free agrees with statfs ground truth');
  assert.ok(v2.usedBytes! > 0, 'a volume with no platform figure gets the statfs-derived one');
  assert.equal(v3.freeBytes, null, 'an unmounted volume stays unknown');
  assert.equal(v3.usedBytes, null);

  // The disk identity probe ran against the real disk0. Whatever this machine
  // is, the result must be a non-empty name or an honest null — never ''.
  assert.notEqual(enriched.physicalDisks[0].name, '');
});

test('mapTopology keeps non-APFS partitions visible', () => {
  // An exFAT stick must not vanish from a panel whose job is "which drive is filling up".
  const topo = mapTopology({
    AllDisksAndPartitions: [
      {
        DeviceIdentifier: 'disk4',
        Size: 64_000_000_000,
        Partitions: [
          { DeviceIdentifier: 'disk4s1', VolumeName: 'STICK', MountPoint: '/Volumes/STICK', Content: 'Microsoft Basic Data' },
        ],
      },
    ],
  });
  assert.equal(topo.logicalVolumes.length, 1);
  assert.equal(topo.logicalVolumes[0].mountPoint, '/Volumes/STICK');
});

test('mapTopology does not double-count an APFS container partition', () => {
  const topo = mapTopology({
    AllDisksAndPartitions: [
      {
        DeviceIdentifier: 'disk0',
        Partitions: [{ DeviceIdentifier: 'disk0s2', Content: 'Apple_APFS' }],
      },
    ],
  });
  assert.deepEqual(topo.logicalVolumes, [], 'the container is represented by its own entry, not twice');
});

/* ══════════════════ Snapshots (unit) ══════════════════ */

test('parseSnapshotList keeps snapshots and drops the header line', () => {
  const stdout = ['Snapshots for disk /:', 'com.apple.TimeMachine.2026-07-27-101500.local', ''].join('\n');
  const snaps = parseSnapshotList(stdout, '/');
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].volume, '/');
  assert.equal(snaps[0].accessPath, null, 'a snapshot is not readable until mounted');
});

test('snapshot timestamps are read as local time, not shifted to UTC', () => {
  const at = parseSnapshotDate('com.apple.TimeMachine.2026-07-27-101500.local');
  const d = new Date(at!);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getHours(), 10, 'a UTC parse would shift this by the machine offset');
  assert.equal(d.getMinutes(), 15);
});

/* ══════════════════ Placeholder helpers (unit) ══════════════════ */

test('decodeICloudStubName recovers the real filename from an evicted stub', () => {
  assert.equal(decodeICloudStubName('.Report.pdf.icloud'), 'Report.pdf');
  assert.equal(decodeICloudStubName('Report.pdf'), null);
});

test('providerForPath labels each sync folder', () => {
  assert.equal(providerForPath('/Users/me/Library/Mobile Documents/x'), 'icloud');
  assert.equal(providerForPath('/Users/me/OneDrive - Corp/x'), 'onedrive');
  assert.equal(providerForPath('/Users/me/Dropbox/x'), 'dropbox');
  assert.equal(providerForPath('/Users/me/Documents/x'), 'unknown');
});

/* ══════════════════ SMART mapping (unit) ══════════════════ */

test('mapSmartctl reports attributes and never carries the serial number', () => {
  const info = mapSmartctl(
    {
      model_name: 'Samsung SSD 990',
      power_on_time: { hours: 1200 },
      smart_status: { passed: true },
      nvme_smart_health_information_log: { percentage_used: 3 },
      ata_smart_attributes: { table: [{ id: 5, name: 'Reallocated_Sector_Ct', value: 100, raw: { value: 0 } }] },
    },
    '/dev/disk0',
  );
  assert.equal(info.modelName, 'Samsung SSD 990');
  assert.equal(info.percentageUsed, 3);
  assert.equal(info.reallocatedSectors, 0);
  assert.equal(info.selfAssessmentPassed, true);
  assert.equal(info.serialRedacted, true);
  assert.ok(!JSON.stringify(info).includes('serial_number'));
});

test('mapSmartctl reports unknown rather than zero when the drive says nothing', () => {
  // A drive behind a USB bridge often reports nothing. Zero would read as
  // "perfect health"; null reads as "cannot know", which is the truth.
  const info = mapSmartctl({}, '/dev/disk9');
  assert.equal(info.percentageUsed, null);
  assert.equal(info.reallocatedSectors, null);
  assert.equal(info.selfAssessmentPassed, null);
});

/* ══════════════════ Integration: real filesystem ══════════════════ */

test('fastEnumerate yields every entry, with directories before their contents', async () => {
  const dir = await mkTmp();
  try {
    await fsp.mkdir(path.join(dir, 'sub', 'deep'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'sub', 'deep', 'a.txt'), 'hello');
    await fsp.writeFile(path.join(dir, 'top.txt'), 'hi');

    const seen: string[] = [];
    for await (const entry of platform().fastEnumerate(dir)) seen.push(entry.path);

    assert.ok(seen.includes(path.join(dir, 'sub', 'deep', 'a.txt')), 'reaches the deepest file');
    assert.ok(
      seen.indexOf(path.join(dir, 'sub')) < seen.indexOf(path.join(dir, 'sub', 'deep', 'a.txt')),
      'a directory is emitted before anything inside it, so a consumer can build a tree in one pass',
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('fastEnumerate reports real sizes and inode identity', async () => {
  const dir = await mkTmp();
  try {
    const file = path.join(dir, 'sized.bin');
    await fsp.writeFile(file, Buffer.alloc(4096, 1));
    let found: { size: number; ino: number; nlink: number } | null = null;
    for await (const e of platform().fastEnumerate(dir)) if (e.path === file) found = e;
    assert.ok(found);
    assert.equal(found!.size, 4096);
    assert.ok(found!.ino > 0, 'inode identity is what makes hard-link detection possible');
    assert.equal(found!.nlink, 1);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('fastEnumerate honours cooperative cancellation', async () => {
  const dir = await mkTmp();
  try {
    for (let i = 0; i < 40; i++) await fsp.mkdir(path.join(dir, `d${String(i)}`));
    let count = 0;
    let cancelled = false;
    for await (const _e of platform().fastEnumerate(dir, { isCancelled: () => cancelled })) {
      count++;
      if (count > 2) cancelled = true;
    }
    assert.ok(count < 41, 'cancellation stopped the walk early');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('fastEnumerate skips what the caller asks it to skip', async () => {
  const dir = await mkTmp();
  try {
    await fsp.mkdir(path.join(dir, 'keep'));
    await fsp.mkdir(path.join(dir, 'drop'));
    await fsp.writeFile(path.join(dir, 'drop', 'hidden.txt'), 'x');
    const seen: string[] = [];
    // path.sep, not '/': the enumerator hands back host-separated paths, and
    // a '/'-anchored suffix silently never matches on Windows — the skip
    // callback then never fires and the test fails for a reason that has
    // nothing to do with skipping.
    for await (const e of platform().fastEnumerate(dir, { skip: (p) => p.endsWith(path.sep + 'drop') })) seen.push(e.path);
    assert.ok(seen.some((p) => p.endsWith(path.sep + 'keep')));
    assert.ok(!seen.some((p) => p.includes(path.sep + 'drop')), 'a skipped directory takes its whole subtree with it');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// Windows is excluded because its answer is genuinely different, not broken:
// NTFS allocates a truncate-only file SOLID unless FSCTL_SET_SPARSE was set,
// so ~50 MB allocated is the true on-disk figure there (CI's first real
// Windows run recorded it). Asserting the POSIX expectation would measure
// the filesystem's semantics, not the code.
test('getAllocatedSize tells a sparse file from a solid one', { skip: process.platform === 'win32' && 'NTFS allocates truncate-only files solid; the full size is the honest answer' }, async () => {
  const dir = await mkTmp();
  try {
    const sparse = path.join(dir, 'sparse.bin');
    const fd = fs.openSync(sparse, 'w');
    fs.ftruncateSync(fd, 50 * 1024 * 1024);
    fs.closeSync(fd);

    const solid = path.join(dir, 'solid.bin');
    await fsp.writeFile(solid, Buffer.alloc(1024 * 1024, 3));

    const p = platform();
    const sparseAllocated = await p.getAllocatedSize(sparse);
    const solidAllocated = await p.getAllocatedSize(solid);

    assert.equal((await fsp.stat(sparse)).size, 50 * 1024 * 1024, 'it claims 50 MB');
    assert.ok(sparseAllocated < 1024 * 1024, `but occupies almost nothing (got ${String(sparseAllocated)})`);
    assert.ok(solidAllocated >= 1024 * 1024, 'a solid file occupies what it claims');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an ordinary fully-local file is never mislabelled as a cloud placeholder', async () => {
  const dir = await mkTmp();
  try {
    const solid = path.join(dir, 'solid.bin');
    await fsp.writeFile(solid, Buffer.alloc(65536, 9));
    assert.equal(await platform().getPlaceholderInfo(solid), null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('B2: a file held open by a live process is reported, with the process named', { skip: !IS_MAC }, async () => {
  const dir = await mkTmp();
  try {
    const target = path.join(dir, 'held.bin');
    await fsp.writeFile(target, Buffer.alloc(2048, 1));
    const fd = fs.openSync(target, 'r');
    try {
      const held = await openHandlesFor([target]);
      // `some`, not `length === 1`. The claim is "this process's open
      // descriptor is found", and `openHandlesFor` reports EVERY process
      // holding the path — on a shared runner an indexing daemon touching the
      // same temp file would make this two without anything being wrong.
      const mine = held.filter((h) => h.pid === process.pid);
      assert.equal(mine.length, 1, 'the open descriptor is found');
      assert.equal(mine[0].pid, process.pid);
      assert.ok(mine[0].processName.length > 0, 'the warning can name the program');
      assert.equal(mine[0].path, target, 'the path is reported as the caller asked, not symlink-resolved');
    } finally {
      fs.closeSync(fd);
    }
    assert.deepEqual(await openHandlesFor([target]), [], 'once closed, nothing is reported');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('B2: one vanished path in a batch does not blind the whole check', { skip: !IS_MAC }, async () => {
  // The regression that motivated CommandFailedError: lsof exits 1 when any
  // argument is missing, which previously discarded its perfectly good output
  // for every other path — silently answering "nothing has this open".
  const dir = await mkTmp();
  try {
    const target = path.join(dir, 'held.bin');
    await fsp.writeFile(target, Buffer.alloc(2048, 1));
    const fd = fs.openSync(target, 'r');
    try {
      const held = await openHandlesFor([target, path.join(dir, 'never-existed.bin')]);
      const mine = held.filter((h) => h.pid === process.pid);
      assert.equal(mine.length, 1, 'the surviving path is still checked');
      assert.equal(mine[0].pid, process.pid);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('B2: a batch check of 1,000 paths costs one pass, not a thousand', { skip: !IS_MAC }, async (t) => {
  /**
   * §B2's acceptance criterion is that a batch check is affordable. The
   * absolute figure it used to assert — `elapsed < 1000` — measures the
   * RUNNER, not the code: the window contains a single `lsof` that enumerates
   * every process on the machine, so its cost tracks how busy the host is and
   * not the 1,000 paths at all. Measured here on an idle Mac: 274-300 ms
   * against a 1,000 ms bound, i.e. 3.4x of headroom on hardware that GitHub's
   * shared macOS runners are routinely 2-3x slower than. That is the same
   * shape as the `diskUsage`/PowerShell flake this suite already paid for.
   *
   * The machine-independent claim underneath it is that the cost is FLAT in
   * the size of the set, because it is one enumeration either way — a
   * per-path implementation would cost about a thousand times the one-path
   * figure, not about one. That is what is asserted, in the same form
   * `openHandleGuard.test.ts` already uses, with the real number recorded as
   * a diagnostic so a regression in absolute cost is still visible.
   */
  const dir = await mkTmp();
  try {
    const paths: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const p = path.join(dir, `f${String(i)}.bin`);
      await fsp.writeFile(p, 'x');
      paths.push(p);
    }
    const t1 = Date.now();
    await openHandlesFor([paths[0]]);
    const one = Date.now() - t1;

    const t1000 = Date.now();
    await openHandlesFor(paths);
    const thousand = Date.now() - t1000;

    t.diagnostic(`open-handle batch: 1 path ${String(one)}ms · 1,000 paths ${String(thousand)}ms`);
    assert.ok(
      thousand < Math.max(one * 10 + 250, 3000),
      `a 1,000-path check must not scale with the batch (1: ${String(one)}ms, 1000: ${String(thousand)}ms)`,
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('B5: a deleted-but-open file is detected, and released once closed', { skip: !IS_MAC }, async () => {
  const dir = await mkTmp();
  try {
    const target = path.join(dir, 'zombie.bin');
    const bytes = 3_000_000;
    await fsp.writeFile(target, Buffer.alloc(bytes, 5));
    const fd = fs.openSync(target, 'r');
    await fsp.unlink(target); // deleted, but this process still holds it

    const mine = (await platform().getZombieHandles()).filter((z) => z.path.includes(path.basename(dir)));
    assert.equal(mine.length, 1, 'the unlinked-but-open inode is found');
    assert.equal(mine[0].pid, process.pid);
    assert.equal(mine[0].bytes, bytes, 'the reclaimable byte count is the real one');

    fs.closeSync(fd);
    const after = (await platform().getZombieHandles()).filter((z) => z.path.includes(path.basename(dir)));
    assert.deepEqual(after, [], 'closing the descriptor genuinely releases the space');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('A5: topology on this machine names real hardware and real mount points', { skip: !IS_MAC }, async () => {
  const topo = await platform().getVolumeTopology();
  assert.ok(topo.physicalDisks.length >= 1, 'at least one physical disk is found');
  const mounted = topo.logicalVolumes.filter((v) => v.mountPoint);
  assert.ok(mounted.length >= 1, 'at least one mounted volume is found');
  const rootVolume = mounted.find((v) => v.mountPoint === '/');
  assert.ok(rootVolume, 'the boot volume is present');
  assert.ok(rootVolume!.physicalDiskIds.length > 0, 'and is attributed to a physical disk');
  for (const v of mounted) {
    for (const id of v.physicalDiskIds) {
      assert.ok(
        topo.physicalDisks.some((d) => d.id === id),
        `volume ${v.id} points at physical disk ${id}, which must exist in the same answer`,
      );
    }
  }
});
