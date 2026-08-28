/**
 * Telling "it is not there" apart from "I could not find out".
 *
 * Every `lstat`/`stat` in a watcher path used to be wrapped in a bare
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
 * | `ELOOP` / `ENAMETOOLONG` | the path cannot be resolved, which is not the same as empty |
 *
 * The cost of getting this wrong was measured rather than imagined: injecting
 * ONE `EMFILE` into the index watcher's `lstat` made TreeMap delete a live
 * 50,000-byte file from its index while the file sat on disk, and for a
 * directory the same path runs `deleteSubtree` and takes the whole subtree.
 * A disk-space tool that quietly under-reports the disk is the worst thing
 * this codebase can ship, so the distinction gets its own tested function.
 */
/**
 * The plain absences: this path is not there, and nothing is pretending
 * otherwise.
 *
 * This is the narrow set, and it is the one to reach for whenever the answer
 * decides whether STORED STATE may be discarded or overwritten.
 */
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

/**
 * The absences, plus paths the kernel will never resolve however many times
 * it is asked: a symlink cycle, a component past `NAME_MAX`, an ill-formed
 * path.
 *
 * Only correct for a `lstat`/`stat` that is asking "is this entry still
 * there?" — where an unresolvable path may as well be gone, and retrying it
 * is a loop that never clears, burning the full retry budget and marking the
 * root stale on every event.
 *
 * It is NOT correct for reading a file whose contents are the state. An
 * `ELOOP` on `timecapsule.json` says nothing about whether the user has
 * recovery payloads; answering "absent" there produced an empty index, and
 * the orphan sweep then deleted every payload on disk in a single pass.
 * Measured, not imagined — which is why the two predicates are now separate
 * despite describing overlapping sets.
 */
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
