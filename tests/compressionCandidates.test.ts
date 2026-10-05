import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-compressionCandidates-data-');
process.env.TREEMAP_NO_GDU = '1';

import { startScan } from '../src/services/diskScanner';
import { setMediaTools, type MediaProbe, type MediaTools } from '../src/services/compressionAdvisor';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { waitFor } from './fixtures/waitFor';

/**
 * D56: videos ffprobe could not read were dropped without a word.
 *
 * GET /api/compression/candidates shortlists the scan's big video files and
 * probes each one. A probe that came back empty — ffprobe could not read the
 * file — went through `isWorthEncoding(null)`, which is false, and the file was
 * skipped exactly like one already in HEVC. Nothing counted it, so a scan of
 * large but unreadable videos answered `candidates: []` and the pane said
 * "everything large is already in an efficient format" about files nobody had
 * judged.
 *
 * The answer now counts what it looked at (`shortlisted`) and what it could not
 * read (`unreadable`), so the pane can tell "efficient" from "unknown".
 *
 * Read-only route; nothing is encoded or trashed. The videos are sparse files
 * (their size is reported, nothing is written), and the media tools are a fake.
 */

const ROOT = fs.realpathSync(fileTempDir('treemap-compressionCandidates-'));
const MB = 1024 * 1024;
for (const name of ['old-h264.mp4', 'already-hevc.mov', 'unreadable.mkv', 'no-video-stream.mp4']) {
  const fd = fs.openSync(path.join(ROOT, name), 'w');
  fs.ftruncateSync(fd, 80 * MB); // over MIN_CANDIDATE_BYTES (50 MiB), and sparse: nothing is written
  fs.closeSync(fd);
}

const PROBES: Record<string, MediaProbe | null> = {
  'old-h264.mp4': { durationSeconds: 60, videoCodec: 'h264', width: 1920, height: 1080, bitrateBps: 8e6, frameCount: 1440 },
  'already-hevc.mov': { durationSeconds: 60, videoCodec: 'hevc', width: 1920, height: 1080, bitrateBps: 4e6, frameCount: 1440 },
  'unreadable.mkv': null,
  'no-video-stream.mp4': { durationSeconds: 60, videoCodec: null, width: null, height: null, bitrateBps: 1e5, frameCount: null },
};

const fake: MediaTools = {
  availability: async () => ({ available: true, encoder: 'hevc_videotoolbox', hardwareCodecs: ['hevc'], mechanism: 'test' }),
  probe: async (file: string) => PROBES[path.basename(file)] ?? null,
  encode: async () => { throw new Error('this test never encodes'); },
};

let server: http.Server;
let port: number;
let scanId: string;

before(async () => {
  setMediaTools(fake);
  resetRateLimiter();
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  const scan = await startScan(ROOT);
  await waitFor(() => scan.status !== 'running', 'the scan of the video fixture');
  assert.equal(scan.status, 'complete', scan.error);
  scanId = scan.scanId;
});

after(async () => {
  setMediaTools(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function get(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

test('a video that could not be read is counted, not passed off as efficient', async () => {
  const r = await get(`/api/compression/candidates?scanId=${scanId}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.candidates.map((c: { name: string }) => c.name), ['old-h264.mp4'], 'only the H.264 file is worth re-encoding');
  assert.equal(r.body.shortlisted, 4, 'four large videos were looked at');
  assert.equal(r.body.unreadable, 2, 'two of them could not be read as video, so nobody judged them');
});

test('the route documents both counts', async () => {
  const r = await get('/api/openapi.json');
  const spec = r.body.paths['/api/compression/candidates'].get.responses['200'].content['application/json'].schema;
  assert.ok(spec.properties.shortlisted, 'shortlisted is in the spec');
  assert.ok(spec.properties.unreadable, 'unreadable is in the spec');
});
