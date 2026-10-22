import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * What the map paints is what the map means — QA of 5 Oct 2026 (batch QA-6).
 *
 * The painters are cut out of the built `public/index.html` and RUN against a
 * recording 2D context (the fxChartsPerf precedent): every call is kept with
 * its arguments, `measureText` answers 6 px a character, and the assertions
 * are about the pixels' instructions — which text, at what width, in which
 * colour — rather than about how the source happens to spell them.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** `function name(…) {…}`, `const name = {…};` (brace matched) or `const|let NAME = value;`. */
function declSource(name: string): string {
  let start = INDEX.indexOf(`function ${name}(`);
  if (start === -1) start = INDEX.indexOf(`const ${name} = {`);
  if (start === -1) {
    let at = INDEX.indexOf(`const ${name} = `);
    if (at === -1) at = INDEX.indexOf(`let ${name} = `);
    assert.notEqual(at, -1, `${name} is declared in the built page`);
    return INDEX.slice(at, INDEX.indexOf(';', at) + 1);
  }
  let depth = 0;
  for (let i = INDEX.indexOf('{', INDEX.indexOf(name, start) + name.length); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1) + ';';
  }
  return assert.fail(`${name} never closes`);
}

function load<T>(names: string[], deps: Record<string, unknown>, returns: string): T {
  const keys = Object.keys(deps);
  const src = `'use strict'; ${names.map(declSource).join('\n')}\nreturn ${returns};`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, src)(...keys.map((k) => deps[k])) as T;
}

type Call = [string, unknown[]];
type Grad = { kind: 'linear'; args: number[]; stops: Array<[number, string]> };

/** A 2D context that records every method call with its arguments; text is 6 px a character. */
function recordingCtx() {
  const calls: Call[] = [];
  const fills: unknown[] = []; // fillStyle at each fill()/fillRect()
  const props: Record<string, unknown> = {
    measureText: (t: string) => ({ width: String(t).length * 6 }),
    createLinearGradient: (...args: number[]) => {
      const g: Grad = { kind: 'linear', args, stops: [] };
      return Object.assign(g, { addColorStop: (o: number, c: string) => { g.stops.push([o, c]); } });
    },
  };
  const ctx: any = new Proxy(props, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...a: unknown[]) => {
        calls.push([k, a]);
        if (k === 'fill' || k === 'fillRect') fills.push(t.fillStyle);
      };
    },
    set(t, k: string, v) { t[k] = v; return true; },
  });
  return { ctx, calls, fills, texts: () => calls.filter(([k]) => k === 'fillText') };
}

/* ══════════════ D27 — sunburst labels fit, shorten, or go — never squeeze ══════════════ */

const LONG = 'com_apple_MobileAsset_iOSSimulatorRuntime';

function paintSunburst(ringT: number) {
  const rec = recordingCtx();
  const innerR0 = 94;
  const geo = { dpr: 1, cssW: 600, cssH: 600, cx: 300, cy: 300, rings: 2, outerR: innerR0 + 2 * ringT, innerR0, ringT };
  const arc = (name: string, a0: number, a1: number) => ({
    n: { name, path: '/r/' + name }, depth: 1, a0, a1, cx: 300, cy: 300, rInner: innerR0, rOuter: innerR0 + ringT,
  });
  const arcs = [arc(LONG, -Math.PI / 2, 0.6), arc('Docs', 0.6, 2.2), arc('ab', 2.2, 4.7)];
  const status = { textContent: '' };
  const render = load<(root: unknown, arcs: unknown[], geo: unknown) => void>(
    ['renderSunburstFrame', 'sunFitLabel', 'sunStatusLine', 'SUN_LABEL_MIN_CHARS', 'Canvas2D'], {
      tmBufCtx: rec.ctx,
      cssVar: () => '#000',
      cellRgb: () => [10, 132, 255],
      mix: (a: number[]) => a,
      sectorPath() {},
      $: () => status,
      state: { treemap: { history: { active: false } } },
      formatCount: String,
      formatBytes: (n: number) => `${n} B`,
      formatWhen: String,
      presentSunburst() {},
      renderTmLegend() {},
      window: { devicePixelRatio: 1 },
    }, 'renderSunburstFrame');
  render({ name: 'A folder whose name is far too long for the centre', size: 123456 }, arcs, geo);
  return rec;
}

test('D27: no sunburst text is drawn with fillText\'s squeeze argument', () => {
  // fillText(text, x, y, maxWidth) compresses the glyphs horizontally until
  // they fit. A ring label runs radially, so its room is the ring thickness,
  // and every real folder name was crushed into an unreadable smear.
  for (const ringT of [94, 20]) {
    const squeezed = paintSunburst(ringT).texts().filter(([, a]) => a.length > 3);
    assert.deepEqual(squeezed.map(([, a]) => a[0]), [], `ring ${ringT}px: nothing is squeezed to fit`);
  }
});

test('D27: a long name is shortened with "…" to the ring\'s room; one that fits is drawn whole', () => {
  const texts = paintSunburst(94).texts().map(([, a]) => String(a[0]));
  const long = texts.find((t) => t.startsWith('com_apple'));
  assert.ok(long, 'the long name is labelled');
  assert.ok(long!.endsWith('…'), `and shortened with an ellipsis (${long})`);
  assert.ok(long!.length * 6 <= 94 - 7, `inside the ring's ${94 - 7}px of room (${long!.length * 6}px)`);
  assert.ok(texts.includes('Docs'), 'a name that fits is drawn whole');
});

test('D27: a ring too thin for three letters and "…" gets no label rather than a stub', () => {
  const texts = paintSunburst(20).texts().map(([, a]) => String(a[0]));
  const stubs = texts.filter((t) => t.endsWith('…') && LONG.startsWith(t.slice(0, -1)));
  assert.deepEqual(stubs, [], `no "c…" or "co…" stub of the long name (${texts.join(' | ')})`);
  assert.ok(texts.includes('ab'), 'a two-letter name that fits whole is still drawn');
});

