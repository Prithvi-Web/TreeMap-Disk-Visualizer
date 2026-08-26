import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/services/query/parse';
import {
  evaluate, evaluateMaybe, isEmptyQuery, isInsidePrefix, matchesDate,
  type EvalFacts, type EvalNode,
} from '../src/services/query/evaluate';
import type { Ast } from '../src/services/query/types';

/**
 * The query evaluator (v4 §2.2).
 *
 * Two things get disproportionate attention here, because both fail silently.
 *
 * **The date asymmetry.** `modified<2023-01-01` compares a timestamp ("before
 * that date"); `modified>90d` compares an age ("older than 90 days"). Both
 * read as "older" to a person even though the operator flips. Getting it
 * backwards returns the exact complement of what was asked — a full page of
 * confident, wrong results — so every operator is asserted in both modes.
 *
 * **Kleene logic.** The executor narrows to candidates before paying for
 * facts, which is only safe if `evaluateMaybe` never says `false` where the
 * full evaluation would say `true`. A single such case silently drops real
 * matches. The last test in this file asserts that property exhaustively over
 * a corpus rather than trusting the three-line implementation.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 15);
const HOME = '/Users/tester';

function node(over: Partial<EvalNode> = {}): EvalNode {
  return {
    name: 'holiday.mp4',
    path: '/Users/tester/Movies/holiday.mp4',
    size: 2_000_000_000,
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

const hit = (q: string, over: Partial<EvalNode> = {}, facts: EvalFacts = {}): boolean =>
  evaluate(ast(q), { node: node(over), facts, now: NOW }, HOME);

/* ============================ the basics ============================ */

test('size, ext, name, path and type', () => {
  assert.equal(hit('size>1gb'), true);
  assert.equal(hit('size>3gb'), false);
  assert.equal(hit('size<=2gb'), true);
  assert.equal(hit('size=2000000000'), true);

  assert.equal(hit('ext:mp4'), true);
  assert.equal(hit('ext:mov'), false);
  assert.equal(hit('ext:mov,mp4,mkv'), true);
  assert.equal(hit('ext:MP4'), true, 'the query is folded, and stored extensions are lower-case');
  assert.equal(hit('ext:mp4', { isDir: true, name: 'mp4' }), false, 'a folder has no extension');

  assert.equal(hit('name:holiday'), true);
  assert.equal(hit('name:HOLIDAY'), true);
  assert.equal(hit('name:Movies'), false, 'name is the basename only, not the path');
  assert.equal(hit('path:Movies'), true, 'path searches the whole path');

  assert.equal(hit('type:file'), true);
  assert.equal(hit('type:dir'), false);
  assert.equal(hit('type:dir', { isDir: true }), true);
});

test('bare words behave exactly as they always have', () => {
  assert.equal(hit('*.mp4'), true);
  assert.equal(hit('.mp4'), true);
  assert.equal(hit('holiday'), true);
  assert.equal(hit('HOLIDAY'), true);
  assert.equal(hit('*.mp4', { isDir: true, name: 'x.mp4' }), false, 'extension queries are files-only');
  assert.equal(hit('Movies'), false, 'a bare word is a NAME substring, not a path one');
});

test('depth and empty', () => {
  assert.equal(hit('depth<=3'), true);
  assert.equal(hit('depth<3'), false);
  assert.equal(hit('depth=3'), true);

  assert.equal(hit('empty:yes', { isDir: true, childCount: 0 }), true);
  assert.equal(hit('empty:yes', { isDir: true, childCount: 5 }), false);
  // A zero-byte FILE is not "an empty folder" — conflating them would put
  // files into a list whose whole contract is about directories.
  assert.equal(hit('empty:yes', { isDir: false, size: 0 }), false);
});

/* ============================ in: ============================ */

