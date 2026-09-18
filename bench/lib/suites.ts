/**
 * The three suites, driving the REAL engines in-process — `startScan`,
 * `getDuplicateJob`, `getNearDupeJob` — never a re-implementation of them.
 *
 * `TREEMAP_DATA_DIR` must be isolated by the caller BEFORE this module is
 * imported (scans write caches and snapshots into it). `bench/run.ts` and the
 * tests both do that at their top.
 */
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { cacheState, defaultPurge } from './cache';
import type { CorpusManifest } from './corpus';
import type { ImageManifest } from './images';
import { scoreClusters } from './images';
import { describeMachine } from './machine';
import { diffUsage, snapshotUsage } from './rusage';
import { summarize, type BenchResult, type BenchRun } from './report';
import { checkDuplicatesAgainstManifest, checkScanAgainstManifest } from './verify';
import { startScan, cancelAllScans } from '../../src/services/diskScanner';
import type { ScanResult } from '../../src/models/types';
import { findGduBinary, type FindOptions } from '../../src/services/gduScanner';
import { getDuplicateJob } from '../../src/services/duplicateFinder';
import { getNearDupeJob } from '../../src/services/perceptualDupes';
import { storeOf } from '../../src/services/scanStore';

export type EngineChoice = 'auto' | 'gdu' | 'walker';

export interface EnumerateOptions {
  manifest: CorpusManifest;
  corpusName: string;
  engine: EngineChoice;
  runs: number;
  cache: 'warm' | 'cold';
  label: string;
  /** Test hook: where to look for gdu (a nonexistent `bundledPath` with `pathLookup: false` means "no binary"). */
  gduFind?: FindOptions;
  purge?: () => Promise<{ ok: boolean; command: string; error?: string }>;
}

const POLL_MS = 25;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function settled(scan: ScanResult): Promise<ScanResult> {
  while (scan.status === 'running') await sleep(POLL_MS);
  if (scan.status === 'error') throw new Error(`scan failed: ${scan.error ?? 'unknown'}`);
  return scan;
}

/** Forces the engine choice the way the app itself does: through the env gate. */
async function selectEngine(engine: EngineChoice, gduFind: FindOptions): Promise<void> {
  if (engine === 'walker') {
    process.env.TREEMAP_NO_GDU = '1';
    return;
  }
  delete process.env.TREEMAP_NO_GDU;
  if (engine === 'gdu') {
    const bin = await findGduBinary(gduFind);
    if (!bin) throw new Error('gdu was requested but no gdu binary is available (bundled, ./gdu, or $PATH); run `npm run fetch:gdu:dev` first');
  }
}

async function measuredScan(root: string): Promise<{ scan: ScanResult; run: BenchRun }> {
  const before = await snapshotUsage();
  const t0 = performance.now();
  const scan = await settled(await startScan(root));
  const wallMs = performance.now() - t0;
  const after = await snapshotUsage();
  const d = diffUsage(before, after);
  return {
    scan,
    run: {
      wallMs,
      entries: scan.scanned,
      cpuSeconds: d.cpuSeconds,
      childCpuSeconds: d.childCpuSeconds,
      peakRssBytes: d.peakRssBytes,
      bytesRead: d.bytesRead,
      loadAvg: os.loadavg(),
    },
  };
}

function rootSizeOf(scan: ScanResult): number {
  const store = storeOf(scan);
  return store.size(store.rootId);
}

export async function runEnumerate(opts: EnumerateOptions): Promise<BenchResult> {
  await selectEngine(opts.engine, opts.gduFind ?? {});
  const machine = await describeMachine();
  const entries = opts.manifest.files + opts.manifest.dirs;
  const purge = opts.purge ?? defaultPurge;

  let warmedUp = false;
  if (opts.cache === 'warm') {
    const warm = await measuredScan(opts.manifest.root);
    cancelAllScans();
    warmedUp = warm.scan.status === 'complete';
  }
  const cache = await cacheState({ requested: opts.cache, purge, entries, maxVnodes: machine.maxVnodes ?? undefined, warmedUp });

  const runs: BenchRun[] = [];
  let engine = 'unknown';
  let correctness: BenchResult['correctness'] = { ok: true, notes: [] };
  for (let i = 0; i < opts.runs; i++) {
    if (opts.cache === 'cold' && i > 0) {
      const again = await purge();
      if (!again.ok) correctness.notes.push(`run ${i + 1}: the cache could not be purged again (${again.error ?? 'unknown'}); this run is not cold`);
    }
    const { scan, run } = await measuredScan(opts.manifest.root);
    engine = scan.engine ?? 'walker';
    if (i === 0) {
      correctness = checkScanAgainstManifest(opts.manifest, {
        fileCount: scan.fileCount,
        dirCount: scan.dirCount,
        rootSize: rootSizeOf(scan),
        scanned: scan.scanned,
      });
    }
    runs.push(run);
    cancelAllScans();
  }

  return {
    suite: 'enumerate',
    corpus: { name: opts.corpusName, params: opts.manifest.params, dirs: opts.manifest.dirs, files: opts.manifest.files, scale: scaleOf(entries) },
    engine,
    machine,
    cache,
    runs,
    summary: summarize(runs),
    correctness,
    recordedAt: new Date().toISOString(),
    commit: machine.commit,
    label: opts.label,
  };
}

function scaleOf(entries: number): string {
  if (entries >= 900_000) return '1M entries: the prompt\'s full enumeration size';
  if (entries >= 180_000) return '200k entries: fits this Mac\'s vnode cache (kern.maxvnodes)';
  return `${entries.toLocaleString('en-US')} entries`;
}

