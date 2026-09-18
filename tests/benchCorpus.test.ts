import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import {
  CORPORA, contentBytes, corpusDir, corpusWorkerEntry, createCorpus, ensureCorpus, manifestFor, planCorpus,
} from '../bench/lib/corpus';
import type { CorpusParams, CorpusPlan } from '../bench/lib/corpus';

/**
 * Task 4 — the corpus generator.
 *
 * A benchmark number means nothing unless the corpus under it is known, so
 * these tests hold the generator to three promises: the plan is a pure
 * function of its parameters (the digest proves it), the files on disk are
 * exactly what the plan says (every path is stat'ed, every duplicate group is
 * read back, every hard link's inode is checked), and the manifest states the
 * truth the engines will be checked against. Every corpus lives under
 * `os.tmpdir()` and is removed by the `after` hook; nothing here ever looks
 * at the owner's real folders.
 *
 * On-disk naming, which the walk below relies on: directory `k` is named
 * `d${dirNameId[k]}` under its parent (directory 0 is the root itself) and
 * file `i` is named `f${i}` inside `dirs[fileDir[i]]`.
 */

const KiB = 1024;
const MiB = 1024 * KiB;
const ROLE = { plain: 0, duplicate: 1, hardlink: 2, sparse: 3 } as const;
const WORKERS = 3;

/** 3,000 entries: every role planted many times over, yet created in well under five seconds. */
const SMALL: CorpusParams = {
  entries: 3000,
  fanout: 8,
  depth: 5,
  flat: 300,
  sizeMedian: 4 * KiB,
  sizeSigma: 1.0,
  sizeMax: MiB,
  duplicateRate: 0.12,
  hardlinkRate: 0.02,
  sparseRate: 0.01,
  seed: 11,
};

/**
 * Planned, never created: 52,800 files. At 2,640 files a Bernoulli draw at
 * 0.12 has a standard deviation of 0.63 points, so "within half a percent"
 * would be a statement about the seed; at 52,800 it is 0.14 points and the
 * band is a statement about the rule.
 */
const RATES: CorpusParams = { ...SMALL, entries: 60_000, fanout: 10, depth: 7, flat: 2000, seed: 5 };

const ENSURE_NAME = `bench-test-${process.pid}`;
const ENSURE_A: CorpusParams = { ...SMALL, entries: 600, flat: 40, seed: 3 };
const ENSURE_B: CorpusParams = { ...ENSURE_A, seed: 4 };

const createdRoots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-test-'));
  createdRoots.push(root);
  return root;
}

function removeUnderTmp(p: string): void {
  assert.ok(p.startsWith(os.tmpdir() + path.sep), `refusing to remove ${p}: it is not under os.tmpdir()`);
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
}

after(() => {
  for (const p of [...createdRoots, corpusDir(ENSURE_NAME, ENSURE_A), corpusDir(ENSURE_NAME, ENSURE_B)]) removeUnderTmp(p);
});

/* ---------------- helpers that read the plan the way the disk will ---------------- */

function dirRel(plan: CorpusPlan, dir: number): string {
  const parts: string[] = [];
  for (let k = dir; k > 0; k = plan.dirParent[k]) parts.push(`d${plan.dirNameId[k]}`);
  return parts.reverse().join(path.sep);
}

function fileIndexOf(p: string): number {
  const m = /^f(\d+)$/.exec(path.basename(p));
  assert.ok(m, `${p} is not a corpus file name`);
  return Number(m[1]);
}

function roleCounts(plan: CorpusPlan): number[] {
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < plan.fileRole.length; i++) counts[plan.fileRole[i]]++;
  return counts;
}

function digestOf(plan: CorpusPlan): string {
  return manifestFor(plan, path.join(os.tmpdir(), 'nowhere'), 'digest-only').planDigest;
}

interface WalkedFile { rel: string; st: fs.Stats }
interface Walked { dirs: number; files: WalkedFile[] }

