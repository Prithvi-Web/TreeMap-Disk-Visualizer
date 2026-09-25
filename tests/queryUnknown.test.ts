import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { isolatedDataDir, fileTempDir } from './fixtures/dataDir';
// Policies, run history and the Time Capsule land here, never in real app
// data: an Autopilot test that wrote to the real store would leave a standing
// instruction to delete the user's files.
isolatedDataDir('treemap-query-unknown-');
process.env.TREEMAP_NO_GDU = '1';

import { parse } from '../src/services/query/parse';
import { evaluate, evaluateMaybe, type EvalFacts, type EvalNode } from '../src/services/query/evaluate';
import { executeAgainstScan, gitStateOf, cloudStateOf, type QueryOutcome } from '../src/services/query/execute';
import { startScan, peekScan } from '../src/services/diskScanner';
import { normalizePolicy, savePolicies, listPolicies, simulatePolicy, runPolicy } from '../src/services/autopilot';
import { readJsonFile, writeJsonFile } from '../src/services/storage';
import { setTrashStepForTests } from '../src/services/cleaner';
import { AppError } from '../src/middleware/errorHandler';
import type { AutopilotPolicy, AutopilotRun } from '../src/models/types';
import type { Ast } from '../src/services/query/types';
import { waitFor } from './fixtures/waitFor';
import { recoverabilityProvider } from '../src/services/facts/recoverabilityProvider';
import { platform } from '../src/platform';
import { resetNativeForTests, setNativeLoadOverrideForTests } from '../src/services/scan/native';

/** A native module whose `dataIsLocal` answers each path by its base name; `null` for no module that can ask. */
function localityStandIn(answer: ((name: string) => number) | null): void {
  resetNativeForTests();
  const mod: Record<string, unknown> = { version: () => '0.0.0-test' };
  if (answer) mod.dataIsLocal = (paths: string[]) => Uint8Array.from(paths.map((p) => answer(path.basename(p))));
  setNativeLoadOverrideForTests({ path: '/stand-in/treemap_core.node', expectedVersion: '0.0.0-test', requireModule: () => mod });
}

function realLocality(): void {
  setNativeLoadOverrideForTests(null);
  resetNativeForTests();
}

/**
 * An unknown is not a "no" (v4 §2.2, three-valued logic).
 *
 * The defect this file pins: `dupe:` parses but nothing ever supplies the
 * fact, so every file's `dupe:` term is unknown. The evaluator read unknown
 * as false, and a leading `-` flipped that false to true — so `-dupe:yes`
 * matched EVERY file in the scan, and an Autopilot policy built from it
 * selected everything under its folder for unattended trashing, with only
 * the mandatory first approval in the way.
 *
 * The rule is Kleene's: unknown stays unknown under `-`; `unknown and false`
 * is false; `unknown or true` is true; and only a definite true at the top of
 * the query matches. An unknown can therefore make a result smaller, never
 * larger. It is not a `dupe:` rule — every fact-backed field has the same
 * "could not be supplied" state, so each is asserted here.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 15);
const HOME = '/Users/tester';

function node(over: Partial<EvalNode> = {}): EvalNode {
  return {
    name: 'clip.mp4',
    path: '/Users/tester/Movies/clip.mp4',
    size: 5_000,
    isDir: false,
    mtimeMs: NOW - 400 * DAY,
    depth: 3,
    ...over,
  };
}

function ast(q: string): Ast {
  const r = parse(q);
  assert.equal(r.ok, true, `"${q}" failed to parse` + (r.ok ? '' : `: ${r.error}`));
  return (r as { ok: true; ast: Ast }).ast;
}

const hit = (q: string, n: EvalNode, facts: EvalFacts): boolean => evaluate(ast(q), { node: n, facts, now: NOW }, HOME);

/** Files of both kinds `size>0` can split: one it matches, one it does not. */
const FILES: EvalNode[] = [
  node(),
  node({ name: 'empty.mp4', path: '/Users/tester/Movies/empty.mp4', size: 0 }),
  node({ name: 'b.log', path: '/Users/tester/b.log', size: 70, depth: 1 }),
];

/**
 * Every term that can be unknown, in the state the executor hands the
 * evaluator when it could not supply the fact. `{}` is literal: pass two
 * leaves a fact unset when its provider is unavailable on this machine, when
 * the path is absent from the provider's values, or — for `dupe:` — always,
 * because nothing fetches it at all.
 */
