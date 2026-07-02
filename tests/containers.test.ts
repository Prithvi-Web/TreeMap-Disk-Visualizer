import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseZipCentralDirectory, TarWalker } from '../src/utils/archive';
import { entriesToChildren, parseBsdtarListing } from '../src/services/containerScanner';
import { detectContainerKind } from '../src/utils/containerKind';

/** Container drill-down: parser and grafting tests on hand-crafted bytes. */

/* ---------- zip central directory ---------- */

/** Build one central-directory entry record by hand. */
function cdEntry(name: string, uncompressedSize: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const rec = Buffer.alloc(46 + nameBuf.length);
  rec.writeUInt32LE(0x02014b50, 0); // signature
  rec.writeUInt32LE(uncompressedSize, 24);
  rec.writeUInt16LE(nameBuf.length, 28);
  nameBuf.copy(rec, 46);
  return rec;
}

test('zip: central directory entries parse with names, sizes and dir flags', () => {
  const cd = Buffer.concat([
    cdEntry('docs/report.pdf', 5_000_000),
    cdEntry('docs/', 0),
    cdEntry('readme.txt', 1234),
  ]);
  const { entries, truncated } = parseZipCentralDirectory(cd, 3);
  assert.equal(truncated, false);
  assert.deepEqual(entries.map((e) => [e.path, e.size, e.dir]), [
    ['docs/report.pdf', 5_000_000, false],
    ['docs', 0, true],
    ['readme.txt', 1234, false],
  ]);
});

test('zip: a corrupt record stops parsing instead of inventing entries', () => {
  const cd = Buffer.concat([cdEntry('ok.bin', 10), Buffer.from('garbagegarbagegarbage')]);
  const { entries } = parseZipCentralDirectory(cd, 5);
  assert.equal(entries.length, 1);
});

/* ---------- tar headers ---------- */

/** Build a 512-byte tar header block. */
function tarHeader(name: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write(size.toString(8).padStart(11, '0') + ' ', 124, 12, 'ascii');
  block.write(type, 156, 1, 'ascii');
  block.write('ustar', 257, 'ascii');
  return block;
}

function tarData(content: string | Buffer): Buffer {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const padded = Buffer.alloc(Math.ceil(buf.length / 512) * 512);
  buf.copy(padded);
  return padded;
}

test('tar: files, dirs and data-skipping parse from crafted blocks', () => {
  const w = new TarWalker();
  w.write(Buffer.concat([
    tarHeader('src/', 0, '5'),
    tarHeader('src/main.c', 1300, '0'),
    tarData('x'.repeat(1300)),
    tarHeader('big.bin', 600_000, '0'),
    tarData(Buffer.alloc(600_000)),
    Buffer.alloc(1024), // end-of-archive
  ]));
  assert.deepEqual(w.entries.map((e) => [e.path, e.size, e.dir]), [
    ['src', 0, true],
    ['src/main.c', 1300, false],
    ['big.bin', 600_000, false],
  ]);
});

test('tar: GNU longname applies to the following entry', () => {
  const longName = 'deep/'.repeat(30) + 'file-with-a-very-long-path.dat';
  const w = new TarWalker();
  w.write(Buffer.concat([
    tarHeader('././@LongLink', longName.length, 'L'),
    tarData(longName),
    tarHeader('ignored-short-name', 42, '0'),
    tarData(Buffer.alloc(42)),
  ]));
  assert.equal(w.entries.length, 1);
  assert.equal(w.entries[0].path, longName);
  assert.equal(w.entries[0].size, 42);
});

test('tar: chunked writes across block boundaries still parse', () => {
  const whole = Buffer.concat([
    tarHeader('a.txt', 700, '0'),
    tarData(Buffer.alloc(700)),
    tarHeader('b.txt', 10, '0'),
    tarData(Buffer.alloc(10)),
  ]);
  const w = new TarWalker();
  for (let i = 0; i < whole.length; i += 100) w.write(whole.subarray(i, i + 100));
  assert.deepEqual(w.entries.map((e) => e.path), ['a.txt', 'b.txt']);
});

/* ---------- grafting ---------- */

test('entriesToChildren scales sizes so the subtree never outweighs the archive', () => {
  const entries = [
    { path: 'a/big.mov', size: 800, dir: false },
    { path: 'a/small.txt', size: 200, dir: false },
  ];
  // 1000 logical bytes inside a 100-byte archive → 10× down-scale.
  const { children } = entriesToChildren(entries, '/r/x.zip', 100, 0);
  const a = children.find((c) => c.name === 'a')!;
  assert.equal(a.type, 'dir');
  assert.equal(a.virtual, true);
  const big = a.children!.find((c) => c.name === 'big.mov')!;
  assert.equal(big.size, 80);
  assert.equal(big.logicalSize, 800); // the honest uncompressed size survives
  const total = children.reduce((s, c) => s + c.size, 0);
  assert.ok(total <= 100, `scaled total ${total} must fit the archive`);
});

test('entriesToChildren keeps unscaled sizes when they already fit', () => {
  const { children } = entriesToChildren([{ path: 'x.bin', size: 40, dir: false }], '/r/a.zip', 100, 0);
  assert.equal(children[0].size, 40);
  assert.equal(children[0].logicalSize, undefined);
});

test('entriesToChildren rejects escape attempts and absolute paths', () => {
  const { children, entryCount } = entriesToChildren([
    { path: '../../etc/passwd', size: 10, dir: false },
    { path: '/abs/path', size: 10, dir: false },
    { path: 'ok.txt', size: 10, dir: false },
  ], '/r/a.zip', 1000, 0);
  assert.equal(entryCount, 1);
  assert.equal(children.length, 1);
  assert.equal(children[0].name, 'ok.txt');
});

/* ---------- bsdtar listing + kind detection ---------- */

test('bsdtar listing lines parse into entries', () => {
  const out = [
    '-rw-r--r--  0 root   root   1048576 Jan  1  2024 files/movie.mp4',
    'drwxr-xr-x  0 root   root         0 Jan  1  2024 files/',
    'lrwxrwxrwx  0 root   root         0 Jan  1  2024 link -> target',
    'not a listing line',
  ].join('\n');
  const { entries } = parseBsdtarListing(out);
  assert.deepEqual(entries.map((e) => [e.path, e.size, e.dir]), [
    ['files/movie.mp4', 1048576, false],
    ['files', 0, true],
  ]);
});

test('detectContainerKind maps names to reader kinds', () => {
  assert.equal(detectContainerKind('app.zip', false), 'zip');
  assert.equal(detectContainerKind('lib.JAR', false), 'zip');
  assert.equal(detectContainerKind('backup.tar.gz', false), 'tgz');
  assert.equal(detectContainerKind('backup.tgz', false), 'tgz');
  assert.equal(detectContainerKind('data.tar', false), 'tar');
  assert.equal(detectContainerKind('ubuntu.iso', false), 'iso');
  assert.equal(detectContainerKind('installer.dmg', false), 'dmg');
  assert.equal(detectContainerKind('Docker.raw', false), 'docker');
  assert.equal(detectContainerKind('Photos Library.photoslibrary', true), 'photos');
  assert.equal(detectContainerKind('Photos Library.photoslibrary', false), undefined);
  assert.equal(detectContainerKind('notes.txt', false), undefined);
  assert.equal(detectContainerKind('regular-folder', true), undefined);
});
