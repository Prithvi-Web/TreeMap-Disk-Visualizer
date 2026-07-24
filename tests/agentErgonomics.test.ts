import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-ergo-test-'));
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { formatBytes } from '../src/utils/formatBytes';

/**
 * Agent ergonomics: the blocking scan path (?wait=true) and the one-call
 * summary. The bar from the master prompt: raw bytes + formatted strings,
 * stable ids, deterministic ordering — and the default POST /api/scan
 * response stays byte-identical to the historical one.
 */

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-ergo-fixture-'));
function write(rel: string, content: Buffer | string): string {
  const p = path.join(fixture, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
write('huge.bin', Buffer.alloc(2 * 1024 * 1024, 1));
write('docs/mid.bin', Buffer.alloc(512 * 1024, 2));
write('proj/package.json', '{}');
write('proj/node_modules/dep/index.js', 'module.exports = 1;');
write('junk/.DS_Store', Buffer.alloc(6148, 0));

async function listen() {
  resetRateLimiter();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function req(port: number, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
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

test('the default POST /api/scan response is byte-identical to the historical shape', async () => {
  const { port, close } = await listen();
  try {
    const r = await req(port, 'POST', '/api/scan', { path: fixture });
    assert.equal(r.status, 202);
    assert.deepEqual(Object.keys(r.body).sort(), ['incremental', 'scanId'], 'exactly the two historical fields');
  } finally {
    await close();
  }
});

test('POST /api/scan?wait=true blocks and answers 200 with the stats inline', async () => {
  const { port, close } = await listen();
  try {
    const r = await req(port, 'POST', '/api/scan?wait=true&waitMs=30000', { path: fixture });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'complete');
    assert.equal(typeof r.body.scanId, 'string');
    // The stats ride along in the exact buildScanStats shape.
    assert.equal(r.body.fileCount, 5);
    assert.equal(typeof r.body.scanned, 'number');
    assert.equal(typeof r.body.durationMs, 'number');
    assert.equal(typeof r.body.engine, 'string');
  } finally {
    await close();
  }
});

test('wait=true with waitMs=0 returns an honest 202 running you can poll', async () => {
  const { port, close } = await listen();
  try {
    // node_modules of this repo: large enough that a 0 ms wait cannot win.
    const big = path.join(__dirname, '..', 'node_modules');
    const r = await req(port, 'POST', '/api/scan?wait=true&waitMs=0', { path: big });
    assert.equal(r.status, 202);
    assert.equal(r.body.status, 'running');
    assert.equal(typeof r.body.scanId, 'string');
    // The documented polling path takes over from here.
    const stats = await req(port, 'GET', `/api/scan/${r.body.scanId}/stats`);
    assert.ok(['running', 'complete'].includes(stats.body.status));
  } finally {
    await close();
  }
});

test('agent summary: raw+formatted bytes, stable ids, deterministic order, real forecast', async () => {
  const { port, close } = await listen();
  try {
    const scan = await req(port, 'POST', '/api/scan?wait=true&waitMs=30000', { path: fixture });
    const scanId = scan.body.scanId as string;

    const r = await req(port, 'GET', `/api/agent/summary?scanId=${scanId}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = r.body;

    assert.equal(s.scanId, scanId);
    assert.equal(s.rootPath, fixture);
    assert.equal(typeof s.totals.bytes, 'number');
    assert.equal(s.totals.formatted, formatBytes(s.totals.bytes), 'raw and formatted agree');
    assert.equal(s.totals.fileCount, 5);

    assert.equal(s.largestFiles[0].name, 'huge.bin', 'largest first');
    assert.equal(s.largestFiles[0].size, 2 * 1024 * 1024);
    assert.equal(s.largestFiles[0].sizeFormatted, '2.0 MB');
    const fileSizes = s.largestFiles.map((f: { size: number }) => f.size);
    assert.deepEqual(fileSizes, [...fileSizes].sort((a, b) => b - a), 'files size-desc');

    const folderSizes = s.largestFolders.map((f: { size: number }) => f.size);
    assert.deepEqual(folderSizes, [...folderSizes].sort((a, b) => b - a), 'folders size-desc');

    const nm = s.cleanup.groups.find((g: { id: string }) => g.id === 'regen-node-modules');
    assert.ok(nm, 'stable rule id present');
    assert.equal(nm.regenerateCmd, 'npm install');
    assert.equal(nm.totalSizeFormatted, formatBytes(nm.totalSize));
    const junk = s.cleanup.byCategory.find((c: { category: string }) => c.category === 'junk');
    assert.ok(junk && junk.bytes > 0, '.DS_Store lands in the junk category');
    assert.equal(s.cleanup.reclaimableFormatted, formatBytes(s.cleanup.reclaimableBytes));

    assert.ok(['ok', 'insufficient', 'stable', 'shrinking', 'erratic'].includes(s.forecast.status));
    assert.equal(typeof s.forecast.bytesPerDayFormatted, 'string');

    // Deterministic: an immediate second read is identical.
    const again = await req(port, 'GET', `/api/agent/summary?scanId=${scanId}`);
    assert.deepEqual(again.body, s, 'two reads over the same scan are identical');
  } finally {
    await close();
  }
});

test('agent summary answers 202 while the scan is still running and 404 for unknown scans', async () => {
  const { port, close } = await listen();
  try {
    const big = path.join(__dirname, '..', 'node_modules');
    const started = await req(port, 'POST', '/api/scan', { path: big });
    const r = await req(port, 'GET', `/api/agent/summary?scanId=${started.body.scanId}`);
    assert.equal(r.status, 202);
    assert.equal(r.body.status, 'running');

    const missing = await req(port, 'GET', '/api/agent/summary?scanId=nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'SCAN_NOT_FOUND');
  } finally {
    await close();
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(process.env.TREEMAP_DATA_DIR!, { recursive: true, force: true });
  }
});
