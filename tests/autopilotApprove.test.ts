import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-autopilotApprove-data-');
process.env.TREEMAP_NO_GDU = '1';

import { approvePolicy, approvePolicyForTests, listPolicies, runDuePolicies, runPolicy, savePolicies } from '../src/services/autopilot';
import { setTrashStepForTests } from '../src/services/cleaner';
import { readJsonFile, writeJsonFile } from '../src/services/storage';
import { AppError } from '../src/middleware/errorHandler';
import type { AutopilotPolicy, AutopilotRun } from '../src/models/types';
import { withOpenFileCheck } from './fixtures/openFileCheck';
import { withinHangGuard } from './fixtures/waitFor';
import { setRootCheckForTests } from '../src/services/diskScanner';
import { INDEX } from './fixtures/liftFrontend';
import http from 'node:http';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';

/**
 * Approval is granted against the run the person looked at (the final review, F1.7, F1.10).
 *
 * F1.7: approval was policy-wide and checked nothing, and the page offered "Approve this policy" on
 * every run still awaiting approval. Edit a policy's scope after its preview and that old run's button
 * approved the edited, never-previewed scope, due at once — a deletion no dry run ever showed. Now an
 * approval names its run, and is refused unless that run is the policy's newest, awaiting approval,
 * and made for the policy's folder and match as they are now.
 *
 * F1.10: a run held by "Ask me first above N" could never go ahead — approving it only re-stamped the
 * policy, the next run was held again, every time. Now approving a held run lets the next run delete
 * up to what that run matched, once; a later run that matches more asks again.
 *
 * Nothing reaches the machine's Trash: the trash step moves each original into this file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-autopilotApprove-trash-');
const trashed: string[] = [];

before(() => {
  setTrashStepForTests(async (p) => {
    trashed.push(p);
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashed.length}-${path.basename(p)}`));
  });
});

after(() => {
  setTrashStepForTests(null);
});

function folder(label: string, files: Record<string, number>): string {
  const dir = fs.realpathSync(fileTempDir(`treemap-autopilotApprove-${label}-`));
  for (const [name, size] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), Buffer.alloc(size, 7));
  return dir;
}

async function policyNow(id: string): Promise<AutopilotPolicy> {
  const p = (await listPolicies()).find((x) => x.id === id);
  assert.ok(p, `policy ${id} is saved`);
  return p;
}

async function refusal(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (err) {
    assert.ok(err instanceof AppError, String(err));
    return err;
  }
  assert.fail('it was not refused');
}

/** One run of the policy as the scheduler starts it, with the open-file check answering "nothing open". */
async function runOnce(id: string): Promise<AutopilotRun> {
  return withOpenFileCheck('clear', async () => runPolicy(await policyNow(id)));
}

test('an approval names its run: none, or one that does not exist, is refused, and nothing is approved', async () => {
  const dir = folder('none', { 'old.log': 1000 });
  await savePolicies([{ id: 'none', name: 'Logs', path: dir, match: { kind: 'custom', exts: ['log'] }, dryRunFirst: false, enabled: true }]);
  try {
    const missing = await refusal(approvePolicy('none', undefined as unknown as string));
    assert.equal(missing.code, 'RUN_ID_REQUIRED', missing.message);
    assert.equal(missing.status, 400);
    const unknown = await refusal(approvePolicy('none', 'no-such-run'));
    assert.equal(unknown.code, 'RUN_NOT_FOUND', unknown.message);
    assert.equal((await policyNow('none')).approvedAt, undefined, 'a policy never previewed is not approved');
  } finally {
    await savePolicies([]);
  }
});

