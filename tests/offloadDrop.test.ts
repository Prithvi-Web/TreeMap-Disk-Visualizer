import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-offloadDrop-data-');
import { waitFor } from './fixtures/waitFor';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { setVolumeProviders } from '../src/services/volumes';
import { destinationsOnAnotherDrive } from './fixtures/offloadDrive';
destinationsOnAnotherDrive(); // every destination here stands for another drive (E01)

/**
 * Volumes for the offload dock (§8.3): GET /api/volumes lists attached
 * external drives with free/total bytes. A drive whose stats cannot be read
 * is still listed — nulls with a reason — because hiding a drive the user can
 * see plugged in would be a lie of omission.
 *
 * The dock's drag/manifest/abort behaviour is frontend work and is tested in
 * the frontend session — this file deliberately covers only the endpoint.
 */

async function listen() {
  resetRateLimiter();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function get(port: number, url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: url, method: 'GET' }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => {
        let parsed: unknown = buf;
        try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

test('GET /api/volumes reports each attached drive with name, path, free and total bytes', async () => {
  setVolumeProviders({
    list: () => [
      { name: 'Backup', path: '/Volumes/Backup' },
      { name: 'Archive', path: '/Volumes/Archive' },
    ],
    usage: async () => ({ total: 1_000_000, free: 400_000 }),
  });
  const s = await listen();
  try {
    const r = await get(s.port, '/api/volumes');
    assert.equal(r.status, 200);
    assert.equal(r.body.volumes.length, 2);
    for (const v of r.body.volumes) {
      assert.deepEqual(Object.keys(v).sort(), ['freeBytes', 'name', 'path', 'totalBytes']);
      assert.equal(v.freeBytes, 400_000);
      assert.equal(v.totalBytes, 1_000_000);
    }
  } finally {
    setVolumeProviders(null);
    await s.close();
  }
});

test('a volume that shares this computer\'s own disk\'s space — another APFS volume in its container — is not listed as another drive, so neither the dock nor the offload picker offers it (review F1.5)', async () => {
  const asked: string[][] = [];
  setVolumeProviders({
    list: () => [
      { name: 'Backup', path: '/Volumes/Backup' },
      { name: 'Dev Space', path: '/Volumes/Dev Space' },
    ],
    usage: async () => ({ total: 1_000_000, free: 400_000 }),
    sameSpace: async (anchors: readonly string[], paths: readonly string[]) => { asked.push([...anchors], [...paths]); return new Set(['/Volumes/Dev Space']); },
  } as Parameters<typeof setVolumeProviders>[0]);
  const s = await listen();
  try {
    const r = await get(s.port, '/api/volumes');
    assert.equal(r.status, 200);
    assert.deepEqual(asked, [['/'], ['/Volumes/Backup', '/Volumes/Dev Space']], 'with no folder named, every listed volume is judged against this computer\'s own disk, once');
    assert.deepEqual(r.body.volumes.map((v: { path: string }) => v.path), ['/Volumes/Backup'], 'the volume on this computer\'s own disk is left out');
  } finally {
    setVolumeProviders(null);
    await s.close();
  }
});

test('which volumes share the space of the folders named: those on the same device as one, or whose device is a volume of one\'s APFS container — not another container, not a device no APFS volume is on (review F1.5, F2.1)', async () => {
  const mod = await import('../src/services/apfsContainers').catch(() => null) as
    { sameSpaceAs?: (anchors: readonly string[], paths: readonly string[], containers: ReadonlyMap<bigint, string>, deviceOf: (p: string) => Promise<bigint | null>) => Promise<Set<string>> } | null;
  assert.equal(typeof mod?.sameSpaceAs, 'function', 'apfsContainers.ts answers it');
  const devices = new Map<string, bigint>([
    ['/', 30n], ['/Volumes/Dev Space', 37n], ['/Volumes/Backup', 50n], ['/Volumes/Backup Two', 51n], ['/Volumes/Camera', 60n],
    ['/Volumes/Camera/DCIM', 60n],
  ]);
  const containers = new Map<bigint, string>([[30n, 'disk3'], [37n, 'disk3'], [50n, 'disk5'], [51n, 'disk5']]);
  const deviceOf = async (p: string) => devices.get(p) ?? null;
  const paths = ['/Volumes/Dev Space', '/Volumes/Backup', '/Volumes/Backup Two', '/Volumes/Camera', '/Volumes/Gone'];
  assert.deepEqual([...await mod!.sameSpaceAs!(['/'], paths, containers, deviceOf)], ['/Volumes/Dev Space'], 'this computer\'s own disk: its container\'s other volume');
  assert.deepEqual([...await mod!.sameSpaceAs!(['/Volumes/Backup'], paths, containers, deviceOf)], ['/Volumes/Backup', '/Volumes/Backup Two'],
    'files on another APFS drive: that drive, and the other volume of its container — never this computer\'s own sibling volume');
  assert.deepEqual([...await mod!.sameSpaceAs!(['/Volumes/Backup', '/'], paths, containers, deviceOf)], ['/Volumes/Dev Space', '/Volumes/Backup', '/Volumes/Backup Two'],
    'folders on two drives: what shares space with either');
  assert.deepEqual([...await mod!.sameSpaceAs!(['/'], paths, new Map([[37n, 'disk3'], [50n, 'disk5']]), deviceOf)], [],
    'a root whose container is not known shares no container\'s space');
  assert.deepEqual([...await mod!.sameSpaceAs!(['/Volumes/Camera/DCIM'], paths, containers, deviceOf)], ['/Volumes/Camera'],
    'a drive no APFS container is known for: the volume on the same device as the folder');
});

test('a cloud folder named as an anchor is on no local drive: it is never looked up on the disk, and shares no volume\'s space (review F2.1)', async () => {
  const { sameSpaceAs } = await import('../src/services/apfsContainers');
  const looked: string[] = [];
  const deviceOf = async (p: string) => { looked.push(p); return p === '/' ? 30n : p === '/Volumes/Dev Space' ? 37n : null; };
  const containers = new Map<bigint, string>([[30n, 'disk3'], [37n, 'disk3']]);
  assert.deepEqual([...await sameSpaceAs(['cloud://gdrive/Photos'], ['/Volumes/Dev Space'], containers, deviceOf)], [], 'no local volume shares a cloud folder\'s space');
  assert.deepEqual(looked.filter((p) => p.startsWith('cloud://')), [], 'and the cloud identifier never reaches the disk');
  assert.deepEqual([...await sameSpaceAs(['cloud://gdrive/Photos', '/'], ['/Volumes/Dev Space'], containers, deviceOf)], ['/Volumes/Dev Space'],
    'control: a local folder beside it is still judged');
});

test('on this Mac, the VM volume and the temp folder share the root\'s space and the device file system does not — read off the real mount table (review F1.5)', { skip: (process.platform !== 'darwin' || !fs.existsSync('/System/Volumes/VM')) && 'needs macOS\'s VM volume' }, async () => {
  const { volumesSharingSpace } = await import('../src/services/volumes') as { volumesSharingSpace?: (anchors: readonly string[], paths: readonly string[]) => Promise<Set<string>> };
  assert.equal(typeof volumesSharingSpace, 'function', 'volumes.ts answers it');
  const tmp = fs.realpathSync(os.tmpdir());
  assert.deepEqual([...await volumesSharingSpace!(['/'], ['/System/Volumes/VM', tmp, '/dev'])], ['/System/Volumes/VM', tmp],
    'VM and the Data volume are the root\'s container; devfs is no APFS volume');
});

test('on this Mac, GET /api/volumes itself leaves out the VM volume and the temp folder — the real wiring judges them, with only the drive listing stood in (review F2.2)', { skip: (process.platform !== 'darwin' || !fs.existsSync('/System/Volumes/VM')) && 'needs macOS\'s VM volume' }, async () => {
  // Only `list` is stood in: everything else is what GET /api/volumes really runs. A provider set that
  // replaced the real one wholesale would hide a broken wiring of the same-space judgement behind a stub.
  const tmp = fs.realpathSync(os.tmpdir());
  setVolumeProviders({ list: () => [{ name: 'VM', path: '/System/Volumes/VM' }, { name: 'Temp', path: tmp }] });
  const s = await listen();
  try {
    const r = await get(s.port, '/api/volumes');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.volumes.map((v: { path: string }) => v.path), [],
      'both share this computer\'s own disk\'s space, so neither is offered as another drive');
  } finally {
    setVolumeProviders(null);
    await s.close();
  }
});

test('GET /api/volumes?from= judges every volume against the folders the files are in, not this computer\'s own disk: a volume sharing space with one is left out, and this computer\'s own sibling volume is another drive for files that live elsewhere (review F2.1)', async () => {
  const asked: string[][] = [];
  setVolumeProviders({
    list: () => [{ name: 'Archive', path: '/Volumes/Archive' }, { name: 'Dev', path: '/Volumes/Dev' }, { name: 'Work', path: '/Volumes/Work' }],
    usage: async () => ({ total: 1_000_000, free: 400_000 }),
    // Work and Archive are two volumes of one external container; Dev is a volume of this computer's own disk.
    sameSpace: async (anchors: readonly string[]) => {
      asked.push([...anchors]);
      return new Set(anchors.flatMap((a) => (a.startsWith('/Volumes/Work') ? ['/Volumes/Work', '/Volumes/Archive'] : a === '/' || a.startsWith('/Users') ? ['/Volumes/Dev'] : [])));
    },
  });
  const s = await listen();
  const paths = async (url: string) => {
    const r = await get(s.port, url);
    assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.body)}`);
    return r.body.volumes.map((v: { path: string }) => v.path);
  };
  try {
    assert.deepEqual(await paths('/api/volumes'), ['/Volumes/Archive', '/Volumes/Work'], 'control: judged against this computer\'s own disk, its own sibling volume is left out');
    assert.deepEqual(await paths(`/api/volumes?from=${encodeURIComponent('/Volumes/Work/Projects/../Projects')}`), ['/Volumes/Dev'],
      'files on Work: Work and the volume sharing its container are left out, and this computer\'s own sibling volume is offered');
    assert.deepEqual(asked[1], ['/Volumes/Work/Projects'], 'the folder named is what is judged, as the path sanitizer spells it');
    assert.deepEqual(await paths(`/api/volumes?from=${encodeURIComponent('/Volumes/Work')}&from=${encodeURIComponent('/Users/me')}`), [],
      'files on Work and on this computer\'s disk: no volume is another drive for all of them');
    assert.deepEqual(asked[2], ['/Volumes/Work', '/Users/me'], 'every folder named is judged, in order');
  } finally {
    setVolumeProviders(null);
    await s.close();
  }
});

test('GET /api/volumes refuses a folder in from that is no path, and more than 32 of them — never judging against something else in its place (review F2.1)', async () => {
  setVolumeProviders({ list: () => [{ name: 'Work', path: '/Volumes/Work' }], usage: async () => ({ total: 10, free: 5 }), sameSpace: async () => new Set() });
  const s = await listen();
  try {
    const empty = await get(s.port, '/api/volumes?from=');
    assert.equal(empty.body.code, 'PATH_INVALID', 'an empty folder is refused');
    const nul = await get(s.port, '/api/volumes?from=%2FVolumes%2FWork%00x');
    assert.equal(nul.body.code, 'PATH_INVALID', 'so is one with a null byte');
    const many = await get(s.port, '/api/volumes?' + Array.from({ length: 33 }, (_, i) => `from=%2Ff${i}`).join('&'));
    assert.equal(many.body.code, 'TOO_MANY_PATHS', 'and more than 32 folders');
    assert.equal(many.status, 400, 'with a 400');
    const enough = await get(s.port, '/api/volumes?' + Array.from({ length: 32 }, (_, i) => `from=%2Ff${i}`).join('&'));
    assert.equal(enough.status, 200, 'control: 32 are judged');
  } finally {
    setVolumeProviders(null);
    await s.close();
  }
});

test('on this Mac, GET /api/volumes?from= runs the real judgement against the folder named: from a folder on no drive this can read, neither the VM volume nor the temp folder is left out (review F2.1)', { skip: (process.platform !== 'darwin' || !fs.existsSync('/System/Volumes/VM')) && 'needs macOS\'s VM volume' }, async () => {
  const tmp = fs.realpathSync(os.tmpdir());
  const nowhere = path.join(tmp, `treemap-offloadDrop-no-such-folder-${process.pid}`);
  assert.equal(fs.existsSync(nowhere), false, 'control: the folder does not exist');
  setVolumeProviders({ list: () => [{ name: 'Temp', path: tmp }, { name: 'VM', path: '/System/Volumes/VM' }] });
  const s = await listen();
  try {
    const r = await get(s.port, `/api/volumes?from=${encodeURIComponent(nowhere)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.volumes.map((v: { path: string }) => v.path).sort(), [tmp, '/System/Volumes/VM'].sort(),
      'judged against that folder rather than this computer\'s own disk, nothing shares its space');
  } finally {
    setVolumeProviders(null);
    await s.close();
  }
});

