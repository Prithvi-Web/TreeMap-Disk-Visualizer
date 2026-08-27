import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileNode, WatchEvent } from '../src/models/types';
import { mergePending, capFrame, topLevelDirs } from '../src/services/watcher';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));

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

/* ══════════════ A session says how much it actually watched ══════════════ */

test('the top-level fallback list always includes the root, so it is never empty', () => {
  // Load-bearing for the zero-watcher case. `attachWatchers` falls back to
  // watching these directories one by one, and each attach is wrapped in a
  // swallowing catch — so "how many attached" is the only thing that
  // distinguishes a session watching nothing from a quiet disk.
  //
  // Because the root is always in this list, reaching zero requires the ROOT
  // itself to be unwatchable (permissions, or Linux's max_user_watches), not
  // merely a folder that happens to have no subdirectories. That is what makes
  // the zero case rare rather than routine, and it is worth pinning.
  const flat: FileNode = {
    name: 'flat', path: '/flat', size: 10, type: 'dir', modifiedAt: 0,
    children: [{ name: 'a.txt', path: '/flat/a.txt', size: 10, type: 'file', modifiedAt: 0 }],
  };
  assert.deepEqual(topLevelDirs(flat, 2, 50), ['/flat'], 'a folder of only files still yields the root');

  const nested: FileNode = {
    name: 'r', path: '/r', size: 10, type: 'dir', modifiedAt: 0,
    children: [
      { name: 'a', path: '/r/a', size: 5, type: 'dir', modifiedAt: 0, children: [] },
      { name: 'f.txt', path: '/r/f.txt', size: 5, type: 'file', modifiedAt: 0 },
    ],
  };
  assert.deepEqual(topLevelDirs(nested, 2, 50), ['/r', '/r/a'], 'directories join it; files never do');

  assert.deepEqual(topLevelDirs(nested, 2, 1), ['/r'], 'and the cap never drops the root');
});

test('the live stream tells the client how many watchers attached, with a reason at zero', () => {
  // §2.4 — unavailable is a first-class state carrying its reason, never a
  // blank that reads as "nothing is happening". `engine` names the strategy
  // that was TRIED, which is not the same claim.
  const routes = readFileSync(path.join(__dirname_, '..', 'src', 'api', 'watchRoutes.ts'), 'utf8');
  assert.match(routes, /watchers: watching/, 'the init frame carries the count');
  assert.match(routes, /watching === 0/, 'and branches on zero');
  assert.match(routes, /could not be watched for live changes/, 'with a reason the user can act on');

  const app = readFileSync(path.join(__dirname_, '..', 'public', 'index.html'), 'utf8');
  const init = app.slice(app.indexOf("if (frame.type === 'init')"), app.indexOf("} else if (frame.type === 'activity')"));
  assert.ok(init.length > 100, 'the init handler was located');
  assert.match(init, /frame\.watchers === 0/, 'the client checks it');
  assert.match(init, /disableLive/, 'and refuses Live rather than looking attentive');
});
