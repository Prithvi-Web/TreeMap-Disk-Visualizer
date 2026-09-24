import assert from 'node:assert/strict';
import { FileNode, ContainerKind } from '../../src/models/types';
import { ObjectScanStore, PackedScanStore, ScanStore, Flag, NodeInput } from '../../src/services/scanStore';

/**
 * The differential fuzz's trees and checks, shared by tests/packedStore.test.ts
 * (the packed store against the object store, the oracle) and
 * tests/packedStoreAdopt.test.ts (a store adopted from columns, as the native
 * build hands them over, against the same oracle).
 */

/* ------------------------- deterministic rng ------------------------- */

export function makeRng(seed: number): () => number {
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

export interface Profile {
  sep: '/' | '\\';
  rootPath: string;
  atime: boolean;
  cloudIds: boolean;
}

export function randomName(rng: () => number, serial: number): string {
  let s = rng() < 0.06 ? '.' : '';
  const len = 1 + Math.floor(rng() * 12);
  for (let i = 0; i < len; i++) s += NAME_CHARS[Math.floor(rng() * NAME_CHARS.length)];
  return `${s}${serial.toString(36)}`; // global serial keeps every name unique
}

export function randomFile(rng: () => number, name: string, profile: Profile): NodeInput {
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

export function randomDir(rng: () => number, name: string, profile: Profile): NodeInput {
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
export function generate(
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

export const FLAGS_TO_CHECK = [
  Flag.Dir, Flag.HasChildArray, Flag.Hidden, Flag.HardlinkDup, Flag.Symlink,
  Flag.CloudPlaceholder, Flag.GitRepo, Flag.Virtual, Flag.HasAccessed,
] as const;

/** Every node of the oracle must answer identically from the packed store. */
export function compareStores(obj: ObjectScanStore, packed: PackedScanStore, rng: () => number): void {
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
export function verifyPruneInvariants(store: ScanStore, pruned: FileNode): void {
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

export function comparePrunes(obj: ObjectScanStore, packed: PackedScanStore): void {
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

export function makeProfile(rng: () => number, iteration: number): Profile {
  const windows = iteration % 4 === 1;
  const cloud = iteration % 5 === 3;
  return {
    sep: windows ? '\\' : '/',
    rootPath: cloud ? 'cloud://gdrive' : windows ? 'C:\\Users\\fuzz' : '/fuzz/root',
    atime: !cloud && rng() < 0.5,
    cloudIds: cloud,
  };
}

export function buildPair(seed: number, iteration: number, nodes: number): {
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

/**
 * The same watcher-style mutations on both stores: size and mtime updates,
 * git flagging, removals (ancestors may already be gone), and new files
 * under surviving folders.
 */
export function mutateBoth(obj: ObjectScanStore, packed: PackedScanStore, rng: () => number): void {
  const paths: string[] = [];
  obj.eachNode(obj.rootId, (id) => paths.push(obj.path(id)));
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
}
