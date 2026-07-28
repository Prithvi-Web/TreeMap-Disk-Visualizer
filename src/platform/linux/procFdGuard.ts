import { promises as fsp } from 'fs';
import path from 'path';
import type { OpenHandleInfo, ZombieHandleInfo } from '../types';

/**
 * Open-handle (B2) and zombie-handle (B5) detection on Linux, straight from
 * `/proc`.
 *
 * Mechanism choice (§2.3): tier 1 in spirit — no subprocess at all. Every
 * `/proc/<pid>/fd/<n>` is a symlink to whatever that descriptor points at, and
 * `readlink` on it is an ordinary filesystem call. B2 explicitly calls this the
 * "faster no-subprocess path" for Linux, and it is: checking a 1,000-file delete
 * set costs one pass over /proc rather than spawning lsof.
 *
 * The kernel appends ` (deleted)` to the link target of an unlinked inode.
 * Unlike macOS (see ../macos/lsofGuard.ts, where no such marker exists) this is
 * authoritative, so B5 on Linux reads it directly rather than comparing inodes.
 *
 * ── Two traps this handles ──
 *
 * 1. **A filename can legitimately end in " (deleted)".** Trusting the suffix
 *    blindly would report a perfectly live file as reclaimable space. The
 *    stripped path is therefore confirmed against the inode behind the
 *    descriptor: if `/proc/<pid>/fd/<n>` still stats to the same inode as the
 *    path on disk, it is not deleted, whatever its name says.
 *
 * 2. **Processes disappear mid-scan.** /proc is a live view, so ENOENT while
 *    walking it is the normal case, not an error, and never aborts the pass.
 *
 * What this cannot see: descriptors held by other users' processes, unless
 * TreeMap runs as root — /proc/<pid>/fd is readable only by the owner. Reported
 * in the capability reason rather than presented as a complete answer.
 */

const DELETED_SUFFIX = ' (deleted)';

/** Numeric entries of /proc are the process ids. */
async function listPids(procRoot: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(procRoot);
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const name of entries) {
    if (name.length === 0 || name.charCodeAt(0) < 48 || name.charCodeAt(0) > 57) continue;
    const pid = Number.parseInt(name, 10);
    if (Number.isFinite(pid)) pids.push(pid);
  }
  return pids;
}

/** Process name from /proc/<pid>/comm, falling back to the pid itself. */
async function processName(procRoot: string, pid: number): Promise<string> {
  try {
    return (await fsp.readFile(path.join(procRoot, String(pid), 'comm'), 'utf8')).trim() || `pid ${String(pid)}`;
  } catch {
    return `pid ${String(pid)}`;
  }
}

export interface ProcFdRecord {
  pid: number;
  processName: string;
  /** Link target with any ` (deleted)` suffix removed. */
  path: string;
  /** True when the kernel marked the target as unlinked. */
  markedDeleted: boolean;
  /** The descriptor's own path under /proc, for stat-based confirmation. */
  fdPath: string;
}

/**
 * Every regular-file descriptor currently open, as seen from `/proc`.
 *
 * `procRoot` is injectable so the whole walk can be tested against a fixture
 * tree on any OS — which is the only way this Linux-only code gets covered by a
 * suite that also runs on macOS.
 */
export async function readOpenDescriptors(procRoot = '/proc'): Promise<ProcFdRecord[]> {
  const out: ProcFdRecord[] = [];

  for (const pid of await listPids(procRoot)) {
    const fdDir = path.join(procRoot, String(pid), 'fd');
    let fds: string[];
    try {
      fds = await fsp.readdir(fdDir);
    } catch {
      continue; // owned by another user, or the process just exited
    }

    let name: string | null = null;
    for (const fd of fds) {
      const fdPath = path.join(fdDir, fd);
      let target: string;
      try {
        target = await fsp.readlink(fdPath);
      } catch {
        continue; // descriptor closed between readdir and readlink
      }
      // Sockets, pipes, epoll and anon inodes are not files on disk.
      if (!target.startsWith('/')) continue;

      const markedDeleted = target.endsWith(DELETED_SUFFIX);
      const resolved = markedDeleted ? target.slice(0, -DELETED_SUFFIX.length) : target;
      // /proc, /sys and /dev descriptors are not user data and only add noise.
      if (resolved.startsWith('/proc/') || resolved.startsWith('/sys/') || resolved.startsWith('/dev/')) continue;

      name ??= await processName(procRoot, pid);
      out.push({ pid, processName: name, path: resolved, markedDeleted, fdPath });
    }
  }
  return out;
}

