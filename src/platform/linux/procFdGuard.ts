import { promises as fsp } from 'fs';
import path from 'path';
import type { OpenHandleInfo, ZombieHandleInfo, ZombieHandleScan } from '../types';
import { meansAbsent } from '../../utils/errno';

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

/**
 * Numeric entries of /proc are the process ids.
 *
 * A failure to read /proc is rethrown rather than answered with `[]`. No pids
 * means no descriptors means no conflicts, which `checkOpenHandles` would
 * report as `checked: true` with a clean result — "nothing is open", from a
 * probe that never ran. That is the one answer this module's contract forbids,
 * and the `checked: false` state it should produce instead already exists.
 * (The per-pid `continue` further down is a different case and stays: another
 * user's process is genuinely unreadable, and the capability reason says so.
 * The held-space pass counts the ones it answers for — `scanOpenDescriptors`.)
 */
async function listPids(procRoot: string): Promise<number[]> {
  const entries: string[] = await fsp.readdir(procRoot);
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

/** The process exited, or the descriptor closed, between one call and the next: /proc's normal case. */
function wentAway(err: unknown): boolean {
  return meansAbsent(err) || (err as NodeJS.ErrnoException | null)?.code === 'ESRCH';
}

/** What one walk of /proc read (`scanOpenDescriptors`). */
export interface ProcFdScan {
  records: ProcFdRecord[];
  /**
   * The programs whose open files it could not read — their fd folder, or a
   * descriptor in it, refused — each once; never one that went away
   * meanwhile (the BQL-a review, F1.4).
   */
  refused: number[];
}

/**
 * Every regular-file descriptor currently open, as seen from `/proc`.
 *
 * `procRoot` is injectable so the whole walk can be tested against a fixture
 * tree on any OS — which is the only way this Linux-only code gets covered by a
 * suite that also runs on macOS.
 */
export async function readOpenDescriptors(procRoot = '/proc'): Promise<ProcFdRecord[]> {
  return (await scanOpenDescriptors(procRoot)).records;
}

/**
 * `readOpenDescriptors`, with the programs whose open files it could not read
 * (the BQL-a review, F1.4). /proc/<pid>/fd is readable only by the account a
 * program runs as — and not even by that account when the program made itself
 * not dumpable, as ssh-agent does, since its /proc entries are then root's.
 * The walk passed over every such folder unseen, so the held-space pass said
 * none of your programs held a deleted file while ssh-agent might have.
 */
export async function scanOpenDescriptors(procRoot = '/proc'): Promise<ProcFdScan> {
  const out: ProcFdRecord[] = [];
  const refused: number[] = [];

  for (const pid of await listPids(procRoot)) {
    const fdDir = path.join(procRoot, String(pid), 'fd');
    let fds: string[];
    try {
      fds = await fsp.readdir(fdDir);
    } catch (err) {
      // Exited, or refused: another account's program, or one of this account that is not dumpable.
      if (!wentAway(err)) refused.push(pid);
      continue;
    }

    let name: string | null = null;
    let unread = false;
    for (const fd of fds) {
      const fdPath = path.join(fdDir, fd);
      let target: string;
      try {
        target = await fsp.readlink(fdPath);
      } catch (err) {
        if (!wentAway(err)) unread = true; // refused, not closed between readdir and readlink
        continue;
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
    if (unread) refused.push(pid);
  }
  return { records: out, refused };
}

/**
 * Whether the held-space pass answers for a program whose open files it could
 * not read (the BQL-a review, F1.4): one running as `uid` — its effective id,
 * from /proc/<pid>/status, which every account may read — any when `uid` is
 * root's, and one whose account cannot be read, never assumed another
 * account's. Not one that exited meanwhile: it holds nothing now.
 */
async function answersFor(procRoot: string, pid: number, uid: number | null): Promise<boolean> {
  let status: string;
  try {
    status = await fsp.readFile(path.join(procRoot, String(pid), 'status'), 'utf8');
  } catch (err) {
    return !wentAway(err); // refused too (a /proc mounted with hidepid): whose it is cannot be read
  }
  if (uid === 0) return true;
  const effective = /^Uid:\s+\d+\s+(\d+)/m.exec(status)?.[1];
  return uid === null || effective === undefined || Number(effective) === uid;
}

/** How many of the programs a walk could not read (`ProcFdScan.refused`) TreeMap answers for (`answersFor`). */
async function unreadableProgramsOf(procRoot: string, refused: readonly number[], uid: number | null): Promise<number> {
  let count = 0;
  for (const pid of refused) if (await answersFor(procRoot, pid, uid)) count++;
  return count;
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
  const wanted = await wantedOf(paths);
  return intersectHandles(await readOpenDescriptors(procRoot), wanted);
}

/**
 * `openHandlesFor`, with how many programs TreeMap answers for whose open files the walk could not read
 * (the BQL-a review, F2.3) — one of `uid`'s that made itself not dumpable, as ssh-agent does; one whose
 * account cannot be read; any when `uid` is root's — as the held-space pass counts them (`answersFor`). A
 * file such a program holds is not among `handles`, so the delete-time guard must not answer as if it had
 * seen everything. Another account's program is outside what the guard says it sees, and is not counted.
 */
export async function openHandleScanFor(
  paths: string[],
  procRoot = '/proc',
  uid: number | null = process.getuid?.() ?? null,
): Promise<{ handles: OpenHandleInfo[]; unreadablePrograms: number }> {
  if (paths.length === 0) return { handles: [], unreadablePrograms: 0 };
  const wanted = await wantedOf(paths);
  const walk = await scanOpenDescriptors(procRoot);
  return { handles: intersectHandles(walk.records, wanted), unreadablePrograms: await unreadableProgramsOf(procRoot, walk.refused, uid) };
}

/** The open-file guard's words for `n` programs whose open files it could not read (`openHandleScanFor`). */
export function openFilesUnreadReason(n: number): string {
  const one = n === 1;
  return `TreeMap could not read which files ${String(n)} ${one ? 'program has' : 'programs have'} open — a program can keep them even from the account it runs as, as ssh-agent does — so a file ${one ? 'it holds' : 'they hold'} open may be in use without being listed.`;
}

/** Each path with its realpath first, the way the walk's descriptors spell what they point at. */
async function wantedOf(paths: readonly string[]): Promise<(readonly [string, string])[]> {
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
  return wanted;
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
 *
 * `statOf` is the stat both lookups go through, injectable so a test can make
 * the descriptor answer while the path refuses — the case a real /proc gives
 * and a fixture cannot (QA D17).
 */
export async function zombieHandles(
  procRoot = '/proc',
  statOf: (p: string) => Promise<{ ino: number; size: number }> = (p) => fsp.stat(p),
): Promise<ZombieHandleInfo[]> {
  return (await zombieHandleScan(procRoot, statOf)).handles;
}

/**
 * zombieHandles, with how many held files it could not decide (BQL item 11) and how many programs it
 * answers for whose open files it could not read (the BQL-a review, F1.4). `uid` is the account TreeMap
 * runs as, injectable so a test can stand another in.
 */
export async function zombieHandleScan(
  procRoot = '/proc',
  statOf: (p: string) => Promise<{ ino: number; size: number }> = (p) => fsp.stat(p),
  uid: number | null = process.getuid?.() ?? null,
): Promise<ZombieHandleScan> {
  const out: ZombieHandleInfo[] = [];
  const seen = new Set<string>();
  // The held files it could not decide, each once however many descriptors and programs hold it (BQL item 11).
  const undecided = new Set<string>();
  const walk = await scanOpenDescriptors(procRoot);

  for (const rec of walk.records) {
    if (!rec.markedDeleted) continue;

    let bytes: number | null = null;
    let ino: number | null = null;
    try {
      // /proc/<pid>/fd/<n> is a magic symlink: stat() resolves to the open
      // file itself, and keeps working after the name is unlinked. That is what
      // makes the byte count exact rather than an estimate.
      const st = await statOf(rec.fdPath);
      bytes = st.size;
      ino = st.ino;
    } catch {
      /* the process exited mid-pass — handled below, without guessing */
    }

    // What is at that path now: its inode, 'gone' (no such file), or 'unknown'
    // when TreeMap could not look. Permission denied says nothing about whether
    // the file is still there (QA D17), so an unknown is never claimed.
    const now = await statOf(rec.path).then(
      (st) => st.ino,
      (err: unknown) => (meansAbsent(err) ? 'gone' as const : 'unknown' as const),
    );
    if (now === 'unknown') {
      // Counted only while its descriptor still answers: one that went away mid-pass holds nothing now.
      if (ino !== null) undecided.add(`${String(ino)}\0${rec.path}`);
      continue;
    }

    // Trap 1: a file genuinely named "notes (deleted)" is not a zombie.
    if (ino !== null) {
      // Authoritative: the descriptor's inode against whatever is at that path
      // now. Same inode means the suffix was part of the name.
      if (now === ino) continue;
    } else {
      // The descriptor could not be stat'ed, so the inode comparison is
      // unavailable. Claiming a zombie here would be asserting something
      // unverified — §10's "reporting a number you can't verify". Fall back to
      // the weaker but honest test: if a file still exists at that path, assume
      // the name simply ends in " (deleted)" and stay quiet.
      if (now !== 'gone') continue;
    }

    // One inode held on many descriptors is one leak, not several.
    const key = `${String(rec.pid)}\0${ino !== null ? String(ino) : rec.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pid: rec.pid, processName: rec.processName, path: rec.path, bytes, ino });
  }
  return { handles: out, undecided: undecided.size, unreadablePrograms: await unreadableProgramsOf(procRoot, walk.refused, uid) };
}
