import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-mapColourPop-data-');

import { buildTreemap } from '../src/utils/treemap';
import type { FileNode } from '../src/models/types';

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
 * The owner's outline decision (20 Oct 2026) and J51: the outlines contrast
 * with the tiles they bound, and a folder no rectangle covers shows its own
 * colour — measured on rendered pixels at the end of this file.
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
  for (let attempt = 0; attempt < 64; attempt++) {
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
  throw new Error(`${names.join(', ')} would not run after pulling in 64 helpers`);
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

type Stroke = { style: string; width: number; rect: number[] };
/** One straight segment of a stroked path, as [x0, y0, x1, y1], in the paint it was stroked in. */
type Line = { style: string; width: number; seg: number[] };
/** One rectangle filled, or one text written, in the order the painter did it. */
type Op = { kind: 'rect'; style: unknown; rect: number[] } | { kind: 'text'; text: Text };

/**
 * A 2D context that records every fill, every text and every stroked
 * rectangle with the paint it was drawn in — and, in `ops`, every filled
 * rectangle and text in drawing order, so what lies under a label can be
 * replayed (canvasAt).
 */
function recordingCtx() {
  const fills: unknown[] = [];
  const texts: Text[] = [];
  const strokes: Stroke[] = [];
  const lines: Line[] = [];
  const ops: Op[] = [];
  // A path's straight segments, kept until it is stroked (a leaf's top highlight, review F1.6).
  let pending: number[][] = [];
  let pen: number[] | null = null;
  const props: Record<string, unknown> = {
    font: '10px sans-serif',
    globalAlpha: 1,
    measureText: (t: string) => ({ width: String(t).length * 6 }),
    createLinearGradient: (...args: number[]) => {
      const g: Grad = { kind: 'linear', args, stops: [] };
      return Object.assign(g, { addColorStop: (o: number, c: string) => { g.stops.push([o, c]); } });
    },
    createPattern: () => null,
    beginPath: () => { pending = []; pen = null; },
    moveTo: (x: number, y: number) => { pen = [x, y]; },
    lineTo: (x: number, y: number) => { if (pen) pending.push([pen[0], pen[1], x, y]); pen = [x, y]; },
    stroke: () => { for (const seg of pending) lines.push({ style: String(props.strokeStyle), width: Number(props.lineWidth), seg }); },
  };
  const ctx: any = new Proxy(props, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...a: unknown[]) => {
        // A fill drawn under a globalAlpha below 1 shows its ground through
        // however opaque its own colours are, so the alpha travels with it.
        if (k === 'fill' || k === 'fillRect') fills.push(withAlpha(t.fillStyle, Number(t.globalAlpha)));
        if (k === 'fillRect') ops.push({ kind: 'rect', style: withAlpha(t.fillStyle, Number(t.globalAlpha)), rect: a.map(Number) });
        if (k === 'fillText') {
          const text = { text: String(a[0]), x: Number(a[1]), y: Number(a[2]), fillStyle: withAlpha(t.fillStyle, Number(t.globalAlpha)), font: String(t.font) };
          texts.push(text);
          ops.push({ kind: 'text', text });
        }
        if (k === 'strokeRect') strokes.push({ style: String(t.strokeStyle), width: Number(t.lineWidth), rect: a.map(Number) });
      };
    },
    set(t, k: string, v) { t[k] = v; return true; },
  });
  return { ctx, fills, texts, strokes, lines, ops };
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

/**
 * Paint `tiles` with the real drawTreemap — coloured by the size ramp unless
 * `colour` says otherwise, on the live map unless `history` says otherwise.
 */
function paint(tiles: Tile[], colour: (n: Tile) => RGB = (n) => ramp.sizeRgb(n.size), history = { active: false, diff: false }) {
  const rec = recordingCtx();
  const state = { treemap: { nodes: tiles, hideCloud: false, rootSize: 1e12, history, pxRects: [] as any[], colorMode: 'size', mode: 'treemap', query: '' } };
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
    cellRgb: colour,
    tmHatchPattern: () => null,
    tmPreview: { on: false },
    roundRect() {},
    formatBytes: (n: number) => `${Math.round(n)} B`,
  }, 'drawTreemap', (draw) => draw());
  // Resolving the helpers ran the painter, perhaps more than once and partly:
  // what is measured is one clean paint.
  rec.fills.length = 0;
  rec.texts.length = 0;
  rec.ops.length = 0;
  rec.strokes.length = 0;
  rec.lines.length = 0;
  draw();
  return Object.assign(rec, { px: state.treemap.pxRects });
}

/** A leaf `h` px tall at `depth`, coloured by `bytes`, in its own column of the map. */
function tile(i: number, depth: number, bytes: number, h = 200): Tile {
  const col = i % 40, row = Math.floor(i / 40);
  return {
    name: `f${i}.bin`, path: `/r/f${i}.bin`, size: bytes, type: 'file', depth, expanded: false,
    x: col * 2.5, y: row * 25, w: 2.4, h: (h / MAP_H) * 100,
  };
}

/**
 * The leaf fills pass 1 painted, in tile order: each leaf's own fill over its box, edge to edge — not a
 * folder's fill under it (pass 0, J51), nor anything laid on it after.
 */
function leafFills(rec: ReturnType<typeof recordingCtx>, n: number, px: Array<{ x: number; y: number; w: number; h: number; frame: boolean }> = (rec as { px?: never[] }).px ?? []): Grad[] {
  // The gradient laid over most of the leaf's own box and no further: a folder's fill under it is bigger.
  const over = ([x, y, w, h]: number[], r: { x: number; y: number; w: number; h: number }) =>
    x >= r.x - 1e-6 && y >= r.y - 1e-6 && x + w <= r.x + r.w + 1e-6 && y + h <= r.y + r.h + 1e-6 && w * h >= 0.5 * r.w * r.h;
  const fills = px.filter((r) => !r.frame).map((r) => {
    const op = rec.ops.find((o) => o.kind === 'rect' && typeof o.style === 'object' && over(o.rect, r));
    return op && op.kind === 'rect' ? op.style : undefined;
  });
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

/* ══════════════ G09 — a tile's name and size reach 4.5:1 on the tile they are written on ══════════════ */

/** px of a canvas font string ("500 11px …"). */
const fontPx = (font: string) => Number(/(\d+(?:\.\d+)?)px/.exec(font)![1]);
/** The vertical room a line of text takes: its font size at a normal 1.2 leading. */
const LEADING = 1.2;

const LABEL_DEPTHS = [1, 2, 3, 4, 5, 6];
/** Tall enough for both lines, short enough that one line spans most of the cushion, and between. */
const LABEL_HEIGHTS = [15, 18, 22, 27, 31, 36, 44, 60, 90, 200];

type Labelled = { depth: number; t: number; h: number; tile: Tile; fill: Grad; texts: Text[] };
const LABELLED: Labelled[] = (() => {
  const out: Array<Omit<Labelled, 'fill' | 'texts'>> = [];
  let i = 0;
  for (const depth of LABEL_DEPTHS) for (const s of STEPS) for (const h of LABEL_HEIGHTS) {
    // One tile per 100 px column, 210 px rows: each tile has room for its labels and touches no other.
    const col = i % 10, row = Math.floor(i / 10);
    const x = col * 100, y = row * 210;
    out.push({ depth, t: s.t, h, tile: { name: `file-${i}.mov`, path: `/r/file-${i}.mov`, size: s.bytes, type: 'file', depth, expanded: false,
      x: (x / MAP_W) * 100, y: (y / MAP_H) * 100, w: (96 / MAP_W) * 100, h: (h / MAP_H) * 100 } });
    i++;
  }
  const rec = paint(out.map((o) => o.tile));
  const fills = leafFills(rec, out.length);
  return out.map((o, k) => {
    const x = (o.tile.x / 100) * MAP_W, y = (o.tile.y / 100) * MAP_H;
    return { ...o, fill: fills[k], texts: rec.texts.filter((tx) => tx.x >= x && tx.x < x + 96 && tx.y >= y && tx.y < y + 210) };
  });
})();

/** The worst contrast `text` has against the cushion under it, from its top to its bottom on the tile. */
function worstContrast(l: Labelled, text: Text, ground: RGB): number {
  const ink = rgba(String(text.fillStyle));
  return Math.min(...lineEnds(l, text, ground).map((under) => contrast(over(ink, under), under)));
}
/** The cushion under `text`'s top and its foot on the tile. */
function lineEnds(l: Labelled, text: Text, ground: RGB): RGB[] {
  const y0 = (l.tile.y / 100) * MAP_H, h = l.h;
  return [text.y, Math.min(y0 + h, text.y + fontPx(text.font) * LEADING)]
    .map((yy) => at(l.fill, Math.max(0, Math.min(1, (yy - y0) / h)), ground));
}

/** The size line's quieter ink, as the page sets it. */
const QUIET = load<number>(['TM_SIZE_INK_ALPHA'], {}, 'TM_SIZE_INK_ALPHA');
/** The better of black and white at `alpha` across a line whose ends lie on `ends`: its worst contrast. */
function bestInkAt(ends: RGB[], alpha: number): number {
  const worst = (ink: RGB) => Math.min(...ends.map((c) => contrast(over([...ink, alpha] as RGBA, c), c)));
  return Math.max(worst([0, 0, 0]), worst([255, 255, 255]));
}
/**
 * The weight a line is written at (review F2.4): the name at full ink; the
 * size line a step quieter, at the page's TM_SIZE_INK_ALPHA, wherever a
 * line that quiet reads at 4.5:1 across `ends`, and at full ink only where
 * it would not. A 4.5:1 floor alone cannot see this — full ink only ever
 * reads better. Returns which weight the line took.
 */
function assertInkWeight(text: Text, ends: RGB[], where: string): 'name' | 'quiet' | 'full' {
  const a = rgba(String(text.fillStyle))[3];
  if (fontPx(text.font) !== 10) {
    assert.equal(a, 1, `${where}: the name "${text.text}" is written at full ink (alpha ${a})`);
    return 'name';
  }
  const quiet = bestInkAt(ends, QUIET);
  assert.equal(a, quiet >= 4.5 ? QUIET : 1,
    `${where}: a size line ${QUIET} quiet reads at ${fmt(quiet)}:1 here, so it is written at ${quiet >= 4.5 ? QUIET : 1} (alpha ${a})`);
  return quiet >= 4.5 ? 'quiet' : 'full';
}

test('G09: every tile is labelled where it has room — a name, and a size where two lines fit', () => {
  for (const l of LABELLED) {
    assert.ok(l.texts.length >= 1, `depth ${l.depth}, ramp ${l.t}, ${l.h} px: the tile carries its name`);
    if (l.h >= 36) assert.equal(l.texts.length, 2, `depth ${l.depth}, ramp ${l.t}, ${l.h} px: and its size (${l.texts.map((x) => x.text).join(' | ')})`);
  }
});

test('G09: a tile\'s name and its size line both reach 4.5:1 against the tile, at every ramp step and depth, in both themes', () => {
  for (const [theme, ground] of THEMES) {
    for (const l of LABELLED) {
      for (const [k, text] of l.texts.entries()) {
        const c = worstContrast(l, text, ground);
        assert.ok(c >= 4.5,
          `${theme}, depth ${l.depth}, ramp ${l.t}, a ${l.h} px tile: its ${k === 0 ? 'name' : 'size'} line "${text.text}" in ${String(text.fillStyle)} measures ${fmt(c)}:1 (floor 4.5:1)`);
      }
    }
  }
});

test('G09: the name is written at full ink and the size line a step quieter wherever that still reads at 4.5:1 — full ink only where it would not, at every ramp step and depth', () => {
  // The name/size hierarchy is part of how the map reads. Every other
  // label assertion is a 4.5:1 floor, which full ink on every size line
  // passes as well — so nothing held the quieter step (review F2.4).
  assert.ok(QUIET < 1, `the size line is a step quieter than the name (TM_SIZE_INK_ALPHA ${QUIET})`);
  const took = { name: 0, quiet: 0, full: 0 };
  for (const [theme, ground] of THEMES) {
    for (const l of LABELLED) {
      for (const text of l.texts) took[assertInkWeight(text, lineEnds(l, text, ground), `${theme}, depth ${l.depth}, ramp ${l.t}, a ${l.h} px tile`)]++;
    }
  }
  assert.ok(took.quiet > took.full, `on the ramp the size line is mostly the quieter one (${took.quiet} quiet, ${took.full} at full ink, ${took.name} names)`);
});

test('G09: the ink is chosen from the tile — dark on a light tile, light on a dark one', () => {
  // One fixed ink cannot clear 4.5:1 on both: the Reclaim mode's "not
  // scored" grey (#3A4048) is a dark tile, the size ramp's amber a light one.
  const rec = recordingCtx();
  const grey = { name: 'keep.bin', path: '/r/keep.bin', size: 5e9, type: 'file', depth: 1, expanded: false, x: 0, y: 0, w: 10, h: 10 };
  const amber = { ...grey, name: 'amber.bin', path: '/r/amber.bin', x: 20 };
  const draw = load<() => void>(['drawTreemap'], {
    $: () => ({ clientWidth: MAP_W + 20 }), treemapCanvasHeight: () => MAP_H, window: { devicePixelRatio: 1 },
    tmCanvas: { style: {}, width: 0, height: 0 }, tmBuffer: { width: 0, height: 0 }, tmBufCtx: rec.ctx,
    cssVar: () => 'rgba(0,0,0,0.3)',
    state: { treemap: { nodes: [grey, amber], hideCloud: false, rootSize: 1e12, history: { active: false, diff: false }, pxRects: [] } },
    tmNodeCapNote: () => '', renderAltNote() {}, tmSetEmpty() {}, renderSearchOverlay() {}, presentTreemap() {}, renderTmLegend() {},
    cellRgb: (n: Tile) => (n === grey ? [0x3a, 0x40, 0x48] : [255, 214, 10]),
    tmHatchPattern: () => null, tmPreview: { on: false }, roundRect() {}, formatBytes: (n: number) => `${n} B`,
  }, 'drawTreemap', (d) => d());
  rec.texts.length = 0;
  draw();
  const inkOf = (name: string) => luminance(rgba(String(rec.texts.find((x) => x.text === name)!.fillStyle)).slice(0, 3) as RGB);
  assert.ok(inkOf('keep.bin') > 0.5, 'a light ink on the dark grey tile');
  assert.ok(inkOf('amber.bin') < 0.1, 'a dark ink on the amber tile');
});

test('G09: of black and white, a line takes the ink that is clearer over the whole line, its darker bottom included', () => {
  // On a mid grey the cushion's light top can favour black by a hair while
  // the shaded bottom of the same line favours white by a mile: judged at
  // its top alone, the line would be written in the ink it can barely be
  // read in at its foot.
  const greys: RGB[] = [];
  for (let v = 70; v <= 190; v += 3) greys.push([v, v, v + 6]);
  const tiles: Tile[] = [];
  const colourOf = new Map<string, RGB>();
  for (const g of greys) for (const h of [15, 20, 26, 34, 50, 90]) {
    const i = tiles.length, x = (i % 10) * 100, y = Math.floor(i / 10) * 210;
    const t: Tile = { name: `g${i}.dat`, path: `/r/g${i}.dat`, size: 1e9, type: 'file', depth: 2, expanded: false,
      x: (x / MAP_W) * 100, y: (y / MAP_H) * 100, w: 9.6, h: (h / MAP_H) * 100 };
    tiles.push(t);
    colourOf.set(t.path, g);
  }
  const rec = paint(tiles, (n) => colourOf.get(n.path)!);
  const fills = leafFills(rec, tiles.length);
  let judged = 0;
  for (const [k, t] of tiles.entries()) {
    const x = (t.x / 100) * MAP_W, y0 = (t.y / 100) * MAP_H, h = (t.h / 100) * MAP_H;
    for (const text of rec.texts.filter((tx) => tx.x >= x && tx.x < x + 96 && tx.y >= y0 && tx.y < y0 + 210)) {
      const alpha = rgba(String(text.fillStyle))[3];
      const ends = [text.y, Math.min(y0 + h, text.y + fontPx(text.font) * LEADING)]
        .map((yy) => at(fills[k], Math.max(0, Math.min(1, (yy - y0) / h)), [0, 0, 0]));
      const worstFor = (ink: RGB) => Math.min(...ends.map((c) => contrast(over([...ink, alpha] as RGBA, c), c)));
      const chosen = rgba(String(text.fillStyle)).slice(0, 3) as RGB;
      const other: RGB = luminance(chosen) > 0.5 ? [0, 0, 0] : [255, 255, 255];
      assert.ok(worstFor(chosen) >= worstFor(other) - 1e-9,
        `grey ${colourOf.get(t.path)}, ${h} px, "${text.text}": ${String(text.fillStyle)} is ${fmt(worstFor(chosen))}:1 at its worst, the other ink ${fmt(worstFor(other))}:1`);
      judged++;
    }
  }
  assert.ok(judged > 300, `the sweep judged ${judged} lines`);
});

test('G09: a hollow cloud placeholder is labelled in the page\'s own ink, readable over the map\'s ground in both themes', () => {
  // A placeholder is drawn hollow — a 16% wash of its colour over the
  // map's ground — so its label sits on the ground, which is near-black in
  // dark: the old fixed black ink was all but invisible there.
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    const ground = canvasGround(palette);
    const rec = recordingCtx();
    const cloud = { name: 'movie.mov', path: '/r/movie.mov', size: 4e9, type: 'file', depth: 1, expanded: false, cloudPlaceholder: true, x: 0, y: 0, w: 20, h: 20 };
    const draw = load<() => void>(['drawTreemap'], {
      $: () => ({ clientWidth: MAP_W + 20 }), treemapCanvasHeight: () => MAP_H, window: { devicePixelRatio: 1 },
      tmCanvas: { style: {}, width: 0, height: 0 }, tmBuffer: { width: 0, height: 0 }, tmBufCtx: rec.ctx,
      cssVar: (name: string) => palette[name] ?? '',
      state: { treemap: { nodes: [cloud], hideCloud: false, rootSize: 1e12, history: { active: false, diff: false }, pxRects: [] } },
      tmNodeCapNote: () => '', renderAltNote() {}, tmSetEmpty() {}, renderSearchOverlay() {}, presentTreemap() {}, renderTmLegend() {},
      cellRgb: () => ramp.sizeRgb(4e9),
      tmHatchPattern: () => null, tmPreview: { on: false }, roundRect() {}, formatBytes: (n: number) => `${n} B`,
    }, 'drawTreemap', (d) => d());
    rec.fills.length = 0; rec.texts.length = 0;
    draw();
    const wash = rec.fills[1];
    assert.equal(typeof wash, 'string', 'the placeholder is a flat wash, not a cushion');
    const under = over(rgba(String(wash)), ground);
    assert.equal(rec.texts.length, 2, 'it carries its name and size');
    for (const text of rec.texts) {
      const c = contrast(over(rgba(String(text.fillStyle)), under), under);
      assert.ok(c >= 4.5, `${theme}: "${text.text}" in ${String(text.fillStyle)} measures ${fmt(c)}:1 on the hollow tile (floor 4.5:1)`);
    }
  }
});

