import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';
import { resetRateLimiter, rateLimitLanes } from '../src/middleware/rateLimiter';
import { FileNode } from '../src/models/types';

/**
 * Rate-limiter lanes.
 *
 * Measured against a real boot on a dev server: one page load fires ~25 API
 * requests, and a boot that coincides with a scan completing fires ~12 more in
 * the same tick. On a single 20-token bucket four of them came back 429 —
 * `POST /api/index/build`, `GET /api/forecast`, `GET /api/scan/:id/budgets`,
 * `GET /api/snapshots/compare`. Nothing was lost (the frontend's `api()`
 * retries a 429 with backoff) but each one cost a round of backoff before the
 * first paint and printed a red line in the console during an ordinary action.
 *
 * The two directions that matter are pinned here together, because either one
 * alone is easy to satisfy by breaking the other:
 *
 *  - a realistic boot burst draws no 429 at all, and
 *  - hammering an endpoint that walks a tree or spawns a process still does.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-lanes-'));
fs.writeFileSync(path.join(tmp, 'a.txt'), 'x'.repeat(10));

function tree(): FileNode {
  return {
    name: path.basename(tmp), path: tmp, type: 'dir', modifiedAt: 0, isHidden: false, size: 10,
    children: [{ name: 'a.txt', path: path.join(tmp, 'a.txt'), size: 10, type: 'file', modifiedAt: 0, isHidden: false, extension: 'txt' }],
  };
}

async function listen() {
  resetRateLimiter();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const scan = createScanRecord(tmp);
  scan.status = 'complete';
  scan.root = tree();
  return {
    port: (server.address() as { port: number }).port,
    scanId: scan.scanId,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface Res { status: number; url: string }

function req(port: number, method: string, url: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: url, method }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, url }));
    });
    r.on('error', reject);
    r.end();
  });
}

/**
 * The request list a boot actually issues, recorded from the browser's
 * performance timeline against the dev server. Kept as data rather than prose
 * so the shape of a boot can be re-measured and pasted back in.
 *
 * Only the limiter's verdict is asserted, never the body: a path that answers
 * 404 in this fixture still proves the limiter let it through, which is the
 * whole question.
 */
function bootRequests(scanId: string, p: string): [string, string][] {
  const q = encodeURIComponent(p);
  return [
    // first paint
    ['GET', '/api/settings'],
    ['GET', '/api/platform/portable'],
    ['GET', '/api/system'],
    ['GET', '/api/notes'],
    ['GET', '/api/platform/capabilities'],
    ['GET', '/api/scans'],
    // session restore
    ['GET', `/api/fs/list?path=${q}`],
    ['GET', '/api/trash/size'],
    ['GET', '/api/system/snapshots'],
    ['GET', '/api/cloud/status'],
    ['GET', `/api/index/status?path=${q}`],
    ['GET', `/api/index/tree?path=${q}&maxNodes=25000`],
    ['GET', `/api/snapshots?path=${q}`],
    ['GET', '/api/platform/topology'],
    ['GET', '/api/zombie-handles'],
    ['GET', `/api/scan/${scanId}/progress`],
    // …and the scan completing underneath it
    ['GET', `/api/snapshots?path=${q}`],
    ['GET', `/api/cleanup/suggestions?scanId=${scanId}`],
    ['GET', `/api/large-files?scanId=${scanId}&limit=10&minSize=1`],
    ['GET', `/api/file-types?scanId=${scanId}`],
    ['GET', `/api/large-folders?scanId=${scanId}&limit=10`],
    ['GET', `/api/cost/estimate?scanId=${scanId}&freeable=0&currency=USD`],
    ['GET', '/api/snapshots/compare?a=nope-a&b=nope-b'],
    ['GET', `/api/health/smart?scanId=${scanId}`],
    ['GET', `/api/scan/${scanId}/calendar`],
    ['GET', `/api/forecast?path=${q}`],
    ['GET', `/api/scan/${scanId}/budgets`],
    ['GET', `/api/scan/${scanId}/budget-gauges`],
    ['GET', '/api/notifications?since=0'],
    ['GET', `/api/snapshots?path=${q}`],
    ['POST', '/api/index/build'],
  ];
}

test('a boot that coincides with a scan completing draws no 429 at all', async () => {
  const s = await listen();
  try {
    // All at once: the worst case the timeline shows, with no refill in between.
    const results = await Promise.all(bootRequests(s.scanId, tmp).map(([m, u]) => req(s.port, m, u)));
    const limited = results.filter((r) => r.status === 429).map((r) => r.url);
    assert.deepEqual(limited, [], 'no request of an ordinary boot may be rate limited');
  } finally {
    await s.close();
  }
});

