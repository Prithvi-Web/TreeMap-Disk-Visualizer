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

/** Uniform API error body. */
export interface ApiError {
  error: string;
  code: string;
}
