import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileNode, ContainerKind } from '../src/models/types';
import {
  ObjectScanStore,
  PackedScanStore,
  ScanStore,
  Flag,
  NodeInput,
} from '../src/services/scanStore';

/**
 * Differential fuzz: every random tree is built into ObjectScanStore (the
 * oracle — it delegates to the logic the app runs today) and PackedScanStore
 * from the identical NodeInput stream, and the two must agree on everything:
 * per-node metadata, traversal order, path lookup (hits and misses), size
 * summation, and — most importantly — prune() output that is byte-identical
 * as JSON across a sweep of budgets, before and after mutations.
 */

/* ------------------------- deterministic rng ------------------------- */

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* --------------------------- tree generator --------------------------- */

const EXTS = ['ts', 'png', 'mp4', 'zip', 'log', 'txt', undefined, undefined];
const CONTAINERS: ContainerKind[] = ['zip', 'tar', 'tgz', 'iso', 'dmg', 'photos', 'docker'];
const PROVIDERS = ['icloud', 'onedrive', 'dropbox'] as const;
const NAME_CHARS = 'abcdefghij-_ é文'.split('');

interface Profile {
  sep: '/' | '\\';
  rootPath: string;
  atime: boolean;
  cloudIds: boolean;
}

function randomName(rng: () => number, serial: number): string {
  let s = rng() < 0.06 ? '.' : '';
  const len = 1 + Math.floor(rng() * 12);
  for (let i = 0; i < len; i++) s += NAME_CHARS[Math.floor(rng() * NAME_CHARS.length)];
  return `${s}${serial.toString(36)}`; // global serial keeps every name unique
}

function randomFile(rng: () => number, name: string, profile: Profile): NodeInput {
  const ext = EXTS[Math.floor(rng() * EXTS.length)];
  const input: NodeInput = {
    name: ext ? `${name}.${ext}` : name,
    isDir: false,
    size: Math.floor(rng() * 1_000_000),
    modifiedAt: Math.floor(rng() * 2_000_000_000_000),
    isHidden: name.startsWith('.'),
    extension: ext,
  };
  if (profile.atime && rng() < 0.7) input.accessedAt = Math.floor(rng() * 2_000_000_000_000);
  if (rng() < 0.05) {
    input.hardlinkDuplicate = true;
    input.size = 0;
  } else if (rng() < 0.05) {
    input.isSymlink = true;
  } else if (rng() < 0.06) {
    input.cloudPlaceholder = true;
    input.cloudProvider = PROVIDERS[Math.floor(rng() * 3)];
  }
  if (rng() < 0.06) {
    const kind = CONTAINERS[Math.floor(rng() * CONTAINERS.length)];
    input.container = kind;
    input.name = `${name}.${kind === 'photos' ? 'photoslibrary' : kind}`;
    input.extension = kind === 'photos' ? 'photoslibrary' : kind;
  }
  if (profile.cloudIds && rng() < 0.8) input.cloudId = `cid-${Math.floor(rng() * 1e9)}`;
  return input;
}

function randomDir(rng: () => number, name: string, profile: Profile): NodeInput {
  const input: NodeInput = {
    name,
    isDir: true,
    size: 0,
    modifiedAt: Math.floor(rng() * 2_000_000_000_000),
    isHidden: name.startsWith('.'),
  };
  if (rng() < 0.05) input.gitRepo = true;
  if (profile.cloudIds && rng() < 0.8) input.cloudId = `cid-${Math.floor(rng() * 1e9)}`;
  return input;
}

/** Grow the same random tree into both stores until the budget is spent. */
function generate(
  rng: () => number,
  obj: ObjectScanStore,
  packed: PackedScanStore,
  profile: Profile,
  budget: { left: number },
): void {
  let serial = 0;
  const grow = (objParent: number, packedParent: number, depth: number): void => {
    if (budget.left <= 0 || depth > 7) return;
    const kids = Math.floor(rng() * 9); // 0..8 — zero keeps empty dirs common
    for (let i = 0; i < kids && budget.left > 0; i++) {
      const isDir = rng() < 0.3;
      const base = randomName(rng, serial++);
      const input = isDir ? randomDir(rng, base, profile) : randomFile(rng, base, profile);
      budget.left--;
      const oId = obj.addNode(objParent, input);
      const pId = packed.addNode(packedParent, input);
      if (isDir) grow(oId, pId, depth + 1);
    }
  };
  // One pass rarely spends the budget (branches die out); keep sprouting new
  // top-level subtrees until it is spent so big budgets mean big trees.
  while (budget.left > 0) {
    const before = budget.left;
    const isDir = rng() < 0.85;
    const base = randomName(rng, serial++);
    const input = isDir ? randomDir(rng, base, profile) : randomFile(rng, base, profile);
    budget.left--;
    const oId = obj.addNode(obj.rootId, input);
    const pId = packed.addNode(packed.rootId, input);
    if (isDir) grow(oId, pId, 1);
    if (budget.left === before) break; // safety: forward progress guaranteed above
  }
}

