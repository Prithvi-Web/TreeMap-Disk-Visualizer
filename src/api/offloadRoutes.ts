import { Router, Request, Response } from 'express';
import { requireScan } from './scanRoutes';
import {
  prepareOffload,
  startOffload,
  startRestore,
  getOffloadJob,
  cancelOffloadJob,
  getOffloadIndex,
  getOffloadEntry,
} from '../services/offload';
import { openPath } from '../services/cleaner';
import { guardBodyPaths, requireInsideScanRoot } from '../middleware/pathGuard';
import { idempotency } from '../middleware/idempotency';
import { getPolicy, assertPathsAllowed, assertBytesCap } from '../services/policy';
import { appendAudit, tokenIdFor } from '../services/audit';
import { sanitizePath } from '../utils/pathSanitizer';
import { sseSend } from '../utils/sse';
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

/** Typed front for the shared guarded SSE writer — never raw res.write. */
function send(res: Response, event: OffloadStreamEvent): void {
  sseSend(res, event);
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
 * POST /api/offload { scanId, paths[], dest, dryRun? } → 202 { jobId }
 * Sources must be inside a scanned root (and not inside an archive).
 * With dryRun: true, returns the exact copy plan (files, bytes, wouldTrash)
 * having validated everything a real run would — and does nothing.
 * Honors an Idempotency-Key header so a retry can't start a second job.
 */
offloadRouter.post('/offload', idempotency, guardBodyPaths, requireInsideScanRoot, async (req: Request, res: Response) => {
  const body = req.body as { scanId?: unknown; paths: string[]; dest?: unknown; dryRun?: unknown };
  const scan = requireScan(req, body.scanId);
  if (scan.status !== 'complete' || (!scan.store && !scan.root)) {
    throw new AppError(409, 'SCAN_RUNNING', 'Wait for the scan to finish first');
  }
  if (typeof body.dest !== 'string' || !body.dest.trim()) {
    throw new AppError(400, 'DEST_REQUIRED', 'Pick a destination folder');
  }
  const dest = sanitizePath(body.dest);
  const dryRun = body.dryRun === true;
  const policy = await getPolicy();
  try {
    assertPathsAllowed(policy, body.paths); // originals get trashed after verify
    const prepared = await prepareOffload(scan, body.paths, dest);
    assertBytesCap(policy, prepared.bytesTotal);

    if (dryRun) {
      await appendAudit({ action: 'offload.start', source: 'http', tokenId: tokenIdFor('http'), paths: body.paths, bytes: prepared.bytesTotal, dryRun: true, outcome: 'ok' });
      res.json({
        dryRun: true,
        fileCount: prepared.plan.length,
        bytesTotal: prepared.bytesTotal,
        dest,
        wouldTrashAfterVerify: body.paths,
        copies: prepared.plan.slice(0, 100).map((c) => ({ src: c.src, dest: c.dest, size: c.size })),
        copiesTruncated: prepared.plan.length > 100,
      });
      return;
    }

    const job = await startOffload(scan, body.paths, dest, prepared);
    await appendAudit({ action: 'offload.start', source: 'http', tokenId: tokenIdFor('http'), paths: body.paths, bytes: prepared.bytesTotal, dryRun: false, outcome: 'ok' });
    res.status(202).json({ jobId: job.jobId });
  } catch (err) {
    if (err instanceof AppError) {
      await appendAudit({ action: 'offload.start', source: 'http', tokenId: tokenIdFor('http'), paths: body.paths, bytes: null, dryRun, outcome: 'refused', code: err.code });
    }
    throw err;
  }
});

/**
 * POST /api/offload/restore { ids: [], dryRun? } → 202 { jobId }
 * With dryRun: true, lists exactly which entries would be restored (and
 * where to) without copying anything. Honors an Idempotency-Key header.
 */
offloadRouter.post('/offload/restore', idempotency, async (req: Request, res: Response) => {
  const { ids, dryRun } = req.body as { ids?: unknown; dryRun?: unknown };
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === 'string')) {
    throw new AppError(400, 'IDS_REQUIRED', 'Body must include a non-empty "ids" array');
  }
  if (ids.length > 500) throw new AppError(400, 'TOO_MANY_IDS', 'At most 500 restores per request');

  if (dryRun === true) {
    const entries = [];
    for (const id of ids as string[]) {
      const entry = await getOffloadEntry(id);
      if (entry && !entry.restoredAt) {
        entries.push({ id: entry.id, name: entry.name, originalPath: entry.originalPath, destPath: entry.destPath, size: entry.size });
      }
    }
    const bytesTotal = entries.reduce((sum, e) => sum + e.size, 0);
    await appendAudit({ action: 'offload.restore', source: 'http', tokenId: tokenIdFor('http'), paths: entries.map((e) => e.originalPath), bytes: bytesTotal, dryRun: true, outcome: 'ok' });
    res.json({ dryRun: true, wouldRestore: entries, bytesTotal });
    return;
  }

  const job = await startRestore(ids as string[]);
  await appendAudit({ action: 'offload.restore', source: 'http', tokenId: tokenIdFor('http'), paths: [], bytes: job.bytesTotal, dryRun: false, outcome: 'ok' });
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
