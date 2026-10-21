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
/** Each declaration's source, sliced once: the painter pulls in some eighty helpers, and every paint resolves them. */
const DECLS = new Map<string, string>();
const declOnce = (name: string) => { if (!DECLS.has(name)) DECLS.set(name, declSource(name)); return DECLS.get(name)!; };
/** The helpers each set of names turned out to need, by the names, the dependencies and the returns: found once, then reused. */
const PULLED = new Map<string, string[]>();
function load<T>(names: string[], deps: Record<string, unknown>, returns: string, run?: (fn: T) => void): T {
  const keys = Object.keys(deps);
  const memo = `${names.join(',')}|${keys.join(',')}|${returns}`;
  const pulled = [...(PULLED.get(memo) ?? names)];
  for (let attempt = 0; attempt < 128; attempt++) {
    const src = `'use strict'; ${pulled.map(declOnce).join('\n')}\nreturn ${returns};`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function(...keys, src)(...keys.map((k) => deps[k])) as T;
      if (run) run(fn);
      PULLED.set(memo, pulled);
      return fn;
    } catch (e) {
      const missing = /(\w+) is not defined/.exec(String((e as Error).message))?.[1];
      if (!missing || pulled.includes(missing)) throw e;
      pulled.push(missing);
    }
  }
  throw new Error(`${names.join(', ')} would not run after pulling in 128 helpers`);
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
  return over(rgba(palette['--tm-canvas-bg']), cardGround(palette));
}
/** What a cleared canvas pixel shows: the map's glass card over the page. */
function cardGround(palette: Record<string, string>): RGB {
  const page = rgba(palette['--bg-1']).slice(0, 3) as RGB;
  return over(rgba(palette['--glass']), page);
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
    // The foot is read at the tile's own height (gy), on a pixel of the tile above its bottom row — where a line it
    // shares with the tile below may lie (the owner's refinement), which no glyph's body reaches.
    const foot = canvasAt(rec.ops, i, x, Math.min(top.leaf![1] + top.leaf![3] - 1.01, footGy), ground, footGy);
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
function exportSvg(tiles: Tile[], colour: (n: Tile) => RGB, ground: string, history = { active: false, diff: false }, palette?: Record<string, string>, hideCloud = false) {
  const state = { treemap: { nodes: tiles, hideCloud, rootSize: 1e12, history, pxRects: [] as any[],
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

test('owner\'s outlines: the SVG export lays the History diff\'s wash in the canvas\'s order — after every folder\'s own fill, leaf and texture (passes 0 to 2.4), before every leaf\'s line and folder\'s band (passes 2.6 and 2.7), so no line is tinted by it (review F2.4)', () => {
  // The lines are laid after the washes so each is seen in the tone it was picked in: under two washes even black reached
  // only 2.3:1 on a grey tile. An export that laid its washes over the lines passed every test, which compared the washes
  // only among themselves. Two folders that changed, each holding two files of one colour side by side, which meet at a
  // line (svgDiffTiles' files part from what lies beside them unaided, and lay none).
  const node = (path: string, dir: boolean, x: number, y: number, w: number, h: number, kind: string): Tile =>
    ({ name: path.slice(path.lastIndexOf('/') + 1), path, size: 5e9, prevSize: PREV[kind](5e9), type: dir ? 'dir' : 'file', depth: dir ? 1 : 2, expanded: dir, x, y, w, h } as Tile);
  const tiles = [
    node('/r/P', true, 0, 0, 40, 40, 'grew'), node('/r/P/a', false, 0.2, 0.2, 19.8, 30, 'unchanged'), node('/r/P/b', false, 20, 0.2, 19.8, 30, 'unchanged'),
    node('/r/Q', true, 50, 0, 40, 40, 'shrank'), node('/r/Q/c', false, 50.2, 0.2, 19.8, 30, 'grew'), node('/r/Q/d', false, 70, 0.2, 19.8, 30, 'grew'),
  ];
  const { svg, px } = exportSvg(tiles, (n) => DIFF_PAGE.diffRgb(n), '#0e0e13', { active: true, diff: true });
  const f = (v: number) => v.toFixed(2);
  const lineKey = (b: Band) => `${f(b.x)} ${f(b.y)} ${f(Math.max(0, b.w))} ${f(Math.max(0, b.h))} ${b.rgb}`;
  const lines = new Set(px.flatMap((r: Painted) => [...(r.lines || [])].map(lineKey)));
  const bands = new Set(px.flatMap((r: Painted) => [...(r.bands || [])].map(lineKey)));
  const order = [...svg.matchAll(/<rect ([^>]*?)\/?>/g)].map((m) => attrs(m[1])).map((a) => {
    if ('fill-opacity' in a && !('stroke' in a)) return 'wash';
    const key = `${a.x} ${a.y} ${a.width} ${a.height} ${a.fill}`;
    if (lines.has(key)) return 'line';
    if (bands.has(key)) return 'band';
    return /^url\(#tm-[cft]\d+\)$/.test(a.fill || '') ? 'tile' : 'other';
  });
  const count = (k: string) => order.filter((o) => o === k).length;
  assert.ok(count('wash') === 2 && count('line') >= 2 && count('band') >= 8 && count('tile') >= 6,
    `control — the export holds the two washes, the leaves' lines, the folders' bands and the tiles (${['wash', 'line', 'band', 'tile'].map((k) => `${count(k)} ${k === 'wash' ? 'washes' : `${k}s`}`).join(', ')})`);
  const firstWash = order.indexOf('wash'), lastWash = order.lastIndexOf('wash');
  const tileAfter = order.findIndex((o, i) => o === 'tile' && i > firstWash);
  const lineBefore = order.findIndex((o, i) => (o === 'line' || o === 'band') && i < lastWash);
  assert.equal(tileAfter, -1, `every tile is laid before the washes (rect ${tileAfter} is a tile after the first wash, rect ${firstWash})`);
  assert.equal(lineBefore, -1, `every line and band is laid after the washes (rect ${lineBefore} is a ${order[lineBefore]} before the last wash, rect ${lastWash})`);
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
 *     against the tile on each side of it (the owner's refinement, below), across the whole size ramp and
 *     every other colour the map paints;
 *   - folder bands heavier and higher-contrast than leaf outlines;
 *   - the colour still popping inside every tile;
 *   - a realistic dense map (the server's own layout of a /System/Library-like tree) not a black mesh;
 *   - a folder's area no rectangle covers (its files under the 4 KB floor, J51) in the folder's own
 *     colour and cushion, never the map's ground.
 */

/** WCAG's bar for a non-text edge, and the owner's. */
const EDGE_BAR = 3;

/**
 * The staged block's hatch as the page's tmHatchPattern builds it (review F2.2): an 8×8 tile with two
 * strokes 1.6 px wide in --warn, from (-2, 10) to (10, -2) and from (-2, 18) to (18, -2) — the lines
 * x + y = 8 and x + y = 16 — repeated from the canvas's origin and scaled by its transform. `cover` is how
 * much of each of the tile's 64 pixels the strokes cover, sampled 8×8 within the pixel.
 */
type Hatch = { kind: 'hatch'; ink: string; cover: number[] };
function hatchOf(ink: string): Hatch {
  const half = 0.8 * Math.SQRT2; // half the stroke's width, measured along x + y
  const cover: number[] = [];
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let n = 0;
      for (let sy = 0; sy < 8; sy++) for (let sx = 0; sx < 8; sx++) {
        const s = u + (sx + 0.5) / 8 + v + (sy + 0.5) / 8;
        if (Math.abs(s - 8) <= half || Math.abs(s - 16) <= half) n++;
      }
      cover.push(n / 64);
    }
  }
  return { kind: 'hatch', ink, cover };
}

/**
 * A 2D context that rasterizes what the painter asks for onto a `W`×`H` grid of pixels, starting from
 * `ground`: rectangles filled and stroked, axis-aligned path strokes, flat colours, vertical gradients
 * and the staged block's hatch (hatchOf), each at its own alpha and globalAlpha, with partial pixels
 * covered by area; and a rounded rectangle filled (roundRect, then fill), as pass 3 lays the top-level
 * folders' name tags — how much of each pixel it covers is noted (`tagged`, `taggedWhole`). A clip
 * (review F3.1) is a path of rectangles and rounded rectangles — rect, or moveTo and four arcTo then
 * closePath as Canvas2D.roundRect draws one — filled by the even-odd rule or nonzero, sampled as fill()
 * samples, and what is painted after it lands by as much of each pixel as it lets through, until
 * restore(). Text is not drawn: what is measured here is the tiles and the lines between them.
 */
function rasterCtx(W: number, H: number, ground: RGB) {
  const px = new Float64Array(W * H * 3);
  for (let i = 0; i < W * H; i++) px.set(ground, i * 3);
  const tag = new Float32Array(W * H);
  let tagPaint = '';
  // clipMask: how much of each device pixel the clip lets through (null: all of it), saved and restored with the rest.
  const st: Record<string, any> = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, clipMask: null };
  const saved: Array<Record<string, any>> = [];
  let path: number[][] = [];
  type Shape = { x: number; y: number; w: number; h: number; r: number };
  let round: Shape | null = null;
  // The current path's closed shapes, for clip(): rectangles, and rounded rectangles built from moveTo and four arcTo.
  let shapes: Shape[] = [];
  let sub: Array<{ x: number; y: number; r: number }> | null = null;
  /** Whether the device point (x, y) lies in `s` (device px), inclusive of its edge, as fill() samples it. */
  const inShape = (s: Shape, x: number, y: number) => {
    if (x < s.x || x > s.x + s.w || y < s.y || y > s.y + s.h) return false;
    const qx = Math.min(Math.max(x, s.x + s.r), s.x + s.w - s.r), qy = Math.min(Math.max(y, s.y + s.r), s.y + s.h - s.r);
    return (x - qx) ** 2 + (y - qy) ** 2 <= s.r * s.r + 1e-9;
  };
  const clipAt = (i: number) => (st.clipMask ? (st.clipMask as Float32Array)[i] : 1);
  // The transform's scale (setTransform): the painter works in css px, the grid is the device's pixels.
  let k = 1;
  // The hatch's colour at a device pixel: its ink, as much of it as the tile's pixel there is covered.
  const hatchAt = (h: Hatch, pxx: number, py: number): RGBA => {
    const u = ((Math.floor((pxx + 0.5) / k) % 8) + 8) % 8, v = ((Math.floor((py + 0.5) / k) % 8) + 8) % 8;
    const [r, g, b, a] = rgba(h.ink);
    return [r, g, b, a * h.cover[v * 8 + u]];
  };
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
  const paintRect = (cx0: number, cy0: number, cw: number, ch: number, style: any) => {
    const x = cx0 * k, y = cy0 * k, w = cw * k, h = ch * k;
    if (!(w > 0 && h > 0)) return;
    const hatch = style && typeof style === 'object' && style.kind === 'hatch' ? style as Hatch : null;
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(H, Math.ceil(y + h)); py++) {
      const cy = Math.min(py + 1, y + h) - Math.max(py, y);
      const row = hatch ? null : colourAt(style, (py + 0.5) / k);
      for (let pxx = Math.max(0, Math.floor(x)); pxx < Math.min(W, Math.ceil(x + w)); pxx++) {
        const cx = Math.min(pxx + 1, x + w) - Math.max(pxx, x);
        const c = row ?? hatchAt(hatch!, pxx, py);
        const a = c[3] * Number(st.globalAlpha) * cx * cy * clipAt(py * W + pxx);
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
    setTransform: (a: number) => { k = a; },
    fillRect: (x: number, y: number, w: number, h: number) => paintRect(x, y, w, h, st.fillStyle),
    strokeRect: (x: number, y: number, w: number, h: number) => strokeEdges(x, y, w, h),
    // A cleared pixel shows what is behind the canvas: the map's own ground.
    clearRect: (x: number, y: number, w: number, h: number) => {
      const keep = st.globalAlpha;
      st.globalAlpha = 1;
      paintRect(x, y, w, h, `rgb(${ground.join(',')})`);
      st.globalAlpha = keep;
    },
    beginPath: () => { path = []; round = null; shapes = []; sub = null; },
    // A rounded rectangle's path, its radius clamped as the page's Canvas2D.roundRect clamps it (a path of its own).
    roundRect: (x: number, y: number, w: number, h: number, r: number) => { path = []; round = { x, y, w, h, r: Math.max(0, Math.min(r, w / 2, h / 2)) }; shapes = [round]; },
    rect: (x: number, y: number, w: number, h: number) => { shapes.push({ x, y, w, h, r: 0 }); },
    // Canvas2D.roundRect's own path: moveTo, an arcTo at each corner, closePath — a rounded rectangle, kept for clip().
    arcTo: (x1: number, y1: number, _x2: number, _y2: number, r: number) => { if (sub) sub.push({ x: x1, y: y1, r }); },
    closePath: () => {
      if (sub && sub.length === 4) {
        const xs = sub.map((c) => c.x), ys = sub.map((c) => c.y);
        const x = Math.min(...xs), y = Math.min(...ys);
        shapes.push({ x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, r: sub[0].r });
      }
      sub = null;
    },
    clip: (rule?: string) => {
      const evenOdd = rule === 'evenodd';
      const dev = shapes.map((s) => ({ x: s.x * k, y: s.y * k, w: s.w * k, h: s.h * k, r: s.r * k }));
      // A pixel wholly inside a shape, clear of its rounded corners, needs no samples.
      const whole = (s: Shape, x: number, y: number) => x >= s.x && x + 1 <= s.x + s.w && y >= s.y && y + 1 <= s.y + s.h &&
        ((x >= s.x + s.r && x + 1 <= s.x + s.w - s.r) || (y >= s.y + s.r && y + 1 <= s.y + s.h - s.r));
      const lets = (n: number) => (evenOdd ? n % 2 === 1 : n > 0);
      const next = new Float32Array(W * H);
      for (let py = 0; py < H; py++) {
        for (let pxx = 0; pxx < W; pxx++) {
          const hit = dev.filter((s) => s.x < pxx + 1 && s.x + s.w > pxx && s.y < py + 1 && s.y + s.h > py);
          let cover = 0;
          if (hit.every((s) => whole(s, pxx, py))) cover = lets(hit.length) ? 1 : 0;
          else {
            let n = 0;
            for (let sy = 0; sy < 8; sy++) for (let sx = 0; sx < 8; sx++) {
              const x = pxx + (sx + 0.5) / 8, y = py + (sy + 0.5) / 8;
              if (lets(hit.filter((s) => inShape(s, x, y)).length)) n++;
            }
            cover = n / 64;
          }
          next[py * W + pxx] = cover * clipAt(py * W + pxx);
        }
      }
      st.clipMask = next;
    },
    // Filling it covers each pixel by the share of its 8×8 samples inside the shape.
    fill: () => {
      if (!round) return;
      const s: Shape = { x: round.x * k, y: round.y * k, w: round.w * k, h: round.h * k, r: round.r * k };
      const c = colourAt(st.fillStyle, 0);
      tagPaint = String(st.fillStyle);
      for (let py = Math.max(0, Math.floor(s.y)); py < Math.min(H, Math.ceil(s.y + s.h)); py++) {
        for (let pxx = Math.max(0, Math.floor(s.x)); pxx < Math.min(W, Math.ceil(s.x + s.w)); pxx++) {
          let n = 0;
          for (let sy = 0; sy < 8; sy++) for (let sx = 0; sx < 8; sx++) if (inShape(s, pxx + (sx + 0.5) / 8, py + (sy + 0.5) / 8)) n++;
          if (!n) continue;
          const a = c[3] * Number(st.globalAlpha) * (n / 64) * clipAt(py * W + pxx);
          const o = (py * W + pxx) * 3;
          for (let i = 0; i < 3; i++) px[o + i] = px[o + i] * (1 - a) + c[i] * a;
          tag[py * W + pxx] = Math.max(tag[py * W + pxx], n / 64);
        }
      }
    },
    moveTo: (x: number, y: number) => { path.push([x, y]); sub = []; },
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
  return {
    ctx, nearBlack, W, H, at: (x: number, y: number) => [0, 1, 2].map((i) => px[(Math.round(y) * W + Math.round(x)) * 3 + i]) as RGB,
    /** Whether a name tag (pass 3) covers the pixel, in any part. */
    tagged: (x: number, y: number) => tag[Math.round(y) * W + Math.round(x)] > 0,
    /** Whether a name tag covers the whole pixel, every one of its samples. */
    taggedWhole: (x: number, y: number) => tag[Math.round(y) * W + Math.round(x)] >= 1,
    taggedShare: () => tag.reduce((n, v) => n + (v > 0 ? 1 : 0), 0) / (W * H),
    /** The paint the name tags were filled with. */
    tagPaint: () => tagPaint,
  };
}

type Band = { x: number; y: number; w: number; h: number; rgb: string };
/** A rectangle as drawTreemap leaves it in pxRects, with what it recorded painting it. */
type Texture = { stops: RGB[]; rects: number[][] };
type Painted = { n: Tile; x: number; y: number; w: number; h: number; frame: boolean; lines?: Band[]; lit?: boolean; stops?: RGB[]; fillRgb?: RGB; bg?: RGB[]; bands?: Band[]; tex?: Texture; lw?: number; seen?: RGB[] };

/**
 * `tiles` painted by the real drawTreemap onto a `W`×`H` css px map in `palette`'s theme, at device pixel ratio `dpr`: a raster of the device's pixels.
 * With everything the real map lays over the tiles that bears on its lines (review F2.2): a staged block's
 * amber hatch, as tmHatchPattern builds it (hatchOf), and each top-level folder's name tag, the half-black
 * rounded pill pass 3 fills (the page's roundRect, a rounded rectangle path). They were stubbed out, so the
 * hatch's amber was never beside a band, and the pills never over a line.
 *
 * With `bare` (lineCalls of the same map), the map as it would be with no leaf outline, no folder band and no
 * name tag drawn: what a name tag should lie over (review F3.1).
 */
function rasterPaint(tiles: Tile[], palette: Record<string, string>, W: number, H: number,
  colour: (n: Tile) => RGB = (n) => ramp.sizeRgb(n.size), history = { active: false, diff: false }, hideCloud = false, dpr = 1, bare?: Set<string>) {
  // The grid starts as the card the canvas sits on — what a cleared pixel shows — and the painter lays the
  // theme's --tm-canvas-bg over it, as on screen: so what the page reckons its ground to be is measured too.
  const raster = rasterCtx(Math.round(W * dpr), Math.round(H * dpr), cardGround(palette));
  const state = { treemap: { nodes: tiles, hideCloud, rootSize: 1e12, history, pxRects: [] as Painted[], colorMode: 'size', mode: 'treemap', query: '' } };
  const deps = {
    $: () => ({ clientWidth: W + 20 }), treemapCanvasHeight: () => H, window: { devicePixelRatio: dpr },
    tmCanvas: { style: {}, width: 0, height: 0 }, tmBuffer: { width: 0, height: 0 }, tmBufCtx: raster.ctx,
    cssVar: (name: string) => palette[name] ?? 'rgba(0,0,0,0)',
    state, tmNodeCapNote: () => '', renderAltNote() {}, tmSetEmpty() {}, renderSearchOverlay() {}, presentTreemap() {}, renderTmLegend() {},
    cellRgb: colour, tmPreview: { on: false },
    // The page's fallback ink, as tmHatchPattern has it.
    tmHatchPattern: () => hatchOf(palette['--warn'] || '#FF9F0A'),
    roundRect: (c: { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }, x: number, y: number, w: number, h: number, r: number) => c.roundRect(x, y, w, h, r),
    formatBytes: (n: number) => `${Math.round(n)} B`,
  };
  const onGrid = !bare ? raster.ctx : new Proxy(raster.ctx, {
    get(t, k: string) {
      if (k === 'strokeRect' || k === 'fillRect') {
        return (...a: number[]) => { if (!bare.has([k, k === 'strokeRect' ? t.strokeStyle : t.fillStyle, ...a].join('|'))) t[k](...a); };
      }
      if (k === 'fill') return () => {}; // the name tags, the only shapes this raster fills
      return t[k];
    },
    set(t, k: string, v) { t[k] = v; return true; },
  });
  // Resolving the helpers runs the painter, once per helper it turns out to need, each run stopping where a
  // helper is missing — on a context that keeps what a run left (a clip, a save) that would carry into the
  // next. So they are resolved on a recording context, and the grid gets one clean paint of its own from the
  // painter they resolved.
  let into: any = recordingCtx().ctx;
  const ctx = new Proxy({}, { get: (_t, k: string) => into[k], set: (_t, k: string, v) => { into[k] = v; return true; } });
  const draw = load<() => void>(['drawTreemap'], { ...deps, tmBufCtx: ctx }, 'drawTreemap', (d) => d());
  into = onGrid;
  draw();
  return { raster, px: state.treemap.pxRects };
}

/** The calls a paint draws its leaf lines (pass 2.6) and folder bands (pass 2.7) with, as rasterPaint's `bare` leaves them out. */
const lineCalls = (px: Painted[]) => new Set(px.flatMap((r) => [...(r.lines || []), ...(r.bands || [])].map((b) => ['fillRect', b.rgb, b.x, b.y, b.w, b.h].join('|'))));

/**
 * What lies under the top-level folders' name tags (review F3.1): every pixel a tag covers whole should be the
 * map with no outline or band drawn (`bare`), under the tag's own half black — the tag laid over the tiles
 * alone. A line stops at a tag's edge, as a frame's border stops at its legend: under the pill it would be
 * darkened by half with the tile beside it, about 2:1 between them, and on the size ramp's red, its blue or a
 * mid grey no colour at all reaches 3:1 there. `lines` counts the places where a line would run under a tag
 * whole (edgesOf) — a leaf's outline (`leaf`) apart from a folder's band (`frame`) — so a map whose tags cover
 * none cannot pass for one whose tags hide its lines; and `bandPx` counts the device pixels a band the painter
 * laid (r.bands) covers whole under a tag's whole pixel, so a map whose tags cover only leaf outlines cannot pass
 * for one that shows the bands stop there too (review F1.3).
 */
function underTags(raster: ReturnType<typeof rasterCtx>, bare: ReturnType<typeof rasterCtx>, px: Painted[], dpr = 1) {
  // The tags' paint — none when no tag was laid, and then no pixel is a tag's (`whole` stays 0).
  const [tr, tg, tb, ta] = raster.tagPaint() ? rgba(raster.tagPaint()) : [0, 0, 0, 0];
  const shown: string[] = [];
  let whole = 0;
  for (let y = 0; y < raster.H; y++) {
    for (let x = 0; x < raster.W; x++) {
      if (!raster.taggedWhole(x, y)) continue;
      whole++;
      const want = bare.at(x, y).map((v, i) => v * (1 - ta) + [tr, tg, tb][i] * ta);
      const got = raster.at(x, y);
      if (got.some((v, i) => Math.abs(v - want[i]) > 0.5) && shown.length < 8) shown.push(`${x},${y}: ${got.map(Math.round)} where the tag over the tiles alone is ${want.map(Math.round)}`);
    }
  }
  const under = edgesOf(px, raster.W, raster.H, dpr).filter((e) => raster.taggedWhole(...e.line));
  const lines = { leaf: under.filter((e) => e.kind === 'leaf').length, frame: under.filter((e) => e.kind === 'frame').length };
  let bandPx = 0;
  for (const b of px.flatMap((r) => r.bands || [])) {
    for (let y = Math.ceil(b.y * dpr - 1e-6); y < Math.floor((b.y + b.h) * dpr + 1e-6); y++) {
      for (let x = Math.ceil(b.x * dpr - 1e-6); x < Math.floor((b.x + b.w) * dpr + 1e-6); x++) if (raster.taggedWhole(x, y)) bandPx++;
    }
  }
  return { whole, lines, bandPx, shown };
}

/** A leaf the owner's rule gives lines of its own: 8 px or more on each side. Under it, a texture. */
const OUTLINED_PX = 8;
/**
 * The band a folder is framed by, as the owner's refinement has it (20 Oct 2026): by the folder's thinner side and
 * depth — 3 px for a top-level folder 96 px or more across, 2 px from 32 px (from 48 px nested), 1 px from 8 px, and
 * none under 8 px.
 */
const bandOf = (r: { w: number; h: number; n: Tile }) => {
  const m = Math.min(r.w, r.h);
  if (m < OUTLINED_PX) return 0;
  return r.n.depth <= 1 ? (m >= 96 ? 3 : m >= 32 ? 2 : 1) : (m >= 48 ? 2 : 1);
};
/** A painted rectangle on whole pixels (the painter lays them there; a painter that did not is measured where its rectangles round to). */
const whole = (r: Painted): Painted => ({ ...r, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.x + r.w) - Math.round(r.x), h: Math.round(r.y + r.h) - Math.round(r.y) });

/** Which side of the box `r` the line `l` lies along: the one it runs beside, nearest. */
function sideOf(l: Band, r: { x: number; y: number; w: number; h: number }): 'top' | 'bottom' | 'left' | 'right' {
  const d = { top: l.y - r.y, bottom: r.y + r.h - l.y - l.h, left: l.x - r.x, right: r.x + r.w - l.x - l.w };
  if (l.w > l.h) return d.top <= d.bottom ? 'top' : 'bottom';
  if (l.h > l.w) return d.left <= d.right ? 'left' : 'right';
  return (Object.entries(d).sort((p, q) => p[1] - q[1])[0][0]) as 'top';
}

/**
 * Every place a line meets a tile, as the raster shows it: [the line's pixel, the tile's pixel beside it, what and
 * where], on BOTH sides of every line — the owner's refinement asks each line to stand out from the tile on each of its
 * sides (20 Oct 2026). The lines are where the painter recorded laying them: each leaf's (r.lines, pass 2.6) and each
 * folder's band (r.bands, pass 2.7), and a hollow or staged cell's dashed edge; the raster says whether each was laid,
 * and in what colour — a line recorded and not drawn shows its tile's colour there, and fails the bar. That every two
 * leaves of OUTLINED_PX and up are parted by a line is held apart (partings). From each line's outer row or column of
 * device pixels the next pixel out is the tile, past one pixel some line covers only in part (a 1 px line at 150 %); a
 * pixel a line covers there, whole or (a second one) in part, means lines meet lines, and is not measured. Two pixels are left out at each end of
 * a line, where lines meet lines.
 */
function edgesOf(painted: Painted[], W: number, H: number, dpr = 1) {
  // 1: a pixel a line covers whole; 2: one it covers only in part.
  const map = new Uint8Array(W * H);
  const extent = (x: number, y: number, w: number, h: number) => ({ x0: x * dpr, y0: y * dpr, x1: (x + w) * dpr, y1: (y + h) * dpr });
  const mark = (x: number, y: number, w: number, h: number) => {
    const e = extent(x, y, w, h);
    for (let yy = Math.max(0, Math.floor(e.y0 + 1e-9)); yy < Math.min(H, Math.ceil(e.y1 - 1e-9)); yy++) {
      for (let xx = Math.max(0, Math.floor(e.x0 + 1e-9)); xx < Math.min(W, Math.ceil(e.x1 - 1e-9)); xx++) {
        const full = xx >= e.x0 - 1e-9 && xx + 1 <= e.x1 + 1e-9 && yy >= e.y0 - 1e-9 && yy + 1 <= e.y1 + 1e-9;
        const i = yy * W + xx;
        map[i] = map[i] === 1 || full ? 1 : 2;
      }
    }
  };
  const lines: Array<{ l: Band; kind: 'leaf' | 'frame'; r: Painted }> = [];
  for (const r of painted) {
    for (const l of r.lines || []) lines.push({ l, kind: 'leaf', r });
    for (const l of r.bands || []) lines.push({ l, kind: 'frame', r });
  }
  for (const { l } of lines) mark(l.x, l.y, l.w, l.h);
  // A hollow cloud cell's or a staged block's dashed edge, stroked 1 px in from its box, is a line too: where it meets a
  // band end-on, lines meet. Its inside — the ground, or its faint wash over it — is a tile.
  for (const r of painted) {
    const n = r.n as { freed?: boolean; cloudPlaceholder?: boolean };
    if (r.frame || r.stops || !(n.freed || n.cloudPlaceholder) || r.w <= 6 || r.h <= 6) continue;
    mark(r.x, r.y, r.w, 2); mark(r.x, r.y + r.h - 2, r.w, 2); mark(r.x, r.y, 2, r.h); mark(r.x + r.w - 2, r.y, 2, r.h);
  }
  const isTile = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && map[y * W + x] === 0;
  const isPart = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && map[y * W + x] === 2;
  const out: Array<{ line: [number, number]; tile: [number, number]; what: string; kind: 'leaf' | 'frame'; r: Painted }> = [];
  const skip = Math.ceil(2 * dpr);
  for (const { l, kind, r } of lines) {
    // The line's whole device pixels.
    const e = extent(l.x, l.y, l.w, l.h);
    const x0 = Math.ceil(e.x0 - 1e-9), x1 = Math.floor(e.x1 + 1e-9) - 1, y0 = Math.ceil(e.y0 - 1e-9), y1 = Math.floor(e.y1 + 1e-9) - 1;
    if (x1 < x0 || y1 < y0) continue;
    const what = kind === 'leaf'
      ? `${r.n.path} (${Math.round(r.w * dpr)}×${Math.round(r.h * dpr)} px), ${sideOf(l, r)} side`
      : `folder ${r.n.path} (depth ${r.n.depth}), ${sideOf(l, r)} band`;
    // Past at most one pixel a line covers in part — the one a 1 px line leaves at 125–175 % — to the tile; a second
    // such pixel is another line's edge, where lines meet lines.
    const step = (x: number, y: number, dx: number, dy: number) => {
      let tx = x + dx, ty = y + dy;
      if (isPart(tx, ty)) { tx += dx; ty += dy; }
      if (isTile(tx, ty)) out.push({ line: [x, y], tile: [tx, ty], what, kind, r });
    };
    for (let x = x0 + skip; x <= x1 - skip; x++) { step(x, y0, 0, -1); step(x, y1, 0, 1); }
    for (let y = y0 + skip; y <= y1 - skip; y++) { step(x0, y, -1, 0); step(x1, y, 1, 0); }
  }
  return out;
}

/**
 * Where two leaves of OUTLINED_PX and up meet, and where one meets a smaller leaf or a folder's own fill, as the
 * raster shows it (the owner's outline decision, refined): every device pixel along the boundary is parted by a line —
 * a pixel within 2 px of it, on one side or the other, stands out from the cushion of the leaf it lies in (r.seen) by
 * `EDGE_BAR`:1, as a line laid there does.
 * Two leaves meet at one line, laid in either; a leaf beside anything else has its own, unless the two tiles already
 * differ by the bar on the screen — the pixels on each side as the raster shows them, a smaller leaf's texture or a
 * folder's seam beside the edge included (review F1.5) — and the painter then lays none: no shade stands out from
 * both. Measured along each side of
 * each such leaf. A side along its folder's
 * edge counts the folder's band. Four pixels are left out at each end, where lines meet lines. Returns the places looked
 * at and the first that are not parted. `bar` is EDGE_BAR, or the painter's own TM_EDGE_MIN where a test holds it to that.
 */
function partings(raster: ReturnType<typeof rasterCtx>, painted: Painted[], dpr = 1, bar = EDGE_BAR) {
  // OUTLINED_PX and up on the device's pixels, as the painter takes the step (review F1.1): at 150 % a snapped width can
  // fall a hair under 8 css px.
  const lined = (r: Painted) => Math.min(Math.round(r.w * dpr), Math.round(r.h * dpr)) >= OUTLINED_PX * dpr;
  const leaves = painted.filter((r) => !r.frame && r.stops && lined(r));
  const dev = (r: Painted) => { const x = Math.round(r.x * dpr), y = Math.round(r.y * dpr); return { x, y, w: Math.round((r.x + r.w) * dpr) - x, h: Math.round((r.y + r.h) * dpr) - y }; };
  const owner = new Int32Array(raster.W * raster.H).fill(-1);
  const boxes = painted.map(dev);
  for (const [i, r] of painted.entries()) {
    if (r.frame) continue;
    const d = boxes[i];
    for (let y = Math.max(0, d.y); y < Math.min(raster.H, d.y + d.h); y++) for (let x = Math.max(0, d.x); x < Math.min(raster.W, d.x + d.w); x++) owner[y * raster.W + x] = i;
  }
  // Clear of each end by more than the widest band, where lines meet lines.
  const skip = Math.ceil(4 * dpr);
  let looked = 0;
  const unparted: string[] = [];
  // Whether the pixel p stands out from the cushion the leaf r was painted with, as the screen shows it (r.seen), on p's row.
  const cushion = (r: Painted, y: number) => lerp(r.seen![0], r.seen![1], Math.max(0, Math.min(1, ((y + 0.5) / dpr - r.y) / r.h)));
  const stands = (p: [number, number], r: Painted) => contrast(raster.at(...p), cushion(r, p[1])) >= bar - 0.01;
  for (const r of leaves) {
    const i = painted.indexOf(r), d = boxes[i];
    const sides: Array<[string, number, number, number, number, number, number]> = [
      // side, first pixel x, y, step along x, y, outward x, y
      ['top', d.x, d.y, 1, 0, 0, -1], ['bottom', d.x, d.y + d.h - 1, 1, 0, 0, 1],
      ['left', d.x, d.y, 0, 1, -1, 0], ['right', d.x + d.w - 1, d.y, 0, 1, 1, 0],
    ];
    for (const [side, sx, sy, ax, ay, ox, oy] of sides) {
      const len = ax ? d.w : d.h;
      for (let k = skip; k < len - skip; k++) {
        const px: [number, number] = [sx + ax * k, sy + ay * k], qx: [number, number] = [px[0] + ox, px[1] + oy];
        if (qx[0] < 0 || qx[1] < 0 || qx[0] >= raster.W || qx[1] >= raster.H) continue; // the map's own edge
        if (raster.tagged(...px) || raster.tagged(...qx)) continue;
        looked++;
        // A line on this leaf's side — its own, or a band of a folder it lies in — within its outer 2 px.
        const near = (p: [number, number], dir: number) => Array.from({ length: Math.ceil(2 * dpr) }, (_, k) => [p[0] + dir * ox * k, p[1] + dir * oy * k] as [number, number]);
        if (near(px, -1).some((p) => stands(p, r))) continue;
        const j = owner[qx[1] * raster.W + qx[0]];
        const other = j >= 0 ? painted[j] : null;
        // On the other side, a leaf of OUTLINED_PX and up whose own line lies there.
        if (other && other.seen && lined(other) && near(qx, 1).some((p) => stands(p, other))) continue;
        // Or the two tiles already part themselves, by the bar: no line is needed there — as the screen shows them, the
        // pixel on each side: the other's cushion or its texture, a folder's own fill or its seam (review F1.5).
        if (contrast(raster.at(...px), raster.at(...qx)) >= bar - 0.01) continue;
        if (unparted.length < 8) unparted.push(`${r.n.path} ${side} side at ${px}: ${raster.at(...px).map(Math.round)} beside ${raster.at(...qx).map(Math.round)}${other ? ` (${other.n.path})` : ''}`);
      }
    }
  }
  return { looked, unparted };
}

/**
 * The weakest line-against-tile contrast in each `kind`, and every place under the bar.
 *
 * A place where a top-level folder's name tag (pass 3) covers the line's pixel or the tile's, in any part,
 * is left out, and counted in `tagged` (review F2.2): the tag is a label laid over the map — its folder's
 * name in white on a half-black pill — and no line is drawn under it (review F3.1; underTags holds that, pixel
 * by pixel, wherever a tag covers a pixel whole), so there is no line there to measure. Everywhere else the bar holds.
 */
function measureEdges(raster: ReturnType<typeof rasterCtx>, px: Painted[], dpr = 1) {
  const all = edgesOf(px, raster.W, raster.H, dpr);
  const edges = all.filter((e) => !raster.tagged(...e.line) && !raster.tagged(...e.tile));
  const tagged = all.length - edges.length;
  const under: string[] = [];
  const worst = { leaf: Infinity, frame: Infinity };
  for (const e of edges) {
    const c = contrast(raster.at(...e.line), raster.at(...e.tile));
    worst[e.kind] = Math.min(worst[e.kind], c);
    if (c < EDGE_BAR && under.length < 12) under.push(`${e.what}: ${fmt(c)}:1 (${raster.at(...e.line).map(Math.round)} on ${raster.at(...e.tile).map(Math.round)})`);
  }
  return { edges, worst, under, tagged };
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

test('owner\'s outlines: a folder\'s band is heavier and higher-contrast than a leaf\'s line beside the same colour — 2 px here, for a top-level folder 54 px across and a nested one 48 px across (the owner\'s refinement sizes a band by its folder), and on the size ramp always the stronger line', () => {
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    const b = colourBlocks(EVERY_COLOUR, 16, 16);
    const { raster, px } = rasterPaint(b.tiles, palette, b.W, b.H, b.colour);
    const { edges } = measureEdges(raster, px);
    for (const [i, c] of EVERY_COLOUR.entries()) {
      const mine = edges.filter((e) => e.r.n.path.startsWith(`/m/t${i}/`) || e.r.n.path === `/m/t${i}`);
      const leaf = Math.min(...mine.filter((e) => e.kind === 'leaf' && e.r.n.path.endsWith('/f4')).map((e) => contrast(raster.at(...e.line), raster.at(...e.tile))));
      // A band against the tiles inside its folder — beside the same colour; beyond it, the next block or the ground.
      const inBox = (e: { tile: [number, number]; r: Painted }) => e.tile[0] >= e.r.x && e.tile[0] < e.r.x + e.r.w && e.tile[1] >= e.r.y && e.tile[1] < e.r.y + e.r.h;
      const frame = Math.min(...mine.filter((e) => e.kind === 'frame' && inBox(e)).map((e) => contrast(raster.at(...e.line), raster.at(...e.tile))));
      assert.ok(Number.isFinite(leaf) && Number.isFinite(frame), `${theme}, ${c.name}: control — both lines measured`);
      assert.ok(frame >= leaf, `${theme}, ${c.name}: a folder's band (${fmt(frame)}:1) is no weaker than a leaf's outline (${fmt(leaf)}:1)`);
      if (i < RAMP_COLOURS.length) assert.ok(frame > leaf + 0.5, `${theme}, ${c.name}: on the size ramp the band (${fmt(frame)}:1) is clearly the stronger line than the leaf's outline (${fmt(leaf)}:1)`);
    }
    const top = px.find((r) => r.n.depth === 1)!, nested = px.find((r) => r.n.depth === 2)!;
    assert.deepEqual([Math.min(top.w, top.h), Math.min(nested.w, nested.h)], [54, 48], `${theme}: control — the folders' thinner sides`);
    assert.equal(top.bands!.find((x) => x.y === top.y)!.h, 2, `${theme}: a top-level folder 54 px across has a 2 px band`);
    assert.equal(nested.bands!.find((x) => x.y === nested.y)!.h, 2, `${theme}: a nested folder 48 px across has a 2 px band, twice a leaf's line`);
  }
});

/** How many pixels, from (x, y) stepping (dx, dy), are within 1.02:1 of the first — a band's width as the raster shows it. */
function runOf(raster: ReturnType<typeof rasterCtx>, x: number, y: number, dx: number, dy: number): number {
  const first = raster.at(x, y);
  let k = 1;
  while (k < 12 && contrast(raster.at(x + dx * k, y + dy * k), first) < 1.02) k++;
  return k;
}

test('owner\'s outlines: a folder\'s band is visibly heavier than a leaf\'s outline at every depth Depth 4 draws — on the pixels, 3 px at the top level and 2 px at depths 2 and 3, against a 1 px leaf outline (review F1.3)', () => {
  // /t holds /t/n, which holds /t/n/m and a file; /t/n/m holds four files. Every folder has room for its whole band.
  const dir = (path: string, depth: number, x: number, y: number, w: number, h: number): Tile => ({ name: path, path, size: 4e9 / depth, type: 'dir', depth, expanded: true, x, y, w, h });
  const file = (path: string, depth: number, x: number, y: number, w: number, h: number, size: number): Tile => ({ name: path, path, size, type: 'file', depth, expanded: false, x, y, w, h });
  const tiles = [
    dir('/t', 1, 0, 0, 100, 100), dir('/t/n', 2, 10, 10, 80, 80), dir('/t/n/m', 3, 10, 10, 50, 80),
    file('/t/n/f', 3, 60, 10, 30, 80, 3e8),
    file('/t/n/m/a', 4, 10, 10, 25, 40, 2e8), file('/t/n/m/b', 4, 35, 10, 25, 40, 9e7), file('/t/n/m/c', 4, 10, 50, 25, 40, 4e7), file('/t/n/m/d', 4, 35, 50, 25, 40, 1e7),
  ];
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    const { raster, px } = rasterPaint(tiles, palette, 400, 400);
    const at = (path: string) => whole(px.find((r) => r.n.path === path)!);
    // Each band measured where it lies beside its own fill or a file, away from any other line: its top edge, a third of the way along.
    const t = at('/t'), n = at('/t/n'), m = at('/t/n/m'), leaf = at('/t/n/m/b');
    const bands = { top: runOf(raster, t.x + 6, t.y, 0, 1), 'depth 2': runOf(raster, n.x + n.w - 20, n.y, 0, 1), 'depth 3': runOf(raster, m.x + 20, m.y, 0, 1) };
    // A leaf's outline where it lies inside its folder, touching no folder edge: b's left side, beside a.
    const outline = runOf(raster, leaf.x, leaf.y + Math.floor(leaf.h / 2), 1, 0);
    assert.equal(outline, 1, `${theme}: control — a leaf's outline is 1 px on the pixels`);
    assert.deepEqual(bands, { top: 3, 'depth 2': 2, 'depth 3': 2 }, `${theme}: the bands' widths on the pixels`);
    for (const [where, w] of Object.entries(bands)) assert.ok(w > outline, `${theme}: the ${where} band (${w} px) is heavier than a leaf's outline (${outline} px)`);
  }
});

test('owner\'s outlines, refined: a band is sized by its folder — none under 8 px across, 1 px from 8 px, never over a third of its thinner side — and a thin folder keeps its own colour and texture inside its band (review F1.12; the owner\'s refinement of 20 Oct 2026)', () => {
  // Folders 2 to 10 px thick, at the top level and nested, each holding nothing over the floor: filled with its own colour (J51).
  const tiles: Tile[] = [];
  const thick = [2, 3, 4, 5, 6, 7, 8, 9, 10];
  // The top-level ones side by side along the top of a 100 px map, a file beside and below them so no bare ground lies
  // beside one; the nested ones 2 px apart inside /host, clear of its band, beside its own fill.
  const xs = thick.map((_t, i) => thick.slice(0, i).reduce((a, t) => a + t + 2, 0));
  const ts = thick.map((_t, i) => thick.slice(0, i).reduce((a, t) => a + t, 0));
  for (const [i, t] of thick.entries()) {
    tiles.push({ name: `top${t}`, path: `/top${t}`, size: 5e9, type: 'dir', depth: 1, expanded: true, x: ts[i], y: 0, w: t, h: 40 } as Tile);
  }
  const used = ts[ts.length - 1] + thick[thick.length - 1];
  tiles.push({ name: 'beside.bin', path: '/beside.bin', size: 5e9, type: 'file', depth: 1, expanded: false, x: used, y: 0, w: 100 - used, h: 40 } as Tile);
  tiles.push({ name: 'below.bin', path: '/below.bin', size: 5e9, type: 'file', depth: 1, expanded: false, x: 0, y: 40, w: 100, h: 10 } as Tile);
  tiles.push({ name: 'host', path: '/host', size: 5e10, type: 'dir', depth: 1, expanded: true, x: 0, y: 50, w: 100, h: 50 } as Tile);
  for (const [i, t] of thick.entries()) {
    tiles.push({ name: `n${t}`, path: `/host/n${t}`, size: 5e9, type: 'dir', depth: 2, expanded: true, x: 5 + xs[i], y: 55, w: t, h: 40 } as Tile);
  }
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    const { raster, px } = rasterPaint(tiles, palette, 100, 100);
    for (const t of thick) {
      for (const path of [`/top${t}`, `/host/n${t}`]) {
        const r = whole(px.find((p) => p.n.path === path)!);
        const want = t < 8 ? 0 : 1;
        // Its left band: the side bands run between the top and bottom ones.
        const left = (r.bands || []).find((b) => b.x === r.x && b.y > r.y && b.y + b.h < r.y + r.h);
        assert.equal(left ? left.w : 0, want, `${theme}, ${path} (${t} px wide): its band is ${want ? `${want} px` : 'none'}`);
        if (!want) assert.deepEqual(r.bands, [], `${theme}, ${path} (${t} px wide): no band on any side`);
        assert.ok(want <= Math.floor(t / 3), `${theme}, ${path}: no more than a third of ${t} px`);
        // Inside both side bands, the folder's own fill, and its texture every 4 px from its corner — a pixel clear of
        // each band: its colour, not a band's.
        const y = r.y + 22; // a row of the fill between two of the texture's rows
        const fill = lerp(r.bg![0], r.bg![1], (y + 0.5 - r.y) / r.h), seam = lerp(r.tex!.stops[0], r.tex!.stops[1], (y + 0.5 - r.y) / r.h);
        for (let x = r.x + want; x < r.x + r.w - want; x++) {
          const on = (x - r.x) % 4 === 0 && (!want || (x - r.x > want && x - r.x < r.w - want - 1));
          assert.ok(contrast(raster.at(x, y), on ? seam : fill) < 1.05, `${theme}, ${path}: pixel ${x - r.x} across is the folder's own ${on ? 'texture' : 'fill'}`);
        }
      }
    }
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

/** The real drawTreemap on a recording context whose every variable is `ground` (a light theme's, by default). */
function paintOn(tiles: Tile[], colour: (n: Tile) => RGB, ground = '#e8e9ee') {
  const rec = recordingCtx();
  const state = { treemap: { nodes: tiles, hideCloud: false, rootSize: 1e12, history: { active: false, diff: false }, pxRects: [] as any[], colorMode: 'size', mode: 'treemap', query: '' } };
  const draw = load<() => void>(['drawTreemap'], {
    $: () => ({ clientWidth: MAP_W + 20 }), treemapCanvasHeight: () => MAP_H, window: { devicePixelRatio: 1 },
    tmCanvas: { style: {}, width: 0, height: 0 }, tmBuffer: { width: 0, height: 0 }, tmBufCtx: rec.ctx, cssVar: () => ground, state,
    tmNodeCapNote: () => '', renderAltNote() {}, tmSetEmpty() {}, renderSearchOverlay() {}, presentTreemap() {}, renderTmLegend() {},
    cellRgb: colour, tmHatchPattern: () => null, tmPreview: { on: false }, roundRect() {}, formatBytes: (n: number) => `${Math.round(n)} B`,
  }, 'drawTreemap', (d) => d());
  rec.fills.length = 0; rec.texts.length = 0; rec.ops.length = 0; rec.strokes.length = 0; rec.lines.length = 0;
  draw();
  return Object.assign(rec, { px: state.treemap.pxRects as Painted[] });
}

test('owner\'s outlines, refined: a leaf under 8 px has no line of its own — a faint texture along its top and left edges in a shade of its own colour, 1.1:1 at 2 px rising to 1.375:1 at 7 px, and none at 1 px; one of 8 px and up has 1 px lines in a shade of its own colour, a highlight only under a dark one', () => {
  // Literal sizes about the rule's edges, so moving either — the lines to 24 px, the texture to 4 — fails here. Each leaf
  // alone on the light theme's ground, so it lines every side of its own.
  const leaf = (name: string, x: number, px: number, size = 2e6): Tile => ({ name, path: `/r/${name}`, size, type: 'file', depth: 1, expanded: false, x, y: 50, w: px / 10, h: px / 10 });
  const tiles = [leaf('one', 2, 1), leaf('two', 5, 2), leaf('four', 8, 4), leaf('seven', 10, 7), leaf('eight', 20, 8), leaf('nine', 30, 9), leaf('twenty', 40, 20)];
  const rec = paintOn(tiles, (n) => ramp.sizeRgb(n.size));
  const near = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.01);
  const rectOps = rec.ops.filter((op): op is Extract<Op, { kind: 'rect' }> => op.kind === 'rect');
  for (const [name, x, side] of [['one', 20, 1], ['two', 50, 2], ['four', 80, 4], ['seven', 100, 7], ['eight', 200, 8], ['nine', 300, 9], ['twenty', 400, 20]] as const) {
    const y = 500;
    const r = rec.px.find((p) => p.n.name === name)!;
    assert.ok(rectOps.some((op) => near(op.rect, [x, y, side, side]) && typeof op.style === 'object'), `${name} (${side} px): its cushion fills its box edge to edge`);
    assert.equal(rec.strokes.filter((st) => st.rect[0] >= x && st.rect[0] < x + side && st.rect[1] >= y && st.rect[1] < y + side).length, 0, `${name}: no stroked outline`);
    if (side < OUTLINED_PX) {
      assert.equal(r.lines, undefined, `${name} (${side} px): no line of its own`);
      assert.equal(r.lit, undefined, `${name}: and no highlight`);
      if (side < 2) { assert.equal(r.tex, undefined, `${name} (1 px): too thin for a texture too`); continue; }
      // Its texture: its top row and its left column below it, filled with a cushion of the texture's own stops.
      assert.ok(r.tex, `${name} (${side} px): a texture recorded`);
      assert.deepEqual(r.tex!.rects, [[x, y, side, 1], [x, y + 1, 1, side - 1]], `${name}: a texture along its top and left edges`);
      for (const box of r.tex!.rects) {
        const op = rectOps.find((o) => near(o.rect, box));
        assert.ok(op && typeof op.style === 'object' && (op.style as Grad).stops.map(([, c]) => c).join() === r.tex!.stops.map((c) => `rgb(${c.join(',')})`).join(), `${name}: its texture at ${box} is laid in the texture's cushion`);
      }
      const want = 1.1 + 0.055 * (side - 2);
      for (const [i, t] of r.tex!.stops.entries()) {
        const c = contrast(t, r.stops![i]);
        assert.ok(c >= want - 1e-9 && c < want + 0.12, `${name} (${side} px): its texture stands ${fmt(c)}:1 from its cushion (${fmt(want)}:1 asked)`);
        assert.ok(luminance(t) < luminance(r.stops![i]), `${name}: a darker shade on a light tile`);
      }
      continue;
    }
    assert.equal(r.tex, undefined, `${name} (${side} px): no texture, lines`);
    // Alone on the ground, its lines run around all four sides, each its side's whole length.
    assert.deepEqual(r.lines!.map((l) => [l.x, l.y, l.w, l.h]), [[x, y, side, 1], [x, y, 1, side], [x + side - 1, y, 1, side], [x, y + side - 1, side, 1]], `${name}: its four lines`);
    for (const l of r.lines!) {
      assert.ok(rectOps.some((op) => op.style === l.rgb && near(op.rect, [l.x, l.y, l.w, l.h])), `${name}: its line at ${l.x},${l.y} is laid in the tone it recorded`);
      const [er, eg, eb, ea] = rgba(l.rgb);
      assert.equal(ea, 1, `${name}: the line is opaque — it does not let the ground through`);
      assert.ok(!(er === 0 && eg === 0 && eb === 0), `${name}: a shade of its own colour, not flat black (${l.rgb})`);
    }
    const highlight = rec.lines.filter((l) => near(l.seg, [x + 1, y + 1.5, x + side - 1, y + 1.5]));
    assert.equal(highlight.length, r.lit ? 1 : 0, `${name}: a highlight ${r.lit ? 'along its top row, under its dark line' : 'only under a dark line'}`);
    // The highlight's white is a share of 0.18 as the tile's cushion is of the whole (60 px): on a short tile, whose
    // cushion is shallow, it would otherwise be a light line of its own, stepping in at 8 px with the lines.
    if (r.lit) assert.equal(rgba(highlight[0].style)[3], 0.18 * Math.min(1, side / 60), `${name} (${side} px): its highlight's white (${highlight[0].style})`);
  }

  // On a dark tile — Reclaim's "not scored" grey — the shades are lighter than the tile, and no highlight sits beside them.
  const grey = paintOn([leaf('grey', 60, 20), leaf('dot', 70, 5)], () => [0x3a, 0x40, 0x48], '#0e0e13');
  const g = grey.px.find((p) => p.n.name === 'grey')!, dot = grey.px.find((p) => p.n.name === 'dot')!;
  assert.ok(g.lines!.length > 0 && g.lines!.every((l) => luminance(rgba(l.rgb).slice(0, 3) as RGB) > luminance([0x3a, 0x40, 0x48])), `a dark tile's lines are lighter shades (${g.lines!.map((l) => l.rgb)})`);
  assert.equal(g.lit, false, 'and it has no highlight');
  assert.ok(dot.tex!.stops.every((t, i) => luminance(t) > luminance(dot.stops![i])), 'and a small dark tile\'s texture is a lighter shade');
});

test('owner\'s outlines: a line takes the shade of its tile\'s colour nearest it that stands out from every colour beside it — of the shades toward black and toward white that reach the bar, the one fewer 32nds away, black on a tie; where none does, the one that comes nearest', () => {
  const tone = load<(base: RGB, beside: RGB[], target: number) => { rgb: RGB; light: boolean; ok: boolean }>(['tmTone'], {}, 'tmTone', (t) => { t([108, 122, 137], [[108, 122, 137]], 3.3); });
  const mixed = (a: RGB, b: RGB, t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as RGB;
  const nearest = (base: RGB, beside: RGB[], target: number) => {
    for (let k = 1; k <= 32; k++) for (const toward of [[0, 0, 0], [255, 255, 255]] as RGB[]) {
      const c = mixed(base, toward, k / 32);
      if (beside.every((b) => contrast(c, b) >= target)) return c;
    }
    return null;
  };
  // Grey tiles both shades reach — the Trash cell, the History diff's "unchanged" — a light tile, a dark one, and a
  // line between a light tile and the dark theme's ground, which only a shade between them serves.
  const cases: Array<[string, RGB, RGB[], number]> = [
    ['the Trash cell', [108, 122, 137], [[108, 122, 137]], 3.3],
    ['History diff unchanged', [116, 122, 134], [[116, 122, 134]], 3.3],
    ['size ramp amber', ramp.sizeRgb(1e8), [ramp.sizeRgb(1e8)], 3.3],
    ['Reclaim not scored', [0x3a, 0x40, 0x48], [[0x3a, 0x40, 0x48]], 3.3],
    ['size ramp amber beside the dark ground', ramp.sizeRgb(1e8), [ramp.sizeRgb(1e8), canvasGround(DARK)], 3.3],
  ];
  for (const [what, base, beside, target] of cases) {
    const want = nearest(base, beside, target), got = tone(base, beside, target);
    assert.ok(want, `${what}: control — some shade reaches ${target}:1`);
    assert.deepEqual(got.rgb, want, `${what}: the nearest shade that reaches ${target}:1 (${got.rgb} where ${want} is nearer)`);
    assert.equal(got.ok, true, `${what}: and says it reached it`);
  }
  const both = nearest([108, 122, 137], [[108, 122, 137]], 3.3)!;
  assert.ok(luminance(both) < luminance([108, 122, 137]) && contrast(mixed([108, 122, 137], [255, 255, 255], 1), [108, 122, 137]) >= 3.3, 'control: on the Trash cell white reaches the bar too, and the darker shade is nearer');
  // Where no shade reaches it — a band's 4.5:1 against the size ramp's red over its whole cushion, 16% white at its top
  // to 22% black at its foot (REPORT problem 8) — the one that comes nearest: black.
  const r0 = ramp.sizeRgb(2e10), redCushion = [mixed(r0, [255, 255, 255], 0.16), mixed(r0, [0, 0, 0], 0.22)];
  const red = tone(r0, redCushion, 4.5);
  assert.equal(red.ok, false, 'control: no shade of the red reaches 4.5:1 against its whole cushion');
  assert.deepEqual(red.rgb, [0, 0, 0], `on the red, the nearest to 4.5:1 is black (${red.rgb})`);
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
      // In the middle of a cell of its texture (the owner's refinement: a seam every 4 px from its corner), on its fill.
      const px0 = r.x + Math.floor((r.w * x) / 4) * 4 + 2, py0 = r.y + Math.floor((r.h * y) / 4) * 4 + 2;
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
    // (inside its edge the page lays --tm-canvas-bg once more, as it always has: a shade under the ground)
    const stagedGround = over(rgba(palette['--tm-canvas-bg']), ground);
    assert.ok(contrast(hollow.raster.at(50, 50), stagedGround) < 1.01, `${theme}: the staged block shows the ground (${hollow.raster.at(50, 50).map(Math.round)}, want ${stagedGround.map(Math.round)})`);
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
        // …and between two of its texture's seams (one every 4 px from its corner, the owner's refinement): its fill.
        if ((x - g.x) % 4 !== 0 && (y - g.y) % 4 !== 0 && !inside.some((c) => x + 0.5 > c.x - 4 && x + 0.5 < c.x + c.w + 4 && y + 0.5 > c.y - 4 && y + 0.5 < c.y + c.h + 4)) spot = [x, y];
      }
    }
    assert.ok(spot, `${theme}: control — a part of /r/g no rectangle covers`);
    const shown = raster.at(...spot!);
    const want = lerp(g.bg![0], g.bg![1], (spot![1] + 0.5 - g.y) / g.h);
    assert.ok(contrast(shown, ground) > 1.3, `${theme}: not the map's ground there (${shown.map(Math.round)} on ${ground.map(Math.round)})`);
    assert.ok(contrast(shown, want) < 1.05, `${theme}: /r/g's own cushion there (${shown.map(Math.round)}, want ${want.map(Math.round)})`);
  }
});

test('J51 in every colouring: a folder with nothing drawn in it is filled with the colour the map shows for it — its Age band, its Reclaim score, "not scored", its History diff colour seen through the diff\'s washes — never the size ramp\'s (review F1.8)', () => {
  const ages = OTHER_COLOURS.filter((c) => c.name.startsWith('Age band ')).map((c) => c.rgb);
  const scores = OTHER_COLOURS.filter((c) => /^Reclaim score \d+$/.test(c.name)).map((c) => c.rgb);
  const unscored = OTHER_COLOURS.find((c) => c.name === 'Reclaim not scored')!.rgb;
  const pick = <T,>(list: T[], path: string): T => list[[...path].reduce((a, ch) => a + ch.charCodeAt(0), 0) % list.length];
  // The History diff: each node's earlier size decides its colour, and each folder that grew, shrank or is new is washed.
  const prevKind: Record<string, string> = { '/c': 'unchanged', '/c/Mail': 'grew', '/c/Mail/INBOX': 'shrank', '/c/Mail/Sent': 'new', '/c/Wide folder': 'shrank', '/c/Half': 'grew', '/c/Half/big.mov': 'unchanged' };
  const withPrev = subFloorTiles().map((n) => ({ ...n, prevSize: PREV[prevKind[n.path]](n.size) } as Tile));
  const SAME = DIFF_PAGE.diffRgb({ size: 1, prevSize: 1 });
  const modes: Array<[string, Tile[], (n: Tile) => RGB, { active: boolean; diff: boolean }]> = [
    ['Age', subFloorTiles(), (n) => pick(ages, n.path), { active: false, diff: false }],
    ['Reclaim', subFloorTiles(), (n) => pick(scores, n.path), { active: false, diff: false }],
    ['Reclaim, not scored', subFloorTiles(), () => unscored, { active: false, diff: false }],
    ['History diff', withPrev, (n) => DIFF_PAGE.diffRgb(n), { active: true, diff: true }],
  ];
  const spots = [['/c/Mail/INBOX', 0.5, 0.5], ['/c/Mail/Sent', 0.5, 0.5], ['/c/Mail', 0.85, 0.5], ['/c/Wide folder', 0.5, 0.5], ['/c/Half', 0.75, 0.5], ['/c', 0.9, 0.9]] as const;
  for (const [mode, tiles, colour, history] of modes) {
    for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
      const { raster, px } = rasterPaint(tiles, palette, 400, 400, colour, history);
      for (const [path, fx, fy] of spots) {
        const r = whole(px.find((p) => p.n.path === path)!);
        const own = colour(r.n), amp = Math.min(1, r.h / 60);
        assert.notDeepEqual(own, ramp.sizeRgb(r.n.size), `${mode}, ${path}: control — its colour here is not its size ramp colour`);
        const cushion: RGB[] = [mix3(own, [255, 255, 255], 0.16 * amp) as RGB, mix3(own, [0, 0, 0], 0.22 * amp) as RGB];
        assert.deepEqual(r.bg, cushion, `${theme}, ${mode}, ${path}: its fill is the cushion of the colour the map shows for it`);
        // On the pixels — in the middle of a cell of its texture, on its fill — that cushion, through the wash of each
        // changed folder over it, in the order the map lays them.
        const x = r.x + Math.floor((r.w * fx) / 4) * 4 + 2, y = r.y + Math.floor((r.h * fy) / 4) * 4 + 2;
        let want = lerp(cushion[0], cushion[1], (y + 0.5 - r.y) / r.h);
        if (history.diff) {
          for (const f of px) {
            const c = DIFF_PAGE.diffRgb(f.n);
            if (f.frame && c.join() !== SAME.join() && x >= f.x + 1 && x < f.x + f.w - 1 && y >= f.y + 1 && y < f.y + f.h - 1) want = lerp(want, c, 0.3);
          }
        }
        assert.ok(contrast(raster.at(x, y), want) < 1.05, `${theme}, ${mode}, ${path}: shows that colour (${raster.at(x, y).map(Math.round)}, want ${want.map(Math.round)})`);
      }
    }
  }
});

test('owner\'s outlines: a folder\'s band beside a cell that shows the map\'s ground — a hollow online-only file, a staged block, the part of a folder an online-only file is hidden in — reaches 3:1 against what that cell shows, in both themes (review F1.5)', () => {
  const dir = (path: string, depth: number, x: number, y: number, w: number, h: number): Tile => ({ name: path, path, size: 4e10 / depth, type: 'dir', depth, expanded: true, x, y, w, h });
  const file = (path: string, depth: number, x: number, y: number, w: number, h: number, more: object = {}): Tile => ({ name: path, path, size: 3e9, type: 'file', depth, expanded: false, x, y, w, h, ...more } as Tile);
  const cloud = { cloudPlaceholder: true };
  // /a: a file and a hollow online-only file, side by side. /b: a nested folder, a file beside a hollow one.
  const hollow = [
    dir('/a', 1, 0, 0, 50, 100), file('/a/here.bin', 2, 0, 0, 25, 100), file('/a/away.mov', 2, 25, 0, 25, 100, cloud),
    dir('/b', 1, 50, 0, 50, 100), dir('/b/n', 2, 55, 5, 40, 90), file('/b/n/here.bin', 3, 55, 5, 20, 90), file('/b/n/away.mov', 3, 75, 5, 20, 90, cloud),
  ];
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    const cases: Array<[string, ReturnType<typeof rasterPaint>, (x: number, y: number) => boolean]> = [];
    const h = rasterPaint(hollow, palette, 400, 200);
    const cell = (pxs: Painted[], path: string) => { const r = whole(pxs.find((p) => p.n.path === path)!); return (x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h; };
    const inA = cell(h.px, '/a/away.mov'), inN = cell(h.px, '/b/n/away.mov');
    cases.push(['beside a hollow online-only file', h, (x, y) => inA(x, y) || inN(x, y)]);
    // The staged block, as the page's own preview lays it out, in the nested folder /r/g/p.
    const s = rasterPaint(stagedInNestedFolder(), palette, 400, 200);
    cases.push(['beside a staged block', s, cell(s.px, '/r/g/p — freed')]);
    // /g holds a file and an online-only file, hidden: /g is not filled where it would be (J51), so the ground shows there.
    const hid = rasterPaint([dir('/g', 1, 0, 0, 100, 100), file('/g/here.bin', 2, 0, 0, 50, 100), file('/g/away.mov', 2, 50, 0, 50, 100, cloud)], palette, 400, 200, undefined, undefined, true);
    const g = whole(hid.px[0]);
    cases.push(['beside the ground where an online-only file is hidden', hid, (x, y) => x >= g.x + g.w / 2 && y >= g.y && y < g.y + g.h]);
    for (const [what, { raster, px }, inCell] of cases) {
      const m = measureEdges(raster, px);
      const beside = m.edges.filter((e) => e.kind === 'frame' && inCell(...e.tile));
      assert.ok(beside.length > 100, `${theme}, ${what}: control — ${beside.length} places where a band meets that cell were measured`);
      if (what === 'beside a staged block') {
        // The block's amber hatch is on the raster, as the page draws it (review F2.2): many of the places a band
        // meets the block are on a hatch line — the amber at half over the ground the block shows inside its
        // edge — and the band is held to the bar against those too, below.
        const inside = over(rgba(palette['--tm-canvas-bg']), canvasGround(palette));
        const amberLine = lerp(inside, rgba(palette['--warn']).slice(0, 3) as RGB, 0.5);
        const onLine = beside.filter((e) => contrast(raster.at(...e.tile), amberLine) < 1.1);
        assert.ok(onLine.length > 10, `${theme}: control — ${onLine.length} of the ${beside.length} places a band meets the staged block are on its hatch's amber lines (${amberLine.map(Math.round)})`);
      }
      if (what === 'beside a hollow online-only file') {
        // A band beside a hollow cell is a shade of the cell's own colour, toward black or white — not of the
        // folder's (review F1.5; F2.2 found nothing held it).
        const cellRgb = ramp.sizeRgb(3e9);
        const shadeOf = (c: RGB, base: RGB) => {
          // How far toward black (read off its brightest channel) or toward white (off the channel furthest from white).
          const hi = base.indexOf(Math.max(...base)), lo = base.indexOf(Math.min(...base));
          const dark = c[hi] / base[hi], light = (c[lo] - base[lo]) / (255 - base[lo]);
          return c.every((v, i) => Math.abs(v - base[i] * dark) <= 1.5) || c.every((v, i) => Math.abs(v - (base[i] + (255 - base[i]) * light)) <= 1.5);
        };
        assert.notDeepEqual(cellRgb, ramp.sizeRgb(4e10), `${theme}: control — the cell's colour is not its folder's`);
        const off = beside.map((e) => raster.at(...e.line).map(Math.round) as RGB).filter((c) => !shadeOf(c, cellRgb));
        assert.deepEqual(off.slice(0, 4), [], `${theme}: every band beside the hollow cell is a shade of its colour ${cellRgb} (${off.length} of ${beside.length} not)`);
      }
      const weak = beside.map((e) => ({ e, c: contrast(raster.at(...e.line), raster.at(...e.tile)) })).filter(({ c }) => c < EDGE_BAR);
      assert.deepEqual(weak.slice(0, 6).map(({ e, c }) => `${e.what}: ${fmt(c)}:1 (${raster.at(...e.line).map(Math.round)} on ${raster.at(...e.tile).map(Math.round)})`), [],
        `${theme}, ${what}: every band reaches ${EDGE_BAR}:1 against what the cell shows (${weak.length} places under)`);
      assert.deepEqual(m.under, [], `${theme}, ${what}: and every other line on the map`);
    }
  }
});

/**
 * The page's renderSearchOverlay, run after a paint as the page runs it, onto a grid of how much scrim covers
 * each pixel: a fill adds its alpha over what is there, a clear takes it back to none. The search buffer is
 * laid over the map whole (presentTreemap), so this is what dims each pixel.
 */
function searchScrim(px: Painted[], W: number, H: number, query: string, theme: 'dark' | 'light') {
  const alpha = new Float64Array(W * H);
  const st: Record<string, any> = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1 };
  let k = 1;
  const cover = (x: number, y: number, w: number, h: number, a: number | null) => {
    [x, y, w, h] = [x * k, y * k, w * k, h * k];
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(H, Math.ceil(y + h)); py++) {
      for (let pxx = Math.max(0, Math.floor(x)); pxx < Math.min(W, Math.ceil(x + w)); pxx++) {
        const share = (Math.min(pxx + 1, x + w) - Math.max(pxx, x)) * (Math.min(py + 1, y + h) - Math.max(py, y));
        const i = py * W + pxx;
        alpha[i] = a === null ? alpha[i] * (1 - share) : alpha[i] + a * share * (1 - alpha[i]);
      }
    }
  };
  const ctx: any = new Proxy({
    setTransform: (a: number) => { k = a; },
    clearRect: (x: number, y: number, w: number, h: number) => cover(x, y, w, h, null),
    fillRect: (x: number, y: number, w: number, h: number) => cover(x, y, w, h, rgba(String(st.fillStyle))[3]),
  } as Record<string, unknown>, {
    get(t, key: string) { return key in t ? t[key] : key in st ? st[key] : () => {}; },
    set(_t, key: string, v) { st[key] = v; return true; },
  });
  const state = { treemap: { pxRects: px, query, queryMode: 'word', matchedPaths: null, matches: 0 } };
  load<() => void>(['renderSearchOverlay'], {
    tmSearchBuffer: { width: W, height: H }, tmBuffer: { width: W, height: H }, window: { devicePixelRatio: 1 }, tmSearchCtx: ctx,
    state, document: { documentElement: { dataset: { theme } } }, cssVar: () => '#0A84FF', updateTmStatus() {}, isCells: () => false,
  }, 'renderSearchOverlay', (render) => render());
  return { at: (x: number, y: number) => alpha[Math.round(y) * W + Math.round(x)], max: () => alpha.reduce((m, v) => Math.max(m, v), 0), matches: state.treemap.matches };
}

test('J51 under a search: a folder\'s own fill is dimmed with everything else that does not match — never left a bright slab beside the matches — and is dimmed once, not twice over what is drawn in it (review F1.1)', () => {
  const tiles = subFloorTiles(); // corpus/Mail and its mailboxes, "Wide folder", a folder half covered by big.mov
  const W = 400, H = 400;
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    const { px } = rasterPaint(tiles, palette, W, H);
    const scrimAlpha = theme === 'dark' ? 0.78 : 0.82; // the page's scrim, rgba(…, 0.78) dark and (…, 0.82) light
    const where = (path: string, fx: number, fy: number) => { const r = whole(px.find((p) => p.n.path === path)!); return [Math.floor(r.x + r.w * fx), Math.floor(r.y + r.h * fy)] as [number, number]; };
    const filled = [['/c/Mail/INBOX', 0.5, 0.5], ['/c/Mail/Sent', 0.5, 0.5], ['/c/Mail', 0.85, 0.5], ['/c/Wide folder', 0.5, 0.5], ['/c/Half', 0.75, 0.5], ['/c', 0.9, 0.9]] as const;
    // A query nothing matches: every folder's own fill is dimmed, as every file is.
    const none = searchScrim(px, W, H, 'zzz-nothing', theme);
    assert.equal(none.matches, 0, `${theme}: control — nothing matches`);
    for (const [path, fx, fy] of filled) {
      assert.ok(Math.abs(none.at(...where(path, fx, fy)) - scrimAlpha) < 1e-6, `${theme}, "zzz-nothing": ${path}'s own fill is dimmed (scrim ${none.at(...where(path, fx, fy)).toFixed(2)}, want ${scrimAlpha})`);
    }
    assert.ok(Math.abs(none.at(...where('/c/Half/big.mov', 0.5, 0.5)) - scrimAlpha) < 1e-6, `${theme}: control — a file that does not match is dimmed`);
    assert.ok(none.max() < scrimAlpha + 1e-6, `${theme}: no pixel is dimmed twice over (deepest scrim ${none.max().toFixed(3)})`);
    // A query that matches the file: it stays bright; the folders' fills around it are dimmed.
    const big = searchScrim(px, W, H, 'big', theme);
    assert.equal(big.at(...where('/c/Half/big.mov', 0.5, 0.5)), 0, `${theme}, "big": the match is not dimmed`);
    assert.ok(Math.abs(big.at(...where('/c/Half', 0.75, 0.5)) - scrimAlpha) < 1e-6, `${theme}, "big": its folder's own fill beside it is dimmed`);
    // A query that matches a folder with nothing drawn in it: its fill is the match, bright; its parent's is dimmed.
    const inbox = searchScrim(px, W, H, 'inbox', theme);
    assert.equal(inbox.at(...where('/c/Mail/INBOX', 0.5, 0.5)), 0, `${theme}, "inbox": the matching folder's own fill is not dimmed`);
    assert.ok(Math.abs(inbox.at(...where('/c/Mail', 0.85, 0.5)) - scrimAlpha) < 1e-6, `${theme}, "inbox": the folder around it is dimmed where its own fill shows`);
    assert.ok(inbox.max() < scrimAlpha + 1e-6, `${theme}, "inbox": no pixel is dimmed twice over`);
  }
});

/* ── A folder an online-only file is hidden in, inside a folder with its own fill (review F2.1) ── */

/**
 * /f, a top-level folder whose right half holds only files under the floor, so it is filled (J51); in its
 * left half /f/Synced, holding a file that is drawn and an online-only file — hidden while hideCloud is on,
 * so nothing is drawn over the right half of /f/Synced. On a 200×200 map: /f 0–200, /f/Synced 0–100,
 * here.bin 0–50, and where away.mov would be, 50–100.
 */
function cloudInFilledFolder(): Tile[] {
  return [
    { name: 'F', path: '/f', size: 3e10, type: 'dir', depth: 1, expanded: true, x: 0, y: 0, w: 100, h: 100 },
    { name: 'Synced', path: '/f/Synced', size: 2e10, type: 'dir', depth: 2, expanded: true, x: 0, y: 0, w: 50, h: 100 },
    { name: 'here.bin', path: '/f/Synced/here.bin', size: 5e9, type: 'file', depth: 3, expanded: false, x: 0, y: 0, w: 25, h: 100 },
    { name: 'away.mov', path: '/f/Synced/away.mov', size: 5e9, type: 'file', depth: 3, expanded: false, x: 25, y: 0, w: 25, h: 100, cloudPlaceholder: true } as Tile,
  ];
}
const inHiddenCloud = (x: number, y: number) => x >= 50 && x < 100 && y >= 0 && y < 200;

test('J51 with online-only files hidden: a folder an online-only file is hidden in shows the map\'s ground where that file would be, even inside a folder with its own fill — never the fill of the folder above — and every band beside it reaches 3:1 against that ground, in both themes (review F2.1)', () => {
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    const ground = canvasGround(palette);
    const { raster, px } = rasterPaint(cloudInFilledFolder(), palette, 200, 200, undefined, undefined, true);
    const f = px.find((r) => r.n.path === '/f')!, synced = px.find((r) => r.n.path === '/f/Synced')!;
    assert.deepEqual(px.map((r) => r.n.path), ['/f', '/f/Synced', '/f/Synced/here.bin'], `${theme}: control — the online-only file is hidden`);
    assert.ok(f.bg, `${theme}: control — /f, half of it in files under the floor, is filled`);
    // Between two of its texture's seams (one every 4 px from its corner): its fill.
    const fShown = raster.at(150, 102), fWant = lerp(f.bg![0], f.bg![1], 102.5 / 200);
    assert.ok(contrast(fShown, fWant) < 1.05, `${theme}: control — /f's own cushion shows in its right half (${fShown.map(Math.round)}, want ${fWant.map(Math.round)})`);
    assert.equal(synced.bg, undefined, `${theme}: /f/Synced is not filled where its online-only file is hidden`);
    // Where the hidden file would be, clear of every band: the map's ground — not /f's fill, which would claim
    // the hidden file's bytes in /f's colour.
    for (const [x, y] of [[75, 100], [75, 20], [60, 180], [94, 100]] as const) {
      const shown = raster.at(x, y);
      assert.ok(contrast(shown, ground) < 1.01, `${theme}: the map's ground shows at ${x},${y}, where /f/Synced's online-only file is hidden (${shown.map(Math.round)}; the ground ${ground.map(Math.round)}, /f's fill there ${lerp(f.bg![0], f.bg![1], (y + 0.5) / 200).map(Math.round)})`);
    }
    // Every band beside that ground — /f/Synced's own, and /f's over it along their shared top and bottom.
    const m = measureEdges(raster, px);
    const beside = m.edges.filter((e) => e.kind === 'frame' && inHiddenCloud(...e.tile));
    assert.ok(beside.length > 100, `${theme}: control — ${beside.length} places where a band meets that ground were measured`);
    const weak = beside.map((e) => ({ e, c: contrast(raster.at(...e.line), raster.at(...e.tile)) })).filter(({ c }) => c < EDGE_BAR);
    assert.deepEqual(weak.slice(0, 6).map(({ e, c }) => `${e.what}: ${fmt(c)}:1 (${raster.at(...e.line).map(Math.round)} on ${raster.at(...e.tile).map(Math.round)})`), [],
      `${theme}: every band reaches ${EDGE_BAR}:1 against what shows beside it (${weak.length} places under)`);
    assert.deepEqual(m.under, [], `${theme}: and every other line on the map`);
  }
});

