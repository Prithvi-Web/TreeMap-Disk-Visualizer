import { Router, Request, Response } from 'express';
import path from 'path';
import { buildOpenApiDocument, ENDPOINTS } from './openapi';
import { clampInt, requireScan } from './scanRoutes';
import { readAudit } from '../services/audit';
import { assertScanAllowed, getPolicy, POLICY_FILE } from '../services/policy';
import { appDataDir } from '../services/storage';
import { collectLargestFiles, collectLargestFolders, scanRootRefusal } from '../services/diskScanner';
import { cleanupSuggestionsCountedFor } from '../services/cleanupMemo';
import { loadRuleCatalog } from '../services/rulePacks';
import { suppressedNoteRoots } from '../services/notes';
import { getIgnoreMatchers } from '../services/settings';
import { getForecast } from '../services/forecast';
import { storeOf } from '../services/scanStore';
import { formatBytes } from '../utils/formatBytes';
import { AppError } from '../middleware/errorHandler';
import { PathRejectedError, sanitizePath } from '../utils/pathSanitizer';
import { AgentPolicy } from '../models/types';
import { rateLimitLanes } from '../middleware/rateLimiter';
import { getCapabilities } from '../platform/capabilities';
// The list alone, from the file that imports nothing: '../mcp/server' would
// load the MCP SDK and zod into every boot (Track U, U-6).
import { MCP_TOOL_NAMES } from '../mcp/toolNames';
import { capabilitySummary } from './platformRoutes';
import { SuggestionCategory } from '../models/types';
import { storageModeGate } from '../middleware/storageModeGate';
import { APP_VERSION } from '../utils/appVersion';

/**
 * metaRoutes — self-description for agents: the OpenAPI document and a
 * compact capability manifest. Both are generated from the same endpoint
 * registry (src/api/openapi.ts), so they cannot disagree about what exists.
 * Read-only and side-effect-free by construction.
 */

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

/** The most folders one GET /api/policy judges for a scan: the start screen's choices, every drive letter among them. */
const MAX_SCAN_ROOTS = 64;

/** One folder's verdict: whether a scan may start there, or the refusal POST /api/scan would answer. */
type ScanRootVerdict = { path: string; allowed: true } | { path: string; allowed: false; code: string; error: string };

/**
 * `?scanRoot=` as asked (repeatable, in order) beside each folder as the path rules read it, or
 * undefined when none is asked about. A folder those rules refuse by its spelling refuses the whole
 * request — 400 PATH_INVALID or PATH_BLOCKED, POST /api/scan's own first refusal (`guardBodyPath`),
 * as on every route that takes a path (GET /api/volumes' `from`).
 */
function scanRootsAsked(raw: unknown): { asked: string; root: string }[] | undefined {
  if (raw === undefined) return undefined;
  const roots = Array.isArray(raw) ? raw : [raw];
  if (roots.length > MAX_SCAN_ROOTS) throw new AppError(400, 'TOO_MANY_PATHS', `At most ${MAX_SCAN_ROOTS} folders in "scanRoot"`);
  return roots.map((r) => ({ asked: String(r), root: sanitizePath(r) })); // PathRejectedError -> the error handler's 400
}

/**
 * Whether the rules let a scan start at `root` (asked as `asked`), as POST /api/scan applies them
 * after the path rules and before it walks — the same calls in the same order: the policy (a file
 * that will not parse, `policy` here, refuses every scan), its allowedRoots where the folder lives
 * (`assertScanAllowed`), then startScan's own check of where a link root leads (`scanRootRefusal`,
 * the path rules there included). One rule, so the start screen offers no folder a scan would be
 * refused, and never judges one itself (review F3.2). Whether the folder is there and readable is
 * its own state, not a rule: a scan of it says so in its own words.
 */
async function scanRootVerdict(policy: AgentPolicy | AppError, { asked, root }: { asked: string; root: string }): Promise<ScanRootVerdict> {
  try {
    if (policy instanceof AppError) throw policy;
    assertScanAllowed(policy, root);
    const refusal = await scanRootRefusal(root);
    if (refusal) throw refusal;
    return { path: asked, allowed: true };
  } catch (err) {
    if (err instanceof AppError || err instanceof PathRejectedError) return { path: asked, allowed: false, code: err.code, error: err.message };
    throw err;
  }
}

/**
 * GET /api/policy[?scanRoot=<folder>…] — the active agent policy and where to edit it.
 * Deliberately read-only: a policy an agent could rewrite for itself would
 * be theatre. The human edits the JSON file.
 *
 * With `scanRoot` (repeatable, at most 64), it also says of each folder, in
 * the order asked, whether a scan may start there (scanRootVerdict). Without
 * it, the answer is what it always was.
 */
