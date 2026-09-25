/**
 * The three suites. Each measured pass runs the REAL engines — `startScan`,
 * the duplicate job, the near-duplicate job — in a child process started
 * from `measureWorker.ts`, with an isolated data directory and the engine
 * gate set in that child's environment. This process only orchestrates,
 * labels and checks; it never imports a service, so nothing it does can leak
 * into a number.
 *
 * Refusals, never guesses: a requested engine the scan did not run on, a
 * requested budget the scan did not record, a cold series whose purge failed,
 * a job that errored — each is an error or a downgraded label with the
 * reason, never a silently different number.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { FindOptions } from '../../src/services/gduScanner';
import type { ScanBudget } from '../../src/models/types';
import { cacheState, defaultPurge, type CacheVerdict, type PurgeProcedure, type PurgeResult, type RequestedCache } from './cache';
import type { CorpusManifest, SyntheticManifest } from './corpus';
import { scoreClusters, type ImageManifest } from './images';
import { describeMachine, type MachineRecord } from './machine';
import type { EngineChoice, WorkerJob, WorkerResult, WorkerSuccess } from './measureWorker';
import { summarize, type BenchBudget, type BenchResult, type BenchRun, type BenchSource, type EntriesUnit, type RequestedBudget, type ScanPreset, type SuiteName } from './report';
import { PROBE_BINARY_ENV, PROBE_FAILURE_ENV, probeHandoff } from './rusage';
import { GOVERNOR_BAND_POINTS, PRESET_CEILING_PERCENT, SERIES_STRIDE, scanHoldVerdict, type ScanHoldVerdict } from './governorSuite';
import { checkDuplicatesAgainstManifest, checkRunsAgree, checkScanAgainstManifest, type ScanCounts } from './verify';

export type { EngineChoice } from './measureWorker';

/** The spec's default-threshold precision target (Section 5.5): the near-duplicate suite's correctness bar. */
export const NEAR_DUP_PRECISION_FLOOR = 0.98;

/** A near-duplicate run is correct when the decoder ran, nothing was cut off, something was clustered, and no pair joined two different originals beyond the bar. */
export function nearDupVerdict(v: { available: boolean; truncated: boolean; pairs: number; precision: number }): boolean {
  return v.available && !v.truncated && v.pairs > 0 && v.precision >= NEAR_DUP_PRECISION_FLOOR;
}

const ENGINE_DESCRIPTIONS: Record<string, string> = {
  native: 'the native walker (tm-walk: one getattrlistbulk call per directory on macOS) on its own threads, columns ingested into the packed store',
  'gdu-turbo': 'the bundled gdu binary, one subprocess per top-level directory, output parsed from a JSON file',
  'turbo-walker': 'the Node walker (readdir + one lstat per entry) on a libuv pool sized above 4 threads',
  walker: 'the Node walker (readdir + one lstat per entry) on the default 4-thread libuv pool',
  'sha256-staged': 'size bucket → SHA-256 of the first 64 KiB → full SHA-256, four files at a time',
  'dhash-pairwise': 'dHash of a 9×8 sharp thumbnail per image, O(n²) pairwise union-find, at most 8,000 candidates',
};

export interface CommonOptions {
  corpusName: string;
  runs: number;
  label: string;
  cache?: RequestedCache;
  purge?: PurgeProcedure;
  /** Test hook: removes the series' child data directories, all together, once the series is over. */
  removeDirs?: (dirs: string[]) => void;
}

export interface EnumerateOptions extends CommonOptions {
  manifest: CorpusManifest;
  engine: EngineChoice;
  cache: RequestedCache;
  /** The budget preset every pass scans under, set in each measuring process with the app's own setter. */
  preset: ScanPreset;
  /** Test hook: where to look for gdu (a nonexistent `bundledPath` with `pathLookup: false` means "no binary"). */
  gduFind?: FindOptions;
  /** Test hook: make the child report this engine, to prove the mismatch refusal. */
  pretendEngine?: string;
  /** Test hook: make the child report these budget fields instead of its scan's own, to prove the budget refusals. */
  pretendBudget?: Partial<ScanBudget>;
  /** Test hook: make the child report this usage probe instead of the one it ran, to prove the hand-over refusals. */
  pretendProbe?: WorkerJob['pretendProbe'];
}

