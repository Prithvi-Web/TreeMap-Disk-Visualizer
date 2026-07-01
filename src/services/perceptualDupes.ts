import { execFile } from 'child_process';
import { promisify } from 'util';
import { FileNode, ScanResult, NearDupeCluster, NearDupeJob } from '../models/types';
import { getScan } from './diskScanner';

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
 */

/** Image types we fingerprint. */
const IMAGE_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'heic', 'heif', 'avif',
]);
/** Skip favicon-sized junk so tiny sprites don't drown out real photos. */
const MIN_IMAGE_BYTES = 4 * 1024;
/** Bound the O(n²) clustering; largest images are kept when over the cap. */
const MAX_IMAGES = 8000;
/** Response-size guard, mirroring the exact-duplicate finder. */
const MAX_CLUSTERS = 500;

/** dHash stored as two 32-bit halves so Hamming distance avoids slow BigInt. */
type DHash = [hi: number, lo: number];

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
  for (const [scanId, job] of jobs) {
    if (!getScan(scanId)) {
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
  if (!scan.root) throw new Error('Scan has no result tree');

  const decoder = await detectDecoder();
  job.decoder = decoder;
  if (decoder === 'none') {
    job.available = false;
    job.reason = 'No image decoder available — install the "sharp" package or ffmpeg to find near-duplicate images.';
    finishEmpty(job);
    return;
  }

  // Collect candidate images, largest first; cap to bound the O(n²) pass.
  const images: FileNode[] = [];
  const stack: FileNode[] = [scan.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'file') {
      if (
        node.size >= MIN_IMAGE_BYTES &&
        !node.hardlinkDuplicate &&
        !node.isSymlink &&
        !node.cloudPlaceholder &&
        node.extension &&
        IMAGE_EXT.has(node.extension)
      ) {
        images.push(node);
      }
      continue;
    }
    if (node.children) for (const c of node.children) stack.push(c);
  }
  images.sort((a, b) => b.size - a.size);
  let truncated = false;
  if (images.length > MAX_IMAGES) {
    images.length = MAX_IMAGES;
    truncated = true;
  }
  job.toHash = images.length;

  // Hash each image; null = unreadable/undecodable (dropped silently).
  const concurrency = decoder === 'sharp' ? 4 : 2;
  const hashes = await mapConcurrent(images, concurrency, (f) => hashImage(f.path, decoder), job);
  if (job.cancelled) return;

  type Entry = { file: FileNode; hash: DHash };
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
  job.clusters = clusters.slice(0, MAX_CLUSTERS);
  job.truncated = truncated;
  job.status = 'complete';
  job.finishedAt = Date.now();
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

function hamming(a: DHash, b: DHash): number {
  return popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
}

/* ---------- Decoders (best-effort) ---------- */

// sharp ships dual ESM/CJS typings; under `require` it returns the callable
// factory directly, so unwrap a possible `default` to recover its call type.
type SharpNamespace = typeof import('sharp');
type SharpFactory = SharpNamespace extends { default: infer F } ? F : SharpNamespace;
let sharpCache: SharpFactory | null | undefined;
function loadSharp(): SharpFactory | null {
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
async function detectDecoder(): Promise<NearDupeJob['decoder']> {
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

/** Decode one image to a dHash, or null if it can't be read/decoded. */
async function hashImage(filePath: string, decoder: NearDupeJob['decoder']): Promise<DHash | null> {
  try {
    let gray: Buffer;
    if (decoder === 'sharp') {
      const sharp = loadSharp();
      if (!sharp) return null;
      gray = await sharp(filePath, { failOn: 'none', animated: false })
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
    ['-v', 'error', '-i', filePath, '-frames:v', '1', '-vf', 'scale=9:8', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { timeout: 15000, maxBuffer: 1024, encoding: 'buffer' }
  );
  return stdout as Buffer;
}

/**
 * Run `fn` over `items` with at most `limit` in flight; results keep order.
 * Increments `job.hashed` as each finishes and bails early on cancellation.
 */
async function mapConcurrent(
  items: FileNode[],
  limit: number,
  fn: (item: FileNode) => Promise<DHash | null>,
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
