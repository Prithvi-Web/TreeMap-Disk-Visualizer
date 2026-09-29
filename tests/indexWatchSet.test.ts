import { test, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { isolatedDataDir, fileTempDir } from './fixtures/dataDir';
isolatedDataDir('treemap-index-watchset-data-');

import {
  buildIndex,
  getRoot,
  openIndex,
  closeIndex,
  deleteIndex,
  stopWatcher,
  stopAllWatchers,
} from '../src/services/indexEngine';
import {
  watchPath,
  onWatchSetChange,
  openWatches,
  setSharedStreamForTests,
  setWatchImplForTests,
  type WatchSetChange,
} from '../src/platform/watchRegistry';
import { ensureWatchSession, subscribe } from '../src/services/watcher';
import { PortableProvider } from '../src/platform/portable';
import { LinuxProvider } from '../src/platform/linux';
import type { FileNode, ScanResult } from '../src/models/types';

/**
 * The live index when the process's set of watches changes.
 *
 * On macOS every watch in a process shares one FSEventStream, rebuilt from
 * scratch whenever any watch attaches or closes, and a change made while it is
 * rebuilt is never reported — to the watches that stayed attached as much as
 * to the one that moved (src/platform/watchRegistry.ts has the evidence). A
 * root can therefore miss a change while its own watcher is attached and
 * healthy, and the index's founding rule is that such a root is `stale`, not
 * `ready`.
 *
 * Nothing here waits for the OS to deliver an event. Every watch-set change
 * is reported by the registry synchronously, inside the call that caused it,
 * so each test makes one change and counts what it did to each root. The
 * shared-stream behaviour is switched on and off explicitly, so the macOS
 * rule and the Windows/Linux one are both proven on every runner.
 */

after(() => {
  stopAllWatchers();
  closeIndex();
  setWatchImplForTests(null);
  setSharedStreamForTests(null);
});

/** A folder with one file and no subfolders, so no provider attaches anything after it returns. */
function flatRoot(): string {
  const dir = fileTempDir('tm-watchset-');
  fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(1000));
  return dir;
}

/** Leave the process with no watches and no roots, and the platform as it really is. */
function cleanUp(t: TestContext): void {
  t.after(() => {
    stopAllWatchers();
    deleteIndex();
    setSharedStreamForTests(null);
  });
}

/** Build live roots on a platform whose watches do not interfere, so the test starts from `ready`. */
async function liveRoots(n: number): Promise<string[]> {
  setSharedStreamForTests(false);
  const roots: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const dir = flatRoot();
    const root = await buildIndex(dir, { live: true });
    assert.equal(root.state, 'ready');
    assert.equal(root.live, true);
    roots.push(dir);
  }
  return roots;
}

/** Every watch-set change reported while `fn` runs. */
async function changesDuring(fn: () => unknown): Promise<WatchSetChange[]> {
  const seen: WatchSetChange[] = [];
  const off = onWatchSetChange((c) => seen.push(c));
  try {
    await fn();
  } finally {
    off();
  }
  return seen;
}

const state = (dir: string): string => getRoot(dir)!.state;

/* ════════════════════ macOS: one stream for every watch ════════════════════ */

test('on a platform whose watches share one stream, another watch starting or stopping leaves every other live root stale, and says why', async (t) => {
  cleanUp(t);
  const [a, b] = await liveRoots(2);
  const other = fileTempDir('tm-watchset-other-');
  setSharedStreamForTests(true);

  const lease = watchPath(other, { recursive: true, owner: 'test:other' }, () => {});
  for (const dir of [a, b]) {
    const root = getRoot(dir)!;
    assert.equal(root.state, 'stale', `${dir}: a watch attaching elsewhere interrupted this one too`);
    assert.match(root.staleReason ?? '', /another folder/, 'and the root says why, in words');
    assert.equal(root.live, true, 'it is still watched — it just can no longer be vouched for');
  }

  // Back to ready the only way there is — a rebuild — then the same for a close.
  setSharedStreamForTests(false);
  await buildIndex(a, { live: true });
  await buildIndex(b, { live: true });
  assert.deepEqual([state(a), state(b)], ['ready', 'ready']);
  setSharedStreamForTests(true);
  lease.close();
  assert.deepEqual([state(a), state(b)], ['stale', 'stale'], 'a watch closing elsewhere interrupts them just the same');
});

