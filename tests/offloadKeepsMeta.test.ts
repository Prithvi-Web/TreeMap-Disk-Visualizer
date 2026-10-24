import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-offloadKeepsMeta-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createScanRecord } from '../src/services/diskScanner';
import { getOffloadIndex, getOffloadJob, prepareOffload, setOffloadFileMetaFaultForTests, startOffload, startRestore } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import { buildOpenApiDocument } from '../src/api/openapi';
import { setCopyFaultForTests } from '../src/utils/copyVerify';
import { readJsonFile, writeJsonFile } from '../src/services/storage';
import http from 'node:http';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp/server';
import { isRestoreCopyFor } from './fixtures/restoreCopy';
import type { FileNode, OffloadJob, ScanResult } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';
import { destinationsOnAnotherDrive } from './fixtures/offloadDrive';
destinationsOnAnotherDrive(); // every destination here stands for another drive (E01)

/**
 * An offload and its Restore keep each file's modified date and, where the system has them, its
 * permissions (hunt C45). The copy opened its output with the default mode and set nothing after:
 * a private 0600 file came out 0644 — readable by every account — at the destination and again after
 * Restore, a script lost its execute bit, and every date became the time of the offload or the
 * restore. Now each copy is given its original's dates (and, off Windows, its permission bits) once it
 * verifies, the record keeps them, and Restore puts them back on the file it writes.
 *
 * Windows has no POSIX permission bits — a mode there is only the read-only attribute — so the
 * permission test runs where they exist; the dates are kept, and tested, everywhere.
 *
 * Nothing reaches the machine's Trash: the trash step moves each original into this file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-offloadKeepsMeta-trash-');
let trashCount = 0;

before(() => {
  setTrashStepForTests(async (p) => {
    trashCount++;
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashCount}-${path.basename(p)}`));
  });
});

after(() => {
  setTrashStepForTests(null);
});

const OLD = new Date('2020-01-02T03:04:05Z');
const OLDER = new Date('2019-06-07T08:09:10Z');

function fileNode(p: string): FileNode {
  return { name: path.basename(p), path: p, size: fs.statSync(p).size, type: 'file', modifiedAt: Date.now(), isHidden: false };
}

/** root/proj holding `files` (name → mode), each last opened OLDER and modified OLD, and a complete scan listing them. */
function project(label: string, files: Record<string, number>): { proj: string; paths: string[]; scan: ScanResult } {
  const root = fs.realpathSync(fileTempDir(`treemap-offloadKeepsMeta-${label}-`));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const paths = Object.entries(files).map(([name, mode]) => {
    const p = path.join(proj, name);
    fs.writeFileSync(p, `the contents of ${name}\n`);
    fs.chmodSync(p, mode);
    fs.utimesSync(p, OLDER, OLD);
    return p;
  });
  const children = paths.map(fileNode);
  const scan = createScanRecord(root);
  scan.status = 'complete';
  const folder: FileNode = { name: 'proj', path: proj, size: children.reduce((s, c) => s + c.size, 0), type: 'dir', modifiedAt: Date.now(), isHidden: false, children };
  scan.root = { name: path.basename(root), path: root, size: folder.size, type: 'dir', modifiedAt: Date.now(), isHidden: false, children: [folder] };
  return { proj, paths, scan };
}

async function settled(jobId: string): Promise<OffloadJob> {
  await waitFor(() => getOffloadJob(jobId)?.status !== 'running', `the job ${jobId} settling`);
  return getOffloadJob(jobId) as OffloadJob;
}

/** Offloads `proj`, then restores every file of it; answers the destination. */
async function offloadAndRestore(label: string, proj: string, scan: ScanResult, between: (dest: string) => void): Promise<string> {
  const dest = fileTempDir(`treemap-offloadKeepsMeta-${label}-dest-`);
  const job = await withOpenFileCheck('clear', async () => {
    const prepared = await prepareOffload(scan, [proj], dest);
    return settled((await startOffload(scan, [proj], dest, prepared)).jobId);
  });
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.error, undefined, 'no warning: every date and permission was set');
  assert.ok(!fs.existsSync(proj), 'the originals went to the (stand-in) Trash');
  between(dest);
  const ids = (await getOffloadIndex()).entries.filter((e) => e.originalPath.startsWith(proj + path.sep)).map((e) => e.id);
  const restore = await settled((await startRestore(ids)).jobId);
  assert.equal(restore.status, 'complete', restore.error);
  assert.equal(restore.error, undefined, 'no warning: every date and permission was set back');
  return dest;
}

