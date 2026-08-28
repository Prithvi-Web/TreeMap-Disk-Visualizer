import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What the live watcher does when the filesystem will not answer.
 *
 * The bug these pin was found by injecting one errno rather than by reading:
 * every `lstat` in the watcher path was wrapped in a bare `catch { stat =
 * null }`, so ANY failure was read as "this file no longer exists" — and the
 * `stat === null` branch runs `deleteSubtree`. Measured consequences of a
 * single injected `EMFILE`, on a machine where nothing had been deleted:
 *
 *   - a live 50,000-byte file was removed from the index while it sat on disk
 *     (a directory would have taken its whole subtree along);
 *   - a newly created file was never indexed at all, and never re-examined,
 *     because nothing else was going to change about it — which is exactly
 *     how `an external create ... within 2 seconds` failed on macOS CI with
 *     `never landed in the index at all`.
 *
 * `EMFILE` is not exotic on a loaded machine, which is why CI saw this and an
 * idle laptop did not.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-transient-data-'));
process.env.TREEMAP_DATA_DIR = DATA_DIR;

import { buildIndex, getRoot, stopAllWatchers, closeIndex, deleteIndex, MAX_CHANGE_ATTEMPTS } from '../src/services/indexEngine';
import { meansGone } from '../src/utils/errno';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mkTmp = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), 'tm-transient-'));

/** The object the engine actually calls through, so patching it is honest. */
const liveFs = require('fs').promises as typeof import('fs').promises;

/**
 * Make EVERY `lstat` of one path fail with a given errno until released,
 * letting every other path through untouched.
 *
 * Deliberately not "fail the Nth call". A change is stat'ed once by the
 * watcher to classify the event and once by `applyPendingChanges` to decide
 * what to write, and it is only the second that reaches the index — but that
 * count is a property of the WATCHER, and the watcher is not the same
 * everywhere: `src/platform/linux/index.ts` overrides `subscribeToChanges`
 * entirely, and FSEvents can coalesce or repeat. An ordinal would encode this
 * Mac's arrangement and quietly stop testing anything on the other two
 * runners — the worst outcome available, because it fails green.
 *
 * Failing every call needs no such assumption, and it still isolates the
 * behaviour under test: an unreadable path must never become a deletion, on
 * any platform, however many times it is asked about.
 */
function failLstat(match: string, code: string, opts: { forMs?: number } = {}): { release: () => void; calls: () => number } {
  // NOTE: every caller must release, and the tests below do it through
  // `t.after` rather than a `finally`. A wrapper left installed is wrapped by
  // the NEXT test's wrapper, so a later `release()` restores to the stale one
  // rather than to the real `lstat` — which turns one failing test into two
  // and hides the one that actually broke.
  const original = liveFs.lstat;
  const until = opts.forMs === undefined ? Infinity : Date.now() + opts.forMs;
  let calls = 0;
  (liveFs as unknown as { lstat: unknown }).lstat = async (p: unknown, ...rest: unknown[]): Promise<unknown> => {
    if (String(p).endsWith(match)) {
      // Counted whether or not it is failed. Counting only the FAILED calls
      // ties `calls()` to the injection window, so on a runner slow enough
      // that the first filesystem event arrives after the window closes, the
      // counter would stay at zero for ever and a `waitFor(calls() > 0)`
      // would fail for a reason that has nothing to do with the behaviour
      // under test.
      calls++;
      if (Date.now() < until) {
        const err: NodeJS.ErrnoException = new Error(`${code}: injected, lstat`);
        err.code = code;
        throw err;
      }
    }
    return (original as unknown as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
  };
  return {
    release: () => {
      (liveFs as unknown as { lstat: unknown }).lstat = original;
    },
    calls: () => calls,
  };
}

/** Poll until the predicate holds, returning how long it took, or -1. */
async function waitFor(predicate: () => boolean, timeoutMs = 12_000): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return Date.now() - started;
    await sleep(25);
  }
  return -1;
}

