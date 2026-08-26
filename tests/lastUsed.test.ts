import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-lastused-test-'));
process.env.TREEMAP_NO_GDU = '1';

import {
  ATIME_CAVEAT,
  atimeSupportFromOptions,
  lastUsedFromAtime,
  mountForPath,
  parseBsdMount,
  parseDisableLastAccess,
  parseProcMounts,
  readAtime,
  unescapeMountPoint,
  windowsLastAccessReason,
} from '../src/platform/atime';
import { parseMdlsBatch, parseMdutilStatus } from '../src/platform/macos/lastUsed';
import { lastUsedProvider } from '../src/services/facts/lastUsedProvider';
import { clearFactCache, computeFacts } from '../src/services/facts';

/**
 * Last-opened dates (v4 §1.1).
 *
 * Almost everything interesting here lives in *other people's* tool output — a
 * `noatime` mount, an NTFS volume with last-access tracking off, an `mdls`
 * batch that lost its alignment — and none of it can be produced on the
 * machine running these tests. So the parsers are pure and exported, and this
 * file drives them against captured output. That is the only honest way to
 * cover a Windows behaviour from a Mac, and the phase check-in says plainly
 * which paths have and have not run live.
 *
 * The rule every case below is ultimately defending: **an unknown date is
 * null, never zero.** A zero renders as 1 January 1970, which reads as
 * "ancient — safe to delete". That is the single worst thing this feature
 * could do.
 */

/* ============================ macOS: mdls ============================ */

test('mdls: a batch zips positionally onto its input paths', () => {
  // `mdls -plist - a b c` emits an array of dicts with no paths in them. The
  // array order is the ONLY thing tying an answer to a file.
  const paths = ['/a.txt', '/b.txt', '/c.txt'];
  const raw = [
    { kMDItemLastUsedDate: '2025-03-14T09:21:00Z', kMDItemUseCount: 12 },
    {},
    { kMDItemLastUsedDate: '2024-11-02T18:00:00Z' },
  ];
  const out = parseMdlsBatch(raw, paths);
  assert.ok(out);
  assert.equal(out.size, 2);
  assert.equal(out.get('/a.txt')!.lastUsedMs, Date.parse('2025-03-14T09:21:00Z'));
  assert.equal(out.get('/a.txt')!.useCount, 12);
  assert.equal(out.has('/b.txt'), false, 'an empty dict means no data, not a zero date');
  assert.equal(out.get('/c.txt')!.useCount, null, 'a missing use count is null, not 0');
});

test('mdls: a length mismatch discards the batch rather than mis-zipping it', () => {
  // The observed failure: one nonexistent path makes mdls abandon the plist
  // entirely, print "could not find /x." as plain text, and EXIT 0. If the
  // shorter array were zipped anyway, one file's date would be attached to a
  // different file's row — a wrong answer presented with full confidence.
  assert.equal(parseMdlsBatch([{}, {}], ['/a', '/b', '/c']), null);
  assert.equal(parseMdlsBatch([], ['/a']), null);
  assert.equal(parseMdlsBatch('could not find /x.', ['/a']), null);
  assert.equal(parseMdlsBatch(null, ['/a']), null);
});

test('mdls: only genuinely parseable dates are accepted', () => {
  const paths = ['/a', '/b', '/c', '/d'];
  const out = parseMdlsBatch(
    [
      { kMDItemLastUsedDate: '(null)' },
      { kMDItemLastUsedDate: 12345 },
      { kMDItemLastUsedDate: '' },
      { kMDItemLastUsedDate: 'not a date at all' },
    ],
    paths,
  );
  assert.ok(out);
  // NaN from Date.parse must never become a date. Every one of these is
  // "unknown", and unknown means absent.
  assert.equal(out.size, 0);
});

test('mdls: a negative or absurd use count is dropped, not shown', () => {
  const out = parseMdlsBatch(
    [{ kMDItemLastUsedDate: '2025-01-01T00:00:00Z', kMDItemUseCount: -3 }],
    ['/a'],
  );
  assert.equal(out!.get('/a')!.useCount, null);
});

