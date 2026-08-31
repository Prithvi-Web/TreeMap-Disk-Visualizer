import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Budget gauges (v4 §9.4) — the projected date a folder budget will be
 * breached, computed through the disk forecast's own honesty gates. The data
 * dir is pointed at a temp directory before the services load so nothing
 * here can ever touch a real snapshots.json.
 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-budget-gauges-'));
process.env.TREEMAP_DATA_DIR = DATA_DIR;

import { Snapshot, SnapshotTreeNode } from '../src/models/types';
import { budgetGauges, budgetHistorySeries, computeBudgetProjection } from '../src/services/budgetGauges';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const GB = 1024 ** 3;
const NOW = 1_800_000_000_000; // fixed "now" so every projection is deterministic

/** A series point `daysAgo` days back from NOW at `v` bytes. */
function pt(daysAgo: number, v: number): { t: number; v: number } {
  return { t: NOW - daysAgo * DAY, v };
}

function snap(rootPath: string, id: string, daysAgo: number, totalSize: number): Snapshot {
  return { id, rootPath, takenAt: NOW - daysAgo * DAY, totalSize, fileCount: 1, dirCount: 1, topEntries: [] };
}

/** Overwrite the isolated snapshot store with exactly these snapshots. */
function writeSnapshots(snaps: Snapshot[]): void {
  fs.writeFileSync(path.join(DATA_DIR, 'snapshots.json'), JSON.stringify({ snapshots: snaps }, null, 2));
}

/** Write a root's stored snapshot trees exactly the way saveSnapshot lays them out. */
function writeTrees(rootPath: string, trees: Record<string, SnapshotTreeNode>): void {
  const h = crypto.createHash('sha1').update(rootPath).digest('hex').slice(0, 16);
  fs.writeFileSync(path.join(DATA_DIR, `snapshot-trees-${h}.json`), JSON.stringify(trees));
}

/* ---------- computeBudgetProjection: the honesty gates ---------- */

test('steady growth projects a breach date through the ok gate', () => {
  // +1 GB/day for 10 days, currently 100 GB against a 105 GB budget → ~5 days.
  const series = Array.from({ length: 10 }, (_, i) => pt(9 - i, (91 + i) * GB));
  const p = computeBudgetProjection({ path: '/Users/t/Projects/app', maxBytes: 105 * GB }, 100 * GB, series, NOW);
  assert.equal(p.status, 'ok');
  assert.ok(Math.abs(p.breachInDays! - 5) < 0.5, `expected ~5 days, got ${p.breachInDays}`);
  assert.ok(p.confidence > 0, `confidence must be positive, got ${p.confidence}`);
  assert.ok(Math.abs(p.bytesPerDay - GB) / GB < 0.01, `expected ~1 GB/day, got ${p.bytesPerDay}`);
  assert.ok(p.breachAtMs !== undefined);
  assert.ok(
    Math.abs(p.breachAtMs! - (NOW + p.breachInDays! * DAY)) <= 1,
    'breachAtMs must be NOW plus breachInDays, to the millisecond',
  );
});

test('already over the limit reports the fact, not a forecast', () => {
  const p = computeBudgetProjection({ path: '/b', maxBytes: 100 * GB }, 110 * GB, [], NOW);
  assert.equal(p.status, 'over');
  assert.match(p.reason!, /limit/i);
  // Being over is a measured fact, not a projection — full confidence.
  assert.equal(p.confidence, 1);
  assert.equal(p.breachInDays, undefined);
  assert.equal(p.breachAtMs, undefined);

  // Exactly at the limit counts as over too — there is no headroom to project into.
  const q = computeBudgetProjection({ path: '/b', maxBytes: 100 }, 100, [], NOW);
  assert.equal(q.status, 'over');
});

test("two points an hour apart refuse with the forecast's own insufficiency reason", () => {
  const series = [{ t: NOW - HOUR, v: 10 * GB }, { t: NOW, v: 11 * GB }];
  const p = computeBudgetProjection({ path: '/b', maxBytes: 50 * GB }, 11 * GB, series, NOW);
  assert.equal(p.status, 'insufficient');
  // The reason must be computeForecast's own sentence, so it talks about
  // scans/history — asserted loosely on purpose, the prose is forecast.ts's.
  assert.match(p.reason!, /scan|history/i);
  assert.equal(p.breachInDays, undefined);
  assert.equal(p.breachAtMs, undefined);
});

