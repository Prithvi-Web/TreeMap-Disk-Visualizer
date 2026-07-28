import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import path from 'path';
import { guardBodyPath, guardQueryPath } from '../middleware/pathGuard';
import { AppError } from '../middleware/errorHandler';
import { clampInt } from './scanRoutes';
import { getPolicy, assertScanAllowed } from '../services/policy';
import { sseSend } from '../utils/sse';
import {
  buildIndex,
  deleteIndex,
  getRoot,
  listRoots,
  readTree,
  rootFor,
  searchIndex,
  startWatcher,
  type BuildProgress,
  type IndexedRoot,
} from '../services/indexEngine';
import { accountFor, allocationForFile } from '../services/allocationAccountant';

/**
 * indexRoutes (A1) — build, inspect and read the persistent index.
 *
 * Long work follows the one pattern §3.3 defines, the same one
 * `/api/scan/:id/progress` already uses:
 *
 *   POST /api/index/build          → 202 { jobId }
 *   GET  /api/index/:jobId/progress → SSE frames
 *   GET  /api/index/:jobId/result   → 202 while running, 200 when done
 *   POST /api/index/:jobId/cancel   → cooperative cancellation
 *
 * Responses are flat objects with a `{ error, code }` envelope on failure —
 * this project's existing convention, which §3.2 says to follow rather than
 * introduce a second one.
 */

export const indexRouter = Router();

/* ------------------------------ jobs ------------------------------ */

interface BuildJob {
  jobId: string;
  rootPath: string;
  status: 'running' | 'complete' | 'error' | 'cancelled';
  phase: BuildProgress['phase'];
  processed: number;
  currentPath: string;
  startedAt: number;
  finishedAt?: number;
  cancelled: boolean;
  error?: string;
  result?: IndexedRoot;
}

const jobs = new Map<string, BuildJob>();

/** Jobs are small, but a long-lived server must not accumulate them forever. */
const JOB_TTL_MS = 30 * 60 * 1000;

function reapJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && (job.finishedAt ?? job.startedAt) < cutoff) jobs.delete(id);
  }
}

function requireJob(jobId: unknown): BuildJob {
  const job = jobs.get(String(jobId ?? ''));
  if (!job) throw new AppError(404, 'JOB_NOT_FOUND', 'Unknown or expired index job');
  return job;
}

/* ---------------------------- SSE clients ---------------------------- */

interface IndexSseClient {
  res: Response;
  timer: NodeJS.Timeout;
}
const sseClients = new Set<IndexSseClient>();

function closeClient(client: IndexSseClient): void {
  clearInterval(client.timer);
  sseClients.delete(client);
  try {
    client.res.end();
  } catch {
    /* already gone */
  }
}

/** Called on SIGTERM by the graceful-shutdown path, like every other stream. */
export function drainIndexClients(): void {
  for (const client of [...sseClients]) {
    try {
      sseSend(client.res, { type: 'shutdown' });
    } catch {
      /* socket already dead */
    }
    closeClient(client);
  }
}

export function activeIndexSseCount(): number {
  return sseClients.size;
}

/** Cancel every running build (shutdown). */
export function cancelAllIndexJobs(): void {
  for (const job of jobs.values()) if (job.status === 'running') job.cancelled = true;
}

/* ------------------------------ routes ------------------------------ */

/**
 * POST /api/index/build { path } → 202 { jobId }
 *
 * Returns immediately; progress rides the SSE stream. Indexing a large volume
 * takes as long as a scan does, and §3.3 forbids making the client hold a
 * request open for it.
 */
