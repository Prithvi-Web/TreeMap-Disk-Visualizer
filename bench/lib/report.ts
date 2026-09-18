/**
 * The result record every bench suite produces, and the arithmetic that turns
 * runs into a verdict.
 *
 * Rules, each borrowed from `scripts/bench-v4.ts` or learned from a review
 * that made this harness print a wrong number:
 *
 * 1. A figure carries the load it was taken under and the cache state.
 * 2. A difference smaller than the measurement's own resolution is not a
 *    result; it prints INCONCLUSIVE with the band stated. The band of a
 *    comparison combines both measurements' bands.
 * 3. Nothing here estimates: a run that could not measure bytes read says so
 *    in `bytesReadReason`, and the summary's `bytesReadMedian` is null the
 *    moment any run could not.
 * 4. Two results are compared only when they describe the same thing — same
 *    suite, corpus, engine, machine tier, platform, architecture and cache
 *    state — and only when both passed their correctness check and were
 *    reproducible. Anything else is NOT COMPARABLE, never PASS or FAIL.
 * 5. A result read from disk is validated field by field before a number of
 *    it is used; a single run's missing resolution survives the JSON trip.
 * 6. A result that failed its correctness check may carry a zero wall clock:
 *    a governor hold that never ran (no native module) measured nothing, and
 *    zero is the honest count of nothing. A result that claims correctness
 *    with no wall clock is malformed.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MachineRecord } from './machine';
import type { CacheState } from './cache';
import { formatMs, median, resolutionBand, spreadPct } from './stats';

export type SuiteName = 'enumerate' | 'duplicates' | 'neardup' | 'governor';
export const SUITES: readonly SuiteName[] = ['enumerate', 'duplicates', 'neardup', 'governor'];
/** What each suite counts: the enumerate suite files + directories, the others files or images; the governor suite the samples of one hold. */
export type EntriesUnit = 'entries' | 'files' | 'images' | 'samples';
const UNITS: readonly EntriesUnit[] = ['entries', 'files', 'images', 'samples'];
const CACHE_STATES: readonly CacheState[] = ['cold', 'warm', 'mixed', 'unknown'];
const TIERS = ['A', 'B', 'C'] as const;

export interface BenchRun {
  wallMs: number;
  /** What the suite counts (see `BenchResult.entriesUnit`). */
  entries: number;
  /** CPU seconds this process AND its children burned (gdu's shards count). */
  cpuSeconds: number;
  selfCpuSeconds: number;
  /** The children's share of `cpuSeconds`; null where the platform cannot report it. */
  childCpuSeconds: number | null;
  /** The measuring process's peak resident set (its lifetime peak, so a fresh process per run). */
  peakRssBytes: number;
  bytesRead: number | null;
  /** Where `bytesRead` comes from, or why it is null. */
  bytesReadReason: string;
  /** The app's own persistence after a scan (cache and snapshot writes), measured separately. */
  persistMs: number;
  persistCpuSeconds: number;
  /** 1/5/15-minute load at the end of the run; null where the OS has none (Windows). */
  loadAvg: number[] | null;
}

export interface BenchSummary {
  wallMsMedian: number;
  entriesPerSecond: number;
  cpuSecondsPerMillion: number;
  peakRssBytes: number;
  bytesReadMedian: number | null;
  /** (max − min) / median of the wall clocks across runs. The governor suite stores the hold's p95 |error| in percentage points of machine CPU here: its one run is a whole series (see governorSuite.ts). */
  spreadPct: number;
  resolutionPct: number;
  /** True when the runs spread less than 5% — the Phase 1 gate. For the governor suite, true when the hold stayed in its band. */
  reproducible: boolean;
}

