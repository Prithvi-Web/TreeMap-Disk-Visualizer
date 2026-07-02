import { Router, Request, Response } from 'express';
import { requireScan } from './scanRoutes';
import { PROVIDERS, providerById, credentialsFor, tokenFor, CloudProviderId } from '../services/cloud/providers';
import { startCloudScan, trashCloudPaths } from '../services/cloud/cloudScan';
import { startAuth, finishAuthManually, getTokens, saveTokens, deleteTokens } from '../services/cloud/oauth';
import { getSettings } from '../services/settings';
import { guardBodyPaths } from '../middleware/pathGuard';
import { AppError } from '../middleware/errorHandler';
import { FileNode, ScanResult } from '../models/types';

/**
 * cloudRoutes — the ONLY routes that ever talk to the internet, and only to
 * the user's own cloud accounts. With no account connected, /status reads a
 * local JSON file and returns — zero network. Cloud paths never reach the
 * filesystem guards: they live in their own scan records and their deletes
 * go to the provider's trash via /cloud/trash.
 */

export const cloudRouter = Router();

/** Quota results cached briefly so the dashboard doesn't hammer providers. */
const quotaCache = new Map<string, { at: number; used: number; total: number }>();
const QUOTA_TTL_MS = 5 * 60_000;

/** After a successful connect, capture the account label for the UI. */
async function captureAccount(providerId: CloudProviderId): Promise<void> {
  try {
    const provider = providerById(providerId);
    const token = await tokenFor(provider);
    const account = await provider.account(token);
    const tokens = await getTokens(providerId);
    if (tokens) await saveTokens(providerId, { ...tokens, account });
  } catch {
    /* label is cosmetic — connection still works without it */
  }
}

/** GET /api/cloud/status — local-only unless an account is connected. */
cloudRouter.get('/cloud/status', async (_req: Request, res: Response) => {
  const settings = await getSettings();
  const out = [];
  for (const provider of Object.values(PROVIDERS)) {
    const configured = !!settings.cloud[provider.id]?.clientId;
    const tokens = await getTokens(provider.id);
    const entry: Record<string, unknown> = {
      id: provider.id,
      name: provider.name,
      configured,
      connected: !!tokens,
      account: tokens?.account,
      trashLabel: provider.trashLabel,
      needsClientSecret: provider.needsClientSecret,
    };
    if (tokens && configured) {
      const cached = quotaCache.get(provider.id);
      if (cached && Date.now() - cached.at < QUOTA_TTL_MS) {
        entry.quota = { used: cached.used, total: cached.total };
      } else {
        try {
          const quota = await provider.quota(await tokenFor(provider));
          quotaCache.set(provider.id, { at: Date.now(), ...quota });
          entry.quota = quota;
        } catch {
          entry.quota = cached ? { used: cached.used, total: cached.total } : undefined;
        }
      }
    }
    out.push(entry);
  }
  res.json({ providers: out });
});

/** POST /api/cloud/connect { provider } → { authorizeUrl, redirectUri } */
cloudRouter.post('/cloud/connect', async (req: Request, res: Response) => {
  const { provider: id } = req.body as { provider?: unknown };
  const provider = providerById(String(id ?? ''));
  const { clientId, clientSecret } = await credentialsFor(provider);
  const started = await startAuth(
    {
      providerId: provider.id,
      authUrl: provider.authUrl,
      tokenUrl: provider.tokenUrl,
      clientId,
      clientSecret,
      scope: provider.scope,
      extraAuthParams: provider.extraAuthParams,
    },
    (err) => {
      if (!err) void captureAccount(provider.id);
    },
  );
  res.json(started);
});

/** POST /api/cloud/connect/manual { input } — pasted redirect URL or code. */
cloudRouter.post('/cloud/connect/manual', async (req: Request, res: Response) => {
  const { input } = req.body as { input?: unknown };
  if (typeof input !== 'string' || !input.trim()) {
    throw new AppError(400, 'INPUT_REQUIRED', 'Paste the redirect URL or the code');
  }
  const providerId = await finishAuthManually(input);
  await captureAccount(providerId as CloudProviderId);
  res.json({ connected: providerId });
});

/** POST /api/cloud/disconnect { provider } — wipes the stored tokens. */
cloudRouter.post('/cloud/disconnect', async (req: Request, res: Response) => {
  const { provider: id } = req.body as { provider?: unknown };
  const provider = providerById(String(id ?? ''));
  await deleteTokens(provider.id);
  quotaCache.delete(provider.id);
  res.json({ disconnected: provider.id });
});

/** POST /api/cloud/scan { provider } → 202 { scanId } (progress via /api/scan/:id/progress). */
cloudRouter.post('/cloud/scan', async (req: Request, res: Response) => {
  const { provider: id } = req.body as { provider?: unknown };
  const scan = await startCloudScan(String(id ?? ''));
  res.status(202).json({ scanId: scan.scanId });
});

/**
 * POST /api/cloud/trash { scanId, paths } — deletes map to the provider's
 * own trash, mirroring the local trash-only rule.
 */
cloudRouter.post('/cloud/trash', guardBodyPaths, async (req: Request, res: Response) => {
  const body = req.body as { scanId?: unknown; paths: string[] };
  const scan = requireScan(req, body.scanId);
  if (scan.status !== 'complete' || !scan.root) throw new AppError(409, 'SCAN_RUNNING', 'Wait for the scan to finish');
  if (!scan.rootPath.startsWith('cloud://')) {
    throw new AppError(400, 'NOT_A_CLOUD_SCAN', 'Use DELETE /api/files for local scans');
  }
  for (const p of body.paths) {
    if (!p.startsWith(scan.rootPath + '/')) {
      throw new AppError(403, 'OUTSIDE_SCAN_ROOT', `"${p}" is not inside this cloud scan`);
    }
  }
  res.json(await trashCloudPaths(scan as ScanResult & { root: FileNode }, body.paths));
});
