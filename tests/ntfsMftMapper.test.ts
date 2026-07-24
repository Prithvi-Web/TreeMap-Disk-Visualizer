import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseNtfsMftEdges,
  resolveTargetRecord,
  buildNtfsMftStoreFromEdges,
  ROOT_RECORD_NO,
} from '../src/services/ntfsMftMapper';
import { PackedScanStore } from '../src/services/scanStore';
import { FileNode } from '../src/models/types';

const ndjson = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'ntfs-mft-sample.ndjson'),
  'utf8',
);

function find(root: FileNode, name: string): FileNode | undefined {
  if (root.name === name) return root;
  for (const c of root.children ?? []) {
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

function buildFxTree(): { root: FileNode; stats: ReturnType<typeof buildNtfsMftStoreFromEdges>['stats'] } {
  const edges = parseNtfsMftEdges(ndjson);
  const target = resolveTargetRecord(edges, ['fx']);
  assert.notEqual(target, null, 'fx must resolve to a record number');
  const store = new PackedScanStore('C:\\fx', '\\', {
    name: 'fx',
    isDir: true,
    size: 0,
    modifiedAt: 1732000000000,
    isHidden: false,
  });
  const { stats } = buildNtfsMftStoreFromEdges(edges, target!, store, store.rootId);
  // prune() requires finalize() first (PackedScanStore.requireFinal()) — a
  // freshly addNode-populated store throws 'finalize() first' otherwise.
  store.finalize();
  store.sumSizes();
  const root = store.prune(store.rootId, { maxNodes: Number.MAX_SAFE_INTEGER }).root;
  return { root, stats };
}

test('resolveTargetRecord returns ROOT_RECORD_NO for an empty path (whole volume)', () => {
  const edges = parseNtfsMftEdges(ndjson);
  assert.equal(resolveTargetRecord(edges, []), ROOT_RECORD_NO);
});

test('resolveTargetRecord walks path components case-insensitively', () => {
  const edges = parseNtfsMftEdges(ndjson);
  assert.equal(resolveTargetRecord(edges, ['FX']), resolveTargetRecord(edges, ['fx']));
});

test('resolveTargetRecord returns null for a path that does not resolve', () => {
  const edges = parseNtfsMftEdges(ndjson);
  assert.equal(resolveTargetRecord(edges, ['fx', 'nope']), null);
});

test('sums sizes, deduping the genuine hardlink exactly once', () => {
  const { root } = buildFxTree();
  // .hidden 2 + a.txt 5 + sub(hardlink.txt 0 + b.log 3 + deep(c.dat 1)) + empty 0 + zero.bin 0 = 11
  assert.equal(root.size, 11);
  assert.equal(find(root, 'a.txt')!.size, 5, 'first occurrence keeps its size');
  assert.equal(find(root, 'hardlink.txt')!.size, 0, 'second occurrence is zeroed');
  assert.equal(find(root, 'hardlink.txt')!.hardlinkDuplicate, true);
});

test('reports hardlink counters', () => {
  const { stats } = buildFxTree();
  assert.equal(stats.hardlinkedFiles, 1);
  assert.equal(stats.hardlinkedBytes, 5);
});

test('counts files and dirs correctly', () => {
  const { stats } = buildFxTree();
  // .hidden, a.txt, hardlink.txt, b.log, c.dat, zero.bin
  assert.equal(stats.fileCount, 6);
  // sub, deep, empty — NOT fx itself: buildNtfsMftStoreFromEdges only counts
  // fx's DESCENDANTS. fx is the store's pre-existing root (created by
  // `new PackedScanStore(...)` above, not by this function), same reason
  // Task 4's orchestration does `scan.dirCount = stats.dirCount + 1` to
  // account for the root separately.
  assert.equal(stats.dirCount, 3);
});

test('keeps empty dirs as children: [] — the empty-folder finder depends on it', () => {
  const { root } = buildFxTree();
  assert.deepEqual(find(root, 'empty')!.children, []);
});

test('derives isHidden from a leading dot', () => {
  const { root } = buildFxTree();
  assert.equal(find(root, '.hidden')!.isHidden, true);
  assert.equal(find(root, 'a.txt')!.isHidden, false);
});
