import { Router, Request, Response } from 'express';
import { getCapabilities, invalidateCapabilities, capabilityState } from '../platform/capabilities';
import { platform } from '../platform';
import { AppError } from '../middleware/errorHandler';
import type { Capabilities } from '../platform/types';

/**
 * platformRoutes — what this machine can and cannot do (§2.2).
 *
 * ── Why not `GET /api/capabilities`, which §2.2 names? ──
 *
 * That path is already taken. It serves the agent-facing manifest (endpoint
 * list, safety model, workflow), is generated from the ENDPOINTS registry in
 * openapi.ts, is documented in AGENTS.md, and is pinned by
 * tests/discoverability.test.ts. §4 is unambiguous that every existing endpoint
 * keeps its current path, parameters and response shape — so reusing it would
 * break a documented contract to satisfy a naming suggestion.
 *
 * The resolution keeps both promises: platform capabilities live at
 * `GET /api/platform/capabilities`, and the existing manifest gains one
 * *additive* optional `platform` key pointing at it. Nothing existing changes
 * shape; the frontend has one place to read from. Recorded in
 * docs/PLATFORM_NOTES.md.
 */

export const platformRouter = Router();

/**
 * GET /api/platform/capabilities
 *
 * Every capability-gated feature, each in one of the three honest states from
 * §2.2: available, unavailable with a reason a person can act on, or degraded
 * to a named fallback. The frontend's view registry reads this to decide
 * whether a panel renders, hides, or shows its disabled state with the reason.
 *
 * Never fails as a whole: a probe that throws becomes an unavailable capability
 * carrying its own reason (see capabilities.ts), because one broken probe must
 * not blank out the entire UI (§6, failure isolation).
 */
platformRouter.get('/platform/capabilities', async (_req: Request, res: Response) => {
  const capabilities = await getCapabilities();
  res.json({
    platform: capabilities.platform,
    /** Node's own name for the platform, for anyone who needs the literal truth. */
    nodePlatform: process.platform,
    capabilities,
  });
});

/**
 * POST /api/platform/capabilities/refresh
 *
 * Re-probe now. Capabilities are cached for 30s, but granting Full Disk Access,
 * installing smartmontools or plugging in a drive changes the answer at a
 * moment the user knows about and the cache does not — so the UI can ask for a
 * fresh look rather than making them wait or restart (§3.8).
 */
platformRouter.post('/platform/capabilities/refresh', async (_req: Request, res: Response) => {
  invalidateCapabilities();
  res.json({ capabilities: await getCapabilities() });
});

/** GET /api/platform/topology — physical disks and the volumes on them (A5). */
platformRouter.get('/platform/topology', async (_req: Request, res: Response) => {
  const state = await capabilityState('volumeTopology');
  if (!state.available) {
    throw new AppError(409, 'CAPABILITY_UNAVAILABLE', state.reason ?? 'Disk layout is not available on this system');
  }
  const topology = await platform().getVolumeTopology();
  res.json({ ...topology, capability: state });
});

/**
 * Compact mirror for the existing agent manifest.
 *
 * Only the shape an agent needs — which capabilities are on — without the prose
 * reasons, which are written for a person reading a panel.
 */
export function capabilitySummary(capabilities: Capabilities): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(capabilities)) {
    if (key === 'platform') continue;
    out[key] = (value as { available: boolean }).available;
  }
  return out;
}
