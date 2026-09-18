/**
 * A labelled image corpus for the near-duplicate benchmark (plan Task 5).
 *
 * Every original is painted from the seeded PRNG — a two-colour vertical
 * gradient, a handful of filled rectangles and circles, and a little
 * per-pixel noise — so the corpus is the same on every machine and every run.
 * Each original then gets one variant per requested transform, made with
 * sharp, and the manifest records which original every file came from. That
 * label is what `scoreClusters` uses to turn an engine's clusters into a
 * recall per transform and one precision.
 *
 * Nothing here calls Math.random, nothing is written outside `root`, and
 * `ensureImageCorpus` only ever removes a root that lives under os.tmpdir().
 *
 * sharp is loaded lazily so that importing this module never fails on a
 * machine without it: only building a corpus needs the decoder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hash32, mulberry32 } from './prng';

export type Transform =
  | 'resize'
  | 'reencode-q40'
  | 'reencode-q70'
  | 'crop-5'
  | 'crop-10'
  | 'crop-20'
  | 'rotate-90'
  | 'watermark'
  | 'screenshot'
  | 'png'
  | 'webp'
  | 'colour-shift';

/** Every planted transform, in the plan's order. */
export const ALL_TRANSFORMS: readonly Transform[] = [
  'resize',
  'reencode-q40',
  'reencode-q70',
  'crop-5',
  'crop-10',
  'crop-20',
  'rotate-90',
  'watermark',
  'screenshot',
  'png',
  'webp',
  'colour-shift',
];

export interface ImageCorpusParams {
  originals: number;
  seed: number;
  transforms: Transform[];
}

export interface ImageManifest {
  params: ImageCorpusParams;
  root: string;
  images: Array<{ path: string; original: number; transform: Transform | 'original' }>;
}

export type ImageManifestEntry = ImageManifest['images'][number];

export interface ClusterScore {
  /** Per transform: variants that share a cluster with their original / variants planted. NaN when none were planted. */
  recall: Record<Transform, number>;
  /** Same-cluster pairs whose two files share an original / all same-cluster pairs. NaN when there are no pairs. */
  precision: number;
  /** The denominator of `precision`. */
  pairs: number;
}

/* ---------- constants ---------- */

const MANIFEST_FILE = 'manifest.json';
const ORIGINALS_DIR = 'originals';
const LANDSCAPE = { width: 1600, height: 1200 };
const PORTRAIT = { width: 1200, height: 1600 };
const CHANNELS = 3;
const CONCURRENCY = 4;
/** Originals, and every JPEG variant whose transform is not itself a re-encode. */
const JPEG_QUALITY = 92;
const WEBP_QUALITY = 80;
const SHAPES_MIN = 6;
const SHAPES_SPAN = 7; // 6..12 shapes
const SHAPE_MIN_FRACTION = 0.05; // of the shorter side …
const SHAPE_SPAN_FRACTION = 0.35; // … so a shape spans 5%–40% of it
const NOISE_LEVELS = Math.round(255 * 0.03); // "3% noise": every pixel moves by −8..+8 levels
const RESIZE_FACTOR = 0.5;
const WATERMARK = { grey: 128, alpha: 0.25, widthDivisor: 3, heightDivisor: 2 }; // the lower-right sixth
const SCREENSHOT = { width: 1920, height: 1080, bar: 40, scale: 0.7, frame: '#3a3a3a', barColour: '#1e1e1e' };
const COLOUR_SHIFT = { hue: 25, brightness: 1.1 };

/* ---------- sharp, loaded on first use ---------- */

// sharp ships dual ESM/CJS typings; under `require` it returns the callable
// factory directly, so unwrap a possible `default` to recover its call type.
type SharpNamespace = typeof import('sharp');
type SharpFactory = SharpNamespace extends { default: infer F } ? F : SharpNamespace;
type SharpInstance = ReturnType<SharpFactory>;

let sharpFactory: SharpFactory | undefined;
function loadSharp(): SharpFactory {
  if (sharpFactory === undefined) {
    sharpFactory = require('sharp') as unknown as SharpFactory;
  }
  return sharpFactory;
}

/* ---------- the scene painter ---------- */

type Rng = () => number;
interface Rgb { r: number; g: number; b: number }
interface Canvas { pixels: Buffer; width: number; height: number }

/** Every third original, starting at index 2, is portrait. */
function dimensionsFor(index: number): { width: number; height: number } {
  return index % 3 === 2 ? PORTRAIT : LANDSCAPE;
}

