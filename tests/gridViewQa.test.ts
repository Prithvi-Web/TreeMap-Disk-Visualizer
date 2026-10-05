import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Grid view (QA D43, D44, D02).
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
  id: string; value: string; disabled: boolean; hidden: boolean; innerHTML: string; className: string;
  tabIndex: number; dataset: Record<string, string>; style: Record<string, string> & { cssText?: string };
  attrs: Record<string, string>; cls: Set<string>; children: FakeEl[]; listeners: Record<string, ((e: unknown) => void)[]>;
  clientWidth: number; clientHeight: number; scrollTop: number;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean; toggle(c: string, on?: boolean): void };
  setAttribute(k: string, v: string): void; addEventListener(t: string, f: (e: unknown) => void): void;
  appendChild(c: FakeEl): void; replaceChildren(f: { children: FakeEl[] }): void; querySelector(): null; focus(): void; remove(): void;
};

function fakeEl(id = ''): FakeEl {
  const el: FakeEl = {
    id, value: '', disabled: false, hidden: false, innerHTML: '', className: '', tabIndex: -1, dataset: {}, style: {},
    attrs: {}, cls: new Set(), children: [], listeners: {}, clientWidth: 1220, clientHeight: 100000, scrollTop: 0,
    classList: {
      add: (c) => { el.cls.add(c); }, remove: (c) => { el.cls.delete(c); }, contains: (c) => el.cls.has(c),
      toggle: (c, on) => { if (on ?? !el.cls.has(c)) el.cls.add(c); else el.cls.delete(c); },
    },
    setAttribute: (k, v) => { el.attrs[k] = v; },
    addEventListener: (t, f) => { (el.listeners[t] ||= []).push(f); },
    appendChild: (c) => { el.children.push(c); },
    replaceChildren: (f) => { el.children = [...f.children]; },
    querySelector: () => null, focus: () => {}, remove: () => {},
  };
  return el;
}

type Grid = {
  state: {
    root: Node | null; pathIndex: Map<string, Node>;
    grid: { path: string; sort: string; query: string; layout: { it: Node; x: number; y: number; side: number }[]; totalH: number;
      selection: Set<string>; anchor: number | null; rangeStart: number; rangeEnd: number };
  };
  els: Record<string, FakeEl>;
  crumbsCb: { fn: ((p: string) => void) | null };
  timers: Map<number, () => void>;
  renderGrid(): Promise<void>; onCellClick(e: Record<string, boolean>, i: number): void; gridUp(): void;
  gridItems(): Node[]; updateSelectionBar(): void;
  settle(): Promise<void>;
};

const file = (dir: string, name: string, size: number): Node => ({ name, path: `${dir}/${name}`, size, type: 'file', modifiedAt: 1 });

function gridHarness(): Grid {
  const src = slice('/* ───────────────────────────── Grid view ───────────────────────────── */',
    '/* ───────────────────────────── Apps view (Feature 18) ───────────────────────────── */');
  const els: Record<string, FakeEl> = {};
  const $ = (id: string) => (els[id] ||= fakeEl(id));
  const fonts: Node = { name: 'Fonts', path: '/r/Fonts', size: 3000, type: 'dir', children: [file('/r/Fonts', 'a.ttf', 2000), file('/r/Fonts', 'b.otf', 1000)] };
  const other: Node = { name: 'Notes.txt', path: '/r/Notes.txt', size: 10, type: 'file', modifiedAt: 1 };
  const root: Node = { name: 'r', path: '/r', size: 3010, type: 'dir', children: [fonts, other] };
  const pathIndex = new Map<string, Node>([[root.path, root], [fonts.path, fonts], [other.path, other],
    ...fonts.children!.map((c) => [c.path, c] as [string, Node])]);
  const state = {
    root, pathIndex, scanId: 's1',
    grid: { path: '/r', sort: 'size', query: '', layout: [], totalH: 0, selection: new Set<string>(), anchor: null, rangeStart: 0, rangeEnd: -1 },
  };
  const crumbsCb: { fn: ((p: string) => void) | null } = { fn: null };
  const timers = new Map<number, () => void>();
  let tid = 0;
  const document = {
    createElement: () => fakeEl(),
    createDocumentFragment: () => { const f = { children: [] as FakeEl[], appendChild(c: FakeEl) { f.children.push(c); } }; return f; },
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
  const api = new Function(...names, `'use strict'; ${src}
    return { renderGrid, onCellClick, gridUp, gridItems, updateSelectionBar };`)(...names.map((n) => deps[n])) as
    Pick<Grid, 'renderGrid' | 'onCellClick' | 'gridUp' | 'gridItems' | 'updateSelectionBar'>;
  // renderGrid is async; navigation calls it without awaiting.
  const wrapped = {
    ...api,
    renderGrid: () => { const p = api.renderGrid(); pending.push(p); return p; },
  };
  return {
    state: state as unknown as Grid['state'], els, crumbsCb, timers, ...wrapped,
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
