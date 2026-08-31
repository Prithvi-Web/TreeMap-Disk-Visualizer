import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * FX wiring — the living-surface effects are bound to REAL app states.
 *
 * Two halves, mirroring the repo's split. The fxOrbShow/fxOrbHide helpers are
 * extracted and EXECUTED with stub namespaces, because "every mount has a
 * paired destroy" is behaviour — the orb equivalent of frontendContract's
 * "a view stops its timers when unmounted". Everything else is structural:
 * each activation site must contain its own deactivation site, because the
 * failure mode is a refactor that keeps the glow and quietly drops the
 * transition that was supposed to end it.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const JS_START = '/* ═══════════════ FX: living-surface wiring ═══════════════';
const JS_END = '/* ═══ end FX: living-surface wiring ═══ */';

function wiringSection(): string {
  const start = INDEX.indexOf(JS_START);
  const end = INDEX.indexOf(JS_END);
  assert.ok(start !== -1 && end > start, 'the FX wiring section must be spliced');
  return INDEX.slice(start, end);
}

/** A slice of the app between two exact anchors — containment checks only. */
function slice(startAnchor: string, endAnchor: string): string {
  const start = INDEX.indexOf(startAnchor);
  assert.notEqual(start, -1, `anchor "${startAnchor}" exists in index.html`);
  const end = INDEX.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `anchor "${endAnchor}" follows it`);
  return INDEX.slice(start, end);
}

/* ══════════════ The helper pair, as behaviour ══════════════ */

type FakeEl = {
  nodeType: number; className: string; children: FakeEl[];
  parentNode: FakeEl | null; isConnected: boolean;
  listeners: Record<string, Array<() => void>>;
  appendChild(c: FakeEl): FakeEl; remove(): void;
  addEventListener(name: string, fn: () => void): void;
};

function fakeEl(): FakeEl {
  return {
    nodeType: 1, className: '', children: [], parentNode: null, isConnected: false,
    listeners: {},
    appendChild(c: FakeEl) { c.parentNode = this; c.isConnected = true; this.children.push(c); return c; },
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
      this.parentNode = null; this.isConnected = false;
    },
    addEventListener(name: string, fn: () => void) { (this.listeners[name] ??= []).push(fn); },
  };
}

type Harness = {
  fx: Record<string, (...args: unknown[]) => unknown> & { fxOrbLive: Map<string, unknown> };
  els: Record<string, FakeEl>;
  mounts: Array<{ destroyed: number; state: string; size: number; container: FakeEl; setStates: string[] }>;
  beamCalls: Array<[FakeEl, Record<string, unknown>]>;
  timers: Array<() => void>;
  state: { scanning: boolean; root: unknown; view: string };
};

function makeHarness(): Harness {
  const els: Harness['els'] = {};
  const mounts: Harness['mounts'] = [];
  const beamCalls: Harness['beamCalls'] = [];
  const timers: Harness['timers'] = [];
  const state = { scanning: false, root: null as unknown, view: 'dashboard' };
  const $ = (id: string) => { els[id] ??= fakeEl(); els[id].isConnected = true; return els[id]; };
  const FxOrbs = {
    mount(container: FakeEl, opts: { state: string; size: number }) {
      const h = {
        destroyed: 0, state: opts.state, size: opts.size, container, setStates: [] as string[],
        setState(s: string) { h.state = s; h.setStates.push(s); },
        destroy() { h.destroyed++; },
      };
      mounts.push(h);
      return h;
    },
  };
  const FxBeam = {
    attach(el: FakeEl, opts: Record<string, unknown>) { beamCalls.push([el, opts]); return el; },
    detach() {},
  };
  const documentStub = { createElement: () => fakeEl() };
  const src = wiringSection();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fx = new Function(
    'FxOrbs', 'FxBeam', '$', 'document', 'state', 'setTimeout', 'clearTimeout',
    `'use strict'; ${src}
     return { fxOrbShow, fxOrbHide, fxScanHeroSync, fxShapeSync, fxEmptyCtaSync, fxCartPulseSync, fxOrbLive };`,
  )(
    FxOrbs, FxBeam, $, documentStub, state,
    (fn: () => void) => { timers.push(fn); return timers.length; },
    () => {},
  ) as Harness['fx'];
  return { fx, els, mounts, beamCalls, timers, state };
}

