import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-scanProgress-data-');
import { HANG_GUARD_MS } from './fixtures/waitFor';

import { readFileSync } from 'node:fs';
import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';
import { FileNode, ScanEvent } from '../src/models/types';
import { setTreeFrameMaxCharsForTests } from '../src/services/treeFrame';
import { HEARTBEAT_TICKS, PROGRESS_TICK_MS, holdFinalFrameForTests, progressTick, type ProgressTickState } from '../src/api/scanRoutes';

/**
 * Progress-stream failure modes.
 *
 * A finished tree is handed to the UI as one `complete` SSE frame. It used to
 * be one JSON.stringify of every node: past roughly 3.5M nodes the result
 * exceeded V8's ~512 MB cap on a single string and stringify threw RangeError,
 * in a setInterval callback where Express cannot catch it — it killed the
 * whole process. Since Phase 4 T9b the frame is written from the store in
 * chunks and counted before its first byte, and a frame longer than V8's
 * longest string is refused with the same error instead.
 *
 * Lowering that limit (setTreeFrameMaxCharsForTests) reproduces this in
 * milliseconds instead of requiring a real 4-million-file disk. (These tests
 * used to make a root's `toJSON` throw the RangeError the one-string frame
 * hit; the frame no longer calls it.)
 */

/** A root the stream can send, until the limit is lowered below its frame. */
function tooBigRoot(rootPath: string): FileNode {
  return {
    name: 'root',
    path: rootPath,
    size: 1,
    type: 'dir',
    modifiedAt: 0,
    isHidden: false,
    children: [{ name: 'a.bin', path: `${rootPath}/a.bin`, size: 1, type: 'file', modifiedAt: 0, isHidden: false }],
  };
}

/** Frames longer than this are refused: shorter than any `complete` frame here. */
const TOO_LONG = 64;

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Open the progress stream and collect frames until the server closes it.
 * `onFrame` lets a test mutate the scan in reaction to a frame.
 */
function collectEvents(
  port: number,
  scanId: string,
  onFrame: (event: ScanEvent) => void = () => {},
): Promise<ScanEvent[]> {
  return new Promise((resolve, reject) => {
    const events: ScanEvent[] = [];
    const req = http.get({ host: '127.0.0.1', port, path: `/api/scan/${scanId}/progress` }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let split: number;
        while ((split = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, split);
          buf = buf.slice(split + 2);
          if (!frame.startsWith('data: ')) continue; // keep-alive comment frame
          const event = JSON.parse(frame.slice(6)) as ScanEvent;
          events.push(event);
          onFrame(event);
        }
      });
      res.on('end', () => resolve(events));
      res.on('error', reject);
    });
    req.on('error', reject);
    // Idle for the hang guard, not for seconds: the server sends a keep-alive only after 10 s without progress.
    req.setTimeout(HANG_GUARD_MS, () => reject(new Error('progress stream never closed')));
  });
}

test('a tree too large to serialize closes the stream with an error instead of crashing', async (t) => {
  setTreeFrameMaxCharsForTests(TOO_LONG);
  t.after(() => setTreeFrameMaxCharsForTests(null));
  const scan = createScanRecord('/too-big');
  scan.scanned = 4_235_109;
  scan.fileCount = 4_000_000;
  scan.dirCount = 235_109;

  const { port, close } = await listen();
  try {
    // The stream opens while the scan is still running, so completion is
    // delivered by the interval timer — the path that took the app down.
    const events = await collectEvents(port, scan.scanId, (event) => {
      if (event.type === 'progress') {
        scan.status = 'complete';
        scan.root = tooBigRoot('/too-big');
      }
    });

    const last = events[events.length - 1];
    assert.equal(last.type, 'error', `expected a final error frame, got ${last.type}`);
    assert.match((last as { message: string }).message, /too large/i);
    // The message must name the scale so the user knows why it was refused.
    assert.match((last as { message: string }).message, /4,235,109/);
  } finally {
    await close();
  }
});

