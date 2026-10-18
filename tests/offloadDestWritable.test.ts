import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-offloadDestWritable-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { createScanRecord, peekScan } from '../src/services/diskScanner';
import { prepareOffload, setOffloadDeviceForTests } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import { readAudit } from '../src/services/audit';
import { AppError } from '../src/middleware/errorHandler';
import type { ScanResult } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * An offload's dry run refuses a destination it cannot write to (sixth browser pass H02). A sealed,
 * read-only volume answered the dry run 200 and the sheet said "Copy, verify, then trash"; the real
 * run would fail at its first copy. AGENTS.md promises that a dry run that succeeds means the real run
 * would act, so the write check is made where both runs plan: prepareOffload. A dry run and a real run
 * refuse alike, with their own code, before anything is copied.
 *
 * The read-only folder is a folder made read-only with chmod. On Windows a folder's write permission
 * is an ACL that fs.access does not read — it reports every folder writable — so there the check would
 * promise what it cannot know, and is not made (the real run's first copy finds it, and rolls back).
 * Root ignores permission bits, so a run as root skips too. Nothing reaches the machine's Trash.
 */

const WHY_SKIP = process.platform === 'win32'
  ? 'Windows keeps a folder\'s write permission in an ACL fs.access does not read, so the check is not made there'
  : typeof process.getuid === 'function' && process.getuid() === 0
    ? 'root may write into a read-only folder, so chmod cannot make one here'
    : false;

const FAKE_TRASH = fileTempDir('treemap-offloadDestWritable-trash-');
const trashed: string[] = [];
let restoreDevice: () => void = () => {};

before(() => {
  setTrashStepForTests(async (p) => {
    trashed.push(p);
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashed.length}-${path.basename(p)}`));
  });
  // Every folder a test can make is on the runner's one drive; the destination here stands for
  // another drive, so the same-drive refusal (E01) is not the one met.
  restoreDevice = setOffloadDeviceForTests(async (_p, end) => (end === 'source' ? 1n : 2n));
});
after(() => {
  restoreDevice();
  setTrashStepForTests(null);
});

/** proj/ holding a.txt (1,000 bytes) under a fresh root, a complete scan listing it, and an empty destination beside it. */
function project(label: string): { root: string; proj: string; a: string; dest: string; scan: ScanResult } {
  const root = fs.realpathSync(fileTempDir(`treemap-offloadDestWritable-${label}-`));
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
  const dest = fs.realpathSync(fileTempDir(`treemap-offloadDestWritable-${label}-dest-`));
  return { root, proj, a, dest, scan };
}

/** Runs `fn` with `dir` read-only (r-x for everyone), and makes it writable again however `fn` ends. */
async function readOnly<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  fs.chmodSync(dir, 0o555);
  try {
    return await fn();
  } finally {
    fs.chmodSync(dir, 0o755);
  }
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

test('prepareOffload refuses a destination it cannot write to with DEST_NOT_WRITABLE, and plans once it can (H02)', { skip: WHY_SKIP }, async () => {
  const { proj, dest, scan } = project('plan');
  await readOnly(dest, async () => {
    assert.throws(() => fs.writeFileSync(path.join(dest, 'probe'), 'x'), 'control: the folder really is read-only to this process');
    await assert.rejects(withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest)), (e: unknown) => {
      assert.ok(e instanceof AppError, `an AppError, not ${String(e)}`);
      assert.equal(e.code, 'DEST_NOT_WRITABLE', 'refused by its own code');
      assert.equal(e.status, 400);
      assert.match(e.message, new RegExp(`"${path.basename(dest)}" cannot be written to`), 'names the folder');
      assert.match(e.message, /permission to add files/, 'says why, in words');
      assert.match(e.message, /Nothing was copied or deleted\./, 'and that nothing happened');
      return true;
    });
  });
  const plan = await withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest));
  assert.equal(plan.plan.length, 1, 'control: writable again, the same destination plans its one copy');
});

test('POST /api/offload refuses a read-only destination — DEST_NOT_WRITABLE, a dry run and a real run alike, audited, and nothing copied or trashed (H02)', { skip: WHY_SKIP }, async () => {
  const { root, proj, a, dest } = project('route');
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const started = await post(port, '/api/scan', { path: root });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => peekScan(started.body.scanId)?.status !== 'running', 'the scan settling');
    await readOnly(dest, async () => {
      for (const dryRun of [true, false]) {
        const before = trashed.length;
        const r = await withOpenFileCheck('clear', () => post(port, '/api/offload', { scanId: started.body.scanId, paths: [proj], dest, dryRun }));
        assert.equal(r.status, 400, `dryRun ${dryRun}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, 'DEST_NOT_WRITABLE', `dryRun ${dryRun}: refused by its own code`);
        assert.deepEqual(fs.readdirSync(dest), [], `dryRun ${dryRun}: nothing was copied`);
        assert.ok(fs.existsSync(a), `dryRun ${dryRun}: the original is where it was`);
        assert.equal(trashed.length, before, `dryRun ${dryRun}: nothing went to the Trash`);
        const [last] = await readAudit(1);
        assert.deepEqual({ action: last?.action, outcome: last?.outcome, code: last?.code, dryRun: last?.dryRun },
          { action: 'offload.start', outcome: 'refused', code: 'DEST_NOT_WRITABLE', dryRun }, `dryRun ${dryRun}: the refusal is in the audit log`);
      }
    });
    const ok = await withOpenFileCheck('clear', () => post(port, '/api/offload', { scanId: started.body.scanId, paths: [proj], dest, dryRun: true }));
    assert.equal(ok.status, 200, `control: writable again, the dry run plans (${JSON.stringify(ok.body)})`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('the refusal is documented where an agent reads the offload: the OpenAPI document, the MCP tool and AGENTS.md (H02)', async () => {
  const { buildOpenApiDocument } = await import('../src/api/openapi');
  const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>> };
  assert.match(String(doc.paths['/api/offload'].post.responses['400'].description), /DEST_NOT_WRITABLE[^;]*cannot write/,
    'the document names the code and says what it means');
  const mcp = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'server.ts'), 'utf8');
  const tool = mcp.slice(mcp.indexOf("'offload',"), mcp.indexOf('inputSchema', mcp.indexOf("'offload',")));
  assert.match(tool, /DEST_NOT_WRITABLE/, 'the MCP offload tool names the refusal');
  const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
  const offloadSection = agents.slice(agents.indexOf('`POST /api/offload` with `{ scanId, paths, dest }`'), agents.indexOf('`POST /api/cart/commit` with `{ paths }`'));
  assert.match(offloadSection, /`400 DEST_NOT_WRITABLE`/, 'AGENTS.md\'s offload section lists it among its refusals');
  assert.match(offloadSection, /dry run included \(`400 DEST_NOT_WRITABLE`\)/, 'as refused by a dry run too');
  assert.match(offloadSection, /on\s+Windows[^;]*?it is not\s+checked, and the real run's first copy finds it/, 'and says where the check is not made, and what finds it there');
});
