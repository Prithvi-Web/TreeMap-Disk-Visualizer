import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as NativeCore from '../native/index';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-nativeMemoryPath-data-');

import { skipOrFailOnCi } from './fixtures/ciSkip';
import { buildEdgeFixture, unlockAndRemove } from './fixtures/nativeEdge';
import { CORPORA, ensureCorpus } from '../bench/lib/corpus';
import { loadNative, resetNativeForTests, type ScanModule } from '../src/services/scan/native';
import { rootName, runNativeWalk, type NativeStorage } from '../src/services/scan/nativeEngine';
import { adoptNativeStore } from '../src/services/scan/nativeMemory';
import { statToInput } from '../src/services/scan/nodeInput';
import { Flag, PackedScanStore } from '../src/services/scanStore';
import type { PruneOptions } from '../src/utils/pruneTree';
import { createScanRecord } from '../src/services/diskScanner';
import { platform } from '../src/platform';
import type { ScanResult } from '../src/models/types';

/**
 * Phase 4 T8c: the native engine's memory path — `scanStart` with `storage:
 * 'memory'`, `storeTake`, `PackedScanStore.adoptColumns`, and Node's passes
 * over what the native build left to it (text candidates, cloud candidates,
 * the byte totals in breadth-first order, refused folders, the counters) —
 * against the columns path (`scanTake` + `ingestColumns`), the oracle: the
 * same tree must give the same pruned JSON byte for byte and the same scan
 * record, field for field, unset where the oracle leaves a field unset.
 */

const REPO = path.join(__dirname, '..');
const PREBUILT_MODULE = path.join(REPO, 'native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node');
const BLOCKS_ARE_MEANINGFUL = platform().blocksAreMeaningful;

/** Every field of the scan record either path fills. */
const RECORD_FIELDS = [
  'scanned', 'fileCount', 'dirCount', 'walkedDirs', 'cachedDirs', 'hardlinkedFiles', 'hardlinkedBytes',
  'sparseFiles', 'sparseBytes', 'slackBytes', 'cloudFiles', 'cloudBytes', 'deniedDirs', 'deniedExamples',
  'vanishedDirs', 'unreadableDirs', 'deniedEntries', 'unreadableEntries', 'placeholdersSkipped',
] as const;

const PRUNES: PruneOptions[] = [{ maxNodes: Number.MAX_SAFE_INTEGER }, { maxNodes: 12 }, { maxNodes: 4 }];

function loadCore(t: TestContext): ScanModule | null {
  const file = process.env.TREEMAP_NATIVE_MODULE ?? PREBUILT_MODULE;
  if (!fs.existsSync(file)) {
    skipOrFailOnCi(t, `no native module at ${file}; build it with npm run build:native`);
    return null;
  }
  resetNativeForTests();
  const r = loadNative({ path: file });
  if (!r.available) assert.fail(r.reason);
  return r.module as unknown as ScanModule;
}

function rootInput(root: string) {
  const st = fs.lstatSync(root);
  return statToInput(rootName(root), true, 0, st.mtimeMs, st.atimeMs);
}

interface Walked {
  scan: ScanResult;
  store: PackedScanStore;
}

async function walk(core: ScanModule, root: string, storage: NativeStorage): Promise<Walked> {
  const scan = createScanRecord(root);
  const store = new PackedScanStore(root, path.sep, rootInput(root));
  await runNativeWalk(scan, store, root, core, storage);
  return { scan, store };
}

/** A pruned tree as the API emits it, access times scrubbed (the two walks read them apart; presence still compares). */
function prunedJson(store: PackedScanStore, opts: PruneOptions): string {
  return JSON.stringify(store.prune(store.rootId, opts).root).replace(/"accessedAt":\d+/g, '"accessedAt":1');
}

function record(scan: ScanResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of RECORD_FIELDS) out[k] = scan[k];
  return out;
}

function assertSame(memory: Walked, columns: Walked, what: string): void {
  for (const opts of PRUNES) {
    assert.equal(prunedJson(memory.store, opts), prunedJson(columns.store, opts), `${what}: the pruned JSON at ${JSON.stringify(opts)}`);
  }
  assert.deepEqual(record(memory.scan), record(columns.scan), `${what}: the scan record`);
}

