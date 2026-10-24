import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-mcp-advisory-root-data-');
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
 * Review F1.2/F1.5 (hunt C12 follow-up): trash_paths took its advice-only claims from the cleanup
 * walk alone, and the walk examines only what lies below a scan's root. So a completed scan rooted
 * AT an advice-only folder, or inside one, claimed nothing, and trash_paths let the folder and its
 * files go — the natural way to see what is big in Docker's VM folder is to scan that folder. Now
 * the path itself and every folder above it are read against the rules, whatever folder the scan
 * started at.
 *
 * Every case has its own folder tree, and no other scan in this process covers it, so no scan
 * rooted higher up can find the claim for it. The rules come from a pack of this test's own
 * (TREEMAP_RULEPACK_DIR); the location rule's folder is under {localAppData}, pointed at a temp
 * folder here, so the same rule resolves on every platform CI runs.
 */

const PACKS = fileTempDir('treemap-mcp-advroot-packs-');
const LOCAL = fs.realpathSync(fileTempDir('treemap-mcp-advroot-local-'));
const trashed: string[] = [];
const was = { packs: process.env.TREEMAP_RULEPACK_DIR, local: process.env.LOCALAPPDATA };

function writePacks(): void {
  const rule = (extra: Record<string, unknown>) => ({ category: 'cache', confidence: 'high', ...extra });
  fs.writeFileSync(path.join(PACKS, 'common.json'), JSON.stringify({
    schemaVersion: 1, pack: 'common', updated: '2026-10-24',
    rules: [
      rule({ id: 'test-scratch', kind: 'directory', title: 'Test scratch folders', description: 'Scratch folders, safe to remove.', category: 'junk', names: ['scratchdir'] }),
      rule({ id: 'test-vm-disk', kind: 'directory', title: 'Test VM disk', description: 'A virtual machine disk.', action: 'advice', adviceCommand: 'vmtool compact', names: ['vmdisk.bundle'] }),
      rule({ id: 'test-vm-data', kind: 'location', title: 'Test VM data', description: 'A virtual machine\'s data folder.', action: 'advice', adviceCommand: 'vmtool reclaim', paths: ['{localAppData}/dockerish/data', '{localAppData}/scratchdir'] }),
      rule({ id: 'test-render', kind: 'project-directory', title: 'Test render files', description: 'Render files of a video project.', action: 'advice', adviceCommand: 'Delete render files in the editor', names: ['Render Files'], requiresSibling: ['Original Media'], restoreCommand: 'Render again in the editor' }),
    ],
  }));
  for (const pack of ['macos', 'linux', 'windows']) {
    fs.writeFileSync(path.join(PACKS, `${pack}.json`), JSON.stringify({ schemaVersion: 1, pack, updated: '2026-10-24', rules: [] }));
  }
}

/** A folder tree of its own, `files` relative paths each written with a few bytes. */
function tree(prefix: string, files: string[]): string {
  const root = fs.realpathSync(fileTempDir(prefix));
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), Buffer.alloc(4_096, 7));
  }
  return root;
}

let client: Client;

