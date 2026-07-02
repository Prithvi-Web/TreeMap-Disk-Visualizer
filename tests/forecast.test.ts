import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Snapshot } from '../src/models/types';
import { computeForecast, fitGrowth } from '../src/services/forecast';

/** Forecast math tests — the honesty gates are the contract here. */

const DAY = 86_400_000;
const NOW = 1_800_000_000_000; // fixed "now" so tests are deterministic

function snap(daysAgo: number, totalSize: number, tops: { name: string; size: number }[] = []): Snapshot {
  return {
    id: `s${daysAgo}`,
    rootPath: '/r',
    takenAt: NOW - daysAgo * DAY,
    totalSize,
    fileCount: 1,
    dirCount: 1,
    topEntries: tops.map((t) => ({ name: t.name, path: `/r/${t.name}`, size: t.size, type: 'dir' as const })),
  };
}

const GB = 1024 ** 3;

test('steady linear growth produces an accurate fullInDays', () => {
  // +1 GB/day for 10 days, 50 GB free → full in ~50 days.
  const snaps = Array.from({ length: 10 }, (_, i) => snap(9 - i, (100 + i) * GB));
  const f = computeForecast(snaps, 50 * GB, NOW);
  assert.equal(f.status, 'ok');
  assert.ok(Math.abs(f.fullInDays! - 50) < 1, `expected ~50, got ${f.fullInDays}`);
  assert.ok(f.confidence > 0.5, `confidence should be strong, got ${f.confidence}`);
  assert.ok(Math.abs(f.bytesPerDay - GB) / GB < 0.01);
});

test('recent-weighted fit reacts to acceleration faster than a plain line', () => {
  // Flat for 20 days, then +2 GB/day for the last 5 — the weighted slope
  // must sit well above the all-history average.
  const sizes = [
    ...Array.from({ length: 20 }, () => 100 * GB),
    ...Array.from({ length: 5 }, (_, i) => (100 + 2 * (i + 1)) * GB),
  ];
  const snaps = sizes.map((v, i) => snap(sizes.length - 1 - i, v));
  const points = snaps.map((s) => ({ t: s.takenAt, v: s.totalSize }));
  const linear = fitGrowth(points, null, NOW);
  const weighted = fitGrowth(points, 7, NOW); // the service's half-life
  assert.ok(weighted.slopePerDay > linear.slopePerDay * 1.5,
    `weighted ${weighted.slopePerDay} should out-react linear ${linear.slopePerDay}`);
});

test('honesty gate: fewer than 5 snapshots → insufficient', () => {
  const snaps = Array.from({ length: 4 }, (_, i) => snap(3 - i, (100 + i) * GB));
  const f = computeForecast(snaps, 50 * GB, NOW);
  assert.equal(f.status, 'insufficient');
  assert.equal(f.fullInDays, undefined);
  assert.match(f.reason!, /Not enough history/);
});

test('honesty gate: five scans within an hour → insufficient (span too short)', () => {
  const snaps = Array.from({ length: 6 }, (_, i) => snap(i / 200, (100 + i) * GB)); // ~7-min gaps
  const f = computeForecast(snaps, 50 * GB, NOW);
  assert.equal(f.status, 'insufficient');
  assert.equal(f.fullInDays, undefined);
});

test('honesty gate: erratic sizes → no number', () => {
  // Bounces hard between 100 GB and 160 GB with a slight upward drift.
  const sizes = [100, 160, 102, 158, 104, 156, 106, 154, 108, 152];
  const snaps = sizes.map((v, i) => snap(sizes.length - 1 - i, v * GB));
  const f = computeForecast(snaps, 50 * GB, NOW);
  assert.equal(f.status, 'erratic');
  assert.equal(f.fullInDays, undefined);
  assert.ok(f.confidence < 0.3, `erratic data must not be confident, got ${f.confidence}`);
});

test('flat and shrinking histories are called out, not projected', () => {
  const flat = computeForecast(Array.from({ length: 8 }, (_, i) => snap(7 - i, 100 * GB)), 50 * GB, NOW);
  assert.equal(flat.status, 'stable');
  const shrinking = computeForecast(Array.from({ length: 8 }, (_, i) => snap(7 - i, (100 - i) * GB)), 50 * GB, NOW);
  assert.equal(shrinking.status, 'shrinking');
  assert.equal(shrinking.fullInDays, undefined);
});

test('growth too slow to matter reads as stable, not "full in 9 years"', () => {
  // +2 MB/day with 500 GB free → ~700 years out.
  const snaps = Array.from({ length: 10 }, (_, i) => snap(9 - i, 100 * GB + i * 2 * 1_048_576));
  const f = computeForecast(snaps, 500 * GB, NOW);
  assert.equal(f.status, 'stable');
});

test('topGrowers ranks the fastest-growing top-level folders', () => {
  const snaps = Array.from({ length: 8 }, (_, i) =>
    snap(7 - i, (100 + 3 * i) * GB, [
      { name: 'Movies', size: (50 + 2 * i) * GB },  // +2 GB/day
      { name: 'Projects', size: (30 + i) * GB },    // +1 GB/day
      { name: 'Docs', size: 10 * GB },              // flat
    ]));
  const f = computeForecast(snaps, 500 * GB, NOW);
  assert.equal(f.status, 'ok');
  assert.equal(f.topGrowers[0].name, 'Movies');
  assert.equal(f.topGrowers[1].name, 'Projects');
  assert.ok(!f.topGrowers.some((g) => g.name === 'Docs'), 'flat folders are not culprits');
  assert.ok(Math.abs(f.topGrowers[0].bytesPerDay - 2 * GB) / GB < 0.1);
});

test('an entry missing from the latest snapshot is never a culprit', () => {
  const snaps = Array.from({ length: 8 }, (_, i) =>
    snap(7 - i, (100 + i) * GB, i < 7
      ? [{ name: 'Temp', size: (10 + 5 * i) * GB }] // grows fast, then vanishes
      : []));
  const f = computeForecast(snaps, 500 * GB, NOW);
  assert.ok(!f.topGrowers.some((g) => g.name === 'Temp'));
});
