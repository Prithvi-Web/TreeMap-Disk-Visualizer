import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * FX: Border Beam — the pure logic of the FxBeam splice section, extracted
 * from public/index.html between its exact banner comments and evaluated in
 * Node (the commandPalette extraction precedent). Behaviour under test:
 *
 *  - the shared pulse oscillator (port of pulseDriver.ts): deterministic,
 *    cyclic, honors CSS animation-delay semantics;
 *  - the palette tables: right shapes, and every stop re-tuned into the
 *    blue/black --accent family (no ported colorful/sunset warm colors);
 *  - opts validation: defaults, clamps, and loud failure on unknown types;
 *  - the CSS generator: balanced, clean output for all 5 types × 2 themes,
 *    and genuinely animation-free under reduced motion.
 *
 * The section is permanently spliced, so a missing banner is a broken build:
 * it fails loudly here instead of silently disarming the whole file (the
 * skip-if-not-spliced affordance outlived the splice it waited for).
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const START_BANNER = '/* ═══════════════ FX: Border Beam ═══════════════';
const END_BANNER = '/* ═══ end FX: Border Beam ═══ */';

function extractSection(): string {
  const start = INDEX.indexOf(START_BANNER);
  assert.notEqual(start, -1, 'FX: Border Beam is spliced into index.html — a renamed banner must fail, never skip');
  const end = INDEX.indexOf(END_BANNER, start);
  assert.notEqual(end, -1, 'the section has its end banner');
  return INDEX.slice(start, end + END_BANNER.length);
}

interface Osc { prop: string; a: number; b: number; period: number; delay: number; unit: string }
interface PaletteEntry { rgb: string; [k: string]: unknown }
interface Internals {
  TYPES: string[];
  PALETTE: {
    border: PaletteEntry[];
    small: PaletteEntry[];
    smallInnerAlphas: number[];
    line: { dark: PaletteEntry[]; light: PaletteEntry[] };
    lineInner: { a: number; w: number; h: number; dx: number; dy: number }[];
    lineSpikes: { dark: PaletteEntry[]; light: PaletteEntry[] };
    lineEdgeSpike: { dark: { p: string; s: string }; light: { p: string; s: string } };
  };
  PULSE_RING_MAP: unknown[];
  PULSE_INNER_SIZES: unknown[];
  PULSE_INNER_BLOOM: unknown[];
  PULSE_OUTER_CORE: unknown[];
  PULSE_OUTER_BLOOM: unknown[];
  pingPong: (phase: number) => number;
  oscValue: (osc: Osc, tSec: number) => number;
  hueValue: (range: number, period: number, tSec: number) => number;
  pulseParams: (type: string, theme: string, duration: number) => Record<string, number>;
  oscillatorDefs: (id: string, p: Record<string, number>) => Osc[];
  normalizeOpts: (opts?: unknown) => {
    type: string; active: boolean; duration: number; strength: number;
    opacity?: number; brightness?: number; saturation?: number; hueRange?: number;
    staticColors?: boolean; borderRadius?: number;
    onActivate?: (el: unknown) => void; onDeactivate?: (el: unknown) => void;
  };
  buildCSS: (id: string, type: string, theme: string, duration: number, radius: number, reduced: boolean,
    knobs?: { hueRange?: number; staticColors?: boolean }) => string;
}

const section = extractSection();

/** The section is a plain `const FxBeam = (() => {...})()` block: everything
 *  DOM-touching is lazy (first attach), so pure internals need no stubs. */
function instantiate(): Internals {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function('REDUCED', `'use strict';\n${section}\nreturn FxBeam;`);
  const beam = factory(false) as { _internals: Internals };
  return beam._internals;
}

/* ══════════════════ Oscillator math, as behaviour ══════════════════ */

