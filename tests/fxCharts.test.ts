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
    'ramp', 'lerpColor', 'arcLayout', 'polar', 'linreg', 'extent']) {
    assert.equal(typeof fx.math[k], 'function', `FxCharts.math.${k} is a function`);
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
