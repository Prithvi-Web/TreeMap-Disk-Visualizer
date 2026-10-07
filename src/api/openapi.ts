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

import { FEATURES, ROUTE_FEATURES, STORAGE_MODES, canBeOff, featuresOf, isOff } from '../services/storageMode';
import { NOT_EMPTY_CODES } from '../services/emptyFolderCheck';

/** Why an "only empty folders" delete left a path where it is (U-4b L4): one code per reason. */
const EMPTY_FOLDER_REFUSAL_CODES: readonly string[] = Object.values(NOT_EMPTY_CODES);

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

/** GET /api/index/tree's answer while the index that holds the folder is being built: the root's record, no tree. */
const indexBuilding202 = jsonResponse(
  'The index that holds this folder is still being built — no tree is read from a partial index; retry when it is ready',
  obj({ status: str("Always 'running'"), root: opaque('The indexed root as it stands: path, state, counters') }, ['status', 'root']),
);

/** GET /api/index/{jobId}/result while its build runs: the body indexRoutes.ts sends, not a scan's. */
const indexRunning202 = jsonResponse(
  'Build still running — retry when it completes',
  obj(
    {
      status: str("Always 'running'"),
      phase: str('enumerating while the files are written as the walk finds them, summing while the folders are written last'),
      processed: int('Rows written so far'),
      currentPath: str(),
    },
    ['status'],
  ),
);

/**
 * The refusals an undo meets in the Time Capsule restore it starts, which check every copy before any
 * is put back: any one refuses the whole undo, nothing put back (F1.17, F1.18).
 */
const UNDO_RESTORE_409 =
  'and, from the restore it starts, which checks every copy before it puts any back: PATH_OCCUPIED (something stands at an item\'s place), ' +
  'PATH_UNREADABLE (an item\'s place could not be looked at), PAYLOAD_GONE, MANIFEST_UNREADABLE, or CAPSULE_RECORD_INVALID (a record ' +
  'with a TreeMap id whose original place or manifest TreeMap would not write) — any of them refuses the whole undo, and nothing is put back';

/** The allocation routes' answer while the index that holds the path is being built (plan U-7): no figure. */
const allocationBuilding202 = jsonResponse(
  'The index that holds this path is still being built — nothing is summed from a partial index; retry when it is ready',
  obj({ status: str("Always 'building'") }, ['status']),
);

/** The allocation routes' answer where TreeMap did not measure what the files occupy (plan U-7, U-Q5). */
const allocationNotMeasured409 = errorResponse(
  'ALLOCATION_NOT_MEASURED — this index holds no measure of what its files occupy (an index built from a scan, or any index on Windows, where a file\'s blocks are not reported): a sentence says so, and no number is sent',
);

/* ------------------------------- schemas ------------------------------- */