test('pulse oscillator: pingPong is a cosine ease with exact endpoints', () => {
  const I = instantiate();
  assert.ok(Math.abs(I.pingPong(0)) < 1e-12, 'phase 0 → 0');
  assert.ok(Math.abs(I.pingPong(1)) < 1e-12, 'phase 1 → 0');
  assert.ok(Math.abs(I.pingPong(0.5) - 1) < 1e-12, 'phase 0.5 → 1');
  assert.ok(Math.abs(I.pingPong(0.25) - 0.5) < 1e-12, 'phase 0.25 → exactly half');
});

test('pulse oscillator: oscValue is deterministic, delay-shifted and period-cyclic', () => {
  const I = instantiate();
  const osc: Osc = { prop: '--x', a: 2, b: 6, period: 4, delay: 1, unit: '' };
  assert.equal(I.oscValue(osc, 3.7), I.oscValue(osc, 3.7), 'same input, same value — twice');
  assert.ok(Math.abs(I.oscValue(osc, 1) - 2) < 1e-9, 'at t = delay the oscillator sits at a');
  assert.ok(Math.abs(I.oscValue(osc, 3) - 6) < 1e-9, 'half a period later it peaks at b');
  assert.ok(Math.abs(I.oscValue(osc, 10.3) - I.oscValue(osc, 14.3)) < 1e-9, 'one full period returns the same value');
});

test('hue drift ping-pongs inside ±range — never the original 360° rainbow', () => {
  const I = instantiate();
  for (let t = 0; t < 40; t += 0.37) {
    const v = I.hueValue(14, 16, t);
    assert.ok(v >= -14 - 1e-9 && v <= 14 + 1e-9, `t=${t} stays within ±14deg`);
  }
  assert.ok(Math.abs(I.hueValue(14, 16, 0) + 14) < 1e-9, 'starts at -range');
  assert.ok(Math.abs(I.hueValue(14, 16, 8) - 14) < 1e-9, 'peaks at +range mid-period');
});

test('pulseParams scale linearly with duration and stay theme-tuned', () => {
  const I = instantiate();
  const p1 = I.pulseParams('pulse-inner', 'dark', 2.3);
  const p2 = I.pulseParams('pulse-inner', 'dark', 4.6);
  assert.ok(Math.abs(p2.bs - p1.bs * 2) < 1e-9, 'breathe speed doubles with duration');
  assert.ok(Math.abs(p2.ss - p1.ss * 2) < 1e-9, 'size speed doubles with duration');
  assert.notDeepEqual(I.pulseParams('pulse-inner', 'dark', 2.3), I.pulseParams('pulse-inner', 'light', 2.3), 'themes differ');
  assert.equal(I.pulseParams('pulse-outside', 'light', 2.3).op, 0, 'the ported light pulse-outside quadrant amplitude');
});

test('an instance gets 17 desynced oscillators with px units only on drift', () => {
  const I = instantiate();
  const defs = I.oscillatorDefs('t1', I.pulseParams('pulse-inner', 'dark', 2.3));
  assert.equal(defs.length, 17, 'the original table: 3 size regions × 4 + gh + 4 quadrants');
  for (const d of defs) {
    assert.ok(d.prop.startsWith('--fxb-') && d.prop.endsWith('-t1'), `${d.prop} is namespaced per-instance`);
    assert.ok(Number.isFinite(d.a) && Number.isFinite(d.b) && d.period > 0, `${d.prop} is well-formed`);
    if (d.unit === 'px') assert.match(d.prop, /--fxb-b[xy]\d-/, 'px only on the drift vars');
    else assert.equal(d.unit, '', 'everything else is unitless');
  }
  assert.equal(defs.filter((d) => d.delay > 0).length, 3, 'tr/bl/br quadrants carry desync delays');
});

/* ══════════════════ Palette tables, structurally ══════════════════ */