test('the approve button of a run made before the policy\'s scope was edited is refused - the edited scope is previewed and approved on its own', async () => {
  const dir = folder('stale', { 'old.log': 1000, 'precious-notes.txt': 1000 });
  const notes = path.join(dir, 'precious-notes.txt');
  await savePolicies([{ id: 'stale', name: 'Logs', path: dir, match: { kind: 'custom', exts: ['log'] }, dryRunFirst: false, enabled: true }]);
  try {
    const seen = await runOnce('stale');
    assert.equal(seen.status, 'awaiting-approval');
    assert.deepEqual(seen.items.map((i) => i.name), ['old.log'], 'the preview the person looked at');
    await savePolicies([{ id: 'stale', name: 'Logs', path: dir, match: { kind: 'custom', exts: ['log', 'txt'] }, dryRunFirst: false, enabled: true }]);
    assert.equal((await policyNow('stale')).lastRunAt, undefined, 'the edited scope\'s preview is due at once, not after the old one\'s cooldown');
    const stale = await refusal(approvePolicy('stale', seen.id));
    assert.equal(stale.code, 'APPROVAL_STALE', stale.message);
    assert.equal(stale.status, 409);
    assert.equal((await policyNow('stale')).approvedAt, undefined, 'the edited scope is not approved');
    assert.equal((await policyNow('stale')).lastRunAt, undefined, 'and its own preview is due at once, not after a cooldown');
    const preview = await runOnce('stale');
    assert.equal(preview.status, 'awaiting-approval', 'the next run only previews the new scope');
    assert.deepEqual(preview.items.map((i) => i.name).sort(), ['old.log', 'precious-notes.txt']);
    assert.ok(fs.existsSync(notes), 'nothing was deleted on an approval it never had');
    await approvePolicy('stale', preview.id);
    const live = await runOnce('stale');
    assert.equal(live.mode, 'live');
    assert.equal(live.items.length, 2, 'what the person approved, after seeing it');
  } finally {
    await savePolicies([]);
  }
});

test('a run an earlier build recorded, with no scope, is not approved - and the policy is previewed afresh at its next check', async () => {
  const dir = folder('older-build', { 'a.log': 1000 });
  await savePolicies([{ id: 'older-build', name: 'Logs', path: dir, match: { kind: 'custom', exts: ['log'] }, dryRunFirst: false, enabled: true }]);
  try {
    const seen = await runOnce('older-build');
    const store = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
    delete store.runs.find((r) => r.id === seen.id)?.scope; // as a run recorded before 5.2.0
    await writeJsonFile('autopilot.json', store);
    assert.ok((await policyNow('older-build')).lastRunAt, 'the preview started its cooldown');
    const refused = await refusal(approvePolicy('older-build', seen.id));
    assert.equal(refused.code, 'APPROVAL_STALE', refused.message);
    assert.equal((await policyNow('older-build')).approvedAt, undefined);
    assert.equal((await policyNow('older-build')).lastRunAt, undefined, 'a fresh preview is due at the next check, not after the cooldown');
  } finally {
    await savePolicies([]);
  }
});

test('a first preview an earlier build recorded is previewed again at the next check, not after the cooldown - and that preview can be approved', async () => {
  const dir = folder('upgrade', { 'a.log': 1000 });
  await savePolicies([{ id: 'upgrade', name: 'Logs', path: dir, match: { kind: 'custom', exts: ['log'] }, dryRunFirst: false, enabled: true }]);
  try {
    const old = await runOnce('upgrade');
    const store = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
    delete store.runs.find((r) => r.id === old.id)?.scope; // as v5.0.x recorded it
    await writeJsonFile('autopilot.json', store);
    const stampedAt = (await policyNow('upgrade')).lastRunAt;
    assert.ok(stampedAt, 'the old preview started its cooldown');
    const ran = await withOpenFileCheck('clear', () => runDuePolicies(stampedAt + 60_000));
    assert.equal(ran.length, 1, 'the next check previews it again, inside the cooldown');
    assert.equal(ran[0].status, 'awaiting-approval', 'a preview: nothing is deleted');
    assert.ok(ran[0].scope, 'made for the policy as it is now');
    assert.ok(fs.existsSync(path.join(dir, 'a.log')));
    const again = await withOpenFileCheck('clear', () => runDuePolicies(stampedAt + 120_000));
    assert.deepEqual(again, [], 'and once previewed, it waits out its cooldown as before');
    await approvePolicy('upgrade', ran[0].id);
    assert.ok((await policyNow('upgrade')).approvedAt);
  } finally {
    await savePolicies([]);
  }
});

