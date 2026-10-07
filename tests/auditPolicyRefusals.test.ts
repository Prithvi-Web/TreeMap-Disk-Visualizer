import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
const DATA_DIR = isolatedDataDir('treemap-auditPolicyRefusals-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { startScan } from '../src/services/diskScanner';
import { setTrashStepForTests } from '../src/services/cleaner';
import { setMediaTools } from '../src/services/compressionAdvisor';
import { updateSettings } from '../src/services/settings';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { resetIdempotencyCache } from '../src/middleware/idempotency';
import { POLICY_FILE } from '../src/services/policy';

/**
 * GET /api/capabilities says every destructive request refused at its endpoint by the agent policy
 * is in the audit log. POST /api/security/relocate and POST /api/compression/encode checked the
 * policy outside any audited step, so their refusals left no line (the final review, F1.21). Both are
 * now recorded, `refused` with the policy's code, as DELETE /api/files records its own.
 *
 * Nothing is moved, encoded or trashed: both requests are refused, the encoder is a stand-in that
 * fails loudly, and the Trash step is replaced.
 */

const ROOT = fs.realpathSync(fileTempDir('treemap-auditPolicyRefusals-root-'));
const SECRET = path.join(ROOT, 'id_rsa');
const VIDEO = path.join(ROOT, 'clip.mp4');
fs.writeFileSync(SECRET, 'not really a key');
fs.writeFileSync(VIDEO, Buffer.alloc(4096, 1));
fs.mkdirSync(path.join(ROOT, 'safe'));
const POLICY_PATH = path.join(DATA_DIR, POLICY_FILE);

let port = 0;
let server: http.Server;
const acted: string[] = [];

before(async () => {
  setTrashStepForTests(async (p) => {
    acted.push(`trash ${p}`);
    throw new Error(`no test here may trash anything, and ${p} was asked for`);
  });
  setMediaTools({
    async availability() { return { available: true, encoder: 'hevc_videotoolbox', hardwareCodecs: ['hevc'], mechanism: 'stand-in' }; },
    async probe() { return null; },
    async encode(input) { acted.push(`encode ${input}`); throw new Error('no test here may encode anything'); },
  });
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  await updateSettings({ engine: 'walker' });
  const scan = await startScan(ROOT);
  await waitFor(() => scan.status !== 'running', `the scan of ${ROOT}`);
  assert.equal(scan.status, 'complete', scan.error);
  fs.writeFileSync(POLICY_PATH, JSON.stringify({ protectedPaths: [SECRET, VIDEO] }));
});

after(async () => {
  setTrashStepForTests(null);
  setMediaTools(null);
  fs.rmSync(POLICY_PATH, { force: true });
  await new Promise<void>((r) => server.close(() => r()));
  assert.deepEqual(acted, [], 'nothing was moved, encoded or trashed');
});

function request(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  resetRateLimiter();
  resetIdempotencyCache();
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, path: url, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf); } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

/** The newest audit line, as action, outcome and code. */
async function newestAudit(): Promise<string[]> {
  const [line] = (await request('GET', '/api/audit?limit=1')).body.entries as { action: string; outcome: string; code?: string }[];
  return [line?.action, line?.outcome, line?.code ?? ''];
}

test('a relocation the agent policy refuses is in the audit log, refused with the policy\'s code', async () => {
  const answer = await request('POST', '/api/security/relocate', { path: SECRET, to: path.join(ROOT, 'safe', 'id_rsa'), confirm: true });
  assert.deepEqual([answer.status, answer.body.code], [403, 'POLICY_PROTECTED_PATH'], JSON.stringify(answer.body));
  assert.deepEqual(await newestAudit(), ['security.relocate', 'refused', 'POLICY_PROTECTED_PATH']);
  assert.ok(fs.existsSync(SECRET), 'nothing was moved');
});

test('an encode the agent policy refuses is in the audit log, refused with the policy\'s code', async () => {
  const answer = await request('POST', '/api/compression/encode', { paths: [VIDEO], confirm: true });
  assert.deepEqual([answer.status, answer.body.code], [403, 'POLICY_PROTECTED_PATH'], JSON.stringify(answer.body));
  assert.deepEqual(await newestAudit(), ['compression.encode', 'refused', 'POLICY_PROTECTED_PATH']);
});