const schemas: Json = {
  ApiError: obj(
    { error: str('Human-readable message'), code: str('Stable machine-readable code, e.g. OUTSIDE_SCAN_ROOT; BAD_HOST (403) when the Host header does not name this server') },
    ['error', 'code'],
    'Uniform error body returned by every endpoint',
  ),
  StorageModeError: obj(
    {
      error: str('A sentence naming the feature and the mode, why the feature is off there, and what to do instead'),
      code: str("'STORAGE_MODE'"),
      mode: str("The storage mode the scan is kept in: 'spill' or 'aggregate'"),
      feature: str('The feature refused, by its id in the availability table (src/services/storageMode.ts)'),
    },
    ['error', 'code', 'mode', 'feature'],
    'A feature that is off in the storage mode a very large scan is kept in (Phase 4). Every scan is kept in memory today, where nothing is off.',
  ),
  ScanBoundary: obj(
    {
      scanId: str(),
      rule: nullable({ type: 'string', enum: ['stay', 'cross'], description: 'The boundary rule the scan ran under (Settings: scanBoundary); null for a record made without a boundary (a cloud listing).' }),
      source: nullable({ type: 'string', enum: ['mount', '/proc/mounts', 'none'], description: 'Where the mount table came from: macOS mount, Linux /proc/mounts, or none (Windows keeps no table).' }),
      reason: nullable(str('Why the lists below are unknown (no boundary on the record, or a mount table that could not be read); Windows says why it has no table. Null when everything is known.')),
      notEntered: nullable(obj({ count: int(), examples: arr(str(), 'Up to five paths, sorted') }, ['count', 'examples'], 'Drives mounted inside the folder that the walk reached and did not enter (stay). Null when unknown — never an empty list standing in for unknown.')),
      entered: nullable(obj(
        { count: int(), examples: arr(str(), 'Up to five paths, sorted'), bytes: nullable(int('Logical bytes the scan counted inside the outermost entered drives; null when that total cannot be looked up (spill or aggregate mode, a scan still running), with reason')), reason: str('Present when bytes is null') },
        ['count', 'examples', 'bytes'],
        'The outermost drives the walk entered (cross); a drive inside one is inside its bytes. Null when unknown.',
      )),
      crossedUnlisted: nullable(obj({ count: int(), examples: arr(str(), 'Up to five paths, sorted') }, ['count', 'examples'], 'Folders the built-in walker went into whose device differs from their parent’s and that the mount table did not list — counted, never a reason to stop (only the built-in walker counts them). Null for a record without a boundary.')),
      mountsListed: nullable(int('How many drives the mount table showed mounted beneath the root; null when unknown')),
      mounts: nullable(arr(
        obj(
          {
            path: str('The mount point, spelled as the scan spells it'),
            filesystem: str('e.g. apfs, nullfs, ext4, tmpfs'),
            source: str('What is mounted there: a device, or the folder a nullfs or bind mount shows again'),
            reached: bool('The walk got to the mount point (false under a folder no walk descends into, such as /Volumes for a scan of /, or beneath a refused, unreadable or skipped folder)'),
            entered: bool('The walk went in'),
            bytes: nullable(int('Logical bytes the scan counted inside; null where it did not enter or cannot look the total up')),
            sourceListed: bool('The source is a folder this scan listed (inside its root, not under a folder it never descended into), so a nullfs or bind view of it shows files already counted; false for a device'),
          },
          ['path', 'filesystem', 'source', 'reached', 'entered', 'bytes', 'sourceListed'],
        ),
        'At most 50, sorted by path; null when unknown',
      )),
    },
    ['scanId', 'rule', 'source', 'reason', 'notEntered', 'entered', 'crossedUnlisted', 'mountsListed', 'mounts'],
    'Which drives mounted inside the scanned folder the scan did not enter, or entered (Track U, U-26).',
  ),
  BudgetGauge: obj(
    {
      path: str(), name: str(), maxBytes: int(),
      actualBytes: int('null when the folder is not in this scan — never zero'),
      ratio: num('actualBytes / maxBytes, null when actualBytes is null'),
      projection: obj(
        {
          status: str("'ok' | 'over' | 'insufficient' | 'erratic' | 'stable' | 'shrinking'"),
          reason: str('Always present when status is not ok — the honest refusal, verbatim from the forecast'),
          confidence: num(), bytesPerDay: int(),
          breachInDays: num('Only when status is ok'),
          breachAtMs: int('Only when status is ok'),
          seriesSource: str("'own-scans' | 'ancestor-trees' | 'none'"),
          seriesPoints: int(),
          caveat: str('Present for ancestor-tree series — the approximation, stated'),
        },
        ['status', 'confidence', 'bytesPerDay', 'seriesSource', 'seriesPoints'],
      ),
    },
    ['path', 'name', 'maxBytes', 'actualBytes', 'ratio', 'projection'],
    'A folder budget with its projected breach (v4 §9.4) — the projection reuses the disk-full forecast’s own honesty gates',
  ),
  FolderNote: obj(
    {
      path: str('Sanitized absolute path of the noted folder'),
      text: str('The note text, stored and returned verbatim — the UI renders it as plain text only, never HTML'),
      suppress: bool('When true (the default), Smart Suggestions and Autopilot skip this folder and everything under it'),
      createdMs: int(),
      updatedMs: int(),
    },
    ['path', 'text', 'suppress', 'createdMs', 'updatedMs'],
    'A note pinned to a folder (v4 §9.5)',
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
      engine: str('The engine that produced the scan: native (the native scan core), ntfs-mft (the NTFS turbo mode), gdu-turbo (gdu), walker or turbo-walker (the built-in walker, named turbo-walker when its I/O pool is larger than libuv\'s default 4), or cloud (a connected cloud account\'s listing)'),
      ioThreads: int(),
      durationMs: int(),
      incremental: bool(),
      cachedDirs: int(),
      walkedDirs: int(),
      hardlinkedFiles: int(),
      hardlinkedBytes: int(),
      sparseFiles: int('Files claiming more room than they occupy: sparse files and, on macOS, compressed ones'),
      sparseBytes: int('What those files claim, minus what they occupy. Zero on Windows, where allocation is not reported during a walk'),
      slackBytes: int('The mirror: what small files occupy beyond what they claim, because a disk hands out space in fixed-size pieces'),
      cloudFiles: int(),
      cloudBytes: int(),
      refused: obj(
        {
          dirs: int('Folders the OS would not let the scan list'),
          examples: { type: 'array', items: { type: 'string' }, description: 'Up to five of them, absolute paths, sorted' },
        },
        ['dirs', 'examples'],
      ),
      vanishedDirs: int('Folders that disappeared mid-scan; the results are partial when > 0'),
      expiresAt: int('Epoch ms when the results leave memory; null while running. Every read of the scan pushes it out by 30 minutes'),
      budget: ref('ScanBudget'),
      /* ---- Phase 3 (D6): after budget, in this order ---- */
      engineReason: str('Why this engine ran, in a sentence: the setting, the rule or the probe that chose it; for the legacy engines also that CPU seconds are not measured per scan'),
      fastPath: str('The listing mechanism: bulk / extdDirInfo / getdents / perEntry for the native engine, readdir+lstat for the built-in walker, gdu, cloud; unavailable when the native listing was probed and refused and the legacy chain ran, with the reason in fallbackReason'),
      fallbackReason: nullable(str('Why an engine that was wanted could not run — a missing native module, a refused probe, a failed walk, a missing gdu; null when nothing fell back')),
      entriesPerSecond: nullable(int('scanned ÷ the scan’s own seconds; null while running, and when the duration is zero')),
      cpuSeconds: nullable(num('CPU seconds the engine measured for this scan alone (the native walk’s threads plus the ingest); null where the engine does not measure per scan, with the reason in engineReason')),
      peakRssBytes: nullable(int('Always null: resident memory is a per-process figure and cannot be attributed to one scan')),
      bytesRead: nullable(int('Bytes read from disk for this scan alone; null unless the engine measured them')),
      cacheHitRate: nullable(num('null until Phase 4’s index exists to hit')),
      storageMode: { type: 'string', enum: ['memory'], description: 'Where the tree lives; memory until Phase 4’s spill and aggregate modes' },
      placeholdersSkipped: int('Entries the walk found dataless (a cloud placeholder whose bytes are not local); 0 for the legacy engines, which detect none at walk time'),
    },
    ['scanned', 'fileCount', 'dirCount', 'engine', 'ioThreads', 'durationMs', 'incremental', 'cachedDirs', 'walkedDirs', 'hardlinkedFiles', 'hardlinkedBytes', 'sparseFiles', 'sparseBytes', 'slackBytes', 'cloudFiles', 'cloudBytes', 'refused', 'vanishedDirs', 'expiresAt', 'budget', 'engineReason', 'fastPath', 'fallbackReason', 'entriesPerSecond', 'cpuSeconds', 'peakRssBytes', 'bytesRead', 'cacheHitRate', 'storageMode', 'placeholdersSkipped'],
  ),
  /* ---- the scanning budget (Phase 2) ---- */
  ScanBudget: obj(
    {
      preset: { type: 'string', enum: ['auto', 'eco', 'balanced', 'turbo'], description: 'The setting when the scan started; a scheduled scan records eco whatever the setting says' },
      effective: { type: 'string', enum: ['eco', 'balanced', 'turbo'], description: 'What it started at: auto resolves to turbo for a scan a person started in the TreeMap window (interactive) and to balanced for any other, one step lower on battery and eco when the machine is thermally serious or worse; an interactive scan is held at balanced while an unattended scan runs' },
      source: { type: 'string', enum: ['native', 'node-shim'], description: 'Who held the budget: the native governor, or the best-effort Node shim' },
    },
    ['preset', 'effective', 'source'],
    'The budget a scan ran under, captured when it started',
  ),
  EngineBudgetSetting: obj(
    {
      preset: { type: 'string', enum: ['auto', 'eco', 'balanced', 'turbo'], description: 'auto is turbo while a scan a person started in the TreeMap window runs and no unattended scan does, balanced otherwise; one step lower on battery and eco under heat, when the native governor can tell (without it nothing reads the battery or the heat)' },
      cpuPercent: nullable(int("1–100 replaces the preset's CPU ceiling; null keeps the preset's own")),
    },
    ['preset', 'cpuPercent'],
    'The scanning budget setting (src/services/engineBudget.ts)',
  ),
  EngineMechanism: obj(
    {
      available: bool(),
      mechanism: str('What the platform provides, e.g. pthread_set_qos_class_self_np; "none" when nothing does'),
      reason: nullable(str('Why it is unavailable; null when it is available')),
    },
    ['available', 'mechanism', 'reason'],
    'One OS mechanism the governor can use — the same shape in Rust, native/index.d.ts and here',
  ),
  NativeCoreStatus: obj(
    {
      available: bool(),
      version: nullable(str("The loaded module's version; null when it is not loaded")),
      reason: nullable(str('Why it is not loaded, or why a loaded module is not in force right now (a fault the app retries) — the Node shim\'s rules apply meanwhile; null when it is in force')),
    },
    ['available', 'version', 'reason'],
  ),
  EffectiveBudget: obj(
    {
      preset: { type: 'string', enum: ['eco', 'balanced', 'turbo'] },
      targetShare: num('The share of the whole machine the budget aims for, 0–1'),
      source: { type: 'string', enum: ['native', 'node-shim'] },
    },
    ['preset', 'targetShare', 'source'],
    'What the setting resolves to right now: the native governor\'s own preset and share while it holds the budget',
  ),
  EngineBudgetState: obj(
    {
      setting: ref('EngineBudgetSetting'),
      effective: ref('EffectiveBudget'),
      native: ref('NativeCoreStatus'),
      snapshot: nullable(opaque("The native governor's live snapshot (budget, effective, targetShare, share1s, workers, duty, thermal, onBattery, interacting, paused, ticks, mechanisms); null without the native core — nothing measured, nothing reported")),
      source: { type: 'string', enum: ['native', 'node-shim'], description: 'Who holds the budget right now' },
    },
    ['setting', 'effective', 'native', 'snapshot', 'source'],
  ),
  EngineCapabilities: obj(
    {
      native: ref('NativeCoreStatus'),
      mechanisms: obj(
        {
          qos: ref('EngineMechanism'),
          ioPolicy: ref('EngineMechanism'),
          priority: ref('EngineMechanism'),
          thermal: ref('EngineMechanism'),
          battery: ref('EngineMechanism'),
          interaction: ref('EngineMechanism'),
          machineCpu: ref('EngineMechanism'),
        },
        ['qos', 'ioPolicy', 'priority', 'thermal', 'battery', 'interaction', 'machineCpu'],
        'Each absent with its reason when the native core is not loaded',
      ),
      source: { type: 'string', enum: ['native', 'node-shim'] },
    },
    ['native', 'mechanisms', 'source'],
  ),
  ScanPauseOutcome: obj(
    {
      scanId: str(),
      status: str("The scan record's status: 'running', 'complete' or 'error'"),
      paused: bool('Whether the scan is paused after this call'),
      supported: bool("Whether this scan's engine can be paused on this platform at all"),
      reason: str('Why the scan is not paused or cannot be: present when a pause did not take (the scan had finished, or its engine cannot pause) and when a resume found nothing paused; absent after a pause that took and after a resume that worked'),
      source: { type: 'string', enum: ['native', 'node-shim'] },
    },
    ['scanId', 'status', 'paused', 'supported', 'source'],
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
      usedDisk: int('Bytes the filesystem counts as occupied (blocks − bfree); total − free is larger by the root reserve on ext4'),
      homeDir: str(),
      commonDirs: arr(str()),
    },
    ['platform', 'hostname', 'totalDisk', 'freeDisk', 'usedDisk', 'homeDir', 'commonDirs'],
  ),
  VolumeInfo: obj(
    {
      name: str('The volume name as mounted'),
      path: str('Mount point, e.g. /Volumes/Backup'),
      freeBytes: nullable(int('null when the stats could not be read — see reason')),
      totalBytes: nullable(int()),
      reason: str('Present only when freeBytes/totalBytes are null: why the stats could not be read'),
    },
    ['name', 'path', 'freeBytes', 'totalBytes'],
    'An attached external drive; an unreadable one is still listed, with nulls and a reason, never hidden',
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
  DupeDetailFile: obj(
    {
      name: str('Basename'),
      path: str('Absolute path'),
      size: int('Bytes, from the scanned tree'),
      modifiedAt: int('Unix epoch ms, from the scanned tree'),
      newest: bool('Newest of this group (ties can mark more than one; false on every copy when all are the same age)'),
      largest: bool('Largest of this group (ties can mark more than one; false on every copy when all are the same size, as content-identical copies always are)'),
      isImage: bool(),
      width: nullable(int('Pixels; null with dimensionsReason when unreadable')),
      height: nullable(int()),
      dimensionsReason: nullable(str("Why width/height are null, e.g. 'not an image', 'image decoding unavailable'")),
      captureDate: nullable(str('EXIF DateTimeOriginal as YYYY-MM-DDTHH:MM:SS (local wall-clock, no timezone)')),
      captureDateReason: nullable(str("Why captureDate is null, e.g. 'no capture date recorded'")),
      visualDiff: nullable(
        obj(
          {
            hammingDistance: int('Differing dHash bits vs the reference file, 0–64'),
            differingBlocks: arr(int(), 'Differing bit indices 0–63; bit i = row ⌊i/8⌋, col i%8 of the 8×8 grid'),
            summary: str("The distance in plain terms, e.g. 'differs in 4 of 64 blocks — likely a re-encode of the same image'"),
          },
          ['hammingDistance', 'differingBlocks', 'summary'],
        ),
      ),
      visualDiffReason: nullable(str('Why visualDiff is null (the reference file itself, a non-image, or an undecodable one)')),
    },
    ['name', 'path', 'size', 'modifiedAt', 'newest', 'largest', 'isImage', 'width', 'height', 'dimensionsReason', 'captureDate', 'captureDateReason', 'visualDiff', 'visualDiffReason'],
    'One file of a duplicate group in the side-by-side viewer; every absent fact is null with its reason stated',
  ),
  EmptyFoldersResult: obj(
    {
      folders: arr(obj({ name: str(), path: str() }, ['name', 'path']), 'Topmost recursively-empty dirs. Never a folder the scan did not list in full (refused, unreadable, vanished, never entered, entries left out by a "don\'t scan" pattern or a failed stat), nor one above it; each was looked at again on disk and found still empty'),
      totalCount: int('All empty dirs found, nested included'),
      truncated: bool(),
      withheld: int('Folders the scan saw empty that a second look on disk did not find still empty — they hold something now, could not be read, or did not answer — left out of folders, and their nested ones out of totalCount'),
      withheldBy: {
        type: 'object',
        description: 'How many of withheld were left out for each reason: content (holds something now), unreadable, no-answer (the folder or its drive did not answer, or its drive still held two calls that had not answered, so the folder was not asked), out-of-time (the 10 s TreeMap gives to looking ran out first), too-many (too much to look through), not-a-folder, gone. {} when nothing was withheld',
        additionalProperties: { type: 'integer' },
      },
      reason: str('Present only when the scan cannot offer empty folders at all, and why: a gdu scan shows a folder it could not read as an empty one'),
    },
    ['folders', 'totalCount', 'truncated', 'withheld', 'withheldBy'],
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
      failed: arr(obj({
        path: str(),
        reason: str(),
        stopped: bool('Present (true) when the Trash command was stopped before it answered (its time limit, or a signal on macOS and Linux): the Trash may still finish the move after this answer'),
        refused: bool('Present (true) when TreeMap itself did not hand the path to the Trash (a name Windows would trim, or a folder not shown to be still empty under onlyEmptyFolders): the Trash was never asked'),
        code: {
          type: 'string',
          enum: [...EMPTY_FOLDER_REFUSAL_CODES],
          description: 'Present with refused when onlyEmptyFolders was set and this path was not shown to be still an empty folder at its turn, saying why: FOLDER_NOT_EMPTY (it holds something), FOLDER_UNREADABLE (a folder in it could not be read), FOLDER_NO_ANSWER (it or its drive did not answer in time, or its drive still held two calls that had not answered, so it was not asked), FOLDER_NOT_CHECKED (the 10 s TreeMap gives to looking ran out before its turn ended), FOLDER_TOO_MANY_ENTRIES (too much to look through), NOT_A_FOLDER',
        },
      }, ['path', 'reason'])),
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
  CalendarDay: obj(
    {
      date: str("Local calendar day, 'YYYY-MM-DD', bucketed in the server's timezone (DST-correct)"),
      bytes: int('Total bytes of the files bucketed to this day'),
      count: int('Files bucketed to this day — always at least 1: days nothing landed on are absent, never zero'),
    },
    ['date', 'bytes', 'count'],
    'One day of the activity calendar',
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
      originalPath: str('The path it was deleted by: where it will be put back, unless realPath says where that was'),
      realPath: str('Present when the item was somewhere else on the disk than originalPath reads now — reached through a link, or written in another case: where it is put back, and where an undo looks for it'),
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
      expiredAt: int('Present once the retention window passed and its copy was removed; the record stays, holding nothing, until every record of its run has expired, so an undo names it'),
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
      match: opaque("{ kind: 'suggestion', groupIds[] }, { kind: 'custom', maxAgeMs?, minBytes?, exts[]? }, or { kind: 'query', q } — a v4 §2 query, parsed on save and refused if it has no conditions"),
      maxBytesPerRun: nullable(int('Ceiling on one run; null = uncapped')),
      maxBytesPerWeek: nullable(int('Ceiling across a rolling 7 days; null = uncapped')),
      cooldownDays: int('Minimum days between runs; also acts as the schedule'),
      dryRunFirst: bool('Simulate every run instead of deleting'),
      requireConfirmationAbove: nullable(int('Refuse unattended when the match totals more than this')),
      enabled: bool(),
      approvedAt: int('Set once the mandatory first dry run was approved; until then the policy only simulates'),
      approvedBytes: int('What the approved run matched: the next run may delete up to this much past requireConfirmationAbove, once. Set by approval only; cleared when the folder or match changes'),
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
      unverified: arr(str(), 'Items of skipped whose trash step was not confirmed either way: their copies are kept, and an undo puts each back once its place is empty'),
      undoneAt: int('Set once the run has been undone: an undo\'s restore completed and everything an undo could put back was put back. Never by an undo that failed or was cancelled'),
      scope: obj({ path: str(), match: opaque('The policy\'s match when the run was made') }, ['path', 'match'], 'The folder and match the policy had when this run was made; an approval of the run holds only while the policy still has them. Absent on runs recorded by builds before 5.2.0'),
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
      unverified: arr(str(), 'Paths whose trash step was not confirmed either way — the Trash may have moved them after the answer — named apart from paths, which for a cart commit lists only what was confirmed moved'),
      bytes: nullable(int('Known bytes involved, when the operation can tell')),
      dryRun: bool(),
      outcome: { type: 'string', enum: ['ok', 'refused', 'error'] },
      code: str("Error/refusal code when outcome is not 'ok'"),
    },
    ['at', 'action', 'source', 'tokenId', 'paths', 'bytes', 'dryRun', 'outcome'],
  ),
  JournalEntry: obj(
    {
      at: int('Unix epoch ms — when the change was noticed'),
      rootPath: str('Root of the scheduled scan that noticed the change'),
      path: str('The changed path, as deep as the change could honestly be pinned'),
      delta: int('Signed bytes: positive = grew, negative = shrank'),
      attribution: str('App display name, "you" (a deletion made through TreeMap), or exactly "an unidentified process"'),
      sentence: str('e.g. "Docker added 14.2 GB (~/Library/Containers/com.docker.docker)"'),
    },
    ['at', 'rootPath', 'path', 'delta', 'attribution', 'sentence'],
    'One line of the rolling disk journal (journal.jsonl in the app-data dir, capped and rotated)',
  ),
  TrashDryRunManifest: obj(
    {
      dryRun: bool('Always true'),
      wouldTrash: arr(obj({ path: str(), bytes: nullable(int('null when no scan knows this path')) }, ['path', 'bytes'])),
      totalKnownBytes: int(),
      openHandles: opaque("B2's preflight, always sent: what a program is holding open right now in these paths — a real run refuses 409 OPEN_HANDLE_CONFLICT on any of them unless ignoreOpenHandles: true"),
      notEmpty: arr(
        obj({ path: str(), code: { type: 'string', enum: [...EMPTY_FOLDER_REFUSAL_CODES] }, reason: str() }, ['path', 'code', 'reason']),
        'Present only with onlyEmptyFolders: the paths the real run would leave, because each is not still an empty folder; they are not in wouldTrash',
      ),
    },
    ['dryRun', 'wouldTrash', 'totalKnownBytes', 'openHandles'],
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
      timeCapsuleRetentionDays: int(
        'How long the Time Capsule keeps a copy of what a cart commit deleted, in days: 1-365, default 30. '
          + 'Read live, so lowering it can retire copies captured under the old value at the next sweep.',
      ),
      timeCapsuleMaxPercent: int(
        'The Time Capsule\'s ceiling, as a percentage of its volume\'s usable space: 1-90, default 10. '
          + 'Anything too large to fit is left undeleted and named in skipped[], never deleted unprotected.',
      ),
      cloud: opaque('Per-provider OAuth app credentials (gdrive / dropbox / onedrive)'),
      reclaimWeights: obj(
        {
          size: num(), staleness: num(), regenerable: num(),
          redundant: num(), redownloadable: num(), elsewhere: num(),
        },
        ['size', 'staleness', 'regenerable', 'redundant', 'redownloadable', 'elsewhere'],
        'How much each component counts toward the Reclaim Score, 0-1 each. '
          + 'A weight of 0 removes that component from the score rather than scoring it as worthless. '
          + 'Send null to restore the defaults.',
      ),
      cleanupGoalBytes: nullable(int(
        'Optional target for the cleanup cart, in bytes ("free 50 GB"). '
          + 'null means no target is set, which is the default — the meter simply does not appear. '
          + 'Send null to clear one.',
      )),
      humanScaleUnits: bool(
        'Show "≈ 3,100 photos like the ones here" beside sizes over ~1 GB (v4 §9.3), '
          + 'computed from each folder’s own file mix. Default true; cosmetic only.',
      ),
      tourDone: bool('Whether the guided first run (v4 §9.2) was completed or skipped. Only boolean true counts.'),
      engineBudget: ref('EngineBudgetSetting'),
      engine: {
        type: 'string',
        enum: ['auto', 'native', 'gdu', 'walker', 'ntfs-mft'],
        description: 'The Scan engine (Phase 3): auto picks the native engine when this build has it and the scan is eligible, then gdu, then the built-in walker; the others force one. Default auto. '
          + 'ntfs-mft is the NTFS turbo mode (M6): Windows only — refused with 400 BAD_SETTING on every other platform — and opt-in, never chosen by auto. '
          + 'After Windows asks for administrator permission it runs an elevated, read-only helper that reads the drive’s file table directly. '
          + 'It is used only where no program running as the user could change that helper — TreeMap installed for everyone who uses the computer (Program Files); '
          + 'installed only for one user, or run as a portable copy, the scan falls back and says why. '
          + 'Not verified on this build.',
      },
      scanBoundary: {
        type: 'string',
        enum: ['stay', 'cross'],
        description: 'At a drive mounted inside the folder being scanned (a disk image, the iOS Simulator volumes, a separate /home on Linux): '
          + 'stay ("Stay on this drive", the default) leaves it out — the scan stops at the mount point, which stays as an empty folder, and GET /api/scan/{scanId}/boundary names it; '
          + 'cross ("Include drives mounted inside it") walks into it as well. The drives come from the operating system\'s mount table, never from device ids. '
          + 'Applies from the next scan. A value other than these two is refused with 400 BAD_SETTING; a hand-edited file is read as stay.',
      },
    },
    ['ignore', 'schedules', 'budgets', 'forecastThresholdDays', 'watchIdleMinutes', 'timeCapsuleRetentionDays', 'timeCapsuleMaxPercent', 'cloud', 'reclaimWeights', 'cleanupGoalBytes', 'humanScaleUnits', 'tourDone', 'engineBudget', 'engine', 'scanBoundary'],
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
      '200': jsonResponse(
        'The policy, or — when the file exists and will not parse — `policy: null` with `unreadable: true` and a reason. ' +
          'This endpoint answers in that state ON PURPOSE: every other policy-gated call refuses with POLICY_UNREADABLE, ' +
          'and this is the one that tells a person where the file is.',
        obj(
          {
            policy: ref('AgentPolicy'),
            file: str('Absolute path of agent-policy.json'),
            unreadable: bool('Present and true when the file could not be parsed; `policy` is then null'),
            reason: str('Why it could not be parsed'),
          },
          ['file'],
        ),
      ),
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
          incremental: bool('Ask for a fast rescan (default false). Only the built-in walker does one: it reuses the listings the last scan of this folder saved for every folder whose modified time has not changed, so it can miss an edit inside a file, and its sparse-file, slack and hard-link figures count only the folders it lists afresh. Where the native engine walks the folder the request is not used: it lists the whole folder, faster and exact, and engineReason says so. A request also keeps gdu and the NTFS turbo mode off. The answer\'s incremental says whether saved listings were reused'),
          interactive: bool('A person started this scan in the TreeMap window (default false). Only such a scan may raise an administrator prompt: with the Scan engine setting ntfs-mft, a scan without it lists the folders and says why. And only such a scan runs the Automatic budget at turbo; under Automatic any other never runs above balanced, and holds a person\'s scan at balanced while it runs. The server cannot check the claim, so an agent must leave it out'),
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
    method: 'post',
    path: '/api/scan/{scanId}/cancel',
    summary: 'Stop a running scan — the walker halts and a gdu subprocess is killed; cancelled:false means it had already settled',
    tag: 'scan',
    destructive: false,
    parameters: [pathParam('scanId', 'Scan id')],
    responses: {
      '200': jsonResponse(
        'The scan record after the request',
        obj({ scanId: str(), cancelled: bool('False when the scan had already finished or failed'), status: str("'error' once cancelled") }, ['scanId', 'cancelled', 'status']),
      ),
      '404': errorResponse('Unknown scanId'),
    },
  },
  {
    method: 'get',
    path: '/api/scan/{scanId}/progress',
    summary: "SSE progress stream: frames of type 'progress' (the unchanged frame repeats about every 2 s as a heartbeat while the count stands still), then one 'complete' (the tree pruned as /result's + stats) or 'error'",
    tag: 'scan',
    destructive: false,
    parameters: [pathParam('scanId', 'Scan id')],
    responses: { '200': sseResponse('ScanEvent frames'), '404': errorResponse('Unknown scanId') },
  },
  {
    method: 'get',
    path: '/api/scan/{scanId}/result',
    summary: "The completed scan: counters plus the tree pruned to an exact 250k-node budget — a folder whose children would pass it comes back pruned (open it with /subtree), the scanned folder's own children excepted (a non-additive change of 2 Oct 2026, approved by the owner as U-Q6)",
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
            sparseFiles: int(),
            sparseBytes: int(),
            slackBytes: int(),
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
    path: '/api/scan/{scanId}/boundary',
    summary: 'Which drives mounted inside the scanned folder the scan did not enter ("Stay on this drive", the default) or entered ("Include drives mounted inside it"), from the mount table read when it started; unknown is null with the reason',
    tag: 'scan',
    destructive: false,
    parameters: [pathParam('scanId', 'Scan id')],
    responses: {
      '200': jsonResponse('The scan boundary', ref('ScanBoundary')),
      '404': errorResponse('SCAN_NOT_FOUND — unknown or expired scanId'),
    },
  },
  {
    method: 'get',
    path: '/api/scan/{scanId}/budget-gauges',
    summary: 'The budgets above plus a projected breach date each (v4 §9.4) — refusals (too little history, erratic, shrinking) carry the forecast’s own reasons instead of invented dates',
    tag: 'scan',
    destructive: false,
    parameters: [pathParam('scanId', 'Scan id')],
    responses: {
      '200': jsonResponse('Budget gauges', obj({ scanId: str(), gauges: arr(ref('BudgetGauge')) }, ['scanId', 'gauges'])),
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
    path: '/api/scan/{scanId}/calendar',
    summary: 'Per-local-day file activity for a contributions-style calendar; ?channel=created adds creation dates behind a capped stat pass',
    tag: 'scan',
    destructive: false,
    parameters: [
      pathParam('scanId', 'Scan id'),
      queryParam('channel', "'modified' (default; that channel is always returned) or 'created' — adds a second channel from per-file birthtime reads, capped and reported in degraded"),
    ],
    responses: {
      '200': jsonResponse(
        'Day aggregates, ascending by date; only days at least one counted file landed on appear',
        obj(
          {
            scanId: str(),
            rootPath: str(),
            modified: arr(ref('CalendarDay'), 'Every file in the scan, bucketed by mtime — read from the tree, exact'),
            created: arr(ref('CalendarDay'), 'channel=created only. Files past the stat cap, unreadable, or with no recorded creation time are excluded and reported in degraded — never bucketed to 1970 or a zero day'),
            degraded: arr(
              obj({ provider: str(), reason: str('Plain-prose reason') }, ['provider', 'reason']),
              'What the created channel could not read; empty when nothing was withheld',
            ),
          },
          ['scanId', 'rootPath', 'modified', 'degraded'],
        ),
      ),
      '202': running202,
      '400': errorResponse('BAD_CHANNEL — channel must be "modified" or "created"'),
      '404': errorResponse('Unknown scanId'),
      '500': errorResponse('Scan failed'),
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
    responses: { '200': jsonResponse('Largest folders', obj({ folders: arr(ref('LargeFolder')) }, ['folders'])), '202': running202 },
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
            notHashed: obj(
              {
                files: int('Cloud placeholders at or above minSize, left unopened: opening one downloads it'),
                bytes: int('Their size as the cloud reports it'),
                largest: arr(obj({ path: str(), size: int() }, ['path', 'size']), 'The largest 20, biggest first'),
              },
              ['files', 'bytes', 'largest'],
            ),
            tookMs: int(),
          },
          ['status', 'scanId', 'minSize', 'groups', 'groupCount', 'totalReclaimable', 'notHashed', 'tookMs'],
        ),
      ),
      '202': jsonResponse(
        'Hashing in progress',
        obj(
          {
            status: str("'running'"),
            phase: str("Which pass hashed/toHash count: 'sizes' (grouping by size, nothing read yet), 'partial' (the first 64 KiB of every same-size candidate) or 'full' (whole files whose first 64 KiB matched; counts again from zero)"),
            hashed: int(),
            toHash: int(),
          },
          ['status', 'phase', 'hashed', 'toHash'],
        ),
      ),
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
      '200': jsonResponse('Clusters', opaque('status, scanId, threshold, available, decoder, reason? (with available false, why — no decoder, no image confirmed on this disk, or no image readable; with available true, how many images were not compared because nobody could confirm their data is on this disk, and how many because they are online-only), clusters[], clusterCount, totalReclaimable, truncated (more images than the 8,000-image cap; set on an unavailable answer too), compared (images fingerprinted and compared), unreadable (images the decoder could not read — not compared, never dropped silently), unreadableTypes[] ({ extension, count }, most first), tookMs')),
      '202': jsonResponse('Hashing in progress', obj({ status: str("'running'"), hashed: int(), toHash: int() }, ['status', 'hashed', 'toHash'])),
    },
  },
  {
    method: 'get',
    path: '/api/duplicates/detail',
    summary:
      'Side-by-side facts for one duplicate pair/group: scanned-tree metadata, image dimensions and EXIF capture date where readable, the dHash diff against the recommended keep, and which file to keep with the rule that picked it stated',
    tag: 'insights',
    destructive: false,
    parameters: [
      scanIdQuery,
      queryParam('paths', '2–8 file paths, each individually URL-encoded, joined by commas; every path must be a file in this scan', str(), true),
    ],
    responses: {
      '200': jsonResponse(
        'The group; every absent fact is null with its reason',
        obj(
          {
            scanId: str(),
            files: arr(ref('DupeDetailFile'), 'In request order'),
            recommendedKeep: obj(
              { index: int('Index into files'), reason: str('Which rule fired, in plain terms') },
              ['index', 'reason'],
            ),
            diffReference: nullable(int('Index of the file the dHash diffs are measured against; null when nothing could be fingerprinted')),
          },
          ['scanId', 'files', 'recommendedKeep', 'diffReference'],
        ),
      ),
      '400': errorResponse('Fewer than 2 or more than 8 paths, or a folder among them'),
      '404': errorResponse('Unknown scanId, or a path not in this scan'),
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
    summary: 'Topmost recursively-empty directories: only folders the scan listed in full, each looked at again on disk (withheld counts the ones left out); none from a gdu scan (reason)',
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
      '409': errorResponse('BOUNDARY_CHANGED — the two scans stopped at different drives mounted inside the folder (one under "Stay on this drive" left a drive out that the other did not, or one went into a drive the other did not find), so a diff would show a drive as files added or removed'),
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
    path: '/api/missing-gigabytes',
    summary:
      "One accounting statement for the volume the scan lives on: every line is bytes, the lines sum to the volume's used space exactly, and whatever is left over is its own `unaccounted` line rather than being hidden in the others",
    tag: 'insights',
    destructive: false,
    parameters: [scanIdQuery],
    responses: {
      '200': jsonResponse(
        'The statement',
        obj(
          {
            scanId: str(),
            rootPath: str(),
            volume: obj(
              {
                mountPoint: str(),
                totalBytes: num(),
                usedBytes: num(),
                freeBytes: num(),
                mechanism: str('How the figure was obtained, for the footnote'),
                mechanismLabel: str('The same fact in the user’s words, with no call name and no mount path'),
                reservedBytes: num('Blocks only the system may use (ext4’s 5% reserve): total − used − free. Zero on APFS and Windows. used + free + reservedBytes === totalBytes.'),
              },
              ['mountPoint', 'totalBytes', 'usedBytes', 'freeBytes', 'mechanism', 'mechanismLabel', 'reservedBytes'],
            ),
            lines: arr(
              obj(
                {
                  id: str("One of: scanned, cloudPlaceholders, sparseFiles, snapshots, purgeable, openHandles, otherVolumes, mountedInside, unscannable, unaccounted. mountedInside (Track U): drives mounted inside the scanned folder — 0 when the scan stayed out of them (Stay on this drive), null with the reason when it went in (their logical total is in the detail; it is never subtracted) or could not tell"),
                  label: str(),
                  bytes: nullable(
                    num(
                      'Signed — negative for a correction. NULL means unknown and must never be rendered as 0; a line that is genuinely zero carries 0.',
                    ),
                  ),
                  available: bool(),
                  reason: str('Present only when available is false. Show verbatim.'),
                  detail: str(),
                  count: nullable(num()),
                  notes: arr(str(), 'Facts belonging to this line but outside the arithmetic'),
                  remedy: nullable(opaque('An existing, already-gated action; never a second path to one')),
                },
                ['id', 'label', 'bytes', 'available', 'detail', 'count', 'notes', 'remedy'],
              ),
            ),
            unaccountedBytes: num('Signed. Negative means TreeMap counted more than the volume holds, which shared storage produces.'),
            coversWholeVolume: bool('False when the scan started inside the volume rather than at it'),
            caveats: arr(str()),
            generatedAt: num(),
          },
          ['scanId', 'rootPath', 'volume', 'lines', 'unaccountedBytes', 'coversWholeVolume', 'caveats', 'generatedAt'],
        ),
      ),
      '404': errorResponse('Unknown scanId'),
      '409': errorResponse('The scan is still running, or the disk layout cannot be read on this system'),
    },
  },
  {
    method: 'get',
    path: '/api/compression/candidates',
    summary: 'Large video in an older codec that HEVC would store in less space, with ESTIMATED savings',
    tag: 'insights',
    destructive: false,
    parameters: [scanIdQuery, queryParam('limit', 'How many files to probe, 1–200 (default 60)', int())],
    responses: {
      '200': jsonResponse(
        'Candidates, or an honest reason the feature is unavailable',
        obj(
          {
            scanId: str(),
            available: bool('false when ffmpeg or a hardware encoder is missing — the reason says which'),
            reason: str(),
            encoder: nullable(str('The hardware encoder that would be used, e.g. hevc_videotoolbox')),
            hardwareCodecs: arr(str(), 'Codecs with genuine hardware ENCODE support — decode-only never counts'),
            candidates: arr(opaque('path, name, size, codec, width, height, durationSeconds, estimatedBytes, estimatedSaving, reason')),
            totalSaving: int('Sum of the estimates — an estimate, not a promise'),
            shortlisted: int('Large video files looked at, biggest first (up to `limit`)'),
            unreadable: int('Of those, how many could not be read as video — not judged, so never counted as already efficient'),
          },
          ['scanId', 'available', 'candidates'],
        ),
      ),
    },
  },
  {
    method: 'post',
    path: '/api/compression/encode',
    summary: 'Re-encode video to HEVC: encode beside the original, verify it, trash the original, promote the new file. LOSSY.',
    tag: 'insights',
    destructive: true,
    parameters: [idempotencyHeader],
    requestBody: jsonBody(obj({ paths: arr(str(), 'Files inside a scanned root'), confirm: bool('Must be true') }, ['paths', 'confirm'])),
    responses: {
      '202': jsonResponse('Started', obj({ jobId: str(), total: int(), encoder: str() }, ['jobId', 'total'])),
      '403': errorResponse('Outside every scanned root'),
      '503': errorResponse('No ffmpeg, or no hardware encoder'),
    },
  },
  {
    method: 'get',
    path: '/api/compression/{jobId}/progress',
    summary: 'Server-sent progress for an encode job',
    tag: 'insights',
    destructive: false,
    parameters: [pathParam('jobId', 'Job id from the encode call')],
    responses: { '200': { description: 'text/event-stream of progress then complete frames' }, '404': errorResponse('No such job') },
  },
  {
    method: 'get',
    path: '/api/compression/{jobId}/result',
    summary: 'The same answer as the stream, for pollers',
    tag: 'insights',
    destructive: false,
    parameters: [pathParam('jobId', 'Job id from the encode call')],
    responses: { '200': jsonResponse('Job', opaque('status, done, total, results[], savedBytes')), '404': errorResponse('No such job') },
  },
  {
    method: 'post',
    path: '/api/compression/{jobId}/cancel',
    summary: 'Stop before the NEXT file — the one encoding finishes its own verify cycle',
    tag: 'insights',
    destructive: false,
    parameters: [pathParam('jobId', 'Job id from the encode call')],
    responses: { '200': jsonResponse('Cancelled', obj({ cancelled: bool() }, ['cancelled'])) },
  },
  {
    method: 'get',
    path: '/api/cost/estimate',
    summary: 'What the scanned data would cost on each cloud provider, and what cleaning up would save — against a table that ships with the app, never fetched',
    tag: 'insights',
    destructive: false,
    parameters: [
      scanIdQuery,
      queryParam('freeable', 'Bytes the user is considering removing, for the what-if', int()),
      queryParam('currency', 'USD (default), EUR, GBP, INR, AUD or CAD', { type: 'string' }),
    ],
    responses: {
      '200': jsonResponse(
        'Per-provider tier fit and saving',
        obj(
          {
            scanId: str(),
            asOf: str('The date every price was read from the provider — show it, so a stale price is visible as stale'),
            currency: str(),
            symbol: str(),
            approximate: bool('true for every currency but USD: conversions are approximations, not live rates'),
            rateFromUsd: { type: 'number' },
            providerCount: int(),
            providers: arr(opaque('providerId, providerName, source, current tier fit, afterCleanup, monthlySavingUsd, annualSavingUsd')),
          },
          ['scanId', 'asOf', 'currency', 'providers'],
        ),
      ),
    },
  },
  {
    method: 'get',
    path: '/api/cost/pricing',
    summary: 'The shipped pricing table itself, with the date it was recorded',
    tag: 'insights',
    destructive: false,
    responses: { '200': jsonResponse('Pricing', obj({ asOf: str(), providers: arr(opaque('id, name, source, tiers[]')) }, ['asOf', 'providers'])) },
  },
  {
    method: 'get',
    path: '/api/health/smart',
    summary: "Drive SMART attributes reported verbatim, plus which runs out first — space or write endurance",
    tag: 'insights',
    destructive: false,
    parameters: [
      queryParam('device', 'Raw device path, e.g. /dev/disk0', { type: 'string' }),
      queryParam('scanId', 'Completed scan, to include its growth forecast', { type: 'string' }),
    ],
    responses: {
      '200': jsonResponse(
        'Health, or an explicit can’t-know with the reason',
        obj(
          {
            available: bool('false when SMART cannot be read — the reason says why, and how to fix it'),
            reason: str(),
            mechanism: str(),
            devicePath: nullable(str()),
            smart: nullable(opaque('modelName, percentageUsed, powerOnHours, reallocatedSectors, selfAssessmentPassed, temperatureCelsius, attributes[] — all verbatim from the device')),
            forecast: nullable(opaque('The existing growth forecast for the scanned root')),
            outlook: nullable(opaque('spaceFullInDays, wearExhaustedInDays, firstLimit, summary')),
          },
          ['available', 'mechanism'],
        ),
      ),
    },
  },
  {
    method: 'get',
    path: '/api/provenance',
    summary: 'Where one file came from: origin URL and host, download date, and last-opened time',
    tag: 'insights',
    destructive: false,
    parameters: [queryParam('path', 'File inside a scanned root', { type: 'string' }, true)],
    responses: {
      '200': jsonResponse(
        'Origin, or an honest statement that nothing was recorded',
        obj(
          {
            path: str(),
            supported: bool('false when this OS cannot read provenance at all'),
            unsupportedReason: str(),
            found: bool('false when the OS records nothing for this file'),
            url: nullable(str('UNTRUSTED input — never fetch it, always escape it')),
            host: nullable(str()),
            referrer: nullable(str()),
            downloadedAt: nullable(int('Unix epoch milliseconds')),
            mechanism: nullable(str('Which OS record answered')),
            lastOpenedAt: nullable(int()),
            absentReason: str('Why nothing was recorded, when nothing was'),
          },
          ['path', 'supported', 'found'],
        ),
      ),
      '403': errorResponse('Outside every scanned root'),
    },
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
            findings: arr(opaque('patternId, label, why, severity, path, name, size, modifiedAt, reason, suggestedPath, exposed, appOwned')),
            counts: opaque('high, medium and low finding counts, over every finding (not only the listed ones)'),
            total: int('How many findings there are in all; more than findings.length once the cap bites'),
            truncated: bool('true when there are more than 500 findings: the 500 most serious are listed'),
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
      '400': errorResponse('PATH_REQUIRED, PATH_INVALID or PATH_BLOCKED for the path; CONFIRM_REQUIRED without confirm: true; DEST_REQUIRED without a "to"'),
      '403': errorResponse('OUTSIDE_SCAN_ROOT for either end; SPILL_PATH, or APP_DATA_PATH for the destination; SAFETY_RECORD for the agent policy or the audit log, which are never moved; POLICY_ROOT_NOT_ALLOWED or POLICY_PROTECTED_PATH from agent-policy.json'),
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
    path: '/api/media',
    summary:
      'Media libraries (Photos, Final Cut Pro, iMovie, Lightroom, Capture One) split into originals, derivatives and database — only derivatives are ever removable, and a library held open by its app offers nothing',
    tag: 'insights',
    destructive: false,
    parameters: [scanIdQuery],
    responses: {
      '200': jsonResponse(
        'Libraries, largest first',
        obj(
          {
            scanId: str(),
            libraries: arr(
              opaque(
                'app, appName, name, path, totalBytes, recognised (false ⇒ size-only with a reason), components[] (kind: originals|derivatives|database, label, path, bytes, removable? on derivatives only, regenerationCost prose), originalsBytes, derivativesBytes, databaseBytes, originalsOutside? (Lightroom), inUse (checked/complete/held?/processNames/reason)',
              ),
            ),
            totalBytes: int(),
            derivativesBytes: int('Regenerable derivatives across recognised libraries — all that is ever offered'),
            libraryCount: int(),
            recognisedCount: int('Libraries whose layout was recognised; the rest report total size only'),
          },
          ['scanId', 'libraries', 'totalBytes', 'derivativesBytes', 'libraryCount', 'recognisedCount'],
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
    summary: "Run git gc --aggressive --prune=2.weeks.ago in a scanned repository (requires confirm: true); refused, with the reason, when its .git is a file or link, shares objects (commondir) or borrows them (objects/info/alternates), holds a link or special file, or its settings could start a program",
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
    responses: { '200': jsonResponse('History', opaque('{roots[]} | {rootPath, snapshots[]} | {snapshots[]}. A snapshot carries boundary — { rule: "stay", notEntered[] } or { rule: "cross", entered[] } — only when a drive was mounted inside its folder (Track U); history never compares across two different boundaries')) },
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
      '200': jsonResponse(
        'Historical layout. prevTakenAt and every prevSize are absent (null) when no earlier snapshot exists, or when the one before stopped at different drives mounted inside the folder (Track U, U-24)',
        opaque('snapshot, prevTakenAt, root, scanRootPath, maxDepth, minSize, nodes[], tree'),
      ),
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
    responses: {
      '200': jsonResponse('Diff', opaque('SnapshotDiff: a, b, rootPath, totalDelta, entries[]')),
      '404': errorResponse('Unknown snapshot id'),
      '409': errorResponse('BOUNDARY_CHANGED — the two snapshots stopped at different drives mounted inside the folder, so a diff would show a drive as files added or removed'),
    },
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
  {
    method: 'get',
    path: '/api/journal',
    summary: 'The rolling journal of significant disk changes (journal.jsonl, capped and rotated), newest first — written by scheduled scans, read-only over HTTP',
    tag: 'history',
    destructive: false,
    parameters: [queryParam('limit', '1–1000 (default 100)', int())],
    responses: { '200': jsonResponse('Journal entries', obj({ entries: arr(ref('JournalEntry')) }, ['entries'])) },
  },

  /* ------------ notes (v4 §9.5) ------------ */
  {
    method: 'get',
    path: '/api/notes',
    summary: 'Notes pinned to folders. A suppressing note excludes its whole subtree from Smart Suggestions and Autopilot matching',
    tag: 'notes',
    destructive: false,
    responses: { '200': jsonResponse('Every folder note', obj({ notes: arr(ref('FolderNote')) }, ['notes'])) },
  },
  {
    method: 'put',
    path: '/api/notes',
    summary: 'Create or update the note on one folder — text is stored verbatim; suppress defaults to true on create and is kept on update when omitted',
    tag: 'notes',
    destructive: true,
    requestBody: jsonBody(obj(
      {
        path: str('The folder to note (sanitized, not required to be inside a scanned root — notes outlive scans, like budgets)'),
        text: str('Up to 2000 characters, stored verbatim'),
        suppress: bool('Pause Smart Suggestions and Autopilot for this subtree'),
      },
      ['path', 'text'],
    )),
    responses: { '200': jsonResponse('The stored note', obj({ note: ref('FolderNote') }, ['note'])) },
  },
  {
    method: 'delete',
    path: '/api/notes',
    summary: 'Remove one folder note',
    tag: 'notes',
    destructive: true,
    parameters: [queryParam('path', 'The noted folder', str())],
    responses: { '200': jsonResponse('Whether a note existed there', obj({ ok: bool(), existed: bool() }, ['ok', 'existed'])) },
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
          ignoreJunk: bool('With onlyEmptyFolders only: the junk rule the list was made with (GET /api/empty-folders?ignoreJunk=) — OS junk such as .DS_Store is not content. True when left out'),
          onlyEmptyFolders: bool('true = every path was offered as an empty folder (GET /api/empty-folders): each is looked at again right before its own Trash step, and one that is not still an empty folder (OS junk such as .DS_Store aside) is left where it is, failed with refused and the code that says why (CleanResult.failed[].code); a drive that does not answer is asked once, and the looks of one request stop after 10 s'),
        },
        ['paths'],
      ),
    ),
    responses: {
      '200': jsonResponse('Per-path outcome, or the dry-run manifest', { oneOf: [ref('CleanResult'), ref('TrashDryRunManifest')] }),
      '400': errorResponse('ONLY_EMPTY_FOLDERS_INVALID — onlyEmptyFolders is present and not a boolean; IGNORE_JUNK_INVALID — ignoreJunk is not a boolean, or is sent without onlyEmptyFolders: true'),
      '403': errorResponse('A path is outside every scanned root, cloud-hosted, inside an archive, or refused by agent-policy.json; SAFETY_RECORD for the agent policy or the audit log, or a folder that holds them (app-data, a folder above it), or a link TreeMap reaches app-data through (or a folder holding one), which no request removes or moves'),
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
    method: 'get',
    path: '/api/volumes',
    summary:
      'Attached external drives with free/total bytes — destinations for the offload dock, sorted by name; a drive whose stats cannot be read is listed with nulls and a reason, never hidden',
    tag: 'offload',
    destructive: false,
    responses: { '200': jsonResponse('Volumes, sorted by name', obj({ volumes: arr(ref('VolumeInfo')) }, ['volumes'])) },
  },
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
      '400': errorResponse('Bad destination / too many files / not enough space (DEST_FULL), or DEST_SPACE_UNKNOWN when the destination\u2019s free space could not be read at all — the drive may be disconnected or busy, and no offload was started. DEST_INSIDE_SOURCE / SOURCE_INSIDE_DEST when the destination lies in the selection or the selection in the destination, judged where each really is; LINK_IN_SELECTION when a selected path is or holds a link, which a copy would follow'),
      '403': errorResponse('Sources outside every scanned root, or refused by agent-policy.json; SAFETY_RECORD for the agent policy or the audit log, or a folder that holds them, or a link TreeMap reaches app-data through'),
      '409': errorResponse('OPEN_HANDLE_CONFLICT — a program holds one of the sources open; or OFFLOAD_NOT_FULLY_LISTED — a selected folder holds something the scan did not list (a "Don\'t scan" match, a folder it could not read, a drive it did not enter, something made since), which the trash step would take with no copy: refused before anything is copied, a dry run too, naming the first such entry'),
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
            refused: arr(opaque('{ id, name, originalPath, reason } — a record the real run would refuse before writing (not of the shape TreeMap writes, into app-data or the spill folder, or its copy outside its destination), and why; its fields as the record holds them')),
            bytesTotal: int(),
          },
          ['dryRun', 'wouldRestore', 'refused', 'bytesTotal'],
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
    responses: {
      '200': jsonResponse('Revealed', obj({ revealed: str() }, ['revealed'])),
      '400': errorResponse('ID_REQUIRED — the body has no "id"'),
      '403': errorResponse('OUTSIDE_DEST_ROOT — the record names a place outside its own destination, both resolved, so nothing was revealed'),
      '404': errorResponse('ENTRY_NOT_FOUND — unknown entry'),
    },
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
            dirs: arr(obj({ name: str(), path: str(), isHidden: bool() }, ['name', 'path', 'isHidden']),
              'At most 500 subfolders, the first 500 in the order the picker shows them: ordinary folders first, then dot-folders, each by name. Links are not listed.'),
            total: int('How many subfolders there are; more than dirs holds when the list was cut at 500'),
          },
          ['path', 'parent', 'dirs', 'total'],
        ),
      ),
    },
  },

  /* ------------ settings & watch ------------ */
  {
    method: 'get',
    path: '/api/settings',
    summary: 'User settings: ignore list, schedules, budgets, thresholds, cloud credentials, Reclaim Score weights',
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
    requestBody: jsonBody(opaque('Any subset of AppSettings: ignore, schedules, budgets, forecastThresholdDays, watchIdleMinutes, timeCapsuleRetentionDays, timeCapsuleMaxPercent, cloud, reclaimWeights, cleanupGoalBytes, humanScaleUnits, tourDone, engineBudget, engine, scanBoundary')),
    responses: { '200': jsonResponse('Updated settings', ref('AppSettings')), '400': errorResponse('Bad shape; BAD_SETTING when engine is not one of auto, native, gdu, walker, ntfs-mft — ntfs-mft only on Windows — or scanBoundary is not stay or cross'), '403': errorResponse('POLICY_ROOT_NOT_ALLOWED — a new schedule\'s folder is outside agent-policy.json\'s allowedRoots (one saved earlier is kept, and refused by the scheduler each time it falls due)') },
  },
  /* ------------ the scanning budget (Phase 2) ------------ */
  {
    method: 'get',
    path: '/api/engine/capabilities',
    summary: "The native core's status and the seven OS mechanisms it can use on this machine — each named, or absent with the reason",
    tag: 'engine',
    destructive: false,
    responses: { '200': jsonResponse('Mechanisms', ref('EngineCapabilities')) },
  },
  {
    method: 'get',
    path: '/api/engine/budget',
    summary: "The scanning budget: the setting, what it resolves to right now, who holds it (native governor or Node shim), and the governor's snapshot",
    tag: 'engine',
    destructive: false,
    responses: { '200': jsonResponse('The budget', ref('EngineBudgetState')) },
  },
  {
    method: 'put',
    path: '/api/engine/budget',
    summary: 'Change the scanning budget — running scans follow at their next batch; the same setting PUT /api/settings writes as engineBudget',
    tag: 'engine',
    destructive: true,
    requestBody: jsonBody(
      obj(
        {
          preset: { type: 'string', enum: ['auto', 'eco', 'balanced', 'turbo'] },
          cpuPercent: nullable(int("1–100 replaces the preset's CPU ceiling; null keeps the preset's own")),
        },
        undefined,
        'Either key or both; an omitted key keeps its value',
      ),
    ),
    responses: {
      '200': jsonResponse('The budget after the change', ref('EngineBudgetState')),
      '400': errorResponse('BAD_SETTING: not one of the four presets, cpuPercent outside 1–100, or a key that is neither'),
    },
  },
  {
    method: 'post',
    path: '/api/scan/{scanId}/pause',
    summary: 'Pause a running scan: a native walk\'s workers stop at their next check, the built-in walker within a batch, and a gdu shard is stopped in place; an NTFS turbo read or a cloud listing cannot be paused, and the answer says why',
    tag: 'scan',
    destructive: false,
    parameters: [pathParam('scanId', 'Scan id')],
    responses: {
      '200': jsonResponse("The scan's pause state after the request", ref('ScanPauseOutcome')),
      '404': errorResponse('Unknown scanId'),
    },
  },
  {
    method: 'post',
    path: '/api/scan/{scanId}/resume',
    summary: 'Resume a paused scan',
    tag: 'scan',
    destructive: false,
    parameters: [pathParam('scanId', 'Scan id')],
    responses: {
      '200': jsonResponse("The scan's pause state after the request", ref('ScanPauseOutcome')),
      '404': errorResponse('Unknown scanId'),
    },
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
    summary: 'SSE live disk activity for a completed scan. The init frame carries "watchers": 0 with a "reason" when nothing on this folder could be watched, which is different from a quiet disk',
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
    summary: 'Build (or rebuild) the persistent index for a folder — progress via SSE. Honours the scanBoundary setting as a scan does: under stay, a drive mounted inside the folder is left out',
    tag: 'index',
    destructive: false,
    requestBody: jsonBody(obj({
      path: str('Absolute folder path. Without maxEntries the build replaces the folder\'s saved index at its start: cancelled or failed, it leaves the folder with no index'),
      maxEntries: int(
        'Optional cap, a positive integer: past this many entries the walk stops, nothing it wrote is kept, the folder\'s saved index (if any) is left exactly as it was, the stop is remembered (GET /api/index/status?path=\'s stoppedAtCap) and the job ends cancelled with a sentence (GET /result answers 409 INDEX_CAP_REACHED). The page sends GET /api/index/status\'s autoBuild.maxEntries with every build it starts on its own',
      ),
    }, ['path'])),
    responses: {
      '202': jsonResponse(
        'Build started. A request for a folder already being built joins that build when its cap is no tighter (none covers any): alreadyRunning is then true and maxEntries is the cap it joined (null for none). A cancelled build is never joined. Otherwise it joins the one job waiting behind that build, whose cap is widened to its own (alreadyRunning true, maxEntries the widened cap), or, with none waiting, gets a job of its own, which starts once that build has settled and, if that build completed, answers with its index',
        obj({ jobId: str(), status: str("'running'"), alreadyRunning: bool(), maxEntries: nullable(int()) }, ['jobId']),
      ),
      '400': errorResponse('MAX_ENTRIES_INVALID — maxEntries is not a positive integer'),
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
    responses: { '200': sseResponse('progress / complete / error / shutdown frames. A progress frame\'s processed is the rows written so far, and moves with every write of at most 500 rows: phase enumerating while the files are written as the walk finds them, summing while the folders are written last, each with its total. An error frame for a build stopped at its cap also carries code INDEX_CAP_REACHED and maxEntries') },
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
      '202': indexRunning202,
      '404': errorResponse('JOB_NOT_FOUND'),
      '409': errorResponse('INDEX_CAP_REACHED — the build stopped at its maxEntries (carried in the body): the folder holds more than it may write. Nothing failed; the saved index, if any, is as it was'),
      '500': errorResponse('INDEX_BUILD_FAILED — the build failed or was cancelled. A folder that is gone or cannot be listed is refused with a sentence before anything is written, and its saved index is kept'),
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
    responses: {
      '200': jsonResponse(
        'Index status',
        opaque(
          '{ roots[], dbPath, dbBytes, autoBuild } or, with ?path=, { path, indexed, root, running[], autoBuild, stoppedAtCap }. autoBuild is { maxEntries }: the most items a folder may hold for TreeMap to index it on its own after a scan. stoppedAtCap is { maxEntries, at, reason } when the last capped build of exactly that folder stopped at its cap (kept until a build of it completes or its index is deleted), else null. A root is current when state is ready and live is true. A link inside an indexed folder, or a folder indexed under a link\'s own path, answers indexed false and root null: the index holds the link itself, not the folder it points to, so scan it to see that folder',
        ),
      ),
    },
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
      '202': indexBuilding202,
      '404': errorResponse(
        'INDEX_NOT_BUILT — that folder has not been indexed yet; PATH_NOT_FOUND — the path is not in the index, or it is a link the index holds as the link itself (scan it to see the folder it points to)',
      ),
      '500': errorResponse('INDEX_BUILD_FAILED — the build of the index that holds this folder failed'),
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
    summary: 'Drop one indexed root (?path=) or the whole index — nothing on disk is touched. Every build of what is dropped, running or waiting, is cancelled first; removed counts folders\' indexes only',
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
        opaque('hits[], total, countCapped, truncated, tookMs, roots[], staleRoots[]. Only ready and stale roots are searched: a root still being built, or one whose build failed, gives no hit and is not counted'),
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
      '202': allocationBuilding202,
      '404': errorResponse('INDEX_NOT_BUILT — scan the folder once first'),
      '409': allocationNotMeasured409,
      '500': errorResponse('INDEX_BUILD_FAILED — the build of the index that holds this folder failed'),
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
      '202': allocationBuilding202,
      '404': errorResponse('INDEX_NOT_BUILT or PATH_NOT_FOUND'),
      '409': allocationNotMeasured409,
      '500': errorResponse('INDEX_BUILD_FAILED — the build of the index that holds this file failed'),
    },
  },

  {
    method: 'get',
    path: '/api/fleet',
    summary: 'LAN fleet view: the switch, what would be shared, what never is, and the machines found so far. OFF by default.',
    tag: 'platform',
    destructive: false,
    responses: {
      '200': jsonResponse(
        'Fleet state',
        obj(
          {
            enabled: bool('false by default — nothing listens or advertises until turned on'),
            allowRemoteScan: bool('A SEPARATE opt-in from visibility'),
            label: str(),
            instanceId: str(),
            running: bool(),
            addresses: arr(str(), 'Private LAN addresses bound; never a public one'),
            peers: arr(opaque('paired machines; the shared secret is never included')),
            discovered: arr(opaque('machines advertising nearby, not yet paired')),
            shares: arr(str(), 'Exactly what leaves this machine'),
            neverShares: arr(str(), 'What cannot leave, including anything from the Security panel'),
          },
          ['enabled', 'allowRemoteScan', 'peers'],
        ),
      ),
    },
  },
  {
    method: 'put',
    path: '/api/fleet',
    summary: 'Turn the fleet view on or off, and separately allow remote scan requests',
    tag: 'platform',
    destructive: false,
    requestBody: jsonBody(obj({ enabled: bool(), allowRemoteScan: bool(), label: str() })),
    responses: { '200': jsonResponse('Applied', opaque('enabled, allowRemoteScan, label, running')) },
  },
  {
    method: 'post',
    path: '/api/fleet/pairing',
    summary: 'Show a six-digit pairing code for a few minutes',
    tag: 'platform',
    destructive: false,
    responses: {
      '200': jsonResponse('Offer', obj({ code: str(), expiresAt: int() }, ['code', 'expiresAt'])),
      '409': errorResponse('The fleet view is off'),
    },
  },
  {
    method: 'delete',
    path: '/api/fleet/pairing',
    summary: 'Stop offering a pairing code',
    tag: 'platform',
    destructive: false,
    responses: { '200': jsonResponse('Cancelled', opaque('pairing: null')) },
  },
  {
    method: 'get',
    path: '/api/fleet/peers',
    summary: 'Machines paired with this one',
    tag: 'platform',
    destructive: false,
    responses: { '200': jsonResponse('Peers', obj({ peers: arr(opaque('instanceId, label, address, online, summary')) }, ['peers'])) },
  },
  {
    method: 'post',
    path: '/api/fleet/peers',
    summary: 'Pair with another machine using the code it is showing',
    tag: 'platform',
    destructive: false,
    requestBody: jsonBody(obj({ address: str(), port: int(), code: str('Six digits') }, ['address', 'code'])),
    responses: { '200': jsonResponse('Paired', opaque('peer')), '400': errorResponse('Pairing failed') },
  },
  {
    method: 'delete',
    path: '/api/fleet/peers/{id}',
    summary: 'Forget a paired machine',
    tag: 'platform',
    destructive: false,
    parameters: [pathParam('id', 'Peer instance id')],
    responses: { '200': jsonResponse('Removed', obj({ removed: bool() }, ['removed'])) },
  },
  {
    method: 'get',
    path: '/api/fleet/peers/{id}/summary',
    summary: 'Ask a paired machine for its summary — volume figures and last scan, never files',
    tag: 'platform',
    destructive: false,
    parameters: [pathParam('id', 'Peer instance id')],
    responses: { '200': jsonResponse('Summary', opaque('summary, peer')), '502': errorResponse('That machine could not be reached') },
  },
  {
    method: 'post',
    path: '/api/fleet/peers/{id}/trigger-scan',
    summary: 'Ask a paired machine to scan a folder. It refuses unless it separately allowed remote scans.',
    tag: 'platform',
    destructive: false,
    parameters: [pathParam('id', 'Peer instance id')],
    requestBody: jsonBody(obj({ path: str('Folder on THAT machine') }, ['path'])),
    responses: { '200': jsonResponse('Started', opaque('scanId')), '502': errorResponse('Refused or unreachable') },
  },
  {
    method: 'get',
    path: '/api/platform/portable',
    summary: 'Is this a portable, no-trace session? Where it writes, what it cannot do, and which drives to offer first.',
    tag: 'platform',
    destructive: false,
    responses: {
      '200': jsonResponse(
        'Portable status',
        obj(
          {
            portable: bool(),
            signal: str('Which signal turned it on: env, portable-executable-dir or marker-file'),
            dataDir: nullable(str('Where state is written; null means nothing is persisted at all')),
            baseDir: str('The folder holding the executable — the only place it may write'),
            writable: bool(),
            reason: str('Why nothing can be saved, when that is the case'),
            hostUntouched: bool('True while this machine’s own app-data location has not been touched'),
            hostDataDir: str('The host location being deliberately avoided'),
            degraded: arr(opaque('key and a plain-English reason')),
            externalVolumes: arr(opaque('path and name of each attached drive')),
          },
          ['portable', 'signal', 'writable', 'hostUntouched'],
        ),
      ),
    },
  },
  {
    method: 'get',
    path: '/api/platform/shell-integration',
    summary: 'Is the "Scan with TreeMap" right-click entry installed? Read from the filesystem/registry, never remembered.',
    tag: 'platform',
    destructive: false,
    responses: {
      '200': jsonResponse('State', obj({ supported: bool(), mechanism: str(), reason: str(), installed: bool() }, ['supported', 'installed'])),
    },
  },
  {
    method: 'post',
    path: '/api/platform/shell-integration',
    summary: 'Add or remove the right-click entry. Per-user; needs no administrator rights.',
    tag: 'platform',
    destructive: false,
    requestBody: jsonBody(obj({ install: bool('true to add, false to remove') }, ['install'])),
    responses: {
      '200': jsonResponse('Result', obj({ installed: bool(), targets: arr(str()), reason: str(), mechanism: str() }, ['installed', 'targets'])),
      '409': errorResponse('No supported file manager on this system'),
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
            processes: opaque('per-process groups: pid, processName, appBundle, restartable, restartRefusal, bytes, unknownSizeCount, handles[] (path, bytes, holders)'),
            totalBytes: int('Known held bytes, each deleted file counted once however many processes hold it — a floor, not an estimate'),
            unknownSizeCount: int('Held files whose size could not be read, each counted once'),
            fileCount: int('Distinct deleted files held open'),
            sharedFileCount: int('How many of those more than one process holds'),
            scannedAt: int(),
          },
          ['processes', 'totalBytes', 'unknownSizeCount', 'fileCount', 'sharedFileCount', 'scannedAt'],
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
      '400': errorResponse('PID_INVALID / PROCESS_NAME_REQUIRED / PID_IS_TREEMAP / PID_SYSTEM (part of the operating system, or run as root) / PID_OTHER_USER / RESTART_UNSUPPORTED'),
      '409': errorResponse('CAPABILITY_UNAVAILABLE / PID_REUSED / PID_UNVERIFIED / TERMINATE_REFUSED'),
    },
  },
  {
    method: 'get',
    path: '/api/timecapsule',
    summary: 'Items copied aside before an automated delete, with capacity and history',
    tag: 'timecapsule',
    destructive: false,
    responses: {
      '200': jsonResponse('The capsule index', ref('TimeCapsuleIndex')),
      '500': errorResponse(
        'CAPSULE_INDEX_UNREADABLE — the index file exists and will not parse. Every capsule operation refuses ' +
          'in this state rather than acting on an invented empty capsule, because each entry is the only record ' +
          'of a file it is holding. The message names the file to repair — never to move or delete it, which ' +
          'would make the next sweep read an ABSENT index, call it a first run, and remove every recovery folder.',
      ),
    },
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
      '409': errorResponse('PATH_OCCUPIED, PATH_UNREADABLE (its original place could not be looked at — a folder above it cannot be searched — so nothing was put there), ALREADY_RESTORED (put back already, or just now and still being recorded), PAYLOAD_GONE, MANIFEST_UNREADABLE, RESTORE_RUNNING (a restore of that copy is already under way) or CAPSULE_RECORD_INVALID (the entry\'s id, its original place or its manifest\'s names are not what TreeMap records) — restoring never overwrites what is there now, and never follows a record TreeMap did not write'),
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
      '409': errorResponse('RESTORE_RUNNING — a restore is reading that copy right now; it can be forgotten once the restore has finished. DELETION_RUNNING — the deletion that made the copy is still under way, and its item may be on its way to the Trash with this as its only copy; it can be forgotten once that deletion has finished'),
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
        overwrite: bool('Replace an existing file at the destination. Off by default — a snapshot copy is older than whatever is there now. The file replaced goes to the Trash first, held to the rules a delete is: inside a scanned root, and allowed by agent-policy.json'),
      }, ['path']) } },
    },
    responses: {
      '400': errorResponse('PATH_REQUIRED without a path; PATH_INVALID or PATH_BLOCKED for the path or the destination'),
      '403': errorResponse('SPILL_PATH for the path or the destination; APP_DATA_PATH for the destination; with overwrite, for the file it would replace, OUTSIDE_SCAN_ROOT, or POLICY_ROOT_NOT_ALLOWED, POLICY_PROTECTED_PATH or POLICY_BYTES_EXCEEDED from agent-policy.json'),
      '200': jsonResponse('Recovered', obj(
        {
          restored: bool(), originalPath: str(), restoredTo: str(), fromSnapshotId: nullable(str()),
          sizeBytes: nullable(int('The bytes recovered: a file\'s size, or the total of the files in a recovered folder; null when that folder\'s tree could not be read')),
          newerUnread: obj(
            { count: int('How many newer snapshots could not be mounted or opened'), reason: str('The first of their reasons') },
            ['count', 'reason'],
            'Present only when the copy came from an older snapshot because newer ones could not be mounted or opened: it may not be the newest copy',
          ),
        },
        ['restored', 'originalPath', 'restoredTo', 'fromSnapshotId', 'sizeBytes'],
      )),
      '409': errorResponse('DESTINATION_OCCUPIED, DESTINATION_IS_FOLDER, DESTINATION_UNVERIFIABLE (the destination could not be checked, so nothing was written over it), DESTINATION_NOT_CLEARED (the file being replaced could not be moved to the Trash), NO_SNAPSHOTS, SNAPSHOTS_UNREADABLE (the snapshot list could not be read — NOT the same as there being none), NOT_IN_ANY_SNAPSHOT, DESTINATION_FOLDER_REFUSED (macOS: the destination folder belongs to another account or others can change it, so the copy made as administrator is not put there — checked before the password prompt, and before a file being replaced is moved to the Trash), DESTINATION_FOLDER_UNAVAILABLE (macOS: the destination folder could not be checked or made before the password prompt — the reason is in the message — or could not be opened or checked when the copy ran — moved, removed or its drive disconnected while the prompt was open; nothing was written, and trying again may succeed), RESTORE_FAILED (on every platform: the prompt, the copy or its placement failed, or a snapshot could not be mounted or opened — NOT the same as the path being in no snapshot; a restore with overwrite that stops after the Trash step says the replaced file is there), or AUTHORIZATION_DECLINED when the password prompt was dismissed'),
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
      '400': errorResponse('POLICY_MATCH_EMPTY, POLICY_MATCH_INVALID (an unknown match kind, or a custom rule carrying the duplicates flag, which no policy can honour), POLICY_PATH_TOO_BROAD, POLICY_PATH_REQUIRED, POLICY_PATH_IS_LINK (a new or changed folder is a link; the sentence names the folder it leads to, and offers it to choose instead when a policy can be saved there: not a whole drive, nor another link), PATH_INVALID and PATH_BLOCKED (the folder fails the scan-path check), POLICY_QUERY_INVALID (the query does not parse), POLICY_QUERY_UNANSWERABLE (a new or changed query uses a field this build cannot answer, e.g. dupe:), POLICY_MATCH_ADVISORY (a new or changed suggestion match names a group TreeMap only advises on and never deletes — a VM disk, Xcode archives, a photo library\'s derivatives), NOTHING_TO_UPDATE (no "policies" in the body), BAD_POLICIES ("policies" is not a list), TOO_MANY_POLICIES (more than 50), DUPLICATE_POLICY_ID (two entries share an id) — refused rather than saved in a shape that would misbehave'),
    },
  },
  {
    method: 'post',
    path: '/api/autopilot/policies/{id}/approve',
    summary: 'Let a policy start deleting, after its mandatory first dry run — bound to the run the person looked at',
    tag: 'autopilot',
    destructive: true,
    parameters: [pathParam('id', 'Policy id')],
    requestBody: jsonBody(obj({ runId: str('The run being approved: the policy\'s newest run, awaiting approval') }, ['runId'])),
    responses: {
      '200': jsonResponse('Approved: a first approval lets the policy delete on its own; approving a run held by requireConfirmationAbove lets its next run delete up to what that run matched, once (approvedBytes)', obj({ policy: ref('AutopilotPolicy') }, ['policy'])),
      '400': errorResponse('RUN_ID_REQUIRED'),
      '404': errorResponse('POLICY_NOT_FOUND, or RUN_NOT_FOUND (no such run of this policy)'),
      '409': errorResponse('APPROVAL_NOT_ASKED (that run is not awaiting approval), or APPROVAL_STALE (not the policy\'s newest run, or made before its folder or match changed — it showed something else; a policy never approved is previewed afresh at its next check)'),
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
      '400': errorResponse('POLICY_REQUIRED (neither "policyId" nor "policy"); for a "policy", every refusal a save would give it, judged against the stored policy of the same id as a save judges it: POLICY_MATCH_EMPTY, POLICY_MATCH_INVALID, POLICY_PATH_TOO_BROAD, POLICY_PATH_REQUIRED, POLICY_PATH_IS_LINK, PATH_INVALID, PATH_BLOCKED, POLICY_QUERY_INVALID, POLICY_QUERY_UNANSWERABLE, POLICY_MATCH_ADVISORY'),
      '404': errorResponse('POLICY_NOT_FOUND'),
      '409': errorResponse('POLICY_RECORD_INVALID — the stored policy\'s folder is not one TreeMap saved (autopilot.json was changed outside TreeMap), so nothing was scanned; save the policy again'),
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
      '202': jsonResponse('Restore started', obj({
        jobId: str(),
        entryCount: int(),
        passedOver: arr(opaque('{ path, reason } — a copy of an unconfirmed item not put back yet (its place is not empty), saying what the disk showed; the run stays undoable for it')),
        unrestorable: arr(opaque('{ path, reason } — an item of the run whose Time Capsule copy is gone (evicted to make room, expired, or missing from the capsule folder), or a record in the run that TreeMap did not make (its id is not one TreeMap gives), which no undo can put back; the run is then not marked undone. A record with a TreeMap id whose original place or manifest TreeMap would not write refuses the whole undo instead (409 CAPSULE_RECORD_INVALID)')),
      }, ['jobId', 'entryCount'])),
      '404': errorResponse('RUN_NOT_FOUND'),
      '409': errorResponse('NOTHING_TO_UNDO (the sentence says what the disk showed of each copy still held), ALREADY_UNDONE, CAPSULE_EMPTY or RESTORE_RUNNING (an undo or restore of the same copies is already under way) — refused rather than half-undone; ' + UNDO_RESTORE_409),
    },
  },
  {
    method: 'post',
    path: '/api/timecapsule/jobs/{jobId}/cancel',
    summary: 'Cancel a running restore; what it had begun writing is removed (items already put back stay), and one that cannot remove something it wrote ends as an error naming it, never as cancelled',
    tag: 'timecapsule',
    destructive: false,
    parameters: [pathParam('jobId', 'Id from POST /api/timecapsule/{id}/restore')],
    responses: {
      '200': jsonResponse('Cancelling', obj({ cancelling: bool() }, ['cancelling'])),
      '404': errorResponse('JOB_NOT_RUNNING — no running job with that id'),
    },
  },

  /* ------------ query grammar (v4 §2) ------------ */
  {
    method: 'post',
    path: '/api/query',
    summary: 'Run a query against a completed scan — the grammar behind saved views and Clean Up rules',
    tag: 'query',
    destructive: false,
    requestBody: jsonBody(
      obj(
        {
          scanId: str('A completed scan (from POST /api/scan)'),
          q: str('The query, e.g. size>100mb ext:mp4 used>1y -in:node_modules'),
          limit: int('1-1000 (default 200)'),
          offset: int('Paging offset'),
          sort: str('size | name | modified | path (default size)'),
        },
        ['scanId', 'q'],
      ),
    ),
    responses: {
      '200': jsonResponse(
        'Matches, plus what the query could not fully answer',
        obj(
          {
            ok: bool(),
            total: int('Matches found'),
            truncated: bool('More matches exist than were examined or returned'),
            examined: int('Nodes walked — lets a caller state coverage rather than imply it'),
            postFiltered: arr(str(), 'Signals read after the scan tree was walked — this route runs in memory, not against the index'),
            postFilterReasons: arr(opaque('{ field, reason }')),
            degraded: arr(opaque('{ provider, reason }'), 'Signals this machine cannot supply — an empty result here means "unknown", never "nothing matched"'),
            hits: arr(opaque('{ path, name, size, isDir, mtimeMs }')),
          },
          ['ok', 'total', 'truncated', 'hits', 'degraded', 'postFiltered'],
        ),
      ),
      '400': errorResponse('QUERY_PARSE_ERROR (with offset, length and expected), QUERY_REQUIRED or SCAN_REQUIRED'),
      '404': errorResponse('SCAN_NOT_FOUND'),
      '409': errorResponse('SCAN_RUNNING or SCAN_FAILED'),
    },
  },
  {
    method: 'post',
    path: '/api/nl-query',
    summary: 'Translate plain words into the query grammar (v4 §9.6) via the built-in offline phrase table — translation only, NEVER execution; the result is shown for approval and can be edited before it runs through POST /api/query',
    tag: 'query',
    destructive: false,
    requestBody: jsonBody(obj({ text: str('e.g. "big videos I have not opened in a year"') }, ['text'])),
    responses: {
      '200': jsonResponse(
        'ok:true carries the translated q from the deterministic phrase table (source is always "rules"). ok:false carries the honest refusal. Never any hits.',
        obj(
          {
            ok: bool(),
            source: str("always 'rules' — the deterministic phrase table"),
            q: str('The translated query — present when ok'),
            matched: arr(obj({ phrase: str(), term: str(), note: str() }, ['phrase', 'term'])),
            unmatched: arr(str('Words the table could not place — shown, not swallowed')),
            reason: str('Present when ok:false: nothing was understood, the sentence uses a field TreeMap can never answer (duplicates, "never opened" — the query would match nothing), or it comes to nothing but type: (it would list every file)'),
          },
          ['ok', 'source'],
        ),
      ),
      '400': errorResponse('NL_TEXT_REQUIRED'),
    },
  },
  {
    method: 'post',
    path: '/api/query/validate',
    summary: 'Parse a query without running it — for live feedback while typing',
    tag: 'query',
    destructive: false,
    requestBody: jsonBody(obj({ q: str('The query to parse') }, ['q'])),
    responses: {
      '200': jsonResponse('Parsed', obj({
        ok: bool(),
        postFiltered: arr(str(), 'What a scan query would need beyond the tree itself'),
        indexPostFiltered: arr(str(), 'What the SQLite index could not answer — a different engine, reported separately'),
        fields: arr(str()),
      }, ['ok', 'fields'])),
      '400': errorResponse('QUERY_PARSE_ERROR — carries offset, length and the valid alternatives'),
    },
  },
  {
    method: 'get',
    path: '/api/query/fields',
    summary: 'The query grammar: every field, its operators, its values and its help text',
    tag: 'query',
    destructive: false,
    responses: {
      '200': jsonResponse('The grammar', obj({ fields: arr(opaque('{ name, help, values[], operators[] }')) }, ['fields'])),
    },
  },
  {
    method: 'get',
    path: '/api/queries',
    summary: 'Saved views, pinned first then newest',
    tag: 'query',
    destructive: false,
    responses: { '200': jsonResponse('Saved views', obj({ queries: arr(opaque('{ id, name, q, createdMs, pinned, colour }')) }, ['queries'])) },
  },
  {
    method: 'post',
    path: '/api/queries',
    summary: 'Save a view. A query that does not parse is refused rather than stored',
    tag: 'query',
    destructive: false,
    requestBody: jsonBody(obj({ name: str(), q: str(), pinned: bool(), colour: str('#rrggbb, or omitted') }, ['name', 'q'])),
    responses: {
      '201': jsonResponse('Saved', obj({ query: opaque('{ id, name, q, createdMs, pinned, colour }') }, ['query'])),
      '400': errorResponse('QUERY_PARSE_ERROR, NAME_REQUIRED, NAME_TOO_LONG, QUERY_REQUIRED or TOO_MANY_SAVED_QUERIES'),
    },
  },
  {
    method: 'delete',
    path: '/api/queries/{id}',
    summary: 'Delete a saved view (it holds no file data — this removes a bookmark)',
    tag: 'query',
    destructive: false,
    parameters: [pathParam('id', 'Saved view id')],
    responses: {
      '200': jsonResponse('Deleted', obj({ deleted: bool() }, ['deleted'])),
      '404': errorResponse('SAVED_QUERY_NOT_FOUND'),
    },
  },

  /* ------------ the cleanup cart (v4 §4.4) ------------ */
  {
    method: 'post',
    path: '/api/cart/commit',
    summary: 'Commit the cleanup cart: protect in the Time Capsule, verify, then Trash — as one undoable run',
    tag: 'cart',
    destructive: true,
    parameters: [idempotencyHeader],
    requestBody: jsonBody(
      obj(
        {
          paths: arr(str(), 'Absolute paths inside a scanned root; at most 500 per request'),
          dryRun: bool('Return the exact manifest, having acted on nothing'),
          carryOver: arr(opaque('Opaque: an entry of the carryOver a previous dry run returned'), 'Dry run only: the carryOver the dry run of the previous batch of the same cart returned, handed back unchanged — so this batch plans against the room the earlier batches would already use (a dry run writes nothing). Leave it out for the first batch'),
          runId: str('Continue the run a previous commit started, so a cart larger than one request is still ONE undoable unit. Must be the id that commit returned'),
        },
        ['paths'],
      ),
    ),
    responses: {
      '200': jsonResponse(
        'The manifest (dryRun) or the result of the run',
        obj(
          {
            dryRun: bool(),
            runId: str('Only on a real run. The id POST /api/cart/undo takes'),
            items: arr(opaque('{ path, bytes, willDelete, code?, reason? } — dry run only')),
            bytesWouldFree: int('Dry run only'),
            bytesSkipped: int('Dry run only: bytes that would be left behind, unprotectable'),
            evicts: arr(opaque('{ id, name, originalPath, bytes } — older capsule copies that would be dropped to make room')),
            capsule: opaque('{ available, reason?, capBytes, usedBytes }'),
            openHandles: opaque("B2's preflight: what a program is holding open right now"),
            carryOver: arr(opaque('Opaque'), 'Dry run only: hand it back unchanged with the next batch\'s dry run of the same cart'),
            trashed: arr(str(), 'Real run only. An item staged inside another staged item (by where each is on the disk) is listed too, once the disk no longer shows it: it went to the Trash inside it, and its bytes are counted once, there'),
            bytesFreed: int('Real run only'),
            skipped: arr(opaque('{ path, code?, reason? } — left UNDELETED because they could not be protected (CAPSULE_FULL also when they do not fit beside the copies this run already holds, which are never evicted), their copy was gone by their own trash step (CAPSULE_COPY_GONE), they changed between their copy and their trash step (CAPSULE_CHANGED; the copy is discarded), the Trash refused them (or TreeMap did not hand them to it), the item holding them was not deleted, or the Trash reported taking the item holding them while the disk still shows them in place (code NOT_DELETED)')),
            failedToTrash: arr(opaque("{ path, reason } — protected, then refused by the Trash, and still in place, untouched; the copies were dropped")),
            unverified: arr(opaque('{ path, reason } — present when the Trash reported failing and the disk could not confirm either way (a look that failed, nothing known at the path before the trash step, or a trash command stopped before it answered): the copies were KEPT, and undo puts each back only if its place is empty by then. Also an item inside another one, when that one is unverified, or went to the Trash while the item\'s own place could not be looked at: the copy of the item holding it holds it')),
            capsuleUnavailable: str('Set when the capsule cannot run at all. Nothing was deleted'),
            cleanupError: str('Real run only: discarding the copies of what the Trash refused did not finish. Everything in trashed was trashed, and undo with runId puts it back'),
          },
          ['dryRun'],
        ),
      ),
      '400': errorResponse('PATHS_REQUIRED, TOO_MANY_PATHS or a rejected path'),
      '403': errorResponse('OUTSIDE_SCAN_ROOT, VIRTUAL_PATH, SAFETY_RECORD (the agent policy or the audit log, or a folder that holds them, or a link TreeMap reaches app-data through) or a policy refusal'),
      '409': errorResponse('OPEN_HANDLE_CONFLICT — something in the set is open'),
    },
  },
  {
    method: 'post',
    path: '/api/cart/undo',
    summary: 'Put a whole cart commit back from the Time Capsule, at the original paths',
    tag: 'cart',
    destructive: true,
    parameters: [idempotencyHeader],
    requestBody: jsonBody(obj({ runId: str('The runId POST /api/cart/commit returned') }, ['runId'])),
    responses: {
      '202': jsonResponse(
        'Restore started; follow it on GET /api/timecapsule/jobs/{jobId}/progress',
        obj({
          jobId: str(),
          entryCount: int(),
          bytesTotal: int(),
          passedOver: arr(opaque('{ path, reason } — a copy of an unconfirmed item not put back yet (its place is not empty), saying what the disk showed; a later undo can still put it back')),
          unrestorable: arr(opaque('{ path, reason } — an item of the commit whose Time Capsule copy is gone (evicted to make room, expired, or missing from the capsule folder), or a record in the run that TreeMap did not make (its id is not one TreeMap gives), which no undo can put back. A record with a TreeMap id whose original place or manifest TreeMap would not write refuses the whole undo instead (409 CAPSULE_RECORD_INVALID)')),
        }, ['jobId', 'entryCount', 'bytesTotal']),
      ),
      '400': errorResponse('RUN_ID_REQUIRED'),
      '409': errorResponse('ALREADY_UNDONE — an undo already put back everything it could (and the sentence counts any item whose copy is gone); CAPSULE_EMPTY — the copies are gone, so it cannot be undone; NOTHING_TO_UNDO — no copy it holds can be put back now, and the sentence says what the disk showed of each: the same file still in its place, never deleted, something else standing there, or a place that could not be looked at; RESTORE_RUNNING — an undo or restore of the same copies is already under way; ' + UNDO_RESTORE_409),
    },
  },

  /* ------------ facts (v4 §4.1) ------------ */
  {
    method: 'post',
    path: '/api/facts',
    summary: 'Per-path derived facts, as a sidecar — a path absent from "values" was not computable, never zero',
    tag: 'facts',
    destructive: false,
    requestBody: jsonBody(
      obj(
        {
          scanId: str('A completed scan (from POST /api/scan)'),
          paths: arr(str(), 'Absolute paths inside a scanned root. At most 2000 per request.'),
          providers: arr(str(), 'Fact provider ids: size, lastUsed, recoverability, reclaimScore. Unknown ids are refused rather than ignored.'),
        },
        ['scanId', 'paths', 'providers'],
      ),
      'Facts are delivered here rather than added to the scan endpoints, whose responses are held byte-identical to the pre-rewrite baseline.',
    ),
    responses: {
      '200': jsonResponse(
        'One entry per requested provider. A provider that failed is available:false with its own reason; the others still answer.',
        obj(
          {
            providers: opaque(
              'providerId -> { available, reason?, stats: { requested, computed, skipped, failed }, values: { [path]: fact } }',
            ),
          },
          ['providers'],
        ),
      ),
      '400': errorResponse('PATHS_REQUIRED, TOO_MANY_PATHS, PROVIDERS_REQUIRED or UNKNOWN_PROVIDER (which names the valid ids)'),
      '403': errorResponse('OUTSIDE_SCAN_ROOT — every path must lie inside a root this server scanned (one there that no scan listed, such as a drive a scan did not enter, is skipped instead)'),
      '404': errorResponse('SCAN_NOT_FOUND — unknown or expired scanId'),
    },
  },
];