test('an approved policy whose newest run an earlier build held for its size still waits out its cooldown - only a preview is ever brought forward', async () => {
  const dir = folder('upgrade-approved', { 'a.bin': 5000 });
  await savePolicies([{ id: 'upgrade-approved', name: 'Bins', path: dir, match: { kind: 'custom', exts: ['bin'] }, dryRunFirst: false, enabled: true, requireConfirmationAbove: 1000 }]);
  try {
    await approvePolicyForTests('upgrade-approved');
    const held = await runOnce('upgrade-approved');
    assert.equal(held.status, 'awaiting-approval');
    const store = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
    delete store.runs.find((r) => r.id === held.id)?.scope; // as v5.0.x recorded it
    await writeJsonFile('autopilot.json', store);
    const stampedAt = (await policyNow('upgrade-approved')).lastRunAt as number;
    const ran = await withOpenFileCheck('clear', () => runDuePolicies(stampedAt + 60_000));
    assert.deepEqual(ran, [], 'not brought forward: its next run could delete');
    assert.ok(fs.existsSync(path.join(dir, 'a.bin')));
  } finally {
    await savePolicies([]);
  }
});

test('an approval\'s allowance is spent by the next run even when that run only previews - it never waits for the policy to be switched to deleting', async () => {
  const dir = folder('preview-spends', { 'a.bin': 5000 });
  const base = { id: 'preview-spends', name: 'Bins', path: dir, match: { kind: 'custom', exts: ['bin'] }, enabled: true, requireConfirmationAbove: 1000 };
  await savePolicies([{ ...base, dryRunFirst: true }]);
  try {
    const first = await runOnce('preview-spends');
    await approvePolicy('preview-spends', first.id);
    assert.equal((await policyNow('preview-spends')).approvedBytes, 5000);
    const preview = await runOnce('preview-spends');
    assert.equal(preview.mode, 'dry-run');
    assert.equal((await policyNow('preview-spends')).approvedBytes, undefined, 'spent by that preview');
    await savePolicies([{ ...(await policyNow('preview-spends')), dryRunFirst: false }]); // not a scope change: approval kept
    const live = await withOpenFileCheck('clear', async () => runPolicy(await policyNow('preview-spends'), { ignoreCooldown: true }));
    assert.equal(live.status, 'awaiting-approval', 'over the limit, it asks first');
    assert.ok(fs.existsSync(path.join(dir, 'a.bin')));
  } finally {
    await savePolicies([]);
  }
});

test('only the policy\'s newest run can be approved, and an older run\'s button never restarts an approved policy\'s cooldown', async () => {
  const dir = folder('newest', { 'a.log': 1000 });
  await savePolicies([{ id: 'newest', name: 'Logs', path: dir, match: { kind: 'custom', exts: ['log'] }, dryRunFirst: false, enabled: true }]);
  try {
    const first = await runOnce('newest');
    const second = await withOpenFileCheck('clear', async () => runPolicy(await policyNow('newest'), { ignoreCooldown: true }));
    assert.equal(second.status, 'awaiting-approval');
    const older = await refusal(approvePolicy('newest', first.id));
    assert.equal(older.code, 'APPROVAL_STALE', older.message);
    await approvePolicy('newest', second.id);
    const live = await runOnce('newest');
    assert.equal(live.mode, 'live');
    const ranAt = (await policyNow('newest')).lastRunAt;
    assert.ok(ranAt, 'the live run started its cooldown');
    const again = await refusal(approvePolicy('newest', second.id));
    assert.equal(again.code, 'APPROVAL_STALE', again.message);
    assert.equal((await policyNow('newest')).lastRunAt, ranAt, 'the cooldown is left as the live run set it');
  } finally {
    await savePolicies([]);
  }
});

test('a run that is not waiting for approval is not approved', async () => {
  const dir = folder('not-asked', { 'a.log': 1000 });
  await savePolicies([{ id: 'not-asked', name: 'Logs', path: dir, match: { kind: 'custom', exts: ['log'] }, dryRunFirst: true, enabled: true }]);
  try {
    await approvePolicyForTests('not-asked');
    const preview = await runOnce('not-asked');
    assert.equal(preview.status, 'completed', 'a preview-only policy\'s run asks nothing');
    const refused = await refusal(approvePolicy('not-asked', preview.id));
    assert.equal(refused.code, 'APPROVAL_NOT_ASKED', refused.message);
  } finally {
    await savePolicies([]);
  }
});

