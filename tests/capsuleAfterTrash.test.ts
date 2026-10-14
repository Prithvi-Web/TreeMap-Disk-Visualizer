import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-capsuleAfterTrash-data-');
process.env.TREEMAP_NO_GDU = '1';

import { deleteCapsuleEntry, getCapsuleIndex, getCapsuleJob, listUndoableEntriesForRun, setDiscardFaultForTests, setMemberLookFaultForTests, type DiscardStep } from '../src/services/timeCapsule';
import { CommandStopped, setTrashStepForTests } from '../src/services/cleaner';
import { commitCart, planCartCommit, undoCartRun } from '../src/services/cartCommit';
import { approvePolicyForTests, getRun, listPolicies, runPolicy, savePolicies, undoRun } from '../src/services/autopilot';
import { platform } from '../src/platform';
import { invalidateCapabilities } from '../src/platform/capabilities';
import { waitFor } from './fixtures/waitFor';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';

/**
 * Follow-up FG1, item 2. After its trash step `protectAndTrash` discards the Time Capsule copies of
 * the items the Trash refused: it reads the index, drops each copy, writes the index. A failure
 * there escaped as a throw after other items were already in the Trash — Autopilot then recorded
 * a failed run that removed nothing, whose undo answered NOTHING_TO_UNDO, and the cart commit lost
 * the run id its undo needs. Nothing past the trash step throws now: the result names what was
 * trashed, with its run id and a sentence, the detail goes to the server log, and an undo puts back
 * exactly what was trashed.
 *
 * Nothing reaches the machine's Trash: the trash step moves each file into this file's own folder,
 * and refuses every file named held*.
 */

const FAKE_TRASH = fileTempDir('treemap-capsuleAfterTrash-trash-');
let trashCalls = 0;
/** Paths whose next trash step is stopped at its time limit, whatever their name. */
const stopNext = new Set<string>();

