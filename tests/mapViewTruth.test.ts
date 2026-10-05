import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The map view says what it is doing — QA of 5 Oct 2026 (batch QA-6).
 *
 * Every pin here RUNS the shipped code: the functions are cut out of the built
 * `public/index.html` by brace matching and evaluated with each global they
 * touch passed in, which is what makes them stubbable at all (the
 * gridAnchorStale / treemapFooterPlural harness precedent). The invariants are
 * about what a person sees and what a click does, so they are asserted as
 * behaviour rather than as source shapes a rewrite would legitimately change.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** `function name(…) {…}`, `const name = {…};` (cut by brace matching) or `const NAME = value;`. */
function declSource(name: string): string {
  let start = INDEX.indexOf(`function ${name}(`);
  if (start > 0 && INDEX.slice(start - 6, start) === 'async ') start -= 6;
  if (start === -1) start = INDEX.indexOf(`const ${name} = {`);
  if (start === -1) {
    // A scalar constant: `const NAME = value;` up to its semicolon.
    const at = INDEX.indexOf(`const ${name} = `);
    assert.notEqual(at, -1, `${name} is declared in the built page`);
    return INDEX.slice(at, INDEX.indexOf(';', at) + 1);
  }
  assert.notEqual(start, -1, `${name} is declared in the built page`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', INDEX.indexOf(name, start) + name.length); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1) + ';';
  }
  return assert.fail(`${name} never closes`);
}

/**
 * Evaluate the named declarations in one scope, with `deps` as the globals.
 * `prelude` declares module-level `let`s the functions assign to.
 */
function load<T>(names: string[], deps: Record<string, unknown>, returns: string, prelude = ''): T {
  const keys = Object.keys(deps);
  const src = `'use strict'; ${prelude}\n${names.map(declSource).join('\n')}\nreturn ${returns};`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, src)(...keys.map((k) => deps[k])) as T;
}

const fmtCount = (n: number) => n.toLocaleString('en-US');

/* ══════════════ D28 — Reclaim colour mode: scores follow every load ══════════════ */

type Calls = Record<string, number>;

/**
 * Drive the real `loadTreemap` (and the real `drawView`) for one renderer with
 * the Reclaim colour mode on, and count what was drawn and what was asked for.
 */
async function loadInMode(mode: string, colorMode = 'reclaim'): Promise<Calls> {
  const calls: Calls = { drawTreemap: 0, drawSunburst: 0, drawCells: 0, fetchScoresForTreemap: 0 };
  const count = (k: string) => () => { calls[k]++; };
  const el = () => ({ classList: { add() {}, remove() {} }, disabled: false, innerHTML: '' });
  const els: Record<string, ReturnType<typeof el>> = {};
  const state = {
    scanId: 's1',
    root: { path: '/r', name: 'r', size: 100 },
    pathIndex: new Map(),
    treemap: {
      mode, colorMode, rootPath: '/r', maxDepth: 4, nodes: [], hover: null, kbSel: null,
      history: { scrubbing: false, active: false },
    },
  };
  const deps = {
    state,
    $: (id: string) => (els[id] ||= el()),
    REDUCED: true,
    isSun: () => state.treemap.mode === 'sunburst',
    isCells: () => state.treemap.mode === 'circles' || state.treemap.mode === 'voronoi',
    exitCartPreview() {},
    ensureSubtree: async (p: string) => ({ path: p, name: 'a', size: 60 }),
    api: async () => ({ root: { path: '/r/a', name: 'a', size: 60 }, nodes: [{ path: '/r/a/x', size: 60 }] }),
    renderCrumbs() {},
    exitHistoryState() {},
    refreshTimebar() {},
    tmSetEmpty() {},
    maybeInjectTrash() {},
    altBeginZoom() {},
    altCircleFor: () => null,
    toast: (m: string) => { throw new Error('loadTreemap reported a failure: ' + m); },
    requestAnimationFrame: (f: () => void) => f(),
    drawTreemap: count('drawTreemap'),
    drawSunburst: count('drawSunburst'),
    drawCells: count('drawCells'),
    fetchScoresForTreemap: count('fetchScoresForTreemap'),
  };
  const loadTreemap = load<(p: string, animate?: boolean) => Promise<void>>(
    ['loadTreemap', 'drawView'], deps, 'loadTreemap', 'let tmLoadSeq = 0;');
  await loadTreemap('/r/a', true);
  return calls;
}

