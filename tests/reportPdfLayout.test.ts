import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { Response } from 'express';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-reportPdfLayout-data-');

import { pdfTextWidth, pdfWrap, streamPdf } from '../src/services/reportExport';
import { formatBytes } from '../src/utils/formatBytes';
import { FileNode, ScanResult } from '../src/models/types';

/**
 * QA D36: in the PDF report, "Largest Files (top 20)" put each raw path in
 * an 8 pt cell of a ['*', 60, 60] table. pdfmake breaks lines only where
 * Unicode allows, a path offers no such place, and a cell whose shortest
 * possible width is wider than the star column pushes the fixed columns off
 * the page: the long paths ran off the right edge and the Size column was
 * not on the page at all.
 *
 * Proven here on the real report: streamPdf renders through pdfmake into
 * pdfkit, every text pdfkit is asked to draw is recorded with its position
 * and width, and nothing may end past the right margin — paths, the scanned
 * folder, extensions — while every size is drawn.
 */

const A4_WIDTH = 595.28;
const MARGIN_X = 40;
const RIGHT_EDGE = A4_WIDTH - MARGIN_X;

test('a wrapped path keeps every character, breaks after separators, and no line is wider than asked', () => {
  const wide = 'W'.repeat(120); // one segment wider than any line: must break mid-segment
  const p = `/Volumes/Archive Drive/Projects/2026/${wide}/node_modules/@scope/some-package/dist/esm/internal/helpers/really-long-file-name-without-breaks.js`;
  const maxWidth = 200;
  const out = pdfWrap(p, maxWidth, 8);
  const lines = out.split('\n');
  assert.equal(out.replace(/\n/g, ''), p, 'removing the line breaks gives back the path exactly');
  assert.ok(lines.length > 1);
  for (const l of lines) {
    assert.ok(pdfTextWidth(l, 8) <= maxWidth, `line "${l}" is ${pdfTextWidth(l, 8).toFixed(1)} pt, over ${maxWidth}`);
    assert.ok(l.length > 0, 'no empty line');
  }
  // A line ends mid-segment only where the 120-W segment had to be cut.
  for (const l of lines.slice(0, -1)) {
    if (!l.endsWith('/')) assert.match(l, /W$/, `"${l}" was cut mid-segment although its segment fits on a line`);
  }
  // Short text is left alone.
  assert.equal(pdfWrap('/Users/me/a.txt', maxWidth, 8), '/Users/me/a.txt');
});

test('widths are Helvetica\'s own: narrow and wide glyphs measure differently, unknown characters measure wide', () => {
  assert.equal(pdfTextWidth('i', 10), 2.22); // AFM width 222
  assert.equal(pdfTextWidth('W', 10), 9.44); // AFM width 944
  assert.ok(pdfTextWidth('日', 10) >= 10, 'a character outside the table counts as at least a full em');
});

function file(name: string, parent: string, size: number, ext?: string): FileNode {
  return { name, path: `${parent}/${name}`, size, type: 'file', modifiedAt: 1_752_000_000_000, isHidden: false, ...(ext ? { extension: ext } : {}) };
}

function longTree(): { root: FileNode; sizes: number[] } {
  // A long scanned folder with a segment pdfmake could not break: wider than the subtitle's whole line.
  const root = `/Volumes/Archive Drive/${'Backups-Of-Backups-'.repeat(4)}/${'W'.repeat(70)}`;
  const deep = `${root}/${'W'.repeat(90)}/${'segment-'.repeat(12)}end`;
  const wideExt = 'X'.repeat(70);
  const files = [
    file(`${'M'.repeat(80)}.mov`, deep, 9_000_000_000, 'mov'),
    file(`IMG_0001.${wideExt}`, deep, 4_000_000_000, wideExt),
    file('short.txt', root, 1_500_000, 'txt'),
  ];
  const dir: FileNode = { name: 'x', path: deep, size: 13_000_000_000, type: 'dir', modifiedAt: 1_752_000_000_000, isHidden: false, children: files.slice(0, 2) };
  const tree: FileNode = {
    name: 'Final', path: root, size: 13_001_500_000, type: 'dir', modifiedAt: 1_752_000_000_000, isHidden: false,
    children: [dir, files[2]!],
  };
  return { root: tree, sizes: files.map((f) => f.size) };
}

interface Drawn { text: string; x: number; width: number }

test('the PDF report keeps every path, the scanned folder and every extension inside the page, and every size is drawn', async (t) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfkit = require('@foliojs-fork/pdfkit');
  const PDFDocument = (pdfkit.default ?? pdfkit) as { prototype: { text: (...a: unknown[]) => unknown; widthOfString: (s: string, o?: unknown) => number } };
  const original = PDFDocument.prototype.text;
  const drawn: Drawn[] = [];
  t.mock.method(PDFDocument.prototype, 'text', function (this: { widthOfString: (s: string, o?: unknown) => number }, ...args: unknown[]) {
    const [text, x, , options] = args as [unknown, number, number, { textWidth?: number } | undefined];
    const s = String(text);
    drawn.push({ text: s, x, width: options?.textWidth ?? this.widthOfString(s) });
    return original.apply(this, args);
  });

  const { root, sizes } = longTree();
  const scan = { rootPath: root.path, root, fileCount: 3, dirCount: 2, status: 'complete' } as unknown as ScanResult;
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  const ended = new Promise<void>((resolve) => sink.on('end', () => resolve()));
  const res = sink as unknown as Response;
  (res as unknown as { status: () => unknown }).status = () => res;
  (res as unknown as { setHeader: () => void }).setHeader = () => {};
  await streamPdf(scan, res);
  await ended;
  assert.ok(Buffer.concat(chunks).subarray(0, 5).toString() === '%PDF-', 'a PDF came out');

  const past = drawn.filter((d) => d.x + d.width > RIGHT_EDGE + 0.01);
  assert.deepEqual(past.map((d) => `${d.text.slice(0, 40)}… ends at ${(d.x + d.width).toFixed(1)}`), [],
    `text drawn past the right margin (${RIGHT_EDGE} pt)`);
  // pdfmake draws "8.4 " and "GB" as two words, so sizes are read from the drawn text in order.
  const all = drawn.map((d) => d.text).join('');
  for (const size of sizes) {
    const label = formatBytes(size);
    assert.ok(all.includes(label), `the size ${label} is not drawn`);
  }
  // Nothing was lost to the wrapping: each long string is drawn in full, in order.
  assert.ok(all.includes(`${root.path}/${'W'.repeat(90)}/`), 'the long folder path is drawn in full');
  assert.ok(all.includes(`${'M'.repeat(80)}.mov`), 'the long file name is drawn in full');
  assert.ok(all.includes('X'.repeat(70)), 'the long extension is drawn in full');
});
