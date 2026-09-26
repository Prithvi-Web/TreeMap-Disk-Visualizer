/**
 * The memory path's measurements (Phase 4 T9; design §S.3). No product code:
 * each measurement runs in a fresh process of its own — this machine's Node,
 * or the installed app's own Electron binary run as Node — with the app's
 * server modules loaded, and drives the native engine's memory path exactly as
 * `runNativeWalk` does (walk and seal, `storeTake`, `adoptNativeStore` with
 * Node's passes), then sends the first tree as the app sends it (the SSE
 * `complete` frame at `PRUNE_MAX_NODES`), reporting the process's peak
 * resident memory and physical footprint after each stage. A store where every
 * file is a candidate measures Node's passes alone; a probe loads the addon in
 * a worker thread, as the full-pass runner will (§S.5.7). The numbers set each
 * runtime's `T_mem` and `M_agg`.
 *
 * The measuring process runs JavaScript compiled as the app's build compiles
 * it (`tsc` with the app's settings, into a folder of the harness's own), so
 * no TypeScript loader sits in the memory it measures. The app's binary is
 * used read-only (`ELECTRON_RUN_AS_NODE=1` starts no app and opens no app
 * data); every process has a data folder of its own, removed when it is done.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PROBE_BINARY_ENV, PROBE_FAILURE_ENV, probeHandoff } from './rusage';

/** The stages a walk is measured after, in order. */
export const MEMORY_PATH_STAGES = ['loaded', 'walked', 'handed-over', 'adopted', 'pruned'] as const;
/** The installed app's binary, run as Node for the Electron runtime (macOS). */
export const ELECTRON_BINARY = '/Applications/TreeMap.app/Contents/MacOS/TreeMap';

export type MemoryPathRuntime = 'node' | 'electron';

/** What one measuring process does. */
export type MemoryPathJob =
  /** The memory path over a synthetic tree: nothing on disk (tm-walk's `SyntheticLister`, the developer shape). */
  | { kind: 'synthetic'; entries: number; seed: number }
  /** The memory path over a tree on disk (a bench corpus). */
  | { kind: 'disk'; root: string }
  /** Node's passes alone, over a store built in JavaScript where every file is a text and a cloud candidate. */
  | { kind: 'candidates'; entries: number }
  /** The addon loaded in a worker thread, its version read there. */
  | { kind: 'worker-probe' };

export interface StageUsage {
  stage: string;
  /** Since the process started measuring. */
  ms: number;
  /** The process's peak resident set so far (`getrusage` maxRSS). */
  peakRssBytes: number;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  /** The process's peak physical footprint so far (macOS), or null. */
  peakFootprintBytes: number | null;
}

export interface MemoryPathRuntimeInfo {
  node: string;
  /** Electron's version where the process is the app's binary run as Node, else null. */
  electron: string | null;
}

export type MemoryPathResult =
  | {
    ok: true;
    runtime: MemoryPathRuntimeInfo;
    stages: StageUsage[];
    /** Why a stage's footprint is null, or where it came from. */
    footprintSource: string;
    /** Whether a TypeScript loader was in the process: never, since it runs compiled JavaScript. */
    typescriptLoader: boolean;
    /** Whether the app's server modules were in memory from the first stage on. */
    serverLoaded?: boolean;
    counts?: { scanned: number; dirs: number; files: number };
    /**
     * How long the JavaScript thread was busy while `storeTake` ran
     * (`busyWhile`): where Electron refuses external buffers, napi-rs copies
     * the columns there, inside one callback (RISKS R92).
     */
    handOverBusyMs?: number;
    /** The SSE `complete` frame's bytes, as the app's `sseSend` wrote it and a socket encodes it. */
    frameBytes?: number;
    /** The frame's first bytes, which name the event. */
    frameHead?: string;
    passes?: { textCandidates: number; cloudCandidates: number; ms: number };
    workerVersion?: string;
  }
  | { ok: false; runtime?: MemoryPathRuntimeInfo; error: string };

/**
 * `work`'s value, and how long the JavaScript thread was busy while it ran:
 * the event loop's active time over the window. A block inside the callback
 * that settles `work` counts whole — a delay probe would miss it, switched off
 * by the very continuation that follows the block.
 */
export async function busyWhile<T>(work: () => Promise<T>): Promise<{ value: T; busyMs: number }> {
  const before = performance.eventLoopUtilization();
  const value = await work();
  return { value, busyMs: performance.eventLoopUtilization(before).active };
}

const REPO = path.join(__dirname, '..', '..');

/** The tsconfig `compileWorker` compiles with. */
export interface WorkerTsconfig {
  extends: string;
  compilerOptions: { rootDir: string; outDir: string; sourceMap: false; noEmit: false };
  files: string[];
  include: string[];
}

