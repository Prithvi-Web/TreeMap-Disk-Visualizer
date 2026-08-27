import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-q2p-'));
process.env.TREEMAP_DATA_DIR = DATA_DIR;
process.env.TREEMAP_NO_GDU = '1';

import {
  normalizePolicy,
  savePolicies,
  listPolicies,
  sameScope,
  selectCandidates,
  applyCaps,
  effectiveCap,
  simulatePolicy,
  runPolicy,
  approvePolicy,
} from '../src/services/autopilot';
import { AppError } from '../src/middleware/errorHandler';
import type { AutopilotPolicy, AutopilotRun } from '../src/models/types';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(path.join(__dirname_, '..', 'public', 'index.html'), 'utf8');
const AUTOPILOT_SRC = readFileSync(path.join(__dirname_, '..', 'src', 'services', 'autopilot.ts'), 'utf8');

/**
 * Phase 4 §4.5 — query → Clean Up rule → Autopilot policy.
 *
 * The ladder's whole value is that the top rung is not a new pathway. §4.5 is
 * unusually blunt about it: a promoted policy "inherits every existing rail
 * unchanged … do not weaken, bypass or special-case a single one of these, and
 * do not add a path that reaches Autopilot execution without them."
 *
 * So this file does not test that promotion works. It tests, rail by rail,
 * that promotion changed nothing — that a policy built from a query is
 * indistinguishable, in every field that governs what it may delete, from one
 * typed by hand.
 */

after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const HOME = os.homedir();
const SAFE_PATH = path.join(HOME, 'q2p-fixture');

function promoted(overrides: Record<string, unknown> = {}): AutopilotPolicy {
  return normalizePolicy({
    name: 'Old logs',
    path: SAFE_PATH,
    match: { kind: 'query', q: 'ext:log modified>90d' },
    ...overrides,
  });
}

/* ══════════════ the query itself is validated by the one parser ══════════════ */

test('a query policy stores the query, parsed and trimmed', () => {
  const p = promoted({ match: { kind: 'query', q: '  ext:log modified>90d  ' } });
  assert.equal(p.match.kind, 'query');
  assert.equal((p.match as { q: string }).q, 'ext:log modified>90d');
});

