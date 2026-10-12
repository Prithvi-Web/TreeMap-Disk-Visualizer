import fs from 'node:fs';
import path from 'node:path';

/**
 * `fs.promises.opendir` as Node 20 types a listing's entries on Windows, on any machine.
 *
 * Node 20 bundles libuv 1.46, whose Windows `fs.Dir` read (`fs__readdir`, over FindNextFileW) types an
 * entry by FILE_ATTRIBUTE_DIRECTORY before FILE_ATTRIBUTE_REPARSE_POINT: a symbolic link to a folder and
 * a junction — both carry the two attributes — come out `isDirectory()`, never `isSymbolicLink()`.
 * (`fs.readdir` with `withFileTypes`, libuv's scandir, checks the reparse point first and reads them as
 * links; libuv later reordered the Dir read too.) The Windows CI leg met it as git being sent through a
 * link at the top of a git folder (CI run 38318285188). Electron 31, which TreeMap ships, is Node 20.
 *
 * While installed, every entry a listing hands out that is a link to a folder reads as that folder, as
 * there; every other entry is the platform's own. Names may be strings or Buffers (`encoding: 'buffer'`).
 */
export function listAsWindowsNode20(): { restore(): void } {
  const promises = fs.promises as unknown as { opendir: (...args: unknown[]) => Promise<fs.Dir> };
  const real = promises.opendir;
  promises.opendir = async (...args: unknown[]): Promise<fs.Dir> => {
    const dir = await real.apply(fs.promises, args);
    const asWindows = (entry: fs.Dirent | null): fs.Dirent | null => {
      if (entry === null || !entry.isSymbolicLink()) return entry;
      const name = entry.name as unknown as string | Buffer;
      const full = typeof name === 'string' ? path.join(dir.path, name) : Buffer.concat([Buffer.from(`${dir.path}${path.sep}`), name]);
      let leadsToFolder = false;
      try {
        leadsToFolder = fs.statSync(full).isDirectory();
      } catch {
        // To nothing: no folder to read it as.
      }
      if (!leadsToFolder) return entry;
      return Object.assign(Object.create(Object.getPrototypeOf(entry) as object) as fs.Dirent, entry, {
        isDirectory: () => true,
        isSymbolicLink: () => false,
        isFile: () => false,
      });
    };
    return new Proxy(dir, {
      get(target, key) {
        if (key === 'read') return async () => asWindows(await target.read());
        if (key === Symbol.asyncIterator) {
          return async function* entries(): AsyncGenerator<fs.Dirent> {
            try {
              for (let entry = await target.read(); entry !== null; entry = await target.read()) yield asWindows(entry) as fs.Dirent;
            } finally {
              await target.close().catch(() => { /* already closed */ });
            }
          };
        }
        // The Dir itself as `this`: its own fields are private to it, and a proxy has none.
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  };
  return { restore: () => { promises.opendir = real; } };
}
