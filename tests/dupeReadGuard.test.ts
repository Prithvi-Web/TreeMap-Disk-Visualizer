import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';

isolatedDataDir('treemap-dupeReadGuard-data-');

import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { buildDuplicateDetail, type DupeDetailFile, type DupeDetailResponse } from '../src/services/dupeViewer';
import { getNearDupeJob, observeImageOpensForTests } from '../src/services/perceptualDupes';
import { PackedScanStore } from '../src/services/scanStore';
import { resetNativeForTests, setNativeLoadOverrideForTests } from '../src/services/scan/native';
import type { NearDupeJob, ScanResult } from '../src/models/types';

/**
 * RISKS R1 and R71, the master prompt §3.2: opening an online-only file makes
 * iCloud Drive or OneDrive download it. The exact duplicate finder never
 * opens a cloud placeholder or a link, and asks the native module's
 * `dataIsLocal` just before it reads (duplicatePlaceholders.test.ts). Two
 * more readers open the same files — the duplicate viewer, which decodes
 * every image it is asked to compare, and the near-duplicate pass, which
 * decodes every candidate image — and they keep the same rule: a placeholder
 * or a link is never opened, a file whose data has left since the scan is
 * never opened, and one nobody could ask about is not opened either (no
 * answer is not a yes). An observer sees every image path handed to a
 * decoder, before it is handed over, so an open cannot happen unseen.
 */

let sharpAvailable = true;
try {
  require('sharp');
} catch {
  sharpAvailable = false;
}
const needsSharp = { skip: sharpAvailable ? false : 'sharp is not installed, so no local image can be decoded' };

// The viewer's reasons, word for word: what the panel shows beside each file.
const ONLINE_ONLY = 'not opened: this file is online-only, and opening it would download it';
const LINK = 'not opened: this is a link, and TreeMap never follows one';
const LEFT_DISK = "not opened: this file's data has left the disk since the scan (it is online-only now), and opening it would download it";
const UNCONFIRMED = "not opened: TreeMap could not confirm this file's data is on the disk, and opening it could download it";

/**
 * Every file is real and on this disk, so a reader that ignored the rule
 * would visibly open it. The five pictures carry the same pixels: were the
 * near-duplicate pass to decode one it should not, it would join the cluster.
 * `link.png` is a real link to `local-a.png`; `broken.png` is not a picture
 * at all, so its decode fails — and it must still be seen being opened.
 */
const PICTURES = ['local-a.png', 'local-b.png', 'cloud.png', 'evicted.png', 'unsure.png'] as const;

/** The scan's own mtimes: local-b is the newest, so the viewer keeps it and diffs against it. */
const MTIME: Record<string, number> = {
  'local-a.png': 1_000, 'local-b.png': 9_000, 'cloud.png': 2_000, 'link.png': 3_000,
  'evicted.png': 4_000, 'unsure.png': 5_000, 'broken.png': 6_000, 'notes.txt': 7_000,
};

let fixtureDir: string | null = null;

