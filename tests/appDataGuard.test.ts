import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
// App-data sits in a folder that is scanned, as ~/Library/Application Support sits in a scanned
// home folder: there the scanned-root rule allows a request that names a path in it.
const HOME = isolatedDataDir('treemap-appDataGuard-home-');
const APP = path.join(HOME, 'app-data');
fs.mkdirSync(APP);
process.env.TREEMAP_DATA_DIR = APP;
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../src/server';
import { buildMcpServer } from '../src/mcp/server';
import { evictExpiredScans, startScan } from '../src/services/diskScanner';
import { setLaunchStepForTests, setTrashStepForTests } from '../src/services/cleaner';
import { relocateSecret } from '../src/services/securityHygieneScanner';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { foldName, isAppDataPath, isSpillFolderName } from '../src/utils/pathSanitizer';
import { platform } from '../src/platform';
import type { ScanResult } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';

/**
 * Follow-up FG1, item 1: TreeMap's own app-data folder is never where a request writes, moves or
 * copies a file. It holds the files TreeMap trusts — the offload manifest the reveal route opens
 * from, the Autopilot policies (with their approval) the scheduler runs, the Time Capsule — and a
 * relocation, an offload or a snapshot restore could put a file there under a name of the
 * caller's choosing. Every such destination is refused 403 APP_DATA_PATH, however it is spelled,
 * before the file or the folder exists. Reading app-data and deleting what a scan covers stay as
 * they were. And the offload reveal opens only a copy inside its own destination.
 *
 * Nothing is written into app-data by a request here (every vector is refused, a dry run or aimed
 * at a missing target), nothing reaches the Trash, and nothing is launched: both steps are replaced
 * for the whole file.
 */

const USER = path.join(HOME, 'user');
fs.mkdirSync(path.join(USER, 'stuff'), { recursive: true });
fs.writeFileSync(path.join(USER, 'stuff', 'a.txt'), 'a user file');
const CRAFTED = path.join(USER, 'crafted.json');
fs.writeFileSync(CRAFTED, JSON.stringify({ entries: [], destinations: {} }));
const NAMED_LIKE_MANIFEST = path.join(USER, 'offload-manifest.json');
fs.writeFileSync(NAMED_LIKE_MANIFEST, JSON.stringify({ entries: [] }));
const OK_FILE = path.join(USER, 'ok.txt');
fs.writeFileSync(OK_FILE, 'moves where it is told');
const KEPT = path.join(APP, 'kept.txt');
fs.writeFileSync(KEPT, 'a file of app-data');
fs.mkdirSync(path.join(APP, 'sub'));
/** Links beside app-data: to it, to a file in it not made yet, through a chain, in a loop, and to the user's folder. */
const LINKS = path.join(HOME, 'links');
fs.mkdirSync(LINKS);
const TO_APP = path.join(LINKS, 'to-app');
fs.symlinkSync(APP, TO_APP, 'junction');
const PLANTED = path.join(LINKS, 'planted.json');
fs.symlinkSync(path.join(APP, 'planted.json'), PLANTED, 'file');
const CHAIN = path.join(LINKS, 'chain-1');
fs.symlinkSync(TO_APP, CHAIN, 'junction');
const LOOP = path.join(LINKS, 'loop-a');
fs.symlinkSync(path.join(LINKS, 'loop-b'), LOOP, 'file');
fs.symlinkSync(LOOP, path.join(LINKS, 'loop-b'), 'file');
const TO_USER = path.join(LINKS, 'to-user');
fs.symlinkSync(USER, TO_USER, 'junction');
/** A relative link to app-data (`../app-data`), read through a link to its folder from somewhere else. */
fs.symlinkSync(path.join('..', 'app-data'), path.join(LINKS, 'relative-to-app'), 'dir');
const LINKS_ELSEWHERE = path.join(fileTempDir('treemap-appDataGuard-elsewhere-'), 'to-links');
fs.symlinkSync(LINKS, LINKS_ELSEWHERE, 'junction');
/** Destinations outside app-data: an ordinary one, and one holding a link to app-data under a name the volume folds. */
const DEST = fileTempDir('treemap-appDataGuard-dest-');
const FOLD_DEST = fileTempDir('treemap-appDataGuard-folddest-');
fs.symlinkSync(APP, path.join(FOLD_DEST, 'ſtuff'), 'junction');
const FOLDS_LONG_S = fs.existsSync(path.join(FOLD_DEST, 'stuff'));

