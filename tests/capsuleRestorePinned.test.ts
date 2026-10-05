import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-capsuleRestorePinned-data-');
process.env.TREEMAP_NO_GDU = '1';

import {
  cancelCapsuleJob,
  capsulePayloadWaitersForTests,
  capsuleRoot,
  capsuleStoreWaitersForTests,
  deleteCapsuleEntry,
  getCapsuleIndex,
  getCapsuleJob,
  protectItems,
  pruneExpired,
  setAfterIndexLoadForTests,
  setBeforeEvictionForTests,
  setCapsuleCapForTests,
  startCapsuleRestore,
} from '../src/services/timeCapsule';
import { CommandStopped, setTrashStepForTests } from '../src/services/cleaner';
import { commitCart, planCartCommit } from '../src/services/cartCommit';
import { setCopyFaultForTests, setHardLinkForTests } from '../src/utils/copyVerify';
import { undoCartRun } from '../src/services/cartCommit';
import { AppError } from '../src/middleware/errorHandler';
import type { TimeCapsuleEntry } from '../src/models/types';
import { waitFor, withinHangGuard } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * FG3g H1 (HIGH). A restore job reads each copy it puts back from the Time Capsule — and nothing kept
 * that copy for it. Only the copies of deletion runs under way were pinned, so while a restore was
 * running, a capture could evict a copy it had not reached yet, "Forget" could remove one, and the
 * hourly expiry could sweep one: the restore then stopped on a missing file, and the copy it was
 * putting back — after the Trash was emptied, the only one — was gone (repro R1 of the FG3f review).
 *
 * Now every copy a restore holds is pinned from the moment the restore is accepted until its job
 * ends, however it ends: a capture never evicts it (the item that needed the room is left undeleted,
 * CAPSULE_FULL), Forget refuses it (RESTORE_RUNNING), the expiry passes over it until a later sweep,
 * and a second restore of it is refused. A restore is accepted under the same lock every removal of
 * a copy takes, so it never accepts a copy whose removal is under way.
 *
 * Nothing here times anything: a restore is held at a known point (its first file's placement, or
 * its bookkeeping waiting for the index), and the test waits on conditions. Nothing reaches the
 * machine's Trash: the trash step moves each file into this file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-capsuleRestorePinned-trash-');
let trashCalls = 0;

