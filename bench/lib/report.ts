/**
 * The result record every bench suite produces, and the arithmetic that turns
 * runs into a verdict.
 *
 * Rules, each borrowed from `scripts/bench-v4.ts` or learned from a review
 * that made this harness print a wrong number:
 *
 * 1. A figure carries the load it was taken under, the cache state and the
 *    budget.
 * 2. A difference smaller than the measurement's own resolution is not a
 *    result; it prints INCONCLUSIVE with the band stated. The band of a
 *    comparison combines both measurements' bands.
 * 3. Nothing here estimates: a run that could not measure bytes read says so
 *    in `bytesReadReason`, and the summary's `bytesReadMedian` is null the
 *    moment any run could not.
 * 4. Two results are compared only when they describe the same thing — same
 *    suite, corpus, engine, machine tier, platform, architecture, cache
 *    state, budget, and the duplicate suite's `--min-size` or the
 *    near-duplicate suite's `--threshold` — and only when both passed their correctness check,
 *    were reproducible and ran under the budget they name. Anything else is
 *    NOT COMPARABLE, never PASS or FAIL.
 * 5. A result read from disk is validated field by field before a number of
 *    it is used; a single run's missing resolution survives the JSON trip.
 * 6. A result that failed its correctness check may carry a zero wall clock:
 *    a governor hold that never ran (no native module) measured nothing, and
 *    zero is the honest count of nothing. A result that claims correctness
 *    with no wall clock is malformed.
 * 7. The budget a run ran under is the product's own record of it (the
 *    scan's `budget.effective`), never the request copied. A result written
 *    before the governor existed has no budget and reads as exactly that; it
 *    is not rewritten, and it compares only with another like it.
 * 8. A result says where its entries came from (`source`). A synthetic
 *    listing (tm-walk's `SyntheticLister`, Phase 4 P4-8) reads no disk, so its
 *    wall clock is not a file-system throughput: it is labelled `synthetic`
 *    in every report and never compared with a file-system run. A result
 *    without the field was written before it existed, and every such result
 *    listed a file system.
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

/** The three presets a scan can be asked to run under: the app's own (src/services/engineBudget.ts). */
export type ScanPreset = 'eco' | 'balanced' | 'turbo';
export const SCAN_PRESETS: readonly ScanPreset[] = ['eco', 'balanced', 'turbo'];
/** What a series asked the budget for: a preset, or `auto` — the app's own default, which the suites that name no preset run under. */
export type RequestedBudget = ScanPreset | 'auto';
export const REQUESTED_BUDGETS: readonly RequestedBudget[] = [...SCAN_PRESETS, 'auto'];

/**
 * The budget a series ran under. `requested` is what the harness asked for;
 * `effective` holds, per measured run and in order, the preset that run's
 * scan recorded for itself — `ScanResult.budget.effective`, which the stats
 * route serves as `budget` — the product's word, never recomputed here.
 */
export interface BenchBudget {
  requested: RequestedBudget;
  effective: string[];
}

/** Where a result's entries came from: a file system an engine listed, or a synthetic listing that reads no disk (rule 8). */
export type BenchSource = 'file-system' | 'synthetic';
export const SOURCES: readonly BenchSource[] = ['file-system', 'synthetic'];

/** The effective preset of a run that measured nothing (a governor hold that never ran). */
export const NO_BUDGET = 'none';
/** How a result written before the governor existed — every Phase 1 baseline — reads wherever a budget is expected. */
export const PRE_GOVERNOR_BUDGET = 'none (recorded before the governor)';

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
  /** The budget every run scanned under. Every suite records it; `StoredResult` is the shape of the files written before it existed. */
  budget: BenchBudget;
  runs: BenchRun[];
  summary: BenchSummary;
  correctness: { ok: boolean; notes: string[] };
  recordedAt: string;
  commit: string;
  label: string;
  /** The duplicate suite's `--min-size` in bytes — which files are hashed at all. Absent on the other suites and on results written before it was recorded. */
  minSize?: number;
  /** The near-duplicate suite's `--threshold` — which pairs join a cluster. Absent on the other suites and on results written before it was recorded. */
  threshold?: number;
  /** Where the entries came from (rule 8). Absent on results written before it was recorded, which read as `file-system` (`sourceOf`). */
  source?: BenchSource;
}

