import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileNode } from '../src/models/types';
import { pruneTree } from '../src/utils/pruneTree';

/**
 * pruneTree's two invariants are what let the UI consume a bounded tree
 * without ever showing something false:
 *   1. children present => children complete (never a half-empty folder),
 *      and never both `children` and `pruned`.
 *   2. sizes stay exact even where detail was withheld.
 * Everything here exists to hold those lines.
 */

function file(name: string, path: string, size: number): FileNode {
  return { name, path, size, type: 'file', modifiedAt: 0, isHidden: false };
}
function dir(name: string, path: string, children: FileNode[]): FileNode {
  return {
    name, path, type: 'dir', modifiedAt: 0, isHidden: false,
    size: children.reduce((s, c) => s + c.size, 0),
    children,
  };
}

/** Every node in a tree, flattened. */
function walk(n: FileNode, out: FileNode[] = []): FileNode[] {
  out.push(n);
  if (n.children) for (const c of n.children) walk(c, out);
  return out;
}

function indexByPath(n: FileNode): Map<string, FileNode> {
  return new Map(walk(n).map((x) => [x.path, x]));
}

/** A wide, deep tree: `branch` dirs per level, `files` files per dir. */
function bigTree(depth: number, branch: number, files: number): FileNode {
  let seq = 0;
  const build = (name: string, path: string, d: number): FileNode => {
    const kids: FileNode[] = [];
    for (let i = 0; i < files; i++) kids.push(file(`f${i}.bin`, `${path}/f${i}.bin`, ++seq));
    if (d > 0) for (let i = 0; i < branch; i++) kids.push(build(`d${i}`, `${path}/d${i}`, d - 1));
    return dir(name, path, kids);
  };
  return build('root', '/root', depth);
}

test('a tree that fits under the budget comes back whole and unmarked', () => {
  const src = bigTree(2, 2, 2);
  // An empty folder must survive a round trip intact — the empty-folder finder
  // reads exactly this, and `children: []` must not decay to `undefined`.
  (src.children as FileNode[]).push(dir('empty', '/root/empty', []));
  const total = walk(src).length;
  const r = pruneTree(src, { maxNodes: 10_000 });

  assert.equal(r.nodes, total);
  assert.equal(r.prunedDirs, 0);
  assert.equal(walk(r.root).length, total);
  assert.ok(walk(r.root).every((n) => !n.pruned), 'nothing should be marked pruned');
  assert.deepEqual(r.root, src, 'an unpruned result should match the source exactly');
});

test('invariant: a node never carries both children and pruned', () => {
  const src = bigTree(5, 3, 4);
  const r = pruneTree(src, { maxNodes: 200 });
  for (const n of walk(r.root)) {
    assert.ok(!(n.children && n.pruned), `${n.path} has both children and pruned`);
  }
});

test('invariant: if children are present they are COMPLETE (never a partial folder)', () => {
  const src = bigTree(5, 3, 4);
  const srcIndex = indexByPath(src);
  const r = pruneTree(src, { maxNodes: 200 });

  let checked = 0;
  for (const n of walk(r.root)) {
    if (!n.children) continue;
    const original = srcIndex.get(n.path);
    assert.ok(original, `${n.path} must exist in the source`);
    assert.deepEqual(
      n.children.map((c) => c.name).sort(),
      (original.children ?? []).map((c) => c.name).sort(),
      `${n.path} is missing children — a partial folder leaked through`,
    );
    checked++;
  }
  assert.ok(checked > 1, 'the test tree should have expanded several folders');
});

test('invariant: sizes stay exact even for pruned directories', () => {
  const src = bigTree(5, 3, 4);
  const srcIndex = indexByPath(src);
  const r = pruneTree(src, { maxNodes: 150 });

  let prunedSeen = 0;
  for (const n of walk(r.root)) {
    assert.equal(n.size, srcIndex.get(n.path)?.size, `${n.path} reports a size the scan disagrees with`);
    if (n.pruned) prunedSeen++;
  }
  assert.ok(prunedSeen > 0, 'this budget should have pruned something');
});

test('every pruned mark corresponds to a directory that really has children', () => {
  const src = bigTree(4, 3, 3);
  const srcIndex = indexByPath(src);
  const r = pruneTree(src, { maxNodes: 120 });

  const marked = walk(r.root).filter((n) => n.pruned);
  assert.equal(marked.length, r.prunedDirs, 'prunedDirs must match the marks in the tree');
  for (const n of marked) {
    const original = srcIndex.get(n.path);
    assert.ok(original?.children?.length, `${n.path} is marked pruned but has no children to withhold`);
  }
});