/** Every entry under `root`, by readdir — the filesystem's account, not the plan's. */
function walk(root: string): Walked {
  const files: WalkedFile[] = [];
  let dirs = 1; // the root itself, as both engines count it
  const visit = (abs: string, rel: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        dirs++;
        visit(childAbs, childRel);
      } else {
        assert.ok(entry.isFile(), `${childRel} is neither a file nor a directory`);
        files.push({ rel: childRel, st: fs.statSync(childAbs) });
      }
    }
  };
  visit(root, '');
  return { dirs, files };
}

/* ---------------- the tests ---------------- */

test('planning is deterministic: same params, same digest; a different seed, a different digest', () => {
  const a = planCorpus(SMALL);
  const b = planCorpus(SMALL);
  const c = planCorpus({ ...SMALL, seed: SMALL.seed + 1 });

  assert.match(digestOf(a), /^[0-9a-f]{64}$/);
  assert.equal(digestOf(a), digestOf(b));
  assert.notEqual(digestOf(a), digestOf(c));

  // the digest is what it claims to be: sha256 over the typed arrays, in declaration order
  const h = createHash('sha256');
  for (const arr of [a.dirParent, a.dirNameId, a.fileDir, a.fileSize, a.fileContent, a.fileRole, a.fileHardlinkOf]) {
    h.update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  }
  assert.equal(digestOf(a), h.digest('hex'));

  // and the arrays agree element for element, not just by hash
  assert.deepEqual(Array.from(a.fileSize), Array.from(b.fileSize));
  assert.deepEqual(Array.from(a.fileRole), Array.from(b.fileRole));
  assert.deepEqual(Array.from(a.dirParent), Array.from(b.dirParent));
  assert.deepEqual(a.params, SMALL);
});

test('the plan has exactly the requested number of entries and honours fanout, depth and flat', () => {
  const plan = planCorpus(SMALL);
  const dirs = plan.dirParent.length;
  const files = plan.fileDir.length;

  assert.equal(dirs + files, SMALL.entries);
  assert.ok(dirs >= SMALL.entries * 0.1 && dirs <= SMALL.entries * 0.14, `${dirs} directories is not about 12% of ${SMALL.entries}`);
  assert.equal(plan.dirNameId.length, dirs);
  assert.equal(plan.fileSize.length, files);
  assert.equal(plan.fileContent.length, files);
  assert.equal(plan.fileRole.length, files);
  assert.equal(plan.fileHardlinkOf.length, files);

  // directory 0 is the root; every other directory hangs off an earlier one, within depth, within fanout
  assert.equal(plan.dirParent[0], -1);
  const childDirs = new Uint32Array(dirs);
  const depth = new Uint32Array(dirs);
  for (let d = 1; d < dirs; d++) {
    const parent = plan.dirParent[d];
    assert.ok(parent >= 0 && parent < d, `directory ${d} has parent ${parent}, which does not precede it`);
    childDirs[parent]++;
    depth[d] = depth[parent] + 1;
  }
  assert.ok(Math.max(...childDirs) <= SMALL.fanout, `a directory has ${Math.max(...childDirs)} subdirectories, more than fanout ${SMALL.fanout}`);
  assert.ok(Math.max(...depth) <= SMALL.depth, `a directory sits at depth ${Math.max(...depth)}, deeper than ${SMALL.depth}`);
  assert.ok(Math.max(...depth) >= 3, 'the tree should actually be a tree, not a bush of one level');

  // the flat directory is the root's first child, holds exactly `flat` files and no subdirectories
  assert.equal(plan.dirParent[1], 0);
  assert.equal(childDirs[1], 0);
  let inFlat = 0;
  const perDir = new Uint32Array(dirs);
  for (let i = 0; i < files; i++) {
    const dir = plan.fileDir[i];
    assert.ok(dir >= 0 && dir < dirs, `file ${i} is in directory ${dir}, which does not exist`);
    perDir[dir]++;
    if (dir === 1) inFlat++;
  }
  assert.equal(inFlat, SMALL.flat);

  // the skew: the rest of the files are not spread evenly — a few directories are large
  const sorted = Array.from(perDir.subarray(2)).sort((x, y) => y - x);
  const topTenth = sorted.slice(0, Math.ceil(sorted.length / 10)).reduce((s, n) => s + n, 0);
  assert.ok(topTenth / (files - SMALL.flat) > 0.2, `the largest tenth of directories holds only ${topTenth} of ${files - SMALL.flat} files`);

  // without a flat directory the count is still exact and nothing claims to be one
  const none = planCorpus({ ...SMALL, flat: 0 });
  assert.equal(none.dirParent.length + none.fileDir.length, SMALL.entries);
  assert.equal(manifestFor(none, path.join(os.tmpdir(), 'nowhere'), 'x').flatDir, null);

  // asking for more flat files than the plan can hold is refused, not silently trimmed
  assert.throws(() => planCorpus({ ...SMALL, flat: SMALL.entries }), RangeError);
  assert.throws(() => planCorpus({ ...SMALL, duplicateRate: 0.7, hardlinkRate: 0.4 }), RangeError);
  assert.throws(() => planCorpus({ ...SMALL, sizeMax: 100.5 }), RangeError, 'a fractional cap would make fractional sizes; refuse it here, not inside a worker');
});