/* ----------------------------- verifiers ----------------------------- */

const FLAGS_TO_CHECK = [
  Flag.Dir, Flag.HasChildArray, Flag.Hidden, Flag.HardlinkDup, Flag.Symlink,
  Flag.CloudPlaceholder, Flag.GitRepo, Flag.Virtual, Flag.HasAccessed,
] as const;

/** Every node of the oracle must answer identically from the packed store. */
function compareStores(obj: ObjectScanStore, packed: PackedScanStore, rng: () => number): void {
  assert.equal(packed.count, obj.count, 'node counts');

  // Traversal parity, order included.
  const objNodes: string[] = [];
  const packedNodes: string[] = [];
  obj.eachNode(obj.rootId, (id) => objNodes.push(obj.path(id)));
  packed.eachNode(packed.rootId, (id) => packedNodes.push(packed.path(id)));
  assert.deepEqual(packedNodes, objNodes, 'eachNode order');

  const objFiles: string[] = [];
  const packedFiles: string[] = [];
  obj.eachFile(obj.rootId, (id) => objFiles.push(obj.path(id)));
  packed.eachFile(packed.rootId, (id) => packedFiles.push(packed.path(id)));
  assert.deepEqual(packedFiles, objFiles, 'eachFile order');

  // Per-node metadata via path lookup.
  obj.eachNode(obj.rootId, (oId) => {
    const p = obj.path(oId);
    const pId = packed.findByPath(p);
    assert.notEqual(pId, -1, `findByPath miss: ${p}`);
    assert.equal(packed.name(pId), obj.name(oId), `name @ ${p}`);
    assert.equal(packed.path(pId), p, `path @ ${p}`);
    assert.equal(packed.size(pId), obj.size(oId), `size @ ${p}`);
    assert.equal(packed.nodeType(pId), obj.nodeType(oId), `type @ ${p}`);
    assert.equal(packed.modifiedAt(pId), obj.modifiedAt(oId), `mtime @ ${p}`);
    assert.equal(packed.extension(pId), obj.extension(oId), `ext @ ${p}`);
    assert.equal(packed.accessedAt(pId), obj.accessedAt(oId), `atime @ ${p}`);
    assert.equal(packed.container(pId), obj.container(oId), `container @ ${p}`);
    assert.equal(packed.cloudProvider(pId), obj.cloudProvider(oId), `provider @ ${p}`);
    assert.equal(packed.cloudId(pId), obj.cloudId(oId), `cloudId @ ${p}`);
    assert.equal(packed.logicalSize(pId), obj.logicalSize(oId), `logicalSize @ ${p}`);
    assert.equal(packed.childCount(pId), obj.childCount(oId), `childCount @ ${p}`);
    assert.equal(packed.hasChildArray(pId), obj.hasChildArray(oId), `hasChildArray @ ${p}`);
    for (const f of FLAGS_TO_CHECK) {
      assert.equal(packed.flag(pId, f), obj.flag(oId, f), `flag ${f} @ ${p}`);
    }
    const oParent = obj.parent(oId);
    if (oParent === -1) assert.equal(packed.parent(pId), -1);
    else assert.equal(packed.path(packed.parent(pId)), obj.path(oParent), `parent @ ${p}`);
    // Materialized single nodes must be byte-identical.
    assert.equal(
      JSON.stringify(packed.materialize(pId)),
      JSON.stringify(obj.materialize(oId)),
      `materialize @ ${p}`,
    );
    // Absent paths never resolve.
    if (rng() < 0.15) {
      assert.equal(packed.findByPath(p + packed.sep + 'no-such-child'), -1);
      assert.equal(packed.findByPath(p + 'x'), obj.findByPath(p + 'x') === -1 ? -1 : packed.findByPath(p + 'x'));
    }
  });
}

/** pruneTree's §1.2 invariants, asserted against the live store. */
function verifyPruneInvariants(store: ScanStore, pruned: FileNode): void {
  const walk = (node: FileNode): void => {
    assert.ok(!(node.children && node.pruned), `never both children and pruned @ ${node.path}`);
    const id = store.findByPath(node.path);
    assert.notEqual(id, -1, `pruned output contains a real node @ ${node.path}`);
    assert.equal(node.size, store.size(id), `size stays exact @ ${node.path}`);
    if (node.children) {
      assert.equal(node.children.length, store.childCount(id), `whole-directory granularity @ ${node.path}`);
      for (const c of node.children) walk(c);
    } else if (store.hasChildArray(id) && store.childCount(id) === 0) {
      assert.fail(`empty dir must materialize children: [] @ ${node.path}`);
    }
  };
  walk(pruned);
}

