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
 * (/Users legitimately sits on a different volume than /).
 */
const DARWIN_SKIP = new Set(['/System/Volumes', '/Volumes', '/dev', '/home', '/net', '/Network']);
const LINUX_SKIP = new Set(['/proc', '/sys', '/dev', '/run']);

export function neverDescend(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'darwin') return DARWIN_SKIP.has(p);
  if (platform === 'linux') return LINUX_SKIP.has(p);
  return false;
}
