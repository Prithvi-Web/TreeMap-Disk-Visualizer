/**
 * memoryPathWorker — one T9 measurement, in a process of its own
 * (`memoryPath.ts` compiles it and starts it with this machine's Node or the
 * app's binary run as Node). A fresh process makes a peak this measurement's
 * own.
 *
 * The job arrives as a JSON file (argv[2]) and the result leaves as a JSON
 * file (`job.outFile`); stdout stays free for diagnostics. After each stage
 * it records the process's peak resident set (`getrusage` maxRSS), its
 * current memory, and on macOS its peak physical footprint (the harness's
 * probe). The app's server modules are loaded inside the job before anything
 * else, so the first stage, `loaded`, is the server's own baseline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import type { Response } from 'express';
import type * as NativeCore from '../../native/index';
import type { ScanModule } from '../../src/services/scan/native';
import { peakFootprint, snapshotUsage } from './rusage';
import { busyWhile, firstAnswer, type MemoryPathJob, type MemoryPathResult, type StageUsage } from './memoryPath';

type Job = MemoryPathJob & { module: string; outFile: string };

const job = JSON.parse(fs.readFileSync(process.argv[2] ?? '', 'utf8')) as Job;
const started = performance.now();
const stages: StageUsage[] = [];
const runtime = { node: process.versions.node, electron: process.versions.electron ?? null };
/** A TypeScript loader registers `.ts` with `require`; the packaged app has none. */
const typescriptLoader = '.ts' in require.extensions;
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

/**
 * The app's server modules, loaded as the server loads them — none started,
 * nothing listening — so every stage counts them, as the app's own process
 * does. Whether they are in memory.
 */
async function loadApp(): Promise<boolean> {
  await import('../../src/server');
  return Object.keys(require.cache).some((file) => file.endsWith(path.join('src', 'server.js')));
}

/**
 * A socket whose reader keeps up, as a local client's does: it takes each
 * chunk on the next turn, and pushes back past 16 KiB (a socket's own mark).
 * It counts the bytes and keeps the first 64 characters.
 */
function readerSocket(): { stream: Writable; bytes: () => number; head: () => string } {
  let bytes = 0;
  let head = '';
  const stream = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk: Buffer, _encoding, done): void {
      if (head.length < 64) head += chunk.subarray(0, 64 - head.length).toString('utf8');
      bytes += chunk.length;
      setImmediate(done);
    },
  });
  return { stream, bytes: () => bytes, head: () => head };
}

/**
 * The memory path over a synthetic tree or one on disk, as `runNativeWalk`'s
 * memory branch drives it, then the first tree sent as the app sends it.
 */
async function walk(source: Extract<MemoryPathJob, { kind: 'synthetic' | 'disk' }>): Promise<MemoryPathResult> {
  const serverLoaded = await loadApp();
  const { sendFinalEvent } = await import('../../src/api/scanRoutes');
  const { adoptNativeStore, memoryStoreOptions, takeNativeStore } = await import('../../src/services/scan/nativeMemory');
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
  // Taken as the app takes it: as it is where external buffers are allowed,
  // filled off the JavaScript thread where they are not (Electron, T9c).
  const { value: taken, busyMs: handOverBusyMs } = await busyWhile(() => takeNativeStore(core as unknown as ScanModule, handle));
  await measure('handed-over');
  const scan = createScanRecord(root);
  adoptNativeStore(scan, store, taken);
  store.sumSizes();
  await measure('adopted');
  // The progress stream's last frame, as the app sends it (`sendFinalEvent`:
  // the pruned tree from the store in chunks, Phase 4 T9b), to a socket whose
  // reader keeps up.
  scan.status = 'complete';
  scan.store = store;
  const socket = readerSocket();
  await sendFinalEvent(socket.stream as unknown as Response, scan);
  await measure('pruned');
  return {
    ok: true,
    runtime,
    stages,
    footprintSource,
    typescriptLoader,
    serverLoaded,
    counts: { scanned: scan.scanned ?? 0, dirs: scan.dirCount ?? 0, files: scan.fileCount ?? 0 },
    handOverBusyMs,
    frameBytes: socket.bytes(),
    frameHead: socket.head(),
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
  const serverLoaded = await loadApp();
  const { adoptNativeStore } = await import('../../src/services/scan/nativeMemory');
  const { PackedScanStore, Flag } = await import('../../src/services/scanStore');
  const { statToInput } = await import('../../src/services/scan/nodeInput');
  const { createScanRecord } = await import('../../src/services/diskScanner');
  await measure('loaded');
  const folders = Math.max(1, Math.ceil(files / FILES_PER_FOLDER));
  const n = 1 + folders + files;
  const capacity = n + 1_024;
  // Written straight into one pool: an array per name would hold a few
  // hundred bytes a name through the measurement, over a gigabyte at 5M.
  const nameOf = (id: number): string => {
    if (id === 0) return 'root';
    const f = id - 1;
    if (f < folders) return f % 2 === 0 ? `OneDrive ${f}` : `dossier ${f}`;
    return `fichier-é${f - folders}.TXT`;
  };
  let bytes = 0;
  for (let id = 0; id < n; id++) bytes += Buffer.byteLength(nameOf(id), 'utf8');
  const pool = new Uint8Array(bytes);
  const writer = Buffer.from(pool.buffer, pool.byteOffset, pool.byteLength);
  const nameOff = new Uint32Array(capacity + 1);
  let at = 0;
  for (let id = 0; id < n; id++) {
    nameOff[id] = at;
    at += writer.write(nameOf(id), at, 'utf8');
  }
  for (let id = n; id <= capacity; id++) nameOff[id] = at;
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
  return { ok: true, runtime, stages, footprintSource, typescriptLoader, serverLoaded, passes: { textCandidates: files, cloudCandidates: files, ms } };
}

/**
 * The addon loaded in a worker thread, as the full-pass runner will load it
 * (§S.5.7), and its version read there. With `mainFirst` this thread loads it
 * first, as the app's main thread does; without, the worker is its only
 * holder — the case in which Windows unmapped the addon when the worker's
 * environment ended (Node's Environment destructor closes every addon it
 * loaded) and the process then crashed, until tm-node pinned itself (RISKS R96).
 */
async function workerProbe(mainFirst: boolean): Promise<MemoryPathResult> {
  if (mainFirst) require(job.module);
  const mainHeldFirst = require.resolve(job.module) in require.cache;
  const code = "const { parentPort, workerData } = require('node:worker_threads'); parentPort.postMessage(require(workerData).version());";
  const worker = new Worker(code, { eval: true, workerData: job.module });
  try {
    const version = await firstAnswer(worker);
    // Said before the worker is terminated, so a process that dies there
    // leaves the harness a trace of how far it got (its no-result reason
    // carries stderr).
    process.stderr.write(`the worker thread answered ${String(version)}; terminating it\n`);
    return { ok: true, runtime, stages, footprintSource, typescriptLoader, workerVersion: String(version), mainHeldFirst };
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
      return workerProbe(job.mainFirst === true);
  }
}

main()
  .catch((err: unknown): MemoryPathResult => ({ ok: false, runtime, error: err instanceof Error ? err.stack ?? err.message : String(err) }))
  .then((result) => fs.writeFileSync(job.outFile, JSON.stringify(result)));
