import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-selectOracle-data-');

import { Flag } from '../src/services/scanStore';
import {
  ORACLE_PATH,
  oracleText,
  pruneAnswer,
  treeFromColumns,
  treemapAnswer,
  type Cell,
  type PruneAnswer,
  type Tree,
  type TreeColumns,
  type TreemapAnswer,
  type TreemapParams,
} from './fixtures/selectOracle';

/**
 * Phase 4 T15a: tm-store's selection ports (`select_prune`, `select_treemap`)
 * are held to the JavaScript they port through a file
 * (`native/treemap-core/crates/tm-store/tests/fixtures/select-oracle.tsv`)
 * that `tests/fixtures/selectOracle.ts` writes from `pruneStore`,
 * `prunedExpansion` and `buildTreemapFromStore` themselves. The file is only
 * evidence while it is what the JavaScript answers today and while its trees
 * hold what its header claims; and the small trees tm-store's own tests
 * (`tests/select.rs`) work by hand are only evidence while their answers are
 * the JavaScript's.
 */

let today: ReturnType<typeof oracleText> | undefined;

/** The oracle as the JavaScript writes it today, built once, by the first test that asks. */
function oracleToday(): ReturnType<typeof oracleText> {
  today ??= oracleText();
  return today;
}

test('the committed selection oracle is what the JavaScript answers today', () => {
  const { text } = oracleToday();
  assert.ok(text.length < 1_000_000, `the oracle stays under 1 MB: ${text.length} bytes`);
  const committed = fs.readFileSync(ORACLE_PATH, 'utf8');
  assert.ok(
    committed === text,
    `the oracle is stale: regenerate it with \`npx tsx tests/fixtures/selectOracle.ts\` and commit it (${committed.length} bytes committed, ${text.length} today)`,
  );
});

test("the oracle's trees hold the ties and odd rows it claims, and each bound decides cases at each setting", () => {
  const f = oracleToday().facts;
  const at = (m: Map<number, number>, key: number): number => m.get(key) ?? 0;
  const everyKey = (label: string, m: Map<number, number>, keys: number[]): Array<readonly [string, boolean]> =>
    keys.map((key) => [`${label} at ${key}: ${at(m, key)}`, at(m, key) > 0] as const);
  // Every claim is checked and every broken one named, so a fixture that lost several says which.
  const claims: ReadonlyArray<readonly [string, boolean]> = [
    [`listings with two children of one size: ${f.listingTies}`, f.listingTies > 100],
    [`folders as large as one of their children: ${f.levelTies}`, f.levelTies > 100],
    [`folders with children and zero bytes: ${f.zeroFolders}`, f.zeroFolders > 100],
    [`the longest single-child chain: ${f.longestChain}`, f.longestChain >= 5],
    [`the widest listing: ${f.widest}`, f.widest >= 500],
    [`listings of files and folders both: ${f.mixedListings}`, f.mixedListings > 100],
    [
      `opened containers ${f.openedContainers}, folders without a child array ${f.oddFolders}, containers with children but no array ${f.oddContainers}, plain files with children ${f.oddFiles}`,
      f.openedContainers > 0 && f.oddFolders > 0 && f.oddContainers > 0 && f.oddFiles > 0,
    ],
    [`the big tree's rows: ${f.biggestTree}`, f.biggestTree > 250_000],
    ...everyKey('prunes whose last folder overshoots', f.overshoots, [50, 20_000, 250_000]),
    ...everyKey('prunes that stop with folders waiting', f.cutShort, [1, 50, 20_000, 250_000]),
    ...everyKey('prunes that stop at exactly maxNodes with folders waiting', f.exactFits, [2, 5, 50, 51]),
    [`prunes that pop two folders of one size, the second already waiting: ${f.heapTies}`, f.heapTies > 10],
    ...everyKey('treemaps the cap stops', f.capped, [1, 7, 50, 20_000]),
    ...everyKey('treemaps cut by maxDepth', f.depthCuts, [1, 2, 3, 4, 5, 6]),
    ...everyKey('treemaps that keep a child of exactly minSize', f.minSizeTies, [1, 4096, 10240]),
    [`treemaps that leave out a rectangle with no width or height: ${f.skippedRects}`, f.skippedRects > 10],
    [`treemaps that do not expand a rectangle too thin: ${f.thinRects}`, f.thinRects > 10],
  ];
  const broken = claims.filter(([, holds]) => !holds).map(([what]) => what);
  assert.deepEqual(broken, [], `claims the oracle does not hold:\n${broken.join('\n')}`);
});

/* ------------------- the hand-made trees of tests/select.rs ------------------- */

interface Row {
  size: number;
  flags: number;
  container: number;
  children: Row[];
}

const file = (size: number): Row => ({ size, flags: 0, container: 0, children: [] });
const folder = (children: Row[]): Row => ({ size: 0, flags: Flag.Dir | Flag.HasChildArray, container: 0, children });
const folderWithoutChildArray = (children: Row[]): Row => ({ size: 0, flags: Flag.Dir, container: 0, children });
const openedContainer = (kind: number, size: number, children: Row[]): Row => ({
  size,
  flags: Flag.HasChildArray,
  container: kind,
  children,
});

