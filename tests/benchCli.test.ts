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
  const run: BenchRun = { wallMs, entries: 1000, cpuSeconds: 0.1, selfCpuSeconds: 0.1, childCpuSeconds: 0, peakRssBytes: 1, bytesRead: null, bytesReadReason: 'test', persistMs: 0, persistCpuSeconds: 0, loadAvg: [0, 0, 0] };
  return {
    suite: 'enumerate',
    corpus: { name: 'fake', params: {}, scale: 'test' },
    engine: 'walker',
    engineDescription: 'the Node walker',
    entriesUnit: 'entries',
    machine: { cpuModel: 'x', cores: 1, perfCores: null, effCores: null, memoryBytes: 1, platform: 'test', arch: 'x64', osRelease: '0', node: 'v0', commit: 'unknown', dirty: false, loadAvg: [0, 0, 0], maxVnodes: null, tier: 'C', tierReason: 'test' },
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

test('bench compare exits 1 on a regression, 0 on a pass, 2 when inconclusive and 3 when not comparable', () => {
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
    const near = writeResult(fakeResult(1005), dir, 'near.json');
    const inconclusive = bench('compare', near, base);
    assert.equal(inconclusive.status, 2, inconclusive.stdout + inconclusive.stderr);
    assert.match(inconclusive.stdout, /^INCONCLUSIVE/);
    const other = fakeResult(700);
    other.corpus = { ...other.corpus, name: 'elsewhere' };
    const foreign = writeResult(other, dir, 'foreign.json');
    const refused = bench('compare', foreign, base);
    assert.equal(refused.status, 3, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /^NOT COMPARABLE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown command is refused with a non-zero exit', () => {
  const r = bench('frobnicate');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command/);
});

test('an unknown or malformed option is refused instead of silently ignored', () => {
  const r = bench('enumerate', '--run=3');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option --run/);
  const bad = bench('enumerate', '--runs=0');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--runs must be an integer between 1 and 50/);
  const engine = bench('enumerate', '--engine=turbo');
  assert.equal(engine.status, 1);
  assert.match(engine.stderr, /--engine must be one of/);
  const one = bench('compare', '/nowhere.json');
  assert.equal(one.status, 1);
  assert.match(one.stderr, /compare needs/);
});

test('the smoke corpus runs the enumerate and duplicates commands end to end', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-cli-out-'));
  try {
    const env = { ...process.env, TREEMAP_BENCH_OUT: out };
    const r = spawnSync(process.execPath, [tsxCli, path.join(REPO, 'bench', 'run.ts'), 'enumerate', '--corpus=smoke', '--engine=walker', '--runs=2', '--label=cli test'], { cwd: REPO, encoding: 'utf8', timeout: 300_000, env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /enumerate\s+smoke/);
    assert.match(r.stdout, /correct/);
    const files = fs.readdirSync(out).filter((f) => f.startsWith('enumerate-'));
    assert.equal(files.length, 1, files.join(','));
    const d = spawnSync(process.execPath, [tsxCli, path.join(REPO, 'bench', 'run.ts'), 'duplicates', '--corpus=smoke', '--runs=1', '--label=cli test'], { cwd: REPO, encoding: 'utf8', timeout: 300_000, env });
    assert.equal(d.status, 0, d.stdout + d.stderr);
    assert.match(d.stdout, /recall 1\.0000/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
