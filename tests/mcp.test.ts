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

test('handshake lists exactly the ten documented tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'cleanup_suggestions',
    'compare_scans',
    'find_duplicates',
    'forecast',
    'get_largest',
    'missing_gigabytes', // v4 §5 — §6's MCP parity for the accounting statement
    'offload',
    'reclaim_ranked', // v4 §3 — §6's MCP parity for the Reclaim Score
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

/* ══════════════════ reclaim_ranked (v4 §3, §6 MCP parity) ══════════════════ */

test('reclaim_ranked ranks by safety rather than size, and shows its working', async () => {
  const r = await call('reclaim_ranked', { scanId, kind: 'folders', minSizeBytes: 0, limit: 20 });
  assert.ok(!r.isError, JSON.stringify(r.content));
  const s = r.structuredContent!;

  assert.ok(Array.isArray(s.entries) && s.entries.length > 0, 'the fixture has scorable folders');
  // Stated coverage, not implied: this ranked the largest N, not the disk.
  assert.equal(typeof s.examined, 'number');
  assert.equal(typeof s.scored, 'number');
  assert.equal(s.notScored, s.examined - s.scored);
  assert.match(String(s.note), /never select/i, 'the note must say the ranking is not a selection');

  for (const e of s.entries) {
    assert.equal(typeof e.score, 'number');
    assert.ok(e.score >= 0 && e.score <= 100);
    assert.ok(['high', 'medium', 'low'].includes(e.confidence));
    assert.ok(Array.isArray(e.why) && e.why.length > 0, `${e.path} scored with no reasoning`);
    for (const w of e.why) assert.ok(String(w.because).trim().length > 8, `${e.path}/${w.component}: "${w.because}"`);
    // §3.2: a component that could not be computed is named, never zeroed.
    assert.ok(Array.isArray(e.couldNotCompute));
    for (const m of e.couldNotCompute) assert.ok(String(m.because).trim().length > 8);
    const overlap = e.why.map((w: any) => w.component)
      .filter((c: string) => e.couldNotCompute.some((m: any) => m.component === c));
    assert.deepEqual(overlap, [], 'a component is either answered or missing, never both');
  }

  // Sorted by score, descending — the whole point of the tool.
  const scores = s.entries.map((e: any) => e.score);
  assert.deepEqual(scores, [...scores].sort((a: number, b: number) => b - a));

  // node_modules is regenerable, so it must beat the plain `sub` folder.
  const nm = s.entries.find((e: any) => e.path.endsWith('node_modules'));
  const sub = s.entries.find((e: any) => e.path.endsWith(`${path.sep}sub`));
  assert.ok(nm, `node_modules must be ranked; got ${JSON.stringify(s.entries.map((e: any) => e.path))}`);
  if (sub) assert.ok(nm.score > sub.score, `node_modules ${nm.score} vs sub ${sub.score}`);
});

test('reclaim_ranked is inert: it selects nothing and removes nothing', async () => {
  const before = fs.readdirSync(fixtureRoot).sort();
  const r = await call('reclaim_ranked', { scanId, minSizeBytes: 0, limit: 50 });
  assert.ok(!r.isError);
  assert.deepEqual(fs.readdirSync(fixtureRoot).sort(), before);
  // Nothing in the payload marks anything as chosen — §3.2 forbids the score
  // auto-selecting anywhere, and an agent reading a `selected` flag would act
  // on it.
  const body = JSON.stringify(r.structuredContent);
  for (const word of ['"selected"', '"staged"', '"delete"', '"recommended"']) {
    assert.ok(!body.includes(word), `reclaim_ranked must not imply a choice (${word})`);
  }
});

test('reclaim_ranked filters by minScore and pages stably', async () => {
  const all = await call('reclaim_ranked', { scanId, minSizeBytes: 0, limit: 100 });
  const high = await call('reclaim_ranked', { scanId, minSizeBytes: 0, limit: 100, minScore: 99 });
  assert.ok(!all.isError && !high.isError);
  assert.ok(high.structuredContent!.entries.length <= all.structuredContent!.entries.length);
  for (const e of high.structuredContent!.entries) assert.ok(e.score >= 99);

  // The same call twice must give the same order, or an agent paging through
  // it sees entries swap places and never reads some of them.
  const again = await call('reclaim_ranked', { scanId, minSizeBytes: 0, limit: 100 });
  assert.deepEqual(
    again.structuredContent!.entries.map((e: any) => e.path),
    all.structuredContent!.entries.map((e: any) => e.path),
  );
});

/* ══════════════ missing_gigabytes (v4 §5, §6 MCP parity) ══════════════ */

test('missing_gigabytes balances: the lines sum to the volume total, exactly', async () => {
  const r = await call('missing_gigabytes', { scanId });
  assert.ok(!r.isError, JSON.stringify(r.content));
  const s = r.structuredContent!;
  const sum = (s.lines as { bytes: number | null }[]).reduce((a, l) => a + (l.bytes ?? 0), 0);
  assert.equal(sum, s.volume.usedBytes, 'an agent must be able to check the arithmetic itself');
  assert.equal(
    s.lines.find((l: { id: string }) => l.id === 'unaccounted').bytes,
    s.unaccountedBytes,
  );
});

test('missing_gigabytes keeps unknown and zero apart, which is the whole point', async () => {
  const r = await call('missing_gigabytes', { scanId });
  const s = r.structuredContent!;
  for (const line of s.lines as { id: string; bytes: number | null; available: boolean; reason?: string }[]) {
    if (line.bytes === null) {
      // An agent that reads null as 0 concludes a disk has no snapshots when
      // the truth is that nothing would size them. So a null always explains.
      assert.equal(line.available, false, `${line.id}: unknown bytes must not claim to be available`);
      assert.ok(line.reason && line.reason.length > 10, `${line.id}: an unknown must carry its reason`);
    } else {
      assert.equal(typeof line.bytes, 'number');
    }
  }
  // And the residual names every unknown that is hiding inside it.
  const residual = s.lines.find((l: { id: string }) => l.id === 'unaccounted');
  for (const line of s.lines as { bytes: number | null; label: string; id: string }[]) {
    if (line.bytes === null) assert.ok(residual.detail.includes(line.label), `${line.id} must be named in the residual`);
  }
});

test('missing_gigabytes is inert, and offers no action of its own', async () => {
  const before = fs.readdirSync(fixtureRoot).sort();
  const r = await call('missing_gigabytes', { scanId });
  assert.ok(!r.isError);
  assert.deepEqual(fs.readdirSync(fixtureRoot).sort(), before);
  // The remedies the HTTP view links to are separately gated endpoints. This
  // tool must not read as if it can take them.
  const body = JSON.stringify(r.structuredContent);
  for (const word of ['"deleted"', '"purged"', '"freed"']) {
    assert.ok(!body.includes(word), `missing_gigabytes must not imply it acted (${word})`);
  }
});

test('missing_gigabytes refuses an unknown scan rather than answering emptily', async () => {
  const r = await call('missing_gigabytes', { scanId: 'no-such-scan' });
  assert.ok(r.isError);
  assert.match(r.content![0].text, /SCAN_NOT_FOUND/);
});

test('reclaim_ranked refuses an unknown scan rather than answering emptily', async () => {
  const r = await call('reclaim_ranked', { scanId: 'no-such-scan' });
  assert.ok(r.isError);
  assert.match(r.content![0].text, /SCAN_NOT_FOUND/);
});
