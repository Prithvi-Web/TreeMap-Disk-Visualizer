import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-query-empty-unproven-');

import { parse } from '../src/services/query/parse';
import { executeAgainstScan, type QueryOutcome } from '../src/services/query/execute';
import { createScanRecord } from '../src/services/diskScanner';
import { buildStoreFromTree, Flag } from '../src/services/scanStore';
import type { FileNode, ScanResult } from '../src/models/types';
import type { Ast } from '../src/services/query/types';

/**
 * `empty:` decides only what the scan can vouch for (U-4b, the review of
 * 5a0b905, M1 and L5).
 *
 * A folder the tree shows with no children is empty only if the scan listed it
 * in full. Flag.Unlisted names the folders an engine knows it did not; two
 * engines cannot name them all: gdu shows a folder it could not read as an
 * empty one, and the native engine counts the entries it could not look at
 * without naming their folders. On such a scan a childless folder is unknown
 * to `empty:` — neither `empty:yes` nor `empty:no` — and `degraded` says why,
 * beside the `undecided` count AGENTS.md promises. A folder with a listed
 * child is decided either way: that child proves it is not empty.
 */

const NOW = 1_800_000_000_000;

function ast(q: string): Ast {
  const r = parse(q);
  assert.equal(r.ok, true, `"${q}" failed to parse` + (r.ok ? '' : `: ${r.error}`));
  return (r as { ok: true; ast: Ast }).ast;
}

const at = (name: string, p: string, children?: FileNode[]): FileNode => ({
  name, path: p, type: children ? 'dir' : 'file', modifiedAt: NOW, isHidden: false,
  size: children ? 0 : 10, ...(children ? { children } : {}),
});

function scanOf(tree: FileNode, fields: Partial<ScanResult> = {}, unlisted: string[] = []): ScanResult {
  const store = buildStoreFromTree(tree);
  for (const p of unlisted) store.setFlag(store.findByPath(p), Flag.Unlisted, true);
  const scan = createScanRecord(tree.path);
  Object.assign(scan, fields);
  scan.store = store;
  scan.status = 'complete';
  return scan;
}

async function run(scan: ScanResult, q: string): Promise<{ dirs: string[]; degraded: Map<string, string> }> {
  const out = await executeAgainstScan(scan.scanId, ast(q), { limit: 1_000, offset: 0, sort: 'path', signal: new AbortController().signal });
  assert.ok(!('error' in out), `"${q}": ${JSON.stringify(out)}`);
  const o = out as QueryOutcome;
  return { dirs: o.hits.filter((h) => h.isDir).map((h) => h.path).sort(), degraded: new Map(o.degraded.map((d) => [d.provider, d.reason])) };
}

test('a folder not listed in full is unknown only while it shows no child: one listed child proves it is not empty (L5)', async () => {
  const scan = scanOf(at('q', '/q', [
    at('refused', '/q/refused', []),
    // A "don't scan" pattern left an entry out, but src was listed.
    at('partial', '/q/partial', [at('src', '/q/partial/src', [])]),
    at('fine', '/q/fine', []),
    at('full', '/q/full', [at('f.txt', '/q/full/f.txt')]),
  ]), { engine: 'walker' }, ['/q/refused', '/q/partial']);
  const yes = await run(scan, 'type:dir empty:yes');
  assert.deepEqual(yes.dirs, ['/q/fine', '/q/partial/src']);
  assert.match(yes.degraded.get('undecided') ?? '', /^1 item could not be decided/, 'the refused folder is counted as undecided, never as "did not match"');
  const no = await run(scan, 'type:dir empty:no');
  assert.deepEqual(no.dirs, ['/q', '/q/full', '/q/partial'], 'partial holds src: not empty, whatever else its listing missed');
  assert.match(no.degraded.get('undecided') ?? '', /^1 item/);
  assert.deepEqual((await run(scan, 'type:dir -empty:yes')).dirs, no.dirs, 'and -empty:yes reads the same');
});

test('on a gdu scan every childless folder is unknown to empty:, and degraded says why (M1)', async () => {
  const scan = scanOf(at('g', '/g', [
    at('e1', '/g/e1', []),
    at('keep', '/g/keep', [at('f.txt', '/g/keep/f.txt')]),
    at('nest', '/g/nest', [at('e2', '/g/nest/e2', [])]),
  ]), { engine: 'gdu-turbo' });
  const yes = await run(scan, 'type:dir empty:yes');
  assert.deepEqual(yes.dirs, [], 'gdu shows a folder it could not read as an empty one: none is offered as empty');
  assert.match(yes.degraded.get('undecided') ?? '', /^2 items could not be decided/);
  assert.match(yes.degraded.get('emptyUnproven') ?? '', /gdu/, 'the reason names the engine');
  assert.match(yes.degraded.get('emptyUnproven') ?? '', /onlyEmptyFolders|Empty Folders/, 'and what to do instead');
  const no = await run(scan, 'type:dir empty:no');
  assert.deepEqual(no.dirs, ['/g', '/g/keep', '/g/nest'], 'a folder with a listed child is decided');
  // The plain-words phrase lands on the same terms.
  assert.deepEqual((await run(scan, 'empty:yes type:dir')).dirs, []);
});

