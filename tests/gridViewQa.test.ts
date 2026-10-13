import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { selectAll } from './fixtures/fakeSelector';

/**
 * Grid view and the cards that share its file (QA D43, D44, D02, D21) and the
 * shared Move-to-Trash sheet's total.
 *
 * The whole Grid section of the built page is lifted and RUN against a stub
 * DOM — its own top-level wiring included — so these tests drive the real
 * entry points (renderGrid, a tile click, Up, the filter box) and survive a
 * refactor of the helpers behind them.
 *
 *  - D43: Up was enabled at the scan root and did nothing; tiles under 64 px
 *    had no name and tiles under 84 px no size ("Extensions" showed neither
 *    figure); the folder-count badge sat in the corner the centred icon
 *    reaches.
 *  - D44: the filter outlived the folder it was typed for — "Fonts" found the
 *    Fonts folder, and opening it said 'No files match "Fonts"'.
 *  - D02: the selection bar slid off-screen with nothing selected but stayed
 *    focusable and in the accessibility tree ("Move to Trash" included).
 *  - D21: the Cost card told a free plan "clearing … keeps you on the same
 *    plan" — a plan that costs nothing has no plan to keep you on.
 *  - confirmTrash's "(X total)" counted a folder and a file inside it twice.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function slice(a: string, b: string): string {
  const i = INDEX.indexOf(a);
  assert.notEqual(i, -1, `anchor "${a}" exists`);
  const j = INDEX.indexOf(b, i + a.length);
  assert.notEqual(j, -1, `anchor "${b}" follows`);
  return INDEX.slice(i, j);
}

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

const SHEET = INDEX.slice(INDEX.indexOf('<style>') + 7, INDEX.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, ' ');
function declsOf(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of SHEET.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sels = m[1].trim().split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (!sels.includes(selector)) continue;
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i !== -1) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
  }
  return out;
}
function px(v: string | undefined, what: string): number {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec((v || '').trim());
  assert.ok(m, `${what} is a px length (got ${v})`);
  return Number(m![1]);
}

/* ══════════════ the Grid section, lifted ══════════════ */

type Node = { name: string; path: string; size: number; type: 'file' | 'dir'; children?: Node[]; modifiedAt?: number; extension?: string };
type FakeEl = {
  id: string; tagName: string; parent: FakeEl | null; value: string; disabled: boolean; hidden: boolean; innerHTML: string; className: string;
  tabIndex: number; dataset: Record<string, string>; style: Record<string, string> & { cssText?: string };
  attrs: Record<string, string>; cls: Set<string>; children: FakeEl[]; listeners: Record<string, ((e: unknown) => void)[]>;
  clientWidth: number; clientHeight: number; scrollTop: number;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean; toggle(c: string, on?: boolean): void };
  setAttribute(k: string, v: string): void; addEventListener(t: string, f: (e: unknown) => void): void;
  appendChild(c: FakeEl): void; replaceChildren(f: { children: FakeEl[] }): void; querySelector(sel?: string): FakeEl | null;
  contains(n: unknown): boolean; focus(opts?: unknown): void; remove(): void; getClientRects(): unknown[];
};

/** Where keyboard focus is: what `document.activeElement` answers in the harness, and the options it was moved with. */
const FOCUS: { active: FakeEl | null; opts: unknown } = { active: null, opts: undefined };

function fakeEl(id = '', tagName = 'div', attrs: Record<string, string> = {}): FakeEl {
  const el: FakeEl = {
    id, tagName, parent: null, value: '', disabled: false, hidden: false, innerHTML: '', className: '', tabIndex: -1, dataset: {}, style: {},
    attrs: { ...attrs }, cls: new Set(), children: [], listeners: {}, clientWidth: 1220, clientHeight: 100000, scrollTop: 0,
    classList: {
      add: (c) => { el.cls.add(c); }, remove: (c) => { el.cls.delete(c); }, contains: (c) => el.cls.has(c),
      toggle: (c, on) => { if (on ?? !el.cls.has(c)) el.cls.add(c); else el.cls.delete(c); },
    },
    setAttribute: (k, v) => { el.attrs[k] = v; },
    addEventListener: (t, f) => { (el.listeners[t] ||= []).push(f); },
    appendChild: (c) => { el.children.push(c); c.parent = el; },
    replaceChildren: (f) => { el.children = [...f.children]; for (const c of el.children) c.parent = el; },
    // Only the tile lookups the Grid makes for focus; anything else finds nothing, as before.
    querySelector: (sel) => {
      const m = /^\.gcell(?:\[data-i="(\d+)"\])?$/.exec(sel || '');
      if (!m) return null;
      return el.children.find((c) => /\bgcell\b/.test(c.className) && (m[1] === undefined || String(c.dataset.i) === m[1])) || null;
    },
    contains: (n) => n === el || el.children.includes(n as FakeEl),
    focus: (opts) => { FOCUS.active = el; FOCUS.opts = opts; }, remove: () => {},
    // Painted unless it or a parent is hidden: what "on screen" means to the page's activeViewControl.
    getClientRects: () => { for (let p: FakeEl | null = el; p; p = p.parent) if (p.hidden) return []; return [{}]; },
  };
  return el;
}

