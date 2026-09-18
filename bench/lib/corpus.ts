/**
 * corpus — a deterministic synthetic corpus for the benchmark harness.
 *
 * `planCorpus` turns a parameter set into typed arrays (no per-entry objects,
 * so a million entries plan in well under a second and a few tens of MB);
 * `createCorpus` writes that plan to disk with worker threads; `manifestFor`
 * states what was planted — the truth every engine is later checked against.
 * The plan is a pure function of its parameters and seed, and `planDigest`
 * in the manifest is the proof.
 *
 * On-disk contract: directory `k` is named `d${dirNameId[k]}` under its
 * parent (directory 0 is the root itself); file `i` is named `f${i}` inside
 * `dirs[fileDir[i]]`. Manifest paths are absolute, under a realpath'd root,
 * because the verify stage looks them up against the engine's own paths.
 *
 * `ensureCorpus` keeps every corpus under `os.tmpdir()/treemap-bench/` beside
 * a `manifest.json` (the tree itself is `tree/`, so the manifest never counts
 * as a scanned file) and refuses to remove anything outside that directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Worker } from 'node:worker_threads';
import { hash32, mulberry32 } from './prng';

/* ---------------- public surface ---------------- */

export interface CorpusParams {
  entries: number;          // files + directories (the root counts as a directory)
  fanout: number;           // max subdirectories per directory
  depth: number;            // max depth below the root
  flat: number;             // one directory with this many direct children (0 = none)
  sizeMedian: number;       // bytes, log-normal median
  sizeSigma: number;        // log-normal sigma (natural log)
  sizeMax: number;          // cap in bytes
  duplicateRate: number;    // fraction of files whose bytes equal an earlier file's
  hardlinkRate: number;     // fraction of files that are an extra name for an earlier file in the same directory
  sparseRate: number;       // fraction of files created with ftruncate only (no blocks)
  seed: number;
}

export interface CorpusPlan {
  params: CorpusParams;
  dirParent: Int32Array;    // per directory; directory 0 is the root and its parent is -1
  dirNameId: Uint32Array;   // name = `d${id}`
  fileDir: Int32Array;      // per file
  fileSize: Float64Array;   // bytes; a sparse file's logical size
  fileContent: Uint32Array; // content id; equal ids ⇒ identical bytes; 0 = no content (sparse)
  fileRole: Uint8Array;     // 0 plain, 1 duplicate, 2 hardlink (target = fileHardlinkOf), 3 sparse
  fileHardlinkOf: Int32Array; // target file index for role 2, else -1
}

export interface CorpusManifest {
  name: string;
  params: CorpusParams;
  createdAt: string;
  root: string;
  dirs: number;             // directories including the root
  files: number;            // file names, hard-link extra names included
  logicalBytes: number;     // hard-link extra names count 0 bytes, sparse files count their logical size
  duplicateGroups: Array<{ content: number; size: number; paths: string[] }>;   // groups with ≥ 2 members, one path per inode
  hardlinkFamilies: Array<{ target: string; links: string[] }>;
  sparseFiles: Array<{ path: string; logicalSize: number }>;
  flatDir: string | null;
  planDigest: string;       // sha256 of the typed arrays — the reproducibility proof
}

export interface CreateOptions {
  workers?: number;         // default min(8, cores)
  name?: string;            // manifest name; default the root's basename
}

/** The `fileRole` encoding. */
export const Role = { plain: 0, duplicate: 1, hardlink: 2, sparse: 3 } as const;

/** What one worker receives: a contiguous file range, the directory paths, and the plan's file arrays as SharedArrayBuffer views. */
export interface WorkerJob {
  start: number;
  end: number;
  dirPaths: string[];
  fileDir: Int32Array;
  fileSize: Float64Array;
  fileContent: Uint32Array;
  fileRole: Uint8Array;
  fileHardlinkOf: Int32Array;
}

export type WorkerReply =
  | { ok: true; written: number; bytes: number; deferredLinks: number }
  | { ok: false; error: string };