test('an oversized tree is reported the same way when the scan finished before the stream opened', async (t) => {
  setTreeFrameMaxCharsForTests(TOO_LONG);
  t.after(() => setTreeFrameMaxCharsForTests(null));
  const scan = createScanRecord('/too-big-already');
  scan.scanned = 9_000_000;
  scan.fileCount = 8_000_000;
  scan.dirCount = 1_000_000;
  scan.status = 'complete';
  scan.root = tooBigRoot('/too-big-already');

  const { port, close } = await listen();
  try {
    const events = await collectEvents(port, scan.scanId);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.match((events[0] as { message: string }).message, /9,000,000/);
  } finally {
    await close();
  }
});

test('a normal tree still streams progress and completes', async () => {
  const scan = createScanRecord('/small');
  const root: FileNode = {
    name: 'small',
    path: '/small',
    size: 10,
    type: 'dir',
    modifiedAt: 0,
    isHidden: false,
    children: [
      { name: 'a.txt', path: '/small/a.txt', size: 10, type: 'file', modifiedAt: 0, isHidden: false },
    ],
  };

  const { port, close } = await listen();
  try {
    const events = await collectEvents(port, scan.scanId, (event) => {
      if (event.type === 'progress') {
        scan.status = 'complete';
        scan.root = root;
      }
    });

    const last = events[events.length - 1];
    assert.equal(last.type, 'complete', `expected a complete frame, got ${last.type}`);
    assert.deepEqual((last as { root: FileNode }).root, root);
  } finally {
    await close();
  }
});

/* ══════════════ heartbeats (plan U-2) ══════════════
 *
 * The page's watchdog asks the server something once the stream has said
 * nothing for 6 s. A scan whose count stands still — a second walk, a long
 * ingest, the first frame being built — used to send a comment every 10 s,
 * which EventSource never delivers to the page, so the watchdog fired and,
 * before U-2, asked for the whole result every 3 s. The unchanged progress
 * frame is now repeated every HEARTBEAT_TICKS ticks instead: a message the
 * page can count, with the frame's shape unchanged (P8-1).
 */

test('progressTick: 13 unchanged ticks send nothing, the 14th a heartbeat, the 28th a second, a change resets', () => {
  const at = (scannedByTick: (i: number) => number, ticks: number): number[] => {
    let state: ProgressTickState = { lastScanned: scannedByTick(0), quietTicks: 0 };
    const sent: number[] = [];
    for (let i = 1; i <= ticks; i++) {
      const r = progressTick(state, { scanned: scannedByTick(i), currentPath: '/a', firstByteWritten: false });
      state = r.state;
      if (r.send) sent.push(i);
    }
    return sent;
  };
  assert.equal(HEARTBEAT_TICKS, 14);
  assert.deepEqual(at(() => 5, 30), [14, 28], 'every fourteenth unchanged tick, and none between');
  assert.deepEqual(at((i) => (i < 10 ? 5 : 6), 30), [10, 24], 'a change is sent at once and starts the count again');
  assert.deepEqual(at((i) => i, 5), [1, 2, 3, 4, 5], 'a count that moves is sent every tick, as before');
  const written = progressTick({ lastScanned: 5, quietTicks: 13 }, { scanned: 6, currentPath: '/a', firstByteWritten: true });
  assert.equal(written.send, false, 'nothing once the complete frame has begun — not a change, not a heartbeat');
});

test("HEARTBEAT_TICKS × the tick is below the page's 6000 ms quiet threshold", () => {
  const page = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const from = page.indexOf('function followScanProgress(');
  const quiet = /const QUIET_MS = (\d+);/.exec(page.slice(from, page.indexOf('async function startCloudScan(', from)));
  assert.ok(quiet, 'the page names its quiet threshold inside followScanProgress');
  assert.equal(PROGRESS_TICK_MS, 150);
  assert.ok(HEARTBEAT_TICKS * PROGRESS_TICK_MS < Number(quiet[1]),
    `a heartbeat every ${HEARTBEAT_TICKS * PROGRESS_TICK_MS} ms reaches the page before it calls the stream quiet (${quiet[1]} ms)`);
  // Two heartbeats fit inside the threshold, so one lost to scheduling still leaves the stream talking.
  assert.ok(2 * HEARTBEAT_TICKS * PROGRESS_TICK_MS < Number(quiet[1]));
});

