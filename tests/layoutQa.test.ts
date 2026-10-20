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
    refreshCartButtons() {}, cartButtonHtml: () => '<button class="icon-btn"></button>',
    nodeFor: () => null, confirmTrash() {}, openInOS() {}, showCtxMenu() {},
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
  setAttribute(k: string, v: string): void;
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
      setAttribute: (k, v) => { el.attrs[k] = String(v); },
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
    renderCartGoal() {}, cartTotalBytes: () => 0, cartNode: () => null, cartSpaceSaid: () => '',
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
  assert.equal(w.els.cartTab.attrs['aria-expanded'], 'true', 'control: the open drawer is said on its pill (F11b)');
  fire(w.els.cartCollapse, 'click');
  assert.equal(w.focus.active, w.els.cartTab, 'the tab is the way back in while the cart has items');
  assert.equal(w.els.cartTab.attrs['aria-expanded'], 'false', 'and the pill says the drawer is closed (fifth browser pass F11b)');
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

test('while the cart is open the welcome tour\'s card covers none of it — at every window size, the preview pane open or not, in both sidebar states (sixth browser pass H51)', () => {
  // QA: the tour card (z 96, 18 px from the right, 86 px up) sat on the open cart (z 80): a hit test
  // at the centre of Preview after, Clear, Move all to Trash and each row's × returned the card, so
  // the cart could not be used until the tour was skipped. The card stands left of the open cart now.
  const z = (sel: string) => Number(declsFor(sel).get('z-index'));
  assert.ok(z('#tourOverlay') > z('#cartDock'), `the premise: the card's layer (${z('#tourOverlay')}) is above the cart's (${z('#cartDock')}), so where they meet the card wins`);
  const root = declsFor(':root');
  const stated = (base: string, rail: boolean) => base.replace(/^(body\S*)/, `$1:has(#sideNav${rail ? '.collapsed' : ':not(.collapsed)'})`);
  const forState = (selectors: string[], W: number, rail: boolean) =>
    new Map([...selectors.flatMap((sel) => [...declsAt(sel, W)]), ...selectors.filter((sel) => sel.startsWith('body')).flatMap((sel) => [...declsAt(stated(sel, rail), W)])]);
  const vw = (v: string, W: number) => v.replace(/(\d+(?:\.\d+)?)vw/g, (_m, n: string) => `${(Number(n) / 100) * W}px`);
  let checked = 0;
  for (const W of [1024, 1067, 1068, 1100, 1180, 1235, 1236, 1280, 1320, 1440, 1920]) {
    for (const rail of [false, true]) {
      for (const preview of [false, true]) {
        const side = sheetPx(root.get(rail ? '--side-w-rail' : '--side-w'), 'the sidebar width') + 12;
        const label = `${W} px, sidebar ${rail ? 'rail' : 'open'}${preview ? ', preview pane open' : ''}`;
        const dock = forState(['#cartDock', ...(preview ? ['body.preview-open #cartDock', 'body.preview-open.cart-open #cartDock'] : [])], W, rail);
        const dockW = Math.min(cssPx(dock.get('width')!, W), cssPx(vw(dock.get('max-width')!, W), W));
        const dockLeft = W - cssPx(dock.get('right')!, W) - dockW;
        const card = forState(['.tour-card', 'body.cart-open .tour-card', ...(preview ? ['body.preview-open.cart-open .tour-card'] : [])], W, rail);
        // The card's place is set on <body> (--tour-r, --tour-w) for the toast stack to read too (review F1.12).
        const tour = forState(['body', 'body.cart-open', ...(preview ? ['body.preview-open.cart-open'] : [])], W, rail);
        const resolved = (v: string) => v.replace(/var\((--[\w-]+)\)/g, (_m, k: string) => { const r = tour.get(k); assert.ok(r, `${label}: ${k} is set on <body>`); return r!; });
        const cardRight = W - cssPx(resolved(card.get('right')!), W);
        const cardLeft = cardRight - cssPx(vw(resolved(card.get('width')!), W), W);
        assert.ok(cardRight <= dockLeft, `${label}: the card runs to x ${cardRight.toFixed(0)}; the open cart starts at x ${dockLeft.toFixed(0)} — no button of the cart is under it`);
        assert.ok(cardLeft >= side, `${label}: the card starts at x ${cardLeft.toFixed(0)}, clear of the sidebar (to x ${side})`);
        assert.ok(cardRight - cardLeft >= 240, `${label}: the card keeps a readable width (${(cardRight - cardLeft).toFixed(0)} px)`);
        checked++;
      }
    }
  }
  assert.equal(checked, 44, 'every size, sidebar state and pane state was checked');
  // Control: with the cart closed the card stays where it rests.
  assert.equal(declsAt('.tour-card', 1440).get('right'), 'var(--tour-r)', 'the card stands where <body> says');
  assert.equal(declsAt('body', 1440).get('--tour-r'), '18px', 'control: the resting card, 18 px from the right');
});

/* ══════════════ J04 — the coach card covers no control (seventh browser pass) ══════════════ */

/** A box on screen, in CSS px from the window's top-left; `tag` its element's (a canvas is a surface, not a control). */
type Box = { left: number; top: number; right: number; bottom: number; tag?: string };

/**
 * The page's tourPlace over a W × H window, the card `cardH` px tall in its
 * column (where the stylesheet stands it: --tour-r from the right, --tour-w
 * wide), and `controls` on screen. Returns the offset from the window's
 * bottom it stood the card at (--tour-b; 86 px at rest) and the card's box.
 */