before(() => {
  setTrashStepForTests(async (p) => {
    // Refused with an errno, so the Trash's reason is a sentence of its own (describeFsError).
    if (path.basename(p).startsWith('held')) throw Object.assign(new Error('the Trash refused it (a test)'), { code: 'EBUSY' });
    // Stopped at its time limit before Finder moved it: the Trash may still carry the move out later.
    if (stopNext.delete(p)) throw new CommandStopped('osascript was stopped at its time limit (a test)');
    if (path.basename(p).startsWith('late')) throw new CommandStopped('osascript was stopped at its time limit (a test)');
    // Moved, and then its folder could no longer be looked into, and reported as failed.
    if (path.basename(p).startsWith('unseen')) {
      fs.renameSync(p, path.join(FAKE_TRASH, `${trashCalls++}-${path.basename(p)}`));
      fs.chmodSync(path.dirname(p), 0o000);
      throw new Error('the Trash reported a failure (a test)');
    }
    // Reported as moved, and nothing moved: a Trash that says it took an item it did not (FG3c).
    if (path.basename(p).startsWith('phantom')) return;
    // Moved, and then the folder it was in can no longer be looked into, and reported as moved (FG3c).
    if (path.basename(p).startsWith('sealed')) {
      fs.renameSync(p, path.join(FAKE_TRASH, `${trashCalls++}-${path.basename(p)}`));
      fs.chmodSync(path.dirname(p), 0o000);
      return;
    }
    // Refused, and its folder can no longer be looked into (its permissions changed meanwhile).
    if (path.basename(p).startsWith('locked')) {
      fs.chmodSync(path.dirname(p), 0o000);
      throw Object.assign(new Error('the Trash refused it (a test)'), { code: 'EIO' });
    }
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashCalls++}-${path.basename(p)}`));
    // An osascript killed at its timeout while Finder finishes: moved, then reported as failed.
    if (path.basename(p).startsWith('slow')) throw new Error('osascript timed out after 15000 ms (a test)');
    // Moved, another file made at the same name at once, then reported as failed.
    if (path.basename(p).startsWith('swap')) {
      fs.writeFileSync(p, 'another file, made after the trash step moved the first');
      throw new Error('the Trash reported a failure (a test)');
    }
  });
});

after(() => {
  setTrashStepForTests(null);
  setDiscardFaultForTests(null);
});

/** A folder of three files: two the Trash takes, one it refuses. */
function threeFiles(label: string): { dir: string; gone: string[]; held: string } {
  const dir = fileTempDir(`treemap-capsuleAfterTrash-${label}-`);
  const gone = ['a.txt', 'b.txt'].map((n) => path.join(dir, n));
  const held = path.join(dir, 'held.txt');
  for (const p of [...gone, held]) fs.writeFileSync(p, `the content of ${path.basename(p)}`);
  return { dir, gone, held };
}

async function restored(jobId: string): Promise<void> {
  await waitFor(() => getCapsuleJob(jobId)?.status !== 'running', `the restore ${jobId}`);
  const job = getCapsuleJob(jobId);
  assert.equal(job?.status, 'complete', job?.error ?? 'the restore finished');
}

/** Runs `fn` with a failure injected at `step`, and with console.error captured. */
async function withFault<T>(step: DiscardStep | null, fn: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const logged: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' '));
  };
  setDiscardFaultForTests(step);
  try {
    return { value: await fn(), logged };
  } finally {
    setDiscardFaultForTests(null);
    console.error = log;
  }
}

const sorted = (list: string[]): string[] => [...list].sort();

/**
 * Runs `fn` with the open-file check (B2) answering `answer`: 'clear' (checked, nothing open) or
 * 'fails' (the probe could not run). An Autopilot run is unattended, and an unattended delete moves
 * nothing when the check could not run — so a test that means to trash through Autopilot must say
 * what the check answers, or it depends on the machine. On GitHub's Windows runner (CI run
 * 36663542819) the real check (Restart Manager) came back "couldn't check": the cart commits here, a
 * person's delete, went ahead on that answer as B2 documents, while every Autopilot run was refused
 * whole (OPEN_HANDLE_UNCHECKED) before its trash step and recorded as blocked.
 */
async function withOpenFileCheck<T>(answer: 'clear' | 'fails' | 'open', fn: () => Promise<T>): Promise<T> {
  const provider = platform() as unknown as {
    getOpenHandlesBatch: (paths: string[]) => Promise<unknown>;
    probeOpenHandleGuard: () => Promise<unknown>;
  };
  const batch = provider.getOpenHandlesBatch.bind(provider);
  const probe = provider.probeOpenHandleGuard.bind(provider);
  provider.getOpenHandlesBatch = answer === 'fails'
    ? () => Promise.reject(new Error('the probe did not answer (a test)'))
    : answer === 'open'
      // Another program has the first file of the batch open ('open', FG3c).
      ? (paths: string[]) => Promise.resolve({ handles: [{ path: paths[0], pid: 1, processName: 'Preview' }], complete: true })
      : () => Promise.resolve({ handles: [], complete: true });
  provider.probeOpenHandleGuard = () => Promise.resolve({ available: true, mechanism: 'test' });
  invalidateCapabilities();
  try {
    return await fn();
  } finally {
    provider.getOpenHandlesBatch = batch;
    provider.probeOpenHandleGuard = probe;
    invalidateCapabilities();
  }
}

/** Saves and approves a live policy over `dir`, and runs it once. */
async function runOver(dir: string, id: string): Promise<Awaited<ReturnType<typeof runPolicy>>> {
  await savePolicies([{ id, name: 'three files', path: dir, match: { kind: 'custom', minBytes: 1 }, dryRunFirst: false, enabled: true }]);
  await approvePolicyForTests(id);
  const policy = (await listPolicies()).find((p) => p.id === id);
  assert.ok(policy);
  return runPolicy(policy);
}

test('without a failure, the copy of the refused item is discarded and nothing is said', async () => {
  const { gone, held } = threeFiles('cart-none');
  const { value: result } = await withFault(null, () => commitCart([...gone, held]));
  assert.deepEqual(sorted(result.trashed), sorted(gone));
  assert.equal(result.cleanupError, undefined);
  const job = await undoCartRun(result.runId);
  assert.equal(job.entryCount, 2);
  await restored(job.jobId);
  for (const p of gone) assert.equal(fs.readFileSync(p, 'utf8'), `the content of ${path.basename(p)}`);
});

const STEPS: DiscardStep[] = ['load', 'drop', 'save'];

/**
 * The way back that sentence offers, with its end (review F2.2 of QA third pass D06). It said "can
 * be put back" and stopped, in the cart commit's answer and in an Autopilot run's record, which the
 * run history shows for as long as the record exists — long after the Trash is emptied and the
 * capsule's retention or its size cap has let the copies go.
 */
const BOUNDED_WAY_BACK = /Everything listed as trashed was trashed, and can be put back until the Time Capsule removes its copies \(after 30 days by default, or sooner to stay under its size cap\)\.$/;

for (const step of STEPS) {
  test(`a failure at the ${step} step after the trash step: the cart commit answers with what it trashed and its run id, and its undo puts exactly that back`, async () => {
    const { gone, held } = threeFiles(`cart-${step}`);
    const { value: result, logged } = await withFault(step, () => commitCart([...gone, held]));
    assert.match(result.runId, /^[0-9a-f-]{36}$/, 'the run id its undo needs');
    assert.deepEqual(sorted(result.trashed), sorted(gone), 'exactly the two the Trash took');
    assert.ok(result.bytesFreed > 0, 'and their bytes');
    assert.deepEqual(result.failedToTrash.map((f) => f.path), [held]);
    assert.match(result.cleanupError ?? '', /did not finish/, 'with a sentence saying what did not finish');
    assert.match(result.cleanupError ?? '', BOUNDED_WAY_BACK, 'and the way back it offers says when it ends');
    assert.ok(logged.some((line) => line.includes(`a failure injected at the ${step} step`)), `the detail is in the server log (${logged.join(' | ')})`);
    for (const p of gone) assert.ok(!fs.existsSync(p), `${p} is in the Trash`);
    assert.ok(fs.existsSync(held), 'the one the Trash refused is where it was');

    const job = await undoCartRun(result.runId);
    assert.equal(job.entryCount, 2, 'the undo puts back the two it trashed, and passes over the copy of the one still in place');
    await restored(job.jobId);
    for (const p of gone) assert.equal(fs.readFileSync(p, 'utf8'), `the content of ${path.basename(p)}`);
    assert.equal(fs.readFileSync(held, 'utf8'), 'the content of held.txt', 'and the one never deleted is untouched');
  });

  test(`a failure at the ${step} step after the trash step: Autopilot records the run it made, and its undo puts that back`, async () => {
    const { dir, gone, held } = threeFiles(`autopilot-${step}`);
    try {
      const { value: run } = await withOpenFileCheck('clear', () => withFault(step, () => runOver(dir, `after-trash-${step}`)));
      assert.equal(run.status, 'completed', run.blockedReason);
      assert.deepEqual(sorted(run.items.map((i) => i.path)), sorted(gone), 'its items are what it trashed');
      assert.ok(run.bytesDeleted > 0, 'and their bytes');
      assert.match(run.blockedReason ?? '', /did not finish/, 'with the sentence');
      assert.match(run.blockedReason ?? '', BOUNDED_WAY_BACK, 'whose way back says when it ends, on the record the run history shows');
      assert.ok(run.skipped.some((s) => s.path === held), 'the one the Trash refused is named as left alone');
      for (const p of gone) assert.ok(!fs.existsSync(p));

      const job = await undoRun(run.id);
      assert.equal(job.entryCount, 2, 'the undo puts back the two it trashed');
      await restored(job.jobId);
      for (const p of gone) assert.equal(fs.readFileSync(p, 'utf8'), `the content of ${path.basename(p)}`);
      assert.equal(fs.readFileSync(held, 'utf8'), 'the content of held.txt');
    } finally {
      await savePolicies([]);
    }
  });
}

/* ─────────────── FG3, item 5: a copy of an item that WAS trashed is kept ─────────────── */

test('a trash step that moves a file and then reports failure: the item is counted as trashed, its copy kept, and undo puts it back', async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-slow-');
  const plain = path.join(dir, 'a.txt');
  const slow = path.join(dir, 'slow.txt');
  for (const p of [plain, slow]) fs.writeFileSync(p, `the content of ${path.basename(p)}`);
  const result = await commitCart([plain, slow]);
  assert.deepEqual(sorted(result.trashed), sorted([plain, slow]), 'judged by the disk: the file is gone from its place');
  assert.deepEqual(result.failedToTrash, [], 'and not reported as left in place');
  assert.ok(!fs.existsSync(slow));
  const job = await undoCartRun(result.runId);
  assert.equal(job.entryCount, 2, 'its copy was kept');
  await restored(job.jobId);
  for (const p of [plain, slow]) assert.equal(fs.readFileSync(p, 'utf8'), `the content of ${path.basename(p)}`);
});

test('the same path twice in one batch is protected and trashed once, and undo puts it back', async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-twice-');
  const twice = path.join(dir, 'twice.txt');
  fs.writeFileSync(twice, 'the content of twice.txt');
  const result = await commitCart([twice, twice]);
  assert.deepEqual(result.trashed, [twice], 'trashed once');
  assert.deepEqual(result.failedToTrash, [], 'and not also reported as failing');
  const job = await undoCartRun(result.runId);
  assert.equal(job.entryCount, 1, 'one copy, kept');
  await restored(job.jobId);
  assert.equal(fs.readFileSync(twice, 'utf8'), 'the content of twice.txt');
});

test('the dry run of a batch with the same path twice plans it once, as the real run does', async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-twice-plan-');
  const twice = path.join(dir, 'twice.txt');
  fs.writeFileSync(twice, 'the content of twice.txt');
  const plan = await planCartCommit([twice, twice]);
  assert.deepEqual(plan.items.map((i) => i.path), [twice], 'one item');
  assert.equal(plan.bytesWouldFree, fs.statSync(twice).size, 'counted once');
});

const NO_CHMOD = process.platform === 'win32'
  ? 'Windows ignores a folder\'s mode bits'
  : process.getuid?.() === 0 ? 'root may look into any folder' : false;

test('a reported failure whose place can no longer be looked at keeps its copy, and says so: could not look is neither gone nor untouched', { skip: NO_CHMOD }, async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-locked-');
  const locked = path.join(dir, 'locked.txt');
  fs.writeFileSync(locked, 'the content of locked.txt');
  let result: Awaited<ReturnType<typeof commitCart>>;
  try {
    result = await commitCart([locked]);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.deepEqual(result.trashed, [], 'not counted as trashed');
  assert.deepEqual(result.failedToTrash, [], 'nor as left untouched with its copy discarded: nothing showed it in place');
  assert.deepEqual((result.unverified ?? []).map((u) => u.path), [locked], 'it is reported as not confirmed');
  assert.match(result.unverified?.[0]?.reason ?? '', /the disk did not answer.*could not confirm.*copy was kept/, `with the Trash's reason and what was kept (${result.unverified?.[0]?.reason})`);
  assert.equal(fs.readFileSync(locked, 'utf8'), 'the content of locked.txt', 'the file is where it was');
  const kept = (await getCapsuleIndex()).entries.filter((e) => e.originalPath === locked && e.hasPayload);
  assert.equal(kept.length, 1, 'its copy is still in the Time Capsule');
  assert.deepEqual(await listUndoableEntriesForRun(result.runId), [], 'and an undo passes over it while the file is in place');
  await assert.rejects(undoCartRun(result.runId), (err: { code?: string; message?: string }) =>
    err.code === 'NOTHING_TO_UNDO' && /still in (its|their) place/.test(err.message ?? ''), 'saying so, not that the copies are gone');
});

test('a trash step that moves a file and then cannot look at its place: the copy is kept, and the undo puts it back', { skip: NO_CHMOD }, async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-unseen-');
  const unseen = path.join(dir, 'unseen.txt');
  fs.writeFileSync(unseen, 'the content of unseen.txt');
  let result: Awaited<ReturnType<typeof commitCart>>;
  try {
    result = await commitCart([unseen]);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.deepEqual((result.unverified ?? []).map((u) => u.path), [unseen], 'not confirmed either way when it was judged');
  assert.ok(!fs.existsSync(unseen), 'it is in the Trash');
  const job = await undoCartRun(result.runId);
  assert.equal(job.entryCount, 1, 'its copy was kept, and the undo finds its place empty');
  await restored(job.jobId);
  assert.equal(fs.readFileSync(unseen, 'utf8'), 'the content of unseen.txt');
});

test('a trash step stopped at its time limit keeps the copy though the file is still in place; if the Trash finishes later, the undo puts it back', async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-late-');
  const late = path.join(dir, 'late.txt');
  fs.writeFileSync(late, 'the content of late.txt');
  const result = await commitCart([late]);
  assert.deepEqual(result.trashed, []);
  assert.deepEqual(result.failedToTrash, [], 'a step stopped at its limit does not show the file untouched: the Trash may still finish');
  assert.deepEqual((result.unverified ?? []).map((u) => u.path), [late]);
  assert.ok(fs.existsSync(late), 'still in place when it was judged');
  // Finder finishing the Apple event it already had.
  fs.renameSync(late, path.join(FAKE_TRASH, `${trashCalls++}-late.txt`));
  const job = await undoCartRun(result.runId);
  assert.equal(job.entryCount, 1, 'the copy was kept, so the undo puts it back');
  await restored(job.jobId);
  assert.equal(fs.readFileSync(late, 'utf8'), 'the content of late.txt');
});

