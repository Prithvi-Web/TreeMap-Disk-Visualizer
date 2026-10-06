import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
// App-data sits in a scanned home folder, as ~/Library/Application Support/TreeMap does: there the
// scanned-root rule allows a request that names a path in it.
const HOME = fs.realpathSync(isolatedDataDir('treemap-safetyRecords-home-'));
const APP = path.join(HOME, 'Library', 'Application Support', 'TreeMap');
fs.mkdirSync(APP, { recursive: true });
process.env.TREEMAP_DATA_DIR = APP;
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../src/server';
import { buildMcpServer } from '../src/mcp/server';
import { startScan } from '../src/services/diskScanner';
import { moveToTrash, setTrashStepForTests } from '../src/services/cleaner';
import { normalizePolicy, simulatePolicy } from '../src/services/autopilot';
import { protectAndTrash } from '../src/services/timeCapsule';
import { relocateSecret } from '../src/services/securityHygieneScanner';
import { POLICY_FILE } from '../src/services/policy';
import { auditFilePath } from '../src/services/audit';
import { SAFETY_RECORD_NAMES } from '../src/utils/pathSanitizer';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { AppError } from '../src/middleware/errorHandler';
import { updateSettings } from '../src/services/settings';
import { waitFor } from './fixtures/waitFor';

/**
 * TreeMap's agent policy (agent-policy.json) and its audit log (audit.jsonl) are not removed or
 * moved through TreeMap (the final review, F1.11, F1.20). The policy is deliberately not writable
 * through the API, and an ABSENT policy means "no restrictions" — so a delete of the file, which any
 * scan of the home folder allowed, lifted every rail, and the next call ran unrestricted; a delete
 * of the audit log erased the record of it. Every door that removes or moves a file the request names
 * refuses either one, and any folder that holds them (app-data, a folder above it), 403
 * SAFETY_RECORD, by any spelling — dry runs too; Autopilot leaves them alone and says so. Every other
 * file in app-data is deleted as before.
 *
 * Nothing reaches the Trash: the step is replaced for the whole file.
 */

const POLICY = path.join(APP, POLICY_FILE);
const AUDIT = path.join(APP, 'audit.jsonl');
const KEPT = path.join(APP, 'kept.json');
fs.writeFileSync(POLICY, JSON.stringify({ protectedPaths: [path.join(HOME, 'nothing-here')] }));
fs.writeFileSync(AUDIT, '');
fs.writeFileSync(KEPT, '{"a":1}');
const CASE_FOLDS = fs.existsSync(path.join(APP, 'AGENT-POLICY.JSON'));

let port = 0;
let server: http.Server;
let client: Client;
let scanId = '';
const trashed: string[] = [];

before(async () => {
  setTrashStepForTests(async (p) => {
    trashed.push(p);
    throw new Error(`no test here may trash anything, and ${p} was asked for`);
  });
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  const mcp = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'treemap-safety-records-test', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  await updateSettings({ engine: 'walker' });
  const scan = await startScan(HOME);
  await waitFor(() => scan.status !== 'running', `the scan of ${HOME}`);
  assert.equal(scan.status, 'complete', scan.error);
  scanId = scan.scanId;
});

after(async () => {
  setTrashStepForTests(null);
  await client.close();
  await new Promise<void>((r) => server.close(() => r()));
  assert.deepEqual(trashed, [], 'nothing was trashed');
});

/** A request with a JSON body: its status and code, or its status alone when it has none. */
function send(method: string, url: string, body: unknown): Promise<string> {
  resetRateLimiter();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, path: url, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let code = '';
          try { code = (JSON.parse(buf) as { code?: string }).code ?? ''; } catch { /* not JSON */ }
          resolve(`${res.statusCode}${code ? ` ${code}` : ''}`);
        });
      },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

test('the safety records the rule knows by name are the files the policy and the audit are read from and written to', () => {
  assert.deepEqual([...SAFETY_RECORD_NAMES].sort(), [POLICY_FILE, path.basename(auditFilePath())].sort());
  assert.equal(path.dirname(auditFilePath()), APP);
});