test('a volume whose stats cannot be read is listed with nulls and a reason, never hidden', async () => {
  setVolumeProviders({
    list: () => [
      { name: 'Healthy', path: '/Volumes/Healthy' },
      { name: 'Locked', path: '/Volumes/Locked' },
    ],
    usage: async (target: string) => {
      if (target === '/Volumes/Locked') throw new Error('statfs reported implausible capacity');
      return { total: 2_000, free: 500 };
    },
  });
  const s = await listen();
  try {
    const r = await get(s.port, '/api/volumes');
    assert.equal(r.status, 200);
    assert.equal(r.body.volumes.length, 2, 'the unreadable drive still appears');
    const locked = r.body.volumes.find((v: any) => v.name === 'Locked');
    assert.equal(locked.freeBytes, null);
    assert.equal(locked.totalBytes, null);
    assert.match(locked.reason, /implausible capacity/);
    const healthy = r.body.volumes.find((v: any) => v.name === 'Healthy');
    assert.equal(healthy.freeBytes, 500);
    assert.equal(healthy.reason, undefined, 'a readable drive carries no excuse');
  } finally {
    setVolumeProviders(null);
    await s.close();
  }
});

test('volumes come back in deterministic name order regardless of mount enumeration', async () => {
  setVolumeProviders({
    list: () => [
      { name: 'Zebra', path: '/Volumes/Zebra' },
      { name: 'Alpha', path: '/Volumes/Alpha' },
      { name: 'Mango', path: '/Volumes/Mango' },
    ],
    usage: async () => ({ total: 10, free: 5 }),
  });
  const s = await listen();
  try {
    const r = await get(s.port, '/api/volumes');
    assert.deepEqual(r.body.volumes.map((v: any) => v.name), ['Alpha', 'Mango', 'Zebra']);
  } finally {
    setVolumeProviders(null);
    await s.close();
  }
});

