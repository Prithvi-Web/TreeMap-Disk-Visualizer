import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-offloadSameVolume-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { createScanRecord, peekScan } from '../src/services/diskScanner';
import * as offload from '../src/services/offload';
import { prepareOffload } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import { readAudit } from '../src/services/audit';
import { AppError } from '../src/middleware/errorHandler';
import type { ScanResult } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * An offload to a folder on the drive the files already live on frees nothing (fourth browser pass,
 * E01): every copy lands on that same drive, and the originals go to that same drive's Trash — the
 * space is used twice until the Trash is emptied, and the person was promised room. The picker opened
 * on the home folder, so the obvious press did exactly that. The server refuses it, by the device each
 * end really is on, with its own code — a dry run as surely as a real run.
 *
 * Every folder here is in the runner's temp folder, so source and destination share a drive for real:
 * the refusal is driven against the disk, never a stand-in. Nothing reaches the machine's Trash.
 */

const FAKE_TRASH = fileTempDir('treemap-offloadSameVolume-trash-');
const trashed: string[] = [];

before(() => {
  setTrashStepForTests(async (p) => {
    trashed.push(p);
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashed.length}-${path.basename(p)}`));
  });
});
after(() => {
  setTrashStepForTests(null);
});

/** The device seam, which the fix adds; undefined before it. */
type DeviceOf = (p: string, end: 'source' | 'destination') => Promise<bigint | null>;
const setDevice = (offload as unknown as { setOffloadDeviceForTests?: (fn: DeviceOf | null) => () => void }).setOffloadDeviceForTests;

/** proj/ holding a.txt (1,000 bytes) under a fresh root, a complete scan listing it, and an empty destination beside it. */
function project(label: string): { root: string; proj: string; a: string; dest: string; scan: ScanResult } {
  const root = fs.realpathSync(fileTempDir(`treemap-offloadSameVolume-${label}-`));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const a = path.join(proj, 'a.txt');
  fs.writeFileSync(a, Buffer.alloc(1000, 1));
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = {
    name: path.basename(root), path: root, size: 1000, type: 'dir', modifiedAt: Date.now(), isHidden: false,
    children: [{
      name: 'proj', path: proj, size: 1000, type: 'dir', modifiedAt: Date.now(), isHidden: false,
      children: [{ name: 'a.txt', path: a, size: 1000, type: 'file', modifiedAt: Date.now(), isHidden: false }],
    }],
  };
  const dest = fs.realpathSync(fileTempDir(`treemap-offloadSameVolume-${label}-dest-`));
  return { root, proj, a, dest, scan };
}

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

test('control: the source and the destination here really are on one drive', () => {
  const { a, dest } = project('control');
  assert.equal(fs.statSync(a, { bigint: true }).dev, fs.statSync(dest, { bigint: true }).dev,
    'the runner\'s temp folder is one drive — the refusal below is the real one');
});

test('POST /api/offload refuses a destination on the drive the files are on — DEST_SAME_VOLUME, a dry run and a real run alike, audited, and nothing copied or trashed (E01)', async () => {
  const { root, proj, a, dest } = project('route');
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const started = await post(port, '/api/scan', { path: root });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => peekScan(started.body.scanId)?.status !== 'running', 'the scan settling');
    for (const dryRun of [true, false]) {
      const before = trashed.length;
      const r = await withOpenFileCheck('clear', () => post(port, '/api/offload', { scanId: started.body.scanId, paths: [proj], dest, dryRun }));
      assert.equal(r.status, 400, `dryRun ${dryRun}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'DEST_SAME_VOLUME', `dryRun ${dryRun}: refused by its own code`);
      assert.match(r.body.error, /same drive/, 'the refusal says why in words');
      assert.match(r.body.error, /frees? nothing/, 'and what it would have cost');
      assert.match(r.body.error, /another drive/, 'and what to do instead');
      assert.deepEqual(fs.readdirSync(dest), [], `dryRun ${dryRun}: nothing was copied`);
      assert.ok(fs.existsSync(a), `dryRun ${dryRun}: the original is where it was`);
      assert.equal(trashed.length, before, `dryRun ${dryRun}: nothing went to the Trash`);
      const [last] = await readAudit(1);
      assert.ok(last, `dryRun ${dryRun}: the refusal is in the audit log`);
      assert.deepEqual({ action: last.action, outcome: last.outcome, code: last.code, dryRun: last.dryRun },
        { action: 'offload.start', outcome: 'refused', code: 'DEST_SAME_VOLUME', dryRun }, `dryRun ${dryRun}: the refusal is in the audit log`);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('the devices compared are the destination\'s and each selected item\'s — the same device refuses, another plans, and a device that cannot be read refuses nothing (E01)', async () => {
  assert.equal(typeof setDevice, 'function', 'offload.ts exposes setOffloadDeviceForTests');
  const { proj, dest, scan } = project('seam');
  const asked: Array<[string, string]> = [];
  const devices = { source: 1n as bigint | null, destination: 1n as bigint | null };
  const restore = setDevice!(async (p, end) => { asked.push([p, end]); return devices[end]; });
  try {
    await assert.rejects(withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest)),
      (e: unknown) => e instanceof AppError && e.code === 'DEST_SAME_VOLUME' && e.status === 400);
    assert.deepEqual(asked, [[dest, 'destination'], [proj, 'source']], 'the destination folder and the selected folder, each asked once');

    /** The plan's file count, or the assertion `said`, naming the refusal it met. */
    const plans = async (said: string): Promise<number> => {
      try {
        return (await withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest))).plan.length;
      } catch (e) {
        return assert.fail(`${said} — refused: ${(e as Error).message}`);
      }
    };
    devices.destination = 2n;
    assert.equal(await plans('a destination on another drive is planned'), 1);

    devices.destination = 1n;
    devices.source = null;
    assert.equal(await plans('a source whose drive cannot be read is not called the same drive'), 1);

    devices.source = 1n;
    devices.destination = null;
    assert.equal(await plans('nor is a destination whose drive cannot be read'), 1);
  } finally {
    restore();
  }
  await assert.rejects(withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest)),
    (e: unknown) => e instanceof AppError && e.code === 'DEST_SAME_VOLUME', 'with the seam removed, the real devices answer again');
});

test('the refusal is declared where an agent reads: the OpenAPI document\'s 400 for POST /api/offload, AGENTS.md, and the MCP offload tool (E01)', async () => {
  const { buildOpenApiDocument } = await import('../src/api/openapi');
  const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { responses: Record<string, { description?: string }> }>> };
  assert.match(String(doc.paths['/api/offload'].post.responses['400'].description), /DEST_SAME_VOLUME[^;]*same drive/, 'the document names the code and says what it means');
  const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
  assert.match(agents, /`400 DEST_SAME_VOLUME`/, 'AGENTS.md names the code');
  const mcp = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'server.ts'), 'utf8');
  assert.match(mcp.slice(mcp.indexOf("'offload',"), mcp.indexOf("'offload',") + 3000), /same drive/, 'the MCP offload tool tells an agent before it asks');
});
