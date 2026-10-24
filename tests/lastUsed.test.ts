import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-lastused-test-');
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
import { parseMdlsBatch, parseMdutilStatus, readLastUsedMac, resetSpotlightVerdictForTests } from '../src/platform/macos/lastUsed';
import { PlistConversionError, parseXmlPlist, plistToJson } from '../src/platform/macos/plist';
import { execFileSync } from 'node:child_process';
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

test('mdls: a last-used date that is only the file\'s modification or creation date is no opening, and is dropped (review F1.2/F1.3)', () => {
  // Measured on macOS 27: for a file no app has opened, mdls reports kMDItemLastUsedDate equal to the
  // content modification date (a file touched to 2019 is "last used" in 2019) with no use count. Taken
  // as an opening, the modification time became the last-opened date — what this fact must never say.
  const T = '2019-01-02T09:04:00Z';
  const OTHER = '2020-05-05T00:00:00Z';
  const paths = ['/mod', '/created', '/fsmod', '/fscreated', '/opened', '/counted'];
  const out = parseMdlsBatch([
    { kMDItemLastUsedDate: T, kMDItemContentModificationDate: T, kMDItemContentCreationDate: OTHER, kMDItemFSContentChangeDate: OTHER, kMDItemFSCreationDate: OTHER },
    { kMDItemLastUsedDate: T, kMDItemContentModificationDate: OTHER, kMDItemContentCreationDate: T, kMDItemFSContentChangeDate: OTHER, kMDItemFSCreationDate: OTHER },
    { kMDItemLastUsedDate: T, kMDItemContentModificationDate: OTHER, kMDItemContentCreationDate: OTHER, kMDItemFSContentChangeDate: '2019-01-02T09:04:00.600Z', kMDItemFSCreationDate: OTHER },
    { kMDItemLastUsedDate: T, kMDItemContentModificationDate: OTHER, kMDItemContentCreationDate: OTHER, kMDItemFSContentChangeDate: OTHER, kMDItemFSCreationDate: '2019-01-02T09:03:59.400Z' },
    // Controls: a date apart from every one of them by a second or more is an opening ...
    { kMDItemLastUsedDate: '2019-01-02T09:04:01Z', kMDItemContentModificationDate: T, kMDItemContentCreationDate: T, kMDItemFSContentChangeDate: T, kMDItemFSCreationDate: T },
    // ... and so is one Spotlight counted uses for, whatever it equals.
    { kMDItemLastUsedDate: T, kMDItemUseCount: 4, kMDItemContentModificationDate: T, kMDItemContentCreationDate: T, kMDItemFSContentChangeDate: T, kMDItemFSCreationDate: T },
  ], paths);
  assert.ok(out);
  assert.deepEqual([...out.keys()], ['/opened', '/counted'], 'a date that is the modification or creation date, to within a second, is no record of an opening');
  assert.deepEqual(out.get('/opened'), { lastUsedMs: Date.parse('2019-01-02T09:04:01Z'), useCount: null });
  assert.deepEqual(out.get('/counted'), { lastUsedMs: Date.parse(T), useCount: 4 });
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

/* ====================== macOS: a plist that holds a date ====================== */

/**
 * What `mdls -plist -` writes for two files, one of which Spotlight has a last-opened date for
 * (HC-L8). `plutil -convert json` refuses any plist holding a <date> ("Invalid object in plist for
 * JSON format"), so the whole batch failed and Spotlight dropped out of every answer it was in.
 */
const DATED_MDLS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
	<dict>
		<key>kMDItemLastUsedDate</key>
		<date>2026-03-04T05:06:07Z</date>
		<key>kMDItemUseCount</key>
		<integer>7</integer>
	</dict>
	<dict/>
</array>
</plist>
`;

test('plist: an XML property list parses to JSON-shaped values, a date as its ISO text (HC-L8)', () => {
  assert.deepEqual(parseXmlPlist(DATED_MDLS), [{ kMDItemLastUsedDate: '2026-03-04T05:06:07Z', kMDItemUseCount: 7 }, {}]);
  const every = parseXmlPlist(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>s</key><string>a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos; &#233;&#x00E9;</string>
  <key>empty</key><string/>
  <key>n</key><integer>-42</integer>
  <key>r</key><real>1.5</real>
  <key>t</key><true/>
  <key>f</key><false/>
  <key>d</key><data>
    AAEC
    Aw==
  </data>
  <key>a</key><array><string>x</string><array/><dict/></array>
</dict></plist>`);
  assert.deepEqual(every, { s: 'a <b> & "c" \'d\' éé', empty: '', n: -42, r: 1.5, t: true, f: false, d: 'AAECAw==', a: ['x', [], {}] });
  const proto = parseXmlPlist('<plist version="1.0"><dict><key>__proto__</key><string>x</string></dict></plist>') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(proto), Object.prototype, 'a key named __proto__ is a key, never the object\'s prototype');
  assert.deepEqual(Object.keys(proto), ['__proto__']);
});

