import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Request, Response, NextFunction } from 'express';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-reportCsvStream-data-');

import { CSV_CHUNK_CHARS, streamCsv } from '../src/services/reportExport';
import { errorHandler } from '../src/middleware/errorHandler';
import { FileNode, ScanResult } from '../src/models/types';

/**
 * QA D35: "Export CSV" of every file of a 303,478-file scan answered an empty
 * reply (curl 52), the server grew by 200 MB and logged nothing. streamCsv made
 * one res.write() per row in one synchronous loop: it never yielded, never
 * looked at write()'s answer and never waited for 'drain', so every row of the
 * scan piled up in memory in a single tick before the first byte left. And the
 * error handler ended a response whose headers had gone out with res.end() and
 * no log line — a failure mid-download read as a complete (short) file.
 *
 * The contract now, all of it counted (no clock): rows go out in chunks of
 * whole lines; a write that answers false is followed by nothing until 'drain'
 * (or the connection closing, which stops the export); the loop gives the
 * event loop a turn between chunks; and a small export's bytes are exactly
 * what they were.
 */

const T = 1_752_000_000_000;

function file(name: string, parent: string, size: number, mtime: number, ext?: string): FileNode {
  return { name, path: `${parent}/${name}`, size, type: 'file', modifiedAt: mtime, isHidden: false, ...(ext ? { extension: ext } : {}) };
}

/** A small tree with every CSV escape in it: a comma and quotes in a folder name, a missing date, no extension. */
function demoTree(): FileNode {
  const sub = '/demo/sub, "q"';
  return {
    name: 'demo', path: '/demo', size: 3_500, type: 'dir', modifiedAt: T, isHidden: false,
    children: [
      file('a.txt', '/demo', 1_000, T, 'txt'),
      {
        name: 'sub, "q"', path: sub, size: 2_500, type: 'dir', modifiedAt: T, isHidden: false,
        children: [
          file('b.png', sub, 2_000, T, 'png'),
          file('noext', sub, 500, Number.NaN),
          { name: 'empty', path: `${sub}/empty`, size: 0, type: 'dir', modifiedAt: T, isHidden: false, children: [] },
        ],
      },
    ],
  };
}

/** `files` synthetic files spread over 100 folders: big enough for many chunks, small enough for any laptop. */
function syntheticTree(files: number): FileNode {
  const dirs: FileNode[] = [];
  for (let d = 0; d < 100; d++) {
    const dp = `/big/folder-${d}`;
    const children: FileNode[] = [];
    for (let i = d; i < files; i += 100) children.push(file(`file-${i}.bin`, dp, i, T, 'bin'));
    dirs.push({ name: `folder-${d}`, path: dp, size: 0, type: 'dir', modifiedAt: T, isHidden: false, children });
  }
  return { name: 'big', path: '/big', size: 0, type: 'dir', modifiedAt: T, isHidden: false, children: dirs };
}

function scanOf(root: FileNode): ScanResult {
  return { rootPath: root.path, root, fileCount: 0, dirCount: 0, status: 'complete' } as unknown as ScanResult;
}

/** The members of a Response that streamCsv uses, with write()'s answer under the test's control. */
class FakeRes extends EventEmitter {
  chunks: string[] = [];
  headers: Record<string, string> = {};
  ended = false;
  destroyed = false;
  /** While true, every write answers false: the socket's buffer is full. */
  full = false;
  status(): this { return this; }
  setHeader(k: string, v: string): void { this.headers[k.toLowerCase()] = v; }
  write(chunk: string): boolean {
    assert.equal(this.ended, false, 'write after end');
    this.chunks.push(chunk);
    return !this.full;
  }
  end(): void { this.ended = true; }
  body(): string { return this.chunks.join(''); }
}

const asRes = (r: FakeRes): Response => r as unknown as Response;

