import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skipOrFailOnCi } from './fixtures/ciSkip';
import { HANG_GUARD_MS } from './fixtures/waitFor';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-benchScanHold-data-');

import { planCorpus, createCorpus, type CorpusManifest } from '../bench/lib/corpus';
import { GOVERNOR_BAND_POINTS, PRESET_CEILING_PERCENT, scanHoldVerdict } from '../bench/lib/governorSuite';
import { runScanHold } from '../bench/lib/suites';
import { readResult } from '../bench/lib/report';
import { nativeScanModule } from '../src/services/scan/nativeEngine';

/**
 * Phase 3's governor gate with a live scan as the load (the Phase 3 plan's
 * "the three 60 s holds with a live scan as the load"): native scans of a
 * corpus back to back under a preset, this process's own share of the
 * machine sampled every 100 ms. A scan waits on the disk and may never reach
 * its ceiling, so where the synthetic hold must sit AT the ceiling, a scan
 * must stay UNDER it: the last half of the samples may average at most the
 * ceiling plus the gate's band.
 */

const REPO = path.join(__dirname, '..');
const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const CORPUS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-scanhold-corpus-'));
after(() => {
  fs.rmSync(CORPUS_DIR, { recursive: true, force: true, maxRetries: 3 });
});

let smallBuild: Promise<CorpusManifest> | null = null;
function small(): Promise<CorpusManifest> {
  if (!smallBuild) {
    const dir = path.join(CORPUS_DIR, 'small');
    fs.mkdirSync(dir);
    smallBuild = createCorpus(dir, planCorpus({ entries: 400, fanout: 5, depth: 3, flat: 0, sizeMedian: 512, sizeSigma: 1, sizeMax: 65_536, duplicateRate: 0, hardlinkRate: 0, sparseRate: 0, seed: 17 }));
  }
  return smallBuild;
}

const repeat = (n: number, v: number): number[] => Array.from({ length: n }, () => v);

/**
 * Every wait on real work here is a hang guard, never a measurement. Eco runs
 * the walk's threads at background QoS, so with every core busy a hold's scan
 * waits for a turn, and since the native stall rule leaves saturated time out
 * it no longer falls back after 30 s. The whole command (tsx, the smoke corpus
 * built or reused, the hold, its last scan run to its end) keeps the longer
 * guard it always had.
 */
const COMMAND_HANG_GUARD_MS = 300_000;

/** The child ran to its own exit: a kill by the hang guard fails by name, not as an exit code of null. */
function ranToExit(r: SpawnSyncReturns<string>, what: string, guardMs: number): SpawnSyncReturns<string> {
  assert.equal(r.error, undefined, `${what} did not run to its own exit (hang guard ${guardMs} ms): ${String(r.error)}`);
  return r;
}

test('the verdict is the last half of the samples against the ceiling plus the band, from below as well', () => {
  const eco = PRESET_CEILING_PERCENT.eco;
  assert.equal(eco, 25);
  assert.equal(GOVERNOR_BAND_POINTS, 5);

  const under = scanHoldVerdict(repeat(20, 20), eco);
  assert.equal(under.samples, 20);
  assert.equal(under.mean, 20);
  assert.equal(under.meanLastHalf, 20);
  assert.equal(under.limit, 30);
  assert.equal(under.withinBudget, true, 'a scan that never reaches its ceiling is within it');

  // The first half is the governor settling (as the synthetic hold's rule has it): a hot start is forgiven.
  const settles = scanHoldVerdict([...repeat(10, 60), ...repeat(10, 20)], eco);
  assert.equal(settles.meanLastHalf, 20);
  assert.equal(settles.max, 60);
  assert.equal(settles.withinBudget, true);

  assert.equal(scanHoldVerdict(repeat(20, 30), eco).withinBudget, true, 'the band is inclusive');
  const over = scanHoldVerdict(repeat(20, 31), eco);
  assert.equal(over.withinBudget, false, 'over the ceiling and its band');

  const ramp = scanHoldVerdict(Array.from({ length: 20 }, (_, i) => i + 1), eco);
  assert.equal(ramp.p95, 19, 'p95 by nearest rank');
  assert.equal(ramp.meanLastHalf, 15.5);

  const none = scanHoldVerdict([], eco);
  assert.equal(none.samples, 0);
  assert.equal(none.withinBudget, false, 'no samples is no evidence');
});