test('mdutil: only a recognisably enabled answer counts as enabled', () => {
  assert.equal(parseMdutilStatus('/:\n\tIndexing enabled. '), true);
  assert.equal(parseMdutilStatus('/Volumes/Backup:\n\tIndexing disabled.'), false);
  assert.equal(parseMdutilStatus('/Volumes/Ext:\n\tIndexing and searching disabled.'), false);
  // An unreadable answer must not be optimistically read as working.
  assert.equal(parseMdutilStatus(''), false);
  assert.equal(parseMdutilStatus('Error: invalid operation.'), false);
  assert.equal(parseMdutilStatus('/Volumes/X:\n\tIndexing enabled but not searchable.'), true);
});

/* ============================ Linux: /proc/mounts ============================ */

const PROC_MOUNTS = [
  'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
  'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
  '/dev/sda2 / ext4 rw,relatime,errors=remount-ro 0 0',
  '/dev/sda3 /home ext4 rw,noatime 0 0',
  '/dev/sdb1 /mnt/my\\040backup\\040disk ext4 rw,strictatime 0 0',
  '',
].join('\n');

test('/proc/mounts parses, including octal-escaped mount points', () => {
  const entries = parseProcMounts(PROC_MOUNTS);
  assert.equal(entries.length, 5);
  const backup = entries.find((e) => e.filesystem === 'ext4' && e.options.includes('strictatime'));
  // A user whose backup drive is called "My Passport" would never match their
  // own mount if the kernel's \040 escaping were left in place.
  assert.equal(backup!.mountPoint, '/mnt/my backup disk');
  assert.equal(unescapeMountPoint('/mnt/a\\011b\\012c\\134d'), '/mnt/a\tb\nc\\d');
});

test('the longest matching mount wins, because mounts nest', () => {
  const entries = parseProcMounts(PROC_MOUNTS);
  // /home is noatime and sits under a relatime /. Taking the first match
  // instead of the longest would read the root's options for every file in
  // /home and report last-used dates that never move.
  assert.equal(mountForPath(entries, '/home/me/file.txt')!.mountPoint, '/home');
  assert.equal(mountForPath(entries, '/var/log/syslog')!.mountPoint, '/');
  assert.equal(mountForPath(entries, '/mnt/my backup disk/x')!.mountPoint, '/mnt/my backup disk');
});

test('a mount point is not a prefix of an unrelated sibling', () => {
  const entries = parseProcMounts('/dev/sda1 /home ext4 rw,noatime 0 0\n/dev/sda2 / ext4 rw,relatime 0 0');
  // "/homework" must not match the "/home" mount on a bare string prefix.
  assert.equal(mountForPath(entries, '/homework/file')!.mountPoint, '/');
  assert.equal(mountForPath(entries, '/home')!.mountPoint, '/home');
});

test('noatime is fatal; relatime is usable but says so', () => {
  const noatime = atimeSupportFromOptions(['rw', 'noatime']);
  assert.equal(noatime.usable, false);
  assert.match(noatime.reason!, /noatime/);
  // The refusal must state that mtime is NOT being substituted — otherwise a
  // user reasonably assumes some date is being shown.
  assert.match(noatime.reason!, /no way to know/i);

  const relatime = atimeSupportFromOptions(['rw', 'relatime']);
  assert.equal(relatime.usable, true, 'relatime is the modern default — refusing it would throw away a good signal');
  assert.match(relatime.reason!, /nearest day/);

  assert.equal(atimeSupportFromOptions(['rw', 'strictatime']).usable, true);
  assert.equal(atimeSupportFromOptions(['rw']).usable, true);
});

/* ============================ macOS: mount ============================ */

const BSD_MOUNT = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, shadow)',
  '/dev/disk4s2 on /Volumes/Backup Drive (hfs, local, nodev, noatime)',
  '',
].join('\n');

