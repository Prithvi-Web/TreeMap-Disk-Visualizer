import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-preview-errors-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { startScan, getScan } from '../src/services/diskScanner';
import { updateSettings } from '../src/services/settings';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { waitFor } from './fixtures/waitFor';

/**
 * Hunt C87: an image preview that could not be opened answered a bare 500 with an image
 * Content-Type and an empty body, where a text file in the same state answers
 * 403 PERMISSION_DENIED with the access sentence. The image is now opened before anything is sent,
 * so the same refusal reaches the uniform { error, code }.
 *
 * A file with no permissions is still readable on Windows and by root, so this runs where the
 * system refuses the read — macOS and Linux as an ordinary user, which is every CI leg but Windows.
 */

const refusesUnreadable = process.platform !== 'win32' && process.getuid?.() !== 0;
const ROOT = fs.realpathSync(fileTempDir('treemap-preview-errors-'));
const LOCKED = path.join(ROOT, 'locked.png');
const OPEN = path.join(ROOT, 'open.png');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex');
let server: http.Server;
let port = 0;

function get(url: string): Promise<{ status: number; type: string; body: string }> {
  resetRateLimiter();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, agent: false }, (res) => {
      let buf = '';
      res.setEncoding('latin1');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body: buf }));
    }).on('error', reject);
  });
}

before(async () => {
  fs.writeFileSync(LOCKED, PNG);
  fs.writeFileSync(OPEN, PNG);
  await updateSettings({ engine: 'walker' });
  const s = await startScan(ROOT, {});
  await waitFor(() => getScan(s.scanId)?.status !== 'running', 'the scan');
  assert.equal(getScan(s.scanId)?.status, 'complete', getScan(s.scanId)?.error);
  fs.chmodSync(LOCKED, 0o000);
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  // The temp folder's own cleanup may have removed it already; a locked file there is removed all the same.
  if (fs.existsSync(LOCKED)) fs.chmodSync(LOCKED, 0o644);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

test('an image TreeMap may not read answers 403 PERMISSION_DENIED as { error, code }, not a bare 500 with an image type', { skip: refusesUnreadable ? false : 'this system lets the owner (or root) read a file with no permissions' }, async () => {
  const r = await get(`/api/files/preview?path=${encodeURIComponent(LOCKED)}`);
  assert.equal(r.status, 403, `${r.status} ${r.type} ${JSON.stringify(r.body)}`);
  assert.match(r.type, /^application\/json/);
  const body = JSON.parse(r.body);
  assert.equal(body.code, 'PERMISSION_DENIED');
  assert.equal(typeof body.error, 'string');
});

test('a readable image still streams inline (control)', async () => {
  const r = await get(`/api/files/preview?path=${encodeURIComponent(OPEN)}`);
  assert.deepEqual([r.status, r.type, Buffer.from(r.body, 'latin1').equals(PNG)], [200, 'image/png', true]);
});