const UNKNOWN_TERMS: { term: string; why: string }[] = [
  { term: 'dupe:yes', why: 'nothing supplies duplicate facts to the evaluator' },
  { term: 'dupe:no', why: 'nothing supplies duplicate facts to the evaluator' },
  { term: 'elsewhere:proven', why: 'recoverability unavailable, or the path absent from its values' },
  { term: 'elsewhere:unknown', why: 'no verdict at all is not the provider\'s own "unknown" verdict' },
  { term: 'git:dirty', why: 'recoverability unavailable for this path' },
  { term: 'backup:no', why: 'recoverability unavailable for this path' },
  { term: 'cloud:local-only', why: 'recoverability unavailable for this path' },
  { term: 'score>70', why: 'a file the reclaim score could not score at all' },
  { term: 'used<90d', why: 'last-opened dates are not available on this machine' },
  { term: 'used>1y', why: 'last-opened dates are not available on this machine' },
  { term: 'used:never', why: 'never asked is not "never opened"' },
  { term: 'created<30d', why: 'a creation time not yet read' },
];

/* ============================ the evaluator ============================ */

test('a term whose fact could not be supplied matches nothing — and neither does its negation', () => {
  for (const { term, why } of UNKNOWN_TERMS) {
    for (const n of FILES) {
      assert.equal(hit(term, n, {}), false, `${term} on ${n.name} (${why})`);
      assert.equal(
        hit(`-${term}`, n, {}), false,
        `-${term} on ${n.name}: an unknown negated is still unknown, not "every file" (${why})`,
      );
    }
  }
});

test('beside `or`, an unknown leaves exactly what the known side matches', () => {
  for (const { term, why } of UNKNOWN_TERMS) {
    for (const n of FILES) {
      const known = hit('size>0', n, {});
      assert.equal(hit(`${term} or size>0`, n, {}), known, `${term} or size>0 on ${n.name} (${why})`);
      assert.equal(hit(`-${term} or size>0`, n, {}), known, `-${term} or size>0 on ${n.name} (${why})`);
      assert.equal(hit(`size>0 or -${term}`, n, {}), known, `size>0 or -${term} on ${n.name}: order must not matter`);
    }
  }
  // Not vacuous: the known side really does split the files.
  assert.deepEqual(FILES.map((n) => hit('size>0', n, {})), [true, false, true]);
});

test('-(unknown and known): only a definite false inside decides it', () => {
  // `unknown and false` is false, so its negation is TRUE — the empty file
  // matches on the strength of `size>0` alone, whatever the unknown would
  // have said. `unknown and true` is unknown, so its negation is unknown and
  // the other files do not match: their answer depends on the missing fact.
  for (const { term, why } of UNKNOWN_TERMS) {
    for (const n of FILES) {
      assert.equal(
        hit(`-(${term} size>0)`, n, {}), n.size === 0,
        `-(${term} size>0) on ${n.name} (size ${n.size}) (${why})`,
      );
    }
  }
});

test('an unknown child count behaves the same way for empty:', () => {
  // A directory nobody managed to list. Reading `empty:yes` as false and then
  // negating it offered a permission-denied folder up as "not empty"; reading
  // `empty:no` the same way offered it up as empty.
  const dirs = [
    node({ name: 'unlisted', path: '/Users/tester/unlisted', isDir: true, size: 9_000, childCount: undefined }),
    node({ name: 'bare', path: '/Users/tester/bare', isDir: true, size: 0, childCount: undefined }),
  ];
  for (const term of ['empty:yes', 'empty:no']) {
    for (const n of dirs) {
      assert.equal(hit(term, n, {}), false, `${term} on ${n.name}`);
      assert.equal(hit(`-${term}`, n, {}), false, `-${term} on ${n.name}`);
      assert.equal(hit(`-${term} or size>0`, n, {}), n.size > 0, `-${term} or size>0 on ${n.name}`);
      assert.equal(hit(`-(${term} size>0)`, n, {}), n.size === 0, `-(${term} size>0) on ${n.name}`);
    }
  }
});

test('a fact that WAS supplied still negates normally', () => {
  // The fix must not overcorrect into "negation never matches".
  const f = FILES[0];
  assert.equal(hit('-dupe:yes', f, { dupe: false }), true);
  assert.equal(hit('-dupe:yes', f, { dupe: true }), false);
  assert.equal(hit('-elsewhere:proven', f, { elsewhere: 'none' }), true);
  // The provider's own "unknown" verdict is an answer — "nothing proves a
  // copy exists" — so it is definitely not `proven`. Only the ABSENCE of a
  // verdict is unknown to the evaluator.
  assert.equal(hit('-elsewhere:proven', f, { elsewhere: 'unknown' }), true);
  assert.equal(hit('elsewhere:unknown', f, { elsewhere: 'unknown' }), true);
  assert.equal(hit('-git:dirty', f, { git: 'pushed' }), true);
  assert.equal(hit('-score>70', f, { score: 10 }), true);
  assert.equal(hit('-used<90d', f, { lastUsedMs: NOW - 400 * DAY }), true);
  assert.equal(hit('-empty:yes', node({ isDir: true, childCount: 3 }), {}), true);
  assert.equal(hit('-size>1gb', f, {}), true, 'and a tree-only term never had anything unknown about it');
});