/* ------------------------------ document ------------------------------ */

/**
 * An endpoint's responses with the storage-mode refusal added, read from the availability
 * table (the one source, P4-15): a route serving a feature that can be off answers 409
 * `STORAGE_MODE` in the modes where it is. Merged into a 409 the endpoint already documents.
 */
function withStorageModeRefusal(ep: EndpointDescriptor): Json {
  const entry = ROUTE_FEATURES[`${ep.method.toUpperCase()} ${ep.path.replace(/\{(\w+)\}/g, ':$1')}`];
  const off = entry === undefined ? [] : featuresOf(entry).filter(canBeOff);
  if (off.length === 0) return ep.responses;
  const which = off
    .map((f) => `${FEATURES[f].label} (off in ${STORAGE_MODES.filter((m) => isOff(f, m)).join(' and ')} mode)`)
    .join('; ');
  const refusal =
    `STORAGE_MODE — the scan is kept in a storage mode where the feature asked for is off: ${which}. ` +
    'The body adds `mode` and `feature`. Every scan is kept in memory today, where nothing is off.';
  const existing = ep.responses['409'] as { description?: string; content?: Json } | undefined;
  return {
    ...ep.responses,
    '409': existing
      ? { ...existing, description: `${existing.description ?? ''}; or ${refusal}` }
      : jsonResponse(refusal, ref('StorageModeError')),
  };
}

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
      responses: withStorageModeRefusal(ep),
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
        'authenticates via an automatically-set cookie. A feature that is off in the storage mode a very ' +
        'large scan is kept in answers 409 { error, code: "STORAGE_MODE", mode, feature } (every scan is ' +
        'kept in memory today, where nothing is off); a path in TreeMap\'s own spill folder in app-data is ' +
        'refused by every endpoint that takes a path to trash, open, move or write, 403 { code: "SPILL_PATH" }; and no ' +
        'request writes, moves or copies a file anywhere in app-data, 403 { code: "APP_DATA_PATH" }; nor removes or moves ' +
        'the agent policy or the audit log, or a folder that holds them, or a link TreeMap reaches app-data through, 403 { code: "SAFETY_RECORD" }.',
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
      { name: 'engine', description: 'The scanning budget — Eco, Balanced, Turbo — and the native core that holds it' },
      { name: 'cloud', description: "The user's own cloud accounts" },
      { name: 'facts', description: 'Per-path derived facts, delivered as a sidecar to the scan tree' },
      { name: 'query', description: 'The query grammar, and the views saved from it' },
      { name: 'cart', description: 'Committing the cleanup cart through the Time Capsule, and undoing it' },
      { name: 'notes', description: 'Notes pinned to folders — words for the human, and a matching pause for the machine (v4 §9.5)' },
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
