import { Router, Request, Response } from 'express';
import { requireScan } from './scanRoutes';
import { guardBodyPathsMax, requireInsideScanRoot } from '../middleware/pathGuard';
import { AppError } from '../middleware/errorHandler';
import { computeFacts, factProviderIds } from '../services/facts';

/**
 * factRoutes — the per-node fact sidecar (v4 §4.1).
 *
 * **Why this route exists at all.** The scan responses the UI already consumes
 * are held to byte-identity against the pre-rewrite baseline by
 * `tests/goldenResponses.test.ts` — structure, key names, key order, values
 * and child order all compared. Not one field may be added to any of them,
 * not even an optional one, because key *presence* is compared too. So every
 * new per-node fact v4 introduces — last-used date, recoverability, reclaim
 * score, notes, journal attribution — arrives here instead, keyed by path,
 * and is joined to the tree in the browser.
 *
 * That constraint is not a workaround. The goldens are the only proof that
 * the packed-store rewrite did not change what the UI sees, and they stay
 * valuable exactly as long as nothing is allowed to edge into them.
 */

export const factRouter = Router();

/**
 * The batch cap for this route.
 *
 * Higher than the 500 the destructive routes use, and deliberately so: this
 * endpoint answers questions about paths rather than acting on them, and a
 * treemap or a query result can legitimately need facts for a whole screenful
 * at once. Four times the destructive cap, still small enough that one
 * request cannot become an unbounded amount of subprocess work.
 */
export const MAX_FACT_PATHS = 2000;

/**
 * POST /api/facts
 *   body: { scanId, paths: string[], providers: string[] }
 *   → 200 { providers: { [id]: { available, reason?, stats, values } } }
 *
 * Every path is sanitized and must lie inside a root this server actually
 * scanned (§2.3) — the same rule the destructive routes obey, applied to a
 * read-only route on purpose: "which files exist here" is itself information,
 * and scanning is what grants scoped permission to answer questions about a
 * tree.
 *
 * One provider failing never costs the others their answers; see
 * `services/facts/registry.ts`.
 */
factRouter.post(
  '/facts',
  guardBodyPathsMax(MAX_FACT_PATHS),
  requireInsideScanRoot,
  async (req: Request, res: Response) => {
    const body = req.body as { scanId?: unknown; paths: string[]; providers?: unknown };

    // 404s an unknown or expired scanId, exactly as every other scan-scoped
    // route does. Providers guard this again for direct callers, and because
    // a scan can be evicted between here and the await below.
    const scan = requireScan(req, body.scanId);

    const requested = body.providers;
    if (!Array.isArray(requested) || requested.length === 0) {
      throw new AppError(
        400,
        'PROVIDERS_REQUIRED',
        `Request body must include a non-empty "providers" array. Valid ids: ${factProviderIds().join(', ')}`,
      );
    }

    // Named explicitly rather than defaulting to "all": a default would make
    // shipping a new provider silently change every existing caller's
    // response — and its cost, since some providers shell out per batch.
    const ids = [...new Set(requested.map((p) => String(p)))];
    const known = new Set(factProviderIds());
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new AppError(
        400,
        'UNKNOWN_PROVIDER',
        `No fact provider named ${unknown.map((u) => `"${u}"`).join(', ')}. Valid ids: ${factProviderIds().join(', ')}`,
      );
    }

    // A client that navigates away mid-request should stop the work, not just
    // stop reading it: providers shell out to per-OS tools, and an abandoned
    // batch of 2,000 would otherwise keep a subprocess queue busy for nobody.
    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    res.on('close', onClose);
    try {
      const providers = await computeFacts(scan.scanId, body.paths, ids, controller.signal);
      res.json({ providers });
    } finally {
      res.off('close', onClose);
    }
  },
);