test('in: is subtree containment, anchored at a separator', () => {
  assert.equal(isInsidePrefix('/a/b/c.txt', '/a/b', HOME), true);
  assert.equal(isInsidePrefix('/a/b', '/a/b', HOME), true, 'the folder itself is inside itself');
  assert.equal(isInsidePrefix('/a/b/c.txt', '/a/b/', HOME), true, 'a trailing slash is tolerated');
  // The bug this guards: an unanchored prefix match would sweep in a sibling
  // folder whose name merely starts the same way.
  assert.equal(isInsidePrefix('/a/bc/d.txt', '/a/b', HOME), false);
  assert.equal(isInsidePrefix('/a/b-old/d.txt', '/a/b', HOME), false);
  assert.equal(isInsidePrefix('/a/b.txt', '/a/b', HOME), false);

  // `~` expands, because that is how people write the query.
  assert.equal(isInsidePrefix(`${HOME}/Downloads/x.zip`, '~/Downloads', HOME), true);
  assert.equal(isInsidePrefix('/other/Downloads/x.zip', '~/Downloads', HOME), false);

  // Case-insensitive, matching the rest of the grammar.
  assert.equal(isInsidePrefix('/A/B/c.txt', '/a/b', HOME), true);

  assert.equal(hit('in:~/Movies'), true);
  assert.equal(hit('-in:~/Movies'), false);
  assert.equal(hit('in:/nowhere'), false);
});

test('a bare folder name matches that folder wherever it appears', () => {
  // §2.1's own example is `-in:node_modules`, which has to mean "not under
  // ANY node_modules". Requiring an absolute path there would make the
  // exclusion match nothing and silently become a no-op — the query would
  // look like it was working.
  const deep = { path: '/Users/tester/p/node_modules/x/holiday.mp4' };
  assert.equal(hit('in:node_modules', deep), true);
  assert.equal(hit('-in:node_modules', deep), false);
  assert.equal(hit('in:node_modules'), false, 'a path without it does not match');

  // Still anchored at separators: a bare name is a whole path component.
  assert.equal(isInsidePrefix('/a/src/f.ts', 'src', HOME), true);
  assert.equal(isInsidePrefix('/a/src-old/f.ts', 'src', HOME), false);
  assert.equal(isInsidePrefix('/a/mysrc/f.ts', 'src', HOME), false);
  assert.equal(isInsidePrefix('/a/b/src', 'src', HOME), true, 'the folder itself counts');
  // And an absolute prefix keeps its precise meaning.
  assert.equal(isInsidePrefix('/other/node_modules/x', '/Users/me/node_modules', HOME), false);
});

/* ============================ dates ============================ */

test('absolute dates compare the timestamp, in every operator', () => {
  const cases: [string, boolean][] = [
    ['modified<2026-01-01', true],   // 400 days ago is before 1 Jan 2026
    ['modified>2026-01-01', false],
    ['modified<2024-01-01', false],
    ['modified>2024-01-01', true],
    ['modified<=2026-01-01', true],
    ['modified>=2024-01-01', true],
  ];
  for (const [q, expected] of cases) assert.equal(hit(q), expected, q);
});

test('relative dates compare the AGE, so the operator flips', () => {
  // The file is 400 days old.
  const cases: [string, boolean][] = [
    ['modified>90d', true],    // older than 90 days
    ['modified>500d', false],
    ['modified<500d', true],   // newer than 500 days
    ['modified<90d', false],
    ['modified>=400d', true],
    ['modified<=400d', true],
    ['modified>1y', true],     // 400 days > 365
    ['modified>2y', false],
    ['modified<2y', true],
    ['modified>6m', true],     // 400 days > 180
  ];
  for (const [q, expected] of cases) assert.equal(hit(q), expected, q);
});

test('the two modes genuinely disagree, which is the point', () => {
  // Same operator, same field, opposite meaning. If these ever agree, the
  // asymmetry has been "simplified" away and half of all date queries return
  // the complement of what was asked.
  const recent = { mtimeMs: NOW - 5 * DAY };
  assert.equal(hit('modified<30d', recent), true, 'age < 30 days: recent');
  assert.equal(hit('modified<2020-01-01', recent), false, 'timestamp < 2020: not recent');
});