test('the budget is respected, overshooting by at most one directory fanout', () => {
  const branch = 3, files = 4;
  const maxFanout = branch + files;
  for (const budget of [1, 5, 50, 200, 1000]) {
    const r = pruneTree(bigTree(5, branch, files), { maxNodes: budget });
    assert.ok(
      r.nodes <= budget + maxFanout,
      `budget ${budget}: emitted ${r.nodes}, over the ${budget + maxFanout} ceiling`,
    );
    // The reported count must describe the tree actually returned — callers
    // size their budgets off this number.
    assert.equal(r.nodes, walk(r.root).length, `budget ${budget}: nodes count drifted from the tree`);
  }
});

test('maxNodes of 1 yields just the root, marked pruned', () => {
  const r = pruneTree(bigTree(3, 2, 2), { maxNodes: 1 });
  assert.equal(r.root.path, '/root');
  assert.equal(r.root.children, undefined);
  assert.equal(r.root.pruned, true);
  assert.equal(r.nodes, 1);
  assert.equal(r.prunedDirs, 1);
});

test('big directories are expanded before small ones', () => {
  // BIG is worth 1000 bytes, SMALL 3. The budget covers root + both children
  // + exactly one of their child lists — it must spend it on BIG.
  const big = dir('BIG', '/root/BIG', Array.from({ length: 10 }, (_, i) => file(`b${i}`, `/root/BIG/b${i}`, 100)));
  const small = dir('SMALL', '/root/SMALL', Array.from({ length: 10 }, (_, i) => file(`s${i}`, `/root/SMALL/s${i}`, 1)));
  const src = dir('root', '/root', [big, small]);

  const r = pruneTree(src, { maxNodes: 13 }); // 1 root + 2 dirs + 10 children
  const idx = indexByPath(r.root);

  assert.equal(idx.get('/root/BIG')?.children?.length, 10, 'BIG should be expanded');
  assert.equal(idx.get('/root/BIG')?.pruned, undefined);
  assert.equal(idx.get('/root/SMALL')?.children, undefined, 'SMALL should be withheld');
  assert.equal(idx.get('/root/SMALL')?.pruned, true);
  // ...and SMALL still tells the truth about its size.
  assert.equal(idx.get('/root/SMALL')?.size, 10);
});

test('an expanded container drills in like a directory', () => {
  const archive: FileNode = {
    name: 'a.zip', path: '/root/a.zip', size: 50, type: 'file', modifiedAt: 0, isHidden: false,
    container: 'zip',
    children: [
      { name: 'inner.txt', path: '/root/a.zip/inner.txt', size: 50, type: 'file', modifiedAt: 0, isHidden: false, virtual: true },
    ],
  };
  const src = dir('root', '/root', [archive]);

  const whole = pruneTree(src, { maxNodes: 100 });
  assert.equal(indexByPath(whole.root).get('/root/a.zip')?.children?.length, 1, 'container children should survive');

  const tight = pruneTree(src, { maxNodes: 2 });
  assert.equal(indexByPath(tight.root).get('/root/a.zip')?.pruned, true, 'a container is prunable like a dir');
});

test('an empty directory is never marked pruned', () => {
  const src = dir('root', '/root', [dir('empty', '/root/empty', []), file('a', '/root/a', 5)]);
  const r = pruneTree(src, { maxNodes: 1 });
  // Root itself gets withheld at this budget, so expand fully instead:
  const full = pruneTree(src, { maxNodes: 100 });
  const empty = indexByPath(full.root).get('/root/empty');
  assert.equal(empty?.pruned, undefined, 'an empty dir has nothing to withhold');
  assert.deepEqual(empty?.children, []);
  assert.equal(r.root.pruned, true);
});

test('the source tree is never mutated', () => {
  const src = bigTree(4, 3, 3);
  const before = JSON.stringify(src);
  pruneTree(src, { maxNodes: 40 });
  assert.equal(JSON.stringify(src), before, 'pruneTree must not touch the scan it was given');
});

test('a pruned tree is much cheaper to serialize than the source', () => {
  const src = bigTree(7, 3, 5); // a few thousand nodes
  const r = pruneTree(src, { maxNodes: 300 });
  assert.ok(
    JSON.stringify(r.root).length < JSON.stringify(src).length / 2,
    'pruning should meaningfully shrink the payload',
  );
});