type Grid = {
  state: {
    root: Node | null; pathIndex: Map<string, Node>; view: string;
    grid: { path: string; sort: string; query: string; layout: { it: Node; x: number; y: number; side: number }[]; totalH: number;
      selection: Set<string>; anchor: number | null; rangeStart: number; rangeEnd: number };
  };
  els: Record<string, FakeEl>;
  /** The document the page queries, for when the Grid is not the view on screen: see `screenOf`. */
  screen: { body: FakeEl };
  crumbsCb: { fn: ((p: string) => void) | null };
  timers: Map<number, () => void>;
  renderGrid(): Promise<void>; onCellClick(e: Record<string, boolean>, i: number): void; gridUp(): void;
  gridItems(): Node[]; updateSelectionBar(): void;
  /** The Escape key's Grid branch, out of the page's keydown handler (gridHarness({ escape: true })). */
  escapeInGrid?(): void;
  settle(): Promise<void>;
};

/** The Grid branch of the page keydown handler's Escape chain, as the page has it. */
function escapeGridBranch(): string {
  const handler = braced("document.addEventListener('keydown', (e) => {\n  const mod = e.metaKey || e.ctrlKey;");
  const esc = handler.indexOf("if (e.key === 'Escape') {");
  assert.notEqual(esc, -1, 'the keydown handler has an Escape chain');
  const at = handler.indexOf("if (state.view === 'grid') {", esc);
  assert.notEqual(at, -1, 'and a Grid branch in it');
  let depth = 0;
  for (let i = handler.indexOf('{', at); i < handler.length; i++) {
    if (handler[i] === '{') depth++;
    else if (handler[i] === '}' && --depth === 0) return handler.slice(at, i + 1);
  }
  return assert.fail('the Grid branch closes');
}

const file = (dir: string, name: string, size: number): Node => ({ name, path: `${dir}/${name}`, size, type: 'file', modifiedAt: 1 });

