import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-storageModeRefusal-data-');
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../src/server';
import { buildMcpServer } from '../src/mcp/server';
import { startScan, scanIdOf } from '../src/services/diskScanner';
import { stopAllWatchers } from '../src/services/watcher';
import { cancelAllDuplicateJobs } from '../src/services/duplicateFinder';
import { cancelAllNearDupeJobs } from '../src/services/perceptualDupes';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { registerFactProvider, unregisterFactProvider } from '../src/services/facts';
import { storageModeGate } from '../src/middleware/storageModeGate';
import type { Request, Response } from 'express';
import {
  FEATURES,
  ROUTE_FEATURES,
  TOOL_FEATURES,
  canBeOff,
  featuresOf,
  refusalSentence,
  setStorageModeForTests,
  storageModeOf,
  type FeatureId,
  type StorageMode,
} from '../src/services/storageMode';
import type { ScanResult } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';

/**
 * Phase 4 T17a (plan §S.7, P4-15): a feature that is off in a scan's storage mode is refused
 * before its handler runs — 409 `{ error, code: 'STORAGE_MODE', mode, feature }` over HTTP,
 * the same code as an MCP tool's error, `available: false` from a fact provider — and the
 * same scan in memory mode reaches the handler exactly as today.
 *
 * Table-driven: every case says which feature it asks for, and whether it is refused in a
 * mode is read from the availability table, never restated here. One scan is put in spill
 * and then aggregate mode through the seam (`setStorageModeForTests(mode, scan)`), and back.
 * The case lists are held to the table: every route and tool whose feature can be off has a
 * case, and every feature a split route can serve has one.
 */

