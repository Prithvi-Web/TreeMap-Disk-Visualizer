import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEX, lift } from './fixtures/liftFrontend';

/**
 * Design pass G13 — plain words on everyday screens.
 *
 * The Sunburst's footer read "52 segments · 4 rings": geometry, not anything
 * a person can check against the picture. Duplicates said "+116.7 MB
 * reclaimable", and a leading plus reads as growth. (The engine row, the
 * index badge and the System card's Trash row are held where their other
 * rules are: engineSettingUi, engineBudgetUi, polishUiScan, dashboardWiring.)
 */

function slice(a: string, b: string): string {
  const i = INDEX.indexOf(a);
  assert.notEqual(i, -1, `anchor "${a}" exists`);
  const j = INDEX.indexOf(b, i + a.length);
  assert.notEqual(j, -1, `anchor "${b}" follows`);
  return INDEX.slice(i, j);
}

test('the Sunburst footer says what is drawn — files and folders, how many levels — not "segments · rings" (G13)', () => {
  const line = lift<(drawn: number, levels: number, bytes: number) => string>(['UNITS', 'UI_LOCALE', 'formatBytes', 'formatCount', 'sunStatusLine'], 'sunStatusLine');
  assert.equal(line(52, 4, 9_500_000_000), '52 files and folders shown, up to 4 levels deep · 9.5 GB total');
  assert.equal(line(1, 2, 1000), '1 file or folder shown, up to 2 levels deep · 1.0 KB total', 'one is one');
  assert.equal(line(12_488, 7, 0), '12,488 files and folders shown, up to 7 levels deep · 0 B total');
  const frame = slice('function renderSunburstFrame(', 'function drawSunburst(');
  assert.match(frame, /: sunStatusLine\(arcs\.length, geo\.rings, root\.size\);/, 'the footer is written through it');
  assert.doesNotMatch(frame, /segments ·|rings ·/, 'and the geometry words are gone');
});

test('Duplicates says how much is reclaimable without a plus, which reads as growth (G13)', () => {
  const exact = slice('function renderDuplicates', '/* ── What the reclaimable figure does not promise ── */');
  const near = slice('<span class="nd-count">', '<button class="pill" data-nd-view=');
  assert.match(exact, /<span class="reclaim num">\$\{formatBytes\(g\.reclaimable\)\} reclaimable<\/span>/, 'each exact group');
  assert.match(near, /<span class="reclaim num">\$\{formatBytes\(c\.reclaimableBytes\)\} reclaimable<\/span>/, 'each cluster of similar images');
  const script = INDEX.slice(INDEX.indexOf('<script'));
  assert.doesNotMatch(script, />\+\$\{formatBytes\([^)]*\)\} reclaimable/, 'no "+" before a reclaimable figure anywhere');
});
