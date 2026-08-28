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
 * Codes that mean the path is not there, or cannot be there.
 *
 * `ENOENT` and `ENOTDIR` are the plain absences. The other three describe a
 * path the kernel will never resolve however many times it is asked —
 * a symlink cycle, a component past `NAME_MAX`, an ill-formed path. Treating
 * those as "could not find out" is not conservative, it is a loop: the
 * condition never clears, so every event for such a path burns the full
 * retry budget and then marks the root stale, permanently. A deep
 * `node_modules` past `PATH_MAX` on Linux would do that on every event.
 */
const GONE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG', 'EINVAL']);

export function meansGone(err: unknown): boolean {
  // `cause` is walked because this codebase now chains errors (`diskUsage`
  // does), and a wrapped fs error with the answer inside it must not read as
  // "could not tell" just because the wrapper carries no code of its own.
  for (let e: unknown = err, depth = 0; e != null && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as NodeJS.ErrnoException).code;
    if (typeof code === 'string') return GONE.has(code);
    // An error that crossed a worker/structuredClone boundary loses its own
    // properties but keeps `errno`. -2 is ENOENT, -20 is ENOTDIR.
    const errno = (e as NodeJS.ErrnoException).errno;
    if (typeof errno === 'number') return errno === -2 || errno === -20;
  }
  return false;
}