/**
 * The tsconfig that compiles the worker and every file of the app's `src/` in `repo`
 * into `outDir`, every path written with `/`: TypeScript splits an `include` pattern
 * on `/` alone, so a pattern with Windows' separators matches nothing, and the compile
 * loses `src/types`' declarations. `p` is the platform's path module.
 */
export function workerTsconfig(repo: string, outDir: string, p: path.PlatformPath = path): WorkerTsconfig {
  const slashed = (...parts: string[]): string => p.join(...parts).split(p.sep).join('/');
  return {
    extends: slashed(repo, 'tsconfig.json'),
    compilerOptions: { rootDir: slashed(repo), outDir: slashed(outDir), sourceMap: false, noEmit: false },
    files: [slashed(repo, 'bench', 'lib', 'memoryPathWorker.ts')],
    include: [slashed(repo, 'src', '**', '*.ts')],
  };
}

/**
 * The worker, and the app's `src/` it drives, compiled as the app's build
 * compiles them — `tsc` with the app's own settings, every file of `src/` —
 * into `outDir`, laid out as the repository is: `src/` one level below a
 * `package.json`, so the paths the app counts up from its own files
 * (`../../package.json`, the native loader's root) land where they land in the
 * app's `dist/`. (The rule packs `scripts/copy-assets.js` copies are read on
 * first use, which nothing measured makes.) Returns the compiled worker's path.
 */
function compileWorker(outDir: string): string {
  const tsconfig = path.join(outDir, 'tsconfig.json');
  fs.writeFileSync(tsconfig, JSON.stringify(workerTsconfig(REPO, outDir)));
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  const r = spawnSync(process.execPath, [tsc, '-p', tsconfig], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`the measuring worker did not compile: ${`${r.stdout}${r.stderr}`.trim().slice(-2_000)}`);
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(outDir, 'package.json'));
  return path.join(outDir, 'bench', 'lib', 'memoryPathWorker.js');
}

let compiled: string | undefined;

/**
 * The compiled worker, built once per process into a folder removed when the
 * process exits: inside the repository (under the ignored `bench/results/`),
 * so the compiled app finds the repository's `node_modules` as `dist/` does.
 */
