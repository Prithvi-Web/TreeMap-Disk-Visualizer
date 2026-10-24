import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-compareUnlisted-data-');
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { compareTrees, createScanRecord, getScan, peekScan, startScan } from '../src/services/diskScanner';
import { buildStoreFromTree, Flag, storeOf } from '../src/services/scanStore';
import { markLeftOutByRule, markUnlisted } from '../src/services/scanRefusals';
import { updateSettings } from '../src/services/settings';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { buildMcpServer } from '../src/mcp/server';
import type { FileNode, ScanResult } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';

/**
 * Compare and MCP `compare_scans` never call a file removed (or added) because one of the scans could
 * not list its folder (hunt C47). `compareTrees` emitted every child missing on one side as removed or
 * added, and never read `Flag.Unlisted` — the mark of a folder a scan was refused, could not read, did
 * not enter, or listed with entries left out. One scan with Full Disk Access and one without (the
 * window and a browser-run server differ), or a mount that stopped answering, listed everything in
 * ~/Library/Mail as removed and offered "Check snapshots" for it. Now a child absent from a folder one
 * of the scans did not list in full is left out — it is not known to be gone or new — and the answer
 * counts such folders (`unlistedFolders`), which the card and the tool say.
 */

/** A complete scan of `root` holding `tree` (relative path → bytes, a trailing / for a folder). */
function scanOf(root: string, tree: Record<string, number>, unlisted: string[] = []): ScanResult {
  const node = (p: string, isDir: boolean, size: number): FileNode => ({ name: path.basename(p), path: p, size, type: isDir ? 'dir' : 'file', modifiedAt: 1, isHidden: false, ...(isDir ? { children: [] } : {}) });
  const top = node(root, true, 0);
  const byPath = new Map<string, FileNode>([[root, top]]);
  for (const [rel, size] of Object.entries(tree)) {
    const isDir = rel.endsWith('/');
    const p = path.join(root, rel.replace(/\/$/, ''));
    const n = node(p, isDir, isDir ? 0 : size);
    byPath.set(p, n);
    (byPath.get(path.dirname(p)) as FileNode).children?.push(n);
  }
  const sum = (n: FileNode): number => (n.type === 'dir' ? (n.size = (n.children ?? []).reduce((s, c) => s + sum(c), 0)) : n.size);
  sum(top);
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = top;
  const store = buildStoreFromTree(top); // kept on the scan, so the flags set below are the ones compared
  scan.store = store;
  for (const rel of unlisted) store.setFlag(store.findByPath(path.join(root, rel)), Flag.Unlisted, true);
  return scan;
}

const ROOT = path.join(path.sep, 'cmp-root');
const MAIL = { 'Mail/': 0, 'Mail/msg-0.emlx': 4000, 'Mail/msg-1.emlx': 4000, 'Mail/msg-2.emlx': 4000 };
/** Each entry as "<path under the root, with / between names> <change>", whatever this system's separator. */
const rows = (r: { entries: { path: string; change: string }[] }): string[] =>
  r.entries.map((e) => `${path.relative(ROOT, e.path).split(path.sep).join('/')} ${e.change}`).sort();

test('files in a folder the newer scan could not list are not called removed, and the folder is counted', () => {
  const a = scanOf(ROOT, { ...MAIL, 'other.txt': 1 });
  const b = scanOf(ROOT, { 'Mail/': 0, 'other.txt': 5 }, ['Mail']);
  const r = compareTrees(storeOf(a), storeOf(b));
  assert.deepEqual(rows(r), ['other.txt grew'], 'only what both scans could see is compared');
  assert.equal(r.unlistedFolders, 1, 'the folder one scan could not list is counted');
});

test('the other way round, files in a folder the older scan could not list are not called added', () => {
  const a = scanOf(ROOT, { 'Mail/': 0, 'other.txt': 1 }, ['Mail']);
  const b = scanOf(ROOT, { ...MAIL, 'other.txt': 1 });
  const r = compareTrees(storeOf(a), storeOf(b));
  assert.deepEqual(rows(r), []);
  assert.equal(r.unlistedFolders, 1);
});

test('in a folder listed only in part, what both scans list is still compared', () => {
  const a = scanOf(ROOT, MAIL);
  const b = scanOf(ROOT, { 'Mail/': 0, 'Mail/msg-0.emlx': 9000 }, ['Mail']); // msg-1 and msg-2 left out of its listing
  const r = compareTrees(storeOf(a), storeOf(b));
  assert.deepEqual(rows(r), ['Mail/msg-0.emlx grew']);
  assert.equal(r.unlistedFolders, 1);
});

test('two scans that listed everything compare as before, with nothing counted', () => {
  const r = compareTrees(storeOf(scanOf(ROOT, { ...MAIL, 'other.txt': 1 })), storeOf(scanOf(ROOT, { 'Mail/': 0, 'other.txt': 1 })));
  assert.deepEqual(rows(r), ['Mail/msg-0.emlx removed', 'Mail/msg-1.emlx removed', 'Mail/msg-2.emlx removed']);
  assert.equal(r.unlistedFolders, 0);
});