function colourFrom(rng: Rng): Rgb {
  return { r: Math.floor(rng() * 256), g: Math.floor(rng() * 256), b: Math.floor(rng() * 256) };
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

function setPixel(canvas: Canvas, x: number, y: number, colour: Rgb): void {
  const offset = (y * canvas.width + x) * CHANNELS;
  canvas.pixels[offset] = colour.r;
  canvas.pixels[offset + 1] = colour.g;
  canvas.pixels[offset + 2] = colour.b;
}

function paintGradient(canvas: Canvas, top: Rgb, bottom: Rgb): void {
  const { width, height } = canvas;
  for (let y = 0; y < height; y++) {
    const t = height > 1 ? y / (height - 1) : 0;
    const row: Rgb = {
      r: Math.round(top.r + (bottom.r - top.r) * t),
      g: Math.round(top.g + (bottom.g - top.g) * t),
      b: Math.round(top.b + (bottom.b - top.b) * t),
    };
    for (let x = 0; x < width; x++) setPixel(canvas, x, y, row);
  }
}

function fillRect(canvas: Canvas, left: number, top: number, w: number, h: number, colour: Rgb): void {
  const x0 = Math.max(0, left);
  const x1 = Math.min(canvas.width, left + w);
  const y0 = Math.max(0, top);
  const y1 = Math.min(canvas.height, top + h);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) setPixel(canvas, x, y, colour);
  }
}

function fillCircle(canvas: Canvas, cx: number, cy: number, radius: number, colour: Rgb): void {
  const r2 = radius * radius;
  const x0 = Math.max(0, cx - radius);
  const x1 = Math.min(canvas.width - 1, cx + radius);
  const y0 = Math.max(0, cy - radius);
  const y1 = Math.min(canvas.height - 1, cy + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2) setPixel(canvas, x, y, colour);
    }
  }
}

function paintShape(canvas: Canvas, rng: Rng): void {
  const colour = colourFrom(rng);
  const shorter = Math.min(canvas.width, canvas.height);
  const extent = (): number => Math.floor(shorter * (SHAPE_MIN_FRACTION + rng() * SHAPE_SPAN_FRACTION));
  const cx = Math.floor(rng() * canvas.width);
  const cy = Math.floor(rng() * canvas.height);
  if (rng() < 0.5) {
    fillCircle(canvas, cx, cy, Math.floor(extent() / 2), colour);
  } else {
    const w = extent();
    const h = extent();
    fillRect(canvas, cx - Math.floor(w / 2), cy - Math.floor(h / 2), w, h, colour);
  }
}

/** One draw per pixel, applied to all three channels: luminance noise, the kind a sensor adds. */
function addNoise(canvas: Canvas, rng: Rng): void {
  const { pixels } = canvas;
  const span = 2 * NOISE_LEVELS + 1;
  for (let offset = 0; offset < pixels.length; offset += CHANNELS) {
    const delta = Math.floor(rng() * span) - NOISE_LEVELS;
    pixels[offset] = clampByte(pixels[offset] + delta);
    pixels[offset + 1] = clampByte(pixels[offset + 1] + delta);
    pixels[offset + 2] = clampByte(pixels[offset + 2] + delta);
  }
}

/** Paints the seeded scene into a fresh RGB buffer; the same seed always paints the same pixels. */
function renderScene(seed: number, width: number, height: number): Buffer {
  const rng = mulberry32(seed);
  const canvas: Canvas = { pixels: Buffer.alloc(width * height * CHANNELS), width, height };
  paintGradient(canvas, colourFrom(rng), colourFrom(rng));
  const shapes = SHAPES_MIN + Math.floor(rng() * SHAPES_SPAN);
  for (let n = 0; n < shapes; n++) paintShape(canvas, rng);
  addNoise(canvas, rng);
  return canvas.pixels;
}

/* ---------- the variants ---------- */

interface VariantInput { sharp: SharpFactory; source: Buffer; width: number; height: number }
type VariantBuilder = (input: VariantInput) => SharpInstance | Promise<SharpInstance>;

function centreCrop({ sharp, source, width, height }: VariantInput, percent: number): SharpInstance {
  const keep = (100 - percent) / 100;
  const cropWidth = Math.round(width * keep);
  const cropHeight = Math.round(height * keep);
  return sharp(source)
    .extract({ left: Math.floor((width - cropWidth) / 2), top: Math.floor((height - cropHeight) / 2), width: cropWidth, height: cropHeight })
    .jpeg({ quality: JPEG_QUALITY });
}