/* ══════════════ G09 — every colour the map paints, and a label pushed below its folder's tag ══════════════ */

/**
 * The size ramp is one of the colours a tile is painted in. Age, Reclaim
 * (every score, and "not scored"), the History diff and the Trash cell
 * paint others, and several sit at the luminance where black and white
 * read about equally — about 4.6:1 each on a flat fill, so a cushion's light
 * top and dark foot leave neither at 4.5:1 across a line: the Reclaim
 * "keep" grey measured 4.36:1 (name) and 4.06:1 (size), the diff's
 * "unchanged" 3.91:1 (review F1.2, F1.14). And a leaf in its folder's
 * top-left corner writes its label below the folder's name tag, 24 px down,
 * where a short red tile's cushion runs through that same luminance.
 */
const OTHER_COLOURS: Array<{ name: string; rgb: RGB }> = (() => {
  const pageColours = load<{ reclaimRgb: (s: number) => RGB; diffRgb: (n: object) => RGB; consts: Record<string, RGB> }>(
    ['reclaimRgb', 'diffRgb', 'C_RC_UNSCORED'], {},
    `{ reclaimRgb, diffRgb, consts: { C_RC_UNSCORED, ${[...new Set(/const AGE_BANDS = \[([\s\S]*?)\n\];/.exec(INDEX)![1].match(/rgb: (C_\w+)/g)!.map((m) => m.slice(5)))].join(', ')} } }`,
    (c) => { c.reclaimRgb(10); c.diffRgb({ size: 1, prevSize: 2 }); });
  const out: Array<{ name: string; rgb: RGB }> = [];
  for (let s = 0; s <= 100; s++) out.push({ name: `Reclaim score ${s}`, rgb: pageColours.reclaimRgb(s) });
  out.push({ name: 'Reclaim not scored', rgb: pageColours.consts.C_RC_UNSCORED });
  for (const [k, v] of Object.entries(pageColours.consts)) if (k !== 'C_RC_UNSCORED') out.push({ name: `Age band ${k}`, rgb: v });
  for (const [what, n] of [['unchanged', { size: 5e9 }], ['unchanged (same size)', { size: 5e9, prevSize: 5e9 }], ['new', { size: 5e9, prevSize: null }],
    ['grew', { size: 5e9, prevSize: 1e9 }], ['shrank', { size: 1e9, prevSize: 5e9 }]] as const) {
    out.push({ name: `History diff ${what}`, rgb: pageColours.diffRgb(n) });
  }
  return out;
})();

/** Heights through the cushion's whole range: a one-line tile, two lines, a part cushion, a whole one, tall. */
const SWEEP_HEIGHTS = [15, 17, 18, 20, 22, 25, 27, 31, 34, 37, 41, 44, 48, 53, 56, 60, 63, 71, 74, 87, 110, 126, 200];

type Swept = { label: string; h: number; y0: number; fill: Grad; texts: Text[] };

/**
 * Paint `leaves` (each with its colour, or the Trash cell) with the real
 * drawTreemap, each in its own 210 px row slot — after the folder frame it
 * sits in, when it has one — and return each leaf's cushion and the lines
 * written on it.
 */
function sweep(leaves: Array<{ label: string; rgb?: RGB; trash?: boolean; h: number; inFolder?: boolean }>): Swept[] {
  const nodes: Tile[] = [];
  const colourOf = new Map<string, RGB>();
  const where: Array<{ x: number; y: number; h: number }> = [];
  for (const [i, l] of leaves.entries()) {
    const x = (i % 10) * 100, y = Math.floor(i / 10) * 210;
    let lx = x, ly = y;
    if (l.inFolder) {
      // A top-level folder big enough for its name tag, with this leaf in its top-left corner.
      nodes.push({ name: `Folder ${i}`, path: `/r/d${i}`, size: 1e10, type: 'dir', depth: 1, expanded: true,
        x: (x / MAP_W) * 100, y: (y / MAP_H) * 100, w: (100 / MAP_W) * 100, h: ((l.h + 4) / MAP_H) * 100 });
      lx = x + 2; ly = y + 2;
    }
    const leaf = { name: `file-${i}.mov`, path: `/r/d${i}/file-${i}.mov`, size: 5e9, type: 'file', depth: l.inFolder ? 2 : 1, expanded: false,
      x: (lx / MAP_W) * 100, y: (ly / MAP_H) * 100, w: (96 / MAP_W) * 100, h: (l.h / MAP_H) * 100, ...(l.trash ? { isTrash: true } : {}) };
    nodes.push(leaf);
    if (l.rgb) colourOf.set(leaf.path, l.rgb);
    where.push({ x: lx, y: ly, h: l.h });
  }
  const rec = paint(nodes, (n) => colourOf.get(n.path) ?? [0, 0, 0]);
  const fills = leafFills(rec, leaves.length);
  return leaves.map((l, k) => ({
    label: l.label, h: l.h, y0: where[k].y, fill: fills[k],
    texts: rec.texts.filter((tx) => Math.abs(tx.x - (where[k].x + 5)) < 0.01 && tx.y >= where[k].y - 0.01 && tx.y < where[k].y + l.h),
  }));
}

/** Every line on every swept tile at 4.5:1 or better against the cushion under it, in both themes. */
function assertLegible(swept: Swept[], what: string, expectLines: number) {
  let lines = 0;
  for (const [theme, ground] of THEMES) {
    for (const s of swept) {
      for (const [k, text] of s.texts.entries()) {
        const l = { depth: 0, t: 0, h: s.h, tile: { y: (s.y0 / MAP_H) * 100 } as Tile, fill: s.fill, texts: s.texts };
        const c = worstContrast(l, text, ground);
        assert.ok(c >= 4.5, `${theme}, ${what}, ${s.label}, a ${s.h} px tile: its ${k === 0 ? 'name' : 'size'} line in ${String(text.fillStyle)} measures ${fmt(c)}:1 (floor 4.5:1)`);
        assertInkWeight(text, lineEnds(l, text, ground), `${theme}, ${what}, ${s.label}, a ${s.h} px tile`);
        lines++;
      }
    }
  }
  assert.ok(lines >= expectLines, `${what}: ${lines} lines measured`);
}

test('G09: a tile\'s name and size reach 4.5:1 on every colour the map paints — Age, every Reclaim score, "not scored", the History diff and the Trash cell', () => {
  const leaves = [
    ...OTHER_COLOURS.flatMap((c) => SWEEP_HEIGHTS.map((h) => ({ label: c.name, rgb: c.rgb, h }))),
    ...SWEEP_HEIGHTS.map((h) => ({ label: 'the Trash cell', trash: true, h })),
  ];
  const swept = sweep(leaves);
  for (const s of swept) assert.ok(s.texts.length >= 1, `${s.label}, ${s.h} px: the tile is labelled`);
  assertLegible(swept, 'colour mode', 2 * leaves.length);
});

test('G09: a label written below its folder\'s name tag reaches 4.5:1 too — on the size ramp and on every other colour', () => {
  const heights = [40, 42, 44, 48, 51, 53, 56, 60, 66, 74, 90, 120, 200]; // a folder 44 px or taller carries a tag
  const colours = [...STEPS.map((s) => ({ name: `ramp ${s.t}`, rgb: ramp.sizeRgb(s.bytes) })), ...OTHER_COLOURS];
  const leaves = colours.flatMap((c) => heights.map((h) => ({ label: c.name, rgb: c.rgb, h, inFolder: true })));
  const swept = sweep(leaves);
  for (const s of swept) {
    assert.ok(s.texts.length >= 1, `${s.label}, ${s.h} px: the tile is labelled`);
    assert.ok(s.texts[0].y - s.y0 >= 20, `${s.label}, ${s.h} px: below its folder's tag (${fmt(s.texts[0].y - s.y0)} px down)`);
  }
  assertLegible(swept, 'below a folder tag', 2 * leaves.length);
});

