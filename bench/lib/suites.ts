/**
 * The three suites. Each measured pass runs the REAL engines — `startScan`,
 * the duplicate job, the near-duplicate job — in a child process started
 * from `measureWorker.ts`, with an isolated data directory and the engine
 * gate set in that child's environment. This process only orchestrates,
 * labels and checks; it never imports a service, so nothing it does can leak
 * into a number.
 *
 * Refusals, never guesses: a requested engine the scan did not run on, a
 * cold series whose purge failed, a job that errored — each is an error or a
 * downgraded label with the reason, never a silently different number.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { FindOptions } from '../../src/services/gduScanner';
import { cacheState, defaultPurge, type CacheVerdict, type PurgeProcedure, type PurgeResult, type RequestedCache } from './cache';
import type { CorpusManifest } from './corpus';
import { scoreClusters, type ImageManifest } from './images';
import { describeMachine, type MachineRecord } from './machine';
import type { EngineChoice, WorkerJob, WorkerResult, WorkerSuccess } from './measureWorker';
import { summarize, type BenchResult, type BenchRun, type EntriesUnit, type SuiteName } from './report';
import { checkDuplicatesAgainstManifest, checkRunsAgree, checkScanAgainstManifest, type ScanCounts } from './verify';

export type { EngineChoice } from './measureWorker';

/** The spec's default-threshold precision target (Section 5.5): the near-duplicate suite's correctness bar. */
export const NEAR_DUP_PRECISION_FLOOR = 0.98;

/** A near-duplicate run is correct when the decoder ran, nothing was cut off, something was clustered, and no pair joined two different originals beyond the bar. */
export function nearDupVerdict(v: { available: boolean; truncated: boolean; pairs: number; precision: number }): boolean {
  return v.available && !v.truncated && v.pairs > 0 && v.precision >= NEAR_DUP_PRECISION_FLOOR;
}

const ENGINE_DESCRIPTIONS: Record<string, string> = {
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
}

export interface EnumerateOptions extends CommonOptions {
  manifest: CorpusManifest;
  engine: EngineChoice;
  cache: RequestedCache;
  /** Test hook: where to look for gdu (a nonexistent `bundledPath` with `pathLookup: false` means "no binary"). */
  gduFind?: FindOptions;
  /** Test hook: make the child report this engine, to prove the mismatch refusal. */
  pretendEngine?: string;
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
const WORKER = path.join(__dirname, 'measureWorker.ts');

/** One measured pass in a fresh process with its own app-data directory; the directory is removed once the child has exited. */
async function runChild(job: Omit<WorkerJob, 'outFile'>): Promise<WorkerSuccess> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-data-'));
  const jobFile = path.join(dataDir, 'job.json');
  const outFile = path.join(dataDir, 'result.json');
  const env: NodeJS.ProcessEnv = { ...process.env, TREEMAP_DATA_DIR: dataDir };
  if (job.engine === 'walker') env.TREEMAP_NO_GDU = '1';
  else delete env.TREEMAP_NO_GDU;
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
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

function assertRequestedEngine(requested: EngineChoice, actual: string): void {
  const mismatch = (requested === 'gdu' && actual !== 'gdu-turbo') || (requested === 'walker' && actual === 'gdu-turbo');
  if (mismatch) throw new Error(`requested ${requested} but the scan ran on ${actual}; the number would describe the wrong engine`);
}

interface Series {
  runs: BenchRun[];
  results: WorkerSuccess[];
  cache: CacheVerdict;
}

/**
 * Warm: one un-measured pass first, then the label the vnode rule allows.
 * Cold: the purge procedure before EVERY measured pass; one failure and the
 * whole series is `unknown`, naming the runs that were not purged.
 */
async function series(job: Omit<WorkerJob, 'outFile'>, opts: CommonOptions & { engine?: EngineChoice }, machine: MachineRecord, entries: number, dataNote: string): Promise<Series> {
  const requested = opts.cache ?? 'warm';
  const purge = opts.purge ?? defaultPurge;
  const runs: BenchRun[] = [];
  const results: WorkerSuccess[] = [];
  const failedPurges: Array<{ run: number; result: PurgeResult }> = [];

  let warmedUp = false;
  if (requested === 'warm') {
    const warm = await runChild(job);
    if (opts.engine) assertRequestedEngine(opts.engine, warm.engine);
    warmedUp = true;
  }

  for (let i = 0; i < opts.runs; i++) {
    if (requested === 'cold') {
      const result = await purge();
      if (!result.ok) failedPurges.push({ run: i + 1, result });
    }
    const result = await runChild(job);
    if (opts.engine) assertRequestedEngine(opts.engine, result.engine);
    if (result.engine === 'gdu-turbo') {
      result.run.bytesRead = null;
      result.run.bytesReadReason = 'gdu reads in child processes; the probe counts only the measuring process';
    }
    runs.push(result.run);
    results.push(result);
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
  return { runs, results, cache };
}

function build(suite: SuiteName, engine: string, unit: EntriesUnit, corpus: BenchResult['corpus'], machine: MachineRecord, s: Series, correctness: BenchResult['correctness'], label: string): BenchResult {
  return {
    suite,
    corpus,
    engine,
    engineDescription: ENGINE_DESCRIPTIONS[engine] ?? 'an engine this harness has no description for',
    entriesUnit: unit,
    machine,
    cache: { state: s.cache.state, reason: s.cache.reason },
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
  const s = await series({ suite: 'enumerate', root: opts.manifest.root, engine: opts.engine, gduFind: opts.gduFind, pretendEngine: opts.pretendEngine }, opts, machine, entries, '');
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
  return build('enumerate', engine, 'entries', { name: opts.corpusName, params: opts.manifest.params, dirs: opts.manifest.dirs, files: opts.manifest.files, scale: scaleOf(entries, machine.maxVnodes) }, machine, s, { ok, notes }, opts.label);
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
  return build('duplicates', 'sha256-staged', 'files', { name: opts.corpusName, params: opts.manifest.params, dirs: opts.manifest.dirs, files: opts.manifest.files, scale: `${opts.manifest.files.toLocaleString('en-US')} files, ${(opts.manifest.logicalBytes / 1e9).toFixed(2)} GB logical — the prompt's corpus is 1M files / 500 GB` }, machine, s, { ok, notes }, opts.label);
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
  return build('neardup', 'dhash-pairwise', 'images', { name: opts.corpusName, params: opts.manifest.params, images, scale: `${images.toLocaleString('en-US')} images — the prompt's corpus is 200k` }, machine, s, { ok, notes }, opts.label);
}