indexRouter.post('/index/build', guardBodyPath, async (req: Request, res: Response) => {
  reapJobs();
  const { path: rootPath } = req.body as { path: string };
  // The same policy gate scanning uses: an allowlisted deployment must not be
  // able to index its way around the restriction.
  assertScanAllowed(await getPolicy(), rootPath);

  const existing = [...jobs.values()].find((j) => j.rootPath === rootPath && j.status === 'running');
  if (existing) {
    res.status(202).json({ jobId: existing.jobId, status: 'running', alreadyRunning: true });
    return;
  }

  const job: BuildJob = {
    jobId: randomUUID(),
    rootPath,
    status: 'running',
    phase: 'enumerating',
    processed: 0,
    currentPath: rootPath,
    startedAt: Date.now(),
    cancelled: false,
  };
  jobs.set(job.jobId, job);

  // Deliberately not awaited: the response goes out now.
  void buildIndex(rootPath, {
    isCancelled: () => job.cancelled,
    onProgress: (p) => {
      job.phase = p.phase;
      job.processed = p.processed;
      job.currentPath = p.currentPath;
    },
  })
    .then((root) => {
      job.status = 'complete';
      job.phase = 'done';
      job.result = root;
      job.finishedAt = Date.now();
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      job.status = message === 'cancelled' ? 'cancelled' : 'error';
      job.phase = 'error';
      job.error = message;
      job.finishedAt = Date.now();
    });

  res.status(202).json({ jobId: job.jobId, status: 'running' });
});

/** GET /api/index/:jobId/progress — SSE, mirroring the scan progress stream. */
indexRouter.get('/index/:jobId/progress', (req: Request, res: Response) => {
  const job = requireJob(req.params.jobId);

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let lastProcessed = -1;
  let lastBeat = Date.now();

  const finish = (): void => {
    if (job.status === 'complete' && job.result) {
      sseSend(res, { type: 'complete', root: job.result });
    } else {
      sseSend(res, { type: 'error', message: job.error ?? 'Index build failed' });
    }
    closeClient(client);
  };

  const timer = setInterval(() => {
    try {
      if (job.status !== 'running') {
        finish();
        return;
      }
      if (job.processed !== lastProcessed) {
        lastProcessed = job.processed;
        sseSend(res, {
          type: 'progress',
          phase: job.phase,
          processed: job.processed,
          currentPath: job.currentPath,
        });
        lastBeat = Date.now();
      } else if (Date.now() - lastBeat > 15_000) {
        // §3.3: a heartbeat every 15s so proxies do not drop the stream.
        res.write(': keep-alive\n\n');
        lastBeat = Date.now();
      }
    } catch {
      // Nothing sits above a timer callback to catch a throw, so anything
      // escaping would take the process down. Drop this client instead.
      closeClient(client);
    }
  }, 200);

  const client: IndexSseClient = { res, timer };
  sseClients.add(client);

  if (job.status === 'running') {
    sseSend(res, { type: 'progress', phase: job.phase, processed: job.processed, currentPath: job.currentPath });
    lastProcessed = job.processed;
  } else {
    finish();
  }

  req.on('close', () => closeClient(client));
});

/** GET /api/index/:jobId/result — 202 while running, 200 when done. */
indexRouter.get('/index/:jobId/result', (req: Request, res: Response) => {
  const job = requireJob(req.params.jobId);
  if (job.status === 'running') {
    res.status(202).json({ status: 'running', phase: job.phase, processed: job.processed, currentPath: job.currentPath });
    return;
  }
  if (job.status !== 'complete' || !job.result) {
    throw new AppError(500, 'INDEX_BUILD_FAILED', job.error ?? 'Index build failed');
  }
  res.json({ status: 'complete', root: job.result });
});

/** POST /api/index/:jobId/cancel — cooperative, rolls back cleanly. */
indexRouter.post('/index/:jobId/cancel', (req: Request, res: Response) => {
  const job = requireJob(req.params.jobId);
  if (job.status === 'running') job.cancelled = true;
  res.json({ jobId: job.jobId, cancelled: true, status: job.status });
});

/**
 * GET /api/index/status[?path=]
 *
 * With no `path`, every indexed root. With one, the root that would serve it —
 * which is what the Dashboard asks on load to decide between rendering
 * instantly and starting a scan.
 */
