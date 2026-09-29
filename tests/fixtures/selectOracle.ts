import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileNode } from '../../src/models/types';
import { Flag, PackedScanStore, pruneStore, prunedExpansion } from '../../src/services/scanStore';
import { buildTreemapFromStore } from '../../src/utils/treemap';
import { makeRng } from './storeFuzz';

/**
 * The selection ports' oracle (Phase 4 T15a, design §S.5.5): which rows
 * `pruneStore`/`prunedExpansion` (src/services/scanStore.ts) and
 * `buildTreemapFromStore` (src/utils/treemap.ts) read of a store, for seeded
 * trees full of ties, written to a file tm-store's Rust tests read
 * (`native/treemap-core/crates/tm-store/tests/fixtures/select-oracle.tsv`).
 * There `select_prune` and `select_treemap` must choose the same rows in the
 * same order, over the same trees, or a spilled scan would show a user a
 * different tree than the same scan held in memory.
 *
 * The trees are not in the file: each is grown from its `tree` line by
 * `generate` below, which tm-store's test (`tests/select.rs`) repeats draw for
 * draw with the same generator (`makeRng`, mulberry32), and the line carries a
 * digest of the finished tree so a generator that drifted is named as that,
 * not as a wrong selection. That is what lets one tree pass 250,000 rows (the
 * `PRUNE_MAX_NODES` of scanRoutes.ts) without putting 320,000 rows in the
 * file. The selections are written the same way, as counts and digests: with
 * every list spelled out the file would be 3.9 MB, not 0.2.
 *
 * What the JavaScript reads is recorded, not restated: a store whose
 * `childIds` and `bareNode` note each call gives the folders each function
 * reads the children of, in the order it reads them, and the rows
 * `pruneStore` makes nodes of. Each recording is held to what the function
 * returned. Only the treemap's `rows` are derived here: the root and, of each
 * folder it read, the children its size filter keeps (the rows a store must
 * hold for the same map to be laid out; the rest are read for their size
 * alone).
 *
 * Regenerate with `npx tsx tests/fixtures/selectOracle.ts`;
 * `tests/selectOracle.test.ts` fails when the file is stale. To see one case's
 * lists, e.g. the first tree pruned from its root to 50:
 *   npx tsx -e "const o = require('./tests/fixtures/selectOracle');
 *     console.log(o.pruneAnswer(o.treeOf(o.SHAPES[0]), 0, 50))"
 *
 * One record per line, tab-separated; a case belongs to the tree above it:
 *   tree    <name> <seed> <nodes> <dirPct> <chainPct> <widePct> <wideMin>
 *           <wideSpan> <smallMax> <zeroPct> <palettePct> <paletteLen>
 *           <containerPct> <openPct> <oddPct> <rows> <tree digest>
 *   prune   <root> <maxNodes> <expanded> <digest> <rows> <digest>
 *   treemap <root> <maxDepth> <minSize> <maxNodes> <read> <digest> <rows>
 *           <digest> <cells> <digest>
 * A list is its length and the FNV-1a (32-bit) digest of its little-endian
 * bytes: each id as a u32; each cell as its id and depth (u32), expanded (one
 * byte, 1 or 0) and x, y, w, h (f64). The tree digest takes each row in id
 * order: parent (i32), size after `sumSizes()` (f64), flags (u16), container
 * (u8), childStart and childCnt (u32).
 */

export const ORACLE_PATH = path.join(
  __dirname, '..', '..', 'native', 'treemap-core', 'crates', 'tm-store', 'tests', 'fixtures', 'select-oracle.tsv',
);

/**
 * How a tree grows. Every share is per hundred draws; see `generate`, which
 * reads them in a fixed order that the Rust copy of it follows.
 */
export interface Shape {
  readonly name: string;
  readonly seed: number;
  /** Rows, the root's included: `generate` grows every tree to exactly this many. */
  readonly nodes: number;
  /** Children that are folders. */
  readonly dirPct: number;
  /** Listings of one child, a folder: single-child chains. */
  readonly chainPct: number;
  /** Listings of wideMin + (draw mod (wideSpan + 1)) children. */
  readonly widePct: number;
  readonly wideMin: number;
  readonly wideSpan: number;
  /** Every other listing: draw mod (smallMax + 1) children. */
  readonly smallMax: number;
  /** Files of zero bytes; then files sized from the palette; the rest 1 + draw bytes. */
  readonly zeroPct: number;
  readonly palettePct: number;
  /** How much of the palette the tree draws from: 1 sizes every palette file alike. */
  readonly paletteLen: number;
  /** Files that are containers; of those, the opened ones (a child array and children). */
  readonly containerPct: number;
  readonly openPct: number;
  /** Rows no scan makes whose answer the JavaScript's rules still decide (see `generate`). */
  readonly oddPct: number;
}

