import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-benchMemoryPath-data-');

import { skipOrFailOnCi } from './fixtures/ciSkip';
import { Worker } from 'node:worker_threads';
import { HANG_GUARD_MS } from './fixtures/waitFor';
import { ELECTRON_BINARY, MEMORY_PATH_STAGES, busyWhile, firstAnswer, memoryPathBaselinePath, memoryPathExecutable, noResultReason, parseSizes, runMeasuringProcess, runMemoryPathWorker, workerTsconfig, type MemoryPathRecord } from '../bench/lib/memoryPath';

/**
 * Phase 4 T9's harness (no product code): each measurement runs in a fresh
 * process — plain Node, or the installed app's own binary run as Node — on
 * JavaScript compiled as the app's build compiles it, with the app's server
 * modules loaded, and drives the native memory path stage by stage (walk and
 * seal, hand-over, adoption with Node's passes, the first tree sent as the
 * app sends it), reporting the process's peak resident memory after each; a
 * store where every file is a candidate measures Node's passes alone; a probe
 * loads the addon in a worker thread. These tests hold the harness to its
 * contract on small trees; the measurements themselves are T9's record, not a
 * test.
 */

const REPO = path.join(__dirname, '..');
const MODULE = process.env.TREEMAP_NATIVE_MODULE ?? path.join(REPO, 'native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node');

function moduleOrSkip(t: TestContext): string | null {
  if (fs.existsSync(MODULE)) return MODULE;
  skipOrFailOnCi(t, `no native module at ${MODULE}; build it with npm run build:native`);
  return null;
}

