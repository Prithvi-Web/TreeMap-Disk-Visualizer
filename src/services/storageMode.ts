import fs from 'fs';
import type { ScanResult } from '../models/types';
import { AppError } from '../middleware/errorHandler';
import { storeOf } from './scanStore';

/**
 * Where a scan's rows live, and what each feature does there: the availability table of
 * the Phase 4 plan's §S.7, as data, in one place (P4-15).
 *
 * A scan is kept in one of three storage modes. `memory` is every scan today: the whole
 * tree in a packed store. `spill` keeps the rows in unnamed files on disk and a summary in
 * memory (§S.5). `aggregate` keeps a bounded summary, the largest folders and files and
 * totals for the rest, with no row for every file (§S.6). T16's chooser picks the mode
 * before the walk; until it exists every scan is `memory`, and a test puts a scan in the
 * other two through `setStorageModeForTests`.
 *
 * Every HTTP route the app registers and every MCP tool is mapped to one feature here, a
 * route whose answer depends on its parameters through a `pick` that names the feature a
 * request asks for. `tests/storageModeTable.test.ts` walks the running app's router and
 * lists the MCP server's tools, and fails on anything this table does not classify and on
 * any entry naming a route or tool that does not exist. A feature that is `off` in a
 * scan's mode is refused before its handler runs: 409 `STORAGE_MODE` over HTTP
 * (`middleware/storageModeGate.ts`), the same code in an MCP tool's error, and
 * `available: false` with the same sentence from a fact provider.
 *
 * Only `off` is built here (T17a). The other behaviours the large modes will have (exact
 * answers from the summary, async lookups, the FullPassRunner, the fold's counts,
 * `notKept`) are T15b's, T18's and T19's; until they land, those routes keep today's
 * handler in every mode, and this table says what each will become.
 */

export type StorageMode = 'memory' | 'spill' | 'aggregate';

export const STORAGE_MODES: readonly StorageMode[] = ['memory', 'spill', 'aggregate'];

/** What a feature does in a mode: §S.7's cells. */
export type Availability =
  | 'today'
  | 'exact'
  | 'exactOrFlagged'
  | 'keptRows'
  | 'asyncLookup'
  | 'runner'
  | 'fold'
  | 'notKept'
  | 'off';

/** Each cell of §S.7 in words. */
export const AVAILABILITY_MEANS: Readonly<Record<Availability, string>> = {
  today: 'as today',
  exact: 'exact: answered from the summary kept in memory, and from the spill files beyond it (T15b)',
  exactOrFlagged: 'exact, or flagged exact:false with the reason (P4-16; T19)',
  keptRows: 'the rows the scan kept, with what it did not keep counted in `omitted` (T19)',
  asyncLookup: 'looked up in the spill files off the main thread (T15b)',
  runner: 'run over the spill files in a worker thread, the FullPassRunner (T18)',
  fold: 'from the recursive counts folded during the walk (T19)',
  notKept: '`notKept` for a path the scan did not keep, with `lstat` where a size is needed (T19)',
  off: 'refused: 409 STORAGE_MODE',
};

/** Why a feature is off in a mode, in the words the refusal uses. */
type OffBecause = 'needsEveryFile' | 'growsPerFile' | 'changesTheStore';

interface FeatureRow {
  /** What the feature is, in a phrase that can end a sentence or begin one. */
  readonly label: string;
  /** The row of §S.7 it belongs to (1–8), or 0 for "reads no scan's rows". */
  readonly row: number;
  /** Set when §S.7 does not name it: why it sits in its row. */
  readonly classified?: string;
  readonly memory: 'today';
  readonly spill: Availability;
  readonly aggregate: Availability;
}

