import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-capsuleCaptureCap-data-');
process.env.TREEMAP_NO_GDU = '1';

import {
  capsuleRoot, capsuleStoreWaitersForTests, deleteCapsuleEntry, getCapsuleIndex, protectItems, setCaptureCleanupFaultForTests, setSourceCallForTests,
} from '../src/services/timeCapsule';
import { setTrashStepForTests } from '../src/services/cleaner';
import { commitCart, planCartCommit } from '../src/services/cartCommit';
import { abandonedCallsUnsettled, setCopyFaultForTests, setStallTimerForTests, withinStallLimit } from '../src/utils/copyVerify';
import { waitFor, withinHangGuard } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * FG3h A (the M2 remainder). The stall limit FG3g M2 put on a capture's copy left the rest of what a
 * capture does to the item unbounded: its walk (each lstat, readdir and readlink) ran with the Time
 * Capsule index held, so a volume that stopped answering mid-walk held the index — every restore's
 * bookkeeping, every Forget, the expiry, every other run — and the Autopilot policy behind it, for
 * ever. Now every call on the item has the same limit. And a call left waiting at its limit cannot be
 * stopped: it holds a worker thread of the pool every file call in TreeMap shares, so a handful of
 * them starved the next unguarded file call — which then hung with the index held. Now once two are
 * left waiting, a capture starts no more: the rest of the run is left undeleted at once
 * (CAPSULE_COPY_FAILED), as is an item due its look right before its trash step, and a dry run says
 * so — until they return.
 *
 * "A volume that stopped answering" is a call on the item this file holds (setSourceCallForTests),
 * and "the limit passed" is a timer this file fires (setStallTimerForTests): nothing waits on a clock.
 * Nothing reaches the machine's Trash: the trash step moves each file into this file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-capsuleCaptureCap-trash-');
let trashCalls = 0;
/** Run inside the trash step, before it moves `p`. */
let duringTrash: ((p: string) => void) | null = null;

/** The stall timers armed, in order; each fires its own callback when the test says so. */
let armed: { ms: number; fire: () => void; cancelled: boolean }[] = [];
let unsetTimer: (() => void) | null = null;