test('BSD mount output parses into the same shape as /proc/mounts', () => {
  const entries = parseBsdMount(BSD_MOUNT);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].mountPoint, '/');
  assert.equal(entries[0].filesystem, 'apfs');
  // A mount point containing a space must survive — external drives are
  // routinely named with them.
  const backup = entries[2];
  assert.equal(backup.mountPoint, '/Volumes/Backup Drive');
  assert.equal(atimeSupportFromOptions(backup.options).usable, false);
  assert.equal(mountForPath(entries, '/Volumes/Backup Drive/old.zip')!.mountPoint, '/Volumes/Backup Drive');
});

test('BSD mount: malformed lines are skipped, never half-parsed', () => {
  assert.deepEqual(parseBsdMount(''), []);
  assert.deepEqual(parseBsdMount('garbage without the marker'), []);
  assert.deepEqual(parseBsdMount('/dev/x on /y (unterminated'), []);
});

/* ============================ Windows: fsutil ============================ */

test('fsutil DisableLastAccess is a two-bit field, not a boolean', () => {
  // 0 User Managed/Enabled · 1 User Managed/Disabled
  // 2 System Managed/Enabled · 3 System Managed/Disabled
  // Bit 0 is the disable flag; bit 1 only records who decides. The tempting
  // shortcut — "non-zero means off" — would wrongly blank this feature on
  // every machine reporting 2, a common modern default.
  assert.deepEqual(parseDisableLastAccess('DisableLastAccess = 0  (User Managed, Updates Enabled)'), { updatesEnabled: true, raw: 0 });
  assert.deepEqual(parseDisableLastAccess('DisableLastAccess = 1  (User Managed, Updates Disabled)'), { updatesEnabled: false, raw: 1 });
  assert.deepEqual(parseDisableLastAccess('DisableLastAccess = 2  (System Managed, Updates Enabled)'), { updatesEnabled: true, raw: 2 });
  assert.deepEqual(parseDisableLastAccess('DisableLastAccess = 3  (System Managed, Updates Disabled)'), { updatesEnabled: false, raw: 3 });
});

test('fsutil: an unreadable answer is null, never optimistically "enabled"', () => {
  assert.equal(parseDisableLastAccess(''), null);
  assert.equal(parseDisableLastAccess('The system cannot find the file specified.'), null);
  assert.equal(parseDisableLastAccess('DisableLastAccess = 9'), null, 'out-of-range values are not guessed at');
  assert.equal(parseDisableLastAccess('DisableLastAccess = '), null);
  // Case and spacing vary between Windows versions.
  assert.deepEqual(parseDisableLastAccess('disablelastaccess=1'), { updatesEnabled: false, raw: 1 });
});

test('the Windows refusal names who turned it off, and refuses to substitute mtime', () => {
  const systemManaged = windowsLastAccessReason(3);
  const userManaged = windowsLastAccessReason(1);
  assert.match(systemManaged, /Windows manages this setting/);
  assert.match(userManaged, /changed manually/);
  for (const reason of [systemManaged, userManaged]) {
    // The most important sentence in the whole feature: it says outright that
    // the modification date is NOT being shown in place of the missing one.
    assert.match(reason, /will not substitute the last-modified date/);
    assert.match(reason, /different fact/);
  }
});

/* ============================ the null rule ============================ */

test('an unknown access time is null and source "none" — never a 1970 date', () => {
  for (const bad of [null, 0, -1, NaN, Infinity]) {
    const info = lastUsedFromAtime(bad as number | null);
    assert.equal(info.lastUsedMs, null, `atime ${String(bad)} must not become a date`);
    assert.equal(info.source, 'none');
    assert.equal(info.useCount, null);
  }
  // A zero here would render as 1 January 1970 and read as "ancient, safe to
  // delete" — the single worst thing this feature could do.
  const good = lastUsedFromAtime(1_700_000_000_000);
  assert.equal(good.lastUsedMs, 1_700_000_000_000);
  assert.equal(good.source, 'atime');
  assert.equal(good.caveat, ATIME_CAVEAT);
});

test('the access-time caveat explains that other things read files too', () => {
  // Users make delete decisions from this date. It has to say what it is.
  assert.match(ATIME_CAVEAT, /not a record of you opening it/);
  assert.match(ATIME_CAVEAT, /Backups, search indexing, antivirus/);
});

