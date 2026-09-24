/**
 * measureWorker — one measured pass, in a process of its own.
 *
 * `suites.ts` starts this file under tsx once per run with the app's data
 * directory and engine gate already in the environment. A fresh process is
 * what makes the numbers honest: peak RSS is this pass's own (no scans
 * retained from earlier passes, no corpus builder in the same heap), the CPU
 * and bytes-read counters cannot include the previous scan's persistence,
 * and every engine variable is set before a single service is imported.
 *
 * The scan is timed to the instant its status leaves `running`. The app then
 * persists a cache and a snapshot in the background; that work is waited for
 * (`settled()` from the app's own write ledger) and reported on its own as
 * `persist`, so it is neither inside the scan's numbers nor lost.
 *
 * The job arrives as a JSON file (argv[2]); the result leaves as a JSON file
 * (`job.outFile`). Nothing crosses stdout, which stays free for diagnostics.
 *
 * A job that names a budget preset has it set before the scan with the app's
 * own setter, and every result carries the budget the scan's own record says
 * it ran under — the parent refuses a preset that did not take.
 *
 * This process never compiles the macOS usage probe: the parent built it
 * before the warm-up and names it in the environment (rusage.ts), because a
 * compile here would be foreign work just before the timed window (see
 * rusage.ts for what that did and did not measure). Every result says which
 * probe ran and how many this process compiled, and the parent refuses a
 * child that compiled one.
 */
import fs from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { startScan, cancelAllScans, evictExpiredScans } from '../../src/services/diskScanner';
import { findGduBinary, type FindOptions } from '../../src/services/gduScanner';
import { nativeScanModule } from '../../src/services/scan/nativeEngine';
import { getDuplicateJob } from '../../src/services/duplicateFinder';
import { getNearDupeJob } from '../../src/services/perceptualDupes';
import { storeOf } from '../../src/services/scanStore';
import { settled } from '../../src/utils/backgroundWrites';
import { applyEngineBudgetSetting } from '../../src/services/engineBudget';
import { getSettings } from '../../src/services/settings';
import type { ScanBudget, ScanResult } from '../../src/models/types';
import { diffUsage, probeBuildCount, probeLocation, snapshotUsage } from './rusage';
import { SCAN_PRESETS, type BenchRun, type ScanPreset } from './report';

/** Which engine a pass asks for; `native` is the Phase 3 walker and is refused when the build has no module. */
export type EngineChoice = 'auto' | 'native' | 'gdu' | 'walker';
export const ENGINE_CHOICES: readonly EngineChoice[] = ['auto', 'native', 'gdu', 'walker'];

export interface WorkerJob {
  suite: 'enumerate' | 'duplicates' | 'neardup' | 'scanhold';
  root: string;
  engine: EngineChoice;
  outFile: string;
  gduFind?: FindOptions;
  /** Test hook: report this engine name instead of the scan's own, to prove the mismatch refusal. */
  pretendEngine?: string;
  /** The budget preset to scan under; absent for the suites that run under the app's own default (Automatic). */
  preset?: ScanPreset;
  /** Test hook: report these fields instead of the scan's own budget record, to prove the budget refusals. */
  pretendBudget?: Partial<ScanBudget>;
  /** Test hook: report these fields instead of the probe this process ran, to prove the hand-over refusals. */
  pretendProbe?: Partial<WorkerSuccess['probe']>;
  minSize?: number;
  threshold?: number;
  /** What the near-duplicate suite counts (the corpus's image count). */
  entries?: number;
  /** How long a scan hold scans for, in seconds. */
  seconds?: number;
}

export interface WorkerSuccess {
  ok: true;
  engine: string;
  counts: { fileCount: number; dirCount: number; scanned: number; rootSize: number };
  run: BenchRun;
  /** The budget the scan's own record says it ran under: `ScanResult.budget`, which GET /api/scan/:id/stats serves as `budget`. */
  budget: ScanBudget;
  groups?: Array<{ size: number; files: Array<{ path: string }> }>;
  groupCount?: number;
  clusters?: string[][];
  decoder?: string;
  available?: boolean;
  reason?: string;
  truncated?: boolean;
  /** The usage probe this process ran (`null` where none ran) and how many times it compiled one — 0 when the parent's hand-off took. */
  probe: { location: string | null; builds: number };
  /** A scan hold's series: this process's share of the machine in percent, one sample every `sampleMs`, and the scans it ran. */
  hold?: { samples: number[]; scans: number; sampleMs: number };
}
export interface WorkerFailure { ok: false; error: string }
/** What a pass measured; the entry point adds the probe it measured with. */
type MeasuredPass = Omit<WorkerSuccess, 'probe'>;
export type WorkerResult = WorkerSuccess | WorkerFailure;

