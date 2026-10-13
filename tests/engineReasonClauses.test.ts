import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-engineReasonClauses-data-');

import { getScan, setMftWalkForTests, startScan } from '../src/services/diskScanner';
import { resetNativeForTests } from '../src/services/scan/native';
import { resetEngineBudgetForTests, setNativeLoadOptionsForTests } from '../src/services/engineBudget';
import { updateSettings } from '../src/services/settings';
import { settled } from '../src/utils/backgroundWrites';
import type { EngineSetting, ScanResult } from '../src/models/types';

/**
 * QA D45 and D75 (5 Oct 2026): the engine sentence the page shows on hover
 * named one cause twice — "this is an incremental rescan, and the mtime cache
 * it reuses belongs to the built-in walker; this is an incremental rescan,
 * which gdu has no cache for", and the same for a "don't scan" pattern and a
 * single-file root — because each engine the scan passed over gave its own
 * sentence for the one cause. A cause is now said once, in the words of the
 * first engine it kept off; a different cause for each engine still names
 * both.
 */

after(async () => {
  setMftWalkForTests(null);
  await updateSettings({ engine: 'auto', ignore: [] });
  await settled();
});

/** root/{a.bin, keep/b.bin, skip/c.bin}. */
function tree(): string {
  const root = fs.realpathSync(fileTempDir('treemap-engineReasonClauses-'));
  fs.mkdirSync(path.join(root, 'keep'));
  fs.mkdirSync(path.join(root, 'skip'));
  fs.writeFileSync(path.join(root, 'a.bin'), 'aaaa');
  fs.writeFileSync(path.join(root, 'keep', 'b.bin'), 'bb');
  fs.writeFileSync(path.join(root, 'skip', 'c.bin'), 'c');
  return root;
}

async function scanOf(root: string, engine: EngineSetting, opts: Parameters<typeof startScan>[1] = {}): Promise<ScanResult> {
  await updateSettings({ engine });
  const s = await startScan(root, opts);
  await waitFor(() => s.status !== 'running', `the scan of ${root} settling`);
  assert.equal(s.status, 'complete', s.error);
  await settled();
  return getScan(s.scanId) ?? s;
}

/** How many times `pattern` occurs in `text`. */
const times = (text: string | undefined, pattern: RegExp): number => (text ?? '').match(new RegExp(pattern.source, 'g'))?.length ?? 0;

test('a "don\'t scan" pattern is said once, though it kept two engines off (D75)', async () => {
  const root = tree();
  await updateSettings({ ignore: [{ pattern: 'skip', scope: 'scan' }] });
  try {
    const scan = await scanOf(root, 'auto');
    assert.ok(scan.engine === 'walker' || scan.engine === 'turbo-walker', scan.engine);
    assert.equal(times(scan.engineReason, /"don't scan" pattern/), 1, scan.engineReason);
    assert.match(scan.engineReason ?? '', /the scan has 1 "don't scan" pattern, and only the built-in walker can skip what a pattern names/, 'in the words of the first engine it kept off');
    assert.doesNotMatch(scan.engineReason ?? '', /glob|dialect/, 'in plain words: the Dashboard shows it (C10)');
  } finally {
    await updateSettings({ ignore: [] });
  }
});

test('a single-file root is said once, though it kept two engines off', async () => {
  const root = tree();
  const scan = await scanOf(path.join(root, 'a.bin'), 'auto');
  assert.equal(times(scan.engineReason, /single file/), 1, scan.engineReason);
});

/**
 * gdu's own rule on Windows, where it is never wanted (RISKS R59, `gduRuleFor`): there it is the one gdu
 * always gives, so its rules for a fast rescan or a "don't scan" pattern never speak, and neither the
 * fast rescan nor the pattern is a cause of anything being kept off.
 */
const GDU_ON_WINDOWS = /on Windows gdu keys no hard links \(it reads every file id as 0\), so a tree that has them would be counted more than once; the built-in walker keys them by file id/;

/**
 * A fast rescan the walker serves, where the native engine cannot run: the second scan of a tree, its
 * engine chosen with `platform` standing in for this machine's (`asWindows`) or as this machine is.
 */
async function walkerFastRescan(platform: 'here' | 'win32'): Promise<ScanResult> {
  const root = tree();
  resetNativeForTests();
  resetEngineBudgetForTests();
  setNativeLoadOptionsForTests({ path: path.join(os.tmpdir(), 'treemap-no-native-here.node') });
  try {
    await scanOf(root, 'auto');
    await updateSettings({ engine: 'auto' });
    const start = (): Promise<ScanResult> => startScan(root, { incremental: true });
    const scan = platform === 'win32' ? await asWindows(start) : await start();
    await waitFor(() => scan.status !== 'running', `the fast rescan of ${root} settling`);
    assert.equal(scan.status, 'complete', scan.error);
    await settled();
    return getScan(scan.scanId) ?? scan;
  } finally {
    setNativeLoadOptionsForTests(null);
    resetNativeForTests();
    resetEngineBudgetForTests();
  }
}

