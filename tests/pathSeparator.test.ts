import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-pathSeparator-data-');

import { FileNode, SnapshotTreeNode } from '../src/models/types';
import { SIGNIFICANT_BYTES, significantChanges } from '../src/services/journal';
import { inflateSnapshotTree } from '../src/services/snapshots';
import { findNodeByPath } from '../src/utils/treemap';
import { ObjectScanStore, buildStoreFromTree } from '../src/services/scanStore';

/**
 * A path's separator is read off the path itself: "\" in a Windows path — a drive's or a share's —
 * and "/" in every other, a cloud identifier's included (POL item 7 review, F2.2).
 *
 * Six places on the server guessed it from `path.includes('\\')`. On macOS and Linux "\" is a
 * character a name may hold, so a scan, a snapshot or a cloud folder whose path held one anywhere —
 * "/data/a\b/proj" — had its children joined with "\": the journal named folders that do not exist,
 * Trends and Compare inflated snapshot trees under them, and a lookup by path missed nodes that were
 * there. missingGigabytes already read it this way; every place now does.
 */

const dir = (name: string, path: string, children: FileNode[] = []): FileNode =>
  ({ name, path, size: children.reduce((s, c) => s + c.size, 0), type: 'dir', modifiedAt: 0, isHidden: false, children });
const file = (name: string, path: string, size = 10): FileNode => ({ name, path, size, type: 'file', modifiedAt: 0, isHidden: false });

/** /data, the folder "a\b" in it and a file in that — and a folder below it, for a deeper lookup. */
function backslashTree(): FileNode {
  return dir('data', '/data', [
    dir('a\\b', '/data/a\\b', [file('f', '/data/a\\b/f'), dir('sub', '/data/a\\b/sub', [file('g', '/data/a\\b/sub/g')])]),
    dir('ok', '/data/ok', [file('h', '/data/ok/h')]),
  ]);
}

test('the journal joins a change’s path with the root’s own separator: "/" under a POSIX root that holds a backslash, "\\" under a drive or a share (POL item 7 review, F2.2)', () => {
  const grew = (rootName: string): { prev: SnapshotTreeNode; curr: SnapshotTreeNode } => ({
    prev: { n: rootName, s: 0, t: 1, c: [{ n: 'x', s: 0, t: 1 }] },
    curr: { n: rootName, s: SIGNIFICANT_BYTES * 2, t: 1, c: [{ n: 'x', s: SIGNIFICANT_BYTES * 2, t: 1 }] },
  });
  const at = (rootPath: string): string[] => {
    const { prev, curr } = grew('proj');
    return significantChanges(prev, curr, rootPath).map((c) => c.path);
  };
  assert.deepEqual({
    posixWithBackslash: at('/data/a\\b/proj'),
    posix: at('/data/proj'),
    drive: at('C:\\proj'),
    driveRoot: at('C:\\'),
    share: at('\\\\srv\\share\\proj'),
    cloud: at('cloud://gdrive/a\\b'),
  }, {
    posixWithBackslash: ['/data/a\\b/proj/x'],
    posix: ['/data/proj/x'],
    drive: ['C:\\proj\\x'],
    driveRoot: ['C:\\x'],
    share: ['\\\\srv\\share\\proj\\x'],
    cloud: ['cloud://gdrive/a\\b/x'],
  });
});

test('a stored snapshot tree is inflated under its root with the root’s own separator, so Trends and Compare draw "/data/a\\b/proj/x", not "/data/a\\b/proj\\x" (POL item 7 review, F2.2)', () => {
  const stored: SnapshotTreeNode = { n: 'proj', s: 10, t: 1, c: [{ n: 'x', s: 10, t: 1, c: [{ n: 'y', s: 10 }] }] };
  const paths = (rootPath: string): string[] => {
    const out: string[] = [];
    const walk = (n: FileNode): void => { out.push(n.path); n.children?.forEach(walk); };
    walk(inflateSnapshotTree(stored, rootPath, 0));
    return out;
  };
  assert.deepEqual({
    posixWithBackslash: paths('/data/a\\b/proj'),
    drive: paths('C:\\proj'),
    share: paths('\\\\srv\\share\\'),
  }, {
    posixWithBackslash: ['/data/a\\b/proj', '/data/a\\b/proj/x', '/data/a\\b/proj/x/y'],
    drive: ['C:\\proj', 'C:\\proj\\x', 'C:\\proj\\x\\y'],
    share: ['\\\\srv\\share\\', '\\\\srv\\share\\x', '\\\\srv\\share\\x\\y'],
  });
});

