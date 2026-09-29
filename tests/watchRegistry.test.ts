import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-watch-registry-data-');

import {
  watchPath,
  holdWatchesOf,
  onWatchSetChange,
  openWatches,
  streamIsSharedOn,
  setWatchImplForTests,
  type WatchSetChange,
} from '../src/platform/watchRegistry';

/**
 * The watch registry — the one place in the process that attaches or closes an
 * OS file watch, and the one that says when the set of watches changed.
 *
 * Every test here runs against a stand-in for `fs.watch`, so what is counted
 * is exactly how many OS watches the registry asked for and closed: no event
 * delivery, no timing, and the same answer on all three platforms.
 */

class FakeWatch extends EventEmitter {
  closes = 0;
  constructor(
    readonly target: string,
    readonly recursive: boolean,
    readonly deliver: (eventType: string, filename: string | null) => void,
  ) {
    super();
  }
  close(): void {
    this.closes += 1;
  }
}

const made: FakeWatch[] = [];
const refused = new Set<string>();
setWatchImplForTests((target, opts, listener) => {
  if (refused.has(target)) throw Object.assign(new Error(`EACCES: watch ${target}`), { code: 'EACCES' });
  const w = new FakeWatch(target, opts.recursive, listener);
  made.push(w);
  return w;
});
after(() => setWatchImplForTests(null));

/** Every watch-set change reported while `fn` runs. */
function changesDuring(fn: () => void): WatchSetChange[] {
  const seen: WatchSetChange[] = [];
  const off = onWatchSetChange((c) => seen.push(c));
  try {
    fn();
  } finally {
    off();
  }
  return seen;
}

const noop = (): void => {};

test('two leases on one folder share one OS watch, and only the first open and the last close change the set', () => {
  const before = made.length;
  let a!: ReturnType<typeof watchPath>;
  let b!: ReturnType<typeof watchPath>;
  const opening = changesDuring(() => {
    a = watchPath('/r/shared', { recursive: true, owner: 'index:/r/shared' }, noop);
    b = watchPath('/r/shared', { recursive: true, owner: 'live:s1' }, noop);
  });
  assert.equal(made.length - before, 1, 'one OS watch for two leases on the same folder');
  assert.deepEqual(opening, [{ kind: 'attached', path: '/r/shared', recursive: true, owners: ['index:/r/shared'] }]);

  const firstClose = changesDuring(() => a.close());
  assert.deepEqual(firstClose, [], 'a lease closing while another holds the watch changes nothing');
  assert.equal(made[made.length - 1].closes, 0, 'and the OS watch stays open');

  const lastClose = changesDuring(() => b.close());
  assert.deepEqual(lastClose, [{ kind: 'closed', path: '/r/shared', recursive: true, owners: ['live:s1'] }]);
  assert.equal(made[made.length - 1].closes, 1, 'the last lease closes the OS watch, once');
  assert.deepEqual(changesDuring(() => b.close()), [], 'closing a lease twice is harmless');
  assert.deepEqual(openWatches(), []);
});

test('a recursive and a folder-only watch of one folder are different watches', () => {
  // A recursive watch reports the whole subtree; a lease that asked for one
  // folder must never be handed its grandchildren's events.
  const before = made.length;
  const deep = watchPath('/r/kinds', { recursive: true, owner: 'a' }, noop);
  const flat = watchPath('/r/kinds', { recursive: false, owner: 'b' }, noop);
  try {
    assert.equal(made.length - before, 2);
    assert.deepEqual(made.slice(-2).map((w) => w.recursive), [true, false]);
  } finally {
    deep.close();
    flat.close();
  }
});

