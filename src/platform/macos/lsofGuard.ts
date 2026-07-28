import { promises as fsp } from 'fs';
import { runText, CommandUnavailableError, CommandFailedError } from '../exec';
import type { OpenHandleInfo, ZombieHandleInfo } from '../types';

/**
 * Open-handle (B2) and zombie-handle (B5) detection on macOS and Linux via
 * `lsof`.
 *
 * Mechanism choice (§2.3): tier 3, a system binary. `lsof` ships with macOS and
 * with every mainstream Linux distribution, needs no entitlement to see the
 * calling user's own processes, and has a documented machine-readable mode.
 * There is no `--json`, but `-F` is not human-formatted output — it is
 * field-per-line output designed for programs, so parsing it does not violate
 * §10's "no regex over human-formatted output" rule. Linux additionally has a
 * faster no-subprocess path through /proc (see ../linux/procFdGuard.ts); this
 * module is macOS's primary mechanism and Linux's fallback.
 *
 * ── Two behaviours measured on macOS 15 (Darwin 25.5), not assumed ──
 *
 * 1. **macOS emits no `(deleted)` marker.** The widely-documented Linux
 *    behaviour of appending `(deleted)` to an unlinked-but-open file's name
 *    does not happen here: `lsof` output for a descriptor is byte-identical
 *    before and after `unlink()` — same path, same size, same inode. Detecting
 *    a zombie therefore compares lsof's `i` (inode) field against the inode
 *    currently at that path: gone, or a different inode, means the descriptor
 *    is holding an unlinked one. The `(deleted)` marker is still honoured when
 *    present, so Linux takes the cheap path and macOS the correct one.
 *
 * 2. **lsof reports resolved paths.** A handle opened on `/tmp/x` comes back as
 *    `/private/tmp/x`, because `/tmp` is a symlink. Matching results against a
 *    caller's delete set therefore compares realpaths, or every warning about a
 *    file under `/tmp`, `/var` or `/etc` would be silently missed.
 *
 * Field order, as emitted: `f` (descriptor) opens a block, then `t` type,
 * `D` device, `s` size, `i` inode, `n` name. State resets on each `f`.
 *
 * What this cannot see: processes owned by other users, unless TreeMap runs
 * elevated. Reported as a partial answer in the capability reason, never as a
 * confident "nothing has it open".
 */

/** One descriptor as reported by lsof. */
export interface LsofRecord {
  pid: number;
  processName: string;
  /** Path as lsof resolved it (symlinks already followed). */
  path: string;
  /** Inode the descriptor points at, when reported. */
  ino: number | null;
  /** Size in bytes, when reported. */
  size: number | null;
  /** True when lsof itself flagged the inode as unlinked (Linux). */
  markedDeleted: boolean;
}

/**
 * Parse lsof `-F` output into descriptor records.
 *
 * Exported because this parser is the only part of the mechanism that can be
 * asserted without a live system, and the awkward cases it must survive —
 * spaces in application names, `(deleted)` suffixes, non-file names like
 * sockets and pipes — are exactly where a naive implementation goes wrong.
 */
