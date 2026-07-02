import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileNode } from '../src/models/types';
import { buildSnapshotTree, inflateSnapshotTree, closestSnapshot } from '../src/services/snapshots';

/** Unit tests for the time-slider snapshot-tree logic (pure functions). */

function dir(p: string, name: string, children: FileNode[]): FileNode {
  return {
    name,
    path: p,
    size: children.reduce((s, c) => s + c.size, 0),
    type: 'dir',
    children,
    modifiedAt: 0,
    isHidden: false,
  };
}

function file(p: string, name: string, size: number): FileNode {
  return { name, path: p, size, type: 'file', modifiedAt: 0, isHidden: false };
}

test('buildSnapshotTree keeps parent sizes truthful when children are dropped', () => {
  // 40 files of 1 byte in one dir: only the largest 30 are stored, but the
  // dir's own stored size must stay 40.
  const files = Array.from({ length: 40 }, (_, i) => file(`/r/d/f${i}`, `f${i}`, 1));
  const root = dir('/r', 'r', [dir('/r/d', 'd', files)]);
  const tree = buildSnapshotTree(root);
  assert.equal(tree.s, 40);
  const d = tree.c![0];
  assert.equal(d.s, 40);
  assert.equal(d.c!.length, 30);
});

test('buildSnapshotTree stays within its byte budget on a wide tree', () => {
  // 60 dirs × 60 long-named files would blow 100 KB at full fidelity.
  const dirs = Array.from({ length: 60 }, (_, i) =>
    dir(`/r/dir${i}`, `directory-with-a-fairly-long-name-${i}`,
      Array.from({ length: 60 }, (_, j) =>
        file(`/r/dir${i}/f${j}`, `file-with-a-fairly-long-name-${i}-${j}.bin`, 1000 + j)))
  );
  const root = dir('/r', 'r', dirs);
  const tree = buildSnapshotTree(root);
  assert.ok(JSON.stringify(tree).length <= 100_000, 'serialized tree fits the budget');
  assert.equal(tree.s, root.size, 'root size preserved');
});

test('buildSnapshotTree caps depth at 3 levels', () => {
  const deep = dir('/r', 'r', [
    dir('/r/a', 'a', [
      dir('/r/a/b', 'b', [
        dir('/r/a/b/c', 'c', [file('/r/a/b/c/f', 'f', 5)]),
      ]),
    ]),
  ]);
  const tree = buildSnapshotTree(deep);
  const a = tree.c![0];
  const b = a.c![0];
  const c = b.c![0];
  assert.equal(c.n, 'c');
  assert.equal(c.s, 5); // still carries its full size…
  assert.equal(c.c, undefined); // …but stores no children past level 3
});

test('inflateSnapshotTree rebuilds paths and stamps the snapshot time', () => {
  const root = dir('/Users/t/Music', 'Music', [
    dir('/Users/t/Music/Beatles', 'Beatles', [file('/Users/t/Music/Beatles/help.mp3', 'help.mp3', 9)]),
  ]);
  const inflated = inflateSnapshotTree(buildSnapshotTree(root), '/Users/t/Music', 1234);
  assert.equal(inflated.path, '/Users/t/Music');
  assert.equal(inflated.children![0].path, '/Users/t/Music/Beatles');
  assert.equal(inflated.children![0].children![0].path, '/Users/t/Music/Beatles/help.mp3');
  assert.equal(inflated.children![0].children![0].type, 'file');
  assert.equal(inflated.modifiedAt, 1234);
});

test('inflateSnapshotTree uses backslashes for Windows roots', () => {
  const root = dir('C:\\Data', 'Data', [file('C:\\Data\\x.bin', 'x.bin', 3)]);
  const inflated = inflateSnapshotTree(buildSnapshotTree(root), 'C:\\Data', 1);
  assert.equal(inflated.children![0].path, 'C:\\Data\\x.bin');
});

test('closestSnapshot picks the nearest takenAt in either direction', () => {
  const snaps = [{ takenAt: 100 }, { takenAt: 200 }, { takenAt: 400 }];
  assert.equal(closestSnapshot(snaps, 0)!.takenAt, 100);
  assert.equal(closestSnapshot(snaps, 240)!.takenAt, 200);
  assert.equal(closestSnapshot(snaps, 320)!.takenAt, 400);
  assert.equal(closestSnapshot(snaps, 9999)!.takenAt, 400);
  assert.equal(closestSnapshot([], 5), null);
});