type Reply = { isError?: boolean; structuredContent?: any; content?: Array<{ text?: string }> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => (await client.callTool({ name, arguments: args })) as Reply;

async function scanAt(root: string): Promise<void> {
  const s = await startScan(root, {});
  await waitFor(() => getScan(s.scanId)?.status !== 'running', `the scan of ${root}`);
  assert.equal(getScan(s.scanId)?.status, 'complete', getScan(s.scanId)?.error);
}

/** Each path, dry run and real run alike, is refused ADVISORY_PATH naming `command`, audited, and reaches no Trash step. */
async function assertRefused(paths: string[], command: string): Promise<void> {
  await withOpenFileCheck('clear', async () => {
    for (const p of paths) {
      for (const dryRun of [true, false]) {
        const r = await call('trash_paths', { paths: [p], dryRun });
        const text = r.content?.[0]?.text ?? '';
        assert.equal(r.isError, true, `${p} dryRun=${dryRun} was not refused: ${JSON.stringify(r.structuredContent ?? text)}`);
        assert.match(text, /ADVISORY_PATH/, text);
        assert.ok(text.includes(command), `the refusal names the supported way instead: ${text}`);
        const [line] = await readAudit(1);
        assert.deepEqual([line?.source, line?.outcome, line?.code], ['mcp', 'refused', 'ADVISORY_PATH'], 'the refusal is audited');
      }
    }
  });
  assert.deepEqual(trashed, [], 'nothing reached a Trash step');
}

/** The path's dry run goes through: no rule makes it advice only. */
async function assertAllowed(p: string): Promise<void> {
  await withOpenFileCheck('clear', async () => {
    const r = await call('trash_paths', { paths: [p], dryRun: true });
    assert.ok(!r.isError, `${p} should be allowed: ${r.content?.[0]?.text}`);
    assert.deepEqual(r.structuredContent.wouldTrash.map((w: { path: string }) => w.path), [p]);
  });
}

before(async () => {
  writePacks();
  process.env.TREEMAP_RULEPACK_DIR = PACKS;
  process.env.LOCALAPPDATA = LOCAL;
  resetRuleCatalog();
  setTrashStepForTests(async (p: string) => { trashed.push(p); });
  await updateSettings({ engine: 'walker' });
  const server = buildMcpServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'mcp-advisory-root', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
});

after(async () => {
  await client.close();
  setTrashStepForTests(null);
  for (const [key, value] of [['TREEMAP_RULEPACK_DIR', was.packs], ['LOCALAPPDATA', was.local]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetRuleCatalog();
});

test('a scan rooted AT an advice-only folder: the folder and a file in it are refused', async () => {
  const root = tree('treemap-mcp-advroot-at-', ['vm/vmdisk.bundle/disk.img']);
  const bundle = path.join(root, 'vm', 'vmdisk.bundle');
  await scanAt(bundle);
  await assertRefused([bundle, path.join(bundle, 'disk.img')], 'vmtool compact');
});

test('a scan rooted INSIDE an advice-only folder: a file under it is refused', async () => {
  const root = tree('treemap-mcp-advroot-in-', ['vm/vmdisk.bundle/inner/part.img']);
  const inner = path.join(root, 'vm', 'vmdisk.bundle', 'inner');
  await scanAt(inner);
  await assertRefused([inner, path.join(inner, 'part.img')], 'vmtool compact');
});

test('a scan rooted at a location rule\'s folder: the folder and the disk image in it are refused', async () => {
  const data = path.join(LOCAL, 'dockerish', 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'Docker.raw'), Buffer.alloc(8_192, 1));
  await scanAt(data);
  await assertRefused([data, path.join(data, 'Docker.raw')], 'vmtool reclaim');
});

test('a project rule\'s folder is advice only where its sibling is there, judged from the disk', async () => {
  const withSibling = tree('treemap-mcp-advroot-proj-', ['Event/Render Files/clip.mov', 'Event/Original Media/clip.mov']);
  const render = path.join(withSibling, 'Event', 'Render Files');
  await scanAt(render);
  await assertRefused([render, path.join(render, 'clip.mov')], 'Delete render files in the editor');

  const alone = tree('treemap-mcp-advroot-proj-alone-', ['Event/Render Files/clip.mov']);
  const lone = path.join(alone, 'Event', 'Render Files');
  await scanAt(lone);
  await assertAllowed(path.join(lone, 'clip.mov'));
});

test('a project rule\'s sibling that cannot be listed counts as there for an advice rule, so the folder is refused', {
  // A folder this user may enter but not list: POSIX permissions (Windows has no such mode, and root reads anything).
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const root = tree('treemap-mcp-advroot-proj-unlisted-', ['Event/Render Files/clip.mov']);
  const event = path.join(root, 'Event');
  const render = path.join(event, 'Render Files');
  await scanAt(render);
  fs.chmodSync(event, 0o300);
  try {
    assert.throws(() => fs.readdirSync(event), 'the folder holding it cannot be listed');
    await assertRefused([path.join(render, 'clip.mov')], 'Delete render files in the editor');
  } finally {
    fs.chmodSync(event, 0o755);
  }
});

test('a file is judged by the file rules, as the walk judges it: a file named like an advice-only folder is not refused', async () => {
  const root = tree('treemap-mcp-advroot-file-', ['vm/vmdisk.bundle']);
  await scanAt(root);
  await assertAllowed(path.join(root, 'vm', 'vmdisk.bundle'));
});

test('a folder a trash rule claims first is not refused because an advice rule names it too, as the suggestions offer it', async () => {
  // The walk tries project rules, then name rules, then locations: a folder named scratchdir is the
  // trash rule's, whichever location rule also lists it.
  const scratch = path.join(LOCAL, 'scratchdir');
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'junk.bin'), Buffer.alloc(1_024, 2));
  await scanAt(scratch);
  await assertAllowed(path.join(scratch, 'junk.bin'));
  await assertAllowed(scratch);
});
