import path from 'path';
import os from 'os';

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
 * Validate and normalize a user-supplied path.
 * - rejects non-strings, empty strings and null bytes
 * - expands a leading "~" to the home directory
 * - resolves to an absolute path (eliminating ../ traversal segments)
 * - rejects blocked system directories
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
  if (isBlocked(resolved)) {
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
