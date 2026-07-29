/**
 * openapi.ts — the machine-readable description of the HTTP API.
 *
 * One rule governs this file: it may never describe a field the code does not
 * actually return. Every schema below is transcribed from src/models/types.ts
 * or from the literal res.json() shapes in the route files; where a payload's
 * shape is dynamic or provider-specific, the schema stays a plain object with
 * a description instead of inventing properties. When a route changes, this
 * file changes in the same commit — the contract test in
 * tests/discoverability.test.ts holds sampled endpoints to it.
 */

// Resolved at runtime so the served spec always reports the app's version.
const { version: APP_VERSION } = require('../../package.json') as { version: string };

type Json = Record<string, unknown>;

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });

const str = (description?: string): Json => ({ type: 'string', ...(description ? { description } : {}) });
const num = (description?: string): Json => ({ type: 'number', ...(description ? { description } : {}) });
const int = (description?: string): Json => ({ type: 'integer', ...(description ? { description } : {}) });
const bool = (description?: string): Json => ({ type: 'boolean', ...(description ? { description } : {}) });
const arr = (items: Json, description?: string): Json => ({ type: 'array', items, ...(description ? { description } : {}) });
const obj = (properties: Json, required?: string[], description?: string): Json => ({
  type: 'object',
  ...(description ? { description } : {}),
  properties,
  ...(required && required.length ? { required } : {}),
});
/** A payload whose exact shape is dynamic — described, never invented. */
const opaque = (description: string): Json => ({ type: 'object', description });
const nullable = (schema: Json): Json => ({ ...schema, nullable: true });

/* ------------------------------ parameters ------------------------------ */

const pathParam = (name: string, description: string): Json => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string' },
});

const queryParam = (name: string, description: string, schema: Json = { type: 'string' }, required = false): Json => ({
  name,
  in: 'query',
  required,
  description,
  schema,
});

/** Destructive endpoints honor this header: retries replay, never re-execute. */
const idempotencyHeader: Json = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description:
    'Optional. A repeat of a successful request with the same key (within ~10 minutes) replays the stored response instead of executing again; the replay carries an Idempotency-Replayed: true header.',
  schema: { type: 'string' },
};

const scanIdQuery = queryParam('scanId', 'Id of a completed scan (from POST /api/scan)', { type: 'string' }, true);

/* ------------------------------ responses ------------------------------ */

const jsonResponse = (description: string, schema: Json): Json => ({
  description,
  content: { 'application/json': { schema } },
});

const errorResponse = (description: string): Json => jsonResponse(description, ref('ApiError'));

const sseResponse = (description: string): Json => ({
  description,
  content: { 'text/event-stream': { schema: str('One JSON frame per "data:" line') } },
});

const running202 = jsonResponse(
  'Scan still running — retry when it completes',
  obj({ status: str("Always 'running'"), scanned: int(), currentPath: str() }, ['status']),
);

/* ------------------------------- schemas ------------------------------- */

