import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-mountBoundaries-data-');

import { boundaryRecord, mountOutcome, neverDescend, noteRefusedBelow, type BoundaryMount, type MountOutcome, type ScanBoundaryRecord } from '../src/utils/mountBoundaries';
import { markUnlistedPaths } from '../src/services/scanRefusals';
import { buildStoreFromTree, Flag, type ScanStore } from '../src/services/scanStore';
import type { FileNode } from '../src/models/types';

/**
 * The descent guard is what keeps a full-disk scan from wandering into
 * /System/Volumes (re-counting the whole Data volume) or into automount /
 * dead-mount triggers whose open()/stat() block forever. It gates descent
 * only — any of these paths chosen directly as a scan root is never asked.
 */

test('darwin: mount re-entry points and automount triggers are refused', () => {
  for (const p of ['/System/Volumes', '/Volumes', '/dev', '/home', '/net', '/Network']) {
    assert.equal(neverDescend(p, 'darwin'), true, `${p} must not be descended into`);
  }
});

test('darwin: real content roots pass', () => {
  for (const p of ['/System', '/Users', '/Applications', '/private', '/Library', '/opt']) {
    assert.equal(neverDescend(p, 'darwin'), false, `${p} must be walkable`);
  }
});

test('darwin: children of a skipped dir are unaffected (root-scan case)', () => {
  // Scanning /Volumes/Backup directly starts AT that path — the guard is
  // only consulted for children found on the way down, so the entry itself
  // must not match.
  assert.equal(neverDescend('/Volumes/Backup', 'darwin'), false);
  assert.equal(neverDescend('/System/Volumes/Data', 'darwin'), false);
});

test('linux: pseudo-filesystems are refused, real roots pass', () => {
  for (const p of ['/proc', '/sys', '/dev', '/run']) {
    assert.equal(neverDescend(p, 'linux'), true);
  }
  assert.equal(neverDescend('/home', 'linux'), false, 'linux /home is real user data');
  assert.equal(neverDescend('/var', 'linux'), false);
});

test('windows: no descent restrictions', () => {
  assert.equal(neverDescend('C:\\Windows', 'win32'), false);
});

/* ─────────── The work a settle does is linear in the mounts (the SEC-1 review, L4) ─────────── */

/** A Docker host's overlay mounts: every one under one folder, each in a folder of its own. */
const OVERLAY = '/var/lib/docker/overlay2';
const hashOf = (i: number): string => i.toString(16).padStart(64, '0');

test('a refused folder costs a look at the mounts beneath it, not at every mount: reads of the list stay linear in it (L4)', () => {
  const count = 2000;
  const refused = 1000;
  let reads = 0;
  const list: BoundaryMount[] = Array.from({ length: count }, (_, i) => ({ path: `${OVERLAY}/${hashOf(i)}/merged`, filesystem: 'overlay', source: 'overlay', underFixed: false }));
  list.push({ path: '/Volumes/Backup', filesystem: 'apfs', source: '/dev/disk9s1', underFixed: true });
  // Every read of an entry is counted: the quadratic version read the whole list once per refused folder.
  const mounts = new Proxy(list, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) reads++;
      return Reflect.get(target, prop, receiver);
    },
  });
  const record = boundaryRecord({ rule: 'stay', source: '/proc/mounts', reason: null, mounts, fixed: [], neverDescend: list.map((m) => m.path) });
  for (let d = 0; d < refused; d++) noteRefusedBelow(record, `/root/denied/dir-${d}`);
  assert.equal(record.walk.refusedAbove.size, 0, 'no mount lies beneath any of those');
  noteRefusedBelow(record, `${OVERLAY}/${hashOf(7)}`);
  assert.deepEqual([...record.walk.refusedAbove], [`${OVERLAY}/${hashOf(7)}/merged`], 'the one beneath it, and not its look-alike siblings');
  noteRefusedBelow(record, OVERLAY);
  assert.equal(record.walk.refusedAbove.size, count, 'every mount beneath the folder');
  noteRefusedBelow(record, '/Volumes');
  assert.ok(!record.walk.refusedAbove.has('/Volumes/Backup'), 'a mount under a fixed folder is never reached anyway');
  noteRefusedBelow(record, `${OVERLAY}/${hashOf(9)}/merged`);
  assert.equal(record.walk.refusedAbove.size, count, 'a mount point itself is not beneath itself');
  assert.ok(reads <= 2 * (count + 1), `${reads} reads of a list of ${count + 1} mounts over ${refused + 4} refused folders`);
});

