import { Router, Request, Response } from 'express';
import { requireScan } from './scanRoutes';
import {
  startOffload,
  startRestore,
  getOffloadJob,
  cancelOffloadJob,
  getOffloadIndex,
  getOffloadEntry,
} from '../services/offload';
import { openPath } from '../services/cleaner';
import { guardBodyPaths, requireInsideScanRoot } from '../middleware/pathGuard';
import { sanitizePath } from '../utils/pathSanitizer';
import { AppError } from '../middleware/errorHandler';
import { FileNode, OffloadJob, OffloadStreamEvent, ScanResult } from '../models/types';

/**
 * offloadRoutes — copy → verify → trash jobs and the Offloaded index.
 * Progress streams over SSE exactly like scan progress. The reveal endpoint
 * is the documented pathGuard exemption: destinations aren't scanned roots,
 * so it only ever opens paths recorded in the offload manifest.
 */

export const offloadRouter = Router();

interface OffloadSseClient {
  res: Response;
  timer: NodeJS.Timeout;
}
const sseClients = new Set<OffloadSseClient>();

function send(res: Response, event: OffloadStreamEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function closeClient(client: OffloadSseClient): void {
  clearInterval(client.timer);
  sseClients.delete(client);
  try {
    client.res.end();
  } catch {
    /* already gone */
  }
}

/** Graceful shutdown: tell clients, then end each stream. */
export function drainOffloadClients(): void {
  for (const client of [...sseClients]) {
    try {
      send(client.res, { type: 'shutdown' });
    } catch { /* socket already dead */ }
    closeClient(client);
  }
}

/**
 * POST /api/offload { scanId, paths[], dest } → 202 { jobId }
 * Sources must be inside a scanned root (and not inside an archive).
 */
offloadRouter.post('/offload', guardBodyPaths, requireInsideScanRoot, async (req: Request, res: Response) => {
  const body = req.body as { scanId?: unknown; paths: string[]; dest?: unknown };
  const scan = requireScan(req, body.scanId);
  if (scan.status !== 'complete' || !scan.root) {
    throw new AppError(409, 'SCAN_RUNNING', 'Wait for the scan to finish first');
  }
  if (typeof body.dest !== 'string' || !body.dest.trim()) {
    throw new AppError(400, 'DEST_REQUIRED', 'Pick a destination folder');
  }
  const dest = sanitizePath(body.dest);
  const job = await startOffload(scan as ScanResult & { root: FileNode }, body.paths, dest);
  res.status(202).json({ jobId: job.jobId });
});

/** POST /api/offload/restore { ids: [] } → 202 { jobId } */
offloadRouter.post('/offload/restore', async (req: Request, res: Response) => {
  const { ids } = req.body as { ids?: unknown };
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === 'string')) {
    throw new AppError(400, 'IDS_REQUIRED', 'Body must include a non-empty "ids" array');
  }
  if (ids.length > 500) throw new AppError(400, 'TOO_MANY_IDS', 'At most 500 restores per request');
  const job = await startRestore(ids as string[]);
  res.status(202).json({ jobId: job.jobId });
});

/** GET /api/offload/index — everything offloaded, grouped by destination. */
offloadRouter.get('/offload/index', async (_req: Request, res: Response) => {
  res.json(await getOffloadIndex());
});

/** POST /api/offload/reveal { id } — reveal an offloaded copy at its destination. */
offloadRouter.post('/offload/reveal', async (req: Request, res: Response) => {
  const { id } = req.body as { id?: unknown };
  if (typeof id !== 'string') throw new AppError(400, 'ID_REQUIRED', 'Body must include "id"');
  const entry = await getOffloadEntry(id);
  if (!entry) throw new AppError(404, 'ENTRY_NOT_FOUND', 'Unknown offload entry');
  await openPath(entry.destPath, true);
  res.json({ revealed: entry.destPath });
});

/** POST /api/offload/:jobId/cancel — cooperative cancel + rollback. */
offloadRouter.post('/offload/:jobId/cancel', (req: Request, res: Response) => {
  const ok = cancelOffloadJob(String(req.params.jobId));
  if (!ok) throw new AppError(404, 'JOB_NOT_RUNNING', 'No running job with that id');
  res.json({ cancelling: true });
});

/** GET /api/offload/:jobId/progress — Server-Sent Events stream. */
offloadRouter.get('/offload/:jobId/progress', (req: Request, res: Response) => {
  if (req.method === 'HEAD') {
    res.status(200).set({ 'Content-Type': 'text/event-stream' }).end();
    return;
  }
  const job = getOffloadJob(String(req.params.jobId));
  if (!job) throw new AppError(404, 'JOB_NOT_FOUND', 'Unknown or expired job id');

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const finish = (j: OffloadJob): void => {
    if (j.status === 'complete') send(res, { type: 'complete', filesDone: j.filesDone, bytesDone: j.bytesDone });
    else if (j.status === 'cancelled') send(res, { type: 'cancelled' });
    else send(res, { type: 'error', message: j.error ?? 'Offload failed' });
    closeClient(client);
  };

  const timer = setInterval(() => {
    const j = getOffloadJob(String(req.params.jobId));
    if (!j) { closeClient(client); return; }
    if (j.status !== 'running') { finish(j); return; }
    send(res, {
      type: 'progress',
      phase: j.phase,
      filesDone: j.filesDone,
      fileCount: j.fileCount,
      bytesDone: Math.min(j.bytesDone, j.bytesTotal),
      bytesTotal: j.bytesTotal,
      currentPath: j.currentPath,
    });
  }, 300);

  const client: OffloadSseClient = { res, timer };
  sseClients.add(client);
  if (job.status !== 'running') finish(job);

  req.on('close', () => closeClient(client));
});
