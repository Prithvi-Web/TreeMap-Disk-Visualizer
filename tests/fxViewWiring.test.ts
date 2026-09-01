import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * View wiring — the round that put the chart kit to work in the views.
 *
 * Two kinds of pin, following tests/numeralsLoading.test.ts:
 *
 *   1. **The dead-code pin.** Every FxCharts factory — old and new — must
 *      have at least one real call site outside the FX section itself. A
 *      kit primitive nobody mounts is dead weight that still ships to every
 *      user, and the way it happens is silent: a refactor moves a view off
 *      a factory and nothing fails. The factory list is read from the kit's
 *      own export line, so a factory added later is covered automatically.
 *
 *   2. **Containment pins.** Every handle this round created is paired with
 *      a destroy on every exit door — view unmount, modal close, the state
 *      that hid it — because the classic regression keeps the pretty half
 *      and quietly drops the teardown. The pure derivations (net-change
 *      points, calendar quarters) run in Node as behaviour.
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

/** Evaluate one small standalone app function in Node, with stubbed globals. */
function appFn(name: string, deps: Record<string, unknown> = {}): (...args: any[]) => any {
  const start = INDEX.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} exists`);
  const end = INDEX.indexOf('\n}', start);
  assert.notEqual(end, -1, `function ${name} closes`);
  const src = INDEX.slice(start, end + 2);
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, `${src}; return ${name};`)(...keys.map((k) => deps[k]));
}

/* ══════════════════ the dead-code pin ══════════════════ */

test('every FxCharts factory has a real call site outside the FX section', () => {
  const fxStart = INDEX.indexOf('/* ═══════════════ FX: Charts ═══════════════ */');
  const fxEnd = INDEX.indexOf('/* ═══ end FX: Charts ═══ */');
  assert.ok(fxStart !== -1 && fxEnd > fxStart, 'the FX: Charts banners bound the kit');
  const section = INDEX.slice(fxStart, fxEnd);
  const at = section.lastIndexOf('return {');
  const close = section.indexOf('};', at);
  assert.ok(at !== -1 && close > at, 'the kit ends on its export line');
  // Shorthand entries that are function declarations in the section are the
  // factories; `math` and aliased entries (ramp: math.ramp) are not.
  const factories = section.slice(at + 'return {'.length, close)
    .split(',')
    .map((e) => e.trim())
    .filter((e) => /^[A-Za-z_$][\w$]*$/.test(e))
    .filter((e) => section.includes(`function ${e}(`));
  assert.ok(factories.length >= 9, `the export names the factories (saw: ${factories.join(', ')})`);
  const outside = INDEX.slice(0, fxStart) + INDEX.slice(fxEnd);
  for (const f of factories) {
    assert.ok(outside.includes(`FxCharts.${f}(`),
      `FxCharts.${f} is mounted by real app code — an unused factory is dead weight, wire it or remove it`);
  }
});

/* ══════════════════ pure derivations, run in Node ══════════════════ */

test('trendNetPoints derives consecutive deltas from the SAME series the area draws', () => {
  const trendNetPoints = appFn('trendNetPoints');
  const snaps = [
    { takenAt: 100, totalSize: 50 },
    { takenAt: 200, totalSize: 80 },
    { takenAt: 300, totalSize: 20 },
  ];
  assert.deepEqual(trendNetPoints(snaps), [
    { t: 200, v: 30 },   // grew by 30
    { t: 300, v: -60 },  // freed 60 — a real negative, never clamped
  ]);
  assert.deepEqual(trendNetPoints([]), [], 'no snapshots, no deltas');
  assert.deepEqual(trendNetPoints([snaps[0]]), [], 'one snapshot has no delta — nothing is invented');
});

test('calQuarterOf reads the quarter from the ISO string alone', () => {
  const calQuarterOf = appFn('calQuarterOf');
  assert.equal(calQuarterOf('2026-01-15'), 1);
  assert.equal(calQuarterOf('2026-03-31'), 1);
  assert.equal(calQuarterOf('2026-04-01'), 2);
  assert.equal(calQuarterOf('2026-07-04'), 3);
  assert.equal(calQuarterOf('2026-12-25'), 4);
});

/* ══════════════════ Trends ══════════════════ */

test('the trends area mounts the full bklit surface: fades, dots, brush, budget band', () => {
  const draw = slice('function drawTrendChart(', 'function trendNetPoints(');
  assert.match(draw, /fadeEdges: span > 0 && span >= domain \* 0\.2/,
    'edges dissolve only once the history holds its own fifth of the domain — the fade must never erase a young series');
  assert.match(draw, /pattern: 'dots'/, 'the dotted backdrop is on');
  assert.match(draw, /brush: pts\.length > 1 \? \{\} : null/, 'the brush strip needs something to zoom');
  assert.match(draw, /budgetFor\(state\.trends\.path\)/, 'the band reads the budget the app already fetched');
  // The BRANCH, not a trailing token: `/: null,\s*\};/` was satisfied by any
  // property that happened to end the spec with a null, so the else-branch was
  // free to become a fabricated `{ from: 0, to: Infinity }` ceiling on every
  // root with no budget at all.
  const band = /referenceBand:\s*(budget && budget\.maxBytes > 0)\s*\?\s*\{([\s\S]{0,240}?)\}\s*:\s*([A-Za-z0-9_.{[]+),/.exec(draw);
  assert.ok(band, 'the band is a ternary on a real, positive budget');
  assert.match(band![2], /from: budget\.maxBytes, to: Infinity/, 'over-budget territory is the ceiling upward');
  assert.equal(band![3], 'null', 'no budget means no band — never a fabricated ceiling');
});

/**
 * The projection used to run a flat 30 days past the last snapshot whatever
 * the history was. With 18 snapshots spanning an hour that left the real
 * series inside 0.05% of the plot — an empty-looking chart — and it drew a
 * month-long forecast the app's OWN honesty gate was refusing at the same
 * moment on the dashboard ("needs at least 5 scans spanning 2+ days").
 */
const DAY = 864e5;
const linregStub = {
  math: {
    linreg(pts: Array<{ x: number; y: number }>) {
      const n = pts.length;
      const mx = pts.reduce((s, p) => s + p.x, 0) / n;
      const my = pts.reduce((s, p) => s + p.y, 0) / n;
      let num = 0, den = 0;
      for (const p of pts) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
      const slope = den ? num / den : 0;
      return { slope, project: (x: number) => my + slope * (x - mx) };
    },
  },
};

test('the trends projection never draws what the app’s own forecast gate refuses', () => {
  const trendProjection = appFn('trendProjection', { FxCharts: linregStub });
  const t0 = Date.UTC(2026, 7, 1);
  const hour = Array.from({ length: 18 }, (_, i) => ({ t: t0 + i * (3.6e6 / 17), v: 1e9 + i * 1e6 }));
  assert.equal(trendProjection(hour, false), null,
    'the gate said no — Trends must not project where the dashboard refuses to');
  assert.equal(trendProjection(hour.slice(0, 2), true), null, 'two points are not a fit');
  assert.equal(trendProjection([], true), null, 'and no points are nothing at all');
  const same = Array.from({ length: 5 }, () => ({ t: t0, v: 1e9 }));
  assert.equal(trendProjection(same, true), null, 'a zero-length history has no rate to extend');
});

test('the projection horizon is bounded by the history, so real data always dominates the plot', () => {
  const trendProjection = appFn('trendProjection', { FxCharts: linregStub });
  const t0 = Date.UTC(2026, 7, 1);
  const series = (n: number, span: number) =>
    Array.from({ length: n }, (_, i) => ({ t: t0 + (i * span) / (n - 1), v: 1e9 + i * 1e6 }));

  for (const span of [3.6e6, 2 * DAY, 9 * DAY, 60 * DAY, 400 * DAY]) {
    const pts = series(18, span);
    const p = trendProjection(pts, true)!;
    assert.ok(p, `a span of ${span / DAY} days still projects`);
    const tail = p.points[1].t - pts[pts.length - 1].t;
    assert.ok(tail > 0, 'the forecast reaches forward');
    assert.ok(tail <= 30 * DAY + 1, 'never more than 30 days out — the old flat horizon is the ceiling now');
    const domain = p.points[1].t - pts[0].t;
    assert.ok(span / domain >= 2 / 3 - 1e-9,
      `real data holds ${(span / domain * 100).toFixed(1)}% of the domain — it must hold at least two thirds`);
  }
  // The hour-long history that started this: the tail is half an hour, not a month.
  const hour = series(18, 3.6e6);
  assert.equal(trendProjection(hour, true)!.points[1].t - hour[17].t, 1.8e6);
});

test('one honesty policy: the gate is the server forecast, re-read on every load', () => {
  const draw = slice('function drawTrendChart(', 'function trendNetPoints(');
  assert.match(draw, /trendProjection\(pts, state\.trends\.forecastOk === true\)/,
    'the chart asks the same gate the dashboard banner obeys');
  const load = slice('async function loadTrendData(', 'async function labelTrendForecast(');
  assert.match(load, /state\.trends\.forecastOk = false/,
    'a new root starts with the answer unknown — unknown never projects');
  const label = slice('async function labelTrendForecast(', "$('trendRoot').addEventListener");
  assert.match(label, /const ok = f\.status === 'ok'/, 'the gate is the server’s own status, not a local re-derivation');
  assert.match(label, /state\.trends\.forecastOk = ok;[\s\S]{0,80}?drawTrendChart\(\)/,
    'and the answer repaints the chart — the projection appears only once it is vouched for');
});

test('the reference band pulls the y-domain up to any finite bound', () => {
  const area = slice('function area(canvas, spec)', 'function rings(');
  assert.match(area, /if \(s\.referenceBand && !win\) \{/, 'only the unzoomed view stretches for the band');
  assert.match(area, /Number\.isFinite\(bv\) && bv > vMax/, 'finite bounds only — an open end rides the data');
});

test('the net-change strip exists only from three snapshots, and dies on every door', () => {
  const draw = slice('function drawTrendNet(', 'async function renderTrendDeltas(');
  assert.match(draw, /snaps\.length < 3/, 'two snapshots make one delta — not a line');
  assert.match(draw, /wrap\.hidden = true;\s*if \(trendNetHandle\) \{ trendNetHandle\.destroy\(\); trendNetHandle = null; \}/,
    'hiding the strip releases the handle');
  assert.match(draw, /if \(trendNetHandle\) trendNetHandle\.update\(spec\);\s*else trendNetHandle = FxCharts\.profitLine\(/,
    'one handle, updated in place');
  const entry = slice("id: 'trends'", "id: 'offloaded'");
  assert.match(entry, /trendNetHandle\.destroy\(\); trendNetHandle = null;/, 'trends unmount releases it too');
});

test('the theme toggle refreshes the three new canvas handles', () => {
  const toggle = slice("$('themeToggle').addEventListener", 'function applySideNav(');
  assert.match(toggle, /if \(trendNetHandle\) trendNetHandle\.update\(\{\}\);/, 'the net-change strip retints');
  assert.match(toggle, /if \(appsScatterHandle\) appsScatterHandle\.update\(\{\}\);/, 'the apps scatter retints');
  assert.match(toggle, /if \(capsuleGaugeHandle\) capsuleGaugeHandle\.update\(\{\}\);/, 'the capsule gauge retints');
});

test('delta rows diverge from a centre axis in the two tokenized blue-family tones', () => {
  const fn = slice('function deltaRow(', 'async function checkSnapshotsFor');
  assert.match(fn, /bar-track dv/, 'the track is the diverging variant');
  assert.match(fn, /fx-bar-fill \$\{up \? 'up' : 'down'\}/, 'the fill picks its side from the sign');
  assert.match(fn, /\* 50\)/, 'each side owns half the track — a full-width bar would cross the axis');
  const css = slice('/* Diverging delta bars', '#trendNet {');
  assert.match(css, /\.fx-bar-fill\.up \{ left: 50%/, 'growth anchors at the axis and reaches right');
  assert.match(css, /var\(--accent\)/, 'growth is the accent');
  assert.match(css, /\.fx-bar-fill\.down \{ right: 50%/, 'shrinkage anchors at the axis and reaches left');
  assert.match(css, /var\(--fx-neg\)/, 'shrinkage is the slate counterpart — the profit-line pair');
  // Both callers release the width-in.
  assert.match(slice('async function renderTrendDeltas', 'function deltaRow'), /fxBarsIn\(host\)/);
  assert.match(slice('function renderCompare(', 'let browsePath = null;'), /fxBarsIn\(\$\('cmpBody'\)\)/);
});

/* ══════════════════ History: calendar + compare ══════════════════ */

test('quarter separators land only on week-column boundaries, only within a year', () => {
  const cal = slice('function renderCalendar(', 'function calApplyRange(');
  assert.match(cal, /dayCells % 7 === 0/, 'a separator mid-week would break the 7-row rhythm');
  assert.match(cal, /q === prevQ \+ 1/, 'only a quarter advancing within the year — the year header owns 4→1');
  assert.match(cal, /cal-qsep" role="presentation" data-q="Q\$\{q\}"/, 'the label rides a data attribute');
  const css = slice('.cal-qsep', '#calBody[data-cal-dim');
  assert.match(css, /grid-row: 1 \/ -1/, 'the separator spans the full week column');
  assert.match(css, /linear-gradient\(180deg, transparent,[\s\S]*?transparent\)/, 'the line fades 0→1→0');
});

test('legend hover-sync dims the other levels to 0.3 in 160ms, CSS-owned', () => {
  assert.match(INDEX, /\$\('calLegend'\)\.addEventListener\('mouseover'/, 'hover-in sets the level');
  assert.match(INDEX, /\$\('calBody'\)\.dataset\.calDim = cell\.dataset\.lv/, 'the attribute names the held level');
  assert.match(INDEX, /\$\('calLegend'\)\.addEventListener\('mouseout'/, 'hover-out clears it');
  for (const lv of [1, 2, 3, 4]) {
    assert.match(INDEX, new RegExp(`#calBody\\[data-cal-dim="${lv}"\\] \\.cal-cell:not\\(\\[data-lv="${lv}"\\]\\)`),
      `level ${lv} dims everything that is not level ${lv}`);
  }
  assert.match(INDEX, /\.cal-cell \{[^}]*transition: opacity 160ms/, 'the dim eases over the bklit 160ms');
});