test('on a native scan that could not look at some entries, naming no folder, a childless folder is unknown too (M1)', async () => {
  const tree = (): FileNode => at('n', '/n', [at('e1', '/n/e1', []), at('keep', '/n/keep', [at('f.txt', '/n/keep/f.txt')])]);
  const counted = scanOf(tree(), { engine: 'native', deniedEntries: 2, unreadableEntries: 1 });
  const yes = await run(counted, 'type:dir empty:yes');
  assert.deepEqual(yes.dirs, []);
  assert.match(yes.degraded.get('emptyUnproven') ?? '', /3 items/, 'how many it could not look at');
  assert.match(yes.degraded.get('undecided') ?? '', /^1 item/);
  // The memory path counts the folders it could not read without naming them, too.
  const unreadableFolder = await run(scanOf(tree(), { engine: 'native', unreadableDirs: 1 }), 'type:dir empty:yes');
  assert.deepEqual(unreadableFolder.dirs, []);
  assert.match(unreadableFolder.degraded.get('emptyUnproven') ?? '', /1 item /);
  // A folder that vanished during the scan is gone: nothing to doubt.
  assert.deepEqual((await run(scanOf(tree(), { engine: 'native', vanishedDirs: 2 }), 'type:dir empty:yes')).dirs, ['/n/e1']);
  // Every entry looked at: the native engine's own records are whole, and its childless folders are empty.
  const whole = scanOf(tree(), { engine: 'native', deniedEntries: 0, unreadableEntries: 0 });
  const decided = await run(whole, 'type:dir empty:yes');
  assert.deepEqual(decided.dirs, ['/n/e1']);
  assert.equal(decided.degraded.has('emptyUnproven'), false);
});

test('a native scan on the columns path names its unreadable folders: those are undecided by their mark, the rest decided (U-4b review, L-7)', async () => {
  // The columns ingest marks every folder it could not read (Flag.Unlisted) and says so; counting
  // them as well once left every childless folder of the scan undecided.
  const tree = (): FileNode => at('n', '/n', [at('e1', '/n/e1', []), at('bad', '/n/bad', [])]);
  const named = await run(scanOf(tree(), { engine: 'native', unreadableDirs: 1, unreadableDirsNamed: true }, ['/n/bad']), 'type:dir empty:yes');
  assert.deepEqual(named.dirs, ['/n/e1'], 'e1 is decided empty; bad, marked, is not');
  assert.equal(named.degraded.has('emptyUnproven'), false);
  assert.match(named.degraded.get('undecided') ?? '', /^1 item/, 'only the marked folder is undecided');
  // Counted without the word that they are named (the memory path): every childless folder is doubted.
  assert.deepEqual((await run(scanOf(tree(), { engine: 'native', unreadableDirs: 1 }, ['/n/bad']), 'type:dir empty:yes')).dirs, []);
  // Entries it could not look at are never named, columns path or not.
  assert.deepEqual((await run(scanOf(tree(), { engine: 'native', unreadableDirs: 1, unreadableDirsNamed: true, deniedEntries: 1 }, ['/n/bad']), 'type:dir empty:yes')).dirs, []);
});

test('the walker names every folder it did not list, so its own counts leave childless folders decided', async () => {
  // The walker marks the folder of each entry it could not look at (Flag.Unlisted); its counts are a summary.
  const scan = scanOf(at('w', '/w', [at('e1', '/w/e1', [])]), { engine: 'walker', deniedEntries: 4, unreadableEntries: 2 });
  const yes = await run(scan, 'type:dir empty:yes');
  assert.deepEqual(yes.dirs, ['/w/e1']);
  assert.equal(yes.degraded.has('emptyUnproven'), false);
  assert.equal(yes.degraded.has('undecided'), false);
});

test('emptyUnproven is said only where a childless folder was left undecided: one another term decides is not doubted (U-4b review, L-4)', async () => {
  const scan = scanOf(at('g', '/g', [
    at('e1', '/g/e1', []),
    at('keep', '/g/keep', [at('f.txt', '/g/keep/f.txt')]),
  ]), { engine: 'gdu-turbo' });
  // Every folder here is far below 1 GB: size decides each one, whatever empty: would say.
  const big = await run(scan, 'size>1gb empty:yes');
  assert.deepEqual(big.dirs, []);
  assert.equal(big.degraded.has('undecided'), false, 'every item is decided by its size');
  assert.equal(big.degraded.has('emptyUnproven'), false, 'so no childless folder was left undecided, and none is blamed');
  // The same where a fact is looked up file by file (the second pass): decided false before it, never doubted.
  assert.equal((await run(scan, 'size>1gb empty:yes created>2000-01-01')).degraded.has('emptyUnproven'), false);
  // Where one is left undecided, it is said — in either pass.
  assert.ok((await run(scan, 'type:dir empty:yes')).degraded.has('emptyUnproven'));
  assert.ok((await run(scan, 'type:dir empty:yes created>2000-01-01')).degraded.has('emptyUnproven'));
});

test('a query that does not ask about empty: hears nothing about it', async () => {
  const scan = scanOf(at('g', '/g', [at('e1', '/g/e1', [])]), { engine: 'gdu-turbo' });
  const dirs = await run(scan, 'type:dir');
  assert.deepEqual(dirs.dirs, ['/g', '/g/e1']);
  assert.equal(dirs.degraded.has('emptyUnproven'), false);
  assert.equal(dirs.degraded.has('undecided'), false);
});
