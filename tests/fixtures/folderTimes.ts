import fs from 'node:fs';
import path from 'node:path';

/** How far back `ageFolders` puts folder times: an hour, far past diskScanner's SETTLED_LISTING_MS. */
export const AGED_BY_MS = 60 * 60 * 1000;

/**
 * Puts the time of `root` and of every folder beneath it an hour in the past, on a fraction of a
 * second (so a time cut to whole seconds, as gdu keeps them, differs from it).
 *
 * A fast rescan reuses only the listings the cache vouches for: a folder that last changed well
 * before its scan began (diskScanner's `listingSettled`). A tree made a moment before its scan has
 * none — a change in the same tick of the clock could follow its listing unseen — so a test that
 * wants a fast rescan to reuse listings lets them settle first, by setting the times rather than
 * waiting. Links are not followed; a folder that cannot be listed keeps its children's times.
 */
export function ageFolders(root: string, byMs = AGED_BY_MS): void {
  const when = new Date(Math.floor((Date.now() - byMs) / 1000) * 1000 + 321);
  const folders = [root];
  for (let i = 0; i < folders.length; i++) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(folders[i], { withFileTypes: true });
    } catch {
      // Unlistable: its own time is still set below.
    }
    for (const entry of entries) if (entry.isDirectory()) folders.push(path.join(folders[i], entry.name));
  }
  for (const folder of folders) fs.utimesSync(folder, when, when);
}