test('every lease hears every event, and a closed lease hears nothing more', () => {
  const heard = { a: [] as string[], b: [] as string[] };
  const a = watchPath('/r/fan', { recursive: true, owner: 'a' }, (_t, f) => heard.a.push(String(f)));
  const b = watchPath('/r/fan', { recursive: true, owner: 'b' }, (_t, f) => heard.b.push(String(f)));
  const os = made[made.length - 1];
  os.deliver('change', 'one.txt');
  a.close();
  os.deliver('change', 'two.txt');
  b.close();
  assert.deepEqual(heard, { a: ['one.txt'], b: ['one.txt', 'two.txt'] });
});

test('a lease closed by another lease\'s listener during a delivery does not hear that event either', () => {
  // One OS watch serves Live mode and the index at once; either may close the
  // other's lease from inside a callback (a session stopping, a root's watch
  // ending). Closed means closed, from that moment.
  const heard: string[] = [];
  let b!: ReturnType<typeof watchPath>;
  const a = watchPath('/r/midway', { recursive: true, owner: 'a' }, () => {
    heard.push('a');
    b.close();
  });
  b = watchPath('/r/midway', { recursive: true, owner: 'b' }, () => heard.push('b'));
  made[made.length - 1].deliver('change', 'x.txt');
  a.close();
  assert.deepEqual(heard, ['a']);
});

test('a lease whose listener throws does not keep the event from the others, and the throw still surfaces', () => {
  // One OS watch serves every lease on its folder, so a bug in one subscriber
  // (Live mode's handler, say) must not starve another (the index) of events.
  const heard: string[] = [];
  const a = watchPath('/r/throws', { recursive: true, owner: 'a' }, () => {
    throw new Error('subscriber bug');
  });
  const b = watchPath('/r/throws', { recursive: true, owner: 'b' }, (_t, f) => heard.push(String(f)));
  try {
    assert.throws(() => made[made.length - 1].deliver('change', 'x.txt'), /subscriber bug/, 'the bug is not swallowed');
    assert.deepEqual(heard, ['x.txt'], 'and the other lease still heard the event');
  } finally {
    a.close();
    b.close();
  }
});

test('an OS watch the system ends with an error tells every lease, is reported once with every owner, and is not reused', () => {
  const errors: string[] = [];
  const a = watchPath('/r/fails', { recursive: true, owner: 'index:/r/fails', onError: (e) => errors.push(`a:${e.message}`) }, noop);
  const b = watchPath('/r/fails', { recursive: true, owner: 'live:s2', onError: (e) => errors.push(`b:${e.message}`) }, noop);
  const os = made[made.length - 1];

  const ended = changesDuring(() => os.emit('error', new Error('stream failed')));
  assert.deepEqual(errors, ['a:stream failed', 'b:stream failed'], 'every lease is told');
  assert.deepEqual(ended, [{ kind: 'errored', path: '/r/fails', recursive: true, owners: ['index:/r/fails', 'live:s2'] }]);
  assert.deepEqual(changesDuring(() => { a.close(); b.close(); }), [], 'the leases it ended close without a second report');

  const before = made.length;
  const again = watchPath('/r/fails', { recursive: true, owner: 'c' }, noop);
  assert.equal(made.length - before, 1, 'a new lease gets a new OS watch, not the dead one');
  again.close();
});

test('a watch the OS refuses throws to its caller and leaves nothing behind', () => {
  refused.add('/r/refused');
  try {
    const before = made.length;
    const changes = changesDuring(() => {
      assert.throws(() => watchPath('/r/refused', { recursive: true, owner: 'a' }, noop), /EACCES/);
    });
    assert.deepEqual(changes, [], 'nothing attached, so nothing is reported');
    assert.deepEqual(openWatches(), [], 'and nothing is recorded');
    refused.delete('/r/refused');
    const ok = watchPath('/r/refused', { recursive: true, owner: 'a' }, noop);
    assert.equal(made.length - before, 1, 'the next attempt asks the OS again');
    ok.close();
  } finally {
    refused.delete('/r/refused');
  }
});

