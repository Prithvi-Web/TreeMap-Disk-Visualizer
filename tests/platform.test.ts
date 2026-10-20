import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
import { openFileEnumerationsDuring } from './fixtures/openFileEnumerations';
isolatedDataDir('treemap-platform-data-');

import { platform, platformNameOf } from '../src/platform';
import { getCapabilities, invalidateCapabilities } from '../src/platform/capabilities';
import { parseLsofRecords, resolveZombies, openHandlesFor } from '../src/platform/macos/lsofGuard';
import * as lsof from '../src/platform/macos/lsofGuard';
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

/* ── Sixth browser pass H04: lsof's 31-character command names ── */

/** The lsofGuard names this fix adds, read loosely so a missing one fails as an assertion. */
const lsofNames = (lsof as unknown as {
  LSOF_NAME_MAX?: number;
  displayProcessName?: (lsofName: string, executable: string | null) => string;
  withFullProcessNames?: <T extends { pid: number; processName: string }>(rows: T[], executablesOf: (pids: number[]) => Promise<Map<number, string | null>>) => Promise<T[]>;
});
// Recorded on this Mac: `lsof -F pc -p 1192` printed the first 31 characters, cut mid-word.
const APERITIF_CUT = 'Google Chrome Helper (Aperitif ';
const APERITIF_EXE = '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/141.0.7390.55/Helpers/Google Chrome Helper (Aperitif Renderer).app/Contents/MacOS/Google Chrome Helper (Aperitif Renderer)';

test('a process name lsof cut at its 31 characters is the executable\'s own name where that continues it, else ellipsized — never with a trailing space (H04)', () => {
  assert.equal(lsofNames.LSOF_NAME_MAX, 31, 'lsof prints at most 31 characters of a name (the kernel\'s 32 bytes and their NUL)');
  const show = lsofNames.displayProcessName;
  assert.equal(typeof show, 'function', 'lsofGuard exposes displayProcessName');
  assert.equal(APERITIF_CUT.length, 31, 'control: the recorded name is as long as lsof prints');
  assert.equal(show!(APERITIF_CUT, APERITIF_EXE), 'Google Chrome Helper (Aperitif Renderer)', 'the executable\'s own name, whole');
  assert.equal(show!(APERITIF_CUT, null), 'Google Chrome Helper (Aperitif…', 'unknown executable: what lsof gave, said to be cut, with no trailing space');
  assert.equal(show!(APERITIF_CUT, '/usr/local/bin/other'), 'Google Chrome Helper (Aperitif…', 'an executable whose name does not continue it is not borrowed');
  assert.equal(show!('Google Chrome Helper (Renderer)', '/x/Google Chrome Helper (Renderer)'), 'Google Chrome Helper (Renderer)', 'a whole 31-character name stays as it is');
  assert.equal(show!('node ', null), 'node', 'a short name is whole: its trailing space goes, and no ellipsis is added');
  assert.equal(show!('Finder', '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder'), 'Finder', 'a short name is never replaced');
});

test('open-file conflicts ask the executable of the cut names alone, in one call, and an unanswered call leaves them ellipsized (H04)', async () => {
  const full = lsofNames.withFullProcessNames;
  assert.equal(typeof full, 'function', 'lsofGuard exposes withFullProcessNames');
  const rows = [
    { pid: 7, processName: APERITIF_CUT, path: '/a', openPath: '/a' },
    { pid: 7, processName: APERITIF_CUT, path: '/b', openPath: '/b' },
    { pid: 8, processName: 'Python', path: '/c', openPath: '/c' },
  ];
  const asked: number[][] = [];
  const named = await full!(rows, async (pids) => { asked.push(pids); return new Map([[7, APERITIF_EXE]]); });
  assert.deepEqual(asked, [[7]], 'one call, about the cut name\'s pid alone, once');
  assert.deepEqual(named.map((r) => r.processName), ['Google Chrome Helper (Aperitif Renderer)', 'Google Chrome Helper (Aperitif Renderer)', 'Python']);
  assert.deepEqual(named.map((r) => r.path), ['/a', '/b', '/c'], 'every other field as it was');
  const none = await full!(rows, async () => { throw new Error('ps did not answer'); });
  assert.deepEqual(none.map((r) => r.processName), ['Google Chrome Helper (Aperitif…', 'Google Chrome Helper (Aperitif…', 'Python'], 'unanswered: said to be cut');
  let calls = 0;
  await full!([rows[2]], async () => { calls++; return new Map(); });
  assert.equal(calls, 0, 'no cut name, no call');
});

/*
 * Review F1.1: a name past ASCII. Recorded on this Mac with `lsof -w -F pc`: under no locale (as the Dock
 * and launchd start TreeMap) lsof writes each byte it cannot print as `\xNN` text; under a UTF-8 locale it
 * writes the raw bytes, cut at byte 31 — inside a character, whose first byte it writes raw, which Node
 * then decodes as U+FFFD (any later byte of it is `\xNN`, review F3.2 below).
 * 日 本 語 are three bytes each (E6 97 A5, E6 9C AC, E8 AA 9E).
 */