const schemas: Json = {
  ApiError: obj(
    { error: str('Human-readable message'), code: str('Stable machine-readable code, e.g. OUTSIDE_SCAN_ROOT') },
    ['error', 'code'],
    'Uniform error body returned by every endpoint',
  ),
  FileNode: obj(
    {
      name: str('Basename'),
      path: str('Absolute path'),
      size: int('Bytes; recursive total for directories'),
      type: { type: 'string', enum: ['file', 'dir'] },
      children: arr({ $ref: '#/components/schemas/FileNode' }, 'Directories only; absent when pruned'),
      pruned: bool('Children exist but were withheld — fetch the subtree endpoint to drill in'),
      extension: str('Lower-cased extension without the dot; files only'),
      modifiedAt: int('Unix epoch ms'),
      accessedAt: int('Unix epoch ms of last access; best-effort, often absent'),
      isHidden: bool(),
      hardlinkDuplicate: bool('Inode already counted elsewhere; size reported as 0'),
      isSymlink: bool(),
      cloudPlaceholder: bool('Online-only stub occupying ~no disk blocks'),
      cloudProvider: { type: 'string', enum: ['icloud', 'onedrive', 'dropbox'] },
      gitRepo: bool('Directory directly containing a .git directory'),
      container: ref('ContainerKind'),
      cloudId: str('Provider file id (cloud scans only)'),
      virtual: bool('Lives inside a container — listed, not on disk'),
      logicalSize: int('Uncompressed size for scaled archive entries'),
    },
    ['name', 'path', 'size', 'type', 'modifiedAt', 'isHidden'],
    'A file or directory in a scanned tree (src/models/types.ts)',
  ),
  ContainerKind: { type: 'string', enum: ['zip', 'tar', 'tgz', 'iso', 'dmg', 'photos', 'docker'] },
  ScanStats: obj(
    {
      scanned: int('Total entries seen'),
      fileCount: int(),
      dirCount: int(),
      engine: str('Enumeration engine, e.g. walker / turbo-walker / gdu-turbo / cloud'),
      ioThreads: int(),
      durationMs: int(),
      incremental: bool(),
      cachedDirs: int(),
      walkedDirs: int(),
      hardlinkedFiles: int(),
      hardlinkedBytes: int(),
      cloudFiles: int(),
      cloudBytes: int(),
    },
    ['scanned', 'fileCount', 'dirCount', 'engine', 'ioThreads', 'durationMs', 'incremental', 'cachedDirs', 'walkedDirs', 'hardlinkedFiles', 'hardlinkedBytes', 'cloudFiles', 'cloudBytes'],
  ),
  TreemapNode: obj(
    {
      name: str(),
      path: str(),
      size: int(),
      type: { type: 'string', enum: ['file', 'dir'] },
      extension: str(),
      modifiedAt: int(),
      depth: int(),
      expanded: bool("Whether this dir's children were also emitted"),
      x: num('Percent 0–100'),
      y: num('Percent 0–100'),
      w: num('Percent 0–100'),
      h: num('Percent 0–100'),
      cloudPlaceholder: bool(),
      gitRepo: bool(),
      container: ref('ContainerKind'),
      virtual: bool(),
      logicalSize: int(),
      prevSize: nullable(int('Historical layouts only: size in the previous snapshot; null = did not exist')),
    },
    ['name', 'path', 'size', 'type', 'modifiedAt', 'depth', 'expanded', 'x', 'y', 'w', 'h'],
  ),
  SystemInfo: obj(
    {
      platform: str("Node platform, e.g. 'darwin'"),
      hostname: str(),
      totalDisk: int('Bytes'),
      freeDisk: int('Bytes'),
      homeDir: str(),
      commonDirs: arr(str()),
    },
    ['platform', 'hostname', 'totalDisk', 'freeDisk', 'homeDir', 'commonDirs'],
  ),
  LargeFile: obj(
    { name: str(), path: str(), size: int(), extension: str(), modifiedAt: int() },
    ['name', 'path', 'size', 'modifiedAt'],
  ),
  LargeFolder: obj(
    { name: str(), path: str(), size: int('Recursive bytes'), fileCount: int('Recursive file count'), modifiedAt: int() },
    ['name', 'path', 'size', 'fileCount', 'modifiedAt'],
  ),
  FileTypeStat: obj({ ext: str(), count: int(), totalSize: int() }, ['ext', 'count', 'totalSize']),
  DuplicateGroup: obj(
    {
      hash: str('Full SHA-256 of the content (hex)'),
      size: int('Bytes of one copy'),
      count: int(),
      reclaimable: int('size × (count − 1)'),
      files: arr(obj({ name: str(), path: str(), modifiedAt: int() }, ['name', 'path', 'modifiedAt']), 'Newest first'),
    },
    ['hash', 'size', 'count', 'reclaimable', 'files'],
  ),
  EmptyFoldersResult: obj(
    {
      folders: arr(obj({ name: str(), path: str() }, ['name', 'path']), 'Topmost recursively-empty dirs'),
      totalCount: int('All empty dirs found, nested included'),
      truncated: bool(),
    },
    ['folders', 'totalCount', 'truncated'],
  ),
  CompareEntry: obj(
    {
      path: str(),
      name: str(),
      type: { type: 'string', enum: ['file', 'dir'] },
      sizeA: nullable(int('null = did not exist in scan A')),
      sizeB: nullable(int('null = did not exist in scan B')),
      delta: int(),
      change: { type: 'string', enum: ['added', 'removed', 'grew', 'shrank'] },
    },
    ['path', 'name', 'type', 'sizeA', 'sizeB', 'delta', 'change'],
  ),
  CompareResult: obj(
    {
      scanIdA: str(),
      scanIdB: str(),
      rootPath: str(),
      totalDelta: int(),
      entries: arr(ref('CompareEntry'), 'Biggest absolute change first, capped at 1000'),
      truncated: bool(),
    },
    ['scanIdA', 'scanIdB', 'rootPath', 'totalDelta', 'entries', 'truncated'],
  ),
  ForecastGrower: obj({ name: str(), path: str(), bytesPerDay: int() }, ['name', 'path', 'bytesPerDay']),
  ForecastResult: obj(
    {
      path: str(),
      status: { type: 'string', enum: ['ok', 'insufficient', 'stable', 'shrinking', 'erratic'], description: "Honest by design — 'ok' only when the projection is trustworthy" },
      fullInDays: num("Days until the volume is full — present only when status is 'ok'"),
      confidence: num('0–1'),
      bytesPerDay: int(),
      freeBytes: int(),
      snapshotCount: int(),
      spanDays: num(),
      topGrowers: arr(ref('ForecastGrower')),
      reason: str("Explanation when status is not 'ok'"),
    },
    ['path', 'status', 'confidence', 'bytesPerDay', 'freeBytes', 'snapshotCount', 'spanDays', 'topGrowers'],
  ),
  CleanupSuggestionItem: obj(
    { name: str(), path: str(), size: int(), type: { type: 'string', enum: ['file', 'dir'] }, modifiedAt: int() },
    ['name', 'path', 'size', 'type', 'modifiedAt'],
  ),
  CleanupSuggestionGroup: obj(
    {
      id: str("Stable rule id, e.g. 'regen-node-modules'"),
      title: str(),
      description: str(),
      items: arr(ref('CleanupSuggestionItem'), 'Largest first, capped at 200 per rule'),
      totalSize: int('Exact total across all matches'),
      category: { type: 'string', enum: ['regenerable', 'cache', 'junk'] },
      regenerateCmd: str('Command that recreates the contents (regenerable groups only)'),
      confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How sure the rule pack is that this is safe to reclaim' },
      why: str('Plain-English description of what the rule matched'),
      advisory: bool('True when this space must NOT be reclaimed by trashing it'),
      adviceCommand: str('For advisory groups: the supported way to reclaim the space'),
    },
    ['id', 'title', 'description', 'items', 'totalSize', 'category'],
  ),
  CleanResult: obj(
    {
      deleted: arr(str(), 'Paths moved to the system Trash'),
      failed: arr(obj({ path: str(), reason: str() }, ['path', 'reason'])),
    },
    ['deleted', 'failed'],
    'Every delete is a move to the OS Trash — recoverable, never a hard delete',
  ),
  OpenHandleConflict: obj(
    {
      path: str('The path from the request that is blocked'),
      pid: int(),
      processName: str('e.g. "Google Chrome"'),
      openPath: str('The file actually held open, when it sits inside `path`'),
    },
    ['path', 'pid', 'processName'],
  ),
  OpenHandleReport: obj(
    {
      conflicts: arr(ref('OpenHandleConflict')),
      checked: bool('false = the check could not run; `reason` says why, and no conclusion may be drawn'),
      complete: bool('false = the check ran but could not cover the whole set'),
      reason: str('How the answer was obtained, or why it could not be'),
      elapsedMs: int(),
    },
    ['conflicts', 'checked', 'complete', 'elapsedMs'],
    'An empty `conflicts` with `checked: false` means "unknown", never "nothing is open"',
  ),
  BudgetStatus: obj(
    { path: str(), name: str(), maxBytes: int(), actualBytes: int(), overBy: int('Positive means over budget') },
    ['path', 'name', 'maxBytes', 'actualBytes', 'overBy'],
  ),
  OffloadEntry: obj(
    {
      id: str(),
      name: str(),
      originalPath: str(),
      destPath: str(),
      destRoot: str(),
      size: int(),
      hash: str('Full SHA-256, verified on offload and restore'),
      offloadedAt: int(),
      restoredAt: int('Present once copied back and re-verified'),
    },
    ['id', 'name', 'originalPath', 'destPath', 'destRoot', 'size', 'hash', 'offloadedAt'],
  ),
  OffloadIndex: obj(
    {
      destinations: arr(
        obj(
          { root: str(), mounted: bool(), lastSeenAt: int(), totalBytes: int(), activeCount: int(), restoredCount: int() },
          ['root', 'mounted', 'lastSeenAt', 'totalBytes', 'activeCount', 'restoredCount'],
        ),
      ),
      entries: arr(ref('OffloadEntry'), 'Newest first'),
    },
    ['destinations', 'entries'],
  ),
  TimeCapsuleEntry: obj(
    {
      id: str(),
      name: str('Basename'),
      originalPath: str('Where it will be put back'),
      kind: { type: 'string', enum: ['file', 'folder'] },
      sizeBytes: int('Size when captured; never changes'),
      heldBytes: int('Bytes held right now — 0 once restored or evicted'),
      hasPayload: bool('Whether a copy is still there to give back. Distinct from heldBytes: an empty folder and a zero-byte file hold nothing and still restore'),
      fileCount: int(),
      digest: str('SHA-256 over the capture manifest'),
      capturedAt: int('Unix epoch ms'),
      runId: str('Groups everything one automated run protected'),
      policyId: str('Autopilot policy that selected it'),
      reason: str('Why it was deleted, in the rule’s own words'),
      restoredAt: int('Present once copied back and re-verified'),
    },
    ['id', 'name', 'originalPath', 'kind', 'sizeBytes', 'heldBytes', 'hasPayload', 'fileCount', 'digest', 'capturedAt'],
  ),
  TimeCapsuleEvent: obj(
    {
      at: int('Unix epoch ms'),
      kind: { type: 'string', enum: ['evicted', 'expired', 'unprotected', 'lost'] },
      name: str(),
      originalPath: str(),
      sizeBytes: int(),
      detail: str('Plain-language explanation, written for display'),
    },
    ['at', 'kind', 'name', 'originalPath', 'sizeBytes', 'detail'],
    'Protection withheld or withdrawn is never silent — each is recorded here',
  ),
  TimeCapsuleIndex: obj(
    {
      status: obj(
        {
          usedBytes: int(),
          capBytes: int('Ceiling: a percentage of the volume’s usable space'),
          freeBytes: nullable(int('Free space on the capsule’s volume; null when unreadable')),
          retentionDays: int(),
          maxPercent: int(),
          entryCount: int(),
          restorableCount: int('Entries still holding a payload'),
          available: bool('False when the capsule cannot be used at all'),
          reason: str('Why it is unavailable or limited'),
        },
        ['usedBytes', 'capBytes', 'freeBytes', 'retentionDays', 'maxPercent', 'entryCount', 'restorableCount', 'available'],
      ),
      entries: arr(ref('TimeCapsuleEntry'), 'Newest first'),
      events: arr(ref('TimeCapsuleEvent'), 'Newest first'),
    },
    ['status', 'entries', 'events'],
  ),
  SnapshotCandidate: obj(
    {
      snapshot: obj(
        { id: str(), name: str(), takenAt: nullable(int('Unix epoch ms')), volume: str(), accessPath: nullable(str()) },
        ['id', 'name', 'takenAt', 'volume', 'accessPath'],
      ),
      state: { type: 'string', enum: ['present', 'possible', 'absent'] },
      sizeBytes: nullable(int('Known only when the snapshot could be inspected')),
      modifiedAt: nullable(int()),
    },
    ['snapshot', 'state', 'sizeBytes', 'modifiedAt'],
    "'possible' means the snapshot exists but reading it needs authorization — never assume it holds the file",
  ),
  SnapshotSearchResult: obj(
    {
      path: str(),
      candidates: arr(ref('SnapshotCandidate'), 'Newest first'),
      confirmed: bool('False when states were inferred rather than checked inside (macOS/Windows before authorization)'),
      capability: opaque('available, mechanism, reason?, degradedTo?'),
      stillPresent: bool('The path is still on disk — not a recovery case'),
      reason: str('Why there is nothing to offer'),
    },
    ['path', 'candidates', 'confirmed', 'capability'],
  ),
  AutopilotPolicy: obj(
    {
      id: str(),
      name: str('User-facing label'),
      path: str('The folder this policy may clean'),
      match: opaque("{ kind: 'suggestion', groupIds[] } or { kind: 'custom', maxAgeMs?, minBytes?, exts[]? }"),
      maxBytesPerRun: nullable(int('Ceiling on one run; null = uncapped')),
      maxBytesPerWeek: nullable(int('Ceiling across a rolling 7 days; null = uncapped')),
      cooldownDays: int('Minimum days between runs; also acts as the schedule'),
      dryRunFirst: bool('Simulate every run instead of deleting'),
      requireConfirmationAbove: nullable(int('Refuse unattended when the match totals more than this')),
      enabled: bool(),
      approvedAt: int('Set once the mandatory first dry run was approved; until then the policy only simulates'),
      lastRunAt: int(),
    },
    ['id', 'name', 'path', 'match', 'maxBytesPerRun', 'maxBytesPerWeek', 'cooldownDays', 'dryRunFirst', 'requireConfirmationAbove', 'enabled'],
    'A standing cleanup instruction. It never deletes until approved, and every deletion routes through the Time Capsule and the open-file guard',
  ),
  AutopilotRun: obj(
    {
      id: str(),
      policyId: str(),
      policyName: str(),
      at: int('Unix epoch ms'),
      mode: { type: 'string', enum: ['dry-run', 'live'] },
      status: { type: 'string', enum: ['awaiting-approval', 'completed', 'blocked', 'failed'] },
      blockedReason: str('Why nothing was deleted, when nothing was'),
      items: arr(obj(
        { path: str(), name: str(), bytes: int(), reason: str('Why it was selected, in the rule’s own words'), regenerateCmd: str() },
        ['path', 'name', 'bytes', 'reason'],
      )),
      bytesMatched: int('What the match totalled, before any cap'),
      bytesDeleted: int('What was actually removed; 0 for a dry run'),
      capsuleRunId: str('Ties this run’s deletions to their Time Capsule copies'),
      skipped: arr(obj({ path: str(), reason: str() }, ['path', 'reason'])),
      undoneAt: int('Set once the run has been undone'),
    },
    ['id', 'policyId', 'policyName', 'at', 'mode', 'status', 'items', 'bytesMatched', 'bytesDeleted', 'skipped'],
  ),
  AgentPolicy: obj(
    {
      allowedRoots: arr(str(), 'When non-empty, scans and destructive targets must lie inside one of these'),
      protectedPaths: arr(str(), 'Never trashed or offloaded (nor anything containing them)'),
      maxBytesPerOperation: nullable(int('Refuse a single destructive operation over this many bytes; null = no cap')),
    },
    ['allowedRoots', 'protectedPaths', 'maxBytesPerOperation'],
    'User-editable guard rails (agent-policy.json in the app-data dir); empty file = no restriction',
  ),
  AuditEntry: obj(
    {
      at: int('Unix epoch ms'),
      action: str("e.g. 'files.trash', 'offload.start', 'offload.restore', 'trash.empty'"),
      source: { type: 'string', enum: ['http', 'mcp'] },
      tokenId: str("Short digest of the configured token, or 'local' when auth is off"),
      paths: arr(str()),
      bytes: nullable(int('Known bytes involved, when the operation can tell')),
      dryRun: bool(),
      outcome: { type: 'string', enum: ['ok', 'refused', 'error'] },
      code: str("Error/refusal code when outcome is not 'ok'"),
    },
    ['at', 'action', 'source', 'tokenId', 'paths', 'bytes', 'dryRun', 'outcome'],
  ),
  TrashDryRunManifest: obj(
    {
      dryRun: bool('Always true'),
      wouldTrash: arr(obj({ path: str(), bytes: nullable(int('null when no scan knows this path')) }, ['path', 'bytes'])),
      totalKnownBytes: int(),
    },
    ['dryRun', 'wouldTrash', 'totalKnownBytes'],
    'What DELETE /api/files would do — nothing has been touched',
  ),
  OffloadDryRunManifest: obj(
    {
      dryRun: bool('Always true'),
      fileCount: int(),
      bytesTotal: int(),
      dest: str(),
      wouldTrashAfterVerify: arr(str(), 'The originals that would go to the Trash after every copy verifies'),
      copies: arr(obj({ src: str(), dest: str(), size: int() }, ['src', 'dest', 'size']), 'First 100 planned copies'),
      copiesTruncated: bool(),
    },
    ['dryRun', 'fileCount', 'bytesTotal', 'dest', 'wouldTrashAfterVerify', 'copies', 'copiesTruncated'],
    'The exact plan a real offload would execute — nothing has been touched',
  ),
  AgentSummary: obj(
    {
      scanId: str(),
      rootPath: str(),
      totals: obj(
        { bytes: int(), formatted: str(), fileCount: int(), dirCount: int() },
        ['bytes', 'formatted', 'fileCount', 'dirCount'],
      ),
      largestFiles: arr(
        { allOf: [ref('LargeFile'), obj({ sizeFormatted: str() }, ['sizeFormatted'])] },
        'Top 10, size desc',
      ),
      largestFolders: arr(
        { allOf: [ref('LargeFolder'), obj({ sizeFormatted: str() }, ['sizeFormatted'])] },
        'Top 10, size desc',
      ),
      cleanup: obj(
        {
          reclaimableBytes: int('Exact total across every suggestion group'),
          reclaimableFormatted: str(),
          byCategory: arr(
            obj(
              {
                category: { type: 'string', enum: ['regenerable', 'cache', 'junk'] },
                bytes: int(),
                bytesFormatted: str(),
                groupCount: int(),
              },
              ['category', 'bytes', 'bytesFormatted', 'groupCount'],
            ),
            'Bytes desc',
          ),
          groups: arr(
            obj(
              {
                id: str('Stable rule id'),
                title: str(),
                category: { type: 'string', enum: ['regenerable', 'cache', 'junk'] },
                totalSize: int(),
                totalSizeFormatted: str(),
                itemCount: int(),
                regenerateCmd: str('Regenerable groups only'),
                topItems: arr({ allOf: [ref('CleanupSuggestionItem'), obj({ sizeFormatted: str() }, ['sizeFormatted'])] }, 'Top 3'),
              },
              ['id', 'title', 'category', 'totalSize', 'totalSizeFormatted', 'itemCount', 'topItems'],
            ),
            'Top 10 groups, size desc',
          ),
        },
        ['reclaimableBytes', 'reclaimableFormatted', 'byCategory', 'groups'],
      ),
      forecast: {
        allOf: [ref('ForecastResult'), obj({ bytesPerDayFormatted: str(), freeFormatted: str() }, ['bytesPerDayFormatted', 'freeFormatted'])],
      },
    },
    ['scanId', 'rootPath', 'totals', 'largestFiles', 'largestFolders', 'cleanup', 'forecast'],
    'GET /api/agent/summary — the whole picture in one deterministic, read-only payload',
  ),
  AppSettings: obj(
    {
      ignore: arr(obj({ pattern: str(), scope: { type: 'string', enum: ['scan', 'suggest', 'both'] } }, ['pattern', 'scope'])),
      schedules: arr(
        obj(
          {
            id: str(),
            path: str(),
            intervalHours: num(),
            thresholdPct: num(),
            thresholdBytes: int(),
            enabled: bool(),
            lastRunAt: int(),
          },
          ['id', 'path', 'intervalHours', 'enabled'],
        ),
      ),
      budgets: arr(obj({ path: str(), maxBytes: int() }, ['path', 'maxBytes'])),
      forecastThresholdDays: num(),
      watchIdleMinutes: num(),
      cloud: opaque('Per-provider OAuth app credentials (gdrive / dropbox / onedrive)'),
    },
    ['ignore', 'schedules', 'budgets', 'forecastThresholdDays', 'watchIdleMinutes', 'cloud'],
  ),
};

