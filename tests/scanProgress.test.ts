import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';
import { FileNode, ScanEvent } from '../src/models/types';

/**
 * Progress-stream failure modes.
 *
 * A finished tree is handed to the UI as one `complete` SSE frame, which means
 * one JSON.stringify of every node. Past roughly 3.5M nodes the result exceeds
 * V8's ~512 MB cap on a single string and stringify throws RangeError. That
 * throw lands in a setInterval callback, where Express cannot catch it, so it
 * killed the whole process.
 *
 * A root whose `toJSON` throws the identical RangeError reproduces this in
 * milliseconds instead of requiring a real 4-million-file disk.
 */

function unserializableRoot(): FileNode {
  return {
    name: 'root',
    path: '/too-big',
    size: 1,
    type: 'dir',
    modifiedAt: 0,
    isHidden: false,
    toJSON(): never {
      throw new RangeError('Invalid string length');
    },
  } as unknown as FileNode;
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

/**
 * Open the progress stream and collect frames until the server closes it.
 * `onFrame` lets a test mutate the scan in reaction to a frame.
 */
function collectEvents(
  port: number,
  scanId: string,
  onFrame: (event: ScanEvent) => void = () => {},
): Promise<ScanEvent[]> {
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
          const event = JSON.parse(frame.slice(6)) as ScanEvent;
          events.push(event);
          onFrame(event);
        }
      });
      res.on('end', () => resolve(events));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => reject(new Error('progress stream never closed')));
  });
}

test('a tree too large to serialize closes the stream with an error instead of crashing', async () => {
  const scan = createScanRecord('/too-big');
  scan.scanned = 4_235_109;
  scan.fileCount = 4_000_000;
  scan.dirCount = 235_109;

  const { port, close } = await listen();
  try {
    // The stream opens while the scan is still running, so completion is
    // delivered by the interval timer — the path that took the app down.
    const events = await collectEvents(port, scan.scanId, (event) => {
      if (event.type === 'progress') {
        scan.status = 'complete';
        scan.root = unserializableRoot();
      }
    });

    const last = events[events.length - 1];
    assert.equal(last.type, 'error', `expected a final error frame, got ${last.type}`);
    assert.match((last as { message: string }).message, /too large/i);
    // The message must name the scale so the user knows why it was refused.
    assert.match((last as { message: string }).message, /4,235,109/);
  } finally {
    await close();
  }
});

test('an oversized tree is reported the same way when the scan finished before the stream opened', async () => {
  const scan = createScanRecord('/too-big-already');
  scan.scanned = 9_000_000;
  scan.fileCount = 8_000_000;
  scan.dirCount = 1_000_000;
  scan.status = 'complete';
  scan.root = unserializableRoot();

  const { port, close } = await listen();
  try {
    const events = await collectEvents(port, scan.scanId);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.match((events[0] as { message: string }).message, /9,000,000/);
  } finally {
    await close();
  }
});

test('a normal tree still streams progress and completes', async () => {
  const scan = createScanRecord('/small');
  const root: FileNode = {
    name: 'small',
    path: '/small',
    size: 10,
    type: 'dir',
    modifiedAt: 0,
    isHidden: false,
    children: [
      { name: 'a.txt', path: '/small/a.txt', size: 10, type: 'file', modifiedAt: 0, isHidden: false },
    ],
  };

  const { port, close } = await listen();
  try {
    const events = await collectEvents(port, scan.scanId, (event) => {
      if (event.type === 'progress') {
        scan.status = 'complete';
        scan.root = root;
      }
    });

    const last = events[events.length - 1];
    assert.equal(last.type, 'complete', `expected a complete frame, got ${last.type}`);
    assert.deepEqual((last as { root: FileNode }).root, root);
  } finally {
    await close();
  }
});
