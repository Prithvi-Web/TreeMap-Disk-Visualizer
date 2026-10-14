import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-offloadSameVolume-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { createScanRecord, peekScan } from '../src/services/diskScanner';
import * as offload from '../src/services/offload';
import { prepareOffload } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import { readAudit } from '../src/services/audit';
import { AppError } from '../src/middleware/errorHandler';
import type { ScanResult } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * An offload to a folder on the drive the files already live on frees nothing (fourth browser pass,
 * E01): every copy lands on that same drive, and the originals go to that same drive's Trash — the
 * space is used twice until the Trash is emptied, and the person was promised room. The picker opened
 * on the home folder, so the obvious press did exactly that. The server refuses it, by the device each
 * end really is on, with its own code — a dry run as surely as a real run.
 *
 * Every folder here is in the runner's temp folder, so source and destination share a drive for real:
 * the refusal is driven against the disk, never a stand-in. Nothing reaches the machine's Trash.
 */

const FAKE_TRASH = fileTempDir('treemap-offloadSameVolume-trash-');
const trashed: string[] = [];

before(() => {
  setTrashStepForTests(async (p) => {
    trashed.push(p);
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashed.length}-${path.basename(p)}`));
  });
});
after(() => {
  setTrashStepForTests(null);
});

/** The device seam, which the fix adds; undefined before it. */
type DeviceOf = (p: string, end: 'source' | 'destination') => Promise<bigint | null>;
const setDevice = (offload as unknown as { setOffloadDeviceForTests?: (fn: DeviceOf | null) => () => void }).setOffloadDeviceForTests;

/** proj/ holding a.txt (1,000 bytes) under a fresh root, a complete scan listing it, and an empty destination beside it. */
function project(label: string): { root: string; proj: string; a: string; dest: string; scan: ScanResult } {
  const root = fs.realpathSync(fileTempDir(`treemap-offloadSameVolume-${label}-`));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const a = path.join(proj, 'a.txt');
  fs.writeFileSync(a, Buffer.alloc(1000, 1));
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = {
    name: path.basename(root), path: root, size: 1000, type: 'dir', modifiedAt: Date.now(), isHidden: false,
    children: [{
      name: 'proj', path: proj, size: 1000, type: 'dir', modifiedAt: Date.now(), isHidden: false,
      children: [{ name: 'a.txt', path: a, size: 1000, type: 'file', modifiedAt: Date.now(), isHidden: false }],
    }],
  };
  const dest = fs.realpathSync(fileTempDir(`treemap-offloadSameVolume-${label}-dest-`));
  return { root, proj, a, dest, scan };
}

function post(port: number, url: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
    });
    r.on('error', reject);
    r.end(payload);
  });
}

test('control: the source and the destination here really are on one drive', () => {
  const { a, dest } = project('control');
  assert.equal(fs.statSync(a, { bigint: true }).dev, fs.statSync(dest, { bigint: true }).dev,
    'the runner\'s temp folder is one drive — the refusal below is the real one');
});

test('POST /api/offload refuses a destination on the drive the files are on — DEST_SAME_VOLUME, a dry run and a real run alike, audited, and nothing copied or trashed (E01)', async () => {
  const { root, proj, a, dest } = project('route');
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const started = await post(port, '/api/scan', { path: root });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => peekScan(started.body.scanId)?.status !== 'running', 'the scan settling');
    for (const dryRun of [true, false]) {
      const before = trashed.length;
      const r = await withOpenFileCheck('clear', () => post(port, '/api/offload', { scanId: started.body.scanId, paths: [proj], dest, dryRun }));
      assert.equal(r.status, 400, `dryRun ${dryRun}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'DEST_SAME_VOLUME', `dryRun ${dryRun}: refused by its own code`);
      assert.match(r.body.error, /same drive/, 'the refusal says why in words');
      assert.match(r.body.error, /frees? nothing/, 'and what it would have cost');
      assert.match(r.body.error, /another drive/, 'and what to do instead');
      assert.deepEqual(fs.readdirSync(dest), [], `dryRun ${dryRun}: nothing was copied`);
      assert.ok(fs.existsSync(a), `dryRun ${dryRun}: the original is where it was`);
      assert.equal(trashed.length, before, `dryRun ${dryRun}: nothing went to the Trash`);
      const [last] = await readAudit(1);
      assert.ok(last, `dryRun ${dryRun}: the refusal is in the audit log`);
      assert.deepEqual({ action: last.action, outcome: last.outcome, code: last.code, dryRun: last.dryRun },
        { action: 'offload.start', outcome: 'refused', code: 'DEST_SAME_VOLUME', dryRun }, `dryRun ${dryRun}: the refusal is in the audit log`);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('the devices compared are the destination\'s and each selected item\'s — the same device refuses, another plans, and a device that cannot be read refuses nothing (E01)', async () => {
  assert.equal(typeof setDevice, 'function', 'offload.ts exposes setOffloadDeviceForTests');
  const { proj, dest, scan } = project('seam');
  const asked: Array<[string, string]> = [];
  const devices = { source: 1n as bigint | null, destination: 1n as bigint | null };
  const restore = setDevice!(async (p, end) => { asked.push([p, end]); return devices[end]; });
  try {
    await assert.rejects(withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest)),
      (e: unknown) => e instanceof AppError && e.code === 'DEST_SAME_VOLUME' && e.status === 400);
    assert.deepEqual(asked, [[dest, 'destination'], [proj, 'source']], 'the destination folder and the selected folder, each asked once');

    /** The plan's file count, or the assertion `said`, naming the refusal it met. */
    const plans = async (said: string): Promise<number> => {
      try {
        return (await withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest))).plan.length;
      } catch (e) {
        return assert.fail(`${said} — refused: ${(e as Error).message}`);
      }
    };
    devices.destination = 2n;
    assert.equal(await plans('a destination on another drive is planned'), 1);

    devices.destination = 1n;
    devices.source = null;
    assert.equal(await plans('a source whose drive cannot be read is not called the same drive'), 1);

    devices.source = 1n;
    devices.destination = null;
    assert.equal(await plans('nor is a destination whose drive cannot be read'), 1);
  } finally {
    restore();
  }
  await assert.rejects(withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest)),
    (e: unknown) => e instanceof AppError && e.code === 'DEST_SAME_VOLUME', 'with the seam removed, the real devices answer again');
});