test('J51 with online-only files hidden: the SVG export lays the map\'s ground over a folder an online-only file is hidden in, inside a folder with its own fill — after that fill, before what is drawn in the folder — as the canvas does (review F2.1)', () => {
  const { svg, px } = exportSvg(cloudInFilledFolder(), (n) => ramp.sizeRgb(n.size), '#0e0e13', undefined, undefined, true);
  const painted = px as Painted[];
  const r = (path: string) => painted.find((p) => p.n.path === path)!;
  const f = r('/f'), synced = r('/f/Synced'), here = r('/f/Synced/here.bin');
  assert.ok(f.bg && !synced.bg && painted.length === 3, 'control: /f is filled, /f/Synced is not, and the online-only file is hidden');
  const rects = [...svg.matchAll(/<rect ([^>]*?)\/?>/g)].map((m) => ({ a: attrs(m[1]), at: m.index! }));
  const close = (a: Record<string, string>, box: number[]) => ['x', 'y', 'width', 'height'].every((k, i) => Math.abs(Number(a[k]) - box[i]) < 0.011);
  const fFill = rects.find(({ a }) => /^url\(#tm-f/.test(a.fill ?? '') && close(a, [f.x, f.y, f.w, f.h]));
  assert.ok(fFill, 'control: /f\'s own fill is in the SVG');
  const hereFill = rects.find(({ a }) => /^url\(#tm-c/.test(a.fill ?? '') && close(a, [here.x, here.y, here.w, here.h]));
  assert.ok(hereFill, 'control: here.bin is in the SVG');
  const ground = rects.find(({ a }) => a.fill === '#0e0e13' && a.stroke === undefined && close(a, [synced.x, synced.y, synced.w, synced.h]));
  assert.ok(ground, '/f/Synced\'s box is laid with the map\'s ground, where its online-only file is hidden');
  assert.ok(fFill!.at < ground!.at && ground!.at < hereFill!.at, `the ground is laid after /f's fill and before here.bin (${fFill!.at} < ${ground!.at} < ${hereFill!.at})`);
});

test('J51 with online-only files hidden, under a search: the ground a folder shows where its online-only file is hidden is dimmed with everything else that does not match — not left at the strength of the fill above it — and dimmed once; a folder that matches keeps it undimmed (review F2.1)', () => {
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    const { px } = rasterPaint(cloudInFilledFolder(), palette, 200, 200, undefined, undefined, true);
    const scrimAlpha = theme === 'dark' ? 0.78 : 0.82;
    const none = searchScrim(px, 200, 200, 'zzz-nothing', theme);
    assert.ok(Math.abs(none.at(150, 100) - scrimAlpha) < 1e-6, `${theme}: control — /f's own fill is dimmed`);
    for (const [x, y] of [[75, 100], [60, 180]] as const) {
      assert.ok(Math.abs(none.at(x, y) - scrimAlpha) < 1e-6, `${theme}, "zzz-nothing": where /f/Synced's online-only file is hidden is dimmed (scrim ${none.at(x, y).toFixed(2)} at ${x},${y}, want ${scrimAlpha})`);
    }
    assert.ok(none.max() < scrimAlpha + 1e-6, `${theme}, "zzz-nothing": no pixel is dimmed twice over (deepest scrim ${none.max().toFixed(3)})`);
    const here = searchScrim(px, 200, 200, 'here', theme);
    assert.equal(here.at(25, 100), 0, `${theme}, "here": the match is not dimmed`);
    assert.ok(Math.abs(here.at(75, 100) - scrimAlpha) < 1e-6, `${theme}, "here": the ground beside it, where the online-only file is hidden, is dimmed`);
    const synced = searchScrim(px, 200, 200, 'synced', theme);
    assert.equal(synced.at(75, 100), 0, `${theme}, "synced": the folder that matches keeps the ground in it undimmed`);
    assert.ok(Math.abs(synced.at(150, 100) - scrimAlpha) < 1e-6, `${theme}, "synced": the folder around it is dimmed where its own fill shows`);
    assert.ok(synced.max() < scrimAlpha + 1e-6, `${theme}, "synced": no pixel is dimmed twice over`);
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

test('map density: a realistic dense map is colour with contrasting lines, not a black mesh — near-black under 2% in dark and light, every line at 3:1 on its pixels, and none under a name tag', () => {
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
    // The top-level folders' name tags are on the raster, each over its folder's top-left corner, as pass 3 lays
    // them (review F2.2): the places under a tag are left out of the measure (measureEdges says why), and few.
    const tags = px.filter((r) => r.frame && r.n.depth === 1 && r.w >= 90 && r.h >= 44).length;
    assert.ok(tags >= 5, `${theme}: control — ${tags} top-level folders carry a name tag`);
    assert.ok(m.tagged > 0, `${theme}: control — ${m.tagged} places where a line meets a tile lie under a name tag`);
    assert.ok(raster.taggedShare() < 0.02 && m.tagged < m.edges.length * 0.02, `${theme}: the name tags cover ${(raster.taggedShare() * 100).toFixed(2)}% of the map and ${m.tagged} places, under 2% of the ${m.edges.length} measured`);
    assert.deepEqual(m.under, [], `${theme}: lines under ${EDGE_BAR}:1 against the tile beside them`);
    // And under a tag no line is drawn at all (review F3.1): each pixel it covers whole is the tiles, darkened by the tag alone.
    const t = underTags(raster, rasterPaint(nodes, palette, REAL_W, REAL_H, undefined, undefined, false, 1, lineCalls(px)).raster, px);
    // Its tags lie over leaf outlines only: no folder's band runs under one here (the next test lays one there).
    assert.ok(t.whole > 1000 && t.lines.leaf > 100, `${theme}: control — the tags cover ${t.whole} pixels whole, where leaf outlines would run in ${t.lines.leaf} places (bands in ${t.lines.frame}, over ${t.bandPx} band pixels)`);
    assert.deepEqual(t.shown, [], `${theme}: under a name tag, pixels that are not the tiles under the tag alone — a leaf's outline or a folder's band shows there, or the tag is not laid`);
  }
  // QA read 8.5% (corpus) and 8.9% (/System/Library) near-black in the real dark map, and 2.3–5.5% in light,
  // painted BQG-5's way; this layout, painted that way (REL-79) on this raster, name tags and all, measures
  // 13.3% dark and 1.7% light — the empty folders' slabs and the 0.35 outlines over a gap of the ground — and
  // 0.1% in both with BQJ-2's outlines (0.3% while the lines still ran under the name tags' half-black pills,
  // darkened by half with the tiles beside them; review F3.1), and 0.2% with the owner's refinement. The lines are
  // dark shades of each tile's own colour, not black: at luminance < 0.08 the share is 20.1% now (26.1% with BQJ-2's
  // own outlines and 3/2 px bands; 18.5% dark and 3.2% light painted BQG-5's way) — the outlines the owner asked to see.
  const over = Object.entries(share).filter(([, v]) => v >= 0.02).map(([theme, v]) => `${theme} ${(v * 100).toFixed(1)}%`);
  assert.deepEqual(over, [], `near-black (luminance < ${NEAR_BLACK}) at or over 2%: ${over.join(', ')} (dark ${(share.dark * 100).toFixed(1)}%, light ${(share.light * 100).toFixed(1)}%)`);
});

/**
 * A top-level folder, Applications, big enough for a name tag, holding in its top-left corner a folder N narrower than the
 * tag with nothing drawn in it (J51), above a file L across its foot, beside a file big.bin (review F1.3): N's right band
 * runs under the tag, and no leaf's outline does — beside N, under the tag, is Applications' own fill.
 */
function bandUnderTag(): Tile[] {
  return [
    { name: 'Applications', path: '/t/Applications', size: 6e10, type: 'dir', depth: 1, expanded: true, x: 0, y: 0, w: 400 / 6, h: 100 },
    { name: 'big.bin', path: '/t/big.bin', size: 3e10, type: 'file', depth: 1, expanded: false, x: 400 / 6, y: 0, w: 100 - 400 / 6, h: 100 },
    { name: 'N', path: '/t/Applications/N', size: 4e9, type: 'dir', depth: 2, expanded: true, x: 0, y: 0, w: 10, h: 50 },
    { name: 'L', path: '/t/Applications/L', size: 3e10, type: 'file', depth: 2, expanded: false, x: 0, y: 50, w: 400 / 6, h: 50 },
  ];
}

test('owner\'s outlines: under a name tag no folder\'s band is drawn either — a folder narrower than its top-level folder\'s tag runs its band under the tag, and every pixel the tag covers whole is the tiles under the tag alone, at device pixel ratios 1, 1.5 and 2, in both themes (review F1.3)', () => {
  const W = 600, H = 300;
  for (const dpr of [1, 1.5, 2]) {
    for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
      const where = `${theme}, dpr ${dpr}`;
      const { raster, px } = rasterPaint(bandUnderTag(), palette, W, H, undefined, undefined, false, dpr);
      const t = underTags(raster, rasterPaint(bandUnderTag(), palette, W, H, undefined, undefined, false, dpr, lineCalls(px)).raster, px, dpr);
      assert.ok(t.whole > 0 && t.bandPx > 0 && t.lines.frame > 0 && t.lines.leaf === 0,
        `${where}: control — Applications' tag covers ${t.whole} device pixels whole, ${t.bandPx} of them under a band the painter laid; bands would meet a tile there in ${t.lines.frame} places, leaf outlines in ${t.lines.leaf}`);
      assert.deepEqual(t.shown, [], `${where}: under the name tag, device pixels that are not the tiles under the tag alone — N's band shows there`);
    }
  }
});

/* ══════════════ The owner's refinement (20 Oct 2026): "Refine it" ══════════════
 *
 * After before/after screenshots of the contrasting outlines (REPORT, bqa8shots), the owner chose to refine them: keep
 * every line at 3:1, taper them so there is no hard step at 8 px, thinner frames on small and nested folders so dense
 * corners and small folders stay bright, a faint texture where tiles are too small for an outline, and each line at 3:1
 * against the tile on EACH of its sides. Measured on the shots: the densest 280 px of /System/Library was 42.8% folder
 * band with 43.4% of its pixels under luminance 0.08; corpus/Mail, 58×52 px in the corpus map, was 90.5% band; 8 px
 * clips had a heavy 2 px grid where 7 px clips were one flat block; a folder of 20,000 tiny files was one flat slab; and
 * 104 of corpus/Mail's 1,889 outline edges fell to 2.33:1 against the tile on their far side.
 */

/** A uniform grid of `n`×`n` leaves `s` px square, each `bytes` big, filling a map of its own at the top level. */
function uniformGrid(s: number, n: number, bytes: number) {
  const W = s * n, H = s * n, tiles: Tile[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) tiles.push({ name: `g${i}.${j}`, path: `/g/g${i}.${j}`, size: bytes, type: 'file', depth: 1, expanded: false, x: (j * s / W) * 100, y: (i * s / H) * 100, w: (s / W) * 100, h: (s / H) * 100 });
  }
  return { tiles, W, H };
}

/**
 * How the raster shows the leaves in a box — all of `px` whose path `inBox` takes — against each one's own cushion (the
 * solid fill, from the stops the painter recorded): the share of their pixels that stand apart from it toward the shade
 * a line or a texture takes on that tile (darker on a light tile, lighter on a dark one) by more than 1.05:1 — `apart`,
 * the line pixels and texture together, not the highlight — the strongest contrast, the share under luminance 0.03, the
 * mean relative luminance against the solid fill's (`mean`, 1 when equal), the mean CIE L* less the solid fill's (`dL`),
 * and the solid fill's own mean L* (`L`). And `ink`: the share of their area a line or a texture covers as the raster shows
 * it — each pixel counted by how far it lies from the fill toward the shade the tile's lines (r.lines) or texture (r.tex)
 * were laid in on its row, 0 to 1 — so a device pixel a 1 px line covers by half, at 150 %, counts a half: the same share at
 * every device pixel ratio, where `apart` counts that pixel whole.
 */
function tileLook(raster: ReturnType<typeof rasterCtx>, px: Painted[], inBox: (r: Painted) => boolean, dpr = 1) {
  let total = 0, apart = 0, black = 0, sum = 0, solid = 0, dL = 0, L = 0, strongest = 1, ink = 0;
  for (const r of px) {
    if (r.frame || !r.stops || !inBox(r)) continue;
    const darker = luminance(r.fillRgb!) >= 0.18;
    const lineShades = [...new Set((r.lines || []).map((l) => l.rgb))].map((c) => rgba(c).slice(0, 3) as RGB);
    const x0 = Math.round(r.x * dpr), y0 = Math.round(r.y * dpr), x1 = Math.round((r.x + r.w) * dpr), y1 = Math.round((r.y + r.h) * dpr);
    for (let y = y0; y < y1; y++) {
      const t = Math.max(0, Math.min(1, ((y + 0.5) / dpr - r.y) / r.h));
      const fill = lerp(r.stops[0], r.stops[1], t);
      const shades = r.tex ? [...lineShades, lerp(r.tex.stops[0] as RGB, r.tex.stops[1] as RGB, t)] : lineShades;
      for (let x = x0; x < x1; x++) {
        const p = raster.at(x, y), c = contrast(p, fill);
        total++;
        if (c > 1.05 && (luminance(p) < luminance(fill)) === darker) apart++;
        strongest = Math.max(strongest, c);
        if (luminance(p) < 0.03) black++;
        sum += luminance(p); solid += luminance(fill); dL += lab(p).L - lab(fill).L; L += lab(fill).L;
        // How far p lies from the fill toward a shade, along the line between them: the share of the pixel that shade covers.
        let k = 0;
        for (const sh of shades) {
          const d = sh.map((v, i) => v - fill[i]), n = d.reduce((a, v) => a + v * v, 0);
          if (n > 0) k = Math.max(k, Math.min(1, d.reduce((a, v, i) => a + v * (p[i] - fill[i]), 0) / n));
        }
        ink += k;
      }
    }
  }
  return { total, apart: apart / total, strongest, black: black / total, mean: sum / solid, dL: dL / total, L: L / total, ink: ink / total };
}

/** Three colours of the size ramp — a 2 MB file's green, a 400 MB file's amber, a 6 GB file's red — and two of the other colourings. */
const TAPER_COLOURS: Array<{ name: string; rgb: RGB }> = [
  { name: 'size ramp 2 MB', rgb: ramp.sizeRgb(2e6) },
  { name: 'size ramp 400 MB', rgb: ramp.sizeRgb(4e8) },
  { name: 'size ramp 6 GB', rgb: ramp.sizeRgb(6e9) },
  ...OTHER_COLOURS.filter((c) => c.name === 'Reclaim not scored' || c.name === 'Age band C_ORANGE'),
];

test('owner\'s refinement: no hard step at 8 px — on uniform grids of tiles 5 to 18 px, the share of pixels a line or a texture takes, and the mean lightness, change smoothly from one size to the next, in both themes, on the size ramp, Reclaim\'s "not scored" grey and an Age band, at device pixel ratios 1, 1.25, 1.5, 1.75 and 2 (review F3.2)', () => {
  // 7 px tiles were one flat block and 8 px tiles a heavy 2 px grid (each leaf drew its own outline, so neighbours met at
  // 2 px): 0% to 43.8% of the pixels, and 15 L* darker, in one step. Now two leaves with lines meet at one 1 px line, and
  // a smaller leaf draws a 1 px texture where they would meet: a 1 px seam per tile at every size, whose share falls as
  // 1 − ((s − 1)/s)² — each step smaller than the one before (5.4 points from 5 to 6 px, 3.1 from 7 to 8). That is the
  // bound: no step bigger than the one before it, by more than half a point. The seam is the owner's faint texture
  // (1.4:1 at 7 px) below 8 px and his 3:1 line from 8 px, so the mean lightness steps most at 7→8 px: no more than
  // 7 L* there — half the old step — and under 2 L* at every other size.
  // At 2× a 1 px seam is two device pixels of a tile's 2s: the same share. At 125, 150 and 175 % it covers a device pixel
  // and part of the next, which `apart` counts whole: there the share is held as the seams' `ink` (tileLook), each pixel
  // counted by how much of it a seam covers — the formula's share at every ratio, within a point and a half. A painter that
  // laid each 8 px tile its own right and bottom line at those ratios put a 2 px grid back: 43.7% of the 8 px tiles' area
  // at 150 %, against 26.4% for 7 px (review F3.2).
  const grey = TAPER_COLOURS.find((c) => c.name === 'Reclaim not scored')!;
  const runs = [...TAPER_COLOURS.map((c) => ({ c, dpr: 1 })), { c: TAPER_COLOURS[1], dpr: 2 },
    ...[1.25, 1.5, 1.75].map((dpr) => ({ c: TAPER_COLOURS[1], dpr })), { c: grey, dpr: 1.5 }];
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    for (const { c, dpr } of runs) {
      const looks: Array<ReturnType<typeof tileLook> & { s: number }> = [];
      for (let s = 5; s <= 18; s++) {
        const n = 9, g = uniformGrid(s, n, 4e8);
        const { raster, px } = rasterPaint(g.tiles, palette, g.W, g.H, () => c.rgb, undefined, false, dpr);
        // The middle tiles: the outer ring meets the map's edge.
        const inner = (r: Painted) => { const [i, j] = /g(\d+)\.(\d+)$/.exec(r.n.path)!.slice(1).map(Number); return i > 0 && j > 0 && i < n - 1 && j < n - 1; };
        looks.push({ s, ...tileLook(raster, px, inner, dpr) });
      }
      const where = `${theme}, ${c.name}, dpr ${dpr}`;
      const table = looks.map((l) => `${l.s}px ${(l.apart * 100).toFixed(1)}% (ink ${(l.ink * 100).toFixed(1)}%) ${l.dL.toFixed(1)}L*`).join(', ');
      for (const l of looks) {
        const want = 1 - ((l.s - 1) / l.s) ** 2;
        if (Number.isInteger(dpr)) assert.ok(Math.abs(l.apart - want) < 0.02, `${where}: ${l.s} px tiles — one 1 px seam each, ${(l.apart * 100).toFixed(1)}% of their pixels (${table})`);
        assert.ok(Math.abs(l.ink - want) < 0.015, `${where}: ${l.s} px tiles — one 1 px seam each, covering ${(l.ink * 100).toFixed(1)}% of their area, where one covers ${(want * 100).toFixed(1)}% (${table})`);
      }
      for (let k = 1; k < looks.length; k++) {
        const step = Math.abs(looks[k].ink - looks[k - 1].ink), before = k > 1 ? Math.abs(looks[k - 1].ink - looks[k - 2].ink) : Infinity;
        assert.ok(step <= before + 0.005, `${where}: from ${looks[k - 1].s} to ${looks[k].s} px the seams' share steps ${(step * 100).toFixed(1)} points, more than the step before it (${(before * 100).toFixed(1)}) — ${table}`);
        const dL = Math.abs(looks[k].dL - looks[k - 1].dL), bound = looks[k].s === OUTLINED_PX ? 7 : 2;
        assert.ok(dL <= bound, `${where}: from ${looks[k - 1].s} to ${looks[k].s} px the mean lightness steps ${dL.toFixed(1)} L*, over ${bound} — ${table}`);
      }
    }
  }
});

/**
 * A `cols`×`rows` grid of leaves `s` css px square on a map of its own, its corner at (`ox`, `oy`) css px: at 125, 150 and
 * 175 % each tile's edges lie on whole device pixels, and its width and height — differences of two snapped edges —
 * carry float noise ((29 / 1.5) − (17 / 1.5) is 7.999999999999998).
 */
function offsetGrid(s: number, cols: number, rows: number, ox: number, oy: number) {
  const W = Math.ceil(ox + s * cols + 1), H = Math.ceil(oy + s * rows + 1), tiles: Tile[] = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      tiles.push({ name: `g${i}.${j}`, path: `/g/g${i}.${j}`, size: 4e8, type: 'file', depth: 1, expanded: false,
        x: ((ox + j * s) / W) * 100, y: ((oy + i * s) / H) * 100, w: (s / W) * 100, h: (s / H) * 100 });
    }
  }
  return { tiles, W, H };
}

