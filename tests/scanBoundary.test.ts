import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-scanBoundary-data-');

import { parseBsdMount, parseProcMounts, type MountEntry } from '../src/platform/atime';
import {
  boundedIsDirectory,
  dataVolumeAlias,
  firmlinkAliases,
  liveMountTableDeps,
  mountPointsUnder,
  neverDescendPaths,
  parseFirmlinks,
  readMountTable,
  scanBoundary,
  unknownBoundary,
  type BoundaryDeps,
  type MountTable,
} from '../src/utils/mountBoundaries';
import {
  CLOCKS_NULLFS,
  CROSSED_AT_ROOT,
  DIAGNOSIS_MAC_FIRMLINKS,
  DIAGNOSIS_MAC_MOUNT,
  FOLDERS_PLACEHOLDER,
  IOS_22E238,
  IOS_23F77,
  LINUX_PROC_MOUNTS,
  SIM_RUNTIME_BUNDLE,
  SYSTEM_MOUNTS_AT_ROOT,
} from './fixtures/mountTables';

/**
 * Track U, U-23: each scan's boundary list comes from the mount table.
 *
 * Pure, on every OS, counts only. The tables are other machines' — the
 * diagnosis Mac's `mount` output (redacted), its firmlinks, a Linux
 * `/proc/mounts` — fed through the same seams the scan uses, so nothing here
 * depends on what this machine has mounted.
 */

const FIRMLINKS = firmlinkAliases(parseFirmlinks(DIAGNOSIS_MAC_FIRMLINKS));
const NO_ALIASES = (): string[] => [];
const darwinEntries = (): MountEntry[] => parseBsdMount(DIAGNOSIS_MAC_MOUNT);
const sorted = (paths: Iterable<string>): string[] => [...paths].sort();
const pathsOf = (list: readonly { path: string }[]): string[] => sorted(list.map((m) => m.path));

/** The scan's dependencies over a fixed table, counting what was asked. */
function fakeDeps(
  platform: NodeJS.Platform,
  table: MountTable,
  over: Partial<BoundaryDeps> = {},
): BoundaryDeps & { reads: number; asked: string[] } {
  const deps = {
    platform,
    reads: 0,
    asked: [] as string[],
    async readTable(): Promise<MountTable> {
      deps.reads++;
      return table;
    },
    realpath: async (p: string) => p,
    aliases: async () => (platform === 'darwin' ? FIRMLINKS : NO_ALIASES),
    async isDirectory(p: string): Promise<boolean | null> {
      deps.asked.push(p);
      return true;
    },
    ...over,
  };
  return deps;
}

const darwinTable = (): MountTable => ({ source: 'mount', entries: darwinEntries(), reason: null });
const linuxTable = (): MountTable => ({ source: '/proc/mounts', entries: parseProcMounts(LINUX_PROC_MOUNTS), reason: null });

/* ───────────────────────────── the table, parsed ───────────────────────────── */

test('the diagnosis Mac’s table at / gives exactly the four crossed mounts, plus the system mounts under the fixed never-descend folders', () => {
  const under = mountPointsUnder('/', '/', darwinEntries(), FIRMLINKS);
  assert.deepEqual(pathsOf(under), sorted([...CROSSED_AT_ROOT, ...SYSTEM_MOUNTS_AT_ROOT]), 'every mount strictly beneath /, once each, nothing else');
  const nullfs = under.find((m) => m.path === CLOCKS_NULLFS);
  assert.ok(nullfs, 'the Clocks wrapper is listed');
  assert.equal(nullfs.filesystem, 'nullfs');
  assert.equal(nullfs.source, '/Applications/Clocks.app/Wrapper', 'a nullfs mount names the folder it shows again');
  const sim = under.find((m) => m.path === IOS_22E238);
  assert.ok(sim, 'iOS_22E238 is listed');
  assert.equal(sim.filesystem, 'apfs');
  assert.equal(sim.source, '/dev/disk7s1');
});