test('matchesDate refuses a null timestamp rather than treating it as epoch', () => {
  // A null must never compare as 1 Jan 1970, which would make every
  // "older than" query match everything unknown.
  assert.equal(matchesDate(null, 'age', '>', DAY, NOW), false);
  assert.equal(matchesDate(undefined, 'age', '>', DAY, NOW), false);
  assert.equal(matchesDate(null, 'absolute', '<', NOW, NOW), false);
});

test('used: reads the fact, not the modification time', () => {
  const old = { mtimeMs: NOW - 400 * DAY };
  // Modified 400 days ago but opened yesterday: NOT stale.
  assert.equal(hit('used>1y', old, { lastUsedMs: NOW - DAY }), false);
  assert.equal(hit('used<30d', old, { lastUsedMs: NOW - DAY }), true);
  // Opened 500 days ago: stale, whatever the mtime says.
  assert.equal(hit('used>1y', old, { lastUsedMs: NOW - 500 * DAY }), true);
});

test('used:never means fetched-and-unknown, not never-asked', () => {
  // null is "we looked, this machine records nothing".
  assert.equal(hit('used:never', {}, { lastUsedMs: null }), true);
  // A real date is not "never".
  assert.equal(hit('used:never', {}, { lastUsedMs: NOW }), false);
  // undefined is "we did not ask" — claiming it was never opened would be
  // inventing a fact out of our own omission.
  assert.equal(hit('used:never', {}, {}), false);
});

/* ============================ facts ============================ */

test('the recoverability enums match what the fact layer supplies', () => {
  assert.equal(hit('elsewhere:proven', {}, { elsewhere: 'proven' }), true);
  assert.equal(hit('elsewhere:proven,likely', {}, { elsewhere: 'likely' }), true);
  assert.equal(hit('elsewhere:proven', {}, { elsewhere: 'none' }), false);
  assert.equal(hit('git:pushed', {}, { git: 'pushed' }), true);
  assert.equal(hit('git:pushed,dirty', {}, { git: 'dirty' }), true);
  assert.equal(hit('backup:unknown', {}, { backup: 'unknown' }), true);
  assert.equal(hit('cloud:synced', {}, { cloud: 'synced' }), true);
  assert.equal(hit('cloud:synced', {}, { cloud: null }), false, 'not in a sync folder is not a match');
  assert.equal(hit('score>70', {}, { score: 90 }), true);
  assert.equal(hit('score>70', {}, { score: 20 }), false);
  assert.equal(hit('dupe:yes', {}, { dupe: true }), true);
  assert.equal(hit('dupe:no', {}, { dupe: false }), true);
});

test('an unavailable fact does not match — and the executor reports it degraded', () => {
  // Half of §2.2's rule lives here; the other half is the `degraded` array.
  // Together they mean "empty list WITH a warning" rather than an empty list
  // that reads as "nothing matched".
  for (const q of ['elsewhere:proven', 'git:pushed', 'backup:yes', 'cloud:synced', 'score>70', 'dupe:yes']) {
    assert.equal(hit(q, {}, {}), false, q);
  }
});

/* ============================ structure ============================ */

test('and, or, not and grouping', () => {
  assert.equal(hit('size>1gb ext:mp4'), true);
  assert.equal(hit('size>1gb ext:mov'), false);
  assert.equal(hit('size>3gb or ext:mp4'), true);
  assert.equal(hit('size>3gb or ext:mov'), false);
  assert.equal(hit('-ext:mov'), true);
  assert.equal(hit('-ext:mp4'), false);
  assert.equal(hit('-(ext:mov or ext:mkv)'), true);
  assert.equal(hit('size>1gb (ext:mov or ext:mp4)'), true);
  assert.equal(hit('(size>3gb or size<1kb) ext:mp4'), false);
});

test('the empty query is recognised as "no filter"', () => {
  // The original parser reports the empty query as matching NOTHING, which is
  // right for a highlight overlay and wrong for a filter. The executor checks
  // this rather than making matches() behave two ways.
  assert.equal(isEmptyQuery(ast('')), true);
  assert.equal(isEmptyQuery(ast('   ')), true);
  assert.equal(isEmptyQuery(ast('size>1gb')), false);
  assert.equal(isEmptyQuery(ast('x')), false);
});

