import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The map's colour pops, and its labels can be read — design pass of
 * 14 Oct 2026 (G01, G09).
 *
 * G01: each leaf was painted at alpha 0.95 × max(0.55, 1 − 0.08·depth) over
 * --tm-canvas-bg, so the saturated ramp reached the screen washed out: the
 * 9.1 GB tile at depth 4 measured C*ab 41 in light (pastel salmon) and 46 in
 * dark (muddy maroon), where #FF453A itself is 84. The owner's standing rule
 * is that the colour must pop.
 *
 * G09: the tile labels were fixed black ink, 2.55–3.91:1 on the darker and
 * saturated tiles.
 *
 * The real painter is cut out of the built page and RUN against a recording
 * 2D context (the mapPaintFidelity precedent). Each tile's gradient stops are
 * composited over the theme's real canvas ground — --tm-canvas-bg over the
 * map's glass card over the page — and measured in CIE Lab and by WCAG
 * contrast. Nothing pins a hex: re-tune the ramp or the cushion and the
 * numbers are measured again.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* ─────────────────────────── slicing and running the page ─────────────────────────── */

/** `function name(…) {…}`, `const name = {…};` (brace matched) or `const|let NAME = value;`. */
function declSource(name: string): string {
  let start = INDEX.indexOf(`\nfunction ${name}(`);
  if (start !== -1) start += 1;
  if (start === -1) start = INDEX.indexOf(`const ${name} = {`);
  if (start === -1) {
    // `const NAME = …;`, or NAME as a later member of `const A = …, NAME = …;`.
    const m = new RegExp(`\\n(?:const|let) [^;\\n]*\\b${name} = `).exec(INDEX);
    assert.ok(m, `${name} is declared in the built page`);
    const at = m!.index + 1;
    return INDEX.slice(at, INDEX.indexOf(';', at) + 1);
  }
  let depth = 0;
  for (let i = INDEX.indexOf('{', INDEX.indexOf(name, start) + name.length); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1) + ';';
  }
  return assert.fail(`${name} never closes`);
}

/**
 * The page's declarations `names`, plus every other top-level function or
 * constant they turn out to need, resolved by running them: a helper that is
 * renamed, split or inlined is followed without editing this file.
 */
function load<T>(names: string[], deps: Record<string, unknown>, returns: string, run?: (fn: T) => void): T {
  const keys = Object.keys(deps);
  const pulled = [...names];
  for (let attempt = 0; attempt < 16; attempt++) {
    const src = `'use strict'; ${pulled.map(declSource).join('\n')}\nreturn ${returns};`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function(...keys, src)(...keys.map((k) => deps[k])) as T;
      if (run) run(fn);
      return fn;
    } catch (e) {
      const missing = /(\w+) is not defined/.exec(String((e as Error).message))?.[1];
      if (!missing || pulled.includes(missing)) throw e;
      pulled.push(missing);
    }
  }
  throw new Error(`${names.join(', ')} would not run after pulling in 16 helpers`);
}

type Grad = { kind: 'linear'; args: number[]; stops: Array<[number, string]> };
type Text = { text: string; x: number; y: number; fillStyle: unknown; font: string };

