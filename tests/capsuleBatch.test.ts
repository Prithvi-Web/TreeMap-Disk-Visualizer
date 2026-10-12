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
function diskOf(entries: Record<string, { dir: boolean; dev: number; linkTo?: string }>, failing: string[] = [], failingLstat: string[] = []): PlaceReader {
  /**
   * Where a path leads: each link on the way followed, and the last name too when `followLast`. The names
   * are those after the root: on Windows the root holds the drive (`D:\`), which is no name to join.
   */
  const resolved = (p: string, followLast: boolean): string => {
    const full = path.resolve(p);
    let at = path.parse(full).root;
    const names = full.slice(at.length).split(path.sep).filter(Boolean);
    for (const [i, name] of names.entries()) {
      at = path.join(at, name);
      const link = entries[at]?.linkTo;
      if (link !== undefined && (followLast || i < names.length - 1)) at = path.resolve(link);
    }
    return at;
  };
  // A look at a path in `failing` fails as a volume having a bad moment does: it says nothing either
  // way. One in `failingLstat` fails for its own lstat only, as one look of several can.
  const look = (p: string, among = failing): void => {
    if (among.map((f) => path.resolve(f)).includes(path.resolve(p))) throw Object.assign(new Error('i/o error (a test)'), { code: 'EIO' });
  };
  return {
    lstat: async (p) => {
      look(p);
      look(p, failingLstat);
      const at = resolved(p, false);
      const e = entries[at];
      const isLink = e?.linkTo !== undefined;
      return e ? { dev: BigInt(e.dev), ino: BigInt(Object.keys(entries).indexOf(at) + 1), isSymbolicLink: () => isLink, isDirectory: () => e.dir && !isLink } : null;
    },
    stat: async (p) => {
      const e = entries[resolved(p, true)];
      return e ? { dev: BigInt(e.dev) } : null;
    },
    realPlaceOf: async (p) => {
      look(p);
      return entries[resolved(p, true)] ? resolved(p, true) : null;
    },
  };
}

test('a request whose place cannot be looked at is never silently its own item: one written inside another goes with it (FG3d #10)', async () => {
  const folder = path.join(ROOT, 'A');
  const inner = path.join(folder, 'b.txt');
  const beside = path.join(ROOT, 'C', 'c.txt');
  const entries = {
    [ROOT]: { dir: true, dev: 1 },
    [folder]: { dir: true, dev: 1 },
    [inner]: { dir: false, dev: 1 },
    [path.join(ROOT, 'C')]: { dir: true, dev: 1 },
    [beside]: { dir: false, dev: 1 },
  };
  const looks: [string, PlaceReader][] = [
    ['the item\u2019s', diskOf(entries, [inner])],
    ['the folder\u2019s', diskOf(entries, [folder])],
    ['the folder\u2019s own lstat alone', diskOf(entries, [], [folder])],
  ];
  for (const [which, disk] of looks) {
    const { top, covered } = await collapseBatch([folder, inner, beside].map((p) => ({ path: p })), disk);
    assert.deepEqual(top.map((r) => r.path), [folder, beside], `${which} look failed: not two copies of b.txt`);
    assert.deepEqual(covered.map((c) => [c.request.path, c.by]), [[inner, folder]], `${which} look failed: b.txt goes with the folder it is written inside`);
  }
  // Three deep, judged by how they are written: each goes with the outermost.
  const sub = path.join(folder, 'sub');
  const deep = path.join(sub, 'd.txt');
  const nested = { ...entries, [sub]: { dir: true, dev: 1 }, [deep]: { dir: false, dev: 1 } };
  const three = await collapseBatch([folder, sub, deep].map((p) => ({ path: p })), diskOf(nested, [deep]));
  assert.deepEqual(three.top.map((r) => r.path), [folder]);
  assert.deepEqual(three.covered.map((c) => [c.request.path, c.by]), [[sub, folder], [deep, folder]], 'by the outermost, a request of top');
  // One that is simply not there is its own item, as before: its own capture says it is gone.
  const gone = path.join(folder, 'gone.txt');
  const { top } = await collapseBatch([folder, gone].map((p) => ({ path: p })), diskOf(entries));
  assert.deepEqual(top.map((r) => r.path), [folder, gone]);
});

