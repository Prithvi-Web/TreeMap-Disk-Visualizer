import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as NativeCore from '../native/index';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-nativeMemoryDefault-data-');

import { skipOrFailOnCi } from './fixtures/ciSkip';
import { loadNative, resetNativeForTests, type ScanModule } from '../src/services/scan/native';
import { resetEngineBudgetForTests, setNativeLoadOptionsForTests } from '../src/services/engineBudget';
import { nativeStorageFor, rootName, runNativeWalk } from '../src/services/scan/nativeEngine';
import { setMemoryRoomForTests } from '../src/services/scan/nativeMemory';
import { allScans, createScanRecord, getScan, startScan } from '../src/services/diskScanner';
import { updateSettings } from '../src/services/settings';
import { PackedScanStore } from '../src/services/scanStore';
import { statToInput } from '../src/services/scan/nodeInput';
import type { ScanResult } from '../src/models/types';

/**
 * Phase 4 T10: the scanner walks through the memory store. A module that
 * offers it (`storeTake`, every real one) is walked in memory mode; a tree
 * past the store's room ends at its ceiling (`scanPoll`'s `ceiling`), and —
 * until T12–T14 give such a tree a mode of its own — is walked again,
 * natively, on the columns path, which is what took every native scan
 * before T10, with the reason in `engineReason`: never the legacy walker.
 */

const REPO = path.join(__dirname, '..');
const PREBUILT_MODULE = path.join(REPO, 'native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node');

type Core = typeof NativeCore;

interface Counted {
  module: ScanModule;
  /** Each walk's storage, in order. */
  starts: string[];
  /** Stores taken, whole or filled. */
  takes: number;
}

/** What a walk's poll reports, given its storage, which poll of that walk it is (from 1) and the module's own report. */
type PollHook = (storage: string, nth: number, real: NativeCore.NativeProgress) => NativeCore.NativeProgress;

/**
 * The real module, passed through with its starts and takes counted, loaded
 * through the real loader; with `poll`, every poll's report passes through it.
 */
function countedReal(t: TestContext, poll?: PollHook): Counted | null {
  const file = process.env.TREEMAP_NATIVE_MODULE ?? PREBUILT_MODULE;
  if (!fs.existsSync(file)) {
    skipOrFailOnCi(t, `no native module at ${file}; build it with npm run build:native`);
    return null;
  }
  resetNativeForTests();
  resetEngineBudgetForTests();
  const direct = loadNative({ path: file });
  if (!direct.available) assert.fail(direct.reason);
  const core = direct.module as unknown as Core;
  const counted: Counted = { module: {} as ScanModule, starts: [], takes: 0 };
  const walks = new Map<number, { storage: string; polls: number }>();
  const module = {
    ...core,
    scanStart: (root: string, opts: NativeCore.ScanStartOptions): number => {
      const storage = opts.storage ?? 'columns';
      counted.starts.push(storage);
      const handle = core.scanStart(root, opts);
      walks.set(handle, { storage, polls: 0 });
      return handle;
    },
    scanPoll: (handle: number): NativeCore.NativeProgress => {
      const real = core.scanPoll(handle);
      const walk = walks.get(handle);
      if (!poll || !walk) return real;
      walk.polls++;
      return poll(walk.storage, walk.polls, real);
    },
    storeTake: async (handle: number): Promise<NativeCore.NativeStore> => {
      counted.takes++;
      return core.storeTake(handle);
    },
    storeTakeInto: async (handle: number, into: NativeCore.NativeStoreArrays): Promise<NativeCore.NativeStore> => {
      counted.takes++;
      return core.storeTakeInto(handle, into);
    },
  };
  resetNativeForTests();
  setNativeLoadOptionsForTests({ path: file, requireModule: () => module });
  const outcome = loadNative({ path: file, requireModule: () => module });
  assert.equal(outcome.available, true, 'the pass-through must pass the loader\'s handshake');
  counted.module = module as unknown as ScanModule;
  return counted;
}

/** `folders` folders of `files` files each under a new temp folder; `pad` lengthens every file's name. */
function tree(t: TestContext, folders: number, files: number, pad = ''): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-memory-default-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let f = 0; f < folders; f++) {
    const dir = path.join(root, `folder-${f}`);
    fs.mkdirSync(dir);
    for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `file-${i}${pad}.txt`), 'x'.repeat(1 + (i % 50)));
  }
  return root;
}