test('a synthetic walk is measured stage by stage in a process of its own, the peak never falling', async (t) => {
  const module = moduleOrSkip(t);
  if (!module) return;
  const entries = 20_000;
  const result = await runMemoryPathWorker({ kind: 'synthetic', entries, seed: 3, module, runtime: 'node' });
  assert.ok(result.ok, result.ok ? '' : result.error);
  assert.deepEqual(result.stages.map((s) => s.stage), [...MEMORY_PATH_STAGES]);
  for (let i = 1; i < result.stages.length; i++) {
    assert.ok(result.stages[i].peakRssBytes >= result.stages[i - 1].peakRssBytes, `${result.stages[i].stage}: a peak is a high-water mark`);
  }
  assert.equal(result.counts?.scanned, entries + 1, 'every entry and the root');
  assert.equal((result.counts?.dirs ?? 0) + (result.counts?.files ?? 0), entries + 1, 'every row a folder or a file');
  assert.ok((result.frameBytes ?? 0) > 0, 'the first tree was sent');
  assert.match(result.frameHead ?? '', /^data: \{"type":"complete","root":\{/, 'as the SSE complete frame the app writes');
  const walked = result.stages.find((s) => s.stage === 'walked');
  const handedOver = result.stages.find((s) => s.stage === 'handed-over');
  assert.ok(walked && handedOver);
  const busy = result.handOverBusyMs;
  assert.ok(typeof busy === 'number' && Number.isFinite(busy) && busy >= 0, 'the JavaScript thread\'s busy time during the hand-over is measured');
  // Timed inside the hand-over, which lies between the two stages' readings: 1 ms for the clocks' rounding.
  assert.ok(busy <= handedOver.ms - walked.ms + 1, `${busy} ms busy inside a hand-over of ${handedOver.ms - walked.ms} ms`);
  assert.equal(result.typescriptLoader, false, 'the measuring process runs compiled JavaScript, as the packaged app does');
  assert.equal(result.serverLoaded, true, 'the app\'s server modules are in memory from the first stage on');
  assert.equal(result.runtime.electron, null, 'plain Node');
  assert.equal(result.runtime.node, process.versions.node);
});

test('Node\'s passes are measured alone on a store where every file is a text candidate and a cloud candidate', async (t) => {
  const module = moduleOrSkip(t);
  if (!module) return;
  const result = await runMemoryPathWorker({ kind: 'candidates', entries: 30_000, module, runtime: 'node' });
  assert.ok(result.ok, result.ok ? '' : result.error);
  assert.deepEqual(result.stages.map((s) => s.stage), ['loaded', 'built', 'adopted']);
  assert.equal(result.passes?.textCandidates, 30_000);
  assert.equal(result.passes?.cloudCandidates, 30_000);
  assert.ok((result.passes?.ms ?? -1) >= 0);
});

test('the worker-thread probe loads the addon inside a worker and reads its version', async (t) => {
  const module = moduleOrSkip(t);
  if (!module) return;
  const result = await runMemoryPathWorker({ kind: 'worker-probe', module, runtime: 'node' });
  assert.ok(result.ok, result.ok ? '' : result.error);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { nativeVersion: string };
  assert.equal(result.workerVersion, pkg.nativeVersion);
  assert.equal(result.mainHeldFirst, false, 'the worker is the addon\'s only holder, the case Windows unmaps when the worker ends (RISKS R96)');
});

test('the worker-thread probe, with the addon already held by the main thread as the app holds it, loads it in a worker and reads its version', async (t) => {
  // The full-pass runner's own case (§S.5.7): the app's main thread loads the
  // addon at startup, and a worker loads it after. Beside the test above it
  // tells two causes apart on Windows, where a worker's environment unmaps an
  // addon it was the last to hold: this one passes even without the pin.
  const module = moduleOrSkip(t);
  if (!module) return;
  const result = await runMemoryPathWorker({ kind: 'worker-probe', module, runtime: 'node', mainFirst: true });
  assert.ok(result.ok, result.ok ? '' : result.error);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { nativeVersion: string };
  assert.equal(result.workerVersion, pkg.nativeVersion);
  assert.equal(result.mainHeldFirst, true, 'the main thread held the addon before the worker loaded it');
});

test('inside Electron the node runtime is refused: this binary is the app, and a measurement runs without ELECTRON_RUN_AS_NODE, which would open it', async () => {
  // 27 Sep 2026: \`npm test\` run by the installed app's binary as Node reached
  // this harness, whose node runtime spawned that binary with ELECTRON_RUN_AS_NODE
  // removed: the app opened, twice, on the owner's own profile. The host here is
  // a stand-in path, so nothing could open even were the refusal gone.
  const insideElectron = { execPath: path.join(os.tmpdir(), 'treemap-no-such-electron-app'), electron: '31.7.7' };
  assert.throws(() => memoryPathExecutable('node', insideElectron), /Electron 31\.7\.7 .*would open the app/);
  await assert.rejects(runMemoryPathWorker({ kind: 'worker-probe', module: MODULE, runtime: 'node' }, insideElectron), /would open the app/);
  assert.equal(memoryPathExecutable('node', { execPath: '/opt/node/bin/node', electron: undefined }), '/opt/node/bin/node', 'plain Node runs itself');
});

test('a measuring process that leaves no result says how it ended: its exit code, and what it wrote to stderr', async () => {
  // Windows CI, run 36282411813: the worker-thread probe's process wrote no
  // result and nothing to stderr, and the harness said only that — a crash
  // and a silent exit read alike. The environment keeps this process's, so
  // ELECTRON_RUN_AS_NODE rides along wherever it is set.
  const ending = await runMeasuringProcess(process.execPath, ['-e', "process.stderr.write('the stand-in stopped here'); process.exit(7)"], { ...process.env });
  assert.deepEqual(ending, { code: 7, signal: null, stderr: 'the stand-in stopped here' });
  assert.equal(noResultReason(ending), 'the measuring process wrote no result: it exited with code 7; its stderr: the stand-in stopped here');
  assert.equal(noResultReason({ code: null, signal: 'SIGKILL', stderr: '' }), 'the measuring process wrote no result: it was ended by SIGKILL; its stderr was empty');
});

test('a worker thread that exits before it answers is reported with its exit code, not waited on forever', async () => {
  const guard = (answer: Promise<unknown>): Promise<unknown> => Promise.race([
    answer,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer and no exit within ${HANG_GUARD_MS} ms`)), HANG_GUARD_MS).unref()),
  ]);
  const answering = new Worker("require('node:worker_threads').parentPort.postMessage(42)", { eval: true });
  assert.equal(await guard(firstAnswer(answering)), 42);
  await answering.terminate();
  const leaving = new Worker('process.exit(7)', { eval: true });
  await assert.rejects(guard(firstAnswer(leaving)), /the worker thread exited with code 7 before it answered/);
});

test('the Electron runtime is the installed app\'s binary run as Node, or refused with where it looked', async (t) => {
  const module = moduleOrSkip(t);
  if (!module) return;
  if (!fs.existsSync(ELECTRON_BINARY)) {
    await assert.rejects(runMemoryPathWorker({ kind: 'worker-probe', module, runtime: 'electron' }), new RegExp(ELECTRON_BINARY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return;
  }
  const result = await runMemoryPathWorker({ kind: 'worker-probe', module, runtime: 'electron' });
  assert.ok(result.ok, result.ok ? '' : result.error);
  assert.match(result.runtime.electron ?? '', /^\d+\.\d+\.\d+/, 'the app\'s Electron answered');
});

/* ------------------------------ the command ------------------------------ */

const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');

function bench(env: NodeJS.ProcessEnv, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [tsxCli, path.join(REPO, 'bench', 'run.ts'), ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 600_000, env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('the hand-over\'s busy time counts, whole, a block inside the callback that settles it', async () => {
  const BLOCK_MS = 30;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const { value, busyMs } = await busyWhile(() => new Promise<string>((resolve) => {
    setTimeout(() => {
      // Holds this thread as napi-rs's copy inside `resolve` holds it: a wait, not a spin.
      Atomics.wait(cell, 0, 0, BLOCK_MS);
      resolve('settled');
    }, 1);
  }));
  assert.equal(value, 'settled');
  // 1 ms for the two monotonic clocks' rounding; a slower or busier machine only adds.
  assert.ok(busyMs >= BLOCK_MS - 1, `${busyMs} ms busy across a ${BLOCK_MS} ms block`);
});

test('the measuring worker\'s tsconfig writes every path with forward slashes, which TypeScript\'s include patterns need on Windows', () => {
  // TypeScript splits an `include` pattern on `/` alone: with Windows' separators the
  // pattern matched nothing there, and the compile lost src/types' declarations.
  const repo = 'D:\\a\\TreeMap\\TreeMap';
  const config = workerTsconfig(repo, path.win32.join(repo, 'bench', 'results', '.memory-path-js-x'), path.win32);
  assert.deepEqual(config.include, ['D:/a/TreeMap/TreeMap/src/**/*.ts']);
  assert.deepEqual(config.files, ['D:/a/TreeMap/TreeMap/bench/lib/memoryPathWorker.ts']);
  for (const value of [config.extends, config.compilerOptions.rootDir, config.compilerOptions.outDir, ...config.files, ...config.include]) {
    assert.ok(!value.includes('\\'), `${value} keeps a backslash`);
  }
});

test('a memory-path record is kept in a folder of its own, away from the comparable baselines every reader of the top folder expects', () => {
  const top = path.join('/repo', 'bench', 'baselines');
  const file = memoryPathBaselinePath(top, 'darwin', 'arm64');
  assert.equal(file, path.join(top, 'memory-path', 'darwin-arm64.json'));
  assert.notEqual(path.dirname(file), top, 'the top folder holds only comparable results (tests/benchReport.test.ts reads every file there)');
  const committed = path.join(REPO, 'bench', 'baselines');
  for (const name of fs.readdirSync(committed).filter((f) => f.endsWith('.json'))) {
    const record = JSON.parse(fs.readFileSync(path.join(committed, name), 'utf8')) as { kind?: unknown };
    assert.notEqual(record.kind, 'memory-path', `${name} is a memory-path record in the top folder`);
  }
});

test('sizes are whole counts with an optional k or m, and anything else is refused by name', () => {
  assert.deepEqual(parseSizes('1m,2m,500k,5000', 'sizes'), [1_000_000, 2_000_000, 500_000, 5_000]);
  for (const bad of ['1q', '', '1.5m', '-2k', 'm']) {
    assert.throws(() => parseSizes(bad, 'sizes'), /--sizes must be a list like 1m,2m,500k/, bad);
  }
});

test('bench memory-path is on the help, and refuses an unknown runtime and a malformed size', () => {
  const help = bench({}, '--help');
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes('npm run bench -- memory-path'));
  const runtime = bench({}, 'memory-path', '--runtime=deno');
  assert.equal(runtime.status, 1);
  assert.match(runtime.stderr, /--runtime must be one of node, electron, both/);
  const sizes = bench({}, 'memory-path', '--sizes=1q');
  assert.equal(sizes.status, 1);
  assert.match(sizes.stderr, /--sizes must be a list like 1m,2m,500k/);
});

test('bench memory-path measures its matrix and writes one result naming every measurement', async (t) => {
  const module = moduleOrSkip(t);
  if (!module) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-memory-path-cli-'));
  try {
    const r = bench({ TREEMAP_BENCH_OUT: out, TREEMAP_NATIVE_MODULE: module }, 'memory-path', '--runtime=node', '--sizes=20k', '--candidates=10k');
    assert.equal(r.status, 0, r.stderr);
    const files = fs.readdirSync(out).filter((name) => /^memory-path-.*\.json$/.test(name));
    assert.equal(files.length, 1, files.join(', '));
    const record = JSON.parse(fs.readFileSync(path.join(out, files[0]), 'utf8')) as MemoryPathRecord;
    assert.deepEqual(record.measurements.map((m) => [m.runtime, m.job.kind]), [['node', 'synthetic'], ['node', 'candidates'], ['node', 'worker-probe']]);
    for (const m of record.measurements) assert.ok(m.result.ok, m.result.ok ? '' : m.result.error);
    assert.match(r.stdout, /node\s+synthetic 20,000 .* · hand-over busy \d+\.\d ms · frame \d+\.\d MB/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
