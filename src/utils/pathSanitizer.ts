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

function isBlocked(resolved: string): boolean {
  if (process.platform === 'win32') {
    const lower = resolved.toLowerCase();
    return WINDOWS_BLOCKLIST.some((b) => lower === b || lower.startsWith(b + path.sep));
  }
  return UNIX_BLOCKLIST.some((b) => resolved === b || resolved.startsWith(b + '/'));
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
 * which is why this canonicalises the WHOLE path (realpath resolves
 * intermediate components too) rather than just its last segment.
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
 * Cost is one realpath syscall per sanitize call in the normal case (the path
 * exists), and at most one per path segment in the ENOENT case. This runs once
 * per scan REQUEST, not once per file, so it is invisible next to the walk it
 * guards — and nothing here is quadratic.
 */
function canonicalize(resolved: string): string {
  const strip = (p: string): string =>
    // Node's realpath.native can hand back an extended-length prefix on
    // Windows; the blocklist is written in ordinary drive-letter form.
    process.platform === 'win32' && p.startsWith('\\\\?\\') ? p.slice(4) : p;

  try {
    return strip(fs.realpathSync.native(resolved));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return resolved;
  }

  // ENOENT: climb toward the root looking for a real ancestor to canonicalise.
  const tail: string[] = [];
  let dir = resolved;
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir) return resolved; // reached the root without a hit
    tail.unshift(path.basename(dir));
    dir = parent;
    try {
      return path.join(strip(fs.realpathSync.native(dir)), ...tail);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return resolved;
    }
  }
}

/**
 * Validate and normalize a user-supplied path.
 * - rejects non-strings, empty strings and null bytes
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

  // Cloud-scan paths (cloud://provider/...) are pure identifiers: they never
  // reach the filesystem, so they skip resolution — but not validation.
  if (input.startsWith('cloud://')) {
    if (!/^cloud:\/\/[a-z]+(\/[^\0]*)?$/.test(input) || input.includes('..')) {
      throw new PathRejectedError('Malformed cloud path', 'PATH_INVALID');
    }
    return input;
  }

  let p = input.trim();
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
  if (isBlocked(resolved) || (canonical !== resolved && isBlocked(canonical))) {
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
