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
import { executeAgainstScan, type QueryOutcome } from '../src/services/query/execute';
import { startScan, peekScan } from '../src/services/diskScanner';
import { normalizePolicy, savePolicies, listPolicies, simulatePolicy, runPolicy } from '../src/services/autopilot';
import { readJsonFile, writeJsonFile } from '../src/services/storage';
import { setTrashStepForTests } from '../src/services/cleaner';
import { AppError } from '../src/middleware/errorHandler';
import type { AutopilotPolicy, AutopilotRun } from '../src/models/types';
import type { Ast } from '../src/services/query/types';
import { waitFor } from './fixtures/waitFor';

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