test('marking the folders a scan never listed reads each folder’s listing at most once, however many drives it holds (L4)', () => {
  const count = 2000;
  const kids = (i: number): FileNode[] => (i % 2 === 0 ? [{ name: 'merged', path: `/r${OVERLAY}/${hashOf(i)}/merged`, size: 0, type: 'dir', modifiedAt: 0, isHidden: false, children: [] }] : []);
  const dir = (p: string, children: FileNode[]): FileNode => ({ name: p.slice(p.lastIndexOf('/') + 1), path: p, size: 0, type: 'dir', modifiedAt: 0, isHidden: false, children });
  // /r/var/lib/docker/overlay2/<hash>[/merged]: the even ones hold their mount point; gdu drops the odd ones' (-x).
  const overlay = dir(`/r${OVERLAY}`, Array.from({ length: count }, (_, i) => dir(`/r${OVERLAY}/${hashOf(i)}`, kids(i))));
  const tree = dir('/r', [dir('/r/var', [dir('/r/var/lib', [dir('/r/var/lib/docker', [overlay])])]), dir('/r/home', []), dir('/r/home', [])]);
  const real = buildStoreFromTree(tree);
  real.finalize();
  // The work, counted: a lookup by path scans every child of each folder on the way down, as the store does.
  let work = 0;
  const childCountsOnTheWay = (p: string): number => {
    let id = real.rootId;
    let n = 0;
    for (const name of p.slice('/r/'.length).split('/')) {
      n += real.childCount(id);
      id = real.childByName(id, name);
      if (id === -1) break;
    }
    return n;
  };
  const store = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === 'findByPath') return (p: string) => { work += childCountsOnTheWay(p); return target.findByPath(p); };
      if (prop === 'childByName') return (id: number, name: string) => { work += target.childCount(id); return target.childByName(id, name); };
      if (prop === 'forEachChild') return (id: number, fn: (c: number) => void) => target.forEachChild(id, (c) => { work++; fn(c); });
      if (prop === 'childIds') return (id: number) => { const ids = target.childIds(id); work += ids.length; return ids; };
      return value.bind(target);
    },
  }) as ScanStore;
  const paths = Array.from({ length: count }, (_, i) => `/r${OVERLAY}/${hashOf(i)}/merged`);
  markUnlistedPaths(store, [...paths, '/r/home', '/r/absent', '/r/nowhere/x', '/r']);
  const flagged = (p: string): boolean => real.flag(real.findByPath(p), Flag.Unlisted);
  assert.ok(flagged(paths[0]), 'a mount point the tree holds is marked');
  assert.ok(!flagged(`/r${OVERLAY}/${hashOf(0)}`), 'and not the folder that holds it');
  assert.ok(flagged(`/r${OVERLAY}/${hashOf(1)}`), 'where the tree left the mount point out, the folder that held it');
  assert.ok(flagged('/r/home'), 'a folder directly under the root');
  const homes = real.childIds(real.rootId).filter((id) => real.name(id) === 'home');
  assert.deepEqual(homes.map((id) => real.flag(id, Flag.Unlisted)), [true, false], 'of two of one name, the first — the one a lookup by path finds');
  assert.ok(!flagged('/r'), 'the root was listed, and a drive gone from directly under it marks nothing');
  const listings = count + count / 2 + 7;
  assert.ok(work <= 2 * listings, `${work} children looked at, for ${listings} children in the folders on the way`);
});

test('marking a path under two folders of one name finds it where a lookup by path does: in the second, when only the second holds it (the SEC-2 review, LOW-2)', () => {
  // An archive's listing or a sliced adopt can hold two siblings of one name. The lookup by path
  // tries each in turn (findByPath backtracks); the listing kept only the first of each name, so it
  // marked the wrong folder, or none.
  const dir = (p: string, children: FileNode[]): FileNode => ({ name: p.slice(p.lastIndexOf('/') + 1), path: p, size: 0, type: 'dir', modifiedAt: 0, isHidden: false, children });
  const store = buildStoreFromTree(dir('/r', [
    dir('/r/a', [dir('/r/a/other', [])]),
    dir('/r/a', [dir('/r/a/mnt', [])]),
    dir('/r/b', []),
    dir('/r/b', [dir('/r/b/x', [])]),
  ]));
  store.finalize();
  markUnlistedPaths(store, ['/r/a/mnt', '/r/b/x/gone']);
  const named = (name: string): number[] => store.childIds(store.rootId).filter((id) => store.name(id) === name);
  const mnt = store.findByPath('/r/a/mnt');
  assert.equal(store.parent(mnt), named('a')[1], 'the lookup by path finds it in the second a');
  assert.equal(store.flag(mnt, Flag.Unlisted), true, 'and that is the folder marked');
  assert.deepEqual(named('a').map((id) => store.flag(id, Flag.Unlisted)), [false, false], 'never an a in its place');
  assert.equal(store.flag(store.findByPath('/r/b/x'), Flag.Unlisted), true, 'a path the tree left out marks the folder that held it, found the same way');
  assert.deepEqual(named('b').map((id) => store.flag(id, Flag.Unlisted)), [false, false]);
});
/* ─────────── What became of each mount is linear in the mounts (QA-5b, from the SEC-1 review's notes) ─────────── */