function compiledWorker(): string {
  if (compiled === undefined) {
    const results = path.join(REPO, 'bench', 'results');
    fs.mkdirSync(results, { recursive: true });
    const outDir = fs.mkdtempSync(path.join(results, '.memory-path-js-'));
    process.once('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));
    compiled = compileWorker(outDir);
  }
  return compiled;
}

/** The binary a runtime runs; the Electron runtime is refused, naming where it looked, when the app is not installed there. */
function executable(runtime: MemoryPathRuntime): string {
  if (runtime === 'node') return process.execPath;
  if (process.platform !== 'darwin' || !fs.existsSync(ELECTRON_BINARY)) {
    throw new Error(`the Electron runtime runs the installed app's binary, and there is none at ${ELECTRON_BINARY}`);
  }
  return ELECTRON_BINARY;
}

/**
 * One measurement: `job` in a fresh process under `runtime`, loading the
 * addon at `module`. Resolves with the worker's result — `ok: false` with
 * its sentence when it failed — and rejects only when the runtime is not
 * there to run.
 */
export async function runMemoryPathWorker(job: MemoryPathJob & { module: string; runtime: MemoryPathRuntime }): Promise<MemoryPathResult> {
  const binary = executable(job.runtime);
  const worker = compiledWorker();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-memory-path-'));
  try {
    const jobFile = path.join(dataDir, 'job.json');
    const outFile = path.join(dataDir, 'result.json');
    fs.writeFileSync(jobFile, JSON.stringify({ ...job, outFile }));
    // The app runs with neither: NODE_OPTIONS could carry a loader into the process measured.
    const { [PROBE_BINARY_ENV]: _binary, [PROBE_FAILURE_ENV]: _failure, ELECTRON_RUN_AS_NODE: _asNode, NODE_OPTIONS: _options, ...inherited } = process.env;
    const env: NodeJS.ProcessEnv = {
      ...inherited,
      ...probeHandoff(),
      TREEMAP_DATA_DIR: dataDir,
      ...(job.runtime === 'electron' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    };
    const stderr = await new Promise<string>((resolve, reject) => {
      let err = '';
      const child = spawn(binary, [worker, jobFile], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
      child.on('error', reject);
      child.on('close', () => resolve(err));
    });
    if (!fs.existsSync(outFile)) return { ok: false, error: `the measuring process wrote no result: ${stderr.trim().slice(-2_000)}` };
    return JSON.parse(fs.readFileSync(outFile, 'utf8')) as MemoryPathResult;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/* ------------------------------ the matrix (`npm run bench -- memory-path`) ------------------------------ */

/** One measurement of the matrix: where it ran, what it did, and what it found. */
export interface MemoryPathMeasurement {
  runtime: MemoryPathRuntime;
  job: MemoryPathJob;
  result: MemoryPathResult;
}

/**
 * Where `--record` keeps a platform's record: a folder of its own under the
 * baselines, because every file directly in that folder is a comparable
 * result that the bench's readers compare (and `tests/benchReport.test.ts`
 * reads each one as such), and a memory-path record is not one.
 */
export function memoryPathBaselinePath(baselinesDir: string, platform: string, arch: string): string {
  return path.join(baselinesDir, 'memory-path', `${platform}-${arch}.json`);
}

/** What `memory-path` writes: every measurement, and the machine and tree they were taken on. */
export interface MemoryPathRecord {
  kind: 'memory-path';
  recordedAt: string;
  label: string;
  machine: Awaited<ReturnType<typeof import('./machine').describeMachine>>;
  module: string;
  measurements: MemoryPathMeasurement[];
}

/**
 * A list of counts, each a whole number with an optional `k` (thousand) or
 * `m` (million): `1m,2m,500k`. Anything else is refused, naming the option.
 */
export function parseSizes(text: string, option: string): number[] {
  const refuse = (): Error => new Error(`--${option} must be a list like 1m,2m,500k: whole counts, each with an optional k or m`);
  const parts = text.split(',');
  return parts.map((part) => {
    const match = /^(\d+)([km]?)$/.exec(part.trim());
    if (!match) throw refuse();
    const n = Number(match[1]) * (match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1);
    if (!Number.isSafeInteger(n) || n < 1) throw refuse();
    return n;
  });
}

export interface MatrixOptions {
  runtimes: readonly MemoryPathRuntime[];
  /** Synthetic trees' entry counts. */
  sizes: readonly number[];
  seed: number;
  /** A bench corpus on disk to walk too. */
  corpusRoot?: string;
  /** Candidate stores' file counts. */
  candidates: readonly number[];
  module: string;
  onMeasured?: (measurement: MemoryPathMeasurement) => void;
}

/** Every runtime's measurements, one fresh process each: the synthetic trees, the corpus, the candidate stores, the worker probe. */
export async function runMemoryPathMatrix(opts: MatrixOptions): Promise<MemoryPathMeasurement[]> {
  const out: MemoryPathMeasurement[] = [];
  for (const runtime of opts.runtimes) {
    const jobs: MemoryPathJob[] = [
      ...opts.sizes.map((entries): MemoryPathJob => ({ kind: 'synthetic', entries, seed: opts.seed })),
      ...(opts.corpusRoot ? [{ kind: 'disk', root: opts.corpusRoot } as const] : []),
      ...opts.candidates.map((entries): MemoryPathJob => ({ kind: 'candidates', entries })),
      { kind: 'worker-probe' },
    ];
    for (const job of jobs) {
      const measurement = { runtime, job, result: await runMemoryPathWorker({ ...job, module: opts.module, runtime }) };
      out.push(measurement);
      opts.onMeasured?.(measurement);
    }
  }
  return out;
}

const MB = 1024 * 1024;

/** One line per measurement: the stages' peak resident set in MB, and the footprint at the end. */
export function formatMeasurement(m: MemoryPathMeasurement): string {
  const what = m.job.kind === 'synthetic' ? `synthetic ${m.job.entries.toLocaleString('en-US')}`
    : m.job.kind === 'disk' ? `disk ${path.basename(path.dirname(m.job.root))}`
      : m.job.kind === 'candidates' ? `candidates ${m.job.entries.toLocaleString('en-US')}`
        : 'worker-probe';
  const head = `${m.runtime.padEnd(8)} ${what.padEnd(22)}`;
  if (!m.result.ok) return `${head} FAILED: ${m.result.error.split('\n')[0]}`;
  const stages = m.result.stages.map((s) => `${s.stage} ${(s.peakRssBytes / MB).toFixed(0)}`).join(' · ');
  const last = m.result.stages[m.result.stages.length - 1];
  const footprint = last?.peakFootprintBytes == null ? '' : ` · footprint ${(last.peakFootprintBytes / MB).toFixed(0)}`;
  const extra = m.result.passes ? ` · passes ${m.result.passes.ms.toFixed(0)} ms`
    : m.result.workerVersion ? ` · worker loaded ${m.result.workerVersion}`
      : m.result.handOverBusyMs !== undefined
        ? ` · hand-over busy ${m.result.handOverBusyMs.toFixed(1)} ms · frame ${((m.result.frameBytes ?? 0) / MB).toFixed(1)} MB` : '';
  return `${head} peak MB: ${stages || '—'}${footprint}${extra}`;
}
