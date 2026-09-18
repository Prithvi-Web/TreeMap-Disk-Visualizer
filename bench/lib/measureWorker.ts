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
 */
import fs from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { startScan, cancelAllScans } from '../../src/services/diskScanner';
import { findGduBinary, type FindOptions } from '../../src/services/gduScanner';
import { getDuplicateJob } from '../../src/services/duplicateFinder';
import { getNearDupeJob } from '../../src/services/perceptualDupes';
import { storeOf } from '../../src/services/scanStore';
import { settled } from '../../src/utils/backgroundWrites';
import type { ScanResult } from '../../src/models/types';
import { diffUsage, snapshotUsage } from './rusage';
import type { BenchRun } from './report';

export type EngineChoice = 'auto' | 'gdu' | 'walker';

export interface WorkerJob {
  suite: 'enumerate' | 'duplicates' | 'neardup';
  root: string;
  engine: EngineChoice;
  outFile: string;
  gduFind?: FindOptions;
  /** Test hook: report this engine name instead of the scan's own, to prove the mismatch refusal. */
  pretendEngine?: string;
  minSize?: number;
  threshold?: number;
  /** What the near-duplicate suite counts (the corpus's image count). */
  entries?: number;
}

export interface WorkerSuccess {
  ok: true;
  engine: string;
  counts: { fileCount: number; dirCount: number; scanned: number; rootSize: number };
  run: BenchRun;
  groups?: Array<{ size: number; files: Array<{ path: string }> }>;
  groupCount?: number;
  clusters?: string[][];
  decoder?: string;
  available?: boolean;
  reason?: string;
  truncated?: boolean;
}
export interface WorkerFailure { ok: false; error: string }
export type WorkerResult = WorkerSuccess | WorkerFailure;

/** Tight enough that the wall clock carries no visible polling floor (the app's own waiter polls at 250 ms). */
const POLL_MS = 1;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function settledScan(scan: ScanResult): Promise<ScanResult> {
  while (scan.status === 'running') await sleep(POLL_MS);
  if (scan.status === 'error') throw new Error(`scan failed: ${scan.error ?? 'unknown'}`);
  return scan;
}

function counts(scan: ScanResult): WorkerSuccess['counts'] {
  const store = storeOf(scan);
  return { fileCount: scan.fileCount, dirCount: scan.dirCount, scanned: scan.scanned, rootSize: store.size(store.rootId) };
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

async function main(job: WorkerJob): Promise<WorkerSuccess> {
  if (job.engine === 'gdu') {
    const bin = await findGduBinary(job.gduFind ?? {});
    if (!bin) throw new Error('gdu was requested but no gdu binary is available (bundled, ./gdu, or $PATH); run `npm run fetch:gdu:dev` first');
  }

  if (job.suite === 'enumerate') {
    const timed = await measured((scan: ScanResult) => scan.scanned, async () => settledScan(await startScan(job.root)));
    const scan = timed.value;
    return { ok: true, engine: job.pretendEngine ?? scan.engine ?? 'unset', counts: counts(scan), run: timed.run };
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
    clusters: (near.clusters ?? []).map((c) => c.files.map((f) => f.path)),
    decoder: near.decoder,
    available: near.available,
    reason: near.reason,
    truncated: near.truncated === true,
  };
}

function readJob(file: string | undefined): WorkerJob {
  if (!file) throw new Error('measureWorker: a job file is required');
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('measureWorker: the job is not an object');
  const j = parsed as Record<string, unknown>;
  if (!['enumerate', 'duplicates', 'neardup'].includes(String(j.suite))) throw new Error(`measureWorker: unknown suite ${String(j.suite)}`);
  if (typeof j.root !== 'string' || typeof j.outFile !== 'string') throw new Error('measureWorker: root and outFile are required');
  if (!['auto', 'gdu', 'walker'].includes(String(j.engine))) throw new Error(`measureWorker: unknown engine ${String(j.engine)}`);
  return parsed as WorkerJob;
}

if (require.main === module) {
  const job = readJob(process.argv[2]);
  main(job)
    .then((result) => {
      fs.writeFileSync(job.outFile, JSON.stringify(result));
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