/** A shape from its fields in the order a `tree` line writes them. */
const shape = (
  name: string, seed: number, nodes: number, dirPct: number, chainPct: number, widePct: number, wideMin: number,
  wideSpan: number, smallMax: number, zeroPct: number, palettePct: number, paletteLen: number, containerPct: number,
  openPct: number, oddPct: number,
): Shape => ({
  name, seed, nodes, dirPct, chainPct, widePct, wideMin, wideSpan, smallMax, zeroPct, palettePct, paletteLen,
  containerPct, openPct, oddPct,
});

/**
 * The trees. Ties everywhere: sizes from a palette that holds the treemap's
 * cut-offs themselves (1, 4096, 10240), folders of one palette size or two
 * (`flat`), chains where a folder is as large as its only child, folders
 * whose total is zero, wide folders whose last expansion overshoots any
 * budget, containers opened and not, and a spread tree with few ties to
 * check the ties are not all the test sees.
 */
export const SHAPES: readonly Shape[] = [
  shape('ties-a', 1, 400, 35, 10, 3, 30, 60, 6, 10, 85, 9, 5, 40, 3),
  shape('ties-b', 2, 1_200, 35, 10, 3, 30, 60, 6, 10, 85, 9, 5, 40, 3),
  shape('flat-a', 3, 500, 40, 15, 2, 20, 40, 5, 5, 95, 1, 0, 0, 0),
  shape('flat-b', 4, 1_500, 30, 5, 5, 50, 100, 7, 20, 80, 2, 0, 0, 0),
  shape('chains-a', 5, 300, 50, 60, 0, 0, 0, 3, 10, 80, 5, 0, 0, 0),
  shape('chains-b', 6, 900, 55, 45, 2, 10, 20, 4, 10, 80, 6, 3, 50, 2),
  shape('wide-a', 7, 3_000, 20, 5, 20, 100, 400, 6, 10, 80, 9, 2, 30, 1),
  shape('wide-b', 8, 2_500, 25, 0, 30, 60, 300, 3, 30, 70, 3, 0, 0, 0),
  shape('zeros-a', 9, 600, 45, 10, 3, 20, 30, 5, 70, 25, 4, 0, 0, 0),
  shape('zeros-b', 10, 800, 50, 20, 0, 0, 0, 4, 95, 5, 1, 0, 0, 0),
  shape('spread-a', 11, 1_000, 30, 5, 3, 30, 60, 8, 2, 0, 9, 5, 40, 2),
  shape('containers-a', 12, 800, 30, 5, 3, 20, 40, 6, 10, 70, 9, 40, 50, 10),
  shape('containers-b', 13, 1_500, 25, 5, 5, 30, 80, 6, 10, 60, 9, 30, 40, 8),
  shape('deep-a', 14, 700, 60, 30, 1, 10, 10, 3, 10, 80, 9, 2, 50, 2),
  shape('mixed-a', 15, 2_000, 30, 10, 5, 40, 200, 8, 15, 60, 9, 5, 40, 3),
  shape('tiny-a', 16, 40, 40, 10, 0, 0, 0, 4, 10, 80, 3, 5, 50, 5),
  shape('tiny-b', 17, 12, 50, 20, 0, 0, 0, 3, 10, 90, 2, 0, 0, 0),
];

/** The tree past the SSE frame's 250,000 rows, and past the treemap route's 20,000 cells. */
export const BIG: Shape = shape('big', 107, 320_000, 25, 5, 3, 100, 900, 14, 8, 70, 9, 3, 30, 0);

/** File sizes the palette draws from: the treemap cut-offs 1, 4096 and 10240, their neighbours, and a few more. */
const PALETTE: readonly number[] = [1, 2, 7, 4095, 4096, 4097, 10240, 65536, 1_048_576];

/** A draw of up to 20 bits: `Math.floor(rng() * k)` is exact below 2^21, so Rust takes it as `(u * k) >> 32`. */
const SPREAD = 1 << 20;

/** Flag bits no selection reads, set at random so a port that compared whole flag words would be caught. */
const EXTRA_FLAGS: readonly number[] = [
  0, 0, Flag.Hidden, Flag.HardlinkDup, Flag.Symlink, Flag.CloudPlaceholder, Flag.GitRepo, Flag.Virtual, Flag.HasAccessed,
];

/** A tree's columns in `PackedScanStore`'s layout: breadth-first ids, each listing one consecutive range. */
export interface TreeColumns {
  readonly parent: Int32Array;
  /** A file's bytes; 0 for a folder until `sumSizes()`. */
  readonly size: Float64Array;
  readonly flags: Uint16Array;
  readonly container: Uint8Array;
  readonly childStart: Uint32Array;
  readonly childCnt: Uint32Array;
}