export interface BenchResult {
  suite: SuiteName;
  corpus: { name: string; params: unknown; dirs?: number; files?: number; images?: number; scale: string };
  /** A short stable id (`gdu-turbo`, `turbo-walker`, `walker`, `sha256-staged`, `dhash-pairwise`): file names and comparisons key on it. */
  engine: string;
  /** The prose that describes the engine; never part of a file name. */
  engineDescription: string;
  entriesUnit: EntriesUnit;
  machine: MachineRecord;
  cache: { state: CacheState; reason: string };
  runs: BenchRun[];
  summary: BenchSummary;
  correctness: { ok: boolean; notes: string[] };
  recordedAt: string;
  commit: string;
  label: string;
}

export type VerdictKind = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NOT COMPARABLE';

export interface Verdict {
  verdict: VerdictKind;
  deltaPct: number;
  band: number;
  sentence: string;
}

/** The regression gate: slower than this against the baseline fails. */
export const REGRESSION_GATE_PCT = 10;
/** Runs must spread less than this to count as reproducible. */
export const REPRODUCIBLE_SPREAD_PCT = 5;

export function summarize(runs: BenchRun[]): BenchSummary {
  if (runs.length === 0) throw new Error('summarize: no runs');
  const walls = runs.map((r) => r.wallMs);
  const wallMsMedian = median(walls);
  const entries = median(runs.map((r) => r.entries));
  if (!(wallMsMedian > 0) || !(entries > 0)) {
    throw new Error(`summarize: a wall clock of ${wallMsMedian} ms over ${entries} entries is not a measurement`);
  }
  const cpu = median(runs.map((r) => r.cpuSeconds));
  const reads = runs.map((r) => r.bytesRead);
  // One run has no spread and no resolution: it is a number, not a measurement.
  const spread = runs.length < 2 ? Number.POSITIVE_INFINITY : spreadPct(walls);
  return {
    wallMsMedian,
    entriesPerSecond: entries / (wallMsMedian / 1000),
    cpuSecondsPerMillion: (cpu / entries) * 1_000_000,
    peakRssBytes: Math.max(...runs.map((r) => r.peakRssBytes)),
    bytesReadMedian: reads.every((b): b is number => b !== null) ? median(reads) : null,
    spreadPct: spread,
    resolutionPct: resolutionBand(walls),
    reproducible: spread < REPRODUCIBLE_SPREAD_PCT,
  };
}

/** The fields two results must share before their wall clocks mean the same thing. */
function comparabilityDifferences(current: BenchResult, baseline: BenchResult): string[] {
  const out: string[] = [];
  const same = (label: string, a: unknown, b: unknown): void => {
    if (a !== b) out.push(`${label} (${String(a)} vs ${String(b)})`);
  };
  same('suite', current.suite, baseline.suite);
  same('corpus', current.corpus.name, baseline.corpus.name);
  same('corpus parameters', JSON.stringify(current.corpus.params), JSON.stringify(baseline.corpus.params));
  same('engine', current.engine, baseline.engine);
  same('unit', current.entriesUnit, baseline.entriesUnit);
  same('machine tier', current.machine.tier, baseline.machine.tier);
  same('platform', current.machine.platform, baseline.machine.platform);
  same('architecture', current.machine.arch, baseline.machine.arch);
  same('cache state', current.cache.state, baseline.cache.state);
  return out;
}

function unusable(result: BenchResult, which: string): string | null {
  if (!result.correctness.ok) return `${which} failed its correctness check, so it measured nothing`;
  if (!result.summary.reproducible) {
    const spread = Number.isFinite(result.summary.spreadPct) ? `${result.summary.spreadPct.toFixed(1)}%` : 'a single run';
    return `${which} is not reproducible (${spread} against the ${REPRODUCIBLE_SPREAD_PCT}% rule)`;
  }
  return null;
}