test('G09: the cushion gives way only where a label needs it — a size-ramp tile keeps the whole cushion an unlabelled tile of its height gets', () => {
  // The owner's map is cushioned; legibility may ease a tile's cushion,
  // never flatten the ramp's tiles, whose labels read at the whole one.
  const twins = sweep(LABELLED.map((l) => ({ label: `ramp ${l.t}`, rgb: ramp.sizeRgb(STEPS.find((s) => s.t === l.t)!.bytes), h: l.h })));
  const bare = (() => {
    const tiles = LABELLED.map((l, i) => ({ ...tile(i, l.depth, STEPS.find((s) => s.t === l.t)!.bytes, l.h) }));
    return leafFills(paint(tiles), tiles.length);
  })();
  for (const [k, l] of LABELLED.entries()) {
    assert.ok(twins[k].texts.length >= 1, `ramp ${l.t}, ${l.h} px: labelled`);
    assert.deepEqual(twins[k].fill.stops, bare[k].stops, `ramp ${l.t}, a ${l.h} px tile: labelled, it keeps the cushion an unlabelled tile gets`);
  }
});

test('G09: where the cushion gives way for a label, it eases — a Reclaim "keep" tile 60 px or taller still shades from top to foot', () => {
  const swept = sweep([60, 74, 90, 126, 200].map((h) => ({ label: 'Reclaim score 0', rgb: OTHER_COLOURS[0].rgb, h })));
  for (const s of swept) {
    const top = luminance(at(s.fill, 0, [0, 0, 0])), foot = luminance(at(s.fill, 1, [0, 0, 0]));
    assert.ok(top > foot * 1.08, `${s.h} px: the cushion still runs light to dark (${top.toFixed(3)} → ${foot.toFixed(3)})`);
  }
});

/* ══════════════ G09 — the History diff: a label read through its folder's wash ══════════════ */

/**
 * What the canvas holds at (x, y) as op `upTo` is drawn: every rectangle
 * filled over that point before it, replayed in order over `ground` — the
 * leaf's cushion, then anything laid over it. `leaf` is the last cushion
 * painted there, `grad` its gradient, and `washes` counts the flat fills
 * laid over it since. A cushion is read at `gy` (y unless given): the
 * painter judges a line's foot at the tile's own height, half a pixel below
 * the inset rectangle it fills.
 */