/** §S.7's rows, each as its cells. */
const TREE = { row: 1, memory: 'today', spill: 'exact', aggregate: 'keptRows' } as const;
const ANSWERS = { row: 2, memory: 'today', spill: 'exact', aggregate: 'exactOrFlagged' } as const;
const LOOKUPS = { row: 3, memory: 'today', spill: 'asyncLookup', aggregate: 'notKept' } as const;
const FULL_PASS = { row: 4, memory: 'today', spill: 'runner', aggregate: 'off' } as const;
const FOLD = { row: 5, memory: 'today', spill: 'fold', aggregate: 'fold' } as const;
const GROWS = { row: 6, memory: 'today', spill: 'off', aggregate: 'off' } as const;
const WRITES = { row: 7, memory: 'today', spill: 'off', aggregate: 'off' } as const;
const TOTALS = { row: 8, memory: 'today', spill: 'today', aggregate: 'today' } as const;
const NO_STORE = { row: 0, memory: 'today', spill: 'today', aggregate: 'today' } as const;

/** Every feature, by id: what it is and what it does in each mode. */
export const FEATURES = {
  // Row 1: the tree views.
  tree: { ...TREE, label: 'the scan’s tree (the complete event, /result, /subtree and /treemap)' },
  snapshot: { ...TREE, label: 'the snapshot saved when a scan completes' },
  journal: { ...TREE, label: 'the History journal of scheduled scans' },
  // Row 2: the answers the dashboard shows.
  largest: { ...ANSWERS, label: 'the largest files and folders' },
  fileTypes: { ...ANSWERS, label: 'the file-type breakdown' },
  reclaimRanked: { ...ANSWERS, label: 'the Reclaim Score ranking of the largest entries' },
  reportPdf: {
    ...ANSWERS,
    label: 'the PDF report',
    classified: 'it prints the top files, the top folders and the file types, which are this row’s answers',
  },
  // Row 3: lookups by path.
  nodes: { ...LOOKUPS, label: 'looking paths up in the scan' },
  budgets: {
    ...LOOKUPS,
    label: 'folder budgets',
    classified: 'the budget gauges look the same folders up as /budgets does',
  },
  facts: { ...LOOKUPS, label: 'per-path facts' },
  knownSizeOf: { ...LOOKUPS, label: 'the byte cap of the agent policy' },
  duplicateDetail: { ...LOOKUPS, label: 'the side-by-side view of a duplicate group' },
  offload: {
    ...LOOKUPS,
    label: 'offloading files',
    classified: 'an offload of files reads one row a file; only a whole folder is off (§S.5.7)',
  },
  // Row 4: full passes, which run in the FullPassRunner in spill and are off in aggregate.
  cleanupSuggestions: { ...FULL_PASS, label: 'the Smart Suggestions list' },
  customRules: { ...FULL_PASS, label: 'matching the custom Clean Up rules' },
  query: { ...FULL_PASS, label: 'the query search' },
  calendar: { ...FULL_PASS, label: 'the calendar view' },
  security: { ...FULL_PASS, label: 'the Security view' },
  cloudSafe: { ...FULL_PASS, label: 'the list of online-only cloud files' },
  compression: { ...FULL_PASS, label: 'the video compression shortlist' },
  git: { ...FULL_PASS, label: 'the git repositories breakdown' },
  packages: { ...FULL_PASS, label: 'the package-artifacts view' },
  games: { ...FULL_PASS, label: 'the game libraries view' },
  media: { ...FULL_PASS, label: 'the media libraries view' },
  appAttribution: { ...FULL_PASS, label: 'the per-app storage view' },
  browserProfiles: { ...FULL_PASS, label: 'the browser profiles view' },
  humanScale: { ...FULL_PASS, label: 'the “≈ N photos like the ones here” comparison' },
  folderExport: {
    ...FULL_PASS,
    label: 'the folders export (CSV or XLSX)',
    classified: 'the folders CSV is §S.7’s; the folders XLSX writes the same rows through a streaming writer',
  },
  agentSummary: {
    ...FULL_PASS,
    label: 'the agent summary',
    classified: 'its reclaimable-by-category part runs the cleanup suggestions over the whole tree',
  },
  autopilot: {
    ...FULL_PASS,
    label: 'Autopilot',
    classified: 'a policy runs the cleanup suggestions, custom rules or a query over the scan it makes',
  },
  // Row 5.
  subtreeCount: { ...FOLD, label: 'the item counts of folders' },
  // Row 6: JavaScript state that grows with every file: off until it is ported.
  duplicates: { ...GROWS, label: 'duplicate finding' },
  nearDuplicates: { ...GROWS, label: 'near-duplicate finding' },
  compare: { ...GROWS, label: 'comparing two scans' },
  emptyFolders: { ...GROWS, label: 'the Empty Folders view' },
  customRulesDup: { ...GROWS, label: 'the custom rule for names and sizes that occur more than once' },
  fileExport: { ...GROWS, label: 'the per-file export (CSV or XLSX)' },
  folderOffload: { ...GROWS, label: 'offloading a whole folder' },
  // Row 7: a spill or aggregate store is read-only after the walk (P4-6a).
  liveMode: { ...WRITES, label: 'Live mode' },
  containerExpansion: { ...WRITES, label: 'opening an archive or a Photos library inside the scan' },
  cloudTrash: {
    ...WRITES,
    label: 'moving cloud files to the provider’s trash',
    classified: 'it removes the trashed entries from the scan’s store, which the large modes never change',
  },
  // Row 8: totals and records, as today in every mode.
  costEstimate: { ...TOTALS, label: 'the cloud cost estimate' },
  scanList: { ...TOTALS, label: 'the list of scans in memory' },
  missingGigabytes: { ...TOTALS, label: 'the Missing Gigabytes statement' },
  scheduler: { ...TOTALS, label: 'scheduled scans' },
  fleet: { ...TOTALS, label: 'Fleet' },
  stats: { ...TOTALS, label: 'the scan’s counters (/stats)' },
  // Not the store at all.
  noStore: {
    ...NO_STORE,
    label: 'a request that reads no scan’s rows',
    classified: 'it reads settings, files on disk, the index, the Time Capsule, snapshots or a scan’s record, never its rows',
  },
} as const satisfies Record<string, FeatureRow>;

