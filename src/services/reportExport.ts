import type { Response } from 'express';
import { formatCount, machineHourCycle, UI_LOCALE } from '../utils/formatCount';
import type PdfPrinter from 'pdfmake/src/printer';
import type { TDocumentDefinitions, Content, TableCell } from 'pdfmake/interfaces';
import { ScanResult } from '../models/types';
import { collectLargestFiles, collectLargestFolders, collectFileTypes } from './diskScanner';
import { diskUsage } from './diskUsage';
import { formatBytes } from '../utils/formatBytes';
import { ScanStore, TreeSource, asStore, storeOf } from './scanStore';

/**
 * reportExport — Feature 17. Turns a completed scan into a downloadable report:
 * streamed CSV or XLSX of every file or folder, and a human-readable PDF
 * summary built with pdfmake's built-in Helvetica (no font files, so it works
 * the same in the packaged desktop app). The treemap image is intentionally
 * not embedded — this is a text report. Rows stream straight off the scan's
 * packed store; the whole tree is never buffered as objects.
 *
 * exceljs and pdfmake are loaded by the export that needs them, never at
 * start (Track U, U-6): every boot used to load both — with the MCP SDK,
 * 0.56–1.65 s in the Track U diagnosis — for exports most sessions never
 * make. The first XLSX or PDF export pays that cost instead, once. Only
 * loadExcel and getPrinter may load them (tests/bootModules.test.ts).
 */

type CompleteScan = ScanResult;
type ExcelModule = typeof import('exceljs');

let excelModule: ExcelModule | null = null;
/** exceljs, loaded on the first XLSX export and kept for the next. */
function loadExcel(): ExcelModule {
  if (!excelModule) excelModule = require('exceljs') as ExcelModule;
  return excelModule;
}

/* ----------------------------- CSV ----------------------------- */

function csvField(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function safeBase(scan: CompleteScan): string {
  const store = storeOf(scan);
  return (store.name(store.rootId) || 'treemap').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'treemap';
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function totalSize(scan: CompleteScan): number {
  const store = storeOf(scan);
  return store.size(store.rootId);
}

/** How much CSV text (in characters) goes out per res.write(). */
export const CSV_CHUNK_CHARS = 64 * 1024;

/** Resolves once `res` drains or closes, whichever comes first. */
function drainedOrClosed(res: Response): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => { res.off('drain', done); res.off('close', done); resolve(); };
    res.once('drain', done);
    res.once('close', done);
  });
}

/** One turn of the event loop, so sockets, timers and other requests run between chunks. */
const yieldTurn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Stream a CSV of every file, or every folder (recursive sizes), as attachment.
 *
 * QA D35: this used to be one res.write() per row in one synchronous loop, so
 * a 303,478-file export piled every row up in memory in a single tick (+200 MB)
 * and the client got an empty reply. Rows now go out in chunks of whole lines
 * (`chunkChars` of text each); after a write that answers false nothing more
 * is written until the response drains, the event loop gets a turn between
 * chunks either way, and a connection that closes stops the export with a log
 * line instead of a silent short file. The bytes are exactly what they were.
 */
