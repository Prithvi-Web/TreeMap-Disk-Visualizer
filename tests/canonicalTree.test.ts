import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackedScanStore, type NodeInput } from '../src/services/scanStore';
import type { ScanResult } from '../src/models/types';
import { COUNTER_NAMES, canonicalDigest, canonicalLines, countersOf, firstDifference } from './fixtures/canonicalTree';

/**
 * The canonical digest (Phase 3, W3; decision P3-8): one line per node, children
 * in name-byte order, a hard-link family's bytes on its smallest path. Two
 * legacy walks of one tree are not byte-identical to each other on those two
 * points, so the digest normalises exactly them and nothing else. These tests
 * pin that contract on hand-built stores; the live engines meet it in
 * tests/nativeEquivalence.test.ts.
 */

const MTIME = 1_700_000_000_000;
const ROOT = '/fx';

const file = (name: string, size: number, extra: Partial<NodeInput> = {}): NodeInput =>
  ({ name, isDir: false, size, modifiedAt: MTIME, isHidden: name.startsWith('.'), ...extra });
const dir = (name: string, extra: Partial<NodeInput> = {}): NodeInput =>
  ({ name, isDir: true, size: 0, modifiedAt: MTIME, isHidden: name.startsWith('.'), ...extra });

interface Spec { input: NodeInput; children?: Spec[] }

/** A store from a spec, every directory's children inserted as written or reversed. */
function build(children: Spec[], order: 'as-written' | 'reversed' = 'as-written'): PackedScanStore {
  const store = new PackedScanStore(ROOT, '/', dir('fx'));
  const add = (parent: number, specs: Spec[]): void => {
    const ordered = order === 'reversed' ? [...specs].reverse() : specs;
    for (const s of ordered) {
      const id = store.addNode(parent, s.input);
      if (s.children) add(id, s.children);
    }
  };
  add(store.rootId, children);
  store.finalize();
  store.sumSizes();
  return store;
}

const TREE: Spec[] = [
  { input: file('b.txt', 20, { extension: 'txt' }) },
  { input: file('a.txt', 10, { extension: 'txt', accessedAt: MTIME + 5 }) },
  {
    input: dir('sub', { gitRepo: true }),
    children: [
      { input: file('.git', 0) },
      { input: file('émoji.png', 7, { extension: 'png' }) },
      { input: file('Z.bin', 3, { extension: 'bin' }) },
    ],
  },
  { input: file('archive.zip', 99, { extension: 'zip', container: 'zip' }) },
  { input: file('link', 5, { isSymlink: true }) },
];

test('two stores with reversed child insertion order produce the same lines and the same digest', () => {
  const forward = build(TREE, 'as-written');
  const reversed = build(TREE, 'reversed');
  assert.deepEqual(canonicalLines(reversed), canonicalLines(forward));
  assert.equal(canonicalDigest(reversed), canonicalDigest(forward));
  assert.match(canonicalDigest(forward), /^[0-9a-f]{64}$/, 'SHA-256, hex');
});

test('one line per node, pre-order, children in name-byte order, the ten documented columns', () => {
  const lines = canonicalLines(build(TREE));
  // Byte order: 'Z' (0x5a) sorts before 'é' (0xc3 0xa9), '.git' (0x2e) before both.
  assert.deepEqual(lines, [
    `0\tfx\tdir\t144\t${MTIME}\t-\t00000\t-\t-\t-`,
    `1\ta.txt\tfile\t10\t${MTIME}\t${MTIME + 5}\t00000\ttxt\t-\t-`,
    `1\tarchive.zip\tfile\t99\t${MTIME}\t-\t00000\tzip\tzip\t-`,
    `1\tb.txt\tfile\t20\t${MTIME}\t-\t00000\ttxt\t-\t-`,
    `1\tlink\tfile\t5\t${MTIME}\t-\t01000\t-\t-\t-`,
    `1\tsub\tdir\t10\t${MTIME}\t-\t00001\t-\t-\t-`,
    `2\t.git\tfile\t0\t${MTIME}\t-\t10000\t-\t-\t-`,
    `2\tZ.bin\tfile\t3\t${MTIME}\t-\t00000\tbin\t-\t-`,
    `2\témoji.png\tfile\t7\t${MTIME}\t-\t00000\tpng\t-\t-`,
  ]);
});

