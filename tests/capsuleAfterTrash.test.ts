import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-capsuleAfterTrash-data-');
process.env.TREEMAP_NO_GDU = '1';

import { getCapsuleJob, listUndoableEntriesForRun, setDiscardFaultForTests, type DiscardStep } from '../src/services/timeCapsule';
import { setTrashStepForTests } from '../src/services/cleaner';
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

before(() => {
  setTrashStepForTests(async (p) => {
    if (path.basename(p).startsWith('held')) throw new Error('the Trash refused it (a test)');
    // Refused, and its folder can no longer be looked into (its permissions changed meanwhile).
    if (path.basename(p).startsWith('locked')) {
      fs.chmodSync(path.dirname(p), 0o000);
      throw new Error('the Trash refused it (a test)');
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

test('a reported failure whose file can no longer be looked at stands: could not look is not gone', { skip: NO_CHMOD }, async () => {
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
  assert.deepEqual(result.failedToTrash.map((f) => f.path), [locked], 'the Trash\'s refusal stands');
  assert.equal(fs.readFileSync(locked, 'utf8'), 'the content of locked.txt', 'and the file is where it was');
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