test('the §2 acceptance query selects exactly what it claims', () => {
  const q = 'size>100mb ext:mp4 used>1y -in:node_modules';
  const stale = { lastUsedMs: NOW - 500 * DAY };
  const fresh = { lastUsedMs: NOW - DAY };

  assert.equal(hit(q, {}, stale), true, 'big, mp4, unopened for years, outside node_modules');
  assert.equal(hit(q, { size: 10_000_000 }, stale), false, 'too small');
  assert.equal(hit(q, { name: 'holiday.mov' }, stale), false, 'wrong extension');
  assert.equal(hit(q, {}, fresh), false, 'opened recently');
  assert.equal(hit(q, { path: '/Users/tester/p/node_modules/x/holiday.mp4' }, stale), false, 'inside node_modules');
});

/* ============================ Kleene ============================ */

test('evaluateMaybe returns maybe exactly when a needed fact is missing', () => {
  assert.equal(evaluateMaybe(ast('size>1gb'), { node: node(), facts: {}, now: NOW }, HOME), true);
  assert.equal(evaluateMaybe(ast('size>3gb'), { node: node(), facts: {}, now: NOW }, HOME), false);
  assert.equal(evaluateMaybe(ast('git:pushed'), { node: node(), facts: {}, now: NOW }, HOME), 'maybe');
  assert.equal(evaluateMaybe(ast('git:pushed'), { node: node(), facts: { git: 'pushed' }, now: NOW }, HOME), true);

  // AND is false as soon as one side is definitely false — that is the
  // narrowing that makes a two-pass executor worth having.
  assert.equal(evaluateMaybe(ast('size>3gb git:pushed'), { node: node(), facts: {}, now: NOW }, HOME), false);
  assert.equal(evaluateMaybe(ast('size>1gb git:pushed'), { node: node(), facts: {}, now: NOW }, HOME), 'maybe');
  // OR is true as soon as one side is definitely true.
  assert.equal(evaluateMaybe(ast('size>1gb or git:pushed'), { node: node(), facts: {}, now: NOW }, HOME), true);
  assert.equal(evaluateMaybe(ast('size>3gb or git:pushed'), { node: node(), facts: {}, now: NOW }, HOME), 'maybe');
  // NOT leaves maybe alone.
  assert.equal(evaluateMaybe(ast('-git:pushed'), { node: node(), facts: {}, now: NOW }, HOME), 'maybe');
  assert.equal(evaluateMaybe(ast('-size>3gb'), { node: node(), facts: {}, now: NOW }, HOME), true);
});

test('evaluateMaybe NEVER says false where the full evaluation says true', () => {
  // The soundness property the two-pass executor rests on. A single violation
  // silently drops real matches: pass one discards the node, pass two never
  // sees it, and the user gets a short list with no indication anything is
  // missing.
  const queries = [
    'size>1gb', 'git:pushed', 'used>1y', 'used:never', 'backup:yes', 'score>70', 'dupe:yes',
    'size>1gb git:pushed', 'size>1gb or git:pushed', '-git:pushed', '-(git:pushed or backup:yes)',
    'size>1gb used>1y -in:node_modules', 'ext:mp4 (git:dirty or backup:no)',
    '-used:never', 'type:file -git:pushed', '(used>1y or size>3gb) -dupe:yes',
    'elsewhere:proven cloud:synced', '-(size>3gb git:pushed)', 'depth<=3 score>70',
  ];
  const factSets: EvalFacts[] = [
    {},
    { lastUsedMs: NOW - 500 * DAY },
    { lastUsedMs: NOW - DAY },
    { lastUsedMs: null },
    { git: 'pushed' }, { git: 'dirty' }, { git: 'none' },
    { backup: 'yes' }, { backup: 'no' }, { backup: 'unknown' },
    { cloud: 'synced' }, { cloud: null },
    { score: 90 }, { score: 10 },
    { dupe: true }, { dupe: false },
    { elsewhere: 'proven' }, { elsewhere: 'none' },
    { lastUsedMs: NOW - 500 * DAY, git: 'pushed', backup: 'yes', cloud: 'synced', score: 90, dupe: true, elsewhere: 'proven' },
  ];
  const nodes = [
    node(), node({ size: 10 }), node({ isDir: true, childCount: 0 }),
    node({ name: 'clip.mov', depth: 1 }),
    node({ path: '/Users/tester/node_modules/x/holiday.mp4' }),
  ];

  let checked = 0;
  for (const q of queries) {
    const parsed = ast(q);
    for (const n of nodes) {
      for (const facts of factSets) {
        checked++;
        const full = evaluate(parsed, { node: n, facts, now: NOW }, HOME);
        // Pass one runs with NO facts at all — that is the real condition.
        const narrowed = evaluateMaybe(parsed, { node: n, facts: {}, now: NOW }, HOME);
        if (full === true) {
          assert.notEqual(
            narrowed, false,
            `"${q}" on ${n.name}: pass one discarded a node that pass two would have matched`,
          );
        }
        // And a definite verdict from pass one must be honoured by pass two
        // when the facts it used are the same (no facts).
        const sameFacts = evaluate(parsed, { node: n, facts: {}, now: NOW }, HOME);
        if (narrowed !== 'maybe') assert.equal(narrowed, sameFacts, `"${q}" on ${n.name}: definite verdict disagreed`);
      }
    }
  }
  assert.ok(checked >= 1500, `expected a broad sweep, ran ${checked}`);
});