test('a firmlinked folder is never a boundary: /Users, /Applications and /private come from no table, and only the table’s mounts outside the fixed folders are looked at', async () => {
  const under = pathsOf(mountPointsUnder('/', '/', darwinEntries(), FIRMLINKS));
  for (const firmlinked of ['/Users', '/Applications', '/private', '/Library', '/Volumes', '/opt']) {
    assert.ok(!under.includes(firmlinked), `${firmlinked} shares the volume through a firmlink, and is not a mount`);
  }
  const deps = fakeDeps('darwin', darwinTable());
  const b = await scanBoundary('/', 'stay', deps);
  for (const firmlinked of ['/Users', '/Applications', '/private']) {
    assert.ok(!b.neverDescend.includes(firmlinked), `${firmlinked} is walked by a scan of /`);
  }
  // The table is the whole source: the only paths asked about are the
  // table's own mounts a walk can reach. Nothing under /System/Volumes or
  // /dev is touched — a dead mount there must not stall the scan's start.
  assert.deepEqual(sorted(deps.asked), CROSSED_AT_ROOT, 'only the four reachable mounts are looked at');
});

test('a root of /System/Volumes/Data finds the mounts the table spells through the firmlinks, in the root’s own spelling', () => {
  const data = '/System/Volumes/Data';
  const want = sorted([
    data + SIM_RUNTIME_BUNDLE,
    data + IOS_22E238,
    data + IOS_23F77,
    data + CLOCKS_NULLFS,
    '/System/Volumes/Data/home',
  ]);
  assert.deepEqual(pathsOf(mountPointsUnder(data, data, darwinEntries(), FIRMLINKS)), want);
  // Without the firmlinks only the one mount the table spells on the Data
  // side is found: the aliases are what reach the rest.
  assert.deepEqual(pathsOf(mountPointsUnder(data, data, darwinEntries(), NO_ALIASES)), ['/System/Volumes/Data/home']);
});

test('the fallback alias rule — the Data volume prefix taken off — finds a mount the table spells on the Data side', () => {
  const entries = parseBsdMount('/dev/disk8s1 on /System/Volumes/Data/Users/someone/mnt (apfs, local, nodev, nosuid, journaled, nobrowse)\n');
  assert.deepEqual(dataVolumeAlias('/System/Volumes/Data/Users/someone/mnt'), ['/Users/someone/mnt']);
  assert.deepEqual(dataVolumeAlias('/Users/someone/mnt'), [], 'one direction only: it cannot know which folders are firmlinked');
  assert.deepEqual(dataVolumeAlias('/System/Volumes/Data'), ['/']);
  assert.deepEqual(pathsOf(mountPointsUnder('/Users/someone', '/Users/someone', entries, dataVolumeAlias)), ['/Users/someone/mnt']);
  assert.deepEqual(pathsOf(mountPointsUnder('/Users/someone', '/Users/someone', entries, FIRMLINKS)), ['/Users/someone/mnt'], 'the firmlinks find it too');
});

test('a mount under the root’s real location is re-spelled in the root’s own spelling: /var/folders/… against /private/var/folders/…', () => {
  const typed = FOLDERS_PLACEHOLDER.replace(/^\/private/, '');
  assert.deepEqual(pathsOf(mountPointsUnder(typed, FOLDERS_PLACEHOLDER, darwinEntries(), FIRMLINKS)), [CLOCKS_NULLFS.replace(/^\/private/, '')]);
  // Typed as the table spells it, it is found as itself.
  assert.deepEqual(pathsOf(mountPointsUnder(FOLDERS_PLACEHOLDER, FOLDERS_PLACEHOLDER, darwinEntries(), FIRMLINKS)), [CLOCKS_NULLFS]);
});

test('names are compared segment by segment, strictly beneath the root, and the kernel’s octal escapes are undone', () => {
  const entries = parseBsdMount([
    '/dev/disk4s2 on /Volumes/Disk (apfs, local, nodev, nosuid, journaled)',
    '/dev/disk5s2 on /Volumes/Disk2 (apfs, local, nodev, nosuid, journaled)',
    '/dev/disk6s1 on /Volumes/Disk/inner (apfs, local, nodev, nosuid, journaled)',
    '',
  ].join('\n'));
  assert.deepEqual(pathsOf(mountPointsUnder('/Volumes/Disk', '/Volumes/Disk', entries, NO_ALIASES)), ['/Volumes/Disk/inner'], '/Volumes/Disk2 is not under /Volumes/Disk, and a root that is a mount is not in its own list');
  assert.deepEqual(pathsOf(mountPointsUnder(IOS_22E238, IOS_22E238, darwinEntries(), FIRMLINKS)), [], 'a scan of a mounted volume lists nothing for itself');
  assert.deepEqual(pathsOf(mountPointsUnder('/mnt', '/mnt', parseProcMounts(LINUX_PROC_MOUNTS), NO_ALIASES)), ['/mnt/my disk']);
});

