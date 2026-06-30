/**
 * TreeMap — shared TypeScript interfaces.
 * Every shape that crosses a service or API boundary lives here.
 */

/** A single file or directory in the scanned tree. */
export interface FileNode {
  name: string;
  path: string;
  /** Bytes. For directories this is the recursive sum of all children. */
  size: number;
  type: 'file' | 'dir';
  /** Present only for directories. */
  children?: FileNode[];
  /** Lower-cased extension without the dot, e.g. "png". Files only. */
  extension?: string;
  /** Unix epoch milliseconds of last modification. */
  modifiedAt: number;
  isHidden: boolean;
}

export type ScanStatus = 'running' | 'complete' | 'error';

/** Mutable record of one scan, kept in the in-memory store. */
export interface ScanResult {
  scanId: string;
  rootPath: string;
  status: ScanStatus;
  /** Total filesystem entries seen so far (files + dirs). */
  scanned: number;
  fileCount: number;
  dirCount: number;
  /** Path the scanner most recently touched — used for progress UI. */
  currentPath: string;
  /** Populated once status === 'complete'. */
  root?: FileNode;
  /** Populated once status === 'error'. */
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** Used by the TTL evictor. */
  createdAt: number;
  /** Cooperative cancellation flag (set on shutdown/eviction). */
  cancelled: boolean;
}

