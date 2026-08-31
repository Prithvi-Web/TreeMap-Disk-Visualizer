import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { recommendKeep, diffBlocks, diffSummary, parseExifCaptureDate } from '../src/services/dupeViewer';
import { FileNode } from '../src/models/types';

/**
 * The duplicate viewer's facts (§8.2). Two rules govern every assertion here:
 * the keeper recommendation must SAY which rule picked it, and every fact the
 * server cannot read must come back null with a reason — never a guess, never
 * a fabricated date, never a hidden failure.
 */

let sharpAvailable = true;
try {
  require('sharp');
} catch {
  sharpAvailable = false;
}

/* ────────────────────────── recommendKeep (pure) ────────────────────────── */

test('recommendKeep prefers the file that is both newest and largest, and says so', () => {
  const r = recommendKeep([
    { size: 100, modifiedAt: 1_000 },
    { size: 200, modifiedAt: 2_000 },
  ]);
  assert.equal(r.index, 1);
  assert.match(r.reason, /newest/i);
  assert.match(r.reason, /largest/i);
});

test('recommendKeep keeps a meaningfully larger older file, and names the size rule', () => {
  // The older file carries twice the bytes — a larger original vs a re-encode.
  const r = recommendKeep([
    { size: 200, modifiedAt: 1_000 },
    { size: 100, modifiedAt: 2_000 },
  ]);
  assert.equal(r.index, 0);
  assert.match(r.reason, /100% larger than the newest/);
});

test('recommendKeep keeps the newest when the older file is larger by 10% or less', () => {
  const r = recommendKeep([
    { size: 105, modifiedAt: 1_000 },
    { size: 100, modifiedAt: 2_000 },
  ]);
  assert.equal(r.index, 1);
  assert.match(r.reason, /newest/i);
  assert.match(r.reason, /not by more than the 10% margin/, "the boundary prose must be true AT the boundary: 10% larger is not \"under 10%\"");
});

test('recommendKeep sits exactly on the 10% boundary honestly: 10% is not "meaningfully" larger', () => {
  // 110 vs 100 is exactly 10% — the rule is STRICTLY more than 10%.
  const r = recommendKeep([
    { size: 110, modifiedAt: 1_000 },
    { size: 100, modifiedAt: 2_000 },
  ]);
  assert.equal(r.index, 1, 'exactly 10% larger does not unseat the newest');
  const over = recommendKeep([
    { size: 111, modifiedAt: 1_000 },
    { size: 100, modifiedAt: 2_000 },
  ]);
  assert.equal(over.index, 0, 'just over 10% does');
});

test('recommendKeep breaks a same-age tie toward the larger file', () => {
  const r = recommendKeep([
    { size: 100, modifiedAt: 5_000 },
    { size: 300, modifiedAt: 5_000 },
  ]);
  assert.equal(r.index, 1);
  assert.match(r.reason, /largest/i);
});

test('recommendKeep is honest about a dead tie', () => {
  const r = recommendKeep([
    { size: 100, modifiedAt: 5_000 },
    { size: 100, modifiedAt: 5_000 },
    { size: 100, modifiedAt: 5_000 },
  ]);
  assert.equal(r.index, 0);
  assert.match(r.reason, /same age and size/);
});

test('recommendKeep keeps the non-empty copy when the newest is empty', () => {
  const r = recommendKeep([
    { size: 4_096, modifiedAt: 1_000 },
    { size: 0, modifiedAt: 2_000 },
  ]);
  assert.equal(r.index, 0);
  assert.match(r.reason, /empty/);
});

/* ─────────────────────── dHash diff blocks + summary ─────────────────────── */

test('diffBlocks of identical hashes is empty', () => {
  assert.deepEqual(diffBlocks([0xdeadbeef, 0x12345678], [0xdeadbeef, 0x12345678]), []);
});

test('diffBlocks maps bits to the documented 0–63 indices: lo carries 0–31, hi carries 32–63', () => {
  // DHash is [hi, lo]; dhashFromGray fills bit 0 first, into lo.
  assert.deepEqual(diffBlocks([0, 0], [0, 1]), [0]);
  assert.deepEqual(diffBlocks([0, 0], [1, 0]), [32]);
  assert.deepEqual(diffBlocks([0, 0], [0x80000000, 0]), [63]);
  // bit 9 = row 1, col 1 of the 8×8 grid per the row = floor(i/8) contract.
  assert.deepEqual(diffBlocks([0, 0], [0, 1 << 9]), [9]);
});