before(() => {
  setTrashStepForTests(async (p) => {
    duringTrash?.(p);
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

beforeEach(() => {
  armed = [];
  duringTrash = null;
});

/** The newest stall timer still armed: "no answer for the whole limit" is declared by firing it. */
function newestArmed(): { ms: number; fire: () => void; cancelled: boolean } | undefined {
  return [...armed].reverse().find((t) => !t.cancelled);
}

function file(label: string, name: string, content: string): string {
  const p = path.join(fileTempDir(`treemap-capsuleCaptureCap-${label}-`), name);
  fs.writeFileSync(p, content);
  return p;
}

/** A folder holding `inner.txt`: a capture's walk looks at that member with its own lstat. */
function folder(label: string): { dir: string; inner: string } {
  const dir = path.join(fileTempDir(`treemap-capsuleCaptureCap-${label}-`), 'proj');
  fs.mkdirSync(dir);
  const inner = path.join(dir, 'inner.txt');
  fs.writeFileSync(inner, 'a file inside a folder being captured');
  return { dir, inner };
}

/** What a held call is: its kind (lstat, readdir, readlink, stat) and the path it is on. */
interface HeldCall { what: string; abs: string }

/**
 * Holds each call on the item that `matches` picks — by its kind, its path, and how many calls of
 * that kind on that path came before it (0 for the first) — so it does not answer until `answer` is
 * called; every other call goes to the disk. `asked` lists the paths held, in order, and `calls`
 * what each was.
 */
function holdCalls(matches: (what: string, abs: string, nth: number) => boolean): { asked: string[]; calls: HeldCall[]; answer: () => void; remove: () => void } {
  const asked: string[] = [];
  const calls: HeldCall[] = [];
  const seen = new Map<string, number>();
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  const remove = setSourceCallForTests((what, abs) => {
    const key = `${what}\0${abs}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    if (!matches(what, abs, nth)) return null;
    asked.push(abs);
    calls.push({ what, abs });
    return answered.then(() => { throw Object.assign(new Error('the volume answered at last (a test)'), { code: 'EIO' }); });
  });
  return { asked, calls, answer, remove };
}

/**
 * Holds every call on the items named in `paths` (each a call a walk or capture makes): it does not
 * answer until `answer` is called. `asked` lists the paths asked about, in order.
 */
function holdCallsOn(paths: string[]): { asked: string[]; calls: HeldCall[]; answer: () => void; remove: () => void } {
  return holdCalls((_what, abs) => paths.includes(abs));
}

/**
 * Drives `committing` to its end, firing the stall limit of each held call as it is asked — every
 * one, so a call asked a second time is seen rather than left to hang the test.
 */
async function fireEachHeldCall<T>(committing: Promise<T>, hold: { asked: string[] }): Promise<T> {
  let done = false;
  committing.then(() => { done = true; }, () => { done = true; });
  for (let fired = 0; ; fired++) {
    await waitFor(() => hold.asked.length > fired || done, 'a held call being asked, or the commit finishing');
    if (hold.asked.length <= fired) break;
    newestArmed()?.fire(); // the limit passes with no answer
  }
  return withinHangGuard(committing, 'the commit finishing once each limit passed');
}

/** Records every call on the items named in `paths`, answering each as the disk does. */
function watchCallsOn(paths: string[]): { asked: string[]; remove: () => void } {
  const asked: string[] = [];
  const remove = setSourceCallForTests((_what, abs) => {
    if (paths.includes(abs)) asked.push(abs);
    return null;
  });
  return { asked, remove };
}

/** `n` calls left waiting at their limit, as a volume that stopped answering leaves them; `answer` lets them return. */
function leaveCallsWaiting(n: number): { answer: () => void } {
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  for (let i = 0; i < n; i++) {
    void withinStallLimit(answered, 60_000, () => undefined);
    newestArmed()?.fire();
  }
  return { answer };
}

test('a capture whose walk of an item gets no answer is stopped at the limit: that item is left undeleted, the next goes, and the index is let go', async () => {
  const other = file('forget', 'other.txt', 'a copy someone will forget');
  const { outcomes: [held] } = await protectItems([{ path: other }]);
  assert.equal(held.protected, true, held.detail);
  const { dir, inner } = folder('walk');
  const normal = file('walk-next', 'normal.txt', 'an ordinary file');
  const hold = holdCallsOn([inner]);
  const before = abandonedCallsUnsettled();
  let result: Awaited<ReturnType<typeof commitCart>>;
  let forgot: Promise<unknown> | null = null;
  try {
    result = await withOpenFileCheck('clear', async () => {
      const committing = commitCart([dir, normal]);
      await waitFor(() => hold.asked.length > 0, 'the walk asking about the member that does not answer');
      forgot = deleteCapsuleEntry(held.entryId as string);
      await waitFor(() => capsuleStoreWaitersForTests() > 0, 'the "Forget" waiting for the capture, which holds the index');
      assert.equal(newestArmed()?.ms, 60_000);
      newestArmed()?.fire(); // the limit passes with no answer
      return withinHangGuard(committing, 'the commit finishing once the limit passed');
    });
    assert.equal(abandonedCallsUnsettled(), before + 1, 'the call left waiting is counted until it returns');
  } finally {
    hold.answer();
    hold.remove();
  }
  await waitFor(() => abandonedCallsUnsettled() === before, 'the call left waiting returning');
  assert.deepEqual(await (forgot as unknown as Promise<unknown>), { deleted: true, bytesFreed: Buffer.byteLength('a copy someone will forget') }, 'the "Forget" ran once the capture let the index go');
  const row = result.skipped.find((s) => s.path === dir);
  assert.equal(row?.code, 'CAPSULE_UNREADABLE', JSON.stringify(result.skipped));
  assert.match(row?.reason ?? '', /inner\.txt/, row?.reason);
  assert.match(row?.reason ?? '', /did not answer/, row?.reason);
  assert.ok(fs.existsSync(inner), 'the item whose walk got no answer is still in place, whole');
  assert.deepEqual(result.trashed, [normal], 'and the item after it was protected and deleted');
  assert.deepEqual((await getCapsuleIndex()).entries.filter((e) => e.runId === result.runId).map((e) => e.originalPath), [normal]);
});

test('a folder inside an item that gets no answer is asked once: one call is left waiting, not two, and the rest of the run goes on (FG3g review F2.2)', async () => {
  const first = file('quiet-sub-first', 'first.txt', 'an ordinary file before the folder');
  const { dir } = folder('quiet-sub');
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'deep.txt'), 'a file in a folder that stops answering');
  const last = file('quiet-sub-last', 'last.txt', 'an ordinary file after the folder');
  await waitFor(() => abandonedCallsUnsettled() === 0, 'every earlier call left waiting returning');
  const hold = holdCallsOn([sub]);
  let result: Awaited<ReturnType<typeof commitCart>>;
  try {
    result = await withOpenFileCheck('clear', () => fireEachHeldCall(commitCart([first, dir, last]), hold));
    assert.deepEqual(hold.calls.map((c) => c.what), ['lstat'], 'the folder that did not answer its look was not asked for its listing as well');
    assert.equal(abandonedCallsUnsettled(), 1, 'one call left waiting, on the one quiet folder');
  } finally {
    hold.answer();
    hold.remove();
  }
  await waitFor(() => abandonedCallsUnsettled() === 0, 'the call left waiting returning');
  const row = result.skipped.find((s) => s.path === dir);
  assert.equal(row?.code, 'CAPSULE_UNREADABLE', JSON.stringify(result.skipped));
  assert.match(row?.reason ?? '', /made no progress for 60 seconds/, row?.reason);
  assert.ok(fs.existsSync(path.join(sub, 'deep.txt')), 'the item holding the quiet folder is in place, whole');
  assert.deepEqual([...result.trashed].sort(), [first, last].sort(), 'and the items before and after it were protected and deleted');
});

test('a folder inside an item whose own look fails at once - an answer, not a silence - is still copied whole, only its times unrecorded', async () => {
  const { dir } = folder('failed-look');
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'deep.txt'), 'a file in a folder whose look fails');
  const remove = setSourceCallForTests((what, abs) => (what === 'lstat' && abs === sub
    ? Promise.reject(Object.assign(new Error('an i/o error (a test)'), { code: 'EIO' }))
    : null));
  let outcome: Awaited<ReturnType<typeof protectItems>>['outcomes'][number];
  try {
    [outcome] = (await protectItems([{ path: dir }])).outcomes;
  } finally {
    remove();
  }
  assert.equal(outcome.protected, true, outcome.detail);
  const manifest = JSON.parse(fs.readFileSync(path.join(capsuleRoot(), outcome.entryId as string, 'manifest.json'), 'utf8')) as { members: { rel: string; kind: string; mtimeMs?: number }[] };
  const ofSub = manifest.members.find((m) => m.rel === 'sub');
  assert.equal(ofSub?.kind, 'dir');
  assert.equal(ofSub?.mtimeMs, undefined, 'its times, which could not be read, are not recorded');
  assert.ok(manifest.members.some((m) => m.rel === path.join('sub', 'deep.txt')), 'and what it holds was copied');
});

test('a single file whose look gets no answer is left undeleted at the limit, saying so', async () => {
  const lone = file('lone', 'lone.txt', 'a file on a volume that stops answering');
  const hold = holdCallsOn([lone]);
  let result: Awaited<ReturnType<typeof commitCart>>;
  try {
    result = await withOpenFileCheck('clear', async () => {
      const committing = commitCart([lone]);
      await waitFor(() => hold.asked.length > 0, 'the capture asking about the file');
      newestArmed()?.fire();
      return withinHangGuard(committing, 'the commit finishing once the limit passed');
    });
  } finally {
    hold.answer();
    hold.remove();
  }
  await waitFor(() => abandonedCallsUnsettled() === 0, 'the call left waiting returning');
  const row = result.skipped.find((s) => s.path === lone);
  assert.equal(row?.code, 'CAPSULE_UNREADABLE', JSON.stringify(result.skipped));
  assert.match(row?.reason ?? '', /made no progress for 60 seconds/, row?.reason);
  assert.ok(fs.existsSync(lone));
});

test('once two calls are left waiting, a capture starts no more: the rest is left undeleted at once, and a dry run says so, until they return', async () => {
  const later = file('capped', 'later.txt', 'an item asked for while TreeMap waits on a quiet volume');
  const waiting = leaveCallsWaiting(2);
  const watch = watchCallsOn([later]); // records any call on it; none must come
  try {
    assert.equal(abandonedCallsUnsettled(), 2);
    const plan = await planCartCommit([later]);
    assert.equal(plan.items[0].willDelete, false, 'the dry run says it will be left alone');
    assert.equal(plan.items[0].code, 'CAPSULE_COPY_FAILED', JSON.stringify(plan.items[0]));
    const result = await withOpenFileCheck('clear', () => commitCart([later]));
    const row = result.skipped.find((s) => s.path === later);
    assert.equal(row?.code, 'CAPSULE_COPY_FAILED', JSON.stringify(result.skipped));
    assert.match(row?.reason ?? '', /still waiting on 2 calls/, row?.reason);
    assert.match(row?.reason ?? '', /left alone/, row?.reason);
    assert.deepEqual(watch.asked, [], 'and nothing was asked of it: no further call was started');
    assert.ok(fs.existsSync(later));
  } finally {
    waiting.answer();
    watch.remove();
  }
  await waitFor(() => abandonedCallsUnsettled() === 0, 'the calls left waiting returning');
  const again = await withOpenFileCheck('clear', () => commitCart([later]));
  assert.deepEqual(again.trashed, [later], 'once they have returned, capture goes on as before');
});

test('an item whose turn to be trashed comes while two calls are left waiting is not looked at again, and so not trashed', async () => {
  const first = path.join(fileTempDir('treemap-capsuleCaptureCap-turn-'), 'aa', 'first.txt'); // deeper: trashed first
  fs.mkdirSync(path.dirname(first));
  fs.writeFileSync(first, 'the first item');
  const second = file('turn', 'second.txt', 'the second item');
  let waiting: { answer: () => void } | null = null;
  duringTrash = (p) => {
    if (p === first) waiting = leaveCallsWaiting(2); // a volume stops answering between the two turns
  };
  let result: Awaited<ReturnType<typeof commitCart>>;
  try {
    result = await withOpenFileCheck('clear', () => commitCart([first, second]));
  } finally {
    (waiting as { answer: () => void } | null)?.answer();
  }
  await waitFor(() => abandonedCallsUnsettled() === 0, 'the calls left waiting returning');
  assert.deepEqual(result.trashed, [first]);
  const row = result.skipped.find((s) => s.path === second);
  assert.equal(row?.code, 'CAPSULE_UNREADABLE', JSON.stringify(result.skipped));
  assert.match(row?.reason ?? '', /still waiting on 2 calls/, row?.reason);
  assert.ok(fs.existsSync(second), 'it is still in place');
});

test('an item whose look right before its trash step gets no answer is left in place at the limit, and is asked once', async () => {
  const first = path.join(fileTempDir('treemap-capsuleCaptureCap-look-'), 'aa', 'first.txt'); // deeper: trashed first
  fs.mkdirSync(path.dirname(first));
  fs.writeFileSync(first, 'the first item');
  const second = file('look', 'second.txt', 'the second item, on a volume that stops answering');
  let hold: ReturnType<typeof holdCallsOn> | null = null;
  duringTrash = (p) => {
    if (p === first) hold = holdCallsOn([second]); // the volume stops answering between the two turns
  };
  let result: Awaited<ReturnType<typeof commitCart>>;
  try {
    result = await withOpenFileCheck('clear', async () => {
      const committing = commitCart([first, second]);
      await waitFor(() => ((hold as ReturnType<typeof holdCallsOn> | null)?.asked.length ?? 0) > 0, 'the look at the second item, right before its trash step');
      newestArmed()?.fire();
      return withinHangGuard(committing, 'the commit finishing once the limit passed');
    });
  } finally {
    const held = hold as ReturnType<typeof holdCallsOn> | null;
    held?.answer();
    held?.remove();
  }
  await waitFor(() => abandonedCallsUnsettled() === 0, 'the call left waiting returning');
  assert.deepEqual(result.trashed, [first]);
  const row = result.skipped.find((s) => s.path === second);
  assert.equal(row?.code, 'CAPSULE_UNREADABLE', JSON.stringify(result.skipped));
  assert.match(row?.reason ?? '', /could not be looked at again right before its deletion \(the disk did not answer/, row?.reason);
  assert.deepEqual((hold as ReturnType<typeof holdCallsOn> | null)?.asked, [second], 'asked once: no second wait on the same quiet volume');
  assert.ok(fs.existsSync(second));
});

test('a capture\'s half-made copy whose folder could not be removed at once is removed by the next capture, not left until the next start (FG3h D)', async () => {
  const broken = file('cleanup', 'broken.txt', 'an item whose copy fails part-way');
  const next = file('cleanup-next', 'next.txt', 'an item captured after it');
  const folders = (): string[] => (fs.existsSync(capsuleRoot()) ? fs.readdirSync(capsuleRoot()) : []);
  const known = async (): Promise<Set<string>> => new Set((await getCapsuleIndex()).entries.map((e) => e.id));
  const unfault = setCopyFaultForTests((dest) => (path.basename(dest) === 'broken.txt' ? new Error('the disk stopped answering (a test)') : null));
  // As on Windows, where the copy left waiting still holds a handle in the folder: the first removal fails.
  let refusals = 0;
  const uncleanup = setCaptureCleanupFaultForTests(() => (refusals++ === 0 ? Object.assign(new Error('the folder is in use (a test)'), { code: 'EBUSY' }) : null));
  let leftover: string[] = [];
  try {
    const [outcome] = (await protectItems([{ path: broken }])).outcomes;
    assert.equal(outcome.code, 'CAPSULE_COPY_FAILED', outcome.detail);
    const ids = await known();
    leftover = folders().filter((name) => !ids.has(name));
    assert.equal(leftover.length, 1, `the half-made copy's folder is still there (${leftover.join(', ')})`);
  } finally {
    unfault();
  }
  try {
    const [outcome] = (await protectItems([{ path: next }])).outcomes;
    assert.equal(outcome.protected, true, outcome.detail);
  } finally {
    uncleanup();
  }
  assert.equal(fs.existsSync(path.join(capsuleRoot(), leftover[0])), false, 'the next capture removed it');
  assert.ok(fs.existsSync(broken), 'and the item whose copy failed is untouched');
});
