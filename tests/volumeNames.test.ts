import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-volumeNames-data-');

import { apfsNameKey, foldsCaseAt, nameKeyFor, ntfsNameKey } from '../src/utils/volumeNames';
import { manifestRefusal } from '../src/services/timeCapsule';
import { ABSENT, UNKNOWN, type Identity } from '../src/utils/placeIdentity';

/**
 * FG3c (#5, #9): a restore's early link check compares names the way the destination's volume
 * does. FG3b's key folded compatibility forms (NFKC) on every Mac volume, so it refused trees APFS
 * holds — a link `ｌｉｂ` beside a folder `lib`, `lib` beside `Lib` on a case-sensitive volume — and
 * stranded the only copy; and it missed `ẞ`, which APFS reads as `ß` and `ss`.
 */

/** Whether this file's temp volume reads `a` and `A` as one name. */
const FOLDS_CASE = ((): boolean => {
  const dir = fileTempDir('treemap-volumeNames-probe-');
  fs.writeFileSync(path.join(dir, 'probe'), '');
  return fs.existsSync(path.join(dir, 'PROBE'));
})();

const apart = (key: (n: string) => string, a: string, b: string): boolean => key(a) !== key(b);

test('APFS: one key for names default APFS reads as one — case, Unicode forms, ß, ẞ and ss, ς and σ, ﬁ and fi (FG3c #9)', () => {
  const same: [string, string][] = [
    ['a', 'A'], ['é', 'é'], ['ας', 'ασ'], ['straße', 'strasse'],
    ['ẞ', 'ss'], ['ẞ', 'ß'], ['ﬁ', 'fi'], ['Ϊ́', 'ΐ'], ['İ', 'i̇'],
  ];
  for (const [a, b] of same) assert.ok(!apart(apfsNameKey, a, b), `${JSON.stringify(a)} and ${JSON.stringify(b)} are one name on APFS`);
});

test('APFS: two keys for names APFS keeps apart — compatibility forms and dotless ı (FG3c #5)', () => {
  const different: [string, string][] = [
    ['ｌｉｂ', 'lib'], ['²', '2'], ['ı', 'i'], ['ı', 'I'], ['𝐀', 'A'], ['①', '1'],
  ];
  for (const [a, b] of different) assert.ok(apart(apfsNameKey, a, b), `${JSON.stringify(a)} and ${JSON.stringify(b)} are two names on APFS`);
});

test('NTFS: a model that folds only what every NTFS table folds — the ASCII letters; every other pair, and a trailing dot or space, compared exactly (FG3c #5, FG3d #16)', () => {
  for (const [a, b] of [['a', 'A'], ['Lib', 'LIB'], ['readme.md', 'README.MD'], ['q-z_0', 'Q-Z_0']] as const) {
    assert.ok(!apart(ntfsNameKey, a, b), `${JSON.stringify(a)} and ${JSON.stringify(b)} are one name to every NTFS table`);
  }
  // Pairs the table Windows 7 and later write keeps apart though Unicode upper-cases one to the
  // other (ı, ς, ſ, µ); pairs it may join (é and É) are kept apart too: folding less than the
  // volume is the safe side, since the restore makes links last. And Node reaches `name.` exactly.
  const exact: [string, string][] = [
    ['\u0131', 'I'], ['\u03c2', '\u03c3'], ['\u017f', 'S'], ['\u00b5', '\u03bc'], ['\u00e9', '\u00c9'], ['\u00df', 'ss'],
    ['\u00e9', 'e\u0301'], ['\uff4c', 'l'], ['name.', 'name'], ['name ', 'NAME'],
  ];
  for (const [a, b] of exact) assert.ok(apart(ntfsNameKey, a, b), `${JSON.stringify(a)} and ${JSON.stringify(b)} are compared exactly`);
});

test('the key follows the platform and whether the destination folds case: case-sensitive keeps Lib and lib apart, and Linux compares exactly (FG3c #5)', () => {
  assert.ok(!apart(nameKeyFor('darwin', true), 'Lib', 'lib'));
  assert.ok(apart(nameKeyFor('darwin', false), 'Lib', 'lib'), 'a case-sensitive Mac volume');
  assert.ok(!apart(nameKeyFor('win32', true), 'Lib', 'lib'));
  assert.ok(apart(nameKeyFor('win32', false), 'Lib', 'lib'), 'a case-sensitive Windows folder');
  assert.ok(apart(nameKeyFor('win32', false), 'lib.', 'lib'), 'a trailing dot is part of the name: Node reaches it exactly, as the restore does (FG3d #16)');
  assert.ok(apart(nameKeyFor('linux', true), 'Lib', 'lib'), 'Linux: exact; a folding mount relies on links being made last');
});

