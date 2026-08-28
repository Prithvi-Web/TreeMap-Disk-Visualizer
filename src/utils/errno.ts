/**
 * Telling "it is not there" apart from "I could not find out" — and telling
 * the two questions apart that need that distinction.
 *
 * Every `lstat` in a watcher path was once wrapped in a bare
 * `catch { /* gone *\/ }`, which reads ANY error as a deletion. Most errors
 * are not deletions:
 *
 * | errno | what it means |
 * | --- | --- |
 * | `ENOENT` | the path really is not there |
 * | `ENOTDIR` | a parent component is not a directory, so the path cannot exist |
 * | `EMFILE` / `ENFILE` | this process, or this machine, is out of file descriptors |
 * | `EACCES` / `EPERM` | it is there and cannot be looked at |
 * | `EIO` / `EBUSY` / `ETIMEDOUT` | a failing disk, or a network volume having a bad moment |
 * | `ELOOP` / `ENAMETOOLONG` / `EINVAL` | the path cannot be resolved, which is not the same as empty |
 *
 * The cost was measured rather than imagined: injecting ONE `EMFILE` into the
 * index watcher's `lstat` made TreeMap delete a live 50,000-byte file from its
 * index while the file sat on disk, and for a directory the same path runs
 * `deleteSubtree` and takes the whole subtree.
 *
 * **There are two predicates here, and they are deliberately not one.** The
 * last row of that table is the reason. For a `stat` asking "is this entry
 * still there?", a path the kernel will never resolve may as well be gone —
 * and retrying it is a loop that never clears. For a `readFile` whose CONTENTS
 * are the state, the same answer is a fabrication: an `ELOOP` on
 * `timecapsule.json` says nothing about whether the user has recovery
 * payloads, and answering "absent" there produced an empty index whose orphan
 * sweep deleted every payload on disk in one pass. Also measured — after the
 * wider set had been introduced for the watcher and silently inherited here.
 *
 * So: **`meansAbsent` wherever the answer decides whether stored state may be
 * discarded or overwritten. `meansGone` for a `stat`.** Before changing either
 * set, walk the call sites and ask what a wrong answer costs at each one.
 */
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

/** The absences, plus paths the kernel will never resolve. */
const UNRESOLVABLE = new Set([...ABSENT, 'ELOOP', 'ENAMETOOLONG', 'EINVAL']);

/** Walk an error and its causes for the first fs errno anyone recorded. */
function errnoOf(err: unknown): { code?: string; errno?: number } | null {
  // `cause` is walked because this codebase chains errors (`diskUsage` does),
  // and a wrapped fs error with the answer inside it must not read as "could
  // not tell" just because the wrapper carries no code of its own. The depth
  // bound also terminates a cyclic cause chain.
  for (let e: unknown = err, depth = 0; e != null && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const node = e as NodeJS.ErrnoException;
    if (typeof node.code === 'string') return { code: node.code };
    if (typeof node.errno === 'number') return { errno: node.errno };
  }
  return null;
}

/**
 * libuv's numeric codes, for an error that lost its own properties crossing a
 * worker or `structuredClone` boundary. The Windows values differ from the
 * Unix ones and both are listed — checking only `-2`/`-20` would have made
 * this fallback silently dead on the platform with the most cross-boundary
 * machinery.
 */
const ABSENT_ERRNO = new Set([-2, -20, -4058, -4052]);

/** Is this failure a plain "it is not there"? Use where state is at stake. */
export function meansAbsent(err: unknown): boolean {
  const found = errnoOf(err);
  if (!found) return false;
  if (found.code !== undefined) return ABSENT.has(found.code);
  return found.errno !== undefined && ABSENT_ERRNO.has(found.errno);
}

/** Is this a `stat` failure that may as well be treated as gone? */
export function meansGone(err: unknown): boolean {
  const found = errnoOf(err);
  if (!found) return false;
  if (found.code !== undefined) return UNRESOLVABLE.has(found.code);
  return found.errno !== undefined && ABSENT_ERRNO.has(found.errno);
}