before(() => {
  setTrashStepForTests(async (p) => {
    // A name starting "late": the step is stopped at its time limit, the file left in place — so
    // the run keeps its copy as unconfirmed.
    if (path.basename(p).startsWith('late')) throw new CommandStopped('osascript was stopped at its time limit (a test)');
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashCalls++}-${path.basename(p)}`));
  });
});

after(() => {
  setTrashStepForTests(null);
});

const ITEM = 100_000;

/** A file of ITEM bytes, each `fill`, in a folder of its own. */
function item(label: string, name: string, fill: number): string {
  const p = path.join(fileTempDir(`treemap-capsuleRestorePinned-${label}-`), name);
  fs.writeFileSync(p, Buffer.alloc(ITEM, fill));
  return p;
}

/** Protects each path in turn, one capture each, oldest first: the copies' ids. */
async function protectEach(paths: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const p of paths) {
    const { outcomes } = await protectItems([{ path: p }]);
    assert.equal(outcomes[0].protected, true, outcomes[0].detail);
    ids.push(outcomes[0].entryId as string);
  }
  return ids;
}

async function entry(id: string): Promise<TimeCapsuleEntry | undefined> {
  return (await getCapsuleIndex()).entries.find((e) => e.id === id);
}

async function settled(jobId: string): Promise<NonNullable<ReturnType<typeof getCapsuleJob>>> {
  await waitFor(() => getCapsuleJob(jobId)?.status !== 'running', `the restore ${jobId} settling`);
  const job = getCapsuleJob(jobId);
  assert.ok(job);
  return job;
}

/**
 * Holds every restore at its first file's placement until `release` is called: `reached` resolves
 * when one gets there. The placement then goes ahead as it would have.
 */
function holdAtPlacement(): { reached: Promise<void>; release: () => void; remove: () => void } {
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  const remove = setHardLinkForTests(async (existing, link) => {
    if (!held) {
      held = true;
      arrive();
      await gate;
    }
    await fs.promises.link(existing, link);
  });
  return { reached, release, remove };
}

const refusedWith = (code: string) => (err: unknown): boolean => {
  assert.ok(err instanceof AppError, String(err));
  assert.equal(err.code, code, err.message);
  return true;
};

/* ─────────────── a capture ─────────────── */

test('a capture never evicts a copy a running restore has not reached yet: the item that needed the room is left undeleted (FG3f review R1)', async () => {
  const uncap = setCapsuleCapForTests(250_000);
  try {
    const a = item('r1', 'a.bin', 1);
    const b = item('r1', 'b.bin', 2);
    const c = item('r1', 'c.bin', 3);
    const [idA, idB] = await protectEach([a, b]); // A is the oldest copy
    fs.rmSync(a);
    fs.rmSync(b); // as if trashed and the Trash emptied: the capsule holds the only copies
    let jobId = '';
    // The person presses Undo for [B, A] while a deletion run is capturing C: B comes back first, and
    // its bookkeeping then waits for the index, which the capture holds.
    const unhook = setAfterIndexLoadForTests(async () => {
      jobId = (await startCapsuleRestore([idB, idA])).jobId;
      await waitFor(() => capsuleStoreWaitersForTests() > 0 || getCapsuleJob(jobId)?.status !== 'running', 'B\'s bookkeeping waiting for the index');
    });
    let captured: Awaited<ReturnType<typeof protectItems>> | undefined;
    try {
      captured = await protectItems([{ path: c }]);
    } finally {
      unhook();
    }
    const job = await settled(jobId);
    assert.equal(job.status, 'complete', `the restore of a copy that was evicted under it: ${job.error}`);
    assert.ok(fs.readFileSync(a).equals(Buffer.alloc(ITEM, 1)), 'A is back, byte for byte');
    assert.ok(fs.readFileSync(b).equals(Buffer.alloc(ITEM, 2)), 'and B');
    assert.ok(captured);
    const outcome = captured.outcomes[0];
    assert.equal(outcome.protected, false, 'C could only fit by evicting a copy being restored, so it was not protected');
    assert.equal(outcome.code, 'CAPSULE_FULL');
    assert.match(outcome.detail ?? '', /being restored/, 'and the sentence says what holds the room');
    assert.ok(fs.existsSync(c), 'C is untouched');
  } finally {
    uncap();
  }
});

test('a restore asked for while a capture is evicting that very copy is refused, never started on a copy being removed', async () => {
  const uncap = setCapsuleCapForTests(250_000);
  try {
    const a = item('evicting', 'a.bin', 16);
    const b = item('evicting', 'b.bin', 17);
    const c = item('evicting', 'c.bin', 18);
    const [idA] = await protectEach([a, b]); // A is the oldest copy, so the one evicted for C
    fs.rmSync(a); // the capsule holds its only copy
    let attempt: Promise<{ jobId?: string; code?: string }> | null = null;
    let answered = false;
    const unhook = setBeforeEvictionForTests(async (victims) => {
      assert.deepEqual(victims, [idA]);
      // The person presses Restore on A just as a deletion run has decided to evict it.
      attempt = startCapsuleRestore([idA]).then(
        (job) => ({ jobId: job.jobId }),
        (err: unknown) => ({ code: err instanceof AppError ? err.code : String(err) }),
      ).finally(() => { answered = true; });
      await waitFor(() => answered || capsulePayloadWaitersForTests() > 0, 'the restore being answered, or waiting for the eviction');
    });
    try {
      const captured = await protectItems([{ path: c }]);
      assert.equal(captured.outcomes[0].protected, true, 'C evicted A to fit');
    } finally {
      unhook();
    }
    assert.ok(attempt);
    const outcome = await (attempt as Promise<{ jobId?: string; code?: string }>);
    if (outcome.jobId) {
      const job = await settled(outcome.jobId);
      assert.fail(`a restore was started on a copy being evicted, and ended ${job.status}: ${job.error}`);
    }
    assert.equal(outcome.code, 'PAYLOAD_GONE', 'refused, saying the copy is gone (FG3g L1)');
  } finally {
    uncap();
  }
});

test('the dry run gives the same verdict while a restore runs: a copy being restored is never planned for eviction', async () => {
  const uncap = setCapsuleCapForTests(250_000);
  const hold = holdAtPlacement();
  try {
    const a = item('plan', 'a.bin', 4);
    const b = item('plan', 'b.bin', 5);
    const c = item('plan', 'c.bin', 6);
    const [idA, idB] = await protectEach([a, b]);
    fs.rmSync(a);
    fs.rmSync(b);
    const { jobId } = await startCapsuleRestore([idB, idA]);
    await withinHangGuard(hold.reached, 'the restore reaching its first placement');
    const plan = await planCartCommit([c]);
    assert.equal(plan.items[0].willDelete, false);
    assert.equal(plan.items[0].code, 'CAPSULE_FULL');
    assert.deepEqual(plan.evicts.map((e) => e.id).filter((id) => id === idA || id === idB), [], 'no copy being restored is planned for eviction');
    hold.release();
    assert.equal((await settled(jobId)).status, 'complete');
  } finally {
    hold.release();
    hold.remove();
    uncap();
  }
});

/* ─────────────── Forget, expiry, supersede ─────────────── */

test('"Forget" refuses a copy a running restore holds, and forgets it once the restore is over', async () => {
  const hold = holdAtPlacement();
  try {
    const a = item('forget', 'a.bin', 7);
    const b = item('forget', 'b.bin', 8);
    const [idA, idB] = await protectEach([a, b]);
    fs.rmSync(a);
    fs.rmSync(b);
    const { jobId } = await startCapsuleRestore([idA, idB]);
    await withinHangGuard(hold.reached, 'the restore reaching its first placement');
    await assert.rejects(deleteCapsuleEntry(idB), refusedWith('RESTORE_RUNNING'));
    assert.equal((await entry(idB))?.hasPayload, true, 'the copy the restore has not reached yet is still held');
    assert.ok(fs.existsSync(path.join(capsuleRoot(), idB)), 'and still on disk');
    hold.release();
    const job = await settled(jobId);
    assert.equal(job.status, 'complete', job.error);
    assert.ok(fs.readFileSync(b).equals(Buffer.alloc(ITEM, 8)), 'B is back');
    assert.deepEqual(await deleteCapsuleEntry(idB), { deleted: true, bytesFreed: 0 }, 'once the restore is over, its record can be forgotten');
  } finally {
    hold.release();
    hold.remove();
  }
});

test('the expiry sweep passes over a copy a running restore holds, and sweeps it on a later pass', async () => {
  const hold = holdAtPlacement();
  try {
    const a = item('expire', 'a.bin', 9);
    const b = item('expire', 'b.bin', 10);
    const [idA, idB] = await protectEach([a, b]);
    fs.rmSync(a);
    fs.rmSync(b);
    const { jobId } = await startCapsuleRestore([idA, idB]);
    await withinHangGuard(hold.reached, 'the restore reaching its first placement');
    const later = Date.now() + 1000 * 86_400_000; // everything has expired by then
    await pruneExpired(later);
    for (const id of [idA, idB]) {
      assert.equal((await entry(id))?.hasPayload, true, `${id}: a copy being restored is not swept`);
    }
    hold.release();
    const job = await settled(jobId);
    assert.equal(job.status, 'complete', job.error);
    assert.ok(fs.readFileSync(b).equals(Buffer.alloc(ITEM, 10)), 'B is back');
    await pruneExpired(later);
    assert.equal(await entry(idB), undefined, 'a later sweep, with the restore over, removes it');
  } finally {
    hold.release();
    hold.remove();
  }
});

test('an unconfirmed copy being restored is never dropped as superseded by a newer identical one', async () => {
  const dir = fileTempDir('treemap-capsuleRestorePinned-late-');
  const late = path.join(dir, 'late.txt');
  fs.writeFileSync(late, 'the content of late.txt');
  const first = await withOpenFileCheck('clear', () => commitCart([late]));
  assert.deepEqual((first.unverified ?? []).map((u) => u.path), [late], 'its trash step was not confirmed: its copy is kept');
  const older = (await getCapsuleIndex()).entries.find((e) => e.runId === first.runId);
  assert.ok(older);
  fs.rmSync(late); // the Trash took it after all: its place is empty
  const hold = holdAtPlacement();
  try {
    const { jobId } = await startCapsuleRestore([older.id]);
    await withinHangGuard(hold.reached, 'the restore reaching its placement');
    fs.writeFileSync(late, 'the content of late.txt'); // the same content, back at its place meanwhile
    const second = await withOpenFileCheck('clear', () => commitCart([late]));
    assert.deepEqual((second.unverified ?? []).map((u) => u.path), [late]);
    hold.release();
    const job = await settled(jobId);
    assert.equal(job.status, 'error', 'its place was taken meanwhile, so the restore stopped without writing over it');
    const kept = await entry(older.id);
    assert.equal(kept?.hasPayload, true, 'the copy it was reading is still held: it was not dropped as superseded while in use');
    assert.ok(fs.existsSync(path.join(capsuleRoot(), older.id)));
  } finally {
    hold.release();
    hold.remove();
  }
});

/* ─────────────── a second restore; letting go ─────────────── */

test('a second restore of a copy already being restored is refused, and the first finishes', async () => {
  const hold = holdAtPlacement();
  try {
    const a = item('twice', 'a.bin', 11);
    const [idA] = await protectEach([a]);
    fs.rmSync(a);
    const { jobId } = await startCapsuleRestore([idA]);
    await withinHangGuard(hold.reached, 'the restore reaching its placement');
    await assert.rejects(startCapsuleRestore([idA]), refusedWith('RESTORE_RUNNING'));
    hold.release();
    const job = await settled(jobId);
    assert.equal(job.status, 'complete', job.error);
    assert.ok(fs.readFileSync(a).equals(Buffer.alloc(ITEM, 11)));
  } finally {
    hold.release();
    hold.remove();
  }
});

test('the same copy asked for twice in one restore is put back once', async () => {
  const a = item('dup', 'a.bin', 15);
  const [idA] = await protectEach([a]);
  fs.rmSync(a);
  const job = await settled((await startCapsuleRestore([idA, idA])).jobId);
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.entryIds.length, 1);
  assert.ok(fs.readFileSync(a).equals(Buffer.alloc(ITEM, 15)));
});

test('a restore that fails lets go of its copies: they can be forgotten, evicted or restored again', async () => {
  const a = item('fails', 'a.bin', 12);
  const [idA] = await protectEach([a]);
  fs.rmSync(a);
  const unfault = setCopyFaultForTests(() => new Error('the disk stopped answering (a test)'));
  let jobId = '';
  try {
    jobId = (await startCapsuleRestore([idA])).jobId;
    assert.equal((await settled(jobId)).status, 'error');
  } finally {
    unfault();
  }
  const again = await startCapsuleRestore([idA]);
  const job = await settled(again.jobId);
  assert.equal(job.status, 'complete', job.error);
  assert.ok(fs.readFileSync(a).equals(Buffer.alloc(ITEM, 12)));
});

test('a restore that is cancelled lets go of the copies it did not put back', async () => {
  const hold = holdAtPlacement();
  try {
    const a = item('cancel', 'a.bin', 13);
    const b = item('cancel', 'b.bin', 14);
    const [idA, idB] = await protectEach([a, b]);
    fs.rmSync(a);
    fs.rmSync(b);
    const { jobId } = await startCapsuleRestore([idA, idB]);
    await withinHangGuard(hold.reached, 'the restore reaching its first placement');
    assert.equal(cancelCapsuleJob(jobId), true);
    hold.release();
    assert.equal((await settled(jobId)).status, 'cancelled');
    assert.equal(fs.existsSync(b), false, 'B was not put back');
    assert.deepEqual(await deleteCapsuleEntry(idB), { deleted: true, bytesFreed: ITEM }, 'and its copy is no longer held for the cancelled restore');
  } finally {
    hold.release();
    hold.remove();
  }
});

/* ─────────────── every removal of a copy holds the lock a restore is accepted under ─────────────── */

test('every removal of a copy, and accepting a restore, are made under one lock', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'timeCapsule.ts'), 'utf8');
  const source = ts.createSourceFile('timeCapsule.ts', text, ts.ScriptTarget.Latest, true);
  const sites: { what: string; line: number; locked: boolean }[] = [];
  const enclosedBy = (node: ts.Node, lock: string): boolean => {
    for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
      if (ts.isCallExpression(up) && ts.isIdentifier(up.expression) && up.expression.text === lock) return true;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    // Each removal of a copy that a record still names: `dropPayload`; and a restore taking its copies.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'dropPayload') {
      sites.push({ what: 'dropPayload', line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, locked: enclosedBy(node, 'withPayloadLock') });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'add'
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'restoresInFlight') {
      sites.push({ what: 'restoresInFlight.add', line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, locked: enclosedBy(node, 'withPayloadLock') });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(sites.filter((s) => s.what === 'dropPayload').length >= 4, `found ${sites.length} sites: eviction, Forget, expiry and a restore's own bookkeeping at least`);
  assert.ok(sites.some((s) => s.what === 'restoresInFlight.add'), 'a restore pins its copies');
  const unlocked = sites.filter((s) => !s.locked).map((s) => `${s.what} at line ${s.line}`);
  assert.deepEqual(unlocked, [], 'outside withPayloadLock');
});

test('a restore holds the payload lock only to look at the copies and pin them: where it writes is looked at before, holding nothing', () => {
  // A destination on a volume gone quiet would otherwise hold every removal of a copy — and every
  // capture waiting to evict, holding the index — behind one restore's look at it.
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'timeCapsule.ts'), 'utf8');
  const source = ts.createSourceFile('timeCapsule.ts', text, ts.ScriptTarget.Latest, true);
  let locked: ts.Node | null = null;
  const findStart = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'startCapsuleRestore') {
      const findLock = (n: ts.Node): void => {
        if (locked === null && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'withPayloadLock') locked = n;
        ts.forEachChild(n, findLock);
      };
      findLock(node);
    }
    ts.forEachChild(node, findStart);
  };
  findStart(source);
  assert.ok(locked, 'startCapsuleRestore takes the payload lock');
  const named: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && ['restoreNameKeyFor', 'restorePlaceOf', 'lstat', 'stat', 'foldsCaseAt'].includes(n.text)) named.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(locked as unknown as ts.Node);
  assert.deepEqual(named, [], 'no look at the destination under the lock');
});