test('D28: a drill-in, an Up, a crumb or a renderer switch asks for the Reclaim scores of what it drew', async () => {
  // Every one of those goes through loadTreemap. It used to draw with the
  // renderer's own draw function, which never asks for scores, so switching
  // Voronoi → Treemap kept Voronoi's 210 scores and painted the rest grey.
  const expectDraw: Record<string, string> = {
    treemap: 'drawTreemap', sunburst: 'drawSunburst', circles: 'drawCells', voronoi: 'drawCells',
  };
  for (const [mode, drawFn] of Object.entries(expectDraw)) {
    const calls = await loadInMode(mode);
    assert.equal(calls[drawFn], 1, `${mode}: the map is drawn once`);
    assert.equal(calls.fetchScoresForTreemap, 1,
      `${mode}: the cells it just drew are scored — a load must not keep the previous layout's scores`);
  }
});

test('D28: with Size or Age colouring a load asks for no scores at all', async () => {
  for (const colorMode of ['size', 'age']) {
    const calls = await loadInMode('treemap', colorMode);
    assert.equal(calls.drawTreemap, 1);
    assert.equal(calls.fetchScoresForTreemap, 0, `${colorMode}: nothing is fetched that nothing will paint`);
  }
});

/** The coverage sentence for `drawn` cells of which the first `scored` are scored and the next `pending` are in flight. */
function coverage(drawn: number, scored: number, pending: number, unscorable = 0): string {
  const cells = Array.from({ length: drawn }, (_, i) => ({ n: { path: `/r/f${i}` } }));
  const scores = new Map<string, unknown>();
  const inFlight = new Set<string>();
  cells.forEach((c, i) => {
    if (i < scored) scores.set(c.n.path, { score: 50 });
    else if (i < scored + unscorable) scores.set(c.n.path, null);
    else if (i < scored + unscorable + pending) inFlight.add(c.n.path);
  });
  const note = load<() => string>(['reclaimCoverageNote'], {
    drawnCells: () => cells,
    reclaim: { scores, pending: inFlight },
    formatCount: fmtCount,
    TM_SCORE_CAP: 6000,
  }, 'reclaimCoverageNote');
  return note();
}

test('D28: "TreeMap stops at 6,000" is said only when the asking actually reached 6,000', () => {
  // The QA screen: Voronoi's 210 scores carried over, nothing else asked.
  // "Scored 210 of 9,432 — TreeMap stops at 6,000 at a time" contradicts itself.
  const carried = coverage(9432, 210, 0);
  assert.match(carried, /Scored 210 of 9,432 on screen/);
  assert.doesNotMatch(carried, /stops at/, 'nothing reached the cap, so the cap is not the reason');
  // The fetch that follows the draw is in flight: say so, with the count.
  const loading = coverage(9432, 210, 5790);
  assert.match(loading, /Scored 210 of 9,432 on screen; 5,790 more are loading/);
  assert.match(loading, /stops at 6,000 at a time; drill in to score the rest/,
    '210 + 5,790 is the cap, so this time the cap IS why 3,432 cells will stay grey');
  // Landed at the cap.
  assert.match(coverage(9432, 6000, 0), /Scored 6,000 of 9,432 on screen — TreeMap stops at 6,000/);
  // Under the cap and loading: no cap clause.
  const small = coverage(4000, 1000, 3000);
  assert.match(small, /3,000 more are loading\.$/);
  assert.doesNotMatch(small, /stops at/);
  assert.match(coverage(4000, 1000, 1), /1 more is loading\./, 'the verb follows its own number');
  // Unchanged: fully scored says nothing; unscorable cells are named.
  assert.equal(coverage(4000, 4000, 0), '');
  assert.match(coverage(4000, 3990, 0, 10), /10 of 4,000 could not be scored/);
});

/* ══════════════ D26 — one level per click (owner, 5 Oct 2026) ══════════════ */

type Hit = { n: { path: string; type: 'dir' | 'file'; container?: boolean; virtual?: boolean; isTrash?: boolean }; center?: boolean };

