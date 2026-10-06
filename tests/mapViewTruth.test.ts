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
    // A one-statement value: `const NAME = value;` or `let NAME = value;`, up to its semicolon.
    let at = INDEX.indexOf(`const ${name} = `);
    if (at === -1) at = INDEX.indexOf(`let ${name} = `);
    assert.notEqual(at, -1, `${name} is declared in the built page`);
    return INDEX.slice(at, INDEX.indexOf(';', at) + 1);
  }
  assert.notEqual(start, -1, `${name} is declared in the built page`);
  let from = INDEX.indexOf(name, start) + name.length;
  if (INDEX[from] === '(') {
    // Past the parameter list first: a destructured parameter is a brace, and
    // `function ctxMenuShow(menu, { label, … })` would otherwise close on it.
    for (let paren = 0; from < INDEX.length; from++) {
      if (INDEX[from] === '(') paren++;
      else if (INDEX[from] === ')' && --paren === 0) break;
    }
  }
  let depth = 0;
  for (let i = INDEX.indexOf('{', from); i < INDEX.length; i++) {
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
    ['loadTreemap', 'drawView', 'TM_MIN_SIZE'], deps, 'loadTreemap', 'let tmLoadSeq = 0;');
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
  const note = load<() => string>(['reclaimCoverageNote', 'reclaimAskableNode', 'reclaimAskablePath'], {
    drawnCells: () => cells,
    reclaim: { scores, pending: inFlight, failed: new Set<string>() },
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
  // A Windows drive root ends in its separator too, and is the case a scan of C:\ lands in.
  assert.deepEqual(clickOn({ n: { path: 'C:\\Users\\me\\x', type: 'dir' } }, 'C:\\').loaded, ['C:\\Users'],
    'from a drive root the next level is C:\\Users, not "C:" or "C:\\\\Users"');
  assert.deepEqual(clickOn({ n: { path: 'C:\\pagefile.sys', type: 'file' } }, 'C:\\').previewed, ['C:\\pagefile.sys'],
    'a file directly on the drive opens its preview');
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

/**
 * Where keyboard focus is, for the fake elements below: `focus()` moves it,
 * and the code under test reads it back through `document.activeElement`.
 */
const fakeDoc = {
  body: { tagName: 'BODY' } as unknown,
  active: null as unknown,
  get activeElement() { return fakeDoc.active; },
};

type FakeBtn = {
  tagName: string; path: string | null; more: boolean; nm: string | null; text: string; current: boolean; disabled: boolean;
  attrs: Record<string, string>;
  /** Every `data-*` attribute, camel-cased, as the DOM's dataset has them. */
  dataset: Record<string, string>; listeners: Record<string, Array<(e: unknown) => void>>;
  /** Every scrollIntoView() call's options, in order. */
  scrolls: unknown[];
  addEventListener(t: string, f: (e: unknown) => void): void; click(): void;
  getBoundingClientRect(): { left: number; bottom: number }; focus(): void; scrollIntoView(o?: unknown): void;
  setAttribute(k: string, v: string): void; getAttribute(k: string): string | null; hasAttribute(k: string): boolean;
  closest(sel: string): unknown;
};

/**
 * `el.closest(sel)` for the fakes, which have no parents: the element itself,
 * matched against each selector of a comma list — a tag name, `[attr]` and
 * `[attr="value"]` (QA-6b review F1.9). It used to answer the button for any
 * list that mentioned `button`, so `a[href]` and the ARIA roles were never tried.
 */
function fakeClosest<T extends { tagName: string; attrs: Record<string, string> }>(el: T, sel: string): T | null {
  for (const one of sel.split(',')) {
    const m = /^\s*([a-z]*)((?:\[[^\]]+\])*)\s*$/i.exec(one);
    if (!m) throw new Error(`the fake closest() cannot read ${JSON.stringify(one)}`);
    if (m[1] && m[1].toUpperCase() !== el.tagName) continue;
    const conds = [...m[2].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
    if (conds.every(([, k, v]) => k in el.attrs && (v === undefined || el.attrs[k] === v))) return el;
  }
  return null;
}

/** A fake element that is not a button: a link, a `div` with a role, a menu's separator. */
function fakeEl(tagName: string, attrs: Record<string, string> = {}) {
  const el = {
    tagName, attrs,
    setAttribute(k: string, v: string) { el.attrs[k] = String(v); },
    getAttribute(k: string) { return k in el.attrs ? el.attrs[k] : null; },
    closest(sel: string) { return fakeClosest(el, sel); },
    focus() { fakeDoc.active = el; },
  };
  return el;
}

function parseButtons(html: string): FakeBtn[] {
  const out: FakeBtn[] = [];
  for (const m of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrText = m[1];
    const attrs: Record<string, string> = {};
    for (const a of attrText.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = unesc(a[2] ?? '');
    const p = /data-p="([^"]*)"/.exec(attrText);
    const nm = /<span class="crumb-nm">([\s\S]*?)<\/span>/.exec(m[2]);
    const b: FakeBtn = {
      tagName: 'BUTTON',
      path: p ? unesc(p[1]) : null,
      more: /data-crumb-more/.test(attrText),
      nm: nm ? unesc(nm[1]) : null,
      text: unesc(m[2].replace(/<[^>]*>/g, '')),
      current: /aria-current="true"/.test(attrText),
      disabled: 'disabled' in attrs,
      attrs,
      dataset: Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('data-'))
        .map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase()), v])),
      scrolls: [],
      listeners: {},
      addEventListener(t, f) { (b.listeners[t] ||= []).push(f); },
      click() { for (const f of b.listeners.click || []) f({ stopPropagation() {}, preventDefault() {}, currentTarget: b }); },
      getBoundingClientRect: () => ({ left: 0, bottom: 30 }),
      focus() { fakeDoc.active = b; },
      scrollIntoView(o) { b.scrolls.push(o); },
      setAttribute(k, v) { b.attrs[k] = String(v); },
      getAttribute(k) { return k in b.attrs ? b.attrs[k] : null; },
      hasAttribute(k) { return k in b.attrs; },
      closest(sel: string) { return fakeClosest(b, sel); },
    };
    out.push(b);
  }
  return out;
}

/**
 * The `.crumbs` rule's numbers, read from the built page: the width of the
 * mask's fade, the gap between items, and a button's ceiling. The fit tests
 * measure against these rather than against copies of the product's own
 * constants, so a fade the CSS widens is a fade the trail must clear.
 */