test('a link beside a folder of another case is refused early only where the destination folds case (FG3c #5)', () => {
  const manifest = {
    originalPath: path.resolve('/x/proj'), name: 'proj',
    members: [
      { rel: '', kind: 'dir', size: 0, hash: '' },
      { rel: 'lib', kind: 'symlink', size: 3, hash: 'h', target: 'Lib' },
      { rel: 'Lib', kind: 'dir', size: 0, hash: '' },
      { rel: path.join('Lib', 'x'), kind: 'file', size: 1, hash: 'h' },
    ],
  } as unknown as Parameters<typeof manifestRefusal>[0];
  assert.equal(manifestRefusal(manifest, undefined, nameKeyFor('darwin', false)), null, 'a case-sensitive volume holds both');
  assert.match(manifestRefusal(manifest, undefined, nameKeyFor('darwin', true)) ?? '', /past a link/, 'a folding one reads them as one');
});

/** A stand-in disk: identities by path; any other path is absent. */
const lookIn = (ids: Record<string, Identity>) => async (p: string): Promise<Identity> => ids[path.resolve(p)] ?? ABSENT;

test('whether a destination folds case is read from the disk: the nearest folder named with a letter, looked up in another case (FG3c #5)', async () => {
  const place = path.resolve('/stand/In/place');
  const folding = lookIn({ [place]: '1:7', [path.resolve('/stand/In/Place')]: '1:7' });
  assert.equal(await foldsCaseAt(place, folding), true, 'another case leads to the same folder');
  assert.equal(await foldsCaseAt(path.join(place, 'not-made-yet'), folding), true, 'a folder not made yet is judged by the one above');
  assert.equal(await foldsCaseAt(place, lookIn({ [place]: '1:7' })), false, 'another case leads nowhere');
  assert.equal(await foldsCaseAt(place, lookIn({ [place]: '1:7', [path.resolve('/stand/In/Place')]: '1:8' })), false, 'another case is another folder');
  const blind = async (p: string): Promise<Identity> => (path.resolve(p) === place ? '1:7' : UNKNOWN);
  assert.equal(await foldsCaseAt(place, blind), null, 'a look that fails tells nothing, and nothing above tells either');
  assert.equal(await foldsCaseAt(path.resolve('/1/2'), lookIn({})), null, 'no folder with a letter: nothing to tell by');
});

test('on this machine, the probe agrees with the temp volume (FG3c #5)', async () => {
  assert.equal(await foldsCaseAt(fileTempDir('treemap-volumeNames-real-')), FOLDS_CASE);
});

/**
 * The key measured against the volume itself (FG3c): one empty file per name — every code point
 * with a case, normalization or compatibility mapping, between two letters, and each of its
 * mappings — made with 'wx', so a name the volume already holds under another spelling fails
 * EEXIST and native realpath names the spelling it holds. No two names the volume reads as one may
 * have two keys (the early check would pass what the volume merges), and no key may join two names
 * the volume keeps apart (it would refuse a tree the volume holds). Counted.
 *
 * The blocks are the long-settled ones every finding's case lives in (Latin, Greek and its
 * dialytika forms, Cyrillic, Armenian, ẞ, letterlike and enclosed letters, ligatures, fullwidth,
 * mathematical letters): the candidates come from this Node's Unicode tables and the folding from
 * the running macOS, so a script added to Unicode lately could set the two apart for reasons of
 * version alone. Every code point, measured on the Mac this was written on, gave the same answer
 * (FG3c STATUS, apfs-oracle).
 */
const SETTLED_BLOCKS: [number, number][] = [
  [0x20, 0x58f], [0x1e00, 0x1fff], [0x2100, 0x218f], [0x2460, 0x24ff], [0xfb00, 0xfb4f], [0xff00, 0xffef], [0x1d400, 0x1d7ff],
];

/**
 * The file system a path is on, from a macOS mount table (`mount`'s lines, "<device> on <mount
 * point> (<type>, …)"): the type of the longest mount point holding it, or null (FG3d #15). The sweep
 * below measures APFS's own table, so it runs only on APFS: a temp folder on HFS+, exFAT, FAT or SMB
 * folds case too, by another table (HFS+ keeps ß and ss apart), and would fail for that alone.
 */
