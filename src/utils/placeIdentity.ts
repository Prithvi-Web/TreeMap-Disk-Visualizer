import { promises as fsp } from 'fs';
import { meansAbsent } from './errno';

/**
 * What stands at a path, looked at on the disk — for judging a trash step by what it did rather
 * than by what it reported (FG3, FG3b). A step can move the file and still report failure: macOS's
 * osascript is stopped at its time limit while Finder goes on to finish the move it was handed.
 * So a report of failure proves nothing on its own, and neither does one look that failed.
 */

/** Nothing stands at the path, as `meansAbsent` reads an lstat's failure. */
export const ABSENT = Symbol('absent');
/** A look at the path that failed for another reason (permissions, I/O): it says nothing either way. */
export const UNKNOWN = Symbol('unknown');
/** The device and id of what stands at a path (links not followed), ABSENT, or UNKNOWN. */
export type Identity = string | typeof ABSENT | typeof UNKNOWN;

export async function identityOf(p: string): Promise<Identity> {
  try {
    const st = await fsp.lstat(p, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch (err) {
    return meansAbsent(err) ? ABSENT : UNKNOWN;
  }
}

/**
 * What a trash step that reported a failure did to an item, from what stood at its path just before
 * the step (`before`) and what stands there now (`now`):
 *
 * - `gone` — a known file stood there before, and nothing does now, or another file does: the item
 *   left its place.
 * - `there` — the same file stands there before and after, and the step ended on its own: the item
 *   is untouched. The only verdict under which a caller may say so.
 * - `unsure` — anything else: nothing known stood there before the step (it went, or was never
 *   seen, before the step could move it — not the step's doing), a look that failed, or a step
 *   stopped before it answered (`stopped`: its time limit, or a signal on macOS and Linux), which
 *   may still be carried out after this look. A caller keeps whatever it would otherwise discard,
 *   and says it could not tell.
 */
export function afterReportedFailure(before: Identity, now: Identity, stopped: boolean): 'gone' | 'there' | 'unsure' {
  if (typeof before !== 'string' || now === UNKNOWN) return 'unsure';
  if (now === ABSENT || now !== before) return 'gone';
  return stopped ? 'unsure' : 'there';
}