test('a mount point that appears twice (one mounted over the other) is listed once, as the later entry the walk would meet', () => {
  const entries = parseBsdMount([
    '/dev/disk4s1 on /Users/someone/mnt (apfs, local, nodev, nosuid, journaled)',
    '/dev/disk5s1 on /Users/someone/mnt (hfs, local, nodev, nosuid, journaled)',
    '',
  ].join('\n'));
  const under = mountPointsUnder('/Users/someone', '/Users/someone', entries, NO_ALIASES);
  assert.equal(under.length, 1);
  assert.equal(under[0].filesystem, 'hfs');
  assert.equal(under[0].source, '/dev/disk5s1');
});

/* ───────────────────────────── reading the table ───────────────────────────── */

test('a mount table that cannot be read is unknown — entries null with the reason — never an empty list', async () => {
  const darwin = await readMountTable('darwin', { runMount: () => Promise.reject(new Error('mount did not answer within 5 s')), readProcMounts: () => Promise.reject(new Error('not asked')) });
  assert.equal(darwin.entries, null);
  assert.equal(darwin.source, 'mount');
  assert.match(darwin.reason ?? '', /mount did not answer within 5 s/);
  const linux = await readMountTable('linux', { runMount: () => Promise.reject(new Error('not asked')), readProcMounts: () => Promise.reject(Object.assign(new Error('EACCES: permission denied, open \'/proc/mounts\''), { code: 'EACCES' })) });
  assert.equal(linux.entries, null);
  assert.equal(linux.source, '/proc/mounts');
  assert.match(linux.reason ?? '', /EACCES/);

  const unknown = await scanBoundary('/', 'stay', fakeDeps('darwin', darwin));
  assert.equal(unknown.mounts, null, 'the scan’s list is unknown too');
  assert.match(unknown.reason ?? '', /mount did not answer/);
  assert.deepEqual(sorted(unknown.neverDescend), sorted(neverDescendPaths('darwin')), 'and the walk crosses as it always has: the fixed list alone');
});

test('the table is read: macOS from mount, Linux from /proc/mounts, Windows has none to read and says why', async () => {
  let ran = 0;
  const darwin = await readMountTable('darwin', { runMount: async () => { ran++; return DIAGNOSIS_MAC_MOUNT; }, readProcMounts: () => Promise.reject(new Error('not asked')) });
  assert.equal(ran, 1);
  assert.equal(darwin.entries?.length, 14);
  assert.equal(darwin.reason, null);
  const linux = await readMountTable('linux', { runMount: () => Promise.reject(new Error('not asked')), readProcMounts: async () => LINUX_PROC_MOUNTS });
  assert.equal(linux.entries?.length, 8);
  const win = await readMountTable('win32', { runMount: () => Promise.reject(new Error('not asked')), readProcMounts: () => Promise.reject(new Error('not asked')) });
  assert.deepEqual(win.entries, [], 'Windows: nothing to list');
  assert.match(win.reason ?? '', /reparse point/, 'and the reason a volume in a folder needs no table there');
});

test('the mount child is started without TreeMap’s API token in its environment', async () => {
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const deps = liveMountTableDeps(async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    return DIAGNOSIS_MAC_MOUNT;
  });
  const table = await readMountTable('darwin', deps);
  assert.equal(table.entries?.length, 14);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, '/sbin/mount', 'by its full path: a packaged app’s PATH may not hold /sbin');
  assert.deepEqual(calls[0].args, []);
  assert.ok(calls[0].env && Object.prototype.hasOwnProperty.call(calls[0].env, 'TREEMAP_TOKEN') && calls[0].env.TREEMAP_TOKEN === undefined, 'TREEMAP_TOKEN is taken out of the child’s environment');
});

