import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-b5-data-'));
process.env.TREEMAP_NO_GDU = '1';

import { groupZombies, appBundleOf, zombieReport, restartProcess } from '../src/services/zombieHandles';
import { AppError } from '../src/middleware/errorHandler';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';

/**
 * B5 — the zombie-handle reclaim detector.
 *
 * The integration tests leak *real* descriptors from *real* separate
 * processes, per §9: the whole feature exists because an unlinked file's
 * blocks stay allocated while a descriptor lives, and only a live descriptor
 * from another process proves detection works. The pure tests cover the
 * arithmetic a wrong "X GB held" figure would come from.
 *
 * Nothing here touches the Trash, and the only process ever terminated is a
 * child this file spawned for the purpose.
 */

const IS_UNIX = process.platform !== 'win32';
const NODE_NAME = path.basename(process.execPath);

/* ══════════════════ Grouping arithmetic (pure, every OS) ══════════════════ */

test('handles group by process, biggest holder first, unknowns counted not guessed', () => {
  const grouped = groupZombies([
    { pid: 20, processName: 'small', path: '/x/a', bytes: 100 },
    { pid: 10, processName: 'big', path: '/x/b', bytes: 4000 },
    { pid: 10, processName: 'big', path: '/x/c', bytes: 1000 },
    { pid: 10, processName: 'big', path: '/x/d', bytes: null },
  ]);

  assert.deepEqual(grouped.processes.map((p) => p.pid), [10, 20], 'sorted by held bytes, descending');
  assert.equal(grouped.processes[0].bytes, 5000, 'a process sums its own handles');
  assert.equal(grouped.processes[0].unknownSizeCount, 1, 'an unknowable size is counted, never folded into the sum as zero');
  assert.equal(grouped.totalBytes, 5100, 'the headline total is the sum of known bytes only — a floor, not an estimate');
  assert.equal(grouped.unknownSizeCount, 1);
  assert.deepEqual(
    grouped.processes[0].handles.map((h) => h.bytes),
    [4000, 1000, null],
    'within a process, biggest handle first and unknowns last',
  );
});

test('an empty handle list groups to an empty report, not an error', () => {
  const grouped = groupZombies([]);
  assert.deepEqual(grouped.processes, []);
  assert.equal(grouped.totalBytes, 0);
});

test('the .app bundle test matches path segments, not substrings', () => {
  assert.equal(
    appBundleOf('/Applications/Safari.app/Contents/MacOS/Safari'),
    '/Applications/Safari.app',
    'a real bundle resolves to the bundle root',
  );
  assert.equal(
    appBundleOf('/Applications/Google Chrome.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper'),
    '/Applications/Google Chrome.app',
    'the outermost bundle wins — `open` on an inner helper bundle would not reopen the app',
  );
  assert.equal(appBundleOf('/usr/local/bin/node'), null, 'a plain binary is not a bundle');
  assert.equal(appBundleOf(null), null);
  assert.equal(appBundleOf('.app/x'), null, 'a path that starts at the marker has no bundle name');
});

/* ══════════════════ The acceptance criterion (unix) ══════════════════ */

/**
 * Hold `target` open from a separate process, resolving once the descriptor
 * is really open — the same no-sleep handshake the B2 suite uses. Returns the
 * child so tests can terminate it and observe the space actually free.
 */
async function holdOpenElsewhere(target: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['-e', 'const fs=require("fs");fs.openSync(process.argv[1],"r");console.log("open");setInterval(()=>{},1000);', target],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('the holder process never signalled that it opened the file')); }, 10_000);
    child.stdout!.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('the holder process exited early')); });
  });
  return child;
}

/** Wait for a spawned child to fully exit. */
function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