/** mountOutcome as SEC-1 left it, quadratic in the mounts: the reference its answers are compared with. */
function outcomeByPairs(record: ScanBoundaryRecord): MountOutcome {
  if (record.mounts === null) return { known: false, notEntered: [], entered: [], unreached: [], enteredWithin: [] };
  const reached = record.mounts.filter((m) => !m.underFixed && !record.walk.refusedAbove.has(m.path) && !record.walk.skipped.has(m.path));
  const inside = (m: BoundaryMount): boolean => reached.some((o) => o !== m && o.path !== m.path && m.path.startsWith(`${o.path}/`));
  const outer = reached.filter((m) => !inside(m));
  const within = reached.filter(inside);
  const unreached = record.mounts.filter((m) => !reached.includes(m));
  if (record.rule === 'stay') return { known: true, notEntered: outer, entered: [], unreached: [...unreached, ...within], enteredWithin: [] };
  return { known: true, notEntered: [], entered: outer, unreached, enteredWithin: within };
}

/**
 * A Docker host's mounts, nested: `count` overlay folders, each with its merged view mounted inside and, for every
 * third, a bind mount inside that; every fifth under a refused folder, every seventh under a skipped one, and a few
 * under a fixed folder. Each mount's `path` is read through a getter that counts.
 */
function nestedMounts(count: number): { list: BoundaryMount[]; reads: () => number; refused: Set<string>; skipped: Set<string> } {
  let reads = 0;
  const mount = (p: string, underFixed = false): BoundaryMount => {
    const m = { filesystem: 'overlay', source: 'overlay', underFixed } as BoundaryMount;
    Object.defineProperty(m, 'path', { enumerable: true, get: () => { reads++; return p; } });
    return m;
  };
  const list: BoundaryMount[] = [];
  const refused = new Set<string>();
  const skipped = new Set<string>();
  for (let i = 0; i < count; i++) {
    const outer = `${OVERLAY}/${hashOf(i)}`;
    list.push(mount(outer));
    list.push(mount(`${outer}/merged`));
    if (i % 3 === 0) list.push(mount(`${outer}/merged/etc/hosts.d`));
    if (i % 5 === 0) refused.add(`${outer}/merged`);
    if (i % 7 === 0) skipped.add(outer);
  }
  list.push(mount('/Volumes/Backup', true), mount('/Volumes/Backup/inner', true));
  return { list, reads: () => reads, refused, skipped };
}

for (const rule of ['stay', 'cross'] as const) {
  test(`${rule}: what became of each mount is the pairwise answer, with each mount's path read a bounded number of times, not once per other mount`, () => {
    const count = 600;
    const { list, reads, refused, skipped } = nestedMounts(count);
    const record = boundaryRecord({ rule, source: '/proc/mounts', reason: null, mounts: list, fixed: [], neverDescend: [] });
    for (const p of refused) record.walk.refusedAbove.add(p);
    for (const p of skipped) record.walk.skipped.add(p);
    const want = outcomeByPairs(record);
    // Every scan of every entry is counted too: `includes` over a list is a pass over it, whatever it compares.
    let scanned = 0;
    const includes = Array.prototype.includes;
    const before = reads();
    let got: MountOutcome;
    Array.prototype.includes = function (this: unknown[], ...args: [unknown, number?]) { scanned += this.length; return includes.apply(this, args); };
    try {
      got = mountOutcome(record);
    } finally {
      Array.prototype.includes = includes;
    }
    const work = reads() - before + scanned;
    const paths = (l: readonly BoundaryMount[]): string[] => l.map((m) => m.path).sort();
    for (const key of ['notEntered', 'entered', 'unreached', 'enteredWithin'] as const) {
      assert.deepEqual(paths(got[key]), paths(want[key]), `${key} is the pairwise answer`);
    }
    assert.equal(got.known, true);
    assert.ok(paths(rule === 'stay' ? got.notEntered : got.entered).length > 0 && paths(got.unreached).length > 0, 'the fixture reaches some mounts and not others');
    assert.ok(work <= 8 * list.length, `${work} reads and list entries scanned, for ${list.length} mounts`);
  });
}