const NIHONGO_ESCAPED = '\\xe6\\x97\\xa5\\xe6\\x9c\\xac\\xe8\\xaa\\x9e';
const JP_CUT_ESCAPED = `${NIHONGO_ESCAPED.repeat(3)}\\xe6\\x97\\xa5\\xe6`; // 31 bytes: ten whole characters and one byte of 本
const JP_CUT_RAW = '日本語日本語日本語日\uFFFD';
const JP_EXE = '/Users/me/Apps/日本語日本語日本語日本語';

test('a process name lsof wrote as \\xNN escapes is read back as its letters, and judged cut by its bytes, never by its UTF-16 length (review F1.1)', () => {
  const show = lsofNames.displayProcessName!;
  const nameOf = (c: string): string => parseLsofRecords(['p41', `c${c}`, 'f3', 'n/x/a'].join('\n'))[0].processName;
  assert.equal(nameOf('\\xc3\\x89cran Partag\\xc3\\xa9 Assistant App'), 'Écran Partagé Assistant App', 'the escapes are the bytes of É and é');
  assert.equal(show(nameOf('\\xc3\\x89cran Partag\\xc3\\xa9 Assistant App'), null), 'Écran Partagé Assistant App', 'its 29 bytes are under lsof\'s 31: whole, with no ellipsis');
  assert.equal(nameOf(String.raw`do\\x41`), String.raw`do\x41`, 'lsof writes a backslash as "\\\\" (measured, review F2.1): the name "do\\x41" is read back as it is, never as "doA"');

  assert.equal(show(nameOf(JP_CUT_ESCAPED), null), '日本語日本語日本語日…', 'cut inside a character under no locale: the whole characters, said to be cut');
  assert.equal(show(nameOf(JP_CUT_ESCAPED), JP_EXE), '日本語日本語日本語日本語', 'and the executable\'s own name where it continues them');
  assert.equal(show(JP_CUT_RAW, null), '日本語日本語日本語日…', 'cut inside a character under a UTF-8 locale: never shown whole with a U+FFFD');
  assert.equal(show(JP_CUT_RAW, JP_EXE), '日本語日本語日本語日本語', 'and the executable\'s own name where it continues them');

  const appli = 'Écran Partagé Assistant Appli'; // 29 characters, 31 bytes: as long as lsof prints
  assert.equal(Buffer.byteLength(appli), 31, 'control: as many bytes as lsof prints');
  assert.equal(show(appli, '/Applications/Écran Partagé Assistant Application'), 'Écran Partagé Assistant Application', 'judged by its bytes, it may be cut: the executable continues it');
  assert.equal(show(appli, null), 'Écran Partagé Assistant Appli…', 'and with no executable it is said to be cut');
});

/*
 * Review F3.2, recorded on this Mac with `lsof -w -F pc` under en_US.UTF-8, as `npm start` from a terminal
 * runs: a 35-byte executable name the kernel cuts at 31 bytes, after two of the three bytes of こ, is written
 * with the first of them raw and the second as the text "\x81" — two U+FFFD once read back. (Under no locale
 * both are "\xNN" and read back as one.)
 */
test('a name cut inside a character that reads back as a run of U+FFFD — a raw byte, then lsof\'s \\xNN for the next — is completed from the executable, and never shown with a U+FFFD (review F3.2)', async () => {
  const whole = 'AAあいうえおかきくけこさ';
  const exe = `/Users/me/bin/${whole}`;
  // As runText reads lsof's output: its bytes decoded as UTF-8.
  const stdout = Buffer.concat([Buffer.from('p16327\ncAAあいうえおかきくけ'), Buffer.from([0xe3]), Buffer.from(String.raw`\x81` + '\nf3\nn/x/a\n')]).toString('utf8');
  const [rec] = parseLsofRecords(stdout);
  assert.equal(rec.processName, 'AAあいうえおかきくけ��', 'control: the raw byte and the escaped one each read back as a U+FFFD');
  const show = lsofNames.displayProcessName!;
  assert.equal(show(rec.processName, exe), whole, 'the executable continues what was kept');
  assert.equal(show(rec.processName, null), 'AAあいうえおかきくけ…', 'with no executable it is said to be cut, with no U+FFFD');
  const [named] = await lsofNames.withFullProcessNames!([{ pid: 16327, processName: rec.processName }], async () => new Map([[16327, exe]]));
  assert.equal(named.processName, whole, 'and the open-file warning names it whole');
  // A cut keeps at most three bytes of a four-byte character: however many U+FFFD they read back as, none is shown.
  assert.equal(show(`${'x'.repeat(28)}���`, null), `${'x'.repeat(28)}…`, 'three U+FFFD are one cut character');
});