/** `style` as drawn under `globalAlpha`: a gradient's stops, or a colour, with the alpha multiplied in. */
function withAlpha(style: unknown, globalAlpha: number): unknown {
  if (globalAlpha === 1 || globalAlpha === undefined || Number.isNaN(globalAlpha)) return style;
  const scale = (c: string) => { const [r, g, b, a] = rgba(c); return `rgba(${r},${g},${b},${a * globalAlpha})`; };
  if (style && typeof style === 'object' && (style as Grad).stops) {
    const g = style as Grad;
    return { ...g, stops: g.stops.map(([o, c]) => [o, scale(c)]) };
  }
  return typeof style === 'string' && /^(#|rgb)/i.test(style) ? scale(style) : style;
}

/** A 2D context that records every fill and every text with the paint it was drawn in. */
function recordingCtx() {
  const fills: unknown[] = [];
  const texts: Text[] = [];
  const props: Record<string, unknown> = {
    font: '10px sans-serif',
    globalAlpha: 1,
    measureText: (t: string) => ({ width: String(t).length * 6 }),
    createLinearGradient: (...args: number[]) => {
      const g: Grad = { kind: 'linear', args, stops: [] };
      return Object.assign(g, { addColorStop: (o: number, c: string) => { g.stops.push([o, c]); } });
    },
    createPattern: () => null,
  };
  const ctx: any = new Proxy(props, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...a: unknown[]) => {
        // A fill drawn under a globalAlpha below 1 shows its ground through
        // however opaque its own colours are, so the alpha travels with it.
        if (k === 'fill' || k === 'fillRect') fills.push(withAlpha(t.fillStyle, Number(t.globalAlpha)));
        if (k === 'fillText') texts.push({ text: String(a[0]), x: Number(a[1]), y: Number(a[2]), fillStyle: withAlpha(t.fillStyle, Number(t.globalAlpha)), font: String(t.font) });
      };
    },
    set(t, k: string, v) { t[k] = v; return true; },
  });
  return { ctx, fills, texts };
}

/* ─────────────────────────── the theme grounds ─────────────────────────── */

const SHEET = (() => {
  const open = INDEX.indexOf('<style>');
  return INDEX.slice(open + '<style>'.length, INDEX.indexOf('</style>', open)).replace(/\/\*[\s\S]*?\*\//g, ' ');
})();
function tokens(selector: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of SHEET.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (!selector.test(m[1].trim())) continue;
    for (const d of m[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  }
  return out;
}
const DARK = tokens(/^:root$/);
const LIGHT = { ...DARK, ...tokens(/^:root\[data-theme="light"\]$/) };

type RGB = [number, number, number];
type RGBA = [number, number, number, number];
function rgba(value: string): RGBA {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return [...[0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)), 1] as RGBA;
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(v);
  assert.ok(fn, `colour "${value}" is a hex or rgb()/rgba()`);
  return [+fn![1], +fn![2], +fn![3], fn![4] === undefined ? 1 : +fn![4]];
}
function over(fg: RGBA, bg: RGB): RGB {
  return [0, 1, 2].map((i) => fg[3] * fg[i] + (1 - fg[3]) * bg[i]) as RGB;
}
/** The ground a tile is painted on: --tm-canvas-bg over the map's glass card over the page. */
function canvasGround(palette: Record<string, string>): RGB {
  const page = rgba(palette['--bg-1']).slice(0, 3) as RGB;
  const card = over(rgba(palette['--glass']), page);
  return over(rgba(palette['--tm-canvas-bg']), card);
}
const THEMES = [['dark', canvasGround(DARK)], ['light', canvasGround(LIGHT)]] as const;

/* ─────────────────────────── colour science ─────────────────────────── */

const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
function luminance([r, g, b]: RGB): number { return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** CIE L*, C*ab under D65. */
function lab([r8, g8, b8]: RGB): { L: number; C: number } {
  const r = lin(r8), g = lin(g8), b = lin(b8);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const L = 116 * f(Y) - 16;
  return { L, C: Math.hypot(500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))) };
}
const lerp = (a: RGB, b: RGB, t: number) => a.map((v, i) => v + (b[i] - v) * t) as RGB;
const fmt = (n: number) => n.toFixed(2);

/* ─────────────────────────── the ramp, from the page ─────────────────────────── */

const ramp = load<{ sizeRgb: (b: number) => RGB; lo: number; hi: number }>(
  ['sizeRgb'], {}, '{ sizeRgb, lo: TIER_LO, hi: TIER_HI }', (r) => { r.sizeRgb(1e9); });