test('palette tables keep the original shapes (9/8/9/9/5 and pulse geometry)', () => {
  const I = instantiate();
  assert.equal(I.PALETTE.border.length, 9, 'md ring: 9 blobs');
  assert.equal(I.PALETTE.small.length, 8, 'sm ring: 8 blobs');
  assert.equal(I.PALETTE.smallInnerAlphas.length, 8, 'sm inner alpha ladder matches');
  assert.equal(I.PALETTE.line.dark.length, 9, 'line dark: 9 blobs');
  assert.equal(I.PALETTE.line.light.length, 9, 'line light: 9 blobs');
  assert.equal(I.PALETTE.lineInner.length, 9, 'line inner layer: 9 blobs');
  assert.equal(I.PALETTE.lineSpikes.dark.length, 5, '5 bloom spikes (dark)');
  assert.equal(I.PALETTE.lineSpikes.light.length, 5, '5 bloom spikes (light)');
  assert.equal(I.PULSE_RING_MAP.length, 9, 'pulse ring map covers all 9 blobs');
  assert.equal(I.PULSE_INNER_SIZES.length, 9, 'pulse inner sizes cover all 9');
  assert.equal(I.PULSE_INNER_BLOOM.length, 7, 'inner bloom: 7 of 9');
  assert.equal(I.PULSE_OUTER_CORE.length, 8, 'outer core: 8 edge blobs');
  assert.equal(I.PULSE_OUTER_BLOOM.length, 7, 'outer bloom: 7 halo blobs');
});

test('every palette stop is in the blue family — colorful/sunset stayed behind', () => {
  const I = instantiate();
  const rgbs: string[] = [
    ...I.PALETTE.border.map((c) => c.rgb),
    ...I.PALETTE.small.map((c) => c.rgb),
    ...I.PALETTE.line.dark.map((c) => c.rgb),
    ...I.PALETTE.line.light.map((c) => c.rgb),
    ...I.PALETTE.lineSpikes.dark.map((c) => c.rgb),
    ...I.PALETTE.lineSpikes.light.map((c) => c.rgb),
    I.PALETTE.lineEdgeSpike.dark.p, I.PALETTE.lineEdgeSpike.dark.s,
    I.PALETTE.lineEdgeSpike.light.p, I.PALETTE.lineEdgeSpike.light.s,
  ];
  assert.ok(rgbs.length >= 40, 'a real palette, not a token one');
  for (const rgb of rgbs) {
    const parts = rgb.split(',').map((n) => parseInt(n, 10));
    assert.equal(parts.length, 3, `${rgb} is an r, g, b triplet`);
    const [r, g, b] = parts;
    assert.ok([r, g, b].every((n) => Number.isFinite(n) && n >= 0 && n <= 255), `${rgb} in range`);
    assert.ok(b > r && b >= g, `rgb(${rgb}) is blue-dominant`);
  }
});

/* ══════════════════ Opts validation ══════════════════ */

test('normalizeOpts: documented defaults, per-type durations', () => {
  const I = instantiate();
  assert.deepEqual(I.normalizeOpts(), { type: 'md', active: true, duration: 1.96, strength: 1 });
  assert.equal(I.normalizeOpts({ type: 'sm' }).duration, 1.96, 'rotate family default');
  assert.equal(I.normalizeOpts({ type: 'line' }).duration, 3.1, 'line default');
  assert.equal(I.normalizeOpts({ type: 'pulse-inner' }).duration, 2.3, 'pulse default');
  assert.equal(I.normalizeOpts({ type: 'pulse-outside' }).duration, 2.3, 'pulse default');
});

test('normalizeOpts: clamps strength, repairs duration, rejects unknown types loudly', () => {
  const I = instantiate();
  assert.equal(I.normalizeOpts({ strength: 7 }).strength, 1, 'strength caps at 1');
  assert.equal(I.normalizeOpts({ strength: -2 }).strength, 0, 'and floors at 0');
  assert.equal(I.normalizeOpts({ strength: 0.4 }).strength, 0.4, 'in-range passes through');
  assert.equal(I.normalizeOpts({ duration: -3 }).duration, 1.96, 'nonsense duration falls back');
  assert.equal(I.normalizeOpts({ duration: 'fast' }).duration, 1.96, 'so does a non-number');
  assert.equal(I.normalizeOpts({ active: 0 }).active, false, 'active coerces to boolean');
  assert.throws(() => I.normalizeOpts({ type: 'xl' }), TypeError, 'unknown type throws');
  assert.throws(() => I.normalizeOpts({ type: 'colorful' }), TypeError, 'the unported variants are not types');
});

