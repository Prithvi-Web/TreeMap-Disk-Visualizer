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
  for (let attempt = 0; attempt < 32; attempt++) {
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
  throw new Error(`${names.join(', ')} would not run after pulling in 32 helpers`);
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

/** A 2D context that records every fill, every text and every stroked rectangle with the paint it was drawn in. */
function recordingCtx() {
  const fills: unknown[] = [];
  const texts: Text[] = [];
  const strokes: Stroke[] = [];
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
        if (k === 'strokeRect') strokes.push({ style: String(t.strokeStyle), width: Number(t.lineWidth), rect: a.map(Number) });
      };
    },
    set(t, k: string, v) { t[k] = v; return true; },
  });
  return { ctx, fills, texts, strokes };
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

/** Paint `tiles` with the real drawTreemap — coloured by the size ramp unless `colour` says otherwise. */
function paint(tiles: Tile[], colour: (n: Tile) => RGB = (n) => ramp.sizeRgb(n.size)) {
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
  const y0 = (l.tile.y / 100) * MAP_H, h = l.h;
  const ink = rgba(String(text.fillStyle));
  let worst = Infinity;
  for (const yy of [text.y, Math.min(y0 + h, text.y + fontPx(text.font) * LEADING)]) {
    const under = at(l.fill, Math.max(0, Math.min(1, (yy - y0) / h)), ground);
    worst = Math.min(worst, contrast(over(ink, under), under));
  }
  return worst;
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

/* ══════════════ G01/G09 — the SVG export is the map's own recipe ══════════════ */

/**
 * The PNG export copies the canvas, but the SVG export drew the map again
 * with the retired recipe: each leaf at fill-opacity 0.95 × max(0.55,
 * 1 − 0.08·depth) of sizeRgb over the page, its labels fixed black at
 * 0.78/0.55 — a depth-4 9.1 GB tile came out the pastel/maroon wash at
 * 2.87:1 (review F1.3, F1.9). The real exportTreemapSVG runs here over the
 * pxRects the real drawTreemap left, and its SVG is read back.
 */
function exportSvg(tiles: Tile[], colour: (n: Tile) => RGB, ground: string) {
  const state = { treemap: { nodes: tiles, hideCloud: false, rootSize: 1e12, history: { active: false, diff: false }, pxRects: [] as any[],
    colorMode: 'size', mode: 'treemap', query: '', rootName: 'r' } };
  const rec = recordingCtx();
  const common = {
    $: () => ({ clientWidth: MAP_W + 20 }), treemapCanvasHeight: () => MAP_H, window: { devicePixelRatio: 1 },
    tmCanvas: { style: {}, width: 0, height: 0 }, tmBuffer: { width: MAP_W, height: MAP_H }, tmBufCtx: rec.ctx,
    cssVar: (name: string) => (name === '--bg-1' ? ground : 'rgba(0,0,0,0.3)'),
    state,
    tmNodeCapNote: () => '', renderAltNote() {}, tmSetEmpty() {}, renderSearchOverlay() {}, presentTreemap() {}, renderTmLegend() {},
    cellRgb: colour, sizeRgb: () => [255, 0, 255], tmHatchPattern: () => null, tmPreview: { on: false }, roundRect() {},
    formatBytes: (n: number) => `${Math.round(n)} B`,
  };
  const draw = load<() => void>(['drawTreemap'], common, 'drawTreemap', (d) => d());
  rec.fills.length = 0;
  rec.texts.length = 0;
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
  const { svg, rec } = exportSvg(tiles, (n) => colours[tiles.findIndex((t) => t.path === n.path)], '#0e0e13');
  const canvas = leafFills(rec, tiles.length);
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
  const { svg, rec } = exportSvg(tiles, (n) => colours[leaves.findIndex((t) => t.path === n.path)] ?? [0, 0, 0], '#0e0e13');
  const canvas = leafFills(rec, leaves.length);
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

test('G01: the SVG export frames each folder as the canvas does — a dark outline, heavier at the top level, and a light rim inside it', () => {
  const tiles: Tile[] = [
    { name: 'Top', path: '/r/top', size: 1e10, type: 'dir', depth: 1, expanded: true, x: 0, y: 0, w: 50, h: 50 },
    { name: 'Inner', path: '/r/top/in', size: 5e9, type: 'dir', depth: 3, expanded: true, x: 2, y: 5, w: 40, h: 40 },
    { ...tile(0, 4, 1e9, 100), x: 4, y: 8, w: 10 },
  ];
  const { svg } = exportSvg(tiles, () => [255, 72, 57], '#0e0e13');
  const frames = [...svg.matchAll(/<rect [^>]*fill="none"[^>]*\/>/g)].map((m) => attrs(m[0]));
  const outline = (d: number) => frames.find((f) => /^rgba\(0,0,0,/.test(f.stroke) && Math.abs(Number(f.x) - (d === 1 ? 0.5 : 20.5)) < 0.06);
  const top = outline(1), inner = outline(3);
  assert.ok(top && inner, `each folder has a dark outline (${JSON.stringify(frames)})`);
  assert.ok(Number(top!['stroke-width']) > Number(inner!['stroke-width']), 'heavier at the top level');
  for (const [x, what] of [[1.5, 'top'], [21.5, 'inner']] as const) {
    assert.ok(frames.some((f) => /^rgba\(255,255,255,/.test(f.stroke) && Math.abs(Number(f.x) - x) < 0.06), `the ${what} folder has a light rim inside its outline`);
  }
});

/* ══════════════ G01 — depth is told by the folder frames ══════════════ */

test('G01: each folder is framed by a dark outline — heavier at the top level — with a light rim drawn inside it, and a folder too small for a rim gets none', () => {
  // Every leaf is painted at full strength now (G01), so nesting is read
  // from the edges, as on a desktop treemap. Nothing pinned the frames: the
  // whole of pass 2 could go, or turn white, with every test still green
  // (review F1.8).
  const folders: Tile[] = [
    { name: 'Top', path: '/r/top', size: 1e10, type: 'dir', depth: 1, expanded: true, x: 0, y: 0, w: 50, h: 50 },
    { name: 'Mid', path: '/r/top/mid', size: 5e9, type: 'dir', depth: 2, expanded: true, x: 2, y: 5, w: 40, h: 40 },
    { name: 'Deep', path: '/r/top/mid/deep', size: 2e9, type: 'dir', depth: 3, expanded: true, x: 4, y: 8, w: 30, h: 30 },
    { name: 'Tiny', path: '/r/tiny', size: 1e6, type: 'dir', depth: 3, expanded: true, x: 60, y: 60, w: 0.4, h: 0.4 },
  ];
  const rec = paint(folders);
  const alphaOf = (style: string) => rgba(style)[3];
  const isDark = (style: string) => { const [r, g, b] = rgba(style); return r + g + b === 0; };
  const isLight = (style: string) => { const [r, g, b] = rgba(style); return r === 255 && g === 255 && b === 255; };
  const outlines: Stroke[] = [];
  for (const f of folders) {
    const x = (f.x / 100) * MAP_W, y = (f.y / 100) * MAP_H, w = (f.w / 100) * MAP_W, h = (f.h / 100) * MAP_H;
    const near = (r: number[], want: number[]) => r.every((v, i) => Math.abs(v - want[i]) < 0.01);
    const at = (want: number[]) => rec.strokes.findIndex((st) => near(st.rect, want));
    const o = at([x + 0.5, y + 0.5, w - 1, h - 1]);
    assert.notEqual(o, -1, `${f.name}: an outline on its edge`);
    const outline = rec.strokes[o];
    assert.ok(isDark(outline.style) && alphaOf(outline.style) >= 0.35, `${f.name}: the outline is dark (${outline.style})`);
    outlines.push(outline);
    const rim = at([x + 1.5, y + 1.5, w - 3, h - 3]);
    if (w > 4 && h > 4) {
      assert.notEqual(rim, -1, `${f.name}: a rim inside its outline`);
      assert.ok(isLight(rec.strokes[rim].style), `${f.name}: the rim is light (${rec.strokes[rim].style})`);
      assert.ok(rim > o, `${f.name}: the rim is drawn after the outline, so it lies on top of it`);
    } else {
      assert.equal(rim, -1, `${f.name}: ${fmt(w)} px is too small for a rim`);
    }
  }
  const [top, mid, deep] = outlines;
  assert.ok(top.width > mid.width && alphaOf(top.style) > alphaOf(mid.style), `the top level's outline is heavier (${top.width}px ${top.style} against ${mid.width}px ${mid.style})`);
  assert.deepEqual([mid.width, mid.style], [deep.width, deep.style], 'below the top level every outline is alike');
});
