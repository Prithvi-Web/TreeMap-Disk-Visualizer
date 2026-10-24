import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-cleanupTrashTruthServer-data-');

import { collectCleanupSuggestions, ITEMS_PER_RULE } from '../src/services/cleanupRules';
import { FileNode } from '../src/models/types';

/**
 * Hunt group C (24 Oct 2026), the server's half: the figures and sentences
 * the page prints about Clean Up, the cart, the Trash and the Undo Vault are
 * the server's, so they are pinned where they are made.
 */

const ROOT = path.resolve('/scanroot');
let uid = 0;
function file(name: string, size: number, at: string): FileNode {
  return { name, path: path.join(at, name), size, type: 'file', modifiedAt: Date.now(), isHidden: false, extension: (name.split('.').pop() || '').toLowerCase() };
}
function dir(name: string, children: (at: string) => FileNode[], at: string): FileNode {
  const here = path.join(at, name);
  const kids = children(here);
  return { name, path: here, type: 'dir', modifiedAt: 0, isHidden: false, size: kids.reduce((s, c) => s + c.size, 0), children: kids };
}

/* ═════════ C62 — a group counts every match, as its total does ═════════ */

test('a Smart suggestions group counts every match beside its capped list, so the badge can say how many (C62)', () => {
  const N = ITEMS_PER_RULE + 50;
  const kids = Array.from({ length: N }, (_, i) => dir(`p${i}`, (at) => [dir('__pycache__', (a) => [file(`x${uid++}.pyc`, 1000 + i, a)], at)], ROOT));
  const root: FileNode = { name: 'scanroot', path: ROOT, type: 'dir', modifiedAt: 0, isHidden: false, size: kids.reduce((s, c) => s + c.size, 0), children: kids };
  const py = collectCleanupSuggestions(root, []).find((g) => g.id === 'regen-pycache');
  assert.ok(py, 'control: the rule matched');
  assert.equal(py.items.length, ITEMS_PER_RULE, 'control: the list is capped');
  assert.equal(py.count, N, 'the count is every match, as totalSize is');
  const one = collectCleanupSuggestions({ ...root, children: kids.slice(0, 1), size: kids[0].size }, []).find((g) => g.id === 'regen-pycache');
  assert.equal(one?.count, 1, 'and a single match is one');
});