function canvasAt(ops: Op[], upTo: number, x: number, y: number, ground: RGB, gy = y): { rgb: RGB; leaf: number[] | null; grad: Grad | null; washes: number } {
  let rgb = ground, leaf: number[] | null = null, grad: Grad | null = null, washes = 0;
  for (const op of ops.slice(0, upTo)) {
    if (op.kind !== 'rect') continue;
    const [rx, ry, rw, rh] = op.rect;
    if (x < rx || x >= rx + rw || y < ry || y >= ry + rh) continue;
    if (op.style && typeof op.style === 'object') {
      const g = op.style as Grad;
      rgb = at(g, Math.max(0, Math.min(1, (gy - g.args[1]) / (g.args[3] - g.args[1]))), rgb);
      leaf = op.rect;
      grad = g;
      washes = 0;
    } else if (typeof op.style === 'string' && /^(#|rgb)/i.test(op.style)) {
      rgb = over(rgba(op.style), rgb);
      washes++;
    }
  }
  return { rgb, leaf, grad, washes };
}

/** Each line `rec` wrote, with what the canvas held under its top and its foot as it was written. */
function linesAsWritten(rec: ReturnType<typeof recordingCtx>, ground: RGB) {
  const out: Array<{ text: Text; ends: RGB[]; washes: number }> = [];
  for (const [i, op] of rec.ops.entries()) {
    if (op.kind !== 'text' || fontPx(op.text.font) === 10.5) continue; // 10.5 px: a folder's name tag, on its own chip
    const x = op.text.x + 1;
    const top = canvasAt(rec.ops, i, x, op.text.y, ground);
    assert.ok(top.leaf, `"${op.text.text}" is written on a tile`);
    const footGy = Math.min(top.grad!.args[3], op.text.y + fontPx(op.text.font) * LEADING);
    const foot = canvasAt(rec.ops, i, x, Math.min(top.leaf![1] + top.leaf![3] - 0.01, footGy), ground, footGy);
    out.push({ text: op.text, ends: [top.rgb, foot.rgb], washes: Math.min(top.washes, foot.washes) });
  }
  return out;
}

const DIFF_PAGE = load<{ diffRgb: (n: object) => RGB }>(['diffRgb'], {}, '{ diffRgb }', (c) => {
  for (const prevSize of [5e9, 1e9, 2e10, null]) c.diffRgb({ size: 5e9, prevSize });
});
/** A node's earlier size for each History diff colour (diffRgb decides the colour from it). */
const PREV: Record<string, (size: number) => number | null> = {
  unchanged: (s) => s, grew: (s) => s / 4, shrank: (s) => s * 4, new: () => null,
};

/**
 * A History map with every diff colour: folders that grew, shrank, are new
 * or are unchanged — alone and one inside another — each holding one leaf of
 * every kind, in the folder's corner below its tag and clear of it, at every
 * label height. Each node carries the prevSize the diff is drawn from.
 */
function diffMap() {
  const folderSets = [['grew'], ['shrank'], ['new'], ['unchanged'], ['grew', 'shrank'], ['shrank', 'grew'], ['shrank', 'shrank'], ['grew', 'grew']];
  const heights = [15, 18, 22, 27, 31, 36, 40, 44, 48, 53, 56, 60, 65, 68, 71, 74, 77, 87, 110, 126, 170];
  const nodes: Tile[] = [];
  const slots: Array<{ what: string; x: number; y: number }> = [];
  for (const folders of folderSets) for (const kind of Object.keys(PREV)) for (const corner of [true, false]) for (const h of heights) {
    if (corner && h < 36) continue; // below the tag, a label needs 36 px of tile
    const i = slots.length, x = (i % 10) * 100, y = Math.floor(i / 10) * 210;
    const off = corner ? 2 : 30;  // in the folder's top-left corner, or clear of its tag
    const fh = off + h + 4;
    folders.forEach((f, d) => nodes.push({ name: `D${i}.${d}`, path: `/r/d${i}${'/in'.repeat(d)}`, size: 2e10, prevSize: PREV[f](2e10), type: 'dir', depth: d + 1, expanded: true,
      x: ((x + d) / MAP_W) * 100, y: ((y + d) / MAP_H) * 100, w: ((100 - 2 * d) / MAP_W) * 100, h: ((fh - 2 * d) / MAP_H) * 100 } as Tile));
    nodes.push({ name: `file-${i}.mov`, path: `/r/d${i}/file-${i}.mov`, size: 5e9, prevSize: PREV[kind](5e9), type: 'file', depth: folders.length + 1, expanded: false,
      x: ((x + 2) / MAP_W) * 100, y: ((y + off) / MAP_H) * 100, w: (96 / MAP_W) * 100, h: (h / MAP_H) * 100 } as Tile);
    slots.push({ what: `${folders.join(' › ')} folder, ${kind} leaf, ${corner ? 'below the tag' : 'mid-folder'}, ${h} px`, x: x + 2, y });
  }
  return { nodes, slots };
}

test('G09: in the History diff, a label in a folder that grew, shrank or is new reaches 4.5:1 on its tile as the folder\'s wash leaves it — mid-folder, below the folder\'s tag, and under two washes', () => {
  // Pass 2.5 lays a 30% wash of the folder's own diff colour over every
  // expanded folder that changed, its leaves included, after pass 1 painted
  // them and before pass 4 writes their labels — so a label is read on its
  // cushion seen through that wash, not on the cushion alone. Chosen against
  // the cushion alone, the unchanged grey leaf in the corner of a folder
  // that grew took white at 4.64:1 and measured 3.67:1 under the teal wash
  // (review F2.1). What is measured here is the canvas itself: every fill
  // over the label's top and foot, replayed in the order it was drawn.
  // Two washes of one colour too: under red › red the grey leaf below the
  // tag reads at 4.5:1 only where its cushion eases for the washed colour.
  const { nodes, slots } = diffMap();
  const rec = paint(nodes, (n) => DIFF_PAGE.diffRgb(n), { active: true, diff: true });
  const whatAt = (t: Text) => slots.find((s) => Math.abs(t.x - (s.x + 5)) < 0.01 && t.y >= s.y && t.y < s.y + 210)!.what;
  const washed = [0, 0, 0];
  for (const [theme, ground] of THEMES) {
    for (const line of linesAsWritten(rec, ground)) {
      const ink = rgba(String(line.text.fillStyle));
      const c = Math.min(...line.ends.map((under) => contrast(over(ink, under), under)));
      assert.ok(c >= 4.5, `${theme}, ${whatAt(line.text)}: "${line.text.text}" in ${String(line.text.fillStyle)} measures ${fmt(c)}:1 on its tile under ${line.washes} wash(es) (floor 4.5:1)`);
      assertInkWeight(line.text, line.ends, `${theme}, ${whatAt(line.text)}, under ${line.washes} wash(es)`);
      washed[Math.min(2, line.washes)]++;
    }
  }
  assert.ok(washed[1] > 400 && washed[2] > 200 && washed[0] > 100,
    `labels were measured with no wash (${washed[0]}), one (${washed[1]}) and two (${washed[2]}) over them`);
});

/** The see-through flat fills laid over the map after its ground: the History diff's washes (a folder's bands are opaque). */
const washesOn = (rec: ReturnType<typeof paint>) => rec.ops.slice(1)
  .filter((op): op is Extract<Op, { kind: 'rect' }> => op.kind === 'rect' && typeof op.style === 'string' && rgba(op.style)[3] < 1)
  .map((op) => `${op.rect.map((v) => v.toFixed(1)).join(' ')} ${String(op.style)}`);
/** Outside the diff the map is drawn as the live map is: History played back without it, or a diff flag left on after it. */
const NOT_THE_DIFF = [{ active: true, diff: false }, { active: false, diff: true }];
/** `nodes` as the live map holds them: no earlier size, so nothing a wash could be drawn from. */
const withoutPrev = (nodes: Tile[]) => nodes.map((n) => Object.fromEntries(Object.entries(n).filter(([k]) => k !== 'prevSize')) as Tile);
/** Each node's History diff colour, fixed by its path so that it outlives withoutPrev. */
function colourOf(nodes: Tile[]): (n: Tile) => RGB {
  const byPath = new Map(nodes.map((n) => [n.path, DIFF_PAGE.diffRgb(n)]));
  return (n) => byPath.get(n.path)!;
}

test('G09: the History diff\'s wash is laid only while the diff is on — History played back without it, or a diff flag left over on the live map, paints what the live map paints, each label judged on its cushion alone', () => {
  // Every node /api/snapshots/tree serves carries a prevSize, so a History
  // view with Diff off holds folders that grew and shrank; only the guard in
  // tmDiffWashes keeps their wash off the map, out of the ink and out of the
  // cushion's ease. Every History paint the suite ran was {active, diff}, so
  // dropping either half of that guard left it green (review F3.2).
  // The reference is the same map as the live map holds it — no prevSize,
  // each tile in the same colour — so a wash drawn from prevSize anywhere,
  // in any mode, shows as a difference.
  const { nodes } = diffMap();
  const colour = colourOf(nodes);
  assert.ok(washesOn(paint(nodes, colour, { active: true, diff: true })).length > 100,
    'in the History diff these folders are washed — the map below is one a wash would land on');
  const live = JSON.stringify(paint(withoutPrev(nodes), colour, { active: false, diff: false }).ops);
  for (const history of NOT_THE_DIFF) {
    const where = `history ${JSON.stringify(history)}`;
    const rec = paint(nodes, colour, history);
    assert.deepEqual(washesOn(rec), [], `${where}: no wash is laid over any folder`);
    const leaves = rec.px.filter((r) => r.stops);
    assert.ok(leaves.length > 500, `${where}: the leaves were painted (${leaves.length})`);
    for (const r of leaves) assert.deepEqual(r.seen, r.stops, `${where}: ${r.n.name}'s label is judged on the cushion painted, through no wash`);
    assert.ok(JSON.stringify(rec.ops) === live, `${where}: every cushion, label and ink is the one the live map paints`);
  }
});

/* ══════════════ G01/G09 — the SVG export is the map's own recipe ══════════════ */

/**
 * The PNG export copies the canvas, but the SVG export drew the map again
 * with the retired recipe: each leaf at fill-opacity 0.95 × max(0.55,
 * 1 − 0.08·depth) of sizeRgb over the page, its labels fixed black at
 * 0.78/0.55 — a depth-4 9.1 GB tile came out the pastel/maroon wash at
 * 2.87:1 (review F1.3, F1.9). The real exportTreemapSVG runs here over the
 * pxRects the real drawTreemap left, and its SVG is read back.
 */
function exportSvg(tiles: Tile[], colour: (n: Tile) => RGB, ground: string, history = { active: false, diff: false }, palette?: Record<string, string>) {
  const state = { treemap: { nodes: tiles, hideCloud: false, rootSize: 1e12, history, pxRects: [] as any[],
    colorMode: 'size', mode: 'treemap', query: '', rootName: 'r' } };
  const rec = recordingCtx();
  const common = {
    $: () => ({ clientWidth: MAP_W + 20 }), treemapCanvasHeight: () => MAP_H, window: { devicePixelRatio: 1 },
    tmCanvas: { style: {}, width: 0, height: 0 }, tmBuffer: { width: MAP_W, height: MAP_H }, tmBufCtx: rec.ctx,
    cssVar: (name: string) => (palette ? palette[name] ?? '' : name === '--bg-1' ? ground : 'rgba(0,0,0,0.3)'),
    state,
    tmNodeCapNote: () => '', renderAltNote() {}, tmSetEmpty() {}, renderSearchOverlay() {}, presentTreemap() {}, renderTmLegend() {},
    cellRgb: colour, sizeRgb: () => [255, 0, 255], tmHatchPattern: () => null, tmPreview: { on: false }, roundRect() {},
    formatBytes: (n: number) => `${Math.round(n)} B`,
  };
  const draw = load<() => void>(['drawTreemap'], common, 'drawTreemap', (d) => d());
  rec.fills.length = 0;
  rec.texts.length = 0;
  rec.ops.length = 0;
  rec.strokes.length = 0; // one clean paint's strokes, as its fills (the outline tests compare them with the SVG's)
  draw();
  let svg = '';
  const exp = load<() => void>(['exportTreemapSVG'], {
    ...common,
    Blob: class { constructor(parts: string[]) { svg = parts.join(''); } },
    downloadBlob() {}, exportFileName: () => 'map.svg', toast() {},
  }, 'exportTreemapSVG', (e) => e());
  svg = '';
  exp();
  return { svg, rec, px: state.treemap.pxRects };
}

/** `name="value"` attributes of one tag. */
const attrs = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

test('G01/G09: the SVG export paints each leaf as the canvas does — opaque, in the colour the map is showing, with the canvas\'s own cushion', () => {
  // cellRgb paints this map; sizeRgb, which the old export used, would be magenta.
  const tiles = [
    { ...tile(0, 4, 9.1e9, 200), w: 9.6 },
    { ...tile(1, 2, 5e8, 60), x: 12, w: 9.6 },
    { ...tile(2, 6, 3e7, 120), x: 24, w: 9.6 },
  ];
  const colours: RGB[] = [[255, 72, 57], [90, 100, 114], [48, 209, 88]];
  const { svg, rec, px } = exportSvg(tiles, (n) => colours[tiles.findIndex((t) => t.path === n.path)], '#0e0e13');
  const canvas = leafFills(rec, tiles.length, px);
  const leaves = [...svg.matchAll(/<rect [^>]*><title>[^<]*<\/title><\/rect>/g)].map((m) => attrs(m[0]));
  assert.equal(leaves.length, tiles.length, 'one rectangle per leaf');
  for (const [k, a] of leaves.entries()) {
    assert.ok(!('fill-opacity' in a) || Number(a['fill-opacity']) === 1, `leaf ${k} is opaque (fill-opacity ${a['fill-opacity']})`);
    const id = /^url\(#([\w-]+)\)$/.exec(a.fill ?? '')?.[1];
    assert.ok(id, `leaf ${k} is filled with a gradient, as the canvas cushion is (fill ${a.fill})`);
    const grad = new RegExp(`<linearGradient id="${id}"[^>]*>([\\s\\S]*?)</linearGradient>`).exec(svg);
    assert.ok(grad, `its gradient #${id} is defined`);
    const stops = [...grad![1].matchAll(/<stop [^>]*>/g)].map((m) => attrs(m[0])).map((s) => [Number(s.offset), s['stop-color']]);
    assert.deepEqual(stops, canvas[k].stops, `leaf ${k}: the SVG's cushion is the canvas's (${JSON.stringify(stops)})`);
    const g = attrs(/<linearGradient [^>]*>/.exec(grad![0])![0]);
    assert.equal(g.gradientUnits, 'userSpaceOnUse', 'laid over the tile\'s own height, as on the canvas');
    assert.equal(Number(g.y1), canvas[k].args[1]);
    assert.equal(Number(g.y2), canvas[k].args[3]);
  }
});

test('G09: the SVG export writes each label in the ink, and at the place, the canvas wrote it — 4.5:1 on the tile', () => {
  // The last leaf sits in its folder's top-left corner, so its label is
  // written below the folder's name tag.
  const folder: Tile = { name: 'Folder', path: '/r/d', size: 1e10, type: 'dir', depth: 1, expanded: true, x: 40, y: 0, w: 10, h: 8 };
  const leaves = [
    { ...tile(0, 4, 9.1e9, 200), w: 9.6 },
    { ...tile(1, 2, 5e8, 74), x: 12, w: 9.6 },
    { ...tile(2, 3, 3e7, 40), x: 24, w: 9.6 },
    { ...tile(3, 2, 2e9, 74), x: 40.2, y: 0.2, w: 9.6 },
  ];
  const tiles = [...leaves.slice(0, 3), folder, leaves[3]];
  const colours: RGB[] = [[255, 72, 57], [90, 100, 114], [10, 30, 160], [255, 69, 58]];
  const { svg, rec, px } = exportSvg(tiles, (n) => colours[leaves.findIndex((t) => t.path === n.path)] ?? [0, 0, 0], '#0e0e13');
  const canvas = leafFills(rec, leaves.length, px);
  const written = [...svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map((m) => ({ a: attrs(m[1]), text: m[2] }));
  const shifted = rec.texts.find((tx) => tx.text === leaves[3].name);
  assert.ok(shifted && shifted.y - 2 >= 20, `the cornered leaf is labelled below its folder's tag (${shifted && shifted.y} px down)`);
  for (const [k, t] of leaves.entries()) {
    const x = (t.x / 100) * MAP_W, y0 = (t.y / 100) * MAP_H, h = (t.h / 100) * MAP_H;
    const onCanvas = rec.texts.filter((tx) => Math.abs(tx.x - (x + 5)) < 0.01);
    const inSvg = written.filter((w) => Math.abs(Number(w.a.x) - (x + 5)) < 0.06);
    assert.ok(onCanvas.length >= 1, `leaf ${k} is labelled on the canvas`);
    assert.deepEqual(inSvg.map((w) => w.text), onCanvas.map((c) => c.text), `leaf ${k}: the SVG writes the canvas's lines`);
    for (const [j, w] of inSvg.entries()) {
      assert.equal(w.a.fill, String(onCanvas[j].fillStyle), `leaf ${k}, "${w.text}": in the canvas's ink`);
      const top = Number(w.a.y) - Number(fontPx(onCanvas[j].font)) * 0.8;
      assert.ok(Math.abs(top - onCanvas[j].y) <= 1.5, `leaf ${k}, "${w.text}": at the canvas's line (baseline ${w.a.y}, line top ${onCanvas[j].y})`);
      const l = { depth: 0, t: 0, h, tile: { y: (y0 / MAP_H) * 100 } as Tile, fill: canvas[k], texts: [] };
      const c = worstContrast(l, { ...onCanvas[j], fillStyle: w.a.fill }, [14, 14, 19]);
      assert.ok(c >= 4.5, `leaf ${k}, "${w.text}" in ${w.a.fill}: ${fmt(c)}:1 on its tile (floor 4.5:1)`);
    }
  }
});

/**
 * Each leaf label the SVG writes, with what the SVG has painted under its
 * top and its foot by then: every rectangle before it, in document order,
 * over `ground` — a gradient fill read from its <linearGradient>, a flat
 * fill at its fill-opacity. A leaf is a rectangle carrying its <title>;
 * the background, the frames and the washes close themselves.
 */
function svgLines(svg: string, ground: RGB) {
  const grads = new Map<string, { y1: number; y2: number; stops: RGB[] }>();
  for (const m of svg.matchAll(/<linearGradient ([^>]*)>([\s\S]*?)<\/linearGradient>/g)) {
    const a = attrs(m[1]);
    grads.set(a.id, { y1: Number(a.y1), y2: Number(a.y2), stops: [...m[2].matchAll(/stop-color="([^"]*)"/g)].map((s) => rgba(s[1]).slice(0, 3) as RGB) });
  }
  const under = (upTo: number, x: number, y: number) => {
    let rgb = ground, leaf: number[] | null = null;
    for (const m of svg.slice(0, upTo).matchAll(/<rect ([^>]*?)(\/?)>/g)) {
      const a = attrs(m[1]);
      const box = ['x', 'y', 'width', 'height'].map((k) => Number(a[k] ?? 0));
      if (a.fill === 'none' || x < box[0] || x >= box[0] + box[2] || y < box[1] || y >= box[1] + box[3]) continue;
      const grad = /^url\(#([\w-]+)\)$/.exec(a.fill)?.[1];
      if (grad) {
        const g = grads.get(grad)!;
        rgb = lerp(g.stops[0], g.stops[1], Math.max(0, Math.min(1, (y - g.y1) / (g.y2 - g.y1))));
      } else {
        const [r, gr, b, al] = rgba(a.fill);
        rgb = over([r, gr, b, al * Number(a['fill-opacity'] ?? 1)], rgb);
      }
      if (m[2] === '') leaf = box;
    }
    return { rgb, leaf };
  };
  const out: Array<{ text: string; fill: string; ends: RGB[] }> = [];
  for (const m of svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)) {
    const a = attrs(m[1]);
    if (a['font-size'] === '10.5') continue; // a folder's name tag, on its own chip
    const fpx = Number(a['font-size']), x = Number(a.x) + 1, top = Number(a.y) - fpx * 0.8;
    const t = under(m.index!, x, top);
    assert.ok(t.leaf, `"${m[2]}" is written on a leaf`);
    const foot = under(m.index!, x, Math.min(t.leaf![1] + t.leaf![3] - 0.01, top + fpx * LEADING));
    out.push({ text: m[2], fill: a.fill, ends: [t.rgb, foot.rgb] });
  }
  return out;
}

/** Three folders — one grew, one shrank, one did not change — each holding leaves, with the prevSize the diff is drawn from. */
function svgDiffTiles(): Tile[] {
  const leaf = (name: string, x: number, y: number, h: number, kind: string): Tile => ({ name, path: `/r/${name}`, size: 5e9, prevSize: PREV[kind](5e9),
    type: 'file', depth: 2, expanded: false, x, y, w: 9.6, h: h / 10 } as Tile);
  const folder = (name: string, x: number, y: number, kind: string): Tile => ({ name, path: `/r/${name}`, size: 2e10, prevSize: PREV[kind](2e10),
    type: 'dir', depth: 1, expanded: true, x, y, w: 40, h: 40 } as Tile);
  return [
    folder('Projects', 0, 0, 'grew'), leaf('keep.bin', 0.2, 0.2, 40, 'unchanged'), leaf('mid.bin', 0.2, 10, 68, 'unchanged'),
    folder('Old', 50, 0, 'shrank'), leaf('grew.bin', 50.2, 0.2, 60, 'grew'), leaf('same.bin', 50.2, 10, 68, 'unchanged'),
    folder('Same', 0, 50, 'unchanged'), leaf('here.bin', 0.2, 50.2, 60, 'unchanged'),
  ];
}

test('G09: the SVG export lays the History diff\'s wash over each folder that grew or shrank, as the canvas does, and its labels read 4.5:1 through it', () => {
  // The canvas picks a label's ink against the cushion seen through its
  // folder's wash (review F2.1); an export that left the wash out would
  // write that ink on a tile it was not chosen for, and lose the diff.
  const tiles = svgDiffTiles();
  const { svg, rec } = exportSvg(tiles, (n) => DIFF_PAGE.diffRgb(n), '#0e0e13', { active: true, diff: true });
  const box = (r: number[]) => r.map((v) => v.toFixed(1)).join(' ');
  const onCanvas = rec.ops.slice(1).filter((op): op is Extract<Op, { kind: 'rect' }> => op.kind === 'rect' && typeof op.style === 'string' && rgba(op.style)[3] < 1)
    .map((op) => `${box(op.rect)} ${rgba(String(op.style)).join(',')}`);
  assert.equal(onCanvas.length, 2, `the canvas washes the two folders that changed, and not the one that did not (${onCanvas.join(' | ')})`);
  const inSvg = [...svg.matchAll(/<rect ([^>]*)\/>/g)].map((m) => attrs(m[1])).filter((a) => 'fill-opacity' in a)
    .map((a) => `${box(['x', 'y', 'width', 'height'].map((k) => Number(a[k])))} ${[...rgba(a.fill).slice(0, 3), Number(a['fill-opacity'])].join(',')}`);
  assert.deepEqual(inSvg, onCanvas, 'the SVG lays the same washes, over the same frames, in the same colours');
  const lines = svgLines(svg, [14, 14, 19]);
  assert.ok(lines.length >= 8, `the leaves' lines are written (${lines.length})`);
  for (const l of lines) {
    const ink = rgba(l.fill);
    const c = Math.min(...l.ends.map((u) => contrast(over(ink, u), u)));
    assert.ok(c >= 4.5, `"${l.text}" in ${l.fill}: ${fmt(c)}:1 on its tile in the SVG (floor 4.5:1)`);
  }
});

test('G09: the SVG export lays the History diff\'s wash only while the diff is on — exported from History without it, or with a diff flag left over on the live map, it is the live map\'s own export', () => {
  // The export lays each wash tmDiffWashes names (review F2.1), so the same
  // guard keeps it out of an export made outside the diff (review F3.2).
  const colour = colourOf(svgDiffTiles());
  const washesIn = (svg: string) => [...svg.matchAll(/<rect ([^>]*)\/>/g)].map((m) => attrs(m[1])).filter((a) => 'fill-opacity' in a);
  assert.equal(washesIn(exportSvg(svgDiffTiles(), colour, '#0e0e13', { active: true, diff: true }).svg).length, 2,
    'in the History diff the export washes the two folders that changed');
  const live = exportSvg(withoutPrev(svgDiffTiles()), colour, '#0e0e13', { active: false, diff: false }).svg;
  for (const history of NOT_THE_DIFF) {
    const where = `history ${JSON.stringify(history)}`;
    const { svg } = exportSvg(svgDiffTiles(), colour, '#0e0e13', history);
    assert.deepEqual(washesIn(svg), [], `${where}: the export lays no wash`);
    assert.ok(svg === live, `${where}: the export is the live map's own, rectangle by rectangle and label by label`);
  }
});

test('G09/G27: the SVG export draws a cloud placeholder hollow and a staged block as an amber dashed outline, as the map does — neither as a cushion — and labels the hollow tile at 4.5:1', () => {
  // Every SVG test exported plain leaves, so the export's two other leaf
  // branches ran under no test: an opaque cloud, a solid one, an undashed
  // one, or a staged block drawn as a cloud all left the suite green
  // (review F2.3). Each is measured against what the canvas drew.
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    const cloud = { ...tile(0, 2, 4e9, 200), w: 9.6, cloudPlaceholder: true } as Tile;
    const staged = { ...tile(1, 2, 3e9, 200), x: 12, w: 9.6, freed: true } as Tile;
    const plain: Tile = { ...tile(2, 2, 2e9, 200), x: 24, w: 9.6 };
    const { svg, rec } = exportSvg([cloud, staged, plain], () => [255, 72, 57], palette['--bg-1'], undefined, palette);
    const leaves = new Map([...svg.matchAll(/<rect ([^>]*)><title>([^<]*?) — [^<]*<\/title><\/rect>/g)].map((m) => [m[2], attrs(m[1])]));
    assert.equal(leaves.size, 3, `one titled rectangle per leaf (${[...leaves.keys()].join(', ')})`);
    const box = (t: Tile) => [(t.x / 100) * MAP_W + 0.5, (t.y / 100) * MAP_H + 0.5, (t.w / 100) * MAP_W - 1, (t.h / 100) * MAP_H - 1];
    const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 0.01);
    const canvasFill = (t: Tile) => rec.ops.find((op) => op.kind === 'rect' && near(op.rect, box(t))) as Extract<Op, { kind: 'rect' }> | undefined;
    const canvasStroke = (t: Tile) => rec.strokes.find((st) => near(st.rect.slice(0, 2), [box(t)[0] + 0.5, box(t)[1] + 0.5]));

    const c = leaves.get(cloud.path)!;
    assert.ok(!/^url\(/.test(c.fill), `${theme}: the cloud placeholder is not a cushion (fill ${c.fill})`);
    const wash = String(canvasFill(cloud)?.style);
    assert.ok(rgba(wash)[3] < 0.5, `${theme}: on the canvas it is a faint wash of its colour (${wash})`);
    assert.deepEqual([...rgba(c.fill).slice(0, 3), Number(c['fill-opacity'])], rgba(wash),
      `${theme}: and in the SVG the same faint wash (fill ${c.fill}, fill-opacity ${c['fill-opacity']})`);
    assert.equal(c.stroke, canvasStroke(cloud)?.style, `${theme}: outlined in the canvas's stroke`);
    assert.ok(c['stroke-dasharray'], `${theme}: dashed, as on the map`);

    const s = leaves.get(staged.path)!;
    assert.equal(s.fill, 'none', `${theme}: the staged block is an outline, not a fill — its space is not freed yet`);
    assert.equal(s.stroke, palette['--warn'], `${theme}: in the theme's amber, --warn`);
    assert.equal(s.stroke, canvasStroke(staged)?.style, `${theme}: as the canvas outlines it`);
    assert.ok(s['stroke-dasharray'], `${theme}: dashed, as on the map`);

    assert.match(leaves.get(plain.path)!.fill, /^url\(#/, `${theme}: a tile on this disk is still a cushion`);

    const lines = svgLines(svg, rgba(palette['--bg-1']).slice(0, 3) as RGB).filter((l) => l.text === cloud.name || l.text === `${cloud.size} B`);
    assert.equal(lines.length, 2, `${theme}: the hollow tile carries its name and size`);
    for (const l of lines) {
      const ink = rgba(l.fill);
      const ratio = Math.min(...l.ends.map((u) => contrast(over(ink, u), u)));
      assert.ok(ratio >= 4.5, `${theme}: "${l.text}" in ${l.fill} measures ${fmt(ratio)}:1 on the hollow tile over the page (floor 4.5:1)`);
    }
  }
});

/* ══════════════ The owner's outline decision (20 Oct 2026), and a folder's uncovered area (J51) ══════════════ */

/**
 * "The maps outlines should be contrasting and easy to see" — the owner, 20 Oct 2026. It outranks BQG-5
 * item 14's fading, which left a nested folder's outline at a quarter of black and a small leaf's at 0.35
 * over a gap of the map's ground: too faint to see on a tile, and a near-black grid between small tiles
 * (QA read 8.5–8.9% near-black in a dense corner of the dark map, where this file's old dense corner
 * claimed 1.4%). Everything below is measured on rendered pixels — the real drawTreemap rasterized — in
 * both themes:
 *   - every leaf outline and every folder band at EDGE_BAR (WCAG's 3:1 for a non-text edge) or better
 *     against the tile beside it, across the whole size ramp and every other colour the map paints;
 *   - folder bands heavier and higher-contrast than leaf outlines;
 *   - the colour still popping inside every tile;
 *   - a realistic dense map (the server's own layout of a /System/Library-like tree) not a black mesh;
 *   - a folder's area no rectangle covers (its files under the 4 KB floor, J51) in the folder's own
 *     colour and cushion, never the map's ground.
 */

/** WCAG's bar for a non-text edge, and the owner's. */
const EDGE_BAR = 3;

/**
 * A 2D context that rasterizes what the painter asks for onto a `W`×`H` grid of pixels, starting from
 * `ground`: rectangles filled and stroked, axis-aligned path strokes, flat colours and vertical
 * gradients, each at its own alpha and globalAlpha, with partial pixels covered by area. Text and
 * patterns are not drawn: what is measured here is the tiles and the lines between them.
 */
function rasterCtx(W: number, H: number, ground: RGB) {
  const px = new Float64Array(W * H * 3);
  for (let i = 0; i < W * H; i++) px.set(ground, i * 3);
  const st: Record<string, any> = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1 };
  const saved: Array<Record<string, any>> = [];
  let path: number[][] = [];
  const colourAt = (style: any, y: number): RGBA => {
    if (style && typeof style === 'object' && style.stops) {
      const g = style as Grad;
      const [, y0, , y1] = g.args;
      const t = Math.max(0, Math.min(1, (y - y0) / ((y1 - y0) || 1)));
      const stops = [...g.stops].sort((a, b) => a[0] - b[0]);
      const lo = stops.filter(([o]) => o <= t).pop() ?? stops[0];
      const hi = stops.find(([o]) => o >= t) ?? stops[stops.length - 1];
      const a = rgba(lo[1]), b = rgba(hi[1]);
      const k = hi[0] === lo[0] ? 0 : (t - lo[0]) / (hi[0] - lo[0]);
      return a.map((v, i) => v + (b[i] - v) * k) as RGBA;
    }
    return rgba(String(style));
  };
  const paintRect = (x: number, y: number, w: number, h: number, style: any) => {
    if (!(w > 0 && h > 0)) return;
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(H, Math.ceil(y + h)); py++) {
      const cy = Math.min(py + 1, y + h) - Math.max(py, y);
      const c = colourAt(style, py + 0.5);
      for (let pxx = Math.max(0, Math.floor(x)); pxx < Math.min(W, Math.ceil(x + w)); pxx++) {
        const cx = Math.min(pxx + 1, x + w) - Math.max(pxx, x);
        const a = c[3] * Number(st.globalAlpha) * cx * cy;
        const o = (py * W + pxx) * 3;
        for (let i = 0; i < 3; i++) px[o + i] = px[o + i] * (1 - a) + c[i] * a;
      }
    }
  };
  const strokeEdges = (x: number, y: number, w: number, h: number) => {
    const lw = Number(st.lineWidth), s = st.strokeStyle;
    paintRect(x - lw / 2, y - lw / 2, w + lw, lw, s);
    paintRect(x - lw / 2, y + h - lw / 2, w + lw, lw, s);
    paintRect(x - lw / 2, y + lw / 2, lw, h - lw, s);
    paintRect(x + w - lw / 2, y + lw / 2, lw, h - lw, s);
  };
  const props: Record<string, unknown> = {
    font: '10px sans-serif',
    measureText: (t: string) => ({ width: String(t).length * 6 }),
    createLinearGradient: (...args: number[]) => {
      const g: Grad = { kind: 'linear', args, stops: [] };
      return Object.assign(g, { addColorStop: (o: number, c: string) => { g.stops.push([o, c]); } });
    },
    createPattern: () => null,
    fillRect: (x: number, y: number, w: number, h: number) => paintRect(x, y, w, h, st.fillStyle),
    strokeRect: (x: number, y: number, w: number, h: number) => strokeEdges(x, y, w, h),
    // A cleared pixel shows what is behind the canvas: the map's own ground.
    clearRect: (x: number, y: number, w: number, h: number) => {
      const keep = st.globalAlpha;
      st.globalAlpha = 1;
      paintRect(x, y, w, h, `rgb(${ground.join(',')})`);
      st.globalAlpha = keep;
    },
    beginPath: () => { path = []; },
    moveTo: (x: number, y: number) => { path.push([x, y]); },
    lineTo: (x: number, y: number) => {
      const [x0, y0] = path[path.length - 1];
      path.push([x, y]);
      (path as any).segs = [...((path as any).segs || []), [x0, y0, x, y]];
    },
    stroke: () => {
      const lw = Number(st.lineWidth);
      for (const [x0, y0, x1, y1] of ((path as any).segs || []) as number[][]) {
        if (y0 === y1) paintRect(Math.min(x0, x1), y0 - lw / 2, Math.abs(x1 - x0), lw, st.strokeStyle);
        else if (x0 === x1) paintRect(x0 - lw / 2, Math.min(y0, y1), lw, Math.abs(y1 - y0), st.strokeStyle);
      }
    },
    save: () => { saved.push({ ...st }); },
    restore: () => { Object.assign(st, saved.pop()); },
  };
  const ctx: any = new Proxy(props, {
    get(t, k: string) { if (k in t) return t[k]; if (k in st) return st[k]; return () => {}; },
    set(t, k: string, v) { st[k] = v; return true; },
  });
  /** The share of pixels darker than relative luminance `under` — black mesh, gaps and the ground showing. */
  const nearBlack = (under: number) => {
    let n = 0;
    for (let i = 0; i < W * H; i++) if (luminance([px[i * 3], px[i * 3 + 1], px[i * 3 + 2]] as RGB) < under) n++;
    return n / (W * H);
  };
  return { ctx, nearBlack, W, H, at: (x: number, y: number) => [0, 1, 2].map((i) => px[(Math.round(y) * W + Math.round(x)) * 3 + i]) as RGB };
}

type Band = { x: number; y: number; w: number; h: number; rgb: string };
/** A rectangle as drawTreemap leaves it in pxRects, with what it recorded painting it. */
type Painted = { n: Tile; x: number; y: number; w: number; h: number; frame: boolean; edge?: string; lit?: boolean; stops?: RGB[]; fillRgb?: RGB; bg?: RGB[]; bands?: Band[] };

/** `tiles` painted by the real drawTreemap onto a `W`×`H` raster in `palette`'s theme. */
function rasterPaint(tiles: Tile[], palette: Record<string, string>, W: number, H: number,
  colour: (n: Tile) => RGB = (n) => ramp.sizeRgb(n.size), history = { active: false, diff: false }, hideCloud = false) {
  const raster = rasterCtx(W, H, canvasGround(palette));
  const state = { treemap: { nodes: tiles, hideCloud, rootSize: 1e12, history, pxRects: [] as Painted[], colorMode: 'size', mode: 'treemap', query: '' } };
  const deps = {
    $: () => ({ clientWidth: W + 20 }), treemapCanvasHeight: () => H, window: { devicePixelRatio: 1 },
    tmCanvas: { style: {}, width: 0, height: 0 }, tmBuffer: { width: 0, height: 0 }, tmBufCtx: raster.ctx,
    // The grid already starts from the map's real ground, so the painter's own fill of it changes nothing.
    cssVar: (name: string) => (name === '--tm-canvas-bg' ? 'rgba(0,0,0,0)' : palette[name] ?? 'rgba(0,0,0,0)'),
    state, tmNodeCapNote: () => '', renderAltNote() {}, tmSetEmpty() {}, renderSearchOverlay() {}, presentTreemap() {}, renderTmLegend() {},
    cellRgb: colour, tmHatchPattern: () => null, tmPreview: { on: false }, roundRect() {},
    formatBytes: (n: number) => `${Math.round(n)} B`,
  };
  // Resolving the helpers runs the painter; the grid is measured after one clean paint of its own.
  load<() => void>(['drawTreemap'], { ...deps, tmBufCtx: recordingCtx().ctx }, 'drawTreemap', (draw) => draw());
  load<() => void>(['drawTreemap'], deps, 'drawTreemap', (draw) => draw());
  return { raster, px: state.treemap.pxRects };
}

/** A leaf the owner's rule outlines: 8 px or more on each side. */
const OUTLINED_PX = 8;
/** The band a folder is framed by, as the owner's rule has it: 2 px at the top level, 1 px inside it (never over a third of the folder). */
const bandOf = (r: { w: number; h: number; n: Tile }) => Math.max(1, Math.min(r.n.depth <= 1 ? 2 : 1, Math.floor(Math.min(r.w, r.h) / 3)));
/** A painted rectangle on whole pixels (the painter lays them there; a painter that did not is measured where its rectangles round to). */
const whole = (r: Painted): Painted => ({ ...r, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.x + r.w) - Math.round(r.x), h: Math.round(r.y + r.h) - Math.round(r.y) });

/**
 * Every place a line meets a tile, as the raster shows it: [the line's pixel, the tile's pixel beside
 * it, what and where]. Where the lines are is the owner's rule, not what the painter recorded: each
 * leaf of OUTLINED_PX and up, along each side (its own outline, or the folder band laid over it where
 * it lies along its folder's edge); each folder's band (bandOf), along its inner edge, where a tile — a
 * leaf's inside, or the folder's own fill — lies beside it. Two pixels are left out at each end of a
 * side, where lines meet lines.
 */
function edgesOf(painted: Painted[], W: number, H: number) {
  const px = painted.map(whole);
  const line = new Uint8Array(W * H);
  const mark = (x: number, y: number, w: number, h: number) => {
    for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) line[yy * W + xx] = 1;
  };
  const ring = (x: number, y: number, w: number, h: number, t: number) => { mark(x, y, w, t); mark(x, y + h - t, w, t); mark(x, y, t, h); mark(x + w - t, y, t, h); };
  for (const r of px) if (r.frame) ring(r.x, r.y, r.w, r.h, bandOf(r));
  const outlined = (r: Painted) => !r.frame && !!r.stops && Math.min(r.w, r.h) >= OUTLINED_PX;
  for (const r of px) if (outlined(r)) ring(r.x, r.y, r.w, r.h, 1);
  const isLine = (x: number, y: number) => x < 0 || y < 0 || x >= W || y >= H || line[y * W + x] === 1;
  const out: Array<{ line: [number, number]; tile: [number, number]; what: string; kind: 'leaf' | 'frame'; r: Painted }> = [];
  // Inward from (x, y) along (dx, dy): the last line pixel and the first tile pixel.
  const inward = (x: number, y: number, dx: number, dy: number): { line: [number, number]; tile: [number, number] } | null => {
    let k = 0;
    while (k < 4 && isLine(x + dx * k, y + dy * k)) k++;
    if (k === 0 || k === 4) return null;
    return { line: [x + dx * (k - 1), y + dy * (k - 1)], tile: [x + dx * k, y + dy * k] };
  };
  for (const r of px) {
    if (!outlined(r)) continue;
    const what = `${r.n.path} (${r.w}×${r.h} px)`;
    for (let y = r.y + 2; y <= r.y + r.h - 3; y++) {
      for (const [x, dx, side] of [[r.x, 1, 'left'], [r.x + r.w - 1, -1, 'right']] as const) {
        const e = inward(x, y, dx, 0);
        if (e) out.push({ ...e, what: `${what}, ${side} side`, kind: 'leaf', r });
      }
    }
    for (let x = r.x + 2; x <= r.x + r.w - 3; x++) {
      for (const [y, dy, side] of [[r.y, 1, 'top'], [r.y + r.h - 1, -1, 'bottom']] as const) {
        const e = inward(x, y, 0, dy);
        if (e) out.push({ ...e, what: `${what}, ${side} side`, kind: 'leaf', r });
      }
    }
  }
  for (const r of px) {
    if (!r.frame) continue;
    const lw = bandOf(r);
    const what = `folder ${r.n.path} (depth ${r.n.depth})`;
    const at = (lx: number, ly: number, tx: number, ty: number, side: string) => {
      if (isLine(tx, ty)) return; // a nested line meets the band here
      out.push({ line: [lx, ly], tile: [tx, ty], what: `${what}, ${side} band`, kind: 'frame', r });
    };
    for (let y = r.y + lw + 2; y <= r.y + r.h - lw - 3; y++) {
      at(r.x + lw - 1, y, r.x + lw, y, 'left');
      at(r.x + r.w - lw, y, r.x + r.w - lw - 1, y, 'right');
    }
    for (let x = r.x + lw + 2; x <= r.x + r.w - lw - 3; x++) {
      at(x, r.y + lw - 1, x, r.y + lw, 'top');
      at(x, r.y + r.h - lw, x, r.y + r.h - lw - 1, 'bottom');
    }
  }
  return out;
}

/** The weakest line-against-tile contrast in each `kind`, and every place under the bar. */
function measureEdges(raster: ReturnType<typeof rasterCtx>, px: Painted[]) {
  const edges = edgesOf(px, raster.W, raster.H);
  const under: string[] = [];
  const worst = { leaf: Infinity, frame: Infinity };
  for (const e of edges) {
    const c = contrast(raster.at(...e.line), raster.at(...e.tile));
    worst[e.kind] = Math.min(worst[e.kind], c);
    if (c < EDGE_BAR && under.length < 12) under.push(`${e.what}: ${fmt(c)}:1 (${raster.at(...e.line).map(Math.round)} on ${raster.at(...e.tile).map(Math.round)})`);
  }
  return { edges, worst, under };
}

/**
 * Every colour in its own block: a top-level folder holding, in its top-left corner, a nested folder
 * exactly tiled by a 3×3 grid of `lw`×`lh` leaves, with 6 px of the top-level folder's own fill to its
 * right and below — all in that colour — in the server's breadth-first order. The top-level band lies
 * over the nested folder along their shared edges and over its own fill elsewhere; the middle leaf of
 * each grid touches no folder edge, so its outline alone separates it.
 */
function colourBlocks(colours: Array<{ name: string; rgb: RGB; prev?: (s: number) => number | null }>, lw: number, lh: number) {
  const bw = 3 * lw + 10, bh = 3 * lh + 10, cols = Math.ceil(Math.sqrt(colours.length));
  const W = cols * bw, H = Math.ceil(colours.length / cols) * bh;
  const tops: Tile[] = [], nests: Tile[] = [], leaves: Tile[] = [];
  const colourOf = new Map<string, RGB>();
  const pct = (v: number, of: number) => (v / of) * 100;
  for (const [i, c] of colours.entries()) {
    const x = (i % cols) * bw, y = Math.floor(i / cols) * bh;
    const t: Tile = { name: `T${i}`, path: `/m/t${i}`, size: 5e9, type: 'dir', depth: 1, expanded: true, x: pct(x, W), y: pct(y, H), w: pct(3 * lw + 6, W), h: pct(3 * lh + 6, H) };
    const n: Tile = { name: `N${i}`, path: `/m/t${i}/n`, size: 4e9, type: 'dir', depth: 2, expanded: true, x: pct(x, W), y: pct(y, H), w: pct(3 * lw, W), h: pct(3 * lh, H) };
    for (const tile of [t, n]) { if (c.prev) (tile as any).prevSize = c.prev(tile.size); colourOf.set(tile.path, c.rgb); tops.push(tile); }
    for (let k = 0; k < 9; k++) {
      const l: Tile = { name: `f${k}`, path: `/m/t${i}/n/f${k}`, size: 4e8, type: 'file', depth: 3, expanded: false,
        x: pct(x + (k % 3) * lw, W), y: pct(y + Math.floor(k / 3) * lh, H), w: pct(lw, W), h: pct(lh, H) };
      if (c.prev) (l as any).prevSize = c.prev(l.size);
      colourOf.set(l.path, c.rgb);
      leaves.push(l);
    }
  }
  const byDepth = [...tops.filter((t) => t.depth === 1), ...tops.filter((t) => t.depth === 2), ...leaves];
  return { tiles: byDepth, W, H, colour: (n: Tile) => colourOf.get(n.path)!, nameOf: (path: string) => colours[Number(/^\/m\/t(\d+)/.exec(path)![1])].name };
}

const RAMP_COLOURS = STEPS.map((s) => ({ name: `size ramp ${s.t}`, rgb: ramp.sizeRgb(s.bytes) }));
const EVERY_COLOUR = [...RAMP_COLOURS, ...OTHER_COLOURS, { name: 'the Trash cell', rgb: [108, 122, 137] as RGB }];
/** Leaf shapes from the smallest with an outline (8 px) to a tall tile with its whole cushion, and a wide one. */
const LEAF_SHAPES: Array<[number, number]> = [[8, 8], [9, 12], [16, 16], [12, 64], [64, 12]];

test('owner\'s outlines: every leaf outline and every folder band reaches 3:1 against the tile beside it, on rendered pixels — every leaf size from 8 px, the whole size ramp, Age, every Reclaim score, "not scored", the History diff colours and the Trash cell, in both themes', () => {
  let measured = 0;
  for (const [lw, lh] of LEAF_SHAPES) {
    const b = colourBlocks(EVERY_COLOUR, lw, lh);
    for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
      const { raster, px } = rasterPaint(b.tiles, palette, b.W, b.H, b.colour);
      const m = measureEdges(raster, px);
      assert.ok(m.edges.filter((e) => e.kind === 'leaf').length > EVERY_COLOUR.length * 9 * 8, `${theme}, ${lw}×${lh} leaves: control — every leaf's sides were measured`);
      assert.ok(m.edges.filter((e) => e.kind === 'frame').length > EVERY_COLOUR.length * 8, `${theme}, ${lw}×${lh} leaves: control — every folder's bands were measured`);
      assert.deepEqual(m.under, [], `${theme}, ${lw}×${lh} leaves: lines under ${EDGE_BAR}:1 against the tile beside them`);
      measured += m.edges.length;
    }
  }
  assert.ok(measured > 50000, `${measured} places measured`);
});

test('owner\'s outlines: in the History diff a line is measured as the screen shows it, through each folder\'s wash — 3:1 in a folder that grew, shrank, is new or is unchanged, in both themes', () => {
  const kinds = Object.keys(PREV);
  const colours = kinds.flatMap((folder) => kinds.map((leaf) => ({ name: `${leaf} leaf in a ${folder} folder`, rgb: [0, 0, 0] as RGB, folder, leaf })));
  const b = colourBlocks(colours.map((c) => ({ name: c.name, rgb: c.rgb })), 16, 16);
  // The diff colours come from each node's earlier size: the folders' from their kind, the leaves' from theirs.
  for (const t of b.tiles) {
    const c = colours[Number(/^\/m\/t(\d+)/.exec(t.path)![1])];
    (t as any).prevSize = PREV[t.type === 'dir' ? c.folder : c.leaf](t.size);
  }
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    const { raster, px } = rasterPaint(b.tiles, palette, b.W, b.H, (n) => DIFF_PAGE.diffRgb(n), { active: true, diff: true });
    assert.ok(px.some((r) => r.frame && DIFF_PAGE.diffRgb(r.n).join() !== DIFF_PAGE.diffRgb({ size: 1, prevSize: 1 }).join()), 'control: some folders are washed');
    const m = measureEdges(raster, px);
    assert.deepEqual(m.under, [], `${theme}: lines under ${EDGE_BAR}:1 against the washed tile beside them`);
  }
});