/** A scan the gdu setting asks for, with one "don't scan" pattern, its engine chosen as `walkerFastRescan`'s is. */
async function gduWithPattern(platform: 'here' | 'win32'): Promise<ScanResult> {
  const root = tree();
  await updateSettings({ ignore: [{ pattern: 'skip', scope: 'scan' }] });
  try {
    await updateSettings({ engine: 'gdu' });
    const start = (): Promise<ScanResult> => startScan(root);
    const scan = platform === 'win32' ? await asWindows(start) : await start();
    resetNativeForTests(); // Windows may have sent the loader looking for a Windows module
    await waitFor(() => scan.status !== 'running', `the scan of ${root} settling`);
    assert.equal(scan.status, 'complete', scan.error);
    await settled();
    return getScan(scan.scanId) ?? scan;
  } finally {
    await updateSettings({ ignore: [] });
  }
}

/** The fast rescan's sentence as `platform` gives it: each cause once — and on Windows the fast rescan is none. */
function assertFastRescanSaidOnce(scan: ScanResult, platform: NodeJS.Platform): void {
  assert.ok(scan.engine === 'walker' || scan.engine === 'turbo-walker', scan.engine);
  if (platform === 'win32') {
    assert.equal(times(scan.engineReason, GDU_ON_WINDOWS), 1, `gdu's rule on Windows, once: ${scan.engineReason}`);
    assert.equal(times(scan.engineReason, /incremental rescan/), 0, `no engine was kept off for a fast rescan: ${scan.engineReason}`);
  } else {
    assert.equal(times(scan.engineReason, /incremental rescan/), 1, scan.engineReason);
  }
}

/** The gdu setting and what refused it, both said: the pattern — or on Windows gdu's own rule there. */
function assertSettingAndCauseSaid(scan: ScanResult, platform: NodeJS.Platform): void {
  if (platform === 'win32') {
    assert.match(scan.engineReason ?? '', new RegExp(`the Scan engine setting asks for gdu; ${GDU_ON_WINDOWS.source}`));
  } else {
    assert.match(scan.engineReason ?? '', /the Scan engine setting asks for gdu; the scan has 1 "don't scan" pattern gdu cannot express/);
  }
}

test('an incremental rescan the walker serves is said once (D45)', async () => {
  // Where the native engine can run, a fast-rescan request no longer keeps it
  // off (tests/fastRescanEngine.test.ts); without one, gdu's rule says it.
  assertFastRescanSaidOnce(await walkerFastRescan('here'), process.platform);
});

test('two causes are both said: a gdu setting refused by a pattern names the setting and the pattern', async () => {
  assertSettingAndCauseSaid(await gduWithPattern('here'), process.platform);
});

test('on Windows gdu\'s own rule is the one it gives (R59), said once: a fast rescan the walker serves names no rescan as a cause, and a gdu setting names the setting and that rule (Windows stood in where this is not Windows)', async () => {
  assertFastRescanSaidOnce(await walkerFastRescan('win32'), 'win32');
  assertSettingAndCauseSaid(await gduWithPattern('win32'), 'win32');
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

test('the NTFS turbo mode kept off by a pattern says it once, for the mode and the engines after it', async () => {
  const calls: string[] = [];
  setMftWalkForTests(async (_scan, _store, rootPath) => {
    calls.push(rootPath);
    return { used: false, failed: false, reason: 'must not run' };
  });
  const root = tree();
  await updateSettings({ ignore: [{ pattern: 'skip', scope: 'scan' }] });
  try {
    const scan = await asWindows(async () => {
      await updateSettings({ engine: 'ntfs-mft' });
      return startScan(root, { interactive: true });
    });
    resetNativeForTests(); // Windows sent the loader looking for a Windows module
    resetEngineBudgetForTests();
    await waitFor(() => scan.status !== 'running', 'the scan settling');
    assert.equal(scan.status, 'complete', scan.error);
    assert.deepEqual(calls, [], 'the mode was not asked');
    assert.match(scan.engineReason ?? '', /the NTFS turbo mode \([^)]*\) was not used: the scan has 1 "don't scan" pattern/);
    assert.equal(times(scan.engineReason, /"don't scan" pattern/), 1, scan.engineReason);
  } finally {
    await updateSettings({ ignore: [] });
  }
});