/* ══════════════════ The CSS generator, as a pure function ══════════════════ */

test('buildCSS emits balanced, clean CSS for all 5 types × 2 themes', () => {
  const I = instantiate();
  for (const type of I.TYPES) {
    for (const theme of ['dark', 'light']) {
      const css = I.buildCSS('t9', type, theme, 2.5, 13, false);
      assert.ok(css.includes('[data-fxbeam="t9"]'), `${type}/${theme} targets its instance`);
      assert.ok(!css.includes('NaN') && !css.includes('undefined'), `${type}/${theme} has no leaked values`);
      assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length, `${type}/${theme} braces balance`);
      let depth = 0;
      for (const ch of css) { if (ch === '(') depth++; else if (ch === ')') depth--; assert.ok(depth >= 0); }
      assert.equal(depth, 0, `${type}/${theme} parens balance`);
      assert.ok(css.includes(`fxb-fade-in-t9`) && css.includes(`fxb-fade-out-t9`), `${type}/${theme} fades in and out`);
      assert.ok(css.includes('animation-play-state: paused'), `${type}/${theme} can pause offscreen/hidden`);
      assert.ok(css.includes('pointer-events: none'), `${type}/${theme} layers never intercept input`);
    }
  }
});

test('under reduced motion the generator emits NO animations or keyframes at all', () => {
  const I = instantiate();
  for (const type of I.TYPES) {
    const css = I.buildCSS('t9', type, 'dark', 2.5, 13, true);
    assert.ok(!css.includes('animation:'), `${type} reduced: no animation shorthand`);
    assert.ok(!css.includes('@keyframes'), `${type} reduced: no keyframes`);
    assert.ok(css.includes('[data-fxbeam="t9"]'), `${type} reduced: the static glow rules still exist`);
  }
});

test('rotate types are theme-agnostic (tokens flip the theme); line and pulse regenerate', () => {
  const I = instantiate();
  assert.equal(
    I.buildCSS('t2', 'md', 'dark', 1.96, 13, false),
    I.buildCSS('t2', 'md', 'light', 1.96, 13, false),
    'md CSS is identical across themes — --fxb-* tokens carry the difference'
  );
  assert.notEqual(
    I.buildCSS('t3', 'line', 'dark', 3.1, 13, false),
    I.buildCSS('t3', 'line', 'light', 3.1, 13, false),
    'line palette geometry is theme-resolved'
  );
  assert.notEqual(
    I.buildCSS('t3', 'pulse-inner', 'dark', 2.3, 13, false),
    I.buildCSS('t3', 'pulse-inner', 'light', 2.3, 13, false),
    'pulse corner accents are theme-resolved'
  );
});

/* ══════════════════ Contract seams, structurally ══════════════════ */

test('the section honors the app REDUCED const at its animation entry point', () => {
  const src = section;
  const at = src.indexOf('function activate(');
  assert.notEqual(at, -1, 'the activate entry point exists');
  const body = src.slice(at, at + 900);
  assert.match(body, /\bREDUCED\b/, 'activate asks REDUCED before anything moves');
});

test('the pulse loop is shared, ~30fps-capped, and stops when idle', () => {
  const src = section;
  assert.match(src, /1000 \/ 30/, 'the frame interval is the original ~30fps cap');
  assert.match(src, /driven\.size === 0[\s\S]{0,80}cancelAnimationFrame/, 'no instances → no rAF loop');
  assert.match(src, /document\.hidden/, 'the loop and lifecycle know about hidden documents');
  assert.match(src, /IntersectionObserver/, 'offscreen instances pause');
});

/* ══════════════════ Per-attach knobs (upstream types.ts port) ══════════════════ */

