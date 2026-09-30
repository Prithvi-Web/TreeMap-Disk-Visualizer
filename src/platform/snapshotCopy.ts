import fs, { promises as fsp } from 'fs';
import path from 'path';

/** What fs.cp answers when something is already at a name it was asked to create. */
const TAKEN = new Set(['ERR_FS_CP_EEXIST', 'EEXIST', 'ERR_FS_CP_DIR_TO_NON_DIR', 'ERR_FS_CP_NON_DIR_TO_DIR']);

/**
 * Copies `source` out of a snapshot to `destination`, never over anything already there (FG4,
 * FG4c). Answers false when the destination was taken, true when the copy was made; any other
 * failure throws.
 *
 * The Linux and Windows restores used `fs.cp` with its default `force: true`, which replaces a
 * file at the destination — the service checks the destination before the restore, but a name
 * that appears after that check was replaced. `fs.cp`'s own flags do not settle it either
 * (review #5, #19): on Node 20 — CI's, Electron 31's, the Docker image's — it merges a folder
 * into one already there; on every Node it replaces a link at the destination whatever the flags
 * say; and a folder onto a file, or a file onto a folder, throws rather than answering "taken".
 * So each kind claims its name with a call that fails if anything at all is there:
 *  - a link is made with `symlink`, as the snapshot holds it (`verbatimSymlinks`) or, as `fs.cp`
 *    would, with a relative target resolved from where it was;
 *  - a folder claims its name with `mkdir` (not recursive), and its entries are copied into it;
 *  - anything else is copied by `fs.cp` with `force: false`, `errorOnExist` and `COPYFILE_EXCL`,
 *    whose file copy is exclusive on every Node.
 * A name planted inside a folder this call just made, while it copies, fails the rest of the copy
 * as taken, with what was copied so far left in that folder.
 */
export async function copyOutOfSnapshot(source: string, destination: string, opts: { verbatimSymlinks?: boolean } = {}): Promise<boolean> {
  const cpOptions: fs.CopyOptions = {
    recursive: true,
    preserveTimestamps: true,
    force: false,
    errorOnExist: true,
    mode: fs.constants.COPYFILE_EXCL,
    ...(opts.verbatimSymlinks ? { verbatimSymlinks: true } : {}),
  };
  const st = await fsp.lstat(source);
  try {
    if (st.isSymbolicLink()) {
      const text = await fsp.readlink(source);
      await fsp.symlink(opts.verbatimSymlinks || path.isAbsolute(text) ? text : path.resolve(path.dirname(source), text), destination);
      return true;
    }
    if (st.isDirectory()) {
      await fsp.mkdir(destination);
      for (const name of await fsp.readdir(source)) {
        await fsp.cp(path.join(source, name), path.join(destination, name), cpOptions);
      }
      await fsp.chmod(destination, st.mode & 0o7777);
      return true;
    }
    await fsp.cp(source, destination, cpOptions);
    return true;
  } catch (err) {
    if (TAKEN.has((err as NodeJS.ErrnoException).code ?? '')) return false;
    throw err;
  }
}

/** The reason a restore gives when its destination was taken. */
export function destinationTakenReason(destination: string): string {
  return `Something is already at ${destination}, so nothing was restored over it. Choose another name, or move that file aside first.`;
}
