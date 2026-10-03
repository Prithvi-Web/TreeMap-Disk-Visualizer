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
import { insideAnyScanRoot } from '../src/middleware/pathGuard';
import { createScanRecord, evictExpiredScans, SCAN_TTL_MS, startScan } from '../src/services/diskScanner';
import { setTrashStepForTests } from '../src/services/cleaner';
import { updateSettings } from '../src/services/settings';
import { parseBsdMount } from '../src/platform/atime';
import { boundaryRecord, firmlinkAliases, neverDescendPaths, parseFirmlinks, scanBoundary, setBoundaryDepsForTests } from '../src/utils/mountBoundaries';
import { DIAGNOSIS_MAC_FIRMLINKS, DIAGNOSIS_MAC_MOUNT, IOS_22E238 } from './fixtures/mountTables';
import type { ScanResult } from '../src/models/types';

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