/**
 * Which processes hold any of `paths` — **or anything beneath them** — open.
 *
 * One /proc pass covers the whole set whatever its size, and descendants come
 * free from prefix matching: the walk already reads every descriptor on the
 * system, so restricting it to exact paths would discard the very information
 * that makes trashing a folder safe. macOS reaches the same contract through a
 * full `lsof` dump (see ../macos/lsofGuard.ts) — different mechanism, identical
 * guarantee, which is what §11.1 asks for.
 */
export async function openHandlesFor(paths: string[], procRoot = '/proc'): Promise<OpenHandleInfo[]> {
  if (paths.length === 0) return [];

  // Compare against realpaths: a descriptor opened through a symlinked
  // directory reports the resolved target, exactly as lsof does on macOS.
  const wanted: (readonly [string, string])[] = [];
  for (const p of paths) {
    let real = p;
    try {
      real = await fsp.realpath(p);
    } catch {
      /* already gone — keep the literal path so a stale entry still matches */
    }
    wanted.push([real, p]);
    if (real !== p) wanted.push([p, p]);
  }

  return intersectHandles(await readOpenDescriptors(procRoot), wanted);
}

/**
 * Intersect open descriptors with the delete set, matching descendants.
 *
 * Pure and exported for the same reason as its macOS counterpart: the matching
 * rule is where the correctness lives, and a fixture can exercise it on any OS.
 */
export function intersectHandles(
  records: readonly ProcFdRecord[],
  wanted: readonly (readonly [resolved: string, requested: string])[],
): OpenHandleInfo[] {
  const exact = new Map(wanted);
  // Trailing separator so deleting `/a/logs` never claims `/a/logs-archive/x`.
  const prefixes = wanted.map(([resolved, requested]) => [`${resolved.replace(/\/+$/, '')}/`, requested] as const);

  const seen = new Set<string>();
  const out: OpenHandleInfo[] = [];
  for (const rec of records) {
    if (rec.markedDeleted) continue; // an unlinked inode blocks no delete

    let requested = exact.get(rec.path);
    if (requested === undefined) {
      let best = '';
      for (const [prefix, asked] of prefixes) {
        if (rec.path.startsWith(prefix) && prefix.length > best.length) {
          best = prefix;
          requested = asked;
        }
      }
      if (requested === undefined) continue;
    }

    const key = `${String(rec.pid)}\0${requested}\0${rec.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: requested, pid: rec.pid, processName: rec.processName, openPath: rec.path });
  }
  return out;
}

/**
 * Unlinked-but-open inodes, and the space they are still holding.
 *
 * The size comes from stat'ing the descriptor itself (`/proc/<pid>/fd/<n>`),
 * not the path — the path is gone, which is the whole point. That gives the
 * real byte count rather than an estimate.
 */
export async function zombieHandles(procRoot = '/proc'): Promise<ZombieHandleInfo[]> {
  const out: ZombieHandleInfo[] = [];
  const seen = new Set<string>();

  for (const rec of await readOpenDescriptors(procRoot)) {
    if (!rec.markedDeleted) continue;

    let bytes: number | null = null;
    let ino: number | null = null;
    try {
      // /proc/<pid>/fd/<n> is a magic symlink: stat() resolves to the open
      // file itself, and keeps working after the name is unlinked. That is what
      // makes the byte count exact rather than an estimate.
      const st = await fsp.stat(rec.fdPath);
      bytes = st.size;
      ino = st.ino;
    } catch {
      /* the process exited mid-pass — handled below, without guessing */
    }

    // Trap 1: a file genuinely named "notes (deleted)" is not a zombie.
    if (ino !== null) {
      // Authoritative: the descriptor's inode against whatever is at that path
      // now. Same inode means the suffix was part of the name.
      const stillThere = await fsp.stat(rec.path).then((st) => st.ino === ino, () => false);
      if (stillThere) continue;
    } else {
      // The descriptor could not be stat'ed, so the inode comparison is
      // unavailable. Claiming a zombie here would be asserting something
      // unverified — §10's "reporting a number you can't verify". Fall back to
      // the weaker but honest test: if a file still exists at that path, assume
      // the name simply ends in " (deleted)" and stay quiet.
      const pathExists = await fsp.stat(rec.path).then(() => true, () => false);
      if (pathExists) continue;
    }

    // One inode held on many descriptors is one leak, not several.
    const key = `${String(rec.pid)}\0${ino !== null ? String(ino) : rec.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pid: rec.pid, processName: rec.processName, path: rec.path, bytes });
  }
  return out;
}