test('owner\'s outlines: a folder\'s band is heavier and higher-contrast than a leaf\'s outline beside the same colour — 2 px at the top level, and on the size ramp always the stronger line', () => {
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    const b = colourBlocks(EVERY_COLOUR, 16, 16);
    const { raster, px } = rasterPaint(b.tiles, palette, b.W, b.H, b.colour);
    const { edges } = measureEdges(raster, px);
    for (const [i, c] of EVERY_COLOUR.entries()) {
      const mine = edges.filter((e) => e.r.n.path.startsWith(`/m/t${i}/`) || e.r.n.path === `/m/t${i}`);
      const leaf = Math.min(...mine.filter((e) => e.kind === 'leaf' && e.r.n.path.endsWith('/f4')).map((e) => contrast(raster.at(...e.line), raster.at(...e.tile))));
      const frame = Math.min(...mine.filter((e) => e.kind === 'frame').map((e) => contrast(raster.at(...e.line), raster.at(...e.tile))));
      assert.ok(Number.isFinite(leaf) && Number.isFinite(frame), `${theme}, ${c.name}: control — both lines measured`);
      assert.ok(frame >= leaf, `${theme}, ${c.name}: a folder's band (${fmt(frame)}:1) is no weaker than a leaf's outline (${fmt(leaf)}:1)`);
      if (i < RAMP_COLOURS.length) assert.ok(frame > leaf + 0.5, `${theme}, ${c.name}: on the size ramp the band (${fmt(frame)}:1) is clearly the stronger line than the leaf's outline (${fmt(leaf)}:1)`);
    }
    const top = px.find((r) => r.n.depth === 1)!, nested = px.find((r) => r.n.depth === 2)!;
    assert.equal(top.bands!.find((x) => x.y === top.y)!.h, 2, `${theme}: a top-level folder's band is 2 px`);
    assert.equal(nested.bands!.find((x) => x.y === nested.y)!.h, 1, `${theme}: a nested folder's band is 1 px, as a leaf's outline is`);
  }
});