/** One rectangle of the squarified treemap, coordinates in percent (0–100). */
export interface TreemapNode {
  name: string;
  path: string;
  size: number;
  type: 'file' | 'dir';
  extension?: string;
  modifiedAt: number;
  depth: number;
  /** Whether this dir's children were also emitted (false = leaf in this view). */
  expanded: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Events streamed over the SSE progress endpoint. */
export type ScanEvent =
  | { type: 'progress'; scanned: number; currentPath: string }
  | { type: 'complete'; root: FileNode }
  | { type: 'error'; message: string }
  | { type: 'shutdown' };

/** A batch trash operation. */
export interface CleanJob {
  paths: string[];
}

export interface CleanResult {
  deleted: string[];
  failed: { path: string; reason: string }[];
}

export interface SystemInfo {
  platform: NodeJS.Platform;
  hostname: string;
  totalDisk: number;
  freeDisk: number;
  homeDir: string;
  commonDirs: string[];
}

export interface FileTypeStat {
  ext: string;
  count: number;
  totalSize: number;
}

export interface LargeFile {
  name: string;
  path: string;
  size: number;
  extension?: string;
  modifiedAt: number;
}

export interface LargeFolder {
  name: string;
  path: string;
  size: number;
  /** Recursive file count. */
  fileCount: number;
  modifiedAt: number;
}

/* ---------- Duplicate finder ---------- */

/** One group of content-identical files. */
export interface DuplicateGroup {
  /** Full SHA-256 of the content (hex). */
  hash: string;
  /** Size of one copy, bytes. */
  size: number;
  count: number;
  /** Bytes freed by keeping a single copy: size × (count − 1). */
  reclaimable: number;
  /** Newest first. */
  files: { name: string; path: string; modifiedAt: number }[];
}

export type DuplicateJobStatus = 'running' | 'complete' | 'error';

/** Mutable record of one background hashing job (per scanId). */
export interface DuplicateJob {
  scanId: string;
  status: DuplicateJobStatus;
  /** Files below this many bytes were not considered. */
  minSize: number;
  /** Hashing progress for the UI. */
  hashed: number;
  toHash: number;
  cancelled: boolean;
  /** Populated once status === 'complete' (top groups by reclaimable). */
  groups?: DuplicateGroup[];
  groupCount?: number;
  totalReclaimable?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

/* ---------- Empty folders ---------- */

export interface EmptyFoldersResult {
  /** Topmost recursively-empty dirs (parents themselves not empty). */
  folders: { name: string; path: string }[];
  /** All empty dirs found, including those nested inside the ones above. */
  totalCount: number;
  truncated: boolean;
}

/* ---------- Snapshots (size history / Trends) ---------- */

export interface SnapshotTopEntry {
  name: string;
  path: string;
  size: number;
  type: 'file' | 'dir';
}

/** Lightweight persisted record of one completed scan. */
export interface Snapshot {
  id: string;
  rootPath: string;
  takenAt: number;
  totalSize: number;
  fileCount: number;
  dirCount: number;
  /** Direct children of the root at scan time, largest first. */
  topEntries: SnapshotTopEntry[];
}

export interface SnapshotRef {
  id: string;
  takenAt: number;
  totalSize: number;
}

export interface SnapshotDeltaEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  /** null = entry did not exist in that snapshot. */
  sizeA: number | null;
  sizeB: number | null;
  delta: number;
}

export interface SnapshotDiff {
  a: SnapshotRef;
  b: SnapshotRef;
  rootPath: string;
  totalDelta: number;
  entries: SnapshotDeltaEntry[];
}

/* ---------- Scan comparison ---------- */

export type CompareChange = 'added' | 'removed' | 'grew' | 'shrank';

export interface CompareEntry {
  path: string;
  name: string;
  type: 'file' | 'dir';
  sizeA: number | null;
  sizeB: number | null;
  delta: number;
  change: CompareChange;
}

export interface CompareResult {
  scanIdA: string;
  scanIdB: string;
  rootPath: string;
  totalDelta: number;
  entries: CompareEntry[];
  truncated: boolean;
}

/* ---------- Settings: ignore list + scheduled scans ---------- */

export type IgnoreScope = 'scan' | 'suggest' | 'both';

export interface IgnoreEntry {
  /** Absolute path, path glob, or bare name glob (e.g. "node_modules", "*.iso"). */
  pattern: string;
  /** 'scan' = skip while walking; 'suggest' = hide from cleanup suggestions. */
  scope: IgnoreScope;
}

export interface ScheduleConfig {
  id: string;
  path: string;
  /** Hours between runs, e.g. 24 = daily. */
  intervalHours: number;
  /** Alert when growth since the previous snapshot exceeds either bound. */
  thresholdPct?: number;
  thresholdBytes?: number;
  enabled: boolean;
  lastRunAt?: number;
}

export interface AppSettings {
  ignore: IgnoreEntry[];
  schedules: ScheduleConfig[];
}

/** Emitted when a scheduled scan crosses its growth threshold. */
export interface GrowthNotification {
  id: string;
  path: string;
  at: number;
  message: string;
  prevSize: number;
  newSize: number;
  delta: number;
}

/* ---------- Smart cleanup suggestions ---------- */

export interface CleanupSuggestionItem {
  name: string;
  path: string;
  size: number;
  type: 'file' | 'dir';
  modifiedAt: number;
}

export interface CleanupSuggestionGroup {
  id: string;
  title: string;
  description: string;
  items: CleanupSuggestionItem[];
  totalSize: number;
}

/* ---------- Clean the Mac (well-known macOS junk locations) ---------- */

/** One macOS junk category, paired with the scan that backs its deletes. */
export interface MacCleanCategoryResult {
  id: string;
  title: string;
  description: string;
  /** Absolute directory this category scanned. */
  path: string;
  /** Scan whose root is `path`; poll /api/scan/:scanId/result for sizes. */
  scanId: string;
}

/* ---------- Applications: Uninstaller + Updater ---------- */

/** One installed macOS application (top-level *.app in /Applications or ~/Applications). */
export interface AppSummary {
  /** Display name (the .app filename without the extension). */
  name: string;
  /** Absolute path to the .app bundle. */
  path: string;
  /** CFBundleIdentifier, or null if the Info.plist lacks one. */
  bundleId: string | null;
  /** CFBundleShortVersionString (falls back to CFBundleVersion), or null. */
  version: string | null;
  /** CFBundleExecutable — used for exact running-process detection. */
  executable: string | null;
  /** Base64 PNG data URI of the app's icon, or null if none. */
  icon: string | null;
}

/** One support-file an app leaves behind under ~/Library. */
export interface AppLeftover {
  /** Basename of the leftover file/folder. */
  name: string;
  /** Absolute path (always inside ~/Library). */
  path: string;
  /** Which ~/Library subfolder it lives in, e.g. "Caches", "Preferences". */
  category: string;
  /** Bytes, from the registered scan. */
  size: number;
}

/** Result of analyzing one app for uninstall: the bundle + its leftovers. */
export interface AppLeftoversResult {
  app: {
    name: string;
    path: string;
    bundleId: string | null;
    version: string | null;
    icon: string | null;
    size: number;
    /** True when a process with the bundle's executable name is running. */
    running: boolean;
  };
  leftovers: AppLeftover[];
  /** App bundle + every leftover, bytes. */
  totalSize: number;
}

/** One Homebrew cask with an available update. */
export interface OutdatedCask {
  /** Homebrew token (used for `brew upgrade --cask <token>`). */
  token: string;
  name: string;
  installedVersion: string | null;
  latestVersion: string | null;
  /** Base64 PNG icon of the matching installed app, or null. */
  icon: string | null;
}

/** Outcome of a single `brew upgrade --cask` run. */
export interface BrewUpgradeResult {
  ok: boolean;
  token: string;
  /** Last line of brew's stdout (success) or stderr (failure). */
  message: string;
}

/* ---------- Activity hub (Dashboard lifetime stats) ---------- */

export type ActivityKind = 'fast-clean' | 'system-junk' | 'uninstall' | 'update' | 'large-old';

/** One recorded cleaner action. */
export interface ActivityEvent {
  /** Unix epoch ms. */
  at: number;
  kind: ActivityKind;
  /** Human label, e.g. an app name or "application caches". */
  label: string;
  /** Bytes moved to Trash / recovered (0 for updates). */
  bytes: number;
  /** Count of items affected (paths trashed, casks updated, …). */
  items: number;
}

/** Persisted cumulative activity + recent log. */
export interface ActivitySummary {
  /** When the first event was recorded (drives "since {date}"); null when empty. */
  firstRecordedAt: number | null;
  totalBytesRecovered: number;
  junkItemsCleaned: number;
  appsUninstalled: number;
  programsUpdated: number;
  /** Newest first, capped. */
  log: ActivityEvent[];
}

/** Uniform API error body. */
export interface ApiError {
  error: string;
  code: string;
}
