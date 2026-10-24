import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
const DATA_DIR = isolatedDataDir('treemap-scangrant-data-');
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../src/server';
import { startScan, getScan, cancelScan, createScanRecord } from '../src/services/diskScanner';
import { setTrashStepForTests } from '../src/services/cleaner';
import { updateSettings } from '../src/services/settings';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { resetIdempotencyCache } from '../src/middleware/idempotency';
import { insideAnyScanRoot } from '../src/middleware/pathGuard';
import { POLICY_FILE } from '../src/services/policy';
import { buildMcpServer } from '../src/mcp/server';
import { relocateSecret } from '../src/services/securityHygieneScanner';
import { runGitGc } from '../src/services/gitScanner';
import { waitFor } from './fixtures/waitFor';

/**
 * Hunt C08: which scans grant permission to act. Only a COMPLETED scan does — the scanned-root
 * rule, the byte cap and the audit all read the same scans. A scan still running, one that failed
 * and one that was stopped listed nothing TreeMap keeps, so none of them opens its root to a
 * delete; and under a byte cap a path no completed scan sized (a file made since the scan) is
 * refused, never counted as nothing.
 */

const BIG = 512 * 1024;
const FAKE_TRASH = fileTempDir('treemap-scangrant-trash-');
const trashed: string[] = [];
let server: http.Server;
let port = 0;

function mkRoot(label: string): { dir: string; big: string } {
  const dir = fs.realpathSync(fileTempDir(`treemap-scangrant-${label}-`));
  const big = path.join(dir, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(BIG, 7));
  return { dir, big };
}

function request(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  resetRateLimiter();
  resetIdempotencyCache();
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
          try { parsed = JSON.parse(buf); } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

async function newestAudit(): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return (await request('GET', '/api/audit?limit=1')).body.entries[0];
}

async function completedScanOf(dir: string): Promise<void> {
  const s = await startScan(dir, {});
  await waitFor(() => getScan(s.scanId)?.status !== 'running', `the scan of ${dir}`);
  assert.equal(getScan(s.scanId)?.status, 'complete', getScan(s.scanId)?.error);
}

function setCap(bytes: number | null): void {
  const file = path.join(DATA_DIR, POLICY_FILE);
  if (bytes === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, JSON.stringify({ maxBytesPerOperation: bytes }));
}