/** The folder of real files, written once (sharp writes the pictures). */
async function files(): Promise<string> {
  if (fixtureDir) return fixtureDir;
  const dir = fileTempDir('tm-dupe-read-guard-');
  const sharp = require('sharp');
  // Noise, 128px: a PNG of it clears the near-duplicate pass's 4 KB floor.
  const raw = Buffer.alloc(128 * 128 * 3);
  let x = 7;
  for (let i = 0; i < raw.length; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; raw[i] = x >>> 24; }
  const png: Buffer = await sharp(raw, { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer();
  for (const name of PICTURES) fs.writeFileSync(path.join(dir, name), png);
  fs.symlinkSync(path.join(dir, 'local-a.png'), path.join(dir, 'link.png'));
  fs.writeFileSync(path.join(dir, 'broken.png'), 'this is not a picture\n'.repeat(400));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'plain text, never an image\n');
  fixtureDir = dir;
  return dir;
}

interface Built { scan: ScanResult; store: PackedScanStore; id: (name: string) => number }

/** A completed scan of the fixture folder whose store says what each file is. */
async function scanned(): Promise<Built> {
  const dir = await files();
  const scan = createScanRecord(dir);
  const store = new PackedScanStore(dir, path.sep, { name: path.basename(dir), isDir: true, size: 0, modifiedAt: 0, isHidden: false });
  const ids = new Map<string, number>();
  for (const name of Object.keys(MTIME)) {
    const extra = name === 'cloud.png' ? { cloudPlaceholder: true, cloudProvider: 'icloud' as const }
      : name === 'link.png' ? { isSymlink: true }
        : {};
    ids.set(name, store.addNode(store.rootId, {
      name, isDir: false, size: fs.statSync(path.join(dir, name)).size, modifiedAt: MTIME[name]!, isHidden: false,
      extension: path.extname(name).slice(1), ...extra,
    }));
  }
  store.finalize();
  store.sumSizes();
  scan.store = store;
  scan.status = 'complete';
  return { scan, store, id: (name) => ids.get(name)! };
}

/* ──────────────────────────── the native stand-ins ──────────────────────────── */

/** Every batch the stand-in's `dataIsLocal` was asked about, by file name. */
const asked: string[][] = [];

/** A native module whose `dataIsLocal` answers each file by name — or, with no answer, one built before it could ask. */
function standIn(answer?: (name: string) => number): void {
  resetNativeForTests();
  asked.length = 0;
  const mod: Record<string, unknown> = { version: () => '0.0.0-test' };
  if (answer) {
    mod.dataIsLocal = (paths: string[]) => {
      asked.push(paths.map((p) => path.basename(p)));
      return Uint8Array.from(paths.map((p) => answer(path.basename(p))));
    };
  }
  setNativeLoadOverrideForTests({ path: '/stand-in/treemap_core.node', expectedVersion: '0.0.0-test', requireModule: () => mod });
}

/** No native module at all: a path where none is. */
function noModule(): void {
  resetNativeForTests();
  asked.length = 0;
  setNativeLoadOverrideForTests({ path: path.join(fixtureDir ?? '/nowhere', 'no-such', 'treemap_core.node') });
}

function realNative(): void {
  setNativeLoadOverrideForTests(null);
  resetNativeForTests();
}

/** How many times each file was handed to a decoder, while `fn` ran. */
async function watchingOpens<T>(fn: () => Promise<T>): Promise<{ result: T; opens: Record<string, number> }> {
  const opens: Record<string, number> = {};
  observeImageOpensForTests((file) => {
    const name = path.basename(file);
    opens[name] = (opens[name] ?? 0) + 1;
  });
  try {
    return { result: await fn(), opens };
  } finally {
    observeImageOpensForTests(null);
  }
}

/* ─────────────────────────────── the viewer ─────────────────────────────── */

function detailOf(b: Built, names: string[]): Promise<DupeDetailResponse> {
  return buildDuplicateDetail(b.scan.scanId, b.store, names.map(b.id));
}

function fileNamed(d: DupeDetailResponse, name: string): DupeDetailFile {
  const f = d.files?.find((x) => x.name === name);
  assert.ok(f, `${name} is in the answer: ${JSON.stringify(d).slice(0, 300)}`);
  return f;
}

/** The image facts of a file nobody opened: nothing read, and the same reason given for each. */
function imageFacts(f: DupeDetailFile) {
  return {
    isImage: f.isImage, width: f.width, height: f.height, dimensionsReason: f.dimensionsReason,
    captureDate: f.captureDate, captureDateReason: f.captureDateReason,
    visualDiff: f.visualDiff, visualDiffReason: f.visualDiffReason,
  };
}
const notOpened = (reason: string) => ({
  isImage: true, width: null, height: null, dimensionsReason: reason,
  captureDate: null, captureDateReason: reason, visualDiff: null, visualDiffReason: reason,
});

test('the viewer never opens a cloud placeholder or a link, and says why — even where the module calls both local', needsSharp, async () => {
  // A module that cannot see a placeholder flag (Linux answers existence)
  // calls every file local; the scan's flags must still hold.
  const b = await scanned();
  standIn(() => 1);
  try {
    const names = ['local-a.png', 'local-b.png', 'cloud.png', 'link.png', 'broken.png', 'notes.txt'];
    const { result: d, opens } = await watchingOpens(() => detailOf(b, names));

    // The local ones really decode, and are compared against the keeper (local-b, the newest).
    const a = fileNamed(d, 'local-a.png');
    assert.deepEqual([a.width, a.visualDiff?.hammingDistance, d.diffReference], [128, 0, names.indexOf('local-b.png')],
      'local-a decoded, and compared against local-b');

    // sharp reads the header, then the fingerprint decodes the pixels: two
    // opens a file, each seen before it happens — even one whose decode fails.
    assert.deepEqual(opens, { 'local-a.png': 2, 'local-b.png': 2, 'broken.png': 2 }, 'only the local images were opened');
    assert.deepEqual(asked, [['local-a.png', 'local-b.png', 'broken.png']],
      'asked once, about the images that could be opened: never about a placeholder, a link or a text file');

    // The tree's facts answer for every file, opened or not, in the caller's
    // order. The four pictures share one size; the text and the broken file are smaller.
    assert.deepEqual(
      d.files.map((f) => [f.name, f.path, f.size, f.modifiedAt, f.newest, f.largest]),
      names.map((n) => [n, b.store.path(b.id(n)), b.store.size(b.id(n)), MTIME[n], n === 'local-b.png', PICTURES.some((p) => p === n) || n === 'link.png']),
    );

    assert.deepEqual(imageFacts(fileNamed(d, 'cloud.png')), notOpened(ONLINE_ONLY));
    assert.deepEqual(imageFacts(fileNamed(d, 'link.png')), notOpened(LINK));
  } finally {
    realNative();
  }
});

test('the viewer asks just before it opens: data gone since the scan, or no answer, is never opened', needsSharp, async () => {
  const b = await scanned();
  standIn((name) => (name === 'evicted.png' ? 0 : name === 'unsure.png' ? 2 : 1));
  try {
    const names = ['local-a.png', 'local-b.png', 'evicted.png', 'unsure.png'];
    const { result: d, opens } = await watchingOpens(() => detailOf(b, names));
    assert.deepEqual(opens, { 'local-a.png': 2, 'local-b.png': 2 }, 'the evicted and the unanswered file were never opened');
    assert.deepEqual(imageFacts(fileNamed(d, 'evicted.png')), notOpened(LEFT_DISK));
    assert.deepEqual(imageFacts(fileNamed(d, 'unsure.png')), notOpened(UNCONFIRMED), 'no answer is not a yes');
  } finally {
    realNative();
  }
});

test('when the module cannot ask at all (the call throws), no image is opened', needsSharp, async () => {
  const b = await scanned();
  standIn(() => {
    throw new Error('the directory entries could not be read');
  });
  try {
    const names = ['local-a.png', 'local-b.png', 'notes.txt'];
    const { result: d, opens } = await watchingOpens(() => detailOf(b, names));
    assert.deepEqual(opens, {}, 'nothing was opened');
    assert.deepEqual([imageFacts(fileNamed(d, 'local-a.png')), imageFacts(fileNamed(d, 'local-b.png'))], [notOpened(UNCONFIRMED), notOpened(UNCONFIRMED)]);
    assert.equal(fileNamed(d, 'notes.txt').visualDiffReason, 'not an image', 'a text file is never opened, so it is never refused either');
    assert.equal(d.recommendedKeep.index, names.indexOf('local-b.png'), 'the keeper is chosen from the tree, not from what could be opened');
  } finally {
    realNative();
  }
});

test('with no module that can ask, the scan’s flags alone decide, as they do for the exact finder', needsSharp, async () => {
  const b = await scanned();
  const names = ['local-a.png', 'evicted.png', 'unsure.png', 'cloud.png', 'link.png'];
  for (const [label, setUp] of [['no native module', noModule], ['a module built before dataIsLocal', () => standIn()]] as const) {
    setUp();
    try {
      const { result: d, opens } = await watchingOpens(() => detailOf(b, names));
      assert.deepEqual(opens, { 'local-a.png': 2, 'evicted.png': 2, 'unsure.png': 2 }, `${label}: every file the scan saw as local is opened`);
      assert.deepEqual(imageFacts(fileNamed(d, 'cloud.png')), notOpened(ONLINE_ONLY), label);
      assert.deepEqual(imageFacts(fileNamed(d, 'link.png')), notOpened(LINK), label);
    } finally {
      realNative();
    }
  }
});

test('the same rule holds through GET /api/duplicates/detail', needsSharp, async () => {
  const b = await scanned();
  standIn((name) => (name === 'evicted.png' ? 0 : 1));
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    const names = ['local-a.png', 'local-b.png', 'cloud.png', 'link.png', 'evicted.png'];
    const url = `/api/duplicates/detail?scanId=${b.scan.scanId}&paths=${names.map((n) => encodeURIComponent(b.store.path(b.id(n)))).join(',')}`;
    const { result: r, opens } = await watchingOpens(() => get(port, url));
    assert.deepEqual(opens, { 'local-a.png': 2, 'local-b.png': 2 }, `status ${r.status}`);
    const d = r.body as DupeDetailResponse;
    assert.deepEqual(imageFacts(fileNamed(d, 'cloud.png')), notOpened(ONLINE_ONLY));
    assert.deepEqual(imageFacts(fileNamed(d, 'link.png')), notOpened(LINK));
    assert.deepEqual(imageFacts(fileNamed(d, 'evicted.png')), notOpened(LEFT_DISK));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    realNative();
  }
});

