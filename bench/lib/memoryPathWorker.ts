/**
 * memoryPathWorker — one T9 measurement, in a process of its own
 * (`memoryPath.ts` starts it under tsx with this machine's Node or the app's
 * binary run as Node). A fresh process makes a peak this measurement's own.
 *
 * The job arrives as a JSON file (argv[2]) and the result leaves as a JSON
 * file (`job.outFile`); stdout stays free for diagnostics. After each stage
 * it records the process's peak resident set (`getrusage` maxRSS), its
 * current memory, and on macOS its peak physical footprint (the harness's
 * probe). The app's modules are imported inside the job, so the first stage,
 * `loaded`, is the baseline with them in memory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type * as NativeCore from '../../native/index';
import { peakFootprint, snapshotUsage } from './rusage';
import { FIRST_PRUNE_NODES, type MemoryPathJob, type MemoryPathResult, type StageUsage } from './memoryPath';

type Job = MemoryPathJob & { module: string; outFile: string };

const job = JSON.parse(fs.readFileSync(process.argv[2] ?? '', 'utf8')) as Job;
const started = performance.now();
const stages: StageUsage[] = [];
const runtime = { node: process.versions.node, electron: process.versions.electron ?? null };
let footprintSource = 'no stage was measured';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** How often the walk is polled: the app's own cadence (NATIVE_POLL_MS). */
const POLL_MS = 10;

async function measure(stage: string): Promise<void> {
  const usage = await snapshotUsage();
  const memory = process.memoryUsage();
  const footprint = peakFootprint();
  footprintSource = footprint.reason;
  stages.push({
    stage,
    ms: performance.now() - started,
    peakRssBytes: usage.peakRssBytes,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    peakFootprintBytes: footprint.bytes,
  });
}

/** The addon at `job.module` through the app's own loader (and its version handshake), or the loader's reason. */
async function loadCore(): Promise<typeof NativeCore | string> {
  const { loadNative } = await import('../../src/services/scan/native');
  const loaded = loadNative({ path: job.module });
  return loaded.available ? (loaded.module as unknown as typeof NativeCore) : loaded.reason;
}

/** The memory path over a synthetic tree or one on disk, as `runNativeWalk`'s memory branch drives it. */
async function walk(source: Extract<MemoryPathJob, { kind: 'synthetic' | 'disk' }>): Promise<MemoryPathResult> {
  const { adoptNativeStore, memoryStoreOptions } = await import('../../src/services/scan/nativeMemory');
  const { rootName } = await import('../../src/services/scan/nativeEngine');
  const { PackedScanStore } = await import('../../src/services/scanStore');
  const { statToInput } = await import('../../src/services/scan/nodeInput');
  const { createScanRecord } = await import('../../src/services/diskScanner');
  const core = await loadCore();
  if (typeof core === 'string') return { ok: false, runtime, error: core };
  await measure('loaded');
  const root = source.kind === 'synthetic'
    ? path.join(core.syntheticTempFolder(), `memory-path-${source.entries}-${process.pid}`)
    : source.root;
  const mtime = source.kind === 'disk' ? fs.lstatSync(root).mtimeMs : Date.now();
  const store = new PackedScanStore(root, path.sep, statToInput(rootName(root), true, 0, mtime));
  const handle = core.scanStart(root, {
    neverDescend: [],
    wantAtime: true,
    ...(source.kind === 'synthetic' ? { synthetic: { entries: source.entries, seed: source.seed } } : {}),
    storage: 'memory',
    store: memoryStoreOptions(store),
  });
  while (!core.scanPoll(handle).done) await sleep(POLL_MS);
  const error = core.scanPoll(handle).error;
  if (error) return { ok: false, runtime, error };
  await measure('walked');
  const taken = await core.storeTake(handle);
  await measure('handed-over');
  const scan = createScanRecord(root);
  adoptNativeStore(scan, store, taken);
  store.sumSizes();
  await measure('adopted');
  const json = JSON.stringify(store.prune(store.rootId, { maxNodes: FIRST_PRUNE_NODES }).root);
  await measure('pruned');
  return {
    ok: true,
    runtime,
    stages,
    footprintSource,
    counts: { scanned: scan.scanned ?? 0, dirs: scan.dirCount ?? 0, files: scan.fileCount ?? 0 },
    prunedJsonBytes: json.length,
  };
}

/** Folders the candidates store spreads its files over: one per this many files. */
const FILES_PER_FOLDER = 1_000;

/**
 * Node's passes alone: a store as the native build hands it over — built here
 * in JavaScript — whose every file has a name with a non-ASCII byte and a dot
 * and claims bytes with none allocated, so every file is a text candidate and
 * a cloud candidate; half the folders are named like a OneDrive folder.
 */
