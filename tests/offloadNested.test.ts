import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-offloadNested-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { createScanRecord, peekScan } from '../src/services/diskScanner';
import { getOffloadIndex, getOffloadJob, prepareOffload, startOffload } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import type { OffloadJob, ScanResult } from '../src/models/types';
import { INDEX } from './fixtures/liftFrontend';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';
import { destinationsOnAnotherDrive } from './fixtures/offloadDrive';
destinationsOnAnotherDrive(); // every destination here stands for another drive (E01)

/**
 * A folder and an item inside it, both selected, are one set of files (the final review, F1.8): the
 * cart allows staging both, and dropping it on a drive sent both. The server planned the inner file
 * twice — the confirm over-counted files and bytes, the free-space check could refuse wrongly, the
 * job ended with "couldn't be moved to the Trash: it is no longer there" (the folder had taken it),
 * and the record held two rows for one original, the second never restorable. Now the server plans
 * each selection once, by its outermost item, and the page sends only those.
 *
 * Nothing reaches the machine's Trash: the trash step moves each original into this file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-offloadNested-trash-');
const trashedPaths: string[] = [];

before(() => {
  setTrashStepForTests(async (p) => {
    trashedPaths.push(p);
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashedPaths.length}-${path.basename(p)}`));
  });
});

after(() => {
  setTrashStepForTests(null);
});

/** proj/ holding a.txt and b.txt, 1,000 bytes each, under a fresh root; and a complete scan listing them. */
function project(label: string): { root: string; proj: string; a: string; b: string; scan: ScanResult } {
  const root = fs.realpathSync(fileTempDir(`treemap-offloadNested-${label}-`));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const a = path.join(proj, 'a.txt');
  const b = path.join(proj, 'b.txt');
  fs.writeFileSync(a, Buffer.alloc(1000, 1));
  fs.writeFileSync(b, Buffer.alloc(1000, 2));
  const scan = createScanRecord(root);
  scan.status = 'complete';
  const file = (p: string): { name: string; path: string; size: number; type: 'file'; modifiedAt: number; isHidden: boolean } =>
    ({ name: path.basename(p), path: p, size: 1000, type: 'file', modifiedAt: Date.now(), isHidden: false });
  scan.root = {
    name: path.basename(root), path: root, size: 2000, type: 'dir', modifiedAt: Date.now(), isHidden: false,
    children: [{ name: 'proj', path: proj, size: 2000, type: 'dir', modifiedAt: Date.now(), isHidden: false, children: [file(a), file(b)] }],
  };
  return { root, proj, a, b, scan };
}

async function settled(jobId: string): Promise<OffloadJob> {
  await waitFor(() => getOffloadJob(jobId)?.status !== 'running', `the job ${jobId} settling`);
  return getOffloadJob(jobId) as OffloadJob;
}

test('a folder and a file inside it, both selected, are planned once: the folder\'s files, once each', async () => {
  const { proj, a, b, scan } = project('plan');
  const dest = fileTempDir('treemap-offloadNested-plan-dest-');
  const prepared = await withOpenFileCheck('clear', () => prepareOffload(scan, [a, proj, a, proj], dest));
  assert.deepEqual(prepared.plan.map((c) => c.src).sort(), [a, b], 'each file once');
  assert.equal(prepared.bytesTotal, 2000, 'the folder\'s bytes, not the folder\'s plus the file\'s again');
  assert.deepEqual(prepared.topPaths, [proj], 'what is trashed after verify: the folder alone');
});

test('the offload of a folder and a file inside it ends with no false warning, and records each original once', async () => {
  const { proj, a, b, scan } = project('run');
  const dest = fileTempDir('treemap-offloadNested-run-dest-');
  const before = trashedPaths.length;
  const job = await withOpenFileCheck('clear', async () => {
    const prepared = await prepareOffload(scan, [proj, a], dest);
    return settled((await startOffload(scan, [proj, a], dest, prepared)).jobId);
  });
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.error, undefined, `no original "couldn't be moved to the Trash" (${job.error})`);
  assert.equal(job.fileCount, 2);
  assert.deepEqual(trashedPaths.slice(before), [proj], 'the folder, once');
  const rows = (await getOffloadIndex()).entries.filter((e) => e.originalPath === a || e.originalPath === b);
  assert.deepEqual(rows.map((e) => e.originalPath).sort(), [a, b], 'one record per original');
});

/* ─────────────── the route's dry run ─────────────── */

function post(port: number, url: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
    });
    r.on('error', reject);
    r.end(payload);
  });
}