const KiB = 1024;
const MiB = 1024 * KiB;
const TWO_POW_32 = 4294967296;
const NO_INDEX = -1;
const ROOT_DIR = 0;
const FLAT_DIR = 1;
const DIRECTORY_SHARE = 0.12;
const SIZE_QUANTUM = KiB;
const QUANTISE_BELOW = 64 * KiB;
const SPARSE_MIN = 8 * MiB;
const SPARSE_SPAN = 56 * MiB;      // logical sizes lie in [8 MiB, 64 MiB)
const CONTENT_PREFIX_BYTES = 8;    // content id + size, so distinct ids are distinct bytes by construction
const MAX_WORKERS = 8;
const BENCH_DIR = 'treemap-bench';
const TREE_DIR = 'tree';
const MANIFEST_FILE = 'manifest.json';

export const CORPORA: Record<'enum200k' | 'enum1m' | 'dupes100k', CorpusParams> = Object.freeze({
  enum200k: Object.freeze({ entries: 200_000, fanout: 12, depth: 8, flat: 10_000, sizeMedian: 1024, sizeSigma: 1.2, sizeMax: 2 * MiB, duplicateRate: 0, hardlinkRate: 0.01, sparseRate: 0.001, seed: 2 }),
  enum1m: Object.freeze({ entries: 1_000_000, fanout: 12, depth: 8, flat: 10_000, sizeMedian: 1024, sizeSigma: 1.2, sizeMax: 2 * MiB, duplicateRate: 0, hardlinkRate: 0.01, sparseRate: 0.001, seed: 4 }),
  dupes100k: Object.freeze({ entries: 112_000, fanout: 10, depth: 6, flat: 0, sizeMedian: 8192, sizeSigma: 1.6, sizeMax: 64 * MiB, duplicateRate: 0.12, hardlinkRate: 0.005, sparseRate: 0.001, seed: 3 }),
});

/** File `index` is named this inside its directory. */
export function fileName(index: number): string {
  return `f${index}`;
}

/* ---------------- planning ---------------- */

function validateParams(params: CorpusParams): void {
  const integerAtLeast = (field: string, value: number, min: number): void => {
    if (!Number.isInteger(value) || value < min) throw new RangeError(`${field} must be an integer ≥ ${min}, got ${value}`);
  };
  const positive = (field: string, value: number): void => {
    if (!Number.isFinite(value) || value < 1) throw new RangeError(`${field} must be a finite number ≥ 1, got ${value}`);
  };
  const rate = (field: string, value: number): void => {
    if (!(value >= 0 && value <= 1)) throw new RangeError(`${field} must lie in [0, 1], got ${value}`);
  };
  integerAtLeast('entries', params.entries, 2);
  integerAtLeast('fanout', params.fanout, 1);
  integerAtLeast('depth', params.depth, 1);
  integerAtLeast('flat', params.flat, 0);
  if (!Number.isInteger(params.seed)) throw new RangeError(`seed must be an integer, got ${params.seed}`);
  positive('sizeMedian', params.sizeMedian);
  integerAtLeast('sizeMax', params.sizeMax, 1);   // it caps integer sizes, so a fractional cap would make fractional files
  if (!Number.isFinite(params.sizeSigma) || params.sizeSigma < 0) throw new RangeError(`sizeSigma must be a finite number ≥ 0, got ${params.sizeSigma}`);
  rate('duplicateRate', params.duplicateRate);
  rate('hardlinkRate', params.hardlinkRate);
  rate('sparseRate', params.sparseRate);
  const total = params.duplicateRate + params.hardlinkRate + params.sparseRate;
  if (total > 1) throw new RangeError(`duplicateRate + hardlinkRate + sparseRate must not exceed 1, got ${total}`);
}

interface DirectoryTree { dirParent: Int32Array; dirNameId: Uint32Array; flatDir: number }

/**
 * Breadth-first: each directory gets 1 + floor(rng·fanout) children while depth
 * allows, until about 12% of the entries are directories. The flat directory,
 * when asked for, is the root's first child and never gets subdirectories.
 * If fanout and depth cannot hold the target, the tree simply ends smaller.
 */
