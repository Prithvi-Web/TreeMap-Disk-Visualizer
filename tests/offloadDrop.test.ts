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
import { prepareOffload, startOffload, getOffloadJob, setOffloadVerifyForTests } from '../src/services/offload';

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