function gridHarness(opts: { escape?: boolean } = {}): Grid {
  const src = slice('/* ───────────────────────────── Grid view ───────────────────────────── */',
    '/* ───────────────────────────── Apps view (Feature 18) ───────────────────────────── */');
  const els: Record<string, FakeEl> = {};
  const $ = (id: string) => (els[id] ||= fakeEl(id));
  FOCUS.active = null;
  // The selection bar holds its four controls, as the markup does.
  $('selectionBar').children.push($('selInfo'), $('selOffloadBtn'), $('selTrashBtn'), $('selClearBtn'));
  const fonts: Node = { name: 'Fonts', path: '/r/Fonts', size: 3000, type: 'dir', children: [file('/r/Fonts', 'a.ttf', 2000), file('/r/Fonts', 'b.otf', 1000)] };
  const other: Node = { name: 'Notes.txt', path: '/r/Notes.txt', size: 10, type: 'file', modifiedAt: 1 };
  const root: Node = { name: 'r', path: '/r', size: 3010, type: 'dir', children: [fonts, other] };
  const pathIndex = new Map<string, Node>([[root.path, root], [fonts.path, fonts], [other.path, other],
    ...fonts.children!.map((c) => [c.path, c] as [string, Node])]);
  const state = {
    root, pathIndex, scanId: 's1', view: 'grid',
    grid: { path: '/r', sort: 'size', query: '', layout: [], totalH: 0, selection: new Set<string>(), anchor: null, rangeStart: 0, rangeEnd: -1 },
  };
  const crumbsCb: { fn: ((p: string) => void) | null } = { fn: null };
  const timers = new Map<number, () => void>();
  let tid = 0;
  const screen: Grid['screen'] = { body: fakeEl('body', 'body') };
  const document = {
    createElement: (tag = 'div') => fakeEl('', tag),
    createDocumentFragment: () => { const f = { children: [] as FakeEl[], appendChild(c: FakeEl) { f.children.push(c); } }; return f; },
    get activeElement() { return FOCUS.active; },
    // The page's own selectors, answered over a fake document (B13 review F3.2): a
    // stub that matched on ".view.active" alone held whatever the selector said.
    querySelectorAll: (sel: string) => selectAll(screen.body, sel),
    querySelector: (sel: string) => selectAll(screen.body, sel)[0] ?? null,
  };
  const pending: Promise<unknown>[] = [];
  const deps: Record<string, unknown> = {
    $, state, document, window: { addEventListener: () => {} },
    requestAnimationFrame: () => 0,
    setTimeout: (fn: () => void) => { const id = ++tid; timers.set(id, fn); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    ensureSubtree: async () => {}, ensureScores: async () => {}, RECLAIM_BATCH: 100, byReclaimDesc: () => () => 0,
    renderCrumbs: (_el: unknown, _p: string, cb: (p: string) => void) => { crumbsCb.fn = cb; },
    icon: (name: string, px = 16) => `<svg data-icon="${name}" data-px="${px}"></svg>`,
    escapeHtml: (s: string) => String(s), formatBytes: (n: number) => `${n} B`, formatCount: (n: number) => String(n),
    kindFor: () => ({ icon: 'doc', tint: '#888' }),
    breadcrumbsFor: (p: string) => {
      const out = [{ name: 'r', path: '/r' }];
      if (p !== '/r') for (const part of p.slice(3).split('/')) out.push({ name: part, path: out[out.length - 1].path + '/' + part });
      return out;
    },
    nodeFor: (p: string) => pathIndex.get(p), isCloudScan: () => false, confirmTrash: () => {},
    openInOS: () => {}, showCtxMenu: () => {}, showTooltip: () => {}, hideTooltip: () => {}, openPreview: () => {},
  };
  const names = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const escape = opts.escape ? `function escapeInGrid() { ${escapeGridBranch()} }` : 'const escapeInGrid = undefined;';
  const api = new Function(...names, `'use strict'; ${src}
    ${braced('function activeViewControl(')}
    ${escape}
    return { renderGrid, onCellClick, gridUp, gridItems, updateSelectionBar, escapeInGrid };`)(...names.map((n) => deps[n])) as
    Pick<Grid, 'renderGrid' | 'onCellClick' | 'gridUp' | 'gridItems' | 'updateSelectionBar' | 'escapeInGrid'>;
  // renderGrid is async; navigation calls it without awaiting.
  const wrapped = {
    ...api,
    renderGrid: () => { const p = api.renderGrid(); pending.push(p); return p; },
  };
  return {
    state: state as unknown as Grid['state'], els, screen, crumbsCb, timers, ...wrapped,
    settle: async () => {
      while (pending.length) await pending.shift();
      // Navigation calls the lifted renderGrid itself, unawaited: let its awaits run out.
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}

/* ══════════════ D43 — Up, labels, badges ══════════════ */

test('Up is disabled at the scan root and enabled one folder down (D43)', async () => {
  const g = gridHarness();
  await g.renderGrid();
  assert.equal(g.els.gridUpBtn.disabled, true, 'at the root there is nowhere up to go');
  g.state.grid.path = '/r/Fonts';
  await g.renderGrid();
  assert.equal(g.els.gridUpBtn.disabled, false, 'one level down, Up works');
  g.state.root = null;
  await g.renderGrid();
  assert.equal(g.els.gridUpBtn.disabled, true, 'no scan, no Up');
});

/** A folder whose children span every tile size the layout can produce. */
function widePlant(g: Grid) {
  const kids: Node[] = [];
  for (let i = 0; i < 60; i++) {
    const size = Math.round(1e9 * Math.pow(i / 59, 2)) + 1;
    const dir = i % 2 === 0;
    kids.push(dir
      ? { name: `Folder${i}`, path: `/r/Folder${i}`, size, type: 'dir', children: [file(`/r/Folder${i}`, 'x', 1)] }
      : file('/r', `File${i}`, size));
  }
  g.state.root!.children = kids;
  for (const k of kids) g.state.pathIndex.set(k.path, k);
}

type Tile = { side: number; html: string; compact: boolean };
/** The size of a tile's own type icon (not the selection tick). */
function iconPxOf(html: string): number {
  const m = /<span style="color:[^"]*"><svg data-icon="[^"]*" data-px="(\d+)"/.exec(html);
  assert.ok(m, `the tile draws its type icon: ${html}`);
  return Number(m![1]);
}
async function tiles(): Promise<Tile[]> {
  const g = gridHarness();
  widePlant(g);
  await g.renderGrid();
  const cells = g.els.gridInner.children;
  assert.ok(cells.length >= 60, `every tile rendered (${cells.length})`);
  return cells.map((c) => ({
    side: Number(/width:(\d+)px/.exec(c.style.cssText || '')![1]),
    html: c.innerHTML,
    compact: /\bcompact\b/.test(c.className),
  }));
}

test('every tile is labelled with its name and its size, whatever its size (D43)', async () => {
  const ts = await tiles();
  const sides = ts.map((t) => t.side);
  assert.ok(Math.min(...sides) < 84 && Math.max(...sides) >= 120, `the plant covers small and large tiles: ${Math.min(...sides)}–${Math.max(...sides)}`);
  for (const t of ts) {
    assert.match(t.html, /class="nm"/, `a ${t.side}px tile names what it is`);
    assert.match(t.html, /class="sz num"/, `a ${t.side}px tile says how big it is`);
  }
});

test('a tile’s icon, name and size fit inside it at every size the layout produces (D43)', async () => {
  const cell = declsOf('.gcell'), compact = declsOf('.gcell.compact');
  const border = 1;
  const nameLine = px(declsOf('.gcell .nm').get('line-height'), '.gcell .nm line-height');
  const sizeLine = px(declsOf('.gcell .sz').get('line-height'), '.gcell .sz line-height');
  assert.equal(cell.get('justify-content'), 'center', 'the stack is centred vertically');
  for (const t of await tiles()) {
    const d = t.compact ? compact : cell;
    const pad = px(d.get('padding') ?? cell.get('padding'), 'tile padding');
    const gap = px(d.get('gap') ?? cell.get('gap'), 'tile gap');
    const iconPx = iconPxOf(t.html);
    const stack = iconPx + gap + nameLine + gap + sizeLine;
    const room = t.side - 2 * border - 2 * pad;
    assert.ok(stack <= room, `${t.side}px tile${t.compact ? ' (compact)' : ''}: a ${stack}px stack in ${room}px`);
  }
});

test('the folder-count badge only appears where it clears the icon (D43)', async () => {
  const cell = declsOf('.gcell'), badge = declsOf('.gcell .badge');
  const nameLine = px(declsOf('.gcell .nm').get('line-height'), '.gcell .nm line-height');
  const sizeLine = px(declsOf('.gcell .sz').get('line-height'), '.gcell .sz line-height');
  const [bPadV] = (badge.get('padding') || '').split(/\s+/).map((v) => px(v, 'badge padding'));
  const badgeBottom = px(badge.get('top'), 'badge top') + 2 * bPadV + px(badge.get('line-height'), 'badge line-height');
  let seen = 0;
  for (const t of await tiles()) {
    if (!/class="badge num"/.test(t.html)) continue;
    seen++;
    assert.ok(!t.compact, 'never on a compact tile');
    const iconPx = iconPxOf(t.html);
    const pad = px(cell.get('padding'), 'tile padding'), gap = px(cell.get('gap'), 'tile gap');
    const stack = iconPx + gap + nameLine + gap + sizeLine;
    const iconTop = 1 + pad + (t.side - 2 - 2 * pad - stack) / 2;
    assert.ok(iconTop >= badgeBottom, `${t.side}px tile: icon starts at ${iconTop}px, the badge ends at ${badgeBottom}px`);
  }
  assert.ok(seen > 0, 'large folders still carry their count');
});

/* ══════════════ D44 — the filter belongs to the folder it was typed in ══════════════ */

test('opening a folder from a filtered grid clears the filter, so the folder shows its contents (D44)', async () => {
  const g = gridHarness();
  g.state.grid.query = 'Fonts'; g.els.gridSearch.value = 'Fonts';
  await g.renderGrid();
  assert.deepEqual(g.state.grid.layout.map((c) => c.it.name), ['Fonts'], 'the filter found the folder (precondition)');
  g.onCellClick({}, 0);
  await g.settle();
  assert.equal(g.state.grid.path, '/r/Fonts', 'the click opened the folder');
  assert.equal(g.state.grid.query, '', 'the filter typed for the parent is dropped');
  assert.equal(g.els.gridSearch.value, '', 'and so is the text in the box');
  assert.deepEqual(g.gridItems().map((n) => n.name).sort(), ['a.ttf', 'b.otf'], 'the folder shows what it holds');
});

test('Up and the breadcrumbs clear the filter too, and a half-typed filter cannot land after the move (D44)', async () => {
  const g = gridHarness();
  g.state.grid.path = '/r/Fonts';
  g.state.grid.query = 'a.t'; g.els.gridSearch.value = 'a.t';
  g.gridUp();
  await g.settle();
  assert.equal(g.state.grid.path, '/r', 'Up went up');
  assert.equal(g.state.grid.query, '', 'Up drops the filter');
  assert.equal(g.els.gridSearch.value, '', 'and empties the box');

  await g.renderGrid();
  assert.ok(g.crumbsCb.fn, 'the grid wires its breadcrumbs');
  g.state.grid.path = '/r/Fonts'; g.state.grid.query = 'b'; g.els.gridSearch.value = 'b';
  g.crumbsCb.fn!('/r');
  await g.settle();
  assert.equal(g.state.grid.query, '', 'a breadcrumb drops it');
  assert.equal(g.els.gridSearch.value, '', 'and empties the box');

  // A keystroke still inside its debounce when the folder changes.
  const input = g.els.gridSearch.listeners.input?.[0];
  assert.ok(input, 'the filter box listens for input');
  g.els.gridSearch.value = 'Fo';
  input!({ target: g.els.gridSearch });
  assert.equal(g.timers.size, 1, 'the keystroke is debounced (precondition)');
  await g.renderGrid();
  g.state.grid.layout = [{ it: g.state.pathIndex.get('/r/Fonts')!, x: 0, y: 0, side: 100 }];
  g.onCellClick({}, 0);
  const stillPending = g.timers.size;
  for (const fn of [...g.timers.values()]) fn();
  await g.settle();
  assert.equal(g.state.grid.query, '', 'the parent’s half-typed filter never lands on the new folder, whenever its timer fires');
  assert.equal(stillPending, 0, 'and the keystroke is cancelled with the move — no second render of the new folder for it');
});

/* ══════════════ D02 — no off-screen focus stops ══════════════ */

test('with nothing selected, the selection bar is hidden from focus and assistive tech, not just slid away (D02)', () => {
  const bar = declsOf('#selectionBar');
  const shown = declsOf('#selectionBar.visible');
  assert.equal(bar.get('visibility'), 'hidden', 'off-screen is not enough: Tab reached "Move to Trash"');
  assert.equal(shown.get('visibility'), 'visible', 'a selection brings it back');
  // The slide-out still plays: visibility flips only after the transform has run.
  const dur = /transform (var\(--[\w-]+\))/.exec(bar.get('transition') || '');
  assert.ok(dur, 'the bar still slides');
  assert.match(bar.get('transition') || '', new RegExp(`visibility 0s linear ${dur![1].replace(/[()]/g, '\\$&')}`),
    'hiding waits for the slide to finish');
  assert.match(shown.get('transition') || '', /visibility 0s(?! linear)/, 'showing is immediate');

  const g = gridHarness();
  g.updateSelectionBar();
  assert.equal(g.els.selectionBar.cls.has('visible'), false, 'empty selection: the hidden state');
  g.state.grid.selection.add('/r/Notes.txt');
  g.updateSelectionBar();
  assert.equal(g.els.selectionBar.cls.has('visible'), true, 'one item: shown');
});

/* ══════════════ D21 — no "same plan" for a free plan ══════════════ */

test('the Cost card never tells a free plan that clearing space keeps you on it (D21)', async () => {
  const src = slice('function costMoney(', '/* ───────────────────────────── Drive Health');
  let painted = '';
  const provider = (name: string, label: string, monthly: number) => ({
    providerName: name, bytes: 8.8e9, current: { tier: { label }, monthly },
    afterCleanup: { tier: { label }, monthly }, sameTierAfterCleanup: true, monthlySavingUsd: 0,
  });
  const est = { providers: [provider('Free Drive', 'Free — 15 GB', 0), provider('Paid Drive', 'Basic — 100 GB', 1.99)],
    asOf: '2026-09', symbol: '$', rateFromUsd: 1, approximate: false };
  const host = fakeEl('costBody');
  const deps: Record<string, unknown> = {
    $: (id: string) => (id === 'costBody' ? host : { value: 'USD' }),
    state: { scanId: 's1' },
    api: async (url: string) => (url.startsWith('/api/cleanup/suggestions') ? { groups: [{ totalSize: 137_200_000 }] } : est),
    skeletonRows: () => '', escapeHtml: (s: string) => String(s), formatBytes: (n: number) => `${n} B`,
    fxBarStyle: () => '', fxBarsIn: () => {},
    FxNum: { rollHtml: (_h: unknown, html: string) => { painted = html; } },
  };
  const names = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const load = new Function(...names, `'use strict'; ${src} return loadCostEstimate;`)(...names.map((n) => deps[n])) as () => Promise<void>;
  await load();
  const rows = painted.split('<div class="cost-row">').slice(1);
  assert.equal(rows.length, 2, 'both providers are priced');
  const free = rows.find((r) => r.includes('Free Drive'))!;
  const paid = rows.find((r) => r.includes('Paid Drive'))!;
  assert.doesNotMatch(free, /cost-nosave/, 'a plan that costs nothing has no plan to keep you on');
  assert.match(paid, /cost-nosave/, 'a paid plan the cleanup cannot shrink still says so');
  assert.match(paid, /keeps you on the same plan/);
});

/* ══════════════ the shared Move-to-Trash sheet's total ══════════════ */

test('the Move-to-Trash sheet’s total counts a folder and a file inside it once', async () => {
  const src = slice('/* ───────────────────────────── Trash (confirm + execute) ',
    '/* ───────────────────────────── Open-file guard (B2)');
  const sizes: Record<string, { name: string; size: number }> = {
    '/r/A': { name: 'A', size: 100 }, '/r/A/x.bin': { name: 'x.bin', size: 40 }, '/r/B': { name: 'B', size: 10 },
    '/r/AB': { name: 'AB', size: 5 },
  };
  const els: Record<string, FakeEl> = {};
  const deps: Record<string, unknown> = {
    $: (id: string) => (els[id] ||= fakeEl(id)),
    ensureNodes: async () => {}, nodeFor: (p: string) => sizes[p], resetOpenHandleWarning: () => {},
    checkOpenHandlesFor: async () => {}, cloudProviderOfScan: () => ({}), cloudTrashPaths: () => {},
    icon: () => '', escapeHtml: (s: string) => String(s), formatBytes: (n: number) => `${n} B`,
  };
  const names = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const confirmTrash = new Function(...names, `'use strict'; ${braced('function tmParentPath(')}\n${src} return confirmTrash;`)(
    ...names.map((n) => deps[n])) as (p: string[]) => Promise<void>;
  await confirmTrash(['/r/A', '/r/A/x.bin', '/r/B', '/r/AB']);
  assert.match(els.confirmText.innerHTML, /\(115 B total\)/,
    'A (100) holds x.bin (40): the folder counts once; B and AB are separate — a shared name prefix is not nesting');
  assert.match(els.confirmText.innerHTML, /<b>4 items<\/b>/, 'the sheet still names every item it will move');
});

/* ══════════════ B13 — Clear hands keyboard focus back to the grid ══════════════ */

/** Press Clear in the selection bar, as its click handler sees it. */
function pressClear(g: Grid) {
  const handlers = g.els.selClearBtn.listeners.click || [];
  assert.ok(handlers.length > 0, 'Clear has a click handler');
  for (const h of handlers) h({});
}

test('Clear in the selection bar hands keyboard focus back to the tile it was selecting, never to <body> (B13)', async () => {
  // QA: the bar slid away with focus still on its Clear button, so focus
  // fell to <body> and a keyboard user had to tab in from the top again.
  const g = gridHarness();
  await g.renderGrid();
  g.onCellClick({ metaKey: true }, 1); // ⌘-click the second tile: the bar slides in
  assert.ok(g.els.selectionBar.cls.has('visible'), 'the bar is up');
  g.els.selClearBtn.focus();
  pressClear(g);
  assert.ok(!g.els.selectionBar.cls.has('visible'), 'the bar slides away');
  const at = FOCUS.active;
  assert.ok(at && /\bgcell\b/.test(at.className), `focus is on a tile, not on the hidden button (${at ? at.id || at.className : 'nothing'})`);
  assert.equal(String(at!.dataset.i), '1', 'the tile the selection was anchored on');
  assert.ok(g.els.gridInner.children.includes(at!), 'one of the tiles the grid is showing now');
});

test('Clear leaves focus alone when it was not in the bar (B13)', async () => {
  const g = gridHarness();
  await g.renderGrid();
  g.onCellClick({ metaKey: true }, 0);
  g.els.gridSearch.focus(); // somewhere else entirely
  pressClear(g);
  assert.equal(FOCUS.active, g.els.gridSearch, 'a control outside the bar keeps its focus');
});

/** 400 equal files: 256 px tiles, four to a 1200 px row, a row every 268 px — a grid far taller than its window. */
function tallPlant(g: Grid) {
  const kids: Node[] = [];
  for (let i = 0; i < 400; i++) kids.push(file('/r', `Clip${i}.mov`, 1000));
  g.state.root!.children = kids;
  for (const k of kids) g.state.pathIndex.set(k.path, k);
}

/** The tile focus is on, and whether any of it is inside the grid's visible window. */
function focusedTile(g: Grid): { i: number; y0: number; y1: number; inView: boolean } {
  const at = FOCUS.active;
  assert.ok(at && /\bgcell\b/.test(at.className), `focus is on a tile (${at ? at.id || at.className : 'nothing'})`);
  const i = Number(at!.dataset.i);
  const c = g.state.grid.layout[i];
  const top = g.els.gridScroll.scrollTop, bottom = top + g.els.gridScroll.clientHeight;
  return { i, y0: c.y, y1: c.y + c.side, inView: c.y + c.side > top && c.y < bottom };
}

/** Type into the filter box and let its debounce and the re-render run out. */
async function typeFilter(g: Grid, text: string) {
  const input = g.els.gridSearch.listeners.input?.[0];
  assert.ok(input, 'the filter box listens for input');
  g.els.gridSearch.value = text;
  input!({ target: g.els.gridSearch });
  for (const [id, fn] of [...g.timers]) { g.timers.delete(id); fn(); }
  await g.settle();
}

test('Clear never scrolls the grid: focus goes to a tile that is on screen, without moving it (B13 review F1.3)', async () => {
  // Review: with the anchored tile scrolled out of the rendered window, focus
  // went to the first tile DRAWN — up to 200 px above the visible area — and
  // tile.focus() with no options scrolled the grid to it on Clear.
  const g = gridHarness();
  tallPlant(g);
  g.els.gridScroll.clientHeight = 700;
  await g.renderGrid();
  g.onCellClick({ metaKey: true }, 2); // select a tile in the first row
  g.els.gridScroll.scrollTop = 3000; // then scroll well past it
  g.els.selClearBtn.focus();
  pressClear(g);
  const far = focusedTile(g);
  assert.ok(far.inView, `focus went to tile ${far.i} at y ${far.y0}–${far.y1}; the grid shows 3000–3700`);
  assert.deepEqual(FOCUS.opts, { preventScroll: true }, 'and moving it there does not scroll the grid');

  // The anchored tile still drawn (inside the 200 px margin) but above the window.
  const h = gridHarness();
  tallPlant(h);
  h.els.gridScroll.clientHeight = 700;
  await h.renderGrid();
  h.onCellClick({ metaKey: true }, 2); // y 0–256
  h.els.gridScroll.scrollTop = 400;
  h.els.selClearBtn.focus();
  pressClear(h);
  const near = focusedTile(h);
  assert.ok(near.inView, `focus went to tile ${near.i} at y ${near.y0}–${near.y1}; the grid shows 400–1100`);
  assert.equal(near.i, 4, 'the first tile on screen, as the anchored one is not');
  assert.deepEqual(FOCUS.opts, { preventScroll: true }, 'without scrolling');
});

test('with the anchor gone, Clear hands focus to the first tile on screen; with no tiles at all, to the filter box (B13 review F1.6)', async () => {
  // A filter keystroke re-lays the grid, and one that leaves another file (or
  // none) at the anchor's position drops the anchor, while the selection and
  // its bar stay up. (A re-lay that keeps the same file there keeps it — the
  // preview pane narrowing the Grid, QA C04.)
  const g = gridHarness();
  await g.renderGrid();
  g.onCellClick({ metaKey: true }, 1);
  await typeFilter(g, 'notes'); // only "Notes.txt" matches: nothing is at position 1 now
  assert.equal(g.state.grid.anchor, null, 'the re-lay dropped the anchor (precondition)');
  assert.ok(g.els.selectionBar.cls.has('visible'), 'and the bar is still up (precondition)');
  g.els.selClearBtn.focus();
  pressClear(g);
  assert.equal(focusedTile(g).i, 0, 'the first tile on screen');
  assert.deepEqual(FOCUS.opts, { preventScroll: true }, 'without scrolling');

  const e = gridHarness();
  await e.renderGrid();
  e.onCellClick({ metaKey: true }, 1);
  await typeFilter(e, 'zzz'); // nothing matches: no tile is drawn
  assert.equal(e.els.gridInner.children.length, 0, 'no tile is drawn (precondition)');
  assert.ok(e.els.selectionBar.cls.has('visible'), 'the bar is still up (precondition)');
  e.els.selClearBtn.focus();
  pressClear(e);
  assert.equal(FOCUS.active, e.els.gridSearch, 'focus goes to the filter box, never to <body>');
  assert.deepEqual(FOCUS.opts, { preventScroll: true }, 'without scrolling');
});

test('Escape in the Grid clears the selection through the same door as Clear, so focus in the bar comes back too (B13 review F1.8)', async () => {
  // Review: Escape cleared the selection with its own three statements and
  // never moved focus, so a keyboard user on "Move to Trash" was dropped to
  // <body> when the bar slid away — the B13 symptom, by another key.
  const g = gridHarness({ escape: true });
  await g.renderGrid();
  g.onCellClick({ metaKey: true }, 1);
  g.els.selTrashBtn.focus(); // tabbed into the bar
  g.escapeInGrid!();
  assert.equal(g.state.grid.selection.size, 0, 'Escape clears the selection');
  assert.ok(!g.els.selectionBar.cls.has('visible'), 'and the bar slides away');
  const at = FOCUS.active;
  assert.ok(at && /\bgcell\b/.test(at.className), `focus is back on a tile, not on the hidden button (${at ? at.id || at.className : 'nothing'})`);
  assert.equal(String(at!.dataset.i), '1', 'the tile the selection was anchored on');
  // Pressed from a tile, Escape clears and leaves focus where it is.
  const h = gridHarness({ escape: true });
  await h.renderGrid();
  h.onCellClick({ metaKey: true }, 0);
  const tile = h.els.gridInner.children[1];
  tile.focus();
  h.escapeInGrid!();
  assert.equal(h.state.grid.selection.size, 0, 'the selection is cleared');
  assert.equal(FOCUS.active, tile, 'focus on a tile stays on that tile');
});

/** The Grid with a selection made, then another view brought up: the bar stays (⌘⌫ works from any view), the Grid is display:none. */
async function selectionThenLeave(view: string): Promise<Grid> {
  const g = gridHarness();
  await g.renderGrid();
  g.onCellClick({ metaKey: true }, 1);
  g.state.view = view; // switchView: the Grid is hidden…
  g.els.gridScroll.clientHeight = 0; // …so its scroller has no height and no tile is on screen
  assert.ok(g.els.selectionBar.cls.has('visible'), 'the bar is still up (precondition)');
  return g;
}

/**
 * The document behind `g`'s queries while `view` is up, as the page builds
 * it: the sidebar's tab bar with that view's tab selected, the Grid's own
 * section hidden (its filter box inside it), and the view's
 * `<section class="view active">` holding `controls` in document order.
 * `make` builds each element with its tag and attributes; anything that is
 * not a control — the section itself, a wrapper, a label — is in the tree
 * too, so a selector that matched it would find it.
 */
function screenOf(g: Grid, view: string, controls: FakeEl[]): { tab: FakeEl; section: FakeEl } {
  const body = g.screen.body;
  const nav = fakeEl('', 'nav'); nav.cls.add('tabbar');
  const gridTab = fakeEl('tabGrid', 'button', { 'aria-selected': 'false' });
  const tab = fakeEl(`tab-${view}`, 'button', { 'aria-selected': 'true' });
  nav.appendChild(gridTab); nav.appendChild(tab);
  const gridView = fakeEl('view-grid', 'section'); gridView.cls.add('view'); gridView.hidden = true;
  gridView.appendChild(g.els.gridSearch); // the filter box: in the Grid, which is display:none now
  const section = fakeEl(`view-${view}`, 'section'); section.cls.add('view'); section.cls.add('active');
  const wrap = fakeEl('', 'div'); // a toolbar row: not a control, and its controls are still in the view
  for (const c of controls) wrap.appendChild(c);
  section.appendChild(wrap);
  body.appendChild(nav); body.appendChild(gridView); body.appendChild(section);
  return { tab, section };
}

test('Clear pressed with the Grid hidden hands focus to the view on screen, or to its tab — never to the hidden filter box (B13 review F2.4, F3.2)', async () => {
  // Review: the bar outlives a view switch, and Clear's fallback focused
  // #gridSearch inside the hidden Grid — a no-op in a browser — so focus
  // fell to <body> with the bar, the B13 symptom.
  // Review F3.2: the document the page queries now answers its own
  // selector, and the first control on screen is not a button — the
  // Dashboard's "What's new" strip is a div in the tab order.
  const g = await selectionThenLeave('dashboard');
  const offscreen = fakeEl('dashOffscreen', 'button'); offscreen.hidden = true;
  const disabled = fakeEl('dashDisabled', 'button'); disabled.disabled = true;
  screenOf(g, 'dashboard', [
    offscreen, disabled,
    fakeEl('dashCard', 'div', { tabindex: '-1' }), // focusable by script only: not a stop in the tab order
    fakeEl('dashLabel', 'span'),
    fakeEl('whatsNewBody', 'div', { role: 'button', tabindex: '0' }),
    fakeEl('dashRescan', 'button'),
  ]);
  g.els.selClearBtn.focus();
  pressClear(g);
  assert.ok(!g.els.selectionBar.cls.has('visible'), 'the bar slides away');
  assert.equal(FOCUS.active?.id, 'whatsNewBody', 'the first enabled control on screen in the view that is up');
  assert.deepEqual(FOCUS.opts, { preventScroll: true }, 'without scrolling it');

  // A view with nothing to offer (its capability notice instead of controls): its sidebar tab.
  const b = await selectionThenLeave('apps');
  const { tab } = screenOf(b, 'apps', [fakeEl('appsNotice', 'p')]);
  b.els.selClearBtn.focus();
  pressClear(b);
  assert.equal(FOCUS.active, tab, 'the selected sidebar tab, when the view has no control on screen');
});

test('every kind of control the page counts can take focus when Clear is pressed from another view — a button, a text box, a menu, anything in the tab order (B13 review F3.2)', async () => {
  // Review: with the stub answering any ".view.active" selector, the page's
  // could lose a part — inputs, menus, [tabindex="0"] — or shrink to
  // ".view.active", the sections themselves, and nothing went red. Here
  // each kind is the only control in its view, behind things that are not
  // controls, so each part of the selector has to find it.
  const kinds: Array<[string, () => FakeEl]> = [
    ['a button', () => fakeEl('only', 'button')],
    ['a text box', () => fakeEl('only', 'input', { type: 'text' })],
    ['a menu', () => fakeEl('only', 'select')],
    ['a canvas in the tab order', () => fakeEl('only', 'canvas', { tabindex: '0' })],
  ];
  for (const [kind, make] of kinds) {
    const g = await selectionThenLeave('city');
    const only = make();
    screenOf(g, 'city', [fakeEl('', 'span'), fakeEl('', 'canvas', { tabindex: '-1' }), only]);
    g.els.selClearBtn.focus();
    pressClear(g);
    assert.equal(FOCUS.active, only, `${kind}: focus lands on it (got ${FOCUS.active ? `${FOCUS.active.tagName}#${FOCUS.active.id}` : 'nothing'})`);
  }
});
