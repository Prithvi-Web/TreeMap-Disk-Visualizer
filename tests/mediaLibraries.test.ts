import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanMediaLibraries, guardMediaReport, MediaReport } from '../src/services/mediaLibraryScanner';
import { platform } from '../src/platform';

/**
 * §8.1 — media-library awareness.
 *
 * These build REAL bundle layouts on disk and scan them through the same
 * FileNode walker the game-library tests use, so detection is exercised
 * against the documented directory structures rather than a hand-drawn tree.
 *
 * The safety invariants pinned here are the feature:
 *   - originals NEVER carry a removable flag — the file IS the data;
 *   - a layout the scanner does not recognise reports its total size only
 *     and offers nothing;
 *   - when the owning app holds the library, offers are withdrawn and the
 *     report says who; when the probe cannot check, it says that, never
 *     "not running".
 */

const roots: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-media-'));
  roots.push(dir);
  return dir;
}
function bytes(file: string, n: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(n, 7));
}

/** Walk a real directory into the FileNode shape the scanner consumes. */
function treeOf(dir: string): import('../src/models/types').FileNode {
  const st = fs.statSync(dir);
  const children = fs.readdirSync(dir).map((name) => {
    const full = path.join(dir, name);
    const s = fs.statSync(full);
    if (s.isDirectory()) return treeOf(full);
    return {
      name, path: full, size: s.size, type: 'file' as const,
      modifiedAt: s.mtimeMs, isHidden: name.startsWith('.'),
      extension: (name.split('.').pop() || '').toLowerCase(),
    };
  });
  return {
    name: path.basename(dir), path: dir, type: 'dir', modifiedAt: st.mtimeMs, isHidden: false,
    size: children.reduce((s, c) => s + c.size, 0), children,
  };
}

process.on('exit', () => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function byKind(lib: { components: { kind: string; bytes: number }[] }): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of lib.components) out[c.kind] = (out[c.kind] ?? 0) + c.bytes;
  return out;
}

/* ─────────────────────── Photos ─────────────────────── */

function photosFixture(root: string): string {
  const lib = path.join(root, 'Pictures', 'Photos Library.photoslibrary');
  bytes(path.join(lib, 'originals', '0', 'IMG_0001.heic'), 50_000);
  bytes(path.join(lib, 'resources', 'derivatives', '0', 'thumb.jpg'), 7_000);
  bytes(path.join(lib, 'database', 'Photos.sqlite'), 3_000);
  bytes(path.join(lib, 'private', 'misc.plist'), 500); // real but unclassified
  return lib;
}

test('a modern Photos library splits into originals, derivatives and database', () => {
  const root = tmp();
  const libPath = photosFixture(root);
  const report = scanMediaLibraries(treeOf(root));

  assert.equal(report.libraries.length, 1);
  const lib = report.libraries[0];
  assert.equal(lib.app, 'photos');
  assert.equal(lib.path, libPath);
  assert.equal(lib.recognised, true);
  assert.equal(lib.totalBytes, 60_500, 'the whole bundle, unclassified parts included');
  assert.equal(lib.originalsBytes, 50_000);
  assert.equal(lib.derivativesBytes, 7_000);
  assert.equal(lib.databaseBytes, 3_000);
  const kinds = byKind(lib);
  assert.equal(kinds.originals, 50_000);
  assert.equal(kinds.derivatives, 7_000);
  assert.equal(kinds.database, 3_000);
  assert.equal(report.libraryCount, 1);
  assert.equal(report.recognisedCount, 1);
  assert.equal(report.derivativesBytes, 7_000);
});

test('Photos derivatives are removable with the regeneration cost stated as prose', () => {
  const root = tmp();
  photosFixture(root);
  const lib = scanMediaLibraries(treeOf(root)).libraries[0];
  const derivative = lib.components.find((c) => c.kind === 'derivatives');
  assert.ok(derivative);
  assert.equal(derivative.removable, true);
  assert.ok(derivative.regenerationCost, 'the cost of regenerating is stated');
  assert.match(derivative.regenerationCost, /slow first launch/i);
});

