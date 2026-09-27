import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type * as NativeCore from '../native/index';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-collectorsOracle-data-');

import { skipOrFailOnCi } from './fixtures/ciSkip';
import { KEEP, ORACLE_PATH, PREBUILT_MODULE, SPECS, oracleText, storeOf } from './fixtures/collectorsOracle';
import { collectLargestFiles, collectLargestFolders } from '../src/services/diskScanner';
import { loadNative } from '../src/services/scan/native';

/**
 * Phase 4 T12b: tm-store's aggregate state is held to a Rust port of the
 * collectors, and the port is held here to the collectors themselves, through
 * `tests/fixtures/collectorsOracle.ts`'s file.
 */

type Core = typeof NativeCore;

function coreOrSkip(t: TestContext): Core | null {
  const file = process.env.TREEMAP_NATIVE_MODULE ?? PREBUILT_MODULE;
  if (!fs.existsSync(file)) {
    skipOrFailOnCi(t, `no native module at ${file}; build it with npm run build:native`);
    return null;
  }
  const loaded = loadNative({ path: file });
  if (!loaded.available) assert.fail(loaded.reason);
  return loaded.module as unknown as Core;
}

const LIMITS = [1, 2, 3, 10, 100, KEEP - 1, KEEP];
const MIN_SIZES = [0, 1, 2, 50, 1_000, 4_096, 4_097, 1e6, 1e15];

test('every limit and minimum the routes ask for is the full list cut short, so one list per tree answers them all', async (t) => {
  const core = coreOrSkip(t);
  if (!core) return;
  for (const [index, spec] of SPECS.entries()) {
    const { store } = await storeOf(core, spec, index);
    const files = collectLargestFiles(store, KEEP, 0);
    const folders = collectLargestFolders(store, KEEP, 0);
    for (const limit of LIMITS) {
      for (const min of MIN_SIZES) {
        const at = `seed ${spec.seed}, limit ${limit}, minimum ${min}`;
        assert.deepEqual(collectLargestFiles(store, limit, min), files.filter((f) => f.size >= min).slice(0, limit), `files, ${at}`);
        assert.deepEqual(collectLargestFolders(store, limit, min), folders.filter((f) => f.size >= min).slice(0, limit), `folders, ${at}`);
      }
    }
  }
});

test('the committed oracle is what the collectors answer today', async (t) => {
  const core = coreOrSkip(t);
  if (!core) return;
  const committed = fs.readFileSync(ORACLE_PATH, 'utf8');
  const today = await oracleText(core);
  assert.ok(
    committed === today,
    `the oracle is stale: regenerate it with \`npx tsx tests/fixtures/collectorsOracle.ts\` and commit it (${committed.length} bytes committed, ${today.length} today)`,
  );
});