test('evaluate is exactly "the three-valued answer is a definite true"', () => {
  // One evaluator with one notion of unknown, not two that agree today.
  const queries = [
    'dupe:yes', '-dupe:yes', '-dupe:yes or size>0', '-(dupe:yes size>0)', 'size>0 -dupe:no',
    '-elsewhere:proven', 'git:pushed or -backup:yes', '-(score>70 or used>1y)', '-used:never',
    '(size>1kb or dupe:yes) -in:node_modules', '-(-dupe:yes)', 'type:file -(cloud:synced or git:dirty)',
  ];
  const factSets: EvalFacts[] = [
    {}, { dupe: true }, { dupe: false }, { elsewhere: 'proven' }, { elsewhere: 'unknown' },
    { git: 'pushed', backup: 'yes' }, { score: 90, lastUsedMs: NOW - 500 * DAY }, { lastUsedMs: null }, { cloud: null },
  ];
  const nodes = [...FILES, node({ isDir: true, childCount: undefined, name: 'd', path: '/d' })];
  let checked = 0;
  for (const q of queries) {
    const parsed = ast(q);
    for (const n of nodes) {
      for (const facts of factSets) {
        checked++;
        const ctx = { node: n, facts, now: NOW };
        assert.equal(evaluate(parsed, ctx, HOME), evaluateMaybe(parsed, ctx, HOME) === true, `"${q}" on ${n.name} with ${JSON.stringify(facts)}`);
      }
    }
  }
  assert.ok(checked >= 400, `expected a broad sweep, ran ${checked}`);
});

/* ============================ the executor, on a real scan ============================ */

let fixture: Promise<{ root: string; scanId: string }> | null = null;

/** One small scanned folder, shared by the executor tests. */
function scannedFixture(): Promise<{ root: string; scanId: string }> {
  fixture ??= (async () => {
    const root = fileTempDir('treemap-query-unknown-scan-');
    fs.writeFileSync(path.join(root, 'a.log'), Buffer.alloc(1_000, 1));
    fs.writeFileSync(path.join(root, 'b.log'), Buffer.alloc(2_000, 2));
    fs.writeFileSync(path.join(root, 'empty.txt'), Buffer.alloc(0));
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'c.bin'), Buffer.alloc(3_000, 3));
    const scan = await startScan(root);
    await waitFor(() => peekScan(scan.scanId)?.status !== 'running', `fixture scan ${scan.scanId} settling`);
    assert.equal(peekScan(scan.scanId)?.status, 'complete');
    return { root, scanId: scan.scanId };
  })();
  return fixture;
}

async function run(q: string): Promise<QueryOutcome> {
  const { scanId } = await scannedFixture();
  const out = await executeAgainstScan(scanId, ast(q), {
    limit: 1_000, offset: 0, sort: 'path', signal: new AbortController().signal,
  });
  assert.ok(!('error' in out), `"${q}": ${JSON.stringify(out)}`);
  return out as QueryOutcome;
}

const pathsOf = async (q: string): Promise<string[]> => (await run(q)).hits.map((h) => h.path).sort();

test('-dupe:yes matches nothing on a real scan, and says why', async () => {
  const everything = await pathsOf('size>=0');
  assert.ok(everything.length >= 5, `the fixture should have files and folders; got ${everything.length}`);

  for (const q of ['-dupe:yes', 'dupe:yes', '-dupe:no', 'dupe:no', 'type:file -dupe:yes', '-(dupe:yes or dupe:no)']) {
    const out = await run(q);
    assert.equal(out.total, 0, `"${q}" matched ${out.total} of ${everything.length}: ${out.hits.map((h) => h.name).join(', ')}`);
    const duplicates = out.degraded.find((d) => d.provider === 'duplicates');
    assert.ok(duplicates, `"${q}" must name the missing signal, so an empty list reads as "unknown"`);
    assert.match(duplicates.reason, /-dupe:/, 'the reason says the negation matches nothing too — it used to match everything');
  }
});