/**
 * A result as a file holds it. One written before the governor existed —
 * every Phase 1 baseline — has no budget: it reads as PRE_GOVERNOR_BUDGET, so
 * it compares only with another like it, and nothing here rewrites it.
 */
export type StoredResult = Omit<BenchResult, 'budget'> & { budget?: BenchBudget };

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

/**
 * Why the product may move each budget — its own rules (tm-governor's preset
 * table; Automatic in src/services/engineBudget.ts), stated beside a moved
 * series, never offered as the diagnosis of one.
 */
const WHY_A_BUDGET_MOVES: Readonly<Record<RequestedBudget, string>> = {
  eco: 'the governor scales Eco and Balanced back while someone is using the computer, and any preset under thermal pressure',
  balanced: 'the governor scales Eco and Balanced back while someone is using the computer, and any preset under thermal pressure',
  turbo: 'the governor never scales Turbo back for interaction, only under thermal pressure',
  auto: 'Automatic is Balanced, and Eco on battery or under serious heat',
};

/** "a", "a and b", "a, b and c". */
function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "run 2", "runs 1 and 3". */
const runList = (runs: number[]): string => `${runs.length === 1 ? 'run' : 'runs'} ${joinAnd(runs.map(String))}`;

/**
 * Why a series' runs did not all run under the budget it names (for
 * Automatic, under one budget), with the runs and presets named — or null
 * when they did. A run that measured nothing ran under no budget, which is
 * not a move; a result written before the governor has nothing to judge.
 */
export function budgetMoved(budget: BenchBudget | undefined): string | null {
  if (!budget) return null;
  const runsByPreset = new Map<string, number[]>();
  budget.effective.forEach((preset, i) => {
    if (preset !== NO_BUDGET) runsByPreset.set(preset, [...(runsByPreset.get(preset) ?? []), i + 1]);
  });
  const why = WHY_A_BUDGET_MOVES[budget.requested];
  if (budget.requested === 'auto') {
    if (runsByPreset.size <= 1) return null;
    const parts = [...runsByPreset].map(([preset, runs]) => `${preset} in ${runList(runs)}`);
    return `the app's default (Automatic) ran under ${joinAnd(parts)} (${why}); the series measured more than one budget`;
  }
  const moved = [...runsByPreset].filter(([preset]) => preset !== budget.requested);
  if (moved.length === 0) return null;
  const parts = moved.map(([preset, runs], i) => `${runList(runs)}${i === 0 ? ' ran' : ''} under ${preset}`);
  return `${budget.requested} was requested but ${joinAnd(parts)} (${why}); the series does not measure the budget it names`;
}

/** The budget line printed under a result: what was asked for, what each run ran under, and whether that moved. */
export function describeBudget(r: StoredResult): string {
  if (!r.budget) return PRE_GOVERNOR_BUDGET;
  const moved = budgetMoved(r.budget);
  return `${r.budget.requested} requested, ran under ${r.budget.effective.join('/')}${moved ? ` — moved: ${moved}` : ''}`;
}

/** The budget as a comparison's condition: the preset asked for, or the word for a result from before the governor. */
const budgetCondition = (r: StoredResult): string => r.budget?.requested ?? PRE_GOVERNOR_BUDGET;

/** Where a result's entries came from; a result written before the field listed a file system (rule 8). */
export const sourceOf = (r: StoredResult): BenchSource => r.source ?? 'file-system';

/** How a suite option reads as a condition when the result does not carry it (another suite, or written before it was recorded). */
export const OPTION_NOT_RECORDED = 'not recorded';
const optionCondition = (value: number | undefined): string => (value === undefined ? OPTION_NOT_RECORDED : String(value));