test('a reported failure where another file now stands at the path: the one copied was trashed, and its copy is kept', async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-swap-');
  const swapped = path.join(dir, 'swap.txt');
  fs.writeFileSync(swapped, 'the content of swap.txt');
  const result = await commitCart([swapped]);
  assert.deepEqual(result.trashed, [swapped], 'judged by what stands there: not the file that was copied');
  assert.deepEqual(result.failedToTrash, []);
  const kept = await listUndoableEntriesForRun(result.runId);
  assert.deepEqual(kept.map((e) => e.originalPath), [swapped], 'its copy is kept for an undo');
});

/* ─────────────── FG3b: a folder and an item inside it in one batch ─────────────── */

/** A folder `name` holding a.txt and b.txt, in a new temp folder. */
function project(label: string, name = 'proj'): { dir: string; inner: string[] } {
  const dir = path.join(fileTempDir(`treemap-capsuleAfterTrash-${label}-`), name);
  fs.mkdirSync(dir);
  const inner = ['a.txt', 'b.txt'].map((n) => path.join(dir, n));
  for (const p of inner) fs.writeFileSync(p, `the content of ${path.basename(p)}`);
  return { dir, inner };
}

const bytesOf = (files: string[]): number => files.reduce((sum, p) => sum + fs.statSync(p).size, 0);

for (const order of ['folder first', 'item first'] as const) {
  test(`a folder and an item inside it in one batch (${order}): one copy, the item goes with its folder, and the undo puts both back`, async () => {
    const { dir, inner } = project(`nested-${order === 'folder first' ? 'parent' : 'child'}`);
    const size = bytesOf(inner);
    const batch = order === 'folder first' ? [dir, inner[0]] : [inner[0], dir];
    const result = await commitCart(batch);
    assert.deepEqual(sorted(result.trashed), sorted([dir, inner[0]]), 'both are in the Trash: the item inside its folder');
    assert.deepEqual(result.failedToTrash, []);
    assert.equal(result.bytesFreed, size, 'the item\'s bytes are counted once, in its folder');
    assert.ok(!fs.existsSync(dir));
    const job = await undoCartRun(result.runId);
    assert.equal(job.entryCount, 1, 'one copy: the folder\'s, which holds the item');
    await restored(job.jobId);
    for (const p of inner) assert.equal(fs.readFileSync(p, 'utf8'), `the content of ${path.basename(p)}`);
    assert.deepEqual(await listUndoableEntriesForRun(result.runId), [], 'and nothing is left undoable');
  });
}

test('a folder, a folder inside it and a file inside that, in one batch: the outermost is copied once, and all three go and come back with it', async () => {
  const { dir, inner } = project('nested-three');
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  const deep = path.join(sub, 'deep.txt');
  fs.writeFileSync(deep, 'the content of deep.txt');
  const size = bytesOf([...inner, deep]);
  const result = await commitCart([deep, sub, dir]);
  assert.deepEqual(sorted(result.trashed), sorted([dir, sub, deep]), 'each is in the Trash, inside the outermost');
  assert.equal(result.bytesFreed, size, 'counted once');
  const job = await undoCartRun(result.runId);
  assert.equal(job.entryCount, 1);
  await restored(job.jobId);
  assert.equal(fs.readFileSync(deep, 'utf8'), 'the content of deep.txt');
});

test('an item inside a folder the Trash refuses stays in place with it, and says so', async () => {
  const { dir, inner } = project('nested-held', 'held-proj');
  const result = await commitCart([dir, inner[0]]);
  assert.deepEqual(result.trashed, [], 'nothing was trashed');
  assert.deepEqual(result.failedToTrash.map((f) => f.path), [dir], 'the folder was refused');
  const inside = result.skipped.find((s) => s.path === inner[0]);
  assert.match(inside?.reason ?? '', /inside .*held-proj.*left in place/, `the item says why (${JSON.stringify(result.skipped)})`);
  for (const p of inner) assert.equal(fs.readFileSync(p, 'utf8'), `the content of ${path.basename(p)}`, `${path.basename(p)} is where it was`);
});

test('the dry run of a folder and an item inside it counts the item once, in its folder — and a sibling whose name only starts the same is its own', async () => {
  const { dir, inner } = project('nested-plan');
  const sibling = `${dir}2`;
  fs.mkdirSync(sibling);
  const beside = path.join(sibling, 'beside.txt');
  fs.writeFileSync(beside, 'the content of beside.txt');
  const plan = await planCartCommit([inner[0], dir, beside]);
  assert.equal(plan.bytesWouldFree, bytesOf([...inner, beside]), 'not the item twice, and the sibling\'s file once');
  assert.deepEqual(sorted(plan.items.filter((i) => i.willDelete).map((i) => i.path)), sorted([dir, inner[0], beside]), 'all would go');
  assert.ok((plan.items.find((i) => i.path === beside)?.bytes ?? 0) > 0, 'the sibling\'s file is counted as itself, not as inside the folder');
});

/* ─────────────── FG3c: an item inside another is judged by where it is on the disk ─────────────── */

/** Whether the temp volume reads `a` and `A` as one name (default APFS and NTFS do). */
const FOLDS_CASE = ((): boolean => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-case-probe-');
  fs.writeFileSync(path.join(dir, 'probe'), '');
  return fs.existsSync(path.join(dir, 'PROBE'));
})();

/** A file's content as the tests write it. */
const contentOf = (p: string): string => `the content of ${path.basename(p)}`;

