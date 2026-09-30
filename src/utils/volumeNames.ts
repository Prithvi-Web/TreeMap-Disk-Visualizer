import path from 'path';
import { ABSENT, identityOf, type Identity } from './placeIdentity';

/**
 * Names as the volume a restore writes to compares them (FG3c), for the Time Capsule's early check
 * that no member of a manifest lies past a link it records (`manifestRefusal`). Folding less than the
 * volume lets a tampered record reach the restore, which still makes links last, so nothing is
 * written through one — it only fails later. Folding more refuses a tree the volume holds, and
 * strands the only copy of a folder that really was trashed. So each key folds exactly what its
 * volume folds, as far as it can be known, and a volume whose rule cannot be told is compared
 * exactly.
 */

/** Dotless ı: APFS keeps it apart from i and I, though Unicode's upper case of it is I. */
const DOTLESS_I = 'ı';

/**
 * A name as a Mac volume that folds case compares it (default APFS): canonical decomposition, then
 * each code point's case folded — the lower case of its upper case of its lower case, which is
 * Unicode's full case folding (ß, ẞ and ss are one name; ς and σ; ﬁ and fi) — except dotless ı.
 * Compatibility forms are NOT folded: APFS keeps `ｌｉｂ` and `lib`, `²` and `2`, apart. Measured on
 * this Mac's APFS over about 34,000 names — every code point with a case, normalization or
 * compatibility mapping, and those mappings: no two names the volume reads as one have two keys,
 * and no key joins two names it keeps apart (tests/volumeNames.test.ts). An HFS+ volume that folds
 * case folds by an older table, and is read with this one.
 */
export function apfsNameKey(name: string): string {
  let folded = '';
  for (const c of name.normalize('NFD')) folded += c === DOTLESS_I ? c : c.toLowerCase().toUpperCase().toLowerCase();
  return folded.normalize('NFD');
}

/**
 * A name as an NTFS folder that folds case compares it: each character upper-cased by the simple,
 * one-to-one mapping — NTFS's upcase table, which covers the Basic Multilingual Plane only — so ß
 * stays ß, ı is I, and nothing is normalized; and a trailing run of dots and spaces dropped, as
 * Win32 drops it. Modelled on NTFS's documented upcase table; not measured here.
 */
export function ntfsNameKey(name: string): string {
  let upper = '';
  for (const c of win32Trimmed(name)) {
    const u = c.toUpperCase();
    upper += c.length === 1 && u.length === 1 ? u : c;
  }
  return upper;
}

/** Win32 drops a trailing run of dots and spaces from a name, whatever the folder's case rule. */
function win32Trimmed(name: string): string {
  return name.replace(/[ .]+$/, '');
}

/**
 * The key a restore compares names with: by platform, and whether the destination folds case.
 * Linux compares exactly: a case-insensitive mount there (vfat, exFAT, a casefolded ext4 folder)
 * relies on the restore making links last.
 */
export function nameKeyFor(platform: NodeJS.Platform, foldsCase: boolean): (name: string) => string {
  if (platform === 'win32') return foldsCase ? ntfsNameKey : win32Trimmed;
  if (platform === 'darwin' && foldsCase) return apfsNameKey;
  return (name) => name;
}

/**
 * Whether the volume at `dir` reads a name in another case as the same name — asked of the disk:
 * the nearest existing folder at or above `dir` whose name has an ASCII letter is looked up with
 * that letter's case swapped. True when that spelling leads to the same folder, false when it leads
 * nowhere or to another, and null when no folder above can tell (no letter, or looks that fail).
 * Writes nothing. `look` stands in for the disk in tests.
 */
export async function foldsCaseAt(dir: string, look: (p: string) => Promise<Identity> = identityOf): Promise<boolean | null> {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    const name = path.basename(at);
    const i = name.search(/[A-Za-z]/);
    if (i >= 0) {
      const here = await look(at);
      if (typeof here === 'string') {
        const c = name[i];
        const swapped = `${name.slice(0, i)}${c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()}${name.slice(i + 1)}`;
        const there = await look(path.join(path.dirname(at), swapped));
        if (there === ABSENT) return false;
        if (typeof there === 'string') return there === here;
      }
    }
    if (path.dirname(at) === at) return null;
  }
}

/** The key for restoring into `dir`: its volume's, asked of the disk (`foldsCaseAt`). */
export async function restoreNameKeyFor(dir: string): Promise<(name: string) => string> {
  return nameKeyFor(process.platform, (await foldsCaseAt(dir)) === true);
}
