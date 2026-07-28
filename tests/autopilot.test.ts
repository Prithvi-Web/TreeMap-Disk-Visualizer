import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// Isolate policies, run history, the capsule and settings from the user's real
// app data. An Autopilot test that wrote to the real store would leave standing
// instructions to delete the user's files.
process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-autopilot-test-'));
process.env.TREEMAP_NO_GDU = '1';

import {
  normalizePolicy,
  savePolicies,
  listPolicies,
  sameScope,
  selectCandidates,
  applyCaps,
  effectiveCap,
  bytesDeletedSince,
  runPolicy,
  approvePolicy,
  listRuns,
  undoRun,
  type Candidate,
} from '../src/services/autopilot';
import { protectItems } from '../src/services/timeCapsule';
import { readJsonFile, writeJsonFile } from '../src/services/storage';
import { AutopilotPolicy, AutopilotRun, CleanupSuggestionGroup } from '../src/models/types';
import { AppError } from '../src/middleware/errorHandler';

/**
 * B1 — Autopilot.
 *
 * A policy is a standing instruction to delete things while nobody is
 * watching, so the tests that matter here are about the *rails*: the run that
 * refuses, the cap that holds, the approval that cannot be skipped. §B1's
 * acceptance criteria are all of that shape.
 *
 * Nothing in this file trashes anything. The one test that drives a live run
 * all the way through does so against a file held open by another process, so
 * B2 refuses the delete — the whole path executes and the Trash is never
 * touched.
 */

const mkTmp = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), 'tm-b1-'));
const IS_UNIX = process.platform !== 'win32';
const MB = 1024 * 1024;

async function writeFile(p: string, size: number): Promise<string> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, crypto.randomBytes(size));
  return p;
}

function candidate(name: string, bytes: number): Candidate {
  return { path: `/x/${name}`, name, bytes, reason: 'test' };
}

function group(id: string, items: { path: string; size: number }[]): CleanupSuggestionGroup {
  return {
    id,
    title: id,
    description: 'test group',
    items: items.map((i) => ({ name: path.basename(i.path), path: i.path, size: i.size, type: 'dir' as const, modifiedAt: 0 })),
    totalSize: items.reduce((s, i) => s + i.size, 0),
    category: 'regenerable',
  };
}

const basePolicy = (over: Partial<AutopilotPolicy> = {}): AutopilotPolicy => ({
  id: 'p1',
  name: 'Test policy',
  path: os.tmpdir(),
  match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
  maxBytesPerRun: null,
  maxBytesPerWeek: null,
  cooldownDays: 7,
  dryRunFirst: false,
  requireConfirmationAbove: null,
  enabled: true,
  ...over,
});

/* ══════════════════ A policy cannot be saved in a dangerous shape ══════════════════ */

test('a custom rule with nothing set is refused — it would match every file', () => {
  // Unattended, "delete everything under this folder" is the worst possible
  // policy, and an empty rule set is how someone writes it by accident.
  assert.throws(
    () => normalizePolicy({ path: os.tmpdir(), match: { kind: 'custom' } }),
    (err: unknown) => err instanceof AppError && err.code === 'POLICY_MATCH_EMPTY',
  );
});

test('a suggestion match with no groups is refused', () => {
  assert.throws(
    () => normalizePolicy({ path: os.tmpdir(), match: { kind: 'suggestion', groupIds: [] } }),
    (err: unknown) => err instanceof AppError && err.code === 'POLICY_MATCH_EMPTY',
  );
});

test('a policy needs a folder, and it goes through the same guard as a scan path', () => {
  assert.throws(
    () => normalizePolicy({ match: { kind: 'suggestion', groupIds: ['x'] } }),
    (err: unknown) => err instanceof AppError && err.code === 'POLICY_PATH_REQUIRED',
  );
  // The shared sanitizer refuses virtual filesystems. POSIX-only: on a
  // Windows host the sanitizer resolves '/proc' to 'C:\proc' — an ordinary,
  // permissible path there — so the refusal genuinely does not (and should
  // not) fire. The NUL check below is invalid on every OS.
  if (process.platform !== 'win32') {
    assert.throws(() => normalizePolicy({ path: '/proc', match: { kind: 'suggestion', groupIds: ['x'] } }));
  }
  assert.throws(() => normalizePolicy({ path: 'x\0y', match: { kind: 'suggestion', groupIds: ['x'] } }));
});