test('a folder and items inside it spelled through a link to its folder are one item: one copy, counted once, and the undo puts everything back (FG3c #1, #14)', async () => {
  const real = fileTempDir('treemap-capsuleAfterTrash-respelled-');
  const alias = path.join(fileTempDir('treemap-capsuleAfterTrash-respelled-alias-'), 'via');
  fs.symlinkSync(real, alias, 'junction');
  const proj = path.join(real, 'proj');
  fs.mkdirSync(proj);
  const inner = ['a.txt', 'b.txt'].map((n) => path.join(proj, n));
  const other = path.join(real, 'zother.txt');
  for (const p of [...inner, other]) fs.writeFileSync(p, contentOf(p));
  const size = bytesOf([...inner, other]);
  const sameFolder = path.join(alias, 'proj');
  const inside = path.join(alias, 'proj', 'a.txt');
  const batch = [proj, sameFolder, inside, other];
  const plan = await planCartCommit(batch);
  assert.equal(plan.bytesWouldFree, size, 'the dry run counts each byte once');
  const result = await commitCart(batch);
  assert.deepEqual(sorted(result.trashed), sorted(batch), 'each spelling is in the Trash, with its folder');
  assert.equal(result.bytesFreed, size, 'counted once');
  const job = await undoCartRun(result.runId);
  assert.equal(job.entryCount, 2, 'one copy for the folder, one for the file beside it');
  await restored(job.jobId);
  for (const p of [...inner, other]) assert.equal(fs.readFileSync(p, 'utf8'), contentOf(p));
  assert.deepEqual(await listUndoableEntriesForRun(result.runId), [], 'and nothing is left undoable');
});

test('a folder and an item inside it spelled in another case are one item where the volume folds case (FG3c #14)', { skip: FOLDS_CASE ? false : 'this volume keeps a and A apart' }, async () => {
  const { dir, inner } = project('recased');
  const size = bytesOf(inner);
  const upper = path.join(path.dirname(dir), 'PROJ', 'a.txt');
  const plan = await planCartCommit([dir, upper]);
  assert.equal(plan.bytesWouldFree, size, 'the dry run counts it once');
  const result = await commitCart([dir, upper]);
  assert.deepEqual(sorted(result.trashed), sorted([dir, upper]));
  assert.equal(result.bytesFreed, size);
  const job = await undoCartRun(result.runId);
  assert.equal(job.entryCount, 1, 'one copy, the folder\'s');
  await restored(job.jobId);
  for (const p of inner) assert.equal(fs.readFileSync(p, 'utf8'), contentOf(p));
});

for (const order of ['folder first', 'item first'] as const) {
  test(`an item reached through a link inside a folder of the same batch is its own item: really trashed, and put back where it was (${order}) (FG3c #4, #7)`, async () => {
    const root = fileTempDir(`treemap-capsuleAfterTrash-through-${order === 'folder first' ? 'a' : 'b'}-`);
    const folder = path.join(root, 'A');
    const elsewhere = path.join(root, 'B');
    fs.mkdirSync(folder);
    fs.mkdirSync(elsewhere);
    const own = path.join(folder, 'a.txt');
    const target = path.join(elsewhere, 'x.txt');
    for (const p of [own, target]) fs.writeFileSync(p, contentOf(p));
    fs.symlinkSync(elsewhere, path.join(folder, 'lnk'), 'junction');
    const through = path.join(folder, 'lnk', 'x.txt');
    const batch = order === 'folder first' ? [folder, through] : [through, folder];
    const planned = (await planCartCommit(batch)).items.find((i) => i.path === through);
    assert.ok(planned?.willDelete, 'it is planned');
    assert.doesNotMatch(planned?.reason ?? '', /inside/, `not as inside the folder: the link leads out of it (${planned?.reason})`);
    const result = await commitCart(batch);
    assert.deepEqual(sorted(result.trashed), sorted(batch), JSON.stringify(result));
    assert.ok(!fs.existsSync(target), 'the file the link leads to really went to the Trash');
    const job = await undoCartRun(result.runId);
    assert.equal(job.entryCount, 2, 'each has its own copy');
    await restored(job.jobId);
    assert.equal(fs.readFileSync(target, 'utf8'), contentOf(target), 'it is back where it was');
    assert.ok(fs.lstatSync(path.join(folder, 'lnk')).isSymbolicLink(), 'and the link is a link again');
    assert.equal(fs.readFileSync(own, 'utf8'), contentOf(own));
  });
}

test('an item inside a link of the same batch is its own item: a link holds nothing, and trashing it takes only the link (FG3c #4, #14)', async () => {
  const root = fileTempDir('treemap-capsuleAfterTrash-in-link-');
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  const file = path.join(real, 'file.txt');
  fs.writeFileSync(file, contentOf(file));
  const link = path.join(root, 'link');
  fs.symlinkSync(real, link, 'junction');
  const through = path.join(link, 'file.txt');
  const planned = (await planCartCommit([link, through])).items.find((i) => i.path === through);
  assert.ok(planned?.willDelete);
  assert.equal(planned?.bytes, fs.statSync(file).size, 'its own bytes: the link\'s copy does not hold them');
  assert.doesNotMatch(planned?.reason ?? '', /inside/, planned?.reason);
  const result = await commitCart([link, through]);
  assert.deepEqual(sorted(result.trashed), sorted([link, through]));
  assert.ok(!fs.existsSync(file), 'the file itself went to the Trash, not only the link to its folder');
  const job = await undoCartRun(result.runId);
  assert.equal(job.entryCount, 2);
  await restored(job.jobId);
  assert.equal(fs.readFileSync(file, 'utf8'), contentOf(file));
  assert.ok(fs.lstatSync(link).isSymbolicLink());
});

for (const order of ['link first', 'folder first'] as const) {
  test(`a link and the folder it leads to, in one batch (${order}), are two items: each planned and trashed as itself, and both come back (FG3d #13)`, async () => {
    const root = fileTempDir(`treemap-capsuleAfterTrash-link-and-target-${order === 'link first' ? 'a' : 'b'}-`);
    const real = path.join(root, 'real');
    fs.mkdirSync(real);
    const file = path.join(real, 'file.txt');
    fs.writeFileSync(file, contentOf(file));
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link, 'junction');
    const batch = order === 'link first' ? [link, real] : [real, link];
    const plan = await planCartCommit(batch);
    for (const p of batch) {
      const row = plan.items.find((i) => i.path === p);
      assert.ok(row?.willDelete, `${path.basename(p)} is planned (${JSON.stringify(row)})`);
      assert.doesNotMatch(row?.reason ?? '', /spelled another way|inside/, `${path.basename(p)} is its own item (${row?.reason})`);
    }
    const result = await commitCart(batch);
    assert.deepEqual(sorted(result.trashed), sorted(batch), JSON.stringify(result));
    assert.ok(!fs.existsSync(real), 'the folder itself went to the Trash, not only the link to it');
    assert.throws(() => fs.lstatSync(link), 'and so did the link');
    const job = await undoCartRun(result.runId);
    assert.equal(job.entryCount, 2, 'each has its own copy');
    await restored(job.jobId);
    assert.equal(fs.readFileSync(file, 'utf8'), contentOf(file), 'the folder is back with its file');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'and the link is a link again');
  });
}

