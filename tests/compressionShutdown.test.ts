import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Response } from 'express';
import {
  MediaProbe, MediaTools, activeEncodeSseCount, cancelAllEncodeJobs, drainEncodeClients,
  getEncodeJob, registerEncodeClient, resetEncodeJobs, setMediaTools, startEncodeJob,
} from '../src/services/compressionAdvisor';

/**
 * Graceful shutdown, for the ONE feature that was in neither shutdown list.
 *
 * SIGTERM cancels scans, dup hashing, watchers, offloads, index builds and
 * capsule restores, and drains five SSE registries. Compression was in none of
 * them, which is worse here than anywhere else in the app: an encode owns a
 * spawned ffmpeg that keeps reading and writing the user's disk after TreeMap
 * is "gone", and its progress stream is a `setInterval` holding the event loop
 * open, so the process does not exit either.
 *
 * These tests pin the two exports shutdown needs, in isolation from the server:
 *
 *   1. `cancelAllEncodeJobs()` — every running job marked cancelled AND its
 *      encoder killed, with nothing after the current file started.
 *   2. `drainEncodeClients()` — every registered progress stream told why it
 *      ended, its timer cleared, and the registry emptied.
 */

const roots: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-encshut-'));
  roots.push(dir);
  return dir;
}
function fixture(dir: string, name: string, bytes = 1000): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}
afterEach(() => {
  setMediaTools(null);
  resetEncodeJobs();
  drainEncodeClients(); // a leaked client's interval would hold this suite open
});
process.on('exit', () => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, cond: () => boolean, ms = 2000): Promise<void> {
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
 * takes — the only state in which shutdown is interesting. It hands its caller
 * a fake child, and only settles when that child is killed, exactly as a real
 * spawn's `close` handler rejects after a SIGKILL.
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

/* ─────────────── 1. the job and its subprocess ─────────────── */

test('shutdown cancels every running encode and kills the ffmpeg it owns', async () => {
  const dir = tmp();
  const first = fixture(dir, 'first.mp4');
  const second = fixture(dir, 'second.mp4');
  const log = { spawned: 0, killed: [] as NodeJS.Signals[] };
  setMediaTools(hangingTools(log));

  const job = startEncodeJob('job-shutdown', [first, second], 'hevc_videotoolbox');
  await waitFor('the encoder to start on the first file', () => log.spawned === 1);

  assert.equal(cancelAllEncodeJobs(), 1, 'one running job was cancelled');
  assert.equal(job.cancelled, true, 'the flag every later file checks');
  assert.deepEqual(log.killed, ['SIGKILL'], 'raising the flag alone leaves ffmpeg reading the disk');

  await waitFor('the job to settle', () => job.status !== 'running');
  assert.equal(log.spawned, 1, 'nothing after the killed file is started');
  assert.equal(getEncodeJob('job-shutdown')!.status, 'complete');
  assert.equal(job.results.length, 1);
  assert.equal(job.results[0].ok, false, 'a killed encode is not a success');

  // The point of killing rather than promoting: neither original is touched,
  // and the half-written encode is gone.
  assert.deepEqual(fs.readdirSync(dir).sort(), ['first.mp4', 'second.mp4']);
  assert.equal(fs.statSync(first).size, 1000, 'the original the encoder was chewing on is intact');
});

test('cancelAllEncodeJobs is a no-op with nothing running, and never kills twice', async () => {
  // Shutdown calls it unconditionally, and Electron quit can call shutdown
  // after the CLI already did.
  assert.equal(cancelAllEncodeJobs(), 0, 'no jobs at all');

  const dir = tmp();
  const file = fixture(dir, 'only.mp4');
  const log = { spawned: 0, killed: [] as NodeJS.Signals[] };
  setMediaTools(hangingTools(log));
  const job = startEncodeJob('job-twice', [file], 'hevc_videotoolbox');
  await waitFor('the encoder to start', () => log.spawned === 1);

  assert.equal(cancelAllEncodeJobs(), 1);
  await waitFor('the job to settle', () => job.status !== 'running');
  assert.equal(cancelAllEncodeJobs(), 0, 'a finished job is not cancelled again');
  assert.deepEqual(log.killed, ['SIGKILL'], 'and its child is not signalled twice');
});

/* ─────────────── 2. the progress SSE registry ─────────────── */

function fakeClient(opts: { writeThrows?: boolean } = {}): {
  res: Response; frames: string[]; ends: number; ticks: () => number; timer: NodeJS.Timeout;
} {
  const frames: string[] = [];
  const state = { ends: 0, ticks: 0 };
  const timer = setInterval(() => { state.ticks++; }, 1);
  const res = {
    write(frame: string): boolean {
      if (opts.writeThrows) throw new Error('ERR_STREAM_WRITE_AFTER_END');
      frames.push(frame);
      return true;
    },
    end(): void { state.ends++; },
  };
  return {
    res: res as unknown as Response,
    frames,
    get ends() { return state.ends; },
    ticks: () => state.ticks,
    timer,
  };
}

test('draining the progress streams tells each one why, ends it, and clears its timer', async () => {
  const client = fakeClient();
  const release = registerEncodeClient(client.res, client.timer);
  assert.equal(activeEncodeSseCount(), 1, 'a live stream is visible to shutdown');

  drainEncodeClients();

  assert.equal(activeEncodeSseCount(), 0, 'the registry is empty afterwards');
  assert.match(client.frames.join(''), /"type":"shutdown"/, 'the browser is told, not just cut off');
  assert.equal(client.ends, 1, 'the response is ended');

  // The invariant that decides whether the process can exit at all: a live
  // interval keeps the event loop open long after server.close().
  const ticked = client.ticks();
  await sleep(30);
  assert.equal(client.ticks(), ticked, 'the poll timer is cleared, so nothing holds the loop open');

  release(); // the route's own req 'close' fires right after the drain ended it
  assert.equal(client.ends, 1, 'releasing twice does not double-end the response');
  assert.equal(activeEncodeSseCount(), 0);
});

test('a socket that is already dead does not stop the drain reaching the others', () => {
  const dead = fakeClient({ writeThrows: true });
  const live = fakeClient();
  registerEncodeClient(dead.res, dead.timer);
  registerEncodeClient(live.res, live.timer);
  assert.equal(activeEncodeSseCount(), 2);

  drainEncodeClients();

  assert.equal(activeEncodeSseCount(), 0, 'both are released');
  assert.equal(dead.ends, 1, 'the dead one is still ended and its timer cleared');
  assert.match(live.frames.join(''), /"type":"shutdown"/, 'the live one still got its frame');
});

test('a released client is gone before shutdown ever runs', () => {
  // The ordinary path: the user closes the tab, or the job finishes and the
  // route ends its own stream. Shutdown must not find a stale entry.
  const client = fakeClient();
  const release = registerEncodeClient(client.res, client.timer);
  release();
  assert.equal(activeEncodeSseCount(), 0);
  assert.equal(client.ends, 1);
  drainEncodeClients();
  assert.equal(client.ends, 1, 'and it is not ended a second time by the drain');
});

/* ─────────────── 3. the wiring itself ─────────────── */

/**
 * The two exports above are only worth having if `shutdown()` calls them.
 * Every other feature in this list was wired and compression was not, so the
 * gap this file exists to close is the CALL, not the capability — and a test
 * that exercises the exports alone would have stayed green through the entire
 * bug. This one drives the real server's own shutdown and asserts what a
 * SIGTERM leaves behind.
 */
test('the real server’s shutdown() kills the encoder and ends its progress stream', async () => {
  const { startServer } = await import('../src/server');
  const dir = tmp();
  const file = fixture(dir, 'wired.mp4');
  const log = { spawned: 0, killed: [] as NodeJS.Signals[] };
  setMediaTools(hangingTools(log));

  const running = await startServer({
    publicDir: path.join(__dirname, '..', 'public'),
    port: 0,
    host: '127.0.0.1',
  });
  try {
    const job = startEncodeJob('job-wired', [file], 'hevc_videotoolbox');
    await waitFor('the encoder to start', () => log.spawned === 1);

    let ended = false;
    const wrote: string[] = [];
    const fake = {
      writableEnded: false,
      write(chunk: string) { wrote.push(String(chunk)); return true; },
      end() { ended = true; },
      on() { return this; },
    } as unknown as Response;
    // The same pair the route registers: the response and the poll timer whose
    // survival is what keeps the process alive after server.close().
    const timer = setInterval(() => {}, 1000);
    registerEncodeClient(fake, timer);
    assert.equal(activeEncodeSseCount(), 1, 'the stream is registered before shutdown');

    running.shutdown();

    assert.equal(job.cancelled, true, 'shutdown() must reach cancelAllEncodeJobs()');
    assert.deepEqual(log.killed, ['SIGKILL'], 'and the ffmpeg it owns must not outlive the server');
    assert.equal(ended, true, 'shutdown() must reach drainEncodeClients()');
    assert.ok(
      wrote.some((c) => c.includes('shutdown')),
      'the stream is told WHY it ended, not just cut off',
    );
    assert.equal(activeEncodeSseCount(), 0, 'the registry is empty afterwards');
    clearInterval(timer); // the drain clears it too; belt and braces if it did not
    await waitFor('the job to settle', () => job.status !== 'running');
  } finally {
    running.shutdown(); // idempotent; safe if the assertions above threw first
  }
});