function fileSystemOf(real: string, mountTable: string): string | null {
  let best: { at: string; type: string } | null = null;
  for (const line of mountTable.split('\n')) {
    const m = / on (.+?) \(([^,)]+)/.exec(line);
    if (m === null) continue;
    const [, at, type] = m;
    const holds = real === at || real.startsWith(at.endsWith('/') ? at : `${at}/`);
    if (holds && (best === null || at.length > best.at.length)) best = { at, type };
  }
  return best?.type ?? null;
}

test('the mount table names the file system of the longest mount point holding a path (FG3d #15)', () => {
  const table = [
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    '/dev/disk4s2 on /Volumes/Old Drive (hfs, local, nodev, nosuid, journaled)',
    '/dev/disk5s1 on /Volumes/USB (exfat, local, nodev, nosuid, noowners)',
  ].join('\n');
  assert.equal(fileSystemOf('/private/var/folders/x/T', table), 'apfs');
  assert.equal(fileSystemOf('/Volumes/Old Drive/tmp', table), 'hfs', 'a mount point with a space in its name');
  assert.equal(fileSystemOf('/Volumes/USB', table), 'exfat', 'the mount point itself');
  assert.equal(fileSystemOf('/Volumes/USBX/tmp', table), 'apfs', 'a name that only starts like a mount point is not on it');
  assert.equal(fileSystemOf('/x', ''), null);
});

/** This file's temp volume's file system, on a Mac: 'apfs', 'hfs', … or null when it cannot be told. */
const TEMP_FILE_SYSTEM = ((): string | null => {
  if (process.platform !== 'darwin') return null;
  try {
    return fileSystemOf(fs.realpathSync.native(fileTempDir('treemap-volumeNames-fs-probe-')), execFileSync('/sbin/mount', [], { encoding: 'utf8' }));
  } catch {
    return null;
  }
})();

test('the APFS key agrees with this volume on every name with a case or form mapping (FG3c #5, #9)', {
  skip: process.platform !== 'darwin' ? 'measured on a Mac'
    : !FOLDS_CASE ? 'this Mac\u2019s temp volume keeps a and A apart'
      : TEMP_FILE_SYSTEM !== 'apfs' ? `the temp volume is ${TEMP_FILE_SYSTEM ?? 'of a kind the mount table does not name'}, not APFS, and folds names by its own table`
        : false,
}, () => {
  const dir = fileTempDir('treemap-volumeNames-oracle-');
  const names = new Set<string>();
  const add = (core: string): void => { if (core.length > 0 && !core.includes('/') && !core.includes('\0')) names.add(`q${core}q`); };
  for (const [from, to] of SETTLED_BLOCKS) {
    for (let c = from; c <= to; c++) {
      const s = String.fromCodePoint(c);
      if (s === '/' || s === ':' || s === '.') continue;
      if (s.toLowerCase() === s && s.toUpperCase() === s && s.normalize('NFD') === s && s.normalize('NFKC') === s) continue;
      for (const form of [s, apfsNameKey(s), s.toLowerCase(), s.toUpperCase(), s.normalize('NFD'), s.normalize('NFC'), s.normalize('NFKC')]) add(form);
    }
  }
  const root = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (root.get(r) !== r) r = root.get(r) as string; return r; };
  const byNfd = new Map<string, string>();
  for (const name of names) {
    root.set(name, name);
    const p = path.join(dir, name);
    try {
      fs.closeSync(fs.openSync(p, 'wx'));
      byNfd.set(name.normalize('NFD'), name);
    } catch (err) {
      assert.equal((err as NodeJS.ErrnoException).code, 'EEXIST', `the volume refused ${JSON.stringify(name)}`);
      const stored = path.basename(fs.realpathSync.native(p));
      const held = root.has(stored) ? stored : byNfd.get(stored.normalize('NFD'));
      assert.ok(held !== undefined, `the spelling the volume holds for ${JSON.stringify(name)} was made here`);
      root.set(find(name), find(held));
    }
  }
  const under: string[] = [];
  const classesOfKey = new Map<string, Set<string>>();
  for (const name of names) {
    const r = find(name);
    if (apfsNameKey(name) !== apfsNameKey(r)) under.push(`${name} / ${r}`);
    const k = apfsNameKey(name);
    if (!classesOfKey.has(k)) classesOfKey.set(k, new Set());
    classesOfKey.get(k)?.add(r);
  }
  const over = [...classesOfKey].filter(([, classes]) => classes.size > 1).map(([k, classes]) => `${k}: ${[...classes].join(' / ')}`);
  assert.ok(names.size > 4_000, `${names.size} names measured`);
  assert.deepEqual(under.slice(0, 5), [], `${under.length} names the volume reads as one have two keys`);
  assert.deepEqual(over.slice(0, 5), [], `${over.length} keys join names the volume keeps apart`);
});