test('two scans read the table twice: it is never remembered between scans', async () => {
  const deps = fakeDeps('darwin', darwinTable());
  await scanBoundary('/', 'stay', deps);
  await scanBoundary('/', 'stay', deps);
  assert.equal(deps.reads, 2);
});

/* ───────────────────────────── the scan's list ───────────────────────────── */

test('stay composes the fixed list plus every mount beneath the root; cross gives the fixed list alone', async () => {
  const stay = await scanBoundary('/', 'stay', fakeDeps('darwin', darwinTable()));
  assert.equal(stay.rule, 'stay');
  assert.equal(stay.source, 'mount');
  assert.equal(stay.reason, null);
  assert.deepEqual(pathsOf(stay.mounts ?? []), sorted([...CROSSED_AT_ROOT, ...SYSTEM_MOUNTS_AT_ROOT]));
  assert.deepEqual(sorted(stay.neverDescend), sorted(new Set([...neverDescendPaths('darwin'), ...CROSSED_AT_ROOT, ...SYSTEM_MOUNTS_AT_ROOT])));
  const cross = await scanBoundary('/', 'cross', fakeDeps('darwin', darwinTable()));
  assert.equal(cross.rule, 'cross');
  assert.deepEqual(pathsOf(cross.mounts ?? []), pathsOf(stay.mounts ?? []), 'the mounts are listed either way');
  assert.deepEqual(sorted(cross.neverDescend), sorted(neverDescendPaths('darwin')), 'but only the fixed list is never descended');
});

test('a root typed through a link finds the mounts beneath where it really is, spelled as the walk will spell them', async () => {
  const typed = FOLDERS_PLACEHOLDER.replace(/^\/private/, '');
  const deps = fakeDeps('darwin', darwinTable(), { realpath: async (p: string) => (p === typed ? FOLDERS_PLACEHOLDER : p) });
  const b = await scanBoundary(typed, 'stay', deps);
  assert.deepEqual(pathsOf(b.mounts ?? []), [CLOCKS_NULLFS.replace(/^\/private/, '')]);
  assert.ok(b.neverDescend.includes(CLOCKS_NULLFS.replace(/^\/private/, '')), 'the walk’s own spelling is what it will not descend');
});

test('a fixed folder above the root is not a boundary of this scan: a drive inside a scanned /Volumes/Backup is looked at and reachable', async () => {
  const table: MountTable = {
    source: 'mount',
    entries: parseBsdMount([
      '/dev/disk4s2 on /Volumes/Backup (apfs, local, nodev, nosuid, journaled)',
      '/dev/disk6s1 on /Volumes/Backup/inner (apfs, local, nodev, nosuid, journaled)',
      '',
    ].join('\n')),
    reason: null,
  };
  const deps = fakeDeps('darwin', table);
  const b = await scanBoundary('/Volumes/Backup', 'stay', deps);
  assert.deepEqual(b.mounts?.map((m) => [m.path, m.underFixed]), [['/Volumes/Backup/inner', false]], '/Volumes is never descended, but this scan starts inside it');
  assert.deepEqual(deps.asked, ['/Volumes/Backup/inner']);
  const fromRoot = await scanBoundary('/', 'stay', fakeDeps('darwin', table));
  assert.deepEqual(fromRoot.mounts?.map((m) => [m.path, m.underFixed]), [['/Volumes/Backup', true], ['/Volumes/Backup/inner', true]], 'from / both sit under the fixed /Volumes');
});