/** Ramp steps: 21 sizes spread evenly over the key's log domain, 1 MB … 10 GB. */
const STEPS = Array.from({ length: 21 }, (_, k) => {
  const t = k / 20;
  return { t, bytes: 10 ** (ramp.lo + t * (ramp.hi - ramp.lo)) };
});
const TOP = STEPS[STEPS.length - 1];

/* ─────────────────────────── painting a map ─────────────────────────── */

type Tile = { name: string; path: string; size: number; type: string; depth: number; expanded: boolean; x: number; y: number; w: number; h: number };

const MAP_W = 1000, MAP_H = 1000;

/** Paint `tiles` with the real drawTreemap; hand back what it recorded. */
function paint(tiles: Tile[]) {
  const rec = recordingCtx();
  const state = { treemap: { nodes: tiles, hideCloud: false, rootSize: 1e12, history: { active: false, diff: false }, pxRects: [] as any[], colorMode: 'size', mode: 'treemap', query: '' } };
  const draw = load<() => void>(['drawTreemap'], {
    $: () => ({ clientWidth: MAP_W + 20 }),
    treemapCanvasHeight: () => MAP_H,
    window: { devicePixelRatio: 1 },
    tmCanvas: { style: {}, width: 0, height: 0 },
    tmBuffer: { width: 0, height: 0 },
    tmBufCtx: rec.ctx,
    cssVar: () => 'rgba(0,0,0,0.3)',
    state,
    tmNodeCapNote: () => '', renderAltNote() {}, tmSetEmpty() {},
    renderSearchOverlay() {}, presentTreemap() {}, renderTmLegend() {},
    cellRgb: (n: Tile) => ramp.sizeRgb(n.size),
    tmHatchPattern: () => null,
    tmPreview: { on: false },
    roundRect() {},
    formatBytes: (n: number) => `${Math.round(n)} B`,
  }, 'drawTreemap', (draw) => draw());
  // Resolving the helpers ran the painter, perhaps more than once and partly:
  // what is measured is one clean paint.
  rec.fills.length = 0;
  rec.texts.length = 0;
  draw();
  return rec;
}

/** A leaf `h` px tall at `depth`, coloured by `bytes`, in its own column of the map. */
function tile(i: number, depth: number, bytes: number, h = 200): Tile {
  const col = i % 40, row = Math.floor(i / 40);
  return {
    name: `f${i}.bin`, path: `/r/f${i}.bin`, size: bytes, type: 'file', depth, expanded: false,
    x: col * 2.5, y: row * 25, w: 2.4, h: (h / MAP_H) * 100,
  };
}

/** The leaf fills pass 1 painted, in tile order (fills[0] is the map's ground). */
function leafFills(rec: ReturnType<typeof recordingCtx>, n: number): Grad[] {
  const fills = rec.fills.slice(1, 1 + n);
  assert.equal(fills.length, n, 'one fill per tile');
  for (const f of fills) assert.equal(typeof f, 'object', `a leaf is a cushion gradient, not a flat colour (${String(f)})`);
  return fills as Grad[];
}

/** The gradient's colour at offset `t` (0 top, 1 bottom), composited over `ground`. */
function at(g: Grad, t: number, ground: RGB): RGB {
  const stops = [...g.stops].sort((a, b) => a[0] - b[0]);
  const lo = stops.filter(([o]) => o <= t).pop() ?? stops[0];
  const hi = stops.find(([o]) => o >= t) ?? stops[stops.length - 1];
  const a = over(rgba(lo[1]), ground), b = over(rgba(hi[1]), ground);
  return hi[0] === lo[0] ? a : lerp(a, b, (t - lo[0]) / (hi[0] - lo[0]));
}

/* ══════════════ G01 — the fill pops, at every depth, in both themes ══════════════ */

const DEPTHS = [1, 2, 3, 4, 5, 6, 7, 8];
const CASES = DEPTHS.flatMap((depth) => STEPS.map((s) => ({ depth, ...s })));
const PAINTED = (() => {
  const tiles = CASES.map((c, i) => tile(i, c.depth, c.bytes));
  return leafFills(paint(tiles), tiles.length);
})();

