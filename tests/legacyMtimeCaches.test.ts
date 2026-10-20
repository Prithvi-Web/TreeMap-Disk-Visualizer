import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
const APP = isolatedDataDir('treemap-legacyMtimeCaches-data-');

import { dropLegacyMtimeCaches, LEGACY_MTIME_CACHE } from '../src/services/legacyMtimeCaches';
import { initPortableMode, isEphemeral, resetPortableMode } from '../src/services/portableMode';

/**
 * The U-4c review, F1.2: since U-4c L2 a fast-rescan cache's name carries its
 * format, and one of an older format is never read: the unversioned
 * `mtime-cache-<hash>.json`, and since BQL item 8 format 2,
 * `mtime-cache-v2-<hash>.json` (it can spell a name that begins with U+FEFF
 * without the mark). Each root ever scanned left one in app-data (up to tens
 * of MB), which nothing read, listed or removed. A completed scan now removes
 * them (tests/emptyFolders.test.ts and tests/incrementalRescan.test.ts hold the
 * scan to it); here, exactly what is removed: TreeMap's own old caches by their
 * exact name, and nothing else.
 */

const names = (): string[] => fs.readdirSync(APP).sort();

test('only the old caches go: a regular file named exactly mtime-cache-<16 hex>.json or mtime-cache-v2-<16 hex>.json, and nothing else in app-data', async () => {
  const keep = [
    'mtime-cache-v3-0123456789abcdef.json', // today's cache (format 3, BQL item 8)
    'mtime-cache-0123456789abcdef.json.tmp', // a write in progress, under the old name
    'mtime-cache-v2-0123456789abcdef.json.tmp', // and under format 2's
    'mtime-cache-v2-0123456789abcde.json', // format 2's name one hex digit short
    'mtime-cache-v4-0123456789abcdef.json', // a later format: not this build's to remove
    'mtime-cache-ABCDEF0123456789.json', // not a hash this build or an older one wrote (a hex hash is lower case)
    'mtime-cache-0123456789abcde.json', // one hex digit short
    'mtime-cache-0123456789abcdef0.json', // one long
    'settings.json',
    'snapshots.json',
  ];
  const old = ['mtime-cache-0123456789abcdef.json', 'mtime-cache-fedcba9876543210.json', 'mtime-cache-v2-0123456789abcdef.json', 'mtime-cache-v2-fedcba9876543210.json'];
  for (const name of [...keep, ...old]) fs.writeFileSync(path.join(APP, name), '{}');
  // A folder under an old cache's name, holding a file: not a cache, and never removed.
  const folder = 'mtime-cache-1111111111111111.json';
  fs.mkdirSync(path.join(APP, folder));
  fs.writeFileSync(path.join(APP, folder, 'inside.txt'), 'kept');
  // A link under an old cache's name: not TreeMap's file; what it points at is never touched.
  const outside = path.join(fileTempDir('treemap-legacyMtimeCaches-outside-'), 'target.json');
  fs.writeFileSync(outside, '{"kept":true}');
  const link = 'mtime-cache-2222222222222222.json';
  let linked = true;
  try {
    fs.symlinkSync(outside, path.join(APP, link));
  } catch {
    linked = false; // Windows without the right to make links
  }
  const dropped = await dropLegacyMtimeCaches();
  assert.deepEqual(names(), [...keep, folder, ...(linked ? [link] : [])].sort(), 'the four old caches went, and nothing else');
  assert.equal(fs.readFileSync(path.join(APP, folder, 'inside.txt'), 'utf8'), 'kept');
  assert.equal(fs.readFileSync(outside, 'utf8'), '{"kept":true}');
  assert.equal(dropped, 4, 'and it says how many');
  assert.equal(await dropLegacyMtimeCaches(), 0, 'once gone, nothing more');
  assert.ok(LEGACY_MTIME_CACHE.test('mtime-cache-0123456789abcdef.json'));
  assert.ok(LEGACY_MTIME_CACHE.test('mtime-cache-v2-0123456789abcdef.json'), 'format 2 is an old cache now (BQL item 8)');
  assert.ok(!LEGACY_MTIME_CACHE.test('mtime-cache-v3-0123456789abcdef.json'), 'and format 3 is the one this build reads');
});

test('a read-only portable session removes nothing: its app-data is not TreeMap\'s to touch', async () => {
  const old = path.join(APP, 'mtime-cache-3333333333333333.json');
  fs.writeFileSync(old, '{}');
  // Read-only as the D3 tests make one: the data folder inside a regular file, so every OS refuses it.
  // process.env still names APP, so a removal that did not ask would take `old`.
  const blocker = path.join(fileTempDir('treemap-legacyMtimeCaches-ro-'), 'not-a-folder');
  fs.writeFileSync(blocker, 'x');
  resetPortableMode();
  initPortableMode({ TREEMAP_PORTABLE: '1', TREEMAP_DATA_DIR: path.join(blocker, 'data') } as NodeJS.ProcessEnv);
  try {
    assert.equal(isEphemeral(), true, 'the session really is read-only');
    assert.equal(await dropLegacyMtimeCaches(), 0);
    assert.equal(fs.existsSync(old), true, 'left where it is');
  } finally {
    resetPortableMode();
    initPortableMode({ TREEMAP_DATA_DIR: APP } as NodeJS.ProcessEnv);
  }
  assert.equal(await dropLegacyMtimeCaches(), 1, 'and removed once the session may write');
});

test('a cache that cannot be removed stays, unread, and the others still go: the removal never rejects (the U-4c review, F2.6)', async () => {
  // An antivirus lock or a read-only attribute refuses one removal. The scan's tracked write
  // swallows a rejection silently, so one that threw would leave every later old cache in place on every scan.
  const old = ['mtime-cache-4444444444444444.json', 'mtime-cache-5555555555555555.json', 'mtime-cache-6666666666666666.json'];
  for (const name of old) fs.writeFileSync(path.join(APP, name), '{}');
  const real = fs.promises.unlink;
  let refused = '';
  // The first removal asked for is refused, whichever file the listing names first.
  (fs.promises as { unlink: unknown }).unlink = function (p: fs.PathLike) {
    if (!refused) {
      refused = path.basename(String(p));
      return Promise.reject(Object.assign(new Error(`EACCES: permission denied, unlink '${String(p)}'`), { code: 'EACCES', errno: -13, syscall: 'unlink', path: String(p) }));
    }
    return real.call(fs.promises, p);
  };
  let dropped: number;
  try {
    dropped = await dropLegacyMtimeCaches();
  } finally {
    (fs.promises as { unlink: unknown }).unlink = real;
  }
  assert.ok(old.includes(refused), `a removal was refused (${refused})`);
  assert.deepEqual(names().filter((n) => old.includes(n)), [refused], 'the refused one stays, and the other two went');
  assert.equal(dropped, 2, 'and it counts only what it removed');
  assert.equal(await dropLegacyMtimeCaches(), 1, 'once the refusal is gone, the next scan removes it');
});

test('no app-data folder yet: nothing to remove, and no failure', async () => {
  const saved = process.env.TREEMAP_DATA_DIR;
  process.env.TREEMAP_DATA_DIR = path.join(fileTempDir('treemap-legacyMtimeCaches-none-'), 'never-made');
  try {
    assert.equal(await dropLegacyMtimeCaches(), 0);
  } finally {
    process.env.TREEMAP_DATA_DIR = saved;
  }
});
