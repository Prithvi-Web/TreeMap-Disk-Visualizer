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
