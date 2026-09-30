import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('NTFS: simple upper case — a and A, ς and σ, ı and I are one; ß and ss, é and e + U+0301 are not; a trailing dot or space goes (FG3c #5)', () => {
  for (const [a, b] of [['a', 'A'], ['ς', 'σ'], ['ı', 'I'], ['name.', 'name'], ['name ', 'NAME']] as const) {
    assert.ok(!apart(ntfsNameKey, a, b), `${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  }
  for (const [a, b] of [['ß', 'ss'], ['é', 'é'], ['ｌ', 'l']] as const) {
    assert.ok(apart(ntfsNameKey, a, b), `${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  }
});

test('the key follows the platform and whether the destination folds case: case-sensitive keeps Lib and lib apart, and Linux compares exactly (FG3c #5)', () => {
  assert.ok(!apart(nameKeyFor('darwin', true), 'Lib', 'lib'));
  assert.ok(apart(nameKeyFor('darwin', false), 'Lib', 'lib'), 'a case-sensitive Mac volume');
  assert.ok(!apart(nameKeyFor('win32', true), 'Lib', 'lib'));
  assert.ok(apart(nameKeyFor('win32', false), 'Lib', 'lib'), 'a case-sensitive Windows folder');
  assert.ok(!apart(nameKeyFor('win32', false), 'lib.', 'lib'), 'where Win32 drops a trailing dot, whatever the case rule');
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
 * the volume keeps apart (it would refuse a tree the volume holds). About 34,000 names; counted.
 */
test('the APFS key agrees with this volume on every name with a case or form mapping (FG3c #5, #9)', {
  skip: process.platform === 'darwin' && FOLDS_CASE ? false : 'measured on a Mac volume that folds case',
}, () => {
  const dir = fileTempDir('treemap-volumeNames-oracle-');
  const names = new Set<string>();
  const add = (core: string): void => { if (core.length > 0 && !core.includes('/') && !core.includes('\0')) names.add(`q${core}q`); };
  for (let c = 0x20; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const s = String.fromCodePoint(c);
    if (s === '/' || s === ':' || s === '.') continue;
    if (s.toLowerCase() === s && s.toUpperCase() === s && s.normalize('NFD') === s && s.normalize('NFKC') === s) continue;
    for (const form of [s, apfsNameKey(s), s.toLowerCase(), s.toUpperCase(), s.normalize('NFD'), s.normalize('NFC'), s.normalize('NFKC')]) add(form);
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
  assert.ok(names.size > 30_000, `${names.size} names measured`);
  assert.deepEqual(under.slice(0, 5), [], `${under.length} names the volume reads as one have two keys`);
  assert.deepEqual(over.slice(0, 5), [], `${over.length} keys join names the volume keeps apart`);
});
