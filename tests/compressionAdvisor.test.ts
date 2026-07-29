import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MediaProbe, MediaTools, encodeOne, encoderFor, estimateFor, expectedRatio,
  isWorthEncoding, setMediaTools, shortlistFromScan, verifyEncode, MIN_CANDIDATE_BYTES,
} from '../src/services/compressionAdvisor';
import { FileNode } from '../src/models/types';

/**
 * §C2 — media compression advisor.
 *
 * ffmpeg is not installed on this machine, so the real encode cannot run here.
 * What CAN be tested — and is what actually keeps a user's video safe — is the
 * ORDER of the pipeline, and every branch of it. The external tools sit behind
 * a `MediaTools` seam so a fake can fail in each of the ways ffmpeg really
 * fails: producing nothing, producing a truncated file, producing something
 * bigger, producing something unreadable.
 *
 * The rule every test below defends: **the original is only ever touched after
 * the replacement has been proven good, and it is only ever moved to the
 * Trash.**
 */

const roots: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-enc-'));
  roots.push(dir);
  return dir;
}
afterEach(() => setMediaTools(null));
process.on('exit', () => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function probe(over: Partial<MediaProbe> = {}): MediaProbe {
  return { durationSeconds: 60, videoCodec: 'h264', width: 1920, height: 1080, bitrateBps: 8e6, frameCount: 1440, ...over };
}

/**
 * A fake ffmpeg. `write` decides what the "encoder" produces, so each real
 * failure mode can be reproduced exactly.
 */
function fakeTools(opts: {
  write?: (output: string) => void;
  encodeThrows?: string;
  probeOf?: (file: string) => MediaProbe | null;
} = {}): MediaTools {
  return {
    async availability() {
      return { available: true, encoder: 'hevc_videotoolbox', hardwareCodecs: ['hevc', 'h264'], mechanism: 'fake' };
    },
    async probe(file) {
      return opts.probeOf ? opts.probeOf(file) : probe();
    },
    async encode(_input, output) {
      if (opts.encodeThrows) throw new Error(opts.encodeThrows);
      (opts.write ?? ((o: string) => fs.writeFileSync(o, Buffer.alloc(400))))(output);
    },
  };
}

function original(dir: string, bytes = 1000): string {
  const file = path.join(dir, 'holiday.mp4');
  fs.writeFileSync(file, Buffer.alloc(bytes, 3));
  return file;
}

/* ─────────────── Estimation and shortlisting ─────────────── */

test('the estimate is conservative, and worse codecs are expected to shrink more', () => {
  assert.ok(expectedRatio('h264') > expectedRatio('mpeg2video'), 'older codecs shrink further');
  assert.ok(expectedRatio('mpeg2video') > expectedRatio('prores'), 'intermediate formats shrink most');
  assert.ok(expectedRatio('h264') >= 0.5, 'an estimate that oversells becomes a complaint');
  const { estimatedBytes, estimatedSaving } = estimateFor(1000, 'h264');
  assert.equal(estimatedBytes + estimatedSaving, 1000);
});

test('already-efficient video is never offered', () => {
  // Re-encoding HEVC to HEVC loses quality for nothing.
  for (const codec of ['hevc', 'h265', 'av1', 'vp9']) {
    assert.equal(isWorthEncoding(probe({ videoCodec: codec })), false, `${codec} must not be a candidate`);
  }
  for (const codec of ['h264', 'mpeg4', 'wmv3', 'prores']) {
    assert.equal(isWorthEncoding(probe({ videoCodec: codec })), true, `${codec} should be`);
  }
  assert.equal(isWorthEncoding(null), false, 'an unprobeable file is not a candidate');
});

test('the shortlist is big video files only, largest first', () => {
  const root = path.resolve('/vids');
  const file = (name: string, size: number): FileNode => ({
    name, path: path.join(root, name), size, type: 'file', modifiedAt: 0, isHidden: false,
    extension: (name.split('.').pop() || '').toLowerCase(),
  });
  const tree: FileNode = {
    name: 'vids', path: root, type: 'dir', modifiedAt: 0, isHidden: false, size: 0,
    children: [
      file('small.mp4', MIN_CANDIDATE_BYTES - 1),
      file('big.mov', MIN_CANDIDATE_BYTES * 3),
      file('medium.mp4', MIN_CANDIDATE_BYTES * 2),
      file('notes.txt', MIN_CANDIDATE_BYTES * 9),
      file('photo.jpg', MIN_CANDIDATE_BYTES * 9),
    ],
  };
  const list = shortlistFromScan(tree, []);
  assert.deepEqual(list.map((f) => f.name), ['big.mov', 'medium.mp4'], 'no documents, no images, nothing small');
});

test('the encoder is the platform’s hardware one, never a software fallback', () => {
  assert.equal(encoderFor('hevc', 'darwin'), 'hevc_videotoolbox');
  assert.equal(encoderFor('hevc', 'win32'), 'hevc_qsv');
  assert.equal(encoderFor('hevc', 'linux'), 'hevc_vaapi');
  for (const p of ['darwin', 'win32', 'linux'] as const) {
    assert.doesNotMatch(encoderFor('hevc', p), /^libx|^libsvt|^librav/, 'no software encoder may be selected');
  }
});

/* ─────────────── Verification, one test per real failure mode ─────────────── */

test('a truncated encode is rejected — the classic ffmpeg failure', () => {
  // It looks perfectly fine until you play the end.
  const verdict = verifyEncode(probe({ durationSeconds: 600 }), probe({ durationSeconds: 540 }), 1000, 400);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /shorter than the original/);
});

