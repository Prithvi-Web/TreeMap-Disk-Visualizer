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
 * APFS over about 34,000 names — every code point with a case, normalization or compatibility
 * mapping, and those mappings: no two names the volume reads as one have two keys, and no key joins
 * two names it keeps apart (FG3c; tests/volumeNames.test.ts re-measures the long-settled blocks on
 * every Mac run). An HFS+ volume that folds
 * case folds by an older table, and is read with this one.
 */
export function apfsNameKey(name: string): string {
  let folded = '';
  for (const c of name.normalize('NFD')) folded += c === DOTLESS_I ? c : c.toLowerCase().toUpperCase().toLowerCase();
  return folded.normalize('NFD');
}

/**
 * A name as an NTFS folder that folds case compares it — as far as is certain, which is a model,
 * not a measurement (FG3d #16). NTFS compares names by the $UpCase table written onto each volume,
 * and that table is not Unicode's upper case: the one Windows 7 and later write keeps ı, ς, ſ, µ
 * and some 220 more apart from what Unicode upper-cases them to (the FG3c review rebuilt it from
 * ntfs-3g's copy, whose hashes match Windows'; nothing here measures a volume). So only the ASCII
 * letters are folded, which every such table folds: `lib` and `LIB` are one name. Every other pair
 * is compared exactly — folding less than the volume, the safe side: a member past a link the
 * volume reads as one name with a folder then passes this early check, and the restore, which
 * makes links last, fails when it makes the link, having written nothing through it. Folding more
 * would refuse a tree the volume holds. Nor is a trailing dot or space dropped: Node writes through
 * `\\?\` paths, which Win32 does not trim, so to the restore `lib.` and `lib` are two names.
 */
export function ntfsNameKey(name: string): string {
  return name.replace(/[a-z]/g, (c) => c.toUpperCase());
}

/**
 * The key a restore compares names with: by platform, and whether the destination folds case.
 * Linux compares exactly: a case-insensitive mount there (vfat, exFAT, a casefolded ext4 folder)
 * relies on the restore making links last, as an NTFS folder does for all but the ASCII letters.
 */
export function nameKeyFor(platform: NodeJS.Platform, foldsCase: boolean): (name: string) => string {
  if (platform === 'win32' && foldsCase) return ntfsNameKey;
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