function planDirectories(params: CorpusParams, rng: () => number): DirectoryTree {
  const target = Math.max(params.flat > 0 ? 2 : 1, Math.round(params.entries * DIRECTORY_SHARE));
  const parent = new Int32Array(target);
  const depth = new Uint32Array(target);
  parent[ROOT_DIR] = NO_INDEX;
  let dirs = 1;
  let flatDir = NO_INDEX;
  if (params.flat > 0) {
    parent[FLAT_DIR] = ROOT_DIR;
    depth[FLAT_DIR] = 1;
    flatDir = FLAT_DIR;
    dirs = 2;
  }
  for (let d = 0; d < dirs && dirs < target; d++) {
    if (d === flatDir || depth[d] >= params.depth) continue;
    const children = 1 + Math.floor(rng() * params.fanout);
    for (let c = 0; c < children && dirs < target; c++) {
      parent[dirs] = d;
      depth[dirs] = depth[d] + 1;
      dirs++;
    }
  }
  const dirNameId = new Uint32Array(dirs);
  for (let d = 0; d < dirs; d++) dirNameId[d] = d;
  return { dirParent: dirs === target ? parent : parent.slice(0, dirs), dirNameId, flatDir };
}

/** Log-normal via Box–Muller, capped, and on 1 KiB steps below 64 KiB so plain files share sizes. */
function drawSize(params: CorpusParams, rng: () => number): number {
  const u1 = rng();
  const u2 = rng();
  const gauss = Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);
  const raw = Math.exp(Math.log(params.sizeMedian) + params.sizeSigma * gauss);
  const quantised = raw < QUANTISE_BELOW
    ? Math.max(SIZE_QUANTUM, Math.round(raw / SIZE_QUANTUM) * SIZE_QUANTUM)
    : Math.floor(raw);
  return Math.min(quantised, params.sizeMax);
}

/** A logical size in [8 MiB, 64 MiB) no earlier sparse file has: two same-sized sparse files would be identical zeros, an unplanted duplicate. */
function drawSparseSize(rng: () => number, taken: Set<number>): number {
  if (taken.size >= SPARSE_SPAN) throw new RangeError('more sparse files than distinct logical sizes');
  let size = SPARSE_MIN + Math.floor(rng() * SPARSE_SPAN);
  while (taken.has(size)) size = size + 1 < SPARSE_MIN + SPARSE_SPAN ? size + 1 : SPARSE_MIN;
  taken.add(size);
  return size;
}

type FilePlan = Pick<CorpusPlan, 'fileDir' | 'fileSize' | 'fileContent' | 'fileRole' | 'fileHardlinkOf'>;

function planFiles(params: CorpusParams, rng: () => number, dirs: number, flatDir: number, files: number): FilePlan {
  const fileDir = new Int32Array(files);
  const fileSize = new Float64Array(files);
  const fileContent = new Uint32Array(files);
  const fileRole = new Uint8Array(files);
  const fileHardlinkOf = new Int32Array(files).fill(NO_INDEX);
  const lastPlainInDir = new Int32Array(dirs).fill(NO_INDEX);
  const plainIndex = new Int32Array(files);
  let plainCount = 0;
  const sparseSizes = new Set<number>();
  const candidates = flatDir === NO_INDEX ? dirs : dirs - 1;
  const duplicateEdge = params.duplicateRate;
  const hardlinkEdge = duplicateEdge + params.hardlinkRate;
  const sparseEdge = hardlinkEdge + params.sparseRate;

  for (let i = 0; i < files; i++) {
    let dir: number;
    if (i < params.flat) {
      dir = flatDir;
    } else {
      const r = rng();
      const pick = Math.floor(candidates * r * r);          // skewed: a few directories are large, most are small
      dir = flatDir !== NO_INDEX && pick >= flatDir ? pick + 1 : pick;
    }
    fileDir[i] = dir;
    const size = drawSize(params, rng);
    const r = rng();
    const drawn = r < duplicateEdge ? Role.duplicate : r < hardlinkEdge ? Role.hardlink : r < sparseEdge ? Role.sparse : Role.plain;
    const role = (drawn === Role.duplicate && plainCount === 0) || (drawn === Role.hardlink && lastPlainInDir[dir] === NO_INDEX)
      ? Role.plain
      : drawn;

    if (role === Role.duplicate) {
      const target = plainIndex[Math.floor(rng() * plainCount)];
      fileRole[i] = Role.duplicate;
      fileContent[i] = fileContent[target];
      fileSize[i] = fileSize[target];
    } else if (role === Role.hardlink) {
      const target = lastPlainInDir[dir];
      fileRole[i] = Role.hardlink;
      fileHardlinkOf[i] = target;
      fileContent[i] = fileContent[target];
      fileSize[i] = fileSize[target];
    } else if (role === Role.sparse) {
      fileRole[i] = Role.sparse;
      fileContent[i] = 0;
      fileSize[i] = drawSparseSize(rng, sparseSizes);
    } else {
      fileRole[i] = Role.plain;
      fileContent[i] = i + 1;                                 // never 0
      fileSize[i] = size;
      lastPlainInDir[dir] = i;
      plainIndex[plainCount++] = i;
    }
  }
  return { fileDir, fileSize, fileContent, fileRole, fileHardlinkOf };
}

