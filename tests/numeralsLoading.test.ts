import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Numerals & loading choreography — structural pins.
 *
 * This round wired three languages through the app: rolling numerals on
 * every stat that updates in place, the bklit chart-card loading veil
 * (skeleton pulse + diagonal sweep with a rest), and shimmer-text on the
 * orb chips' pending labels. Each is an activation/deactivation pair or a
 * load-bearing CSS trick, and the failure mode is always the same: a
 * refactor keeps the pretty half and quietly drops the off-switch, the
 * baseline fix, or the snap-don't-roll honesty rule. These pins hold the
 * pairs together.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** A slice of the file between two exact anchors — containment checks only. */
function slice(startAnchor: string, endAnchor: string): string {
  const start = INDEX.indexOf(startAnchor);
  assert.notEqual(start, -1, `anchor "${startAnchor}" exists in index.html`);
  const end = INDEX.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `anchor "${endAnchor}" follows it`);
  return INDEX.slice(start, end);
}

/* ══════════════════ rolling numerals ══════════════════ */

test('the digit slot clips with overflow: clip — a scroll container would wreck the baseline', () => {
  const styles = slice('FX: Rolling Numerals — styles', 'end FX: Rolling Numerals styles');
  const slot = styles.match(/\.fx-roll-d\s*\{[^}]*\}/);
  assert.ok(slot, '.fx-roll-d rule exists');
  assert.match(slot![0], /overflow:\s*clip/, 'clip keeps the inline baseline; hidden moves it to the bottom edge');
  assert.match(styles, /\.fx-roll-sizer\s*\{[^}]*opacity:\s*0/, 'the sizer is invisible but real — width, copy and screen readers');
  assert.match(styles, /\.fx-roll-col[^{]*\{[^}]*transition:\s*transform/, 'the glide is a CSS transition, not a JS loop');
  assert.match(styles, /\.fx-roll\s*\{[^}]*tabular-nums/, 'rolled digits are tabular (constraint: numbers always are)');
});