/* ─────────────── FG3g L1: what the index says while a capture that evicted is under way ─────────────── */

test('while a capture that evicted a copy is still copying, the index already says that copy is gone, and a restore of it says so (FG3f review S1)', async () => {
  const uncap = setCapsuleCapForTests(250_000);
  try {
    const a = item('s1', 'a.bin', 19);
    const b = item('s1', 'b.bin', 20);
    const c = item('s1', 'c.bin', 21);
    const [idA] = await protectEach([a, b]); // A is the oldest copy, so the one evicted for C
    fs.rmSync(a);
    let listed: Promise<TimeCapsuleEntry | undefined> | null = null;
    let restore: Promise<string> | null = null;
    // Part-way through copying C, A's copy is gone: the index and a restore are asked then.
    const unfault = setCopyFaultForTests((dest) => {
      if (listed === null && path.basename(dest) === 'c.bin') {
        listed = entry(idA);
        restore = startCapsuleRestore([idA]).then(() => 'started', (err: unknown) => (err instanceof AppError ? err.code : String(err)));
      }
      return null;
    });
    try {
      const captured = await protectItems([{ path: c }]);
      assert.equal(captured.outcomes[0].protected, true);
    } finally {
      unfault();
    }
    assert.ok(listed && restore, 'asked while C was being copied');
    assert.equal((await (listed as Promise<TimeCapsuleEntry | undefined>))?.hasPayload, false, 'the index no longer offers A as restorable');
    assert.equal(await (restore as Promise<string>), 'PAYLOAD_GONE', 'and its restore says the copy is gone, not that a record cannot be read');
  } finally {
    uncap();
  }
});

