import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  startScan,
  getScan,
  collectLargestFiles,
  collectLargestFolders,
  compareTrees,
} from '../services/diskScanner';
import { getDuplicateJob } from '../services/duplicateFinder';
import { collectCleanupSuggestions } from '../services/cleanupRules';
import { getIgnoreMatchers } from '../services/settings';
import { getForecast } from '../services/forecast';
import { prepareOffload, startOffload, getOffloadJob } from '../services/offload';
import { moveToTrash } from '../services/cleaner';
import { storeOf } from '../services/scanStore';
import { insideAnyScanRoot } from '../middleware/pathGuard';
import { isVirtualPath } from '../services/containerScanner';
import { sanitizePath, PathRejectedError } from '../utils/pathSanitizer';
import { AppError } from '../middleware/errorHandler';
import { formatBytes } from '../utils/formatBytes';
import { getPolicy, assertScanAllowed, assertPathsAllowed, assertBytesCap, knownSizeOf } from '../services/policy';
import { appendAudit, tokenIdFor } from '../services/audit';
import { OffloadJob, ScanResult } from '../models/types';

/**
 * TreeMap MCP server — the agent-facing face of the disk visualizer.
 *
 * Every tool is a thin wrapper over the exact service functions the HTTP
 * routes call (diskScanner, duplicateFinder, cleanupRules, forecast, offload,
 * cleaner). No tool computes an answer its route counterpart doesn't; if the
 * two ever disagree, that is a bug.
 *
 * Safety model (identical to the HTTP API):
 *  - every user-supplied path goes through sanitizePath;
 *  - destructive tools demand the path lie inside a root this process has
 *    actually scanned (the requireInsideScanRoot rule), never a cloud:// or
 *    in-archive virtual path;
 *  - deletes go to the system Trash via moveToTrash — nothing hard-deletes;
 *  - offload copies, verifies hashes, and only then trashes originals;
 *  - dryRun on destructive tools reports the exact manifest without acting.
 */

// The MCP server's reported version always matches the app's. Resolved at
// runtime so the compiled dist/mcp build reads the same repo-root file.
const { version: APP_VERSION } = require('../../package.json') as { version: string };

const POLL_MS = 250;
const DEFAULT_WAIT_MS = 55_000;
const MAX_WAIT_MS = 600_000;
/** Same batch cap as guardBodyPaths on the HTTP API. */
const MAX_PATHS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------- result shaping ------------------------- */

interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function ok(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function fail(message: string, code: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: `Error (${code}): ${message}` }] };
}

/** Map thrown errors to the same codes the HTTP errorHandler would use. */
async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) return fail(err.message, err.code);
    if (err instanceof PathRejectedError) return fail(err.message, err.code);
    if (err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string') {
      switch ((err as NodeJS.ErrnoException).code) {
        case 'ENOENT':
          return fail('Path does not exist', 'PATH_NOT_FOUND');
        case 'EACCES':
        case 'EPERM':
          return fail('Permission denied', 'PERMISSION_DENIED');
        case 'ENOTDIR':
          return fail('Path is not a directory', 'NOT_A_DIRECTORY');
      }
    }
    return fail(err instanceof Error ? err.message : String(err), 'INTERNAL');
  }
}

/* ------------------------- shared guards ------------------------- */

function requireScanMcp(scanId: string): ScanResult {
  const scan = getScan(scanId);
  if (!scan) {
    throw new AppError(404, 'SCAN_NOT_FOUND', 'Unknown or expired scanId — run scan_path first');
  }
  return scan;
}

function requireCompleteScanMcp(scanId: string): ScanResult {
  const scan = requireScanMcp(scanId);
  if (scan.status === 'running') {
    throw new AppError(409, 'SCAN_RUNNING', 'Scan is still running — call scan_path with this scanId to wait for it');
  }
  if (scan.status === 'error' || (!scan.store && !scan.root)) {
    throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  }
  return scan;
}

