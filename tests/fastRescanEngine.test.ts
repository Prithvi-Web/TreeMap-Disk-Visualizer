import { test, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-fastRescanEngine-data-');
process.env.TREEMAP_NO_GDU = '1';

import { skipOrFailOnCi } from './fixtures/ciSkip';
import { getScan, setMftWalkForTests, startScan } from '../src/services/diskScanner';
import { nativeScanModule, resetNativeForTests, setNativeLoadOverrideForTests } from '../src/services/scan/native';
import { resetEngineBudgetForTests, setNativeLoadOptionsForTests } from '../src/services/engineBudget';
import { storeOf } from '../src/services/scanStore';
import { updateSettings } from '../src/services/settings';
import { settled } from '../src/utils/backgroundWrites';
import type { EngineSetting, ScanResult } from '../src/models/types';

/**
 * QA D45 (5 Oct 2026): "Fast rescan" was about twenty times slower than a
 * plain scan on the QA Mac. An incremental request kept the native engine
 * off — "the mtime cache it reuses belongs to the built-in walker" — so the
 * scan traded a native walk (one bulk listing per folder) for the walker,
 * plus a parse of the whole cached tree, plus an lstat of every folder.
 *
 * The engineering call: where the native engine can run, Automatic (and the
 * Native setting, which asks for it by name) runs it and does not read the
 * cache, and the scan says so. It is faster, and it is exact where the cache
 * is not — an edit inside a file is seen, every file's allocation is
 * measured, a placeholder is read from its flag. The fast rescan is the
 * walker's, as it always was: under the Walker setting, or wherever the
 * native engine cannot run, the cache is read as before.
 */

const NO_NATIVE = path.join(os.tmpdir(), 'treemap-no-native-here.node');
const SKIPPED = /a fast rescan was asked for and not used: the native engine lists the whole folder faster than the built-in walker reuses its cache, and sees the edits inside files the cache cannot/;

after(async () => {
  setNativeLoadOptionsForTests(null);
  resetNativeForTests();
  resetEngineBudgetForTests();
  await updateSettings({ engine: 'auto' });
  await settled();
});

/** root/{a.bin, sub/b.bin}. */
function tree(): string {
  const root = fs.realpathSync(fileTempDir('treemap-fastRescanEngine-'));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'a.bin'), 'a'.repeat(100));
  fs.writeFileSync(path.join(root, 'sub', 'b.bin'), 'b'.repeat(200));
  return root;
}

async function scanOf(root: string, engine: EngineSetting, opts: { incremental?: boolean } = {}): Promise<ScanResult> {
  await updateSettings({ engine });
  const s = await startScan(root, opts);
  await waitFor(() => s.status !== 'running', `the ${engine} scan of ${root} settling`);
  assert.equal(s.status, 'complete', s.error);
  await settled(); // the fast-rescan cache is written after the scan answers
  return getScan(s.scanId) ?? s;
}

function hasNative(t: TestContext): boolean {
  if (nativeScanModule().available) return true;
  skipOrFailOnCi(t, 'no native module built for this machine');
  return false;
}

const isWalker = (s: ScanResult): boolean => s.engine === 'walker' || s.engine === 'turbo-walker';
const times = (text: string | undefined, pattern: RegExp): number => (text ?? '').match(new RegExp(pattern.source, 'g'))?.length ?? 0;

for (const engine of ['auto', 'native'] as const) {
  test(`${engine}: a fast-rescan request runs the native engine where it can, reads no cache, sees an edit inside a file, and says why (D45)`, async (t) => {
    if (!hasNative(t)) return;
    const root = tree();
    const first = await scanOf(root, engine);
    assert.equal(first.engine, 'native');
    // An edit inside a file changes no folder's time: the cache would hand the old size back.
    const sub = path.join(root, 'sub');
    const times0 = fs.statSync(sub);
    fs.appendFileSync(path.join(sub, 'b.bin'), 'b'.repeat(50));
    fs.utimesSync(sub, times0.atime, times0.mtime);

    const again = await scanOf(root, engine, { incremental: true });
    assert.equal(again.engine, 'native', `${again.engineReason} — ${again.fallbackReason}`);
    assert.equal(again.incremental, false, 'the cache was not read');
    assert.equal(again.cachedDirs, 0);
    assert.equal(again.fallbackReason, null, 'a choice, not a failure');
    assert.equal(times(again.engineReason, SKIPPED), 1, again.engineReason);
    const store = storeOf(again);
    assert.equal(store.size(store.findByPath(path.join(sub, 'b.bin'))), 250, 'the edit is seen');
  });
}

