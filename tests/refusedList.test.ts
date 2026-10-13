import { test, after, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
import { skipOrFailOnCi } from './fixtures/ciSkip';
isolatedDataDir('treemap-refusedList-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { buildOpenApiDocument } from '../src/api/openapi';
import { createScanRecord, getScan, startScan } from '../src/services/diskScanner';
import { updateSettings } from '../src/services/settings';
import { mapGduTree, mapGduTreeIntoStore } from '../src/services/gduMapper';
import { PackedScanStore } from '../src/services/scanStore';
import {
  REFUSED_EXAMPLES, REFUSED_LIST_CAP, addRefused, noteRefused, refusedFolders,
} from '../src/services/scanRefusals';
import { FEATURES, ROUTE_FEATURES } from '../src/services/storageMode';
import { loadNative, resetNativeForTests } from '../src/services/scan/native';
import { resetEngineBudgetForTests, setNativeLoadOptionsForTests } from '../src/services/engineBudget';
import type { ScanResult } from '../src/models/types';

/**
 * Browser re-check C06: "69 folders could not be read — " named five of them
 * and stopped — no "and 64 more", and nothing anywhere in the app listed the
 * other 64. The scan kept five examples and nothing else, so no surface could.
 *
 * Now the scan record keeps every refused folder's path (the smallest
 * REFUSED_LIST_CAP of them, so a pathological scan holds a bounded list), and
 * GET /api/scan/:scanId/refused serves the list, with what it could not name
 * counted and said in words. /stats is untouched: its `refused` stays
 * `{ dirs, examples }` with five examples (tests/goldenResponses.test.ts).
 */

const REPO = path.join(__dirname, '..');
const PREBUILT_MODULE = path.join(REPO, 'native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node');
const canLock = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0);

let port = 0;
let server: http.Server;

before(async () => {
  resetRateLimiter();
  server = http.createServer(createApp(path.join(REPO, 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function get(url: string): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
    }).on('error', reject);
  });
}

/** Every element of `list`, visiting index `(i * stride) % length` in turn (`stride` coprime with the length). */
function strided<T>(list: readonly T[], stride: number): T[] {
  return list.map((_, i) => list[(i * stride) % list.length]);
}

/* ───────────────────────────── the record ───────────────────────────── */

test('C06: every folder a scan was refused is named, in path order, whatever order the walk met them in', () => {
  const names = Array.from({ length: 69 }, (_, i) => `/r/${'qrstuvwxyz'[i % 10]}-${String(i).padStart(2, '0')}`);
  const want = [...names].sort();
  for (const order of [names, [...names].reverse(), strided(names, 4)]) {
    const scan = createScanRecord('/r');
    for (const p of order) noteRefused(scan, p);
    assert.deepEqual(refusedFolders(scan), { dirs: 69, paths: want, unnamed: 0, unnamedReason: null }, 'all 69, sorted, none left unnamed');
    assert.deepEqual(want.slice(0, REFUSED_EXAMPLES), scan.deniedExamples, 'and its first five are the five /stats names');
  }
});

test('C06: past the cap the smallest paths are named and the rest counted and said to be, the same whatever the order, and the record never holds twice the cap', () => {
  const total = 3 * REFUSED_LIST_CAP + 7;
  const all = Array.from({ length: total }, (_, i) => `/r/d${String(i).padStart(6, '0')}`);
  for (const order of [[...all].reverse(), strided(all, 2)]) {
    const scan = createScanRecord('/r');
    let most = 0;
    for (const p of order) {
      noteRefused(scan, p);
      most = Math.max(most, scan.deniedPaths?.length ?? 0);
    }
    assert.ok(most < 2 * REFUSED_LIST_CAP, `the record held at most ${most} paths, under twice the cap`);
    const got = refusedFolders(scan);
    assert.equal(got.dirs, total, 'every refusal is counted');
    assert.deepEqual(got.paths, all.slice(0, REFUSED_LIST_CAP), 'the smallest, in path order');
    assert.equal(got.unnamed, total - REFUSED_LIST_CAP);
    assert.equal(got.unnamedReason, 'TreeMap names the first 10,000 of them, in path order; the other 20,007 were counted but not named.');
  }
});

test('C06: a part counted elsewhere — a gdu shard, the native adopt — adds its count and every path it named, and the five /stats names come from them', () => {
  const scan = createScanRecord('/r');
  noteRefused(scan, '/r/m');
  addRefused(scan, 6, ['/r/z', '/r/a', '/r/y', '/r/b', '/r/x', '/r/c']);
  assert.deepEqual(refusedFolders(scan), {
    dirs: 7, paths: ['/r/a', '/r/b', '/r/c', '/r/m', '/r/x', '/r/y', '/r/z'], unnamed: 0, unnamedReason: null,
  });
  assert.deepEqual(scan.deniedExamples, ['/r/a', '/r/b', '/r/c', '/r/m', '/r/x']);
  addRefused(scan, 0, []);
  assert.equal(refusedFolders(scan).dirs, 7, 'an empty part changes nothing');
  // The gdu scanner merges each shard's stats through it.
  const gdu = fs.readFileSync(path.join(REPO, 'src', 'services', 'gduScanner.ts'), 'utf8');
  assert.match(gdu, /addRefused\(scan, stats\.deniedDirs, stats\.deniedPaths\)/, 'gduScanner adds each shard\'s refusals, every path included');
});

test('C06: the gdu mapper names every folder gdu could not read, not only five', () => {
  const letters = ['g', 'c', 'a', 'e', 'b', 'f', 'd'];
  const doc = [1, 2, { progname: 'gdu', progver: 'v5.36.1', timestamp: 1 },
    [{ name: '/fx', mtime: 1 },
      ...letters.map((n) => [{ name: `locked-${n}`, mtime: 1, read_error: true }]),
      [{ name: 'open', mtime: 1 }, { name: 'b.txt', asize: 1, dsize: 4096, mtime: 1 }],
    ]];
  const want = [...letters].sort().map((n) => `/fx/locked-${n}`);
  const { stats } = mapGduTree(doc, '/fx');
  assert.equal(stats.deniedDirs, 7);
  assert.deepEqual([...stats.deniedPaths].sort(), want, 'mapGduTree');
  const store = new PackedScanStore('/fx', '/', { name: 'fx', isDir: true, size: 0, modifiedAt: 0, isHidden: false });
  const viaStore = mapGduTreeIntoStore(doc, '/fx', store, store.rootId);
  assert.deepEqual([...viaStore.stats.deniedPaths].sort(), want, 'mapGduTreeIntoStore');
});

/* ───────────────────────────── the route ───────────────────────────── */

/** `root` holding seven mode-000 folders (one a level down) and an open one; the locked paths, sorted. */
function lockedTree(t: TestContext): { root: string; locked: string[] } {
  const root = fs.realpathSync(fileTempDir('treemap-refused-route-'));
  const locked: string[] = [];
  for (const rel of ['locked-g', 'locked-c', 'locked-a', 'locked-e', 'locked-b', 'locked-f', path.join('open', 'locked-d')]) {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hidden.bin'), Buffer.alloc(1000));
    locked.push(dir);
  }
  fs.writeFileSync(path.join(root, 'open', 'seen.txt'), 'seen');
  for (const dir of locked) fs.chmodSync(dir, 0o000);
  t.after(() => { for (const dir of locked) fs.chmodSync(dir, 0o755); });
  return { root, locked: locked.sort() };
}

async function scanned(root: string, engine: 'walker' | 'native'): Promise<ScanResult> {
  await updateSettings({ engine });
  const s = await startScan(root);
  await waitFor(() => s.status !== 'running', `the ${engine} scan of ${root} settling`);
  assert.equal(s.status, 'complete', s.error);
  return getScan(s.scanId) ?? s;
}

async function assertRouteNamesAll(scan: ScanResult, locked: string[]): Promise<void> {
  const r = await get(`/api/scan/${scan.scanId}/refused`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { scanId: scan.scanId, status: 'complete', dirs: 7, paths: locked, unnamed: 0, unnamedReason: null }, 'every refused folder, by path, in path order');
  const stats = await get(`/api/scan/${scan.scanId}/stats`);
  assert.deepEqual(stats.body.refused, { dirs: 7, examples: locked.slice(0, 5) }, '/stats still names five, in the shape it always had');
  assert.deepEqual(r.body.paths.slice(0, 5), stats.body.refused.examples, 'and the list begins with them');
}

test('C06: GET /api/scan/:scanId/refused names every folder a walker scan was refused; /stats is unchanged', { skip: !canLock && 'needs chmod-000 folders' }, async (t) => {
  const { root, locked } = lockedTree(t);
  try {
    await assertRouteNamesAll(await scanned(root, 'walker'), locked);
  } finally {
    await updateSettings({ engine: 'auto' });
  }
  const unknown = await get('/api/scan/no-such-scan/refused');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'SCAN_NOT_FOUND');
});