export type FeatureId = keyof typeof FEATURES;

/** What a request says, as a feature's `pick` reads it. MCP tools pass their arguments as `body`. */
export interface RequestFacts {
  query: Record<string, unknown>;
  body: Record<string, unknown>;
  /** The scans the request names, resolved. */
  scans: ScanResult[];
}

/** A route whose feature depends on what the request asks for. */
export interface SplitEntry {
  readonly features: readonly FeatureId[];
  /** What decides, in words. */
  readonly by: string;
  pick(request: RequestFacts): FeatureId;
}

/** A route whose scan is made by its own handler, so the refusal is in the run, not before it. */
export interface InRunEntry {
  readonly feature: FeatureId;
  readonly refusedIn: string;
}

export type RouteEntry = FeatureId | SplitEntry | InRunEntry;

/**
 * GET /api/scan/:scanId/export: the PDF prints the dashboard's answers, the folders list
 * (CSV or XLSX) is a full pass, and the per-file list holds a row per file. Read as the
 * handler reads its parameters; a format it would refuse (400 BAD_FORMAT) reads as the
 * per-file export, so in a large mode that request is refused 409 before it could be a 400.
 */
const EXPORT: SplitEntry = {
  features: ['reportPdf', 'folderExport', 'fileExport'],
  by: 'the format and mode parameters',
  pick: ({ query }) => {
    if (String(query.format ?? 'csv') === 'pdf') return 'reportPdf';
    return query.mode === 'folders' ? 'folderExport' : 'fileExport';
  },
};

/** GET /api/cleanup/rules: the duplicate option (`dup`) counts every name and size in the scan. */
const CUSTOM_RULES: SplitEntry = {
  features: ['customRules', 'customRulesDup'],
  by: 'the dup parameter',
  pick: ({ query }) => (query.dup === '1' || query.dup === 'true' ? 'customRulesDup' : 'customRules'),
};

/** POST /api/offload and the MCP `offload` tool: a selection holding a folder is a whole-folder offload. */
const OFFLOAD: SplitEntry = {
  features: ['offload', 'folderOffload'],
  by: 'whether the selection holds a folder',
  pick: ({ body, scans }) => (selectsAFolder(body.paths, scans) ? 'folderOffload' : 'offload'),
};

