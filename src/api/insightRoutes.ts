import { Router, Request, Response } from 'express';
import { requireScan, clampInt } from './scanRoutes';
import {
  allScans,
  collectLargestFolders,
  collectEmptyFolders,
  compareTrees,
} from '../services/diskScanner';
import { getDuplicateJob } from '../services/duplicateFinder';
import { getNearDupeJob } from '../services/perceptualDupes';
import {
  listSnapshots,
  listSnapshotRoots,
  listAllSnapshotsSlim,
  getSnapshot,
  getSnapshotTreeAt,
  inflateSnapshotTree,
  diffSnapshots,
} from '../services/snapshots';
import { buildTreemap } from '../utils/treemap';
import { guardQueryPath, guardBodyPath, requireInsideScanRoot } from '../middleware/pathGuard';
import { getAppAttribution } from '../services/appAttribution';
import { storeOf } from '../services/scanStore';
import { getForecast } from '../services/forecast';
import { expandContainer } from '../services/containerScanner';
import { findGitRepos, runGitGc } from '../services/gitScanner';
import { AppError } from '../middleware/errorHandler';
import { idempotency } from '../middleware/idempotency';
import { appendAudit, tokenIdFor } from '../services/audit';
import { CompareResult, FileNode, ScanResult } from '../models/types';

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
  if (scan.status === 'error' || (!scan.store && !scan.root)) {
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

/**
 * GET /api/near-duplicates?scanId=&threshold=10
 * Perceptual (dHash) near-duplicate image detection (Feature 12). Poll like
 * /duplicates: 202 + progress while hashing, 200 + clusters when done.
 * When no image decoder is available, returns 200 with available:false.
 */
insightRouter.get('/near-duplicates', (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  const threshold = clampInt(req.query.threshold, 10, 0, 32);

  const job = getNearDupeJob(scan, threshold);
  if (job.status === 'running') {
    res.status(202).json({ status: 'running', hashed: job.hashed, toHash: job.toHash });
    return;
  }
  if (job.status === 'error') {
    throw new AppError(500, 'NEAR_DUPLICATES_FAILED', job.error ?? 'Near-duplicate detection failed');
  }
  res.json({
    status: 'complete',
    scanId: scan.scanId,
    threshold: job.threshold,
    available: job.available,
    decoder: job.decoder,
    reason: job.reason,
    clusters: job.clusters ?? [],
    clusterCount: job.clusterCount ?? 0,
    totalReclaimable: job.totalReclaimable ?? 0,
    truncated: job.truncated ?? false,
    tookMs: (job.finishedAt ?? job.startedAt) - job.startedAt,
  });
});

/**
 * GET /api/apps?scanId= — per-application storage attribution (Apps tab).
 * Read-only tree walk over the completed scan; cached per scan.
 */
insightRouter.get('/apps', async (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  res.json(await getAppAttribution(scan));
});

/** GET /api/large-folders?scanId=&limit=20&minSize=1048576 */
insightRouter.get('/large-folders', (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  const limit = clampInt(req.query.limit, 20, 1, 500);
  const minSize = clampInt(req.query.minSize, 1_048_576, 0, Number.MAX_SAFE_INTEGER);
  res.json({ folders: collectLargestFolders(storeOf(scan), limit, minSize) });
});

/** GET /api/empty-folders?scanId=&ignoreJunk=true */
insightRouter.get('/empty-folders', (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  const ignoreJunk = String(req.query.ignoreJunk ?? 'true') !== 'false';
  res.json(collectEmptyFolders(storeOf(scan), ignoreJunk));
});

/** GET /api/git/repos?scanId= — pack/loose/LFS breakdown of every .git in the scan. */
insightRouter.get('/git/repos', (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  res.json({ repos: findGitRepos(storeOf(scan)) });
});

/** POST /api/git/gc { path, confirm:true } — run `git gc` in a scanned repo. */
insightRouter.post('/git/gc', idempotency, guardBodyPath, requireInsideScanRoot, async (req: Request, res: Response) => {
  const { path: repoPath, confirm } = req.body as { path: string; confirm?: boolean };
  if (confirm !== true) {
    throw new AppError(400, 'CONFIRM_REQUIRED', 'Pass { confirm: true } to run git gc');
  }
  const result = await runGitGc(repoPath);
  await appendAudit({ action: 'git.gc', source: 'http', tokenId: tokenIdFor('http'), paths: [repoPath], bytes: null, dryRun: false, outcome: 'ok' });
  res.json(result);
});

/**
 * POST /api/container/expand { scanId, path } — list a container's contents
 * (zip/jar/tar/tgz/iso/docker) and graft them into the scan as virtual
 * children. Lazy: first click parses (in a worker), repeats hit the cache.
 */
insightRouter.post('/container/expand', guardBodyPath, requireInsideScanRoot, async (req: Request, res: Response) => {
  const { scanId, path: containerPath } = req.body as { scanId?: unknown; path: string };
  const scan = requireCompleteScan(req, scanId);
  res.json(await expandContainer(scan, containerPath));
});

/** GET /api/scans — completed scans currently in memory (Compare picker). */
insightRouter.get('/scans', (_req: Request, res: Response) => {
  const scans = allScans()
    .filter((s) => s.status === 'complete' && s.store)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .map((s) => ({
      scanId: s.scanId,
      rootPath: s.rootPath,
      totalSize: s.store!.size(s.store!.rootId),
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
  const storeA = storeOf(scanA);
  const storeB = storeOf(scanB);
  const { entries, truncated } = compareTrees(storeA, storeB);
  const result: CompareResult = {
    scanIdA: scanA.scanId,
    scanIdB: scanB.scanId,
    rootPath: scanA.rootPath,
    totalDelta: storeB.size(storeB.rootId) - storeA.size(storeA.rootId),
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

/**
 * GET /api/snapshots/tree?path=&at= — historical treemap (time slider).
 * Serves the stored snapshot tree closest to `at` in exactly the shape of
 * /api/scan/:id/treemap, so the live renderer draws it unmodified. Each node
 * carries prevSize (size in the previous snapshot; null = didn't exist) for
 * the diff overlay.
 */
insightRouter.get('/snapshots/tree', guardQueryPath('path'), async (req: Request, res: Response) => {
  const rootPath = req.query.path as string | undefined;
  if (!rootPath) throw new AppError(400, 'PATH_REQUIRED', 'A "path" query parameter is required');
  const at = Number(req.query.at);
  if (!Number.isFinite(at)) throw new AppError(400, 'AT_REQUIRED', '"at" must be a unix-ms timestamp');

  const found = await getSnapshotTreeAt(rootPath, at);
  if (!found) throw new AppError(404, 'NO_SNAPSHOT_TREE', 'No snapshot trees recorded for that folder yet — rescan it to start history');

  const root = inflateSnapshotTree(found.tree, rootPath, found.snapshot.takenAt);
  const nodes = buildTreemap(root, { maxDepth: 3, minSize: 0, maxNodes: 20_000 });

  // Diff data for both renderers: prevSize on the flat treemap nodes and on
  // the tree itself (the sunburst lays out client-side from the tree).
  if (found.prev) {
    const prevSizes = new Map<string, number>();
    const walk = (n: FileNode): void => {
      prevSizes.set(n.path, n.size);
      if (n.children) for (const c of n.children) walk(c);
    };
    walk(inflateSnapshotTree(found.prev.tree, rootPath, found.prev.snapshot.takenAt));
    for (const n of nodes) n.prevSize = prevSizes.get(n.path) ?? null;
    const annotate = (n: FileNode & { prevSize?: number | null }): void => {
      n.prevSize = prevSizes.get(n.path) ?? null;
      if (n.children) for (const c of n.children) annotate(c);
    };
    annotate(root);
  }

  res.json({
    snapshot: { id: found.snapshot.id, takenAt: found.snapshot.takenAt, totalSize: found.snapshot.totalSize },
    prevTakenAt: found.prev ? found.prev.snapshot.takenAt : null,
    root: { name: root.name, path: root.path, size: root.size, modifiedAt: root.modifiedAt },
    scanRootPath: rootPath,
    maxDepth: 3,
    minSize: 0,
    nodes,
    tree: root,
  });
});

/**
 * GET /api/forecast?path= — disk-full projection for a tracked root, from
 * its snapshot history plus the volume's free space. Honest by design:
 * status explains itself when there's no trustworthy number.
 */
insightRouter.get('/forecast', guardQueryPath('path'), async (req: Request, res: Response) => {
  const rootPath = req.query.path as string | undefined;
  if (!rootPath) throw new AppError(400, 'PATH_REQUIRED', 'A "path" query parameter is required');
  res.json(await getForecast(rootPath));
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
