import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-capsuleConcurrency-data-');
process.env.TREEMAP_NO_GDU = '1';

import {
  capsuleStoreWaitersForTests,
  deleteCapsuleEntry,
  getCapsuleIndex,
  getCapsuleJob,
  protectItems,
  setAfterIndexLoadForTests,
  startCapsuleRestore,
} from '../src/services/timeCapsule';
import { setTrashStepForTests } from '../src/services/cleaner';
import { commitCart } from '../src/services/cartCommit';
import { approvePolicy, listPolicies, listRuns, runDuePolicies, runPolicy, savePolicies } from '../src/services/autopilot';
import type { AutopilotRun, TimeCapsuleEntry } from '../src/models/types';
import { AppError } from '../src/middleware/errorHandler';
import { waitFor, withinHangGuard } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * FG3f #2 (HIGH). Two ways one deletion run could undo another's bookkeeping.
 *
 * 1. Every writer of the Time Capsule index loaded it, changed it and saved it whole, and nothing
 *    kept two of those apart. A capture loads the index, copies for minutes, then saves what it
 *    loaded plus its own copies — erasing whatever was recorded meanwhile: another run's copies (a
 *    cart commit overlapping an Autopilot run: one run's trashed items lose their only copy), a
 *    restore's "put back", a "Forget". The same held for autopilot.json. Now one mutex per store
 *    serialises every read-modify-write.
 * 2. Autopilot's 60-second tick ran every due policy without asking whether it was still running
 *    from the last tick — and a policy stays due until its run ends. Now a policy in flight is
 *    skipped, and each policy is read afresh before it is judged due.
 *
 * Nothing here times anything: a test holds one side at a known point (the seam
 * setAfterIndexLoadForTests, or the trash step) and waits on a condition — the other side has done
 * its work, or is waiting its turn (capsuleStoreWaitersForTests) — never on a clock. Nothing reaches
 * the machine's Trash: the trash step moves each file into this file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-capsuleConcurrency-trash-');
let trashCalls = 0;
/** A path whose first trash step is held until `release` resolves; `reached` is called when it gets there. */
let hold: { path: string; reached: () => void; release: Promise<void> } | null = null;

before(() => {
  setTrashStepForTests(async (p) => {
    if (hold !== null && hold.path === p) {
      const held = hold;
      hold = null;
      held.reached();
      await held.release;
    }
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashCalls++}-${path.basename(p)}`));
  });
});

after(() => {
  setTrashStepForTests(null);
});

function file(label: string, name: string, content = `the content of ${name}`): string {
  const dir = fileTempDir(`treemap-capsuleConcurrency-${label}-`);
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

async function entryFor(original: string): Promise<TimeCapsuleEntry | undefined> {
  return (await getCapsuleIndex()).entries.find((e) => e.originalPath === original);
}

/* ─────────────── every writer goes through the lock: read from the source ─────────────── */

/** Each `saveStore(...)` call in `file`, by line, and whether a `lock(...)` call encloses it. */
function saveSites(file: string, lock: string): { line: number; locked: boolean }[] {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: { line: number; locked: boolean }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'saveStore') {
      let locked = false;
      for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
        if (ts.isCallExpression(up) && ts.isIdentifier(up.expression) && up.expression.text === lock) {
          locked = true;
          break;
        }
      }
      sites.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, locked });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

for (const [file, lock, writers] of [
  // protectItems, dropSupersededUnverified, discardUnusedCopies, deleteCapsuleEntry, pruneExpired,
  // reconcileCapsule, and a restore's bookkeeping.
  ['timeCapsule.ts', 'withCapsuleStore', 7],
  // savePolicies, a run's record (and its cooldown record), approvePolicy, markUndone.
  ['autopilot.ts', 'withAutopilotStore', 5],
] as const) {
  test(`every save of ${file}'s store is inside ${lock}: no read-modify-write overlaps another`, () => {
    const sites = saveSites(file, lock);
    assert.ok(sites.length >= writers, `found ${sites.length} saveStore calls; expected at least ${writers}`);
    const unlocked = sites.filter((s) => !s.locked).map((s) => s.line);
    assert.deepEqual(unlocked, [], `saveStore outside ${lock} at line(s) ${unlocked.join(', ')} of ${file}`);
  });
}

