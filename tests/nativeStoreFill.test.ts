import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as NativeCore from '../native/index';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-nativeStoreFill-data-');

import { skipOrFailOnCi } from './fixtures/ciSkip';
import { waitFor } from './fixtures/waitFor';
import { loadNative, resetNativeForTests, type ScanModule } from '../src/services/scan/native';
import { allocateStoreArrays, takeNativeStore } from '../src/services/scan/nativeMemory';

/**
 * Phase 4 T9c (RISKS R92): where a runtime refuses external buffers — the
 * app's Electron does — the store is handed over by filling arrays JavaScript
 * allocated, on libuv's pool, instead of napi-rs copying every column on the
 * JavaScript thread (6.5 ms a million rows, 32.6 ms at 5M, T9). `storeShape`
 * says how long each array must be; `storeTakeInto` checks the arrays before
 * it takes the scan, fills them off the JavaScript thread, and drops each
 * column after its copy. The bytes are the external hand-over's, array for
 * array; the addon counts the bytes it copied on each side of the thread line.
 */

const REPO = path.join(__dirname, '..');
const PREBUILT_MODULE = path.join(REPO, 'native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node');
const ELECTRON_BINARY = '/Applications/TreeMap.app/Contents/MacOS/TreeMap';

type Core = typeof NativeCore;

const ENTRIES = 3_000;
const HEADROOM = 64;

function modulePath(): string {
  return process.env.TREEMAP_NATIVE_MODULE ?? PREBUILT_MODULE;
}

function loadCore(t: TestContext): Core | null {
  if (!fs.existsSync(modulePath())) {
    skipOrFailOnCi(t, `no native module at ${modulePath()}; build it with npm run build:native`);
    return null;
  }
  resetNativeForTests();
  const r = loadNative({ path: modulePath() });
  if (!r.available) assert.fail(r.reason);
  return r.module as unknown as Core;
}

function rootFor(core: Core, tag: string): string {
  return path.join(core.syntheticTempFolder(), `store-fill-${tag}-${process.pid}`);
}

/** One worker, one seed: two walks number their blocks alike, so their stores are the same bytes. */
function options(wantAtime: boolean): NativeCore.ScanStartOptions {
  return {
    neverDescend: [],
    wantAtime,
    maxWorkers: 1,
    synthetic: { entries: ENTRIES, seed: 11 },
    storage: 'memory',
    store: {
      rootName: 'the tree',
      rootMtimeMs: 1_700_000_000_000,
      blocksAreMeaningful: true,
      sortChildren: true,
      containerRules: [{ text: '.zip', wholeName: false, folders: false, kind: 1 }],
      headroomRows: HEADROOM,
      capRows: 100_000,
      nameBytes: 8 << 20,
    },
  };
}

async function walked(core: Core, tag: string, wantAtime: boolean): Promise<number> {
  const handle = core.scanStart(rootFor(core, tag), options(wantAtime));
  await waitFor(() => core.scanPoll(handle).done, 'the memory-mode walk', 5);
  return handle;
}

const ARRAYS = [
  'parent', 'size', 'mtime', 'atime', 'flags', 'ext', 'container', 'cloudProv', 'nameOff', 'names',
  'childStart', 'childCnt', 'extOverflowIds', 'cloudCandidates', 'textCandidates', 'sparseTermIds', 'sparseTermBytes',
] as const;

function bytesOf(array: ArrayBufferView | undefined): Buffer {
  return array ? Buffer.from(array.buffer, array.byteOffset, array.byteLength) : Buffer.alloc(0);
}

test('a store filled into JavaScript\'s own arrays is, array for array, the one the external hand-over gives', async (t) => {
  const core = loadCore(t);
  if (!core) return;
  for (const wantAtime of [false, true]) {
    const external = await core.storeTake(await walked(core, `external-${wantAtime}`, wantAtime));
    const handle = await walked(core, `filled-${wantAtime}`, wantAtime);
    const shape = core.storeShape(handle);
    const into = allocateStoreArrays(shape);
    const filled = await core.storeTakeInto(handle, into);
    for (const name of ARRAYS) {
      assert.ok(bytesOf(filled[name]).equals(bytesOf(external[name])), `${name}, wantAtime ${wantAtime}`);
      if (into[name]) assert.equal(filled[name], into[name], `${name} is JavaScript's own array`);
    }
    for (const field of ['n', 'capacity', 'namesLen', 'extDict', 'extOverflowTexts', 'counters'] as const) {
      assert.deepEqual(filled[field], external[field], field);
    }
    assert.equal(filled.stats.entries, external.stats.entries);
    assert.equal(shape.n, filled.n);
    assert.equal(shape.capacity, filled.capacity);
    assert.equal(shape.atime, external.atime !== undefined, 'the shape asks for an atime array exactly when there is one');
  }
});

