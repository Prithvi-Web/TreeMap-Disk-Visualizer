import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-humanscale-test-'));
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { clearFactCache, computeFacts, factProviderIds, getFactProvider } from '../src/services/facts';
import {
  humanScaleProvider,
  setHumanScaleWalkCapForTests,
  HumanScaleFact,
} from '../src/services/facts/humanScaleProvider';

/**
 * The humanScale fact provider (v4 §9.3).
 *
 * What these tests defend is the sentence in §9.3 that makes the feature
 * honest: an equivalent like "about 3,100 photos" is computed **from the
 * actual file mix in that folder, never from a constant**. So every expected
 * number below is derived from fixture files whose byte sizes are written by
 * the test itself, and the assertions are hand-computed literals — if the
 * provider ever reaches for a generic average, the arithmetic stops matching.
 *
 * The second thing defended is §2.4: a folder with no comparable files gets
 * an empty `equivalents` array (nothing is shown), a kind with fewer than
 * MIN_COMPARABLE samples is absent rather than zeroed, and a path that is a
 * file or missing from the scan is skipped — absent from `values`, never a
 * fabricated `{ bytes: 0 }`.
 */

/* ------------------------------ harness ------------------------------ */

async function listen() {
  resetRateLimiter();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function req(port: number, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        host: '127.0.0.1',
        port,
        path: url,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Run a scan over `root` and wait for it to complete. */
async function scanned(port: number, root: string): Promise<string> {
  const started = await req(port, 'POST', '/api/scan', { path: root });
  assert.equal(started.status, 202, `scan refused: ${JSON.stringify(started.body)}`);
  const scanId = started.body.scanId as string;
  for (let i = 0; i < 400; i++) {
    const stats = await req(port, 'GET', `/api/scan/${scanId}/stats`);
    if (stats.body.status === 'complete') break;
    assert.notEqual(stats.body.status, 'error', 'fixture scan failed');
    await new Promise((r) => setTimeout(r, 25));
  }
  return scanId;
}

/**
 * A fixture whose media mix is fully known, and a completed scan over it.
 *
 * Every byte count is chosen so the true averages are exact integers, which
 * keeps the expected values below free of float-tolerance fudging:
 *
 *  photos20/   20 photos sized 1000+10i     → 21,900 bytes, average 1,095
 *  mixed/      20 photos sized 2000+100i    → 59,000 bytes, average 2,950
 *  mixed/clips 15 videos sized 10000+1000i  → 255,000 bytes, average 17,000
 *  few9/       9 photos (below the floor)   → no comparable kind
 *  nomedia/    txt + bin + extensionless    → no comparable kind
 *  zeromusic/  12 empty .mp3 files          → 12 samples but average 0
 *  capped30/   30 photos of exactly 1,000   → for the walk-cap test
 */
async function scannedMediaFixture(port: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-humanscale-fixture-'));

  const photos20 = path.join(root, 'photos20');
  fs.mkdirSync(photos20);
  for (let i = 0; i < 20; i++) {
    // One deliberately UPPERCASE name: the scanner lowercases extensions, so
    // this file must still land in the photo bucket or sampleCount reads 19.
    const name = i === 0 ? 'IMG_0000.JPG' : `img_${i}.${i % 2 === 0 ? 'jpg' : 'png'}`;
    fs.writeFileSync(path.join(photos20, name), Buffer.alloc(1000 + 10 * i));
  }

  const mixed = path.join(root, 'mixed');
  const clips = path.join(mixed, 'clips');
  fs.mkdirSync(mixed);
  fs.mkdirSync(clips);
  for (let i = 0; i < 20; i++) {
    const ext = i % 3 === 0 ? 'heic' : i % 3 === 1 ? 'jpg' : 'webp';
    fs.writeFileSync(path.join(mixed, `img_${i}.${ext}`), Buffer.alloc(2000 + 100 * i));
  }
  // Videos live one level down, so this folder also proves the walk descends
  // into subdirectories rather than reading direct children only.
  for (let i = 0; i < 15; i++) {
    fs.writeFileSync(path.join(clips, `clip_${i}.${i % 2 === 0 ? 'mp4' : 'mov'}`), Buffer.alloc(10000 + 1000 * i));
  }

  const few9 = path.join(root, 'few9');
  fs.mkdirSync(few9);
  for (let i = 0; i < 9; i++) {
    fs.writeFileSync(path.join(few9, `photo_${i}.png`), Buffer.alloc(500 + i));
  }

  const nomedia = path.join(root, 'nomedia');
  fs.mkdirSync(nomedia);
  fs.writeFileSync(path.join(nomedia, 'notes.txt'), Buffer.alloc(100));
  fs.writeFileSync(path.join(nomedia, 'data.bin'), Buffer.alloc(200));
  fs.writeFileSync(path.join(nomedia, 'README'), Buffer.alloc(50));

  const zeromusic = path.join(root, 'zeromusic');
  fs.mkdirSync(zeromusic);
  for (let i = 0; i < 12; i++) {
    fs.writeFileSync(path.join(zeromusic, `silent_${i}.mp3`), Buffer.alloc(0));
  }

  const capped30 = path.join(root, 'capped30');
  fs.mkdirSync(capped30);
  for (let i = 0; i < 30; i++) {
    fs.writeFileSync(path.join(capped30, `same_${i}.jpg`), Buffer.alloc(1000));
  }

  const scanId = await scanned(port, root);
  return {
    root,
    scanId,
    photos20,
    mixed,
    few9,
    nomedia,
    zeromusic,
    capped30,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const fresh = () => new AbortController().signal;

/* --------------------------- the folder's own mix --------------------------- */

test('a folder of 20 photos yields one photos entry from its own true average', async () => {
  const { port, close } = await listen();
  const fixture = await scannedMediaFixture(port);
  try {
    clearFactCache();
    const out = await computeFacts(fixture.scanId, [fixture.photos20], ['humanScale'], fresh());
    assert.equal(out.humanScale.available, true);

    const v = out.humanScale.values[fixture.photos20] as HumanScaleFact;
    // Sum of 1000+10i for i in 0..19 is 21,900; the average over 20 files is
    // exactly 1,095, and the folder holds nothing else — so a folder made
    // only of photos is equivalent to its own photo count.
    assert.deepEqual(v, {
      bytes: 21900,
      equivalents: [{ kind: 'photos', sampleCount: 20, avgBytes: 1095, equivalentCount: 20 }],
    });
    // The optional stays absent on an uncapped walk — never `capped: false`.
    assert.equal(Object.prototype.hasOwnProperty.call(v, 'capped'), false);
    assert.deepEqual(out.humanScale.stats, { requested: 1, computed: 1, skipped: 0, failed: 0 });
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('a mixed folder yields each kind from its own average, including nested files', async () => {
  const { port, close } = await listen();
  const fixture = await scannedMediaFixture(port);
  try {
    clearFactCache();
    const out = await computeFacts(fixture.scanId, [fixture.mixed], ['humanScale'], fresh());
    const v = out.humanScale.values[fixture.mixed] as HumanScaleFact;

    // The folder totals 59,000 (photos) + 255,000 (videos in clips/) =
    // 314,000 bytes. Each kind divides that same total by its OWN average:
    // photos 314,000 / 2,950 = 106.44 → 106; videos 314,000 / 17,000 =
    // 18.47 → 18. If either kind borrowed the other's average — or any
    // constant — neither literal would match.
    assert.deepEqual(v, {
      bytes: 314000,
      equivalents: [
        { kind: 'photos', sampleCount: 20, avgBytes: 2950, equivalentCount: 106 },
        { kind: 'videos', sampleCount: 15, avgBytes: 17000, equivalentCount: 18 },
      ],
    });
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('nine photos are below the floor: the kind is absent, not zeroed', async () => {
  const { port, close } = await listen();
  const fixture = await scannedMediaFixture(port);
  try {
    clearFactCache();
    const out = await computeFacts(fixture.scanId, [fixture.few9], ['humanScale'], fresh());
    const v = out.humanScale.values[fixture.few9] as HumanScaleFact;

    // An average of 9 files is an anecdote, not a basis. The photos kind is
    // not present with sampleCount 9 and no equivalent, and not present with
    // equivalentCount 0 — it is simply not in the array, so the UI shows
    // nothing rather than a figure resting on too few samples.
    assert.deepEqual(v.equivalents, []);
    assert.equal(v.bytes > 0, true, 'the byte figure itself is still real');
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('no comparable files means an empty equivalents array — never a generic average', async () => {
  const { port, close } = await listen();
  const fixture = await scannedMediaFixture(port);
  try {
    clearFactCache();
    const out = await computeFacts(
      fixture.scanId,
      [fixture.nomedia, fixture.zeromusic],
      ['humanScale'],
      fresh(),
    );

    const nomedia = out.humanScale.values[fixture.nomedia] as HumanScaleFact;
    assert.deepEqual(nomedia, { bytes: 350, equivalents: [] });

    // Twelve zero-byte mp3 files clear the sample floor but average 0 bytes.
    // Dividing by that average would be nonsense, so the kind is omitted the
    // same way an under-sampled one is.
    const zeromusic = out.humanScale.values[fixture.zeromusic] as HumanScaleFact;
    assert.deepEqual(zeromusic, { bytes: 0, equivalents: [] });
  } finally {
    fixture.cleanup();
    await close();
  }
});

/* ------------------------------ skipped paths ------------------------------ */

test('a file path is skipped and absent from values — directories only', async () => {
  const { port, close } = await listen();
  const fixture = await scannedMediaFixture(port);
  try {
    clearFactCache();
    const filePath = path.join(fixture.photos20, 'IMG_0000.JPG');
    const out = await computeFacts(fixture.scanId, [fixture.photos20, filePath], ['humanScale'], fresh());

    // A single file has no "mix of files" to compare against, so the provider
    // says nothing about it at all — same rule as sizeProvider's missing
    // paths: absent from `values`, never a zeroed placeholder.
    assert.equal(Object.prototype.hasOwnProperty.call(out.humanScale.values, filePath), false);
    assert.equal(out.humanScale.values[filePath], undefined);
    assert.ok(out.humanScale.values[fixture.photos20], 'the directory in the same batch still answered');
    assert.deepEqual(out.humanScale.stats, { requested: 2, computed: 1, skipped: 1, failed: 0 });
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('a path the scan does not contain is skipped and absent from values', async () => {
  const { port, close } = await listen();
  const fixture = await scannedMediaFixture(port);
  try {
    clearFactCache();
    const ghost = path.join(fixture.root, 'never-existed');
    const out = await computeFacts(fixture.scanId, [ghost], ['humanScale'], fresh());

    assert.equal(Object.prototype.hasOwnProperty.call(out.humanScale.values, ghost), false);
    assert.deepEqual(out.humanScale.stats, { requested: 1, computed: 0, skipped: 1, failed: 0 });
    // The invariant that lets a partial batch state itself honestly (§2.4).
    const s = out.humanScale.stats;
    assert.equal(s.requested, s.computed + s.skipped + s.failed);
  } finally {
    fixture.cleanup();
    await close();
  }
});

/* ------------------------------- determinism ------------------------------- */

test('recomputing from scratch gives byte-identical results', async () => {
  const { port, close } = await listen();
  const fixture = await scannedMediaFixture(port);
  try {
    clearFactCache();
    const paths = [fixture.photos20, fixture.mixed, fixture.nomedia];
    const first = await computeFacts(fixture.scanId, paths, ['humanScale'], fresh());
    // Clearing the cache between calls makes this a real determinism check —
    // without it the second call would be served from the cache and the
    // comparison would prove nothing about the computation.
    clearFactCache();
    const second = await computeFacts(fixture.scanId, paths, ['humanScale'], fresh());
    assert.deepEqual(second.humanScale, first.humanScale);
  } finally {
    fixture.cleanup();
    await close();
  }
});

/* -------------------------------- registry -------------------------------- */

test('the provider resolves through the registry like every other fact', async () => {
  const { port, close } = await listen();
  const fixture = await scannedMediaFixture(port);
  try {
    assert.ok(factProviderIds().includes('humanScale'), 'importing the facts index registered it');
    assert.equal(getFactProvider('humanScale'), humanScaleProvider);
    assert.equal(humanScaleProvider.id, 'humanScale');
    assert.equal(humanScaleProvider.label, 'Human-scale equivalents');
    assert.equal(humanScaleProvider.capabilityKey, null, 'reads only the in-memory scan, so always available');

    clearFactCache();
    const out = await computeFacts(fixture.scanId, [fixture.photos20], ['humanScale'], fresh());
    assert.equal(out.humanScale.available, true);
    assert.ok(out.humanScale.values[fixture.photos20]);
  } finally {
    fixture.cleanup();
    await close();
  }
});

/* ---------------------------------- abort ---------------------------------- */

test('an already-aborted signal computes nothing, and the stats still add up', async () => {
  const { port, close } = await listen();
  const fixture = await scannedMediaFixture(port);
  try {
    clearFactCache();
    const controller = new AbortController();
    controller.abort();
    const out = await computeFacts(
      fixture.scanId,
      [fixture.photos20, fixture.mixed],
      ['humanScale'],
      controller.signal,
    );
    assert.deepEqual(out.humanScale.stats, { requested: 2, computed: 0, skipped: 2, failed: 0 });
    assert.deepEqual(out.humanScale.values, {});
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('an abort discovered mid-walk skips that path entirely — never a partial value', async () => {
  const { port, close } = await listen();
  // A dedicated fixture: the in-walk abort check runs every 4,096 visited
  // nodes, so the tree must be bigger than that for the check to ever fire.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-humanscale-big-'));
  const many = path.join(root, 'many');
  fs.mkdirSync(many);
  for (let i = 0; i < 4200; i++) {
    fs.writeFileSync(path.join(many, `f_${i}.jpg`), Buffer.alloc(10));
  }
  try {
    const scanId = await scanned(port, root);
    clearFactCache();

    // The walk is synchronous, so a real AbortController cannot flip during
    // it from the same event loop. This stand-in reads as live once (the
    // between-paths check at the top of the loop) and aborted ever after, so
    // the walk is guaranteed to be mid-flight when it learns of the abort.
    let reads = 0;
    const flipsAfterFirstRead = {
      get aborted() {
        reads += 1;
        return reads > 1;
      },
    } as unknown as AbortSignal;

    const batch = await humanScaleProvider.compute(scanId, [many, root], flipsAfterFirstRead);
    assert.equal(batch.available, true);
    // Had the walk returned what it counted before the abort, `many` would be
    // present with a partial (and wrong-looking) sample. Aborted means
    // skipped: no value at all, and the remaining path is skipped too.
    assert.equal(batch.values.size, 0);
    assert.deepEqual(batch.stats, { requested: 2, computed: 0, skipped: 2, failed: 0 });
    assert.ok(reads >= 2, 'the abort was discovered inside the walk, not at the loop top');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await close();
  }
});

/* --------------------------------- the cap --------------------------------- */

test('a walk that hits the node cap reports what it counted, marked capped', async () => {
  const { port, close } = await listen();
  const fixture = await scannedMediaFixture(port);
  // Cap 12 visits the directory itself plus 11 of its 30 photos. Every photo
  // is exactly 1,000 bytes, so the average is 1,000 no matter which eleven
  // the traversal reached — the assertion cannot flake on child order.
  const restore = setHumanScaleWalkCapForTests(12);
  try {
    clearFactCache();
    const out = await computeFacts(fixture.scanId, [fixture.capped30], ['humanScale'], fresh());
    const v = out.humanScale.values[fixture.capped30] as HumanScaleFact;
    assert.deepEqual(v, {
      bytes: 30000,
      capped: true,
      // 11 samples still clear MIN_COMPARABLE, and the folder's full 30,000
      // bytes divided by the sampled average of 1,000 says "about 30 photos"
      // — the UI's basis line can state the truncated sample honestly.
      equivalents: [{ kind: 'photos', sampleCount: 11, avgBytes: 1000, equivalentCount: 30 }],
    });

    // With the cap restored the same folder answers in full, and the capped
    // marker disappears entirely rather than lingering as `capped: false`.
    restore();
    clearFactCache();
    const full = await computeFacts(fixture.scanId, [fixture.capped30], ['humanScale'], fresh());
    const fv = full.humanScale.values[fixture.capped30] as HumanScaleFact;
    assert.deepEqual(fv, {
      bytes: 30000,
      equivalents: [{ kind: 'photos', sampleCount: 30, avgBytes: 1000, equivalentCount: 30 }],
    });
    assert.equal(Object.prototype.hasOwnProperty.call(fv, 'capped'), false);
  } finally {
    restore();
    fixture.cleanup();
    await close();
  }
});