test('open-file conflicts ask about every name cut by its bytes or inside a character, and none whole (review F1.1)', async () => {
  const full = lsofNames.withFullProcessNames!;
  const rows = [
    { pid: 9, processName: 'Écran Partagé Assistant Appli' },
    { pid: 10, processName: 'Écran Partagé Assistant App' },
    { pid: 11, processName: JP_CUT_RAW },
  ];
  const asked: number[][] = [];
  const named = await full(rows, async (pids) => {
    asked.push(pids);
    return new Map([[9, '/Applications/Écran Partagé Assistant Application'], [11, JP_EXE]]);
  });
  assert.deepEqual(asked, [[9, 11]], 'the 31-byte name and the name cut inside a character are asked about; the 29-byte one is whole');
  assert.deepEqual(named.map((r) => r.processName), ['Écran Partagé Assistant Application', 'Écran Partagé Assistant App', '日本語日本語日本語日本語']);
});

test('the executables a cut name is completed from are read by a ps under a UTF-8 locale, which writes a name past ASCII as its letters (review F1.1)', async () => {
  const psExecutables = (lsof as unknown as { psExecutables?: (pids: number[], run: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => Promise<string>) => Promise<Map<number, string | null>> }).psExecutables;
  assert.equal(typeof psExecutables, 'function', 'lsofGuard exposes psExecutables with an injectable runner');
  const seen: (NodeJS.ProcessEnv | undefined)[] = [];
  const found = await psExecutables!([7], async (cmd, args, opts) => { seen.push(opts?.env); return `    7 ${JP_EXE}\n`; });
  assert.equal(found.get(7), JP_EXE);
  assert.equal(seen.length, 1);
  assert.match(seen[0]?.LC_ALL ?? '', /\.UTF-8$/, 'LC_ALL names a UTF-8 locale: under C, macOS\'s ps writes É as "M-CM^I"');
});

test('a whole name of 30 bytes — one short of what lsof prints — is never said to be cut, nor its executable asked for (review F2.5)', async () => {
  const show = lsofNames.displayProcessName!;
  const full = lsofNames.withFullProcessNames!;
  const ascii = 'Google Chrome Helper (Renderer'; // 30 ASCII bytes
  const accented = 'Écran Partagé Assistant Appl'; // 28 characters, 30 bytes
  assert.deepEqual([ascii, accented].map((n) => Buffer.byteLength(n)), [30, 30], 'control: both one byte short of lsof\'s 31');
  assert.equal(show(ascii, null), ascii, '30 ASCII bytes: whole, no ellipsis');
  assert.equal(show(accented, null), accented, '30 bytes past ASCII: whole, no ellipsis');
  assert.equal(show(ascii, '/x/Google Chrome Helper (Renderer) Extra'), ascii, 'and never swapped for a longer executable name');
  let calls = 0;
  const named = await full([{ pid: 3, processName: ascii }, { pid: 4, processName: accented }], async () => { calls++; return new Map(); });
  assert.equal(calls, 0, 'no name may be cut: ps is not asked');
  assert.deepEqual(named.map((r) => r.processName), [ascii, accented]);
});

/*
 * Review F2.1, recorded on this Mac with `lsof -F n` under no locale, as the Dock and launchd start TreeMap
 * (LC_ALL=C prints the same): lsof writes a backslash as `\\` under every locale, a tab and a newline as `\t`
 * and `\n` — a backspace, form feed and carriage return as `\b`, `\f` and `\r` (review F3.4, measured under
 * no locale and en_US.UTF-8) — DEL and each byte past ASCII as `\xNN`; under en_US.UTF-8 it writes É and é
 * as their bytes but the backslash still as `\\`. Another control byte is `^A`, exactly as a caret followed
 * by an A is, so `^X` cannot be undone and is left as written.
 */
const LSOF_N_RECORDED: readonly (readonly [lsofText: string, name: string])[] = [
  [String.raw`\xc3\x89cran Partag\xc3\xa9.txt`, 'Écran Partagé.txt'],
  [String.raw`back\\slash.txt`, String.raw`back\slash.txt`],
  [String.raw`tab\there.txt`, 'tab\there.txt'],
  [String.raw`nl\nline.txt`, 'nl\nline.txt'],
  [String.raw`bs\bx.txt`, 'bs\bx.txt'],
  [String.raw`ff\fx.txt`, 'ff\fx.txt'],
  [String.raw`cr\rx.txt`, 'cr\rx.txt'],
  [String.raw`del\x7fz.txt`, 'del\x7fz.txt'],
  [String.raw`lit\\x41.txt`, String.raw`lit\x41.txt`],
  [String.raw`lit\\\\n.txt`, String.raw`lit\\n.txt`],
  ['caret^Atext.txt', 'caret^Atext.txt'],
];