export async function streamCsv(
  scan: CompleteScan,
  mode: 'files' | 'folders',
  res: Response,
  chunkChars: number = CSV_CHUNK_CHARS, // injectable so tests can make many chunks from a small tree
): Promise<void> {
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="treemap-${safeBase(scan)}-${mode}-${stamp()}.csv"`);

  let pending = (mode === 'files' ? 'Path,Bytes,Last Modified,Extension' : 'Path,Bytes,Last Modified,Files') + '\r\n';
  let rows = 0;
  /** Sends what is pending; false once the connection is gone and the export must stop. */
  const flush = async (): Promise<boolean> => {
    const fits = res.write(pending);
    pending = '';
    if (!fits) await drainedOrClosed(res);
    else await yieldTurn();
    if (res.destroyed || res.writableEnded) {
      console.warn(`[export] CSV export (${mode}) stopped after ${formatCount(rows)} rows: the connection closed before it finished.`);
      return false;
    }
    return true;
  };

  for (const row of reportRows(storeOf(scan), mode)) {
    pending += `${csvField(row[0])},${row[1]},${row[2] ? row[2].toISOString() : ''},${typeof row[3] === 'string' ? csvField(row[3]) : row[3]}\r\n`;
    rows++;
    if (pending.length >= chunkChars && !(await flush())) return;
  }
  if (pending) res.write(pending);
  res.end();
}

/* ----------------------------- XLSX ----------------------------- */

/** One worksheet row: Path, Bytes, Last Modified, Extension (files) / recursive file count (folders). */
export type ReportRow = [string, number, Date | null, string | number];

function rowDate(ms: number): Date | null {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * The same rows the CSV emits, as typed values (bytes as numbers, dates as
 * Dates) so spreadsheet cells sort and format natively. Pure and exported for
 * tests. Folders mode is post-order, exactly like before, so every folder
 * row carries its recursive file count. Traversal orders replicate the
 * original stack/recursion exactly.
 */
export function* reportRows(source: TreeSource, mode: 'files' | 'folders'): Generator<ReportRow, void, void> {
  const store = asStore(source);
  if (mode === 'files') {
    // The original pushed children in order onto a pop-stack — last child
    // first. Kept byte-for-byte so exports diff clean across versions.
    const stack: number[] = [store.rootId];
    while (stack.length) {
      const id = stack.pop() as number;
      if (!store.isDir(id)) {
        yield [store.path(id), store.size(id), rowDate(store.modifiedAt(id)), store.extension(id) ?? ''];
      } else {
        for (const c of store.childIds(id)) stack.push(c);
      }
    }
    return;
  }
  // Post-order with explicit frames (no recursion on deep trees).
  interface Frame { id: number; kids: number[]; next: number; count: number }
  const frame = (id: number): Frame => ({ id, kids: store.isDir(id) ? store.childIds(id) : [], next: 0, count: 0 });
  const stack: Frame[] = [frame(store.rootId)];
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (!store.isDir(f.id)) {
      stack.pop();
      if (stack.length) stack[stack.length - 1].count += 1;
      continue;
    }
    if (f.next < f.kids.length) {
      stack.push(frame(f.kids[f.next++]));
      continue;
    }
    stack.pop();
    yield [store.path(f.id), store.size(f.id), rowDate(store.modifiedAt(f.id)), f.count];
    if (stack.length) stack[stack.length - 1].count += f.count;
  }
}

/** Excel caps a sheet at 1,048,576 rows — leave room for the header + truncation notice. */
export const XLSX_MAX_DATA_ROWS = 1_048_574;

/**
 * Stream an .xlsx of every file or folder as an attachment. Uses exceljs's
 * streaming WorkbookWriter so rows go out as they're built instead of holding
 * a multi-million-row workbook in memory; backpressure from the response is
 * honored between batches. Scans beyond Excel's row limit get a visible
 * truncation notice rather than a silently short sheet.
 */
export async function streamXlsx(
  scan: CompleteScan,
  mode: 'files' | 'folders',
  res: Response,
  maxRows: number = XLSX_MAX_DATA_ROWS // injectable so tests can exercise truncation cheaply
): Promise<void> {
  // Loaded before anything is written, so a library that fails to load still leaves the error handler a clean response.
  const Excel = loadExcel();
  res.status(200);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="treemap-${safeBase(scan)}-${mode}-${stamp()}.xlsx"`);

  const wb = new Excel.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true, useSharedStrings: false });
  const ws = wb.addWorksheet(mode === 'files' ? 'Files' : 'Folders', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = [
    { width: 78 },
    { width: 14 },
    { width: 19, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
    { width: 12 },
  ];
  const header = ws.addRow(
    mode === 'files' ? ['Path', 'Bytes', 'Last Modified', 'Extension'] : ['Path', 'Bytes', 'Last Modified', 'Files']
  );
  header.font = { bold: true };
  header.commit();

  let written = 0;
  let truncated = false;
  for (const row of reportRows(storeOf(scan), mode)) {
    if (written >= maxRows) { truncated = true; break; }
    ws.addRow(row).commit();
    written++;
    // Every 16k rows, let a saturated response drain before piling on more.
    if ((written & 0x3fff) === 0 && res.writableNeedDrain) {
      await new Promise<void>((resolve) => {
        const done = (): void => { res.off('drain', done); res.off('close', done); resolve(); };
        res.once('drain', done);
        res.once('close', done);
      });
      if (res.destroyed || res.writableEnded) return; // client went away mid-download
    }
  }
  if (truncated) {
    const note = ws.addRow([`— truncated at ${formatCount(maxRows)} rows (Excel's sheet limit); export CSV for the full list —`]);
    note.font = { italic: true };
    note.commit();
  }
  ws.commit();
  await wb.commit();
}

/* ----------------------------- PDF ----------------------------- */

const FONTS = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
};

let printer: PdfPrinter | null = null;
/** pdfmake's printer, loaded on the first PDF export and kept for the next. */
function getPrinter(): PdfPrinter {
  if (!printer) {
    const Printer = require('pdfmake/src/printer') as typeof import('pdfmake/src/printer');
    printer = new Printer(FONTS);
  }
  return printer;
}

function th(text: string): TableCell {
  return { text, style: 'th' };
}

