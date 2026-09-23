/**
 * The governor suite: `npm run bench -- governor` asks the native governor to
 * hold its own synthetic load at a preset's CPU ceiling for a fixed number of
 * seconds and records the share it actually held, as sampled by the hold's
 * independent sampler (docs/superpowers/plans/2026-09-18-phase2-governor.md,
 * Task 7). It is the Phase 2 gate: a preset passes when the mean of the last
 * half of the run sits within GOVERNOR_BAND_POINTS of the ceiling.
 *
 * Who measured what:
 *   - the series, its mean, the mean of its last half, the p95 absolute error
 *     and the band verdict come from the native hold; the harness prints them
 *     and never recomputes or smooths them;
 *   - the wall clock is this process's own clock around the call;
 *   - CPU seconds are this process's `process.cpuUsage()` delta, which
 *     includes the synthetic load (it runs on this process's threads);
 *   - peak RSS, load, bytes read and persistence are the measuring process's
 *     own, and the run record labels them so.
 *
 * One run is one result: the hold is itself a series of several hundred
 * samples, so `reproducible` is the band verdict, not a spread across runs.
 * When the native module cannot load, the result is an honest failure — the
 * loader's reason, a single zero-sample run and no series at all.
 */
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { loadNative, type NativeModule, type NativeOutcome } from '../../src/services/scan/native';
import { describeMachine } from './machine';
import { NO_BUDGET, summarize, type BenchResult, type BenchRun, type BenchSummary } from './report';

export type GovernorPreset = 'eco' | 'balanced' | 'turbo';
export const GOVERNOR_PRESETS: readonly GovernorPreset[] = ['eco', 'balanced', 'turbo'];
/** The preset table's ceilings (the plan's Section 8.1), in percent of machine CPU: what each preset is asked to hold. */
export const PRESET_CEILING_PERCENT: Readonly<Record<GovernorPreset, number>> = { eco: 25, balanced: 50, turbo: 90 };
/** The gate's band around the ceiling, in percentage points, judged over the last half of the run. */
export const GOVERNOR_BAND_POINTS = 5;
/** The notes carry the series on one line by keeping every Nth sample. */
export const SERIES_STRIDE = 10;
export const GOVERNOR_ENGINE = 'tm-governor';

const ENGINE_DESCRIPTION = "the native Rust governor (tm-governor) holding its own synthetic load at the preset's CPU ceiling, the share sampled by the hold's independent sampler";
const CACHE_REASON = 'not applicable: the hold reads no files';
const NO_FILES_REASON = "the hold reads no files; the measuring process's own reads were not probed";
const NO_HOLD_REASON = 'no hold ran, so nothing was read';
const OWN_PROCESS_NOTE = "CPU seconds, peak RSS and load are the measuring process's own (the synthetic load runs on its threads); bytes read and persistence do not apply";
const PERCENT_PER_SHARE = 100;
const BYTES_PER_KIB = 1024;
const MICROSECONDS_PER_SECOND = 1_000_000;
/** Two targets are the same target within this much (a share converted to percent may carry rounding). */
const TARGET_TOLERANCE = 1e-9;

/** What the native hold reports, normalised to percent of machine CPU whatever unit the module spoke. */
export interface HoldReport {
  target: number;
  samples: number[];
  mean: number;
  meanLastHalf: number;
  p95AbsError: number;
  /** The native verdict: |meanLastHalf − target| within the band. Never recomputed here. */
  withinBand: boolean;
  workersFinal: number;
  dutyFinal: number;
}

export interface GovernorOptions {
  preset: GovernorPreset;
  seconds: number;
  label: string;
  /** Test hook: the loader's outcome, standing in for `loadNative()`. */
  native?: NativeOutcome;
}

type HoldFn = (targetPercent: number, seconds: number) => Promise<unknown>;
type ConfigureFn = (budget: { preset: GovernorPreset; cpuPercent: number | null }, auto: boolean) => unknown;
type GovernorApi = { hold: HoldFn; configure: ConfigureFn } | { refused: string };
/** Everything a result carries besides what the hold decides. */
type ResultFrame = Omit<BenchResult, 'budget' | 'runs' | 'summary' | 'correctness' | 'recordedAt'>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const sameTarget = (a: number, b: number): boolean => Math.abs(a - b) <= TARGET_TOLERANCE;