/* -------------------------- endpoint registry -------------------------- */

/**
 * One entry per HTTP endpoint. This registry is the single source both the
 * OpenAPI paths object and GET /api/capabilities are generated from, so the
 * two can never disagree about what exists.
 */
export interface EndpointDescriptor {
  method: 'get' | 'post' | 'put' | 'delete';
  /** OpenAPI-style path, e.g. /api/scan/{scanId}/result */
  path: string;
  summary: string;
  tag: string;
  /** Mutates the filesystem, OS state, or persisted config. */
  destructive: boolean;
  parameters?: Json[];
  requestBody?: Json;
  responses: Json;
}

const jsonBody = (schema: Json, description?: string): Json => ({
  required: true,
  ...(description ? { description } : {}),
  content: { 'application/json': { schema } },
});

export const ENDPOINTS: EndpointDescriptor[] = [
  /* ------------ discoverability ------------ */
  {
    method: 'get',
    path: '/api/openapi.json',
    summary: 'This OpenAPI 3 document',
    tag: 'meta',
    destructive: false,
    responses: { '200': jsonResponse('The OpenAPI document', opaque('OpenAPI 3.0 document')) },
  },
  {
    method: 'get',
    path: '/api/capabilities',
    summary: 'Machine-readable capability manifest: endpoints, safety model, intended workflow',
    tag: 'meta',
    destructive: false,
    responses: { '200': jsonResponse('Capability manifest', opaque('See GET /api/capabilities')) },
  },
  {
    method: 'get',
    path: '/api/audit',
    summary: 'The destructive-action audit log (JSONL in the app-data dir), newest first',
    tag: 'meta',
    destructive: false,
    parameters: [queryParam('limit', '1–1000 (default 100)', int())],
    responses: { '200': jsonResponse('Audit entries', obj({ entries: arr(ref('AuditEntry')) }, ['entries'])) },
  },
  {
    method: 'get',
    path: '/api/policy',
    summary: 'The active agent policy and the file to edit it (read-only by design)',
    tag: 'meta',
    destructive: false,
    responses: {
      '200': jsonResponse('Policy', obj({ policy: ref('AgentPolicy'), file: str('Absolute path of agent-policy.json') }, ['policy', 'file'])),
    },
  },
  {
    method: 'get',
    path: '/api/agent/summary',
    summary: 'One read-only call: top culprits, reclaimable-by-category, and the forecast — raw bytes + formatted, deterministic order',
    tag: 'meta',
    destructive: false,
    parameters: [scanIdQuery],
    responses: {
      '200': jsonResponse('The summary', ref('AgentSummary')),
      '202': jsonResponse('Scan still running', obj({ status: str("'running'"), scanned: int(), currentPath: str() }, ['status', 'scanned'])),
      '404': errorResponse('Unknown scanId'),
    },
  },

  /* ------------ scanning ------------ */
  {
    method: 'post',
    path: '/api/scan',
    summary: 'Start scanning a directory tree (progress via SSE or polling GET /api/scan/{scanId}/stats); ?wait=true blocks until done',
    tag: 'scan',
    destructive: false,
    parameters: [
      queryParam('wait', "'true' = block until the scan settles (or waitMs elapses) instead of returning immediately", bool()),
      queryParam('waitMs', 'With wait=true: max wait in ms, 0–600000 (default 55000)', int()),
    ],
    requestBody: jsonBody(
      obj(
        {
          path: str('Absolute directory path (a leading ~ expands to the home directory)'),
          incremental: bool('Reuse the on-disk mtime cache for a fast rescan (default false)'),
        },
        ['path'],
      ),
    ),
    responses: {
      '200': jsonResponse(
        'wait=true only: the scan completed within waitMs',
        {
          allOf: [
            obj({ scanId: str(), status: str("'complete'"), incremental: bool() }, ['scanId', 'status', 'incremental']),
            ref('ScanStats'),
          ],
        },
      ),
      '202': jsonResponse(
        'Scan started (default), or still running after waitMs (wait=true adds status/scanned/currentPath)',
        obj({ scanId: str(), incremental: bool(), status: str("wait=true only: 'running'"), scanned: int('wait=true only'), currentPath: str('wait=true only') }, ['scanId', 'incremental']),
      ),
      '400': errorResponse('Path rejected'),
      '403': errorResponse('Outside agent-policy.json allowedRoots'),
      '404': errorResponse('Path does not exist'),
    },
  },
  {
    method: 'get',
    path: '/api/scan/{scanId}/progress',
    summary: "SSE progress stream: frames of type 'progress', then one 'complete' (pruned tree + stats) or 'error'",
    tag: 'scan',
    destructive: false,
    parameters: [pathParam('scanId', 'Scan id')],
    responses: { '200': sseResponse('ScanEvent frames'), '404': errorResponse('Unknown scanId') },
  },
  {
    method: 'get',
    path: '/api/scan/{scanId}/result',
    summary: 'The completed scan: counters plus the tree pruned to a 250k-node budget',
    tag: 'scan',
    destructive: false,
    parameters: [pathParam('scanId', 'Scan id')],
    responses: {
      '200': jsonResponse(
        'Completed scan',
        obj(
          {
            status: str("'complete'"),
            scanId: str(),
            rootPath: str(),
            fileCount: int(),
            dirCount: int(),
            hardlinkedFiles: int(),
            hardlinkedBytes: int(),
            cloudFiles: int(),
            cloudBytes: int(),
            startedAt: int(),
            finishedAt: int(),
            root: ref('FileNode'),
          },
          ['status', 'scanId', 'rootPath', 'fileCount', 'dirCount', 'startedAt'],
        ),
      ),
      '202': running202,
      '404': errorResponse('Unknown scanId'),
      '500': errorResponse('Scan failed'),
    },
  },
  {
    method: 'get',
    path: '/api/scan/{scanId}/subtree',
    summary: 'Bounded drill-in: a nested subtree rooted at ?path, for directories the pruned tree withheld',
    tag: 'scan',
    destructive: false,
    parameters: [
      pathParam('scanId', 'Scan id'),
      queryParam('path', 'Directory inside the scanned root (defaults to the root)'),
      queryParam('maxNodes', 'Node budget, clamped to 1–250000 (default 20000)', int()),
    ],
    responses: {
      '200': jsonResponse(
        'Subtree',
        obj({ scanId: str(), root: ref('FileNode'), nodes: int('Nodes emitted'), prunedDirs: int('Dirs still pruned') }, ['scanId', 'root', 'nodes', 'prunedDirs']),
      ),
      '202': running202,
      '403': errorResponse('Path outside the scanned root'),
      '404': errorResponse('Unknown scanId or path not in this scan'),
    },
  },
  {
    method: 'post',
    path: '/api/scan/{scanId}/nodes',
    summary: 'Resolve up to 500 paths to node metadata (null for paths not in this scan)',
    tag: 'scan',
    destructive: false,
    parameters: [pathParam('scanId', 'Scan id')],
    requestBody: jsonBody(obj({ paths: arr(str(), 'At most 500') }, ['paths'])),
    responses: {
      '200': jsonResponse(
        'Path → node map',
        obj(
          {
            scanId: str(),
            nodes: { type: 'object', description: 'Map of requested path → FileNode, or null when not in this scan', additionalProperties: { oneOf: [ref('FileNode'), { type: 'null' }] } },
          },
          ['scanId', 'nodes'],
        ),
      ),
      '202': running202,
      '400': errorResponse('Bad batch (missing, empty, or over 500 paths)'),
    },
  },
  {
    method: 'get',
    path: '/api/scan/{scanId}/stats',
    summary: 'O(1) scan counters — the honest polling endpoint (status turns complete/error when done)',
    tag: 'scan',
    destructive: false,
    parameters: [pathParam('scanId', 'Scan id')],
    responses: {
      '200': jsonResponse(
        'Counters',
        {
          allOf: [
            obj({ scanId: str(), status: { type: 'string', enum: ['running', 'complete', 'error'] } }, ['scanId', 'status']),
            ref('ScanStats'),
          ],
        },
      ),
      '404': errorResponse('Unknown scanId'),
    },
  },
  {
    method: 'get',
    path: '/api/scan/{scanId}/budgets',
    summary: 'Saved folder budgets cross-referenced against this scan',
    tag: 'scan',
    destructive: false,
    parameters: [pathParam('scanId', 'Scan id')],
    responses: {
      '200': jsonResponse('Budget statuses', obj({ scanId: str(), budgets: arr(ref('BudgetStatus')) }, ['scanId', 'budgets'])),
      '202': running202,
    },
  },
  {
    method: 'get',
    path: '/api/scan/{scanId}/export',
    summary: 'Download the scan as a report (csv, xlsx or pdf attachment)',
    tag: 'scan',
    destructive: false,
    parameters: [
      pathParam('scanId', 'Scan id'),
      queryParam('format', 'csv | xlsx | pdf (default csv)'),
      queryParam('mode', 'files | folders (default files)'),
    ],
    responses: { '200': { description: 'The report file as an attachment' }, '400': errorResponse('Bad format') },
  },
  {
    method: 'get',
    path: '/api/scan/{scanId}/treemap',
    summary: 'Pre-computed squarified treemap layout, coordinates in percent',
    tag: 'scan',
    destructive: false,
    parameters: [
      pathParam('scanId', 'Scan id'),
      queryParam('maxDepth', '1–8 (default 3)', int()),
      queryParam('minSize', 'Bytes (default 10240)', int()),
      queryParam('root', 'Zoom to this directory inside the scanned root'),
    ],
    responses: {
      '200': jsonResponse(
        'Layout',
        obj(
          {
            scanId: str(),
            root: obj({ name: str(), path: str(), size: int(), modifiedAt: int() }, ['name', 'path', 'size', 'modifiedAt']),
            scanRootPath: str(),
            maxDepth: int(),
            minSize: int(),
            nodes: arr(ref('TreemapNode')),
          },
          ['scanId', 'root', 'scanRootPath', 'maxDepth', 'minSize', 'nodes'],
        ),
      ),
      '202': running202,
    },
  },
  {
    method: 'get',
    path: '/api/scans',
    summary: 'Completed scans currently in memory (30-minute TTL)',
    tag: 'scan',
    destructive: false,
    responses: {
      '200': jsonResponse(
        'Scan list',
        obj(
          {
            scans: arr(
              obj(
                { scanId: str(), rootPath: str(), totalSize: int(), fileCount: int(), finishedAt: int() },
                ['scanId', 'rootPath', 'totalSize', 'fileCount'],
              ),
              'Newest first',
            ),
          },
          ['scans'],
        ),
      ),
    },
  },

  /* ------------ insights ------------ */
  {
    method: 'get',
    path: '/api/large-files',
    summary: 'Largest files in a completed scan',
    tag: 'insights',
    destructive: false,
    parameters: [scanIdQuery, queryParam('limit', '1–1000 (default 50)', int()), queryParam('minSize', 'Bytes (default 1048576)', int())],
    responses: { '200': jsonResponse('Largest files', obj({ files: arr(ref('LargeFile')) }, ['files'])), '202': running202 },
  },
  {
    method: 'get',
    path: '/api/large-folders',
    summary: 'Largest folders in a completed scan',
    tag: 'insights',
    destructive: false,
    parameters: [scanIdQuery, queryParam('limit', '1–500 (default 20)', int()), queryParam('minSize', 'Bytes (default 1048576)', int())],
    responses: { '200': jsonResponse('Largest folders', obj({ folders: arr(ref('LargeFolder')) }, ['folders'])) },
  },
  {
    method: 'get',
    path: '/api/file-types',
    summary: 'Bytes and counts per file extension',
    tag: 'insights',
    destructive: false,
    parameters: [scanIdQuery],
    responses: { '200': jsonResponse('Types', obj({ types: arr(ref('FileTypeStat')) }, ['types'])), '202': running202 },
  },
  {
    method: 'get',
    path: '/api/duplicates',
    summary: 'Content-identical duplicate groups (background hashing; 202 with progress while running)',
    tag: 'insights',
    destructive: false,
    parameters: [scanIdQuery, queryParam('minSize', 'Ignore files smaller than this (default 1024)', int())],
    responses: {
      '200': jsonResponse(
        'Groups, largest reclaimable first',
        obj(
          {
            status: str("'complete'"),
            scanId: str(),
            minSize: int(),
            groups: arr(ref('DuplicateGroup'), 'Top 500'),
            groupCount: int(),
            totalReclaimable: int(),
            tookMs: int(),
          },
          ['status', 'scanId', 'minSize', 'groups', 'groupCount', 'totalReclaimable', 'tookMs'],
        ),
      ),
      '202': jsonResponse('Hashing in progress', obj({ status: str("'running'"), hashed: int(), toHash: int() }, ['status', 'hashed', 'toHash'])),
      '409': errorResponse('Scan still running'),
    },
  },
  {
    method: 'get',
    path: '/api/near-duplicates',
    summary: 'Perceptually similar images (dHash clusters); 202 with progress while hashing',
    tag: 'insights',
    destructive: false,
    parameters: [scanIdQuery, queryParam('threshold', 'Max Hamming distance 0–32 (default 10)', int())],
    responses: {
      '200': jsonResponse('Clusters', opaque('status, scanId, threshold, available, decoder, reason?, clusters[], clusterCount, totalReclaimable, truncated, tookMs')),
      '202': jsonResponse('Hashing in progress', obj({ status: str("'running'"), hashed: int(), toHash: int() }, ['status', 'hashed', 'toHash'])),
    },
  },
  {
    method: 'get',
    path: '/api/apps',
    summary: 'Per-application storage attribution',
    tag: 'insights',
    destructive: false,
    parameters: [scanIdQuery],
    responses: { '200': jsonResponse('Attribution', opaque('AppAttributionResult: scanId, apps[], otherBytes, totalBytes, appsFolderScanned')) },
  },
  {
    method: 'get',
    path: '/api/empty-folders',
    summary: 'Topmost recursively-empty directories',
    tag: 'insights',
    destructive: false,
    parameters: [scanIdQuery, queryParam('ignoreJunk', "OS junk files don't count as content (default true)", bool())],
    responses: { '200': jsonResponse('Empty folders', ref('EmptyFoldersResult')) },
  },
  {
    method: 'get',
    path: '/api/compare',
    summary: 'Structural diff between two completed scans of the same root',
    tag: 'insights',
    destructive: false,
    parameters: [
      queryParam('scanIdA', 'The earlier scan', { type: 'string' }, true),
      queryParam('scanIdB', 'The later scan', { type: 'string' }, true),
    ],
    responses: {
      '200': jsonResponse('Diff', ref('CompareResult')),
      '400': errorResponse('Scans cover different roots'),
    },
  },
  {
    method: 'get',
    path: '/api/git/repos',
    summary: 'Git repositories in the scan with pack/loose/LFS breakdown',
    tag: 'insights',
    destructive: false,
    parameters: [scanIdQuery],
    responses: { '200': jsonResponse('Repositories', obj({ repos: arr(opaque('Per-repo breakdown')) }, ['repos'])) },
  },
  {
    method: 'get',
    path: '/api/security/findings',
    summary: 'Secrets (keys, .env, wallets, cloud credentials) found OUTSIDE their expected locations — names and paths only, never contents',
    tag: 'insights',
    destructive: false,
    parameters: [scanIdQuery],
    responses: {
      '200': jsonResponse(
        'Findings, most serious first',
        obj(
          {
            scanId: str(),
            patternCount: int('How many patterns the catalog checks'),
            findings: arr(opaque('patternId, label, why, severity, path, name, size, modifiedAt, reason, suggestedPath, exposed')),
            counts: opaque('high, medium and low finding counts'),
            truncated: bool('true when the 500-finding cap was reached'),
          },
          ['scanId', 'findings', 'counts'],
        ),
      ),
    },
  },
  {
    method: 'post',
    path: '/api/security/relocate',
    summary: 'Move ONE secret into a safer directory. Never deletes, never overwrites an existing destination.',
    tag: 'insights',
    destructive: true,
    parameters: [idempotencyHeader],
    requestBody: jsonBody(
      obj(
        {
          path: str('File inside a scanned root'),
          to: str('Destination path, including the file name'),
          confirm: bool('Must be true'),
        },
        ['path', 'to', 'confirm'],
      ),
    ),
    responses: {
      '200': jsonResponse('Moved', obj({ moved: bool(), from: str(), to: str() }, ['moved', 'from', 'to'])),
      '409': errorResponse('The destination is occupied, or the move failed — nothing was removed'),
    },
  },
  {
    method: 'get',
    path: '/api/games',
    summary: 'Game libraries (Steam, Epic, GOG, itch.io) broken down per title into base install, shader cache, workshop, Proton prefix and DLC',
    tag: 'insights',
    destructive: false,
    parameters: [scanIdQuery],
    responses: {
      '200': jsonResponse(
        'Libraries, largest first',
        obj(
          {
            scanId: str(),
            libraries: arr(opaque('launcher, path, totalBytes, shaderCacheBytes, titles[]')),
            totalBytes: int(),
            shaderCacheBytes: int('Total shader cache across every title — the only part safe to clear'),
            titleCount: int(),
          },
          ['scanId', 'libraries', 'totalBytes', 'shaderCacheBytes', 'titleCount'],
        ),
      ),
    },
  },
  {
    method: 'get',
    path: '/api/packages/orphans',
    summary: 'Package-manager artifacts classified as orphaned (owning project gone), active, or shared cache',
    tag: 'cleanup',
    destructive: false,
    parameters: [scanIdQuery],
    responses: {
      '200': jsonResponse(
        'Ecosystems, most reclaimable first. available:false with a reason means a rule pack is malformed.',
        obj(
          {
            scanId: str(),
            available: bool('false when the rule-pack catalog could not be loaded'),
            reason: str('Why the catalog could not be loaded'),
            ecosystems: arr(opaque('ecosystem, orphan/active/cache counts and bytes, entries[]')),
            orphanBytes: int('Exact total across every orphan'),
            cacheBytes: int(),
            activeBytes: int(),
            orphanCount: int(),
          },
          ['scanId', 'ecosystems'],
        ),
      ),
    },
  },
  {
    method: 'post',
    path: '/api/git/gc',
    summary: 'Run git gc in a scanned repository (requires confirm: true)',
    tag: 'insights',
    destructive: true,
    parameters: [idempotencyHeader],
    requestBody: jsonBody(obj({ path: str('Repo path inside a scanned root'), confirm: bool('Must be true') }, ['path', 'confirm'])),
    responses: { '200': jsonResponse('gc result', opaque('Result of git gc')), '400': errorResponse('confirm missing'), '403': errorResponse('Outside every scanned root') },
  },
  {
    method: 'post',
    path: '/api/container/expand',
    summary: "List a container's contents (zip/tar/iso/docker/…) and graft them into the scan as virtual children",
    tag: 'insights',
    destructive: false,
    requestBody: jsonBody(obj({ scanId: str(), path: str('Container file inside the scanned root') }, ['scanId', 'path'])),
    responses: { '200': jsonResponse('Expanded listing', opaque('Container listing grafted into the scan')) },
  },

  /* ------------ history & forecast ------------ */
  {
    method: 'get',
    path: '/api/snapshots',
    summary: 'Snapshot history: roots (no params), one root (?path=), or all slim (?all=true)',
    tag: 'history',
    destructive: false,
    parameters: [queryParam('path', 'Root to list snapshots for'), queryParam('all', "'true' for every snapshot, slim", bool())],
    responses: { '200': jsonResponse('History', opaque('{roots[]} | {rootPath, snapshots[]} | {snapshots[]}')) },
  },
  {
    method: 'get',
    path: '/api/snapshots/tree',
    summary: 'Historical treemap: the stored snapshot tree closest to ?at, in the live treemap shape',
    tag: 'history',
    destructive: false,
    parameters: [
      queryParam('path', 'Tracked root', { type: 'string' }, true),
      queryParam('at', 'Unix ms timestamp', int(), true),
    ],
    responses: {
      '200': jsonResponse('Historical layout', opaque('snapshot, prevTakenAt, root, scanRootPath, maxDepth, minSize, nodes[], tree')),
      '404': errorResponse('No snapshot trees recorded'),
    },
  },
  {
    method: 'get',
    path: '/api/snapshots/compare',
    summary: 'Deltas between two snapshots of the same root',
    tag: 'history',
    destructive: false,
    parameters: [queryParam('a', 'Snapshot id', { type: 'string' }, true), queryParam('b', 'Snapshot id', { type: 'string' }, true)],
    responses: { '200': jsonResponse('Diff', opaque('SnapshotDiff: a, b, rootPath, totalDelta, entries[]')), '404': errorResponse('Unknown snapshot id') },
  },
  {
    method: 'get',
    path: '/api/forecast',
    summary: 'Disk-full projection for a tracked root from snapshot history + free space',
    tag: 'history',
    destructive: false,
    parameters: [queryParam('path', 'Tracked root', { type: 'string' }, true)],
    responses: { '200': jsonResponse('Forecast', ref('ForecastResult')) },
  },

  /* ------------ cleanup ------------ */
  {
    method: 'get',
    path: '/api/cleanup/suggestions',
    summary: 'Smart reclaimable-space suggestions (regenerable dirs, caches, junk), grouped by rule pack rule',
    tag: 'cleanup',
    destructive: false,
    parameters: [scanIdQuery],
    responses: {
      '200': jsonResponse(
        'Groups, largest first. available:false with a reason means a rule pack is malformed — the rest of the app is unaffected.',
        obj(
          {
            scanId: str(),
            groups: arr(ref('CleanupSuggestionGroup')),
            available: bool('false when the rule-pack catalog could not be loaded'),
            reason: str('Why the catalog could not be loaded (present only when available is false)'),
            catalog: opaque('schemaVersion and the loaded packs: name, updated, ruleCount'),
          },
          ['scanId', 'groups'],
        ),
      ),
      '202': running202,
    },
  },
  {
    method: 'get',
    path: '/api/cleanup/browser-profiles',
    summary: 'Browser profiles with their reclaimable cache sub-areas',
    tag: 'cleanup',
    destructive: false,
    parameters: [scanIdQuery],
    responses: { '200': jsonResponse('Profiles', opaque('scanId, profiles[]: browser, profile, path, totalBytes, items[]')) },
  },
  {
    method: 'get',
    path: '/api/cleanup/cloud-safe',
    summary: 'Online-only cloud placeholder files, grouped by provider (safe to remove locally)',
    tag: 'cleanup',
    destructive: false,
    parameters: [scanIdQuery, queryParam('perProvider', 'File list cap per provider, 1–2000 (default 300)', int())],
    responses: { '200': jsonResponse('Placeholders', opaque('scanId, groups[], totalCount and exact byte totals')) },
  },
  {
    method: 'get',
    path: '/api/cleanup/rules',
    summary: 'Files matching custom rules (age / size / extension / duplicate-name); rules are ANDed',
    tag: 'cleanup',
    destructive: false,
    parameters: [
      scanIdQuery,
      queryParam('maxAgeMs', 'Only files older than this', int()),
      queryParam('minBytes', 'Only files at least this big', int()),
      queryParam('exts', 'Comma-separated extensions'),
      queryParam('dup', "'1' — only name+size duplicates", bool()),
      queryParam('limit', '1–2000 (default 500)', int()),
    ],
    responses: {
      '200': jsonResponse('Matches', opaque('scanId, files[], matched count')),
      '400': errorResponse('No rules enabled'),
    },
  },

  /* ------------ files (destructive & OS-touching) ------------ */
  {
    method: 'delete',
    path: '/api/files',
    summary: 'Move paths to the system Trash (never a hard delete); paths must be inside a scanned root',
    tag: 'files',
    destructive: true,
    parameters: [idempotencyHeader],
    requestBody: jsonBody(
      obj(
        {
          paths: arr(str(), 'At most 500, each inside a scanned root'),
          dryRun: bool('true = return the exact manifest (paths + known bytes) and touch nothing'),
          ignoreOpenHandles: bool('true = trash even though a program has something open (the user chose "delete anyway")'),
        },
        ['paths'],
      ),
    ),
    responses: {
      '200': jsonResponse('Per-path outcome, or the dry-run manifest', { oneOf: [ref('CleanResult'), ref('TrashDryRunManifest')] }),
      '403': errorResponse('A path is outside every scanned root, cloud-hosted, inside an archive, or refused by agent-policy.json'),
      '409': errorResponse('OPEN_HANDLE_CONFLICT — a program holds one of these paths (or a file inside it) open; the offending processes are listed in `conflicts`. Retry with ignoreOpenHandles: true to proceed anyway'),
    },
  },
  {
    method: 'post',
    path: '/api/files/open-handles',
    summary: 'Which of these paths (or files inside them) is a program holding open? Read-only pre-flight for a delete',
    tag: 'files',
    destructive: false,
    requestBody: jsonBody(obj({ paths: arr(str(), 'At most 500, each inside a scanned root') }, ['paths'])),
    responses: {
      '200': jsonResponse('Open-handle report', ref('OpenHandleReport')),
      '403': errorResponse('A path is outside every scanned root'),
    },
  },
  {
    method: 'post',
    path: '/api/files/open',
    summary: 'Open a path with the OS default app (reveal: true highlights it in the file manager)',
    tag: 'files',
    destructive: false,
    requestBody: jsonBody(obj({ path: str('Inside a scanned root'), reveal: bool() }, ['path'])),
    responses: { '200': jsonResponse('Opened', obj({ opened: str() }, ['opened'])), '403': errorResponse('Outside every scanned root') },
  },
  {
    method: 'post',
    path: '/api/files/terminal',
    summary: "Open the platform's terminal at a scanned directory",
    tag: 'files',
    destructive: false,
    requestBody: jsonBody(obj({ path: str('Directory inside a scanned root') }, ['path'])),
    responses: { '200': jsonResponse('Opened', obj({ opened: str() }, ['opened'])), '400': errorResponse('Not a directory') },
  },
  {
    method: 'get',
    path: '/api/files/preview',
    summary: 'Read-only preview: images stream inline, known text types return the first 8 KB, else metadata',
    tag: 'files',
    destructive: false,
    parameters: [queryParam('path', 'File inside a scanned root', { type: 'string' }, true), queryParam('thumb', 'Present = WebP thumbnail mode')],
    responses: {
      '200': { description: 'Image bytes, or JSON {type: text|meta, …}' },
      '304': { description: 'Thumbnail mode only: the ETag still matches, body unchanged' },
      '403': errorResponse('Outside every scanned root'),
    },
  },

  /* ------------ offload ------------ */
  {
    method: 'post',
    path: '/api/offload',
    summary: 'Copy → verify SHA-256 → only then trash the local originals; any failure rolls back',
    tag: 'offload',
    destructive: true,
    parameters: [idempotencyHeader],
    requestBody: jsonBody(
      obj(
        {
          scanId: str('Completed scan the sources belong to'),
          paths: arr(str(), 'Sources inside the scanned root'),
          dest: str('Existing destination folder'),
          dryRun: bool('true = return the exact copy plan, validated end-to-end, and touch nothing'),
        },
        ['scanId', 'paths', 'dest'],
      ),
    ),
    responses: {
      '200': jsonResponse('Dry-run manifest (dryRun: true only)', ref('OffloadDryRunManifest')),
      '202': jsonResponse('Job started (progress via SSE)', obj({ jobId: str() }, ['jobId'])),
      '400': errorResponse('Bad destination / too many files / not enough space'),
      '403': errorResponse('Sources outside every scanned root, or refused by agent-policy.json'),
    },
  },
  {
    method: 'post',
    path: '/api/offload/restore',
    summary: 'Copy offloaded files back to their original paths, re-verifying the recorded hash',
    tag: 'offload',
    destructive: true,
    parameters: [idempotencyHeader],
    requestBody: jsonBody(
      obj(
        {
          ids: arr(str(), 'Offload entry ids, at most 500'),
          dryRun: bool('true = list exactly what would be restored and touch nothing'),
        },
        ['ids'],
      ),
    ),
    responses: {
      '200': jsonResponse(
        'Dry-run manifest (dryRun: true only)',
        obj(
          {
            dryRun: bool('Always true'),
            wouldRestore: arr(obj({ id: str(), name: str(), originalPath: str(), destPath: str(), size: int() }, ['id', 'name', 'originalPath', 'destPath', 'size'])),
            bytesTotal: int(),
          },
          ['dryRun', 'wouldRestore', 'bytesTotal'],
        ),
      ),
      '202': jsonResponse('Job started', obj({ jobId: str() }, ['jobId'])),
      '404': errorResponse('Nothing to restore'),
    },
  },
  {
    method: 'get',
    path: '/api/offload/index',
    summary: 'Everything offloaded, grouped by destination drive',
    tag: 'offload',
    destructive: false,
    responses: { '200': jsonResponse('Index', ref('OffloadIndex')) },
  },
  {
    method: 'post',
    path: '/api/offload/reveal',
    summary: 'Reveal an offloaded copy at its destination in the file manager',
    tag: 'offload',
    destructive: false,
    requestBody: jsonBody(obj({ id: str('Offload entry id') }, ['id'])),
    responses: { '200': jsonResponse('Revealed', obj({ revealed: str() }, ['revealed'])), '404': errorResponse('Unknown entry') },
  },
  {
    method: 'post',
    path: '/api/offload/{jobId}/cancel',
    summary: 'Cooperatively cancel a running offload/restore job (rolls back what it wrote)',
    tag: 'offload',
    destructive: false,
    parameters: [pathParam('jobId', 'Job id')],
    responses: { '200': jsonResponse('Cancelling', obj({ cancelling: bool() }, ['cancelling'])), '404': errorResponse('No running job') },
  },
  {
    method: 'get',
    path: '/api/offload/{jobId}/progress',
    summary: 'SSE progress stream for an offload/restore job',
    tag: 'offload',
    destructive: false,
    parameters: [pathParam('jobId', 'Job id')],
    responses: { '200': sseResponse('OffloadStreamEvent frames'), '404': errorResponse('Unknown job') },
  },

  /* ------------ system ------------ */
  {
    method: 'get',
    path: '/api/system',
    summary: 'Platform, hostname, disk totals, and suggested folders to scan',
    tag: 'system',
    destructive: false,
    responses: { '200': jsonResponse('System info', ref('SystemInfo')) },
  },
  {
    method: 'get',
    path: '/api/trash/size',
    summary: 'Current size and contents of the system Trash across locations',
    tag: 'system',
    destructive: false,
    responses: { '200': jsonResponse('Trash info', opaque('totalBytes, itemCount, paths, items')) },
  },
  {
    method: 'post',
    path: '/api/trash/empty',
    summary: 'Empty the system Trash / Recycle Bin — irreversible; requires confirm: true',
    tag: 'system',
    destructive: true,
    parameters: [idempotencyHeader],
    requestBody: jsonBody(obj({ confirm: bool('Must be true') }, ['confirm'])),
    responses: { '200': jsonResponse('Result', opaque('Per-location outcome')), '400': errorResponse('confirm missing') },
  },
  {
    method: 'get',
    path: '/api/system/snapshots',
    summary: 'OS snapshot accounting (APFS/Btrfs/VSS), best-effort',
    tag: 'system',
    destructive: false,
    responses: { '200': jsonResponse('Accounting', opaque('Platform-specific snapshot accounting')) },
  },
  {
    method: 'post',
    path: '/api/system/snapshots/purge',
    summary: 'Delete local OS snapshots (macOS); requires confirm: true',
    tag: 'system',
    destructive: true,
    parameters: [idempotencyHeader],
    requestBody: jsonBody(obj({ confirm: bool('Must be true') }, ['confirm'])),
    responses: { '200': jsonResponse('Result', opaque('Purge outcome')), '400': errorResponse('confirm missing') },
  },
  {
    method: 'get',
    path: '/api/fs/list',
    summary: 'Subdirectories of a folder (powers the Browse picker)',
    tag: 'system',
    destructive: false,
    parameters: [queryParam('path', 'Directory (defaults to the home directory)')],
    responses: {
      '200': jsonResponse(
        'Listing',
        obj(
          {
            path: str(),
            parent: nullable(str()),
            dirs: arr(obj({ name: str(), path: str(), isHidden: bool() }, ['name', 'path', 'isHidden'])),
          },
          ['path', 'parent', 'dirs'],
        ),
      ),
    },
  },

  /* ------------ settings & watch ------------ */
  {
    method: 'get',
    path: '/api/settings',
    summary: 'User settings: ignore list, schedules, budgets, thresholds, cloud credentials',
    tag: 'settings',
    destructive: false,
    responses: { '200': jsonResponse('Settings', ref('AppSettings')) },
  },
  {
    method: 'put',
    path: '/api/settings',
    summary: 'Replace whichever settings lists are present in the body',
    tag: 'settings',
    destructive: true,
    requestBody: jsonBody(opaque('Any subset of AppSettings: ignore, schedules, budgets, forecastThresholdDays, watchIdleMinutes, cloud')),
    responses: { '200': jsonResponse('Updated settings', ref('AppSettings')), '400': errorResponse('Bad shape') },
  },
  {
    method: 'get',
    path: '/api/notifications',
    summary: 'Growth alerts emitted by scheduled scans',
    tag: 'settings',
    destructive: false,
    parameters: [queryParam('since', 'Unix ms — only alerts after this', int())],
    responses: { '200': jsonResponse('Alerts', obj({ now: int(), notifications: arr(opaque('GrowthNotification')) }, ['now', 'notifications'])) },
  },
  {
    method: 'get',
    path: '/api/watch/{scanId}',
    summary: 'SSE live disk activity for a completed scan (init, activity, paused frames)',
    tag: 'settings',
    destructive: false,
    parameters: [pathParam('scanId', 'Completed scan id')],
    responses: { '200': sseResponse('WatchStreamEvent frames'), '409': errorResponse('Scan still running') },
  },

  /* ------------ cloud ------------ */
  {
    method: 'get',
    path: '/api/cloud/status',
    summary: 'Cloud provider connection status (local-only unless an account is connected)',
    tag: 'cloud',
    destructive: false,
    responses: { '200': jsonResponse('Providers', obj({ providers: arr(opaque('id, name, configured, connected, account?, trashLabel, needsClientSecret, quota?')) }, ['providers'])) },
  },
  {
    method: 'post',
    path: '/api/cloud/connect',
    summary: 'Begin OAuth for a provider — returns the authorize URL to open',
    tag: 'cloud',
    destructive: false,
    requestBody: jsonBody(obj({ provider: str('gdrive | dropbox | onedrive') }, ['provider'])),
    responses: { '200': jsonResponse('Auth started', opaque('authorizeUrl and redirect details')) },
  },
  {
    method: 'post',
    path: '/api/cloud/connect/manual',
    summary: 'Finish OAuth by pasting the redirect URL or code',
    tag: 'cloud',
    destructive: false,
    requestBody: jsonBody(obj({ input: str('Redirect URL or code') }, ['input'])),
    responses: { '200': jsonResponse('Connected', obj({ connected: str('Provider id') }, ['connected'])) },
  },
  {
    method: 'post',
    path: '/api/cloud/disconnect',
    summary: "Disconnect a provider (wipes its stored tokens)",
    tag: 'cloud',
    destructive: true,
    requestBody: jsonBody(obj({ provider: str() }, ['provider'])),
    responses: { '200': jsonResponse('Disconnected', obj({ disconnected: str() }, ['disconnected'])) },
  },
  {
    method: 'post',
    path: '/api/cloud/scan',
    summary: 'Scan a connected cloud account (progress via the normal scan SSE)',
    tag: 'cloud',
    destructive: false,
    requestBody: jsonBody(obj({ provider: str() }, ['provider'])),
    responses: { '202': jsonResponse('Scan started', obj({ scanId: str() }, ['scanId'])) },
  },
  {
    method: 'post',
    path: '/api/cloud/trash',
    summary: "Move cloud files to the provider's own trash (the cloud mirror of the trash-only rule)",
    tag: 'cloud',
    destructive: true,
    parameters: [idempotencyHeader],
    requestBody: jsonBody(obj({ scanId: str('A cloud scan'), paths: arr(str(), 'cloud:// paths inside that scan') }, ['scanId', 'paths'])),
    responses: { '200': jsonResponse('Outcome', opaque('Per-path provider-trash outcome')), '403': errorResponse('Path outside this cloud scan') },
  },

  /* ------------ platform capabilities (§2.2) ------------ */
  {
    method: 'get',
    path: '/api/platform/capabilities',
    summary: 'What this machine can actually do, detected at runtime — each capability available, unavailable with a reason, or degraded to a named fallback',
    tag: 'meta',
    destructive: false,
    responses: {
      '200': jsonResponse(
        'Capability states',
        obj(
          {
            platform: str("'windows' | 'macos' | 'linux'"),
            nodePlatform: str('process.platform, verbatim'),
            capabilities: opaque('One CapabilityState per capability-gated feature'),
          },
          ['platform', 'nodePlatform', 'capabilities'],
        ),
      ),
    },
  },
  {
    method: 'post',
    path: '/api/platform/capabilities/refresh',
    summary: 'Re-probe capabilities now (after granting a permission or installing a missing tool)',
    tag: 'meta',
    destructive: false,
    responses: { '200': jsonResponse('Freshly detected capability states', opaque('Same shape as GET')) },
  },
  /* ------------ persistent live index (A1) ------------ */
  {
    method: 'post',
    path: '/api/index/build',
    summary: 'Build (or rebuild) the persistent index for a folder — progress via SSE',
    tag: 'index',
    destructive: false,
    requestBody: jsonBody(obj({ path: str('Absolute folder path') }, ['path'])),
    responses: {
      '202': jsonResponse('Build started', obj({ jobId: str(), status: str("'running'") }, ['jobId'])),
      '403': errorResponse('POLICY_ROOT_NOT_ALLOWED — outside the configured allowedRoots'),
    },
  },
  {
    method: 'get',
    path: '/api/index/{jobId}/progress',
    summary: 'Server-Sent Events stream of index build progress',
    tag: 'index',
    destructive: false,
    parameters: [pathParam('jobId', 'Job id from POST /api/index/build')],
    responses: { '200': sseResponse('progress / complete / error / shutdown frames') },
  },
  {
    method: 'get',
    path: '/api/index/{jobId}/result',
    summary: 'The finished index root, or 202 while the build is still running',
    tag: 'index',
    destructive: false,
    parameters: [pathParam('jobId', 'Job id from POST /api/index/build')],
    responses: {
      '200': jsonResponse('Index root', opaque('status, root')),
      '202': running202,
      '404': errorResponse('JOB_NOT_FOUND'),
    },
  },
  {
    method: 'post',
    path: '/api/index/{jobId}/cancel',
    summary: 'Cancel a running index build; partial rows are discarded',
    tag: 'index',
    destructive: false,
    parameters: [pathParam('jobId', 'Job id from POST /api/index/build')],
    responses: { '200': jsonResponse('Cancelled', obj({ jobId: str(), cancelled: bool() }, ['jobId', 'cancelled'])) },
  },
  {
    method: 'get',
    path: '/api/index/status',
    summary: 'Indexed roots, or (with ?path=) whether a folder can be served from the index',
    tag: 'index',
    destructive: false,
    parameters: [queryParam('path', 'Optional folder to resolve against the index', str())],
    responses: { '200': jsonResponse('Index status', opaque('roots[] or { indexed, root, running[] }')) },
  },
  {
    method: 'get',
    path: '/api/index/tree',
    summary: 'Read a folder tree straight from the index — the instant-open path, same FileNode shape as a scan',
    tag: 'index',
    destructive: false,
    parameters: [
      queryParam('path', 'Folder to read', str()),
      queryParam('maxNodes', 'Node budget (default 250000)', int()),
    ],
    responses: {
      '200': jsonResponse('Indexed tree', opaque('root FileNode plus state/live/builtAt and counters')),
      '202': running202,
      '404': errorResponse('INDEX_NOT_BUILT — that folder has not been indexed yet'),
    },
  },
  {
    method: 'post',
    path: '/api/index/watch',
    summary: 'Attach a live watcher to an indexed folder so changes update it automatically',
    tag: 'index',
    destructive: false,
    requestBody: jsonBody(obj({ path: str('Indexed folder path') }, ['path'])),
    responses: {
      '200': jsonResponse('Watching', obj({ path: str(), watching: bool() }, ['path', 'watching'])),
      '404': errorResponse('INDEX_NOT_BUILT'),
    },
  },
  {
    method: 'delete',
    path: '/api/index',
    summary: 'Drop one indexed root (?path=) or the whole index — nothing on disk is touched',
    tag: 'index',
    destructive: false,
    parameters: [queryParam('path', 'Optional single root to drop', str())],
    responses: { '200': jsonResponse('Removed', obj({ removed: int() }, ['removed'])) },
  },

  /* ------------ instant search (A4) ------------ */
  {
    method: 'get',
    path: '/api/search',
    summary:
      'Instant size-aware search over the index. Same query language as the treemap highlight box: "*.zip", ".zip", or a case-insensitive filename substring. Size-descending.',
    tag: 'index',
    destructive: false,
    parameters: [
      queryParam('q', 'Query — "*.zip", ".zip", or a filename substring', str()),
      queryParam('minSize', 'Only entries at least this many bytes', int()),
      queryParam('olderThan', 'Only entries untouched for at least this many days', int()),
      queryParam('type', "'file' | 'dir' | 'all' (default all)", str()),
      queryParam('scope', 'Restrict to this folder and everything beneath it', str()),
      queryParam('limit', '1–500 (default 50)', int()),
      queryParam('offset', 'Pagination offset', int()),
    ],
    responses: {
      '200': jsonResponse(
        'Matches, largest first',
        opaque('hits[], total, countCapped, truncated, tookMs, roots[], staleRoots[]'),
      ),
    },
  },

  /* ------------ allocation accounting (A2) ------------ */
  {
    method: 'get',
    path: '/api/allocation',
    summary:
      'What a folder really costs on disk: naive vs inode-deduplicated vs allocated bytes, the shared/exclusive split, and (for a whole volume) reconciliation against the filesystem',
    tag: 'index',
    destructive: false,
    parameters: [queryParam('path', 'Indexed folder path', str())],
    responses: {
      '200': jsonResponse(
        'Allocation summary — always carries approximate:true with a plain-language reason',
        opaque('naiveLogicalBytes, logicalBytes, allocatedBytes, sharedBytes, exclusiveBytes, reconciliation'),
      ),
      '404': errorResponse('INDEX_NOT_BUILT — scan the folder once first'),
    },
  },
  {
    method: 'get',
    path: '/api/allocation/file',
    summary: 'Shared vs exclusive bytes for one file — what deleting it would actually free',
    tag: 'index',
    destructive: false,
    parameters: [queryParam('path', 'File path inside an indexed folder', str())],
    responses: {
      '200': jsonResponse('Per-file allocation', opaque('logicalBytes, allocatedBytes, sharedBytes, exclusiveBytes, links')),
      '404': errorResponse('INDEX_NOT_BUILT or PATH_NOT_FOUND'),
    },
  },

  {
    method: 'get',
    path: '/api/platform/topology',
    summary: 'Physical disks and the logical volumes on each — which drive is actually filling up',
    tag: 'system',
    destructive: false,
    responses: {
      '200': jsonResponse('Logical-to-physical mapping', opaque('physicalDisks[], logicalVolumes[], mechanism')),
      '409': errorResponse('CAPABILITY_UNAVAILABLE — disk layout cannot be read on this system'),
    },
  },
  {
    method: 'get',
    path: '/api/zombie-handles',
    summary: 'Space still held by files that were deleted while a process kept them open, grouped by process',
    tag: 'system',
    destructive: false,
    responses: {
      '200': jsonResponse(
        'The held-space report',
        obj(
          {
            processes: opaque('per-process groups: pid, processName, appBundle, bytes, unknownSizeCount, handles[]'),
            totalBytes: int('Known held bytes across every process — a floor, not an estimate'),
            unknownSizeCount: int('Held files whose size could not be read'),
            scannedAt: int(),
          },
          ['processes', 'totalBytes', 'unknownSizeCount', 'scannedAt'],
        ),
      ),
      '409': errorResponse('CAPABILITY_UNAVAILABLE — held-space detection is not possible on this system'),
    },
  },
  {
    method: 'post',
    path: '/api/zombie-handles/restart',
    summary: 'Ask the process holding deleted files to quit (reopening it where supported) so the space frees',
    tag: 'system',
    // Quitting a program can lose its unsaved work. SIGTERM only, identity-
    // checked against pid reuse, never TreeMap itself, never escalated.
    destructive: true,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: obj(
            {
              pid: int('The process id, exactly as reported by GET /api/zombie-handles'),
              processName: str('The process name from the same report — refused if the pid no longer matches it'),
            },
            ['pid', 'processName'],
          ),
        },
      },
    },
    responses: {
      '200': jsonResponse(
        'What happened',
        obj(
          { pid: int(), processName: str(), terminated: bool(), relaunched: bool(), message: str() },
          ['pid', 'processName', 'terminated', 'relaunched', 'message'],
        ),
      ),
      '400': errorResponse('PID_INVALID / PROCESS_NAME_REQUIRED / PID_IS_TREEMAP'),
      '409': errorResponse('CAPABILITY_UNAVAILABLE / PID_REUSED / PID_UNVERIFIED / TERMINATE_REFUSED'),
    },
  },
  {
    method: 'get',
    path: '/api/timecapsule',
    summary: 'Items copied aside before an automated delete, with capacity and history',
    tag: 'timecapsule',
    destructive: false,
    responses: { '200': jsonResponse('The capsule index', ref('TimeCapsuleIndex')) },
  },
  {
    method: 'post',
    path: '/api/timecapsule/{id}/restore',
    summary: 'Copy a protected item back to its original path, re-verifying every byte',
    tag: 'timecapsule',
    destructive: true,
    parameters: [pathParam('id', 'Time Capsule entry id'), idempotencyHeader],
    responses: {
      '202': jsonResponse('Restore started', obj({ jobId: str() }, ['jobId'])),
      '404': errorResponse('ENTRY_NOT_FOUND — no such entry'),
      '409': errorResponse('PATH_OCCUPIED, ALREADY_RESTORED or PAYLOAD_GONE — restoring never overwrites what is there now'),
    },
  },
  {
    method: 'delete',
    path: '/api/timecapsule/{id}',
    summary: 'Forget one protected item and free the space it holds',
    tag: 'timecapsule',
    destructive: true,
    parameters: [pathParam('id', 'Time Capsule entry id')],
    responses: {
      '200': jsonResponse('Forgotten', obj({ deleted: bool(), bytesFreed: int() }, ['deleted', 'bytesFreed'])),
      '404': errorResponse('ENTRY_NOT_FOUND — no such entry'),
    },
  },
  {
    method: 'get',
    path: '/api/timecapsule/jobs/{jobId}/progress',
    summary: 'Restore progress (Server-Sent Events)',
    tag: 'timecapsule',
    destructive: false,
    parameters: [pathParam('jobId', 'Id from POST /api/timecapsule/{id}/restore')],
    responses: {
      '200': sseResponse('progress | complete | cancelled | error | shutdown frames'),
      '404': errorResponse('JOB_NOT_FOUND — unknown or expired job id'),
    },
  },
  {
    method: 'get',
    path: '/api/system/snapshots/find-deleted',
    summary: 'Which filesystem snapshots could still hold a lost path — costs no privileges',
    tag: 'system',
    destructive: false,
    parameters: [queryParam('path', 'The path you are looking for', { type: 'string' }, true)],
    responses: {
      '200': jsonResponse('Candidate snapshots, newest first', ref('SnapshotSearchResult')),
      '400': errorResponse('PATH_REQUIRED'),
    },
  },
  {
    method: 'post',
    path: '/api/system/snapshots/restore',
    summary: 'Recover a path from the newest snapshot holding it, written beside the original',
    tag: 'system',
    destructive: true,
    parameters: [idempotencyHeader],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: obj({
        path: str('The original path to recover'),
        destination: str('Where to write it; defaults to a dated sibling of the original'),
        overwrite: bool('Replace an existing file at the destination. Off by default — a snapshot copy is older than whatever is there now'),
      }, ['path']) } },
    },
    responses: {
      '200': jsonResponse('Recovered', obj(
        { restored: bool(), originalPath: str(), restoredTo: str(), fromSnapshotId: nullable(str()), sizeBytes: int() },
        ['restored', 'originalPath', 'restoredTo', 'fromSnapshotId', 'sizeBytes'],
      )),
      '409': errorResponse('DESTINATION_OCCUPIED, NO_SNAPSHOTS, NOT_IN_ANY_SNAPSHOT, or AUTHORIZATION_DECLINED when the password prompt was dismissed'),
    },
  },
  {
    method: 'get',
    path: '/api/autopilot/policies',
    summary: 'Standing cleanup policies',
    tag: 'autopilot',
    destructive: false,
    responses: { '200': jsonResponse('Configured policies', obj({ policies: arr(ref('AutopilotPolicy')) }, ['policies'])) },
  },
  {
    method: 'put',
    path: '/api/autopilot/policies',
    summary: 'Replace the policy list; editing a policy’s scope revokes its approval',
    tag: 'autopilot',
    destructive: true,
    requestBody: { required: true, content: { 'application/json': { schema: obj({ policies: arr(ref('AutopilotPolicy')) }, ['policies']) } } },
    responses: {
      '200': jsonResponse('Saved, re-validated', obj({ policies: arr(ref('AutopilotPolicy')) }, ['policies'])),
      '400': errorResponse('POLICY_MATCH_EMPTY, POLICY_PATH_TOO_BROAD, POLICY_PATH_REQUIRED — refused rather than saved in a shape that would misbehave'),
    },
  },
  {
    method: 'post',
    path: '/api/autopilot/policies/{id}/approve',
    summary: 'Let a policy start deleting, after its mandatory first dry run',
    tag: 'autopilot',
    destructive: true,
    parameters: [pathParam('id', 'Policy id')],
    responses: {
      '200': jsonResponse('Approved', obj({ policy: ref('AutopilotPolicy') }, ['policy'])),
      '404': errorResponse('POLICY_NOT_FOUND'),
    },
  },
  {
    method: 'post',
    path: '/api/autopilot/simulate',
    summary: 'Exactly what a policy would delete — writes nothing, touches no schedule',
    tag: 'autopilot',
    destructive: false,
    requestBody: { required: true, content: { 'application/json': { schema: obj({ policyId: str('A saved policy'), policy: ref('AutopilotPolicy') }) } } },
    responses: {
      '200': jsonResponse('The projection', opaque('items[], bytesMatched, bytesWouldDelete, skipped[], capBytes, wouldBlockReason?')),
      '404': errorResponse('POLICY_NOT_FOUND'),
    },
  },
  {
    method: 'get',
    path: '/api/autopilot/runs',
    summary: 'Run history: what each run deleted, or why it refused',
    tag: 'autopilot',
    destructive: false,
    parameters: [queryParam('limit', 'How many runs to return (default 50)', { type: 'integer' })],
    responses: { '200': jsonResponse('Newest first', obj({ runs: arr(ref('AutopilotRun')) }, ['runs'])) },
  },
  {
    method: 'post',
    path: '/api/autopilot/runs/{id}/undo',
    summary: 'Put back everything a run deleted, from the Time Capsule',
    tag: 'autopilot',
    destructive: true,
    parameters: [pathParam('id', 'Run id'), idempotencyHeader],
    responses: {
      '202': jsonResponse('Restore started', obj({ jobId: str(), entryCount: int() }, ['jobId', 'entryCount'])),
      '404': errorResponse('RUN_NOT_FOUND'),
      '409': errorResponse('NOTHING_TO_UNDO, ALREADY_UNDONE or CAPSULE_EMPTY — refused rather than half-undone'),
    },
  },
  {
    method: 'post',
    path: '/api/timecapsule/jobs/{jobId}/cancel',
    summary: 'Cancel a running restore; anything already written is rolled back',
    tag: 'timecapsule',
    destructive: false,
    parameters: [pathParam('jobId', 'Id from POST /api/timecapsule/{id}/restore')],
    responses: {
      '200': jsonResponse('Cancelling', obj({ cancelling: bool() }, ['cancelling'])),
      '404': errorResponse('JOB_NOT_RUNNING — no running job with that id'),
    },
  },
];