const fixture = fileTempDir('treemap-storageModeRefusal-tree-');
const dest = fileTempDir('treemap-storageModeRefusal-dest-');
function write(rel: string, content: string | Buffer): string {
  const p = path.join(fixture, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
const aFile = write('a.txt', 'same content in two files');
write('b.txt', 'same content in two files');
write('big.bin', Buffer.alloc(4096, 7));
const sub = path.dirname(write('sub/c.txt', 'c'));
write('sub/deep/d.txt', 'dd');
fs.mkdirSync(path.join(fixture, 'empty'));

let server: http.Server;
let port: number;
let client: Client;
let scan: ScanResult;

async function settled(started: ScanResult): Promise<ScanResult> {
  await waitFor(() => started.status !== 'running', 'the fixture scan');
  assert.equal(started.status, 'complete', started.error);
  return started;
}

before(async () => {
  resetRateLimiter();
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  const mcp = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'storage-mode-refusal-test', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  scan = await settled(await startScan(fixture));
});

after(async () => {
  setStorageModeForTests(null);
  stopAllWatchers();
  cancelAllDuplicateJobs();
  cancelAllNearDupeJobs();
  await client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Answer {
  status: number;
  body: any;
}

/**
 * One request; an event stream is answered by its status alone and closed at once. The rate
 * limiter is emptied first: the cases send ~100 requests, and a 429 would say nothing here.
 */
function request(method: string, url: string, body?: unknown): Promise<Answer> {
  resetRateLimiter();
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1', port, path: url, method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        if (String(res.headers['content-type'] ?? '').startsWith('text/event-stream')) {
          resolve({ status: res.statusCode ?? 0, body: null });
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* a CSV, an XLSX or a PDF */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', (err) => ((err as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(err)));
    if (payload) req.write(payload);
    req.end();
  });
}

/** A request, by the route the table classifies it under and the feature it asks for. */
interface RouteCase {
  route: string;
  feature: FeatureId;
  send: () => Promise<Answer>;
}

const q = encodeURIComponent;
const routeCases = (): RouteCase[] => {
  const id = scan.scanId;
  return [
    { route: 'GET /api/scan/:scanId/export', feature: 'reportPdf', send: () => request('GET', `/api/scan/${id}/export?format=pdf`) },
    { route: 'GET /api/scan/:scanId/export', feature: 'folderExport', send: () => request('GET', `/api/scan/${id}/export?format=csv&mode=folders`) },
    { route: 'GET /api/scan/:scanId/export', feature: 'folderExport', send: () => request('GET', `/api/scan/${id}/export?format=xlsx&mode=folders`) },
    { route: 'GET /api/scan/:scanId/export', feature: 'fileExport', send: () => request('GET', `/api/scan/${id}/export?format=csv&mode=files`) },
    { route: 'GET /api/scan/:scanId/export', feature: 'fileExport', send: () => request('GET', `/api/scan/${id}/export?format=xlsx`) },
    { route: 'GET /api/scan/:scanId/export', feature: 'fileExport', send: () => request('GET', `/api/scan/${id}/export`) },
    { route: 'GET /api/scan/:scanId/calendar', feature: 'calendar', send: () => request('GET', `/api/scan/${id}/calendar`) },
    { route: 'GET /api/duplicates', feature: 'duplicates', send: () => request('GET', `/api/duplicates?scanId=${id}`) },
    { route: 'GET /api/near-duplicates', feature: 'nearDuplicates', send: () => request('GET', `/api/near-duplicates?scanId=${id}`) },
    { route: 'GET /api/apps', feature: 'appAttribution', send: () => request('GET', `/api/apps?scanId=${id}`) },
    { route: 'GET /api/empty-folders', feature: 'emptyFolders', send: () => request('GET', `/api/empty-folders?scanId=${id}`) },
    { route: 'GET /api/git/repos', feature: 'git', send: () => request('GET', `/api/git/repos?scanId=${id}`) },
    { route: 'GET /api/packages/orphans', feature: 'packages', send: () => request('GET', `/api/packages/orphans?scanId=${id}`) },
    { route: 'GET /api/games', feature: 'games', send: () => request('GET', `/api/games?scanId=${id}`) },
    { route: 'GET /api/media', feature: 'media', send: () => request('GET', `/api/media?scanId=${id}`) },
    { route: 'GET /api/security/findings', feature: 'security', send: () => request('GET', `/api/security/findings?scanId=${id}`) },
    { route: 'GET /api/compression/candidates', feature: 'compression', send: () => request('GET', `/api/compression/candidates?scanId=${id}`) },
    { route: 'POST /api/container/expand', feature: 'containerExpansion', send: () => request('POST', '/api/container/expand', { scanId: id, path: aFile }) },
    { route: 'GET /api/compare', feature: 'compare', send: () => request('GET', `/api/compare?scanIdA=${id}&scanIdB=${id}`) },
    { route: 'GET /api/cleanup/suggestions', feature: 'cleanupSuggestions', send: () => request('GET', `/api/cleanup/suggestions?scanId=${id}`) },
    { route: 'GET /api/cleanup/browser-profiles', feature: 'browserProfiles', send: () => request('GET', `/api/cleanup/browser-profiles?scanId=${id}`) },
    { route: 'GET /api/cleanup/cloud-safe', feature: 'cloudSafe', send: () => request('GET', `/api/cleanup/cloud-safe?scanId=${id}`) },
    { route: 'GET /api/cleanup/rules', feature: 'customRules', send: () => request('GET', `/api/cleanup/rules?scanId=${id}&minBytes=1`) },
    { route: 'GET /api/cleanup/rules', feature: 'customRulesDup', send: () => request('GET', `/api/cleanup/rules?scanId=${id}&dup=1`) },
    { route: 'GET /api/cleanup/rules', feature: 'customRulesDup', send: () => request('GET', `/api/cleanup/rules?scanId=${id}&minBytes=1&dup=true`) },
    { route: 'GET /api/watch/:scanId', feature: 'liveMode', send: () => request('GET', `/api/watch/${id}`) },
    { route: 'POST /api/offload', feature: 'offload', send: () => request('POST', '/api/offload', { scanId: id, paths: [aFile], dest, dryRun: true }) },
    { route: 'POST /api/offload', feature: 'folderOffload', send: () => request('POST', '/api/offload', { scanId: id, paths: [aFile, sub], dest, dryRun: true }) },
    { route: 'POST /api/cloud/trash', feature: 'cloudTrash', send: () => request('POST', '/api/cloud/trash', { scanId: id, paths: [aFile] }) },
    { route: 'GET /api/agent/summary', feature: 'agentSummary', send: () => request('GET', `/api/agent/summary?scanId=${id}`) },
    { route: 'POST /api/query', feature: 'query', send: () => request('POST', '/api/query', { scanId: id, q: 'size>0' }) },
    // A body scanId the handler reads with String(): a JSON array holding the id finds the scan
    // there (requireScan), so the gate must find it too.
    { route: 'POST /api/offload', feature: 'folderOffload', send: () => request('POST', '/api/offload', { scanId: [id], paths: [sub], dest, dryRun: true }) },
    { route: 'POST /api/cloud/trash', feature: 'cloudTrash', send: () => request('POST', '/api/cloud/trash', { scanId: [id], paths: [aFile] }) },
    { route: 'POST /api/container/expand', feature: 'containerExpansion', send: () => request('POST', '/api/container/expand', { scanId: [[id]], path: aFile }) },
    // Never off: the split must not refuse what it does not serve, and a lookup is never refused.
    { route: 'GET /api/scan/:scanId/subtree', feature: 'tree', send: () => request('GET', `/api/scan/${id}/subtree?path=${q(fixture)}`) },
    { route: 'GET /api/large-files', feature: 'largest', send: () => request('GET', `/api/large-files?scanId=${id}&minSize=0`) },
  ];
};

interface ToolCase {
  tool: string;
  feature: FeatureId;
  args: () => Record<string, unknown>;
}

const toolCases = (): ToolCase[] => [
  { tool: 'find_duplicates', feature: 'duplicates', args: () => ({ scanId: scan.scanId, waitMs: 0 }) },
  { tool: 'cleanup_suggestions', feature: 'cleanupSuggestions', args: () => ({ scanId: scan.scanId }) },
  { tool: 'compare_scans', feature: 'compare', args: () => ({ scanIdA: scan.scanId, scanIdB: scan.scanId }) },
  { tool: 'offload', feature: 'offload', args: () => ({ scanId: scan.scanId, paths: [aFile], dest, dryRun: true, waitMs: 0 }) },
  { tool: 'offload', feature: 'folderOffload', args: () => ({ scanId: scan.scanId, paths: [sub], dest, dryRun: true, waitMs: 0 }) },
  { tool: 'get_largest', feature: 'largest', args: () => ({ scanId: scan.scanId, minSizeBytes: 0 }) },
  { tool: 'scan_path', feature: 'tree', args: () => ({ scanId: scan.scanId, waitMs: 0 }) },
];

interface ToolReply {
  isError?: boolean;
  content?: { type: string; text: string }[];
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolReply> {
  return (await client.callTool({ name, arguments: args })) as ToolReply;
}

const MODES: StorageMode[] = ['memory', 'spill', 'aggregate'];

/**
 * Whether the table's cell says `off`: read from the cell itself, not through `isOff`, so a
 * fault in the code that decides can never move the expectation along with it. The cells are
 * held to §S.7 by tests/storageModeTable.test.ts.
 */
const offIn = (feature: FeatureId, mode: StorageMode): boolean => FEATURES[feature][mode] === 'off';

test('the cases cover every route and tool whose feature can be off, and every feature a split can serve', () => {
  const routes = routeCases();
  for (const [route, entry] of Object.entries(ROUTE_FEATURES)) {
    if (typeof entry !== 'string' && 'refusedIn' in entry) continue; // its run is tested below
    for (const feature of featuresOf(entry)) {
      if (featuresOf(entry).some(canBeOff)) {
        assert.ok(routes.some((c) => c.route === route && c.feature === feature), `a case asks ${route} for ${feature}`);
      }
    }
  }
  for (const c of routes) {
    const entry = ROUTE_FEATURES[c.route];
    assert.ok(entry !== undefined && featuresOf(entry).includes(c.feature), `${c.route} can serve ${c.feature}`);
  }
  const tools = toolCases();
  for (const [tool, entry] of Object.entries(TOOL_FEATURES)) {
    for (const feature of featuresOf(entry)) {
      if (canBeOff(feature)) assert.ok(tools.some((c) => c.tool === tool && c.feature === feature), `a case asks ${tool} for ${feature}`);
    }
  }
});

test('a route refuses exactly the features that are off in the scan\'s mode, and memory mode reaches every handler', async () => {
  try {
    for (const mode of MODES) {
      setStorageModeForTests(mode, scan);
      assert.equal(storageModeOf(scan), mode);
      for (const c of routeCases()) {
        const answer = await c.send();
        const what = `${c.route} asked for ${c.feature} with the scan in ${mode} mode`;
        if (offIn(c.feature, mode)) {
          assert.equal(answer.status, 409, `${what}: refused (${JSON.stringify(answer.body).slice(0, 200)})`);
          assert.deepEqual(answer.body, { error: refusalSentence(c.feature, mode), code: 'STORAGE_MODE', mode, feature: c.feature }, what);
        } else {
          assert.ok(
            !(answer.status === 409 && answer.body?.code === 'STORAGE_MODE'),
            `${what}: reaches its handler (${answer.status} ${JSON.stringify(answer.body).slice(0, 200)})`,
          );
          assert.notEqual(answer.status, 500, `${what}: and is not a server fault (${JSON.stringify(answer.body).slice(0, 200)})`);
        }
      }
    }
  } finally {
    setStorageModeForTests('memory', scan);
  }
});

test('an MCP tool refuses the same way, in its own error shape', async () => {
  try {
    for (const mode of MODES) {
      setStorageModeForTests(mode, scan);
      for (const c of toolCases()) {
        const reply = await callTool(c.tool, c.args());
        const text = reply.content?.[0]?.text ?? '';
        const what = `${c.tool} asked for ${c.feature} with the scan in ${mode} mode`;
        if (offIn(c.feature, mode)) {
          assert.equal(reply.isError, true, `${what}: refused`);
          assert.equal(text, `Error (STORAGE_MODE): ${refusalSentence(c.feature, mode)}`, what);
        } else {
          assert.ok(!text.startsWith('Error (STORAGE_MODE)'), `${what}: reaches its handler (${text.slice(0, 200)})`);
        }
      }
    }
  } finally {
    setStorageModeForTests('memory', scan);
  }
});

test('a fact provider that is off answers unavailable with the sentence, and the others in the request still answer', async () => {
  const ask = (): Promise<Answer> =>
    request('POST', '/api/facts', { scanId: scan.scanId, paths: [fixture, sub], providers: ['humanScale', 'size', 'subtreeCount'] });
  try {
    for (const mode of MODES) {
      setStorageModeForTests(mode, scan);
      const answer = await ask();
      assert.equal(answer.status, 200, `facts answer in ${mode} mode`);
      const { humanScale, size, subtreeCount } = answer.body.providers;
      assert.equal(size.available, true, `size answers in ${mode} mode`);
      assert.equal(subtreeCount.available, true, `subtreeCount answers in ${mode} mode`);
      if (offIn('humanScale', mode)) {
        assert.deepEqual(humanScale, {
          available: false,
          reason: refusalSentence('humanScale', mode),
          stats: { requested: 2, computed: 0, skipped: 2, failed: 0 },
          values: {},
        }, `humanScale in ${mode} mode`);
      } else {
        assert.equal(humanScale.available, true, `humanScale runs in ${mode} mode`);
      }
    }
  } finally {
    setStorageModeForTests('memory', scan);
  }
});

test('a provider the table does not classify costs only its own answer in a large mode, never the request', async () => {
  registerFactProvider<number>({
    id: 't17aUnclassified',
    label: 'A provider no table row names',
    capabilityKey: null,
    compute: async (_scanId, paths) => ({
      available: true,
      values: new Map(paths.map((p) => [p, 1])),
      stats: { requested: paths.length, computed: paths.length, skipped: 0, failed: 0 },
    }),
  });
  try {
    for (const mode of MODES) {
      setStorageModeForTests(mode, scan);
      const answer = await request('POST', '/api/facts', { scanId: scan.scanId, paths: [sub], providers: ['t17aUnclassified', 'size'] });
      assert.equal(answer.status, 200, `facts answer in ${mode} mode (${JSON.stringify(answer.body).slice(0, 200)})`);
      assert.equal(answer.body.providers.size.available, true, `size answers in ${mode} mode`);
      const unclassified = answer.body.providers.t17aUnclassified;
      if (mode === 'memory') {
        assert.equal(unclassified.available, true, 'memory mode runs it');
      } else {
        assert.equal(unclassified.available, false, `${mode} mode refuses it`);
        assert.match(unclassified.reason, new RegExp(`not run on a scan kept in ${mode} mode`));
      }
    }
  } finally {
    setStorageModeForTests('memory', scan);
    unregisterFactProvider('t17aUnclassified');
  }
});

test('Autopilot refuses in its run, once the scan it makes is kept in a mode where it is off', async () => {
  const simulate = (): Promise<Answer> =>
    request('POST', '/api/autopilot/simulate', { policy: { path: fixture, match: { kind: 'custom', minBytes: 1 } } });
  try {
    for (const mode of MODES) {
      setStorageModeForTests(mode);
      const answer = await simulate();
      if (offIn('autopilot', mode)) {
        assert.equal(answer.status, 409, `simulate in ${mode} mode is refused`);
        assert.deepEqual(answer.body, { error: refusalSentence('autopilot', mode), code: 'STORAGE_MODE', mode, feature: 'autopilot' });
      } else {
        assert.equal(answer.status, 200, `simulate in ${mode} mode runs (${JSON.stringify(answer.body).slice(0, 200)})`);
      }
    }
  } finally {
    setStorageModeForTests(null);
  }
});

test('a scan is made in memory mode unless the seam says otherwise, and /stats keeps saying memory', async () => {
  const plain = await settled(await startScan(sub));
  assert.equal(plain.storageMode, 'memory', 'every scan starts in memory mode today');
  setStorageModeForTests('aggregate');
  let labelled: ScanResult;
  try {
    labelled = await settled(await startScan(sub));
  } finally {
    setStorageModeForTests(null);
  }
  assert.equal(labelled.storageMode, 'aggregate', 'a scan made while the seam is set carries its mode');
  const again = await settled(await startScan(sub));
  assert.equal(again.storageMode, 'memory', 'and the seam, cleared, gives memory again');
  const stats = await request('GET', `/api/scan/${labelled.scanId}/stats`);
  assert.equal(stats.body.storageMode, 'memory', '/stats is T23\'s to change; its enum stays memory');
  assert.equal(Object.keys(FEATURES).length > 0, true);
});

test('HEAD is served by the GET route, so the gate refuses it by the GET route\'s feature', async () => {
  try {
    setStorageModeForTests('aggregate', scan);
    const head = await request('HEAD', `/api/duplicates?scanId=${scan.scanId}`);
    assert.equal(head.status, 409, 'HEAD /api/duplicates on an aggregate scan is refused');
    setStorageModeForTests('memory', scan);
    const again = await request('HEAD', `/api/empty-folders?scanId=${scan.scanId}`);
    assert.equal(again.status, 200, 'and in memory mode it reaches the handler');
  } finally {
    setStorageModeForTests('memory', scan);
  }
});

test('the gate passes every memory-mode request before it looks anything up, and fails loudly on a route the table lacks', () => {
  const run = (mode: StorageMode): unknown => {
    setStorageModeForTests(mode, scan);
    let passed: unknown = 'not called';
    const req = {
      method: 'GET', baseUrl: '/api', route: { path: '/not-in-the-table' },
      params: {}, query: { scanId: scan.scanId }, body: {},
    } as unknown as Request;
    storageModeGate(req, {} as Response, (err?: unknown) => { passed = err; });
    return passed;
  };
  try {
    assert.equal(run('memory'), undefined, 'memory mode passes, whatever the table says');
    const err = run('spill');
    assert.ok(err instanceof Error && /GET \/api\/not-in-the-table/.test(err.message), `a large mode names the unclassified route (${String(err)})`);
  } finally {
    setStorageModeForTests('memory', scan);
  }
});

test('a scan id that is no string is read without throwing, whatever the JSON, and memory mode answers as before', async () => {
  // JSON can give an object whose toString is no function, in any depth of lists: String()
  // throws on those; the reading must not, and gives no scan.
  for (const odd of [{ toString: 1 }, [{ toString: 1 }], [[[{ toString: 1 }]]], { toString: 1, valueOf: 1 }]) {
    assert.equal(scanIdOf(odd), '', JSON.stringify(odd));
  }
  // Every value that did not throw reads exactly as String() read it.
  const same: [unknown, string][] = [['abc', 'abc'], [['abc'], 'abc'], [[['abc']], 'abc'], [123, '123'], [true, 'true'], [null, ''], [undefined, ''], [{}, '[object Object]'], [['a', 'b'], 'a,b']];
  for (const [value, want] of same) assert.equal(scanIdOf(value), want, JSON.stringify(value));
  // Over HTTP in memory mode: a body channel the route never reads cannot turn it into a 500.
  const url = `/api/duplicates?scanId=${scan.scanId}`;
  await waitFor(async () => (await request('GET', url)).status === 200, 'duplicate hashing of the fixture');
  const odd = await request('GET', url, { scanId: { toString: 1 } });
  assert.equal(odd.status, 200, `GET /api/duplicates answers as it does without the body (${JSON.stringify(odd.body).slice(0, 160)})`);
  const query = await request('POST', '/api/query', { scanId: { toString: 1 }, q: 'size>0' });
  assert.deepEqual([query.status, query.body.code], [400, 'SCAN_REQUIRED'], 'and POST /api/query refuses the id itself, as it always did');
});

test('the mount prefix is read as Express routes it: /API/duplicates is /api/duplicates', async () => {
  try {
    setStorageModeForTests('spill', scan);
    const refused = await request('GET', `/API/duplicates?scanId=${scan.scanId}`);
    assert.deepEqual([refused.status, refused.body.code], [409, 'STORAGE_MODE'], `refused, not a server fault (${JSON.stringify(refused.body).slice(0, 160)})`);
    setStorageModeForTests('memory', scan);
    const served = await request('GET', `/API/empty-folders?scanId=${scan.scanId}`);
    assert.equal(served.status, 200, 'and in memory mode the handler answers');
  } finally {
    setStorageModeForTests('memory', scan);
  }
});
