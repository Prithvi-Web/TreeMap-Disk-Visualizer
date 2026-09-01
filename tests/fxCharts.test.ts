import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * FX: Charts — the pure math core, as behaviour.
 *
 * The chart kit lives in public/index.html between exact banner comments
 * (the commandPalette extraction precedent). FxCharts.math is DOM-free by
 * construction, so the whole section is evaluated here in Node with the
 * app globals stubbed, and the scales / ticks / smoothing / arcs / ramps
 * are exercised as functions — determinism, coverage and monotonicity are
 * behaviour, not structure.
 *
 * The section is permanently spliced, so a missing banner is a broken
 * build: it fails loudly here instead of silently turning the math suite
 * into skips. FXCHARTS_SRC=<path to section.js> still validates a
 * standalone file the same way, ahead of a merge.
 */

const BANNER = '/* ═══════════════ FX: Charts ═══════════════ */';
const END = '/* ═══ end FX: Charts ═══ */';

function sectionSource(): string {
  const alt = process.env.FXCHARTS_SRC;
  if (alt && existsSync(alt)) return readFileSync(alt, 'utf8');
  const html = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const a = html.indexOf(BANNER);
  assert.notEqual(a, -1, 'FX: Charts is spliced into index.html — a renamed banner must fail, never skip');
  const b = html.indexOf(END, a);
  assert.notEqual(b, -1, 'FX: Charts banner opens but never closes');
  return html.slice(a, b + END.length);
}

const SRC = sectionSource();

/* App globals the section references lazily; math never touches them,
   but evaluating the section must not depend on a browser. */