/** Click the map over `hit` while `rootPath` is on screen; report what the click did. */
function clickOn(hit: Hit, rootPath = '/r') {
  const did = { loaded: [] as string[], previewed: [] as string[], expanded: [] as string[] };
  const click = load<(e: unknown) => void>(['tmOnCanvasClick', 'tmStepToward', 'tmIsInside'], {
    state: { treemap: { rootPath, history: { active: false } } },
    tmPreview: { on: false },
    hideTooltip() {},
    viewHit: () => hit,
    openTrashModal() { throw new Error('not the Trash cell'); },
    breadcrumbsFor: () => [],
    loadTreemap: (p: string) => { did.loaded.push(p); },
    openPreview: (n: { path: string }) => { did.previewed.push(n.path); },
    expandContainerNode: (n: { path: string }) => { did.expanded.push(n.path); },
  }, 'tmOnCanvasClick', 'let tmSuppressClick = false;');
  click({ clientX: 10, clientY: 10 });
  return did;
}

test('D26: a click opens the next folder down under the pointer, never the deepest one drawn there', () => {
  // QA: one click went AssetsV2 › … › AssetData, four levels at once, while
  // the tour said "click to drill in" and Esc climbs back ONE.
  assert.deepEqual(clickOn({ n: { path: '/r/a/b/c', type: 'dir' } }).loaded, ['/r/a'],
    'a folder drawn three levels down opens its top-level ancestor');
  assert.deepEqual(clickOn({ n: { path: '/r/a', type: 'dir' } }).loaded, ['/r/a'], 'a top-level folder opens itself');
  const deepFile = clickOn({ n: { path: '/r/a/b/movie.mov', type: 'file' } });
  assert.deepEqual(deepFile.loaded, ['/r/a'], 'a file inside a folder is a click on that folder, one level down');
  assert.deepEqual(deepFile.previewed, [], 'and does not open a preview from three levels away');
  assert.deepEqual(clickOn({ n: { path: '/r/notes.txt', type: 'file' } }).previewed, ['/r/notes.txt'],
    'a file directly in the folder on screen still opens its preview');
});

test('D26: the step is separator-aware: Windows paths, a drive root, and archive entries', () => {
  assert.deepEqual(clickOn({ n: { path: 'C:\\Users\\me\\AppData\\Local\\Temp', type: 'dir' } }, 'C:\\Users\\me').loaded,
    ['C:\\Users\\me\\AppData'], 'a Windows tree steps on its own separator');
  assert.deepEqual(clickOn({ n: { path: '/Users/me/x', type: 'dir' } }, '/').loaded, ['/Users'],
    'from the filesystem root the next level is /Users, not "" or "//Users"');
  assert.deepEqual(clickOn({ n: { path: '/r/z.zip/inner/x.txt', type: 'file', virtual: true } }).loaded, ['/r/z.zip'],
    'an entry inside an opened archive opens the archive first');
  assert.deepEqual(clickOn({ n: { path: '/r/z.zip', type: 'file', container: true } }).expanded, ['/r/z.zip'],
    'an archive on screen still opens through the container route');
});

test('D26: the tour describes the click the map actually performs', () => {
  const start = INDEX.indexOf("tour.step === 'map'");
  assert.notEqual(start, -1, 'the map step of the tour exists');
  const card = INDEX.slice(start, INDEX.indexOf('</p>', start));
  assert.match(card, /Click a folder to open it, one level at a time/, 'one click, one level — the owner\'s rule, in words');
  assert.match(card, /<kbd>Esc<\/kbd> to climb back up a level/, 'and Esc is the same step in reverse');
});

/* ══════════════ D25 — the breadcrumb trail folds instead of clipping ══════════════ */

const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type FakeBtn = {
  path: string | null; more: boolean; nm: string | null; text: string; current: boolean;
  dataset: { p?: string }; listeners: Record<string, Array<(e: unknown) => void>>;
  addEventListener(t: string, f: (e: unknown) => void): void; click(): void;
  getBoundingClientRect(): { left: number; bottom: number }; focus(): void;
};

function parseButtons(html: string): FakeBtn[] {
  const out: FakeBtn[] = [];
  for (const m of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = m[1];
    const p = /data-p="([^"]*)"/.exec(attrs);
    const nm = /<span class="crumb-nm">([\s\S]*?)<\/span>/.exec(m[2]);
    const b: FakeBtn = {
      path: p ? unesc(p[1]) : null,
      more: /data-crumb-more/.test(attrs),
      nm: nm ? unesc(nm[1]) : null,
      text: unesc(m[2].replace(/<[^>]*>/g, '')),
      current: /aria-current="true"/.test(attrs),
      dataset: p ? { p: unesc(p[1]) } : {},
      listeners: {},
      addEventListener(t, f) { (b.listeners[t] ||= []).push(f); },
      click() { for (const f of b.listeners.click || []) f({ stopPropagation() {}, preventDefault() {}, currentTarget: b }); },
      getBoundingClientRect: () => ({ left: 0, bottom: 30 }),
      focus() {},
    };
    out.push(b);
  }
  return out;
}