/**
 * Grows `shape`'s tree breadth-first: each row, in id order, is given its
 * listing, so ids come out as `finalize()` numbers them. Every listing makes
 * two draws (its form, its count) and every child five (kind, size class,
 * value, oddity, container), whatever they decide, so the Rust copy stays in
 * step by counting draws rather than by following branches.
 *
 * A tree grown at random mostly dies out after a few levels, so a listing
 * made when no other listed row is waiting for its turn (`ahead` is zero)
 * gets at least one child, and its first child is a folder: the tree grows
 * until it holds `nodes` rows.
 *
 * The odd rows are ones a scan never makes — a folder without a child array,
 * a container with children but no child array, a plain file with a child
 * array and children — kept because `isExpandableId` and the treemap's own
 * test read different flags, and only such rows tell those rules apart.
 */
export function generate(shape: Shape): TreeColumns {
  const rng = makeRng(shape.seed);
  const draw = (k: number): number => Math.floor(rng() * k);
  const parent: number[] = [-1];
  const size: number[] = [0];
  const flags: number[] = [Flag.Dir | Flag.HasChildArray];
  const container: number[] = [0];
  const listed: boolean[] = [true];
  const childStart: number[] = [];
  const childCnt: number[] = [];
  let ahead = 1;
  for (let id = 0; id < parent.length; id++) {
    childStart.push(parent.length);
    if (listed[id]) {
      ahead--;
      const form = draw(100);
      const spread = draw(SPREAD);
      const chain = form < shape.chainPct;
      let count = chain
        ? 1
        : form < shape.chainPct + shape.widePct
          ? shape.wideMin + (spread % (shape.wideSpan + 1))
          : spread % (shape.smallMax + 1);
      const rescue = ahead === 0;
      if (rescue) count = Math.max(count, 1);
      count = Math.min(count, shape.nodes - parent.length);
      for (let k = 0; k < count; k++) {
        const kind = draw(100);
        const sized = draw(100);
        const value = draw(SPREAD);
        const odd = draw(100);
        const boxed = draw(100);
        let bits = EXTRA_FLAGS[(value >>> 4) % EXTRA_FLAGS.length];
        let bytes = 0;
        let box = 0;
        let lists = false;
        if (chain || (rescue && k === 0) || kind < shape.dirPct) {
          bits |= Flag.Dir;
          if (odd >= shape.oddPct) bits |= Flag.HasChildArray;
          lists = true;
        } else {
          if (sized < shape.zeroPct) bytes = 0;
          else if (sized < shape.zeroPct + shape.palettePct) bytes = PALETTE[value % shape.paletteLen];
          else bytes = 1 + value;
          if (boxed < shape.containerPct) {
            box = 1 + (value % 7);
            if (odd < shape.openPct) {
              bits |= Flag.HasChildArray;
              lists = true;
            } else if (odd < shape.openPct + shape.oddPct) {
              lists = true;
            }
          } else if (odd < shape.oddPct) {
            bits |= Flag.HasChildArray;
            lists = true;
          }
        }
        parent.push(id);
        size.push(bytes);
        flags.push(bits);
        container.push(box);
        listed.push(lists);
        if (lists) ahead++;
      }
    }
    childCnt.push(parent.length - childStart[id]);
  }
  return {
    parent: Int32Array.from(parent),
    size: Float64Array.from(size),
    flags: Uint16Array.from(flags),
    container: Uint8Array.from(container),
    childStart: Uint32Array.from(childStart),
    childCnt: Uint32Array.from(childCnt),
  };
}

/**
 * A packed store that notes what the selections read: the folders whose
 * children it hands out (`childIds`) and the rows it makes nodes of
 * (`bareNode`), each in call order, while `recording` is on.
 */
export class RecordingStore extends PackedScanStore {
  readonly read: number[] = [];
  readonly made: number[] = [];
  recording = false;

  override childIds(id: number): number[] {
    if (this.recording) this.read.push(id);
    return super.childIds(id);
  }

  override bareNode(id: number, knownPath?: string): FileNode {
    if (this.recording) this.made.push(id);
    return super.bareNode(id, knownPath);
  }
}

/** A tree adopted as a store and summed, as a native scan's is, with the columns it holds. */
export interface Tree {
  /** What failure messages call it. */
  readonly name: string;
  readonly store: RecordingStore;
  /** The store's own arrays: `size` holds the totals once `sumSizes()` has run. */
  readonly columns: TreeColumns;
  readonly n: number;
  /**
   * Each row's id by its path. A row is named by its id in base 36 and the
   * root `r`, which row 27's name repeats; no two siblings share a name, so
   * no two rows share a path.
   */
  readonly idOfPath: Map<string, number>;
}