test('parseLsofRecords reads a path back from every escape lsof writes in it — a backslash, a tab, a newline, a backspace, a form feed, a carriage return, DEL and each byte past ASCII — and leaves its ambiguous ^X as written (review F2.1, F3.4)', () => {
  for (const [written, name] of LSOF_N_RECORDED) {
    const [rec] = parseLsofRecords(['p41', 'csleep', 'f3', 's1', 'i9', `n/Users/me/f21/${written}`].join('\n'));
    assert.equal(rec?.path, `/Users/me/f21/${name}`, `lsof's "${written}" is the file "${name}"`);
  }
  const [gone] = parseLsofRecords(['p9', 'cnode', 'f3', 's100', 'i42', String.raw`n/tmp/\xc3\xa9t\xc3\xa9.bin (deleted)`].join('\n'));
  assert.deepEqual([gone.path, gone.markedDeleted], ['/tmp/été.bin', true], 'an escaped path keeps the Linux (deleted) marker, which is not part of the path');
  assert.equal(parseLsofRecords(['p41', String.raw`cback\\slash`, 'f3', 'n/x/a'].join('\n'))[0].processName, String.raw`back\slash`,
    'a name\'s backslash is read back the same way');
});

test('a file with an escaped name, held open, is in use and never a deleted file still held (review F2.1)', async () => {
  const out = ['p53661', 'csleep', 'f3', 's1', 'i9',
    String.raw`n/Users/me/\xc3\x89cran Partag\xc3\xa9.txt`, 'f4', 's1', 'i10', String.raw`n/Users/me/back\\slash.txt`].join('\n');
  const files = ['/Users/me/Écran Partagé.txt', String.raw`/Users/me/back\slash.txt`];
  const held = lsof.intersectHandles(parseLsofRecords(out), files.map((f) => [f, f] as const));
  assert.deepEqual(held.map((h) => h.path), files, 'each file is found in use');
  const inodes = new Map([[files[0], 9], [files[1], 10]]);
  const zombies = await resolveZombies(parseLsofRecords(out), async (p) => {
    const ino = inodes.get(p);
    if (ino === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return ino;
  });
  assert.deepEqual(zombies, [], 'each file is still at its path with its inode: nothing deleted is held');
});

/*
 * Review F3.1, F3.3, measured on this Mac with `lsof -w -F n` under no locale and under en_US.UTF-8 (both print
 * the same): every control byte but a backspace, tab, newline, form feed and carriage return is written as `^`
 * and the character 0x40 above it — 0x01 "^A", VT "^K", ESC "^[", 0x1c "^\", 0x1f "^_" — and a caret as
 * itself, so "^A" cannot be read back. 0x1c's "^\" even runs into the letter after it: "c\x1cb.txt" is
 * printed "c^\b.txt", which reads back as a caret and a backspace. Beside lsof's other escapes in one name
 * each byte is written as it is alone (measured too).
 */
const LSOF_CARET_RECORDED: readonly (readonly [lsofText: string, name: string])[] = [
  ['a^Ab.txt', 'a\x01b.txt'],
  ['vt^Kx.txt', 'vt\x0bx.txt'],
  ['esc^[z.txt', 'esc\x1bz.txt'],
  [String.raw`c^\b.txt`, 'c\x1cb.txt'],
  ['us^_x.txt', 'us\x1fx.txt'],
  [String.raw`mix^A\tz.txt`, 'mix\x01\tz.txt'],
  [String.raw`bk^A\\z.txt`, 'bk\x01\\z.txt'],
  [String.raw`dl^A\x7fz.txt`, 'dl\x01\x7fz.txt'],
  [String.raw`\xc3\xa9^[z.txt`, 'é\x1bz.txt'],
  [String.raw`fs^\\\z.txt`, 'fs\x1c\\z.txt'],
];
const ENOENT = (p: string): Error => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });

test('a held file whose name holds a control byte lsof writes as ^X is found in use — alone or inside a folder being deleted — and never reported as a deleted file still holding space (review F3.1, F3.3)', async () => {
  const dir = '/Users/me/f31';
  const lines = ['p53661', 'csleep'];
  LSOF_CARET_RECORDED.forEach(([written], i) => lines.push(`f${i + 3}`, 's1', `i${i + 10}`, `n${dir}/${written}`));
  lines.push('f99', 's1', 'i20', `n${dir}/d^Bir/inner.txt`);
  const records = parseLsofRecords(lines.join('\n'));
  const files = LSOF_CARET_RECORDED.map(([, name]) => `${dir}/${name}`);
  const folder = `${dir}/d\x02ir`;
  const held = lsof.intersectHandles(records, [...files, folder].map((f) => [f, f] as const));
  assert.deepEqual(held.map((h) => h.path), [...files, folder], 'each file, and the folder holding the last one, is found in use');

  // Every file is still at its own path with its inode; only lsof's spelling of it names nothing — or, for
  // "a^Ab.txt", another file: a real caret and an A, with another inode.
  const inodes = new Map<string, number>([...files.map((f, i) => [f, i + 10] as const), [`${folder}/inner.txt`, 20], [`${dir}/a^Ab.txt`, 999]]);
  const zombies = await resolveZombies(records, async (p) => {
    const ino = inodes.get(p);
    if (ino === undefined) throw ENOENT(p);
    return ino;
  });
  assert.deepEqual(zombies.map((z) => z.path), [], 'nobody deleted them: a ^X spelling that names nothing, or another file, is no proof');

  const marked = parseLsofRecords(['p9', 'cnode', 'f3', 's100', 'i42', 'n/tmp/a^Ab.bin (deleted)'].join('\n'));
  assert.deepEqual((await resolveZombies(marked, async (p) => { throw ENOENT(p); })).map((z) => z.path), ['/tmp/a^Ab.bin'],
    'control: lsof\'s own (deleted) marker is believed, whatever the name holds');
  const plain = parseLsofRecords(['p9', 'cnode', 'f3', 's100', 'i42', 'n/tmp/gone.bin'].join('\n'));
  assert.deepEqual((await resolveZombies(plain, async (p) => { throw ENOENT(p); })).map((z) => z.path), ['/tmp/gone.bin'],
    'control: a path with no caret that is gone is still a deleted file held');
});

