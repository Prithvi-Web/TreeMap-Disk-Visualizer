import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-capsuleCaptureStall-data-');
process.env.TREEMAP_NO_GDU = '1';

import { capsuleStoreWaitersForTests, deleteCapsuleEntry, getCapsuleIndex, protectItems, setSourceCallForTests } from '../src/services/timeCapsule';
import { setTrashStepForTests } from '../src/services/cleaner';
import { commitCart } from '../src/services/cartCommit';
import { abandonedCallsUnsettled, copyWithHash, CopyStalled, setCopyFaultForTests, setStallTimerForTests } from '../src/utils/copyVerify';
import { waitFor, withinHangGuard } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * FG3g M2 (minimum). A capture holds the Time Capsule index from its load to its save (FG3f #2), and
 * a copy whose read never answered — a network volume gone quiet, a dying disk, a named pipe chosen
 * for deletion — held it for ever: every restore's bookkeeping, every "Forget", the expiry sweep and
 * every other deletion run waited behind it, and the Autopilot policy that started it stayed "still
 * running" until TreeMap was restarted. Now each file a capture copies has a stall limit: a copy
 * that makes no progress for that long is stopped, its item is left undeleted (it was not
 * protected), and the capture goes on, saves and lets the index go — and a run returns, which is what
 * releases its Autopilot policy (autopilot.ts `runPolicy`'s finally).
 *
 * Nothing here waits on a clock: the stall limit is judged by a timer this file injects
 * (setStallTimerForTests) and fires itself, once the copy is seen to be stuck. "A read that never
 * answers" is real: a named pipe with no writer, whose open does not return until this file opens
 * it for writing at the end, once that open is seen waiting (`release`) — so nothing is left pending
 * when the file's tests are done. A capture's walk arms a timer of its own for each look at the item,
 * so a capture's copy is taken to have begun only once the walk's look has returned (`watchLooks`).
 * And a copy stopped at its limit is counted as a call left waiting until its read returns: two of
 * them stop the run (FG3h A2). Nothing
 * reaches the machine's Trash: the trash step moves each file into this file's own folder.
 */

const NO_FIFO = process.platform === 'win32' ? 'Windows has no named pipes in the file system' : false;

const FAKE_TRASH = fileTempDir('treemap-capsuleCaptureStall-trash-');
let trashCalls = 0;

/** The stall timers armed, in order; each fires its own callback when the test says so. */
let armed: { ms: number; fire: () => void; cancelled: boolean }[] = [];
let unsetTimer: (() => void) | null = null;

before(() => {
  setTrashStepForTests(async (p) => {
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashCalls++}-${path.basename(p)}`));
  });
  unsetTimer = setStallTimerForTests((ms, onExpire) => {
    const timer = { ms, fire: onExpire, cancelled: false };
    armed.push(timer);
    return () => { timer.cancelled = true; };
  });
});

after(() => {
  setTrashStepForTests(null);
  unsetTimer?.();
});

/**
 * A named pipe nobody writes to: an open of it for reading does not return. Each test whose copy may
 * still be waiting on it releases it in its own `finally` (`release`), while it is still there: the
 * folder is removed with this file's others, and a read still waiting on a pipe nobody can name any
 * more would never return.
 */
function namedPipe(label: string): string {
  const fifo = path.join(fileTempDir(`treemap-capsuleCaptureStall-${label}-`), 'pipe');
  execFileSync('mkfifo', [fifo], { env: { ...process.env } });
  return fifo;
}

/**
 * Opens `fifo` for writing once a read is waiting on it, and closes it, so that read returns at its
 * end. Polled until one is (FG3g review F1.6): a copy hands its open to a worker thread, which may not
 * have reached it yet when a test is done with the copy — and a writer that came and went before it
 * did found no reader (ENXIO), so the open then waited for ever, holding a worker thread and this
 * whole file open. Called only where a read of the pipe has been started and not yet released.
 */
async function release(fifo: string): Promise<void> {
  await waitFor(() => {
    try {
      fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENXIO') return false; // no read waiting on it yet
      throw err;
    }
  }, 'a read of the pipe waiting, to release it');
}

/** The newest stall timer still armed: "no progress for the whole limit" is declared by firing it. */
function newestArmed(): { ms: number; fire: () => void; cancelled: boolean } | undefined {
  return [...armed].reverse().find((t) => !t.cancelled);
}

/**
 * Watches a capture's first look at each of `paths` (its walk's lstat), answered as the disk answers
 * it (FG3g review F2.8). Every call a capture's walk makes on an item arms a stall timer of its own,
 * through the same seam a copy's does (FG3h A1) — so "a timer is armed" says a pipe's copy began only
 * once the walk's look at it has returned, its timer let go by then. With `hold`, each look answers
 * only once `answer` is called, so a test can make the moment when the walk's timer is the one armed.
 */
function watchLooks(paths: string[], opts: { hold?: boolean } = {}): {
  asked: (p: string) => boolean;
  returned: () => string[];
  answer: (p: string) => void;
  remove: () => void;
} {
  const asked = new Set<string>();
  const returned: string[] = [];
  const gates = new Map<string, () => void>();
  const remove = setSourceCallForTests((what, abs) => {
    if (what !== 'lstat' || !paths.includes(abs) || asked.has(abs)) return null;
    asked.add(abs);
    const gate = opts.hold === true ? new Promise<void>((resolve) => { gates.set(abs, resolve); }) : Promise.resolve();
    return gate.then(() => fs.promises.lstat(abs, { bigint: true })).then((st) => {
      returned.push(abs);
      return st;
    });
  });
  return { asked: (p) => asked.has(p), returned: () => [...returned], answer: (p) => gates.get(p)?.(), remove };
}

function file(label: string, name: string, content: string): string {
  const p = path.join(fileTempDir(`treemap-capsuleCaptureStall-${label}-`), name);
  fs.writeFileSync(p, content);
  return p;
}

test('a copy whose source never answers is stopped once the stall limit passes with no progress, and makes nothing', { skip: NO_FIFO }, async () => {
  armed = [];
  const fifo = namedPipe('copy');
  const dest = path.join(fileTempDir('treemap-capsuleCaptureStall-copy-dest-'), 'copy');
  try {
    const copying = copyWithHash(fifo, dest, undefined, { stallMs: 60_000 });
    await waitFor(() => newestArmed() !== undefined, 'the stall limit being armed');
    assert.equal(newestArmed()?.ms, 60_000);
    newestArmed()?.fire(); // the limit passes with nothing read
    await assert.rejects(withinHangGuard(copying, 'the stalled copy being answered'), (err: unknown) => {
      assert.ok(err instanceof CopyStalled, String(err));
      assert.match(err.message, /made no progress for 60 seconds/);
      return true;
    });
    assert.equal(fs.existsSync(dest), false, 'nothing was made at the destination');
  } finally {
    await release(fifo); // the copy's open of it may not have been entered yet
  }
});

test('a copy whose source stops answering part-way is stopped, and what it made is removed once the read returns', { skip: NO_FIFO }, async () => {
  armed = [];
  const fifo = namedPipe('midway');
  const dest = path.join(fileTempDir('treemap-capsuleCaptureStall-midway-dest-'), 'copy');
  let chunks = 0;
  const unfault = setCopyFaultForTests((d) => {
    if (d === dest) chunks++;
    return null;
  });
  const writer: { fd: number | null; opened: boolean } = { fd: null, opened: false };
  try {
    const copying = copyWithHash(fifo, dest, undefined, { stallMs: 60_000 });
    // The source answers once, then goes quiet with its writer still open.
    await waitFor(() => {
      try {
        writer.fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
        writer.opened = true;
        return true;
      } catch {
        return false; // the copy has not opened it for reading yet
      }
    }, 'the copy opening the pipe');
    fs.writeSync(writer.fd as number, 'the first bytes');
    await waitFor(() => chunks === 1, 'the first bytes being copied');
    newestArmed()?.fire(); // bytes flowed since the limit was armed: it is armed again
    newestArmed()?.fire(); // and now a whole limit with nothing read
    await assert.rejects(withinHangGuard(copying, 'the stalled copy being answered'), (err: unknown) => err instanceof CopyStalled);
    assert.ok(fs.existsSync(dest), 'the copy had begun its file');
    fs.closeSync(writer.fd as number); // the waiting read returns, at the end of the pipe
    writer.fd = null;
    await waitFor(() => !fs.existsSync(dest), 'the stopped copy removing the file it had begun');
  } finally {
    unfault();
    if (writer.fd !== null) fs.closeSync(writer.fd);
    if (!writer.opened) await release(fifo); // the copy's open of it never returned
  }
});

test('a stopped copy whose stuck read then brings more bytes stops at once and removes what it made, without waiting for the source to end', { skip: NO_FIFO }, async () => {
  armed = [];
  const fifo = namedPipe('more');
  const dest = path.join(fileTempDir('treemap-capsuleCaptureStall-more-dest-'), 'copy');
  let chunks = 0;
  const unfault = setCopyFaultForTests((d) => {
    if (d === dest) chunks++;
    return null;
  });
  const writer: { fd: number | null; opened: boolean } = { fd: null, opened: false };
  try {
    const copying = copyWithHash(fifo, dest, undefined, { stallMs: 60_000 });
    await waitFor(() => {
      try {
        writer.fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
        writer.opened = true;
        return true;
      } catch {
        return false;
      }
    }, 'the copy opening the pipe');
    fs.writeSync(writer.fd as number, 'the first bytes');
    await waitFor(() => chunks === 1, 'the first bytes being copied');
    newestArmed()?.fire();
    newestArmed()?.fire(); // a whole limit with nothing read: stopped
    await assert.rejects(withinHangGuard(copying, 'the stalled copy being answered'), (err: unknown) => err instanceof CopyStalled);
    fs.writeSync(writer.fd as number, 'more bytes, long after'); // the stuck read returns, and the source is still open
    await waitFor(() => !fs.existsSync(dest), 'the stopped copy removing the file it had begun, at the bytes that came late');
  } finally {
    unfault();
    if (writer.fd !== null) fs.closeSync(writer.fd);
    if (!writer.opened) await release(fifo); // the copy's open of it never returned
  }
});

test('a copy that keeps making progress is never stopped, however often the limit comes round', async () => {
  armed = [];
  const src = file('progress', 'big.bin', 'x'.repeat(3 * 64 * 1024));
  const dest = path.join(fileTempDir('treemap-capsuleCaptureStall-progress-dest-'), 'big.bin');
  let fired = 0;
  // At every chunk, the limit comes round: each time, bytes have flowed since it was armed.
  const unfault = setCopyFaultForTests((d) => {
    if (d === dest) {
      newestArmed()?.fire();
      fired++;
    }
    return null;
  });
  try {
    await copyWithHash(src, dest, undefined, { stallMs: 60_000 });
  } finally {
    unfault();
  }
  assert.ok(fired >= 3, `the limit came round ${fired} times`);
  assert.equal(fs.readFileSync(dest, 'utf8'), fs.readFileSync(src, 'utf8'), 'and the copy finished whole');
});

test('a capture whose copy stalls leaves that item undeleted, goes on to the next, and lets the index go: a "Forget" waiting behind it finishes (FG3f review M2)', { skip: NO_FIFO }, async () => {
  armed = [];
  const other = file('forget', 'other.txt', 'a copy someone will forget');
  const { outcomes: [held] } = await protectItems([{ path: other }]);
  assert.equal(held.protected, true);
  const fifo = namedPipe('cart');
  const normal = file('cart', 'normal.txt', 'an ordinary file');
  let forgot: Promise<unknown> | null = null;
  let result: Awaited<ReturnType<typeof commitCart>>;
  let copyStarted = false;
  // The walk's own look at the pipe answers only when this test says (FG3g review F2.8): while it is
  // out, the timer armed is the walk's, not the copy's — the moment a wait for "any timer armed" took
  // for the copy, firing the walk's timer instead and never starting the copy it then waited on.
  const look = watchLooks([fifo], { hold: true });
  try {
    result = await withOpenFileCheck('clear', async () => {
      const committing = commitCart([fifo, normal]);
      await waitFor(() => look.asked(fifo), 'the walk looking at the pipe');
      assert.ok(newestArmed() !== undefined, 'the walk\'s own look has a stall timer armed');
      look.answer(fifo);
      await waitFor(() => look.returned().includes(fifo) && newestArmed() !== undefined, 'the copy of the pipe starting, once the walk\'s look has returned');
      copyStarted = true;
      forgot = deleteCapsuleEntry(held.entryId as string);
      await waitFor(() => capsuleStoreWaitersForTests() > 0, 'the "Forget" waiting for the capture, which holds the index');
      newestArmed()?.fire(); // the stall limit passes with nothing read
      return withinHangGuard(committing, 'the commit finishing');
    });
  } finally {
    look.answer(fifo);
    look.remove();
    if (copyStarted) await release(fifo); // the copy's open of it may not have been entered yet
  }
  assert.deepEqual(await (forgot as unknown as Promise<unknown>), { deleted: true, bytesFreed: Buffer.byteLength('a copy someone will forget') }, 'the "Forget" ran once the capture let the index go');
  const row = result.skipped.find((s) => s.path === fifo);
  assert.equal(row?.code, 'CAPSULE_COPY_FAILED', JSON.stringify(result.skipped));
  assert.match(row?.reason ?? '', /made no progress for 60 seconds/, row?.reason);
  assert.match(row?.reason ?? '', /left alone/, row?.reason);
  assert.ok(fs.existsSync(fifo), 'the item whose copy stalled is still in place');
  assert.deepEqual(result.trashed, [normal], 'and the item after it was protected and deleted');
  const copies = (await getCapsuleIndex()).entries.filter((e) => e.runId === result.runId);
  assert.deepEqual(copies.map((e) => e.originalPath), [normal], 'no copy of the stalled item is kept');
});

/* ─────────────── FG3h A2 for copies (FG3g review F2.9): a stopped copy's read is counted ─────────────── */

test('a copy stopped at its stall limit is counted as a call left waiting until its read returns', { skip: NO_FIFO }, async () => {
  armed = [];
  await waitFor(() => abandonedCallsUnsettled() === 0, 'every earlier read left waiting returning');
  const fifo = namedPipe('counted');
  const look = watchLooks([fifo]);
  let copyStarted = false;
  let result: Awaited<ReturnType<typeof commitCart>>;
  try {
    result = await withOpenFileCheck('clear', async () => {
      const committing = commitCart([fifo]);
      await waitFor(() => look.returned().includes(fifo) && newestArmed() !== undefined, 'the copy of the pipe starting');
      copyStarted = true;
      newestArmed()?.fire(); // the stall limit passes with nothing read
      return withinHangGuard(committing, 'the commit finishing');
    });
    assert.equal(abandonedCallsUnsettled(), 1, 'the stopped copy, its read still waiting on the pipe, is counted');
  } finally {
    look.remove();
    if (copyStarted) await release(fifo);
  }
  await waitFor(() => abandonedCallsUnsettled() === 0, 'the copy\'s read returning, and no longer counted');
  assert.equal(result.skipped.find((s) => s.path === fifo)?.code, 'CAPSULE_COPY_FAILED', JSON.stringify(result.skipped));
});

test('two copies stopped at their stall limit stop the run: the item after them is left undeleted at once, and nothing is asked of it', { skip: NO_FIFO }, async () => {
  armed = [];
  await waitFor(() => abandonedCallsUnsettled() === 0, 'every earlier read left waiting returning');
  const pipes = [namedPipe('cap-one'), namedPipe('cap-two')];
  const normal = file('cap', 'normal.txt', 'an ordinary file, asked for after two copies that stalled');
  const look = watchLooks([...pipes, normal]);
  let result: Awaited<ReturnType<typeof commitCart>>;
  try {
    result = await withOpenFileCheck('clear', async () => {
      const committing = commitCart([...pipes, normal]);
      for (const pipe of pipes) {
        await waitFor(() => look.returned().includes(pipe) && newestArmed() !== undefined, `the copy of ${path.basename(path.dirname(pipe))} starting`);
        newestArmed()?.fire(); // the stall limit passes with nothing read
      }
      return withinHangGuard(committing, 'the commit finishing');
    });
    assert.equal(abandonedCallsUnsettled(), 2, 'both stopped copies are counted');
  } finally {
    look.remove();
    for (const pipe of look.returned().filter((p) => pipes.includes(p))) await release(pipe);
  }
  await waitFor(() => abandonedCallsUnsettled() === 0, 'both reads returning');
  const row = result.skipped.find((s) => s.path === normal);
  assert.equal(row?.code, 'CAPSULE_COPY_FAILED', JSON.stringify(result.skipped));
  assert.match(row?.reason ?? '', /still waiting on 2 calls/, row?.reason);
  assert.equal(look.asked(normal), false, 'nothing was asked of it: no further call was started');
  assert.deepEqual(result.trashed, [], 'nothing was trashed');
  assert.ok(fs.existsSync(normal), 'the item after them is still in place');
});
