import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-queryWalkWork-data-');
process.env.TREEMAP_NO_GDU = '1';

import os from 'node:os';
import { parse } from '../src/services/query/parse';
import { evaluateMaybe, type EvalNode } from '../src/services/query/evaluate';
import { executeAgainstScan, childlessUnproven, type QueryHit, type QueryOutcome, type SortKey } from '../src/services/query/execute';
import { createScanRecord } from '../src/services/diskScanner';
import { buildStoreFromTree, Flag, type ScanStore } from '../src/services/scanStore';
import type { FileNode, ScanResult } from '../src/models/types';
import type { Ast } from '../src/services/query/types';

/**
 * The query walk's work, counted (design pass G07).
 *
 * The Highlight box asks POST /api/query on every pause in typing, and on a
 * 304k-file scan the walk took 128-180 ms on a quiet machine (0.21 s in the
 * pass's own measurement). It decoded every node's name twice — once to
 * build its path when its parent pushed it, once more as the node was judged
 * — and built a path string for every node, though a path is read only by a
 * path term, a fact lookup and the hits on the page. Names and paths are now
 * read when something reads them. And the walk ran in one turn of the event
 * loop, so a query the person had already typed past could not be stopped:
 * now it runs in slices (Track U's U-D9, the same guard as the dashboard's
 * lists), an abort lands between slices, and a tree that changed during a
 * slice's turn is walked again from the start.
 *
 * Counted, never timed. The answers are held to an oracle that shares none
 * of the walk's code: every node read by id (store.path, store.name), judged
 * by the same evaluator, sorted by the documented order.
 */

const T = 1_800_000_000_000;
const YEAR = 365 * 86_400_000;

/** A seeded tree: `dirs` folders a few levels deep, files of many sizes, names and ages, some empty folders. */
function seededTree(root: string, seed: number, dirs: number): FileNode {
  let s = seed >>> 0;
  const rnd = (): number => { s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0; return s / 2 ** 32; };
  const EXT = ['zip', 'mp4', 'txt', 'JPG', 'tar.gz', '', 'é.png'];
  let made = 0;
  const dir = (path: string, name: string, depth: number): FileNode => {
    const children: FileNode[] = [];
    const files = Math.floor(rnd() * 9);
    for (let i = 0; i < files; i++) {
      const ext = EXT[Math.floor(rnd() * EXT.length)];
      const nm = `${rnd() < 0.2 ? 'Report' : 'item'}-${depth}-${i}${rnd() < 0.1 ? ' (copy)' : ''}${ext ? '.' + ext : ''}`;
      children.push({ name: nm, path: `${path}/${nm}`, type: 'file', extension: ext.split('.').pop() ?? '', size: Math.floor(10 ** (1 + rnd() * 9)), modifiedAt: T - Math.floor(rnd() * 4) * YEAR - 86_400_000, isHidden: false });
    }
    while (made < dirs && depth < 6 && (depth === 0 || rnd() < 0.8)) { // the root keeps going until the tree has its folders
      made++;
      const dn = `${rnd() < 0.15 ? 'node_modules' : 'Folder'}${made}`;
      children.push(dir(`${path}/${dn}`, dn, depth + 1));
    }
    return { name, path, type: 'dir', size: children.reduce((a, c) => a + c.size, 0), modifiedAt: T - YEAR, isHidden: false, children };
  };
  return dir(root, root.split('/').pop() as string, 0);
}

function scanOf(tree: FileNode): ScanResult {
  const scan = createScanRecord(tree.path);
  scan.store = buildStoreFromTree(tree);
  scan.status = 'complete';
  scan.engine = 'walker';
  return scan;
}

function ast(q: string): Ast {
  const r = parse(q);
  assert.ok(r.ok, `"${q}" parses`);
  return (r as { ok: true; ast: Ast }).ast;
}

const run = (scan: ScanResult, q: string, opts: Partial<{ limit: number; offset: number; sort: SortKey; signal: AbortSignal; slices: unknown }> = {}): Promise<QueryOutcome> =>
  executeAgainstScan(scan.scanId, ast(q), { limit: 1000, offset: 0, sort: 'size', signal: new AbortController().signal, ...opts } as never) as Promise<QueryOutcome>;