test('an offload\'s copies and its Restore keep each file\'s modified date, and the record keeps it', async () => {
  const { proj, paths, scan } = project('times', { 'notes.txt': 0o644, 'report.pdf': 0o644 });
  await offloadAndRestore('times', proj, scan, (dest) => {
    for (const name of ['notes.txt', 'report.pdf']) {
      assert.equal(fs.statSync(path.join(dest, 'proj', name)).mtime.toISOString(), OLD.toISOString(), `the copy of ${name} keeps its modified date`);
    }
  });
  for (const p of paths) {
    assert.equal(fs.statSync(p).mtime.toISOString(), OLD.toISOString(), `the restored ${path.basename(p)} has its modified date back`);
  }
  const recorded = (await getOffloadIndex()).entries.filter((e) => e.originalPath.startsWith(proj + path.sep));
  assert.ok(recorded.every((e) => e.mtimeMs === OLD.getTime()), 'the record keeps each modified date');
});

test('an offload\'s copies and its Restore keep each file\'s last-opened date too, and the record keeps it (review F1.18)', async () => {
  const { proj, paths, scan } = project('atimes', { 'opened.txt': 0o644 });
  await offloadAndRestore('atimes', proj, scan, (dest) => {
    assert.equal(fs.statSync(path.join(dest, 'proj', 'opened.txt')).atime.toISOString(), OLDER.toISOString(), 'the copy keeps its last-opened date');
  });
  assert.equal(fs.statSync(paths[0]).atime.toISOString(), OLDER.toISOString(), 'the restored file has its last-opened date back');
  const recorded = (await getOffloadIndex()).entries.filter((e) => e.originalPath.startsWith(proj + path.sep));
  assert.deepEqual(recorded.map((e) => e.atimeMs), [OLDER.getTime()], 'the record keeps it');
});

/**
 * An original this account can read with no owner bits at all — another account's file shared by its
 * group or other bits, which no test can make — is stood in for, where the system can, by an access
 * list that lets this user read a file of mode 0o044 (macOS `chmod +a`). Its copy, made by this user,
 * must stay readable to them, or Restore could never read it back (review F1.18).
 */
test('a copy of an original readable here with no owner bits is left readable by its owner, so Restore can read it back', { skip: process.platform !== 'darwin' ? 'an access list that lets an owner read past its own mode is macOS\'s (chmod +a)' : false }, async () => {
  const { proj, paths: [shared], scan } = project('ownerless', { 'shared.txt': 0o644 });
  fs.chmodSync(shared, 0o044);
  execFileSync('chmod', ['+a', `user:${os.userInfo().username} allow read`, shared], { env: { ...process.env } });
  fs.utimesSync(shared, OLDER, OLD);
  assert.equal(fs.readFileSync(shared, 'utf8'), 'the contents of shared.txt\n', 'readable here, though its mode gives its owner nothing');
  await offloadAndRestore('ownerless', proj, scan, (dest) => {
    const copy = path.join(dest, 'proj', 'shared.txt');
    assert.equal(fs.statSync(copy).mode & 0o777, 0o444, 'its own bits, and readable by its owner');
    assert.equal(fs.readFileSync(copy, 'utf8'), 'the contents of shared.txt\n');
  });
  const recorded = (await getOffloadIndex()).entries.filter((e) => e.originalPath === shared);
  assert.deepEqual(recorded.map((e) => e.mode), [0o044], 'the record keeps the original\'s own bits');
});

test('an offload\'s copies and its Restore keep each file\'s permissions: a private file stays private, a script stays runnable', { skip: process.platform === 'win32' ? 'Windows has no POSIX permission bits; a mode there is only the read-only attribute' : false }, async () => {
  const { proj, paths: [secret, script], scan } = project('modes', { 'secret.txt': 0o600, 'run.sh': 0o755 });
  await offloadAndRestore('modes', proj, scan, (dest) => {
    assert.equal(fs.statSync(path.join(dest, 'proj', 'secret.txt')).mode & 0o777, 0o600, 'the copy of the private file is private');
    assert.equal(fs.statSync(path.join(dest, 'proj', 'run.sh')).mode & 0o777, 0o755, 'the copy of the script is runnable');
  });
  assert.equal(fs.statSync(secret).mode & 0o777, 0o600, 'the restored private file is private');
  assert.equal(fs.statSync(script).mode & 0o777, 0o755, 'the restored script is runnable');
  const recorded = (await getOffloadIndex()).entries.filter((e) => e.originalPath.startsWith(proj + path.sep));
  assert.deepEqual(recorded.map((e) => [path.basename(e.originalPath), e.mode]).sort(), [['run.sh', 0o755], ['secret.txt', 0o600]], 'the record keeps each permission');
});

