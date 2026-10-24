import { test } from 'node:test';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-mapNoHardStepHighRatios-data-');

import { DARK, EVERY_COLOUR, LIGHT, assertNoHardStep } from './fixtures/mapRaster';

/**
 * Item 44 (BQV): the owner's refinement "no hard step at 8 px" on every colour the map paints, at 175 %, a Windows
 * display scaling, and on a Retina screen (200 %). The every-colour sweep in tests/mapNoHardStep.test.ts paints
 * every colour at 100 and 150 %, and at 175 and 200 % one colour, a 400 MB file's amber. Here each of these ratios
 * paints every colour, in both themes, held to the same checks (assertNoHardStep): the seams' share of the pixels
 * from 5 px, the mean lightness under 2 L* a step from 3 px — 7 to 8 px too — and the shade a textured leaf is
 * filled with under 2 L* a size. Each ratio is a test of its own, so a failure names its ratio; 67, 80 and 125 %
 * are tests/mapNoHardStepLowRatios.test.ts. They are two files because each ratio takes about a minute on Node 20,
 * and CI holds a file to 20 minutes on runners up to 2.6 times as slow.
 */

test('owner\'s refinement: no hard step at 8 px on every colour the map paints at 175 % (device pixel ratio 1.75) — the whole size ramp, every Reclaim score and "not scored", every Age band, the History diff colours and the Trash cell, in both themes, held as at 100 % and 150 % (item 44)', () => {
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) for (const c of EVERY_COLOUR) assertNoHardStep(theme, palette, c, 1.75);
});

test('owner\'s refinement: no hard step at 8 px on every colour the map paints on a Retina screen (device pixel ratio 2) — the whole size ramp, every Reclaim score and "not scored", every Age band, the History diff colours and the Trash cell, in both themes, held as at 100 % and 150 % (item 44)', () => {
  for (const [theme, palette] of [['dark', DARK], ['light', LIGHT]] as const) for (const c of EVERY_COLOUR) assertNoHardStep(theme, palette, c, 2);
});
