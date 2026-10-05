import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import path from 'path';
import { guardBodyPath, guardQueryPath } from '../middleware/pathGuard';
import { AppError } from '../middleware/errorHandler';
import { clampInt } from './scanRoutes';
import { getPolicy, assertScanAllowed } from '../services/policy';
import { getSettings } from '../services/settings';
import { DEFAULT_BOUNDARY_RULE, scanBoundary, unknownBoundary, type BoundaryRule } from '../utils/mountBoundaries';
import { sseSend } from '../utils/sse';
import {
  INDEX_AUTO_MAX_ENTRIES,
  IndexCapReached,
  buildIndex,
  capStopFor,
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
  /** The cap the build was started with; absent for an explicit, uncapped build. */
  maxEntries?: number;
  /** True when the build stopped at `maxEntries` — cancelled, not failed. */
  capReached?: boolean;
  /** Settles (never rejects) when the job has; a request queued behind it waits on this. */
  settled?: Promise<void>;
  /** True while the job waits for the build of its folder ahead of it to settle. */
  queued: boolean;
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
 * What `GET /api/index/status` says about building on its own (plan U-1): the
 * most items a folder may hold for the page to index it after a scan. The
 * page reads it from here rather than holding its own copy.
 */
function autoBuild(): { maxEntries: number } {
  return { maxEntries: INDEX_AUTO_MAX_ENTRIES };
}

/**
 * Whether a running build started with cap `running` answers a request for
 * cap `requested` (undefined is no cap): it does when it is capped no
 * tighter. An uncapped build answers every request; a capped one never
 * answers an uncapped request, which would otherwise end with the running
 * build's cap and nothing written (Track U review of U-1, finding 3).
 */
function capCovers(running: number | undefined, requested: number | undefined): boolean {
  return running === undefined || (requested !== undefined && running >= requested);
}

/**
 * The paths a build of `rootPath` must not enter, and its watcher drops
 * changes under (Track U, U-24): what a scan of the folder is handed under
 * the person's "Stay on this drive" setting — the fixed never-descend
 * folders and, under `stay`, every drive the mount table shows mounted
 * inside it (`scanBoundary`, the one place a scan composes its list).
 * Composed from the folder and the setting alone, read now: a build has no
 * scan to take it from. A table that cannot be read leaves the fixed list,
 * as it leaves a scan's.
 */
async function boundaryFor(rootPath: string): Promise<string[]> {
  const rule: BoundaryRule = await getSettings().then((s) => s.scanBoundary, () => DEFAULT_BOUNDARY_RULE);
  const boundary = await scanBoundary(rootPath, rule).catch((err: unknown) =>
    unknownBoundary(rule, process.platform, err instanceof Error ? err.message : String(err)),
  );
  return boundary.neverDescend;
}

/** Tests only: while set, every job waits for this before its build starts. */
let buildGateForTests: Promise<void> | null = null;

/** Tests only: hold every index build that starts until `gate` settles; null lets them start at once. */
export function holdIndexBuildsForTests(gate: Promise<void> | null): void {
  buildGateForTests = gate;
}

/**
 * Run one job to its end. Never rejects: a job waiting behind this one reads
 * the outcome from the job, not from a rejection.
 *
 * A job queued behind `ahead` (a build of the same folder with a tighter cap)
 * starts once that one has settled. If that one completed, the folder fitted
 * under its cap, so it fits this job too: its index is this job's answer, and
 * the folder is not walked a second time.
 */
async function runJob(job: BuildJob, ahead: BuildJob | undefined): Promise<void> {
  const end = (status: BuildJob['status'], fields: Partial<BuildJob>): void => {
    Object.assign(job, fields, { status, finishedAt: Date.now() });
  };
  try {
    if (ahead?.settled) await ahead.settled;
    job.queued = false;
    if (buildGateForTests) await buildGateForTests;
    if (job.cancelled) {
      end('cancelled', { phase: 'error', error: 'cancelled' });
      return;
    }
    if (ahead && ahead.status === 'complete' && ahead.result) {
      end('complete', { phase: 'done', processed: ahead.processed, result: ahead.result });
      return;
    }
    // A job no longer queued is never widened, so its cap is read after this
    // await as it was before it.
    const neverDescend = await boundaryFor(job.rootPath);
    const root = await buildIndex(job.rootPath, {
      ...(job.maxEntries === undefined ? {} : { maxEntries: job.maxEntries }),
      neverDescend,
      isCancelled: () => job.cancelled,
      onProgress: (p) => {
        job.phase = p.phase;
        job.processed = p.processed;
        job.currentPath = p.currentPath;
      },
    });
    end('complete', { phase: 'done', result: root });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // A build stopped at its cap was not a failure: the folder is larger
    // than TreeMap indexes on its own, and the sentence says so.
    const capReached = err instanceof IndexCapReached;
    end(message === 'cancelled' || capReached ? 'cancelled' : 'error', {
      phase: 'error',
      error: message,
      ...(capReached ? { capReached: true } : {}),
    });
  }
}

/**
 * POST /api/index/build { path, maxEntries? } → 202 { jobId }
 *
 * Returns immediately; progress rides the SSE stream. Indexing a large volume
 * takes as long as a scan does, and §3.3 forbids making the client hold a
 * request open for it.
 *
 * `maxEntries` (a positive whole number, anything else is 400) caps the build:
 * past it the walk stops, the folder's saved index (if any) is left exactly as
 * it was, the stop is remembered (the status's `stoppedAtCap`) and the job
 * ends `cancelled` with a sentence saying so. The page sends the status's
 * `autoBuild.maxEntries` with every build it starts on its own; without it a
 * build is not capped.
 *
 * A request for a folder already being built joins that build when its cap
 * is no tighter (`alreadyRunning: true`, with the cap it joined, null for
 * none); a cancelled build is never joined. Otherwise it joins the one job
 * waiting behind that build, widening that job's cap to its own, or, with
 * none waiting, gets a job of its own that starts once that build has
 * settled.
 */
indexRouter.post('/index/build', guardBodyPath, async (req: Request, res: Response) => {
  reapJobs();
  const { path: rootPath, maxEntries } = req.body as { path: string; maxEntries?: unknown };
  if (maxEntries !== undefined && !(typeof maxEntries === 'number' && Number.isSafeInteger(maxEntries) && maxEntries > 0)) {
    throw new AppError(400, 'MAX_ENTRIES_INVALID', 'maxEntries must be a whole number of items, 1 or more');
  }
  // The same policy gate scanning uses: an allowlisted deployment must not be
  // able to index its way around the restriction.
  assertScanAllowed(await getPolicy(), rootPath);

  const running = [...jobs.values()].filter((j) => j.rootPath === rootPath && j.status === 'running');
  // A cancelled job is never joined: it ends 'cancelled' whatever it is
  // asked (Track U review L3a). It is still waited behind, below, so two
  // builds of one folder never run at once.
  const joinable = running.filter((j) => !j.cancelled);
  const joined = joinable.find((j) => capCovers(j.maxEntries, maxEntries));
  if (joined) {
    res.status(202).json({ jobId: joined.jobId, status: 'running', alreadyRunning: true, maxEntries: joined.maxEntries ?? null });
    return;
  }
  // At most one job waits behind a running build of a folder (L3c). A
  // request the waiting job does not cover widens it to its own cap, so one
  // walk answers both: it has not started, and a looser cap only lets it
  // write more of the same folder.
  const waiting = joinable.find((j) => j.queued);
  if (waiting) {
    if (maxEntries === undefined) delete waiting.maxEntries;
    else waiting.maxEntries = maxEntries;
    res.status(202).json({ jobId: waiting.jobId, status: 'running', alreadyRunning: true, maxEntries: waiting.maxEntries ?? null });
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
    queued: running.length > 0,
    ...(maxEntries === undefined ? {} : { maxEntries }),
  };
  jobs.set(job.jobId, job);
  // Deliberately not awaited: the response goes out now. Queued behind the
  // newest build of the same folder, which itself waits on any before it.
  job.settled = runJob(job, running.at(-1));

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
      sseSend(res, {
        type: 'error',
        message: job.error ?? 'Index build failed',
        // Stopped at its cap rather than failed: said in a code beside the sentence, as /result says it.
        ...(job.capReached ? { code: 'INDEX_CAP_REACHED', maxEntries: job.maxEntries } : {}),
      });
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

/**
 * GET /api/index/:jobId/result — 202 while running, 200 when done.
 *
 * A build that stopped at its cap answers 409 INDEX_CAP_REACHED with the
 * sentence and the cap: nothing failed, the folder holds more than the build
 * may write. Anything else that did not complete (a failure, a cancel) is
 * 500 INDEX_BUILD_FAILED, as it always was.
 */
indexRouter.get('/index/:jobId/result', (req: Request, res: Response) => {
  const job = requireJob(req.params.jobId);
  if (job.status === 'running') {
    res.status(202).json({ status: 'running', phase: job.phase, processed: job.processed, currentPath: job.currentPath });
    return;
  }
  if (job.capReached) {
    throw new AppError(409, 'INDEX_CAP_REACHED', job.error ?? 'Stopped at its cap', { maxEntries: job.maxEntries });
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
 * instantly and starting a scan. Both carry `autoBuild: { maxEntries }`, the
 * most items a folder may hold for the page to index it on its own; with a
 * path, `stoppedAtCap` follows it: `{ maxEntries, at, reason }` when the last
 * capped build of exactly that folder stopped at its cap, else null.
 *
 * A root's `live` says whether a watcher is attached now. `state: 'ready'`
 * alone does not: a watch that could not be established leaves a freshly
 * built root 'ready' and unwatched, and a build with `live: false` attaches
 * none. "Current" is both together, as the badge and the page's build plan
 * read it.
 */
indexRouter.get('/index/status', guardQueryPath('path'), (req: Request, res: Response) => {
  const target = req.query.path as string | undefined;
  if (target === undefined) {
    // The database size is reported because the index is genuinely large — a
    // 366,000-file home directory measured ~200 MB — and a cache that grows
    // without the user being able to see it is the kind of thing that turns
    // into a support complaint. `DELETE /api/index` is the answer, and this is
    // what tells them whether they need it.
    res.json({ roots: listRoots(), dbPath: indexDbPathSafe(), dbBytes: indexDbBytes(), autoBuild: autoBuild() });
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
    // After every earlier key, so each keeps its position (plan U-1).
    autoBuild: autoBuild(),
    // Whether the last capped build of exactly this folder stopped at its
    // cap, or null: the page then offers instead of building it again after
    // every scan (Track U review of U-1).
    stoppedAtCap: capStopFor(target),
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
indexRouter.post('/index/watch', guardBodyPath, async (req: Request, res: Response) => {
  const { path: rootPath } = req.body as { path: string };
  const root = getRoot(rootPath);
  if (!root) throw new AppError(404, 'INDEX_NOT_BUILT', 'That folder has not been indexed yet');
  // What the index leaves out, for an index an earlier process built (U-24);
  // one this process built keeps its own build's list.
  const attached = startWatcher(rootPath, await boundaryFor(rootPath));
  res.json({ path: rootPath, watching: attached });
});

/**
 * DELETE /api/index[?path=] — drop one root, or the whole index.
 *
 * Not gated behind a confirmation like the destructive endpoints are: nothing
 * on disk is touched, and everything here can be rebuilt from the filesystem.
 *
 * Every build of what is removed — running, or waiting to run — is cancelled
 * first, or it would bring the index back (Track U review L3b); the engine
 * stops a running one too, whoever removes the index.
 */
indexRouter.delete('/index', guardQueryPath('path'), (req: Request, res: Response) => {
  const target = req.query.path as string | undefined;
  for (const job of jobs.values()) {
    if (job.status === 'running' && (target === undefined || job.rootPath === target)) job.cancelled = true;
  }
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
 * Whether the allocation routes may read `root` (plan U-7, U-D5): only a
 * 'ready' or 'stale' root is read. A root still being built answers 202
 * `{ status: 'building' }` and nothing else — its rows are the part of a walk
 * written so far, and summed they would be stated as a whole account — and a
 * root whose build failed answers as `/api/index/tree` answers it. Returns
 * true once it has answered.
 */
function answeredUnread(root: IndexedRoot, res: Response): boolean {
  if (root.state === 'building') {
    res.status(202).json({ status: 'building' });
    return true;
  }
  if (root.state === 'error') {
    throw new AppError(500, 'INDEX_BUILD_FAILED', root.error ?? 'The index for that folder could not be built');
  }
  return false;
}

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
 *
 * A root still being built answers 202 `{ status: 'building' }`, one whose
 * build failed 500 INDEX_BUILD_FAILED, and one whose allocation TreeMap did
 * not measure — built from a scan, or on Windows — 409
 * ALLOCATION_NOT_MEASURED with a sentence and no number (plan U-7).
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
  if (answeredUnread(root, res)) return;
  const summary = await accountFor(root.path);
  if (!summary) throw new AppError(404, 'INDEX_NOT_BUILT', 'That folder is not in the index');
  res.json(summary);
});

/**
 * GET /api/allocation/file?path= (A2)
 *
 * The per-file split behind a tooltip: "2.1 GB total, 340 MB exclusive to this
 * copy". Answers 404 for a file that is not in the index rather than inventing
 * a zero, and 202, 500 or 409 as `/api/allocation` does.
 */
indexRouter.get('/allocation/file', guardQueryPath('path'), (req: Request, res: Response) => {
  const target = String(req.query.path ?? '');
  if (!target) throw new AppError(400, 'PATH_REQUIRED', 'Provide a file "path"');

  const root = rootFor(target);
  if (!root) throw new AppError(404, 'INDEX_NOT_BUILT', 'That file’s folder has not been indexed yet');
  if (answeredUnread(root, res)) return;
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