/**
 * Open the progress stream and collect its raw frames — comments included —
 * until `stop(frames)` says enough, then drop the connection. `onFrame` runs
 * on each. The bound is a hang guard, not a measurement.
 */
function rawFrames(
  port: number,
  scanId: string,
  stop: (frames: string[]) => boolean,
  onFrame: (frame: string, frames: string[]) => void = () => {},
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const frames: string[] = [];
    let done = false;
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      req.destroy();
      if (err) reject(err);
      else resolve(frames);
    };
    // A whole-test bound, not the socket's idle timeout: a stream that keeps
    // sending something else (a comment every 10 s) never goes idle.
    const guard = setTimeout(() => finish(new Error(`the stream never gave the frames asked for: ${JSON.stringify(frames)}`)), 60_000);
    const req = http.get({ host: '127.0.0.1', port, path: `/api/scan/${scanId}/progress` }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let split: number;
        while (!done && (split = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, split);
          buf = buf.slice(split + 2);
          frames.push(frame);
          onFrame(frame, frames);
          if (stop(frames)) finish();
        }
      });
      res.on('end', () => finish());
      res.on('error', () => finish());
    });
    req.on('error', (e) => finish(done ? undefined : e));
  });
}

const isProgress = (f: string): boolean => f.startsWith('data: {"type":"progress"');

test('a record held running streams at least 3 identical progress frames and no comment frame', async () => {
  const scan = createScanRecord('/held');
  scan.scanned = 42;
  scan.currentPath = '/held/a';
  const { port, close } = await listen();
  try {
    const frames = await rawFrames(port, scan.scanId, (fs) => fs.filter(isProgress).length >= 3);
    const progress = frames.filter(isProgress);
    assert.equal(progress.length, 3);
    assert.deepEqual(progress, Array(3).fill('data: {"type":"progress","scanned":42,"currentPath":"/held/a"}'),
      'the same frame, the first at once and then as heartbeats');
    assert.equal(frames.filter((f) => f.startsWith(':')).length, 0, 'no comment frame: EventSource never hands one to the page');
    assert.equal(frames.length, 3, 'and nothing else');
  } finally {
    scan.status = 'error';
    await close();
  }
});

test("heartbeats continue while the complete frame's build is held (seam) and stop at its first byte", async (t) => {
  let release!: () => void;
  holdFinalFrameForTests(new Promise<void>((resolve) => { release = resolve; }));
  t.after(() => holdFinalFrameForTests(null));
  const scan = createScanRecord('/held-final');
  scan.scanned = 7;
  scan.currentPath = '/held-final/a';
  const root: FileNode = { name: 'held-final', path: '/held-final', size: 1, type: 'dir', modifiedAt: 0, isHidden: false, children: [] };
  const { port, close } = await listen();
  try {
    let flippedAt = -1;
    // Read to the end of the stream: the server closes it after the complete frame.
    const frames = await rawFrames(port, scan.scanId, () => false, (frame, fs) => {
      if (flippedAt === -1 && isProgress(frame)) {
        // The scan finishes: from here the frame is being "built" until the seam lets it go.
        scan.status = 'complete';
        scan.root = root;
        flippedAt = fs.length;
      } else if (flippedAt !== -1 && fs.slice(flippedAt).filter(isProgress).length === 2) {
        release();
      }
    });
    const after = frames.slice(flippedAt);
    const completeAt = after.findIndex((f) => f.startsWith('data: {"type":"complete"'));
    assert.ok(completeAt >= 2, `two heartbeats were sent while the frame was held (frames after the flip: ${after.length})`);
    assert.ok(after.slice(0, completeAt).every(isProgress), 'each of them an unchanged progress frame');
    assert.equal(completeAt, after.length - 1, 'and nothing follows the complete frame');
    assert.deepEqual((JSON.parse(after[completeAt].slice(6)) as { root: FileNode }).root, root, 'which is whole');
  } finally {
    await close();
  }
});
