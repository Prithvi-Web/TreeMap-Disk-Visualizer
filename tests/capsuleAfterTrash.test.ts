import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-capsuleAfterTrash-data-');
process.env.TREEMAP_NO_GDU = '1';

import { getCapsuleIndex, getCapsuleJob, listUndoableEntriesForRun, setDiscardFaultForTests, type DiscardStep } from '../src/services/timeCapsule';
import { CommandStopped, setTrashStepForTests } from '../src/services/cleaner';
import { commitCart, planCartCommit, undoCartRun } from '../src/services/cartCommit';
import { approvePolicy, listPolicies, runPolicy, savePolicies, undoRun } from '../src/services/autopilot';
import { platform } from '../src/platform';
import { invalidateCapabilities } from '../src/platform/capabilities';
import { waitFor } from './fixtures/waitFor';

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
async function withOpenFileCheck<T>(answer: 'clear' | 'fails', fn: () => Promise<T>): Promise<T> {
  const provider = platform() as unknown as {
    getOpenHandlesBatch: (paths: string[]) => Promise<unknown>;
    probeOpenHandleGuard: () => Promise<unknown>;
  };
  const batch = provider.getOpenHandlesBatch.bind(provider);
  const probe = provider.probeOpenHandleGuard.bind(provider);
  provider.getOpenHandlesBatch = answer === 'fails'
    ? () => Promise.reject(new Error('the probe did not answer (a test)'))
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
  await approvePolicy(id);
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

for (const step of STEPS) {
  test(`a failure at the ${step} step after the trash step: the cart commit answers with what it trashed and its run id, and its undo puts exactly that back`, async () => {
    const { gone, held } = threeFiles(`cart-${step}`);
    const { value: result, logged } = await withFault(step, () => commitCart([...gone, held]));
    assert.match(result.runId, /^[0-9a-f-]{36}$/, 'the run id its undo needs');
    assert.deepEqual(sorted(result.trashed), sorted(gone), 'exactly the two the Trash took');
    assert.ok(result.bytesFreed > 0, 'and their bytes');
    assert.deepEqual(result.failedToTrash.map((f) => f.path), [held]);
    assert.match(result.cleanupError ?? '', /did not finish/, 'with a sentence saying what did not finish');
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
  } finally {
    await savePolicies([]);
  }
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
