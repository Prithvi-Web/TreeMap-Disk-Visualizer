import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-mapNoHardStep-data-');

import {
  DARK, EVERY_COLOUR, LIGHT, TAPER_COLOURS, assertNoHardStep,
} from './fixtures/mapRaster';

/**
 * The owner's refinement "no hard step at 8 px" (20 Oct 2026), swept on uniform grids of tiles 1 to 18 px: the share of
 * pixels a line or a texture takes, and the mean lightness against the tile's own solid colour, change smoothly from one
 * size to the next. Split from tests/mapColourPop.test.ts (BQV), whose sweeps had grown past CI's 20-minute limit a test
 * file; the harness is tests/fixtures/mapRaster.ts.
 */

test('owner\'s refinement: no hard step at 8 px — on uniform grids of tiles 1 to 18 px, the share of pixels a line or a texture takes (from 5 px) and the mean lightness against the tile\'s own solid colour (from 3 px) change smoothly from one size to the next — under 2 L* a step, 7 to 8 px too, at every ratio — and the shade a leaf with a texture is filled with moves under 2 L* a size, from none at 1 px to the whole at 7, in both themes, on the size ramp, Reclaim\'s "not scored" grey and an Age band, at device pixel ratios 0.667, 0.8, 1, 1.25, 1.5, 1.75 and 2 (review F3.2, F3.6; residual 3; review F1.6, F1.11)', () => {
  // 7 px tiles were one flat block and 8 px tiles a heavy 2 px grid (each leaf drew its own outline, so neighbours met at
  // 2 px): 0% to 43.8% of the pixels, and 15 L* darker, in one step. Now two leaves with lines meet at one 1 px line, and
  // a smaller leaf draws a 1 px texture where they would meet: a 1 px seam per tile at every size, whose share falls as
  // 1 − ((s − 1)/s)² — each step smaller than the one before (5.4 points from 5 to 6 px, 3.1 from 7 to 8). That is the
  // bound: no step bigger than the one before it, by more than half a point. The seam is the owner's faint texture
  // (1.4:1 at 7 px) below 8 px and the owner's 3:1 line from 8 px, so the mean lightness stepped most at 7→8 px — 6.3 L* on the
  // size ramp's amber (from 3.4 L* under the solid fill to 9.7), and a lone 8 px row among 7 px rows read as a dark stripe
  // (residual 3). A leaf with lines is now filled a shade lighter (or darker, under light lines) by just enough that it
  // keeps the mean lightness a 7 px tile's texture gives (tmEdgedFill), its chroma kept whole; on amber, orange and red,
  // which cannot be lightened so, the leaves with a texture are darkened instead, more the bigger they are, to meet the
  // 8 px leaf (tmTexturePull). So the lightness — measured against the cushion the tile's own colour gets with nothing
  // on it — steps under 2 L* at every size, 7→8 px too.
  // At 2× a 1 px seam is two device pixels of a tile's 2s: the same share. At 125, 150 and 175 % a texture's seam covers a
  // device pixel and part of the next, which `apart` counts whole: there the share is held as the seams' `ink` (tileLook),
  // each pixel counted by how much of it a seam covers — the formula's share at every ratio, within a point and a half. A
  // line there is a whole number of device pixels (devicePx: one at 125, 150 and 175 %, residual 4), so its share
  // is the formula's for a seam that wide — thinner than the texture's at 125, 150 and 175 %, where the share falls at 8 px while
  // the line's weight rises, and the mean lightness alone is held across that step. A painter that laid each 8 px tile its
  // own right and bottom line at those ratios put a 2 px grid back: 43.7% of the 8 px tiles' area at 150 %, against 26.4%
  // for 7 px (review F3.2). On a page zoomed out (ratio 0.8, 0.667) the painter's px is a device pixel, so the grids are of
  // tiles 5 to 18 device px, and a seam is one device pixel (review F3.6).
  // Under 5 px: from 1 px, where a tile has no texture, the owner's texture starts at 2 px (1.1:1, taken by size on the
  // device's pixels, so at 125 and 175 % the 2 px grid is part 2 px and part 1.6), a step of its own of 2.3 to 3.6 L*;
  // from 3 px the lightness is held under 2 L* a step as above. And the shade the painter moves a textured leaf's fill
  // to, toward the 8 px leaf (tmTexturedFill), is held to move under 2 L* a size from 1 px to 7: filled the whole way
  // at every size, a 2 px grid stood 8.6 L* under a 1 px one, and nothing looked under 5 px (review F1.11).
  const grey = TAPER_COLOURS.find((c) => c.name === 'Reclaim not scored')!;
  const runs = [...TAPER_COLOURS.map((c) => ({ c, dpr: 1 })), { c: TAPER_COLOURS[1], dpr: 2 },
    ...[1.25, 1.5, 1.75].map((dpr) => ({ c: TAPER_COLOURS[1], dpr })), { c: grey, dpr: 1.5 }, { c: TAPER_COLOURS[1], dpr: 0.8 }, { c: grey, dpr: 0.667 }];
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    for (const { c, dpr } of runs) assertNoHardStep(theme, palette, c, dpr);
  }
});

test('owner\'s refinement: no hard step at 8 px on every colour the map paints — the whole size ramp, every Reclaim score and "not scored", every Age band, the History diff colours and the Trash cell — at 100 % and 150 %, in both themes: the fill a leaf with lines is given is the one nearest its target that a try found, never wherever a fourth try left it (review F2.1)', () => {
  // The fill of a leaf with lines (tmEdgedFill), and the pull on a textured leaf (tmTexturePull), are solved by the
  // secant through the shifts tried — but the mean lightness moves in steps (each fill is whole sRGB values, about
  // 0.3 L* apart) and stops where the colour meets sRGB's edge, and a secant through two tries on one step was flung
  // far off and kept, the fourth try being the last: Reclaim 67's 8 px tiles were left at a shift of 2.3 where 6.5 had
  // been found, 3.8 L* darker than its 9 px tiles — and its textured leaves were pulled darker to meet them, 3.3 to
  // 6.6 L* under the solid colour — Reclaim 66's 13 px tiles at a shift of −2.8, 5.7 L* darker than its 12 px and 5.5
  // than its 14 px; Reclaim 43's 13 px 3.2 L* lighter than its 14 px; and the 17 or 18 px tiles of Reclaim 7 and 65 and
  // the size ramp at 0.35 2.2 to 2.3 L* off their neighbours. The sweep above painted five colours at 100 %, and none
  // of these. Every colour, at a whole ratio and a fractional one.
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    for (const dpr of [1, 1.5]) for (const c of EVERY_COLOUR) assertNoHardStep(theme, palette, c, dpr);
  }
});