test('planted rates are within half a percent of the request', () => {
  const plan = planCorpus(RATES);
  const files = plan.fileDir.length;
  const counts = roleCounts(plan);
  const rate = (role: number): number => counts[role] / files;

  assert.equal(counts.reduce((s, n) => s + n, 0), files);
  assert.ok(Math.abs(rate(ROLE.duplicate) - RATES.duplicateRate) <= 0.005, `duplicates ${rate(ROLE.duplicate)} vs ${RATES.duplicateRate}`);
  assert.ok(Math.abs(rate(ROLE.hardlink) - RATES.hardlinkRate) <= 0.005, `hard links ${rate(ROLE.hardlink)} vs ${RATES.hardlinkRate}`);
  assert.ok(Math.abs(rate(ROLE.sparse) - RATES.sparseRate) <= 0.005, `sparse ${rate(ROLE.sparse)} vs ${RATES.sparseRate}`);

  // and each role means what the manifest will say it means
  const lastPlainInDir = new Int32Array(plan.dirParent.length).fill(-1);
  const sparseSizes = new Set<number>();
  for (let i = 0; i < files; i++) {
    const role = plan.fileRole[i];
    const dir = plan.fileDir[i];
    if (role === ROLE.plain) {
      assert.equal(plan.fileContent[i], i + 1, 'a plain file gets its own content id, never 0');
      assert.equal(plan.fileHardlinkOf[i], -1);
      assert.ok(plan.fileSize[i] >= KiB && plan.fileSize[i] <= RATES.sizeMax, `plain size ${plan.fileSize[i]}`);
      assert.ok(Number.isInteger(plan.fileSize[i]));
      lastPlainInDir[dir] = i;
    } else if (role === ROLE.duplicate) {
      const target = plan.fileContent[i] - 1;
      assert.ok(target >= 0 && target < i, `duplicate ${i} copies ${target}, which is not an earlier file`);
      assert.equal(plan.fileRole[target], ROLE.plain, 'a duplicate copies a plain file');
      assert.equal(plan.fileSize[i], plan.fileSize[target]);
      assert.equal(plan.fileHardlinkOf[i], -1);
    } else if (role === ROLE.hardlink) {
      const target = plan.fileHardlinkOf[i];
      assert.equal(target, lastPlainInDir[dir], `hard link ${i} must target the most recent plain file in its directory`);
      assert.equal(plan.fileDir[target], dir);
      assert.equal(plan.fileContent[i], plan.fileContent[target]);
      assert.equal(plan.fileSize[i], plan.fileSize[target]);
    } else {
      assert.equal(role, ROLE.sparse);
      assert.equal(plan.fileContent[i], 0, 'a sparse file holds no content');
      assert.equal(plan.fileHardlinkOf[i], -1);
      assert.ok(plan.fileSize[i] >= 8 * MiB && plan.fileSize[i] < 64 * MiB, `sparse logical size ${plan.fileSize[i]}`);
      assert.ok(!sparseSizes.has(plan.fileSize[i]), 'two sparse files with one logical size would be byte-identical zeros — an unplanted duplicate');
      sparseSizes.add(plan.fileSize[i]);
    }
  }
});

