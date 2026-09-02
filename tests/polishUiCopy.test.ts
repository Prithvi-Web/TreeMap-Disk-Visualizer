import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Polish round — the words (copy-5, copy-6, copy-8, first-run-7).
 *
 * One date dialect everywhere; no hashes, block counts or process ids in
 * anything a person reads; one spelling; "folder", never "directory"; and a
 * welcome paragraph that explains the product rather than comparing it to
 * another one.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

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

function slice(a: string, b: string): string {
  const i = INDEX.indexOf(a);
  assert.notEqual(i, -1, `anchor "${a}" exists`);
  const j = INDEX.indexOf(b, i + a.length);
  assert.notEqual(j, -1, `anchor "${b}" follows`);
  return INDEX.slice(i, j);
}

/* ══════════════ copy-5 — one date dialect ══════════════ */

test('dates come from one formatter: no bare toLocaleString() on a Date anywhere in the page', () => {
  const bare = INDEX.match(/new Date\([^()]*\)\.toLocaleString\(\)/g) || [];
  assert.deepEqual(bare, [], 'a bare toLocaleString() prints "9/1/2026, 10:31:45 PM" — a different dialect with seconds');
  const inline = INDEX.match(/toLocaleString\(\[\], \{ month: 'short'/g) || [];
  assert.deepEqual(inline, [], 'the three inline copies of the short format moved into formatWhen');
  const fn = braced('function formatWhen(');
  const src = slice('const WHEN_FMT = new Intl.DateTimeFormat(', 'function cssVar(');
  assert.match(src, /month: ?'short', day: ?'numeric', hour: ?'2-digit', minute: ?'2-digit'/, 'the slider\'s dialect is the one dialect');
  const formatWhen = new Function(`'use strict'; ${src} return formatWhen;`)() as (ms: number) => string;
  assert.equal(formatWhen(0), '–', 'no timestamp, no date');
  const s = formatWhen(Date.UTC(2026, 8, 1, 22, 31, 45));
  assert.doesNotMatch(s, /:\d\d:\d\d/, 'no seconds');
  assert.doesNotMatch(s, /2026/, 'no year — the same string the time slider prints');
  assert.equal(formatWhen(Date.UTC(2026, 8, 1, 22, 31, 45)), s, 'memoised: the same input is the same string');
  // Every compare-view surface goes through it.
  const compare = slice('/* ───────────────────────────── Compare view', '/* ───────────────────────────── Browse modal');
  assert.ok((compare.match(/formatWhen\(/g) || []).length >= 4, 'option labels, the split footer, the slider valuetext and the result heading');
  assert.match(braced('function updateTimeLabel('), /formatWhen\(/, 'the time slider label');
  assert.match(fn, /WHEN_FMT\.format/, 'formatWhen is the memo over the one formatter');
});

/* ══════════════ copy-6 — no hashes, block counts or pids in what a person reads ══════════════ */

test('duplicate group headers say "identical copies", and keep the fingerprint behind a title', () => {
  const render = slice('body.innerHTML = \'<div class="dup-list">\'', '</div>\' +');
  assert.doesNotMatch(render, />[^<]*sha-256/, 'no "sha-256 3fa9c1b2…" in the visible line');
  assert.match(render, /identical copies/, 'the fact, in words');
  assert.match(render, /title="Content fingerprint/, 'the hash is still there for the curious — as a title');
});

test('the compare viewer states similarity in percent, never "N of 64 blocks differ"', () => {
  assert.doesNotMatch(INDEX, /of 64 blocks differ/, 'the block count is an implementation detail');
  const fn = braced('function dupeSimilarity(');
  const sim = new Function(`'use strict'; ${fn} return dupeSimilarity;`)() as (d: number) => string;
  assert.equal(sim(0), 'looks identical');
  assert.match(sim(7), /^89% similar/, '7 of 64 blocks differing is 89% similar');
  assert.match(sim(32), /^50% similar/);
  assert.match(braced('function renderDupeViewer('), /dupeSimilarity\(f\.visualDiff\.hammingDistance\)/, 'and the pane uses it');
});

test('held-up space rows name the program, and keep the process id in the title only', () => {
  const rows = braced('function renderZombies(');
  assert.doesNotMatch(rows, /<span class="pid num">pid \$\{/, 'no "pid 4123" beside Google Chrome');
  assert.match(rows, /title="[^"]*[Pp]rocess \$\{p\.pid\}/, 'the id survives as a title on the row for anyone who needs it');
});

/* ══════════════ copy-8 — one spelling, one word for folder ══════════════ */

test('the app speaks one dialect: color, center, folder', () => {
  // Attribute text a person hears or reads: aria-labels, titles, and the seg labels.
  const attrs = [...INDEX.matchAll(/(?:aria-label|title|placeholder)="([^"]*)"/g)].map((m) => m[1]);
  const british = attrs.filter((a) => /\b(colour|centre|recentre)\b/i.test(a));
  assert.deepEqual(british, [], 'no British spellings in labels or titles');
  const directory = attrs.filter((a) => /\bdirector(y|ies)\b/i.test(a));
  assert.deepEqual(directory, [], 'the app says folder');
  assert.doesNotMatch(INDEX, /<b>Colour<\/b>/, 'the Disk City legend');
  assert.doesNotMatch(INDEX, />Recentre</, 'the Disk City toolbar');
  assert.doesNotMatch(INDEX, /Open Terminal Here/, 'Title Case in a sentence-case menu');
  assert.match(INDEX, /Open in Terminal/, 'parallel to "Open in Finder"');
  // The one visible body-text exception a search would find is a tooltip on the
  // cells renderer note; body text is checked here on the markup, minus comments.
  const markup = INDEX.slice(INDEX.indexOf('<body'), INDEX.indexOf('<script')).replace(/<!--[\s\S]*?-->/g, '');
  const text = markup.replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(text, /\b(colour|centre|directory)\b/i, 'nor in the static body text');
});

/* ══════════════ first-run-7 — the welcome explains, it does not compare ══════════════ */

test('the welcome paragraph describes the map in plain words and drops the benchmark pill', () => {
  const empty = slice('<section id="emptyState">', '</section>');
  assert.doesNotMatch(empty, /GrandPerspective/, 'no comparison to a product most users have not met');
  assert.doesNotMatch(empty, /2M\+ items|items \/ min/, 'no throughput figure nobody can evaluate');
  assert.match(empty, /the bigger the rectangle, the more space it takes/, 'the same sentence the tour card uses');
  assert.match(empty, /Trash/, 'the safety promise survives');
  assert.match(empty, /whole drive in minutes/i, 'speed stated as an outcome');
});
