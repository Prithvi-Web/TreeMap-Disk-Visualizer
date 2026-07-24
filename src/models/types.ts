/**
 * TreeMap — shared TypeScript interfaces.
 * Every shape that crosses a service or API boundary lives here.
 */

import type { ScanStore } from '../services/scanStore';

/** A single file or directory in the scanned tree. */
export interface FileNode {
  name: string;
  path: string;
  /** Bytes. For directories this is the recursive sum of all children. */
  size: number;
  type: 'file' | 'dir';
  /** Present only for directories. */
  children?: FileNode[];
  /**
   * Set by pruneTree: this directory has children in the real scan, but they
   * were withheld to keep the payload bounded. `size` stays exact. Fetch
   * GET /api/scan/:scanId/subtree?path=… to drill in.
   * Invariant: a node never has both `children` and `pruned`.
   */
  pruned?: boolean;
  /** Lower-cased extension without the dot, e.g. "png". Files only. */
  extension?: string;
  /** Unix epoch milliseconds of last modification. */
  modifiedAt: number;
  /**
   * Unix epoch milliseconds of last access (stat.atimeMs). Recorded only by
   * the disk walker; the gdu/cloud/container engines have no atime and omit
   * it. Best-effort by nature: relatime/noatime mounts (and Windows defaults)
   * make access times stale, so consumers must treat "missing" as normal.
   */
  accessedAt?: number;
  isHidden: boolean;
  /** Hard-linked file whose inode was already counted — size set to 0 to avoid double-counting. */
  hardlinkDuplicate?: boolean;
  /** Symbolic link (recorded as a leaf, never followed). */
  isSymlink?: boolean;
  /** Cloud placeholder/stub: reports a logical size but occupies ~no disk blocks. */
  cloudPlaceholder?: boolean;
  /** Cloud provider detected for a placeholder, when inferable from the path. */
  cloudProvider?: 'icloud' | 'onedrive' | 'dropbox';
  /** Directory that is a git repository root (directly contains a .git directory). */
  gitRepo?: boolean;
  /** Drillable container (archive, disk image, Docker data, Photos library). */
  container?: ContainerKind;
  /** Provider file id for nodes of a cloud scan (drives provider-trash). */
  cloudId?: string;
  /** Lives inside a container — listed, not on disk; excluded from trash/open. */
  virtual?: boolean;
  /** Uncompressed size for archive entries whose treemap size was scaled. */
  logicalSize?: number;
}

/** Containers the treemap can drill into. */
export type ContainerKind = 'zip' | 'tar' | 'tgz' | 'iso' | 'dmg' | 'photos' | 'docker';

export type ScanStatus = 'running' | 'complete' | 'error' | 'cancelled';

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
  /**
   * The scan's tree, packed. Populated once status === 'complete' for scans
   * produced by the disk walker (and, as producers migrate, every engine).
   */
  store?: ScanStore;
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
  /** Which enumeration engine produced this scan (dashboard note). */
  engine?: 'walker' | 'turbo-walker' | 'gdu-turbo' | 'ntfs-mft' | 'cloud';
  /** libuv threadpool size the scan ran with. */
  ioThreads?: number;
  /** True when this scan reused the on-disk mtime cache (fast rescan). */
  incremental?: boolean;
  /** Directories served from the cache (incremental scans only). */
  cachedDirs?: number;
  /** Directories actually walked on disk. */
  walkedDirs?: number;
  /** Files skipped as hard-link duplicates (counted once). */
  hardlinkedFiles?: number;
  /** Bytes those hard-link duplicates would have double-counted. */
  hardlinkedBytes?: number;
  /** Cloud placeholder files detected (size > 0 but ~0 disk blocks). */
  cloudFiles?: number;
  /** Logical bytes those cloud placeholders report but don't occupy on disk. */
  cloudBytes?: number;
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
  /** Cloud placeholder/stub (online-only file) — rendered with a cloud marker. */
  cloudPlaceholder?: boolean;
  /** Git repository root — rendered with a branch marker. */
  gitRepo?: boolean;
  /** Drillable container — rendered with a distinct border/badge. */
  container?: ContainerKind;
  /** Inside a container: read-only, no trash/open. */
  virtual?: boolean;
  /** Uncompressed size for scaled archive entries (tooltips). */
  logicalSize?: number;
  /**
   * Historical layouts only (time slider): size in the previous snapshot,
   * or null when the entry didn't exist yet — drives the diff overlay.
   */
  prevSize?: number | null;
}

/** Events streamed over the SSE progress endpoint. */
/**
 * The counters a client needs to paint headline numbers.
 *
 * All are O(1) reads off ScanResult — the walker maintains them during the walk
 * — so they ride along on the 'complete' frame rather than costing a round-trip.
 * That matters because a pruned tree cannot be counted client-side without
 * under-reporting, so these are the *only* honest source for the headline.
 */
