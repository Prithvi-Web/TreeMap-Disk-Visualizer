import fs, { promises as fsp } from 'fs';

/**
 * Copies `source` out of a snapshot to `destination`, never over anything already there (FG4).
 *
 * The Linux and Windows restores used `fs.cp` with its default `force: true`, which replaces a
 * file at the destination — the service checks the destination before the restore, but a name
 * that appears after that check was replaced. Here a file, a link or a dangling link at the
 * destination fails the copy (`force: false` with `errorOnExist`, and `COPYFILE_EXCL` for a file
 * made in the moment between) and nothing is written through it. Answers false when the
 * destination was taken, true when the copy was made; any other failure throws.
 */
export async function copyOutOfSnapshot(source: string, destination: string, opts: { verbatimSymlinks?: boolean } = {}): Promise<boolean> {
  try {
    await fsp.cp(source, destination, {
      recursive: true,
      preserveTimestamps: true,
      force: false,
      errorOnExist: true,
      mode: fs.constants.COPYFILE_EXCL,
      ...(opts.verbatimSymlinks ? { verbatimSymlinks: true } : {}),
    });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ERR_FS_CP_EEXIST' || code === 'EEXIST') return false;
    throw err;
  }
}

/** The reason a restore gives when its destination was taken. */
export function destinationTakenReason(destination: string): string {
  return `Something is already at ${destination}, so nothing was restored over it. Choose another name, or move that file aside first.`;
}
