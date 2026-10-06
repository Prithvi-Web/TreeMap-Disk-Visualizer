import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Layout found wrong by driving the real page (browser QA of 6 Oct 2026,
 * findings B01–B38; this file holds the layout ones that have no nearer
 * home). Everything here reads the built `public/index.html`: the stylesheet
 * is parsed and its geometry evaluated, and page functions are lifted out and
 * run against small stubs, so what is tested is what ships.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** The page function `name`, run with `deps` as its free names. */
function runPageFn<T>(name: string, deps: Record<string, unknown>): T {
  const start = INDEX.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is in the built page`);
  let depth = 0, end = -1;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > start, `${name} has a balanced body`);
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, `'use strict';\n${INDEX.slice(start, end)}\nreturn ${name};`)(...keys.map((k) => deps[k])) as T;
}

/* ══════════════ B03 — Largest Files keeps its names readable in Reclaim order ══════════════ */

type BigFile = { name: string; path: string; size: number };
type Score = { score: number; confidence: string } | null;

/** The Largest Files rows as renderBigFiles writes them, one string per row. */
function bigFileRows(sort: 'size' | 'reclaim', scoreOf: (p: string) => Score, known: (p: string) => boolean): string[] {
  const host = { innerHTML: '', querySelectorAll: () => [] as unknown[] };
  const largest: BigFile[] = [
    { name: 'holiday-4k.mov', path: '/c/Videos/holiday-4k.mov', size: 3e9 },
    { name: 'Installer.dmg', path: '/c/Archives/Installer.dmg', size: 2e9 },
    { name: 'dup-group-1.bin', path: '/c/Dupes/dup-group-1.bin', size: 1e8 },
  ];
  const render = runPageFn<() => void>('renderBigFiles', {
    $: () => host,
    state: { largest, bigFilesSort: sort },
    chipFor: () => '<span class="chip"></span>',
    escapeHtml: (s: string) => s,
    fxBarStyle: () => '', fxBarsIn() {},
    sizeInk: () => '#000', sizeColor: () => '#000',
    formatBytes: (n: number) => `${n} B`,
    icon: () => '',
    byReclaimDesc: () => () => 0,
    reclaimBadge: (_p: string, fact: Score) => (fact ? `<button type="button" class="rc-badge conf-${fact.confidence}">${fact.score}</button>` : ''),
    scoreFor: scoreOf, scoreKnown: known,
    refreshCartButtons() {}, nodeFor: () => null, confirmTrash() {}, openInOS() {}, showCtxMenu() {},
  });
  render();
  const rows = host.innerHTML.split('<div class="bigfile">').slice(1);
  assert.equal(rows.length, largest.length, 'one row per file');
  return rows;
}

/** The columns beside the name that only state a measure: the percent of the largest, or the score. */
function measureSlots(row: string): string[] {
  return [...row.matchAll(/class="(fx-li-pct|rc-badge|rc-none)\b/g)].map((m) => m[1]);
}

test('a Largest Files row holds ONE measure column — the score badge takes the percent column’s place, so the name keeps its width (B03)', () => {
  // QA: in Reclaim order the badge was ADDED to a row that already held the
  // bar, the percent, the size and the hover actions, and the name column fell
  // to 66 px — six of ten rows read "dup-gro…". The bar and the size already
  // say how big a file is; the percent of the largest is the one column that
  // can give its place to the score.
  const scored = (p: string): Score => ({ score: p.length % 90, confidence: 'high' });
  const unscored = (): Score => null;
  const cases: Array<[string, 'size' | 'reclaim', (p: string) => Score, (p: string) => boolean, string]> = [
    ['Size order, nothing scored', 'size', unscored, () => false, 'fx-li-pct'],
    ['Size order after scores arrived', 'size', scored, () => true, 'rc-badge'],
    ['Reclaim order, scores arrived', 'reclaim', scored, () => true, 'rc-badge'],
    ['Reclaim order, a file no signal could score', 'reclaim', unscored, () => true, 'rc-none'],
    ['Reclaim order, scores still loading', 'reclaim', unscored, () => false, 'fx-li-pct'],
  ];
  for (const [label, sort, scoreOf, known, want] of cases) {
    for (const row of bigFileRows(sort, scoreOf, known)) {
      assert.deepEqual(measureSlots(row), [want], `${label}: the row carries exactly one measure column (${want})`);
      assert.match(row, /class="bar-track"/, `${label}: the bar still shows the size against the largest`);
      assert.match(row, /class="size-badge num"/, `${label}: and the size is still printed`);
    }
  }
});

/* ══════════════ B01 — a search field told to grow hands its width to its input ══════════════ */

/** The built stylesheet, comments removed, as { selectors, body } rules. */
const SHEET = INDEX.slice(INDEX.indexOf('<style>') + 7, INDEX.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, ' ');
const RULES = [...SHEET.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .map((m) => ({ selectors: m[1].trim().split(',').map((s) => s.trim().replace(/\s+/g, ' ')), body: m[2] }))
  .filter((r) => r.selectors[0] && !r.selectors[0].startsWith('@'));
/** Declarations of every rule naming exactly one of `selectors`, in source order. */
function declsFor(...selectors: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of RULES) {
    if (!r.selectors.some((s) => selectors.includes(s))) continue;
    for (const d of r.body.split(';')) {
      const i = d.indexOf(':');
      if (i !== -1) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
  }
  return out;
}

test('the Offloaded and Time Capsule search boxes fill their field — the placeholder is not cut to "Search by name or origi" (B01)', () => {
  // The field is flex:1 up to 420 px inside a .rule-row, but it was a plain
  // block: its icon sat inline and the input kept its intrinsic ~172 px.
  const fields = [...INDEX.matchAll(/<div class="rule-row"[^>]*>\s*<div class="field" style="flex:1;max-width:(\d+)px;">\s*<span data-icon="search"><\/span>\s*<input type="text" id="(\w+)" placeholder="([^"]+)"/g)];
  assert.deepEqual(fields.map((m) => m[2]).sort(), ['capsuleSearch', 'offloadSearch'], 'both search rows were found');
  const field = declsFor('.rule-row > .field');
  assert.equal(field.get('display'), 'flex', 'the field lays its icon and input out in a row');
  assert.equal(field.get('min-width'), '0', 'and may shrink inside a narrow card');
  const input = declsFor('.rule-row > .field > input[type="text"]');
  assert.match(input.get('flex') || '', /^1( 1 0(%|px)?)?$/, 'the input takes every pixel the field has after the icon');
  assert.equal(input.get('min-width'), '0', 'and gives them back when the card is narrow');
  const gap = Number((/^(\d+)px$/.exec(field.get('gap') || '') || [])[1]);
  assert.ok(gap > 0, 'with a gap between the icon and the box');
  for (const [, maxW, id, placeholder] of fields) {
    // The input gets the field's width less the 16 px icon and the gap; at
    // 13 px a placeholder character is at most ~6.6 px, plus 12 px padding a side.
    const inputW = Number(maxW) - 16 - gap;
    const needed = placeholder.length * 6.6 + 24 + 2;
    assert.ok(inputW >= needed, `#${id}: a ${inputW}px box shows all of "${placeholder}" (needs ~${needed.toFixed(0)}px)`);
  }
});