test('one link spelled in two cases is one item where the volume folds case: planned and copied once, as that link (FG3d #13)', { skip: FOLDS_CASE ? false : 'this volume keeps a and A apart' }, async () => {
  const root = fileTempDir('treemap-capsuleAfterTrash-link-recased-');
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'file.txt'), 'the content of file.txt');
  const lnk = path.join(root, 'lnk');
  fs.symlinkSync(real, lnk, 'junction');
  const upper = path.join(root, 'LNK');
  const row = (await planCartCommit([lnk, upper])).items.find((i) => i.path === upper);
  assert.match(row?.reason ?? '', /spelled another way/, `it is the same link (${row?.reason})`);
  const result = await commitCart([lnk, upper]);
  assert.deepEqual(sorted(result.trashed), sorted([lnk, upper]), 'both spellings went, as one link');
  assert.ok(fs.existsSync(path.join(real, 'file.txt')), 'and where it leads is untouched');
  const job = await undoCartRun(result.runId);
  assert.equal(job.entryCount, 1, 'one copy, of the one link');
  await restored(job.jobId);
  assert.ok(fs.lstatSync(lnk).isSymbolicLink(), 'the link is back');
});

test('an item reached through a link out of a folder, that the Trash refused, is judged where it is — not gone because its folder went (FG3c #7)', async () => {
  const root = fileTempDir('treemap-capsuleAfterTrash-through-held-');
  const folder = path.join(root, 'A');
  const elsewhere = path.join(root, 'B');
  fs.mkdirSync(folder);
  fs.mkdirSync(elsewhere);
  const target = path.join(elsewhere, 'held-x.txt');
  fs.writeFileSync(target, contentOf(target));
  fs.writeFileSync(path.join(folder, 'a.txt'), 'the content of a.txt');
  fs.symlinkSync(elsewhere, path.join(folder, 'lnk'), 'junction');
  const through = path.join(folder, 'lnk', 'held-x.txt');
  const result = await commitCart([folder, through]);
  assert.deepEqual(result.trashed, [folder], `only the folder: the file the Trash refused is where it was (${JSON.stringify(result)})`);
  assert.deepEqual(result.failedToTrash.map((f) => f.path), [through], 'and it is reported as refused');
  assert.equal(fs.readFileSync(target, 'utf8'), contentOf(target));
});