indexRouter.get('/index/status', guardQueryPath('path'), (req: Request, res: Response) => {
  const target = req.query.path as string | undefined;
  if (target === undefined) {
    // The database size is reported because the index is genuinely large — a
    // 366,000-file home directory measured ~200 MB — and a cache that grows
    // without the user being able to see it is the kind of thing that turns
    // into a support complaint. `DELETE /api/index` is the answer, and this is
    // what tells them whether they need it.
    res.json({ roots: listRoots(), dbPath: indexDbPathSafe(), dbBytes: indexDbBytes() });
    return;
  }
  const root = rootFor(target);
  res.json({
    path: target,
    indexed: root !== null,
    // 'ready' means the index is live and trustworthy; 'stale' means it exists
    // but missed events and is being reconciled. The UI shows green vs amber,
    // and must never present stale data as current.
    root,
    running: [...jobs.values()]
      .filter((j) => j.status === 'running' && (target === j.rootPath || target.startsWith(j.rootPath + path.sep)))
      .map((j) => ({ jobId: j.jobId, phase: j.phase, processed: j.processed })),
  });
});

/**
 * GET /api/index/tree?path=&maxNodes=
 *
 * The instant-open path. Answers with the same `FileNode` shape
 * `/api/scan/:id/result` returns, so the frontend renders it through exactly
 * the same code.
 */
indexRouter.get('/index/tree', guardQueryPath('path'), (req: Request, res: Response) => {
  const target = String(req.query.path ?? '');
  if (!target) throw new AppError(400, 'PATH_REQUIRED', 'Provide a "path" to read from the index');

  const root = rootFor(target);
  if (!root) {
    throw new AppError(404, 'INDEX_NOT_BUILT', 'That folder has not been indexed yet — scan it once to build the index');
  }
  if (root.state === 'building') {
    res.status(202).json({ status: 'running', root });
    return;
  }
  if (root.state === 'error') {
    throw new AppError(500, 'INDEX_BUILD_FAILED', root.error ?? 'The index for that folder could not be built');
  }

  const maxNodes = clampInt(req.query.maxNodes, 250_000, 1, 250_000);
  const tree = readTree(root.path, target, maxNodes);
  if (!tree) throw new AppError(404, 'PATH_NOT_FOUND', 'That path is not in the index');

  res.json({
    rootPath: root.path,
    path: target,
    // Carried on every read: 'stale' is the difference between "this is what is
    // on disk" and "this is what was on disk when we last looked", and the
    // client must be able to say which (§A1's consistency guard).
    state: root.state,
    live: root.live,
    builtAt: root.builtAt,
    fileCount: root.fileCount,
    dirCount: root.dirCount,
    totalSize: root.totalSize,
    root: tree.root,
    nodes: tree.nodes,
    prunedDirs: tree.prunedDirs,
  });
});

/**
 * POST /api/index/watch { path } — attach a live watcher and clear staleness.
 *
 * Used when the UI opens a stale root: reconciliation is a rebuild (see
 * indexEngine.reconcile), but simply resuming the watch is enough once the
 * caller has confirmed the index is current.
 */
indexRouter.post('/index/watch', guardBodyPath, (req: Request, res: Response) => {
  const { path: rootPath } = req.body as { path: string };
  const root = getRoot(rootPath);
  if (!root) throw new AppError(404, 'INDEX_NOT_BUILT', 'That folder has not been indexed yet');
  const attached = startWatcher(rootPath);
  res.json({ path: rootPath, watching: attached });
});

/**
 * DELETE /api/index[?path=] — drop one root, or the whole index.
 *
 * Not gated behind a confirmation like the destructive endpoints are: nothing
 * on disk is touched, and everything here can be rebuilt from the filesystem.
 */
indexRouter.delete('/index', guardQueryPath('path'), (req: Request, res: Response) => {
  const target = req.query.path as string | undefined;
  const removed = deleteIndex(target);
  res.json({ removed, path: target ?? null });
});

/**
 * GET /api/search?q=&minSize=&olderThan=&type=&scope=&limit=&offset= (A4)
 *
 * Instant, size-aware search over the index. The query language is the
 * treemap highlight box's, unchanged: `*.zip`, `.zip`, or a case-insensitive
 * substring of the filename (see utils/searchQuery.ts). §A4 is explicit that a
 * second query language must not be invented, so there is exactly one.
 *
 * Results are size-descending by default, which is the whole point: this is a
 * search for *disk hogs*, so the biggest match belongs first rather than the
 * alphabetically luckiest.
 */
