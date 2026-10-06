import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-pathGuardBoundary-data-');
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp/server';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { insideAnyScanRoot, setDataVolumeFoldersForTests, setFirmlinksFileForTests } from '../src/middleware/pathGuard';
import { isInside, sanitizePath } from '../src/utils/pathSanitizer';
import { createScanRecord, evictExpiredScans, SCAN_TTL_MS, startScan } from '../src/services/diskScanner';
import { setTrashStepForTests } from '../src/services/cleaner';
import { updateSettings } from '../src/services/settings';
import { parseBsdMount } from '../src/platform/atime';
import { boundaryRecord, firmlinkAliases, neverDescendPaths, parseFirmlinks, scanBoundary, setBoundaryDepsForTests } from '../src/utils/mountBoundaries';
import { DIAGNOSIS_MAC_FIRMLINKS, DIAGNOSIS_MAC_MOUNT, IOS_22E238 } from './fixtures/mountTables';
import type { ScanResult } from '../src/models/types';
import { registerFactProvider, unregisterFactProvider } from '../src/services/facts';
import { unavailableBatch, type FactProvider } from '../src/services/facts/types';

/**
 * Track U, U-25: the scanned-root rule reads what the scan listed (U-D19).
 *
 * Scanning is what grants permission to act on a path, and a scan only ever
 * saw what it listed. A drive it did not enter ("Stay on this drive") and a
 * folder no walk descends into (/Volumes after a scan of /) were never
 * listed, so a path at or beneath one is outside that scan: 403
 * OUTSIDE_SCAN_ROOT, the code the rule has always answered — unless another
 * scan covers it. Every request here is a dry run, and the trash step is
 * stubbed to fail loudly, so nothing can be moved.
 */

const REPO = path.join(__dirname, '..');
const NO_TABLE = process.platform === 'win32' ? 'Windows keeps no mount table, so no scan there has a drive inside it to stop at' : null;

let port = 0;
let server: http.Server;
let client: Client;