function dateShort(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/*
 * Long text in the PDF (QA D36). pdfmake breaks a line only where Unicode
 * allows one, and a path offers none: a long path was one unbreakable word,
 * and a cell whose narrowest possible width is wider than its '*' column
 * pushes the fixed columns off the page — the paths ran off the right edge and
 * the Size column was not on the page at all. (A plain paragraph is fine:
 * pdfmake cuts a word wider than the page there.) So every long string in a
 * table cell is broken into lines that fit before pdfmake sees it, measured
 * with Helvetica's own metrics. A '\n' is pdfmake's line break; U+200B is not an option, because
 * the standard-14 Helvetica is WinAnsi and has no glyph for it.
 */

/** A4 width less the 40 pt side margins (pageMargins below). */
const CONTENT_WIDTH_PT = 595.28 - 2 * 40;
/** The font sizes of the table styles long text is drawn in: 'cell' and 'v' (the default size). */
const CELL_PT = 8;
const VALUE_PT = 9;
/** The fixed columns of each table that has a '*' column, so the widths and the wrap budget cannot drift apart. */
const SUMMARY_FIXED = [110];
const FILES_FIXED = [60, 60];
const FOLDERS_FIXED = [60, 50];
const TYPES_FIXED = [70, 70];

/**
 * The width pdfmake gives a table's single '*' column: the content width less
 * the fixed columns and the cell padding between columns (pdfmake's built-in
 * 'lightHorizontalLines' pads 8 pt on each side of every inner column edge,
 * 'noBorders' 4 pt), less 1 pt so rounding can never tip a line over.
 */
function starColumnWidth(fixed: readonly number[], layout: 'lightHorizontalLines' | 'noBorders'): number {
  const gap = layout === 'lightHorizontalLines' ? 16 : 8;
  return CONTENT_WIDTH_PT - fixed.reduce((a, b) => a + b, 0) - gap * fixed.length - 1;
}

/**
 * Helvetica's advance widths (1/1000 em) for ' ' … '~', from the font's AFM —
 * the metrics pdfmake lays the report out with. Two follow WinAnsi, which the
 * standard fonts draw in, where it is the wider: ' (222) and ` (333).
 */
const HELVETICA_ASCII_WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 222, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
/** Any other character counts as the widest glyph in the table, so a line is never wider than measured. */
const UNMEASURED_CHAR_WIDTH = 1015;

/** The width of `text` in points, drawn in Helvetica at `fontSize`. Exported for tests. */
export function pdfTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    units += c >= 32 && c <= 126 ? (HELVETICA_ASCII_WIDTHS[c - 32] as number) : UNMEASURED_CHAR_WIDTH;
  }
  return (units * fontSize) / 1000;
}

/**
 * `text` broken into lines no wider than `maxWidth` points at `fontSize`,
 * joined with '\n': after a path separator where it can, mid-segment only
 * where one segment is wider than a whole line. Removing the '\n's gives back
 * `text` exactly; text that fits is returned as is. Exported for tests.
 */