export function compareToBaseline(current: BenchResult, baseline: BenchResult): Verdict {
  const base = baseline.summary.wallMsMedian;
  const cur = current.summary.wallMsMedian;
  const deltaPct = ((cur - base) / base) * 100;
  const times = `${formatMs(base)} → ${formatMs(cur)}`;
  const differences = comparabilityDifferences(current, baseline);
  if (differences.length > 0) {
    return { verdict: 'NOT COMPARABLE', deltaPct, band: Number.NaN, sentence: `the two results differ in ${differences.join('; ')}, so their wall clocks measure different things` };
  }
  const blocker = unusable(current, 'the current result') ?? unusable(baseline, 'the baseline');
  if (blocker) return { verdict: 'NOT COMPARABLE', deltaPct, band: Number.NaN, sentence: blocker };
  const a = current.summary.resolutionPct;
  const b = baseline.summary.resolutionPct;
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    const which = Number.isFinite(a) ? 'the baseline' : 'the current result';
    return {
      verdict: 'INCONCLUSIVE',
      deltaPct,
      band: Number.POSITIVE_INFINITY,
      sentence: `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}% (${times}), but ${which} has too few runs for a resolution (a single run has no resolution; take at least three)`,
    };
  }
  // Two medians each resolved to ±a and ±b differ by noise up to √(a²+b²).
  const band = Math.sqrt(a * a + b * b);
  if (Math.abs(deltaPct) <= band) {
    return {
      verdict: 'INCONCLUSIVE',
      deltaPct,
      band,
      sentence: `${Math.abs(deltaPct).toFixed(1)}% ${deltaPct >= 0 ? 'slower' : 'faster'} (${times}), inside the ${band.toFixed(1)}% combined resolution of the two measurements — inconclusive; raise --runs to tighten it`,
    };
  }
  if (deltaPct > Math.max(REGRESSION_GATE_PCT, band)) {
    return { verdict: 'FAIL', deltaPct, band, sentence: `${deltaPct.toFixed(1)}% slower than the baseline (${times}), beyond the ${REGRESSION_GATE_PCT}% gate` };
  }
  if (deltaPct > 0) {
    return { verdict: 'PASS', deltaPct, band, sentence: `${deltaPct.toFixed(1)}% slower than the baseline (${times}), within the ${REGRESSION_GATE_PCT}% gate` };
  }
  return { verdict: 'PASS', deltaPct, band, sentence: `${Math.abs(deltaPct).toFixed(1)}% faster than the baseline (${times})` };
}

const fmtBytes = (n: number | null): string => {
  if (n === null) return 'n/a';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};
const fmtCount = (n: number): string => Math.round(n).toLocaleString('en-US');

/** The spread column: across runs for the scan suites; for the governor, the hold's own p95 |error| in points of machine CPU (bench/README.md, "The governor row"). */
function spreadCell(r: BenchResult): string {
  if (r.suite === 'governor') {
    if (!(r.summary.wallMsMedian > 0)) return 'n/a (no hold)';
    return `±${r.summary.spreadPct.toFixed(1)} pt p95${r.summary.reproducible ? '' : ' (outside the band)'}`;
  }
  if (r.runs.length < 2) return `n/a (${r.runs.length} run)`;
  return `±${r.summary.spreadPct.toFixed(1)}%${r.summary.reproducible ? '' : ` (>${REPRODUCIBLE_SPREAD_PCT}%)`}`;
}

