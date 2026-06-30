import { Router, Request, Response } from 'express';
import { startScan, getScan, collectLargestFiles, collectFileTypes } from '../services/diskScanner';
import { buildTreemap, findNodeByPath } from '../utils/treemap';
import { isInside } from '../utils/pathSanitizer';
import { guardBodyPath, guardQueryPath } from '../middleware/pathGuard';
import { AppError } from '../middleware/errorHandler';
import { getSettings } from '../services/settings';
import { ScanResult, ScanEvent, BudgetStatus } from '../models/types';

export const scanRouter = Router();

/* ---------- SSE client registry (drained on graceful shutdown) ---------- */

interface SseClient {
  res: Response;
  timer: NodeJS.Timeout;
}
const sseClients = new Set<SseClient>();

function sseSend(res: Response, event: ScanEvent): void {
  // JSON.stringify never emits raw newlines, so one data: line is enough.
  res.write(`data: ${JSON.stringify(event)}\n\n`);
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
      sseSend(res, { type: 'complete', root: scan.root });
    } else {
      sseSend(res, { type: 'error', message: scan.error ?? 'Scan failed' });
    }
    closeClient(client);
  };

  const timer = setInterval(() => {
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
    root: scan.root,
  });
});

/** GET /api/scan/:scanId/stats — counters incl. incremental cache usage. */
scanRouter.get('/scan/:scanId/stats', (req: Request, res: Response) => {
  const scan = requireScan(req, req.params.scanId);
  res.json({
    scanId: scan.scanId,
    status: scan.status,
    scanned: scan.scanned,
    fileCount: scan.fileCount,
    dirCount: scan.dirCount,
    incremental: scan.incremental === true,
    cachedDirs: scan.cachedDirs ?? 0,
    walkedDirs: scan.walkedDirs ?? 0,
    hardlinkedFiles: scan.hardlinkedFiles ?? 0,
    hardlinkedBytes: scan.hardlinkedBytes ?? 0,
    cloudFiles: scan.cloudFiles ?? 0,
    cloudBytes: scan.cloudBytes ?? 0,
  });
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
    if (found.type !== 'dir') throw new AppError(400, 'NOT_A_DIRECTORY', 'Treemap root must be a directory');
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