before(async () => {
  setTrashStepForTests(async (p) => {
    throw new Error(`no test here may trash anything, and ${p} was asked for`);
  });
  resetRateLimiter();
  server = http.createServer(createApp(path.join(REPO, 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  const mcp = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'treemap-path-guard-boundary-test', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  setBoundaryDepsForTests(null);
  setTrashStepForTests(null);
  await client.close();
  await new Promise<void>((r) => server.close(() => r()));
});

function deleteDryRun(paths: string[]): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ paths, dryRun: true });
    const r = http.request(
      { host: '127.0.0.1', port, path: '/api/files', method: 'DELETE', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
      },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

interface Tree {
  root: string;
  mnt: string;
  onDrive: string;
  other: string;
  here: string;
}

/** root/{mnt/on-drive.txt, other/here.txt}, by its real path; the mount table names root/mnt. */
function tree(): Tree {
  const root = fs.realpathSync(fileTempDir('treemap-guard-boundary-'));
  const mnt = path.join(root, 'mnt');
  const other = path.join(root, 'other');
  fs.mkdirSync(mnt);
  fs.mkdirSync(other);
  const onDrive = path.join(mnt, 'on-drive.txt');
  const here = path.join(other, 'here.txt');
  fs.writeFileSync(onDrive, 'd'.repeat(300));
  fs.writeFileSync(here, 'h'.repeat(200));
  setBoundaryDepsForTests({
    readTable: async () => ({ source: 'mount', entries: [{ mountPoint: mnt, filesystem: 'apfs', options: ['apfs'], source: '/dev/disk99s1' }], reason: null }),
    aliases: async () => () => [],
  });
  return { root, mnt, onDrive, other, here };
}

async function scanned(root: string): Promise<ScanResult> {
  await updateSettings({ scanBoundary: 'stay', engine: 'walker' });
  const s = await startScan(root);
  await waitFor(() => s.status !== 'running', `the scan of ${root} settling`);
  assert.equal(s.status, 'complete', s.error);
  return s;
}

test('after a scan that did not enter a drive, nothing at or beneath it may be acted on: 403 OUTSIDE_SCAN_ROOT', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  await scanned(f.root);
  for (const p of [f.onDrive, f.mnt, path.join(f.mnt, 'not-yet.txt')]) {
    const r = await deleteDryRun([p]);
    assert.equal(r.status, 403, `${p}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'OUTSIDE_SCAN_ROOT');
  }
  const here = await deleteDryRun([f.here]);
  assert.equal(here.status, 200, 'a file the scan listed is still acted on');
  assert.equal(here.body.wouldTrash?.[0]?.path, f.here);
  assert.ok(fs.existsSync(f.onDrive) && fs.existsSync(f.here), 'a dry run moves nothing');
});

function postFacts(body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, path: '/api/facts', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
      },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

test('POST /api/facts answers a batch holding a drive the scan did not enter: that path is skipped, never a 403 for the batch (TS review R8)', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  const s = await scanned(f.root);
  // The Grid sends every child of the folder it shows, the mount point among them.
  const r = await postFacts({ scanId: s.scanId, paths: [f.other, f.mnt, f.onDrive], providers: ['size'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const size = r.body.providers.size;
  assert.deepEqual(Object.keys(size.values), [f.other], 'only what the scan listed is answered');
  assert.deepEqual(size.values[f.other], { bytes: 200 });
  assert.deepEqual(size.stats, { requested: 3, computed: 1, skipped: 2, failed: 0 }, 'the drive and the file on it are skipped, and counted');
  const outside = path.join(fs.realpathSync(fileTempDir('treemap-guard-facts-outside-')), 'x.txt');
  const refused = await postFacts({ scanId: s.scanId, paths: [f.other, outside], providers: ['size'] });
  assert.deepEqual([refused.status, refused.body.code], [403, 'OUTSIDE_SCAN_ROOT'], 'a path under no scanned root is still refused');
});

test('POST /api/facts: a batch of only paths no scan listed still says which providers cannot answer on this computer — never "available" for want of asking (the SEC-1 review, L3)', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  const s = await scanned(f.root);
  // A provider this computer cannot run, standing in for last-opened dates where nothing records them.
  let asked = 0;
  const missing: FactProvider<never> = {
    id: 'zzz-sec1-not-here',
    label: 'A signal this computer lacks',
    capabilityKey: null,
    async compute(_scanId, paths) {
      asked++;
      return unavailableBatch('This computer does not record that.', paths.length);
    },
  };
  registerFactProvider(missing);
  try {
    const r = await postFacts({ scanId: s.scanId, paths: [f.mnt, f.onDrive], providers: ['zzz-sec1-not-here', 'size'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const lacking = r.body.providers['zzz-sec1-not-here'];
    assert.equal(lacking.available, false, 'the provider was asked, and said it cannot answer here');
    assert.equal(lacking.reason, 'This computer does not record that.');
    assert.deepEqual(lacking.values, {});
    assert.deepEqual(lacking.stats, { requested: 2, computed: 0, skipped: 2, failed: 0 }, 'requested = computed + skipped + failed still holds');
    assert.equal(asked, 1);
    const size = r.body.providers.size;
    assert.equal(size.available, true, 'one that can answer says so');
    assert.deepEqual(size.stats, { requested: 2, computed: 0, skipped: 2, failed: 0 }, 'both paths skipped, and counted');
  } finally {
    unregisterFactProvider('zzz-sec1-not-here');
  }
});

test('a spelling of the drive in another case is the same drive where names fold (macOS and Windows)', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  if (process.platform !== 'darwin') return t.skip('the case-folding volume is macOS’s default; Linux volumes keep case');
  const f = tree();
  await scanned(f.root);
  const shouted = path.join(f.root, 'MNT', 'on-drive.txt');
  assert.ok(fs.existsSync(shouted), 'this volume folds case, so the shouted spelling is the same file');
  assert.equal(insideAnyScanRoot(shouted), false);
  // The mount point itself, the leaf no realpath re-spells: only the fold catches it.
  const shoutedDrive = path.join(f.root, 'MNT');
  assert.equal(insideAnyScanRoot(shoutedDrive), false, 'the drive under another case of its name');
  for (const p of [shouted, shoutedDrive]) {
    const r = await deleteDryRun([p]);
    assert.equal(r.status, 403, `${p}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'OUTSIDE_SCAN_ROOT');
  }
});

test('a scan of the drive itself covers it; the other folders stay covered', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  await scanned(f.root);
  assert.equal(insideAnyScanRoot(f.onDrive), false, 'refused before the drive is scanned');
  await scanned(f.mnt);
  assert.equal(insideAnyScanRoot(f.onDrive), true, 'another scan covers it');
  const r = await deleteDryRun([f.onDrive]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await deleteDryRun([f.here])).status, 200);
});

test('MCP trash_paths answers the same refusal', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const f = tree();
  await scanned(f.root);
  const reply = (await client.callTool({ name: 'trash_paths', arguments: { paths: [f.onDrive], dryRun: true } })) as { isError?: boolean; content?: { text: string }[] };
  assert.equal(reply.isError, true);
  assert.match(reply.content?.[0]?.text ?? '', /OUTSIDE_SCAN_ROOT/);
  const ok = (await client.callTool({ name: 'trash_paths', arguments: { paths: [f.here], dryRun: true } })) as { isError?: boolean };
  assert.notEqual(ok.isError, true, 'a listed file is still offered');
});

test('a scan of / does not permit a path inside a fixed never-descend folder (/Volumes on macOS, /run on Linux)', async (t) => {
  const fixed = neverDescendPaths();
  if (fixed.length === 0) return t.skip(`no folder is fixed as never-descend on ${process.platform}`);
  const volumes = process.platform === 'darwin' ? '/Volumes' : '/run';
  assert.ok(fixed.includes(volumes));
  // A record of a scan of /, made by hand: nothing is walked, and no test may scan the real /.
  const slash = createScanRecord('/');
  slash.status = 'complete';
  slash.finishedAt = Date.now();
  try {
    assert.equal(insideAnyScanRoot(path.join(volumes, 'SomeDrive', 'file.txt')), false, 'a scan of / never listed it');
    assert.equal(insideAnyScanRoot(volumes), false, 'nor the folder itself');
    const elsewhere = path.join(fs.realpathSync(fileTempDir('treemap-guard-slash-')), 'x.txt');
    assert.equal(insideAnyScanRoot(elsewhere), true, 'everything the walk of / would list is still inside');
  } finally {
    // The record of / would cover every path for the rest of the run; it goes.
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  }
});