/** Tight enough that the wall clock carries no visible polling floor (the app's own waiter polls at 250 ms). */
const POLL_MS = 1;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A scan hold samples this process's share at the governor's own tick. */
const HOLD_SAMPLE_MS = 100;
/** Far enough ahead that every settled scan's retention has passed: a hold keeps none of its scans in memory. */
const EVICT_ALL_SETTLED_MS = 24 * 60 * 60 * 1000;
const MICROSECONDS_PER_SECOND = 1_000_000;
const PERCENT = 100;

async function settledScan(scan: ScanResult): Promise<ScanResult> {
  while (scan.status === 'running') await sleep(POLL_MS);
  if (scan.status === 'error') throw new Error(`scan failed: ${scan.error ?? 'unknown'}`);
  return scan;
}

function counts(scan: ScanResult): WorkerSuccess['counts'] {
  const store = storeOf(scan);
  return { fileCount: scan.fileCount, dirCount: scan.dirCount, scanned: scan.scanned, rootSize: store.size(store.rootId) };
}

/**
 * The preset is the app's own setting, set with the app's own setter. The
 * settings file is loaded first because its first load hands the budget
 * module the persisted setting (settings.ts) — Automatic, in this child's
 * fresh data directory — and startScan's own settings read would otherwise
 * undo the preset set here, silently.
 */
async function applyPreset(preset: ScanPreset): Promise<void> {
  await getSettings();
  applyEngineBudgetSetting({ preset, cpuPercent: null });
}

interface Timed<T> { value: T; run: BenchRun }

/** Runs `work` between two usage snapshots, then waits for the app's background writes and measures those too. */
async function measured<T>(entries: (value: T) => number, work: () => Promise<T>): Promise<Timed<T>> {
  const before = await snapshotUsage();
  const t0 = performance.now();
  const value = await work();
  const wallMs = performance.now() - t0;
  const atEnd = await snapshotUsage();
  const p0 = performance.now();
  await settled();
  const persistMs = performance.now() - p0;
  const afterPersist = await snapshotUsage();
  const d = diffUsage(before, atEnd);
  const persist = diffUsage(atEnd, afterPersist);
  const child = d.childCpuSeconds;
  return {
    value,
    run: {
      wallMs,
      entries: entries(value),
      cpuSeconds: d.cpuSeconds + (child ?? 0),
      selfCpuSeconds: d.cpuSeconds,
      childCpuSeconds: child,
      peakRssBytes: d.peakRssBytes,
      bytesRead: d.bytesRead,
      bytesReadReason: d.bytesReadReason,
      persistMs,
      persistCpuSeconds: persist.cpuSeconds + (persist.childCpuSeconds ?? 0),
      loadAvg: process.platform === 'win32' ? null : os.loadavg(),
    },
  };
}

async function main(job: WorkerJob): Promise<MeasuredPass> {
  if (job.engine === 'gdu') {
    const bin = await findGduBinary(job.gduFind ?? {});
    if (!bin) throw new Error('gdu was requested but no gdu binary is available (bundled, ./gdu, or $PATH); run `npm run fetch:gdu:dev` first');
  }
  if (job.engine === 'native') {
    const surface = nativeScanModule();
    if (!surface.available) throw new Error(`the native engine was requested but this build cannot run it: ${surface.reason}`);
  }
  if (job.preset) await applyPreset(job.preset);
  const budgetOf = (scan: ScanResult): ScanBudget => ({ ...scan.budget, ...job.pretendBudget });

  if (job.suite === 'scanhold') return scanHold(job, budgetOf);

  if (job.suite === 'enumerate') {
    const timed = await measured((scan: ScanResult) => scan.scanned, async () => settledScan(await startScan(job.root)));
    const scan = timed.value;
    return { ok: true, engine: job.pretendEngine ?? scan.engine ?? 'unset', counts: counts(scan), run: timed.run, budget: budgetOf(scan) };
  }

  // The scan itself is not what these suites measure: it runs first, un-timed, and its persistence settles before the job starts.
  const scan = await settledScan(await startScan(job.root));
  await settled();
  const engine = job.pretendEngine ?? scan.engine ?? 'unset';

  if (job.suite === 'duplicates') {
    const minSize = job.minSize ?? 1024;
    const timed = await measured(() => scan.fileCount, async () => {
      const dup = getDuplicateJob(scan, minSize);
      while (dup.status === 'running') await sleep(POLL_MS);
      if (dup.status === 'error') throw new Error(`duplicate job failed: ${dup.error ?? 'unknown'}`);
      return dup;
    });
    const dup = timed.value;
    return {
      ok: true,
      engine,
      counts: counts(scan),
      run: timed.run,
      budget: budgetOf(scan),
      groups: (dup.groups ?? []).map((g) => ({ size: g.size, files: g.files.map((f) => ({ path: f.path })) })),
      groupCount: dup.groupCount ?? (dup.groups ?? []).length,
    };
  }

  const threshold = job.threshold ?? 10;
  const timed = await measured(() => job.entries ?? 0, async () => {
    const near = getNearDupeJob(scan, threshold);
    while (near.status === 'running') await sleep(POLL_MS);
    if (near.status === 'error') throw new Error(`near-duplicate job failed: ${near.error ?? 'unknown'}`);
    return near;
  });
  const near = timed.value;
  return {
    ok: true,
    engine,
    counts: counts(scan),
    run: timed.run,
    budget: budgetOf(scan),
    clusters: (near.clusters ?? []).map((c) => c.files.map((f) => f.path)),
    decoder: near.decoder,
    available: near.available,
    reason: near.reason,
    truncated: near.truncated === true,
  };
}