test('a node is found by its path inside a folder whose name holds a backslash — by findNodeByPath, by a store wrapped round a tree with or without its separator named, and by one packed from a tree — while a Windows tree is found as before (POL item 7 review, F2.2)', () => {
  const tree = backslashTree();
  const wrapped = ObjectScanStore.wrap(backslashTree());
  const wrappedWithSep = ObjectScanStore.wrap(backslashTree(), '/');
  const packed = buildStoreFromTree(backslashTree());
  const found = (store: { findByPath(p: string): number; path(id: number): string }, p: string): string | null => {
    const id = store.findByPath(p);
    return id === -1 ? null : store.path(id);
  };
  const targets = ['/data/a\\b', '/data/a\\b/f', '/data/a\\b/sub/g', '/data/ok/h'];
  // A scan or a cloud folder rooted at the folder itself: the root's path holds the backslash.
  const rooted = (): FileNode => dir('a\\b', '/data/a\\b', [file('f', '/data/a\\b/f'), dir('sub', '/data/a\\b/sub', [file('g', '/data/a\\b/sub/g')])]);
  const rootedTargets = ['/data/a\\b', '/data/a\\b/f', '/data/a\\b/sub', '/data/a\\b/sub/g'];
  const rootedWrapped = ObjectScanStore.wrap(rooted());
  const rootedPacked = buildStoreFromTree(rooted());
  assert.deepEqual({
    findNodeByPath: targets.map((p) => findNodeByPath(tree, p)?.path ?? null),
    wrapped: targets.map((p) => found(wrapped, p)),
    wrappedWithSep: targets.map((p) => found(wrappedWithSep, p)),
    packed: targets.map((p) => found(packed, p)),
    rootedWrapped: rootedTargets.map((p) => found(rootedWrapped, p)),
    rootedPacked: rootedTargets.map((p) => found(rootedPacked, p)),
    // A store's own separator, which it joins every child's path with.
    seps: [wrapped.sep, packed.sep, rootedWrapped.sep, rootedPacked.sep],
    // Not a separator: "/data/a" holds nothing of "a\b"'s.
    notInTheSibling: findNodeByPath(dir('data', '/data', [dir('a', '/data/a', [file('b', '/data/a/b')])]), '/data/a\\b'),
  }, {
    findNodeByPath: targets,
    wrapped: targets,
    wrappedWithSep: targets,
    packed: targets,
    rootedWrapped: rootedTargets,
    rootedPacked: rootedTargets,
    seps: ['/', '/', '/', '/'],
    notInTheSibling: null,
  });

  const windows = dir('C:\\', 'C:\\', [dir('a', 'C:\\a', [file('f', 'C:\\a\\f')])]);
  const share = dir('share', '\\\\srv\\share\\', [dir('a', '\\\\srv\\share\\a', [file('f', '\\\\srv\\share\\a\\f')])]);
  assert.deepEqual({
    drive: findNodeByPath(windows, 'C:\\a\\f')?.path ?? null,
    driveWrapped: found(ObjectScanStore.wrap(windows), 'C:\\a\\f'),
    drivePacked: found(buildStoreFromTree(dir('C:\\', 'C:\\', [dir('a', 'C:\\a', [file('f', 'C:\\a\\f')])])), 'C:\\a\\f'),
    share: findNodeByPath(share, '\\\\srv\\share\\a\\f')?.path ?? null,
    shareSep: ObjectScanStore.wrap(share).sep,
  }, {
    drive: 'C:\\a\\f',
    driveWrapped: 'C:\\a\\f',
    drivePacked: 'C:\\a\\f',
    share: '\\\\srv\\share\\a\\f',
    shareSep: '\\',
  });
});
