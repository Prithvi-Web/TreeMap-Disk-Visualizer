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
    // A focused child taken out goes with its focus, as a browser's focus fixup
    // has it (review F1.5): document.activeElement is then <body>, here nothing.
    replaceChildren: (f) => {
      if (el.children.includes(FOCUS.active as FakeEl) && !f.children.includes(FOCUS.active as FakeEl)) FOCUS.active = null;
      el.children = [...f.children]; for (const c of el.children) c.parent = el;
    },
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
  /** The document the page queries, and the sidebar tabs switchView marks selected: see `screenOf`. */
  screen: { body: FakeEl; tabs: FakeEl[] };
  crumbsCb: { fn: ((p: string) => void) | null };
  timers: Map<number, () => void>;
  /** What the page around the Grid holds: whether the cart dock is up (the selection bar's state is its own element's). */
  page: { cart: boolean };
  renderGrid(): Promise<void>; onCellClick(e: Record<string, boolean>, i: number): void; gridUp(): void;
  gridItems(): Node[]; updateSelectionBar(): void;
  /** The view registry's own switchView, the parts that are not the Grid's stubbed (D03): it hides and shows the `.view` sections of `screen`. */
  switchView(name: string): void;
  /** The Escape key's Grid branch, out of the page's keydown handler (gridHarness({ escape: true })). */
  escapeInGrid?(): void;
  /** The page's own preview pane, in place of the stub (gridHarness({ preview: true })): Escape and Close both call closePreview. */
  closePreview?(): void;
  /** And what opens it, for a pane opened from somewhere other than a tile (gridHarness({ preview: true })). */
  openPreview?(node: Node): void;
  settle(): Promise<void>;
};

/** A top-level `let`/`const` of the built page, up to its first semicolon. */
function pageDecl(anchor: string): string {
  const at = INDEX.indexOf(anchor);
  assert.notEqual(at, -1, `"${anchor}" is in the built page`);
  return INDEX.slice(at, INDEX.indexOf(';', at) + 1);
}

/** The quick-look preview pane, as the page has it: what opens it, closes it and remembers where focus came from. */
function previewPaneSrc(): string {
  return [pageDecl('const PV_IMG_EXT = '), pageDecl('let pvReqId = '), pageDecl('let pvPrevFocus = '),
    ...['previewExt', 'previewReflow', 'openPreview', 'closePreview', 'previewIsOpen'].map((n) => braced(`function ${n}(`))].join('\n');
}

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

