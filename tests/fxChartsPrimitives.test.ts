import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * FX: Charts — the bklit primitives round (scatter / funnel / profitLine /
 * barSquares, plus gauge-linear, area brush/band/pattern and the liveLine
 * momentum treatment).
 *
 * The pure geometry lives in FxCharts.math and is exercised here as
 * functions, following tests/fxCharts.test.ts: the section is extracted by
 * its exact banners and evaluated in Node with the app globals stubbed.
 * What cannot run in Node — canvas ink, DOM entrances — is pinned
 * structurally so a refactor cannot silently drop the guards that make
 * these primitives safe (hidden-tab paint refusal, REDUCED snaps, the
 * 15fps live gate, destroy teardowns).
 */

const BANNER = '/* ═══════════════ FX: Charts ═══════════════ */';
const END = '/* ═══ end FX: Charts ═══ */';

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function sectionSource(): string {
  const alt = process.env.FXCHARTS_SRC;
  if (alt && existsSync(alt)) return readFileSync(alt, 'utf8');
  const a = INDEX.indexOf(BANNER);
  assert.notEqual(a, -1, 'FX: Charts is spliced into index.html — a renamed banner must fail, never skip');
  const b = INDEX.indexOf(END, a);
  assert.notEqual(b, -1, 'FX: Charts banner opens but never closes');
  return INDEX.slice(a, b + END.length);
}

const SRC = sectionSource();

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
    const Canvas2D = { setup() { throw new Error('DOM-only'); }, toLocal() { throw new Error('DOM-only'); }, roundRect() { throw new Error('DOM-only'); } };
  `;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${stubs}\n${SRC}\nreturn FxCharts;`)();
}

/** A named slice of the section — for structural pins on one primitive. */
function fn(name: string, next: string): string {
  const a = SRC.indexOf(`function ${name}(`);
  assert.notEqual(a, -1, `function ${name} exists in the kit`);
  const b = SRC.indexOf(`function ${next}(`, a);
  assert.notEqual(b, -1, `function ${next} follows ${name}`);
  return SRC.slice(a, b);
}

/** Every top-level factory declaration in the kit, in source order. */
const FACTORIES = [...SRC.matchAll(/\n {2}function ([A-Za-z_$][\w$]*)\(([^)]*)\)/g)]
  .map((m) => ({ name: m[1], args: m[2], at: m.index! }));

/** One factory's body: from its declaration to whatever declaration follows. */
function factoryBody(name: string): string {
  const i = FACTORIES.findIndex((d) => d.name === name);
  assert.notEqual(i, -1, `factory ${name} is declared in the kit`);
  return SRC.slice(FACTORIES[i].at, FACTORIES[i + 1] ? FACTORIES[i + 1].at : SRC.length);
}

test('the primitives round extends the API without touching the old surface', () => {
  const fx = loadFxCharts();
  for (const k of ['area', 'rings', 'gauge', 'barList', 'liveLine',
    'scatter', 'funnel', 'profitLine', 'barSquares', 'ramp']) {
    assert.equal(typeof fx[k], 'function', `FxCharts.${k} is a function`);
  }
  assert.equal(typeof fx.math, 'object', 'FxCharts.math is the DOM-free core');
  for (const k of ['zeroSplit', 'easeMaster', 'sampleRamp', 'funnelLayout',
    'squareStack', 'clampBrush', 'momentum']) {
    assert.equal(typeof fx.math[k], 'function', `FxCharts.math.${k} is a function`);
  }
});

/* ══════════════ zeroSplit: exact crossings, shared boundaries ══════════════ */

