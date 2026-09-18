/**
 * The result record every bench suite produces, and the arithmetic that turns
 * runs into a verdict.
 *
 * Three rules, each borrowed from `scripts/bench-v4.ts` because each exists
 * for a reason that has already cost this project a wrong number:
 *
 * 1. A figure carries the load it was taken under, and the cache state.
 * 2. A difference smaller than the measurement's own resolution is not a
 *    result; it prints INCONCLUSIVE with the band stated.
 * 3. Nothing here estimates. A run that could not measure bytes read says so
 *    in `bytesReadReason`, and the summary's `bytesReadMedian` is null the
 *    moment any run could not.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MachineRecord } from './machine';
import { median, resolutionBand, spreadPct } from './stats';

export interface BenchRun {
  wallMs: number;
  /** Files + directories the engine reported (root included). */
  entries: number;
  cpuSeconds: number;
  /** CPU of child processes (gdu shards), when the platform reports it. */
  childCpuSeconds: number | null;
  peakRssBytes: number;
  bytesRead: number | null;
  loadAvg: number[];
}

export interface BenchSummary {
  wallMsMedian: number;
  entriesPerSecond: number;
  cpuSecondsPerMillion: number;
  peakRssBytes: number;
  bytesReadMedian: number | null;
  spreadPct: number;
  resolutionPct: number;
  /** True when the runs spread less than 5% — the Phase 1 gate. */
  reproducible: boolean;
}

export interface BenchResult {
  suite: 'enumerate' | 'duplicates' | 'neardup';
  corpus: { name: string; params: unknown; dirs?: number; files?: number; images?: number; scale: string };
  engine: string;
  machine: MachineRecord;
  cache: { state: 'cold' | 'warm' | 'mixed' | 'unknown'; reason: string };
  runs: BenchRun[];
  summary: BenchSummary;
  correctness: { ok: boolean; notes: string[] };
  recordedAt: string;
  commit: string;
  label: string;
}

export interface Verdict {
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
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
  const cpu = median(runs.map((r) => r.cpuSeconds));
  const reads = runs.map((r) => r.bytesRead);
  // One run has no spread and no resolution: it is a number, not a measurement.
  const spread = runs.length < 2 ? Number.POSITIVE_INFINITY : spreadPct(walls);
  return {
    wallMsMedian,
    entriesPerSecond: wallMsMedian > 0 ? entries / (wallMsMedian / 1000) : 0,
    cpuSecondsPerMillion: entries > 0 ? (cpu / entries) * 1_000_000 : 0,
    peakRssBytes: Math.max(...runs.map((r) => r.peakRssBytes)),
    bytesReadMedian: reads.every((b): b is number => b !== null) ? median(reads) : null,
    spreadPct: spread,
    resolutionPct: runs.length < 2 ? Number.POSITIVE_INFINITY : resolutionBand(walls),
    reproducible: spread < REPRODUCIBLE_SPREAD_PCT,
  };
}

export function compareToBaseline(current: BenchResult, baseline: BenchResult): Verdict {
  const base = baseline.summary.wallMsMedian;
  const cur = current.summary.wallMsMedian;
  const deltaPct = base > 0 ? ((cur - base) / base) * 100 : 0;
  const band = Math.max(current.summary.resolutionPct, baseline.summary.resolutionPct);
  const times = `${base.toFixed(1)} ms → ${cur.toFixed(1)} ms`;
  if (!Number.isFinite(band)) {
    const which = Number.isFinite(current.summary.resolutionPct) ? 'the baseline' : 'the current result';
    return {
      verdict: 'INCONCLUSIVE',
      deltaPct,
      band,
      sentence: `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}% (${times}), but ${which} is a single run and has no resolution; take at least three runs before comparing`,
    };
  }
  if (Math.abs(deltaPct) <= band) {
    return {
      verdict: 'INCONCLUSIVE',
      deltaPct,
      band,
      sentence: `${Math.abs(deltaPct).toFixed(1)}% ${deltaPct >= 0 ? 'slower' : 'faster'} (${times}), inside the ${band.toFixed(1)}% resolution of the measurement — inconclusive; raise --runs to tighten it`,
    };
  }
  if (deltaPct > Math.max(REGRESSION_GATE_PCT, band)) {
    return {
      verdict: 'FAIL',
      deltaPct,
      band,
      sentence: `${deltaPct.toFixed(1)}% slower than the baseline (${times}), beyond the ${REGRESSION_GATE_PCT}% gate`,
    };
  }
  if (deltaPct > 0) {
    return {
      verdict: 'PASS',
      deltaPct,
      band,
      sentence: `${deltaPct.toFixed(1)}% slower than the baseline (${times}), within the ${REGRESSION_GATE_PCT}% gate`,
    };
  }
  return {
    verdict: 'PASS',
    deltaPct,
    band,
    sentence: `${Math.abs(deltaPct).toFixed(1)}% faster than the baseline (${times})`,
  };
}

const fmtBytes = (n: number | null): string => {
  if (n === null) return 'n/a';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};
const fmtCount = (n: number): string => Math.round(n).toLocaleString('en-US');

export function printTable(results: BenchResult[]): string {
  const header = ['suite', 'corpus', 'engine', 'cache', 'entries/s', 'wall (median)', 'spread', 'CPU s/M', 'peak RSS', 'bytes read', 'load', 'correct'];
  const rows = results.map((r) => [
    r.suite,
    r.corpus.name,
    r.engine,
    r.cache.state,
    fmtCount(r.summary.entriesPerSecond),
    `${r.summary.wallMsMedian.toFixed(1)} ms`,
    r.runs.length < 2 ? 'n/a (1 run)' : `±${r.summary.spreadPct.toFixed(1)}%${r.summary.reproducible ? '' : ' (>5%)'}`,
    r.summary.cpuSecondsPerMillion.toFixed(2),
    fmtBytes(r.summary.peakRssBytes),
    fmtBytes(r.summary.bytesReadMedian),
    r.runs.map((x) => (x.loadAvg[0] ?? 0).toFixed(1)).join('/'),
    r.correctness.ok ? 'ok' : 'FAIL',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(header), widths.map((w) => '─'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

export function resultFileName(r: BenchResult): string {
  const stamp = r.recordedAt.replace(/[:.]/g, '-');
  return `${r.suite}-${r.engine}-${r.corpus.name}-${stamp}.json`;
}

export function writeResult(r: BenchResult, dir: string, fileName = resultFileName(r)): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, JSON.stringify(r, null, 2) + '\n');
  return file;
}

export function readResult(file: string): BenchResult {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !('summary' in parsed) || !('runs' in parsed)) {
    throw new Error(`${file} is not a bench result`);
  }
  const result = parsed as BenchResult;
  // JSON has no Infinity: a summary written from a single run comes back with
  // nulls, and null must not read as "perfectly resolved".
  const s = result.summary as unknown as Record<string, unknown>;
  for (const key of ['spreadPct', 'resolutionPct']) {
    if (s[key] === null || s[key] === undefined) s[key] = Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(result.summary.spreadPct)) result.summary.reproducible = false;
  return result;
}
