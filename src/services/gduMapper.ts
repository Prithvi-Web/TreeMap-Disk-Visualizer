import { FileNode } from '../models/types';
import { detectContainerKind } from '../utils/containerKind';
import { ScanStore, NodeInput, Flag } from './scanStore';

/**
 * gdu's JSON export -> TreeMap's FileNode.
 *
 * Schema verified against RECORDED real gdu v5.36.1 output (tests/fixtures),
 * not from documentation — the integration prompt got several details wrong:
 *
 *   document = [1, 2, {header}, <dirNode>]
 *   dirNode  = [metaObj, ...children]   <-- FLAT. The prompt claimed
 *                                           [meta, childrenArray]; its sample had
 *                                           one child per dir, hiding the bug.
 *   fileNode = { name, asize?, dsize?, mtime, notreg?, ino?, hlnkc? }
 *
 * Details that matter:
 *   - `asize`/`dsize` are OMITTED when zero — always default them or you get NaN.
 *   - directories carry NO size; it is summed here.
 *   - `mtime` is Unix seconds; FileNode.modifiedAt is milliseconds.
 *   - `ino` + `hlnkc` are emitted only when the link count is >1 — the same
 *     optimization the walker makes (`stat.nlink > 1`). Deduping on them
 *     reproduces the walker's byte total exactly (verified on /Applications:
 *     30,070,595,907 both ways, 21,499 hard links both ways). Naive counting is
 *     1.972% high, so this is required, not optional.
 *
 * Hot path: deliberately no `path.join` and no `path.extname`. Both are ~20x
 * slower than the raw string ops used here (787ms vs 39ms per 458k nodes) and
 * this runs once per node — at 5M nodes that difference is the whole budget.
 */

export interface GduMapStats {
  fileCount: number;
  dirCount: number;
  hardlinkedFiles: number;
  hardlinkedBytes: number;
  cloudFiles: number;
  cloudBytes: number;
}

interface GduMeta {
  name: string;
  mtime: number;
}

interface GduFile {
  name: string;
  asize?: number;
  dsize?: number;
  mtime: number;
  /** Not a regular file (symlink, socket, fifo). */
  notreg?: boolean;
  /** Inode — present only alongside hlnkc. */
  ino?: number;
  /** Hard-link count > 1. */
  hlnkc?: boolean;
}

type GduEntry = GduDir | GduFile;
type GduDir = [GduMeta, ...GduEntry[]];

export interface GduMapOptions {
  /**
   * Shared across shards so a hard link spanning two top-level directories is
   * still counted once. gdu gives `ino` but no `dev`, so the key is inode-only:
   * exact within one volume (the overwhelming case), and documented as a known
   * limit for scans that span volumes.
   */
  seenInodes?: Set<number>;
  /** Injected to keep this module pure and testable without touching disk. */
  cloudProviderFor?: (p: string) => 'icloud' | 'onedrive' | 'dropbox' | undefined;
}

/**
 * @param doc      a parsed gdu document ([1,2,{header},dir]) or a bare dir node
 * @param rootPath absolute path this tree is rooted at
 */
export function mapGduTree(
  doc: unknown,
  rootPath: string,
  opts: GduMapOptions = {},
): { root: FileNode; stats: GduMapStats } {
  const stats: GduMapStats = {
    fileCount: 0,
    dirCount: 0,
    hardlinkedFiles: 0,
    hardlinkedBytes: 0,
    cloudFiles: 0,
    cloudBytes: 0,
  };
  const seen = opts.seenInodes ?? new Set<number>();
  const cloudFor = opts.cloudProviderFor;

  // Accept either the full document or a bare directory node.
  const arr = doc as unknown[];
  const dirNode = (Array.isArray(arr) && typeof arr[0] === 'number' ? arr[3] : arr) as GduDir;

  // gdu labels the scanned root with its full path; children carry bare names.
  const rootAbs = rootPath.length > 1 && rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;

  function buildFile(o: GduFile, parent: string): FileNode {
    stats.fileCount++;
    const name = o.name;
    const p = parent === '/' ? '/' + name : parent + '/' + name;
    const size = o.asize || 0;

    const node: FileNode = {
      name,
      path: p,
      size,
      type: 'file',
      modifiedAt: o.mtime * 1000,
      isHidden: name.charCodeAt(0) === 46,
    };

    // A leading dot is not an extension — matches path.extname('.bashrc') === ''.
    const dot = name.lastIndexOf('.');
    if (dot > 0 && dot < name.length - 1) node.extension = name.slice(dot + 1).toLowerCase();

    const container = detectContainerKind(name, false);
    if (container) node.container = container;

    if (o.notreg) {
      // Symlink/socket/fifo: recorded as a leaf, never followed — same as the
      // walker's lstat behaviour and gdu's default (no -L).
      node.isSymlink = true;
      return node;
    }

    if (o.hlnkc && o.ino !== undefined) {
      if (seen.has(o.ino)) {
        node.hardlinkDuplicate = true;
        stats.hardlinkedFiles++;
        stats.hardlinkedBytes += size;
        node.size = 0; // the first occurrence already carried these bytes
        return node;
      }
      seen.add(o.ino);
    }

    // Cloud placeholder: a logical size but no allocated blocks (gdu omits dsize
    // when zero). Gated on a known cloud folder so plain sparse files — VM
    // images, database files — are never mislabelled "safe to delete".
    if (size > 0 && !o.dsize && cloudFor) {
      const provider = cloudFor(p);
      if (provider) {
        node.cloudPlaceholder = true;
        node.cloudProvider = provider;
        stats.cloudFiles++;
        stats.cloudBytes += size;
      }
    }

    return node;
  }

  function buildDir(d: GduDir, parent: string | null): FileNode {
    stats.dirCount++;
    const meta = d[0];
    const isRoot = parent === null;
    const p = isRoot ? rootAbs : parent === '/' ? '/' + meta.name : parent + '/' + meta.name;
    const name = isRoot ? rootAbs.slice(rootAbs.lastIndexOf('/') + 1) || rootAbs : meta.name;

    const children: FileNode[] = [];
    let total = 0;
    for (let i = 1; i < d.length; i++) {
      const c = d[i];
      const child = Array.isArray(c) ? buildDir(c as GduDir, p) : buildFile(c as GduFile, p);
      total += child.size;
      children.push(child);
    }

    const node: FileNode = {
      name,
      path: p,
      size: total,
      type: 'dir',
      modifiedAt: meta.mtime * 1000,
      isHidden: name.charCodeAt(0) === 46,
      // MUST stay [] rather than undefined when empty — the empty-folder finder
      // keys off it.
      children,
    };

    for (const c of children) {
      if (c.name === '.git') {
        node.gitRepo = true;
        break;
      }
    }
    const container = detectContainerKind(name, true);
    if (container) node.container = container;

    return node;
  }

  return { root: buildDir(dirNode, null), stats };
}