/**
 * Folders exactly at the band steps, off whole css px: rows of top-level folders 8, 32 and 96 css px across their
 * thinner side, and in a top-level folder of their own, rows of nested folders 8 and 48 css px across.
 */
function offsetFolders() {
  const W = 302, H = 276, pct = (v: number, of: number) => (v / of) * 100, tiles: Tile[] = [];
  const dir = (path: string, depth: number, x: number, y: number, w: number, h: number): Tile =>
    ({ name: path.slice(path.lastIndexOf('/') + 1), path, size: 1e9, type: 'dir', depth, expanded: true, x: pct(x, W), y: pct(y, H), w: pct(w, W), h: pct(h, H) });
  for (let j = 0; j < 20; j++) tiles.push(dir(`/b/s8-${j}`, 1, 0.7 + 8 * j, 0.3, 8, 24));
  for (let j = 0; j < 8; j++) tiles.push(dir(`/b/s32-${j}`, 1, 0.7 + 32 * j, 24.3, 32, 40));
  for (let j = 0; j < 3; j++) tiles.push(dir(`/b/s96-${j}`, 1, 0.7 + 96 * j, 64.3, 96, 110));
  tiles.push(dir('/b/T', 1, 0.7, 174.3, 300, 100));
  for (let j = 0; j < 6; j++) tiles.push(dir(`/b/T/n48-${j}`, 2, 3.7 + 48 * j, 177.3, 48, 60));
  for (let j = 0; j < 30; j++) tiles.push(dir(`/b/T/n8-${j}`, 2, 3.7 + 8 * j, 240.3, 8, 20));
  return { tiles, W, H };
}

