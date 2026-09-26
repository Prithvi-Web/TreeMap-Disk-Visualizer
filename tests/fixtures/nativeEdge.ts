import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** The native engine's on-disk edge fixture, shared by its tests (tests/nativeEngine.test.ts, tests/nativeMemoryPath.test.ts). */

export const KB = 1024;
/** Whether a folder can be made unlistable here: not on Windows, and not as root. */
export const canLock = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

/**
 * Every condition the legacy walker documents (docs/engine/CURRENT-STATE.md §3.3)
 * that a temp directory can hold: hard links in one folder, a sparse file, a
 * cloud placeholder under a path the iCloud regex matches, `.git`, a symlink,
 * a refused folder, an empty folder, hidden entries, a Photos library, an
 * archive, names with accents and an emoji, every extension case.
 */
export async function buildEdgeFixture(prefix: string): Promise<{ root: string; total: number; locked: string | null }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  // Written with '/', as every folder below is: path.join turns it into the
  // platform's separator at the disk, and the count at the end splits on '/'.
  // Joined with '\' on Windows, this path's three folders counted as one, and
  // the builder expected two entries fewer than the walker found.
  const cloud = 'Library/Mobile Documents/com~apple~CloudDocs';
  const dirs = ['docs', 'docs/nested', 'empty', '.hidden-dir', 'repo', 'repo/.git', 'vm', cloud, 'photos.photoslibrary', 'mod0', 'mod1', 'mod2'];
  for (const d of dirs) await fsp.mkdir(path.join(root, d), { recursive: true });
  const file = (rel: string, bytes: number): Promise<void> => fsp.writeFile(path.join(root, rel), Buffer.alloc(bytes, 0x61));
  await file('docs/a.txt', 100);
  await file('docs/b.md', 200);
  await file('docs/NOEXT', 50);
  await file('docs/.dotfile', 7);
  await file('docs/résumé.txt', 77);
  await file('docs/party 🎉.txt', 11);
  await file('docs/nested/deep.TAR.GZ', 300);
  await file('archive.zip', 1234);
  await file('.hidden-dir/.secret', 42);
  await file('repo/.git/HEAD', 23);
  await file('repo/README', 5);
  await file('photos.photoslibrary/db.sqlite', 10);
  let files = 12;
  for (let d = 0; d < 3; d++) {
    for (let i = 0; i < 10; i++) { await file(`mod${d}/s${i}.ts`, 1000 + d * 100 + i); files++; }
  }
  // Hard links in the SAME folder: which twin is the duplicate is decided by
  // the listing order both engines see, not by a race between workers.
  await file('hard-a.bin', 999);
  await fsp.link(path.join(root, 'hard-a.bin'), path.join(root, 'hard-b.bin'));
  files += 2;
  // A symlink: never followed, a leaf with the link's own size.
  await fsp.symlink(path.join('docs', 'a.txt'), path.join(root, 'link.txt'));
  files++;
  // A sparse file outside any cloud folder: claims a mebibyte, occupies nothing.
  await file('vm/disk.img', 0);
  await fsp.truncate(path.join(root, 'vm', 'disk.img'), 1024 * KB);
  files++;
  // A placeholder: the same shape, but under a path the iCloud rule matches.
  await file(path.join(cloud, 'doc.pages'), 0);
  await fsp.truncate(path.join(root, cloud, 'doc.pages'), 4 * KB);
  files++;
  let locked: string | null = null;
  if (canLock) {
    locked = path.join(root, 'locked');
    await fsp.mkdir(locked);
    await file('locked/secret.bin', 1000);
    await fsp.chmod(locked, 0o000);
    dirs.push('locked');
  }
  // The root, every distinct folder (the cloud path is three deep and a nested
  // folder's parent is listed on its own too), and every file the walk can see.
  const distinct = new Set<string>();
  for (const d of dirs) {
    const parts = d.split('/');
    for (let i = 1; i <= parts.length; i++) distinct.add(parts.slice(0, i).join('/'));
  }
  return { root, total: 1 + distinct.size + files, locked };
}

export async function unlockAndRemove(root: string, locked: string | null): Promise<void> {
  if (locked) await fsp.chmod(locked, 0o755).catch(() => {});
  await fsp.rm(root, { recursive: true, force: true });
}
