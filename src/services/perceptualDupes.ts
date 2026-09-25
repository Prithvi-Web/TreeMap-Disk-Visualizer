import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import { promisify } from 'util';
import { ScanResult, NearDupeCluster, NearDupeJob } from '../models/types';
import { storeOf, Flag } from './scanStore';
import { stillLocal } from './dataLocality';

/** The fields a candidate image needs once the cap has landed. */
interface CandidateImage {
  name: string;
  path: string;
  size: number;
  modifiedAt: number;
}
import { peekScan } from './diskScanner';

/**
 * PerceptualDupes — near-duplicate IMAGE detection (Feature 12).
 *
 * The SHA-256 finder only catches byte-identical files. This pass catches
 * resized, re-encoded and screenshot copies by comparing a 64-bit dHash of
 * each image:
 *
 *   1. decode → 9×8 grayscale (8 rows × 9 cols)
 *   2. per row, compare adjacent pixels → 8 bits/row → 64-bit fingerprint
 *   3. two images are "near" when their dHashes differ by ≤ threshold bits
 *
 * Decoding is best-effort: `sharp` if present (prebuilt, fast), else an
 * `ffmpeg` shell-out, else the feature reports itself unavailable rather than
 * crashing. Hashing + O(n²) clustering run as a background job per scanId,
 * polled exactly like the exact-duplicate finder.
 *
 * Nothing is decoded that would make a sync client download it (the master
 * prompt §3.2, RISKS R1 and R71), by the exact finder's rule: a cloud
 * placeholder or a link is never a candidate, and a candidate is asked about
 * again just before the decodes begin.
 */

/** Image types we fingerprint. Exported so the duplicate viewer (§8.2) asks
 * "is this an image?" with the SAME answer this pass would give. */
export const IMAGE_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'heic', 'heif', 'avif',
]);
/** Skip favicon-sized junk so tiny sprites don't drown out real photos. */
const MIN_IMAGE_BYTES = 4 * 1024;
/** Bound the O(n²) clustering; largest images are kept when over the cap. */
const MAX_IMAGES = 8000;
/** Paths per locality ask: one synchronous native call each, with the event loop let through between them. */
const LOCALITY_CHUNK = 256;

/** dHash stored as two 32-bit halves so Hamming distance avoids slow BigInt.
 * Bit i of the 64 (0–63) lives in `lo` for i<32, else in `hi` at i−32, and
 * corresponds to row ⌊i/8⌋, col i%8 of the 8×8 comparison grid. */
export type DHash = [hi: number, lo: number];

/** Test-only: told of every image path this pass or the duplicate viewer hands to a decoder, before it is handed over. */
let imageOpenObserver: ((file: string) => void) | null = null;

/** Test-only: watch what this pass and the duplicate viewer open (null stops watching). */
export function observeImageOpensForTests(observer: ((file: string) => void) | null): void {
  imageOpenObserver = observer;
}

/**
 * `filePath`, on its way to a decoder. This pass and the duplicate viewer
 * hand an image path to sharp or ffmpeg only wrapped in this — the
 * fingerprint (hashImage) and the viewer's header read — so a test hears of
 * each of their opens before it happens, one whose decode then fails
 * included. (makeThumbnail, the thumbnail cache's renderer, is not one of
 * them.)
 */
export function openingImage(filePath: string): string {
  imageOpenObserver?.(filePath);
  return filePath;
}

const jobs = new Map<string, NearDupeJob>();

export function cancelAllNearDupeJobs(): void {
  for (const job of jobs.values()) job.cancelled = true;
  jobs.clear();
}

/**
 * Get (or start) the near-duplicate job for a scan + threshold. Re-uses a
 * finished job on later polls; a changed threshold supersedes the old job.
 */
