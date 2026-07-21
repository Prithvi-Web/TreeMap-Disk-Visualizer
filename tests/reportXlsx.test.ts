import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { Response } from 'express';
import Excel from 'exceljs';
import { reportRows, streamXlsx } from '../src/services/reportExport';
import { FileNode, ScanResult } from '../src/models/types';

/**
 * XLSX export (Feature: Export to Excel). reportRows is the pure row builder —
 * it must emit exactly the CSV's columns, with bytes as numbers and dates as
 * Dates so Excel sorts/formats natively. streamXlsx is round-tripped through
 * exceljs's reader to prove the streamed bytes are a workbook Excel will open.
 */

function file(name: string, parent: string, size: number, mtime: number, ext?: string): FileNode {
  return { name, path: `${parent}/${name}`, size, type: 'file', modifiedAt: mtime, isHidden: false, ...(ext ? { extension: ext } : {}) };
}

const T = 1_752_000_000_000; // fixed epoch ms so date assertions are exact

function demoTree(): FileNode {
  return {
    name: 'demo', path: '/demo', size: 3_500, type: 'dir', modifiedAt: T, isHidden: false,
    children: [
      file('a.txt', '/demo', 1_000, T, 'txt'),
      {
        name: 'sub', path: '/demo/sub', size: 2_500, type: 'dir', modifiedAt: T, isHidden: false,
        children: [
          file('b.png', '/demo/sub', 2_000, T, 'png'),
          file('noext', '/demo/sub', 500, T),
          { name: 'empty', path: '/demo/sub/empty', size: 0, type: 'dir', modifiedAt: T, isHidden: false, children: [] },
        ],
      },
    ],
  };
}

test('files mode: one row per file with Path, Bytes, Date, Extension', () => {
  const rows = [...reportRows(demoTree(), 'files')];
  assert.equal(rows.length, 3);
  const byPath = new Map(rows.map((r) => [r[0], r]));

  const a = byPath.get('/demo/a.txt');
  assert.ok(a);
  assert.equal(a[1], 1_000); // bytes stay numeric
  assert.ok(a[2] instanceof Date);
  assert.equal((a[2] as Date).getTime(), T);
  assert.equal(a[3], 'txt');
  assert.equal(byPath.get('/demo/sub/noext')?.[3], ''); // extensionless: empty string, like the CSV
  assert.equal(byPath.has('/demo/sub'), false); // no folder rows in files mode
});

test('folders mode: post-order rows carry recursive file counts', () => {
  const rows = [...reportRows(demoTree(), 'folders')];
  const counts = new Map(rows.map((r) => [r[0], r[3]]));

  assert.equal(counts.get('/demo/sub/empty'), 0);
  assert.equal(counts.get('/demo/sub'), 2); // b.png + noext
  assert.equal(counts.get('/demo'), 3); // + a.txt
  // Post-order: every folder appears after all of its subfolders.
  const order = rows.map((r) => r[0]);
  assert.ok(order.indexOf('/demo/sub/empty') < order.indexOf('/demo/sub'));
  assert.ok(order.indexOf('/demo/sub') < order.indexOf('/demo'));
});

test('an unrepresentable mtime becomes an empty cell, never Invalid Date', () => {
  const bad = file('bad', '/demo', 1, Number.NaN, 'x');
  const root: FileNode = { name: 'demo', path: '/demo', size: 1, type: 'dir', modifiedAt: T, isHidden: false, children: [bad] };
  const [row] = [...reportRows(root, 'files')];
  assert.equal(row[2], null);
});

function fakeRes(sink: PassThrough): Response {
  const res = sink as unknown as Response & { headers: Record<string, string> };
  res.headers = {};
  (res as unknown as { status: (n: number) => unknown }).status = () => res;
  (res as unknown as { setHeader: (k: string, v: string) => void }).setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  return res;
}

async function roundTrip(mode: 'files' | 'folders', maxRows?: number): Promise<{ wb: Excel.Workbook; headers: Record<string, string> }> {
  const scan = { rootPath: '/demo', root: demoTree(), fileCount: 3, dirCount: 3, status: 'complete' } as unknown as ScanResult & { root: FileNode };
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  const res = fakeRes(sink);
  await streamXlsx(scan, mode, res, maxRows);
  const wb = new Excel.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks) as unknown as ArrayBuffer);
  return { wb, headers: (res as unknown as { headers: Record<string, string> }).headers };
}

test('streamXlsx produces a workbook exceljs itself can re-open, with typed cells', async () => {
  const { wb, headers } = await roundTrip('files');
  assert.equal(headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(headers['content-disposition'], /attachment; filename="treemap-demo-files-\d{8}\.xlsx"/);

  const ws = wb.getWorksheet('Files');
  assert.ok(ws);
  // Row.values is 1-indexed with a hole at [0] — compare from index 1.
  assert.deepEqual((ws.getRow(1).values as Excel.CellValue[]).slice(1), ['Path', 'Bytes', 'Last Modified', 'Extension']);
  assert.equal(ws.actualRowCount, 4); // header + 3 files
  // Find a.txt's row and check the cell types survived the round trip.
  let hit: Excel.Row | undefined;
  ws.eachRow((row) => { if (row.getCell(1).value === '/demo/a.txt') hit = row; });
  assert.ok(hit);
  assert.equal(hit.getCell(2).value, 1_000);
  assert.ok(hit.getCell(3).value instanceof Date);
});

test('folders workbook uses the Files count column', async () => {
  const { wb } = await roundTrip('folders');
  const ws = wb.getWorksheet('Folders');
  assert.ok(ws);
  assert.deepEqual((ws.getRow(1).values as Excel.CellValue[]).slice(1), ['Path', 'Bytes', 'Last Modified', 'Files']);
  let rootRow: Excel.Row | undefined;
  ws.eachRow((row) => { if (row.getCell(1).value === '/demo') rootRow = row; });
  assert.equal(rootRow?.getCell(4).value, 3);
});

test('scans past the row cap truncate with a visible notice instead of a corrupt sheet', async () => {
  const { wb } = await roundTrip('files', 2);
  const ws = wb.getWorksheet('Files');
  assert.ok(ws);
  assert.equal(ws.actualRowCount, 4); // header + 2 data rows + notice
  const last = ws.getRow(4).getCell(1).value;
  assert.match(String(last), /truncated at 2 rows/);
});