test('files that share a content id are byte-identical and files that differ do not', () => {
  const a = contentBytes(7, 4096);
  const b = contentBytes(7, 4096);
  const c = contentBytes(8, 4096);
  const d = contentBytes(7, 4095);

  assert.equal(a.length, 4096);
  assert.ok(a.equals(b), 'the same content id and size must give the same bytes');
  assert.ok(!a.equals(c), 'a different content id must give different bytes');
  assert.equal(d.length, 4095);
  assert.ok(!a.subarray(0, 4095).equals(d), 'a different size must give a different stream, not a prefix of the same one');

  // distinct ids never collide at one size — a guarantee, not a probability
  const seen = new Set<string>();
  for (let id = 1; id <= 2000; id++) {
    const key = contentBytes(id, KiB).toString('base64');
    assert.ok(!seen.has(key), `content id ${id} produced the bytes of an earlier id`);
    seen.add(key);
  }

  // odd sizes are filled to the last byte, and no plain file reads as the zeros a sparse file reads as
  const odd = contentBytes(3, 13);
  assert.equal(odd.length, 13);
  assert.ok(odd.subarray(8).some((x) => x !== 0));
  assert.ok(contentBytes(1, 4096).some((x) => x !== 0));
  assert.equal(contentBytes(9, 0).length, 0);

  // the guarantee holds from 4 bytes up; below that there are fewer possible outputs than ids (pigeonhole), so it cannot
  assert.ok(!contentBytes(1, 4).equals(contentBytes(257, 4)), 'ids that share their low byte still differ at 4 bytes');
  assert.ok(!contentBytes(1, 5).equals(contentBytes(65537, 5)));
  assert.ok(contentBytes(1, 1).equals(contentBytes(257, 1)), 'one byte cannot tell 2^32 ids apart; the contract starts at 4 bytes');
});

test('same-size non-duplicates exist so the size bucket stage has work to do', () => {
  const plan = planCorpus(SMALL);
  const frequency = new Map<number, number>();
  let plain = 0;
  for (let i = 0; i < plan.fileRole.length; i++) {
    if (plan.fileRole[i] !== ROLE.plain) continue;
    plain++;
    frequency.set(plan.fileSize[i], (frequency.get(plan.fileSize[i]) ?? 0) + 1);
  }
  let sharing = 0;
  for (let i = 0; i < plan.fileRole.length; i++) {
    if (plan.fileRole[i] !== ROLE.plain) continue;
    if ((frequency.get(plan.fileSize[i]) ?? 0) >= 2) sharing++;
    if (plan.fileSize[i] < 64 * KiB) assert.equal(plan.fileSize[i] % KiB, 0, `size ${plan.fileSize[i]} is not on a 1 KiB step`);
  }
  assert.ok(sharing / plain >= 0.1, `only ${sharing} of ${plain} plain files share a size with another plain file`);
  assert.ok(frequency.size >= 10, `only ${frequency.size} distinct sizes — the log-normal is not doing its job`);
});

