import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-capsuleCapacity-data-');
process.env.TREEMAP_NO_GDU = '1';

import {
  capsuleRoot,
  deleteCapsuleEntry,
  getCapsuleIndex,
  getCapsuleJob,
  planEviction,
  protectItems,
  setAfterCopyVerifiedForTests,
  setCapsuleCapForTests,
  startCapsuleRestore,
} from '../src/services/timeCapsule';
import { setCopyFaultForTests } from '../src/utils/copyVerify';
import { setTrashStepForTests } from '../src/services/cleaner';
import { commitCart, planCartCommit, undoCartRun } from '../src/services/cartCommit';
import { approvePolicyForTests, getRun, listPolicies, runPolicy, savePolicies, undoRun } from '../src/services/autopilot';
import type { TimeCapsuleEntry } from '../src/models/types';
import { AppError } from '../src/middleware/errorHandler';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * FG3f #1 (CRITICAL). A batch bigger than the Time Capsule's cap evicted its OWN earlier copies to
 * make room for its later items, and then trashed those earlier items with no copy: `capture`
 * planned eviction over every entry, this batch's included, oldest first, and nothing looked again
 * before the trash step. Ten 2 GB items against a 15 GB cap trashed items 1–3 with no copy. A
 * chunked cart commit (one run, several requests) did the same to the previous chunk's items, which
 * were already in the Trash.
 *
 * The rule now: what a run still under way holds is never evicted, so a later item that does not
 * fit beside it is left undeleted (CAPSULE_FULL, in skipped[]) as AGENTS.md says; and right before
 * each item's trash step its copy is looked for — one that is gone leaves the item in place.
 *
 * The cap is a number here (setCapsuleCapForTests), so "three items the cap cannot hold" is exact on
 * any machine. Nothing reaches the machine's Trash: the trash step moves each file into this file's
 * own folder.
 */

const ITEM = 100_000;
const CAP = 250_000; // two items fit; a third does not
const FAKE_TRASH = fileTempDir('treemap-capsuleCapacity-trash-');
let trashCalls = 0;
/** Run inside the trash step, before it moves `p` (a test's stand-in for something else acting meanwhile). */
let duringTrash: ((p: string) => Promise<void>) | null = null;