before(async () => {
  setTrashStepForTests(async (p: string) => {
    trashed.push(p);
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashed.length}-${path.basename(p)}`));
  });
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  await updateSettings({ engine: 'walker' });
});

after(async () => {
  setTrashStepForTests(null);
  setCap(null);
  await new Promise<void>((r) => server.close(() => r()));
});

test('a scan still running grants nothing: its root is outside the scanned-root rule, and the refusal says the scan has not finished', async () => {
  const { dir, big } = mkRoot('running');
  const rec = createScanRecord(dir);
  try {
    assert.equal(rec.status, 'running');
    assert.equal(insideAnyScanRoot(big), false, 'a running scan has listed nothing TreeMap keeps');
    const answer = await request('DELETE', '/api/files', { paths: [big] });
    assert.deepEqual([answer.status, answer.body.code], [403, 'OUTSIDE_SCAN_ROOT'], JSON.stringify(answer.body));
    assert.match(answer.body.error, /has not finished/, 'the sentence says why a folder being scanned is refused');
    assert.ok(fs.existsSync(big), 'nothing was moved');
  } finally {
    cancelScan(rec.scanId);
  }
});

test('a stopped scan grants nothing: a delete under its root is refused, not let past the byte cap as 0 bytes', async () => {
  setCap(1000);
  try {
    const { dir, big } = mkRoot('stopped');
    const s = await startScan(dir, {});
    assert.equal(cancelScan(s.scanId), true, 'the scan was stopped while it ran');
    assert.equal(getScan(s.scanId)?.status, 'error');
    assert.equal(insideAnyScanRoot(big), false);
    const answer = await request('DELETE', '/api/files', { paths: [big] });
    assert.deepEqual([answer.status, answer.body.code], [403, 'OUTSIDE_SCAN_ROOT'], JSON.stringify(answer.body));
    assert.ok(fs.existsSync(big), 'nothing was moved');
  } finally {
    setCap(null);
  }
});

test('after a completed scan the cap refuses the oversized file (control), and the audit counts its bytes', async () => {
  setCap(1000);
  try {
    const { dir, big } = mkRoot('control');
    await completedScanOf(dir);
    const answer = await request('DELETE', '/api/files', { paths: [big] });
    assert.deepEqual([answer.status, answer.body.code], [403, 'POLICY_BYTES_EXCEEDED'], JSON.stringify(answer.body));
    const line = await newestAudit();
    assert.deepEqual([line.action, line.outcome, line.code, line.bytes], ['files.trash', 'refused', 'POLICY_BYTES_EXCEEDED', BIG]);
  } finally {
    setCap(null);
  }
});

test('under a byte cap, a file no completed scan sized is refused POLICY_BYTES_UNKNOWN — DELETE, its dry run and the cart', async () => {
  const { dir } = mkRoot('later');
  await completedScanOf(dir);
  const later = path.join(dir, 'later.bin');
  fs.writeFileSync(later, Buffer.alloc(BIG, 9));
  setCap(1000);
  try {
    for (const [url, method, body] of [
      ['/api/files', 'DELETE', { paths: [later], dryRun: true }],
      ['/api/files', 'DELETE', { paths: [later] }],
      ['/api/cart/commit', 'POST', { paths: [later], dryRun: true }],
    ] as const) {
      const answer = await request(method, url, body);
      assert.deepEqual([answer.status, answer.body.code], [403, 'POLICY_BYTES_UNKNOWN'], `${method} ${url}: ${JSON.stringify(answer.body)}`);
      assert.ok(answer.body.error.includes(later), 'the sentence names the path it could not size');
      const line = await newestAudit();
      assert.deepEqual([line.outcome, line.code], ['refused', 'POLICY_BYTES_UNKNOWN'], 'the refusal is audited with its code');
    }
    assert.ok(fs.existsSync(later), 'nothing was moved');
  } finally {
    setCap(null);
  }
  // With no cap there is nothing to hold it to: the dry run answers as before.
  const free = await request('DELETE', '/api/files', { paths: [later], dryRun: true });
  assert.equal(free.status, 200, JSON.stringify(free.body));
});

test('MCP trash_paths reads the same scans: a running scan grants nothing, and an unsized path under a cap is refused', async () => {
  const mcp = buildMcpServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'scangrant', version: '0.0.0' });
  await Promise.all([mcp.connect(st), client.connect(ct)]);
  try {
    const call = async (args: Record<string, unknown>) =>
      (await client.callTool({ name: 'trash_paths', arguments: args })) as { isError?: boolean; content?: Array<{ text?: string }> };
    const running = mkRoot('mcp-running');
    const rec = createScanRecord(running.dir);
    try {
      const r = await call({ paths: [running.big], dryRun: true });
      assert.equal(r.isError, true);
      assert.match(r.content?.[0]?.text ?? '', /OUTSIDE_SCAN_ROOT/);
    } finally {
      cancelScan(rec.scanId);
    }
    const done = mkRoot('mcp-later');
    await completedScanOf(done.dir);
    const later = path.join(done.dir, 'later.bin');
    fs.writeFileSync(later, Buffer.alloc(BIG, 9));
    setCap(1000);
    try {
      const r = await call({ paths: [later], dryRun: true });
      assert.equal(r.isError, true);
      assert.match(r.content?.[0]?.text ?? '', /POLICY_BYTES_UNKNOWN/);
      const line = await newestAudit();
      assert.deepEqual([line.source, line.outcome, line.code], ['mcp', 'refused', 'POLICY_BYTES_UNKNOWN']);
    } finally {
      setCap(null);
    }
  } finally {
    await client.close();
  }
});

test('every route and service that refuses a path a running scan lists says that scan has not finished (review F1.4, F1.6)', async () => {
  const { dir, big } = mkRoot('unfinished-all');
  const { dir: done } = mkRoot('unfinished-src');
  await completedScanOf(done);
  const key = path.join(done, 'id_rsa');
  fs.writeFileSync(key, 'not a real key');
  fs.mkdirSync(path.join(dir, 'repo', '.git'), { recursive: true });
  const rec = createScanRecord(dir);
  const unfinished = new RegExp(`The scan of "${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" has not finished yet`);
  try {
    const q = encodeURIComponent(big);
    const answers: Record<string, { status: number; body: any }> = { // eslint-disable-line @typescript-eslint/no-explicit-any
      preview: await request('GET', `/api/files/preview?path=${q}`),
      provenance: await request('GET', `/api/provenance?path=${q}`),
      encode: await request('POST', '/api/compression/encode', { paths: [big], confirm: true }),
      relocate: await request('POST', '/api/security/relocate', { path: key, to: path.join(dir, 'id_rsa'), confirm: true }),
    };
    for (const [route, answer] of Object.entries(answers)) {
      assert.deepEqual([answer.status, answer.body.code], [403, 'OUTSIDE_SCAN_ROOT'], `${route}: ${JSON.stringify(answer.body)}`);
      assert.match(answer.body.error, unfinished, `${route} says why a folder being scanned is refused`);
    }
    await assert.rejects(relocateSecret(key, path.join(dir, 'id_rsa')), (err: Error) => unfinished.test(err.message), 'relocateSecret says so too');
    const gc = await runGitGc(path.join(dir, 'repo'));
    assert.equal(gc.ok, false);
    assert.match(String(gc.error), unfinished, 'and git gc');
    assert.ok(fs.existsSync(key), 'nothing was moved');
  } finally {
    cancelScan(rec.scanId);
  }
});
