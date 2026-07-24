import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate everything the MCP process would persist (snapshots, mtime caches,
// settings) and force the deterministic walker engine before any import can
// observe the environment.
process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-mcp-test-'));
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp/server';
import { formatBytes } from '../src/utils/formatBytes';

/**
 * The MCP server, exercised over a real client↔server handshake (in-memory
 * transport — the same protocol stdio would carry). The bar mirrors the HTTP
 * suites: real answers over a real fixture tree, and destructive tools that
 * provably touch nothing on a dry run.
 */

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-mcp-fixture-'));

function write(rel: string, content: Buffer | string): string {
  const p = path.join(fixtureRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

const BIG = 2 * 1024 * 1024;
const DUP = 512 * 1024;
const bigPath = write('big.bin', Buffer.alloc(BIG, 1));
write('small.txt', 'ten bytes!');
write('sub/mid.bin', Buffer.alloc(1024 * 1024, 2));
write('dup-a.bin', Buffer.alloc(DUP, 3));
write('dup-b.bin', Buffer.alloc(DUP, 3));
write('proj/package.json', '{}');
write('proj/node_modules/dep/index.js', 'module.exports = 1;');

let client: Client;
let scanId: string;

before(async () => {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'treemap-mcp-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client.close();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.rmSync(process.env.TREEMAP_DATA_DIR!, { recursive: true, force: true });
});

interface ToolReply {
  isError?: boolean;
  structuredContent?: Record<string, any>;
  content?: { type: string; text: string }[];
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolReply> {
  return (await client.callTool({ name, arguments: args })) as ToolReply;
}

test('handshake lists exactly the eight documented tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'cleanup_suggestions',
    'compare_scans',
    'find_duplicates',
    'forecast',
    'get_largest',
    'offload',
    'scan_path',
    'trash_paths',
  ]);
});

test('scan_path scans a real tree and reports exact totals', async () => {
  const r = await call('scan_path', { path: fixtureRoot, waitMs: 30_000 });
  assert.ok(!r.isError, JSON.stringify(r.content));
  const s = r.structuredContent!;
  assert.equal(s.status, 'complete');
  assert.equal(s.rootPath, fixtureRoot);
  // big.bin, small.txt, sub/mid.bin, dup-a.bin, dup-b.bin, proj/package.json,
  // proj/node_modules/dep/index.js
  assert.equal(s.fileCount, 7);
  assert.equal(typeof s.totalBytes, 'number');
  assert.ok(s.totalBytes >= BIG + DUP * 2, 'total covers the fixture bytes');
  assert.equal(s.totalFormatted, formatBytes(s.totalBytes));
  assert.ok(Array.isArray(s.topEntries) && s.topEntries.length > 0);
  assert.equal(s.topEntries[0].name, 'big.bin', 'largest top-level entry leads');
  scanId = s.scanId as string;
});

test('get_largest returns files largest-first with raw + formatted sizes', async () => {
  const r = await call('get_largest', { scanId, kind: 'files', limit: 3, minSizeBytes: 0 });
  assert.ok(!r.isError);
  const s = r.structuredContent!;
  assert.equal(s.files[0].name, 'big.bin');
  assert.equal(s.files[0].size, BIG);
  assert.equal(s.files[0].sizeFormatted, '2.0 MB');
  assert.equal(s.count, 3);
});

test('get_largest folders reports recursive sizes', async () => {
  const r = await call('get_largest', { scanId, kind: 'folders', limit: 5, minSizeBytes: 0 });
  assert.ok(!r.isError);
  const s = r.structuredContent!;
  const sub = s.folders.find((f: { name: string }) => f.name === 'sub');
  assert.ok(sub, 'sub folder is ranked');
  assert.equal(sub.size, 1024 * 1024);
  assert.equal(sub.fileCount, 1);
});

test('find_duplicates finds the identical pair and its reclaimable bytes', async () => {
  const r = await call('find_duplicates', { scanId, minSizeBytes: 1, waitMs: 30_000 });
  assert.ok(!r.isError);
  const s = r.structuredContent!;
  assert.equal(s.status, 'complete');
  const dupGroup = s.groups.find((g: { count: number; size: number }) => g.size === DUP);
  assert.ok(dupGroup, 'the 512 KB duplicate pair is reported');
  assert.equal(dupGroup.count, 2);
  assert.equal(dupGroup.reclaimable, DUP);
  assert.equal(dupGroup.reclaimableFormatted, '512.0 KB');
});

test('cleanup_suggestions flags node_modules as regenerable', async () => {
  const r = await call('cleanup_suggestions', { scanId });
  assert.ok(!r.isError);
  const s = r.structuredContent!;
  const nm = s.groups.find((g: { id: string }) => g.id === 'regen-node-modules');
  assert.ok(nm, 'node_modules suggestion present');
  assert.equal(nm.regenerateCmd, 'npm install');
  assert.ok(nm.totalSize > 0);
  assert.equal(nm.totalSizeFormatted, formatBytes(nm.totalSize));
});

test('forecast answers honestly with thin history', async () => {
  const r = await call('forecast', { path: fixtureRoot });
  assert.ok(!r.isError);
  const s = r.structuredContent!;
  assert.equal(s.status, 'insufficient');
  assert.equal(typeof s.reason, 'string');
});

test('compare_scans of two identical scans reports zero drift', async () => {
  const second = await call('scan_path', { path: fixtureRoot, waitMs: 30_000 });
  const secondId = second.structuredContent!.scanId as string;
  const r = await call('compare_scans', { scanIdA: scanId, scanIdB: secondId });
  assert.ok(!r.isError);
  const s = r.structuredContent!;
  assert.equal(s.totalDelta, 0);
  assert.deepEqual(s.entries, []);
  assert.equal(s.truncated, false);
});

test('trash_paths dryRun reports the manifest and provably touches nothing', async () => {
  const r = await call('trash_paths', { paths: [bigPath], dryRun: true });
  assert.ok(!r.isError);
  const s = r.structuredContent!;
  assert.equal(s.dryRun, true);
  assert.equal(s.wouldTrash[0].path, bigPath);
  assert.equal(s.wouldTrash[0].bytes, BIG);
  assert.equal(s.totalKnownBytes, BIG);
  assert.ok(fs.existsSync(bigPath), 'dry run must not move the file');
});

test('trash_paths refuses paths outside every scanned root', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-mcp-outside-'));
  try {
    const victim = path.join(outside, 'x.txt');
    fs.writeFileSync(victim, 'x');
    const r = await call('trash_paths', { paths: [victim], dryRun: false });
    assert.equal(r.isError, true);
    assert.match(r.content![0].text, /OUTSIDE_SCAN_ROOT/);
    assert.ok(fs.existsSync(victim), 'the refused path is untouched');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('offload dryRun returns the exact copy plan and writes nothing', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-mcp-dest-'));
  try {
    const r = await call('offload', { scanId, paths: [bigPath], dest, dryRun: true });
    assert.ok(!r.isError, JSON.stringify(r.content));
    const s = r.structuredContent!;
    assert.equal(s.dryRun, true);
    assert.equal(s.fileCount, 1);
    assert.equal(s.bytesTotal, BIG);
    assert.equal(s.copies[0].src, bigPath);
    assert.equal(fs.readdirSync(dest).length, 0, 'dry run must not copy anything');
    assert.ok(fs.existsSync(bigPath), 'dry run must not trash the source');
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('unknown scanId comes back as a clean, coded error', async () => {
  const r = await call('get_largest', { scanId: 'nope', kind: 'files' });
  assert.equal(r.isError, true);
  assert.match(r.content![0].text, /SCAN_NOT_FOUND/);
});