test('G01: a leaf is painted opaque, so --tm-canvas-bg (or anything behind the map) cannot tint it', () => {
  for (const [i, g] of PAINTED.entries()) {
    for (const t of [0, 0.5, 1]) {
      const onBlack = at(g, t, [0, 0, 0]), onWhite = at(g, t, [255, 255, 255]);
      assert.deepEqual(onBlack.map(Math.round), onWhite.map(Math.round),
        `depth ${CASES[i].depth}, ramp ${CASES[i].t}: the fill at ${t} shows through to what is behind it (${g.stops.map((s) => s[1]).join(' → ')})`);
    }
  }
});

test('G01: no tile at any depth keeps less than 0.8 of its ramp colour\'s strength, in either theme', () => {
  for (const [theme, ground] of THEMES) {
    for (const [i, g] of PAINTED.entries()) {
      const { depth, t, bytes } = CASES[i];
      const own = lab(ramp.sizeRgb(bytes)).C;
      const shown = lab(at(g, 0.5, ground)).C;
      assert.ok(shown / own >= 0.8,
        `${theme}, depth ${depth}, ramp ${t}: the tile shows C*ab ${shown.toFixed(1)} of its colour's ${own.toFixed(1)} (${fmt(shown / own)}, floor 0.80)`);
    }
  }
});

test('G01: the top of the ramp (10 GB+) shows C*ab ≥ 60 at every depth the default Depth 4 draws, in both themes', () => {
  for (const [theme, ground] of THEMES) {
    for (const [i, g] of PAINTED.entries()) {
      const { depth, t } = CASES[i];
      if (t !== TOP.t || depth > 4) continue;
      const { L, C } = lab(at(g, 0.5, ground));
      assert.ok(C >= 60, `${theme}, depth ${depth}: the biggest tiles show C*ab ${C.toFixed(1)} (L* ${L.toFixed(1)}) — washed out under 60`);
    }
  }
});

test('G01: the paint keeps the ramp\'s own lightness order — L* rises and falls where the ramp does, and nowhere else', () => {
  // The ramp itself runs teal (L* ~74) up to amber (~87) and down to red
  // (~58): monotone on each side of the amber knee. What is measured here is
  // that the paint never reorders it — a depth recipe that lightened or
  // darkened some steps more than others would.
  const own = STEPS.map((s) => lab(ramp.sizeRgb(s.bytes)).L);
  for (const [theme, ground] of THEMES) {
    for (const depth of DEPTHS) {
      const shown = STEPS.map((_, k) => lab(at(PAINTED[CASES.findIndex((c) => c.depth === depth) + k], 0.5, ground)).L);
      for (let k = 1; k < STEPS.length; k++) {
        const rampDir = Math.sign(Math.round((own[k] - own[k - 1]) * 10));
        if (rampDir === 0) continue;
        assert.equal(Math.sign(shown[k] - shown[k - 1]), rampDir,
          `${theme}, depth ${depth}: between ramp ${STEPS[k - 1].t} and ${STEPS[k].t} the ramp's L* goes ${own[k - 1].toFixed(1)} → ${own[k].toFixed(1)}, the tile's ${shown[k - 1].toFixed(1)} → ${shown[k].toFixed(1)}`);
      }
    }
  }
});

test('G01: the cushion still shades every tile — lighter at the top, darker at the bottom', () => {
  for (const [i, g] of PAINTED.entries()) {
    const top = luminance(at(g, 0, [0, 0, 0])), bottom = luminance(at(g, 1, [0, 0, 0]));
    assert.ok(top > bottom, `depth ${CASES[i].depth}, ramp ${CASES[i].t}: the cushion runs light to dark (${top.toFixed(3)} → ${bottom.toFixed(3)})`);
  }
});