test('an older Photos layout (Masters, renders, proxies) is still recognised', () => {
  const root = tmp();
  const lib = path.join(root, 'Old Library.photoslibrary');
  bytes(path.join(lib, 'Masters', '2016', 'IMG.jpg'), 30_000);
  bytes(path.join(lib, 'resources', 'renders', 'r.jpg'), 4_000);
  bytes(path.join(lib, 'resources', 'proxies', 'p.jpg'), 2_000);
  bytes(path.join(lib, 'database', 'photos.db'), 1_000);
  const found = scanMediaLibraries(treeOf(root)).libraries[0];
  assert.equal(found.recognised, true);
  assert.equal(found.originalsBytes, 30_000);
  assert.equal(found.derivativesBytes, 6_000, 'renders and proxies are both derivatives');
  assert.equal(found.databaseBytes, 1_000);
});

test('an unrecognised Photos layout reports its total size only and offers nothing', () => {
  const root = tmp();
  const lib = path.join(root, 'Strange.photoslibrary');
  bytes(path.join(lib, 'Contents', 'Info.plist'), 9_000);
  const report = scanMediaLibraries(treeOf(root));
  assert.equal(report.libraries.length, 1, 'an unparseable library is unrecognised, never invisible');
  const found = report.libraries[0];
  assert.equal(found.recognised, false);
  assert.equal(found.totalBytes, 9_000, 'an unknown is never a zero');
  assert.ok(found.reason, 'why it could not be parsed');
  assert.match(found.reason, /layout/i);
  assert.deepEqual(found.components, [], 'nothing classified means nothing offered');
  assert.equal(report.recognisedCount, 0);
});

/* ─────────────────────── Final Cut Pro & iMovie ─────────────────────── */

function fcpFixture(root: string): string {
  const lib = path.join(root, 'Movies', 'My Library.fcpbundle');
  bytes(path.join(lib, 'CurrentVersion.flexolibrary', 'db'), 2_000);
  bytes(path.join(lib, 'My Event', 'Original Media', 'clip.mov'), 80_000);
  bytes(path.join(lib, 'My Event', 'Render Files', 'High Quality Media', 'r.mov'), 20_000);
  bytes(path.join(lib, 'My Event', 'Transcoded Media', 'proxy.mov'), 10_000);
  bytes(path.join(lib, 'Settings.plist'), 100);
  return lib;
}

test('a Final Cut bundle splits per event into originals, renders, proxies and database', () => {
  const root = tmp();
  const libPath = fcpFixture(root);
  const lib = scanMediaLibraries(treeOf(root)).libraries[0];
  assert.equal(lib.app, 'finalcut');
  assert.equal(lib.path, libPath);
  assert.equal(lib.recognised, true);
  assert.equal(lib.originalsBytes, 80_000);
  assert.equal(lib.derivativesBytes, 30_000, 'Render Files and Transcoded Media');
  assert.equal(lib.databaseBytes, 2_000);
  const derivatives = lib.components.filter((c) => c.kind === 'derivatives');
  assert.equal(derivatives.length, 2, 'renders and proxies are reported separately');
  for (const d of derivatives) {
    assert.equal(d.removable, true);
    assert.ok(d.regenerationCost);
  }
  const renders = derivatives.find((c) => /render/i.test(c.label));
  assert.ok(renders);
  assert.match(renders.regenerationCost ?? '', /re-render/i);
});

test('an iMovie library is the same family as Final Cut', () => {
  const root = tmp();
  const lib = path.join(root, 'Movies', 'iMovie Library.imovielibrary');
  bytes(path.join(lib, 'CurrentVersion.imovielibrary'), 1_000);
  bytes(path.join(lib, 'Holiday', 'Original Media', 'clip.mov'), 40_000);
  bytes(path.join(lib, 'Holiday', 'Render Files', 'r.mov'), 5_000);
  const found = scanMediaLibraries(treeOf(root)).libraries[0];
  assert.equal(found.app, 'imovie');
  assert.equal(found.recognised, true);
  assert.equal(found.originalsBytes, 40_000);
  assert.equal(found.derivativesBytes, 5_000);
  assert.equal(found.databaseBytes, 1_000);
});

