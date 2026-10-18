import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEX, lift } from './fixtures/liftFrontend';

/**
 * Design pass G24 — the Apps view.
 *
 * Every row printed its size twice: "IntelliJ IDEA app 4.5 GB … 4.5 GB",
 * because the per-category summary beside the name repeated the only
 * category's size that the badge already shows. And the scatter above the
 * list had no axis titles: a log y-axis reading "4.5 GB / 1.0 MB / 1.0 KB /
 * 0 B" over unlabelled dots. `appCatSummary` and `renderApps` are EXECUTED
 * out of the built page.
 */

function slice(a: string, b: string): string {
  const i = INDEX.indexOf(a);
  assert.notEqual(i, -1, `anchor "${a}" exists`);
  const j = INDEX.indexOf(b, i + a.length);
  assert.notEqual(j, -1, `anchor "${b}" follows`);
  return INDEX.slice(i, j);
}

const summary = lift<(app: { bytesByCategory: Record<string, number> }) => string>(
  ['UNITS', 'UI_LOCALE', 'formatBytes', 'APP_CAT_LABEL', 'appCatSummary'], 'appCatSummary');

test('an app\'s summary names what its size is made of without repeating the size the row already shows (G24)', () => {
  assert.equal(summary({ bytesByCategory: { app: 4_500_000_000 } }), 'app only', 'one category: its name, not the size beside it again');
  assert.equal(summary({ bytesByCategory: { app: 0, cache: 2_000_000 } }), 'caches only');
  assert.equal(summary({ bytesByCategory: { app: 4_000_000_000, cache: 200_000_000, data: 0, logs: 1_000_000 } }),
    'app 4.0 GB · caches 200.0 MB · logs 1.0 MB', 'several: each part\'s own size, which the row\'s total does not show');
});

test('each app row prints its size once (G24)', () => {
  type El = { innerHTML: string; textContent: string; querySelectorAll: () => never[] };
  const els: Record<string, El> = {};
  const $ = (id: string) => (els[id] ??= { innerHTML: '', textContent: '', querySelectorAll: () => [] });
  const fb = lift<(n: number) => string>(['UNITS', 'formatBytes'], 'formatBytes');
  const src = slice('function renderApps() {', '/* ── The apps scatter');
  const app = (name: string, cats: Record<string, number>) => {
    const totalBytes = Object.values(cats).reduce((a, b) => a + b, 0);
    return { name, totalBytes, bytesByCategory: cats, safeToClearBytes: 0, safeToClearPaths: [], locations: [{ path: `/Applications/${name}.app`, bytes: totalBytes, category: 'app' }] };
  };
  const apps = [app('IntelliJ IDEA', { app: 4_500_000_000 }), app('Google Chrome', { app: 1_500_000_000 }), app('Notes', { app: 900_000_000, data: 100_000_000 })];
  const state = { root: { path: '/Applications' }, scanId: 's', apps: { list: apps, totalBytes: 7_000_000_000, otherBytes: 0, appsFolderScanned: true } };
  new Function('$', 'state', 'FxNum', 'escapeHtml', 'formatBytes', 'icon', 'sizeInk', 'fxBarStyle', 'fxBarsIn', 'cartButtonHtml', 'refreshCartButtons',
    'appsScatterDrop', 'loadAppsScatter', 'confirmTrash', 'switchView', 'showCtxMenu', 'MB', 'APP_CAT_LABEL', 'APP_CART_CATEGORIES', 'appCatSummary',
    `'use strict'; ${src} renderApps();`)(
    $, state, { rollHtml: () => {} }, (s: string) => s, fb, () => '', () => '#000', () => '', () => {}, () => '', () => {},
    () => {}, async () => {}, () => {}, () => {}, () => {}, 1e6, { app: 'App', cache: 'Caches', data: 'Data', logs: 'Logs' }, new Set(['cache', 'logs']),
    (a: { bytesByCategory: Record<string, number> }) => summary(a));
  const heads = els.appsBody.innerHTML.split('<div class="bp-head"').slice(1).map((h) => h.slice(0, h.indexOf('<div class="bp-items">') === -1 ? h.length : h.indexOf('<div class="bp-items">')));
  assert.equal(heads.length, 4, 'three apps and "Everything else"');
  for (const [i, a] of apps.entries()) {
    const total = fb(a.totalBytes);
    const times = heads[i].split(total).length - 1;
    assert.equal(times, 1, `${a.name}: "${total}" is printed once in its row, not ${times} times: ${heads[i].replace(/\s+/g, ' ')}`);
  }
});