export function getNearDupeJob(scan: ScanResult, threshold: number): NearDupeJob {
  // Evict jobs whose scan has been evicted so the map can't grow forever.
  // peekScan, not getScan: housekeeping is not the user reading those scans.
  for (const [scanId, job] of jobs) {
    if (!peekScan(scanId)) {
      job.cancelled = true;
      jobs.delete(scanId);
    }
  }

  const existing = jobs.get(scan.scanId);
  if (existing && existing.threshold === threshold && existing.status !== 'error') {
    return existing;
  }
  if (existing) existing.cancelled = true;

  const job: NearDupeJob = {
    scanId: scan.scanId,
    status: 'running',
    threshold,
    decoder: 'none',
    available: true,
    hashed: 0,
    toHash: 0,
    cancelled: false,
    startedAt: Date.now(),
  };
  jobs.set(scan.scanId, job);

  void runJob(scan, job).catch((err: unknown) => {
    job.status = 'error';
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
  });

  return job;
}

async function runJob(scan: ScanResult, job: NearDupeJob): Promise<void> {
  if (!scan.store && !scan.root) throw new Error('Scan has no result tree');
  const store = storeOf(scan);

  const decoder = await detectDecoder();
  job.decoder = decoder;
  if (decoder === 'none') {
    job.available = false;
    job.reason = 'No image decoder available — install the "sharp" package or ffmpeg to find near-duplicate images.';
    finishEmpty(job);
    return;
  }

  // Collect candidate images, largest first; cap to bound the O(n²) pass.
  // Candidates carry bare ids until the cap lands; only the kept set
  // materializes names and paths.
  const candidates: { id: number; size: number }[] = [];
  store.eachFile(store.rootId, (id) => {
    const size = store.size(id);
    if (size < MIN_IMAGE_BYTES) return;
    if (store.flag(id, Flag.HardlinkDup) || store.flag(id, Flag.Symlink) || store.flag(id, Flag.CloudPlaceholder)) return;
    const ext = store.extension(id);
    if (ext && IMAGE_EXT.has(ext)) candidates.push({ id, size });
  });
  candidates.sort((a, b) => b.size - a.size);
  let truncated = false;
  if (candidates.length > MAX_IMAGES) {
    candidates.length = MAX_IMAGES;
    truncated = true;
  }
  // Decoding an online-only file downloads it, and a sync client can evict a
  // file after its scan (RISKS R71), so just before any decode each kept
  // image is asked about again — of its directory entry, never the file —
  // a chunk at a time, so a long list never holds the event loop. One whose
  // data has left is left out as a placeholder is. One nobody could vouch
  // for is left out too (no answer is not a yes), and that is a gap in the
  // answer, so the job says how many; with none compared at all it is
  // unavailable, since an empty list would read as "none found".
  const local = new Set<number>();
  let unconfirmed = 0;
  for (let at = 0; at < candidates.length; at += LOCALITY_CHUNK) {
    if (at > 0) await new Promise<void>((resolve) => setImmediate(resolve));
    if (job.cancelled) return;
    const chunk = candidates.slice(at, at + LOCALITY_CHUNK).map((c) => c.id);
    const settled = new Set<number>();
    for (const id of stillLocal(chunk, (i) => store.path(i), (i) => { settled.add(i); })) {
      local.add(id);
      settled.add(id);
    }
    // No answer is not a yes. It is not "could be online-only" either when
    // the entry is simply gone: nothing updates a scan when its files are
    // trashed, and the ask answers "could not tell" for a missing path.
    for (const id of chunk) {
      if (settled.has(id)) continue;
      if (await deletedSinceScan(store.path(id))) continue;
      unconfirmed++;
    }
  }
  if (unconfirmed > 0 && local.size === 0) {
    job.available = false;
    job.reason = 'No image was compared: TreeMap could not confirm that the images are on this disk, and opening one that is online-only would download it. Near-duplicates are unknown here, not none.';
    finishEmpty(job);
    return;
  }
  if (unconfirmed > 0) {
    job.reason = unconfirmed === 1
      ? '1 image was not compared: TreeMap could not confirm its data is on this disk, and opening it could download it.'
      : `${unconfirmed} images were not compared: TreeMap could not confirm their data is on this disk, and opening one could download it.`;
  }
  const images: CandidateImage[] = candidates.filter((c) => local.has(c.id)).map(({ id, size }) => ({
    name: store.name(id),
    path: store.path(id),
    size,
    modifiedAt: store.modifiedAt(id),
  }));
  job.toHash = images.length;

  // Hash each image; null = unreadable/undecodable (dropped silently).
  const concurrency = decoder === 'sharp' ? 4 : 2;
  const hashes = await mapConcurrent(images, concurrency, (f) => hashImage(f.path, decoder), job);
  if (job.cancelled) return;

  type Entry = { file: CandidateImage; hash: DHash };
  const entries: Entry[] = [];
  for (let i = 0; i < images.length; i++) {
    const h = hashes[i];
    if (h) entries.push({ file: images[i]!, hash: h });
  }

  // Cluster by Hamming distance ≤ threshold with union-find (transitive groups).
  const n = entries.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (let i = 0; i < n; i++) {
    const hi = entries[i]!.hash;
    for (let j = i + 1; j < n; j++) {
      if (hamming(hi, entries[j]!.hash) <= job.threshold) {
        const ra = find(i);
        const rb = find(j);
        if (ra !== rb) parent[ra] = rb;
      }
    }
    if ((i & 511) === 0 && job.cancelled) return;
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }

  const clusters: NearDupeCluster[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    // Newest first — the newest copy is the one "auto-select" keeps.
    idxs.sort((a, b) => entries[b]!.file.modifiedAt - entries[a]!.file.modifiedAt);
    const repHash = entries[idxs[0]!]!.hash;
    const files = idxs.map((i) => {
      const f = entries[i]!.file;
      return {
        name: f.name,
        path: f.path,
        size: f.size,
        modifiedAt: f.modifiedAt,
        distance: hamming(entries[i]!.hash, repHash),
      };
    });
    const reclaimableBytes = files.slice(1).reduce((s, f) => s + f.size, 0);
    clusters.push({ files, count: files.length, reclaimableBytes });
  }
  clusters.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);

  job.clusterCount = clusters.length;
  job.totalReclaimable = clusters.reduce((s, c) => s + c.reclaimableBytes, 0);
  // Every cluster is returned. MAX_IMAGES already bounds the input, so at most
  // MAX_IMAGES/2 clusters can exist and the response is inherently capped —
  // while slicing here dropped groups the user could act on WITHOUT setting
  // `truncated`, so they simply vanished with nothing to indicate it.
  job.clusters = clusters;
  job.truncated = truncated; // reflects the MAX_IMAGES cap only
  job.status = 'complete';
  job.finishedAt = Date.now();
}

