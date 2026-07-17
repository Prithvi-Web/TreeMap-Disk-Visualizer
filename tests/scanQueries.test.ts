import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileNode } from '../src/models/types';
import { collectCloudPlaceholders, matchCustomRules, lookupNodes } from '../src/services/scanQueries';

/**
 * These queries exist because the browser now holds a pruned tree and would
 * otherwise answer them over a fraction of the scan — confidently, and wrongly.
 * So what's tested here is mostly *exactness*: totals describe the whole scan,
 * even when the returned lists are capped.
 */

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function file(name: string, path: string, size: number, extra: Partial<FileNode> = {}): FileNode {
  return { name, path, size, type: 'file', modifiedAt: NOW, isHidden: false, ...extra };
}
function dir(name: string, path: string, children: FileNode[]): FileNode {
  return {
    name, path, type: 'dir', modifiedAt: NOW, isHidden: false,
    size: children.reduce((s, c) => s + c.size, 0), children,
  };
}

/* ------------------------- cloud placeholders ------------------------- */

test('cloud placeholders group by provider with exact counts and totals', () => {
  const root = dir('root', '/r', [
    file('a.raw', '/r/a.raw', 100, { cloudPlaceholder: true, cloudProvider: 'icloud' }),
    file('b.raw', '/r/b.raw', 50, { cloudPlaceholder: true, cloudProvider: 'icloud' }),
    file('c.doc', '/r/c.doc', 20, { cloudPlaceholder: true, cloudProvider: 'onedrive' }),
    file('local.txt', '/r/local.txt', 999), // not online-only
  ]);

  const r = collectCloudPlaceholders(root, 300);
  assert.equal(r.totalCount, 3);
  assert.equal(r.totalSize, 170);

  const icloud = r.groups.find((g) => g.provider === 'icloud')!;
  assert.equal(icloud.count, 2);
  assert.equal(icloud.totalSize, 150);
  assert.deepEqual(icloud.files.map((f) => f.name), ['a.raw', 'b.raw'], 'largest first');

  const onedrive = r.groups.find((g) => g.provider === 'onedrive')!;
  assert.equal(onedrive.count, 1);
  assert.ok(!r.groups.some((g) => g.files.some((f) => f.name === 'local.txt')));
});

test('cloud totals stay exact when the file list is capped', () => {
  const kids = Array.from({ length: 500 }, (_, i) =>
    file(`f${i}`, `/r/f${i}`, i + 1, { cloudPlaceholder: true, cloudProvider: 'dropbox' }));
  const r = collectCloudPlaceholders(dir('root', '/r', kids), 10);

  const g = r.groups[0];
  assert.equal(g.files.length, 10, 'the list is capped');
  assert.equal(g.count, 500, 'but the count describes the whole scan');
  assert.equal(g.totalSize, (500 * 501) / 2, 'and so does the byte total');
  assert.equal(g.files[0].size, 500, 'the cap keeps the largest');
  assert.equal(r.totalCount, 500);
});

test('a placeholder with no provider groups under "cloud"', () => {
  const r = collectCloudPlaceholders(
    dir('root', '/r', [file('x', '/r/x', 5, { cloudPlaceholder: true })]), 300);
  assert.equal(r.groups[0].provider, 'cloud');
  assert.equal(r.groups[0].count, 1);
});

test('cloud placeholders never descend into an expanded container', () => {
  const zip: FileNode = {
    ...file('a.zip', '/r/a.zip', 10, { container: 'zip' }),
    children: [file('inner', '/r/a.zip/inner', 10, { cloudPlaceholder: true, virtual: true })],
  };
  const r = collectCloudPlaceholders(dir('root', '/r', [zip]), 300);
  assert.equal(r.totalCount, 0, 'archive entries are a listing, not online-only files on disk');
});

/* ---------------------------- custom rules ---------------------------- */

test('the age rule matches only files at least that old', () => {
  const root = dir('root', '/r', [
    file('old.txt', '/r/old.txt', 10, { modifiedAt: NOW - 40 * DAY }),
    file('new.txt', '/r/new.txt', 10, { modifiedAt: NOW - 2 * DAY }),
  ]);
  const r = matchCustomRules(root, { maxAgeMs: 30 * DAY }, 500, NOW);
  assert.deepEqual(r.files.map((f) => f.name), ['old.txt']);
  assert.equal(r.matched, 1);
});

test('the size rule matches only files at least that big', () => {
  const root = dir('root', '/r', [file('big', '/r/big', 5000), file('small', '/r/small', 10)]);
  const r = matchCustomRules(root, { minBytes: 1000 }, 500, NOW);
  assert.deepEqual(r.files.map((f) => f.name), ['big']);
});