test('a query that does not parse cannot be saved', () => {
  assert.throws(
    () => promoted({ match: { kind: 'query', q: 'nosuchfield:7' } }),
    (err: AppError) => {
      assert.equal(err.code, 'POLICY_QUERY_INVALID');
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test('a query with no conditions is refused — it would match every file in the folder', () => {
  // The same refusal an empty custom rule gets, and for the same reason. This
  // is the one that turns a policy into a disaster if it is missing.
  for (const q of ['', '   ']) {
    assert.throws(() => promoted({ match: { kind: 'query', q } }), (err: AppError) => {
      assert.equal(err.code, 'POLICY_MATCH_EMPTY');
      return true;
    });
  }
});

test('an unknown match kind is still refused now that a third exists', () => {
  assert.throws(() => promoted({ match: { kind: 'regex', pattern: '.*' } }), (err: AppError) => {
    assert.equal(err.code, 'POLICY_MATCH_INVALID');
    return true;
  });
});

/* ══════════════ every rail, field by field ══════════════ */

test('rail 1: a promoted policy has never been approved, so its first run cannot delete', () => {
  const p = promoted();
  assert.equal(p.approvedAt, undefined, 'approval is not something promotion can grant');
});

test('rail 1: a client cannot grant approval by sending the field', () => {
  const p = promoted({ approvedAt: Date.now(), lastRunAt: Date.now() });
  assert.equal(p.approvedAt, undefined, 'approvedAt is bookkeeping the engine owns');
  assert.equal(p.lastRunAt, undefined);
});

test('rail 2: the byte caps exist and are null-by-default, not absent', () => {
  const p = promoted();
  assert.equal(p.maxBytesPerRun, null);
  assert.equal(p.maxBytesPerWeek, null);
  const capped = promoted({ maxBytesPerRun: 5 * 1024 ** 3, maxBytesPerWeek: 20 * 1024 ** 3 });
  assert.equal(capped.maxBytesPerRun, 5 * 1024 ** 3);
  assert.equal(capped.maxBytesPerWeek, 20 * 1024 ** 3);
});

test('rail 2: the caps bind a query policy exactly as they bind any other', () => {
  const candidates = [
    { path: '/a', name: 'a', bytes: 400, reason: 'r' },
    { path: '/b', name: 'b', bytes: 400, reason: 'r' },
    { path: '/c', name: 'c', bytes: 400, reason: 'r' },
  ];
  const { selected, skipped } = applyCaps(candidates, 900);
  assert.equal(selected.length, 2);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /left for a later run/);
});

test('rail 2: the rolling weekly budget is what is left of the week, for a query policy too', () => {
  const p = promoted({ maxBytesPerRun: 1000, maxBytesPerWeek: 1500 });
  const now = Date.now();
  const runs = [{
    id: 'r1', policyId: p.id, policyName: p.name, at: now - 86_400_000,
    mode: 'live', status: 'completed', items: [], bytesMatched: 900, bytesDeleted: 900, skipped: [],
  }] as unknown as AutopilotRun[];
  assert.equal(effectiveCap(p, runs, now), 600, 'the tighter of 1000 and the 600 left this week');
});

test('rail 3: the cooldown is clamped to a real number of days', () => {
  assert.equal(promoted().cooldownDays, 7);
  assert.equal(promoted({ cooldownDays: 0 }).cooldownDays, 7);
  assert.equal(promoted({ cooldownDays: 5000 }).cooldownDays, 365);
  assert.equal(promoted({ cooldownDays: 3 }).cooldownDays, 3);
});

test('rail 4: "ask me first above N" survives promotion', () => {
  assert.equal(promoted().requireConfirmationAbove, null);
  assert.equal(promoted({ requireConfirmationAbove: 2 * 1024 ** 3 }).requireConfirmationAbove, 2 * 1024 ** 3);
});

test('rail 5: the only delete in Autopilot is still protectAndTrash', () => {
  // §10: no new deletion pathway. A query policy must not have acquired one.
  assert.ok(AUTOPILOT_SRC.includes('protectAndTrash'), 'the capsule-backed delete is present');
  for (const forbidden of ['moveToTrash(', 'fsp.rm(', 'fs.rmSync(', 'unlink']) {
    assert.ok(!AUTOPILOT_SRC.includes(forbidden), `autopilot.ts must not call ${forbidden}`);
  }
});

test('rail 6: a promoted policy starts disabled and previewing', () => {
  const p = promoted();
  assert.equal(p.enabled, false, 'nothing is scheduled by promotion alone');
  assert.equal(p.dryRunFirst, true);
});

test('editing a query policy scope drops the approval it had', async () => {
  const a = promoted();
  const b = normalizePolicy({ ...a, match: { kind: 'query', q: 'ext:tmp' } });
  assert.equal(sameScope(a, b), false, 'a different query is a different scope');

  // …and savePolicies enforces it, which is where it matters: "approve a tiny
  // preview, then edit the query to match everything" is exactly the walk-past
  // the rail exists to stop.
  await savePolicies([a]);
  const stored = (await listPolicies())[0];
  // Through approvePolicy, because sending `approvedAt` in the body is exactly
  // what rail 1 refuses — the test above proves it, and this one would quietly
  // pass for the wrong reason if it tried the same trick.
  await approvePolicy(stored.id);
  assert.ok((await listPolicies())[0].approvedAt, 'approval persisted');

  await savePolicies([{ ...stored, match: { kind: 'query', q: 'ext:tmp' } }]);
  assert.equal((await listPolicies())[0].approvedAt, undefined, 'and was dropped when the query changed');
  await savePolicies([]);
});

test('a query policy is not confused with a custom one by sameScope', () => {
  const q = promoted();
  const c = normalizePolicy({ name: 'x', path: SAFE_PATH, match: { kind: 'custom', exts: ['log'] } });
  assert.equal(sameScope(q, c), false);
});

/* ══════════════ resolution: the same engine, no second matcher ══════════════ */

test('a query match turns hits into candidates that name the query as the reason', () => {
  const hits = [
    { path: '/a/big.log', name: 'big.log', size: 900 },
    { path: '/a/small.log', name: 'small.log', size: 100 },
  ];
  const out = selectCandidates([], hits, { kind: 'query', q: 'ext:log' });
  assert.equal(out.length, 2);
  assert.equal(out[0].path, '/a/big.log', 'largest first, like every other kind');
  // The run record and the capsule entry both carry this; it has to say what
  // actually matched rather than "a rule".
  assert.match(out[0].reason, /matched your query: ext:log/);
});

test('resolution goes through the shared evaluator, not a second matcher', () => {
  // §7 forbids a second query language, and this is where one would start.
  assert.match(AUTOPILOT_SRC, /executeAgainstScan/, 'the same evaluator POST /api/query uses');
  assert.match(AUTOPILOT_SRC, /import \{ parse \} from '\.\/query\/parse'/, 'and the one parser');
});

test('a query policy never trashes a directory unattended', () => {
  // A query may legitimately ask for type:dir. A person can stage a folder by
  // hand, where they can see it; an unattended policy doing it is a different
  // blast radius, so the resolver drops them.
  const start = AUTOPILOT_SRC.indexOf("if (policy.match.kind === 'query')");
  assert.notEqual(start, -1);
  const body = AUTOPILOT_SRC.slice(start, AUTOPILOT_SRC.indexOf('const hits = matchCustomRules', start));
  assert.match(body, /filter\(\(h\) => !h\.isDir\)/);
});

/* ══════════════ the first run really is a preview ══════════════ */

test('the first run of a promoted policy deletes nothing and asks for approval', async () => {
  await fsp.mkdir(SAFE_PATH, { recursive: true });
  const stale = path.join(SAFE_PATH, 'old.log');
  await fsp.writeFile(stale, Buffer.alloc(4096, 3));
  // Backdate it well past the query's 90-day threshold.
  const old = new Date(Date.now() - 400 * 86_400_000);
  await fsp.utimes(stale, old, old);
  try {
    const p = promoted();
    await savePolicies([p]);
    const run = await runPolicy((await listPolicies())[0], { ignoreCooldown: true });

    assert.equal(run.status, 'awaiting-approval');
    assert.equal(run.mode, 'dry-run', 'a first run is never live');
    assert.equal(run.bytesDeleted, 0);
    assert.match(run.blockedReason ?? '', /never run/i);
    assert.ok(fs.existsSync(stale), 'the file is still there');
    await savePolicies([]);
  } finally {
    await fsp.rm(SAFE_PATH, { recursive: true, force: true });
  }
});

test('simulating a promoted policy says why a real run would refuse', async () => {
  await fsp.mkdir(SAFE_PATH, { recursive: true });
  try {
    const p = promoted();
    const sim = await simulatePolicy(p);
    assert.equal(sim.policyName, 'Old logs');
    assert.match(sim.wouldBlockReason ?? '', /never run for real/i);
    assert.equal(sim.bytesWouldDelete, 0);
  } finally {
    await fsp.rm(SAFE_PATH, { recursive: true, force: true });
  }
});

/* ══════════════ the frontend half of the ladder ══════════════ */

function slice(from: string, to: string): string {
  const start = INDEX.indexOf(from);
  assert.notEqual(start, -1, `anchor not found: ${from}`);
  const end = INDEX.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `end anchor not found: ${to}`);
  const out = INDEX.slice(start, end);
  assert.ok(out.length > 100, `the slice ${from} → ${to} is suspiciously short`);
  return out;
}

test('a saved view runs as a Clean Up rule through the same query endpoint', () => {
  const body = slice('async function findBySavedView', "$('cleanFindBtn').addEventListener");
  assert.match(body, /'\/api\/query'/, 'the one engine, not a local re-implementation');
  assert.match(body, /degraded/, 'and a degraded result is surfaced, not shown as "nothing matched"');
});

test('promotion opens the existing editor and saves nothing by itself', () => {
  const body = slice('function promoteRuleToPolicy', "$('cleanPromoteBtn').addEventListener");
  assert.match(body, /openPolicyEditor\(/, 'the existing editor, not a new dialog');
  assert.ok(!body.includes("method: 'PUT'"), 'promotion never writes a policy');
  assert.ok(!body.includes('/approve'), 'and certainly never approves one');
  // The two fields that decide whether it can delete unattended.
  assert.match(body, /dryRunFirst: true/);
  assert.match(body, /enabled: false/);
});

test('the policy editor validates a query through the parse-only endpoint', () => {
  const body = slice('async function validateApQuery', 'let apQueryDeb = 0;');
  assert.match(body, /'\/api\/query\/validate'/);
  // A client-side parser here would be the second query language §7 forbids.
  assert.ok(!body.includes('function parseQuery'), 'no second parser');
});

test('the policy editor round-trips a query match', () => {
  const from = slice('function policyFromEditor', 'document.querySelectorAll(\'#apMatchSeg button\')');
  assert.match(from, /kind: 'query', q: \$\('apRuleQuery'\)\.value\.trim\(\)/);
  const into = slice('function openPolicyEditor', 'function setApMatchKind');
  assert.match(into, /apDraft\.match\?\.kind === 'query'/);
  assert.match(into, /\$\('apRuleQuery'\)\.value = kind === 'query'/);
});

test('the duplicates-only rule is refused for promotion rather than silently dropped', () => {
  // matchCustomRules' `dup` flag has no AutopilotMatch equivalent. Promoting a
  // rule that included it would produce a policy that means something else.
  const body = slice('function promoteRuleToPolicy', "$('cleanPromoteBtn').addEventListener");
  assert.match(body, /duplicates-only rule cannot run unattended/);
});