metaRouter.get('/policy', async (req: Request, res: Response) => {
  const file = path.join(appDataDir(), POLICY_FILE);
  const roots = scanRootsAsked(req.query.scanRoot);
  // This is the one endpoint that tells a person WHERE the policy file is, so
  // it must keep answering when that file is the thing that is broken.
  // `getPolicy` now refuses on an unparseable policy — correct for every
  // enforcement path, and exactly wrong here, where failing would hide the
  // path the user needs in order to fix it.
  let policy: AgentPolicy | AppError;
  try {
    policy = await getPolicy();
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'POLICY_UNREADABLE') throw err;
    policy = err;
  }
  const judged = roots ? { scanRoots: await Promise.all(roots.map((r) => scanRootVerdict(policy, r))) } : {};
  res.json(policy instanceof AppError
    ? { policy: null, unreadable: true, reason: policy.message, file, ...judged }
    : { policy, file, ...judged });
});

/**
 * GET /api/agent/summary?scanId= — the whole picture in one read-only call:
 * top culprits, reclaimable-by-category, and the disk-full forecast, composed
 * from the exact services the individual endpoints use. Every size comes as
 * raw bytes with a formatted string beside it, except the forecast's
 * topGrowers[].bytesPerDay, which is spread in as computed and stays raw bytes
 * only; ids are the services' stable ids; every list is deterministically
 * ordered (size desc), so two calls over the same scan return identical
 * payloads.
 */
