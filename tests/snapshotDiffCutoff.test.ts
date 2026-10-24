import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-snapshotDiffCutoff-data-');

import { createScanRecord } from '../src/services/diskScanner';
import { diffSnapshots, listSnapshots, saveSnapshot } from '../src/services/snapshots';
import type { FileNode, Snapshot } from '../src/models/types';

/**
 * Snapshot diffs — Trends' "Since previous scan" and Compare on two History records — never call an
 * item removed or new because it crossed the largest-100 line (hunt C46). A snapshot keeps only the
 * largest 100 top-level items, and the diff read a path missing from one list as gone (`sizeB: null`,
 * "removed", offered "Check snapshots") or new (its whole size as the delta): in ~/Downloads each new
 * download marked an existing file removed, and a folder that climbed into the 100 showed as "new
 * +<its whole size>". It also left out every empty item, so a folder that became empty read "removed".
 * Now a snapshot records whether its list was cut (`topEntriesCut`) and keeps empty items, and a path
 * missing from a list that may have left it out is not compared — counted in `notCompared` — while
 * one missing from a list that holds every item is removed or new, as before.
 */

const ROOT = path.join(path.sep, 'snap-root');

function scanWith(children: { name: string; size: number; dir?: boolean }[]) {
  const nodes: FileNode[] = children.map((c) => ({
    name: c.name, path: path.join(ROOT, c.name), size: c.size, type: c.dir ? 'dir' : 'file', modifiedAt: 1, isHidden: false, ...(c.dir ? { children: [] } : {}),
  }));
  const scan = createScanRecord(ROOT);
  scan.status = 'complete';
  scan.finishedAt = Date.now();
  scan.root = { name: 'snap-root', path: ROOT, size: nodes.reduce((s, n) => s + n.size, 0), type: 'dir', modifiedAt: 1, isHidden: false, children: nodes };
  return scan;
}

function snapOf(entries: [string, number][], extra: Partial<Snapshot> = {}): Snapshot {
  return {
    id: `s${Math.random()}`, rootPath: ROOT, takenAt: 1, totalSize: entries.reduce((s, [, n]) => s + n, 0), fileCount: entries.length, dirCount: 1,
    topEntries: entries.map(([name, size]) => ({ name, path: path.join(ROOT, name), size, type: 'file' as const })),
    ...extra,
  };
}

const files = (n: number, size: (i: number) => number): [string, number][] =>
  Array.from({ length: n }, (_, i) => [`file-${String(i).padStart(3, '0')}.bin`, size(i)]);

test('a snapshot says whether its list of top-level items was cut, and keeps the empty ones', async () => {
  const wide = await saveSnapshot(scanWith(files(101, (i) => 2000 - i).map(([name, size]) => ({ name, size }))));
  assert.equal(wide?.topEntries.length, 100);
  assert.equal(wide?.topEntriesCut, true, 'a folder of 101 items: the list was cut');
  const narrow = await saveSnapshot(scanWith([{ name: 'big.bin', size: 50 }, { name: 'Empty', size: 0, dir: true }, { name: 'zero.txt', size: 0 }]));
  assert.equal(narrow?.topEntriesCut, false);
  assert.deepEqual(narrow?.topEntries.map((e) => [e.name, e.size]), [['big.bin', 50], ['Empty', 0], ['zero.txt', 0]], 'the empty items are kept, after the rest');
  assert.equal((await listSnapshots(ROOT)).length, 2);
});

test('an item that fell below the largest 100, and one that climbed into it, are neither removed nor new', () => {
  // 101 files; a new 50 kB download arrives, and file-100 was never kept while file-099 drops out.
  const before = snapOf(files(100, (i) => 2000 - i), { topEntriesCut: true });
  const after = snapOf([['new-download.zip', 50_000], ...files(99, (i) => 2000 - i)], { topEntriesCut: true });
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.entries, [], 'no row for either: neither list can vouch for the other\'s item');
  assert.equal(diff.notCompared, 2, 'both are counted as not compared');
  assert.equal(diff.totalDelta, after.totalSize - before.totalSize, 'the total is still exact');
});

test('a list that holds every item still calls a missing one removed, and an emptied folder shrank to 0, not removed', () => {
  const before = snapOf([['gone.bin', 700], ['Mail', 900]], { topEntriesCut: false });
  const after = snapOf([['Mail', 0], ['fresh.bin', 300]], { topEntriesCut: false });
  const diff = diffSnapshots(before, after);
  const by = new Map(diff.entries.map((e) => [e.name, e]));
  assert.equal(by.get('gone.bin')?.sizeB, null, 'gone from a whole list: removed');
  assert.equal(by.get('fresh.bin')?.sizeA, null, 'new to a whole list: new');
  assert.equal(by.get('Mail')?.sizeB, 0, 'an emptied folder is there, at 0');
  assert.equal(by.get('Mail')?.delta, -900);
  assert.equal(diff.notCompared, undefined, 'nothing left uncompared');
});

test('a full list an earlier build saved, with no word on whether it was cut, is taken as one that may have been', () => {
  const before = snapOf(files(100, (i) => 2000 - i));
  const after = snapOf([['new-download.zip', 50_000], ...files(99, (i) => 2000 - i)]);
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.entries, []);
  assert.equal(diff.notCompared, 2);
});

/* ---------- the page's words (read as built: public/index.html) ---------- */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function decl(name: string): string {
  let start = INDEX.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is declared in the built page`);
  if (INDEX.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let i = INDEX.indexOf('{', INDEX.indexOf(')', start)); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`${name} never closes`);
}

test('Trends\' last-change list says how many items it could not compare', async () => {
  const host = { innerHTML: '' };
  const snaps = [snapOf([['a', 1]]), snapOf([['a', 2]])];
  const deps: Record<string, unknown> = {
    $: () => host, state: { view: 'trends', trends: { path: ROOT, snapshots: snaps } },
    api: async () => ({ totalDelta: 50_000, entries: [], notCompared: 2 }),
    coverageRules: () => null, coverageFor: () => null, formatDate: (t: number) => `d${t}`, cmpWhenPair: () => ['x', 'y'],
    formatBytes: (n: number) => `${n} B`, formatCount: (n: number) => String(n), escapeHtml: (s: unknown) => String(s), chipFor: () => '', coverageExplains: () => null,
    FxNum: { rollHtml: (el: { innerHTML: string }, html: string) => { el.innerHTML = html; } }, fxBarsIn: () => {},
  };
  const keys = Object.keys(deps);
  const render = new Function(...keys, `${decl('renderTrendDeltas')}\n${decl('snapshotNotComparedHtml')}\n${decl('deltaRow')}\nreturn renderTrendDeltas;`)(...keys.map((k) => deps[k])) as () => Promise<void>;
  await render();
  assert.match(host.innerHTML, /2 top-level items are in only one of these scans’ lists of the largest 100, so they are not compared\./, host.innerHTML);
});