test('normalizeOpts: unspecified knobs leave the four-key shape untouched — back-compat is structural', () => {
  const I = instantiate();
  const base = I.normalizeOpts({ type: 'md', active: true });
  assert.deepEqual(Object.keys(base).sort(), ['active', 'duration', 'strength', 'type'],
    'no knob key exists unless the caller supplied it');
});

test('normalizeOpts: opacity is the PORT_PLAN clamp — [0,1], nonsense repairs to 1', () => {
  const I = instantiate();
  assert.equal(I.normalizeOpts({ opacity: 1.9 }).opacity, 1, 'four upstream presets exceed 1 — clamped');
  assert.equal(I.normalizeOpts({ opacity: -0.5 }).opacity, 0, 'floors at 0');
  assert.equal(I.normalizeOpts({ opacity: 0.35 }).opacity, 0.35, 'in-range passes through');
  assert.equal(I.normalizeOpts({ opacity: 'solid' }).opacity, 1, 'a supplied non-number repairs to the full-on default');
  assert.ok(!('opacity' in I.normalizeOpts({})), 'absent stays absent');
});

test('normalizeOpts: brightness/saturation clamp to [0,3] and drop when nonsense', () => {
  const I = instantiate();
  assert.equal(I.normalizeOpts({ brightness: 1.9 }).brightness, 1.9, 'the pulse preset value survives');
  assert.equal(I.normalizeOpts({ brightness: 9 }).brightness, 3, 'caps at 3');
  assert.equal(I.normalizeOpts({ saturation: 0.6 }).saturation, 0.6);
  assert.equal(I.normalizeOpts({ saturation: -1 }).saturation, undefined, 'negative drops to the token default');
  assert.equal(I.normalizeOpts({ brightness: 'high' }).brightness, undefined, 'non-numbers drop to the token default');
});

test('normalizeOpts: hueRange clamps to the upstream 30° ceiling — the palette contract', () => {
  const I = instantiate();
  assert.equal(I.normalizeOpts({ hueRange: 19 }).hueRange, 19);
  assert.equal(I.normalizeOpts({ hueRange: 360 }).hueRange, 30, 'the original rainbow stays unported');
  assert.equal(I.normalizeOpts({ hueRange: -4 }).hueRange, 0, 'no negative ranges');
  assert.equal(I.normalizeOpts({ hueRange: 0 }).hueRange, 0, 'zero — a pinned hue — is a valid choice');
});

test('normalizeOpts: staticColors coerces, borderRadius must be a non-negative number, callbacks must be functions', () => {
  const I = instantiate();
  assert.equal(I.normalizeOpts({ staticColors: 1 }).staticColors, true);
  assert.equal(I.normalizeOpts({ staticColors: false }).staticColors, false);
  assert.equal(I.normalizeOpts({ borderRadius: 10 }).borderRadius, 10);
  assert.equal(I.normalizeOpts({ borderRadius: -3 }).borderRadius, undefined, 'negative radii fall back to measuring');
  assert.equal(I.normalizeOpts({ borderRadius: 'round' }).borderRadius, undefined);
  const fn = () => {};
  assert.equal(I.normalizeOpts({ onActivate: fn }).onActivate, fn, 'a function passes through by reference');
  assert.equal(I.normalizeOpts({ onActivate: 'later' }).onActivate, undefined, 'anything else is dropped, never called');
  assert.equal(I.normalizeOpts({ onDeactivate: fn }).onDeactivate, fn);
});

test('buildCSS: omitting the knobs bag is byte-identical to passing it empty — every pre-knob caller is safe', () => {
  const I = instantiate();
  for (const type of I.TYPES) {
    assert.equal(
      I.buildCSS('t9', type, 'dark', 2.5, 13, false),
      I.buildCSS('t9', type, 'dark', 2.5, 13, false, {}),
      `${type}: the 6-arg call and the empty bag agree`
    );
  }
});