export function planCorpus(params: CorpusParams): CorpusPlan {
  validateParams(params);
  const rng = mulberry32(params.seed);
  const tree = planDirectories(params, rng);
  const dirs = tree.dirParent.length;
  const files = params.entries - dirs;
  if (files < 1) throw new RangeError(`${params.entries} entries leave no room for a file beside ${dirs} directories`);
  if (params.flat > files) throw new RangeError(`flat (${params.flat}) exceeds the ${files} files that ${params.entries} entries leave after ${dirs} directories`);
  return { params: { ...params }, dirParent: tree.dirParent, dirNameId: tree.dirNameId, ...planFiles(params, rng, dirs, tree.flatDir, files) };
}

/* ---------------- bytes ---------------- */

/**
 * The bytes of content id `content` at `size`: the id and the size in the
 * first two words (so two different ids never produce the same bytes at any
 * size of 4 or more; below that there are fewer possible outputs than ids), then
 * a `mulberry32(hash32(content, size))` stream, 4 bytes at a time. Identical
 * for identical ids; a plain file is never the all-zeros a sparse file reads as.
 */
export function contentBytes(content: number, size: number): Buffer {
  if (!Number.isInteger(content) || content < 0 || content > 0xffffffff) throw new RangeError(`content id must be a 32-bit unsigned integer, got ${content}`);
  if (!Number.isInteger(size) || size < 0) throw new RangeError(`size must be a non-negative integer, got ${size}`);
  const id = content >>> 0;
  const buf = Buffer.allocUnsafeSlow(size);                   // every byte is written below
  const header = Buffer.alloc(CONTENT_PREFIX_BYTES);
  header.writeUInt32LE(id, 0);
  header.writeUInt32LE(size >>> 0, 4);
  const prefix = Math.min(size, CONTENT_PREFIX_BYTES);
  header.copy(buf, 0, 0, prefix);
  const rng = mulberry32(hash32(id, size));
  let offset = prefix;
  for (; offset + 4 <= size; offset += 4) buf.writeUInt32LE((rng() * TWO_POW_32) >>> 0, offset);
  if (offset < size) {
    const tail = (rng() * TWO_POW_32) >>> 0;
    for (let shift = 0; offset < size; offset++, shift += 8) buf[offset] = (tail >>> shift) & 0xff;
  }
  return buf;
}

/* ---------------- manifest ---------------- */

function directoryPaths(plan: CorpusPlan, root: string): string[] {
  const paths: string[] = new Array<string>(plan.dirParent.length);
  paths[ROOT_DIR] = root;
  for (let d = 1; d < paths.length; d++) paths[d] = path.join(paths[plan.dirParent[d]], `d${plan.dirNameId[d]}`);   // parents precede children
  return paths;
}

function planDigest(plan: CorpusPlan): string {
  const hash = createHash('sha256');
  for (const arr of [plan.dirParent, plan.dirNameId, plan.fileDir, plan.fileSize, plan.fileContent, plan.fileRole, plan.fileHardlinkOf]) {
    hash.update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  }
  return hash.digest('hex');
}

/** Counting sort of file indices by a key in [0, keys): returns the sorted indices and the start offset of every key. */
function bucketBy(files: number, keys: number, keyOf: (i: number) => number): { sorted: Int32Array; offset: Uint32Array } {
  const count = new Uint32Array(keys + 1);
  for (let i = 0; i < files; i++) {
    const k = keyOf(i);
    if (k >= 0) count[k + 1]++;
  }
  for (let k = 0; k < keys; k++) count[k + 1] += count[k];
  const offset = count;                                       // offset[k] .. offset[k + 1] holds key k
  const fill = offset.slice();
  const sorted = new Int32Array(offset[keys]);
  for (let i = 0; i < files; i++) {
    const k = keyOf(i);
    if (k >= 0) sorted[fill[k]++] = i;
  }
  return { sorted, offset };
}

