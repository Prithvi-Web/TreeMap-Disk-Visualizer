import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * Compare says how many differences it lists (hunt C48). The server returns at most the biggest 1,000
 * differences (`truncated` past that), and the card drew 200 of them: past 1,000 it said "biggest
 * 1,000 shown" over 200 rows, and with 201 to 1,000 it drew 200 and said nothing of the rest. The
 * added/removed/grew/shrank counts, taken over what the server returned, read as totals beside it.
 * Now the card says it lists the biggest 200 of N differences (of more than 1,000 when the server cut
 * the list), and counts taken over a cut list say they are of the biggest 1,000.
 *
 * The page is read as built (public/index.html); `renderCompare` and `deltaRow` run with stand-ins for
 * the page helpers they call.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** The source of the function declared at `signature`, by brace matching. */
function grab(signature: string): string {
  const start = INDEX.indexOf(signature);
  assert.notEqual(start, -1, `not found: ${signature}`);
  let depth = 0;
  for (let k = INDEX.indexOf('{', INDEX.indexOf(')', start)); k < INDEX.length; k++) {
    if (INDEX[k] === '{') depth++;
    else if (INDEX[k] === '}' && --depth === 0) return INDEX.slice(start, k + 1);
  }
  throw new Error(`unbalanced: ${signature}`);
}

let html = '';
const body = { set innerHTML(v: string) { html = v; }, get innerHTML() { return html; }, querySelector: () => null, querySelectorAll: () => [] };
const ctx: Record<string, unknown> = {
  $: () => body, icon: () => '', cmpWhenPair: () => ['then', 'now'], coverageExplains: () => null,
  formatBytes: (n: number) => `${n} B`, escapeHtml: (s: unknown) => String(s), chipFor: () => '',
  countUp() {}, fxBarsIn() {}, wireSnapshotActions() {}, initCmpSplit() {}, formatCount: (n: number) => n.toLocaleString('en-US'),
  FxCharts: { barSquares: () => ({ destroy() {} }) }, cmpCountsDrop() {}, cmpSplit: null, cmpCountsHandle: null,
};
vm.createContext(ctx);
vm.runInContext(`${grab('function snapshotNotComparedHtml(n)')}\n${grab('function deltaRow(en, maxD, opts = {})')}\n${grab('function renderCompare(r)').replace('function renderCompare', 'globalThis.renderCompare = function')}`, ctx);