test('createCorpus writes what the plan says and the manifest states the truth', async (t) => {
  const root = tmpRoot();
  const plan = planCorpus(SMALL);
  const files = plan.fileDir.length;
  const counts = roleCounts(plan);

  const t0 = performance.now();
  const manifest = await createCorpus(root, plan, { workers: WORKERS, name: 'small' });
  const elapsedMs = performance.now() - t0;
  t.diagnostic(`createCorpus: ${SMALL.entries} entries (${files} files, ${counts[ROLE.hardlink]} hard links, ${counts[ROLE.sparse]} sparse) in ${elapsedMs.toFixed(0)} ms with ${WORKERS} workers`);
  assert.ok(elapsedMs < 5000, `creating ${SMALL.entries} entries took ${elapsedMs.toFixed(0)} ms`);

  // the fixture must exercise the deferred path: a hard link whose target another worker created
  const chunkOf = (i: number): number => Math.floor((i * WORKERS) / files);
  let crossChunk = 0;
  for (let i = 0; i < files; i++) {
    if (plan.fileRole[i] === ROLE.hardlink && chunkOf(plan.fileHardlinkOf[i]) !== chunkOf(i)) crossChunk++;
  }
  assert.ok(crossChunk > 0, 'no hard link targets a file in another worker chunk; the fixture proves nothing about the deferred links');

  // the manifest describes this corpus
  assert.equal(manifest.name, 'small');
  assert.equal(manifest.root, fs.realpathSync(root));
  assert.deepEqual(manifest.params, SMALL);
  assert.equal(manifest.planDigest, digestOf(plan));
  assert.equal(manifest.dirs, plan.dirParent.length);
  assert.equal(manifest.files, files);
  assert.ok(!Number.isNaN(Date.parse(manifest.createdAt)));
  assert.equal(manifest.flatDir, path.join(manifest.root, 'd1'));
  assert.equal(fs.readdirSync(manifest.flatDir!).length, SMALL.flat);
  assert.ok(!fs.existsSync(path.join(root, 'manifest.json')), 'the tree holds the corpus and nothing else');

  // the filesystem's account: every entry the plan describes, nothing more, each where it belongs, at its size
  const walked = walk(root);
  assert.equal(walked.dirs, manifest.dirs);
  assert.equal(walked.files.length, manifest.files);
  const seenIndex = new Set<number>();
  const sizeByInode = new Map<number, number>();
  let sparseUnchecked = 0; // Node does not expose allocated blocks on Windows, so the sparse check is stated as skipped there
  for (const { rel, st } of walked.files) {
    const i = fileIndexOf(rel);
    assert.ok(i >= 0 && i < files && !seenIndex.has(i), `unexpected or repeated file ${rel}`);
    seenIndex.add(i);
    const parent = path.dirname(rel) === '.' ? '' : path.dirname(rel);
    assert.equal(parent, dirRel(plan, plan.fileDir[i]), `${rel} is not in the directory the plan gave it`);
    assert.equal(st.size, plan.fileSize[i], `${rel} has size ${st.size}, the plan said ${plan.fileSize[i]}`);
    sizeByInode.set(st.ino, st.size);
    if (plan.fileRole[i] === ROLE.sparse) {
      if (process.platform === 'win32') sparseUnchecked++;
      else assert.equal(st.blocks, 0, `sparse ${rel} has ${st.blocks} blocks allocated`);
    }
  }

  if (sparseUnchecked > 0) t.diagnostic(`${sparseUnchecked} sparse files were not checked for zero allocated blocks: Node does not expose stats.blocks on Windows`);

  // hard links: one inode per family, nlink counts every name, and the manifest lists every planted link
  let linkNames = 0;
  const targets = new Set<string>();
  for (const family of manifest.hardlinkFamilies) {
    assert.ok(!targets.has(family.target));
    targets.add(family.target);
    const target = fs.statSync(family.target);
    assert.equal(target.nlink, 1 + family.links.length, `${family.target} should have ${1 + family.links.length} names`);
    for (const link of family.links) {
      const st = fs.statSync(link);
      assert.equal(st.ino, target.ino, `${link} is not the same inode as ${family.target}`);
      assert.equal(path.dirname(link), path.dirname(family.target), 'a hard link lives beside its target');
      linkNames++;
    }
  }
  assert.equal(linkNames, counts[ROLE.hardlink]);

  // sparse files: exactly the planted ones, at their logical size
  assert.equal(manifest.sparseFiles.length, counts[ROLE.sparse]);
  for (const sparse of manifest.sparseFiles) {
    const i = fileIndexOf(sparse.path);
    assert.equal(plan.fileRole[i], ROLE.sparse);
    assert.equal(sparse.logicalSize, plan.fileSize[i]);
    assert.equal(fs.statSync(sparse.path).size, sparse.logicalSize);
  }

  // duplicate groups: byte-identical throughout, distinct inodes, sorted by content id, every planted duplicate present
  const grouped = new Set<number>();
  let previousContent = -1;
  for (const group of manifest.duplicateGroups) {
    assert.ok(group.content > previousContent, 'groups are sorted by content id and never repeat one');
    previousContent = group.content;
    assert.ok(group.paths.length >= 2);
    const first = fs.readFileSync(group.paths[0]);
    assert.equal(first.length, group.size);
    assert.ok(first.equals(contentBytes(group.content, group.size)), 'a group holds the bytes its content id promises');
    const inodes = new Set<number>();
    for (const p of group.paths) {
      const st = fs.statSync(p);
      assert.ok(!inodes.has(st.ino), `${p} is a hard link, not a duplicate`);
      inodes.add(st.ino);
      assert.ok(fs.readFileSync(p).equals(first), `${p} differs from ${group.paths[0]}`);
      const i = fileIndexOf(p);
      assert.ok(plan.fileRole[i] === ROLE.plain || plan.fileRole[i] === ROLE.duplicate);
      grouped.add(i);
    }
  }
  for (let i = 0; i < files; i++) {
    if (plan.fileRole[i] === ROLE.duplicate) assert.ok(grouped.has(i), `planted duplicate ${i} is in no group`);
    if (plan.fileRole[i] === ROLE.hardlink) assert.ok(!grouped.has(i), `hard link ${i} must not be listed as a duplicate`);
  }

  // and no unplanned duplicates: hash every non-sparse inode's bytes; the identical sets are exactly the groups
  const byHash = new Map<string, number[]>();
  for (const { rel, st } of walked.files) {
    const i = fileIndexOf(rel);
    if (plan.fileRole[i] === ROLE.sparse || plan.fileRole[i] === ROLE.hardlink) continue;
    const hash = createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
    byHash.set(hash, [...(byHash.get(hash) ?? []), i]);
    if (plan.fileRole[i] === ROLE.plain) {
      assert.ok(fs.readFileSync(path.join(root, rel)).equals(contentBytes(plan.fileContent[i], plan.fileSize[i])), `${rel} does not hold contentBytes(${plan.fileContent[i]}, ${plan.fileSize[i]})`);
    }
    void st;
  }
  const identicalSets = [...byHash.values()].filter((members) => members.length >= 2).map((members) => members.sort((x, y) => x - y).join(','));
  const plantedSets = manifest.duplicateGroups.map((g) => g.paths.map(fileIndexOf).sort((x, y) => x - y).join(','));
  assert.deepEqual(identicalSets.sort(), plantedSets.sort());

  // logical bytes: the sum over distinct inodes — plain, duplicate and sparse sizes once each, hard-link names nothing
  let logical = 0;
  for (const size of sizeByInode.values()) logical += size;
  assert.equal(manifest.logicalBytes, logical);
  assert.ok(manifest.logicalBytes > counts[ROLE.sparse] * 8 * MiB, 'sparse logical sizes are counted');
});