function comparePrunes(obj: ObjectScanStore, packed: PackedScanStore): void {
  for (const maxNodes of [1, 20, 250, 20_000, 250_000]) {
    const o = obj.prune(obj.rootId, { maxNodes });
    const p = packed.prune(packed.rootId, { maxNodes });
    assert.equal(JSON.stringify(p.root), JSON.stringify(o.root), `prune JSON @ maxNodes=${maxNodes}`);
    assert.equal(p.nodes, o.nodes, `prune nodes @ ${maxNodes}`);
    assert.equal(p.prunedDirs, o.prunedDirs, `prunedDirs @ ${maxNodes}`);
    verifyPruneInvariants(packed, p.root);
  }
}

/* ------------------------------- tests ------------------------------- */

function makeProfile(rng: () => number, iteration: number): Profile {
  const windows = iteration % 4 === 1;
  const cloud = iteration % 5 === 3;
  return {
    sep: windows ? '\\' : '/',
    rootPath: cloud ? 'cloud://gdrive' : windows ? 'C:\\Users\\fuzz' : '/fuzz/root',
    atime: !cloud && rng() < 0.5,
    cloudIds: cloud,
  };
}

function buildPair(seed: number, iteration: number, nodes: number): {
  obj: ObjectScanStore;
  packed: PackedScanStore;
  rng: () => number;
  profile: Profile;
} {
  const rng = makeRng(seed);
  const profile = makeProfile(rng, iteration);
  const rootInput: NodeInput = {
    name: profile.rootPath.split(profile.sep).pop() || profile.rootPath,
    isDir: true,
    size: 0,
    modifiedAt: 1700000000000,
    isHidden: false,
  };
  const obj = new ObjectScanStore(profile.rootPath, profile.sep, rootInput);
  const packed = new PackedScanStore(profile.rootPath, profile.sep, rootInput);
  generate(rng, obj, packed, profile, { left: nodes });
  obj.finalize();
  packed.finalize();
  obj.sumSizes();
  packed.sumSizes();
  return { obj, packed, rng, profile };
}

test('differential fuzz: packed store matches the oracle on 120 random trees', () => {
  for (let iter = 0; iter < 120; iter++) {
    const { obj, packed, rng } = buildPair(1000 + iter, iter, 1200);
    try {
      compareStores(obj, packed, rng);
      comparePrunes(obj, packed);
    } catch (err) {
      throw new Error(`fuzz iteration ${iter} (seed ${1000 + iter}): ${String(err)}`, { cause: err });
    }
  }
});

test('differential fuzz: mutations keep both stores identical', () => {
  for (let iter = 0; iter < 40; iter++) {
    const { obj, packed, rng } = buildPair(9000 + iter, iter, 900);
    const paths: string[] = [];
    obj.eachNode(obj.rootId, (id) => paths.push(obj.path(id)));

    try {
      // Watcher-style size/mtime updates and git flagging.
      for (let i = 0; i < 25; i++) {
        const p = paths[Math.floor(rng() * paths.length)];
        const oId = obj.findByPath(p);
        const pId = packed.findByPath(p);
        assert.equal(oId === -1, pId === -1, `lookup agreement @ ${p}`);
        if (oId === -1) continue;
        const roll = rng();
        if (roll < 0.35) {
          const size = Math.floor(rng() * 500_000);
          obj.setSize(oId, size);
          packed.setSize(pId, size);
          const ms = Math.floor(rng() * 2e12);
          obj.setModifiedAt(oId, ms);
          packed.setModifiedAt(pId, ms);
        } else if (roll < 0.6) {
          const delta = Math.floor(rng() * 10_000) - 5000;
          obj.addToSize(oId, delta);
          packed.addToSize(pId, delta);
        } else if (roll < 0.8 && obj.isDir(oId)) {
          obj.setFlag(oId, Flag.GitRepo, true);
          packed.setFlag(pId, Flag.GitRepo, true);
        } else if (p !== obj.rootPath) {
          // Cloud-trash-style removal (ancestors may already be gone).
          obj.removeNode(oId);
          packed.removeNode(pId);
        }
      }

      // Watcher-created files under surviving dirs.
      for (let i = 0; i < 6; i++) {
        const p = paths[Math.floor(rng() * paths.length)];
        const oId = obj.findByPath(p);
        const pId = packed.findByPath(p);
        if (oId === -1 || !obj.isDir(oId)) continue;
        const input: NodeInput = {
          name: `fresh-${i}.log`, isDir: false, size: Math.floor(rng() * 9999),
          modifiedAt: 1750000000000, isHidden: false, extension: 'log',
        };
        obj.addNode(oId, input);
        packed.addNode(pId, input);
      }

      compareStores(obj, packed, rng);
      comparePrunes(obj, packed);
    } catch (err) {
      throw new Error(`mutation fuzz iteration ${iter} (seed ${9000 + iter}): ${String(err)}`, { cause: err });
    }
  }
});

