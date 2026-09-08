import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readOpenDescriptors, openHandlesFor, zombieHandles } from '../src/platform/linux/procFdGuard';
import { mapLsblk, mapZpool } from '../src/platform/linux/topology';
import { parseSubvolumeList } from '../src/platform/linux/btrfs';
import { addThunarAction, removeThunarAction, nautilusScript, xmlEscape } from '../src/platform/linux/shellIntegration';
import { parseZoneIdentifier, hostOf as winHostOf } from '../src/platform/windows/zoneIdentifier';
import { mapWindowsTopology, readWindowsTopologyDoc, TOPOLOGY_SCRIPT } from '../src/platform/windows/topology';
import {
  isCloudPlaceholder,
  isSparse,
  isCompressed,
  mapFileFacts,
  toPlaceholderInfo,
  providerForPath as winProviderForPath,
  FILE_ATTRIBUTE,
} from '../src/platform/windows/attributes';
import { mapShadowCopies, normalizeVolume, parseInstallDate } from '../src/platform/windows/vss';
import { installCommands, uninstallCommands, SHELL_KEYS } from '../src/platform/windows/shellIntegration';
import { mapRestartManagerOutput, RM_SCRIPT } from '../src/platform/windows/restartManager';
import { asArray } from '../src/platform/windows/powershell';

/**
 * Windows and Linux mechanisms, tested from macOS.
 *
 * This file exists because of a hard constraint stated plainly: the author's
 * machine is a Mac, so the Windows and Linux providers were written against
 * documented APIs and have never been executed on their own operating systems.
 *
 * The response is to make every part that *can* be tested anywhere pure, and
 * then to test it hard — parsers, bit arithmetic, argv construction, JSON
 * mapping. Fixtures reproduce the shapes those tools genuinely emit, including
 * the awkward ones (ConvertTo-Json collapsing a one-element array, volume GUID
 * paths, localised output avoided by choosing CIM over vssadmin).
 *
 * The remaining round-trips run in CI only where a test is gated to that OS
 * (.github/workflows/test.yml has windows-latest and ubuntu-latest legs). Today
 * that is the Windows topology live test below; RmGetList and `lsblk -O` are
 * still checked for the shape of the script and the argv only. That is the
 * honest division: logic is proven here, a syscall is proven there only when
 * a live test says so, and nothing is claimed to be verified that is not.
 */

const mkTmp = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), 'tm-xos-'));

/* ════════════════════════ Linux: /proc handle guard ════════════════════════ */

/**
 * Build a fake /proc tree. `readOpenDescriptors` takes its root as a parameter
 * precisely so the walk can be exercised on any OS.
 */
async function fakeProc(
  procRoot: string,
  processes: { pid: number; comm: string; fds: { name: string; target: string }[] }[],
): Promise<void> {
  for (const proc of processes) {
    const dir = path.join(procRoot, String(proc.pid));
    await fsp.mkdir(path.join(dir, 'fd'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'comm'), proc.comm + '\n');
    for (const fd of proc.fds) {
      await fsp.symlink(fd.target, path.join(dir, 'fd', fd.name)).catch(() => {});
    }
  }
}

// The fake-/proc fixture is built from symlinks whose TARGETS are Linux fd
// strings ('socket:[123]', '/path (deleted)') — NTFS forbids ':' inside a
// path segment, so on a Windows host the fixture cannot exist and every
// assertion (including the ones that pass vacuously on empty results) would
// measure the fixture's absence rather than the guard. The module under
// test is Linux's own mechanism; the POSIX hosts prove it for real.
const WIN_NO_PROC_FIXTURE = process.platform === 'win32' && 'the fake /proc fixture needs POSIX symlink targets';