test('owner\'s outlines: the colour still pops inside every outlined tile — C*ab ≥ 60 at the top of the ramp and at least 0.8 of its colour\'s strength, the outline taking only the tile\'s edge', () => {
  for (const [lw, lh] of [[8, 8], [16, 16], [12, 64]] as const) {
    const b = colourBlocks(RAMP_COLOURS, lw, lh);
    for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
      const { raster, px } = rasterPaint(b.tiles, palette, b.W, b.H, b.colour);
      for (const [i, c] of RAMP_COLOURS.entries()) {
        const mid = px.find((r) => r.n.path === `/m/t${i}/n/f4`)!;
        const centre = raster.at(mid.x + Math.floor(mid.w / 2), mid.y + Math.floor(mid.h / 2));
        const own = lab(c.rgb).C, shown = lab(centre).C;
        assert.ok(shown / own >= 0.8, `${theme}, ${lw}×${lh}, ${c.name}: inside its outline the tile shows C*ab ${shown.toFixed(1)} of ${own.toFixed(1)}`);
        if (i === RAMP_COLOURS.length - 1) assert.ok(shown >= 60, `${theme}, ${lw}×${lh}: the top of the ramp shows C*ab ${shown.toFixed(1)} inside its outline`);
        // The outline is a ring one pixel wide: every pixel inside it is the tile's own cushion.
        for (let x = mid.x + 1; x < mid.x + mid.w - 1; x++) {
          const p = raster.at(x, mid.y + Math.floor(mid.h / 2));
          assert.ok(contrast(p, centre) < 1.2, `${theme}, ${lw}×${lh}, ${c.name}: pixel ${x - mid.x} of its middle row is the tile, not a line`);
        }
      }
    }
  }
});