test('a policy cannot be pointed at the whole drive', () => {
  // The shared sanitizer allows scanning "/" — reasonable for a disk tool. A
  // standing instruction to delete unattended is a different proposition, so
  // Autopilot narrows it rather than relying on a guard tuned for scanning.
  assert.throws(
    () => normalizePolicy({ path: '/', match: { kind: 'suggestion', groupIds: ['x'] } }),
    (err: unknown) => err instanceof AppError && err.code === 'POLICY_PATH_TOO_BROAD',
  );
});

test('agent-policy.json protected paths bind Autopilot too', async () => {
  // agent-policy.json is the user's own "never destroy these" list. It was
  // written for the API surface, but an unattended deleter is precisely what
  // those paths need protecting from.
  const dir = await mkTmp();
  try {
    const keep = path.join(dir, 'proj');
    await writeFile(path.join(keep, 'node_modules', 'x', 'a.bin'), 4096);
    await writeJsonFile('agent-policy.json', { allowedRoots: [], protectedPaths: [keep], maxBytesPerOperation: null });

    const [policy] = await savePolicies([{
      id: 'protected', name: 'p', path: dir,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
      dryRunFirst: false, enabled: true,
    }]);
    await approvePolicy(policy.id);

    const result = await runPolicy((await listPolicies())[0]);
    assert.equal(result.bytesDeleted, 0);
    assert.ok(result.skipped.some((s) => /protected path/i.test(s.reason)),
      'the protected match is skipped, and the run record says why');
    assert.ok(fs.existsSync(path.join(keep, 'node_modules')));
  } finally {
    await writeJsonFile('agent-policy.json', {});
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a client cannot grant its own approval by sending the field', () => {
  // Otherwise the mandatory first dry run is one crafted request away from
  // being skipped entirely.
  const p = normalizePolicy({
    path: os.tmpdir(),
    match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
    approvedAt: 12345,
    lastRunAt: 999,
  });
  assert.equal(p.approvedAt, undefined);
  assert.equal(p.lastRunAt, undefined);
});

test('a new policy is disabled unless explicitly enabled', () => {
  const p = normalizePolicy({ path: os.tmpdir(), match: { kind: 'suggestion', groupIds: ['a'] } });
  assert.equal(p.enabled, false);
  assert.equal(p.dryRunFirst, true, 'and previews by default');
});

test('editing what a policy matches revokes the approval it already had', async () => {
  const saved = await savePolicies([
    { id: 'edit-me', path: os.tmpdir(), match: { kind: 'suggestion', groupIds: ['regen-node-modules'] }, enabled: true },
  ]);
  await approvePolicy(saved[0].id);
  assert.ok((await listPolicies())[0].approvedAt, 'approved');

  // "Approve a tiny dry run, then edit the policy to match everything" is the
  // exact bypass this closes.
  const edited = await savePolicies([
    { id: 'edit-me', path: os.tmpdir(), match: { kind: 'suggestion', groupIds: ['regen-node-modules', 'cache-npm'] }, enabled: true },
  ]);
  assert.equal(edited[0].approvedAt, undefined, 'a wider policy must earn approval again');
  await savePolicies([]);
});

test('sameScope compares where and what, not the cosmetic fields', () => {
  const a = basePolicy();
  assert.equal(sameScope(a, basePolicy({ name: 'renamed', cooldownDays: 30 })), true);
  assert.equal(sameScope(a, basePolicy({ path: os.homedir() })), false);
  assert.equal(sameScope(a, basePolicy({ match: { kind: 'suggestion', groupIds: ['other'] } })), false);
});

/* ══════════════════ Selection and caps (pure) ══════════════════ */

test('only the chosen suggestion groups are selected, and each carries its reason', () => {
  const groups = [
    group('regen-node-modules', [{ path: '/p/node_modules', size: 500 }]),
    group('cache-other', [{ path: '/p/.cache', size: 900 }]),
  ];
  const picked = selectCandidates(groups, [], { kind: 'suggestion', groupIds: ['regen-node-modules'] });
  assert.deepEqual(picked.map((c) => c.path), ['/p/node_modules']);
  assert.match(picked[0].reason, /regen-node-modules/, 'the rule’s own words travel with the candidate');
});

test('a custom match explains itself in words a person can check', () => {
  const picked = selectCandidates([], [{ path: '/p/big.dmg', name: 'big.dmg', size: 5 * MB }],
    { kind: 'custom', minBytes: MB, maxAgeMs: 90 * 86_400_000, exts: ['dmg'] });
  assert.equal(picked.length, 1);
  assert.match(picked[0].reason, /at least 1\.0 MB/);
  assert.match(picked[0].reason, /older than 90 days/);
  assert.match(picked[0].reason, /\.dmg/);
});

test('candidates come back largest first', () => {
  const picked = selectCandidates([group('g', [
    { path: '/a', size: 10 }, { path: '/b', size: 900 }, { path: '/c', size: 50 },
  ])], [], { kind: 'suggestion', groupIds: ['g'] });
  assert.deepEqual(picked.map((c) => c.bytes), [900, 50, 10]);
});

test('a run never exceeds its cap, and says what it left behind', () => {
  // §B1 acceptance: "A byte-capped policy never exceeds its cap in a run."
  const { selected, skipped } = applyCaps([candidate('a', 60), candidate('b', 30), candidate('c', 20)], 100);
  const total = selected.reduce((s, c) => s + c.bytes, 0);
  assert.ok(total <= 100, `selected ${total} bytes against a cap of 100`);
  assert.deepEqual(selected.map((c) => c.name), ['a', 'b']);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /limit of 100 B was reached/);
});