async function watermark({ sharp, source, width, height }: VariantInput): Promise<SharpInstance> {
  const tileWidth = Math.floor(width / WATERMARK.widthDivisor);
  const tileHeight = Math.floor(height / WATERMARK.heightDivisor);
  const tile = await sharp({
    create: {
      width: tileWidth,
      height: tileHeight,
      channels: 4,
      background: { r: WATERMARK.grey, g: WATERMARK.grey, b: WATERMARK.grey, alpha: WATERMARK.alpha },
    },
  })
    .png()
    .toBuffer();
  return sharp(source)
    .composite([{ input: tile, left: width - tileWidth, top: height - tileHeight }])
    .jpeg({ quality: JPEG_QUALITY });
}

async function screenshot({ sharp, source, width, height }: VariantInput): Promise<SharpInstance> {
  const innerHeight = SCREENSHOT.height - SCREENSHOT.bar;
  // 70% of a portrait original is 1120 px tall and would not fit the frame (sharp refuses an
  // overlay larger than its base), so the scale is capped to what fits under the bar.
  const scale = Math.min(SCREENSHOT.scale, SCREENSHOT.width / width, innerHeight / height);
  const scaledWidth = Math.round(width * scale);
  const scaledHeight = Math.round(height * scale);
  const picture = await sharp(source).resize(scaledWidth, scaledHeight).png().toBuffer();
  const bar = await sharp({ create: { width: SCREENSHOT.width, height: SCREENSHOT.bar, channels: 3, background: SCREENSHOT.barColour } })
    .png()
    .toBuffer();
  return sharp({ create: { width: SCREENSHOT.width, height: SCREENSHOT.height, channels: 3, background: SCREENSHOT.frame } })
    .composite([
      { input: bar, left: 0, top: 0 },
      { input: picture, left: Math.floor((SCREENSHOT.width - scaledWidth) / 2), top: SCREENSHOT.bar + Math.floor((innerHeight - scaledHeight) / 2) },
    ])
    .jpeg({ quality: JPEG_QUALITY });
}

// A record rather than a switch so that a transform added to the type without a builder fails to compile.
const VARIANTS: Record<Transform, VariantBuilder> = {
  resize: ({ sharp, source, width, height }) =>
    sharp(source).resize(Math.round(width * RESIZE_FACTOR), Math.round(height * RESIZE_FACTOR)).jpeg({ quality: JPEG_QUALITY }),
  'reencode-q40': ({ sharp, source }) => sharp(source).jpeg({ quality: 40 }),
  'reencode-q70': ({ sharp, source }) => sharp(source).jpeg({ quality: 70 }),
  'crop-5': (input) => centreCrop(input, 5),
  'crop-10': (input) => centreCrop(input, 10),
  'crop-20': (input) => centreCrop(input, 20),
  'rotate-90': ({ sharp, source }) => sharp(source).rotate(90).jpeg({ quality: JPEG_QUALITY }),
  watermark,
  screenshot,
  png: ({ sharp, source }) => sharp(source).png(),
  webp: ({ sharp, source }) => sharp(source).webp({ quality: WEBP_QUALITY }),
  'colour-shift': ({ sharp, source }) => sharp(source).modulate(COLOUR_SHIFT).jpeg({ quality: JPEG_QUALITY }),
};

function extensionFor(transform: Transform): string {
  if (transform === 'png') return 'png';
  if (transform === 'webp') return 'webp';
  return 'jpg';
}

function originalFile(root: string, index: number): string {
  return path.join(root, ORIGINALS_DIR, `img-${index}.jpg`);
}

function variantFile(root: string, index: number, transform: Transform): string {
  return path.join(root, transform, `img-${index}.${extensionFor(transform)}`);
}

async function writeOriginal(sharp: SharpFactory, root: string, seed: number, index: number): Promise<void> {
  const { width, height } = dimensionsFor(index);
  const pixels = renderScene(hash32(seed, index), width, height);
  try {
    await sharp(pixels, { raw: { width, height, channels: CHANNELS } }).jpeg({ quality: JPEG_QUALITY }).toFile(originalFile(root, index));
  } catch (err) {
    throw new Error(`original ${index}: ${(err as Error).message}`, { cause: err });
  }
}

