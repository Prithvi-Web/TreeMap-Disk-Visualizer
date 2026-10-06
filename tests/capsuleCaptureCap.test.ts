import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-capsuleCaptureCap-data-');
process.env.TREEMAP_NO_GDU = '1';

import {
  capsuleRoot, capsuleStoreWaitersForTests, deleteCapsuleEntry, getCapsuleIndex, protectItems, pruneExpired, setCaptureCleanupFaultForTests, setSourceCallForTests,
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

/* ─────────────── FG3g review F2.12: every other call on the item has the limit too ─────────────── */

const NO_LINKS = process.platform === 'win32' ? 'a link needs a privilege on Windows' : false;

/** A folder holding `inner.txt` and a link `link` to it. */
function folderWithLink(label: string): { dir: string; link: string } {
  const { dir } = folder(label);
  const link = path.join(dir, 'link');
  fs.symlinkSync('inner.txt', link);
  return { dir, link };
}

interface CallCase {
  name: string;
  skip?: string | false;
  /** The item to delete, and the one call on it that gets no answer: its kind, path and order. */
  make: () => { item: string; what: string; abs: string; nth: number };
  /** What the run says of the item, left in place, once that call's limit passed. */
  expect: { code: string; reason: RegExp };
}

const manifestOf = (entryId: string): { members: { rel: string; targetIsDir?: boolean }[]; rootMtimeMs?: number } =>
  JSON.parse(fs.readFileSync(path.join(capsuleRoot(), entryId, 'manifest.json'), 'utf8')) as { members: { rel: string; targetIsDir?: boolean }[]; rootMtimeMs?: number };

const CALL_CASES: CallCase[] = [
  {
    name: 'the listing of a folder being walked',
    make: () => { const { dir } = folder('call-readdir'); return { item: dir, what: 'readdir', abs: dir, nth: 0 }; },
    expect: { code: 'CAPSULE_UNREADABLE', reason: /made no progress for 60 seconds/ },
  },
  {
    name: 'the walk\'s read of a link inside the item',
    skip: NO_LINKS,
    make: () => { const { dir, link } = folderWithLink('call-member-link'); return { item: dir, what: 'readlink', abs: link, nth: 0 }; },
    expect: { code: 'CAPSULE_UNREADABLE', reason: /could not read the link link, inside it \(the disk did not answer/ },
  },
  {
    name: 'the walk\'s read of an item that is itself a link',
    skip: NO_LINKS,
    make: () => {
      const alias = path.join(fileTempDir('treemap-capsuleCaptureCap-call-root-link-'), 'alias');
      fs.symlinkSync('somewhere-else', alias);
      return { item: alias, what: 'readlink', abs: alias, nth: 0 };
    },
    expect: { code: 'CAPSULE_UNREADABLE', reason: /made no progress for 60 seconds/ },
  },
  {
    name: 'the capture\'s read of a link it is copying',
    skip: NO_LINKS,
    make: () => { const { dir, link } = folderWithLink('call-copy-link'); return { item: dir, what: 'readlink', abs: link, nth: 1 }; },
    expect: { code: 'CAPSULE_COPY_FAILED', reason: /could not be copied into the Time Capsule \(looking at .* made no progress for 60 seconds\)/ },
  },
  // These two only record something, and a look that fails at once still only leaves it unrecorded
  // (below). No answer within the limit fails the item, as every other call on it does (FG3g review
  // F3.1): read as "nothing to record", the capture went on to ask the next link the same quiet
  // volume — one more call left waiting per link, a minute each with the index held.
  {
    name: 'the capture\'s look at what a link leads to (which only records whether it is a folder)',
    skip: NO_LINKS,
    make: () => { const { dir, link } = folderWithLink('call-link-target'); return { item: dir, what: 'stat', abs: link, nth: 0 }; },
    expect: { code: 'CAPSULE_COPY_FAILED', reason: /could not be copied into the Time Capsule \(looking at .*link made no progress for 60 seconds\)/ },
  },
  {
    name: 'the capture\'s look at a folder\'s own times (which only records them)',
    make: () => { const { dir } = folder('call-root-times'); return { item: dir, what: 'lstat', abs: dir, nth: 1 }; },
    expect: { code: 'CAPSULE_COPY_FAILED', reason: /could not be copied into the Time Capsule \(looking at .*proj made no progress for 60 seconds\)/ },
  },
  {
    name: 'the read of a link in the look right before the trash step',
    skip: NO_LINKS,
    make: () => { const { dir, link } = folderWithLink('call-look-link'); return { item: dir, what: 'readlink', abs: link, nth: 3 }; },
    // A link that could not be read again is a look that failed, not a link that changed (FG3g review F3.6).
    expect: { code: 'CAPSULE_UNREADABLE', reason: /could not be looked at again right before its deletion \(the disk did not answer/ },
  },
];

for (const c of CALL_CASES) {
  test(`a call on the item that gets no answer is stopped at the limit and the run goes on: ${c.name}`, { skip: c.skip ?? false }, async () => {
    await waitFor(() => abandonedCallsUnsettled() === 0, 'every earlier call left waiting returning');
    const { item, what, abs, nth } = c.make();
    const normal = file('call-next', 'normal.txt', 'an ordinary file after the item');
    const hold = holdCalls((w, a, n) => w === what && a === abs && n === nth);
    let result: Awaited<ReturnType<typeof commitCart>>;
    try {
      result = await withOpenFileCheck('clear', () => fireEachHeldCall(commitCart([item, normal]), hold));
    } finally {
      hold.answer();
      hold.remove();
    }
    await waitFor(() => abandonedCallsUnsettled() === 0, 'the call left waiting returning');
    assert.deepEqual(hold.calls, [{ what, abs }], 'that call was made, under its limit, once');
    assert.ok(result.trashed.includes(normal), 'the item after it was protected and deleted: the index was let go');
    assert.ok(!result.trashed.includes(item), 'the item was not deleted');
    assert.ok(fs.lstatSync(item), 'it is still in place');
    const row = result.skipped.find((s) => s.path === item);
    assert.ok(row, `it is named in skipped (${JSON.stringify(result.skipped)})`);
    assert.equal(row.code, c.expect.code, row.reason);
    assert.match(row.reason ?? '', c.expect.reason, row.reason);
  });
}

/**
 * The read of a link in the look right before the trash step, answered at once (FG3g review F3.6):
 * every failure of it was read as a different target, so a link that could not be read was reported
 * as one that "points somewhere else". Only a different target is that; a link gone since the walk is
 * a change of its own, and any other failure is a look that failed.
 */
const LOOK_LINK_ANSWERS: { name: string; code: string; expect: { code: string; reason: RegExp } }[] = [
  { name: 'gone since the walk', code: 'ENOENT', expect: { code: 'CAPSULE_CHANGED', reason: /it changed after it was copied \(link was removed\)/ } },
  { name: 'refused', code: 'EACCES', expect: { code: 'CAPSULE_UNREADABLE', reason: /could not be looked at again right before its deletion \((macOS would not let TreeMap|TreeMap is not allowed)/ } },
];

for (const answer of LOOK_LINK_ANSWERS) {
  test(`a link whose read right before the trash step is answered "${answer.name}" is left in place, and said to be so - never "points somewhere else"`, { skip: NO_LINKS }, async () => {
    const { dir, link } = folderWithLink(`look-link-${answer.code}`);
    let reads = 0;
    const remove = setSourceCallForTests((what, abs) => (what === 'readlink' && abs === link && reads++ === 3 // the walk's, the copy's, the look's own walk, then this one
      ? Promise.reject(Object.assign(new Error(`${answer.code} (a test)`), { code: answer.code }))
      : null));
    let result: Awaited<ReturnType<typeof commitCart>>;
    try {
      result = await withOpenFileCheck('clear', () => commitCart([dir]));
    } finally {
      remove();
    }
    assert.equal(reads, 4, 'the look right before the trash step read the link');
    assert.deepEqual(result.trashed, [], 'it was not deleted');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'it is still in place');
    const row = result.skipped.find((s) => s.path === dir);
    assert.equal(row?.code, answer.expect.code, row?.reason);
    assert.match(row?.reason ?? '', answer.expect.reason, row?.reason);
    assert.doesNotMatch(row?.reason ?? '', /points somewhere else/, row?.reason);
  });
}

test('a folder of links whose targets do not answer leaves one call waiting, not one per link: it is left undeleted, and the next item still goes (FG3g review F3.1)', { skip: NO_LINKS }, async () => {
  await waitFor(() => abandonedCallsUnsettled() === 0, 'every earlier call left waiting returning');
  const { dir } = folder('links-quiet');
  // Six links whose targets are on a volume that stopped answering: each look at where one leads is held.
  const links = Array.from({ length: 6 }, (_, i) => {
    const link = path.join(dir, `link${i}`);
    fs.symlinkSync('inner.txt', link);
    return link;
  });
  const normal = file('links-quiet-next', 'normal.txt', 'an ordinary file after the folder');
  const hold = holdCalls((what, abs) => what === 'stat' && links.includes(abs));
  let result: Awaited<ReturnType<typeof commitCart>>;
  try {
    result = await withOpenFileCheck('clear', () => fireEachHeldCall(commitCart([dir, normal]), hold));
    assert.equal(hold.calls.length, 1, `one look at where a link leads was left waiting, and no other was started on that item (${hold.asked.join(', ')})`);
  } finally {
    hold.answer();
    hold.remove();
  }
  await waitFor(() => abandonedCallsUnsettled() === 0, 'the call left waiting returning');
  const row = result.skipped.find((s) => s.path === dir);
  assert.equal(row?.code, 'CAPSULE_COPY_FAILED', JSON.stringify(result.skipped));
  assert.match(row?.reason ?? '', /made no progress for 60 seconds/, row?.reason);
  assert.ok(links.every((l) => fs.lstatSync(l).isSymbolicLink()), 'the folder is in place, whole');
  assert.deepEqual(result.trashed, [normal], 'and the item after it was protected and deleted, not refused for calls left waiting');
});

test('a look at where a link leads, or at a folder\'s own times, that fails at once - an answer, not a silence - still protects the item, with nothing recorded for it', { skip: NO_LINKS }, async () => {
  const { dir, link } = folderWithLink('looks-fail');
  const eio = (): Promise<never> => Promise.reject(Object.assign(new Error('an i/o error (a test)'), { code: 'EIO' }));
  let ofRoot = 0;
  const remove = setSourceCallForTests((what, abs) => {
    if (what === 'stat' && abs === link) return eio();
    if (what === 'lstat' && abs === dir && ofRoot++ === 1) return eio(); // the folder's own times, after the walk's own look
    return null;
  });
  let outcome: Awaited<ReturnType<typeof protectItems>>['outcomes'][number];
  try {
    [outcome] = (await protectItems([{ path: dir }])).outcomes;
  } finally {
    remove();
  }
  assert.equal(outcome.protected, true, outcome.detail);
  const manifest = manifestOf(outcome.entryId as string);
  const ofLink = manifest.members.find((m) => m.rel === 'link');
  assert.ok(ofLink, 'the link was copied');
  assert.equal(ofLink.targetIsDir, undefined, 'what it leads to, which could not be looked at, is not recorded');
  assert.equal(manifest.rootMtimeMs, undefined, 'nor the folder\'s own times');
  assert.ok(manifest.members.some((m) => m.rel === 'inner.txt'), 'and what it holds was copied');
});

/* ─────────────── FG3g review F2.13: the retry of a capture's leftover folder ─────────────── */

/** A capture whose copy fails and whose folder cannot be removed at once: that folder's name. */
async function leaveCaptureFolder(label: string): Promise<string> {
  const broken = file(label, 'broken.txt', 'an item whose copy fails part-way');
  const unfault = setCopyFaultForTests((dest) => (dest.startsWith(capsuleRoot()) && path.basename(dest) === 'broken.txt' ? new Error('the disk stopped answering (a test)') : null));
  let refusals = 0;
  const uncleanup = setCaptureCleanupFaultForTests(() => (refusals++ === 0 ? Object.assign(new Error('the folder is in use (a test)'), { code: 'EBUSY' }) : null));
  try {
    const before = new Set(fs.readdirSync(capsuleRoot()));
    const [outcome] = (await protectItems([{ path: broken }])).outcomes;
    assert.equal(outcome.code, 'CAPSULE_COPY_FAILED', outcome.detail);
    const left = fs.readdirSync(capsuleRoot()).filter((name) => !before.has(name));
    assert.equal(left.length, 1, `the half-made copy's folder is still there (${left.join(', ')})`);
    return left[0];
  } finally {
    unfault();
    uncleanup();
  }
}

const INDEX = (): string => path.join(path.dirname(capsuleRoot()), 'timecapsule.json');

test('a capture\'s folder that could not be removed at once is removed by the next expiry sweep too, not left until the next start', async () => {
  const leftover = await leaveCaptureFolder('sweep-retry');
  await pruneExpired();
  assert.equal(fs.existsSync(path.join(capsuleRoot(), leftover)), false, 'the expiry sweep removed it');
});

test('a folder a record names is never removed by that retry: only its place in the list of leftovers goes', async () => {
  const leftover = await leaveCaptureFolder('sweep-named');
  // A record naming that folder (as a record written by another TreeMap on the same app data would).
  const index = JSON.parse(fs.readFileSync(INDEX(), 'utf8')) as { entries: Record<string, unknown>[] };
  const planted = {
    id: leftover, name: 'named.txt', originalPath: path.join(fileTempDir('treemap-capsuleCaptureCap-sweep-named-orig-'), 'named.txt'),
    kind: 'file', sizeBytes: 1, heldBytes: 1, hasPayload: true, fileCount: 1, digest: '', capturedAt: Date.now(), runId: 'planted',
  };
  fs.writeFileSync(INDEX(), JSON.stringify({ ...index, entries: [...index.entries, planted] }));
  try {
    await pruneExpired();
    assert.ok(fs.existsSync(path.join(capsuleRoot(), leftover)), 'the folder a record names is kept');
  } finally {
    const now = JSON.parse(fs.readFileSync(INDEX(), 'utf8')) as { entries: { id: string }[] };
    fs.writeFileSync(INDEX(), JSON.stringify({ ...now, entries: now.entries.filter((e) => e.id !== leftover) }));
  }
  await pruneExpired();
  assert.ok(fs.existsSync(path.join(capsuleRoot(), leftover)), 'and it is no longer a leftover the retry removes: the next start\'s reconcile decides');
});