/** Every route the app registers, as `METHOD /api/path` in Express's spelling. */
export const ROUTE_FEATURES: Readonly<Record<string, RouteEntry>> = {
  // scanRoutes
  'POST /api/scan': 'noStore',
  'POST /api/scan/:scanId/cancel': 'noStore',
  'GET /api/scan/:scanId/progress': 'tree',
  'GET /api/scan/:scanId/result': 'tree',
  'GET /api/scan/:scanId/subtree': 'tree',
  'POST /api/scan/:scanId/nodes': 'nodes',
  'GET /api/scan/:scanId/stats': 'stats',
  'GET /api/scan/:scanId/budgets': 'budgets',
  'GET /api/scan/:scanId/budget-gauges': 'budgets',
  'GET /api/scan/:scanId/export': EXPORT,
  'GET /api/scan/:scanId/treemap': 'tree',
  'GET /api/scan/:scanId/calendar': 'calendar',
  'GET /api/large-files': 'largest',
  'GET /api/file-types': 'fileTypes',
  // fileRoutes
  'POST /api/files/open-handles': 'noStore',
  'DELETE /api/files': 'knownSizeOf',
  'POST /api/files/open': 'noStore',
  'POST /api/files/terminal': 'noStore',
  'GET /api/files/preview': 'noStore',
  // systemRoutes
  'GET /api/system': 'noStore',
  'GET /api/volumes': 'noStore',
  'GET /api/trash/size': 'noStore',
  'POST /api/trash/empty': 'noStore',
  'GET /api/system/snapshots': 'noStore',
  'POST /api/system/snapshots/purge': 'noStore',
  'GET /api/system/snapshots/find-deleted': 'noStore',
  'POST /api/system/snapshots/restore': 'noStore',
  'GET /api/fs/list': 'noStore',
  // insightRoutes
  'GET /api/duplicates': 'duplicates',
  'GET /api/near-duplicates': 'nearDuplicates',
  'GET /api/duplicates/detail': 'duplicateDetail',
  'GET /api/apps': 'appAttribution',
  'GET /api/large-folders': 'largest',
  'GET /api/empty-folders': 'emptyFolders',
  'GET /api/missing-gigabytes': 'missingGigabytes',
  'GET /api/git/repos': 'git',
  'GET /api/packages/orphans': 'packages',
  'GET /api/games': 'games',
  'GET /api/media': 'media',
  'GET /api/security/findings': 'security',
  'POST /api/security/relocate': 'noStore',
  'GET /api/provenance': 'noStore',
  'GET /api/health/smart': 'noStore',
  'GET /api/cost/estimate': 'costEstimate',
  'GET /api/cost/pricing': 'noStore',
  'GET /api/compression/candidates': 'compression',
  'POST /api/compression/encode': 'noStore',
  'GET /api/compression/:jobId/progress': 'noStore',
  'GET /api/compression/:jobId/result': 'noStore',
  'POST /api/compression/:jobId/cancel': 'noStore',
  'POST /api/git/gc': 'noStore',
  'POST /api/container/expand': 'containerExpansion',
  'GET /api/scans': 'scanList',
  'GET /api/compare': 'compare',
  'GET /api/snapshots': 'noStore',
  'GET /api/snapshots/tree': 'noStore',
  'GET /api/forecast': 'noStore',
  'GET /api/snapshots/compare': 'noStore',
  // fleetRoutes
  'GET /api/fleet': 'fleet',
  'PUT /api/fleet': 'fleet',
  'POST /api/fleet/pairing': 'fleet',
  'DELETE /api/fleet/pairing': 'fleet',
  'GET /api/fleet/peers': 'fleet',
  'POST /api/fleet/peers': 'fleet',
  'DELETE /api/fleet/peers/:id': 'fleet',
  'GET /api/fleet/peers/:id/summary': 'fleet',
  'POST /api/fleet/peers/:id/trigger-scan': 'fleet',
  // settingsRoutes
  'GET /api/settings': 'noStore',
  'PUT /api/settings': 'noStore',
  'GET /api/cleanup/suggestions': 'cleanupSuggestions',
  'GET /api/cleanup/browser-profiles': 'browserProfiles',
  'GET /api/cleanup/cloud-safe': 'cloudSafe',
  'GET /api/cleanup/rules': CUSTOM_RULES,
  'GET /api/notifications': 'noStore',
  // watchRoutes
  'GET /api/watch/:scanId': 'liveMode',
  // offloadRoutes
  'POST /api/offload': OFFLOAD,
  'POST /api/offload/restore': 'noStore',
  'GET /api/offload/index': 'noStore',
  'POST /api/offload/reveal': 'noStore',
  'POST /api/offload/:jobId/cancel': 'noStore',
  'GET /api/offload/:jobId/progress': 'noStore',
  // cloudRoutes
  'GET /api/cloud/status': 'noStore',
  'POST /api/cloud/connect': 'noStore',
  'POST /api/cloud/connect/manual': 'noStore',
  'POST /api/cloud/disconnect': 'noStore',
  'POST /api/cloud/scan': 'noStore',
  'POST /api/cloud/trash': 'cloudTrash',
  // metaRoutes
  'GET /api/openapi.json': 'noStore',
  'GET /api/audit': 'noStore',
  'GET /api/policy': 'noStore',
  'GET /api/agent/summary': 'agentSummary',
  'GET /api/capabilities': 'noStore',
  // journalRoutes
  'GET /api/journal': 'noStore',
  // platformRoutes
  'GET /api/platform/capabilities': 'noStore',
  'POST /api/platform/capabilities/refresh': 'noStore',
  'GET /api/platform/topology': 'noStore',
  'GET /api/platform/portable': 'noStore',
  'GET /api/platform/shell-integration': 'noStore',
  'POST /api/platform/shell-integration': 'noStore',
  // indexRoutes: the persistent index reads the disk and its own database, never a scan's rows (§S.7)
  'POST /api/index/build': 'noStore',
  'GET /api/index/:jobId/progress': 'noStore',
  'GET /api/index/:jobId/result': 'noStore',
  'POST /api/index/:jobId/cancel': 'noStore',
  'GET /api/index/status': 'noStore',
  'GET /api/index/tree': 'noStore',
  'POST /api/index/watch': 'noStore',
  'DELETE /api/index': 'noStore',
  'GET /api/search': 'noStore',
  'GET /api/allocation': 'noStore',
  'GET /api/allocation/file': 'noStore',
  // timeCapsuleRoutes: the Time Capsule reads no scan (§S.7)
  'GET /api/timecapsule': 'noStore',
  'POST /api/timecapsule/:id/restore': 'noStore',
  'DELETE /api/timecapsule/:id': 'noStore',
  'POST /api/timecapsule/jobs/:jobId/cancel': 'noStore',
  'GET /api/timecapsule/jobs/:jobId/progress': 'noStore',
  // autopilotRoutes
  'GET /api/autopilot/policies': 'noStore',
  'PUT /api/autopilot/policies': 'noStore',
  'POST /api/autopilot/policies/:id/approve': 'noStore',
  'POST /api/autopilot/simulate': { feature: 'autopilot', refusedIn: 'the run, once the scan it makes has a mode (matchCandidates)' },
  'GET /api/autopilot/runs': 'noStore',
  'POST /api/autopilot/runs/:id/undo': 'noStore',
  // zombieRoutes
  'GET /api/zombie-handles': 'noStore',
  'POST /api/zombie-handles/restart': 'noStore',
  // factRoutes: never off as a whole; each provider answers for itself (PROVIDER_FEATURES)
  'POST /api/facts': 'facts',
  // queryRoutes
  'POST /api/query/validate': 'noStore',
  'POST /api/nl-query': 'noStore',
  'GET /api/query/fields': 'noStore',
  'POST /api/query': 'query',
  'GET /api/queries': 'noStore',
  'POST /api/queries': 'noStore',
  'DELETE /api/queries/:id': 'noStore',
  // cartRoutes
  'POST /api/cart/commit': 'knownSizeOf',
  'POST /api/cart/undo': 'noStore',
  // noteRoutes
  'GET /api/notes': 'noStore',
  'PUT /api/notes': 'noStore',
  'DELETE /api/notes': 'noStore',
  // engineRoutes
  'GET /api/engine/capabilities': 'noStore',
  'GET /api/engine/budget': 'noStore',
  'PUT /api/engine/budget': 'noStore',
  'POST /api/scan/:scanId/pause': 'noStore',
  'POST /api/scan/:scanId/resume': 'noStore',
};