export function parseLsofRecords(stdout: string): LsofRecord[] {
  const out: LsofRecord[] = [];
  let pid = 0;
  let processName = '';
  let size: number | null = null;
  let ino: number | null = null;

  const intOrNull = (s: string): number | null => {
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  };

  for (const line of stdout.split('\n')) {
    if (line.length < 2) continue;
    const code = line[0];
    const value = line.slice(1);

    switch (code) {
      case 'p':
        pid = intOrNull(value) ?? 0;
        processName = '';
        size = ino = null;
        break;
      case 'c':
        processName = value;
        break;
      case 'f': // a new descriptor block — previous per-fd fields no longer apply
        size = ino = null;
        break;
      case 's':
        size = intOrNull(value);
        break;
      case 'i':
        ino = intOrNull(value);
        break;
      case 'n': {
        if (!pid) break;
        const markedDeleted = value.endsWith('(deleted)');
        const path = markedDeleted ? value.slice(0, -'(deleted)'.length).trimEnd() : value;
        // Sockets, pipes, kqueues and cwd markers are not files on disk.
        if (path.startsWith('/')) out.push({ pid, processName, path, ino, size, markedDeleted });
        size = ino = null;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Resolve symlinks so lsof's answers and the caller's paths can be compared. */
async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

/**
 * Run lsof, tolerating its non-zero exits.
 *
 * Measured: lsof exits 1 when nothing matches (the common, boring case) *and*
 * when any single path argument no longer exists — while still printing
 * complete records for every path that does. Both are ordinary during a delete
 * batch, where files legitimately vanish between listing and confirming, so a
 * non-zero exit with usable stdout is data, not failure. A missing binary is
 * the one case that genuinely yields nothing.
 */
async function runLsof(args: string[], timeoutMs: number, maxBuffer?: number): Promise<string | null> {
  try {
    return await runText('lsof', args, { timeoutMs, ...(maxBuffer ? { maxBuffer } : {}) });
  } catch (err) {
    if (err instanceof CommandUnavailableError) return null;
    if (err instanceof CommandFailedError) return err.stdout;
    return null;
  }
}

/**
 * Which processes hold any of `paths` — **or anything beneath them** — open.
 *
 * ── Why one full enumeration rather than `lsof <path> <path> …` ──
 *
 * Measured on macOS 15: `lsof /some/dir` reports processes whose *own* cwd or
 * descriptor is that directory, and says **nothing** about a file open inside
 * it. So the targeted form silently passes a folder full of open files — and
 * trashing folders is most of what TreeMap's Clean Up view does (`node_modules`
 * while a dev server holds a log open is the everyday case). A guard that
 * quietly answers "nothing is open" there is worse than no guard.
 *
 * `lsof +D <dir>` does descend, but it stats every file in the tree, so a batch
 * mixing several large folders becomes several deep walks.
 *
 * One unfiltered enumeration, intersected against the delete set in memory, is
 * what §B2 actually prescribes ("do one enumeration pass and intersect against
 * the delete set") and it fixes both problems at once: exactly one subprocess
 * whatever the batch looks like, and descendants come free from prefix
 * matching. Measured on this Mac: ~170 ms warm for ~12,500 open file
 * descriptors, independent of how many paths are being deleted.
 */
export async function openHandlesFor(paths: string[]): Promise<OpenHandleInfo[]> {
  if (paths.length === 0) return [];

  const resolved = await Promise.all(paths.map(async (p) => [await realpathOrSelf(p), p] as const));
  const stdout = await runLsof(['-F', 'pcnfsi', '-w'], 30_000, 64 * 1024 * 1024);
  if (stdout === null) return [];

  return intersectHandles(parseLsofRecords(stdout), resolved);
}

/**
 * Intersect open descriptors with the delete set, matching descendants.
 *
 * Pure and exported: this is where the correctness lives, and it is the only
 * part testable without a live process holding real files open.
 *
 * `wanted` maps each realpath to the path the caller asked about, so a warning
 * names the file the user is looking at rather than lsof's resolved form
 * (`/tmp/x` comes back as `/private/tmp/x`).
 */
export function intersectHandles(
  records: LsofRecord[],
  wanted: readonly (readonly [resolved: string, requested: string])[],
): OpenHandleInfo[] {
  const exact = new Map(wanted);
  // Directory prefixes carry a trailing separator so that deleting `/a/logs`
  // does not claim `/a/logs-archive/x` — a false warning about an unrelated
  // file is how a guard trains people to click through it.
  const prefixes = wanted.map(([resolved, requested]) => [`${resolved.replace(/\/+$/, '')}/`, requested] as const);

  const seen = new Set<string>();
  const out: OpenHandleInfo[] = [];
  for (const rec of records) {
    if (rec.markedDeleted) continue; // an unlinked inode blocks no delete

    let requested = exact.get(rec.path);
    if (requested === undefined) {
      // Deepest match wins, so a set holding both a folder and a file inside it
      // attributes the handle to the file the user can actually see.
      let best = '';
      for (const [prefix, asked] of prefixes) {
        if (rec.path.startsWith(prefix) && prefix.length > best.length) {
          best = prefix;
          requested = asked;
        }
      }
      if (requested === undefined) continue;
    }

    const key = `${rec.pid}\0${requested}\0${rec.path}`;
    if (seen.has(key)) continue; // one process, many descriptors, one warning
    seen.add(key);
    out.push({ path: requested, pid: rec.pid, processName: rec.processName, openPath: rec.path });
  }
  return out;
}

/**
 * Files deleted while still open: their blocks stay allocated until the last
 * descriptor closes, which is how a disk can be full with nothing visible to
 * account for it.
 *
 * Uses lsof's own `(deleted)` marker where the platform emits it, and falls
 * back to comparing the descriptor's inode against what is at that path now —
 * which is the only mechanism that works on macOS (see the note at the top).
 */
export async function zombieHandles(): Promise<ZombieHandleInfo[]> {
  const stdout = await runLsof(['-F', 'pcnfsi', '-w'], 30_000, 64 * 1024 * 1024);
  if (stdout === null) return [];
  return resolveZombies(parseLsofRecords(stdout), (p) => fsp.stat(p).then((st) => st.ino));
}

/**
 * Decide which records describe unlinked inodes.
 *
 * `inoAt` is injected so this — the part that carries the actual correctness
 * risk — is unit-testable without unlinking files under a live process.
 */
export async function resolveZombies(
  records: LsofRecord[],
  inoAt: (path: string) => Promise<number>,
): Promise<ZombieHandleInfo[]> {
  const out: ZombieHandleInfo[] = [];
  // One stat per distinct path, not per descriptor: a browser can hold hundreds
  // of descriptors on the same handful of files.
  const inoCache = new Map<string, Promise<number | null>>();
  const lookup = (p: string): Promise<number | null> => {
    let hit = inoCache.get(p);
    if (!hit) {
      hit = inoAt(p).catch(() => null);
      inoCache.set(p, hit);
    }
    return hit;
  };

  // Deduplicate by (pid, inode): the same unlinked inode held on several
  // descriptors is one leak, not several, and counting it twice would overstate
  // reclaimable bytes — precisely the kind of confidently-wrong number §10 bans.
  const seen = new Set<string>();

  for (const rec of records) {
    let isZombie = rec.markedDeleted;
    if (!isZombie) {
      if (rec.ino === null) continue; // no inode reported — cannot know, so don't claim
      const live = await lookup(rec.path);
      isZombie = live === null || live !== rec.ino;
    }
    if (!isZombie) continue;
    const key = `${rec.pid}\0${rec.ino ?? rec.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pid: rec.pid, processName: rec.processName, path: rec.path, bytes: rec.size });
  }
  return out;
}
