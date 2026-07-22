/**
 * Dev-only benchmark harness for the scan-memory rewrite (not shipped).
 *
 * Generates a deterministic synthetic tree (seeded PRNG) and replays the
 * exact same node stream into either the legacy FileNode object tree or the
 * packed SoA store, then reports memory and throughput:
 *
 *   npx tsx --expose-gc scripts/bench-store.ts --mode=object --nodes=1000000
 *   npx tsx --expose-gc scripts/bench-store.ts --mode=packed --nodes=5000000
 *
 * Run with --expose-gc (and --max-old-space-size=8192 for big object runs)
 * so the bytes/item figure is a settled-heap delta, not allocation noise.
 */
import { FileNode } from '../src/models/types';
import { pruneTree } from '../src/utils/pruneTree';

/* ---------- args ---------- */

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const MODE = arg('mode', 'object');
const NODES = Number(arg('nodes', '1000000'));
const SEED = Number(arg('seed', '42'));
const FANOUT = Number(arg('fanout', '20'));

/* ---------- deterministic generator ---------- */

/** mulberry32 — small, fast, deterministic. */
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

const EXTS = ['ts', 'js', 'json', 'png', 'jpg', 'mp4', 'txt', 'log', 'zip', 'md', 'css', 'html', 'pdf', 'wav', 'db'];

export interface SynthNode {
  /** Parent id; -1 for the root. Parents are always emitted before children. */
  parent: number;
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  extension?: string;
  isHidden: boolean;
}

/**
 * Emit `total` nodes (root included) in a parent-before-child order.
 * `emit` must return the id it assigned to the node (0-based, dense).
 */
export function generateTree(total: number, seed: number, fanout: number, emit: (n: SynthNode) => number): void {
  const rng = makeRng(seed);
  const rootId = emit({ parent: -1, name: 'bench-root', isDir: true, size: 0, mtimeMs: 1700000000000, isHidden: false });
  let emitted = 1;
  // Queue of dirs still owed children. Plain array with a moving head — BFS.
  const dirQueue: number[] = [rootId];
  let head = 0;
  let serial = 0;

  while (emitted < total) {
    const dir = head < dirQueue.length ? dirQueue[head++] : rootId;
    const kids = Math.min(1 + Math.floor(rng() * fanout * 2), total - emitted);
    for (let i = 0; i < kids; i++) {
      const isDir = rng() < 0.22;
      const nameLen = 4 + Math.floor(rng() * 16);
      let name = `n${(serial++).toString(36)}`;
      while (name.length < nameLen) name += 'abcdefghij'[Math.floor(rng() * 10)];
      const hidden = rng() < 0.03;
      if (hidden) name = '.' + name;
      let ext: string | undefined;
      if (!isDir && rng() < 0.85) {
        ext = EXTS[Math.floor(rng() * EXTS.length)];
        name += '.' + ext;
      }
      const id = emit({
        parent: dir,
        name,
        isDir,
        size: isDir ? 0 : Math.floor(rng() * 50_000_000),
        mtimeMs: 1600000000000 + Math.floor(rng() * 100000000000),
        extension: ext,
        isHidden: hidden,
      });
      emitted++;
      if (isDir) dirQueue.push(id);
    }
  }
}

/* ---------- measurement ---------- */

function gc(): void {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
  }
}

interface Mem {
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  rss: number;
}

function mem(): Mem {
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers, rss: m.rss };
}

const mb = (b: number): string => (b / 1024 / 1024).toFixed(1) + ' MB';

/* ---------- object-tree benchmark (the legacy representation) ---------- */