test('Restore puts the recorded date and permissions back even when the copy on the drive lost them (a drive that cannot hold them)', async () => {
  const { proj, paths: [file], scan } = project('lost', { 'kept.txt': 0o640 });
  await offloadAndRestore('lost', proj, scan, (dest) => {
    // As exFAT would have it: the copy's own date and permissions are whatever the drive gives it.
    const copy = path.join(dest, 'proj', 'kept.txt');
    fs.utimesSync(copy, new Date(), new Date());
    if (process.platform !== 'win32') fs.chmodSync(copy, 0o666);
  });
  assert.equal(fs.statSync(file).mtime.toISOString(), OLD.toISOString(), 'the date comes from the record');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o640, 'and so do the permissions');
});

test('a drive that cannot hold a copy\'s dates is said, never a reason to undo the offload or the restore', async () => {
  const { proj, paths: [file], scan } = project('fault', { 'a.txt': 0o644 });
  const dest = fileTempDir('treemap-offloadKeepsMeta-fault-dest-');
  const refuse = setOffloadFileMetaFaultForTests((_p, what) => (what === 'times' ? Object.assign(new Error('EPERM: operation not permitted, utime'), { code: 'EPERM' }) : null));
  try {
    const job = await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, [proj], dest);
      return settled((await startOffload(scan, [proj], dest, prepared)).jobId);
    });
    assert.equal(job.status, 'complete', job.error);
    assert.ok(!fs.existsSync(proj), 'the verified offload went ahead');
    // A note, never the job's error (review F1.8): it denies nothing the job did, so the page's
    // "originals are in the Trash" still stands beside it.
    assert.equal(job.error, undefined, job.error);
    assert.match(job.note ?? '', /The dates or permissions of 1 copy could not be set at the destination/, job.note);
    const last = (await framesOf(job.jobId)).at(-1) ?? {};
    assert.equal(last.type, 'complete');
    assert.equal(last.warning, undefined, 'the stream carries no warning');
    assert.equal(last.note, job.note, 'the stream carries the note');
    assert.equal((await mcpOffloadPayload(job.jobId)).note, job.note, 'and so does the MCP offload tool');
    assert.match(job.note ?? '', /TreeMap's record keeps the originals' dates and permissions for Restore/, job.note);
    const ids = (await getOffloadIndex()).entries.filter((e) => e.originalPath === file).map((e) => e.id);
    const restore = await settled((await startRestore(ids)).jobId);
    assert.equal(restore.status, 'complete', restore.error);
    assert.ok(fs.existsSync(file), 'the restore went ahead');
    assert.equal(restore.error, undefined, restore.error);
    assert.match(restore.note ?? '', /The dates or permissions of 1 restored file could not be set back/, restore.note);
  } finally {
    refuse();
  }
});

test('a date finer than a millisecond is recorded as the fraction it is, and the published schema says a number, not an integer (review F1.7, F1.20)', async () => {
  const { proj, paths: [file], scan } = project('fraction', { 'fine.txt': 0o644 });
  fs.utimesSync(file, 1_577_934_245.123456, 1_577_934_300.654321); // as APFS, ext4 and NTFS keep them
  await offloadAndRestore('fraction', proj, scan, (dest) => {
    assert.equal(fs.statSync(path.join(dest, 'proj', 'fine.txt')).mtime.getTime(), 1_577_934_300_654, 'the copy has it to the millisecond');
  });
  const [entry] = (await getOffloadIndex()).entries.filter((e) => e.originalPath === file);
  assert.equal(Number.isInteger(entry.mtimeMs), false, `a fraction of a millisecond: ${entry.mtimeMs}`);
  assert.equal(Math.trunc(entry.mtimeMs as number), 1_577_934_300_654);
  assert.equal(fs.statSync(file).mtime.getTime(), 1_577_934_300_654, 'and Restore puts it back to the millisecond');
  const props = (buildOpenApiDocument() as { components: { schemas: Record<string, { properties: Record<string, { type: string }> }> } }).components.schemas.OffloadEntry.properties;
  assert.deepEqual([props.mtimeMs.type, props.atimeMs.type], ['number', 'number']);
});