test('a scan of / under stay, with the diagnosis Mac’s real mount table, still grants what it listed — and nothing on the drives it did not enter (the U-25 security review, F1)', async () => {
  // /System/Volumes/Data is one of the mounts the table lists under the fixed
  // /System/Volumes, and the Data volume's own spelling of the root is "/": an
  // exclusion taken through canonicalDirOf on its own became "/", and every
  // path on the disk was refused after a whole-disk scan.
  const boundary = await scanBoundary('/', 'stay', {
    platform: 'darwin',
    readTable: async () => ({ source: 'mount', entries: parseBsdMount(DIAGNOSIS_MAC_MOUNT), reason: null }),
    realpath: async (p: string) => p,
    aliases: async () => firmlinkAliases(parseFirmlinks(DIAGNOSIS_MAC_FIRMLINKS)),
    isDirectory: async () => true,
  });
  assert.ok(boundary.neverDescend.includes('/System/Volumes/Data'), 'the table lists the Data volume, under the fixed /System/Volumes');
  const slash = createScanRecord('/');
  slash.status = 'complete';
  slash.finishedAt = Date.now();
  slash.boundary = boundaryRecord(boundary);
  try {
    const home = fs.realpathSync(fileTempDir('treemap-guard-slash-stay-'));
    assert.equal(insideAnyScanRoot(path.join(home, 'listed.txt')), true, 'a file the walk of / listed is still inside');
    assert.equal(insideAnyScanRoot(path.join(IOS_22E238, 'System', 'Library', 'x.plist')), false, 'a file on a drive it did not enter is not');
    assert.equal(insideAnyScanRoot(IOS_22E238), false, 'nor the drive’s mount point');
    if (process.platform === 'darwin') {
      assert.equal(insideAnyScanRoot('/Volumes/SomeDrive/f.txt'), false, 'nor anything in /Volumes');
      assert.equal(insideAnyScanRoot('/System/Volumes/Preboot/x'), false, 'nor another system volume');
      assert.equal(insideAnyScanRoot(path.join('/System/Volumes/Data', home, 'listed.txt')), true, 'the Data volume’s spelling of a listed file is the same file');
    }
  } finally {
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  }
});

test('a drive named with a word-final sigma is the same drive in either sigma (the U-25 security review, F7)', () => {
  const root = fs.realpathSync(fileTempDir('treemap-guard-sigma-'));
  const drive = path.join(root, 'ΔΙΣΚΟΣ');
  const record = createScanRecord(root);
  record.status = 'complete';
  record.finishedAt = Date.now();
  record.boundary = boundaryRecord({
    rule: 'stay', source: 'mount', reason: null,
    mounts: [{ path: drive, filesystem: 'apfs', source: '/dev/disk99s1', underFixed: false }],
    fixed: [], neverDescend: [drive],
  });
  try {
    assert.equal(insideAnyScanRoot(path.join(root, 'δισκος')), false, 'final sigma');
    assert.equal(insideAnyScanRoot(path.join(root, 'δισκοσ')), false, 'medial sigma at the end: a fold that keeps the two apart lets this through');
    assert.equal(insideAnyScanRoot(path.join(root, 'other')), true);
  } finally {
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  }
});