function benchObject(): void {
  const before = mem();
  const t0 = performance.now();

  const byId: FileNode[] = [];
  generateTree(NODES, SEED, FANOUT, (n) => {
    const node: FileNode = {
      name: n.name,
      path: '', // filled below from the parent chain
      size: n.size,
      type: n.isDir ? 'dir' : 'file',
      modifiedAt: Math.round(n.mtimeMs),
      isHidden: n.isHidden,
    };
    if (n.extension) node.extension = n.extension;
    if (n.isDir) node.children = [];
    const id = byId.length;
    byId.push(node);
    if (n.parent >= 0) {
      const parent = byId[n.parent];
      node.path = parent.path + '/' + n.name;
      parent.children!.push(node);
    } else {
      node.path = '/bench/' + n.name;
    }
    return id;
  });
  const root = byId[0];
  const buildMs = performance.now() - t0;

  gc();
  const after = mem();

  // Full DFS: bottom-up size sum with an explicit stack (no recursion).
  const t1 = performance.now();
  const stack: FileNode[] = [root];
  const order: FileNode[] = [];
  while (stack.length) {
    const n = stack.pop()!;
    order.push(n);
    if (n.children) for (const c of n.children) stack.push(c);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    if (n.children) {
      let total = 0;
      for (const c of n.children) total += c.size;
      n.size = total;
    }
  }
  const dfsMs = performance.now() - t1;

  const t2 = performance.now();
  const pruned = pruneTree(root, { maxNodes: 250_000 });
  const pruneMs = performance.now() - t2;

  report('object (FileNode tree)', before, after, buildMs, dfsMs, pruneMs, pruned.nodes, root.size);
}

/* ---------- packed-store benchmark ---------- */

async function benchPacked(): Promise<void> {
  const { PackedScanStore } = await import('../src/services/scanStore');
  const before = mem();
  const t0 = performance.now();

  const store = new PackedScanStore('/bench/bench-root', '/');
  generateTree(NODES, SEED, FANOUT, (n) =>
    n.parent < 0
      ? store.rootId
      : store.addNode(n.parent, {
          name: n.name,
          isDir: n.isDir,
          size: n.size,
          modifiedAt: Math.round(n.mtimeMs),
          isHidden: n.isHidden,
          extension: n.extension,
        }),
  );
  store.finalize();
  const buildMs = performance.now() - t0;

  gc();
  const after = mem();

  const t1 = performance.now();
  store.sumSizes();
  const dfsMs = performance.now() - t1;

  const t2 = performance.now();
  const pruned = store.prune(store.rootId, { maxNodes: 250_000 });
  const pruneMs = performance.now() - t2;

  report('packed (SoA store)', before, after, buildMs, dfsMs, pruneMs, pruned.nodes, store.size(store.rootId));
}

function report(label: string, before: Mem, after: Mem, buildMs: number, dfsMs: number, pruneMs: number, prunedNodes: number, rootSize: number): void {
  const heap = after.heapUsed - before.heapUsed;
  const bufs = after.arrayBuffers - before.arrayBuffers;
  const total = heap + bufs;
  console.log(`\n=== bench-store: ${label} ===`);
  console.log(`nodes           ${NODES.toLocaleString()} (seed ${SEED}, fanout ~${FANOUT})`);
  console.log(`build           ${buildMs.toFixed(0)} ms  (${Math.round(NODES / (buildMs / 1000)).toLocaleString()} nodes/s)`);
  console.log(`full DFS (sum)  ${dfsMs.toFixed(0)} ms`);
  console.log(`prune to 250k   ${pruneMs.toFixed(0)} ms  (${prunedNodes.toLocaleString()} nodes emitted)`);
  console.log(`heap delta      ${mb(heap)}`);
  console.log(`arrayBuffers Δ  ${mb(bufs)}`);
  console.log(`bytes/item      ${(total / NODES).toFixed(1)}`);
  console.log(`peak RSS        ${mb(after.rss)}`);
  console.log(`root size       ${rootSize.toLocaleString()} bytes (checksum)`);
  if (typeof global.gc !== 'function') {
    console.log('NOTE: run with --expose-gc for a settled bytes/item figure.');
  }
}

if (MODE === 'object') benchObject();
else if (MODE === 'packed') void benchPacked();
else {
  console.error(`unknown --mode=${MODE} (use object|packed)`);
  process.exit(1);
}