test('diffBlocks length always equals the Hamming distance', () => {
  const a: [number, number] = [0xffffffff, 0];
  const b: [number, number] = [0, 0xffffffff];
  assert.equal(diffBlocks(a, b).length, 64);
});

test('diffSummary speaks plainly at each distance', () => {
  assert.match(diffSummary(0), /identical perceptual fingerprint/);
  assert.match(diffSummary(4), /differs in 4 of 64 blocks/);
  assert.match(diffSummary(4), /re-encode/);
  assert.match(diffSummary(12), /edit or crop/);
  assert.match(diffSummary(30), /differs in 30 of 64 blocks/);
  assert.doesNotMatch(diffSummary(30), /re-encode/);
});

/* ──────────────────── EXIF DateTimeOriginal (minimal, honest) ──────────────────── */

/**
 * Build a minimal EXIF payload the way a camera would: "Exif\0\0", a TIFF
 * header, IFD0 holding only the Exif-IFD pointer (0x8769), and an Exif IFD
 * holding only DateTimeOriginal (0x9003) as ASCII. All IFD offsets are
 * relative to the TIFF header, exactly as the spec demands.
 */
function exifPayload(dto: string | null, bigEndian = false): Buffer {
  const buf = Buffer.alloc(120);
  buf.write('Exif\0\0', 0, 'latin1');
  const tiff = 6;
  const le = !bigEndian;
  const w16 = (v: number, rel: number) => (le ? buf.writeUInt16LE(v, tiff + rel) : buf.writeUInt16BE(v, tiff + rel));
  const w32 = (v: number, rel: number) => (le ? buf.writeUInt32LE(v, tiff + rel) : buf.writeUInt32BE(v, tiff + rel));
  buf.write(le ? 'II' : 'MM', tiff, 'latin1');
  w16(42, 2);
  w32(8, 4); // IFD0 at rel 8
  if (dto === null) {
    // IFD0 with a single unrelated tag (Orientation) and no Exif pointer.
    w16(1, 8);
    w16(0x0112, 10); w16(3, 12); w32(1, 14); w32(1, 18);
    w32(0, 22);
    return buf.subarray(0, tiff + 26);
  }
  // IFD0: one entry, the Exif-IFD pointer → rel 26.
  w16(1, 8);
  w16(0x8769, 10); w16(4, 12); w32(1, 14); w32(26, 18);
  w32(0, 22);
  // Exif IFD at rel 26: one entry, DateTimeOriginal, ASCII at rel 44.
  w16(1, 26);
  w16(0x9003, 28); w16(2, 30); w32(dto.length + 1, 32); w32(44, 36);
  w32(0, 40);
  buf.write(dto + '\0', tiff + 44, 'latin1');
  return buf.subarray(0, tiff + 44 + dto.length + 1);
}

test('parseExifCaptureDate reads DateTimeOriginal from both byte orders', () => {
  assert.equal(parseExifCaptureDate(exifPayload('2020:01:02 03:04:05')), '2020-01-02T03:04:05');
  assert.equal(parseExifCaptureDate(exifPayload('1999:12:31 23:59:59', true)), '1999-12-31T23:59:59');
});

test('parseExifCaptureDate returns null when the tag is absent — never a fabricated date', () => {
  assert.equal(parseExifCaptureDate(exifPayload(null)), null);
});

test('parseExifCaptureDate refuses a blank or malformed date', () => {
  // Cameras write all-spaces when the clock was never set.
  assert.equal(parseExifCaptureDate(exifPayload('    :  :     :  :  ')), null);
  assert.equal(parseExifCaptureDate(exifPayload('yesterday, probably')), null);
});

test('parseExifCaptureDate survives garbage without throwing', () => {
  assert.equal(parseExifCaptureDate(Buffer.from('not exif at all')), null);
  assert.equal(parseExifCaptureDate(Buffer.alloc(0)), null);
  assert.equal(parseExifCaptureDate(Buffer.from('Exif\0\0II')), null);
});