test('C06: and every folder a native scan was refused', { skip: !canLock && 'needs chmod-000 folders' }, async (t) => {
  const file = process.env.TREEMAP_NATIVE_MODULE ?? PREBUILT_MODULE;
  if (!fs.existsSync(file)) return skipOrFailOnCi(t, `no native module at ${file}; build it with npm run build:native`);
  resetNativeForTests();
  resetEngineBudgetForTests();
  setNativeLoadOptionsForTests({ path: file });
  t.after(() => {
    resetNativeForTests();
    setNativeLoadOptionsForTests(null);
  });
  assert.equal(loadNative({ path: file }).available, true, 'the prebuilt module loads');
  const { root, locked } = lockedTree(t);
  try {
    const scan = await scanned(root, 'native');
    assert.equal(scan.engine, 'native', `the native engine ran: ${scan.fallbackReason ?? ''}`);
    await assertRouteNamesAll(scan, locked);
  } finally {
    await updateSettings({ engine: 'auto' });
  }
});

test('C06: the route is in the published spec with the body it sends, and the storage-mode table reads it off the record in every mode', () => {
  const doc = buildOpenApiDocument() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const op = doc.paths?.['/api/scan/{scanId}/refused']?.get;
  assert.ok(op, 'GET /api/scan/{scanId}/refused is declared');
  assert.ok(op.responses?.['200'] && op.responses?.['404'], 'with its 200 and its 404');
  const schema = doc.components?.schemas?.RefusedFolders;
  const keys = ['dirs', 'paths', 'scanId', 'status', 'unnamed', 'unnamedReason'];
  assert.deepEqual(Object.keys(schema?.properties ?? {}).sort(), keys, 'every key the route sends, and no other');
  assert.deepEqual([...(schema?.required ?? [])].sort(), keys, 'each always sent');
  assert.equal(ROUTE_FEATURES['GET /api/scan/:scanId/refused'], 'refused');
  const row = FEATURES.refused;
  assert.deepEqual([row.memory, row.spill, row.aggregate], ['today', 'today', 'today'], 'answered in every storage mode');
});
