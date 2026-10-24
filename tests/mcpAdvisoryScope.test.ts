import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-mcp-advisory-scope-data-');
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp/server';
import { startScan, getScan } from '../src/services/diskScanner';
import { setTrashStepForTests } from '../src/services/cleaner';
import { updateSettings } from '../src/services/settings';
import { resetRuleCatalog } from '../src/services/rulePacks';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * Hunt HF-L1: trash_paths judged every folder above a path against the rules, so on Windows the
 * shipped windows-temp rule — advice only, about %LOCALAPPDATA%\Temp — refused every file under
 * that folder: an ordinary temp file, and every test fixture CI makes in os.tmpdir(), which on the
 * Windows runner lies there. The rule is about the folder itself (programs expect it to exist), so
 * its pack says so (`adviceCovers: "folder"`): the folder, and a folder holding it, are refused;
 * what is in it is not. A rule without it covers what its folder holds too, so a VM disk in
 * Docker's WSL data folder stays refused.
 *
 * The Windows layout on every platform: the REAL windows.json is loaded in every OS pack slot (the
 * real common.json beside it), and LOCALAPPDATA points at a temp folder, so `{localAppData}/Temp`
 * is a folder of this test's.
 */

const ROOT = path.join(__dirname, '..');
const PACKS = fileTempDir('treemap-mcp-advscope-packs-');
const LOCAL = fs.realpathSync(fileTempDir('treemap-mcp-advscope-local-'));
const TEMP = path.join(LOCAL, 'Temp');
const trashed: string[] = [];
const was = { packs: process.env.TREEMAP_RULEPACK_DIR, local: process.env.LOCALAPPDATA };

function writePacks(): void {
  const shipped = (name: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'services', 'rulepacks', `${name}.json`), 'utf8'));
  fs.writeFileSync(path.join(PACKS, 'common.json'), JSON.stringify(shipped('common')));
  const windows = shipped('windows');
  for (const pack of ['macos', 'linux', 'windows']) {
    fs.writeFileSync(path.join(PACKS, `${pack}.json`), JSON.stringify({ ...windows, pack }));
  }
}

function writeFile(p: string, bytes: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 3));
}

let client: Client;

type Reply = { isError?: boolean; structuredContent?: any; content?: Array<{ text?: string }> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => (await client.callTool({ name, arguments: args })) as Reply;

async function scanAt(root: string): Promise<void> {
  const s = await startScan(root, {});
  await waitFor(() => getScan(s.scanId)?.status !== 'running', `the scan of ${root}`);
  assert.equal(getScan(s.scanId)?.status, 'complete', getScan(s.scanId)?.error);
}

/** The path's dry run is refused ADVISORY_PATH with `relation` and names `command`. */
async function assertRefused(p: string, relation: 'is in' | 'holds', command: string): Promise<void> {
  await withOpenFileCheck('clear', async () => {
    const r = await call('trash_paths', { paths: [p], dryRun: true });
    const text = r.content?.[0]?.text ?? '';
    assert.equal(r.isError, true, `${p} was not refused: ${JSON.stringify(r.structuredContent ?? text)}`);
    assert.match(text, /ADVISORY_PATH/, text);
    assert.ok(text.includes(`" ${relation} "`), `the refusal says the path ${relation} the item: ${text}`);
    assert.ok(text.includes(command), `the refusal names the supported way instead: ${text}`);
  });
}

/** The path's dry run goes through. */
async function assertAllowed(p: string): Promise<void> {
  await withOpenFileCheck('clear', async () => {
    const r = await call('trash_paths', { paths: [p], dryRun: true });
    assert.ok(!r.isError, `${p} should be allowed: ${r.content?.[0]?.text}`);
    assert.deepEqual(r.structuredContent.wouldTrash.map((w: { path: string }) => w.path), [p]);
  });
}

const TEMP_ADVICE = 'Settings ▸ System ▸ Storage ▸ Temporary files';

before(async () => {
  writePacks();
  process.env.TREEMAP_RULEPACK_DIR = PACKS;
  process.env.LOCALAPPDATA = LOCAL;
  resetRuleCatalog();
  setTrashStepForTests(async (p: string) => { trashed.push(p); });
  await updateSettings({ engine: 'walker' });
  const server = buildMcpServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'mcp-advisory-scope', version: '0.0.0' });
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

test('a file in Windows\' Temp folder, and a folder of its own there, go to the Trash: the advice is about the Temp folder itself', async () => {
  // As CI's fixtures are made on the Windows runner: a folder of the test's own in os.tmpdir(), scanned.
  const fixture = path.join(TEMP, 'treemap-mcp-fixture-1');
  writeFile(path.join(fixture, 'big.bin'), 8_192);
  await scanAt(fixture);
  await assertAllowed(path.join(fixture, 'big.bin'));
  await assertAllowed(fixture);
  assert.deepEqual(trashed, [], 'dry runs only');
});

test('the Temp folder itself, and a folder holding it, are still refused', async () => {
  writeFile(path.join(TEMP, 'held.tmp'), 1_024);
  await scanAt(TEMP);
  await assertRefused(TEMP, 'is in', TEMP_ADVICE);
  await assertAllowed(path.join(TEMP, 'held.tmp'));
  await scanAt(LOCAL);
  await assertRefused(LOCAL, 'holds', TEMP_ADVICE);
  // The scan of the folder above lists Temp as the rule's item: what is in it still goes.
  await assertAllowed(path.join(TEMP, 'held.tmp'));
});

test('an advice-only folder whose advice covers what it holds still refuses a file in it: a WSL virtual disk', async () => {
  const data = path.join(LOCAL, 'Docker', 'wsl', 'data');
  writeFile(path.join(data, 'ext4.vhdx'), 8_192);
  await scanAt(data);
  await assertRefused(path.join(data, 'ext4.vhdx'), 'is in', 'docker system prune');
  await assertRefused(data, 'is in', 'docker system prune');
});
