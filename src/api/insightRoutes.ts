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
import { buildDuplicateDetail } from '../services/dupeViewer';
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
import { guardQueryPath, guardBodyPath, guardBodyPaths, requireInsideScanRoot, insideAnyScanRoot } from '../middleware/pathGuard';
import { getAppAttribution } from '../services/appAttribution';
import { storeOf } from '../services/scanStore';
import { getForecast } from '../services/forecast';
import { buildStatement } from '../services/missingGigabytes';
import { capabilityState } from '../platform/capabilities';
import { expandContainer } from '../services/containerScanner';
import { findGitRepos, runGitGc } from '../services/gitScanner';
import { scanPackageEcosystems } from '../services/packageEcosystemScanner';
import { scanGameLibraries } from '../services/gameLibraryScanner';
import { scanMediaLibraries, guardMediaReport } from '../services/mediaLibraryScanner';
import { collectSecurityFindings, relocateSecret, SECURITY_PATTERNS } from '../services/securityHygieneScanner';
import { readProvenance } from '../services/provenanceTracker';
import { getDriveHealth } from '../services/driveHealthMonitor';
import { estimateCost, isCurrency, PROVIDER_PRICING, PRICING_AS_OF } from '../services/costIntelligence';
import {
  cancelEncodeJob, estimateFor, getEncodeJob, isWorthEncoding, mediaTools,
  registerEncodeClient, shortlistFromScan, startEncodeJob, CompressionCandidate,
} from '../services/compressionAdvisor';
import { sseSend } from '../utils/sse';
import { randomUUID } from 'crypto';
import { sanitizePath } from '../utils/pathSanitizer';
import { getPolicy, assertPathsAllowed } from '../services/policy';
import { ruleCatalogStatus } from '../services/rulePacks';
import { getIgnoreMatchers } from '../services/settings';
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
 * GET /api/duplicates/detail?scanId=&paths=<comma-separated, URL-encoded>
 * The side-by-side facts for one duplicate pair/group (§8.2): tree metadata,
 * image dimensions and EXIF capture date where readable, the dHash diff
 * against the recommended keep, and which file to keep with the rule stated.
 *
 * `paths` carries 2–8 paths, each individually URL-encoded and joined by
 * commas. The split happens on the RAW query value — before any decoding —
 * so a comma inside a filename (%2C) never splits a path in two; the query
 * parser's own decode would erase that distinction. Every path must resolve
 * to a FILE in this scan's tree: not-in-scan is a 404, exactly like an
 * expired scanId, because the answer comes from the scanned tree and a path
 * outside it has no honest answer here.
 */
insightRouter.get('/duplicates/detail', async (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  if (Array.isArray(req.query.paths)) {
    throw new AppError(400, 'PATHS_INVALID', 'Pass "paths" once, as a comma-separated list');
  }
  const rawList = /[?&]paths=([^&]*)/.exec(req.url)?.[1] ?? '';
  let paths: string[];
  try {
    paths = rawList.split(',').filter((p) => p.length > 0).map((p) => sanitizePath(decodeURIComponent(p)));
  } catch (err) {
    if (err instanceof URIError) {
      throw new AppError(400, 'PATHS_INVALID', 'Every path in "paths" must be URL-encoded');
    }
    throw err; // PathRejectedError → the error handler's 400
  }
  if (paths.length < 2 || paths.length > 8) {
    throw new AppError(400, 'PATHS_RANGE', 'The duplicate viewer compares between 2 and 8 files');
  }
  const store = storeOf(scan);
  const ids = paths.map((p) => {
    const id = store.findByPath(p);
    if (id < 0) {
      throw new AppError(404, 'PATH_NOT_IN_SCAN', `Not in this scan: ${p}`);
    }
    if (store.nodeType(id) !== 'file') {
      throw new AppError(400, 'NOT_A_FILE', `The duplicate viewer compares files, and this is a folder: ${p}`);
    }
    return id;
  });
  res.json(await buildDuplicateDetail(scan.scanId, store, ids));
});

/**
 * GET /api/apps?scanId= — per-application storage attribution (Apps tab).
 * Read-only tree walk over the completed scan; cached per scan.
 */
insightRouter.get('/apps', async (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  res.json(await getAppAttribution(scan));
});

/**
 * GET /api/large-folders?scanId=&limit=20&minSize=1048576
 *
 * 202 while the scan runs, NOT 409.
 *
 * This is one of three endpoints the dashboard fetches together in a single
 * Promise.all — beside /api/large-files and /api/file-types, which have always
 * answered 202. Three answers to one question meant the row could take an
 * error from this sibling while the other two were merely saying "not yet",
 * and "Could not load stats" is the wrong sentence for a scan that is simply
 * still running. 202 is also the shape the client's api() already knows how to
 * poll, so waiting became possible rather than just quieter.
 *
 * The 409 SCAN_RUNNING convention still holds everywhere it means "this cannot
 * be answered from a partial scan, and polling would be wrong" — offload,
 * watch, cloud and the rest of this file.
 */