/**
 * The requireInsideScanRoot rule, applied to tool input: sanitize every path,
 * then reject anything cloud-hosted, outside every scanned root, or virtual
 * (inside an archive). Same codes and messages as the HTTP middleware.
 */
function guardDestructivePaths(raw: string[]): string[] {
  if (raw.length === 0) {
    throw new AppError(400, 'PATHS_REQUIRED', 'Provide a non-empty "paths" array');
  }
  if (raw.length > MAX_PATHS) {
    throw new AppError(400, 'TOO_MANY_PATHS', 'At most 500 paths per request');
  }
  const paths = raw.map((p) => sanitizePath(p));
  for (const p of paths) {
    if (p.startsWith('cloud://')) {
      throw new AppError(403, 'CLOUD_PATH', `"${p}" lives in a cloud account — use the provider's trash instead`);
    }
    if (!insideAnyScanRoot(p)) {
      throw new AppError(403, 'OUTSIDE_SCAN_ROOT', `"${p}" is outside every scanned root — scan its folder first`);
    }
    if (isVirtualPath(p)) {
      throw new AppError(403, 'VIRTUAL_PATH', `"${p}" is inside an archive — act on the archive itself instead`);
    }
  }
  return paths;
}

/* ------------------------- summaries ------------------------- */

function scanSummary(scan: ScanResult): Record<string, unknown> {
  const store = storeOf(scan);
  const totalBytes = store.size(store.rootId);
  const topEntries = store
    .childIds(store.rootId)
    .map((id) => ({
      name: store.name(id),
      path: store.path(id),
      type: store.nodeType(id),
      size: store.size(id),
    }))
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))
    .slice(0, 10)
    .map((e) => ({ ...e, sizeFormatted: formatBytes(e.size) }));
  return {
    scanId: scan.scanId,
    rootPath: scan.rootPath,
    status: scan.status,
    totalBytes,
    totalFormatted: formatBytes(totalBytes),
    fileCount: scan.fileCount,
    dirCount: scan.dirCount,
    engine: scan.engine ?? 'walker',
    durationMs: (scan.finishedAt ?? scan.startedAt) - scan.startedAt,
    incremental: scan.incremental === true,
    topEntries,
  };
}

function runningScanPayload(scan: ScanResult): Record<string, unknown> {
  return {
    scanId: scan.scanId,
    rootPath: scan.rootPath,
    status: 'running',
    scanned: scan.scanned,
    currentPath: scan.currentPath,
    hint: 'Call scan_path again with this scanId to keep waiting for the result.',
  };
}

function offloadJobPayload(job: OffloadJob): Record<string, unknown> {
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    phase: job.phase,
    destRoot: job.destRoot,
    filesDone: job.filesDone,
    fileCount: job.fileCount,
    bytesDone: Math.min(job.bytesDone, job.bytesTotal),
    bytesTotal: job.bytesTotal,
    bytesTotalFormatted: formatBytes(job.bytesTotal),
    ...(job.error !== undefined ? { error: job.error } : {}),
    ...(job.status === 'running'
      ? { hint: 'Call offload again with this jobId to keep waiting for it.' }
      : {}),
  };
}

const waitMsSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_MS)
  .default(DEFAULT_WAIT_MS)
  .describe('How long to wait (ms) before returning a still-running status you can poll again');