test('a name that only begins with two dots (..data, as Kubernetes mounts a ConfigMap) is inside its folder, not a way out of it (the U-25 security review, F6)', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-guard-dotdot-'));
  assert.equal(isInside(root, path.join(root, '..data')), true);
  assert.equal(isInside(root, path.join(root, '..data', 'config.yaml')), true);
  assert.equal(isInside(root, path.join(root, '...')), true, 'three dots are a name too');
  assert.equal(isInside(root, path.dirname(root)), false, '.. itself still leaves');
  assert.equal(isInside(root, path.join(path.dirname(root), 'sibling')), false);
  assert.equal(isInside(root, `${root}-sibling`), false, 'a name that merely starts like the folder is not in it');
  const dotted = path.join(root, '..data');
  fs.mkdirSync(dotted);
  const file = path.join(dotted, 'config.yaml');
  fs.writeFileSync(file, 'k: v');
  await scanned(root);
  const r = await deleteDryRun([file]);
  assert.equal(r.status, 200, `a file the scan listed under ..data is acted on: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.wouldTrash?.[0]?.path, file);
  assert.ok(fs.existsSync(file), 'a dry run moves nothing');
});

test('a scan of the Data volume itself covers what the root shows of that volume, never the sealed system volume or another volume (the U-25 security review, F2)', async (t) => {
  if (process.platform !== 'darwin') return t.skip('the Data volume and its firmlinks are macOS');
  // Every spelling under /System/Volumes/Data is the root's own (pathSanitizer), so this scan's
  // root reads as "/" — and before, it granted every path on every volume.
  evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  const data = createScanRecord('/System/Volumes/Data');
  data.status = 'complete';
  data.finishedAt = Date.now();
  const home = fs.realpathSync(fileTempDir('treemap-guard-data-volume-'));
  assert.ok(home.startsWith('/private/'), `the temp folder is on the Data volume, under /private: ${home}`);
  try {
    // This Mac's own firmlinks.
    assert.equal(insideAnyScanRoot(path.join(home, 'x.txt')), true, 'a file on the Data volume, as the root spells it');
    assert.equal(insideAnyScanRoot(path.join('/System/Volumes/Data', home, 'x.txt')), true, 'and as the Data volume spells it');
    assert.equal(insideAnyScanRoot('/System/Library/CoreServices/SystemVersion.plist'), false, 'the sealed system volume was never listed');
    assert.equal(insideAnyScanRoot('/usr/bin/true'), false);
    assert.equal(insideAnyScanRoot('/System/Volumes/Preboot/x'), false, 'nor another volume');
    // A firmlink list that cannot be read grants nothing.
    setDataVolumeFoldersForTests([]);
    assert.equal(insideAnyScanRoot(path.join(home, 'x.txt')), false, 'unknown firmlinks: fail closed');
    setDataVolumeFoldersForTests(['/Users']);
    assert.equal(insideAnyScanRoot(path.join(home, 'x.txt')), false, 'only the folders the firmlinks name');
    setDataVolumeFoldersForTests(null);
    // A scan of / itself listed the system volume too.
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
    const slash = createScanRecord('/');
    slash.status = 'complete';
    slash.finishedAt = Date.now();
    assert.equal(insideAnyScanRoot('/usr/bin/true'), true, 'a scan of / covers the system volume it listed');
  } finally {
    setDataVolumeFoldersForTests(null);
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  }
});

test('a scan of the Data volume never lists /Volumes, where every drive appears: a drive mounted after it began, and every drive when the mount table was unknown, are outside it (the SEC-1 review, M2)', async (t) => {
  if (process.platform !== 'darwin') return t.skip('the Data volume and its firmlinks are macOS');
  // /usr/share/firmlinks names /Volumes, so the Data volume's /Volumes is the root's: the drives
  // mounted there appear in a walk of /System/Volumes/Data. The fixed list is spelled from the
  // root (/Volumes), and no path below /System/Volumes/Data is that, so it was dropped for this
  // root and only the drives the table named at the start were refused.
  const pairs = parseFirmlinks(DIAGNOSIS_MAC_FIRMLINKS);
  setDataVolumeFoldersForTests(pairs.map((pair) => pair.system));
  const home = fs.realpathSync(fileTempDir('treemap-guard-data-m2-'));
  const tables = [
    { label: 'the table read at the start', entries: parseBsdMount(`${DIAGNOSIS_MAC_MOUNT}/dev/disk20s1 on /Volumes/Backup (apfs, local, journaled)\n`) },
    { label: 'the table unknown', entries: null },
  ];
  try {
    for (const { label, entries } of tables) {
      evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
      const boundary = await scanBoundary('/System/Volumes/Data', 'stay', {
        platform: 'darwin',
        readTable: async () => ({ source: 'mount', entries, reason: entries === null ? 'mount could not be run' : null }),
        realpath: async (p: string) => p,
        aliases: async () => firmlinkAliases(pairs),
        isDirectory: async () => true,
      });
      const data = createScanRecord('/System/Volumes/Data');
      data.status = 'complete';
      data.finishedAt = Date.now();
      data.boundary = boundaryRecord(boundary);
      for (const p of ['/Volumes/Backup/secret.txt', '/Volumes/NewlyMounted/secret.txt', '/Volumes/NewlyMounted', '/Volumes', '/System/Volumes/Data/Volumes/NewlyMounted/x', '/System/Volumes/Data/Volumes']) {
        assert.equal(insideAnyScanRoot(p), false, `${label}: ${p}`);
      }
      assert.equal(insideAnyScanRoot(path.join(home, 'x.txt')), true, `${label}: a file on the Data volume is still inside`);
      const r = await deleteDryRun(['/Volumes/NewlyMounted/secret.txt']);
      assert.deepEqual([r.status, r.body.code], [403, 'OUTSIDE_SCAN_ROOT'], `${label}: ${JSON.stringify(r.body)}`);
    }
  } finally {
    setDataVolumeFoldersForTests(null);
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  }
});

test('a scan of the Data volume typed through a link in its parents, or in another case, never lists /Volumes either: its exclusions are taken where its root really is (the SEC-2 review, F1)', async (t) => {
  if (process.platform !== 'darwin') return t.skip('the Data volume and its firmlinks are macOS');
  // The rule judges a root where it really is (/System/Volumes/Data), while the fixed folders were
  // spelled from the root as typed, which the sanitizer keeps — so a root typed any other way
  // dropped them again, and with them every drive mounted after the scan began (or every drive,
  // when the table could not be read). Every Mac has /Volumes/<its boot volume> → /, which makes
  // /Volumes/Macintosh HD/System/Volumes/Data such a spelling; a link made here to /System stands
  // in for it, so nothing depends on what this Mac's volumes are called.
  const pairs = parseFirmlinks(DIAGNOSIS_MAC_FIRMLINKS);
  setDataVolumeFoldersForTests(pairs.map((pair) => pair.system));
  const home = fs.realpathSync(fileTempDir('treemap-guard-data-f1-'));
  fs.symlinkSync('/System', path.join(home, 'boot'));
  const roots = [path.join(home, 'boot', 'Volumes', 'Data')];
  // The boot volume folds case on every Mac by default; where it does, /System/volumes is that folder
  // too, and so is the root's own last name in another case — which was kept as typed, so such a root
  // was not the Data volume to the rule and granted nothing of it (the SEC-2b review, F1.3, F1.5).
  if (fs.realpathSync.native('/System/volumes') === '/System/Volumes') roots.push('/System/volumes/Data');
  if (fs.realpathSync.native('/System/Volumes/data') === '/System/Volumes/Data') {
    roots.push('/System/Volumes/data', '/System/Volumes/DATA', '/system/volumes/data', path.join(home, 'boot', 'Volumes', 'DATA'));
  }
  const tables = [
    { label: 'the table read at the start', entries: parseBsdMount(`${DIAGNOSIS_MAC_MOUNT}/dev/disk20s1 on /Volumes/Backup (apfs, local, journaled)\n`) },
    { label: 'the table unknown', entries: null },
  ];
  try {
    for (const root of roots) {
      resetRateLimiter(); // two dry runs a root: this asks about the rule, never the limiter
      assert.equal(sanitizePath(root), root, 'the sanitizer keeps the root as typed, and so does the record');
      for (const { label, entries } of tables) {
        evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
        const boundary = await scanBoundary(root, 'stay', {
          platform: 'darwin',
          readTable: async () => ({ source: 'mount', entries, reason: entries === null ? 'mount could not be run' : null }),
          realpath: async (p: string) => (p === root ? '/System/Volumes/Data' : p),
          aliases: async () => firmlinkAliases(pairs),
          isDirectory: async () => true,
        });
        const data = createScanRecord(root);
        data.status = 'complete';
        data.finishedAt = Date.now();
        data.boundary = boundaryRecord(boundary);
        for (const p of [
          '/Volumes/NewlyMounted/secret.txt', '/Volumes/NewlyMounted', '/Volumes', '/System/Volumes/Data/Volumes/NewlyMounted/x',
          '/System/Volumes/Data/Volumes', path.join(root, 'Volumes', 'NewlyMounted', 'x'), '/Volumes/Backup/secret.txt',
        ]) {
          assert.equal(insideAnyScanRoot(p), false, `${root}, ${label}: ${p}`);
        }
        assert.deepEqual(
          {
            file: insideAnyScanRoot(path.join(home, 'x.txt')),
            asTheVolumeSpellsIt: insideAnyScanRoot(path.join('/System/Volumes/Data', home, 'x.txt')),
            asTheRootSpellsIt: insideAnyScanRoot(path.join(root, home, 'x.txt')),
            theRootItself: insideAnyScanRoot(root),
          },
          { file: true, asTheVolumeSpellsIt: true, asTheRootSpellsIt: true, theRootItself: false },
          `${root}, ${label}: a file on the Data volume is still inside, by each spelling; the volume itself never was`,
        );
        const r = await deleteDryRun(['/Volumes/NewlyMounted/secret.txt']);
        assert.deepEqual([r.status, r.body.code], [403, 'OUTSIDE_SCAN_ROOT'], `${root}, ${label}: ${JSON.stringify(r.body)}`);
        // The read-only rule (POST /api/facts) reads the root the same way: the file by each spelling,
        // and the root itself, are under it — skipped or answered, never a 403 for the batch — while
        // the sealed system volume is under no scan of the Data volume (the SEC-2c review, F2.7).
        const read = await postFacts({
          scanId: data.scanId,
          paths: [path.join(home, 'x.txt'), path.join('/System/Volumes/Data', home, 'x.txt'), path.join(root, home, 'x.txt'), root],
          providers: ['size'],
        });
        assert.equal(read.status, 200, `${root}, ${label}: ${JSON.stringify(read.body)}`);
        const sealed = await postFacts({ scanId: data.scanId, paths: [path.join(home, 'x.txt'), '/usr/bin/true'], providers: ['size'] });
        assert.deepEqual([sealed.status, sealed.body.code], [403, 'OUTSIDE_SCAN_ROOT'], `${root}, ${label}: ${JSON.stringify(sealed.body)}`);
      }
    }
  } finally {
    setDataVolumeFoldersForTests(null);
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  }
});

test('a scan root typed with its last name in another case covers the folder it names, by either spelling; a root that is a link covers the link, never what it leads to', async (t) => {
  const home = fs.realpathSync(fileTempDir('treemap-guard-root-case-'));
  fs.mkdirSync(path.join(home, 'Projects'));
  fs.mkdirSync(path.join(home, 'Projects2'));
  fs.mkdirSync(path.join(home, 'elsewhere'));
  fs.symlinkSync(path.join(home, 'elsewhere'), path.join(home, 'link-root'));
  fs.symlinkSync(path.join(home, 'Projects'), path.join(home, 'to-projects'));
  const folds = fs.existsSync(path.join(home, 'PROJECTS'));
  try {
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
    const linked = createScanRecord(path.join(home, 'link-root'));
    linked.status = 'complete';
    linked.finishedAt = Date.now();
    const answers: Record<string, unknown> = {
      'the link the scan listed': insideAnyScanRoot(path.join(home, 'link-root')),
      'what it leads to': insideAnyScanRoot(path.join(home, 'elsewhere', 'x.txt')),
    };
    const expected: Record<string, unknown> = { 'the link the scan listed': true, 'what it leads to': false };
    if (folds) {
      // Its files' folders read back by the volume's own name, while the root's last name stayed as
      // typed: every file the scan listed was outside it (the SEC-2b review, F1.3).
      const typed = createScanRecord(path.join(home, 'PROJECTS'));
      typed.status = 'complete';
      typed.finishedAt = Date.now();
      answers['a file, as the scan spelled it'] = insideAnyScanRoot(path.join(home, 'PROJECTS', 'a.txt'));
      answers['a file, by its own name'] = insideAnyScanRoot(path.join(home, 'Projects', 'a.txt'));
      answers['a sibling'] = insideAnyScanRoot(path.join(home, 'Projects2', 'a.txt'));
      // And the root itself, by any spelling of its last name: a path keeps its last name as typed,
      // and the root's became the volume's own, so the root as the scan names it was refused (the
      // SEC-2c review, F2.3). A sibling folder, or a link beside the root that leads to it, is not it.
      answers['the root itself, as the scan spelled it'] = insideAnyScanRoot(path.join(home, 'PROJECTS'));
      answers['the root itself, by its own name'] = insideAnyScanRoot(path.join(home, 'Projects'));
      answers['the root itself, in a third case'] = insideAnyScanRoot(path.join(home, 'projects'));
      answers['a sibling folder'] = insideAnyScanRoot(path.join(home, 'Projects2'));
      answers['a link beside the root, to it'] = insideAnyScanRoot(path.join(home, 'to-projects'));
      Object.assign(expected, {
        'a file, as the scan spelled it': true, 'a file, by its own name': true, 'a sibling': false,
        'the root itself, as the scan spelled it': true, 'the root itself, by its own name': true, 'the root itself, in a third case': true,
        'a sibling folder': false, 'a link beside the root, to it': false,
      });
      // The read-only rule (POST /api/facts) reads the root as the listing rule does (the SEC-2c review, F2.7).
      const read = await postFacts({
        scanId: typed.scanId,
        paths: [path.join(home, 'PROJECTS', 'a.txt'), path.join(home, 'Projects', 'a.txt'), path.join(home, 'PROJECTS'), path.join(home, 'Projects'), path.join(home, 'projects')],
        providers: ['size'],
      });
      answers['the read-only rule: the root and its files, by either spelling'] = read.status === 200 || JSON.stringify(read.body);
      const sibling = await postFacts({ scanId: typed.scanId, paths: [path.join(home, 'Projects2', 'a.txt')], providers: ['size'] });
      answers['the read-only rule: a sibling'] = sibling.body.code ?? sibling.status;
      Object.assign(expected, { 'the read-only rule: the root and its files, by either spelling': true, 'the read-only rule: a sibling': 'OUTSIDE_SCAN_ROOT' });
    } else {
      // On a volume that keeps case, another case names another folder: PROJECTS beside the scanned
      // Projects is neither the root nor in it, to the act rule and to the read-only rule alike. Nothing
      // asserted it, so a root compared without case passed here and on Linux (the SEC-2d review, F3.3).
      t.diagnostic('this volume keeps case, so a root in another case names another folder');
      fs.mkdirSync(path.join(home, 'PROJECTS'));
      fs.writeFileSync(path.join(home, 'PROJECTS', 'a.txt'), 'a');
      const scanned = createScanRecord(path.join(home, 'Projects'));
      scanned.status = 'complete';
      scanned.finishedAt = Date.now();
      answers['the root itself'] = insideAnyScanRoot(path.join(home, 'Projects'));
      answers['another folder, by the root’s name in another case'] = insideAnyScanRoot(path.join(home, 'PROJECTS'));
      answers['a file in that folder'] = insideAnyScanRoot(path.join(home, 'PROJECTS', 'a.txt'));
      for (const [what, p] of [['that folder', path.join(home, 'PROJECTS')], ['a file in it', path.join(home, 'PROJECTS', 'a.txt')]]) {
        const read = await postFacts({ scanId: scanned.scanId, paths: [p], providers: ['size'] });
        answers[`the read-only rule: ${what}`] = read.body.code ?? read.status;
      }
      Object.assign(expected, {
        'the root itself': true, 'another folder, by the root’s name in another case': false, 'a file in that folder': false,
        'the read-only rule: that folder': 'OUTSIDE_SCAN_ROOT', 'the read-only rule: a file in it': 'OUTSIDE_SCAN_ROOT',
      });
    }
    assert.deepEqual(answers, expected);
  } finally {
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  }
});

test('the root by another spelling of its last name is asked of the file system only for a path beside the root: a batch of files in a scan costs two lstats a file, and no realpath once their folder is known (the SEC-2d review, F3.5)', () => {
  // asTheRoot's gate kept the question to a path beside the root, and nothing counted it: without it every
  // path cost one more lstat for every scan tried, on a route that judges 2,000 paths a request. Counted,
  // not timed.
  const home = fs.realpathSync(fileTempDir('treemap-guard-root-cost-'));
  const root = path.join(home, 'Projects');
  fs.mkdirSync(root);
  const files = Array.from({ length: 200 }, (_, i) => path.join(root, `f${i}.txt`));
  for (const f of files) fs.writeFileSync(f, 'f');
  const sync = fs as unknown as { lstatSync: (...args: unknown[]) => unknown };
  const lstat = sync.lstatSync;
  const realpath = fs.realpathSync.native;
  const calls = { lstat: 0, realpath: 0 };
  try {
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
    const rec = createScanRecord(root);
    rec.status = 'complete';
    rec.finishedAt = Date.now();
    assert.equal(insideAnyScanRoot(files[0]), true, 'and the folders’ answers are now remembered');
    sync.lstatSync = (...args: unknown[]) => {
      calls.lstat += 1;
      return lstat(...args);
    };
    fs.realpathSync.native = ((...args: Parameters<typeof realpath>) => {
      calls.realpath += 1;
      return realpath(...args);
    }) as typeof realpath;
    const inside = files.filter((f) => insideAnyScanRoot(f)).length;
    sync.lstatSync = lstat;
    fs.realpathSync.native = realpath;
    // One lstat of the file (is it a link?) and one of the root (is it a folder?), and a few spare.
    const bound = 2 * files.length + 8;
    assert.deepEqual(
      { inside, calls: calls.lstat + calls.realpath <= bound ? `at most ${bound}` : `${calls.lstat} lstats and ${calls.realpath} realpaths` },
      { inside: files.length, calls: `at most ${bound}` },
    );
  } finally {
    sync.lstatSync = lstat;
    fs.realpathSync.native = realpath;
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  }
});

test('where /usr/share/firmlinks cannot be read, the folders every macOS firmlinks stand in: the Data volume’s spelling of a scanned file is still that file, and nothing else is read as the root’s (the SEC-2 review, LOW-1)', async (t) => {
  if (process.platform !== 'darwin') return t.skip('the Data volume and its firmlinks are macOS');
  // With no list, no Data volume spelling was the root's: a scan of a home folder refused
  // /System/Volumes/Data/Users/me/f, while the sanitizer, the spill and the app-data rules all
  // read it as /Users/me/f — the layers disagreed about one file.
  const lists = fs.realpathSync(fileTempDir('treemap-guard-low1-list-'));
  setFirmlinksFileForTests(path.join(lists, 'no-such-firmlinks'));
  evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  const home = fs.realpathSync(fileTempDir('treemap-guard-low1-'));
  assert.ok(home.startsWith('/private/'), `the temp folder is under /private: ${home}`);
  const inData = path.join('/System/Volumes/Data', home, 'f.txt');
  try {
    const rec = createScanRecord(home);
    rec.status = 'complete';
    rec.finishedAt = Date.now();
    assert.equal(insideAnyScanRoot(path.join(home, 'f.txt')), true);
    assert.equal(insideAnyScanRoot(inData), true, 'the Data volume’s spelling of a file in the scan');
    // A list that can be read is the list; one that names nothing is no list, and the default stands in.
    const file = path.join(lists, 'firmlinks');
    fs.writeFileSync(file, '/Users\tUsers\n');
    setFirmlinksFileForTests(file);
    assert.equal(insideAnyScanRoot(inData), false, 'a list naming only /Users does not make /private the root’s');
    fs.writeFileSync(file, '');
    setFirmlinksFileForTests(file);
    assert.equal(insideAnyScanRoot(inData), true, 'an empty list: the default');
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
    const slash = createScanRecord('/');
    slash.status = 'complete';
    slash.finishedAt = Date.now();
    assert.equal(insideAnyScanRoot('/System/Volumes/Data/usr/local/bin/x'), true, '/usr/local is firmlinked on every macOS');
    assert.equal(insideAnyScanRoot('/System/Volumes/Data/usr/bin/x'), false, 'the Data volume’s own /usr/bin is not /usr/bin');
    assert.equal(insideAnyScanRoot('/System/Volumes/Data/System/Library/Caches/x'), false, 'a folder firmlinked only on some versions is not assumed');
  } finally {
    setFirmlinksFileForTests(null);
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  }
});

test('POST /api/facts after a scan of the Data volume: a folder only that volume has is under its root, so it is skipped rather than refusing the batch; the sealed system volume is still refused (the SEC-2 review, MEDIUM-2)', async (t) => {
  if (process.platform !== 'darwin') return t.skip('the Data volume and its firmlinks are macOS');
  // The read-only rule asks only "under some scan's root, listed or not", and the route skips what
  // no scan listed. It took the listing rule's spelling of a Data volume path, which a scan of the
  // volume itself answers with "not listed" (the Data volume's own /usr, /.Spotlight-V100, /mnt) —
  // and so "under no root": one such path, a child the Grid asks about, cost the whole batch a 403.
  setDataVolumeFoldersForTests(parseFirmlinks(DIAGNOSIS_MAC_FIRMLINKS).map((pair) => pair.system));
  evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  const home = fs.realpathSync(fileTempDir('treemap-guard-data-medium2-'));
  const listed = path.join(home, 'x.txt');
  const own = ['/System/Volumes/Data/usr', '/System/Volumes/Data/.Spotlight-V100', '/System/Volumes/Data/mnt/x'];
  try {
    const data = createScanRecord('/System/Volumes/Data');
    data.status = 'complete';
    data.finishedAt = Date.now();
    for (const p of own) assert.equal(insideAnyScanRoot(p), false, `${p} is still never acted on`);
    const r = await postFacts({ scanId: data.scanId, paths: [listed, ...own], providers: ['size'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const size = r.body.providers.size;
    for (const p of own) assert.ok(!(p in size.values), `${p} has no fact`);
    assert.equal(size.stats.requested, 4);
    assert.ok(size.stats.skipped >= own.length, `each of the Data volume's own folders is skipped and counted: ${JSON.stringify(size.stats)}`);
    assert.equal(size.stats.requested, size.stats.computed + size.stats.skipped + size.stats.failed);
    const sealed = await postFacts({ scanId: data.scanId, paths: [listed, '/usr/bin/true'], providers: ['size'] });
    assert.deepEqual([sealed.status, sealed.body.code], [403, 'OUTSIDE_SCAN_ROOT'], 'the sealed system volume is under no scan of the Data volume');
    const elsewhere = await postFacts({ scanId: data.scanId, paths: [listed, '/System/Volumes/Preboot/x'], providers: ['size'] });
    assert.deepEqual([elsewhere.status, elsewhere.body.code], [403, 'OUTSIDE_SCAN_ROOT'], 'nor is another volume');
  } finally {
    setDataVolumeFoldersForTests(null);
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  }
});

