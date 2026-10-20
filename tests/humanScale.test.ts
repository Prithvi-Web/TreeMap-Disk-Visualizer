import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-humanscale-test-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { peekScan } from '../src/services/diskScanner';
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

/**
 * Servers a test opened and has not closed yet. Most tests open theirs before
 * the fixture scan and close it in a `finally` that only begins after the
 * fixture returns, so a failed fixture scan used to leave the server
 * listening and the file then never exited. The `after` hook closes those.
 */
const openServers = new Set<http.Server>();

function closeServer(server: http.Server): Promise<void> {
  openServers.delete(server);
  return new Promise<void>((r) => server.close(() => r()));
}

after(async () => {
  await Promise.all([...openServers].map(closeServer));
});

async function listen() {
  resetRateLimiter();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  openServers.add(server);
  return {
    port: (server.address() as { port: number }).port,
    close: () => closeServer(server),
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

/**
 * Run a scan over `root` and wait for it to complete.
 *
 * The wait reads the scan record in this process (peekScan, which does not
 * count as a use of the scan) instead of polling `GET /api/scan/:id/stats`.
 * The old loop polled that route every 25 ms while it sat in the rate
 * limiter's strict "api" lane (20 burst, then 10/s), so a slow scan drained
 * the bucket, the 429 bodies carried no `status`, and after 400 polls the loop
 * fell through with the scan still running and nothing asserted. The provider
 * answers a running scan with an unavailable batch and no values, so with
 * every core busy seven tests here failed on `available: false` or a missing
 * value — never on the arithmetic. The wait now spends no rate-limit tokens:
 * each test's own requests (one scan POST, or the settings test's three PUTs)
 * fit the bucket that listen() resets.
 */
async function scanned(port: number, root: string): Promise<string> {
  const started = await req(port, 'POST', '/api/scan', { path: root });
  assert.equal(started.status, 202, `scan refused: ${JSON.stringify(started.body)}`);
  const scanId = started.body.scanId as string;
  // A hang guard, not a measurement: with every core busy these scans were
  // still running after the old loop's ~10 s of polling.
  await waitFor(() => peekScan(scanId)?.status !== 'running', `the fixture scan of ${root} settling`);
  const scan = peekScan(scanId);
  assert.equal(
    scan?.status,
    'complete',
    `fixture scan failed: ${scan ? `it is ${scan.status}, not complete: ${scan.error ?? 'no error recorded'}` : 'the scan record is gone'}`,
  );
  return scanId;
}

/**
 * A fixture whose media mix is fully known, and a completed scan over it.
 *
 * Every byte count is chosen so the true averages are exact integers, which
 * keeps the expected values below free of float-tolerance fudging. Media
 * files are at least the per-item floors (a photo 100 KB, a video or a song
 * 1 MB — B10), and are written sparse, so their sizes cost no disk:
 *
 *  photos20/   20 photos sized 100000+1000i       → 2,190,000 bytes, average 109,500
 *  mixed/      20 photos sized 200000+10000i      → 5,900,000 bytes, average 295,000
 *  mixed/clips 15 videos sized 1000000+100000i    → 25,500,000 bytes, average 1,700,000
 *  few9/       9 photos (below the count floor)   → no comparable kind
 *  nomedia/    txt + bin + extensionless          → no comparable kind
 *  zeromusic/  12 empty .mp3 files                → 12 files, none a song
 *  capped30/   30 photos of exactly 100,000       → for the walk-cap test
 *  icons/      56 PNG icons of 1,600 bytes        → no photos at all (B10)
 *  album/      12 photos of 2,000,000 + 40 icons  → the photos, not the icons (B10)
 *  sounds/     12 alert sounds of 50,000 (.aiff)  → no music (B10)
 */
/** A file of `bytes` that occupies no blocks where the file system allows it. */
function sized(file: string, bytes: number): void {
  fs.writeFileSync(file, '');
  fs.truncateSync(file, bytes);
}

async function scannedMediaFixture(port: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-humanscale-fixture-'));

  const photos20 = path.join(root, 'photos20');
  fs.mkdirSync(photos20);
  for (let i = 0; i < 20; i++) {
    // One deliberately UPPERCASE name: the scanner lowercases extensions, so
    // this file must still land in the photo bucket or sampleCount reads 19.
    const name = i === 0 ? 'IMG_0000.JPG' : `img_${i}.${i % 2 === 0 ? 'jpg' : 'png'}`;
    sized(path.join(photos20, name), 100_000 + 1000 * i);
  }

  const mixed = path.join(root, 'mixed');
  const clips = path.join(mixed, 'clips');
  fs.mkdirSync(mixed);
  fs.mkdirSync(clips);
  for (let i = 0; i < 20; i++) {
    const ext = i % 3 === 0 ? 'heic' : i % 3 === 1 ? 'jpg' : 'webp';
    sized(path.join(mixed, `img_${i}.${ext}`), 200_000 + 10_000 * i);
  }
  // Videos live one level down, so this folder also proves the walk descends
  // into subdirectories rather than reading direct children only.
  for (let i = 0; i < 15; i++) {
    sized(path.join(clips, `clip_${i}.${i % 2 === 0 ? 'mp4' : 'mov'}`), 1_000_000 + 100_000 * i);
  }

  const few9 = path.join(root, 'few9');
  fs.mkdirSync(few9);
  for (let i = 0; i < 9; i++) {
    sized(path.join(few9, `photo_${i}.png`), 200_000 + i);
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
    sized(path.join(capped30, `same_${i}.jpg`), 100_000);
  }

  // B10: an app's icon PNGs are not photos. 56 of them averaging 1.6 KB made
  // 2.6 GB of SDKs "≈ 1,701,034 photos like the ones here".
  const icons = path.join(root, 'icons');
  fs.mkdirSync(icons);
  for (let i = 0; i < 56; i++) sized(path.join(icons, `icon_${i}.png`), 1600);

  const album = path.join(root, 'album');
  fs.mkdirSync(album);
  for (let i = 0; i < 12; i++) sized(path.join(album, `IMG_${i}.heic`), 2_000_000);
  for (let i = 0; i < 40; i++) sized(path.join(album, `thumb_${i}.png`), 1600);

  const sounds = path.join(root, 'sounds');
  fs.mkdirSync(sounds);
  for (let i = 0; i < 12; i++) sized(path.join(sounds, `alert_${i}.aiff`), 50_000);

  // The video and music floors from the side the folders above leave open:
  // a 300 KB clip is under the video floor, and a 1 MB song is at the music
  // floor, so it counts.
  const shortclips = path.join(root, 'shortclips');
  fs.mkdirSync(shortclips);
  for (let i = 0; i < 12; i++) sized(path.join(shortclips, `loop_${i}.mp4`), 300_000);

  const songs = path.join(root, 'songs');
  fs.mkdirSync(songs);
  for (let i = 0; i < 12; i++) sized(path.join(songs, `track_${i}.mp3`), 1_000_000);

  let scanId: string;
  try {
    scanId = await scanned(port, root);
  } catch (err) {
    // The caller's `finally` only exists once this returns, so a failed scan
    // would otherwise leave the fixture on disk.
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
  return {
    root,
    scanId,
    photos20,
    mixed,
    few9,
    nomedia,
    zeromusic,
    capped30,
    icons,
    album,
    sounds,
    shortclips,
    songs,
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
    // Sum of 100000+1000i for i in 0..19 is 2,190,000; the average over 20
    // files is exactly 109,500, and the folder holds nothing else — so a
    // folder made only of photos is equivalent to its own photo count.
    assert.deepEqual(v, {
      bytes: 2190000,
      equivalents: [{ kind: 'photos', sampleCount: 20, avgBytes: 109500, equivalentCount: 20 }],
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

    // The folder totals 5,900,000 (photos) + 25,500,000 (videos in clips/) =
    // 31,400,000 bytes. Each kind divides that same total by its OWN average:
    // photos 31,400,000 / 295,000 = 106.44 → 106; videos 31,400,000 /
    // 1,700,000 = 18.47 → 18. If either kind borrowed the other's average —
    // or any constant — neither literal would match.
    assert.deepEqual(v, {
      bytes: 31400000,
      equivalents: [
        { kind: 'photos', sampleCount: 20, avgBytes: 295000, equivalentCount: 106 },
        { kind: 'videos', sampleCount: 15, avgBytes: 1700000, equivalentCount: 18 },
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

    // Twelve zero-byte mp3 files are twelve files but no song: each is under
    // the per-item floor, so the kind is omitted the same way an under-sampled
    // one is — and an average of 0 bytes is never divided by.
    const zeromusic = out.humanScale.values[fixture.zeromusic] as HumanScaleFact;
    assert.deepEqual(zeromusic, { bytes: 0, equivalents: [] });
  } finally {
    fixture.cleanup();
    await close();
  }
});

/* ------------------- B10: an icon is not a photo, nor an alert a song ------------------- */

test('icons, thumbnails and alert sounds are not the photos and songs a folder is compared to (B10)', async () => {
  const { port, close } = await listen();
  const fixture = await scannedMediaFixture(port);
  try {
    clearFactCache();
    const out = await computeFacts(fixture.scanId, [fixture.icons, fixture.album, fixture.sounds], ['humanScale'], fresh());
    const icons = out.humanScale.values[fixture.icons] as HumanScaleFact;
    assert.deepEqual(icons, { bytes: 56 * 1600, equivalents: [] },
      '56 icon PNGs averaging 1.6 KB are no basis for "photos like the ones here"');

    // The album's twelve photos are the basis; its forty thumbnails are not in
    // the sample (they would drag the average to 1/3 of a photo), but they are
    // still part of the folder's size, which is the figure translated.
    const album = out.humanScale.values[fixture.album] as HumanScaleFact;
    assert.deepEqual(album, {
      bytes: 12 * 2_000_000 + 40 * 1600,
      equivalents: [{ kind: 'photos', sampleCount: 12, avgBytes: 2_000_000, equivalentCount: 12 }],
    });

    const sounds = out.humanScale.values[fixture.sounds] as HumanScaleFact;
    assert.deepEqual(sounds.equivalents, [], 'twelve 50 KB alert sounds are not songs');
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('the video and music floors hold from both sides: a 300 KB clip is not a video, a 1 MB song is a song (B10 review)', async () => {
  const { port, close } = await listen();
  const fixture = await scannedMediaFixture(port);
  try {
    clearFactCache();
    const out = await computeFacts(fixture.scanId, [fixture.shortclips, fixture.songs], ['humanScale'], fresh());
    const shortclips = out.humanScale.values[fixture.shortclips] as HumanScaleFact;
    assert.deepEqual(shortclips, { bytes: 12 * 300_000, equivalents: [] },
      'twelve 300 KB clips are under the 1 MB video floor: no "videos like the ones here"');
    const songs = out.humanScale.values[fixture.songs] as HumanScaleFact;
    assert.deepEqual(songs, {
      bytes: 12 * 1_000_000,
      equivalents: [{ kind: 'music', sampleCount: 12, avgBytes: 1_000_000, equivalentCount: 12 }],
    }, 'twelve 1 MB songs sit at the music floor and are the sample');
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
  // is exactly 100,000 bytes, so the average is 100,000 no matter which
  // eleven the traversal reached — the assertion cannot flake on child order.
  const restore = setHumanScaleWalkCapForTests(12);
  try {
    clearFactCache();
    const out = await computeFacts(fixture.scanId, [fixture.capped30], ['humanScale'], fresh());
    const v = out.humanScale.values[fixture.capped30] as HumanScaleFact;
    assert.deepEqual(v, {
      bytes: 3000000,
      capped: true,
      // 11 samples still clear MIN_COMPARABLE, and the folder's full 3,000,000
      // bytes divided by the sampled average of 100,000 says "about 30
      // photos" — the UI's basis line can state the truncated sample honestly.
      equivalents: [{ kind: 'photos', sampleCount: 11, avgBytes: 100000, equivalentCount: 30 }],
    });

    // With the cap restored the same folder answers in full, and the capped
    // marker disappears entirely rather than lingering as `capped: false`.
    restore();
    clearFactCache();
    const full = await computeFacts(fixture.scanId, [fixture.capped30], ['humanScale'], fresh());
    const fv = full.humanScale.values[fixture.capped30] as HumanScaleFact;
    assert.deepEqual(fv, {
      bytes: 3000000,
      equivalents: [{ kind: 'photos', sampleCount: 30, avgBytes: 100000, equivalentCount: 30 }],
    });
    assert.equal(Object.prototype.hasOwnProperty.call(fv, 'capped'), false);
  } finally {
    restore();
    fixture.cleanup();
    await close();
  }
});

/* ═══════════ The Settings toggle + tooltip wiring (parent session) ═══════════ */

import { readFileSync } from 'node:fs';
import { getSettings, updateSettings } from '../src/services/settings';

test('humanScaleUnits defaults on, turns off explicitly, and survives a round trip', async () => {
  const initial = await getSettings();
  assert.equal(initial.humanScaleUnits, true, 'default on (§9.3)');
  const off = await updateSettings({ humanScaleUnits: false });
  assert.equal(off.humanScaleUnits, false);
  const untouched = await updateSettings({ forecastThresholdDays: 30 });
  assert.equal(untouched.humanScaleUnits, false, 'an unrelated save keeps the choice');
  const on = await updateSettings({ humanScaleUnits: true });
  assert.equal(on.humanScaleUnits, true);
});

test('the tooltip line shows nothing without comparables, and always carries its basis', () => {
  const html = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const start = html.indexOf('function humanScaleTooltipLine');
  assert.notEqual(start, -1, 'the tooltip line exists');
  const fn = html.slice(start, html.indexOf('\n}', start));
  assert.match(fn, /!fact\.equivalents\.length\) return ''/, 'no comparables → no line, never a generic average');
  assert.match(fn, /based on the/, 'the basis is stated inline (§9.3: "shown with its basis")');
  assert.match(fn, /humanScaleOn/, 'the Settings toggle gates it');
  assert.ok(html.includes('id="humanScaleToggle"'), 'the toggle exists in Settings');
  // The resolver must never fire for files, small folders, or foreign scans.
  const resolver = html.slice(html.indexOf('function resolveHumanScale'), html.indexOf('function humanScaleTooltipLine'));
  assert.match(resolver, /node\.type !== 'dir'/, 'directories only');
  assert.match(resolver, /HS_MIN_BYTES/, 'only over the ~1 GB floor');
  assert.match(resolver, /treeScan\(\) !== scanAtRequest\) return/, 'a stale answer cannot cross scans');
});

test('review F2.2: while a rescan runs over an older scan\'s tree, the tooltip\'s equivalents are asked of the scan that tree came from — never the running scan, which answers "unavailable" — and an answer landing after the rescan landed is not kept for the new tree', async () => {
  const html = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const start = html.indexOf('function resolveHumanScale(');
  assert.notEqual(start, -1, 'the resolver is in the page');
  let end = -1;
  for (let i = html.indexOf('{', html.indexOf(')', start)), depth = 0; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  // The app's one rule for the scan behind the tree on screen (treeScanId), lifted with it.
  const ruleAt = html.indexOf('function treeScanId(');
  assert.notEqual(ruleAt, -1, 'the rule is in the page');
  const rule = html.slice(ruleAt, html.indexOf('\n}', ruleAt) + 2);
  const asks: Array<{ scanId: string; paths: string[]; answer: (res: unknown) => void }> = [];
  const state: Record<string, unknown> = { scanning: true, settledScanId: 'A', scanId: 'B' }; // followScanProgress set B; the tree on screen is A's
  const hsFacts = new Map<string, unknown>();
  const deps: Record<string, unknown> = {
    state, hsFacts, hsPending: new Set<string>(), humanScaleOn: true, HS_MIN_BYTES: 1e9, showTooltip: () => {},
    $: () => ({ style: { display: 'none' }, dataset: {} }),
    api: (_url: string, init: { body: string }) => new Promise((answer) => {
      const b = JSON.parse(init.body) as { scanId: string; paths: string[] };
      asks.push({ scanId: b.scanId, paths: b.paths, answer });
    }),
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const resolve = new Function(...keys, `${rule}\n${html.slice(start, end)}\nreturn resolveHumanScale;`)(...keys.map((k) => deps[k])) as (n: unknown) => void;
  const settle = () => new Promise((r) => setImmediate(r));
  const fact = { equivalents: [{ kind: 'photos', equivalentCount: 3100, sampleCount: 56, avgBytes: 4_000_000 }] };
  const answerFor = (p: string) => ({ providers: { humanScale: { available: true, values: { [p]: fact } } } });

  resolve({ path: '/r/big', type: 'dir', size: 2e9 });
  assert.deepEqual(asks.map((a) => a.scanId), ['A'], 'asked of the scan the tree on screen came from');
  asks[0].answer(answerFor('/r/big'));
  await settle();
  assert.deepEqual(hsFacts.get('/r/big'), fact, 'and kept as it lands, while the rescan still runs');

  resolve({ path: '/r/other', type: 'dir', size: 2e9 });
  assert.deepEqual(asks.map((a) => a.scanId), ['A', 'A'], 'control: asked of A too');
  Object.assign(state, { scanning: false, scanId: 'B', settledScanId: 'B' }); // the rescan lands before the answer
  asks[1].answer(answerFor('/r/other'));
  await settle();
  assert.equal(hsFacts.has('/r/other'), false, 'A\'s answer is not kept for B\'s tree');

  // The saved index's tree on screen, its scan running: no scan stands behind the tree, so nothing is asked.
  Object.assign(state, { scanning: true, settledScanId: null, scanId: 'C' });
  resolve({ path: '/r/indexed', type: 'dir', size: 2e9 });
  assert.equal(asks.length, 2, 'a saved index\'s tree is asked nothing — not of the running scan, not of no scan');
});

test('the human-scale sentence wraps between words — only the path line may break inside one (B10)', () => {
  const html = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const rule = (selector: string): string => {
    const at = html.indexOf(`${selector} {`);
    assert.notEqual(at, -1, `${selector} has a rule`);
    return html.slice(at, html.indexOf('}', at));
  };
  // "based on the 56 pho / tos in this folder": break-all, meant for paths,
  // also applied to every sentence in the tooltip.
  assert.doesNotMatch(rule('#tooltip .t-line'), /break-all/, 'a tooltip sentence is not broken mid-word');
  assert.match(rule('#tooltip .t-line'), /overflow-wrap: anywhere/, 'though a token wider than the tooltip still wraps');
  assert.match(rule('#tooltip .t-path'), /word-break: break-all/, 'the path line keeps breaking anywhere');
  const show = html.slice(html.indexOf('function showTooltip'), html.indexOf('function resolveScore'));
  assert.match(show, /<div class="t-line t-path">\$\{escapeHtml\(node\.path\)\}<\/div>/, 'and the path line is the one that carries it');
});

test('one request cannot walk forever: the batch budget skips the tail honestly', async () => {
  // 2,000 deep directories in one request could visit billions of nodes with
  // only a per-path cap — a synchronous walk that would block the event loop
  // for seconds. The batch budget bounds the whole request; paths past it
  // are SKIPPED (absent from values, counted in stats), never zeroed.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-humanscale-batch-'));
  const dirs: string[] = [];
  for (let d = 0; d < 6; d++) {
    const dir = path.join(root, `bucket_${d}`);
    fs.mkdirSync(dir);
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(dir, `p_${i}.jpg`), Buffer.alloc(1000));
    }
    dirs.push(dir);
  }
  const { port, close } = await listen();
  try {
    const scanId = await scanned(port, root);
    // Per-path cap huge, batch budget 30: each bucket costs 13 visits
    // (itself + 12 files), so roughly two buckets fit and the rest must not.
    const restore = setHumanScaleWalkCapForTests(1_000_000, 30);
    try {
      const controller = new AbortController();
      const out = await computeFacts(scanId, dirs, ['humanScale'], controller.signal);
      const r = out.humanScale;
      assert.equal(r.available, true);
      const answered = Object.keys(r.values).length;
      assert.ok(answered >= 1, 'the budget covers at least the first path');
      assert.ok(answered < dirs.length, `and runs out before the batch ends (answered ${answered} of ${dirs.length})`);
      assert.equal(r.stats.requested, dirs.length);
      assert.equal(r.stats.computed + r.stats.skipped + r.stats.failed, r.stats.requested,
        'coverage arithmetic still holds under the budget');
      for (const d of dirs.slice(0, answered)) {
        assert.ok((r.values as any)[d], 'answered paths carry real values');
      }
    } finally {
      restore();
      clearFactCache(scanId);
    }
  } finally {
    await close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the settings route refuses a non-boolean humanScaleUnits instead of coercing it on', async () => {
  // Review finding 10: "anything but explicit false means on" is written for
  // hand-edited FILES; API input is validated like every other field.
  const { port, close } = await listen();
  try {
    const bad = await req(port, 'PUT', '/api/settings', { humanScaleUnits: 'off' });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    const good = await req(port, 'PUT', '/api/settings', { humanScaleUnits: false });
    assert.equal(good.status, 200);
    assert.equal(good.body.humanScaleUnits, false);
    await req(port, 'PUT', '/api/settings', { humanScaleUnits: true });
  } finally {
    await close();
  }
});