test('a folder that left out only what a "Don\'t scan" rule matched is compared whole, unless a read failed in it too (review F1.3)', () => {
  // Both scans ran under the same rules: what one of them left out by rule, the other did too.
  const ruled = (tree: Record<string, number>, alsoUnread: false | 'after' | 'before' = false): ScanResult => {
    const scan = scanOf(ROOT, tree);
    const store = storeOf(scan);
    const proj = store.findByPath(path.join(ROOT, 'proj'));
    if (alsoUnread === 'before') markUnlisted(store, proj); // a read failure already marked, then the rule
    markLeftOutByRule(store, proj);
    if (alsoUnread === 'after') markUnlisted(store, proj); // an entry whose stat failed, after the rule
    return scan;
  };
  const before = { 'proj/': 0, 'proj/a.txt': 1000, 'proj/b.txt': 3000 };
  const now = { 'proj/': 0, 'proj/a.txt': 1000, 'proj/c.txt': 2000 };
  const whole = compareTrees(storeOf(ruled(before)), storeOf(ruled(now)));
  assert.deepEqual(rows(whole), ['proj/b.txt removed', 'proj/c.txt added']);
  assert.equal(whole.unlistedFolders, 0, 'nothing in it is unknown');
  for (const order of ['after', 'before'] as const) {
    const unread = compareTrees(storeOf(ruled(before)), storeOf(ruled(now, order)));
    assert.deepEqual(rows(unread), ['proj/c.txt added'], `${order}: a read failure in the newer scan leaves b.txt unknown; c.txt is new to an older listing that held all the rest`);
    assert.equal(unread.unlistedFolders, 1);
  }
  const store = storeOf(ruled(now));
  assert.equal(store.flag(store.findByPath(path.join(ROOT, 'proj')), Flag.Unlisted), true, 'still never offered as empty: what the rule left out is in it');
});

test('two real scans under a "Don\'t scan" rule: a file deleted beside the rule\'s match is removed, one made there is added (review F1.13)', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-compareUnlisted-rule-'));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(proj, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'node_modules', 'x.js'), 'x');
  fs.writeFileSync(path.join(proj, 'keep.txt'), Buffer.alloc(1000));
  fs.mkdirSync(path.join(proj, 'dist'));
  fs.writeFileSync(path.join(proj, 'dist', 'big.bin'), Buffer.alloc(3000));
  await updateSettings({ ignore: [{ pattern: 'node_modules', scope: 'scan' }] });
  try {
    const a = await scanToEnd(root);
    fs.rmSync(path.join(proj, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'fresh.txt'), Buffer.alloc(2000));
    const b = await scanToEnd(root);
    const r = compareTrees(storeOf(a), storeOf(b));
    const at = (e: { path: string; change: string }): string => `${path.relative(root, e.path).split(path.sep).join('/')} ${e.change}`;
    assert.deepEqual(r.entries.map(at).sort(), ['proj/dist removed', 'proj/fresh.txt added']);
    assert.equal(r.unlistedFolders, 0);
  } finally {
    await updateSettings({ ignore: [] });
  }
});

/* ---------- a folder the operating system refuses, over HTTP and MCP ---------- */

const refusable = process.platform !== 'win32' && process.getuid?.() !== 0;
let client: Client;
before(async () => {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'treemap-compareUnlisted-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});
after(async () => { await client.close(); });

async function scanToEnd(root: string): Promise<ScanResult> {
  const started = await startScan(root, {});
  await waitFor(() => peekScan(started.scanId)?.status !== 'running', 'the scan settling');
  return getScan(started.scanId) as ScanResult;
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    return await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: url }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => resolve(JSON.parse(buf)));
      }).on('error', reject);
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('a folder the system refused on the second scan: /api/compare and compare_scans list none of its files as removed, and say why', { skip: refusable ? false : 'permissions do not stop this user here (Windows ACLs, or root)' }, async () => {
  const root = fs.realpathSync(fileTempDir('treemap-compareUnlisted-real-'));
  const mail = path.join(root, 'Mail');
  fs.mkdirSync(mail);
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(mail, `msg-${i}.emlx`), Buffer.alloc(4000, i));
  fs.writeFileSync(path.join(root, 'other.txt'), 'x');
  const a = await scanToEnd(root);
  fs.chmodSync(mail, 0o000);
  let b: ScanResult;
  try {
    b = await scanToEnd(root);
  } finally {
    fs.chmodSync(mail, 0o755);
  }
  const body = await getJson(`/api/compare?scanIdA=${a.scanId}&scanIdB=${b.scanId}`);
  assert.deepEqual(body.entries, [], `no file in Mail is called removed: ${JSON.stringify(body.entries)}`);
  assert.equal(body.unlistedFolders, 1);
  const reply = (await client.callTool({ name: 'compare_scans', arguments: { scanIdA: a.scanId, scanIdB: b.scanId } })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
  assert.ok(!reply.isError, JSON.stringify(reply));
  const s = reply.structuredContent ?? {};
  assert.deepEqual(s.entries, []);
  assert.equal(s.unlistedFolders, 1);
  assert.match(String(s.unlistedNote), /1 folder one of these scans could not list in full/, String(s.unlistedNote));
});
