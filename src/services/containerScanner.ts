import path from 'path';
import { execFile } from 'child_process';
import { Worker } from 'worker_threads';
import { FileNode, ScanResult, ContainerKind } from '../models/types';
import { ArchiveEntry, ArchiveListing, MAX_ENTRIES } from '../utils/archive';
import { detectContainerKind } from '../utils/containerKind';
import { findNodeByPath } from '../utils/treemap';
import { isInside } from '../utils/pathSanitizer';
import { AppError } from '../middleware/errorHandler';
import { ScanStore, Flag } from './scanStore';

/**
 * ContainerScanner — makes opaque blobs drillable (Phase 6). Pluggable
 * readers list a container's contents WITHOUT extracting anything:
 *  - zip/jar   central directory only (worker thread)
 *  - tar/tgz   entry headers, gunzip-streamed for .tar.gz (worker thread)
 *  - iso       `bsdtar -tvf` when available (macOS/Linux ship it)
 *  - docker    `docker system df -v` breakdown when the CLI is present
 *  - dmg       not listable without mounting — stays a leaf with a note
 *  - photos    already a scanned directory bundle — badge only
 *
 * Parsed entries are grafted into the in-memory scan tree as `virtual`
 * nodes (largest VIRTUAL_CAP kept), so the existing treemap/drill/breadcrumb
 * machinery works unchanged. Entry sizes are scaled down proportionally when
 * their sum exceeds the container's on-disk size — a cell can never claim
 * more pixels than the bytes it really occupies — with the true uncompressed
 * size kept in `logicalSize` for tooltips. pathGuard consults
 * isVirtualPath() so nothing inside a container can be trashed or opened.
 */

const VIRTUAL_CAP = 2000;
const WORKER_TIMEOUT_MS = 30_000;

/** Expanded containers per scanId — the pathGuard virtual-path registry. */
const expanded = new Map<string, Set<string>>();

/** True when `p` points inside an expanded container (not at it). */
export function isVirtualPath(p: string): boolean {
  for (const paths of expanded.values()) {
    for (const containerPath of paths) {
      if (p !== containerPath && isInside(containerPath, p)) return true;
    }
  }
  return false;
}

/** Scan eviction hygiene: drop registries for scans that no longer exist. */
export function forgetScan(scanId: string): void {
  expanded.delete(scanId);
}

/* ---------------- entries → virtual subtree ---------------- */

/**
 * Build the virtual FileNode children for a container from its entry list.
 * Keeps the largest VIRTUAL_CAP files, recreates their directories, and
 * scales sizes so the subtree never outweighs the container's disk bytes.
 * Pure — exported for tests.
 */
export function entriesToChildren(
  entries: ArchiveEntry[],
  containerPath: string,
  containerSize: number,
  now: number,
): { children: FileNode[]; entryCount: number; truncated: boolean } {
  const files = entries.filter((e) => !e.dir && e.size >= 0 && e.path && !e.path.startsWith('/') && !e.path.split('/').includes('..'));
  const kept = [...files].sort((a, b) => b.size - a.size).slice(0, VIRTUAL_CAP);
  const truncated = kept.length < files.length;

  const totalLogical = kept.reduce((s, e) => s + e.size, 0);
  const scale = totalLogical > containerSize && totalLogical > 0 ? containerSize / totalLogical : 1;

  const root: FileNode = {
    name: '', path: containerPath, size: 0, type: 'dir', children: [], modifiedAt: now, isHidden: false, virtual: true,
  };
  const dirIndex = new Map<string, FileNode>([['', root]]);

  const dirFor = (rel: string): FileNode => {
    const hit = dirIndex.get(rel);
    if (hit) return hit;
    const parent = dirFor(rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const node: FileNode = {
      name,
      path: containerPath + path.sep + rel.split('/').join(path.sep),
      size: 0,
      type: 'dir',
      children: [],
      modifiedAt: now,
      isHidden: name.startsWith('.'),
      virtual: true,
    };
    parent.children!.push(node);
    dirIndex.set(rel, node);
    return node;
  };

  for (const e of kept) {
    const rel = e.path;
    const parent = dirFor(rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const scaled = Math.max(1, Math.round(e.size * scale));
    const node: FileNode = {
      name,
      path: containerPath + path.sep + rel.split('/').join(path.sep),
      size: e.size > 0 ? scaled : 0,
      type: 'file',
      modifiedAt: now,
      isHidden: name.startsWith('.'),
      virtual: true,
    };
    if (scale !== 1) node.logicalSize = e.size;
    const ext = path.extname(name).toLowerCase().replace(/^\./, '');
    if (ext) node.extension = ext;
    parent.children!.push(node);
  }

  // Bottom-up dir sizes, mirroring the scanner.
  const sum = (n: FileNode): number => {
    if (n.type === 'file' || !n.children) return n.size;
    let t = 0;
    for (const c of n.children) t += sum(c);
    n.size = t;
    return t;
  };
  sum(root);

  return { children: root.children ?? [], entryCount: files.length, truncated };
}

/* ---------------- readers ---------------- */

function parseInWorker(kind: 'zip' | 'tar' | 'tgz', filePath: string): Promise<ArchiveListing> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'containerWorker.js'), { workerData: { kind, filePath } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new AppError(422, 'CONTAINER_TIMEOUT', 'Reading the archive directory took too long'));
    }, WORKER_TIMEOUT_MS);
    worker.once('message', (msg: { ok: boolean; listing?: ArchiveListing; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (msg.ok && msg.listing) resolve(msg.listing);
      else reject(new AppError(422, 'CONTAINER_UNREADABLE', msg.error ?? 'Could not read the archive'));
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(new AppError(500, 'CONTAINER_WORKER', err.message));
    });
  });
}