test('owner\'s refinement at 125, 150 and 175 %: the 8 px step, the 2 px texture step and the band steps are taken by size on the device\'s pixels — every one of a grid of identical 8 px tiles lined, and at 150 % every one of a grid of identical 2 px tiles textured, each painted pixel for pixel as its neighbour, never some classed a step down by the float noise in a snapped width; and every folder exactly 8, 32, 48 or 96 px across banded as that size asks, in both themes (review F1.1, F2.6)', () => {
  // A tile 12 device px wide at 150 % is 8 css px; its width as two snapped edges' difference was 7.999999999999998, and
  // `>= 8` classed it textured: a 1.375:1 seam beside identical tiles parted by 3.3:1 lines — a speckle at exactly the
  // step the owner asked to taper. The same noise took a band a step thinner.
  // At 150 % the same noise put a 2 px tile (3 device px) a hair under the 2 px texture step: 1.9999999999999996, a plain
  // tile among textured ones (review F2.6).
  const kindOf = (r: Painted) => (r.lines ? 'lined' : r.tex ? 'textured' : 'solid');
  const onDevice = (r: Painted, dpr: number) => ({ ...r, w: Math.round(r.w * dpr) / dpr, h: Math.round(r.h * dpr) / dpr });
  // A grid of identical `s` px tiles at `dpr`: each classed `kind`, and each clear of the map's edge painted pixel for pixel
  // as the first such tile.
  const identical = (where: string, palette: Record<string, string>, dpr: number, s: number, cols: number, rows: number, kind: string) => {
    const d = s * dpr;
    const g = offsetGrid(s, cols, rows, 0.7, 0.3);
    const { raster, px } = rasterPaint(g.tiles, palette, g.W, g.H, () => TAPER_COLOURS[1].rgb, undefined, false, dpr);
    assert.ok(px.length === cols * rows && px.every((r) => Math.round(r.w * dpr) === d && Math.round(r.h * dpr) === d),
      `${where}: control — ${px.length} tiles, each ${d} device px square`);
    const under = px.filter((r) => Math.min(r.w, r.h) < s).length;
    assert.ok(under > 0, `${where}: control — ${under} of the snapped sizes fall a hair under ${s} css px`);
    const kinds: Record<string, number> = {};
    for (const r of px) kinds[kindOf(r)] = (kinds[kindOf(r)] || 0) + 1;
    assert.deepEqual(kinds, { [kind]: cols * rows }, `${where}: identical ${s} px tiles, each ${kind}`);
    const box = (r: Painted) => [Math.round(r.x * dpr), Math.round(r.y * dpr)];
    const ref = px.find((r) => r.n.path === '/g/g1.1')!, [rx, ry] = box(ref);
    let worst = 0, at = '';
    for (const r of px) {
      const [i, j] = /g(\d+)\.(\d+)$/.exec(r.n.path)!.slice(1).map(Number);
      if (i === 0 || j === 0 || i === rows - 1 || j === cols - 1) continue;
      const [x0, y0] = box(r);
      for (let v = 0; v < d; v++) {
        for (let u = 0; u < d; u++) {
          const p = raster.at(x0 + u, y0 + v), q = raster.at(rx + u, ry + v);
          const diff = Math.max(...p.map((c, k) => Math.abs(c - q[k])));
          if (diff > worst) { worst = diff; at = `${r.n.path} at +${u},+${v}: ${p.map(Math.round)} where ${ref.n.path} shows ${q.map(Math.round)}`; }
        }
      }
    }
    assert.ok(worst <= 1, `${where}: identical ${s} px tiles painted alike — ${at}`);
  };
  for (const dpr of [1.25, 1.5, 1.75]) {
    for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
      const where = `${theme}, dpr ${dpr}`;
      identical(where, palette, dpr, 8, 40, 12, 'lined');
      // 2 css px is a whole number of device pixels only at 150 %.
      if (dpr === 1.5) identical(where, palette, dpr, 2, 300, 6, 'textured');
      // The band steps.
      const f = offsetFolders();
      const fp = rasterPaint(f.tiles, palette, f.W, f.H, undefined, undefined, false, dpr).px.filter((r) => r.frame);
      assert.equal(fp.length, f.tiles.length, `${where}: control — every folder drawn`);
      const hair = fp.filter((r) => Math.min(r.w, r.h) < Math.min(onDevice(r, dpr).w, onDevice(r, dpr).h)).length;
      assert.ok(hair > 0, `${where}: control — ${hair} folders' snapped sizes fall a hair under their size on the device`);
      const wrong = fp.filter((r) => r.lw !== bandOf(onDevice(r, dpr)))
        .map((r) => `${r.n.path} (${Math.min(r.w, r.h)} css px): a ${r.lw} px band where its size asks ${bandOf(onDevice(r, dpr))}`);
      assert.deepEqual(wrong.slice(0, 6), [], `${where}: ${wrong.length} folders banded off their size`);
    }
  }
});

