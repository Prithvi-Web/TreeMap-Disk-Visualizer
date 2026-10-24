import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import fs from 'node:fs';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-journalUnlisted-data-');
process.env.TREEMAP_NO_GDU = '1';

import type { FileNode, ScanResult, SnapshotTreeNode } from '../src/models/types';
import { significantChanges } from '../src/services/journal';
import { buildSnapshotTree } from '../src/services/snapshots';
import { buildStoreFromTree, Flag, storeOf } from '../src/services/scanStore';
import { getScan, peekScan, startScan } from '../src/services/diskScanner';
import { updateSettings } from '../src/services/settings';
import { waitFor } from './fixtures/waitFor';

/**
 * The journal never says a process removed what a scan could not read (hunt C47). A folder the newer
 * scan was refused (one scan with Full Disk Access and one without, or a mount that stopped answering)
 * reads 0 bytes in that scan, and the journal's walk over the two snapshot trees recorded "an
 * unidentified process removed 12 GB from Mail". Now a snapshot tree marks a folder its scan did not
 * list in full (`u`) and keeps it however small, and the walk leaves such a folder's change out — not
 * reported there, and not reported as the unexplained remainder of the folder above it.
 */

const GB = 1_000_000_000;
const node = (n: string, s: number, c?: SnapshotTreeNode[], u?: true): SnapshotTreeNode => ({ n, s, ...(c ? { t: 1 as const, c } : {}), ...(u ? { u: 1 as const } : {}) });

test('a folder the newer scan could not list is not reported as removed, at itself or above it', () => {
  const prev = node('x', 30 * GB, [node('Library', 20 * GB, [node('Mail', 12 * GB, []), node('Caches', 8 * GB, [])]), node('Movies', 10 * GB, [])]);
  const curr = node('x', 18 * GB, [node('Library', 8 * GB, [node('Mail', 0, [], true), node('Caches', 8 * GB, [])]), node('Movies', 10 * GB, [])]);
  assert.deepEqual(significantChanges(prev, curr, '/Users/x'), [], 'nothing is known to have changed');
});

test('a real change beside it is still found, and pinned where it is known', () => {
  const prev = node('x', 30 * GB, [node('Library', 20 * GB, [node('Mail', 12 * GB, []), node('Caches', 8 * GB, [])]), node('Movies', 10 * GB, [])]);
  const curr = node('x', 22 * GB, [node('Library', 8 * GB, [node('Mail', 0, [], true), node('Caches', 8 * GB, [])]), node('Movies', 14 * GB, [])]);
  assert.deepEqual(significantChanges(prev, curr, '/Users/x'), [{ path: '/Users/x/Movies', delta: 4 * GB }]);
});

test('the older scan\'s unread folder is unknown the same way, and so is a scanned folder its scan could not list', () => {
  const prev = node('x', 10 * GB, [node('Mail', 0, [], true), node('Movies', 10 * GB, [])]);
  const curr = node('x', 22 * GB, [node('Mail', 12 * GB, []), node('Movies', 10 * GB, [])]);
  assert.deepEqual(significantChanges(prev, curr, '/Users/x'), []);
  assert.deepEqual(significantChanges(node('x', 10 * GB, [node('Movies', 10 * GB, [])]), node('x', 0, [], true), '/Users/x'), [],
    'the scanned folder itself refused: nothing is known');
});

test('a snapshot tree marks a folder its scan did not list in full, and keeps it however small', () => {
  const root = path.join(path.sep, 'tree-root');
  const kids: FileNode[] = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, path: path.join(root, `f${i}`), size: 1000 + i, type: 'file', modifiedAt: 1, isHidden: false }));
  const mail: FileNode = { name: 'Mail', path: path.join(root, 'Mail'), size: 0, type: 'dir', modifiedAt: 1, isHidden: false, children: [] };
  const top: FileNode = { name: 'tree-root', path: root, size: kids.reduce((s, k) => s + k.size, 0), type: 'dir', modifiedAt: 1, isHidden: false, children: [...kids, mail] };
  const store = buildStoreFromTree(top);
  store.setFlag(store.findByPath(mail.path), Flag.Unlisted, true);
  const tree = buildSnapshotTree(store);
  const kept = tree.c?.find((c) => c.n === 'Mail');
  assert.ok(kept, 'kept, though it is 0 bytes and 40 larger items stand beside it');
  assert.equal(kept?.u, 1, 'marked as not listed in full');
  assert.equal(tree.u, undefined, 'a folder listed in full carries no mark');
});

test('in a folder listed only in part, a change in what both scans list is still found, and only the rest is left out (review F1.2)', () => {
  // proj had an entry whose stat failed in the newer scan; proj/src/big.bin grew by 20 GB.
  const prev = node('x', 1 * GB, [node('proj', 1 * GB, [node('src', 1 * GB, [node('big.bin', 1 * GB)])])]);
  const curr = node('x', 21 * GB, [node('proj', 21 * GB, [node('src', 21 * GB, [node('big.bin', 21 * GB)])], true)]);
  assert.deepEqual(significantChanges(prev, curr, '/x'), [{ path: '/x/proj/src/big.bin', delta: 20 * GB }]);
  // And what its matched children do not explain is left out: not reported at proj, nor above it.
  const shrunk = node('x', 6 * GB, [node('proj', 6 * GB, [node('src', 6 * GB, [node('big.bin', 6 * GB)])], true)]);
  const before = node('x', 9 * GB, [node('proj', 9 * GB, [node('src', 1 * GB, [node('big.bin', 1 * GB)])])]);
  assert.deepEqual(significantChanges(before, shrunk, '/x'), [{ path: '/x/proj/src/big.bin', delta: 5 * GB }]);
});

async function scanToEnd(root: string): Promise<ScanResult> {
  const started = await startScan(root, {});
  await waitFor(() => peekScan(started.scanId)?.status !== 'running', 'the scan settling');
  return getScan(started.scanId) as ScanResult;
}

test('a folder holding what a "Don\'t scan" rule left out is listed in full for the journal (review F1.2, F1.13)', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-journalUnlisted-rule-'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), 'x');
  fs.mkdirSync(path.join(root, 'proj'));
  fs.writeFileSync(path.join(root, 'proj', 'a.txt'), 'a');
  await updateSettings({ ignore: [{ pattern: 'node_modules', scope: 'scan' }] });
  try {
    const scan = await scanToEnd(root);
    const store = storeOf(scan);
    assert.equal(store.flag(store.rootId, Flag.Unlisted), true, 'never offered as empty: what the rule left out is in it');
    const tree = buildSnapshotTree(store);
    assert.equal(tree.u, undefined, 'but its change is known: every entry the rule did not match was listed');
  } finally {
    await updateSettings({ ignore: [] });
  }
});
