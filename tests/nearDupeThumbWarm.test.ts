import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { resetThumbnailCache, thumbnailCacheStats } from '../src/services/thumbnailCache';
import { resetBackgroundWrites, settled } from '../src/utils/backgroundWrites';
import { FileNode } from '../src/models/types';

/**
 * The near-duplicate strip's thumbnails are warmed the moment the job lands.
 *
 * Measured in the browser against a 240-image corpus: a thumbnail the server
 * has never rendered costs ~46 ms median (a sharp decode, four at a time),
 * one it has cached costs ~6 ms. The strip lazy-loads a cluster's images as
 * the user scrolls it into view, so every fresh cluster used to be 24 cold
 * renders and a visible pop-in of images over a few hundred milliseconds —
 * the "glitchy when I go up and down" the owner reported. The fingerprinting
 * job already knows exactly which files the strip will show; when it
 * completes, the route renders their thumbnails in the background so a scroll
 * only ever hits the cache.
 */

let sharpAvailable = true;
try {
  require('sharp');
} catch {
  sharpAvailable = false;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ndwarm-'));
const A1 = path.join(tmp, 'same-a.png');
const A2 = path.join(tmp, 'same-b.png');
const LONE = path.join(tmp, 'lone.png');

/**
 * Two byte-identical images (a cluster) and one that matches nothing. Noise
 * rather than a pattern, and 128px rather than 64: the job ignores images
 * under 4 KB (MIN_IMAGE_BYTES), and a smooth pattern compresses below that.
 */
async function writeFixtures(): Promise<void> {
  const sharp = require('sharp');
  const noise = (seed: number): Buffer => {
    const raw = Buffer.alloc(128 * 128 * 3);
    let x = seed >>> 0;
    for (let i = 0; i < raw.length; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; raw[i] = x >>> 24; }
    return raw;
  };
  const same = noise(7);
  await sharp(same, { raw: { width: 128, height: 128, channels: 3 } }).png().toFile(A1);
  await sharp(same, { raw: { width: 128, height: 128, channels: 3 } }).png().toFile(A2);
  await sharp(noise(99), { raw: { width: 128, height: 128, channels: 3 } }).png().toFile(LONE);
  for (const p of [A1, A2, LONE]) assert.ok(fs.statSync(p).size > 4 * 1024, `${path.basename(p)} must clear the job's 4 KB floor`);
}

function tree(): FileNode {
  const files = [A1, A2, LONE].map((p) => {
    const st = fs.statSync(p);
    return { name: path.basename(p), path: p, size: st.size, type: 'file' as const, modifiedAt: Math.round(st.mtimeMs), isHidden: false, extension: 'png' };
  });
  return { name: path.basename(tmp), path: tmp, type: 'dir', modifiedAt: 0, isHidden: false, size: files.reduce((s, f) => s + f.size, 0), children: files };
}

async function listen() {
  resetRateLimiter();
  resetThumbnailCache();
  resetBackgroundWrites();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const scan = createScanRecord(tmp);
  scan.status = 'complete';
  scan.root = tree();
  return { port: (server.address() as { port: number }).port, scanId: scan.scanId, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function get(port: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: url, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function nearDupes(port: number, scanId: string): Promise<{ clusters: Array<{ files: Array<{ path: string }> }> }> {
  for (let i = 0; i < 200; i++) {
    const r = await get(port, `/api/near-duplicates?scanId=${scanId}&threshold=4`);
    if (r.status === 200) return JSON.parse(r.body);
    assert.equal(r.status, 202, `polling the job: ${r.status} ${r.body.slice(0, 120)}`);
    await new Promise((res) => setTimeout(res, 25));
  }
  return assert.fail('the near-duplicate job never completed');
}

test('the clustered files are thumbnailed in the background as soon as the job completes', { skip: !sharpAvailable }, async () => {
  await writeFixtures();
  const s = await listen();
  try {
    assert.equal(thumbnailCacheStats().entries, 0, 'nothing cached before the job');
    const data = await nearDupes(s.port, s.scanId);
    assert.equal(data.clusters.length, 1, 'the two identical images form one cluster');
    const clustered = data.clusters[0]!.files.map((f) => f.path).sort();
    assert.deepEqual(clustered, [A1, A2].sort());
    await settled(); // the warm is a tracked background write — wait for it, never poll
    assert.equal(thumbnailCacheStats().entries, 2, 'exactly the clustered files are cached, and nothing else');
    // The lone image was NOT warmed — it is not in the strip, so the warm must
    // not spend a decode on it; asking for it now is the one render left.
    await get(s.port, `/api/files/preview?thumb=1&path=${encodeURIComponent(LONE)}`);
    assert.equal(thumbnailCacheStats().entries, 3, 'an unclustered file renders on request, as before');
    // A clustered file is a hit: no new entry, no render.
    await get(s.port, `/api/files/preview?thumb=1&path=${encodeURIComponent(A1)}`);
    assert.equal(thumbnailCacheStats().entries, 3, 'the strip’s own request costs no render');
  } finally {
    await s.close();
  }
});

test('a completed job warms once, however many times the strip re-asks for it', { skip: !sharpAvailable }, async () => {
  await writeFixtures();
  const s = await listen();
  try {
    await nearDupes(s.port, s.scanId);
    await settled();
    assert.equal(thumbnailCacheStats().entries, 2);
    resetThumbnailCache(); // if the route re-warmed on every GET, this would refill
    await nearDupes(s.port, s.scanId);
    await nearDupes(s.port, s.scanId);
    await settled();
    assert.equal(thumbnailCacheStats().entries, 0, 'the second and third reads of the same job start no new warm');
  } finally {
    await s.close();
  }
});
