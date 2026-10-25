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
import { resetRuleCatalog, ruleCatalogStatus } from '../src/services/rulePacks';
import { adviceHitAlong } from '../src/services/adviceGuard';
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
      // Hunt HF-L6: the branches adviceGuard claims, each with a rule of its own.
      rule({ id: 'test-vm-file', kind: 'file', title: 'Test VM disk file', description: 'A virtual machine disk file.', action: 'advice', adviceCommand: 'vmtool shrink', names: ['disk.vhdx'] }),
      rule({ id: 'test-cache-bundle', kind: 'project-directory', title: 'Test cache bundle', description: 'A cache bundle with its index.', action: 'advice', adviceCommand: 'cachetool purge', names: ['Cache Bundle'], requiresChild: ['index.db'], restoreCommand: 'Rebuilt by cachetool' }),
      rule({ id: 'test-proxy', kind: 'project-directory', title: 'Test proxy media', description: 'Proxy media nobody marked to keep.', action: 'advice', adviceCommand: 'Delete proxies in the editor', names: ['Proxy Media'], forbidsChild: ['keep.me'], restoreCommand: 'Made again by the editor' }),
      rule({ id: 'test-renders', kind: 'project-directory', title: 'Test renders', description: 'Renders beside a project file.', action: 'advice', adviceCommand: 'Delete renders in the editor', names: ['Renders'], requiresSibling: ['project.*'], restoreCommand: 'Render again' }),
      rule({ id: 'test-build', kind: 'project-directory', title: 'Test build output', description: 'Build output beside a manifest.', category: 'regenerable', names: ['build'], requiresSibling: ['package.json'], restoreCommand: 'npm run build' }),
      rule({ id: 'test-locked-build', kind: 'location', title: 'Test locked build', description: 'A build folder another tool owns.', action: 'advice', adviceCommand: 'buildtool clean', paths: ['{localAppData}/lockedparent/build'] }),
      // Review F1.4: a location rule whose folder's last name holds an s, which a volume may fold from ſ.
      rule({ id: 'test-vm-store', kind: 'location', title: 'Test VM store', description: 'A virtual machine store.', action: 'advice', adviceCommand: 'vmtool prune', paths: ['{localAppData}/vmstore'] }),
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

/* Hunt HF-L3, HF-L5: a path is judged where it is, as the scanned-root rule judges it — not by its spelling. */

/** Whether the volume answers `other`, another spelling of `p`, with `p` itself (it folds that name). */
function volumeFolds(p: string, other: string): boolean {
  try {
    const [a, b] = [fs.statSync(p), fs.statSync(other)];
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

test('a folder holding an advice-only item is refused when its last name is typed in another case', async (t) => {
  const root = tree('treemap-mcp-advroot-holdcase-', ['vmfolder/vmdisk.bundle/disk.img']);
  const holder = path.join(root, 'VMFOLDER');
  if (!volumeFolds(path.join(root, 'vmfolder'), holder)) return t.skip('this volume keeps case: VMFOLDER is another folder');
  await scanAt(root);
  await assertRefused([holder], 'vmtool compact');
  const r = await call('trash_paths', { paths: [holder], dryRun: true });
  assert.match(r.content?.[0]?.text ?? '', /" holds "Test VM disk"/, 'the refusal says the folder holds the item');
});

test('a scan whose root is typed in another case still finds the folder holding an advice-only item', async (t) => {
  const root = tree('treemap-mcp-advroot-rootcase-', ['vmfolder/vmdisk.bundle/disk.img']);
  const typed = path.join(path.dirname(root), path.basename(root).toUpperCase());
  if (!volumeFolds(root, typed)) return t.skip('this volume keeps case: the upper-case root is another folder');
  await scanAt(typed);
  await assertRefused([path.join(root, 'vmfolder')], 'vmtool compact');
});

test('an advice-only folder named with a leaf the volume folds (ſ for s) is refused', async (t) => {
  const root = tree('treemap-mcp-advroot-leaffold-', ['vm/vmdisk.bundle/disk.img']);
  const folded = path.join(root, 'vm', 'vmdiſk.bundle');
  if (!volumeFolds(path.join(root, 'vm', 'vmdisk.bundle'), folded)) return t.skip('this volume does not fold ſ to s');
  await scanAt(root);
  await assertRefused([folded, path.join(folded, 'disk.img')], 'vmtool compact');
  // Rooted at the folder itself, no scan's walk lists it as an item: the path alone must say so.
  const alone = tree('treemap-mcp-advroot-leaffold-alone-', ['vm/vmdisk.bundle/disk.img']);
  await scanAt(path.join(alone, 'vm', 'vmdisk.bundle'));
  await assertRefused([path.join(alone, 'vm', 'vmdi\u017fk.bundle')], 'vmtool compact');
});

test('a location rule\'s folder spelled through macOS\'s Data volume is refused, and so is the disk image in it', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const data = path.join(LOCAL, 'dockerish', 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'Docker.raw'), Buffer.alloc(8_192, 1));
  const long = path.join('/System/Volumes/Data', data);
  if (!volumeFolds(data, long)) return t.skip('the Data volume does not show this folder');
  await scanAt(data);
  await assertRefused([long, path.join(long, 'Docker.raw')], 'vmtool reclaim');
});

test('a scan whose root is typed through macOS\'s Data volume still finds the folder holding an advice-only item', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const root = tree('treemap-mcp-advroot-datavolroot-', ['vmfolder/vmdisk.bundle/disk.img']);
  const long = path.join('/System/Volumes/Data', root);
  if (!volumeFolds(root, long)) return t.skip('the Data volume does not show this folder');
  await scanAt(long);
  await assertRefused([path.join(root, 'vmfolder')], 'vmtool compact');
});