/**
 * A crumb host that lays its buttons out the way `.crumbs` does: one line,
 * packed to the END, so a trail wider than the host overflows past its START
 * edge — the first button's left edge goes negative. Widths are a fixed
 * model (7 px a character, the 220 px ceiling, 15 px separators).
 */
function makeHost(width: number) {
  const h = {
    clientWidth: width, html: '', buttons: [] as FakeBtn[], seps: 0,
    set innerHTML(v: string) { h.html = v; h.buttons = parseButtons(v); h.seps = (v.match(/class="sep"/g) || []).length; },
    get innerHTML() { return h.html; },
    natural(): number {
      const items = h.buttons.map((b) => (b.more ? 30 : Math.min(220, 20 + b.text.length * 7)));
      return items.reduce((a, w) => a + w, 0) + h.seps * 15 + 3 * Math.max(0, items.length + h.seps - 1);
    },
    get firstElementChild() {
      return h.buttons.length ? { getBoundingClientRect: () => ({ left: h.clientWidth - h.natural() }) } : null;
    },
    getBoundingClientRect: () => ({ left: 0, right: h.clientWidth }),
    querySelectorAll(sel: string) {
      if (sel === 'button[data-p]') return h.buttons.filter((b) => b.path !== null);
      if (sel === 'button') return h.buttons;
      throw new Error('unexpected selector ' + sel);
    },
    querySelector(sel: string) {
      if (sel === '[data-crumb-more]') return h.buttons.find((b) => b.more) || null;
      throw new Error('unexpected selector ' + sel);
    },
  };
  return h;
}

const DEEP = '/System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime/7f2d3a5b8c9e1f0a/AssetData';

function crumbsHarness() {
  const picked: string[] = [];
  const observers: Array<{ cb: () => void; el: unknown }> = [];
  const menu = { html: '', buttons: [] as FakeBtn[], style: {} as Record<string, string>, offsetHeight: 120,
    set innerHTML(v: string) { menu.html = v; menu.buttons = parseButtons(v); },
    get innerHTML() { return menu.html; },
    querySelectorAll: () => menu.buttons, querySelector: () => menu.buttons[0] || null };
  class FakeRO { cb: () => void; constructor(cb: () => void) { this.cb = cb; } observe(el: unknown) { observers.push({ cb: this.cb, el }); } }
  const render = load<(host: unknown, p: string, onPick: (p: string) => void) => void>(
    ['renderCrumbs', 'breadcrumbsFor', 'crumbsPaint', 'crumbFolded', 'crumbsOverflow', 'crumbsWatch', 'showCrumbMenu', 'CRUMB_FADE_PX'], {
      state: { root: { path: '/System', name: 'System' } },
      icon: () => '<svg></svg>',
      escapeHtml: esc,
      hideTooltip() {},
      hideCtxMenu() {},
      nodeFor: () => null,
      openBudgetDialog() {},
      $: (id: string) => { assert.equal(id, 'ctxMenu'); return menu; },
      window: { innerWidth: 1440, innerHeight: 900 },
      ResizeObserver: FakeRO,
    }, 'renderCrumbs');
  return { render, picked, onPick: (p: string) => { picked.push(p); }, menu, observers };
}

/** Every path the trail offers: the visible crumbs, plus whatever the "…" menu lists. */
function reachable(host: ReturnType<typeof makeHost>, h: ReturnType<typeof crumbsHarness>): string[] {
  const out = host.buttons.filter((b) => b.path).map((b) => b.path as string);
  const more = host.buttons.find((b) => b.more);
  if (more) { more.click(); out.push(...h.menu.buttons.map((b) => b.path as string)); }
  return out;
}

