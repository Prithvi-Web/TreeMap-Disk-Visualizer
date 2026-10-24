import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-summary-advisory-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { startScan, getScan } from '../src/services/diskScanner';
import { updateSettings } from '../src/services/settings';
import { resetRuleCatalog } from '../src/services/rulePacks';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { buildOpenApiDocument } from '../src/api/openapi';
import { waitFor } from './fixtures/waitFor';

/**
 * Hunt C14: GET /api/agent/summary counted advice-only groups (a VM disk, Windows.old) as
 * reclaimable bytes and listed them without the advisory flag, so an agent could not tell them from
 * groups that may be trashed. Now they are left out of reclaimableBytes and byCategory, as the
 * page leaves them out of every total, reported apart as advisoryBytes, listed with advisory and
 * adviceCommand, and itemCount is every match.
 *
 * The rules come from a pack of this test's own, so the same advice rule exists on every platform.
 */

const PACKS = fileTempDir('treemap-summary-advisory-packs-');
const ROOT = fs.realpathSync(fileTempDir('treemap-summary-advisory-root-'));
const wasPackDir = process.env.TREEMAP_RULEPACK_DIR;
let server: http.Server;
let port = 0;
let scanId = '';

function writePacks(): void {
  const rule = (extra: Record<string, unknown>) => ({ category: 'cache', confidence: 'high', kind: 'directory', ...extra });
  fs.writeFileSync(path.join(PACKS, 'common.json'), JSON.stringify({
    schemaVersion: 1, pack: 'common', updated: '2026-10-20',
    rules: [
      rule({ id: 'test-vm-disk', title: 'Test VM disk', description: 'A virtual machine disk: deleting it destroys the machine.', action: 'advice', adviceCommand: 'vmtool compact', names: ['vmdisk.bundle'] }),
      rule({ id: 'test-scratch', title: 'Test scratch folders', description: 'Scratch folders, safe to remove.', category: 'junk', names: ['scratchdir'] }),
    ],
  }));
  for (const pack of ['macos', 'linux', 'windows']) {
    fs.writeFileSync(path.join(PACKS, `${pack}.json`), JSON.stringify({ schemaVersion: 1, pack, updated: '2026-10-20', rules: [] }));
  }
}

function get(url: string): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  resetRateLimiter();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
    }).on('error', reject);
  });
}

before(async () => {
  writePacks();
  process.env.TREEMAP_RULEPACK_DIR = PACKS;
  resetRuleCatalog();
  fs.mkdirSync(path.join(ROOT, 'vm', 'vmdisk.bundle'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'vm', 'vmdisk.bundle', 'disk.img'), Buffer.alloc(200_000, 1));
  for (let i = 0; i < 201; i++) {
    fs.mkdirSync(path.join(ROOT, `p${i}`, 'scratchdir'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, `p${i}`, 'scratchdir', 'z.bin'), 'z');
  }
  await updateSettings({ engine: 'walker' });
  const s = await startScan(ROOT, {});
  await waitFor(() => getScan(s.scanId)?.status !== 'running', 'the fixture scan');
  assert.equal(getScan(s.scanId)?.status, 'complete', getScan(s.scanId)?.error);
  scanId = s.scanId;
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (wasPackDir === undefined) delete process.env.TREEMAP_RULEPACK_DIR;
  else process.env.TREEMAP_RULEPACK_DIR = wasPackDir;
  resetRuleCatalog();
});

test('advice-only groups are not reclaimable: out of reclaimableBytes and byCategory, counted in advisoryBytes, and flagged in the list', async () => {
  const r = await get(`/api/agent/summary?scanId=${encodeURIComponent(scanId)}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = r.body.cleanup;
  const vm = c.groups.find((g: { id: string }) => g.id === 'test-vm-disk');
  const scratch = c.groups.find((g: { id: string }) => g.id === 'test-scratch');
  assert.ok(vm && scratch, JSON.stringify(c.groups.map((g: { id: string }) => g.id)));
  assert.equal(c.reclaimableBytes, scratch.totalSize, 'only what may be trashed is reclaimable');
  assert.equal(c.advisoryBytes, vm.totalSize, 'the advice-only space is reported apart');
  assert.equal(typeof c.advisoryFormatted, 'string');
  assert.deepEqual(c.byCategory.map((b: { category: string }) => b.category), ['junk'], 'the advice-only cache group adds nothing to byCategory');
  assert.deepEqual([vm.advisory, vm.adviceCommand], [true, 'vmtool compact']);
  assert.equal(scratch.advisory, undefined);
  assert.equal(scratch.itemCount, 201, 'itemCount is every match, past the 200 a group lists');
});

test('the OpenAPI AgentSummary declares what the summary sends', () => {
  const doc = buildOpenApiDocument() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cleanup = doc.components.schemas.AgentSummary.properties.cleanup;
  assert.ok(cleanup.properties.advisoryBytes, 'advisoryBytes is declared');
  assert.match(cleanup.properties.reclaimableBytes.description, /advice/i, 'reclaimableBytes says it leaves advice-only groups out');
  const group = cleanup.properties.groups.items.properties;
  assert.ok(group.advisory && group.adviceCommand, 'each group may carry advisory and adviceCommand');
});
