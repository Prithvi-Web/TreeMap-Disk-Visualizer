import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-mcp-advisory-data-');
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp/server';
import { startScan, getScan } from '../src/services/diskScanner';
import { setTrashStepForTests } from '../src/services/cleaner';
import { updateSettings } from '../src/services/settings';
import { resetRuleCatalog } from '../src/services/rulePacks';
import { readAudit } from '../src/services/audit';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * Hunt C12/C59: MCP cleanup_suggestions said "Suggested paths can be passed straight to
 * trash_paths" while it served advice-only groups (a VM disk, Windows.old) beside the rest, counted
 * them in "Well-known reclaimable space", and reported the capped list's length as the match count.
 * Now an advisory group is marked as never to be trashed, left out of totalBytes (it has its own
 * advisoryBytes), itemCount is every match, and trash_paths refuses an advisory path — at it, inside
 * it, or holding it — as Autopilot leaves one alone.
 *
 * The rules come from a pack of this test's own (TREEMAP_RULEPACK_DIR), so the same advice rule
 * exists on every platform CI runs.
 */

const PACKS = fileTempDir('treemap-mcp-advisory-packs-');
const ROOT = fs.realpathSync(fileTempDir('treemap-mcp-advisory-root-'));
const BUNDLE = path.join(ROOT, 'vm', 'vmdisk.bundle');
const DISK = path.join(BUNDLE, 'disk.img');
const SCRATCH_A = path.join(ROOT, 'a', 'scratchdir');
const SCRATCH_B = path.join(ROOT, 'b', 'scratchdir');
const trashed: string[] = [];
const wasPackDir = process.env.TREEMAP_RULEPACK_DIR;

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

let client: Client;
let scanId = '';

type Reply = { isError?: boolean; structuredContent?: any; content?: Array<{ text?: string }> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => (await client.callTool({ name, arguments: args })) as Reply;

before(async () => {
  writePacks();
  process.env.TREEMAP_RULEPACK_DIR = PACKS;
  resetRuleCatalog();
  fs.mkdirSync(BUNDLE, { recursive: true });
  fs.writeFileSync(DISK, Buffer.alloc(200_000, 1));
  fs.mkdirSync(SCRATCH_A, { recursive: true });
  fs.writeFileSync(path.join(SCRATCH_A, 'x.bin'), Buffer.alloc(1_000, 2));
  fs.mkdirSync(SCRATCH_B, { recursive: true });
  fs.writeFileSync(path.join(SCRATCH_B, 'y.bin'), Buffer.alloc(2_000, 3));
  setTrashStepForTests(async (p: string) => { trashed.push(p); });
  await updateSettings({ engine: 'walker' });
  const s = await startScan(ROOT, {});
  await waitFor(() => getScan(s.scanId)?.status !== 'running', 'the fixture scan');
  assert.equal(getScan(s.scanId)?.status, 'complete', getScan(s.scanId)?.error);
  scanId = s.scanId;
  const server = buildMcpServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'mcp-advisory', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
});

after(async () => {
  await client.close();
  setTrashStepForTests(null);
  if (wasPackDir === undefined) delete process.env.TREEMAP_RULEPACK_DIR;
  else process.env.TREEMAP_RULEPACK_DIR = wasPackDir;
  resetRuleCatalog();
});

test('the cleanup_suggestions description says advisory groups are never trashed, and never that every suggested path may go to trash_paths', async () => {
  const tools = (await client.listTools()).tools;
  const cleanup = tools.find((t) => t.name === 'cleanup_suggestions')?.description ?? '';
  assert.doesNotMatch(cleanup, /passed straight to\s+trash_paths/, 'the untrue sentence is gone');
  assert.match(cleanup, /advisory: true/);
  assert.match(cleanup, /never/i);
  assert.match(cleanup, /adviceCommand/);
  const trash = tools.find((t) => t.name === 'trash_paths')?.description ?? '';
  assert.match(trash, /advisory/, 'trash_paths says it refuses an advisory group\'s paths');
});

test('an advisory group is marked, left out of totalBytes and counted in advisoryBytes; itemCount is every match', async () => {
  const r = await call('cleanup_suggestions', { scanId, itemsPerGroup: 1 });
  assert.ok(!r.isError, JSON.stringify(r.content));
  const out = r.structuredContent;
  const vm = out.groups.find((g: { id: string }) => g.id === 'test-vm-disk');
  const scratch = out.groups.find((g: { id: string }) => g.id === 'test-scratch');
  assert.ok(vm && scratch, `both groups are listed: ${JSON.stringify(out.groups.map((g: { id: string }) => g.id))}`);
  assert.deepEqual([vm.advisory, vm.adviceCommand], [true, 'vmtool compact']);
  assert.match(vm.note, /never/i, 'the group itself says not to trash it');
  assert.equal(scratch.advisory, undefined);
  assert.ok(vm.totalSize > 0);
  assert.equal(out.totalBytes, scratch.totalSize, 'totalBytes counts only what may be trashed');
  assert.equal(out.advisoryBytes, vm.totalSize, 'the advice-only space is reported apart');
  assert.deepEqual([scratch.itemCount, scratch.items.length, scratch.itemsTruncated], [2, 1, true], 'itemCount is every match, and the list says it was cut');
});

test('trash_paths refuses an advisory path — the group\'s item, a file inside it and a folder holding it — and audits the refusal', async () => {
  await withOpenFileCheck('clear', async () => {
    for (const p of [BUNDLE, DISK, path.join(ROOT, 'vm')]) {
      for (const dryRun of [true, false]) {
        const r = await call('trash_paths', { paths: [p], dryRun });
        assert.equal(r.isError, true, `${p} dryRun=${dryRun}: ${JSON.stringify(r.structuredContent)}`);
        const text = r.content?.[0]?.text ?? '';
        assert.match(text, /ADVISORY_PATH/, text);
        assert.match(text, /vmtool compact/, 'the refusal names the supported way instead');
        const [line] = await readAudit(1);
        assert.ok(line, 'the refusal is audited');
        assert.deepEqual([line.source, line.outcome, line.code], ['mcp', 'refused', 'ADVISORY_PATH']);
      }
    }
    assert.deepEqual(trashed, [], 'nothing reached a Trash step');
    assert.ok(fs.existsSync(DISK));
    const ok = await call('trash_paths', { paths: [SCRATCH_A], dryRun: true });
    assert.ok(!ok.isError, `a path of a group that may be trashed is still dry-run: ${JSON.stringify(ok.content)}`);
  });
});

test('past the 200 items a group lists, itemCount is still every match and itemsTruncated says so', async () => {
  const many = fs.realpathSync(fileTempDir('treemap-mcp-advisory-many-'));
  for (let i = 0; i < 201; i++) {
    fs.mkdirSync(path.join(many, `p${i}`, 'scratchdir'), { recursive: true });
    fs.writeFileSync(path.join(many, `p${i}`, 'scratchdir', 'z.bin'), 'z');
  }
  const s = await startScan(many, {});
  await waitFor(() => getScan(s.scanId)?.status !== 'running', 'the scan of 201 matches');
  assert.equal(getScan(s.scanId)?.status, 'complete', getScan(s.scanId)?.error);
  const r = await call('cleanup_suggestions', { scanId: s.scanId, itemsPerGroup: 200 });
  assert.ok(!r.isError, JSON.stringify(r.content));
  const scratch = r.structuredContent.groups.find((g: { id: string }) => g.id === 'test-scratch');
  assert.deepEqual([scratch.itemCount, scratch.items.length, scratch.itemsTruncated], [201, 200, true]);
});