test('a .fcpbundle with none of the documented markers is size-only', () => {
  const root = tmp();
  bytes(path.join(root, 'Odd.fcpbundle', 'whatever', 'x.bin'), 3_000);
  const found = scanMediaLibraries(treeOf(root)).libraries[0];
  assert.equal(found.recognised, false);
  assert.equal(found.totalBytes, 3_000);
  assert.deepEqual(found.components, []);
});

/* ─────────────────────── Lightroom ─────────────────────── */

function lightroomFixture(root: string): { catalog: string; folder: string } {
  const folder = path.join(root, 'Lightroom');
  const catalog = path.join(folder, 'Wedding.lrcat');
  bytes(catalog, 5_000);
  bytes(path.join(folder, 'Wedding Previews.lrdata', 'previews.db'), 12_000);
  bytes(path.join(folder, 'Wedding Smart Previews.lrdata', 's.dng'), 8_000);
  bytes(path.join(folder, 'Other Previews.lrdata', 'x.db'), 1_000); // another catalog's
  bytes(path.join(folder, '2024 Photos', 'raw1.arw'), 100_000); // the user's originals
  return { catalog, folder };
}

test('a Lightroom catalog claims its previews and database — and NEVER the photos', () => {
  const root = tmp();
  const { catalog } = lightroomFixture(root);
  const report = scanMediaLibraries(treeOf(root));
  const lib = report.libraries.find((l) => l.app === 'lightroom' && l.path === catalog);
  assert.ok(lib);
  assert.equal(lib.recognised, true);
  assert.equal(lib.originalsOutside, true, 'originals live outside the catalog');
  assert.equal(lib.originalsBytes, 0, 'no original is ever claimed');
  assert.equal(lib.components.find((c) => c.kind === 'originals'), undefined);
  assert.equal(lib.databaseBytes, 5_000, 'the .lrcat is the database');
  assert.equal(lib.derivativesBytes, 20_000, 'its own Previews and Smart Previews only');
  assert.equal(lib.totalBytes, 25_000, "the user's photo folders are not counted into the library");
  const smart = lib.components.find((c) => /smart/i.test(c.label));
  assert.ok(smart);
  assert.equal(smart.removable, true);
  assert.match(smart.regenerationCost ?? '', /build smart previews/i);
});

test("another catalog's .lrdata is not claimed by name proximity", () => {
  const root = tmp();
  lightroomFixture(root);
  const libs = scanMediaLibraries(treeOf(root)).libraries.filter((l) => l.app === 'lightroom');
  assert.equal(libs.length, 1, 'Other Previews.lrdata has no Other.lrcat beside it');
  const claimed = libs[0].components.map((c) => path.basename(c.path));
  assert.ok(!claimed.includes('Other Previews.lrdata'));
});

/* ─────────────────────── Capture One ─────────────────────── */

test('a Capture One catalog splits into originals, cache and database', () => {
  const root = tmp();
  const lib = path.join(root, 'Capture One Catalog.cocatalog');
  bytes(path.join(lib, 'Capture One Catalog.cocatalogdb'), 4_000);
  bytes(path.join(lib, 'Originals', '2024', 'raw.arw'), 60_000);
  bytes(path.join(lib, 'Cache', 'Proxies', 'p.cop'), 9_000);
  bytes(path.join(lib, 'Cache', 'Thumbnails', 't.cot'), 1_000);
  const found = scanMediaLibraries(treeOf(root)).libraries[0];
  assert.equal(found.app, 'captureone');
  assert.equal(found.recognised, true);
  assert.equal(found.originalsBytes, 60_000, 'managed originals inside the catalog');
  assert.equal(found.derivativesBytes, 10_000, 'the whole Cache is derivative');
  assert.equal(found.databaseBytes, 4_000);
  const cache = found.components.find((c) => c.kind === 'derivatives');
  assert.ok(cache);
  assert.equal(cache.removable, true);
});

test('a .cocatalog without its database file is size-only', () => {
  const root = tmp();
  bytes(path.join(root, 'Mystery.cocatalog', 'Stuff', 'x.bin'), 2_000);
  const found = scanMediaLibraries(treeOf(root)).libraries[0];
  assert.equal(found.recognised, false);
  assert.deepEqual(found.components, []);
});