/** The fields two results must share before their wall clocks mean the same thing. */
function comparabilityDifferences(current: StoredResult, baseline: StoredResult): string[] {
  const out: string[] = [];
  const same = (label: string, a: unknown, b: unknown): void => {
    if (a !== b) out.push(`${label} (${String(a)} vs ${String(b)})`);
  };
  same('suite', current.suite, baseline.suite);
  same('source', sourceOf(current), sourceOf(baseline));
  same('corpus', current.corpus.name, baseline.corpus.name);
  same('corpus parameters', JSON.stringify(current.corpus.params), JSON.stringify(baseline.corpus.params));
  same('engine', current.engine, baseline.engine);
  same('unit', current.entriesUnit, baseline.entriesUnit);
  same('machine tier', current.machine.tier, baseline.machine.tier);
  same('platform', current.machine.platform, baseline.machine.platform);
  same('architecture', current.machine.arch, baseline.machine.arch);
  same('cache state', current.cache.state, baseline.cache.state);
  same('budget', budgetCondition(current), budgetCondition(baseline));
  same('--min-size', optionCondition(current.minSize), optionCondition(baseline.minSize));
  same('--threshold', optionCondition(current.threshold), optionCondition(baseline.threshold));
  return out;
}

/**
 * Why `--record` refuses to make this result a baseline, or null when it may:
 * a baseline is the referent every later claim cites, so it must have passed
 * its correctness check, be reproducible, have run under the budget it names,
 * and name the code it measured.
 */
export function recordRefusal(r: BenchResult): string | null {
  if (!r.correctness.ok) return 'it failed its correctness check';
  if (!r.summary.reproducible) {
    return `its runs spread ${Number.isFinite(r.summary.spreadPct) ? `${r.summary.spreadPct.toFixed(1)}%` : 'over a single run'} (the rule is under ${REPRODUCIBLE_SPREAD_PCT}%)`;
  }
  const moved = budgetMoved(r.budget);
  if (moved) return `its budget moved: ${moved}`;
  if (r.machine.dirty) {
    return r.machine.dirtyReason === undefined
      ? 'the working tree had uncommitted changes, so the commit it cites is not the code measured'
      : `git could not say whether the working tree was clean (${r.machine.dirtyReason}), so the commit it cites may not be the code measured`;
  }
  return null;
}

function unusable(result: StoredResult, which: string): string | null {
  if (!result.correctness.ok) return `${which} failed its correctness check, so it measured nothing`;
  if (!result.summary.reproducible) {
    const spread = Number.isFinite(result.summary.spreadPct) ? `${result.summary.spreadPct.toFixed(1)}%` : 'a single run';
    return `${which} is not reproducible (${spread} against the ${REPRODUCIBLE_SPREAD_PCT}% rule)`;
  }
  const moved = budgetMoved(result.budget);
  if (moved) return `${which}'s budget moved: ${moved}`;
  return null;
}