test('erratic growth refuses to name a date', () => {
  // Bounces hard between 100 GB and 160 GB with a slight upward drift.
  const sizes = [100, 160, 102, 158, 104, 156, 106, 154, 108, 152];
  const series = sizes.map((v, i) => pt(sizes.length - 1 - i, v * GB));
  const p = computeBudgetProjection({ path: '/b', maxBytes: 200 * GB }, 152 * GB, series, NOW);
  assert.equal(p.status, 'erratic');
  assert.ok(p.reason, 'a refusal always carries its reason');
  assert.equal(p.breachInDays, undefined);
  assert.equal(p.breachAtMs, undefined);
});

test('a shrinking folder is called out, not projected', () => {
  const series = Array.from({ length: 8 }, (_, i) => pt(7 - i, (100 - i) * GB));
  const p = computeBudgetProjection({ path: '/b', maxBytes: 200 * GB }, 93 * GB, series, NOW);
  assert.equal(p.status, 'shrinking');
  assert.ok(p.reason);
  assert.equal(p.breachInDays, undefined);
});

test('a flat folder reads as stable, never as a breach date', () => {
  const series = Array.from({ length: 8 }, (_, i) => pt(7 - i, 100 * GB));
  const p = computeBudgetProjection({ path: '/b', maxBytes: 200 * GB }, 100 * GB, series, NOW);
  assert.equal(p.status, 'stable');
  assert.ok(p.reason);
  assert.equal(p.breachInDays, undefined);
});

/* ---------- budgetHistorySeries: where the points come from ---------- */

test("budgetHistorySeries prefers the folder's own snapshot history", async () => {
  const bp = '/Users/t/Projects/app';
  writeSnapshots([
    snap(bp, 'own-1', 2, 10 * GB),
    snap(bp, 'own-2', 1, 11 * GB),
    snap(bp, 'own-3', 0, 12 * GB),
  ]);
  const s = await budgetHistorySeries(bp);
  assert.equal(s.source, 'own-scans');
  assert.deepEqual(s.points, [pt(2, 10 * GB), pt(1, 11 * GB), pt(0, 12 * GB)]);
  assert.equal(s.caveat, undefined);
});

test('ancestor snapshot trees yield points only where the folder was recorded', async () => {
  const root = '/Users/t/Media';
  const bp = '/Users/t/Media/photos/raw'; // two levels below the scanned root
  writeSnapshots([
    snap(root, 'anc-1', 4, 100 * GB),
    snap(root, 'anc-2', 2, 110 * GB),
    snap(root, 'anc-3', 0, 120 * GB),
  ]);
  const withRaw = (rawBytes: number): SnapshotTreeNode => ({
    n: 'Media', s: 100 * GB, t: 1,
    c: [{ n: 'photos', s: 60 * GB, t: 1, c: [{ n: 'raw', s: rawBytes, t: 1 }] }],
  });
  // anc-2's shallow tree pruned `raw` away, as the 2–3-level budget can.
  const without: SnapshotTreeNode = {
    n: 'Media', s: 110 * GB, t: 1,
    c: [{ n: 'photos', s: 60 * GB, t: 1 }],
  };
  writeTrees(root, { 'anc-1': withRaw(40 * GB), 'anc-2': without, 'anc-3': withRaw(55 * GB) });

  const s = await budgetHistorySeries(bp);
  assert.equal(s.source, 'ancestor-trees');
  assert.deepEqual(s.points, [pt(4, 40 * GB), pt(0, 55 * GB)]);
  assert.match(s.caveat!, /shallow/i);
  assert.match(s.caveat!, /level/i);
});

test("segment matching follows the platform's case rule", async () => {
  const root = '/srv/data';
  const bp = '/srv/data/Logs/App'; // the stored tree spells these lower-case
  writeSnapshots([snap(root, 'case-1', 1, GB)]);
  writeTrees(root, {
    'case-1': { n: 'data', s: GB, t: 1, c: [{ n: 'logs', s: GB / 2, t: 1, c: [{ n: 'app', s: GB / 4, t: 1 }] }] },
  });
  const s = await budgetHistorySeries(bp);
  if (process.platform === 'linux') {
    // Case-sensitive filesystems: 'Logs' and 'logs' are different folders.
    assert.equal(s.source, 'none');
  } else {
    assert.equal(s.source, 'ancestor-trees');
    assert.equal(s.points[0].v, GB / 4);
  }
});