test('compare: counts animate from the real totals and the squares chart dies on every door', () => {
  const fn = slice('function renderCompare(', 'let browsePath = null;');
  const drop = fn.indexOf('cmpCountsDrop()');
  const rewrite = fn.indexOf(".innerHTML = splitCard");
  assert.ok(drop !== -1 && rewrite !== -1 && drop < rewrite,
    'the counts handle dies BEFORE the rewrite that would strand it');
  assert.match(fn, /countUp\(\$\('cmpBody'\)\.querySelector\('\.cmp-total'\), Math\.abs\(r\.totalDelta\), formatBytes\)/,
    'the total rolls from the real delta');
  assert.match(fn, /\.cmp-ct'\)\.forEach\(el => countUp\(el, Number\(el\.dataset\.n\)\)\)/,
    'each count rolls to the number it already prints');
  assert.match(fn, /cmpCountsHandle = FxCharts\.barSquares\(\$\('cmpCounts'\)/, 'counts are discrete squares');
  assert.match(fn, /if \(r\.entries\.length\) \{\s*cmpCountsHandle = FxCharts\.barSquares/,
    'no entries, no chart — the sentence covers zero');
  // The Comparing… rewrite and the history unmount are exit doors too.
  assert.match(slice("$('cmpRunBtn').addEventListener", 'function renderCompare('),
    /cmpCountsDrop\(\);[^]*?innerHTML = `<div class="card glass dup-progress">/);
  assert.match(slice("registerView({\n  id: 'history'", '/* ═══════════ Disk journal'), /unmount\(\) \{[\s\S]*?cmpCountsDrop\(\);/);
});

/* ══════════════════ Apps ══════════════════ */

test('apps rows ride the kit bar recipe and release the width-in', () => {
  const fn = slice('function renderApps(', '/* ── The apps scatter');
  assert.match(fn, /fx-bar-fill" data-w="/, 'rows carry the kit fill');
  assert.match(fn, /fxBarStyle\(i\)/, 'ranked on the blue ramp');
  assert.match(fn, /fxBarStyle\(3\)/, 'the everything-else row takes the trailing tone');
  assert.match(fn, /fxBarsIn\(host\)/, 'the width-in is released once per paint');
  assert.doesNotMatch(fn, /class="bar" style="width/, 'no plain bars left behind');
});

test('the apps scatter: five-app floor, unknown-is-not-zero, and every exit door', () => {
  const fn = slice('async function loadAppsScatter(', 'async function loadDuplicates(');
  assert.match(fn, /apps\.length < 5\) \{ appsScatterDrop\(\); return; \}/, 'fewer than five apps make a legend, not a scatter');
  assert.match(fn, /else \{ known = false; break; \}/, 'a location the provider could not count voids the dot');
  assert.match(fn, /points\.length < 5\) \{ appsScatterDrop\(\); return; \}/, 'and so does a starved point set');
  assert.match(fn, /seq !== appsScatterSeq/, 'a stale fact response cannot resurrect the chart');
  assert.match(fn, /providers: \['subtreeCount'\]/, 'counts come from the same fact Disk City uses');
  const drop = slice('function appsScatterDrop(', 'async function loadAppsScatter(');
  assert.match(drop, /appsScatterSeq\+\+/, 'dropping invalidates any fetch still in flight');
  assert.match(drop, /appsScatterHandle\.destroy\(\); appsScatterHandle = null;/, 'and releases the handle');
  assert.match(slice("id: 'apps'", "id: 'games'"), /unmount\(\) \{[\s\S]*?appsScatterDrop\(\);/, 'the view unmount drops it');
  assert.match(slice('async function loadApps(', 'function costMoney('),
    /appsScatterDrop\(\);/, 'a reload drops the previous scan’s dots');
});

/* ══════════════════ Capsule ══════════════════ */

test('the capsule cap meter is the linear gauge, and hiding it always releases it', () => {
  const fn = slice('function renderCapsule(', 'let capsuleEventsHandle');
  assert.match(fn, /orientation: 'linear', linearHeight: 14/, 'laid flat at caption height');
  assert.match(fn, /notchCornerRadius: 99/, 'clamped to a true capsule');
  // The tone is named, not spelled: a raw hex here painted the same amber in
  // both themes (~1.9:1 on a light card). --warn carries the light override.
  assert.match(fn, /warn: pct > 85/, 'past 85% the track turns the warn tone the plain bar used');
  assert.match(fn, /activeGradient: \['#0A84FF', '#86C1FF'\]/, 'the normal ramp is unchanged');
  assert.match(fn, /FxNum\.rollText\(\$\('capsuleGaugeText'\)/, 'the caption rolls');
  assert.match(fn, /FxNum\.rollHtml\(\$\('capsuleInfo'\)[\s\S]{0,400}?'capsule'\)/, 'the info line rolls under the constant key');
  // The ONLY place the gauge hides is the helper that also destroys — a bare
  // `.hidden = true` would strand a live canvas handle behind display:none.
  const hides = INDEX.match(/\$\('capsuleGauge'\)\.hidden = true/g) || [];
  assert.equal(hides.length, 1, 'one hide, inside capsuleGaugeHide — every caller goes through it');
  assert.match(slice('function capsuleGaugeHide(', 'async function loadCapsule('),
    /capsuleGaugeHandle\.destroy\(\); capsuleGaugeHandle = null;[\s\S]*?\$\('capsuleGauge'\)\.hidden = true/);
  const load = slice('async function loadCapsule(', 'function renderCapsule(');
  assert.match(load, /gaugeEl\.classList\.add\('fx-chart-loading'\)/, 'a refresh sweeps the standing gauge');
  assert.equal((load.match(/classList\.remove\('fx-chart-loading'\)/g) || []).length, 2,
    'the veil settles on the success path AND the error path');
  assert.match(slice("registerView({\n  id: 'capsule'", '/* ═══════════ The Missing Gigabytes'),
    /unmount\(\) \{[\s\S]*?capsuleGaugeHide\(\);[\s\S]*?capsuleEventsDrop\(\);/, 'the view unmount releases both handles');
});

test('the couldn’t-keep list is barList, destroyed before the rewrite that would strand it', () => {
  const fn = slice('function renderCapsuleEvents(', 'function restoreFromCapsule(');
  const drop = fn.indexOf('capsuleEventsDrop()');
  const rewrite = fn.indexOf('host.innerHTML');
  assert.ok(drop !== -1 && rewrite !== -1 && drop < rewrite, 'destroy first, rewrite second');
  assert.match(fn, /capsuleEventsHandle = FxCharts\.barList\(\$\('capsuleEventsList'\)/, 'the kit owns the rows');
});

/* ══════════════════ Duplicates ══════════════════ */

test('the reclaim funnel exists only while a selection does, and dies on every door', () => {
  const fn = slice('function updateDupToolbar(', "$('dupAutoBtn')");
  assert.match(fn, /if \(n && state\.dup\.status === 'complete'\) \{/, 'no selection, no funnel');
  assert.match(fn, /\{ name: 'Duplicate bytes', value: state\.dup\.totalReclaimable \}/, 'stage 1 is the hunt’s own total');
  assert.match(fn, /\{ name: 'Selected', value: total \}/, 'stage 2 is the live selection');
  assert.match(fn, /if \(cartHas\(p\)\) staged \+= nodeFor\(p\)\?\.size \?\? 0/, 'stage 3 is what of it is already staged');
  assert.match(fn, /\} else \{\s*dupFunnelDrop\(\);\s*\}/, 'clearing the selection clears the funnel');
  assert.match(slice("id: 'duplicates'", "// Trends, Compare and Offloaded"), /dupFunnelDrop\(\);/, 'the view unmount drops it');
  assert.match(slice('function refreshCartButtons(', '/* ── Phase 4 (v4 §4.1) — the goal meter'),
    /if \(state\.view === 'duplicates'\) updateDupToolbar\(\)/,
    'every cart mutation funnels through here, so the staged stage stays current');
});

test('duplicate groups carry the kit mini-bar, scaled to the shown groups', () => {
  const fn = slice('function renderDuplicates(', 'function dupFillGroup(');
  assert.match(fn, /const maxRec = groups\.slice\(0, shown\)\.reduce/, 'the scale is the shown list’s own max');
  assert.match(fn, /bar-track dup-mini"><div class="fx-bar-fill" data-w="/, 'the kit fill, in the head row');
  assert.match(fn, /fxBarStyle\(gi\)/, 'ranked on the blue ramp');
  assert.match(fn, /fxBarsIn\(body\)/, 'released once per paint');
  assert.match(INDEX, /@container \(max-width: 620px\) \{ \.dup-head \.bar-track\.dup-mini \{ display: none; \} \}/,
    'the least essential column leaves first when the card runs out of room');
});

/* ══════════════════ Clean Up modal ══════════════════ */

test('the smart-pane funnel states suggested → staged → projected free, and dies with the sheet', () => {
  const fn = slice('function renderCleanFunnel(', "$('cleanConfirmBtn')");
  assert.match(fn, /if \(!\(suggested > 0\)\) \{ cleanFunnelDrop\(\); return; \}/, 'no results, no funnel');
  assert.match(fn, /\{ name: 'Suggested', value: suggested \}/, 'what the rules found');
  assert.match(fn, /\{ name: 'Staged', value: staged \}/, 'what is ticked, each at its own size');
  assert.match(fn, /\{ name: 'Projected free', value: freed \}/, 'the deduped promise the summary states');
  assert.match(slice('function updateCleanSummary(', 'let cleanFunnelHandle'),
    /if \(cleanPane === 'smart'\) renderCleanFunnel\(bytes\)/, 'only the smart pane owns it');
  assert.match(slice('function closeModal(', 'document.querySelectorAll'),
    /if \(id === 'cleanModal'\) cleanFunnelDrop\(\)/, 'every close — button, scrim, Esc, confirm — is one funnel');
  assert.match(slice("$('cleanupBtn').addEventListener", 'setCleanPane'),
    /cleanFunnelDrop\(\)/, 'reopening resets the previous results’ funnel');
});

/* ══════════════════ Missing GB ══════════════════ */

test('the receipt segments ramp their own token and dim the others on hover', () => {
  const css = slice('.mg-seg {', '/* Where the volume');
  for (const seg of ['scanned', 'snapshots', 'handles', 'volumes']) {
    assert.match(css, new RegExp(`\\.mg-seg\\.is-${seg}\\s+\\{ background: linear-gradient\\(180deg,\\s*\\n?\\s*color-mix\\(in srgb, var\\(--mg-${seg}\\)`),
      `${seg} ramps its own token — no new hues`);
  }
  assert.match(css, /\.mg-bar:hover \.mg-seg:not\(:hover\) \{ opacity: 0\.3; \}/, 'bklit hover: the rest fall to 0.3');
  assert.match(css, /\.mg-bar:focus-within \.mg-seg:not\(:focus-visible\) \{ opacity: 0\.3; \}/, 'keyboard gets the same language');
  assert.match(css, /opacity 160ms var\(--ease\)/, 'over the bklit 160ms');
  assert.match(css, /repeating-linear-gradient/, 'the residual keeps its hatch — it is not a measurement');
});

/* ══════════════════ info lines that roll ══════════════════ */

test('security, offloaded and fleet paint through keyed rolls', () => {
  assert.match(INDEX, /FxNum\.rollHtml\(\$\('securityInfo'\)[\s\S]{0,700}?state\.scanId\)/,
    'security is keyed by the scan it describes');
  assert.match(INDEX, /FxNum\.rollHtml\(\$\('offloadInfo'\)[\s\S]{0,700}?'offload-index'\)/,
    'the offload index is one entity — a constant key');
  assert.match(slice('function renderFleet(', 'async function setFleet('), /FxNum\.rollHtml\(host,/,
    'the fleet panel rolls its figures across the 5-second refresh');
  assert.match(INDEX, /availableHtml, 'fleet'\)/, 'under its constant key');
});