test('B2/B5: a held file whose name holds a control byte lsof writes as ^X is found in use and not reported deleted (review F3.1, F3.3)', { skip: !IS_MAC }, async () => {
  const dir = await mkTmp();
  const fds: number[] = [];
  try {
    const folder = path.join(dir, 'd\x02ir');
    await fsp.mkdir(folder);
    const targets = [...LSOF_CARET_RECORDED.map(([, name]) => path.join(dir, name)), path.join(folder, 'inner.txt')];
    for (const t of targets) {
      await fsp.writeFile(t, 'x');
      fds.push(fs.openSync(t, 'r'));
    }
    const asked = [...targets.slice(0, -1), folder];
    const held = (await openHandlesFor(asked)).filter((h) => h.pid === process.pid);
    assert.deepEqual([...new Set(held.map((h) => h.path))].sort(), [...asked].sort(), 'every open file, and the folder holding one, is found in use');
    const zombies = (await lsof.zombieHandles()).filter((z) => z.path.includes(path.basename(dir)));
    assert.deepEqual(zombies, [], 'no file was deleted, so none is reported as held deleted space');
  } finally {
    for (const fd of fds) fs.closeSync(fd);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('B2/B5: under no locale, as the Dock starts TreeMap, a held file whose name lsof escapes is found in use and not reported deleted (review F2.1)', { skip: !IS_MAC }, async () => {
  const dir = await mkTmp();
  const saved = { ...process.env };
  const fds: number[] = [];
  try {
    const targets = [path.join(dir, 'Écran Partagé.txt'), path.join(dir, String.raw`back\slash.txt`)];
    for (const t of targets) {
      await fsp.writeFile(t, 'x');
      fds.push(fs.openSync(t, 'r'));
    }
    for (const k of Object.keys(process.env)) if (k === 'LANG' || k.startsWith('LC_')) delete process.env[k];
    const held = (await openHandlesFor(targets)).filter((h) => h.pid === process.pid);
    assert.deepEqual(held.map((h) => h.path).sort(), [...targets].sort(), 'both open files are found in use');
    const zombies = (await lsof.zombieHandles()).filter((z) => z.path.includes(path.basename(dir)));
    assert.deepEqual(zombies, [], 'neither file was deleted, so neither is reported as held deleted space');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    for (const fd of fds) fs.closeSync(fd);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the open-file check names its conflicts whole: openHandlesFor hands what it intersects to withFullProcessNames (H04)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'macos', 'lsofGuard.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export async function openHandlesFor('), src.indexOf('export function intersectHandles('));
  assert.match(fn, /return withFullProcessNames\(intersectHandles\(parseLsofRecords\(stdout\), resolved\)\);/,
    'every conflict the warning lists passes through the whole-name step');
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
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  });
  assert.equal(zombies.length, 1);
  assert.equal(zombies[0].bytes, 900);
});

test('resolveZombies stays silent when it cannot know — no inode, no claim', async () => {
  const records = parseLsofRecords(['p1', 'ca', 'f3', 'n/mystery.bin'].join('\n'));
  assert.deepEqual(await resolveZombies(records, async () => 5), []);
});

test('resolveZombies: a path TreeMap may not stat is unknown, never "deleted" (QA D17)', async () => {
  // Only "no such file" means gone. Permission denied under a root-only folder
  // says nothing about whether the file is still there.
  const records = parseLsofRecords(
    ['p1', 'ca', 'f3', 's500', 'i100', 'n/private/locked.bin', 'f4', 's900', 'i200', 'n/gone.bin', 'f5', 's300', 'i300', 'n/was-a-dir/x'].join('\n'),
  );
  const failWith = (code: string) => Object.assign(new Error(code), { code });
  const zombies = await resolveZombies(records, async (p) => {
    throw failWith(p === '/private/locked.bin' ? 'EACCES' : p === '/gone.bin' ? 'ENOENT' : 'ENOTDIR');
  });
  assert.deepEqual(zombies.map((z) => z.path), ['/gone.bin', '/was-a-dir/x'], 'permission denied is not deletion');
  assert.equal(zombies[0].ino, 200, 'the inode travels with the handle, so programs holding the same file can be matched');
});