test('D25: a deep trail that does not fit folds its ancestors into "…" — clear of the fade, every ancestor one click away', () => {
  const h = crumbsHarness();
  const host = makeHost(420);
  h.render(host, DEEP, h.onPick);
  const ancestors = ['/System', '/System/Library', '/System/Library/AssetsV2',
    '/System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime',
    '/System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime/7f2d3a5b8c9e1f0a'];
  assert.ok(host.clientWidth - host.natural() >= 34,
    `the trail fits clear of the 34 px fade instead of being sliced mid-word (needs ${host.natural()} px of ${host.clientWidth})`);
  assert.ok(host.buttons.some((b) => b.more), 'something had to fold, and it folded into the "…" crumb');
  assert.equal(host.buttons[0].path, '/System', 'the middle folds first: the root stays on screen while it fits');
  const cur = host.buttons[host.buttons.length - 1];
  assert.equal(cur.path, DEEP, 'the folder on screen is the last crumb and never folds');
  assert.equal(cur.nm, 'AssetData', 'its name sits in .crumb-nm, the span that can ellipsize');
  const offered = reachable(host, h);
  for (const a of ancestors) assert.ok(offered.includes(a), `${a} is reachable from the crumbs`);
  // Picking from the menu navigates there.
  const lib = h.menu.buttons.find((b) => b.path === '/System/Library');
  assert.ok(lib, 'Library is in the menu — QA could not reach it at all');
  lib!.click();
  assert.deepEqual(h.picked, ['/System/Library']);
});

test('D25: "fits" means clear of the fade, not merely inside the box', () => {
  // At 630 px the trail with two ancestors folded measures 611 px: inside the
  // box, but its first 19 px sit under the 34 px mask — the half-legible root
  // the old clip produced. It folds one more.
  const h = crumbsHarness();
  const host = makeHost(630);
  h.render(host, DEEP, h.onPick);
  assert.ok(host.clientWidth - host.natural() >= 34, `clear of the fade (left edge at ${host.clientWidth - host.natural()} px)`);
});

test('D25: a trail that fits is drawn whole — nothing folds that did not have to', () => {
  const h = crumbsHarness();
  const host = makeHost(1400);
  h.render(host, DEEP, h.onPick);
  assert.equal(host.buttons.filter((b) => b.more).length, 0, 'no "…" when everything fits');
  assert.equal(host.buttons.length, 6, 'all six crumbs are on screen');
  assert.ok(host.buttons.every((b) => b.nm !== null), 'and every name is in its ellipsizing span');
});

test('D25: in a very narrow toolbar only "…" and the folder on screen remain, and the menu holds the rest', () => {
  const h = crumbsHarness();
  const host = makeHost(150);
  h.render(host, DEEP, h.onPick);
  assert.deepEqual(host.buttons.map((b) => (b.more ? '…' : b.nm)), ['…', 'AssetData']);
  reachable(host, h);
  assert.equal(h.menu.buttons.length, 5, 'all five ancestors, the root included, are in the menu');
  assert.equal(h.menu.buttons[0].path, '/System', 'in path order, root first');
});

test('D25: the trail re-fits when the toolbar changes width, and a hidden toolbar folds nothing', () => {
  const h = crumbsHarness();
  const host = makeHost(0);
  h.render(host, DEEP, h.onPick);
  assert.equal(host.buttons.filter((b) => b.more).length, 0,
    'a host that is not laid out cannot measure, so nothing is folded on a guess');
  assert.equal(h.observers.length, 1, 'the host is watched for size changes');
  host.clientWidth = 420; // the view is shown
  h.observers[0].cb();
  assert.ok(host.buttons.some((b) => b.more), 'shown at 420 px, the trail folds');
  assert.ok(host.clientWidth - host.natural() >= 34, 'and fits');
  const painted = host.html;
  host.html = 'untouched';
  h.observers[0].cb();
  assert.equal(host.html, 'untouched', 'a callback with no change of width repaints nothing — the re-fit cannot feed its own observer');
  host.html = painted;
  h.render(host, DEEP, h.onPick);
  assert.equal(h.observers.length, 1, 'one observer per host, however many renders');
});

test('D25: the name inside a crumb ellipsizes (text-overflow does nothing on the flex button itself)', () => {
  const at = INDEX.indexOf('.crumbs .crumb-nm {');
  assert.notEqual(at, -1, 'the name span has its own rule');
  const rule = INDEX.slice(at, INDEX.indexOf('}', at));
  for (const d of [/min-width:\s*0/, /overflow:\s*hidden/, /text-overflow:\s*ellipsis/, /white-space:\s*nowrap/]) {
    assert.match(rule, d, `.crumb-nm declares ${d}`);
  }
});