test('a root\'s own watch starting is that root\'s own business: it is ready, and the other live roots are stale', async (t) => {
  cleanUp(t);
  const [a] = await liveRoots(1);
  setSharedStreamForTests(true);

  const b = flatRoot();
  const built = await buildIndex(b, { live: true });
  // Its attach is where its watch begins. A change in the moment before that
  // watch is live is the gap every build has between reading a folder and
  // watching it — not an interruption of a watch that was running.
  assert.equal(built.state, 'ready', 'its own watch starting is not something it missed');
  assert.equal(built.staleReason, undefined, 'and a ready root carries no reason');
  assert.equal(state(a), 'stale', 'but its attaching rebuilt the stream the other root was on');
});

test('a root\'s own watch stopping leaves that root as it was, and the other live roots stale', async (t) => {
  cleanUp(t);
  const [a, b] = await liveRoots(2);
  setSharedStreamForTests(true);

  stopWatcher(b);
  const stopped = getRoot(b)!;
  assert.equal(stopped.state, 'ready', 'stopping its own watcher is not something this root missed');
  assert.equal(stopped.live, false, '`live` is what says it is no longer watched');
  assert.equal(stopped.staleReason, undefined);
  assert.equal(state(a), 'stale');
});

test('rebuilding a live root hands its OS watch over rather than closing it, so no other root goes stale', async (t) => {
  // Every scan the UI finishes rebuilds that folder's index. If a rebuild
  // closed the folder's watch and opened a new one, every scan would leave
  // every OTHER indexed folder amber.
  cleanUp(t);
  const [a, b] = await liveRoots(2);
  const watchesBefore = openWatches().length;
  setSharedStreamForTests(true);

  const changes = await changesDuring(() => buildIndex(b, { live: true }));
  assert.deepEqual(changes, [], 'no OS watch was closed or opened by the rebuild');
  assert.equal(openWatches().length, watchesBefore);
  const rebuilt = getRoot(b)!;
  assert.equal(rebuilt.state, 'ready');
  assert.equal(rebuilt.live, true, 'the rebuilt root is watched again');
  assert.equal(state(a), 'ready', 'and the other root was never interrupted');
});

/** A finished scan of `dir` — all that Live mode reads from one. */
const scanOf = (dir: string, scanId: string): ScanResult & { root: FileNode } =>
  ({
    scanId,
    rootPath: dir,
    root: { name: path.basename(dir), path: dir, size: 0, type: 'dir', children: [], modifiedAt: 0, isHidden: false },
  }) as unknown as ScanResult & { root: FileNode };

test(
  'Live mode on a folder the index already watches shares its watch, so turning it on and off leaves every root ready',
  // Sharing needs the same kind of watch. On Linux the index watches each
  // folder on its own (inotify has no recursive watch) and Live mode asks for
  // a recursive one, so they are two watches — which costs nothing there,
  // where watches do not share a stream.
  { skip: process.platform === 'linux' && 'the Linux index watches folder by folder, Live mode recursively; they cannot share, and there they need not' },
  async (t) => {
    cleanUp(t);
    const [a, b] = await liveRoots(2);
    setSharedStreamForTests(true);

    const onAndOff = await changesDuring(async () => {
      const session = await ensureWatchSession(scanOf(a, 'watchset-live-a'));
      subscribe(session, () => {})(); // the last listener leaving stops the session
    });
    assert.deepEqual(onAndOff, [], 'Live mode rode the index\'s own watch');
    assert.deepEqual([state(a), state(b)], ['ready', 'ready']);
  },
);

test('Live mode\'s watch of a folder nothing else watches is the registry\'s, and on macOS starting it interrupts every indexed root', async (t) => {
  cleanUp(t);
  const [a, b] = await liveRoots(2);
  setSharedStreamForTests(true);

  const elsewhere = fileTempDir('tm-watchset-live-');
  const session = await ensureWatchSession(scanOf(elsewhere, 'watchset-live-elsewhere'));
  const stop = subscribe(session, () => {});
  try {
    assert.ok(
      openWatches().some((w) => w.path === elsewhere && w.owners.includes('live:watchset-live-elsewhere')),
      'Live mode\'s watch is visible to the registry',
    );
    assert.deepEqual([state(a), state(b)], ['stale', 'stale'], 'and it starting interrupted both indexed roots');
  } finally {
    stop();
  }
});

