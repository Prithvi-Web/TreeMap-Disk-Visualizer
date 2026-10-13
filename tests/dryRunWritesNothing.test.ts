import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
const DATA_DIR = isolatedDataDir('treemap-dryRunWritesNothing-data-');

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { settled } from '../src/utils/backgroundWrites';
import { setTrashStepForTests } from '../src/services/cleaner';
import { approvePolicyForTests, normalizePolicy, runPolicy, savePolicies, simulatePolicy } from '../src/services/autopilot';
import { allScans, getScan, startScan } from '../src/services/diskScanner';
import { fleetRuntime } from '../src/services/fleet/fleetRuntime';
import { defaultConfig } from '../src/services/fleet/fleetSync';
import { listSnapshots } from '../src/services/snapshots';
import { waitFor } from './fixtures/waitFor';

/**
 * A dry run changes nothing persistent (browser re-check C12).
 *
 * An Autopilot Preview scanned the policy's folder as an ordinary scan does,
 * and every finished scan saves a history snapshot and the fast-rescan cache:
 * on a fresh install the first real scan then said "Nothing changed since your
 * last scan moments ago", and the forecast and Trends counted the preview.
 * The evidence was snapshots.json's first entry, 0.5 s before the audit's
 * autopilot.simulate line.
 *
 * Asserted on the data folder itself, file by file and byte for byte, so a
 * write nobody thought of fails here too. A dry run is meant to add exactly
 * one thing: its line in audit.jsonl (AGENTS.md — dry runs are audited). A
 * policy's own preview run is meant to add its run record to autopilot.json.
 *
 * Nothing here can reach the Trash: every dry run stops before it, and the
 * Trash step is replaced by a recorder that fails the file if it is called.
 */

const trashed: string[] = [];
setTrashStepForTests(async (p) => { trashed.push(p); });
after(() => {
  setTrashStepForTests(null);
  assert.deepEqual(trashed, [], 'no dry run reached the Trash step');
});

/** Every file under the data folder, by its path inside it, with its content's SHA-256. */
function dataFiles(): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of fs.readdirSync(DATA_DIR, { recursive: true }) as string[]) {
    const full = path.join(DATA_DIR, rel);
    if (fs.statSync(full).isFile()) out.set(rel, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
  }
  return out;
}

/** The files added, removed or changed between two listings, sorted. */
function changed(before: Map<string, string>, now: Map<string, string>): string[] {
  const names = new Set([...before.keys(), ...now.keys()]);
  return [...names].filter((n) => before.get(n) !== now.get(n)).sort();
}

/** A small folder: three files the custom rule below matches. */
function tree(): string {
  const dir = fs.realpathSync(fileTempDir('tm-dryrun-tree-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  for (const [name, size] of [['a.bin', 4000], ['b.bin', 6000], ['sub/c.bin', 8000]] as const) {
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(size, 1));
  }
  return dir;
}

const matchAll = { kind: 'custom', minBytes: 1 };

test('C12: an Autopilot Preview writes nothing persistent — no history snapshot, no fast-rescan cache', async () => {
  const dir = tree();
  await settled();
  const before = dataFiles();
  const result = await simulatePolicy(normalizePolicy({ path: dir, match: matchAll }));
  assert.equal(result.items.length, 3, 'control: the preview scanned the folder and matched its three files');
  await settled();
  assert.deepEqual(changed(before, dataFiles()), [], 'the data folder is byte for byte as it was');
  assert.deepEqual(await listSnapshots(dir), [], 'no history snapshot of the folder');

  // Control: an ordinary scan of the same folder does keep a snapshot, so the
  // listing above would have seen one.
  const scan = await startScan(dir);
  await waitFor(() => getScan(scan.scanId)?.status !== 'running', 'the ordinary scan settling');
  await settled();
  assert.equal((await listSnapshots(dir)).length, 1, 'control: a scan a person starts is kept');
  assert.ok(changed(before, dataFiles()).includes('snapshots.json'), 'control: and the listing sees it');
});

test('C12: a policy run that only previews records its run, and writes no snapshot or cache', async () => {
  const dir = tree();
  try {
    // Never approved: its runs preview until a person approves one.
    const [fresh] = await savePolicies([{ id: 'preview-only', name: 'p', path: dir, match: matchAll, dryRunFirst: false, enabled: true }]);
    await settled();
    let before = dataFiles();
    const first = await runPolicy(fresh, { ignoreCooldown: true });
    assert.equal(first.status, 'awaiting-approval', 'control: a preview, which matched');
    assert.equal(first.items.length, 3);
    await settled();
    assert.deepEqual(changed(before, dataFiles()), ['autopilot.json'], 'its run record, and nothing else');

    // Approved, but set to preview every run ("Preview every run" in the editor).
    await savePolicies([{ id: 'previews', name: 'q', path: dir, match: matchAll, dryRunFirst: true, enabled: true }]);
    const previews = await approvePolicyForTests('previews');
    await settled();
    before = dataFiles();
    const second = await runPolicy(previews, { ignoreCooldown: true });
    assert.match(second.blockedReason ?? '', /^Simulated/, 'control: simulated, deleting nothing');
    await settled();
    assert.deepEqual(changed(before, dataFiles()), ['autopilot.json'], 'again only its run record');
    assert.deepEqual(await listSnapshots(dir), [], 'and no history snapshot of the folder');

    // Approved to delete, and asked for a dry run of it.
    await savePolicies([{ id: 'deletes', name: 'r', path: dir, match: matchAll, dryRunFirst: false, enabled: true }]);
    const deletes = await approvePolicyForTests('deletes');
    await settled();
    before = dataFiles();
    const third = await runPolicy(deletes, { ignoreCooldown: true, dryRun: true });
    assert.match(third.blockedReason ?? '', /^Simulated/, 'control: simulated, deleting nothing');
    await settled();
    assert.deepEqual(changed(before, dataFiles()), ['autopilot.json'], 'a dry run asked for is one too');
    assert.deepEqual(await listSnapshots(dir), []);

    // Control: a run that may delete keeps its scan, as any scan does. Its rule
    // matches nothing here, so nothing is deleted.
    await savePolicies([{ id: 'real', name: 's', path: dir, match: { kind: 'custom', minBytes: 1e12 }, dryRunFirst: false, enabled: true }]);
    const real = await approvePolicyForTests('real');
    const fourth = await runPolicy(real, { ignoreCooldown: true });
    assert.equal(fourth.blockedReason, 'Nothing matched this time.', 'control: a real run, past every preview gate, that found nothing to delete');
    assert.equal(fourth.bytesDeleted, 0);
    await settled();
    assert.equal((await listSnapshots(dir)).length, 1, 'its scan is in the history');
  } finally {
    await savePolicies([]);
  }
});