test('a small timing difference is tolerated', () => {
  // Container rounding routinely shifts the duration by a fraction of a second.
  assert.equal(verifyEncode(probe({ durationSeconds: 600 }), probe({ durationSeconds: 599.7 }), 1000, 400).ok, true);
});

test('an unreadable, empty, bigger or frame-short encode is rejected', () => {
  assert.match(verifyEncode(probe(), null, 1000, 400).reason!, /could not be opened/);
  assert.match(verifyEncode(probe(), probe(), 1000, 0).reason!, /empty/);
  assert.match(verifyEncode(probe(), probe(), 1000, 1200).reason!, /not smaller/);
  assert.match(verifyEncode(probe({ frameCount: 1000 }), probe({ frameCount: 800 }), 1000, 400).reason!, /frames where the original has/);
  assert.match(verifyEncode(probe(), probe({ durationSeconds: null }), 1000, 400).reason!, /reports no duration/);
});

/* ─────────────── The pipeline: what happens to the user's file ─────────────── */

test('a good encode replaces the original, which goes to the Trash, keeping its date', async () => {
  const dir = tmp();
  const file = original(dir, 1000);
  const before = fs.statSync(file);
  setMediaTools(fakeTools());

  const outcome = await encodeOne(file, 'hevc_videotoolbox', 0, () => undefined);
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.originalBytes, 1000);
  assert.equal(outcome.newBytes, 400);
  assert.equal(outcome.savedBytes, 600);

  assert.equal(fs.statSync(file).size, 400, 'the new file sits at the original path');
  assert.equal(Math.round(fs.statSync(file).mtimeMs), Math.round(before.mtimeMs), 'the date survives — "sort by date" depends on it');
  assert.deepEqual(fs.readdirSync(dir), ['holiday.mp4'], 'no temp file is left behind');
});

test('a failed encode leaves the original exactly where it was', async () => {
  const dir = tmp();
  const file = original(dir, 1000);
  setMediaTools(fakeTools({ encodeThrows: 'hevc_videotoolbox: Invalid argument' }));

  const outcome = await encodeOne(file, 'hevc_videotoolbox', 0, () => undefined);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error!, /Invalid argument/);
  assert.equal(fs.statSync(file).size, 1000, 'untouched');
  assert.deepEqual(fs.readdirSync(dir), ['holiday.mp4'], 'and the half-written encode is cleaned up');
});

test('an encode that fails VERIFICATION never reaches the original', async () => {
  const dir = tmp();
  const file = original(dir, 1000);
  // The encoder "succeeds" but produces a file half the length.
  setMediaTools(fakeTools({
    probeOf: (f) => (f === file ? probe({ durationSeconds: 600 }) : probe({ durationSeconds: 300 })),
  }));

  const outcome = await encodeOne(file, 'hevc_videotoolbox', 0, () => undefined);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error!, /^Kept the original/);
  assert.match(outcome.error!, /shorter/);
  assert.equal(fs.statSync(file).size, 1000, 'the original is still the original');
  assert.deepEqual(fs.readdirSync(dir), ['holiday.mp4'], 'the bad encode is gone');
});

test('an encode that produces nothing is caught before anything is trashed', async () => {
  const dir = tmp();
  const file = original(dir, 1000);
  setMediaTools(fakeTools({ write: () => undefined })); // ffmpeg exits 0, writes no file

  const outcome = await encodeOne(file, 'hevc_videotoolbox', 0, () => undefined);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error!, /produced no file/);
  assert.equal(fs.statSync(file).size, 1000);
});

test('an encode that comes out bigger is discarded', async () => {
  const dir = tmp();
  const file = original(dir, 1000);
  setMediaTools(fakeTools({ write: (o) => fs.writeFileSync(o, Buffer.alloc(5000)) }));

  const outcome = await encodeOne(file, 'hevc_videotoolbox', 0, () => undefined);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error!, /not smaller/);
  assert.equal(fs.statSync(file).size, 1000, 'a bigger "saving" is not a saving');
  assert.deepEqual(fs.readdirSync(dir), ['holiday.mp4']);
});

test('the original is never overwritten in place', async () => {
  const dir = tmp();
  const file = original(dir, 1000);
  const seen: string[] = [];
  setMediaTools({
    ...fakeTools(),
    async encode(input, output) {
      seen.push(output);
      // The single most important assertion in this file.
      assert.notEqual(output, input, 'the encoder must never be pointed at the original');
      assert.equal(fs.statSync(input).size, 1000, 'and the original is intact while it runs');
      fs.writeFileSync(output, Buffer.alloc(400));
    },
  });
  await encodeOne(file, 'hevc_videotoolbox', 0, () => undefined);
  assert.equal(seen.length, 1);
  assert.equal(path.dirname(seen[0]), dir, 'the temp file is beside the original, so promoting it is one rename');
});

test('progress is reported while a file encodes', async () => {
  const dir = tmp();
  const file = original(dir, 1000);
  const seen: number[] = [];
  setMediaTools({
    ...fakeTools(),
    async encode(_i, output, _e, _d, onProgress) {
      onProgress(0.25); onProgress(0.5); onProgress(1);
      fs.writeFileSync(output, Buffer.alloc(400));
    },
  });
  await encodeOne(file, 'hevc_videotoolbox', 0, (f) => seen.push(f));
  assert.deepEqual(seen, [0.25, 0.5, 1]);
});
