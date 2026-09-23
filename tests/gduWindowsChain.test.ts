import { test, after } from 'node:test';
import { skipOrFailOnCi } from './fixtures/ciSkip';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-gdu-windows-chain-'));
process.env.TREEMAP_DATA_DIR = DATA_DIR;
delete process.env.TREEMAP_NO_GDU;

import { startScan } from '../src/services/diskScanner';
import { findGduBinary } from '../src/services/gduScanner';
import { resetNativeForTests, setNativeLoadOverrideForTests } from '../src/services/scan/native';
import { settled } from '../src/utils/backgroundWrites';
import type { ScanResult } from '../src/models/types';

/**
 * RISKS R59, as startScan runs it: with no native module, a Windows scan is
 * the walker's, never gdu's (gdu keys no hard links there). Windows only while
 * startScan decides — synchronously, before its walk — so the walk runs as
 * this machine; the calibration first shows this machine would use gdu.
 */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-gdu-windows-chain-root-'));
fs.writeFileSync(path.join(ROOT, 'a.bin'), 'aaaa');

after(() => {
  setNativeLoadOverrideForTests(null);
  resetNativeForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

async function done(scan: ScanResult): Promise<ScanResult> {
  const deadline = Date.now() + 20_000;
  while (scan.status === 'running') {
    if (Date.now() > deadline) assert.fail('the scan did not settle');
    await new Promise((r) => setTimeout(r, 5));
  }
  await settled();
  return scan;
}

async function scanAs(platform: NodeJS.Platform): Promise<ScanResult> {
  resetNativeForTests();
  setNativeLoadOverrideForTests({ path: path.join(os.tmpdir(), 'treemap-no-native-here.node') });
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real && 'value' in real);
  Object.defineProperty(process, 'platform', { ...real, value: platform });
  let scan: ScanResult;
  try {
    scan = await startScan(ROOT);
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
  return done(scan);
}

test('with no native module a Windows scan is the walker’s, never gdu’s, and says why', { skip: process.platform === 'win32' && 'the calibration needs a platform where gdu is wanted' }, async (t) => {
  if (!(await findGduBinary())) return skipOrFailOnCi(t, 'no gdu binary on this machine, so nothing would choose it');
  const here = await scanAs(process.platform);
  assert.equal(here.engine, 'gdu-turbo', `calibration: this machine picks gdu (${here.engineReason})`);
  const windows = await scanAs('win32');
  assert.equal(windows.status, 'complete', windows.error);
  assert.ok(windows.engine === 'walker' || windows.engine === 'turbo-walker', `${windows.engine}: ${windows.engineReason}`);
  assert.match(windows.engineReason ?? '', /on Windows gdu keys no hard links/);
});
