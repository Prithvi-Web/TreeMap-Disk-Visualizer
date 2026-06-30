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

/** Uniform API error body. */
export interface ApiError {
  error: string;
  code: string;
}
