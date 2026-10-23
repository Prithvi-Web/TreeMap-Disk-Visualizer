import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { buildTreemap } from '../../src/utils/treemap';
import type { FileNode } from '../../src/models/types';

/**
 * The map painter's test harness, shared by tests/mapColourPop.test.ts and the sweeps split from it (BQV): the real
 * painter cut out of the built page and run (load), a recording 2D context and a rasterizing one (recordingCtx,
 * rasterCtx), the one painter every raster paint shares (rasterPaint), the theme grounds, colour science, the colours
 * the map paints, the maps the tests paint, and the oracles that measure a raster (measureEdges, partings, tileLook).
 * Moved here from mapColourPop.test.ts as they were, an export in front of each: CI runs every test file under a
 * 20-minute limit, and that file's sweeps had grown past it on CI's Windows runner. It loads no test of its own.
 */

export const INDEX = readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

/* ─────────────────────────── slicing and running the page ─────────────────────────── */

/** `function name(…) {…}`, `const name = {…};` (brace matched) or `const|let NAME = value;`. */
export function declSource(name: string): string {
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
export const DECLS = new Map<string, string>();
export const declOnce = (name: string) => { if (!DECLS.has(name)) DECLS.set(name, declSource(name)); return DECLS.get(name)!; };
/** The helpers each set of names turned out to need, by the names, the dependencies and the returns: found once, then reused. */
export const PULLED = new Map<string, string[]>();
export function load<T>(names: string[], deps: Record<string, unknown>, returns: string, run?: (fn: T) => void): T {
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

export type Grad = { kind: 'linear'; args: number[]; stops: Array<[number, string]> };
export type Text = { text: string; x: number; y: number; fillStyle: unknown; font: string };

/** `style` as drawn under `globalAlpha`: a gradient's stops, or a colour, with the alpha multiplied in. */
export function withAlpha(style: unknown, globalAlpha: number): unknown {
  if (globalAlpha === 1 || globalAlpha === undefined || Number.isNaN(globalAlpha)) return style;
  const scale = (c: string) => { const [r, g, b, a] = rgba(c); return `rgba(${r},${g},${b},${a * globalAlpha})`; };
  if (style && typeof style === 'object' && (style as Grad).stops) {
    const g = style as Grad;
    return { ...g, stops: g.stops.map(([o, c]) => [o, scale(c)]) };
  }
  return typeof style === 'string' && /^(#|rgb)/i.test(style) ? scale(style) : style;
}

export type Stroke = { style: string; width: number; rect: number[] };
/** One straight segment of a stroked path, as [x0, y0, x1, y1], in the paint it was stroked in. */
export type Line = { style: string; width: number; seg: number[] };
/** One rectangle filled, or one text written, in the order the painter did it. */
export type Op = { kind: 'rect'; style: unknown; rect: number[] } | { kind: 'text'; text: Text };

/**
 * A 2D context that records every fill, every text and every stroked
 * rectangle with the paint it was drawn in — and, in `ops`, every filled
 * rectangle and text in drawing order, so what lies under a label can be
 * replayed (canvasAt).
 */
export function recordingCtx() {
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

export const SHEET = (() => {
  const open = INDEX.indexOf('<style>');
  return INDEX.slice(open + '<style>'.length, INDEX.indexOf('</style>', open)).replace(/\/\*[\s\S]*?\*\//g, ' ');
})();
export function tokens(selector: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of SHEET.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (!selector.test(m[1].trim())) continue;
    for (const d of m[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  }
  return out;
}
export const DARK = tokens(/^:root$/);
export const LIGHT = { ...DARK, ...tokens(/^:root\[data-theme="light"\]$/) };

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];
export function rgba(value: string): RGBA {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return [...[0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)), 1] as RGBA;
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(v);
  assert.ok(fn, `colour "${value}" is a hex or rgb()/rgba()`);
  return [+fn![1], +fn![2], +fn![3], fn![4] === undefined ? 1 : +fn![4]];
}
export function over(fg: RGBA, bg: RGB): RGB {
  return [0, 1, 2].map((i) => fg[3] * fg[i] + (1 - fg[3]) * bg[i]) as RGB;
}
/** What a cleared canvas pixel shows: the map's glass card over the page. */
export function cardGround(palette: Record<string, string>): RGB {
  const page = rgba(palette['--bg-1']).slice(0, 3) as RGB;
  return over(rgba(palette['--glass']), page);
}

/* ─────────────────────────── colour science ─────────────────────────── */

export const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
export function luminance([r, g, b]: RGB): number { return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
export function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** CIE L*, C*ab under D65. */
export function lab([r8, g8, b8]: RGB): { L: number; C: number } {
  const r = lin(r8), g = lin(g8), b = lin(b8);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const L = 116 * f(Y) - 16;
  return { L, C: Math.hypot(500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))) };
}
/** lab(c).L for the colour whose luminance(c) is `Y`: the same arithmetic, without a and b. */
export function lstarOfY(Y: number): number {
  return 116 * (Y > 216 / 24389 ? Math.cbrt(Y) : (24389 / 27 * Y + 16) / 116) - 16;
}
export const lerp = (a: RGB, b: RGB, t: number) => a.map((v, i) => v + (b[i] - v) * t) as RGB;
export const fmt = (n: number) => n.toFixed(2);

/* ─────────────────────────── the ramp, from the page ─────────────────────────── */

export const ramp = load<{ sizeRgb: (b: number) => RGB; lo: number; hi: number }>(
  ['sizeRgb'], {}, '{ sizeRgb, lo: TIER_LO, hi: TIER_HI }', (r) => { r.sizeRgb(1e9); });
/** Ramp steps: 21 sizes spread evenly over the key's log domain, 1 MB … 10 GB. */
export const STEPS = Array.from({ length: 21 }, (_, k) => {
  const t = k / 20;
  return { t, bytes: 10 ** (ramp.lo + t * (ramp.hi - ramp.lo)) };
});

/* ─────────────────────────── painting a map ─────────────────────────── */

export type Tile = { name: string; path: string; size: number; type: string; depth: number; expanded: boolean; x: number; y: number; w: number; h: number };

export const MAP_W = 1000, MAP_H = 1000;

/** A leaf `h` px tall at `depth`, coloured by `bytes`, in its own column of the map. */
export function tile(i: number, depth: number, bytes: number, h = 200): Tile {
  const col = i % 40, row = Math.floor(i / 40);
  return {
    name: `f${i}.bin`, path: `/r/f${i}.bin`, size: bytes, type: 'file', depth, expanded: false,
    x: col * 2.5, y: row * 25, w: 2.4, h: (h / MAP_H) * 100,
  };
}

/** The gradient's colour at offset `t` (0 top, 1 bottom), composited over `ground`. */
export function at(g: Grad, t: number, ground: RGB): RGB {
  const stops = [...g.stops].sort((a, b) => a[0] - b[0]);
  const lo = stops.filter(([o]) => o <= t).pop() ?? stops[0];
  const hi = stops.find(([o]) => o >= t) ?? stops[stops.length - 1];
  const a = over(rgba(lo[1]), ground), b = over(rgba(hi[1]), ground);
  return hi[0] === lo[0] ? a : lerp(a, b, (t - lo[0]) / (hi[0] - lo[0]));
}
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
export const OTHER_COLOURS: Array<{ name: string; rgb: RGB }> = (() => {
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

export const DIFF_PAGE = load<{ diffRgb: (n: object) => RGB }>(['diffRgb'], {}, '{ diffRgb }', (c) => {
  for (const prevSize of [5e9, 1e9, 2e10, null]) c.diffRgb({ size: 5e9, prevSize });
});
/** Each node's History diff colour, fixed by its path so that it outlives withoutPrev. */
export function colourOf(nodes: Tile[]): (n: Tile) => RGB {
  const byPath = new Map(nodes.map((n) => [n.path, DIFF_PAGE.diffRgb(n)]));
  return (n) => byPath.get(n.path)!;
}
/** WCAG's bar for a non-text edge, and the owner's. */
export const EDGE_BAR = 3;

/**
 * The staged block's hatch as the page's tmHatchPattern builds it (review F2.2): an 8×8 tile with two
 * strokes 1.6 px wide in --warn, from (-2, 10) to (10, -2) and from (-2, 18) to (18, -2) — the lines
 * x + y = 8 and x + y = 16 — repeated from the canvas's origin and scaled by its transform. `cover` is how
 * much of each of the tile's 64 pixels the strokes cover, sampled 8×8 within the pixel.
 */
export type Hatch = { kind: 'hatch'; ink: string; cover: number[] };
export function hatchOf(ink: string): Hatch {
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
export function rasterCtx(W: number, H: number, ground: RGB) {
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
    /** The device pixels themselves, r, g, b each — to hold two rasters to each other byte for byte. */
    pixels: () => px,
    /** The share of each device pixel a name tag covers. */
    tags: () => tag,
  };
}

export type Band = { x: number; y: number; w: number; h: number; rgb: string };
/** A rectangle as drawTreemap leaves it in pxRects, with what it recorded painting it. */
export type Texture = { stops: RGB[]; rects: number[][] };
export type Painted = { n: Tile; x: number; y: number; w: number; h: number; frame: boolean; lines?: Band[]; lit?: boolean; stops?: RGB[]; fillRgb?: RGB; bg?: RGB[]; bands?: Band[]; tex?: Texture; lw?: number; seen?: RGB[]; litSeen?: RGB; dashes?: number[][] };

/**
 * `tiles` painted by the real drawTreemap onto a `W`×`H` css px map in `palette`'s theme, at device pixel ratio `dpr`: a raster of the device's pixels,
 * as many across and down as the painter made its canvas (review F2.1 of BQJ-2c-r: a raster sized here apart from the
 * canvas could not see the map run past it).
 * With everything the real map lays over the tiles that bears on its lines (review F2.2): a staged block's
 * amber hatch, as tmHatchPattern builds it (hatchOf), and each top-level folder's name tag, the half-black
 * rounded pill pass 3 fills (the page's roundRect, a rounded rectangle path). They were stubbed out, so the
 * hatch's amber was never beside a band, and the pills never over a line.
 *
 * With `bare` (lineCalls of the same map), the map as it would be with no leaf outline, no folder band and no
 * name tag drawn: what a name tag should lie over (review F3.1). With `bareKeepsTags` too, the name tags are laid
 * all the same: the map without the calls `bare` names alone.
 *
 * Every raster paint of the file is laid by one painter, compiled at the first (rasterPainter): compiled afresh for
 * each paint, as it was, the "no hard step" sweep on every colour alone took 269 to 348 s of the file's 784 to 851 s on
 * Node 20, the version CI runs, which projected the file past CI's 20-minute limit a file on its Windows runner (about 1.6
 * times as slow). Shared, the file took 488 s. What a compiled painter carries from one paint to the next is
 * its answers kept — the tone memo (TM_TONE_MEMO) and the luminances (tmLumCache), each a function of its question
 * alone — so it lays every raster byte for byte as a painter compiled for that paint alone lays it, which a test below
 * holds it to (rasterPaintFresh). The tests of the memo's own bounds compile painters of their own (dragPainter).
 */
export function rasterPaint(tiles: Tile[], palette: Record<string, string>, W: number, H: number,
  colour: (n: Tile) => RGB = (n) => ramp.sizeRgb(n.size), history = { active: false, diff: false }, hideCloud = false, dpr = 1, bare?: Set<string>, bareKeepsTags = false) {
  const call = { tiles, palette, W, H, colour, history, hideCloud, dpr };
  for (let again = false; ; again = true) {
    SHARED_PAINTER ??= rasterPainter(call);
    try {
      return rasterLay(SHARED_PAINTER, call, bare, bareKeepsTags);
    } catch (e) {
      // A helper this paint reaches that no paint before it did (a hatch, a hollow cell, a wash): the painter is
      // compiled again, its helpers resolved on this paint, and the paint laid afresh on a raster of its own.
      if (again || (e as Error).name !== 'ReferenceError') throw e;
      SHARED_PAINTER = null;
    }
  }
}

/** What a raster paint asks the painter for: the map, its css size and device pixel ratio, its theme and its colouring. */
export type RasterCall = { tiles: Tile[]; palette: Record<string, string>; W: number; H: number; colour: (n: Tile) => RGB; history: { active: boolean; diff: boolean }; hideCloud: boolean; dpr: number };
/** The real drawTreemap, compiled, with the page it reads: the paint it is asked for (`call`) and the context it lays on (`onto`). */
export type RasterPainter = {
  call: RasterCall; onto: () => any; draw: () => void; busy: boolean;
  state: { treemap: { pxRects?: unknown } }; canvas: { style: Record<string, string>; width: number; height: number }; buffer: { width: number; height: number };
};
/** The one painter every rasterPaint lays with, compiled at the first. */
export let SHARED_PAINTER: RasterPainter | null = null;
export const treemapState = (c: RasterCall) => ({ nodes: c.tiles, hideCloud: c.hideCloud, rootSize: 1e12, history: c.history, pxRects: [] as Painted[], colorMode: 'size', mode: 'treemap', query: '' });

/**
 * The real drawTreemap compiled, its page read through `p.call` and `p.onto` at each paint. Resolving its helpers runs
 * the painter on `call`, once per helper it turns out to need, each run stopping where a helper is missing — on a
 * context that keeps what a run left (a clip, a save) that would carry into the next. So they are resolved on a
 * recording context, and the grid gets clean paints of its own from the painter they resolved.
 */
export function rasterPainter(call: RasterCall): RasterPainter {
  const resolving = recordingCtx().ctx;
  const p: RasterPainter = { call, onto: () => resolving, draw: () => {}, busy: false, state: { treemap: treemapState(call) }, canvas: { style: {}, width: 0, height: 0 }, buffer: { width: 0, height: 0 } };
  const deps = {
    $: () => ({ clientWidth: p.call.W + 20 }), treemapCanvasHeight: () => p.call.H, window: { get devicePixelRatio() { return p.call.dpr; } },
    tmCanvas: p.canvas, tmBuffer: p.buffer,
    tmBufCtx: new Proxy({}, { get: (_t, k: string) => p.onto()[k], set: (_t, k: string, v) => { p.onto()[k] = v; return true; } }),
    cssVar: (name: string) => p.call.palette[name] ?? 'rgba(0,0,0,0)',
    state: p.state, tmNodeCapNote: () => '', renderAltNote() {}, tmSetEmpty() {}, renderSearchOverlay() {}, presentTreemap() {}, renderTmLegend() {},
    cellRgb: (n: Tile) => p.call.colour(n), tmPreview: { on: false },
    // The page's fallback ink, as tmHatchPattern has it.
    tmHatchPattern: () => hatchOf(p.call.palette['--warn'] || '#FF9F0A'),
    roundRect: (c: { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }, x: number, y: number, w: number, h: number, r: number) => c.roundRect(x, y, w, h, r),
    formatBytes: (n: number) => `${Math.round(n)} B`,
  };
  p.draw = load<() => void>(['drawTreemap'], deps, 'drawTreemap', (d) => d());
  return p;
}

/** `call` laid by the painter `p` onto a raster of the canvas it sizes for it (rasterPaint). */
export function rasterLay(p: RasterPainter, call: RasterCall, bare?: Set<string>, bareKeepsTags = false) {
  if (p.busy) throw new Error('a raster paint was started inside another, on the painter that is laying it');
  p.call = call;
  p.state.treemap = treemapState(call);
  // The grid is the canvas the painter sized — made when the paint first reaches for its context, which drawTreemap
  // does once it has sized its canvas (held below) — and starts as the card the canvas sits on, what a cleared pixel
  // shows; the painter lays the theme's --tm-canvas-bg over it, as on screen: so what the page reckons its ground to
  // be is measured too.
  let raster: ReturnType<typeof rasterCtx> | null = null;
  let grid: any = null;
  const open = () => {
    raster = rasterCtx(p.canvas.width, p.canvas.height, cardGround(call.palette));
    grid = !bare ? raster.ctx : new Proxy(raster.ctx, {
      get(t, k: string) {
        if (k === 'strokeRect' || k === 'fillRect') {
          return (...a: number[]) => { if (!bare.has([k, k === 'strokeRect' ? t.strokeStyle : t.fillStyle, ...a].join('|'))) t[k](...a); };
        }
        if (k === 'fill' && !bareKeepsTags) return () => {}; // the name tags, the only shapes this raster fills
        return t[k];
      },
      set(t, k: string, v) { t[k] = v; return true; },
    });
    return grid;
  };
  p.onto = () => grid ?? open();
  p.busy = true;
  try { p.draw(); } finally { p.busy = false; }
  const r = (raster ?? (open(), raster)) as unknown as ReturnType<typeof rasterCtx>;
  assert.deepEqual([p.canvas.width, p.canvas.height, p.buffer.width, p.buffer.height], [r.W, r.H, r.W, r.H],
    `the raster is the canvas the painter sized for this paint, ${call.W}×${call.H} css px at ${call.dpr}: it sized it only after it began laying`);
  return { raster: r, px: p.state.treemap.pxRects as Painted[] };
}

/**
 * How many device pixels a line or band `px` painter's px wide takes at device pixel ratio `dpr`: under a ratio of 1, `px`
 * (the painter's px is a device pixel, review F3.6); from 1 up, the most whole device pixels no wider than `px` css px,
 * and never none — at 150 % a 1 px line is one device pixel and a 3 px band four, at 175 % one and five (residual 4).
 */
export const devicePx = (px: number, dpr: number) => (dpr < 1 ? px : Math.max(1, Math.floor(px * dpr + 1e-9)));
/** A leaf's line in css px at device pixel ratio `dpr`: one painter's px, a whole number of device pixels (devicePx). */
export const lineCss = (dpr: number) => devicePx(1, dpr) / dpr;
/** A leaf the owner's rule gives lines of its own: 8 px or more on each side. Under it, a texture. */
export const OUTLINED_PX = 8;
/**
 * The band a folder is framed by, as the owner's refinement has it (20 Oct 2026): by the folder's thinner side and
 * depth — 3 px for a top-level folder 96 px or more across, 2 px from 64 px (nested too), 1 px from 8 px, and none under
 * 8 px — in css px at device pixel ratio `dpr`, a whole number of device pixels wide (devicePx: at 150 % a 1 px band is one
 * device pixel, residual 4), and under a ratio of 1 in device pixels, sizes and widths (review F3.6). (2 px came from 32 px,
 * 48 px nested, until corpus/Mail — 58×52 px in the corpus map — stood at 39.5% band, its own 2 px band a fifth of that:
 * residual 9.)
 */
export const bandStep = (m: number, depth: number) => (m < OUTLINED_PX ? 0 : depth <= 1 && m >= 96 ? 3 : m >= 64 ? 2 : 1);
/** A painted rectangle on whole pixels (the painter lays them there; a painter that did not is measured where its rectangles round to). */
export const whole = (r: Painted): Painted => ({ ...r, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.x + r.w) - Math.round(r.x), h: Math.round(r.y + r.h) - Math.round(r.y) });

/** Which side of the box `r` the line `l` lies along: the one it runs beside, nearest. */
export function sideOf(l: Band, r: { x: number; y: number; w: number; h: number }): 'top' | 'bottom' | 'left' | 'right' {
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
 * a line, where lines meet lines. A line under a device pixel across — under a ratio of 1 a 1 css px line is part of
 * one — is measured on the pixel it covers most, blended with its tile as the screen shows it; it was left out, so a
 * test at such a ratio measured nothing (review F3.6). Where a line laid after it covers the line's whole pixel in part —
 * at 175 % a folder's 1 px band laid over a nested folder's a device pixel from it — the line shows on two pixels beside
 * the tile, each blended: its whole pixel with the later line, and the pixel it covers in part with the tile. Given the
 * `raster`, the one of the two that stands out more from the tile is measured; where neither does, the line is lost there.
 */
export function edgesOf(painted: Painted[], W: number, H: number, dpr = 1, raster?: ReturnType<typeof rasterCtx>) {
  // 1: a pixel a line covers whole; 2: one it covers only in part.
  const map = new Uint8Array(W * H);
  // The last line laid that touches each pixel, in the order passes 2.6 and 2.7 lay them (-1: none).
  const top = new Int32Array(W * H).fill(-1);
  const extent = (x: number, y: number, w: number, h: number) => ({ x0: x * dpr, y0: y * dpr, x1: (x + w) * dpr, y1: (y + h) * dpr });
  const mark = (x: number, y: number, w: number, h: number, order = -1) => {
    const e = extent(x, y, w, h);
    for (let yy = Math.max(0, Math.floor(e.y0 + 1e-9)); yy < Math.min(H, Math.ceil(e.y1 - 1e-9)); yy++) {
      for (let xx = Math.max(0, Math.floor(e.x0 + 1e-9)); xx < Math.min(W, Math.ceil(e.x1 - 1e-9)); xx++) {
        const full = xx >= e.x0 - 1e-9 && xx + 1 <= e.x1 + 1e-9 && yy >= e.y0 - 1e-9 && yy + 1 <= e.y1 + 1e-9;
        const i = yy * W + xx;
        map[i] = map[i] === 1 || full ? 1 : 2;
        top[i] = Math.max(top[i], order);
      }
    }
  };
  const lines: Array<{ l: Band; kind: 'leaf' | 'frame'; r: Painted; order: number }> = [];
  for (const r of painted) for (const l of r.lines || []) lines.push({ l, kind: 'leaf', r, order: lines.length });
  for (const r of painted.filter((p) => p.frame).sort((a, b) => b.n.depth - a.n.depth)) for (const l of r.bands || []) lines.push({ l, kind: 'frame', r, order: lines.length });
  for (const { l, order } of lines) mark(l.x, l.y, l.w, l.h, order);
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
  const skip = Math.ceil(2 * Math.max(1, dpr));
  for (const { l, kind, r, order } of lines) {
    // The line's whole device pixels.
    const e = extent(l.x, l.y, l.w, l.h);
    let x0 = Math.ceil(e.x0 - 1e-9), x1 = Math.floor(e.x1 + 1e-9) - 1, y0 = Math.ceil(e.y0 - 1e-9), y1 = Math.floor(e.y1 + 1e-9) - 1;
    // Under a device pixel across: measured on the pixel it covers most. A device pixel or more across that holds no whole
    // pixel (the inner part of a line laid in two parts, at 125 %) lies against the part beside it: lines meet lines.
    if (x1 < x0) { if (e.x1 - e.x0 >= 1 - 1e-9) continue; x0 = x1 = Math.floor((e.x0 + e.x1) / 2); }
    if (y1 < y0) { if (e.y1 - e.y0 >= 1 - 1e-9) continue; y0 = y1 = Math.floor((e.y0 + e.y1) / 2); }
    const what = kind === 'leaf'
      ? `${r.n.path} (${Math.round(r.w * dpr)}×${Math.round(r.h * dpr)} px), ${sideOf(l, r)} side`
      : `folder ${r.n.path} (depth ${r.n.depth}), ${sideOf(l, r)} band`;
    // Past at most one pixel a line covers in part — the one a 1 px line leaves at 125–175 % — to the tile; a second
    // such pixel is another line's edge, where lines meet lines.
    const step = (x: number, y: number, dx: number, dy: number) => {
      let tx = x + dx, ty = y + dy, lx = x, ly = y;
      let px: [number, number] | null = null;
      if (isPart(tx, ty)) {
        // A line laid after this one covers its whole pixel in part: the line shows on its partial pixel too.
        if (top[y * W + x] > order) px = [tx, ty];
        tx += dx; ty += dy;
      }
      if (!isTile(tx, ty)) return;
      if (px && raster && contrast(raster.at(...px), raster.at(tx, ty)) > contrast(raster.at(x, y), raster.at(tx, ty))) [lx, ly] = px;
      out.push({ line: [lx, ly], tile: [tx, ty], what, kind, r });
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
export function partings(raster: ReturnType<typeof rasterCtx>, painted: Painted[], dpr = 1, bar = EDGE_BAR) {
  // OUTLINED_PX and up on the device's pixels, as the painter takes the step (review F1.1): at 150 % a snapped width can
  // fall a hair under 8 css px. Under a ratio of 1 the step is 8 device px (review F3.6).
  const lined = (r: Painted) => Math.min(Math.round(r.w * dpr), Math.round(r.h * dpr)) >= OUTLINED_PX * Math.max(1, dpr);
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
  const skip = Math.ceil(4 * Math.max(1, dpr));
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
        const near = (p: [number, number], dir: number) => Array.from({ length: Math.ceil(2 * Math.max(1, dpr)) }, (_, k) => [p[0] + dir * ox * k, p[1] + dir * oy * k] as [number, number]);
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
export function measureEdges(raster: ReturnType<typeof rasterCtx>, px: Painted[], dpr = 1) {
  const all = edgesOf(px, raster.W, raster.H, dpr, raster);
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
export function colourBlocks(colours: Array<{ name: string; rgb: RGB; prev?: (s: number) => number | null }>, lw: number, lh: number) {
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

export const RAMP_COLOURS = STEPS.map((s) => ({ name: `size ramp ${s.t}`, rgb: ramp.sizeRgb(s.bytes) }));
export const EVERY_COLOUR = [...RAMP_COLOURS, ...OTHER_COLOURS, { name: 'the Trash cell', rgb: [108, 122, 137] as RGB }];
/**
 * A deterministic stand-in for the dense corner of /System/Library, laid out by the server's own
 * buildTreemap at the page's own floor (4,000 bytes) and Depth 4: nine top folders of three to seven
 * folders, each of two to six folders of 4 KB–600 KB files (and some under the floor), one in twelve
 * holding nothing over the floor (J51). On a 640×400 map about half its 1,750 leaves are 4–16 px a side.
 */
export function realisticNodes(): Tile[] {
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
export const REAL_W = 640, REAL_H = 400;
/** A uniform grid of `n`×`n` leaves `s` px square, each `bytes` big, filling a map of its own at the top level. */
export function uniformGrid(s: number, n: number, bytes: number) {
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
 * and the solid fill's own mean L* (`L`) — the solid fill being the cushion painted, or with `solidOf` the cushion the
 * tile's own colour gets with nothing on it (a leaf with lines is filled a shade lighter or darker, residual 3); and
 * without the device pixels `skip` takes (a folder's band laid over the leaf's edge). And `ink`: the share of their area a line or a texture covers as the raster shows
 * it — each pixel counted by how far it lies from the fill toward the shade the tile's lines (r.lines) or texture (r.tex)
 * were laid in on its row, 0 to 1 — so a device pixel a 1 px line covers by half, at 150 %, counts a half: the same share at
 * every device pixel ratio, where `apart` counts that pixel whole. And `moved`: the mean CIE L* of the cushion painted
 * less that of the one measured against — with `solidOf`, how far the painter moved the tile's fill from its colour.
 */
export function tileLook(raster: ReturnType<typeof rasterCtx>, px: Painted[], inBox: (r: Painted) => boolean, dpr = 1, solidOf?: (r: Painted) => RGB[], skip?: (x: number, y: number) => boolean) {
  let total = 0, apart = 0, black = 0, sum = 0, solid = 0, dL = 0, L = 0, strongest = 1, ink = 0, moved = 0;
  for (const r of px) {
    if (r.frame || !r.stops || !inBox(r)) continue;
    const darker = luminance(r.fillRgb!) >= 0.18;
    const lineShades = [...new Set((r.lines || []).map((l) => l.rgb))].map((c) => rgba(c).slice(0, 3) as RGB);
    const x0 = Math.round(r.x * dpr), y0 = Math.round(r.y * dpr), x1 = Math.round((r.x + r.w) * dpr), y1 = Math.round((r.y + r.h) * dpr);
    // What the lightness is measured against: the cushion as painted, or as the tile's own colour would be painted solid.
    const own = solidOf ? solidOf(r) : r.stops;
    for (let y = y0; y < y1; y++) {
      const t = Math.max(0, Math.min(1, ((y + 0.5) / dpr - r.y) / r.h));
      const fill = lerp(r.stops[0], r.stops[1], t), ref = lerp(own[0], own[1], t);
      const shades = r.tex ? [...lineShades, lerp(r.tex.stops[0] as RGB, r.tex.stops[1] as RGB, t)] : lineShades;
      // What holds along the row, found once — the fill's and the reference's luminance and L*, each shade's step from
      // the fill — and each pixel's luminance once: every sum is as it was, bit for bit, at a third of the cost, so the
      // "no hard step" sweep can measure every colour the map paints (review F2.1).
      const yFill = luminance(fill), yRef = luminance(ref), lRef = lab(ref).L, lFill = lab(fill as RGB).L;
      const steps = shades.map((sh) => { const d = sh.map((v, i) => v - fill[i]); return { d, n: d.reduce((a, v) => a + v * v, 0) }; });
      for (let x = x0; x < x1; x++) {
        if (skip && skip(x, y)) continue;
        const p = raster.at(x, y), yp = luminance(p), c = (Math.max(yp, yFill) + 0.05) / (Math.min(yp, yFill) + 0.05);
        total++;
        if (c > 1.05 && (yp < yFill) === darker) apart++;
        strongest = Math.max(strongest, c);
        if (yp < 0.03) black++;
        sum += yp; solid += yRef; dL += lstarOfY(yp) - lRef; L += lRef; moved += lFill - lRef;
        // How far p lies from the fill toward a shade, along the line between them: the share of the pixel that shade covers.
        let k = 0;
        for (const { d, n } of steps) {
          if (n > 0) k = Math.max(k, Math.min(1, d.reduce((a, v, i) => a + v * (p[i] - fill[i]), 0) / n));
        }
        ink += k;
      }
    }
  }
  return { total, apart: apart / total, strongest, black: black / total, mean: sum / solid, dL: dL / total, L: L / total, ink: ink / total, moved: moved / total };
}

/** The page's tmLeafStops: the cushion a leaf of colour `base`, `h` css px tall, is painted with — solid, with nothing on it. */
export const LEAF_STOPS = load<(base: RGB, h: number, lines: null) => RGB[]>(['tmLeafStops'], {}, 'tmLeafStops', (f) => { f([100, 100, 100], 20, null); });
/** Three colours of the size ramp — a 2 MB file's green, a 400 MB file's amber, a 6 GB file's red — and two of the other colourings. */
export const TAPER_COLOURS: Array<{ name: string; rgb: RGB }> = [
  { name: 'size ramp 2 MB', rgb: ramp.sizeRgb(2e6) },
  { name: 'size ramp 400 MB', rgb: ramp.sizeRgb(4e8) },
  { name: 'size ramp 6 GB', rgb: ramp.sizeRgb(6e9) },
  ...OTHER_COLOURS.filter((c) => c.name === 'Reclaim not scored' || c.name === 'Age band C_ORANGE'),
];

/**
 * The "no hard step at 8 px" checks on colour `c` at device pixel ratio `dpr` in `theme` (painted with `palette`): uniform
 * 9×9 grids of tiles 1 to 18 px, their middle 7×7 measured (tileLook) — the seams' share of the pixels from 5 px, the mean
 * lightness against the tile's own solid colour from 3 px, under 2 L* a step, and the shade a textured leaf is filled
 * with, under 2 L* a size up to 7 px. The tests below say why each bound is what it is.
 */
export function assertNoHardStep(theme: string, palette: Record<string, string>, c: { name: string; rgb: RGB }, dpr: number) {
  const looks: Array<ReturnType<typeof tileLook> & { s: number }> = [];
  for (let s = 1; s <= 18; s++) {
    const n = 9, g = uniformGrid(s * Math.max(1, 1 / dpr), n, 4e8);
    const { raster, px } = rasterPaint(g.tiles, palette, g.W, g.H, () => c.rgb, undefined, false, dpr);
    // The middle tiles: the outer ring meets the map's edge.
    const inner = (r: Painted) => { const [i, j] = /g(\d+)\.(\d+)$/.exec(r.n.path)!.slice(1).map(Number); return i > 0 && j > 0 && i < n - 1 && j < n - 1; };
    looks.push({ s, ...tileLook(raster, px, inner, dpr, (r) => LEAF_STOPS(c.rgb, r.h, null)) });
  }
  const where = `${theme}, ${c.name}, dpr ${dpr}`;
  const table = looks.map((l) => `${l.s}px ${(l.apart * 100).toFixed(1)}% (ink ${(l.ink * 100).toFixed(1)}%) ${l.dL.toFixed(1)}L* (fill ${l.moved.toFixed(1)})`).join(', ');
  // A seam's width in painter's px: a texture's one, a line's a whole number of device pixels (lineCss).
  const seam = (s: number) => (s >= OUTLINED_PX && dpr >= 1 ? lineCss(dpr) : 1);
  for (const l of looks) {
    if (l.s < 5) continue;
    const want = 1 - ((l.s - seam(l.s)) / l.s) ** 2;
    if (Number.isInteger(dpr)) assert.ok(Math.abs(l.apart - want) < 0.02, `${where}: ${l.s} px tiles — one 1 px seam each, ${(l.apart * 100).toFixed(1)}% of their pixels (${table})`);
    assert.ok(Math.abs(l.ink - want) < 0.015, `${where}: ${l.s} px tiles — one 1 px seam each, covering ${(l.ink * 100).toFixed(1)}% of their area, where one covers ${(want * 100).toFixed(1)}% (${table})`);
  }
  for (let k = 1; k < looks.length; k++) {
    const a = looks[k - 1], b = looks[k];
    if (b.s < OUTLINED_PX) {
      const moved = Math.abs(b.moved - a.moved);
      assert.ok(moved <= 2, `${where}: from ${a.s} to ${b.s} px the shade a textured leaf is filled with moves ${moved.toFixed(1)} L*, over 2 — ${table}`);
    }
    if (a.s < 3) continue;
    if (a.s >= 5) {
      const step = Math.abs(b.ink - a.ink), before = a.s > 5 ? Math.abs(a.ink - looks[k - 2].ink) : Infinity;
      // (Where the line is thinner than the texture's seam, its share steps down at 8 px: the lightness is held there all the same.)
      if (!(b.s === OUTLINED_PX && seam(OUTLINED_PX) < 1 - 1e-9)) {
        assert.ok(step <= before + 0.005, `${where}: from ${a.s} to ${b.s} px the seams' share steps ${(step * 100).toFixed(1)} points, more than the step before it (${(before * 100).toFixed(1)}) — ${table}`);
      }
    }
    const dL = Math.abs(b.dL - a.dL), bound = 2;
    assert.ok(dL <= bound, `${where}: from ${a.s} to ${b.s} px the mean lightness steps ${dL.toFixed(1)} L*, over ${bound} — ${table}`);
  }
}

/**
 * A deterministic stand-in for the densest 280 px of /System/Library's map (bqa8shots, 1440 wide): about a hundred
 * top-level folders of falling size (1/k^1.15), each of one to eight folders, each of one to six folders of one to five
 * files (a few with files under the floor), laid out by the server's own buildTreemap at the page's floor and Depth 4 —
 * about 2,000 folders and 4,000 leaves, most of either 1–7 px across, as the real corner's 2,300 and 3,100. Painted
 * BQJ-2's way it is 45.9% folder band, with 46.1% of its pixels under luminance 0.08 (the real corner 42.8% and 43.4%).
 */
export function denseCornerNodes(): Tile[] {
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
export const DENSE_PX = 280;

/** A colouring of `nodes` by a stable hash of each path: Age's four bands, or a Reclaim score with about one in six not scored. */
export function hashColouring(kind: 'age' | 'reclaim'): (n: Tile) => RGB {
  const ages = OTHER_COLOURS.filter((c) => c.name.startsWith('Age band')).map((c) => c.rgb);
  const scores = OTHER_COLOURS.filter((c) => c.name.startsWith('Reclaim')).map((c) => c.rgb); // 0…100, then "not scored"
  return (n) => {
    let h = 2166136261;
    for (const ch of n.path) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    if (kind === 'age') return ages[h % ages.length];
    return h % 6 === 0 ? scores[scores.length - 1] : scores[h % (scores.length - 1)];
  };
}