export interface ScanStats {
  scanned: number;
  fileCount: number;
  dirCount: number;
  engine: string;
  ioThreads: number;
  durationMs: number;
  incremental: boolean;
  cachedDirs: number;
  walkedDirs: number;
  hardlinkedFiles: number;
  hardlinkedBytes: number;
  cloudFiles: number;
  cloudBytes: number;
}

export type ScanEvent =
  | { type: 'progress'; scanned: number; currentPath: string }
  | { type: 'complete'; root: FileNode; stats: ScanStats }
  | { type: 'error'; message: string }
  | { type: 'cancelled' }
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

/* ---------- Perceptual / near-duplicate images (Feature 12) ---------- */

/** One image inside a near-duplicate cluster. */
export interface NearDupeFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: number;
  /** Hamming distance (0–64) of this image's dHash from the cluster's newest image. */
  distance: number;
}

/** A group of perceptually-similar images (resized / re-encoded / screenshot copies). */
export interface NearDupeCluster {
  /** Newest first; the newest copy is the one kept by "auto-select all but newest". */
  files: NearDupeFile[];
  count: number;
  /** Bytes freed by keeping only the newest copy: total − newest. */
  reclaimableBytes: number;
}

export type NearDupeJobStatus = 'running' | 'complete' | 'error';

/** Background dHash + clustering job, one per (scanId, threshold). */
export interface NearDupeJob {
  scanId: string;
  status: NearDupeJobStatus;
  /** Max Hamming distance for two images to be considered near-duplicates. */
  threshold: number;
  /** Image decoder actually used, or 'none' when none was available. */
  decoder: 'sharp' | 'ffmpeg' | 'none';
  /** False when no image decoder could be loaded — the UI shows a hint instead of clusters. */
  available: boolean;
  reason?: string;
  /** Hashing progress for the UI. */
  hashed: number;
  toHash: number;
  cancelled: boolean;
  /** Populated once status === 'complete' (top clusters by reclaimable bytes). */
  clusters?: NearDupeCluster[];
  clusterCount?: number;
  totalReclaimable?: number;
  /** True when more images existed than the clustering cap allowed. */
  truncated?: boolean;
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
  /** True when a deeper tree was stored for the time-slider treemap. */
  hasTree?: boolean;
}

/**
 * Compact stored subtree for the time-slider treemap: single-letter keys and
 * name-only paths keep each snapshot's tree within its ~100 KB budget.
 */
