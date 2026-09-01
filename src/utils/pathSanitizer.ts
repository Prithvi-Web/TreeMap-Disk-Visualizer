import path from 'path';
import os from 'os';
import fs from 'fs';

/**
 * Path validation shared by the pathGuard middleware and the services.
 * Throws PathRejectedError for anything suspicious; returns the resolved
 * absolute path otherwise.
 */

export class PathRejectedError extends Error {
  readonly code: string;
  constructor(message: string, code = 'PATH_REJECTED') {
    super(message);
    this.name = 'PathRejectedError';
    this.code = code;
  }
}

/** Virtual / volatile filesystems and OS internals we refuse to touch. */
const UNIX_BLOCKLIST = ['/proc', '/sys', '/dev', '/run', '/private/var/db', '/System/Volumes/VM'];
const WINDOWS_BLOCKLIST = [
  'c:\\windows\\system32',
  'c:\\windows\\syswow64',
  'c:\\windows\\winsxs',
  'c:\\$recycle.bin',
  'c:\\system volume information',
];

/**
 * Win32 strips trailing spaces and dots from every path component inside the
 * OS, so `C:\\Windows\\System32 ` and `C:\\Windows\\System32` are one directory to
 * every file API. This file deliberately stopped trimming the tail — a trailing
 * space is legal filename DATA on POSIX — so the blocklist has to do the
 * normalisation Windows itself would do, or the space walks a blocked path
 * straight past a string comparison.
 */
function win32Normalize(p: string): string {
  return p
    .toLowerCase()
    .split(path.sep)
    .map((seg) => seg.replace(/[ .]+$/, ''))
    .join(path.sep);
}

function isBlocked(resolved: string): boolean {
  if (process.platform === 'win32') {
    const lower = win32Normalize(resolved);
    return WINDOWS_BLOCKLIST.some((b) => lower === b || lower.startsWith(b + path.sep));
  }
  return UNIX_BLOCKLIST.some((b) => resolved === b || resolved.startsWith(b + '/'));
}

/** Node's realpath.native can hand back a Windows extended-length prefix; the
 *  blocklist is written in ordinary drive-letter form. */
function strip(p: string): string {
  return process.platform === 'win32' && p.startsWith('\\\\?\\') ? p.slice(4) : p;
}

/**
 * Bounded, short-lived memo of directory -> canonical directory.
 *
 * Sizing: entries are two strings, so 512 is a few tens of kB and covers any
 * realistic mix of open scan roots; eviction is oldest-inserted-first (a Map
 * iterates in insertion order), which is enough — the memo exists to collapse
 * ONE batch, not to be a long-lived index.
 *
 * Freshness beats hit rate here, hence the TTL as well as the cap. A cached
 * entry is a claim about the shape of the filesystem, and the filesystem can
 * change underneath it: if /tmp/work is memoised as an ordinary directory and
 * is then replaced by a symlink to /dev, a hit inside the window answers with
 * the stale, unblocked location. Five seconds keeps that window shorter than
 * any human-driven swap while still collapsing a batch, which is processed in
 * a single synchronous tick. Note also which half of the check is cached: the
 * DIRECTORY chain, whose entries are long-lived and mostly OS-owned. A symlink
 * planted as the LEAF — the cheap, obvious attack — is re-lstat'd every time
 * and cannot be hidden by this cache at all.
 */
const CANON_CACHE_MAX = 512;
const CANON_CACHE_TTL_MS = 5_000;
const canonCache = new Map<string, { value: string; at: number }>();

/** Canonical form of a DIRECTORY path, memoised. */
function canonDir(dir: string): string {
  const now = Date.now();
  const hit = canonCache.get(dir);
  if (hit !== undefined && now - hit.at < CANON_CACHE_TTL_MS) return hit.value;

  const value = canonDirUncached(dir);
  canonCache.delete(dir); // re-insert so this entry counts as the newest
  canonCache.set(dir, { value, at: now });
  if (canonCache.size > CANON_CACHE_MAX) {
    const oldest = canonCache.keys().next().value;
    if (oldest !== undefined) canonCache.delete(oldest);
  }
  return value;
}

