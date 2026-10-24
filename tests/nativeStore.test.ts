import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

/**
 * The regions this process has mapped readable and writable (not executable),
 * and their bytes: /proc/self/maps on Linux, vmmap on macOS. A store's columns
 * are such mappings, and so is the reservation a kept store would still hold —
 * the private writable regions Linux's fork weighs whole against memory and
 * swap (BQR-1 A1). The whole address space (VmSize, ps's vsz) also counts
 * reservations nothing may write, which are no store's: V8 reserves 8 GiB
 * (10 GiB on Node 20) for every WebAssembly memory, and tsx's loader makes such
 * memories in every test file's process as their compiles settle. On Node 24
 * two settle at the first turn of the event loop after the file loads: during
 * the file's first test, but inside this test's two readings when it runs alone
 * (a name pattern, every time) or the compile is late on a loaded Mac —
 * 17,250,680,832 bytes in a full `npm test` on 24 Oct 2026, two 8 GiB
 * reservations and the 71 MB a pass grows.
 */
function readWriteMappings(): { regions: number; bytes: number } {
  const linux = process.platform === 'linux';
  const listing = linux
    ? fs.readFileSync('/proc/self/maps', 'utf8')
    : execFileSync('vmmap', ['-w', '-interleaved', String(process.pid)], { maxBuffer: 1 << 30 }).toString();
  // Linux: "start-end perms offset dev inode path"; vmmap: "type  start-end  [ vsize rsdnt dirty swap] current/max share …".
  const region = linux ? /^([0-9a-f]+)-([0-9a-f]+) (\S{3})/ : /\s([0-9a-f]+)-([0-9a-f]+)\s+\[[^\]]*\]\s+(\S{3})\//;
  let regions = 0;
  let bytes = 0;
  for (const line of listing.split('\n')) {
    const m = region.exec(line);
    if (m?.[3] !== 'rw-') continue;
    regions += 1;
    bytes += parseInt(m[2], 16) - parseInt(m[1], 16);
  }
  return { regions, bytes };
}

test('a store taken and kept maps its room, not the whole reservation its walk wrote into: on Linux a fork is refused ENOMEM once kept reservations side by side pass memory and swap, as CI\'s Autopilot spawn was after 25 scans (BQR-1 A1)', { skip: process.platform === 'win32' && 'Windows reserves a room without charging it, and starts a child without a fork' }, async (t) => {
  // The app's default room (src/services/scan/nativeMemory.ts: 1.25 x 5,000,000 rows, 128 name bytes a row).
  const room = { capRows: 6_250_000, nameBytes: 800_000_000 };
  const KEPT = 4;
  const core = loadCore(t);
  if (!core) return;
  const kept: NativeCore.NativeStore[] = [];
  const before = readWriteMappings();
  for (let i = 0; i < KEPT; i++) {
    const handle = core.scanStart(rootFor(core, `kept-${String(i)}`), options({ store: storeOptions(room) }));
    await done(core, handle);
    kept.push(await core.storeTake(handle));
  }
  const after = readWriteMappings();
  const grew = after.bytes - before.bytes;
  assert.ok(before.regions > 0 && after.regions > 0, `control: the listing names this process's read-write regions (${String(before.regions)}, then ${String(after.regions)})`);
  for (const s of kept) {
    assert.deepEqual([s.n, s.capacity, s.parent.length, s.parent[0]], [ENTRIES + 1, ENTRIES + 1 + HEADROOM, ENTRIES + 1 + HEADROOM, -1], 'control: each kept store has its rows and headroom, the root first');
  }
  assert.ok(grew < room.nameBytes, `${String(KEPT)} stores taken and kept grew the read-write mappings by ${String(grew)} bytes, more than one room's name pool (${String(room.nameBytes)}): each still maps the reservation its walk wrote into`);
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
