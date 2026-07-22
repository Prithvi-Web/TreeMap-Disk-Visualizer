import { Router, Request, Response } from 'express';
import { startScan, getScan, collectLargestFiles, collectFileTypes } from '../services/diskScanner';
import { buildTreemap, findNodeByPath } from '../utils/treemap';
import { pruneTree } from '../utils/pruneTree';
import { isInside } from '../utils/pathSanitizer';
import { guardBodyPath, guardBodyPaths, guardQueryPath } from '../middleware/pathGuard';
import { lookupNodes } from '../services/scanQueries';
import { AppError } from '../middleware/errorHandler';
import { getSettings } from '../services/settings';
import { streamCsv, streamPdf, streamXlsx } from '../services/reportExport';
import { sseSend as sseWrite } from '../utils/sse';
import { ScanResult, ScanEvent, ScanStats, BudgetStatus } from '../models/types';

export const scanRouter = Router();

/**
 * The one place scan counters are shaped, shared by /stats and the SSE
 * 'complete' frame so the two cannot drift apart.
 */
export function buildScanStats(scan: ScanResult): ScanStats {
  return {
    scanned: scan.scanned,
    fileCount: scan.fileCount,
    dirCount: scan.dirCount,
    engine: scan.engine ?? 'walker',
    ioThreads: scan.ioThreads ?? 0,
    durationMs: scan.finishedAt ? scan.finishedAt - scan.startedAt : 0,
    incremental: scan.incremental === true,
    cachedDirs: scan.cachedDirs ?? 0,
    walkedDirs: scan.walkedDirs ?? 0,
    hardlinkedFiles: scan.hardlinkedFiles ?? 0,
    hardlinkedBytes: scan.hardlinkedBytes ?? 0,
    cloudFiles: scan.cloudFiles ?? 0,
    cloudBytes: scan.cloudBytes ?? 0,
  };
}

/**
 * Node budget for the tree handed to the UI.
 *
 * The browser holds this tree and builds a lookup entry per node, so the cap
 * is about the *client's* memory, not just the ~512 MB string ceiling that
 * JSON.stringify enforces. 250k nodes is roughly 50 MB of JSON and well under
 * a second to serialize, parse and index — while a real 4M-object scan would
 * be ~600-800 MB and cannot be handed over at all.
 *
 * Detail beyond this budget isn't lost, only deferred: pruned directories keep
 * their true sizes and are fetched on demand from the subtree endpoint.
 */
export const PRUNE_MAX_NODES = 250_000;

/** Default budget for one on-demand drill-in. */
export const SUBTREE_MAX_NODES = 20_000;

/* ---------- SSE client registry (drained on graceful shutdown) ---------- */

interface SseClient {
  res: Response;
  timer: NodeJS.Timeout;
}
const sseClients = new Set<SseClient>();

/**
 * Typed front for the shared guarded writer (src/utils/sse.ts) so every call
 * site keeps ScanEvent union checking. The guard matters here: a 'complete'
 * event carrying a ~3.5M+ node tree exceeds V8's ~512 MB string cap, and this
 * runs on a timer where an escaping exception is uncaught.
 */
function sseSend(res: Response, event: ScanEvent): boolean {
  return sseWrite(res, event);
}

/** Why an oversized tree was refused, and what the user can do instead. */
export function treeTooLargeMessage(scan: ScanResult): string {
  const nodes = scan.fileCount + scan.dirCount || scan.scanned;
  return (
    `This scan is too large to display (${nodes.toLocaleString()} items). ` +
    `Try scanning a specific folder instead of the whole drive.`
  );
}

function closeClient(client: SseClient): void {
  clearInterval(client.timer);
  sseClients.delete(client);
  try {
    client.res.end();
  } catch {
    /* already gone */
  }
}

/** Called from index.ts on SIGTERM/SIGINT: tell clients, then close streams. */
export function drainSseClients(): void {
  for (const client of [...sseClients]) {
    try {
      sseSend(client.res, { type: 'shutdown' });
    } catch {
      /* socket already dead */
    }
    closeClient(client);
  }
}

