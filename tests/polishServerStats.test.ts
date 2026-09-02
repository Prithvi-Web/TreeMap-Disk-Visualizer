import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-polish-stats-data-'));
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { buildScanStats } from '../src/api/scanRoutes';
import {
  startScan, getScan, peekScan, createScanRecord, scanExpired, scanExpiresAt, SCAN_TTL_MS,
} from '../src/services/diskScanner';
import { mapGduTree, mapGduTreeIntoStore } from '../src/services/gduMapper';
import { PackedScanStore } from '../src/services/scanStore';
import type { ScanResult } from '../src/models/types';

/**
 * Two things the scan stats now say that they used to keep to themselves:
 *
 *  - `refused: { dirs, examples }` — folders the OS would not let the scan
 *    list. The walker counted them (deniedDirs) but nothing published the
 *    count, so a protected folder scanned as "Scan complete — 0 B across 0
 *    files". Examples are at most five absolute paths, in a deterministic
 *    (sorted) order, so the page can name one.
 *  - `expiresAt` — when the results will be evicted. Results used to expire
 *    30 minutes after a scan settled with no touch-on-read, so a page that
 *    was actively in use lost its scan under it. Every read of a scanId now
 *    refreshes the clock (at minute granularity, so a stats read and the
 *    'complete' frame that preceded it agree).
 */

const MIN = 60_000;
const canLock = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0);

function record(overrides: Partial<ScanResult>): ScanResult {
  const now = Date.now();
  return {
    scanId: 'test', rootPath: '/tmp/x', status: 'complete', scanned: 1, fileCount: 1, dirCount: 0,
    currentPath: '/tmp/x', startedAt: now, createdAt: now, cancelled: false,
    ...overrides,
  };
}

async function settled(dir: string): Promise<ScanResult> {
  const scan = await startScan(dir);
  const deadline = Date.now() + 15_000;
  while (getScan(scan.scanId)?.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return getScan(scan.scanId)!;
}

function getJson(port: number, url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
    }).on('error', reject);
  });
}

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/* ───────────────────────────── refused ───────────────────────────── */

test('a scan with nothing refused says so explicitly', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-polish-open-'));
  fs.writeFileSync(path.join(base, 'a.txt'), 'a');
  const scan = await settled(base);
  assert.equal(scan.status, 'complete');
  const stats = buildScanStats(scan);
  assert.deepEqual(stats.refused, { dirs: 0, examples: [] });
  assert.equal(stats.vanishedDirs, 0);
});