test('owner\'s outlines: a leaf under 8 px is filled edge to edge with no outline or highlight; one of 8 px and up is outlined in a shade of its own colour, a highlight only under a dark one', () => {
  // Literal sizes about the rule's edge, so raising it — to 24 px, say — fails here.
  const leaf = (name: string, x: number, px: number, size = 2e6): Tile => ({ name, path: `/r/${name}`, size, type: 'file', depth: 1, expanded: false, x, y: 50, w: px / 10, h: px / 10 });
  const tiles = [leaf('seven', 10, 7), leaf('eight', 20, 8), leaf('nine', 30, 9), leaf('twenty', 40, 20)];
  const rec = paint(tiles);
  const near = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.01);
  for (const [name, x, side, edged] of [['seven', 100, 7, false], ['eight', 200, 8, true], ['nine', 300, 9, true], ['twenty', 400, 20, true]] as const) {
    const y = 500;
    const r = rec.px.find((p: Painted) => p.n.name === name) as Painted;
    assert.ok(rec.ops.some((op) => op.kind === 'rect' && near(op.rect, [x, y, side, side]) && typeof op.style === 'object'), `${name} (${side} px): its cushion fills its box edge to edge`);
    const outline = rec.strokes.filter((st) => near(st.rect, [x + 0.5, y + 0.5, side - 1, side - 1]));
    assert.equal(outline.length, edged ? 1 : 0, `${name} (${side} px): ${edged ? 'an outline of its own' : 'no outline of its own'}`);
    if (!edged) { assert.equal(r.edge, undefined, `${name}: no outline recorded`); continue; }
    assert.equal(outline[0].style, r.edge, `${name}: in the tone it recorded`);
    const [er, eg, eb, ea] = rgba(outline[0].style);
    assert.equal(ea, 1, `${name}: the outline is opaque — it does not let the ground through`);
    assert.ok(!(er === 0 && eg === 0 && eb === 0), `${name}: a shade of its own colour, not flat black (${outline[0].style})`);
    const highlight = rec.lines.filter((l) => near(l.seg, [x + 1, y + 1.5, x + side - 1, y + 1.5]));
    assert.equal(highlight.length, r.lit ? 1 : 0, `${name}: a highlight ${r.lit ? 'along its top row, under its dark outline' : 'only under a dark outline'}`);
  }
  // On a dark tile — Reclaim's "not scored" grey — the shade is lighter than the tile, and no highlight sits beside it.
  const grey = paint([leaf('grey', 60, 20)], () => [0x3a, 0x40, 0x48]);
  const g = grey.px[0] as Painted;
  assert.ok(luminance(rgba(g.edge!).slice(0, 3) as RGB) > luminance([0x3a, 0x40, 0x48]), `a dark tile's outline is a lighter shade (${g.edge})`);
  assert.equal(g.lit, false, 'and it has no highlight');
});

/* ── J51: a folder no rectangle covers shows its own colour ── */

/** A top-level folder holding the corpus's Mail (no file over the floor, its mailboxes empty frames too), "Wide folder", and a folder half covered. */
function subFloorTiles(): Tile[] {
  const dir = (name: string, path: string, size: number, depth: number, x: number, y: number, w: number, h: number): Tile =>
    ({ name, path, size, type: 'dir', depth, expanded: true, x, y, w, h });
  return [
    dir('corpus', '/c', 4e10, 1, 0, 0, 100, 100),
    dir('Mail', '/c/Mail', 37.7e6, 2, 5, 5, 40, 30),
    dir('Wide folder', '/c/Wide folder', 2e6, 2, 50, 5, 5, 5.25),
    dir('Half', '/c/Half', 1.2e10, 2, 60, 40, 30, 40),
    { name: 'big.mov', path: '/c/Half/big.mov', size: 6e9, type: 'file', depth: 3, expanded: false, x: 60, y: 40, w: 15, h: 40 },
    // Mail's mailboxes: frames of their own, each with nothing over the floor either.
    dir('INBOX', '/c/Mail/INBOX', 20e6, 3, 5, 5, 20, 30),
    dir('Sent', '/c/Mail/Sent', 10e6, 3, 25, 5, 10, 30),
  ];
}

test('J51: a folder whose files are all under the size floor is filled with its own colour and cushion — never the map\'s ground, a black slab in dark or a white grid in light — and so is the part of a folder no rectangle covers', () => {
  const tiles = subFloorTiles();
  const W = 400, H = 400;
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    const ground = canvasGround(palette);
    const { raster, px } = rasterPaint(tiles, palette, W, H);
    const where = (path: string) => px.find((r) => r.n.path === path)!;
    for (const [path, x, y] of [
      ['/c/Mail/INBOX', 0.5, 0.5], ['/c/Mail/Sent', 0.5, 0.5], ['/c/Mail', 0.85, 0.5], // Mail shows between and beside its mailboxes
      ['/c/Wide folder', 0.5, 0.5], ['/c/Half', 0.75, 0.5], ['/c', 0.9, 0.9],
    ] as const) {
      const r = whole(where(path));
      const px0 = Math.floor(r.x + r.w * x), py0 = Math.floor(r.y + r.h * y);
      const shown = raster.at(px0, py0);
      // A leaf's cushion of the folder's own colour on the size ramp: 16% white at its top, 22% black at its foot, over its height.
      const own = ramp.sizeRgb(r.n.size), amp = Math.min(1, r.h / 60);
      const cushion: RGB[] = [mix3(own, [255, 255, 255], 0.16 * amp) as RGB, mix3(own, [0, 0, 0], 0.22 * amp) as RGB];
      const want = lerp(cushion[0], cushion[1], (py0 + 0.5 - r.y) / r.h);
      assert.ok(lab(shown).C - lab(ground).C > 30, `${theme}, ${path}: not the map's ground (${shown.map(Math.round)} on ${ground.map(Math.round)})`);
      assert.ok(contrast(shown, want) < 1.05, `${theme}, ${path}: shows its own cushion (${shown.map(Math.round)}; its cushion there ${want.map(Math.round)})`);
      assert.ok(lab(shown).C / lab(own).C >= 0.8, `${theme}, ${path}: at the strength of its colour on the size ramp (C*ab ${lab(shown).C.toFixed(1)} of ${lab(own).C.toFixed(1)})`);
      assert.deepEqual(r.bg, cushion, `${theme}, ${path}: and the painter recorded that fill, for the SVG export`);
    }
    // A staged block and a hollow cloud cell in a filled folder show the map's ground, not the folder's fill:
    // neither is space the folder holds on this disk.
    const hollow = rasterPaint([
      { name: 'F', path: '/f', size: 3e10, type: 'dir', depth: 1, expanded: true, x: 0, y: 0, w: 100, h: 100 },
      // A staged block as tmBuildPreview names it, in the folder it lies in (review F1.4).
      { name: 'Staged', path: '/f — freed', parentPath: '/f', size: 2e9, type: 'dir', depth: 2, expanded: false, x: 10, y: 10, w: 30, h: 30, freed: true } as Tile,
      { name: 'cloud.mov', path: '/f/cloud.mov', size: 2e9, type: 'file', depth: 2, expanded: false, x: 50, y: 10, w: 30, h: 30, cloudPlaceholder: true } as Tile,
    ], palette, 200, 200);
    assert.ok(hollow.px[0].bg, `${theme}: control — the folder around them is filled`);
    assert.ok(contrast(hollow.raster.at(50, 50), ground) < 1.01, `${theme}: the staged block shows the ground (${hollow.raster.at(50, 50).map(Math.round)})`);
    const faint = over([...ramp.sizeRgb(2e9), 0.16] as RGBA, ground);
    assert.ok(contrast(hollow.raster.at(130, 50), faint) < 1.02, `${theme}: the hollow cloud cell is its faint wash over the ground (${hollow.raster.at(130, 50).map(Math.round)}, want ${faint.map(Math.round)})`);
    // With online-only files hidden, a folder holding one is not filled where it would be: its bytes are not
    // on this disk, so the folder's colour there would claim space it does not take.
    const withCloud = [
      { name: 'G', path: '/g', size: 3e10, type: 'dir', depth: 1, expanded: true, x: 0, y: 0, w: 100, h: 100 },
      { name: 'here.bin', path: '/g/here.bin', size: 1e10, type: 'file', depth: 2, expanded: false, x: 0, y: 0, w: 50, h: 100 },
      { name: 'away.mov', path: '/g/away.mov', size: 2e10, type: 'file', depth: 2, expanded: false, x: 50, y: 0, w: 50, h: 100, cloudPlaceholder: true } as Tile,
    ] as Tile[];
    const hidden = rasterPaint(withCloud, palette, 200, 200, undefined, undefined, true);
    assert.equal(hidden.px.length, 2, `${theme}: control — the online-only file is hidden`);
    assert.equal(hidden.px[0].bg, undefined, `${theme}: the folder is not filled where its hidden online-only file would be`);
    assert.ok(contrast(hidden.raster.at(150, 100), ground) < 1.01, `${theme}: the map's ground shows there (${hidden.raster.at(150, 100).map(Math.round)})`);
    // A folder its contents tile exactly needs no fill of its own.
    const tiled = rasterPaint([
      { name: 'T', path: '/t', size: 2e9, type: 'dir', depth: 1, expanded: true, x: 0, y: 0, w: 50, h: 50 },
      { name: 'a', path: '/t/a', size: 1e9, type: 'file', depth: 2, expanded: false, x: 0, y: 0, w: 25, h: 50 },
      { name: 'b', path: '/t/b', size: 1e9, type: 'file', depth: 2, expanded: false, x: 25, y: 0, w: 25, h: 50 },
    ], palette, 200, 200);
    assert.equal(tiled.px[0].bg, undefined, `${theme}: a folder its files tile is not filled under them`);
  }
  // The top of the ramp, as a sub-floor folder: still C*ab ≥ 60.
  const huge = rasterPaint([{ name: 'big', path: '/big', size: 2e10, type: 'dir', depth: 1, expanded: true, x: 0, y: 0, w: 100, h: 100 }], DARK, 100, 100);
  assert.ok(lab(huge.raster.at(50, 50)).C >= 60, `a 20 GB folder with nothing drawn in it shows C*ab ${lab(huge.raster.at(50, 50)).C.toFixed(1)}`);
});

/** The page's own mix, for a test that says what a colour should be. */
function mix3(a: RGB, b: RGB, t: number): number[] { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }

/** The cart preview's nodes as the page's own tmBuildPreview lays them out — its staged blocks named "<folder> — freed". */
function previewOf(nodes: Tile[], rootPath: string, rootSize: number, cart: string[], sizes: Record<string, number>): Tile[] {
  let out: Tile[] | null = null;
  // Built while loading, so every helper it calls is pulled in.
  load<() => { nodes: Tile[] | null }>(['tmBuildPreview'], {
    state: { treemap: { nodes, rootPath, rootSize }, cart: new Set(cart) },
    cartNode: (p: string) => (p in sizes ? { path: p, size: sizes[p] } : null),
  }, 'tmBuildPreview', (build) => { out = build().nodes; });
  assert.ok(out, 'control: a preview was built');
  return out!;
}

