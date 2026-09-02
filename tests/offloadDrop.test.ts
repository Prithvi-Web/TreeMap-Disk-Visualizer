import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { setVolumeProviders } from '../src/services/volumes';

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
    for (let i = 0; i < 200 && getOffloadJob(job.jobId)!.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
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
  const scan = scanOfOneClaimedFile(src, movie, 30 * 1024 * 1024);

  const restore = setOffloadDiskUsageForTests(async () => ({
    total: 1024 * 1024 * 1024, free: 20 * 1024 * 1024, used: 1004 * 1024 * 1024,
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
  const scan = scanOfOneClaimedFile(src, movie, 30 * 1024 * 1024);

  const restore = setOffloadDiskUsageForTests(async () => ({
    total: 1024 * 1024 * 1024, free: 31_800_000, used: 1024 * 1024 * 1024 - 31_800_000,
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
