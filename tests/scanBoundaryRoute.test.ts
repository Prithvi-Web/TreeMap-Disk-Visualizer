import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-scanBoundaryRoute-data-');
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp/server';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { createScanRecord, startScan } from '../src/services/diskScanner';
import { updateSettings } from '../src/services/settings';
import { setStorageModeForTests } from '../src/services/storageMode';
import { boundaryRecord, setBoundaryDepsForTests, type MountTable } from '../src/utils/mountBoundaries';
import type { ScanResult } from '../src/models/types';

/**
 * Track U, U-26: GET /api/scan/:scanId/boundary says which drives mounted
 * inside the scanned folder a scan did not enter (or, under "Include drives
 * mounted inside it", entered), every count from the scan's own record.
 * Unknown is null with the reason, never an empty list (U-D13).
 */

const REPO = path.join(__dirname, '..');
const NO_TABLE = process.platform === 'win32' ? 'Windows keeps no mount table, so no scan there has a drive inside it to stop at' : null;

let port = 0;
let server: http.Server;

before(async () => {
  resetRateLimiter();
  server = http.createServer(createApp(path.join(REPO, 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  setBoundaryDepsForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
});

function get(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
    }).on('error', reject);
  });
}

function table(paths: string[]): MountTable {
  return { source: 'mount', entries: paths.map((p) => ({ mountPoint: p, filesystem: 'apfs', options: ['apfs'], source: '/dev/disk99s1' })), reason: null };
}

/** root/drive-1 … drive-n, each holding one file of `i * 100` bytes, every one named a mount. */
function drives(n: number): { root: string; mounts: string[] } {
  const root = fs.realpathSync(fileTempDir('treemap-boundary-route-'));
  const mounts: string[] = [];
  for (let i = 1; i <= n; i++) {
    const m = path.join(root, `drive-${i}`);
    fs.mkdirSync(m);
    fs.writeFileSync(path.join(m, 'f.bin'), 'x'.repeat(i * 100));
    mounts.push(m);
  }
  fs.writeFileSync(path.join(root, 'here.txt'), 'h'.repeat(50));
  // Listed in reverse, so the answer's own order is what the test sees.
  setBoundaryDepsForTests({ readTable: async () => table([...mounts].reverse()), aliases: async () => () => [] });
  return { root, mounts };
}

async function scanned(root: string, rule: 'stay' | 'cross'): Promise<ScanResult> {
  await updateSettings({ scanBoundary: rule, engine: 'walker' });
  const s = await startScan(root);
  await waitFor(() => s.status !== 'running', `the scan of ${root} settling`);
  assert.equal(s.status, 'complete', s.error);
  return s;
}

test('a stay scan: the rule, the drives not entered (five examples, sorted), and every listed drive with reached, entered and bytes', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const { root, mounts } = drives(7);
  const s = await scanned(root, 'stay');
  const r = await get(`/api/scan/${s.scanId}/boundary`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body;
  assert.equal(b.scanId, s.scanId);
  assert.equal(b.rule, 'stay');
  assert.equal(b.source, 'mount');
  assert.equal(b.reason, null);
  assert.deepEqual(b.notEntered, { count: 7, examples: [...mounts].sort().slice(0, 5) });
  assert.deepEqual(b.entered, { count: 0, examples: [], bytes: 0 });
  assert.deepEqual(b.crossedUnlisted, { count: 0, examples: [] });
  assert.equal(b.mountsListed, 7);
  assert.deepEqual(b.mounts.map((m: any) => m.path), [...mounts].sort());
  for (const m of b.mounts) {
    assert.deepEqual(m, { path: m.path, filesystem: 'apfs', source: '/dev/disk99s1', reached: true, entered: false, bytes: null }, 'reached, not entered, nothing counted inside');
  }
});

test('a cross scan: the drives entered, with the bytes the scan counted inside them', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const { root, mounts } = drives(3);
  const s = await scanned(root, 'cross');
  const b = (await get(`/api/scan/${s.scanId}/boundary`)).body;
  assert.equal(b.rule, 'cross');
  assert.deepEqual(b.notEntered, { count: 0, examples: [] });
  assert.deepEqual(b.entered, { count: 3, examples: [...mounts].sort(), bytes: 100 + 200 + 300 });
  assert.deepEqual(b.mounts.map((m: any) => [m.reached, m.entered, m.bytes]), [[true, true, 100], [true, true, 200], [true, true, 300]]);
});

test('more than fifty drives: fifty are listed, sorted, and mountsListed says how many there are', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const root = fs.realpathSync(fileTempDir('treemap-boundary-route-many-'));
  const many = Array.from({ length: 55 }, (_, i) => path.join(root, `m-${String(i).padStart(2, '0')}`));
  setBoundaryDepsForTests({ readTable: async () => table([...many].reverse()), aliases: async () => () => [], isDirectory: async () => true });
  const s = await scanned(root, 'stay');
  const b = (await get(`/api/scan/${s.scanId}/boundary`)).body;
  assert.equal(b.notEntered.count, 55);
  assert.equal(b.notEntered.examples.length, 5);
  assert.equal(b.mountsListed, 55);
  assert.equal(b.mounts.length, 50);
  assert.deepEqual(b.mounts.map((m: any) => m.path), many.slice(0, 50));
});

