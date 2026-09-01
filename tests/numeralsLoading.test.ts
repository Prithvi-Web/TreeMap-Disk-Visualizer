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

const REDUCE_AT = '@media (prefers-reduced-motion: reduce) {';

/**
 * The one reduced-motion block inside `styles`, brace-matched.
 *
 * A `prefers-reduced-motion[\s\S]{0,400}?` window proves nothing about
 * containment: `}` is an ordinary character to it, so the same rule moved
 * one line PAST the media query still matched — and in that state it
 * applies to everybody, killing the animation for every user, which is the
 * exact opposite of what a REDUCED pin claims.
 */
function reducedBlock(styles: string): string {
  const start = styles.indexOf(REDUCE_AT);
  assert.notEqual(start, -1, 'the section carries a prefers-reduced-motion block');
  assert.equal(styles.indexOf(REDUCE_AT, start + 1), -1,
    'exactly one — otherwise a rule could satisfy this pin from a block it does not belong to');
  let depth = 0;
  for (let i = styles.indexOf('{', start); i < styles.length; i++) {
    if (styles[i] === '{') depth++;
    else if (styles[i] === '}' && --depth === 0) return styles.slice(start, i + 1);
  }
  return assert.fail('the prefers-reduced-motion block never closes');
}

/**
 * One `FxNum.rollHtml(…)` call, parsed to its matching close paren.
 *
 * The key argument is what decides whether a surface rolls or snaps, and a
 * `[\s\S]{0,400}?` window cannot see argument position: swapping dupSummary's
 * third argument for the constant `'dup'` still matched, because the real
 * `state.dup.loadedFor` sat on the next line. Parsing the call means the
 * assertion is about the argument itself.
 */
function rollHtmlCall(hay: string, hostArg: string): string {
  const anchor = `FxNum.rollHtml(${hostArg}`;
  const start = hay.indexOf(anchor);
  assert.notEqual(start, -1, `${anchor}…) exists`);
  let depth = 0, quote = '';
  for (let i = hay.indexOf('(', start); i < hay.length; i++) {
    const c = hay[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return hay.slice(start, i + 1);
  }
  return assert.fail(`${anchor}…) never closes`);
}

/** Assert `key` is the LAST argument of that rollHtml call, not merely nearby. */
function assertKeyedBy(hay: string, hostArg: string, key: string, why: string): void {
  const call = rollHtmlCall(hay, hostArg);
  assert.match(call, new RegExp(`,\\s*${key.replace(/[.$()[\]|*+?^\\]/g, '\\$&')}\\)$`), why);
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
  // Selecting a rolled number used to copy the whole 0–9 strip of every
  // column ("4 0 1 2 3 4 5 6 7 8 9"). The strip is aria-hidden presentation,
  // so it is excluded from selection too; the opacity:0 sizer stays
  // selectable and carries the real digit, so a copy yields the real value.
  const col = styles.match(/\.fx-roll-col\s*\{[^}]*\}/);
  assert.ok(col, '.fx-roll-col rule exists');
  assert.match(col![0], /user-select:\s*none/, 'the presentation strip is not selectable text');
  assert.match(col![0], /-webkit-user-select:\s*none/, 'including on WebKit');
  const sizer = styles.match(/\.fx-roll-sizer\s*\{[^}]*\}/);
  assert.ok(!/user-select/.test(sizer![0]), 'the sizer stays selectable — it is the value a copy must yield');
  // …and the strip's digits are inline-block, not block: a block box inside
  // the slot is a paragraph boundary to the selection serializer, so a copy
  // came out as "3\n4" even with the strip itself unselectable.
  const strip = styles.match(/\.fx-roll-col > span\s*\{[^}]*\}/);
  assert.ok(strip, '.fx-roll-col > span rule exists');
  assert.match(strip![0], /display:\s*inline-block/, 'no block boundary inside a number');
  assert.match(strip![0], /width:\s*100%/, 'which is what still stacks them one per line');
  assert.match(strip![0], /height:\s*1em/, 'and the 1em pitch the translateY(-Nem) roll depends on');
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
  assertKeyedBy(cart, "$('cartFootTotal')", "'cart'",
    'the innerHTML surface goes through the rewrite-then-roll helper, under the constant key the cart’s own comment claims');
});

test('innerHTML summaries roll ONLY under a same-entity key — a new scan must snap', () => {
  assertKeyedBy(INDEX, "$('dupSummary')", 'state.dup.loadedFor',
    'duplicates summary is keyed by scan+threshold — a fresh hunt must not roll from the last one’s figures');
  assertKeyedBy(INDEX, "$('ndSummary')", 'state.near.loadedFor',
    'near-duplicates summary is keyed the same way');
  for (const id of ['appsInfo', 'gamesInfo', 'mediaInfo']) {
    assertKeyedBy(INDEX, `$('${id}')`, 'state.scanId', `${id} is keyed by the scan it describes`);
  }
  assertKeyedBy(slice('function renderZombies(', 'function wireZombieActions'), 'body', "'zh'",
    'the held-up-space card is one entity across its life, so a constant key is the honest one');
  assertKeyedBy(slice('async function renderTrendDeltas', 'function deltaRow'), 'host', 'state.trends.path',
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
  const reduced = reducedBlock(styles);
  assert.match(reduced, /\.fx-shimmer-text \{[^}]*animation:\s*none/,
    'REDUCED gets a static label — and the rule is INSIDE the query, not merely near it');
  assert.match(reduced, /-webkit-text-fill-color:\s*currentColor/,
    'with the fill handed back, or a static label would be invisible');
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
  const reduced = reducedBlock(styles);
  assert.match(reduced, /\.fx-chart-loading::before, \.fx-chart-loading::after \{[^}]*animation:\s*none/,
    'REDUCED gets a static veil — the rule must be INSIDE the query, or the pulse and sweep are dead for everyone');
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

test('the missing-gigabytes card waits in the same language as every other card', () => {
  const load = slice('async function loadMissing(', 'function renderMissing()');
  assert.ok(!/Reconciling…<\/div>/.test(load),
    'a plain muted line was the one pending state left speaking a different language');
  assert.match(load, /skeletonRows\(/, 'a first load gets skeleton rows');
  assert.match(load, /classList\.add\('fx-chart-loading'\)/, 'a refresh veils the standing receipt instead of blanking it');
  assert.match(load, /catch[\s\S]{0,120}?classList\.remove\('fx-chart-loading'\)/,
    'a failed reconcile must not leave the card veiled forever');
  assert.match(slice('function renderMissing()', '/* Segment → its row.'), /classList\.remove\('fx-chart-loading'\)/,
    'and the paint settles it');
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
  // The History calendar can count for seconds on a big root — its pending
  // state is the same skeleton language, not a bare muted sentence.
  assert.match(slice('async function loadCalendar', 'function renderCalendar'),
    /skeletonRows\(\d+, \d+, 'Counting bytes per day…'\)/);
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
  assert.match(charts, /FxNum\.rollText\(pill,/, 'slot-machine numerals via the shared roller');
  assert.match(charts, /if \(when\) \{/, 'shown only when formatTime yields a date');
  assert.match(charts, /pill\.remove\(\)/, 'destroy() removes it — every mount has its teardown');
  const leave = charts.slice(charts.indexOf('function onLeave'), charts.indexOf("life.on(canvas, 'mousemove'"));
  assert.match(leave, /pill\.classList\.remove\('on'\)/, 'leaving the chart hides the pill');
});