/**
 * Phase 3's governor gate with a live scan as the load: the app's own scan,
 * started and settled again and again for `job.seconds`, under the preset
 * the job set, while this process samples its own CPU share of the machine
 * (all threads: the native walk runs on this process's). Each scan's
 * persistence settles before the next starts, and each settled scan is
 * dropped from memory at once, as its retention would drop it.
 */
async function scanHold(job: WorkerJob, budgetOf: (scan: ScanResult) => ScanBudget): Promise<MeasuredPass> {
  const cores = os.cpus().length;
  const samples: number[] = [];
  let scans = 0;
  // Held in an object: an assignment inside the timed callback is invisible to the narrowing below.
  const last: { value: { scan: ScanResult; counts: WorkerSuccess['counts'] } | null } = { value: null };
  const timed = await measured(() => samples.length, async () => {
    let cpuMark = process.cpuUsage();
    let wallMark = performance.now();
    const sampler = setInterval(() => {
      const now = performance.now();
      const cpu = process.cpuUsage(cpuMark);
      const wallSeconds = (now - wallMark) / 1000;
      if (wallSeconds > 0) samples.push(((cpu.user + cpu.system) / MICROSECONDS_PER_SECOND / (wallSeconds * cores)) * PERCENT);
      cpuMark = process.cpuUsage();
      wallMark = now;
    }, HOLD_SAMPLE_MS);
    try {
      const endAt = performance.now() + (job.seconds ?? 0) * 1000;
      while (performance.now() < endAt) {
        const scan = await settledScan(await startScan(job.root));
        scans++;
        last.value = { scan, counts: counts(scan) };
        await settled();
        evictExpiredScans(Date.now() + EVICT_ALL_SETTLED_MS);
      }
    } finally {
      clearInterval(sampler);
    }
    return samples;
  });
  if (!last.value) throw new Error('measureWorker: no scan completed during the hold');
  const { scan, counts: lastCounts } = last.value;
  return { ok: true, engine: job.pretendEngine ?? scan.engine ?? 'unset', counts: lastCounts, run: timed.run, budget: budgetOf(scan), hold: { samples, scans, sampleMs: HOLD_SAMPLE_MS } };
}

function readJob(file: string | undefined): WorkerJob {
  if (!file) throw new Error('measureWorker: a job file is required');
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('measureWorker: the job is not an object');
  const j = parsed as Record<string, unknown>;
  if (!['enumerate', 'duplicates', 'neardup', 'scanhold'].includes(String(j.suite))) throw new Error(`measureWorker: unknown suite ${String(j.suite)}`);
  if (typeof j.root !== 'string' || typeof j.outFile !== 'string') throw new Error('measureWorker: root and outFile are required');
  if (!(ENGINE_CHOICES as readonly string[]).includes(String(j.engine))) throw new Error(`measureWorker: unknown engine ${String(j.engine)}`);
  if (j.preset !== undefined && !(SCAN_PRESETS as readonly unknown[]).includes(j.preset)) throw new Error(`measureWorker: unknown preset ${String(j.preset)}`);
  if ((j.suite === 'enumerate' || j.suite === 'scanhold') && j.preset === undefined) {
    throw new Error(`measureWorker: the ${String(j.suite)} suite scans under a named preset (eco, balanced or turbo), never the app's Automatic default, which no number can name`);
  }
  if (j.suite === 'scanhold' && !(Number.isInteger(j.seconds) && Number(j.seconds) >= 1)) {
    throw new Error(`measureWorker: a scan hold needs whole seconds of at least 1, got ${String(j.seconds)}`);
  }
  return parsed as WorkerJob;
}

if (require.main === module) {
  const job = readJob(process.argv[2]);
  main(job)
    .then((result) => {
      const success: WorkerSuccess = { ...result, probe: { location: probeLocation(), builds: probeBuildCount(), ...job.pretendProbe } };
      fs.writeFileSync(job.outFile, JSON.stringify(success));
      cancelAllScans();
      process.exit(0);
    })
    .catch((err: unknown) => {
      const failure: WorkerFailure = { ok: false, error: err instanceof Error ? err.message : String(err) };
      try {
        fs.writeFileSync(job.outFile, JSON.stringify(failure));
      } catch {
        /* the parent reports the missing file */
      }
      process.exit(1);
    });
}
