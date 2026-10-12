import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-duplicateMinSize-data-');
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp/server';
import { buildOpenApiDocument } from '../src/api/openapi';
import { createScanRecord } from '../src/services/diskScanner';
import { DEFAULT_DUPLICATE_MIN_SIZE, peekDuplicateJob } from '../src/services/duplicateFinder';
import { PackedScanStore } from '../src/services/scanStore';
import { resetNativeForTests, setNativeLoadOverrideForTests } from '../src/services/scan/native';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { INDEX } from './fixtures/liftFrontend';
import { waitFor } from './fixtures/waitFor';
import type { ScanResult } from '../src/models/types';

/**
 * The smallest file the duplicate finder looks at, when nobody says (the LEFT brief, item 5).
 *
 * Sizes are decimal (QA D09: 1 KB = 1,000 bytes, as Finder counts), and the Duplicates view's
 * smallest choice is "1 KB". GET /api/duplicates and the MCP tool find_duplicates each defaulted
 * to their own 1,024, so an agent that left the figure out was told "1 KB" by the page's units and
 * skipped every file from 1,000 to 1,023 bytes. One constant now holds the default for both, and
 * each says what it is.
 */

const ONE_KB_PAIR = 1_000; // two identical files of exactly 1 KB, decimal
const LARGER_PAIR = 5_000;

let client: Client;

before(async () => {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'treemap-duplicateMinSize-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client.close();
});

/** A completed scan of two pairs of identical files: 1,000 bytes each, and 5,000 bytes each. */
function built(): { scan: ScanResult; dir: string } {
  const dir = fileTempDir('treemap-duplicateMinSize-');
  const files: [string, Buffer][] = [
    ['kb-a.dat', Buffer.alloc(ONE_KB_PAIR, 1)], ['kb-b.dat', Buffer.alloc(ONE_KB_PAIR, 1)],
    ['big-a.dat', Buffer.alloc(LARGER_PAIR, 2)], ['big-b.dat', Buffer.alloc(LARGER_PAIR, 2)],
  ];
  const scan = createScanRecord(dir);
  const store = new PackedScanStore(dir, path.sep, { name: path.basename(dir), isDir: true, size: 0, modifiedAt: 0, isHidden: false });
  for (const [name, bytes] of files) {
    fs.writeFileSync(path.join(dir, name), bytes);
    store.addNode(store.rootId, { name, isDir: false, size: bytes.length, modifiedAt: 1, isHidden: false });
  }
  store.finalize();
  store.sumSizes();
  scan.store = store;
  scan.status = 'complete';
  return { scan, dir };
}

/** A native module that only says every file is local, so no real module decides what is read. */
function standIn(): void {
  resetNativeForTests();
  const mod = { version: () => '0.0.0-test', dataIsLocal: (paths: string[]) => Uint8Array.from(paths.map(() => 1)) };
  setNativeLoadOverrideForTests({ path: '/stand-in/treemap_core.node', expectedVersion: '0.0.0-test', requireModule: () => mod });
}

function get(port: number, url: string): Promise<{ status: number; json: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(buf) }));
    }).on('error', reject);
  });
}

test('GET /api/duplicates with no minSize looks at files from 1 KB = 1,000 bytes, the Duplicates view\'s smallest choice', async () => {
  const { scan, dir } = built();
  standIn();
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const url = `/api/duplicates?scanId=${scan.scanId}`;
    await get(port, url); // starts the job
    await waitFor(() => peekDuplicateJob(scan.scanId)?.status !== 'running', 'the duplicate job finishing');
    const done = await get(port, url);
    assert.equal(done.status, 200, JSON.stringify(done.json));
    const sizes = (done.json.groups as { size: number }[]).map((g) => g.size).sort((a, b) => a - b);
    assert.ok(sizes.includes(LARGER_PAIR), `control: the 5,000-byte pair is found (${sizes.join(', ')})`);
    assert.deepEqual(sizes, [ONE_KB_PAIR, LARGER_PAIR], 'two copies of exactly 1 KB, decimal, are found too');
    assert.equal(done.json.minSize, 1_000, 'and the answer says it looked from 1,000 bytes');
    assert.equal(done.json.minSize, DEFAULT_DUPLICATE_MIN_SIZE, 'the one shared default');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setNativeLoadOverrideForTests(null);
    resetNativeForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the MCP tool find_duplicates defaults to the same 1,000 bytes and says so in its description', async () => {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === 'find_duplicates');
  assert.ok(tool, 'control: find_duplicates is listed');
  const minSize = (tool!.inputSchema.properties as Record<string, { default?: unknown; description?: string }>).minSizeBytes;
  assert.equal(minSize.default, 1_000, 'an agent that leaves minSizeBytes out looks from 1 KB = 1,000 bytes');
  assert.equal(minSize.default, DEFAULT_DUPLICATE_MIN_SIZE, 'the one shared default');
  assert.match(minSize.description ?? '', /default 1,000 bytes = 1 KB/, `the parameter says what it defaults to: ${minSize.description}`);
  assert.match(tool!.description ?? '', /1 KB \(1,000 bytes/, 'and so does the tool\'s own description');
});

test('the OpenAPI document states the shared default for GET /api/duplicates', () => {
  const doc = buildOpenApiDocument() as { paths: Record<string, { get?: { parameters?: { name: string; description?: string }[] } }> };
  const minSize = doc.paths['/api/duplicates']?.get?.parameters?.find((p) => p.name === 'minSize');
  assert.ok(minSize, 'control: the endpoint documents minSize');
  assert.match(minSize!.description ?? '', new RegExp(`\\(default ${DEFAULT_DUPLICATE_MIN_SIZE}\\b`), `it names the default: ${minSize!.description}`);
});

test('the shared default is the size the Duplicates view\'s smallest choice names, read in the decimal units the page prints', () => {
  const select = INDEX.match(/<select id="dupMinSize"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? '';
  const labels = [...select.matchAll(/<option\b[^>]*>([^<]*)<\/option>/g)].map((m) => m[1].trim());
  assert.ok(labels.length >= 2, `control: the view offers choices (${labels.join(', ')})`);
  const DECIMAL: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9 };
  const bytes = labels.map((label) => {
    const m = label.match(/^([\d.]+)\s*(B|KB|MB|GB)$/);
    assert.ok(m, `"${label}" reads as a size`);
    return Number(m![1]) * DECIMAL[m![2]];
  });
  assert.equal(Math.min(...bytes), DEFAULT_DUPLICATE_MIN_SIZE, `the smallest choice, "${labels[bytes.indexOf(Math.min(...bytes))]}", is the default an agent gets`);
});
