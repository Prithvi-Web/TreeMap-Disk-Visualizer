import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-capsuleBatch-data-');

import { collapseBatch, deepestFirst, shallowestFirst, type PlaceReader } from '../src/services/capsuleBatch';

/**
 * FG3c: which items of a delete batch go with another, judged by where each is on the disk. The
 * real-disk cases (another spelling, another case, a link out of a folder, a link as the item) are
 * in capsuleAfterTrash.test.ts, where they are trashed and undone. What no test can make without
 * privilege — a volume mounted inside a folder — is decided here from a stand-in for the disk.
 */

const ROOT = path.resolve('/stand-in');

/**
 * A disk of folders and files, each on a device, every name as stored — and links (`linkTo`), which
 * the real disk's realpath follows to where they lead, as `stat` does, while `lstat` reads the link.
 */
function diskOf(entries: Record<string, { dir: boolean; dev: number; linkTo?: string }>): PlaceReader {
  const at = (p: string) => entries[path.resolve(p)];
  const followed = (p: string) => (at(p)?.linkTo !== undefined ? path.resolve(at(p).linkTo as string) : path.resolve(p));
  return {
    lstat: async (p) => {
      const e = at(p);
      const isLink = e?.linkTo !== undefined;
      return e ? { dev: BigInt(e.dev), ino: BigInt(Object.keys(entries).indexOf(path.resolve(p)) + 1), isSymbolicLink: () => isLink, isDirectory: () => e.dir && !isLink } : null;
    },
    stat: async (p) => (at(followed(p)) ? { dev: BigInt(at(followed(p)).dev) } : null),
    realPlaceOf: async (p) => (at(p) && at(followed(p)) ? followed(p) : null),
  };
}

test('a folder holds what is inside it on its own device, and not what is on a volume mounted inside it (FG3c #7)', async () => {
  const folder = path.join(ROOT, 'A');
  const mount = path.join(folder, 'mnt');
  const own = path.join(folder, 'own.txt');
  const onMount = path.join(mount, 'x.txt');
  const disk = diskOf({
    [ROOT]: { dir: true, dev: 1 },
    [folder]: { dir: true, dev: 1 },
    [own]: { dir: false, dev: 1 },
    [mount]: { dir: true, dev: 2 },
    [onMount]: { dir: false, dev: 2 },
  });
  const { top, covered } = await collapseBatch([folder, own, onMount].map((p) => ({ path: p })), disk);
  assert.deepEqual(covered.map((c) => [c.request.path, c.by]), [[own, folder]], 'the file on its device goes with it');
  assert.deepEqual(top.map((r) => r.path), [folder, onMount], 'the one on the mounted volume is its own item');
});

test('a folder on the mounted volume holds what is inside it there (FG3c #7)', async () => {
  const folder = path.join(ROOT, 'A');
  const mount = path.join(folder, 'mnt');
  const inner = path.join(mount, 'sub');
  const deep = path.join(inner, 'x.txt');
  const disk = diskOf({
    [ROOT]: { dir: true, dev: 1 },
    [folder]: { dir: true, dev: 1 },
    [mount]: { dir: true, dev: 2 },
    [inner]: { dir: true, dev: 2 },
    [deep]: { dir: false, dev: 2 },
  });
  const { top, covered } = await collapseBatch([folder, inner, deep].map((p) => ({ path: p })), disk);
  assert.deepEqual(covered.map((c) => [c.request.path, c.by]), [[deep, inner]]);
  assert.deepEqual(top.map((r) => r.path), [folder, inner]);
});

test('a link and the folder it leads to are two items, whichever comes first: a link is itself the item, wherever it leads (FG3d #13)', async () => {
  const real = path.join(ROOT, 'real');
  const link = path.join(ROOT, 'link');
  const disk = diskOf({
    [ROOT]: { dir: true, dev: 1 },
    [real]: { dir: true, dev: 1 },
    [path.join(real, 'file.txt')]: { dir: false, dev: 1 },
    [link]: { dir: false, dev: 1, linkTo: real },
  });
  for (const batch of [[link, real], [real, link]]) {
    const { top, covered } = await collapseBatch(batch.map((p) => ({ path: p })), disk);
    assert.deepEqual(top.map((r) => r.path), batch, `both are items of their own (${batch.map((p) => path.basename(p)).join(', ')})`);
    assert.deepEqual(covered, [], 'neither goes with the other, nor is it the other spelled another way');
  }
});

test('the trash step goes deepest first and the undo shallowest first, each otherwise in the order given (FG3c)', () => {
  const a = path.join(ROOT, 'A');
  const through = path.join(ROOT, 'A', 'lnk', 'x.txt');
  const beside = path.join(ROOT, 'B', 'y.txt');
  const other = path.join(ROOT, 'C', 'z.txt');
  assert.deepEqual(deepestFirst([a, other, through, beside]), [through, other, beside, a]);
  const entries = [through, beside, other, a].map((originalPath) => ({ originalPath }));
  assert.deepEqual(shallowestFirst(entries).map((e) => e.originalPath), [a, beside, other, through]);
});