test('a one-byte size change changes the digest, and firstDifference names the line', () => {
  const base = build(TREE);
  const changed = build(TREE.map((s) => (s.input.name === 'b.txt' ? { input: file('b.txt', 21, { extension: 'txt' }) } : s)));
  assert.notEqual(canonicalDigest(changed), canonicalDigest(base));
  const diff = firstDifference(canonicalLines(base), canonicalLines(changed));
  assert.ok(diff, 'the lines differ somewhere');
  // The root's total changes first (pre-order), by exactly that one byte.
  assert.equal(diff.index, 0);
  assert.equal(diff.a, `0\tfx\tdir\t144\t${MTIME}\t-\t00000\t-\t-\t-`);
  assert.equal(diff.b, `0\tfx\tdir\t145\t${MTIME}\t-\t00000\t-\t-\t-`);
});

/** A family of two names across two directories: whichever name the engine saw first carries the bytes. */
function hardlinkTree(owner: 'a.bin' | 'z.bin', deduped = true): Spec[] {
  const bytesOf = (name: string): number => (name === owner || !deduped ? 5000 : 0);
  const dupOf = (name: string): boolean => deduped && name !== owner;
  return [
    {
      input: dir('hard'),
      children: [
        { input: file('a.bin', bytesOf('a.bin'), { extension: 'bin', hardlinkDuplicate: dupOf('a.bin') || undefined }) },
        { input: dir('sub'), children: [{ input: file('z.bin', bytesOf('z.bin'), { extension: 'bin', hardlinkDuplicate: dupOf('z.bin') || undefined }) }] },
      ],
    },
    { input: file('other.txt', 1, { extension: 'txt' }) },
  ];
}

const FAMILY = [['/fx/hard/sub/z.bin', '/fx/hard/a.bin']];

test('the hard-link rule: stores that gave the bytes to different names digest equal with the family, and differ without it', () => {
  const aOwns = build(hardlinkTree('a.bin'));
  const zOwns = build(hardlinkTree('z.bin'));
  assert.notEqual(canonicalDigest(aOwns), canonicalDigest(zOwns), 'without the family the first-seen choice shows');
  const withFamily = { hardlinkFamilies: FAMILY };
  const linesA = canonicalLines(aOwns, withFamily);
  const linesZ = canonicalLines(zOwns, withFamily);
  assert.deepEqual(linesZ, linesA);
  assert.equal(canonicalDigest(zOwns, withFamily), canonicalDigest(aOwns, withFamily));
  // The smallest path (/fx/hard/a.bin) owns the bytes; every other member is size 0 and hardlinkDup;
  // directory totals follow the bytes (sub holds none, hard holds all).
  assert.deepEqual(linesZ, [
    `0\tfx\tdir\t5001\t${MTIME}\t-\t00000\t-\t-\t-`,
    `1\thard\tdir\t5000\t${MTIME}\t-\t00000\t-\t-\t-`,
    `2\ta.bin\tfile\t5000\t${MTIME}\t-\t00000\tbin\t-\t-`,
    `2\tsub\tdir\t0\t${MTIME}\t-\t00000\t-\t-\t-`,
    `3\tz.bin\tfile\t0\t${MTIME}\t-\t00100\tbin\t-\t-`,
    `1\tother.txt\tfile\t1\t${MTIME}\t-\t00000\ttxt\t-\t-`,
  ]);
});