test('ensureCorpus reuses a corpus whose manifest matches and rebuilds one whose params changed', async () => {
  const dir = corpusDir(ENSURE_NAME, ENSURE_A);
  assert.ok(dir.startsWith(path.join(os.tmpdir(), 'treemap-bench') + path.sep));
  assert.match(path.basename(dir), new RegExp(`^${ENSURE_NAME}-[0-9a-f]{8}$`));
  assert.equal(corpusDir(ENSURE_NAME, { ...ENSURE_A }), dir, 'equal params name the same directory');
  assert.notEqual(corpusDir(ENSURE_NAME, ENSURE_B), dir, 'different params name a different directory');

  const first = await ensureCorpus(ENSURE_NAME, ENSURE_A);
  assert.equal(first.name, ENSURE_NAME);
  assert.equal(first.root, fs.realpathSync(path.join(dir, 'tree')));
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
  assert.equal(walk(first.root).files.length, first.files);

  // a matching manifest is reused: the same createdAt comes back and nothing is rewritten
  const sentinel = path.join(dir, 'tree', 'sentinel-not-in-the-plan');
  fs.writeFileSync(sentinel, 'if this survives, the corpus was reused');
  const again = await ensureCorpus(ENSURE_NAME, ENSURE_A);
  assert.deepEqual(again, first);
  assert.ok(fs.existsSync(sentinel), 'a matching corpus must be reused, not rebuilt');

  // a stale manifest (the params on disk differ from the request) forces a rebuild from scratch
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...first, params: { ...ENSURE_A, seed: 99 } }));
  const rebuilt = await ensureCorpus(ENSURE_NAME, ENSURE_A);
  assert.ok(!fs.existsSync(sentinel), 'a stale corpus must be removed before it is rebuilt');
  assert.equal(rebuilt.planDigest, first.planDigest);
  assert.deepEqual(rebuilt.params, ENSURE_A);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')), rebuilt);

  // a manifest whose digest no longer matches what the planner produces is not trusted either
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...rebuilt, planDigest: '0'.repeat(64) }));
  fs.writeFileSync(sentinel, 'stale');
  const replanned = await ensureCorpus(ENSURE_NAME, ENSURE_A);
  assert.ok(!fs.existsSync(sentinel));
  assert.equal(replanned.planDigest, first.planDigest);

  // changed params: a different directory, a different corpus
  const other = await ensureCorpus(ENSURE_NAME, ENSURE_B);
  assert.equal(path.dirname(other.root), fs.realpathSync(corpusDir(ENSURE_NAME, ENSURE_B)));
  assert.notEqual(other.planDigest, first.planDigest);
  assert.ok(fs.existsSync(first.root), 'building another corpus leaves the first alone');
});

