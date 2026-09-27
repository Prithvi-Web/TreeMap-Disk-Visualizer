import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type * as NativeCore from '../native/index';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-nativeStore-data-');

import { skipOrFailOnCi } from './fixtures/ciSkip';
import { waitFor } from './fixtures/waitFor';
import { loadNative, resetNativeForTests } from '../src/services/scan/native';

/**
 * Phase 4 T8b: a memory-mode native scan. `scanStart` with `storage:
 * 'memory'` numbers the walk in blocks, keeps no columns of its own and feeds
 * tm-store's memory sink, which seals the store on the walk's own thread;
 * `storeTake` hands it over — every per-node column `capacity` rows long, as
 * `PackedScanStore.adoptColumns` takes them — and frees the handle. What the
 * hand-over costs in memory — none in plain Node, whose arrays are the store's
 * own mappings; a copy where Electron refuses that — is T9's to measure. A scan
 * that cannot finish is held by the process-wide governor's pause, never by a
 * clock.
 */

const REPO = path.join(__dirname, '..');
const PREBUILT_MODULE = path.join(REPO, 'native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node');

type Core = typeof NativeCore;

/** Entries under each synthetic root. */
const ENTRIES = 3_000;
/** Rows the store keeps free after the scan's. */
const HEADROOM = 64;

/** The prebuilt module (or TREEMAP_NATIVE_MODULE) through the real loader, or null after skipping with the reason. */
function loadCore(t: TestContext): Core | null {
  const file = process.env.TREEMAP_NATIVE_MODULE ?? PREBUILT_MODULE;
  if (!fs.existsSync(file)) {
    skipOrFailOnCi(t, `no native module at ${file}; build it with npm run build:native`);
    return null;
  }
  resetNativeForTests();
  const r = loadNative({ path: file });
  if (!r.available) assert.fail(r.reason);
  return r.module as unknown as Core;
}

function storeOptions(over: Partial<NativeCore.StoreStartOptions> = {}): NativeCore.StoreStartOptions {
  return {
    rootName: 'the tree',
    rootMtimeMs: 1_700_000_000_000,
    blocksAreMeaningful: true,
    sortChildren: true,
    containerRules: [{ text: '.zip', wholeName: false, folders: false, kind: 1 }],
    headroomRows: HEADROOM,
    capRows: 100_000,
    nameBytes: 8 << 20,
    ...over,
  };
}

/** A root inside the app's synthetic temp folder, as the module names it, that nothing creates. */
function rootFor(core: Core, tag: string): string {
  return path.join(core.syntheticTempFolder(), `store-test-${tag}-${process.pid}`);
}

function options(over: Partial<NativeCore.ScanStartOptions> = {}): NativeCore.ScanStartOptions {
  return {
    neverDescend: [],
    wantAtime: false,
    maxWorkers: 2,
    synthetic: { entries: ENTRIES, seed: 7 },
    storage: 'memory',
    store: storeOptions(),
    ...over,
  };
}

async function done(core: Core, handle: number): Promise<void> {
  await waitFor(() => core.scanPoll(handle).done, 'the memory-mode walk', 5);
}

/** Runs `body` with the process-wide governor paused: no walk started meanwhile can finish. */
async function withGovernorPaused(core: Core, body: () => Promise<void>): Promise<void> {
  core.governorPause();
  try {
    await body();
  } finally {
    core.governorResume();
  }
}

function perNodeColumns(s: NativeCore.NativeStore): Array<[string, ArrayLike<number>]> {
  return [
    ['parent', s.parent], ['size', s.size], ['mtime', s.mtime], ['flags', s.flags], ['ext', s.ext],
    ['container', s.container], ['cloudProv', s.cloudProv], ['childStart', s.childStart], ['childCnt', s.childCnt],
  ];
}

