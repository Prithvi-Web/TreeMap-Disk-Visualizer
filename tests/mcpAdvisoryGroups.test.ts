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
import { setNote, deleteNote } from '../src/services/notes';
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

test('trash_paths, the rule-pack README and AGENTS.md say a folder holding an advice-only item is refused where a completed scan lists the item inside it, and that a "Don\'t scan" pattern hides it (review F1.3)', async () => {
  // A folder is refused for what it holds only through a completed scan's claims: a scan lists no item a
  // scan-scope "Don't scan" pattern keeps out of it, so that scan claims nothing for the folder holding it.
  const words = (text: string): string => text.replace(/\s+/g, ' ');
  const trash = words((await client.listTools()).tools.find((t) => t.name === 'trash_paths')?.description ?? '');
  const readme = words(fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'rulepacks', 'README.md'), 'utf8'));
  const agents = words(fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8'));
  for (const [name, text] of [['trash_paths', trash], ['the rule-pack README', readme], ['AGENTS.md', agents]] as const) {
    assert.doesNotMatch(text, /(?:any|a) folder holding it(?! that a completed scan)/, `${name} no longer promises every folder holding one`);
    const said = text.match(/a folder (?:holding one )?that a completed scan lists (?:it )?inside/g) ?? [];
    assert.equal(said.length, 2, `${name} says which folders holding one are refused, for a rule covering what its folder holds and for one about its folder itself`);
    assert.match(text, /"Don't scan" pattern keeps out of a scan is not listed by that scan, so that scan refuses no folder for holding it/, `${name} says a "Don't scan" pattern hides an item from it`);
  }
});

