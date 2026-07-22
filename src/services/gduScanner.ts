import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileNode, ScanResult } from '../models/types';
import { mapGduTree } from './gduMapper';
import { detectContainerKind } from '../utils/containerKind';
import { neverDescend } from '../utils/mountBoundaries';

/**
 * The gdu turbo engine.
 *
 * gdu (github.com/dundee/gdu, MIT) walks a tree at ~124-129k items/sec on this
 * hardware versus the Node walker's 69-97k, and far more consistently (the
 * walker's run-to-run spread on an identical tree measured 39%; gdu's was ~4%).
 *
 * Two measured facts shape this design:
 *
 * 1. gdu emits NO progress when its stdout is a pipe (it only prints to a TTY),
 *    and it writes its JSON in a single burst at the very end — the output file
 *    sits at 0 bytes for the whole walk. A single run over 5M items would mean a
 *    ~40-second blind spinner, replacing the walker's live item counter with
 *    nothing. Perceived slowness is exactly what got the previous scan rework
 *    rolled back, so instead we shard by top-level directory: ~8% slower
 *    (measured 3.83s vs 3.55s on 458k, still ~112k items/sec) in exchange for
 *    live progress, per-shard memory release, and a cancellation checkpoint.
 *
 * 2. Streaming JSON parsing is the wrong tool despite what one might assume from
 *    the payload size. JSON.parse handles 5M nodes in 1.68s at 1.7 GB RSS;
 *    stream-json would cost 8-20s and blow the entire throughput budget. The
 *    real constraint is V8's ~512 MB cap on a single string, which sharding
 *    keeps us far away from, backstopped by MAX_SHARD_BYTES.
 */

/** Refuse a shard whose JSON approaches V8's ~512 MB single-string ceiling. */
const MAX_SHARD_BYTES = 450 * 1024 * 1024;

/**
 * Hard ceiling per gdu subprocess. gdu moves at ~112k+ items/sec, so five
 * minutes covers a ~30M-item shard — nothing real gets close. What DOES
 * happen without it: a blocking open() on an automount trigger or a dead
 * mount parks gdu at 0% CPU forever and the scan never finishes. --no-cross
 * prevents the known cases; this is the net for the unknown ones, and a
 * timeout falls back to the walker like every other gdu failure.
 */
const SHARD_TIMEOUT_MS = 5 * 60 * 1000;

export interface FindOptions {
  bundledPath?: string;
  /** Set false to test the "nothing installed" path deterministically. */
  pathLookup?: boolean;
}

/**
 * Where a bundled gdu might live, most-specific first.
 *
 * Note `process.resourcesPath` is only meaningful in a packaged Electron app —
 * under `electron .` in dev it points at Electron's OWN resources, not ours, so
 * the repo-relative candidate has to be checked too or dev silently loses the
 * engine.
 */
function bundledCandidates(): string[] {
  const exe = process.platform === 'win32' ? 'gdu.exe' : 'gdu';
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const out: string[] = [];
  if (resources) out.push(path.join(resources, 'gdu', exe));
  // dist/services/.. /.. and src/services/.. /.. both land on the repo root.
  out.push(path.join(__dirname, '..', '..', 'gdu', exe));
  return out;
}

/**
 * Locate a gdu binary: a bundled copy first, then $PATH so contributors running
 * `npm run dev` can use the engine without the bundling step.
 *
 * Returns null rather than throwing — a missing binary is an ordinary condition
 * that falls back to the walker, not an error.
 */