/* ───────────────────────────── the route, live ───────────────────────────── */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dupeviewer-'));
const OLD_TXT = path.join(tmp, 'old.txt');
const NEW_TXT = path.join(tmp, 'new.txt');
const COMMA_TXT = path.join(tmp, 'we,ird.txt');
const BIG_TXT = path.join(tmp, 'big.txt');
const IMG_A = path.join(tmp, 'imgA.png');
const IMG_B = path.join(tmp, 'imgB.png');
const IMG_EXIF = path.join(tmp, 'shot.jpg');

fs.writeFileSync(OLD_TXT, 'hello world universe'); // 20 bytes — the meaningfully larger, older copy
fs.writeFileSync(NEW_TXT, 'hello'); // 5 bytes — newest
fs.writeFileSync(COMMA_TXT, 'hello');
fs.writeFileSync(BIG_TXT, 'x'.repeat(512 * 1024)); // dwarfs any 32×32 PNG, so the keeper rule picks it

/** Same pixels twice + one EXIF-carrying JPEG, written by sharp itself. */
/**
 * The EXIF fixture ships as bytes rather than being written through sharp's
 * `withExif` JPEG save — that save fails with EINVAL on the Windows CI
 * runner's libvips build ("unable to open for write: Invalid argument"),
 * which took this whole file's suite down. These 1,073 bytes were produced
 * once by exactly that call on a machine where it works, round-tripped
 * through sharp.metadata() + parseExifCaptureDate to prove they carry
 * DateTimeOriginal 2020:01:02 03:04:05, and are decoded here on every
 * platform identically. sharp is still needed to READ them — the tests
 * stay skip-gated on sharpAvailable for that.
 */
const IMG_EXIF_BYTES = Buffer.from(
  '/9j/4QDcRXhpZgAASUkqAAgAAAAGABIBAwABAAAAAQAAABoBBQABAAAAVgAAABsBBQABAAAAXgAAACgBAwABAAAAAgAAABMC' +
  'AwABAAAAAQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA6AMAADhjAADoAwAABwAAkAcABAAAADAyMTADkAIAFAAAAMAAAAABkQcA' +
  'BAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAACAAAAADoAQAAQAAACAAAAAAAAAAMjAyMDowMTowMiAw' +
  'MzowNDowNQD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0o' +
  'MCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo' +
  'KCj/wAARCAAgACADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAgMB/8QAJBAAAgICAQQBBQAAAAAAAAAAAQIDBAUR' +
  'ABIUISJBEzEyQlH/xAAWAQEBAQAAAAAAAAAAAAAAAAACAwH/xAAgEQAABQQDAQAAAAAAAAAAAAAAITFB8AECEXGBobHR/9oA' +
  'DAMBAAIRAxEAPwDUxihUgo4sKvrPVggoj4HSRLaot9vyPSU/nj9uA2EyqEw2YsqI17iu3cV79ars+yJFOqTMeldeGJO18trX' +
  'GmMUKkFHFhV9Z6sEFEfA6SJbVFvt+R6Sn88ftwGwmVQmGzFlRGvcV27ivfrVdn2RIp1SZj0rrwxJ2vlta5lFncZTCpTENPPr' +
  '4GPO2NYyx2ZcT3BaxBI0tjHT2WA28UcMyvCo2wAAIA2vlRyzY97chk7KRzZc2YEhprNM8wX2+vapOGAZmJ9k+d6YrvkXnbGs' +
  'ZY7MuJ7gtYgkaWxjp7LAbeKOGZXhUbYAAEAbXyo5Zse9uQydlI5subMCQ01mmeYL7fXtUnDAMzE+yfO9MV3x3Ee98RkE7mkm' +
  'gUxihUgo4sKvrPVggoj4HSRLaot9vyPSU/nj9uA2EyqEw2YsqI17iu3cV79ars+yJFOqTMeldeGJO18trXGmMUKkFHFhV9Z6' +
  'sEFEfA6SJbVFvt+R6Sn88ftwGwmVQmGzFlRGvcV27ivfrVdn2RIp1SZj0rrwxJ2vlta4KLO4ymKUpiGnn18DHnbGsZY7MuJ7' +
  'gtYgkaWxjp7LAbeKOGZXhUbYAAEAbXyo5Zse9uQydlI5subMCQ01mmeYL7fXtUnDAMzE+yfO9MV3yLztjWMsdmXE9wWsQSNL' +
  'Yx09lgNvFHDMrwqNsAACANr5Ucs2Pe3IZOykc2XNmBIaazTPMF9vr2qThgGZifZPnemK747iPe+IyCdzSTQ//9k=',
  'base64',
);