test('a hold keeps an owner\'s OS watches open while that owner lets go and takes them back', () => {
  // What an index rebuild does: its watcher goes with the old rows and a new
  // one comes with the new rows, and the OS watch in between must not close —
  // closing and reopening it is exactly the churn the registry reports.
  const first = watchPath('/r/held', { recursive: true, owner: 'index:/r/held' }, noop);
  const other = watchPath('/r/other-owner', { recursive: true, owner: 'live:s3' }, noop);
  const release = holdWatchesOf('index:/r/held', 'rebuild:/r/held');

  assert.deepEqual(
    changesDuring(() => other.close()),
    [{ kind: 'closed', path: '/r/other-owner', recursive: true, owners: ['live:s3'] }],
    'another owner\'s watch is not held: it closes when its owner lets go',
  );
  let second!: ReturnType<typeof watchPath>;
  const handOver = changesDuring(() => {
    first.close();
    second = watchPath('/r/held', { recursive: true, owner: 'index:/r/held' }, noop);
    release();
  });
  assert.deepEqual(handOver, [], 'no OS watch closed or opened across the hand-over');
  assert.deepEqual(openWatches(), [{ path: '/r/held', recursive: true, owners: ['index:/r/held'] }], 'and the hold is gone');
  second.close();
});

test('only macOS serves every watch in a process from one shared stream', () => {
  // libuv on macOS keeps one FSEventStream per event loop and rebuilds it for
  // every attach and close; Windows gives each watch its own
  // ReadDirectoryChangesW and Linux each its own inotify watch descriptor.
  assert.equal(streamIsSharedOn('darwin'), true);
  assert.equal(streamIsSharedOn('win32'), false);
  assert.equal(streamIsSharedOn('linux'), false);
});

/* ─────────────── the registry sees every watch, or it reports nothing ─────────────── */

const REPO = path.join(__dirname, '..');
const SRC = path.join(REPO, 'src');
const REGISTRY = path.join(SRC, 'platform', 'watchRegistry.ts');
/** A call of `watch(` — `fs.watch(`, `fsp.watch(`, or a bare `watch(` imported from fs — or that import itself. */
const OPENS_A_WATCH = [/(^|[^\w$])watch\(/, /\{[^}]*\bwatch\b[^}]*\}\s*from\s*'(node:)?fs(\/promises)?'/];
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

function sourceFiles(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (name !== 'node_modules' && name !== 'assets') sourceFiles(full, exts, out);
    } else if (exts.some((ext) => name.endsWith(ext))) out.push(full);
  }
  return out;
}

function watchCalls(file: string): string[] {
  const out: string[] = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!COMMENT_LINE.test(line) && OPENS_A_WATCH.some((re) => re.test(line))) out.push(`${path.relative(REPO, file)}:${i + 1}  ${line.trim()}`);
  });
  return out;
}

test('nothing in the server\'s process opens an OS watch except through the registry', () => {
  // The registry can report only the watches it opened. A watch opened
  // anywhere else in the same process still interrupts every other one on
  // macOS each time it attaches or closes — and nothing would mark a root
  // stale for it, which is the silent drift this module exists to end. The
  // server runs as it is (src/) and inside the Electron shell's main process
  // (electron/); the MCP server, scripts and the VS Code extension are
  // processes of their own.
  assert.ok(watchCalls(REGISTRY).length >= 1, 'the pattern finds the registry\'s own fs.watch, so it can find another');
  const files = [
    ...sourceFiles(SRC, ['.ts']),
    ...sourceFiles(path.join(REPO, 'electron'), ['.js', '.cjs', '.mjs']),
  ];
  assert.ok(files.some((f) => f.endsWith(path.join('electron', 'main.js'))), 'the Electron shell is scanned too');
  const elsewhere = files.filter((f) => f !== REGISTRY).flatMap(watchCalls);
  assert.deepEqual(elsewhere, [], `open the watch through watchPath() in src/platform/watchRegistry.ts instead:\n  ${elsewhere.join('\n  ')}`);
});