test('fxOrbShow mounts once and fxOrbHide destroys — the paired-teardown contract', () => {
  const h = makeHarness();
  const host = fakeEl(); host.isConnected = true;
  h.fx.fxOrbShow('k', host, 'searching');
  assert.equal(h.mounts.length, 1, 'one mount');
  assert.equal(h.mounts[0].state, 'searching');
  assert.equal(host.children.length, 1, 'the slot went into the host');
  h.fx.fxOrbHide('k');
  assert.equal(h.mounts[0].destroyed, 1, 'destroy was called');
  assert.equal(host.children.length, 0, 'the slot was removed');
  assert.equal((h.fx.fxOrbLive as Map<string, unknown>).size, 0, 'nothing is tracked afterwards');
  h.fx.fxOrbHide('k');
  assert.equal(h.mounts[0].destroyed, 1, 'hide is idempotent — no double destroy');
});

test('a re-show on the same surface retargets in place instead of stacking mounts', () => {
  const h = makeHarness();
  const host = fakeEl(); host.isConnected = true;
  h.fx.fxOrbShow('k', host, 'searching');
  h.fx.fxOrbShow('k', host, 'solving');
  assert.equal(h.mounts.length, 1, 'still one mount');
  assert.deepEqual(h.mounts[0].setStates, ['solving'], 'the existing orb was retargeted');
  const other = fakeEl(); other.isConnected = true;
  h.fx.fxOrbShow('k', other, 'working');
  assert.equal(h.mounts[0].destroyed, 1, 'moving hosts destroys the old orb first');
  assert.equal(h.mounts.length, 2, 'then mounts the new one');
});

test('the scan hero follows the active view and dies when the scan ends — the unmount rule for orbs', () => {
  const h = makeHarness();
  h.state.scanning = true; h.state.root = null; h.state.view = 'treemap';
  h.fx.fxScanHeroSync();
  assert.equal(h.mounts.length, 1, 'hero mounted');
  assert.equal(h.mounts[0].size, 64, 'at avatar scale');
  assert.equal(h.mounts[0].state, 'searching');
  assert.equal(h.mounts[0].container.parentNode, h.els.tmScanOrb, 'in the treemap well');
  h.state.view = 'dashboard';
  h.fx.fxScanHeroSync();
  assert.equal(h.mounts[0].destroyed, 1, 'leaving the view destroys its orb');
  assert.equal(h.mounts[1].container.parentNode, h.els.dashScanOrb, 'and the dashboard well takes over');
  h.state.view = 'settings';
  h.fx.fxScanHeroSync();
  assert.equal(h.mounts[1].destroyed, 1, 'a view with no well means no hero at all');
  h.state.view = 'treemap';
  h.state.root = { path: '/' };
  h.fx.fxScanHeroSync();
  assert.equal(h.mounts.length, 2, 'a rescan over real data never shows the hero');
  h.state.root = null; h.state.scanning = false;
  h.fx.fxScanHeroSync();
  assert.equal((h.fx.fxOrbLive as Map<string, unknown>).size, 0, 'scan over, hero gone');
});

test('the shaping chip is a strict function of the refinement queue', () => {
  const h = makeHarness();
  h.fx.fxShapeSync(true);
  assert.equal(h.mounts.length, 1);
  assert.equal(h.mounts[0].state, 'shaping');
  h.fx.fxShapeSync(true);
  assert.equal(h.mounts.length, 1, 'staying refining does not remount');
  h.fx.fxShapeSync(false);
  assert.equal(h.mounts[0].destroyed, 1, 'queue drained, chip destroyed');
});

