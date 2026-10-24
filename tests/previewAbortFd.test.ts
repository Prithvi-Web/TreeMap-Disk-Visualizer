import { test } from 'node:test';
import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';

isolatedDataDir('treemap-previewAbortFd-data-');
import { HANG_GUARD_MS, waitFor } from './fixtures/waitFor';

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

const tmp = fileTempDir('tm-preview-fd-');
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
    connections: () => new Promise<number>((r) => server.getConnections((_err, n) => r(n))),
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
    // An idle socket is a hang only once the hang guard says so: a busy runner can sit on a response for seconds.
    r.setTimeout(HANG_GUARD_MS, () => { r.destroy(); reject(new Error('preview request timed out')); });
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
 * Record every FileHandle the route opens on the fixture, through `fs.promises.open` on the shared
 * `node:fs` module object; a test may hold the open at a gate. A handle's `fd` is -1 once it is closed.
 */
function trackOpens() {
  const promises = fs.promises as unknown as { open: typeof fs.promises.open };
  const real = promises.open;
  const tracker = {
    opened: [] as fs.promises.FileHandle[],
    gate: null as Promise<void> | null,
    onEnter: null as (() => void) | null,
    restore: () => { promises.open = real; },
  };
  promises.open = (async (...args: Parameters<typeof fs.promises.open>) => {
    if (args[0] !== IMG) return real(...args);
    tracker.onEnter?.();
    if (tracker.gate) await tracker.gate;
    const handle = await real(...args);
    tracker.opened.push(handle);
    return handle;
  }) as typeof fs.promises.open;
  return tracker;
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

    // Closing is asynchronous: wait for every close to land, bounded only by the hang guard.
    await waitFor(() => track.opened.every((s) => s.closed), 'every aborted preview closing its read stream', 25);
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
    await waitFor(() => track.opened.every((s) => s.closed), 'a completed preview closing its read stream', 25);
    assert.equal(track.opened.filter((s) => !s.closed).length, 0, 'a completed preview closes its descriptor');
  } finally {
    track.restore();
    await srv.close();
  }
});

test('a read error on the source before any byte is sent answers 500 READ_FAILED as { error, code }, and closes the file', async () => {
  const srv = await listen();
  const real = fs.createReadStream;
  const mutable = fs as unknown as { createReadStream: typeof fs.createReadStream };
  const handles = trackOpens();
  // A source that fails on first read, standing in for the mid-flight EIO /
  // unlink that the route's own 'error' handler exists to answer. The response
  // it produces must not change: destroying the socket instead of replying
  // would turn a diagnosable 500 into a bare socket hang-up. It ignores the
  // descriptor it is handed, so only the route's own close can close that.
  mutable.createReadStream = (() => {
    const s = new Readable({ read() { this.destroy(new Error('simulated read failure')); } });
    return s as unknown as fs.ReadStream;
  }) as typeof fs.createReadStream;
  try {
    const res = await get(srv.port, previewUrl(IMG));
    assert.equal(res.status, 500);
    assert.match(String(res.headers['content-type']), /^application\/json/, 'the answer is typed as JSON, not as the image');
    const body = JSON.parse(res.body.toString('utf8'));
    assert.equal(body.code, 'READ_FAILED');
    assert.match(body.error, /^The image could not be read: simulated read failure/);
    await waitFor(() => handles.opened.length === 1 && handles.opened[0].fd === -1, 'the file the route opened closing', 25);
  } finally {
    mutable.createReadStream = real;
    handles.restore();
    await srv.close();
  }
});