test('D27: the centre disc shortens the folder name to the disc rather than squeezing it', () => {
  const texts = paintSunburst(94).texts().map(([, a]) => String(a[0]));
  const centre = texts.find((t) => t.startsWith('A folder'));
  assert.ok(centre && centre.endsWith('…'), `the centre name is shortened (${centre})`);
  assert.ok(centre!.length * 6 <= 94 * 1.8, 'to the disc\'s width');
});

/* ══════════════ D39 — the lens shows the tiles in the map's own colours ══════════════ */

const TILE = { name: 'clip.mov', path: '/r/a/b/c/clip.mov', size: 5e8, type: 'file', depth: 4, expanded: false, x: 10, y: 10, w: 30, h: 30 };
const GREEN = [48, 209, 88];

/** What the real drawTreemap needs from the page. */
const MAP_NAMES = ['drawTreemap', 'tmLeafFill', 'tmLeafStops', 'TM_CUSHION_LIGHT', 'TM_CUSHION_SHADE', 'TM_CUSHION_FULL_H', 'tmFolderTags', 'tmLabelLines', 'tmBestInk', 'tmLabelInk', 'tmContrast', 'tmLuminance', 'TM_CUSHION_EASE', 'TM_LABEL_FLOOR', 'TM_LABEL_LEADING', 'TM_SIZE_INK_ALPHA', 'tmDiffWashes', 'tmWashesOver', 'tmSeenThrough', 'TM_DIFF_WASH', 'mix', 'containerListable',
  // The outline rules the passes read (the owner's outline decision, 20 Oct 2026, and its refinement; J51).
  'tmLeafEdged', 'tmReaches', 'TM_DENSE_PX', 'tmSnap', 'tmPxScale', 'tmLinePx', 'tmLitLine', 'tmTone', 'TM_EDGE_MIN', 'TM_LIT', 'tmKidsOf', 'tmParentPath', 'tmFramesDeepestFirst',
  'tmFrameBands', 'tmTouches', 'TM_SIDES', 'TM_FRAME_MIN',
  'tmToneFor', 'tmLumCache', 'tmLitAlpha', 'tmLeafKind', 'tmBandWidth', 'TM_TEXTURE_PX', 'TM_TEXTURE_PITCH', 'tmTextureContrast', 'tmTextureStops',
  'tmFolderPathOf', 'TM_OPPOSITE', 'tmSideAt', 'tmNeighbourhood', 'tmShown', 'tmBaseOf', 'tmFillShown', 'tmUnderBand', 'tmShareOk', 'tmClip',
  'tmEdgeOf', 'tmAcross', 'tmInside', 'tmBandAsks', 'tmMeets', 'tmOverlay', 'tmSeamParts', 'tmPartRect', 'tmMergeRuns', 'tmLeafLines', 'tmBarCorners',
  'tmLineMask', 'tmClearRuns', 'tmUncovered', 'tmFolderTexture', 'tmLeafTexture', 'tmSeamPx',
  // The map's ground, which a band beside a hollow or staged cell is toned against (review F1.5), and what a hollow
  // cell (review F2.1) and a staged block (review F1.4 of BQJ-2c-r) show on their outermost device pixel.
  'tmGroundRgb', 'tmCssRgba', 'tmOver', 'tmHollowEdge', 'TM_HOLLOW_WASH', 'TM_HOLLOW_DASH', 'tmStagedEdge',
  // The name tags the outlines and bands stop at (review F3.1).
  'tmClipOutTags', 'TM_TAG_RADIUS',
  // A leaf's fill moved for its lines or its texture, so neither 8 px nor any size under it is a step (residuals 3 and 5).
  'tmPaintLeaf', 'tmLayLeaf', 'tmLabelAt', 'tmEdgedFill', 'tmTexturedFill', 'tmTexturePull', 'TM_PULL_MIN', 'tmLinedMean', 'tmSolveFill',
  'tmUnionArea', 'tmTextureMean', 'tmCushionL', 'tmLineBoundL', 'tmLstarOf', 'tmLstar', 'tmLab', 'tmFromLab', 'TM_D65', 'tmShiftL',
  'TM_SHIFT_CHROMA', 'TM_LIFT_CHROMA', 'TM_TEXTURE_SHARE', 'TM_FILL_SHIFT_MAX', 'TM_TONE_MEMO', 'TM_TONE_MEMO_MAX', 'tmToneSearch',
  // A container's indigo dashes, clear of every line and band (residual 6).
  'tmOpenDashes', 'TM_OPEN_DASH', 'TM_OPEN_DASH_ON', 'TM_OPEN_DASH_OFF',
  // Pass 3's name tag, which the lens lays too (residual 8).
  'tmLayTag'];

/** What the real lensPaint needs from the page — the map's outline rules among them (review F1.2). */
const LENS_NAMES = ['lensPaint', 'lensActive', 'lensShapes', 'LENS_SCALE', 'LENS_RADIUS', 'Canvas2D', 'mix', 'tmLeafFill', 'tmLeafStops', 'TM_CUSHION_LIGHT', 'TM_CUSHION_SHADE', 'TM_CUSHION_FULL_H', 'tmFolderTags', 'tmLabelLines', 'tmBestInk', 'tmLabelInk', 'tmContrast', 'tmLuminance', 'TM_CUSHION_EASE', 'TM_LABEL_FLOOR', 'TM_LABEL_LEADING', 'TM_SIZE_INK_ALPHA', 'tmSeenThrough', 'TM_DIFF_WASH',
  'tmTone', 'tmToneFor', 'tmLumCache', 'TM_EDGE_MIN', 'TM_LIT', 'tmLitAlpha', 'tmLitLine', 'tmLinePx', 'tmPxScale', 'tmFramesDeepestFirst', 'lensTexture',
  'TM_TONE_MEMO', 'TM_TONE_MEMO_MAX', 'tmToneSearch',
  // The map's name tags on the glass: the lines and bands stop at them, and they are laid as pass 3 lays them (residual 8).
  'tmClipOutTags', 'TM_TAG_RADIUS', 'tmLayTag', 'roundRect'];