test('every selected item is judged, whichever comes first: one item on the destination\'s drive among items on another refuses the whole offload, naming it (E01, review F1.7)', async () => {
  assert.equal(typeof setDevice, 'function', 'offload.ts exposes setOffloadDeviceForTests');
  // Two top-level items: one on "another drive", one on the destination's — the harm E01 describes when
  // only the first is judged: the second is copied onto its own drive and its original trashed.
  const root = fs.realpathSync(fileTempDir('treemap-offloadSameVolume-two-'));
  const items = ['aaa', 'zzz'].map((name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, `${name}.txt`), Buffer.alloc(1000, 1));
    return dir;
  });
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = {
    name: path.basename(root), path: root, size: 2000, type: 'dir', modifiedAt: Date.now(), isHidden: false,
    children: items.map((dir) => ({
      name: path.basename(dir), path: dir, size: 1000, type: 'dir' as const, modifiedAt: Date.now(), isHidden: false,
      children: [{ name: `${path.basename(dir)}.txt`, path: path.join(dir, `${path.basename(dir)}.txt`), size: 1000, type: 'file' as const, modifiedAt: Date.now(), isHidden: false }],
    })),
  };
  const dest = fs.realpathSync(fileTempDir('treemap-offloadSameVolume-two-dest-'));
  const devices = new Map<string, bigint>([[dest, 2n]]);
  const restore = setDevice!(async (p) => devices.get(p) ?? null);
  try {
    // Each item in turn is the one on the destination's drive, and each is sent first and last.
    for (const [same, other] of [[items[0], items[1]], [items[1], items[0]]]) {
      devices.set(same, 2n);
      devices.set(other, 1n);
      for (const order of [[same, other], [other, same]]) {
        await assert.rejects(withOpenFileCheck('clear', () => prepareOffload(scan, order, dest)),
          (e: unknown) => e instanceof AppError && e.code === 'DEST_SAME_VOLUME' && e.message.includes(`"${path.basename(same)}"`),
          `${path.basename(same)} on the destination's drive, sent ${order[0] === same ? 'first' : 'second'}: refused, naming it`);
      }
    }
    devices.set(items[0], 1n);
    devices.set(items[1], 3n);
    const plan = await withOpenFileCheck('clear', () => prepareOffload(scan, items, dest));
    assert.equal(plan.plan.length, 2, 'control: with neither on the destination\'s drive, both are planned');
  } finally {
    restore();
  }
});

