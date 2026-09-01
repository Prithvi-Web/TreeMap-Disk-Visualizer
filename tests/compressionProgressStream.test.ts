import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  MediaProbe, MediaTools, activeEncodeSseCount, cancelAllEncodeJobs, drainEncodeClients,
  resetEncodeJobs, setMediaTools, startEncodeJob,
} from '../src/services/compressionAdvisor';

/**
 * The compression progress route must put ITSELF in the shutdown registry.
 *
 * compressionAdvisor exports `registerEncodeClient` / `drainEncodeClients`, and
 * `shutdown()` calls the drain — but for one release nothing in src/ ever
 * called the register, so the registry was permanently empty and the drain
 * drained nothing. The only tests that saw a non-zero count were the ones that
 * registered a fake client themselves, which is a test asserting a fiction: it
 * pins the registry's own bookkeeping and says nothing about whether the route
 * that owns the leak is wired to it.
 *
 * So every assertion here drives the count through the REAL route over a REAL
 * socket, and this file never calls `registerEncodeClient`. What leaks when the
 * wiring is missing is precisely the pair the route holds: an open response and
 * a 500 ms `setInterval`, which keeps the event loop alive after
 * `server.close()` — the difference between a process that exits on SIGTERM and
 * one the user has to kill.
 */

const roots: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-encsse-'));
  roots.push(dir);
  return dir;
}
function fixture(dir: string, name: string, bytes = 1000): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}
afterEach(() => {
  cancelAllEncodeJobs();
  setMediaTools(null);
  resetEncodeJobs();
  drainEncodeClients(); // a leaked client's interval would hold this suite open
});
process.on('exit', () => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, cond: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function probe(over: Partial<MediaProbe> = {}): MediaProbe {
  return { durationSeconds: 60, videoCodec: 'h264', width: 1920, height: 1080, bitrateBps: 8e6, frameCount: 1440, ...over };
}

/**
 * A fake ffmpeg that HANGS, the way a real one does for the minutes an encode
 * takes. The job therefore stays `running`, which is the only state in which
 * the progress stream stays OPEN — a stream that completes on its first tick
 * would unregister itself before a test could look at it.
 */
function hangingTools(log: { spawned: number; killed: NodeJS.Signals[] }): MediaTools {
  return {
    async availability() {
      return { available: true, encoder: 'hevc_videotoolbox', hardwareCodecs: ['hevc'], mechanism: 'fake' };
    },
    async probe() {
      return probe();
    },
    encode(_input, _output, _encoder, _duration, _onProgress, onSpawn) {
      return new Promise<void>((_resolve, reject) => {
        log.spawned++;
        const child = {
          kill(signal: NodeJS.Signals) {
            log.killed.push(signal);
            reject(new Error('ffmpeg was killed'));
            return true;
          },
        };
        onSpawn?.(child as unknown as ChildProcess);
      });
    },
  };
}

interface OpenStream {
  /** Frames the server actually wrote, newest last. */
  frames: unknown[];
  /** Resolves when the server ends the response (drain, or job finished). */
  ended: Promise<void>;
  /** Hang up the way a browser tab closing does: kill the socket. */
  disconnect: () => void;
}

/** Open the progress stream over a real socket and parse its SSE frames. */
function openProgress(port: number, jobId: string): OpenStream {
  const frames: unknown[] = [];
  let resolveEnded = (): void => {};
  const ended = new Promise<void>((resolve) => { resolveEnded = resolve; });
  const req = http.get({ host: '127.0.0.1', port, path: `/api/compression/${jobId}/progress` }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buf += chunk;
      let split: number;
      while ((split = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, split);
        buf = buf.slice(split + 2);
        if (frame.startsWith('data: ')) frames.push(JSON.parse(frame.slice(6)));
      }
    });
    res.on('end', () => resolveEnded());
    res.on('close', () => resolveEnded());
    res.on('error', () => resolveEnded());
  });
  req.on('error', () => resolveEnded()); // a destroyed request is how we hang up
  return { frames, ended, disconnect: () => req.destroy() };
}

async function serve(): Promise<{ port: number; shutdown: () => void }> {
  const { startServer } = await import('../src/server');
  const running = await startServer({
    publicDir: path.join(__dirname, '..', 'public'),
    port: 0,
    host: '127.0.0.1',
  });
  return { port: running.port, shutdown: running.shutdown };
}

test('the progress route registers itself, and a client hanging up releases it', async () => {
  const dir = tmp();
  const file = fixture(dir, 'stream.mp4');
  const log = { spawned: 0, killed: [] as NodeJS.Signals[] };
  setMediaTools(hangingTools(log));

  const running = await serve();
  try {
    const job = startEncodeJob('job-sse-live', [file], 'hevc_videotoolbox');
    await waitFor('the encoder to start', () => log.spawned === 1);
    assert.equal(activeEncodeSseCount(), 0, 'nothing is registered before anyone connects');

    const stream = openProgress(running.port, 'job-sse-live');
    // THE assertion. Nothing in this file registered anything: if the count
    // moves, the route did it, which is the whole point.
    await waitFor('the route to register its own stream', () => activeEncodeSseCount() === 1);

    // A browser tab closing is a socket dying, not a graceful job end. The
    // route's own `close` handler has to release the pair, or every reload
    // leaves another interval ticking against a dead response forever.
    stream.disconnect();
    await waitFor('the client disconnect to release the stream', () => activeEncodeSseCount() === 0);
    await stream.ended;

    assert.equal(job.status, 'running', 'the encode outlives its watcher — only the stream ended');
  } finally {
    running.shutdown();
  }
});

test('shutdown drains a live progress stream that only the route registered', async () => {
  const dir = tmp();
  const file = fixture(dir, 'drained.mp4');
  const log = { spawned: 0, killed: [] as NodeJS.Signals[] };
  setMediaTools(hangingTools(log));

  const running = await serve();
  let stream: OpenStream | undefined;
  try {
    startEncodeJob('job-sse-drain', [file], 'hevc_videotoolbox');
    await waitFor('the encoder to start', () => log.spawned === 1);

    stream = openProgress(running.port, 'job-sse-drain');
    await waitFor('the route to register its own stream', () => activeEncodeSseCount() === 1);

    running.shutdown();

    // drainEncodeClients() is synchronous: by the time shutdown() returns, the
    // registry the route filled must be empty and its interval cleared.
    assert.equal(activeEncodeSseCount(), 0, 'shutdown drained the stream the ROUTE registered');
    await stream.ended;
    assert.ok(
      stream.frames.some((f) => (f as { type?: string }).type === 'shutdown'),
      'the watching browser is told WHY the stream ended, not just cut off',
    );
  } finally {
    stream?.disconnect();
    running.shutdown(); // idempotent; safe if the assertions above threw first
  }
});