/** The fillStyle the real drawTreemap gives `tile`'s rectangle, and the pixel rect it drew. */
function mapFill(tile: typeof TILE = TILE, colour: number[] = GREEN) {
  const rec = recordingCtx();
  const state = { treemap: { nodes: [tile], hideCloud: false, rootSize: 1e9, history: { active: false }, pxRects: [] as any[] } };
  const draw = load<() => void>(MAP_NAMES, {
    $: () => ({ clientWidth: 120 }),
    treemapCanvasHeight: () => 100,
    window: { devicePixelRatio: 1 },
    tmCanvas: { style: {}, width: 0, height: 0 },
    tmBuffer: { width: 0, height: 0 },
    tmBufCtx: rec.ctx,
    cssVar: () => '#0b0b0f',
    state,
    tmNodeCapNote: () => '', renderAltNote() {}, tmSetEmpty() {},
    renderSearchOverlay() {}, presentTreemap() {}, renderTmLegend() {},
    cellRgb: () => colour,
    tmHatchPattern: () => null,
    tmPreview: { on: false },
    roundRect() {},
    formatBytes: (n: number) => `${n} B`,
  }, 'drawTreemap');
  draw();
  // Pass 1 paints each leaf with exactly one fillRect; the first after the
  // background fill (fills[0]) is the tile.
  return { fill: rec.fills[1], px: state.treemap.pxRects };
}

/** The fillStyle the real lensPaint gives the same tile under the glass. */
function lensFill(pxRects: any[], colour: number[] = GREEN, at = { x: 25, y: 25 }) {
  const rec = recordingCtx();
  const paint = load<(ctx: unknown, w: number, h: number) => void>(
    LENS_NAMES, {
      state: { lens: { held: true, pinned: false, at }, treemap: { pxRects, cells: [] } },
      isCells: () => false,
      cssVar: () => '#0b0b0f',
      cellRgb: () => colour,
      altCellPath() {},
      window: { devicePixelRatio: 1 },
    }, 'lensPaint');
  paint(rec.ctx, 120, 100);
  // fills[0] is the glass's background; the next is the tile.
  return rec.fills[1];
}

test('D39: the lens paints a tile with the same fill the map painted it with', () => {
  // QA: bright green under the glass over an olive map. The map painted a
  // depth-faded gradient over its dark background (a depth-4 tile was ~65%
  // opaque); the lens painted the same tile opaque and fully saturated. Both
  // paint the one opaque cushion now (G01), and must keep agreeing.
  const { fill, px } = mapFill();
  assert.equal(px.length, 1, 'the map drew the tile');
  const glass = lensFill(px);
  assert.equal(typeof glass, 'object', `the lens fills with the map's gradient, not a flat colour (${String(glass)})`);
  assert.deepEqual((glass as any).stops, (fill as any).stops, 'with the same colour stops — same hue, same cushion');
  assert.deepEqual((glass as any).args, (fill as any).args, 'running over the tile\'s own height, as on the map');
});

test('D39: a tile whose cushion eased for its label shows the same eased cushion under the glass', () => {
  // A mid grey (the Reclaim "keep" grey) reads at 4.5:1 in neither black
  // nor white across the whole cushion, so pass 1 eases it under the label
  // (review F1.2): the glass must paint that cushion, not a fresh full one.
  const KEEP = [90, 100, 114];
  const labelled = { ...TILE, name: 'keep.bin', path: '/r/keep.bin', x: 0, y: 0, w: 80, h: 74 };
  const { fill, px } = mapFill(labelled, KEEP);
  assert.equal(px.length, 1, 'the map drew the tile');
  const full = mapFill({ ...labelled, w: 30 }, KEEP).fill as any; // too narrow for a label: the whole cushion
  assert.notDeepEqual((fill as any).stops, full.stops, 'the map eased this tile\'s cushion for its label');
  const glass = lensFill(px, KEEP, { x: 40, y: 40 });
  assert.equal(typeof glass, 'object', `the lens fills with a gradient (${String(glass)})`);
  assert.deepEqual((glass as any).stops, (fill as any).stops, 'the glass paints the cushion the map painted');
});

/**
 * The real drawTreemap's rectangles for `nodes`, each in its own colour, on a 100×100 map — what the lens redraws — at device
 * pixel ratio `dpr`, on a map `size` css px square, painted onto `ctx` (review F1.2 of BQJ-2c-r).
 */
function mapRects(nodes: any[], colourOf: (n: any) => number[], hideCloud = false, dpr = 1, size = 100, ctx: unknown = recordingCtx().ctx) {
  return mapState(nodes, colourOf, hideCloud, dpr, size, ctx).pxRects;
}
/** mapRects' whole record of the paint: its rectangles (pxRects) and the top-level folders' name tags it laid (tags). */
function mapState(nodes: any[], colourOf: (n: any) => number[], hideCloud = false, dpr = 1, size = 100, ctx: unknown = recordingCtx().ctx) {
  const map = mapPainter(nodes, colourOf, hideCloud, dpr, size, ctx);
  map.paint();
  return map.state.treemap;
}
/** The real drawTreemap over a state of its own, to paint as often as a test likes: `state.treemap.nodes` is what the next paint draws. */
function mapPainter(nodes: any[], colourOf: (n: any) => number[], hideCloud = false, dpr = 1, size = 100, ctx: unknown = recordingCtx().ctx) {
  const state = { treemap: { nodes, hideCloud, rootSize: 1e9, history: { active: false }, pxRects: [] as any[], tags: [] as any[] } };
  const paint = load<() => void>(MAP_NAMES, {
    $: () => ({ clientWidth: size + 20 }), treemapCanvasHeight: () => size, window: { devicePixelRatio: dpr },
    tmCanvas: { style: {}, width: 0, height: 0 }, tmBuffer: { width: 0, height: 0 }, tmBufCtx: ctx,
    cssVar: () => '#0b0b0f', state, tmNodeCapNote: () => '', renderAltNote() {}, tmSetEmpty() {},
    renderSearchOverlay() {}, presentTreemap() {}, renderTmLegend() {}, cellRgb: colourOf, tmHatchPattern: () => null,
    tmPreview: { on: false }, roundRect() {}, formatBytes: (n: number) => `${n} B`,
  }, 'drawTreemap');
  return { state, paint };
}

