import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { summarize, writeResult, type BenchResult, type BenchRun } from '../bench/lib/report';

const REPO = path.join(__dirname, '..');
const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');

function bench(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [tsxCli, path.join(REPO, 'bench', 'run.ts'), ...args], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function fakeResult(wallMs: number): BenchResult {
  const run: BenchRun = { wallMs, entries: 1000, cpuSeconds: 0.1, childCpuSeconds: null, peakRssBytes: 1, bytesRead: null, loadAvg: [0, 0, 0] };
  return {
    suite: 'enumerate',
    corpus: { name: 'fake', params: {}, scale: 'test' },
    engine: 'walker',
    machine: { cpuModel: 'x', cores: 1, perfCores: null, effCores: null, memoryBytes: 1, platform: 'test', osRelease: '0', node: 'v0', commit: 'unknown', loadAvg: [0, 0, 0], maxVnodes: null, tier: 'C', tierReason: 'test' },
    cache: { state: 'unknown', reason: 'test' },
    runs: [run, run, run],
    summary: { ...summarize([run, run, run]), resolutionPct: 1 },
    correctness: { ok: true, notes: [] },
    recordedAt: '2026-09-18T00:00:00.000Z',
    commit: 'unknown',
    label: 'test',
  };
}

test('bench --help prints every command and exits 0', () => {
  const r = bench('--help');
  assert.equal(r.status, 0, r.stderr);
  for (const cmd of ['enumerate', 'duplicates', 'neardup', 'all', 'compare']) assert.ok(r.stdout.includes(`npm run bench -- ${cmd}`), `help names ${cmd}`);
});

test('bench compare exits 1 on a regression beyond the gate and 0 otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-cli-'));
  try {
    const base = writeResult(fakeResult(1000), dir, 'base.json');
    const slow = writeResult(fakeResult(1300), dir, 'slow.json');
    const fast = writeResult(fakeResult(700), dir, 'fast.json');
    const bad = bench('compare', slow, base);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /^FAIL: 30\.0% slower/);
    const good = bench('compare', fast, base);
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /^PASS: 30\.0% faster/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown command is refused with a non-zero exit', () => {
  const r = bench('frobnicate');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command/);
});