test('readAtime returns null for a path that is not there', async () => {
  assert.equal(await readAtime(path.join(os.tmpdir(), 'treemap-definitely-absent-zzz')), null);
});

/* ============================ the fact provider ============================ */

/** A real file, freshly read, so its access time is genuinely recent. */
function usedFixture(): { dir: string; file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-lastused-fixture-'));
  const file = path.join(dir, 'used.txt');
  fs.writeFileSync(file, 'hello');
  fs.readFileSync(file); // move atime
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the provider answers with a real date on this machine', async () => {
  const fixture = usedFixture();
  try {
    clearFactCache();
    const out = await computeFacts('scan-lu', [fixture.file], ['lastUsed'], new AbortController().signal);
    const result = out.lastUsed;
    assert.equal(result.available, true, result.reason ?? '');
    const fact = result.values[fixture.file] as { lastUsedMs: number | null; source: string; caveat?: string };
    assert.ok(fact, 'the fixture got an answer');
    assert.equal(typeof fact.lastUsedMs, 'number');
    assert.ok(fact.lastUsedMs! > Date.now() - 60_000, 'the date is recent, so it is genuinely being read');
    // Whichever source answered, a non-Spotlight answer must carry its caveat.
    if (fact.source === 'atime') assert.ok(fact.caveat, 'an access-time answer always states what it is');
    assert.ok(['spotlight', 'atime'].includes(fact.source), `unexpected source ${fact.source}`);
  } finally {
    fixture.cleanup();
  }
});

test('a path that vanished since the scan is skipped, never dated zero', async () => {
  const fixture = usedFixture();
  const ghost = path.join(fixture.dir, 'deleted-since-the-scan.txt');
  try {
    clearFactCache();
    const out = await computeFacts('scan-lu2', [fixture.file, ghost], ['lastUsed'], new AbortController().signal);
    const result = out.lastUsed;
    assert.equal(Object.prototype.hasOwnProperty.call(result.values, ghost), false);
    assert.deepEqual(result.stats, { requested: 2, computed: 1, skipped: 1, failed: 0 });
  } finally {
    fixture.cleanup();
  }
});

test('the provider is gated on its capability and declares its key', () => {
  // A view or consumer can gate itself declaratively rather than re-deriving
  // per-OS availability, which is how three consumers end up with three
  // subtly different ideas of what is available.
  assert.equal(lastUsedProvider.capabilityKey, 'lastUsed');
  assert.equal(lastUsedProvider.id, 'lastUsed');
});

test('an already-aborted batch computes nothing but still accounts for every path', async () => {
  const fixture = usedFixture();
  try {
    clearFactCache();
    const controller = new AbortController();
    controller.abort();
    const out = await computeFacts('scan-lu3', [fixture.file], ['lastUsed'], controller.signal);
    const s = out.lastUsed.stats;
    assert.equal(s.requested, s.computed + s.skipped + s.failed);
    assert.equal(s.computed, 0);
  } finally {
    fixture.cleanup();
  }
});

test('mtime is never substituted for a missing last-used date', async () => {
  // The rule, asserted end to end rather than only in the reason strings: for
  // every path the provider answers about, a null lastUsedMs stays null. No
  // code path may quietly fill it from the modification time — "changed a year
  // ago" is a different fact from "not opened in a year", and swapping them
  // would put a wrong reason underneath a delete button.
  const fixture = usedFixture();
  try {
    clearFactCache();
    const out = await computeFacts('scan-lu4', [fixture.file], ['lastUsed'], new AbortController().signal);
    for (const value of Object.values(out.lastUsed.values)) {
      const fact = value as { lastUsedMs: number | null; source: string };
      if (fact.source === 'none') assert.equal(fact.lastUsedMs, null, 'source "none" must carry a null date');
      if (fact.lastUsedMs !== null) assert.notEqual(fact.source, 'none', 'a date must always name its source');
    }
  } finally {
    fixture.cleanup();
  }
});