/** `shape`'s tree in a store. */
export function treeOf(shape: Shape): Tree {
  return treeFromColumns(shape.name, generate(shape));
}

/** `generated` adopted as a store and summed, under the name `name`. */
export function treeFromColumns(name: string, generated: TreeColumns): Tree {
  const columns: TreeColumns = { ...generated, size: Float64Array.from(generated.size) };
  const n = columns.parent.length;
  const nameOff = new Uint32Array(n + 1);
  const text: string[] = [];
  let at = 0;
  for (let id = 0; id < n; id++) {
    const rowName = id === 0 ? 'r' : id.toString(36);
    text.push(rowName);
    at += rowName.length;
    nameOff[id + 1] = at;
  }
  const names = new TextEncoder().encode(text.join(''));
  const store = new RecordingStore('/r', '/', { name: 'r', isDir: true, size: 0, modifiedAt: 0, isHidden: false });
  store.adoptColumns({
    n,
    capacity: n,
    parent: columns.parent,
    size: columns.size,
    mtime: new Float64Array(n),
    atime: null,
    flags: columns.flags,
    ext: new Uint16Array(n),
    container: columns.container,
    cloudProv: new Uint8Array(n),
    nameOff,
    names,
    namesLen: names.length,
    childStart: columns.childStart,
    childCnt: columns.childCnt,
    extDict: [''],
    extOverflow: [],
  });
  store.sumSizes();
  const paths: string[] = [store.path(0)];
  const idOfPath = new Map<string, number>([[paths[0], 0]]);
  for (let id = 1; id < n; id++) {
    const p = store.childPath(id, paths[columns.parent[id]]);
    paths.push(p);
    idOfPath.set(p, id);
  }
  return { name, store, columns, n, idOfPath };
}

/* ------------------------------- digests ------------------------------- */

const scratch = new DataView(new ArrayBuffer(8));

/** FNV-1a, 32-bit, over little-endian bytes: tm-store's test computes the same. */
class Digest {
  private h = 0x811c9dc5;

  byte(b: number): void {
    this.h = Math.imul(this.h ^ (b & 0xff), 0x01000193) >>> 0;
  }

  u16(v: number): void {
    this.byte(v);
    this.byte(v >>> 8);
  }

  u32(v: number): void {
    for (let shift = 0; shift < 32; shift += 8) this.byte(v >>> shift);
  }

  f64(v: number): void {
    scratch.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) this.byte(scratch.getUint8(i));
  }

  hex(): string {
    return this.h.toString(16).padStart(8, '0');
  }
}

/** A list as the file writes it: its length and its digest. */
function listText(ids: readonly number[]): string {
  const d = new Digest();
  for (const id of ids) d.u32(id);
  return `${ids.length}\t${d.hex()}`;
}

/** The digest a `tree` line carries: every row's structural columns, the summed sizes included. */
function treeDigest(tree: Tree): string {
  const d = new Digest();
  const c = tree.columns;
  for (let id = 0; id < tree.n; id++) {
    d.u32(c.parent[id]);
    d.f64(c.size[id]);
    d.u16(c.flags[id]);
    d.byte(c.container[id]);
    d.u32(c.childStart[id]);
    d.u32(c.childCnt[id]);
  }
  return d.hex();
}

/* ------------------------------ the answers ------------------------------ */

/** What `pruneStore` reads: the folders it expands, in pop order, and the rows it makes nodes of, in order. */
export interface PruneAnswer {
  readonly expanded: number[];
  readonly rows: number[];
}

/**
 * `pruneStore` and `prunedExpansion` from `root` under `maxNodes`, recorded.
 * The two are held to each other here (the same folders, in the same order)
 * and `pruneStore`'s rows to the root and every child of each folder it
 * expanded, so the file cannot quietly hold a recording of something else.
 */
export function pruneAnswer(tree: Tree, root: number, maxNodes: number): PruneAnswer {
  const { store } = tree;
  store.read.length = 0;
  store.made.length = 0;
  store.recording = true;
  let expansion: Set<number>;
  let expansionRead: number[];
  let nodes: number;
  try {
    expansion = prunedExpansion(store, root, { maxNodes });
    expansionRead = store.read.splice(0);
    nodes = pruneStore(store, root, { maxNodes }).nodes;
  } finally {
    store.recording = false;
  }
  const expanded = [...expansion];
  const pruneRead = store.read.splice(0);
  const rows = store.made.splice(0);
  const at = `${tree.name}, prune from ${root} to ${maxNodes}`;
  assert.deepEqual(expansionRead, expanded, `${at}: prunedExpansion reads the folders it returns, in order`);
  assert.deepEqual(pruneRead, expanded, `${at}: pruneStore expands what prunedExpansion names, in order`);
  assert.equal(rows.length, nodes, `${at}: one node made per row counted`);
  assert.deepEqual(rows, [root, ...expanded.flatMap((f) => store.childIds(f))], `${at}: every child of each folder expanded`);
  return { expanded, rows };
}