function get(port: number, url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: url, method: 'GET' }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => {
        let parsed: unknown = buf;
        try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

/* ──────────────────────────── the near-duplicate pass ──────────────────────────── */

async function finished(job: NearDupeJob): Promise<NearDupeJob> {
  // A hang guard, not a measurement: a fixed short deadline fails on a busy runner.
  await waitFor(() => job.status !== 'running', 'the near-duplicate job finishing');
  assert.equal(job.status, 'complete', job.error);
  return job;
}

const clustered = (job: NearDupeJob): string[][] =>
  (job.clusters ?? []).map((c) => c.files.map((f) => path.basename(f.path)).sort());

test('the near-duplicate pass asks before it decodes: what has left the disk, or cannot be asked about, is never opened', needsSharp, async () => {
  const b = await scanned();
  standIn((name) => (name === 'evicted.png' ? 0 : name === 'unsure.png' ? 2 : 1));
  try {
    const { result: job, opens } = await watchingOpens(() => finished(getNearDupeJob(b.scan, 4)));
    assert.deepEqual(clustered(job), [['local-a.png', 'local-b.png']], 'the same pixels on the evicted and unanswered files were never looked at');
    assert.deepEqual(opens, { 'local-a.png': 1, 'local-b.png': 1, 'broken.png': 1 },
      'the local candidates were opened — the undecodable one too, and seen — and nothing else');
    // The evicted file is online-only now, left out as a placeholder is. The
    // unanswered one may be on this disk: leaving it out is a gap in the
    // answer, and the answer says so rather than reading as complete.
    assert.deepEqual([job.available, job.reason], [true, NOT_COMPARED_ONE], 'the one image nobody could vouch for is named as not compared');
  } finally {
    realNative();
  }
});

// What the near-duplicate job says, word for word, about images it could not confirm were on this disk.
const NOT_COMPARED_ONE = '1 image was not compared: TreeMap could not confirm its data is on this disk, and opening it could download it.';
const NONE_COMPARED = 'No image was compared: TreeMap could not confirm that the images are on this disk, and opening one that is online-only would download it. Near-duplicates are unknown here, not none.';

test('when the module cannot ask at all, the near-duplicate pass reports unknown, never "none found"', needsSharp, async () => {
  // Every candidate is a real local file carrying the same pixels, so a pass
  // that treated "could not ask" as "nothing here" would read as a tidy library.
  const b = await scanned();
  standIn(() => {
    throw new Error('the directory entries could not be read');
  });
  try {
    const { result: job, opens } = await watchingOpens(() => finished(getNearDupeJob(b.scan, 4)));
    assert.deepEqual(opens, {}, 'nothing was opened');
    assert.deepEqual(
      [job.available, job.reason, job.clusters, job.clusterCount],
      [false, NONE_COMPARED, [], 0],
      'unavailable, with the reason: an empty list here would say "no near-duplicates", which nobody checked',
    );
  } finally {
    realNative();
  }
});

/** A completed scan listing `total` pictures that exist only in its store: nothing of them can be read. */
function pictureEntries(total: number): ScanResult {
  const dir = fileTempDir('tm-near-chunks-');
  const scan = createScanRecord(dir);
  const store = new PackedScanStore(dir, path.sep, { name: path.basename(dir), isDir: true, size: 0, modifiedAt: 0, isHidden: false });
  for (let i = 0; i < total; i++) {
    store.addNode(store.rootId, { name: `p${i}.png`, isDir: false, size: 8192 + i, modifiedAt: i, isHidden: false, extension: 'png' });
  }
  store.finalize();
  store.sumSizes();
  scan.store = store;
  scan.status = 'complete';
  return scan;
}

test('an image deleted since the scan is not an image nobody could vouch for', needsSharp, async () => {
  // Nothing updates a scan when its files are trashed (DELETE /api/files
  // leaves the tree as it was), and the native ask answers "could not tell"
  // for a path that is gone. Reading that as "could be online-only" told a
  // person who had just trashed duplicates that images "could download".
  const b = await scanned();
  const gone = b.store.addNode(b.store.rootId, {
    name: 'trashed.png', isDir: false, size: 20_000, modifiedAt: 8_000, isHidden: false, extension: 'png',
  });
  assert.equal(fs.existsSync(b.store.path(gone)), false, 'the trashed image is only in the scan');
  standIn((name) => (name === 'local-a.png' || name === 'local-b.png' || name === 'broken.png' ? 1 : name === 'trashed.png' ? 2 : 0));
  try {
    const { result: job, opens } = await watchingOpens(() => finished(getNearDupeJob(b.scan, 4)));
    assert.deepEqual(clustered(job), [['local-a.png', 'local-b.png']]);
    assert.equal(opens['trashed.png'], undefined, 'the deleted image was never opened');
    assert.deepEqual([job.available, job.reason], [true, undefined], 'and it is not reported as one nobody could vouch for');
  } finally {
    realNative();
  }
});

const NO_CHMOD = process.platform === 'win32'
  ? 'Windows has no POSIX folder permissions'
  : process.getuid?.() === 0 ? 'root may search any folder: chmod cannot hide an entry from root' : false;

test('an entry the pass cannot look at is not taken for deleted', { skip: NO_CHMOD }, async () => {
  // Only a definite "no such entry" says an image is gone; a folder the
  // process may not search hides an image that may well be there.
  const b = await scanned();
  const locked = path.join(b.store.rootPath, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'hidden.png'), Buffer.alloc(20_000, 1));
  const dirId = b.store.addNode(b.store.rootId, { name: 'locked', isDir: true, size: 0, modifiedAt: 0, isHidden: false });
  b.store.addNode(dirId, { name: 'hidden.png', isDir: false, size: 20_000, modifiedAt: 8_000, isHidden: false, extension: 'png' });
  standIn((name) => (name === 'local-a.png' || name === 'local-b.png' || name === 'broken.png' ? 1 : name === 'hidden.png' ? 2 : 0));
  fs.chmodSync(locked, 0o000);
  try {
    assert.throws(() => fs.lstatSync(path.join(locked, 'hidden.png')), /EACCES/, 'the fixture really hides the entry');
    const { result: job } = await watchingOpens(() => finished(getNearDupeJob(b.scan, 4)));
    assert.deepEqual([job.available, job.reason], [true, NOT_COMPARED_ONE], 'one image nobody could vouch for, not a deleted one');
  } finally {
    fs.chmodSync(locked, 0o755);
    realNative();
  }
});