export function pdfWrap(text: string, maxWidth: number, fontSize: number): string {
  if (pdfTextWidth(text, fontSize) <= maxWidth) return text;
  const pieces = text.match(/[^/\\]*[/\\]|[^/\\]+/g) ?? [text];
  const lines: string[] = [];
  let line = '';
  for (const piece of pieces) {
    if (pdfTextWidth(line + piece, fontSize) <= maxWidth) {
      line += piece;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    // Starts the piece on a line of its own, cut only if even that is too narrow.
    for (const ch of piece) {
      if (line && pdfTextWidth(line + ch, fontSize) > maxWidth) {
        lines.push(line);
        line = '';
      }
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

function buildDoc(
  scan: CompleteScan,
  topFiles: ReturnType<typeof collectLargestFiles>,
  topFolders: ReturnType<typeof collectLargestFolders>,
  types: ReturnType<typeof collectFileTypes>,
  disk: { total: number; free: number; used: number } | null,
): TDocumentDefinitions {
  const used = disk ? disk.used : 0;
  const summaryRows: TableCell[][] = [
    [{ text: 'Scanned folder', style: 'k' }, { text: pdfWrap(scan.rootPath, starColumnWidth(SUMMARY_FIXED, 'noBorders'), VALUE_PT), style: 'v' }],
    // English like every date in TreeMap; the machine keeps its clock and time zone.
    [{ text: 'Generated', style: 'k' },
    { text: new Date().toLocaleString(UI_LOCALE, { dateStyle: 'medium', timeStyle: 'short', hourCycle: machineHourCycle() }), style: 'v' }],
    [{ text: 'Total size', style: 'k' }, { text: formatBytes(totalSize(scan)), style: 'v' }],
    [{ text: 'Files', style: 'k' }, { text: formatCount(scan.fileCount), style: 'v' }],
    [{ text: 'Folders', style: 'k' }, { text: formatCount(scan.dirCount), style: 'v' }],
  ];
  if (disk) {
    summaryRows.push([
      { text: 'Volume', style: 'k' },
      { text: `${formatBytes(used)} used of ${formatBytes(disk.total)} (${formatBytes(disk.free)} free)`, style: 'v' },
    ]);
  }

  const content: Content[] = [
    { text: 'TreeMap Disk Report', style: 'title' },
    { text: scan.rootPath, style: 'subtitle' },
    {
      table: { widths: [...SUMMARY_FIXED, '*'], body: summaryRows },
      layout: 'noBorders',
      margin: [0, 6, 0, 14],
    },
  ];

  content.push({ text: `Largest files (top ${topFiles.length})`, style: 'h2' });
  content.push({
    table: {
      headerRows: 1,
      widths: ['*', ...FILES_FIXED],
      body: [
        [th('Path'), th('Size'), th('Modified')],
        ...topFiles.map((f): TableCell[] => [
          { text: pdfWrap(f.path, starColumnWidth(FILES_FIXED, 'lightHorizontalLines'), CELL_PT), style: 'cell' },
          { text: formatBytes(f.size), style: 'cellR' },
          { text: dateShort(f.modifiedAt), style: 'cellR' },
        ]),
      ],
    },
    layout: 'lightHorizontalLines',
    margin: [0, 2, 0, 14],
  });

  content.push({ text: `Largest folders (top ${topFolders.length})`, style: 'h2' });
  content.push({
    table: {
      headerRows: 1,
      widths: ['*', ...FOLDERS_FIXED],
      body: [
        [th('Path'), th('Size'), th('Files')],
        ...topFolders.map((f): TableCell[] => [
          { text: pdfWrap(f.path, starColumnWidth(FOLDERS_FIXED, 'lightHorizontalLines'), CELL_PT), style: 'cell' },
          { text: formatBytes(f.size), style: 'cellR' },
          { text: formatCount(f.fileCount), style: 'cellR' },
        ]),
      ],
    },
    layout: 'lightHorizontalLines',
    margin: [0, 2, 0, 14],
  });

  content.push({ text: `File types by size (top ${types.length})`, style: 'h2' });
  content.push({
    table: {
      headerRows: 1,
      widths: ['*', ...TYPES_FIXED],
      body: [
        [th('Extension'), th('Files'), th('Total Size')],
        ...types.map((t): TableCell[] => [
          { text: pdfWrap(t.ext, starColumnWidth(TYPES_FIXED, 'lightHorizontalLines'), CELL_PT), style: 'cell' },
          { text: formatCount(t.count), style: 'cellR' },
          { text: formatBytes(t.totalSize), style: 'cellR' },
        ]),
      ],
    },
    layout: 'lightHorizontalLines',
    margin: [0, 2, 0, 4],
  });

  return {
    content,
    pageSize: 'A4',
    pageMargins: [40, 44, 40, 44],
    defaultStyle: { font: 'Helvetica', fontSize: 9, color: '#1c1c1e' },
    styles: {
      title: { fontSize: 20, bold: true, color: '#0a84ff' },
      subtitle: { fontSize: 9, color: '#8a8a8e', margin: [0, 2, 0, 0] },
      h2: { fontSize: 12, bold: true, margin: [0, 8, 0, 4] },
      th: { bold: true, fontSize: 8, color: '#48484a', fillColor: '#f2f2f7' },
      k: { color: '#8a8a8e', margin: [0, 1, 0, 1] },
      v: { color: '#1c1c1e', margin: [0, 1, 0, 1] },
      cell: { fontSize: 8 },
      cellR: { fontSize: 8, alignment: 'right' },
    },
    footer: (currentPage: number, pageCount: number): Content => ({
      text: `TreeMap • ${dateShort(Date.now())} • Page ${currentPage} of ${pageCount}`,
      alignment: 'center',
      fontSize: 7,
      color: '#aeaeb2',
      margin: [0, 8, 0, 0],
    }),
  };
}

/** Generate and stream the PDF report as an attachment. */
export async function streamPdf(scan: CompleteScan, res: Response): Promise<void> {
  const store = storeOf(scan);
  const topFiles = collectLargestFiles(store, 20, 1);
  const topFolders = collectLargestFolders(store, 20, 1);
  const types = collectFileTypes(store).slice(0, 15);

  let disk: { total: number; free: number; used: number } | null = null;
  try {
    disk = await diskUsage(scan.rootPath);
  } catch {
    disk = null; // best-effort; df can fail on odd mounts
  }

  const doc = getPrinter().createPdfKitDocument(buildDoc(scan, topFiles, topFolders, types, disk));
  res.status(200);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="treemap-${safeBase(scan)}-${stamp()}.pdf"`);
  doc.on('error', () => {
    if (!res.headersSent) res.status(500);
    res.end();
  });
  doc.pipe(res);
  doc.end();
}