/** One cell of the treemap, by id. */
export interface Cell {
  readonly id: number;
  readonly depth: number;
  readonly expanded: boolean;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** What `buildTreemapFromStore` reads and emits. */
export interface TreemapAnswer {
  /** The folders whose children it reads, in the order it reads them. */
  readonly read: number[];
  /** The root, then each read folder's children its size filter keeps, in child order. */
  readonly rows: number[];
  /** Its output, row by row. */
  readonly cells: Cell[];
}

export interface TreemapParams {
  readonly maxDepth: number;
  readonly minSize: number;
  readonly maxNodes: number;
}

/**
 * `buildTreemapFromStore` from `root` with `params`, recorded. Its reads are
 * held to its output: the queue takes the root and then the expanded cells in
 * the order they were emitted, and every cell it takes is read (an expanded
 * cell passes each test the loop makes), so `read` is the root, when it was
 * laid out, then a prefix of the expanded cells; and every cell is a row.
 */
export function treemapAnswer(tree: Tree, root: number, params: TreemapParams): TreemapAnswer {
  const { store } = tree;
  store.read.length = 0;
  store.recording = true;
  let out: ReturnType<typeof buildTreemapFromStore>;
  try {
    out = buildTreemapFromStore(store, root, params);
  } finally {
    store.recording = false;
  }
  const read = store.read.splice(0);
  const rows = [root];
  for (const folder of read) {
    for (const c of store.childIds(folder)) {
      if (store.size(c) >= params.minSize && store.size(c) > 0) rows.push(c);
    }
  }
  const at = `${tree.name}, treemap from ${root} at ${params.maxDepth}/${params.minSize}/${params.maxNodes}`;
  const cells = out.map((node): Cell => {
    const id = tree.idOfPath.get(node.path);
    assert.ok(id !== undefined, `${at}: the treemap emitted ${node.path}, which is no row`);
    return { id, depth: node.depth, expanded: node.expanded, x: node.x, y: node.y, w: node.w, h: node.h };
  });
  if (cells.length > 0) assert.equal(read[0], root, `${at}: a map with cells read its root first`);
  const fromRoot = read[0] === root ? 1 : 0;
  const queued = cells.filter((c) => c.expanded).map((c) => c.id);
  assert.deepEqual(read.slice(fromRoot), queued.slice(0, read.length - fromRoot), `${at}: it read the cells it queued, in order`);
  const held = new Set(rows);
  assert.ok(cells.every((c) => held.has(c.id)), `${at}: every cell is a row`);
  return { read, rows, cells };
}

function cellsText(cells: readonly Cell[]): string {
  const d = new Digest();
  for (const c of cells) {
    d.u32(c.id);
    d.u32(c.depth);
    d.byte(c.expanded ? 1 : 0);
    d.f64(c.x);
    d.f64(c.y);
    d.f64(c.w);
    d.f64(c.h);
  }
  return `${cells.length}\t${d.hex()}`;
}

/* -------------------------------- the grid -------------------------------- */

/** Budgets for the prunes: the design's 1, 50 and 250,000, and the neighbours where a bound is off by one. */
const PRUNE_BUDGETS = [1, 2, 5, 50, 51, 250_000];
/** The treemap's grid, from each tree's root and one folder inside it: depths 1–6, the cut-offs, small and large caps. */
const TREEMAP_MAX_DEPTHS = [1, 2, 3, 4, 5, 6];
const TREEMAP_MIN_SIZES = [0, 1, 4096, 10240];
const TREEMAP_MAX_NODES = [1, 7, 50, 20_000];
/** Roots the route refuses or no scan makes: each laid out at two settings, so their rules are pinned. */
const ODD_ROOT_PARAMS: readonly TreemapParams[] = [
  { maxDepth: 3, minSize: 0, maxNodes: 20_000 },
  { maxDepth: 6, minSize: 1, maxNodes: 50 },
];
/**
 * The big tree's settings: from the root, the SSE frame's 250,000 and the
 * `/subtree` route's default 20,000 (`SUBTREE_MAX_NODES`), and the UI's own
 * treemap request (maxDepth 4, minSize 4096, then 1 when that draws nothing;
 * the route's 20,000 cells), with more depths; from a folder inside it, the
 * drill-in's two.
 */
const BIG_PRUNES = [1, 50, 20_000, 250_000];
const BIG_FOLDER_PRUNES = [20_000, 250_000];
const BIG_TREEMAPS: readonly TreemapParams[] = [
  { maxDepth: 4, minSize: 4096, maxNodes: 20_000 },
  { maxDepth: 4, minSize: 1, maxNodes: 20_000 },
  { maxDepth: 2, minSize: 0, maxNodes: 20_000 },
  { maxDepth: 3, minSize: 10240, maxNodes: 20_000 },
  { maxDepth: 6, minSize: 0, maxNodes: 20_000 },
  { maxDepth: 8, minSize: 1, maxNodes: 20_000 },
  { maxDepth: 4, minSize: 4096, maxNodes: 50 },
];
const BIG_FOLDER_TREEMAPS: readonly TreemapParams[] = [{ maxDepth: 4, minSize: 4096, maxNodes: 20_000 }];
/** A cap no tree here reaches: what a treemap would emit were it not capped. */
const UNCAPPED = Number.MAX_SAFE_INTEGER;

/** The first row from `from` on that `test` accepts, if any. */
function firstRow(tree: Tree, from: number, test: (id: number) => boolean): number | undefined {
  for (let id = from; id < tree.n; id++) if (test(id)) return id;
  return undefined;
}

/**
 * The rows each tree is selected from beside its root: the folder whose
 * subtree holds nearest a quarter of the tree (the lowest id on a tie), and
 * the first row of each kind the rules treat apart.
 */
function rootsOf(tree: Tree): { folder?: number; others: number[] } {
  const c = tree.columns;
  const bit = (id: number, f: Flag): boolean => (c.flags[id] & f) !== 0;
  const below = new Uint32Array(tree.n).fill(1);
  for (let id = tree.n - 1; id >= 1; id--) below[c.parent[id]] += below[id];
  let folder: number | undefined;
  for (let id = 1; id < tree.n; id++) {
    if (!(bit(id, Flag.Dir) && bit(id, Flag.HasChildArray) && c.childCnt[id] > 0)) continue;
    if (folder === undefined || Math.abs(below[id] - tree.n / 4) < Math.abs(below[folder] - tree.n / 4)) folder = id;
  }
  const file = firstRow(tree, 1, (id) => !bit(id, Flag.Dir) && c.container[id] === 0 && c.childCnt[id] === 0);
  const opened = firstRow(tree, 1, (id) => c.container[id] !== 0 && bit(id, Flag.HasChildArray) && c.childCnt[id] > 0);
  const oddFolder = firstRow(tree, 1, (id) => bit(id, Flag.Dir) && !bit(id, Flag.HasChildArray) && c.childCnt[id] > 0);
  const oddBox = firstRow(tree, 1, (id) => c.container[id] !== 0 && !bit(id, Flag.HasChildArray) && c.childCnt[id] > 0);
  const oddFile = firstRow(tree, 1, (id) => !bit(id, Flag.Dir) && c.container[id] === 0 && c.childCnt[id] > 0);
  const others = [file, opened, oddFolder, oddBox, oddFile].filter((id): id is number => id !== undefined);
  return { folder, others };
}

function treeLine(tree: Tree, s: Shape): string {
  return [
    'tree', s.name, s.seed, s.nodes, s.dirPct, s.chainPct, s.widePct, s.wideMin, s.wideSpan, s.smallMax,
    s.zeroPct, s.palettePct, s.paletteLen, s.containerPct, s.openPct, s.oddPct, tree.n, treeDigest(tree),
  ].join('\t');
}

function pruneLine(tree: Tree, root: number, maxNodes: number, facts: Facts): string {
  const a = pruneAnswer(tree, root, maxNodes);
  facts.notePrune(tree, maxNodes, a);
  return `prune\t${root}\t${maxNodes}\t${listText(a.expanded)}\t${listText(a.rows)}`;
}

/** A treemap case's line; `uncapped` is how many cells the same map has with no cap. */
function treemapLine(tree: Tree, root: number, p: TreemapParams, uncapped: number, facts: Facts): string {
  const a = treemapAnswer(tree, root, p);
  facts.noteTreemap(tree, p, a, uncapped);
  return `treemap\t${root}\t${p.maxDepth}\t${p.minSize}\t${p.maxNodes}\t${listText(a.read)}\t${listText(a.rows)}\t${cellsText(a.cells)}`;
}

/** How many cells the map from `root` at `p`'s depth and cut-off has with no cap. */
function uncappedCells(tree: Tree, root: number, p: Omit<TreemapParams, 'maxNodes'>): number {
  return treemapAnswer(tree, root, { ...p, maxNodes: UNCAPPED }).cells.length;
}

/* ------------------------------ what it holds ------------------------------ */

/** The treemap's own 0.2: a rectangle this thin or thinner either way is not expanded. */
const THIN = 0.2;

/** One more case at `key`. */
function bump(counts: Map<number, number>, key: number): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * What the oracle's trees and cases hold, counted as the file is written, so
 * `tests/selectOracle.test.ts` can check the claims above instead of trusting
 * them: the ties and odd rows are there, and each bound the ports carry
 * decides cases at each of its settings.
 */
class Facts {
  /** Listings with two children of one size above zero. */
  listingTies = 0;
  /** Folders as large as one of their children (above zero): a tie across levels. */
  levelTies = 0;
  /** Folders with children whose total is zero: expandable, yet never laid out. */
  zeroFolders = 0;
  /** The longest run of folders each the only child of the one before. */
  longestChain = 0;
  /** The most children one row has. */
  widest = 0;
  /** Listings with files and folders both. */
  mixedListings = 0;
  openedContainers = 0;
  oddFolders = 0;
  oddContainers = 0;
  oddFiles = 0;
  /** Rows in the biggest tree. */
  biggestTree = 0;
  /** Prunes whose last folder took them past `maxNodes`, by `maxNodes`. */
  readonly overshoots = new Map<number, number>();
  /** Prunes that stopped with folders left waiting, by `maxNodes`. */
  readonly cutShort = new Map<number, number>();
  /** Prunes that stopped with folders waiting and exactly `maxNodes` rows: the `<` bound's edge, by `maxNodes`. */
  readonly exactFits = new Map<number, number>();
  /** Prunes that popped two folders of one size in a row, the second waiting before the first was popped. */
  heapTies = 0;
  /** Treemaps the cap stopped (with no cap they emit more), by `maxNodes`. */
  readonly capped = new Map<number, number>();
  /** Treemaps with a cell that drills in and has children, not expanded only because of `maxDepth`, by `maxDepth`. */
  readonly depthCuts = new Map<number, number>();
  /** Treemaps that kept a child of exactly `minSize` bytes, by `minSize`. */
  readonly minSizeTies = new Map<number, number>();
  /** Treemaps that left out a child the filter kept, before reaching `maxNodes`: a rectangle with no width or height. */
  skippedRects = 0;
  /** Treemaps with a cell that drills in and has children, above `maxDepth`, not expanded only because it is `THIN`. */
  thinRects = 0;