export function activeSseCount(): number {
  return sseClients.size;
}

/* ------------------------------ Routes ------------------------------ */

/** Shared with insightRoutes: resolve a scanId or 404 cleanly. */
export function requireScan(_req: Request, idSource: unknown): ScanResult {
  const scan = getScan(String(idSource ?? ''));
  if (!scan) {
    throw new AppError(404, 'SCAN_NOT_FOUND', 'Unknown or expired scanId');
  }
  return scan;
}

/** POST /api/scan  { path } -> { scanId } */
scanRouter.post('/scan', guardBodyPath, async (req: Request, res: Response) => {
  const { path: scanPath, incremental } = req.body as { path: string; incremental?: boolean };
  const scan = await startScan(scanPath, { incremental: incremental === true }); // lstat failures -> 404/403
  res.status(202).json({ scanId: scan.scanId, incremental: scan.incremental === true });
});

/** GET /api/scan/:scanId/progress — Server-Sent Events stream. */
scanRouter.get('/scan/:scanId/progress', (req: Request, res: Response) => {
  const scan = requireScan(req, req.params.scanId);

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let lastScanned = -1;
  let lastBeat = Date.now();

  const finish = (): void => {
    if (scan.status === 'complete' && scan.root) {
      // Pruned: the full tree may be far larger than the UI can hold. The
      // sseSend guard below stays as a backstop — pruning should mean it never
      // trips, but a timer throw would take the app down, so we keep the net.
      const { root } = pruneTree(scan.root, { maxNodes: PRUNE_MAX_NODES });
      // Counters ride along: a pruned tree can't be counted client-side, and
      // making the client fetch them instead puts three full server-side tree
      // walks in front of the headline paint.
      if (!sseSend(res, { type: 'complete', root, stats: buildScanStats(scan) })) {
        sseSend(res, { type: 'error', message: treeTooLargeMessage(scan) });
      }
    } else {
      sseSend(res, { type: 'error', message: scan.error ?? 'Scan failed' });
    }
    closeClient(client);
  };

  const timer = setInterval(() => {
    try {
      if (scan.status !== 'running') {
        finish();
        return;
      }
      if (scan.scanned !== lastScanned) {
        lastScanned = scan.scanned;
        sseSend(res, { type: 'progress', scanned: scan.scanned, currentPath: scan.currentPath });
        lastBeat = Date.now();
      } else if (Date.now() - lastBeat > 10_000) {
        res.write(': keep-alive\n\n'); // comment frame, ignored by EventSource
        lastBeat = Date.now();
      }
    } catch {
      // Nothing sits above a timer callback to catch a throw, so anything
      // escaping would kill the process. Drop this client instead.
      closeClient(client);
    }
  }, 150);

  const client: SseClient = { res, timer };
  sseClients.add(client);

  // Send an immediate first frame so the UI updates without waiting a tick.
  if (scan.status === 'running') {
    sseSend(res, { type: 'progress', scanned: scan.scanned, currentPath: scan.currentPath });
    lastScanned = scan.scanned;
  } else {
    finish();
  }

  req.on('close', () => closeClient(client));
});

/** GET /api/scan/:scanId/result -> FileNode tree, or 202 while running. */
scanRouter.get('/scan/:scanId/result', (req: Request, res: Response) => {
  const scan = requireScan(req, req.params.scanId);
  if (scan.status === 'running') {
    res.status(202).json({
      status: 'running',
      scanned: scan.scanned,
      currentPath: scan.currentPath,
    });
    return;
  }
  if (scan.status === 'error') {
    throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  }
  // Pruned to the same budget as the SSE 'complete' event — this is the
  // frontend's fallback path when the stream stalls, so it must hand over a
  // tree of the same shape, not a 600 MB one that cannot be serialized.
  const pruned = scan.root ? pruneTree(scan.root, { maxNodes: PRUNE_MAX_NODES }).root : scan.root;
  res.json({
    status: 'complete',
    scanId: scan.scanId,
    rootPath: scan.rootPath,
    fileCount: scan.fileCount,
    dirCount: scan.dirCount,
    hardlinkedFiles: scan.hardlinkedFiles ?? 0,
    hardlinkedBytes: scan.hardlinkedBytes ?? 0,
    cloudFiles: scan.cloudFiles ?? 0,
    cloudBytes: scan.cloudBytes ?? 0,
    startedAt: scan.startedAt,
    finishedAt: scan.finishedAt,
    root: pruned,
  });
});