test('a mount under a folder no walk descends into is listed as not reached — not as a drive the scan chose not to enter', async () => {
  const slash = createScanRecord('/');
  slash.status = 'complete';
  slash.boundary = boundaryRecord({
    rule: 'stay',
    source: 'mount',
    reason: null,
    mounts: [
      { path: '/Volumes/Backup', filesystem: 'apfs', source: '/dev/disk4s2', underFixed: true },
      { path: '/Library/Developer/CoreSimulator/Volumes/iOS_22E238', filesystem: 'apfs', source: '/dev/disk7s1', underFixed: false },
    ],
    fixed: ['/Volumes'],
    neverDescend: ['/Volumes', '/Volumes/Backup', '/Library/Developer/CoreSimulator/Volumes/iOS_22E238'],
  });
  const b = (await get(`/api/scan/${slash.scanId}/boundary`)).body;
  assert.deepEqual(b.notEntered, { count: 1, examples: ['/Library/Developer/CoreSimulator/Volumes/iOS_22E238'] });
  const volumes = b.mounts.find((m: any) => m.path === '/Volumes/Backup');
  assert.equal(volumes.reached, false, 'the walk of / never reaches /Volumes');
  assert.equal(volumes.entered, false);
  const sim = b.mounts.find((m: any) => m.path.endsWith('iOS_22E238'));
  assert.deepEqual([sim.reached, sim.entered], [true, false]);
});

test('a record made without a boundary answers rule null with the reason — never an empty list', async () => {
  const old = createScanRecord(fs.realpathSync(fileTempDir('treemap-boundary-route-old-')));
  old.status = 'complete';
  const b = (await get(`/api/scan/${old.scanId}/boundary`)).body;
  assert.equal(b.rule, null);
  assert.match(b.reason, /without a mount boundary/);
  assert.equal(b.notEntered, null);
  assert.equal(b.entered, null);
  assert.equal(b.mounts, null);
  assert.equal(b.mountsListed, null);
});

test('a mount table that could not be read: the drives are unknown, with the table’s reason', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const root = fs.realpathSync(fileTempDir('treemap-boundary-route-unread-'));
  setBoundaryDepsForTests({ readTable: async () => ({ source: 'mount', entries: null, reason: '/sbin/mount did not answer within 5 s' }) });
  const s = await scanned(root, 'stay');
  const b = (await get(`/api/scan/${s.scanId}/boundary`)).body;
  assert.equal(b.rule, 'stay');
  assert.equal(b.reason, '/sbin/mount did not answer within 5 s');
  assert.equal(b.notEntered, null);
  assert.equal(b.mounts, null);
  assert.deepEqual(b.crossedUnlisted, { count: 0, examples: [] }, 'what the walk itself recorded is still known');
});

test('a scan kept in spill mode: the bytes inside the drives it entered are null, with the reason', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const { root } = drives(2);
  const s = await scanned(root, 'cross');
  setStorageModeForTests('spill', s);
  const b = (await get(`/api/scan/${s.scanId}/boundary`)).body;
  assert.equal(b.entered.count, 2);
  assert.equal(b.entered.bytes, null);
  assert.match(b.entered.reason, /spill mode/);
  assert.deepEqual(b.mounts.map((m: any) => m.bytes), [null, null]);
});

test('an unknown scan is 404 SCAN_NOT_FOUND', async () => {
  const r = await get('/api/scan/no-such-scan/boundary');
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'SCAN_NOT_FOUND');
});

test('the published spec describes exactly what the route answers', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const { root } = drives(1);
  const s = await scanned(root, 'stay');
  const body = (await get(`/api/scan/${s.scanId}/boundary`)).body;
  const doc = (await get('/api/openapi.json')).body;
  const op = doc.paths['/api/scan/{scanId}/boundary']?.get;
  assert.ok(op, 'the spec has the route');
  const ref = op.responses['200'].content['application/json'].schema.$ref as string;
  const schema = doc.components.schemas[ref.replace('#/components/schemas/', '')];
  assert.deepEqual(Object.keys(body).sort(), Object.keys(schema.properties).sort(), 'every answered key is described, and nothing else');
  assert.deepEqual([...schema.required].sort(), Object.keys(body).sort(), 'and every one is always answered');
  assert.ok(op.responses['404'], 'the 404 is documented');
});

test('MCP scan_path names the drives a scan did not enter', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const { root, mounts } = drives(2);
  await updateSettings({ scanBoundary: 'stay', engine: 'walker' });
  const mcp = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'treemap-boundary-route-test', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  try {
    let reply = (await client.callTool({ name: 'scan_path', arguments: { path: root, waitMs: 60_000 } })) as { structuredContent?: Record<string, any> };
    while (reply.structuredContent?.status === 'running') {
      reply = (await client.callTool({ name: 'scan_path', arguments: { scanId: reply.structuredContent.scanId, waitMs: 60_000 } })) as { structuredContent?: Record<string, any> };
    }
    const sentence = reply.structuredContent?.drivesMountedInside as string;
    assert.equal(sentence, `2 drives mounted inside were not entered: ${path.basename(mounts[0])}, ${path.basename(mounts[1])}. Their files are not counted; PUT /api/settings { "scanBoundary": "cross" } includes them in the next scan.`);
  } finally {
    await client.close();
  }
});