test('a copy whose folder went from the capsule outside TreeMap is refused as gone; a record that cannot be read is still MANIFEST_UNREADABLE', async () => {
  const x = item('gone', 'x.bin', 22);
  const y = item('gone', 'y.bin', 23);
  const [idX, idY] = await protectEach([x, y]);
  fs.rmSync(x);
  fs.rmSync(y);
  fs.rmSync(path.join(capsuleRoot(), idX), { recursive: true }); // removed by hand, or by another program
  await assert.rejects(startCapsuleRestore([idX]), refusedWith('PAYLOAD_GONE'));
  fs.writeFileSync(path.join(capsuleRoot(), idY, 'manifest.json'), '{ not json');
  await assert.rejects(startCapsuleRestore([idY]), refusedWith('MANIFEST_UNREADABLE'));
});

test('an undo asked for while a capture that evicted one of its copies is under way names that item as gone', async () => {
  const uncap = setCapsuleCapForTests(250_000);
  try {
    const dir = fileTempDir('treemap-capsuleRestorePinned-undo-s1-');
    const a = path.join(dir, 'a.bin');
    const b = path.join(dir, 'b.bin');
    fs.writeFileSync(a, Buffer.alloc(ITEM, 24));
    fs.writeFileSync(b, Buffer.alloc(ITEM, 25));
    const committed = await withOpenFileCheck('clear', () => commitCart([a, b])); // one run: both trashed, both copies kept
    assert.deepEqual([...committed.trashed].sort(), [a, b].sort());
    const c = item('undo-s1', 'c.bin', 26);
    let undo: Promise<{ unrestorable?: { path: string }[]; jobId?: string; code?: string }> | null = null;
    // The commit's copies are no longer pinned (its run is over), so C evicts the older of them.
    const unfault = setCopyFaultForTests((dest) => {
      if (undo === null && path.basename(dest) === 'c.bin') {
        undo = undoCartRun(committed.runId).then((r) => r, (err: unknown) => ({ code: err instanceof AppError ? err.code : String(err) }));
      }
      return null;
    });
    try {
      assert.equal((await protectItems([{ path: c }])).outcomes[0].protected, true);
    } finally {
      unfault();
    }
    assert.ok(undo);
    const answer = await (undo as Promise<{ unrestorable?: { path: string }[]; jobId?: string; code?: string }>);
    assert.equal(answer.code, undefined, `the undo started: ${answer.code}`);
    assert.equal(answer.unrestorable?.length, 1, 'and named the one item whose copy was evicted, rather than failing on it');
    const job = await settled(answer.jobId as string);
    assert.equal(job.status, 'complete', job.error);
  } finally {
    uncap();
  }
});