/* ─────────────────────── The safety invariant ─────────────────────── */

test('originals and databases NEVER carry a removable flag — only derivatives may', () => {
  // The Games reasoning: the file IS the data. Asserted across every layout at
  // once so a new library type cannot ship without inheriting the invariant.
  const root = tmp();
  photosFixture(root);
  fcpFixture(root);
  lightroomFixture(root);
  bytes(path.join(root, 'C1.cocatalog', 'C1.cocatalogdb'), 1_000);
  bytes(path.join(root, 'C1.cocatalog', 'Originals', 'a.arw'), 2_000);
  bytes(path.join(root, 'C1.cocatalog', 'Cache', 'Thumbnails', 't.cot'), 500);

  const report = scanMediaLibraries(treeOf(root));
  assert.ok(report.libraries.length >= 4);
  for (const lib of report.libraries) {
    for (const c of lib.components) {
      if (c.kind === 'derivatives') {
        if (c.removable) assert.ok(c.regenerationCost, `${c.path} is offered without stating its cost`);
      } else {
        assert.ok(!('removable' in c), `${c.path} (${c.kind}) must never carry a removable flag`);
        assert.ok(!('regenerationCost' in c), `${c.path} (${c.kind}) is not regenerable — the file IS the data`);
      }
    }
  }
});

test('libraries are ordered largest first', () => {
  const root = tmp();
  photosFixture(root); // 60_500
  fcpFixture(root); // 112_100
  const report = scanMediaLibraries(treeOf(root));
  const sizes = report.libraries.map((l) => l.totalBytes);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
  assert.equal(report.libraries[0].app, 'finalcut');
});

test('a folder with no media libraries reports nothing', () => {
  const root = tmp();
  bytes(path.join(root, 'documents', 'notes.txt'), 100);
  const report = scanMediaLibraries(treeOf(root));
  assert.deepEqual(report.libraries, []);
  assert.equal(report.totalBytes, 0);
  assert.equal(report.derivativesBytes, 0);
});

/* ─────────────────────── The running-app guard ─────────────────────── */

type Provider = { getOpenHandlesBatch: (paths: string[]) => Promise<{ handles: unknown[]; complete: boolean }> };

test('a library the owning app holds open says so and offers nothing', async () => {
  const root = tmp();
  photosFixture(root);
  lightroomFixture(root);
  const report = scanMediaLibraries(treeOf(root));

  const provider = platform() as unknown as Provider;
  const original = provider.getOpenHandlesBatch.bind(provider);
  provider.getOpenHandlesBatch = (paths: string[]) => {
    const held = paths.find((p) => p.includes('.photoslibrary'));
    assert.ok(held, 'the probe covers the library paths');
    return Promise.resolve({
      handles: [{ path: held, pid: process.pid + 1, processName: 'Photos', openPath: path.join(held, 'database', 'Photos.sqlite') }],
      complete: true,
    });
  };
  let guarded: MediaReport;
  try {
    guarded = await guardMediaReport(report);
  } finally {
    provider.getOpenHandlesBatch = original;
  }

  const photos = guarded.libraries.find((l) => l.app === 'photos');
  assert.ok(photos?.inUse);
  assert.equal(photos.inUse.checked, true);
  assert.equal(photos.inUse.held, true);
  assert.deepEqual(photos.inUse.processNames, ['Photos']);
  assert.match(photos.inUse.reason ?? '', /open right now/i);
  for (const c of photos.components) {
    assert.ok(!('removable' in c), 'every offer is withdrawn while the app holds the library');
  }

  // A library nothing holds keeps its offers.
  const lightroom = guarded.libraries.find((l) => l.app === 'lightroom');
  assert.ok(lightroom?.inUse);
  assert.equal(lightroom.inUse.held, false);
  assert.ok(lightroom.components.some((c) => c.removable === true));
});