test('stat surfaces roll in place: system card, quick stats, cart', () => {
  const sys = slice('async function loadSystem', 'async function loadTrash');
  for (const id of ['sysTotal', 'sysFree', 'sysUsed']) {
    assert.match(sys, new RegExp(`countUp\\(\\$\\('${id}'\\)`), `${id} rolls`);
  }
  assert.match(slice('async function loadTrash', 'function openTrashModal'), /countUp\(\$\('sysTrash'\)/, 'the trash fact rolls');
  const finish = slice('async function finishScan', 'if (!state.scanId) {');
  assert.match(finish, /FxNum\.rollText\(\$\('statLastScan'\)/, 'last-scan time rolls between scans');
  const cart = slice('async function renderCart', "$('cartList')");
  assert.match(cart, /countUp\(\$\('cartTabCount'\)/, 'the cart tab count rolls');
  assert.match(cart, /countUp\(\$\('cartTabTotal'\)/, 'the cart tab total rolls');
  assert.match(cart, /FxNum\.rollHtml\(\$\('cartFootTotal'\)/, 'the innerHTML surface goes through the rewrite-then-roll helper');
});

test('innerHTML summaries roll ONLY under a same-entity key — a new scan must snap', () => {
  assert.match(INDEX, /FxNum\.rollHtml\(\$\('dupSummary'\)[\s\S]{0,400}?state\.dup\.loadedFor\)/,
    'duplicates summary is keyed by scan+threshold');
  assert.match(INDEX, /FxNum\.rollHtml\(\$\('ndSummary'\)[\s\S]{0,400}?state\.near\.loadedFor\)/,
    'near-duplicates summary is keyed the same way');
  for (const id of ['appsInfo', 'gamesInfo', 'mediaInfo']) {
    assert.match(INDEX, new RegExp(`FxNum\\.rollHtml\\(\\$\\('${id}'\\)[\\s\\S]{0,700}?state\\.scanId\\)`),
      `${id} is keyed by the scan it describes`);
  }
  assert.match(slice('function renderZombies(', 'function wireZombieActions'), /FxNum\.rollHtml\(body,/,
    'the held-up-space card rolls its totals on refresh');
  assert.match(slice('async function renderTrendDeltas', 'function deltaRow'), /FxNum\.rollHtml\(host,[\s\S]{0,200}?state\.trends\.path\)/,
    'trend deltas are keyed by the root path');
});

/* ══════════════════ shimmer-text labels ══════════════════ */

test('shimmer-text keeps `color` intact so currentColor icon strokes survive', () => {
  const styles = slice('FX: living-surface wiring — wells and strips', 'FX: Charts — styles');
  const rule = styles.match(/\.fx-shimmer-text\s*\{[^}]*\}/);
  assert.ok(rule, '.fx-shimmer-text rule exists');
  assert.match(rule![0], /background-clip:\s*text/, 'the band is masked to the glyphs');
  assert.match(rule![0], /-webkit-text-fill-color:\s*transparent/, 'only the text fill goes transparent');
  assert.ok(!/[^-]color:\s*transparent/.test(rule![0]), 'never `color: transparent` — that would blank the icons');
  assert.match(rule![0], /2000ms linear/, 'the border-beam demo t-shimmer timing');
  assert.match(styles, /--fx-shimmer-hi/, 'the band brightness is a token');
  assert.match(styles, /\[data-theme="light"\][^{]*\{[^}]*--fx-shimmer-hi/, 'quieter in light theme');
  assert.match(styles, /prefers-reduced-motion[\s\S]{0,300}?\.fx-shimmer-text\s*\{[^}]*animation:\s*none/,
    'REDUCED gets a static label');
});

test('shimmer rides exactly the pending states, with a paired off-switch', () => {
  const begin = slice('function beginScanChrome(', 'function endScanChrome(');
  const end = slice('function endScanChrome(', 'function failScan(');
  assert.match(begin, /\$\('scanStatus'\)\.classList\.add\('fx-shimmer-text'\)/, 'the scan status shimmers while scanning');
  assert.match(end, /\$\('scanStatus'\)\.classList\.remove\('fx-shimmer-text'\)/, 'and the single exit funnel stops it');
  assert.match(INDEX, /id="nlPending"[^>]*><span class="fx-orb-well"><\/span><span class="fx-shimmer-text">Translating…<\/span>/,
    'the weaving chip label shimmers (visibility is gated by [hidden])');
  assert.match(INDEX, /id="dupProgText" class="fx-shimmer-text"/, 'the solving chip label shimmers');
  assert.match(INDEX, /id="ndProgText" class="fx-shimmer-text"/, 'the near-dup progress label shimmers');
});

/* ══════════════════ chart-card loading choreography ══════════════════ */

test('the loading veil keeps bklit\'s rhythm: 2.2s of travel, then a 280ms rest', () => {
  const styles = slice('FX: Charts — styles', 'end FX: Charts — styles');
  assert.match(styles, /fx-skel-pulse 2480ms/, 'the pulse shares the cycle');
  assert.match(styles, /fx-skel-sweep 2480ms linear/, 'the sweep is linear over one 2480ms cycle');
  assert.match(styles, /88\.7%\s*\{\s*background-position:\s*0%\s*0;\s*\}/, 'travel ends at 88.7% — the rest is the rest');
  assert.match(styles, /\.fx-chart-loading::before[\s\S]{0,200}?pointer-events:\s*none/, 'the veil never eats clicks');
  assert.match(styles, /prefers-reduced-motion[\s\S]{0,400}?\.fx-chart-loading::before[\s\S]{0,80}?animation:\s*none/,
    'REDUCED gets a static veil');
});

test('the donut veil has an off-switch in every painter of the card', () => {
  assert.match(slice('function fxDonutLoadingSync', 'function fxCartPulseSync'), /classList\.toggle\('fx-chart-loading'/,
    'the helper lives in the wiring section');
  assert.match(slice('function beginScanChrome(', 'function endScanChrome('), /fxDonutLoadingSync\(true\)/, 'a scan veils it');
  assert.match(slice('function showListsPending', 'function cancelScanById'), /fxDonutLoadingSync\(true\)/,
    'the index-first pending window veils it');
  assert.match(slice('function renderDonut()', 'const tmCanvas'), /fxDonutLoadingSync\(false\)/, 'renderDonut settles it');
  assert.match(slice('function restoreDashboardPanels', 'function showListsPending'), /fxDonutLoadingSync\(false\)/,
    'a stopped scan settles it too');
});

test('the trends veil covers exactly the fetch — the finally holds on errors', () => {
  const fn = slice('async function loadTrendData', 'async function labelTrendForecast');
  assert.match(fn, /classList\.add\('fx-chart-loading'\)/);
  assert.match(fn, /finally\s*\{[\s\S]{0,120}?classList\.remove\('fx-chart-loading'\)/,
    'a failed fetch must not leave the chart veiled forever');
});

test('the budget veil only ever covers an existing card, and every paint settles it', () => {
  const load = slice('async function loadBudgets', 'function budgetProjectionLine');
  assert.match(load, /if \(!\$\('budgetCard'\)\.hidden\) \$\('budgetList'\)\.classList\.add\('fx-chart-loading'\)/,
    'a first load has nothing to veil — the card is hidden until data exists');
  assert.match(slice('function renderBudgetWidget', 'let budgetTarget'), /classList\.remove\('fx-chart-loading'\)/);
});

/* ══════════════════ skeleton unification ══════════════════ */

test('the muted-text loaders became skeletons, keeping their §3.5 copy for screen readers', () => {
  assert.match(slice('function skeletonRows', 'const INSTANT_OPEN_NODES'), /role="status" aria-label/,
    'skeletonRows carries the loading sentence as a label');
  assert.match(slice('async function loadTopology', 'function renderTopologyBlocked'),
    /skeletonRows\(\d+, \d+, 'Reading disk layout…'\)/);
  assert.match(slice('async function loadZombies', 'function renderZombiesBlocked'),
    /skeletonRows\(\d+, \d+, 'Checking for held-up space…'\)/);
  assert.match(slice('async function loadJournal', 'function renderJournal'),
    /skeletonRows\(\d+, \d+, 'Reading the journal…'\)/);
  assert.match(slice('async function loadCapsule', 'function renderCapsule'),
    /skeletonRows\(\d+, \d+, 'Reading the Time Capsule…'\)/);
  const fleet = slice('id="fleetBody"', '</section>');
  assert.match(fleet, /class="skeleton"/, 'the fleet view loads as skeleton rows');
  assert.match(fleet, /aria-label="Looking for TreeMaps on your network…"/, 'with its copy in the label');
});

/* ══════════════════ FxCharts tooltip upgrades ══════════════════ */

test('the crosshair fades through its top and bottom 10% zones', () => {
  const charts = slice('/* ═══════════════ FX: Charts ═══════════════ */', '/* ═══ end FX: Charts ═══ */');
  const cross = charts.slice(charts.indexOf('// crosshair + dots on hover'), charts.indexOf('function nearest'));
  assert.match(cross, /addColorStop\(0, math\.alpha\(chCol, 0\)\)/, 'transparent at the top edge');
  assert.match(cross, /addColorStop\(0\.1, chCol\)/, 'full strength from 10%');
  assert.match(cross, /addColorStop\(0\.9, chCol\)/, 'until 90%');
  assert.match(cross, /addColorStop\(1, math\.alpha\(chCol, 0\)\)/, 'transparent at the bottom edge');
});

test('the tooltip panel trails on a self-parking follow loop — zero rAF at rest', () => {
  const charts = slice('function makeTip(host)', 'function makeLife');
  assert.match(charts, /Math\.exp\(-dt/, 'time-based damping, not per-frame magic numbers');
  assert.match(charts, /if \(REDUCED \|\| !cur\)/, 'REDUCED and the first show snap into place');
  const settle = charts.slice(charts.indexOf('function settle'), charts.indexOf('function moveTo'));
  assert.match(settle, /followRaf = 0/, 'each frame clears its handle');
  assert.match(settle, /return;[\s\S]{0,120}?apply\(\);\s*followRaf = requestAnimationFrame\(settle\)/,
    'the loop re-arms only while the gap is still closing');
  assert.match(charts, /cancelAnimationFrame\(followRaf\)/, 'destroy() releases the follower');
});

test('the date pill exists, follows the crosshair, and rolls its numerals', () => {
  const styles = slice('FX: Charts — styles', 'end FX: Charts — styles');
  assert.match(styles, /\.fx-tip-pill\s*\{[^}]*pointer-events:\s*none/, 'the pill never eats hover');
  const charts = slice('/* ═══════════════ FX: Charts ═══════════════ */', '/* ═══ end FX: Charts ═══ */');
  assert.match(charts, /pill\.className = 'fx-tip-pill fx-num'/, 'area() owns one pill per chart');
  assert.match(charts, /FxNum\.rollText\(pill, String\(when\)\)/, 'slot-machine numerals via the shared roller');
  assert.match(charts, /if \(when\) \{/, 'shown only when formatTime yields a date');
  assert.match(charts, /pill\.remove\(\)/, 'destroy() removes it — every mount has its teardown');
  const leave = charts.slice(charts.indexOf('function onLeave'), charts.indexOf("life.on(canvas, 'mousemove'"));
  assert.match(leave, /pill\.classList\.remove\('on'\)/, 'leaving the chart hides the pill');
});
