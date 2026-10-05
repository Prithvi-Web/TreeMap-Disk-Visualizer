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
  setCapsuleCapForTests,
} from '../src/services/timeCapsule';
import { setTrashStepForTests } from '../src/services/cleaner';
import { commitCart, planCartCommit, undoCartRun } from '../src/services/cartCommit';
import { approvePolicy, getRun, listPolicies, runPolicy, savePolicies, undoRun } from '../src/services/autopilot';
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
    await approvePolicy('partial');
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