/** One JSON request to a fresh app on an ephemeral port. */
async function call(method: string, url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    const payload = JSON.stringify(body);
    return await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : {} }));
      });
      r.on('error', reject);
      r.end(payload);
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('C12: every dry run over HTTP leaves the data folder as it was, but for the audit line it is meant to add', async () => {
  const dir = tree();
  const dest = fs.realpathSync(fileTempDir('tm-dryrun-dest-'));
  const scanned = await call('POST', '/api/scan?wait=true&waitMs=55000', { path: dir });
  assert.equal(scanned.status, 200, JSON.stringify(scanned.body));
  const scanId = String(scanned.body.scanId);
  await settled();
  const before = dataFiles();
  const file = path.join(dir, 'a.bin');

  const dryRuns: Array<[string, string, unknown]> = [
    ['DELETE', '/api/files', { paths: [file], dryRun: true }],
    ['POST', '/api/cart/commit', { paths: [file], dryRun: true }],
    ['POST', '/api/offload', { scanId, paths: [file], dest, dryRun: true }],
    ['POST', '/api/offload/restore', { ids: ['no-such-offload'], dryRun: true }],
    ['POST', '/api/autopilot/simulate', { policy: { path: dir, match: matchAll } }],
  ];
  for (const [method, url, body] of dryRuns) {
    const r = await call(method, url, body);
    assert.equal(r.status, 200, `${method} ${url}: ${JSON.stringify(r.body)}`);
  }
  await settled();
  assert.deepEqual(changed(before, dataFiles()), ['audit.jsonl'], 'the audit is the only file a dry run adds to');
  const lines = fs.readFileSync(path.join(DATA_DIR, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dryRun: boolean });
  assert.equal(lines.slice(-dryRuns.length).filter((l) => l.dryRun).length, dryRuns.length, 'one dry-run line each');
  for (const name of ['a.bin', 'b.bin', path.join('sub', 'c.bin')]) assert.ok(fs.existsSync(path.join(dir, name)), `${name} is where it was`);
  assert.deepEqual(fs.readdirSync(dest), [], 'and nothing was copied');
});

test('C12: a dry run\'s scan is nobody\'s scan — not listed by GET /api/scans (a reload reopens the newest, Compare offers every one), nor sent to the fleet as this machine\'s last scan', async () => {
  const dir = tree();
  const scanned = await call('POST', '/api/scan?wait=true&waitMs=55000', { path: dir });
  assert.equal(scanned.status, 200, JSON.stringify(scanned.body));
  const mine = String(scanned.body.scanId);
  const listed = async (): Promise<string[]> => {
    const r = await call('GET', '/api/scans', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (r.body.scans as Array<{ scanId: string }>).map((s) => s.scanId);
  };
  const before = await listed();
  assert.equal(before[0], mine, 'control: the scan a person started is listed, newest first');
  const inMemory = allScans().length;

  const sim = await call('POST', '/api/autopilot/simulate', { policy: { path: dir, match: matchAll } });
  assert.equal(sim.status, 200, JSON.stringify(sim.body));
  assert.equal((sim.body.items as unknown[]).length, 3, 'control: the Preview scanned the folder');
  try {
    const [fresh] = await savePolicies([{ id: 'preview-listed', name: 'p', path: dir, match: matchAll, dryRunFirst: false, enabled: true }]);
    const run = await runPolicy(fresh, { ignoreCooldown: true });
    assert.equal(run.status, 'awaiting-approval', 'control: a run that can only preview');
  } finally {
    await savePolicies([]);
  }
  assert.equal(allScans().length, inMemory + 2, 'control: both previews\' scans are held in memory, as any scan is');

  assert.deepEqual(await listed(), before, 'neither preview\'s scan is listed');
  const summary = await fleetRuntime().summary({ ...defaultConfig(), label: 'here' });
  const latestRecorded = allScans().find((s) => s.scanId === mine)!;
  assert.equal(summary.lastScanAt, latestRecorded.finishedAt, 'the fleet hears of the person\'s own scan as the last one, not a preview\'s');
});