test('the presets are the ones the plan names and plan within budget', (t) => {
  // Windows plants no sparse files (the generator only ftruncates, which NTFS
  // does not treat as sparse), so every preset's sparse rate is 0 there.
  const sparseRate = process.platform === 'win32' ? 0 : 0.001;
  assert.deepEqual(CORPORA.enum200k, { entries: 200_000, fanout: 12, depth: 8, flat: 10_000, sizeMedian: 1024, sizeSigma: 1.2, sizeMax: 2 * MiB, duplicateRate: 0, hardlinkRate: 0.01, sparseRate, seed: 2 });
  assert.deepEqual(CORPORA.enum1m, { ...CORPORA.enum200k, entries: 1_000_000, seed: 4 });
  assert.deepEqual(CORPORA.dupes100k, { entries: 112_000, fanout: 10, depth: 6, flat: 0, sizeMedian: 8192, sizeSigma: 1.6, sizeMax: 64 * MiB, duplicateRate: 0.12, hardlinkRate: 0.005, sparseRate, seed: 3 });

  for (const [name, params] of Object.entries(CORPORA)) {
    const t0 = performance.now();
    const plan = planCorpus(params);
    const ms = performance.now() - t0;
    t.diagnostic(`planCorpus(${name}): ${params.entries.toLocaleString('en-US')} entries in ${ms.toFixed(0)} ms, ${plan.dirParent.length.toLocaleString('en-US')} directories`);
    assert.equal(plan.dirParent.length + plan.fileDir.length, params.entries);
    assert.ok(plan.dirParent.length >= params.entries * 0.1, `${name}: the tree ran out of room at ${plan.dirParent.length} directories`);
    assert.ok(ms < 5000, `${name}: planning took ${ms.toFixed(0)} ms`);
    if (params.flat > 0) {
      let inFlat = 0;
      for (let i = 0; i < plan.fileDir.length; i++) if (plan.fileDir[i] === 1) inFlat++;
      assert.equal(inFlat, params.flat);
    }
  }
});

test('a plan whose arrays disagree is refused, so a wrong plan can never become a corpus', async () => {
  const { planCorpus, assertConsistentPlan } = await import('../bench/lib/corpus');
  const plan = planCorpus({ entries: 300, fanout: 4, depth: 3, flat: 0, sizeMedian: 512, sizeSigma: 1, sizeMax: 8192, duplicateRate: 0.1, hardlinkRate: 0.05, sparseRate: 0.01, seed: 21 });
  assertConsistentPlan(plan);
  const short = { ...plan, fileSize: plan.fileSize.slice(0, plan.fileSize.length - 1) };
  assert.throws(() => assertConsistentPlan(short), /length/);
  const badLink = { ...plan, fileHardlinkOf: Int32Array.from(plan.fileHardlinkOf) };
  const linkIndex = Array.from(plan.fileRole).findIndex((r) => r === 2);
  assert.ok(linkIndex >= 0, 'the plan has a hard link');
  badLink.fileHardlinkOf[linkIndex] = -1;
  assert.throws(() => assertConsistentPlan(badLink), /hard link/);
});