export async function findGduBinary(opts: FindOptions = {}): Promise<string | null> {
  const bundled = opts.bundledPath ? [opts.bundledPath] : bundledCandidates();
  for (const candidate of bundled) {
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }

  if (opts.pathLookup === false) return null;

  const exe = process.platform === 'win32' ? 'gdu.exe' : 'gdu';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      const candidate = path.join(dir, exe);
      await fsp.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Spawn gdu for one directory, exporting JSON to `outFile`.
 *
 * execFile with an argv array — never `exec` with a string and never
 * shell: true — because `dir` originates in user input.
 */
export function runGdu(
  bin: string,
  dir: string,
  outFile: string,
  opts: { ignoreDirs?: string[]; timeoutMs?: number } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    // -x: never cross filesystem boundaries — inside a shard this skips
    // nested mounts (DMGs, /System/Volumes/*) that double-count the disk or
    // hang on network I/O. Skipped mount roots simply don't appear in the
    // shard's output, matching the walker's don't-descend behavior.
    const args = ['-n', '-x', '-o', outFile];
    if (opts.ignoreDirs?.length) args.push('-i', opts.ignoreDirs.join(','));
    args.push(dir);
    const timeout = opts.timeoutMs ?? SHARD_TIMEOUT_MS;
    execFile(bin, args, { maxBuffer: 1 << 20, timeout, killSignal: 'SIGKILL' }, (err) => {
      if (err) {
        reject(
          new Error(
            err.killed
              ? `gdu timed out after ${Math.round(timeout / 60000)} min on ${dir} — likely a blocking mount`
              : `gdu failed: ${err.message}`,
          ),
        );
      } else resolve();
    });
  });
}

/**
 * Build a leaf FileNode for something sitting directly under the scan root.
 *
 * These do not pass through gdu (they are stat'ed directly, since there are few
 * of them and spawning a whole subprocess for them would be wasteful), so every
 * enrichment gdu's shards get must be reproduced here or the two halves of a
 * scan disagree. A parity test caught exactly that: a hard link at the root
 * counted full against its twin inside a shard, inflating the total by the file's
 * whole size.
 *
 * The inode key is `ino` ALONE, deliberately — it must share a key space with
 * mapGduTree, which only has `ino` to work with (gdu emits no `dev`). Keying
 * `dev:ino` here, as the walker does, would never collide with a shard's entry.
 */
async function statLeaf(
  parent: string,
  name: string,
  isSymlink: boolean,
  seenInodes: Set<number>,
  cloudProviderFor: (p: string) => 'icloud' | 'onedrive' | 'dropbox' | undefined,
): Promise<{ node: FileNode; hardlinkedBytes: number } | null> {
  const p = parent === '/' ? '/' + name : parent + '/' + name;
  try {
    const st = await fsp.lstat(p);
    const node: FileNode = {
      name,
      path: p,
      size: st.size,
      type: 'file',
      modifiedAt: Math.round(st.mtimeMs),
      isHidden: name.charCodeAt(0) === 46,
    };
    const dot = name.lastIndexOf('.');
    if (dot > 0 && dot < name.length - 1) node.extension = name.slice(dot + 1).toLowerCase();

    const container = detectContainerKind(name, false);
    if (container) node.container = container;

    if (isSymlink) {
      node.isSymlink = true;
      return { node, hardlinkedBytes: 0 };
    }

    // Same rule as the mapper: only files whose link count exceeds 1 can be
    // duplicates, so only they claim an inode.
    if (st.nlink > 1) {
      if (seenInodes.has(st.ino)) {
        node.hardlinkDuplicate = true;
        const bytes = node.size;
        node.size = 0;
        return { node, hardlinkedBytes: bytes };
      }
      seenInodes.add(st.ino);
    }

    if (node.size > 0 && st.blocks === 0) {
      const provider = cloudProviderFor(p);
      if (provider) {
        node.cloudPlaceholder = true;
        node.cloudProvider = provider;
      }
    }

    return { node, hardlinkedBytes: 0 };
  } catch {
    return null; // vanished mid-scan
  }
}

/**
 * Scan `scan.rootPath` with gdu, one subprocess per top-level directory.
 * Mutates the scan's counters as shards land so the SSE progress stream keeps
 * moving. Throws on any failure — callers fall back to the walker.
 */