function canonDirUncached(dir: string): string {
  try {
    return strip(fs.realpathSync.native(dir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return dir;
  }
  // ENOENT: climb toward the root looking for a real ancestor to canonicalise,
  // because "/var/db/not-yet.sqlite" must stay blocked even though nothing at
  // that path exists yet. Recursing through canonDir memoises every level of
  // the climb, so a second missing sibling costs nothing.
  const parent = path.dirname(dir);
  if (parent === dir) return dir; // a root that will not resolve: nothing above it
  return path.join(canonDir(parent), path.basename(dir));
}

/**
 * Resolve every symlink in `resolved`, for the blocklist test only.
 *
 * A textual blocklist asks "does this string start with a forbidden prefix?"
 * when the question that matters is "does this path land in a forbidden
 * directory?". On macOS the two answers disagree out of the box: /var, /etc
 * and /tmp are symlinks into /private, so "/private/var/db" was rejected while
 * "/var/db" — byte-for-byte the same directory — was allowed. The same hole
 * opens anywhere a symlink inside a permitted tree points at a blocked one,
 * which is why this canonicalises the WHOLE path — every intermediate
 * component as well as the last segment.
 *
 * Failure is never an error here. A path the caller is about to create, a
 * directory this process cannot stat, a symlink loop — none of those is a
 * bypass attempt, and turning them into PathRejectedError would break scanning
 * a folder that merely contains an unreadable ancestor. So:
 *
 *  - ENOENT is the one case worth working at, because "/var/db/not-yet.sqlite"
 *    must stay blocked even though the leaf is missing. Walk up to the deepest
 *    ancestor that does exist, canonicalise that, and re-attach the tail.
 *  - EACCES / EPERM / ELOOP / anything else falls back to the textual path,
 *    which is exactly the pre-existing behaviour: no worse than before, and
 *    the textual blocklist test still runs against it.
 *
 * COST — this is not once per request. `guardBodyPathsMax` sanitizes a body
 * with `paths.map(sanitizePath)` over batches capped at 2,000, so "one realpath
 * per sanitize call" means up to 2,000 synchronous syscalls parked on the event
 * loop for a single facts request, where this file used to do pure string work.
 * What the blocklist actually asks about is DIRECTORIES — 2,000 files in one
 * folder share one answer — so the work is split in two:
 *
 *  - the directory part of the path goes through the memo above, which turns a
 *    whole batch in one folder into one realpath;
 *  - the leaf gets an `lstat`, and only a leaf that really is a symlink costs a
 *    realpath of its own. `lstat` is one syscall against realpath's walk of
 *    every component, and — the reason it is not cached — it is always FRESH.
 *    The leaf is where a bypass would be planted, so it is the one question
 *    that must never be answered from memory.
 */
/**
 * macOS firmlinks: the same directory under two names, and realpath collapses
 * neither.
 *
 * Since Catalina the system volume is sealed and the writable Data volume is
 * mounted at /System/Volumes/Data, firmlinked into the root — so /private/var
 * and /System/Volumes/Data/private/var are one directory with one inode, and
 * `realpath(3)` reports each spelling as itself because a firmlink is a mount
 * feature, not a link. The blocklist was reachable by the alias: sanitizePath
 * accepted /System/Volumes/Data/private/var/db, which is exactly the directory
 * holding the local account database.
 *
 * The prefix is a documented, fixed part of the OS layout, so stripping it is
 * complete for the whole tree beneath any aliased directory and costs nothing.
 */
const DATA_VOLUME = '/System/Volumes/Data';
function stripDataVolume(p: string): string {
  if (process.platform !== 'darwin') return p;
  if (p === DATA_VOLUME) return '/';
  return p.startsWith(DATA_VOLUME + '/') ? p.slice(DATA_VOLUME.length) : p;
}

/**
 * Device+inode of every blocked directory that exists, computed once.
 *
 * The backstop behind the string rules. An alias nobody predicted — another
 * mount of the same volume, a bind mount, a firmlink Apple adds next release —
 * still lands on the same inode, and identity is the one test that cannot be
 * spelled around. Gated on a basename match below so the stat is not paid on
 * every path this app ever sees.
 */
let blockedIds: Set<string> | null = null;
function blockedIdentities(): Set<string> {
  if (blockedIds) return blockedIds;
  blockedIds = new Set<string>();
  const list = process.platform === 'win32' ? WINDOWS_BLOCKLIST : UNIX_BLOCKLIST;
  for (const b of list) {
    try {
      const st = fs.statSync(b);
      blockedIds.add(`${st.dev}:${st.ino}`);
    } catch {
      // Not present on this machine, so nothing can alias to it.
    }
  }
  return blockedIds;
}

/** Is `p` the same directory as a blocked one, under any name? */
function isBlockedByIdentity(p: string): boolean {
  // Cheap pre-filter: only a path whose LAST component is named like a blocked
  // directory can be one under a different prefix. Anything deeper inside an
  // aliased tree is already handled by stripDataVolume, which rewrites the
  // whole path rather than just its tail.
  const base = path.basename(p).toLowerCase();
  const list = process.platform === 'win32' ? WINDOWS_BLOCKLIST : UNIX_BLOCKLIST;
  if (!list.some((b) => path.basename(b).toLowerCase() === base)) return false;
  try {
    const st = fs.statSync(p);
    return blockedIdentities().has(`${st.dev}:${st.ino}`);
  } catch {
    return false; // it does not exist, so it is not a blocked directory
  }
}

/**
 * Could some spelling of this path's last component land on the blocklist?
 *
 * True when the path's own parent directory is at or above a blocked entry —
 * `/` is above `/dev`, `/private/var` is above `/private/var/db`. Anywhere
 * else, renaming the leaf cannot produce a blocked path, so its on-disk
 * spelling does not matter and the syscall is skipped.
 */
function parentMayHostBlocked(candidate: string): boolean {
  const parent = path.dirname(candidate);
  const list = process.platform === 'win32' ? WINDOWS_BLOCKLIST : UNIX_BLOCKLIST;
  const sep = process.platform === 'win32' ? path.sep : '/';
  const norm = process.platform === 'win32' ? win32Normalize(parent) : parent;
  const prefix = norm.endsWith(sep) ? norm : norm + sep;
  return list.some((b) => b === norm || b.startsWith(prefix));
}

function canonicalize(resolved: string): string {
  const parent = path.dirname(resolved);
  if (parent === resolved) return canonDir(resolved); // "/" or "C:\" itself

  const candidate = stripDataVolume(path.join(canonDir(parent), path.basename(resolved)));

  let leaf: fs.Stats | undefined;
  try {
    // lstat, not stat: the question is whether this last component is itself a
    // link, and stat would follow it and answer about the target. A missing
    // leaf is not an error (throwIfNoEntry) — its canonical location is still
    // the canonical parent, which is what keeps /var/db/not-yet.sqlite blocked.
    leaf = fs.lstatSync(resolved, { throwIfNoEntry: false });
  } catch {
    // EACCES / ENOTDIR / anything else: fall back to the textual answer, which
    // is what this function did before it could see the filesystem at all.
    return candidate;
  }
  // A symlink is not the only way the caller's spelling of the leaf differs
  // from the kernel's. macOS mounts its boot volume case-insensitive and
  // case-preserving, so `/DEV` is an ordinary directory to `lstat` and `/dev`
  // to everything else; Windows discards a trailing space or dot before any
  // file API sees it. Either way a blocked directory arrives under a name the
  // string comparison does not recognise, which the whole-path realpath this
  // replaced could not miss.
  //
  // Realpathing every leaf would give back the cost the memo exists to save.
  // But the only leaf whose SPELLING can change the verdict is one that could
  // land on the blocklist, and the parent already tells us that: unless the
  // canonical parent sits at or above a blocked directory, no spelling of the
  // last component reaches one. That is a string test, so the extra syscall is
  // paid on `/`, `/private/var` and `C:\\Windows`, and never on the 2,000 files
  // in someone's Downloads folder. A child of a case-variant directory needs
  // nothing here: its own parent goes through canonDir, which realpaths it.
  const mustCheckLeaf = leaf !== undefined && (leaf.isSymbolicLink() || parentMayHostBlocked(candidate));
  if (!mustCheckLeaf) return candidate;

  try {
    const viaLink = stripDataVolume(strip(fs.realpathSync.native(resolved)));
    // The more restrictive answer wins. Returning the link's target outright
    // would let a symlink sitting INSIDE a blocked tree, but pointing out of
    // it, carry its own path back out as unblocked — the candidate already
    // says where the link lives, and that is the fact the blocklist is about.
    return isBlocked(candidate) ? candidate : viaLink;
  } catch {
    // A dangling link or a symlink loop points at nothing, so it is not a
    // blocklist bypass; the canonical parent plus the link's own name is the
    // most that can honestly be said about it.
    return candidate;
  }
}

/**
 * Validate and normalize a user-supplied path.
 * - rejects non-strings, empty strings and null bytes
 * - strips LEADING whitespace only (see below)
 * - expands a leading "~" to the home directory
 * - resolves to an absolute path (eliminating ../ traversal segments)
 * - rejects blocked system directories, judged on the CANONICAL path (symlinks
 *   resolved) so that /var/db and /private/var/db get the same answer
 */
export function sanitizePath(input: unknown): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new PathRejectedError('Path must be a non-empty string', 'PATH_INVALID');
  }
  if (input.includes('\0')) {
    throw new PathRejectedError('Path contains a null byte', 'PATH_INVALID');
  }

  // Leading whitespace is noise; TRAILING whitespace is part of the name.
  //
  // Nothing can precede an absolute path or a "~", so a leading run is always
  // copy-paste debris and comes off. At the other end a space is a legal
  // filename byte on macOS and Linux, `path.resolve` preserves it deliberately,
  // and every lookup in this app is exact string equality — so trimming
  // "~/Downloads/Screenshots " does not find a folder that is close enough, it
  // finds nothing, and the route 404s on a directory the treemap is drawing.
  // (This used to be harmless only by accident: the trimmed value was assigned
  // to req.query[name], which express 5 discards. Making the guard rewrite the
  // URL made the trim real.) Emptiness is still judged with a full trim, so a
  // whitespace-only value never reaches path.resolve — which would answer with
  // the process's cwd. Note that both operations cover the same character set:
  // JavaScript's \s and String.prototype.trim agree, U+00A0 and U+FEFF
  // included, and those two arrive routinely in names pasted from a web page.
  const trimmed = input.replace(/^\s+/, '');

  // Cloud-scan paths (cloud://provider/...) are pure identifiers: they never
  // reach the filesystem, so they skip resolution — but not validation. They
  // are matched on the leading-trimmed string for the same reason as above:
  // otherwise " cloud://gdrive/x" misses this branch and gets resolved into a
  // nonsense path under the cwd. The trailing end is left alone here too — a
  // cloud identifier ends in a remote file's name, which is no more ours to
  // rewrite than a local one.
  if (trimmed.startsWith('cloud://')) {
    if (!/^cloud:\/\/[a-z]+(\/[^\0]*)?$/.test(trimmed) || trimmed.includes('..')) {
      throw new PathRejectedError('Malformed cloud path', 'PATH_INVALID');
    }
    return trimmed;
  }

  let p = trimmed;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1));
  }

  const resolved = path.resolve(p);
  // Test the canonical form, return the caller's. Returning the canonical path
  // would quietly rewrite what the rest of the app scans and displays (/tmp/x
  // would surface as /private/tmp/x in the UI, in scan roots, in saved
  // snapshots), which is a visible change nobody asked for; the blocklist only
  // needs to KNOW where the path lands, not to relabel it. Returning `resolved`
  // also keeps the function idempotent — path.resolve of an absolute path is
  // itself, and re-canonicalising the same string reaches the same verdict —
  // which matters because paths are sanitized twice on most requests (pathGuard
  // middleware, then again inside the service).
  const canonical = canonicalize(resolved);
  if (isBlocked(resolved) || (canonical !== resolved && isBlocked(canonical)) || isBlockedByIdentity(resolved)) {
    throw new PathRejectedError(`Scanning "${resolved}" is not allowed`, 'PATH_BLOCKED');
  }
  return resolved;
}

/** True when `child` is `parent` itself or located anywhere beneath it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}
