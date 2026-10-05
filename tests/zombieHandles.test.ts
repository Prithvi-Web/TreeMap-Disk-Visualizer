import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { isolatedDataDir } from './fixtures/dataDir';
import { withinHangGuard } from './fixtures/waitFor';
isolatedDataDir('tm-b5-data-');
process.env.TREEMAP_NO_GDU = '1';

import { groupZombies, appBundleOf, zombieReport, restartProcess, executablePathsOf, PS_PIDS_PER_CALL } from '../src/services/zombieHandles';
import { AppError } from '../src/middleware/errorHandler';
import { runText, CommandFailedError } from '../src/platform/exec';
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

test('one deleted file held by several programs is counted once, and says how many hold it (QA D17)', () => {
  // QA's Mac: one logd cache file held by hundreds of programs was counted once per
  // holder, so 687 MB of unique held files read as 2.37 GB.
  const shared = { path: '/private/var/db/cache.plist-cache', ino: 77, bytes: 100 };
  const grouped = groupZombies([
    { pid: 10, processName: 'logd', ...shared },
    { pid: 11, processName: 'Finder', ...shared },
    { pid: 12, processName: 'Dock', ...shared },
    { pid: 12, processName: 'Dock', path: '/tmp/own.log', ino: 5, bytes: 40 },
  ]);
  assert.equal(grouped.totalBytes, 140, 'the shared file once plus the other one, not 100 per holder');
  assert.equal(grouped.processes.length, 3, 'every holder is still listed');
  assert.equal(grouped.processes.find((p) => p.pid === 12)?.bytes, 140, 'a holder still shows everything it holds');
  assert.equal(grouped.fileCount, 2, 'two deleted files are held');
  assert.equal(grouped.sharedFileCount, 1, 'one of them by more than one program');
  const holdersOf = (pid: number, p: string) =>
    grouped.processes.find((x) => x.pid === pid)?.handles.find((h) => h.path === p)?.holders;
  assert.equal(holdersOf(10, shared.path), 3, 'each handle says how many programs hold that file');
  assert.equal(holdersOf(12, '/tmp/own.log'), 1, 'and a file one program holds says one');
});

test('the same path on a different inode is a different file, as a log rotated twice is (QA D17)', () => {
  const grouped = groupZombies([
    { pid: 10, processName: 'a', path: '/var/log/app.log', ino: 1, bytes: 100 },
    { pid: 11, processName: 'b', path: '/var/log/app.log', ino: 2, bytes: 100 },
  ]);
  assert.equal(grouped.totalBytes, 200, 'two inodes are two files, each holding its own space');
  assert.equal(grouped.fileCount, 2, 'and two files are counted');
});