/** Every node of the store, read by id — store.path and store.name, never the walk's own reads. */
function everyNode(store: ScanStore, childlessKnown: boolean): EvalNode[] {
  const out: EvalNode[] = [];
  const visit = (id: number, depth: number): void => {
    const isDir = store.isDir(id);
    let childCount: number | undefined;
    if (isDir && store.hasChildArray(id)) {
      const n = store.childCount(id);
      childCount = n > 0 ? n : childlessKnown && !store.flag(id, Flag.Unlisted) ? 0 : undefined;
    }
    out.push({ name: store.name(id), path: store.path(id), size: store.size(id), isDir, mtimeMs: store.modifiedAt(id), depth, childCount });
    if (isDir) store.forEachChild(id, (c) => visit(c, depth + 1));
  };
  visit(store.rootId, 0);
  return out;
}

const ORDER: Record<SortKey, (a: QueryHit, b: QueryHit) => number> = {
  size: (a, b) => b.size - a.size || a.path.localeCompare(b.path),
  name: (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  modified: (a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path),
  path: (a, b) => a.path.localeCompare(b.path),
};

test('G07: the walk answers exactly what every node, judged one by one, says — totals, pages and undecided', async () => {
  const scan = scanOf(seededTree('/q/walk', 0x9e37, 400));
  const store = scan.store as ScanStore;
  const nodes = everyNode(store, childlessUnproven(scan) === null);
  assert.ok(nodes.length > 1500, `a tree of ${nodes.length} nodes`);
  const queries = [
    'size>1mb', 'size<100', 'ext:zip,mp4', 'ext:jpg', 'name:report', 'path:folder1', 'in:node_modules', '-in:node_modules size>10kb',
    'type:dir', 'type:dir size>100mb', 'depth>3', 'depth<2 or ext:txt', '(ext:png or ext:gz) -name:copy', 'empty:yes', 'empty:no type:dir',
    'modified>2y', 'modified<1y', '*.zip', 'report', 'size>1gb or (depth=1 and type:dir)',
  ];
  const home = os.homedir();
  for (const q of queries) {
    const now = Date.now();
    const verdicts = nodes.map((node) => evaluateMaybe(ast(q), { node, facts: {}, now }, home));
    const matched = nodes.filter((_, i) => verdicts[i] === true);
    const undecided = verdicts.filter((v) => v === 'maybe').length;
    for (const sort of ['size', 'name', 'modified', 'path'] as SortKey[]) {
      for (const [limit, offset] of [[1000, 0], [7, 0], [5, 11]]) {
        const out = await run(scan, q, { limit, offset, sort });
        const expected = matched
          .map((n) => ({ path: n.path, name: n.name, size: n.size, isDir: n.isDir, mtimeMs: n.mtimeMs }))
          .sort(ORDER[sort]).slice(offset, offset + limit);
        assert.equal(out.total, matched.length, `${q}: total`);
        assert.deepEqual(out.hits, expected, `${q} by ${sort}, ${limit} from ${offset}: the page`);
        assert.equal(out.examined, nodes.length, `${q}: every node examined`);
        assert.equal(out.truncated, offset + expected.length < matched.length, `${q}: truncated says whether more matched`);
        const said = out.degraded.find((d) => d.provider === 'undecided');
        assert.equal(Boolean(said), undecided > 0, `${q}: undecided is said exactly when a node could not be decided`);
        if (said) assert.match(said.reason, new RegExp(`^${undecided.toLocaleString('en-US')} item`), `${q}: and counts them`);
      }
    }
  }
});

/** The store, with every name and path read counted. */
function counting(scan: ScanResult): { reads: { name: number; childPath: number; path: number } } {
  const store = scan.store as ScanStore;
  const reads = { name: 0, childPath: 0, path: 0 };
  scan.store = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === 'name' || prop === 'childPath' || prop === 'path') {
        return (...args: unknown[]) => { reads[prop]++; return (value as (...a: unknown[]) => unknown).apply(receiver, args); };
      }
      return (value as (...a: unknown[]) => unknown).bind(receiver);
    },
  }) as ScanStore;
  return { reads };
}

