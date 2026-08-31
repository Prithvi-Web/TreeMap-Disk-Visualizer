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

/* ══════════════ momentum: up / down / flat ══════════════ */

test('momentum reads the trend relative to the series own level', () => {
  const { math } = loadFxCharts();
  assert.equal(math.momentum([10, 20, 30, 40, 50, 60]), 'up');
  assert.equal(math.momentum([60, 50, 40, 30, 20, 10]), 'down');
  assert.equal(math.momentum([50, 50, 50, 50, 50, 50]), 'flat');
  assert.equal(math.momentum([100, 101, 100, 100, 101, 100]), 'flat', 'jitter is not a trend');
  assert.equal(math.momentum([1, 100]), 'flat', 'two points are not a trend');
  assert.equal(math.momentum([]), 'flat');
  assert.equal(math.momentum([0, 0, 0, 5, 5, 5]), 'up', 'a rise from zero still reads');
});

/* ══════════════ structural pins: what Node cannot run ══════════════ */

test('every canvas primitive refuses to paint while the document is hidden', () => {
  for (const [name, next] of [
    ['scatter', 'profitLine'], ['profitLine', 'funnel'],
  ] as const) {
    const src = fn(name, next);
    assert.match(src, /if \(life\.dead \|\| document\.hidden\) return;/,
      `${name} render() bails while hidden — the visibilitychange redraw catches up`);
    assert.match(src, /makeLife\(/, `${name} rides the shared lifecycle`);
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
  assert.match(styles, /\.fx-bsq \{[^}]*overflow-x: auto/, 'the strip scrolls instead of crushing at narrow widths');
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
  assert.match(src, /math\.clampBrush\(/, 'the window is clamped by the tested rule');
  assert.match(src, /filter = 'blur\(1\.5px\)'/, 'outside the window the mini strip softens');
  assert.match(src, /setLineDash\(\[4, 4\]\)/, 'band edges and projection use the bklit 4,4 dash');
  assert.match(src, /the sweep is a first-paint event/, 'updates never replay the entrance');
  assert.match(src, /animate\(life, 500, \(p\) => \{\s*yShown = from \+ \(m\.targetTop - from\) \* p;/,
    'the y-domain morphs over ≈500ms');
  assert.match(src, /destination-out/, 'edge fades erase, they never paint an opaque veil over glass');
  assert.match(src, /progress >= 1/, 'the projection terminal ring lands only after the reveal');
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