/**
 * A folder that holds nothing over the floor — Wide folder's 20,000 files of 400 B — `w`×`h` px, nested in a top-level
 * folder, in its lower right corner, clear of the top-level folder's name tag.
 */
function subFloorFolder(w: number, h: number): { tiles: Tile[]; W: number; H: number } {
  const W = w + 120, H = h + 70;
  return {
    W, H, tiles: [
      { name: 'corpus', path: '/c', size: 4e10, type: 'dir', depth: 1, expanded: true, x: 0, y: 0, w: 100, h: 100 },
      { name: 'Wide folder', path: '/c/Wide folder', size: 8e6, type: 'dir', depth: 2, expanded: true, x: ((W - w - 20) / W) * 100, y: ((H - h - 20) / H) * 100, w: (w / W) * 100, h: (h / H) * 100 },
    ],
  };
}

/**
 * How the raster shows the folder `f`'s own fill (J51) and its texture, on the device's pixels clear of its band (bandOf):
 * the share of them that stand apart from the fill by more than 1.05:1 (`apart`), the seams' `ink` — each pixel counted by
 * how far it lies from the fill toward the seam's shade on its row, so a pixel a seam covers by half counts a half (as
 * tileLook) — the weakest pixel a seam the painter recorded laying (r.tex) covers whole (`weakest`, over `whole` of them),
 * the strongest pixel, the share under luminance 0.03, and the mean CIE L* less the fill's (`dL`) with the fill's own (`L`).
 */
function folderLook(raster: ReturnType<typeof rasterCtx>, f: Painted, dpr: number) {
  const lw = bandOf(f);
  const x0 = Math.ceil((f.x + lw) * dpr - 1e-6), y0 = Math.ceil((f.y + lw) * dpr - 1e-6);
  const x1 = Math.floor((f.x + f.w - lw) * dpr + 1e-6), y1 = Math.floor((f.y + f.h - lw) * dpr + 1e-6);
  const whole = new Uint8Array(raster.W * raster.H);
  for (const [x, y, w, h] of f.tex!.rects) {
    for (let yy = Math.ceil(y * dpr - 1e-6); yy < Math.floor((y + h) * dpr + 1e-6); yy++) {
      for (let xx = Math.ceil(x * dpr - 1e-6); xx < Math.floor((x + w) * dpr + 1e-6); xx++) whole[yy * raster.W + xx] = 1;
    }
  }
  let total = 0, apart = 0, ink = 0, black = 0, dL = 0, L = 0, strongest = 1, weakest = Infinity, wholes = 0;
  for (let y = y0; y < y1; y++) {
    const t = Math.max(0, Math.min(1, ((y + 0.5) / dpr - f.y) / f.h));
    const fill = lerp(f.bg![0], f.bg![1], t), seam = lerp(f.tex!.stops[0] as RGB, f.tex!.stops[1] as RGB, t);
    const d = seam.map((v, i) => v - fill[i]), n = d.reduce((a, v) => a + v * v, 0);
    for (let x = x0; x < x1; x++) {
      const p = raster.at(x, y), k = contrast(p, fill);
      total++;
      if (luminance(p) < 0.03) black++;
      if (k > 1.05) apart++;
      ink += Math.max(0, Math.min(1, d.reduce((a, v, i) => a + v * (p[i] - fill[i]), 0) / n));
      if (whole[y * raster.W + x]) { wholes++; weakest = Math.min(weakest, k); }
      strongest = Math.max(strongest, k); dL += lab(p).L - lab(fill).L; L += lab(fill).L;
    }
  }
  return { total, apart: apart / total, ink: ink / total, weakest, whole: wholes, strongest, black: black / total, dL: dL / total, L: L / total };
}

test('owner\'s refinement: where tiles are too small for lines, a faint texture — a folder of tiny files reads as many files, never one flat slab and never a mesh: texture over a fifth of its pixels, no pixel past 1.6:1 from its own fill, none near-black, and its mean lightness (L*) within a tenth of the solid fill\'s — for leaves 2 to 7 px and for a folder\'s own fill (J51), whose seams stand 1.2:1 or more from it and cover as much of it at every ratio as at 100 %, on the size ramp, Reclaim\'s "not scored" grey and an Age band, in both themes, at device pixel ratios 1, 1.25, 1.5, 1.75 and 2 (review F1.7, F3.3, F3.4)', () => {
  // Lightness is CIE L*, as a person sees it, for every colour. Relative luminance is no measure of how bright a dark tile
  // looks: the lighter texture on Reclaim's "not scored" grey (L* 27) raises its luminance by a fifth (117-121%) — about
  // 0.01 — and its L* by 2.5, under a tenth; the size ramp's darker texture lowers its L* by under 3 of 60-76.
  // At 125, 150 and 175 % a texture's 1 px row covers a device pixel and part of the next; the share it covers is held as
  // its ink (tileLook, folderLook), each pixel counted by how much of it the texture covers. A painter that laid no texture
  // at those ratios left Wide folder one flat slab there with every test green (review F3.3).
  const grey = TAPER_COLOURS.find((c) => c.name === 'Reclaim not scored')!;
  const runs = [...TAPER_COLOURS.map((c) => ({ c, dpr: 1 })), { c: TAPER_COLOURS[1], dpr: 2 },
    ...[1.25, 1.5, 1.75].map((dpr) => ({ c: TAPER_COLOURS[1], dpr })), { c: grey, dpr: 1.5 }];
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    for (const { c, dpr } of runs) {
      for (let s = 2; s < OUTLINED_PX; s++) {
        // 2 css px is a whole number of device pixels only at 100, 150 and 200 %: at 125 and 175 % a grid of 2 px tiles
        // lies on tiles of 2 and 3 device px, and those of 2 (1.6 and 1.14 css px) are under the texture step.
        if (s === 2 && !Number.isInteger(s * dpr)) continue;
        const n = Math.ceil(60 / s), g = uniformGrid(s, n, 4e8);
        const { raster, px } = rasterPaint(g.tiles, palette, g.W, g.H, () => c.rgb, undefined, false, dpr);
        const inner = (r: Painted) => { const [i, j] = /g(\d+)\.(\d+)$/.exec(r.n.path)!.slice(1).map(Number); return i > 0 && j > 0 && i < n - 1 && j < n - 1; };
        const t = tileLook(raster, px, inner, dpr);
        const where = `${theme}, ${c.name}, ${s} px tiles, dpr ${dpr}`;
        assert.ok(t.apart > 0.2, `${where}: a texture shows — ${(t.apart * 100).toFixed(1)}% of the pixels stand apart from the fill`);
        assert.ok(t.ink > 0.2, `${where}: a texture shows — it covers ${(t.ink * 100).toFixed(1)}% of the tiles' area`);
        assert.ok(t.strongest <= 1.6, `${where}: a texture, not a line — at most ${fmt(t.strongest)}:1 from the fill`);
        assert.equal(t.black, 0, `${where}: nothing near-black`);
        assert.ok(Math.abs(t.dL) <= 0.1 * t.L, `${where}: mean lightness ${t.dL.toFixed(2)} L* from the solid fill's ${t.L.toFixed(1)}`);
      }
    }
    // A folder of files all under the floor, as Wide folder (20×21 px in the corpus map) and a larger one, on the size ramp
    // and in Reclaim's "not scored" grey, on the device's pixels. Its seams are 1 css px every 4 px at every ratio, so they
    // cover as much of it as at 100 % — within an eighth: they keep a device pixel clear beside the band, which is less of
    // the folder as the ratio rises (Wide folder's seams cover 33.9% of it at 100 %, 36.3-36.8% at the others). Laid one
    // device pixel thick, they covered 19.3% of it at 2x and 25.3% at 150 % (review F3.4).
    for (const [w, h, colour] of [[20, 21, undefined], [200, 120, undefined], [200, 120, grey]] as const) {
      let atOne = 0;
      for (const dpr of [1, 1.25, 1.5, 1.75, 2]) {
        const g = subFloorFolder(w, h);
        const { raster, px } = rasterPaint(g.tiles, palette, g.W, g.H, colour ? () => colour.rgb : undefined, undefined, false, dpr);
        const f = px.find((r) => r.n.path === '/c/Wide folder')!;
        const t = folderLook(raster, f, dpr);
        if (dpr === 1) atOne = t.ink;
        const where = `${theme}, a ${w}×${h} px folder of files under the floor${colour ? `, ${colour.name}` : ''}, dpr ${dpr}`;
        assert.ok(t.whole > 0.1 * t.total, `${where}: control — ${t.whole} of its ${t.total} device pixels lie wholly under a seam the painter recorded`);
        assert.ok(t.apart > 0.2, `${where}: a texture shows — ${(100 * t.apart).toFixed(1)}% of its pixels`);
        assert.ok(Math.abs(t.ink - atOne) <= atOne / 8, `${where}: its seams cover ${(100 * t.ink).toFixed(1)}% of it, where at 100 % they cover ${(100 * atOne).toFixed(1)}%`);
        assert.ok(t.weakest >= 1.2, `${where}: its seams stand ${fmt(t.weakest)}:1 or more from its fill — faint, and seen`);
        assert.ok(t.strongest <= 1.6, `${where}: a texture, not a mesh — at most ${fmt(t.strongest)}:1 from its fill`);
        assert.equal(t.black, 0, `${where}: nothing near-black`);
        assert.ok(Math.abs(t.dL) <= 0.1 * t.L, `${where}: mean lightness ${t.dL.toFixed(2)} L* from the solid fill's ${t.L.toFixed(1)}`);
      }
    }
  }
});

/**
 * A deterministic stand-in for the densest 280 px of /System/Library's map (bqa8shots, 1440 wide): about a hundred
 * top-level folders of falling size (1/k^1.15), each of one to eight folders, each of one to six folders of one to five
 * files (a few with files under the floor), laid out by the server's own buildTreemap at the page's floor and Depth 4 —
 * about 2,000 folders and 4,000 leaves, most of either 1–7 px across, as the real corner's 2,300 and 3,100. Painted
 * BQJ-2's way it is 45.9% folder band, with 46.1% of its pixels under luminance 0.08 (the real corner 42.8% and 43.4%).
 */
function denseCornerNodes(): Tile[] {
  let seed = 20261021;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const between = (lo: number, hi: number) => Math.round(10 ** (Math.log10(lo) + rnd() * (Math.log10(hi) - Math.log10(lo))));
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const dir = (p: string, children: FileNode[]): FileNode => ({ name: p.slice(p.lastIndexOf('/') + 1), path: p, type: 'dir', size: children.reduce((a, c) => a + c.size, 0), modifiedAt: 0, isHidden: false, children });
  const files = (d: string, n: number, lo: number, hi: number, from = 0): FileNode[] =>
    Array.from({ length: n }, (_, i) => ({ name: `f${from + i}`, path: `${d}/f${from + i}`, type: 'file' as const, size: between(lo, hi), modifiedAt: 0, isHidden: false, extension: '' }));
  const zipf = (n: number) => { const z = Array.from({ length: n }, (_, i) => 1 / (i + 1) ** 1.15); const t = z.reduce((a, b) => a + b, 0); return z.map((v) => v / t); };
  const level3 = (p: string, k: number, budget: number): FileNode => {
    const d = `${p}/c${k}`, n = int(1, 5);
    return dir(d, [...files(d, n, 4000, Math.max(8000, (budget / n) * 3)), ...files(d, rnd() < 0.05 ? int(1, 3) : 0, 300, 3900, n)]);
  };
  const level2 = (p: string, k: number, budget: number): FileNode => {
    const d = `${p}/b${k}`;
    return dir(d, [...zipf(int(1, 6)).map((v, i) => level3(d, i, budget * 0.8 * v)), ...files(d, int(0, 3), 4000, Math.max(8000, budget * 0.2))]);
  };
  const level1 = (k: number, budget: number): FileNode => {
    const d = `/S/a${k}`;
    return dir(d, [...zipf(int(1, 8)).map((v, i) => level2(d, i, budget * 0.85 * v)), ...files(d, int(0, 4), 8000, Math.max(16000, budget * 0.15))]);
  };
  const root = dir('/S', zipf(100).map((v, k) => level1(k, 4.6e9 * v)));
  return buildTreemap(root, { maxDepth: 4, minSize: 4000, maxNodes: 20000 }) as unknown as Tile[];
}
const DENSE_PX = 280;

/**
 * corpus/Mail as the corpus map draws it 1440 wide (bqa8shots): a top-level folder 58×52 px holding 24 mailbox folders,
 * each of four to six "Messages" folders of 60–140 mail files of 1–6.5 KB — those over the 4 KB floor 1 px leaves, the
 * rest the folder's own fill — beside two of the corpus's other folders, on a 300×200 map. Mail's box is laid out by
 * the server's own buildTreemap, scaled into it.
 */
function mailNodes(): { tiles: Tile[]; W: number; H: number; mail: { x: number; y: number; w: number; h: number } } {
  let seed = 37746617;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const dir = (p: string, children: FileNode[]): FileNode => ({ name: p.slice(p.lastIndexOf('/') + 1), path: p, type: 'dir', size: children.reduce((a, c) => a + c.size, 0), modifiedAt: 0, isHidden: false, children });
  const mail = dir('/c/Mail', Array.from({ length: 24 }, (_, k) => {
    const box = `/c/Mail/Mailbox ${k}.mbox`;
    return dir(box, Array.from({ length: int(4, 6) }, (_, j) => {
      const m = `${box}/Messages-${j}`;
      return dir(m, Array.from({ length: int(60, 140) }, (_, i) => ({ name: `${i}.emlx`, path: `${m}/${i}.emlx`, type: 'file' as const, size: Math.round(10 ** (3 + rnd() * 0.81)), modifiedAt: 0, isHidden: false, extension: 'emlx' })));
    }));
  }));
  const W = 300, H = 200, box = { x: 242, y: 148, w: 58, h: 52 };
  const pct = (v: number, of: number) => (v / of) * 100;
  const tiles: Tile[] = [
    { name: 'Videos', path: '/c/Videos', size: 9e9, type: 'file', depth: 1, expanded: false, x: 0, y: 0, w: 100, h: pct(148, H) },
    { name: 'Docs', path: '/c/Docs', size: 2e8, type: 'dir', depth: 1, expanded: true, x: 0, y: pct(148, H), w: pct(242, W), h: pct(52, H) },
    { name: 'Mail', path: '/c/Mail', size: mail.size, type: 'dir', depth: 1, expanded: true, x: pct(box.x, W), y: pct(box.y, H), w: pct(box.w, W), h: pct(box.h, H) },
  ];
  for (const n of buildTreemap(mail, { maxDepth: 3, minSize: 4000, maxNodes: 20000 }) as unknown as Tile[]) {
    tiles.push({ ...n, depth: n.depth + 1, x: pct(box.x + (n.x / 100) * box.w, W), y: pct(box.y + (n.y / 100) * box.h, H), w: pct((n.w / 100) * box.w, W), h: pct((n.h / 100) * box.h, H) });
  }
  return { tiles, W, H, mail: box };
}

/** The share of the box's pixels a folder's band covers, by the bands the painter laid (r.bands), on whole css px. */
function bandShare(px: Painted[], box: { x: number; y: number; w: number; h: number }) {
  const on = new Uint8Array(box.w * box.h);
  for (const b of px.flatMap((r) => r.bands || [])) {
    for (let y = Math.max(box.y, Math.round(b.y)); y < Math.min(box.y + box.h, Math.round(b.y + b.h)); y++) {
      for (let x = Math.max(box.x, Math.round(b.x)); x < Math.min(box.x + box.w, Math.round(b.x + b.w)); x++) on[(y - box.y) * box.w + (x - box.x)] = 1;
    }
  }
  return on.reduce((n, v) => n + v, 0) / on.length;
}
/** The share of the box's pixels darker than relative luminance `under`. */
function darkShare(raster: ReturnType<typeof rasterCtx>, box: { x: number; y: number; w: number; h: number }, under: number) {
  let n = 0;
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) if (luminance(raster.at(x, y)) < under) n++;
  return n / (box.w * box.h);
}

test('owner\'s refinement: thinner frames — a corner as dense as /System/Library\'s is at most 25% folder band with at most 22% of its pixels under luminance 0.08, and a folder like corpus/Mail (58×52 px of 24 mailboxes of tiny files) at most 40% band, reading as the colour of what it holds — in both themes, at device pixel ratios 1, 1.5 and 2', () => {
  const dense = denseCornerNodes();
  const mail = mailNodes();
  for (const dpr of [1, 1.5, 2]) for (const [theme0, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    const theme = `${theme0}, dpr ${dpr}`;
    const d = rasterPaint(dense, palette, DENSE_PX, DENSE_PX, undefined, undefined, false, dpr);
    const all = { x: 0, y: 0, w: DENSE_PX, h: DENSE_PX };
    const dev = (b: { x: number; y: number; w: number; h: number }) => ({ x: Math.round(b.x * dpr), y: Math.round(b.y * dpr), w: Math.round(b.w * dpr), h: Math.round(b.h * dpr) });
    const frames = d.px.filter((r) => r.frame), leaves = d.px.filter((r) => !r.frame);
    assert.ok(frames.length > 1500 && leaves.length > 2500 && leaves.filter((r) => Math.min(r.w, r.h) < 8).length > leaves.length * 0.9,
      `${theme}: control — a corner like the real one: ${frames.length} folders, ${leaves.length} leaves, most under 8 px`);
    const band = bandShare(d.px, all), dark = darkShare(d.raster, dev(all), 0.08);
    assert.ok(band <= 0.25, `${theme}: the dense corner is ${(band * 100).toFixed(1)}% folder band`);
    assert.ok(dark <= 0.22, `${theme}: ${(dark * 100).toFixed(1)}% of the dense corner is under luminance 0.08`);
    assert.ok(d.raster.nearBlack(NEAR_BLACK) < 0.02, `${theme}: near-black ${(d.raster.nearBlack(NEAR_BLACK) * 100).toFixed(2)}% of the dense corner`);
    // corpus/Mail.
    const m = rasterPaint(mail.tiles, palette, mail.W, mail.H, undefined, undefined, false, dpr);
    const inMail = m.px.filter((r) => r.n.path.startsWith('/c/Mail/'));
    const boxes = inMail.filter((r) => r.frame && r.n.depth === 2).length, files = inMail.filter((r) => !r.frame).length;
    // (At 150 % a file of 1 css px covers under one css px² once laid on whole device pixels, and is not drawn: its
    // folder's own fill stands for it.)
    assert.ok(boxes === 24 && (dpr === 1.5 || files > 300), `${theme}: control — Mail's 24 mailboxes (${boxes}) and their tiny files (${files}) are drawn`);
    const mb = bandShare(m.px, mail.mail);
    assert.ok(mb <= 0.4, `${theme}: corpus/Mail is ${(mb * 100).toFixed(1)}% band`);
    // It reads as what it holds: most of its pixels show the tiles — within 1.5:1 of the map with no line or band laid.
    const bare = rasterPaint(mail.tiles, palette, mail.W, mail.H, undefined, undefined, false, dpr, lineCalls(m.px)).raster;
    const mb2 = dev(mail.mail);
    let same = 0;
    for (let y = mb2.y; y < mb2.y + mb2.h; y++) for (let x = mb2.x; x < mb2.x + mb2.w; x++) if (contrast(m.raster.at(x, y), bare.at(x, y)) < 1.5) same++;
    const shows = same / (mb2.w * mb2.h);
    // At 150 % a 1 px band spans a device pixel and a half: the half it covers is a blend, neither band nor tile.
    const bar = dpr === 1.5 ? 0.5 : 0.6;
    assert.ok(shows >= bar, `${theme}: ${(shows * 100).toFixed(1)}% of corpus/Mail shows the colour of what it holds (${bar * 100}% asked)`);
  }
});

/** A colouring of `nodes` by a stable hash of each path: Age's four bands, or a Reclaim score with about one in six not scored. */
function hashColouring(kind: 'age' | 'reclaim'): (n: Tile) => RGB {
  const ages = OTHER_COLOURS.filter((c) => c.name.startsWith('Age band')).map((c) => c.rgb);
  const scores = OTHER_COLOURS.filter((c) => c.name.startsWith('Reclaim')).map((c) => c.rgb); // 0…100, then "not scored"
  return (n) => {
    let h = 2166136261;
    for (const ch of n.path) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    if (kind === 'age') return ages[h % ages.length];
    return h % 6 === 0 ? scores[scores.length - 1] : scores[h % (scores.length - 1)];
  };
}

test('owner\'s refinement: every line stands out from the tile on EACH of its sides — every leaf\'s line and every folder\'s band at 3:1 against every tile beside it on the device\'s pixels, every two leaves of 8 px and up parted by a line, and the bands at 4.5:1 or more on the size ramp — on a dense corner, corpus/Mail and a realistic map, at device pixel ratios 1, 1.5 and 2, in both themes, coloured by size, Age and Reclaim', () => {
  // Each outline was toned against its own tile alone: beside a smaller leaf, or a folder's fill (J51), it fell to
  // 2.33:1 against the tile on its far side (corpus/Mail, 104 of 1,889 edges).
  const dense = denseCornerNodes(), mail = mailNodes(), real = realisticNodes();
  const maps: Array<[string, Tile[], number, number, number[]]> = [
    ['the dense corner', dense, DENSE_PX, DENSE_PX, [1, 1.5, 2]],
    ['corpus/Mail', mail.tiles, mail.W, mail.H, [1, 1.5, 2]],
    ['the realistic map', real, REAL_W, REAL_H, [1]],
  ];
  const colourings: Array<[string, ((n: Tile) => RGB) | undefined]> = [['size', undefined], ['Age', hashColouring('age')], ['Reclaim', hashColouring('reclaim')]];
  for (const [what, tiles, W, H, ratios] of maps) {
    for (const dpr of ratios) {
      for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
        for (const [colouring, colour] of colourings) {
          const where = `${what}, ${theme}, dpr ${dpr}, by ${colouring}`;
          const { raster, px } = rasterPaint(tiles, palette, W, H, colour, undefined, false, dpr);
          const m = measureEdges(raster, px, dpr);
          const leafPlaces = m.edges.filter((e) => e.kind === 'leaf').length, framePlaces = m.edges.length - leafPlaces;
          assert.ok(leafPlaces > 200 * dpr && framePlaces > (what === 'corpus/Mail' ? 300 : 1000) * dpr, `${where}: control — ${leafPlaces} places a leaf's line meets a tile, ${framePlaces} a band does`);
          assert.deepEqual(m.under, [], `${where}: lines under ${EDGE_BAR}:1 against a tile beside them`);
          const p = partings(raster, px, dpr);
          assert.ok(p.looked > (what === 'corpus/Mail' ? 200 : 500) * dpr, `${where}: control — ${p.looked} places along the sides of leaves of 8 px and up`);
          assert.deepEqual(p.unparted, [], `${where}: leaves of 8 px and up not parted from what lies beside them by a line`);
          if (colouring === 'size') {
            const bands = m.edges.filter((e) => e.kind === 'frame').map((e) => contrast(raster.at(...e.line), raster.at(...e.tile))).sort((a, b) => a - b);
            const median = bands[Math.floor(bands.length / 2)];
            assert.ok(median >= 4.5, `${where}: the bands' median contrast against the tiles beside them is ${fmt(median)}:1`);
          }
        }
      }
    }
  }
});

