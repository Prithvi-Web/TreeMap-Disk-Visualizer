import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mapGduTree } from '../src/services/gduMapper';
import { FileNode } from '../src/models/types';

/**
 * The mapper is built against RECORDED real gdu v5.36.1 output, because the
 * integration prompt described the schema wrongly in ways a hand-written
 * fixture would have faithfully preserved:
 *
 *  - a directory is [meta, ...children] (FLAT), not [meta, childrenArray].
 *    Their sample had one child per directory, which hides the difference.
 *  - directories carry no size at all; it must be summed here.
 *  - mtime is Unix SECONDS; FileNode.modifiedAt is milliseconds.
 *  - asize is OMITTED when zero (so `|| 0`, never `NaN`).
 *  - ino/hlnkc ARE emitted, so hardlink dedup is possible — and required, since
 *    naive counting runs 1.972% high on a real tree.
 *
 * The fixture covers: hidden file, zero-byte file, symlink, hard-link pair,
 * nested dirs, and an empty dir.
 */

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'gdu-v5.36.1.json'), 'utf8'),
);

function find(root: FileNode, name: string): FileNode | undefined {
  if (root.name === name) return root;
  for (const c of root.children ?? []) {
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

test('maps a flat [meta, ...children] directory, not [meta, childrenArray]', () => {
  const { root } = mapGduTree(fixture, '/fx');
  assert.equal(root.type, 'dir');
  assert.equal(root.name, 'fx');
  // 5 files/links + sub + empty = 7 direct children.
  // A [meta, childrenArray] reading — the prompt's claim — would see 1.
  assert.equal(root.children!.length, 7);
});

test('reconstructs full paths from the parent chain', () => {
  const { root } = mapGduTree(fixture, '/fx');
  assert.equal(find(root, 'c.dat')!.path, '/fx/sub/deep/c.dat');
  assert.equal(find(root, 'sub')!.path, '/fx/sub');
});

test('converts mtime from seconds to milliseconds', () => {
  const { root } = mapGduTree(fixture, '/fx');
  assert.equal(find(root, 'a.txt')!.modifiedAt, 1784255815 * 1000);
});

test('treats a missing asize as zero rather than NaN', () => {
  const { root } = mapGduTree(fixture, '/fx');
  const zero = find(root, 'zero.bin')!;
  assert.equal(zero.size, 0);
  assert.ok(!Number.isNaN(zero.size));
});

test('sums directory sizes, counting a hard-linked inode exactly once', () => {
  const { root } = mapGduTree(fixture, '/fx');
  // .hidden 2 + a.txt 5 + hardlink.txt 0 (same ino) + link.txt 5 + zero.bin 0
  // + sub(b.log 3 + deep(c.dat 1)) + empty 0 = 16
  assert.equal(root.size, 16);
  assert.equal(find(root, 'sub')!.size, 4);
  assert.equal(find(root, 'deep')!.size, 1);
});

test('zeroes the second hard link and flags it, keeping the first intact', () => {
  const { root } = mapGduTree(fixture, '/fx');
  assert.equal(find(root, 'a.txt')!.size, 5);
  assert.equal(find(root, 'a.txt')!.hardlinkDuplicate, undefined);
  assert.equal(find(root, 'hardlink.txt')!.size, 0);
  assert.equal(find(root, 'hardlink.txt')!.hardlinkDuplicate, true);
});

test('reports hardlink counters for the scan record', () => {
  const { stats } = mapGduTree(fixture, '/fx');
  assert.equal(stats.hardlinkedFiles, 1);
  assert.equal(stats.hardlinkedBytes, 5);
});

test('shares the inode set across shards so dedup spans the whole scan', () => {
  const seenInodes = new Set<number>();
  const first = mapGduTree(fixture, '/fx', { seenInodes });
  // Same tree mapped again as if it were a second shard: every hard-linked
  // inode is already known, so nothing is counted twice.
  const second = mapGduTree(fixture, '/fx2', { seenInodes });
  assert.equal(first.stats.hardlinkedFiles, 1);
  assert.equal(second.stats.hardlinkedFiles, 2, 'both links are dupes the 2nd time');
  assert.equal(second.root.size, 11, '16 minus the 5 now attributed to shard 1');
});

test('flags a symlink via notreg and never gives it children', () => {
  const { root } = mapGduTree(fixture, '/fx');
  const link = find(root, 'link.txt')!;
  assert.equal(link.isSymlink, true);
  assert.equal(link.type, 'file');
  assert.equal(link.children, undefined);
});

test('keeps empty dirs as children: [] — the empty-folder finder depends on it', () => {
  const { root } = mapGduTree(fixture, '/fx');
  const empty = find(root, 'empty')!;
  assert.equal(empty.type, 'dir');
  assert.deepEqual(empty.children, []);
});

test('derives isHidden and extension without path.extname', () => {
  const { root } = mapGduTree(fixture, '/fx');
  assert.equal(find(root, '.hidden')!.isHidden, true);
  // A leading dot is not an extension — matches path.extname('.hidden') === ''
  assert.equal(find(root, '.hidden')!.extension, undefined);
  assert.equal(find(root, 'b.log')!.extension, 'log');
  assert.equal(find(root, 'a.txt')!.isHidden, false);
});

test('counts files and dirs for the scan record', () => {
  const { stats } = mapGduTree(fixture, '/fx');
  // .hidden a.txt hardlink.txt link.txt zero.bin b.log c.dat
  assert.equal(stats.fileCount, 7);
  // /fx sub deep empty
  assert.equal(stats.dirCount, 4);
});

test('detects a cloud placeholder: logical size but no disk blocks', () => {
  // gdu omits dsize when it is zero, which is the stub signature. Gate on a
  // known cloud folder so sparse files (VM images, DBs) are never mislabelled.
  const doc = [1, 2, {}, [
    { name: '/Users/x/Library/Mobile Documents', mtime: 1 },
    { name: 'stub.psd', asize: 900, mtime: 1 },              // no dsize -> stub
    { name: 'real.psd', asize: 900, dsize: 4096, mtime: 1 }, // on disk
  ]];
  const { root, stats } = mapGduTree(doc, '/Users/x/Library/Mobile Documents', {
    cloudProviderFor: (p) => (/Mobile Documents/.test(p) ? 'icloud' : undefined),
  });
  const stub = find(root, 'stub.psd')!;
  assert.equal(stub.cloudPlaceholder, true);
  assert.equal(stub.cloudProvider, 'icloud');
  assert.equal(find(root, 'real.psd')!.cloudPlaceholder, undefined);
  assert.equal(stats.cloudFiles, 1);
  assert.equal(stats.cloudBytes, 900);
});

test('never labels a sparse file outside a cloud folder as a placeholder', () => {
  const doc = [1, 2, {}, [
    { name: '/data', mtime: 1 },
    { name: 'vm.img', asize: 5_000_000, mtime: 1 }, // sparse, not cloud
  ]];
  const { root, stats } = mapGduTree(doc, '/data', { cloudProviderFor: () => undefined });
  assert.equal(find(root, 'vm.img')!.cloudPlaceholder, undefined);
  assert.equal(stats.cloudFiles, 0);
});