test('the cart pulse fires only on an increase, once, and switches itself off', () => {
  const h = makeHarness();
  h.fx.fxCartPulseSync(5); // boot restore of a persisted cart
  assert.equal(h.beamCalls.length, 0, 'a restored cart is not an increase');
  h.fx.fxCartPulseSync(4);
  assert.equal(h.beamCalls.length, 0, 'removals never glow');
  h.fx.fxCartPulseSync(6);
  assert.equal(h.beamCalls.length, 1, 'an increase pulses');
  assert.equal(h.beamCalls[0][0], h.els.cartTab);
  assert.deepEqual(h.beamCalls[0][1], { type: 'pulse-inner', active: true });
  assert.equal(h.timers.length, 1, 'and arms its own off-switch');
  h.timers[0]();
  assert.deepEqual(h.beamCalls[1][1], { type: 'pulse-inner', active: false }, 'which deactivates');
});

test('the search-line beams light on focus and die on blur, on the strip — never the input', () => {
  const h = makeHarness();
  for (const [inputId, stripId] of [['gsearch', 'gsearchBeamStrip'], ['tmSearch', 'tmSearchBeamStrip']] as const) {
    const before = h.beamCalls.length;
    assert.ok(h.els[inputId].listeners.focus?.length, `${inputId} has a focus listener`);
    assert.ok(h.els[inputId].listeners.blur?.length, `${inputId} has a blur listener`);
    h.els[inputId].listeners.focus[0]();
    h.els[inputId].listeners.blur[0]();
    assert.equal(h.beamCalls[before][0], h.els[stripId], 'the beam host is the overlay strip');
    assert.deepEqual(h.beamCalls[before][1], { type: 'line', active: true });
    assert.deepEqual(h.beamCalls[before + 1][1], { type: 'line', active: false });
  }
});

/* ══════════════ Every activation has its deactivation — structurally ══════════════ */

