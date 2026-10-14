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
import { ON_DISK_UNAVAILABLE, onDiskProvider, setOnDiskForTests } from '../src/services/facts/onDiskProvider';
import { platform } from '../src/platform';
import { waitFor, withinHangGuard } from './fixtures/waitFor';

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

test('what a file takes is read from the disk each time it is asked — never an answer kept from before the file changed (review F1.6)', { skip: !platform().blocksAreMeaningful && 'this system reports no blocks' }, async () => {
  // A second Find in the scan's 30 minutes was served the first one's
  // measure: a file written in full since read as the 0 B it once took.
  const dir = fs.realpathSync(fileTempDir('tm-ondisk-live-'));
  const file = path.join(dir, 'clip.mov');
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, DENSE); // claims 100 kB, takes nothing yet
  fs.closeSync(fd);
  const scanned = await call('POST', '/api/scan?wait=true&waitMs=55000', { path: dir });
  assert.equal(scanned.status, 200, JSON.stringify(scanned.body));
  const ask = async () => (await call('POST', '/api/facts', { scanId: scanned.body.scanId, paths: [file], providers: ['onDisk'] })).body.providers.onDisk;
  const before = await ask();
  assert.ok(before.values[file].bytes < DENSE, `control: it took less than it claims (${before.values[file].bytes})`);
  fs.writeFileSync(file, Buffer.alloc(DENSE, 7)); // written in full since
  const after = await ask();
  assert.equal(after.values[file].bytes, fs.statSync(file).blocks * 512, 'what it takes now, not what it took when first asked');
  assert.ok(after.values[file].bytes >= DENSE, 'control: now it takes what it claims');
});

test('a file whose drive stops answering is not waited on: its look has a deadline and is counted failed — never 0 — the rest of the request is not asked, and nothing more is asked until that look comes back (review F1.1)', { skip: !platform().blocksAreMeaningful && 'this system reports no blocks' }, async () => {
  // A NAS that went to sleep after the scan: Node's lstat of a file on it can
  // block for minutes or never settle. Clean Up's Find waited on this fact,
  // and every request held one more thread of the I/O pool. Here that file's
  // look never settles until the test lets it, and the deadline passes when
  // the test says so (count, don't time).
  const dir = fs.realpathSync(fileTempDir('tm-ondisk-stall-'));
  const stuck = path.join(dir, 'on-the-nas.mov');
  const beside = path.join(dir, 'beside.mov');
  fs.writeFileSync(stuck, Buffer.alloc(DENSE, 7));
  fs.writeFileSync(beside, Buffer.alloc(DENSE, 7));
  const scanned = await call('POST', '/api/scan?wait=true&waitMs=55000', { path: dir });
  assert.equal(scanned.status, 200, JSON.stringify(scanned.body));
  const scanId = scanned.body.scanId as string;

  const looked: string[] = [];
  const deadlines: Array<() => void> = [];
  let answer: (() => void) | null = null;
  setOnDiskForTests({
    lstat: (p) => {
      looked.push(p);
      if (p !== stuck) return fs.promises.lstat(p);
      return new Promise((resolve, reject) => { answer = () => { fs.promises.lstat(p).then(resolve, reject); }; });
    },
    deadline: () => {
      let pass = (): void => {};
      const late = new Promise<void>((resolve) => { pass = resolve; });
      deadlines.push(pass);
      return { late, cancel: () => {} };
    },
  });
  try {
    const signal = new AbortController().signal;
    const first = onDiskProvider.compute(scanId, [stuck, beside], signal);
    await waitFor(() => deadlines.length === 1, 'the stalled look to be given its deadline');
    deadlines[0](); // its deadline passes
    const stalled = await withinHangGuard(first, 'the request to answer once the deadline passed');
    assert.equal(stalled.available, true);
    assert.equal(stalled.values.has(stuck), false, 'the stalled file has no answer — never a 0');
    assert.deepEqual(stalled.stats, { requested: 2, computed: 0, skipped: 1, failed: 1 }, 'it failed, and the file after it was not asked');
    assert.deepEqual(looked, [stuck], 'nothing more was looked at in that request');

    // While that look is still out, a new request asks nothing: no second thread of the pool.
    const meanwhile = await onDiskProvider.compute(scanId, [beside], signal);
    assert.equal(meanwhile.available, false, 'unknown while the drive is silent');
    assert.match(meanwhile.reason ?? '', /did not answer/, `and it says why: ${meanwhile.reason}`);
    assert.deepEqual(looked, [stuck], 'and nothing was looked at');

    // Once the look comes back, files are measured again.
    answer!();
    await waitFor(async () => (await onDiskProvider.compute(scanId, [beside], signal)).available, 'files to be measured once the drive answers');
    const again = await onDiskProvider.compute(scanId, [beside], signal);
    assert.ok((again.values.get(beside)?.bytes ?? 0) >= DENSE, 'control: a file that answers is measured');
  } finally {
    setOnDiskForTests(null);
    if (answer) (answer as () => void)();
  }
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
