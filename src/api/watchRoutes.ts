import { Router, Request, Response } from 'express';
import { requireScan } from './scanRoutes';
import { ensureWatchSession, subscribe } from '../services/watcher';
import { sseSend } from '../utils/sse';
import { AppError } from '../middleware/errorHandler';
import { FileNode, ScanResult, WatchStreamEvent } from '../models/types';

/**
 * watchRoutes — live disk activity stream (Live mode). Same SSE pattern as
 * the scan progress endpoint: one long-lived response per client, drained
 * explicitly on graceful shutdown.
 */

export const watchRouter = Router();

interface WatchClient {
  res: Response;
  unsubscribe: () => void;
}
const watchClients = new Set<WatchClient>();

/** Typed front for the shared guarded SSE writer — never raw res.write. */
function send(res: Response, frame: WatchStreamEvent): void {
  sseSend(res, frame);
}

function closeClient(client: WatchClient): void {
  client.unsubscribe();
  watchClients.delete(client);
  try {
    client.res.end();
  } catch {
    /* already gone */
  }
}

/** Called on SIGTERM/SIGINT alongside drainSseClients (scan progress). */
export function drainWatchClients(): void {
  for (const client of [...watchClients]) closeClient(client);
}

/** GET /api/watch/:scanId — SSE stream of { path, delta, kind } frames. */
watchRouter.get('/watch/:scanId', async (req: Request, res: Response) => {
  // Express routes HEAD through GET handlers; a HEAD must not hold a
  // zombie SSE subscription (and its connection) open forever.
  if (req.method === 'HEAD') {
    res.status(200).set({ 'Content-Type': 'text/event-stream' }).end();
    return;
  }
  const scan = requireScan(req, req.params.scanId);
  if (scan.status === 'running') {
    throw new AppError(409, 'SCAN_RUNNING', 'Wait for the scan to finish before watching it');
  }
  if (scan.status === 'error' || (!scan.store && !scan.root)) {
    throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  }

  const session = await ensureWatchSession(scan as ScanResult & { root: FileNode });

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  send(res, { type: 'init', idleMinutes: session.idleMinutes, engine: session.engine });

  const client: WatchClient = {
    res,
    unsubscribe: subscribe(session, (frame) => {
      send(res, frame);
      if (frame.type === 'paused') closeClient(client);
    }),
  };
  watchClients.add(client);

  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      closeClient(client);
    }
  }, 15_000);
  keepAlive.unref();

  req.on('close', () => {
    clearInterval(keepAlive);
    closeClient(client);
  });
});