test('a mount the table spells on the Data volume is listed as the walk of / meets it — through the firmlink — never under /System/Volumes', async () => {
  // The security review of U-25 (F8): with the table's own spelling preferred,
  // /System/Volumes/Data/Users/someone/mnt sat under the fixed /System/Volumes,
  // and the walk of / — which reaches it as /Users/someone/mnt — would go in.
  const table: MountTable = {
    source: 'mount',
    entries: parseBsdMount('/dev/disk8s1 on /System/Volumes/Data/Users/someone/mnt (apfs, local, nodev, nosuid, journaled, nobrowse)\n'),
    reason: null,
  };
  const b = await scanBoundary('/', 'stay', fakeDeps('darwin', table));
  assert.deepEqual(b.mounts?.map((m) => [m.path, m.underFixed]), [['/Users/someone/mnt', false]]);
  assert.ok(b.neverDescend.includes('/Users/someone/mnt'), 'the walk of / meets the drive at /Users/someone/mnt, and stops there');
  const data = await scanBoundary('/System/Volumes/Data', 'stay', fakeDeps('darwin', table));
  assert.deepEqual(data.mounts?.map((m) => m.path), ['/System/Volumes/Data/Users/someone/mnt'], 'a scan of the Data volume meets it in its own spelling');
});

test('a mount the system reports as a file is dropped (Docker’s /etc/hosts); one whose kind cannot be learned is kept', async () => {
  const deps = fakeDeps('linux', linuxTable(), {
    async isDirectory(p: string) {
      if (p === '/etc/hosts') return false;
      if (p === '/home') return null; // did not answer: kept, since not entering it is the safe side
      return true;
    },
  });
  const b = await scanBoundary('/', 'stay', deps);
  assert.deepEqual(pathsOf(b.mounts ?? []), ['/dev', '/home', '/mnt/my disk', '/proc', '/run', '/sys']);
  assert.ok(!b.neverDescend.includes('/etc/hosts'));
});

test('BSD mount lines: a source holding " on " and a mount point holding " on " both parse', () => {
  const [nullfs] = parseBsdMount(`/Users/someone/Disk on Desk on ${FOLDERS_PLACEHOLDER}/X/ABC (nullfs, local, nodev, nosuid, read-only, nobrowse, mounted by someone)\n`);
  assert.equal(nullfs.mountPoint, `${FOLDERS_PLACEHOLDER}/X/ABC`);
  assert.equal(nullfs.source, '/Users/someone/Disk on Desk');
  assert.equal(nullfs.filesystem, 'nullfs');
  const [named] = parseBsdMount('/dev/disk4s2 on /Volumes/Fun on Sunday (hfs, local, nodev, nosuid, journaled)\n');
  assert.equal(named.mountPoint, '/Volumes/Fun on Sunday');
  assert.equal(named.source, '/dev/disk4s2');
});

test('the fixture names no account: “mounted by” and the temporary-folder hash are placeholders', () => {
  const owners = [...DIAGNOSIS_MAC_MOUNT.matchAll(/mounted by ([^),]+)\)/g)].map((m) => m[1]);
  assert.deepEqual(owners, ['someone']);
  const hashes = [...DIAGNOSIS_MAC_MOUNT.matchAll(/\/private\/var\/folders\/[^/]+\/([^/]+)\//g)].map((m) => m[1]);
  assert.deepEqual([...new Set(hashes)], ['USER_TEMP_PLACEHOLDER']);
  const user = os.userInfo().username;
  if (user.length >= 6) assert.ok(!DIAGNOSIS_MAC_MOUNT.includes(user), 'this machine’s account name is not in the fixture');
});

test('a mount point whose stat never answers holds one I/O thread, however many scans ask about it (TS review R9)', async () => {
  // A dead hard-mounted NFS share: its stat never answers. The bounded look gives up on it,
  // but cannot cancel it, and each stat parks one of libuv's few threads while it hangs.
  const asked: string[] = [];
  const answers = new Map<string, (st: { isDirectory(): boolean }) => void>();
  const stat = (p: string): Promise<{ isDirectory(): boolean }> => {
    asked.push(p);
    return new Promise((resolve) => { answers.set(p, resolve); });
  };
  const isDirectory = boundedIsDirectory(stat, 1);
  assert.equal(await isDirectory('/mnt/dead'), null, 'not known in time: kept, the safe side');
  assert.equal(await isDirectory('/mnt/dead'), null);
  assert.equal(await isDirectory('/mnt/dead'), null);
  assert.deepEqual(asked, ['/mnt/dead'], 'a later scan waits on the stat still out, it never starts another');
  assert.equal(await isDirectory('/mnt/other'), null);
  assert.deepEqual(asked, ['/mnt/dead', '/mnt/other'], 'another mount point is its own question');
  answers.get('/mnt/dead')!({ isDirectory: () => true }); // the share comes back
  await new Promise((r) => setImmediate(r));
  assert.equal(await isDirectory('/mnt/dead'), null, 'its next look is a fresh stat, which hangs again here');
  assert.deepEqual(asked, ['/mnt/dead', '/mnt/other', '/mnt/dead'], 'an answer is never kept: a drive may be mounted there since');
  const answered = boundedIsDirectory(async () => ({ isDirectory: () => false }), 1);
  assert.equal(await answered('/etc/hosts'), false, 'an answer in time is the answer');
});