test('approving a run held by "Ask me first above" lets the next run delete what it matched, once - a bigger match asks again', async () => {
  const dir = folder('held', { 'a.bin': 5000 });
  await savePolicies([{ id: 'held', name: 'Bins', path: dir, match: { kind: 'custom', exts: ['bin'] }, dryRunFirst: false, enabled: true, requireConfirmationAbove: 1000 }]);
  try {
    await approvePolicyForTests('held');
    const held = await runOnce('held');
    assert.equal(held.status, 'awaiting-approval');
    assert.match(held.blockedReason ?? '', /more than the/);
    await approvePolicy('held', held.id);
    assert.equal((await policyNow('held')).lastRunAt, undefined, 'due at once');
    const live = await runOnce('held');
    assert.equal(live.mode, 'live', live.blockedReason);
    assert.equal(live.bytesDeleted, 5000, live.blockedReason);
    assert.ok(!fs.existsSync(path.join(dir, 'a.bin')), 'what the person approved was deleted');
    // Once: the next match over the limit is held again.
    fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.alloc(5000, 1));
    const later = await withOpenFileCheck('clear', async () => runPolicy(await policyNow('held'), { ignoreCooldown: true }));
    assert.equal(later.status, 'awaiting-approval', 'a later match over the limit asks again');
    assert.ok(fs.existsSync(path.join(dir, 'b.bin')));
  } finally {
    await savePolicies([]);
  }
});

test('an approved size hold does not stretch: a match grown past what was approved is held again', async () => {
  const dir = folder('grown', { 'a.bin': 5000 });
  await savePolicies([{ id: 'grown', name: 'Bins', path: dir, match: { kind: 'custom', exts: ['bin'] }, dryRunFirst: false, enabled: true, requireConfirmationAbove: 1000 }]);
  try {
    await approvePolicyForTests('grown');
    const held = await runOnce('grown');
    await approvePolicy('grown', held.id);
    fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.alloc(5000, 1));
    const grown = await runOnce('grown');
    assert.equal(grown.status, 'awaiting-approval', 'more than the person approved');
    assert.equal(grown.bytesDeleted, 0);
    assert.ok(fs.existsSync(path.join(dir, 'a.bin')) && fs.existsSync(path.join(dir, 'b.bin')));
  } finally {
    await savePolicies([]);
  }
});

test('approving a first preview over the "Ask me first" limit lets the next run delete what it showed, not ask again', async () => {
  const dir = folder('first-big', { 'a.bin': 5000 });
  await savePolicies([{ id: 'first-big', name: 'Bins', path: dir, match: { kind: 'custom', exts: ['bin'] }, dryRunFirst: false, enabled: true, requireConfirmationAbove: 1000 }]);
  try {
    const preview = await runOnce('first-big');
    assert.equal(preview.status, 'awaiting-approval');
    await approvePolicy('first-big', preview.id);
    const live = await runOnce('first-big');
    assert.equal(live.mode, 'live', live.blockedReason);
    assert.equal(live.bytesDeleted, 5000);
  } finally {
    await savePolicies([]);
  }
});

test('POST /api/autopilot/policies/:id/approve takes the run being approved: without one it is refused, with the newest preview it approves', async () => {
  const dir = folder('route', { 'a.log': 1000 });
  await savePolicies([{ id: 'route', name: 'Logs', path: dir, match: { kind: 'custom', exts: ['log'] }, dryRunFirst: false, enabled: true }]);
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const post = (body: unknown): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: '/api/autopilot/policies/route/approve', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
    });
    r.on('error', reject);
    r.end(payload);
  });
  try {
    const preview = await runOnce('route');
    const bare = await post({});
    assert.equal(bare.status, 400, JSON.stringify(bare.body));
    assert.equal(bare.body.code, 'RUN_ID_REQUIRED');
    const ok = await post({ runId: preview.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.policy.approvedAt, 'approved');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await savePolicies([]);
  }
});

/* ─────────────── a run under way while the policy changes (final review F2.1) ─────────────── */

/**
 * Holds every scan at its last look before it settles, until `release`: a policy's run is then under
 * way — its folder scanned, its record not yet written — as a big folder leaves it for minutes.
 */
function holdScans(): { reached: Promise<void>; release: () => void } {
  let open!: () => void;
  const released = new Promise<void>((resolve) => { open = resolve; });
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  setRootCheckForTests(async () => {
    reach();
    await released;
  });
  return {
    reached: withinHangGuard(reached, 'the run reaching its scan\'s last look'),
    release: () => {
      setRootCheckForTests(null);
      open();
    },
  };
}