/* ------------------------- the server ------------------------- */

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'treemap-mcp-server', version: APP_VERSION },
    {
      instructions:
        'TreeMap disk-space tools. Workflow: scan_path first (returns a scanId), then ' +
        'get_largest / cleanup_suggestions / find_duplicates against that scanId, then — only when the ' +
        'user has confirmed — trash_paths or offload, ideally after a dryRun:true pass. ' +
        'Deletes always go to the OS Trash (recoverable); nothing outside a scanned root can be touched.',
    },
  );

  server.registerTool(
    'scan_path',
    {
      title: 'Scan a folder',
      description:
        'Scan a directory tree and return its size breakdown. Give "path" to start a new scan, or "scanId" ' +
        'to keep waiting on / re-read a previous one. Waits up to waitMs; if the scan is still running you get ' +
        '{ status: "running", scanId } — call scan_path again with that scanId. On completion returns total size ' +
        '(raw bytes + formatted), file/dir counts, and the ten largest top-level entries. The scanId is the key ' +
        'every other tool needs.',
      inputSchema: {
        path: z.string().min(1).optional().describe('Absolute directory path to scan (also accepts ~/)'),
        scanId: z.string().min(1).optional().describe('Existing scan to wait on / re-read instead of starting a new one'),
        incremental: z
          .boolean()
          .default(false)
          .describe('Reuse the on-disk mtime cache for a fast rescan (may miss in-place file edits)'),
        waitMs: waitMsSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ path: rawPath, scanId, incremental, waitMs }) =>
      run(async () => {
        let scan: ScanResult;
        if (scanId !== undefined) {
          scan = requireScanMcp(scanId);
        } else if (rawPath !== undefined) {
          const target = sanitizePath(rawPath);
          assertScanAllowed(await getPolicy(), target); // agent-policy.json allowedRoots
          scan = await startScan(target, { incremental });
        } else {
          throw new AppError(400, 'PATH_REQUIRED', 'Provide "path" to start a scan or "scanId" to check one');
        }
        const deadline = Date.now() + waitMs;
        while (scan.status === 'running' && Date.now() < deadline) {
          await sleep(POLL_MS);
        }
        if (scan.status === 'running') return ok(runningScanPayload(scan));
        if (scan.status === 'error' || (!scan.store && !scan.root)) {
          throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
        }
        return ok(scanSummary(scan));
      }),
  );

  server.registerTool(
    'get_largest',
    {
      title: 'Largest files or folders',
      description:
        'The biggest files or folders in a completed scan, largest first, each with raw bytes and a formatted ' +
        'size. Folders report their recursive size and file count.',
      inputSchema: {
        scanId: z.string().min(1).describe('A completed scan from scan_path'),
        kind: z.enum(['files', 'folders']).default('files').describe('Rank files or folders'),
        limit: z.number().int().min(1).max(500).default(25).describe('How many entries to return'),
        minSizeBytes: z.number().int().min(0).default(1_048_576).describe('Ignore entries smaller than this'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ scanId, kind, limit, minSizeBytes }) =>
      run(async () => {
        const scan = requireCompleteScanMcp(scanId);
        const store = storeOf(scan);
        if (kind === 'folders') {
          const folders = collectLargestFolders(store, limit, minSizeBytes).map((f) => ({
            ...f,
            sizeFormatted: formatBytes(f.size),
          }));
          return ok({ scanId, kind, count: folders.length, folders });
        }
        const files = collectLargestFiles(store, limit, minSizeBytes).map((f) => ({
          ...f,
          sizeFormatted: formatBytes(f.size),
        }));
        return ok({ scanId, kind, count: files.length, files });
      }),
  );

  server.registerTool(
    'find_duplicates',
    {
      title: 'Find duplicate files',
      description:
        'Content-identical duplicate groups in a completed scan (size bucket → partial hash → full SHA-256). ' +
        'Hashing runs in the background: if it is still working after waitMs you get { status: "running", ' +
        'hashed, toHash } — call find_duplicates again with the same arguments to keep polling. Groups come ' +
        'back largest-reclaimable first.',
      inputSchema: {
        scanId: z.string().min(1).describe('A completed scan from scan_path'),
        minSizeBytes: z.number().int().min(1).default(1024).describe('Ignore files smaller than this'),
        limit: z.number().int().min(1).max(500).default(25).describe('Maximum duplicate groups to return'),
        filesPerGroup: z.number().int().min(1).max(100).default(10).describe('Maximum file paths listed per group'),
        waitMs: waitMsSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ scanId, minSizeBytes, limit, filesPerGroup, waitMs }) =>
      run(async () => {
        const scan = requireCompleteScanMcp(scanId);
        const job = getDuplicateJob(scan, minSizeBytes);
        const deadline = Date.now() + waitMs;
        while (job.status === 'running' && Date.now() < deadline) {
          await sleep(POLL_MS);
        }
        if (job.status === 'running') {
          return ok({
            scanId,
            status: 'running',
            hashed: job.hashed,
            toHash: job.toHash,
            hint: 'Call find_duplicates again with the same arguments to keep polling.',
          });
        }
        if (job.status === 'error') {
          throw new AppError(500, 'DUPLICATES_FAILED', job.error ?? 'Duplicate detection failed');
        }
        const groups = (job.groups ?? []).slice(0, limit).map((g) => ({
          hash: g.hash,
          size: g.size,
          sizeFormatted: formatBytes(g.size),
          count: g.count,
          reclaimable: g.reclaimable,
          reclaimableFormatted: formatBytes(g.reclaimable),
          files: g.files.slice(0, filesPerGroup),
          filesTruncated: g.files.length > filesPerGroup,
        }));
        return ok({
          scanId,
          status: 'complete',
          minSizeBytes,
          groupCount: job.groupCount ?? 0,
          totalReclaimable: job.totalReclaimable ?? 0,
          totalReclaimableFormatted: formatBytes(job.totalReclaimable ?? 0),
          groups,
        });
      }),
  );

  server.registerTool(
    'cleanup_suggestions',
    {
      title: 'Smart cleanup suggestions',
      description:
        'Well-known reclaimable space in a completed scan, grouped by rule: regenerable build dirs ' +
        '(node_modules, target, …, each with the command that rebuilds it), tool/browser caches, and OS junk. ' +
        'Groups come back largest first with exact byte totals. Suggested paths can be passed straight to ' +
        'trash_paths (they are always inside the scanned root).',
      inputSchema: {
        scanId: z.string().min(1).describe('A completed scan from scan_path'),
        itemsPerGroup: z.number().int().min(1).max(200).default(20).describe('Maximum items listed per group'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ scanId, itemsPerGroup }) =>
      run(async () => {
        const scan = requireCompleteScanMcp(scanId);
        const ignore = await getIgnoreMatchers('suggest');
        const groups = collectCleanupSuggestions(storeOf(scan), ignore);
        const totalBytes = groups.reduce((sum, g) => sum + g.totalSize, 0);
        return ok({
          scanId,
          totalBytes,
          totalFormatted: formatBytes(totalBytes),
          groups: groups.map((g) => ({
            id: g.id,
            title: g.title,
            description: g.description,
            category: g.category,
            totalSize: g.totalSize,
            totalSizeFormatted: formatBytes(g.totalSize),
            ...(g.regenerateCmd !== undefined ? { regenerateCmd: g.regenerateCmd } : {}),
            itemCount: g.items.length,
            items: g.items.slice(0, itemsPerGroup).map((i) => ({ ...i, sizeFormatted: formatBytes(i.size) })),
            itemsTruncated: g.items.length > itemsPerGroup,
          })),
        });
      }),
  );

  server.registerTool(
    'forecast',
    {
      title: 'Disk-full forecast',
      description:
        'When will the volume holding this folder fill up? Fitted from the folder\'s scan-snapshot history. ' +
        'Honest by design: status is "ok" with fullInDays only when the projection is trustworthy; otherwise ' +
        '"insufficient" / "stable" / "shrinking" / "erratic" with a reason. Scan the folder a few times over ' +
        'several days to build history.',
      inputSchema: {
        path: z.string().min(1).describe('A folder that has been scanned before (its snapshot history is used)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path: rawPath }) =>
      run(async () => {
        const result = await getForecast(sanitizePath(rawPath));
        return ok({
          ...result,
          bytesPerDayFormatted: formatBytes(Math.abs(result.bytesPerDay)),
          freeFormatted: formatBytes(result.freeBytes),
        });
      }),
  );

  server.registerTool(
    'compare_scans',
    {
      title: 'Compare two scans',
      description:
        'Structural diff between two completed scans of the same root path: what appeared, vanished, grew or ' +
        'shrank, biggest absolute change first. Subtrees present in only one scan collapse to a single entry. ' +
        'Run scan_path on the same folder at two different times to get the two scanIds.',
      inputSchema: {
        scanIdA: z.string().min(1).describe('The earlier scan'),
        scanIdB: z.string().min(1).describe('The later scan'),
        limit: z.number().int().min(1).max(1000).default(100).describe('Maximum change entries to return'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ scanIdA, scanIdB, limit }) =>
      run(async () => {
        const scanA = requireCompleteScanMcp(scanIdA);
        const scanB = requireCompleteScanMcp(scanIdB);
        if (scanA.rootPath !== scanB.rootPath) {
          throw new AppError(400, 'ROOT_MISMATCH', 'Both scans must cover the same root path');
        }
        const storeA = storeOf(scanA);
        const storeB = storeOf(scanB);
        const { entries, truncated } = compareTrees(storeA, storeB);
        const totalDelta = storeB.size(storeB.rootId) - storeA.size(storeA.rootId);
        return ok({
          scanIdA,
          scanIdB,
          rootPath: scanA.rootPath,
          totalDelta,
          totalDeltaFormatted: `${totalDelta < 0 ? '-' : '+'}${formatBytes(Math.abs(totalDelta))}`,
          entries: entries.slice(0, limit).map((e) => ({
            ...e,
            deltaFormatted: `${e.delta < 0 ? '-' : '+'}${formatBytes(Math.abs(e.delta))}`,
          })),
          truncated: truncated || entries.length > limit,
        });
      }),
  );

  server.registerTool(
    'offload',
    {
      title: 'Offload files to another drive',
      description:
        'Move files/folders to a destination the safe way: copy → verify SHA-256 → only then move the local ' +
        'originals to the OS Trash. Any failure rolls back and leaves local data untouched. DESTRUCTIVE unless ' +
        'dryRun: true, which returns the exact copy plan (files, bytes, destinations) without touching anything ' +
        '— always dry-run first. Sources must live inside a completed scan; pass jobId instead to keep waiting ' +
        'on a started job.',
      inputSchema: {
        scanId: z.string().min(1).optional().describe('The completed scan the source paths belong to'),
        paths: z.array(z.string().min(1)).max(MAX_PATHS).optional().describe('Files/folders to offload (inside the scanned root)'),
        dest: z.string().min(1).optional().describe('Existing destination folder (e.g. an external drive)'),
        dryRun: z.boolean().default(false).describe('true = report the exact plan, act on nothing'),
        jobId: z.string().min(1).optional().describe('A running offload job to keep waiting on instead of starting one'),
        waitMs: waitMsSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ scanId, paths: rawPaths, dest: rawDest, dryRun, jobId, waitMs }) =>
      run(async () => {
        if (jobId !== undefined) {
          const existing = getOffloadJob(jobId);
          if (!existing) throw new AppError(404, 'JOB_NOT_FOUND', 'Unknown or expired job id');
          const deadline = Date.now() + waitMs;
          while (existing.status === 'running' && Date.now() < deadline) {
            await sleep(POLL_MS);
          }
          return ok(offloadJobPayload(existing));
        }
        if (scanId === undefined || rawPaths === undefined || rawDest === undefined) {
          throw new AppError(400, 'ARGS_REQUIRED', 'Provide scanId, paths and dest (or jobId to poll a job)');
        }
        const scan = requireCompleteScanMcp(scanId);
        const paths = guardDestructivePaths(rawPaths);
        const dest = sanitizePath(rawDest);
        const policy = await getPolicy();
        const prepared = await (async () => {
          try {
            assertPathsAllowed(policy, paths); // originals get trashed after verify
            const plan = await prepareOffload(scan, paths, dest);
            assertBytesCap(policy, plan.bytesTotal);
            return plan;
          } catch (err) {
            if (err instanceof AppError) {
              await appendAudit({ action: 'offload.start', source: 'mcp', tokenId: tokenIdFor('mcp'), paths, bytes: null, dryRun, outcome: 'refused', code: err.code });
            }
            throw err;
          }
        })();
        await appendAudit({ action: 'offload.start', source: 'mcp', tokenId: tokenIdFor('mcp'), paths, bytes: prepared.bytesTotal, dryRun, outcome: 'ok' });
        if (dryRun) {
          return ok({
            dryRun: true,
            fileCount: prepared.plan.length,
            bytesTotal: prepared.bytesTotal,
            bytesTotalFormatted: formatBytes(prepared.bytesTotal),
            wouldTrashAfterVerify: paths,
            copies: prepared.plan.slice(0, 100).map((c) => ({ src: c.src, dest: c.dest, size: c.size })),
            copiesTruncated: prepared.plan.length > 100,
            note: 'Dry run — nothing was copied, verified or trashed.',
          });
        }
        const job = await startOffload(scan, paths, dest, prepared);
        const deadline = Date.now() + waitMs;
        while (job.status === 'running' && Date.now() < deadline) {
          await sleep(POLL_MS);
        }
        return ok(offloadJobPayload(job));
      }),
  );

  server.registerTool(
    'trash_paths',
    {
      title: 'Move paths to the Trash',
      description:
        'Move files/folders to the system Trash / Recycle Bin (recoverable — never a hard delete). DESTRUCTIVE ' +
        'unless dryRun: true, which reports what would be trashed and the bytes that would be reclaimed without ' +
        'touching anything — dry-run first, and only act once the user has confirmed. Every path must lie inside ' +
        'a folder this server has scanned (run scan_path first); cloud and in-archive paths are refused.',
      inputSchema: {
        paths: z.array(z.string().min(1)).min(1).max(MAX_PATHS).describe('Files/folders to trash (inside a scanned root)'),
        dryRun: z.boolean().default(false).describe('true = report the manifest, act on nothing'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ paths: rawPaths, dryRun }) =>
      run(async () => {
        const paths = guardDestructivePaths(rawPaths);
        const sized = paths.map((p) => {
          const bytes = knownSizeOf(p);
          return { path: p, bytes, bytesFormatted: bytes === null ? 'unknown' : formatBytes(bytes) };
        });
        const knownTotal = sized.reduce((sum, s) => sum + (s.bytes ?? 0), 0);
        const policy = await getPolicy();
        try {
          assertPathsAllowed(policy, paths);
          assertBytesCap(policy, knownTotal);
        } catch (err) {
          if (err instanceof AppError) {
            await appendAudit({ action: 'files.trash', source: 'mcp', tokenId: tokenIdFor('mcp'), paths, bytes: knownTotal, dryRun, outcome: 'refused', code: err.code });
          }
          throw err;
        }
        if (dryRun) {
          await appendAudit({ action: 'files.trash', source: 'mcp', tokenId: tokenIdFor('mcp'), paths, bytes: knownTotal, dryRun: true, outcome: 'ok' });
          return ok({
            dryRun: true,
            wouldTrash: sized,
            totalKnownBytes: knownTotal,
            totalKnownFormatted: formatBytes(knownTotal),
            note: 'Dry run — nothing was moved to the Trash.',
          });
        }
        const result = await moveToTrash(paths);
        await appendAudit({ action: 'files.trash', source: 'mcp', tokenId: tokenIdFor('mcp'), paths, bytes: knownTotal, dryRun: false, outcome: result.failed.length === 0 ? 'ok' : 'error', ...(result.failed.length > 0 ? { code: 'PARTIAL_FAILURE' } : {}) });
        const freed = sized
          .filter((s) => result.deleted.includes(s.path))
          .reduce((sum, s) => sum + (s.bytes ?? 0), 0);
        return ok({
          deleted: result.deleted,
          failed: result.failed,
          reclaimedBytes: freed,
          reclaimedFormatted: formatBytes(freed),
          note: 'Items were moved to the OS Trash and can be restored from there.',
        });
      }),
  );

  return server;
}