before(() => {
  setCapsuleCapForTests(CAP);
  setTrashStepForTests(async (p) => {
    if (duringTrash) await duringTrash(p);
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashCalls++}-${path.basename(p)}`));
  });
});

after(() => {
  setTrashStepForTests(null);
  setCapsuleCapForTests(null);
});

beforeEach(async () => {
  duringTrash = null;
  // Each test starts from an empty capsule, so what it evicts is only what it made.
  for (const entry of (await getCapsuleIndex()).entries) await deleteCapsuleEntry(entry.id);
});

/** `names` in a fresh folder, ITEM bytes each, each its own content. */
function files(label: string, names: string[]): string[] {
  const dir = fileTempDir(`treemap-capsuleCapacity-${label}-`);
  return names.map((name, i) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.alloc(ITEM, i + 1));
    return p;
  });
}

async function restored(jobId: string): Promise<void> {
  await waitFor(() => getCapsuleJob(jobId)?.status !== 'running', `the restore ${jobId}`);
  const job = getCapsuleJob(jobId);
  assert.equal(job?.status, 'complete', job?.error ?? 'the restore finished');
}

async function entriesOf(runId: string): Promise<TimeCapsuleEntry[]> {
  return (await getCapsuleIndex()).entries.filter((e) => e.runId === runId);
}

/** Every trashed path has its copy, held, in the run's own entries. */
async function assertEveryTrashedItemHasItsCopy(runId: string, trashed: string[]): Promise<void> {
  const held = new Map((await entriesOf(runId)).map((e) => [e.originalPath, e]));
  for (const p of trashed) {
    const entry = held.get(p);
    assert.ok(entry, `${path.basename(p)} was trashed and the run holds an entry for it`);
    assert.equal(entry.hasPayload, true, `${path.basename(p)} was trashed, and its copy was evicted: it was deleted with no copy`);
    assert.ok(fs.existsSync(path.join(capsuleRoot(), entry.id, 'manifest.json')), `the copy of ${path.basename(p)} is on disk`);
  }
}

const sorted = (list: string[]): string[] => [...list].sort();

test('the pure rule: what is pinned counts toward the cap and is never evicted, and an item that cannot fit beside it evicts nothing', () => {
  // `mine-1` is the oldest of all: pinned is never evicted, whatever its age.
  const entries = [
    { id: 'mine-1', runId: 'this', capturedAt: 0, heldBytes: 100_000, hasPayload: true },
    { id: 'old', runId: 'earlier', capturedAt: 1, heldBytes: 100_000, hasPayload: true },
    { id: 'mine-2', runId: 'this', capturedAt: 3, heldBytes: 100_000, hasPayload: true },
  ] as unknown as TimeCapsuleEntry[];
  const pinned = (e: TimeCapsuleEntry): boolean => e.runId === 'this';
  // 300 KB held, 250 KB cap: the run's own 200 KB plus 100 KB more cannot fit whatever is evicted.
  assert.deepEqual(planEviction(entries, CAP, ITEM, pinned), { evict: [], fits: false },
    'refused, and the older copy is not dropped for an item that still would not fit');
  // 50 KB fits once the older copy goes — and only the older copy goes.
  const room = planEviction(entries, CAP, 50_000, pinned);
  assert.equal(room.fits, true);
  assert.deepEqual(room.evict.map((e) => e.id), ['old'], 'the oldest copy that is not pinned, and nothing pinned');
  // With nothing pinned the old rule stands: oldest first.
  assert.deepEqual(planEviction(entries, CAP, 50_000).evict.map((e) => e.id), ['mine-1']);
});

test('a batch the cap cannot hold whole: the later item is left in place, and nothing is trashed without its copy', async () => {
  const [a, b, c] = files('batch', ['a.bin', 'b.bin', 'c.bin']);
  const result = await withOpenFileCheck('clear', () => commitCart([a, b, c]));

  assert.deepEqual(sorted(result.trashed), sorted([a, b]), 'the two that fit were trashed');
  await assertEveryTrashedItemHasItsCopy(result.runId, result.trashed);
  const left = result.skipped.find((s) => s.path === c);
  assert.ok(left, `the third is named in skipped (${JSON.stringify(result.skipped)})`);
  assert.equal(left.code, 'CAPSULE_FULL');
  assert.match(left.reason ?? '', /left alone rather than deleted without a backup/);
  // What holds the room is named, and only that (FG3h D): this run's own copies.
  assert.match(left.reason ?? '', /200\.0 KB of copies of items whose deletion is still under way/, left.reason);
  assert.doesNotMatch(left.reason ?? '', /being restored|could not be confirmed/, left.reason);
  assert.ok(fs.existsSync(c), 'the third is still where it was');
  assert.equal(result.bytesFreed, 2 * ITEM);

  const job = await undoCartRun(result.runId);
  assert.equal(job.entryCount, 2, 'the undo puts back both trashed items');
  await restored(job.jobId);
  for (const [p, fill] of [[a, 1], [b, 2]] as const) {
    assert.ok(fs.readFileSync(p).equals(Buffer.alloc(ITEM, fill)), `${path.basename(p)} is back, byte for byte`);
  }
});

test('a chunked cart commit: the next chunk of the same run never evicts the copies of the chunk already in the Trash', async () => {
  const [a, b, c] = files('chunks', ['a.bin', 'b.bin', 'c.bin']);
  const first = await withOpenFileCheck('clear', () => commitCart([a, b]));
  assert.deepEqual(sorted(first.trashed), sorted([a, b]));
  const second = await withOpenFileCheck('clear', () => commitCart([c], first.runId));
  assert.equal(second.runId, first.runId, 'one run');
  assert.deepEqual(second.trashed, [], 'the next chunk trashed nothing');
  assert.equal(second.skipped[0]?.code, 'CAPSULE_FULL', JSON.stringify(second.skipped));
  assert.ok(fs.existsSync(c), 'and left its item in place');
  await assertEveryTrashedItemHasItsCopy(first.runId, first.trashed);

  const job = await undoCartRun(first.runId);
  assert.equal(job.entryCount, 2, 'the first chunk can still be put back whole');
  await restored(job.jobId);
  assert.ok(fs.existsSync(a) && fs.existsSync(b));
});

test('the dry run gives the same verdict: never more than the cap, and the copies it would drop are never this batch\'s own', async () => {
  // An older copy, from an earlier run, that the batch may evict.
  const [old] = files('old', ['old.bin']);
  const earlier = await protectItems([{ path: old }]);
  assert.equal(earlier.outcomes[0].protected, true);
  const oldId = earlier.outcomes[0].entryId;

  const [a, b, c] = files('plan', ['a.bin', 'b.bin', 'c.bin']);
  const plan = await planCartCommit([a, b, c]);
  assert.deepEqual(plan.items.map((i) => [path.basename(i.path), i.willDelete]), [['a.bin', true], ['b.bin', true], ['c.bin', false]]);
  assert.equal(plan.items[2].code, 'CAPSULE_FULL');
  // Naming what holds the room and only that (FG3g review F2.14) — in a dry run, the copies the items
  // planned before it would take: nothing is copied yet, and no deletion is under way (hunt S1).
  assert.match(plan.items[2].reason ?? '', /200\.0 KB would go to the copies of the items planned before it/, plan.items[2].reason);
  assert.doesNotMatch(plan.items[2].reason ?? '', /under way/, plan.items[2].reason);
  assert.doesNotMatch(plan.items[2].reason ?? '', /being restored|could not be confirmed/, plan.items[2].reason);
  assert.ok(plan.bytesWouldFree <= plan.capsule.capBytes, `${plan.bytesWouldFree} planned against a ${plan.capsule.capBytes} cap`);
  assert.deepEqual(plan.evicts.map((e) => e.id), [oldId], 'only the older copy is named as dropped');

  // Planned in two requests, the second carrying what the first would leave: the same verdict.
  const part1 = await planCartCommit([a, b]);
  const part2 = await planCartCommit([c], part1.carryOver);
  assert.equal(part2.items[0].willDelete, false);
  assert.equal(part2.items[0].code, 'CAPSULE_FULL');
  assert.deepEqual(part2.evicts, [], 'the second request names none of the first request\'s items as dropped');
  assert.ok(part1.bytesWouldFree + part2.bytesWouldFree <= CAP);

  // And the real run does what the plan said.
  const result = await withOpenFileCheck('clear', () => commitCart([a, b, c]));
  assert.deepEqual(sorted(result.trashed), sorted([a, b]));
  assert.ok(fs.existsSync(c));
  await assertEveryTrashedItemHasItsCopy(result.runId, result.trashed);
});

test('a copy that is gone by the item\'s own trash step leaves the item in place, and says so', async () => {
  const [first, second] = files('gone', ['first.bin', 'second.bin']);
  // Something outside this run — another TreeMap process sharing the app data, say — removes the
  // second item's copy while the first is being trashed.
  duringTrash = async (p) => {
    if (p !== first) return;
    const entry = (await getCapsuleIndex()).entries.find((e) => e.originalPath === second);
    assert.ok(entry, 'the second item was copied');
    fs.rmSync(path.join(capsuleRoot(), entry.id), { recursive: true, force: true });
  };
  const result = await withOpenFileCheck('clear', () => commitCart([first, second]));
  assert.deepEqual(result.trashed, [first]);
  assert.ok(fs.existsSync(second), 'the item whose copy went is still where it was');
  const row = result.skipped.find((s) => s.path === second);
  assert.equal(row?.code, 'CAPSULE_COPY_GONE', JSON.stringify(result.skipped));
  assert.match(row?.reason ?? '', /copy is no longer there/);
  assert.doesNotMatch(row?.reason ?? '', /its copy was discarded/, 'a copy that was gone is not said to be discarded');
  assert.equal((await entriesOf(result.runId)).some((e) => e.originalPath === second), false,
    'and the run keeps no record of a copy it does not hold');
  await assertEveryTrashedItemHasItsCopy(result.runId, result.trashed);
});

test('a run\'s copies stay pinned through its trash step: a commit made meanwhile cannot evict them', async () => {
  const [a1, a2] = files('pinned-a', ['a1.bin', 'a2.bin']);
  const [b] = files('pinned-b', ['b.bin']);
  let meanwhile: Awaited<ReturnType<typeof commitCart>> | null = null;
  // While the first run trashes its first item, a second commit needs room the first run's copies
  // fill: the oldest copies in the capsule are the first run's.
  duringTrash = async (p) => {
    if (p !== a1) return;
    duringTrash = null;
    meanwhile = await commitCart([b]);
  };
  const first = await withOpenFileCheck('clear', () => commitCart([a1, a2]));
  assert.deepEqual(sorted(first.trashed), sorted([a1, a2]));
  await assertEveryTrashedItemHasItsCopy(first.runId, first.trashed);
  assert.ok(meanwhile, 'the second commit ran during the first one\'s trash step');
  const second = meanwhile as Awaited<ReturnType<typeof commitCart>>;
  assert.deepEqual(second.trashed, [], 'the second commit trashed nothing');
  assert.equal(second.skipped[0]?.code, 'CAPSULE_FULL', JSON.stringify(second.skipped));
  assert.ok(fs.existsSync(b));
});

/* ─────────────── FG3f #3: an undo of a run whose copy is gone says so ─────────────── */

test('a cart undo of a commit whose copy was evicted since puts back what it holds, and names the item it cannot', async () => {
  const [a, b] = files('partial', ['a.bin', 'b.bin']);
  const first = await withOpenFileCheck('clear', () => commitCart([a, b]));
  assert.deepEqual(sorted(first.trashed), sorted([a, b]));
  // A later commit needs room, and the first commit's oldest copy is evicted for it.
  const [c] = files('partial-later', ['c.bin']);
  const later = await withOpenFileCheck('clear', () => commitCart([c]));
  assert.deepEqual(later.trashed, [c]);
  const lostPath = (await entriesOf(first.runId)).find((e) => !e.hasPayload)?.originalPath;
  assert.ok(lostPath, 'one of the first commit\'s copies was evicted');

  const undo = await undoCartRun(first.runId);
  assert.equal(undo.entryCount, 1, 'the copy still held is put back');
  assert.deepEqual(undo.unrestorable?.map((u) => u.path), [lostPath], 'and the one it no longer holds is named');
  assert.match(undo.unrestorable?.[0].reason ?? '', /copy is gone/);
  await restored(undo.jobId);
  const kept = lostPath === a ? b : a;
  assert.ok(fs.existsSync(kept), 'the held one is back');
  assert.ok(!fs.existsSync(lostPath), 'and the lost one is not');
  // Asked again, it answers that it is undone as far as it can be (FG3f #11), not that the capsule lost it.
  await assert.rejects(() => undoCartRun(first.runId), (err: unknown) => {
    assert.ok(err instanceof AppError, String(err));
    assert.equal(err.code, 'ALREADY_UNDONE', err.message);
    assert.match(err.message, /1 item could not be put back/, err.message);
    return true;
  });
});

test('an Autopilot undo of a run whose copy was evicted since names the item it cannot put back, and leaves the run not undone', async () => {
  const dir = fileTempDir('treemap-capsuleCapacity-partial-run-');
  for (const [name, fill] of [['a.bin', 1], ['b.bin', 2]] as const) fs.writeFileSync(path.join(dir, name), Buffer.alloc(ITEM, fill));
  await savePolicies([{ id: 'partial', name: 'partial', path: dir, match: { kind: 'custom', minBytes: 1 }, dryRunFirst: false, enabled: true }]);
  try {
    await approvePolicyForTests('partial');
    const policy = (await listPolicies()).find((p) => p.id === 'partial');
    assert.ok(policy);
    const run = await withOpenFileCheck('clear', () => runPolicy(policy));
    assert.equal(run.status, 'completed', run.blockedReason);
    assert.equal(run.items.length, 2);
    const [c] = files('partial-run-later', ['c.bin']);
    await withOpenFileCheck('clear', () => commitCart([c]));

    const undo = await undoRun(run.id);
    assert.equal(undo.entryCount, 1);
    assert.equal(undo.unrestorable?.length, 1, JSON.stringify(undo));
    await restored(undo.jobId);
    assert.equal((await getRun(run.id))?.undoneAt, undefined, 'one of its items is not back, so the run is not recorded as undone');
    await assert.rejects(() => undoRun(run.id), (err: unknown) => {
      assert.ok(err instanceof AppError, String(err));
      assert.equal(err.code, 'ALREADY_UNDONE', err.message);
      return true;
    });
  } finally {
    await savePolicies([]);
  }
});

/* ─────────────── FG3h A3: a capture evicts only once its own copy is whole ─────────────── */

/** Protects each path in its own capture, oldest first: the copies' ids. */
async function protectEach(paths: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const p of paths) {
    const { outcomes } = await protectItems([{ path: p }]);
    assert.equal(outcomes[0].protected, true, outcomes[0].detail);
    ids.push(outcomes[0].entryId as string);
  }
  return ids;
}

const held = async (id: string): Promise<boolean | undefined> => (await getCapsuleIndex()).entries.find((e) => e.id === id)?.hasPayload;

test('a capture whose copy fails evicts nothing: the older copies it needed room from are all still held (FG3h A3)', async () => {
  const [o1, o2, s] = files('a3-fails', ['o1.bin', 'o2.bin', 's.bin']);
  const [id1, id2] = await protectEach([o1, o2]); // the capsule is full: s fits only by evicting o1
  const unfault = setCopyFaultForTests((dest) => (path.basename(dest) === 's.bin' ? new Error('the disk stopped answering (a test)') : null));
  let outcome: Awaited<ReturnType<typeof protectItems>>['outcomes'][number];
  try {
    [outcome] = (await protectItems([{ path: s }])).outcomes;
  } finally {
    unfault();
  }
  assert.equal(outcome.protected, false);
  assert.equal(outcome.code, 'CAPSULE_COPY_FAILED', outcome.detail);
  assert.equal(await held(id1), true, 'the oldest copy, which would have made room, is still held');
  assert.equal(await held(id2), true);
  assert.ok(fs.existsSync(path.join(capsuleRoot(), id1, 'manifest.json')), 'and still on disk');
  const events = (await getCapsuleIndex()).events.filter((e) => e.kind === 'evicted' && e.originalPath === o1);
  assert.deepEqual(events, [], 'nothing was evicted for an item that was then not protected');
});

test('a capture that must make room evicts only once its copy is whole: while it copies, the older copy is still held', async () => {
  const [o1, o2, s] = files('a3-order', ['o1.bin', 'o2.bin', 's.bin']);
  const [id1, id2] = await protectEach([o1, o2]);
  let duringCopy: { onDisk: boolean } | null = null;
  const unfault = setCopyFaultForTests((dest) => {
    if (duringCopy === null && path.basename(dest) === 's.bin') duringCopy = { onDisk: fs.existsSync(path.join(capsuleRoot(), id1, 'manifest.json')) };
    return null;
  });
  let outcome: Awaited<ReturnType<typeof protectItems>>['outcomes'][number];
  try {
    [outcome] = (await protectItems([{ path: s }])).outcomes;
  } finally {
    unfault();
  }
  assert.deepEqual(duringCopy, { onDisk: true }, 'while s was copied, the copy it then evicted was still there');
  assert.equal(outcome.protected, true, outcome.detail);
  assert.equal(await held(id1), false, 'once s\'s copy was whole, the oldest copy went to make room');
  assert.equal(await held(id2), true);
});

test('a copy that no longer fits once it is whole - a restore took the room meanwhile - is discarded, and nothing is evicted', async () => {
  const [o1, o2, s] = files('a3-replan', ['o1.bin', 'o2.bin', 's.bin']);
  const [id1, id2] = await protectEach([o1, o2]);
  fs.rmSync(o1);
  fs.rmSync(o2); // the capsule holds their only copies
  let jobId = '';
  let copied = '';
  const unhook = setAfterCopyVerifiedForTests(async (entryId) => {
    copied = entryId;
    // The person presses Undo for o1 and o2 while s is being protected, after s's copy was planned to fit.
    jobId = (await startCapsuleRestore([id1, id2])).jobId;
  });
  let outcome: Awaited<ReturnType<typeof protectItems>>['outcomes'][number];
  try {
    [outcome] = (await protectItems([{ path: s }])).outcomes;
  } finally {
    unhook();
  }
  assert.equal(outcome.protected, false, 'it fits only by evicting copies being restored');
  assert.equal(outcome.code, 'CAPSULE_FULL', outcome.detail);
  assert.match(outcome.detail ?? '', /being restored/, outcome.detail);
  assert.ok(copied !== '' && !fs.existsSync(path.join(capsuleRoot(), copied)), 'its copy, whole but with no room, is not kept');
  assert.ok(fs.existsSync(s), 's is untouched');
  await restored(jobId);
  assert.ok(fs.readFileSync(o1).equals(Buffer.alloc(ITEM, 1)), 'o1 is back, from the copy nothing evicted');
  assert.ok(fs.readFileSync(o2).equals(Buffer.alloc(ITEM, 2)), 'and o2');
});

/* ─────────────── FG3h D: "Forget" never takes a copy a deletion run under way relies on ─────────────── */

test('"Forget" refuses the copy of an item whose deletion is under way: asked at its very trash step, the item still goes with its copy held', async () => {
  const [a, b] = files('forget-in-flight', ['a.bin', 'b.bin']);
  let refused: unknown = null;
  duringTrash = async (p) => {
    if (p !== b) return;
    // After b's own look right before its trash step, and before the move: the person presses Forget on b.
    const entry = (await getCapsuleIndex()).entries.find((e) => e.originalPath === b);
    assert.ok(entry);
    refused = await deleteCapsuleEntry(entry.id).then(() => null, (err: unknown) => err);
  };
  const result = await withOpenFileCheck('clear', () => commitCart([a, b]));
  assert.ok(refused instanceof AppError, `Forget was refused (${String(refused)})`);
  assert.equal(refused.code, 'DELETION_RUNNING', refused.message);
  assert.match(refused.message, /deletion that is still under way/, refused.message);
  assert.deepEqual(sorted(result.trashed), sorted([a, b]));
  await assertEveryTrashedItemHasItsCopy(result.runId, result.trashed);
  const entry = (await getCapsuleIndex()).entries.find((e) => e.originalPath === b);
  assert.ok(entry);
  assert.deepEqual(await deleteCapsuleEntry(entry.id), { deleted: true, bytesFreed: ITEM }, 'once the deletion is over, it can be forgotten');
});

/* ─────────────── FG3g review F2.3: a capture that fails while making room keeps no orphan copy ─────────────── */

const SKIP_MODES = process.platform === 'win32'
  ? 'a folder\'s permissions do not stop a removal on Windows'
  : process.getuid?.() === 0 ? 'running as root, a folder\'s mode stops nothing' : false;

test('a capture whose making room fails once its copy is whole removes that copy: no folder of it is left beside the index', { skip: SKIP_MODES }, async () => {
  const [o1, o2, s] = files('a3-room-fails', ['o1.bin', 'o2.bin', 's.bin']);
  const [id1, id2] = await protectEach([o1, o2]); // the capsule is full: s fits only by evicting o1
  const locked = path.join(capsuleRoot(), id1, 'data');
  fs.chmodSync(locked, 0o555); // o1's copy cannot be removed: making room for s fails
  try {
    await assert.rejects(protectItems([{ path: s }]), (err: unknown) => {
      assert.equal((err as NodeJS.ErrnoException).code, 'EACCES', String(err));
      return true;
    });
  } finally {
    fs.chmodSync(locked, 0o755);
  }
  assert.deepEqual(fs.readdirSync(capsuleRoot()).sort(), [id1, id2].sort(), 'no copy of s is left on disk, where nothing would count it or remove it until the next start');
  assert.deepEqual((await getCapsuleIndex()).entries.map((e) => e.id).sort(), [id1, id2].sort(), 'and the index records none');
  assert.ok(fs.readFileSync(s).equals(Buffer.alloc(ITEM, 3)), 's is untouched');
});

/* ─────────────── FG3g review F2.10: an item that cannot fit is refused before anything is copied ─────────────── */

/** Counts the reads of each copy into the capsule of a file named `name` (each chunk read is one). */
function countCopiesOf(name: string): { chunks: () => number; remove: () => void } {
  let chunks = 0;
  const remove = setCopyFaultForTests((dest) => {
    if (dest.startsWith(capsuleRoot()) && path.basename(dest) === name) chunks++;
    return null;
  });
  return { chunks: () => chunks, remove };
}

test('an item bigger than the whole capsule is refused without a byte of it copied', async () => {
  const big = path.join(fileTempDir('treemap-capsuleCapacity-too-big-'), 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(CAP + ITEM, 7));
  const counted = countCopiesOf('big.bin');
  let outcome: Awaited<ReturnType<typeof protectItems>>['outcomes'][number];
  try {
    [outcome] = (await protectItems([{ path: big }])).outcomes;
  } finally {
    counted.remove();
  }
  assert.equal(outcome.code, 'CAPSULE_FULL', outcome.detail);
  assert.equal(counted.chunks(), 0, 'nothing of it was copied into the capsule: no copy is made that cannot be kept');
});

test('an item that cannot fit beside the copies its own run holds is refused without a byte of it copied', async () => {
  const [a, b, c] = files('no-copy-pinned', ['a.bin', 'b.bin', 'c.bin']);
  const counted = countCopiesOf('c.bin');
  let result: Awaited<ReturnType<typeof commitCart>>;
  try {
    result = await withOpenFileCheck('clear', () => commitCart([a, b, c]));
  } finally {
    counted.remove();
  }
  assert.equal(result.skipped.find((s) => s.path === c)?.code, 'CAPSULE_FULL', JSON.stringify(result.skipped));
  assert.equal(counted.chunks(), 0, 'nothing of it was copied: the room beside the run\'s own copies was planned first');
  assert.ok(fs.existsSync(c));
});
