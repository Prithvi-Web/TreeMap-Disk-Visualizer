import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PRESET_CEILING_PERCENT, SERIES_STRIDE, runGovernor, type HoldReport } from '../bench/lib/governorSuite';
import { compareToBaseline, isBenchResult, printTable, readResult, writeResult } from '../bench/lib/report';
import type { NativeOutcome } from '../src/services/scan/native';

// The native module is an accelerator that may be missing on any machine (no
// prebuilt, a version mismatch), so every test here injects the loader's
// outcome: a fake module whose governorHold resolves a scripted report, or the
// honest `{ available: false, reason }`. Nothing here needs cargo.

const REPO = path.join(__dirname, '..');
const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const FAKE_VERSION = '0.1.0';
const FAKE_PATH = '/fake/native/prebuilt/test/treemap_core.node';
/** The fake hold takes this long, so the measured wall clock is a real, positive number. */
const FAKE_HOLD_MS = 20;

function bench(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [tsxCli, path.join(REPO, 'bench', 'run.ts'), ...args], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A scripted series in percent: every SERIES_STRIDE-th sample is distinctive (30, 31, 32, …), the rest sit at `filler`. */
function series(length: number, filler: number): number[] {
  return Array.from({ length }, (_, i) => (i % SERIES_STRIDE === 0 ? 30 + i / SERIES_STRIDE : filler));
}

function heldReport(overrides: Partial<HoldReport> = {}): HoldReport {
  return { target: 25, samples: series(25, 24.5), mean: 24.9, meanLastHalf: 25.2, p95AbsError: 2.4, withinBand: true, workersFinal: 2, dutyFinal: 0.41, ...overrides };
}

/** Every call the suite makes on the module, in order. */
interface Call { fn: 'governorConfigure' | 'governorHold'; args: unknown[] }

function fakeNative(resolveWith: unknown, calls: Call[] = []): NativeOutcome {
  const module = {
    version: (): string => FAKE_VERSION,
    governorConfigure: (...args: unknown[]): void => { calls.push({ fn: 'governorConfigure', args }); },
    governorHold: async (...args: unknown[]): Promise<unknown> => {
      calls.push({ fn: 'governorHold', args });
      await new Promise((resolve) => setTimeout(resolve, FAKE_HOLD_MS));
      return resolveWith;
    },
  };
  return { available: true, module, version: FAKE_VERSION, path: FAKE_PATH };
}

const withTempDir = async (prefix: string, body: (dir: string) => Promise<void> | void): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try { await body(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test('a hold the governor kept in band is a governor result: one run of samples, correctness from the band, the series in the notes', async () => {
  const calls: Call[] = [];
  const result = await runGovernor({ preset: 'eco', seconds: 2, label: 'governor test', native: fakeNative(heldReport(), calls) });
  assert.equal(result.suite, 'governor');
  assert.equal(result.entriesUnit, 'samples');
  assert.equal(result.engine, 'tm-governor');
  assert.equal(result.corpus.name, 'hold-eco');
  assert.deepEqual(result.corpus.params, { preset: 'eco', seconds: 2, targetShare: 0.25 });
  assert.equal(result.corpus.scale, 'this machine');
  assert.equal(result.label, 'governor test');
  assert.deepEqual(calls, [
    { fn: 'governorConfigure', args: [{ preset: 'eco', cpuPercent: null }, false] },
    { fn: 'governorHold', args: [PRESET_CEILING_PERCENT.eco, 2] },
  ], "the governor is configured for the preset with auto mode off, then asked to hold that preset's ceiling");
  assert.equal(result.runs.length, 1, 'one run: the hold is itself the series');
  const run = result.runs[0];
  assert.equal(run.entries, 25, 'entries is the sample count');
  assert.ok(run.wallMs >= FAKE_HOLD_MS / 2 && run.wallMs < 5_000, `wallMs ${run.wallMs} is the measured hold, not seconds × 1000 assumed`);
  assert.ok(Number.isFinite(run.cpuSeconds) && run.cpuSeconds >= 0, `cpuSeconds ${run.cpuSeconds}`);
  assert.equal(run.selfCpuSeconds, run.cpuSeconds);
  assert.equal(run.bytesRead, null);
  assert.match(run.bytesReadReason, /hold/);
  assert.equal(run.persistMs, 0);
  assert.ok(run.peakRssBytes > 0, "the measuring process's own peak RSS");
  assert.equal(result.correctness.ok, true);
  assert.equal(result.summary.reproducible, true, 'reproducible is the band verdict for this suite');
  assert.equal(result.summary.spreadPct, 2.4, "the spread column carries the hold's p95 |error| in points");
  assert.ok(result.summary.entriesPerSecond > 0);
  const notes = result.correctness.notes.join('\n');
  for (const expected of [/target 25/, /mean 24\.9/, /last half 25\.2/, /p95[^\n]*2\.4/, /workers 2/, /duty 0\.41/]) assert.match(notes, expected);
  const seriesNote = result.correctness.notes.find((n) => n.startsWith('series'));
  assert.ok(seriesNote, notes);
  assert.match(seriesNote, /every 10th of 25 samples/);
  assert.match(seriesNote, /30\.0 31\.0 32\.0/, 'every 10th sample on one line');
  assert.doesNotMatch(seriesNote, /24\.5/, 'the samples between are not printed');
});

test('a governor result survives the trip through JSON reproducible and prints samples per second', async () => {
  await withTempDir('treemap-bench-governor-', async (dir) => {
    const result = await runGovernor({ preset: 'eco', seconds: 2, label: 'json', native: fakeNative(heldReport()) });
    const back = readResult(writeResult(result, dir, 'eco.json'));
    assert.equal(back.summary.reproducible, true);
    assert.equal(back.correctness.ok, true);
    const table = printTable([back]);
    assert.match(table, /samples\/s/);
    assert.match(table, /2\.4 pt/);
    assert.doesNotMatch(table, /NaN|Infinity/);
  });
});

test('a hold outside the band fails correctness, with the real series still in the notes', async () => {
  const report = heldReport({ target: 50, samples: series(30, 41), mean: 42.0, meanLastHalf: 43.1, p95AbsError: 8.7, withinBand: false });
  const result = await runGovernor({ preset: 'balanced', seconds: 2, label: 'band', native: fakeNative(report) });
  assert.equal(result.correctness.ok, false);
  assert.equal(result.summary.reproducible, false);
  assert.equal(result.runs[0].entries, 30);
  const notes = result.correctness.notes.join('\n');
  assert.match(notes, /outside/);
  assert.match(notes, /30\.0 31\.0 32\.0/);
  const table = printTable([result]);
  assert.match(table, /FAIL/);
  assert.match(table, /outside the band/);
});

test('a report in shares (the Rust unit) is printed in points, and a report for a target other than the one asked for is refused', async () => {
  const shares = heldReport({ target: 0.25, samples: series(25, 24.5).map((s) => s / 100), mean: 0.249, meanLastHalf: 0.252, p95AbsError: 0.024 });
  const result = await runGovernor({ preset: 'eco', seconds: 2, label: 'shares', native: fakeNative(shares) });
  const notes = result.correctness.notes.join('\n');
  assert.match(notes, /target 25/);
  assert.match(notes, /30\.0 31\.0 32\.0/);
  assert.ok(Math.abs(result.summary.spreadPct - 2.4) < 1e-9, `${result.summary.spreadPct}`);
  await assert.rejects(
    runGovernor({ preset: 'eco', seconds: 2, label: 'wrong', native: fakeNative(heldReport({ target: 50 })) }),
    /not the 25%/,
  );
});

test("no native module: an honest failure carrying the loader's reason, one zero-sample run, never a series", async () => {
  const reason = 'no native module at /nowhere/treemap_core.node for darwin-arm64; the legacy engines run instead';
  const result = await runGovernor({ preset: 'turbo', seconds: 60, label: 'missing', native: { available: false, reason } });
  assert.deepEqual(result.correctness, { ok: false, notes: [reason] });
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].entries, 0);
  assert.equal(result.runs[0].wallMs, 0);
  assert.equal(result.summary.wallMsMedian, 0);
  assert.equal(result.summary.entriesPerSecond, 0);
  assert.equal(result.summary.reproducible, false);
  for (const [key, value] of Object.entries(result.summary)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} is ${value}`);
  }
  assert.equal(result.corpus.name, 'hold-turbo');
  assert.deepEqual(result.corpus.params, { preset: 'turbo', seconds: 60, targetShare: 0.9 });
  assert.equal(isBenchResult(result), true, 'a hold that never ran is still a well-formed record');
  await withTempDir('treemap-bench-governor-', (dir) => {
    const back = readResult(writeResult(result, dir, 'failed.json'));
    assert.equal(back.correctness.ok, false);
    assert.equal(back.summary.reproducible, false);
    const table = printTable([back]);
    assert.doesNotMatch(table, /NaN|Infinity/);
    assert.match(table, /FAIL/);
    assert.match(table, /n\/a/, 'nothing was measured, so the timing columns say so');
    const verdict = compareToBaseline(back, back);
    assert.equal(verdict.verdict, 'NOT COMPARABLE');
    assert.doesNotMatch(verdict.sentence, /NaN/);
  });
});

test('a module that loads but exports no governor is refused with its file and version named, not held', async () => {
  const module = { version: (): string => FAKE_VERSION };
  const result = await runGovernor({ preset: 'eco', seconds: 1, label: 'stale', native: { available: true, module, version: FAKE_VERSION, path: FAKE_PATH } });
  assert.equal(result.correctness.ok, false);
  assert.equal(result.correctness.notes.length, 1);
  assert.match(result.correctness.notes[0], /governorHold/);
  assert.match(result.correctness.notes[0], /0\.1\.0/);
  assert.match(result.correctness.notes[0], /treemap_core\.node/);
  assert.equal(result.runs[0].entries, 0);
});

test('a malformed hold report is an error, never a number', async () => {
  const hold = (resolveWith: unknown) => runGovernor({ preset: 'eco', seconds: 1, label: 'bad', native: fakeNative(resolveWith) });
  await assert.rejects(hold(42), /report/);
  await assert.rejects(hold(heldReport({ samples: [] })), /sample/);
  await assert.rejects(hold(heldReport({ withinBand: 'yes' as unknown as boolean })), /withinBand/);
});

test('the governor command is in the usage and its options are guarded: seconds at least 1, preset one of three, nothing else', () => {
  const help = bench('--help');
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes('npm run bench -- governor [--preset=eco|balanced|turbo] [--seconds=60] [--record] [--label=...]'), help.stdout);
  const zero = bench('governor', '--seconds=0');
  assert.equal(zero.status, 1, zero.stdout + zero.stderr);
  assert.match(zero.stderr, /--seconds must be an integer between 1 and \d+/);
  const fast = bench('governor', '--preset=fast');
  assert.equal(fast.status, 1, fast.stdout + fast.stderr);
  assert.match(fast.stderr, /--preset must be one of eco, balanced, turbo/);
  const runs = bench('governor', '--runs=3');
  assert.equal(runs.status, 1, runs.stdout + runs.stderr);
  assert.match(runs.stderr, /unknown option --runs for governor/);
});

test('bench compare works between two governor results of one preset and refuses two presets', async () => {
  await withTempDir('treemap-bench-governor-cmp-', async (dir) => {
    const a = writeResult(await runGovernor({ preset: 'eco', seconds: 2, label: 'a', native: fakeNative(heldReport()) }), dir, 'eco-a.json');
    const b = writeResult(await runGovernor({ preset: 'eco', seconds: 2, label: 'b', native: fakeNative(heldReport({ meanLastHalf: 24.8 })) }), dir, 'eco-b.json');
    const c = writeResult(await runGovernor({ preset: 'balanced', seconds: 2, label: 'c', native: fakeNative(heldReport({ target: 50, samples: series(25, 49) })) }), dir, 'balanced.json');
    // One hold has no resolution across runs — its wall clock is the prescribed length — so the verdict is inconclusive, never refused.
    const same = bench('compare', a, b);
    assert.equal(same.status, 2, same.stdout + same.stderr);
    assert.match(same.stdout, /^INCONCLUSIVE/);
    const different = bench('compare', c, a);
    assert.equal(different.status, 3, different.stdout + different.stderr);
    assert.match(different.stdout, /^NOT COMPARABLE/);
    assert.match(different.stdout, /corpus \(hold-balanced vs hold-eco\)/);
  });
});

test("the governor command runs end to end and writes a result whatever the native module's state", async () => {
  await withTempDir('treemap-bench-governor-out-', (out) => {
    const env = { ...process.env, TREEMAP_BENCH_OUT: out };
    const r = spawnSync(process.execPath, [tsxCli, path.join(REPO, 'bench', 'run.ts'), 'governor', '--preset=eco', '--seconds=1', '--label=cli test'], { cwd: REPO, encoding: 'utf8', timeout: 120_000, env });
    assert.doesNotMatch(r.stderr, /^bench: /m, `the command ran to a result, not a crash: ${r.stderr}`);
    assert.ok(r.status === 0 || r.status === 1, `exit ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /governor\s+hold-eco\s+tm-governor/);
    const files = fs.readdirSync(out).filter((f) => f.startsWith('governor-tm-governor-hold-eco-'));
    assert.equal(files.length, 1, files.join(','));
    const written = readResult(path.join(out, files[0]));
    assert.equal(written.suite, 'governor');
    assert.equal(written.corpus.name, 'hold-eco');
    // Either the module held eco for a second (a real series, its verdict) or it could not load (its reason, no series) — never a series without a module.
    if (written.runs[0].entries === 0) {
      assert.equal(r.status, 1);
      assert.match(r.stdout, /CORRECTNESS: /);
      assert.match(written.correctness.notes[0], /native module|governorHold/);
    } else {
      assert.ok(written.correctness.notes.some((n) => n.startsWith('series')), written.correctness.notes.join('\n'));
    }
  });
});