const launched: string[] = [];
const trashed: string[] = [];
let server: http.Server;
let port: number;
let client: Client;
let scan: ScanResult;

before(async () => {
  setTrashStepForTests(async (p) => {
    trashed.push(p);
    throw new Error('the app-data guard test trashes nothing');
  });
  setLaunchStepForTests(async (command) => {
    launched.push(command.cmd);
  });
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  const mcp = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'app-data-guard-test', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  scan = await startScan(HOME);
  await waitFor(() => scan.status !== 'running', 'the home scan');
  assert.equal(scan.status, 'complete', scan.error);
});

after(async () => {
  setTrashStepForTests(null);
  setLaunchStepForTests(null);
  await client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.deepEqual(trashed, [], 'nothing was offered to the Trash');
});

function request(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  resetRateLimiter();
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1', port, path: url, method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assertAppDataRefusal(answer: { status: number; body: any }, what: string): void {
  assert.equal(answer.status, 403, `${what}: refused (${JSON.stringify(answer.body).slice(0, 240)})`);
  assert.equal(answer.body.code, 'APP_DATA_PATH', what);
  assert.match(answer.body.error, /TreeMap's own app-data folder/, what);
}

/** The audit entries of one action, newest first. */
async function audited(action: string): Promise<{ outcome: string; code?: string }[]> {
  const entries = (await request('GET', '/api/audit?limit=1000')).body.entries as { action: string; outcome: string; code?: string }[];
  return entries.filter((e) => e.action === action);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const reply = (await client.callTool({ name, arguments: args })) as { content?: { text: string }[] };
  return reply.content?.[0]?.text ?? '';
}

/* ─────────────── The rule ─────────────── */

test('app-data and everything in it is recognised as a destination, however it is spelled', () => {
  const inside = [
    APP,
    path.join(APP, 'offload-manifest.json'),
    path.join(APP, 'autopilot.json'),
    path.join(APP, 'not', 'made', 'yet.json'),
    path.join(HOME, 'APP-DATA', 'x.json'),
    path.join(fs.realpathSync.native(APP), 'x.json'),
    path.join(TO_APP, 'x.json'),
    // A write to a link goes where it leads, so a link's own name is judged by its target too.
    TO_APP,
    PLANTED,
    CHAIN,
    // ../app-data from the folder the link really is in, whatever folder it was reached through.
    path.join(LINKS_ELSEWHERE, 'relative-to-app'),
    // A loop leads nowhere a write could land; it is refused rather than guessed about.
    LOOP,
  ];
  for (const p of inside) assert.equal(isAppDataPath(p), true, `${p} is app-data`);
  const outside = [
    HOME,
    CRAFTED,
    path.join(HOME, 'app-data-2', 'x.json'),
    path.join(HOME, 'app-dat'),
    path.join(DEST, 'x.json'),
    TO_USER,
    path.join(TO_USER, 'x.json'),
    'cloud://gdrive/app-data/x.json',
  ];
  for (const p of outside) assert.equal(isAppDataPath(p), false, `${p} is not app-data`);
});

test('the capability manifest states the rule', async () => {
  const caps = (await request('GET', '/api/capabilities')).body;
  assert.match(String(caps.safety.appDataFolder), /403 APP_DATA_PATH/);
  assert.match(String(caps.safety.audit), /SPILL_PATH or APP_DATA_PATH on a path the request names/);
});

test('before app-data exists, a name the file system may fold to its own is app-data', () => {
  const saved = process.env.TREEMAP_DATA_DIR;
  process.env.TREEMAP_DATA_DIR = path.join(HOME, 'tm-data-s');
  try {
    assert.equal(isAppDataPath(path.join(HOME, 'tm-data-ſ', 'x.json')), true, 'ſ for s');
    assert.equal(isAppDataPath(path.join(HOME, 'TM-DATA-S', 'x.json')), true, 'another case');
    assert.equal(isAppDataPath(path.join(HOME, 'tm-data-t', 'x.json')), false, 'another name');
  } finally {
    process.env.TREEMAP_DATA_DIR = saved;
  }
});

test('app-data under a second name no fold explains is app-data, by identity (a hard link stands in for a Windows short name)', () => {
  // On Windows app-data's folder also answers to an 8.3 name (TREEMA~1). APFS gives a folder no
  // second name, so app-data is pointed at a file here, hard-linked under another name.
  const saved = process.env.TREEMAP_DATA_DIR;
  const standIn = path.join(HOME, 'stand-in');
  const second = path.join(HOME, 'second-name');
  fs.writeFileSync(standIn, 'stands in for app-data');
  fs.linkSync(standIn, second);
  process.env.TREEMAP_DATA_DIR = standIn;
  try {
    assert.equal(isAppDataPath(second), true, 'the same entry, by device and inode');
    assert.equal(isAppDataPath(CRAFTED), false, 'while an entry of its own is not');
  } finally {
    process.env.TREEMAP_DATA_DIR = saved;
    fs.rmSync(second, { force: true });
    fs.rmSync(standIn, { force: true });
  }
});

test('names fold as the platform folds them: NFKC then case, and on Windows NTFS\'s upper case too', () => {
  assert.equal(foldName('ſcan', 'darwin'), 'scan', 'ſ is s');
  assert.equal(foldName('ＳＣＡＮ', 'linux'), 'scan', 'the fullwidth letters fold too');
  // NTFS upcases ı (U+0131) to I, where NFKC and lower case leave it alone.
  assert.equal(foldName('scan-spıll', 'win32'), 'scan-spill');
  assert.equal(isSpillFolderName('scan-spıll', 'win32'), true, 'so on Windows scan-spıll is the spill folder');
  assert.equal(isSpillFolderName('scan-spıll', 'darwin'), false, 'and elsewhere it is another name');
  assert.equal(foldName('TreeMap. .', 'win32'), 'treemap', 'Windows drops a trailing run of dots and spaces');
  assert.equal(foldName('TreeMap. .', 'darwin'), 'treemap. .', 'which other systems keep');
});

/* ─────────────── The routes ─────────────── */

test('a relocation never writes into app-data: the offload manifest, the Autopilot policies, any spelling', async () => {
  const destinations = [
    path.join(APP, 'offload-manifest.json'),
    path.join(APP, 'autopilot.json'),
    path.join(APP, 'new', 'deeper', 'x.json'),
    path.join(HOME, 'APP-DATA', 'x.json'),
    path.join(TO_APP, 'x.json'),
    PLANTED,
  ];
  for (const to of destinations) {
    assertAppDataRefusal(await request('POST', '/api/security/relocate', { path: CRAFTED, to, confirm: true }), `relocating to ${to}`);
  }
  assert.ok(fs.existsSync(CRAFTED), 'the crafted file stayed where it was');
  for (const name of ['offload-manifest.json', 'autopilot.json', 'new', 'x.json', 'planted.json']) {
    assert.ok(!fs.existsSync(path.join(APP, name)), `nothing named ${name} was made in app-data`);
  }
  // The move itself checks too, whoever calls it.
  await assert.rejects(relocateSecret(CRAFTED, path.join(APP, 'offload-manifest.json')), /TreeMap's own app-data folder/);
  assert.ok(fs.existsSync(CRAFTED));
});

test('an offload never copies into app-data: its destination, over HTTP and MCP, any spelling', async () => {
  const before = (await audited('offload.start')).length;
  for (const dest of [APP, TO_APP, path.join(APP, 'sub'), path.join(HOME, 'APP-DATA')]) {
    assertAppDataRefusal(
      await request('POST', '/api/offload', { scanId: scan.scanId, paths: [NAMED_LIKE_MANIFEST], dest, dryRun: true }),
      `offloading into ${dest}`,
    );
  }
  assert.match(
    await callTool('offload', { scanId: scan.scanId, paths: [NAMED_LIKE_MANIFEST], dest: APP, dryRun: true }),
    /^Error \(APP_DATA_PATH\): /,
  );
  // Refused as a path the request names, before a plan is made: a path rule, so not recorded.
  assert.equal((await audited('offload.start')).length, before, 'the destinations refused are not recorded');
});

test('nor any copy its plan would make there, through a link its destination holds under a name the volume folds', { skip: !FOLDS_LONG_S && 'this volume does not fold ſ to s' }, async () => {
  const offloads = (): Promise<{ outcome: string; code?: string }[]> => audited('offload.start');
  const before = (await offloads()).length;
  // The destination is outside app-data, so the route allows it; the plan names its copy
  // stuff/a.txt, and stuff is ſtuff to this volume — a link into app-data.
  assertAppDataRefusal(
    await request('POST', '/api/offload', { scanId: scan.scanId, paths: [path.join(USER, 'stuff')], dest: FOLD_DEST, dryRun: true }),
    'a planned copy that lands in app-data',
  );
  const after = await offloads();
  assert.equal(after.length, before + 1, 'the plan\'s refusal is recorded');
  assert.deepEqual([after[0].outcome, after[0].code], ['refused', 'APP_DATA_PATH']);
});

test('a snapshot restore never writes into app-data: a destination given, or the default beside an app-data original', async () => {
  const provider = platform();
  const listSnapshots = provider.listSnapshots;
  // A restore that got past its check would list the volume's snapshots next; none are offered,
  // so it would stop there, before anything privileged.
  provider.listSnapshots = async () => [];
  try {
    const before = (await audited('snapshots.restore')).length;
    assertAppDataRefusal(await request('POST', '/api/system/snapshots/restore', { path: CRAFTED, destination: path.join(APP, 'autopilot.json') }), 'as autopilot.json');
    assertAppDataRefusal(await request('POST', '/api/system/snapshots/restore', { path: CRAFTED, destination: path.join(TO_APP, 'x.json') }), 'through a link');
    assert.equal((await audited('snapshots.restore')).length, before, 'a destination the request names is a path rule, not recorded');
    assertAppDataRefusal(await request('POST', '/api/system/snapshots/restore', { path: KEPT }), 'beside an app-data original, by default');
    const recorded = await audited('snapshots.restore');
    assert.deepEqual([recorded.length - before, recorded[0].outcome, recorded[0].code], [1, 'refused', 'APP_DATA_PATH'], 'the default one is refused by the restore itself, and recorded');
  } finally {
    provider.listSnapshots = listSnapshots;
  }
  assert.deepEqual(fs.readdirSync(APP).filter((n) => n.includes('recovered')), [], 'nothing was recovered into app-data');
});

test('an encode never writes into app-data: it writes where its original is', async () => {
  // No confirm: an encode that got past the check would answer 400 CONFIRM_REQUIRED.
  assertAppDataRefusal(await request('POST', '/api/compression/encode', { paths: [KEPT] }), 'encoding a file of app-data');
});

test('reading app-data and deleting what a scan covers stay as they were', async () => {
  const facts = await request('POST', '/api/facts', { scanId: scan.scanId, paths: [KEPT], providers: ['size'] });
  assert.equal(facts.status, 200, JSON.stringify(facts.body).slice(0, 200));
  const trash = await request('DELETE', '/api/files', { paths: [KEPT], dryRun: true });
  assert.equal(trash.status, 200, JSON.stringify(trash.body).slice(0, 200));
});

test('a relocation and an offload elsewhere still work', async () => {
  const moved = path.join(USER, 'moved', 'ok.txt');
  const relocated = await request('POST', '/api/security/relocate', { path: OK_FILE, to: moved, confirm: true });
  assert.equal(relocated.status, 200, JSON.stringify(relocated.body).slice(0, 200));
  assert.ok(fs.existsSync(moved) && !fs.existsSync(OK_FILE), 'the file moved');
  const offload = await request('POST', '/api/offload', { scanId: scan.scanId, paths: [path.join(USER, 'stuff')], dest: DEST, dryRun: true });
  assert.equal(offload.status, 200, JSON.stringify(offload.body).slice(0, 200));
});

/* ─────────────── The offload reveal ─────────────── */

test('the offload reveal opens only a copy inside its own destination', async () => {
  const copy = path.join(DEST, 'copy.txt');
  fs.writeFileSync(copy, 'an offloaded copy');
  const escape = path.join(DEST, 'escape');
  fs.symlinkSync(USER, escape, 'junction');
  const leafEscape = path.join(DEST, 'leaf-escape.json');
  fs.symlinkSync(CRAFTED, leafEscape, 'file');
  const entry = { originalPath: CRAFTED, name: 'x', size: 1, hash: '0'.repeat(64), offloadedAt: Date.now(), destRoot: DEST };
  const manifest = path.join(APP, 'offload-manifest.json');
  // Written by the test into its own app-data, as TreeMap writes it: the tampered records are
  // what a planted manifest would hold.
  fs.writeFileSync(manifest, JSON.stringify({
    entries: [
      { ...entry, id: 'inside', destPath: copy },
      { ...entry, id: 'outside', destPath: CRAFTED },
      { ...entry, id: 'through-a-link', destPath: path.join(escape, 'crafted.json') },
      { ...entry, id: 'a-link-itself', destPath: leafEscape },
      { ...entry, id: 'dot-dot', destPath: `${DEST}${path.sep}..${path.sep}elsewhere.txt` },
      { ...entry, id: 'the-root-itself', destPath: DEST },
      // A record with no destination of its own would read one from the working folder.
      { ...entry, id: 'no-root', destRoot: '', destPath: path.join(process.cwd(), 'package.json') },
    ],
    destinations: {},
  }));
  const before = launched.length;
  try {
    const shown = await request('POST', '/api/offload/reveal', { id: 'inside' });
    assert.deepEqual([shown.status, shown.body.revealed], [200, copy], JSON.stringify(shown.body));
    for (const id of ['outside', 'through-a-link', 'a-link-itself', 'dot-dot', 'the-root-itself', 'no-root']) {
      const refused = await request('POST', '/api/offload/reveal', { id });
      assert.deepEqual([refused.status, refused.body.code], [403, 'OUTSIDE_DEST_ROOT'], `${id}: ${JSON.stringify(refused.body)}`);
    }
    assert.equal(launched.length - before, 1, 'only the copy inside its destination was revealed');
  } finally {
    fs.rmSync(manifest, { force: true });
  }
});

/* ─────────────── Open Terminal's answer (last: it forgets every scan) ─────────────── */

test('Open Terminal answers a refusal from its own check with that refusal, not as a missing terminal', async () => {
  const target = path.join(USER, 'stuff');
  const lstat = fs.promises.lstat;
  // Between the route's guard and the service's own check the route stats the folder; the scan that
  // made it a scanned root is forgotten there, as the evictor may forget one at any moment.
  (fs.promises as { lstat: unknown }).lstat = async (p: fs.PathLike, ...rest: unknown[]): Promise<fs.Stats> => {
    if (String(p) === target) evictExpiredScans(Date.now() + 365 * 86_400_000);
    return (lstat as (p: fs.PathLike, ...rest: unknown[]) => Promise<fs.Stats>)(p, ...rest);
  };
  const before = launched.length;
  try {
    const answer = await request('POST', '/api/files/terminal', { path: target });
    assert.deepEqual([answer.status, answer.body.code], [403, 'OUTSIDE_SCAN_ROOT'], JSON.stringify(answer.body));
  } finally {
    (fs.promises as { lstat: unknown }).lstat = lstat;
  }
  assert.equal(launched.length, before, 'and nothing was started');
});