test('plist: anything not a whole property list is refused, never half-read (HC-L8)', () => {
  for (const bad of [
    '',
    '<plist version="1.0"><dict><key>a</key></dict></plist>',
    '<plist version="1.0"><dict><string>a</string><string>b</string></dict></plist>',
    '<plist version="1.0"><array><string>a</array></plist>',
    '<plist version="1.0"><integer></integer></plist>',
    '<plist version="1.0"><integer>4x</integer></plist>',
    '<plist version="1.0"><date/></plist>',
    '<plist version="1.0"><string>a</string><string>b</string></plist>',
    '<plist version="1.0"><string>a</string><dict/>',
    '<plist version="1.0"><string>a</string>',
    '<plist version="1.0"><string>a</string></plist>trailing',
    '<plist version="1.0"><blob>a</blob></plist>',
  ]) {
    assert.throws(() => parseXmlPlist(bad), PlistConversionError, JSON.stringify(bad));
  }
});

test('plist: a real dated plist goes through macOS\'s own plutil, XML and binary alike, and mdls\'s batch keeps its date (HC-L8)', { skip: process.platform !== 'darwin' && 'plutil is macOS\'s' }, async (t) => {
  const xml = Buffer.from(DATED_MDLS);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-plist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const xmlFile = path.join(dir, 'dated.plist');
  fs.writeFileSync(xmlFile, xml);
  const binFile = path.join(dir, 'dated.bin');
  execFileSync('plutil', ['-convert', 'binary1', '-o', binFile, xmlFile], { env: { ...process.env } });
  for (const [kind, body] of [['xml', xml], ['binary', fs.readFileSync(binFile)]] as const) {
    const raw = await plistToJson<unknown>(body);
    const batch = parseMdlsBatch(raw, ['/a.mov', '/b.mov']);
    assert.ok(batch, `${kind}: the batch is read, not discarded`);
    assert.deepEqual([...batch], [['/a.mov', { lastUsedMs: Date.parse('2026-03-04T05:06:07Z'), useCount: 7 }]], `${kind}: the dated file has its date, the other has none`);
  }
});

/** What `mdls -plist -` writes, verbatim in shape, for a file no app has opened (its last-used date is its modification date) and for one opened four times. */
const DEFAULT_DATED_MDLS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
	<dict>
		<key>kMDItemContentCreationDate</key>
		<date>2019-01-02T09:04:00Z</date>
		<key>kMDItemContentModificationDate</key>
		<date>2019-01-02T09:04:00Z</date>
		<key>kMDItemFSContentChangeDate</key>
		<date>2019-01-02T09:04:00Z</date>
		<key>kMDItemFSCreationDate</key>
		<date>2019-01-02T09:04:00Z</date>
		<key>kMDItemLastUsedDate</key>
		<date>2019-01-02T09:04:00Z</date>
	</dict>
	<dict>
		<key>kMDItemContentCreationDate</key>
		<date>2019-01-02T09:04:00Z</date>
		<key>kMDItemContentModificationDate</key>
		<date>2024-06-07T08:09:10Z</date>
		<key>kMDItemFSContentChangeDate</key>
		<date>2024-06-07T08:09:10Z</date>
		<key>kMDItemFSCreationDate</key>
		<date>2019-01-02T09:04:00Z</date>
		<key>kMDItemLastUsedDate</key>
		<date>2026-03-04T05:06:07Z</date>
		<key>kMDItemUseCount</key>
		<integer>4</integer>
	</dict>
