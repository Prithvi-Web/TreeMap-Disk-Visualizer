import { Router, Request, Response } from 'express';
import { requireScan, clampInt } from './scanRoutes';
import {
  allScans,
  collectLargestFolders,
  collectEmptyFolders,
  compareTrees,
} from '../services/diskScanner';
import { getDuplicateJob } from '../services/duplicateFinder';
import {
  listSnapshots,
  listSnapshotRoots,
  listAllSnapshotsSlim,
  getSnapshot,
  diffSnapshots,
} from '../services/snapshots';
import { guardQueryPath } from '../middleware/pathGuard';
import { AppError } from '../middleware/errorHandler';
import { CompareResult, ScanResult } from '../models/types';

/**
 * insightRoutes — analysis endpoints layered on top of completed scans:
 * duplicates, largest folders, empty folders, snapshot history (Trends)
 * and scan-to-scan comparison.
 */

export const insightRouter = Router();

function requireCompleteScan(req: Request, idSource: unknown): ScanResult & { root: NonNullable<ScanResult['root']> } {
  const scan = requireScan(req, idSource);
  if (scan.status === 'running') {
    throw new AppError(409, 'SCAN_RUNNING', 'Scan is still running — try again when it completes');
  }
  if (scan.status === 'error' || !scan.root) {
    throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  }
  return scan as ScanResult & { root: NonNullable<ScanResult['root']> };
}

/**
 * GET /api/duplicates?scanId=&minSize=
 * First call starts the hashing job; poll until status === 'complete'.
 * 202 + progress while hashing, 200 + groups when done.
 */
insightRouter.get('/duplicates', (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  const minSize = clampInt(req.query.minSize, 1024, 1, Number.MAX_SAFE_INTEGER);

  const job = getDuplicateJob(scan, minSize);
  if (job.status === 'running') {
    res.status(202).json({ status: 'running', hashed: job.hashed, toHash: job.toHash });
    return;
  }
  if (job.status === 'error') {
    throw new AppError(500, 'DUPLICATES_FAILED', job.error ?? 'Duplicate detection failed');
  }
  res.json({
    status: 'complete',
    scanId: scan.scanId,
    minSize: job.minSize,
    groups: job.groups ?? [],
    groupCount: job.groupCount ?? 0,
    totalReclaimable: job.totalReclaimable ?? 0,
    tookMs: (job.finishedAt ?? job.startedAt) - job.startedAt,
  });
});

/** GET /api/large-folders?scanId=&limit=20&minSize=1048576 */
insightRouter.get('/large-folders', (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  const limit = clampInt(req.query.limit, 20, 1, 500);
  const minSize = clampInt(req.query.minSize, 1_048_576, 0, Number.MAX_SAFE_INTEGER);
  res.json({ folders: collectLargestFolders(scan.root, limit, minSize) });
});

/** GET /api/empty-folders?scanId=&ignoreJunk=true */
insightRouter.get('/empty-folders', (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  const ignoreJunk = String(req.query.ignoreJunk ?? 'true') !== 'false';
  res.json(collectEmptyFolders(scan.root, ignoreJunk));
});

/** GET /api/scans — completed scans currently in memory (Compare picker). */
insightRouter.get('/scans', (_req: Request, res: Response) => {
  const scans = allScans()
    .filter((s) => s.status === 'complete' && s.root)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .map((s) => ({
      scanId: s.scanId,
      rootPath: s.rootPath,
      totalSize: s.root!.size,
      fileCount: s.fileCount,
      finishedAt: s.finishedAt,
    }));
  res.json({ scans });
});

/**
 * GET /api/compare?scanIdA=&scanIdB=
 * Structural diff between two completed scans of the same root path.
 */
insightRouter.get('/compare', (req: Request, res: Response) => {
  const scanA = requireCompleteScan(req, req.query.scanIdA);
  const scanB = requireCompleteScan(req, req.query.scanIdB);
  if (scanA.rootPath !== scanB.rootPath) {
    throw new AppError(400, 'ROOT_MISMATCH', 'Both scans must cover the same root path');
  }
  const { entries, truncated } = compareTrees(scanA.root, scanB.root);
  const result: CompareResult = {
    scanIdA: scanA.scanId,
    scanIdB: scanB.scanId,
    rootPath: scanA.rootPath,
    totalDelta: scanB.root.size - scanA.root.size,
    entries,
    truncated,
  };
  res.json(result);
});

/**
 * GET /api/snapshots            -> roots that have history
 * GET /api/snapshots?path=<dir> -> snapshots for that root, oldest first
 * GET /api/snapshots?all=true   -> every snapshot, slim (no topEntries)
 */
insightRouter.get('/snapshots', guardQueryPath('path'), async (req: Request, res: Response) => {
  const rootPath = req.query.path as string | undefined;
  if (rootPath) {
    res.json({ rootPath, snapshots: await listSnapshots(rootPath) });
  } else if (String(req.query.all ?? '') === 'true') {
    res.json({ snapshots: await listAllSnapshotsSlim() });
  } else {
    res.json({ roots: await listSnapshotRoots() });
  }
});

/** GET /api/snapshots/compare?a=<id>&b=<id> — deltas between two snapshots. */
insightRouter.get('/snapshots/compare', async (req: Request, res: Response) => {
  const [a, b] = await Promise.all([
    getSnapshot(String(req.query.a ?? '')),
    getSnapshot(String(req.query.b ?? '')),
  ]);
  if (!a || !b) throw new AppError(404, 'SNAPSHOT_NOT_FOUND', 'Unknown snapshot id');
  if (a.rootPath !== b.rootPath) {
    throw new AppError(400, 'ROOT_MISMATCH', 'Snapshots must cover the same root path');
  }
  res.json(diffSnapshots(a, b));
});