export function printTable(results: BenchResult[]): string {
  const header = ['suite', 'corpus', 'engine', 'cache', 'rate', 'wall (median)', 'spread', 'CPU s/M', 'peak RSS', 'bytes read', 'load', 'correct'];
  const rows = results.map((r) => {
    // A zero wall clock is a result that measured nothing (a hold that never ran): its rate and clock are n/a, not 0.
    const measured = r.summary.wallMsMedian > 0;
    return [
      r.suite,
      r.corpus.name,
      r.engine,
      r.cache.state,
      measured ? `${fmtCount(r.summary.entriesPerSecond)} ${r.entriesUnit}/s` : 'n/a',
      measured ? formatMs(r.summary.wallMsMedian) : 'n/a',
      spreadCell(r),
      measured ? r.summary.cpuSecondsPerMillion.toFixed(2) : 'n/a',
      fmtBytes(r.summary.peakRssBytes),
      fmtBytes(r.summary.bytesReadMedian),
      r.runs.map((x) => (x.loadAvg === null ? 'n/a' : (x.loadAvg[0] ?? 0).toFixed(1))).join('/'),
      r.correctness.ok ? 'ok' : 'FAIL',
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(header), widths.map((w) => '─'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

/** A file-name-safe spelling of an engine or corpus id. */
export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function resultFileName(r: BenchResult): string {
  const stamp = r.recordedAt.replace(/[:.]/g, '-');
  return `${r.suite}-${slug(r.engine)}-${slug(r.corpus.name)}-${stamp}.json`;
}

/** Baselines are keyed on everything a comparison requires to match. */
export function baselineFileName(r: BenchResult): string {
  return `${r.suite}-${slug(r.engine)}-${slug(r.corpus.name)}-${slug(r.machine.platform)}-${slug(r.machine.arch)}-tier${r.machine.tier}.json`;
}

export function writeResult(r: BenchResult, dir: string, fileName = resultFileName(r)): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, JSON.stringify(r, null, 2) + '\n');
  return file;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNumberOrNull = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v));

/** Field-by-field: every number a comparison or a table reads must exist and be a finite number of the right sign. */
export function isBenchResult(value: unknown): value is BenchResult {
  if (!isRecord(value)) return false;
  const v = value;
  if (!(SUITES as readonly unknown[]).includes(v.suite)) return false;
  if (!isRecord(v.corpus) || typeof v.corpus.name !== 'string') return false;
  if (typeof v.engine !== 'string' || typeof v.engineDescription !== 'string') return false;
  if (!(UNITS as readonly unknown[]).includes(v.entriesUnit)) return false;
  if (!isRecord(v.machine) || !(TIERS as readonly unknown[]).includes(v.machine.tier) || typeof v.machine.platform !== 'string' || typeof v.machine.arch !== 'string') return false;
  if (!isRecord(v.cache) || !(CACHE_STATES as readonly unknown[]).includes(v.cache.state) || typeof v.cache.reason !== 'string') return false;
  if (!Array.isArray(v.runs) || v.runs.length === 0 || !v.runs.every((r) => isRecord(r) && typeof r.wallMs === 'number' && Number.isFinite(r.wallMs))) return false;
  if (!isRecord(v.correctness) || typeof v.correctness.ok !== 'boolean' || !Array.isArray(v.correctness.notes)) return false;
  if (!isRecord(v.summary)) return false;
  const s = v.summary;
  if (typeof s.wallMsMedian !== 'number' || !Number.isFinite(s.wallMsMedian) || s.wallMsMedian < 0) return false;
  // Rule 6: a zero wall clock is admitted only on a result that failed its correctness check.
  if (s.wallMsMedian === 0 && v.correctness.ok) return false;
  if (typeof s.entriesPerSecond !== 'number' || !Number.isFinite(s.entriesPerSecond) || s.entriesPerSecond < 0) return false;
  if (!isNumberOrNull(s.spreadPct) || !isNumberOrNull(s.resolutionPct) || typeof s.reproducible !== 'boolean') return false;
  if (typeof v.recordedAt !== 'string' || typeof v.commit !== 'string' || typeof v.label !== 'string') return false;
  return true;
}

export function readResult(file: string): BenchResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err: unknown) {
    throw new Error(`${file} is not a bench result: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isBenchResult(parsed)) throw new Error(`${file} is not a bench result (a field a comparison needs is missing or malformed)`);
  // JSON has no Infinity: a summary written from too few runs comes back with
  // nulls, and null must not read as "perfectly resolved".
  const summary: BenchSummary = {
    ...parsed.summary,
    spreadPct: parsed.summary.spreadPct === null ? Number.POSITIVE_INFINITY : parsed.summary.spreadPct,
    resolutionPct: parsed.summary.resolutionPct === null ? Number.POSITIVE_INFINITY : parsed.summary.resolutionPct,
  };
  summary.reproducible = summary.reproducible && Number.isFinite(summary.spreadPct);
  return { ...parsed, summary };
}