/** Every MCP tool the MCP server lists. */
export const TOOL_FEATURES: Readonly<Record<string, RouteEntry>> = {
  scan_path: 'tree',
  get_largest: 'largest',
  reclaim_ranked: 'reclaimRanked',
  missing_gigabytes: 'missingGigabytes',
  find_duplicates: 'duplicates',
  cleanup_suggestions: 'cleanupSuggestions',
  forecast: 'noStore',
  compare_scans: 'compare',
  offload: OFFLOAD,
  trash_paths: 'knownSizeOf',
};

/** Every fact provider, reached through POST /api/facts (and reclaim_ranked). */
export const PROVIDER_FEATURES: Readonly<Record<string, FeatureId>> = {
  size: 'facts',
  lastUsed: 'facts',
  recoverability: 'facts',
  reclaimScore: 'facts',
  subtreeCount: 'subtreeCount',
  humanScale: 'humanScale',
};

/** The features a route entry can name. */
export function featuresOf(entry: RouteEntry): readonly FeatureId[] {
  if (typeof entry === 'string') return [entry];
  if ('features' in entry) return entry.features;
  return [entry.feature];
}

/** The feature a request asks for. */
export function featureFor(entry: RouteEntry, request: RequestFacts): FeatureId {
  if (typeof entry === 'string') return entry;
  if ('pick' in entry) return entry.pick(request);
  return entry.feature;
}

