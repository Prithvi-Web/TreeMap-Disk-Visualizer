import { promises as fsp } from 'fs';

/**
 * Whether an entry an `fs.opendir` listing calls a folder is one of its own — never a link to one.
 *
 * Node 20 bundles libuv 1.46 (Electron 31, which TreeMap ships, is Node 20), and its Windows listing
 * (`fs.Dir`, read with FindNextFileW) types an entry by FILE_ATTRIBUTE_DIRECTORY before
 * FILE_ATTRIBUTE_REPARSE_POINT: a symbolic link to a folder and a junction carry both, and read
 * `isDirectory()` there, never `isSymbolicLink()`. `lstat` follows no link and calls neither a folder
 * (libuv reads a symbolic link and a drive-letter junction as links). So an entry a listing calls a
 * folder is asked again with `lstat` — on every platform, one call each, so the answer never rests on
 * how a platform's listing types a link. Throws as `lstat` does (the entry went since it was listed).
 */
export async function listedFolderIsReal(full: string | Buffer): Promise<boolean> {
  return (await fsp.lstat(full)).isDirectory();
}