function exec(cmd: string, args: string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().slice(0, 300)));
      else resolve(stdout);
    });
  });
}

/** `bsdtar -tvf` line: "-rw-r--r--  0 user group   12345 Jan  1  2024 path/inside" */
export function parseBsdtarListing(stdout: string): ArchiveListing {
  const entries: ArchiveEntry[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^([dl-])[rwxsStT-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const [, type, size, rawPath] = m;
    if (type === 'l') continue; // symlinks inside images — skip
    const p = rawPath.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!p || p === '.') continue;
    entries.push({ path: p, size: Number(size) || 0, dir: type === 'd' });
    if (entries.length >= MAX_ENTRIES) return { entries, truncated: true };
  }
  return { entries, truncated: false };
}

async function listIso(filePath: string): Promise<ArchiveListing> {
  try {
    return parseBsdtarListing(await exec('bsdtar', ['-tvf', filePath]));
  } catch (err) {
    throw new AppError(422, 'CONTAINER_UNSUPPORTED',
      `Could not list this disk image${err instanceof Error && /ENOENT/.test(err.message) ? ' — bsdtar is not installed' : ''}. It can still be trashed or opened whole.`);
  }
}

/** Docker breakdown via the CLI: images / containers / volumes / build cache. */
async function listDocker(): Promise<ArchiveEntry[]> {
  let raw: string;
  try {
    raw = await exec('docker', ['system', 'df', '-v', '--format', 'json']);
  } catch {
    throw new AppError(422, 'CONTAINER_UNSUPPORTED',
      'Docker Desktop stores everything in this one file. Install/start the docker CLI to see the per-image breakdown.');
  }
  interface DockerDf {
    Images?: { Repository?: string; Tag?: string; Size?: string; UniqueSize?: string }[];
    Containers?: { Names?: string; Size?: string }[];
    Volumes?: { Name?: string; Size?: string }[];
    BuildCache?: { ID?: string; Size?: string }[];
  }
  const parseSize = (s?: string): number => {
    const m = /^([\d.]+)\s*(B|kB|KB|MB|GB|TB)/i.exec((s ?? '0B').trim());
    if (!m) return 0;
    const mult: Record<string, number> = { b: 1, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4 };
    return Math.round(Number(m[1]) * (mult[m[2].toLowerCase()] ?? 1));
  };
  const df = JSON.parse(raw) as DockerDf;
  const entries: ArchiveEntry[] = [];
  for (const img of df.Images ?? []) {
    entries.push({ path: `Images/${img.Repository ?? '<none>'}:${img.Tag ?? '<none>'}`, size: parseSize(img.UniqueSize ?? img.Size), dir: false });
  }
  for (const c of df.Containers ?? []) entries.push({ path: `Containers/${c.Names ?? 'unnamed'}`, size: parseSize(c.Size), dir: false });
  for (const v of df.Volumes ?? []) entries.push({ path: `Volumes/${v.Name ?? 'unnamed'}`, size: parseSize(v.Size), dir: false });
  for (const b of df.BuildCache ?? []) entries.push({ path: `Build cache/${b.ID ?? 'layer'}`, size: parseSize(b.Size), dir: false });
  return entries;
}

/* ---------------- public entry point ---------------- */

export interface ExpandResult {
  path: string;
  kind: ContainerKind;
  entryCount: number;
  truncated: boolean;
  cached: boolean;
  /** The grafted virtual subtree (also live in the scan tree). */
  children: FileNode[];
}