test('the memory path gives the columns path\'s tree byte for byte and its record field for field, on the edge fixture', async (t) => {
  const core = loadCore(t);
  if (!core) return;
  const { root, locked } = await buildEdgeFixture('treemap-native-memory-');
  try {
    const columns = await walk(core, root, 'columns');
    const memory = await walk(core, root, 'memory');
    assertSame(memory, columns, 'the edge fixture');
    // The fixture reached every pass: a name Node decides (résumé.txt, party 🎉.txt),
    // and the cloud rule on a file that claims bytes with none allocated.
    const json = prunedJson(memory.store, PRUNES[0]);
    assert.match(json, /"name":"résumé\.txt"[^{}]*"extension":"txt"/);
    assert.match(json, /"name":"deep\.TAR\.GZ"[^{}]*"container":"tgz"/);
    if (fs.lstatSync(path.join(root, 'vm', 'disk.img')).blocks === 0 && BLOCKS_ARE_MEANINGFUL) {
      assert.ok((memory.scan.sparseFiles ?? 0) >= 1, 'the unallocated VM image is a sparse guess Node counted');
    }
  } finally {
    await unlockAndRemove(root, locked);
  }
});

test('the memory path gives the columns path\'s tree on a wide tree the workers number out of breadth-first order', async (t) => {
  const core = loadCore(t);
  if (!core) return;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-native-memory-wide-'));
  try {
    for (let d = 0; d < 40; d++) {
      const dir = path.join(root, `d${String(d).padStart(3, '0')}`);
      await fsp.mkdir(path.join(dir, 'inner'), { recursive: true });
      for (let f = 0; f < 12; f++) await fsp.writeFile(path.join(dir, `f${f}.bin`), Buffer.alloc(f * 37 + d));
      await fsp.writeFile(path.join(dir, 'inner', 'leaf.txt'), 'x');
    }
    await fsp.link(path.join(root, 'd000', 'f5.bin'), path.join(root, 'd039', 'twin.bin'));
    const columns = await walk(core, root, 'columns');
    const memory = await walk(core, root, 'memory');
    assertSame(memory, columns, 'the wide tree');
    assert.equal(memory.scan.hardlinkedFiles, 1, 'the cross-folder pair has one duplicate');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the memory path gives the columns path\'s tree on the ci20k corpus', async (t) => {
  const core = loadCore(t);
  if (!core) return;
  // Built once under its own name, where every ensureCorpus corpus lives, and kept for the next run.
  const corpus = await ensureCorpus('memory-path-ci20k', CORPORA.ci20k);
  const columns = await walk(core, corpus.root, 'columns');
  const memory = await walk(core, corpus.root, 'memory');
  assertSame(memory, columns, 'ci20k');
  assert.equal(memory.scan.scanned, corpus.dirs + corpus.files, 'the whole corpus: every folder, the root included, and every name');
  assert.equal(memory.scan.hardlinkedFiles, corpus.hardlinkFamilies.reduce((sum, family) => sum + family.links.length, 0), 'every extra name of a hard-linked file');
});

test('the memory path gives the columns path\'s tree where names are not UTF-8', { skip: process.platform !== 'linux' && 'only Linux\'s file systems take a name that is not UTF-8' }, async (t) => {
  const core = loadCore(t);
  if (!core) return;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-native-memory-bytes-'));
  const raw = (...parts: Array<string | number[]>): Buffer => Buffer.concat([
    Buffer.from(root + path.sep),
    ...parts.map((part) => (typeof part === 'string' ? Buffer.from(part) : Buffer.from(part))),
  ]);
  try {
    // 0xF8 and 0xFF are never UTF-8: each name is stored with U+FFFD in its place.
    fs.mkdirSync(raw('d', [0xff]));
    fs.writeFileSync(raw('d', [0xff], '/inner.txt'), 'abc');
    fs.writeFileSync(raw('a', [0xf8], '.txt'), 'abcd');
    fs.writeFileSync(raw('a', [0xf9], '.TAR'), 'ab');
    fs.writeFileSync(raw('plain.txt'), 'a');
    const columns = await walk(core, root, 'columns');
    const memory = await walk(core, root, 'memory');
    assertSame(memory, columns, 'names that are not UTF-8');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------ Node's passes, on stores built by hand ------------------------------ */

/** The names `handBuilt` gives its rows, the folder `a` under an iCloud folder's name when `cloudy`. */
function rowNames(cloudy: boolean): string[] {
  return ['r', cloudy ? 'com~apple~CloudDocs' : 'a', 'b', 'b3.img', 'b4.img', 'a5.img', 'a6.img'];
}

/**
 * A store as the native build hands it over, for a tree whose ids are not
 * breadth-first: the root (0) holds folders `a` (1) and `b` (2); `b`'s block
 * was reserved first, so its files are 3 and 4, and `a`'s are 5 and 6.
 * Breadth-first the files come a5, a6, b3, b4.
 */
function handBuilt(over: Partial<NativeCore.NativeStore> = {}, names: string[] = rowNames(false)): NativeCore.NativeStore {
  const capacity = 9;
  const encoder = new TextEncoder();
  const encoded = names.map((name) => encoder.encode(name));
  const nameOff = new Uint32Array(capacity + 1);
  let at = 0;
  encoded.forEach((bytes, id) => {
    nameOff[id] = at;
    at += bytes.length;
  });
  for (let id = names.length; id <= capacity; id++) nameOff[id] = at;
  const pool = new Uint8Array(at + 4);
  encoded.forEach((bytes, id) => pool.set(bytes, nameOff[id]));
  const column = <T extends { set(values: ArrayLike<number>): void }>(make: (n: number) => T, rows: number[]): T => {
    const out = make(capacity);
    out.set(rows);
    return out;
  };
  const dir = Flag.Dir | Flag.HasChildArray;
  return {
    n: names.length,
    capacity,
    parent: column((n) => new Int32Array(n), [-1, 0, 0, 2, 2, 1, 1]),
    size: column((n) => new Float64Array(n), [0, 0, 0, 3, 4, 5, 6]),
    mtime: column((n) => new Float64Array(n), [1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000]),
    flags: column((n) => new Uint16Array(n), [dir, dir, dir, 0, 0, 0, 0]),
    ext: column((n) => new Uint16Array(n), [0, 0, 0, 1, 1, 1, 1]),
    container: new Uint8Array(capacity),
    cloudProv: new Uint8Array(capacity),
    nameOff,
    names: pool,
    namesLen: at,
    childStart: column((n) => new Uint32Array(n), [1, 5, 3, 7, 7, 7, 7]),
    childCnt: column((n) => new Uint32Array(n), [2, 2, 2, 0, 0, 0, 0]),
    extDict: ['', 'img'],
    extOverflowIds: new Uint32Array(0),
    extOverflowTexts: [],
    cloudCandidates: new Uint32Array(0),
    textCandidates: new Uint32Array(0),
    sparseTermIds: new Uint32Array(0),
    sparseTermBytes: new Float64Array(0),
    counters: {
      dirs: 3, files: 4, hardlinkedFiles: 0, hardlinkedBytes: 0, cloudFiles: 0, cloudBytes: 0,
      sparseFiles: 0, sparseBytes: 0, slackBytes: 0, deniedDirs: [], vanishedDirs: 0, unreadableDirs: 0,
    },
    stats: {
      dirsListed: 3, entries: 6, wallMs: 1, cpuSeconds: null, fastPath: 'bulk', workersPeak: 1, climbSteps: 0,
      deniedEntries: 0, unreadableEntries: 0, dataless: 0,
    },
    ...over,
  };
}

function adopted(taken: NativeCore.NativeStore): Walked {
  const root = '/Users/someone/r';
  const scan = createScanRecord(root);
  const store = new PackedScanStore(root, '/', statToInput('r', true, 0, 1_000));
  adoptNativeStore(scan, store, taken);
  return { scan, store };
}

test('the byte totals past 2^53 are summed in breadth-first order, the terms and Node\'s own guesses interleaved (RISKS R91)', { skip: !BLOCKS_ARE_MEANINGFUL && 'no sparse account where blocks mean nothing' }, () => {
  // Breadth-first: a5 (a term of 1), a6 (a guess Node counts, 1 byte), b3 (a term of
  // 2^53). From 0 in that order the sum is exact: 2^53 + 2. In id order — b3 first —
  // each 1 would round away, leaving 2^53.
  const size = new Float64Array(9);
  size.set([0, 0, 0, 2 ** 53, 4, 1, 1]);
  const { scan } = adopted(handBuilt({
    size,
    sparseTermIds: new Uint32Array([5, 3]),
    sparseTermBytes: new Float64Array([1, 2 ** 53]),
    cloudCandidates: new Uint32Array([6]),
    counters: { ...handBuilt().counters, sparseFiles: 2, sparseBytes: 2 ** 53 + 1 },
  }));
  assert.equal(scan.sparseFiles, 3, 'the two the build counted and Node\'s guess');
  assert.equal(scan.sparseBytes, 2 ** 53 + 2);
});

test('the cloud rule: a guess under a provider\'s folder becomes a placeholder, the walk\'s own placeholder gets its provider, and cloudBytes is summed in list order from 0', () => {
  const flags = new Uint16Array(9);
  const dir = Flag.Dir | Flag.HasChildArray;
  flags.set([dir, dir, dir, 0, 0, Flag.CloudPlaceholder, 0]);
  const { scan, store } = adopted(handBuilt({
    flags,
    cloudCandidates: new Uint32Array([5, 6]),
    counters: { ...handBuilt().counters, cloudFiles: 1, cloudBytes: 5 },
  }, rowNames(true)));
  assert.equal(store.cloudProvider(5), 'icloud', 'the walk\'s own placeholder gets the provider its path names');
  assert.equal(store.flag(6, Flag.CloudPlaceholder), true, 'the guess under the iCloud folder is a placeholder');
  assert.equal(store.cloudProvider(6), 'icloud');
  assert.equal(scan.cloudFiles, 2);
  assert.equal(scan.cloudBytes, 11, 'recomputed from 0: 5 + 6, never added onto the build\'s own');
  assert.equal(scan.sparseFiles, undefined, 'a placeholder is not sparse, and nothing else was');
});

test('a guess with no provider is sparse where blocks mean something, unless it is a later name of a hard-linked file', { skip: !BLOCKS_ARE_MEANINGFUL && 'no sparse account where blocks mean nothing' }, () => {
  const flags = new Uint16Array(9);
  const dir = Flag.Dir | Flag.HasChildArray;
  flags.set([dir, dir, dir, 0, Flag.HardlinkDup, 0, 0]);
  const { scan } = adopted(handBuilt({
    flags,
    cloudCandidates: new Uint32Array([5, 3, 4]),
    counters: { ...handBuilt().counters, hardlinkedFiles: 1, hardlinkedBytes: 4 },
  }));
  assert.equal(scan.sparseFiles, 2, 'a5 and b3; b4 is a duplicate');
  assert.equal(scan.sparseBytes, 8);
  assert.equal(scan.cloudFiles, undefined, 'nothing became a placeholder');
  assert.equal(scan.hardlinkedFiles, 1);
  assert.equal(scan.hardlinkedBytes, 4);
});

test('a text candidate\'s extension and container are statToInput\'s, and counters nothing counted stay unset', () => {
  // The build leaves a name with a non-ASCII byte and a dot at no extension and no
  // container: Node lower-cases it by its own rules.
  const ext = new Uint16Array(9);
  ext.set([0, 0, 0, 0, 1, 1, 1]);
  const names = rowNames(false);
  names[3] = 'böx.TAR.GZ';
  const { scan, store } = adopted(handBuilt({ ext, textCandidates: new Uint32Array([3]) }, names));
  assert.equal(store.extension(3), 'gz');
  assert.equal(store.container(3), 'tgz');
  for (const field of ['hardlinkedFiles', 'hardlinkedBytes', 'cloudFiles', 'cloudBytes', 'sparseFiles', 'sparseBytes', 'slackBytes', 'deniedDirs', 'vanishedDirs', 'unreadableDirs'] as const) {
    assert.equal(scan[field], undefined, `${field} stays unset when nothing was counted`);
  }
  assert.equal(scan.dirCount, 3);
  assert.equal(scan.fileCount, 4);
  assert.equal(scan.scanned, 7);
  assert.equal(scan.walkedDirs, 3);
});