/* ─────────────── the capsule index ─────────────── */

test('two captures at once keep both copies', async () => {
  const a = file('pair', 'a.txt');
  const b = file('pair', 'b.txt');
  const [first, second] = await Promise.all([protectItems([{ path: a }]), protectItems([{ path: b }])]);
  assert.equal(first.outcomes[0].protected, true);
  assert.equal(second.outcomes[0].protected, true);
  assert.ok(await entryFor(a), 'the first capture\'s copy is recorded');
  assert.ok(await entryFor(b), 'and the second\'s, though each loaded the index before the other saved');
});

test('three "Forget"s at once forget all three', async () => {
  const items = ['x.txt', 'y.txt', 'z.txt'].map((n) => file('forget', n));
  const { outcomes } = await protectItems(items.map((p) => ({ path: p })));
  const ids = outcomes.map((o) => o.entryId as string);
  await Promise.all(ids.map((id) => deleteCapsuleEntry(id)));
  const left = (await getCapsuleIndex()).entries.filter((e) => ids.includes(e.id));
  assert.deepEqual(left.map((e) => e.name), [], 'no forgotten entry comes back');
});

test('a cart commit overlapping an Autopilot run keeps both runs\' copies', async () => {
  const dir = fileTempDir('treemap-capsuleConcurrency-policy-');
  const p = path.join(dir, 'p.bin');
  fs.writeFileSync(p, 'the content of p.bin');
  const a = file('cart', 'a.bin');
  await savePolicies([{ id: 'overlap', name: 'overlap', path: dir, match: { kind: 'custom', minBytes: 1 }, dryRunFirst: false, enabled: true }]);
  await approvePolicy('overlap');
  const policy = (await listPolicies()).find((x) => x.id === 'overlap');
  assert.ok(policy);

  let autopilot: Promise<AutopilotRun> | null = null;
  let autopilotDone: Promise<unknown> | null = null;
  let cart: ReturnType<typeof commitCart> | null = null;
  let cartLoaded = false;
  let calls = 0;
  // The Autopilot run loads the index first and is held there until the cart commit has either
  // loaded it too (no lock) or is waiting its turn (the lock); the cart commit, once it has loaded,
  // is held until the Autopilot run has finished.
  const unhook = setAfterIndexLoadForTests(async () => {
    calls++;
    if (calls === 1) {
      cart = commitCart([a]);
      await waitFor(() => cartLoaded || capsuleStoreWaitersForTests() > 0, 'the cart commit loading the index, or waiting its turn');
    } else if (calls === 2) {
      cartLoaded = true;
      await withinHangGuard(autopilotDone as Promise<unknown>, 'the Autopilot run finishing');
    }
  });
  try {
    await withOpenFileCheck('clear', async () => {
      autopilot = runPolicy(policy);
      autopilotDone = autopilot.then(() => undefined, () => undefined);
      const run = await autopilot;
      assert.equal(run.status, 'completed', run.blockedReason);
      await waitFor(() => cart !== null, 'the cart commit starting');
      const committed = await (cart as unknown as ReturnType<typeof commitCart>);
      assert.deepEqual(committed.trashed, [a]);
      assert.deepEqual(run.items.map((i) => i.path), [p]);
    });
  } finally {
    unhook();
    await savePolicies([]);
  }
  const ofP = await entryFor(p);
  assert.ok(ofP, 'the Autopilot run\'s copy is still recorded: its item is in the Trash and this is its only copy');
  assert.equal(ofP.hasPayload, true);
  assert.ok(await entryFor(a), 'and the cart commit\'s');
});