after(() => {
  stopAllWatchers();
  closeIndex();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/* ------------------------------- the rule ------------------------------- */

test('only a real absence counts as gone', () => {
  const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
  assert.equal(meansGone(err('ENOENT')), true, 'the path is not there');
  assert.equal(meansGone(err('ENOTDIR')), true, 'a parent is not a directory, so it cannot be there');
  // Not absences, but paths the kernel will never resolve. Retrying them is a
  // loop that never clears: the budget burns and the root goes stale on every
  // event, for ever.
  assert.equal(meansGone(err('ELOOP')), true, 'a symlink cycle will not resolve on the sixth attempt either');
  assert.equal(meansGone(err('ENAMETOOLONG')), true, 'nor will a path past NAME_MAX');
  assert.equal(meansGone(err('EINVAL')), true, 'nor an ill-formed one');

  // A wrapped error still answers, because this codebase chains them now.
  assert.equal(meansGone(new Error('outer', { cause: err('ENOENT') })), true, 'the cause is walked');
  assert.equal(meansGone(new Error('outer', { cause: err('EMFILE') })), false);
  // And one that lost its own properties crossing a worker boundary keeps errno.
  assert.equal(meansGone(Object.assign(new Error('x'), { errno: -2 })), true, 'errno -2 is ENOENT');
  assert.equal(meansGone(Object.assign(new Error('x'), { errno: -24 })), false, 'errno -24 is EMFILE');

  // Everything below means "could not find out", and every one of them is
  // reachable: descriptor exhaustion, a protected file, a failing disk, a
  // network volume having a bad moment.
  for (const code of ['EMFILE', 'ENFILE', 'EACCES', 'EPERM', 'EIO', 'EBUSY', 'ETIMEDOUT', 'EAGAIN']) {
    assert.equal(meansGone(err(code)), false, `${code} is not a deletion`);
  }
  assert.equal(meansGone(new Error('no code at all')), false);
  assert.equal(meansGone(null), false);
  assert.equal(meansGone(undefined), false);
});

/* --------------------------- the two damages --------------------------- */

test('a transient lstat failure does not delete a file that is still on disk', async (t) => {
  const dir = await mkTmp();
  let injected: { release: () => void; calls: () => number } | null = null;
  try {
    await fsp.mkdir(path.join(dir, 'keep'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'keep', 'big.bin'), Buffer.alloc(50_000));
    await fsp.writeFile(path.join(dir, 'keep', 'small.bin'), Buffer.alloc(10_000));
    await buildIndex(dir, { live: true });
    assert.equal(getRoot(dir)!.totalSize, 60_000, 'the fixture indexed correctly to begin with');

    injected = failLstat(path.join('keep', 'big.bin'), 'EMFILE');
    t.after(() => { injected?.release(); });
    // A rewrite at the SAME size, not a `utimes`. Two reasons, both learned
    // from this test failing in a full-suite run:
    //   - a pure timestamp change does not reliably produce an FSEvents
    //     callback, so the test could sit waiting for an event that was never
    //     going to come and fail for a reason that is not the point;
    //   - the size must not move, because the assertion below is that the
    //     index still totals every byte.
    await fsp.writeFile(path.join(dir, 'keep', 'big.bin'), Buffer.alloc(50_000, 2));

    // Wait for the engine to have actually ASKED — a fixed sleep would pass
    // on a slow runner before the watcher had done anything, proving nothing.
    const asked = await waitFor(() => injected!.calls() > 0);
    assert.notEqual(asked, -1, 'the watcher noticed the change and tried to stat it');

    // Now let it keep failing across several flush intervals. Whatever the
    // engine does with an unreadable path, deleting the row is not among the
    // acceptable answers.
    await sleep(1_200);
    assert.ok(fs.existsSync(path.join(dir, 'keep', 'big.bin')), 'the file never went anywhere');
    assert.equal(
      getRoot(dir)!.totalSize,
      60_000,
      'the index still accounts for every byte — before the fix this read 10000',
    );

    // And once the machine recovers, the row is REFRESHED rather than left
    // behind — the retry is what makes "leave it alone" safe rather than
    // merely non-destructive.
    //
    // This assertion used to be `totalSize === 60_000` again, immediately
    // after release. It could not fail: 60,000 was already asserted six lines
    // up, the trigger changed no size, and nothing was awaited. The one test
    // in this file that claimed to prove recovery proved nothing — the exact
    // sin this repo's own audit named ("two tests that were not testing").
    //
    // It now grows the file while the disk is unreadable, so the new size can
    // only appear if something re-read it. The second injection is TIME-boxed
    // for the same reason the one in the next test is: every natural event
    // the append produces is delivered within tens of milliseconds, so a
    // window that outlasts them means no natural event can do the work, and
    // the only thing left that can is the engine's own retry.
    injected.release();
    injected = failLstat(path.join('keep', 'big.bin'), 'EMFILE', { forMs: 1_000 });
    t.after(() => { injected?.release(); });
    await fsp.appendFile(path.join(dir, 'keep', 'big.bin'), Buffer.alloc(7_000, 3));
    const landed = await waitFor(() => getRoot(dir)!.totalSize === 67_000);
    assert.notEqual(landed, -1, 'the retry re-read the file once the disk answered, and the index caught up');
  } finally {
    injected?.release();
    stopWatcherAndClean(dir);
  }
});

test('a transient lstat failure delays a new file into the index, it does not lose it', async (t) => {
  const dir = await mkTmp();
  try {
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(1000));
    await buildIndex(dir, { live: true });

    // Unreadable for a full second, then readable again — WITHOUT the test
    // choosing the moment. The window matters: `writeFile` completes in
    // milliseconds and its events are delivered in tens of milliseconds, so
    // by the time the disk "recovers" every event the filesystem was ever
    // going to send has already been delivered and refused. Nothing is going
    // to happen to this file again. If the change still lands, the only
    // thing that can have carried it is the engine's own retry.
    //
    // Releasing the moment the first stat failed is NOT equivalent, and this
    // is not hypothetical: written that way, the test passed against the
    // unfixed engine, because a later natural event from the same `writeFile`
    // arrived after the release and did the insert.
    const injected = failLstat('new.bin', 'EMFILE', { forMs: 1_000 });
    t.after(() => { injected.release(); });
    await fsp.writeFile(path.join(dir, 'new.bin'), Buffer.alloc(5000));

    const asked = await waitFor(() => injected.calls() > 0);
    assert.notEqual(asked, -1, 'the watcher noticed the new file and tried to stat it');
    assert.equal(getRoot(dir)!.totalSize, 1000, 'nothing invented while the answer was unavailable');

    const took = await waitFor(() => getRoot(dir)!.totalSize === 6000);
    assert.notEqual(took, -1, 'the create landed once the disk answered, rather than never');
  } finally {
    stopWatcherAndClean(dir);
  }
});

/* ------------------------- the honest end state ------------------------- */

test('a change that never resolves marks the root stale rather than pretending', async (t) => {
  const dir = await mkTmp();
  try {
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(1000));
    await buildIndex(dir, { live: true });
    assert.equal(getRoot(dir)!.state, 'ready', 'a freshly built root is ready');

    // A volume that stays unreadable — not one blip but every attempt.
    const injected = failLstat('stubborn.bin', 'EIO');
    t.after(() => { injected.release(); });
    await fsp.writeFile(path.join(dir, 'stubborn.bin'), Buffer.alloc(7000));

    const took = await waitFor(() => getRoot(dir)!.state === 'stale');
    assert.notEqual(took, -1, 'the retries are bounded and the root ends up stale');
    // More than the two a single pass costs — the watcher classifies the
    // event with one `lstat` and `applyPendingChanges` decides with another,
    // so `> 1` was satisfied without any retry at all.
    assert.ok(
      injected.calls() >= MAX_CHANGE_ATTEMPTS,
      `it retried to the bound before giving up (saw ${String(injected.calls())} attempts)`,
    );
    assert.equal(
      getRoot(dir)!.totalSize,
      1000,
      'and no number was invented for the file it could not read',
    );
    injected.release();
  } finally {
    stopWatcherAndClean(dir);
  }
});

test('a real deletion is still applied, exactly as before', async () => {
  // The fix must not have bought its safety by ignoring deletions.
  const dir = await mkTmp();
  try {
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(1000));
    await fsp.writeFile(path.join(dir, 'doomed.bin'), Buffer.alloc(4000));
    await buildIndex(dir, { live: true });
    assert.equal(getRoot(dir)!.totalSize, 5000);

    await fsp.unlink(path.join(dir, 'doomed.bin'));
    const took = await waitFor(() => getRoot(dir)!.totalSize === 1000);
    assert.notEqual(took, -1, 'ENOENT still means gone, and the row goes with it');
    assert.equal(getRoot(dir)!.state, 'ready', 'an ordinary deletion does not make a root stale');
  } finally {
    stopWatcherAndClean(dir);
  }
});

function stopWatcherAndClean(dir: string): void {
  stopAllWatchers();
  deleteIndex(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}
