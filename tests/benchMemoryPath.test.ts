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
import { ELECTRON_BINARY, MEMORY_PATH_STAGES, longestDelayMs, parseSizes, runMemoryPathWorker, type MemoryPathRecord } from '../bench/lib/memoryPath';

/**
 * Phase 4 T9's harness (no product code): each measurement runs in a fresh
 * process — plain Node, or the installed app's own binary run as Node — and
 * drives the native memory path stage by stage (walk and seal, hand-over,
 * adoption with Node's passes, first prune), reporting the process's peak
 * resident memory after each; a store where every file is a candidate
 * measures Node's passes alone; a probe loads the addon in a worker thread.
 * These tests hold the harness to its contract on small trees; the
 * measurements themselves are T9's record, not a test.
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
  assert.ok((result.prunedJsonBytes ?? 0) > 0, 'the first prune was serialised');
  const walked = result.stages.find((s) => s.stage === 'walked');
  const handedOver = result.stages.find((s) => s.stage === 'handed-over');
  assert.ok(walked && handedOver);
  const block = result.handOverBlockMs;
  assert.ok(typeof block === 'number' && Number.isFinite(block) && block >= 0, 'the hand-over\'s longest block of the JavaScript thread is measured');
  // The block is timed inside the hand-over, and the hand-over between the two stages: 1 ms is the probe's resolution.
  assert.ok(block <= handedOver.ms - walked.ms + 1, `a ${block} ms block is no longer than the hand-over it was timed in`);
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

test('the hand-over\'s block is read in milliseconds from a histogram that records nanoseconds', () => {
  assert.equal(longestDelayMs({ max: 2_500_000 }), 2.5);
  assert.equal(longestDelayMs({ max: 0 }), 0, 'a histogram that took no sample');
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
    assert.match(r.stdout, /node\s+synthetic 20,000 .* · hand-over block \d+\.\d ms/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
