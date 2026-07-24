import { Router, Request, Response } from 'express';
import path from 'path';
import { buildOpenApiDocument, ENDPOINTS } from './openapi';
import { clampInt, requireScan } from './scanRoutes';
import { readAudit } from '../services/audit';
import { getPolicy, POLICY_FILE } from '../services/policy';
import { appDataDir } from '../services/storage';
import { collectLargestFiles, collectLargestFolders } from '../services/diskScanner';
import { collectCleanupSuggestions } from '../services/cleanupRules';
import { getIgnoreMatchers } from '../services/settings';
import { getForecast } from '../services/forecast';
import { storeOf } from '../services/scanStore';
import { formatBytes } from '../utils/formatBytes';
import { AppError } from '../middleware/errorHandler';
import { SuggestionCategory } from '../models/types';

/**
 * metaRoutes — self-description for agents: the OpenAPI document and a
 * compact capability manifest. Both are generated from the same endpoint
 * registry (src/api/openapi.ts), so they cannot disagree about what exists.
 * Read-only and side-effect-free by construction.
 */

const { version: APP_VERSION } = require('../../package.json') as { version: string };

export const metaRouter = Router();

/** GET /api/openapi.json — the OpenAPI 3 document. */
metaRouter.get('/openapi.json', (_req: Request, res: Response) => {
  res.json(buildOpenApiDocument());
});

/** GET /api/audit?limit=100 — the destructive-action audit log, newest first. */
metaRouter.get('/audit', async (req: Request, res: Response) => {
  const limit = clampInt(req.query.limit, 100, 1, 1000);
  res.json({ entries: await readAudit(limit) });
});

/**
 * GET /api/policy — the active agent policy and where to edit it.
 * Deliberately read-only: a policy an agent could rewrite for itself would
 * be theatre. The human edits the JSON file.
 */
metaRouter.get('/policy', async (_req: Request, res: Response) => {
  res.json({ policy: await getPolicy(), file: path.join(appDataDir(), POLICY_FILE) });
});

/**
 * GET /api/agent/summary?scanId= — the whole picture in one read-only call:
 * top culprits, reclaimable-by-category, and the disk-full forecast, composed
 * from the exact services the individual endpoints use. Every number comes as
 * raw bytes plus a formatted string; ids are the services' stable ids; every
 * list is deterministically ordered (size desc), so two calls over the same
 * scan return identical payloads.
 */
metaRouter.get('/agent/summary', async (req: Request, res: Response) => {
  const scan = requireScan(req, req.query.scanId);
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running', scanned: scan.scanned, currentPath: scan.currentPath });
    return;
  }
  if (scan.status === 'error' || (!scan.store && !scan.root)) {
    throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  }

  const store = storeOf(scan);
  const totalBytes = store.size(store.rootId);

  const largestFiles = collectLargestFiles(store, 10, 0).map((f) => ({ ...f, sizeFormatted: formatBytes(f.size) }));
  const largestFolders = collectLargestFolders(store, 10, 0).map((f) => ({ ...f, sizeFormatted: formatBytes(f.size) }));

  const ignore = await getIgnoreMatchers('suggest');
  const groups = collectCleanupSuggestions(store, ignore); // already sorted largest first
  const reclaimableBytes = groups.reduce((sum, g) => sum + g.totalSize, 0);
  const byCategoryMap = new Map<SuggestionCategory, { bytes: number; groupCount: number }>();
  for (const g of groups) {
    const agg = byCategoryMap.get(g.category) ?? { bytes: 0, groupCount: 0 };
    agg.bytes += g.totalSize;
    agg.groupCount += 1;
    byCategoryMap.set(g.category, agg);
  }
  const byCategory = [...byCategoryMap.entries()]
    .map(([category, agg]) => ({ category, bytes: agg.bytes, bytesFormatted: formatBytes(agg.bytes), groupCount: agg.groupCount }))
    .sort((a, b) => b.bytes - a.bytes || a.category.localeCompare(b.category));

  const forecast = await getForecast(scan.rootPath);

  res.json({
    scanId: scan.scanId,
    rootPath: scan.rootPath,
    totals: {
      bytes: totalBytes,
      formatted: formatBytes(totalBytes),
      fileCount: scan.fileCount,
      dirCount: scan.dirCount,
    },
    largestFiles,
    largestFolders,
    cleanup: {
      reclaimableBytes,
      reclaimableFormatted: formatBytes(reclaimableBytes),
      byCategory,
      groups: groups.slice(0, 10).map((g) => ({
        id: g.id,
        title: g.title,
        category: g.category,
        totalSize: g.totalSize,
        totalSizeFormatted: formatBytes(g.totalSize),
        itemCount: g.items.length,
        ...(g.regenerateCmd !== undefined ? { regenerateCmd: g.regenerateCmd } : {}),
        topItems: g.items.slice(0, 3).map((i) => ({ ...i, sizeFormatted: formatBytes(i.size) })),
      })),
    },
    forecast: {
      ...forecast,
      bytesPerDayFormatted: formatBytes(Math.abs(forecast.bytesPerDay)),
      freeFormatted: formatBytes(forecast.freeBytes),
    },
  });
});