test('one oversized item does not block every smaller thing behind it', () => {
  const { selected, skipped } = applyCaps([candidate('huge', 5000), candidate('small', 10)], 100);
  assert.deepEqual(selected.map((c) => c.name), ['small']);
  assert.deepEqual(skipped.map((s) => s.path), ['/x/huge']);
});

test('no cap means no ceiling and nothing skipped', () => {
  const { selected, skipped } = applyCaps([candidate('a', 1e9)], null);
  assert.equal(selected.length, 1);
  assert.deepEqual(skipped, []);
});

/* ══════════════════ The weekly budget ══════════════════ */

const run = (over: Partial<AutopilotRun>): AutopilotRun => ({
  id: crypto.randomUUID(), policyId: 'p1', policyName: 'p', at: Date.now(),
  mode: 'live', status: 'completed', items: [], bytesMatched: 0, bytesDeleted: 0, skipped: [], ...over,
});

test('the weekly total counts only live runs, in window, that were not undone', () => {
  const now = Date.now();
  const runs = [
    run({ bytesDeleted: 100, at: now - 86_400_000 }),
    run({ bytesDeleted: 999, at: now - 86_400_000, mode: 'dry-run' }),   // simulated
    run({ bytesDeleted: 500, at: now - 30 * 86_400_000 }),               // out of window
    run({ bytesDeleted: 400, at: now - 86_400_000, undoneAt: now }),     // put back
    run({ bytesDeleted: 50, at: now - 86_400_000, policyId: 'other' }),  // another policy
  ];
  assert.equal(bytesDeletedSince(runs, 'p1', now - 7 * 86_400_000), 100);
});

test('the effective cap is the tighter of the per-run and weekly limits', () => {
  const now = Date.now();
  const spent = [run({ bytesDeleted: 800, at: now - 86_400_000 })];
  // 1000-per-week with 800 spent leaves 200, which is tighter than a 500 run cap.
  assert.equal(effectiveCap(basePolicy({ maxBytesPerRun: 500, maxBytesPerWeek: 1000 }), spent, now), 200);
  // With nothing spent the per-run cap is the binding one.
  assert.equal(effectiveCap(basePolicy({ maxBytesPerRun: 500, maxBytesPerWeek: 1000 }), [], now), 500);
  assert.equal(effectiveCap(basePolicy(), [], now), null, 'no caps set = no ceiling');
  // A spent week clamps to zero rather than going negative.
  assert.equal(effectiveCap(basePolicy({ maxBytesPerWeek: 100 }), [run({ bytesDeleted: 500, at: now })], now), 0);
});

/* ══════════════════ The mandatory first dry run ══════════════════ */

