import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The treemap status line has to agree with its own numbers.
 *
 * Drilling into a folder that holds exactly one file produced
 * "1 nodes · 1 drawn · 394.0 KB total" — the count and the noun contradicting
 * each other in the most-read line on the page. Every other counted sentence
 * in this app already carries the house idiom `${n === 1 ? '' : 's'}`
 * (`035-system-info.js`, `095-lasso-select.js`, `175-cleanup-cart.js`, and the
 * `match`/`matches` branch of this very function); the no-query footer was the
 * one that never got it.
 *
 * `updateTmStatus` is extracted from the built page and RUN here (the
 * gridAnchorStale / motionWidth harness precedent) rather than pattern-matched,
 * because the invariant is about the SENTENCE A USER READS, not about which
 * ternary spelling the source happens to use. The slice is taken by brace
 * matching so that rewording the line — the exact thing this test invites —
 * cannot silently change what is under test.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** A function body, from its `function name(` anchor to its MATCHING brace. */
function braced(openAnchor: string): string {
  const start = INDEX.indexOf(openAnchor);
  assert.notEqual(start, -1, `block "${openAnchor}" exists in index.html`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`block "${openAnchor}" never closes`);
}

type Treemap = Record<string, unknown>;

/**
 * Run the real `updateTmStatus` and hand back the sentence it wrote.
 *
 * Collaborators are stubbed to the smallest things that behave like the
 * originals. `formatCount` deliberately does NOT group thousands here: the
 * assertions are about the noun beside the number, and a separator would only
 * make the expected strings harder to read.
 */
function runTmStatus(treemap: Treemap): string {
  let written = '';
  const $ = (id: string) => (id === 'tmStatus'
    ? { set textContent(v: string) { written = v; } }
    : { textContent: '' });
  const make = new Function(
    '$', 'state', 'formatCount', 'formatBytes', 'tmPreview', 'isSun', 'isCells',
    `'use strict'; ${braced('function updateTmStatus() {')}\nreturn updateTmStatus;`,
  );
  const fn = make(
    $,
    {
      treemap: {
        query: '', matches: 0, matchTotal: null, queryMode: 'bare',
        rootSize: 0, nodes: [], pxRects: [], history: { active: false },
        ...treemap,
      },
    },
    (n: number) => String(n),
    (n: number) => `${n} B`,
    { on: false },
    () => false,
    () => false,
  ) as () => void;
  assert.equal(typeof fn, 'function', 'updateTmStatus is spliced into the page');
  fn();
  return written;
}

/** `n` placeholder entries — the footer only ever reads `.length`. */
function many(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({ i }));
}

/** The footer with no query, no history, no preview: the plain count line. */
function footer(nodes: number, drawn: number, rootSize = 1): string {
  return runTmStatus({ nodes: many(nodes), pxRects: many(drawn), rootSize });
}

test('the treemap footer says "node" for one and "nodes" for none or many', () => {
  // One file in the folder is the case that shipped broken. Both halves of the
  // line are pinned, not just the noun: "1 drawn" needs no plural marker of its
  // own — its noun is elided and would agree with its own count anyway — so the
  // fix must not invent one.
  assert.equal(footer(1, 1), '1 node · 1 drawn · 1 B total',
    'a single-file folder reads "1 node", never "1 nodes"');

  // Zero takes the plural in English, and so does anything above one.
  assert.equal(footer(0, 0), '0 nodes · 0 drawn · 1 B total',
    'an empty folder reads "0 nodes"');
  assert.equal(footer(12, 9), '12 nodes · 9 drawn · 1 B total',
    'twelve entries read "12 nodes"');

  // The two counts are independent: a big folder drawn down to one visible cell
  // must not borrow the node count's plural, and vice versa.
  assert.equal(footer(7, 1), '7 nodes · 1 drawn · 1 B total',
    'the drawn count is pluralised on ITS own number, not on the node count');
  assert.equal(footer(1, 0), '1 node · 0 drawn · 1 B total',
    'the node count is pluralised on ITS own number, not on the drawn count');
});

test('no count in the treemap footer is ever followed by a plural it contradicts', () => {
  // The general invariant behind the cases above, so that a future rewording —
  // "1 item", "1 entry", "1 cell" — is held to the same rule instead of only
  // the two nouns that happen to be there today. A bare "1" may never be
  // followed by a word ending in "s" that is not itself part of the sentence's
  // fixed furniture ("total"), and any count above one may never be followed by
  // a singular noun that the one-case spelled without an "s".
  for (const n of [0, 1, 2, 5, 40]) {
    const line = footer(n, n);
    assert.ok(!/\b1 \w+s\b/.test(line),
      `a count of one is never followed by a plural noun — got "${line}"`);
    if (n !== 1) {
      assert.ok(!/\b\d+ node\b/.test(line),
        `a count of ${n} is never followed by a singular noun — got "${line}"`);
    }
  }
});

test('the query branch keeps its own already-correct match/matches agreement', () => {
  // Guard, not a discovery: this branch was written with the house idiom from
  // the start. It sits in the same function as the broken footer, so a rewrite
  // that unifies the two must not regress it.
  assert.match(runTmStatus({ query: 'openapi', matches: 1, matchTotal: null, rootSize: 5 }),
    /^1 match for “openapi”/, 'one hit is "1 match"');
  assert.match(runTmStatus({ query: 'openapi', matches: 3, matchTotal: null, rootSize: 5 }),
    /^3 matches for “openapi”/, 'three hits are "3 matches"');
});

test('the "N of M" disclosure agrees with M, the number its noun belongs to', () => {
  // The same defect one branch up, and reachable for real: the server total is
  // what the noun counts, and the sole file the grammar matched can easily sit
  // outside the folder or below the depth the map drew. That prints
  // "0 of 1 matches" — a plural hung off the number 1.
  assert.match(runTmStatus({ query: 'size>1gb', matches: 0, matchTotal: 1, rootSize: 5 }),
    /^0 of 1 match for “size>1gb”/,
    'one match, none of it drawn here, is "0 of 1 match"');

  // And the plural still has to survive for every larger total.
  assert.match(runTmStatus({ query: 'size>1gb', matches: 1, matchTotal: 2, rootSize: 5 }),
    /^1 of 2 matches for “size>1gb”/, 'two matches stay "matches"');
});