test('the Walker setting keeps the fast rescan: the cache is read, and the sentence says nothing of the native engine', async () => {
  const root = tree();
  await scanOf(root, 'walker');
  const again = await scanOf(root, 'walker', { incremental: true });
  assert.ok(isWalker(again), again.engine);
  assert.equal(again.incremental, true);
  assert.ok((again.cachedDirs ?? 0) > 0, `cachedDirs ${again.cachedDirs}`);
  assert.equal(times(again.engineReason, SKIPPED), 0, again.engineReason);
});

test('where the native engine cannot run, Automatic’s fast rescan is the walker’s, with the cache, as before', async () => {
  const root = tree();
  resetNativeForTests();
  resetEngineBudgetForTests();
  setNativeLoadOptionsForTests({ path: NO_NATIVE });
  try {
    await scanOf(root, 'auto');
    const again = await scanOf(root, 'auto', { incremental: true });
    assert.ok(isWalker(again), again.engine);
    assert.equal(again.incremental, true);
    assert.ok((again.cachedDirs ?? 0) > 0, `cachedDirs ${again.cachedDirs}`);
    assert.equal(times(again.engineReason, /incremental rescan/), 1, again.engineReason);
    assert.equal(times(again.engineReason, SKIPPED), 0, again.engineReason);
  } finally {
    setNativeLoadOptionsForTests(null);
    resetNativeForTests();
    resetEngineBudgetForTests();
  }
});

/** Windows while `startScan` decides which engine runs (as tests/scanMftMode.test.ts stands it in). */
async function asWindows<T>(fn: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real && 'value' in real, 'process.platform is a plain value that can be stood in for');
  Object.defineProperty(process, 'platform', { ...real, value: 'win32' });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

test('the NTFS turbo mode is never used for a fast-rescan request, though the native engine then walks: no administrator prompt for a scan that asked to be a rescan', async (t) => {
  const prebuilt = path.join(__dirname, '..', 'native', 'prebuilt', `${os.platform()}-${os.arch()}`, 'treemap_core.node');
  if (!fs.existsSync(prebuilt)) return skipOrFailOnCi(t, 'no native module built for this machine');
  const calls: string[] = [];
  setMftWalkForTests(async (_scan, _store, rootPath) => {
    calls.push(rootPath);
    return { used: false, failed: false, reason: 'must not run' };
  });
  const root = tree();
  resetNativeForTests();
  setNativeLoadOverrideForTests({ path: prebuilt }); // Windows' decision, this machine's module
  try {
    const s = await asWindows(async () => {
      await updateSettings({ engine: 'ntfs-mft' });
      return startScan(root, { incremental: true, interactive: true });
    });
    await waitFor(() => s.status !== 'running', 'the scan settling');
    assert.equal(s.status, 'complete', s.error);
    assert.deepEqual(calls, [], 'the mode was not asked');
    assert.equal(s.engine, 'native', s.engineReason);
    assert.match(s.engineReason ?? '', /the NTFS turbo mode \([^)]*\) was not used: this is an incremental rescan, which the turbo mode does not do/);
    assert.equal(times(s.engineReason, SKIPPED), 1, s.engineReason);
  } finally {
    setMftWalkForTests(null);
    setNativeLoadOverrideForTests(null);
    resetNativeForTests();
    resetEngineBudgetForTests();
    await updateSettings({ engine: 'auto' });
  }
});