export function compareToBaseline(current: StoredResult, baseline: StoredResult): Verdict {
  const base = baseline.summary.wallMsMedian;
  const cur = current.summary.wallMsMedian;
  const deltaPct = ((cur - base) / base) * 100;
  const times = `${formatMs(base)} → ${formatMs(cur)}`;
  if (sourceOf(current) !== sourceOf(baseline)) {
    const which = sourceOf(current) === 'synthetic' ? 'the current result' : 'the baseline';
    return { verdict: 'NOT COMPARABLE', deltaPct, band: Number.NaN, sentence: `${which} is a synthetic listing, which reads no disk, so its wall clock is not a file-system throughput and is never compared with a file-system run` };
  }
  const differences = comparabilityDifferences(current, baseline);
  if (differences.length > 0) {
    return { verdict: 'NOT COMPARABLE', deltaPct, band: Number.NaN, sentence: `the two results differ in ${differences.join('; ')}, so their wall clocks measure different things` };
  }
  const blocker = unusable(current, 'the current result') ?? unusable(baseline, 'the baseline');
  if (blocker) return { verdict: 'NOT COMPARABLE', deltaPct, band: Number.NaN, sentence: blocker };
  const a = current.summary.resolutionPct;
  const b = baseline.summary.resolutionPct;
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    // A single run was refused above as not reproducible, so a side named
    // here has two: say so, rather than blame a single run, and name both
    // sides when neither resolves.
    const runs = (r: StoredResult): string => `${r.runs.length} run${r.runs.length === 1 ? '' : 's'}`;
    const short = !Number.isFinite(a) && !Number.isFinite(b)
      ? `the current result has ${runs(current)} and the baseline ${baseline.runs.length}`
      : Number.isFinite(a)
        ? `the baseline has ${runs(baseline)}`
        : `the current result has ${runs(current)}`;
    return {
      verdict: 'INCONCLUSIVE',
      deltaPct,
      band: Number.POSITIVE_INFINITY,
      sentence: `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}% (${times}), but ${short}, too few for a resolution (it takes at least three)`,
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
function spreadCell(r: StoredResult): string {
  if (r.suite === 'governor') {
    if (!(r.summary.wallMsMedian > 0)) return 'n/a (no hold)';
    return `±${r.summary.spreadPct.toFixed(1)} pt p95${r.summary.reproducible ? '' : ' (outside the band)'}`;
  }
  if (r.runs.length < 2) return `n/a (${r.runs.length} run)`;
  return `±${r.summary.spreadPct.toFixed(1)}%${r.summary.reproducible ? '' : ` (>${REPRODUCIBLE_SPREAD_PCT}%)`}`;
}

/** The budget column: the preset asked for, then what each run ran under, one per run as the load column has them; `(moved)` when they differ. */
function budgetCell(r: StoredResult): string {
  if (!r.budget) return PRE_GOVERNOR_BUDGET;
  return `${r.budget.requested}: ${r.budget.effective.join('/')}${budgetMoved(r.budget) ? ' (moved)' : ''}`;
}

export function printTable(results: readonly StoredResult[]): string {
  const header = ['suite', 'corpus', 'engine', 'cache', 'budget', 'rate', 'wall (median)', 'spread', 'CPU s/M', 'peak RSS', 'bytes read', 'load', 'correct'];
  const rows = results.map((r) => {
    // A zero wall clock is a result that measured nothing (a hold that never ran): its rate and clock are n/a, not 0.
    const measured = r.summary.wallMsMedian > 0;
    return [
      r.suite,
      sourceOf(r) === 'synthetic' ? `${r.corpus.name} (synthetic)` : r.corpus.name,
      r.engine,
      r.cache.state,
      budgetCell(r),
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

export function resultFileName(r: StoredResult): string {
  const stamp = r.recordedAt.replace(/[:.]/g, '-');
  return `${r.suite}-${slug(r.engine)}-${slug(r.corpus.name)}-${stamp}.json`;
}

/**
 * A baseline's file is keyed on the suite, engine, corpus, platform,
 * architecture and tier, and — on every result that names one — the budget
 * asked for, which is what a comparison keys on: `…-tierB-budget-turbo.json`,
 * or `…-budget-auto.json` for the app's default.
 * A result from before the governor has no budget and keeps the name it was
 * committed under (`…-tierB.json`). A tier is one capital letter and a
 * budgeted name ends in a lowercase word, so neither can ever be the other's
 * name: a recording under a budget never replaces a baseline from before it.
 * `budget-` spells out which field the word is, because engine ids carry
 * `turbo` too (`gdu-turbo`, `turbo-walker`).
 *
 * The name does not carry every condition a comparison keys on — not the
 * cache state, the corpus parameters, `--min-size` or `--threshold`, and a
 * slug folds case — so two differently measured results can share a name.
 * Adding the cache state would move every budgeted baseline already
 * committed; `recordBaseline` refuses to replace a baseline measured under
 * another condition instead.
 */
export function baselineFileName(r: StoredResult): string {
  const stem = `${r.suite}-${slug(r.engine)}-${slug(r.corpus.name)}-${slug(r.machine.platform)}-${slug(r.machine.arch)}-tier${r.machine.tier}`;
  return r.budget ? `${stem}-budget-${slug(r.budget.requested)}.json` : `${stem}.json`;
}

export function writeResult(r: StoredResult, dir: string, fileName = resultFileName(r)): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, JSON.stringify(r, null, 2) + '\n');
  return file;
}

/** Why `recordBaseline` would not replace the baseline already under the name; the message is the sentence printed. */
export class BaselineConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineConflictError';
  }
}

/**
 * Why the file under this result's baseline name must not be replaced by it,
 * or null when it may: a baseline measured under any condition a comparison
 * keys on other than this result's would silently change what every later
 * comparison against it measures, and a file this harness cannot read is not
 * replaced unseen.
 */
function baselineConflict(r: StoredResult, file: string): string | null {
  if (!fs.existsSync(file)) return null;
  let recorded: StoredResult;
  try {
    recorded = readResult(file);
  } catch (err: unknown) {
    return `refusing to replace a baseline this harness cannot read: ${err instanceof Error ? err.message : String(err)}; move it aside first if it is meant to go`;
  }
  const differences = comparabilityDifferences(r, recorded);
  if (differences.length === 0) return null;
  return `refusing to replace ${file}: this result and the baseline recorded there differ in ${differences.join('; ')} (this result's first), so the replacement would silently change what every comparison against it measures; move the old baseline aside first if that change is meant`;
}

/**
 * `--record`'s one write: the result under its baseline name in `dir`
 * (bench/baselines/ from the CLI). Returns the file written. Throws
 * `BaselineConflictError` rather than replace a baseline measured under
 * another condition; the same conditions re-measured replace it.
 */
export function recordBaseline(r: StoredResult, dir: string): string {
  const fileName = baselineFileName(r);
  const conflict = baselineConflict(r, path.join(dir, fileName));
  if (conflict !== null) throw new BaselineConflictError(conflict);
  return writeResult(r, dir, fileName);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNumberOrNull = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v));
/** A suite option is absent, or a whole number no smaller than zero. */
const isOptionalCount = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 0);