/* ============================ regressions from review ============================ */

test('an unknown child count answers neither empty:yes NOR empty:no', () => {
  // A directory nobody managed to list (permission denied, excluded, pruned)
  // has an unknown count, and `store.childCount` returns 0 for it just as it
  // does for a genuinely empty one.
  //
  // Reporting it as empty would offer a permission-denied folder up for bulk
  // deletion. Reporting it as non-empty was the bug actually present: it
  // asserted "this folder has contents" about a folder nobody could read.
  const unknown = { isDir: true, childCount: undefined };
  assert.equal(hit('empty:yes', unknown), false, 'we do not know it is empty');
  assert.equal(hit('empty:no', unknown), false, 'and we do not know it is not');

  const known = { isDir: true, childCount: 0 };
  assert.equal(hit('empty:yes', known), true);
  assert.equal(hit('empty:no', known), false);
});

test('empty: with an unknown count is MAYBE in pass one, not a definite no', () => {
  // Without this, pass one discards a directory whose count is unknown and
  // pass two never sees it — the two-pass executor silently loses rows. It is
  // latent against a scan (which supplies counts) and live for any consumer
  // that does not, which is exactly what the index path would be.
  const ctx = { node: node({ isDir: true, childCount: undefined }), facts: {}, now: NOW };
  assert.equal(evaluateMaybe(ast('empty:yes'), ctx, HOME), 'maybe');
  assert.equal(evaluateMaybe(ast('empty:no'), ctx, HOME), 'maybe');
  // A known count decides normally, and a file is decidable without one.
  assert.equal(evaluateMaybe(ast('empty:yes'), { node: node({ isDir: true, childCount: 0 }), facts: {}, now: NOW }, HOME), true);
  assert.equal(evaluateMaybe(ast('empty:yes'), { node: node({ isDir: false }), facts: {}, now: NOW }, HOME), false);
});

test('created: is MAYBE until it has been stat\'d, so pass one keeps the node', () => {
  // No scan records a creation time, so `created:` costs a stat. Deciding it
  // false in pass one — before any stat — discarded every candidate before it
  // could be measured, and the endpoint answered total: 0.
  const ctx = { node: node(), facts: {}, now: NOW };
  assert.equal(evaluateMaybe(ast('created<2y'), ctx, HOME), 'maybe');
  assert.equal(
    evaluateMaybe(ast('created<2y'), { node: node(), facts: { createdMs: NOW - 100 * DAY }, now: NOW }, HOME),
    true,
  );
  // A stat that failed or was capped yields null — fetched and unknown — which
  // is a definite non-match, and the executor reports the count in `degraded`.
  assert.equal(evaluateMaybe(ast('created<2y'), { node: node(), facts: { createdMs: null }, now: NOW }, HOME), false);
});