/** Is the directory entry gone? Only a definite "no such entry" counts; any other failure is not an answer. */
async function deletedSinceScan(filePath: string): Promise<boolean> {
  try {
    await fsp.lstat(filePath);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

function finishEmpty(job: NearDupeJob): void {
  job.clusters = [];
  job.clusterCount = 0;
  job.totalReclaimable = 0;
  job.status = 'complete';
  job.finishedAt = Date.now();
}

/* ---------- dHash + Hamming ---------- */

/** Build a 64-bit dHash from a row-major 9×8 grayscale buffer (72 bytes). */
function dhashFromGray(px: Buffer): DHash {
  let hi = 0;
  let lo = 0;
  let bit = 0;
  for (let row = 0; row < 8; row++) {
    const base = row * 9;
    for (let col = 0; col < 8; col++) {
      const on = px[base + col + 1]! > px[base + col]! ? 1 : 0;
      if (on) {
        if (bit < 32) lo = (lo | (1 << bit)) >>> 0;
        else hi = (hi | (1 << (bit - 32))) >>> 0;
      }
      bit++;
    }
  }
  return [hi >>> 0, lo >>> 0];
}

function popcount32(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  n = (n + (n >>> 4)) & 0x0f0f0f0f;
  return (n * 0x01010101) >>> 24;
}

export function hamming(a: DHash, b: DHash): number {
  return popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
}

/* ---------- Decoders (best-effort) ---------- */

// sharp ships dual ESM/CJS typings; under `require` it returns the callable
// factory directly, so unwrap a possible `default` to recover its call type.
type SharpNamespace = typeof import('sharp');
type SharpFactory = SharpNamespace extends { default: infer F } ? F : SharpNamespace;
let sharpCache: SharpFactory | null | undefined;
export function loadSharp(): SharpFactory | null {
  if (sharpCache !== undefined) return sharpCache;
  try {
    sharpCache = require('sharp') as unknown as SharpFactory;
  } catch {
    sharpCache = null;
  }
  return sharpCache;
}

const exec = promisify(execFile);
let ffmpegCache: boolean | undefined;
async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegCache !== undefined) return ffmpegCache;
  try {
    await exec('ffmpeg', ['-version'], { timeout: 5000 });
    ffmpegCache = true;
  } catch {
    ffmpegCache = false;
  }
  return ffmpegCache;
}

