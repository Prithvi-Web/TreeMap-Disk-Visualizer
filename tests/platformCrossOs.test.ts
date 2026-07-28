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
import { mapWindowsTopology } from '../src/platform/windows/topology';
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
 * The remaining round-trips — does RmGetList actually return a process name,
 * does lsblk actually accept -O — run in CI on windows-latest and ubuntu-latest
 * (.github/workflows/test.yml). That is the honest division: logic is proven
 * here, syscalls are proven there, and nothing is claimed to be verified that
 * is not.
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
});

test('windows: a Storage Spaces volume is attributed to every disk in the pool', () => {
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