test('the near-duplicate pass asks in chunks, and the event loop turns between them', async () => {
  // One synchronous native call for every candidate (up to 8,000; one
  // directory lookup each) would hold the server's event loop — progress
  // streams and every other request — for the whole list. Nothing here is
  // decoded: every answer is "not on this disk".
  const total = 600;
  const scan = pictureEntries(total);
  const calls: number[] = [];
  const turnedBefore: boolean[] = [];
  let turned = true;
  resetNativeForTests();
  setNativeLoadOverrideForTests({
    path: '/stand-in/treemap_core.node',
    expectedVersion: '0.0.0-test',
    requireModule: () => ({
      version: () => '0.0.0-test',
      dataIsLocal: (paths: string[]) => {
        calls.push(paths.length);
        turnedBefore.push(turned);
        turned = false;
        setImmediate(() => { turned = true; });
        return new Uint8Array(paths.length);
      },
    }),
  });
  try {
    const { result: job, opens } = await watchingOpens(() => finished(getNearDupeJob(scan, 4)));
    assert.deepEqual(opens, {}, 'nothing whose data has left is opened');
    assert.equal(calls.reduce((a, n) => a + n, 0), total, 'every candidate was asked about, once');
    assert.ok(calls.every((n) => n <= 256), `no ask carries more than 256 paths: ${JSON.stringify(calls)}`);
    assert.equal(calls.length, Math.ceil(total / 256), `and the list is split no finer than that: ${JSON.stringify(calls)}`);
    assert.deepEqual(turnedBefore, calls.map(() => true), 'the event loop turned before each ask after the first');
    assert.deepEqual([job.available, job.reason, job.clusterCount], [true, undefined, 0], 'answered "not here" is an answer: nothing is unknown');
  } finally {
    realNative();
  }
});