test('a policy edited while its first preview is under way previews the edit at the next check - the run made for the old scope starts no cooldown (final review F2.1)', async () => {
  const dir = folder('inflight-edit', { 'a.log': 1000, 'b.txt': 1000 });
  const before = { id: 'inflight-edit', name: 'Logs', path: dir, match: { kind: 'custom', exts: ['log'] }, dryRunFirst: false, enabled: true };
  await savePolicies([before]);
  try {
    const hold = holdScans();
    try {
      const tick = withOpenFileCheck('clear', () => runDuePolicies());
      await hold.reached;
      await savePolicies([{ ...before, match: { kind: 'custom', exts: ['log', 'txt'] } }]);
      hold.release();
      const [old] = await tick;
      assert.deepEqual(old?.scope?.match, { kind: 'custom', exts: ['log'] }, 'the run under way was made for the old scope');
    } finally {
      hold.release();
    }
    assert.equal((await policyNow('inflight-edit')).lastRunAt, undefined, 'and starts no cooldown for the edited policy');
    const ran = await withOpenFileCheck('clear', () => runDuePolicies(Date.now() + 60_000));
    assert.equal(ran.length, 1, 'the next check previews the edited scope');
    assert.equal(ran[0].status, 'awaiting-approval', 'a preview: nothing is deleted');
    assert.deepEqual(ran[0].items.map((i) => i.name).sort(), ['a.log', 'b.txt']);
    await approvePolicy('inflight-edit', ran[0].id);
    assert.ok((await policyNow('inflight-edit')).approvedAt, 'and that preview is the one approved');
  } finally {
    await savePolicies([]);
  }
});

test('approving a held run while the policy\'s next run is under way lets the run after it go ahead at the next check, not after a cooldown (final review F2.1)', async () => {
  const dir = folder('inflight-approve', { 'a.bin': 5000 });
  await savePolicies([{ id: 'inflight-approve', name: 'Bins', path: dir, match: { kind: 'custom', exts: ['bin'] }, dryRunFirst: false, enabled: true, requireConfirmationAbove: 1000, cooldownDays: 1 }]);
  try {
    await approvePolicyForTests('inflight-approve');
    const held = await runOnce('inflight-approve');
    assert.equal(held.status, 'awaiting-approval');
    // A day on, its cooldown over (the run checks it by the clock, so the stamp is moved back a day)...
    const store = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
    const saved = store.policies.find((p) => p.id === 'inflight-approve');
    assert.ok(saved?.lastRunAt, 'the held run started its cooldown');
    saved.lastRunAt -= 86_400_000;
    await writeJsonFile('autopilot.json', store);
    const hold = holdScans();
    try {
      // ...the scheduler starts its next run, and the person approves the held one meanwhile.
      const tick = withOpenFileCheck('clear', () => runDuePolicies());
      await hold.reached;
      await approvePolicy('inflight-approve', held.id);
      hold.release();
      const [during] = await tick;
      assert.equal(during?.status, 'awaiting-approval', 'the run under way read the policy before the approval');
    } finally {
      hold.release();
    }
    assert.equal((await policyNow('inflight-approve')).lastRunAt, undefined, 'and does not restart the cooldown the approval cleared');
    const ran = await withOpenFileCheck('clear', () => runDuePolicies(Date.now() + 60_000));
    assert.equal(ran.length, 1, 'the next check runs it');
    assert.equal(ran[0].mode, 'live', ran[0].blockedReason);
    assert.equal(ran[0].bytesDeleted, 5000, ran[0].blockedReason);
    assert.ok(!fs.existsSync(path.join(dir, 'a.bin')), 'what the person approved was deleted');
  } finally {
    await savePolicies([]);
  }
});