test('on a real scan, the files an unknown left out are counted in degraded', async () => {
  // Unknown is not a match, so an unknown shrinks a result. Saying which
  // signal was missing is not enough: "not matched" and "could not tell"
  // must stay apart in the answer, file for file.
  const everything = await pathsOf('size>=0');
  const undecided = (out: QueryOutcome) => out.degraded.find((d) => d.provider === 'undecided')?.reason;
  assert.equal(undecided(await run('-dupe:yes')),
    `${everything.length} items could not be decided — a fact this query needs was not available for them — so they are not in these results.`,
    'every file and folder is undecided under -dupe:yes');
  // Beside an `or`, only the empty file is left to the unknown side.
  assert.equal(undecided(await run('dupe:yes or size>0')),
    '1 item could not be decided — a fact this query needs was not available for it — so it is not in these results.');
  assert.equal(undecided(await run('size>0')), undefined, 'a query this machine answers in full leaves nothing undecided');
  const sized = (await pathsOf('size>0')).length;
  assert.ok(sized > 1 && sized < everything.length, `size>0 splits the fixture: ${sized} of ${everything.length}`);
  assert.equal(undecided(await run('dupe:yes size>0')), `${sized} items could not be decided — a fact this query needs was not available for them — so they are not in these results.`,
    'a file decided false by the known side is not counted as undecided');
});

// Whether this machine's temp folder records creation times (statx on Linux, always on macOS and Windows).
const noBirthtime = fs.statSync(fileTempDir('treemap-query-unknown-birth-')).birthtimeMs > 0
  ? false : 'this filesystem records no creation times, so created: is unknown for every file here';

test('on a real scan, a file the looked-up facts decide against is not counted as undecided', { skip: noBirthtime }, async () => {
  // created: is decided only in the second pass, from each candidate's own
  // stat: every fixture file was made today, so each is a definite no.
  const out = await run('created<2000-01-01');
  assert.equal(out.total, 0, 'nothing here was created before 2000');
  assert.equal(out.degraded.find((d) => d.provider === 'undecided'), undefined, 'and a no is not an unknown');
});

test('on a real scan, an unknown beside or leaves exactly the known side', async () => {
  const known = await pathsOf('size>0');
  assert.ok(known.length > 0 && known.length < (await pathsOf('size>=0')).length, 'size>0 must split the fixture');
  assert.deepEqual(await pathsOf('dupe:yes or size>0'), known);
  assert.deepEqual(await pathsOf('-dupe:yes or size>0'), known);
  assert.deepEqual(await pathsOf('size>0 or -dupe:no'), known);
});

test('on a real scan, -(dupe:yes size>0) matches only what size>0 alone decides', async () => {
  const { root } = await scannedFixture();
  const zero = await pathsOf('-size>0');
  assert.ok(zero.includes(path.join(root, 'empty.txt')), 'the empty file is decided by size>0 being false');
  assert.ok(!zero.includes(path.join(root, 'a.log')), 'a sized file is not');
  assert.deepEqual(await pathsOf('-(dupe:yes size>0)'), zero);
});

/* ============================ Autopilot ============================ */

function policyAt(dir: string, q: string, over: Partial<AutopilotPolicy> = {}): AutopilotPolicy {
  return {
    id: `unknown-${q}`,
    name: `Query ${q}`,
    path: dir,
    match: { kind: 'query', q },
    maxBytesPerRun: null,
    maxBytesPerWeek: null,
    cooldownDays: 7,
    dryRunFirst: false,
    requireConfirmationAbove: null,
    enabled: true,
    ...over,
  };
}

function policyFolder(): string {
  const dir = fileTempDir('treemap-query-unknown-policy-');
  fs.writeFileSync(path.join(dir, 'old.log'), Buffer.alloc(4_096, 7));
  fs.writeFileSync(path.join(dir, 'new.log'), Buffer.alloc(2_048, 8));
  fs.mkdirSync(path.join(dir, 'keep'));
  fs.writeFileSync(path.join(dir, 'keep', 'photo.jpg'), Buffer.alloc(8_192, 9));
  return dir;
}

test('a policy that uses dupe: cannot be saved, and the refusal names the field', async () => {
  // Under three-valued logic a `dupe:` term can never contribute a match: it
  // sinks whatever it is ANDed with, and beside an `or` it is dead weight.
  // Saved as a policy it would never do what its text says — and a run
  // reports no `degraded`, so save time is the only moment anyone is told.
  const dir = policyFolder();
  const refused = [
    '-dupe:yes', 'dupe:yes', 'dupe:no', '-dupe:no',
    'ext:log dupe:yes', 'size>1gb or dupe:yes', '-(dupe:yes size<1kb)', 'ext:log (in:keep or -dupe:no)',
  ];
  for (const q of refused) {
    assert.throws(
      () => normalizePolicy({ name: 'x', path: dir, match: { kind: 'query', q } }),
      (err: unknown) => {
        assert.ok(err instanceof AppError, `"${q}" threw ${String(err)}`);
        assert.equal(err.status, 400, q);
        assert.equal(err.code, 'POLICY_QUERY_UNANSWERABLE', q);
        assert.match(err.message, /"dupe:"/, `"${q}": the message names the field`);
        return true;
      },
      `"${q}" must be refused`,
    );
  }

  // savePolicies goes through the same check, and a refused list stores nothing.
  await savePolicies([]);
  await assert.rejects(
    savePolicies([
      { name: 'fine', path: dir, match: { kind: 'query', q: 'ext:log' } },
      { name: 'not fine', path: dir, match: { kind: 'query', q: '-dupe:yes' } },
    ]),
    (err: unknown) => err instanceof AppError && err.code === 'POLICY_QUERY_UNANSWERABLE',
  );
  assert.deepEqual(await listPolicies(), []);
});