let imagesWritten = false;
async function writeImages(): Promise<void> {
  // Once. Every test calls this, and the fixtures are byte-identical each
  // time — but rewriting them raced Windows CI: the previous test's sharp
  // decode can still hold shot.jpg's handle when the next write opens it,
  // and Windows refuses to replace an open file (both red runs — sharp's
  // EINVAL and node's UNKNOWN — were this race in different masks).
  if (imagesWritten) return;
  const sharp = require('sharp');
  const raw = Buffer.alloc(32 * 32 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) % 256;
  await sharp(raw, { raw: { width: 32, height: 32, channels: 3 } }).png().toFile(IMG_A);
  await sharp(raw, { raw: { width: 32, height: 32, channels: 3 } }).png().toFile(IMG_B);
  fs.writeFileSync(IMG_EXIF, IMG_EXIF_BYTES);
  imagesWritten = true;
}

function fileNode(p: string, modifiedAt: number): FileNode {
  const st = fs.statSync(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  return {
    name: path.basename(p), path: p, size: st.size, type: 'file',
    modifiedAt, isHidden: false, ...(ext ? { extension: ext } : {}),
  };
}

/** The scanned tree carries its own mtimes — the route must answer from THESE. */
function tree(withImages: boolean): FileNode {
  const children = [
    fileNode(OLD_TXT, 1_000),
    fileNode(NEW_TXT, 2_000),
    fileNode(COMMA_TXT, 3_000),
    fileNode(BIG_TXT, 3_000),
    ...(withImages ? [fileNode(IMG_A, 1_000), fileNode(IMG_B, 2_000), fileNode(IMG_EXIF, 1_500)] : []),
  ];
  return {
    name: path.basename(tmp), path: tmp, type: 'dir', modifiedAt: 0, isHidden: false,
    size: children.reduce((s, c) => s + c.size, 0), children,
  };
}

async function listen(withImages: boolean) {
  resetRateLimiter();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const scan = createScanRecord(tmp);
  scan.status = 'complete';
  scan.root = tree(withImages);
  return {
    port: (server.address() as { port: number }).port,
    scanId: scan.scanId,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function get(port: number, url: string): Promise<{ status: number; body: any }> {
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

const detailUrl = (scanId: string, paths: string[]) =>
  `/api/duplicates/detail?scanId=${scanId}&paths=${paths.map(encodeURIComponent).join(',')}`;

test('detail over a real scan: tree metadata, the keeper rule, and honest nulls for non-images', async () => {
  const s = await listen(false);
  try {
    const r = await get(s.port, detailUrl(s.scanId, [OLD_TXT, NEW_TXT]));
    assert.equal(r.status, 200);
    assert.equal(r.body.scanId, s.scanId);
    assert.equal(r.body.files.length, 2);

    const [oldF, newF] = r.body.files;
    // Metadata answers from the scanned tree, mtimes included.
    assert.equal(oldF.name, 'old.txt');
    assert.equal(oldF.size, 20);
    assert.equal(oldF.modifiedAt, 1_000);
    assert.equal(newF.modifiedAt, 2_000);
    assert.equal(oldF.largest, true);
    assert.equal(oldF.newest, false);
    assert.equal(newF.newest, true);
    assert.equal(newF.largest, false);

    // 20 bytes vs 5: the older file is 300% larger, so the size rule fires.
    assert.equal(r.body.recommendedKeep.index, 0);
    assert.match(r.body.recommendedKeep.reason, /larger than the newest/);

    // Not an image: every image fact is null WITH the reason stated.
    for (const f of r.body.files) {
      assert.equal(f.isImage, false);
      assert.equal(f.width, null);
      assert.equal(f.height, null);
      assert.equal(f.dimensionsReason, 'not an image');
      assert.equal(f.captureDate, null);
      assert.equal(f.captureDateReason, 'not an image');
      assert.equal(f.visualDiff, null);
      assert.equal(f.visualDiffReason, 'not an image');
    }
    assert.equal(r.body.diffReference, null);
  } finally {
    await s.close();
  }
});

test('detail for images: dimensions, dHash diff vs the recommended keep, honest missing capture date', { skip: !sharpAvailable }, async () => {
  await writeImages();
  const s = await listen(true);
  try {
    const r = await get(s.port, detailUrl(s.scanId, [IMG_A, IMG_B]));
    assert.equal(r.status, 200);
    const [a, b] = r.body.files;

    for (const f of [a, b]) {
      assert.equal(f.isImage, true);
      assert.equal(f.width, 32);
      assert.equal(f.height, 32);
      assert.equal(f.dimensionsReason, null);
      // PNGs written by sharp carry no EXIF: null + reason, never a guess.
      assert.equal(f.captureDate, null);
      assert.equal(f.captureDateReason, 'no capture date recorded');
    }

    // Same bytes, so imgB (newer) wins and imgA is diffed against it.
    assert.equal(r.body.recommendedKeep.index, 1);
    assert.equal(r.body.diffReference, 1);
    assert.equal(b.visualDiff, null, 'the reference is not diffed against itself');
    assert.match(b.visualDiffReason, /reference/);
    assert.equal(a.visualDiff.hammingDistance, 0);
    assert.deepEqual(a.visualDiff.differingBlocks, []);
    assert.match(a.visualDiff.summary, /identical perceptual fingerprint/);
    assert.equal(a.visualDiffReason, null);
  } finally {
    await s.close();
  }
});

test('detail reads DateTimeOriginal when the image records one', { skip: !sharpAvailable }, async () => {
  await writeImages();
  const s = await listen(true);
  try {
    const r = await get(s.port, detailUrl(s.scanId, [IMG_EXIF, IMG_A]));
    assert.equal(r.status, 200);
    const shot = r.body.files[0];
    assert.equal(shot.captureDate, '2020-01-02T03:04:05');
    assert.equal(shot.captureDateReason, null);
  } finally {
    await s.close();
  }
});

test('a mixed group is honest: no fingerprint for the keeper means no comparison, not a fake one', { skip: !sharpAvailable }, async () => {
  await writeImages();
  const s = await listen(true);
  try {
    // BIG_TXT is both newest and largest of the two, so it is the keeper —
    // and a text file has no dHash to diff the image against.
    const r = await get(s.port, detailUrl(s.scanId, [BIG_TXT, IMG_A]));
    assert.equal(r.status, 200);
    assert.equal(r.body.recommendedKeep.index, 0);
    assert.equal(r.body.diffReference, null);
    const img = r.body.files[1];
    assert.equal(img.visualDiff, null);
    assert.match(img.visualDiffReason, /no comparison/);
  } finally {
    await s.close();
  }
});

test('a comma in a filename survives the round trip', async () => {
  const s = await listen(false);
  try {
    const r = await get(s.port, detailUrl(s.scanId, [COMMA_TXT, NEW_TXT]));
    assert.equal(r.status, 200);
    assert.equal(r.body.files[0].name, 'we,ird.txt');
  } finally {
    await s.close();
  }
});

test('a path outside the scan is refused, not guessed about', async () => {
  const s = await listen(false);
  try {
    const r = await get(s.port, detailUrl(s.scanId, [OLD_TXT, path.join(os.tmpdir(), 'nope.txt')]));
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'PATH_NOT_IN_SCAN');
  } finally {
    await s.close();
  }
});

test('fewer than 2 or more than 8 paths is refused', async () => {
  const s = await listen(false);
  try {
    const one = await get(s.port, detailUrl(s.scanId, [OLD_TXT]));
    assert.equal(one.status, 400);
    assert.equal(one.body.code, 'PATHS_RANGE');
    const nine = await get(s.port, detailUrl(s.scanId, Array.from({ length: 9 }, () => OLD_TXT)));
    assert.equal(nine.status, 400);
    assert.equal(nine.body.code, 'PATHS_RANGE');
  } finally {
    await s.close();
  }
});

test('a folder is refused — the viewer compares files', async () => {
  const s = await listen(false);
  try {
    const r = await get(s.port, detailUrl(s.scanId, [tmp, OLD_TXT]));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'NOT_A_FILE');
  } finally {
    await s.close();
  }
});

test('an unknown scanId is a 404', async () => {
  const s = await listen(false);
  try {
    const r = await get(s.port, detailUrl('no-such-scan', [OLD_TXT, NEW_TXT]));
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'SCAN_NOT_FOUND');
  } finally {
    await s.close();
  }
});