/* ------------------------------ document ------------------------------ */

let cached: Json | null = null;

/** Build (once) the OpenAPI 3 document served at GET /api/openapi.json. */
export function buildOpenApiDocument(): Json {
  if (cached) return cached;

  const paths: Record<string, Json> = {};
  for (const ep of ENDPOINTS) {
    const entry = (paths[ep.path] ??= {});
    entry[ep.method] = {
      summary: ep.summary,
      tags: [ep.tag],
      ...(ep.destructive ? { description: 'DESTRUCTIVE: mutates the filesystem, OS state, or persisted config.' } : {}),
      ...(ep.parameters ? { parameters: ep.parameters } : {}),
      ...(ep.requestBody ? { requestBody: ep.requestBody } : {}),
      responses: ep.responses,
    };
  }

  cached = {
    openapi: '3.0.3',
    info: {
      title: 'TreeMap API',
      version: APP_VERSION,
      description:
        'Local disk-space visualizer API. Workflow: POST /api/scan, poll GET /api/scan/{scanId}/stats ' +
        '(or stream /progress), then query insights with the scanId, and only then act — deletes always go ' +
        'to the OS Trash and only paths inside a scanned root can be touched. Errors are always ' +
        '{ error, code } JSON. Rate limit: 10 req/s sustained per client (burst 20), 429 when exceeded. ' +
        'Auth is optional: only when the server runs with TREEMAP_TOKEN set do /api requests require ' +
        'Authorization: Bearer <token> (401 { code: "UNAUTHORIZED" } otherwise); the served web UI ' +
        'authenticates via an automatically-set cookie.',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'meta', description: 'Self-description' },
      { name: 'scan', description: 'Scanning and scan-tree access' },
      { name: 'insights', description: 'Analysis over a completed scan' },
      { name: 'history', description: 'Snapshots, trends and forecasting' },
      { name: 'cleanup', description: 'Reclaimable-space suggestions' },
      { name: 'files', description: 'Acting on files (trash, open, preview)' },
      { name: 'offload', description: 'Copy-verify-trash offload to another drive' },
      { name: 'system', description: 'Host, disk and OS trash' },
      { name: 'settings', description: 'Settings, notifications and live watch' },
      { name: 'cloud', description: "The user's own cloud accounts" },
    ],
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Enforced only when the server runs with TREEMAP_TOKEN set; without it the API is open (local default)',
        },
      },
    },
  };
  return cached;
}