export async function runGovernor(opts: GovernorOptions): Promise<BenchResult> {
  const machine = await describeMachine();
  const targetPercent = PRESET_CEILING_PERCENT[opts.preset];
  const frame: ResultFrame = {
    suite: 'governor',
    corpus: { name: `hold-${opts.preset}`, params: { preset: opts.preset, seconds: opts.seconds, targetShare: targetPercent / PERCENT_PER_SHARE }, scale: 'this machine' },
    engine: GOVERNOR_ENGINE,
    engineDescription: ENGINE_DESCRIPTION,
    entriesUnit: 'samples',
    machine,
    cache: { state: 'unknown', reason: CACHE_REASON },
    commit: machine.commit,
    label: opts.label,
  };
  const native = opts.native ?? loadNative();
  if (!native.available) return notHeld(frame, opts.preset, native.reason);
  const api = governorApi(native);
  if ('refused' in api) return notHeld(frame, opts.preset, api.refused);

  // Auto mode off: the gate measures the preset asked for, not the one battery or thermal state would pick.
  api.configure({ preset: opts.preset, cpuPercent: null }, false);
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  const raw = await api.hold(targetPercent, opts.seconds);
  const wallMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuBefore);
  const report = parseHoldReport(raw, targetPercent);

  const cpuSeconds = (cpu.user + cpu.system) / MICROSECONDS_PER_SECOND;
  const run: BenchRun = {
    wallMs,
    entries: report.samples.length,
    cpuSeconds,
    selfCpuSeconds: cpuSeconds,
    // The hold runs on this process's threads and starts no child process.
    childCpuSeconds: 0,
    peakRssBytes: peakRssBytes(),
    bytesRead: null,
    bytesReadReason: NO_FILES_REASON,
    persistMs: 0,
    persistCpuSeconds: 0,
    loadAvg: loadAvg(),
  };
  const summary: BenchSummary = {
    ...summarize([run]),
    // One run is the whole series: its spread is the hold's p95 |error| in points, and it is reproducible when the band held.
    spreadPct: report.p95AbsError,
    reproducible: report.withinBand,
  };
  return {
    ...frame,
    // Auto mode is off and parseHoldReport refused any target but this preset's ceiling, so the hold ran under the preset asked for.
    budget: { requested: opts.preset, effective: [opts.preset] },
    runs: [run],
    summary,
    correctness: { ok: report.withinBand, notes: holdNotes(opts, report, wallMs) },
    recordedAt: new Date().toISOString(),
  };
}

/**
 * The record of a hold that never ran. Built by hand because `summarize()`
 * rightly refuses a zero wall clock as "not a measurement" — and this is not
 * one; it is the statement that nothing was measured. Zeros rather than NaN
 * or a made-up series: 0 samples in 0 ms is the honest count of nothing, and
 * `correctness.ok: false` with `reproducible: false` keeps the record out of
 * every comparison and baseline (`isBenchResult` admits a zero wall clock
 * only on a result that failed correctness — its rule 6).
 */
function notHeld(frame: ResultFrame, preset: GovernorPreset, reason: string): BenchResult {
  const run: BenchRun = {
    wallMs: 0,
    entries: 0,
    cpuSeconds: 0,
    selfCpuSeconds: 0,
    childCpuSeconds: 0,
    peakRssBytes: peakRssBytes(),
    bytesRead: null,
    bytesReadReason: NO_HOLD_REASON,
    persistMs: 0,
    persistCpuSeconds: 0,
    loadAvg: loadAvg(),
  };
  const summary: BenchSummary = {
    wallMsMedian: 0,
    entriesPerSecond: 0,
    cpuSecondsPerMillion: 0,
    peakRssBytes: run.peakRssBytes,
    bytesReadMedian: null,
    spreadPct: 0,
    resolutionPct: 0,
    reproducible: false,
  };
  // Nothing ran, so the one run ran under no budget: NO_BUDGET, never the preset that was asked for.
  return { ...frame, budget: { requested: preset, effective: [NO_BUDGET] }, runs: [run], summary, correctness: { ok: false, notes: [reason] }, recordedAt: new Date().toISOString() };
}

