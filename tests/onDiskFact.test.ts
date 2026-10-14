import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-onDiskFact-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { ON_DISK_UNAVAILABLE } from '../src/services/facts/onDiskProvider';
import { platform } from '../src/platform';

/**
 * Fifth browser pass F09: Clean Up › Custom Rules said "2 files · up to 3.9 GB,
 * freed when you empty the Trash" for holiday-4k.mov and raw-footage.mkv, which
 * `stat -f '%z %b'` showed take 0 blocks — sparse. The scan counts the size a
 * file claims; the `onDisk` fact says what it takes, for the page to count.
 */

/** One JSON request to a fresh app on an ephemeral port. */
async function call(method: string, url: string, body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    const payload = JSON.stringify(body);
    return await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : {} }));
      });
      r.on('error', reject);
      r.end(payload);
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const SPARSE_CLAIM = 50_000_000; // decimal: 50 MB claimed, and no block written
const DENSE = 100_000;

test('the onDisk fact says what each file takes on its disk — a sparse file far less than it claims — and has no answer for a folder or a file gone since the scan (F09)', { skip: !platform().blocksAreMeaningful && 'this system reports no blocks (see the next test)' }, async () => {
  const dir = fs.realpathSync(fileTempDir('tm-ondisk-'));
  const sparse = path.join(dir, 'raw-footage.mkv');
  const dense = path.join(dir, 'notes.bin');
  const gone = path.join(dir, 'gone.bin');
  const folder = path.join(dir, 'sub');
  fs.writeFileSync(dense, Buffer.alloc(DENSE, 7));
  fs.writeFileSync(gone, Buffer.alloc(10, 7));
  fs.mkdirSync(folder);
  const fd = fs.openSync(sparse, 'w');
  fs.ftruncateSync(fd, SPARSE_CLAIM); // claims 50 MB, writes nothing
  fs.closeSync(fd);
  const st = fs.statSync(sparse);
  assert.equal(st.size, SPARSE_CLAIM, 'control: the file claims 50 MB');
  assert.ok(st.blocks * 512 < SPARSE_CLAIM / 10, `control: this filesystem keeps it sparse (${st.blocks} blocks)`);

  const scanned = await call('POST', '/api/scan?wait=true&waitMs=55000', { path: dir });
  assert.equal(scanned.status, 200, JSON.stringify(scanned.body));
  fs.rmSync(gone);

  const r = await call('POST', '/api/facts', { scanId: scanned.body.scanId, paths: [sparse, dense, folder, gone], providers: ['onDisk'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const fact = r.body.providers.onDisk;
  assert.equal(fact.available, true);
  assert.equal(fact.values[sparse].bytes, st.blocks * 512, 'the sparse file: what it takes, not the 50 MB it claims');
  assert.ok(fact.values[dense].bytes >= DENSE, 'a file written in full takes at least what it claims');
  assert.equal(fact.values[folder], undefined, 'a folder has no answer here — never 0');
  assert.equal(fact.values[gone], undefined, 'nor a file gone since the scan');
  assert.deepEqual(fact.stats, { requested: 4, computed: 2, skipped: 1, failed: 1 }, 'and the counts say which is which');
});

test('where files report no blocks the onDisk fact is unavailable, saying why — never a zero (F09)', { skip: platform().blocksAreMeaningful && 'this system reports blocks' }, async () => {
  const dir = fs.realpathSync(fileTempDir('tm-ondisk-win-'));
  const file = path.join(dir, 'a.bin');
  fs.writeFileSync(file, Buffer.alloc(1000, 7));
  const scanned = await call('POST', '/api/scan?wait=true&waitMs=55000', { path: dir });
  const r = await call('POST', '/api/facts', { scanId: scanned.body.scanId, paths: [file], providers: ['onDisk'] });
  assert.equal(r.body.providers.onDisk.available, false);
  assert.equal(r.body.providers.onDisk.reason, ON_DISK_UNAVAILABLE);
  assert.deepEqual(r.body.providers.onDisk.values, {});
});