export function manifestFor(plan: CorpusPlan, root: string, name: string): CorpusManifest {
  const files = plan.fileDir.length;
  const dirPaths = directoryPaths(plan, root);
  const pathOf = (i: number): string => path.join(dirPaths[plan.fileDir[i]], fileName(i));

  let logicalBytes = 0;
  for (let i = 0; i < files; i++) if (plan.fileRole[i] !== Role.hardlink) logicalBytes += plan.fileSize[i];

  // content ids run 1..files; hard links share their target's inode and so are not group members
  const contentKeys = files + 2;
  const byContent = bucketBy(files, contentKeys, (i) => (plan.fileRole[i] === Role.plain || plan.fileRole[i] === Role.duplicate ? plan.fileContent[i] : NO_INDEX));
  const duplicateGroups: CorpusManifest['duplicateGroups'] = [];
  for (let content = 1; content < contentKeys; content++) {
    const start = byContent.offset[content];
    const end = byContent.offset[content + 1];
    if (end - start < 2) continue;
    const members = byContent.sorted.subarray(start, end);
    duplicateGroups.push({ content, size: plan.fileSize[members[0]], paths: Array.from(members, pathOf) });
  }

  const byTarget = bucketBy(files, files, (i) => (plan.fileRole[i] === Role.hardlink ? plan.fileHardlinkOf[i] : NO_INDEX));
  const hardlinkFamilies: CorpusManifest['hardlinkFamilies'] = [];
  for (let target = 0; target < files; target++) {
    const start = byTarget.offset[target];
    const end = byTarget.offset[target + 1];
    if (end === start) continue;
    hardlinkFamilies.push({ target: pathOf(target), links: Array.from(byTarget.sorted.subarray(start, end), pathOf) });
  }

  const sparseFiles: CorpusManifest['sparseFiles'] = [];
  for (let i = 0; i < files; i++) if (plan.fileRole[i] === Role.sparse) sparseFiles.push({ path: pathOf(i), logicalSize: plan.fileSize[i] });

  return {
    name,
    params: { ...plan.params },
    createdAt: new Date().toISOString(),
    root,
    dirs: plan.dirParent.length,
    files,
    logicalBytes,
    duplicateGroups,
    hardlinkFamilies,
    sparseFiles,
    flatDir: plan.params.flat > 0 ? dirPaths[FLAT_DIR] : null,
    planDigest: planDigest(plan),
  };
}

/* ---------------- creation ---------------- */

type PlanArray = Int32Array | Uint32Array | Uint8Array | Float64Array;

function sharedCopy<T extends PlanArray>(source: T): T {
  const Ctor = source.constructor as new (buffer: SharedArrayBuffer) => T;
  const copy = new Ctor(new SharedArrayBuffer(source.byteLength));
  copy.set(source);
  return copy;
}

function workerFile(): string {
  const ts = path.join(__dirname, 'corpusWorker.ts');
  return fs.existsSync(ts) ? ts : path.join(__dirname, 'corpusWorker.js');
}

function runWorker(job: WorkerJob): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile(), { workerData: job });
    let settled = false;
    worker.once('message', (reply: WorkerReply) => {
      settled = true;
      resolve(reply);
    });
    worker.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`corpus worker exited with code ${code} before replying`));
    });
  });
}

/**
 * Creates the plan under `root`: every directory from the main thread, then
 * the file range in contiguous chunks, one worker each, every worker in index
 * order. A hard link's target always precedes it in the same directory, so a
 * link whose target lies in another chunk is left to the main thread, which
 * creates it after every worker has finished.
 */