/** List a container's entries with the reader that matches its kind. */
async function listEntries(kind: ContainerKind, containerPath: string): Promise<{ entries: ArchiveEntry[]; truncated: boolean }> {
  if (kind === 'docker') {
    return { entries: await listDocker(), truncated: false };
  }
  if (kind === 'iso') {
    const listing = await listIso(containerPath);
    return { entries: listing.entries, truncated: listing.truncated };
  }
  const listing = await parseInWorker(kind as 'zip' | 'tar' | 'tgz', containerPath);
  return { entries: listing.entries, truncated: listing.truncated };
}

function registerExpanded(scanId: string, containerPath: string): void {
  let reg = expanded.get(scanId);
  if (!reg) { reg = new Set(); expanded.set(scanId, reg); }
  reg.add(containerPath);
}

/** The full (bounded — containers cap at VIRTUAL_CAP entries) subtree under a store node. */
function materializeChildren(store: ScanStore, id: number): FileNode[] {
  return store.prune(id, { maxNodes: Number.MAX_SAFE_INTEGER }).root.children ?? [];
}

/** expandContainer for store-backed scans: grafts land in the store. */
async function expandInStore(scan: ScanResult, store: ScanStore, containerPath: string): Promise<ExpandResult> {
  const nodeId = store.findByPath(containerPath);
  if (nodeId === -1) throw new AppError(404, 'PATH_NOT_FOUND', 'That path is not in this scan');
  const kind = store.container(nodeId) ?? detectContainerKind(store.name(nodeId), store.isDir(nodeId));
  if (!kind) throw new AppError(400, 'NOT_A_CONTAINER', 'That file is not a drillable container');
  if (store.flag(nodeId, Flag.Virtual)) throw new AppError(422, 'NESTED_CONTAINER', 'Archives inside archives can’t be opened without extracting the outer one');

  if (kind === 'photos') {
    // A Photos library is a real directory bundle the scanner already walked.
    return { path: containerPath, kind, entryCount: store.childCount(nodeId), truncated: false, cached: true, children: materializeChildren(store, nodeId) };
  }
  if (kind === 'dmg') {
    throw new AppError(422, 'CONTAINER_UNSUPPORTED', 'macOS disk images can’t be listed without mounting them. The .dmg can still be trashed or opened whole.');
  }
  if (store.childCount(nodeId) > 0) {
    return { path: containerPath, kind, entryCount: store.childCount(nodeId), truncated: false, cached: true, children: materializeChildren(store, nodeId) };
  }

  const { entries, truncated } = await listEntries(kind, containerPath);
  const built = entriesToChildren(entries, containerPath, store.size(nodeId), Date.now());
  store.ingestSubtree(nodeId, built.children); // graft — lives in the store for the scan's lifetime
  registerExpanded(scan.scanId, containerPath);

  return {
    path: containerPath,
    kind,
    entryCount: built.entryCount,
    truncated: truncated || built.truncated,
    cached: false,
    children: built.children,
  };
}

export async function expandContainer(scan: ScanResult & { root: FileNode }, containerPath: string): Promise<ExpandResult> {
  if (scan.store) return expandInStore(scan, scan.store, containerPath);

  const node = findNodeByPath(scan.root, containerPath);
  if (!node) throw new AppError(404, 'PATH_NOT_FOUND', 'That path is not in this scan');
  const kind = node.container ?? detectContainerKind(node.name, node.type === 'dir');
  if (!kind) throw new AppError(400, 'NOT_A_CONTAINER', 'That file is not a drillable container');
  if (node.virtual) throw new AppError(422, 'NESTED_CONTAINER', 'Archives inside archives can’t be opened without extracting the outer one');

  if (kind === 'photos') {
    // A Photos library is a real directory bundle the scanner already walked.
    return { path: containerPath, kind, entryCount: node.children?.length ?? 0, truncated: false, cached: true, children: node.children ?? [] };
  }
  if (kind === 'dmg') {
    throw new AppError(422, 'CONTAINER_UNSUPPORTED', 'macOS disk images can’t be listed without mounting them. The .dmg can still be trashed or opened whole.');
  }
  if (node.children && node.children.length) {
    return { path: containerPath, kind, entryCount: node.children.length, truncated: false, cached: true, children: node.children };
  }

  const { entries, truncated } = await listEntries(kind, containerPath);
  const built = entriesToChildren(entries, containerPath, node.size, Date.now());
  node.children = built.children; // graft — cached in the scan result for its lifetime
  registerExpanded(scan.scanId, containerPath);

  return {
    path: containerPath,
    kind,
    entryCount: built.entryCount,
    truncated: truncated || built.truncated,
    cached: false,
    children: built.children,
  };
}