test('the fill copies every byte on libuv\'s pool, none on the JavaScript thread', async (t) => {
  const core = loadCore(t);
  if (!core) return;
  const handle = await walked(core, 'counted', true);
  const filled = await core.storeTakeInto(handle, allocateStoreArrays(core.storeShape(handle)));
  assert.ok(filled.handOver, 'the fill says how it copied');
  assert.equal(filled.handOver.bytesOnJsThread, 0);
  const rowBytes = filled.n * (4 + 8 + 8 + 2 + 2 + 1 + 1 + 4 + 4 + 4) + filled.namesLen;
  assert.ok(filled.handOver.bytesOffThread >= rowBytes, `${filled.handOver.bytesOffThread} bytes copied off the thread, at least the ${rowBytes} of the rows`);
  const external = await core.storeTake(await walked(core, 'counted-external', true));
  assert.equal(external.handOver, undefined, 'the external hand-over copies nothing of its own');
});

test('arrays of the wrong kind or length are refused before the scan is taken, and the scan stays to be taken', async (t) => {
  const core = loadCore(t);
  if (!core) return;
  const handle = await walked(core, 'refused', true);
  const shape = core.storeShape(handle);
  const short = { ...allocateStoreArrays(shape), names: new Uint8Array(shape.namesRoom - 1) };
  // A wrong length is refused by the task; a wrong kind while napi-rs reads the argument, before any task.
  await assert.rejects(async () => core.storeTakeInto(handle, short), /names/);
  const noAtime = { ...allocateStoreArrays(shape), atime: undefined };
  await assert.rejects(async () => core.storeTakeInto(handle, noAtime), /atime/);
  const wrongKind = { ...allocateStoreArrays(shape), parent: new Uint32Array(shape.capacity) } as unknown as NativeCore.NativeStoreArrays;
  await assert.rejects(async () => core.storeTakeInto(handle, wrongKind), /Int32Array.*parent/);
  const s = await core.storeTake(handle);
  assert.equal(s.n, shape.n, 'the scan was still there to take');
});

test('storeShape and storeTakeInto refuse as storeTake does: an unknown handle, a scan without a store, a walk still running', async (t) => {
  const core = loadCore(t);
  if (!core) return;
  assert.throws(() => core.storeShape(987_654), /987654/);
  const plain = core.scanStart(rootFor(core, 'plain'), { neverDescend: [], wantAtime: false, synthetic: { entries: 50, seed: 3 } });
  await waitFor(() => core.scanPoll(plain).done, 'the plain walk', 5);
  assert.throws(() => core.storeShape(plain), /storage: 'memory'/);
  core.scanTake(plain);
  core.governorPause();
  try {
    const running = core.scanStart(rootFor(core, 'running'), options(false));
    assert.throws(() => core.storeShape(running), /still running/i);
    core.scanCancel(running);
  } finally {
    core.governorResume();
  }
});

test('plain Node lets an array be the store\'s own memory', (t) => {
  const core = loadCore(t);
  if (!core) return;
  assert.equal(core.externalBuffersAllowed(), true);
});