export async function gduScan(
  scan: ScanResult,
  bin: string,
  cloudProviderFor: (p: string) => 'icloud' | 'onedrive' | 'dropbox' | undefined,
): Promise<FileNode> {
  const rootPath = scan.rootPath;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-gdu-'));
  // Shared across shards: a hard link spanning two top-level dirs must still be
  // counted once.
  const seenInodes = new Set<number>();

  try {
    const entries = await fsp.readdir(rootPath, { withFileTypes: true });
    const rootStat = await fsp.lstat(rootPath);
    const childPath = (name: string): string => (rootPath === '/' ? '/' + name : rootPath + '/' + name);
    const allDirs = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink());
    // Mount re-entry points and automount triggers never get a shard —
    // spawning gdu against them double-counts the disk or blocks forever.
    // They stay visible as empty dirs, exactly like the walker leaves them.
    const dirs = allDirs.filter((e) => !neverDescend(childPath(e.name)));

    const children: FileNode[] = [];
    let total = 0;

    for (const e of allDirs) {
      const p = childPath(e.name);
      if (!neverDescend(p)) continue;
      children.push({
        name: e.name,
        path: p,
        size: 0,
        type: 'dir',
        modifiedAt: Math.round(rootStat.mtimeMs),
        isHidden: e.name.charCodeAt(0) === 46,
        children: [],
      });
      scan.dirCount++;
    }

    // Files directly under the root: few, so stat them rather than paying for a
    // whole extra gdu process. They share `seenInodes` with the shards below, so
    // a hard link spanning the root and a subdirectory is still counted once.
    for (const e of entries) {
      if (e.isDirectory() && !e.isSymbolicLink()) continue;
      const leaf = await statLeaf(rootPath, e.name, e.isSymbolicLink(), seenInodes, cloudProviderFor);
      if (!leaf) continue;
      children.push(leaf.node);
      total += leaf.node.size;
      scan.fileCount++;
      if (leaf.node.hardlinkDuplicate) {
        scan.hardlinkedFiles = (scan.hardlinkedFiles ?? 0) + 1;
        scan.hardlinkedBytes = (scan.hardlinkedBytes ?? 0) + leaf.hardlinkedBytes;
      }
      if (leaf.node.cloudPlaceholder) {
        scan.cloudFiles = (scan.cloudFiles ?? 0) + 1;
        scan.cloudBytes = (scan.cloudBytes ?? 0) + leaf.node.size;
      }
    }
    scan.scanned = scan.fileCount;

    for (let i = 0; i < dirs.length; i++) {
      if (scan.cancelled) throw new Error('cancelled');
      const dirPath = childPath(dirs[i].name);
      scan.currentPath = dirPath;

      const outFile = path.join(tmpDir, `shard-${i}.json`);
      await runGdu(bin, dirPath, outFile);

      const st = await fsp.stat(outFile);
      if (st.size > MAX_SHARD_BYTES) {
        throw new Error(
          `gdu output for ${dirPath} is ${Math.round(st.size / 1048576)} MB, beyond the ` +
            '~512 MB single-string ceiling — falling back to the walker',
        );
      }

      const parsed = JSON.parse(await fsp.readFile(outFile, 'utf8'));
      const { root: sub, stats } = mapGduTree(parsed, dirPath, { seenInodes, cloudProviderFor });
      // Release the shard's JSON before the next one is read.
      await fsp.unlink(outFile).catch(() => {});

      children.push(sub);
      total += sub.size;
      scan.fileCount += stats.fileCount;
      scan.dirCount += stats.dirCount;
      scan.hardlinkedFiles = (scan.hardlinkedFiles ?? 0) + stats.hardlinkedFiles;
      scan.hardlinkedBytes = (scan.hardlinkedBytes ?? 0) + stats.hardlinkedBytes;
      scan.cloudFiles = (scan.cloudFiles ?? 0) + stats.cloudFiles;
      scan.cloudBytes = (scan.cloudBytes ?? 0) + stats.cloudBytes;
      scan.scanned = scan.fileCount + scan.dirCount;
    }

    scan.dirCount++; // the root itself
    scan.scanned = scan.fileCount + scan.dirCount;
    scan.currentPath = rootPath;

    const name = rootPath.slice(rootPath.lastIndexOf('/') + 1) || rootPath;
    return {
      name,
      path: rootPath,
      size: total,
      type: 'dir',
      modifiedAt: Math.round(rootStat.mtimeMs),
      isHidden: name.charCodeAt(0) === 46,
      children,
    };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