test('an item whose place cannot be looked at, inside a folder of the same batch, is planned with that folder, never as an item of its own (FG3d #10)', { skip: NO_CHMOD }, async () => {
  const { dir, inner } = project('unlookable', 'unlookable-proj');
  fs.chmodSync(dir, 0o600); // its listing can be read, but nothing in it can be looked at
  try {
    const row = (await planCartCommit([dir, inner[0]])).items.find((i) => i.path === inner[0]);
    assert.match(row?.reason ?? '', /^It is inside .*unlookable-proj/, `with the folder it is written inside (${row?.reason})`);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

/* ─────────────── FG3d #2, #3: an item reached through a link is put back, and judged, where it is ─────────────── */

test('an item spelled through a link inside itself is put back at its own place, not under folders made up from the spelling (FG3d #2)', async () => {
  const root = fileTempDir('treemap-capsuleAfterTrash-cyclic-');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const file = path.join(proj, 'f.txt');
  fs.writeFileSync(file, contentOf(file));
  fs.symlinkSync('..', path.join(proj, 'up'), 'junction');
  const spelled = path.join(proj, 'up', 'proj'); // the folder itself, through its own link
  const result = await commitCart([spelled]);
  assert.deepEqual(result.trashed, [spelled], JSON.stringify(result));
  assert.ok(!fs.existsSync(proj), 'the folder went to the Trash');
  const job = await undoCartRun(result.runId);
  await restored(job.jobId);
  assert.equal(fs.readFileSync(file, 'utf8'), contentOf(file), 'its file is back at its own place');
  assert.ok(fs.lstatSync(path.join(proj, 'up')).isSymbolicLink(), 'and its link is a link again, not a folder made up on the way');
  assert.deepEqual(fs.readdirSync(root), ['proj'], 'nothing else was made beside it');
});

test('items spelled through links restore by where each is: a holder spelled through a link comes back before an item reached through its own link (FG3d #2)', async () => {
  const root = fileTempDir('treemap-capsuleAfterTrash-spelled-holders-');
  for (const dir of ['w', 'y', path.join('ext', 'ed')]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const g = path.join(root, 'ext', 'ed', 'g.txt');
  fs.writeFileSync(g, contentOf(g));
  fs.symlinkSync('..', path.join(root, 'w', 'toroot'), 'junction');
  fs.symlinkSync(path.join('..', 'ext'), path.join(root, 'y', 'lnk'), 'junction');
  const batch = [path.join(root, 'y', 'lnk', 'ed'), path.join(root, 'w', 'toroot', 'y'), path.join(root, 'w')];
  const result = await commitCart(batch);
  assert.deepEqual(sorted(result.trashed), sorted(batch), JSON.stringify(result));
  const job = await undoCartRun(result.runId);
  await restored(job.jobId);
  assert.equal(fs.readFileSync(g, 'utf8'), contentOf(g), 'ed is back in ext, where it was');
  assert.ok(fs.lstatSync(path.join(root, 'y', 'lnk')).isSymbolicLink(), 'y is back with its link');
  assert.ok(fs.lstatSync(path.join(root, 'w', 'toroot')).isSymbolicLink(), 'and w with its');
});

test('an unconfirmed item reached through a link another item took to the Trash is judged where it is: still in its place, passed over, never an EEXIST (FG3d #3)', async () => {
  const root = fileTempDir('treemap-capsuleAfterTrash-through-gone-link-');
  const ext = path.join(root, 'ext');
  fs.mkdirSync(ext);
  const x = path.join(ext, 'late-x.txt'); // its trash step is stopped at its time limit, and it stays
  fs.writeFileSync(x, contentOf(x));
  const link = path.join(root, 'L');
  fs.symlinkSync(ext, link, 'junction');
  const through = path.join(link, 'late-x.txt');
  const result = await commitCart([through, link]);
  assert.deepEqual(result.trashed, [link], JSON.stringify(result));
  assert.deepEqual((result.unverified ?? []).map((u) => u.path), [through]);
  const job = await undoCartRun(result.runId);
  assert.equal(job.entryCount, 1, `only the link is put back (${JSON.stringify(job)})`);
  assert.deepEqual((job.passedOver ?? []).map((p) => [p.path, p.reason]),
    [[through, 'It is still in its place, so there was nothing to put back; its copy stays in the Time Capsule.']]);
  await restored(job.jobId);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is back');
  assert.equal(fs.readFileSync(x, 'utf8'), contentOf(x), 'and the file it leads to was never touched');
});

/* ─────────────── FG3d: a folder holding a file whose look fails ─────────────── */

test('a folder holding a file that cannot be looked at is not protected, so it is not deleted: the dry run and the commit leave it in place and say why (FG3d)', async () => {
  const { dir, inner } = project('unlooked-member', 'unlooked-proj');
  const [, unlooked] = inner;
  // The look at b.txt fails as a disk that stops answering does; the rest of the folder reads fine.
  const removeFault = setMemberLookFaultForTests((abs) => (abs === unlooked ? Object.assign(new Error('i/o error (a test)'), { code: 'EIO' }) : null));
  let result: Awaited<ReturnType<typeof commitCart>>;
  try {
    const planned = (await planCartCommit([dir])).items.find((i) => i.path === dir);
    assert.equal(planned?.willDelete, false, `the dry run would not delete it (${JSON.stringify(planned)})`);
    assert.match(planned?.reason ?? '', /could not look at b\.txt, inside it \(the disk did not answer/, planned?.reason);
    result = await commitCart([dir]);
  } finally {
    removeFault();
  }
  assert.deepEqual(result.trashed, [], `nothing went to the Trash (${JSON.stringify(result)})`);
  const row = result.skipped.find((s) => s.path === dir);
  assert.equal(row?.code, 'CAPSULE_UNREADABLE', JSON.stringify(result.skipped));
  assert.match(row?.reason ?? '', /could not look at b\.txt, inside it/, row?.reason);
  assert.match(row?.reason ?? '', /what cannot be protected is not deleted/, row?.reason);
  for (const p of inner) assert.equal(fs.readFileSync(p, 'utf8'), contentOf(p), `${path.basename(p)} is where it was`);
  assert.deepEqual(await listUndoableEntriesForRun(result.runId), [], 'no copy is held that an undo could call the whole folder');
  const said = (await getCapsuleIndex()).events.find((e) => e.kind === 'unprotected' && e.originalPath === dir);
  assert.match(said?.detail ?? '', /could not look at b\.txt/, 'and the Time Capsule tab says what it could not keep');
});

test('a file that goes between its folder\u2019s listing and the look at it is gone, not unreadable: the folder is still protected and deleted, and the undo puts back what was there (FG3d)', async () => {
  const { dir, inner } = project('vanished-member', 'vanished-proj');
  const [kept, vanished] = inner;
  // Removed by something else after the folder was listed, before the walk looked at it.
  const removeFault = setMemberLookFaultForTests((abs) => {
    if (abs === vanished && fs.existsSync(vanished)) fs.rmSync(vanished);
    return null;
  });
  let result: Awaited<ReturnType<typeof commitCart>>;
  try {
    result = await commitCart([dir]);
  } finally {
    removeFault();
  }
  assert.deepEqual(result.trashed, [dir], JSON.stringify(result));
  const job = await undoCartRun(result.runId);
  await restored(job.jobId);
  assert.equal(fs.readFileSync(kept, 'utf8'), contentOf(kept), 'what was there is back');
  assert.ok(!fs.existsSync(vanished), 'and what had gone before the copy was made stays gone');
});

test('the dry run names an item spelled another way as that item (FG3c #1)', async () => {
  const real = fileTempDir('treemap-capsuleAfterTrash-respelled-plan-');
  const alias = path.join(fileTempDir('treemap-capsuleAfterTrash-respelled-plan-alias-'), 'via');
  fs.symlinkSync(real, alias, 'junction');
  const proj = path.join(real, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'a.txt'), 'the content of a.txt');
  const again = path.join(alias, 'proj');
  const plan = await planCartCommit([proj, again]);
  const row = plan.items.find((i) => i.path === again);
  assert.match(row?.reason ?? '', /spelled another way/, `it is the same folder (${row?.reason})`);
  assert.equal(plan.bytesWouldFree, fs.statSync(path.join(proj, 'a.txt')).size, 'counted once');
});

test('an item inside a folder the Trash reported taking, but still in its place, is not listed as trashed (FG3c #4)', async () => {
  const { dir, inner } = project('phantom', 'phantom-proj');
  const result = await commitCart([dir, inner[0]]);
  assert.deepEqual(result.trashed, [dir], 'the folder, as the Trash reported it');
  const row = result.skipped.find((s) => s.path === inner[0]);
  assert.ok(row, `the item is reported, not dropped (${JSON.stringify(result)})`);
  assert.match(row?.reason ?? '', /still where it was/, `with what the disk showed (${row?.reason})`);
});

test('an item inside a folder whose trash step could not be confirmed is not confirmed either, and says so', async () => {
  const { dir, inner } = project('nested-late', 'late-proj');
  const result = await commitCart([dir, inner[0]]);
  assert.deepEqual(result.trashed, []);
  assert.deepEqual(sorted((result.unverified ?? []).map((u) => u.path)), sorted([dir, inner[0]]), 'both are unconfirmed');
  assert.match(result.unverified?.find((u) => u.path === inner[0])?.reason ?? '', /inside .*late-proj.*could not confirm/);
});

test('a trash step that keeps failing unconfirmed keeps one copy of an unchanged file, not one per attempt', async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-late-again-');
  const late = path.join(dir, 'late-again.txt');
  fs.writeFileSync(late, 'the content of late-again.txt');
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await commitCart([late]);
    assert.deepEqual((result.unverified ?? []).map((u) => u.path), [late], `attempt ${attempt}`);
  }
  const copies = async (): Promise<number> => (await getCapsuleIndex()).entries.filter((e) => e.originalPath === late && e.hasPayload).length;
  assert.equal(await copies(), 1, 'the newest copy supersedes the older, identical ones, which would otherwise crowd out other undo copies');
  fs.writeFileSync(late, 'the content of late-again.txt, changed');
  await commitCart([late]);
  assert.equal(await copies(), 2, 'a copy of other content is never superseded');
});

test('a copy of an item that was trashed is never taken for a superseded unconfirmed one', async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-trashed-then-late-');
  const again = path.join(dir, 'again.txt');
  fs.writeFileSync(again, 'the content of again.txt');
  const first = await commitCart([again]);
  assert.deepEqual(first.trashed, [again], 'trashed, its copy kept');
  fs.writeFileSync(again, 'the content of again.txt'); // the same content, back at the same place
  stopNext.add(again);
  const second = await commitCart([again]);
  assert.deepEqual((second.unverified ?? []).map((u) => u.path), [again]);
  const copies = (await getCapsuleIndex()).entries.filter((e) => e.originalPath === again && e.hasPayload);
  assert.equal(copies.length, 2, 'the trashed item\'s copy is kept beside the unconfirmed one');
  assert.equal((await listUndoableEntriesForRun(first.runId)).length, 1, 'and its undo still has it');
});

/* ─────────────── FG3b: the Trash's own reason, per item ─────────────── */

test('an item the Trash refused names the Trash\'s reason, in the cart\'s answer and in an Autopilot run', async () => {
  const cart = threeFiles('reason-cart');
  const result = await commitCart([...cart.gone, cart.held]);
  const cartRow = result.skipped.find((s) => s.path === cart.held);
  assert.match(cartRow?.reason ?? '', /a program still has it open/, `the cart says why (${cartRow?.reason})`);
  assert.match(cartRow?.reason ?? '', /untouched/, 'and that the disk showed it in place');

  const { dir, gone, held } = threeFiles('reason-autopilot');
  try {
    const run = await withOpenFileCheck('clear', () => runOver(dir, 'reason'));
    assert.deepEqual(sorted(run.items.map((i) => i.path)), sorted(gone));
    const row = run.skipped.find((s) => s.path === held);
    assert.match(row?.reason ?? '', /a program still has it open/, `the run record says why (${row?.reason})`);
  } finally {
    await savePolicies([]);
  }
});

test('an Autopilot run whose trash step could not be confirmed says so, and does not call the item untouched', async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-late-autopilot-');
  const late = path.join(dir, 'late.bin');
  fs.writeFileSync(late, Buffer.alloc(64, 1));
  try {
    const run = await withOpenFileCheck('clear', () => runOver(dir, 'late'));
    assert.equal(run.status, 'blocked');
    assert.match(run.blockedReason ?? '', /could not confirm/, `the reason says what is not known (${run.blockedReason})`);
    const row = run.skipped.find((s) => s.path === late);
    assert.match(row?.reason ?? '', /could not confirm/, `and so does its row (${row?.reason})`);
    assert.doesNotMatch(row?.reason ?? '', /untouched/);
  } finally {
    await savePolicies([]);
  }
});

/* ─────────────── FG3c: an undo says what it knows of an unconfirmed item ─────────────── */

/** Finder finishing the Apple event it already had: the item leaves its place for the stand-in Trash. */
function finderFinishes(p: string): void {
  fs.renameSync(p, path.join(FAKE_TRASH, `${trashCalls++}-${path.basename(p)}`));
}

/** The error `promise` rejects with, as the caller sees it. */
async function refusalOf(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  return promise.then(
    (value) => assert.fail(`expected a refusal, got ${JSON.stringify(value)}`),
    (err: { code?: string; message?: string }) => err,
  );
}