function gridHarness(opts: { escape?: boolean; raf?: boolean; preview?: boolean } = {}): Grid {
  const src = slice('/* ───────────────────────────── Grid view ───────────────────────────── */',
    '/* ───────────────────────────── Apps view (Feature 18) ───────────────────────────── */');
  const els: Record<string, FakeEl> = {};
  const $ = (id: string) => (els[id] ||= fakeEl(id));
  // The filter box is a text box, as the markup has it: a selector for the controls on screen finds it while the Grid is up.
  els.gridSearch = fakeEl('gridSearch', 'input', { type: 'text' });
  FOCUS.active = null;
  // A browser keeps a scroller's scrollTop inside what it can scroll — its
  // content (#gridInner, and the scroller's own padding above and below it)
  // less its window — when it is set, and again when the content shrinks. A
  // plain number let a scroll be restored before the content had grown to
  // hold it, which a browser clamps short (review F2.2). The padding is the
  // sheet's for the page as it stands: the foot grows while the selection
  // bar is up (QA D02), and getComputedStyle answers the page with the same.
  const page = { cart: false };
  const scroller = $('gridScroll'), inner = $('gridInner');
  const pads = () => scrollerPads({ cart: page.cart, bar: els.selectionBar.cls.has('visible') });
  let scrollTop = 0, innerH = '';
  const range = () => Math.max(0, (parseFloat(innerH) || 0) + pads().top + pads().bottom - scroller.clientHeight);
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v: number) => { scrollTop = Math.max(0, Math.min(v, range())); } });
  Object.defineProperty(inner.style, 'height', {
    enumerable: true, get: () => innerH, set: (v: string) => { innerH = v; scrollTop = Math.min(scrollTop, range()); },
  });
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
  const screen: Grid['screen'] = { body: fakeEl('body', 'body'), tabs: [] };
  const document = {
    createElement: (tag = 'div') => fakeEl('', tag),
    createDocumentFragment: () => { const f = { children: [] as FakeEl[], appendChild(c: FakeEl) { f.children.push(c); } }; return f; },
    get activeElement() { return FOCUS.active; },
    // The page's own selectors, answered over a fake document (B13 review F3.2): a
    // stub that matched on ".view.active" alone held whatever the selector said.
    querySelectorAll: (sel: string) => selectAll(screen.body, sel),
    querySelector: (sel: string) => selectAll(screen.body, sel)[0] ?? null,
    // The preview pane reads the page's body class and whether an element is
    // still in the document: one a rebuild took out of its parent is not.
    ...(opts.preview ? {
      body: screen.body,
      contains: (n: FakeEl | null) => {
        for (let p = n; p; p = p.parent) {
          if (p === screen.body || Object.values(els).includes(p)) return true;
          if (!p.parent || !p.parent.children.includes(p)) return false;
        }
        return false;
      },
    } : {}),
  };
  // The window's resize signal reaches the Grid's own listener: the preview
  // pane replays it when it narrows or widens the page (QA C04).
  const winListeners: Record<string, ((e: unknown) => void)[]> = {};
  const win = {
    addEventListener: (t: string, f: (e: unknown) => void) => { (winListeners[t] ||= []).push(f); },
    dispatchEvent: (e: { type: string }) => { for (const f of winListeners[e.type] || []) f(e); return true; },
  };
  if (opts.preview) { $('previewPane').hidden = true; $('previewPane').appendChild($('pvClose')); }
  const pending: Promise<unknown>[] = [];
  const deps: Record<string, unknown> = {
    $, state, document, window: win,
    getComputedStyle: (el: FakeEl) => {
      assert.equal(el, scroller, 'the Grid asks the computed style of its scroller only');
      return { paddingTop: `${pads().top}px`, paddingBottom: `${pads().bottom}px` };
    },
    // A frame runs at once with { raf: true }, so a scroll of #gridScroll draws its tiles.
    requestAnimationFrame: opts.raf ? (cb: () => void) => { cb(); return 0; } : () => 0,
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
    // switchView's world beyond the Grid (D03): every view mounts nothing and is usable; the sections it
    // shows and hides are the `.view` elements of `screen` (screenOf).
    VIEW_BY_ID: new Map(['grid', 'dashboard', 'treemap', 'apps', 'city', 'autopilot'].map((id) => [id, { id, label: id, needsScan: true, mount() {} }])),
    tabs: screen.tabs, viewBlockedReason: () => null, hideCtxMenu: () => {}, fxEmptyCtaSync: () => {}, fxScanHeroSync: () => {},
    renderCapabilityNotice: () => {}, fxViewEnter: () => {}, toast: () => {},
    treeScanId: () => (state as unknown as { scanId: string | null }).scanId,
  };
  if (opts.preview) {
    delete deps.openPreview;
    Object.assign(deps, {
      toast: () => {}, chipFor: () => '', formatDate: String, loadProvenance: () => {}, api: () => new Promise(() => {}),
      Image: class {}, highlightCode: String, renderPreviewMeta: () => {},
    });
  }
  const names = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const escape = opts.escape ? `function escapeInGrid() { ${escapeGridBranch()} }` : 'const escapeInGrid = undefined;';
  const api = new Function(...names, `'use strict'; ${src}
    ${braced('function activeViewControl(')}
    let mountedView = null;
    ${braced('function switchView(')}
    ${escape}
    ${opts.preview ? previewPaneSrc() : 'const closePreview = undefined;'}
    return { renderGrid, onCellClick, gridUp, gridItems, updateSelectionBar, escapeInGrid, switchView, closePreview, openPreview };`)(...names.map((n) => deps[n])) as
    Pick<Grid, 'renderGrid' | 'onCellClick' | 'gridUp' | 'gridItems' | 'updateSelectionBar' | 'escapeInGrid' | 'switchView' | 'closePreview' | 'openPreview'>;
  // renderGrid is async; navigation calls it without awaiting.
  const wrapped = {
    ...api,
    renderGrid: () => { const p = api.renderGrid(); pending.push(p); return p; },
  };
  return {
    state: state as unknown as Grid['state'], els, screen, crumbsCb, timers, page, ...wrapped,
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
  // With the app's one rule for the scan the tree on screen came from (treeScanId), which it prices.
  const src = `${slice('function treeScanId(', '\n}\n')}\n}\n${slice('function costMoney(', '/* ───────────────────────────── Drive Health')}`;
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

test('the Move-to-Trash sheet promises the way back only until the Trash is emptied — local or a cloud provider\'s (QA third pass D06)', async () => {
  // QA third pass D06's sweep: "You can restore it from the Trash at any
  // time." This sheet is DELETE /api/files — no Time Capsule copy — so an
  // emptied Trash gives nothing back; and a provider empties its own trash
  // after the time it keeps deleted files.
  const src = slice('/* ───────────────────────────── Trash (confirm + execute) ',
    '/* ───────────────────────────── Open-file guard (B2)');
  const sizes: Record<string, { name: string; size: number }> = {
    '/r/A': { name: 'A', size: 100 }, '/r/B': { name: 'B', size: 10 },
    'cloud://drive/x.bin': { name: 'x.bin', size: 7 }, 'cloud://drive/y.bin': { name: 'y.bin', size: 3 },
  };
  const els: Record<string, FakeEl> = {};
  const deps: Record<string, unknown> = {
    $: (id: string) => (els[id] ||= fakeEl(id)),
    ensureNodes: async () => {}, nodeFor: (p: string) => sizes[p], resetOpenHandleWarning: () => {},
    checkOpenHandlesFor: async () => {}, cloudProviderOfScan: () => ({ name: 'Google Drive', trashLabel: 'Google Drive trash' }),
    cloudTrashPaths: () => {}, icon: () => '', escapeHtml: (s: string) => String(s), formatBytes: (n: number) => `${n} B`,
  };
  const names = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const confirmTrash = new Function(...names, `'use strict'; ${braced('function tmParentPath(')}\n${src} return confirmTrash;`)(
    ...names.map((n) => deps[n])) as (p: string[]) => Promise<void>;
  const sheet = async (paths: string[]) => { await confirmTrash(paths); return els.confirmText.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '); };
  for (const [paths, pronoun] of [[['/r/A'], 'it'], [['/r/A', '/r/B'], 'them']] as const) {
    const said = await sheet([...paths]);
    assert.doesNotMatch(said, /any ?time/i, `no way back "at any time": ${said}`);
    assert.match(said, new RegExp(`put ${pronoun} back from the Trash until the Trash is emptied`), said);
  }
  for (const [paths, pronoun] of [[['cloud://drive/x.bin'], 'it'], [['cloud://drive/x.bin', 'cloud://drive/y.bin'], 'them']] as const) {
    const said = await sheet([...paths]);
    assert.doesNotMatch(said, /any ?time/i, `a provider keeps deleted files for its own time, not for ever: ${said}`);
    assert.match(said, new RegExp(`restore ${pronoun} from there until it is emptied`), said);
    assert.match(said, /by the provider/, `and says the provider empties it too: ${said}`);
  }
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

/* ══════════════ review F1.8 — a re-flow keeps the Grid's place ══════════════ */

test('a re-flow into a new width keeps the tile just clicked where it was on screen — the preview pane opening on its click, and closing (review F1.8)', async () => {
  // The pane narrows the page (QA C04) on the plain click that opens it, and
  // the Grid re-flows into the narrower column: rows multiply and every
  // tile's y grows. Nothing moved the scroller, so in a Grid scrolled past
  // its first screen the tile just clicked dropped out of view.
  const g = gridHarness();
  tallPlant(g); // 256 px tiles, four to a 1200 px row, a row every 268 px
  g.els.gridScroll.clientHeight = 700;
  await g.renderGrid();
  g.els.gridScroll.scrollTop = 2800; // rows 10–13 on screen
  g.onCellClick({}, 45); // a plain click on a file: it is selected, and the pane opens
  const fromTop = (h: Grid, i: number) => h.state.grid.layout[i].y - h.els.gridScroll.scrollTop;
  const was = fromTop(g, 45);
  assert.ok(was >= 0 && was + 256 <= 700, `control: tile 45 is on screen, ${was} px from the top`);
  g.els.gridScroll.clientWidth = 1220 - 330; // the pane took its width…
  await g.renderGrid(); // …and the resize it replays re-flows the Grid
  assert.ok(g.state.grid.layout[45].y > 2948, 'control: three to a row now — the tile really moved down the grid');
  assert.equal(fromTop(g, 45), was, 'the clicked tile is where it was on screen');
  g.els.gridScroll.clientWidth = 1220; // the pane closes
  await g.renderGrid();
  assert.equal(fromTop(g, 45), was, 'and stays there as the Grid widens again');

  // A Grid scrolled to its foot. Three to a row, the clicked tile sits lower
  // than the shorter Grid could scroll: restored before the Grid grew to its
  // new height, the scroll stops short and the tile lands below the window.
  const foot = gridHarness();
  const sixty: Node[] = [];
  for (let i = 0; i < 60; i++) sixty.push(file('/r', `Clip${i}.mov`, 1000));
  foot.state.root!.children = sixty;
  for (const k of sixty) foot.state.pathIndex.set(k.path, k);
  foot.els.gridScroll.clientHeight = 700;
  await foot.renderGrid(); // fifteen rows, 4020 px: it scrolls 3340 px at most
  foot.els.gridScroll.scrollTop = 3300;
  assert.equal(foot.els.gridScroll.scrollTop, 3300, 'control: within what the Grid can scroll');
  foot.onCellClick({}, 52); // y 3484–3740
  const atFoot = fromTop(foot, 52);
  assert.ok(atFoot >= 0 && atFoot + 256 <= 700, `control: tile 52 is on screen, ${atFoot} px from the top`);
  foot.els.gridScroll.clientWidth = 890; // the pane opens
  await foot.renderGrid();
  assert.ok(foot.state.grid.layout[52].y - atFoot > 3340, 'control: the tile now needs more scroll than the four-to-a-row Grid had');
  assert.equal(fromTop(foot, 52), atFoot, 'the clicked tile is where it was, the Grid grown to hold the scroll first');

  // The anchor scrolled out of view: the first tile in view keeps its place
  // (a sidebar fold, a window resize), and the off-screen anchor is not pulled
  // in. "In view" is any of it: tile 44 is cut by the top, tile 48 is the
  // first wholly on screen, and three to a row they sit one row further apart
  // than they did (rows 14 and 16, not 11 and 12), so keeping the wrong one
  // moves tile 44.
  const h = gridHarness();
  tallPlant(h);
  h.els.gridScroll.clientHeight = 700;
  await h.renderGrid();
  h.onCellClick({ metaKey: true }, 2); // the anchor, on the first row
  h.els.gridScroll.scrollTop = 3000; // then on down: tile 44 (y 2948–3204) is the first in view
  const first = fromTop(h, 44);
  assert.ok(first < 0 && first + 256 > 0, `control: tile 44 is partly above the top (${first} px)`);
  assert.ok(fromTop(h, 48) >= 0, 'control: tile 48 is the first wholly on screen');
  h.els.gridScroll.clientWidth = 890;
  await h.renderGrid();
  assert.equal(fromTop(h, 44), first, 'the first tile in view keeps its place, partly above the top as it was');

  // A new order is not a re-flow: another file holds that position, so
  // nothing is kept in place. It starts at its top (review F1.4): left where
  // it was, the Grid — its own scroller since QA D01 — showed the middle of
  // the new order, its first entries off the top.
  const s = gridHarness();
  const kids: Node[] = [];
  for (let i = 0; i < 400; i++) kids.push(file('/r', `Clip${i}.mov`, i % 2 ? 10 : 1000)); // big and small, alternating
  s.state.root!.children = kids;
  for (const k of kids) s.state.pathIndex.set(k.path, k);
  s.els.gridScroll.clientHeight = 700;
  await s.renderGrid();
  s.els.gridScroll.scrollTop = 2800;
  const before = s.state.grid.layout[40];
  s.state.grid.sort = 'name';
  await s.renderGrid();
  assert.ok(s.state.grid.layout[40].it.path !== before.it.path && s.state.grid.layout[40].y !== before.y,
    'control: by name, another file holds position 40, at another height');
  assert.equal(s.els.gridScroll.scrollTop, 0, 'the new order starts at its top');
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
  // The Grid rebuilds its tiles as the bar goes down: the same tile's new
  // element holds the focus (review F1.5).
  assert.ok(FOCUS.active && h.els.gridInner.children.includes(FOCUS.active), 'focus on a tile stays on a tile in the Grid');
  assert.equal(String(FOCUS.active!.dataset.i), String(tile.dataset.i), 'that tile');
});

/**
 * The Grid with a tile selected and keyboard focus on the selection bar's
 * Clear, then `view` brought up through the page's own switchView, with
 * `controls` in it (screenOf). switchView hides the Grid, so its scroller
 * has no height and no tile is on screen; the bar goes with it (D03).
 */
async function selectionThenLeave(view: string, controls: FakeEl[]): Promise<{ g: Grid; tab: FakeEl }> {
  const g = gridHarness();
  await g.renderGrid();
  g.onCellClick({ metaKey: true }, 1);
  assert.ok(g.els.selectionBar.cls.has('visible'), 'control: the bar is up in the Grid');
  const { tab, gridView, section } = screenOf(g, view, controls);
  g.els.selClearBtn.focus(); // a keyboard user in the bar
  g.els.gridScroll.clientHeight = 0;
  g.switchView(view);
  // The page's own toggles did it: the Grid is hidden now, and the view and its tab are up.
  assert.ok(gridView.hidden && !gridView.cls.has('active') && !section.hidden && section.cls.has('active'), `control: switchView brought ${view} up`);
  assert.equal(tab.attrs['aria-selected'], 'true', `control: and selected ${view}'s tab`);
  return { g, tab };
}

/**
 * The document behind `g`'s queries as it stands when `view` is asked for
 * — before switchView, as the page has it (review F1.5 of D03): the Grid is
 * the view on screen, `<section class="view active">` with its filter box
 * in it, and its sidebar tab is the selected one; `view`'s section is there,
 * hidden, holding `controls` in document order. Only the page's own
 * switchView turns that around, so a call made before its toggles finds the
 * Grid's controls, as it would in the window. Anything that is not a
 * control — the section itself, a wrapper, a label — is in the tree too, so
 * a selector that matched it would find it.
 */
function screenOf(g: Grid, view: string, controls: FakeEl[]): { tab: FakeEl; gridView: FakeEl; section: FakeEl } {
  const body = g.screen.body;
  const nav = fakeEl('', 'nav'); nav.cls.add('tabbar');
  const gridTab = fakeEl('tabGrid', 'button', { 'aria-selected': 'true' }); gridTab.dataset.view = 'grid';
  const tab = fakeEl(`tab-${view}`, 'button', { 'aria-selected': 'false' }); tab.dataset.view = view;
  nav.appendChild(gridTab); nav.appendChild(tab);
  g.screen.tabs.push(gridTab, tab); // the sidebar tabs switchView marks
  const gridView = fakeEl('view-grid', 'section'); gridView.cls.add('view'); gridView.cls.add('active');
  gridView.appendChild(g.els.gridSearch); // the filter box: in the Grid, on screen until switchView hides it
  const section = fakeEl(`view-${view}`, 'section'); section.cls.add('view'); section.hidden = true;
  const wrap = fakeEl('', 'div'); // a toolbar row: not a control, and its controls are still in the view
  for (const c of controls) wrap.appendChild(c);
  section.appendChild(wrap);
  body.appendChild(nav); body.appendChild(gridView); body.appendChild(section);
  return { tab, gridView, section };
}

test('the selection bar is the Grid’s: it leaves with the Grid, and comes back with it, its selection kept (D03)', async () => {
  // QA third pass D03: "1 item selected — 1.7 MB · Offload… · Move to Trash
  // · Clear" stayed up on the Dashboard, on the Treemap beside the map's own
  // selection and behind the Autopilot editor — a selection none of them
  // shows — and ⌘⌫ there opened a Trash sheet for it.
  for (const view of ['dashboard', 'treemap', 'autopilot']) {
    const { g } = await selectionThenLeave(view, [fakeEl(`${view}Btn`, 'button')]);
    assert.ok(!g.els.selectionBar.cls.has('visible'), `${view}: the bar left with the Grid`);
    assert.equal(g.state.grid.selection.size, 1, `${view}: the selection itself is the Grid's, kept for its return`);
    g.switchView('grid');
    assert.ok(g.els.selectionBar.cls.has('visible'), `${view}: back in the Grid, its bar is back with it`);
    assert.match(g.els.selInfo.innerHTML, /<b>1<\/b> item selected/, `${view}: saying what it holds`);
  }
});

test('focus in the selection bar as the Grid leaves goes to the view on screen, or to its tab — never to <body> or the hidden filter box (D03; B13 review F2.4, F3.2)', async () => {
  // The bar goes with the Grid now (D03), so focus in it — on Clear, Move to
  // Trash — goes somewhere the keyboard can carry on from, as Clear's own
  // door has done since B13: the filter box inside the hidden Grid is a
  // no-op focus in a browser, and focus would fall to <body> with the bar.
  // Review F3.2: the document the page queries answers its own selector,
  // and the first control on screen is not a button — the Dashboard's
  // "What's new" strip is a div in the tab order.
  const offscreen = fakeEl('dashOffscreen', 'button'); offscreen.hidden = true;
  const disabled = fakeEl('dashDisabled', 'button'); disabled.disabled = true;
  await selectionThenLeave('dashboard', [
    offscreen, disabled,
    fakeEl('dashCard', 'div', { tabindex: '-1' }), // focusable by script only: not a stop in the tab order
    fakeEl('dashLabel', 'span'),
    fakeEl('whatsNewBody', 'div', { role: 'button', tabindex: '0' }),
    fakeEl('dashRescan', 'button'),
  ]);
  assert.equal(FOCUS.active?.id, 'whatsNewBody', 'the first enabled control on screen in the view that is up');
  assert.deepEqual(FOCUS.opts, { preventScroll: true }, 'without scrolling it');

  // A view with nothing to offer (its capability notice instead of controls): its sidebar tab.
  const { tab } = await selectionThenLeave('apps', [fakeEl('appsNotice', 'p')]);
  assert.equal(FOCUS.active, tab, 'the selected sidebar tab, when the view has no control on screen');

  // Focus anywhere else is left where it is: a click on a sidebar tab has put it there.
  const g = gridHarness();
  await g.renderGrid();
  g.onCellClick({ metaKey: true }, 1);
  const { tab: own } = screenOf(g, 'dashboard', [fakeEl('dashRescan', 'button')]);
  own.focus();
  g.switchView('dashboard');
  assert.equal(FOCUS.active, own, 'focus outside the bar stays where it is');
});

test('every kind of control the page counts can take focus as the bar leaves with the Grid — a button, a text box, a menu, anything in the tab order (B13 review F3.2)', async () => {
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
    const only = make();
    await selectionThenLeave('city', [fakeEl('', 'span'), fakeEl('', 'canvas', { tabindex: '-1' }), only]);
    assert.equal(FOCUS.active, only, `${kind}: focus lands on it (got ${FOCUS.active ? `${FOCUS.active.tagName}#${FOCUS.active.id}` : 'nothing'})`);
  }
});

/* ══════════════ D01 — the Grid is its own scroller, bounded by the window ══════════════ */

/** A length from the sheet — px, vh, vw and calc() sums of them — in a W×H window. */
function sheetLen(v: string, W: number, H: number): number {
  const e = v.trim()
    .replace(/(-?\d*\.?\d+)vh/g, (_m, n: string) => String((Number(n) * H) / 100))
    .replace(/(-?\d*\.?\d+)vw/g, (_m, n: string) => String((Number(n) * W) / 100))
    .replace(/(-?\d*\.?\d+)px/g, '$1')
    .replace(/\bcalc\(/g, '(');
  assert.match(e, /^[\s\d.+\-*/()]*$/, `"${v}" is plain arithmetic once resolved`);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return Function(`"use strict"; return (${e});`)() as number;
}

/** One side of a padding shorthand, in px: 0 top, 1 right, 2 bottom, 3 left. */
function padSide(v: string | undefined, side: number, what: string): number {
  const p = (v || '').trim().split(/\s+/);
  const pick = [p[0], p[1] ?? p[0], p[2] ?? p[0], p[3] ?? p[1] ?? p[0]][side];
  return pick === '0' ? 0 : px(pick, what);
}

/** What one Grid element computes to: its own rule, then those for the cart and the selection bar being up, by specificity. */
function gridDecls(selector: string, page: { cart: boolean; bar?: boolean }): Map<string, string> {
  return new Map([...declsOf(selector),
    ...(page.cart ? declsOf(`body:has(#cartDock.show) ${selector}`) : []),
    ...(page.bar ? declsOf(`body:has(#selectionBar.visible) ${selector}`) : []),
    ...(page.bar && page.cart ? declsOf(`body:has(#selectionBar.visible):has(#cartDock.show) ${selector}`) : [])]);
}

/** A declared value with its var(--x)s read from the same rule set — the Grid's scroller sets its own (--grid-foot, review F2.5). */
function withVars(v: string | undefined, d: Map<string, string>): string | undefined {
  return v?.replace(/var\((--[\w-]+)\)/g, (_m, name: string) => {
    assert.ok(d.has(name), `${name} is set on the element that reads it`);
    return d.get(name)!;
  });
}

/** The Grid scroller's top and bottom padding, in px, as the sheet computes them for that page. */
function scrollerPads(page: { cart: boolean; bar: boolean }): { top: number; bottom: number } {
  const sc = gridDecls('#gridScroll', page);
  return {
    top: padSide(sc.get('padding'), 0, 'the scroller\'s top padding'),
    bottom: sc.has('padding-bottom') ? px(withVars(sc.get('padding-bottom'), sc), 'the scroller\'s bottom padding') : padSide(sc.get('padding'), 2, 'the scroller\'s bottom padding'),
  };
}

/** The flex-grow a rule set gives an item: `flex-grow`, else the `flex` shorthand's first number (`none` and the initial value are 0, `auto` is 1). */
function flexGrow(d: Map<string, string>): number {
  if (d.has('flex-grow')) return Number(d.get('flex-grow'));
  const f = (d.get('flex') || 'initial').trim();
  if (f === 'auto') return 1;
  const n = Number(f.split(/\s+/)[0]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The Grid's scroller as the stylesheet lays it out in a window H px tall.
 * #view-grid.active is a flex column inside <main>; its toolbar is one row of
 * the page's 30 px controls and its own bottom margin; #gridScroll (flex: 1)
 * takes what the view has left. A view with no height of its own — only a
 * min-height — is as tall as what it holds, so its scroller then grows to its
 * tiles plus its padding instead of scrolling them: what QA measured, a
 * scroller 1,123,657 px tall with nothing to scroll (D01).
 * The view hands its height to the scroller only as a flex column the
 * scroller grows in; as a block (`.view.active`) the scroller is as tall as
 * its tiles whatever height the view has. That layout is not modelled, so it
 * is refused here rather than answered as if it were a column (review F1.7).
 * A toolbar on two rows only shortens the scroller, which no claim made with
 * this depends on.
 */
function sheetScrollerH(W: number, H: number, page: { cart: boolean; bar: boolean }, innerH: number): number {
  const view = gridDecls('#view-grid.active', page);
  const scroller = gridDecls('#gridScroll', page);
  assert.match(view.get('display') || '', /^(inline-)?flex$/, `the Grid view lays its toolbar and scroller out as flex items (display: ${view.get('display') ?? 'unset, so .view.active\'s block'})`);
  assert.equal(view.get('flex-direction'), 'column', 'in a column, so its height is shared down the page');
  assert.ok(flexGrow(scroller) > 0, `and the scroller grows into what the toolbar leaves (flex: ${scroller.get('flex') ?? 'unset'})`);
  const pads = scrollerPads(page);
  const content = gridToolbarH() + innerH + pads.top + pads.bottom;
  let viewH = view.has('height') ? sheetLen(view.get('height')!, W, H) : Math.max(view.has('min-height') ? sheetLen(view.get('min-height')!, W, H) : 0, content);
  if (view.has('max-height')) viewH = Math.min(viewH, sheetLen(view.get('max-height')!, W, H));
  const floor = scroller.has('min-height') ? sheetLen(scroller.get('min-height')!, W, H) : 0;
  return Math.max(floor, viewH - gridToolbarH());
}

/** The Grid toolbar on one row: the page's 30 px controls and the toolbar's bottom margin. */
function gridToolbarH(): number {
  return px(declsOf('.btn').get('min-height'), 'a toolbar control\'s height') +
    px(declsOf('.grid-toolbar').get('margin-bottom'), 'the Grid toolbar\'s bottom margin');
}

/**
 * Give a harness's scroller the height the stylesheet gives it, in a W×H
 * window and the column the sidebar leaves — and no scroll at all unless the
 * sheet lets its content overflow into one.
 */
function sizeFromSheet(g: Grid, W: number, H: number, cart: boolean): void {
  const sc = g.els.gridScroll;
  g.page.cart = cart;
  // The scroller's box: the expanded sidebar and its margin, then <main>'s
  // side padding. Its clientWidth is that less the page's scrollbar while it
  // shows one (review F1.9) — always, with a stable gutter; else only once
  // its content overflows it.
  let boxW = W - 244 - 48;
  const barW = () => (scrollerShowsBar(g, cart) ? px(declsOf('::-webkit-scrollbar').get('width'), "the page's scrollbar width") : 0);
  Object.defineProperty(sc, 'clientWidth', { configurable: true, get: () => boxW - barW(), set: (v: number) => { boxW = v + barW(); } });
  Object.defineProperty(sc, 'clientHeight', {
    configurable: true,
    get: () => sheetScrollerH(W, H, { cart, bar: g.els.selectionBar.cls.has('visible') }, parseFloat(g.els.gridInner.style.height) || 0),
  });
  if (!/^(auto|scroll)$/.test(gridDecls('#gridScroll', { cart }).get('overflow-y') || '')) {
    Object.defineProperty(sc, 'scrollTop', { configurable: true, get: () => 0, set: () => {} });
  }
}

/** Whether the Grid's scroller shows its scrollbar: a stable gutter always does; else an auto scroller whose content overflows it. */
function scrollerShowsBar(g: Grid, cart: boolean): boolean {
  const sc = gridDecls('#gridScroll', { cart });
  if (/^stable\b/.test(sc.get('scrollbar-gutter') || '')) return true;
  if (!/^(auto|scroll)$/.test(sc.get('overflow-y') || '')) return false;
  const pads = scrollerPads({ cart, bar: g.els.selectionBar.cls.has('visible') });
  return (parseFloat(g.els.gridInner.style.height) || 0) + pads.top + pads.bottom > g.els.gridScroll.clientHeight;
}

/** A folder of `n` files of one size, so every tile is the largest (256 px) and the rows are regular. */
function evenPlant(g: Grid, n: number): void {
  const kids: Node[] = [];
  for (let i = 0; i < n; i++) kids.push(file('/r', `f${String(i).padStart(5, '0')}.bin`, 4096));
  g.state.root!.children = kids;
  for (const k of kids) g.state.pathIndex.set(k.path, k);
}

test('the Grid scrolls inside itself, bounded by the window: a 25,600-file folder builds only the tiles near the view, and a re-flow keeps the clicked tile in place (D01, C04)', async () => {
  // QA: #gridScroll grew to 1,123,657 px — every tile's height — so it had
  // nothing to scroll (scrollTop always 0) and <main> scrolled the page
  // instead. renderGridWindow, which builds only the tiles within 200 px of
  // the scroller's window, saw a window as tall as the folder and built all
  // 25,600 tiles (~2 s a visit); the toolbar scrolled away with the page; and
  // the keep-in-place re-flow read the scroller's scrollTop, so it never acted.
  const N = 25_600;
  for (const [W, H] of [[1440, 900], [1024, 700]]) {
    for (const cart of [false, true]) {
      const label = `${W}×${H}${cart ? ', cart up' : ''}`;
      const g = gridHarness({ raf: true });
      evenPlant(g, N);
      sizeFromSheet(g, W, H, cart);
      await g.renderGrid();
      const sc = g.els.gridScroll;
      const viewH = sc.clientHeight;
      const built = () => g.els.gridInner.children.length;
      const perRow = g.state.grid.layout.filter((c) => c.y === 0).length;
      const rowH = 256 + 12;
      // renderGridWindow builds what lies within 200 px above and below the
      // scroller's window, and that window is never taller than the window's.
      const most = perRow * (Math.ceil((H + 400) / rowH) + 1);
      assert.ok(built() <= most, `${label}: ${built()} of ${N} tiles are built; the window shows a few rows of ${perRow} (at most ${most})`);
      assert.ok(viewH < H, `${label}: the scroller is ${viewH} px tall — its window, not its ${g.state.grid.totalH} px of tiles`);

      // Scrolling the Grid moves its own window: half a million px down, the
      // tiles there are built and the first ones are gone.
      sc.scrollTop = 500_000;
      assert.equal(sc.scrollTop, 500_000, `${label}: the Grid itself scrolls that far`);
      for (const f of sc.listeners.scroll || []) f({});
      const drawn = g.els.gridInner.children.map((c) => Number(c.dataset.i));
      assert.ok(drawn.length > 0 && drawn.length <= most, `${label}: scrolled, ${drawn.length} tiles are built`);
      const first = g.state.grid.layout[Math.min(...drawn)];
      assert.ok(first.y + first.side >= 500_000 - 200 && first.y <= 500_000 + viewH, `${label}: and they are the ones at the scroll (first at y ${first.y})`);

      // C04: a plain click opens the pane, which narrows the page, and the
      // Grid re-flows into the narrower column. The clicked tile stays where
      // it was in the Grid's window — it can only if the Grid is the scroller.
      sc.scrollTop = 10 * rowH + 100; // row 10 is cut by the top of the window
      const i = 11 * perRow + perRow - 1; // the last tile of row 11, the first whole row on screen
      g.onCellClick({}, i);
      const fromTop = () => g.state.grid.layout[i].y - sc.scrollTop;
      const was = fromTop();
      assert.ok(was >= 0 && was + 256 <= viewH, `${label}: control — tile ${i} is wholly on screen, ${was} px down the Grid's window`);
      const yWas = g.state.grid.layout[i].y;
      sc.clientWidth -= 330; // the pane takes its width…
      await g.renderGrid(); // …and the resize it replays re-flows the Grid
      assert.ok(g.state.grid.layout[i].y > yWas, `${label}: control — fewer to a row, the tile moved down the Grid (${yWas} → ${g.state.grid.layout[i].y})`);
      assert.equal(fromTop(), was, `${label}: the clicked tile is where it was on screen`);
    }
  }
});

/* ══════════════ C04 remainder (b) — a clicked tile is never left under the bars its click raised ══════════════ */

/**
 * Where a tile is in the window, top and bottom, in a W×H window: <main>'s top
 * padding and the toolbar row are above the scroller, then its own padding.
 */
function tileInWindow(g: Grid, i: number): { top: number; bottom: number } {
  const c = g.state.grid.layout[i];
  const main = padSide(declsOf('main').get('padding'), 0, "<main>'s top padding");
  const top = main + gridToolbarH() + scrollerPads({ cart: g.page.cart, bar: g.els.selectionBar.cls.has('visible') }).top + c.y - g.els.gridScroll.scrollTop;
  return { top, bottom: top + c.side };
}

/** The cart pill's top edge in an H px window while the selection bar is up: the dock's lifted bottom plus the pill's height. */
function pillTopWhileBarUp(H: number): number {
  const tab = declsOf('#cartTab');
  const pillH = 2 * padSide(tab.get('padding'), 0, "the pill's padding") + 2 + Math.max(17, px(tab.get('font-size'), "the pill's font") * 1.35);
  return H - px(declsOf('body:has(#selectionBar.visible) #cartDock').get('bottom'), "the dock's lifted bottom") - pillH;
}

/** Eight of the largest tiles, then three a third their size: two full rows and a short last one. */
function picturesPlant(g: Grid): void {
  const big = 1e9, kids: Node[] = [];
  for (let i = 0; i < 8; i++) kids.push(file('/r', `photos_${String(i).padStart(6, '0')}.raw`, big));
  for (let i = 8; i < 11; i++) kids.push(file('/r', `photos_${String(i).padStart(6, '0')}.tiff`, big * 0.365));
  g.state.root!.children = kids;
  for (const k of kids) g.state.pathIndex.set(k.path, k);
}

test('a tile clicked at the foot of the Grid is brought clear of the selection bar and the cart pill its click raised — the pane opening on it, or not (C04 remainder b)', async () => {
  // QA: at 1440×900 with something staged, Grid › Pictures, a plain click on
  // a last-row photo opens the pane; the same click raises the selection bar
  // and the pill steps up above it. The re-flow kept the tile where it was —
  // which was now under the pill.
  const W = 1440, H = 900;
  const g = gridHarness();
  picturesPlant(g);
  sizeFromSheet(g, W, H, true);
  await g.renderGrid();
  const last = g.state.grid.layout.length - 1;
  const pill = pillTopWhileBarUp(H);
  g.onCellClick({ metaKey: true }, 0); // a selection is already up: the bar stands, the pill above it
  assert.equal(g.els.gridScroll.scrollTop, 0, 'a ⌘-click that raises the bar over the foot scrolls nothing for a tile clear of it');
  assert.ok(tileInWindow(g, last).bottom > pill, `control: the last tile reaches y ${tileInWindow(g, last).bottom}, below the pill's top (${pill.toFixed(0)}) — beside the bar and the pill, where a click finds it`);
  g.onCellClick({}, last); // a plain click on a file: it is selected and the pane opens…
  g.els.gridScroll.clientWidth -= 330; // …narrowing the page…
  await g.renderGrid(); // …and the Grid re-flows into it
  let at = tileInWindow(g, last);
  assert.ok(at.bottom <= pill, `the clicked tile ends at y ${at.bottom}; the pill starts at ${pill.toFixed(1)}`);

  // The pane already open and nothing selected: the click raises the bar
  // with no re-flow, and the tile under it is brought clear all the same.
  const p = gridHarness();
  picturesPlant(p);
  sizeFromSheet(p, W, H, true);
  p.els.gridScroll.clientWidth -= 330;
  await p.renderGrid();
  const pLast = p.state.grid.layout.length - 1;
  p.els.gridScroll.scrollTop = 10_000; // scrolled to the end: the last tile is on screen, at the foot
  const gridFoot = padSide(declsOf('main').get('padding'), 0, "<main>'s top padding") + gridToolbarH() + p.els.gridScroll.clientHeight;
  assert.ok(tileInWindow(p, pLast).bottom <= gridFoot, 'control: the last tile is wholly on screen to be clicked');
  assert.ok(tileInWindow(p, pLast).bottom > pill, 'control: and it reaches below where the pill will stand');
  p.onCellClick({}, pLast);
  at = tileInWindow(p, pLast);
  assert.ok(at.bottom <= pill, `with the pane already open the clicked tile ends at y ${at.bottom}; the pill starts at ${pill.toFixed(1)}`);

  // Mid-way down a long folder, where the Grid could scroll much further: a
  // ⌘-click that raises the bar moves the tile just clear, no further.
  const t = gridHarness();
  evenPlant(t, 400);
  sizeFromSheet(t, W, H, true);
  await t.renderGrid();
  t.els.gridScroll.scrollTop = 20 * 268; // row 20 at the top: rows 22 and 23 are near the foot
  const k = 22 * 4;
  assert.ok(tileInWindow(t, k).bottom > pill && tileInWindow(t, k).top < pill, `control: tile ${k} straddles where the pill will stand (y ${tileInWindow(t, k).top}–${tileInWindow(t, k).bottom})`);
  t.onCellClick({ metaKey: true }, k);
  at = tileInWindow(t, k);
  assert.ok(at.bottom <= pill, `the ⌘-clicked tile ends at y ${at.bottom}; the pill starts at ${pill.toFixed(1)}`);
  assert.ok(at.bottom >= pill - 20, `and the Grid moved no further than that (the tile ends at y ${at.bottom})`);

  // The first case again, deep in a scrolled Grid (review F2.2): the bar is
  // already up, so the plain click scrolls nothing, and the pane it opens
  // narrows the page. The re-flow knows the tile as the one just clicked by
  // where the click left it in the Grid's window — its place in the list
  // less the scroll, which at the top of a Grid is no different from its
  // place in the list.
  const s = gridHarness();
  evenPlant(s, 400);
  sizeFromSheet(s, W, H, true);
  await s.renderGrid();
  s.onCellClick({ metaKey: true }, 0); // a selection is already up: the bar stands, the pill above it
  s.els.gridScroll.scrollTop = 20 * 268; // row 20 at the top: row 22 is at the foot
  const deep = 22 * 4;
  const scrolled = s.els.gridScroll.scrollTop;
  assert.ok(scrolled > 0, `control: the Grid is scrolled (${scrolled} px)`);
  assert.ok(tileInWindow(s, deep).bottom > pill && tileInWindow(s, deep).top < pill, `control: tile ${deep} straddles where the pill stands (y ${tileInWindow(s, deep).top}–${tileInWindow(s, deep).bottom})`);
  s.onCellClick({}, deep); // a plain click on a file: it is selected and the pane opens…
  assert.equal(s.els.gridScroll.scrollTop, scrolled, 'control: with the bar already up, the click itself scrolls nothing');
  s.els.gridScroll.clientWidth -= 330; // …narrowing the page…
  await s.renderGrid(); // …and the Grid re-flows into it
  at = tileInWindow(s, deep);
  assert.ok(at.bottom <= pill, `scrolled ${scrolled} px down a long folder, the clicked tile ends at y ${at.bottom}; the pill starts at ${pill.toFixed(1)}`);

  // A click made while the bar was already up scrolls nothing: the tile was
  // where the pointer found it, beside the bars.
  const q = gridHarness();
  picturesPlant(q);
  sizeFromSheet(q, W, H, true);
  await q.renderGrid();
  q.onCellClick({ metaKey: true }, 0);
  assert.equal(q.els.gridScroll.scrollTop, 0, 'control: nothing is scrolled');
  q.onCellClick({ metaKey: true }, q.state.grid.layout.length - 1);
  assert.equal(q.els.gridScroll.scrollTop, 0, 'a ⌘-click with the bar already up scrolls nothing under the pointer');
});

/* ══════════════ review F1.1, F1.4 — another list starts at its top ══════════════ */

/** /r: `n` files of one size, then folder A (`m` files of the same size) as the last tile. */
function deepPlant(g: Grid, n: number, m: number): void {
  evenPlant(g, n);
  const inA: Node[] = [];
  for (let i = 0; i < m; i++) inA.push(file('/r/A', `a${String(i).padStart(5, '0')}.bin`, 4096));
  const a: Node = { name: 'A', path: '/r/A', size: 4096, type: 'dir', children: inA };
  g.state.root!.children!.push(a);
  for (const k of [a, ...inA]) g.state.pathIndex.set(k.path, k);
}

test('a folder opened, Up, a crumb, a filter or a sort shows the new list from its top; a re-flow of the same list keeps its place (review F1.1, F1.4)', async () => {
  // Since the Grid is its own scroller (D01), its toolbar stays on screen and
  // all of these are made from deep in a folder. Nothing reset the scroller:
  // the browser only clamped the old offset to the new list, so a folder
  // opened at its last rows, and a filter or a sort hid its first, largest
  // matches off the top.
  const g = gridHarness({ raf: true });
  deepPlant(g, 300, 400);
  sizeFromSheet(g, 1440, 900, false);
  await g.renderGrid();
  const sc = g.els.gridScroll;
  const scroll = (to: number) => { sc.scrollTop = to; for (const f of sc.listeners.scroll || []) f({}); };
  const fresh = (what: string) => {
    assert.equal(sc.scrollTop, 0, `${what}: the Grid opens at its top (scrollTop ${sc.scrollTop})`);
    const drawn = g.els.gridInner.children.map((c) => Number(c.dataset.i));
    assert.equal(Math.min(...drawn), 0, `${what}: and its first tile is drawn (the first drawn is ${Math.min(...drawn)})`);
  };

  // A folder tile clicked at the foot of a long folder.
  scroll(1e9);
  const folder = g.state.grid.layout.findIndex((c) => c.it.path === '/r/A');
  const top = g.state.grid.layout[folder].y - sc.scrollTop;
  assert.ok(sc.scrollTop > 10_000 && top >= 0 && top < sc.clientHeight, `control: deep in /r (scrollTop ${sc.scrollTop}), folder A is on screen`);
  g.onCellClick({}, folder);
  await g.settle();
  assert.equal(g.state.grid.path, '/r/A', 'control: the click opened A');
  fresh('a folder opened from the foot of its parent');

  // Up, from the end of that folder.
  scroll(1e9);
  assert.ok(sc.scrollTop > 10_000, `control: scrolled to the end of A (${sc.scrollTop})`);
  g.gridUp();
  await g.settle();
  assert.equal(g.state.grid.path, '/r', 'control: Up went back to /r');
  fresh('Up from the end of a folder');

  // A crumb, likewise.
  g.onCellClick({}, g.state.grid.layout.findIndex((c) => c.it.path === '/r/A'));
  await g.settle();
  scroll(1e9);
  g.crumbsCb.fn!('/r');
  await g.settle();
  fresh('a crumb clicked from the end of a folder');

  // A filter typed deep in the folder.
  scroll(1e9);
  const input = g.els.gridSearch.listeners.input![0];
  g.els.gridSearch.value = 'f001';
  input({ target: g.els.gridSearch });
  for (const fn of [...g.timers.values()]) fn();
  await g.settle();
  assert.equal(g.state.grid.layout.length, 100, 'control: the filter matched f00100–f00199');
  fresh('a filter typed deep in the folder');
  scroll(1e9);
  g.els.gridSearch.value = '';
  input({ target: g.els.gridSearch });
  for (const fn of [...g.timers.values()]) fn();
  await g.settle();
  fresh('the filter emptied');

  // A new order chosen deep in the folder.
  scroll(1e9);
  g.els.gridSort.listeners.change![0]({ target: { value: 'name' } });
  await g.settle();
  assert.equal(g.state.grid.sort, 'name', 'control: the order changed');
  fresh('a new order');

  // The same list re-flowed — the pane opening, the window resized — keeps its place.
  scroll(30 * 268);
  const at = sc.scrollTop;
  await g.renderGrid();
  assert.equal(sc.scrollTop, at, 'the same list drawn again keeps its place');
  sc.clientWidth -= 330;
  await g.renderGrid();
  assert.ok(sc.scrollTop > 0, `and re-flowed into a narrower column it is not sent to the top (scrollTop ${sc.scrollTop})`);
});

/* ══════════════ review F1.2 — a re-flow brings only the tile just clicked clear of the bars ══════════════ */

test('a re-flow with no click behind it never scrolls the Grid: an anchor left after Clear, or one the user scrolled to the foot, stays put (review F1.2)', async (t) => {
  // renderGrid brought ANY in-view anchor clear of the bars. The anchor
  // outlives Clear and every re-flow of the same list, and "in view" is any
  // of it, so a tile the user left 40 px showing at the foot was scrolled up
  // by most of its height on a window resize, a sidebar fold, the pane
  // opening or closing — with nothing clicked.
  const W = 1440, H = 900, k = 21 * 4; // a tile on row 21, mid-window once scrolled to row 20
  for (const clear of [true, false]) {
    for (const cart of [false, true]) {
      for (const narrower of [false, true]) {
        const label = `${clear ? 'after Clear' : 'the bar still up'}${cart ? ', cart up' : ''}, ${narrower ? 'a narrowing re-flow' : 'a re-flow at the same width'}`;
        await t.test(label, async () => {
          const g = gridHarness();
          evenPlant(g, 400);
          sizeFromSheet(g, W, H, cart);
          await g.renderGrid();
          const sc = g.els.gridScroll;
          sc.scrollTop = 20 * 268;
          g.onCellClick({}, k); // a plain click: selected, the anchor, the bar up
          assert.equal(g.state.grid.anchor, k, 'control: the click set the anchor');
          assert.equal(sc.scrollTop, 20 * 268, 'control: a tile mid-window is not scrolled by its click');
          if (clear) g.els.selClearBtn.listeners.click![0]({});
          assert.equal(g.els.selectionBar.cls.has('visible'), !clear, `control: the bar is ${clear ? 'down' : 'up'}`);
          // The user scrolls on, until 40 px of the tile show at the foot.
          const padTop = scrollerPads({ cart, bar: !clear }).top;
          sc.scrollTop = padTop + g.state.grid.layout[k].y - sc.clientHeight + 40;
          const shows = sc.clientHeight - (padTop + g.state.grid.layout[k].y - sc.scrollTop);
          assert.equal(shows, 40, 'control: 40 px of the anchor show at the foot of the Grid');
          const was = g.state.grid.layout[k].y - sc.scrollTop, yWas = g.state.grid.layout[k].y;
          if (narrower) sc.clientWidth -= 330; // the pane opening on another view's file, the sidebar unfolding
          await g.renderGrid();
          if (narrower) assert.ok(g.state.grid.layout[k].y > yWas, `control: fewer to a row, the anchor moved down the Grid (${yWas} → ${g.state.grid.layout[k].y})`);
          assert.equal(g.state.grid.layout[k].y - sc.scrollTop, was, `${label}: the anchor stays where the user left it, not pulled up`);
        });
      }
    }
  }

  // Clicked and not scrolled since, but the bars are down: nothing to clear
  // it of. A tile clicked beside the bars, 15 px above the Grid's foot, then
  // Clear, then a re-flow.
  await t.test('clicked beside the bars, then Clear', async () => {
    const g = gridHarness();
    evenPlant(g, 400);
    sizeFromSheet(g, W, H, false);
    await g.renderGrid();
    const sc = g.els.gridScroll;
    g.onCellClick({ metaKey: true }, 0); // the bar goes up for tile 0, far above
    sc.scrollTop = 10 + g.state.grid.layout[k].y + 256 - (sc.clientHeight - 15);
    const at = sc.scrollTop;
    g.onCellClick({}, k); // the bar was up: the tile is where the pointer found it
    assert.equal(sc.scrollTop, at, 'control: a click with the bar already up scrolls nothing');
    g.els.selClearBtn.listeners.click![0]({});
    await g.renderGrid();
    assert.equal(sc.scrollTop, at, 'with the bars down, a re-flow does not move the tile just clicked');
  });
});

/* ══════════════ review F1.5 — a focused tile keeps focus across a windowed rebuild ══════════════ */

test('a tile with keyboard focus keeps it when the Grid rebuilds the tiles around it — Tab into the margin, a wheel scroll, a re-flow, a click (review F1.5)', async () => {
  // Since the Grid really scrolls (D01), a scroll that moves its window
  // rebuilds every tile with replaceChildren. A tile tabbed to in the margin
  // below the foot is scrolled into view by the browser, the rebuild detached
  // it, and focus fell to <body>: Tab could not get past the first screenful.
  const g = gridHarness({ raf: true });
  evenPlant(g, 400);
  sizeFromSheet(g, 1440, 900, false);
  await g.renderGrid();
  const sc = g.els.gridScroll;
  const tile = (i: number) => g.els.gridInner.children.find((c) => Number(c.dataset.i) === i);
  const scroll = (to: number) => { sc.scrollTop = to; for (const f of sc.listeners.scroll || []) f({}); };
  const focusedOn = (i: number, what: string) => {
    const el = FOCUS.active;
    assert.ok(el && g.els.gridInner.children.includes(el), `${what}: focus is on a tile in the Grid (it is on ${el ? `${el.tagName}.${el.className} data-i ${el.dataset.i}` : 'nothing'}, detached or elsewhere)`);
    assert.equal(Number(el!.dataset.i), i, `${what}: the same tile, ${i}`);
    assert.deepEqual(FOCUS.opts, { preventScroll: true }, `${what}: and moving it scrolled nothing`);
  };

  // Tab reaches tile 15, built in the margin below the foot; the browser
  // scrolls it into view, which moves the Grid's window.
  const last = Math.max(...g.els.gridInner.children.map((c) => Number(c.dataset.i)));
  assert.equal(last, 15, 'control: tiles 0–15 are built at the top, the last row in the margin below the foot');
  tile(15)!.focus();
  scroll(10 + g.state.grid.layout[15].y + 256 - sc.clientHeight);
  assert.ok(g.state.grid.rangeEnd >= 19, `control: the scroll moved the Grid's window down a row, for the next Tab (to tile ${g.state.grid.rangeEnd}), so its tiles were rebuilt`);
  focusedOn(15, 'tabbed into the margin and scrolled into view');

  // A wheel scroll that takes the focused tile far out of the window: it
  // stays built, first in the Grid so the next Tab reaches the tiles on screen.
  scroll(50 * 268);
  assert.ok(g.state.grid.rangeStart > 15, `control: the window is far below tile 15 (from ${g.state.grid.rangeStart})`);
  focusedOn(15, 'scrolled far away by the wheel');
  assert.equal(Number(g.els.gridInner.children[0].dataset.i), 15, 'it is the Grid\'s first tile');
  assert.equal(Number(g.els.gridInner.children[1].dataset.i), g.state.grid.rangeStart, 'and the tiles in the window follow it');

  // A re-flow of the same list, and a ⌘-click on the focused tile.
  scroll(0);
  focusedOn(15, 'scrolled back');
  sc.clientWidth -= 330;
  await g.renderGrid();
  focusedOn(15, 'the Grid re-flowed into a narrower column');
  g.onCellClick({ metaKey: true }, 15);
  focusedOn(15, 'a ⌘-click (or ⌘-Space) on it');

  // The window's own first and last tiles (review F2.3). A focused tile in
  // the window is built by the window, once, and keeps the focus: queued
  // ahead of the window as well, Tab onto the first tile then Space — the
  // commonest keyboard flow — built it twice, two tiles stacked and two tab
  // stops for one file.
  const b = gridHarness({ raf: true });
  evenPlant(b, 400);
  sizeFromSheet(b, 1440, 900, false);
  await b.renderGrid();
  const bsc = b.els.gridScroll;
  const edges: [string, number, 'rangeStart' | 'rangeEnd'][] = [
    ['the first tile, at the top of the Grid', 0, 'rangeStart'],
    ['the window\'s first tile, scrolled down', 20 * 268, 'rangeStart'],
    ['the window\'s last tile', 20 * 268, 'rangeEnd'],
  ];
  for (const [what, to, edge] of edges) {
    bsc.scrollTop = to; for (const f of bsc.listeners.scroll || []) f({});
    const i = b.state.grid[edge];
    if (to > 0 && edge === 'rangeStart') assert.ok(i > 0, `control: scrolled, the window starts further down (tile ${i})`);
    b.els.gridInner.children.find((c) => Number(c.dataset.i) === i)!.focus();
    b.onCellClick({ metaKey: true }, i); // Space on it: the Grid rebuilds its tiles
    const built = b.els.gridInner.children.map((c) => Number(c.dataset.i));
    assert.equal(new Set(built).size, built.length, `${what} (${i}) focused, then a rebuild: each tile is built once (built ${built.slice(0, 5).join(', ')} … ${built.slice(-3).join(', ')})`);
    assert.equal(built.filter((n) => n === i).length, 1, `${what}: tile ${i} among them, once`);
    const el = FOCUS.active;
    assert.ok(el && b.els.gridInner.children.includes(el) && Number(el.dataset.i) === i, `${what}: focus stays on tile ${i} (it is on ${el ? `data-i ${el.dataset.i}` : 'nothing'})`);
  }

  // A folder opened from the keyboard is another list: no tile of it takes
  // the focus that was on the folder's tile.
  const h = gridHarness({ raf: true });
  deepPlant(h, 3, 400);
  sizeFromSheet(h, 1440, 900, false);
  await h.renderGrid();
  const folder = h.state.grid.layout.findIndex((c) => c.it.path === '/r/A');
  h.els.gridInner.children.find((c) => Number(c.dataset.i) === folder)!.focus();
  h.onCellClick({}, folder);
  await h.settle();
  assert.equal(h.state.grid.path, '/r/A', 'control: the folder opened');
  assert.ok(!h.els.gridInner.children.includes(FOCUS.active!), `no tile of the new folder takes focus (data-i ${FOCUS.active?.dataset.i})`);
});

/* ══════════════ review F2.4 — a tile is a button, wired to its own file ══════════════ */

test('every tile is a button in the Tab order, and its own click, Enter and Space select that tile’s file — never a neighbour’s — with the Shift, ⌘ or Ctrl the click carries (review F2.4, F3.2)', async () => {
  // A tile's handlers are the only way a person selects a file in the Grid,
  // and the tests drove onCellClick directly: a tile with no click handler,
  // one wired to the next tile, no Enter/Space, or no tab stop passed them all.
  const g = gridHarness({ raf: true });
  evenPlant(g, 40);
  sizeFromSheet(g, 1440, 900, false);
  await g.renderGrid();
  const tileEl = (i: number) => g.els.gridInner.children.find((c) => Number(c.dataset.i) === i)!;
  assert.ok(g.els.gridInner.children.length >= 12, `control: a few rows of tiles are built (${g.els.gridInner.children.length})`);
  for (const t of g.els.gridInner.children) {
    assert.equal(t.tabIndex, 0, `tile ${t.dataset.i} is in the Tab order`);
    assert.equal(t.attrs.role, 'button', `tile ${t.dataset.i} is a button to assistive tech`);
  }
  // The tile's own listeners, as the browser runs them. Each event is a fresh
  // tile: every selection rebuilds the window's tiles.
  const fire = (i: number, type: string, ev: Record<string, unknown>) => {
    const fns = tileEl(i).listeners[type] || [];
    assert.ok(fns.length > 0, `tile ${i} answers a ${type}`);
    for (const f of fns) f(ev);
  };
  const pathOf = (i: number) => g.state.grid.layout[i].it.path;
  const selected = () => [...g.state.grid.selection].sort();
  let prevented = 0;
  const key = (k: string, mods: Record<string, boolean> = {}) => ({ key: k, ...mods, preventDefault: () => { prevented++; } });

  fire(5, 'click', {});
  assert.deepEqual(selected(), [pathOf(5)], 'a click on tile 5 selects its file');
  fire(9, 'keydown', key('Enter'));
  assert.deepEqual(selected(), [pathOf(9)], 'Enter on tile 9 selects its file');
  assert.equal(prevented, 1, 'and the key does nothing else');
  fire(2, 'keydown', key(' ', { metaKey: true }));
  assert.deepEqual(selected(), [pathOf(2), pathOf(9)].sort(), '⌘-Space on tile 2 adds its file');
  assert.equal(prevented, 2, 'and Space does not scroll the Grid');
  fire(3, 'keydown', key('a'));
  assert.deepEqual(selected(), [pathOf(2), pathOf(9)].sort(), 'another key selects nothing');
  assert.equal(prevented, 2, 'and is left to the page');

  // A click's modifiers reach the selection through the tile's own listener
  // (review F3.2): one that called onCellClick without its event made every
  // shift-click and ⌘-click a plain click, and passed all of the above.
  fire(5, 'click', { shiftKey: true });
  assert.deepEqual(selected(), [2, 3, 4, 5].map(pathOf).sort(), 'a shift-click on tile 5 selects tiles 2 to 5, from the anchor ⌘-Space left on 2');
  fire(9, 'click', { metaKey: true });
  assert.deepEqual(selected(), [2, 3, 4, 5, 9].map(pathOf).sort(), 'a ⌘-click on tile 9 adds its file');
  fire(3, 'click', { ctrlKey: true });
  assert.deepEqual(selected(), [2, 4, 5, 9].map(pathOf).sort(), 'a Ctrl-click on tile 3 takes its file out');
});

/* ══════════════ review F2.6 — the preview pane gives focus back to the Grid tile it was opened from ══════════════ */

test('closing the preview pane opened from a Grid tile with Enter gives focus back to that file’s tile, though the tile was rebuilt under it (review F2.6)', async (t) => {
  // The pane remembers the element focus came from and gives it back on
  // close. The Enter that opens it from a tile selects the tile too, and
  // that redraws every tile (and the pane's re-flow redraws them again), so
  // what it remembered was detached by the close and focus fell to <body>:
  // the next Tab started at the top of the page, far from the place in a
  // 25,000-tile Grid.
  const open = async (k: number) => {
    const g = gridHarness({ raf: true, preview: true });
    evenPlant(g, 400);
    sizeFromSheet(g, 1440, 900, false);
    await g.renderGrid();
    const tile = g.els.gridInner.children.find((c) => Number(c.dataset.i) === k)!;
    tile.focus(); // Tab reached it
    tile.listeners.keydown![0]({ key: 'Enter', preventDefault: () => {} });
    await g.settle();
    assert.equal(FOCUS.active, g.els.pvClose, 'control: the pane took the focus, on its Close button');
    assert.ok(!g.els.gridInner.children.includes(tile), 'control: the tile it was opened from was rebuilt — a new tile stands for the file');
    return g;
  };
  const focusedTile = (g: Grid) => {
    const el = FOCUS.active;
    assert.ok(el && g.els.gridInner.children.includes(el), `focus is on a tile in the Grid (it is on ${el ? `${el.id || el.tagName} data-i ${el.dataset.i}` : 'nothing'})`);
    assert.deepEqual(FOCUS.opts, { preventScroll: true }, 'and moving it scrolled nothing');
    return Number(el!.dataset.i);
  };

  await t.test('the file’s tile is on screen: it takes the focus', async () => {
    const g = await open(6);
    g.closePreview!(); // Escape, or Close
    assert.equal(focusedTile(g), 6, 'the same file’s tile, 6');
    await g.settle(); // the re-flow the page's widening brings
    assert.equal(focusedTile(g), 6, 'and it keeps the focus through the re-flow the close brings');
  });

  // Scrolled away while the pane was open: never a tile off screen (B13) —
  // the first one on screen, where the next Tab carries on.
  await t.test('the file’s tile was scrolled away: the first tile on screen takes it', async () => {
    const g = await open(6);
    const sc = g.els.gridScroll;
    sc.scrollTop = 50 * 268; for (const f of sc.listeners.scroll || []) f({});
    assert.ok(!g.els.gridInner.children.some((c) => Number(c.dataset.i) === 6), 'control: tile 6 is no longer built');
    g.closePreview!();
    const first = g.state.grid.layout.findIndex((c) => c.y + c.side > sc.scrollTop);
    assert.equal(focusedTile(g), first, `the first tile on screen, ${first}`);
    await g.settle();
    assert.equal(focusedTile(g), first, 'and it keeps the focus through the re-flow the close brings');
  });

  // The stand-in is for a Grid tile only, and there may be none to give
  // (review F3.1). The pane also opens from a row of another list — its
  // context menu's Quick Look gives the row the focus first — and that list
  // can redraw while the pane is open; a filter can leave the Grid with no
  // tile at all. Either way the close has nothing to give the focus to, and
  // must neither throw nor hand it to a tile that does not stand for it.
  const fromRow = async () => {
    const g = gridHarness({ raf: true, preview: true });
    evenPlant(g, 400);
    sizeFromSheet(g, 1440, 900, false);
    await g.renderGrid();
    const list = (g.els.largestList = fakeEl('largestList')); // on the page, as $() keeps it
    const row = fakeEl('', 'div');
    list.appendChild(row);
    row.focus();
    g.openPreview!(g.state.grid.layout[6].it);
    await g.settle();
    assert.equal(FOCUS.active, g.els.pvClose, 'control: the pane took the focus, on its Close button');
    return { g, list, row };
  };

  await t.test('it came from a row of another list, still on the page: the row gets it back', async () => {
    const { g, row } = await fromRow();
    FOCUS.opts = undefined;
    g.closePreview!();
    assert.equal(FOCUS.active, row, `the row it came from (focus is on ${FOCUS.active ? `${FOCUS.active.id || FOCUS.active.tagName} data-i ${FOCUS.active.dataset.i}` : 'nothing'})`);
    assert.deepEqual(FOCUS.opts, { preventScroll: true }, 'and moving it scrolled nothing');
  });

  await t.test('it came from a row its list redrew while the pane was open: no tile stands for it, and the close moves the focus nowhere', async () => {
    const { g, list } = await fromRow();
    list.replaceChildren({ children: [fakeEl('', 'div')] }); // the list redrawn under the pane
    assert.doesNotThrow(() => g.closePreview!(), 'closing the pane');
    assert.equal(FOCUS.active, g.els.pvClose,
      `no tile takes the focus: the row was not a Grid tile (focus is on ${FOCUS.active ? `${FOCUS.active.id || FOCUS.active.tagName} data-i ${FOCUS.active.dataset.i}` : 'nothing'})`);
  });

  await t.test('it came from a tile, and a filter then left the Grid no tile: the close moves the focus nowhere', async () => {
    const g = await open(6);
    g.els.gridSearch.focus();
    await typeFilter(g, 'no-such-file');
    assert.equal(g.state.grid.layout.length, 0, 'control: the filter matches nothing, so the Grid has no tile');
    g.els.pvClose.focus(); // back into the pane, with Tab or a click on Close
    assert.doesNotThrow(() => g.closePreview!(), 'closing the pane');
    assert.equal(FOCUS.active, g.els.pvClose, 'the focus is not moved: no tile stands for the file');
  });
});

/* ══════════════ review F1.9 — the layout is measured with the scroller's own scrollbar in place ══════════════ */

test('no tile overhangs the Grid when its scrollbar appears — on a first visit, or opening a folder taller than the window from one that fit (review F1.9)', async (t) => {
  // layoutGrid measures the scroller's width, and only then does renderGrid
  // give #gridInner its height. Since the Grid scrolls itself (D01), that
  // height is what makes it overflow, and the page's 11 px scrollbar then
  // takes its width from the tiles already laid out: a row that ended in the
  // last 11 px overhung the content box — a sideways scrollbar, a clipped tile.
  const big = 1e9, mid = big * 0.2296; // a 256 px tile and a 156 px one
  const plant = (g: Grid) => {
    const kids: Node[] = [];
    for (let i = 0; i < 3; i++) kids.push(file('/r/B', `big${i}.raw`, big));
    for (let i = 0; i < 42; i++) kids.push(file('/r/B', `mid${String(i).padStart(2, '0')}.raw`, mid));
    const b: Node = { name: 'B', path: '/r/B', size: 3 * big + 42 * mid, type: 'dir', children: kids };
    g.state.root!.children = [b, file('/r', 'small.txt', 10)];
    for (const k of [b, ...kids]) g.state.pathIndex.set(k.path, k);
  };
  const W = 1440, H = 900;
  const pad = (side: number, g: Grid) => padSide(gridDecls('#gridScroll', { cart: g.page.cart }).get('padding'), side, "the scroller's side padding");
  const noOverhang = (g: Grid, what: string) => {
    const content = g.els.gridScroll.clientWidth - pad(1, g) - pad(3, g);
    for (const c of g.state.grid.layout) {
      assert.ok(c.x + c.side <= content, `${what}: ${c.it.name} ends at x ${c.x + c.side}; the Grid's content is ${content} px wide`);
    }
  };
  // The largest tiles fill the top row to the last pixel of the width a
  // scroller without its bar has — 256 × 3 + 156 × 2 and four gaps.
  const control = gridHarness();
  plant(control);
  control.state.grid.path = '/r/B';
  control.els.gridScroll.clientWidth = W - 244 - 48; // a scroller with no bar
  await control.renderGrid();
  const row0 = control.state.grid.layout.filter((c) => c.y === 0);
  assert.equal(Math.max(...row0.map((c) => c.x + c.side)), W - 244 - 48 - 20, 'control: without a scrollbar, the top row ends at the last pixel of the content');

  // First visit to the folder: nothing laid out yet, so no bar at measure time.
  await t.test('a first visit', async () => {
    const first = gridHarness();
    plant(first);
    first.state.grid.path = '/r/B';
    sizeFromSheet(first, W, H, false);
    await first.renderGrid();
    assert.ok(scrollerShowsBar(first, false), 'control: the folder is taller than the Grid, so its scrollbar shows');
    noOverhang(first, 'a first visit');
  });

  // From a folder that fits into one that does not.
  await t.test('a folder taller than the window, opened from one that fit', async () => {
    const nav = gridHarness();
    plant(nav);
    sizeFromSheet(nav, W, H, false);
    await nav.renderGrid();
    assert.equal(nav.state.grid.layout.length, 2, 'control: /r holds two tiles and fits the Grid');
    nav.onCellClick({}, nav.state.grid.layout.findIndex((c) => c.it.path === '/r/B'));
    await nav.settle();
    assert.equal(nav.state.grid.path, '/r/B', 'control: the folder opened');
    noOverhang(nav, 'a folder taller than the window opened from one that fit');
  });
});

/* ══════════════ hunt C70 — a folder not fetched says why, never "check your connection" ══════════════ */

test('a folder whose contents could not be fetched names no connection to check — and when its scan\'s results expired, says so (hunt C70)', async () => {
  const g = gridHarness();
  const fonts = g.state.pathIndex.get('/r/Fonts')!;
  fonts.children = [];
  (fonts as Node & { pruned?: boolean }).pruned = true;
  g.state.grid.path = '/r/Fonts';
  // The newest empty state: the harness's scroller does not take the last one away.
  const said = () => g.els.gridScroll.children.filter((c) => c.className === 'grid-empty').map((c) => c.innerHTML.replace(/<svg[^>]*><\/svg>/g, '')).pop();
  await g.renderGrid();
  assert.equal(said(), '<span>Couldn’t load this folder — try again</span>', 'a local app has no connection to check');
  // The scan's results expired: the subtree's 404 raised the Scan again offer (scanResultsExpired), for this scan.
  (g.state as unknown as { expiredOffer: unknown }).expiredOffer = { scanId: 's1', isOpen: () => false };
  await g.renderGrid();
  assert.equal(said(), '<span>Couldn’t load this folder — the scan’s results have expired; scan again to see what is in it</span>');
  // Another scan's offer is not this one's.
  (g.state as unknown as { expiredOffer: unknown }).expiredOffer = { scanId: 's0', isOpen: () => false };
  await g.renderGrid();
  assert.equal(said(), '<span>Couldn’t load this folder — try again</span>');
});

/* ══════════════ BQJ-1b — a folder the saved index could not answer for is not "empty" ══════════════ */

test('over the saved index\'s tree, which no scan stands behind, a folder whose children could not be fetched says it could not be loaded — never "This folder is empty" (BQJ-1b)', async () => {
  const g = gridHarness();
  // The saved index's tree: no scan id; Fonts' children were withheld, and the index did not answer for them (ensureSubtree held nothing).
  (g.state as unknown as { scanId: string | null }).scanId = null;
  const fonts = g.state.pathIndex.get('/r/Fonts')!;
  fonts.children = [];
  (fonts as Node & { pruned?: boolean }).pruned = true;
  g.state.grid.path = '/r/Fonts';
  await g.renderGrid();
  const said = g.els.gridScroll.children.filter((c) => c.className === 'grid-empty').map((c) => c.innerHTML).join(' ');
  assert.match(said, /Couldn’t load this folder/, `a folder not fetched is said to be not loaded: ${said}`);
  assert.doesNotMatch(said, /This folder is empty/, 'not called empty');
  // Control: a folder held whole and empty is empty.
  fonts.children = [];
  delete (fonts as Node & { pruned?: boolean }).pruned;
  await g.renderGrid();
  const empty = g.els.gridScroll.children.filter((c) => c.className === 'grid-empty').map((c) => c.innerHTML).join(' ');
  assert.match(empty, /This folder is empty/, `control: a folder held whole with nothing in it is empty: ${empty}`);
});