indexRouter.get('/search', guardQueryPath('scope'), (req: Request, res: Response) => {
  const q = String(req.query.q ?? '');
  if (!q.trim()) {
    // An empty query is not an error — it is the state the search box starts
    // in, and answering 400 would make the frontend special-case its own
    // initial render.
    res.json({
      query: q,
      hits: [],
      total: 0,
      countCapped: false,
      truncated: false,
      tookMs: 0,
      roots: listRoots().map((r) => r.path),
      staleRoots: [],
    });
    return;
  }

  const typeParam = String(req.query.type ?? 'all');
  const result = searchIndex(q, {
    minSize: clampInt(req.query.minSize, 0, 0, Number.MAX_SAFE_INTEGER),
    olderThanDays: clampInt(req.query.olderThan, 0, 0, 36_500),
    type: typeParam === 'file' || typeParam === 'dir' ? typeParam : 'all',
    ...(req.query.scope ? { scope: String(req.query.scope) } : {}),
    limit: clampInt(req.query.limit, 50, 1, 500),
    offset: clampInt(req.query.offset, 0, 0, 100_000),
  });
  res.json(result);
});

/**
 * GET /api/allocation?path= (A2)
 *
 * What a folder really costs on disk: the naive figure other tools report, the
 * inode-deduplicated logical sum, the bytes actually occupied, and the
 * shared/exclusive split — plus, for a whole volume, a reconciliation against
 * the filesystem's own accounting.
 *
 * Always carries `approximate: true` with a reason. On any filesystem
 * supporting copy-on-write the allocated sum is an upper bound, and §10
 * requires saying so rather than presenting it as exact.
 */
indexRouter.get('/allocation', guardQueryPath('path'), async (req: Request, res: Response) => {
  const target = String(req.query.path ?? '');
  if (!target) throw new AppError(400, 'PATH_REQUIRED', 'Provide a "path" to account for');

  const root = rootFor(target);
  if (!root) {
    throw new AppError(
      404,
      'INDEX_NOT_BUILT',
      'That folder has not been indexed yet — scan it once and TreeMap can measure what it really costs on disk',
    );
  }
  const summary = await accountFor(root.path);
  if (!summary) throw new AppError(404, 'INDEX_NOT_BUILT', 'That folder is not in the index');
  res.json(summary);
});

/**
 * GET /api/allocation/file?path= (A2)
 *
 * The per-file split behind a tooltip: "2.1 GB total, 340 MB exclusive to this
 * copy". Answers 404 for a file that is not in the index rather than inventing
 * a zero.
 */
indexRouter.get('/allocation/file', guardQueryPath('path'), (req: Request, res: Response) => {
  const target = String(req.query.path ?? '');
  if (!target) throw new AppError(400, 'PATH_REQUIRED', 'Provide a file "path"');

  const root = rootFor(target);
  if (!root) throw new AppError(404, 'INDEX_NOT_BUILT', 'That file’s folder has not been indexed yet');
  const allocation = allocationForFile(root.path, target);
  if (!allocation) throw new AppError(404, 'PATH_NOT_FOUND', 'That file is not in the index');
  res.json(allocation);
});

/**
 * Total bytes the index occupies, counting its write-ahead log.
 *
 * The `-wal` sidecar is not incidental: it was 46 MB beside a 200 MB database
 * in testing, so reporting the main file alone would understate the real cost
 * by a fifth.
 */
function indexDbBytes(): number | null {
  const base = indexDbPathSafe();
  if (base === null) return null;
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += statSync(base + suffix).size;
    } catch {
      /* absent — nothing to add */
    }
  }
  return total;
}

/** The database path, without letting a failure to resolve it break status. */
function indexDbPathSafe(): string | null {
  try {
    // Imported lazily so a broken app-data directory cannot stop this route
    // from reporting the rest of the status.
    return require('../services/indexEngine').indexDbPath() as string;
  } catch {
    return null;
  }
}