  noteTree(tree: Tree): void {
    const c = tree.columns;
    this.biggestTree = Math.max(this.biggestTree, tree.n);
    for (let id = 0; id < tree.n; id++) {
      const start = c.childStart[id];
      const end = start + c.childCnt[id];
      this.widest = Math.max(this.widest, c.childCnt[id]);
      const isDir = (c.flags[id] & Flag.Dir) !== 0;
      const hasArray = (c.flags[id] & Flag.HasChildArray) !== 0;
      if (isDir && c.size[id] === 0 && c.childCnt[id] > 0) this.zeroFolders++;
      if (isDir && !hasArray && c.childCnt[id] > 0) this.oddFolders++;
      if (!isDir && c.container[id] !== 0 && c.childCnt[id] > 0) {
        if (hasArray) this.openedContainers++;
        else this.oddContainers++;
      }
      if (!isDir && c.container[id] === 0 && c.childCnt[id] > 0) this.oddFiles++;
      const sizes = new Set<number>();
      let tied = false;
      let dirs = 0;
      for (let k = start; k < end; k++) {
        if (c.size[k] > 0 && sizes.has(c.size[k])) tied = true;
        sizes.add(c.size[k]);
        if ((c.flags[k] & Flag.Dir) !== 0) dirs++;
      }
      if (tied) this.listingTies++;
      if (dirs > 0 && dirs < end - start) this.mixedListings++;
      if (isDir && c.size[id] > 0 && sizes.has(c.size[id])) this.levelTies++;
      // A chain: count the folders below this one that are each an only child, a folder.
      let length = 0;
      for (let at = id; c.childCnt[at] === 1 && (c.flags[c.childStart[at]] & Flag.Dir) !== 0; at = c.childStart[at]) length++;
      this.longestChain = Math.max(this.longestChain, length);
    }
  }

