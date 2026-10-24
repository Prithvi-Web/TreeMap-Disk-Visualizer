import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
const DATA_DIR = isolatedDataDir('treemap-encode-safety-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { startScan, getScan } from '../src/services/diskScanner';
import { setTrashStepForTests } from '../src/services/cleaner';
import { setMediaTools, getEncodeJob } from '../src/services/compressionAdvisor';
import { updateSettings } from '../src/services/settings';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { resetIdempotencyCache } from '../src/middleware/idempotency';
import { readAudit } from '../src/services/audit';
import { POLICY_FILE } from '../src/services/policy';
import { platform } from '../src/platform';
import { invalidateCapabilities } from '../src/platform/capabilities';
import { waitFor } from './fixtures/waitFor';

/**
 * Hunt C52: POST /api/compression/encode trashes each original once its encode verifies, but it
 * never held the batch to agent-policy.json's byte cap. Hunt C51: one video open in another
 * program (the Trash step refuses it) or gone since the scan stopped the whole job and threw away
 * the encode that had already verified; now that file keeps its original with the reason, and the
 * job goes on to the next.
 */

const FAKE_TRASH = fileTempDir('treemap-encode-safety-trash-');
const trashed: string[] = [];
let server: http.Server;
let port = 0;

function post(url: string, body: unknown): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  resetRateLimiter();
  resetIdempotencyCache();
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

async function scannedRootWith(names: string[], bytes = 512 * 1024): Promise<{ dir: string; files: string[] }> {
  const dir = fs.realpathSync(fileTempDir('treemap-encode-safety-root-'));
  const files = names.map((n) => path.join(dir, n));
  for (const f of files) fs.writeFileSync(f, Buffer.alloc(bytes, 7));
  const s = await startScan(dir, {});
  await waitFor(() => getScan(s.scanId)?.status !== 'running', `the scan of ${dir}`);
  assert.equal(getScan(s.scanId)?.status, 'complete', getScan(s.scanId)?.error);
  return { dir, files };
}

before(async () => {
  setTrashStepForTests(async (p: string) => {
    trashed.push(p);
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashed.length}-${path.basename(p)}`));
  });
  setMediaTools({
    async availability() { return { available: true, encoder: 'hevc_videotoolbox', hardwareCodecs: ['hevc'], mechanism: 'stand-in' }; },
    async probe(file: string) {
      if (path.basename(file) === 'unprobeable.mp4') throw new Error('the probe failed on this file (a test)');
      return { durationSeconds: 10, videoCodec: 'h264', width: 10, height: 10, bitrateBps: 1, frameCount: 100 };
    },
    async encode(_input: string, output: string, _enc: string, _d: number | null, onProgress: (f: number) => void) {
      fs.writeFileSync(output, Buffer.alloc(1024, 1));
      onProgress(1);
    },
  } as never);
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  await updateSettings({ engine: 'walker' });
});

after(async () => {
  setTrashStepForTests(null);
  setMediaTools(null);
  fs.rmSync(path.join(DATA_DIR, POLICY_FILE), { force: true });
  await new Promise<void>((r) => server.close(() => r()));
});

test('the encode is held to the byte cap: an oversized batch and an unsized file are refused, and each refusal audited', async () => {
  const { dir, files } = await scannedRootWith(['big.mp4']);
  const later = path.join(dir, 'later.mp4');
  fs.writeFileSync(later, Buffer.alloc(2048, 3));
  fs.writeFileSync(path.join(DATA_DIR, POLICY_FILE), JSON.stringify({ maxBytesPerOperation: 1000 }));
  try {
    const big = await post('/api/compression/encode', { paths: files, confirm: true });
    assert.deepEqual([big.status, big.body.code], [403, 'POLICY_BYTES_EXCEEDED'], JSON.stringify(big.body));
    let [line] = await readAudit(1);
    assert.deepEqual([line.action, line.outcome, line.code, line.bytes], ['compression.encode', 'refused', 'POLICY_BYTES_EXCEEDED', 512 * 1024]);
    const unsized = await post('/api/compression/encode', { paths: [later], confirm: true });
    assert.deepEqual([unsized.status, unsized.body.code], [403, 'POLICY_BYTES_UNKNOWN'], JSON.stringify(unsized.body));
    [line] = await readAudit(1);
    assert.deepEqual([line.outcome, line.code], ['refused', 'POLICY_BYTES_UNKNOWN']);
    assert.deepEqual(trashed, [], 'nothing reached a Trash step');
  } finally {
    fs.rmSync(path.join(DATA_DIR, POLICY_FILE), { force: true });
  }
});

test('a video open in another program keeps its original, gone ones are skipped, and the job goes on to the rest', async () => {
  const { files } = await scannedRootWith(['a.mp4', 'gone.mp4', 'unprobeable.mp4', 'b.mp4']);
  const [held, gone, unprobeable, fine] = files;
  fs.rmSync(gone);
  const provider = platform() as unknown as { getOpenHandlesBatch: (paths: string[]) => Promise<unknown>; probeOpenHandleGuard: () => Promise<unknown> };
  const batch = provider.getOpenHandlesBatch.bind(provider);
  const probe = provider.probeOpenHandleGuard.bind(provider);
  provider.getOpenHandlesBatch = (paths: string[]) => Promise.resolve({
    handles: paths.includes(held) ? [{ path: held, pid: process.pid + 1, processName: 'QuickTime Player' }] : [],
    complete: true,
  });
  provider.probeOpenHandleGuard = () => Promise.resolve({ available: true, mechanism: 'test' });
  invalidateCapabilities();
  try {
    const started = await post('/api/compression/encode', { paths: files, confirm: true });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => getEncodeJob(started.body.jobId)?.status !== 'running', 'the encode job');
    const job = getEncodeJob(started.body.jobId)!;
    assert.equal(job.status, 'complete', `the job is not stopped by one file: ${job.error}`);
    assert.equal(job.done, 4, 'every file was taken in turn');
    const byPath = new Map(job.results.map((r) => [r.path, r]));
    assert.equal(byPath.get(held)?.ok, false);
    assert.match(String(byPath.get(held)?.error), /^Kept the original — .*QuickTime Player/, 'the open file keeps its original, and the program is named');
    assert.equal(byPath.get(held)?.newBytes, 1024, 'its encode was made and verified before the Trash step refused it');
    assert.equal(byPath.get(gone)?.ok, false);
    assert.match(String(byPath.get(gone)?.error), /no longer there/, 'a file gone since the scan is skipped with the reason');
    assert.deepEqual([byPath.get(unprobeable)?.ok, byPath.get(unprobeable)?.error], [false, 'Kept the original — the probe failed on this file (a test)'], 'any other failure is that file\'s outcome');
    assert.equal(byPath.get(fine)?.ok, true, 'the next file is still re-encoded');
    assert.ok(fs.existsSync(held), 'the held original is where it was');
    assert.deepEqual(trashed.filter((p) => files.includes(p)), [fine], 'only the file that re-encoded went to the Trash');
  } finally {
    provider.getOpenHandlesBatch = batch;
    provider.probeOpenHandleGuard = probe;
    invalidateCapabilities();
  }
});