/* ═════════════ Windows and Linux: a stream of its own per watch ═════════════ */

test('where every watch has a stream of its own, other watches starting and stopping leave every root ready', async (t) => {
  cleanUp(t);
  const [a, b] = await liveRoots(2);
  setSharedStreamForTests(false);

  const other = watchPath(fileTempDir('tm-watchset-other-'), { recursive: true, owner: 'test:other' }, () => {});
  other.close();
  stopWatcher(b);
  await buildIndex(flatRoot(), { live: true });
  assert.equal(state(a), 'ready', 'nothing another watch did could have cost this one an event');
  assert.equal(getRoot(a)!.live, true);
  assert.equal(state(b), 'ready');
});

test('where every watch has a stream of its own, a rebuild reopens its root\'s watch as it always did', async (t) => {
  // Holding a watch across a rebuild buys nothing where watches do not share
  // a stream, and reopening it is what replaces a watch the system dropped
  // without a word — inotify does, for a folder deleted and made again.
  cleanUp(t);
  const [, b] = await liveRoots(2);
  setSharedStreamForTests(false);

  const changes = await changesDuring(() => buildIndex(b, { live: true }));
  assert.deepEqual(
    changes.filter((c) => c.path === b).map((c) => `${c.kind} ${c.owners.join(',')}`),
    [`closed index:${b}`, `attached index:${b}`],
    'the rebuild closed its root\'s watch and opened a fresh one',
  );
  assert.equal(getRoot(b)!.live, true);
});

/* ═══════════════════════════ Any platform ═══════════════════════════ */

test('a root whose own watch the system ends is stale, and stops claiming to be live, on every platform', async (t) => {
  cleanUp(t);
  class FakeWatch extends EventEmitter {
    close(): void {}
  }
  const fakes = new Map<string, FakeWatch>();
  setWatchImplForTests((target) => {
    const w = new FakeWatch();
    fakes.set(target, w);
    return w;
  });
  t.after(() => setWatchImplForTests(null));
  setSharedStreamForTests(false); // not a shared-stream effect: the watch itself is gone

  const a = flatRoot();
  await buildIndex(a, { live: true });
  assert.ok(fakes.has(a), 'the root\'s watch went through the registry');
  fakes.get(a)!.emit('error', new Error('the stream could not be started'));

  const root = getRoot(a)!;
  assert.equal(root.state, 'stale', 'nothing will be reported for this root again');
  assert.match(root.staleReason ?? '', /stopped reporting/);
  assert.equal(root.live, false, 'and it no longer says it is watched');
});

test('a root that was stale when the index was opened says it was not watched while TreeMap was closed', async (t) => {
  cleanUp(t);
  const a = flatRoot();
  await buildIndex(a, { live: false });
  closeIndex();
  openIndex(); // what a relaunch does
  const root = getRoot(a)!;
  assert.equal(root.state, 'stale');
  assert.match(root.staleReason ?? '', /while TreeMap was closed/);
});

test('both providers take their watches from the registry, under the owner they were given', () => {
  // The base provider (macOS, Windows, and anything else) and the Linux one.
  // A watch opened straight through `fs.watch` is one the registry cannot
  // report — and on macOS, one that can silently cost every root an event.
  for (const [name, provider, recursive] of [
    ['base', new PortableProvider(), true],
    ['linux', new LinuxProvider(), false],
  ] as const) {
    const dir = flatRoot();
    const owner = `test:${name}`;
    const unsubscribe = provider.subscribeToChanges(dir, () => {}, owner);
    try {
      assert.deepEqual(
        openWatches().filter((w) => w.owners.includes(owner)).map((w) => ({ path: w.path, recursive: w.recursive })),
        [{ path: dir, recursive }],
        `the ${name} provider's watch on the root is the registry's`,
      );
    } finally {
      unsubscribe();
    }
    assert.equal(openWatches().filter((w) => w.owners.includes(owner)).length, 0, `and the ${name} provider lets go of it`);
  }
});