test('a dupe: policy an earlier build saved never blocks saving the others; changing it is refused, by name', async () => {
  // The UI saves the whole list for every edit — deleting, renaming or
  // switching off ANY policy re-sends every other one. Were the unchanged
  // old policy refused there, nothing in the list could be changed, not even
  // a different policy that is approved and deleting files unattended. It is
  // refused where a person is writing it: new, or its folder or query changed.
  const dir = policyFolder();
  const old = policyAt(dir, '-dupe:yes ext:jpg', { id: 'old', name: 'Old photos' });
  const other = policyAt(dir, 'ext:log', { id: 'other', name: 'Logs', approvedAt: 1_000 });
  await writeJsonFile('autopilot.json', { version: 1, policies: [old, other], runs: [] });
  const stored = async () => (await listPolicies()).map((p) => [p.id, p.name, p.enabled, p.match.kind === 'query' ? p.match.q : '']);
  try {
    await savePolicies([old, { ...other, name: 'Logs, renamed' }]);
    assert.deepEqual(await stored(), [['old', 'Old photos', true, '-dupe:yes ext:jpg'], ['other', 'Logs, renamed', true, 'ext:log']], 'another policy renamed');
    assert.equal((await listPolicies())[1]?.approvedAt, 1_000, 'and its approval kept, its scope unchanged');
    await savePolicies([{ ...old, enabled: false }, other]);
    assert.deepEqual((await stored())[0], ['old', 'Old photos', false, '-dupe:yes ext:jpg'], 'the old one switched off');
    await savePolicies([{ ...old, enabled: false }]);
    assert.deepEqual((await stored()).map((p) => p[0]), ['old'], 'another policy deleted');

    const before = await stored();
    for (const [what, edit] of [
      ['its query changed', { ...old, match: { kind: 'query', q: '-dupe:yes ext:png' } }],
      ['its folder changed', { ...old, path: path.join(dir, 'keep') }],
      ['a new one', { name: 'New photos', path: dir, match: { kind: 'query', q: 'dupe:yes' } }],
    ] as const) {
      await assert.rejects(savePolicies([old, edit]), (err: unknown) => {
        assert.ok(err instanceof AppError, `${what}: ${String(err)}`);
        assert.equal(err.code, 'POLICY_QUERY_UNANSWERABLE', what);
        assert.match(err.message, new RegExp(`^The policy "${edit.name}" uses "dupe:"`), `${what}: the refusal names the policy and the field`);
        return true;
      }, `${what} is refused`);
      assert.deepEqual(await stored(), before, `${what}: nothing was stored`);
    }
  } finally {
    await savePolicies([]);
  }
});

test('the refusal is about the dupe: field, not the letters in it', () => {
  const dir = policyFolder();
  // A file name, a quoted bare word and a folder name that merely contain
  // "dupe" are ordinary conditions this build answers.
  for (const q of ['name:dupe', '"dupe:yes"', 'ext:log -in:dupes', 'path:dupe']) {
    const p = normalizePolicy({ name: 'x', path: dir, match: { kind: 'query', q } });
    assert.equal(p.match.kind, 'query', q);
  }
});

test('a -dupe:yes policy saved before the refusal existed previews as selecting nothing', async () => {
  const dir = policyFolder();
  // Control first: the folder is visible to a policy, so "nothing" below is
  // the evaluator's answer and not an empty fixture.
  const control = await simulatePolicy(policyAt(dir, 'ext:log'));
  assert.equal(control.items.length, 2, 'ext:log sees both logs');

  // Written straight to the store, as an earlier build would have saved it.
  const stored = policyAt(dir, '-dupe:yes');
  await writeJsonFile('autopilot.json', { version: 1, policies: [stored], runs: [] });
  try {
    const sim = await simulatePolicy((await listPolicies())[0]);
    assert.deepEqual(sim.items.map((i) => i.path), [], 'the preview selects nothing');
    assert.equal(sim.bytesMatched, 0);
    assert.equal(sim.bytesWouldDelete, 0);

    // The mandatory first run: the approval request has nothing to approve.
    const first = await runPolicy((await listPolicies())[0], { ignoreCooldown: true });
    assert.equal(first.status, 'awaiting-approval');
    assert.equal(first.bytesMatched, 0);
    assert.deepEqual(first.items, []);
  } finally {
    await savePolicies([]);
  }
});

