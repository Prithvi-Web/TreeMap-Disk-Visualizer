import type { Response } from 'express';
import PdfPrinter from 'pdfmake/src/printer';
import type { TDocumentDefinitions, Content, TableCell } from 'pdfmake/interfaces';
import Excel from 'exceljs';
import { FileNode, ScanResult } from '../models/types';
import { collectLargestFiles, collectLargestFolders, collectFileTypes } from './diskScanner';
import { diskUsage } from './diskUsage';
import { formatBytes } from '../utils/formatBytes';

/**
 * reportExport — Feature 17. Turns a completed scan into a downloadable report:
 * streamed CSV or XLSX of every file or folder, and a human-readable PDF
 * summary built with pdfmake's built-in Helvetica (no font files, so it works
 * the same in the packaged desktop app). The treemap image is intentionally
 * not embedded — this is a text report.
 */

type CompleteScan = ScanResult & { root: NonNullable<ScanResult['root']> };

/* ----------------------------- CSV ----------------------------- */

function csvField(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function iso(ms: number): string {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}

function safeBase(scan: CompleteScan): string {
  return (scan.root.name || 'treemap').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'treemap';
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** Stream a CSV of every file, or every folder (recursive sizes), as attachment. */
export function streamCsv(scan: CompleteScan, mode: 'files' | 'folders', res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="treemap-${safeBase(scan)}-${mode}-${stamp()}.csv"`);
  const write = (line: string): void => { res.write(line + '\r\n'); };

  if (mode === 'files') {
    write('Path,Bytes,Last Modified,Extension');
    const stack: FileNode[] = [scan.root];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.type === 'file') {
        write(`${csvField(n.path)},${n.size},${iso(n.modifiedAt)},${csvField(n.extension ?? '')}`);
      } else if (n.children) {
        for (const c of n.children) stack.push(c);
      }
    }
  } else {
    write('Path,Bytes,Last Modified,Files');
    // Post-order so each folder is written with its recursive file count.
    const walk = (node: FileNode): number => {
      if (node.type === 'file') return 1;
      let count = 0;
      if (node.children) for (const c of node.children) count += walk(c);
      write(`${csvField(node.path)},${node.size},${iso(node.modifiedAt)},${count}`);
      return count;
    };
    walk(scan.root);
  }
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
 * tests. Folders mode is post-order, exactly like streamCsv, so every folder
 * row carries its recursive file count.
 */
export function* reportRows(root: FileNode, mode: 'files' | 'folders'): Generator<ReportRow, void, void> {
  if (mode === 'files') {
    const stack: FileNode[] = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.type === 'file') yield [n.path, n.size, rowDate(n.modifiedAt), n.extension ?? ''];
      else if (n.children) for (const c of n.children) stack.push(c);
    }
    return;
  }
  yield* folderRows(root);
}

function* folderRows(node: FileNode): Generator<ReportRow, number, void> {
  if (node.type === 'file') return 1;
  let count = 0;
  if (node.children) for (const c of node.children) count += yield* folderRows(c);
  yield [node.path, node.size, rowDate(node.modifiedAt), count];
  return count;
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
  for (const row of reportRows(scan.root, mode)) {
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
    const note = ws.addRow([`— truncated at ${maxRows.toLocaleString()} rows (Excel's sheet limit); export CSV for the full list —`]);
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
function getPrinter(): PdfPrinter {
  if (!printer) printer = new PdfPrinter(FONTS);
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

function buildDoc(
  scan: CompleteScan,
  topFiles: ReturnType<typeof collectLargestFiles>,
  topFolders: ReturnType<typeof collectLargestFolders>,
  types: ReturnType<typeof collectFileTypes>,
  disk: { total: number; free: number } | null,
): TDocumentDefinitions {
  const used = disk ? disk.total - disk.free : 0;
  const summaryRows: TableCell[][] = [
    [{ text: 'Scanned folder', style: 'k' }, { text: scan.rootPath, style: 'v' }],
    [{ text: 'Generated', style: 'k' }, { text: new Date().toLocaleString(), style: 'v' }],
    [{ text: 'Total size', style: 'k' }, { text: formatBytes(scan.root.size), style: 'v' }],
    [{ text: 'Files', style: 'k' }, { text: scan.fileCount.toLocaleString(), style: 'v' }],
    [{ text: 'Folders', style: 'k' }, { text: scan.dirCount.toLocaleString(), style: 'v' }],
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
      table: { widths: [110, '*'], body: summaryRows },
      layout: 'noBorders',
      margin: [0, 6, 0, 14],
    },
  ];

  content.push({ text: `Largest Files (top ${topFiles.length})`, style: 'h2' });
  content.push({
    table: {
      headerRows: 1,
      widths: ['*', 60, 60],
      body: [
        [th('Path'), th('Size'), th('Modified')],
        ...topFiles.map((f): TableCell[] => [
          { text: f.path, style: 'cell' },
          { text: formatBytes(f.size), style: 'cellR' },
          { text: dateShort(f.modifiedAt), style: 'cellR' },
        ]),
      ],
    },
    layout: 'lightHorizontalLines',
    margin: [0, 2, 0, 14],
  });

  content.push({ text: `Largest Folders (top ${topFolders.length})`, style: 'h2' });
  content.push({
    table: {
      headerRows: 1,
      widths: ['*', 60, 50],
      body: [
        [th('Path'), th('Size'), th('Files')],
        ...topFolders.map((f): TableCell[] => [
          { text: f.path, style: 'cell' },
          { text: formatBytes(f.size), style: 'cellR' },
          { text: f.fileCount.toLocaleString(), style: 'cellR' },
        ]),
      ],
    },
    layout: 'lightHorizontalLines',
    margin: [0, 2, 0, 14],
  });

  content.push({ text: `File Types by Size (top ${types.length})`, style: 'h2' });
  content.push({
    table: {
      headerRows: 1,
      widths: ['*', 70, 70],
      body: [
        [th('Extension'), th('Files'), th('Total Size')],
        ...types.map((t): TableCell[] => [
          { text: t.ext, style: 'cell' },
          { text: t.count.toLocaleString(), style: 'cellR' },
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
  const topFiles = collectLargestFiles(scan.root, 20, 1);
  const topFolders = collectLargestFolders(scan.root, 20, 1);
  const types = collectFileTypes(scan.root).slice(0, 15);

  let disk: { total: number; free: number } | null = null;
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