/**
 * GET /api/scan/:scanId/subtree?path=<p>&maxNodes=N
 *
 * A bounded nested subtree rooted at `path` — the drill-in counterpart to the
 * pruned tree sent on completion. The client grafts the result in when the
 * user opens a directory whose children were withheld.
 *
 * The response obeys pruneTree's invariants: any directory carrying `children`
 * carries all of them, and every `size` is the real recursive total.
 */
scanRouter.get('/scan/:scanId/subtree', guardQueryPath('path'), (req: Request, res: Response) => {
  const scan = requireScan(req, req.params.scanId);
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running', scanned: scan.scanned });
    return;
  }
  if (scan.status === 'error' || !scan.root) {
    throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  }

  const target = String(req.query.path ?? scan.rootPath);
  if (target !== scan.rootPath && !isInside(scan.rootPath, target)) {
    throw new AppError(403, 'OUTSIDE_SCAN_ROOT', 'path must be inside the scanned folder');
  }
  const node = findNodeByPath(scan.root, target);
  if (!node) throw new AppError(404, 'PATH_NOT_FOUND', 'That path is not in this scan');

  const maxNodes = clampInt(req.query.maxNodes, SUBTREE_MAX_NODES, 1, PRUNE_MAX_NODES);
  const { root, nodes, prunedDirs } = pruneTree(node, { maxNodes });
  res.json({ scanId: scan.scanId, root, nodes, prunedDirs });
});

/**
 * POST /api/scan/:scanId/nodes  { paths: [...] }
 *
 * Resolve paths to node metadata. The UI holds paths it may not hold nodes for
 * — the cleanup cart persists across sessions, and selection totals must not
 * read a pruned-away node as zero bytes. A path that isn't in this scan comes
 * back as null, which is a real answer rather than a silent zero.
 *
 * guardBodyPaths sanitizes each path and caps the batch at 500.
 */
scanRouter.post('/scan/:scanId/nodes', guardBodyPaths, (req: Request, res: Response) => {
  const scan = requireScan(req, req.params.scanId);
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running' });
    return;
  }
  if (scan.status === 'error' || !scan.root) {
    throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  }
  const { paths } = req.body as { paths: string[] };
  res.json({ scanId: scan.scanId, nodes: lookupNodes(scan.root, paths) });
});

/** GET /api/scan/:scanId/stats — counters incl. incremental cache usage. */
scanRouter.get('/scan/:scanId/stats', (req: Request, res: Response) => {
  const scan = requireScan(req, req.params.scanId);
  res.json({ scanId: scan.scanId, status: scan.status, ...buildScanStats(scan) });
});

/**
 * GET /api/scan/:scanId/budgets — saved folder budgets cross-referenced
 * against this scan. Returns only budgets whose folder is inside the scanned
 * root and present in the tree, each with its current size and overage.
 */
scanRouter.get('/scan/:scanId/budgets', async (req: Request, res: Response) => {
  const scan = requireScan(req, req.params.scanId);
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running' });
    return;
  }
  if (scan.status === 'error' || !scan.root) {
    throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  }
  const { budgets } = await getSettings();
  const out: BudgetStatus[] = [];
  for (const b of budgets) {
    if (b.path !== scan.rootPath && !isInside(scan.rootPath, b.path)) continue;
    const node = findNodeByPath(scan.root, b.path);
    if (!node || node.type !== 'dir') continue;
    out.push({
      path: b.path,
      name: node.name,
      maxBytes: b.maxBytes,
      actualBytes: node.size,
      overBy: node.size - b.maxBytes,
    });
  }
  out.sort((a, b) => b.overBy - a.overBy);
  res.json({ scanId: scan.scanId, budgets: out });
});