test('an approved -dupe:yes policy deletes nothing, and nothing reaches the Trash', async () => {
  const dir = policyFolder();
  const approved = policyAt(dir, '-dupe:yes', { approvedAt: Date.now() - 86_400_000 });
  await writeJsonFile('autopilot.json', { version: 1, policies: [approved], runs: [] });
  const trashed: string[] = [];
  setTrashStepForTests(async (p) => { trashed.push(p); });
  try {
    const result = await runPolicy((await listPolicies())[0], { ignoreCooldown: true });
    assert.equal(result.bytesMatched, 0, 'nothing was matched');
    assert.deepEqual(result.items, []);
    assert.equal(result.mode, 'dry-run', 'it never went live');
    assert.equal(result.bytesDeleted, 0);
    assert.deepEqual(trashed, [], 'the Trash step was never reached');
    for (const f of ['old.log', 'new.log', path.join('keep', 'photo.jpg')]) {
      assert.ok(fs.existsSync(path.join(dir, f)), `${f} is where it was`);
    }
    const runs = (await readJsonFile<{ runs: AutopilotRun[] }>('autopilot.json', { runs: [] })).runs;
    assert.equal(runs[0]?.id, result.id, 'and the run is on record');
  } finally {
    setTrashStepForTests(null);
    await savePolicies([]);
  }
});

test('a date that was looked up but not recorded is unknown too: "-used<90d" and "-created<30d" never match it', () => {
  // `null` is "fetched, and nothing recorded it" — a noatime mount, NTFS
  // last-access tracking off, a filesystem with no birth time, a stat that
  // failed or was past the cap. AGENTS.md: a null lastUsedMs is never a zero.
  // Deciding such a term false let `-` turn it into a match, so "not opened in
  // the last 90 days" selected every file whose opening nobody records — on a
  // noatime mount, every file under an Autopilot policy's folder.
  const unrecorded: EvalFacts = { lastUsedMs: null, createdMs: null };
  for (const q of ['used<90d', 'used>90d', '-used<90d', '-used>90d', 'created<30d', '-created<30d', '-created>2025-01-01']) {
    assert.equal(evaluateMaybe(ast(q), { node: node(), facts: unrecorded, now: NOW }, HOME), 'maybe', `${q} is unknown for an unrecorded date`);
    assert.equal(evaluate(ast(q), { node: node(), facts: unrecorded, now: NOW }, HOME), false, `${q} does not match an unrecorded date`);
  }
  // A recorded date still decides, both ways, negated or not.
  const recorded: EvalFacts = { lastUsedMs: NOW - 200 * DAY, createdMs: NOW - 10 * DAY };
  assert.equal(evaluate(ast('-used<90d'), { node: node(), facts: recorded, now: NOW }, HOME), true, 'opened 200 days ago is not within 90 days');
  assert.equal(evaluate(ast('-created<30d'), { node: node(), facts: recorded, now: NOW }, HOME), false, 'created 10 days ago is within 30 days');
  // `used:never` too: an unrecorded date is not a record of "never opened".
  for (const q of ['used:never', '-used:never', 'type:file used:never', 'size>=0 -used:never']) {
    assert.equal(evaluateMaybe(ast(q), { node: node(), facts: unrecorded, now: NOW }, HOME), 'maybe', `${q} is unknown for an unrecorded date`);
  }
  assert.equal(evaluate(ast('-used:never'), { node: node(), facts: recorded, now: NOW }, HOME), true, 'a recorded date means it was opened');
  assert.equal(evaluate(ast('used:never'), { node: node(), facts: recorded, now: NOW }, HOME), false);
});

test('on a real scan, used:never matches nothing and says why', async () => {
  const out = await run('used:never');
  assert.equal(out.total, 0, `used:never matched ${out.hits.map((h) => h.name).join(', ')}`);
  assert.equal(out.degraded.find((d) => d.provider === 'usedNever')?.reason,
    'Nothing on this computer records that a file was never opened — a missing last-opened date means openings are not recorded there — so "used:never" matches no file. "-used:never" matches files that have a last-opened date, and "used>1y" finds files not opened in a year.');
  assert.equal((await run('used>1y')).degraded.find((d) => d.provider === 'usedNever'), undefined, 'only a query that uses it is told');
});