type LensOp = { kind: string; style?: unknown; lineWidth?: number; box: number[] | null; seg?: number[]; rule?: string; shapes?: number[][]; text?: string; at?: number[]; font?: string; baseline?: string };
/**
 * What the real lensPaint draws over `pxRects` with the cursor `at`, in order: each fill and stroke with its paint and the box it covered.
 * Only the map's ground, --tm-canvas-bg, reads as LENS_GROUND; every other variable is magenta (review F3.2), so a test that finds
 * LENS_GROUND knows the glass read the ground's variable and not another.
 */
const LENS_GROUND = '#0b0b0f';
function lensOps(pxRects: any[], colourOf: (n: any) => number[], at = { x: 25, y: 25 }, size = [120, 100], tags: any[] = [], cells = false): LensOp[] {
  const ops: LensOp[] = [];
  const st: Record<string, any> = { fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textBaseline: '' };
  let box: number[] | null = null;
  let pen: number[] | null = null;
  let segs: number[][] = [];
  // The current path's shapes as boxes [x, y, w, h]: each rectangle, and each subpath of points (a rounded rectangle's moveTo and arcTo).
  let shapes: number[][] = [];
  let pts: number[][] = [];
  const closeSub = () => {
    if (pts.length < 2) { pts = []; return; }
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    shapes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]);
    pts = [];
  };
  const props: Record<string, unknown> = {
    measureText: (t: string) => ({ width: String(t).length * 6 }),
    createLinearGradient: (...args: number[]) => {
      const g: Grad = { kind: 'linear', args, stops: [] };
      return Object.assign(g, { addColorStop: (o: number, c: string) => { g.stops.push([o, c]); } });
    },
    beginPath: () => { box = null; segs = []; pen = null; shapes = []; pts = []; },
    rect: (...a: number[]) => { box = a; shapes.push(a); },
    moveTo: (x: number, y: number) => { pen = [x, y]; closeSub(); pts.push([x, y]); },
    lineTo: (x: number, y: number) => { if (pen) segs.push([pen[0], pen[1], x, y]); pen = [x, y]; },
    arcTo: (x1: number, y1: number, x2: number, y2: number) => { pts.push([x1, y1], [x2, y2]); },
    closePath: () => closeSub(),
    clip: (rule?: string) => { closeSub(); ops.push({ kind: 'clip', rule, box: null, shapes: [...shapes] }); },
    fill: () => { closeSub(); ops.push({ kind: 'fill', style: st.fillStyle, box: box ?? (shapes.length === 1 ? shapes[0] : null) }); },
    fillText: (t: string, x: number, y: number, maxW?: number) => { ops.push({ kind: 'text', style: st.fillStyle, box: null, text: t, at: maxW === undefined ? [x, y] : [x, y, maxW], font: st.font, baseline: st.textBaseline }); },
    stroke: () => {
      ops.push({ kind: 'stroke', style: st.strokeStyle, lineWidth: st.lineWidth, box });
      for (const seg of segs) ops.push({ kind: 'line', style: st.strokeStyle, lineWidth: st.lineWidth, box: null, seg });
    },
    fillRect: (...a: number[]) => { ops.push({ kind: 'fillRect', style: st.fillStyle, box: a }); },
    strokeRect: (...a: number[]) => { ops.push({ kind: 'strokeRect', style: st.strokeStyle, lineWidth: st.lineWidth, box: a }); },
    clearRect: (...a: number[]) => { ops.push({ kind: 'clearRect', box: a }); },
  };
  const ctx: any = new Proxy(props, {
    get(t, k: string) { return k in t ? t[k] : k in st ? st[k] : () => {}; },
    set(_t, k: string, v) { st[k] = v; return true; },
  });
  load<(ctx: unknown, w: number, h: number) => void>(LENS_NAMES, {
    state: { lens: { held: true, pinned: false, at }, treemap: { pxRects, cells: [], tags } },
    isCells: () => cells, cssVar: (name: string) => (name === '--tm-canvas-bg' ? LENS_GROUND : '#ff00ff'), cellRgb: colourOf, altCellPath() {}, window: { devicePixelRatio: 1 },
  }, 'lensPaint')(ctx, size[0], size[1]);
  return ops;
}

const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (c: number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const rgbOf = (c: string) => (/rgba?\(([^)]*)\)/.exec(c)![1].split(',').slice(0, 3).map(Number));
const near = (a: number[] | null, b: number[]) => !!a && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.011);