/**
 * GET /api/scan/:scanId/export?format=csv|xlsx|pdf&mode=files|folders
 * Downloads the scan as a report: streamed CSV or XLSX of every file/folder,
 * or a pdfmake text summary. Always sent as an attachment.
 */
scanRouter.get('/scan/:scanId/export', async (req: Request, res: Response) => {
  const scan = requireScan(req, req.params.scanId);
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running' });
    return;
  }
  if (scan.status === 'error' || !scan.root) {
    throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  }
  const complete = scan as ScanResult & { root: NonNullable<ScanResult['root']> };
  const format = String(req.query.format ?? 'csv');
  if (format === 'pdf') {
    await streamPdf(complete, res);
    return;
  }
  if (format === 'csv') {
    streamCsv(complete, req.query.mode === 'folders' ? 'folders' : 'files', res);
    return;
  }
  if (format === 'xlsx') {
    await streamXlsx(complete, req.query.mode === 'folders' ? 'folders' : 'files', res);
    return;
  }
  throw new AppError(400, 'BAD_FORMAT', 'format must be "csv", "xlsx" or "pdf"');
});

/**
 * GET /api/scan/:scanId/treemap?maxDepth=3&minSize=10240&root=<subpath>
 * Pre-computed squarified layout, coordinates in percent.
 */
scanRouter.get('/scan/:scanId/treemap', guardQueryPath('root'), (req: Request, res: Response) => {
  const scan = requireScan(req, req.params.scanId);
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running', scanned: scan.scanned });
    return;
  }
  if (scan.status === 'error' || !scan.root) {
    throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  }

  const maxDepth = clampInt(req.query.maxDepth, 3, 1, 8);
  const minSize = clampInt(req.query.minSize, 10_240, 0, Number.MAX_SAFE_INTEGER);

  let root = scan.root;
  const rootParam = req.query.root as string | undefined;
  if (rootParam && rootParam !== scan.rootPath) {
    if (!isInside(scan.rootPath, rootParam)) {
      throw new AppError(403, 'OUTSIDE_SCAN_ROOT', 'root must be inside the scanned folder');
    }
    const found = findNodeByPath(scan.root, rootParam);
    if (!found) throw new AppError(404, 'PATH_NOT_FOUND', 'That path is not in this scan');
    if (found.type !== 'dir' && !(found.container && found.children?.length)) {
      throw new AppError(400, 'NOT_A_DIRECTORY', 'Treemap root must be a directory or an opened container');
    }
    root = found;
  }

  const nodes = buildTreemap(root, { maxDepth, minSize, maxNodes: 20_000 });
  res.json({
    scanId: scan.scanId,
    root: { name: root.name, path: root.path, size: root.size, modifiedAt: root.modifiedAt },
    scanRootPath: scan.rootPath,
    maxDepth,
    minSize,
    nodes,
  });
});

/** GET /api/large-files?scanId=x&limit=50&minSize=1048576 */
scanRouter.get('/large-files', (req: Request, res: Response) => {
  const scan = requireScan(req, String(req.query.scanId ?? ''));
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running' });
    return;
  }
  if (!scan.root) throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');

  const limit = clampInt(req.query.limit, 50, 1, 1000);
  const minSize = clampInt(req.query.minSize, 1_048_576, 0, Number.MAX_SAFE_INTEGER);
  res.json({ files: collectLargestFiles(scan.root, limit, minSize) });
});

/** GET /api/file-types?scanId=x */
scanRouter.get('/file-types', (req: Request, res: Response) => {
  const scan = requireScan(req, String(req.query.scanId ?? ''));
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running' });
    return;
  }
  if (!scan.root) throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  res.json({ types: collectFileTypes(scan.root) });
});

export function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
