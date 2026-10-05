import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-mountBoundaries-data-');

import { boundaryRecord, neverDescend, noteRefusedBelow, type BoundaryMount } from '../src/utils/mountBoundaries';
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