export interface DuplicatesOptions {
  manifest: CorpusManifest;
  corpusName: string;
  runs: number;
  minSize: number;
  label: string;
}

export async function runDuplicates(opts: DuplicatesOptions): Promise<BenchResult> {
  const machine = await describeMachine();
  const runs: BenchRun[] = [];
  let correctness: BenchResult['correctness'] = { ok: true, notes: [] };
  process.env.TREEMAP_NO_GDU = '1'; // the walker keys hard links on dev+ino; the corpus plants families
  for (let i = 0; i < opts.runs; i++) {
    const scan = await settled(await startScan(opts.manifest.root));
    const before = await snapshotUsage();
    const t0 = performance.now();
    const job = getDuplicateJob(scan, opts.minSize);
    while (job.status === 'running') await sleep(POLL_MS);
    const wallMs = performance.now() - t0;
    const after = await snapshotUsage();
    if (job.status === 'error') throw new Error(`duplicate job failed: ${job.error ?? 'unknown'}`);
    const d = diffUsage(before, after);
    runs.push({ wallMs, entries: scan.fileCount, cpuSeconds: d.cpuSeconds, childCpuSeconds: d.childCpuSeconds, peakRssBytes: d.peakRssBytes, bytesRead: d.bytesRead, loadAvg: os.loadavg() });
    if (i === 0) {
      const reported = job.groups ?? [];
      const check = checkDuplicatesAgainstManifest(opts.manifest, reported, opts.minSize);
      correctness = {
        ok: check.ok,
        notes: [
          `recall ${check.recall.toFixed(4)} over ${check.expectedGroups} planted groups at or above ${opts.minSize} B; precision ${check.precision.toFixed(4)} over ${reported.length} reported groups (${job.groupCount ?? reported.length} found, ${reported.length} reported); ${check.falsePositives} false positives by byte comparison; ${check.missedGroups} missed`,
          ...check.notes,
        ],
      };
    }
    cancelAllScans();
  }
  return {
    suite: 'duplicates',
    corpus: { name: opts.corpusName, params: opts.manifest.params, dirs: opts.manifest.dirs, files: opts.manifest.files, scale: `${opts.manifest.files.toLocaleString('en-US')} files, ${(opts.manifest.logicalBytes / 1e9).toFixed(2)} GB — the prompt's corpus is 1M files / 500 GB` },
    engine: 'sha256-staged (size → 64 KiB → full)',
    machine,
    cache: { state: 'warm', reason: 'the duplicate pass runs after the scan; the corpus was written by this harness and is in the page cache unless the machine evicted it' },
    runs,
    summary: summarize(runs),
    correctness,
    recordedAt: new Date().toISOString(),
    commit: machine.commit,
    label: opts.label,
  };
}

export interface NearDupOptions {
  manifest: ImageManifest;
  corpusName: string;
  runs: number;
  threshold: number;
  label: string;
}

export async function runNearDup(opts: NearDupOptions): Promise<BenchResult> {
  const machine = await describeMachine();
  const runs: BenchRun[] = [];
  let correctness: BenchResult['correctness'] = { ok: true, notes: [] };
  process.env.TREEMAP_NO_GDU = '1';
  for (let i = 0; i < opts.runs; i++) {
    const scan = await settled(await startScan(opts.manifest.root));
    const before = await snapshotUsage();
    const t0 = performance.now();
    const job = getNearDupeJob(scan, opts.threshold);
    while (job.status === 'running') await sleep(POLL_MS);
    const wallMs = performance.now() - t0;
    const after = await snapshotUsage();
    if (job.status === 'error') throw new Error(`near-duplicate job failed: ${job.error ?? 'unknown'}`);
    const d = diffUsage(before, after);
    runs.push({ wallMs, entries: opts.manifest.images.length, cpuSeconds: d.cpuSeconds, childCpuSeconds: d.childCpuSeconds, peakRssBytes: d.peakRssBytes, bytesRead: d.bytesRead, loadAvg: os.loadavg() });
    if (i === 0) {
      const clusters = (job.clusters ?? []).map((c) => c.files.map((f) => f.path));
      const score = scoreClusters(opts.manifest, clusters);
      const recallLines = (Object.entries(score.recall) as Array<[string, number]>).map(([t, r]) => `${t} ${r.toFixed(3)}`);
      correctness = {
        ok: job.available && !job.truncated,
        notes: [
          `decoder ${job.decoder}; available ${job.available}${job.reason ? ` (${job.reason})` : ''}; truncated ${job.truncated} (the legacy job caps candidates at 8,000 images)`,
          `precision ${score.precision.toFixed(4)} over ${score.pairs} same-cluster pairs; recall by transform: ${recallLines.join(', ')}`,
        ],
      };
    }
    cancelAllScans();
  }
  return {
    suite: 'neardup',
    corpus: { name: opts.corpusName, params: opts.manifest.params, images: opts.manifest.images.length, scale: `${opts.manifest.images.length.toLocaleString('en-US')} images — the prompt's corpus is 200k` },
    engine: 'dhash-pairwise (sharp 9×8, O(n²) union-find)',
    machine,
    cache: { state: 'warm', reason: 'the images were written by this harness and decoded from the page cache unless the machine evicted them' },
    runs,
    summary: summarize(runs),
    correctness,
    recordedAt: new Date().toISOString(),
    commit: machine.commit,
    label: opts.label,
  };
}