/** `root`'s tree numbered breadth-first, as `hand` in tests/select.rs numbers it. */
function hand(name: string, root: Row): Tree {
  const rows: Row[] = [root];
  const parent = [-1];
  const childStart: number[] = [];
  const childCnt: number[] = [];
  for (let id = 0; id < rows.length; id++) {
    childStart.push(rows.length);
    for (const child of rows[id].children) {
      rows.push(child);
      parent.push(id);
    }
    childCnt.push(rows[id].children.length);
  }
  const columns: TreeColumns = {
    parent: Int32Array.from(parent),
    size: Float64Array.from(rows.map((r) => r.size)),
    flags: Uint16Array.from(rows.map((r) => r.flags)),
    container: Uint8Array.from(rows.map((r) => r.container)),
    childStart: Uint32Array.from(childStart),
    childCnt: Uint32Array.from(childCnt),
  };
  return treeFromColumns(name, columns);
}

const cell = (id: number, depth: number, expanded: boolean, [x, y, w, h]: number[]): Cell => ({ id, depth, expanded, x, y, w, h });
const times = (n: number, row: () => Row): Row[] => Array.from({ length: n }, row);

/** Asserts `tree`'s prune from `root` to `maxNodes`, naming the case when it differs. */
function prunes(tree: Tree, root: number, maxNodes: number, want: PruneAnswer): void {
  assert.deepEqual(pruneAnswer(tree, root, maxNodes), want, `${tree.name}: prune from ${root} to ${maxNodes}`);
}

/** Asserts `tree`'s treemap from `root` at `p`, naming the case when it differs. */
function maps(tree: Tree, root: number, p: TreemapParams, want: TreemapAnswer): void {
  assert.deepEqual(treemapAnswer(tree, root, p), want, `${tree.name}: treemap from ${root} at ${JSON.stringify(p)}`);
}