test('a scan hold runs native scans of the corpus back to back in a measuring process and says what it held', { timeout: HANG_GUARD_MS }, async (t) => {
  const surface = nativeScanModule();
  if (!surface.available) {
    skipOrFailOnCi(t, `the native module is not built here: ${surface.reason}`);
    return;
  }
  const manifest = await small();
  const result = await runScanHold({ manifest, corpusName: 'test400', preset: 'eco', seconds: 2, label: 'scanhold test' });
  assert.equal(result.suite, 'governor');
  assert.equal(result.engine, 'native-scan');
  assert.equal(result.entriesUnit, 'samples');
  assert.equal(result.corpus.name, 'scan-hold-eco-test400');
  assert.deepEqual(result.budget, { requested: 'eco', effective: ['eco'] });
  assert.equal(result.runs.length, 1);
  const samples = result.runs[0].entries;
  assert.ok(samples >= 10, `about 20 samples of 100 ms in 2 s: ${samples}`);
  assert.equal(result.summary.reproducible, result.correctness.ok, 'reproducible is the verdict, as for the synthetic hold');
  assert.match(
    result.correctness.notes[0],
    /^\d+ scans? of test400 back to back for \d+\.\d s \(2 s asked; the last scan runs to its end\) under Eco: the last half of \d+ samples averaged \d+\.\d% of the machine \(p95 \d+\.\d%, highest \d+\.\d%\) against Eco's 25% ceiling and its 5-point band — (within|over) budget$/,
  );
  assert.equal(result.correctness.notes[0].endsWith('within budget'), result.correctness.ok);
  assert.match(result.correctness.notes[1], /^series \(every \d+th sample, % of the machine\): [\d. ]+$/);
});

test('the scanhold command is in the usage, and its options are guarded', () => {
  const run = (...args: string[]) => ranToExit(spawnSync(process.execPath, [tsxCli, path.join(REPO, 'bench', 'run.ts'), ...args], { cwd: REPO, encoding: 'utf8', timeout: HANG_GUARD_MS }), `bench ${args.join(' ')}`, HANG_GUARD_MS);
  const help = run('--help');
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes('npm run bench -- scanhold [--corpus=enum200k|enum1m|ci20k|smoke|dupes100k] [--preset=eco|balanced|turbo] [--seconds=60] [--record] [--label=...]'), help.stdout);
  const zero = run('scanhold', '--seconds=0');
  assert.equal(zero.status, 1);
  assert.match(zero.stderr, /--seconds must be an integer between 1 and \d+/);
  const fast = run('scanhold', '--preset=fast');
  assert.equal(fast.status, 1);
  assert.match(fast.stderr, /--preset must be one of eco, balanced, turbo/);
  const engine = run('scanhold', '--engine=walker');
  assert.equal(engine.status, 1);
  assert.match(engine.stderr, /unknown option --engine for scanhold/);
});

test('the scanhold command runs end to end on the smoke corpus and writes its result', (t) => {
  const surface = nativeScanModule();
  if (!surface.available) {
    skipOrFailOnCi(t, `the native module is not built here: ${surface.reason}`);
    return;
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-scanhold-out-'));
  try {
    const env = { ...process.env, TREEMAP_BENCH_OUT: out };
    const r = ranToExit(spawnSync(process.execPath, [tsxCli, path.join(REPO, 'bench', 'run.ts'), 'scanhold', '--corpus=smoke', '--preset=eco', '--seconds=2', '--label=cli test'], { cwd: REPO, encoding: 'utf8', timeout: COMMAND_HANG_GUARD_MS, env }), 'bench scanhold on the smoke corpus', COMMAND_HANG_GUARD_MS);
    assert.doesNotMatch(r.stderr, /^bench: /m, `the command ran to a result, not a crash: ${r.stderr}`);
    assert.ok(r.status === 0 || r.status === 1, `exit ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /governor\s+scan-hold-eco-smoke\s+native-scan/);
    const files = fs.readdirSync(out).filter((f) => f.startsWith('governor-native-scan-scan-hold-eco-smoke'));
    assert.equal(files.length, 1, fs.readdirSync(out).join(','));
    const written = readResult(path.join(out, files[0]));
    assert.equal(written.corpus.name, 'scan-hold-eco-smoke');
    assert.equal(r.status === 0, written.correctness.ok, 'the exit code is the verdict');
  } finally {
    fs.rmSync(out, { recursive: true, force: true, maxRetries: 3 });
  }
});