test('a restore that finishes while a capture is under way stays recorded as restored', async () => {
  const e = file('restore', 'e.txt');
  const { outcomes } = await protectItems([{ path: e }]);
  const id = outcomes[0].entryId as string;
  fs.rmSync(e); // as if trashed and the Trash emptied
  const c = file('restore', 'c.txt');
  let jobId = '';
  const unhook = setAfterIndexLoadForTests(async () => {
    const job = await startCapsuleRestore([id]);
    jobId = job.jobId;
    await waitFor(() => getCapsuleJob(jobId)?.status !== 'running' || capsuleStoreWaitersForTests() > 0,
      'the restore finishing, or its bookkeeping waiting its turn');
  });
  try {
    await protectItems([{ path: c }]);
  } finally {
    unhook();
  }
  await waitFor(() => getCapsuleJob(jobId)?.status !== 'running', 'the restore finishing');
  assert.equal(getCapsuleJob(jobId)?.status, 'complete', getCapsuleJob(jobId)?.error);
  assert.equal(fs.readFileSync(e, 'utf8'), 'the content of e.txt', 'the file is back');
  const restored = (await getCapsuleIndex()).entries.find((x) => x.id === id);
  assert.ok(restored?.restoredAt, 'the index still says it was put back');
  assert.equal(restored?.hasPayload, false, 'and that its copy, which the restore removed, is gone');
  assert.ok(await entryFor(c), 'and the capture under way kept its own copy');
});

/* ─────────────── autopilot.json ─────────────── */

test('three approvals at once are all kept', async () => {
  const ids = ['ap-1', 'ap-2', 'ap-3'];
  await savePolicies(ids.map((id) => ({
    id, name: id, path: fileTempDir(`treemap-capsuleConcurrency-${id}-`), match: { kind: 'custom', minBytes: 1 }, dryRunFirst: true, enabled: true,
  })));
  try {
    await Promise.all(ids.map((id) => approvePolicy(id)));
    const approved = (await listPolicies()).filter((p) => ids.includes(p.id) && typeof p.approvedAt === 'number').map((p) => p.id);
    assert.deepEqual(approved.sort(), ids, 'each approval was saved, not overwritten by the next');
  } finally {
    await savePolicies([]);
  }
});

/* ─────────────── the tick does not re-enter a policy still running ─────────────── */

test('a policy still running is not started again by the next tick, and a tick that began before another policy ran does not run it twice', async () => {
  const dirA = fileTempDir('treemap-capsuleConcurrency-tick-a-');
  const dirB = fileTempDir('treemap-capsuleConcurrency-tick-b-');
  const fileA = path.join(dirA, 'a.bin');
  fs.writeFileSync(fileA, 'the content of a.bin');
  fs.writeFileSync(path.join(dirB, 'b.bin'), 'the content of b.bin');
  await savePolicies([
    { id: 'tick-a', name: 'A', path: dirA, match: { kind: 'custom', minBytes: 1 }, dryRunFirst: false, enabled: true },
    { id: 'tick-b', name: 'B', path: dirB, match: { kind: 'custom', minBytes: 1 }, dryRunFirst: false, enabled: true },
  ]);
  await approvePolicy('tick-a');
  await approvePolicy('tick-b');
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const atTrash = new Promise<void>((resolve) => { reached = resolve; });
  hold = { path: fileA, reached, release: released };
  const logged: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    await withOpenFileCheck('clear', async () => {
      const firstTick = runDuePolicies(); // A first: held at its trash step
      await withinHangGuard(atTrash, 'policy A reaching its trash step');
      const secondTick = await runDuePolicies();
      assert.deepEqual(secondTick.map((r) => r.policyId), ['tick-b'], 'A is still running, so only B ran');
      const policyA = (await listPolicies()).find((x) => x.id === 'tick-a');
      assert.ok(policyA);
      await assert.rejects(runPolicy(policyA), (err: unknown) => err instanceof AppError && err.code === 'POLICY_RUNNING');
      release();
      const firstRuns = await firstTick;
      assert.deepEqual(firstRuns.map((r) => r.policyId), ['tick-a'], 'B ran during this pass, so this pass does not run it again');
    });
  } finally {
    console.error = log;
    hold = null;
    release();
    await savePolicies([]);
  }
  const runs = (await listRuns(200)).filter((r) => r.policyId === 'tick-a' || r.policyId === 'tick-b');
  assert.deepEqual(runs.map((r) => r.policyId).sort(), ['tick-a', 'tick-b'], 'one run each');
  assert.ok(runs.every((r) => r.status === 'completed'), JSON.stringify(runs.map((r) => [r.policyId, r.status, r.blockedReason])));
  assert.deepEqual(logged.filter((l) => /autopilot/.test(l)), [], 'and the tick that found A running logged no failure');
});