test('the Data volume’s spelling of a path is the root’s only under a firmlinked folder: after a scan of /, the Data volume itself and its own folders (/System/Volumes/Data/.Spotlight-V100, …/mnt, …/usr/bin) were never listed (the SEC-1 review, L1)', async (t) => {
  if (process.platform !== 'darwin') return t.skip('the Data volume and its firmlinks are macOS');
  // Only the firmlinked folders (/Users, /private, /usr/local, …) are one folder under two names.
  // Everything else under /System/Volumes/Data is the Data volume's own and lies under /System/Volumes,
  // where no walk of / goes; it was stripped to a root path the scan did list (/usr/bin, /mnt, "/").
  const pairs = parseFirmlinks(DIAGNOSIS_MAC_FIRMLINKS);
  setDataVolumeFoldersForTests(pairs.map((pair) => pair.system));
  evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  const home = fs.realpathSync(fileTempDir('treemap-guard-data-l1-'));
  try {
    const boundary = await scanBoundary('/', 'stay', {
      platform: 'darwin',
      readTable: async () => ({ source: 'mount', entries: parseBsdMount(DIAGNOSIS_MAC_MOUNT), reason: null }),
      realpath: async (p: string) => p,
      aliases: async () => firmlinkAliases(pairs),
      isDirectory: async () => true,
    });
    const slash = createScanRecord('/');
    slash.status = 'complete';
    slash.finishedAt = Date.now();
    slash.boundary = boundaryRecord(boundary);
    for (const p of [
      '/System/Volumes/Data', '/System/Volumes/Data/', '/System/Volumes/Data/Volumes/..',
      '/System/Volumes/Data/.Spotlight-V100/x', '/System/Volumes/Data/mnt/x', '/System/Volumes/Data/usr/bin/foo',
      '/System/Volumes/Data/System/Library/Foo', '/System/Volumes/Data/MobileSoftwareUpdate/x',
    ]) {
      assert.equal(insideAnyScanRoot(p), false, `after a scan of /: ${p}`);
    }
    for (const p of [
      path.join('/System/Volumes/Data', home, 'x.txt'), '/System/Volumes/Data/usr/local/bin/x', '/System/Volumes/Data/System/Library/Caches/x',
      path.join(home, 'x.txt'), '/usr/bin/true', '/.Spotlight-V100/x',
    ]) {
      assert.equal(insideAnyScanRoot(p), true, `after a scan of /: ${p}`);
    }
    const r = await deleteDryRun(['/System/Volumes/Data/mnt/x']);
    assert.deepEqual([r.status, r.body.code], [403, 'OUTSIDE_SCAN_ROOT'], JSON.stringify(r.body));

    // A scan of a folder only the Data volume has listed that folder — not the sealed volume's one of that name.
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
    const mnt = createScanRecord('/System/Volumes/Data/mnt');
    mnt.status = 'complete';
    mnt.finishedAt = Date.now();
    assert.equal(insideAnyScanRoot('/System/Volumes/Data/mnt/x'), true, 'what it listed');
    assert.equal(insideAnyScanRoot('/mnt/x'), false, 'the sealed volume’s /mnt is another folder');

    // A scan of the Data volume itself still covers what the root shows of it, and nothing else (F2).
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
    const data = createScanRecord('/System/Volumes/Data');
    data.status = 'complete';
    data.finishedAt = Date.now();
    assert.equal(insideAnyScanRoot(path.join(home, 'x.txt')), true, 'a firmlinked folder, as the root spells it');
    assert.equal(insideAnyScanRoot(path.join('/System/Volumes/Data', home, 'x.txt')), true, 'and as the Data volume does');
    assert.equal(insideAnyScanRoot('/System/Volumes/Data/.Spotlight-V100/x'), false, 'not a folder the root does not show');
    assert.equal(insideAnyScanRoot('/usr/bin/true'), false, 'nor the sealed system volume');
    // The read-only rule (facts) asks only "under some scan's root", in the same spelling.
    const read = await postFacts({ scanId: data.scanId, paths: [path.join(home, 'x.txt')], providers: ['size'] });
    assert.equal(read.status, 200, `facts read under a firmlinked folder: ${JSON.stringify(read.body)}`);
    const sealed = await postFacts({ scanId: data.scanId, paths: ['/usr/bin/true'], providers: ['size'] });
    assert.deepEqual([sealed.status, sealed.body.code], [403, 'OUTSIDE_SCAN_ROOT'], 'and not on the sealed volume, which is under no scan of the Data volume');
  } finally {
    setDataVolumeFoldersForTests(null);
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  }
});
