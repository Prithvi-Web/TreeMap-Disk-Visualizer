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

/** The fillStyle the real drawTreemap gives `tile`'s rectangle, and the pixel rect it drew. */
function mapFill(tile: typeof TILE = TILE, colour: number[] = GREEN) {
  const rec = recordingCtx();
  const state = { treemap: { nodes: [tile], hideCloud: false, rootSize: 1e9, history: { active: false }, pxRects: [] as any[] } };
  const draw = load<() => void>(['drawTreemap', 'tmLeafFill', 'tmLeafStops', 'TM_CUSHION_LIGHT', 'TM_CUSHION_SHADE', 'TM_CUSHION_FULL_H', 'tmFolderTags', 'tmLabelLines', 'tmBestInk', 'tmLabelInk', 'tmContrast', 'tmLuminance', 'TM_CUSHION_EASE', 'TM_LABEL_FLOOR', 'TM_LABEL_LEADING', 'TM_SIZE_INK_ALPHA', 'tmDiffWashes', 'tmWashesOver', 'tmSeenThrough', 'TM_DIFF_WASH', 'mix', 'containerListable',
    // The dense-area rules pass 1 and pass 2 read (BQG-5 item 14).
    'tmLeafBox', 'tmLeafEdged', 'tmFrameOutline', 'tmFrameRim', 'TM_DENSE_PX', 'TM_FRAME_FADE_PX', 'TM_FRAME_FADED', 'TM_RIM_MIN_PX'], {
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
    ['lensPaint', 'lensActive', 'lensShapes', 'LENS_SCALE', 'LENS_RADIUS', 'Canvas2D', 'mix', 'tmLeafFill', 'tmLeafStops', 'TM_CUSHION_LIGHT', 'TM_CUSHION_SHADE', 'TM_CUSHION_FULL_H', 'tmFolderTags', 'tmLabelLines', 'tmBestInk', 'tmLabelInk', 'tmContrast', 'tmLuminance', 'TM_CUSHION_EASE', 'TM_LABEL_FLOOR', 'TM_LABEL_LEADING', 'TM_SIZE_INK_ALPHA', 'tmSeenThrough', 'TM_DIFF_WASH'], {
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
