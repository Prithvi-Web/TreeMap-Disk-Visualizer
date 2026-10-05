import fs from 'node:fs';
import path from 'node:path';

/**
 * Whether `dest`, as the copy seam (setCopyFaultForTests) sees it, is a restore's copy of the file
 * whose name is `final` (FG3f #8). A restore writes each file beside its name, under
 * `.treemap-restore-…`, and puts it at its name only once it verifies — so the seam never sees the
 * final name of a restore's copy.
 */
export function isRestoreCopyFor(dest: string, final: string): boolean {
  return dest === final || (path.dirname(dest) === path.dirname(final) && path.basename(dest).startsWith('.treemap-restore-'));
}

/** The restore copies not yet put at their names in `dir` (none when `dir` is not there). */
export function restorePartialsIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.startsWith('.treemap-restore-')).map((name) => path.join(dir, name));
}
