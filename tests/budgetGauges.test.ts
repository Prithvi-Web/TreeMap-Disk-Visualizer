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
import { isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
const DATA_DIR = isolatedDataDir('tm-budget-gauges-');

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

test('a budget\'s history starts again where the drives a scan stopped at changed (Track U, U-24)', () => {
  // Six scans that went into a drive mounted inside (35 GB of it), growing a GB a day; then two that stayed out.
  const stay = { rule: 'stay' as const, notEntered: ['/b/sim'] };
  const series = [
    ...Array.from({ length: 6 }, (_, i) => pt(10 - i, (135 + i) * GB)),
    { ...pt(2, 105 * GB), boundary: stay },
    { ...pt(1, 106 * GB), boundary: stay },
  ];
  const p = computeBudgetProjection({ path: '/b', maxBytes: 200 * GB }, 106 * GB, series, NOW);
  assert.equal(p.status, 'insufficient', `the 35 GB step is a drive, not shrinkage (got ${p.status}: ${p.reason ?? ''})`);
  assert.match(p.reason ?? '', /6 earlier scans came before a change in the drives mounted inside this folder that a scan stops at or enters, so they are not compared with these\./);
});

test('a budget\'s history starts again where the "Don\'t scan" rules changed, as the forecast\'s does (leftover HE2-L2)', () => {
  // Six scans under the rule `node_modules`, flat at 40 GB; the rule dropped, two count 100 GB. Nothing grew.
  const nm = JSON.stringify(['node_modules']);
  const series = [
    ...Array.from({ length: 6 }, (_, i) => ({ ...pt(10 - i, 40 * GB), ignoreRules: nm })),
    { ...pt(2, 100 * GB), ignoreRules: JSON.stringify([]) },
    { ...pt(1, 100 * GB), ignoreRules: JSON.stringify([]) },
  ];
  const p = computeBudgetProjection({ path: '/b', maxBytes: 200 * GB }, 100 * GB, series, NOW);
  assert.equal(p.status, 'insufficient', `the 60 GB step is a rule, not growth (got ${p.status}: ${p.reason ?? ''})`);
  assert.match(p.reason ?? '', /6 earlier scans came before your “Don’t scan” rules changed, so they are not compared with these\./);
  const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(agents.includes('Like the forecast, it fits only the scans since the drives mounted inside the budget folder that a scan stopped at, or the "Don\'t scan" rules, last changed'), 'AGENTS.md says so');
});

test('each point carries the "Don\'t scan" rules its scan ran under, from the folder\'s own snapshots or an ancestor\'s (leftover HE2-L2)', async () => {
  const bp = '/Users/t/Projects/rules';
  writeSnapshots([
    snap(bp, 'own-r1', 1, 10 * GB),
    { ...snap(bp, 'own-r2', 0, 11 * GB), ignoreRules: '["node_modules"]' },
  ]);
  assert.deepEqual((await budgetHistorySeries(bp)).points, [pt(1, 10 * GB), { ...pt(0, 11 * GB), ignoreRules: '["node_modules"]' }]);
  const root = '/Users/t/Media';
  const raw = '/Users/t/Media/photos/raw';
  writeSnapshots([
    snap(root, 'anc-r1', 1, 100 * GB),
    { ...snap(root, 'anc-r2', 0, 100 * GB), ignoreRules: '[]' },
  ]);
  const tree: SnapshotTreeNode = { n: 'Media', s: 100 * GB, t: 1, c: [{ n: 'photos', s: 60 * GB, t: 1, c: [{ n: 'raw', s: 40 * GB, t: 1 }] }] };
  writeTrees(root, { 'anc-r1': tree, 'anc-r2': tree });
  assert.deepEqual((await budgetHistorySeries(raw)).points, [pt(1, 40 * GB), { ...pt(0, 40 * GB), ignoreRules: '[]' }]);
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

test('each point carries the drives its scan stopped at — for a folder below the root, only the drives inside that folder (Track U, U-24)', async () => {
  const bp = '/Users/t/Projects/app';
  writeSnapshots([
    snap(bp, 'own-b1', 1, 10 * GB),
    { ...snap(bp, 'own-b2', 0, 11 * GB), boundary: { rule: 'stay', notEntered: [`${bp}/disk`] } },
  ]);
  const own = await budgetHistorySeries(bp);
  assert.deepEqual(own.points, [pt(1, 10 * GB), { ...pt(0, 11 * GB), boundary: { rule: 'stay', notEntered: [`${bp}/disk`] } }]);

  const root = '/Users/t/Media';
  const raw = '/Users/t/Media/photos/raw';
  writeSnapshots([
    { ...snap(root, 'anc-b1', 1, 100 * GB), boundary: { rule: 'stay', notEntered: ['/Users/t/Media/elsewhere'] } },
    { ...snap(root, 'anc-b2', 0, 100 * GB), boundary: { rule: 'stay', notEntered: ['/Users/t/Media/elsewhere', `${raw}/card`] } },
  ]);
  const tree: SnapshotTreeNode = { n: 'Media', s: 100 * GB, t: 1, c: [{ n: 'photos', s: 60 * GB, t: 1, c: [{ n: 'raw', s: 40 * GB, t: 1 }] }] };
  writeTrees(root, { 'anc-b1': tree, 'anc-b2': tree });
  const anc = await budgetHistorySeries(raw);
  assert.deepEqual(anc.points, [
    pt(1, 40 * GB), // a drive left out elsewhere in /Users/t/Media changes nothing in raw
    { ...pt(0, 40 * GB), boundary: { rule: 'stay', notEntered: [`${raw}/card`] } },
  ]);
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

test('a gauge counts the scans its rate was fitted over apart from every point of its history: an update starts the run again (HE3 review F1.2)', async () => {
  const bp = '/Users/t/Projects/updated';
  // Four scans an earlier build saved (no rules recorded), then six since the update, a GB a day.
  writeSnapshots([
    ...Array.from({ length: 4 }, (_, i) => snap(bp, `old-${i}`, 12 - i, 80 * GB)),
    ...Array.from({ length: 6 }, (_, i) => ({ ...snap(bp, `new-${i}`, 5 - i, (95 + i) * GB), ignoreRules: '[]' })),
  ]);
  const [g] = await budgetGauges([{ path: bp, maxBytes: 105 * GB }], () => 100 * GB);
  assert.equal(g.projection.status, 'ok', JSON.stringify(g.projection));
  assert.equal(g.projection.seriesPoints, 10, 'every point of the history');
  assert.equal(g.projection.fitPoints, 6, 'the scans the rate rests on: those since the update');
});

test('the dashboard projection line\'s hover text says the scans the rate was fitted over, not every point of the history (HE3 review F1.2)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const start = html.indexOf('function budgetProjectionLine');
  const fn = html.slice(start, html.indexOf('function shortProjectionReason'));
  const projection = { status: 'ok', confidence: 0.9, bytesPerDay: GB, breachInDays: 5, breachAtMs: NOW + 5 * DAY, seriesSource: 'own-scans', seriesPoints: 106, fitPoints: 6 };
  const line = new Function('state', 'formatBytes', 'formatDay', 'escapeHtml', `${fn}; return budgetProjectionLine;`)(
    { budgets: { gauges: new Map([['/b', { projection }]]) } }, (n: number) => `${n} B`, () => 'the day', (x: unknown) => String(x),
  ) as (b: { path: string; overBy: number }) => string;
  const out = line({ path: '/b', overBy: 0 });
  assert.match(out, new RegExp(`title="${GB} B/day over 6 scans"`), out);
});

/* ══════════════ The route (wired by the parent session) ══════════════ */

import http from 'node:http';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { updateSettings } from '../src/services/settings';

function reqHttp(port: number, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, path: url, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

test('GET /api/scan/:id/budget-gauges reports each in-scan budget with an honest projection', async () => {
  resetRateLimiter();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-gauge-route-'));
  try {
    fs.mkdirSync(path.join(fx, 'inside'));
    fs.writeFileSync(path.join(fx, 'inside', 'a.bin'), Buffer.alloc(50_000, 1));

    await updateSettings({ budgets: [
      { path: path.join(fx, 'inside'), maxBytes: 1_000_000 },
      { path: path.join(os.tmpdir(), 'tm-gauge-elsewhere-root'), maxBytes: 5 },
    ] });

    const scan = await reqHttp(port, 'POST', '/api/scan', { path: fx });
    assert.ok(scan.status === 200 || scan.status === 202, JSON.stringify(scan.body));
    const scanId = scan.body.scanId;
    await waitFor(async () => (await reqHttp(port, 'GET', `/api/scan/${scanId}/result`)).status === 200, 'the fixture scan completing', 50);

    const g = await reqHttp(port, 'GET', `/api/scan/${scanId}/budget-gauges`);
    assert.equal(g.status, 200, JSON.stringify(g.body));
    const gauges = g.body.gauges as any[];
    assert.equal(gauges.length, 1, 'the budget outside this scan root is filtered, like /budgets');
    const gauge = gauges[0];
    assert.equal(gauge.maxBytes, 1_000_000);
    assert.equal(gauge.actualBytes, 50_000, 'the size comes from the scan itself');
    // A folder scanned for the first time has no history: the projection must
    // REFUSE with the forecast's own reason, never invent a breach date.
    assert.equal(gauge.projection.status, 'insufficient');
    assert.ok(gauge.projection.reason && gauge.projection.reason.length > 10, 'the refusal carries its reason');
    assert.equal(gauge.projection.breachInDays, undefined, 'no invented date');

    const missing = await reqHttp(port, 'GET', '/api/scan/does-not-exist/budget-gauges');
    assert.equal(missing.status, 404);
  } finally {
    await updateSettings({ budgets: [] });
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(fx, { recursive: true, force: true });
  }
});

test('the dashboard projection line shows dates only for ok — and refusals with their reasons', () => {
  // Structural, in the frontendContract style: the widget must never print a
  // breach date for a refused projection, and every server string it inlines
  // goes through escapeHtml.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const start = html.indexOf('function budgetProjectionLine');
  assert.notEqual(start, -1, 'budgetProjectionLine exists');
  const fn = html.slice(start, html.indexOf('function shortProjectionReason'));
  assert.match(fn, /status === 'ok' && typeof p\.breachInDays === 'number'/, 'a date needs an ok status AND a number');
  assert.match(fn, /escapeHtml\(p\.reason \|\| ''\)/, 'the refusal reason is escaped on the way into markup');
  assert.match(fn, /escapeHtml\(p\.caveat \|\| ''\)/, 'the ancestor-series caveat is escaped too');
  const reasons = html.slice(html.indexOf('function shortProjectionReason'), html.indexOf('function shortProjectionReason') + 700);
  for (const status of ['insufficient', 'erratic', 'shrinking', 'stable']) {
    assert.ok(reasons.includes(`'${status}'`), `the ${status} refusal has its own sentence`);
  }
});

/* ---------- the hunt (C40): a budget is not a disk ---------- */

test('a folder growing under 1 MiB a day toward a near budget projects its breach, never "flat" (hunt C40)', () => {
  // +500,000 B/day over 6 scans and 5 days, 1,000,000 B of headroom: a breach about 2 days away.
  const series = Array.from({ length: 6 }, (_, i) => pt(5 - i, 996_500_000 + i * 500_000));
  const p = computeBudgetProjection({ path: '/b', maxBytes: 1_000_000_000 }, 999_000_000, series, NOW);
  assert.equal(p.status, 'ok', `${p.status}: ${p.reason}`);
  assert.ok(Math.abs(p.breachInDays! - 2) < 0.1, `expected ~2 days, got ${p.breachInDays}`);
  assert.equal(p.bytesPerDay, 500_000);
});

test('a slow grower whose breach is years off says the folder will not reach its budget for years — never the disk (hunt C40)', () => {
  const series = Array.from({ length: 6 }, (_, i) => pt(5 - i, 100 * GB + i * 1000));
  const p = computeBudgetProjection({ path: '/b', maxBytes: 200 * GB }, 100 * GB + 5000, series, NOW);
  assert.equal(p.status, 'stable');
  assert.doesNotMatch(String(p.reason), /disk|fill-up/, String(p.reason));
  assert.match(String(p.reason), /budget/, String(p.reason));
  const flat = computeBudgetProjection({ path: '/b', maxBytes: 200 * GB }, 100 * GB, Array.from({ length: 8 }, (_, i) => pt(7 - i, 100 * GB)), NOW);
  assert.doesNotMatch(String(flat.reason), /disk|fill-up/, String(flat.reason));
});

test('a folder whose size only jitters reads the same whichever way its noise leans — never "too erratic" when no breach of its budget is in sight (review F1.2, F1.9)', () => {
  // Two noise patterns, each as measured and mirrored: the fitted slope is a few hundred bytes a day, up or down,
  // with centuries of headroom. Rescaled past the disk's flat floor, a positive one met the forecast's fit-quality
  // gate and read "too erratic to project honestly" for a folder that is not growing; its mirror read flat.
  const cases = [
    { at: 500_000_000, maxBytes: 1_000_000_000, jitter: [0, 40_000, -30_000, 20_000, -50_000, 10_000, -20_000, 30_000] },
    { at: 1_000_000_000, maxBytes: 2_000_000_000, jitter: [0, 20_000, -20_000, 30_000, -10_000, 10_000] },
  ];
  for (const { at, maxBytes, jitter } of cases) {
    for (const sign of [1, -1]) {
      const series = jitter.map((j, i) => pt(jitter.length - 1 - i, at + sign * j));
      const p = computeBudgetProjection({ path: '/b', maxBytes }, series[series.length - 1].v, series, NOW);
      assert.equal(p.status, 'stable', `${sign > 0 ? 'as measured' : 'mirrored'} (${p.bytesPerDay} B/day): ${p.status}: ${p.reason}`);
      assert.doesNotMatch(String(p.reason), /erratic/, String(p.reason));
    }
  }
});

test('the gauge row says "flat" only for a folder that is not growing (hunt C40)', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const at = page.indexOf('function shortProjectionReason(');
  const src = page.slice(at, page.indexOf('\n}\n', at) + 2);
  const short = new Function(`${src}; return shortProjectionReason;`)() as (p: Record<string, unknown>) => string;
  assert.equal(short({ status: 'stable', bytesPerDay: 0 }), 'flat — no breach in sight');
  assert.doesNotMatch(short({ status: 'stable', bytesPerDay: 1000 }), /flat/, 'a folder growing slowly is not flat');
});

test('a failed read of the saved budgets saves nothing — never this scan\'s budgets alone over every other folder\'s (hunt C80)', async () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const at = page.indexOf('async function currentSavedBudgets(');
  const src = page.slice(at, page.indexOf('\n}\n', at) + 2);
  const read = new Function('api', 'state', `${src}; return currentSavedBudgets;`)(
    async () => { throw new Error('the server stopped answering'); },
    { budgets: { list: [{ path: '/this-scan/a', maxBytes: 5 }] } },
  ) as () => Promise<unknown>;
  await assert.rejects(read(), /stopped answering/, 'the failure reaches commitBudget and removeBudget, which say "Could not save budget" and write nothing');
});

test('a failed read of the saved budgets under the saved index\'s tree claims nothing and rejects nothing: loadBudgets is called without waiting, and after a save that went through (review F1.10)', async () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const lift = (decl: string): string => {
    const at = page.indexOf(decl);
    assert.notEqual(at, -1, `${decl} is in the page`);
    return page.slice(at, page.indexOf('\n}\n', at) + 2);
  };
  const src = `let loadBudgetsSeq = 0;\n${lift('async function loadBudgets(')}\n${lift('async function currentSavedBudgets(')}`;
  const state = { root: { path: '/r' }, budgets: { list: [{ path: '/x', maxBytes: 1 }], saved: undefined as unknown, overPaths: new Set(), gauges: new Map() } };
  let painted = 0;
  const load = new Function('api', 'state', 'treeScanId', 'renderBudgetWidget', `${src}; return loadBudgets;`)(
    async () => { throw new Error('the server stopped answering'); }, state, () => null, () => { painted++; },
  ) as () => Promise<void>;
  await load();
  assert.equal(painted, 1, 'control: the no-scan branch ran');
  assert.equal(state.budgets.saved, null, 'nothing is claimed about the saved budgets');
});