test('the hard-link rule never hides an engine that counted the family twice', () => {
  const deduped = build(hardlinkTree('a.bin'));
  const doubleCounted = build(hardlinkTree('a.bin', false));
  const withFamily = { hardlinkFamilies: FAMILY };
  assert.notEqual(canonicalDigest(doubleCounted, withFamily), canonicalDigest(deduped, withFamily));
  const diff = firstDifference(canonicalLines(deduped, withFamily), canonicalLines(doubleCounted, withFamily));
  assert.ok(diff && diff.b !== null);
  assert.match(diff.b, /\t10001\t/, 'the root total carries both copies, 5000 + 5000 + 1');
});

test('a store with accessedAt present differs from one without (atime is compared, P3-5)', () => {
  const without = build([{ input: file('f.txt', 1, { extension: 'txt' }) }]);
  const withAtime = build([{ input: file('f.txt', 1, { extension: 'txt', accessedAt: MTIME + 1 }) }]);
  assert.notEqual(canonicalDigest(withAtime), canonicalDigest(without));
  const diff = firstDifference(canonicalLines(without), canonicalLines(withAtime));
  assert.ok(diff);
  assert.equal(diff.a?.split('\t')[5], '-');
  assert.equal(diff.b?.split('\t')[5], String(MTIME + 1));
});

test('names carrying a tab, a newline, a carriage return or a backslash are escaped so every line keeps its ten columns', () => {
  const store = build([
    { input: file('a\tb', 1) },
    { input: file('c\nd', 2) },
    { input: file('e\\f.t\tx', 3, { extension: 't\tx' }) },
    { input: file('g\rh', 4) },
  ]);
  const lines = canonicalLines(store);
  assert.equal(lines.length, 5, 'one line per node: a newline in a name does not become a line');
  for (const line of lines) assert.equal(line.split('\t').length, 10, `ten columns: ${JSON.stringify(line)}`);
  assert.ok(lines.some((l) => l.includes('\ta\\tb\t')), 'the tab is written as \\t');
  assert.ok(lines.some((l) => l.includes('\tc\\nd\t')), 'the newline as \\n');
  assert.ok(lines.some((l) => l.includes('\tg\\rh\t')), 'the carriage return as \\r');
  assert.ok(lines.some((l) => l.includes('\te\\\\f.t\\tx\t') && l.includes('\tt\\tx\t')), 'a backslash doubles, in the extension too');
  // The escaping is injective: the escaped name is not what a different real name would produce.
  const literal = build([{ input: file('a\\tb', 1) }]);
  assert.notEqual(canonicalDigest(literal), canonicalDigest(build([{ input: file('a\tb', 1) }])));
});

test('countersOf reads the eleven counters in the documented order and treats an absent one as zero', () => {
  assert.deepEqual(COUNTER_NAMES, [
    'fileCount', 'dirCount', 'hardlinkedFiles', 'hardlinkedBytes', 'sparseFiles', 'sparseBytes',
    'slackBytes', 'cloudFiles', 'cloudBytes', 'deniedDirs', 'vanishedDirs',
  ]);
  const scan = { fileCount: 3, dirCount: 1, sparseBytes: 4096, deniedDirs: 2 } as ScanResult;
  const counters = countersOf(scan);
  assert.deepEqual(Object.keys(counters), [...COUNTER_NAMES]);
  assert.deepEqual(counters, {
    fileCount: 3, dirCount: 1, hardlinkedFiles: 0, hardlinkedBytes: 0, sparseFiles: 0, sparseBytes: 4096,
    slackBytes: 0, cloudFiles: 0, cloudBytes: 0, deniedDirs: 2, vanishedDirs: 0,
  });
});

test('firstDifference: null for equal arrays, the index and both lines otherwise, a missing tail line is null', () => {
  assert.equal(firstDifference(['x', 'y'], ['x', 'y']), null);
  assert.deepEqual(firstDifference(['x', 'y', 'z'], ['x', 'q', 'z']), { index: 1, a: 'y', b: 'q' });
  assert.deepEqual(firstDifference(['x', 'y'], ['x']), { index: 1, a: 'y', b: null });
  assert.deepEqual(firstDifference(['x'], ['x', 'y']), { index: 1, a: null, b: 'y' });
});