async function candidates(files: number): Promise<MemoryPathResult> {
  const { adoptNativeStore } = await import('../../src/services/scan/nativeMemory');
  const { PackedScanStore, Flag } = await import('../../src/services/scanStore');
  const { statToInput } = await import('../../src/services/scan/nodeInput');
  const { createScanRecord } = await import('../../src/services/diskScanner');
  await measure('loaded');
  const folders = Math.max(1, Math.ceil(files / FILES_PER_FOLDER));
  const n = 1 + folders + files;
  const capacity = n + 1_024;
  const encoder = new TextEncoder();
  const names: Uint8Array[] = [encoder.encode('root')];
  for (let f = 0; f < folders; f++) names.push(encoder.encode(f % 2 === 0 ? `OneDrive ${f}` : `dossier ${f}`));
  for (let i = 0; i < files; i++) names.push(encoder.encode(`fichier-é${i}.TXT`));
  const nameOff = new Uint32Array(capacity + 1);
  let at = 0;
  names.forEach((bytes, id) => { nameOff[id] = at; at += bytes.length; });
  for (let id = n; id <= capacity; id++) nameOff[id] = at;
  const pool = new Uint8Array(at);
  names.forEach((bytes, id) => pool.set(bytes, nameOff[id]));
  const parent = new Int32Array(capacity);
  const size = new Float64Array(capacity);
  const flags = new Uint16Array(capacity);
  const childStart = new Uint32Array(capacity);
  const childCnt = new Uint32Array(capacity);
  parent[0] = -1;
  flags[0] = Flag.Dir | Flag.HasChildArray;
  childStart[0] = 1;
  childCnt[0] = folders;
  const fileIds = new Uint32Array(files);
  for (let f = 0; f < folders; f++) {
    const folder = 1 + f;
    parent[folder] = 0;
    flags[folder] = Flag.Dir | Flag.HasChildArray;
    const first = Math.min(files, f * FILES_PER_FOLDER);
    const last = Math.min(files, first + FILES_PER_FOLDER);
    childStart[folder] = 1 + folders + first;
    childCnt[folder] = last - first;
    for (let i = first; i < last; i++) {
      const id = 1 + folders + i;
      parent[id] = folder;
      size[id] = 4_096 + (i % 997);
      fileIds[i] = id;
    }
  }
  const taken: NativeCore.NativeStore = {
    n,
    capacity,
    parent,
    size,
    mtime: new Float64Array(capacity),
    flags,
    ext: new Uint16Array(capacity),
    container: new Uint8Array(capacity),
    cloudProv: new Uint8Array(capacity),
    nameOff,
    names: pool,
    namesLen: at,
    childStart,
    childCnt,
    extDict: [''],
    extOverflowIds: new Uint32Array(0),
    extOverflowTexts: [],
    cloudCandidates: fileIds,
    textCandidates: fileIds,
    sparseTermIds: new Uint32Array(0),
    sparseTermBytes: new Float64Array(0),
    counters: {
      dirs: 1 + folders, files, hardlinkedFiles: 0, hardlinkedBytes: 0, cloudFiles: 0, cloudBytes: 0,
      sparseFiles: 0, sparseBytes: 0, slackBytes: 0, deniedDirs: [], vanishedDirs: 0, unreadableDirs: 0,
    },
    stats: {
      dirsListed: 1 + folders, entries: n - 1, wallMs: 0, cpuSeconds: null, fastPath: 'unavailable',
      workersPeak: 0, climbSteps: 0, deniedEntries: 0, unreadableEntries: 0, dataless: 0,
    },
  };
  await measure('built');
  const store = new PackedScanStore('/candidates/root', '/', statToInput('root', true, 0, 0));
  const scan = createScanRecord('/candidates/root');
  const before = performance.now();
  adoptNativeStore(scan, store, taken);
  const ms = performance.now() - before;
  await measure('adopted');
  return { ok: true, runtime, stages, footprintSource, passes: { textCandidates: files, cloudCandidates: files, ms } };
}

/** The addon loaded in a worker thread, as the full-pass runner will load it (§S.5.7), and its version read there. */
async function workerProbe(): Promise<MemoryPathResult> {
  const code = "const { parentPort, workerData } = require('node:worker_threads'); parentPort.postMessage(require(workerData).version());";
  const worker = new Worker(code, { eval: true, workerData: job.module });
  try {
    const version = await new Promise<unknown>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    return { ok: true, runtime, stages, footprintSource, workerVersion: String(version) };
  } finally {
    await worker.terminate();
  }
}

async function main(): Promise<MemoryPathResult> {
  switch (job.kind) {
    case 'synthetic':
    case 'disk':
      return walk(job);
    case 'candidates':
      return candidates(job.entries);
    case 'worker-probe':
      return workerProbe();
  }
}

main()
  .catch((err: unknown): MemoryPathResult => ({ ok: false, runtime, error: err instanceof Error ? err.stack ?? err.message : String(err) }))
  .then((result) => fs.writeFileSync(job.outFile, JSON.stringify(result)));
