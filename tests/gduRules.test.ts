import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gduArgs } from '../src/services/gduScanner';
import { gduRuleFor } from '../src/services/diskScanner';

/**
 * gdu on Windows (the first Windows CI run of 23 Sep 2026): v5.36.1 cannot
 * list mount points there, so `-x` made every run fail — "loading mount
 * points: Only Linux platform is supported" — and it keys no hard links
 * there either (RISKS R59), so the owner chose the built-in walker as the
 * engine that follows a native engine that cannot run.
 */

test('gdu is asked to stay on one file system only where it can list mount points: never on Windows', () => {
  assert.deepEqual(gduArgs('/o.json', '/data', [], 'darwin'), ['-n', '-x', '-o', '/o.json', '/data']);
  assert.deepEqual(gduArgs('/o.json', '/data', ['a', 'b'], 'linux'), ['-n', '-x', '-o', '/o.json', '-i', 'a,b', '/data']);
  assert.deepEqual(gduArgs('C:\\o.json', 'C:\\data', [], 'win32'), ['-n', '-o', 'C:\\o.json', 'C:\\data']);
});

test('on Windows the walker, not gdu, follows a native engine that cannot run (RISKS R59)', () => {
  const base = { forced: 'auto' as const, rootIsDir: true, incremental: false, ignoreCount: 0, noGdu: false };
  assert.equal(gduRuleFor({ ...base, platform: 'darwin' }), null);
  assert.equal(gduRuleFor({ ...base, platform: 'linux' }), null);
  assert.match(gduRuleFor({ ...base, platform: 'win32' }) ?? '', /^on Windows gdu keys no hard links/);
  assert.match(gduRuleFor({ ...base, forced: 'gdu', platform: 'win32' }) ?? '', /keys no hard links/, 'even when the setting asks for gdu: the scan says why it did not get it');
  assert.equal(gduRuleFor({ ...base, forced: 'walker', platform: 'win32' }), 'the Scan engine setting asks for the built-in walker', 'the setting’s own word comes first');
});

test('the rules that were there before are unchanged, in their order', () => {
  const base = { forced: 'auto' as const, rootIsDir: true, incremental: false, ignoreCount: 0, noGdu: false, platform: 'linux' as const };
  assert.equal(gduRuleFor({ ...base, rootIsDir: false }), 'the root is a single file, which needs no gdu process');
  assert.equal(gduRuleFor({ ...base, incremental: true }), 'this is an incremental rescan, which gdu has no cache for');
  assert.equal(gduRuleFor({ ...base, ignoreCount: 1 }), 'the scan has 1 "don\'t scan" pattern gdu cannot express');
  assert.equal(gduRuleFor({ ...base, ignoreCount: 3 }), 'the scan has 3 "don\'t scan" patterns gdu cannot express');
  assert.equal(gduRuleFor({ ...base, noGdu: true }), 'gdu is switched off by TREEMAP_NO_GDU');
  assert.equal(gduRuleFor({ ...base, rootIsDir: false, incremental: true }), 'the root is a single file, which needs no gdu process', 'first rule wins');
});
