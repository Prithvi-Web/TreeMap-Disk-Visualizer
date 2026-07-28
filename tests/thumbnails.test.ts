import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { resetThumbnailCache, thumbnailCacheKey, thumbnailCacheStats, getOrRenderThumbnail } from '../src/services/thumbnailCache';
import { FileNode } from '../src/models/types';

/**
 * Thumbnails for the near-duplicate strip.
 *
 * The strip asks for one image per visible row, so these requests arrive in
 * bursts of dozens. Before this work they shared the 20-token API bucket (40 of
 * 60 came back 429, and an <img> cannot retry, so each one became a permanently
 * broken thumbnail) and carried `Cache-Control: no-store`, so every re-render
 * paid the full ~20 ms sharp decode again. Both are pinned here.
 */

let sharpAvailable = true;
try {
  require('sharp');
} catch {
  sharpAvailable = false;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-thumb-'));
const IMG = path.join(tmp, 'pic.png');
const OTHER = path.join(tmp, 'pic2.png');

/** A real 32×32 PNG, written by sharp so the decode path is genuinely exercised. */
async function writeFixtures(): Promise<void> {
  const sharp = require('sharp');
  const raw = Buffer.alloc(32 * 32 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) % 256;
  await sharp(raw, { raw: { width: 32, height: 32, channels: 3 } }).png().toFile(IMG);
  await sharp(raw, { raw: { width: 32, height: 32, channels: 3 } }).png().toFile(OTHER);
}

function tree(): FileNode {
  const st = fs.statSync(IMG);
  const st2 = fs.statSync(OTHER);
  return {
    name: path.basename(tmp), path: tmp, type: 'dir', modifiedAt: 0, isHidden: false, size: st.size + st2.size,
    children: [
      { name: 'pic.png', path: IMG, size: st.size, type: 'file', modifiedAt: st.mtimeMs, isHidden: false, extension: 'png' },
      { name: 'pic2.png', path: OTHER, size: st2.size, type: 'file', modifiedAt: st2.mtimeMs, isHidden: false, extension: 'png' },
    ],
  };
}

async function listen() {
  resetRateLimiter();
  resetThumbnailCache();
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

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; bytes: number }

function get(port: number, url: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: url, method: 'GET', headers }, (res) => {
      let bytes = 0;
      res.on('data', (c: Buffer) => { bytes += c.length; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes }));
    });
    r.on('error', reject);
    r.end();
  });
}

const thumbUrl = (p: string) => `/api/files/preview?thumb=1&path=${encodeURIComponent(p)}`;

test('a burst of thumbnails is not rate limited into broken images', { skip: !sharpAvailable }, async () => {
  await writeFixtures();
  const s = await listen();
  try {
    // 60 at once is one screenful of the strip. On the shared API bucket this
    // returned 20 OK / 40 rate-limited.
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => get(s.port, thumbUrl(i % 2 ? IMG : OTHER)))
    );
    const limited = results.filter((r) => r.status === 429);
    assert.equal(limited.length, 0, 'no thumbnail request may be rate limited');
    assert.ok(results.every((r) => r.status === 200), 'every thumbnail returns 200');
    assert.ok(results.every((r) => r.headers['content-type'] === 'image/webp'));
  } finally {
    await s.close();
  }
});

test('the preview lane does not drain the API lane, and vice versa', { skip: !sharpAvailable }, async () => {
  await writeFixtures();
  const s = await listen();
  try {
    // Spend the whole preview burst allowance…
    await Promise.all(Array.from({ length: 60 }, () => get(s.port, thumbUrl(IMG))));
    // …the ordinary API is untouched by it.
    const sys = await get(s.port, '/api/system');
    assert.equal(sys.status, 200, 'a thumbnail storm must not 429 the app’s own data calls');
  } finally {
    await s.close();
  }
});

test('a thumbnail is cached and revalidates with 304 instead of decoding again', { skip: !sharpAvailable }, async () => {
  await writeFixtures();
  const s = await listen();
  try {
    const first = await get(s.port, thumbUrl(IMG));
    assert.equal(first.status, 200);
    assert.ok(first.bytes > 0, 'the first response carries real bytes');
    const etag = String(first.headers.etag);
    assert.match(etag, /^"tm-[0-9a-f]{40}"$/, 'strong ETag derived from the cache key');
    assert.equal(first.headers['cache-control'], 'private, max-age=86400');

    assert.equal(thumbnailCacheStats().entries, 1, 'rendering populated the cache');

    const revalidated = await get(s.port, thumbUrl(IMG), { 'If-None-Match': etag });
    assert.equal(revalidated.status, 304, 'an unchanged thumbnail costs a 304');
    assert.equal(revalidated.bytes, 0, '304 carries no body');

    const second = await get(s.port, thumbUrl(IMG));
    assert.equal(second.status, 200);
    assert.equal(second.headers.etag, etag, 'the same file yields the same ETag');
    assert.equal(second.bytes, first.bytes);
  } finally {
    await s.close();
  }
});

test('editing the file invalidates its thumbnail', { skip: !sharpAvailable }, async () => {
  await writeFixtures();
  const s = await listen();
  try {
    const before = await get(s.port, thumbUrl(IMG));
    const sharp = require('sharp');
    const raw = Buffer.alloc(64 * 64 * 3, 200);
    await sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).png().toFile(IMG);
    // The scan tree still holds the OLD size/mtime; the route stats the file
    // itself, so the key moves with the file rather than with the scan.
    const after = await get(s.port, thumbUrl(IMG));
    assert.equal(after.status, 200);
    assert.notEqual(after.headers.etag, before.headers.etag, 'a changed file must not reuse a cached thumbnail');
  } finally {
    await s.close();
  }
});

test('the cache key separates path, mtime, size and dimension', () => {
  const a = thumbnailCacheKey('/a/b.png', 1000, 50, 256);
  assert.equal(a, thumbnailCacheKey('/a/b.png', 1000, 50, 256), 'same inputs, same key');
  assert.notEqual(a, thumbnailCacheKey('/a/c.png', 1000, 50, 256));
  assert.notEqual(a, thumbnailCacheKey('/a/b.png', 1001, 50, 256));
  assert.notEqual(a, thumbnailCacheKey('/a/b.png', 1000, 51, 256));
  assert.notEqual(a, thumbnailCacheKey('/a/b.png', 1000, 50, 128));
  // Rounded, because lstat hands back a float and sub-millisecond drift is not
  // a content change.
  assert.equal(a, thumbnailCacheKey('/a/b.png', 1000.4, 50, 256));
});

test('concurrent requests for one image share a single decode', { skip: !sharpAvailable }, async () => {
  await writeFixtures();
  resetThumbnailCache();
  const st = fs.statSync(IMG);
  const all = await Promise.all(
    Array.from({ length: 8 }, () => getOrRenderThumbnail(IMG, st.mtimeMs, st.size, 256))
  );
  assert.ok(all.every((e) => e !== null));
  // Single-flight: every caller got the identical object, not eight decodes.
  assert.ok(all.every((e) => e === all[0]), 'all callers share one rendered buffer');
  assert.equal(thumbnailCacheStats().entries, 1);
});

test('an undecodable file yields null rather than throwing', async () => {
  const junk = path.join(tmp, 'not-an-image.png');
  fs.writeFileSync(junk, Buffer.from('this is definitely not a png'));
  const st = fs.statSync(junk);
  assert.equal(await getOrRenderThumbnail(junk, st.mtimeMs, st.size, 256), null);
});