test('owner\'s refinement: a band is toned against what a person sees beside it, never against a sliver it covers — a 2 px leaf along a folder\'s edge, under its 3 px band, leaves the band toned against the tile past it (REPORT problem 6), at 4.5:1, in both themes', () => {
  const tiles: Tile[] = [
    { name: 'F', path: '/f', size: 5e10, type: 'dir', depth: 1, expanded: true, x: 0, y: 0, w: 100, h: 100 },
    { name: 'sliver', path: '/f/sliver', size: 4e6, type: 'file', depth: 2, expanded: false, x: 20, y: 0, w: 40, h: 2 },
    { name: 'big', path: '/f/big', size: 3e10, type: 'file', depth: 2, expanded: false, x: 0, y: 2, w: 100, h: 98 },
  ];
  // The sliver is Reclaim's dark "not scored" grey: a band toned against it is light, and on the yellow beside it, weak.
  const colour = (n: Tile) => (n.name === 'sliver' ? OTHER_COLOURS.find((c) => c.name === 'Reclaim not scored')!.rgb : ramp.sizeRgb(n.size));
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    const { raster, px } = rasterPaint(tiles, palette, 200, 100, colour);
    const f = px.find((r) => r.n.path === '/f')!;
    assert.equal(bandOf(f), 3, `${theme}: control — F's band is 3 px, over the 2 px sliver`);
    // Over the sliver's stretch of F's top band (x 40..120), the pixel past the band (row 3) is the big tile.
    let worst = Infinity;
    for (let x = 44; x < 116; x++) worst = Math.min(worst, contrast(raster.at(x, 2), raster.at(x, 3)));
    assert.ok(worst >= 4.5, `${theme}: F's band over the sliver stands ${fmt(worst)}:1 from the big tile a person sees past it`);
  }
});

/**
 * A nested folder F, 30×20 px — a 1 px band — whose bottom band runs over a 1 px strip D of Reclaim's dark "not scored" grey,
 * with a green leaf O past it: no one shade of the band stands 4.5:1 from D and 3:1 from O, so the band is laid in two
 * parts, its outer pixel toned against O and its inner one against the row 2 px in — a row that holds a yellow tile Y and
 * a dark one D2 side by side (review F1.2). Every edge inside the map lies a fifth of a px past a whole px, as a layout puts
 * it: at 150 % a whole odd px is half a device pixel, where two tiles' shared edge, reckoned from each, can round apart.
 */
function mixedRowUnderBand() {
  const W = 60, H = 50, pct = (v: number, of: number) => (v / of) * 100;
  const yellow: RGB = [209, 182, 40], dark = OTHER_COLOURS.find((c) => c.name === 'Reclaim not scored')!.rgb, green: RGB = [86, 210, 75];
  const off = (v: number) => (v > 0 ? v + 0.2 : v);
  const node = (path: string, depth: number, [x, y, w, h]: number[], rgb: RGB): Tile & { rgb: RGB } => ({
    name: path.slice(path.lastIndexOf('/') + 1), path, size: 1e9, type: 'file', depth, expanded: false,
    x: pct(off(x), W), y: pct(off(y), H), w: pct(w, W), h: pct(h, H), rgb });
  const tiles = [
    { ...node('/T', 1, [0, 0, 60, 45], [120, 120, 200]), type: 'dir', expanded: true },
    { ...node('/T/F', 2, [10, 10, 30, 20], [120, 120, 200]), type: 'dir', expanded: true },
    node('/T/O', 2, [10, 30, 30, 5], green),
    node('/T/F/Y', 3, [10, 10, 15, 18], yellow),
    node('/T/F/D2', 3, [25, 10, 15, 18], dark),
    node('/T/F/D', 3, [10, 28, 30, 1], dark),
    node('/T/F/S', 3, [10, 29, 30, 1], dark),
  ];
  return { tiles: tiles as Tile[], W, H, colour: (n: Tile) => (n as Tile & { rgb: RGB }).rgb };
}

test('owner\'s refinement: a 1 px band laid in two parts tones its inner part piece by piece against the tiles beside each piece — never one shade against a row that mixes a light tile and a dark one, which no shade stands out from (it stood 2.00:1 from the yellow), every band at 3:1 against every tile beside it, at device pixel ratios 1, 1.5 and 2, in both themes (review F1.2)', () => {
  const m = mixedRowUnderBand();
  for (const dpr of [1, 1.5, 2]) {
    for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
      const where = `${theme}, dpr ${dpr}`;
      const { raster, px } = rasterPaint(m.tiles, palette, m.W, m.H, m.colour, undefined, false, dpr);
      const f = px.find((r) => r.n.path === '/T/F')!;
      // Control: F's band is 1 px, and its bottom band is laid in two parts — its last row and the one above — over the strips.
      const last = f.y + f.h - 1, bottom = (f.bands || []).filter((b) => b.w > b.h && b.y > f.y + f.h / 2);
      assert.ok(f.lw === 1 && bottom.some((b) => Math.abs(b.y - last) < 1e-6) && bottom.some((b) => Math.abs(b.y - (last - 1)) < 1e-6),
        `${where}: control — F's 1 px bottom band laid in two parts (${bottom.map((b) => `${b.x},${b.y} ${b.w}×${b.h} ${b.rgb}`).join('; ')})`);
      const e = measureEdges(raster, px, dpr);
      const inner = e.edges.filter((x) => x.kind === 'frame' && x.r === f && x.tile[1] < x.line[1] && x.line[1] >= Math.floor((last - 1) * dpr));
      assert.ok(inner.length > 5 * dpr, `${where}: control — ${inner.length} places F's inner bottom row meets the tiles above it`);
      assert.deepEqual(e.under, [], `${where}: lines under ${EDGE_BAR}:1 against a tile beside them`);
    }
  }
});

/**
 * A home folder's map, 300×100 px: beside the Trash cell the page adds to it (maybeInjectTrash: path "\0trash", depth 1,
 * isTrash) — or, with `ordinary`, a file of the Trash cell's own grey-blue in its place — a top-level folder F of two orange
 * files, or with `leaf`, a top-level file L.
 */
function besideTrash(ordinary: boolean, leaf: boolean) {
  const W = 300, H = 100, pct = (v: number, of: number) => (v / of) * 100;
  const tiles: Tile[] = leaf
    ? [{ name: 'L', path: '/Users/me/L', size: 6e9, type: 'file', depth: 1, expanded: false, x: 0, y: 0, w: pct(180, W), h: 100 }]
    : [
      { name: 'F', path: '/Users/me/F', size: 6e9, type: 'dir', depth: 1, expanded: true, x: 0, y: 0, w: pct(180, W), h: 100 },
      { name: 'a', path: '/Users/me/F/a', size: 4e9, type: 'file', depth: 2, expanded: false, x: 0, y: 0, w: pct(110, W), h: 100 },
      { name: 'b', path: '/Users/me/F/b', size: 2e9, type: 'file', depth: 2, expanded: false, x: pct(110, W), y: 0, w: pct(70, W), h: 100 },
    ];
  const cell = { name: 'Trash', size: 3e9, type: 'dir', depth: 1, expanded: false, x: pct(180, W), y: 0, w: pct(120, W), h: 100 };
  tiles.push(ordinary ? { ...cell, name: 'G', path: '/Users/me/G', type: 'file' } : { ...cell, path: '\0trash', isTrash: true } as Tile);
  const colour = (n: Tile) => (n.path === '/Users/me/G' ? [108, 122, 137] as RGB : [220, 104, 55] as RGB);
  return { tiles, W, H, colour };
}

test('owner\'s refinement: the Trash cell of a home folder\'s map is a neighbour like any other — a folder\'s band and a file\'s line beside it are toned against the Trash cell, never against the map\'s ground, so the map paints pixel for pixel as it does with an ordinary file of the Trash cell\'s colour there: one clean band, one shared line, at device pixel ratios 1 and 2, in both themes (review F1.3)', () => {
  // The Trash cell's path, "\0trash", has no folder in it, so it was filed under '' while the files beside it are filed
  // under the home folder: no line or band facing it found it, and each was toned against the map's ground — a band
  // with a 1 px stripe of its leaf's orange, and in light three lines stacked where one is shared.
  for (const dpr of [1, 2]) {
    for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
      for (const leaf of [false, true]) {
        const where = `${theme}, dpr ${dpr}, beside ${leaf ? 'a file' : 'a folder'}`;
        const trash = besideTrash(false, leaf), plain = besideTrash(true, leaf);
        const t = rasterPaint(trash.tiles, palette, trash.W, trash.H, trash.colour, undefined, false, dpr);
        const p = rasterPaint(plain.tiles, palette, plain.W, plain.H, plain.colour, undefined, false, dpr);
        const cell = t.px.find((r) => (r.n as { isTrash?: boolean }).isTrash)!;
        assert.ok(cell && cell.lines && cell.lines.length > 0, `${where}: control — the Trash cell is drawn, with lines of its own`);
        const near = (px: Painted[]) => px.filter((r) => r.n.depth === 1)
          .map((r) => ({ path: r.n.path === '\0trash' || r.n.path === '/Users/me/G' ? 'the cell' : r.n.path, lines: r.lines, bands: r.bands }));
        assert.deepEqual(near(t.px), near(p.px), `${where}: the lines and bands beside the Trash cell are those beside an ordinary file of its colour`);
        let differ = 0, first = '';
        for (let y = 0; y < t.raster.H; y++) {
          for (let x = 0; x < t.raster.W; x++) {
            const a = t.raster.at(x, y), b = p.raster.at(x, y);
            if (a.some((v, i) => Math.abs(v - b[i]) > 0.5)) { if (!differ) first = `${x},${y}: ${a.map(Math.round)} where ${b.map(Math.round)}`; differ++; }
          }
        }
        assert.equal(differ, 0, `${where}: the map paints as it does with an ordinary file in the cell's place — ${differ} device pixels differ, first ${first}`);
      }
    }
  }
});

/** Each texture seam the painter laid (r.tex) that runs past its own tile's box, as text. */
function texOutside(px: Painted[]) {
  const out: string[] = [];
  for (const r of px) {
    for (const [x, y, w, h] of r.tex?.rects || []) {
      if (x < r.x - 1e-6 || y < r.y - 1e-6 || x + w > r.x + r.w + 1e-6 || y + h > r.y + r.h + 1e-6) out.push(`${r.n.path} (${r.x},${r.y} ${r.w}×${r.h}): a seam at ${x},${y} ${w}×${h}`);
    }
  }
  return out;
}

test('owner\'s refinement: a folder\'s texture lies inside its own box — its last seam is cut at the folder\'s edge, never laid a part of a px over the tile beside it — on a 4.5 px folder beside a file too small for a texture and on a dense corner, at 125, 150 and 175 % and 2×, in both themes (review F1.4)', () => {
  // A folder's seams were each 1 px thick from every 4th px, so the last ran up to 1 px past a folder whose side is not a
  // whole multiple of 4 px: at 2× a 4.5 px folder's seam at 4 px covered the next tile's first device column.
  const W = 200, H = 100, pct = (v: number, of: number) => (v / of) * 100;
  // N is 6, 7, 8 and 9 device px wide at 125, 150, 175 % and 2× — 4.8, 4.67, 4.57 and 4.5 px, each a part of a px past
  // 4 — from x 40; L 2 device px past it. Each edge a fifth of a device pixel past where it lies, clear of a tie.
  const tilesAt = (dpr: number): Tile[] => {
    const k = { 1.25: 6, 1.5: 7, 1.75: 8, 2: 9 }[dpr]!, end = (40 * dpr + k + 0.2) / dpr, far = (40 * dpr + k + 2.2) / dpr;
    return [
      { name: 'N', path: '/r/N', size: 2e8, type: 'dir', depth: 1, expanded: true, x: pct(40, W), y: pct(20, H), w: pct(end - 40, W), h: pct(32, H) },
      { name: 'L', path: '/r/L', size: 6e9, type: 'file', depth: 1, expanded: false, x: pct(end, W), y: pct(20, H), w: pct(far - end, W), h: pct(32, H) },
    ];
  };
  const dense = denseCornerNodes();
  for (const dpr of [1.25, 1.5, 1.75, 2]) {
    for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
      const where = `${theme}, dpr ${dpr}`;
      const { raster, px } = rasterPaint(tilesAt(dpr), palette, W, H, undefined, undefined, false, dpr);
      const n = px.find((r) => r.n.path === '/r/N')!, l = px.find((r) => r.n.path === '/r/L')!;
      assert.ok(n.tex && n.tex.rects.length > 0 && !l.tex && !l.lines && n.w % 4 > 0 && n.w % 4 < 1,
        `${where}: control — N (${n.w} px across) is textured, with a part of a seam past its last whole 4 px; L (${l.w} px) is plain`);
      assert.deepEqual(texOutside(px), [], `${where}: texture seams past their own box`);
      // L shows its own cushion on every device pixel: no seam of N's lies on it.
      let worst = 1, at = '';
      const x0 = Math.round(l.x * dpr), x1 = Math.round((l.x + l.w) * dpr), y0 = Math.round(l.y * dpr), y1 = Math.round((l.y + l.h) * dpr);
      for (let y = y0; y < y1; y++) {
        const fill = lerp(l.stops![0], l.stops![1], Math.max(0, Math.min(1, ((y + 0.5) / dpr - l.y) / l.h)));
        for (let x = x0; x < x1; x++) {
          const c = contrast(raster.at(x, y), fill);
          if (c > worst) { worst = c; at = `${x},${y}: ${raster.at(x, y).map(Math.round)} on its cushion ${fill.map(Math.round)}`; }
        }
      }
      assert.ok(worst < 1.02, `${where}: L shows its own cushion — ${fmt(worst)}:1 off it at ${at}`);
      if (dpr === 1.5 || dpr === 2) {
        const d = rasterPaint(dense, palette, DENSE_PX, DENSE_PX, undefined, undefined, false, dpr).px;
        assert.ok(d.filter((r) => r.frame && r.tex).length > 200, `${where}: control — the dense corner's folders are textured`);
        assert.deepEqual(texOutside(d).slice(0, 6), [], `${where}: the dense corner's texture seams past their own box`);
      }
    }
  }
});

/**
 * Two nested folders, each with one file at one end and its own fill past it (review F2.5): H, 80×60 px, its file B down
 * its left 30 px; V, 80×60 px, its file C across its top 24 px — in a top-level folder of its own, on a 200×160 map.
 */
function seamFolders() {
  const W = 200, H = 160, pct = (v: number, of: number) => (v / of) * 100;
  const node = (path: string, depth: number, dir: boolean, x: number, y: number, w: number, h: number): Tile =>
    ({ name: path.slice(path.lastIndexOf('/') + 1), path, size: dir ? 1e10 : 5e9, type: dir ? 'dir' : 'file', depth, expanded: dir, x: pct(x, W), y: pct(y, H), w: pct(w, W), h: pct(h, H) });
  return {
    W, H, tiles: [node('/s', 1, true, 0, 0, 200, 160), node('/s/H', 2, true, 10, 10, 80, 60), node('/s/V', 2, true, 110, 10, 80, 60),
      node('/s/H/B', 3, false, 10, 10, 30, 60), node('/s/V/C', 3, false, 110, 10, 80, 24)],
  };
}

test('owner\'s refinement: a folder\'s texture seams its own fill every 4 px from its corner wherever that fill shows — past a file at one end of it too, down and across — never cut short by a file it has passed, at device pixel ratios 1 and 2, in both themes (review F2.5)', () => {
  // The texture sweeps a folder's files in order of where they start, and lets each go once a seam has passed it; a sweep
  // that kept them covered every later seam with each one it had passed, and the folder's fill beyond went back to a flat
  // slab — every test passed, as their folders held no file or took the seams the painter laid as the ones expected.
  const m = seamFolders();
  for (const dpr of [1, 2]) {
    for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
      const { raster, px } = rasterPaint(m.tiles, palette, m.W, m.H, undefined, undefined, false, dpr);
      const fill = (f: Painted, y: number) => lerp(f.bg![0], f.bg![1], Math.max(0, Math.min(1, (y + 0.5 - f.y) / f.h)));
      // What the raster shows at css px (x, y) — its first device pixel — against folder f's own fill there.
      const off = (f: Painted, x: number, y: number) => contrast(raster.at(x * dpr, y * dpr), fill(f, y));
      for (const [path, across] of [['/s/H', true], ['/s/V', false]] as const) {
        const f = px.find((r) => r.n.path === path)!;
        const where = `${theme}, dpr ${dpr}, ${path}`;
        assert.ok(f.bg && f.tex && f.lw === 2, `${where}: control — the folder shows its own fill, seamed, in a 2 px band`);
        // Clear of the file's line and the band by a px, where no line lies: H's columns 41 to 86 on row 44 (2 past a
        // seam row), V's rows 35 to 66 on column 152 (2 past a seam column).
        const wrong: string[] = [];
        let seams = 0;
        for (let v = across ? 41 : 35; v <= (across ? 86 : 66); v++) {
          const x = across ? v : 152, y = across ? 44 : v, seam = (v - (across ? f.x : f.y)) % 4 === 0, c = off(f, x, y);
          if (seam) seams++;
          if (seam ? c < 1.15 : c > 1.03) wrong.push(`${x},${y}: ${fmt(c)}:1 from the fill (${seam ? 'a seam' : 'between seams'})`);
        }
        assert.ok(seams >= 8, `${where}: control — ${seams} seams looked at`);
        assert.deepEqual(wrong.slice(0, 6), [], `${where}: a ${across ? 'column' : 'row'} every 4 px past the file is a seam, and only those (${wrong.length} wrong)`);
      }
    }
  }
});

/**
 * A file A of 8 px and up beside a tile whose texture runs along the edge they share, the two parting by a little over
 * 3.3:1 on their cushions (review F1.5): `above`, A over a 5 px file B (its texture's top row along A's bottom: the
 * review's case); `beside`, A left of a 5 px file B (its texture's left column along A's right side, low on A, where
 * its cushion is darker); `folder`, A in a folder F of nothing else drawn, whose own fill is seamed every 4 px from its
 * corner — a seam along A's bottom, and seams crossing its top. A is a Reclaim yellow, B and F Reclaim's dark "not
 * scored" grey.
 */
function besideTexture(kind: 'above' | 'beside' | 'folder') {
  const W = 80, H = 60, pct = (v: number, of: number) => (v / of) * 100;
  const score = (s: number) => OTHER_COLOURS.find((c) => c.name === `Reclaim score ${s}`)!.rgb;
  const yellow: RGB = kind === 'above' ? [186, 167, 50] : kind === 'beside' ? score(30) : score(40);
  const dark = OTHER_COLOURS.find((c) => c.name === 'Reclaim not scored')!.rgb;
  const file = (path: string, depth: number, x: number, y: number, w: number, h: number): Tile =>
    ({ name: path.slice(path.lastIndexOf('/') + 1), path, size: 1e9, type: 'file', depth, expanded: false, x: pct(x, W), y: pct(y, H), w: pct(w, W), h: pct(h, H) });
  const tiles = kind === 'above' ? [file('/A', 1, 10, 10, 60, 30), file('/B', 1, 10, 40, 60, 5)]
    : kind === 'beside' ? [file('/A', 1, 10, 10, 40, 30), file('/B', 1, 50, 30, 5, 5)]
    : [{ ...file('/F', 1, 0, 0, 80, 60), type: 'dir', expanded: true }, file('/F/A', 2, 10, 4, 60, 8)];
  return { tiles, W, H, colour: (n: Tile) => (/\/A$/.test(n.path) ? yellow : dark) };
}

/** The painter's own bar for a leaf's line against the tile on each of its sides, and for leaving one out (TM_EDGE_MIN). */
const PAINTER_EDGE = load<number>(['TM_EDGE_MIN'], {}, 'TM_EDGE_MIN');

test('owner\'s refinement: a leaf\'s line is left out only where the tiles part by the painter\'s 3.3:1 as the screen shows them — the far tile\'s texture beside the edge counted, a smaller file\'s or a folder\'s seams — so every leaf of 8 px and up is parted by 3.3:1 from what lies beside it on the device\'s pixels: above and beside a file too small for lines, and in a folder whose own fill is seamed along its sides, at device pixel ratios 1, 1.5 and 2, in both themes (review F1.5)', () => {
  // The line was left out where the two cushions parted by 3.3:1, and the far tile's lighter texture then lay along the
  // edge: A's yellow bottom row stood 2.64:1 from the 5 px file's texture under it, with no line between them — under
  // the owner's 3:1. Beside a folder's seams (1.21:1) it stood 3.09:1, under the painter's own 3.3.
  assert.equal(PAINTER_EDGE, 3.3, 'control: the painter leaves a line out where the tiles part by 3.3:1');
  for (const kind of ['above', 'beside', 'folder'] as const) {
    const m = besideTexture(kind);
    for (const dpr of [1, 1.5, 2]) {
      for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
        const where = `${kind}, ${theme}, dpr ${dpr}`;
        const { raster, px } = rasterPaint(m.tiles, palette, m.W, m.H, m.colour, undefined, false, dpr);
        const a = px.find((r) => /\/A$/.test(r.n.path))!, far = kind === 'folder' ? px.find((r) => r.frame)! : px.find((r) => r.n.path === '/B')!;
        assert.ok(a.lines && far.tex && far.tex.rects.length > 0, `${where}: control — A has lines of its own, and what lies beside it a texture`);
        const p = partings(raster, px, dpr, PAINTER_EDGE);
        assert.ok(p.looked > 40 * dpr, `${where}: control — ${p.looked} places along A's sides`);
        assert.deepEqual(p.unparted, [], `${where}: A not parted by ${PAINTER_EDGE}:1 from what lies beside it`);
      }
    }
  }
});