test('what those words say is what trash_paths does: a scan-scope "Don\'t scan" pattern on the item leaves the folder holding it unrefused, and a suggest-scope one does not (review HF2-L4)', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-mcp-advisory-holder-'));
  const holder = path.join(root, 'vmfolder');
  const item = path.join(holder, 'vmdisk.bundle');
  fs.mkdirSync(item, { recursive: true });
  fs.writeFileSync(path.join(item, 'disk.img'), Buffer.alloc(4_096, 7));
  fs.writeFileSync(path.join(holder, 'other.txt'), 'x');
  const scanned = async (): Promise<void> => {
    const s = await startScan(root, {});
    await waitFor(() => getScan(s.scanId)?.status !== 'running', `the scan of ${root}`);
    assert.equal(getScan(s.scanId)?.status, 'complete', getScan(s.scanId)?.error);
  };
  const dry = async (p: string): Promise<{ refused: boolean; text: string }> => {
    const r = await call('trash_paths', { paths: [p], dryRun: true });
    return { refused: r.isError === true, text: r.content?.[0]?.text ?? '' };
  };
  await withOpenFileCheck('clear', async () => {
    await updateSettings({ ignore: [{ pattern: 'vmdisk.bundle', scope: 'scan' }] });
    try {
      await scanned();
      const held = await dry(holder);
      assert.equal(held.refused, false, `the scan listed nothing inside it, so it refuses no folder for holding it — the limit the docs state: ${held.text}`);
      const own = await dry(item);
      assert.deepEqual([own.refused, /ADVISORY_PATH/.test(own.text)], [true, true], `control: the item itself is still refused: ${own.text}`);
    } finally {
      await updateSettings({ ignore: [] });
    }
    await updateSettings({ ignore: [{ pattern: 'vmdisk.bundle', scope: 'suggest' }] });
    try {
      await scanned();
      const held = await dry(holder);
      assert.equal(held.refused, true, `a suggest-scope pattern hides only the suggestion: the scan lists the item, and the folder holding it is refused: ${held.text}`);
      assert.match(held.text, /ADVISORY_PATH/, held.text);
      assert.match(held.text, /holds/, `and says it holds one: ${held.text}`);
    } finally {
      await updateSettings({ ignore: [] });
    }
  });
  assert.deepEqual(trashed, [], 'nothing reached a Trash step');
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

/** Each path, dry run and real run alike, is refused ADVISORY_PATH, and nothing reaches a Trash step. */
async function assertAdvisoryRefused(paths: string[]): Promise<void> {
  await withOpenFileCheck('clear', async () => {
    for (const p of paths) {
      for (const dryRun of [true, false]) {
        const r = await call('trash_paths', { paths: [p], dryRun });
        const text = r.content?.[0]?.text ?? '';
        assert.equal(r.isError, true, `${p} dryRun=${dryRun} was not refused: ${JSON.stringify(r.structuredContent ?? text)}`);
        assert.match(text, /ADVISORY_PATH/, text);
      }
    }
  });
  assert.deepEqual(trashed, [], 'nothing reached a Trash step');
}

test('an ignore pattern or a suppressing note that hides the advisory group from cleanup_suggestions does not let trash_paths take it (review F1.10)', async () => {
  // The folder holding the bundle is refused only by what the scan's walk finds inside it, so it
  // shows the claims are every advice-rule match, with no ignore pattern and no note applied.
  const vm = path.join(ROOT, 'vm');
  const listed = async (): Promise<string[]> => {
    const r = await call('cleanup_suggestions', { scanId });
    assert.ok(!r.isError, JSON.stringify(r.content));
    return r.structuredContent.groups.map((g: { id: string }) => g.id);
  };
  await updateSettings({ ignore: [{ pattern: 'vmdisk.bundle', scope: 'suggest' }] });
  try {
    assert.ok(!(await listed()).includes('test-vm-disk'), 'the ignore pattern hides the group from the suggestions');
    await assertAdvisoryRefused([BUNDLE, DISK, vm]);
  } finally {
    await updateSettings({ ignore: [] });
  }
  await setNote(vm, 'The VM lives here', true);
  try {
    assert.ok(!(await listed()).includes('test-vm-disk'), 'the note hides the group from the suggestions');
    await assertAdvisoryRefused([BUNDLE, DISK, vm]);
  } finally {
    await deleteNote(vm);
  }
});

test('while a rule pack cannot be read, trash_paths fails closed: it refuses even a path no advice rule names, and moves nothing (review F1.10)', async () => {
  const broken = fileTempDir('treemap-mcp-advisory-broken-');
  for (const name of fs.readdirSync(PACKS)) fs.copyFileSync(path.join(PACKS, name), path.join(broken, name));
  fs.writeFileSync(path.join(broken, 'common.json'), '{ "schemaVersion": 1, "pack": "common", ');
  process.env.TREEMAP_RULEPACK_DIR = broken;
  resetRuleCatalog();
  try {
    await withOpenFileCheck('clear', async () => {
      for (const dryRun of [true, false]) {
        const r = await call('trash_paths', { paths: [SCRATCH_A], dryRun });
        const text = r.content?.[0]?.text ?? '';
        assert.equal(r.isError, true, `dryRun=${dryRun} went ahead: ${JSON.stringify(r.structuredContent ?? text)}`);
        assert.match(text, /RULE_PACKS_UNAVAILABLE/, text);
        // A refusal the endpoint decides is audited, as AGENTS.md says (hunt HF-L4).
        const [line] = await readAudit(1);
        assert.deepEqual(
          [line?.action, line?.source, line?.outcome, line?.code, line?.dryRun, line?.paths],
          ['files.trash', 'mcp', 'refused', 'RULE_PACKS_UNAVAILABLE', dryRun, [SCRATCH_A]],
          `dryRun=${dryRun}: the fail-closed refusal is audited`,
        );
      }
    });
    assert.deepEqual(trashed, [], 'nothing reached a Trash step');
    assert.ok(fs.existsSync(SCRATCH_A));
  } finally {
    process.env.TREEMAP_RULEPACK_DIR = PACKS;
    resetRuleCatalog();
  }
});