/* ─────── Sibling APFS volumes share one pool of free space (review F1.5) ─────── */

/** A Mac's `mount`, in its own format: one APFS container (disk3) with several volumes, an external APFS drive, an exFAT one, a nullfs view. */
const MAC_MOUNT = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  'devfs on /dev (devfs, local, nobrowse)',
  '/dev/disk3s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
  '/dev/disk3s7 on /Volumes/Dev Space (apfs, local, journaled)',
  '/dev/disk5s1 on /Volumes/Backup (apfs, local, nodev, nosuid, journaled, noowners)',
  '/dev/disk6s1 on /Volumes/Camera (exfat, local, nodev, nosuid, noowners)',
  '/dev/disk6s2 on /Volumes/Camera 2 (exfat, local, nodev, nosuid, noowners)',
  '/Applications/Clocks.app/Wrapper on /private/var/folders/x/X/4B95 (nullfs, local, nodev, nosuid, read-only, nobrowse)',
  '',
].join('\n');

type ApfsModule = {
  apfsContainerByDevice: (entries: unknown[], deviceOf: (p: string) => Promise<bigint | null>) => Promise<Map<bigint, string>>;
};

test('the container each APFS volume draws its space from is read off the mount table: disk3s5, disk3s6, disk3s7 and the root snapshot disk3s1s1 are all disk3; another drive\'s volume is its own container; a volume of another file system, a view, or a mount point that cannot be read is left to its device (review F1.5)', async () => {
  const mod = await import('../src/services/apfsContainers').catch(() => null) as ApfsModule | null;
  assert.ok(mod && typeof mod.apfsContainerByDevice === 'function', 'src/services/apfsContainers.ts reads the containers');
  const { parseBsdMount } = await import('../src/platform/atime');
  const devices = new Map<string, bigint>([
    ['/', 30n], ['/System/Volumes/VM', 31n], ['/System/Volumes/Data', 30n], ['/Volumes/Dev Space', 37n],
    ['/Volumes/Backup', 50n], ['/Volumes/Camera', 60n], ['/Volumes/Camera 2', 61n], ['/private/var/folders/x/X/4B95', 70n],
  ]);
  const byDevice = await mod!.apfsContainerByDevice(parseBsdMount(MAC_MOUNT), async (p) => devices.get(p) ?? null);
  assert.deepEqual([...byDevice.entries()].sort((a, b) => Number(a[0] - b[0])),
    [[30n, 'disk3'], [31n, 'disk3'], [37n, 'disk3'], [50n, 'disk5']],
    'every volume of the boot container is disk3, the external APFS drive disk5, and the exFAT partitions and the nullfs view are left to their devices');
  devices.delete('/Volumes/Dev Space');
  const unread = await mod!.apfsContainerByDevice(parseBsdMount(MAC_MOUNT), async (p) => devices.get(p) ?? null);
  assert.deepEqual([...unread.entries()].sort((a, b) => Number(a[0] - b[0])), [[30n, 'disk3'], [31n, 'disk3'], [50n, 'disk5']],
    'a mount point that cannot be read names no container, and the others still answer');
});