test('a policy built on used:never is refused, and its negation is not', () => {
  const dir = policyFolder();
  for (const q of ['used:never', 'ext:log used:never', 'ext:log or used:never', '-(-used:never)', '-(ext:jpg -used:never)']) {
    assert.throws(
      () => normalizePolicy({ name: 'Never opened', path: dir, match: { kind: 'query', q } }),
      (err: unknown) => {
        assert.ok(err instanceof AppError, `"${q}" threw ${String(err)}`);
        assert.equal(err.code, 'POLICY_QUERY_UNANSWERABLE', q);
        assert.match(err.message, /^The policy "Never opened" uses "used:never", which nothing on this computer can confirm/, q);
        assert.match(err.message, /"used>1y"/, `${q}: and it says what to use instead`);
        return true;
      },
      `"${q}" must be refused`,
    );
  }
  // Negated, it is decided wherever a date is recorded: "has been opened".
  for (const q of ['-used:never', 'ext:log -used:never', '-(used:never)', '-(ext:jpg or used:never)']) {
    const p = normalizePolicy({ name: 'x', path: dir, match: { kind: 'query', q } });
    assert.equal(p.match.kind === 'query' && p.match.q, q, `"${q}" is accepted`);
  }
  // Both fields at once: one refusal names both.
  assert.throws(
    () => normalizePolicy({ name: 'Both', path: dir, match: { kind: 'query', q: 'dupe:yes used:never' } }),
    (err: unknown) => err instanceof AppError && /uses "dupe:", which .* it also uses "used:never", which /.test(err.message) && /Remove "dupe:" and "used:never" from the query/.test(err.message),
  );
});

test('git and sync state a signal could not read are unknown, never "none" or "not in a sync folder"', () => {
  // The recoverability provider says so itself: a repo whose git call failed
  // has `git: null` AND an `unavailable` entry for git, and gitVerdict calls
  // that 'unknown'. Mapping it to 'none' let `git:none` ("in no pushed
  // project") and `-git:dirty` match files inside a repository nobody could
  // read — the policy shape "clear what version control does not hold".
  const base = { elsewhere: 'unknown' as const, why: [], backup: null };
  const gitFailed = { ...base, git: null, cloud: null, unavailable: [{ signal: 'git' as const, reason: 'git status timed out' }] };
  const noRepo = { ...base, git: null, cloud: null, unavailable: [] };
  assert.equal(gitStateOf(gitFailed), undefined, 'a git call that failed is unknown');
  assert.equal(gitStateOf(noRepo), 'none', 'no repository at all is still "none"');
  const cloudUnread = { ...base, git: null, cloud: null, unavailable: [{ signal: 'cloud' as const, reason: 'client state unreadable' }] };
  const cloudUnknown = { ...base, git: null, cloud: { kind: 'cloud', provider: 'icloud', state: 'unknown' }, unavailable: [] } as unknown as Parameters<typeof cloudStateOf>[0];
  const cloudResident = { ...base, git: null, cloud: { kind: 'cloud', provider: 'dropbox', state: 'unknown', resident: true }, unavailable: [] } as unknown as Parameters<typeof cloudStateOf>[0];
  assert.equal(cloudStateOf(cloudUnread), undefined, 'a sync client that could not be read is unknown');
  assert.equal(cloudStateOf(cloudUnknown), undefined, 'a sync state the client calls unknown is unknown');
  assert.equal(cloudStateOf(cloudResident), 'resident', 'on this disk, uploaded or not: a state of its own');
  assert.equal(cloudStateOf(noRepo), null, 'outside every sync folder is still "not in a sync folder"');
  // And through the evaluator: neither the term nor its opposite matches.
  for (const q of ['git:none', '-git:dirty', '-git:pushed', 'cloud:local-only', '-cloud:local-only', '-cloud:synced']) {
    const facts: EvalFacts = { git: gitStateOf(gitFailed), cloud: cloudStateOf(cloudUnknown) };
    assert.equal(evaluate(ast(q), { node: node(), facts, now: NOW }, HOME), false, `${q} does not match what could not be read`);
  }
});

test('a file on this disk in a sync folder is not a placeholder, and whether it is uploaded stays unknown', () => {
  // The resolver reads a file in a sync folder as either evicted (a
  // placeholder) or here; whether "here" is uploaded it cannot tell. So
  // cloud:placeholder is a definite no for it, and synced/local-only unknown.
  const at = (q: string) => evaluateMaybe(ast(q), { node: node(), facts: { cloud: 'resident' }, now: NOW }, HOME);
  const cases: [string, boolean | 'maybe'][] = [
    ['cloud:placeholder', false], ['-cloud:placeholder', true],
    ['cloud:local-only', 'maybe'], ['-cloud:local-only', 'maybe'], ['cloud:synced', 'maybe'], ['-cloud:synced', 'maybe'],
    ['cloud:placeholder,local-only', 'maybe'], ['cloud:synced,local-only', true], ['-cloud:synced,local-only', false],
  ];
  assert.deepEqual(cases.map(([q]) => [q, at(q)]), cases);
});

