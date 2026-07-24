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

  /* ------------ scanning ------------ */
  {
    method: 'post',
    path: '/api/scan',
    summary: 'Start scanning a directory tree (progress via SSE or polling GET /api/scan/{scanId}/stats)',
    tag: 'scan',
    destructive: false,
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
      '202': jsonResponse('Scan started', obj({ scanId: str(), incremental: bool() }, ['scanId', 'incremental'])),
      '400': errorResponse('Path rejected'),
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
    method: 'post',
    path: '/api/git/gc',
    summary: 'Run git gc in a scanned repository (requires confirm: true)',
    tag: 'insights',
    destructive: true,
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
    summary: 'Smart reclaimable-space suggestions (regenerable dirs, caches, junk), grouped by rule',
    tag: 'cleanup',
    destructive: false,
    parameters: [scanIdQuery],
    responses: {
      '200': jsonResponse('Groups, largest first', obj({ scanId: str(), groups: arr(ref('CleanupSuggestionGroup')) }, ['scanId', 'groups'])),
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
    requestBody: jsonBody(obj({ paths: arr(str(), 'At most 500, each inside a scanned root') }, ['paths'])),
    responses: {
      '200': jsonResponse('Per-path outcome', ref('CleanResult')),
      '403': errorResponse('A path is outside every scanned root, cloud-hosted, or inside an archive'),
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
    responses: { '200': { description: 'Image bytes, or JSON {type: text|meta, …}' }, '403': errorResponse('Outside every scanned root') },
  },

  /* ------------ offload ------------ */
  {
    method: 'post',
    path: '/api/offload',
    summary: 'Copy → verify SHA-256 → only then trash the local originals; any failure rolls back',
    tag: 'offload',
    destructive: true,
    requestBody: jsonBody(
      obj(
        {
          scanId: str('Completed scan the sources belong to'),
          paths: arr(str(), 'Sources inside the scanned root'),
          dest: str('Existing destination folder'),
        },
        ['scanId', 'paths', 'dest'],
      ),
    ),
    responses: {
      '202': jsonResponse('Job started (progress via SSE)', obj({ jobId: str() }, ['jobId'])),
      '400': errorResponse('Bad destination / too many files / not enough space'),
      '403': errorResponse('Sources outside every scanned root'),
    },
  },
  {
    method: 'post',
    path: '/api/offload/restore',
    summary: 'Copy offloaded files back to their original paths, re-verifying the recorded hash',
    tag: 'offload',
    destructive: true,
    requestBody: jsonBody(obj({ ids: arr(str(), 'Offload entry ids, at most 500') }, ['ids'])),
    responses: { '202': jsonResponse('Job started', obj({ jobId: str() }, ['jobId'])), '404': errorResponse('Nothing to restore') },
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
    requestBody: jsonBody(obj({ scanId: str('A cloud scan'), paths: arr(str(), 'cloud:// paths inside that scan') }, ['scanId', 'paths'])),
    responses: { '200': jsonResponse('Outcome', opaque('Per-path provider-trash outcome')), '403': errorResponse('Path outside this cloud scan') },
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
        '{ error, code } JSON. Rate limit: 10 req/s sustained per client (burst 20), 429 when exceeded.',
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
    components: { schemas },
  };
  return cached;
}