/** The two exports the hold needs, or the reason a loaded module cannot hold anything (a build from before the governor). */
function governorApi(native: { module: NativeModule; version: string; path: string }): GovernorApi {
  const { governorHold, governorConfigure } = native.module;
  if (typeof governorHold !== 'function' || typeof governorConfigure !== 'function') {
    return { refused: `the native module at ${native.path} (version ${native.version}) exports no governorHold()/governorConfigure(), so nothing was held` };
  }
  return { hold: governorHold as HoldFn, configure: governorConfigure as ConfigureFn };
}

function finiteField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`governorHold's report has no finite ${key} (got ${JSON.stringify(value)})`);
  return value;
}

/**
 * Validates the module's report and normalises it to percent. The Rust
 * HoldReport speaks in shares (0..1) while the napi call takes a percent;
 * whichever unit the module kept, its target must be the one asked for — a
 * hold of some other target would describe the wrong preset.
 */
function parseHoldReport(raw: unknown, targetPercent: number): HoldReport {
  if (!isRecord(raw)) throw new Error(`governorHold resolved with ${JSON.stringify(raw)} instead of a hold report`);
  const target = finiteField(raw, 'target');
  const scale = sameTarget(target, targetPercent) ? 1 : sameTarget(target * PERCENT_PER_SHARE, targetPercent) ? PERCENT_PER_SHARE : null;
  if (scale === null) throw new Error(`governorHold held a target of ${target}, not the ${targetPercent}% asked for`);
  const samples = raw.samples;
  if (!Array.isArray(samples) || samples.length === 0 || !samples.every((s): s is number => typeof s === 'number' && Number.isFinite(s))) {
    throw new Error('governorHold returned no usable sample series');
  }
  if (typeof raw.withinBand !== 'boolean') throw new Error('governorHold returned no withinBand verdict');
  return {
    target: target * scale,
    samples: samples.map((s) => s * scale),
    mean: finiteField(raw, 'mean') * scale,
    meanLastHalf: finiteField(raw, 'meanLastHalf') * scale,
    p95AbsError: finiteField(raw, 'p95AbsError') * scale,
    withinBand: raw.withinBand,
    workersFinal: finiteField(raw, 'workersFinal'),
    dutyFinal: finiteField(raw, 'dutyFinal'),
  };
}

function holdNotes(opts: GovernorOptions, r: HoldReport, wallMs: number): string[] {
  const n = r.samples.length;
  const pct = (x: number): string => x.toFixed(1);
  const compact = r.samples.filter((_, i) => i % SERIES_STRIDE === 0).map(pct).join(' ');
  return [
    `target ${pct(r.target)}% of machine CPU (the ${opts.preset} ceiling) held for ${opts.seconds} s (${wallMs.toFixed(0)} ms measured): ` +
      `mean ${pct(r.mean)}% over ${n} samples, mean of the last half ${pct(r.meanLastHalf)}%, p95 |error| ${pct(r.p95AbsError)} points — ` +
      `${r.withinBand ? 'within' : 'outside'} the ±${GOVERNOR_BAND_POINTS} point band over the last half`,
    `final workers ${r.workersFinal}, final duty ${r.dutyFinal.toFixed(2)}`,
    `series (every ${SERIES_STRIDE}th of ${n} samples, % of machine CPU): ${compact}`,
    OWN_PROCESS_NOTE,
  ];
}

/** `process.resourceUsage().maxRSS` is KiB on macOS and Linux and bytes on Windows — the rule bench/lib/rusage.ts applies. */
function peakRssBytes(): number {
  const { maxRSS } = process.resourceUsage();
  return process.platform === 'win32' ? maxRSS : maxRSS * BYTES_PER_KIB;
}

/** 1/5/15-minute load at the end of the run; Windows has none. */
function loadAvg(): number[] | null {
  return process.platform === 'win32' ? null : os.loadavg();
}