test('an unconfirmed item whose place another file now holds is never called still in its place (FG3c #2)', async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-late-regen-');
  const late = path.join(dir, 'late-regen.txt');
  fs.writeFileSync(late, 'the content of late-regen.txt');
  const result = await commitCart([late]);
  assert.deepEqual((result.unverified ?? []).map((u) => u.path), [late]);
  // Finder finishes the move, and something (a build, a cache) makes a new file at the same name.
  finderFinishes(late);
  fs.writeFileSync(late, 'regenerated');
  const refused = await refusalOf(undoCartRun(result.runId));
  assert.equal(refused.code, 'NOTHING_TO_UNDO');
  assert.doesNotMatch(refused.message ?? '', /still in (its|their) place/, `the disk shows another file there, not the one copied (${refused.message})`);
  assert.match(refused.message ?? '', /may be in the Trash/, `it says what is known (${refused.message})`);
  assert.equal(fs.readFileSync(late, 'utf8'), 'regenerated', 'the new file is left as it is');
  const kept = (await getCapsuleIndex()).entries.filter((e) => e.originalPath === late && e.hasPayload && !e.restoredAt);
  assert.equal(kept.length, 1, 'and the copy is still held');
});

test('an unconfirmed item whose place cannot be looked at when the undo runs is not called in place either (FG3c #2)', { skip: NO_CHMOD }, async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-late-hidden-');
  const late = path.join(dir, 'late-hidden.txt');
  fs.writeFileSync(late, 'the content of late-hidden.txt');
  const result = await commitCart([late]);
  assert.deepEqual((result.unverified ?? []).map((u) => u.path), [late]);
  fs.chmodSync(dir, 0o000);
  let refused: { code?: string; message?: string };
  try {
    refused = await refusalOf(undoCartRun(result.runId));
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.equal(refused.code, 'NOTHING_TO_UNDO');
  assert.doesNotMatch(refused.message ?? '', /still in (its|their) place/, `nothing was looked at (${refused.message})`);
  assert.match(refused.message ?? '', /could not be looked at/, `it says so (${refused.message})`);
});

test('an undo that passes over an unconfirmed item still in its place puts back the rest, and names the one it left (FG3c #2)', async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-late-mixed-');
  const plain = path.join(dir, 'a.txt');
  const late = path.join(dir, 'late-mixed.txt');
  for (const p of [plain, late]) fs.writeFileSync(p, `the content of ${path.basename(p)}`);
  const result = await commitCart([plain, late]);
  assert.deepEqual([result.trashed, (result.unverified ?? []).map((u) => u.path)], [[plain], [late]]);
  const job = await undoCartRun(result.runId);
  assert.equal(job.entryCount, 1, 'the trashed item');
  assert.deepEqual((job.passedOver ?? []).map((p) => p.path), [late], 'the one passed over is named');
  assert.match(job.passedOver?.[0]?.reason ?? '', /still in its place/, `with what the disk showed (${job.passedOver?.[0]?.reason})`);
  await restored(job.jobId);
  assert.equal(fs.readFileSync(plain, 'utf8'), 'the content of a.txt');
});

test('an Autopilot run whose every item is unconfirmed is not refused as having deleted nothing, and its undo puts the item back once the Trash has taken it (FG3c #3, #11)', async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-late-undo-');
  const late = path.join(dir, 'late-undo.bin');
  fs.writeFileSync(late, Buffer.alloc(64, 1));
  try {
    const run = await withOpenFileCheck('clear', () => runOver(dir, 'late-undo'));
    assert.deepEqual([run.status, run.bytesDeleted], ['blocked', 0]);
    assert.deepEqual(run.unverified, [late], 'the run records what it could not confirm');
    const early = await refusalOf(undoRun(run.id));
    assert.equal(early.code, 'NOTHING_TO_UNDO');
    assert.doesNotMatch(early.message ?? '', /did not delete anything/, `a copy is held for an item that may be in the Trash (${early.message})`);
    assert.match(early.message ?? '', /still in its place/, `the disk shows the same file there (${early.message})`);
    assert.equal((await getRun(run.id))?.undoneAt, undefined, 'a refused undo marks nothing');
    finderFinishes(late);
    const job = await undoRun(run.id);
    assert.equal(job.entryCount, 1, 'the copy kept for it');
    await restored(job.jobId);
    assert.equal(fs.readFileSync(late).length, 64, 'it is back');
    assert.ok((await getRun(run.id))?.undoneAt, 'and now the run is undone');
  } finally {
    await savePolicies([]);
  }
});

test('an Autopilot run of unconfirmed items whose copies are gone says the copies are gone, never that it deleted nothing (FG3c #11)', async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-late-expired-');
  const late = path.join(dir, 'late-expired.bin');
  fs.writeFileSync(late, Buffer.alloc(64, 5));
  try {
    const run = await withOpenFileCheck('clear', () => runOver(dir, 'late-expired'));
    assert.deepEqual(run.unverified, [late]);
    finderFinishes(late);
    // Retention or eviction takes the copy before anyone asks for the undo.
    for (const e of (await getCapsuleIndex()).entries.filter((x) => x.runId === run.id)) await deleteCapsuleEntry(e.id);
    const refused = await refusalOf(undoRun(run.id));
    assert.equal(refused.code, 'CAPSULE_EMPTY', `the item may be in the Trash, and its copy is gone (${refused.message})`);
    assert.doesNotMatch(refused.message ?? '', /did not delete anything/);
  } finally {
    await savePolicies([]);
  }
});

test('an Autopilot undo that passes over an unconfirmed item leaves the run undoable, so a later undo puts it back (FG3c #3)', async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-late-later-');
  const ok = path.join(dir, 'ok.bin');
  const late = path.join(dir, 'late-later.bin');
  for (const p of [ok, late]) fs.writeFileSync(p, Buffer.alloc(64, 2));
  try {
    const run = await withOpenFileCheck('clear', () => runOver(dir, 'late-later'));
    assert.deepEqual([run.status, run.items.map((i) => i.path), run.unverified], ['completed', [ok], [late]]);
    const first = await undoRun(run.id);
    assert.equal(first.entryCount, 1, 'what it trashed');
    assert.deepEqual((first.passedOver ?? []).map((p) => p.path), [late], 'and it names the one it passed over');
    await restored(first.jobId);
    assert.ok(fs.existsSync(ok));
    assert.equal((await getRun(run.id))?.undoneAt, undefined, 'not undone while a copy it passed over is held');
    finderFinishes(late);
    const second = await undoRun(run.id);
    assert.equal(second.entryCount, 1, 'the copy kept for the unconfirmed item');
    await restored(second.jobId);
    assert.equal(fs.readFileSync(late).length, 64, 'it is back');
    assert.ok((await getRun(run.id))?.undoneAt, 'now the run is undone');
    assert.equal((await refusalOf(undoRun(run.id))).code, 'ALREADY_UNDONE');
  } finally {
    await savePolicies([]);
  }
});