test('a read error part-way through an image ends the connection, so the image never reads as complete (hunt C87)', async () => {
  const srv = await listen();
  const real = fs.createReadStream;
  const mutable = fs as unknown as { createReadStream: typeof fs.createReadStream };
  // One chunk goes out (the headers with it), then the source fails.
  mutable.createReadStream = (() => {
    let sent = false;
    const s = new Readable({
      read() {
        if (!sent) { sent = true; this.push(Buffer.alloc(1_024, 9)); return; }
        setImmediate(() => this.destroy(new Error('simulated failure part-way')));
      },
    });
    return s as unknown as fs.ReadStream;
  }) as typeof fs.createReadStream;
  try {
    const seen = await new Promise<{ status: number; bytes: number; complete: boolean }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: srv.port, path: previewUrl(IMG), method: 'GET' }, (res) => {
        let bytes = 0;
        res.on('data', (c: Buffer) => { bytes += c.length; });
        res.on('error', () => undefined); // the cut connection surfaces here; 'close' says how it ended
        res.on('close', () => resolve({ status: res.statusCode ?? 0, bytes, complete: res.complete }));
      });
      r.on('error', reject);
      r.end();
    });
    assert.deepEqual([seen.status, seen.bytes > 0], [200, true], 'the image had begun: its headers and a first chunk were sent');
    assert.equal(seen.complete, false, 'the response was cut off, not ended as if the image were whole');
  } finally {
    mutable.createReadStream = real;
    await srv.close();
  }
});

test('a preview aborted while its file is still being opened closes that file once the open lands (review F1.9)', async () => {
  const srv = await listen();
  const track = trackReadStreams();
  const handles = trackOpens();
  let arrive!: () => void;
  const entered = new Promise<void>((resolve) => { arrive = resolve; });
  let release!: () => void;
  handles.gate = new Promise<void>((resolve) => { release = resolve; });
  handles.onEnter = arrive;
  try {
    const r = http.request({ host: '127.0.0.1', port: srv.port, path: previewUrl(IMG), method: 'GET' });
    r.on('error', () => undefined); // the abort is the point
    r.end();
    await entered; // the route is waiting on the open
    r.destroy();
    await waitFor(async () => (await srv.connections()) === 0, 'the server seeing the client go', 5);
    release();
    // Either the route closed the file it opened, or it went on to stream it to a response already gone.
    await waitFor(() => handles.opened.length === 1 && (handles.opened[0].fd === -1 || track.opened.length > 0), 'the route going on past the open', 5);
    for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(handles.opened[0].fd, -1, 'the file opened for a response already gone is closed, not left to the garbage collector');
    assert.ok(track.opened.every((s) => s.closed), 'and no read stream is left holding it');
  } finally {
    release();
    track.restore();
    handles.restore();
    await srv.close();
  }
});

test('a preview aborted while the route is still looking at the file (before the open) closes the file it then opens (hunt HF-L2)', async () => {
  const srv = await listen();
  const track = trackReadStreams();
  const handles = trackOpens();
  // Hold the route's first look at the fixture, the lstat that comes before the open.
  const promises = fs.promises as unknown as { lstat: typeof fs.promises.lstat };
  const realLstat = promises.lstat;
  let arrive!: () => void;
  const entered = new Promise<void>((resolve) => { arrive = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  promises.lstat = (async (...args: Parameters<typeof fs.promises.lstat>) => {
    if (args[0] === IMG) {
      arrive();
      await gate;
    }
    return realLstat(...args);
  }) as typeof fs.promises.lstat;
  try {
    const r = http.request({ host: '127.0.0.1', port: srv.port, path: previewUrl(IMG), method: 'GET' });
    r.on('error', () => undefined); // the abort is the point
    r.end();
    await entered; // the route is waiting on the lstat
    r.destroy();
    await waitFor(async () => (await srv.connections()) === 0, 'the server seeing the client go', 5);
    release();
    await waitFor(() => handles.opened.length === 1 && (handles.opened[0].fd === -1 || track.opened.length > 0), 'the route going on past the open', 5);
    for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(handles.opened[0].fd, -1, 'the file opened for a response already gone is closed, not left to the garbage collector');
    assert.ok(track.opened.every((s) => s.closed), 'and no read stream is left holding it');
  } finally {
    release();
    promises.lstat = realLstat;
    track.restore();
    handles.restore();
    await srv.close();
  }
});