test('zeroSplit cuts a crossing at the exact interpolated zero', () => {
  const { math } = loadFxCharts();
  const runs = math.zeroSplit([{ x: 0, y: -2 }, { x: 4, y: 2 }]);
  assert.equal(runs.length, 2, 'one crossing makes two runs');
  assert.equal(runs[0].sign, -1);
  assert.equal(runs[1].sign, 1);
  // -2 → 2 over x 0..4 crosses zero exactly at x = 2
  const boundary0 = runs[0].points[runs[0].points.length - 1];
  const boundary1 = runs[1].points[0];
  assert.deepEqual(boundary0, { x: 2, y: 0 }, 'the cut lands on the exact zero');
  assert.deepEqual(boundary1, { x: 2, y: 0 }, 'and belongs to BOTH runs — strokes meet with no gap');

  /* A balanced crossing proves nothing: interpolation and a plain midpoint
     give the same answer there, so `t = a.y / (a.y - b.y)` could be a
     hard-coded 0.5. Most real crossings are lopsided — a day that freed a
     little and then grew a lot — and there the colour boundary would land
     on the wrong date. -1 → 3 crosses at a quarter of the way, x = 1. */
  const skew = math.zeroSplit([{ x: 0, y: -1 }, { x: 4, y: 3 }]);
  assert.deepEqual(skew[0].points[skew[0].points.length - 1], { x: 1, y: 0 },
    'the cut is interpolated, not split down the middle');
  assert.deepEqual(skew[1].points[0], { x: 1, y: 0 });
  // …and the cut is not obliged to land on a data-like round number.
  const frac = math.zeroSplit([{ x: 0, y: -1 }, { x: 1, y: 2 }]);
  assert.ok(Math.abs(frac[0].points[frac[0].points.length - 1].x - 1 / 3) < 1e-12,
    'a crossing two thirds of the way up cuts one third of the way across');
});

test('zeroSplit keeps every original point and never invents a crossing', () => {
  const { math } = loadFxCharts();
  const pts = [{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 0.5 }];
  const runs = math.zeroSplit(pts);
  assert.equal(runs.length, 1, 'an all-positive series is a single run');
  assert.equal(runs[0].sign, 1);
  assert.deepEqual(runs[0].points, pts, 'points pass through untouched');
  assert.deepEqual(math.zeroSplit([]), [], 'no data, no runs');
});

test('zeroSplit: a stretch ON zero is its own run; a touch-and-go stays live', () => {
  const { math } = loadFxCharts();
  // plateau on the axis, then a rise
  const plateau = math.zeroSplit([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 3 }]);
  assert.equal(plateau.length, 2);
  assert.equal(plateau[0].sign, 0, 'the flat-on-zero stretch is sign 0');
  assert.equal(plateau[1].sign, 1);
  assert.deepEqual(plateau[1].points[0], { x: 1, y: 0 }, 'the boundary is shared');
  // a single touch of the axis between two positive segments never splits
  const touch = math.zeroSplit([{ x: 0, y: 2 }, { x: 1, y: 0 }, { x: 2, y: 2 }]);
  assert.equal(touch.length, 1, 'touch-and-go keeps one positive run');
  assert.equal(touch[0].sign, 1);
  // sign flip THROUGH a data point on the axis splits there, no interpolation
  const through = math.zeroSplit([{ x: 0, y: 2 }, { x: 1, y: 0 }, { x: 2, y: -2 }]);
  assert.equal(through.length, 2);
  assert.deepEqual(through[0].points[through[0].points.length - 1], { x: 1, y: 0 });
  assert.deepEqual(through[1].points[0], { x: 1, y: 0 });
});

/* ══════════════ easeMaster: cubic-bezier(0.85, 0, 0.15, 1) ══════════════ */

test('easeMaster matches the bklit master curve: pinned ends, symmetric, S-shaped', () => {
  const { math } = loadFxCharts();
  assert.equal(math.easeMaster(0), 0);
  assert.equal(math.easeMaster(1), 1);
  assert.ok(Math.abs(math.easeMaster(0.5) - 0.5) < 1e-4, 'the control points are point-symmetric about the centre');
  assert.ok(math.easeMaster(0.15) < 0.05, 'slow start — the reveal gathers itself');
  assert.ok(math.easeMaster(0.85) > 0.95, 'and lands softly');
  assert.ok(math.easeMaster(0.55) - math.easeMaster(0.45) > 0.1, 'steeper than linear through the middle');
  let prev = -1;
  for (let i = 0; i <= 40; i++) {
    const v = math.easeMaster(i / 40);
    assert.ok(v >= prev - 1e-9, 'monotone: an easing that backtracks would judder');
    prev = v;
  }
  assert.equal(math.easeMaster(-2), 0, 'clamped below');
  assert.equal(math.easeMaster(2), 1, 'clamped above');
});

/* ══════════════ sampleRamp: the continuous blue ramp ══════════════ */