test('the extension rule matches only the listed extensions', () => {
  const root = dir('root', '/r', [
    file('a.jpg', '/r/a.jpg', 30, { extension: 'jpg' }),
    file('b.png', '/r/b.png', 20, { extension: 'png' }),
    file('c.txt', '/r/c.txt', 10, { extension: 'txt' }),
  ]);
  const r = matchCustomRules(root, { exts: ['jpg', 'png'] }, 500, NOW);
  assert.deepEqual(r.files.map((f) => f.name), ['a.jpg', 'b.png']);
});

test('the duplicate rule sees duplicates across the WHOLE tree, however deep', () => {
  // The two copies sit in different branches at different depths — exactly the
  // case a pruned client-side tree would miss.
  const root = dir('root', '/r', [
    dir('a', '/r/a', [file('photo.jpg', '/r/a/photo.jpg', 500, { extension: 'jpg' })]),
    dir('b', '/r/b', [
      dir('deep', '/r/b/deep', [
        dir('deeper', '/r/b/deep/deeper', [file('photo.jpg', '/r/b/deep/deeper/photo.jpg', 500, { extension: 'jpg' })]),
      ]),
    ]),
    file('unique.jpg', '/r/unique.jpg', 900, { extension: 'jpg' }),
  ]);

  const r = matchCustomRules(root, { dup: true }, 500, NOW);
  assert.equal(r.matched, 2, 'both copies match; the unique file does not');
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['/r/a/photo.jpg', '/r/b/deep/deeper/photo.jpg']);
});

test('duplicate identity is name AND size, matching the original rule', () => {
  const root = dir('root', '/r', [
    file('same.txt', '/r/same.txt', 100),
    file('same.txt', '/r/sub/same.txt', 999), // same name, different size
  ]);
  const r = matchCustomRules(root, { dup: true }, 500, NOW);
  assert.equal(r.matched, 0, 'same name but a different size is not a duplicate');
});

test('enabled rules are ANDed together', () => {
  const root = dir('root', '/r', [
    file('hit.jpg', '/r/hit.jpg', 5000, { extension: 'jpg', modifiedAt: NOW - 40 * DAY }),
    file('toonew.jpg', '/r/toonew.jpg', 5000, { extension: 'jpg', modifiedAt: NOW }),
    file('toosmall.jpg', '/r/toosmall.jpg', 5, { extension: 'jpg', modifiedAt: NOW - 40 * DAY }),
    file('wrongext.txt', '/r/wrongext.txt', 5000, { extension: 'txt', modifiedAt: NOW - 40 * DAY }),
  ]);
  const r = matchCustomRules(root, { maxAgeMs: 30 * DAY, minBytes: 1000, exts: ['jpg'] }, 500, NOW);
  assert.deepEqual(r.files.map((f) => f.name), ['hit.jpg']);
});

test('matched counts every hit even when the returned list is capped', () => {
  const kids = Array.from({ length: 300 }, (_, i) => file(`f${i}`, `/r/f${i}`, i + 1));
  const r = matchCustomRules(dir('root', '/r', kids), { minBytes: 1 }, 10, NOW);
  assert.equal(r.files.length, 10);
  assert.equal(r.matched, 300, 'the true total must survive the cap');
  assert.equal(r.truncated, true);
  assert.equal(r.files[0].size, 300, 'and the cap keeps the largest');
});

test('custom rules never offer files inside an expanded container', () => {
  // requireInsideScanRoot refuses to trash them, so offering them would be a lie.
  const zip: FileNode = {
    ...file('a.zip', '/r/a.zip', 10, { container: 'zip' }),
    children: [file('inner.jpg', '/r/a.zip/inner.jpg', 10, { extension: 'jpg', virtual: true })],
  };
  const r = matchCustomRules(dir('root', '/r', [zip]), { exts: ['jpg'] }, 500, NOW);
  assert.equal(r.matched, 0);
});

/* --------------------------- lookupNodes ----------------------------- */

test('lookupNodes resolves paths to metadata and reports misses as null', () => {
  const root = dir('root', '/r', [
    dir('sub', '/r/sub', [file('a.txt', '/r/sub/a.txt', 42)]),
  ]);
  const r = lookupNodes(root, ['/r/sub/a.txt', '/r/nope']);

  assert.equal(r['/r/sub/a.txt']?.size, 42);
  assert.equal(r['/r/sub/a.txt']?.name, 'a.txt');
  assert.equal(r['/r/nope'], null, 'a path not in this scan is a real answer, not a zero');
});

test('lookupNodes returns a directory as metadata only, with its true size', () => {
  const root = dir('root', '/r', [
    dir('sub', '/r/sub', [file('a', '/r/sub/a', 40), file('b', '/r/sub/b', 60)]),
  ]);
  const r = lookupNodes(root, ['/r/sub']);
  const sub = r['/r/sub']!;

  assert.equal(sub.size, 100, 'the recursive total must be exact');
  assert.equal(sub.children, undefined, 'metadata only — no children shipped');
  assert.equal(sub.pruned, true, 'and marked so the client knows to drill in');
});
