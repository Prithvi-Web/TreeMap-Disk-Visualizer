import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readResult, summarize, writeResult, type BenchResult, type BenchRun } from '../bench/lib/report';

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
    budget: { requested: 'turbo', effective: ['turbo', 'turbo', 'turbo'] },
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

test('bench compare exits 3 when two duplicate results ran at different --min-size, and two near-duplicate results at different --threshold', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-cli-options-'));
  try {
    const dup = (wallMs: number, minSize: number): BenchResult => ({ ...fakeResult(wallMs), suite: 'duplicates', engine: 'sha256-staged', entriesUnit: 'files', minSize });
    const near = (wallMs: number, threshold: number): BenchResult => ({ ...fakeResult(wallMs), suite: 'neardup', engine: 'dhash-pairwise', entriesUnit: 'images', threshold });
    const sizes = bench('compare', writeResult(dup(700, 4096), dir, 'dup-4096.json'), writeResult(dup(1000, 1024), dir, 'dup-1024.json'));
    assert.equal(sizes.status, 3, sizes.stdout + sizes.stderr);
    assert.match(sizes.stdout, /^NOT COMPARABLE: .*--min-size \(4096 vs 1024\)/);
    const thresholds = bench('compare', writeResult(near(700, 12), dir, 'near-12.json'), writeResult(near(1000, 10), dir, 'near-10.json'));
    assert.equal(thresholds.status, 3, thresholds.stdout + thresholds.stderr);
    assert.match(thresholds.stdout, /^NOT COMPARABLE: .*--threshold \(12 vs 10\)/);
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
    // No --preset: the enumerate suite scans under Turbo, and says so beside the cache state.
    assert.deepEqual(readResult(path.join(out, files[0])).budget, { requested: 'turbo', effective: ['turbo', 'turbo'] });
    assert.match(r.stdout, /^ {2}budget: turbo requested, ran under turbo\/turbo$/m);
    const d = spawnSync(process.execPath, [tsxCli, path.join(REPO, 'bench', 'run.ts'), 'duplicates', '--corpus=smoke', '--runs=1', '--label=cli test'], { cwd: REPO, encoding: 'utf8', timeout: 300_000, env });
    assert.equal(d.status, 0, d.stdout + d.stderr);
    assert.match(d.stdout, /recall 1\.0000/);
    assert.match(d.stdout, /^ {2}budget: auto requested, ran under (balanced|eco)$/m, "the duplicate suite runs under the app's default and says what it resolved to");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('--preset is guarded: one of three presets for enumerate, never Automatic, and not an option of the suites that name none', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-cli-guard-'));
  // One smoke run into a scratch directory: were the guard ever to lapse, the run it let through would be small and would write nothing into bench/results.
  const guarded = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [tsxCli, path.join(REPO, 'bench', 'run.ts'), ...args, '--corpus=smoke', '--runs=1'], { cwd: REPO, encoding: 'utf8', timeout: 120_000, env: { ...process.env, TREEMAP_BENCH_OUT: out } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  try {
    const fast = guarded('enumerate', '--preset=fast');
    assert.equal(fast.status, 1, fast.stdout + fast.stderr);
    assert.match(fast.stderr, /--preset must be one of eco, balanced, turbo/);
    const auto = guarded('enumerate', '--preset=auto');
    assert.equal(auto.status, 1, auto.stdout + auto.stderr);
    assert.match(auto.stderr, /--preset must be one of eco, balanced, turbo/);
    const dup = guarded('duplicates', '--preset=eco');
    assert.equal(dup.status, 1, dup.stdout + dup.stderr);
    assert.match(dup.stderr, /unknown option --preset for duplicates/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the enumerate usage names --preset and says the default is Turbo and why', () => {
  const r = bench('--help');
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('npm run bench -- enumerate'));
  assert.ok(line?.includes('[--preset=eco|balanced|turbo]'), line);
  assert.match(r.stdout, /--preset defaults to turbo/);
  assert.match(r.stdout, /headline/, 'the reason: the headline enumeration target is a Turbo figure');
  assert.match(r.stdout, /Automatic/, "and why the app's own default is not a condition a number can name");
});

test('--preset=eco reaches the measuring process, and the budget is printed and written with the result', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-cli-preset-'));
  try {
    const env = { ...process.env, TREEMAP_BENCH_OUT: out };
    const r = spawnSync(process.execPath, [tsxCli, path.join(REPO, 'bench', 'run.ts'), 'enumerate', '--corpus=smoke', '--engine=walker', '--runs=1', '--preset=eco', '--label=cli test'], { cwd: REPO, encoding: 'utf8', timeout: 300_000, env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /budget eco/, 'the progress line names the preset before the runs start');
    assert.match(r.stdout, /enumerate\s+smoke\s+\S+\s+\S+\s+eco: eco\s/, 'the table carries it beside the cache state');
    assert.match(r.stdout, /^ {2}budget: eco requested, ran under eco$/m);
    const files = fs.readdirSync(out).filter((f) => f.startsWith('enumerate-'));
    assert.equal(files.length, 1, files.join(','));
    assert.deepEqual(readResult(path.join(out, files[0])).budget, { requested: 'eco', effective: ['eco'] });
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