let decoderCache: NearDupeJob['decoder'] | undefined;
export async function detectDecoder(): Promise<NearDupeJob['decoder']> {
  if (decoderCache !== undefined) return decoderCache;
  if (loadSharp()) decoderCache = 'sharp';
  else if (await hasFfmpeg()) decoderCache = 'ffmpeg';
  else decoderCache = 'none';
  return decoderCache;
}

/**
 * Render a small WebP thumbnail of any raster image sharp can decode (incl.
 * TIFF/BMP/HEIC that browsers can't show inline). Returns null if sharp is
 * unavailable or the image can't be decoded — callers fall back gracefully.
 */
export async function makeThumbnail(filePath: string, size = 256): Promise<Buffer | null> {
  const sharp = loadSharp();
  if (!sharp) return null;
  try {
    return await sharp(filePath, { failOn: 'none', animated: false })
      .rotate() // honour EXIF orientation
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
  } catch {
    return null;
  }
}

/** Decode one image to a dHash, or null if it can't be read/decoded.
 * Exported for the duplicate viewer (§8.2): one fingerprint implementation,
 * never a second one drifting beside it. */
export async function hashImage(filePath: string, decoder: NearDupeJob['decoder']): Promise<DHash | null> {
  try {
    let gray: Buffer;
    if (decoder === 'sharp') {
      const sharp = loadSharp();
      if (!sharp) return null;
      gray = await sharp(openingImage(filePath), { failOn: 'none', animated: false })
        .greyscale()
        .resize(9, 8, { fit: 'fill' })
        .raw()
        .toBuffer();
    } else {
      gray = await ffmpegGray(filePath);
    }
    if (gray.length < 72) return null;
    return dhashFromGray(gray);
  } catch {
    return null;
  }
}

/** ffmpeg fallback: decode the first frame to a 9×8 grayscale raw buffer. */
async function ffmpegGray(filePath: string): Promise<Buffer> {
  const { stdout } = await exec(
    'ffmpeg',
    ['-v', 'error', '-i', openingImage(filePath), '-frames:v', '1', '-vf', 'scale=9:8', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { timeout: 15000, maxBuffer: 1024, encoding: 'buffer' }
  );
  return stdout as Buffer;
}

/**
 * Run `fn` over `items` with at most `limit` in flight; results keep order.
 * Increments `job.hashed` as each finishes and bails early on cancellation.
 */
async function mapConcurrent(
  items: CandidateImage[],
  limit: number,
  fn: (item: CandidateImage) => Promise<DHash | null>,
  job: NearDupeJob
): Promise<(DHash | null)[]> {
  const results = new Array<DHash | null>(items.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      if (job.cancelled) return;
      const i = next++;
      results[i] = await fn(items[i]!);
      job.hashed++;
    }
  });
  await Promise.all(workers);
  return results;
}