/**
 * A grey file L, 30×9 px, in a top-level folder P, with a 6 px file T of Reclaim's dark "not scored" grey just right of it
 * (review F2.2): with `inFolder`, T is the only file in a folder F of its own size, too small for a band, so what lies
 * beyond L's right side is found inside F. T's texture's left column runs along L's right side; L's cushion parts from T's
 * by 3.3:1 or more for the greys from 154 to 170 (3.33 to 4.01:1), and from T's lighter texture by less (2.52 to 3.02:1).
 */
function besideBandless(grey: number, inFolder: boolean) {
  const W = 100, H = 100, dark = OTHER_COLOURS.find((c) => c.name === 'Reclaim not scored')!.rgb;
  const node = (path: string, depth: number, x: number, y: number, w: number, h: number, dir = false): Tile =>
    ({ name: path.slice(path.lastIndexOf('/') + 1), path, size: dir ? 1e9 : 1e6, type: dir ? 'dir' : 'file', depth, expanded: dir, x, y, w, h });
  const tiles = [node('/r/P', 1, 0, 0, 60, 40, true), node('/r/P/L', 2, 10, 10, 30, 9)];
  if (inFolder) tiles.push(node('/r/P/F', 2, 40, 12, 6, 6, true), node('/r/P/F/T', 3, 40, 12, 6, 6));
  else tiles.push(node('/r/P/T', 2, 40, 12, 6, 6));
  return { tiles, W, H, colour: (n: Tile) => (n.path === '/r/P/L' ? [grey, grey, grey] as RGB : n.path.endsWith('/T') ? dark : [70, 110, 160] as RGB) };
}

test('owner\'s refinement: beside a folder too small for a band, a leaf\'s line is left out only where it parts by 3.3:1 from what that folder shows along the edge — the texture of the file inside it counted, as beside the same file laid in the open — at device pixel ratios 1, 1.5 and 2, in both themes (review F2.2)', () => {
  // Beyond a folder too small for a band the line looked inside the folder and weighed only the cushion of the file there,
  // never its texture: L's line was left out, and T's lighter left column stood 2.68:1 from L's grey (154) with no line
  // between them, where T laid in the open beside L kept the line.
  for (const dpr of [1, 1.5, 2]) {
    for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
      for (const inFolder of [false, true]) {
        let looked = 0;
        for (let grey = 150; grey <= 170; grey += 2) {
          const m = besideBandless(grey, inFolder);
          const where = `${theme}, dpr ${dpr}, grey ${grey}, T ${inFolder ? 'in a folder of its own' : 'in the open'}`;
          const { raster, px } = rasterPaint(m.tiles, palette, m.W, m.H, m.colour, undefined, false, dpr);
          const l = px.find((r) => r.n.path === '/r/P/L')!, t = px.find((r) => r.n.path.endsWith('/T'))!, f = px.find((r) => r.n.path === '/r/P/F');
          assert.ok(l.lines && t.tex && t.tex.rects.length > 0 && (!inFolder || (f && f.lw === 0)),
            `${where}: control — L has lines of its own, T a texture${inFolder ? ', and F no band' : ''}`);
          const p = partings(raster, px, dpr, PAINTER_EDGE);
          looked += p.looked;
          assert.deepEqual(p.unparted, [], `${where}: L not parted by ${PAINTER_EDGE}:1 from what lies beside it`);
          assert.deepEqual(measureEdges(raster, px, dpr).under, [], `${where}: lines under ${EDGE_BAR}:1 against a tile beside them`);
        }
        assert.ok(looked > 11 * 40 * dpr, `${theme}, dpr ${dpr}: control — ${looked} places along L's sides`);
      }
    }
  }
});

/**
 * Hollow online-only files among files with lines of their own (review F2.1): a checkerboard of `s` px tiles at the top
 * level, every other one a hollow cell of the colour `cell`, the rest files in each of `leaves` in turn — so each file
 * meets a hollow cell on each of its four sides.
 */
function besideHollow(cell: RGB, leaves: RGB[], s = 16) {
  const n = Math.ceil(Math.sqrt(2 * leaves.length)), W = n * s, H = n * s, tiles: Tile[] = [];
  const colourOf = new Map<string, RGB>();
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const hollow = (i + j) % 2 === 1, path = `/h/${hollow ? 'c' : 'f'}${i}.${j}`;
      tiles.push({ name: path.slice(3), path, size: 2e9, type: 'file', depth: 1, expanded: false, x: (j * s / W) * 100, y: (i * s / H) * 100, w: (s / W) * 100, h: (s / H) * 100, ...(hollow ? { cloudPlaceholder: true } : {}) } as Tile);
      colourOf.set(path, hollow ? cell : leaves[k++ % leaves.length]);
    }
  }
  return { tiles, W, H, colour: (t: Tile) => colourOf.get(t.path)! };
}

test('owner\'s refinement: beside a hollow online-only file, a leaf\'s line is left out only where it parts by 3.3:1 from what the cell shows at its edge — its dashed outline and faint wash, which cover that device pixel by half at 100 % and less as the ratio rises — every file of 8 px and up parted by 3:1 from each hollow cell beside it, on the size ramp, Reclaim scores, "not scored" and the Age bands, at device pixel ratios 1, 1.25, 1.5 and 2, in both themes (review F2.1)', () => {
  // The cell's edge was taken to be its faint wash alone, so a line was left out beside it; but its dashed outline, 1 px
  // wide and centred 1 px in, covers half of its first device pixel at 100 %: a Reclaim 15 file stood 1.40:1 from a
  // Reclaim 53 cell's edge, a red file 2.66:1 from a red cell's.
  const reclaim = (s: number) => OTHER_COLOURS.find((c) => c.name === `Reclaim score ${s}`)!.rgb;
  const others = [...OTHER_COLOURS.filter((c) => c.name.startsWith('Age band') || c.name === 'Reclaim not scored').map((c) => c.rgb)];
  const leaves = [...RAMP_COLOURS.map((c) => c.rgb), ...Array.from({ length: 21 }, (_, k) => reclaim(5 * k)), ...others];
  const cells = [...RAMP_COLOURS.filter((_, k) => k % 2 === 0).map((c) => c.rgb), ...[0, 15, 30, 45, 53, 60, 75, 90, 100].map(reclaim), ...others];
  for (const dpr of [1, 1.25, 1.5, 2]) {
    for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
      let looked = 0;
      const unparted: string[] = [];
      for (const cell of cells) {
        const m = besideHollow(cell, leaves);
        const { raster, px } = rasterPaint(m.tiles, palette, m.W, m.H, m.colour, undefined, false, dpr);
        const hollow = px.filter((r) => (r.n as { cloudPlaceholder?: boolean }).cloudPlaceholder), files = px.filter((r) => !(r.n as { cloudPlaceholder?: boolean }).cloudPlaceholder);
        assert.ok(hollow.length > 0 && hollow.every((r) => !r.stops) && files.every((r) => r.lines),
          `${theme}, dpr ${dpr}, cells ${cell}: control — the cells are drawn hollow, and the files have lines of their own`);
        // The owner's 3:1: a line laid in two parts at 125 % blends its inner part into the pixel past its outer one,
        // so its outer pixel alone parts it from the cell, by the painter's 3.3:1 less the rounding of a colour.
        const p = partings(raster, px, dpr);
        looked += p.looked;
        unparted.push(...p.unparted.map((u) => `${u} (the cell ${cell})`));
      }
      assert.ok(looked > cells.length * leaves.length * 4 * 6 * dpr, `${theme}, dpr ${dpr}: control — ${looked} places along the files' sides`);
      assert.deepEqual(unparted.slice(0, 6), [], `${theme}, dpr ${dpr}: ${unparted.length} places a file is not parted by ${EDGE_BAR}:1 from the hollow cell beside it`);
    }
  }
});

/**
 * History diff maps where a wash meets a line at its folder's own edge (review F2.3), each node's diff colour from the
 * kind named for it. `beside`: in a top-level folder P, a file L 20 px tall over a folder G 6 px tall — too small for a
 * band — whose one file T fills it, so L's bottom line runs along G's top edge. `sliver`: a top-level folder F1 over a
 * folder F2 half a css px tall on the map's last row, filled by its one file T2, so F1's bottom band runs along F2.
 */
function washEdge(kind: 'beside' | 'sliver', k: string[]) {
  const W = 80, H = 60, pct = (v: number, of: number) => (v / of) * 100;
  const node = (path: string, depth: number, dir: boolean, x: number, y: number, w: number, h: number, what: string): Tile =>
    ({ name: path.slice(path.lastIndexOf('/') + 1), path, size: 5e9, prevSize: PREV[what](5e9), type: dir ? 'dir' : 'file', depth, expanded: dir, x: pct(x, W), y: pct(y, H), w: pct(w, W), h: pct(h, H) } as Tile);
  const tiles = kind === 'beside'
    ? [node('/r/P', 1, true, 0, 0, 80, 60, k[0]), node('/r/P/L', 2, false, 10, 10, 50, 20, k[1]), node('/r/P/G', 2, true, 10, 30, 50, 6, k[2]), node('/r/P/G/T', 3, false, 10, 30, 50, 6, k[3])]
    : [node('/r/F1', 1, true, 0, 0, 80, 59.5, k[0]), node('/r/F1/A', 2, false, 0, 0, 80, 59.5, k[1]), node('/r/F2', 1, true, 0, 59.5, 80, 0.5, k[2]), node('/r/F2/T2', 2, false, 0, 59.5, 80, 0.5, k[3])];
  return { tiles, W, H };
}

test('owner\'s refinement: in the History diff a line along a washed folder\'s edge stands out from the tile beside it as the screen shows it — the wash covers its folder\'s whole box, as the painter reckons, so a file\'s line over a folder too small for a band parts from the file in it by the painter\'s 3.3:1, and a band beside a folder half a css px tall on the map\'s last row reaches 3:1 — at device pixel ratios 1, 1.25, 1.5 and 2, in both themes (review F2.3)', () => {
  // Each wash was laid half a css px in from its folder's edge, while the painter toned the lines against every tile in
  // the folder as washed: at 2× the tile's outer device pixel was unwashed, and L's line stood 2.91:1 from it (a folder
  // that shrank, holding one that grew); a folder half a px tall was washed off the map, and the band above it stood
  // 2.72:1 from it in the review's fuzz (2.94:1 here); and a file half a px tall just past a washed folder was counted
  // washed by it too — the band of a folder that grew stood 2.94:1 from the unwashed file under it.
  const history = { active: true, diff: true }, colour = (n: Tile) => DIFF_PAGE.diffRgb(n);
  const kinds = ['grew', 'shrank', 'unchanged'];
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      for (const kP of kinds) for (const kG of ['grew', 'shrank', 'new']) for (const kL of kinds) {
        const where = `${theme}, dpr ${dpr}: L ${kL} in P ${kP}, over G ${kG} holding T unchanged`;
        const m = washEdge('beside', [kP, kL, kG, 'unchanged']);
        const { raster, px } = rasterPaint(m.tiles, palette, m.W, m.H, colour, history, false, dpr);
        const l = px.find((r) => r.n.path === '/r/P/L')!, g = px.find((r) => r.n.path === '/r/P/G')!;
        assert.ok(l.lines && g.lw === 0, `${where}: control — L has lines of its own, and G no band`);
        // L's last device row, and the first of G under it, along L's bottom clear of its corners.
        const row = Math.round((l.y + l.h) * dpr);
        let worst = Infinity, at = '';
        for (let x = Math.round(l.x * dpr) + 4 * dpr; x < Math.round((l.x + l.w) * dpr) - 4 * dpr; x++) {
          const c = contrast(raster.at(x, row - 1), raster.at(x, row));
          if (c < worst) { worst = c; at = `${raster.at(x, row - 1).map(Math.round)} on ${raster.at(x, row).map(Math.round)}`; }
        }
        assert.ok(worst >= PAINTER_EDGE, `${where}: L's bottom edge stands ${fmt(worst)}:1 from G's top row (${at})`);
        assert.deepEqual(measureEdges(raster, px, dpr).under, [], `${where}: lines under ${EDGE_BAR}:1 against a tile beside them`);
      }
    }
    for (const k1 of [...kinds, 'new']) for (const k2 of [...kinds, 'new']) for (const kA of kinds) {
      const where = `${theme}, dpr 2: F1 ${k1} holding A ${kA}, over F2 ${k2} half a px tall`;
      const m = washEdge('sliver', [k1, kA, k2, 'unchanged']);
      const { raster, px } = rasterPaint(m.tiles, palette, m.W, m.H, colour, history, false, 2);
      const f1 = px.find((r) => r.n.path === '/r/F1')!, f2 = px.find((r) => r.n.path === '/r/F2');
      assert.ok(f1.lw! > 0 && f2 && f2.h === 0.5, `${where}: control — F1 has a band, and F2 is drawn half a px tall`);
      const e = measureEdges(raster, px, 2);
      assert.ok(e.edges.some((x) => x.r === f1 && x.tile[1] === raster.H - 1), `${where}: control — F1's bottom band is measured against F2`);
      assert.deepEqual(e.under, [], `${where}: lines under ${EDGE_BAR}:1 against a tile beside them`);
    }
  }
});

/**
 * A T-junction (review F2.7): in a top-level folder P of Reclaim's dark "not scored" grey, a yellow file A across its top
 * and a mid-grey file B, 80 px tall, below A from 40 px in — B's top-left corner meets A's bottom edge mid-way, and B's
 * left side faces P's own fill. No one shade of B's grey stands out from both B's whole cushion and P's dark fill, so B's
 * left line is laid in two parts; its top line, which B and A share, is one.
 */
function tJunction() {
  const W = 120, H = 100, pct = (v: number, of: number) => (v / of) * 100;
  const node = (path: string, depth: number, dir: boolean, x: number, y: number, w: number, h: number): Tile =>
    ({ name: path.slice(path.lastIndexOf('/') + 1), path, size: dir ? 1e10 : 4e9, type: dir ? 'dir' : 'file', depth, expanded: dir, x: pct(x, W), y: pct(y, H), w: pct(w, W), h: pct(h, H) });
  const tiles = [node('/P', 1, true, 0, 0, 120, 100), node('/P/A', 2, false, 0, 0, 120, 20), node('/P/B', 2, false, 40, 20, 80, 80)];
  const rgb: Record<string, RGB> = { '/P': OTHER_COLOURS.find((c) => c.name === 'Reclaim not scored')!.rgb, '/P/A': [220, 190, 40], '/P/B': [128, 128, 128] };
  return { tiles, W, H, colour: (n: Tile) => rgb[n.path] };
}

test('owner\'s refinement: where a file\'s corner meets another tile\'s edge, the line across keeps its own pixel at the corner — a side line laid in two parts lays its outer pixel first, under the line along the top — so the file stays parted from the tile above it there, at device pixel ratios 1, 1.5 and 2, in both themes (review F2.7)', () => {
  // A two-part line's outer pixel is toned against the tile beyond it alone; laid over the corner, it broke the line
  // between the file and the tile above it. Only one place in the realistic map, under one colouring, held this.
  const m = tJunction();
  for (const dpr of [1, 1.5, 2]) {
    for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
      const where = `${theme}, dpr ${dpr}`;
      const { raster, px } = rasterPaint(m.tiles, palette, m.W, m.H, m.colour, undefined, false, dpr);
      const b = px.find((r) => r.n.path === '/P/B')!;
      const left = (b.lines || []).filter((l) => l.h > 1 && l.w === 1 && l.y <= b.y + 1e-6);
      const top = (b.lines || []).find((l) => l.h === 1 && Math.abs(l.y - b.y) < 1e-6 && l.x <= b.x + 1e-6 && l.x + l.w > b.x);
      assert.ok(left.some((l) => Math.abs(l.x - b.x) < 1e-6) && left.some((l) => Math.abs(l.x - (b.x + 1)) < 1e-6) && top,
        `${where}: control — B's left line laid in two parts, and its top line across the corner (${(b.lines || []).map((l) => `${l.x},${l.y} ${l.w}×${l.h} ${l.rgb}`).join('; ')})`);
      const want = rgba(top!.rgb).slice(0, 3), got = raster.at(Math.round(b.x * dpr), Math.round(b.y * dpr));
      assert.ok(got.every((v, i) => Math.abs(v - want[i]) <= 1), `${where}: B's corner pixel is its top line's ${want} (it shows ${got.map(Math.round)})`);
      const p = partings(raster, px, dpr);
      assert.ok(p.looked > 100 * dpr, `${where}: control — ${p.looked} places along the files' sides`);
      assert.deepEqual(p.unparted, [], `${where}: files not parted by ${EDGE_BAR}:1 from what lies beside them`);
    }
  }
});

/* ── On the device's own pixels: Retina (2) and 150 % (1.5) ── */

test('tmSnap lays a coordinate on the nearest whole device pixel — at device pixel ratios 1, 1.25, 1.5 and 2 (review F1.7)', () => {
  const snap = load<(v: number, dpr: number) => number>(['tmSnap'], {}, 'tmSnap');
  for (const dpr of [1, 1.25, 1.5, 2]) {
    for (const v of [0, 0.2, 0.5, 1.3, 7.77, 100.4, 333.333, 640.9]) {
      const snapped = snap(v, dpr), device = snapped * dpr;
      assert.ok(Math.abs(device - Math.round(device)) < 1e-9, `dpr ${dpr}: ${v} css px is laid at ${snapped}, ${device} device px — a whole device pixel`);
      assert.ok(Math.abs(snapped - v) <= 0.5 / dpr + 1e-9, `dpr ${dpr}: ${v} css px is laid at ${snapped}, the nearest device pixel (within ${0.5 / dpr} css px)`);
    }
  }
});

/**
 * The review's map (F3.1): a folder F that grew, laid to 99.99999999999999 % of the map's width and height, holding a file A
 * that grew and a file B that is new, and along its bottom two files too short for lines, C (a 2 MB file's light green) and
 * D (a 6 GB file's red) — B and D laid to 100 % across, C and D to 100 % down: the float noise a layout carries at its far
 * edge (buildTreemap rounds nothing). On a map 333 by 241 css px at 150 % F's right and bottom edges are 499.49999999999994
 * and 361.49999999999994 device px, its files' 499.5 and 361.5 (and on one 334 by 242 css px, at 125 and 175 %, half a
 * device pixel too): a bare Math.round put B, C and D a device pixel past their folder, beside its band, which was toned
 * against the map's ground beyond it.
 */
function farEdgeNoise(): Tile[] {
  const near = 99.99999999999999;
  return [
    { name: 'F', path: '/r/F', size: 8e9, prevSize: 2e9, type: 'dir', depth: 1, expanded: true, x: 0, y: 0, w: near, h: near },
    { name: 'A', path: '/r/F/A', size: 4e9, prevSize: 1e9, type: 'file', depth: 2, expanded: false, x: 0, y: 0, w: 50, h: 97.5 },
    { name: 'B', path: '/r/F/B', size: 3e9, type: 'file', depth: 2, expanded: false, x: 50, y: 0, w: 50, h: 97.5 },
    { name: 'C', path: '/r/F/C', size: 2e6, prevSize: 2e6, type: 'file', depth: 2, expanded: false, x: 0, y: 97.5, w: 50, h: 2.5 },
    { name: 'D', path: '/r/F/D', size: 6e9, prevSize: 6e9, type: 'file', depth: 2, expanded: false, x: 50, y: 97.5, w: 50, h: 2.5 },
  ] as Tile[];
}

test('owner\'s refinement at 125, 150 and 175 %: a file and its folder that end together in the layout end on the same device pixel — the float noise at a layout\'s far edge (100 against 99.99999999999999 %) never snaps them a device pixel apart, where a file then lay past its folder, beside the folder\'s band toned against the map\'s ground beyond it, at 1.02:1 — on the review\'s map, 333 by 241 and 334 by 242 css px, by size and in the History diff, in both themes, and on a realistic map 1043 by 741 css px (review F3.1)', () => {
  const snap = load<(v: number, dpr: number) => number>(['tmSnap'], {}, 'tmSnap');
  // 241 × 1.5 is 361.5, and 241 × 0.9999999999999999 × 1.5 is 361.49999999999994.
  assert.equal(snap((99.99999999999999 / 100) * 241, 1.5), snap((100 / 100) * 241, 1.5), 'the two spellings of one far edge snap to one device pixel');
  const colourings: Array<[string, ((n: Tile) => RGB) | undefined, { active: boolean; diff: boolean }]> = [
    ['size', undefined, { active: false, diff: false }], ['the History diff', (n: Tile) => DIFF_PAGE.diffRgb(n), { active: true, diff: true }]];
  for (const [dpr, W, H] of [[1.25, 334, 242], [1.5, 333, 241], [1.75, 334, 242]]) for (const [colouring, colour, history] of colourings) {
    for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
      const where = `the review's map, ${W} by ${H} css px, by ${colouring}, ${theme}, dpr ${dpr}`;
      const { raster, px } = rasterPaint(farEdgeNoise(), palette, W, H, colour, history, false, dpr);
      const dev = (v: number) => Math.round(v * dpr);
      const [F, B, C, D] = ['/r/F', '/r/F/B', '/r/F/C', '/r/F/D'].map((p) => px.find((r) => r.n.path === p)!);
      const m = measureEdges(raster, px, dpr);
      assert.ok(m.edges.length > 1000 * dpr, `${where}: control — ${m.edges.length} places measured`);
      assert.deepEqual(m.under, [], `${where}: lines under ${EDGE_BAR}:1 against a tile beside them`);
      assert.deepEqual(partings(raster, px, dpr).unparted, [], `${where}: files not parted by ${EDGE_BAR}:1 from what lies beside them`);
      assert.deepEqual([[B, D].map((r) => dev(r.x + r.w)), [C, D].map((r) => dev(r.y + r.h))], [[dev(F.x + F.w), dev(F.x + F.w)], [dev(F.y + F.h), dev(F.y + F.h)]],
        `${where}: B and D end on F's last device column, C and D on its last device row, as the layout ends them`);
    }
  }
  // A realistic map: every rectangle whose right or bottom edge is its folder's in the layout ends on its folder's device pixel.
  const real = realisticNodes(), W = 1043, H = 741;
  const layout = new Map(real.map((n) => [n.path, n]));
  for (const dpr of [1.25, 1.5, 1.75]) {
    const { px } = rasterPaint(real, DARK, W, H, undefined, undefined, false, dpr);
    const folders = new Map(px.filter((r) => r.frame).map((r) => [r.n.path, r]));
    const dev = (v: number) => Math.round(v * dpr);
    let together = 0, noisy = 0;
    const apart: string[] = [];
    for (const r of px) {
      const f = folders.get(r.n.path.slice(0, r.n.path.lastIndexOf('/')));
      if (!f) continue;
      const n = layout.get(r.n.path)!, fn = layout.get(f.n.path)!;
      for (const [end, fend, size, a, b] of [[n.x + n.w, fn.x + fn.w, W, r.x + r.w, f.x + f.w], [n.y + n.h, fn.y + fn.h, H, r.y + r.h, f.y + f.h]]) {
        if (Math.abs(end - fend) > 1e-9) continue;
        together++;
        if (Math.round((end / 100) * size * dpr) !== Math.round((fend / 100) * size * dpr)) noisy++;
        if (dev(a) !== dev(b) && apart.length < 6) apart.push(`${r.n.path}: ends at ${dev(a)} device px, its folder at ${dev(b)}`);
      }
    }
    assert.ok(together > 1000 && (dpr !== 1.5 || noisy > 0), `the realistic map, dpr ${dpr}: control — ${together} edges a rectangle shares with its folder, ${noisy} of them a bare rounding snaps apart`);
    assert.deepEqual(apart, [], `the realistic map, dpr ${dpr}: rectangles ending a device pixel off their folder's edge`);
  }
});

