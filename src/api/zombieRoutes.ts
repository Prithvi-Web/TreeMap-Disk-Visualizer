import { Router, Request, Response } from 'express';
import { capabilityState } from '../platform/capabilities';
import { zombieReport, restartProcess } from '../services/zombieHandles';
import { AppError } from '../middleware/errorHandler';

/**
 * zombieRoutes (B5) — space held by processes that won't let go.
 *
 * Two endpoints, matching the shape §B5 names:
 *
 *   GET  /api/zombie-handles          → the per-process report
 *   POST /api/zombie-handles/restart  → quit (and where supported, reopen) one holder
 *
 * The capability gate answers exactly like the topology endpoint: 409 with the
 * probe's human-readable reason, so the panel renders the honest unavailable
 * state (§2.2) instead of a blank. On Windows that reason explains that the
 * space frees on process or system restart — the mechanism itself needs
 * native handle enumeration TreeMap does not ship (§B5: pick one and do it
 * completely, or report why not).
 */

export const zombieRouter = Router();

/** GET /api/zombie-handles — every unlinked-but-held file, grouped by process. */
zombieRouter.get('/zombie-handles', async (_req: Request, res: Response) => {
  const state = await capabilityState('zombieHandles');
  if (!state.available) {
    throw new AppError(409, 'CAPABILITY_UNAVAILABLE', state.reason ?? 'Held-space detection is not available on this system');
  }
  // The probe can now fail loudly instead of answering `[]`: `lsof` being
  // killed or truncated used to come back as "no held files", which is a
  // confident zero from a check that did not run. A failure here is the same
  // shape as the capability being unavailable — the feature could not answer
  // — so it is reported the same way rather than as a server fault.
  let report;
  try {
    report = await zombieReport();
  } catch (err) {
    throw new AppError(
      409,
      'CAPABILITY_UNAVAILABLE',
      `Held-space detection could not run: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  res.json({ ...report, capability: state });
});

/**
 * POST /api/zombie-handles/restart { pid, processName }
 *
 * Destructive by declaration: quitting a program can lose unsaved work, and
 * the UI confirms before calling. `processName` is required — it is the
 * identity check that stops a recycled pid from quitting the wrong program.
 */
zombieRouter.post('/zombie-handles/restart', async (req: Request, res: Response) => {
  const state = await capabilityState('zombieHandles');
  if (!state.available) {
    throw new AppError(409, 'CAPABILITY_UNAVAILABLE', state.reason ?? 'Held-space detection is not available on this system');
  }

  const { pid, processName } = req.body as { pid?: unknown; processName?: unknown };
  if (typeof pid !== 'number' || !Number.isInteger(pid)) {
    throw new AppError(400, 'PID_INVALID', 'Provide the numeric "pid" of the process to restart');
  }
  if (typeof processName !== 'string' || processName.trim().length === 0) {
    throw new AppError(400, 'PROCESS_NAME_REQUIRED', 'Provide "processName" so the process identity can be confirmed');
  }

  res.json(await restartProcess(pid, processName));
});