test('a file deleted while held open is detected with its real size, and clears when the holder exits', { skip: !IS_UNIX }, async () => {
  // §B5 acceptance: "A file deleted while held open by a controlled test
  // process is detected, and the reclaimable byte count matches reality after
  // that process exits."
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-b5-'));
  const target = path.join(dir, 'doomed.bin');
  const SIZE = 1_048_576;
  await fsp.writeFile(target, Buffer.alloc(SIZE));

  const holder = await holdOpenElsewhere(target);
  try {
    await fsp.unlink(target);

    const report = await zombieReport();
    const mine = report.processes.find((p) => p.pid === holder.pid);
    assert.ok(mine, 'the holder process is listed among the zombie holders');
    assert.equal(mine!.bytes, SIZE, 'the held bytes are the file’s real size — not a guess, not zero');
    assert.ok(report.totalBytes >= SIZE, 'the headline total includes it');

    // The reclaim itself: once the holder exits, the space is genuinely free
    // and the report must stop claiming it.
    holder.kill('SIGKILL');
    await exited(holder);
    const after = await zombieReport();
    assert.equal(
      after.processes.find((p) => p.pid === holder.pid),
      undefined,
      'an exited holder no longer appears — the bytes it held are reclaimed',
    );
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ restartProcess safety rails (unix) ══════════════════ */

const appErrorCode = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return 'no-error';
  } catch (err) {
    return err instanceof AppError ? err.code : `unexpected: ${String(err)}`;
  }
};

test('restart refuses system pids, TreeMap itself, and its parent', async () => {
  assert.equal(await appErrorCode(() => restartProcess(0, 'x')), 'PID_INVALID');
  assert.equal(await appErrorCode(() => restartProcess(1, 'launchd')), 'PID_INVALID');
  assert.equal(await appErrorCode(() => restartProcess(-5, 'x')), 'PID_INVALID');
  assert.equal(await appErrorCode(() => restartProcess(2.5, 'x')), 'PID_INVALID');
  assert.equal(await appErrorCode(() => restartProcess(process.pid, 'anything')), 'PID_IS_TREEMAP');
  if (process.ppid > 1) {
    assert.equal(await appErrorCode(() => restartProcess(process.ppid, 'anything')), 'PID_IS_TREEMAP');
  }
});

test('restart refuses a pid whose process is not what the caller named', { skip: !IS_UNIX }, async () => {
  // Pids are recycled; acting on a stale panel must never quit whatever
  // program inherited the number.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-b5-'));
  const target = path.join(dir, 'held.bin');
  await fsp.writeFile(target, 'x');
  const child = await holdOpenElsewhere(target);
  try {
    assert.equal(await appErrorCode(() => restartProcess(child.pid!, 'DefinitelyNotThisProcess')), 'PID_REUSED');
    assert.equal(child.exitCode, null, 'the mismatched process was left completely alone');
  } finally {
    child.kill('SIGKILL');
    await exited(child);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('restart terminates a willing process gracefully and reports it plainly', { skip: !IS_UNIX }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-b5-'));
  const target = path.join(dir, 'held.bin');
  await fsp.writeFile(target, 'x');
  const child = await holdOpenElsewhere(target);
  try {
    const result = await restartProcess(child.pid!, NODE_NAME);
    await exited(child);
    assert.equal(result.terminated, true, 'a default SIGTERM handler exits, and that is reported');
    assert.equal(result.relaunched, false, 'a bare binary is never "reopened" — there is nothing supportable to reopen');
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'the child really is gone');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a process that declines to quit is reported still running — never force-killed', { skip: !IS_UNIX }, async () => {
  const child = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM",()=>{});console.log("up");setInterval(()=>{},1000);'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
  try {
    const result = await restartProcess(child.pid!, NODE_NAME, 800);
    assert.equal(result.terminated, false, 'the refusal is reported, not escalated');
    assert.equal(child.exitCode, null, 'the process was asked, not forced — it is still alive');
    assert.match(result.message, /still running/, 'and the message says exactly that');
  } finally {
    child.kill('SIGKILL');
    await exited(child);
  }
});

test('restarting a process that already quit reports the space as already free', { skip: !IS_UNIX }, async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await exited(child);
  const result = await restartProcess(child.pid!, NODE_NAME);
  assert.equal(result.terminated, true);
  assert.match(result.message, /already quit/);
});

/* ══════════════════ The endpoints ══════════════════ */

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

test('GET /api/zombie-handles answers the report, or the honest capability reason', async () => {
  const { port, close } = await listen();
  try {
    const r = await req(port, 'GET', '/api/zombie-handles');
    if (r.status === 200) {
      assert.ok(Array.isArray(r.body.processes), 'processes is a list');
      assert.equal(typeof r.body.totalBytes, 'number');
      assert.equal(typeof r.body.unknownSizeCount, 'number');
      assert.equal(r.body.capability.available, true);
    } else {
      // Windows, or a unix box with lsof genuinely missing: the flat error
      // envelope with the probe's human-readable reason (§2.2), never a blank.
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'CAPABILITY_UNAVAILABLE');
      assert.ok(String(r.body.error).length > 10, 'the reason is a sentence a person can act on');
    }
  } finally {
    await close();
  }
});

test('POST /api/zombie-handles/restart validates before it acts', async () => {
  const { port, close } = await listen();
  try {
    const probe = await req(port, 'GET', '/api/zombie-handles');
    if (probe.status !== 200) {
      // Capability-gated out: the restart gate must answer identically.
      const r = await req(port, 'POST', '/api/zombie-handles/restart', { pid: 12345, processName: 'x' });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'CAPABILITY_UNAVAILABLE');
      return;
    }

    const missing = await req(port, 'POST', '/api/zombie-handles/restart', {});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'PID_INVALID');

    const noName = await req(port, 'POST', '/api/zombie-handles/restart', { pid: 12345 });
    assert.equal(noName.status, 400);
    assert.equal(noName.body.code, 'PROCESS_NAME_REQUIRED');

    const self = await req(port, 'POST', '/api/zombie-handles/restart', { pid: process.pid, processName: 'TreeMap' });
    assert.equal(self.status, 400);
    assert.equal(self.body.code, 'PID_IS_TREEMAP');

    const system = await req(port, 'POST', '/api/zombie-handles/restart', { pid: 1, processName: 'launchd' });
    assert.equal(system.status, 400);
    assert.equal(system.body.code, 'PID_INVALID');
  } finally {
    await close();
  }
});
