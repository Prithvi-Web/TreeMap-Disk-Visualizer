import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-engineReasonClauses-data-');

import { getScan, setMftWalkForTests, startScan } from '../src/services/diskScanner';
import { resetNativeForTests } from '../src/services/scan/native';
import { resetEngineBudgetForTests } from '../src/services/engineBudget';
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
    assert.match(scan.engineReason ?? '', /the glob dialect that honours them lives in the built-in walker/, 'in the words of the first engine it kept off');
  } finally {
    await updateSettings({ ignore: [] });
  }
});

test('a single-file root is said once, though it kept two engines off', async () => {
  const root = tree();
  const scan = await scanOf(path.join(root, 'a.bin'), 'auto');
  assert.equal(times(scan.engineReason, /single file/), 1, scan.engineReason);
});

test('an incremental rescan is said once, though it kept two engines off (D45)', async () => {
  const root = tree();
  await scanOf(root, 'auto');
  const scan = await scanOf(root, 'auto', { incremental: true });
  assert.ok(scan.engine === 'walker' || scan.engine === 'turbo-walker', scan.engine);
  assert.equal(times(scan.engineReason, /incremental rescan/), 1, scan.engineReason);
});

test('two causes are both said: a gdu setting refused by a pattern names the setting and the pattern', async () => {
  const root = tree();
  await updateSettings({ ignore: [{ pattern: 'skip', scope: 'scan' }] });
  try {
    const scan = await scanOf(root, 'gdu');
    assert.match(scan.engineReason ?? '', /the Scan engine setting asks for gdu; the scan has 1 "don't scan" pattern gdu cannot express/);
  } finally {
    await updateSettings({ ignore: [] });
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
