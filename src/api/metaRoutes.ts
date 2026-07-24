import { Router, Request, Response } from 'express';
import path from 'path';
import { buildOpenApiDocument, ENDPOINTS } from './openapi';
import { clampInt } from './scanRoutes';
import { readAudit } from '../services/audit';
import { getPolicy, POLICY_FILE } from '../services/policy';
import { appDataDir } from '../services/storage';

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
      'POST /api/scan with { path } → { scanId }',
      'Poll GET /api/scan/{scanId}/stats until status is "complete" (or stream /progress via SSE)',
      'Explore: /api/large-files, /api/large-folders, /api/cleanup/suggestions, /api/duplicates, /api/forecast',
      'Confirm intent with the user, then act: DELETE /api/files or POST /api/offload',
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