test('a destination on another volume of the same APFS container is the same drive: the volumes are separate devices with one pool of free space, so DEST_SAME_VOLUME refuses it — two partitions of one disk do not share space and are not refused (review F1.5)', async () => {
  const setContainers = (offload as unknown as { setOffloadContainersForTests?: (fn: (() => Promise<Map<bigint, string>>) | null) => () => void }).setOffloadContainersForTests;
  assert.equal(typeof setContainers, 'function', 'offload.ts exposes setOffloadContainersForTests');
  const { proj, dest, scan } = project('container');
  const devices = { source: 1n, destination: 2n };
  let containers = new Map<bigint, string>([[1n, 'disk3'], [2n, 'disk3']]);
  const restoreDevices = setDevice!(async (_p, end) => devices[end]);
  const restoreContainers = setContainers!(async () => containers);
  try {
    await assert.rejects(withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest)),
      (e: unknown) => e instanceof AppError && e.code === 'DEST_SAME_VOLUME' && /same drive/.test(e.message),
      'two volumes of one container: refused');
    containers = new Map([[1n, 'disk3'], [2n, 'disk5']]);
    assert.equal((await withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest))).plan.length, 1, 'control: another container is another drive');
    containers = new Map();
    assert.equal((await withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest))).plan.length, 1, 'a container that cannot be read leaves the devices to decide');
  } finally {
    restoreContainers();
    restoreDevices();
  }
});

test('on this Mac, a folder on the VM volume and one in the temp folder are separate devices on one APFS container — an offload between them is refused, by the real mount table and the real disk (review F1.5)', { skip: (process.platform !== 'darwin' || !fs.existsSync('/System/Volumes/VM')) && 'needs macOS\'s VM volume' }, async () => {
  const { proj, scan } = project('vm');
  const vm = '/System/Volumes/VM';
  assert.notEqual(fs.statSync(vm, { bigint: true }).dev, fs.statSync(proj, { bigint: true }).dev, 'control: two devices');
  await assert.rejects(withOpenFileCheck('clear', () => prepareOffload(scan, [proj], vm)),
    (e: unknown) => e instanceof AppError && e.code === 'DEST_SAME_VOLUME',
    'they share one pool of free space, so the offload would free nothing: refused before anything is planned');
});

test('the refusal is declared where an agent reads: the OpenAPI document\'s 400 for POST /api/offload, AGENTS.md, and the MCP offload tool (E01)', async () => {
  const { buildOpenApiDocument } = await import('../src/api/openapi');
  const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { responses: Record<string, { description?: string }> }>> };
  assert.match(String(doc.paths['/api/offload'].post.responses['400'].description), /DEST_SAME_VOLUME[^;]*same drive/, 'the document names the code and says what it means');
  const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
  assert.match(agents, /`400 DEST_SAME_VOLUME`/, 'AGENTS.md names the code');
  assert.match(String(doc.paths['/api/offload'].post.responses['400'].description), /DEST_SAME_VOLUME[^;]*APFS container whose volumes share one pool of free space/,
    'and says a sibling APFS volume is the same drive (review F1.5)');
  assert.match(agents, /`400 DEST_SAME_VOLUME`,\s+judged by the device each really is on, and on a Mac by the APFS\s+container/, 'as AGENTS.md does');
  assert.match(String((doc.paths['/api/volumes'] as unknown as { get: { summary: string } }).get.summary), /another APFS volume in the root\u2019s container\) is no other drive and is not listed/,
    'the volume list says such a volume is not listed');
  assert.match(agents, /another APFS volume in the root's container\) is no other drive and is\s+not listed/, 'in AGENTS.md too');
  const mcp = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'server.ts'), 'utf8');
  assert.match(mcp.slice(mcp.indexOf("'offload',"), mcp.indexOf("'offload',") + 3000), /same drive/, 'the MCP offload tool tells an agent before it asks');
});