/** One request to a fresh app on a free port, answered as JSON. */
async function overHttp(method: string, url: string): Promise<{ status: number; body: any }> {
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${url}`, { method });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('each Autopilot undo is audited with what it puts back, not what the run once trashed (FG3c #3)', async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-late-audit-');
  const ok = path.join(dir, 'ok.bin');
  const late = path.join(dir, 'late-audit.bin');
  for (const p of [ok, late]) fs.writeFileSync(p, Buffer.alloc(64, 4));
  try {
    const run = await withOpenFileCheck('clear', () => runOver(dir, 'late-audit'));
    const lastUndoLine = async (): Promise<{ paths: string[]; bytes: number | null }> => {
      const audit = await overHttp('GET', '/api/audit?limit=5');
      const line = (audit.body.entries as { action: string; paths: string[]; bytes: number | null }[]).find((e) => e.action === 'autopilot.undo');
      assert.ok(line, 'the undo is audited');
      return line;
    };
    const first = await overHttp('POST', `/api/autopilot/runs/${run.id}/undo`);
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.equal(first.body.puttingBack, undefined, 'the audit\'s own list is not part of the answer');
    await restored(first.body.jobId);
    assert.deepEqual((await lastUndoLine()).paths, [ok], 'the first undo put back what was trashed');
    finderFinishes(late);
    const second = await overHttp('POST', `/api/autopilot/runs/${run.id}/undo`);
    assert.equal(second.status, 202, JSON.stringify(second.body));
    await restored(second.body.jobId);
    const line = await lastUndoLine();
    assert.deepEqual([line.paths, line.bytes], [[late], 64], 'the second, the copy it had passed over');
  } finally {
    await savePolicies([]);
  }
});

test('an Autopilot run with one item refused and one unconfirmed does not say nothing was moved (FG3c #11)', async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-held-late-');
  for (const n of ['held.bin', 'late-held.bin']) fs.writeFileSync(path.join(dir, n), Buffer.alloc(64, 3));
  try {
    const run = await withOpenFileCheck('clear', () => runOver(dir, 'held-late'));
    assert.equal(run.status, 'blocked');
    assert.doesNotMatch(run.blockedReason ?? '', /^Nothing was moved to the Trash/, `one may have been (${run.blockedReason})`);
    assert.match(run.blockedReason ?? '', /Nothing was confirmed as moved to the Trash/);
  } finally {
    await savePolicies([]);
  }
});

test('an item inside a folder that went to the Trash, whose place can then not be looked at, is not confirmed (FG3c #4)', { skip: NO_CHMOD }, async () => {
  const { dir, inner } = project('sealed', 'sealed-proj');
  let result: Awaited<ReturnType<typeof commitCart>>;
  try {
    result = await commitCart([dir, inner[0]]);
  } finally {
    fs.chmodSync(path.dirname(dir), 0o700);
  }
  assert.deepEqual(result.trashed, [dir], 'the folder went');
  const row = (result.unverified ?? []).find((u) => u.path === inner[0]);
  assert.match(row?.reason ?? '', /could not be looked at/, `the item is not called trashed without a look (${JSON.stringify(result)})`);
});

/* ─────────────── The Windows runner's failure, reproduced here ─────────────── */

test('when the open-file check cannot run, an unattended run moves nothing, says why, and discards only copies of what stayed', async () => {
  const { dir, gone, held } = threeFiles('autopilot-unchecked');
  try {
    const run = await withOpenFileCheck('fails', () => runOver(dir, 'unchecked'));
    assert.equal(run.status, 'blocked');
    assert.deepEqual([run.items, run.bytesDeleted], [[], 0], 'nothing was trashed');
    assert.match(run.blockedReason ?? '', /couldn.t check whether these files are in use/, `and the run says why (${run.blockedReason})`);
    for (const p of [...gone, held]) assert.ok(fs.existsSync(p), `${path.basename(p)} is where it was`);
    assert.deepEqual(await listUndoableEntriesForRun(run.capsuleRunId ?? run.id), [], 'so its copies, of files still in place, were discarded');
    // TreeMap's own check stopped the batch, before the Trash was asked (FG3c #13).
    for (const row of run.skipped) {
      assert.doesNotMatch(row.reason, /The Trash did not take it/, `the Trash was never asked (${row.reason})`);
      assert.match(row.reason, /TreeMap did not hand it to the Trash: TreeMap couldn.t check/, `the check's own sentence (${row.reason})`);
      assert.doesNotMatch(row.reason, /\.\./, `one sentence, one full stop (${row.reason})`);
    }
  } finally {
    await savePolicies([]);
  }
});

test('an item of a cart commit TreeMap held back because a program has a file open is not said to be refused by the Trash (FG3c #13)', async () => {
  const { gone, held } = threeFiles('cart-open');
  const result = await withOpenFileCheck('open', () => commitCart([...gone, held]));
  assert.deepEqual(result.trashed, [], 'nothing was moved');
  assert.equal(result.skipped.length, 3, JSON.stringify(result));
  for (const row of result.skipped) {
    assert.doesNotMatch(row.reason ?? '', /The Trash did not take it/, `the Trash was never asked (${row.reason})`);
    assert.match(row.reason ?? '', /TreeMap did not hand it to the Trash: Preview has/, `the check's own sentence (${row.reason})`);
    assert.doesNotMatch(row.reason ?? '', /\.\./, `one full stop (${row.reason})`);
    assert.match(row.reason ?? '', /still in place, untouched/, 'and the disk showed it in place');
  }
  for (const p of [...gone, held]) assert.ok(fs.existsSync(p));
});

test('an item of a cart commit TreeMap itself does not hand to the Trash, a name Windows would trim, is not said to be refused by the Trash (FG3d #9)', async () => {
  const dir = fileTempDir('treemap-capsuleAfterTrash-trimmed-');
  const trimmed = path.join(dir, 'trailing.');
  const ordinary = path.join(dir, 'ordinary.txt');
  for (const p of [trimmed, ordinary]) fs.writeFileSync(p, contentOf(p));
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real);
  Object.defineProperty(process, 'platform', { ...real, value: 'win32' });
  let result: Awaited<ReturnType<typeof commitCart>>;
  try {
    result = await withOpenFileCheck('clear', () => commitCart([trimmed, ordinary]));
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
  assert.deepEqual(result.trashed, [ordinary], JSON.stringify(result));
  const row = result.skipped.find((s) => s.path === trimmed);
  assert.doesNotMatch(row?.reason ?? '', /The Trash did not take it/, `the Trash was never asked (${row?.reason})`);
  assert.match(row?.reason ?? '', /^TreeMap did not hand it to the Trash: Windows would trim/, row?.reason);
  assert.match(row?.reason ?? '', /still in place, untouched, and its copy was discarded/, row?.reason);
  assert.equal(fs.readFileSync(trimmed, 'utf8'), contentOf(trimmed), 'and it is');
});

/**
 * FG3b (review finding 22). The Autopilot variants above answer the open-file check themselves, so
 * that a runner whose check fails does not decide them; this one keeps the real check (Restart
 * Manager) on Windows CI, where it is proven and nowhere else. Whatever the runner's check answers,
 * an unattended run either trashes what the Trash takes (the check answered) or moves nothing and
 * says why (it could not) — never trashes on an answer it could not get. What it answered is
 * recorded in the test's diagnostics.
 */
test('on Windows, an Autopilot run with the real open-file check trashes only on an answer it got', { skip: process.platform === 'win32' ? false : 'Restart Manager is Windows\' own' }, async (t) => {
  const { dir, gone, held } = threeFiles('autopilot-real-check');
  invalidateCapabilities();
  try {
    const run = await runOver(dir, 'real-check');
    t.diagnostic(`the real open-file check on this machine: run ${run.status}${run.blockedReason ? ` (${run.blockedReason})` : ''}`);
    if (run.status === 'blocked') {
      assert.deepEqual([run.items, run.bytesDeleted], [[], 0], 'nothing was trashed');
      assert.match(run.blockedReason ?? '', /couldn.t check|in use|open/i, 'and the run says why');
      for (const p of [...gone, held]) assert.ok(fs.existsSync(p), `${path.basename(p)} is where it was`);
    } else {
      assert.equal(run.status, 'completed', run.blockedReason);
      assert.deepEqual(sorted(run.items.map((i) => i.path)), sorted(gone), 'what the Trash took');
      for (const p of gone) assert.ok(!fs.existsSync(p));
    }
    assert.ok(fs.existsSync(held), 'the one the Trash refused is where it was');
  } finally {
    await savePolicies([]);
  }
});
