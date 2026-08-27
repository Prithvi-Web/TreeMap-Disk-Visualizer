import { Router, Request, Response } from 'express';
import { getCapabilities, invalidateCapabilities, capabilityState } from '../platform/capabilities';
import { platform } from '../platform';
import { AppError } from '../middleware/errorHandler';
import { portableStatus, listExternalVolumes } from '../services/portableMode';
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
  // The reader refuses to pass on an answer that cannot be true (see
  // macos/diskutil.ts) and throws when a re-read will not clear. That throw is
  // the honest outcome, but a 500 is not the honest *presentation* of it: §10
  // asks for an unavailable state carrying its reason, which is what the tab
  // already knows how to render.
  let topology;
  try {
    topology = await platform().getVolumeTopology();
  } catch (err) {
    throw new AppError(409, 'CAPABILITY_UNAVAILABLE', err instanceof Error ? err.message : String(err));
  }
  res.json({ ...topology, capability: state });
});

/**
 * GET /api/platform/portable — is this a no-trace portable session? (D3)
 *
 * Answers even when it is not, so the frontend can decide once at boot whether
 * to show the portable first-run screen.
 */
platformRouter.get('/platform/portable', (_req: Request, res: Response) => {
  const status = portableStatus();
  res.json({
    ...status,
    externalVolumes: status.portable ? listExternalVolumes() : [],
  });
});

/**
 * GET /api/platform/shell-integration — is "Scan with TreeMap" in place? (D2)
 *
 * The installed flag is read from the filesystem/registry every time rather
 * than remembered: an entry removed by hand, or left behind by an uninstall,
 * must be reported truthfully. D2's "removing integration cleanly removes the
 * entry" is only checkable if we look.
 */
platformRouter.get('/platform/shell-integration', async (_req: Request, res: Response) => {
  const state = await capabilityState('shellIntegration');
  res.json({
    supported: state.available,
    mechanism: state.mechanism,
    reason: state.reason,
    installed: state.available ? await platform().shellIntegrationInstalled() : false,
  });
});

/**
 * POST /api/platform/shell-integration { install: boolean }
 *
 * Adds or removes the right-click entry. Per-user in every implementation —
 * no administrator rights, nothing written outside the user's own account —
 * which is why this needs no elevation prompt (§3.8).
 */
platformRouter.post('/platform/shell-integration', async (req: Request, res: Response) => {
  const { install } = req.body as { install?: unknown };
  if (typeof install !== 'boolean') {
    throw new AppError(400, 'INSTALL_REQUIRED', 'Body must be { install: true } or { install: false }');
  }
  const state = await capabilityState('shellIntegration');
  if (!state.available) {
    throw new AppError(409, 'CAPABILITY_UNAVAILABLE', state.reason ?? 'Shell integration is not available on this system');
  }
  const provider = platform();
  const result = install ? await provider.registerShellIntegration() : await provider.unregisterShellIntegration();
  // Report what is ACTUALLY there afterwards, not what we intended.
  res.json({ ...result, installed: await provider.shellIntegrationInstalled(), mechanism: state.mechanism });
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