test('the scatter has axis titles and says what a dot is, and its hover says just that (G24)', () => {
  const scatter = slice('<div class="apps-scatter" id="appsScatter" hidden>', '<div id="appsBody">');
  assert.match(scatter, /<div class="as-h">Size against number of files<\/div>/);
  assert.match(scatter, /<div class="as-note muted">Each dot is one application — point at one, or tab to the chart and use the arrow keys, to see its name, file count and size\.<\/div>/, 'what a dot is, for the mouse and the keyboard (H54)');
  assert.match(scatter, /<div class="as-plot">\s*<span class="as-y">Size<\/span>\s*<div class="as-wrap"><canvas id="appsScatterChart"/, 'the y axis titled beside the chart');
  assert.match(scatter, /<\/canvas><\/div>\s*<\/div>\s*<div class="as-x">Number of files<\/div>/, 'the x axis titled under it');
  // The note's promise is the chart's own tooltip: the app's name, then its
  // files and its size, from the points the Apps view gives it.
  const kit = slice('function scatter(canvas, spec) {', '/* ═════════════════════ profitLine');
  assert.match(kit, /tip\.show\(p\.label \|\| '', \[\{ color: dotColor\(m, p\), name: m\.fmtX\(p\.x\), value: m\.fmtY\(p\.y\) \}\]/, 'the hover shows label, x and y');
  const feed = slice('async function loadAppsScatter() {', '\n}\n');
  assert.match(feed, /points\.push\(\{ x: files, y: a\.totalBytes, label: a\.name \}\)/, 'and the Apps view labels each dot with the app\'s name');
  assert.match(feed, /formatX: \(v\) => `\$\{formatCount\(Math\.round\(v\)\)\} files`/, 'its x as a file count');
  assert.match(feed, /formatY: formatBytes/, 'its y as a size');
  const css = slice('/* ── Apps tab (Feature 18', '#appsBody .bar {');
  assert.match(css, /\.apps-scatter \.as-y \{ writing-mode: vertical-rl; transform: rotate\(180deg\);/, 'the y title reads bottom to top');
  assert.match(css, /\.apps-scatter \.as-plot \.as-wrap \{ flex: 1; min-width: 0; \}/, 'and the chart keeps the rest of the width');
});

/* ══════════════ H54 — the scatter's dots are reachable by keyboard ══════════════ */

type StubEl = {
  tagName: string; className: string; textContent: string; style: Record<string, string>; attrs: Record<string, string>;
  children: StubEl[]; removed?: boolean; clientWidth: number; offsetWidth: number; offsetHeight: number;
  classList: { add(c: string): void; remove(c: string): void };
  setAttribute(k: string, v: string): void; getAttribute(k: string): string | undefined; appendChild(c: StubEl): void; remove(): void;
};

/**
 * The page's own FxCharts.scatter over a stub canvas, with the Apps view's formatters: answers the
 * canvas, a key-press driver, and the live region the chart speaks through (sixth browser pass H54).
 */
function keyboardScatter(points: Array<{ x: number; y: number; label: string }>) {
  const banner = '/* ═══════════════ FX: Charts ═══════════════ */';
  const a = INDEX.indexOf(banner);
  const b = INDEX.indexOf('/* ═══ end FX: Charts ═══ */', a);
  assert.ok(a !== -1 && b > a, 'the chart kit is in the built page');
  const el = (tagName: string): StubEl => {
    const e: StubEl = {
      tagName, className: '', textContent: '', style: {}, attrs: {}, children: [], clientWidth: 600, offsetWidth: 120, offsetHeight: 40,
      classList: { add() {}, remove() {} },
      setAttribute(k, v) { e.attrs[k] = v; }, getAttribute(k) { return e.attrs[k]; },
      appendChild(c) { e.children.push(c); }, remove() { e.removed = true; },
    };
    return e;
  };
  const host = el('div');
  const listeners: Record<string, (e: unknown) => void> = {};
  const canvas = { parentElement: host, tabIndex: -1, attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    addEventListener(t: string, fn: (e: unknown) => void) { listeners[t] = fn; }, removeEventListener() {} };
  const ctx = new Proxy({} as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : () => {}), set: (t, k, v) => { t[k as string] = v; return true; } });
  const stubs = `
    const REDUCED = true;
    function formatBytes(n) { return n + ' B'; }
    function cssVar() { return ''; }
    function formatDay(ms) { return String(ms); }
    const Canvas2D = { setup: (c, w, h) => ({ ctx: __ctx, width: w, height: h }), toLocal: () => ({ x: 0, y: 0 }) };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fx = new Function('document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', '__ctx',
    `${stubs}\n${INDEX.slice(a, b)}\nreturn FxCharts;`)(
    { hidden: false, createElement: el, addEventListener() {}, removeEventListener() {} }, () => ({ position: 'relative' }), () => 1, () => {}, ctx,
  ) as { scatter(c: unknown, spec: unknown): { destroy(): void; update(s: unknown): void } };
  const chart = fx.scatter(canvas, {
    points, height: 200, yGradient: true, logX: 10, logY: 1000,
    formatX: (v: number) => `${Math.round(v)} files`, formatY: (v: number) => `${v} B`,
  });
  const live = host.children.find((c) => c.attrs['aria-live'] === 'polite');
  const prevented: string[] = [];
  const press = (key: string) => listeners.keydown?.({ key, preventDefault: () => { prevented.push(key); } });
  return { canvas, listeners, live, press, prevented, chart, host };
}

const APPS = [
  { x: 4000, y: 9_000_000, label: 'Xcode' },
  { x: 12, y: 3_000, label: 'Notes' },
  { x: 900, y: 120_000, label: 'Slack' },
];

test('the scatter is one tab stop, and the arrow keys walk its dots in file-count order, each said aloud with its name, file count and size (H54)', () => {
  const s = keyboardScatter(APPS);
  assert.equal(s.canvas.tabIndex, 0, 'the chart can be reached with Tab');
  assert.ok(s.live, 'it speaks through a polite live region');
  assert.match(s.live!.className, /\bsr-only\b/, 'read aloud, not shown — the tooltip shows it');
  assert.equal(typeof s.listeners.keydown, 'function', 'it listens for keys');
  s.press('ArrowRight');
  assert.equal(s.live!.textContent, 'Notes: 12 files, 3000 B (1 of 3)', 'the first press lands on the dot with the fewest files');
  s.press('ArrowRight');
  assert.equal(s.live!.textContent, 'Slack: 900 files, 120000 B (2 of 3)');
  s.press('ArrowDown');
  assert.equal(s.live!.textContent, 'Xcode: 4000 files, 9000000 B (3 of 3)', 'Down goes on as Right does');
  s.press('ArrowRight');
  assert.equal(s.live!.textContent, 'Xcode: 4000 files, 9000000 B (3 of 3)', 'and stops at the last dot');
  s.press('ArrowLeft');
  assert.equal(s.live!.textContent, 'Slack: 900 files, 120000 B (2 of 3)', 'Left goes back');
  s.press('Home');
  assert.equal(s.live!.textContent, 'Notes: 12 files, 3000 B (1 of 3)', 'Home to the first');
  s.press('End');
  assert.equal(s.live!.textContent, 'Xcode: 4000 files, 9000000 B (3 of 3)', 'End to the last');
  s.press('Tab');
  assert.deepEqual(s.prevented, ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowRight', 'ArrowLeft', 'Home', 'End'], 'only the keys it handles are taken from the page — Tab still leaves');
  s.listeners.blur?.({});
  s.press('ArrowUp');
  assert.equal(s.live!.textContent, 'Xcode: 4000 files, 9000000 B (3 of 3)', 'after leaving, Up starts again from the last dot');
  s.chart.destroy();
  assert.equal(s.live!.removed, true, 'the live region goes with the chart');
});

test('the Apps scatter says it can be walked by keyboard, and its note is true for keyboard users too (H54)', () => {
  const scatter = slice('<div class="apps-scatter" id="appsScatter" hidden>', '<div id="appsBody">');
  assert.match(scatter, /<div class="as-note muted">Each dot is one application — point at one, or tab to the chart and use the arrow keys, to see its name, file count and size\.<\/div>/);
  const canvasTag = /<canvas id="appsScatterChart"[^>]*>/.exec(scatter)?.[0] ?? '';
  assert.match(canvasTag, /role="application"/, 'a widget with keys of its own, not a still image');
  assert.match(canvasTag, /aria-roledescription="scatter chart"/);
  assert.match(canvasTag, /aria-label="[^"]*arrow keys[^"]*"/, 'its name says how to move between the dots');
});
