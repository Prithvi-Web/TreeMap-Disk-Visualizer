import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-mapRatioSweeps-data-');

import {
  DARK, DENSE_PX, EDGE_BAR, EVERY_COLOUR, REAL_H, REAL_W, bandStep, colourBlocks, denseCornerNodes, devicePx,
  hashColouring, measureEdges, partings, rasterPaint, realisticNodes, type RGB, type Tile,
} from './fixtures/mapRaster';

/**
 * The owner's outlines at every device pixel ratio from 100 to 300 %: every line and band a whole number of device
 * pixels, at 3:1 against the tile beside it, and every file of 8 px and up parted from what lies beside it. Split from
 * tests/mapColourPop.test.ts (BQV), whose sweeps had grown past CI's 20-minute limit a test file; the harness is
 * tests/fixtures/mapRaster.ts.
 */

test('owner\'s refinement at every ratio from 105 to 300 %: every leaf\'s line and every folder\'s band reaches 3:1 against the tile beside it on the device\'s pixels, and every file of 8 px and up is parted by 3:1 from what lies beside it (partings) — where a file meets a sliver an ancestor\'s band covers too — on the dense corner at every 0.05 from 1.05 to 3, coloured by size, Age and Reclaim, on the realistic map at every 0.1 from 1.1 to 3 and at 1.15, 1.55, 1.65 and 2.65, coloured by Age and Reclaim, and on the realistic map 800×500 and 1043×741 css px at 1.5 and 2.2 (review F2.3 of BQJ-2c-r; residual 7)', () => {
  // While a band was a whole number of css px, at a ratio that did not make it a whole number of device pixels its inner
  // edge fell inside one, which it covered in part. Laid over a nested folder's band whose edge lay under it — a sliver of
  // a file between their edges, under the band — it covered that band's one whole device pixel in part too, and the nested
  // band showed only as two blends: at 160 % /L/a5's 3 css px bottom band, device rows 262.2 to 267, over /L/a5/b1/c2's 1
  // css px band, 261.4 to 263, left c2's band 2.58:1 from the red file inside it (review F2.3 of BQJ-2c-r). And where a
  // file met such a sliver, the band's part-covered device pixel lay on the file's own edge: a blend 1.88:1 from the file
  // beside it, on the realistic map coloured by Reclaim at 115, 120 and 190 %, and 800×500 and 1043×741 css px at 150 and
  // 220 % (residual 7) — which measureEdges, stepping over a band's part-covered pixel, never saw, and partings (which
  // steps over none) was not run here for it. Every line and band is now whole device pixels (residual 4), so both
  // oracles run at every ratio. The test above paints these maps at 1, 1.25, 1.5, 1.75 and 2 alone. The dense corner is
  // swept at every 0.05, and the realistic map, over three times its area, at every 0.1 and at the four further ratios
  // where it showed, by Age, where it showed, and by Reclaim (by size none of its lines fell under 3:1 at any 0.05 from
  // 1.05 to 3 in a sweep made while fixing F2.3, before the fix or after it). The theme does not move a line (the same
  // places failed in both), so the dark one is painted.
  const dense = denseCornerNodes(), real = realisticNodes();
  const colourings: Array<[string, ((n: Tile) => RGB) | undefined]> = [['size', undefined], ['Age', hashColouring('age')], ['Reclaim', hashColouring('reclaim')]];
  const maps: Array<[string, Tile[], number, number, number[], typeof colourings]> = [
    ['the dense corner', dense, DENSE_PX, DENSE_PX, Array.from({ length: 40 }, (_, i) => +(1.05 + i * 0.05).toFixed(2)), colourings],
    ['the realistic map', real, REAL_W, REAL_H, [...Array.from({ length: 20 }, (_, i) => +(1.1 + i * 0.1).toFixed(1)), 1.15, 1.55, 1.65, 2.65], colourings.slice(1)],
    ['the realistic map 800×500', real, 800, 500, [1.5, 2.2], colourings.slice(1)],
    ['the realistic map 1043×741', real, 1043, 741, [1.5, 2.2], colourings.slice(1)],
  ];
  for (const [what, tiles, W, H, ratios, cols] of maps) {
    for (const dpr of ratios) {
      for (const [colouring, colour] of cols) {
        const where = `${what}, dark, dpr ${dpr}, by ${colouring}`;
        const { raster, px } = rasterPaint(tiles, DARK, W, H, colour, undefined, false, dpr);
        const m = measureEdges(raster, px, dpr);
        assert.ok(m.edges.length > (what === 'the dense corner' ? 5000 : 20000) * dpr, `${where}: control — ${m.edges.length} places a line meets a tile`);
        assert.deepEqual(m.under, [], `${where}: lines under ${EDGE_BAR}:1 against a tile beside them`);
        const p = partings(raster, px, dpr);
        assert.ok(p.looked > (what === 'the dense corner' ? 300 : 10000) * dpr, `${where}: control — ${p.looked} places a file of 8 px and up meets what lies beside it`);
        assert.deepEqual(p.unparted, [], `${where}: files not parted by ${EDGE_BAR}:1 from what lies beside them`);
      }
    }
  }
});

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