/** GET /api/capabilities — endpoints, safety model, and the intended workflow. */
metaRouter.get('/capabilities', (_req: Request, res: Response) => {
  res.json({
    name: 'treemap',
    version: APP_VERSION,
    description: 'Local, privacy-preserving disk-space visualizer with agent-facing surfaces',
    docs: {
      openapi: '/api/openapi.json',
      agents: 'AGENTS.md at the repository root documents workflows and the safety model',
    },
    errors: {
      shape: '{ error, code }',
      note: 'Every endpoint reports failures as JSON with a human message and a stable machine code',
    },
    auth: {
      enabled: !!process.env.TREEMAP_TOKEN,
      scheme: 'bearer',
      how: 'Send "Authorization: Bearer <TREEMAP_TOKEN>"; the served web UI authenticates via an auto-set cookie instead',
      env: 'TREEMAP_TOKEN — unset (the default) means no auth, exactly the historical behavior',
      unauthorized: { status: 401, code: 'UNAUTHORIZED' },
    },
    cors: {
      enabled: !!process.env.TREEMAP_ALLOWED_ORIGINS,
      env: 'TREEMAP_ALLOWED_ORIGINS — comma-separated origins; unset (the default) emits no CORS headers',
    },
    rateLimit: { sustainedPerSecond: 10, burst: 20, status: 429, code: 'RATE_LIMITED' },
    safety: {
      trashOnlyDeletes: 'Deletes move files to the OS Trash (recoverable); nothing is hard-deleted',
      scannedRootRule:
        'Destructive and OS-touching endpoints only accept paths inside a root this server has actually scanned',
      pathSanitization:
        'Every user-supplied path is sanitized: traversal resolved, null bytes rejected, OS-internal directories blocked',
      cloudPaths: "cloud:// paths never touch the local filesystem; their deletes go to the provider's own trash",
      virtualPaths: 'Entries inside archives are listings, not files — only the archive itself can be acted on',
      offload: 'Offload copies, verifies SHA-256, and only then trashes originals; failures roll back completely',
      dryRun:
        'DELETE /api/files, POST /api/offload and POST /api/offload/restore accept dryRun: true — the exact manifest, nothing acted on',
      policy:
        'agent-policy.json (see GET /api/policy) can allowlist roots, protect paths forever, and cap bytes per operation; empty file = no restriction',
      audit: 'Every destructive request (real, dry-run, refused) is appended to an audit log — GET /api/audit reads it back',
      idempotency:
        'Destructive endpoints honor an Idempotency-Key header: a retried request replays the stored response instead of executing twice',
    },
    workflow: [
      'POST /api/scan with { path } → { scanId } (add ?wait=true to block until done)',
      'Poll GET /api/scan/{scanId}/stats until status is "complete" (or stream /progress via SSE)',
      'GET /api/agent/summary?scanId= for the whole picture in one call, or explore: /api/large-files, /api/large-folders, /api/cleanup/suggestions, /api/duplicates, /api/forecast',
      'Confirm intent with the user, dry-run the destructive call (dryRun: true), then act: DELETE /api/files or POST /api/offload',
      'Anything trashed is recoverable from the OS Trash',
    ],
    mcp: {
      transport: 'stdio',
      start: 'npm run mcp',
      tools: [
        'scan_path',
        'get_largest',
        'find_duplicates',
        'cleanup_suggestions',
        'forecast',
        'compare_scans',
        'offload',
        'trash_paths',
      ],
    },
    endpoints: ENDPOINTS.map((e) => ({
      method: e.method.toUpperCase(),
      path: e.path,
      summary: e.summary,
      destructive: e.destructive,
    })),
  });
});
