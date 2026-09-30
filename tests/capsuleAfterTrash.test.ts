import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-capsuleAfterTrash-data-');
process.env.TREEMAP_NO_GDU = '1';

import { getCapsuleJob, setDiscardFaultForTests, type DiscardStep } from '../src/services/timeCapsule';
import { setTrashStepForTests } from '../src/services/cleaner';
import { commitCart, undoCartRun } from '../src/services/cartCommit';
import { approvePolicy, listPolicies, runPolicy, savePolicies, undoRun } from '../src/services/autopilot';
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
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashCalls++}-${path.basename(p)}`));
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
    const id = `after-trash-${step}`;
    try {
      await savePolicies([{ id, name: 'three files', path: dir, match: { kind: 'custom', minBytes: 1 }, dryRunFirst: false, enabled: true }]);
      await approvePolicy(id);
      const policy = (await listPolicies()).find((p) => p.id === id);
      assert.ok(policy);
      const { value: run } = await withFault(step, () => runPolicy(policy));
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