test('the hand-made trees of tests/select.rs answer as the JavaScript does', () => {
  const four = hand('four equal folders', folder(times(4, () => folder([file(50), file(50)]))));
  prunes(four, 0, 9, { expanded: [0, 1, 4], rows: [0, 1, 2, 3, 4, 5, 6, 11, 12] });
  prunes(four, 0, 1_000, { expanded: [0, 1, 4, 3, 2], rows: [0, 1, 2, 3, 4, 5, 6, 11, 12, 9, 10, 7, 8] });
  const seven = hand('seven equal folders', folder(times(7, () => folder([file(10)]))));
  assert.deepEqual(pruneAnswer(seven, 0, 1_000).expanded, [0, 1, 7, 6, 5, 4, 3, 2], seven.name);

  const last = hand('a wide last folder', folder([folder(times(10, () => file(100))), file(7)]));
  prunes(last, 0, 5, { expanded: [0, 1], rows: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] });

  const bound = hand('the budget', folder([folder([file(1)]), folder([file(1)]), file(1), file(1)]));
  prunes(bound, 0, 0, { expanded: [], rows: [0] });
  prunes(bound, 0, 1, { expanded: [], rows: [0] });
  prunes(bound, 0, 5, { expanded: [0], rows: [0, 1, 2, 3, 4] });
  prunes(bound, 0, 6, { expanded: [0, 1], rows: [0, 1, 2, 3, 4, 5] });

  const whole = [0, 0, 100, 100];
  const chain = hand('a chain', folder([folder([folder([file(100)])])]));
  const deep = (maxDepth: number): TreemapParams => ({ maxDepth, minSize: 0, maxNodes: 20_000 });
  maps(chain, 0, deep(1), { read: [0], rows: [0, 1], cells: [cell(1, 1, false, whole)] });
  maps(chain, 0, deep(2), { read: [0, 1], rows: [0, 1, 2], cells: [cell(1, 1, true, whole), cell(2, 2, false, whole)] });
  maps(chain, 0, deep(3), {
    read: [0, 1, 2],
    rows: [0, 1, 2, 3],
    cells: [cell(1, 1, true, whole), cell(2, 2, true, whole), cell(3, 3, false, whole)],
  });

  const cut = hand('the cut-off', folder([file(4096), file(4095), file(4097), file(0)]));
  const top = [0, 0, 66.6748046875, 50.00610277065788];
  const below = [0, 50.00610277065788, 66.6748046875, 49.99389722934212];
  maps(cut, 0, { maxDepth: 4, minSize: 4096, maxNodes: 20_000 }, {
    read: [0],
    rows: [0, 1, 3],
    cells: [cell(3, 1, false, top), cell(1, 1, false, below)],
  });
  maps(cut, 0, { maxDepth: 4, minSize: 0, maxNodes: 20_000 }, {
    read: [0],
    rows: [0, 1, 2, 3],
    cells: [cell(3, 1, false, top), cell(1, 1, false, below), cell(2, 1, false, [66.6748046875, 0, 33.3251953125, 100])],
  });

  const five = hand('five files', folder([5, 4, 3, 2, 1].map(file)));
  maps(five, 0, { maxDepth: 4, minSize: 0, maxNodes: 3 }, {
    read: [0],
    rows: [0, 1, 2, 3, 4, 5],
    cells: [
      cell(1, 1, false, [0, 0, 60, 55.55555555555555]),
      cell(2, 1, false, [0, 55.55555555555555, 60, 44.44444444444444]),
      cell(3, 1, false, [60, 0, 40, 50]),
    ],
  });
  const two = hand('two folders', folder([folder([file(10), file(10)]), folder([file(10), file(10)])]));
  const halves = [cell(1, 1, true, [0, 0, 100, 50]), cell(2, 1, true, [0, 50, 100, 50])];
  maps(two, 0, { maxDepth: 4, minSize: 0, maxNodes: 2 }, { read: [0], rows: [0, 1, 2], cells: halves });
  maps(two, 0, { maxDepth: 4, minSize: 0, maxNodes: 3 }, {
    read: [0, 1],
    rows: [0, 1, 2, 3, 4],
    cells: [...halves, cell(3, 2, false, [0, 0, 50, 50])],
  });

  const narrow = hand('a strip 0.2 wide', folder([folder([file(2)]), ...times(998, () => file(1))]));
  maps(narrow, 0, { maxDepth: 3, minSize: 2, maxNodes: 20_000 }, {
    read: [0],
    rows: [0, 1],
    cells: [cell(1, 1, false, [0, 0, 0.2, 100])],
  });
  const flat = hand('a strip 0.2 tall', folder([folder([folder([file(6)]), ...times(598, () => file(5)), file(4)]), file(1000)]));
  maps(flat, 0, { maxDepth: 3, minSize: 6, maxNodes: 20_000 }, {
    read: [0, 1],
    rows: [0, 1, 2, 3],
    cells: [cell(1, 1, true, [0, 0, 75, 100]), cell(2, 1, false, [75, 0, 25, 100]), cell(3, 2, false, [0, 0, 75, 0.2])],
  });

  const odd = hand('a folder without a child array', folder([folderWithoutChildArray([file(10), file(10)]), file(5)]));
  prunes(odd, 0, 100, { expanded: [0], rows: [0, 1, 2] });
  maps(odd, 0, { maxDepth: 3, minSize: 0, maxNodes: 20_000 }, {
    read: [0, 1],
    rows: [0, 1, 2, 3, 4],
    cells: [
      cell(1, 1, true, [0, 0, 80, 100]),
      cell(2, 1, false, [80, 0, 20, 100]),
      cell(3, 2, false, [0, 0, 80, 50]),
      cell(4, 2, false, [0, 50, 80, 50]),
    ],
  });

  const nan = hand('a size that is not a number', folder([folder([file(10), file(NaN)]), file(5), folder([file(3)])]));
  prunes(nan, 0, 100, { expanded: [0, 3, 1], rows: [0, 1, 2, 3, 6, 4, 5] });
  maps(nan, 0, { maxDepth: 3, minSize: 0, maxNodes: 20_000 }, { read: [0], rows: [0, 2, 3], cells: [] });
  maps(nan, 3, { maxDepth: 3, minSize: 0, maxNodes: 20_000 }, {
    read: [3],
    rows: [3, 6],
    cells: [cell(6, 1, false, [0, 0, 100, 100])],
  });

  // tests/select.rs lays out a malformed store at a one-cell cap; the JavaScript reads no
  // more of it than of this well-formed one, whose first cell is the same.
  const oneCell = hand('a one-cell cap', folder([file(10), folder([file(5)])]));
  maps(oneCell, 0, { maxDepth: 4, minSize: 0, maxNodes: 1 }, {
    read: [0],
    rows: [0, 1, 2],
    cells: [cell(1, 1, false, [0, 0, 66.66666666666666, 100])],
  });

  const kinds = hand(
    'container bytes 8 and 7',
    folder([openedContainer(8, 30, [file(10), file(10)]), openedContainer(7, 20, [file(5), file(5)]), file(5)]),
  );
  prunes(kinds, 0, 100, { expanded: [0, 2], rows: [0, 1, 2, 3, 6, 7] });
  maps(kinds, 0, { maxDepth: 3, minSize: 0, maxNodes: 20_000 }, {
    read: [0, 2],
    rows: [0, 1, 2, 3, 6, 7],
    cells: [
      cell(1, 1, false, [0, 0, 54.54545454545454, 100]),
      cell(2, 1, true, [54.54545454545454, 0, 45.45454545454547, 79.99999999999999]),
      cell(3, 1, false, [54.54545454545454, 79.99999999999999, 45.454545454545425, 20.000000000000014]),
      cell(6, 2, false, [54.54545454545454, 0, 22.727272727272734, 39.99999999999999]),
      cell(7, 2, false, [77.27272727272728, 0, 22.727272727272734, 39.99999999999999]),
    ],
  });
  maps(kinds, 1, { maxDepth: 3, minSize: 0, maxNodes: 20_000 }, { read: [], rows: [1], cells: [] });
});