insightRouter.get('/large-folders', (req: Request, res: Response) => {
  const running = requireScan(req, req.query.scanId);
  if (running.status === 'running') {
    res.status(202).json({ status: 'running' });
    return;
  }
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

/**
 * GET /api/missing-gigabytes?scanId= — the accounting statement (Phase 5).
 *
 * A **new** endpoint, and necessarily so: every per-scan response in §2.1's
 * byte-identity list is locked, and this adds facts about a scan rather than
 * changing what a scan says. Nothing here is destructive; the two remedies it
 * offers are descriptions of endpoints that already exist and already have
 * their own gates, not a second path to them.
 *
 * Gated on `volumeTopology`, because a statement that cannot read the disk
 * layout has nothing to reconcile against — and a tab disabled with the
 * capability's own reason is better than a panel of blanks.
 */
insightRouter.get('/missing-gigabytes', async (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  const state = await capabilityState('volumeTopology');
  if (!state.available) {
    throw new AppError(
      409,
      'CAPABILITY_UNAVAILABLE',
      state.reason ?? 'The disk layout cannot be read on this system, so there is nothing to reconcile against.',
    );
  }
  // Same reason as GET /api/platform/topology: the layout reader throws rather
  // than hand back an answer that cannot be true, and a statement with nothing
  // to reconcile against is an unavailable feature, not a server fault.
  try {
    res.json({ ...(await buildStatement(scan)), capability: state });
  } catch (err) {
    throw new AppError(409, 'CAPABILITY_UNAVAILABLE', err instanceof Error ? err.message : String(err));
  }
});

/** GET /api/git/repos?scanId= — pack/loose/LFS breakdown of every .git in the scan. */
insightRouter.get('/git/repos', (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  res.json({ repos: findGitRepos(storeOf(scan)) });
});

/**
 * GET /api/packages/orphans?scanId= — package-manager artifacts, classified.
 *
 * Orphaned (the owning project is gone), active (context only), and shared
 * caches. Rules come from the §C8 packs, so a malformed pack makes this feature
 * report itself unavailable exactly like Smart Suggestions rather than
 * answering "no orphans", which would read as good news.
 */
insightRouter.get('/packages/orphans', async (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  const catalog = ruleCatalogStatus();
  if (!catalog.ok) {
    res.json({ scanId: scan.scanId, available: false, reason: catalog.reason, ecosystems: [], orphanBytes: 0, cacheBytes: 0, activeBytes: 0, orphanCount: 0 });
    return;
  }
  const ignore = await getIgnoreMatchers('suggest');
  res.json({ scanId: scan.scanId, available: true, ...scanPackageEcosystems(storeOf(scan), ignore, catalog.catalog) });
});

/**
 * GET /api/games?scanId= — game libraries in the scan, broken down per title.
 *
 * Steam (libraryfolders.vdf + appmanifest_*.acf), Epic (.item manifests), GOG
 * (goggame-*.info) and itch.io. Each title splits into base install, shader
 * cache, workshop content, Proton prefix and — only where the game keeps it
 * separately — DLC.
 */
insightRouter.get('/games', (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  res.json({ scanId: scan.scanId, ...scanGameLibraries(storeOf(scan)) });
});

/**
 * GET /api/media?scanId= — media libraries in the scan, split into parts.
 *
 * Photos (.photoslibrary), Final Cut (.fcpbundle), iMovie (.imovielibrary),
 * Lightroom (.lrcat + sibling .lrdata) and Capture One (.cocatalog), each
 * split into originals / derivatives / database against its own documented
 * layout. Only derivatives ever carry a removable flag, each with the cost of
 * regenerating it as prose; a library whose layout is unrecognised reports
 * its total size only. The §B2 guard runs over every library's parts, so one
 * the owning app holds open says who holds it and offers nothing.
 */
insightRouter.get('/media', async (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  res.json({ scanId: scan.scanId, ...(await guardMediaReport(scanMediaLibraries(storeOf(scan)))) });
});

/**
 * GET /api/security/findings?scanId= — secrets sitting outside their home.
 *
 * Names and locations only: no file is opened and no content is ever read or
 * returned. Findings are local to this machine and are deliberately excluded
 * from anything that leaves it.
 */
insightRouter.get('/security/findings', async (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  const ignore = await getIgnoreMatchers('suggest');
  res.json({ scanId: scan.scanId, patternCount: SECURITY_PATTERNS.length, ...collectSecurityFindings(storeOf(scan), ignore) });
});

/**
 * POST /api/security/relocate { path, to, confirm:true }
 *
 * Move ONE secret into a safer directory. Never a delete, never a clobber: an
 * occupied destination aborts. Both ends are path-sanitised and the source must
 * lie inside a scanned root, exactly like every other file operation.
 */
insightRouter.post('/security/relocate', idempotency, guardBodyPath, requireInsideScanRoot, async (req: Request, res: Response) => {
  const { path: from, to, confirm } = req.body as { path: string; to?: unknown; confirm?: boolean };
  if (confirm !== true) {
    throw new AppError(400, 'CONFIRM_REQUIRED', 'Pass { confirm: true } to move a file');
  }
  if (typeof to !== 'string' || !to.trim()) {
    throw new AppError(400, 'DEST_REQUIRED', 'A "to" destination path is required');
  }
  const dest = sanitizePath(to);
  // Both ends, not just the source: writing a file into a folder the user never
  // scanned is exactly the surprise the scanned-root rule exists to prevent.
  if (!insideAnyScanRoot(dest)) {
    throw new AppError(403, 'OUTSIDE_SCAN_ROOT', 'The destination is outside every scanned folder — scan it first');
  }
  const policy = await getPolicy();
  assertPathsAllowed(policy, [from, dest]);
  try {
    const result = await relocateSecret(from, dest);
    await appendAudit({ action: 'security.relocate', source: 'http', tokenId: tokenIdFor('http'), paths: [from, dest], bytes: null, dryRun: false, outcome: 'ok' });
    res.json(result);
  } catch (err) {
    await appendAudit({ action: 'security.relocate', source: 'http', tokenId: tokenIdFor('http'), paths: [from, dest], bytes: null, dryRun: false, outcome: 'refused' });
    throw new AppError(409, 'RELOCATE_FAILED', err instanceof Error ? err.message : String(err));
  }
});

/**
 * GET /api/provenance?path= — where one file came from (§C3).
 *
 * Read-only, and restricted to files inside a scanned root like every other
 * per-file read. The URL it returns is untrusted text: it is never fetched,
 * never resolved, and the UI escapes it on render.
 */
insightRouter.get('/provenance', guardQueryPath('path'), async (req: Request, res: Response) => {
  const target = req.query.path;
  if (typeof target !== 'string' || !target) {
    throw new AppError(400, 'PATH_REQUIRED', 'A "path" query parameter is required');
  }
  if (!insideAnyScanRoot(target)) {
    throw new AppError(403, 'OUTSIDE_SCAN_ROOT', 'Provenance is only available for files inside a scanned folder');
  }
  res.json(await readProvenance(target));
});

/**
 * GET /api/health/smart?device=&scanId= — drive health next to the forecast.
 *
 * Reports the drive's own attributes and its own self-assessment verbatim, plus
 * the arithmetic a person cannot do in their head: which runs out first, space
 * or write endurance. It never renders a verdict of its own — a false "your
 * drive is dying" is a serious harm.
 */
insightRouter.get('/health/smart', async (req: Request, res: Response) => {
  const device = typeof req.query.device === 'string' && req.query.device.trim() ? req.query.device.trim() : null;
  let rootPath: string | null = null;
  if (typeof req.query.scanId === 'string' && req.query.scanId) {
    rootPath = requireCompleteScan(req, req.query.scanId).rootPath;
  }
  res.json(await getDriveHealth(device, rootPath));
});

/**
 * GET /api/cost/estimate?scanId=&freeable=&currency= — what this data costs.
 *
 * Against a pricing table that SHIPS WITH THE APP. Nothing here fetches a
 * price: TreeMap makes no outbound request, and the "as of" date travels with
 * the answer so a stale price is visible as stale rather than presented as
 * current.
 */
insightRouter.get('/cost/estimate', (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  const bytes = storeOf(scan).size(storeOf(scan).rootId);
  const freeable = Math.max(0, Number(req.query.freeable) || 0);
  const currency = isCurrency(req.query.currency) ? req.query.currency : 'USD';
  res.json({
    scanId: scan.scanId,
    providerCount: PROVIDER_PRICING.length,
    ...estimateCost(bytes, freeable, currency),
  });
});

/** GET /api/cost/pricing — the shipped table itself, with its "as of" date. */
insightRouter.get('/cost/pricing', (_req: Request, res: Response) => {
  res.json({ asOf: PRICING_AS_OF, providers: PROVIDER_PRICING });
});

/**
 * GET /api/compression/candidates?scanId= — video worth re-encoding to HEVC.
 *
 * Shortlisted from the scan first (big video containers only), then probed —
 * so ffprobe runs tens of times, not tens of thousands.
 */
insightRouter.get('/compression/candidates', async (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  const tools = mediaTools();
  const availability = await tools.availability();
  if (!availability.available) {
    res.json({ scanId: scan.scanId, ...availability, candidates: [], totalSaving: 0 });
    return;
  }
  const ignore = await getIgnoreMatchers('suggest');
  const shortlist = shortlistFromScan(storeOf(scan), ignore, clampInt(req.query.limit, 60, 1, 200));
  const candidates: CompressionCandidate[] = [];
  for (const item of shortlist) {
    const probe = await tools.probe(item.path);
    if (!isWorthEncoding(probe)) continue;
    const { estimatedBytes, estimatedSaving } = estimateFor(item.size, probe!.videoCodec);
    candidates.push({
      ...item,
      codec: probe!.videoCodec,
      width: probe!.width,
      height: probe!.height,
      durationSeconds: probe!.durationSeconds,
      estimatedBytes,
      estimatedSaving,
      reason: `${(probe!.videoCodec || 'this codec').toUpperCase()} video — HEVC stores the same picture in less space.`,
    });
  }
  candidates.sort((a, b) => b.estimatedSaving - a.estimatedSaving);
  res.json({
    scanId: scan.scanId, ...availability, candidates,
    totalSaving: candidates.reduce((s, c) => s + c.estimatedSaving, 0),
  });
});

/**
 * POST /api/compression/encode { paths, confirm:true } -> 202 { jobId }
 *
 * Re-encoding is LOSSY and the original is trashed once the new file verifies,
 * so it is double-gated like every other destructive action.
 */
insightRouter.post('/compression/encode', idempotency, guardBodyPaths, async (req: Request, res: Response) => {
  const { paths, confirm } = req.body as { paths: string[]; confirm?: boolean };
  if (confirm !== true) {
    throw new AppError(400, 'CONFIRM_REQUIRED', 'Pass { confirm: true } — re-encoding is lossy and trashes the original');
  }
  for (const p of paths) {
    if (!insideAnyScanRoot(p)) {
      throw new AppError(403, 'OUTSIDE_SCAN_ROOT', `${p} is outside every scanned folder`);
    }
  }
  const availability = await mediaTools().availability();
  if (!availability.available || !availability.encoder) {
    throw new AppError(503, 'ENCODER_UNAVAILABLE', availability.reason || 'No hardware encoder is available');
  }
  const policy = await getPolicy();
  assertPathsAllowed(policy, paths);
  const jobId = randomUUID();
  startEncodeJob(jobId, paths, availability.encoder);
  await appendAudit({ action: 'compression.encode', source: 'http', tokenId: tokenIdFor('http'), paths, bytes: null, dryRun: false, outcome: 'ok' });
  res.status(202).json({ jobId, total: paths.length, encoder: availability.encoder });
});

/** GET /api/compression/:jobId/progress — SSE, the app's one long-work pattern. */
insightRouter.get('/compression/:jobId/progress', (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  const job = getEncodeJob(jobId);
  if (!job) throw new AppError(404, 'JOB_NOT_FOUND', 'No such encode job');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const tick = setInterval(() => {
    const current = getEncodeJob(jobId);
    if (!current) { release(); return; }
    sseSend(res, {
      type: 'progress',
      status: current.status, done: current.done, total: current.total,
      currentPath: current.currentPath, currentFraction: current.currentFraction,
      savedBytes: current.savedBytes,
    });
    if (current.status !== 'running') {
      sseSend(res, { type: 'complete', results: current.results, savedBytes: current.savedBytes, error: current.error });
      release();
    }
  }, 500);
  // The route must put ITSELF in the shutdown registry, the same way the scan,
  // watch, offload, index and capsule streams do. Every other exit here —
  // job gone, job finished, client hung up — goes through the returned release
  // instead of a bare clearInterval, so shutdown never finds a stale entry and,
  // more importantly, never MISSES a live one: an unregistered stream's 500 ms
  // interval survives server.close() and keeps the process alive on SIGTERM.
  // `release` is used above before its declaration on purpose — the interval
  // cannot fire until long after this handler has returned.
  const release = registerEncodeClient(res, tick);
  req.on('close', release);
});

/** GET /api/compression/:jobId/result — the same answer, for pollers. */
insightRouter.get('/compression/:jobId/result', (req: Request, res: Response) => {
  const job = getEncodeJob(String(req.params.jobId));
  if (!job) throw new AppError(404, 'JOB_NOT_FOUND', 'No such encode job');
  res.json(job);
});

/** POST /api/compression/:jobId/cancel — stops before the NEXT file. */
insightRouter.post('/compression/:jobId/cancel', (req: Request, res: Response) => {
  res.json({ cancelled: cancelEncodeJob(String(req.params.jobId)) });
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