export interface DuplicatesOptions extends CommonOptions {
  manifest: CorpusManifest;
  minSize: number;
}

export interface NearDupOptions extends CommonOptions {
  manifest: ImageManifest;
  threshold: number;
}

const tsxCli = (): string => path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
/**
 * A pause after every child exits. The first measured run after the warm-up
 * was the slow one on every series measured while building this, put down at
 * the time to the kernel tearing down the previous process. An A/B on 23 Sep
 * 2026 found the pause itself changes nothing (enum200k walk 405.7 ms without
 * it, 408.0 with it) and put the slow run on deleting the previous child's
 * data directory instead (467.2 ms) — which is why no directory is removed
 * until the series is over (`series`). The pause stays: it costs nothing
 * measured.
 */
const SETTLE_MS = 500;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const WORKER = path.join(__dirname, 'measureWorker.ts');

/**
 * One measured pass in a fresh process with its own app-data directory,
 * which is added to `dataDirs` and left in place: the series removes them all
 * once it is over (`series`). `probe` is this process's usage-probe hand-off
 * (`probeHandoff()`): it replaces whatever probe variables this process
 * inherited, so the child runs exactly the harness's.
 */
async function runChild(job: Omit<WorkerJob, 'outFile'>, probe: Readonly<Record<string, string>>, dataDirs: string[]): Promise<WorkerSuccess> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-data-'));
  dataDirs.push(dataDir);
  const jobFile = path.join(dataDir, 'job.json');
  const outFile = path.join(dataDir, 'result.json');
  const { [PROBE_BINARY_ENV]: _inheritedBinary, [PROBE_FAILURE_ENV]: _inheritedFailure, ...inherited } = process.env;
  const env: NodeJS.ProcessEnv = { ...inherited, ...probe, TREEMAP_DATA_DIR: dataDir };
  if (job.engine === 'walker') env.TREEMAP_NO_GDU = '1';
  else delete env.TREEMAP_NO_GDU;
  // The engine is forced through the app's own setting in the child's private
  // data directory (Phase 3): `auto` is the app's selection, anything else is
  // that engine or a refusal below — never a quiet substitute.
  if (job.engine !== 'auto') fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ engine: job.engine }));
  fs.writeFileSync(jobFile, JSON.stringify({ ...job, outFile }));
  try {
    const stderr = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [tsxCli(), WORKER, jobFile], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
      child.on('error', reject);
      child.on('close', () => resolve(err));
    });
    let result: WorkerResult;
    try {
      result = JSON.parse(fs.readFileSync(outFile, 'utf8')) as WorkerResult;
    } catch {
      throw new Error(`the measuring process left no result${stderr ? `:\n${stderr.trim().split('\n').slice(-5).join('\n')}` : ''}`);
    }
    if (!result.ok) throw new Error(result.error);
    return result;
  } finally {
    await sleep(SETTLE_MS);
  }
}

