import { promises as fsp } from 'fs';
import type { Dirent } from 'fs';
import path from 'path';
import { appDataDir } from './storage';
import { isEphemeral } from './portableMode';

/**
 * The fast-rescan caches of a format no build reads any more, by their exact
 * names, each the hash of a root (and of its "cross" variant):
 *  - `mtime-cache-<16 hex>.json`, written before a cache's name carried its
 *    format (U-4c L2): its partial listings would lose the `unlisted` mark;
 *  - `mtime-cache-v2-<16 hex>.json`, format 2 (5–18 Oct 2026): it can spell a
 *    name that begins with U+FEFF without the mark, so a reused listing would
 *    name the file beside it (BQL item 8; diskScanner writes format 3 since).
 * Every root ever scanned left one in app-data, up to tens of MB each, which
 * nothing reads (the U-4c review, F1.2).
 */
export const LEGACY_MTIME_CACHE = /^mtime-cache-(?:v2-)?[0-9a-f]{16}\.json$/;

/**
 * Removes every legacy fast-rescan cache from app-data: TreeMap's own files,
 * by their exact old name, a regular file only — never a link, a folder or a
 * `.tmp` named like one, and nothing else in the folder. Run as a scan
 * completes (beside the cache it writes), so the first scan after the update
 * clears what every earlier one left, whatever root it was of. A read-only
 * portable session removes nothing: its app-data is not TreeMap's to touch.
 * Never rejects: a file that cannot be removed stays where it is, unread.
 * Answers how many it removed.
 */
export async function dropLegacyMtimeCaches(): Promise<number> {
  if (isEphemeral()) return 0;
  const appData = appDataDir();
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(appData, { withFileTypes: true });
  } catch {
    return 0; // no app-data folder yet: nothing was ever cached
  }
  let dropped = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !LEGACY_MTIME_CACHE.test(entry.name)) continue;
    try {
      await fsp.unlink(path.join(appData, entry.name));
      dropped++;
    } catch {
      /* gone meanwhile, or refused: it is never read either way */
    }
  }
  return dropped;
}
