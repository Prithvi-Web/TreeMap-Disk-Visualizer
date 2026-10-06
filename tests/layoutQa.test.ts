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

/* ══════════════ B13 — emptying the cart hands focus back, never to <body> ══════════════ */

/** Several page declarations (functions, or `const x = …;`) in one scope, run with `deps`. */
function runPageDecls<T>(names: string[], deps: Record<string, unknown>, returns: string): T {
  const parts = names.map((name) => {
    let start = INDEX.indexOf(`function ${name}(`);
    if (INDEX.lastIndexOf('async ', start) === start - 6) start -= 6;
    if (start < 0) {
      const at = INDEX.indexOf(`const ${name} = `);
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
  return new Function(...keys, `'use strict';\n${parts.join('\n')}\nreturn ${returns};`)(...keys.map((k) => deps[k])) as T;
}

type CartEl = {
  id: string; cls: Set<string>; parent: CartEl | null; connected: boolean; disabled?: boolean;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean; toggle(c: string, on?: boolean): void };
  contains(n: unknown): boolean; focus(opts?: unknown): void; getClientRects(): unknown[]; readonly isConnected: boolean;
};

/** Lets the page's awaited repaint run out (microtasks only — nothing is timed). */
async function settled() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

/** The cart dock and a view beside it: what focus can land on, and whether it is painted. */
function cartWorld() {
  const focus: { active: CartEl | null } = { active: null };
  const make = (id: string, parent: CartEl | null): CartEl => {
    const el: CartEl = {
      id, cls: new Set(), parent, connected: true,
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
    };
    return el;
  };
  const body = make('body', null);
  const dock = make('cartDock', body);
  const els: Record<string, CartEl> = { cartDock: dock };
  els.cartPanel = make('cartPanel', dock);
  els.cartClear = make('cartClear', els.cartPanel);
  els.cartCollapse = make('cartCollapse', els.cartPanel);
  els.cartTab = make('cartTab', dock);
  const view = make('view-treemap', body);
  els.viewFirst = make('tmUpBtn', view);
  els.opener = make('addToCartBtn', view);
  const state = { cart: new Set(['/c/a', '/c/b']) };
  const document = {
    body,
    get activeElement() { return focus.active ?? body; },
    querySelectorAll: (sel: string) => (/\.view\.active/.test(sel) ? [els.viewFirst, els.opener] : []),
  };
  const fns = runPageDecls<{
    cartClear(): void; cartDockToggle(open?: boolean, o?: { focus?: boolean }): void; cartNoteFocusIn(e: { relatedTarget: unknown }): void;
  }>(['cartFocus', 'cartNoteFocusIn', 'cartFocusReturn', 'cartDockToggle', 'cartClear'], {
    $: (id: string) => els[id], document, state,
    requestAnimationFrame: (f: () => void) => { f(); return 1; },
    CART_PAGE: 200, cartShown: 200,
    saveCart() {}, refreshCartButtons() {}, cartPreviewInvalidated() {},
    // renderCart's part in this: an empty cart hides the dock and closes the drawer.
    renderCart: async () => {
      await null;
      dock.classList.toggle('show', state.cart.size > 0);
      if (state.cart.size === 0) fns.cartDockToggle(false);
    },
  }, '{ cartClear, cartDockToggle, cartNoteFocusIn }');
  dock.classList.add('show');
  fns.cartDockToggle(true);
  return { els, focus, state, fns, body };
}

test('Clear in the cart hands focus back to where it came from, never to <body> (B13)', async () => {
  // QA: Clear emptied the cart, the panel and the pill disappeared, and focus
  // landed on <body>. The tab the drawer normally returns to is hidden with it.
  const w = cartWorld();
  w.fns.cartNoteFocusIn({ relatedTarget: w.els.opener }); // tabbed into the dock from the view
  w.fns.cartNoteFocusIn({ relatedTarget: w.els.cartTab }); // then moved around inside it
  w.els.cartClear.focus();
  assert.equal(w.focus.active, w.els.cartClear, 'focus is on Clear');
  w.fns.cartClear(); await settled();
  assert.equal(w.state.cart.size, 0, 'the cart is empty');
  assert.ok(!w.els.cartDock.cls.has('show'), 'and the dock is hidden, tab and all');
  assert.equal(w.focus.active, w.els.opener, 'focus is back on the control it came from');
});

test('with the control it came from gone, an emptied cart hands focus to the view on screen (B13)', async () => {
  const w = cartWorld();
  w.fns.cartNoteFocusIn({ relatedTarget: w.els.opener });
  w.els.cartClear.focus();
  w.els.opener.connected = false; // the row it came from was re-rendered away
  w.fns.cartClear(); await settled();
  assert.equal(w.focus.active, w.els.viewFirst, 'the first control of the view on screen');
});

test('collapsing a cart that still holds items returns focus to its tab, and a Clear made from outside moves no focus (B13)', async () => {
  const w = cartWorld();
  w.fns.cartNoteFocusIn({ relatedTarget: w.els.opener });
  w.els.cartCollapse.focus();
  w.fns.cartDockToggle(false);
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