test('POST /api/offload\'s dry run names the folder alone as what would be trashed, with each file counted once', async () => {
  const { root, proj, a } = project('route');
  const dest = fileTempDir('treemap-offloadNested-route-dest-');
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const started = await post(port, '/api/scan', { path: root });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => peekScan(started.body.scanId)?.status !== 'running', 'the scan settling');
    const dry = await withOpenFileCheck('clear', () => post(port, '/api/offload', { scanId: started.body.scanId, paths: [proj, a], dest, dryRun: true }));
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.fileCount, 2);
    assert.equal(dry.body.bytesTotal, 2000);
    assert.deepEqual(dry.body.wouldTrashAfterVerify, [proj]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

/* ─────────────── the page ─────────────── */

/** A named function declaration from the shipped page, by brace matching. */
function pageFunction(name: string): string {
  const at = INDEX.search(new RegExp(`(async )?function ${name}\\(`));
  assert.notEqual(at, -1, `${name} is in the page`);
  const open = INDEX.indexOf('{', INDEX.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(at, i + 1);
  }
  assert.fail(`${name} does not close`);
}

test('dropping the cart on a drive sends only its outermost items, to the dry run and to the offload', async () => {
  const cart = ['/r/proj', '/r/proj/a.txt', '/r/other.bin', '/r/proj/sub/b.txt'];
  const sent: string[][] = [];
  const offloaded: string[][] = [];
  const el = (): Record<string, unknown> => ({ innerHTML: '', classList: { add: () => undefined } });
  const make = new Function(
    'state', 'api', '$', 'toast', 'icon', 'escapeHtml', 'formatBytes', 'resetOpenHandleWarning', 'refreshDock', 'runOffloadJob', 'activeJob',
    `let onConfirmTrash = null; let offloadPlanSeq = 0;
     ${pageFunction('dockDrop')}
     ${pageFunction('confirmOffloadPlan')}
     ${pageFunction('outermostPaths')}
     ${pageFunction('tmParentPath')}
     return { dockDrop, confirm: () => onConfirmTrash };`,
  );
  const page = make(
    { cart: new Set(cart), scanId: 's1', pathIndex: new Set(cart) },
    async (url: string, opts?: { body?: string }) => {
      if (url === '/api/volumes') return { volumes: [{ path: '/Volumes/X', name: 'X', freeBytes: 1e12 }] };
      sent.push(JSON.parse(opts?.body ?? '{}').paths);
      return { fileCount: 3, bytesTotal: 3 };
    },
    el, () => undefined, () => '', (s: string) => s, (n: number) => String(n), () => undefined, () => undefined,
    async (paths: string[]) => { offloaded.push(paths); },
    null,
  ) as { dockDrop: (vol: string) => Promise<void>; confirm: () => (() => Promise<void>) | null };
  await page.dockDrop('/Volumes/X');
  assert.deepEqual(sent, [['/r/proj', '/r/other.bin']], 'the dry run plans the folder, not the folder and what is in it');
  await page.confirm()?.();
  assert.deepEqual(offloaded, [['/r/proj', '/r/other.bin']], 'and the offload moves the same');
});

test('an offload that completes takes what went with a folder out of the cart too', () => {
  const cart = new Set(['/r/proj', '/r/proj/a.txt', '/r/projX/c.txt', '/r/other.bin']);
  let done: ((ev: unknown) => void) | null = null;
  const make = new Function(
    'state', 'api', 'toast', 'watchOffloadJob', 'saveCart', 'renderCart', 'refreshCartButtons', 'refreshDock', 'loadOffloadIndex', 'rescan',
    `${pageFunction('runOffloadJob')}
     ${pageFunction('tmParentPath')}
     ${pageFunction('tmIsInside')}
     return runOffloadJob;`,
  );
  const runOffloadJob = make(
    { cart, scanId: 's1' }, async () => ({ jobId: 'j1' }), () => undefined,
    (_id: string, _title: string, onComplete: (ev: unknown) => void) => { done = onComplete; },
    () => undefined, () => undefined, () => undefined, () => undefined, () => undefined, () => undefined,
  ) as (paths: string[], dest: string) => Promise<void>;
  return runOffloadJob(['/r/proj'], '/Volumes/X').then(() => {
    assert.ok(done, 'the job is followed');
    (done as unknown as (ev: unknown) => void)({});
    assert.deepEqual([...cart].sort(), ['/r/other.bin', '/r/projX/c.txt'], 'the folder and what was staged inside it leave the cart; a look-alike sibling stays');
  });
});