test('a memory-mode scan hands its sealed store over at capacity length, as adoptColumns takes it', async (t) => {
  const core = loadCore(t);
  if (!core) return;
  const handle = core.scanStart(rootFor(core, 'whole'), options());
  await done(core, handle);
  const s = await core.storeTake(handle);
  assert.equal(s.stats.entries, ENTRIES, 'the stats are the walk\'s');
  assert.equal(s.n, ENTRIES + 1, 'a row for every entry and the root');
  assert.equal(s.capacity, s.n + HEADROOM);
  for (const [name, column] of perNodeColumns(s)) {
    assert.equal(column.length, s.capacity, `${name} has capacity rows`);
    for (let id = s.n; id < s.capacity; id++) assert.equal(column[id], 0, `${name}'s headroom row ${id} is zero`);
  }
  assert.equal(s.atime, undefined, 'no access-time column when the walk read none');
  assert.equal(s.nameOff.length, s.capacity + 1);
  assert.equal(s.nameOff[s.n], s.namesLen, 'the names in use end where the last row\'s name does');
  assert.ok(s.names.length >= s.namesLen, 'the name pool holds the names in use');
  assert.equal(new TextDecoder().decode(s.names.subarray(s.nameOff[0], s.nameOff[1])), 'the tree', 'the root has Node\'s name for it');
  assert.equal(s.parent[0], -1, 'the root has no parent');
  let children = 0;
  for (let id = 0; id < s.n; id++) {
    if (id > 0) assert.ok(s.parent[id] >= 0 && s.parent[id] < id, `row ${id}'s parent ${s.parent[id]} comes before it`);
    for (let c = s.childStart[id]; c < s.childStart[id] + s.childCnt[id]; c++) {
      assert.equal(s.parent[c], id, `row ${c} is in its parent ${id}'s child range`);
      children += 1;
    }
  }
  assert.equal(children, s.n - 1, 'every row but the root is some folder\'s child');
  assert.equal(s.counters.dirs + s.counters.files, s.n, 'every row is a folder or not');
  assert.equal(s.sparseTermIds.length, s.sparseTermBytes.length);
  assert.equal(s.extOverflowIds.length, s.extOverflowTexts.length);
  assert.equal(s.extDict[0], '', 'the dictionary\'s first extension is none');
});

test('scanTake frees a memory-mode scan and throws: its rows are in its store', async (t) => {
  const core = loadCore(t);
  if (!core) return;
  const handle = core.scanStart(rootFor(core, 'scan-take'), options());
  await done(core, handle);
  assert.throws(() => core.scanTake(handle), /storeTake/);
  await assert.rejects(core.storeTake(handle), /no scan handle/, 'the refusal freed the handle');
});

test('storeTake refuses a walk still running and keeps it; once it is done it resolves', async (t) => {
  const core = loadCore(t);
  if (!core) return;
  await withGovernorPaused(core, async () => {
    const handle = core.scanStart(rootFor(core, 'running'), options());
    assert.equal(core.scanPoll(handle).done, false, 'held by the governor');
    await assert.rejects(core.storeTake(handle), /still running/);
    core.governorResume();
    await done(core, handle);
    const s = await core.storeTake(handle);
    assert.equal(s.n, ENTRIES + 1);
  });
});

test('storeTake rejects a cancelled memory-mode walk with the cancellation, and frees its handle', async (t) => {
  const core = loadCore(t);
  if (!core) return;
  await withGovernorPaused(core, async () => {
    const handle = core.scanStart(rootFor(core, 'cancelled'), options());
    core.scanCancel(handle);
    core.governorResume();
    await done(core, handle);
    await assert.rejects(core.storeTake(handle), /cancelled/);
    await assert.rejects(core.storeTake(handle), /no scan handle/);
  });
});

test('a sink too small for the walk fails it with the ceiling\'s sentence, and the poll says it was the ceiling', async (t) => {
  const core = loadCore(t);
  if (!core) return;
  const handle = core.scanStart(rootFor(core, 'small'), options({ store: storeOptions({ capRows: 1_000 + HEADROOM }) }));
  await done(core, handle);
  const poll = core.scanPoll(handle);
  assert.match(String(poll.error), /exceeded/);
  assert.equal(poll.ceiling, true, 'a ceiling, which a caller with more room can walk past');
  await assert.rejects(core.storeTake(handle), /exceeded/);

  const whole = core.scanStart(rootFor(core, 'roomy'), options());
  await done(core, whole);
  assert.equal(core.scanPoll(whole).ceiling, false, 'a walk that finished');
  await core.storeTake(whole);

  core.governorPause();
  try {
    const cancelled = core.scanStart(rootFor(core, 'cancelled-ceiling'), options());
    core.scanCancel(cancelled);
    core.governorResume();
    await done(core, cancelled);
    assert.equal(core.scanPoll(cancelled).ceiling, false, 'a walk that was cancelled');
    await assert.rejects(core.storeTake(cancelled), /cancelled/);
  } finally {
    core.governorResume();
  }
});

test('storage and store come together, and a scan started without them has no store', async (t) => {
  const core = loadCore(t);
  if (!core) return;
  const root = rootFor(core, 'shapes');
  assert.throws(() => core.scanStart(root, options({ store: null })), /store/, 'memory needs its store options');
  assert.throws(() => core.scanStart(root, options({ storage: null })), /storage/, 'store options need memory');
  assert.throws(() => core.scanStart(root, options({ storage: 'disk' as never })), /storage/);
  assert.throws(() => core.scanStart(root, options({ store: { ...storeOptions(), colour: 'red' } as never })), /colour/);
  const plain = core.scanStart(root, options({ storage: null, store: null }));
  await done(core, plain);
  await assert.rejects(core.storeTake(plain), /storage: 'memory'/, 'a scan without a store is refused');
  assert.equal(core.scanTake(plain).stats.entries, ENTRIES, 'and kept for scanTake');
});
