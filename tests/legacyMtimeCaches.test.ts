import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
const APP = isolatedDataDir('treemap-legacyMtimeCaches-data-');

import { dropLegacyMtimeCaches, LEGACY_MTIME_CACHE } from '../src/services/legacyMtimeCaches';
import { initPortableMode, isEphemeral, resetPortableMode } from '../src/services/portableMode';

/**
 * The U-4c review, F1.2: since U-4c L2 a fast-rescan cache is named
 * `mtime-cache-v2-<hash>.json`, and one under the old name is never read. Each
 * root ever scanned left one in app-data (up to tens of MB), which nothing
 * read, listed or removed. A completed scan now removes them
 * (tests/emptyFolders.test.ts holds the scan to it); here, exactly what is
 * removed: TreeMap's own old caches by their exact name, and nothing else.
 */

const names = (): string[] => fs.readdirSync(APP).sort();

test('only the old caches go: a regular file named exactly mtime-cache-<16 hex>.json, and nothing else in app-data', async () => {
  const keep = [
    'mtime-cache-v2-0123456789abcdef.json', // today's cache
    'mtime-cache-0123456789abcdef.json.tmp', // a write in progress, under the old name
    'mtime-cache-ABCDEF0123456789.json', // not a hash this build or an older one wrote (a hex hash is lower case)
    'mtime-cache-0123456789abcde.json', // one hex digit short
    'mtime-cache-0123456789abcdef0.json', // one long
    'settings.json',
    'snapshots.json',
  ];
  const old = ['mtime-cache-0123456789abcdef.json', 'mtime-cache-fedcba9876543210.json'];
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
  assert.deepEqual(names(), [...keep, folder, ...(linked ? [link] : [])].sort(), 'the two old caches went, and nothing else');
  assert.equal(fs.readFileSync(path.join(APP, folder, 'inside.txt'), 'utf8'), 'kept');
  assert.equal(fs.readFileSync(outside, 'utf8'), '{"kept":true}');
  assert.equal(dropped, 2, 'and it says how many');
  assert.equal(await dropLegacyMtimeCaches(), 0, 'once gone, nothing more');
  assert.ok(LEGACY_MTIME_CACHE.test('mtime-cache-0123456789abcdef.json'));
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

test('no app-data folder yet: nothing to remove, and no failure', async () => {
  const saved = process.env.TREEMAP_DATA_DIR;
  process.env.TREEMAP_DATA_DIR = path.join(fileTempDir('treemap-legacyMtimeCaches-none-'), 'never-made');
  try {
    assert.equal(await dropLegacyMtimeCaches(), 0);
  } finally {
    process.env.TREEMAP_DATA_DIR = saved;
  }
});
