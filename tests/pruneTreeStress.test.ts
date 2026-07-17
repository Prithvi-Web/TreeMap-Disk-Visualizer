import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileNode } from '../src/models/types';
import { pruneTree } from '../src/utils/pruneTree';
import { collectCloudPlaceholders, matchCustomRules, lookupNodes } from '../src/services/scanQueries';

/**
 * Adversarial trees. Real disks produce shapes nobody designs for: a cache
 * directory with a million siblings, symlink farms, emoji filenames, paths at
 * the OS limit, and everything zero bytes. Each case here is one of those.
 */

function file(name: string, path: string, size: number, extra: Partial<FileNode> = {}): FileNode {
  return { name, path, size, type: 'file', modifiedAt: 0, isHidden: false, ...extra };
}
function dir(name: string, path: string, children: FileNode[]): FileNode {
  return {
    name, path, type: 'dir', modifiedAt: 0, isHidden: false,
    size: children.reduce((s, c) => s + c.size, 0), children,
  };
}
function walk(n: FileNode, out: FileNode[] = []): FileNode[] {
  out.push(n);
  if (n.children) for (const c of n.children) walk(c, out);
  return out;
}

test('a directory with 200k direct children keeps whole-directory granularity', () => {
  // Maildir/cache shapes really do this. Invariant 1 says all-or-nothing, so
  // the budget may overshoot by this fanout — that is by design, not a leak.
  const kids = Array.from({ length: 200_000 }, (_, i) => file(`m${i}`, `/r/mail/m${i}`, i + 1));
  const src = dir('root', '/r', [dir('mail', '/r/mail', kids)]);

  const r = pruneTree(src, { maxNodes: 1000 });
  const mail = walk(r.root).find((n) => n.path === '/r/mail')!;

  assert.ok(mail.children === undefined || mail.children.length === 200_000,
    'the folder is either withheld entirely or complete — never partial');
  assert.equal(mail.size, kids.reduce((s, k) => s + k.size, 0), 'size stays exact either way');
  assert.equal(r.nodes, walk(r.root).length, 'the reported count matches reality');
});

test('a 5,000-deep tree does not blow the stack', () => {
  // Path length caps real depth far below this, but a crafted or synthetic
  // tree must not turn into a RangeError: Maximum call stack size exceeded.
  let node = dir('leafdir', '/r' + '/d'.repeat(5000), [file('f', '/r' + '/d'.repeat(5000) + '/f', 1)]);
  for (let i = 4999; i >= 1; i--) node = dir('d', '/r' + '/d'.repeat(i), [node]);
  const src = dir('root', '/r', [node]);

  assert.doesNotThrow(() => {
    const r = pruneTree(src, { maxNodes: 100_000 });
    assert.ok(r.nodes > 1000, 'it should have walked deep');
  });
});

test('deep trees do not blow the stack in the aggregate queries either', () => {
  let node: FileNode = dir('leafdir', '/r' + '/d'.repeat(3000), [
    file('a.jpg', '/r' + '/d'.repeat(3000) + '/a.jpg', 10, { extension: 'jpg' }),
  ]);
  for (let i = 2999; i >= 1; i--) node = dir('d', '/r' + '/d'.repeat(i), [node]);
  const src = dir('root', '/r', [node]);

  assert.doesNotThrow(() => {
    assert.equal(matchCustomRules(src, { exts: ['jpg'] }, 500, 0).matched, 1);
    assert.equal(collectCloudPlaceholders(src, 300).totalCount, 0);
  });
});

test('emoji, newlines, quotes and unicode in names survive a round trip', () => {
  const nasty = [
    '🎉 party.png', 'ünïcøde.txt', '日本語のファイル.pdf', 'quote".txt', "apos'.txt",
    'back\\slash.txt', 'new\nline.txt', 'tab\there.txt', '<script>alert(1)</script>.txt',
    'em—dash.txt', 'nul-ish.txt',
  ];
  const src = dir('root', '/r', nasty.map((n, i) => file(n, `/r/${n}`, i + 1)));
  const r = pruneTree(src, { maxNodes: 10_000 });

  // A round trip through JSON is what actually happens on the wire.
  const back = JSON.parse(JSON.stringify(r.root)) as FileNode;
  assert.deepEqual(back.children!.map((c) => c.name), nasty, 'every name must survive verbatim');
});

test('paths at the OS length limit are handled', () => {
  const longName = 'x'.repeat(255); // per-component max on macOS/ext4
  const deep = '/r/' + Array.from({ length: 15 }, () => longName).join('/');
  const src = dir('root', '/r', [file(longName, deep, 42)]);
  const r = pruneTree(src, { maxNodes: 100 });
  assert.equal(r.root.children![0].path, deep);
  assert.equal(r.root.children![0].size, 42);
});

