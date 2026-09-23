/**
 * Where the NTFS turbo mode's helper can actually be started from (W6, M6).
 *
 * In a packaged app, a path computed from `__dirname` runs through
 * `resources/app.asar`: Electron's own `fs` sees into the archive, so the
 * helper looks present, but Windows and PowerShell cannot, and
 * `Start-Process` would fail to find it. The release unpacks
 * `native/prebuilt` beside the archive (`asarUnpack` in package.json), so the
 * same file sits under `app.asar.unpacked`, which is the path to start.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** A folder named exactly `app.asar`, between two separators. */
const ASAR_FOLDER = /([\\/])app\.asar(?=[\\/])/;

/** `p` with its `app.asar` folder read as `app.asar.unpacked`; any other path unchanged. */
export function unpackedPath(p: string): string {
  return p.replace(ASAR_FOLDER, '$1app.asar.unpacked');
}

/** The answers that mean "not by this user": denied, or a read-only volume. */
const REFUSED = new Set(['EACCES', 'EPERM', 'EROFS']);

function refused(err: unknown): boolean {
  return REFUSED.has((err as NodeJS.ErrnoException).code ?? '');
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Why `file` must not be started as administrator on this user's say-so, or
 * null when it may be.
 *
 * Elevating a program that this user's own processes can change is elevating
 * whatever they changed it to: any malware running as the user could swap it
 * the moment before the person clicks yes (the third security review of M6
 * found the helper, and the PowerShell that starts it, in a per-user
 * install's own folder). So the program must sit where this user cannot
 * write — true of an install "for anyone who uses this computer" (Program
 * Files), not of one "only for me", a portable copy or a checkout.
 *
 * Every answer is tried, never inferred: Node reads no Windows ACL
 * (`fs.access` checks only the read-only attribute), and a path or an
 * environment variable proves nothing about who may write there. In order:
 * the file is not a link (what a link leads to is not what was checked); its
 * folder refuses this user a new file (a probe, removed at once — a folder
 * that takes one takes a replacement); this user cannot change the file's
 * mode (a no-op chmod — read-only by attribute or mode protects nothing its
 * owner may lift); and cannot open it for writing (opened, never written).
 */
export function elevationRefusal(file: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    return `${file} could not be checked: ${describe(err)}`;
  }
  if (stat.isSymbolicLink()) return `${file} is a link, and what it leads to was not checked`;

  const folder = path.dirname(file);
  const tmpPath = path.join(folder, `.treemap-write-probe-${crypto.randomUUID()}.tmp`);
  let probe: number | null = null;
  try {
    probe = fs.openSync(tmpPath, 'wx');
  } catch (err) {
    if (!refused(err)) return `the folder ${folder} could not be checked: ${describe(err)}`;
  }
  if (probe !== null) {
    closeQuietly(probe);
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* an empty probe of our own name; the refusal below stands either way */
    }
    return `the folder ${folder} lets any program running as you add or replace files in it`;
  }

  try {
    fs.chmodSync(file, stat.mode & 0o7777);
    return `${file} could be changed by any program running as you`;
  } catch (err) {
    if (!refused(err)) return `${file} could not be checked: ${describe(err)}`;
  }
  let opened: number | null = null;
  try {
    opened = fs.openSync(file, 'r+');
  } catch (err) {
    if (!refused(err)) return `${file} could not be checked: ${describe(err)}`;
  }
  if (opened !== null) {
    closeQuietly(opened);
    return `${file} could be changed by any program running as you`;
  }
  return null;
}

/**
 * Closes a descriptor a probe opened. The answer is the open's: a close that
 * then fails cannot turn "this user may write here" into "allowed" (the
 * TypeScript review of M6).
 */
function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    /* the open already answered */
  }
}
