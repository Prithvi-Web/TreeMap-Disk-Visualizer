import { test } from 'node:test';
import { skipOrFailOnCi } from './fixtures/ciSkip';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-duplicatePlaceholders-data-');

import { createScanRecord } from '../src/services/diskScanner';
import { getDuplicateJob, observeHashOpensForTests, observeNotHashedHeldForTests } from '../src/services/duplicateFinder';
import { PackedScanStore } from '../src/services/scanStore';
import { loadNative, resetNativeForTests, setNativeLoadOverrideForTests } from '../src/services/scan/native';
import { waitFor } from './fixtures/waitFor';
import type { DuplicateJob, ScanResult } from '../src/models/types';

/**
 * RISKS R1, the master prompt §3.2: hashing a file makes a sync client
 * download it, so a duplicate pass over iCloud Drive or OneDrive could pull
 * down hundreds of gigabytes onto the disk the user is emptying. A cloud
 * placeholder is never opened; neither is a symbolic link (which a read
 * follows — and a Windows cloud placeholder is a reparse point, which both
 * engines record as a link). What was not read because it would download is
 * reported, never silently dropped.
 */

const PAYLOAD = Buffer.alloc(8192, 7);

interface Built { scan: ScanResult; dir: string }

/** A scan of `dir` whose store says what each file is, over real files with the same bytes. */
function built(): Built {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-dupes-cloud-'));
  for (const name of ['a.dat', 'b.dat', 'cloud.dat', 'cloud-too.dat', 'online-only.dat']) fs.writeFileSync(path.join(dir, name), PAYLOAD);
  fs.symlinkSync(path.join(dir, 'a.dat'), path.join(dir, 'link.dat'));
  const scan = createScanRecord(dir);
  const store = new PackedScanStore(dir, path.sep, { name: path.basename(dir), isDir: true, size: 0, modifiedAt: 0, isHidden: false });
  const file = (name: string, extra: object = {}) =>
    store.addNode(store.rootId, { name, isDir: false, size: PAYLOAD.length, modifiedAt: 1, isHidden: false, ...extra });
  file('a.dat');
  file('b.dat');
  file('cloud.dat', { cloudPlaceholder: true, cloudProvider: 'icloud' });
  file('cloud-too.dat', { cloudPlaceholder: true });
  file('link.dat', { isSymlink: true });
  // The walk's exact flag, outside any known cloud folder: the ingest makes it
  // a placeholder too (nativeEngine.test.ts); here it is one without a provider.
  file('online-only.dat', { cloudPlaceholder: true });
  file('small-cloud.dat', { cloudPlaceholder: true, size: 10 });
  store.finalize();
  store.sumSizes();
  scan.store = store;
  scan.status = 'complete';
  return { scan, dir };
}

async function finished(job: DuplicateJob): Promise<DuplicateJob> {
  await waitFor(() => job.status !== 'running', 'the duplicate job finishing');
  assert.equal(job.status, 'complete', job.error);
  return job;
}