test('the metadata lane survives a boot burst several times over', async () => {
  const s = await listen();
  try {
    // Every cheap read a boot makes, four boots' worth in one tick — a browser
    // reload while the previous page's polls are still in flight.
    const cheap = bootRequests(s.scanId, tmp)
      .filter(([m, u]) => m === 'GET' && rateLimitLanes.laneName('GET', u) === 'meta');
    assert.ok(cheap.length >= 12, 'the boot really is mostly cheap metadata reads');
    const results = await Promise.all(
      Array.from({ length: 4 }, () => cheap.map(([m, u]) => req(s.port, m, u))).flat(),
    );
    assert.equal(results.filter((r) => r.status === 429).length, 0, 'the cheap lane absorbs a repeated boot');
  } finally {
    await s.close();
  }
});

test('hammering an endpoint that walks the disk is still rate limited', async () => {
  const s = await listen();
  try {
    // 60 directory listings at once is not a boot, it is a runaway client.
    const results = await Promise.all(
      Array.from({ length: 60 }, () => req(s.port, 'GET', `/api/fs/list?path=${encodeURIComponent(tmp)}`)),
    );
    const limited = results.filter((r) => r.status === 429).length;
    assert.ok(limited > 0, 'the strict lane must still refuse a flood');
    assert.ok(results.filter((r) => r.status === 200).length <= 21,
      'the strict burst allowance is unchanged — the split must not widen it');
  } finally {
    await s.close();
  }
});

test('draining the strict lane leaves the metadata lane untouched, and the reverse', async () => {
  const s = await listen();
  try {
    await Promise.all(Array.from({ length: 60 }, () => req(s.port, 'GET', `/api/fs/list?path=${encodeURIComponent(tmp)}`)));
    assert.equal((await req(s.port, 'GET', '/api/settings')).status, 200,
      'a flood of tree walks must not starve the app of its own metadata');

    resetRateLimiter();
    await Promise.all(Array.from({ length: 200 }, () => req(s.port, 'GET', '/api/settings')));
    assert.notEqual((await req(s.port, 'GET', `/api/fs/list?path=${encodeURIComponent(tmp)}`)).status, 429,
      'and a flood of metadata reads must not spend the strict allowance');
  } finally {
    await s.close();
  }
});

test('the metadata lane is an allowlist: anything unrecognised is guarded strictly', () => {
  const L = rateLimitLanes;
  // Fail-safe by construction — a route added tomorrow is strict until someone
  // has looked at what it costs.
  assert.equal(L.laneName('GET', '/api/some/route/invented/later'), 'api');
  assert.equal(L.laneName('GET', '/api/duplicates?scanId=x'), 'api');
  assert.equal(L.laneName('GET', '/api/index/tree?path=/x'), 'api');
  assert.equal(L.laneName('GET', '/api/snapshots/tree?path=/x&at=1'), 'api',
    'a stored tree is a tree walk, whatever its prefix');
  assert.equal(L.laneName('GET', '/api/scan/abc/result'), 'api');

  // A write is never a cheap read, even on a path whose GET is one.
  assert.equal(L.laneName('PUT', '/api/settings'), 'api');
  assert.equal(L.laneName('POST', '/api/queries'), 'api');
  assert.equal(L.laneName('DELETE', '/api/notes'), 'api');
  assert.equal(L.laneName('GET', '/api/settings'), 'meta');

  // Mounted at /api the path arrives without the prefix; both spellings agree.
  assert.equal(L.laneName('GET', '/scans'), 'meta');
  assert.equal(L.laneName('GET', '/api/scans'), 'meta');
  assert.equal(L.laneName('GET', '/files/preview?path=/x'), 'preview');
  assert.equal(L.laneName('GET', '/api/files/preview?path=/x'), 'preview');

  // The job-progress polls, which every long job's caller hits on a timer.
  assert.equal(L.laneName('GET', '/api/scan/abc/progress'), 'meta');
  assert.equal(L.laneName('GET', '/api/index/abc/progress'), 'meta');
  assert.equal(L.laneName('GET', '/api/offload/abc/progress'), 'meta');
  assert.equal(L.laneName('GET', '/api/timecapsule/jobs/abc/progress'), 'meta');
  // …but not the results they eventually return, which are the real payload.
  assert.equal(L.laneName('GET', '/api/index/abc/result'), 'api');
});

test('the published rate-limit manifest is generated from the lanes themselves', async () => {
  const s = await listen();
  try {
    const body = await new Promise<Record<string, unknown>>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: s.port, path: '/api/capabilities' }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve(JSON.parse(text)));
      }).on('error', reject);
    });
    const rl = body.rateLimit as { sustainedPerSecond: number; burst: number; lanes: { name: string; burst: number; sustainedPerSecond: number }[] };
    const strict = rateLimitLanes.describe().find((l) => l.name === 'api')!;
    assert.equal(rl.sustainedPerSecond, strict.sustainedPerSecond, 'the headline figures describe the strict lane');
    assert.equal(rl.burst, strict.burst);
    assert.deepEqual(rl.lanes, rateLimitLanes.describe(), 'an agent is told about every lane, not just one');
  } finally {
    await s.close();
  }
});