function crumbsCss() {
  const at = INDEX.indexOf('.crumbs { display: flex;');
  assert.notEqual(at, -1, 'the .crumbs rule is in the built page');
  const rule = INDEX.slice(at, INDEX.indexOf('}', at));
  const fades = [...rule.matchAll(/mask-image:\s*linear-gradient\(to right, transparent 0, #000 (\d+)px\)/g)].map((m) => Number(m[1]));
  assert.equal(fades.length, 2, 'the fade is declared for -webkit-mask-image and mask-image');
  assert.equal(fades[0], fades[1], 'both draw the same fade');
  const gap = /gap:\s*(\d+)px/.exec(rule);
  const btnAt = INDEX.indexOf('.crumbs button {');
  const maxW = /max-width:\s*(\d+)px/.exec(INDEX.slice(btnAt, INDEX.indexOf('}', btnAt)));
  assert.ok(gap && maxW, 'the gap and the button ceiling are declared in px');
  return { fade: fades[0], gap: Number(gap![1]), maxW: Number(maxW![1]) };
}

/**
 * A crumb host that lays its buttons out the way `.crumbs` does: one line,
 * packed to the END, so a trail wider than the host overflows past its START
 * edge — the first button's left edge goes negative. Text widths are a model
 * (7 px a character, 15 px separators, 30 px for "…"); the gap and a button's
 * ceiling are the CSS's own (crumbsCss).
 */
function makeHost(width: number) {
  const h = {
    clientWidth: width, html: '', buttons: [] as FakeBtn[], seps: 0,
    set innerHTML(v: string) { h.html = v; h.buttons = parseButtons(v); h.seps = (v.match(/class="sep"/g) || []).length; },
    get innerHTML() { return h.html; },
    natural(): number {
      const items = h.buttons.map((b) => (b.more ? 30 : Math.min(crumbsCss().maxW, 20 + b.text.length * 7)));
      return items.reduce((a, w) => a + w, 0) + h.seps * 15 + crumbsCss().gap * Math.max(0, items.length + h.seps - 1);
    },
    get firstElementChild() {
      return h.buttons.length ? { getBoundingClientRect: () => ({ left: h.clientWidth - h.natural() }) } : null;
    },
    contains: (el: unknown) => h.buttons.includes(el as FakeBtn),
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

/** The arrow function `(e) => {…}` registered right after `anchor` in the built page, cut out by brace matching. */
function listenerAfter(anchor: string, what: string): string {
  const at = INDEX.indexOf(anchor);
  assert.notEqual(at, -1, `${what} is where this test thinks it is`);
  const start = INDEX.indexOf('(e) => {', at);
  let depth = 0;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`${what} never closes`);
}

/** The page's own document-level keydown handler — the anonymous one holding the map's keys. */
function pageKeydownSource(): string {
  return listenerAfter("document.addEventListener('keydown', (e) => {\n  const mod = e.metaKey || e.ctrlKey;", 'the page keydown handler');
}

/** The Export button's own click listener, which fills #ctxMenu and shows it (QA-6b review F1.7). */
function exportClickSource(): string {
  return listenerAfter("$('tmExportBtn').addEventListener('click', (e) => {", 'the Export click listener');
}

/** The Export button as the markup draws it, its attributes the page's own. */
function exportButton(): FakeBtn {
  const at = INDEX.indexOf('id="tmExportBtn"');
  assert.notEqual(at, -1, 'the Export button is in the built page');
  const [btn] = parseButtons(INDEX.slice(INDEX.lastIndexOf('<button', at), INDEX.indexOf('</button>', at) + '</button>'.length));
  return btn;
}

type FakeMenu = {
  html: string; buttons: FakeBtn[]; divs: Array<ReturnType<typeof fakeEl>>; style: Record<string, string>; offsetHeight: number;
  attrs: Record<string, string>;
  innerHTML: string; querySelectorAll(sel: string): unknown[]; querySelector(sel: string): FakeBtn | null;
  setAttribute(k: string, v: string): void; getAttribute(k: string): string | null; contains(el: unknown): boolean;
};

/**
 * #ctxMenu: its buttons and its `.div` dividers are parsed from what is
 * written into it, and only the selectors the page uses on it are answered
 * — anything else throws rather than quietly answering the buttons.
 */
function fakeMenu(): FakeMenu {
  const menu: FakeMenu = { html: '', buttons: [], divs: [], style: {}, offsetHeight: 120, attrs: {},
    set innerHTML(v: string) {
      menu.html = v;
      menu.buttons = parseButtons(v);
      menu.divs = [...v.matchAll(/<div class="div"><\/div>/g)].map(() => fakeEl('DIV', { class: 'div' }));
    },
    get innerHTML() { return menu.html; },
    querySelectorAll(sel: string) {
      if (sel === 'button') return menu.buttons;
      if (sel === '.div') return menu.divs;
      throw new Error('unexpected selector ' + sel);
    },
    querySelector(sel: string) {
      if (sel === 'button') return menu.buttons[0] || null;
      const act = /^\[data-act="([^"]+)"\]$/.exec(sel);
      if (act) return menu.buttons.find((b) => b.dataset.act === act[1]) || null;
      throw new Error('unexpected selector ' + sel);
    },
    setAttribute(k, v) { menu.attrs[k] = String(v); },
    getAttribute(k) { return k in menu.attrs ? menu.attrs[k] : null; },
    contains: (el: unknown) => el === menu || menu.buttons.includes(el as FakeBtn) || menu.divs.includes(el as ReturnType<typeof fakeEl>) };
  return menu;
}

/** The menu's machinery, shared by the "…" crumb, the right-click menu and Export (QA-6 review MEDIUM-1). */
const CTX_MENU_DECLS = ['ctxMenuOpener', 'ctxMenuReturn', 'CTX_MENU_EDGE', 'ctxMenuShow', 'hideCtxMenu', 'ctxMenuFocusOpener', 'ctxMenuKeydown'];

type KeyEv = { key: string; target: unknown; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean;
  defaultPrevented: boolean; preventDefault(): void; stopPropagation(): void };
const keyEv = (key: string, target: unknown = fakeDoc.active): KeyEv => {
  const ev: KeyEv = { key, target, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false,
    preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {} };
  return ev;
};

function crumbsHarness() {
  const picked: string[] = [];
  const focusAtPick: unknown[] = [];
  const observers: Array<{ cb: () => void; el: unknown }> = [];
  const menu = fakeMenu();
  const map = { drill: 0, up: 0, move: 0 };
  /** What an entry of the Export or right-click menu did when it was picked. */
  const acts: string[] = [];
  const act = (name: string) => (p?: unknown) => { acts.push(typeof p === 'string' ? `${name} ${p}` : name); };
  const canvas = { tagName: 'CANVAS', focus() { fakeDoc.active = canvas; } };
  fakeDoc.active = fakeDoc.body;
  class FakeRO { cb: () => void; constructor(cb: () => void) { this.cb = cb; } observe(el: unknown) { observers.push({ cb: this.cb, el }); } }
  type Page = {
    render: (host: unknown, p: string, onPick: (p: string) => void) => void; keydown: (e: KeyEv) => void;
    exportClick: (e: unknown) => void; showCtxMenu: (x: number, y: number, node: unknown) => void;
  };
  const { render, keydown, exportClick, showCtxMenu } = load<Page>(
    ['renderCrumbs', 'breadcrumbsFor', 'crumbsPaint', 'crumbFolded', 'crumbsOverflow', 'crumbsWatch', 'showCrumbMenu', 'CRUMB_FADE_PX',
      ...CTX_MENU_DECLS, 'tmMapKeyYields', 'tmMapTakeFocus', 'showCtxMenu', 'ctxTarget'], {
      state: {
        scanId: 's1', scanning: false,
        root: { path: '/System', name: 'System' }, view: 'treemap', lasso: { on: false }, grid: { selection: new Set() },
        system: { platform: 'darwin' },
        treemap: { rootPath: DEEP, history: { active: false, snaps: [] }, kbSel: null },
      },
      // The Export menu's own world: a map is drawn, the PNG and SVG entries are offered.
      drawnCells: () => [{}],
      isRectMap: () => true,
      HTMLCanvasElement: { prototype: {} },
      toast: (m: string) => { throw new Error('the page reported: ' + m); },
      exportTreemapPNG: act('png'), exportTreemapSVG: act('svg'), exportTimelapseGif: act('gif'), exportTimelapseWebm: act('webm'),
      downloadReport: act('report'),
      // The right-click menu's.
      cartHas: () => false, budgetFor: () => null, noteFor: () => null,
      openInOS: act('open'), copyPath: act('copy'), openPreview: act('preview'), cartToggle: act('cart'), confirmTrash: act('trash'),
      cloudProviderOfScan: () => ({ name: 'Drive' }),
      document: fakeDoc,
      icon: () => '<svg></svg>',
      escapeHtml: esc,
      hideTooltip() {},
      nodeFor: () => null,
      openBudgetDialog() {},
      $: (id: string) => { assert.equal(id, 'ctxMenu'); return menu; },
      window: { innerWidth: 1440, innerHeight: 900 },
      ResizeObserver: FakeRO,
      // The rest of the page's keydown handler, as far as the keys below reach it.
      tablistKeydown: () => false,
      topModal: () => null,
      tmPreview: { on: false },
      kbDrill: () => { map.drill++; },
      kbUp: () => { map.up++; },
      kbMove: () => { map.move++; },
      tmCanvas: canvas,
    }, `{ render: renderCrumbs, keydown: (${pageKeydownSource()}), exportClick: (${exportClickSource()}), showCtxMenu }`);
  return {
    render, keydown, exportClick, showCtxMenu, acts, map, canvas, picked, focusAtPick, menu, observers,
    onPick: (p: string) => { picked.push(p); focusAtPick.push(fakeDoc.active); },
  };
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
  assert.ok(host.clientWidth - host.natural() >= crumbsCss().fade,
    `the trail fits clear of the ${crumbsCss().fade} px fade instead of being sliced mid-word (needs ${host.natural()} px of ${host.clientWidth})`);
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
  assert.ok(host.clientWidth - host.natural() >= crumbsCss().fade, `clear of the fade (left edge at ${host.clientWidth - host.natural()} px)`);
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
  assert.ok(host.clientWidth - host.natural() >= crumbsCss().fade, 'and fits');
  const painted = host.html;
  host.html = 'untouched';
  h.observers[0].cb();
  assert.equal(host.html, 'untouched', 'a callback with no change of width repaints nothing — the re-fit cannot feed its own observer');
  host.html = painted;
  h.render(host, DEEP, h.onPick);
  assert.equal(h.observers.length, 1, 'one observer per host, however many renders');
});

test('D25: the fold clears the fade the CSS draws — the product\'s fade width is the mask\'s, not a copy that can drift', () => {
  // The fit tests above used to measure against 34, the product's own
  // CRUMB_FADE_PX: a mask widened in the CSS would have left the trail
  // folding to a fade it no longer matched, with every test still green.
  const fadePx = load<number>(['CRUMB_FADE_PX'], {}, 'CRUMB_FADE_PX');
  assert.equal(fadePx, crumbsCss().fade, `CRUMB_FADE_PX (${fadePx}) is the .crumbs mask's fade (${crumbsCss().fade} px)`);
});

test('D25: the name inside a crumb ellipsizes (text-overflow does nothing on the flex button itself)', () => {
  const at = INDEX.indexOf('.crumbs .crumb-nm {');
  assert.notEqual(at, -1, 'the name span has its own rule');
  const rule = INDEX.slice(at, INDEX.indexOf('}', at));
  for (const d of [/min-width:\s*0/, /overflow:\s*hidden/, /text-overflow:\s*ellipsis/, /white-space:\s*nowrap/]) {
    assert.match(rule, d, `.crumb-nm declares ${d}`);
  }
});

/* ══════════════ QA-6 review MEDIUM-1 — the "…" menu works from the keyboard ══════════════ */

/** A narrow trail, so only "…" and the folder on screen are left: the harness, and the "…" crumb. */
function foldedTrail() {
  const h = crumbsHarness();
  const host = makeHost(150);
  h.render(host, DEEP, h.onPick);
  const more = host.buttons.find((b) => b.more);
  assert.ok(more, 'the trail folded into "…"');
  return { h, host, more: more! };
}

test('MEDIUM-1: Enter on "…" is the button\'s own press — it opens the menu instead of drilling the map', () => {
  const { h, more } = foldedTrail();
  const onMap = keyEv('Enter', fakeDoc.body);
  h.keydown(onMap);
  assert.equal(h.map.drill, 1, 'control: Enter with nothing focused drills the map, as before');
  assert.equal(onMap.defaultPrevented, true);
  more.focus();
  const onMore = keyEv('Enter');
  h.keydown(onMore);
  assert.equal(h.map.drill, 1, 'Enter on "…" no longer drills the map behind it');
  assert.equal(onMore.defaultPrevented, false, 'and the button\'s click — what Enter on a button is — is not cancelled');
  more.click(); // the press Enter makes
  assert.equal(h.menu.style.display, 'block', 'the menu opens');
  assert.equal(fakeDoc.active, h.menu.buttons[0], 'with its first folder focused');
});

test('MEDIUM-1: inside the menu the arrows, Home and End move between its folders, and the map behind it stays put', () => {
  const { h, more } = foldedTrail();
  more.click();
  const items = h.menu.buttons;
  assert.equal(items.length, 5);
  // Focus moves with preventScroll, so in a menu that scrolls (LOW-4) every
  // step has to bring its entry into view itself (QA-6b review F1.9).
  const scrolls = () => items.reduce((n, b) => n + b.scrolls.length, 0);
  const press = (key: string) => {
    const before = scrolls();
    const ev = keyEv(key);
    h.keydown(ev);
    if (ev.defaultPrevented) {
      assert.equal(scrolls(), before + 1, `${key} scrolls one entry into view`);
      assert.deepEqual((fakeDoc.active as FakeBtn).scrolls.at(-1), { block: 'nearest' }, `${key}: the entry it focused, the least scroll that shows it`);
    }
    return ev;
  };
  assert.equal(press('ArrowDown').defaultPrevented, true, 'the menu takes the arrow');
  assert.equal(fakeDoc.active, items[1], 'ArrowDown: the next folder');
  press('ArrowDown'); press('ArrowDown'); press('ArrowDown');
  assert.equal(fakeDoc.active, items[4]);
  press('ArrowDown');
  assert.equal(fakeDoc.active, items[0], 'and wraps from the last to the first');
  press('ArrowUp');
  assert.equal(fakeDoc.active, items[4], 'ArrowUp wraps the other way');
  press('Home');
  assert.equal(fakeDoc.active, items[0], 'Home: the first');
  press('End');
  assert.equal(fakeDoc.active, items[4], 'End: the last');
  assert.equal(scrolls(), 8, 'one scroll for each of the eight steps');
  for (const key of ['h', 'j', 'k', 'l', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Enter']) press(key);
  assert.deepEqual(h.map, { drill: 0, up: 0, move: 0 }, 'no key pressed in the menu moves, climbs or drills the map');
  // A menu a right-click opened has not taken focus: the first arrow takes it in.
  fakeDoc.active = fakeDoc.body;
  press('ArrowDown');
  assert.equal(fakeDoc.active, items[0], 'ArrowDown from outside the menu lands on its first folder');
  fakeDoc.active = fakeDoc.body;
  press('ArrowUp');
  assert.equal(fakeDoc.active, items[4], 'ArrowUp from outside it, on its last');
  fakeDoc.active = fakeDoc.body;
  press('j');
  assert.equal(h.map.move, 0, 'and while it is open the map keys wait, wherever focus is');
});

test('MEDIUM-1: Escape, or a folder picked, closes the menu and gives focus back to "…"', () => {
  const { h, host, more } = foldedTrail();
  more.click();
  h.keydown(keyEv('ArrowDown'));
  h.keydown(keyEv('Escape'));
  assert.equal(h.menu.style.display, 'none', 'Escape closes it');
  assert.equal(fakeDoc.active, more, 'and focus is back on "…", not on <body>');
  assert.deepEqual(h.picked, [], 'nothing was picked');
  more.click();
  h.keydown(keyEv('End'));
  const last = fakeDoc.active as FakeBtn;
  const enter = keyEv('Enter');
  h.keydown(enter);
  assert.equal(enter.defaultPrevented, false, 'Enter on a folder in the menu is that folder\'s press');
  assert.equal(h.map.drill, 0);
  last.click(); // the press Enter makes
  assert.deepEqual(h.picked, [last.path], 'it opens the folder picked');
  assert.equal(h.focusAtPick[0], more, 'focus was on "…" before the map moved');
  assert.equal(h.menu.style.display, 'none');
  // The load redraws the trail: focus stays in it rather than dropping to <body>.
  h.render(host, last.path as string, h.onPick);
  assert.ok(host.contains(fakeDoc.active), 'after the crumbs are redrawn, focus is still on a crumb');
});

test('MEDIUM-1: a trail redrawn while its "…" menu is open closes the menu, and focus goes to the new "…" (QA-6b review F1.3, F1.5, F1.12)', () => {
  // A resize, ⌘B or a scan landing redraws the trail under an open menu. The
  // menu stayed up, bound to the old "…": the new one said aria-expanded
  // false over an open menu, a press of it re-opened instead of closing, and
  // Escape focused a button no longer on the page — focus fell to <body>.
  const { h, host, more } = foldedTrail();
  more.click();
  assert.equal(h.menu.buttons.includes(fakeDoc.active as FakeBtn), true, 'control: focus is in the open menu');
  host.clientWidth = 140; // the toolbar narrows
  h.observers[0].cb();
  const again = host.buttons.find((b) => b.more)!;
  assert.ok(again && again !== more, 'control: the redraw replaced "…"');
  assert.equal(h.menu.style.display, 'none', 'the menu of the old trail closes with it');
  assert.equal(fakeDoc.active, again, 'focus that was in it goes to the new "…", not to <body>');
  assert.equal(again.getAttribute('aria-expanded'), 'false', 'which says, truthfully, that its menu is closed');
  again.click();
  assert.equal(h.menu.style.display, 'block', 'one press of the new "…" opens its menu');
  assert.equal(again.getAttribute('aria-expanded'), 'true');
  again.click();
  assert.equal(h.menu.style.display, 'none', 'and the next closes it: the toggle follows the button on screen');
  again.click();
  h.keydown(keyEv('Escape'));
  assert.equal(fakeDoc.active, again, 'Escape gives focus back to the "…" on screen');
  // A load landing on another folder redraws the trail the same way.
  again.click();
  h.render(host, DEEP.slice(0, DEEP.lastIndexOf('/')), h.onPick);
  assert.equal(h.menu.style.display, 'none', 'a new folder\'s trail closes the menu of the old one');
  assert.equal(fakeDoc.active, host.buttons.find((b) => b.more), 'and focus is on its "…"');
  assert.deepEqual(h.picked, [], 'nothing was picked');
});

test('MEDIUM-1: another trail redrawn leaves an open "…" menu alone (QA-6b review F1.3)', () => {
  const { h, more } = foldedTrail();
  more.click();
  const at = fakeDoc.active;
  h.render(makeHost(1400), '/System/Library', h.onPick); // the Grid's or the City's trail
  assert.equal(h.menu.style.display, 'block', 'the menu belongs to the other trail and stays open');
  assert.equal(fakeDoc.active, at, 'with focus where it was');
  assert.equal(more.getAttribute('aria-expanded'), 'true');
});

test('MEDIUM-1: focus on "…" goes to the folder on screen when the redrawn trail has no "…" (QA-6b review F1.10)', () => {
  // Widened, or a shallow folder picked, the trail no longer folds: the
  // fallback is the only place focus can go that is not <body>.
  for (const menuOpen of [false, true]) {
    const { h, host, more } = foldedTrail();
    if (menuOpen) more.click(); else more.focus();
    host.clientWidth = 1400;
    h.observers[0].cb();
    assert.equal(host.buttons.some((b) => b.more), false, 'control: wide, the trail has no "…"');
    const here = host.buttons[host.buttons.length - 1];
    assert.equal(here.current, true, 'control: the last crumb is the folder on screen');
    assert.equal(fakeDoc.active, here, `focus ${menuOpen ? 'in the open menu' : 'on "…"'} goes to the folder on screen`);
    assert.equal(h.menu.style.display, menuOpen ? 'none' : undefined, 'and an open menu is closed');
  }
});

test('MEDIUM-1: a crumb a pointer pressed does not hold focus in the redrawn trail — Enter goes back to the map', () => {
  // Focus is kept across the redraw for "…" (the keyboard's way through the
  // menu). A click leaves focus on the crumb it pressed; keeping it there
  // would have made the next Enter reload that folder instead of reaching the map.
  const h = crumbsHarness();
  const host = makeHost(1400); // wide: every crumb is drawn, no "…"
  h.render(host, DEEP, h.onPick);
  const lib = host.buttons.find((b) => b.path === '/System/Library')!;
  lib.focus();
  lib.click();
  h.render(host, '/System/Library', h.onPick); // the load redraws the trail
  assert.equal(host.contains(fakeDoc.active), false, 'focus was not put back on a crumb');
});

test('MEDIUM-1: Enter on a link, or on anything with a button or menu-item role, is that control\'s press — not the map\'s', () => {
  // tmMapKeyYields asks closest('button, a[href], [role="button"], [role="menuitem"]'):
  // each kind is tried as itself, not as a button (QA-6b review F1.9).
  const h = crumbsHarness();
  const plain = fakeEl('DIV');
  plain.focus();
  h.keydown(keyEv('Enter'));
  assert.equal(h.map.drill, 1, 'control: Enter on an element that is no control drills the map');
  for (const el of [fakeEl('A', { href: '/help' }), fakeEl('DIV', { role: 'button' }), fakeEl('DIV', { role: 'menuitem' })]) {
    el.focus();
    const ev = keyEv('Enter');
    h.keydown(ev);
    assert.equal(h.map.drill, 1, `Enter on ${el.tagName} ${JSON.stringify(el.attrs)} does not drill the map`);
    assert.equal(ev.defaultPrevented, false, 'and its own press is not cancelled');
  }
  const bare = fakeEl('A');
  bare.focus();
  h.keydown(keyEv('Enter'));
  assert.equal(h.map.drill, 2, 'an <a> with no href is no link: Enter on it is the map\'s');
});

test('MEDIUM-1: the map keys used from a button beside the map hand focus to the map, so Enter after j or k still drills', () => {
  // Enter on a focused button is now that button's press. A click leaves
  // focus on the button it pressed — a crumb, Refresh, a renderer segment —
  // and someone who then steers the map with j and k means Enter for the map.
  const { h, host } = foldedTrail();
  const crumb = host.buttons[host.buttons.length - 1];
  crumb.focus();
  h.keydown(keyEv('j'));
  assert.equal(h.map.move, 1, 'j moves the selection');
  assert.equal(fakeDoc.active, h.canvas, 'and the map, which j drives, takes focus');
  h.keydown(keyEv('Enter'));
  assert.equal(h.map.drill, 1, 'so Enter drills the selection rather than pressing the crumb');
  for (const [key, count] of [['k', 'move'], ['h', 'up'], ['l', 'drill']] as const) {
    crumb.focus();
    const before = h.map[count];
    h.keydown(keyEv(key));
    assert.equal(h.map[count], before + 1, `${key} acts on the map`);
    assert.equal(fakeDoc.active, h.canvas, `${key} from a button hands focus to the map`);
  }
  fakeDoc.active = fakeDoc.body;
  h.keydown(keyEv('j'));
  assert.equal(fakeDoc.active, fakeDoc.body, 'with nothing focused, focus is left where it is');
});

test('MEDIUM-1: Tab out of the menu closes it, and the Tab goes on from "…"', () => {
  const { h, more } = foldedTrail();
  more.click();
  h.keydown(keyEv('ArrowDown'));
  const tab = keyEv('Tab');
  h.keydown(tab);
  assert.equal(h.menu.style.display, 'none', 'a menu Tabbed out of does not stay open, holding the map keys');
  assert.equal(fakeDoc.active, more, 'focus is back on "…"');
  assert.equal(tab.defaultPrevented, false, 'and the Tab itself still moves focus on, from there');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
});

test('MEDIUM-1: Tab closes the menu wherever focus is — still on Export, or on the map a right-click left it on (QA-6b review F1.1)', () => {
  // Export and a right-click open the menu without moving focus into it, and
  // Tab closed it only from inside: it stayed up, and while it was up the map
  // keys did nothing — only Escape or a click got out.
  const h = crumbsHarness();
  const btn = exportButton();
  btn.focus();
  h.exportClick({ stopPropagation() {}, currentTarget: btn });
  assert.equal(fakeDoc.active, btn, 'control: Export keeps focus while its menu opens');
  const tab = keyEv('Tab');
  h.keydown(tab);
  assert.equal(h.menu.style.display, 'none', 'Tab from Export closes its menu');
  assert.equal(btn.getAttribute('aria-expanded'), 'false', 'and Export says so');
  assert.equal(tab.defaultPrevented, false, 'the Tab itself goes on');
  assert.equal(fakeDoc.active, btn, 'from Export, where focus was');
  h.canvas.focus(); // where the Tab took it
  h.keydown(keyEv('j'));
  assert.equal(h.map.move, 1, 'with the menu gone, the map keys are the map\'s again');
  h.showCtxMenu(40, 50, { path: '/System/a.mov', name: 'a.mov', type: 'file' });
  assert.equal(fakeDoc.active, h.canvas, 'control: a right-click menu does not take focus');
  h.keydown(keyEv('Tab'));
  assert.equal(h.menu.style.display, 'none', 'Tab from the map closes a right-click menu too');
  assert.equal(fakeDoc.active, h.canvas, 'and leaves focus for the Tab to move');
});

test('MEDIUM-1: a pick from Export or from a right-click menu puts focus back where it was, not on <body> (QA-6b review F1.8)', () => {
  // Only the "…" menu's pick gave focus back; Export's and the right-click
  // menu's closed the menu around the focused entry, and focus fell to <body>.
  const h = crumbsHarness();
  const btn = exportButton();
  btn.focus();
  h.exportClick({ stopPropagation() {}, currentTarget: btn });
  h.keydown(keyEv('ArrowDown'));
  const png = fakeDoc.active as FakeBtn;
  assert.equal(png.dataset.exp, 'png', 'control: the PNG entry has focus');
  png.click(); // the press Enter on it makes
  assert.deepEqual(h.acts, ['png'], 'it exports the PNG');
  assert.equal(h.menu.style.display, 'none');
  assert.equal(fakeDoc.active, btn, 'and focus is back on Export');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  // Every entry the right-click menu builds — on disk, inside an archive, in the cloud.
  const cases: Array<[unknown, string, string]> = [
    [{ path: '/System/a.mov', name: 'a.mov', type: 'file' }, 'open', 'open /System/a.mov'],
    [{ path: '/System/a.zip/b.txt', name: 'b.txt', type: 'file', virtual: true }, 'copy', 'copy /System/a.zip/b.txt'],
    [{ path: 'cloud://drive/c', name: 'c', type: 'file' }, 'copy', 'copy cloud://drive/c'],
    [{ path: 'cloud://drive/c', name: 'c', type: 'file' }, 'cloudtrash', 'trash'],
  ];
  for (const [node, which, did] of cases) {
    h.acts.length = 0;
    h.canvas.focus();
    h.showCtxMenu(40, 50, node);
    const entry = h.menu.buttons.find((b) => b.dataset.act === which)!;
    entry.focus(); // reached with the arrows
    entry.click();
    assert.deepEqual(h.acts, [did], `${which} did its job`);
    assert.equal(h.menu.style.display, 'none');
    assert.equal(fakeDoc.active, h.canvas, `after ${which} on ${(node as { path: string }).path}, focus is back on the map`);
  }
});

test('MEDIUM-1: "…" says whether its menu is open, the menu is named and made of menu items, and a second click closes it', () => {
  const { h, more } = foldedTrail();
  assert.equal(more.getAttribute('aria-haspopup'), 'menu');
  assert.equal(more.getAttribute('aria-expanded'), 'false', 'closed, and says so');
  more.click();
  assert.equal(more.getAttribute('aria-expanded'), 'true', 'open, and says so');
  assert.match(h.menu.getAttribute('aria-label') || '', /folders above/i, 'the menu has an accessible name');
  assert.ok(h.menu.buttons.every((b) => b.getAttribute('role') === 'menuitem'), 'every entry is a menuitem');
  more.click();
  assert.equal(h.menu.style.display, 'none', 'a second click on "…" closes what the first opened');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
});

test('MEDIUM-1: the right-click menu is named and made of menu items too', () => {
  const menu = fakeMenu();
  const { show, keydown } = load<{ show: (x: number, y: number, node: unknown) => void; keydown: (e: KeyEv) => boolean }>(
    ['showCtxMenu', 'ctxTarget', ...CTX_MENU_DECLS], {
    $: (id: string) => { assert.equal(id, 'ctxMenu'); return menu; },
    document: fakeDoc,
    window: { innerWidth: 1440, innerHeight: 900 },
    state: { system: { platform: 'darwin' } },
    icon: () => '<svg></svg>',
    escapeHtml: esc,
    cartHas: () => false, budgetFor: () => null, noteFor: () => null,
  }, '{ show: showCtxMenu, keydown: ctxMenuKeydown }');
  fakeDoc.active = fakeDoc.body;
  show(40, 50, { path: '/r/movie.mov', name: 'movie.mov', type: 'file' });
  assert.equal(menu.style.display, 'block');
  assert.equal(menu.getAttribute('aria-label'), 'Actions for movie.mov');
  assert.ok(menu.buttons.length > 3 && menu.buttons.every((b) => b.getAttribute('role') === 'menuitem'), 'every entry is a menuitem');
  assert.ok(menu.divs.length >= 1, 'control: the menu has a divider, before Move to Trash');
  assert.ok(menu.divs.every((d) => d.getAttribute('role') === 'separator'), 'and every divider is a separator to assistive technology');
  // A text field keeps its own arrows while a right-click menu is up.
  fakeDoc.active = { tagName: 'INPUT' };
  const inField = keyEv('ArrowDown');
  assert.equal(keydown(inField), false, 'ArrowDown in a text field is the field\'s');
  assert.equal(inField.defaultPrevented, false);
  // An entry that cannot be used is not stepped onto.
  fakeDoc.active = fakeDoc.body;
  show(40, 50, { path: '/r/a.zip/inner.txt', name: 'inner.txt', type: 'file', virtual: true });
  assert.equal(menu.buttons.length, 2, 'Copy path, and the disabled note about the archive');
  keydown(keyEv('ArrowDown'));
  assert.equal(fakeDoc.active, menu.buttons[0]);
  keydown(keyEv('ArrowDown'));
  assert.equal(fakeDoc.active, menu.buttons[0], 'the disabled entry is skipped');
  keydown(keyEv('End'));
  assert.equal(fakeDoc.active, menu.buttons[0], 'End too');
});

test('MEDIUM-1: Export says it opens a menu and whether it is open, and Escape gives focus back to it (QA-6b review F1.7)', () => {
  // Driven through Export's own click listener: a regex over its source stayed
  // green with the opener left out, and nothing read the button's markup.
  const h = crumbsHarness();
  const btn = exportButton();
  assert.equal(btn.getAttribute('aria-haspopup'), 'menu', 'the markup says Export opens a menu');
  assert.equal(btn.getAttribute('aria-expanded'), 'false', 'and that it is closed');
  btn.focus();
  const enter = keyEv('Enter');
  h.keydown(enter);
  assert.equal(enter.defaultPrevented, false, 'Enter on Export is Export\'s press');
  assert.equal(h.map.drill, 0);
  h.exportClick({ stopPropagation() {}, currentTarget: btn }); // the press Enter makes
  assert.equal(h.menu.style.display, 'block', 'the menu opens');
  assert.equal(btn.getAttribute('aria-expanded'), 'true', 'and Export says it is open');
  assert.equal(h.menu.getAttribute('aria-label'), 'Export the map', 'the menu is named');
  assert.deepEqual(h.menu.buttons.map((b) => b.dataset.exp), ['png', 'svg', 'csv-files', 'csv-folders', 'xlsx-files', 'xlsx-folders', 'pdf'],
    'the map\'s two image formats, and the reports a finished scan offers');
  assert.ok(h.menu.buttons.every((b) => b.getAttribute('role') === 'menuitem'), 'as menu items');
  h.keydown(keyEv('ArrowDown'));
  assert.equal(fakeDoc.active, h.menu.buttons[0], 'ArrowDown from Export goes into the menu');
  h.keydown(keyEv('Escape'));
  assert.equal(h.menu.style.display, 'none', 'Escape closes it');
  assert.equal(fakeDoc.active, btn, 'and focus is back on Export, not on <body>');
  assert.equal(btn.getAttribute('aria-expanded'), 'false', 'which says the menu is closed');
  assert.deepEqual(h.acts, [], 'nothing was exported');
});

/* ══════════════ QA-6 review LOW-4 — #ctxMenu fits the window ══════════════ */

test('LOW-4: a menu taller than the window opens at its top edge, never above it', () => {
  // ≥ ~25 folded ancestors at 900 px: top = min(36, 900 − height − 8) went negative,
  // and the first folders — the root among them — were off the top of the window.
  const { h, more } = foldedTrail();
  h.menu.offsetHeight = 1200;
  more.click();
  assert.equal(h.menu.style.top, '8px', 'pinned 8 px below the top of the window');
  const narrow = load<(menu: FakeMenu, o: unknown) => void>(CTX_MENU_DECLS, {
    document: fakeDoc, window: { innerWidth: 200, innerHeight: 900 },
  }, 'ctxMenuShow');
  const m = fakeMenu();
  narrow(m, { label: 'x', x: 150, y: 20 });
  assert.equal(m.style.left, '8px', 'and never off the left edge of a window narrower than the menu');
});

test('LOW-4: the menu scrolls inside a short window, and scrolling it does not close it', () => {
  const at = INDEX.indexOf('#ctxMenu { position: fixed;');
  assert.notEqual(at, -1);
  const rule = INDEX.slice(at, INDEX.indexOf('}', at));
  const edge = Number(load<number>(['CTX_MENU_EDGE'], {}, 'CTX_MENU_EDGE'));
  assert.match(rule, new RegExp(`max-height:\\s*calc\\(100vh - ${2 * edge}px\\)`), 'no taller than the window less the edge kept above and below');
  assert.match(rule, /overflow-y:\s*auto/, 'and what does not fit scrolls');
  // The capture-phase scroll listener closed the menu on ANY scroll — its own list's included.
  const menu = fakeMenu();
  menu.style.display = 'block';
  const onScroll = load<(e: { target: unknown }) => void>(['ctxMenuOnScroll', ...CTX_MENU_DECLS], {
    $: () => menu, document: fakeDoc,
  }, 'ctxMenuOnScroll');
  onScroll({ target: menu });
  assert.equal(menu.style.display, 'block', 'scrolling the menu itself leaves it open');
  onScroll({ target: { tagName: 'MAIN' } });
  assert.equal(menu.style.display, 'none', 'a scroll anywhere else still closes it');
  assert.ok(INDEX.includes("document.addEventListener('scroll', ctxMenuOnScroll, true);"), 'and that is the listener the page installs');
});

/* ══════════════ D58 — the 20,000-node cap is stated, not left as a blank ══════════════ */

type TmNode = { path: string; size: number; depth: number; expanded: boolean; isTrash?: boolean };

const CAP_NOTE_DECLS = ['tmNodeCapNote', 'tmDrawnTree', 'tmParentPath', 'TM_SERVER_NODE_CAP', 'TM_MIN_SIZE', 'tmCapMemo'];

/** The note under a map of `nodes`, drawn with the floor `minSize` (what loadTreemap records; 4096 is its first ask). */
function capNote(nodes: TmNode[], rootSize: number, history = false, minSize = 4096): string {
  const note = load<() => string>(CAP_NOTE_DECLS, {
    state: { treemap: { rootPath: '/r', rootSize, nodes, minSize, history: { active: history } } },
    formatCount: fmtCount,
    formatBytes: (n: number) => `${n} B`,
  }, 'tmNodeCapNote');
  return note();
}

const files = (n: number, size: number, dir = '/r'): TmNode[] =>
  Array.from({ length: n }, (_, i) => ({ path: `${dir}/f${i}`, size, depth: 1, expanded: false }));

test('D58: a map cut at the server\'s 20,000 nodes says so, and how much has no rectangle', () => {
  // QA: a folder of 25,600 files drew 20,000 and left a blank rectangle for
  // the rest, with "20,000 nodes · 20,000 drawn" as the only words.
  const note = capNote(files(20000, 250), 25600 * 250);
  assert.match(note, /holds at most 20,000 items, and this folder reached that/, 'the cap is named');
  assert.match(note, /1400000 B has no rectangle here/, 'the 5,600 undrawn files are 1.4 MB of blank map, stated exactly');
  assert.match(note, /drill in, or open the Grid view/, 'and the way to see them');
});

test('D58: the undrawn bytes come from every outlined folder, not only the top level', () => {
  // Breadth-first: the cap leaves whole subtrees out at the BOTTOM of the
  // drawing order — a folder outlined with nothing inside it.
  const nodes = [
    ...files(19998, 10),
    { path: '/r/big', size: 5000, depth: 1, expanded: true },
    { path: '/r/big/a', size: 1000, depth: 2, expanded: false },
  ];
  const note = capNote(nodes, 19998 * 10 + 5000);
  assert.match(note, /4000 B has no rectangle here/, 'big/ is outlined at 5,000 B with 1,000 B drawn inside it');
});

test('D58: under the cap the map says nothing extra — and the Trash cell is not a node the server sent', () => {
  assert.equal(capNote(files(19999, 250), 19999 * 250 + 5000), '', '19,999 nodes were not cut by a 20,000 cap');
  const withTrash = [...files(19999, 250), { path: '\0trash', size: 1e9, depth: 1, expanded: false, isTrash: true }];
  assert.equal(capNote(withTrash, 19999 * 250), '', 'the injected Trash cell does not make 19,999 into 20,000');
});

test('LOW-2: the page\'s 20,000 is the server\'s — read from both routes that cap a treemap', () => {
  // The response is golden-locked, so it cannot say it was cut: the page has
  // to know the number, and a copy nothing checks drifts the day either changes.
  const cap = load<number>(['TM_SERVER_NODE_CAP'], {}, 'TM_SERVER_NODE_CAP');
  const routes: Array<[string, RegExp]> = [
    ['src/api/scanRoutes.ts', /buildTreemapFromStore\(store, rootId, \{[^}]*maxNodes: ([\d_]+)/], // the live map
    ['src/api/insightRoutes.ts', /buildTreemap\(root, \{[^}]*maxNodes: ([\d_]+)/], // the time slider's
  ];
  for (const [file, re] of routes) {
    const m = re.exec(readFileSync(path.join(__dirname, '..', file), 'utf8'));
    assert.ok(m, `${file} still caps the treemap with a maxNodes literal`);
    assert.equal(Number(m![1].replace(/_/g, '')), cap, `${file}'s maxNodes is the page's TM_SERVER_NODE_CAP`);
  }
});

test('LOW-2: exactly 20,000 items with every byte drawn is not called cut', () => {
  // `sent >= 20000` also fired on a folder of exactly 20,000 items. A cut
  // always leaves bytes undrawn — the items it left out are at least 4 KB —
  // so a full map that reached the cap with nothing undrawn says nothing.
  assert.equal(capNote(files(20000, 250), 20000 * 250), '');
});

test('LOW-2: the undrawn figure says it counts files under the 4 KB floor, which no drill-in reveals', () => {
  const note = capNote(files(20000, 250), 25600 * 250);
  assert.match(note, /That figure counts files under 4096 B too, which the map does not draw; the Grid view lists them\./);
  // The time slider's map is laid out with no floor (minSize: 0).
  const history = capNote(files(20000, 250), 25600 * 250, true);
  assert.match(history, /holds at most 20,000 items/);
  assert.doesNotMatch(history, /under 4096 B/, 'a history map has no floor to mention');
});

test('LOW-2: the floor the note names is the one the map is asked for', async () => {
  let url = '';
  const state = { scanId: 's1', root: { path: '/r' }, pathIndex: new Map(),
    treemap: { mode: 'treemap', colorMode: 'size', rootPath: '/r', maxDepth: 4, nodes: [], history: { scrubbing: false } } };
  const loadTreemap = load<(p: string) => Promise<void>>(['loadTreemap', 'TM_MIN_SIZE'], {
    state, REDUCED: true, isSun: () => false, isCells: () => false, exitCartPreview() {}, $: () => ({ classList: { add() {}, remove() {} } }),
    api: async (u: string) => { url = u; throw new Error('stop here'); }, toast() {},
  }, 'loadTreemap', 'let tmLoadSeq = 0;');
  await loadTreemap('/r');
  const floor = load<number>(['TM_MIN_SIZE'], {}, 'TM_MIN_SIZE');
  assert.match(url, new RegExp(`[?&]minSize=${floor}&`), 'loadTreemap asks for the floor TM_MIN_SIZE names');
  const live = INDEX.slice(INDEX.indexOf('async function liveRelayout('), INDEX.indexOf('animateTreemapTo(data.nodes)'));
  assert.match(live, /minSize=\$\{TM_MIN_SIZE\}/, 'and so does the live re-layout');
});

/**
 * The real loadTreemap and liveRelayout over a stubbed server, and the real
 * note for whatever they left on screen. `serve(minSize)` answers each ask.
 */
function mapAndNote(serve: (minSize: number) => { root: { path: string; name: string; size: number }; nodes: TmNode[] }) {
  const asked: number[] = [];
  const state = {
    scanId: 's1', root: { path: '/r' }, pathIndex: new Map(), view: 'treemap', scanning: false,
    live: { on: true, dirty: 1 },
    treemap: { mode: 'treemap', colorMode: 'size', rootPath: '/r', rootSize: 0, maxDepth: 4, nodes: [] as TmNode[], minSize: undefined as number | undefined,
      hover: null, kbSel: null, history: { scrubbing: false, active: false } },
  };
  const page = load<{ loadTreemap: (p: string) => Promise<void>; liveRelayout: () => Promise<void>; note: () => string }>(
    ['loadTreemap', 'liveRelayout', ...CAP_NOTE_DECLS], {
      state, REDUCED: true, isSun: () => false, isCells: () => false, exitCartPreview() {},
      $: () => ({ classList: { add() {}, remove() {} }, disabled: false }),
      api: async (u: string) => { const m = Number(/[?&]minSize=(\d+)/.exec(u)![1]); asked.push(m); return serve(m); },
      toast: (m: string) => { throw new Error('the page reported: ' + m); },
      renderCrumbs() {}, maybeInjectTrash() {}, exitHistoryState() {}, refreshTimebar() {}, drawView() {},
      animateTreemapTo: (nodes: TmNode[]) => { state.treemap.nodes = nodes; },
      formatCount: fmtCount, formatBytes: (n: number) => `${n} B`,
    }, '{ loadTreemap, liveRelayout, note: tmNodeCapNote }', 'let tmLoadSeq = 0;');
  return { ...page, state, asked };
}

test('LOW-2: a map loadTreemap asked for again with no floor does not say it hides files under one (QA-6b review F1.2, F1.4)', async () => {
  // A flat folder of 25,600 files of 250 B: the 4 KB ask draws nothing, so
  // loadTreemap asks again with minSize=1 and gets 20,000 of them. That map
  // DOES draw 250-byte files; the 1.4 MB with no rectangle is what the cap cut.
  const root = { path: '/r', name: 'r', size: 25600 * 250 };
  const small = mapAndNote((m) => ({ root, nodes: m <= 250 ? files(20000, 250) : [] }));
  await small.loadTreemap('/r');
  assert.deepEqual(small.asked, [4096, 1], 'control: the floor was dropped for the second ask');
  assert.equal(small.state.treemap.nodes.length, 20000);
  const note = small.note();
  assert.match(note, /holds at most 20,000 items, and this folder reached that: 1400000 B has no rectangle here/, 'the cut is still said');
  assert.doesNotMatch(note, /files under/, 'and no floor is claimed for a map that has none');
  // The same folder with files over the floor keeps the sentence: its map was asked with 4 KB.
  const big = mapAndNote(() => ({ root: { path: '/r', name: 'r', size: 25600 * 5000 }, nodes: files(20000, 5000) }));
  await big.loadTreemap('/r');
  assert.deepEqual(big.asked, [4096]);
  assert.match(big.note(), /That figure counts files under 4096 B too, which the map does not draw; the Grid view lists them\./);
});

test('LOW-2: the live re-layout records the floor it asks with, and the note follows it (QA-6b review F1.2)', async () => {
  // Live mode on that folder of small files, while they grow past 4 KB.
  let grown = false;
  const h = mapAndNote((m) => (grown
    ? { root: { path: '/r', name: 'r', size: 25600 * 5000 }, nodes: files(20000, 5000) }
    : { root: { path: '/r', name: 'r', size: 25600 * 250 }, nodes: m <= 250 ? files(20000, 250) : [] }));
  await h.loadTreemap('/r');
  grown = true;
  assert.doesNotMatch(h.note(), /files under/, 'control: the retry map claims no floor');
  await h.liveRelayout();
  assert.deepEqual(h.asked, [4096, 1, 4096], 'control: the live re-layout asks with the 4 KB floor');
  assert.match(h.note(), /counts files under 4096 B too/, 'so the map it lays out says so');
});

test('LOW-2: the note is recomputed when only the floor changed (QA-6b review F1.2)', () => {
  const state = { treemap: { rootPath: '/r', rootSize: 25600 * 250, nodes: files(20000, 250), minSize: 4096, history: { active: false } } };
  const note = load<() => string>(CAP_NOTE_DECLS, { state, formatCount: fmtCount, formatBytes: (n: number) => `${n} B` }, 'tmNodeCapNote');
  assert.match(note(), /files under 4096 B/);
  state.treemap.minSize = 1; // the same nodes, read under another floor
  assert.doesNotMatch(note(), /files under/, 'the remembered note is not served for another floor');
});

test('D58: every rectangle-map paint refreshes the note under the map', () => {
  const start = INDEX.indexOf('function drawTreemap() {');
  const body = INDEX.slice(start, INDEX.indexOf('\n}', start));
  const at = body.indexOf('state.treemap.altNote = tmNodeCapNote();');
  assert.ok(at > body.indexOf('state.treemap.pxRects = px;'), 'drawTreemap writes the note once it knows what it drew');
  assert.ok(at < body.indexOf('if (!px.length)'), 'before the empty-map return, so a stale note never outlives its map');
  assert.match(body.slice(at, at + 200), /renderAltNote\(\);/, 'and shows it');
});

/* ══════════════ D59 — the time-lapse bar appearing re-fits the map ══════════════ */

/**
 * Run the real `refreshTimebar` with the bar starting `startHidden` and the
 * snapshot list answering `snaps` entries; count the redraws it asks for.
 * `during` runs while the snapshot request is out.
 */
async function timebar(startHidden: boolean, snaps: number, opts: { view?: string; rootPath?: string; during?: (s: any, els: any) => void; calls?: number } = {}) {
  const els: Record<string, { hidden: boolean; value?: string; max?: string }> = {
    tmTimebar: { hidden: startHidden }, tmLiveToggle: { hidden: false }, tmTimeSlider: { hidden: false, value: '0', max: '0' },
  };
  const state = {
    view: opts.view ?? 'treemap',
    root: { path: '/r' },
    treemap: { rootPath: opts.rootPath ?? '/r', lapse: { playing: false }, history: { snaps: [] as unknown[], active: false, scrubbing: false } },
  };
  let redraws = 0;
  const refresh = load<() => Promise<void>>(['refreshTimebar'], {
    $: (id: string) => els[id],
    state,
    isCloudScan: () => false,
    api: async () => {
      if (opts.during) opts.during(state, els);
      return { snapshots: Array.from({ length: snaps }, (_, i) => ({ id: i, takenAt: i })) };
    },
    lapseOrderedSnaps: (s: unknown[]) => s,
    updateTimeLabel() {},
    drawView: () => { redraws++; },
  }, 'refreshTimebar');
  // `calls` at once: loadTreemap's call and finishScan's 1.5 s timer call can both be out.
  await Promise.all(Array.from({ length: opts.calls ?? 1 }, () => refresh()));
  return { redraws, hidden: els.tmTimebar.hidden };
}

test('D59: when the history bar appears or goes, the map is re-measured and redrawn', async () => {
  // QA at 1440×900: the bar unhid after the map was sized, pushed it down,
  // and cut the footer (legend, node count, hint) off the window.
  assert.deepEqual(await timebar(true, 2), { redraws: 1, hidden: false }, 'the bar appeared: one redraw');
  assert.deepEqual(await timebar(false, 1), { redraws: 1, hidden: true }, 'the bar went: the map takes the room back');
});

test('D59: no redraw when nothing moved, when the map is not on screen, or when the caller draws next', async () => {
  assert.deepEqual(await timebar(false, 3), { redraws: 0, hidden: false }, 'shown before and after');
  assert.deepEqual(await timebar(true, 1), { redraws: 0, hidden: true }, 'hidden before and after');
  assert.deepEqual(await timebar(true, 2, { view: 'grid' }), { redraws: 0, hidden: false }, 'a hidden view is not drawn');
  assert.deepEqual(await timebar(false, 2, { rootPath: '/r/sub' }), { redraws: 0, hidden: true },
    'in a subfolder the bar hides at once, before loadTreemap draws');
});

test('D59: a snapshot answer that lands after the map left the scan root does not bring the bar back', async () => {
  const r = await timebar(true, 2, {
    during: (state, els) => { state.treemap.rootPath = '/r/sub'; els.tmTimebar.hidden = true; },
  });
  assert.deepEqual(r, { redraws: 0, hidden: true }, 'the newer load (in a subfolder) owns the bar');
});

test('LOW-4: two snapshot answers in flight redraw the map once, not twice', async () => {
  // Each call captured the bar's state BEFORE its await, so when loadTreemap's
  // call and finishScan's timer call were both out, both saw "hidden → shown"
  // and both redrew — a Voronoi or Circles re-solve each, up to 200 ms apiece.
  assert.deepEqual(await timebar(true, 2, { calls: 2 }), { redraws: 1, hidden: false }, 'the bar appeared once: one redraw');
  assert.deepEqual(await timebar(false, 1, { calls: 2 }), { redraws: 1, hidden: true }, 'and went once: one redraw');
});

test('LOW-4: a new circle or Voronoi layout ends the level transition still running on the old one', () => {
  // The zoom's `to` is where the shared node sat in the layout being replaced:
  // a redraw that re-solved under a running zoom (the time-lapse bar
  // appearing, a resize) made it jump. loadTreemap starts the new zoom after.
  const cancelled: number[] = [];
  const state = { treemap: { mode: 'circles', cells: [] as unknown[], altNote: '', altMs: 0,
    altZoom: { k: 2, start: 0 } as unknown, altZoomRaf: 7 } };
  const build = load<(geo: unknown) => void>(['buildCells'], {
    state,
    sunburstRoot: () => ({ path: '/r' }),
    altRefineCancel() {},
    performance: { now: () => 0 },
    layoutCirclePack: () => ({ cells: [{ n: { path: '/r/a' } }], done: true, note: '' }),
    layoutVoronoi: () => { throw new Error('the circles mode lays out circles'); },
    altRefineSchedule() {}, altRefiningNote: () => '', fxShapeSync() {},
    cancelAnimationFrame: (id: number) => { cancelled.push(id); },
  }, 'buildCells');
  build({ cssW: 800, cssH: 600, dpr: 1 });
  assert.equal(state.treemap.altZoom, null, 'the running zoom is over');
  assert.equal(state.treemap.altZoomRaf, 0);
  assert.deepEqual(cancelled, [7], 'and its frame loop is cancelled, not left to paint the old transform');
  assert.equal(state.treemap.cells.length, 1, 'the new layout is in place');
});

/* ══════════════ D63 — the keyboard selection's card goes when the map does ══════════════ */

test('D63: a press or a focus anywhere but the map takes the map\'s card down; one on the map does not', () => {
  // QA: after j selected "Archives", its card stayed up over the cart panel
  // and through Preview after — only map navigation ever hid it.
  const canvas = { id: 'treemapCanvas' };
  let hides = 0;
  const view = { name: 'treemap' };
  const dismiss = load<(e: { target: unknown }) => void>(['tmTipDismiss'], {
    state: { get view() { return view.name; } },
    tmCanvas: canvas,
    hideTooltip: () => { hides++; },
  }, 'tmTipDismiss');
  dismiss({ target: { id: 'cartTab' } });
  assert.equal(hides, 1, 'a press on the cart tab hides it');
  dismiss({ target: canvas });
  assert.equal(hides, 1, 'a press on the map is the map\'s business — hover and click manage the card there');
  view.name = 'grid';
  dismiss({ target: { id: 'gridTile' } });
  assert.equal(hides, 1, 'another view\'s card is not the map\'s to hide');
});

test('D63: the dismissal is wired to presses, focus moves and the canvas losing focus', () => {
  assert.ok(INDEX.includes("document.addEventListener('pointerdown', tmTipDismiss, true);"), 'every press, in capture');
  assert.ok(INDEX.includes("document.addEventListener('focusin', tmTipDismiss, true);"), 'every focus move — Tab into the cart');
  assert.ok(INDEX.includes("tmCanvas.addEventListener('blur', hideTooltip);"), 'and the map losing focus');
});

test('D63: entering and leaving the cart preview take the selection\'s card down with the selection', () => {
  let hides = 0;
  const base = {
    hideTooltip: () => { hides++; },
    isSun: () => false, isCells: () => false, isRectMap: () => true,
    toast: (m: string) => { throw new Error('refused: ' + m); },
    formatCount: String,
    syncCartPreviewChrome() {}, drawTreemap() {}, exitCartPreview() {},
    tmBuildPreview: () => ({ nodes: [{ path: '/r/x' }], freedBytes: 5, stagedInView: 1, outsideView: 0, outsideBytes: 0 }),
  };
  const state = { view: 'treemap', cart: { size: 1 }, treemap: { history: { active: false }, nodes: [{ path: '/r/x' }], hover: null, kbSel: { path: '/r/x' } } };
  const tmPreview: Record<string, unknown> = { on: false };
  const enter = load<() => void>(['enterCartPreview'], { ...base, state, tmPreview }, 'enterCartPreview');
  enter();
  assert.equal(tmPreview.on, true, 'the preview started');
  assert.equal(hides, 1, 'and the card of the selection it cleared went with it');
  const exit = load<(silent?: boolean) => void>(['exitCartPreview'], { ...base, state, tmPreview }, 'exitCartPreview');
  state.treemap.kbSel = { path: '/r/x' };
  exit();
  assert.equal(tmPreview.on, false, 'the preview ended');
  assert.equal(hides, 2, 'leaving it clears the selection, and its card, too');
});

/* ══════════════ D64 — the preview banner sits above the map, not on it ══════════════ */

function previewChrome() {
  const props: Record<string, string> = {};
  const wrap = {
    previewing: false,
    classList: { toggle(_c: string, on: boolean) { wrap.previewing = on; } },
    style: {
      setProperty(k: string, v: string) { props[k] = v; }, removeProperty(k: string) { delete props[k]; },
      getPropertyValue: (k: string) => props[k] ?? '',
    },
  };
  const banner = { hidden: true, offsetHeight: 44 };
  const els: Record<string, unknown> = {
    cartPreview: { setAttribute() {}, classList: { toggle() {} } },
    treemapWrap: wrap, tmPreviewBanner: banner, tmPreviewText: { innerHTML: '' },
  };
  const tmPreview = { on: true, freedBytes: 5e9, outsideView: 0, outsideBytes: 0 };
  const observers: Array<() => void> = [];
  class FakeRO { cb: () => void; constructor(cb: () => void) { this.cb = cb; } observe() { observers.push(this.cb); } }
  const counts = { draws: 0 };
  const sync = load<() => void>(['syncCartPreviewChrome', 'TM_PREVIEW_BANNER_INSET', 'tmPreviewPadSync', 'tmPreviewWatch'], {
    $: (id: string) => els[id], tmPreview,
    escapeHtml: (s: string) => s, formatBytes: (n: number) => `${n} B`, formatCount: String,
    ResizeObserver: FakeRO, state: { view: 'treemap' }, isRectMap: () => true,
    drawTreemap: () => { counts.draws++; },
  }, 'syncCartPreviewChrome');
  return { sync, props, banner, tmPreview, wrap, observers, counts };
}

test('D64: the preview pads the map down by its banner\'s measured height', () => {
  // QA: the absolutely-positioned banner sat over the map's top-left tiles
  // and hid their labels ("Videos", "holiday-4k.mov").
  const p = previewChrome();
  p.sync();
  assert.equal(p.wrap.previewing, true);
  assert.equal(p.props['--tm-preview-pad'], '64px', '10 px above the banner, its 44 px, 10 px below');
  p.banner.offsetHeight = 62; // the text wrapped beside the open cart
  p.sync();
  assert.equal(p.props['--tm-preview-pad'], '82px', 'a taller banner pushes the map further');
  p.tmPreview.on = false;
  p.sync();
  assert.equal(p.props['--tm-preview-pad'], undefined, 'leaving the preview gives the room back');
});

test('LOW-3: the pad follows the banner while the preview is up — the cart dock opening, a resize — one redraw per change', () => {
  // The banner narrows beside the open cart dock (max-width: calc(100% - 402px))
  // and on a resize, and wraps to more lines; measured only on enter and exit,
  // the pad went stale and the banner covered the top row again.
  const p = previewChrome();
  p.sync();
  assert.equal(p.props['--tm-preview-pad'], '64px');
  assert.equal(p.observers.length, 1, 'the banner is watched for its size');
  p.observers[0](); // the observer's first call, as it is installed
  assert.equal(p.counts.draws, 0, 'nothing changed, nothing is redrawn');
  p.banner.offsetHeight = 62; // the cart dock opened: the banner wrapped to two lines
  p.observers[0]();
  assert.equal(p.props['--tm-preview-pad'], '82px', 're-measured');
  assert.equal(p.counts.draws, 1, 'and the map redrawn under the new pad');
  p.observers[0]();
  assert.equal(p.counts.draws, 1, 'a callback with no change of height redraws nothing');
  p.tmPreview.on = false;
  p.sync();
  p.banner.offsetHeight = 44;
  p.observers[0]();
  assert.equal(p.props['--tm-preview-pad'], undefined, 'out of the preview nothing is padded');
  assert.equal(p.counts.draws, 1, 'or redrawn');
  p.tmPreview.on = true;
  p.sync();
  assert.equal(p.observers.length, 1, 'one observer however many times the preview starts');
});

test('D64: the map the preview draws is shorter by the banner\'s pad, re-measured, and gets the room back on exit', () => {
  // The test below checks treemapCanvasHeight's subtraction, which predates
  // D64. This drives the preview's own order — the pad is set BEFORE the map
  // is drawn, re-measured when the banner rewraps, and taken off before the
  // exit redraw — through the real functions, with the CSS as a stub:
  // #treemapWrap.previewing { padding-top: var(--tm-preview-pad, 64px) }.
  const props: Record<string, string> = {};
  const wrap = {
    previewing: false,
    classList: { toggle(_c: string, on: boolean) { wrap.previewing = on; } },
    style: {
      setProperty(k: string, v: string) { props[k] = v; }, removeProperty(k: string) { delete props[k]; },
      getPropertyValue: (k: string) => props[k] ?? '',
    },
    getBoundingClientRect: () => ({ top: 150 }),
    parentElement: { querySelector: () => ({ getBoundingClientRect: () => ({ height: 30 }) }) },
    closest: () => ({}),
  };
  const banner = { hidden: true, offsetHeight: 44 };
  const els: Record<string, unknown> = {
    cartPreview: { setAttribute() {}, classList: { toggle() {} } },
    treemapWrap: wrap, tmPreviewBanner: banner, tmPreviewText: { innerHTML: '' },
  };
  const observers: Array<() => void> = [];
  class FakeRO { cb: () => void; constructor(cb: () => void) { this.cb = cb; } observe() { observers.push(this.cb); } }
  const heights: number[] = [];
  let heightOf: (w: unknown) => number = () => NaN;
  const nodes = [{ path: '/r/x' }];
  const state = { view: 'treemap', cart: { size: 1 }, treemap: { history: { active: false }, nodes, hover: null, kbSel: null } };
  const out = load<{ enter: () => void; exit: () => void; heightOf: (w: unknown) => number }>(
    ['enterCartPreview', 'exitCartPreview', 'syncCartPreviewChrome', 'TM_PREVIEW_BANNER_INSET', 'tmPreviewPadSync', 'tmPreviewWatch', 'treemapCanvasHeight'], {
      $: (id: string) => els[id], state, tmPreview: { on: false },
      isSun: () => false, isCells: () => false, isRectMap: () => true,
      toast: (m: string) => { throw new Error('refused: ' + m); },
      formatCount: String, formatBytes: (n: number) => `${n} B`, escapeHtml: (x: string) => x, hideTooltip() {},
      tmBuildPreview: () => ({ nodes: [{ path: '/r/y' }], freedBytes: 5, stagedInView: 1, outsideView: 0, outsideBytes: 0 }),
      drawTreemap: () => { heights.push(heightOf(wrap)); },
      window: { innerHeight: 900 },
      getComputedStyle: (el: unknown) => (el === wrap
        ? { paddingTop: wrap.previewing ? (props['--tm-preview-pad'] ?? '64px') : '10px', paddingBottom: '10px' }
        : { marginTop: '12px', paddingBottom: '24px' }),
      ResizeObserver: FakeRO,
    }, '{ enter: enterCartPreview, exit: exitCartPreview, heightOf: treemapCanvasHeight }');
  heightOf = out.heightOf;
  const full = heightOf(wrap);
  out.enter();
  assert.deepEqual(heights, [full - 54], 'drawn under the preview: its 64 px pad (44 px banner, 10 px either side) for the 10 px it had');
  banner.offsetHeight = 62; // the cart dock opened beside it: the banner wrapped
  observers[0]();
  assert.deepEqual(heights, [full - 54, full - 72], 're-measured and redrawn 18 px shorter');
  out.exit();
  assert.deepEqual(heights, [full - 54, full - 72, full], 'and the exit redraw has every pixel back');
});

test('D64: the previewing wrap takes that padding, and the map\'s height gives it back', () => {
  const at = INDEX.indexOf('#treemapWrap.previewing {');
  assert.notEqual(at, -1);
  assert.match(INDEX.slice(at, INDEX.indexOf('}', at)), /padding-top:\s*var\(--tm-preview-pad,/,
    'the wrap is padded by the measure while previewing');
  // treemapCanvasHeight subtracts the wrap's own top padding, so the padded
  // map still fits the window above its footer.
  const height = (padTop: string) => load<(w: unknown) => number>(['treemapCanvasHeight'], {
    getComputedStyle: (el: { pad?: string }) => (el.pad
      ? { paddingTop: el.pad, paddingBottom: '10px' }
      : { marginTop: '12px', paddingBottom: '24px' }),
    window: { innerHeight: 900 },
  }, 'treemapCanvasHeight')({
    pad: padTop,
    getBoundingClientRect: () => ({ top: 150 }),
    parentElement: { querySelector: () => ({ getBoundingClientRect: () => ({ height: 30 }) }) },
    closest: () => ({}),
  });
  assert.equal(height('10px') - height('64px'), 54, 'every pixel of padding comes off the map, none off the footer');
});