test('the lens redraws what the map now paints — a folder\'s own fill (J51) and its texture, each leaf\'s toned lines and highlight, a small leaf\'s texture, each folder\'s bands after its leaves — and a leaf too small for lines keeps a hairline that reaches 3:1 against it (review F1.2; the owner\'s refinement)', () => {
  // On a 100×100 map, all within the glass about the cursor at (25, 25): Mail, a folder with nothing over the
  // floor; big.bin, a file with room for an outline; d, a folder tiled by two files too narrow for one (one a dark grey).
  const nodes = [
    { name: 'Mail', path: '/r/Mail', size: 3e7, type: 'dir', depth: 1, expanded: true, x: 13, y: 13, w: 12, h: 24 },
    { name: 'big.bin', path: '/r/big.bin', size: 5e9, type: 'file', depth: 1, expanded: false, x: 25, y: 13, w: 12, h: 12 },
    { name: 'd', path: '/r/d', size: 4e9, type: 'dir', depth: 1, expanded: true, x: 25, y: 25, w: 12, h: 12 },
    { name: 't1', path: '/r/d/t1', size: 2e9, type: 'file', depth: 2, expanded: false, x: 25, y: 25, w: 6, h: 12 },
    { name: 't2', path: '/r/d/t2', size: 2e9, type: 'file', depth: 2, expanded: false, x: 31, y: 25, w: 6, h: 12 },
  ];
  const colours: Record<string, number[]> = { '/r/Mail': [255, 69, 58], '/r/big.bin': [48, 209, 88], '/r/d': [10, 132, 255], '/r/d/t1': [58, 64, 72], '/r/d/t2': [255, 214, 10] };
  const colourOf = (n: any) => colours[n.path];
  const px = mapRects(nodes, colourOf);
  const r = (path: string) => px.find((p: any) => p.n.path === path);
  const mail = r('/r/Mail'), big = r('/r/big.bin'), d = r('/r/d'), t1 = r('/r/d/t1'), t2 = r('/r/d/t2');
  assert.ok(mail.bg && mail.tex && big.lines?.length && d.bands?.length && !t1.lines && !t2.lines && t1.tex && t2.tex,
    'control: the map filled Mail and textured it, lined big.bin, framed d, and left t1 and t2 without lines of their own, textured');
  const ops = lensOps(px, colourOf);
  // Mail: its own fill, the map's cushion, over its box — where the glass showed the ground.
  const mailFill = ops.findIndex((op) => op.kind === 'fill' && near(op.box, [mail.x, mail.y, mail.w, mail.h]) && typeof op.style === 'object');
  assert.notEqual(mailFill, -1, 'the glass fills Mail, a folder with nothing drawn in it, as the map does');
  assert.deepEqual((ops[mailFill].style as Grad).stops.map(([, c]) => c), mail.bg.map((c: number[]) => `rgb(${c.join(',')})`), 'with the cushion the map recorded for it');
  // big.bin: the map's lines, each in its tone, 1 px of the map's (4 on the glass), inside its box; its highlight with it.
  for (const l of big.lines) {
    assert.ok(ops.some((op) => op.kind === 'fillRect' && op.style === l.rgb && near(op.box, [l.x, l.y, l.w, l.h])), `big.bin's line at ${l.x},${l.y} ${l.w}×${l.h} is laid in the map's ${l.rgb}`);
  }
  // Each texture the map laid, its seams in the map's shade: Mail's over its fill, and t1's and t2's.
  for (const r of [mail, t1, t2]) {
    for (const box of r.tex.rects) {
      const op = ops.find((o) => o.kind === 'fillRect' && near(o.box, box) && typeof o.style === 'object');
      assert.ok(op && (op.style as Grad).stops.map(([, c]) => c).join() === r.tex.stops.map((c: number[]) => `rgb(${c.join(',')})`).join(), `${r.n.path}: its texture at ${box} is on the glass, in the map's shade`);
    }
  }
  assert.equal(ops.some((op) => op.kind === 'line' && near(op.seg!, [big.x + 1, big.y + 1.5, big.x + big.w - 1, big.y + 1.5])), !!big.lit, `big.bin's highlight ${big.lit ? 'is' : 'is not'} drawn, as on the map`);
  // And at the map's strength: as deep as its cushion (tmLitAlpha), 0.18 of white on a tile 60 px tall or more. The full
  // 0.18 on big.bin, 12 px tall, would be five times what the map draws there (review F1.6).
  const lit = ops.find((op) => op.kind === 'line' && near(op.seg!, [big.x + 1, big.y + 1.5, big.x + big.w - 1, big.y + 1.5]));
  assert.ok(big.lit && lit && big.h < 60, `control: big.bin (${big.h} px tall, under a full cushion) is lit, on the map and on the glass`);
  assert.equal(lit!.style, `rgba(255,255,255,${0.18 * Math.min(1, big.h / 60)})`, 'big.bin\'s highlight is laid on the glass at the map\'s strength');
  // Every band of every folder on the glass, in the map's colours, after every leaf.
  const lastLeaf = Math.max(...[big, t1, t2].map((leaf) => ops.findIndex((op) => op.kind === 'fill' && near(op.box, [leaf.x, leaf.y, leaf.w, leaf.h]))));
  assert.ok(lastLeaf > 0, 'control: the leaves are filled on the glass');
  for (const f of [mail, d]) {
    for (const b of f.bands) {
      const at = ops.findIndex((op) => op.kind === 'fillRect' && op.style === b.rgb && near(op.box, [b.x, b.y, b.w, b.h]));
      assert.ok(at > lastLeaf, `${f.n.path}: its band at ${b.x},${b.y} ${b.w}×${b.h} is laid in the map's ${b.rgb}, over the leaves`);
    }
  }
  // t1 and t2: no outline on the map; on the glass a hairline in a shade that reaches 3:1 against the tile.
  for (const t of [t1, t2]) {
    const hair = ops.find((op) => op.kind === 'stroke' && near(op.box, [t.x, t.y, t.w, t.h]));
    assert.ok(hair, `${t.n.path}: a hairline on the glass`);
    assert.equal(hair!.lineWidth, 0.25, `${t.n.path}: one pixel of the glass (a quarter of the map's)`);
    const worst = Math.min(...t.seen.map((c: number[]) => ratio(rgbOf(String(hair!.style)), c)));
    assert.ok(worst >= 3, `${t.n.path}: its hairline (${hair!.style}) reaches 3:1 against the tile (${worst.toFixed(2)}:1)`);
  }
  assert.ok(lum(rgbOf(String(ops.find((op) => op.kind === 'stroke' && near(op.box, [t1.x, t1.y, t1.w, t1.h]))!.style))) > lum(colours['/r/d/t1']), 'on the dark grey tile the hairline is a lighter shade');
  // The old faint lines are gone from the rectangle map's tiles (the glass's own rim is a ring, not a tile's box).
  assert.deepEqual(ops.filter((op) => /^(stroke|strokeRect)$/.test(op.kind) && op.box && /^rgba\((255,255,255,0\.35|0,0,0,0\.45)\)$/.test(String(op.style))).map((op) => op.style), [], 'no white 0.35 frame line, no black 0.45 hairline');
});