test('buildCSS: a custom hueRange lands in the drift keyframes for the rotate and line families', () => {
  const I = instantiate();
  const md = I.buildCSS('t9', 'md', 'dark', 1.96, 13, false, { hueRange: 19 });
  assert.ok(md.includes('hue-rotate(-19deg)') && md.includes('hue-rotate(19deg)'), 'md ping-pongs at ±19°');
  const line = I.buildCSS('t9', 'line', 'dark', 3.1, 13, false, { hueRange: 6 });
  assert.ok(line.includes('hue-rotate(-6deg)') && line.includes('hue-rotate(6deg)'), 'line at ±6°');
  assert.ok(line.includes('hue-rotate(-16deg)') && line.includes('hue-rotate(16deg)'), 'the line bloom keeps its +10° offset');
});

test('buildCSS: staticColors freezes the hue but never the motion or the brightness/saturation tokens', () => {
  const I = instantiate();
  for (const type of I.TYPES) {
    const css = I.buildCSS('t9', type, 'dark', 2.5, 13, false, { staticColors: true });
    assert.ok(!css.includes('@keyframes fxb-hue'), `${type}: no hue keyframes remain`);
    assert.ok(!css.includes('hue-rotate('), `${type}: no hue-rotate() term remains`);
    assert.ok(css.includes(`fxb-fade-in-t9`), `${type}: fades still run — staticColors is not reduced motion`);
    assert.match(css, /brightness\(var\(--fxb-[a-z]+-bright/, `${type}: the brightness token still applies, statically`);
    let depth = 0;
    for (const ch of css) { if (ch === '(') depth++; else if (ch === ')') depth--; assert.ok(depth >= 0); }
    assert.equal(depth, 0, `${type} staticColors parens balance`);
    assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length, `${type} staticColors braces balance`);
  }
  const md = I.buildCSS('t9', 'md', 'dark', 1.96, 13, false, { staticColors: true });
  assert.ok(md.includes('fxb-spin-t9'), 'the md ring still rotates');
  const line = I.buildCSS('t9', 'line', 'dark', 3.1, 13, false, { staticColors: true });
  assert.ok(line.includes('fxb-travel-t9') && line.includes('fxb-breathe-t9'), 'the line glow still travels and breathes');
});

test('the lifecycle honors the knobs: radius override skips measuring, detach clears the overrides, edges fire callbacks', () => {
  const src = section;
  const attachAt = src.indexOf('function attach(');
  assert.notEqual(attachAt, -1);
  const attachBody = src.slice(attachAt, src.indexOf('function detach(', attachAt));
  assert.match(attachBody, /if \(cfg\.borderRadius !== undefined\) inst\.radius = cfg\.borderRadius;/,
    'a supplied borderRadius wins over the computed-style read');
  assert.match(attachBody, /inst\.cfg\.borderRadius !== undefined\) inst\.radius = detectRadius/,
    'dropping the override on a later attach goes back to measuring');
  assert.match(attachBody, /activate\(inst\); fireCb\(cfg\.onActivate, el\)/, 'the lit edge fires onActivate');
  assert.match(attachBody, /deactivate\(inst\); fireCb\(cfg\.onDeactivate, el\)/, 'the unlit edge fires onDeactivate');
  const detachBody = src.slice(src.indexOf('function detach('), src.indexOf('return {', src.indexOf('function detach(')));
  assert.match(detachBody, /--fxb-\$\{t\}-bright/, 'detach clears the per-attach brightness overrides');
  assert.match(detachBody, /if \(wasLit && inst\.cfg\) fireCb\(inst\.cfg\.onDeactivate, el\)/,
    'detaching a lit beam is its deactivation edge');
  assert.match(src, /function fireCb\(fn, el\) \{[\s\S]{0,160}try \{ fn\(el\); \} catch/,
    'a throwing callback never breaks the lifecycle');
  assert.match(src, /const opacity = inst\.cfg\.opacity === undefined \? 1 : inst\.cfg\.opacity;/,
    'opacity folds into the strength var as a second master fader');
  assert.match(src, /hue: staticColors \? null :/, 'staticColors withholds the pulse driver hue config');
});
