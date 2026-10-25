import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-forecast-data-');

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

/** A snapshot of `snap`'s shape that records the "Don't scan" rules its scan ran under (undefined: an earlier build's, none). */
function ruled(daysAgo: number, totalSize: number, ignoreRules: string | undefined): Snapshot {
  return { ...snap(daysAgo, totalSize), ...(ignoreRules !== undefined ? { ignoreRules } : {}) };
}

test('a "Don\'t scan" rule dropped between two scans is not growth: the forecast fits only the scans since the rules last changed, and says why the earlier ones are set aside (leftover HE2-L2)', () => {
  // Nine daily scans under the rule `node_modules` count 40 GB; the owner drops the rule and the last
  // two count 100 GB. Nothing on disk changed. Fitted as one line it read as ~6 GB a day, "full in ~25 days".
  const nm = JSON.stringify(['node_modules']);
  const none = JSON.stringify([]);
  const history = [
    ...Array.from({ length: 9 }, (_, i) => ruled(10 - i, 40 * GB, nm)),
    ruled(1, 100 * GB, none),
    ruled(0, 100 * GB, none),
  ];
  const f = computeForecast(history, 150 * GB, NOW);
  assert.equal(f.status, 'insufficient', JSON.stringify(f));
  assert.equal(f.fullInDays, undefined, 'no projection across a change of rules');
  assert.equal(f.snapshotCount, 2, 'only the scans since the rules changed are counted');
  assert.equal(f.reason, 'Not enough history yet — 2 scans over 1 day. Forecasting needs at least 5 scans spanning 2+ days. 9 earlier scans came before your “Don’t scan” rules changed, so they are not compared with these.');
  // The control: the same sizes under one set of rules are a real step, and are fitted.
  const same = computeForecast(history.map((s) => ({ ...s, ignoreRules: nm })), 150 * GB, NOW);
  assert.notEqual(same.status, 'insufficient', 'under one set of rules the history is fitted whole');
  assert.equal(same.snapshotCount, 11);
  // Once enough scans under the new rules accumulate, only they are fitted: flat is stable.
  const later = [...history.map((s) => ({ ...s, takenAt: s.takenAt - 5 * DAY })), ...[4, 3, 2, 1, 0].map((d) => ruled(d, 100 * GB, none))];
  const settled = computeForecast(later, 150 * GB, NOW);
  assert.equal(settled.status, 'stable', JSON.stringify(settled));
  assert.equal(settled.snapshotCount, 7);
});

test('a snapshot an earlier build saved records no rules: the forecast does not fit it with one that does, either way round; two that record none fit as before (leftover HE2-L2)', () => {
  const none = JSON.stringify([]);
  const growing = (rules: (i: number) => string | undefined): Snapshot[] =>
    Array.from({ length: 10 }, (_, i) => ruled(9 - i, (100 + i) * GB, rules(i)));
  // Every scan before the update records no rules: one history, fitted as it always was.
  const before = computeForecast(growing(() => undefined), 50 * GB, NOW);
  assert.equal(before.status, 'ok');
  assert.equal(before.snapshotCount, 10);
  // The first scans after the update record theirs: not known to be the rules the earlier ones ran under.
  const after = computeForecast(growing((i) => (i >= 8 ? none : undefined)), 50 * GB, NOW);
  assert.equal(after.status, 'insufficient', JSON.stringify(after));
  assert.equal(after.snapshotCount, 2);
  assert.match(after.reason ?? '', / 8 earlier scans came before TreeMap began recording the “Don’t scan” rules each scan runs under, so they are not compared with these\.$/);
  // The reverse: the newest scans record none where the earlier ones did (a downgrade).
  const reverse = computeForecast(growing((i) => (i >= 9 ? undefined : none)), 50 * GB, NOW);
  assert.equal(reverse.status, 'insufficient', JSON.stringify(reverse));
  assert.equal(reverse.snapshotCount, 1);
  assert.match(reverse.reason ?? '', / 9 earlier scans came before a scan that records no “Don’t scan” rules, so they are not compared with these\.$/);
});

test('when the drives and the rules changed at the same scan, the forecast says both, once (leftover HE2-L2)', () => {
  const stay = { rule: 'stay' as const, notEntered: ['/r/mnt'] };
  const history = [
    ...Array.from({ length: 6 }, (_, i) => ({ ...ruled(7 - i, 40 * GB, JSON.stringify(['node_modules'])), boundary: stay })),
    ruled(1, 100 * GB, JSON.stringify([])),
  ];
  const f = computeForecast(history, 150 * GB, NOW);
  assert.equal(f.snapshotCount, 1);
  assert.match(f.reason ?? '', / 6 earlier scans stopped at different drives mounted inside this folder, and came before your “Don’t scan” rules changed, so they are not compared with these\.$/);
  // One earlier scan is "it".
  const one = computeForecast([ruled(3, 40 * GB, '["a"]'), ruled(2, 40 * GB, '["b"]'), ruled(1, 40 * GB, '["b"]')], 150 * GB, NOW);
  assert.match(one.reason ?? '', / 1 earlier scan came before your “Don’t scan” rules changed, so it is not compared with these\.$/);
});

test('AGENTS.md says the forecast fits only the scans since the drives or the "Don\'t scan" rules last changed, and that an update starts the history again (leftover HE2-L2)', () => {
  const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(agents.includes('The forecast (and MCP `forecast`) fits only the scans since the drives mounted inside the folder that a scan stopped at, or its "Don\'t scan" rules, last changed'), 'the rule is stated');
  assert.ok(agents.includes('A snapshot an earlier build saved records no rules, so it is not fitted with one this build saved: after an update the history starts again'), 'and what an update does');
});