/* ─────────── a root on the Data volume never descends into the fixed folders as that volume spells them ─────────── */

const DATA = '/System/Volumes/Data';
const dataSpelled = (platform: NodeJS.Platform): string[] => neverDescendPaths(platform).map((f) => DATA + f);

test('a walk of the Data volume is told not to descend into the fixed folders as that volume spells them — /System/Volumes/Data/Volumes, where every drive appears — under either rule, with or without a table (the SEC-1 review’s notes, scan side)', async () => {
  for (const rule of ['stay', 'cross'] as const) {
    const b = await scanBoundary(DATA, rule, fakeDeps('darwin', darwinTable()));
    for (const p of dataSpelled('darwin')) assert.ok(b.neverDescend.includes(p), `${rule}: ${p}`);
    for (const p of neverDescendPaths('darwin')) assert.ok(b.neverDescend.includes(p), `${rule}: the fixed list as the root spells it stays`);
    assert.deepEqual(b.fixed, neverDescendPaths('darwin'), `${rule}: the platform's fixed list is what it was`);
  }
  const unread = await scanBoundary(DATA, 'stay', fakeDeps('darwin', { source: 'mount', entries: null, reason: 'mount failed' }));
  for (const p of dataSpelled('darwin')) assert.ok(unread.neverDescend.includes(p), `no table: ${p}`);
  const unknown = unknownBoundary('stay', 'darwin', 'the table could not be composed', DATA);
  for (const p of dataSpelled('darwin')) assert.ok(unknown.neverDescend.includes(p), `nothing composed: ${p}`);
});

test('a drive the table names under /Volumes is, for a walk of the Data volume, under a fixed folder: never reached, and never looked at', async () => {
  const table: MountTable = {
    source: 'mount',
    entries: parseBsdMount('/dev/disk4s2 on /Volumes/Backup (apfs, local, nodev, nosuid, journaled)\n'),
    reason: null,
  };
  const deps = fakeDeps('darwin', table);
  const b = await scanBoundary(DATA, 'stay', deps);
  assert.deepEqual(b.mounts?.map((m) => [m.path, m.underFixed]), [[`${DATA}/Volumes/Backup`, true]]);
  assert.deepEqual(deps.asked, [], 'a dead drive there must not hold the scan’s start');
});

test('only a root on the Data volume gets that spelling: / and other folders are as they were, and Linux has no Data volume', async () => {
  const root = await scanBoundary('/', 'cross', fakeDeps('darwin', darwinTable()));
  assert.deepEqual(sorted(root.neverDescend), sorted(neverDescendPaths('darwin')));
  const users = await scanBoundary('/Users/someone', 'cross', fakeDeps('darwin', darwinTable()));
  assert.deepEqual(sorted(users.neverDescend), sorted(neverDescendPaths('darwin')));
  const inside = await scanBoundary(`${DATA}/Users/someone`, 'cross', fakeDeps('darwin', darwinTable()));
  assert.deepEqual(inside.neverDescend.filter((p) => p.startsWith(`${DATA}/Users/someone/`)), [], 'nothing of the list lies below a folder inside the Data volume');
  const linux = await scanBoundary(DATA, 'cross', fakeDeps('linux', linuxTable()));
  assert.deepEqual(sorted(linux.neverDescend), sorted(neverDescendPaths('linux')));
  assert.deepEqual(sorted(unknownBoundary('cross', 'darwin', 'x', '/').neverDescend), sorted(neverDescendPaths('darwin')));
});