test('a probe that cannot check reports that honestly, never as "not running"', async () => {
  const root = tmp();
  photosFixture(root);
  const report = scanMediaLibraries(treeOf(root));

  const provider = platform() as unknown as Provider;
  const original = provider.getOpenHandlesBatch.bind(provider);
  provider.getOpenHandlesBatch = () => Promise.reject(new Error('probe exploded'));
  let guarded: MediaReport;
  try {
    guarded = await guardMediaReport(report);
  } finally {
    provider.getOpenHandlesBatch = original;
  }

  const photos = guarded.libraries[0];
  assert.ok(photos.inUse);
  assert.equal(photos.inUse.checked, false);
  assert.ok(!('held' in photos.inUse), 'an unchecked library must not read as "not running"');
  assert.ok(photos.inUse.reason, 'the reason the check could not run');
  // The offer stands — refusing every clear because the probe is broken would
  // be worse, and the delete path re-checks at delete time anyway.
  assert.ok(photos.components.some((c) => c.removable === true));
});

/* ── the review's RD-1: a bundle the scan could not read INTO ── */

test('a bundle whose contents could not be listed is unrecognised, never invisible', () => {
  // On macOS without Full Disk Access, TCC denies readdir inside
  // ~/Pictures/Photos Library.photoslibrary — the walker returns the bundle
  // as a childless dir (diskScanner counts it in deniedDirs). That is the
  // most common consumer setup, and the report must show the library at its
  // size and offer nothing — not pretend no library exists.
  const root = tmp();
  const denied: import('../src/models/types').FileNode = {
    name: 'Photos Library.photoslibrary',
    path: path.join(root, 'Photos Library.photoslibrary'),
    type: 'dir', modifiedAt: Date.now(), isHidden: false,
    size: 123_456_789, // the walker still knows the size from the parent stat pass
    children: [],
  };
  const tree: import('../src/models/types').FileNode = {
    name: path.basename(root), path: root, type: 'dir', modifiedAt: Date.now(), isHidden: false,
    size: denied.size, children: [denied],
  };
  const report = scanMediaLibraries(tree);
  assert.equal(report.libraries.length, 1, 'the unreadable library is reported, not omitted');
  const lib = report.libraries[0];
  assert.equal(lib.recognised, false);
  assert.equal(lib.totalBytes, 123_456_789, 'shown at its size');
  assert.deepEqual(lib.components, [], 'nothing is offered');
  assert.match(lib.reason ?? '', /could not be read|read into/i, 'and the reason says why');
});

test('the media rulepack entries defer to this surface — the two must tell one story', () => {
  // The review's RD-2: an agent reading /api/cleanup/suggestions (advisory:
  // never trash from there) and /api/media (derivatives removable) must not
  // hear a contradiction. The advisory entries exist to point at the gated
  // offer, and their prose says so.
  const packs = ['common.json', 'macos.json'].flatMap((f) => {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'rulepacks', f), 'utf8'));
    return (raw.rules ?? []).filter((r: { id?: string }) => (r.id ?? '').startsWith('media-'));
  });
  assert.ok(packs.length >= 4, 'the media entries exist');
  for (const r of packs) {
    assert.match(r.description, /Media Libraries view/, `${r.id} points at the gated offer`);
    assert.equal(r.action, 'advice', `${r.id} never lets Clean Up trash into a live bundle`);
  }
});

/* ── the review's H-1: the route itself, not just the service ── */
import http from 'node:http';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { createScanRecord } from '../src/services/diskScanner';

test('GET /api/media serves the report over a real scan — route wiring, not just the service', async () => {
  resetRateLimiter();
  const root = tmp();
  photosFixture(root);
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = treeOf(root);
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const get = (url: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
    }).on('error', reject);
  });
  try {
    const r = await get(`/api/media?scanId=${scan.scanId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.scanId, scan.scanId);
    assert.equal(r.body.libraries.length, 1);
    assert.equal(r.body.libraries[0].app, 'photos');
    assert.ok(r.body.libraries[0].inUse, 'the open-handle guard ran at the route level');
    assert.equal(typeof r.body.totalBytes, 'number');
    const bad = await get('/api/media?scanId=nope');
    assert.equal(bad.status, 404);
    assert.equal(bad.body.code, 'SCAN_NOT_FOUND');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