async function scanned(root: string): Promise<ScanResult> {
  await updateSettings({ engine: 'native' });
  const record = await startScan(root);
  const t0 = Date.now();
  for (;;) {
    const scan = getScan(record.scanId);
    assert.ok(scan, 'the scan record');
    if (scan.status !== 'running') return scan;
    assert.ok(Date.now() - t0 < 60_000, 'the scan settled');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * The scan's pruned tree as JSON, access times left out: listing a folder
 * moves its access time, so a later walk of the same tree sees the times the
 * earlier walks left, not the ones they read.
 */
function prunedJson(scan: ScanResult): string {
  assert.ok(scan.store, 'the scan kept a store');
  const tree = scan.store.prune(scan.store.rootId, { maxNodes: 250_000 }).root;
  return JSON.stringify(tree, (key, value: unknown) => (key === 'accessedAt' ? undefined : value));
}

test('a module that offers the memory store is walked through it; one that does not, on the columns path', () => {
  assert.equal(nativeStorageFor({ storeTake: async () => ({}) } as unknown as ScanModule), 'memory');
  assert.equal(nativeStorageFor({} as ScanModule), 'columns');
});

test('a native scan walks once, through the memory store, and takes it whole', async (t) => {
  const counted = countedReal(t);
  if (!counted) return;
  const root = tree(t, 8, 25);
  const scan = await scanned(root);
  assert.equal(scan.status, 'complete', scan.error ?? '');
  assert.equal(scan.engine, 'native');
  assert.deepEqual(counted.starts, ['memory']);
  assert.equal(counted.takes, 1);
  assert.equal(scan.fileCount, 8 * 25);
  assert.equal(scan.dirCount, 1 + 8);
  assert.doesNotMatch(scan.engineReason ?? '', /columns path/);
});

test('past the memory store\'s room the scan is walked again on the columns path, natively, and says why', async (t) => {
  const counted = countedReal(t);
  if (!counted) return;
  t.after(() => setMemoryRoomForTests(null));
  const root = tree(t, 40, 60);
  setMemoryRoomForTests({ capRows: 2_048 });
  const scan = await scanned(root);
  assert.equal(scan.status, 'complete', scan.error ?? '');
  assert.equal(scan.engine, 'native', 'never the legacy walker');
  assert.equal(scan.fallbackReason ?? null, null, 'not a fallback: the native engine did the scan');
  assert.deepEqual(counted.starts, ['memory', 'columns'], 'the memory walk ended at its ceiling; the columns walk finished');
  assert.equal(counted.takes, 0, 'nothing was taken from the store that ran out of room');
  // The room is 2,048 rows less 1,024 of headroom; the root is id 0.
  assert.match(scan.engineReason ?? '', /the native engine stopped at its ceiling: the walk exceeded 1,023 entries, so it walked the tree again on the columns path/);
  assert.equal(scan.fileCount, 40 * 60);

  // The same tree walked on the columns path alone.
  const alone = createScanRecord(root);
  const store = new PackedScanStore(root, path.sep, statToInput(rootName(root), true, 0, fs.lstatSync(root).mtimeMs));
  await runNativeWalk(alone, store, root, counted.module, 'columns');
  alone.store = store;
  assert.equal(prunedJson(scan), prunedJson(alone), 'the tree the columns path gives');
});

test('walked again on the columns path, the count the scan shows never goes back, and it ends at the tree\'s own', async (t) => {
  t.after(() => setMemoryRoomForTests(null));
  const root = tree(t, 40, 60);
  const shown: Array<{ storage: string; scanned: number }> = [];
  const counted = countedReal(t, (storage, nth, real) => {
    const running = allScans().find((s) => s.rootPath === root && s.status === 'running');
    if (running) shown.push({ storage, scanned: running.scanned });
    // At its first poll the walk again has only just begun: nothing listed
    // yet, whatever this machine's scheduling let it list meanwhile.
    return storage === 'columns' && nth === 1 ? { ...real, done: false, entries: 0, dirs: 0, files: 0, bytes: 0, currentPath: null } : real;
  });
  if (!counted) return;
  setMemoryRoomForTests({ capRows: 2_048 });
  const scan = await scanned(root);
  assert.equal(scan.status, 'complete', scan.error ?? '');
  assert.deepEqual(counted.starts, ['memory', 'columns']);
  const left = shown.filter((s) => s.storage === 'memory').at(-1)?.scanned ?? 0;
  assert.ok(left > 1, `the memory walk showed its count before it ran out of room: ${left}`);
  assert.ok(shown.some((s) => s.storage === 'columns'), 'the walk again was polled');
  const fell = shown.findIndex((s, i) => i > 0 && s.scanned < shown[i - 1].scanned);
  assert.equal(fell, -1, `the count went back, from ${shown[fell - 1]?.scanned} to ${shown[fell]?.scanned}: ${shown.map((s) => `${s.storage[0]}${s.scanned}`).join(' ')}`);
  assert.equal(scan.scanned, 1 + 40 + 40 * 60, 'the count the scan ends with is the tree\'s own');
});

test('a tree whose names outgrow the memory store before its rows do is walked again too, and the reason names the names', async (t) => {
  const counted = countedReal(t);
  if (!counted) return;
  t.after(() => setMemoryRoomForTests(null));
  // 820 entries, under the room's 1,023, whose names (about 26 KB) are more
  // than the room's 40 bytes a row leave once the headroom's are set aside.
  const root = tree(t, 20, 40, '-a-name-padded-past-forty-bytes');
  setMemoryRoomForTests({ capRows: 2_048, nameBytesPerRow: 40 });
  const scan = await scanned(root);
  assert.equal(scan.status, 'complete', scan.error ?? '');
  assert.equal(scan.engine, 'native', 'never the legacy walker');
  assert.deepEqual(counted.starts, ['memory', 'columns']);
  assert.equal(counted.takes, 0);
  assert.match(scan.engineReason ?? '', /the native engine stopped at its ceiling: the walk's names exceeded [\d,]+ bytes, so it walked the tree again on the columns path/);
  assert.doesNotMatch(scan.engineReason ?? '', /exceeded [\d,]+ entries/, 'no row count is claimed for a tree that fit the rows');
  assert.equal(scan.fileCount, 20 * 40);
  assert.equal(scan.dirCount, 1 + 20);
});
