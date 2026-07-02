import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileNode, WatchEvent } from '../src/models/types';
import { mergePending, capFrame, topLevelDirs } from '../src/services/watcher';

/** Pure-logic tests for the live-activity watcher (Live mode). */

test('mergePending accumulates growth into one honest delta', () => {
  const pending = new Map<string, WatchEvent>();
  // A file at 100 bytes grows three times within one flush window.
  mergePending(pending, '/r/f', 'modified', 150, 100);
  mergePending(pending, '/r/f', 'modified', 400, 150);
  mergePending(pending, '/r/f', 'modified', 900, 400);
  const e = pending.get('/r/f')!;
  assert.equal(e.delta, 800); // 900 − the 100 it started the second at
  assert.equal(e.size, 900);
  assert.equal(e.kind, 'modified');
});

test('mergePending: created then modified stays created', () => {
  const pending = new Map<string, WatchEvent>();
  mergePending(pending, '/r/new', 'created', 10, 0);
  mergePending(pending, '/r/new', 'modified', 500, 10);
  const e = pending.get('/r/new')!;
  assert.equal(e.kind, 'created');
  assert.equal(e.delta, 500);
});

test('mergePending: anything then deleted reads deleted with a negative delta', () => {
  const pending = new Map<string, WatchEvent>();
  mergePending(pending, '/r/f', 'modified', 600, 500);
  mergePending(pending, '/r/f', 'deleted', 0, 600);
  const e = pending.get('/r/f')!;
  assert.equal(e.kind, 'deleted');
  assert.equal(e.delta, -500);
  assert.equal(e.size, 0);
});

test('mergePending: deleted then re-created reads created', () => {
  const pending = new Map<string, WatchEvent>();
  mergePending(pending, '/r/f', 'deleted', 0, 300);
  mergePending(pending, '/r/f', 'created', 200, 0);
  const e = pending.get('/r/f')!;
  assert.equal(e.kind, 'created');
  assert.equal(e.delta, -100); // net vs the 300 bytes it had before the frame
});

test('capFrame keeps the most significant events', () => {
  const events: WatchEvent[] = [
    { path: '/a', kind: 'modified', delta: 5, size: 5 },
    { path: '/b', kind: 'modified', delta: -900, size: 0 },
    { path: '/c', kind: 'modified', delta: 100, size: 100 },
  ];
  const capped = capFrame(events, 2);
  assert.deepEqual(capped.map((e) => e.path), ['/b', '/c']);
  assert.equal(capFrame(events, 5).length, 3); // under the cap → untouched
});

function dir(p: string, children: FileNode[] = []): FileNode {
  return { name: p.split('/').pop() || p, path: p, size: 0, type: 'dir', children, modifiedAt: 0, isHidden: false };
}

test('topLevelDirs walks two levels and respects the watcher cap', () => {
  const root = dir('/r', [
    dir('/r/a', [dir('/r/a/x', [dir('/r/a/x/deep')]), dir('/r/a/y')]),
    dir('/r/b'),
  ]);
  const dirs = topLevelDirs(root, 2, 100);
  assert.deepEqual(dirs, ['/r', '/r/a', '/r/a/x', '/r/a/y', '/r/b']);
  assert.ok(!dirs.includes('/r/a/x/deep'), 'depth 3 stays unwatched');
  assert.equal(topLevelDirs(root, 2, 3).length, 3); // hard cap wins
});
