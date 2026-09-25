import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-trashRefusal-data-');

import { moveToTrash, trashRefusal } from '../src/services/cleaner';

/**
 * RISKS R61. A name that ends in a dot or a space is one name to NTFS (made
 * from Linux, or by a program using `\\?\` paths), and Node reaches it
 * exactly; but the Windows Recycle Bin call normalizes the path the Win32
 * way and trims the dot or space, so trashing `a.` would recycle `a` if one
 * sits beside it. Such a path is refused before the call, with a sentence.
 */

test('on Windows a path with a name that ends in a dot or a space is refused, whichever part of the path it is', () => {
  for (const p of ['C:\\data\\a.', 'C:\\data\\a ', 'C:\\data\\a.\\x.txt', 'C:\\data\\b \\c', '\\\\server\\share\\x.']) {
    assert.match(trashRefusal(p, 'win32') ?? '', /Windows would trim the dot or space/, p);
  }
});

test('on Windows an ordinary name is not refused, a leading dot included', () => {
  // `.` and `..` are resolved the same way by Node and by the Recycle Bin call.
  for (const p of ['C:\\data\\a.txt', 'C:\\data\\.hidden', 'C:\\data\\a..b', 'C:\\', '\\\\server\\share\\x', 'D:/data/x', 'C:\\data\\.\\x', 'C:\\data\\..\\x']) {
    assert.equal(trashRefusal(p, 'win32'), null, p);
  }
});

test('elsewhere the name is the name: nothing is refused for its last character', () => {
  for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
    assert.equal(trashRefusal('/tmp/a.', platform), null);
    assert.equal(trashRefusal('/tmp/a ', platform), null);
  }
});

test('moveToTrash reports the refusal as the reason, and hands the path to no trash call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-trash-refusal-'));
  const file = path.join(dir, 'a.');
  fs.writeFileSync(file, 'x');
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real);
  Object.defineProperty(process, 'platform', { ...real, value: 'win32' });
  try {
    const result = await moveToTrash([file], { ignoreOpenHandles: true });
    assert.deepEqual(result.deleted, []);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].reason, /Windows would trim the dot or space/);
  } finally {
    Object.defineProperty(process, 'platform', real);
    assert.ok(fs.existsSync(file), 'the file is where it was');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
