import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';
import type * as NativeCore from '../../native/index';
import { skipOrFailOnCi } from './ciSkip';
import { loadNative, resetNativeForTests, type ScanModule } from '../../src/services/scan/native';
import { resetEngineBudgetForTests, setNativeLoadOptionsForTests } from '../../src/services/engineBudget';

/**
 * The real native module, passed through with its walks counted, and loaded
 * through the real loader, so a scan the app starts walks with it. Shared by
 * the memory-path tests (tests/nativeMemoryDefault.test.ts, Phase 4 T10b) and
 * Track U's (U-30–U-32): each walk's storage and options, the stores taken,
 * and two hooks — one that may refuse a start, one that may rewrite or throw
 * from a poll — so a test can isolate a rule by counts alone.
 */

const REPO = path.join(__dirname, '..', '..');
const PREBUILT_MODULE = path.join(REPO, 'native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node');

type Core = typeof NativeCore;

export interface Counted {
  module: ScanModule;
  /** Each walk's storage, in the order the walks were started — refused starts included. */
  starts: string[];
  /** Each start's options, in the same order. */
  startOptions: NativeCore.ScanStartOptions[];
  /** Stores taken, whole or filled. */
  takes: number;
  /** Walks cancelled through the module. */
  cancels: number;
}

/** What a walk's poll reports, given its storage, which poll of that walk it is (from 1) and the module's own report; it may throw. */
export type PollHook = (storage: string, nth: number, real: NativeCore.NativeProgress) => NativeCore.NativeProgress;

/** Runs before a start reaches the module, given its storage, its options and which start it is (from 1); a throw refuses the start. */
export type StartHook = (storage: string, opts: NativeCore.ScanStartOptions, nth: number) => void;

export interface CountedHooks {
  poll?: PollHook;
  start?: StartHook;
}

/**
 * The real module behind a pass-through that counts, or null — with the test
 * skipped (failed on CI) — when no module is on disk.
 */
export function countedReal(t: TestContext, hooks: CountedHooks = {}): Counted | null {
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
  const counted: Counted = { module: {} as ScanModule, starts: [], startOptions: [], takes: 0, cancels: 0 };
  const walks = new Map<number, { storage: string; polls: number }>();
  const module = {
    ...core,
    scanStart: (root: string, opts: NativeCore.ScanStartOptions): number => {
      const storage = opts.storage ?? 'columns';
      counted.starts.push(storage);
      counted.startOptions.push(opts);
      hooks.start?.(storage, opts, counted.starts.length);
      const handle = core.scanStart(root, opts);
      walks.set(handle, { storage, polls: 0 });
      return handle;
    },
    scanPoll: (handle: number): NativeCore.NativeProgress => {
      const real = core.scanPoll(handle);
      const walk = walks.get(handle);
      if (!hooks.poll || !walk) return real;
      walk.polls++;
      return hooks.poll(walk.storage, walk.polls, real);
    },
    scanCancel: (handle: number): void => {
      counted.cancels++;
      core.scanCancel(handle);
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