/* ── §8.3: the drop gesture's promise — any failure rolls back cleanly ──
   The dock is a new gesture onto the proven pipeline, and the promise its
   manifest makes ("nothing local is touched until every copy has verified")
   rests on startOffload's rollback. No test anywhere forced a verify
   mismatch end-to-end before this one: the verifier is wrapped through the
   suite's ForTests seam idiom, the second file's read-back "fails", and the
   job must clean the destination completely and leave every original alone. */
import fs from 'node:fs';
import os from 'node:os';
import { createScanRecord } from '../src/services/diskScanner';
import { prepareOffload, startOffload, getOffloadJob, setOffloadVerifyForTests, setOffloadDiskUsageForTests } from '../src/services/offload';
import { AppError } from '../src/middleware/errorHandler';

test('a verify failure rolls back completely — destination cleaned, originals untouched', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-drop-src-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-drop-dest-'));
  fs.writeFileSync(path.join(src, 'keepme.bin'), Buffer.alloc(64 * 1024, 1));
  fs.writeFileSync(path.join(src, 'other.bin'), Buffer.alloc(64 * 1024, 2));
  const paths = [path.join(src, 'keepme.bin'), path.join(src, 'other.bin')];
  const scan = createScanRecord(src);
  scan.status = 'complete';
  scan.root = {
    name: path.basename(src), path: src, size: 128 * 1024, type: 'dir', modifiedAt: Date.now(), isHidden: false,
    children: paths.map((p) => ({ name: path.basename(p), path: p, size: 64 * 1024, type: 'file' as const, modifiedAt: Date.now(), isHidden: false })),
  };

  const restore = setOffloadVerifyForTests((destPath, realHash) =>
    destPath.endsWith('other.bin') ? realHash + '-corrupted' : realHash);
  try {
    const prepared = await prepareOffload(scan, paths, dest);
    const job = await startOffload(scan, paths, dest, prepared);
    await waitFor(() => getOffloadJob(job.jobId)!.status !== 'running', 'the offload job settling', 25);
    const done = getOffloadJob(job.jobId)!;
    assert.equal(done.status, 'error', 'a verify mismatch fails the job');
    assert.match(done.error ?? '', /Verification failed/, 'and says why');
    assert.match(done.error ?? '', /Nothing was deleted/, 'and says what that means');
  } finally {
    restore();
  }

  // Originals: byte-for-byte where they were.
  assert.ok(fs.existsSync(paths[0]) && fs.existsSync(paths[1]), 'both originals still exist');
  assert.equal(fs.statSync(paths[0]).size, 64 * 1024);
  // Destination: every copy this job created is gone — the rollback promise.
  const leftovers = fs.readdirSync(dest).filter((n) => n.endsWith('.bin'));
  assert.deepEqual(leftovers, [], 'no partial copies survive at the destination');
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
});