test('where external buffers are refused, the store is filled; elsewhere it is taken as before', async () => {
  const shape: NativeCore.NativeStoreShape = {
    n: 3, capacity: 5, namesRoom: 40, namesLen: 12, atime: true,
    extOverflow: 1, cloudCandidates: 2, textCandidates: 0, sparseTerms: 1,
  };
  const calls: string[] = [];
  const fake = (allowed: boolean): ScanModule => ({
    externalBuffersAllowed: () => allowed,
    storeShape: (handle: number) => { calls.push(`shape ${handle}`); return shape; },
    storeTakeInto: async (handle: number, into: NativeCore.NativeStoreArrays) => {
      calls.push(`into ${handle}`);
      assert.equal(into.parent.length, 5);
      assert.equal(into.nameOff.length, 6);
      assert.equal(into.names.length, 40);
      assert.equal(into.atime?.length, 5);
      assert.equal(into.extOverflowIds.length, 1);
      assert.equal(into.cloudCandidates.length, 2);
      assert.equal(into.textCandidates.length, 0);
      assert.equal(into.sparseTermIds.length, 1);
      assert.equal(into.sparseTermBytes.length, 1);
      return {} as NativeCore.NativeStore;
    },
    storeTake: async (handle: number) => { calls.push(`take ${handle}`); return {} as NativeCore.NativeStore; },
  }) as unknown as ScanModule;
  await takeNativeStore(fake(false), 7);
  assert.deepEqual(calls, ['shape 7', 'into 7']);
  calls.length = 0;
  await takeNativeStore(fake(true), 8);
  assert.deepEqual(calls, ['take 8']);
});

test('in the installed app\'s binary run as Node, external buffers are refused and the fill hands the store over', (t) => {
  if (process.platform !== 'darwin' || !fs.existsSync(ELECTRON_BINARY)) {
    t.skip(`the installed app's binary is not at ${ELECTRON_BINARY}`);
    return;
  }
  if (!fs.existsSync(modulePath())) {
    skipOrFailOnCi(t, `no native module at ${modulePath()}`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-fill-electron-'));
  const script = path.join(dir, 'probe.js');
  fs.writeFileSync(script, `
    const core = require(process.argv[2]);
    const path = require('path');
    const opts = () => ({ neverDescend: [], wantAtime: true, maxWorkers: 1, synthetic: { entries: 2000, seed: 5 }, storage: 'memory',
      store: { rootName: 'r', rootMtimeMs: 0, blocksAreMeaningful: true, sortChildren: true, containerRules: [], headroomRows: 16, capRows: 50000, nameBytes: 4 << 20 } });
    const walk = async (tag) => { const h = core.scanStart(path.join(core.syntheticTempFolder(), 'fill-' + tag + '-' + process.pid), opts());
      while (!core.scanPoll(h).done) await new Promise((r) => setTimeout(r, 5)); return h; };
    (async () => {
      const allowed = core.externalBuffersAllowed();
      const h = await walk('filled');
      const s = core.storeShape(h);
      const into = { parent: new Int32Array(s.capacity), size: new Float64Array(s.capacity), mtime: new Float64Array(s.capacity),
        atime: s.atime ? new Float64Array(s.capacity) : undefined, flags: new Uint16Array(s.capacity), ext: new Uint16Array(s.capacity),
        container: new Uint8Array(s.capacity), cloudProv: new Uint8Array(s.capacity), nameOff: new Uint32Array(s.capacity + 1),
        names: new Uint8Array(s.namesRoom), childStart: new Uint32Array(s.capacity), childCnt: new Uint32Array(s.capacity),
        extOverflowIds: new Uint32Array(s.extOverflow), cloudCandidates: new Uint32Array(s.cloudCandidates),
        textCandidates: new Uint32Array(s.textCandidates), sparseTermIds: new Uint32Array(s.sparseTerms), sparseTermBytes: new Float64Array(s.sparseTerms) };
      const filled = await core.storeTakeInto(h, into);
      const copied = await core.storeTake(await walk('copied'));
      const same = ['parent', 'size', 'mtime', 'atime', 'flags', 'ext', 'container', 'cloudProv', 'nameOff', 'names', 'childStart', 'childCnt']
        .every((k) => Buffer.from(filled[k].buffer).equals(Buffer.from(copied[k].buffer)));
      console.log(JSON.stringify({ allowed, same, handOver: filled.handOver }));
    })().catch((e) => { console.log(JSON.stringify({ error: String((e && e.stack) || e) })); });
  `);
  const r = spawnSync(ELECTRON_BINARY, [script, modulePath()], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TREEMAP_DATA_DIR: dir },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const line = r.stdout.trim().split('\n').pop() ?? '';
  const out = JSON.parse(line || '{}') as { allowed?: boolean; same?: boolean; handOver?: { bytesOnJsThread: number }; error?: string };
  assert.equal(out.error, undefined, out.error);
  assert.equal(out.allowed, false, 'the app\'s Electron refuses external buffers');
  assert.equal(out.same, true, 'the filled arrays are the copied ones');
  assert.equal(out.handOver?.bytesOnJsThread, 0);
});