test('a first approval given while a run is under way is not undone by that run: the policy goes ahead at the next check (final review F2.1)', async () => {
  const dir = folder('inflight-first', { 'a.log': 1000 });
  await savePolicies([{ id: 'inflight-first', name: 'Logs', path: dir, match: { kind: 'custom', exts: ['log'] }, dryRunFirst: false, enabled: true }]);
  try {
    const older = await runOnce('inflight-first');
    const newest = await withOpenFileCheck('clear', async () => runPolicy(await policyNow('inflight-first'), { ignoreCooldown: true }));
    // An older run's Approve, sent by a client: refused, and the policy's preview is due at the next check.
    const stale = await refusal(approvePolicy('inflight-first', older.id));
    assert.equal(stale.code, 'APPROVAL_STALE', stale.message);
    assert.equal((await policyNow('inflight-first')).lastRunAt, undefined);
    const hold = holdScans();
    try {
      const tick = withOpenFileCheck('clear', () => runDuePolicies());
      await hold.reached;
      await approvePolicy('inflight-first', newest.id);
      hold.release();
      const [during] = await tick;
      assert.equal(during?.status, 'awaiting-approval', 'the run under way read the policy before it was approved');
    } finally {
      hold.release();
    }
    assert.equal((await policyNow('inflight-first')).lastRunAt, undefined, 'and starts no cooldown for the policy now approved');
    const ran = await withOpenFileCheck('clear', () => runDuePolicies(Date.now() + 60_000));
    assert.equal(ran.length, 1, 'the next check runs it');
    assert.equal(ran[0].mode, 'live', ran[0].blockedReason);
    assert.ok(!fs.existsSync(path.join(dir, 'a.log')), 'what the person approved was deleted');
  } finally {
    await savePolicies([]);
  }
});

test('a policy never approved whose newest preview was made for a scope since edited is previewed again at the next check (final review F2.1)', async () => {
  const dir = folder('stale-preview', { 'a.log': 1000, 'b.txt': 1000 });
  await savePolicies([{ id: 'stale-preview', name: 'Logs', path: dir, match: { kind: 'custom', exts: ['log', 'txt'] }, dryRunFirst: false, enabled: true }]);
  try {
    const seen = await runOnce('stale-preview');
    // As a build before this fix left it: the newest preview made for the scope before an edit, its cooldown started.
    const store = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
    const recorded = store.runs.find((r) => r.id === seen.id);
    assert.ok(recorded);
    recorded.scope = { path: dir, match: { kind: 'custom', exts: ['log'] } };
    await writeJsonFile('autopilot.json', store);
    const stampedAt = (await policyNow('stale-preview')).lastRunAt;
    assert.ok(stampedAt, 'the old preview started its cooldown');
    const ran = await withOpenFileCheck('clear', () => runDuePolicies(stampedAt + 60_000));
    assert.equal(ran.length, 1, 'the next check previews it again, inside the cooldown');
    assert.equal(ran[0].status, 'awaiting-approval', 'a preview: nothing is deleted');
    assert.deepEqual(ran[0].scope?.match, { kind: 'custom', exts: ['log', 'txt'] }, 'made for the policy as it is now');
    const again = await withOpenFileCheck('clear', () => runDuePolicies(stampedAt + 120_000));
    assert.deepEqual(again, [], 'and once previewed, it waits out its cooldown as before');
  } finally {
    await savePolicies([]);
  }
});

/* ─────────────── the page ─────────────── */


/** A named function declaration (or a `const`) from the shipped page, by brace matching. */
function pageSource(name: string): string {
  const fn = INDEX.search(new RegExp(`(async )?function ${name}\\(`));
  const at = fn !== -1 ? fn : INDEX.indexOf(`const ${name} =`);
  assert.notEqual(at, -1, `${name} is in the page`);
  const open = INDEX.indexOf('{', fn !== -1 ? INDEX.indexOf(')', at) : at);
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(at, i + 1) + (fn === -1 ? ';' : '');
  }
  assert.fail(`${name} does not close`);
}