test('an all-zero-byte tree prunes without dividing by zero or NaN', () => {
  const kids = Array.from({ length: 100 }, (_, i) => file(`f${i}`, `/r/f${i}`, 0));
  const src = dir('root', '/r', [dir('a', '/r/a', kids), dir('b', '/r/b', [])]);
  const r = pruneTree(src, { maxNodes: 10 });

  for (const n of walk(r.root)) {
    assert.ok(Number.isFinite(n.size), `${n.path} has a non-finite size`);
    assert.ok(!Number.isNaN(n.size), `${n.path} is NaN`);
  }
  assert.equal(r.root.size, 0);
});

test('symlinks and hardlink duplicates are carried through untouched', () => {
  const src = dir('root', '/r', [
    file('link', '/r/link', 0, { isSymlink: true }),
    file('hard', '/r/hard', 0, { hardlinkDuplicate: true }),
    file('real', '/r/real', 100),
  ]);
  const r = pruneTree(src, { maxNodes: 100 });
  const byName = new Map(r.root.children!.map((c) => [c.name, c]));
  assert.equal(byName.get('link')!.isSymlink, true);
  assert.equal(byName.get('hard')!.hardlinkDuplicate, true);
});

test('a tree of nothing but empty directories never marks anything pruned', () => {
  const src = dir('root', '/r', Array.from({ length: 50 }, (_, i) => dir(`e${i}`, `/r/e${i}`, [])));
  const r = pruneTree(src, { maxNodes: 5 });
  // Root itself is expandable, so it expands; each child is empty and stays so.
  for (const n of walk(r.root)) {
    if (n.path === '/r') continue;
    assert.deepEqual(n.children, [], `${n.path} should keep its empty list`);
    assert.equal(n.pruned, undefined);
  }
});

test('equal-sized siblings do not confuse the max-heap ordering', () => {
  const src = dir('root', '/r', Array.from({ length: 100 }, (_, i) =>
    dir(`d${i}`, `/r/d${i}`, [file('f', `/r/d${i}/f`, 100)])));
  assert.doesNotThrow(() => {
    const r = pruneTree(src, { maxNodes: 50 });
    assert.equal(r.nodes, walk(r.root).length);
  });
});

test('a negative or zero budget still returns a usable root', () => {
  const src = dir('root', '/r', [file('a', '/r/a', 1)]);
  for (const maxNodes of [0, -1, -9999]) {
    const r = pruneTree(src, { maxNodes });
    assert.equal(r.root.path, '/r', `budget ${maxNodes} must still yield the root`);
    assert.equal(r.root.size, 1);
  }
});

test('a huge budget on a small tree is harmless', () => {
  const src = dir('root', '/r', [file('a', '/r/a', 1)]);
  const r = pruneTree(src, { maxNodes: Number.MAX_SAFE_INTEGER });
  assert.equal(r.nodes, 2);
  assert.equal(r.prunedDirs, 0);
});

test('lookupNodes tolerates an empty batch and duplicate paths', () => {
  const src = dir('root', '/r', [file('a', '/r/a', 5)]);
  assert.deepEqual(lookupNodes(src, []), {});
  const r = lookupNodes(src, ['/r/a', '/r/a']);
  assert.equal(r['/r/a']?.size, 5);
});

test('rule matching handles absurd thresholds without throwing', () => {
  const src = dir('root', '/r', [file('a.txt', '/r/a.txt', 10, { extension: 'txt' })]);
  assert.equal(matchCustomRules(src, { minBytes: Number.MAX_SAFE_INTEGER }, 500, 0).matched, 0);
  assert.equal(matchCustomRules(src, { maxAgeMs: 0 }, 500, 0).matched, 1, 'age 0 matches everything');
  assert.equal(matchCustomRules(src, { exts: [] }, 500, 0).matched, 1, 'no extensions = no ext filter');
  assert.equal(matchCustomRules(src, { minBytes: 0 }, 0, 0).files.length, 0, 'a limit of 0 returns nothing');
});

test('duplicate detection over many identical files stays correct', () => {
  const kids = Array.from({ length: 5000 }, (_, i) => file('same.jpg', `/r/d${i}/same.jpg`, 1000));
  const src = dir('root', '/r', kids);
  const r = matchCustomRules(src, { dup: true }, 500, 0);
  assert.equal(r.matched, 5000, 'every copy is a duplicate of the others');
  assert.equal(r.files.length, 500, 'the list is capped');
  assert.equal(r.truncated, true);
});