test('differential: container graft (ingestSubtree) matches on both stores', () => {
  const { obj, packed } = buildPair(777, 0, 400);

  // Find a childless container file to graft into; guarantee one exists.
  let target = '';
  obj.eachNode(obj.rootId, (id) => {
    if (!target && !obj.isDir(id) && obj.container(id) !== undefined && !obj.hasChildArray(id)) {
      target = obj.path(id);
    }
  });
  if (!target) {
    const oId = obj.addNode(obj.rootId, { name: 'late.zip', isDir: false, size: 500, modifiedAt: 1, isHidden: false, extension: 'zip', container: 'zip' });
    const pId = packed.addNode(packed.rootId, { name: 'late.zip', isDir: false, size: 500, modifiedAt: 1, isHidden: false, extension: 'zip', container: 'zip' });
    void oId;
    void pId;
    target = obj.path(obj.findByPath(obj.rootPath + obj.sep + 'late.zip'));
  }
  const sep = obj.sep;
  const kids: FileNode[] = [
    {
      name: 'inner', path: `${target}${sep}inner`, size: 90, type: 'dir', modifiedAt: 123, isHidden: false, virtual: true,
      children: [
        { name: 'a.txt', path: `${target}${sep}inner${sep}a.txt`, size: 90, type: 'file', modifiedAt: 123, isHidden: false, virtual: true, logicalSize: 400, extension: 'txt' },
      ],
    },
    { name: 'top.bin', path: `${target}${sep}top.bin`, size: 10, type: 'file', modifiedAt: 123, isHidden: false, virtual: true, extension: 'bin' },
  ];
  obj.ingestSubtree(obj.findByPath(target), kids);
  packed.ingestSubtree(packed.findByPath(target), structuredClone(kids));

  const rng = makeRng(1);
  compareStores(obj, packed, rng);
  comparePrunes(obj, packed);
  assert.equal(packed.findByPath(`${target}${sep}inner${sep}a.txt`) !== -1, true);
});

test('a 60k-node tree prunes byte-identically across the budget sweep', () => {
  const { obj, packed, rng } = buildPair(31337, 0, 60_000);
  compareStores(obj, packed, rng);
  comparePrunes(obj, packed);
});

test('packed store survives a 30k-deep chain without recursion blowups', () => {
  const root: NodeInput = { name: 'root', isDir: true, size: 0, modifiedAt: 1, isHidden: false };
  const packed = new PackedScanStore('/deep', '/', root);
  let parent = packed.rootId;
  for (let i = 0; i < 30_000; i++) {
    parent = packed.addNode(parent, { name: `d${i}`, isDir: true, size: 0, modifiedAt: 1, isHidden: false });
  }
  packed.addNode(parent, { name: 'leaf.bin', isDir: false, size: 7, modifiedAt: 1, isHidden: false, extension: 'bin' });
  packed.finalize();
  packed.sumSizes();

  assert.equal(packed.size(packed.rootId), 7, 'the leaf sums all the way up');

  let deepest = '/deep';
  for (let i = 0; i < 30_000; i++) deepest += `/d${i}`;
  const dirId = packed.findByPath(deepest);
  assert.notEqual(dirId, -1);
  assert.equal(packed.findByPath(`${deepest}/leaf.bin`), packed.childByName(dirId, 'leaf.bin'));

  let count = 0;
  packed.eachNode(packed.rootId, () => count++);
  assert.equal(count, 30_002);

  const pruned = packed.prune(packed.rootId, { maxNodes: 50 });
  assert.ok(pruned.nodes >= 50 || pruned.prunedDirs === 0);
});

test('eviction semantics: dropping the store frees it for GC (no registry leaks)', () => {
  // The store keeps no module-level registries — everything is instance state,
  // so dropping the last reference is sufficient for GC. This guards against
  // someone adding a static cache later.
  const statics = Object.getOwnPropertyNames(PackedScanStore).filter(
    (k) => !['length', 'name', 'prototype'].includes(k),
  );
  assert.deepEqual(statics, [], 'PackedScanStore must hold no static state');
});