test('through the recoverability provider: resident only when the disk says so, and a resolver that fails is unknown for that file', async () => {
  const dir = fileTempDir('treemap-query-unknown-cloud-');
  fs.mkdirSync(path.join(dir, 'Dropbox'));
  const here = path.join(dir, 'Dropbox', 'resident.txt');
  const gone = path.join(dir, 'Dropbox', 'never-existed.bin');
  const unsure = path.join(dir, 'Dropbox', 'unsure.txt');
  const elsewhere = path.join(dir, 'outside.txt');
  fs.writeFileSync(here, 'on this disk\n');
  fs.writeFileSync(unsure, 'on this disk, but nothing could say so\n');
  fs.writeFileSync(elsewhere, 'in no sync folder\n');
  const signal = new AbortController().signal;

  // The placeholder reader answers null for an ordinary local file, and also
  // when it could not look (a failed lstat, a failed PowerShell call), so
  // "not a placeholder" alone is no proof the bytes are here. The file's
  // directory entry is asked, as every reader of file contents asks
  // (dataLocality.ts): 1 here, 2 for a path that is gone or an answer that
  // could not be had.
  localityStandIn((name) => (name === 'resident.txt' ? 1 : 2));
  try {
    const read = await recoverabilityProvider.compute('no-such-scan', [here, gone, unsure, elsewhere], signal);
    const fact = read.values.get(here);
    assert.ok(fact, `the file in the sync folder has a fact: ${JSON.stringify([...read.values])}`);
    assert.deepEqual([fact.cloud?.state, fact.cloud?.resident], ['unknown', true], 'read, and resident');
    assert.equal(cloudStateOf(fact), 'resident');
    for (const [label, p] of [['a path that is gone', gone], ['a file nothing could vouch for', unsure]] as const) {
      const f = read.values.get(p);
      assert.ok(f, `${label} has a fact`);
      assert.deepEqual([f.cloud?.state, f.cloud && 'resident' in f.cloud], ['unknown', false], `${label}: in a sync folder, and not claimed resident`);
      assert.equal(cloudStateOf(f), undefined, `${label} is unknown`);
    }
    const outside = read.values.get(elsewhere);
    assert.ok(outside === undefined || cloudStateOf(outside) === null, `outside every sync folder, or nothing to say at all: ${JSON.stringify(outside)}`);

    // No module that can ask: nothing is claimed resident.
    localityStandIn(null);
    const blind = await recoverabilityProvider.compute('no-such-scan', [here], signal);
    assert.equal(blind.values.get(here) && cloudStateOf(blind.values.get(here)!), undefined, 'without a way to ask, unknown');
  } finally {
    realLocality();
  }

  // The resolver throwing is not "outside every sync folder": the provider
  // names the failure for that file, and the query reads it as unknown.
  const p = platform();
  const real = p.getPlaceholderInfo;
  p.getPlaceholderInfo = async () => { throw new Error('the sync client could not be read'); };
  try {
    const failed = await recoverabilityProvider.compute('no-such-scan', [here], signal);
    const f = failed.values.get(here);
    assert.ok(f, 'a failure is reported, not skipped');
    assert.equal(f.cloud, null);
    assert.ok(f.unavailable.some((u) => u.signal === 'cloud' && /could not be read/.test(u.reason)), `the failure is named: ${JSON.stringify(f.unavailable)}`);
    assert.equal(cloudStateOf(f), undefined, 'unknown, never "not in a sync folder"');
  } finally {
    p.getPlaceholderInfo = real;
  }
});

test('on a real scan, -cloud:placeholder still finds a file on this disk in a sync folder', async () => {
  const dir = fileTempDir('treemap-query-unknown-sync-');
  fs.mkdirSync(path.join(dir, 'Dropbox'));
  fs.writeFileSync(path.join(dir, 'Dropbox', 'resident.txt'), 'on this disk\n');
  const scan = await startScan(dir);
  await waitFor(() => peekScan(scan.scanId)?.status !== 'running', 'the sync-folder scan settling');
  // The scan ran on whatever engine this machine has; the question of where
  // the file's bytes are is answered by a stand-in, so the result does not
  // depend on whether the native module was built here.
  localityStandIn(() => 1);
  try {
    const out = await executeAgainstScan(scan.scanId, ast('type:file -cloud:placeholder'), {
      limit: 100, offset: 0, sort: 'path', signal: new AbortController().signal,
    });
    assert.ok(!('error' in out), JSON.stringify(out));
    assert.deepEqual((out as QueryOutcome).hits.map((h) => h.name), ['resident.txt'], 'known not to be a placeholder');
    const local = await executeAgainstScan(scan.scanId, ast('type:file -cloud:local-only'), {
      limit: 100, offset: 0, sort: 'path', signal: new AbortController().signal,
    });
    assert.deepEqual((local as QueryOutcome).hits, [], 'but whether it is uploaded nobody could tell');
  } finally {
    realLocality();
  }
});