test('folders the OS refused are counted and up to five are named, sorted', { skip: !canLock && 'needs chmod-000 folders' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-polish-refused-'));
  const locked: string[] = [];
  for (const name of ['g', 'c', 'a', 'e', 'b', 'f', 'd']) {
    const dir = path.join(base, `locked-${name}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'hidden.bin'), Buffer.alloc(1000));
    fs.chmodSync(dir, 0o000);
    locked.push(dir);
  }
  fs.mkdirSync(path.join(base, 'open'));
  fs.writeFileSync(path.join(base, 'open', 'seen.txt'), 'seen');
  try {
    const scan = await settled(base);
    assert.equal(scan.status, 'complete');
    const stats = buildScanStats(scan);
    assert.equal(stats.refused.dirs, 7);
    assert.deepEqual(stats.refused.examples, locked.slice().sort().slice(0, 5), 'the five smallest paths, sorted');

    const { port, close } = await listen();
    try {
      const r = await getJson(port, `/api/scan/${scan.scanId}/stats`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.refused, stats.refused, 'the route publishes the same shape');
    } finally {
      await close();
    }
  } finally {
    for (const dir of locked) fs.chmodSync(dir, 0o755);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the gdu mapper reads ncdu-format read_error as a refused folder', () => {
  const doc = [1, 2, { progname: 'gdu', progver: 'v5.36.1', timestamp: 1 },
    [{ name: '/fx', mtime: 1 },
      { name: 'a.txt', asize: 5, dsize: 4096, mtime: 1 },
      [{ name: 'locked', mtime: 1, read_error: true }],
      [{ name: 'open', mtime: 1 }, { name: 'b.txt', asize: 1, dsize: 4096, mtime: 1 }],
    ]];
  const { stats } = mapGduTree(doc, '/fx');
  assert.equal(stats.deniedDirs, 1);
  assert.deepEqual(stats.deniedExamples, ['/fx/locked']);

  const store = new PackedScanStore('/fx', '/', { name: 'fx', isDir: true, size: 0, modifiedAt: 0, isHidden: false });
  const viaStore = mapGduTreeIntoStore(doc, '/fx', store, store.rootId);
  assert.equal(viaStore.stats.deniedDirs, 1);
  assert.deepEqual(viaStore.stats.deniedExamples, ['/fx/locked']);

  const clean = mapGduTree([1, 2, {}, [{ name: '/fx', mtime: 1 }, [{ name: 'open', mtime: 1 }]]], '/fx');
  assert.equal(clean.stats.deniedDirs, 0);
  assert.deepEqual(clean.stats.deniedExamples, []);
});

/* ───────────────────────────── expiresAt ───────────────────────────── */

test('a scan that is being used never expires under the page', () => {
  const now = Date.now();
  const idle = record({ createdAt: now - 90 * MIN, finishedAt: now - 45 * MIN });
  assert.equal(scanExpired(idle, now), true, 'untouched for 45 minutes: gone');
  const used = record({ createdAt: now - 90 * MIN, finishedAt: now - 45 * MIN, lastUsedAt: now - 1 * MIN });
  assert.equal(scanExpired(used, now), false, 'read a minute ago: kept');
  assert.equal(scanExpired(used, now + 30 * MIN), true, 'and expires 30 minutes after that read');
  assert.equal(scanExpiresAt(used), now - 1 * MIN + SCAN_TTL_MS);
  assert.equal(scanExpiresAt(idle), now - 45 * MIN + SCAN_TTL_MS);
  assert.equal(scanExpiresAt(record({ status: 'running' })), null, 'a running scan has no expiry to warn about');
  assert.equal(SCAN_TTL_MS, 30 * MIN);
});

test('getScan refreshes the clock; peekScan does not', () => {
  const scan = createScanRecord(os.tmpdir());
  scan.status = 'complete';
  scan.finishedAt = Date.now() - 20 * MIN;
  assert.equal(scan.lastUsedAt, undefined);
  assert.equal(peekScan(scan.scanId), scan);
  assert.equal(scan.lastUsedAt, undefined, 'a housekeeping look is not a use');
  const before = Date.now();
  assert.equal(getScan(scan.scanId), scan);
  assert.ok((scan.lastUsedAt ?? 0) >= before, 'a real read stamps lastUsedAt');
  const stamped = scan.lastUsedAt;
  getScan(scan.scanId);
  assert.equal(scan.lastUsedAt, stamped, 'a second read within the minute keeps the stamp, so a frame and a stats read agree');
  scan.lastUsedAt = Date.now() - 2 * MIN;
  getScan(scan.scanId);
  assert.ok((scan.lastUsedAt ?? 0) >= before, 'a read more than a minute later refreshes it');
  assert.equal(getScan('no-such-scan'), undefined);
});

test('/stats publishes expiresAt about thirty minutes out, and reading keeps it there', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-polish-expires-'));
  fs.writeFileSync(path.join(base, 'a.txt'), 'a');
  const scan = await settled(base);
  scan.finishedAt = Date.now() - 25 * MIN; // pretend the scan settled a while ago
  scan.lastUsedAt = undefined;
  const { port, close } = await listen();
  try {
    const before = Date.now();
    const r = await getJson(port, `/api/scan/${scan.scanId}/stats`);
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.expiresAt, 'number');
    assert.ok(r.body.expiresAt >= before + SCAN_TTL_MS - 1000, 'the read itself pushed the expiry out to now + 30 min');
    assert.ok(r.body.expiresAt <= Date.now() + SCAN_TTL_MS + 1000);
    assert.equal(scanExpired(scan, Date.now() + 6 * MIN), false, 'what would have expired in five minutes now survives');
  } finally {
    await close();
  }
});