test('a request whose place cannot be looked at, written apart from every other, leaves the rest judged by where each is (FG3d #10)', async () => {
  const real = path.join(ROOT, 'real');
  const alias = path.join(ROOT, 'alias');
  const apart = path.join(ROOT, 'elsewhere', 'x.txt');
  const disk = diskOf({
    [ROOT]: { dir: true, dev: 1 },
    [real]: { dir: true, dev: 1 },
    [alias]: { dir: false, dev: 1, linkTo: real },
    [path.join(real, 'a.txt')]: { dir: false, dev: 1 },
    [path.join(ROOT, 'elsewhere')]: { dir: true, dev: 1 },
    [apart]: { dir: false, dev: 1 },
  }, [apart]);
  const throughAlias = path.join(alias, 'a.txt');
  const { top, covered } = await collapseBatch([real, throughAlias, apart].map((p) => ({ path: p })), disk);
  assert.deepEqual(covered.map((c) => [c.request.path, c.by]), [[throughAlias, real]], 'a.txt through the link is still the folder\u2019s, by where it is');
  assert.deepEqual(top.map((r) => r.path), [real, apart]);
});

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

test('an item held by a folder that is itself held goes with the outermost item: a volume\u2019s root mounted inside a folder of the batch, and an item on it (FG3d #4)', async () => {
  const folder = path.join(ROOT, 'A');
  const mount = path.join(folder, 'mnt');
  const sub = path.join(mount, 'sub');
  const onMount = path.join(sub, 'x.txt');
  const disk = diskOf({
    [ROOT]: { dir: true, dev: 1 },
    [folder]: { dir: true, dev: 1 },
    [mount]: { dir: true, dev: 2 },
    [sub]: { dir: true, dev: 2 },
    [onMount]: { dir: false, dev: 2 },
  });
  const { top, covered } = await collapseBatch([folder, mount, onMount].map((p) => ({ path: p })), disk);
  assert.deepEqual(top.map((r) => r.path), [folder]);
  assert.deepEqual(covered.map((c) => [c.request.path, c.by]), [[mount, folder], [onMount, folder]],
    'each names a request of top, the one whose copy and trash step take it');
  const tops = new Set(top.map((r) => r.path));
  for (const c of covered) assert.ok(tops.has(c.by), `${c.request.path} is held by ${c.by}, which is in top`);
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

/**
 * FG3f #6. When a request's place cannot be looked at, the batch asks whether it is written inside
 * another request or another inside it — and asked that of each such request against every other:
 * 2,000 requests whose looks failed (a volume having a bad moment) made four million path
 * comparisons, 19 seconds of the event loop that also serves the page. Counted here, never timed:
 * the path operations one collapse makes, wrapped for its duration, against a bound linear in the
 * batch times a path's depth.
 */
test('a batch whose places cannot be looked at is judged in work linear in the batch, not each request against every other (FG3f #6)', async () => {
  const n = 600;
  const requests = Array.from({ length: n }, (_, i) => ({ path: path.join(ROOT, 'Caches', `app-${i}`, 'data', 'node_modules') }));
  const eio = (): never => { throw Object.assign(new Error('i/o error (a test)'), { code: 'EIO' }); };
  const failing: PlaceReader = { lstat: async () => eio(), stat: async () => eio(), realPlaceOf: async () => eio() };
  const counted = ['resolve', 'relative', 'dirname'] as const;
  const real = Object.fromEntries(counted.map((name) => [name, path[name]])) as Pick<typeof path, typeof counted[number]>;
  let calls = 0;
  for (const name of counted) {
    (path as unknown as Record<string, unknown>)[name] = (...args: string[]) => {
      calls++;
      return (real[name] as (...a: string[]) => string)(...args);
    };
  }
  let collapsed: Awaited<ReturnType<typeof collapseBatch>>;
  try {
    collapsed = await collapseBatch(requests, failing);
  } finally {
    for (const name of counted) (path as unknown as Record<string, unknown>)[name] = real[name];
  }
  assert.equal(collapsed.top.length, n, 'none is inside another: each is its own item');
  assert.deepEqual(collapsed.covered, []);
  const depth = requests[0].path.split(path.sep).length;
  const bound = 10 * n * depth;
  assert.ok(calls <= bound, `${calls} path operations for ${n} requests: not linear in the batch (bound ${bound})`);
});