/* Hunt HF-L6: every branch adviceGuard states, pinned. Each scan is rooted AT the folder or file under
 * test, so no scan's walk lists it as an item and the path alone must decide. */

test('a file an advice-only file rule names is refused, judged from the path itself', async () => {
  const root = tree('treemap-mcp-advroot-filerule-', ['vm/disk.vhdx', 'vm/notes.txt']);
  const disk = path.join(root, 'vm', 'disk.vhdx');
  await scanAt(disk);
  await assertRefused([disk], 'vmtool shrink');
  await scanAt(path.join(root, 'vm', 'notes.txt'));
  await assertAllowed(path.join(root, 'vm', 'notes.txt'));
});

test('a project rule\'s required child and refused child are read from the disk', async () => {
  const root = tree('treemap-mcp-advroot-children-', [
    'with/Cache Bundle/index.db', 'without/Cache Bundle/blob.bin',
    'plain/Proxy Media/clip.mov', 'kept/Proxy Media/keep.me',
  ]);
  for (const sub of ['with', 'without', 'plain', 'kept']) {
    const dir = sub === 'with' || sub === 'without' ? 'Cache Bundle' : 'Proxy Media';
    await scanAt(path.join(root, sub, dir));
  }
  await assertRefused([path.join(root, 'with', 'Cache Bundle')], 'cachetool purge');
  await assertAllowed(path.join(root, 'without', 'Cache Bundle'));
  await assertRefused([path.join(root, 'plain', 'Proxy Media')], 'Delete proxies in the editor');
  await assertAllowed(path.join(root, 'kept', 'Proxy Media'));
});

test('a sibling pattern ending in .* matches any extension', async () => {
  const root = tree('treemap-mcp-advroot-wildcard-', ['film/Renders/a.mov', 'film/project.fcpx', 'other/Renders/a.mov', 'other/projectnotes']);
  await scanAt(path.join(root, 'film', 'Renders'));
  await scanAt(path.join(root, 'other', 'Renders'));
  await assertRefused([path.join(root, 'film', 'Renders')], 'Delete renders in the editor');
  await assertAllowed(path.join(root, 'other', 'Renders'));
});

test('a folder whose sibling cannot be listed is not claimed by a trash project rule first, so an advice rule still refuses it', {
  // A folder this user may enter but not list: POSIX permissions (Windows has no such mode, and root reads anything).
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const parent = path.join(LOCAL, 'lockedparent');
  const build = path.join(parent, 'build');
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, 'out.js'), Buffer.alloc(1_024, 4));
  fs.writeFileSync(path.join(parent, 'package.json'), '{}');
  await scanAt(build);
  fs.chmodSync(parent, 0o300);
  try {
    assert.throws(() => fs.readdirSync(parent), 'the folder holding it cannot be listed');
    await assertRefused([build], 'buildtool clean');
  } finally {
    fs.chmodSync(parent, 0o755);
  }
});