export function availability(feature: FeatureId, mode: StorageMode): Availability {
  return FEATURES[feature][mode];
}

export function isOff(feature: FeatureId, mode: StorageMode): boolean {
  return availability(feature, mode) === 'off';
}

/** Whether a feature is off in any mode, so its routes must carry the gate. */
export function canBeOff(feature: FeatureId): boolean {
  return STORAGE_MODES.some((mode) => isOff(feature, mode));
}

const MODE_KEEPS: Readonly<Record<StorageMode, string>> = {
  memory: 'keeps the whole tree in memory',
  spill: 'keeps its rows in files on disk and reads them back as it needs them',
  aggregate: 'keeps a summary — every large folder and file, and totals for the rest — not a row for every file',
};

function offBecause(feature: FeatureId, mode: StorageMode): OffBecause {
  const row = FEATURES[feature].row;
  if (row === 7) return 'changesTheStore';
  if (row === 6 && mode === 'spill') return 'growsPerFile';
  return 'needsEveryFile';
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The sentence a refusal carries: the feature, the mode and what the mode keeps, why the
 * feature cannot run there, and what a person can do instead.
 */
export function refusalSentence(feature: FeatureId, mode: StorageMode): string {
  const { label } = FEATURES[feature];
  const why = {
    needsEveryFile: `${label} needs every file`,
    growsPerFile: `${label} holds something in memory for every file, which is what a spill scan avoids, so it stays off until it is rebuilt for spill scans`,
    changesTheStore: `${mode === 'aggregate' ? 'an' : 'a'} ${mode} scan cannot be changed once it is walked, and ${label} changes it`,
  }[offBecause(feature, mode)];
  return (
    `${capitalized(label)} is off for this scan. TreeMap kept it in ${mode} mode, which ${MODE_KEEPS[mode]}, and ${why}. ` +
    'Scan a smaller folder: a scan small enough to keep in memory has every feature.'
  );
}

/** The mode a scan is kept in. Absent reads as `memory`, which every scan is until T16. */
export function storageModeOf(scan: Pick<ScanResult, 'storageMode'>): StorageMode {
  return scan.storageMode ?? 'memory';
}

let modeForTests: StorageMode | null = null;

/**
 * The mode a scan starts in: `memory`, until T16's chooser exists. Both places that make a
 * scan record call this.
 */
export function newScanStorageMode(): StorageMode {
  return modeForTests ?? 'memory';
}

/**
 * Test seam, as T16's chooser will set a mode. Given a scan, that scan is kept (that is,
 * labelled) in `mode` from now on; without one, every scan made while it is set starts in
 * `mode`, and `null` restores `memory`. The scan itself is walked and held exactly as today,
 * so only the refusals see the difference.
 */
export function setStorageModeForTests(mode: StorageMode | null, scan?: ScanResult): void {
  if (scan) {
    scan.storageMode = mode ?? 'memory';
    return;
  }
  modeForTests = mode;
}

/**
 * Whether a path is a folder: the scan's own row when a scan holds the path, the file system
 * otherwise (a path no scan holds, or a scan with no tree yet). Never follows a link.
 */
function isFolder(scans: readonly ScanResult[], p: string): boolean {
  for (const scan of scans) {
    try {
      const store = storeOf(scan);
      const id = store.findByPath(p);
      if (id !== -1) return store.isDir(id);
    } catch {
      // No tree yet: ask the file system.
    }
  }
  try {
    return fs.lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

/** Whether an offload's selection holds a whole folder (§S.5.7: offload.ts plans it with no node limit). */
export function selectsAFolder(paths: unknown, scans: readonly ScanResult[]): boolean {
  return Array.isArray(paths) && paths.some((p) => typeof p === 'string' && isFolder(scans, p));
}

/**
 * The refusal a request earns, or null: the first scan it names whose mode turns the
 * feature it asks for `off`. A scan in `memory` never refuses, and the feature is only
 * worked out once a scan is in another mode.
 */
export function storageRefusal(entry: RouteEntry, request: RequestFacts): AppError | null {
  for (const scan of request.scans) {
    const mode = storageModeOf(scan);
    if (mode === 'memory') continue;
    const feature = featureFor(entry, request);
    if (isOff(feature, mode)) {
      return new AppError(409, 'STORAGE_MODE', refusalSentence(feature, mode), { mode, feature });
    }
  }
  return null;
}

/** An MCP tool's refusal: throws the same 409 `STORAGE_MODE`, which the tool reports as its error. */
export function assertToolAvailable(tool: string, scans: readonly ScanResult[], args: Record<string, unknown>): void {
  const entry = TOOL_FEATURES[tool];
  if (entry === undefined) throw new Error(`the MCP tool ${tool} is not in the storage-mode availability table`);
  const refusal = storageRefusal(entry, { query: {}, body: args, scans: [...scans] });
  if (refusal) throw refusal;
}

/**
 * A fact provider's refusal sentence for a scan, or null when the provider may run. A provider
 * the table does not classify is refused outside memory mode, in a sentence of its own: the
 * registry isolates providers, so one it cannot place costs only its own answer, never the
 * request's (tests/storageModeTable.test.ts holds every registered provider classified).
 */
export function providerRefusal(providerId: string, scan: Pick<ScanResult, 'storageMode'>): string | null {
  const mode = storageModeOf(scan);
  if (mode === 'memory') return null;
  const feature = PROVIDER_FEATURES[providerId];
  if (feature === undefined) {
    return `The fact provider ${providerId} is not in TreeMap's storage-mode table, so it is not run on a scan kept in ${mode} mode.`;
  }
  return isOff(feature, mode) ? refusalSentence(feature, mode) : null;
}

/** A feature refused in a run that makes its own scan (Autopilot): throws the 409. */
export function assertFeatureAvailable(feature: FeatureId, scan: Pick<ScanResult, 'storageMode'>): void {
  const mode = storageModeOf(scan);
  if (isOff(feature, mode)) {
    throw new AppError(409, 'STORAGE_MODE', refusalSentence(feature, mode), { mode, feature });
  }
}
