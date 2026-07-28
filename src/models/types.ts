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
  /**
   * Bytes this file actually occupies on disk (A2). Differs from `size` for
   * sparse files, compressed files and cloud placeholders. Absent when it
   * equals `size` — which is the overwhelming majority of files — so a large
   * tree does not carry a redundant field per node.
   */
  allocatedBytes?: number;
  /**
   * Of `allocatedBytes`, the part shared with another name for the same data
   * (A2). Present only for files that genuinely share; deleting a file with
   * `sharedBytes > 0` frees nothing.
   */
  sharedBytes?: number;
  /**
   * Of `allocatedBytes`, the part deleting this file would genuinely free.
   *
   * Scope rule: exclusivity is measured **within the scanned root**. A file
   * whose family reaches outside it is reported as shared, not exclusive,
   * because deleting every copy in scope would still free nothing.
   */
  exclusiveBytes?: number;
  /** Names for this file's data found in the scanned root (A2, families only). */
  linksInScope?: number;
  /** Names the filesystem reports in total; more than `linksInScope` means the family reaches outside. */
  linksTotal?: number;
}

/** Containers the treemap can drill into. */
export type ContainerKind = 'zip' | 'tar' | 'tgz' | 'iso' | 'dmg' | 'photos' | 'docker';

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
  /** Time Capsule keeps automatically-deleted items restorable this long (B3). */
  timeCapsuleRetentionDays: number;
  /** Ceiling on the capsule, as a percentage of the volume's usable space. */
  timeCapsuleMaxPercent: number;
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

/* ---------- Time Capsule (B3) ---------- */

export type TimeCapsuleKind = 'file' | 'folder';

/** One protected item: what was copied aside before an automated delete. */
export interface TimeCapsuleEntry {
  id: string;
  /** Basename, for search and display. */
  name: string;
  originalPath: string;
  kind: TimeCapsuleKind;
  /** Size of the item when it was captured — never changes, so the panel can
   *  still say how big a restored or evicted item was. */
  sizeBytes: number;
  /** Bytes the capsule is holding right now: 0 once restored or evicted. This
   *  is what counts against the cap. */
  heldBytes: number;
  /**
   * Whether the capsule still has a copy to give back.
   *
   * Separate from `heldBytes` because zero bytes is a perfectly good payload:
   * an empty folder and a zero-byte file both hold nothing and must both still
   * restore. Reading emptiness as absence made them permanently unrestorable.
   */
  hasPayload: boolean;
  fileCount: number;
  /** SHA-256 of the entry's file manifest — one hash for a file, a digest over
   *  every member for a folder. */
  digest: string;
  capturedAt: number;
  /** Groups everything one automated run protected. */
  runId?: string;
  /** The autopilot policy that selected it (B1). */
  policyId?: string;
  /** Why it was deleted, in the rule's own words. */
  reason?: string;
  /** Set once copied back to its original path and re-verified. */
  restoredAt?: number;
}

/**
 * Something that happened to the capsule's contents without the user asking.
 * Surfaced in the panel: protection that was withheld or withdrawn is never
 * allowed to be silent (§B3).
 */
export type TimeCapsuleEventKind = 'evicted' | 'expired' | 'unprotected' | 'lost';

export interface TimeCapsuleEvent {
  at: number;
  kind: TimeCapsuleEventKind;
  name: string;
  originalPath: string;
  sizeBytes: number;
  /** Plain-language explanation, written to go straight on screen. */
  detail: string;
}

export interface TimeCapsuleStatus {
  /** Bytes currently held (sum of every entry's heldBytes). */
  usedBytes: number;
  /** Ceiling, derived from the volume's capacity and the user's percentage. */
  capBytes: number;
  /** Free space on the volume holding the capsule; null when unreadable. */
  freeBytes: number | null;
  retentionDays: number;
  maxPercent: number;
  entryCount: number;
  /** Entries still holding a payload, i.e. restorable right now. */
  restorableCount: number;
  /** False when the capsule cannot be used at all; `reason` says why. */
  available: boolean;
  reason?: string;
}

export interface TimeCapsuleIndex {
  status: TimeCapsuleStatus;
  /** Newest first. */
  entries: TimeCapsuleEntry[];
  /** Newest first, bounded. */
  events: TimeCapsuleEvent[];
}

export type TimeCapsuleJobStatus = 'running' | 'complete' | 'error' | 'cancelled';
export type TimeCapsulePhase = 'copying' | 'verifying' | 'rolling-back' | 'done';

