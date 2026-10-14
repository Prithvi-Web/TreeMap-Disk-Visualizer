import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
const DATA = isolatedDataDir('treemap-coverage-data-');

import { startScan, getScan } from '../src/services/diskScanner';
import { updateSettings } from '../src/services/settings';
import { currentBaseline, listSnapshots, saveSnapshot, diffSnapshots, getSnapshotTreeAt } from '../src/services/snapshots';
import { growthAlertFor } from '../src/services/scheduler';
import { recordScanJournal, readJournal } from '../src/services/journal';
import { computeForecast } from '../src/services/forecast';
import { settled } from '../src/utils/backgroundWrites';
import { createApp } from '../src/server';
import { budgetHistorySeries, computeBudgetProjection } from '../src/services/budgetGauges';
import type { ScanResult, Snapshot } from '../src/models/types';

async function scanned(root: string): Promise<ScanResult> {
  await updateSettings({ engine: 'walker' });
  const scan = await startScan(root);
  const limit = Date.now() + 10_000;
  while (scan.status === 'running' && Date.now() < limit) await new Promise((r) => setTimeout(r, 10));
  assert.equal(scan.status, 'complete', scan.error);
  await settled();
  return getScan(scan.scanId)!;
}

const NO_CHMOD = process.platform === 'win32' || process.getuid?.() === 0;

test('denied folder then restored permissions is not file growth, including after restart', { skip: NO_CHMOD }, async (t) => {
  const root = fileTempDir('treemap-coverage-tree-');
  const locked = path.join(root, 'locked');
  fs.mkdirSync(locked);
  const file = path.join(locked, 'unchanged.txt');
  fs.writeFileSync(file, 'unchanged bytes');
  t.after(() => fs.chmodSync(locked, 0o700));
  const first = await scanned(root);
  fs.chmodSync(locked, 0o000);
  const denied = await scanned(root);
  assert.equal(denied.deniedDirs, 1, 'real scanner encountered the permission gap');
  fs.chmodSync(locked, 0o700);
  const restored = await scanned(root);
  assert.equal(restored.store!.size(0), first.store!.size(0), 'the files did not change');
  const history = await listSnapshots(root);
  const previous = history[1];
  const sched = { id: 'coverage', path: root, intervalHours: 1, thresholdBytes: 1, enabled: true };
  assert.equal(growthAlertFor(sched, root, previous, restored), null, 'permission recovery is not a growth alert');
  assert.deepEqual(currentBaseline(history).map((s) => s.id), [history[2].id], 'partial sample starts a new baseline');
  assert.equal((previous as Snapshot & { coverage?: string }).coverage, 'partial', 'coverage persists with the bytes');
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import snapshots from './src/services/snapshots.ts'; const h = await snapshots.listSnapshots(${JSON.stringify(root)}); console.log(JSON.stringify({ coverage: h[1].coverage, ids: snapshots.currentBaseline(h).map(s=>s.id) }));`],
  { cwd: path.join(__dirname, '..'), env: { ...process.env, TREEMAP_DATA_DIR: DATA }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { coverage: 'partial', ids: [history[2].id] });
  const historical = await getSnapshotTreeAt(root, history[2].takenAt);
  assert.equal(historical!.prev, null, 'time-slider does not call unread bytes added');
  assert.throws(() => diffSnapshots(previous, history[2]), /coverage|incomplete/i);
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    for (const route of [
      `/api/compare?scanIdA=${denied.scanId}&scanIdB=${restored.scanId}`,
      `/api/snapshots/compare?a=${previous.id}&b=${history[2].id}`,
    ]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`);
      assert.equal(response.status, 409);
      assert.equal((await response.json() as { code: string }).code, 'COVERAGE_INCOMPARABLE');
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('legacy coverage stays unknown when converted into a folder budget series', async () => {
  const root = fileTempDir('treemap-coverage-engine-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  const scan = await scanned(root);
  const current = (await listSnapshots(root))[0];
  const legacy = Array.from({ length: 8 }, (_, i) => ({
    ...current, id: `legacy-${i}`, coverage: undefined, takenAt: i * 86_400_000,
  }));
  fs.writeFileSync(path.join(DATA, 'snapshots.json'), JSON.stringify({ snapshots: [...legacy, current] }));
  const history = await listSnapshots(root);
  assert.equal(history.at(-1)!.coverage, 'complete', 'history remains sorted by observation time');
  assert.equal(history.filter((s) => s.coverage === undefined).length, 8);
  assert.equal(currentBaseline(history).length, 1, 'unknown evidence is not bridged');
  const series = await budgetHistorySeries(root);
  const projection = computeBudgetProjection({ path: root, maxBytes: 10e9 }, 1, series.points);
  assert.equal(projection.status, 'insufficient', 'budget conversion preserves unknown coverage');
});

test('legacy snapshots have unknown coverage and cannot establish growth forecasts', () => {
  const day = 86_400_000;
  const snapshots: Snapshot[] = Array.from({ length: 8 }, (_, i) => ({
    id: String(i), rootPath: '/r', takenAt: i * day, totalSize: (100 + i) * 1e9,
    fileCount: 1, dirCount: 1, topEntries: [],
  }));
  assert.equal(computeForecast(snapshots, 50e9, 9 * day).status, 'insufficient');
  assert.deepEqual(currentBaseline(snapshots), []);
  assert.throws(() => diffSnapshots(snapshots[0], snapshots[1]), /coverage|unknown/i);
});

test('known incomplete entry or folder samples never feed alerts, journal or forecasts', async () => {
  const root = fileTempDir('treemap-coverage-counters-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  const scan = await scanned(root);
  const previous = (await listSnapshots(root))[0];
  const sched = { id: 'coverage', path: root, intervalHours: 1, thresholdBytes: 1, enabled: true };
  for (const field of ['deniedDirs', 'unreadableDirs', 'deniedEntries', 'unreadableEntries', 'vanishedDirs'] as const) {
    const partial = { ...scan, [field]: 1 };
    const saved = await saveSnapshot(partial);
    assert.equal((saved as Snapshot & { coverage?: string }).coverage, 'partial', field);
    assert.equal(growthAlertFor(sched, root, { ...previous, totalSize: -1e9 }, partial), null, field);
    const before = (await readJournal(100)).length;
    assert.equal(await recordScanJournal(partial, { ...previous, totalSize: 1e9 }), 0, field);
    assert.equal((await readJournal(100)).length, before, field);
    assert.deepEqual(currentBaseline([previous, saved!]), [], field);
  }
});