</array>
</plist>
`;

test('plist: a real dated plist whose last-used date is the modification date goes through macOS\'s own plutil, and mdls\'s batch takes no opening from it (review F1.2/F1.3)', { skip: process.platform !== 'darwin' && 'plutil is macOS\'s' }, async () => {
  const raw = await plistToJson<unknown>(Buffer.from(DEFAULT_DATED_MDLS));
  const batch = parseMdlsBatch(raw, ['/never-opened.txt', '/opened.txt']);
  assert.ok(batch, 'the batch is read, not discarded');
  assert.deepEqual([...batch], [['/opened.txt', { lastUsedMs: Date.parse('2026-03-04T05:06:07Z'), useCount: 4 }]],
    'the file no app opened has no last-opened date from Spotlight; the one opened four times has its date');
});

test('a file no app has opened is never given its modification time as its last-opened date, through the real mdls (review F1.2/F1.3)', { skip: process.platform !== 'darwin' && 'mdls is macOS\'s' }, async (t) => {
  // Real tools, no stubs: on macOS 27 mdls reports this file's kMDItemLastUsedDate as its 2019
  // modification date. Where Spotlight is off (a CI runner) it reports nothing; either way the
  // answer must not be the modification time.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-lu-real-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); resetSpotlightVerdictForTests(); });
  const file = path.join(dir, 'never-opened.txt');
  fs.writeFileSync(file, 'x');
  const mtime = new Date('2019-01-02T09:04:00Z');
  fs.utimesSync(file, new Date(), mtime);
  const st = fs.lstatSync(file);
  resetSpotlightVerdictForTests();
  const got = (await readLastUsedMac([file])).get(file);
  assert.ok(got, 'the file is answered about');
  assert.ok(got.lastUsedMs === null || Math.abs(got.lastUsedMs - st.mtimeMs) >= 1000,
    `the modification time is not a last-opened date: ${JSON.stringify(got)} (mtime ${st.mtimeMs})`);
  if (got.source === 'atime') {
    // The access time stands in (a read since the utimes may have moved it on, never back), with its caveat.
    assert.ok(got.lastUsedMs !== null && got.lastUsedMs >= Math.floor(st.atimeMs), `the access time stands in: ${JSON.stringify(got)}`);
    assert.ok(got.caveat && got.caveat.includes(ATIME_CAVEAT), 'with its caveat');
  }
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

/**
 * Both halves of the contract, because which one runs depends on the machine.
 *
 * This is not a Windows work-around. Whether last-opened dates exist at all is
 * a real property of the host: NTFS last-access updates have been off by
 * default since Vista, so a Windows runner legitimately reports the feature
 * unavailable — and that path had never been exercised live anywhere, only
 * through parse fixtures. Asserting both branches covers it for the first
 * time, and a skip would have covered nothing.
 *
 * The earlier version of these tests hard-asserted `available === true`, which
 * encoded a macOS/Linux assumption and failed on Windows CI. The code was
 * right; the tests were.
 */
function assertUnavailableIsHonest(result: { available: boolean; reason?: string; values: Record<string, unknown>; stats: { requested: number; computed: number; skipped: number; failed: number } }, requested: number): void {
  assert.equal(result.available, false);
  // §2.4: unavailable is a first-class state — it must say WHY, in a sentence
  // a person can act on, and offer nothing.
  assert.ok(result.reason && result.reason.length > 20, `an unavailable provider must explain itself, got: ${JSON.stringify(result.reason)}`);
  assert.deepEqual(result.values, {}, 'and must not invent a single date');
  assert.equal(result.stats.requested, requested);
  assert.equal(result.stats.computed, 0);
  // Nothing was attempted, so nothing failed — reporting these as failures
  // would make an honest "this machine cannot do that" look like a malfunction.
  assert.equal(result.stats.failed, 0);
  assert.equal(result.stats.requested, result.stats.computed + result.stats.skipped + result.stats.failed);
}

test('the provider either answers with a real date, or says why it cannot', async () => {
  const fixture = usedFixture();
  try {
    // An access time no clock would give: a whole second, far from now and
    // from the file's own mtime. Read back exactly, it proves the date is
    // genuinely read from the file rather than made up or stamped "now".
    const planted = new Date('2011-06-15T12:34:56.000Z');
    fs.utimesSync(fixture.file, planted, fs.statSync(fixture.file).mtime);
    clearFactCache();
    const out = await computeFacts('scan-lu', [fixture.file], ['lastUsed'], new AbortController().signal);
    const result = out.lastUsed;

    if (!result.available) {
      // A host that does not record file openings at all — a Windows runner
      // with NTFS last-access tracking off, or a wholly `noatime` system.
      assertUnavailableIsHonest(result, 1);
      return;
    }

    const fact = result.values[fixture.file] as { lastUsedMs: number | null; source: string; caveat?: string };
    assert.ok(fact, 'the fixture got an answer');
    assert.equal(typeof fact.lastUsedMs, 'number');
    // Whichever source answered, a non-Spotlight answer must carry its caveat.
    if (fact.source === 'atime') {
      assert.equal(fact.lastUsedMs, planted.getTime(), 'the access time on disk, read back exactly: it is genuinely being read');
      assert.ok(fact.caveat, 'an access-time answer always states what it is');
    }
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

    // The rule under test holds either way: the vanished path is ABSENT from
    // `values`. It is never present with a zero date, which would render as
    // 1 January 1970 and read as "ancient — safe to delete".
    assert.equal(Object.prototype.hasOwnProperty.call(result.values, ghost), false);

    if (!result.available) { assertUnavailableIsHonest(result, 2); return; }
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
    // The loop below asserts nothing when the values map is empty, and an
    // empty map is a REACHABLE state, not a hypothetical: an unavailable
    // provider answers with `unavailableBatch()`, whose values map is empty by
    // construction. Without this fork the whole test is a no-op on any machine
    // that lacks the capability, which is exactly the shape of "green while
    // testing nothing". So: either the provider said plainly that it cannot
    // answer here, or it answered about the path we asked about — never
    // silently neither.
    const answered = Object.values(out.lastUsed.values);
    if (!out.lastUsed.available) {
      assert.ok(
        typeof out.lastUsed.reason === 'string' && out.lastUsed.reason.trim().length > 0,
        'an unavailable provider must name its reason in words',
      );
      assert.equal(answered.length, 0, 'an unavailable provider answers about nothing');
      return;
    }
    assert.equal(answered.length, 1, 'an available provider answers about the one path it was given');
    for (const value of answered) {
      const fact = value as { lastUsedMs: number | null; source: string };
      if (fact.source === 'none') assert.equal(fact.lastUsedMs, null, 'source "none" must carry a null date');
      if (fact.lastUsedMs !== null) assert.notEqual(fact.source, 'none', 'a date must always name its source');
    }
  } finally {
    fixture.cleanup();
  }
});

/* ============================ regressions from review ============================ */

test('a ONE-path mdls batch is a bare dict, not an array', () => {
  // Verified against the real tool: `mdls -plist - -- one` emits `{}` while
  // two paths emit `[{},{}]`.
  //
  // Requiring an array made every single-path batch parse as null, and the
  // Spotlight probe memoises that for the whole process as "Spotlight has
  // nothing to say". So the most likely first request the UI ever makes —
  // facts for one selected file — permanently downgraded every later batch to
  // access times and displayed a sentence that was false.
  const one = parseMdlsBatch({ kMDItemLastUsedDate: '2025-03-14T09:21:00Z', kMDItemUseCount: 3 }, ['/a']);
  assert.ok(one, 'a bare dict is accepted for a single path');
  assert.equal(one!.get('/a')!.useCount, 3);

  // An empty dict for one path is still a valid answer meaning "no data".
  const empty = parseMdlsBatch({}, ['/a']);
  assert.ok(empty);
  assert.equal(empty!.size, 0);

  // A bare dict for MORE than one path is still a mismatch and refused.
  assert.equal(parseMdlsBatch({}, ['/a', '/b']), null);
});
