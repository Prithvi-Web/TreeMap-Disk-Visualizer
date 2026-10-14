import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { selectAll, type SelectorNode } from './fixtures/fakeSelector';

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

/* ══════════════ B13 — emptying the cart hands focus back, never to <body> ══════════════ */

/**
 * Several page declarations (functions, or `const x = …;` / `let x = …;`) in one scope, run
 * with `deps` — and `extra`, a stretch of the page's own top-level code (its
 * listener wiring), run after them in the same scope.
 */
function runPageDecls<T>(names: string[], deps: Record<string, unknown>, returns: string, extra = ''): T {
  const parts = names.map((name) => {
    let start = INDEX.indexOf(`function ${name}(`);
    if (INDEX.lastIndexOf('async ', start) === start - 6) start -= 6;
    if (start < 0) {
      const at = [`const ${name} = `, `let ${name} = `].map((d) => INDEX.indexOf(d)).find((i) => i !== -1) ?? -1;
      assert.notEqual(at, -1, `${name} is in the built page`);
      return INDEX.slice(at, INDEX.indexOf(';', at) + 1);
    }
    // The body opens after the parameter list closes: a destructured
    // parameter ({ focus = false } = {}) has braces of its own.
    let paren = 0, open = -1;
    for (let i = INDEX.indexOf('(', start); i < INDEX.length; i++) {
      if (INDEX[i] === '(') paren++;
      else if (INDEX[i] === ')' && --paren === 0) { open = INDEX.indexOf('{', i); break; }
    }
    let depth = 0;
    for (let i = open; i < INDEX.length; i++) {
      if (INDEX[i] === '{') depth++;
      else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
    }
    return assert.fail(`${name} has a balanced body`);
  });
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, `'use strict';\n${parts.join('\n')}\n${extra}\nreturn ${returns};`)(...keys.map((k) => deps[k])) as T;
}

/** The page's own text from `from` up to (not including) `to`, where `from` is unique. */
function pageBetween(from: string, to: string): string {
  const at = INDEX.indexOf(from);
  assert.notEqual(at, -1, `"${from}" is in the built page`);
  assert.equal(INDEX.indexOf(from, at + 1), -1, `"${from}" is there once`);
  const end = INDEX.indexOf(to, at);
  assert.notEqual(end, -1, `"${to}" follows it`);
  return INDEX.slice(at, end);
}

type CartEl = {
  id: string; tagName: string; attrs: Record<string, string>; cls: Set<string>; parent: CartEl | null; children: CartEl[];
  connected: boolean; disabled?: boolean; innerHTML?: string;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean; toggle(c: string, on?: boolean): void };
  contains(n: unknown): boolean; focus(opts?: unknown): void; getClientRects(): unknown[]; readonly isConnected: boolean;
  listeners: Record<string, Array<(e: unknown) => void>>; addEventListener(type: string, fn: (e: unknown) => void): void;
};

/** Deliver an event to what the page registered on `el` — nothing reaches a listener the page did not add. */
function fire(el: CartEl, type: string, e: unknown = {}) {
  for (const fn of el.listeners[type] || []) fn(e);
}

/**
 * The cart's own listener wiring, as the page runs it at load: every
 * `$('…').addEventListener(…)` statement between cartFocusReturn and the
 * document-wide click delegate. Lifted as a block, not line by line, so a
 * registration that goes missing is a listener that never fires here.
 */