test('a private file\'s copy, and its restore\'s file, are never readable by other accounts while they are written (review F1.12)', { skip: process.platform === 'win32' ? 'Windows has no POSIX permission bits' : false }, async () => {
  const root = fs.realpathSync(fileTempDir('treemap-offloadKeepsMeta-window-'));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const secret = path.join(proj, 'secret.key');
  fs.writeFileSync(secret, Buffer.alloc(300_000, 0x53)); // several chunks: looked at while it is written
  fs.chmodSync(secret, 0o600);
  const scan = createScanRecord(root);
  scan.status = 'complete';
  const folder: FileNode = { name: 'proj', path: proj, size: 300_000, type: 'dir', modifiedAt: Date.now(), isHidden: false, children: [fileNode(secret)] };
  scan.root = { name: path.basename(root), path: root, size: 300_000, type: 'dir', modifiedAt: Date.now(), isHidden: false, children: [folder] };
  const seen: { offload: number[]; restore: number[] } = { offload: [], restore: [] };
  const undo = setCopyFaultForTests((dest) => {
    const mode = fs.statSync(dest).mode & 0o777;
    if (isRestoreCopyFor(dest, secret)) seen.restore.push(mode);
    else if (dest.endsWith('secret.key')) seen.offload.push(mode);
    return null;
  });
  try {
    await offloadAndRestore('window', proj, scan, () => {});
  } finally {
    undo();
  }
  assert.ok(seen.offload.length > 0 && seen.restore.length > 0, 'both copies were looked at while written');
  assert.deepEqual([...new Set(seen.offload)], [0o600], 'the copy is private from the moment it is made');
  assert.deepEqual([...new Set(seen.restore)], [0o600], 'and so is the restore\'s temporary file');
  assert.equal(fs.statSync(secret).mode & 0o777, 0o600);
});

test('an entry an earlier build recorded with no permissions or dates is restored as any new file is made, never left private (leftover HE-L9)', { skip: process.platform === 'win32' ? 'Windows has no POSIX permission bits' : false }, async () => {
  const { proj, paths: [file], scan } = project('nomode', { 'old.txt': 0o644 });
  const dest = fileTempDir('treemap-offloadKeepsMeta-nomode-dest-');
  const job = await withOpenFileCheck('clear', async () => {
    const prepared = await prepareOffload(scan, [proj], dest);
    return settled((await startOffload(scan, [proj], dest, prepared)).jobId);
  });
  assert.equal(job.status, 'complete', job.error);
  // As a build before hunt C45 recorded it: no permission bits and no dates.
  const store = await readJsonFile<{ entries: Record<string, unknown>[] }>('offload-manifest.json', { entries: [] });
  const entry = store.entries.find((e) => e.originalPath === file) as Record<string, unknown>;
  delete entry.mode;
  delete entry.mtimeMs;
  delete entry.atimeMs;
  await writeJsonFile('offload-manifest.json', store);
  const was = process.umask(0o022); // a new file is then made 0o644
  let restore: OffloadJob;
  try {
    restore = await settled((await startRestore([entry.id as string])).jobId);
  } finally {
    process.umask(was);
  }
  assert.equal(restore.status, 'complete', restore.error);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644, 'made as a new file is, not owner-only: nothing recorded would ever set its bits');
});

/** The frames of an offload job's progress stream, read until the server ends it. */
async function framesOf(jobId: string): Promise<Record<string, unknown>[]> {
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    const text = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: `/api/offload/${jobId}/progress`, method: 'GET' }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => resolve(buf));
      });
      req.on('error', reject);
      req.end();
    });
    return text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** What the MCP offload tool answers for a finished job, asked by its id. */
async function mcpOffloadPayload(jobId: string): Promise<Record<string, unknown>> {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'treemap-offloadKeepsMeta-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const reply = (await client.callTool({ name: 'offload', arguments: { jobId } })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    assert.ok(!reply.isError, JSON.stringify(reply));
    return reply.structuredContent ?? {};
  } finally {
    await client.close();
  }
}