/**
 * A live map whose folder /r/g holds /r/g/p and a file, with a fifth of /r/g in files under the floor;
 * /r/g/p holds one file, and the cart stages a file inside /r/g/p that the map never drew — so the
 * preview draws it as a staged block in /r/g/p, which tiles /r/g/p with the file.
 */
function stagedInNestedFolder(): Tile[] {
  const dir = (path: string, size: number, depth: number): Tile => ({ name: path.slice(path.lastIndexOf('/') + 1), path, size, type: 'dir', depth, expanded: true, x: 0, y: 0, w: 1, h: 1 });
  const file = (path: string, size: number, depth: number): Tile => ({ ...dir(path, size, depth), type: 'file', expanded: false });
  const nodes = [dir('/r/g', 10e9, 1), dir('/r/g/p', 6e9, 2), file('/r/g/leaf.bin', 2e9, 2), file('/r/g/p/a.bin', 3e9, 3)];
  const staged = '/r/g/p/deep/x.bin';
  return previewOf(nodes, '/r', 10e9, [staged], { [staged]: 3e9 });
}

test('J51 in "Preview after": a staged block is counted in the folder it lies in, so the folder above keeps its own fill where nothing covers it (review F1.4)', () => {
  const preview = stagedInNestedFolder();
  const block = preview.find((n) => (n as { freed?: boolean }).freed)!;
  assert.equal(block.path, '/r/g/p — freed', 'control: the staged block, named as the page names it, lies in /r/g/p');
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    const ground = canvasGround(palette);
    const { raster, px } = rasterPaint(preview, palette, 200, 200);
    const g = px.find((r) => r.n.path === '/r/g')!, p = px.find((r) => r.n.path === '/r/g/p')!;
    assert.ok(g.bg, `${theme}: /r/g, a fifth of it in files under the floor, is filled where none of its rectangles covers it`);
    assert.equal(p.bg, undefined, `${theme}: /r/g/p, tiled by its file and the staged block, has no fill of its own under them`);
    // A pixel of /r/g that none of its rectangles covers, clear of its band: /r/g's cushion, not the map's ground.
    const inside = px.filter((r) => r.n.path.startsWith('/r/g/'));
    let spot: [number, number] | null = null;
    for (let y = g.y + 4; y < g.y + g.h - 4 && !spot; y++) {
      for (let x = g.x + 4; x < g.x + g.w - 4 && !spot; x++) {
        if (!inside.some((c) => x + 0.5 > c.x - 4 && x + 0.5 < c.x + c.w + 4 && y + 0.5 > c.y - 4 && y + 0.5 < c.y + c.h + 4)) spot = [x, y];
      }
    }
    assert.ok(spot, `${theme}: control — a part of /r/g no rectangle covers`);
    const shown = raster.at(...spot!);
    const want = lerp(g.bg![0], g.bg![1], (spot![1] + 0.5 - g.y) / g.h);
    assert.ok(contrast(shown, ground) > 1.3, `${theme}: not the map's ground there (${shown.map(Math.round)} on ${ground.map(Math.round)})`);
    assert.ok(contrast(shown, want) < 1.05, `${theme}: /r/g's own cushion there (${shown.map(Math.round)}, want ${want.map(Math.round)})`);
  }
});

/* ── A dense corner as the real map draws one ── */

/**
 * A deterministic stand-in for the dense corner of /System/Library, laid out by the server's own
 * buildTreemap at the page's own floor (4,000 bytes) and Depth 4: nine top folders of three to seven
 * folders, each of two to six folders of 4 KB–600 KB files (and some under the floor), one in twelve
 * holding nothing over the floor (J51). On a 640×400 map about half its 1,750 leaves are 4–16 px a side.
 */
function realisticNodes(): Tile[] {
  let seed = 20261020;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const between = (lo: number, hi: number) => Math.round(10 ** (Math.log10(lo) + rnd() * (Math.log10(hi) - Math.log10(lo))));
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const dir = (p: string, children: FileNode[]): FileNode => ({ name: p.slice(p.lastIndexOf('/') + 1), path: p, type: 'dir', size: children.reduce((a, c) => a + c.size, 0), modifiedAt: 0, isHidden: false, children });
  const files = (d: string, n: number, lo: number, hi: number): FileNode[] =>
    Array.from({ length: n }, (_, i) => ({ name: `f${i}`, path: `${d}/f${i}`, type: 'file' as const, size: between(lo, hi), modifiedAt: 0, isHidden: false, extension: '' }));
  const level3 = (p: string, k: number): FileNode => {
    const d = `${p}/c${k}`;
    if (rnd() < 0.08) return dir(d, files(d, int(200, 900), 400, 3900));
    return dir(d, [...files(d, int(4, 14), 4000, 600000), ...files(d, int(0, 20), 200, 3900)]);
  };
  const level2 = (p: string, k: number): FileNode => {
    const d = `${p}/b${k}`;
    return dir(d, [...Array.from({ length: int(2, 6) }, (_, i) => level3(d, i)), ...files(d, int(1, 6), 8000, 900000)]);
  };
  const level1 = (k: number): FileNode => {
    const d = `/L/a${k}`;
    return dir(d, [...Array.from({ length: int(3, 7) }, (_, i) => level2(d, i)), ...files(d, int(0, 4), 50000, 4000000)]);
  };
  const root = dir('/L', Array.from({ length: 9 }, (_, i) => level1(i)));
  return buildTreemap(root, { maxDepth: 4, minSize: 4000, maxNodes: 20000 }) as unknown as Tile[];
}
const REAL_W = 640, REAL_H = 400;
/** Near-black: no brighter than relative luminance 0.03 — about L* 20, the map's own dark ground and anything close to it. */
const NEAR_BLACK = 0.03;

test('map density: a realistic dense map is colour with contrasting lines, not a black mesh — near-black under 2% in dark and light, and every line at 3:1 on its pixels', () => {
  const nodes = realisticNodes();
  const share: Record<string, number> = {};
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    const { raster, px } = rasterPaint(nodes, palette, REAL_W, REAL_H);
    const leaves = px.filter((r) => !r.frame);
    const sides = leaves.map((r) => Math.min(r.w, r.h));
    // Control: the corner QA measured — mostly small leaves, many of them outlined, nested folders, and J51's empty ones.
    assert.ok(leaves.length > 1500, `${theme}: control — ${leaves.length} leaves drawn`);
    assert.ok(sides.filter((s) => s >= 4 && s < 16).length > leaves.length * 0.45, `${theme}: control — about half the leaves are 4–16 px a side`);
    const outlined = leaves.filter((r) => Math.min(r.w, r.h) >= OUTLINED_PX).length;
    assert.ok(outlined > 300, `${theme}: control — ${outlined} leaves are big enough for an outline`);
    assert.ok(px.filter((r) => r.frame && r.n.depth >= 3).length > 100, `${theme}: control — nested folders`);
    assert.ok(px.filter((r) => r.frame && !px.some((c) => c !== r && c.n.path.startsWith(`${r.n.path}/`))).length >= 10, `${theme}: control — folders with nothing drawn in them (J51)`);
    share[theme] = raster.nearBlack(NEAR_BLACK);
    // A top-level folder's band is laid last, over any nested folder's along an edge they share: whole, in its own tones.
    for (const r of px.filter((p) => p.n.depth === 1)) {
      for (const b of r.bands!) {
        const want = rgba(b.rgb).slice(0, 3);
        for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
          assert.deepEqual(raster.at(x, y).map(Math.round), want, `${theme}, ${r.n.path}: its band at ${x},${y} is its own ${b.rgb}`);
        }
      }
    }
    const m = measureEdges(raster, px);
    assert.ok(m.edges.length > 20000, `${theme}: ${m.edges.length} places measured`);
    assert.deepEqual(m.under, [], `${theme}: lines under ${EDGE_BAR}:1 against the tile beside them`);
  }
  // QA read 8.5% (corpus) and 8.9% (/System/Library) near-black in the real dark map, and 2.3–5.5% in light,
  // painted BQG-5's way; this layout, painted that way (REL-79), measures 10.6% dark and 4.9% light — the
  // empty folders' slabs and the 0.35 outlines over a gap of the ground — and 0.1% in both now. The lines
  // are dark shades of each tile's own colour, not black: at luminance < 0.08 the share is 16.5% (it was
  // 14.6% dark, 8.7% light) — the outlines the owner asked to see.
  const over = Object.entries(share).filter(([, v]) => v >= 0.02).map(([theme, v]) => `${theme} ${(v * 100).toFixed(1)}%`);
  assert.deepEqual(over, [], `near-black (luminance < ${NEAR_BLACK}) at or over 2%: ${over.join(', ')} (dark ${(share.dark * 100).toFixed(1)}%, light ${(share.light * 100).toFixed(1)}%)`);
});

/* ── The SVG export paints what the canvas painted ── */

test('owner\'s outlines: the SVG export paints each leaf\'s toned outline and highlight, each folder\'s own fill and each band as the canvas did, in its order (mapPaintFidelity\'s rule)', () => {
  const tiles = [...subFloorTiles(), { name: 'grey', path: '/c/Half/grey', size: 3e9, type: 'file', depth: 3, expanded: false, x: 75, y: 40, w: 15, h: 40 } as Tile];
  const colour = (n: Tile) => (n.name === 'grey' ? [0x3a, 0x40, 0x48] as RGB : ramp.sizeRgb(n.size));
  const { svg, rec, px } = exportSvg(tiles, colour, '#0e0e13');
  const painted = px as Painted[];
  const rects = [...svg.matchAll(/<rect ([^>]*?)\/?>/g)].map((m) => ({ a: attrs(m[1]), at: m.index! }));
  const close = (a: Record<string, string>, box: number[]) => ['x', 'y', 'width', 'height'].every((k, i) => Math.abs(Number(a[k]) - box[i]) < 0.011);
  // Each leaf's outline, in the tone the canvas stroked it.
  const leaves = painted.filter((r) => !r.frame);
  assert.ok(leaves.some((r) => r.lit) && leaves.some((r) => r.edge && !r.lit), 'control: a lit leaf under a dark outline, and an unlit one under a light outline');
  for (const r of leaves) {
    const stroke = rec.strokes.find((st) => st.rect.every((v, i) => Math.abs(v - [r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1][i]) < 0.011));
    const inSvg = rects.find(({ a }) => a.fill === 'none' && a.stroke && close(a, [r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1]));
    assert.equal(inSvg?.a.stroke, stroke?.style, `${r.n.path}: the SVG outlines it in the canvas's ${stroke?.style}`);
    const lit = new RegExp(`<line x1="${(r.x + 1).toFixed(2)}" y1="${(r.y + 1.5).toFixed(2)}" x2="${(r.x + r.w - 1).toFixed(2)}" y2="${(r.y + 1.5).toFixed(2)}" stroke="rgba\\(255,255,255,0\\.18\\)"`).test(svg);
    assert.equal(lit, !!r.lit, `${r.n.path}: ${r.lit ? 'its highlight, as on the canvas' : 'no highlight, as on the canvas'}`);
  }
  // Each folder's own fill, with the canvas's cushion, before anything drawn in it.
  for (const r of painted.filter((p) => p.frame && p.bg)) {
    const fill = rects.find(({ a }) => /^url\(#tm-f/.test(a.fill ?? '') && close(a, [r.x, r.y, r.w, r.h]));
    assert.ok(fill, `${r.n.path}: its own fill is in the SVG`);
    const id = /^url\(#([\w-]+)\)$/.exec(fill!.a.fill)![1];
    const stops = [...new RegExp(`<linearGradient id="${id}"[^>]*>([\\s\\S]*?)</linearGradient>`).exec(svg)![1].matchAll(/stop-color="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(stops, r.bg!.map((c) => `rgb(${c.join(',')})`), `${r.n.path}: in the canvas's cushion`);
    const inside = painted.filter((c) => c !== r && c.n.path.startsWith(`${r.n.path}/`) && !c.frame);
    for (const c of inside) {
      const leafAt = rects.find(({ a }) => close(a, [c.x, c.y, c.w, c.h]) && /^url\(#tm-c/.test(a.fill ?? ''));
      assert.ok(leafAt && leafAt.at > fill!.at, `${r.n.path}: ${c.n.path} is drawn over the folder's fill`);
    }
  }
  // Every band, in the canvas's colours and in the canvas's order.
  const bandsOnCanvas = rec.ops.filter((op): op is Extract<Op, { kind: 'rect' }> => op.kind === 'rect' && typeof op.style === 'string' && rgba(op.style)[3] === 1 && /^rgb\(/.test(op.style))
    .map((op) => `${op.rect.map((v) => v.toFixed(2)).join(' ')} ${op.style}`);
  const bandsInSvg = rects.filter(({ a }) => /^rgb\(/.test(a.fill ?? '') && !('fill-opacity' in a)).map(({ a }) => `${['x', 'y', 'width', 'height'].map((k) => Number(a[k]).toFixed(2)).join(' ')} ${a.fill}`);
  assert.ok(bandsOnCanvas.length >= painted.filter((r) => r.frame).length * 4, `control: each folder's bands are on the canvas (${bandsOnCanvas.length})`);
  assert.deepEqual(bandsInSvg, bandsOnCanvas, 'the SVG lays the same bands, in the same colours, in the same order');
});