  notePrune(tree: Tree, maxNodes: number, a: PruneAnswer): void {
    const c = tree.columns;
    const expanded = new Set(a.expanded);
    const waiting = a.rows.some((id) => isExpandable(tree, id) && !expanded.has(id));
    if (a.rows.length > maxNodes && a.expanded.length > 0) bump(this.overshoots, maxNodes);
    if (waiting) bump(this.cutShort, maxNodes);
    if (waiting && a.rows.length === maxNodes) bump(this.exactFits, maxNodes);
    for (let i = 1; i < a.expanded.length; i++) {
      const [before, after] = [a.expanded[i - 1], a.expanded[i]];
      if (c.size[after] === c.size[before] && c.parent[after] !== before) {
        this.heapTies++;
        break;
      }
    }
  }

  noteTreemap(tree: Tree, p: TreemapParams, a: TreemapAnswer, uncapped: number): void {
    const c = tree.columns;
    const drillsIn = (cell: Cell): boolean => isDirOrBox(tree, cell.id) && c.childCnt[cell.id] > 0;
    if (a.cells.length === p.maxNodes && uncapped > p.maxNodes) bump(this.capped, p.maxNodes);
    if (a.cells.some((cell) => !cell.expanded && drillsIn(cell) && cell.depth === p.maxDepth && cell.w > THIN && cell.h > THIN)) {
      bump(this.depthCuts, p.maxDepth);
    }
    if (a.rows.some((id, i) => i > 0 && c.size[id] === p.minSize)) bump(this.minSizeTies, p.minSize);
    if (a.cells.length < p.maxNodes && a.cells.length < a.rows.length - 1) this.skippedRects++;
    if (a.cells.some((cell) => !cell.expanded && drillsIn(cell) && cell.depth < p.maxDepth && (cell.w <= THIN || cell.h <= THIN))) {
      this.thinRects++;
    }
  }
}

/** `isExpandableId`, read off the columns. */
function isExpandable(tree: Tree, id: number): boolean {
  const c = tree.columns;
  return isDirOrBox(tree, id) && (c.flags[id] & Flag.HasChildArray) !== 0 && c.childCnt[id] > 0;
}

/** A folder or a container (the generator writes only the kinds 1–7). */
function isDirOrBox(tree: Tree, id: number): boolean {
  return (tree.columns.flags[id] & Flag.Dir) !== 0 || tree.columns.container[id] !== 0;
}

/* ------------------------------- the file ------------------------------- */

function smallTreeLines(s: Shape, facts: Facts): string[] {
  const tree = treeOf(s);
  facts.noteTree(tree);
  const lines = [treeLine(tree, s)];
  const { folder, others } = rootsOf(tree);
  const roots = folder === undefined ? [0] : [0, folder];
  for (const root of [...roots, ...others]) {
    for (const maxNodes of PRUNE_BUDGETS) lines.push(pruneLine(tree, root, maxNodes, facts));
  }
  for (const root of roots) {
    for (const maxDepth of TREEMAP_MAX_DEPTHS) {
      for (const minSize of TREEMAP_MIN_SIZES) {
        const uncapped = uncappedCells(tree, root, { maxDepth, minSize });
        for (const maxNodes of TREEMAP_MAX_NODES) {
          lines.push(treemapLine(tree, root, { maxDepth, minSize, maxNodes }, uncapped, facts));
        }
      }
    }
  }
  for (const root of others) {
    for (const p of ODD_ROOT_PARAMS) lines.push(treemapLine(tree, root, p, uncappedCells(tree, root, p), facts));
  }
  return lines;
}

function bigTreeLines(facts: Facts): string[] {
  const tree = treeOf(BIG);
  facts.noteTree(tree);
  const lines = [treeLine(tree, BIG)];
  const { folder } = rootsOf(tree);
  for (const maxNodes of BIG_PRUNES) lines.push(pruneLine(tree, 0, maxNodes, facts));
  if (folder !== undefined) {
    for (const maxNodes of BIG_FOLDER_PRUNES) lines.push(pruneLine(tree, folder, maxNodes, facts));
  }
  for (const p of BIG_TREEMAPS) lines.push(treemapLine(tree, 0, p, uncappedCells(tree, 0, p), facts));
  if (folder !== undefined) {
    for (const p of BIG_FOLDER_TREEMAPS) lines.push(treemapLine(tree, folder, p, uncappedCells(tree, folder, p), facts));
  }
  return lines;
}

/** The file's text, and what its trees and cases were found to hold. */
export function oracleText(): { text: string; facts: Facts } {
  const facts = new Facts();
  const lines: string[] = [];
  for (const s of SHAPES) lines.push(...smallTreeLines(s, facts));
  lines.push(...bigTreeLines(facts));
  return { text: `${lines.join('\n')}\n`, facts };
}

if (require.main === module) {
  // Nothing here saves app data, but run as a script the app's data folder is
  // pointed away from the owner's all the same, as every test file's is.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-selectOracle-data-'));
  process.env.TREEMAP_DATA_DIR = dataDir;
  try {
    const { text, facts } = oracleText();
    fs.mkdirSync(path.dirname(ORACLE_PATH), { recursive: true });
    fs.writeFileSync(ORACLE_PATH, text);
    process.stdout.write(`wrote ${ORACLE_PATH} (${text.length} bytes, ${text.split('\n').length - 1} lines)\n`);
    process.stdout.write(`${JSON.stringify(facts, (_k, v: unknown) => (v instanceof Map ? Object.fromEntries(v) : v), 2)}\n`);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