test('a path named through a link into an advice-only folder is refused, as where it lives', {
  skip: process.platform === 'win32', // a symbolic link needs a privilege the Windows runner's user may not hold
}, async () => {
  const root = tree('treemap-mcp-advroot-link-', ['vm/vmdisk.bundle/disk.img']);
  fs.symlinkSync(path.join(root, 'vm', 'vmdisk.bundle'), path.join(root, 'alias'));
  await scanAt(root);
  await assertRefused([path.join(root, 'alias', 'disk.img')], 'vmtool compact');
});

/* Review F1.1: every folder above a path was folded again from its root, name by name, so a deep path
 * cost a fold for every name of every folder above it — quadratic in its depth, synchronously on the
 * MCP event loop, for each spelling of each of up to 500 paths. Counted, not timed. */

/** The catalog this file's packs make. */
function catalogHere(): NonNullable<Extract<ReturnType<typeof ruleCatalogStatus>, { ok: true }>['catalog']> {
  const status = ruleCatalogStatus();
  assert.ok(status.ok, 'the test packs load');
  return status.catalog;
}

/** How many names `body` folds: each fold is one NFKC normalisation (foldName). */
function foldsDuring<T>(body: () => T): { folds: number; value: T } {
  const proto = String.prototype as { normalize: (form?: string) => string };
  const normalize = proto.normalize;
  let folds = 0;
  proto.normalize = function (this: string, form?: string): string {
    folds += 1;
    return normalize.call(this, form);
  };
  try {
    return { value: body(), folds };
  } finally {
    proto.normalize = normalize;
  }
}

test('a deep path folds each of its names once, not once for every folder above it, and a deep path under an advice-only folder is still found (review F1.1)', () => {
  const catalog = catalogHere();
  adviceHitAlong(path.join(LOCAL, 'warm'), catalog); // the rules' own names are folded once per catalog
  const DEPTH = 400;
  const deep = path.join(LOCAL, ...Array<string>(DEPTH).fill('d'));
  const names = deep.split(path.sep).length;
  const plain = foldsDuring(() => adviceHitAlong(deep, catalog));
  assert.equal(plain.value, null, 'no rule claims it');
  assert.ok(plain.folds <= 2 * names, `${plain.folds} folds for a path of ${names} names: each name once, not once for every folder above it`);

  const data = path.join(LOCAL, 'dockerish', 'data');
  const under = foldsDuring(() => adviceHitAlong(path.join(data, ...Array<string>(DEPTH).fill('d')), catalog));
  assert.deepEqual([under.value?.path, under.value?.adviceCommand], [data, 'vmtool reclaim'], 'the location rule\'s folder far above it still claims it');
  assert.ok(under.folds <= 2 * (names + 2), `${under.folds} folds for a path of ${names + 2} names`);
});

test('a location rule\'s folder named with a last name the volume folds (ſ for s) is refused, judged from the path itself (review F1.4)', async (t) => {
  const store = path.join(LOCAL, 'vmstore');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'disk.raw'), Buffer.alloc(4_096, 5));
  const folded = path.join(LOCAL, 'vm\u017ftore');
  // The guard folds the name itself, whatever this volume does with it.
  assert.deepEqual([adviceHitAlong(folded, catalogHere())?.adviceCommand, adviceHitAlong(path.join(folded, 'disk.raw'), catalogHere())?.adviceCommand],
    ['vmtool prune', 'vmtool prune'], 'the location rule\'s folder and a file in it, by the folder\'s folded name');
  if (!volumeFolds(store, folded)) return t.skip('this volume does not fold ſ to s');
  await scanAt(store); // rooted AT the folder: no scan's walk lists it as an item, so the path alone must say so
  await assertRefused([folded, path.join(folded, 'disk.raw')], 'vmtool prune');
});