metaRouter.get('/agent/summary', storageModeGate, async (req: Request, res: Response) => {
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
  // v4 §9.5 — the agent summary must not advertise reclaimable bytes the
  // suggestion surfaces themselves would refuse to show.
  const noted = await suppressedNoteRoots();
  // loadRuleCatalog() throws on a malformed pack, as the matcher's default did.
  // Through the memo (U-16): the same walk the suggestions route answers from.
  const { groups, matchCounts } = await cleanupSuggestionsCountedFor(store, ignore, loadRuleCatalog(), noted); // already sorted largest first
  // An advice-only group is never trashed (AGENTS.md), so it is not reclaimable: left out of the
  // total and the categories, as the page leaves it out of every total, and reported apart (hunt C14).
  const reclaimableBytes = groups.reduce((sum, g) => sum + (g.advisory ? 0 : g.totalSize), 0);
  const advisoryBytes = groups.reduce((sum, g) => sum + (g.advisory ? g.totalSize : 0), 0);
  const byCategoryMap = new Map<SuggestionCategory, { bytes: number; groupCount: number }>();
  for (const g of groups) {
    if (g.advisory) continue;
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
      advisoryBytes,
      advisoryFormatted: formatBytes(advisoryBytes),
      byCategory,
      groups: groups.slice(0, 10).map((g) => ({
        id: g.id,
        title: g.title,
        category: g.category,
        totalSize: g.totalSize,
        totalSizeFormatted: formatBytes(g.totalSize),
        itemCount: matchCounts.get(g.id) ?? g.items.length,
        ...(g.regenerateCmd !== undefined ? { regenerateCmd: g.regenerateCmd } : {}),
        ...(g.advisory ? { advisory: true, adviceCommand: g.adviceCommand } : {}),
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

/**
 * GET /api/capabilities — endpoints, safety model, and the intended workflow.
 *
 * The `platform` key is an ADDITIVE extension (§4: extend with optional fields,
 * never break). It carries a compact on/off summary of what this machine can
 * actually do, plus a pointer to the full detail — the prose reasons live at
 * /api/platform/capabilities because they are written for a person reading a
 * panel, not for an agent branching on a boolean.
 */
metaRouter.get('/capabilities', async (_req: Request, res: Response) => {
  const platformCapabilities = await getCapabilities().catch(() => null);
  const strictLane = rateLimitLanes.describe().find((l) => l.name === 'api')!;
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
    // The headline pair keeps its original meaning — the strict lane, which is
    // what everything an agent does expensively falls in. `lanes` is additive
    // (§4) and generated from the limiter itself, so the published numbers
    // cannot drift from the ones actually enforced.
    rateLimit: {
      sustainedPerSecond: strictLane.sustainedPerSecond,
      burst: strictLane.burst,
      status: 429,
      code: 'RATE_LIMITED',
      lanes: rateLimitLanes.describe(),
    },
    safety: {
      trashOnlyDeletes: 'Deletes move files to the OS Trash (recoverable until the Trash is emptied); nothing is hard-deleted',
      scannedRootRule:
        'Destructive and OS-touching endpoints only accept paths inside a root this server has actually scanned',
      pathSanitization:
        'Every user-supplied path is sanitized: traversal resolved, null bytes rejected, OS-internal directories blocked, ' +
        'and a path spelled through a second name the system gives it (macOS /.nofollow, /.resolve, /.vol; a Windows device or object-manager ' +
        'namespace other than a drive-letter or UNC path behind \\\\?\\ or \\\\.\\, this machine’s own admin shares such as \\\\localhost\\C$, ' +
        'or an NTFS stream name such as ::$INDEX_ALLOCATION) refused: 400 PATH_BLOCKED, and never inside a scanned root',
      cloudPaths: "cloud:// paths never touch the local filesystem; their deletes go to the provider's own trash",
      virtualPaths: 'Entries inside archives are listings, not files — only the archive itself can be acted on',
      offload:
        'Offload copies, verifies SHA-256, and only then trashes originals. A failure before every copy verifies rolls back and leaves local data ' +
        'untouched; after that, an original that cannot go to the Trash, or that changed since its copy was made, stays where it is beside its verified copy',
      dryRun:
        'DELETE /api/files, POST /api/offload and POST /api/offload/restore accept dryRun: true — the exact manifest, nothing acted on',
      policy:
        'agent-policy.json (see GET /api/policy) can allowlist roots, protect paths forever, and cap bytes per operation; empty file = no restriction',
      audit:
        'Every destructive request that reaches its endpoint (real, dry-run, or refused there: policy, open files, the offload plan) is appended to an audit log; ' +
        'one refused before that, by the path rules or the storage-mode gate, is not. SPILL_PATH or APP_DATA_PATH on a path the request names (path, paths, ' +
        'dest, to, destination) is a path rule and not recorded, as SAFETY_RECORD is where a delete, the cart, an offload, a relocation or an MCP tool refuses it; ' +
        'either on a copy the offload plan would make is the plan\'s refusal and is recorded (offload.start, refused); and a snapshot restore with overwrite judges ' +
        'the file it would replace inside its endpoint, so every refusal of that file, SAFETY_RECORD for a link TreeMap reaches app-data through among them, ' +
        'is recorded (snapshots.restore, refused, naming that file) — GET /api/audit reads it back',
      idempotency:
        'Destructive endpoints honor an Idempotency-Key header: a retried request replays the stored response instead of executing twice, ' +
        'and a retry sent while the first is still running waits for its answer (and runs only when the first failed)',
      appDataFolder:
        "TreeMap's own app-data folder (settings, Autopilot policies, the offload manifest, the Undo Vault) is never where a request writes, moves " +
        'or copies a file — a relocation\'s to, an offload\'s dest and its copies, a snapshot restore\'s destination, an encode: 403 APP_DATA_PATH, ' +
        'however the path is spelled; reading it and deleting in it are unchanged, but for the agent policy and the audit log (agent-policy.json, ' +
        'audit.jsonl): no request removes or moves either, nor app-data or a folder above it, nor a folder or link TreeMap reaches app-data through ' +
        '— 403 SAFETY_RECORD, dry runs too; Autopilot leaves them alone',
      spillFolder:
        "TreeMap's own spill folder in app-data (the working files of very large scans) is refused by every endpoint and MCP tool " +
        'that trashes, opens, moves or writes a path: 403 SPILL_PATH, however the path is spelled',
      storageModes:
        'A very large scan may be kept in spill or aggregate mode, where some features are off: they answer ' +
        '409 { error, code: "STORAGE_MODE", mode, feature } (an MCP tool: its error with that code). Every scan is kept in memory ' +
        'today, where nothing is off; GET /api/openapi.json names the 409 on each endpoint that can give it',
    },
    workflow: [
      'POST /api/scan with { path } → { scanId } (add ?wait=true to block until done)',
      'Poll GET /api/scan/{scanId}/stats until status is "complete" (or stream /progress via SSE)',
      'GET /api/agent/summary?scanId= for the whole picture in one call, or explore: /api/large-files, /api/large-folders, /api/cleanup/suggestions, /api/duplicates, /api/forecast',
      'Confirm intent with the user, dry-run the destructive call (dryRun: true), then act: DELETE /api/files or POST /api/offload',
      'Anything trashed is recoverable from the OS Trash until the Trash is emptied',
    ],
    mcp: {
      transport: 'stdio',
      start: 'npm run mcp',
      // The same constant buildMcpServer registers from and asserts against,
      // so this list cannot drift from the tools the MCP server actually has.
      tools: [...MCP_TOOL_NAMES],
    },
    endpoints: ENDPOINTS.map((e) => ({
      method: e.method.toUpperCase(),
      path: e.path,
      summary: e.summary,
      destructive: e.destructive,
    })),
    platform:
      platformCapabilities === null
        ? { detail: '/api/platform/capabilities', note: 'Capability detection is unavailable on this system' }
        : {
            name: platformCapabilities.platform,
            available: capabilitySummary(platformCapabilities),
            detail: '/api/platform/capabilities',
            note: 'Each capability is detected at runtime; the detail endpoint carries a human-readable reason whenever one is unavailable',
          },
  });
});