test('owner\'s outlines on a Retina screen and at 150 %: every rectangle lies on whole device pixels where its percentages put it, every line reaches 3:1 on the device\'s pixels, and the dense map is no black mesh — at device pixel ratios 2 and 1.5, in both themes (review F1.7)', () => {
  const b = colourBlocks(EVERY_COLOUR, 16, 16);
  const nodes = realisticNodes();
  for (const dpr of [2, 1.5]) {
    for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
      for (const [what, tiles, W, H, colour] of [['the colour blocks', b.tiles, b.W, b.H, b.colour], ['the dense map', nodes, REAL_W, REAL_H, undefined]] as const) {
        const { raster, px } = rasterPaint(tiles as Tile[], palette, W, H, colour as ((n: Tile) => RGB) | undefined, undefined, false, dpr);
        assert.equal(raster.W, Math.round(W * dpr), `${theme}, dpr ${dpr}, ${what}: control — the raster is the device's pixels`);
        // Where each rectangle lies: on whole device pixels, within half a device pixel of where its percentages put it.
        const off: string[] = [];
        for (const r of px) {
          const edges = [[r.x, r.n.x / 100 * W], [r.y, r.n.y / 100 * H], [r.x + r.w, (r.n.x + r.n.w) / 100 * W], [r.y + r.h, (r.n.y + r.n.h) / 100 * H]];
          for (const [at, want] of edges) {
            const device = at * dpr;
            if (Math.abs(device - Math.round(device)) > 1e-6 || Math.abs(device - want * dpr) > 0.5 + 1e-6) off.push(`${r.n.path}: an edge at ${device.toFixed(3)} device px, its layout ${(want * dpr).toFixed(3)}`);
          }
        }
        assert.deepEqual(off.slice(0, 6), [], `${theme}, dpr ${dpr}, ${what}: every rectangle's edges on whole device pixels, where the layout puts them (${off.length} off)`);
        const m = measureEdges(raster, px, dpr);
        assert.ok(m.edges.length > (what === 'the dense map' ? 20000 : EVERY_COLOUR.length * 9 * 8) * dpr, `${theme}, dpr ${dpr}, ${what}: control — ${m.edges.length} places measured`);
        assert.deepEqual(m.under, [], `${theme}, dpr ${dpr}, ${what}: lines under ${EDGE_BAR}:1 against the tile beside them, on the device's pixels`);
        if (what === 'the dense map') {
          const share = raster.nearBlack(NEAR_BLACK);
          assert.ok(share < 0.02, `${theme}, dpr ${dpr}: near-black ${(share * 100).toFixed(2)}% of the dense map's device pixels`);
          // No line under a name tag, on the device's pixels (review F3.1).
          const t = underTags(raster, rasterPaint(nodes, palette, W, H, undefined, undefined, false, dpr, lineCalls(px)).raster, px, dpr);
          assert.ok(t.whole > 1000 * dpr * dpr && t.lines.leaf > 100 * dpr, `${theme}, dpr ${dpr}: control — the tags cover ${t.whole} device pixels whole, where leaf outlines would run in ${t.lines.leaf} places (bands in ${t.lines.frame}, over ${t.bandPx} band pixels)`);
          assert.deepEqual(t.shown, [], `${theme}, dpr ${dpr}: under a name tag, device pixels that are not the tiles under the tag alone — a leaf's outline or a folder's band shows there, or the tag is not laid`);
        }
      }
    }
  }
});

/**
 * A top-level folder F, big enough for a name tag, along the map's top and right edges, beside a file A, over a file B along
 * the map's bottom and both its sides (review F1.1, F1.2): F's tag puts the clip under the tags on, and F's right band, B's
 * right outline and B's bottom outline lie on the canvas's last device column and row.
 */
function edgeMap(): Tile[] {
  const t: Tile[] = [
    { name: 'A', path: '/e/A', size: 3e10, type: 'file', depth: 1, expanded: false, x: 0, y: 0, w: 50, h: 60 },
    { name: 'F', path: '/e/F', size: 3e10, type: 'dir', depth: 1, expanded: true, x: 50, y: 0, w: 50, h: 60 },
    { name: 'B', path: '/e/B', size: 4e10, type: 'file', depth: 1, expanded: false, x: 0, y: 60, w: 100, h: 40 },
  ];
  for (let i = 0; i < 4; i++) t.push({ name: `c${i}`, path: `/e/F/c${i}`, size: 4e9 + i * 1e9, type: 'file', depth: 2, expanded: false, x: 50 + (i % 2) * 25, y: Math.floor(i / 2) * 30, w: 25, h: 30 });
  return t;
}

/**
 * The canvas's last device column and row, where the map's right and bottom edge lines lie (review F1.1, F1.2): each pixel
 * there that a leaf's outline (pass 2.6, 1 css px inside its box) or a folder's band (pass 2.7, deepest first) covers whole,
 * and no name tag covers in any part, should be the last of those lines laid over it, in full. A pixel some line covers only
 * in part is stepped over: there lines meet lines (a band's corner, an outline's), and two partial covers blend as the
 * raster's strokes do, not as one. `looked` counts the pixels held to it.
 */
function outerEdgePixels(raster: ReturnType<typeof rasterCtx>, px: Painted[], dpr: number) {
  const lines: Array<{ box: number[]; rgb: string }> = [];
  for (const r of px) for (const l of r.lines || []) lines.push({ box: [l.x, l.y, l.w, l.h], rgb: l.rgb });
  for (const r of px.filter((p) => p.frame).sort((a, b) => b.n.depth - a.n.depth)) for (const b of r.bands || []) lines.push({ box: [b.x, b.y, b.w, b.h], rgb: b.rgb });
  const covers = ([bx, by, bw, bh]: number[], x: number, y: number) =>
    bx * dpr <= x + 1e-6 && (bx + bw) * dpr >= x + 1 - 1e-6 && by * dpr <= y + 1e-6 && (by + bh) * dpr >= y + 1 - 1e-6;
  const touches = ([bx, by, bw, bh]: number[], x: number, y: number) =>
    bx * dpr < x + 1 - 1e-6 && (bx + bw) * dpr > x + 1e-6 && by * dpr < y + 1 - 1e-6 && (by + bh) * dpr > y + 1e-6;
  let looked = 0;
  const off: string[] = [];
  const check = (x: number, y: number) => {
    if (raster.tagged(x, y)) return;
    const over = lines.filter((l) => touches(l.box, x, y));
    if (!over.length || over.some((l) => !covers(l.box, x, y))) return;
    const last = over[over.length - 1];
    looked++;
    const want = rgba(last.rgb).slice(0, 3), got = raster.at(x, y);
    if (got.some((v, i) => Math.abs(v - want[i]) > 0.5) && off.length < 8) off.push(`${x},${y}: ${got.map(Math.round)} where the line laid over it is ${last.rgb}`);
  };
  for (let y = 0; y < raster.H; y++) check(raster.W - 1, y);
  for (let x = 0; x < raster.W - 1; x++) check(x, raster.H - 1);
  return { looked, off };
}

test('owner\'s outlines at 125, 150 and 175 %, on a map whose css size times the ratio is not whole: the clip that keeps the lines from under the name tags covers the whole canvas — the map\'s right and bottom edge lines are laid in full on its last device column and row, and every line reaches 3:1 there, in both themes (review F1.1, F1.2)', () => {
  // At each ratio a size whose device width and height round up: the canvas, and the map's far edges with it, reach past
  // the map's css size by part of a device pixel, which a clip of the css size alone lets through only in part.
  for (const [dpr, W, H] of [[1.25, 643, 403], [1.5, 641, 401], [1.75, 641, 401]] as const) {
    for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
      const { raster, px } = rasterPaint(edgeMap(), palette, W, H, undefined, undefined, false, dpr);
      const where = `${theme}, dpr ${dpr}, ${W}×${H}`;
      const f = px.find((r) => r.n.path === '/e/F')!, b = px.find((r) => r.n.path === '/e/B')!;
      assert.ok(raster.taggedShare() > 0 && f.w >= 90 && f.h >= 44, `${where}: control — F carries a name tag, so the clip under the tags is on`);
      const ends = [[f.x + f.w, raster.W], [b.x + b.w, raster.W], [b.y + b.h, raster.H]].map(([at, dev]) => `${(at * dpr).toFixed(3)} of ${dev}`);
      assert.ok(b.x + b.w > W && b.y + b.h > H && [f.x + f.w, b.x + b.w].every((v) => Math.abs(v * dpr - raster.W) < 1e-6) && Math.abs((b.y + b.h) * dpr - raster.H) < 1e-6,
        `${where}: control — F's and B's right edges and B's bottom edge lie on the canvas's last device pixel, past the map's css size (${ends.join(', ')} device px)`);
      const m = measureEdges(raster, px, dpr);
      const onEdge = m.edges.filter((e) => (e.what.startsWith('/e/B') && e.what.endsWith('right side') && e.line[0] === raster.W - 1) || (e.what.startsWith('/e/B') && e.what.endsWith('bottom side') && e.line[1] === raster.H - 1));
      assert.ok(onEdge.length > 0.9 * (b.h + b.w) * dpr, `${where}: control — B's right and bottom outlines are measured on the canvas's last device column and row (${onEdge.length} places)`);
      assert.deepEqual(m.under, [], `${where}: lines under ${EDGE_BAR}:1 against the tile beside them, on the device's pixels`);
      const o = outerEdgePixels(raster, px, dpr);
      assert.ok(o.looked > 0.95 * (raster.W + raster.H), `${where}: control — ${o.looked} pixels of the last device column and row lie under a line`);
      assert.deepEqual(o.off, [], `${where}: on the canvas's last device column and row, pixels a line covers whole that are not that line's own colour, in full — F's right band, B's right or bottom outline`);
    }
  }
});

/* ── The SVG export paints what the canvas painted ── */

test('owner\'s outlines: the SVG export paints each leaf\'s toned lines and highlight, each folder\'s own fill, each texture and each band as the canvas did, in its order (mapPaintFidelity\'s rule)', () => {
  const tiles = [...subFloorTiles(), { name: 'grey', path: '/c/Half/grey', size: 3e9, type: 'file', depth: 3, expanded: false, x: 75, y: 40, w: 15, h: 40 } as Tile];
  const colour = (n: Tile) => (n.name === 'grey' ? [0x3a, 0x40, 0x48] as RGB : ramp.sizeRgb(n.size));
  const { svg, rec, px } = exportSvg(tiles, colour, '#0e0e13');
  const painted = px as Painted[];
  const rects = [...svg.matchAll(/<rect ([^>]*?)\/?>/g)].map((m) => ({ a: attrs(m[1]), at: m.index! }));
  const close = (a: Record<string, string>, box: number[]) => ['x', 'y', 'width', 'height'].every((k, i) => Math.abs(Number(a[k]) - box[i]) < 0.011);
  // Each leaf's lines, in the tones the canvas laid them.
  const leaves = painted.filter((r) => !r.frame);
  assert.ok(leaves.some((r) => r.lit) && leaves.some((r) => r.lines?.length && !r.lit), 'control: a lit leaf under a dark line, and an unlit one under a light line');
  for (const r of leaves) {
    for (const l of r.lines || []) {
      const onCanvas = rec.ops.find((op) => op.kind === 'rect' && op.style === l.rgb && op.rect.every((v, i) => Math.abs(v - [l.x, l.y, l.w, l.h][i]) < 0.011));
      const inSvg = rects.find(({ a }) => a.fill === l.rgb && close(a, [l.x, l.y, l.w, l.h]));
      assert.ok(onCanvas && inSvg, `${r.n.path}: its line at ${l.x},${l.y} ${l.w}×${l.h} is laid in ${l.rgb} on the canvas and in the SVG`);
    }
    // The highlight's white, a share of 0.18 as the tile's cushion is of the whole (60 px): the canvas's own stroke.
    const alpha = String(0.18 * Math.min(1, r.h / 60)).replace('.', '\\.');
    const lit = new RegExp(`<line x1="${(r.x + 1).toFixed(2)}" y1="${(r.y + 1.5).toFixed(2)}" x2="${(r.x + r.w - 1).toFixed(2)}" y2="${(r.y + 1.5).toFixed(2)}" stroke="rgba\\(255,255,255,${alpha}\\)"`).test(svg);
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
  // Each texture — a folder's over its own fill, a small leaf's over its cushion — its seams in the canvas's shade.
  const textured = painted.filter((r) => r.tex);
  assert.ok(textured.some((r) => r.frame) , 'control: a folder\'s fill carries a texture');
  for (const r of textured) {
    const seams = rects.filter(({ a }) => /^url\(#tm-t/.test(a.fill ?? '') && r.tex!.rects.some((box) => close(a, box)));
    assert.equal(seams.length, r.tex!.rects.length, `${r.n.path}: each seam of its texture is in the SVG`);
    const id = /^url\(#([\w-]+)\)$/.exec(seams[0].a.fill)![1];
    const stops = [...new RegExp(`<linearGradient id="${id}"[^>]*>([\\s\\S]*?)</linearGradient>`).exec(svg)![1].matchAll(/stop-color="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(stops, r.tex!.stops.map((c) => `rgb(${c.join(',')})`), `${r.n.path}: in the canvas's texture shade`);
    const under = rects.find(({ a }) => close(a, [r.x, r.y, r.w, r.h]) && /^url\(#tm-[cf]/.test(a.fill ?? ''))!;
    assert.ok(seams.every(({ at }) => at > under.at), `${r.n.path}: laid over its own fill, as on the canvas`);
  }
  // Every line and band, in the canvas's colours and in the canvas's order.
  const bandsOnCanvas = rec.ops.filter((op): op is Extract<Op, { kind: 'rect' }> => op.kind === 'rect' && typeof op.style === 'string' && rgba(op.style)[3] === 1 && /^rgb\(/.test(op.style))
    .map((op) => `${op.rect.map((v) => v.toFixed(2)).join(' ')} ${op.style}`);
  const bandsInSvg = rects.filter(({ a }) => /^rgb\(/.test(a.fill ?? '') && !('fill-opacity' in a)).map(({ a }) => `${['x', 'y', 'width', 'height'].map((k) => Number(a[k]).toFixed(2)).join(' ')} ${a.fill}`);
  assert.ok(bandsOnCanvas.length >= painted.filter((r) => r.frame).length * 4, `control: each folder's bands are on the canvas (${bandsOnCanvas.length})`);
  assert.deepEqual(bandsInSvg, bandsOnCanvas, 'the SVG lays the same lines and bands, in the same colours, in the same order');
});

test('the SVG export lays the map\'s ground under a staged block and a hollow online-only file in a folder with its own fill — after the folder\'s fill, before the cell\'s dashed outline, as the canvas clears each cell to its ground — so the folder\'s colour never claims space that is not there (review F1.9)', () => {
  const tiles = [
    { name: 'F', path: '/f', size: 3e10, type: 'dir', depth: 1, expanded: true, x: 0, y: 0, w: 60, h: 60 } as Tile,
    { name: 'Staged', path: '/f — freed', parentPath: '/f', size: 2e9, type: 'dir', depth: 2, expanded: false, freed: true, x: 5, y: 5, w: 20, h: 20 } as Tile,
    { name: 'cloud.mov', path: '/f/cloud.mov', size: 2e9, type: 'file', depth: 2, expanded: false, cloudPlaceholder: true, x: 30, y: 5, w: 20, h: 20 } as Tile,
  ];
  const { svg, px } = exportSvg(tiles, (n) => ramp.sizeRgb(n.size), '#0e0e13');
  const painted = px as Painted[];
  const f = painted.find((r) => r.n.path === '/f')!;
  assert.ok(f.bg, 'control: the folder has a fill of its own, which the SVG lays first');
  const rects = [...svg.matchAll(/<rect ([^>]*?)\/?>/g)].map((m) => ({ a: attrs(m[1]), at: m.index! }));
  const close = (a: Record<string, string>, box: number[], tol = 0.051) => ['x', 'y', 'width', 'height'].every((k, i) => Math.abs(Number(a[k]) - box[i]) < tol);
  const fFill = rects.find(({ a }) => /^url\(#tm-f/.test(a.fill ?? '') && close(a, [f.x, f.y, f.w, f.h]))!;
  assert.ok(fFill, 'control: the folder\'s fill is in the SVG');
  for (const path of ['/f — freed', '/f/cloud.mov']) {
    const c = painted.find((r) => r.n.path === path)!;
    const ground = rects.find(({ a }) => a.fill === '#0e0e13' && close(a, [c.x, c.y, c.w, c.h]) && a.stroke === undefined);
    assert.ok(ground, `${path}: a rectangle of the map's ground covers its whole box`);
    const dashed = rects.find(({ a }) => a['stroke-dasharray'] === '4 3' && close(a, [c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1], 0.11));
    assert.ok(dashed, `${path}: control — its dashed outline is in the SVG`);
    assert.ok(fFill.at < ground!.at && ground!.at < dashed!.at, `${path}: the ground is laid after the folder's fill and before the cell's dashed outline (${fFill.at} < ${ground!.at} < ${dashed!.at})`);
  }
});

/** One elliptical arc of an SVG path: where it starts and ends, its radii, and its large-arc and sweep flags. */
type Arc = { from: number[]; to: number[]; rx: number; ry: number; large: number; sweep: number };

/**
 * An SVG path's subpaths (M, L, H, V, A, Z, absolute), each as the points it passes through, the radii of its arcs, and
 * its arcs whole — each with its large-arc and sweep flags, which decide which way a corner curves (review F1.4).
 */
function subpaths(d: string) {
  const tokens = [...d.matchAll(/[MLHVAZ]|-?\d*\.?\d+(?:e-?\d+)?/gi)].map((m) => m[0]);
  const out: Array<{ pts: number[][]; radii: number[]; arcs: Arc[] }> = [];
  let pen = [0, 0];
  for (let i = 0; i < tokens.length;) {
    const cmd = tokens[i++];
    const num = () => Number(tokens[i++]);
    if (cmd === 'M') { pen = [num(), num()]; out.push({ pts: [pen], radii: [], arcs: [] }); }
    else if (cmd === 'L') { pen = [num(), num()]; out[out.length - 1].pts.push(pen); }
    else if (cmd === 'H') { pen = [num(), pen[1]]; out[out.length - 1].pts.push(pen); }
    else if (cmd === 'V') { pen = [pen[0], num()]; out[out.length - 1].pts.push(pen); }
    else if (cmd === 'A') {
      const rx = num(), ry = num();
      num(); // the x-axis rotation: nothing for a circle's arc
      const large = num(), sweep = num(), from = pen;
      pen = [num(), num()];
      out[out.length - 1].radii.push(rx, ry);
      out[out.length - 1].arcs.push({ from, to: pen, rx, ry, large, sweep });
      out[out.length - 1].pts.push(pen);
    }
    else if (cmd !== 'Z') assert.fail(`an unexpected path command ${cmd}`);
  }
  return out.map((s) => {
    const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]);
    return { box: [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)], radii: s.radii, arcs: s.arcs };
  });
}

/**
 * The centre of a quarter-circle arc between two points a radius apart on each axis, as SVG draws it: of the two
 * centres such an arc can have — (from.x, to.y) and (to.x, from.y) — the one about which it turns the way its sweep
 * flag says. With y pointing down, sweep 1 turns from +x toward +y: about its centre, from × to is positive.
 */
function quarterArcCentre(a: Arc): number[] {
  const turn = (c: number[]) => (a.from[0] - c[0]) * (a.to[1] - c[1]) - (a.from[1] - c[1]) * (a.to[0] - c[0]);
  const [c1, c2] = [[a.from[0], a.to[1]], [a.to[0], a.from[1]]];
  return (turn(c1) > 0) === (a.sweep === 1) ? c1 : c2;
}

test('owner\'s outlines: the SVG export\'s outlines and bands stop at its name tags, as the canvas\'s do — each tag clipped out of them by its own box and radius, its corners curving outward as the pill\'s do, and the tags and their names laid after, outside the clip (review F3.1, F1.4)', () => {
  // Two top-level folders big enough for a tag, each tiled by narrow strips whose outlines run under the tag, and a file.
  const tiles: Tile[] = [
    { name: 'Applications', path: '/r/Applications', size: 6e10, type: 'dir', depth: 1, expanded: true, x: 0, y: 0, w: 60, h: 60 },
    { name: 'Library', path: '/r/Library', size: 4e10, type: 'dir', depth: 1, expanded: true, x: 0, y: 60, w: 60, h: 40 },
    { name: 'big.bin', path: '/r/big.bin', size: 4e10, type: 'file', depth: 1, expanded: false, x: 60, y: 0, w: 40, h: 100 },
  ];
  for (const [f, y, h] of [['Applications', 0, 60], ['Library', 60, 40]] as const) {
    for (let k = 0; k < 12; k++) tiles.push({ name: `s${k}`, path: `/r/${f}/s${k}`, size: 5e9 - k * 1e8, type: 'file', depth: 2, expanded: false, x: k * 5, y, w: 5, h });
  }
  const { svg, px } = exportSvg(tiles, (n) => ramp.sizeRgb(n.size), '#0e0e13');
  const painted = px as Painted[];
  const rects = [...svg.matchAll(/<rect ([^>]*?)\/?>/g)].map((m) => ({ a: attrs(m[1]), at: m.index! }));
  const tags = rects.filter(({ a }) => a.fill === 'rgba(0,0,0,0.5)' && 'rx' in a);
  assert.equal(tags.length, 2, 'control: the SVG lays a name tag on each top-level folder big enough for one');
  // The clip: the map's whole rectangle, with each tag cut out of it by the even-odd rule.
  const clips = [...svg.matchAll(/<clipPath id="([\w-]+)">\s*<path ([^>]*?)\/?>\s*<\/clipPath>/g)];
  assert.equal(clips.length, 1, 'the SVG defines one clip for the lines');
  const [, id, pathAttrs] = clips[0];
  const p = attrs(pathAttrs);
  assert.equal(p['clip-rule'], 'evenodd', 'the tags are cut out of the map by the even-odd rule');
  const subs = subpaths(p.d);
  const near = (a: number[], b: number[], tol = 0.011) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < tol);
  assert.ok(near(subs[0].box, [0, 0, MAP_W, MAP_H]) && subs[0].radii.length === 0, `the clip's first shape is the whole map (${subs[0].box})`);
  assert.equal(subs.length, 1 + tags.length, 'and one more for each tag');
  for (const { a } of tags) {
    const box = ['x', 'y', 'width', 'height'].map((k) => Number(a[k]));
    const radius = Math.min(Number(a.rx), box[2] / 2, box[3] / 2);
    const cut = subs.slice(1).filter((s) => near(s.box, box));
    assert.equal(cut.length, 1, `the tag at ${box} is cut out of the clip by its own box`);
    assert.ok(cut[0].radii.length === 8 && cut[0].radii.every((r) => Math.abs(r - radius) < 0.011), `with the tag's own corner radius ${radius} (${cut[0].radii})`);
    // Each corner curves outward, as the pill's own corners do (review F1.4): a quarter circle (not three quarters)
    // whose centre lies a radius inside the tag at that corner. A corner curved inward has its centre on the box's
    // corner itself, and leaves a notch under the pill where the lines show.
    const [bx, by, bw, bh] = box;
    const insetCorners = [[bx + radius, by + radius], [bx + bw - radius, by + radius], [bx + bw - radius, by + bh - radius], [bx + radius, by + bh - radius]];
    const centres = cut[0].arcs.map(quarterArcCentre);
    assert.deepEqual(cut[0].arcs.map((a) => a.large), [0, 0, 0, 0], `the tag at ${box}: each corner is a quarter circle (large-arc flag 0)`);
    assert.ok(insetCorners.every((c) => centres.some((q) => near(q, c))),
      `the tag at ${box}: each corner curves outward, about a centre a radius ${radius} inside it — centres ${centres.map((q) => q.map(fmt).join(',')).join('; ')}, want ${insetCorners.map((q) => q.map(fmt).join(',')).join('; ')}`);
  }
  // What the clip holds: every leaf outline and every band, and nothing else; the tags and their names come after it.
  const open = svg.indexOf(`<g clip-path="url(#${id})">`), close = svg.indexOf('</g>', open);
  assert.ok(open > 0 && close > open, 'the lines are drawn in a group under the clip');
  const outlines = rects.filter(({ a }) => painted.some((r) => (r.lines || []).some((l) => l.rgb === a.fill && Math.abs(l.x - Number(a.x)) < 0.011 && Math.abs(l.y - Number(a.y)) < 0.011)));
  const bands = rects.filter(({ a }) => painted.some((r) => (r.bands || []).some((b) => b.rgb === a.fill && Math.abs(b.x - Number(a.x)) < 0.011 && Math.abs(b.y - Number(a.y)) < 0.011)));
  assert.ok(outlines.length >= 20 && bands.length >= 8, `control: the leaves' outlines (${outlines.length}) and the folders' bands (${bands.length}) are in the SVG`);
  const within = (at: number) => at > open && at < close;
  assert.deepEqual([...outlines, ...bands].filter(({ at }) => !within(at)).map(({ a }) => a.stroke ?? a.fill), [], 'every outline and band is under the clip');
  assert.equal(rects.filter(({ at }) => within(at)).length, outlines.length + bands.length, 'and nothing else is');
  assert.ok(tags.every(({ at }) => at > close), 'the tags are laid after the clipped lines, outside the clip');
  assert.ok([...svg.matchAll(/<text [^>]*font-weight="600"[^>]*>/g)].every((m) => m.index! > close), 'and so are their names');
});