function loadFxCharts(): any {
  const stubs = `
    const REDUCED = true;
    const UNITS = ['B','KB','MB','GB','TB','PB'];
    function formatBytes(n, d = 1) {
      if (!Number.isFinite(n) || n < 0) return '0 B';
      if (n < 1024) return Math.round(n) + ' B';
      let v = n, u = 0;
      while (v >= 1024 && u < UNITS.length - 1) { v /= 1024; u++; }
      return v.toFixed(d) + ' ' + UNITS[u];
    }
    function cssVar() { return ''; }
    const Canvas2D = { setup() { throw new Error('DOM-only'); }, toLocal() { throw new Error('DOM-only'); } };
  `;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${stubs}\n${SRC}\nreturn FxCharts;`)();
}

test('FX: Charts — section evaluates in Node and exposes the full API', () => {
  const fx = loadFxCharts();
  for (const k of ['area', 'rings', 'gauge', 'barList', 'liveLine', 'ramp', 'math']) {
    assert.ok(k in fx, `FxCharts.${k} exists`);
  }
  for (const k of ['scaleLinear', 'scaleTime', 'niceTicks', 'monotone', 'bezierPoint',
    'ramp', 'lerpColor', 'arcLayout', 'polar', 'linreg', 'extent', 'alpha']) {
    assert.equal(typeof fx.math[k], 'function', `FxCharts.math.${k} is a function`);
  }
});

test('alpha re-alphas theme tokens without shifting hue — and never guesses', () => {
  const { math } = loadFxCharts();
  // The crosshair fade builds its transparent stops from whatever --text-3
  // holds; hex and rgb()/rgba() are the two shapes tokens actually use.
  assert.equal(math.alpha('#0A84FF', 0), 'rgba(10,132,255,0)');
  assert.equal(math.alpha('rgba(255,255,255,0.42)', 0), 'rgba(255,255,255,0)');
  assert.equal(math.alpha('rgb(10, 12, 20)', 0.5), 'rgba(10,12,20,0.5)');
  // Anything else falls back to fully transparent rather than fading
  // through a wrong color. Asserted at a NONZERO alpha as well: at a = 0 a
  // wrong guess of `rgba(0,0,0,${a})` prints the same string, and alpha is
  // called with a > 0 in ~15 places (grid fades, band fills, the 0.35 zero
  // row, the 0.07 brush window, liveLine's gradient stops) — a guess there
  // paints solid black, invisible in dark theme and a smear in light.
  for (const unresolved of ['var(--text-3)', '', 'currentColor', 'oklch(0.7 0.1 250)']) {
    assert.equal(math.alpha(unresolved, 0), 'rgba(0,0,0,0)', `${unresolved || '(empty)'} at 0`);
    assert.equal(math.alpha(unresolved, 0.5), 'rgba(0,0,0,0)',
      `${unresolved || '(empty)'} at 0.5 — an unreadable token vanishes, it never guesses black`);
    assert.equal(math.alpha(unresolved, 1), 'rgba(0,0,0,0)', `${unresolved || '(empty)'} at 1`);
  }
});

/* ══════════════════ nice ticks: niceness + coverage ══════════════════ */

test('niceTicks covers the domain and steps stay 1/2/5 × 10^k', () => {
  const { math } = loadFxCharts();
  for (const [min, max] of [[0, 987654321], [0, 1], [3, 7], [0, 0.042], [12, 12], [0, 1024 ** 4]]) {
    const ticks = math.niceTicks(min, max, 4) as number[];
    assert.ok(ticks.length >= 2, `at least two ticks for [${min}, ${max}]`);
    assert.ok(ticks[0] <= min + 1e-9, `first tick ${ticks[0]} ≤ min ${min}`);
    assert.ok(ticks[ticks.length - 1] >= max - 1e-9, `last tick covers max ${max}`);
    const step = ticks[1] - ticks[0];
    const mant = step / Math.pow(10, Math.floor(Math.log10(step)));
    assert.ok([1, 2, 5].some((m) => Math.abs(mant - m) < 1e-6), `step ${step} is a nice number`);
    for (let i = 2; i < ticks.length; i++) {
      assert.ok(Math.abs((ticks[i] - ticks[i - 1]) - step) < step * 1e-6, 'even spacing throughout');
    }
    assert.ok(ticks.length <= 12, 'a tick count a human can read');
  }
});

test('niceTicks is defensive: reversed, degenerate and non-finite inputs', () => {
  const { math } = loadFxCharts();
  const rev = math.niceTicks(10, 2, 4) as number[];
  assert.ok(rev[0] <= 2 && rev[rev.length - 1] >= 10, 'reversed domain is righted');
  const nan = math.niceTicks(NaN, NaN, 4) as number[];
  assert.ok(nan.length >= 2, 'NaN domain still yields ticks');
});

/* ══════════════ monotone smoothing preserves monotonicity ══════════════ */

test('monotone cubic never inverts a monotone series', () => {
  const { math } = loadFxCharts();
  const xs = [0, 10, 20, 30, 40, 55, 70];
  const ys = [0, 1, 1, 8, 8.5, 40, 41]; // flat spells + a spike: the overshoot trap
  const segs = math.monotone(xs, ys);
  assert.equal(segs.length, xs.length - 1, 'one segment per interval');
  let prevY = -Infinity;
  for (const seg of segs) {
    for (let i = 0; i <= 24; i++) {
      const p = math.bezierPoint(seg, i / 24);
      assert.ok(p.y >= prevY - 1e-7, `curve never dips: ${p.y} after ${prevY}`);
      prevY = p.y;
    }
  }
});

test('monotone interpolates through every data point exactly', () => {
  const { math } = loadFxCharts();
  const xs = [0, 5, 9, 14];
  const ys = [3, 7, 7, 2];
  const segs = math.monotone(xs, ys);
  for (let i = 0; i < segs.length; i++) {
    assert.ok(Math.abs(segs[i].x0 - xs[i]) < 1e-9 && Math.abs(segs[i].y0 - ys[i]) < 1e-9, `segment ${i} starts on the data`);
    assert.ok(Math.abs(segs[i].x1 - xs[i + 1]) < 1e-9 && Math.abs(segs[i].y1 - ys[i + 1]) < 1e-9, `segment ${i} ends on the data`);
  }
  assert.deepEqual(math.monotone([1], [1]), [], 'a single point draws nothing');
});

/* ══════════════════ ramp: endpoints + count ══════════════════ */

test('ramp returns exactly n colors anchored at the accent', () => {
  const fx = loadFxCharts();
  for (const n of [1, 2, 3, 4, 5, 8, 12]) {
    const colors = fx.ramp(n) as string[];
    assert.equal(colors.length, n, `ramp(${n}) has ${n} entries`);
    assert.equal(colors[0].toUpperCase(), '#0A84FF', 'the ramp starts at --accent');
    for (const c of colors) assert.match(c, /^#[0-9A-F]{6}$/i, `${c} is a hex color`);
  }
  const four = fx.ramp(4) as string[];
  assert.equal(four[3].toUpperCase(), '#B9DBFF', 'the core ramp ends at ice blue');
  assert.equal(new Set(fx.ramp(8)).size, 8, 'eight distinct colors — no accidental repeats');
  assert.deepEqual(fx.ramp(0), [], 'ramp(0) is empty, not broken');
});

/* ══════════════════ arc layout sums to the whole ══════════════════ */

test('arcLayout spans + gaps sum to exactly 2π and fractions to 1', () => {
  const { math } = loadFxCharts();
  const values = [500, 300, 150, 50];
  const gap = 0.028;
  const segs = math.arcLayout(values, { gap });
  const spans = segs.reduce((s: number, seg: any) => s + (seg.end - seg.start), 0);
  assert.ok(Math.abs(spans + gap * values.length - Math.PI * 2) < 1e-9, 'spans + gaps = full circle');
  const fracs = segs.reduce((s: number, seg: any) => s + seg.frac, 0);
  assert.ok(Math.abs(fracs - 1) < 1e-9, 'fractions sum to 1');
  for (let i = 1; i < segs.length; i++) {
    assert.ok(segs[i].start >= segs[i - 1].end - 1e-12, 'segments never overlap');
  }
});

test('arcLayout survives zeros and a single segment', () => {
  const { math } = loadFxCharts();
  const withZero = math.arcLayout([10, 0, 5]);
  assert.equal(withZero[1].start, withZero[1].end, 'a zero value spans nothing');
  const solo = math.arcLayout([42]);
  assert.ok(Math.abs((solo[0].end - solo[0].start) - Math.PI * 2) < 1e-9, 'one segment owns the full circle (no gap against itself)');
  const empty = math.arcLayout([0, 0]);
  for (const seg of empty) assert.equal(seg.frac, 0, 'an all-zero ring lays out flat instead of dividing by zero');
});

/* ══════════════════ scales round-trip ══════════════════ */

test('scaleLinear round-trips to→from within float noise', () => {
  const { math } = loadFxCharts();
  const sc = math.scaleLinear(0, 1024 ** 3, 62, 900);
  for (const v of [0, 1, 12345678, 1024 ** 3, 1024 ** 3 / 3]) {
    assert.ok(Math.abs(sc.from(sc.to(v)) - v) < Math.max(1, v) * 1e-9, `round-trip preserves ${v}`);
  }
  assert.equal(sc.to(0), 62, 'domain min lands on range min');
  assert.equal(sc.to(1024 ** 3), 900, 'domain max lands on range max');
  const degenerate = math.scaleLinear(5, 5, 0, 100);
  assert.ok(Number.isFinite(degenerate.to(5)), 'a zero-width domain never divides by zero');
});

test('linreg projects the exact line through linear data', () => {
  const { math } = loadFxCharts();
  const pts = [0, 1, 2, 3, 4].map((x) => ({ x, y: 3 + 2 * x }));
  const { slope, intercept, project } = math.linreg(pts);
  assert.ok(Math.abs(slope - 2) < 1e-9 && Math.abs(intercept - 3) < 1e-9, 'recovers y = 2x + 3');
  assert.ok(Math.abs(project(10) - 23) < 1e-9, 'projection extends the line');
  assert.equal(math.linreg([]).slope, 0, 'no data projects flat, not NaN');
});

/* ══════════════════ log axes: the apps-scatter mapping ══════════════════ */

test('scaleLog places log10(value+1) decades evenly and round-trips', () => {
  const { math } = loadFxCharts();
  const sc = math.scaleLog(999, 0, 300); // log10(999 + 1) = exactly 3 decades
  assert.equal(sc.to(0), 0, 'zero sits exactly at the origin');
  assert.ok(Math.abs(sc.to(9) - 100) < 1e-9, 'the first decade costs one third of the range');
  assert.ok(Math.abs(sc.to(99) - 200) < 1e-9, 'the second costs the same third');
  assert.ok(Math.abs(sc.to(999) - 300) < 1e-9, 'the cap lands on the range end');
  for (const v of [0, 3, 42, 500, 999]) {
    assert.ok(Math.abs(sc.from(sc.to(v)) - v) < 1e-6, `round-trip preserves ${v}`);
  }
  assert.ok(Number.isFinite(math.scaleLog(0, 0, 100).to(0)), 'an empty domain never divides by zero');
});

/**
 * The axis caps at the DATA, never at the next full power. Rounding up cost a
 * base-1024 byte axis a whole decade: a 17 GB largest app produced a "1.0 TB"
 * ceiling and left a third of the plot permanently empty, and the label at the
 * top was a number no app in the list had. The top tick is now the real
 * maximum; the decades that fall inside it are the gridlines.
 */
test('logTicks: decades INSIDE the data, and the real max as the top label', () => {
  const { math } = loadFxCharts();
  // The regression, exactly: 17 GB of app on a byte axis.
  const bytes = math.logTicks(17 * 1024 ** 3, 1024, 4) as number[];
  assert.equal(bytes[bytes.length - 1], 17 * 1024 ** 3, 'the top of the axis is the largest app, not 1 TB');
  assert.ok(bytes.every((v) => v <= 17 * 1024 ** 3), 'no tick sits outside the data');
  assert.deepEqual(bytes, [0, 1024, 1024 ** 2, 1024 ** 3, 17 * 1024 ** 3]);
  // Base 10 rounds up the same way, and is fixed the same way.
  assert.deepEqual(math.logTicks(300000, 10, 5), [0, 10, 1000, 100000, 300000]);
  assert.deepEqual(math.logTicks(1000, 10, 5), [0, 10, 100, 1000],
    'an exact power is its own top — no duplicate label a quarter-decade apart');
  assert.deepEqual(math.logTicks(0, 10, 5), [0, 1], 'no data still yields an axis');
  assert.deepEqual(math.logTicks(7, 10, 5), [0, 7], 'below the first decade the max is the only label');
  for (const [max, base] of [[7, 10], [3e9, 10], [5e12, 1024], [1, 10], [1024 ** 4 + 1, 1024]] as const) {
    const ticks = math.logTicks(max, base, 5) as number[];
    assert.equal(ticks[0], 0, 'the origin is a tick');
    assert.equal(ticks[ticks.length - 1], max, `the axis tops at the data (${max}), never above it`);
    assert.ok(ticks.length <= 7, 'a tick count a human can read');
    for (let i = 1; i < ticks.length; i++) {
      assert.ok(ticks[i] > ticks[i - 1], 'strictly ascending');
      if (i === ticks.length - 1) continue; // the top tick is the data, not a decade
      const exp = Math.log(ticks[i]) / Math.log(base);
      assert.ok(Math.abs(exp - Math.round(exp)) < 1e-9, `${ticks[i]} is a power of ${base}`);
      assert.ok(ticks[i] < max, 'every decade drawn actually falls inside the plot');
    }
  }
});

test('compactCount speaks 10/100/1k/10k, never scientific notation', () => {
  const { math } = loadFxCharts();
  assert.equal(math.compactCount(10), '10');
  assert.equal(math.compactCount(100), '100');
  assert.equal(math.compactCount(1000), '1k');
  assert.equal(math.compactCount(10000), '10k');
  assert.equal(math.compactCount(1000000), '1M');
  assert.equal(math.compactCount(1200000), '1.2M');
  assert.equal(math.compactCount(0), '0');
  assert.equal(math.compactCount(NaN), '0', 'nonsense reads as the origin, not "NaN"');
});

test('densityScale shrinks dots under crowding — monotone, floored at 0.6', () => {
  const { math } = loadFxCharts();
  assert.equal(math.densityScale(5), 1, 'a sparse scatter keeps full-size dots');
  assert.equal(math.densityScale(40), 1, 'the shrink starts only past 40 points');
  assert.ok(math.densityScale(300) <= 0.6 + 1e-9, 'a ~300-app scatter reads as points, not a blob');
  let prev = Infinity;
  for (let n = 0; n <= 500; n += 10) {
    const d = math.densityScale(n) as number;
    assert.ok(d <= prev + 1e-12, 'never grows with more points');
    assert.ok(d >= 0.6 - 1e-9 && d <= 1, 'clamped to [0.6, 1]');
    prev = d;
  }
});

/* ══════════════════ radar (the reclaim score's six signals) ══════════════════ */

/**
 * The reclaim score is six weighted signals, and any of them can decline to
 * answer. The score's own promise — stated in the breakdown's footer — is
 * that a missing signal is LEFT OUT, never counted as zero. A radar makes
 * that promise easy to break: a null plotted at the centre is visually
 * indistinguishable from a measured 0.0. So the geometry refuses.
 */
test('radarPoint refuses to place a vertex for a signal that did not answer', () => {
  const { math } = loadFxCharts();
  for (const v of [null, undefined, NaN, 'x']) {
    assert.equal(math.radarPoint(100, 100, 80, 0, 6, v as never), null,
      `${String(v)} has no vertex — it is not a zero`);
  }
  const zero = math.radarPoint(100, 100, 80, 0, 6, 0);
  assert.ok(zero, 'a measured zero DOES have a vertex — at the centre');
  assert.ok(Math.hypot(zero.x - 100, zero.y - 100) < 1e-9);
});

test('radar axes start at twelve o clock and run clockwise, evenly', () => {
  const { math } = loadFxCharts();
  const n = 6;
  const top = math.radarPoint(0, 0, 10, 0, n, 1);
  assert.ok(Math.abs(top.x) < 1e-9 && Math.abs(top.y + 10) < 1e-9,
    'the first axis points straight up, so the same file always draws the same shape');
  // clockwise: the next axis is to the RIGHT of the first in screen space
  const next = math.radarPoint(0, 0, 10, 1, n, 1);
  assert.ok(next.x > 0, 'clockwise');
  // evenly spaced
  for (let i = 0; i < n; i++) {
    const a = math.radarAngle(i, n), b = math.radarAngle((i + 1) % n, n);
    let d = b - a; if (d < 0) d += Math.PI * 2;
    assert.ok(Math.abs(d - (Math.PI * 2) / n) < 1e-9, 'equal wedges');
  }
});

test('radar value is clamped to the rings, never outside the grid', () => {
  const { math } = loadFxCharts();
  const R = 50;
  for (const v of [-1, 0, 0.5, 1, 2]) {
    const p = math.radarPoint(0, 0, R, 0, 6, v);
    const r = Math.hypot(p.x, p.y);
    assert.ok(r <= R + 1e-9 && r >= -1e-9, `${v} lands on or inside the rim`);
  }
});

/**
 * The shape is drawn as RUNS of consecutive answered axes, so a gap is a gap:
 * the outline never chords across a signal that could not answer, which would
 * read as a measured value halfway between its neighbours.
 */
test('radarRuns breaks the outline at every unanswered axis', () => {
  const { math } = loadFxCharts();
  const all = math.radarRuns([0.2, 0.4, 0.6, 0.8, 1, 0.5]);
  assert.deepEqual(all, [{ start: 0, len: 6, closed: true }],
    'six answers is one closed polygon');

  const oneGap = math.radarRuns([0.2, null, 0.6, 0.8, 1, 0.5]);
  assert.deepEqual(oneGap, [{ start: 2, len: 5, closed: false }],
    'a single gap leaves one open run that wraps past the end');

  const twoGaps = math.radarRuns([0.2, null, 0.6, null, 1, 0.5]);
  assert.deepEqual(twoGaps, [{ start: 2, len: 1, closed: false }, { start: 4, len: 3, closed: false }],
    'two gaps leave two runs, and neither chords across a missing axis');

  assert.deepEqual(math.radarRuns([null, null, null, null, null, null]), [],
    'nothing answered draws no shape at all');
  assert.deepEqual(math.radarRuns([null, 0.5, null, null, null, null]), [{ start: 1, len: 1, closed: false }],
    'a lone answer is a run of one — a dot, not a polygon');
});

test('radarHit names the axis a pointer is nearest, and nothing beyond the rim', () => {
  const { math } = loadFxCharts();
  const R = 80;
  const up = math.radarPoint(0, 0, R, 0, 6, 1);
  assert.equal(math.radarHit(0, 0, R, 6, up.x, up.y), 0, 'on an axis, that axis');
  const far = math.radarHit(0, 0, R, 6, 0, -(R * 2));
  assert.equal(far, -1, 'well outside the grid is no axis at all');
  assert.equal(math.radarHit(0, 0, R, 6, 0, 0), -1, 'the exact centre favours no axis');
});
