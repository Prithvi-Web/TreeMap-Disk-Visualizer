import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-mapRatioLines-data-');

import {
  DARK, DENSE_PX, EDGE_BAR, EVERY_COLOUR, LIGHT, REAL_H, REAL_W, bandStep, colourBlocks, denseCornerNodes, devicePx,
  measureEdges, partings, rasterPaint, realisticNodes, type RGB, type Tile,
} from './fixtures/mapRaster';

/**
 * The owner's outlines at every device pixel ratio from 100 to 300 %: every leaf's line and every folder's band a whole
 * number of device pixels on whole device pixels, never a blend; and at 125 and 175 %, Windows' display scalings, every
 * colour's lines at 3:1 and every leaf of 8 px and up parted by a line (item 44). Split from
 * tests/mapColourPop.test.ts (BQV), whose sweeps had grown past CI's 20-minute limit a test file; the harness is
 * tests/fixtures/mapRaster.ts, and the 3:1 sweep at every ratio from 105 % is tests/mapRatioSweeps.test.ts.
 */

/** Ratios from 100 to 300 %: Windows' display scalings, a Retina screen, and browser zoom on each. */
const RATIOS_UP = [1, 1.1, 1.15, 1.2, 1.25, 1.4, 1.5, 1.6, 1.75, 1.9, 2, 2.2, 2.25, 2.5, 2.7, 3];

test('owner\'s outlines at every ratio from 100 to 300 %: every leaf\'s line and every folder\'s band is a whole number of device pixels on whole device pixels — the most no wider than its css width, never none, never a device pixel and part of the next — so no line is ever a blend: at 125, 150 and 175 % a 1 px line was one device pixel and part of the next (residual 4)', () => {
  // At 150 % a 1 css px line covered a device pixel and half the next, and the half-covered pixel was a blend of the line
  // and its tile; laid two whole device pixels wide instead (the nearest above), the dense corner's pixels under luminance
  // 0.08 rose from 22% to 25.1%, over the owner's budget, and at 175 % two (the nearest) put corpus/Mail at 42.5% band,
  // over the owner's 40%. The painter takes the most whole device pixels no wider than the css width, and at least one: no line
  // takes more of the map at any ratio than at 100 %, where the owner's budgets hold (the thinner-frames test).
  const b = colourBlocks(EVERY_COLOUR, 16, 16), real = realisticNodes(), dense = denseCornerNodes();
  const onDevice = (v: number, dpr: number) => Math.abs(v * dpr - Math.round(v * dpr)) < 1e-6;
  for (const dpr of RATIOS_UP) {
    for (const [what, tiles, W, H, colour] of [['the colour blocks', b.tiles, b.W, b.H, b.colour], ['the realistic map', real, REAL_W, REAL_H, undefined],
      ['the dense corner', dense, DENSE_PX, DENSE_PX, undefined]] as const) {
      const where = `${what}, dpr ${dpr}`;
      const { px } = rasterPaint(tiles as Tile[], DARK, W, H, colour as ((n: Tile) => RGB) | undefined, undefined, false, dpr);
      const line = devicePx(1, dpr);
      const laid = px.flatMap((r) => [...(r.lines || []).map((l) => ({ r, l, band: false })), ...(r.bands || []).map((l) => ({ r, l, band: true }))]);
      assert.ok(laid.length > 1000, `${where}: control — ${laid.length} lines and bands laid`);
      const off = laid.filter(({ l }) => ![l.x, l.y, l.x + l.w, l.y + l.h].every((v) => onDevice(v, dpr)) || Math.min(l.w, l.h) * dpr < 1 - 1e-6)
        .map(({ r, l, band }) => `${r.n.path}'s ${band ? 'band' : 'line'} at ${(l.x * dpr).toFixed(2)},${(l.y * dpr).toFixed(2)}, ${(l.w * dpr).toFixed(2)}×${(l.h * dpr).toFixed(2)} device px`);
      assert.deepEqual(off.slice(0, 6), [], `${where}: ${off.length} lines or bands off whole device pixels, or under one`);
      // Each leaf's line: one painter's px, as many whole device pixels as fit in it (a corner kept by the line across it
      // as long as it is wide, tmBarCorners).
      const thick = laid.filter(({ l, band }) => !band && Math.abs(Math.min(l.w, l.h) * dpr - line) > 1e-6 && Math.abs(l.w * dpr - line) > 1e-6 && Math.abs(l.h * dpr - line) > 1e-6)
        .map(({ r, l }) => `${r.n.path}'s line ${(l.w * dpr).toFixed(2)}×${(l.h * dpr).toFixed(2)} device px, where a line is ${line}`);
      assert.deepEqual(thick.slice(0, 6), [], `${where}: ${thick.length} leaf lines not ${line} device px wide`);
      // Each folder's band: by its size in painter's px, 1 to 3, as many whole device pixels as fit in that.
      const misbanded = px.filter((r) => r.frame).map((r) => {
        const m = Math.min(Math.round((r.x + r.w) * dpr) - Math.round(r.x * dpr), Math.round((r.y + r.h) * dpr) - Math.round(r.y * dpr)) / dpr;
        const painter = bandStep(m + 1e-6, r.n.depth);
        return { r, want: painter ? devicePx(painter, dpr) : 0, got: (r.lw || 0) * dpr };
      }).filter(({ want, got }) => Math.abs(want - got) > 1e-6).map(({ r, want, got }) => `${r.n.path}: ${got.toFixed(2)} device px of band where ${want} is asked`);
      assert.deepEqual(misbanded.slice(0, 6), [], `${where}: ${misbanded.length} folders banded off their size`);
    }
  }
});

test('owner\'s outlines at 125 and 175 %: every leaf\'s line and every folder\'s band reaches 3:1 against the tile beside it on the device\'s pixels, and every leaf of 8 px and up is parted from what lies beside it by a line, on every colour the map paints — the colour blocks of the whole size ramp, Age, every Reclaim score, "not scored", the History diff colours and the Trash cell, in both themes, as at 50 to 90 %, 100 %, 150 % and 200 % (item 44)', () => {
  // The colour blocks are measured at 100 % (every leaf shape), at 150 and 200 % and on a page zoomed out to 50 to 90 %
  // (mapColourPop.test.ts), and the dense corner and the realistic map at every ratio from 105 to 300 % (above), by size,
  // Age and Reclaim, in the dark theme; at 125 and 175 %, Windows' display scalings, no test painted every colour.
  const b = colourBlocks(EVERY_COLOUR, 16, 16);
  for (const dpr of [1.25, 1.75]) {
    for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
      const where = `the colour blocks, ${theme}, dpr ${dpr}`;
      const { raster, px } = rasterPaint(b.tiles, palette, b.W, b.H, b.colour, undefined, false, dpr);
      const m = measureEdges(raster, px, dpr);
      assert.ok(m.edges.length > EVERY_COLOUR.length * 9 * 8 * dpr, `${where}: control — ${m.edges.length} places a line meets a tile`);
      assert.deepEqual(m.under, [], `${where}: lines under ${EDGE_BAR}:1 against the tile beside them, on the device's pixels`);
      const p = partings(raster, px, dpr);
      assert.ok(p.looked > 500 * dpr, `${where}: control — ${p.looked} places along the sides of leaves of 8 px and up`);
      assert.deepEqual(p.unparted, [], `${where}: leaves of 8 px and up not parted from what lies beside them by a line`);
    }
  }
});
