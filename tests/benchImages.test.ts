import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { ALL_TRANSFORMS, createImageCorpus, ensureImageCorpus, scoreClusters } from '../bench/lib/images';
import type { ImageManifest, Transform } from '../bench/lib/images';

/**
 * The image corpus (plan Task 5): four seeded originals, one planted variant
 * per transform, and the scorer that turns an engine's clusters into a recall
 * per transform and one precision.
 *
 * The oracles are literal, not mirrored from the generator: the dimensions
 * table is typed from the spec (crop-10 of 1600 is 1440), the pair counts are
 * C(n, 2) worked out by hand, and the screenshot frame colours are the hex
 * values the spec names. A generator that drifts fails here rather than
 * agreeing with a helper that drifted with it.
 */

// sharp is an optional native module. Without it there is nothing to test, and
// the skip reason says so instead of letting the file pass vacuously.
let skipReason: string | false = false;
try {
  require('sharp');
} catch (err) {
  skipReason = `sharp does not load: ${(err as Error).message}`;
}
const gated = { skip: skipReason };

// sharp ships dual ESM/CJS typings; under `require` it returns the callable factory.
type SharpNamespace = typeof import('sharp');
type SharpFactory = SharpNamespace extends { default: infer F } ? F : SharpNamespace;
function loadSharp(): SharpFactory {
  return require('sharp') as unknown as SharpFactory;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-images-'));
const ROOT = path.join(TMP, 'corpus');
const ORIGINALS = 4;
const SEED = 11;
const PARAMS = { originals: ORIGINALS, seed: SEED, transforms: [...ALL_TRANSFORMS] };
const BLOCK = 8; // pixel checks average an 8×8 block, which is one JPEG block

let manifest: ImageManifest;
let createMs = 0;

before(async () => {
  if (skipReason) return;
  const t0 = performance.now();
  manifest = await createImageCorpus(ROOT, PARAMS);
  createMs = performance.now() - t0;
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* ---------- literal oracles ---------- */

interface Dims { width: number; height: number }
type Kind = Transform | 'original';

const LANDSCAPE: Record<Kind, Dims> = {
  original: { width: 1600, height: 1200 },
  resize: { width: 800, height: 600 },
  'reencode-q40': { width: 1600, height: 1200 },
  'reencode-q70': { width: 1600, height: 1200 },
  'crop-5': { width: 1520, height: 1140 },
  'crop-10': { width: 1440, height: 1080 },
  'crop-20': { width: 1280, height: 960 },
  'rotate-90': { width: 1200, height: 1600 },
  watermark: { width: 1600, height: 1200 },
  screenshot: { width: 1920, height: 1080 },
  png: { width: 1600, height: 1200 },
  webp: { width: 1600, height: 1200 },
  'colour-shift': { width: 1600, height: 1200 },
};

const PORTRAIT: Record<Kind, Dims> = {
  original: { width: 1200, height: 1600 },
  resize: { width: 600, height: 800 },
  'reencode-q40': { width: 1200, height: 1600 },
  'reencode-q70': { width: 1200, height: 1600 },
  'crop-5': { width: 1140, height: 1520 },
  'crop-10': { width: 1080, height: 1440 },
  'crop-20': { width: 960, height: 1280 },
  'rotate-90': { width: 1600, height: 1200 },
  watermark: { width: 1200, height: 1600 },
  screenshot: { width: 1920, height: 1080 },
  png: { width: 1200, height: 1600 },
  webp: { width: 1200, height: 1600 },
  'colour-shift': { width: 1200, height: 1600 },
};

function formatFor(kind: Kind): string {
  if (kind === 'png') return 'png';
  if (kind === 'webp') return 'webp';
  return 'jpeg';
}

function extensionFor(kind: Kind): string {
  if (kind === 'png') return 'png';
  if (kind === 'webp') return 'webp';
  return 'jpg';
}

/* ---------- helpers ---------- */

function fileOf(original: number, kind: Kind): string {
  const hit = manifest.images.find((img) => img.original === original && img.transform === kind);
  assert.ok(hit, `manifest lacks the ${kind} of original ${original}`);
  return hit.path;
}

/** One cluster per original holding the original and every variant — the clustering a perfect engine returns. */
function perfectClustering(): string[][] {
  return Array.from({ length: ORIGINALS }, (_, i) => manifest.images.filter((img) => img.original === i).map((img) => img.path));
}

interface Raw { data: Buffer; width: number; height: number; channels: number }

async function rawPixels(file: string): Promise<Raw> {
  const { data, info } = await loadSharp()(file).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** Mean RGB of the BLOCK×BLOCK square whose top-left corner is (x0, y0). */
function blockMean(img: Raw, x0: number, y0: number): number[] {
  const sums = [0, 0, 0];
  for (let y = y0; y < y0 + BLOCK; y++) {
    for (let x = x0; x < x0 + BLOCK; x++) {
      const o = (y * img.width + x) * img.channels;
      sums[0] += img.data[o];
      sums[1] += img.data[o + 1];
      sums[2] += img.data[o + 2];
    }
  }
  return sums.map((s) => s / (BLOCK * BLOCK));
}

function assertClose(actual: number[], expected: number[], tolerance: number, label: string): void {
  for (let c = 0; c < 3; c++) {
    assert.ok(
      Math.abs(actual[c] - expected[c]) <= tolerance,
      `${label}: channel ${c} is ${actual[c].toFixed(1)}, expected ${expected[c].toFixed(1)} ±${tolerance}`,
    );
  }
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/* ---------- the corpus ---------- */

test('every original has one file per transform in the manifest and on disk, and manifest.json matches', gated, (t) => {
  assert.equal(manifest.root, ROOT);
  assert.deepEqual(manifest.params, PARAMS);
  assert.equal(manifest.images.length, ORIGINALS * (ALL_TRANSFORMS.length + 1));
  const bytesByKind = new Map<Kind, number>();
  for (let i = 0; i < ORIGINALS; i++) {
    for (const kind of ['original', ...ALL_TRANSFORMS] as const) {
      const hits = manifest.images.filter((img) => img.original === i && img.transform === kind);
      assert.equal(hits.length, 1, `${kind} of original ${i}: expected exactly one manifest entry, got ${hits.length}`);
      const file = hits[0].path;
      assert.ok(path.isAbsolute(file) && file.startsWith(ROOT + path.sep), `${file} is not an absolute path under the root`);
      assert.equal(path.basename(path.dirname(file)), kind === 'original' ? 'originals' : kind, `${file} is in the wrong directory`);
      assert.equal(path.basename(file), `img-${i}.${extensionFor(kind)}`);
      const size = fs.statSync(file).size;
      assert.ok(size > 0, `${file} is empty`);
      bytesByKind.set(kind, (bytesByKind.get(kind) ?? 0) + size);
    }
  }
  const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')) as ImageManifest;
  assert.deepEqual(onDisk, manifest);
  const total = [...bytesByKind.values()].reduce((sum, n) => sum + n, 0);
  const mib = (n: number): string => `${(n / 1048576).toFixed(1)} MiB`;
  t.diagnostic(`createImageCorpus: ${ORIGINALS} originals × ${ALL_TRANSFORMS.length} transforms in ${createMs.toFixed(0)} ms, ${mib(total)} on disk`);
  t.diagnostic(`bytes by kind: ${[...bytesByKind].map(([kind, n]) => `${kind} ${mib(n)}`).join(', ')}`);
});

test('originals are 1600×1200 (1200×1600 for every third) and every variant decodes to the spec dimensions and format', gated, async () => {
  const sharp = loadSharp();
  for (let i = 0; i < ORIGINALS; i++) {
    const table = i % 3 === 2 ? PORTRAIT : LANDSCAPE;
    for (const kind of ['original', ...ALL_TRANSFORMS] as const) {
      const meta = await sharp(fileOf(i, kind)).metadata();
      assert.deepEqual(
        { width: meta.width, height: meta.height, format: meta.format },
        { ...table[kind], format: formatFor(kind) },
        `${kind} of original ${i}`,
      );
    }
  }
});

test('rotate-90 turns the picture, not just the frame: its top-left is the original bottom-left and its top-right the original top-left', gated, async () => {
  for (const i of [0, 2]) {
    const original = await rawPixels(fileOf(i, 'original'));
    const rotated = await rawPixels(fileOf(i, 'rotate-90'));
    assertClose(blockMean(rotated, 0, 0), blockMean(original, 0, original.height - BLOCK), 6, `original ${i}: rotated top-left`);
    assertClose(blockMean(rotated, rotated.width - BLOCK, 0), blockMean(original, 0, 0), 6, `original ${i}: rotated top-right`);
  }
});

test('screenshot: a 40 px #1e1e1e bar over a #3a3a3a 1920×1080 frame, with the picture centred beneath the bar', gated, async () => {
  const BAR = [0x1e, 0x1e, 0x1e];
  const FRAME = [0x3a, 0x3a, 0x3a];
  const MARGIN = 16; // keep the probes a couple of JPEG blocks away from every edge
  // original 0 is landscape: 1600×1200 at 70% is 1120×840, centred in the 1040 rows under the bar → left 400, top 140.
  // original 2 is portrait: 1200×1600 at 70% would be 1120 tall and not fit, so it is capped to the 1040 rows: 780×1040 → left 570, top 40.
  const placements = [
    { i: 0, left: 400, top: 140, width: 1120, height: 840 },
    { i: 2, left: 570, top: 40, width: 780, height: 1040 },
  ];
  for (const p of placements) {
    const shot = await rawPixels(fileOf(p.i, 'screenshot'));
    assertClose(blockMean(shot, 0, 0), BAR, 3, `original ${p.i}: bar, top-left`);
    assertClose(blockMean(shot, 0, 40 - BLOCK), BAR, 3, `original ${p.i}: bar, last rows (probed at x = 0, away from the picture's edge, which JPEG chroma bleeds across)`);
    assertClose(blockMean(shot, 0, 40), FRAME, 3, `original ${p.i}: frame, first rows under the bar`);
    assertClose(blockMean(shot, 0, 1080 - BLOCK), FRAME, 3, `original ${p.i}: frame, bottom-left`);
    assertClose(blockMean(shot, 1920 - BLOCK, 1080 - BLOCK), FRAME, 3, `original ${p.i}: frame, bottom-right`);
    const midX = p.left + Math.floor(p.width / 2);
    const midY = p.top + Math.floor(p.height / 2);
    // just outside each edge of the picture is frame; just inside is not
    assertClose(blockMean(shot, p.left - MARGIN - BLOCK, midY), FRAME, 3, `original ${p.i}: frame left of the picture`);
    assertClose(blockMean(shot, p.left + p.width + MARGIN, midY), FRAME, 3, `original ${p.i}: frame right of the picture`);
    if (p.top - MARGIN - BLOCK >= 40) assertClose(blockMean(shot, midX, p.top - MARGIN - BLOCK), FRAME, 3, `original ${p.i}: frame above the picture`);
    if (p.top + p.height + MARGIN + BLOCK <= 1080) assertClose(blockMean(shot, midX, p.top + p.height + MARGIN), FRAME, 3, `original ${p.i}: frame below the picture`);
    for (const [x, y, where] of [
      [p.left + MARGIN, midY, 'left edge'],
      [p.left + p.width - MARGIN - BLOCK, midY, 'right edge'],
      [midX, p.top + MARGIN, 'top edge'],
      [midX, p.top + p.height - MARGIN - BLOCK, 'bottom edge'],
    ] as const) {
      const mean = blockMean(shot, x, y);
      const farFromFrame = Math.max(...mean.map((v, c) => Math.abs(v - FRAME[c])));
      assert.ok(farFromFrame > 10, `original ${p.i}: inside the picture's ${where} is frame grey (${mean.map((v) => v.toFixed(0)).join(',')}) — the picture is not where the spec puts it`);
    }
  }
});

test('watermark: the lower-right sixth is blended 25% toward mid-grey and nothing else is touched', gated, async () => {
  // pick the original whose bottom-right corner is farthest from grey, so the blend has something to show
  let best = { i: 0, distance: -1 };
  const originals: Raw[] = [];
  for (let i = 0; i < ORIGINALS; i++) {
    const raw = await rawPixels(fileOf(i, 'original'));
    originals.push(raw);
    const corner = blockMean(raw, raw.width - BLOCK, raw.height - BLOCK);
    const distance = Math.max(...corner.map((v) => Math.abs(v - 128)));
    if (distance > best.distance) best = { i, distance };
  }
  assert.ok(best.distance > 20, `no original has a bottom-right corner farther than 20 levels from grey (best ${best.distance.toFixed(0)}); change the seed so the blend check has teeth`);
  const original = originals[best.i];
  const marked = await rawPixels(fileOf(best.i, 'watermark'));
  const { width: w, height: h } = original;
  const regionLeft = w - Math.floor(w / 3);
  const regionTop = h - Math.floor(h / 2);
  const MARGIN = 16;
  const untouched: Array<[number, number, string]> = [
    [0, 0, 'top-left'],
    [w - BLOCK, 0, 'top-right'],
    [0, h - BLOCK, 'bottom-left'],
    [regionLeft - MARGIN - BLOCK, h - BLOCK, 'just left of the region'],
    [w - BLOCK, regionTop - MARGIN - BLOCK, 'just above the region'],
  ];
  for (const [x, y, where] of untouched) {
    assertClose(blockMean(marked, x, y), blockMean(original, x, y), 4, `untouched ${where}`);
  }
  const blended: Array<[number, number, string]> = [
    [w - BLOCK, h - BLOCK, 'bottom-right corner'],
    [regionLeft + MARGIN, h - BLOCK, 'just inside the region on the left'],
    [w - BLOCK, regionTop + MARGIN, 'just inside the region on the top'],
  ];
  for (const [x, y, where] of blended) {
    const expected = blockMean(original, x, y).map((v) => 0.75 * v + 0.25 * 128);
    assertClose(blockMean(marked, x, y), expected, 6, `blended ${where}`);
  }
});

test('the same seed renders the same bytes, and a different index renders a different picture', gated, async () => {
  const again = path.join(TMP, 'again');
  const one = await createImageCorpus(again, { originals: 1, seed: SEED, transforms: [...ALL_TRANSFORMS] });
  assert.equal(one.images.length, ALL_TRANSFORMS.length + 1);
  assert.equal(sha256(path.join(again, 'originals', 'img-0.jpg')), sha256(fileOf(0, 'original')), 'original 0 differs between two corpora with the same seed');
  assert.equal(sha256(path.join(again, 'crop-10', 'img-0.jpg')), sha256(fileOf(0, 'crop-10')), 'crop-10 of original 0 differs between two corpora with the same seed');
  assert.notEqual(sha256(fileOf(0, 'original')), sha256(fileOf(1, 'original')), 'originals 0 and 1 are byte-identical');
});

test('createImageCorpus rejects bad params before touching the disk', gated, async () => {
  const untouched = path.join(TMP, 'never-created');
  await assert.rejects(createImageCorpus(untouched, { originals: -1, seed: 1, transforms: ['png'] }), /originals/);
  await assert.rejects(createImageCorpus(untouched, { originals: 1.5, seed: 1, transforms: ['png'] }), /originals/);
  await assert.rejects(createImageCorpus(untouched, { originals: 1, seed: 1, transforms: ['png', 'png'] }), /transform/);
  await assert.rejects(createImageCorpus(untouched, { originals: 1, seed: 1, transforms: ['sepia' as Transform] }), /transform/);
  assert.equal(fs.existsSync(untouched), false, 'a rejected call must not create the root');
});

/* ---------- scoreClusters ---------- */

test('scoreClusters: a perfect clustering scores recall 1 for every transform and precision 1 over 312 pairs', gated, () => {
  const score = scoreClusters(manifest, perfectClustering());
  for (const transform of ALL_TRANSFORMS) assert.equal(score.recall[transform], 1, transform);
  assert.equal(score.precision, 1);
  assert.equal(score.pairs, 4 * 78); // four clusters of 13 files: C(13, 2) = 78 each
});

test('scoreClusters: merging two originals\' groups keeps recall 1 but drops precision to 312/481', gated, () => {
  const [a, b, ...rest] = perfectClustering();
  const score = scoreClusters(manifest, [[...a, ...b], ...rest]);
  for (const transform of ALL_TRANSFORMS) assert.equal(score.recall[transform], 1, transform);
  assert.equal(score.pairs, 325 + 78 + 78); // C(26, 2) = 325 in the merged cluster
  assert.equal(score.precision, 312 / 481); // only the 2 × 78 + 2 × 78 same-original pairs count
  assert.ok(score.precision < 1);
});

test('scoreClusters: an original absent from every cluster leaves its variants unrecalled even though they sit in one cluster together', gated, () => {
  const [a, ...rest] = perfectClustering();
  const withoutOriginal = a.filter((file) => file !== fileOf(0, 'original'));
  assert.equal(withoutOriginal.length, 12);
  const score = scoreClusters(manifest, [withoutOriginal, ...rest]);
  for (const transform of ALL_TRANSFORMS) assert.equal(score.recall[transform], 3 / 4, transform);
  assert.equal(score.precision, 1); // every remaining pair still shares an original
  assert.equal(score.pairs, 66 + 3 * 78); // C(12, 2) = 66
});

test('scoreClusters: a variant absent from every cluster is simply not recalled', gated, () => {
  const stray = fileOf(2, 'crop-10');
  const clusters = perfectClustering().map((cluster) => cluster.filter((file) => file !== stray));
  const score = scoreClusters(manifest, clusters);
  for (const transform of ALL_TRANSFORMS) assert.equal(score.recall[transform], transform === 'crop-10' ? 3 / 4 : 1, transform);
  assert.equal(score.precision, 1);
  assert.equal(score.pairs, 3 * 78 + 66);
});

test('scoreClusters: a file the manifest does not know counts against precision, and a repeated path is one member', gated, () => {
  const [a, ...rest] = perfectClustering();
  const junk = path.join(ROOT, 'manifest.json');
  const score = scoreClusters(manifest, [[...a, junk, a[0]], ...rest]);
  for (const transform of ALL_TRANSFORMS) assert.equal(score.recall[transform], 1, transform);
  assert.equal(score.pairs, 91 + 3 * 78); // C(14, 2) = 91: the junk file pairs with 13 real ones
  assert.equal(score.precision, 312 / 325);
});

test('scoreClusters: a transform with no variants has recall NaN, not 0 or 1; no clusters means recall 0 and precision NaN', gated, () => {
  const tiny: ImageManifest = {
    params: { originals: 1, seed: 1, transforms: ['resize'] },
    root: '/nowhere',
    images: [
      { path: '/nowhere/originals/img-0.jpg', original: 0, transform: 'original' },
      { path: '/nowhere/resize/img-0.jpg', original: 0, transform: 'resize' },
    ],
  };
  const score = scoreClusters(tiny, [['/nowhere/originals/img-0.jpg', '/nowhere/resize/img-0.jpg']]);
  assert.equal(score.recall.resize, 1);
  assert.ok(Number.isNaN(score.recall.webp), 'webp was never planted, so its recall is not a measurement');
  assert.equal(score.pairs, 1);
  assert.equal(score.precision, 1);

  const nothing = scoreClusters(manifest, []);
  for (const transform of ALL_TRANSFORMS) assert.equal(nothing.recall[transform], 0, transform);
  assert.equal(nothing.pairs, 0);
  assert.ok(Number.isNaN(nothing.precision), 'no pairs means precision is undefined, not 1');
});

/* ---------- the CLI's entry points ---------- */

test('ALL_TRANSFORMS lists the twelve planted transforms once each, in the plan\'s order', gated, () => {
  assert.deepEqual(
    [...ALL_TRANSFORMS],
    ['resize', 'reencode-q40', 'reencode-q70', 'crop-5', 'crop-10', 'crop-20', 'rotate-90', 'watermark', 'screenshot', 'png', 'webp', 'colour-shift'],
  );
  assert.equal(new Set(ALL_TRANSFORMS).size, 12);
});

test('ensureImageCorpus reuses a corpus whose manifest matches and every file exists, and rebuilds from an empty root otherwise', gated, async () => {
  const root = path.join(TMP, 'ensured');
  const one = { originals: 1, seed: SEED, transforms: [...ALL_TRANSFORMS] };
  const pathOf = (m: ImageManifest, kind: Kind): string => {
    const hit = m.images.find((img) => img.transform === kind);
    assert.ok(hit, `no ${kind} in the manifest`);
    return hit.path;
  };
  const mtimes = (m: ImageManifest): Map<string, number> =>
    new Map([...m.images.map((img) => img.path), path.join(root, 'manifest.json')].map((file) => [file, fs.statSync(file).mtimeMs]));
  const fileCount = (): number => fs.readdirSync(root, { recursive: true }).length;

  const built = await ensureImageCorpus(root, one);
  assert.equal(built.images.length, 13);
  const before = mtimes(built);
  const countBefore = fileCount();

  // same params, every file present: reused, nothing rewritten
  const reused = await ensureImageCorpus(root, { ...one, transforms: [...one.transforms] });
  assert.deepEqual(reused, built);
  assert.deepEqual(mtimes(reused), before, 'a reused corpus must not rewrite any file, not even manifest.json');
  assert.equal(fileCount(), countBefore);

  // a missing file forces a rebuild, and the rebuild starts from an empty root: a stray file does not survive it
  const stray = path.join(root, 'stray.txt');
  fs.writeFileSync(stray, 'not part of the corpus');
  fs.rmSync(pathOf(built, 'webp'));
  const rebuilt = await ensureImageCorpus(root, one);
  assert.deepEqual(rebuilt, built, 'the same params rebuild the same manifest');
  assert.ok(fs.existsSync(pathOf(rebuilt, 'webp')), 'the missing variant is back');
  assert.equal(fs.existsSync(stray), false, 'the rebuild must remove the old root rather than overwrite into it');

  // different params in the same root: rebuilt as a different corpus, and manifest.json says so
  const other = await ensureImageCorpus(root, { ...one, seed: SEED + 1 });
  assert.deepEqual(other.params, { ...one, seed: SEED + 1 });
  assert.notEqual(sha256(pathOf(other, 'original')), sha256(fileOf(0, 'original')), 'a new seed must render a new original');
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as ImageManifest;
  assert.deepEqual(onDisk, other);
});

test('ensureImageCorpus refuses to build or remove anything outside os.tmpdir()', gated, async () => {
  // a root at the filesystem root: even a broken guard could not create it (EROFS/EACCES), so the test is safe to run
  const outside = path.join(path.parse(os.tmpdir()).root, 'treemap-bench-must-never-exist', 'corpus');
  await assert.rejects(ensureImageCorpus(outside, { originals: 1, seed: 1, transforms: ['png'] }), /os\.tmpdir/);
  assert.equal(fs.existsSync(outside), false);
});

test('a variant that cannot be written fails the build naming the file, and the pool stops instead of finishing in the background', gated, async () => {
  const root = path.join(TMP, 'unwritable');
  fs.mkdirSync(path.join(root, 'webp', 'img-0.webp'), { recursive: true }); // a directory sits where the file must go
  await assert.rejects(createImageCorpus(root, PARAMS), /webp of original 0/);
  await new Promise((resolve) => setTimeout(resolve, 1000)); // give any lane that ignored the failure time to finish
  const written = ALL_TRANSFORMS.flatMap((t) => fs.readdirSync(path.join(root, t)).filter((name) => fs.statSync(path.join(root, t, name)).isFile()));
  assert.ok(written.length < ORIGINALS * ALL_TRANSFORMS.length, `all ${written.length} variants were written despite the failure`);
  assert.equal(fs.existsSync(path.join(root, 'crop-5', 'img-3.jpg')), false, 'a job far behind the failure was still run');
});