/** Mutable record of one restore job (progress via SSE). */
export interface TimeCapsuleJob {
  jobId: string;
  /** First entry in the job — kept for callers that only ever restore one. */
  entryId: string;
  /** Every entry this job restores; one item for a single-entry restore. */
  entryIds: string[];
  status: TimeCapsuleJobStatus;
  phase: TimeCapsulePhase;
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

/** Events streamed over the Time Capsule SSE progress endpoint. */
export type TimeCapsuleStreamEvent =
  | { type: 'progress'; phase: TimeCapsulePhase; filesDone: number; fileCount: number; bytesDone: number; bytesTotal: number; currentPath: string }
  | { type: 'complete'; filesDone: number; bytesDone: number }
  | { type: 'error'; message: string }
  | { type: 'cancelled' }
  | { type: 'shutdown' };

/* ---------- Snapshot recovery (B4) ---------- */

/**
 * One snapshot's relationship to a path being looked for.
 *
 * `possible` is the state that keeps this honest. On macOS and Windows,
 * reading a snapshot needs an administrator password, so before the user has
 * given one TreeMap knows a snapshot *exists* but not what is in it. Reporting
 * that as `present` would be a claim nobody checked; reporting it as `absent`
 * would hide a recoverable file.
 */
export type SnapshotCandidateState = 'present' | 'possible' | 'absent';

export interface SnapshotCandidate {
  snapshot: VolumeSnapshotRefDto;
  state: SnapshotCandidateState;
  /** Only known when the snapshot could actually be inspected. */
  sizeBytes: number | null;
  modifiedAt: number | null;
}

/** The wire shape of a platform snapshot reference. */
export interface VolumeSnapshotRefDto {
  id: string;
  name: string;
  takenAt: number | null;
  volume: string;
  accessPath: string | null;
}

export interface SnapshotSearchResult {
  path: string;
  /** Newest first. */
  candidates: SnapshotCandidate[];
  /**
   * Whether `state` was established by looking inside, or inferred from the
   * snapshot merely existing. False on macOS and Windows until authorized.
   */
  confirmed: boolean;
  capability: CapabilityStateDto;
  /** True when the path is still on disk — not a recovery case at all. */
  stillPresent?: boolean;
  /** Why there is nothing to offer, when there is nothing to offer. */
  reason?: string;
}

/** Mirror of the platform layer's CapabilityState, for the wire. */
export interface CapabilityStateDto {
  available: boolean;
  mechanism: string;
  reason?: string;
  degradedTo?: string;
}

export interface SnapshotRestoreOutcome {
  restored: true;
  originalPath: string;
  /** Where it was actually written — never the original path unless asked. */
  restoredTo: string;
  fromSnapshotId: string | null;
  sizeBytes: number;
}

/* ---------- Autopilot (B1) ---------- */

/**
 * What a policy is allowed to delete.
 *
 * Two kinds, because Clean Up has two kinds and Autopilot must not invent a
 * third vocabulary: the Smart Suggestions groups (`node_modules`, caches,
 * junk — each carrying the reason and the command that regenerates it), and
 * the custom age/size/extension rules.
 */
export type AutopilotMatch =
  | { kind: 'suggestion'; groupIds: string[] }
  | { kind: 'custom'; maxAgeMs?: number; minBytes?: number; exts?: string[] };

export interface AutopilotPolicy {
  id: string;
  /** User-facing label, e.g. "Old build folders in ~/Projects". */
  name: string;
  /**
   * The folder this policy may clean. Not in §B1's field list, but the feature
   * cannot resolve candidates without one — CleanupRules matches against a
   * scanned tree, so a policy has to say which tree.
   */
  path: string;
  match: AutopilotMatch;
  /** Hard ceiling on one run. null = no per-run cap. */
  maxBytesPerRun: number | null;
  /** Ceiling across a rolling 7 days. null = no weekly cap. */
  maxBytesPerWeek: number | null;
  /** Minimum days between runs; doubles as the schedule. */
  cooldownDays: number;
  /** Simulate every run instead of deleting. */
  dryRunFirst: boolean;
  /** Refuse to run unattended when the match totals more than this. */
  requireConfirmationAbove: number | null;
  enabled: boolean;
  /**
   * When the mandatory first dry run was approved. Until this is set the
   * policy only ever simulates, regardless of `dryRunFirst` (§B1).
   */
  approvedAt?: number;
  lastRunAt?: number;
}

export type AutopilotRunMode = 'dry-run' | 'live';
export type AutopilotRunStatus = 'awaiting-approval' | 'completed' | 'blocked' | 'failed';

/** One item a run deleted, or would have deleted. */
export interface AutopilotRunItem {
  path: string;
  name: string;
  bytes: number;
  /** Why it was selected, in the rule's own words. */
  reason: string;
  /** Command that puts it back, for regenerable matches. */
  regenerateCmd?: string;
}

/** The record §B1 requires: what, why, how much, when, under which policy. */
export interface AutopilotRun {
  id: string;
  policyId: string;
  policyName: string;
  at: number;
  mode: AutopilotRunMode;
  status: AutopilotRunStatus;
  /** Why nothing was deleted, when nothing was. */
  blockedReason?: string;
  items: AutopilotRunItem[];
  /** Bytes the match totalled, before any cap. */
  bytesMatched: number;
  /** Bytes actually removed (0 for a dry run). */
  bytesDeleted: number;
  /** Ties this run's deletions to their Time Capsule copies, for undo. */
  capsuleRunId?: string;
  /** Selected but not deleted, each with the reason. */
  skipped: { path: string; reason: string }[];
  /** Set once the run has been undone. */
  undoneAt?: number;
}

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

/* ---------- Agent-safety rails (policy + audit) ---------- */

/**
 * User-editable guard rails for destructive operations, persisted as
 * agent-policy.json in the app-data directory. Every field defaults to
 * "no restriction" so an absent or empty file means today's behavior.
 */
export interface AgentPolicy {
  /** When non-empty, scans and destructive targets must lie inside one of these roots. */
  allowedRoots: string[];
  /** Paths that may never be trashed or offloaded (nor anything containing them). */
  protectedPaths: string[];
  /** Refuse a single destructive operation over this many bytes. null = no cap. */
  maxBytesPerOperation: number | null;
}

/** One line of the append-only audit log (audit.jsonl in the app-data dir). */
export interface AuditEntry {
  /** Unix epoch ms. */
  at: number;
  /** e.g. "files.trash", "offload.start", "offload.restore", "trash.empty". */
  action: string;
  source: 'http' | 'mcp';
  /** Short digest of the configured token, or 'local' when auth is off. */
  tokenId: string;
  paths: string[];
  /** Known bytes involved, when the operation can tell. */
  bytes: number | null;
  dryRun: boolean;
  outcome: 'ok' | 'refused' | 'error';
  /** Error/refusal code when outcome is not 'ok'. */
  code?: string;
}