/** Field-by-field: every number a comparison or a table reads must exist and be a finite number of the right sign. */
export function isBenchResult(value: unknown): value is StoredResult {
  if (!isRecord(value)) return false;
  const v = value;
  if (!(SUITES as readonly unknown[]).includes(v.suite)) return false;
  if (!isRecord(v.corpus) || typeof v.corpus.name !== 'string') return false;
  if (typeof v.engine !== 'string' || typeof v.engineDescription !== 'string') return false;
  if (!(UNITS as readonly unknown[]).includes(v.entriesUnit)) return false;
  if (!isRecord(v.machine) || !(TIERS as readonly unknown[]).includes(v.machine.tier) || typeof v.machine.platform !== 'string' || typeof v.machine.arch !== 'string') return false;
  if (!isRecord(v.cache) || !(CACHE_STATES as readonly unknown[]).includes(v.cache.state) || typeof v.cache.reason !== 'string') return false;
  if (!Array.isArray(v.runs) || v.runs.length === 0 || !v.runs.every((r) => isRecord(r) && typeof r.wallMs === 'number' && Number.isFinite(r.wallMs))) return false;
  // Rule 7: no budget is a result from before the governor; a budget names a known request and one preset per run.
  if (v.budget !== undefined) {
    const b = v.budget;
    if (!isRecord(b) || !(REQUESTED_BUDGETS as readonly unknown[]).includes(b.requested)) return false;
    if (!Array.isArray(b.effective) || b.effective.length !== v.runs.length || !b.effective.every((p) => typeof p === 'string')) return false;
  }
  if (!isRecord(v.correctness) || typeof v.correctness.ok !== 'boolean' || !Array.isArray(v.correctness.notes)) return false;
  if (!isOptionalCount(v.minSize) || !isOptionalCount(v.threshold)) return false;
  // Rule 8: no source is a result from before the field; a source is one the harness knows.
  if (v.source !== undefined && !(SOURCES as readonly unknown[]).includes(v.source)) return false;
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

export function readResult(file: string): StoredResult {
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

/** What `--record` did: the baseline it wrote, or why it wrote none. */
export type RecordOutcome = { recorded: string } | { refused: string };

/**
 * `--record`, whole: the result written as its baseline in `dir`, or the
 * reason it may not be one (`recordRefusal`), or the conflict that keeps it
 * from replacing a baseline measured under another condition. Any other
 * failure throws: it is not a refusal, and must not print as one.
 */
export function recordOrRefuse(r: BenchResult, dir: string): RecordOutcome {
  const refusal = recordRefusal(r);
  if (refusal) return { refused: refusal };
  try {
    return { recorded: recordBaseline(r, dir) };
  } catch (err: unknown) {
    if (err instanceof BaselineConflictError) return { refused: err.message };
    throw err;
  }
}