test('the near-duplicate pass with no module that can ask: the scan’s flags alone decide', needsSharp, async () => {
  const b = await scanned();
  noModule();
  try {
    const { result: job, opens } = await watchingOpens(() => finished(getNearDupeJob(b.scan, 4)));
    assert.deepEqual(clustered(job), [['evicted.png', 'local-a.png', 'local-b.png', 'unsure.png']]);
    assert.deepEqual(opens, { 'local-a.png': 1, 'local-b.png': 1, 'evicted.png': 1, 'unsure.png': 1, 'broken.png': 1 });
    assert.equal(job.reason, undefined, 'nothing was asked, so nothing is unknown: the flags answered for every file');
  } finally {
    realNative();
  }
});

test('a superseded near-duplicate job stops asking at its next chunk', async () => {
  // A changed threshold supersedes the running job; the old one has no one
  // left to answer, so it must not go on asking about the rest of its list.
  // Both jobs step one chunk per turn of the event loop, and the old one
  // started first: had it gone on, its asks would be in before the new one
  // finished.
  const scan = pictureEntries(600);
  let calls = 0;
  let next: NearDupeJob | null = null;
  resetNativeForTests();
  setNativeLoadOverrideForTests({
    path: '/stand-in/treemap_core.node',
    expectedVersion: '0.0.0-test',
    requireModule: () => ({
      version: () => '0.0.0-test',
      dataIsLocal: (paths: string[]) => {
        calls++;
        next ??= getNearDupeJob(scan, 5);
        return new Uint8Array(paths.length);
      },
    }),
  });
  try {
    const first = getNearDupeJob(scan, 4);
    await waitFor(() => next !== null, 'the first ask');
    await finished(next!);
    assert.equal(first.cancelled, true, 'the first job was superseded');
    assert.equal(calls, 1 + 3, 'the first job asked once and stopped; the second asked about all 600 in three chunks');
  } finally {
    realNative();
  }
});