test('G07: a size query reads the names and paths of its hits, not of every node it walks past', async () => {
  const scan = scanOf(seededTree('/q/work', 0x51ce, 300));
  const store = scan.store as ScanStore;
  const nodes = everyNode(store, true);
  const dirs = nodes.filter((n) => n.isDir).length;
  const { reads } = counting(scan);
  const out = await run(scan, 'size>500mb', { limit: 1000 });
  assert.ok(out.total > 0 && out.total < 1000, `a selective query (${out.total} of ${nodes.length})`);
  assert.equal(out.examined, nodes.length);
  // Each hit's name for the page, and again inside the store as its path is
  // built; each path built once from its folder's: at most every folder on a
  // hit's way down, and the hit itself. Before, every node twice.
  assert.ok(reads.name <= 2 * out.total + dirs, `names read: ${reads.name} for ${out.total} hits among ${nodes.length} nodes`);
  assert.ok(reads.childPath <= out.total + dirs, `paths built: ${reads.childPath} for ${out.total} hits in ${dirs} folders`);
  assert.equal(reads.path, 0, 'and no path rebuilt from the root');
});

test('G07: a name query decodes each name once, not once to build a path and again to judge it', async () => {
  const scan = scanOf(seededTree('/q/names', 0xbeef, 300));
  const nodes = everyNode(scan.store as ScanStore, true);
  const dirs = nodes.filter((n) => n.isDir).length;
  const { reads } = counting(scan);
  const out = await run(scan, 'name:report', { limit: 5 });
  assert.ok(out.total > 5, `more matches (${out.total}) than the page holds`);
  // Every node's name is judged once; a path is built only for a folder on a
  // kept hit's way down, or a hit itself, and building one reads its name.
  assert.ok(reads.name <= nodes.length + dirs + out.total, `names read: ${reads.name} for ${nodes.length} nodes (twice each would be ${2 * nodes.length})`);
  assert.ok(reads.childPath < nodes.length / 2, `paths built: ${reads.childPath} for ${nodes.length} nodes`);
});

test('G07: an abort that lands between slices stops the walk there, and the answer says it was stopped', async () => {
  const scan = scanOf(seededTree('/q/abort', 0xab, 300));
  const total = everyNode(scan.store as ScanStore, true).length;
  assert.ok(total > 1000, `a tree of ${total} nodes, many slices of 100`);
  const controller = new AbortController();
  let turns = 0;
  const out = await run(scan, 'size>0', {
    signal: controller.signal,
    // The person typed on: the request closes while the walk has handed the loop a turn.
    slices: { sliceNodes: 100, yieldTurn: async () => { turns++; controller.abort(); await new Promise((r) => setImmediate(r)); } },
  });
  assert.ok(turns >= 1, 'the walk handed the loop a turn after its first slice');
  assert.equal(out.examined, 100, `it stopped at the slice the abort landed after (${out.examined} of ${total} examined)`);
  assert.ok(out.degraded.some((d) => d.provider === 'cancelled'), 'and says the results are incomplete');
  assert.equal(out.truncated, true, 'a stopped walk is never a confident total');
});

test('G07: a tree that changes during a slice\'s turn is walked again from the start — never half the old tree and half the new', async () => {
  const scan = scanOf(seededTree('/q/changed', 0xc0de, 300));
  const store = scan.store as ScanStore;
  const before = await run(scan, 'size>0 type:file');
  // The biggest file: on page one either way, so leaving it in would show.
  const victim = before.hits[0].path;
  let victimId = -1;
  const find = (id: number): void => { if (store.path(id) === victim) victimId = id; else if (store.isDir(id)) store.forEachChild(id, find); };
  find(store.rootId);
  assert.notEqual(victimId, -1);
  const attempts: number[] = [];
  let changed = false;
  const out = await run(scan, 'size>0 type:file', {
    slices: {
      sliceNodes: 200,
      onAttempt: (n: number) => attempts.push(n),
      yieldTurn: async () => {
        if (!changed) { changed = true; store.removeNode(victimId); } // a delete lands mid-walk
        await new Promise((r) => setImmediate(r));
      },
    },
  });
  assert.deepEqual(attempts, [1, 2], 'the walk that saw the change started again');
  const after = await run(scan, 'size>0 type:file');
  assert.equal(out.total, before.total - 1, 'the answer is the changed tree\'s');
  assert.deepEqual(out, after, 'exactly the answer a walk of the changed tree gives');
  assert.ok(!out.hits.some((h) => h.path === victim), 'the deleted file is not among the hits');
});