export interface SnapshotTreeNode {
  /** Basename. */
  n: string;
  /** Size in bytes. */
  s: number;
  /** Present (1) = directory. */
  t?: 1;
  c?: SnapshotTreeNode[];
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

/** A user-pinned maximum size for a folder (Feature 15). */
export interface BudgetEntry {
  /** Absolute folder path. */
  path: string;
  /** Budget ceiling in bytes. */
  maxBytes: number;
}

/** Bring-your-own OAuth app credentials for one cloud provider. */
export interface CloudCredentials {
  clientId: string;
  /** Google desktop clients also use a (non-confidential) secret. */
  clientSecret?: string;
}

export interface AppSettings {
  ignore: IgnoreEntry[];
  schedules: ScheduleConfig[];
  budgets: BudgetEntry[];
  /** Scheduled scans warn when the disk-full forecast drops below this many days. */
  forecastThresholdDays: number;
  /** Live activity mode auto-pauses after this many minutes without events. */
  watchIdleMinutes: number;
  /** Cloud provider app credentials (tokens live in cloud-tokens.json). */
  cloud: Partial<Record<'gdrive' | 'dropbox' | 'onedrive', CloudCredentials>>;
}

/** A budget cross-referenced against a scan: how the folder measures up now. */
export interface BudgetStatus {
  path: string;
  name: string;
  maxBytes: number;
  /** Recursive size of the folder in this scan. */
  actualBytes: number;
  /** actualBytes − maxBytes; positive means over budget. */
  overBy: number;
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

/* ---------- Offload (copy → verify → trash; the third option) ---------- */

/** One offloaded file, persisted in the manifest. */
export interface OffloadEntry {
  id: string;
  /** Basename, for search and display. */
  name: string;
  originalPath: string;
  destPath: string;
  /** The destination folder the user picked (grouping + mount checks). */
  destRoot: string;
  size: number;
  /** Full SHA-256 of the content (hex) — verified on offload and restore. */
  hash: string;
  offloadedAt: number;
  /** Set once the entry has been copied back and re-verified. */
  restoredAt?: number;
}

export type OffloadJobStatus = 'running' | 'complete' | 'error' | 'cancelled';
export type OffloadPhase = 'checking' | 'copying' | 'verifying' | 'trashing' | 'rolling-back' | 'done';

/** Mutable record of one offload/restore job (progress via SSE). */
export interface OffloadJob {
  jobId: string;
  kind: 'offload' | 'restore';
  status: OffloadJobStatus;
  phase: OffloadPhase;
  destRoot: string;
  fileCount: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  currentPath: string;
  error?: string;
  cancelled: boolean;
  startedAt: number;
  finishedAt?: number;
}

/** Events streamed over the offload SSE progress endpoint. */
export type OffloadStreamEvent =
  | { type: 'progress'; phase: OffloadPhase; filesDone: number; fileCount: number; bytesDone: number; bytesTotal: number; currentPath: string }
  | { type: 'complete'; filesDone: number; bytesDone: number }
  | { type: 'error'; message: string }
  | { type: 'cancelled' }
  | { type: 'shutdown' };

/* ---------- Live disk activity (Watcher) ---------- */

export type WatchEventKind = 'created' | 'modified' | 'deleted';

/** One batched filesystem change, streamed over the watch SSE. */
export interface WatchEvent {
  path: string;
  kind: WatchEventKind;
  /** Bytes gained (positive) or lost since the last known size. */
  delta: number;
  /** Current size (0 when deleted). */
  size: number;
}

/** Frames streamed over GET /api/watch/:scanId. */
export type WatchStreamEvent =
  | { type: 'init'; idleMinutes: number; engine: 'recursive' | 'top-levels' }
  | { type: 'activity'; at: number; events: WatchEvent[] }
  | { type: 'paused'; reason: 'idle' | 'shutdown' };

/* ---------- Disk-full forecasting ---------- */

/**
 * ok — a trustworthy projection exists. insufficient — too little history.
 * stable/shrinking — no fill-up risk at the fitted rate. erratic — sizes
 * bounce around too much for an honest number.
 */
export type ForecastStatus = 'ok' | 'insufficient' | 'stable' | 'shrinking' | 'erratic';

/** A top-level folder among the fastest growers. */
export interface ForecastGrower {
  name: string;
  path: string;
  /** Fitted growth in bytes/day (recent-weighted). */
  bytesPerDay: number;
}

export interface ForecastResult {
  path: string;
  status: ForecastStatus;
  /** Days until the volume is full at the fitted rate — status 'ok' only. */
  fullInDays?: number;
  /** 0–1: fit quality × history richness × fit agreement. */
  confidence: number;
  /** Fitted growth of the whole root, bytes/day. */
  bytesPerDay: number;
  /** Free bytes on the volume containing the root. */
  freeBytes: number;
  snapshotCount: number;
  /** History span in days. */
  spanDays: number;
  topGrowers: ForecastGrower[];
  /** Human-readable explanation when status !== 'ok'. */
  reason?: string;
}

/* ---------- Smart cleanup suggestions ---------- */

/**
 * regenerable — safe to delete and recreate from source/config (node_modules,
 * build output, virtualenvs). cache — rebuilt automatically by a tool when next
 * used (browser/dev caches). junk — OS-recreated metadata or stale downloads.
 */
export type SuggestionCategory = 'regenerable' | 'cache' | 'junk';

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
  category: SuggestionCategory;
  /** Command that recreates this group's contents (regenerable groups only). */
  regenerateCmd?: string;
}

/* ---------- Per-app storage attribution (Apps tab) ---------- */

/** Where an app's bytes live: the app itself, rebuildable caches, user data, or logs. */
export type AppCategory = 'app' | 'cache' | 'data' | 'logs';

/** One directory (or .app bundle) attributed to an application. */
export interface AppLocation {
  path: string;
  bytes: number;
  category: AppCategory;
  /** Human label for the breakdown list, e.g. "Application Support". */
  label: string;
}

/** One application with everything the scan attributes to it. */
export interface AppEntry {
  /** Display name, e.g. "Google Chrome". */
  name: string;
  /** Merge key: bundle id on macOS when known, else a normalized name. */
  id: string;
  totalBytes: number;
  /** Byte totals per category (only categories that are present). */
  bytesByCategory: Partial<Record<AppCategory, number>>;
  /** Largest attributed locations, size-sorted. */
  locations: AppLocation[];
  /** Bytes freed by "Clear caches safely" (cache + log locations only). */
  safeToClearBytes: number;
  /** The cache/log paths that button moves to the Trash. */
  safeToClearPaths: string[];
}

export interface AppAttributionResult {
  scanId: string;
  /** Largest first. */
  apps: AppEntry[];
  /** Bytes in the scan no application claimed ("Everything else"). */
  otherBytes: number;
  /** Scan root size — apps + otherBytes always sum to exactly this. */
  totalBytes: number;
  /** False when the OS application folders weren't inside this scan. */
  appsFolderScanned: boolean;
}

/* ---------- Browser profile drill-down (Feature 16) ---------- */

/** One reclaimable cache/storage area inside a browser profile. */
export interface BrowserCacheItem {
  path: string;
  bytes: number;
  /** Human label, e.g. "HTTP Cache", "Service Worker Cache". */
  label: string;
}

/** A detected browser profile with its broken-out cache sub-areas. */
export interface BrowserProfileGroup {
  browser: string;
  profile: string;
  /** Profile root path. */
  path: string;
  totalBytes: number;
  items: BrowserCacheItem[];
}

/** Uniform API error body. */
export interface ApiError {
  error: string;
  code: string;
}