test('every fxOrbShow key has a matching fxOrbHide somewhere', () => {
  const shown = new Set([...INDEX.matchAll(/fxOrbShow\('([a-zA-Z]+)'/g)].map((m) => m[1]));
  const hidden = new Set([...INDEX.matchAll(/fxOrbHide\('([a-zA-Z]+)'/g)].map((m) => m[1]));
  assert.ok(shown.size >= 6, `the wired surfaces exist (got ${[...shown].join(', ')})`);
  for (const key of shown) assert.ok(hidden.has(key), `orb key "${key}" is shown but never hidden`);
});

test('every orb state used by the wiring is one of the nine the engine ships', () => {
  const VALID = new Set(['working', 'searching', 'solving', 'listening', 'connecting', 'weaving', 'composing', 'breathing', 'shaping']);
  const used = [...INDEX.matchAll(/fxOrbShow\('[a-zA-Z]+',[^,]+,\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(used.length >= 6, 'states are actually passed');
  for (const s of used) assert.ok(VALID.has(s), `"${s}" is not a thinking-orbs state`);
});

test('scan chrome: begin lights the card beam and searching orb; end — the single exit funnel — kills both', () => {
  const begin = slice('function beginScanChrome(', 'function endScanChrome(');
  const end = slice('function endScanChrome(', 'function failScan(');
  assert.match(begin, /FxBeam\.attach\(\$\('scanStatus'\)\.closest\('\.card'\), \{ type: 'md', active: true \}\)/);
  assert.match(begin, /fxOrbShow\('scan', \$\('scanOrbWell'\), 'searching'\)/);
  assert.match(begin, /fxScanHeroSync\(\)/, 'a starting scan syncs the hero');
  assert.match(end, /FxBeam\.attach\(\$\('scanStatus'\)\.closest\('\.card'\), \{ type: 'md', active: false \}\)/);
  assert.match(end, /fxOrbHide\('scan'\)/);
  assert.match(end, /fxScanHeroSync\(\)/, 'an ending scan syncs the hero too');
  // The funnel claim itself: fail and finish both pass through endScanChrome.
  assert.match(slice('function failScan(', 'function statsFromResult('), /endScanChrome\(\)/);
  assert.match(slice('async function finishScan(', 'state.root = root;'), /endScanChrome\(\)/);
});

test('the scanning status templates hand the spinner role to the orb — no doubled loaders', () => {
  const begin = slice('function beginScanChrome(', 'function endScanChrome(');
  const follow = slice('function followScanProgress(', 'async function startCloudScan(');
  for (const [name, src] of [['beginScanChrome', begin], ['followScanProgress', follow]] as const) {
    assert.ok(!/scanStatus'\)\.innerHTML = icon\('loader'/.test(src) && !src.includes("innerHTML = icon('loader', 14"),
      `${name} no longer paints a loader icon into the status line`);
  }
});

test('duplicates: the solving orb is dropped on settle, on error, on re-entry, and on unmount', () => {
  const load = slice('async function loadDuplicates(', 'function renderDuplicates(');
  assert.match(load, /fxOrbShow\('dup', \$\('dupBody'\)\.querySelector\('\.fx-orb-well'\), 'solving'\)/);
  const hides = (load.match(/fxOrbHide\('dup'\)/g) || []).length;
  assert.ok(hides >= 3, `loadDuplicates drops the orb on re-entry, settle and error (found ${hides})`);
  const dupView = slice("id: 'duplicates'", "id: 'trends'");
  assert.match(dupView, /fxOrbHide\('dup'\)/, "the view's unmount closes the same leak the pollTimer line does");
});

test('autopilot preview: the working orb lives exactly as long as the simulate round-trip', () => {
  const handler = slice("$('apPreviewBtn').addEventListener", "$('apSaveBtn').addEventListener");
  assert.match(handler, /fxOrbShow\('ap', host\.querySelector\('\.fx-orb-well'\), 'working'\)/);
  assert.match(handler, /finally \{\s*fxOrbHide\('ap'\);\s*\}/, 'a finally guarantees the destroy on every exit');
});

test('cloud connect: every way the handshake poll can end drops the connecting orb', () => {
  const fn = slice('async function connectCloud(', 'const SCHED_HOURS');
  assert.match(fn, /fxOrbShow\('cloud', document\.querySelector\([\s\S]+?\), 'connecting'\)/);
  const hides = (fn.match(/fxOrbHide\('cloud'\)/g) || []).length;
  assert.ok(hides >= 3, `timeout, success and failure all drop it (found ${hides})`);
});

test('exports: both timelapse exporters pair composing with their lapseExporting finally', () => {
  const gif = slice('async function exportTimelapseGif(', 'async function exportTimelapseWebm(');
  const webm = slice('async function exportTimelapseWebm(', 'function exportTreemapPNG(');
  for (const [name, src] of [['gif', gif], ['webm', webm]] as const) {
    assert.match(src, /fxOrbShow\('export', \$\('tmExportBtn'\)\.closest\('\.tb-group'\), 'composing'\)/, `${name} shows composing`);
    assert.match(src, /lapseExporting = false;[\s\S]{0,200}fxOrbHide\('export'\)/, `${name}'s finally drops it beside the flag`);
  }
});

test('shaping: buildCells and the refinement loop own the on-switch; altRefineCancel is the off-switch every door uses', () => {
  const build = slice('function buildCells(', 'let altRefineSeq');
  const cancel = slice('function altRefineCancel(', 'function altRefineSchedule(');
  const sched = slice('function altRefineSchedule(', 'the zoom between levels');
  assert.match(build, /fxShapeSync\(!out\.done\)/);
  assert.match(sched, /fxShapeSync\(!out\.done\)/);
  assert.match(cancel, /fxShapeSync\(false\)/);
  // The treemap view's unmount goes through that same door.
  assert.match(slice("id: 'treemap'", "id: 'duplicates'"), /altRefineCancel\(\);/);
});

test('plain words: the weaving orb cannot outlive the popover or the round-trip', () => {
  const translate = slice('async function nlTranslate(', 'function nlRunTranslated(');
  const close = slice('function nlClose(', 'async function nlTranslate(');
  assert.match(translate, /fxOrbShow\('nl', \$\('nlPending'\)\.querySelector\('\.fx-orb-well'\), 'weaving'\)/);
  assert.match(translate, /finally \{\s*fxOrbHide\('nl'\);/, 'settle drops it');
  assert.match(close, /fxOrbHide\('nl'\)/, 'a close mid-flight drops it too');
  assert.match(INDEX, /<div class="nl-pending" id="nlPending" role="status" hidden>/, 'and the row starts hidden');
});

test('drive tiles: the drag beam has an enter edge, two exit edges, and a rebuild detach', () => {
  const drag = slice("for (const dockId of ['tmDock', 'cityDock'])", 'async function runRestoreJob(');
  assert.match(drag, /if \(!tile\.classList\.contains\('drop-ok'\)\) FxBeam\.attach\(tile, \{ type: 'md', active: true \}\)/,
    'activation is gated on the class — the enter edge, not every dragover frame');
  const offs = (drag.match(/FxBeam\.attach\(tile, \{ type: 'md', active: false \}\)/g) || []).length;
  assert.equal(offs, 2, 'dragleave AND drop both deactivate');
  assert.match(slice('function renderDock(', 'async function dockDrop('),
    /querySelectorAll\('\.drive-tile'\)\.forEach\(\(t\) => FxBeam\.detach\(t\)\)/,
    'the dock rewrite detaches before innerHTML orphans an instance');
});

test('the zero-state CTA halo is switched by switchView, from the same `empty` it just computed', () => {
  const sv = slice('function switchView(', 'function renderCapabilityNotice(');
  assert.match(sv, /fxEmptyCtaSync\(empty\)/);
  assert.match(sv, /fxScanHeroSync\(\)/);
  assert.match(wiringSection(), /FxBeam\.attach\(\$\('emptyBrowseBtn'\), \{ type: 'pulse-outside', active: showing \}\)/);
});

test('renderCart is the one caller of the cart pulse', () => {
  const calls = (INDEX.match(/fxCartPulseSync\(/g) || []).length;
  assert.equal(calls, 2, 'one definition, one call site');
  const start = INDEX.indexOf('async function renderCart(');
  assert.notEqual(start, -1, 'renderCart exists');
  assert.match(INDEX.slice(start, start + 800), /fxCartPulseSync\(n\)/, 'called right where the count is read');
});

test('the beam strips and orb wells hold their contract seams', () => {
  assert.match(INDEX, /\.fx-orb-well:empty \{ display: none; \}/, 'idle wells cost nothing');
  assert.match(INDEX, /\.fx-beam-strip \{ position: absolute; inset: 0; pointer-events: none;/, 'strips never eat a click');
  assert.match(INDEX, /<span class="fx-beam-strip" id="gsearchBeamStrip" aria-hidden="true"><\/span>/);
  assert.match(INDEX, /<span class="fx-beam-strip" id="tmSearchBeamStrip" aria-hidden="true"><\/span>/);
  // The line beams must attach to the strips, never to the replaced <input>s,
  // which cannot host the pseudo-element machinery.
  assert.ok(!INDEX.includes("FxBeam.attach($('gsearch')"), 'never the input itself');
  assert.ok(!INDEX.includes("FxBeam.attach($('tmSearch')"), 'never the input itself');
});

/* ══════════════ FX: Charts — every handle dies with its view ══════════════ */

test('dashboard: unmount destroys the ring and gauge handles, mount rebuilds them from held state', () => {
  const entry = slice("id: 'dashboard'", "id: 'treemap'");
  assert.match(entry, /donutHandle\.destroy\(\); donutHandle = null;/, 'the ring handle dies on unmount');
  assert.match(entry, /fxBudgetGaugesDrop\(\)/, 'and every budget gauge with it');
  assert.match(entry, /renderDonut\(\)/, 'mount repaints the donut from state.types');
  assert.match(entry, /renderBudgetWidget\(\)/, 'and the gauges from state.budgets');
  assert.match(entry, /if \(state\.scanning\)/, 'but never over mid-scan skeletons');
});

test('trends: the area-chart handle is destroyed on unmount and rebuilt by mount', () => {
  const entry = slice("id: 'trends'", "id: 'offloaded'");
  assert.match(entry, /trendHandle\.destroy\(\); trendHandle = null;/, 'unmount releases the handle');
  assert.match(entry, /loadTrends\(\)/, 'mount reloads, which recreates it');
  // And drawTrendChart is keep-or-create — never a second handle per view life.
  const draw = slice('function drawTrendChart(', 'async function renderTrendDeltas(');
  assert.match(draw, /if \(trendHandle\) trendHandle\.update\(spec\);\s*else trendHandle = FxCharts\.area\(/,
    'one handle, updated in place');
});

test('live spark: created inside renderLiveFeed, destroyed by disableLive — the one exit every door uses', () => {
  const feed = slice('function renderLiveFeed(', 'async function liveRelayout(');
  assert.match(feed, /liveLineHandle = FxCharts\.liveLine\(/, 'the spark rides the existing feed tick');
  assert.match(feed, /host\.appendChild\(liveLineWrap\)/, 'and is re-appended after every innerHTML rewrite');
  assert.doesNotMatch(feed, /new EventSource/, 'it feeds off the existing stream — never a second one');
  const off = slice('function disableLive(', "$('tmLiveToggle').addEventListener");
  assert.match(off, /fxLiveLineDrop\(\)/, 'live-off destroys it (treemap unmount reaches here too)');
  // The treemap unmount really does pass through that door.
  assert.match(slice("id: 'treemap'", "id: 'duplicates'"), /disableLive\(\{ keepWanted: true \}\)/);
});

test('budget gauges: destroyed BEFORE the innerHTML rewrite that would strand them', () => {
  const fn = slice('function renderBudgetWidget(', 'let budgetTarget');
  const drop = fn.indexOf('fxBudgetGaugesDrop()');
  const rewrite = fn.indexOf('list.innerHTML');
  assert.ok(drop !== -1 && rewrite !== -1, 'both sides of the contract exist');
  assert.ok(drop < rewrite, 'destroy first — a rebuilt list must never orphan a live handle');
  assert.match(fn, /budgetGauges\.push\(FxCharts\.gauge\(/, 'then one gauge per row');
});

test('the donut ring handle: empty state destroys it, the theme toggle refreshes it in place', () => {
  const fn = slice('function renderDonut(', 'const tmCanvas');
  assert.match(fn, /if \(donutHandle\) \{ donutHandle\.destroy\(\); donutHandle = null; \}/,
    'no data means no handle — and no leaked observer');
  assert.match(fn, /if \(donutHandle\) donutHandle\.update\(spec\);\s*else donutHandle = FxCharts\.rings\(/,
    'with data it is keep-or-create, never stacked');
  assert.match(INDEX, /if \(donutHandle\) donutHandle\.update\(\{\}\);/,
    'the theme toggle re-reads tokens through the same handle');
});

test('the theme toggle refreshes EVERY live chart handle — canvases hold rasterized ink', () => {
  // QA F3: FxCharts resolves tokens at render time and has no theme observer
  // of its own, so a handle the toggle forgets keeps the previous theme's
  // grid/label ink until an unrelated redraw. All four live-handle kinds must
  // be refreshed here; deleting any one line fails this test.
  const toggle = slice("$('themeToggle').addEventListener", 'function applySideNav(');
  assert.match(toggle, /if \(donutHandle\) donutHandle\.update\(\{\}\);/, 'the dashboard ring retints');
  assert.match(toggle, /if \(trendHandle\) trendHandle\.update\(\{\}\);/, 'the Trends area chart retints');
  assert.match(toggle, /for \(const g of budgetGauges\) g\.update\(\{\}\);/, 'every budget gauge retints');
  assert.match(toggle, /if \(liveLineHandle\) liveLineHandle\.update\(\{\}\);/, 'the live spark retints');
});

test('the dashboard list bars ride the FxCharts ramp and honour REDUCED', () => {
  const files = slice('function renderBigFiles(', 'function refreshBigFiles(');
  const folders = slice('function renderBigFolders(', 'Dashboard: donut chart');
  for (const [name, src] of [['files', files], ['folders', folders]] as const) {
    assert.match(src, /fx-bar-fill/, `${name} rows use the kit's gradient fill`);
    assert.match(src, /fxBarsIn\(host\)/, `${name} rows animate in through the shared entry`);
    assert.match(src, /fx-li-pct/, `${name} rows carry the percent-of-largest column`);
  }
  const barsIn = slice('function fxBarsIn(', 'function renderBigFiles(');
  assert.match(barsIn, /if \(REDUCED\) \{ el\.style\.width = w; return; \}/,
    'reduced motion renders final widths instantly');
});