const POLICY_A = { id: 'A', name: 'Old logs', path: '/home/me/logs', match: { kind: 'custom', exts: ['log', 'txt'] }, requireConfirmationAbove: null, approvedAt: undefined as number | undefined };
const POLICY_B = { id: 'B', name: 'Bins', path: '/home/me/bins', match: { kind: 'custom', exts: ['bin'] }, requireConfirmationAbove: 1000, approvedAt: 5 };
const runOf = (id: string, policy: typeof POLICY_A | typeof POLICY_B, status: string, scope: unknown, bytesMatched = 2000): Record<string, unknown> => ({
  id, policyId: policy.id, policyName: policy.name, at: 1, mode: 'dry-run', status, items: [], bytesMatched, bytesDeleted: 0, skipped: [], ...(scope ? { scope } : {}),
});
const RUNS = [
  runOf('a-new', POLICY_A, 'awaiting-approval', { path: POLICY_A.path, match: POLICY_A.match }),
  runOf('a-old', POLICY_A, 'awaiting-approval', { path: POLICY_A.path, match: POLICY_A.match }),
  runOf('b-edited', POLICY_B, 'awaiting-approval', { path: POLICY_B.path, match: { kind: 'custom', exts: ['tmp'] } }),
  runOf('b-older-build', POLICY_B, 'awaiting-approval', null),
];