export async function createCorpus(root: string, plan: CorpusPlan, opts: CreateOptions = {}): Promise<CorpusManifest> {
  const files = plan.fileDir.length;
  const requested = opts.workers ?? Math.min(MAX_WORKERS, os.cpus().length);
  if (!Number.isInteger(requested) || requested < 1) throw new RangeError(`workers must be a positive integer, got ${requested}`);
  const workers = Math.min(requested, files);

  fs.mkdirSync(root, { recursive: true });
  const realRoot = fs.realpathSync(root);
  if (fs.readdirSync(realRoot).length > 0) throw new Error(`refusing to create a corpus in ${realRoot}: it is not empty`);
  const dirPaths = directoryPaths(plan, realRoot);
  for (let d = 1; d < dirPaths.length; d++) fs.mkdirSync(dirPaths[d]);   // parents precede children
  const pathOf = (i: number): string => path.join(dirPaths[plan.fileDir[i]], fileName(i));

  const shared = {
    fileDir: sharedCopy(plan.fileDir),
    fileSize: sharedCopy(plan.fileSize),
    fileContent: sharedCopy(plan.fileContent),
    fileRole: sharedCopy(plan.fileRole),
    fileHardlinkOf: sharedCopy(plan.fileHardlinkOf),
  };
  const chunkOf = (i: number): number => Math.floor((i * workers) / files);
  const jobs: WorkerJob[] = [];
  for (let start = 0, chunk = 0; start < files; chunk++) {
    let end = start;
    while (end < files && chunkOf(end) === chunk) end++;
    if (end > start) jobs.push({ start, end, dirPaths, ...shared });
    start = end;
  }

  const replies = await Promise.all(jobs.map(runWorker));
  for (const reply of replies) if (!reply.ok) throw new Error(`corpus worker failed: ${reply.error}`);

  for (let i = 0; i < files; i++) {
    if (plan.fileRole[i] !== Role.hardlink) continue;
    const target = plan.fileHardlinkOf[i];
    if (chunkOf(target) !== chunkOf(i)) fs.linkSync(pathOf(target), pathOf(i));
  }

  return manifestFor(plan, realRoot, opts.name ?? path.basename(realRoot));
}

/* ---------------- location and reuse ---------------- */

function canonicalParams(params: CorpusParams): string {
  const entries = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}

export function corpusDir(name: string, params: CorpusParams): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new RangeError(`corpus name ${JSON.stringify(name)} must be letters, digits, '.', '_' or '-'`);
  const hash8 = createHash('sha256').update(canonicalParams(params)).digest('hex').slice(0, 8);
  return path.join(os.tmpdir(), BENCH_DIR, `${name}-${hash8}`);
}

function isManifest(value: unknown): value is CorpusManifest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m.name === 'string'
    && typeof m.root === 'string'
    && typeof m.createdAt === 'string'
    && typeof m.planDigest === 'string'
    && typeof m.params === 'object' && m.params !== null
    && typeof m.dirs === 'number'
    && typeof m.files === 'number'
    && typeof m.logicalBytes === 'number'
    && Array.isArray(m.duplicateGroups)
    && Array.isArray(m.hardlinkFamilies)
    && Array.isArray(m.sparseFiles);
}

/** The manifest on disk, or null when there is none or it is not a manifest (either way the corpus is rebuilt). */
function readManifest(file: string): CorpusManifest | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isManifest(parsed) ? parsed : null;
}

/** Removes a corpus directory — and only a corpus directory: anything outside `os.tmpdir()/treemap-bench/` is refused. */
function removeCorpusDir(dir: string): void {
  const base = path.join(os.tmpdir(), BENCH_DIR);
  const relative = path.relative(base, dir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error(`refusing to remove ${dir}: corpora live only directly under ${base}`);
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Reuses `<corpusDir>/tree` when its `manifest.json` carries these params, a
 * plan digest the current planner still produces, and a root that exists;
 * otherwise removes the directory and builds the corpus again.
 */
export async function ensureCorpus(name: string, params: CorpusParams): Promise<CorpusManifest> {
  validateParams(params);
  const dir = corpusDir(name, params);
  const treeRoot = path.join(dir, TREE_DIR);
  const manifestPath = path.join(dir, MANIFEST_FILE);
  const plan = planCorpus(params);

  const existing = readManifest(manifestPath);
  if (existing && isDeepStrictEqual(existing.params, params) && existing.planDigest === planDigest(plan) && fs.existsSync(existing.root)) {
    return existing;
  }

  if (fs.existsSync(dir)) removeCorpusDir(dir);
  fs.mkdirSync(treeRoot, { recursive: true });
  const manifest = await createCorpus(treeRoot, plan, { name });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}