/** The card for `n` added files, as the server would return them; answers the rows drawn and the line above them. */
function cardFor(n: number, truncated: boolean): { rows: number; line: string } {
  const entries = Array.from({ length: n }, (_, i) => ({ path: `/r/f${i}`, name: `f${i}`, type: 'file', sizeA: null, sizeB: 5000 - i, delta: 5000 - i, change: 'added' }));
  html = '';
  (ctx.renderCompare as (r: unknown) => void)({ entries, totalDelta: 12345, truncated, deep: true, whenA: 1, whenB: 2, rules: null });
  const line = ((html.match(/<div class="muted num"[^>]*>([\s\S]*?)<\/div>/) ?? [])[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  return { rows: (html.match(/class="delta-row"/g) ?? []).length, line };
}

test('with more differences than it draws, the card says it lists the biggest 200 of how many', () => {
  const { rows, line } = cardFor(640, false);
  assert.equal(rows, 200);
  assert.match(line, /the biggest 200 of 640 differences are listed/, line);
});

test('past the server\'s 1,000 it says "of more than 1,000", never "biggest 1,000 shown" over 200 rows, and its counts say what they count', () => {
  const { rows, line } = cardFor(1000, true);
  assert.equal(rows, 200);
  assert.doesNotMatch(line, /biggest 1,000 shown/, line);
  assert.match(line, /the biggest 200 of more than 1,000 differences are listed/, line);
  assert.match(line, /among the biggest 1,000 differences: 1000 added/, line);
});

test('a folder one of the scans could not list in full is said, and what is in it is not called removed (hunt C47)', () => {
  const entries = [{ path: '/r/other.txt', name: 'other.txt', type: 'file', sizeA: 1, sizeB: 5, delta: 4, change: 'grew' }];
  html = '';
  (ctx.renderCompare as (r: unknown) => void)({ entries, totalDelta: 4, truncated: false, unlistedFolders: 2, deep: true, whenA: 1, whenB: 2, rules: null });
  assert.match(html.replace(/\s+/g, ' '), /2 folders one of these scans could not list in full \(refused, unreadable, not entered, or holding an entry it could not look at\), so what only one scan listed in them is not compared — not called removed or added\./, html);
  html = '';
  (ctx.renderCompare as (r: unknown) => void)({ entries, totalDelta: 4, truncated: false, unlistedFolders: 0, deep: true, whenA: 1, whenB: 2, rules: null });
  assert.doesNotMatch(html, /could not list in full/, 'nothing said when every folder was listed');
});

test('a folder a "Don\'t scan" rule left entries out of under rules not the same for both scans is said, apart from the unlisted ones, and the card never says nothing changed (leftover HE-L6)', () => {
  html = '';
  (ctx.renderCompare as (r: unknown) => void)({ entries: [], totalDelta: -9000, truncated: false, unlistedFolders: 0, ruleFolders: 1, deep: true, whenA: 1, whenB: 2, rules: null });
  const one = html.replace(/\s+/g, ' ');
  assert.match(one, /1 folder a “Don’t scan” rule left entries out of, under rules that are not the same for both scans, so what only one scan listed in it is not compared — not called removed or added\./, one);
  assert.doesNotMatch(one, /could not list in full/, 'no scan failed to list it');
  assert.doesNotMatch(one, /nothing changed/, one);
  assert.match(one, /No differences in what both scans list\./, one);
  html = '';
  (ctx.renderCompare as (r: unknown) => void)({ entries: [], totalDelta: 0, truncated: false, ruleFolders: 3, deep: true, whenA: 1, whenB: 2, rules: null });
  assert.match(html, /3 folders a “Don’t scan” rule left entries out of, under rules that are not the same for both scans, so what only one scan listed in them is not compared/, html);
  // The scan pair's answer carries the count to the card.
  assert.match(INDEX, /const diff = await api\(`\/api\/compare\?scanIdA=\$\{a\.id\}&scanIdB=\$\{b\.id\}`\);[\s\S]{0,300}renderCompare\(\{[^}]*ruleFolders: diff\.ruleFolders \|\| 0/, 'the /api/compare answer\'s ruleFolders reaches renderCompare');
});

test('two History records: the card says how many top-level items it could not compare (hunt C46)', () => {
  html = '';
  (ctx.renderCompare as (r: unknown) => void)({ entries: [], totalDelta: 0, truncated: false, notCompared: 1, deep: false, whenA: 1, whenB: 2, rules: null });
  assert.match(html, /1 top-level item is in only one of these scans’ lists of the largest 100, so it is not compared\./, html);
});

test('with nothing listed beside items or folders it could not compare, the card never says nothing changed (review F1.1)', () => {
  const said = (r: Record<string, unknown>): string => {
    html = '';
    (ctx.renderCompare as (r: unknown) => void)({ entries: [], truncated: false, deep: false, whenA: 1, whenB: 2, rules: null, ...r });
    return html.replace(/\s+/g, ' ');
  };
  // A new 4 GB download in a folder of more than 100 items: neither list can vouch for the other's item.
  const cut = said({ totalDelta: 10_000_000_000, notCompared: 2 });
  assert.doesNotMatch(cut, /nothing changed/, cut);
  assert.match(cut, /No differences in what both scans list\./, cut);
  // ~/Library/Mail refused in one scan: the total shrank by what it held there.
  const unlisted = said({ totalDelta: -12_000, unlistedFolders: 1 });
  assert.doesNotMatch(unlisted, /nothing changed/, unlisted);
  assert.match(unlisted, /No differences in what both scans list\./, unlisted);
  // Everything compared and nothing differs: that is said as ever.
  const same = said({ totalDelta: 0 });
  assert.match(same, /No differences — nothing changed between these two\./, same);
  assert.doesNotMatch(same, /in what both scans list/, same);
});

test('a row known only to have changed by at least its amount says so, is counted apart, and offers no snapshot hunt (review F1.4)', () => {
  const entries = [
    { path: '/r/huge.iso', name: 'huge.iso', type: 'file', sizeA: null, sizeB: 10_000_000_000, delta: 9_999_998_099, atLeast: true },
    { path: '/r/old.iso', name: 'old.iso', type: 'file', sizeA: 4_000_000_000, sizeB: null, delta: -3_999_998_099, atLeast: true },
    { path: '/r/gone.txt', name: 'gone.txt', type: 'file', sizeA: 500, sizeB: null, delta: -500 },
  ];
  html = '';
  (ctx.renderCompare as (r: unknown) => void)({ entries, totalDelta: 6_000_000_000, truncated: false, notCompared: 1, deep: false, whenA: 1, whenB: 2, rules: null });
  const flat = html.replace(/\s+/g, ' ');
  assert.match(flat, /huge\.iso <span class="muted">· new, or grew by at least<\/span>/, flat);
  assert.match(flat, /old\.iso <span class="muted">· removed, or shrank by at least<\/span>/, flat);
  assert.match(flat, /0<\/span> added · <span class="cmp-ct" data-n="1">1<\/span> removed/, 'only the row known to be gone is counted removed');
  assert.match(flat, /· 2 in only one scan’s list of the largest 100, each changed by at least what is shown/, flat);
  assert.equal((html.match(/data-snap-check=/g) ?? []).length, 1, 'only the row known to be gone offers Check snapshots');
});

test('a list it draws whole says nothing of a cut', () => {
  const { rows, line } = cardFor(150, false);
  assert.equal(rows, 150);
  assert.doesNotMatch(line, /biggest|listed/, line);
});