test('the page offers Approve only on a policy\'s newest run awaiting approval that was made for its folder and match as they are now', () => {
  const approvable = new Function(`${pageSource('approvableRunIds')}; return approvableRunIds;`)() as (runs: unknown[], policies: unknown[]) => Set<string>;
  assert.deepEqual([...approvable(RUNS, [POLICY_A, POLICY_B])], ['a-new']);
  const html = renderedRuns(RUNS, [POLICY_A, POLICY_B]);
  const buttons = [...html.matchAll(/data-ap-approve="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(buttons, ['a-new'], 'one button, on the run that shows what the policy matches now');
  assert.match(html, /changed since this run, or ran again/, 'a stale run says why it offers no approval');
  assert.match(html, /earlier version of TreeMap/, 'and a run an earlier build recorded says that instead');
});

/** The page's renderAutopilotRuns, evaluated: the history it shows for `runs` of `policies`. */
function renderedRuns(runs: unknown[], policies: unknown[]): string {
  const host = { innerHTML: '', querySelectorAll: () => [] };
  const render = new Function(
    '$', 'state', 'formatBytes', 'formatCount', 'escapeHtml', 'icon', 'formatDate', 'approveAutopilotRun', 'undoAutopilotRun',
    `${pageSource('AP_STATUS_LABEL')} ${pageSource('approvableRunIds')} ${INDEX.includes('function unapprovableRunNote(') ? pageSource('unapprovableRunNote') : ''} ${pageSource('renderAutopilotRuns')}; return renderAutopilotRuns;`,
  )(() => host, { autopilot: { policies } }, String, String, (s: string) => s, () => '', String, () => undefined, () => undefined) as (runs: unknown[]) => void;
  render(runs);
  return host.innerHTML;
}

/** What one run of `html` says in place of an Approve button. */
function noteOf(html: string, runId: string): string {
  const at = html.indexOf(`data-run="${runId}"`);
  assert.notEqual(at, -1, `${runId} is shown`);
  const next = html.indexOf('data-run="', at + 1);
  const note = html.slice(at, next === -1 ? undefined : next).match(/<span class="muted">([^<]*)<\/span>/);
  return note ? note[1] : '';
}

test('a run that cannot be approved says what comes next, as the scheduler does it (final review F2.1, F2.3)', () => {
  const policy = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> & { id: string; path: string; match: unknown } =>
    ({ id, name: id, path: `/home/me/${id}`, match: { kind: 'custom', exts: ['log'] }, requireConfirmationAbove: 1000, cooldownDays: 7, enabled: true, ...extra });
  const run = (id: string, p: { id: string }, status: string, scope: unknown): Record<string, unknown> => ({
    id, policyId: p.id, policyName: p.id, at: 1, mode: 'dry-run', status, items: [], bytesMatched: 2000, bytesDeleted: 0, skipped: [], ...(scope ? { scope } : {}),
  });
  const now = (p: { path: string; match: unknown }): unknown => ({ path: p.path, match: p.match });
  const editedOn = policy('edited-on'); // never approved, on: its newest preview was made before an edit
  const olderOff = policy('older-build-off', { enabled: false }); // never approved, off: its newest run an earlier build recorded
  const olderApproved = policy('older-build-approved', { approvedAt: 5 }); // approved: its newest run held by an earlier build
  const ranAgain = policy('ran-again'); // an older preview; the newest is current
  const ranSince = policy('ran-since', { approvedAt: 5 }); // an older held run; the newest completed
  const approvedOff = policy('approved-off', { approvedAt: 5, enabled: false, cooldownDays: 1 }); // approved, off: its newest held by an earlier build
  const removed = { id: 'removed' }; // a policy since deleted
  const html = renderedRuns([
    run('edited-newest', editedOn, 'awaiting-approval', { path: editedOn.path, match: { kind: 'custom', exts: ['tmp'] } }),
    run('off-newest', olderOff, 'awaiting-approval', null),
    run('approved-newest', olderApproved, 'awaiting-approval', null),
    run('approved-off-newest', approvedOff, 'awaiting-approval', null),
    run('removed-newest', removed, 'awaiting-approval', null),
    run('again-new', ranAgain, 'awaiting-approval', now(ranAgain)),
    run('again-old', ranAgain, 'awaiting-approval', now(ranAgain)),
    run('since-new', ranSince, 'completed', now(ranSince)),
    run('since-old', ranSince, 'awaiting-approval', now(ranSince)),
  ], [editedOn, olderOff, olderApproved, ranAgain, ranSince, approvedOff]);

  const edited = noteOf(html, 'edited-newest');
  assert.match(edited, /changed since this run/, edited);
  assert.match(edited, /previews what it matches now at its next check; approve that run/, edited);
  assert.doesNotMatch(edited, /approve its newest run/, `it is the newest: ${edited}`);

  const off = noteOf(html, 'off-newest');
  assert.match(off, /earlier version of TreeMap/, off);
  assert.match(off, /once it is switched on/, `the scheduler passes over a policy switched off: ${off}`);
  assert.doesNotMatch(off, /at its next check/, off);

  const approved = noteOf(html, 'approved-newest');
  assert.match(approved, /earlier version of TreeMap/, approved);
  assert.match(approved, /not previewed again/, `an approved policy is never brought forward: ${approved}`);
  assert.match(approved, /every 7 days/, `it says when its next run comes: ${approved}`);
  assert.doesNotMatch(approved, /previews what it matches now|at its next check|switched on/, approved);
  const approvedOffNote = noteOf(html, 'approved-off-newest');
  assert.match(approvedOffNote, /every 1 day once it is switched on/, approvedOffNote);

  assert.equal(noteOf(html, 'removed-newest'), 'Recorded by an earlier version of TreeMap, so it cannot be approved.', 'a removed policy has nothing next');

  assert.match(noteOf(html, 'again-old'), /approve its newest run\./, 'a newer run can be approved: it is named');
  const since = noteOf(html, 'since-old');
  assert.match(since, /ran again/, since);
  assert.doesNotMatch(since, /approve its newest run/, `the newest run asks nothing, so none is offered: ${since}`);
});

test('the approval names the run, and its confirm says the folder, the match and how much', async () => {
  const posted: { url: string; body: unknown }[] = [];
  const texts: Record<string, string> = {};
  const el = (id: string): Record<string, unknown> => ({
    set innerHTML(v: string) { texts[id] = v; }, get innerHTML() { return texts[id] ?? ''; }, classList: { add: () => undefined },
  });
  const make = new Function(
    '$', 'state', 'api', 'toast', 'icon', 'escapeHtml', 'formatBytes', 'loadAutopilot', 'describeMatch',
    `let onConfirmTrash = null; ${pageSource('approveAutopilotRun')}; return { approve: approveAutopilotRun, confirm: () => onConfirmTrash };`,
  );
  const page = make(
    el, { autopilot: { policies: [POLICY_A, POLICY_B], runs: RUNS } },
    async (url: string, opts: { body: string }) => { posted.push({ url, body: JSON.parse(opts.body) }); return {}; },
    () => undefined, () => '', (s: string) => s, (n: number) => `${n} B`, () => undefined, () => 'files ending .log/.txt',
  ) as { approve: (runId: string) => void; confirm: () => (() => Promise<void>) | null };
  page.approve('a-new');
  assert.match(texts.confirmText, /\/home\/me\/logs/, texts.confirmText);
  assert.match(texts.confirmText, /files ending \.log\/\.txt/, texts.confirmText);
  assert.match(texts.confirmText, /2000 B/, texts.confirmText);
  await page.confirm()?.();
  assert.deepEqual(posted, [{ url: '/api/autopilot/policies/A/approve', body: { runId: 'a-new' } }]);
});