function placeTour(W: number, H: number, cardH: number, controls: Box[]) {
  const body = declsAt('body', W);
  const right = W - sheetPx(body.get('--tour-r'), '--tour-r');
  const width = Math.min(360, W - 32); // --tour-w: min(360px, calc(100vw - 32px)), asserted below
  const props: Record<string, string> = {};
  const restPx = sheetPx(body.get('--tour-b'), '--tour-b');
  const bottom = () => (props['--tour-b'] ? sheetPx(props['--tour-b'], 'the --tour-b set') : restPx);
  const box = () => ({ left: right - width, right, width, height: cardH, top: H - bottom() - cardH, bottom: H - bottom() });
  const els = controls.map((c) => ({ tagName: c.tag ?? 'BUTTON', getClientRects: () => [c], getBoundingClientRect: () => c }));
  let asked = '';
  const fns = runPageDecls<{ tourPlace(): void }>(['TOUR_REST_BOTTOM', 'TOUR_GAP', 'TOUR_EDGE', 'TOUR_CONTROLS', 'tourPlace'], {
    tour: { active: true },
    $: (id: string) => (id === 'tourCard' ? { getBoundingClientRect: box } : id === 'tourOverlay' ? { hidden: false } : null),
    document: {
      body: { style: { setProperty: (k: string, v: string) => { props[k] = v; }, removeProperty: (k: string) => { delete props[k]; } } },
      querySelectorAll: (sel: string) => { asked = sel; return els; },
    },
    window: { innerHeight: H },
  }, '{ tourPlace }');
  fns.tourPlace();
  return { bottom: bottom(), card: box(), set: '--tour-b' in props, asked };
}
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test('the welcome tour\'s card stands where it covers no control on screen — at 1024 × 700 it no longer lies over the Dashboard\'s Browse… and Scan; with nothing under it, it rests (seventh browser pass J04)', () => {
  // The stylesheet's half: the card stands --tour-b up from the window's bottom, 86 px at rest, set on <body>.
  assert.equal(declsAt('.tour-card', 1440).get('bottom'), 'var(--tour-b)', 'the card stands where <body> says');
  assert.equal(declsAt('body', 1440).get('--tour-b'), '86px', 'resting 86 px up');
  assert.equal(declsAt('body', 1440).get('--tour-w'), 'min(360px, calc(100vw - 32px))', 'control: the width this test lays the card out with');
  // QA (C-L1024-dashboard): Step 2 of 4, 195 px tall, covered the top 13 px of Browse… and Scan.
  const dash1024: Box[] = [
    { left: 942, top: 40, right: 970, bottom: 62 }, // the "Nothing changed" banner's close
    { left: 290, top: 276, right: 966, bottom: 300 }, // the System card's Trash row (role=button)
    { left: 333, top: 480, right: 420, bottom: 492, tag: 'SUMMARY' }, // "Engine details", left of the card's column
    { left: 292, top: 603, right: 782, bottom: 631, tag: 'INPUT' }, // the path box
    { left: 792, top: 605, right: 872, bottom: 631 }, // Browse…
    { left: 884, top: 605, right: 966, bottom: 631 }, // Scan
  ];
  const at = placeTour(1024, 700, 195, dash1024);
  assert.match(at.asked, /\.view\.active button/, 'control: it asks for the controls of the view that is up');
  assert.match(at.asked, /#emptyState button/, 'and of the start screen');
  for (const c of dash1024) assert.ok(!overlaps(at.card, c), `1024 × 700: the card (y ${at.card.top}–${at.card.bottom}) covers no control (${JSON.stringify(c)})`);
  assert.ok(at.card.top >= 8 && at.card.bottom <= 700 - 8, `and stays in the window (y ${at.card.top}–${at.card.bottom})`);
  assert.ok(at.set, 'control: it was moved from its rest, where it covered Browse… and Scan');
  assert.equal(at.bottom, 700 - 605 + 12, 'as little as it can: 12 px above Browse… and Scan (clear of the path box too), the place nearest its rest that is clear');
  // The start screen at 1024 × 700 with the welcome card (140 px): its choices wrap to a third row.
  const start: Box[] = [
    { left: 339, top: 352, right: 519, bottom: 396 }, { left: 790, top: 352, right: 918, bottom: 396 },
    { left: 482, top: 407, right: 618, bottom: 451 }, { left: 628, top: 407, right: 774, bottom: 451 },
    { left: 533, top: 466, right: 723, bottom: 509 }, // Choose a folder…
  ];
  const welcome = placeTour(1024, 700, 140, start);
  for (const c of start) assert.ok(!overlaps(welcome.card, c), `the start screen: the card covers no choice (${JSON.stringify(c)})`);
  // 1440 × 900: nothing under the card where it rests — it stays there.
  // (The card's column there is x 1062–1422, y 619–814 at rest; Browse… and Scan stand left of it.)
  const wide = placeTour(1440, 900, 195, [{ left: 290, top: 276, right: 1400, bottom: 300 }, { left: 940, top: 640, right: 1040, bottom: 666 }]);
  assert.equal(wide.bottom, 86, 'nothing under it: it rests');
  assert.equal(wide.set, false, 'with nothing set on <body>');
  // A canvas is the view's surface, not a control: over the map — or a small chart under it — the card rests.
  assert.equal(placeTour(1024, 700, 195, [{ left: 268, top: 100, right: 1004, bottom: 680, tag: 'CANVAS' }]).bottom, 86, 'over the map it rests');
  assert.equal(placeTour(1024, 700, 195, [{ left: 700, top: 450, right: 1000, bottom: 600, tag: 'CANVAS' }]).bottom, 86, 'over a chart it rests');
  // And it is placed again whenever what is under it can move: a resize, and a scroll of any part of the page.
  assert.match(INDEX, /window\.addEventListener\('resize', tourPlaceSoon\);/, 'placed again on a resize');
  assert.match(INDEX, /document\.addEventListener\('scroll', tourPlaceSoon, \{ capture: true, passive: true \}\);/, 'and on a scroll anywhere');
  // Never lower than its rest: the window's bottom-right corner is the cart pill's and the toasts'.
  // A control at y 430–450 is cleared from above (the card at y 223–418), not by dropping the card under it to 43 px up.
  const low = placeTour(1024, 700, 195, [{ left: 700, top: 430, right: 900, bottom: 450 }]);
  assert.equal(low.bottom, 282, `cleared from above, never dropped below its rest (stood ${low.bottom} px up)`);
  // A column full of controls from top to bottom: nowhere is clear, and it rests, in the window.
  const full = Array.from({ length: 30 }, (_, i) => ({ left: 600, top: i * 24, right: 1000, bottom: i * 24 + 20 }));
  assert.equal(placeTour(1024, 700, 195, full).bottom, 86, 'nowhere clear: it rests, never off screen');
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
  const fns = runPageDecls<{ tmRefitMap(): void }>(['tmUnscrolledTop', 'treemapCanvasHeight', 'tmRefitMap'], {
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
function mapWithCart(H: number, top: number, footH: number, previewPad?: number, rows: RowBelow[] = []) {
  const pad = sheetPx(declsFor('#treemapWrap').get('padding'), "#treemapWrap's padding");
  const padTop = previewPad ?? pad;
  // The map's card is a .glass card, whose hairline border is height too (QA fourth pass D12: 702 px in a 700 px window).
  assert.match(INDEX, /<div class="glass" id="treemapWrap">/, 'control: the map sits in a .glass card');
  const border = sheetPx(declsFor('.glass').get('border'), "the card's border");
  const footGap = sheetPx(declsFor('.tm-foot').get('margin-top'), "the footer's top margin");
  const padB = sheetPx(declsFor('body:has(#cartDock.show) main').get('padding-bottom'), 'the room <main> keeps for the cart pill');
  const below = rowsBelow(rows);
  const foot = { getBoundingClientRect: () => ({ height: footH }), nextElementSibling: below.first };
  const wrap = {
    getBoundingClientRect: () => ({ top }),
    parentElement: { querySelector: () => foot },
    closest: () => ({}),
  };
  const height = runPageDecls<(w: unknown) => number>(['tmUnscrolledTop', 'treemapCanvasHeight'], {
    window: { innerHeight: H },
    getComputedStyle: (el: unknown) => (el === wrap
      ? { paddingTop: `${padTop}px`, paddingBottom: `${pad}px`, borderTopWidth: `${border}px`, borderBottomWidth: `${border}px` }
      : below.styleOf(el) ?? { marginTop: `${footGap}px`, paddingBottom: `${padB}px` }),
  }, 'treemapCanvasHeight')(wrap);
  // Where the footer's last line (the hint) ends, where the room kept for the pill begins, and the page's whole height.
  const footEnd = top + border + padTop + height + pad + border + footGap + footH;
  return { height, footEnd, pillRoom: H - padB, page: footEnd + below.taken + padB };
}

/**
 * A row of a view that sits under its footer — the drive dock, the alternate renderer's note, Disk
 * City's list — as the page lays it out: `h` px tall when shown, nothing when `hidden`, with the top
 * margin the stylesheet gives `sel`. A <details> counts by its summary while it is open (`openH`, the
 * whole disclosure's height then).
 */
type RowBelow = { sel: string; h: number; shown: boolean; openH?: number };

/** The stylesheet's top margin for `sel` (margin-top, or the first side of a margin shorthand), 0 when it has none. */
function marginTopOf(sel: string): number {
  const d = declsFor(sel);
  const v = d.get('margin-top') ?? d.get('margin');
  return v === undefined ? 0 : sheetPx(v, `${sel}'s top margin`);
}

/** `rows` chained as next siblings, with each one's computed style, and the room the shown ones take on the page. */
function rowsBelow(rows: RowBelow[]) {
  const styles = new Map<unknown, { marginTop: string }>();
  let first: unknown = null;
  let taken = 0;
  for (const r of [...rows].reverse()) {
    const summary = { getBoundingClientRect: () => ({ height: r.h }) };
    const el = {
      tagName: r.openH === undefined ? 'DIV' : 'DETAILS', open: r.openH !== undefined,
      getClientRects: () => (r.shown ? [{}] : []),
      getBoundingClientRect: () => ({ height: r.openH ?? r.h }),
      querySelector: (q: string) => (q === 'summary' ? summary : null),
      nextElementSibling: first,
    };
    styles.set(el, { marginTop: `${marginTopOf(r.sel)}px` });
    first = el;
    if (r.shown) taken += marginTopOf(r.sel) + r.h; // an open disclosure takes its summary's place here; the rest is read below the fold
  }
  return { first, taken, styleOf: (el: unknown) => styles.get(el) };
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

test('in "Preview after" at the desktop window\'s minimum the page fits the window and the cart pill covers nothing — the time-lapse bar steps aside while the map previews (QA fourth pass D12)', () => {
  // QA fourth pass D12 (shots/052): 1024×700, the preview pane open (a 402 px
  // map), two scans (the time-lapse bar), "Preview after" on, the cart
  // collapsed. The toolbar on four rows and the bar on three (105 px and its
  // margin) start the map's card at y 293, the banner on nine lines pads it
  // by 196 (176 and its insets), and the hint takes two lines (a 69 px
  // footer). The map sat at its 96 px floor and the page was 753 px tall:
  // unscrolled, the pill covered the status line and the hint's ⌥/⌘ line.
  // And every state of this window ran 2 px long (702/700): the card's own
  // border was never taken off the map.
  const H = 700, top = 293, banner = 176 + 2 * 10, footH = 69, bar = 105;
  // The bar is not the preview's: the preview is of the live map, and a
  // scrub would draw history under a banner about the cart.
  const root = markupTree();
  const [view] = selectAll(root, '#view-treemap');
  assert.ok(view.children.some((c) => c.id === 'tmTimebar') && view.children.some((c) => c.id === 'treemapWrap'),
    'control: the bar and the map\'s card are both children of the Treemap view');
  const hides = RULES.filter((r) => r.selectors.some((sel) => /^#view-treemap:has\(> ?#treemapWrap\.previewing\) > ?#tmTimebar$/.test(sel)));
  const hidden = hides.some((r) => /(^|;)\s*display:\s*none\s*(;|$)/.test(r.body));
  // The page marks the card .previewing exactly while the preview is up.
  const marks: boolean[] = [];
  const sync = runPageDecls<() => void>(['TM_PREVIEW_BANNER_INSET', 'syncCartPreviewChrome'], {
    $: (id: string) => ({
      cartPreview: { setAttribute() {}, classList: { toggle() {} } },
      treemapWrap: { classList: { toggle: (c: string, on: boolean) => { if (c === 'previewing') marks.push(on); } }, style: { removeProperty() {} } },
      tmPreviewBanner: { hidden: true }, tmPreviewText: { innerHTML: '' },
    } as Record<string, unknown>)[id] ?? null,
    tmPreview: { on: true, freedBytes: 3.2e9, outsideView: 0 }, formatBytes: String, formatCount: String, escapeHtml: String,
    cartSpaceSaid: () => '', tmPreviewPadSync() {}, tmPreviewWatch() {},
  }, 'syncCartPreviewChrome');
  sync();
  assert.deepEqual(marks, [true], 'control: the card is marked .previewing while the preview is up');
  const barBlock = bar + sheetPx(declsFor('.tm-timebar').get('margin-bottom'), "the bar's bottom margin");
  const m = mapWithCart(H, hidden ? top - barBlock : top, footH, banner);
  assert.ok(hidden, 'the stylesheet takes the time-lapse bar away while the map\'s card is .previewing');
  assert.ok(m.footEnd <= m.pillRoom, `the hint ends at y ${m.footEnd} under a ${m.height} px map; the room kept for the pill starts at y ${m.pillRoom}`);
  assert.ok(m.page <= H, `the page is ${m.page} px tall in the ${H} px window`);
  assert.ok(m.height > 96, `and the map is above its floor (${m.height} px)`);
  // Control: with the bar up, nothing the map can give makes this window fit.
  const up = mapWithCart(H, top, footH, banner);
  assert.equal(up.height, 96, 'control: with the bar up the map is at its floor');
  assert.ok(up.page > H, `control: and the page still runs ${up.page - H} px past the window`);
});

/* ══════════════ H52 — the key's ends never wrap, and the open cart leaves the banner and the map their room ══════════════ */

test('the size key\'s end labels, "1 MB" and "10 GB+", never wrap — the key may wrap, its ends do not (sixth browser pass H52a)', () => {
  const host = { innerHTML: '' };
  const render = runPageDecls<() => void>(['renderTmLegend'], {
    $: (id: string) => (id === 'tmLegend' ? host : null),
    state: { treemap: { history: { active: false }, colorMode: 'size' } },
    sizeRampCss: () => 'linear-gradient(red, blue)', tmMarksKey: () => '',
  }, 'renderTmLegend');
  render();
  const ends = [...host.innerHTML.matchAll(/<span class="([^"]*)">([^<]*)<\/span>/g)];
  assert.deepEqual(ends.map((m) => m[2]), ['1 MB', '10 GB+'], 'control: the two end labels of the size key');
  for (const [, cls, text] of ends) {
    const rule = declsFor(`.tm-legend .${cls}`);
    assert.equal(rule.get('white-space'), 'nowrap', `"${text}" is held to one line (.tm-legend .${cls})`);
  }
  // The reclaim key's note is a sentence and must still wrap: the rule names the ends alone.
  assert.notEqual(declsFor('.tm-legend > span').get('white-space'), 'nowrap', 'no rule holds every span in the key to one line');
});

/** Average glyph width of the banner's 12.5 px type, as a share of its size — calibrated on QA's reading of B/shots/062: 290 characters on 12 lines in a 320 px banner. */
const BANNER_CHAR_EM = 0.53;

/**
 * The "Preview after" banner's lines and height at 1024 px with the cart open, from the text the
 * page writes and the parts of it the stylesheet shows beside the open cart.
 */
function bannerBesideCart(spaceSaid: string): { lines: number; height: number; text: string; perLine: number; heightFor(lines: number): number } {
  const els: Record<string, { innerHTML: string; hidden?: boolean; classList?: unknown; style?: unknown; setAttribute?: unknown }> = {
    cartPreview: { innerHTML: '', setAttribute() {}, classList: { toggle() {} } },
    treemapWrap: { innerHTML: '', classList: { toggle() {} }, style: { removeProperty() {} } },
    tmPreviewBanner: { innerHTML: '', hidden: true }, tmPreviewText: { innerHTML: '' },
  };
  runPageDecls<() => void>(['TM_PREVIEW_BANNER_INSET', 'syncCartPreviewChrome'], {
    $: (id: string) => els[id] ?? null,
    tmPreview: { on: true, freedBytes: 3.2e9, outsideView: 0 }, formatBytes: () => '3.2 GB', formatCount: String, escapeHtml: String,
    cartSpaceSaid: () => spaceSaid, tmPreviewPadSync() {}, tmPreviewWatch() {},
  }, 'syncCartPreviewChrome')();
  let html = els.tmPreviewText.innerHTML;
  // What the stylesheet hides in the banner while the cart is open.
  for (const r of RULES) {
    for (const sel of r.selectors) {
      const m = /^body\.cart-open \.tm-preview-banner \.([\w-]+)$/.exec(sel);
      if (m && /(^|;)\s*display:\s*none\s*(;|$)/.test(r.body)) html = html.replace(new RegExp(`<span class="${m[1]}">[\\s\\S]*?</span>`, 'g'), '');
    }
  }
  const text = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const banner = declsFor('.tm-preview-banner');
  const font = sheetPx(banner.get('font-size'), 'the banner\'s type');
  const [padY, padX] = (banner.get('padding') || '').split(/\s+/).map((v) => sheetPx(v, 'the banner\'s padding'));
  const gap = sheetPx(banner.get('gap'), 'the banner\'s gap');
  const lineH = font * Number(declsFor('.tm-preview-banner #tmPreviewText').get('line-height'));
  // 1024 px, sidebar open, no pane: the map's column, and the banner's room beside the open cart.
  const map = 1024 - (232 + 12) - 2 * 24;
  const maxW = cssPx(declsFor('body.cart-open .tm-preview-banner').get('max-width')!.replace(/(\d+(?:\.\d+)?)%/g, (_m, n: string) => `${(Number(n) / 100) * map}px`), map);
  const exitW = 'Exit preview'.length * font * BANNER_CHAR_EM + 2 * 12; // the pill's label and its padding
  const column = maxW - 2 * padX - 2 - 15 - gap - exitW - gap; // borders, the icon, and the button beside the message
  const perLine = Math.floor(column / (font * BANNER_CHAR_EM));
  const lines = Math.ceil(text.length / perLine);
  const heightFor = (n: number): number => n * lineH + 2 * padY + 2; // its lines, its padding and its border
  return { lines, height: heightFor(lines), text, perLine, heightFor };
}

test('in "Preview after" at 1024 px with the cart open, the banner keeps to a few lines and the map keeps a usable height — the sentence the open cart says beside it is not said twice (sixth browser pass H52b)', () => {
  const said = 'Up to that much space comes back, but only when you empty the Trash. The Undo Vault also keeps a copy so you can undo this, and that copy takes up space until the Undo Vault removes it.';
  // The premise: the open cart's footer already says this (cartFootTotal ends with cartSpaceSaid()).
  assert.match(pageBetween('function renderCart(', 'function cartSpaceSaid('), /cartFootTotal[\s\S]*?cartSpaceSaid\(\)/, 'the open cart says when its space comes back');
  const b = bannerBesideCart(said);
  assert.doesNotMatch(b.text, /comes back|Undo Vault/, 'beside the open cart the banner does not say it again');
  assert.match(b.text, /^Preview — nothing has been deleted\. The hatched areas are the 3\.2 GB this cart stages for the Trash\.$/, 'and still says what the preview is');
  assert.ok(b.lines <= 5, `the banner takes ${b.lines} lines (QA: 12)`);
  // QA's scene (B/shots/062): 1024×768, the map's card starting at about y 100, a one-line key and status.
  const m = mapWithCart(768, 100, 40, b.height + 2 * 10);
  assert.ok(m.height >= 330, `the map keeps ${m.height} px under a ${b.height.toFixed(0)} px banner (QA: about 245)`);
  // Control: the whole text, as it was, on the same column, is the banner QA saw — about 12 lines,
  // and about 245 px of map. QA saw it before the rename (20 Oct 2026), under the old name.
  const saidThen = said.replaceAll('Undo Vault', 'Time Capsule');
  const whole = `Preview — nothing has been deleted. The hatched areas are the 3.2 GB this cart stages for the Trash. ${saidThen}`;
  const wholeLines = Math.ceil(whole.length / b.perLine);
  assert.ok(wholeLines >= 10 && wholeLines <= 14, `control: the old banner measures ${wholeLines} lines here, as QA's 12`);
  const before = mapWithCart(768, 100, 40, b.heightFor(wholeLines) + 2 * 10);
  assert.ok(before.height >= 215 && before.height <= 275, `control: under the old banner the map measures ${before.height} px here, as QA's about 245`);
});

/* ══════════════ F06 — the drive dock is counted when the map and Disk City are fitted ══════════════ */

/** The drive dock with one drive, measured in the QA's windows (fifth browser pass F06): 961/900 and 761/700 against 900 and 700. */
const DOCK_H = 61;
/** The alternate renderer's note on one line: 11.5 px type at 1.5 line height (.tm-altnote). */
const ALT_NOTE_H = 18;

test('with a drive connected the drive dock under the map is counted when the map is fitted to the window — at 1440×900 and 1024×700, "Preview after" and the alternate renderers\' note included, and the cart pill never covers the hint (fifth browser pass F06)', () => {
  // QA fifth pass F06: the Treemap was 961/900 with the dock and 900/900 without; 1024×700 (and
  // Preview after) 761/700 against 700/700; the 61 px are the dock's. treemapCanvasHeight measured
  // the footer and nothing under it.
  const [tmView] = selectAll(markupTree(), '#view-treemap');
  assert.ok(['tmDock', 'tmAltNote'].every((id) => tmView.children.some((c) => c.id === id)),
    'control: the dock and the alternate renderers\' note are rows of the Treemap view');
  const dock = (shown: boolean): RowBelow => ({ sel: '.drive-dock', h: DOCK_H, shown });
  const note = (shown: boolean): RowBelow => ({ sel: '.tm-altnote', h: ALT_NOTE_H, shown });
  const barBlock = 105 + sheetPx(declsFor('.tm-timebar').get('margin-bottom'), "the bar's bottom margin");
  const cases: Array<[string, number, number, number, number | undefined]> = [
    // label, window height, the card's top, footer height, preview pad (shots of F06 and of the D12 checks above)
    ['1440×900', 900, 150, 17, undefined],
    ['1024×700, the toolbar on two rows', 700, 250, 40, undefined],
    ['1024×700, Reclaim colour', 700, 250, 76, undefined],
    ['1024×700, preview pane, "Preview after", the time slider stepped aside', 700, 293 - barBlock, 69, 196],
  ];
  for (const [label, H, top, footH, previewPad] of cases) {
    // "Preview after" previews the rectangle map only (enterCartPreview refuses the other three), but
    // the rectangle map writes the same note row: the 20,000-item cap's (QA D58), which a preview keeps
    // (review F1.5 of F06). That state is the floor case, below.
    const states: Array<[string, RowBelow[]]> = [['the dock', [dock(true), note(false)]]];
    if (previewPad === undefined) {
      states.push(['the dock and a note under the map', [dock(true), note(true)]], ['the note alone', [dock(false), note(true)]]);
    }
    if (previewPad !== undefined) {
      // D12's floor case: with the preview pane, "Preview after" and a drive, the map is already at its
      // 96 px floor (two rows of labelled cells), so a capped map's note is the one row the page cannot
      // make room for. The hint stays where it was, above the room kept for the pill; the page runs past
      // the window by that row alone, read by scrolling.
      const capped = mapWithCart(H, top, footH, previewPad, [dock(true), note(true)]);
      const noteRoom = marginTopOf('.tm-altnote') + ALT_NOTE_H;
      assert.ok(capped.footEnd <= capped.pillRoom, `${label}, the dock and the cap's note: the hint ends at y ${capped.footEnd}; the room kept for the pill starts at y ${capped.pillRoom}`);
      assert.ok(capped.page <= H + noteRoom, `${label}, the dock and the cap's note: the page (${capped.page} px) runs past the ${H} px window by the note's ${noteRoom} px at most`);
      assert.equal(capped.height, 96, `${label}, the dock and the cap's note: the map is at its floor`);
    }
    for (const [what, rows] of states) {
      const m = mapWithCart(H, top, footH, previewPad, rows);
      assert.ok(m.page <= H, `${label}, ${what}: the page is ${m.page} px tall in the ${H} px window`);
      assert.ok(m.footEnd <= m.pillRoom, `${label}, ${what}: the hint ends at y ${m.footEnd}; the room kept for the pill starts at y ${m.pillRoom}`);
      assert.ok(m.height >= 96, `${label}, ${what}: and the map keeps its floor (${m.height} px)`);
    }
    // A row that is hidden takes no room: without a drive the map is as tall as it always was.
    assert.equal(mapWithCart(H, top, footH, previewPad, [dock(false), note(false)]).height, mapWithCart(H, top, footH, previewPad).height,
      `${label}: control — with the dock and the note hidden, the map is the height it was`);
  }
});

test('the map is fitted again when the drive dock appears or goes (fifth browser pass F06)', () => {
  const rows = /const TM_CHROME_ROWS = \[([^\]]*)\];/.exec(INDEX);
  const list = [...rows![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(list.includes('#tmDock'), `#tmDock is watched (${list.join(', ')})`);
  // The page's own tmRefitMap over a dock that a drive's arrival shows and its removal hides.
  let shown = false;
  const draws: string[] = [];
  const dockEl = { getClientRects: () => (shown ? [{}] : []), getBoundingClientRect: () => ({ height: DOCK_H }), nextElementSibling: null };
  const foot = { getBoundingClientRect: () => ({ height: 17 }), nextElementSibling: dockEl };
  const wrap = { getBoundingClientRect: () => ({ top: 150 }), parentElement: { querySelector: () => foot }, closest: () => ({}) };
  const tmCanvas = { style: { height: '' } };
  const fns = runPageDecls<{ tmRefitMap(): void; treemapCanvasHeight(w: unknown): number }>(['tmUnscrolledTop', 'treemapCanvasHeight', 'tmRefitMap'], {
    $: (id: string) => (id === 'treemapWrap' ? wrap : null),
    state: { view: 'treemap', treemap: { rootPath: '/c' } },
    tmCanvas,
    window: { innerHeight: 900 },
    getComputedStyle: (el: unknown) => (el === wrap ? { paddingTop: '10px', paddingBottom: '10px' } : el === dockEl ? { marginTop: '0px' } : { marginTop: '12px', paddingBottom: '48px' }),
    drawView: () => { draws.push('draw'); tmCanvas.style.height = fns.treemapCanvasHeight(wrap) + 'px'; },
    isCells: () => false,
  }, '{ tmRefitMap, treemapCanvasHeight }');
  tmCanvas.style.height = fns.treemapCanvasHeight(wrap) + 'px'; // drawn with no drive
  const without = tmCanvas.style.height;
  shown = true; // a drive connected: renderDock shows the dock
  fns.tmRefitMap();
  assert.deepEqual(draws, ['draw'], 'the dock appearing redraws the map');
  assert.equal(parseFloat(without) - parseFloat(tmCanvas.style.height), DOCK_H, 'shorter by the dock');
  fns.tmRefitMap();
  assert.deepEqual(draws, ['draw'], 'and only once');
  shown = false; // the drive ejected
  fns.tmRefitMap();
  assert.deepEqual(draws, ['draw', 'draw'], 'the dock going gives the map its room back');
  assert.equal(tmCanvas.style.height, without);
});

/* ══════════════ F06 review F1.1 — the alternate renderers' note settles once, and never feeds the layout back ══════════════ */

/** The alternate renderers' note: a line is 11.5 px type at 1.5 (.tm-altnote), and this many characters fill one in the map's width. */
const NOTE_LINE_H = 17.25;
const NOTE_LINE_CHARS = 100;

/**
 * A Circles or Voronoi map drawn by the page's own drawView, drawCells, buildCells, refinement loop,
 * tmSizeCanvas, treemapCanvasHeight, tmRefitMap and tmCellsSettle, under the drive-less footer and the
 * note the layout writes (#tmAltNote: as many lines as its text needs, nothing while hidden). The
 * solver takes `slices` slices — "still laying out" until its last — and settles on `finalNote(cssH)`
 * for the height it was given. A ResizeObserver watches the rows the page's TM_CHROME_ROWS names that
 * are here (the note), and calls tmRefitMap at the end of a frame in which one changed height, as the
 * browser does. `frames(n)`: n frames of 16 ms — timers due, then the animation frames asked for
 * before it, then the observer. `solves`: full layouts begun (a slice resumed is not one).
 */
function altNoteWorld(finalNote: (cssH: number) => string, slices = 3) {
  const w = { now: 0, solves: 0 };
  const timers = new Map<number, { at: number; fn: () => void }>();
  let tid = 0;
  let animation: Array<() => void> = [];
  const note = {
    id: 'tmAltNote', tagName: 'DIV', hidden: true, textContent: '', nextElementSibling: null,
    getClientRects() { return note.hidden ? [] : [{}]; },
    getBoundingClientRect: () => ({ height: note.hidden ? 0 : Math.ceil(note.textContent.length / NOTE_LINE_CHARS) * NOTE_LINE_H }),
  };
  const foot = { getBoundingClientRect: () => ({ height: 17 }), nextElementSibling: note };
  const wrap = { clientWidth: 1220, getBoundingClientRect: () => ({ top: 150 }), parentElement: { querySelector: () => foot }, closest: () => ({}) };
  const tmCanvas = { style: { height: '', width: '' }, width: 0, height: 0 };
  const solve = (_root: unknown, geo: { cssH: number }, resume?: { slice: number }) => {
    const slice = resume ? resume.slice : 0;
    if (!resume) w.solves++;
    const done = slice === slices - 1;
    return { cells: [], done, resume: { slice: slice + 1 }, note: done ? finalNote(geo.cssH) : '' };
  };
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  const state = {
    view: 'treemap',
    treemap: { rootPath: '/c', mode: 'voronoi', colorMode: 'size', cells: [], altNote: '', altMs: 0, altRaf: 0, altZoomRaf: 0, altZoom: null },
  };
  const optional = ['altNoteRefitDue', 'altNoteRefitting', 'altNoteSettled'].filter((name) => INDEX.includes(`let ${name} = `) || INDEX.includes(`function ${name}(`));
  const fns = runPageDecls<{
    drawView(): void; tmRefitMap(): void; treemapCanvasHeight(el: unknown): number; rows: string[]; altRefineCancel(): void; renderAltNote(): void;
  }>([
    'isSun', 'isCells', 'drawView', 'tmUnscrolledTop', 'treemapCanvasHeight', 'TM_CHROME_ROWS', 'tmRefitMap', 'tmResizeDeb', 'tmCellsSettle', 'tmSizeCanvas',
    'renderAltNote', 'altRefineSeq', 'altRefiningNote', 'altRefineCancel', 'altRefineSchedule', 'buildCells', 'drawCells', ...optional,
  ], {
    $: (id: string) => (id === 'treemapWrap' ? wrap : id === 'tmAltNote' ? note : null),
    state, tmCanvas, tmBuffer: { width: 0, height: 0 }, tmBufCtx: ctx,
    window: { innerHeight: 900, devicePixelRatio: 1 },
    document: { hidden: false },
    getComputedStyle: (el: unknown) => (el === wrap ? { paddingTop: '10px', paddingBottom: '10px' }
      : el === note ? { marginTop: '6px' } : { marginTop: '12px', paddingBottom: '48px' }),
    setTimeout: (fn: () => void, ms: number) => { timers.set(++tid, { at: w.now + ms, fn }); return tid; },
    clearTimeout: (id: number) => { timers.delete(id); },
    requestAnimationFrame: (fn: () => void) => { animation.push(fn); return animation.length; },
    cancelAnimationFrame: () => {},
    performance: { now: () => w.now },
    sunburstRoot: () => ({ path: '/c' }), layoutVoronoi: solve, layoutCirclePack: solve,
    formatCount: String, cssVar: () => '#000',
    fxShapeSync() {}, repaintCells() {}, drawPackedCircle() {}, drawVoronoiCell() {}, altDrawLabels() {},
    renderSearchOverlay() {}, renderCellsStatus() {}, presentCells() {}, renderTmLegend() {}, fetchScoresForTreemap() {},
    drawTreemap() {}, drawSunburst() {},
  }, '{ drawView, tmRefitMap, treemapCanvasHeight, rows: TM_CHROME_ROWS, altRefineCancel, renderAltNote }');
  const observed = fns.rows.includes('#tmAltNote') ? [note] : [];
  const seen = new Map(observed.map((el) => [el, el.getBoundingClientRect().height]));
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) {
      w.now += 16;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= w.now).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].fn();
      }
      const asked = animation;
      animation = [];
      for (const fn of asked) fn();
      let moved = false;
      for (const el of observed) {
        const h = el.getBoundingClientRect().height;
        if (h !== seen.get(el)) { seen.set(el, h); moved = true; }
      }
      if (moved) fns.tmRefitMap();
    }
  };
  /** The map is the height the window leaves it under the note now on screen. */
  const fitted = () => tmCanvas.style.height === `${fns.treemapCanvasHeight(wrap)}px`;
  /** What setTreemapView does on a renderer switch, before it draws: the refinement and its note let go. */
  const switchTo = (mode: string) => {
    state.treemap.mode = mode;
    fns.altRefineCancel();
    state.treemap.altNote = '';
    fns.renderAltNote();
  };
  return { w, note, frames, fitted, switchTo, drawView: fns.drawView };
}

test('a Circles or Voronoi layout that settles on a note of another height is fitted to it with one more solve, and never re-solves for ever (review F1.1 of fifth browser pass F06)', () => {
  // Review F1.1: F06 counted the note in the map's height and watched it. A layout over several
  // slices writes "still laying out" (one line), then its own last word — nothing, or two lines in a
  // narrow window — and each change of height re-solved the whole layout, which wrote "still laying
  // out" again: 61 full Voronoi solves in 9.6 s, the map's height jumping by the note's each time.
  const twoLines = 'x'.repeat(170);
  const oneLine = 'x'.repeat(60);
  const cases: Array<[string, (cssH: number) => string, number, number]> = [
    // label, the note the layout settles on, slices, the solves it takes to fit
    ['a layout that leaves nothing out (its note goes)', () => '', 3, 1],
    ['a note that wraps to two lines', () => twoLines, 3, 2],
    ['a one-line note, where none was before', () => oneLine, 3, 2],
    ['a layout finished in its first slice, with a two-line note', () => twoLines, 1, 2],
  ];
  for (const [label, finalNote, slices, solves] of cases) {
    const m = altNoteWorld(finalNote, slices);
    m.drawView();
    m.frames(600); // 9.6 s with the view up
    assert.equal(m.w.solves, solves, `${label}: ${m.w.solves} full solves in 9.6 s`);
    assert.ok(m.fitted(), `${label}: and the map is fitted to the note it settled on`);
    assert.equal(m.note.hidden, finalNote(0) === '', `${label}: control — the note shown is the layout's last word`);
  }
  // A drill-in to a map whose note differs from the one on screen: its draw, and one solve to fit.
  let next = twoLines;
  const drill = altNoteWorld(() => next);
  drill.drawView(); drill.frames(600);
  assert.ok(drill.fitted() && drill.w.solves === 2, 'control: the first map settled under its two-line note');
  next = '';
  drill.drawView(); drill.frames(600);
  assert.equal(drill.w.solves - 2, 2, 'a drill-in to a map with no note: its draw and one refit');
  assert.ok(drill.fitted(), 'and the map is fitted to the note gone');
  // A refit owed to a layout the person switched away from is not spent on the next layout.
  const sw = altNoteWorld(() => twoLines);
  sw.drawView();
  sw.frames(3); // the layout settles on its two-line note, and its refit waits out its 160 ms
  sw.switchTo('treemap'); // the Treemap, before the refit runs
  sw.frames(20);
  sw.switchTo('voronoi'); // and back
  sw.drawView();
  sw.frames(600);
  assert.ok(sw.fitted(), 'switched away and back, the new layout is fitted to its own note');
});

test('a note whose height follows the map\'s own height stands after the one refit — the layout is never solved back and forth (review F1.1 of fifth browser pass F06)', () => {
  // A note can depend on the height it was solved for: more is too small to draw in a shorter map. One
  // that is three lines in the taller map and nothing in the shorter one would move the map between
  // the two for ever if every settled note were fitted to.
  const flip = altNoteWorld((cssH) => (cssH > 600 ? 'x'.repeat(250) : ''));
  flip.drawView();
  flip.frames(600);
  assert.equal(flip.w.solves, 2, `the refit's own note stands: ${flip.w.solves} full solves in 9.6 s`);
});

test('the rectangle map writes its note before it measures, so one draw fits it (review F1.1 of fifth browser pass F06)', () => {
  // The note is no longer watched (the alternate renderers' answer fed back into their layout), so a
  // draw measured under the note it is about to write would leave the page that much past the window.
  const note = {
    tagName: 'DIV', hidden: true, textContent: '', nextElementSibling: null,
    getClientRects() { return note.hidden ? [] : [{}]; },
    getBoundingClientRect: () => ({ height: note.hidden ? 0 : Math.ceil(note.textContent.length / NOTE_LINE_CHARS) * NOTE_LINE_H }),
  };
  const foot = { getBoundingClientRect: () => ({ height: 17 }), nextElementSibling: note };
  const wrap = { clientWidth: 1220, getBoundingClientRect: () => ({ top: 150 }), parentElement: { querySelector: () => foot }, closest: () => ({}) };
  const tmCanvas = { style: { height: '', width: '' }, width: 0, height: 0 };
  const capNote = 'The map holds at most 20,000 items, and this folder reached that: 3.1 GB has no rectangle here — drill in, or open the Grid view, to see the rest.';
  const fns = runPageDecls<{ drawTreemap(): void; treemapCanvasHeight(el: unknown): number }>(['tmUnscrolledTop', 'treemapCanvasHeight', 'renderAltNote', 'drawTreemap'], {
    $: (id: string) => (id === 'treemapWrap' ? wrap : id === 'tmAltNote' ? note : null),
    state: { treemap: { nodes: [], hideCloud: false, rootSize: 0, altNote: '' } },
    tmCanvas, tmBuffer: { width: 0, height: 0 }, tmBufCtx: new Proxy({}, { get: () => () => {}, set: () => true }),
    window: { innerHeight: 900, devicePixelRatio: 1 },
    getComputedStyle: (el: unknown) => (el === wrap ? { paddingTop: '10px', paddingBottom: '10px' }
      : el === note ? { marginTop: '6px' } : { marginTop: '12px', paddingBottom: '48px' }),
    cssVar: () => '#000', tmNodeCapNote: () => capNote, formatBytes: (n: number) => `${n} B`,
    tmSetEmpty() {}, renderSearchOverlay() {}, presentTreemap() {}, renderTmLegend() {},
  }, '{ drawTreemap, treemapCanvasHeight }');
  fns.drawTreemap();
  assert.equal(note.hidden, false, 'control: the map at the cap says so under it');
  assert.equal(tmCanvas.style.height, `${fns.treemapCanvasHeight(wrap)}px`, 'and the map is fitted under that note by the draw that wrote it');
});

/**
 * The page's cityFitHeight in a window `H` px tall, Disk City's card starting `top` px down, its
 * footer `footH` px, the rows under it, while the cart holds something. Returns the height it gives
 * the card (border-box, as the page's `* { box-sizing: border-box }` has it) and where the page ends.
 */
function cityWithRows(H: number, top: number, footH: number, rows: RowBelow[], view = 'city') {
  const border = sheetPx(declsFor('#cityWrap').get('border'), "the city card's border");
  const footGap = sheetPx(declsFor('.tm-foot').get('margin-top'), "the footer's top margin");
  const padB = sheetPx(declsFor('body:has(#cartDock.show) main').get('padding-bottom'), 'the room <main> keeps for the cart pill');
  const below = rowsBelow(rows);
  const foot = { getBoundingClientRect: () => ({ height: footH }), nextElementSibling: below.first };
  const wrap = {
    style: { height: '' },
    getBoundingClientRect: () => ({ top }),
    parentElement: { querySelector: (q: string) => (q === '.tm-foot' ? foot : null) },
    closest: () => ({}),
  };
  const invalidated: number[] = [];
  const fns = runPageDecls<{ cityFitHeight(): boolean; cityRefit(): void }>(['tmUnscrolledTop', 'treemapCanvasHeight', 'CITY_CARD_MAX_PX', 'cityFitHeight', 'cityRefit'], {
    $: (id: string) => (id === 'cityWrap' ? wrap : null),
    state: { view },
    window: { innerHeight: H },
    cityInvalidate: () => { invalidated.push(1); },
    getComputedStyle: (el: unknown) => (el === wrap
      ? { paddingTop: '0px', paddingBottom: '0px', borderTopWidth: `${border}px`, borderBottomWidth: `${border}px` }
      : below.styleOf(el) ?? { marginTop: `${footGap}px`, paddingBottom: `${padB}px` }),
  }, '{ cityFitHeight, cityRefit }');
  fns.cityRefit();
  const card = parseFloat(wrap.style.height);
  const footEnd = top + card + footGap + footH;
  return { card, styled: wrap.style.height, footEnd, pillRoom: H - padB, page: footEnd + below.taken + padB, redraws: () => invalidated.length, fns, wrap };
}

test('Disk City is fitted to the window as the map is — its footer, the drive dock, its list\'s summary and the pill\'s room counted — at 1440×900 and 1024×700 (fifth browser pass F06)', () => {
  // QA fifth pass F06: Disk City at 1440×900 was 975/900 with the dock. Its height was the stylesheet's
  // clamp(360px, 100vh - 250px, 1100px): a guess at the rows above and below, which the dock beat.
  const [cityView] = selectAll(markupTree(), '#view-city');
  assert.ok(['cityDock', 'cityTableWrap'].every((id) => cityView.children.some((c) => c.id === id)),
    'control: the dock and the list are rows of the Disk City view');
  const dock = (shown: boolean): RowBelow => ({ sel: '.drive-dock', h: DOCK_H, shown });
  const list = (openH?: number): RowBelow => ({ sel: '.city-table', h: 29, shown: true, openH });
  for (const [label, H, top, footH] of [['1440×900', 900, 150, 17], ['1024×700, the toolbar on two rows', 700, 220, 40]] as Array<[string, number, number, number]>) {
    for (const [what, rows] of [['with the dock', [dock(true), list()]], ['without a drive', [dock(false), list()]]] as Array<[string, RowBelow[]]>) {
      const c = cityWithRows(H, top, footH, rows);
      assert.ok(c.page <= H, `${label}, ${what}: the page is ${c.page} px tall in the ${H} px window (a ${c.card} px city)`);
      assert.ok(c.page >= H - 1, `${label}, ${what}: and the city takes the room there is (the page ends at ${c.page})`);
      assert.ok(c.footEnd <= c.pillRoom, `${label}, ${what}: the hint ends at y ${c.footEnd}; the room kept for the pill starts at y ${c.pillRoom}`);
      assert.equal(c.redraws(), 1, `${label}, ${what}: a city fitted to a new height is redrawn`);
    }
    // Opened, the list is read below the fold: the city does not shrink to make room for it.
    assert.equal(cityWithRows(H, top, footH, [dock(true), list(4000)]).card, cityWithRows(H, top, footH, [dock(true), list()]).card,
      `${label}: opening the list of buildings leaves the city its height`);
  }
  const tall = cityWithRows(2400, 150, 17, [dock(false), list()]);
  assert.equal(tall.card, 1100, 'a very tall window keeps the stylesheet\'s 1100 px ceiling');
  const again = cityWithRows(900, 150, 17, [dock(true), list()]);
  again.fns.cityRefit();
  assert.equal(again.redraws(), 1, 'a fit that changes nothing redraws nothing');
  const hidden = cityWithRows(900, 0, 17, [dock(true), list()]);
  assert.deepEqual([hidden.styled, hidden.redraws()], ['', 0], 'a city not laid out (a hidden view) keeps the stylesheet\'s height');
  const elsewhere = cityWithRows(900, 150, 17, [dock(true), list()], 'treemap');
  assert.deepEqual([elsewhere.styled, elsewhere.redraws()], ['', 0], 'nor is it fitted while another view is up');
});

test('Disk City is fitted again when the drive dock appears or goes, and on every visit and window resize (fifth browser pass F06)', () => {
  const rows = /const CITY_CHROME_ROWS = \[([^\]]*)\];/.exec(INDEX);
  assert.ok(rows, 'the rows around the city are listed');
  const list = [...rows![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const sel of ['#view-city .tm-toolbar', '#view-city .tm-foot', '#cityDock', '#cartDock']) {
    assert.ok(list.includes(sel), `${sel} is watched (${list.join(', ')})`);
  }
  const wiring = INDEX.slice(rows!.index, rows!.index + 400);
  assert.match(wiring, /new ResizeObserver\(\(\) => cityRefit\(\)\)/, 'a change of size refits the city');
  assert.match(wiring, /for \(const sel of CITY_CHROME_ROWS\)[^}]*\.observe\(/, 'and every listed row is observed');
  // The dock arriving: the page's cityRefit over a dock renderDock shows.
  let shown = false;
  const dockEl = { getClientRects: () => (shown ? [{}] : []), getBoundingClientRect: () => ({ height: DOCK_H }), nextElementSibling: null };
  const foot = { getBoundingClientRect: () => ({ height: 17 }), nextElementSibling: dockEl };
  const wrap = { style: { height: '' }, getBoundingClientRect: () => ({ top: 150 }), parentElement: { querySelector: () => foot }, closest: () => ({}) };
  let redraws = 0;
  const fns = runPageDecls<{ cityRefit(): void; cityOnResize(): void }>(['tmUnscrolledTop', 'treemapCanvasHeight', 'CITY_CARD_MAX_PX', 'cityFitHeight', 'cityRefit', 'cityOnResize'], {
    $: (id: string) => (id === 'cityWrap' ? wrap : null), state: { view: 'city' }, window: { innerHeight: 900 },
    cityInvalidate: () => { redraws++; },
    getComputedStyle: (el: unknown) => (el === wrap ? { paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '1px', borderBottomWidth: '1px' }
      : el === dockEl ? { marginTop: '0px' } : { marginTop: '12px', paddingBottom: '76px' }),
  }, '{ cityRefit, cityOnResize }');
  fns.cityRefit();
  const without = parseFloat(wrap.style.height);
  shown = true;
  fns.cityRefit();
  assert.equal(without - parseFloat(wrap.style.height), DOCK_H, 'the dock appearing takes its height off the city');
  assert.equal(redraws, 2, 'and the city is redrawn at it');
  shown = false;
  fns.cityOnResize();
  assert.equal(parseFloat(wrap.style.height), without, 'a window resize fits it too: the dock gone, the room is back');
  // A visit fits the city before it is first drawn.
  const mount = INDEX.slice(INDEX.indexOf('  mount() {\n    refreshDock(); // §8.3 — the dock sits under this canvas too'));
  const body = mount.slice(0, mount.indexOf('\n  },'));
  assert.ok(body.includes('cityFitHeight();') && body.indexOf('cityFitHeight();') < body.indexOf('citySetHeight('),
    'mount() fits the city before its first draw');
});

test('a map or Disk City fitted while <main> is scrolled is fitted as it is unscrolled — a view entered under a scrolled Dashboard, or refitted with its list read below the fold, still fits the window (review F1.8 of fifth browser pass F06)', () => {
  // Review F1.8: <main> is the page's one scroller and nothing resets it on a view switch. The fit read
  // the card's top from the window: under a Dashboard scrolled down, Disk City's first fit (the page
  // 75 px past the window, clamping the scroll to 75) came out 75 px too tall and kept the page at
  // 975/900 — and a card scrolled above the window was not fitted at all.
  /** A card whose box starts `rectTop` px down the window and is `box` px tall (0: not laid out), <main> scrolled `scrollTop`. */
  const card = (rectTop: number, scrollTop: number, box = 500) => {
    const foot = { getBoundingClientRect: () => ({ height: 17 }), nextElementSibling: null };
    const main = { scrollTop };
    return {
      style: { height: '' },
      getBoundingClientRect: () => ({ top: rectTop, height: box }),
      parentElement: { querySelector: (q: string) => (q === '.tm-foot' ? foot : null) },
      closest: (q: string) => (q === 'main' ? main : null),
    };
  };
  const style = (wrap: unknown) => (el: unknown) => (el === wrap
    ? { paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '1px', borderBottomWidth: '1px' }
    : { marginTop: '12px', paddingBottom: '76px' });
  const mapHeight = (rectTop: number, scrollTop: number, box?: number) => {
    const wrap = card(rectTop, scrollTop, box);
    return runPageDecls<(w: unknown) => number>(['tmUnscrolledTop', 'treemapCanvasHeight'], { window: { innerHeight: 900 }, getComputedStyle: style(wrap) }, 'treemapCanvasHeight')(wrap);
  };
  const cityHeight = (rectTop: number, scrollTop: number, box?: number) => {
    const wrap = card(rectTop, scrollTop, box);
    runPageDecls<() => boolean>(['tmUnscrolledTop', 'treemapCanvasHeight', 'CITY_CARD_MAX_PX', 'cityFitHeight'], {
      $: (id: string) => (id === 'cityWrap' ? wrap : null), window: { innerHeight: 900 }, getComputedStyle: style(wrap),
    }, 'cityFitHeight')();
    return wrap.style.height;
  };
  const map = mapHeight(150, 0);
  const city = cityHeight(150, 0);
  assert.ok(map > 96 && city !== '', `control: unscrolled, the map is ${map} px and the city ${city}`);
  for (const s of [75, 150, 400]) {
    // Scrolled s px, the card's box starts s px higher in the window (above it, past 150).
    assert.equal(mapHeight(150 - s, s), map, `<main> scrolled ${s} px: the map is the height it is unscrolled`);
    assert.equal(cityHeight(150 - s, s), city, `<main> scrolled ${s} px: Disk City is the height it is unscrolled`);
  }
  // A view not laid out has no box: it keeps its fallback whatever <main>'s scroll, never a fit from the scroll alone.
  assert.equal(mapHeight(0, 300, 0), 420, 'a hidden map keeps its fallback height');
  assert.equal(cityHeight(0, 300, 0), '', 'a hidden city keeps the stylesheet\'s height');
});

test('the sunburst fits the map the page leaves it, down to the map\'s floor — its disc is never cut by the top or bottom of a short map (review F1.3, F3.3)', () => {
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
  const fits = (cssW: number, cssH: number) => {
    const g = geometry(cssW, cssH);
    const label = `a ${cssW}×${cssH} map`;
    // The disc and the 2 px outline drawn round a hovered or keyboard-picked arc.
    assert.ok(g.cy - g.outerR - 1 >= 0 && g.cy + g.outerR + 1 <= cssH && g.cx - g.outerR - 1 >= 0 && g.cx + g.outerR + 1 <= cssW,
      `${label}: the sunburst spans y ${(g.cy - g.outerR).toFixed(1)}–${(g.cy + g.outerR).toFixed(1)}, x ${(g.cx - g.outerR).toFixed(1)}–${(g.cx + g.outerR).toFixed(1)}, and its outline a pixel more`);
    return { g, label, half: Math.min(cssW, cssH) / 2 };
  };
  for (const cssW of [402, 1100]) {
    for (const cssH of [floor, d12, 100, 119, 120, 127, 128, 140, 156, 200, 360, 600]) {
      const { g, label, half } = fits(cssW, cssH);
      if (half - 18 >= 60) assert.equal(g.outerR, half - 18, `${label}: a map with room draws the disc it always did`);
      else assert.ok(g.outerR >= Math.min(60, half - 6), `${label}: a short map's disc takes its height but a few pixels (radius ${g.outerR}, the map's half ${half})`);
    }
  }
  // Every map with room for a disc keeps the fit, not only those down to the
  // floor (review F3.3): each short side from 10 px — half 5, the first past
  // the 4 px a map needs before it draws one — to 94, either way round, takes
  // its half less 4 px. Shorter maps keep 60 px (the F2.1 test below).
  for (let side = 10; side <= 94; side++) {
    for (const [cssW, cssH] of [[1100, side], [side, 600]]) {
      const { g, label, half } = fits(cssW, cssH);
      assert.equal(g.outerR, half - 4, `${label}: a map whose short side is under the floor takes its half less 4 px (radius ${g.outerR}, the map's half ${half})`);
    }
  }
});

test('a sunburst drawn while its view is hidden draws harmlessly off-screen — it never throws over the view on screen, and a map too small for a disc keeps a positive one (review F2.1, F3.3)', () => {
  // A sunburst load can land after the user has switched to another view: a
  // pruned folder's subtree is fetched, the user moves on, and the load draws
  // anyway. #treemapWrap is then 0 px wide (tmSizeCanvas: -20) and the map
  // 420 px (treemapCanvasHeight's fallback for a view not laid out). The fit
  // for short maps (review F1.3) gave that a radius of -14, a canvas's arc()
  // throws on a negative radius, and "Treemap failed: … The radius provided
  // (-14) is negative" came up over the other view.
  const hiddenH = runPageDecls<(wrap: unknown) => number>(['tmUnscrolledTop', 'treemapCanvasHeight'], {
    window: { innerHeight: 900 },
    getComputedStyle: () => assert.fail('a map that is not laid out is not measured'),
  }, 'treemapCanvasHeight')({ getBoundingClientRect: () => ({ top: 0 }) });
  assert.equal(hiddenH, 420, 'control: a hidden map is 420 px tall, treemapCanvasHeight\'s fallback');
  const file = (dir: string, name: string, size: number) => ({ name, path: `${dir}/${name}`, size, type: 'file' });
  const a = { name: 'Movies', path: '/r/Movies', size: 60, type: 'dir', children: [file('/r/Movies', 'a.mov', 40), file('/r/Movies', 'b.mov', 20)] };
  const root = { name: 'r', path: '/r', size: 100, type: 'dir', children: [a, file('/r', 'c.zip', 40)] };
  // And either side of where the page stops drawing one (review F3.3): a map
  // whose half is 4 px or less (4 and 8 px wide) keeps the old 60 px; one a
  // half-pixel wider (9 px) takes the fit, a radius small but positive.
  for (const cssW of [0 - 20, 0, 4, 8, 9]) {
    const label = cssW < 0 ? 'its view hidden (a 0 px wrap)' : cssW === 0 ? 'a wrap no wider than its padding' : `a map ${cssW} px wide`;
    const radii: number[] = [];
    // A 2D context that refuses a negative radius, as a canvas does.
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) => (k in t ? t[k] : k === 'arc'
        ? (_x: number, _y: number, r: number) => { radii.push(r); if (r < 0) throw new RangeError(`IndexSizeError: The radius provided (${r}) is negative.`); }
        : () => {}),
      set: (t, k: string, v) => { t[k] = v; return true; },
    });
    const state = { root, pathIndex: new Map([[root.path, root]]),
      treemap: { maxDepth: 7, hideCloud: false, rootPath: '/r', history: { active: false }, arcs: [] as unknown[], sun: null as null | { outerR: number; innerR0: number } } };
    const draw = runPageDecls<() => void>(
      ['sunRingCount', 'sunburstGeometry', 'sunburstRoot', 'layoutSunburstArcs', 'SUN_LABEL_MIN_CHARS', 'sunFitLabel', 'sectorPath', 'renderSunburstFrame', 'drawSunburst'], {
        state, tmBufCtx: ctx, tmSizeCanvas: () => ({ cssW, cssH: hiddenH, dpr: 2 }),
        cssVar: () => '#000', cellRgb: () => [10, 20, 30], mix: (c: number[]) => c, Canvas2D: { fitText: (_c: unknown, t: string) => t },
        formatBytes: String, formatCount: String, formatWhen: String, $: () => null, presentSunburst() {}, renderTmLegend() {},
      }, 'drawSunburst');
    assert.doesNotThrow(draw, `${label}: the sunburst draws`);
    assert.ok(radii.length > 0, `control (${label}): the draw reached the canvas`);
    const sun = state.treemap.sun!;
    assert.ok(sun.outerR > 0 && sun.innerR0 > 0 && Math.min(...radii) > 0,
      `${label}: every ring has a positive radius — outer ${sun.outerR}, centre ${sun.innerR0}, smallest drawn ${Math.min(...radii)}`);
    const half: number = Math.min(cssW, hiddenH) / 2;
    if (half <= 4) assert.equal(sun.outerR, 60, `${label}: a map with no room for a disc keeps the old 60 px radius (its half ${half})`);
    else assert.equal(sun.outerR, half - 4, `${label}: a map with room for any disc takes the fit, its half less 4 px (its half ${half})`);
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
  fns = runPageDecls<Fns>(['isCells', 'isSun', 'drawView', 'tmUnscrolledTop', 'treemapCanvasHeight', 'tmRefitMap'], {
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
      // The note's refit (review F1.1 of F06) is altNoteWorld's to test.
      altNoteRefitDue: false, altNoteSettled() {},
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
  return fragmentTree(INDEX.slice(INDEX.indexOf('<body')).replace(/<script[\s\S]*?<\/script>/g, ''));
}

/**
 * Markup — the page's, or a fragment a page function wrote — as a tree the
 * fake selector reads. `content`, when given, gets each element's children
 * and text runs in order (see textOf).
 */
function fragmentTree(markup: string, content?: Map<SelectorNode, Array<SelectorNode | string>>): SelectorNode {
  const html = markup.replace(/<!--[\s\S]*?-->/g, '');
  const root: SelectorNode = { tagName: 'root', id: '', cls: new Set(), attrs: {}, parent: null, children: [] };
  let cur = root;
  const put = (el: SelectorNode, c: SelectorNode | string) => { if (content) content.set(el, [...(content.get(el) || []), c]); };
  let last = 0;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
    const text = html.slice(last, m.index);
    last = m.index! + m[0].length;
    if (text) put(cur, text);
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
    put(cur, el);
    if (!VOID_TAGS.has(tag)) cur = el;
  }
  if (html.slice(last)) put(cur, html.slice(last));
  return root;
}

/** An element's text as a reader sees it: its runs and its children's, in order, entities decoded, white space collapsed. */
function textOf(el: SelectorNode, content: Map<SelectorNode, Array<SelectorNode | string>>): string {
  const raw = (content.get(el) || []).map((c) => (typeof c === 'string' ? c : textOf(c, content))).join('');
  return raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
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
  const checked: string[] = [], shrinks: string[] = [];
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
    // A pair in a strip narrower than its longest option (Compare's list of
    // scans runs to 430 px; the toolbar beside the open pane at 1024 px is
    // 402) gives up the CONTROL's width, never the label's (review F1.8).
    // A flex item's automatic minimum is its content, the select's longest
    // option, so the pair and its select each need min-width 0, and the pair
    // is held to its row.
    if (!item.cls.has('label-pair')) continue; // the treemap's Depth group never shrinks (flex: none) and holds two-digit options
    const pair = sheetFor(root, item), sel = sheetFor(root, control!), lab = sheetFor(root, label);
    assert.ok(flexShrink(pair) > 0, `${where}: the pair shrinks in a narrow row (flex: ${pair.get('flex') ?? 'unset'})`);
    assert.equal(pair.get('min-width'), '0', `${where}: below its content's width — the select's longest option`);
    assert.equal(pair.get('max-width'), '100%', `${where}: and is never wider than the row it sits on`);
    assert.equal(sel.get('min-width'), '0', `${where}: inside it, the select gives up width below its longest option`);
    assert.equal(flexShrink(lab), 0, `${where}: and the label none (flex: ${lab.get('flex') ?? 'unset'})`);
    shrinks.push(id);
  }
  for (const id of ['gridSort', 'cmpA', 'cmpB', 'trendRoot', 'dupMinSize', 'ndThreshold', 'tmDepth']) {
    assert.ok(checked.includes(id), `#${id}'s label was found in its wrapping toolbar and checked (checked: ${checked.join(', ')})`);
  }
  for (const id of ['gridSort', 'cmpA', 'cmpB', 'trendRoot', 'dupMinSize', 'ndThreshold']) {
    assert.ok(shrinks.includes(id), `#${id} sits in a label pair that was held to giving up the select's width (held: ${shrinks.join(', ')})`);
  }
});

/** The flex-shrink a rule set gives an item: `flex-shrink`, else the `flex` shorthand's (`none` 0, `auto` and unset 1, a lone number 1). */
function flexShrink(d: Map<string, string>): number {
  if (d.has('flex-shrink')) return Number(d.get('flex-shrink'));
  const f = (d.get('flex') || '').trim();
  if (f === 'none') return 0;
  const parts = f.split(/\s+/);
  return parts.length > 1 && /^\d/.test(parts[1]) ? Number(parts[1]) : 1;
}

/* ══════════════ E14c — at 1024 px nothing in the treemap's chrome is left alone or cut mid-word ══════════════ */

test('the time-lapse bar wraps its playback options as one — "Diff" never starts a row alone, at any width (QA fourth pass E14c)', () => {
  // QA fourth pass E14c (shots/L1024-treemap): at 1024 px the bar's content
  // box is 696 px. Measured there: the clock 14, Play 28, the scrubber's
  // 140 px floor, the label's 25ch floor 195, the speed seg 164, Loop 52 and
  // Diff 46, 10 px apart. Everything but Diff fit row one (699 > 696), so
  // "Diff" sat on a second row of its own.
  const MEASURED: Record<string, number> = { clock: 14, tmLapsePlay: 28, tmTimeSlider: 140, tmTimeLabel: 195, tmLapseSpeed: 164, tmLapseLoop: 52, tmDiffToggle: 46 };
  const root = markupTree();
  const [bar] = selectAll(root, '#tmTimebar');
  assert.ok(bar, '#tmTimebar is in the page');
  const barCss = sheetFor(root, bar);
  assert.equal(barCss.get('flex-wrap'), 'wrap', 'control: the bar wraps when it is tight');
  const colGap = (d: Map<string, string>) => { const g = (d.get('gap') || '0px').trim().split(/\s+/); return sheetPx(g[g.length - 1], 'a column gap'); };
  const gap = colGap(barCss);
  /** The measured controls an element is or holds, in order. */
  const controls = (el: SelectorNode): string[] => {
    if (el.attrs['data-icon'] === 'clock') return ['clock'];
    if (el.id in MEASURED) return [el.id];
    return el.children.flatMap(controls);
  };
  // The bar's flex items: a control, or an element that lays several out in a row that never wraps.
  const items = bar.children.map((el) => {
    const held = controls(el);
    if (held.length <= 1) return { held, w: held.length ? MEASURED[held[0]] : 0 };
    const css = sheetFor(root, el);
    assert.match(css.get('display') || '', /^(inline-)?flex$/, `the item holding ${held.join(', ')} lays them out in a row`);
    assert.notEqual(css.get('flex-wrap'), 'wrap', `and keeps them on one line (${held.join(', ')})`);
    assert.equal(flexShrink(css), 0, `and never squeezes them (${held.join(', ')})`);
    return { held, w: held.reduce((s, id) => s + MEASURED[id], 0) + (held.length - 1) * colGap(css) };
  }).filter((it) => it.held.length);
  assert.deepEqual(items.flatMap((it) => it.held), Object.keys(MEASURED), 'control: every measured control is in the bar, in order');
  /** The rows a wrapping flex line breaks the items into, in a content box `room` px wide. */
  const rows = (its: Array<{ held: string[]; w: number }>, room: number) => {
    const out: Array<{ held: string[]; w: number }> = [];
    for (const it of its) {
      const last = out[out.length - 1];
      if (last && last.w + gap + it.w <= room) { last.held.push(...it.held); last.w += gap + it.w; } else out.push({ held: [...it.held], w: it.w });
    }
    return out;
  };
  // Control: the QA's own geometry, its items each on their own, puts Diff alone on row two.
  const asShipped = rows(Object.entries(MEASURED).map(([id, w]) => ({ held: [id], w })), 696);
  assert.deepEqual(asShipped.map((r) => r.held), [['clock', 'tmLapsePlay', 'tmTimeSlider', 'tmTimeLabel', 'tmLapseSpeed', 'tmLapseLoop'], ['tmDiffToggle']],
    'control: with every control an item of its own, the measured bar leaves "Diff" alone on its own row');
  // The bar spans the map's column: 402 px beside the open pane in the 1024 px window, up to a wide one.
  const pad = sheetPx((barCss.get('padding') || '').split(/\s+/)[1], "the bar's side padding");
  let checked = 0;
  for (let column = 402; column <= 1700; column++) {
    const room = column - 2 * pad - 2; // its padding, and the glass card's 1 px border a side
    for (const row of rows(items, room)) {
      assert.ok(row.w <= room, `${column} px column: a row of ${row.held.join(', ')} is ${row.w} px in ${room}`);
      if (row.held.includes('tmDiffToggle')) {
        assert.ok(row.held.includes('tmLapseLoop') && row.held.includes('tmLapseSpeed'),
          `${column} px column: "Diff" shares its row with Loop and the speed (${row.held.join(', ')})`);
      }
    }
    checked++;
  }
  assert.equal(checked, 1299, 'every column width from 402 px was checked');
});

test('the Highlight box shows a whole placeholder at every width — never one cut mid-word to "(try size>1g" (QA fourth pass E14c)', () => {
  // QA fourth pass E14c: at 1024 px the field is 187 px and its text room
  // 141 px; "Highlight… (try size>1gb)" needs ~165 at 13 px (6.6 px a
  // character, as B01 measured), so it read "Highlight… (try size>1g", which
  // looks like "1gl". Beside the open preview pane the field is at its 140 px
  // floor, 94 px of room.
  const PER_CHAR = 6.6;
  const root = markupTree();
  const [input] = selectAll(root, '#tmSearch');
  assert.ok(input, '#tmSearch is in the page');
  const css = sheetFor(root, input);
  const width = css.get('width')!;
  const padL = sheetPx(css.get('padding-left'), "the field's left padding (its icon)");
  const padR = sheetPx((css.get('padding') || '').split(/\s+/)[1], "the field's right padding");
  const border = sheetPx(css.get('border'), "the field's border");
  const markupPh = (input.attrs.placeholder || '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  const roomAt = (toolbar: number) => cssPx(width, toolbar) - 2 * border - padL - padR;
  // Before any measurement — the first paint, a hidden view — the markup's own placeholder shows.
  assert.ok(markupPh.length * PER_CHAR <= roomAt(402), `the markup's "${markupPh}" fits the narrowest field's ${roomAt(402).toFixed(0)} px`);
  const box = { clientWidth: 0, placeholder: markupPh };
  // The fit runs when the field is resized, as the page's own wiring after
  // it asks, and measures in the font set on its canvas: a canvas starts at
  // 10 px sans-serif, ~25% narrower than the field's 13 px, so a measure
  // left in it picks "(try size>1gb)" where it is cut (review F1.4).
  const fitAt = INDEX.indexOf('function tmSearchPlaceholderFit(');
  const wiring = pageBetween('function tmSearchPlaceholderFit(', '// One delegate on the panel').slice(INDEX.indexOf('\n}\n', fitAt) + 3 - fitAt);
  const observed: Array<{ cb: (entries: unknown[]) => void; el: unknown }> = [];
  class FakeResizeObserver {
    cb: (entries: unknown[]) => void;
    constructor(cb: (entries: unknown[]) => void) { this.cb = cb; }
    observe(el: unknown) { observed.push({ cb: this.cb, el }); }
  }
  const FIELD_FONT = '500 13px system-ui';
  const ctx = {
    font: '10px sans-serif', // a canvas's own
    measureText: (s: string) => ({ width: s.length * PER_CHAR * (Number(/([\d.]+)px/.exec(ctx.font)![1]) / 13) }),
  };
  const page = runPageDecls<{ forms: string[] }>(['TM_SEARCH_PLACEHOLDERS', 'tmSearchMeasure', 'tmSearchPlaceholderFit'], {
    $: (id: string) => (id === 'tmSearch' ? box : { id }),
    getComputedStyle: () => ({ paddingLeft: `${padL}px`, paddingRight: `${padR}px`, font: FIELD_FONT }),
    document: { createElement: (tag: string) => { assert.equal(tag, 'canvas'); return { getContext: () => ctx }; } },
    ResizeObserver: FakeResizeObserver,
  }, '{ forms: TM_SEARCH_PLACEHOLDERS }', wiring);
  assert.ok(page.forms.includes(markupPh), 'and is one of the forms the page picks from');
  assert.equal(observed.filter((o) => o.el === box).length, 1, 'the page watches the Highlight box for resizes');
  /** The field resized: what the page's observer is handed. */
  const resize = () => { for (const o of observed) if (o.el === box) o.cb([{ target: box }]); };
  let checked = 0;
  for (let toolbar = 402; toolbar <= 1700; toolbar++) {
    const room = roomAt(toolbar);
    box.clientWidth = room + padL + padR;
    resize();
    assert.equal(ctx.font, FIELD_FONT, `${toolbar} px toolbar: measured in the field's own font`);
    assert.ok(page.forms.includes(box.placeholder), `${toolbar} px toolbar: "${box.placeholder}" is a whole placeholder`);
    assert.ok(box.placeholder.length * PER_CHAR <= room, `${toolbar} px toolbar: "${box.placeholder}" (${(box.placeholder.length * PER_CHAR).toFixed(0)} px) fits its ${room.toFixed(0)} px`);
    const longer = page.forms.slice(0, page.forms.indexOf(box.placeholder));
    for (const f of longer) assert.ok(f.length * PER_CHAR > room, `${toolbar} px toolbar: the longer "${f}" would have fitted, and "${box.placeholder}" was shown`);
    checked++;
  }
  assert.equal(checked, 1299, 'every toolbar width from 402 px was checked');
  box.clientWidth = cssPx(width, 720) - 2 * border;
  resize();
  assert.match(box.placeholder, /size>1gb/, `at the QA's 1024 px window (a 720 px toolbar) the example still shows: "${box.placeholder}"`);
  box.clientWidth = 0; // a hidden view: nothing to measure, so nothing changes
  const before = box.placeholder;
  resize();
  assert.equal(box.placeholder, before, 'a field that is not laid out keeps its placeholder');
});

/* ══════════════ E03 — a Smart Suggestion's description and remedy are drawn inside the Clean Up sheet ══════════════ */

/** Every Smart Suggestion group the shipped rule packs can produce, on every OS, shaped as the server serves it (cleanupRules.ts). */
function shippedSmartGroups(): Array<Record<string, unknown>> {
  const dir = path.join(__dirname, '..', 'src', 'services', 'rulepacks');
  const byId = new Map<string, Record<string, unknown>>();
  for (const pack of ['common', 'macos', 'windows', 'linux']) {
    const rules = (JSON.parse(readFileSync(path.join(dir, `${pack}.json`), 'utf8')) as { rules: Array<Record<string, unknown>> }).rules;
    for (const r of rules) {
      if (r.kind === 'package-cache' || byId.has(`${pack}:${String(r.id)}`)) continue; // a shared cache is never a Smart group (§C6)
      byId.set(`${pack}:${String(r.id)}`, {
        id: r.id, title: r.title, description: r.description, category: r.category, confidence: r.confidence,
        regenerateCmd: r.restoreCommand, why: 'Matched by name.', advisory: r.action === 'advice' ? true : undefined, adviceCommand: r.adviceCommand,
        totalSize: 12_345_678_901,
        items: [{ name: 'Render Files', path: '/Users/me/Movies/Vacation.fcpbundle/Day 1/Render Files', size: 12_345_678_901, type: 'dir', modifiedAt: 1 }],
      });
    }
  }
  return [...byId.values()];
}

/**
 * What every remedy in the shipped packs is, as the sheet must show it: the
 * parts that are commands, in order — each in a code pill — and nothing else
 * in one. A menu path or a sentence is text. A remedy not listed here fails
 * the test until someone says what it is.
 */
const REMEDY_CODE: Record<string, string[]> = {
  'npm install': ['npm install'],
  'python3 -m venv <folder>, then reinstall the packages it held': ['python3 -m venv <folder>'],
  'automatic on next run': [],
  'cargo build': ['cargo build'],
  'mvn package': ['mvn package'],
  'gradle build': ['gradle build'],
  'pod install': ['pod install'],
  'npm run build': ['npm run build'],
  'Lightroom Classic ▸ Edit ▸ Catalog Settings ▸ File Handling ▸ Automatically Discard 1:1 Previews': [],
  'Lightroom Classic ▸ Library ▸ Previews ▸ Build Smart Previews': [],
  'Capture One ▸ Image ▸ Regenerate Previews': [],
  'sudo apt-get clean   ·   sudo paccache -r   ·   sudo dnf clean all': ['sudo apt-get clean', 'sudo paccache -r', 'sudo dnf clean all'],
  'sudo journalctl --vacuum-size=200M': ['sudo journalctl --vacuum-size=200M'],
  'flatpak uninstall --unused   ·   sudo snap set system refresh.retain=2': ['flatpak uninstall --unused', 'sudo snap set system refresh.retain=2'],
  'Xcode ▸ Window ▸ Organizer ▸ Archives': [],
  'docker system prune -a --volumes': ['docker system prune -a --volumes'],
  'Quit Photos first — it rebuilds these automatically the next time it opens': [],
  'Re-rendered automatically when the project is next played or exported': [],
  'Final Cut Pro ▸ File ▸ Delete Generated Library Files': [],
  'Settings ▸ System ▸ Storage ▸ Temporary files': [],
  'docker system prune -a --volumes, then wsl --shutdown': ['docker system prune -a --volumes', 'wsl --shutdown'],
};

/** The page's renderSmartGroups over `groups`: the markup it writes. */
function smartGroupsHtml(groups: Array<Record<string, unknown>>): string {
  const host = { innerHTML: '', querySelectorAll: () => [] as unknown[] };
  const esc = (v: unknown) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const names = ['confidenceWording', 'catalogNote', 'smartItemsOf', 'renderSmartGroups'];
  // The remedy helpers the page may have, lifted with it when it does.
  for (const helper of ['REMEDY_PROSE_WORDS', 'remedyIsCommand', 'remedyHtml']) {
    if (INDEX.includes(`function ${helper}(`) || INDEX.includes(`const ${helper} = `)) names.unshift(helper);
  }
  const render = runPageDecls<(catalog: unknown) => void>(names, {
    $: (id: string) => { assert.equal(id, 'smartResults'); return host; },
    smartGroups: groups, smartSort: 'size', icon: () => '<svg class="ic"></svg>', escapeHtml: esc,
    sizeInk: () => '#888', formatBytes: (n: number) => `${(n / 1e6).toFixed(1)} MB`, formatDate: () => 'Oct 2, 2026', chipFor: () => '<span class="chip"></span>',
    reclaimBadge: () => '', scoreFor: () => null, cartButtonHtml: () => '<button class="icon-btn"></button>', refreshCartButtons() {}, updateCleanSummary() {},
    byReclaimDesc: () => () => 0, ensureScores: async () => {}, toast() {}, RECLAIM_BATCH: 2000,
  }, 'renderSmartGroups');
  render(null);
  return host.innerHTML;
}

test('a Smart Suggestion\'s description and its remedy are drawn inside the Clean Up sheet, wrapping as they need — never squeezed to nothing or run past its edge (QA fourth pass E03)', () => {
  // QA fourth pass E03 (shots/041, 1440×900): "Final Cut / iMovie render
  // files" — an advisory group, whose advice is the ONLY thing a person can
  // do with it (AGENTS.md) — drew its header 1,201 px wide in a 586 px box:
  // the advice ended at x 1,431 with the sheet's edge at 1,050, and the
  // descriptions of four groups were squeezed to 0–27 px. Each remedy was a
  // code pill that would not shrink or wrap, in the same row as the title.
  // The sheet is 660 px at 1024 and 1440 alike, so a group's content box is
  // 586 px at both (measured).
  const BOX = 586;
  const CHAR = { title: 8.2, text: 7.0, code: 6.7, label: 6.8 }; // px a character: 13.5 px bold, 12.5 px, 11 px mono, 12 px
  const groups = shippedSmartGroups();
  assert.ok(groups.length >= 20 && groups.some((g) => g.advisory), `control: ${groups.length} groups from the shipped packs, advisory ones among them`);
  for (const g of groups) {
    const content = new Map<SelectorNode, Array<SelectorNode | string>>();
    const tree = fragmentTree(smartGroupsHtml([g]), content);
    const [group] = selectAll(tree, '.smart-group');
    const [row] = selectAll(tree, '.smart-group .rule-row');
    const label = String(g.title);
    assert.ok(group && row, `${label}: the group and its header row are drawn`);
    // Where the description is drawn: a block of its own under the header, never an item squeezed beside the title.
    const holders = (text: string) => selectAll(group, '*').filter((el) => textOf(el, content) === text.replace(/\s+/g, ' ').trim()
      && !el.children.some((c) => textOf(c, content) === textOf(el, content)));
    const [desc] = holders(String(g.description));
    assert.ok(desc, `${label}: the description is drawn`);
    const inRow = (el: SelectorNode) => { for (let p: SelectorNode | null = el; p; p = p.parent) if (p === row) return true; return false; };
    assert.ok(!inRow(desc), `${label}: the description is not an item of the header row, where the title and the badge squeezed it to nothing`);
    // Every remedy the group has: drawn whole, outside the header row, with commands — and only commands — in code.
    const remedies = [g.adviceCommand, g.regenerateCmd].filter((r): r is string => typeof r === 'string');
    const plain = (t: string) => t.replace(/\s+/g, ' ').trim();
    for (const remedy of remedies) {
      assert.ok(remedy in REMEDY_CODE, `${label}: "${remedy}" is a remedy this test knows — say what it is in REMEDY_CODE`);
      // Said for what it is (review F1.5): an advisory group's advice is the
      // way to reclaim it — its only remedy (AGENTS.md) — and a restore
      // command is how a removed group comes back.
      const what = remedy === g.regenerateCmd ? 'To put it back:' : 'To reclaim:';
      const line = selectAll(group, '.smart-remedy').find((el) => textOf(el, content).endsWith(plain(remedy)));
      assert.ok(line, `${label}: "${remedy}" is drawn whole on a remedy line`);
      assert.equal(textOf(line!, content), `${what} ${plain(remedy)}`, `${label}: the line says what "${remedy}" is for, and nothing else`);
      assert.deepEqual(selectAll(line!, '.rc-lbl').map((el) => textOf(el, content)), [what], `${label}: "${what}" is the line's label`);
      assert.ok(!inRow(line!), `${label}: its remedy is not an item of the header row`);
      const codes = selectAll(line!, 'code').map((c) => textOf(c, content));
      assert.deepEqual(codes, REMEDY_CODE[remedy], `${label}: in "${remedy}", the commands — and nothing else — are code`);
      // The "Why?" panel says it the same way: the commands, and nothing else, in code.
      const whyText = remedy === g.regenerateCmd ? `To put it back: ${plain(remedy)}` : `Do not move this to the Trash. Reclaim it instead: ${plain(remedy)}`;
      const whyLine = selectAll(group, '.smart-why .smart-why-line').find((el) => textOf(el, content) === whyText);
      assert.ok(whyLine, `${label}: the "Why?" panel reads "${whyText}"`);
      assert.deepEqual(selectAll(whyLine!, 'code').map((c) => textOf(c, content)), REMEDY_CODE[remedy],
        `${label}: in the "Why?" panel's "${remedy}", the commands — and nothing else — are code`);
      for (const el of [line!, ...selectAll(line!, '*')]) {
        const css = sheetFor(tree, el);
        assert.ok(!/^(nowrap|pre)$/.test(css.get('white-space') || ''), `${label}: <${el.tagName}.${[...el.cls].join('.')}> in the remedy line wraps (white-space: ${css.get('white-space')})`);
        assert.notEqual(css.get('flex'), 'none', `${label}: and does not hold its width`);
      }
      // A single word wider than the box would still run past it: every word fits.
      for (const word of remedy.split(/\s+/)) assert.ok(word.length * CHAR.code <= BOX, `${label}: "${word}" fits the ${BOX} px box`);
    }
    for (const el of [desc, ...selectAll(desc, '*')]) {
      const css = sheetFor(tree, el);
      assert.ok(!/^(nowrap|pre)$/.test(css.get('white-space') || ''), `${label}: the description wraps (white-space: ${css.get('white-space')})`);
      assert.notEqual(css.get('text-overflow'), 'ellipsis', `${label}: and is not cut to an ellipsis`);
    }
    // The header row is one line that fits: the mark or the checkbox, the title, "Why?" and the size badge.
    const items = row.children.map((el) => {
      const text = textOf(el, content);
      if (el.tagName === 'input') return 22; // 15 px and Chrome's 4 + 3 px margins
      if (el.cls.has('adv-mark')) return 14;
      if (el.cls.has('why-btn')) return 30;
      if (el.cls.has('size-badge')) return text.length * 7.2 + 18;
      return text.length * CHAR.title;
    });
    const used = items.reduce((s, w) => s + w, 0) + (items.length - 1) * 10;
    assert.ok(used <= BOX, `${label}: the header row needs ${used.toFixed(0)} px of the ${BOX} (${row.children.map((c) => c.tagName + '.' + [...c.cls].join('.')).join(', ')})`);
  }
  // Every remedy in the packs was seen, so the table above is the packs' own.
  const seen = new Set(groups.flatMap((g) => [g.adviceCommand, g.regenerateCmd]).filter(Boolean));
  assert.deepEqual([...seen].sort(), Object.keys(REMEDY_CODE).sort(), 'every remedy in the shipped packs is in the table, and nothing else');
});

test('the remedy line and the description are coloured from the theme\'s tokens, so both themes draw them (QA fourth pass E03)', () => {
  for (const sel of ['.smart-desc', '.smart-remedy', '.smart-remedy .rc-lbl', '.smart-menu']) {
    const d = declsFor(sel);
    assert.ok(d.size, `${sel} is styled`);
    for (const prop of ['color', 'background', 'background-color', 'border-color']) {
      const v = d.get(prop);
      if (v !== undefined) assert.match(v, /^var\(--[\w-]+\)$/, `${sel} ${prop} is a theme token (${v})`);
    }
  }
  // The code pill's literal violet has a light-theme counterpart.
  assert.ok(RULES.some((r) => r.selectors.includes(':root[data-theme="light"] .regen-cmd') && /\bcolor:/.test(r.body)), 'the code pill is recoloured for the light theme');
});

/* ══════════════ G26 review F2.5 — the folder picker scrolls one thing at the smallest window ══════════════ */

/*
 * The whole-drive row (G26) put 42 px above the picker's path field, and at
 * the 1024×700 smallest window the sheet meets its 84vh cap: its body grew a
 * scrollbar of its own around the list's 320 px one (G26 review F2.5 — with
 * two rows of folder chips the sheet already ran 17 px over there before it).
 * Where the window holds a list of four rows, the body is a column the list
 * gives way in, so the list is the one thing that scrolls.
 */
test('at the smallest window the folder picker scrolls one thing, its list — the sheet\'s body is a column the list gives way in, never a second scrollbar around it (G26 review F2.5)', () => {
  const px = (v: string | undefined, what: string): number => {
    const m = /^(-?[\d.]+)px$/.exec((v ?? '').trim());
    assert.ok(m, `${what} is in px (${v})`);
    return Number(m![1]);
  };
  const sides = (v: string | undefined, what: string) => (v ?? '').trim().split(/\s+/).map((p) => (p === '0' ? 0 : px(p, what)));
  // The column, under a media query on the window's height.
  const media = /@media \(min-height: (\d+)px\) \{\s*#browseModal \.modal-body \{([^{}]*)\}/.exec(SHEET);
  assert.ok(media, 'the picker\'s body is a column where the window is tall enough for one');
  const body = declsFor('#browseModal .modal-body');
  assert.deepEqual([body.get('display'), body.get('flex-direction')], ['flex', 'column'], 'a column');
  const list = declsFor('.browse-list');
  assert.ok(flexShrink(list) > 0, `the list gives way when the sheet meets its cap (flex: ${list.get('flex') ?? 'unset'})`);
  assert.equal(list.get('overflow-y'), 'auto', 'and scrolls what it cannot show');
  // Margins do not collapse in a column: an empty chips row would add its own
  // 12 px above the list's, where block flow merged the two. It is not drawn.
  assert.equal(declsFor('#browseChips:empty').get('display'), 'none', 'an empty chips row takes no room');

  // The room the list gets, from the sheet's own numbers. The sheet is at most
  // 84vh, less its head (the ✕ is its tallest part) and its foot (a button).
  const vh = Number(/^(\d+)vh$/.exec(declsFor('.modal').get('max-height') ?? '')?.[1]) / 100;
  assert.ok(vh > 0, 'control: the sheet\'s cap is read');
  const head = sides(declsFor('.modal-head').get('padding'), 'the head\'s padding');
  const foot = sides(declsFor('.modal-foot').get('padding'), 'the foot\'s padding');
  const chrome = head[0] + (head[2] ?? head[0]) + px(declsFor('.close-x').get('height'), 'the ✕')
    + foot[0] + (foot[2] ?? foot[0]) + 1 + px(declsFor('.btn').get('min-height'), 'a button');
  // The body above its list: its padding, the whole-drive row, the path field,
  // the hint (its inline 6 px margin over one 12 px line, ~15 px), two rows of
  // folder chips (a home folder's seven do not fit one at 560 px) and the list's
  // margin and border.
  const pill = px(declsFor('.pill').get('min-height'), 'a pill');
  const hint = /id="browseHint" style="font-size:12px;margin-top:(\d+)px;"/.exec(INDEX);
  assert.ok(hint, 'control: the hint\'s spacing is read from the page');
  const fixed = 2 * sides(declsFor('.modal-body').get('padding'), 'the body\'s padding')[0]
    + pill + sides(declsFor('.browse-drives').get('margin'), 'the drive row\'s margin')[2]
    + px(declsFor('input[type="text"]').get('min-height'), 'the path field')
    + Number(hint![1]) + 15
    + px(declsFor('.chips').get('margin-top'), 'the chips\' margin') + 2 * pill + px(declsFor('.chips').get('gap'), 'the chips\' gap')
    + px(list.get('margin-top'), 'the list\'s margin') + 2;
  // A row: 9 px above and below a 13 px line (~16 px), and its rule.
  const row = 2 * 9 + 16 + 1;
  const room = (viewport: number) => vh * viewport - chrome - fixed;
  // The smallest window: 700 px tall (electron/main.js), 672 under its title bar.
  const minHeight = Number(/minHeight: (\d+)/.exec(readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8'))?.[1]);
  assert.equal(minHeight, 700, 'control: the window\'s smallest height is read');
  const threshold = Number(media![1]);
  assert.ok(threshold <= minHeight - 28, `the column holds at the smallest window (${minHeight - 28} px under the title bar ≥ ${threshold})`);
  assert.ok(room(threshold) >= 4 * row + 2, `and wherever it holds, the list keeps four rows: ${room(threshold).toFixed(0)} px at ${threshold} px`);
  assert.ok(room(minHeight - 28) >= 6 * row + 2, `at the smallest window, six: ${room(minHeight - 28).toFixed(0)} px`);
});
