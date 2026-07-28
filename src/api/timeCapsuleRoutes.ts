import { Router, Request, Response } from 'express';
import {
  getCapsuleIndex,
  getCapsuleEntry,
  deleteCapsuleEntry,
  startCapsuleRestore,
  getCapsuleJob,
  cancelCapsuleJob,
} from '../services/timeCapsule';
import { idempotency } from '../middleware/idempotency';
import { appendAudit, tokenIdFor } from '../services/audit';
import { sseSend } from '../utils/sse';
import { AppError } from '../middleware/errorHandler';
import { TimeCapsuleJob, TimeCapsuleStreamEvent } from '../models/types';

/**
 * timeCapsuleRoutes — the recovery index, and restoring from it (B3).
 *
 * There is deliberately no endpoint here that *puts* anything into the
 * capsule. Capture only ever happens as part of `protectAndTrash`, which is
 * the automated-deletion pathway itself; exposing a "protect this" route would
 * create a way to fill the capsule without a deletion behind it, and a second
 * thing to keep in step with the delete rules.
 *
 * Restore streams over SSE like every other job in the app (§3.3): the capsule
 * can hold a folder of many thousands of files, so it is exactly the kind of
 * work that must not be a single blocking request.
 */

export const timeCapsuleRouter = Router();

interface CapsuleSseClient {
  res: Response;
  timer: NodeJS.Timeout;
}
const sseClients = new Set<CapsuleSseClient>();

/** Typed front for the shared guarded SSE writer — never raw res.write. */
function send(res: Response, event: TimeCapsuleStreamEvent): void {
  sseSend(res, event);
}

function closeClient(client: CapsuleSseClient): void {
  clearInterval(client.timer);
  sseClients.delete(client);
  try {
    client.res.end();
  } catch {
    /* already gone */
  }
}

/** Graceful shutdown: tell clients, then end each stream. */
export function drainCapsuleClients(): void {
  for (const client of [...sseClients]) {
    try {
      send(client.res, { type: 'shutdown' });
    } catch { /* socket already dead */ }
    closeClient(client);
  }
}

/** GET /api/timecapsule — everything protected, with capacity and history. */
timeCapsuleRouter.get('/timecapsule', async (_req: Request, res: Response) => {
  res.json(await getCapsuleIndex());
});

/**
 * POST /api/timecapsule/:id/restore → 202 { jobId }
 *
 * Refuses when anything already occupies the original path; restoring never
 * overwrites what is there now. Honors an Idempotency-Key header so a retry
 * cannot start a second copy of the same restore.
 */
timeCapsuleRouter.post('/timecapsule/:id/restore', idempotency, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const job = await startCapsuleRestore([id]);
    await appendAudit({
      action: 'timecapsule.restore', source: 'http', tokenId: tokenIdFor('http'),
      paths: [], bytes: job.bytesTotal, dryRun: false, outcome: 'ok',
    });
    res.status(202).json({ jobId: job.jobId });
  } catch (err) {
    if (err instanceof AppError) {
      await appendAudit({
        action: 'timecapsule.restore', source: 'http', tokenId: tokenIdFor('http'),
        paths: [], bytes: null, dryRun: false, outcome: 'refused', code: err.code,
      });
    }
    throw err;
  }
});

/**
 * DELETE /api/timecapsule/:id — forget one protected item.
 *
 * This removes a *backup copy*, not the user's live data, so it does not go
 * through the Trash: the original was trashed when the item was protected, and
 * putting a second copy of it back into the Trash would be confusing rather
 * than safer.
 */
timeCapsuleRouter.delete('/timecapsule/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const entry = await getCapsuleEntry(id);
  const result = await deleteCapsuleEntry(id);
  await appendAudit({
    action: 'timecapsule.forget', source: 'http', tokenId: tokenIdFor('http'),
    paths: entry ? [entry.originalPath] : [], bytes: result.bytesFreed, dryRun: false, outcome: 'ok',
  });
  res.json(result);
});

/** POST /api/timecapsule/jobs/:jobId/cancel — cooperative cancel + rollback. */
timeCapsuleRouter.post('/timecapsule/jobs/:jobId/cancel', (req: Request, res: Response) => {
  const ok = cancelCapsuleJob(String(req.params.jobId));
  if (!ok) throw new AppError(404, 'JOB_NOT_RUNNING', 'No running job with that id');
  res.json({ cancelling: true });
});

/** GET /api/timecapsule/jobs/:jobId/progress — Server-Sent Events stream. */
timeCapsuleRouter.get('/timecapsule/jobs/:jobId/progress', (req: Request, res: Response) => {
  if (req.method === 'HEAD') {
    res.status(200).set({ 'Content-Type': 'text/event-stream' }).end();
    return;
  }
  const job = getCapsuleJob(String(req.params.jobId));
  if (!job) throw new AppError(404, 'JOB_NOT_FOUND', 'Unknown or expired job id');

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const finish = (j: TimeCapsuleJob): void => {
    if (j.status === 'complete') send(res, { type: 'complete', filesDone: j.filesDone, bytesDone: j.bytesDone });
    else if (j.status === 'cancelled') send(res, { type: 'cancelled' });
    else send(res, { type: 'error', message: j.error ?? 'The restore failed' });
    closeClient(client);
  };

  const timer = setInterval(() => {
    const j = getCapsuleJob(String(req.params.jobId));
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

  const client: CapsuleSseClient = { res, timer };
  sseClients.add(client);
  if (job.status !== 'running') finish(job);

  req.on('close', () => closeClient(client));
});
