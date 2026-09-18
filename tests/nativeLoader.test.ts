import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadNative, nativeCandidates, resetNativeForTests } from '../src/services/scan/native';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { nativeVersion: string };

test('a module that is not there is reported, never thrown, with the path and the platform in the reason', () => {
  resetNativeForTests();
  const missing = path.join(os.tmpdir(), 'treemap-no-such-module.node');
  const r = loadNative({ path: missing });
  assert.equal(r.available, false);
  if (r.available) return;
  assert.ok(r.reason.includes(missing), r.reason);
  assert.ok(r.reason.includes(`${process.platform}-${process.arch}`), r.reason);
});

test('a file that is not a module is refused with the loader error in the reason', () => {
  resetNativeForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-native-'));
  try {
    const bogus = path.join(dir, 'treemap_core.node');
    fs.writeFileSync(bogus, 'not a shared library');
    const r = loadNative({ path: bogus });
    assert.equal(r.available, false);
    if (r.available) return;
    assert.ok(r.reason.length > 20, r.reason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a version other than the one package.json expects is refused, naming both', () => {
  resetNativeForTests();
  const r = loadNative({
    path: '/fake/treemap_core.node',
    requireModule: () => ({ version: () => '9.9.9' }),
  });
  assert.equal(r.available, false);
  if (r.available) return;
  assert.ok(r.reason.includes('9.9.9') && r.reason.includes(pkg.nativeVersion), r.reason);
});

test('a module with the expected version loads and the outcome is cached until reset', () => {
  resetNativeForTests();
  let calls = 0;
  const fake = { version: () => pkg.nativeVersion };
  const first = loadNative({ path: '/fake/treemap_core.node', requireModule: () => { calls += 1; return fake; } });
  assert.equal(first.available, true);
  const second = loadNative({ path: '/fake/treemap_core.node', requireModule: () => { calls += 1; return fake; } });
  assert.equal(second.available, true);
  assert.equal(calls, 1, 'the second call reused the first outcome');
  resetNativeForTests();
});

test('the candidate list starts with the environment override and names the prebuilt path for this platform', () => {
  const withEnv = nativeCandidates({ TREEMAP_NATIVE_MODULE: '/override/x.node' });
  assert.equal(withEnv[0], '/override/x.node');
  const plain = nativeCandidates({});
  assert.ok(plain.some((p) => p.endsWith(path.join('native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node'))), plain.join('\n'));
});