test('the lens clears a staged block and a hollow online-only file to the map\'s ground, as the map does — the folder\'s own fill behind them never shows through on the glass (review F1.2)', () => {
  const nodes = [
    { name: 'F', path: '/r/F', size: 9e9, type: 'dir', depth: 1, expanded: true, x: 13, y: 13, w: 24, h: 24 },
    { name: 'Staged', path: '/r/F — freed', parentPath: '/r/F', size: 2e9, type: 'dir', depth: 2, expanded: false, freed: true, x: 13, y: 13, w: 12, h: 12 },
    { name: 'cloud.mov', path: '/r/F/cloud.mov', size: 2e9, type: 'file', depth: 2, expanded: false, cloudPlaceholder: true, x: 25, y: 13, w: 12, h: 12 },
  ];
  const colourOf = (n: any) => (n.path === '/r/F/cloud.mov' ? [255, 159, 10] : [10, 132, 255]);
  const px = mapRects(nodes, colourOf);
  const f = px.find((p: any) => p.n.path === '/r/F');
  assert.ok(f.bg, 'control: the folder is filled where nothing covers it');
  const ops = lensOps(px, colourOf);
  const fFill = ops.findIndex((op) => op.kind === 'fill' && near(op.box, [f.x, f.y, f.w, f.h]));
  for (const [path, own] of [['/r/F — freed', 'rgba(120,120,130,0.35)'], ['/r/F/cloud.mov', 'rgba(255,159,10,0.16)']] as const) {
    const c = px.find((p: any) => p.n.path === path);
    const box = [c.x, c.y, c.w, c.h];
    const clear = ops.findIndex((op) => op.kind === 'clearRect' && near(op.box, box));
    assert.ok(clear > fFill, `${path}: cleared on the glass after the folder's fill`);
    assert.ok(ops[clear + 1]?.kind === 'fill' && ops[clear + 1].style === LENS_GROUND && near(ops[clear + 1].box, box), `${path}: then laid with the map's ground, --tm-canvas-bg (${String(ops[clear + 1]?.style)})`);
    assert.ok(ops[clear + 2]?.kind === 'fill' && ops[clear + 2].style === own && near(ops[clear + 2].box, box), `${path}: then its own faint fill, ${own}`);
  }
});

test('the lens lays the map\'s ground over a folder an online-only file is hidden in, inside a folder with its own fill — after that fill, before what is drawn in the folder — as the map does; it showed the fill of the folder above where the hidden file would be (review F2.1)', () => {
  // On a 100×100 map, within the glass about the cursor at (25, 25): F, whose right half holds only files under
  // the floor (so it is filled), and in its left half Synced, holding here.bin and an online-only file, hidden.
  const nodes = [
    { name: 'F', path: '/r/F', size: 3e10, type: 'dir', depth: 1, expanded: true, x: 13, y: 13, w: 24, h: 24 },
    { name: 'Synced', path: '/r/F/Synced', size: 2e10, type: 'dir', depth: 2, expanded: true, x: 13, y: 13, w: 12, h: 24 },
    { name: 'here.bin', path: '/r/F/Synced/here.bin', size: 5e9, type: 'file', depth: 3, expanded: false, x: 13, y: 13, w: 6, h: 24 },
    { name: 'away.mov', path: '/r/F/Synced/away.mov', size: 5e9, type: 'file', depth: 3, expanded: false, cloudPlaceholder: true, x: 19, y: 13, w: 6, h: 24 },
  ];
  const colourOf = (n: any) => (n.type === 'dir' ? [255, 69, 58] : [10, 132, 255]);
  const px = mapRects(nodes, colourOf, true);
  const r = (path: string) => px.find((p: any) => p.n.path === path);
  const f = r('/r/F'), synced = r('/r/F/Synced'), here = r('/r/F/Synced/here.bin');
  assert.ok(f.bg && !synced.bg && px.length === 3, 'control: F is filled, Synced is not, and the online-only file is hidden');
  const ops = lensOps(px, colourOf);
  const fFill = ops.findIndex((op) => op.kind === 'fill' && near(op.box, [f.x, f.y, f.w, f.h]) && typeof op.style === 'object');
  const hereFill = ops.findIndex((op) => op.kind === 'fill' && near(op.box, [here.x, here.y, here.w, here.h]));
  assert.ok(fFill >= 0 && hereFill > fFill, 'control: F\'s own fill, then here.bin, on the glass');
  const box = [synced.x, synced.y, synced.w, synced.h];
  const clear = ops.findIndex((op) => op.kind === 'clearRect' && near(op.box, box));
  assert.ok(clear > fFill && clear < hereFill, `Synced's box is cleared on the glass after F's fill and before here.bin (${fFill} < ${clear} < ${hereFill})`);
  assert.ok(ops[clear + 1]?.kind === 'fill' && ops[clear + 1].style === LENS_GROUND && near(ops[clear + 1].box, box), `then laid with the map's ground, --tm-canvas-bg (${String(ops[clear + 1]?.style)})`);
  // And the glass itself is laid with the map's ground first, under everything it magnifies (review F3.2).
  const glass = ops.findIndex((op) => op.kind === 'fillRect');
  assert.ok(glass >= 0 && glass < fFill && ops[glass].style === LENS_GROUND, `the glass is first laid with the map's ground, --tm-canvas-bg (${String(ops[glass]?.style)})`);
});

/** A 2D context that keeps each straight segment stroked, with the paint and the width it was stroked in. */
function segmentCtx() {
  const lines: Array<{ style: string; width: number; seg: number[] }> = [];
  const st: Record<string, any> = { strokeStyle: '', lineWidth: 1 };
  let pen: number[] | null = null;
  let segs: number[][] = [];
  const props: Record<string, unknown> = {
    measureText: (t: string) => ({ width: String(t).length * 6 }),
    createLinearGradient: (...args: number[]) => {
      const g: Grad = { kind: 'linear', args, stops: [] };
      return Object.assign(g, { addColorStop: (o: number, c: string) => { g.stops.push([o, c]); } });
    },
    beginPath: () => { segs = []; pen = null; },
    moveTo: (x: number, y: number) => { pen = [x, y]; },
    lineTo: (x: number, y: number) => { if (pen) segs.push([pen[0], pen[1], x, y]); pen = [x, y]; },
    stroke: () => { for (const seg of segs) lines.push({ style: String(st.strokeStyle), width: Number(st.lineWidth), seg }); },
  };
  const ctx: any = new Proxy(props, {
    get(t, k: string) { return k in t ? t[k] : k in st ? st[k] : () => {}; },
    set(_t, k: string, v) { st[k] = v; return true; },
  });
  return { ctx, lines };
}