test('a brand-new policy simulates and deletes nothing, however it is configured', async () => {
  const dir = await mkTmp();
  try {
    // Configured as aggressively as the model allows: enabled, no preview, no
    // caps, no confirmation threshold. It must STILL only simulate.
    await writeFile(path.join(dir, 'project', 'node_modules', 'dep', 'a.bin'), 4096);
    const [policy] = await savePolicies([{
      id: 'first-run', name: 'Aggressive', path: dir,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
      dryRunFirst: false, enabled: true,
    }]);

    const result = await runPolicy(policy);
    assert.equal(result.status, 'awaiting-approval');
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.bytesDeleted, 0);
    assert.match(result.blockedReason ?? '', /never run/);
    assert.ok(result.items.length > 0, 'and it shows exactly what it would have deleted');
    assert.ok(fs.existsSync(path.join(dir, 'project', 'node_modules')), 'nothing was touched');
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('approving clears the cooldown the dry run started', async () => {
  const [policy] = await savePolicies([{
    id: 'approve-me', name: 'p', path: os.tmpdir(),
    match: { kind: 'suggestion', groupIds: ['regen-node-modules'] }, enabled: true,
  }]);
  // Simulate the dry run having stamped the clock.
  const store = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
  store.policies[0].lastRunAt = Date.now();
  await writeJsonFile('autopilot.json', store);

  const approved = await approvePolicy(policy.id);
  assert.ok(approved.approvedAt);
  assert.equal(approved.lastRunAt, undefined, 'approving must not leave the user waiting out a full cooldown');
  await savePolicies([]);
});

/* ══════════════════ The rails that stop a real run ══════════════════ */

test('an unexpectedly large match stops the run instead of being trimmed and executed', async () => {
  // §B1 acceptance: caught by requireConfirmationAbove "rather than executing
  // silently". Note it is NOT clipped by the cap and run anyway — the size
  // itself is the signal that the policy is wrong.
  const dir = await mkTmp();
  try {
    await writeFile(path.join(dir, 'proj', 'node_modules', 'x', 'big.bin'), 200_000);
    const [policy] = await savePolicies([{
      id: 'huge-match', name: 'p', path: dir,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
      dryRunFirst: false, enabled: true, requireConfirmationAbove: 1000, maxBytesPerRun: 100,
    }]);
    await approvePolicy(policy.id);

    const result = await runPolicy((await listPolicies())[0]);
    assert.equal(result.status, 'awaiting-approval');
    assert.equal(result.bytesDeleted, 0);
    assert.match(result.blockedReason ?? '', /more than the 1000 B|more than the 1000/);
    assert.ok(fs.existsSync(path.join(dir, 'proj', 'node_modules')), 'nothing was deleted');
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a policy inside its cooldown refuses without restarting the clock', async () => {
  const startedAt = Date.now() - 2 * 86_400_000;
  const policy = basePolicy({ id: 'cooling', cooldownDays: 7, lastRunAt: startedAt });
  await savePolicies([{ ...policy }]);
  // savePolicies drops client-sent lastRunAt, so put it back the way a real
  // previous run would have.
  const raw = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
  raw.policies[0].lastRunAt = startedAt;
  raw.policies[0].approvedAt = startedAt;
  await writeJsonFile('autopilot.json', raw);

  const result = await runPolicy((await listPolicies())[0]);
  assert.equal(result.status, 'blocked');
  assert.match(result.blockedReason ?? '', /cooldown/);

  // The clock must not move: otherwise a frequent tick pushes the next real
  // run further away every time it checks.
  assert.equal((await listPolicies())[0].lastRunAt, startedAt);
  await savePolicies([]);
});

test('a spent weekly allowance blocks the run and says when it resumes', async () => {
  const dir = await mkTmp();
  try {
    await writeFile(path.join(dir, 'proj', 'node_modules', 'x', 'a.bin'), 4096);
    const [policy] = await savePolicies([{
      id: 'weekly', name: 'p', path: dir,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
      dryRunFirst: false, enabled: true, maxBytesPerWeek: 1000,
    }]);
    await approvePolicy(policy.id);

    // A previous live run already used the whole weekly allowance.
    const raw = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
    raw.runs.unshift(run({ policyId: policy.id, bytesDeleted: 1000, at: Date.now() - 3600_000 }));
    await writeJsonFile('autopilot.json', raw);

    const result = await runPolicy((await listPolicies())[0]);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockedReason ?? '', /weekly allowance/);
    assert.ok(fs.existsSync(path.join(dir, 'proj', 'node_modules')));
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a policy set to preview keeps previewing after approval', async () => {
  const dir = await mkTmp();
  try {
    await writeFile(path.join(dir, 'proj', 'node_modules', 'x', 'a.bin'), 2048);
    const [policy] = await savePolicies([{
      id: 'preview', name: 'p', path: dir,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
      dryRunFirst: true, enabled: true,
    }]);
    await approvePolicy(policy.id);

    const result = await runPolicy((await listPolicies())[0]);
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.bytesDeleted, 0);
    assert.match(result.blockedReason ?? '', /Simulated/);
    assert.ok(fs.existsSync(path.join(dir, 'proj', 'node_modules')));
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ The live path, stopped by B2 ══════════════════ */

async function holdOpenElsewhere(target: string): Promise<() => void> {
  const child = spawn(process.execPath, [
    '-e',
    `const fs=require('fs');const fd=fs.openSync(${JSON.stringify(target)},'r');` +
    `process.stdout.write('open');setInterval(()=>{},1000);`,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
    setTimeout(() => reject(new Error('child never signalled')), 10_000).unref();
  });
  return () => child.kill('SIGKILL');
}

test('a live run routes through the open-file guard and deletes nothing when it refuses', { skip: !IS_UNIX }, async () => {
  // Drives the whole production path — scan, select, cap, protect, trash —
  // with B2 stopping the delete, so the Trash is never touched.
  const dir = await mkTmp();
  let release: (() => void) | null = null;
  try {
    const held = await writeFile(path.join(dir, 'proj', 'node_modules', 'dep', 'held.bin'), 8192);
    release = await holdOpenElsewhere(held);

    const [policy] = await savePolicies([{
      id: 'live-blocked', name: 'p', path: dir,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
      dryRunFirst: false, enabled: true,
    }]);
    await approvePolicy(policy.id);

    const result = await runPolicy((await listPolicies())[0]);
    assert.equal(result.mode, 'live', 'it really did try');
    assert.equal(result.bytesDeleted, 0);
    assert.equal(result.status, 'blocked');
    assert.ok(result.skipped.length > 0, 'and it says what it left and why');
    assert.ok(fs.existsSync(held), 'the open file is exactly where it was');
  } finally {
    release?.();
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ Undo ══════════════════ */

test('a run is undone by putting every item back from the Time Capsule', async () => {
  // §B1 acceptance: "every run is fully undoable for at least 30 days".
  // Built from a real capture so the undo restores real bytes.
  const dir = await mkTmp();
  try {
    const a = await writeFile(path.join(dir, 'one.bin'), 4096);
    const b = await writeFile(path.join(dir, 'two.bin'), 2048);
    const runId = crypto.randomUUID();
    const { outcomes } = await protectItems([{ path: a }, { path: b }], { runId, policyId: 'undo-me' });
    assert.ok(outcomes.every((o) => o.protected), 'both were protected');

    // What a completed live run leaves behind: originals gone, capsule holding
    // copies stamped with the run id.
    await fsp.rm(a);
    await fsp.rm(b);

    const raw = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
    raw.runs.unshift(run({ id: runId, policyId: 'undo-me', capsuleRunId: runId, bytesDeleted: 6144, mode: 'live' }));
    await writeJsonFile('autopilot.json', raw);

    const undo = await undoRun(runId);
    assert.equal(undo.entryCount, 2);

    // The restore is a job; wait it out.
    const { getCapsuleJob } = await import('../src/services/timeCapsule');
    const deadline = Date.now() + 20_000;
    for (;;) {
      const job = getCapsuleJob(undo.jobId);
      if (job && job.status !== 'running') { assert.equal(job.status, 'complete', job.error ?? ''); break; }
      assert.ok(Date.now() < deadline, 'undo timed out');
      await new Promise((r) => setTimeout(r, 25));
    }

    assert.ok(fs.existsSync(a), 'the first file is back');
    assert.ok(fs.existsSync(b), 'and so is the second');
    assert.equal((await listRuns()).find((r) => r.id === runId)?.undoneAt !== undefined, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('undoing twice is refused rather than half-working', async () => {
  const raw = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
  const id = crypto.randomUUID();
  raw.runs.unshift(run({ id, bytesDeleted: 10, mode: 'live', undoneAt: Date.now() }));
  await writeJsonFile('autopilot.json', raw);
  await assert.rejects(() => undoRun(id), (err: unknown) => err instanceof AppError && err.code === 'ALREADY_UNDONE');
});

test('a dry run has nothing to undo, and says so', async () => {
  const raw = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
  const id = crypto.randomUUID();
  raw.runs.unshift(run({ id, mode: 'dry-run', bytesDeleted: 0 }));
  await writeJsonFile('autopilot.json', raw);
  await assert.rejects(() => undoRun(id), (err: unknown) => err instanceof AppError && err.code === 'NOTHING_TO_UNDO');
});

test('a run whose copies the capsule no longer holds cannot be silently half-undone', async () => {
  const raw = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
  const id = crypto.randomUUID();
  raw.runs.unshift(run({ id, mode: 'live', bytesDeleted: 100, capsuleRunId: 'no-such-capsule-run' }));
  await writeJsonFile('autopilot.json', raw);
  await assert.rejects(
    () => undoRun(id),
    (err: unknown) => err instanceof AppError && err.code === 'CAPSULE_EMPTY',
  );
});

test.after(() => {
  fs.rmSync(process.env.TREEMAP_DATA_DIR!, { recursive: true, force: true });
});
