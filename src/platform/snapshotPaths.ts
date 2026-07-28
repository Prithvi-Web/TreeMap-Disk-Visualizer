/**
 * Path arithmetic shared by every platform's snapshot recovery (B4).
 *
 * Lives here rather than in one OS's folder because all three need the same
 * answer and a Linux module importing from the macOS one would be a lie about
 * where the logic belongs.
 */

/**
 * A path inside a snapshot is the original with its volume prefix removed:
 * `/Users/me/a.txt` on volume `/` becomes `Users/me/a.txt`.
 *
 * The result is deliberately **relative**. Getting this wrong fails silently
 * and dangerously: a leading slash makes `<mountpoint>/<rel>` resolve to the
 * *live* filesystem instead of the snapshot, so a "recovery" would find the
 * current file and copy it onto itself, reporting success while restoring
 * nothing.
 */
export function relativeToVolume(originalPath: string, volume: string): string {
  const normalizedVolume = volume.endsWith('/') ? volume : volume + '/';
  if (originalPath.startsWith(normalizedVolume)) {
    return originalPath.slice(normalizedVolume.length).replace(/^\/+/, '');
  }
  // Windows drive letters: C:\Users\me\a.txt → Users\me\a.txt
  return originalPath.replace(/^[A-Za-z]:[\\/]+/, '').replace(/^\/+/, '');
}