test('the plan digest changes when any planned value changes', async () => {
  const { planCorpus, planDigest } = await import('../bench/lib/corpus');
  const params = { entries: 300, fanout: 4, depth: 3, flat: 0, sizeMedian: 512, sizeSigma: 1, sizeMax: 8192, duplicateRate: 0.1, hardlinkRate: 0.05, sparseRate: 0.01, seed: 22 };
  const a = planCorpus(params);
  const b = planCorpus(params);
  assert.equal(planDigest(a), planDigest(b));
  const c = planCorpus(params);
  c.fileSize[7] += 1;
  assert.notEqual(planDigest(c), planDigest(a), 'one changed size changes the digest');
  const d = planCorpus(params);
  d.fileContent[3] = d.fileContent[3] === 1 ? 2 : 1;
  assert.notEqual(planDigest(d), planDigest(a), 'one changed content id changes the digest');
});

test('the presets name every corpus the CLI can ask for, and plant no sparse files on Windows', async () => {
  const { CORPORA } = await import('../bench/lib/corpus');
  for (const name of ['smoke', 'ci20k', 'enum200k', 'enum1m', 'dupes100k'] as const) assert.ok(name in CORPORA, name);
  assert.ok(CORPORA.smoke.entries <= 2_000);
  assert.ok(CORPORA.smoke.duplicateRate > 0, 'the smoke corpus exercises the duplicate finder');
  if (process.platform === 'win32') for (const p of Object.values(CORPORA)) assert.equal(p.sparseRate, 0);
});

test('a reused corpus is checked, not trusted: a manifest whose root moved or whose files vanished is rebuilt', async () => {
  const { ensureCorpus, corpusDir } = await import('../bench/lib/corpus');
  const params = { entries: 200, fanout: 4, depth: 3, flat: 0, sizeMedian: 512, sizeSigma: 1, sizeMax: 8192, duplicateRate: 0.1, hardlinkRate: 0, sparseRate: 0, seed: 23 };
  const name = 'reusecheck';
  const first = await ensureCorpus(name, params);
  const manifestFile = path.join(corpusDir(name, params), 'manifest.json');
  const tampered = { ...first, root: os.homedir() };
  fs.writeFileSync(manifestFile, JSON.stringify(tampered));
  const second = await ensureCorpus(name, params);
  assert.notEqual(second.root, os.homedir(), 'a root outside the corpus directory is never adopted');
  fs.rmSync(second.duplicateGroups[0]?.paths[0] ?? path.join(second.root, 'd0'), { force: true, recursive: true });
  const third = await ensureCorpus(name, params);
  for (const g of third.duplicateGroups) for (const p of g.paths) assert.ok(fs.existsSync(p), `rebuilt: ${p}`);
  fs.rmSync(corpusDir(name, params), { recursive: true, force: true });
});

test('the corpus worker entry loads in a worker thread that inherited no loader hooks, as on Node 20', async () => {
  // Node 20 does not hand tsx's --import hook to worker threads (Node 22 and
  // later do), which is why a .ts worker entry passed locally on Node 24 and
  // failed every CI leg with ERR_UNKNOWN_FILE_EXTENSION. Starting the entry
  // with an empty execArgv is the same situation on every Node version: the
  // entry must be able to load itself.
  const job = {
    start: 0, end: 0, dirPaths: [] as string[],
    fileDir: new Int32Array(0), fileSize: new Float64Array(0), fileContent: new Uint32Array(0),
    fileRole: new Uint8Array(0), fileHardlinkOf: new Int32Array(0),
  };
  const reply = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(corpusWorkerEntry(), { execArgv: [], workerData: job });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => reject(new Error(`worker exited with ${code} before replying`)));
  });
  assert.deepEqual(reply, { ok: true, written: 0, bytes: 0, deferredLinks: 0 });
});