/** The default `removeDirs`: every child data directory, removed recursively. */
function removeChildDirs(dirs: string[]): void {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * A child that compiled the usage probe did foreign work just before its
 * timed window (rusage.ts says what that did and did not measure). One that
 * ran a probe other than the harness's did not get the hand-off. Either is a
 * harness fault, refused rather than kept.
 */
function assertProbeHandedOver(probe: Readonly<Record<string, string>>, result: WorkerSuccess): void {
  if (result.probe.builds > 0) {
    throw new Error(`the measuring process compiled the usage probe itself (${result.probe.builds} time(s)) right before its timed window; the harness builds it once, before the warm-up, so no child does foreign work inside a measured run`);
  }
  const binary = probe[PROBE_BINARY_ENV];
  if (binary !== undefined && result.probe.location !== binary) {
    throw new Error(`the measuring process ran the usage probe at ${result.probe.location ?? 'nowhere'}, not the one the harness built (${binary})`);
  }
}

function assertRequestedEngine(requested: EngineChoice, actual: string): void {
  const mismatch = (requested === 'native' && actual !== 'native')
    || (requested === 'gdu' && actual !== 'gdu-turbo')
    || (requested === 'walker' && (actual === 'gdu-turbo' || actual === 'native'));
  if (mismatch) throw new Error(`requested ${requested} but the scan ran on ${actual}; the number would describe the wrong engine`);
}

/** The scan's own record must name the setting the series asked for (Automatic when it named none); any other would be another budget's number. */
function assertRequestedBudget(requested: RequestedBudget, recorded: ScanBudget): void {
  if (recorded.preset !== requested) {
    throw new Error(`requested the ${requested} budget but the scan recorded the ${recorded.preset} setting; the number would describe another budget`);
  }
}

interface Series {
  runs: BenchRun[];
  results: WorkerSuccess[];
  cache: CacheVerdict;
  budget: BenchBudget;
}

/**
 * The usage probe is built first (once per invocation), then:
 * Warm: one un-measured pass first, then the label the vnode rule allows.
 * Cold: the purge procedure before EVERY measured pass; one failure and the
 * whole series is `unknown`, naming the runs that were not purged.
 */
async function series(job: Omit<WorkerJob, 'outFile'>, opts: CommonOptions & { engine?: EngineChoice }, machine: MachineRecord, entries: number, dataNote: string): Promise<Series> {
  const requested = opts.cache ?? 'warm';
  const requestedBudget: RequestedBudget = job.preset ?? 'auto';
  const purge = opts.purge ?? defaultPurge;
  const runs: BenchRun[] = [];
  const results: WorkerSuccess[] = [];
  const failedPurges: Array<{ run: number; result: PurgeResult }> = [];
  // The usage probe is built here, once per invocation (later series reuse it) and before the warm-up, so whatever its compile disturbs is behind the warm-up pass.
  const probe = probeHandoff();

  // Every child's data directory stays until the series is over: deleting the
  // previous one (it holds 48 MB of fast-rescan cache on enum200k) slowed the
  // next run's walk ~60 ms, and a measured run must not pay for the harness's
  // own cleanup. Removed together at the end, however the series ends.
  const dataDirs: string[] = [];
  let warmedUp = false;
  try {
    if (requested === 'warm') {
      const warm = await runChild(job, probe, dataDirs);
      assertProbeHandedOver(probe, warm);
      if (opts.engine) assertRequestedEngine(opts.engine, warm.engine);
      assertRequestedBudget(requestedBudget, warm.budget);
      warmedUp = true;
    }

    for (let i = 0; i < opts.runs; i++) {
      if (requested === 'cold') {
        const result = await purge();
        if (!result.ok) failedPurges.push({ run: i + 1, result });
      }
      const result = await runChild(job, probe, dataDirs);
      assertProbeHandedOver(probe, result);
      if (opts.engine) assertRequestedEngine(opts.engine, result.engine);
      assertRequestedBudget(requestedBudget, result.budget);
      if (result.engine === 'gdu-turbo') {
        result.run.bytesRead = null;
        result.run.bytesReadReason = 'gdu reads in child processes; the probe counts only the measuring process';
      }
      runs.push(result.run);
      results.push(result);
    }
  } finally {
    (opts.removeDirs ?? removeChildDirs)(dataDirs);
  }

  let cache: CacheVerdict;
  if (requested === 'cold') {
    if (failedPurges.length === 0) {
      cache = { state: 'cold', reason: `the purge procedure succeeded before each of the ${opts.runs} measured run(s)`, procedure: 'purge before every measured run' };
    } else {
      const which = failedPurges.map((f) => f.run).join(', ');
      cache = { state: 'unknown', reason: `not cold: the purge procedure failed before runs ${which} (${failedPurges[0].result.error ?? 'no error was given'})`, procedure: failedPurges[0].result.command };
    }
  } else {
    cache = await cacheState({ requested: 'warm', entries, maxVnodes: machine.maxVnodes ?? undefined, warmedUp });
    if (dataNote) cache = { ...cache, reason: `${cache.reason}; ${dataNote}` };
  }
  // Each measured run's preset is the one its scan recorded, so a series the governor moved says so.
  return { runs, results, cache, budget: { requested: requestedBudget, effective: results.map((r) => r.budget.effective) } };
}

/**
 * Where a manifest's entries come from (report.ts rule 8): a synthetic
 * preset names itself; every corpus this harness builds is on disk.
 */
export function manifestSource(manifest: CorpusManifest | SyntheticManifest): BenchSource {
  return 'source' in manifest && manifest.source === 'synthetic' ? 'synthetic' : 'file-system';
}

function build(suite: SuiteName, engine: string, unit: EntriesUnit, corpus: BenchResult['corpus'], machine: MachineRecord, s: Series, correctness: BenchResult['correctness'], label: string, source: BenchSource): BenchResult {
  return {
    suite,
    source,
    corpus,
    engine,
    engineDescription: ENGINE_DESCRIPTIONS[engine] ?? 'an engine this harness has no description for',
    entriesUnit: unit,
    machine,
    cache: { state: s.cache.state, reason: s.cache.reason },
    budget: s.budget,
    runs: s.runs,
    summary: summarize(s.runs),
    correctness,
    recordedAt: new Date().toISOString(),
    commit: machine.commit,
    label,
  };
}

function scaleOf(entries: number, maxVnodes: number | null): string {
  if (entries >= 900_000) return "1M entries: the prompt's full enumeration size";
  if (entries >= 180_000) {
    return maxVnodes === null
      ? '200k entries'
      : `200k entries: ${entries <= maxVnodes * 0.8 ? 'fits' : 'does not fit'} this machine's vnode cache (kern.maxvnodes ${maxVnodes.toLocaleString('en-US')})`;
  }
  return `${entries.toLocaleString('en-US')} entries`;
}

export async function runEnumerate(opts: EnumerateOptions): Promise<BenchResult> {
  const machine = await describeMachine();
  const entries = opts.manifest.files + opts.manifest.dirs;
  const s = await series({ suite: 'enumerate', root: opts.manifest.root, engine: opts.engine, preset: opts.preset, gduFind: opts.gduFind, pretendEngine: opts.pretendEngine, pretendBudget: opts.pretendBudget, pretendProbe: opts.pretendProbe }, opts, machine, entries, '');
  const perRun: ScanCounts[] = s.results.map((r) => r.counts);
  const notes: string[] = [];
  let ok = true;
  perRun.forEach((c, i) => {
    const check = checkScanAgainstManifest(opts.manifest, c);
    if (!check.ok) { ok = false; notes.push(...check.notes.map((n) => `run ${i + 1}: ${n}`)); }
  });
  const agree = checkRunsAgree(perRun);
  if (!agree.ok) { ok = false; notes.push(...agree.notes); }
  const engine = s.results[0]?.engine ?? 'unset';
  return build('enumerate', engine, 'entries', { name: opts.corpusName, params: opts.manifest.params, dirs: opts.manifest.dirs, files: opts.manifest.files, scale: scaleOf(entries, machine.maxVnodes) }, machine, s, { ok, notes }, opts.label, manifestSource(opts.manifest));
}

export async function runDuplicates(opts: DuplicatesOptions): Promise<BenchResult> {
  const machine = await describeMachine();
  const s = await series(
    { suite: 'duplicates', root: opts.manifest.root, engine: 'walker', minSize: opts.minSize },
    { ...opts, engine: 'walker' },
    machine,
    opts.manifest.files + opts.manifest.dirs,
    'whether the file data stayed in the page cache is not verified',
  );
  const notes: string[] = [];
  let ok = true;
  s.results.forEach((r, i) => {
    const check = checkDuplicatesAgainstManifest(opts.manifest, r.groups ?? [], opts.minSize, { groupCount: r.groupCount });
    if (!check.ok) ok = false;
    const line = `run ${i + 1}: recall ${check.recall.toFixed(4)} over ${check.expectedGroups} planted groups the finder could report` +
      `${check.truncated ? ` (its report holds ${check.reportedGroups} of ${r.groupCount ?? '?'} found: the rule counts groups above its cut)` : ''}` +
      ` at or above ${opts.minSize.toLocaleString('en-US')} B; precision ${check.precision.toFixed(4)} over ${check.reportedGroups} reported groups;` +
      ` ${check.falsePositives} false positives by byte comparison; ${check.sharedStorageGroups} hard-link families reported; ${check.missedGroups} missed`;
    notes.push(line, ...check.notes.map((n) => `run ${i + 1}: ${n}`));
  });
  const result = build('duplicates', 'sha256-staged', 'files', { name: opts.corpusName, params: opts.manifest.params, dirs: opts.manifest.dirs, files: opts.manifest.files, scale: `${opts.manifest.files.toLocaleString('en-US')} files, ${(opts.manifest.logicalBytes / 1e9).toFixed(2)} GB logical — the prompt's corpus is 1M files / 500 GB` }, machine, s, { ok, notes }, opts.label, manifestSource(opts.manifest));
  // The size floor decides which files are hashed at all: a condition of every comparison (report.ts).
  return { ...result, minSize: opts.minSize };
}

export async function runNearDup(opts: NearDupOptions): Promise<BenchResult> {
  const machine = await describeMachine();
  const images = opts.manifest.images.length;
  const s = await series(
    { suite: 'neardup', root: opts.manifest.root, engine: 'walker', threshold: opts.threshold, entries: images },
    { ...opts, engine: 'walker' },
    machine,
    images,
    'whether the image data stayed in the page cache is not verified',
  );
  const notes: string[] = [];
  let ok = true;
  s.results.forEach((r, i) => {
    const score = scoreClusters(opts.manifest, r.clusters ?? []);
    const recallLines = (Object.entries(score.recall) as Array<[string, number]>).map(([t, v]) => `${t} ${v.toFixed(3)}`);
    const available = r.available === true;
    const truncated = r.truncated === true;
    if (!nearDupVerdict({ available, truncated, pairs: score.pairs, precision: score.precision })) ok = false;
    notes.push(
      `run ${i + 1}: decoder ${r.decoder ?? 'unknown'}; available ${available}${r.reason ? ` (${r.reason})` : ''}; truncated ${truncated} (the legacy job caps its candidate list)`,
      `run ${i + 1}: precision ${score.precision.toFixed(4)} over ${score.pairs} same-cluster pairs (the bar is ${NEAR_DUP_PRECISION_FLOOR}); recall by transform: ${recallLines.join(', ')}`,
    );
  });
  const result = build('neardup', 'dhash-pairwise', 'images', { name: opts.corpusName, params: opts.manifest.params, images, scale: `${images.toLocaleString('en-US')} images — the prompt's corpus is 200k` }, machine, s, { ok, notes }, opts.label, 'file-system');
  // The threshold decides which pairs join a cluster: a condition of every comparison (report.ts).
  return { ...result, threshold: opts.threshold };
}

export interface ScanHoldOptions {
  manifest: CorpusManifest;
  corpusName: string;
  preset: ScanPreset;
  seconds: number;
  label: string;
  /** Test hook: removes the hold's child data directory once it is over. */
  removeDirs?: (dirs: string[]) => void;
}

const SCAN_HOLD_ENGINE = 'native-scan';
const SCAN_HOLD_DESCRIPTION = "the app's own native scan of the corpus, started again as each one settles, as the governor's load; the share is the measuring process's own CPU time over the machine's cores, sampled every 100 ms";
const PRESET_NAME: Readonly<Record<ScanPreset, string>> = { eco: 'Eco', balanced: 'Balanced', turbo: 'Turbo' };

/**
 * Phase 3's governor gate with a live scan as the load (the Phase 3 plan's
 * "the three 60 s holds with a live scan as the load"): one measuring process
 * scans the corpus with the native engine again and again for `seconds` under
 * the preset, sampling its own share of the machine; the verdict is
 * `scanHoldVerdict` — a scan must stay under its ceiling (and the band), not
 * reach it. A governor result like the synthetic hold's, under its own engine
 * id, so the two are never compared with each other.
 */
export async function runScanHold(opts: ScanHoldOptions): Promise<BenchResult> {
  const machine = await describeMachine();
  const probe = probeHandoff();
  const dataDirs: string[] = [];
  try {
    const result = await runChild({ suite: 'scanhold', root: opts.manifest.root, engine: 'native', preset: opts.preset, seconds: opts.seconds }, probe, dataDirs);
    assertProbeHandedOver(probe, result);
    assertRequestedEngine('native', result.engine);
    assertRequestedBudget(opts.preset, result.budget);
    if (!result.hold) throw new Error('the measuring process reported no hold series');
    const verdict = scanHoldVerdict(result.hold.samples, PRESET_CEILING_PERCENT[opts.preset]);
    const run: BenchRun = { ...result.run, entries: result.hold.samples.length };
    const entries = opts.manifest.files + opts.manifest.dirs;
    return {
      suite: 'governor',
      source: manifestSource(opts.manifest),
      corpus: { name: `scan-hold-${opts.preset}-${opts.corpusName}`, params: { corpus: opts.manifest.params, preset: opts.preset, seconds: opts.seconds }, dirs: opts.manifest.dirs, files: opts.manifest.files, scale: scaleOf(entries, machine.maxVnodes) },
      engine: SCAN_HOLD_ENGINE,
      engineDescription: SCAN_HOLD_DESCRIPTION,
      entriesUnit: 'samples',
      machine,
      cache: { state: 'unknown', reason: 'the corpus is scanned back to back: the first walk may read it cold, every later one warm' },
      budget: { requested: opts.preset, effective: [result.budget.effective] },
      runs: [run],
      // One run is the whole series, as for the synthetic hold: its spread is the p95 share, and it is reproducible when the budget held.
      summary: { ...summarize([run]), spreadPct: verdict.p95, reproducible: verdict.withinBudget },
      correctness: { ok: verdict.withinBudget, notes: scanHoldNotes(opts, result.hold, verdict, run.wallMs) },
      recordedAt: new Date().toISOString(),
      commit: machine.commit,
      label: opts.label,
    };
  } finally {
    (opts.removeDirs ?? removeChildDirs)(dataDirs);
  }
}

/** The hold ran `wallMs`: at least the seconds asked, since the scan under way then runs to its end. */
function scanHoldNotes(opts: ScanHoldOptions, hold: NonNullable<WorkerSuccess['hold']>, v: ScanHoldVerdict, wallMs: number): string[] {
  const preset = PRESET_NAME[opts.preset];
  const scans = `${hold.scans} scan${hold.scans === 1 ? '' : 's'}`;
  return [
    `${scans} of ${opts.corpusName} back to back for ${(wallMs / 1000).toFixed(1)} s (${opts.seconds} s asked; the last scan runs to its end) under ${preset}: the last half of ${v.samples} samples averaged ${v.meanLastHalf.toFixed(1)}% of the machine (p95 ${v.p95.toFixed(1)}%, highest ${v.max.toFixed(1)}%) against ${preset}'s ${v.ceiling}% ceiling and its ${GOVERNOR_BAND_POINTS}-point band — ${v.withinBudget ? 'within' : 'over'} budget`,
    `series (every ${SERIES_STRIDE}th sample, % of the machine): ${hold.samples.filter((_, i) => i % SERIES_STRIDE === 0).map((s) => s.toFixed(1)).join(' ')}`,
  ];
}
