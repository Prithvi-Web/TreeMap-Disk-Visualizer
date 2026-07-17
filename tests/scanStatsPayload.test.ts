import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';
import { FileNode, ScanEvent } from '../src/models/types';

/**
 * The 'complete' frame must carry the scan's counters.
 *
 * A pruned tree cannot be counted client-side — that under-reports any scan big
 * enough to prune — so every headline number has to come from the server. If the
 * client must *fetch* them, the paint waits on three endpoints that each walk the
 * whole tree (measured: 213.6ms on a 458k tree, ~1.9s projected at 4M). That
 * delay is the regression behind the July 16 rollback.
 *
 * These counters are O(1) fields the walker already maintains, so they ride along
 * on the frame the client is receiving anyway and the paint costs no round-trip.
 */

function tinyRoot(): FileNode {
  return {
    name: 'root', path: '/t', size: 3, type: 'dir', modifiedAt: 0, isHidden: false,
    children: [
      { name: 'a.txt', path: '/t/a.txt', size: 3, type: 'file', modifiedAt: 0, isHidden: false },
    ],
  };
}

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Open the progress stream and collect frames until the server closes it. */
function collectEvents(port: number, scanId: string): Promise<ScanEvent[]> {
  return new Promise((resolve, reject) => {
    const events: ScanEvent[] = [];
    const req = http.get({ host: '127.0.0.1', port, path: `/api/scan/${scanId}/progress` }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let split: number;
        while ((split = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, split);
          buf = buf.slice(split + 2);
          if (!frame.startsWith('data: ')) continue; // keep-alive comment frame
          events.push(JSON.parse(frame.slice(6)) as ScanEvent);
        }
      });
      res.on('end', () => resolve(events));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => reject(new Error('progress stream never closed')));
  });
}

test("the 'complete' frame carries counters so the client paints without a round-trip", async () => {
  const scan = createScanRecord('/t');
  scan.status = 'complete';
  scan.root = tinyRoot();
  scan.fileCount = 1;
  scan.dirCount = 1;
  scan.scanned = 2;
  scan.finishedAt = scan.startedAt + 1234;

  const { port, close } = await listen();
  try {
    const events = await collectEvents(port, scan.scanId);
    const complete = events.find((e) => e.type === 'complete');
    assert.ok(complete, 'stream must deliver a complete frame');

    const c = complete as Extract<ScanEvent, { type: 'complete' }>;
    assert.ok(c.stats, 'complete frame must carry stats');
    assert.equal(c.stats.fileCount, 1);
    assert.equal(c.stats.dirCount, 1);
    assert.equal(c.stats.scanned, 2);
    assert.equal(c.stats.durationMs, 1234);
    assert.equal(c.stats.engine, scan.engine ?? 'walker');
  } finally {
    await close();
  }
});

test('the stats on the frame match what /stats reports for the same scan', async () => {
  const scan = createScanRecord('/t');
  scan.status = 'complete';
  scan.root = tinyRoot();
  scan.fileCount = 7;
  scan.dirCount = 3;
  scan.scanned = 10;
  scan.hardlinkedFiles = 2;
  scan.hardlinkedBytes = 512;
  scan.cloudFiles = 1;
  scan.cloudBytes = 99;
  scan.finishedAt = scan.startedAt + 50;

  const { port, close } = await listen();
  try {
    const events = await collectEvents(port, scan.scanId);
    const c = events.find((e) => e.type === 'complete') as Extract<ScanEvent, { type: 'complete' }>;

    const viaHttp: Record<string, unknown> = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `/api/scan/${scan.scanId}/stats` }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => { body += d; });
        res.on('end', () => resolve(JSON.parse(body)));
        res.on('error', reject);
      }).on('error', reject);
    });

    // One builder feeds both, so the two must not drift apart.
    for (const key of Object.keys(c.stats) as (keyof typeof c.stats)[]) {
      assert.deepEqual(c.stats[key], viaHttp[key], `stats.${String(key)} must match /stats`);
    }
  } finally {
    await close();
  }
});