test('without an inode, holders of the same path and size count once, so the total stays a floor (QA D17)', () => {
  const grouped = groupZombies([
    { pid: 10, processName: 'a', path: '/x/f', ino: null, bytes: 100 },
    { pid: 11, processName: 'b', path: '/x/f', ino: null, bytes: 100 },
    { pid: 10, processName: 'a', path: '/x/u', bytes: null },
    { pid: 11, processName: 'b', path: '/x/u', bytes: null },
  ]);
  assert.equal(grouped.totalBytes, 100, 'never more than is provably held');
  assert.equal(grouped.unknownSizeCount, 1, 'one unsized file, however many programs hold it');
  assert.equal(grouped.fileCount, 2, 'two files in all');
  const resized = groupZombies([
    { pid: 10, processName: 'a', path: '/x/f', ino: null, bytes: 100 },
    { pid: 11, processName: 'b', path: '/x/f', ino: null, bytes: 300 },
  ]);
  assert.equal(resized.totalBytes, 400, 'a different size at the same path is a different file');
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

/* ══════════════════ Track U U-5 — one `ps` for every held-space process ══════════════════ */

type Call = { cmd: string; args: string[] };

/** The pids one recorded `ps` call asked about. */
const pidsAskedIn = (call: Call): number[] => call.args[call.args.indexOf('-p') + 1].split(',').map(Number);

/**
 * A stand-in for `ps -ww -o pid=,comm= -p <pids>`: answers the way macOS's
 * does (the pid right-aligned, one space, then the whole path), for the pids
 * it knows, and records every call.
 */
function fakePs(paths: ReadonlyMap<number, string>) {
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[]): Promise<string> => {
    const call = { cmd, args };
    calls.push(call);
    return pidsAskedIn(call).filter((pid) => paths.has(pid)).map((pid) => `${String(pid).padStart(5)} ${paths.get(pid)}\n`).join('');
  };
  return { run, calls };
}

/** One held handle for each pid: what the platform's lsof pass hands groupZombies. */
const heldBy = (pids: number[]) => async () => pids.map((pid) => ({ pid, processName: `proc${pid}`, path: `/tmp/held-${pid}`, bytes: 1000 }));
const range = (from: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + i);

test('fifty processes holding space cost exactly one ps, and each gets its own answer', async () => {
  const pids = range(1000, 50);
  const ps = fakePs(new Map([[1003, '/Applications/My App.app/Contents/MacOS/My App'], [1007, '/usr/local/bin/node']]));
  const report = await zombieReport({ handles: heldBy(pids), run: ps.run, os: 'darwin' });
  assert.equal(ps.calls.length, 1, 'one ps for the whole report, not one per process');
  assert.equal(ps.calls[0].cmd, 'ps');
  assert.deepEqual(ps.calls[0].args, ['-ww', '-o', 'pid=,comm=', '-p', pids.join(',')], 'every pid asked about in that one call, at full width');
  assert.equal(report.processes.length, 50, 'every holder is still listed');
  const bundle = (pid: number) => report.processes.find((p) => p.pid === pid)?.appBundle;
  assert.equal(bundle(1003), '/Applications/My App.app', 'a path with spaces is read whole, not cut at its first space');
  assert.equal(bundle(1007), null, 'a plain binary is not a bundle');
  assert.equal(bundle(1004), null, 'a pid ps did not answer for is null, never a neighbour\'s answer');
});

test('executablePathsOf: a pid missing from the output is null, and 1,200 pids are asked in three calls of at most 500', async () => {
  assert.equal(PS_PIDS_PER_CALL, 500);
  const ps = fakePs(new Map([[7, '/bin/zsh']]));
  const one = await executablePathsOf([7, 8], ps.run);
  assert.equal(one.get(7), '/bin/zsh');
  assert.equal(one.get(8), null, 'absent from the output: unknown, not an empty path');

  const many = range(10_000, 1200);
  const big = fakePs(new Map(many.map((pid) => [pid, `/opt/p${pid}/bin/p${pid}`])));
  const paths = await executablePathsOf(many, big.run);
  assert.equal(big.calls.length, 3, '1,200 pids: three calls');
  assert.deepEqual(big.calls.map((c) => pidsAskedIn(c).length), [500, 500, 200], 'never more than 500 pids in one call');
  assert.deepEqual(big.calls.flatMap(pidsAskedIn), many, 'each pid asked about once, in order');
  assert.equal(paths.size, 1200, 'one entry per pid asked');
  // The map is seeded with null for every pid, so its size proves nothing about
  // the answers: every pid of every chunk must carry the path ps printed for it.
  const unread = many.filter((pid) => paths.get(pid) !== `/opt/p${pid}/bin/p${pid}`);
  assert.deepEqual(unread, [], 'every chunk\'s answers are read, not only the last one\'s');
});

test('executablePathsOf: a ps call that fails leaves only its own 500 pids unknown, and the chunk after it is still asked', async () => {
  const many = range(20_000, 1200);
  const ps = fakePs(new Map(many.map((pid) => [pid, `/opt/p${pid}/bin/p${pid}`])));
  let calls = 0;
  const run = async (cmd: string, args: string[]): Promise<string> => {
    calls++;
    if (calls === 2) throw new CommandFailedError('ps', 'ps exited with code 1', '', '', 1);
    return ps.run(cmd, args);
  };
  const paths = await executablePathsOf(many, run);
  assert.equal(calls, 3, 'the third chunk is asked after the second one\'s ps failed');
  const answered = (pids: number[]): number => pids.filter((pid) => paths.get(pid) === `/opt/p${pid}/bin/p${pid}`).length;
  const unknown = (pids: number[]): number => pids.filter((pid) => paths.get(pid) === null).length;
  assert.deepEqual(
    [answered(many.slice(0, 500)), unknown(many.slice(500, 1000)), answered(many.slice(1000))],
    [500, 500, 200],
    'the first chunk answered, the failed chunk unknown (nothing guessed), the last chunk answered',
  );
});

test('a ps that fails leaves every bundle unknown and the report still answers', async () => {
  const pids = range(2000, 5);
  const failures: Array<[string, () => Promise<string>]> = [
    ['ps exits 1 when no pid matches (macOS)', async () => { throw new CommandFailedError('ps', 'ps exited with code 1', '', '', 1); }],
    ['ps cannot be started at all', async () => { throw new Error('spawn ps ENOENT'); }],
  ];
  for (const [what, fail] of failures) {
    let calls = 0;
    const report = await zombieReport({ handles: heldBy(pids), run: async () => { calls++; return fail(); }, os: 'darwin' });
    assert.equal(calls, 1, `${what}: asked once`);
    assert.equal(report.processes.length, 5, `${what}: every holder is still reported`);
    assert.ok(report.processes.every((p) => p.appBundle === null), `${what}: no bundle is guessed`);
    assert.equal(report.totalBytes, 5000, `${what}: the held bytes are unaffected`);
  }
  // Only macOS has .app bundles: elsewhere nothing is asked at all.
  let asked = 0;
  await zombieReport({ handles: heldBy(pids), run: async () => { asked++; return ''; }, os: 'linux' });
  assert.equal(asked, 0, 'no ps where the answer cannot be yes');
});

test('the real ps answers the batched form: this process by its executable, an exited one as unknown', { skip: !IS_UNIX }, async () => {
  const gone = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await exited(gone);
  const calls: string[][] = [];
  const paths = await executablePathsOf([process.pid, gone.pid!], (cmd, args, opts) => { calls.push(args); return runText(cmd, args, opts); });
  assert.equal(calls.length, 1, 'both pids in one real ps');
  const mine = paths.get(process.pid);
  assert.ok(typeof mine === 'string' && mine.length > 0, `ps named this process (got ${String(mine)})`);
  assert.equal(path.basename(mine), NODE_NAME, 'by its executable');
  assert.equal(paths.get(gone.pid!), null, 'an exited process is unknown');
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
  await withinHangGuard(new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('error', (err) => reject(err));
    child.once('exit', () => reject(new Error('the holder process exited early')));
  }), 'the holder process signalling that it opened the file');
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

test('restart still asks ps about its one pid, right before it acts (U-5 batches only the report)', { skip: !IS_UNIX }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-b5-'));
  const target = path.join(dir, 'held.bin');
  await fsp.writeFile(target, 'x');
  const child = await holdOpenElsewhere(target);
  const calls: Call[] = [];
  const counted = (cmd: string, args: string[], opts?: Parameters<typeof runText>[2]) => { calls.push({ cmd, args }); return runText(cmd, args, opts); };
  try {
    assert.equal(await appErrorCode(() => restartProcess(child.pid!, 'DefinitelyNotThisProcess', undefined, counted)), 'PID_REUSED');
    assert.equal(calls.length, 1, 'one identity check');
    assert.equal(calls[0].cmd, 'ps');
    assert.deepEqual(pidsAskedIn(calls[0]), [child.pid], 'about that pid alone');
    assert.equal(child.exitCode, null, 'the mismatched process was left alone');
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

/* ══════════════════ The held-up space card (built page) ══════════════════ */

/**
 * Runs the built page's renderZombies with every global it touches stubbed, and
 * returns the HTML it paints. Sizes print as "<n> B" so the arithmetic is visible.
 */
function paintZombies(report: Record<string, unknown>): string {
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const start = index.indexOf('function renderZombies(');
  const end = index.indexOf('function wireZombieActions(', start);
  assert.ok(start > 0 && end > start, 'renderZombies is in the built page');
  let html = '';
  const body = { classList: { remove() {} }, innerHTML: '' };
  const stubs: Record<string, unknown> = {
    $: () => body,
    formatBytes: (n: number) => `${String(n)} B`,
    escapeHtml: (s: unknown) => String(s),
    baseName: (p: string) => p.split('/').pop(),
    fxBarStyle: () => '',
    fxBarsIn: () => undefined,
    wireZombieActions: () => undefined,
    icon: () => '',
    ZH_VISIBLE_ROWS: 1,
    FxNum: { rollHtml: (_el: unknown, h: string) => { html = h; } },
  };
  const keys = Object.keys(stubs);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const render = new Function(...keys, `let zombieProcs = []; ${index.slice(start, end)}; return renderZombies;`)(
    ...keys.map((k) => stubs[k]),
  ) as (r: unknown) => void;
  render(report);
  return html || body.innerHTML;
}

test('the held-up space card counts a shared file once and says so (QA D17)', () => {
  const shared = { path: '/var/db/cache', ino: 9, bytes: 600 };
  const report = groupZombies([
    { pid: 10, processName: 'logd', ...shared },
    { pid: 11, processName: 'Finder', ...shared },
    { pid: 12, processName: 'Dock', ...shared },
  ]);
  const html = paintZombies({ ...report, scannedAt: 0 });
  assert.match(html, /600 B held by 3 programs/, 'the headline is the file once, held by three programs');
  assert.match(html, /open in more than one program/, 'and the card says a shared file is counted once');
  assert.doesNotMatch(html, /1200 B|1800 B/, 'no figure on the card adds the shared file up per program');
});