test('no history anywhere → source none, and the gauge refuses with a reason', async () => {
  writeSnapshots([]);
  const s = await budgetHistorySeries('/nowhere/special');
  assert.equal(s.source, 'none');
  assert.deepEqual(s.points, []);

  const [g] = await budgetGauges([{ path: '/nowhere/special', maxBytes: 10 * GB }], () => 5 * GB);
  assert.equal(g.projection.status, 'insufficient');
  assert.ok(g.projection.reason, 'a refusal always carries its reason');
  assert.equal(g.projection.seriesSource, 'none');
  assert.equal(g.projection.seriesPoints, 0);
  assert.equal(g.actualBytes, 5 * GB);
  assert.equal(g.ratio, 0.5);
  assert.equal(g.name, 'special');
});

test('a budget outside the current scan is unknown, never zero', async () => {
  writeSnapshots([]);
  const [g] = await budgetGauges([{ path: '/elsewhere/folder', maxBytes: 10 * GB }], () => null);
  assert.equal(g.actualBytes, null);
  assert.equal(g.ratio, null);
  assert.equal(g.projection.status, 'insufficient');
  assert.match(g.projection.reason!, /not inside the current scan/);
  assert.equal(g.projection.confidence, 0);
  assert.equal(g.projection.bytesPerDay, 0);
  assert.equal(g.projection.seriesSource, 'none');
  assert.equal(g.projection.seriesPoints, 0);
});

test('own scan history wins outright over ancestor coverage', async () => {
  const root = '/Users/t/Work';
  const bp = '/Users/t/Work/repo';
  writeSnapshots([
    snap(root, 'root-1', 3, 50 * GB),
    snap(root, 'root-2', 1, 52 * GB),
    snap(root, 'root-3', 0, 53 * GB),
    snap(bp, 'own-a', 2, 20 * GB),
    snap(bp, 'own-b', 0, 21 * GB),
  ]);
  writeTrees(root, {
    'root-1': { n: 'Work', s: 50 * GB, t: 1, c: [{ n: 'repo', s: 19 * GB, t: 1 }] },
    'root-2': { n: 'Work', s: 52 * GB, t: 1, c: [{ n: 'repo', s: 20 * GB, t: 1 }] },
    'root-3': { n: 'Work', s: 53 * GB, t: 1, c: [{ n: 'repo', s: 21 * GB, t: 1 }] },
  });
  const s = await budgetHistorySeries(bp);
  assert.equal(s.source, 'own-scans');
  // Own history only — exact and approximate never mix in one series.
  assert.equal(s.points.length, 2);
  assert.deepEqual(s.points.map((p) => p.v), [20 * GB, 21 * GB]);
});

/* ---------- budgetGauges: the wired-together shape ---------- */

test('gauges wire history, actuals and projection together', async () => {
  const bp = '/Users/t/Projects/site';
  writeSnapshots(Array.from({ length: 10 }, (_, i) => snap(bp, `g-${i}`, 9 - i, (91 + i) * GB)));
  const [g] = await budgetGauges([{ path: bp, maxBytes: 105 * GB }], () => 100 * GB);
  assert.equal(g.path, bp);
  assert.equal(g.name, 'site');
  assert.equal(g.maxBytes, 105 * GB);
  assert.equal(g.actualBytes, 100 * GB);
  assert.ok(g.ratio! > 0.94 && g.ratio! < 0.96);
  assert.equal(g.projection.seriesSource, 'own-scans');
  assert.equal(g.projection.seriesPoints, 10);
  assert.equal(g.projection.status, 'ok');
  // The series is an exact 1 GB/day line, so the fit is exact whatever
  // Date.now() is — only breachAtMs depends on the wall clock.
  assert.ok(Math.abs(g.projection.breachInDays! - 5) < 0.5);
  assert.ok(g.projection.breachAtMs! > 0);
});