/**
 * mapGduTree, but building straight into a ScanStore under `parentId` —
 * no intermediate FileNode objects at all. Mapping rules are identical
 * (hardlink dedup on inode alone, dsize-gated cloud detection, `.git`
 * marking, the no-`path.join` string ops). Paths are only assembled for the
 * few files that need a cloud-provider check; the store derives every other
 * path from its parent chain.
 *
 * Returns the id of the shard's root dir plus the same stats as mapGduTree.
 */
export function mapGduTreeIntoStore(
  doc: unknown,
  rootPath: string,
  store: ScanStore,
  parentId: number,
  opts: GduMapOptions = {},
): { rootId: number; stats: GduMapStats } {
  const stats: GduMapStats = {
    fileCount: 0,
    dirCount: 0,
    hardlinkedFiles: 0,
    hardlinkedBytes: 0,
    cloudFiles: 0,
    cloudBytes: 0,
  };
  const seen = opts.seenInodes ?? new Set<number>();
  const cloudFor = opts.cloudProviderFor;

  const arr = doc as unknown[];
  const dirNode = (Array.isArray(arr) && typeof arr[0] === 'number' ? arr[3] : arr) as GduDir;

  const rootAbs = rootPath.length > 1 && rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;

  function addFile(o: GduFile, parentDirId: number, parentPath: string): void {
    stats.fileCount++;
    const name = o.name;
    const size = o.asize || 0;

    const input: NodeInput = {
      name,
      isDir: false,
      size,
      modifiedAt: o.mtime * 1000,
      isHidden: name.charCodeAt(0) === 46,
    };

    // A leading dot is not an extension — matches path.extname('.bashrc') === ''.
    const dot = name.lastIndexOf('.');
    if (dot > 0 && dot < name.length - 1) input.extension = name.slice(dot + 1).toLowerCase();

    const container = detectContainerKind(name, false);
    if (container) input.container = container;

    if (o.notreg) {
      input.isSymlink = true;
      store.addNode(parentDirId, input);
      return;
    }

    if (o.hlnkc && o.ino !== undefined) {
      if (seen.has(o.ino)) {
        input.hardlinkDuplicate = true;
        stats.hardlinkedFiles++;
        stats.hardlinkedBytes += size;
        input.size = 0; // the first occurrence already carried these bytes
        store.addNode(parentDirId, input);
        return;
      }
      seen.add(o.ino);
    }

    if (size > 0 && !o.dsize && cloudFor) {
      const p = parentPath === '/' ? '/' + name : parentPath + '/' + name;
      const provider = cloudFor(p);
      if (provider) {
        input.cloudPlaceholder = true;
        input.cloudProvider = provider;
        stats.cloudFiles++;
        stats.cloudBytes += size;
      }
    }

    store.addNode(parentDirId, input);
  }

  function addDir(d: GduDir, under: number, parentPath: string | null): number {
    stats.dirCount++;
    const meta = d[0];
    const isRoot = parentPath === null;
    const p = isRoot ? rootAbs : parentPath === '/' ? '/' + meta.name : parentPath + '/' + meta.name;
    const name = isRoot ? rootAbs.slice(rootAbs.lastIndexOf('/') + 1) || rootAbs : meta.name;

    const dirId = store.addNode(under, {
      name,
      isDir: true,
      size: 0,
      modifiedAt: meta.mtime * 1000,
      isHidden: name.charCodeAt(0) === 46,
      container: detectContainerKind(name, true),
    });

    let sawGit = false;
    for (let i = 1; i < d.length; i++) {
      const c = d[i];
      if (Array.isArray(c)) {
        const sub = c as GduDir;
        if (sub[0].name === '.git') sawGit = true;
        addDir(sub, dirId, p);
      } else {
        if ((c as GduFile).name === '.git') sawGit = true;
        addFile(c as GduFile, dirId, p);
      }
    }
    if (sawGit) store.setFlag(dirId, Flag.GitRepo, true);

    return dirId;
  }

  return { rootId: addDir(dirNode, parentId, null), stats };
}