test('a cloud placeholder or a link is never opened; only real copies are hashed and grouped', async () => {
  const { scan, dir } = built();
  const opened: string[] = [];
  observeHashOpensForTests((file) => opened.push(path.basename(file)));
  try {
    const job = await finished(getDuplicateJob(scan, 1024));
    assert.deepEqual([...new Set(opened)].sort(), ['a.dat', 'b.dat'], 'only the two real copies were read');
    assert.deepEqual(job.groups?.map((g) => g.files.map((f) => path.basename(f.path)).sort()), [['a.dat', 'b.dat']]);
    assert.equal(job.totalReclaimable, PAYLOAD.length);
  } finally {
    observeHashOpensForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('what would have to download is reported: how many, how much, and the largest by name', async () => {
  const { scan, dir } = built();
  try {
    const job = await finished(getDuplicateJob(scan, 1024));
    assert.deepEqual(job.notHashed, {
      files: 3,
      bytes: 3 * PAYLOAD.length,
      largest: ['cloud-too.dat', 'cloud.dat', 'online-only.dat'].map((name) => ({ path: path.join(dir, name), size: PAYLOAD.length })),
    }, 'placeholders at or above the size the pass looks at; a link is not a file of its own, and a placeholder below the minimum would not have been read anyway');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Path order as the duplicate finder compares paths: JavaScript's `<`, which
 * compares UTF-16 code units. It is the same on every machine (no locale is
 * read), and it is the order the report already sorted its list by.
 */
const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A scan of an empty folder whose store holds only these cloud placeholders, added in this order. */
function placeholders(files: { name: string; size: number }[]): Built {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-not-hashed-'));
  const scan = createScanRecord(dir);
  const store = new PackedScanStore(dir, path.sep, { name: path.basename(dir), isDir: true, size: 0, modifiedAt: 0, isHidden: false });
  for (const { name, size } of files) {
    store.addNode(store.rootId, { name, isDir: false, size, modifiedAt: 1, isHidden: false, cloudPlaceholder: true });
  }
  store.finalize();
  store.sumSizes();
  scan.store = store;
  scan.status = 'complete';
  return { scan, dir };
}

test('the placeholders named among equal sizes are the smallest paths, whatever the store numbered them', async () => {
  // 22 names, added in reverse path order, so the lowest ids hold the
  // largest paths. The names also tell `<` apart from the other ways paths
  // get ordered: 'Z' before 'f' (a locale's collation puts it after), and
  // U+1F600 before U+FF5E (UTF-8 bytes and code points put it after).
  const names = ['Z.dat', ...Array.from({ length: 17 }, (_, i) => `f${String(i).padStart(2, '0')}.dat`), 'zz.dat', '\u{1F600}.dat', '\uFF5E.dat', '\uFF5E\uFF5E.dat'];
  const size = PAYLOAD.length;
  const { scan, dir } = placeholders([...names].sort(byPath).reverse().map((name) => ({ name, size })));
  try {
    const paths = names.map((name) => path.join(dir, name));
    const expected = [...paths].sort(byPath).slice(0, 20);
    const store = scan.store as PackedScanStore;
    const lowestIds = [...paths].sort((a, b) => store.findByPath(a) - store.findByPath(b)).slice(0, 20);
    const inLocaleOrder = [...paths].sort((a, b) => a.localeCompare(b)).slice(0, 20);
    const inByteOrder = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).slice(0, 20);
    for (const [other, which] of [[lowestIds, 'the 20 lowest ids'], [inLocaleOrder, 'localeCompare'], [inByteOrder, 'UTF-8 byte order']] as const) {
      assert.ok(expected.some((p) => !other.includes(p)), `the fixture tells path order apart from ${which}`);
    }

    const job = await finished(getDuplicateJob(scan, 1024));
    assert.equal(job.notHashed?.files, names.length);
    assert.equal(job.notHashed?.bytes, names.length * size);
    assert.deepEqual(job.notHashed?.largest, expected.map((p) => ({ path: p, size })));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bigger placeholders are named first, and a tie at the twentieth place goes to the smaller paths', async () => {
  const big = ['y0.dat', 'y1.dat', 'y2.dat'].map((name) => ({ name, size: 2 * PAYLOAD.length }));
  const tied = Array.from({ length: 22 }, (_, i) => ({ name: `m${String(i).padStart(2, '0')}.dat`, size: PAYLOAD.length }));
  // The tied ones first and in reverse path order, so ids favour their largest paths.
  const { scan, dir } = placeholders([...[...tied].reverse(), ...big]);
  try {
    const job = await finished(getDuplicateJob(scan, 1024));
    assert.deepEqual(
      job.notHashed?.largest,
      [...big, ...tied.slice(0, 17)].map(({ name, size }) => ({ path: path.join(dir, name), size })),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a placeholder too small to be named never has its path built', async () => {
  const big = Array.from({ length: 20 }, (_, i) => ({ name: `big${String(i).padStart(2, '0')}.dat`, size: 2 * PAYLOAD.length }));
  const small = Array.from({ length: 5 }, (_, i) => ({ name: `a-small${i}.dat`, size: PAYLOAD.length }));
  const { scan, dir } = placeholders([...small, ...big]);
  const store = scan.store as PackedScanStore;
  const built = store.path.bind(store);
  const asked: string[] = [];
  store.path = (id: number) => {
    const p = built(id);
    asked.push(path.basename(p));
    return p;
  };
  try {
    const job = await finished(getDuplicateJob(scan, 1024));
    assert.equal(job.notHashed?.files, 25);
    assert.deepEqual(job.notHashed?.largest.map((l) => path.basename(l.path)), big.map((b) => b.name));
    assert.deepEqual(asked.filter((name) => name.startsWith('a-small')), [], 'the five small ones were never needed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the twenty biggest placeholders are named, biggest first, when the walk meets them smallest first', async () => {
  // Every size differs, so no tie decides anything: only which twenty are
  // biggest does, and the walk meets the smallest first.
  for (const count of [21, 25, 40]) {
    const files = Array.from({ length: count }, (_, i) => ({ name: `p${String(i).padStart(2, '0')}.dat`, size: (i + 1) * PAYLOAD.length }));
    const { scan, dir } = placeholders(files);
    try {
      const expected = [...files].reverse().slice(0, 20);
      const store = scan.store as PackedScanStore;
      const walked: number[] = [];
      store.eachFile(store.rootId, (id) => walked.push(store.size(id)));
      assert.deepEqual(walked, files.map((f) => f.size), `with ${count}, the walk meets them in the order they were added`);

      const job = await finished(getDuplicateJob(scan, 1024));
      assert.equal(job.notHashed?.files, count);
      assert.equal(job.notHashed?.bytes, files.reduce((sum, f) => sum + f.size, 0));
      assert.deepEqual(job.notHashed?.largest, expected.map(({ name, size }) => ({ path: path.join(dir, name), size })), `with ${count}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a tie at the twentieth place is decided holding no more than twenty names at once', async () => {
  // Each tied placeholder's path is built to compare it; a name that cannot
  // make the list is dropped as soon as it is compared, not kept to the end.
  // The walk meets the tied ones smallest path last, then smallest path first,
  // so in the second a name arrives that loses to every name already held.
  const big = ['y0.dat', 'y1.dat', 'y2.dat'].map((name) => ({ name, size: 2 * PAYLOAD.length }));
  const tied = Array.from({ length: 100 }, (_, i) => ({ name: `m${String(i).padStart(3, '0')}.dat`, size: PAYLOAD.length }));
  for (const walkOrder of [[...tied].reverse(), tied]) {
    const { scan, dir } = placeholders([...walkOrder, ...big]);
    const held: number[] = [];
    observeNotHashedHeldForTests((n) => held.push(n));
    try {
      const store = scan.store as PackedScanStore;
      const walked: string[] = [];
      store.eachFile(store.rootId, (id) => walked.push(store.name(id)));
      assert.deepEqual(walked, [...walkOrder, ...big].map((f) => f.name), 'the walk meets them in the order they were added');

      const job = await finished(getDuplicateJob(scan, 1024));
      assert.equal(job.notHashed?.files, big.length + tied.length);
      assert.deepEqual(
        job.notHashed?.largest,
        [...big, ...tied.slice(0, 17)].map(({ name, size }) => ({ path: path.join(dir, name), size })),
      );
      assert.equal(held.length, big.length + tied.length, 'each placeholder at or above the twentieth size was considered once');
      assert.equal(Math.max(...held), 20, 'and no more than twenty names were held at once');
    } finally {
      observeNotHashedHeldForTests(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** A native module that answers `dataIsLocal` from `answer`, and nothing else. */
function standIn(answer?: (file: string) => number): void {
  resetNativeForTests();
  const mod: Record<string, unknown> = { version: () => '0.0.0-test' };
  if (answer) mod.dataIsLocal = (paths: string[]) => Uint8Array.from(paths.map(answer));
  setNativeLoadOverrideForTests({ path: '/stand-in/treemap_core.node', expectedVersion: '0.0.0-test', requireModule: () => mod });
}

function realNative(): void {
  setNativeLoadOverrideForTests(null);
  resetNativeForTests();
}

test('a file the scan saw as local that is online-only now is not read either: the pass asks just before it reads', async () => {
  // RISKS R71: a sync client can evict a file after its scan. The question
  // is asked of the directory entry (dataIsLocal), never by opening the file.
  const { scan, dir } = built();
  const opened: string[] = [];
  observeHashOpensForTests((file) => opened.push(path.basename(file)));
  standIn((file) => (path.basename(file) === 'b.dat' ? 0 : 1));
  try {
    const job = await finished(getDuplicateJob(scan, 1024));
    assert.ok(!opened.includes('b.dat'), `evicted since the scan, so never opened: ${opened.join(', ')}`);
    assert.deepEqual(job.groups, [], 'a.dat is left with no copy to compare');
    assert.equal(job.notHashed?.files, 4, 'the three placeholders and the evicted file');
    assert.equal(job.notHashed?.bytes, 4 * PAYLOAD.length);
    assert.ok(job.notHashed?.largest.some((l) => path.basename(l.path) === 'b.dat'), 'named with them');
  } finally {
    observeHashOpensForTests(null);
    realNative();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that cannot be asked about is not read; a module that cannot ask changes nothing', async () => {
  const unaskable = built();
  const opened: string[] = [];
  observeHashOpensForTests((file) => opened.push(path.basename(file)));
  standIn((file) => (path.basename(file) === 'b.dat' ? 2 : 1));
  try {
    const job = await finished(getDuplicateJob(unaskable.scan, 1024));
    assert.ok(!opened.includes('b.dat'), 'no answer is not a yes');
    assert.equal(job.notHashed?.files, 3, 'and it is not counted as a download either');
  } finally {
    fs.rmSync(unaskable.dir, { recursive: true, force: true });
  }
  const old = built();
  opened.length = 0;
  standIn();
  try {
    const job = await finished(getDuplicateJob(old.scan, 1024));
    assert.deepEqual([...new Set(opened)].sort(), ['a.dat', 'b.dat'], 'a module built before dataIsLocal: the scan’s flags alone decide, as before');
    assert.equal(job.groups?.length, 1);
  } finally {
    observeHashOpensForTests(null);
    realNative();
    fs.rmSync(old.dir, { recursive: true, force: true });
  }
});

test('the real module answers for a real file, a folder and a missing path', (t) => {
  // Every CI leg runs its own platform's way of asking: lstat's flags on
  // macOS, FindFirstFileExW on Windows, existence on Linux.
  realNative();
  const outcome = loadNative();
  if (!outcome.available) return skipOrFailOnCi(t, `no native module: ${outcome.reason}`);
  const ask = outcome.module.dataIsLocal;
  assert.equal(typeof ask, 'function', 'this build has dataIsLocal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-data-local-'));
  try {
    const file = path.join(dir, 'here.bin');
    fs.writeFileSync(file, 'on this disk');
    const answers = (ask as (paths: string[]) => Uint8Array)([file, dir, path.join(dir, 'missing.bin')]);
    assert.deepEqual(Array.from(answers), [1, 1, 2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