test('a delete of the agent policy, the audit log, app-data or a folder above it is refused, 403 SAFETY_RECORD, by any spelling — while another file in app-data is deleted as before', async () => {
  const targets: Record<string, string> = {
    'agent-policy.json': POLICY,
    'audit.jsonl': AUDIT,
    'app-data itself': APP,
    'Library, a folder above app-data': path.join(HOME, 'Library'),
  };
  if (CASE_FOLDS) targets['AGENT-POLICY.JSON, another case'] = path.join(APP, 'AGENT-POLICY.JSON');
  const answers: Record<string, string> = {};
  for (const [what, p] of Object.entries(targets)) answers[what] = await send('DELETE', '/api/files', { paths: [p], dryRun: true });
  answers['kept.json, another file in app-data'] = await send('DELETE', '/api/files', { paths: [KEPT], dryRun: true });
  const expected = Object.fromEntries(Object.keys(targets).map((what) => [what, '403 SAFETY_RECORD']));
  assert.deepEqual(answers, { ...expected, 'kept.json, another file in app-data': '200' });
});

test('every other door that removes or moves a file refuses them too: the cart, an offload, the MCP tools, and the Trash step itself', async () => {
  const dest = path.join(HOME, 'elsewhere');
  fs.mkdirSync(dest, { recursive: true });
  const mcpTrash = (await client.callTool({ name: 'trash_paths', arguments: { paths: [POLICY], dryRun: true } })) as { content?: { text: string }[] };
  const mcpOffload = (await client.callTool({ name: 'offload', arguments: { scanId, paths: [AUDIT], dest, dryRun: true } })) as { content?: { text: string }[] };
  const refusedBy = async (act: () => Promise<unknown>): Promise<string> => {
    try {
      await act();
      return 'went ahead';
    } catch (err) {
      return err instanceof AppError ? err.code : String(err);
    }
  };
  const backstop = await refusedBy(() => moveToTrash([POLICY]));
  const capsule = await refusedBy(() => protectAndTrash([{ path: AUDIT }], { runId: 'safety-records-test' }));
  assert.deepEqual(
    {
      'POST /api/cart/commit (dry run)': await send('POST', '/api/cart/commit', { paths: [POLICY], dryRun: true }),
      'POST /api/offload (dry run)': await send('POST', '/api/offload', { scanId, paths: [AUDIT], dest, dryRun: true }),
      'MCP trash_paths': /SAFETY_RECORD/.test(mcpTrash.content?.[0]?.text ?? ''),
      'MCP offload': /SAFETY_RECORD/.test(mcpOffload.content?.[0]?.text ?? ''),
      'moveToTrash, the backstop': backstop,
      'the Time Capsule (cart, Autopilot), its backstop': capsule,
    },
    {
      'POST /api/cart/commit (dry run)': '403 SAFETY_RECORD',
      'POST /api/offload (dry run)': '403 SAFETY_RECORD',
      'MCP trash_paths': true,
      'MCP offload': true,
      'moveToTrash, the backstop': 'SAFETY_RECORD',
      'the Time Capsule (cart, Autopilot), its backstop': 'SAFETY_RECORD',
    },
  );
});

test('Autopilot leaves the agent policy and the audit log alone, and says so; another file it matches in app-data is still a candidate', async () => {
  const policy = normalizePolicy({ name: 'json in app-data', path: APP, match: { kind: 'custom', exts: ['json', 'jsonl'], minBytes: 0 }, enabled: true });
  const result = await simulatePolicy(policy);
  const wouldDelete = result.items.map((i) => i.path);
  assert.deepEqual(
    {
      'agent-policy.json would be deleted': wouldDelete.includes(POLICY),
      'audit.jsonl would be deleted': wouldDelete.includes(AUDIT),
      'kept.json would be deleted': wouldDelete.includes(KEPT),
      'what it left alone, and why': result.skipped.filter((s) => /agent policy and its audit log/.test(s.reason)).map((s) => s.path).sort(),
    },
    {
      'agent-policy.json would be deleted': false,
      'audit.jsonl would be deleted': false,
      'kept.json would be deleted': true,
      'what it left alone, and why': [POLICY, AUDIT].sort(),
    },
  );
});

test('a relocation of the agent policy out of app-data is refused, and the file stays where it is', async () => {
  const moved = path.join(HOME, 'moved-policy.json');
  assert.equal(await send('POST', '/api/security/relocate', { path: POLICY, to: moved, confirm: true }), '403 SAFETY_RECORD');
  // The service's own check, for a caller that skipped the route's.
  await assert.rejects(relocateSecret(POLICY, moved), /agent policy or its audit log/);
  assert.deepEqual([fs.existsSync(POLICY), fs.existsSync(moved)], [true, false]);
});