/** Lets `n` turns of the event loop run (a count, never a duration). */
async function turns(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

const FILES_GOLDEN =
  'Path,Bytes,Last Modified,Extension\r\n'
  + '"/demo/sub, ""q""/noext",500,,\r\n'
  + '"/demo/sub, ""q""/b.png",2000,2025-07-08T18:40:00.000Z,png\r\n'
  + '/demo/a.txt,1000,2025-07-08T18:40:00.000Z,txt\r\n';
const FOLDERS_GOLDEN =
  'Path,Bytes,Last Modified,Files\r\n'
  + '"/demo/sub, ""q""/empty",0,2025-07-08T18:40:00.000Z,0\r\n'
  + '"/demo/sub, ""q""",2500,2025-07-08T18:40:00.000Z,2\r\n'
  + '/demo,3500,2025-07-08T18:40:00.000Z,3\r\n';

test('a small export is byte for byte what it always was, in both modes', async () => {
  for (const [mode, golden] of [['files', FILES_GOLDEN], ['folders', FOLDERS_GOLDEN]] as const) {
    const res = new FakeRes();
    await streamCsv(scanOf(demoTree()), mode, asRes(res));
    assert.equal(res.body(), golden, `${mode} CSV bytes changed`);
    assert.equal(res.ended, true);
    assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
    assert.match(res.headers['content-disposition'], new RegExp(`attachment; filename="treemap-demo-${mode}-\\d{8}\\.csv"`));
  }
});

test('a large export goes out in chunks of whole lines, never one write per row', async () => {
  const rows = 20_000;
  const res = new FakeRes();
  await streamCsv(scanOf(syntheticTree(rows)), 'files', asRes(res));
  const body = res.body();
  const lines = body.split('\r\n');
  assert.equal(lines.pop(), '', 'the export ends with a line break');
  assert.equal(lines.length, rows + 1, 'header + one line per file');
  assert.equal(lines[0], 'Path,Bytes,Last Modified,Extension');
  // Every file is there exactly once.
  const seen = new Set(lines.slice(1).map((l) => l.split(',')[0]));
  assert.equal(seen.size, rows);
  // Chunked: at most one write per CSV_CHUNK_CHARS of text (+1 for the tail), and no line split across writes.
  assert.ok(res.chunks.length <= Math.ceil(body.length / CSV_CHUNK_CHARS) + 1,
    `${res.chunks.length} writes for ${body.length} characters (one per row is the D35 bug)`);
  assert.ok(res.chunks.length > 1, 'a 20,000-row export is more than one chunk');
  for (const c of res.chunks) assert.ok(c.endsWith('\r\n'), 'a chunk ends on a whole line');
});

test('a write that answers false is followed by nothing until the response drains', async () => {
  const res = new FakeRes();
  res.full = true;
  const done = streamCsv(scanOf(syntheticTree(2_000)), 'files', asRes(res), 1_024);
  await turns(20);
  assert.equal(res.chunks.length, 1, 'nothing more is written while the buffer is full');
  assert.equal(res.ended, false);

  res.emit('drain');
  await turns(20);
  assert.equal(res.chunks.length, 2, 'one drain lets exactly one more chunk out while the buffer stays full');

  res.full = false;
  res.emit('drain');
  await done;
  assert.equal(res.ended, true);
  assert.equal(res.body().split('\r\n').length - 2, 2_000, 'every row arrived once the socket drained');
});

test('the export gives the event loop a turn between chunks even when the socket never pushes back', async () => {
  const res = new FakeRes();
  const done = streamCsv(scanOf(syntheticTree(2_000)), 'files', asRes(res), 1_024);
  // A macrotask queued now runs only when the export gives the event loop a
  // turn — an `await` on an already-settled promise is a microtask and does not.
  let writtenWhenTheLoopTurned = -1;
  setImmediate(() => { writtenWhenTheLoopTurned = res.chunks.length; });
  await done;
  assert.ok(res.chunks.length > 2, 'the export is several chunks');
  assert.ok(writtenWhenTheLoopTurned >= 0 && writtenWhenTheLoopTurned < res.chunks.length,
    `the event loop first turned with ${writtenWhenTheLoopTurned} of ${res.chunks.length} chunks written: the export never yielded`);
});

test('a connection that closes mid-download stops the export and says so in the log', async (t) => {
  const warned = t.mock.method(console, 'warn', () => {});
  const res = new FakeRes();
  res.full = true;
  const done = streamCsv(scanOf(syntheticTree(2_000)), 'files', asRes(res), 1_024);
  await turns(5);
  res.destroyed = true;
  res.emit('close');
  await turns(20);
  assert.equal(res.chunks.length, 1, 'nothing is written to a closed connection');
  await done;
  assert.equal(res.ended, false, 'a stopped export is never ended as if it were complete');
  const lines = warned.mock.calls.map((c) => c.arguments.map(String).join(' '));
  assert.ok(lines.some((l) => /CSV export/.test(l) && /closed/.test(l)), `no log line said the export stopped: ${JSON.stringify(lines)}`);
});

test('an error after the download started is logged and the connection is cut, never ended as complete', (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  let ended = 0;
  let destroyed = 0;
  const res = {
    headersSent: true,
    end: () => { ended++; },
    destroy: () => { destroyed++; },
    status: () => { throw new Error('status() after headers were sent'); },
  } as unknown as Response;
  const req = { method: 'GET', path: '/api/scan/abc/export', originalUrl: '/api/scan/abc/export?format=csv' } as unknown as Request;
  errorHandler(new Error('store went away'), req, res, (() => {}) as NextFunction);
  assert.equal(ended, 0, 'res.end() makes a truncated download look complete');
  assert.equal(destroyed, 1, 'the connection is destroyed so the client sees a failed download');
  const lines = logged.mock.calls.map((c) => c.arguments.map(String).join(' '));
  assert.ok(lines.some((l) => /store went away/.test(l) && /\/api\/scan\/abc\/export/.test(l)),
    `the failure is not in the log: ${JSON.stringify(lines)}`);
});