/* ── the review's RD-3: the dock's facts on the other platforms ── */
import { listExternalVolumes } from '../src/services/portableMode';
import { volumesUnavailableReason } from '../src/services/volumes';

test('Linux volumes under /run/media/<user> are flattened to the volumes, never the user dir', () => {
  // udisks mounts per-user: /run/media/alice/USBSTICK. Reporting "alice" at
  // /run/media/alice would put a fabricated tmpfs capacity on the dock and
  // hide the actual stick — the comment promising this flatten predates the
  // implementation.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-volumes-'));
  fs.mkdirSync(path.join(root, 'run', 'media', 'alice', 'USBSTICK'), { recursive: true });
  fs.mkdirSync(path.join(root, 'run', 'media', 'alice', 'BACKUP'), { recursive: true });
  fs.mkdirSync(path.join(root, 'mnt', 'nas'), { recursive: true });
  const vols = listExternalVolumes('linux', [path.join(root, 'run', 'media'), path.join(root, 'mnt')]);
  const names = vols.map((v) => v.name).sort();
  assert.deepEqual(names, ['BACKUP', 'USBSTICK', 'nas'], 'volumes, not user directories');
  assert.ok(vols.every((v) => v.name !== 'alice'), 'the per-user directory itself is never a volume');
  const stick = vols.find((v) => v.name === 'USBSTICK')!;
  assert.equal(stick.path, path.join(root, 'run', 'media', 'alice', 'USBSTICK'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a platform with no drive discovery says so — an empty dock is never a silent lie', () => {
  assert.match(volumesUnavailableReason('win32') ?? '', /Windows/i, 'win32 names the gap');
  assert.equal(volumesUnavailableReason('darwin'), null);
  assert.equal(volumesUnavailableReason('linux'), null);
});

/* ── the sentence a destination without room produces ──
   The refusal has to name numbers a person can act on. It used to divide by
   1073741824 and print one decimal, so a 30 MB offload onto a drive with
   20 MB free read "need 0.0 GB, only 0.0 GB free" — two zeroes about two real
   quantities, in the one app whose promise is that its numbers are true.
   Nothing asserted this string before. Free space is read through a ForTests
   seam because no test can make a real volume have 20 MB free on three
   operating systems, and patching the module export does nothing under tsx. */

/** Sizes are decimal (QA D09): 1 MB is 1,000,000 bytes, as the sentence prints them. */
const MB = 1_000_000;

function scanOfOneClaimedFile(dir: string, filePath: string, size: number) {
  const scan = createScanRecord(dir);
  scan.status = 'complete';
  scan.root = {
    name: path.basename(dir), path: dir, size, type: 'dir', modifiedAt: Date.now(), isHidden: false,
    children: [{ name: path.basename(filePath), path: filePath, size, type: 'file' as const, modifiedAt: Date.now(), isHidden: false }],
  };
  return scan;
}

test('a destination without room says what is needed and what is free, in units a person reads', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-full-src-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-full-dest-'));
  const movie = path.join(src, 'movie.mov');
  // prepareOffload plans from the scan tree and never stats the source, so the
  // file on disk can be a token: the 30 MB is the size the scan claims.
  fs.writeFileSync(movie, 'placeholder');
  const scan = scanOfOneClaimedFile(src, movie, 30 * MB);

  const restore = setOffloadDiskUsageForTests(async () => ({
    total: 1000 * MB, free: 20 * MB, used: 980 * MB,
  }));
  try {
    await assert.rejects(
      () => prepareOffload(scan, [movie], dest),
      (err: unknown) => {
        assert.ok(err instanceof AppError, 'the too-small destination is refused');
        assert.equal(err.code, 'DEST_FULL');
        assert.match(err.message, /30\.0 MB/, 'the payload is named at its real size');
        assert.match(err.message, /20\.0 MB/, 'and so is the room left on the drive');
        assert.doesNotMatch(err.message, /0\.0 GB/, 'megabytes are never rounded away to "0.0 GB"');
        return true;
      },
    );
  } finally {
    restore();
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('a destination that is only just too small never reads as though it had room', async () => {
  // 30.3 MB free against a 30.0 MB plan. FREE_SPACE_MARGIN refuses it, so the
  // sentence must not read "needs 30.0 MB … only 30.3 MB is free", which
  // states its own contradiction and invites the user to retry forever.
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-margin-src-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-margin-dest-'));
  const movie = path.join(src, 'movie.mov');
  fs.writeFileSync(movie, 'placeholder');
  const scan = scanOfOneClaimedFile(src, movie, 30 * MB);

  const restore = setOffloadDiskUsageForTests(async () => ({
    total: 1000 * MB, free: 30_300_000, used: 1000 * MB - 30_300_000,
  }));
  try {
    await assert.rejects(
      () => prepareOffload(scan, [movie], dest),
      (err: unknown) => {
        assert.ok(err instanceof AppError && err.code === 'DEST_FULL');
        assert.match(err.message, /30\.0 MB/, 'the plan');
        assert.match(err.message, /30\.3 MB/, 'and the free space, which is larger');
        assert.match(err.message, /room to spare/, 'so the headroom the check enforces is said out loud');
        return true;
      },
    );
  } finally {
    restore();
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});