async function writeVariant(sharp: SharpFactory, root: string, index: number, transform: Transform): Promise<void> {
  const { width, height } = dimensionsFor(index);
  try {
    const source = await fs.promises.readFile(originalFile(root, index));
    const pipeline = await VARIANTS[transform]({ sharp, source, width, height });
    await pipeline.toFile(variantFile(root, index, transform));
  } catch (err) {
    throw new Error(`${transform} of original ${index}: ${(err as Error).message}`, { cause: err });
  }
}

/**
 * Runs `work` over `items` with at most `limit` in flight. The first rejection
 * is the one the caller sees, and it also stops the other lanes from starting
 * further items, so a failed build does not keep writing in the background.
 */
async function runPool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const lane = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next];
      next += 1;
      try {
        await work(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

function validateParams(params: ImageCorpusParams): void {
  if (!Number.isInteger(params.originals) || params.originals < 0) {
    throw new RangeError(`originals must be a non-negative integer, got ${params.originals}`);
  }
  if (!Number.isInteger(params.seed)) {
    throw new RangeError(`seed must be an integer, got ${params.seed}`);
  }
  const seen = new Set<Transform>();
  for (const transform of params.transforms) {
    if (!ALL_TRANSFORMS.includes(transform)) throw new RangeError(`unknown transform "${transform}"`);
    if (seen.has(transform)) throw new RangeError(`transform "${transform}" is listed twice`);
    seen.add(transform);
  }
}

/* ---------- the corpus ---------- */

/**
 * Builds the corpus under `root`: `originals/img-<i>.jpg` for every original and
 * `<transform>/img-<i>.<ext>` for every variant, four sharp pipelines at a time,
 * and writes the manifest to `<root>/manifest.json` as well as returning it.
 * Existing files are overwritten; nothing is deleted.
 */
export async function createImageCorpus(root: string, params: ImageCorpusParams): Promise<ImageManifest> {
  validateParams(params);
  const sharp = loadSharp();
  const absoluteRoot = path.resolve(root);
  fs.mkdirSync(path.join(absoluteRoot, ORIGINALS_DIR), { recursive: true });
  for (const transform of params.transforms) fs.mkdirSync(path.join(absoluteRoot, transform), { recursive: true });

  const indices = Array.from({ length: params.originals }, (_, index) => index);
  await runPool(indices, CONCURRENCY, (index) => writeOriginal(sharp, absoluteRoot, params.seed, index));
  const jobs = indices.flatMap((index) => params.transforms.map((transform) => ({ index, transform })));
  await runPool(jobs, CONCURRENCY, (job) => writeVariant(sharp, absoluteRoot, job.index, job.transform));

  const images: ImageManifestEntry[] = indices.flatMap((index) => [
    { path: originalFile(absoluteRoot, index), original: index, transform: 'original' as const },
    ...params.transforms.map((transform) => ({ path: variantFile(absoluteRoot, index, transform), original: index, transform })),
  ]);
  const manifest: ImageManifest = {
    params: { originals: params.originals, seed: params.seed, transforms: [...params.transforms] },
    root: absoluteRoot,
    images,
  };
  fs.writeFileSync(path.join(absoluteRoot, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  return manifest;
}

/* ---------- reuse ---------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTransform(value: unknown): value is Transform {
  return typeof value === 'string' && (ALL_TRANSFORMS as readonly string[]).includes(value);
}

function isImageManifest(value: unknown): value is ImageManifest {
  if (!isRecord(value) || !isRecord(value.params) || typeof value.root !== 'string' || !Array.isArray(value.images)) return false;
  const { params, images } = value;
  if (typeof params.originals !== 'number' || typeof params.seed !== 'number') return false;
  if (!Array.isArray(params.transforms) || !params.transforms.every(isTransform)) return false;
  return images.every(
    (img: unknown) =>
      isRecord(img) && typeof img.path === 'string' && typeof img.original === 'number' && (img.transform === 'original' || isTransform(img.transform)),
  );
}

function sameParams(a: ImageCorpusParams, b: ImageCorpusParams): boolean {
  return (
    a.originals === b.originals &&
    a.seed === b.seed &&
    a.transforms.length === b.transforms.length &&
    a.transforms.every((transform, i) => transform === b.transforms[i])
  );
}

/** The manifest under `root` when it parses, was built for exactly these params at this root, and every file it lists exists. */
function reusableManifest(root: string, params: ImageCorpusParams): ImageManifest | undefined {
  const file = path.join(root, MANIFEST_FILE);
  if (!fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isImageManifest(parsed) || parsed.root !== root || !sameParams(parsed.params, params)) return undefined;
  if (parsed.images.length !== params.originals * (params.transforms.length + 1)) return undefined;
  if (!parsed.images.every((img) => fs.existsSync(img.path))) return undefined;
  return parsed;
}

/** Throws unless `root` is strictly inside os.tmpdir(), in either spelling of a symlinked temp dir. */
function assertUnderTmpdir(root: string): void {
  const tmp = path.resolve(os.tmpdir());
  const inside = (dir: string, parent: string): boolean => dir.startsWith(parent + path.sep);
  const spellings = [tmp];
  try {
    spellings.push(fs.realpathSync(tmp));
  } catch {
    // an unreadable temp dir is not a reason to widen the guard
  }
  let ok = spellings.some((spelling) => inside(root, spelling));
  if (!ok && fs.existsSync(root)) {
    try {
      const real = fs.realpathSync(root);
      ok = spellings.some((spelling) => inside(real, spelling));
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    throw new Error(`ensureImageCorpus: refusing to build or remove ${root} — an image corpus must live under os.tmpdir() (${tmp})`);
  }
}

/**
 * Returns the corpus at `root` if its manifest matches `params` and every listed
 * file exists; otherwise removes `root` — only ever under os.tmpdir(), asserted
 * before anything is deleted — and builds it afresh.
 */
export async function ensureImageCorpus(root: string, params: ImageCorpusParams): Promise<ImageManifest> {
  validateParams(params);
  const absoluteRoot = path.resolve(root);
  const existing = reusableManifest(absoluteRoot, params);
  if (existing) return existing;
  assertUnderTmpdir(absoluteRoot);
  fs.rmSync(absoluteRoot, { recursive: true, force: true });
  return createImageCorpus(absoluteRoot, params);
}

/* ---------- scoring ---------- */

function recordOverTransforms(value: (transform: Transform) => number): Record<Transform, number> {
  // Object.fromEntries widens to a string index; every key of Transform is present because ALL_TRANSFORMS lists them all.
  return Object.fromEntries(ALL_TRANSFORMS.map((transform) => [transform, value(transform)])) as Record<Transform, number>;
}

/**
 * Recall per transform is the share of that transform's variants that sit in a
 * cluster with their original; a variant in no cluster, or in a cluster its
 * original is not in, is not recalled. Precision is the share of same-cluster
 * pairs whose two files come from the same original; a path the manifest does
 * not know pairs with everything in its cluster and shares an original with
 * nothing. Paths are matched exactly as strings. A repeated path in a cluster
 * is one member.
 */
export function scoreClusters(manifest: ImageManifest, clusters: string[][]): ClusterScore {
  const members = clusters.map((cluster) => [...new Set(cluster)]);
  const membership = new Map<string, Set<number>>();
  members.forEach((cluster, index) => {
    for (const file of cluster) {
      const indices = membership.get(file) ?? new Set<number>();
      indices.add(index);
      membership.set(file, indices);
    }
  });
  const shareCluster = (a: string, b: string): boolean => {
    const ca = membership.get(a);
    const cb = membership.get(b);
    if (!ca || !cb) return false;
    for (const index of ca) if (cb.has(index)) return true;
    return false;
  };

  const originalPaths = new Map<number, string>();
  for (const image of manifest.images) {
    if (image.transform === 'original') originalPaths.set(image.original, image.path);
  }
  const planted = new Map<Transform, number>();
  const recalled = new Map<Transform, number>();
  for (const image of manifest.images) {
    if (image.transform === 'original') continue;
    planted.set(image.transform, (planted.get(image.transform) ?? 0) + 1);
    const original = originalPaths.get(image.original);
    const isRecalled = original !== undefined && shareCluster(image.path, original);
    if (isRecalled) recalled.set(image.transform, (recalled.get(image.transform) ?? 0) + 1);
  }
  const recall = recordOverTransforms((transform) => (recalled.get(transform) ?? 0) / (planted.get(transform) ?? 0));

  const originalOf = new Map(manifest.images.map((image) => [image.path, image.original]));
  let pairs = 0;
  let agreeing = 0;
  for (const cluster of members) {
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        pairs += 1;
        const a = originalOf.get(cluster[i]);
        const b = originalOf.get(cluster[j]);
        if (a !== undefined && a === b) agreeing += 1;
      }
    }
  }
  return { recall, precision: agreeing / pairs, pairs };
}