test('the lens strokes a leaf\'s top highlight where the map stroked it — its ends, its row and its width — on a page zoomed out as at 100 % and on a Retina screen, at device pixel ratios 0.5, 0.667, 0.8, 0.9, 1 and 2 (review F1.2, F1.5 of BQJ-2c-r)', () => {
  // Pass 1 and the lens lay the highlight by tmLitLine (73234dd1): under a ratio of 1 one device pixel wide, on whole device
  // pixels under the top line. Every lens test ran at a ratio of 1, where that is the old 1 css px line at x + 1 and y + 1.5,
  // so a lens laying the old line passed every test: at 80 % 1 css px at y + 1.5, where the map lays 1.25 at y + 1.875.
  for (const dpr of [0.5, 0.667, 0.8, 0.9, 1, 2]) {
    // The map as many device pixels across as 100 css px at 100 %, so big.bin is lined at every ratio.
    const k = Math.max(1, 1 / dpr), size = 100 * k;
    const nodes = [{ name: 'big.bin', path: '/r/big.bin', size: 5e9, type: 'file', depth: 1, expanded: false, x: 10, y: 10, w: 30, h: 30 }];
    const map = segmentCtx();
    const px = mapRects(nodes, () => GREEN, false, dpr, size, map.ctx);
    const big = px.find((p: any) => p.n.path === '/r/big.bin');
    const drawn = map.lines.filter((l) => /^rgba\(255,255,255,/.test(l.style));
    assert.ok(big && big.lit && drawn.length === 1, `dpr ${dpr}: control — the map lines big.bin, under a dark top line, and strokes one highlight (${drawn.length})`);
    const ops = lensOps(px, () => GREEN, { x: 25 * k, y: 25 * k }, [120 * k, 100 * k]);
    const glass = ops.filter((op) => op.kind === 'line' && /^rgba\(255,255,255,/.test(String(op.style)));
    assert.equal(glass.length, 1, `dpr ${dpr}: control — the lens strokes one highlight`);
    assert.ok(near(glass[0].seg!, drawn[0].seg), `dpr ${dpr}: the lens strokes the highlight from ${glass[0].seg} where the map strokes it from ${drawn[0].seg}`);
    assert.ok(Math.abs(glass[0].lineWidth! - drawn[0].width) < 1e-9, `dpr ${dpr}: the lens strokes it ${glass[0].lineWidth} css px of the map wide, the map ${drawn[0].width}`);
  }
});

test('the lens shows a top-level folder\'s name tag as the map lays it — the lines and bands stop at the tag\'s edge, clipped out of them by its own box, and the tag, its half black and its name, laid after them, where the map\'s pass 3 laid it; no name the glass writes sits on it (residual 8)', () => {
  // A folder 100×60 on a 120×100 map, big enough for its tag, tiled by four files whose lines run under the tag, and a
  // file beside it; the glass about the tag. It drew no tag, so on the glass the lines ran on where the map has the tag.
  const nodes = [
    { name: 'Music', path: '/r/Music', size: 4e10, type: 'dir', depth: 1, expanded: true, x: 0, y: 0, w: 83.34, h: 60 },
    ...[0, 1, 2, 3].map((k) => ({ name: `m${k}`, path: `/r/Music/m${k}`, size: 5e9, type: 'file', depth: 2, expanded: false, x: k * 20.835, y: 0, w: 20.835, h: 60 })),
    { name: 'big.bin', path: '/r/big.bin', size: 2e10, type: 'file', depth: 1, expanded: false, x: 83.34, y: 0, w: 16.66, h: 100 },
  ];
  const colours: Record<string, number[]> = { '/r/Music': [10, 132, 255], '/r/big.bin': [48, 209, 88] };
  const colourOf = (n: any) => colours[n.path] ?? [255, 214, 10];
  const map = mapState(nodes, colourOf, false, 1, 120);
  const px = map.pxRects, tags = map.tags;
  assert.equal(tags.length, 1, 'control: the map laid the folder\'s name tag');
  const t = tags[0], music = px.find((r: any) => r.n.path === '/r/Music');
  const under = px.flatMap((r: any) => r.lines || []).filter((l: any) => l.x < t.x + t.w && l.x + l.w > t.x && l.y < t.y + t.h && l.y + l.h > t.y);
  assert.ok(under.length > 0 && music.bands?.length, 'control: the files\' lines run where the tag sits, and the folder is banded');
  const ops = lensOps(px, colourOf, { x: t.x + t.w / 2, y: t.y + t.h / 2 }, [120, 100], tags);
  const lineAt = (op: LensOp) => op.kind === 'fillRect' && px.some((r: any) => [...(r.lines || []), ...(r.bands || [])].some((l: any) => l.rgb === op.style && near(op.box, [l.x, l.y, l.w, l.h])));
  const firstLine = ops.findIndex(lineAt), lastLine = ops.length - 1 - [...ops].reverse().findIndex(lineAt);
  assert.ok(firstLine > 0, 'control: the glass lays the lines and bands');
  // The clip: the map's whole rectangle with the tag cut out of it, before the first line and after the last leaf's fill.
  const clip = ops.findIndex((op, i) => i < firstLine && op.kind === 'clip' && op.rule === 'evenodd');
  assert.notEqual(clip, -1, 'the lines and bands are laid under an even-odd clip');
  assert.ok(ops[clip].shapes!.some((b) => near(b, [t.x, t.y, t.w, t.h])), `that cuts the tag out by its own box ${[t.x, t.y, t.w, t.h]} (${JSON.stringify(ops[clip].shapes)})`);
  assert.ok(ops.slice(clip).every((op) => !(op.kind === 'fill' && typeof op.style === 'object')), 'every tile is filled before the clip');
  // The tag after the lines: its half black over its box, and its name where pass 3 wrote it.
  const pill = ops.findIndex((op, i) => i > lastLine && op.kind === 'fill' && op.style === 'rgba(0,0,0,0.5)' && near(op.box, [t.x, t.y, t.w, t.h]));
  assert.notEqual(pill, -1, `the tag's half black is laid over its box after the lines (${JSON.stringify(ops.filter((op) => op.kind === 'fill' && op.style === 'rgba(0,0,0,0.5)'))})`);
  const name = ops.findIndex((op, i) => i > pill && op.kind === 'text' && op.text === 'Music' && near(op.at!, [music.x + 12, music.y + 14.5, music.w - 26]));
  assert.notEqual(name, -1, `and the folder's name where the map writes it, at most the folder less 26 wide (${JSON.stringify(ops.filter((op) => op.kind === 'text'))})`);
  // In the map's own type, on its middle line, as pass 3 sets them before it lays a tag: the canvas's default, 10px
  // sans-serif on its alphabetic baseline, wrote the name about 4 css px higher, 16 on the glass (review F1.10).
  assert.equal(ops[name].font, '600 10.5px -apple-system, sans-serif', 'the name is written in the map\'s tag type');
  assert.equal(ops[name].baseline, 'middle', 'on its middle line, as on the map');
  // The names the glass writes at its own size, about the cursor: none on the tag as it shows on the glass.
  const toLens = (x: number, y: number) => [t.x + t.w / 2 + (x - (t.x + t.w / 2)) * 4, t.y + t.h / 2 + (y - (t.y + t.h / 2)) * 4];
  const [tx0, ty0] = toLens(t.x, t.y), [tx1, ty1] = toLens(t.x + t.w, t.y + t.h);
  const onTag = ops.filter((op, i) => i > name && op.kind === 'text' && op.at!.length === 2 && op.at![0] < tx1 && op.at![0] + op.text!.length * 6 > tx0 && op.at![1] + 6 > ty0 && op.at![1] - 6 < ty1);
  assert.deepEqual(onTag.map((op) => op.text), [], 'no name the glass writes sits on the tag');
});

/** A folder 100×60 with its name tag, tiled by four files, beside a file, on a 120×100 map — the residual 8 map — and its colours. */
const TAGGED = {
  nodes: [
    { name: 'Music', path: '/r/Music', size: 4e10, type: 'dir', depth: 1, expanded: true, x: 0, y: 0, w: 83.34, h: 60 },
    ...[0, 1, 2, 3].map((k) => ({ name: `m${k}`, path: `/r/Music/m${k}`, size: 5e9, type: 'file', depth: 2, expanded: false, x: k * 20.835, y: 0, w: 20.835, h: 60 })),
    { name: 'big.bin', path: '/r/big.bin', size: 2e10, type: 'file', depth: 1, expanded: false, x: 83.34, y: 0, w: 16.66, h: 100 },
  ],
  colourOf: (n: any) => ({ '/r/Music': [10, 132, 255], '/r/big.bin': [48, 209, 88] } as Record<string, number[]>)[n.path] ?? [255, 214, 10],
};
/**
 * What the glass lays of a name tag in `ops`: the even-odd clip that cuts tags out of the lines, a tag's half black, and
 * a folder's name as a tag writes it — squeezed to the folder less 26 (fillText's third argument), where the names the
 * glass writes at its own size take two.
 */
function tagOps(ops: LensOp[]) {
  return {
    clips: ops.filter((op) => op.kind === 'clip' && op.rule === 'evenodd').length,
    pills: ops.filter((op) => op.kind === 'fill' && op.style === 'rgba(0,0,0,0.5)').length,
    names: ops.filter((op) => op.kind === 'text' && op.at!.length === 3).map((op) => op.text),
  };
}

test('a map with nothing to draw leaves no name tag behind — an empty folder painted after one with a tag keeps none, and the magnifier, pinned or held over it, lays no tag, half black or clip of the folder before it (review F1.2, F1.4, F1.12)', () => {
  // The tags were recorded only past the empty map's early return, so after "This folder is empty." the lens laid the
  // previous folder's pill and name over the empty ground — something the map was not showing.
  const map = mapPainter(TAGGED.nodes, TAGGED.colourOf, false, 1, 120);
  map.paint();
  const t = map.state.treemap.tags[0];
  assert.equal(map.state.treemap.tags.length, 1, 'control: the folder\'s map lays its name tag');
  const before = tagOps(lensOps(map.state.treemap.pxRects, TAGGED.colourOf, { x: t.x + t.w / 2, y: t.y + t.h / 2 }, [120, 100], map.state.treemap.tags));
  assert.deepEqual(before, { clips: 1, pills: 1, names: ['Music'] }, 'control: and the glass over it lays that tag');
  map.state.treemap.nodes = [];
  map.paint();
  assert.equal(map.state.treemap.pxRects.length, 0, 'control: the empty folder draws nothing');
  assert.deepEqual(map.state.treemap.tags, [], 'the empty folder\'s paint lays no tag, and keeps none of the folder before it');
  const after = tagOps(lensOps(map.state.treemap.pxRects, TAGGED.colourOf, { x: t.x + t.w / 2, y: t.y + t.h / 2 }, [120, 100], map.state.treemap.tags));
  assert.deepEqual(after, { clips: 0, pills: 0, names: [] }, 'and the glass where the tag was lays none of it');
});

test('the magnifier over Circles or Voronoi lays no name tag — the rectangle map\'s tags, still in the state from its last paint, never reach the glass over the cells (review F1.8)', () => {
  // Switching to Circles or Voronoi leaves the rectangle map's tags in state.treemap.tags: only the cells' layout, not
  // the tags, belongs to the glass there.
  const map = mapState(TAGGED.nodes, TAGGED.colourOf, false, 1, 120);
  const t = map.tags[0];
  assert.equal(map.tags.length, 1, 'control: the rectangle map left its tag in the state');
  const at = { x: t.x + t.w / 2, y: t.y + t.h / 2 };
  assert.deepEqual(tagOps(lensOps([], TAGGED.colourOf, at, [120, 100], map.tags)), { clips: 1, pills: 1, names: ['Music'] },
    'control: the glass over the rectangle map lays it');
  assert.deepEqual(tagOps(lensOps([], TAGGED.colourOf, at, [120, 100], map.tags, true)), { clips: 0, pills: 0, names: [] },
    'over the cells the glass lays no tag, half black or clip');
});