test('the held-space probe counts the held files it could not decide — one whose place it may not look at, a name lsof\'s ^X leaves open — each once, and never a record with no inode (BQL item 11)', async () => {
  // The Held-up space panel said "Nothing is stuck" and Missing GB a measured 0 while every candidate was
  // skipped unseen: a stat refused (EPERM, as macOS answers under Library/Mail without Full Disk Access),
  // and a name holding carets. A record with no inode is not counted: lsof shows a handful on this Mac, all
  // where Unix sockets live, and they hold no space.
  const MAIL = '/Users/me/Library/Mail/V10/held.mbox';
  const records = parseLsofRecords([
    'p501', 'cMail',
    'f12', 's5242880', 'i2222', `n${MAIL}`,
    'f13', 's5242880', 'i2222', `n${MAIL}`, // the same file on another descriptor
    'f14', 's1048576', 'n/Users/me/tmp/noinode.bin',
    'f15', 's7340032', 'i1111', 'n/Users/me/logs/a^Ab^Bc^Cd^De^Ef.log', // five carets, and nothing at that spelling
    'f16', 's900', 'i3333', 'n/Users/me/tmp/gone.bin',
    'p502', 'cmdworker', 'f3', 's5242880', 'i2222', `n${MAIL}`, // another program holding the same file
  ].join('\n'));
  const scan = await lsof.resolveZombieScan(records, async (p) => {
    if (p.includes('/Library/Mail/')) throw Object.assign(new Error(`EPERM: operation not permitted, stat '${p}'`), { code: 'EPERM' });
    throw ENOENT(p);
  });
  assert.deepEqual(scan.handles.map((h) => h.path), ['/Users/me/tmp/gone.bin'], 'only the file shown gone is claimed');
  assert.equal(scan.undecided, 2, 'the Mail file, once however many descriptors and programs hold it, and the five-caret name');
  assert.deepEqual(await resolveZombies(records, async (p) => {
    if (p.includes('/Library/Mail/')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    throw ENOENT(p);
  }), scan.handles, 'resolveZombies answers the same handles');
});

/* BQL item 12: a held file whose name holds a caret, decided by every spelling lsof's text could be. */

test('lsofSpellings: every path lsof reads back as a text is among its spellings, and each spelling reads back as that text — every name of up to three characters from carets, letters, hex digits, backslashes and control bytes (BQL item 12)', () => {
  const chars = ['^', 'A', '1', 'x', 'b', '\\', '\x01', '\x1c', '\x08'];
  let names = [''];
  const all: string[] = [];
  for (let len = 1; len <= 3; len++) {
    names = names.flatMap((n) => chars.map((c) => n + c));
    all.push(...names);
  }
  for (const name of all) {
    const file = `/d/${name}.log`;
    const back = lsof.lsofReadBack(file);
    const spellings = lsof.lsofSpellings(back);
    assert.ok(spellings, `${JSON.stringify(back)} has spellings`);
    assert.ok(spellings.includes(file), `${JSON.stringify(file)}, read back as ${JSON.stringify(back)}, is among ${JSON.stringify(spellings)}`);
    for (const s of spellings) assert.equal(lsof.lsofReadBack(s), back, `${JSON.stringify(s)} reads back as ${JSON.stringify(back)}`);
  }
  assert.equal(all.length, 9 + 81 + 729);
  const sorted = (a: string[] | null) => (a ? [...a].sort() : a);
  assert.deepEqual(lsof.lsofSpellings('/x/plain.log'), ['/x/plain.log'], 'no caret: the text is the path');
  assert.deepEqual(sorted(lsof.lsofSpellings('/x/build^A.log')), ['/x/build\x01.log', '/x/build\x1cx41.log', '/x/build^A.log'],
    'a caret and an A, the control byte 0x01, or 0x1c running into "x41"');
  assert.deepEqual(sorted(lsof.lsofSpellings('/x/build^1.log')), ['/x/build\x1cx31.log', '/x/build^1.log'], '"^1" is no control byte, yet 0x1c and "x31" read back as it');
  assert.deepEqual(sorted(lsof.lsofSpellings('/x/n^J.log')), ['/x/n\x1cx4A.log', '/x/n\x1cx4a.log', '/x/n^J.log'], 'a newline is written \\n, never ^J');
  assert.equal(lsof.lsofSpellings('/x/a^Ab^Bc^Cd^De^E.log'), null, `more than ${lsof.LSOF_CARETS_TRIED} carets: more spellings than the guard tries`);
  assert.equal(lsof.LSOF_CARETS_TRIED, 4);
});

test('lsofSpellings: a name that ends in 0x1c — alone, or with the start of an escape after it — is among its own spellings, where nothing follows to finish the escape; and "^@" is never a NUL, which no name holds (BQL-a review F1.2)', () => {
  // lsof prints 0x1c as "^\\", and a run ending in that open backslash was accepted only where more text
  // followed it: at the end of the text, "/work/rep\\x1c" was never among the spellings of "/work/rep^\\", so a
  // file still in place there was claimed deleted.
  const chars = ['^', 'A', '1', 'x', 'b', '\\', '\x01', '\x1c', '\x08'];
  let names = [''];
  const all: string[] = [];
  for (let len = 1; len <= 3; len++) {
    names = names.flatMap((n) => chars.map((c) => n + c));
    all.push(...names);
  }
  for (const name of all) {
    const file = `/d/${name}`; // the name at the very end of lsof's text
    const back = lsof.lsofReadBack(file);
    const spellings = lsof.lsofSpellings(back);
    assert.ok(spellings, `${JSON.stringify(back)} has spellings`);
    assert.ok(spellings.includes(file), `${JSON.stringify(file)}, read back as ${JSON.stringify(back)}, is among ${JSON.stringify(spellings)}`);
    for (const s of spellings) assert.equal(lsof.lsofReadBack(s), back, `${JSON.stringify(s)} reads back as ${JSON.stringify(back)}`);
  }
  const sorted = (a: string[] | null) => (a ? [...a].sort() : a);
  assert.deepEqual(sorted(lsof.lsofSpellings('/work/rep^\\')), ['/work/rep\x1c', '/work/rep^\\'], 'the 0x1c the text ends in, or a caret and a backslash');
  assert.deepEqual(sorted(lsof.lsofSpellings('/work/rep^\\x4')),
    ['/work/rep\x1c\\x784', '/work/rep\x1cx4', '/work/rep\x1cx5Cx4', '/work/rep\x1cx5cx4', '/work/rep^\\x4'],
    'and with "x4", an escape nothing finishes, after it — 0x1c\'s backslash running into the rest, or not');
  assert.deepEqual(sorted(lsof.lsofSpellings('/work/notes^@v2.txt')), ['/work/notes\x1cx40v2.txt', '/work/notes^@v2.txt'],
    '"^@" is a caret and an @, or 0x1c running into "x40" — never a NUL, which no name holds');
});

test('a held file whose name ends in 0x1c, still in place, is in use — never claimed deleted; and a deleted one whose name holds "^@" is listed, never left undecided over a NUL spelling no file can have (BQL-a review F1.2)', async () => {
  const held = (p: string) => parseLsofRecords(['p77', 'crep', 'f9', 's7340032', 'i77', `n${p}`].join('\n'));
  const inPlace = await lsof.resolveZombieScan(held('/work/rep^\\'), async (p) => {
    if (p === '/work/rep\x1c') return 77;
    throw ENOENT(p);
  });
  assert.deepEqual([inPlace.handles, inPlace.undecided], [[], 0], 'its inode at its own name: in use, in place');
  const gone = await lsof.resolveZombieScan(held('/work/notes^@v2.txt'), async (p) => {
    // fs.stat refuses a path holding a NUL before it asks the system: not "no such file".
    if (p.includes('\0')) throw Object.assign(new TypeError('The argument \'path\' must be a string without null bytes'), { code: 'ERR_INVALID_ARG_VALUE' });
    throw ENOENT(p);
  });
  assert.deepEqual([gone.handles.map((h) => h.path), gone.undecided], [['/work/notes^@v2.txt'], 0], 'nothing at either of its spellings: deleted, and listed');
});

test('a held file whose name holds a caret is decided by every spelling lsof\'s text could be: none holding its inode and none unknown, it is deleted and listed; one holding its inode, in use; one that cannot be looked at, undecided (BQL item 12)', async () => {
  // It was never listed: lsof writes a control byte as ^X and a caret as itself, so a deleted build^1.log
  // (7.3 MB) read as "may be a file with a control byte in its name, still in place" and was skipped.
  const held = (p: string) => parseLsofRecords(['p77', 'cbuild', 'f9', 's7340032', 'i4242', `n${p}`].join('\n'));
  const at = (answers: Record<string, number | string>) => async (p: string) => {
    const a = answers[p];
    if (a === undefined) throw ENOENT(p);
    if (typeof a === 'string') throw Object.assign(new Error(`${a}: ${p}`), { code: a });
    return a;
  };
  const verdict = async (p: string, answers: Record<string, number | string>) => {
    const scan = await lsof.resolveZombieScan(held(p), at(answers));
    return [scan.handles.map((h) => [h.path, h.bytes]), scan.undecided];
  };
  assert.deepEqual(await verdict('/x/build^1.log', {}), [[['/x/build^1.log', 7340032]], 0], 'no spelling of it is there: deleted, and listed');
  assert.deepEqual(await verdict('/x/build^A.log', {}), [[['/x/build^A.log', 7340032]], 0], 'nor of build^A.log');
  assert.deepEqual(await verdict('/x/build^A.log', { '/x/build^A.log': 999 }), [[['/x/build^A.log', 7340032]], 0],
    'another file at the caret\'s spelling, none at the others: still deleted');
  assert.deepEqual(await verdict('/x/build^A.log', { '/x/build\x01.log': 4242 }), [[], 0], 'its inode at the control byte\'s spelling: in use, in place');
  assert.deepEqual(await verdict('/x/build^1.log', { '/x/build\x1cx31.log': 4242 }), [[], 0],
    'its inode at 0x1c\'s run-in spelling — which a caret-or-control-byte rule alone would have called deleted');
  assert.deepEqual(await verdict('/x/build^A.log', { '/x/build\x01.log': 'EPERM' }), [[], 1], 'a spelling that cannot be looked at: undecided, never claimed');
  assert.deepEqual(await verdict('/x/build^A.log', { '/x/build\x01.log': 'EPERM', '/x/build\x1cx41.log': 4242 }), [[], 0], 'unless another spelling holds its inode');
  assert.deepEqual(await verdict('/x/a^Ab^Bc^Cd^De^E.log', {}), [[], 1], 'five carets: more than it tries, so undecided');
  // The files of the F3.1/F3.3 recording, each in place: in use, and none left undecided.
  const dir = '/Users/me/f31';
  const lines = ['p53661', 'csleep'];
  LSOF_CARET_RECORDED.forEach(([written], i) => lines.push(`f${i + 3}`, 's1', `i${i + 10}`, `n${dir}/${written}`));
  const inodes = new Map<string, number>(LSOF_CARET_RECORDED.map(([, name], i) => [`${dir}/${name}`, i + 10] as const));
  const scan = await lsof.resolveZombieScan(parseLsofRecords(lines.join('\n')), async (p) => {
    const ino = inodes.get(p);
    if (ino === undefined) throw ENOENT(p);
    return ino;
  });
  assert.deepEqual([scan.handles, scan.undecided], [[], 0], 'every one found at one of its spellings');
});

test('the spellings of a caret path are worked out once per path, not once per descriptor — a program holding one file on 500 descriptors costs one search, however many carets (BQL-a review F1.3)', async () => {
  // The search is synchronous CPU work, a few milliseconds a path and more for odd names; it ran for every
  // record, and 500 descriptors on one four-caret path held the server's event loop for about two seconds.
  const FOUR = '/Users/me/Documents/a^b^c^d^e/file.txt';
  const lines = ['p88', 'cbrowser'];
  for (let fd = 3; fd < 503; fd++) lines.push(`f${String(fd)}`, 's10', 'i5150', `n${FOUR}`);
  lines.push('p89', 'chelper', 'f3', 's10', 'i5150', `n${FOUR}`, 'f4', 's20', 'i6161', 'n/x/build^1.log', 'f5', 's30', 'i7171', 'n/x/plain.log');
  const asked: string[] = [];
  const counting = (readBack: string) => {
    asked.push(readBack);
    return lsof.lsofSpellings(readBack);
  };
  const scan = await lsof.resolveZombieScan(parseLsofRecords(lines.join('\n')), async (p) => {
    if (p === FOUR) return 5150;
    throw ENOENT(p);
  }, counting);
  assert.deepEqual(asked, [FOUR, '/x/build^1.log'], 'each caret path once, across descriptors and programs; a path with no caret never');
  assert.deepEqual([scan.handles.map((h) => h.path).sort(), scan.undecided], [['/x/build^1.log', '/x/plain.log'], 0],
    'and the verdicts are the same: the four-caret file in place, the other two gone');
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
   * per-path implementation would run a thousand. That is what is asserted,
   * by counting the `lsof` runs (a ratio of two timings measured the runner
   * too), with the real figures recorded as a diagnostic so a regression in
   * absolute cost is still visible.
   */
  const dir = await mkTmp();
  try {
    const paths: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const p = path.join(dir, `f${String(i)}.bin`);
      await fsp.writeFile(p, 'x');
      paths.push(p);
    }
    const timed = async (batch: string[]): Promise<{ runs: number; ms: number }> => {
      const started = performance.now();
      const { runs } = await openFileEnumerationsDuring(() => openHandlesFor(batch));
      return { runs, ms: performance.now() - started };
    };
    const one = await timed([paths[0]]);
    const thousand = await timed(paths);

    t.diagnostic(`open-handle batch: 1 path ${one.ms.toFixed(0)}ms · 1,000 paths ${thousand.ms.toFixed(0)}ms`);
    assert.equal(one.runs, 1, 'one path: one lsof');
    assert.equal(thousand.runs, 1, 'a thousand paths: still one lsof, not one per path');
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