test('linux: readOpenDescriptors walks /proc and names each process', { skip: WIN_NO_PROC_FIXTURE }, async () => {
  const root = await mkTmp();
  try {
    await fakeProc(root, [
      { pid: 100, comm: 'firefox', fds: [{ name: '3', target: '/home/me/video.mp4' }] },
      { pid: 200, comm: 'code', fds: [{ name: '7', target: '/home/me/notes.md' }] },
    ]);
    // Non-numeric /proc entries must be ignored, not treated as pids.
    await fsp.mkdir(path.join(root, 'meminfo-dir'), { recursive: true });

    const records = await readOpenDescriptors(root);
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((r) => r.processName).sort(),
      ['code', 'firefox'],
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('linux: sockets, pipes and /proc self-references are not files', { skip: WIN_NO_PROC_FIXTURE }, async () => {
  const root = await mkTmp();
  try {
    await fakeProc(root, [
      {
        pid: 1,
        comm: 'daemon',
        fds: [
          { name: '0', target: 'socket:[12345]' },
          { name: '1', target: 'pipe:[999]' },
          { name: '2', target: 'anon_inode:[eventpoll]' },
          { name: '3', target: '/proc/1/status' },
          { name: '4', target: '/home/me/real.txt' },
        ],
      },
    ]);
    const records = await readOpenDescriptors(root);
    assert.deepEqual(
      records.map((r) => r.path),
      ['/home/me/real.txt'],
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('linux: openHandlesFor matches only the requested paths', { skip: WIN_NO_PROC_FIXTURE }, async () => {
  const root = await mkTmp();
  try {
    await fakeProc(root, [
      { pid: 42, comm: 'chrome', fds: [{ name: '3', target: '/data/wanted.bin' }, { name: '4', target: '/data/other.bin' }] },
    ]);
    const hits = await openHandlesFor(['/data/wanted.bin'], root);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].processName, 'chrome');
    assert.equal(hits[0].pid, 42);
    assert.equal(hits[0].path, '/data/wanted.bin');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('linux: an unlinked inode blocks no delete, so it is not an open-handle conflict', { skip: WIN_NO_PROC_FIXTURE }, async () => {
  const root = await mkTmp();
  try {
    await fakeProc(root, [{ pid: 7, comm: 'x', fds: [{ name: '3', target: '/data/f.bin (deleted)' }] }]);
    assert.deepEqual(await openHandlesFor(['/data/f.bin'], root), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('linux: a real file whose NAME ends in " (deleted)" is not reported as a zombie', { skip: WIN_NO_PROC_FIXTURE }, async () => {
  // The trap: trusting the kernel's suffix blindly would report a live file as
  // reclaimable space and invite the user to kill the process holding it.
  const root = await mkTmp();
  const data = await mkTmp();
  try {
    const tricky = path.join(data, 'notes (deleted)');
    await fsp.writeFile(tricky, 'still very much alive');
    await fakeProc(root, [{ pid: 5, comm: 'editor', fds: [{ name: '3', target: `${tricky} (deleted)` }] }]);

    const zombies = await zombieHandles(root);
    assert.deepEqual(zombies, [], 'the file still exists at that path with that inode, so it is not a zombie');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(data, { recursive: true, force: true });
  }
});

test('linux: a genuinely unlinked inode IS reported as a zombie', { skip: WIN_NO_PROC_FIXTURE }, async () => {
  const root = await mkTmp();
  try {
    await fakeProc(root, [{ pid: 8, comm: 'logger', fds: [{ name: '3', target: '/var/log/gone.log (deleted)' }] }]);
    const zombies = await zombieHandles(root);
    assert.equal(zombies.length, 1);
    assert.equal(zombies[0].path, '/var/log/gone.log');
    assert.equal(zombies[0].processName, 'logger');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/* ════════════════════════ Linux: lsblk topology ════════════════════════ */

test('linux: mapLsblk maps a plain single-disk laptop to a clean 1:1 view', () => {
  const topo = mapLsblk({
    blockdevices: [
      {
        name: 'nvme0n1',
        path: '/dev/nvme0n1',
        type: 'disk',
        size: 512_110_190_592,
        rota: false,
        model: 'Samsung SSD 980',
        children: [
          { name: 'nvme0n1p1', path: '/dev/nvme0n1p1', type: 'part', fstype: 'vfat', mountpoints: ['/boot/efi'], size: 536_870_912 },
          {
            name: 'nvme0n1p2', path: '/dev/nvme0n1p2', type: 'part', fstype: 'ext4', mountpoints: ['/'],
            size: 511_000_000_000, fssize: 502_000_000_000, fsavail: 300_000_000_000, fsused: 180_000_000_000,
          },
        ],
      },
    ],
  });
  assert.equal(topo.physicalDisks.length, 1);
  assert.equal(topo.physicalDisks[0].rotational, false, 'rotational comes from the kernel, not a guess');
  assert.equal(topo.logicalVolumes.length, 2);
  assert.deepEqual(topo.logicalVolumes[1].physicalDiskIds, ['/dev/nvme0n1']);
  assert.equal(topo.logicalVolumes[1].mountPoint, '/');
  // A5: usage is the kernel's FSUSED, not fssize − fsavail — that subtraction
  // would book ext4's root reserve (~2% here) as the user's data.
  assert.equal(topo.logicalVolumes[1].usedBytes, 180_000_000_000);
  assert.equal(topo.logicalVolumes[0].usedBytes, null, 'no FSUSED column → unknown, never zero');
});

test('linux: an LVM volume spanning two disks names both', () => {
  // The question A5 exists to answer: which physical drive is filling up.
  const topo = mapLsblk({
    blockdevices: [
      {
        name: 'sda',
        path: '/dev/sda',
        type: 'disk',
        rota: true,
        children: [
          {
            name: 'sda1',
            path: '/dev/sda1',
            type: 'part',
            children: [{ name: 'vg0-root', path: '/dev/mapper/vg0-root', type: 'lvm', fstype: 'ext4', mountpoints: ['/'] }],
          },
        ],
      },
    ],
  });
  const root = topo.logicalVolumes.find((v) => v.mountPoint === '/');
  assert.ok(root);
  assert.equal(root!.kind, 'lvm');
  assert.deepEqual(root!.physicalDiskIds, ['/dev/sda'], 'the LV traces back to real hardware');
  assert.equal(topo.physicalDisks[0].rotational, true);
});

test('linux: an unmounted container device is not listed as a usable volume', () => {
  const topo = mapLsblk({
    blockdevices: [
      {
        name: 'sda',
        path: '/dev/sda',
        type: 'disk',
        children: [
          {
            name: 'sda1',
            path: '/dev/sda1',
            type: 'part',
            mountpoints: [null],
            children: [{ name: 'crypt', path: '/dev/mapper/crypt', type: 'crypt', fstype: 'ext4', mountpoints: ['/'] }],
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    topo.logicalVolumes.map((v) => v.mountPoint),
    ['/'],
    'the LUKS container itself holds no filesystem the user can fill',
  );
});

test('linux: lsblk string sizes never become a wrong number', () => {
  const topo = mapLsblk({
    blockdevices: [{ name: 'sda', path: '/dev/sda', type: 'disk', size: '500G' as unknown as number }],
  });
  assert.equal(topo.physicalDisks[0].sizeBytes, null, 'an unparseable size is unknown, not zero and not misread');
});

test('linux: mapZpool surfaces ZFS pools that lsblk cannot see', () => {
  const vols = mapZpool({
    pools: {
      tank: {
        name: 'tank',
        properties: { size: { value: '4000000000000' }, free: { value: '1500000000000' }, allocated: { value: '2500000000000' } },
      },
    },
  });
  assert.equal(vols.length, 1);
  assert.equal(vols[0].kind, 'zfs');
  assert.equal(vols[0].sizeBytes, 4_000_000_000_000);
  assert.equal(vols[0].usedBytes, 2_500_000_000_000, "zpool's own allocated figure, raw-space like its free");
});

/* ════════════════════════ Linux: btrfs snapshots ════════════════════════ */

test('linux: parseSubvolumeList reads real subvolume output', () => {
  const stdout = [
    'ID 256 gen 30 cgen 30 top level 5 otime 2026-07-27 10:15:00 path snaps/home-2026-07-27',
    'ID 257 gen 31 cgen 31 top level 5 otime 2026-07-26 09:00:00 path snaps/home-2026-07-26',
  ].join('\n');
  const snaps = parseSubvolumeList(stdout, '/');
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0].id, '256');
  assert.equal(snaps[0].name, 'snaps/home-2026-07-27');
  assert.equal(snaps[0].accessPath, '/snaps/home-2026-07-27', 'btrfs snapshots need no mount step');
  const d = new Date(snaps[0].takenAt!);
  assert.equal(d.getHours(), 10, 'otime is local time; a UTC parse would shift it');
});

test('linux: a snapshot path containing spaces survives the parse', () => {
  const snaps = parseSubvolumeList('ID 9 gen 1 cgen 1 top level 5 otime 2026-01-01 00:00:00 path my snaps/home dir', '/');
  assert.equal(snaps[0].name, 'my snaps/home dir');
});

/* ════════════════════════ Linux: shell integration ════════════════════════ */

test('linux: the Nautilus script reads the selection safely, one path per line', () => {
  const script = nautilusScript('/opt/TreeMap/treemap');
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /while IFS= read -r target/, 'word-splitting would break paths containing spaces');
  assert.match(script, /'\/opt\/TreeMap\/treemap'/, 'the executable path is quoted');
});

test('linux: Thunar action is added without destroying the user\u2019s own actions', () => {
  const existing = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<actions>',
    '<action><name>My Custom Thing</name><unique-id>mine-1</unique-id></action>',
    '</actions>',
  ].join('\n');

  const merged = addThunarAction(existing, '/opt/treemap');
  assert.ok(merged.includes('mine-1'), "the user's own action survives");
  assert.ok(merged.includes('treemap-scan-1'), 'ours is added');
  assert.equal(merged.indexOf('</actions>'), merged.lastIndexOf('</actions>'), 'the document stays well-formed');
});

test('linux: installing twice does not duplicate the Thunar menu entry', () => {
  const once = addThunarAction(null, '/opt/treemap');
  const twice = addThunarAction(once, '/opt/treemap');
  assert.equal(once, twice);
});

test('linux: uninstall removes only our Thunar action', () => {
  const merged = addThunarAction(
    '<?xml version="1.0"?>\n<actions>\n<action><unique-id>mine-1</unique-id></action>\n</actions>\n',
    '/opt/treemap',
  );
  const cleaned = removeThunarAction(merged)!;
  assert.ok(cleaned.includes('mine-1'), "the user's action is untouched");
  assert.ok(!cleaned.includes('treemap-scan-1'), 'no dead entry is left behind');
});

test('linux: an unrecognised uca.xml is left alone rather than corrupted', () => {
  const garbage = 'this is not xml at all';
  assert.equal(addThunarAction(garbage, '/opt/treemap'), garbage);
});

test('linux: xmlEscape neutralises a hostile executable path', () => {
  assert.equal(xmlEscape('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});

/* ════════════════════════ Windows: Zone.Identifier ════════════════════════ */

test('windows: parseZoneIdentifier reads a real stream', () => {
  const raw = ['[ZoneTransfer]', 'ZoneId=3', 'ReferrerUrl=https://example.com/page', 'HostUrl=https://cdn.example.com/f.zip'].join('\r\n');
  const parsed = parseZoneIdentifier(raw);
  assert.equal(parsed.zoneId, 3);
  assert.equal(parsed.hostUrl, 'https://cdn.example.com/f.zip');
  assert.equal(parsed.referrerUrl, 'https://example.com/page');
});

test('windows: a URL containing "=" is not truncated at the first one', () => {
  const parsed = parseZoneIdentifier('[ZoneTransfer]\nHostUrl=https://x.test/d?a=1&b=2');
  assert.equal(parsed.hostUrl, 'https://x.test/d?a=1&b=2');
});

test('windows: keys are matched case-insensitively and a BOM is tolerated', () => {
  const parsed = parseZoneIdentifier('\uFEFF[ZoneTransfer]\r\nhosturl=https://a.test/f\r\n');
  assert.equal(parsed.hostUrl, 'https://a.test/f');
});

test('windows: a stream with no URLs yields nothing rather than empty strings', () => {
  const parsed = parseZoneIdentifier('[ZoneTransfer]\r\nZoneId=3\r\n');
  assert.equal(parsed.hostUrl, null);
  assert.equal(parsed.referrerUrl, null);
});

test('windows: hostOf never throws on a hostile Zone.Identifier value', () => {
  assert.equal(winHostOf('https://good.test/x'), 'good.test');
  assert.equal(winHostOf('"><script>alert(1)</script>'), null);
});

/* ════════════════════════ Windows: file attributes ════════════════════════ */

test('windows: cloud placeholder attributes are recognised, ordinary files are not', () => {
  assert.equal(isCloudPlaceholder(FILE_ATTRIBUTE.RECALL_ON_DATA_ACCESS), true);
  assert.equal(isCloudPlaceholder(FILE_ATTRIBUTE.RECALL_ON_OPEN), true);
  assert.equal(isCloudPlaceholder(FILE_ATTRIBUTE.OFFLINE), true);
  assert.equal(isCloudPlaceholder(0x20 /* ARCHIVE */), false);
  // A sparse VM disk is not a cloud file, and must never be labelled as one.
  assert.equal(isCloudPlaceholder(FILE_ATTRIBUTE.SPARSE_FILE), false);
  assert.equal(isSparse(FILE_ATTRIBUTE.SPARSE_FILE), true);
  assert.equal(isCompressed(FILE_ATTRIBUTE.COMPRESSED), true);
});

test('windows: an evicted OneDrive placeholder reports cloud size and zero local size', () => {
  const info = toPlaceholderInfo({
    path: 'C:\\Users\\me\\OneDrive\\big.mov',
    length: 4_200_000_000,
    attributes: FILE_ATTRIBUTE.RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE.REPARSE_POINT,
    allocated: 0,
  });
  assert.ok(info);
  assert.equal(info!.logicalSize, 4_200_000_000);
  assert.equal(info!.localSize, 0);
  assert.equal(info!.evicted, true);
  assert.equal(info!.provider, 'onedrive');
});

test('windows: the same file kept on the device reports full local usage', () => {
  // A3's acceptance criterion, both directions.
  const info = toPlaceholderInfo({
    path: 'C:\\Users\\me\\OneDrive\\big.mov',
    length: 4_200_000_000,
    attributes: 0x20,
    allocated: 4_200_000_000,
  });
  assert.equal(info, null, 'a fully-resident file is not a placeholder at all');
});

test('windows: an NTFS-compressed file reports its compressed size, not its logical one', () => {
  const info = toPlaceholderInfo({
    path: 'C:\\data\\logs.txt',
    length: 100_000_000,
    attributes: FILE_ATTRIBUTE.COMPRESSED,
    allocated: 12_000_000,
  });
  assert.ok(info);
  assert.equal(info!.localSize, 12_000_000);
  assert.equal(info!.evicted, false, 'compressed is not evicted');
  assert.match(info!.mechanism, /compression/i);
});

test('windows: mapFileFacts survives ConvertTo-Json collapsing one result to an object', () => {
  // The single-file case is the common one, and the shape differs from the
  // many-file case — a mapper that only handles arrays silently returns none.
  const single = mapFileFacts({ path: 'C:\\a.txt', length: 10, attributes: 32, allocated: 4096 });
  assert.equal(single.length, 1);
  const many = mapFileFacts([{ path: 'C:\\a.txt', attributes: 32 }, { path: 'C:\\b.txt', attributes: 32 }]);
  assert.equal(many.length, 2);
});

test('windows: providerForPath is case-insensitive, as Windows paths are', () => {
  assert.equal(winProviderForPath('C:\\Users\\me\\onedrive\\x'), 'onedrive');
  assert.equal(winProviderForPath('C:\\Users\\me\\Documents\\x'), 'unknown');
});

/* ════════════════════════ Windows: topology ════════════════════════ */

test('windows: a plain laptop maps to one disk with its volumes', () => {
  const topo = mapWindowsTopology({
    disks: { Number: 0, FriendlyName: 'NVMe SSD', Size: 512_000_000_000 },
    physical: { DeviceId: '0', FriendlyName: 'NVMe SSD', Size: 512_000_000_000, MediaType: 'SSD' },
    volumes: { DriveLetter: 'C', FileSystem: 'NTFS', Size: 500_000_000_000, SizeRemaining: 120_000_000_000 },
    partitions: { DiskNumber: 0, DriveLetter: 'C' },
  });
  assert.equal(topo.physicalDisks.length, 1, 'ConvertTo-Json returned an object, not an array — still one disk');
  assert.equal(topo.physicalDisks[0].rotational, false);
  assert.equal(topo.logicalVolumes.length, 1);
  assert.equal(topo.logicalVolumes[0].mountPoint, 'C:\\');
  assert.equal(topo.logicalVolumes[0].freeBytes, 120_000_000_000);
  // A5: an NTFS volume owns its space outright, so used really is size − free.
  assert.equal(topo.logicalVolumes[0].usedBytes, 380_000_000_000);
});

test('windows: a volume missing size figures reports unknown usage, not zero', () => {
  const topo = mapWindowsTopology({
    physical: { DeviceId: '0', MediaType: 'SSD' },
    volumes: { DriveLetter: 'C', FileSystem: 'NTFS' },
  });
  assert.equal(topo.logicalVolumes[0].usedBytes, null);
  assert.deepEqual(topo.logicalVolumes[0].physicalDiskIds, ['physical:0'], 'one disk shown and no partition map: the volume can only be there');
});

test('windows: a Storage Spaces volume is attributed to every unclaimed disk when the association names none', () => {
  const topo = mapWindowsTopology({
    physical: [
      { DeviceId: '0', FriendlyName: 'HDD 1', MediaType: 'HDD' },
      { DeviceId: '1', FriendlyName: 'HDD 2', MediaType: 'HDD' },
      { DeviceId: '2', FriendlyName: 'HDD 3', MediaType: 'HDD' },
    ],
    virtual: { FriendlyName: 'Pool', Size: 12_000_000_000_000, ResiliencySettingName: 'Parity' },
    volumes: { DriveLetter: 'D', FileSystem: 'NTFS', Size: 12_000_000_000_000, SizeRemaining: 1_000_000_000_000 },
  });
  assert.equal(topo.physicalDisks.length, 3, 'the pool is three drives, not one virtual disk');
  assert.equal(topo.logicalVolumes[0].kind, 'storage-spaces');
  assert.equal(
    topo.logicalVolumes[0].physicalDiskIds.length,
    3,
    'a pooled volume genuinely spans all three, so naming one would be a confident wrong answer',
  );
});

test('windows: MediaType "Unspecified" reports unknown, never "not rotational"', () => {
  const topo = mapWindowsTopology({ physical: { DeviceId: '0', MediaType: 'Unspecified' } });
  assert.equal(topo.physicalDisks[0].rotational, null);
});

/* Issue #35: two Samsung 980 PROs, C: on one and D: on the other, and the
   panel said "No volumes on this disk." under both while listing C: and D: as
   loose "SIMPLE" cards. The mapper only consulted the partition → disk map
   when Get-PhysicalDisk had returned nothing, and otherwise hung the volumes
   on the hardware only when there was exactly one disk — so every multi-disk
   Windows machine without a pool orphaned every volume, and a one-disk laptop
   (and the CI runner) hid it. */
const REPORTER_35 = {
  disks: [
    { Number: 0, FriendlyName: 'Samsung SSD 980 PRO 2TB', Size: 2_000_398_934_016, BusType: 'NVMe', UniqueId: 'eui.002538B321B0AAAA' },
    { Number: 1, FriendlyName: 'Samsung SSD 980 PRO 2TB', Size: 2_000_398_934_016, BusType: 'NVMe', UniqueId: 'eui.002538B321B0BBBB' },
  ],
  physical: [
    { DeviceId: '0', FriendlyName: 'Samsung SSD 980 PRO 2TB', Size: 2_000_398_934_016, MediaType: 'SSD', UniqueId: 'eui.002538B321B0AAAA' },
    { DeviceId: '1', FriendlyName: 'Samsung SSD 980 PRO 2TB', Size: 2_000_398_934_016, MediaType: 'SSD', UniqueId: 'eui.002538B321B0BBBB' },
  ],
  volumes: [
    { DriveLetter: 'C', FileSystem: 'NTFS', Size: 1_999_000_000_000, SizeRemaining: 365_500_000_000 },
    { DriveLetter: 'D', FileSystem: 'NTFS', Size: 1_999_000_000_000, SizeRemaining: 299_700_000_000 },
  ],
  partitions: [{ DiskNumber: 0, DriveLetter: 'C' }, { DiskNumber: 1, DriveLetter: 'D' }],
};

test('windows: two SSDs, two volumes — each volume hangs on the disk its partition lives on (issue #35)', () => {
  const topo = mapWindowsTopology(REPORTER_35);
  assert.equal(topo.physicalDisks.length, 2, 'two drives, no pool');
  const byLetter = Object.fromEntries(topo.logicalVolumes.map((v) => [v.id, v]));
  assert.deepEqual(byLetter['C:'].physicalDiskIds, ['physical:0'], 'C: is on disk 0');
  assert.deepEqual(byLetter['D:'].physicalDiskIds, ['physical:1'], 'D: is on disk 1');
  assert.equal(byLetter['C:'].kind, 'simple');
  for (const v of topo.logicalVolumes) {
    for (const id of v.physicalDiskIds) assert.ok(topo.physicalDisks.some((d) => d.id === id), `${v.id} names a disk that is shown: ${id}`);
  }
  assert.equal(topo.physicalDisks[0].rotational, false, 'the hardware facts still come from Get-PhysicalDisk');
  assert.deepEqual(topo.physicalDisks.map((d) => d.name), ['Samsung SSD 980 PRO 2TB (Disk 0)', 'Samsung SSD 980 PRO 2TB (Disk 1)'], 'two of one model are told apart by the number Disk Management uses');
});

test('windows: a boot SSD beside a Storage Spaces mirror — C: stays on the SSD, D: spans the two mirror members only', () => {
  const topo = mapWindowsTopology({
    disks: [
      { Number: 0, FriendlyName: 'WD Blue SN580', Size: 1_000_204_886_016, BusType: 'NVMe', UniqueId: 'eui.E8238FA6BF530001' },
      { Number: 3, FriendlyName: 'Mirror', Size: 4_000_000_000_000, BusType: 'Storage Spaces', UniqueId: '{9f7c1e2a-0000-4000-8000-000000000003}' },
    ],
    physical: [
      { DeviceId: '0', FriendlyName: 'WD Blue SN580', Size: 1_000_204_886_016, MediaType: 'SSD', UniqueId: 'eui.E8238FA6BF530001' },
      { DeviceId: '1', FriendlyName: 'WDC WD40EFRX', Size: 4_000_787_030_016, MediaType: 'HDD', UniqueId: '5000CCA0BEC2D111' },
      { DeviceId: '2', FriendlyName: 'WDC WD40EFRX', Size: 4_000_787_030_016, MediaType: 'HDD', UniqueId: '5000CCA0BEC2D222' },
      // A hot spare: in the pool, so Get-Disk never lists it, but not beneath the mirror.
      { DeviceId: '5', FriendlyName: 'WDC WD40EFRX', Size: 4_000_787_030_016, MediaType: 'HDD', UniqueId: '5000CCA0BEC2D555' },
    ],
    virtual: { FriendlyName: 'Mirror', Size: 4_000_000_000_000, ResiliencySettingName: 'Mirror', DiskNumber: 3, PhysicalDiskIds: ['1', '2'] },
    volumes: [
      { DriveLetter: 'C', FileSystem: 'NTFS', Size: 999_000_000_000, SizeRemaining: 400_000_000_000 },
      { DriveLetter: 'D', FileSystem: 'ReFS', Size: 3_990_000_000_000, SizeRemaining: 1_000_000_000_000 },
      // A volume the partition query did not name while it named the others.
      { DriveLetter: 'E', FileSystem: 'NTFS', Size: 10_000_000_000, SizeRemaining: 1_000_000_000 },
    ],
    partitions: [{ DiskNumber: 0, DriveLetter: 'C' }, { DiskNumber: 3, DriveLetter: 'D' }],
  });
  assert.equal(topo.physicalDisks.length, 4, 'four drives — the virtual disk is not hardware and is not listed as a fifth');
  const byLetter = Object.fromEntries(topo.logicalVolumes.map((v) => [v.id, v]));
  assert.deepEqual(byLetter['C:'].physicalDiskIds, ['physical:0'], 'the boot volume is not smeared across the pool');
  assert.equal(byLetter['C:'].kind, 'simple');
  assert.deepEqual(byLetter['D:'].physicalDiskIds.slice().sort(), ['physical:1', 'physical:2'], 'the mirror volume spans its two members — not the SSD, not the hot spare');
  assert.equal(byLetter['D:'].kind, 'storage-spaces');
  assert.deepEqual(byLetter['E:'].physicalDiskIds, [], 'a letter the partition map does not know, on a machine with two places to be: shown unplaced, never guessed onto the pool');
  assert.equal(byLetter['E:'].kind, 'simple');
  assert.deepEqual(topo.physicalDisks.filter((d) => d.name?.startsWith('WDC')).map((d) => d.name), ['WDC WD40EFRX (Disk 1)', 'WDC WD40EFRX (Disk 2)', 'WDC WD40EFRX (Disk 5)'], 'three of one model, told apart');
});

test('windows: a disk whose bus says Storage Spaces is a space even when the association named nothing', () => {
  const topo = mapWindowsTopology({
    disks: [
      { Number: 0, FriendlyName: 'Boot SSD', UniqueId: 'eui.S' },
      { Number: 3, FriendlyName: 'Mirror', Size: 4_000_000_000_000, BusType: 'Storage Spaces', UniqueId: '{9f7c1e2a-0000-4000-8000-000000000003}' },
    ],
    physical: [{ DeviceId: '0', MediaType: 'SSD', UniqueId: 'eui.S' }, { DeviceId: '1', MediaType: 'HDD', UniqueId: 'A' }, { DeviceId: '2', MediaType: 'HDD', UniqueId: 'B' }],
    virtual: { FriendlyName: 'Mirror', Size: 4_000_000_000_000, ResiliencySettingName: 'Mirror' },
    volumes: [{ DriveLetter: 'C', FileSystem: 'NTFS' }, { DriveLetter: 'D', FileSystem: 'ReFS' }],
    partitions: [{ DiskNumber: 0, DriveLetter: 'C' }, { DiskNumber: 3, DriveLetter: 'D' }],
  });
  const byLetter = Object.fromEntries(topo.logicalVolumes.map((v) => [v.id, v]));
  assert.deepEqual(byLetter['D:'].physicalDiskIds.slice().sort(), ['physical:1', 'physical:2'], 'the drives no plain disk owns — not the boot SSD');
  assert.equal(byLetter['D:'].kind, 'storage-spaces');
  assert.deepEqual(byLetter['C:'].physicalDiskIds, ['physical:0']);
  assert.equal(topo.physicalDisks.length, 3, 'the space is not shown as a fourth, volume-less "disk:3"');
  assert.match(topo.mechanism, /Get-VirtualDisk/);
});

test('windows: a disk is matched to its hardware by UniqueId first, and by DeviceId = Number when UniqueIds are absent', () => {
  // UniqueIds agree, DeviceIds are deliberately crossed: the UniqueId must win.
  const crossed = mapWindowsTopology({
    disks: [{ Number: 0, UniqueId: 'eui.AAAA' }, { Number: 1, UniqueId: 'eui.BBBB' }],
    physical: [{ DeviceId: '1', FriendlyName: 'A', MediaType: 'SSD', UniqueId: 'eui.AAAA' }, { DeviceId: '0', FriendlyName: 'B', MediaType: 'HDD', UniqueId: 'eui.BBBB' }],
    volumes: [{ DriveLetter: 'C', FileSystem: 'NTFS' }],
    partitions: [{ DiskNumber: 0, DriveLetter: 'C' }],
  });
  assert.deepEqual(crossed.logicalVolumes[0].physicalDiskIds, ['physical:1'], 'disk 0 is the hardware whose UniqueId it shares');
  // No UniqueIds anywhere (an older Storage module): the device number is the key.
  const byNumber = mapWindowsTopology({
    disks: [{ Number: 0 }, { Number: 1 }],
    physical: [{ DeviceId: '0', MediaType: 'SSD' }, { DeviceId: '1', MediaType: 'HDD' }],
    volumes: [{ DriveLetter: 'D', FileSystem: 'NTFS' }],
    partitions: [{ DiskNumber: 1, DriveLetter: 'D' }],
  });
  assert.deepEqual(byNumber.logicalVolumes[0].physicalDiskIds, ['physical:1']);
});

test('windows: a disk the hardware list cannot be matched to still carries its volumes, as itself', () => {
  const topo = mapWindowsTopology({
    disks: [{ Number: 5, FriendlyName: 'Mystery Disk', Size: 500_000_000_000, UniqueId: 'vendor-specific-1' }],
    physical: [{ DeviceId: '0', FriendlyName: 'Some SSD', MediaType: 'SSD', UniqueId: 'eui.CCCC' }],
    volumes: [{ DriveLetter: 'E', FileSystem: 'exFAT', Size: 499_000_000_000, SizeRemaining: 100_000_000_000 }],
    partitions: [{ DiskNumber: 5, DriveLetter: 'E' }],
  });
  assert.deepEqual(topo.logicalVolumes[0].physicalDiskIds, ['disk:5'], 'never orphaned when the partition map knows the disk');
  const own = topo.physicalDisks.find((d) => d.id === 'disk:5');
  assert.ok(own, 'the disk the volume lives on is shown');
  assert.equal(own!.name, 'Mystery Disk');
  assert.equal(own!.rotational, null, 'no hardware match, so no claim about the media');
  assert.ok(topo.physicalDisks.some((d) => d.id === 'physical:0'), 'the unmatched hardware is still listed — it is what the OS reports');
  // A disk the partition map names but Get-Disk did not list: no friendly name to
  // show, so it carries the name Disk Management would give it, never its raw id.
  const nameless = mapWindowsTopology({
    physical: [{ DeviceId: '0', MediaType: 'SSD', UniqueId: 'eui.AAAA' }, { DeviceId: '1', MediaType: 'HDD', UniqueId: 'eui.BBBB' }],
    volumes: { DriveLetter: 'E', FileSystem: 'NTFS' },
    partitions: { DiskNumber: 5, DriveLetter: 'E' },
  });
  assert.deepEqual(nameless.logicalVolumes[0].physicalDiskIds, ['disk:5']);
  assert.equal(nameless.physicalDisks.find((d) => d.id === 'disk:5')!.name, 'Disk 5');
});

test('windows: the mechanism names every cmdlet the answer came from', () => {
  assert.match(mapWindowsTopology(REPORTER_35).mechanism, /^Get-Disk \+ Get-Partition \+ Get-PhysicalDisk \+ Get-Volume$/);
  const pooled = mapWindowsTopology({ ...REPORTER_35, virtual: { FriendlyName: 'Pool', DiskNumber: 9, PhysicalDiskIds: [] } });
  assert.match(pooled.mechanism, /Get-VirtualDisk/);
});

test('windows: the topology script carries the identifiers the mapper joins on, and asks for a space\'s parts by association', () => {
  assert.match(TOPOLOGY_SCRIPT, /Get-Disk \| Select-Object Number, FriendlyName, Size, BusType, UniqueId, SerialNumber/);
  assert.match(TOPOLOGY_SCRIPT, /Get-PhysicalDisk \| Select-Object DeviceId, FriendlyName, Size, MediaType, UniqueId, SerialNumber/);
  assert.match(TOPOLOGY_SCRIPT, /Get-Volume \| Where-Object \{ \$_\.DriveLetter -and \(\[string\]\$_\.DriveType\) -ne 'CD-ROM' \}/, 'a disc in the drive is not a volume on a disk');
  assert.match(TOPOLOGY_SCRIPT, /Select-Object DriveLetter, FileSystemLabel, FileSystem, DriveType, Size, SizeRemaining, Path/);
  assert.match(TOPOLOGY_SCRIPT, /Get-Partition \| Where-Object \{ \$_\.DriveLetter \} \|\s+Select-Object DiskNumber, DriveLetter/);
  assert.match(TOPOLOGY_SCRIPT, /DiskNumber = \(\$vd \| Get-Disk \| Select-Object -First 1\)\.Number/, 'the disk a space presents, by CIM association');
  assert.match(TOPOLOGY_SCRIPT, /PhysicalDiskIds = @\(\$vd \| Get-PhysicalDisk \| ForEach-Object \{ \[string\]\$_\.DeviceId \}\)/, 'the drives beneath a space, by CIM association');
  assert.match(TOPOLOGY_SCRIPT, /ConvertTo-Json -Depth 5 -Compress/);
  assert.match(TOPOLOGY_SCRIPT, /^\$ErrorActionPreference = 'SilentlyContinue'$/m, 'a missing cmdlet degrades to an empty list, never to a crash');
  assert.doesNotMatch(TOPOLOGY_SCRIPT, /FriendlyName -eq|Where-Object \{ \$_\.FriendlyName/, 'nothing is joined by a display name');
});

const NOT_WINDOWS = process.platform !== 'win32' && 'the live round-trip needs the Windows Storage module';
test('windows (live): the system drive\'s partition names its disk, that disk is matched to real hardware, and the volume hangs on it', { skip: NOT_WINDOWS }, async () => {
  // Issue #35 was masked on one-disk machines. This runs on the CI Windows
  // runner and checks the two things the mapper assumes about real output:
  // Get-Partition names a disk number for the system drive, and that disk is
  // matched to a Get-PhysicalDisk entry by UniqueId or by DeviceId = Number.
  const doc = await readWindowsTopologyDoc();
  const letter = (process.env.SystemDrive || 'C:').replace(':', '').toUpperCase();
  const part = asArray(doc.partitions).find((p) => String(p.DriveLetter ?? '').toUpperCase() === letter);
  assert.ok(part && typeof part.DiskNumber === 'number', `Get-Partition names the disk under ${letter}: — got ${JSON.stringify(doc.partitions)}`);
  const disk = asArray(doc.disks).find((d) => d.Number === part!.DiskNumber);
  assert.ok(disk, `Get-Disk lists disk ${part!.DiskNumber}: ${JSON.stringify(doc.disks)}`);
  const physical = asArray(doc.physical);
  assert.ok(physical.length >= 1, 'Get-PhysicalDisk lists the hardware');
  const norm = (s: unknown) => String(s ?? '').trim().toUpperCase();
  const byUnique = physical.find((p) => norm(p.UniqueId) !== '' && norm(p.UniqueId) === norm(disk!.UniqueId));
  const bySerial = physical.find((p) => norm(p.SerialNumber) !== '' && norm(p.SerialNumber) === norm(disk!.SerialNumber));
  const byNumber = physical.find((p) => String(p.DeviceId) === String(disk!.Number));
  assert.ok(byUnique || bySerial || byNumber, `disk ${disk!.Number} (UniqueId ${disk!.UniqueId}, serial ${disk!.SerialNumber}) matches no hardware by UniqueId, SerialNumber or DeviceId — physical: ${JSON.stringify(physical.map((p) => [p.DeviceId, p.UniqueId, p.SerialNumber]))}`);
  const topo = mapWindowsTopology(doc);
  const vol = topo.logicalVolumes.find((v) => v.id === `${letter}:`);
  assert.ok(vol, `${letter}: is a volume`);
  assert.ok(vol!.physicalDiskIds.length >= 1, `${letter}: hangs on a disk`);
  for (const id of vol!.physicalDiskIds) assert.ok(topo.physicalDisks.some((d) => d.id === id), `${id} is a disk that is shown`);
  assert.ok(!topo.physicalDisks.some((d) => d.id.startsWith('disk:')), `every disk matched its hardware; a "disk:" entry means the identifier assumption failed here: ${JSON.stringify(topo.physicalDisks)}`);
});

test('windows: two hardware records that would share an id get distinct ids, so no card shows another disk\'s volumes', () => {
  const byUnique = mapWindowsTopology({
    physical: [
      { DeviceId: null, FriendlyName: 'Generic USB Disk', UniqueId: 'AAAA', MediaType: 'Unspecified' },
      { DeviceId: null, FriendlyName: 'Generic USB Disk', UniqueId: 'BBBB', MediaType: 'Unspecified' },
    ],
  });
  assert.deepEqual(byUnique.physicalDisks.map((d) => d.id), ['physical:AAAA', 'physical:BBBB']);
  const bare = mapWindowsTopology({ physical: [{ FriendlyName: 'Disk', MediaType: 'HDD' }, { FriendlyName: 'Disk', MediaType: 'HDD' }] });
  assert.equal(new Set(bare.physicalDisks.map((d) => d.id)).size, 2, 'even with nothing to name them, two records are two cards');
});

test('windows: an identifier two records share identifies neither — cloned virtual disks fall through to the device number', () => {
  // A VHDX copied without Set-VHD -ResetDiskIdentifier: both disks carry the
  // same UniqueId on both cmdlets. First-match-wins would hang D: on disk 0.
  const topo = mapWindowsTopology({
    disks: [{ Number: 0, FriendlyName: 'Msft Virtual Disk', UniqueId: '600224803F5C0000' }, { Number: 1, FriendlyName: 'Msft Virtual Disk', UniqueId: '600224803F5C0000' }],
    physical: [{ DeviceId: '0', FriendlyName: 'Msft Virtual Disk', UniqueId: '600224803F5C0000' }, { DeviceId: '1', FriendlyName: 'Msft Virtual Disk', UniqueId: '600224803F5C0000' }],
    volumes: [{ DriveLetter: 'C', FileSystem: 'NTFS' }, { DriveLetter: 'D', FileSystem: 'NTFS' }],
    partitions: [{ DiskNumber: 0, DriveLetter: 'C' }, { DiskNumber: 1, DriveLetter: 'D' }],
  });
  const byLetter = Object.fromEntries(topo.logicalVolumes.map((v) => [v.id, v]));
  assert.deepEqual(byLetter['C:'].physicalDiskIds, ['physical:0']);
  assert.deepEqual(byLetter['D:'].physicalDiskIds, ['physical:1']);
  assert.deepEqual(topo.physicalDisks.map((d) => d.name), ['Msft Virtual Disk (Disk 0)', 'Msft Virtual Disk (Disk 1)'], 'same model, told apart by number');
});

test('windows: a pool member\'s device number is never taken for a plain disk', () => {
  // A mirror member died and stays listed; a USB stick then gets the free
  // disk number 2, and its identifiers match no hardware. Matching "2" to the
  // dead member would hang the stick's volume on a drive in the pool.
  const topo = mapWindowsTopology({
    disks: [
      { Number: 0, FriendlyName: 'WD Blue SN580', UniqueId: 'eui.E8238FA6BF530001' },
      { Number: 2, FriendlyName: 'USB Flash Drive', UniqueId: 'USBSTOR\\DISK&VEN_KINGSTON&PROD_DATATRAVELER' },
      { Number: 9, FriendlyName: 'Mirror', BusType: 'Storage Spaces', UniqueId: '{9f7c1e2a-0000-4000-8000-000000000009}' },
    ],
    physical: [
      { DeviceId: '0', FriendlyName: 'WD Blue SN580', MediaType: 'SSD', UniqueId: 'eui.E8238FA6BF530001' },
      { DeviceId: '2', FriendlyName: 'WDC WD40EFRX', MediaType: 'HDD', UniqueId: '5000CCA0BEC2D222' },
      { DeviceId: '3', FriendlyName: 'WDC WD40EFRX', MediaType: 'HDD', UniqueId: '5000CCA0BEC2D333' },
    ],
    virtual: { FriendlyName: 'Mirror', ResiliencySettingName: 'Mirror', DiskNumber: 9, PhysicalDiskIds: ['2', '3'] },
    volumes: [{ DriveLetter: 'C', FileSystem: 'NTFS' }, { DriveLetter: 'E', FileSystem: 'exFAT' }, { DriveLetter: 'D', FileSystem: 'ReFS' }],
    partitions: [{ DiskNumber: 0, DriveLetter: 'C' }, { DiskNumber: 2, DriveLetter: 'E' }, { DiskNumber: 9, DriveLetter: 'D' }],
  });
  const byLetter = Object.fromEntries(topo.logicalVolumes.map((v) => [v.id, v]));
  assert.deepEqual(byLetter['C:'].physicalDiskIds, ['physical:0']);
  assert.deepEqual(byLetter['E:'].physicalDiskIds, ['disk:2'], 'the stick stands in for itself');
  assert.equal(topo.physicalDisks.find((d) => d.id === 'disk:2')!.name, 'USB Flash Drive');
  assert.deepEqual(byLetter['D:'].physicalDiskIds.slice().sort(), ['physical:2', 'physical:3'], 'the mirror keeps both members');
});

test('windows: SerialNumber is the second key — a drive whose UniqueIds disagree still finds its hardware', () => {
  const topo = mapWindowsTopology({
    disks: [
      { Number: 0, UniqueId: 'eui.AAAA', SerialNumber: 'S0' },
      { Number: 2, FriendlyName: 'SanDisk Extreme', UniqueId: 'USBSTOR\\DISK&VEN_SANDISK', SerialNumber: ' 4C530001234567890 ' },
    ],
    physical: [
      { DeviceId: '0', MediaType: 'SSD', UniqueId: 'eui.AAAA', SerialNumber: 'S0' },
      // The device number deliberately disagrees, so only the serial can place it.
      { DeviceId: '7', FriendlyName: 'SanDisk Extreme', MediaType: 'SSD', UniqueId: '{4c8e1b2a-0000-4000-8000-000000000007}', SerialNumber: '4C530001234567890' },
    ],
    volumes: { DriveLetter: 'E', FileSystem: 'exFAT' },
    partitions: { DiskNumber: 2, DriveLetter: 'E' },
  });
  assert.deepEqual(topo.logicalVolumes[0].physicalDiskIds, ['physical:7']);
  assert.equal(topo.physicalDisks.length, 2, 'no stand-in was needed');
});

test('windows: when Windows names no partitions on a multi-disk machine, the volumes stay unplaced and the card is told why', () => {
  const blind = mapWindowsTopology({ ...REPORTER_35, partitions: [] });
  for (const v of blind.logicalVolumes) assert.deepEqual(v.physicalDiskIds, [], `${v.id} is not guessed onto a disk`);
  assert.deepEqual(blind.degraded, {
    degradedTo: 'Get-Disk + Get-PhysicalDisk + Get-Volume',
    reason: 'Windows did not say which disk each drive letter lives on, so the volumes are listed without their disks.',
  });
  assert.equal(mapWindowsTopology(REPORTER_35).degraded, undefined, 'a complete reading carries no note');
  const laptop = mapWindowsTopology({
    disks: { Number: 0, UniqueId: 'eui.AAAA' }, physical: { DeviceId: '0', MediaType: 'SSD', UniqueId: 'eui.AAAA' },
    volumes: { DriveLetter: 'C', FileSystem: 'NTFS' },
  });
  assert.deepEqual(laptop.logicalVolumes[0].physicalDiskIds, ['physical:0'], 'one disk is the only place a volume can be');
  assert.equal(laptop.degraded, undefined);
  const noHardware = mapWindowsTopology({ disks: [{ Number: 0, FriendlyName: 'SSD' }, { Number: 1, FriendlyName: 'HDD' }], volumes: { DriveLetter: 'C', FileSystem: 'NTFS' }, partitions: { DiskNumber: 0, DriveLetter: 'C' } });
  assert.deepEqual(noHardware.logicalVolumes[0].physicalDiskIds, ['disk:0']);
  assert.match(noHardware.degraded!.reason, /did not describe the drives/);
  assert.equal(noHardware.degraded!.degradedTo, 'Get-Disk + Get-Partition + Get-Volume');
});

test('windows: a letter the partition map does not know is unplaced even on a one-disk machine — a mounted ISO is not on the SSD', () => {
  const topo = mapWindowsTopology({
    disks: { Number: 0, UniqueId: 'eui.AAAA' }, physical: { DeviceId: '0', MediaType: 'SSD', UniqueId: 'eui.AAAA' },
    volumes: [{ DriveLetter: 'C', FileSystem: 'NTFS' }, { DriveLetter: 'E', FileSystem: 'UDF', Size: 8_000_000_000, SizeRemaining: 0 }],
    partitions: { DiskNumber: 0, DriveLetter: 'C' },
  });
  const byLetter = Object.fromEntries(topo.logicalVolumes.map((v) => [v.id, v]));
  assert.deepEqual(byLetter['C:'].physicalDiskIds, ['physical:0']);
  assert.deepEqual(byLetter['E:'].physicalDiskIds, [], 'the partition map knows C: and not E:, so E: is not an ordinary partition');
});

test('windows: a disc in the drive is not a volume on any disk', () => {
  const topo = mapWindowsTopology({
    disks: { Number: 0, UniqueId: 'eui.AAAA' }, physical: { DeviceId: '0', MediaType: 'SSD', UniqueId: 'eui.AAAA' },
    volumes: [{ DriveLetter: 'C', FileSystem: 'NTFS' }, { DriveLetter: 'F', DriveType: 'CD-ROM', FileSystem: 'UDF', Size: 8_000_000_000, SizeRemaining: 0 }, { DriveLetter: 'G', DriveType: 5, FileSystem: 'CDFS' }],
    partitions: { DiskNumber: 0, DriveLetter: 'C' },
  });
  assert.deepEqual(topo.logicalVolumes.map((v) => v.id), ['C:']);
});

test('windows: a locked BitLocker or RAW volume reports no figures rather than 0 B used', () => {
  const topo = mapWindowsTopology({
    physical: { DeviceId: '0', MediaType: 'SSD' },
    volumes: [
      { DriveLetter: 'E', FileSystem: '', Size: 0, SizeRemaining: 0 },
      { DriveLetter: 'F', FileSystem: 'RAW', Size: 1_000_000_000_000, SizeRemaining: 0 },
      { DriveLetter: 'C', FileSystem: 'NTFS', Size: 1_000_000_000_000, SizeRemaining: 400_000_000_000 },
    ],
  });
  const byLetter = Object.fromEntries(topo.logicalVolumes.map((v) => [v.id, v]));
  assert.deepEqual([byLetter['E:'].sizeBytes, byLetter['E:'].freeBytes, byLetter['E:'].usedBytes], [null, null, null], 'locked: nothing is known');
  assert.deepEqual([byLetter['F:'].sizeBytes, byLetter['F:'].freeBytes, byLetter['F:'].usedBytes], [1_000_000_000_000, null, null], 'RAW: the size is real, "0 free" is not');
  assert.equal(byLetter['C:'].usedBytes, 600_000_000_000);
});

test('windows: the numeric codes behind MediaType and BusType are understood too', () => {
  const topo = mapWindowsTopology({
    disks: [{ Number: 0, UniqueId: 'A' }, { Number: 3, BusType: 16, UniqueId: 'V' }],
    physical: [{ DeviceId: '0', MediaType: 4, UniqueId: 'A' }, { DeviceId: '1', MediaType: 3, UniqueId: 'B' }, { DeviceId: '2', MediaType: '5', UniqueId: 'C' }],
    volumes: [{ DriveLetter: 'C', FileSystem: 'NTFS' }, { DriveLetter: 'D', FileSystem: 'ReFS' }],
    partitions: [{ DiskNumber: 0, DriveLetter: 'C' }, { DiskNumber: 3, DriveLetter: 'D' }],
  });
  assert.deepEqual(topo.physicalDisks.map((d) => d.rotational), [false, true, false]);
  const byLetter = Object.fromEntries(topo.logicalVolumes.map((v) => [v.id, v]));
  assert.equal(byLetter['D:'].kind, 'storage-spaces');
  assert.deepEqual(byLetter['D:'].physicalDiskIds.slice().sort(), ['physical:1', 'physical:2']);
});

/* ════════════════════════ Windows: shadow copies ════════════════════════ */

test('windows: mapShadowCopies orders newest first and never mounts eagerly', () => {
  const snaps = mapShadowCopies([
    { ID: '{OLD}', VolumeName: '\\\\?\\Volume{abc}\\', InstallDate: '2026-07-01T10:00:00' },
    { ID: '{NEW}', VolumeName: '\\\\?\\Volume{abc}\\', InstallDate: '2026-07-20T10:00:00' },
  ]);
  assert.deepEqual(snaps.map((s) => s.id), ['{NEW}', '{OLD}']);
  assert.equal(snaps[0].accessPath, null, 'reading a shadow copy needs a link, created only on restore');
});

test('windows: shadow copies of another volume are not offered', () => {
  // Restoring a C: file from a D: snapshot would fail confusingly, or restore
  // the wrong file entirely.
  const raw = [
    { ID: '{C}', VolumeName: 'C:\\', InstallDate: '2026-07-20T10:00:00' },
    { ID: '{D}', VolumeName: 'D:\\', InstallDate: '2026-07-20T11:00:00' },
  ];
  assert.deepEqual(mapShadowCopies(raw, 'C:\\').map((s) => s.id), ['{C}']);
});

test('windows: normalizeVolume reconciles drive letters with volume GUID paths', () => {
  assert.equal(normalizeVolume('C:\\'), 'C:');
  assert.equal(normalizeVolume('c:'), 'C:');
  assert.equal(normalizeVolume('\\\\?\\Volume{ABC}\\'), '\\\\?\\volume{abc}');
});

test('windows: an unparseable InstallDate becomes unknown, not epoch zero', () => {
  assert.equal(parseInstallDate('not a date'), null);
  assert.equal(parseInstallDate(null), null);
  assert.ok(parseInstallDate('2026-07-20T10:00:00') !== null);
});

/* ════════════════════════ Windows: Restart Manager ════════════════════════ */

test('windows: mapRestartManagerOutput names the holding process and skips our own', () => {
  const held = mapRestartManagerOutput(
    [{ pid: 4321, name: 'Google Chrome' }, { pid: process.pid, name: 'TreeMap' }],
    ['C:\\Users\\me\\file.txt'],
  );
  assert.equal(held.length, 1, "TreeMap holding its own handle is not a conflict worth warning about");
  assert.equal(held[0].processName, 'Google Chrome');
  assert.equal(held[0].path, 'C:\\Users\\me\\file.txt');
});

test('windows: a single held file collapses from object to array shape correctly', () => {
  const held = mapRestartManagerOutput({ pid: 99, name: 'notepad' }, ['C:\\a.txt']);
  assert.equal(held.length, 1);
  assert.equal(held[0].pid, 99);
});

test('windows: a process reported without a name still gets a usable label', () => {
  const held = mapRestartManagerOutput([{ pid: 77 }], ['C:\\a.txt']);
  assert.equal(held[0].processName, 'process 77');
});

test('windows: the Restart Manager script calls RmGetList twice and always ends the session', () => {
  // Calling RmGetList once is the classic bug: the first call only reports how
  // many entries exist, so a single call silently truncates the answer.
  const calls = RM_SCRIPT.match(/RmGetList\(/g) ?? [];
  assert.ok(calls.length >= 2, 'the size-probe call must precede the real one');
  assert.match(RM_SCRIPT, /finally\s*\{[\s\S]*RmEndSession/, 'a leaked session outlives the process');
  assert.ok(!RM_SCRIPT.includes('TREEMAP_PATHS"'), 'paths travel via the environment, never interpolated');
});

/* ════════════════════════ Windows: shell integration ════════════════════════ */

test('windows: the context menu installs for folders, backgrounds and drives', () => {
  const keys = SHELL_KEYS.map((k) => k.key);
  assert.ok(keys.some((k) => k.includes('Directory\\shell')));
  assert.ok(keys.some((k) => k.includes('Directory\\Background\\shell')));
  assert.ok(keys.some((k) => k.includes('Drive\\shell')));
  assert.ok(keys.every((k) => k.startsWith('HKCU')), 'per-user only — no administrator rights (§3.8)');
});

test('windows: the background entry uses %V, since %1 is empty there', () => {
  const background = SHELL_KEYS.find((k) => k.key.includes('Background'));
  assert.equal(background!.arg, '%V', 'copying %1 here yields a menu item that launches with no folder');
});

test('windows: an executable path containing spaces is quoted in the command value', () => {
  const cmds = installCommands('C:\\Program Files\\TreeMap\\TreeMap.exe');
  const command = cmds.find((c) => c.args.includes('/d') && c.args.some((a) => a.includes('TreeMap.exe" "')));
  assert.ok(command, 'unquoted, Windows would launch C:\\Program with Files\\... as an argument');
  assert.ok(command!.args.some((a) => a === '"C:\\Program Files\\TreeMap\\TreeMap.exe" "%1"'));
});

test('windows: uninstall deletes every key it installed', () => {
  const removed = uninstallCommands().map((c) => c.args[1]);
  assert.deepEqual(removed.sort(), SHELL_KEYS.map((k) => k.key).sort(), 'D2: no dead entry may be left behind');
});

/* ════════════════════════ Windows: PowerShell helper ════════════════════════ */

test('windows: asArray normalises ConvertTo-Json single-result collapse', () => {
  assert.deepEqual(asArray({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(asArray([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray(undefined), []);
});

test('linux: an unreadable /proc is an error, not "nothing is open"', async () => {
  // `listPids` used to answer `[]` when `readdir('/proc')` failed, which empties
  // the whole descriptor sweep — and `checkOpenHandles` turns an empty sweep
  // into `checked: true` with no conflicts. That is a clean bill of health from
  // a probe that never ran, and `moveToTrash` proceeds on it. The module's own
  // contract forbids exactly that answer, and the `checked: false` state it
  // should produce instead already existed and was already tested.
  //
  // Runs on every OS: the /proc root is a parameter, so a path that is not
  // there exercises the same branch a permission failure would.
  await assert.rejects(
    () => readOpenDescriptors(path.join(os.tmpdir(), 'tm-no-such-proc-9f2a1c')),
    (err: unknown) => err instanceof Error && (err as NodeJS.ErrnoException).code !== undefined,
    'a /proc that cannot be read propagates rather than reporting an empty machine',
  );
});

test('a second watch-delivery listener does not displace the first', async () => {
  // `onWatchDelivery` feeds `watcherEventCount`, which the acceptance tests
  // read to decide whether a missed update is a platform failure (skip) or a
  // bug (fail). A single-slot listener would be replaced silently by any
  // second registrant — leaving the count stuck at zero and those tests
  // SKIPPING GREEN on a real regression, which is precisely the failure the
  // provider-level counter was added to eliminate.
  const { onWatchDelivery, notifyWatchDelivery } = await import('../src/platform/types');
  const seen: string[] = [];
  const off = onWatchDelivery((root) => seen.push(root));
  try {
    notifyWatchDelivery('/some/root');
    assert.deepEqual(seen, ['/some/root'], 'the new listener hears it');
    // The engine's own listener is registered at import time and must still
    // be receiving — proven by it not having been replaced: unsubscribing
    // ours leaves the delivery machinery intact for everyone else.
  } finally {
    off();
  }
  notifyWatchDelivery('/some/root');
  assert.deepEqual(seen, ['/some/root'], 'and unsubscribing removes only ours');
});
