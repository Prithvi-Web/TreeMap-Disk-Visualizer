import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { FileNode } from '../src/models/types';

/**
 * Aborted image previews must not leak file descriptors.
 *
 * `GET /api/files/preview` streams an image with a plain `stream.pipe(res)`.
 * `Readable.pipe` unpipes when the destination emits 'close' or 'error', but it
 * never *destroys* the source: an aborted response therefore leaves the
 * `fs.ReadStream` sitting paused with its descriptor still open, and nothing
 * ever closes it (Node's ReadStream has no GC finalizer that would).
 *
 * That is not a theoretical drip. The preview lane deliberately allows a 300
 * burst / 150 per second precisely because the near-duplicate strip fires one
 * request per visible row, and a user scrolling that strip cancels almost every
 * one of them — the browser aborts the in-flight <img> the moment the row
 * scrolls out. A few minutes of scrolling is hundreds of stranded descriptors
 * and then EMFILE, which takes down the whole server, not just previews.
 *
 * The invariant pinned here: every descriptor the preview route opens is closed
 * once the response is over, however the response ended — and the ordinary
 * completed response is byte-for-byte, header-for-header, status-for-status
 * what it always was.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-preview-fd-'));
const IMG = path.join(tmp, 'big.png');

/**
 * Big enough that a client aborting after the first chunk is guaranteed to be
 * mid-file: the read stream still has ~3 MB to go, so it is unambiguously still
 * holding its descriptor at the moment of the abort. (A tiny fixture would
 * finish and auto-close before the abort landed, and the test would pass for
 * the wrong reason.) Content is noise — the route dispatches on the extension
 * and the size, and never decodes an inline preview.
 */
const IMG_BYTES = 3 * 1024 * 1024;
{
  const buf = Buffer.alloc(IMG_BYTES);
  for (let i = 0; i < IMG_BYTES; i++) buf[i] = (i * 31 + 7) & 0xff;
  fs.writeFileSync(IMG, buf);
}

function tree(): FileNode {
  const st = fs.statSync(IMG);
  return {
    name: path.basename(tmp), path: tmp, type: 'dir', modifiedAt: 0, isHidden: false, size: st.size,
    children: [
      { name: 'big.png', path: IMG, size: st.size, type: 'file', modifiedAt: st.mtimeMs, isHidden: false, extension: 'png' },
    ],
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
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const previewUrl = (p: string) => `/api/files/preview?path=${encodeURIComponent(p)}`;

/** Fire a preview and kill the socket the instant the first body chunk lands. */
function abortAfterFirstChunk(port: number, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: url, method: 'GET' }, (res) => {
      res.once('data', () => {
        r.destroy();
        // Give the server a turn to notice the dead socket and run whatever
        // cleanup it has, before the assertions look at the descriptors.
        setTimeout(resolve, 10);
      });
    });
    // The abort itself surfaces here as ECONNRESET/socket hang up; that is the
    // point of the test, not a failure.
    r.on('error', () => resolve());
    r.setTimeout(5000, () => { r.destroy(); reject(new Error('preview request timed out')); });
    r.end();
  });
}

interface FullResponse { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

function get(port: number, url: string): Promise<FullResponse> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: url, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}

/**
 * Record every fs.ReadStream the route opens.
 *
 * The route reaches the descriptor through `fs.createReadStream`, so wrapping
 * that on the shared `node:fs` module object sees exactly the streams the
 * handler creates — no more, no less. `stream.closed` flips true only when the
 * descriptor is actually closed, which makes this a direct read of the thing
 * under test rather than a proxy for it, and it is deterministic on every
 * platform (unlike `lsof`, used below only as a corroborating cross-check).
 */
function trackReadStreams() {
  const real = fs.createReadStream;
  const opened: fs.ReadStream[] = [];
  const mutable = fs as unknown as { createReadStream: typeof fs.createReadStream };
  mutable.createReadStream = ((...args: Parameters<typeof fs.createReadStream>) => {
    const s = real(...args);
    opened.push(s);
    return s;
  }) as typeof fs.createReadStream;
  return { opened, restore: () => { mutable.createReadStream = real; } };
}

/**
 * Corroborating cross-check: how many descriptors this process holds on the
 * fixture, according to `lsof`. A heuristic by nature — it shells out, and it
 * is skipped entirely where `lsof` is missing (Windows, slim containers) — so
 * it never carries the test on its own; it exists so the stream bookkeeping
 * above is checked against the operating system's own view at least once.
 */
function lsofCount(file: string): number | null {
  try {
    const out = execFileSync('lsof', ['-p', String(process.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((line) => line.includes(file)).length;
  } catch (err) {
    // A non-zero exit with no matching line is normal for lsof; only treat an
    // actual "command not found" as "no cross-check available".
    const e = err as { code?: string; status?: number; stdout?: string };
    if (e.status === 1 && typeof e.stdout === 'string') {
      return e.stdout.split('\n').filter((line) => line.includes(file)).length;
    }
    return null;
  }
}

test('an aborted image preview closes the descriptor it opened', async () => {
  const srv = await listen();
  const track = trackReadStreams();
  try {
    const ABORTS = 40; // decisive: 40 stranded fds is well past coincidence
    for (let i = 0; i < ABORTS; i++) {
      await abortAfterFirstChunk(srv.port, previewUrl(IMG));
    }
    assert.equal(track.opened.length, ABORTS, 'every aborted preview opened exactly one read stream');

    // Closing is asynchronous — allow a couple of turns for the close to land.
    for (let i = 0; i < 20 && track.opened.some((s) => !s.closed); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const stillOpen = track.opened.filter((s) => !s.closed).length;
    assert.equal(stillOpen, 0, `${stillOpen} of ${ABORTS} aborted previews left their file descriptor open`);

    const held = lsofCount(IMG);
    if (held !== null) {
      assert.equal(held, 0, `lsof still shows ${held} open descriptor(s) on the aborted preview fixture`);
    }
  } finally {
    track.restore();
    await srv.close();
  }
});

test('a completed image preview still sends the same bytes, headers and status', async () => {
  const srv = await listen();
  const track = trackReadStreams();
  try {
    const res = await get(srv.port, previewUrl(IMG));
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.body.length, IMG_BYTES, 'the whole image is delivered, not a truncated prefix');
    assert.ok(res.body.equals(fs.readFileSync(IMG)), 'the delivered bytes are the file\'s bytes');

    // The success path must close its descriptor too — the fix must not turn
    // "leaks on abort" into "leaks on success" by holding the stream open.
    for (let i = 0; i < 20 && track.opened.some((s) => !s.closed); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(track.opened.filter((s) => !s.closed).length, 0, 'a completed preview closes its descriptor');
  } finally {
    track.restore();
    await srv.close();
  }
});

test('a read error on the source still answers 500', async () => {
  const srv = await listen();
  const real = fs.createReadStream;
  const mutable = fs as unknown as { createReadStream: typeof fs.createReadStream };
  // A source that fails on first read, standing in for the mid-flight EIO /
  // unlink that the route's own 'error' handler exists to answer. The response
  // it produces must not change: destroying the socket instead of replying
  // would turn a diagnosable 500 into a bare socket hang-up.
  mutable.createReadStream = (() => {
    const s = new Readable({ read() { this.destroy(new Error('simulated read failure')); } });
    return s as unknown as fs.ReadStream;
  }) as typeof fs.createReadStream;
  try {
    const res = await get(srv.port, previewUrl(IMG));
    assert.equal(res.status, 500);
  } finally {
    mutable.createReadStream = real;
    await srv.close();
  }
});
