/**
 * Directories a scan must never descend INTO (each may still be scanned
 * directly as a chosen root — this guard is consulted only on the way down).
 * Two failure modes live behind them:
 *
 *  - Re-entry: /System/Volumes/Data firmlink-mirrors the entire writable
 *    volume, so descending into it counts every byte a full-disk scan
 *    already saw at /Users, /Applications, /private, …
 *  - Blocking triggers: automount points, File Provider materialization and
 *    dead network/external volumes block open()/stat() indefinitely — a
 *    full-disk scan that wanders in never comes back. Diagnosed live: gdu
 *    sat at 0% CPU with every worker thread parked inside open() under
 *    /System/Volumes while the scan counter froze.
 *
 * gdu additionally runs with --no-cross, which catches boundaries this list
 * can't know about (DMGs mounted mid-tree, cryptexes); the walker relies on
 * this list alone because firmlinks make same-device checks wrong on macOS
 * (/Users legitimately sits on a different volume than /). The native walker
 * (Phase 3) is handed this same list and nothing else, for the same reason
 * (decision P3-3).
 */
const DARWIN_SKIP = new Set(['/System/Volumes', '/Volumes', '/dev', '/home', '/net', '/Network']);
const LINUX_SKIP = new Set(['/proc', '/sys', '/dev', '/run']);

/** Paths a test adds to every platform's list (`setNeverDescendForTests`): a scan of a temp folder cannot reach the real ones. */
let extraForTests: ReadonlySet<string> | null = null;

export function neverDescend(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (extraForTests?.has(p)) return true;
  if (platform === 'darwin') return DARWIN_SKIP.has(p);
  if (platform === 'linux') return LINUX_SKIP.has(p);
  return false;
}

/** The whole list for a platform, in a fixed order — what the native walker is given. */
export function neverDescendPaths(platform: NodeJS.Platform = process.platform): string[] {
  const fixed = platform === 'darwin' ? [...DARWIN_SKIP] : platform === 'linux' ? [...LINUX_SKIP] : [];
  return extraForTests ? [...fixed, ...extraForTests] : fixed;
}

/** Tests only: `paths` join every platform's never-descend list, for every engine; null puts the fixed lists back. */
export function setNeverDescendForTests(paths: readonly string[] | null): void {
  extraForTests = paths ? new Set(paths) : null;
}
