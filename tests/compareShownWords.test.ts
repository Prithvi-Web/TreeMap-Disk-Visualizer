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
vm.runInContext(`${grab('function deltaRow(en, maxD, opts = {})')}\n${grab('function renderCompare(r)').replace('function renderCompare', 'globalThis.renderCompare = function')}`, ctx);

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
  assert.match(html.replace(/\s+/g, ' '), /2 folders one of these scans could not list in full \(refused, unreadable or not entered\), so what only one scan listed in them is not compared — not called removed or added\./, html);
  html = '';
  (ctx.renderCompare as (r: unknown) => void)({ entries, totalDelta: 4, truncated: false, unlistedFolders: 0, deep: true, whenA: 1, whenB: 2, rules: null });
  assert.doesNotMatch(html, /could not list in full/, 'nothing said when every folder was listed');
});

test('a list it draws whole says nothing of a cut', () => {
  const { rows, line } = cardFor(150, false);
  assert.equal(rows, 150);
  assert.doesNotMatch(line, /biggest|listed/, line);
});
