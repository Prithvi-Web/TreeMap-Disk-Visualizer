import path from 'node:path';
import { detectContainerKind } from '../../utils/containerKind';
import type { NodeInput } from '../scanStore';

/**
 * Everything lstat tells us about one entry, shaped for store.addNode — the
 * one function every disk engine goes through, so the JSON they emit agrees
 * by construction. The legacy walker calls it with a `Stats`; the native
 * engine (Phase 3) calls it with the same five facts read out of the walk's
 * columns. Nothing here may depend on where the facts came from.
 *
 *  - `size` is 0 for a directory (sumSizes computes their totals);
 *  - `modifiedAt` is `Math.round` of the millisecond double, exactly as Node's
 *    `Stats.mtimeMs` rounds (the native walk hands over the unrounded double
 *    computed the same way, decision P3-6);
 *  - an atime of zero — or anything not above zero — means "never recorded"
 *    on several file systems and is omitted rather than shown as 1970;
 *  - the extension is `path.extname` lower-cased without its dot, files only;
 *  - hidden is the dot prefix, on every platform.
 */
export function statToInput(name: string, isDir: boolean, size: number, mtimeMs: number, atimeMs?: number): NodeInput {
  const input: NodeInput = {
    name,
    isDir,
    size: isDir ? 0 : size,
    modifiedAt: Math.round(mtimeMs),
    isHidden: name.startsWith('.'),
  };
  // atime === 0 means "never recorded" on several filesystems — omit rather
  // than let a 1970 date surface anywhere.
  if (atimeMs !== undefined && atimeMs > 0) input.accessedAt = Math.round(atimeMs);
  if (!isDir) {
    const ext = path.extname(name).toLowerCase().replace(/^\./, '');
    if (ext) input.extension = ext;
  }
  const container = detectContainerKind(name, isDir);
  if (container) input.container = container;
  return input;
}