function cartWiring(): string {
  const fr = INDEX.indexOf('function cartFocusReturn(');
  assert.notEqual(fr, -1, 'cartFocusReturn is in the built page');
  let depth = 0, end = -1;
  for (let i = INDEX.indexOf('{', fr); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const stop = INDEX.indexOf("document.addEventListener('click', (e) => {", end);
  assert.ok(end > fr && stop > end, 'the wiring sits between cartFocusReturn and the click delegate');
  const block = INDEX.slice(end, stop);
  for (const line of block.split('\n').map((l) => l.trim()).filter(Boolean)) {
    assert.match(line, /^\$\('\w+'\)\.addEventListener\(/, `only listener registrations are lifted: ${line}`);
  }
  return block;
}

/** Lets the page's awaited repaint run out (microtasks only — nothing is timed). */
async function settled() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

/**
 * The cart dock and a view beside it: what focus can land on, and whether it
 * is painted. Laid out as the page has them — the dock a child of <body>,
 * outside every view — with each element's tag and attributes, and the
 * page's selectors answered over that tree (B13 review F3.2).
 */
function cartWorld() {
  const focus: { active: CartEl | null } = { active: null };
  const make = (id: string, parent: CartEl | null, tagName = 'button', attrs: Record<string, string> = {}): CartEl => {
    const el: CartEl = {
      id, tagName, attrs, cls: new Set(), parent, children: [], connected: true,
      classList: {
        add: (c) => { el.cls.add(c); }, remove: (c) => { el.cls.delete(c); }, contains: (c) => el.cls.has(c),
        toggle: (c, on) => { if (on ?? !el.cls.has(c)) el.cls.add(c); else el.cls.delete(c); },
      },
      contains: (n) => { for (let p = n as CartEl | null; p; p = p.parent) if (p === el) return true; return false; },
      // focus() on something not painted does nothing, as in a browser.
      focus: () => { if (el.getClientRects().length) focus.active = el; },
      // The dock is display:none without .show; the panel without .open.
      getClientRects: () => {
        for (let p: CartEl | null = el; p; p = p.parent) {
          if (p.id === 'cartDock' && !p.cls.has('show')) return [];
          if (p.id === 'cartPanel' && !p.parent!.cls.has('open')) return [];
        }
        return el.connected ? [{}] : [];
      },
      get isConnected() { return el.connected; },
      listeners: {},
      addEventListener: (type, fn) => { (el.listeners[type] ||= []).push(fn); },
    };
    if (parent) parent.children.push(el);
    return el;
  };
  const body = make('body', null, 'body');
  const view = make('view-treemap', body, 'section');
  view.cls.add('view'); view.cls.add('active');
  const toolbar = make('', view, 'div');
  const up = make('tmUpBtn', toolbar);
  up.disabled = true; // at the scan root there is nowhere up to go
  const els: Record<string, CartEl> = { tmUpBtn: up };
  els.viewFirst = make('tmSearch', toolbar, 'input', { type: 'text' });
  els.opener = make('addToCartBtn', view);
  const dock = make('cartDock', body, 'div');
  els.cartDock = dock;
  els.cartPanel = make('cartPanel', dock, 'div');
  els.cartClear = make('cartClear', els.cartPanel);
  els.cartCollapse = make('cartCollapse', els.cartPanel);
  els.cartTrash = make('cartTrash', els.cartPanel);
  els.cartList = make('cartList', els.cartPanel, 'div');
  els.cartTab = make('cartTab', dock, 'div', { role: 'button', tabindex: '0' });
  // The tab's total, whose title names the items this scan cannot size (B06): a counter's target,
  // detached, so no focus question ever reaches it.
  els.cartTabTotal = make('cartTabTotal', null, 'span');
  const state = { cart: new Set(['/c/a', '/c/b']) };
  const document = {
    body,
    get activeElement() { return focus.active ?? body; },
    querySelectorAll: (sel: string) => selectAll(body, sel),
  };
  // The page's own renderCart — its ORDER is the fix: the dock loses .show
  // before the drawer closes, so cartFocusReturn sees an emptied cart (B13
  // review F1.4). Only its counters, the goal bar and the FX are stubbed.
  const fns = runPageDecls<{
    cartClear(): void; cartDockToggle(open?: boolean, o?: { focus?: boolean }): void;
  }>(['cartFocus', 'cartNoteFocusIn', 'activeViewControl', 'cartFocusReturn', 'cartDockToggle', 'cartClear', 'renderCart'], {
    $: (id: string) => els[id], document, state,
    requestAnimationFrame: (f: () => void) => { f(); return 1; },
    CART_PAGE: 200, cartShown: 200,
    saveCart() {}, refreshCartButtons() {}, cartPreviewInvalidated() {}, cartTrashAll() {},
    ensureNodes: async () => {}, fxCartPulseSync() {}, countUp() {}, FxNum: { rollText() {}, rollHtml() {} },
    renderCartGoal() {}, cartTotalBytes: () => 0, cartNode: () => null,
    // The count of staged items this scan cannot size (B06), a counter like the total beside it.
    cartUnknownCount: () => 0,
    escapeHtml: String, icon: () => '', formatBytes: String, formatCount: String,
  }, '{ cartClear, cartDockToggle }', cartWiring());
  dock.classList.add('show');
  fns.cartDockToggle(true);
  return { els, focus, state, fns, body };
}

test('Clear in the cart hands focus back to where it came from, never to <body> (B13)', async () => {
  // QA: Clear emptied the cart, the panel and the pill disappeared, and focus
  // landed on <body>. The tab the drawer normally returns to is hidden with it.
  // Everything goes through what the page registered (B13 review F1.4, F1.5):
  // focusin on the dock, the click on Clear, and the real renderCart behind it.
  const w = cartWorld();
  fire(w.els.cartDock, 'focusin', { relatedTarget: w.els.opener }); // tabbed into the dock from the view
  fire(w.els.cartDock, 'focusin', { relatedTarget: w.els.cartTab }); // then moved around inside it
  w.els.cartClear.focus();
  assert.equal(w.focus.active, w.els.cartClear, 'focus is on Clear');
  fire(w.els.cartClear, 'click'); await settled();
  assert.equal(w.state.cart.size, 0, 'the cart is empty');
  assert.ok(!w.els.cartDock.cls.has('show'), 'and the dock is hidden, tab and all');
  assert.equal(w.focus.active, w.els.opener, 'focus is back on the control it came from');
});

test('with the control it came from gone, an emptied cart hands focus to the view on screen (B13, B13 review F3.2)', async () => {
  const w = cartWorld();
  fire(w.els.cartDock, 'focusin', { relatedTarget: w.els.opener });
  w.els.cartClear.focus();
  w.els.opener.connected = false; // the row it came from was re-rendered away
  fire(w.els.cartClear, 'click'); await settled();
  assert.equal(w.focus.active, w.els.viewFirst, 'the first enabled control of the view on screen — the search box, as Up is disabled at the root');
});

test('collapsing a cart that still holds items returns focus to its tab, and a Clear made from outside moves no focus (B13)', async () => {
  const w = cartWorld();
  fire(w.els.cartDock, 'focusin', { relatedTarget: w.els.opener });
  w.els.cartCollapse.focus();
  fire(w.els.cartCollapse, 'click');
  assert.equal(w.focus.active, w.els.cartTab, 'the tab is the way back in while the cart has items');
  const v = cartWorld();
  v.els.opener.focus();
  v.fns.cartClear(); await settled();
  assert.equal(v.focus.active, v.els.opener, 'focus that was never in the dock stays put');
});

/* ══════════════ B35 — a whole year of the calendar fits the card ══════════════ */

/** A CSS length expression in px: px, cqw (of `cqw100` px), calc/clamp/min/max and + - * /. */
function cssPx(expr: string, cqw100: number): number {
  const e = expr.trim()
    .replace(/(-?\d*\.?\d+)cqw/g, (_m, n: string) => String((Number(n) / 100) * cqw100))
    .replace(/(-?\d*\.?\d+)px/g, '$1')
    .replace(/\bcalc\(/g, '(').replace(/\bclamp\(/g, '__clamp(').replace(/\bmin\(/g, 'Math.min(').replace(/\bmax\(/g, 'Math.max(');
  assert.match(e.replace(/__clamp|Math\.(min|max)/g, ''), /^[\s\d.+\-*/(),]*$/, `"${expr}" is plain arithmetic once resolved`);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return Function('__clamp', `"use strict"; return (${e});`)((lo: number, v: number, hi: number) => Math.max(lo, Math.min(v, hi))) as number;
}

/** The calendar's grids for `days`, as renderCalendar writes them: [week columns, quarter separators] per year. */
function calendarGrids(days: Array<{ date: string; bytes: number; count: number }>): Array<{ year: string; cols: number; seps: number }> {
  const els: Record<string, { innerHTML: string; textContent: string; hidden: boolean }> = {};
  const $ = (id: string) => (els[id] ||= { innerHTML: '', textContent: '', hidden: false });
  const render = runPageDecls<() => void>(['calLevel', 'calQuarterOf', 'renderCalendar'], {
    $, calChannel: 'modified', calData: { modified: days, created: null, degraded: [] },
    formatBytes: (n: number) => `${n} B`, escapeHtml: (s: string) => s,
  }, 'renderCalendar');
  render();
  const html = els.calBody.innerHTML;
  return [...html.matchAll(/<div class="cal-year num">(\d+)<\/div><div class="cal-grid">([\s\S]*?)<\/div>/g)].map((m) => {
    const cells = (m[2].match(/class="cal-cell"/g) || []).length;
    return { year: m[1], cols: Math.ceil(cells / 7), seps: (m[2].match(/class="cal-qsep"/g) || []).length };
  });
}

test('every quarter of a full year is on screen in the calendar card at the desktop window’s minimum width (B35)', () => {
  // QA: at 1024×768 the card is 675 px wide and a year's grid 849 px, so
  // October–December sat past the card edge, each year its own sideways
  // scroller with no cue. The cells now size themselves from the card.
  const days: Array<{ date: string; bytes: number; count: number }> = [];
  // 2028 starts on a Saturday and is a leap year: six padding days before
  // 1 January, then 366 — the widest grid a year can draw.
  for (let t = new Date(2028, 0, 1); t.getFullYear() === 2028; t.setDate(t.getDate() + 1)) {
    const iso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    days.push({ date: iso, bytes: 1000 + t.getDate(), count: 1 });
  }
  const [grid] = calendarGrids(days);
  assert.equal(grid.year, '2028');
  assert.equal(grid.cols, 54, 'the widest year is 54 week columns');
  assert.equal(grid.seps, 3, 'with a separator before Q2, Q3 and Q4');

  const host = declsFor('#calBody');
  assert.equal(host.get('container-type'), 'inline-size', 'the calendar measures the card it sits in');
  const g = declsFor('.cal-grid');
  const size = g.get('--cal-c');
  assert.ok(size, 'the grid declares its cell size');
  assert.equal(g.get('grid-template-rows'), 'repeat(7, var(--cal-c))', 'seven rows of that size');
  const cell = declsFor('.cal-cell');
  assert.equal(cell.get('width'), 'var(--cal-c, 12px)', 'cells are as wide as the rows are tall — square');
  assert.equal(cell.get('height'), 'var(--cal-c, 12px)');
  const gap = Number(/^(\d+)px$/.exec(g.get('gap') || '')![1]);
  const sep = Number(/^(\d+)px$/.exec(declsFor('.cal-qsep').get('width') || '')![1]);
  const width = (W: number) => {
    const c = cssPx(size!, W);
    return { c, total: grid.cols * c + grid.seps * sep + (grid.cols + grid.seps - 1) * gap };
  };
  // 675 px is the card at 1024×768 (measured by QA); 849 px was the old grid.
  for (let W = 600; W <= 1400; W++) {
    const { c, total } = width(W);
    assert.ok(total <= W + 0.01, `in a ${W}px card the year is ${total.toFixed(1)}px wide (cells ${c.toFixed(2)}px)`);
  }
  assert.ok(width(675).c >= 8, `at 1024×768 a day is still a ${width(675).c.toFixed(2)}px target`);
  assert.equal(width(1400).c, 12, 'and a wide card keeps the full 12 px cells');
});

/* ══════════════ B30 — the preview-after banner uses its width, and its button is one line ══════════════ */

test('the "Preview after" banner may use its whole max-width, and "Exit preview" never wraps (B30)', () => {
  // QA: with the cart closed the banner re-centred at only 568 px of a
  // 1,100 px map and wrapped to three lines, its button to two. An absolute
  // box at `left: 50%` with an auto width shrinks to fit the room right of
  // its left edge — HALF the map — so it wrapped long before its own
  // max-width. A max-content width is limited only by that max-width.
  const banner = declsFor('.tm-preview-banner');
  const open = declsFor('body.cart-open .tm-preview-banner');
  assert.equal(banner.get('position'), 'absolute');
  const states: Array<[string, Map<string, string>]> = [
    ['cart closed', banner],
    ['cart open', new Map([...banner, ...open])],
  ];
  const pct = (v: string, W: number) => cssPx(v.replace(/(\d+(?:\.\d+)?)%/g, (_m, n: string) => `${(Number(n) / 100) * W}px`), W);
  for (const W of [700, 900, 1150, 1400]) { // the map's width, 1024 to wide windows
    for (const [label, d] of states) {
      const maxW = pct(d.get('max-width')!, W);
      const left = pct(d.get('left')!, W);
      const width = d.get('width');
      // Shrink-to-fit for an absolute box with `right: auto` is capped by the
      // room from its left edge to the containing block's right edge.
      const longest = width === 'max-content' ? maxW : Math.min(maxW, W - left);
      assert.equal(longest, maxW, `${label}, ${W}px map: a line of the banner can run ${longest.toFixed(0)}px of its ${maxW.toFixed(0)}px max-width`);
    }
  }
  const exit = declsFor('.tm-preview-banner #tmPreviewExit');
  assert.equal(exit.get('white-space'), 'nowrap', '"Exit preview" stays one line');
  assert.equal(exit.get('flex'), 'none', 'and the message wraps before the button gives up width');
  assert.match(INDEX, /<button class="pill" id="tmPreviewExit">Exit preview<\/button>/, 'the button is the one in the banner');
});

/* ══════════════ C04 — the preview pane narrows the page, and the views re-fit to it ══════════════ */

/**
 * The page's openPreview and closePreview with their own state, on stubs that
 * record two things in order: a real change of <body>'s preview-open class,
 * and each window resize the page dispatches — with whether the page was
 * narrowed when it went out.
 */
function previewWorld() {
  const log: string[] = [];
  const bodyCls = new Set<string>();
  type El = { id: string; hidden: boolean; innerHTML: string; textContent: string; title: string; classList: unknown; focus(): void; contains(x: unknown): boolean };
  const doc = { activeElement: null as unknown, body: {
    classList: {
      add: (c: string) => { if (!bodyCls.has(c)) { bodyCls.add(c); log.push('+' + c); } },
      remove: (c: string) => { if (bodyCls.has(c)) { bodyCls.delete(c); log.push('-' + c); } },
      contains: (c: string) => bodyCls.has(c),
    },
  }, contains: () => true };
  const els = new Map<string, El>();
  const $ = (id: string): El => {
    if (!els.has(id)) {
      const cls = new Set<string>();
      const e: El = { id, hidden: true, innerHTML: '', textContent: '', title: '',
        classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c), contains: (c: string) => cls.has(c) },
        focus() { doc.activeElement = e; }, contains: (x: unknown) => x === e };
      els.set(id, e);
    }
    return els.get(id)!;
  };
  const fns = runPageDecls<{ open(n: unknown): void; close(): void }>(
    ['pvReqId', 'pvPrevFocus', 'PV_IMG_EXT', 'previewExt', 'previewReflow', 'openPreview', 'closePreview', 'previewIsOpen'], {
      $, document: doc,
      window: { dispatchEvent: (e: { type: string }) => { log.push(`${e.type} (${bodyCls.has('preview-open') ? 'narrowed' : 'whole window'})`); return true; } },
      Event: class { type: string; constructor(t: string) { this.type = t; } },
      requestAnimationFrame: (cb: () => void) => cb(), setTimeout: () => 0,
      toast() {}, chipFor: () => '', formatBytes: String, formatDate: String, escapeHtml: String,
      loadProvenance() {}, api: () => new Promise(() => {}), Image: class {}, highlightCode: String, renderPreviewMeta() {},
    }, '{ open: openPreview, close: closePreview }');
  return { ...fns, log };
}

test('opening the preview pane and closing it re-fit the views beside it — the page changed width with no window resize (C04)', () => {
  // The open pane narrows the page now rather than covering it. The width-
  // sensitive views — the treemap canvas, Disk City, the Grid's tiles, the
  // Compare split — redraw on the window's resize signal, and a width the
  // pane takes or gives back raises none: the map stayed drawn at the old
  // width, its right side cut off by the wrap. The page replays the signal,
  // as the sidebar does when it collapses.
  const w = previewWorld();
  const file = (name: string) => ({ type: 'file', path: '/c/' + name, name, size: 1, modifiedAt: 0 });
  w.open(file('a.mov'));
  assert.deepEqual(w.log, ['+preview-open', 'resize (narrowed)'], 'opening narrows the page, then the views are told to re-fit to it');
  w.log.length = 0;
  w.open(file('b.mov'));
  assert.deepEqual(w.log, [], 'another file in the open pane changes no width, so nothing is re-fitted');
  w.close();
  assert.deepEqual(w.log, ['-preview-open', 'resize (whole window)'], 'closing gives the width back, and the views re-fit to it');
  w.log.length = 0;
  w.close();
  assert.deepEqual(w.log, [], 'closing a pane that is already shut changes nothing');
});

test('with the preview pane and the cart both open in the smallest window, the "Preview after" banner keeps a readable width (C04)', () => {
  // The banner is narrowed by the open dock's 402 px; on a page the pane has
  // narrowed, that left it nothing at 1024 px: 1024 − 244 (the sidebar and its
  // margin) − 330 (the pane) − 48 (<main>'s padding) = 402 px of map.
  const side = sheetPx(declsFor(':root').get('--side-w'), 'the sidebar width') + 12;
  const pane = sheetPx(declsFor('#previewPane').get('width'), 'the pane width');
  const mainPad = 2 * sheetPx((declsFor('main').get('padding') || '').split(/\s+/)[1], "<main>'s side padding");
  const map = 1024 - side - pane - mainPad;
  assert.equal(map, 402, 'control: the map the smallest window leaves beside the pane');
  const d = new Map([...declsFor('.tm-preview-banner'), ...declsFor('body.cart-open .tm-preview-banner')]);
  const maxW = cssPx(d.get('max-width')!.replace(/(\d+(?:\.\d+)?)%/g, (_m, n: string) => `${(Number(n) / 100) * map}px`), map);
  assert.ok(maxW >= 240, `the banner may run ${maxW.toFixed(0)} px — a line of its message and "Exit preview" need 240`);
});

/**
 * The declarations the sheet gives exactly `selector` in a window W px wide:
 * rules outside any @media block, and those inside `@media (max-width: Npx)`
 * blocks that hold at W, in source order. (declsFor reads every rule as if it
 * always applied.)
 */
function declsAt(selector: string, W: number): Map<string, string> {
  const blocks: Array<{ from: number; to: number; max: number | null }> = [];
  for (const m of SHEET.matchAll(/@media\s*([^{]*)\{/g)) {
    let depth = 0, to = -1;
    for (let i = m.index! + m[0].length - 1; i < SHEET.length; i++) {
      if (SHEET[i] === '{') depth++;
      else if (SHEET[i] === '}' && --depth === 0) { to = i; break; }
    }
    const max = /^\(max-width:\s*(\d+(?:\.\d+)?)px\)\s*$/.exec(m[1].trim());
    blocks.push({ from: m.index!, to, max: max ? Number(max[1]) : null });
  }
  const out = new Map<string, string>();
  for (const m of SHEET.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sels = m[1].trim().split(',').map((x) => x.trim().replace(/\s+/g, ' '));
    if (!sels.includes(selector)) continue;
    const inBlock = blocks.find((b) => m.index! > b.from && m.index! < b.to);
    if (inBlock && (inBlock.max === null || W > inBlock.max)) continue; // a query this reader cannot evaluate, or one that does not hold
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i !== -1) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
  }
  return out;
}

test('with the cart open beside the open preview pane, the cart dock covers neither the "Preview after" banner nor "Exit preview", at any window size (C04 remainder c)', () => {
  // QA at 1024×700: the pane open, the cart open, "Preview after" on. The
  // dock stands left of the pane (right: 348 px), 366 px wide in a 450 px
  // column, and the banner — held left of where the dock would be, but never
  // under 240 px — sat under it: "Exit preview" and most of the banner were
  // covered (shots/160). The banner runs from its left inset to its whole
  // max-width (B30), and "Exit preview" is its last item.
  const root = declsFor(':root');
  const paneW = sheetPx(declsFor('#previewPane').get('width'), 'the pane width');
  const mainPad = sheetPx((declsFor('main').get('padding') || '').split(/\s+/)[1], "<main>'s side padding");
  // A rule may name the sidebar's state, the rail being a user's pin (review
  // F1.6): `X` and `X` qualified for this state both apply, the qualified
  // one winning by specificity.
  const stated = (base: string, rail: boolean) => base.replace(/^(body\S*)/, `$1:has(#sideNav${rail ? '.collapsed' : ':not(.collapsed)'})`);
  const forState = (selectors: string[], W: number, rail: boolean) =>
    new Map([...selectors.flatMap((sel) => [...declsAt(sel, W)]), ...selectors.filter((sel) => sel.startsWith('body')).flatMap((sel) => [...declsAt(stated(sel, rail), W)])]);
  const vw = (v: string, W: number) => v.replace(/(\d+(?:\.\d+)?)vw/g, (_m, n: string) => `${(Number(n) / 100) * W}px`);
  let checked = 0, beside = 0;
  for (const W of [1024, 1067, 1068, 1100, 1180, 1235, 1236, 1280, 1320, 1440, 1920]) {
    for (const rail of [false, true]) {
      const side = sheetPx(root.get(rail ? '--side-w-rail' : '--side-w'), 'the sidebar width') + 12;
      const map = W - side - paneW - 2 * mainPad;
      const label = `${W} px, sidebar ${rail ? 'rail' : 'open'} (a ${map} px map)`;
      // The dock: its resting rule, the pane's shift, and any rule for the cart open beside the pane.
      const dockAt = (sels: string[]) => {
        const dock = forState(sels, W, rail);
        const w = Math.min(cssPx(dock.get('width')!, W), cssPx(vw(dock.get('max-width')!, W), W));
        return { left: W - cssPx(dock.get('right')!, W) - w, w };
      };
      const { left: dockLeft, w: dockW } = dockAt(['#cartDock', 'body.preview-open #cartDock', 'body.preview-open.cart-open #cartDock']);
      // The banner, in the map's wrap at the column's left edge.
      const d = forState(['.tm-preview-banner', 'body.cart-open .tm-preview-banner', 'body.preview-open.cart-open .tm-preview-banner'], W, rail);
      const pct = (v: string) => cssPx(v.replace(/(\d+(?:\.\d+)?)%/g, (_m, n: string) => `${(Number(n) / 100) * map}px`), map);
      const bannerLeft = side + mainPad + pct(d.get('left')!);
      const bannerW = pct(d.get('max-width')!);
      assert.ok(bannerW >= 240, `${label}: the banner may run ${bannerW.toFixed(0)} px — a line of its message and "Exit preview" need 240`);
      assert.ok(bannerLeft + bannerW <= dockLeft,
        `${label}: the banner and "Exit preview" run to x ${(bannerLeft + bannerW).toFixed(0)}; the open cart starts at x ${dockLeft.toFixed(0)}`);
      // And it uses the strip it has: held to 240 px beside a dock that has
      // moved out of the way, it wrapped to ten lines and pushed the map down.
      assert.ok(bannerW >= dockLeft - bannerLeft - 28,
        `${label}: the banner may run ${bannerW.toFixed(0)} px of the ${(dockLeft - bannerLeft).toFixed(0)} px left of the open cart`);
      // Where the banner's 240 px and the dock both fit left of the pane, the
      // open dock stays there: over the pane it covers the preview itself,
      // its path and "Show the full address" (review F1.6 — the rail).
      const rest = dockAt(['#cartDock', 'body.preview-open #cartDock']);
      if (bannerLeft + 240 <= rest.left) {
        beside++;
        assert.ok(dockLeft + dockW <= W - paneW,
          `${label}: the banner and the dock fit beside the pane, yet the open cart runs to x ${(dockLeft + dockW).toFixed(0)} over the pane from x ${W - paneW}`);
      }
      checked++;
    }
  }
  assert.equal(checked, 22, 'every size and sidebar state was checked');
  assert.ok(beside >= 8, `control: in ${beside} of them the banner and the dock fit beside the pane`);
});

/* ══════════════ B26 — the map refits when a row around it changes height ══════════════ */

/** The treemap's measured height, with a row of `above` px pushing it down, and whether it redrew. */
function refitWorld(opts: { view?: string; drawnAt: string; above: number; footH?: number; padB?: number }) {
  const draws: string[] = [];
  const wrap = {
    getBoundingClientRect: () => ({ top: 150 + opts.above }),
    parentElement: { querySelector: () => ({ getBoundingClientRect: () => ({ height: opts.footH ?? 17 }) }) },
    closest: () => ({}),
  };
  const fns = runPageDecls<{ tmRefitMap(): void }>(['treemapCanvasHeight', 'tmRefitMap'], {
    $: (id: string) => (id === 'treemapWrap' ? wrap : null),
    state: { view: opts.view ?? 'treemap', treemap: { rootPath: '/c' } },
    tmCanvas: { style: { height: opts.drawnAt } },
    window: { innerHeight: 900 },
    getComputedStyle: (el: unknown) => (el === wrap
      ? { paddingTop: '10px', paddingBottom: '10px' }
      : { marginTop: '12px', paddingBottom: `${opts.padB ?? 48}px` }),
    drawView: () => { draws.push('draw'); },
    isCells: () => false, // the rectangle map: cheap to redraw, so it follows at once
  }, '{ tmRefitMap }');
  return { fns, draws };
}

test('the map redraws when a row above or below it changes height, and only then (B26)', () => {
  // QA: with history AND a query, the query row (Save view · Stage 4 files)
  // appeared after the map was sized, and pushed the footer to y 896–909 in a
  // 900 px window. D59 redrew for the time-lapse bar only.
  // Sized with nothing extra above it: 900 - 150 - 20 - (17 + 12) - 48 = 653.
  const still = refitWorld({ drawnAt: '653px', above: 0 });
  still.fns.tmRefitMap();
  assert.deepEqual(still.draws, [], 'nothing moved: no redraw (a Voronoi map would re-solve for nothing)');
  const pushed = refitWorld({ drawnAt: '653px', above: 42 }); // the query row appeared
  pushed.fns.tmRefitMap();
  assert.deepEqual(pushed.draws, ['draw'], 'the query row pushed the map down: it is redrawn to fit');
  const roomier = refitWorld({ drawnAt: '653px', above: 0, padB: 76 }); // the cart pill reserved the bottom
  roomier.fns.tmRefitMap();
  assert.deepEqual(roomier.draws, ['draw'], 'room taken at the bottom refits it too');
  const elsewhere = refitWorld({ view: 'dashboard', drawnAt: '653px', above: 42 });
  elsewhere.fns.tmRefitMap();
  assert.deepEqual(elsewhere.draws, [], 'not while another view is up');
  const never = refitWorld({ drawnAt: '', above: 42 });
  never.fns.tmRefitMap();
  assert.deepEqual(never.draws, [], 'and not before the map has been drawn at all: its first draw measures');
});

test('every row that can push the map or its footer is watched (B26)', () => {
  const rows = /const TM_CHROME_ROWS = \[([^\]]*)\];/.exec(INDEX);
  assert.ok(rows, 'the rows around the map are listed');
  const list = [...rows![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const sel of ['#view-treemap .tm-toolbar', '#tmQueryBar', '#tmTimebar', '#view-treemap .tm-foot', '#cartDock']) {
    assert.ok(list.includes(sel), `${sel} is watched (${list.join(', ')})`);
  }
  const wiring = INDEX.slice(rows!.index, rows!.index + 600);
  assert.match(wiring, /new ResizeObserver\(\(\) => tmRefitMap\(\)\)/, 'a change of size refits the map');
  assert.match(wiring, /for \(const sel of TM_CHROME_ROWS\)[^}]*\.observe\(/, 'and every listed row is observed');
});

/* ══════════════ B36 remainder — at the desktop window's minimum the map gives way, never the footer ══════════════ */

/** One px length from the stylesheet ("10px", or the first side of a shorthand). */
function sheetPx(v: string | undefined, what: string): number {
  const m = /^(\d+(?:\.\d+)?)px\b/.exec((v || '').trim());
  assert.ok(m, `${what} is a px length (${v})`);
  return Number(m![1]);
}

/**
 * The page's treemapCanvasHeight in a window `H` px tall, with the map's wrap
 * starting `top` px down and a footer `footH` px tall, while the cart holds
 * something. The wrap's padding, the footer's top margin and the bottom room
 * <main> keeps for the cart pill are the stylesheet's own — but for the top
 * padding while "Preview after" is up, which the page measures from its
 * banner (--tm-preview-pad), given here as `previewPad`.
 */
function mapWithCart(H: number, top: number, footH: number, previewPad?: number) {
  const pad = sheetPx(declsFor('#treemapWrap').get('padding'), "#treemapWrap's padding");
  const padTop = previewPad ?? pad;
  const footGap = sheetPx(declsFor('.tm-foot').get('margin-top'), "the footer's top margin");
  const padB = sheetPx(declsFor('body:has(#cartDock.show) main').get('padding-bottom'), 'the room <main> keeps for the cart pill');
  const wrap = {
    getBoundingClientRect: () => ({ top }),
    parentElement: { querySelector: () => ({ getBoundingClientRect: () => ({ height: footH }) }) },
    closest: () => ({}),
  };
  const height = runPageDecls<(w: unknown) => number>(['treemapCanvasHeight'], {
    window: { innerHeight: H },
    getComputedStyle: (el: unknown) => (el === wrap
      ? { paddingTop: `${padTop}px`, paddingBottom: `${pad}px` }
      : { marginTop: `${footGap}px`, paddingBottom: `${padB}px` }),
  }, 'treemapCanvasHeight')(wrap);
  // Where the footer's last line (the hint) ends, and where the room kept for the pill begins.
  return { height, footEnd: top + padTop + height + pad + footGap + footH, pillRoom: H - padB };
}

test('at the desktop window\'s minimum the map gives up height so its footer stays above the cart pill (B36 remainder)', () => {
  // QA re-check (12 Oct 2026): fixed at 1440×900 and 1280×800, but at
  // 1024×700 — the desktop window's minimum — the pill still covered the hint
  // and the "12,488 nodes · …" counts, and at 1024×768 it covered the hint in
  // Reclaim colour. The rows above the map (the toolbar on two rows, a saved
  // view's chip row, the time-lapse bar wrapped to two lines) start its wrap
  // at y 250, and the map kept a 360 px floor: the footer was pushed under
  // the pill however much room <main> kept for it.
  const cases: Array<[string, number, number, number]> = [
    // label, window height, wrap top, footer height (measured, shots/332 and 331)
    ['1024×700, Size colour: legend and counts, then the hint', 700, 250, 40],
    ['1024×768, Reclaim colour: the legend note wraps to two lines', 768, 250, 76],
    ['1024×700, Reclaim colour', 700, 250, 76],
  ];
  for (const [label, H, top, footH] of cases) {
    const m = mapWithCart(H, top, footH);
    assert.ok(m.footEnd <= m.pillRoom,
      `${label}: the hint ends at y ${m.footEnd} under a ${m.height} px map; the room kept for the pill starts at y ${m.pillRoom}`);
  }
  // QA D12 (third pass, shots/161 and 164): the same window with the preview
  // pane open — a 402 px map — in "Preview after" with two scans (the time
  // slider): the toolbar on four rows and the time-lapse bar on three start
  // the wrap at y 293, the banner pads it by 127 px, and the hint takes two
  // lines (a 69 px footer). The map kept a 200 px floor: the page grew to
  // 787 px in a 700 px window and, unscrolled, the pill covered "10 GB+" and
  // "Preview · 3.2 GB staged for the Trash".
  const d12 = mapWithCart(700, 293, 69, 127);
  assert.ok(d12.footEnd <= d12.pillRoom,
    `1024×700, preview pane, Preview after, time slider: the hint ends at y ${d12.footEnd} under a ${d12.height} px map; the room kept for the pill starts at y ${d12.pillRoom}`);
  // The map still never collapses: in a window with no room left at all it
  // keeps a usable floor, and the page scrolls to the footer instead. The
  // floor was 200 px; the state above leaves the map 113, so it is 96 now —
  // two rows of labelled cells — and the desktop window's minimum fits.
  const tiny = mapWithCart(480, 250, 76);
  assert.ok(tiny.height >= 96, `a window with no room left still draws a ${tiny.height} px map`);
});

test('the sunburst fits the map the page leaves it, down to the map\'s floor — its disc is never cut by the top or bottom of a short map (review F1.3)', () => {
  // D12 lowered the map's floor from 200 px to 96, under the sunburst's own
  // minimum: its outer radius never went below 60 px (a 120 px disc), so a
  // map 96–119 px tall drew a disc taller than itself and lost the outer
  // ring at 12 and 6 o'clock — 3.5 px a side in the D12 state, 12 at the floor.
  const floor = mapWithCart(480, 250, 76).height;
  const d12 = mapWithCart(700, 293, 69, 127).height;
  assert.ok(floor < 120 && d12 < 120, `control: the map can be shorter than a 120 px disc (floor ${floor}, the D12 state ${d12})`);
  const geometry = (cssW: number, cssH: number) => runPageDecls<() => { cx: number; cy: number; outerR: number }>(['sunRingCount', 'sunburstGeometry'], {
    state: { treemap: { maxDepth: 7 } },
    tmSizeCanvas: () => ({ cssW, cssH, dpr: 1 }),
  }, 'sunburstGeometry')();
  for (const cssW of [402, 1100]) {
    for (const cssH of [floor, d12, 100, 119, 120, 127, 128, 140, 156, 200, 360, 600]) {
      const g = geometry(cssW, cssH);
      const half = Math.min(cssW, cssH) / 2;
      const label = `a ${cssW}×${cssH} map`;
      // The disc and the 2 px outline drawn round a hovered or keyboard-picked arc.
      assert.ok(g.cy - g.outerR - 1 >= 0 && g.cy + g.outerR + 1 <= cssH && g.cx - g.outerR - 1 >= 0 && g.cx + g.outerR + 1 <= cssW,
        `${label}: the sunburst spans y ${(g.cy - g.outerR).toFixed(1)}–${(g.cy + g.outerR).toFixed(1)}, x ${(g.cx - g.outerR).toFixed(1)}–${(g.cx + g.outerR).toFixed(1)}, and its outline a pixel more`);
      if (half - 18 >= 60) assert.equal(g.outerR, half - 18, `${label}: a map with room draws the disc it always did`);
      else assert.ok(g.outerR >= Math.min(60, half - 6), `${label}: a short map's disc takes its height but a few pixels (radius ${g.outerR}, the map's half ${half})`);
    }
  }
});

/**
 * A Voronoi (or Circles) map with the page's own refit and its own window
 * resize handler, on a clock that only moves when the test moves it. A solve
 * is a drawCells; it sizes the canvas to what the map should be, as
 * tmSizeCanvas does. A frame is what a browser does in one: the resize event,
 * then the ResizeObserver delivery (the toolbar's width followed the window,
 * so it fires), then 16 ms pass and any timer that is due runs.
 *
 * Which renderer draws is decided by the page's own isCells, isSun and
 * drawView, and each draw is recorded as what it is: `solve` (drawCells),
 * `treemap`, `sunburst` — and `scores` when a draw asks for the Reclaim
 * scores of what it drew.
 */
function cellsWorld(opts: { colorMode?: string; above?: number } = {}) {
  const w = { innerHeight: 900, above: opts.above ?? 0, now: 0, solves: 0, zoomRunning: false, hidden: false, events: [] as string[] };
  const timers = new Map<number, { at: number; fn: () => void }>();
  let tid = 0;
  const resizeHandlers: Array<() => void> = [];
  const wrap = {
    getBoundingClientRect: () => ({ top: 150 + w.above }),
    parentElement: { querySelector: () => ({ getBoundingClientRect: () => ({ height: 17 }) }) },
    closest: () => ({}),
  };
  const tmCanvas = { style: { height: '' } };
  const state = {
    view: 'treemap',
    treemap: {
      rootPath: '/c' as string | null, mode: 'voronoi', colorMode: opts.colorMode ?? 'size',
      get altZoomRaf() { return w.zoomRunning ? 7 : 0; },
    },
  };
  type Fns = { treemapCanvasHeight(el: unknown): number; tmRefitMap(): void };
  let fns: Fns;
  const drawCells = () => { w.solves++; w.events.push('solve'); tmCanvas.style.height = fns.treemapCanvasHeight(wrap) + 'px'; };
  fns = runPageDecls<Fns>(['isCells', 'isSun', 'drawView', 'treemapCanvasHeight', 'tmRefitMap'], {
    $: (id: string) => (id === 'treemapWrap' ? wrap : null),
    state, tmCanvas,
    window: { get innerHeight() { return w.innerHeight; }, addEventListener: (t: string, f: () => void) => { if (t === 'resize') resizeHandlers.push(f); } },
    document: { get hidden() { return w.hidden; } },
    getComputedStyle: (el: unknown) => (el === wrap ? { paddingTop: '10px', paddingBottom: '10px' } : { marginTop: '12px', paddingBottom: '48px' }),
    drawCells,
    drawTreemap: () => { w.events.push('treemap'); },
    drawSunburst: () => { w.events.push('sunburst'); },
    fetchScoresForTreemap: () => { w.events.push('scores'); },
    setTimeout: (fn: () => void, ms: number) => { timers.set(++tid, { at: w.now + ms, fn }); return tid; },
    clearTimeout: (id: number) => { timers.delete(id); },
  }, '{ treemapCanvasHeight, tmRefitMap }',
  // The window's resize handler, exactly as the page registers it.
  pageBetween('let tmResizeDeb = 0;', '/* ── Feature 20'));
  assert.equal(resizeHandlers.length, 1, 'the treemap registers one window resize handler');
  const pass = (ms: number) => {
    const until = w.now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      w.now = due[1].at;
      due[1].fn();
    }
    w.now = until;
  };
  // `observed` false: no watched row changed size (a height-only drag leaves the toolbar's width alone).
  const frame = (resized: boolean, observed = true) => {
    if (resized) for (const h of resizeHandlers) h();
    if (observed) fns.tmRefitMap();
    pass(16);
  };
  drawCells(); // the map as first drawn
  w.events.length = 0;
  return { w, state, fns, frame, pass };
}

test('a window drag re-solves a Voronoi map once, after it settles — the refit waits with the resize handler (B26 review F1.1)', () => {
  // Review: the toolbar's width follows the window, so the ResizeObserver
  // fired on every frame of a corner drag, found the canvas height stale
  // (the resize handler deliberately waits 160 ms for cells) and re-solved
  // the layout — 30 full solves for 30 frames, where the handler does one.
  const m = cellsWorld();
  for (let i = 0; i < 30; i++) { m.w.innerHeight -= 3; m.frame(true); }
  assert.equal(m.w.solves - 1, 0, `a 30-frame drag re-solved the map ${m.w.solves - 1} times while it was still moving`);
  m.pass(400);
  assert.equal(m.w.solves - 1, 1, 'and exactly once when it settled');
  m.fns.tmRefitMap();
  m.pass(400);
  assert.equal(m.w.solves - 1, 1, 'which fitted it: nothing is owed afterwards');
});

test('a row that changes height re-solves a Voronoi map once, and never under the level zoom that is running (B26 review F1.1)', () => {
  const m = cellsWorld();
  m.w.zoomRunning = true; // a drill-in's transition is playing over the layout it just built
  m.w.above = 42; // and the query row appears above the map
  m.frame(false);
  assert.equal(m.w.solves - 1, 0, 'nothing is solved under the zoom: a solve cancels it and the map jumps');
  m.pass(1000);
  assert.equal(m.w.solves - 1, 0, 'it keeps waiting while the zoom runs');
  m.w.zoomRunning = false;
  m.pass(400);
  assert.equal(m.w.solves - 1, 1, 'and refits once the zoom has finished');
  // A hidden tab runs no frames, so its zoom never finishes: nobody is watching, refit anyway.
  const h = cellsWorld();
  h.w.zoomRunning = true; h.w.hidden = true; h.w.above = 42;
  h.frame(false);
  h.pass(400);
  assert.equal(h.w.solves - 1, 1, 'in a hidden tab the refit does not wait for a zoom that cannot end');
});

test('in Reclaim colour, the settled re-solve asks for the scores of the cells it drew — after a row closes and after a window drag (B26 review F2.1)', () => {
  // Review: F1.1 moved the refit from drawView() to a bare drawCells(), and
  // only drawView asks for scores. A map that grew drew cells it had never
  // drawn, and they painted as unscored grey ("scored N of M") until
  // something else asked. The window's resize handler had the same gap.
  const m = cellsWorld({ colorMode: 'reclaim', above: 42 }); // drawn with the query row above it
  m.w.above = 0; // the row closes: the map is taller, and draws cells it never drew
  m.frame(false);
  assert.deepEqual(m.w.events, [], 'nothing yet: the re-solve waits for things to settle');
  m.pass(400);
  assert.deepEqual(m.w.events, ['solve', 'scores'], 'the re-solve asks for the scores of what it drew, once it has drawn it');
  m.w.events.length = 0;
  // The window dragged taller by its bottom edge: the toolbar keeps its width,
  // so no watched row changes size and only the window's resize event fires.
  for (let i = 0; i < 10; i++) { m.w.innerHeight += 3; m.frame(true, false); }
  m.pass(400);
  assert.deepEqual(m.w.events, ['solve', 'scores'], 'a window drag settles through the same draw, and asks too');
});

test('a re-solve still waiting when the renderer, the view or the map changes draws nothing — the change draws for itself (B26 review F2.3)', () => {
  // Review: a row changing height arms the settle timer, and switching the
  // renderer does not clear it (only leaving the view does). Its guard is
  // all that stops it painting over the map the switch just drew.
  type World = ReturnType<typeof cellsWorld>;
  const changes: Array<[string, (m: World) => void]> = [
    ['the renderer became the Treemap', (m) => { m.state.treemap.mode = 'treemap'; }],
    ['the renderer became the Sunburst', (m) => { m.state.treemap.mode = 'sunburst'; }],
    ['another view came up', (m) => { m.state.view = 'dashboard'; }],
    ['the map went away', (m) => { m.state.treemap.rootPath = null; }],
  ];
  for (const [what, change] of changes) {
    const m = cellsWorld();
    m.w.above = 42; // the query row appears: a re-solve is waiting
    m.frame(false);
    assert.deepEqual(m.w.events, [], `${what}: nothing is drawn before the wait ends (precondition)`);
    change(m);
    m.pass(400);
    assert.deepEqual(m.w.events, [], `${what} while the re-solve waited: it draws nothing`);
  }
});

/* ══════════════ B26 review F3.3 — the shapes a refined layout adds are asked about too ══════════════ */

/**
 * A Voronoi map whose layout takes several slices, drawn as a settled
 * re-solve draws it: the page's own drawView, buildCells, refinement loop
 * and score fetch, lifted together. The solver returns `slices[i]` shapes on
 * its i-th call, finished on the last; each animation frame the loop asks
 * for runs on `frame()`. Recorded: the paths of every ensureScores call, and
 * every legend render.
 */
function refineWorld(colorMode: string, slices: number[]) {
  const asked: string[][] = [];
  let legends = 0;
  const frames: Array<() => void> = [];
  let call = 0;
  const solve = () => {
    const i = call++;
    const cells = Array.from({ length: slices[i] }, (_, k) => ({ n: { path: `/r/c${k}` } }));
    return { cells, done: i === slices.length - 1, resume: { slice: i + 1 }, note: '' };
  };
  const state = {
    scanId: 's1', view: 'treemap',
    treemap: { mode: 'voronoi', colorMode, rootPath: '/r', cells: [] as Array<{ n: { path: string } }>,
      altNote: '', altMs: 0, altRaf: 0, altZoomRaf: 0, altZoom: null },
  };
  const fns = runPageDecls<{ drawView(): void }>(
    ['altRefineSeq', 'tmScoreChain', 'isSun', 'isCells', 'drawView', 'drawnCells', 'buildCells',
      'altRefiningNote', 'altRefineCancel', 'altRefineSchedule', 'tmScoreKey', 'fetchScoresForTreemap'], {
      state, AbortController,
      sunburstRoot: () => ({ path: '/r' }),
      layoutVoronoi: solve, layoutCirclePack: solve,
      performance: { now: () => 0 },
      requestAnimationFrame: (f: () => void) => frames.push(f), cancelAnimationFrame: () => {},
      fxShapeSync() {}, repaintCells() {}, renderAltNote() {}, drawTreemap() {}, drawSunburst() {},
      renderTmLegend: () => { legends++; },
      formatCount: String, reclaimAskableNode: () => true, TM_SCORE_CAP: 6000,
      ensureScores: (paths: string[]) => { asked.push([...paths]); return Promise.resolve(); },
    }, '{ drawView }',
    // drawCells as the page has it, less the canvas: it lays the map out.
    'function drawCells() { buildCells({ cssW: 800, cssH: 600, dpr: 1 }); }');
  return {
    state, asked, frames, legends: () => legends, drawView: fns.drawView,
    frame: () => { const f = frames.shift(); assert.ok(f, 'a frame is waiting'); f!(); },
  };
}

test('in Reclaim colour, the shapes a Voronoi layout adds after its first slice are asked about once it finishes, and the legend recounts (B26 review F3.3)', () => {
  // Review: drawView asked for the scores of what was drawn while only the
  // first slice was, and the refinement frames that drew the rest asked
  // nothing — those shapes stayed in unscored grey until something else did.
  const m = refineWorld('reclaim', [3, 7, 12]);
  m.drawView();
  assert.deepEqual(m.asked.map((a) => a.length), [3], 'the draw asks for the slice it drew (precondition)');
  m.frame();
  assert.equal(m.state.treemap.cells.length, 7, 'a second slice is drawn');
  assert.deepEqual(m.asked.map((a) => a.length), [3], 'nothing is asked while the layout is still filling in');
  m.frame();
  assert.equal(m.frames.length, 0, 'the layout is finished (precondition)');
  const everAsked = new Set(m.asked.flat());
  const unasked = m.state.treemap.cells.map((c) => c.n.path).filter((p) => !everAsked.has(p));
  assert.deepEqual(unasked, [], 'every shape on the finished map has been asked about');
  assert.equal(m.asked.length, 2, 'in one more ask, made when the layout finished');
  assert.equal(m.legends(), 1, 'and the legend recounts against the finished map while they load');

  const s = refineWorld('size', [3, 7, 12]);
  s.drawView(); s.frame(); s.frame();
  assert.deepEqual(s.asked, [], 'in Size colour nothing is asked');
  assert.equal(s.legends(), 0, 'and the legend is not redrawn');
});

/* ══════════════ D04 — a toolbar label never wraps away from its control ══════════════ */

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'col', 'wbr', 'area', 'base', 'embed', 'param', 'track']);

/** The page's <body> as a tree the fake selector walks — scripts and comments left out. */
function markupTree(): SelectorNode {
  const html = INDEX.slice(INDEX.indexOf('<body')).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const root: SelectorNode = { tagName: 'root', id: '', cls: new Set(), attrs: {}, parent: null, children: [] };
  let cur = root;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
    const tag = m[2].toLowerCase();
    if (m[1]) {
      let n: SelectorNode | null = cur;
      while (n && n !== root && n.tagName !== tag) n = n.parent;
      if (n && n !== root) cur = n.parent!;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[3].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? '';
    const el: SelectorNode = { tagName: tag, id: attrs.id || '', cls: new Set((attrs.class || '').split(/\s+/).filter(Boolean)), attrs, parent: cur, children: [] };
    cur.children.push(el);
    if (!VOID_TAGS.has(tag)) cur = el;
  }
  return root;
}

/** Selectors the fake DOM reads: compounds joined by spaces, nothing more. */
const readableSelector = (sel: string) => /^[\w\s.#[\]="-]+$/.test(sel);

/** The declarations the sheet gives `el`, from every rule whose selector the fake DOM can match it with, in source order. */
function sheetFor(root: SelectorNode, el: SelectorNode): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of RULES) {
    if (!r.selectors.some((sel) => readableSelector(sel) && selectAll(root, sel).includes(el))) continue;
    for (const d of r.body.split(';')) {
      const i = d.indexOf(':');
      if (i !== -1) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
  }
  return out;
}

test('a label in a toolbar that wraps travels with its control — "Sort", "After" and the rest never end a row while their menu starts the next (D04)', () => {
  // QA at 1024 px: the Grid three levels deep left "Sort" at the end of the
  // first row (965, 28) and its menu at the start of the second (268, 60);
  // History › Compare ended row one with "After" (649, 70) and began row
  // two with its list (268, 102). A wrapping flex row breaks between its
  // ITEMS, and each label was an item of its own beside its control's.
  const root = markupTree();
  const wrapping = new Set<SelectorNode>();
  for (const r of RULES) {
    if (!/flex-wrap:\s*wrap/.test(r.body)) continue;
    for (const sel of r.selectors) if (readableSelector(sel)) for (const el of selectAll(root, sel)) wrapping.add(el);
  }
  const byId = new Map(selectAll(root, '[id]').map((el) => [el.id, el] as [string, SelectorNode]));
  const inside = (a: SelectorNode, b: SelectorNode) => { for (let p: SelectorNode | null = b; p; p = p.parent) if (p === a) return true; return false; };
  const checked: string[] = [];
  for (const label of selectAll(root, 'label[for]')) {
    const id = label.attrs.for;
    const control = byId.get(id);
    assert.ok(control, `#${id}, the control a label names, is in the page`);
    let item = label, row = label.parent;
    while (row && !wrapping.has(row)) { item = row; row = row.parent; }
    if (!row) continue; // not in a row that wraps
    const where = `#${id} in .${[...row.cls].join('.') || row.id}`;
    assert.notEqual(item, label, `${where}: the label is a flex item of its own, so the row can wrap between it and its control`);
    assert.ok(inside(item, control!), `${where}: the label's item does not hold its control`);
    // A row of its own that does not wrap (one that did would be the row
    // found above, and the label an item of it).
    assert.match(sheetFor(root, item).get('display') || '', /^(inline-)?flex$/, `${where}: the pair lays its label and control out in a row`);
    assert.equal(sheetFor(root, label).get('white-space'), 'nowrap', `${where}: the label keeps its words on one line beside the control`);
    checked.push(id);
  }
  for (const id of ['gridSort', 'cmpA', 'cmpB', 'trendRoot', 'dupMinSize', 'ndThreshold', 'tmDepth']) {
    assert.ok(checked.includes(id), `#${id}'s label was found in its wrapping toolbar and checked (checked: ${checked.join(', ')})`);
  }
});