test('sampleRamp anchors the accent family and clamps its input', () => {
  const fx = loadFxCharts();
  const { math } = fx;
  assert.equal(math.sampleRamp(0), '#0A84FF', 'the ramp starts at --accent');
  assert.equal(math.sampleRamp(1), '#B9DBFF', 'and ends at ice blue');
  assert.match(math.sampleRamp(0.5), /^#[0-9A-F]{6}$/, 'midpoints are real hex colors');
  assert.equal(math.sampleRamp(-1), math.sampleRamp(0), 'clamped below');
  assert.equal(math.sampleRamp(2), math.sampleRamp(1), 'clamped above');
  assert.equal(math.sampleRamp(NaN), math.sampleRamp(0), 'a broken t reads as the anchor, never a broken hex');
  // the discrete ramp and the continuous one agree at the anchors
  assert.equal(math.sampleRamp(0), (fx.ramp(4) as string[])[0]);
  assert.equal(math.sampleRamp(1), (fx.ramp(4) as string[])[3]);
  assert.equal(math.sampleRamp(0.5, ['#000000', '#FFFFFF']), '#808080', 'custom stops interpolate');
});

/* ══════════════ funnelLayout: sized against the first stage ══════════════ */

test('funnelLayout reads conversion against the first stage, honestly', () => {
  const { math } = loadFxCharts();
  const l = math.funnelLayout([200, 120, 30]);
  assert.deepEqual(l.map((s: any) => s.frac), [1, 0.6, 0.15]);
  assert.deepEqual(l.map((s: any) => s.pct), [100, 60, 15]);
  // a later stage larger than the first: geometry clamps, the number does not
  const over = math.funnelLayout([100, 150]);
  assert.equal(over[1].frac, 1, 'the segment cannot burst its track');
  assert.equal(over[1].pct, 150, 'but the badge tells the truth');
  for (const s of math.funnelLayout([0, 50])) {
    assert.equal(s.frac, 0, 'a zero first stage yields zeros, never NaN');
    assert.equal(s.pct, 0);
  }
  assert.deepEqual(math.funnelLayout([]), []);
  assert.equal(math.funnelLayout([-5, 10])[0].frac, 0, 'negative values read as empty');
});

/* ══════════════ squareStack: discrete honesty ══════════════ */

test('squareStack: zero stays dark, any value lights one, the max fills exactly', () => {
  const { math } = loadFxCharts();
  assert.equal(math.squareStack(0, 100, 8), 0);
  assert.equal(math.squareStack(100, 100, 8), 8);
  assert.equal(math.squareStack(1, 100, 8), 1, 'a real value is never invisible');
  assert.equal(math.squareStack(50, 100, 8), 4);
  assert.equal(math.squareStack(10, 0, 8), 0, 'a zero max cannot divide');
  assert.equal(math.squareStack(10, 100, 0), 0, 'zero rows, zero squares');
  let prev = 0;
  for (let v = 0; v <= 100; v += 5) {
    const lit = math.squareStack(v, 100, 8);
    assert.ok(lit >= prev, 'monotone in value');
    prev = lit;
  }
});

/* ══════════════ clampBrush: the zoom window's contract ══════════════ */

test('clampBrush orders, slides against edges, and holds the minimum span', () => {
  const { math } = loadFxCharts();
  assert.deepEqual(math.clampBrush(8, 2, 0, 10), [2, 8], 'reversed input is righted');
  assert.deepEqual(math.clampBrush(-5, 1, 0, 10, 0), [0, 6], 'sliding past the left edge keeps the span');
  assert.deepEqual(math.clampBrush(7, 13, 0, 10, 0), [4, 10], 'and past the right edge');
  const tiny = math.clampBrush(5, 5.01, 0, 10, 2);
  assert.ok(Math.abs((tiny[1] - tiny[0]) - 2) < 1e-9, 'a pinch below minSpan grows to minSpan');
  assert.deepEqual(math.clampBrush(-5, 20, 0, 10, 0), [0, 10], 'wider than the domain becomes the domain');
});

/* ══════════════ brushDrag: pixel → time, translate, minimum span ══════════════ */

/**
 * clampBrush was tested thoroughly and the drag that FEEDS it was not: the
 * pixel→time inversion, the mid-drag translation and the floor a click with
 * no travel lands on all lived inside area()'s applyDrag, where the only pin
 * was the string `math.clampBrush(`. Three separate one-word breakages
 * survived the whole suite. The rule is now a function of times and pixels,
 * so it is tested here beside the clamp it calls.
 */
const PLOT = { padL: 40, padR: 20, width: 260 };   // 200px of plot, x 40 → 240
const DOMAIN = { t0: 0, t1: 1000 };
/** A model whose FULL scale spans 0–1000 and whose ZOOMED scale spans 400–600. */
function brushModel() {
  return {
    ...DOMAIN,
    XFull: { from: (px: number) => ((px - 40) / 200) * 1000 },
    X: { from: (px: number) => 400 + ((px - 40) / 200) * 200 },
  };
}

test('brushDrag inverts pixels through the FULL domain, never the zoomed one', () => {
  const { math } = loadFxCharts();
  const m = brushModel();
  // Mid-strip: the full scale reads 500, the zoomed scale reads 500 too —
  // so the probe is taken at a quarter, where the two disagree (250 vs 450).
  const drag = { mode: 'e', cur: [0, 0], anchor: 0, grabT: 0 };
  assert.deepEqual(math.brushDrag(drag, 90, PLOT, m), [0, 250],
    'a strip pixel means the same instant whether or not a zoom is applied');
  // The zoomed scale would have said 450 — a handle that runs away from the
  // pointer the moment the user zooms in.
  assert.notDeepEqual(math.brushDrag(drag, 90, PLOT, m), [0, 450]);
  // Pixels outside the plot clamp to its edges rather than running off-domain.
  assert.deepEqual(math.brushDrag(drag, -400, PLOT, m), [0, 20], 'left of the plot is the domain start (held to the floor)');
  assert.deepEqual(math.brushDrag(drag, 9999, PLOT, m), [0, 1000], 'right of the plot is the domain end');
});

test('brushDrag translates a grabbed window — dragging the middle never stretches an edge', () => {
  const { math } = loadFxCharts();
  const m = brushModel();
  // Grabbed at t=500 (x 140) with a 200-wide window; the pointer moves +100.
  const drag = { mode: 'mid', cur: [400, 600], anchor: 600, grabT: 500 };
  const moved = math.brushDrag(drag, 160, PLOT, m);
  assert.deepEqual(moved, [500, 700], 'both edges travel together');
  assert.equal(moved[1] - moved[0], 200, 'and the span the user grabbed is exactly preserved');
  const back = math.brushDrag(drag, 120, PLOT, m);
  assert.deepEqual(back, [300, 500], 'dragging the other way translates the other way');
  // Against an edge the window slides, it does not compress.
  const atEdge = math.brushDrag(drag, -999, PLOT, m);
  assert.deepEqual(atEdge, [0, 200], 'shoved past the start it parks against it, span intact');
});

test('brushDrag holds a 2% floor — a press with no travel is a window, not a collapse', () => {
  const { math } = loadFxCharts();
  const m = brushModel();
  assert.equal(math.BRUSH_MIN_FRAC, 0.02, 'the floor is a named share of the domain');
  // onDown seeds anchor === the pressed time; a click that never moves ends
  // here, and a zero-width window would blank the chart.
  const drag = { mode: 'e', cur: [500, 500], anchor: 500, grabT: 500 };
  const nudged = math.brushDrag(drag, 140, PLOT, m);
  assert.ok(nudged[1] - nudged[0] > 0, 'the window has real width');
  assert.ok(Math.abs((nudged[1] - nudged[0]) - 20) < 1e-9, '2% of a 1000-wide domain');
  // A drag wider than the floor is left alone.
  const wide = math.brushDrag(drag, 190, PLOT, m);
  assert.deepEqual(wide, [500, 750], 'a real drag is not widened to anything');
});

/* ══════════════ momentum: up / down / flat ══════════════ */

test('momentum reads the trend relative to the series own level', () => {
  const { math } = loadFxCharts();
  assert.equal(math.momentum([10, 20, 30, 40, 50, 60]), 'up');
  assert.equal(math.momentum([60, 50, 40, 30, 20, 10]), 'down');
  assert.equal(math.momentum([50, 50, 50, 50, 50, 50]), 'flat');
  assert.equal(math.momentum([1, 100]), 'flat', 'two points are not a trend');
  assert.equal(math.momentum([]), 'flat');
  assert.equal(math.momentum([0, 0, 0, 5, 5, 5]), 'up', 'a rise from zero still reads');

  /* "Relative to the series own level" is the whole claim, and a symmetric
     jitter case cannot test it: with equal head and tail means the delta is
     zero under any scale at all. These drift by ~1% of their own level —
     flat to a reader, but a landslide to an absolute yardstick. liveLine
     feeds this |bytes delta| per tick, in the millions, so an absolute
     scale would flip the sparkline up/down on essentially every tick. */
  assert.equal(math.momentum([100, 101, 100, 100, 101, 102]), 'flat', 'jitter is not a trend');
  assert.equal(math.momentum([1e6, 1.01e6, 1e6, 1e6, 1.01e6, 1.02e6]), 'flat',
    'and the same shape in the millions is the same non-trend');
  // Scale invariance both ways: one relative shape, three magnitudes.
  for (const unit of [1, 1e3, 1e9]) {
    assert.equal(math.momentum([1, 1.2, 1, 1, 1.2, 1.4].map((v) => v * unit)), 'up',
      `a ~20% rise reads as a rise at scale ${unit}`);
    assert.equal(math.momentum([1.4, 1.2, 1, 1, 1.2, 1].map((v) => v * unit)), 'down',
      `and the mirror reads as a fall at scale ${unit}`);
  }
});

/* ══════════════ structural pins: what Node cannot run ══════════════ */

/**
 * The list is DERIVED, not written down: every factory whose first parameter
 * is `canvas` paints ink, and ink in a hidden tab is work nobody sees (the
 * visibilitychange redraw catches up). A seventh canvas primitive added
 * later inherits this test without anyone remembering to extend it — which
 * is the whole point, because four of the six were uncovered when the loop
 * was a hand-written pair and each could lose its guard with the suite green.
 */
const CANVAS_PRIMITIVES = FACTORIES.filter((d) => /^canvas\b/.test(d.args)).map((d) => d.name);

test('every canvas primitive refuses to paint while the document is hidden', () => {
  const fx = loadFxCharts();
  // Guard the derivation itself: a rename that emptied this list would make
  // the loop below pass by having nothing to check.
  for (const known of ['area', 'rings', 'gauge', 'liveLine', 'scatter', 'profitLine']) {
    assert.ok(CANVAS_PRIMITIVES.includes(known), `${known} is one of the canvas primitives`);
  }
  assert.equal(CANVAS_PRIMITIVES.length, 6,
    `six canvas primitives (saw: ${CANVAS_PRIMITIVES.join(', ')}) — a new one must carry the guard too`);
  for (const name of CANVAS_PRIMITIVES) {
    assert.equal(typeof fx[name], 'function', `${name} is exported`);
    const src = factoryBody(name);
    assert.match(src, /if \(life\.dead \|\| document\.hidden\) return;/,
      `${name} render() bails while hidden — the visibilitychange redraw catches up`);
    assert.match(src, /makeLife\(/, `${name} rides the shared lifecycle`);
  }
  // makeLife's ResizeObserver is the seventh paint door: a hidden tab still
  // fires resize observations, and each one would repaint for nobody.
  assert.match(fn('makeLife', 'animate'), /if \(life\.dead \|\| document\.hidden\) return;/,
    'the shared resize observer refuses the same way');
});

test('the hover primitives release their tooltip and coalescer on destroy', () => {
  for (const [name, next] of [
    ['scatter', 'profitLine'], ['profitLine', 'funnel'],
  ] as const) {
    const src = fn(name, next);
    assert.match(src, /REDUCED \? 1 : 0/, `${name} renders complete under reduced motion`);
    assert.match(src, /tip\.destroy\(\)/, `${name} destroy() releases its tooltip`);
    assert.match(src, /cancelAnimationFrame\(moveRaf\)/, `${name} destroy() releases the hover coalescer`);
  }
});

test('scatter carries the offset-ring signature and the master reveal', () => {
  const src = fn('scatter', 'profitLine');
  assert.match(src, /R_CORE = 5, RING_GAP = 2, RING_W = 2/, 'r5 core, 2px gap, 2px ring — the bklit geometry');
  assert.match(src, /R_CORE \+ RING_GAP \+ RING_W \/ 2/, 'the ring is held OFF the core by the gap');
  assert.match(src, /filter = 'blur\(2px\)'/, 'inactive dots blur while one is hovered');
  assert.match(src, /1100, \(p\) => \{ progress = p; render\(\); \}, math\.easeMaster/,
    'the ~1100ms master-eased reveal');
});

test('scatter log axes ride the tested math, and crowding shrinks the dots', () => {
  const src = fn('scatter', 'profitLine');
  assert.match(src, /math\.logTicks\(/, 'log axes tick by decades from the tested rule');
  assert.match(src, /math\.scaleLog\(/, 'the log10(v+1) mapping is the tested one');
  assert.match(src, /math\.densityScale\(/, 'dot size answers to the tested crowding rule');
  assert.match(src, /s\.formatXTick \|\| math\.compactCount/, 'decade labels read 10 / 100 / 1k');
  assert.match(src, /m\.yLog\s*\? Math\.log10\(/,
    'a log y-axis samples the color ramp in log space too');
  // The apps scatter is the caller that needed this: both axes log, byte
  // decades on y so the tick labels format exactly.
  const wiring = INDEX.slice(INDEX.indexOf('async function loadAppsScatter'), INDEX.indexOf('async function loadDuplicates'));
  assert.ok(wiring.length > 200, 'the apps-scatter wiring slice is non-empty');
  assert.match(wiring, /logX: 10, logY: 1024/, 'size-vs-count runs log/log with byte-decade y ticks');
  // Both domains read their cap off the tick list, and logTicks now tops out
  // at the data — so neither axis can go back to claiming a ceiling (a 1 TB
  // y-axis over a 17 GB largest app) that nothing in the data reaches.
  assert.match(src, /const top = ticks\[ticks\.length - 1\]/, 'the y domain is the top tick');
  assert.match(src, /math\.scaleLog\(xTicks\[xTicks\.length - 1\]/, 'and so is the x domain');
});

test('profitLine splits by sign, emphasizes the zero row, and answers sign-aware', () => {
  const src = fn('profitLine', 'funnel');
  assert.match(src, /math\.zeroSplit\(/, 'the runs come from the tested splitter');
  assert.match(src, /--fx-neg/, 'the negative tone is a token, re-tuned by the light theme');
  assert.match(src, /alpha\(tone\('--text-1'[^)]*\), 0\.35\)/, 'the zero row is solid foreground at 0.35');
  assert.match(src, /lineWidth = 2\.5/, 'bklit profit stroke weight');
  assert.match(src, /negName \|\| 'Freed'/, 'the tooltip names the sign');
});

test('funnel: halo rings, staggered entrance, percent badge, honest zero stages', () => {
  const src = fn('funnel', 'barSquares');
  assert.match(src, /0 0 0 2px rgba[\s\S]*?0 0 0 4px rgba[\s\S]*?0 0 0 6px rgba/,
    'three concentric halo rings via box-shadow spread');
  assert.match(src, /\(i \* 120\) \+ 'ms'/, 'the 0.12s per-stage stagger');
  assert.match(src, /!entered && !REDUCED && !document\.hidden/,
    'the entrance runs once, never under REDUCED or in a hidden tab');
  assert.match(src, /fx-fun-zero/, 'a zero stage renders as a hairline, not a faked sliver');
  assert.match(src, /math\.funnelLayout\(/, 'geometry comes from the tested layout');
  const styles = INDEX.slice(INDEX.indexOf('FX: Charts — styles'), INDEX.indexOf('end FX: Charts — styles'));
  assert.match(styles, /\.fx-funnel \{ display: flex; gap: 4px/, 'the 4px stage gap');
  assert.match(styles, /\.fx-funnel:hover \.fx-fun-stage:not\(:hover\) \{ opacity: 0\.5/, 'hover dims the others');
  assert.match(styles, /\.fx-fun-pct[^}]*var\(--accent-soft\)/, 'the percent badge is accent-tinted via tokens');
});

test('barSquares: 3px gaps, 0.25 corners, ghost-square track, upward cascade', () => {
  const src = SRC.slice(SRC.indexOf('function barSquares('), SRC.indexOf('return { area, rings'));
  assert.match(src, /GAP = 3, CORNER = 0\.25/, 'the bklit square geometry');
  assert.match(src, /fx-bsq-ghost/, 'unfilled capacity stays visible as the ghost track');
  assert.match(src, /math\.squareStack\(/, 'the lit count comes from the tested rule');
  assert.match(src, /ci \* 60 \+ r \* 35/, 'the cascade staggers by column and row');
  assert.match(src, /!entered && !REDUCED && !document\.hidden/, 'one entrance, REDUCED- and hidden-safe');
  const styles = INDEX.slice(INDEX.indexOf('FX: Charts — styles'), INDEX.indexOf('end FX: Charts — styles'));
  assert.match(styles, /\.fx-bsq-track \{[^}]*overflow-x: auto/, 'the strip scrolls instead of crushing at narrow widths');
});

/**
 * barSquares is the only primitive that hovers a SCROLLING strip. `.fx-tip` is
 * `position: absolute` against the element makeTip was handed, so if that
 * element is the scroller the tip is laid out in content coordinates and
 * drifts by scrollLeft — and makeTip's edge flip, which measures the visible
 * `clientWidth`, flips against the wrong box. Scrolling one level in keeps the
 * anchor and the flip in the same coordinate space as the rects they read.
 */
test('barSquares hovers a scroller without hosting its tooltip inside it', () => {
  const src = SRC.slice(SRC.indexOf('function barSquares('), SRC.indexOf('return { area, rings'));
  assert.match(src, /const tip = makeTip\(el\)/, 'the tooltip anchors to the outer, non-scrolling box');
  assert.match(src, /fx-bsq-track/, 'the columns live in an inner scroller');
  assert.match(src, /track\.appendChild\(col\)|track\.append/, 'columns are appended to the track, not the tip host');
  const styles = INDEX.slice(INDEX.indexOf('FX: Charts — styles'), INDEX.indexOf('end FX: Charts — styles'));
  const outer = styles.match(/\.fx-bsq \{[^}]*\}/);
  assert.ok(outer, '.fx-bsq rule exists');
  assert.ok(!/overflow-x/.test(outer![0]), 'the tooltip host itself never scrolls');
  assert.match(outer![0], /position:\s*relative/, 'and it is the positioned box the tip measures against');
});

/**
 * The legend bars grow from zero. That is an ENTRANCE, and an entrance replayed
 * on an in-place update animates a change that did not happen: `rings.update()`
 * runs `renderLegend()` unconditionally, and the theme handler calls
 * `donutHandle.update({})` with identical data, so every theme flip slid all
 * eight bars out from zero again while the ring itself correctly held still.
 * funnel and barSquares already latch this; rings was the one that did not.
 */
test('rings replays its entrance once, and an update never lands on a stale hover value', () => {
  const src = fn('rings', 'gauge');
  assert.match(src, /entered = true/, 'the legend latches its entrance like funnel and barSquares');
  assert.match(src, /if \(REDUCED \|\| entered\) bar\.style\.width = widthPct;/,
    'an update sets the widths outright instead of re-kicking the grow');
  // setHover starts a 220ms rAF that writes centerShown every frame. update()
  // reseeds centerShown to the new total — but the surviving animation
  // immediately overwrites it with the OLD slice's captured target, leaving
  // the donut centre showing a slice's bytes under the "Top types" label.
  // area.tweenY() and gauge.ease() both stop the raf first; rings must too.
  const at = src.indexOf('update(next) {');
  assert.notEqual(at, -1, 'rings exposes update(next)');
  const upd = src.slice(at, src.indexOf('renderLegend();', at));
  assert.ok(upd.includes('life.stopRaf();'), 'update stops an in-flight hover animation');
  assert.ok(upd.indexOf('life.stopRaf();') < upd.indexOf('centerShown = null'),
    'and it stops BEFORE the reseed, or the surviving frame overwrites it with the old slice’s value');
});

/**
 * `when ? '' : when` is falsy in both branches, so the documented fallback —
 * "the panel states the date when the pill cannot" — could never run.
 */
test('area names the crosshair time in the panel exactly when the pill cannot', () => {
  const src = fn('area', 'rings');
  assert.ok(!/tip\.show\(when \? '' : when,/.test(src), 'the degenerate ternary is gone');
  assert.match(src, /tip\.show\(when \? '' : fxDate\(hoverT\), rows/,
    'no pill means the panel carries the timestamp, from the kit’s own default formatter');
});

/**
 * Every other colour in the kit is a theme token read through tone(). The
 * capsule's over-85% amber was a raw #FF9F0A passed in from the call site, so
 * it painted the same hue in both themes: ~1.9:1 against a light card, under
 * the 3:1 floor for a non-text indicator, over a 36-notch 14px track. --warn
 * carries a light override for exactly this reason.
 */
test('gauge reads its warn tone from the token system, like danger', () => {
  const src = fn('gauge', 'barList');
  assert.match(src, /s\.danger \? tone\('--danger', '#FF453A'\) : s\.warn \? tone\('--warn'/,
    'warn is a flag resolved through tone() at render time, so a theme flip re-reads it');
  const capsule = INDEX.slice(INDEX.indexOf("$('capsuleGauge').hidden = false"), INDEX.indexOf('capsuleGaugeHandle.update(spec)'));
  assert.match(capsule, /warn: pct > 85/, 'the capsule call site names the intent, not a hue');
  assert.ok(!/#FF9F0A/.test(capsule), 'and no raw hex survives the call site');
  assert.match(INDEX, /--warn:\s*#B36B00/, 'the light override that makes this legible still exists');
});

test('gauge grows a linear orientation without moving the arc call sites', () => {
  const src = fn('gauge', 'barList');
  assert.match(src, /if \(s\.orientation === 'linear'\) \{ renderLinear\(\); return; \}/,
    'linear is an explicit opt-in branch');
  assert.match(src, /s\.linearHeight \|\| 24/, 'linearHeight defaults to 24');
  assert.match(src, /notchCornerRadius/, 'notch rounding is honored');
  const gradientUses = src.match(/s\.activeGradient \|\| \['#0A84FF', '#86C1FF'\]/g) || [];
  assert.equal(gradientUses.length, 2, 'both orientations interpolate the activeGradient pair per notch');
});

test('area: brush, reference band, pattern and the y-morph keep their contracts', () => {
  const src = fn('area', 'rings');
  assert.match(src, /'dblclick', onDblClick/, 'double-click resets the zoom');
  assert.match(src, /win = null; \/\/ double-click resets the zoom/, 'to the full domain');
  assert.match(src, /math\.clampBrush\(win\[0\], win\[1\]/, 'an incoming window is clamped by the tested rule');
  assert.match(src, /win = math\.brushDrag\(drag, x, f, m\);/,
    'and a drag produces its window through the tested rule too — pixel inversion, translation and the floor all live there');
  assert.match(src, /filter = 'blur\(1\.5px\)'/, 'outside the window the mini strip softens');
  assert.match(src, /setLineDash\(\[4, 4\]\)/, 'band edges and projection use the bklit 4,4 dash');
  assert.match(src, /the sweep is a first-paint event/, 'updates never replay the entrance');
  assert.match(src, /animate\(life, 500, \(p\) => \{\s*yShown = from \+ \(m\.targetTop - from\) \* p;/,
    'the y-domain morphs over ≈500ms');
  assert.match(src, /destination-out/, 'edge fades erase, they never paint an opaque veil over glass');
  assert.match(src, /progress >= 1/, 'the projection terminal ring lands only after the reveal');
});

test('the idle brush reads as "everything selected", never an empty box', () => {
  const src = fn('area', 'rings');
  const brush = src.slice(src.indexOf('function drawBrush('), src.indexOf('function render('));
  assert.ok(brush.length > 400, 'the drawBrush slice is non-empty');
  assert.match(brush, /const idle = !win \|\| \(wt0 <= m\.t0 && wt1 >= m\.t1\)/,
    'a window spanning everything IS the idle state');
  assert.match(brush, /if \(idle\) \{\s*mini\(ctx\); \/\/ sharp everywhere/,
    'idle draws the mini-chart sharp — nothing dims, because nothing is excluded');
  const active = brush.slice(brush.indexOf('} else {'));
  assert.match(active, /filter = 'blur\(1\.5px\)'/, 'only a real sub-range blurs the outside');
  assert.match(active, /alpha\(accent, 0\.07\)/, 'and raises the accent window over the selection');
  assert.match(brush, /idle \? math\.alpha\(accent, 0\.35\) : accent/,
    'the end handles rest quietly while everything is selected');
  assert.match(brush, /if \(m\.proj\) \{[\s\S]*?setLineDash\(\[4, 4\]\)/,
    'the dashed forecast fills the domain the strip claims to show');
});

test('liveLine: momentum tones ride tokens and the 15fps gate survives', () => {
  const src = fn('liveLine', 'scatter');
  assert.match(src, /math\.momentum\(/, 'the trend comes from the tested reader');
  assert.match(src, /--fx-live-up/, 'up tone is a token');
  assert.match(src, /--fx-live-down/, 'down tone is a token');
  assert.match(src, /ts - lastDraw >= 66/, 'the 15fps gate is untouched');
  assert.match(src, /w - padR - lead/, 'the leading gap holds the tip off the right edge');
  assert.match(src, /Canvas2D\.roundRect\(ctx, bx, by, bw, bh, 8\)/, 'the tip value rides in a pill badge');
});

test('the momentum tokens exist in both themes, inside the charts style banner', () => {
  const styles = INDEX.slice(INDEX.indexOf('FX: Charts — styles'), INDEX.indexOf('end FX: Charts — styles'));
  assert.match(styles, /:root \{\s*--fx-neg: #5E7FA6;\s*--fx-live-up: #4DA3FF;\s*--fx-live-down: #5E7FA6;\s*\}/,
    'dark defaults');
  assert.match(styles, /:root\[data-theme="light"\] \{\s*--fx-neg: #46617F;\s*--fx-live-up: #0069D6;\s*--fx-live-down: #46617F;\s*\}/,
    'light re-tunes the same tokens');
  assert.match(styles, /\.fx-fun-stage,\s*\.fx-fun-seg,\s*\.fx-bsq-col,\s*\.fx-bsq-sq \{ transition: none; \}/,
    'reduced motion silences the new transitions too');
});
