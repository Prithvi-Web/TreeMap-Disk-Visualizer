import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-trashRefusal-data-');

import { moveToTrash, setTrashStepForTests, trashRefusal } from '../src/services/cleaner';

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
  // The Trash step is a stand-in that records what it is handed: until 30 Sep 2026 this test
  // drove the machine's own Trash step, trusting the refusal inside it to stop the call.
  const handed: string[] = [];
  setTrashStepForTests(async (p) => {
    handed.push(p);
  });
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real);
  Object.defineProperty(process, 'platform', { ...real, value: 'win32' });
  try {
    const result = await moveToTrash([file], { ignoreOpenHandles: true });
    assert.deepEqual(handed, [], 'no Trash step was handed the path, not even a stand-in');
    assert.deepEqual(result.deleted, []);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].reason, /Windows would trim the dot or space/);
  } finally {
    Object.defineProperty(process, 'platform', real);
    setTrashStepForTests(null);
    assert.ok(fs.existsSync(file), 'the file is where it was');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a path Windows would trim reads as gone when it is gone and as refused when it is there, in either order, and no Trash step is handed either', async () => {
  // Until 30 Sep 2026 (FG2) the refusal sat inside the Trash step, after the step's own lstat, so a
  // path that had gone since the scan read as gone. Moved ahead of every Trash step, it read as the
  // refusal instead — a sentence about renaming a file that is not there.
  const dir = fileTempDir('treemap-trash-refusal-');
  const there = path.join(dir, 'a.');
  const gone = path.join(dir, 'b.');
  fs.writeFileSync(there, 'x');
  const handed: string[] = [];
  setTrashStepForTests(async (p) => {
    handed.push(p);
  });
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real);
  Object.defineProperty(process, 'platform', { ...real, value: 'win32' });
  try {
    for (const order of [[gone, there], [there, gone]]) {
      const result = await moveToTrash(order, { ignoreOpenHandles: true });
      assert.deepEqual(result.deleted, [], `nothing was trashed: ${JSON.stringify(result)}`);
      assert.deepEqual(result.failed.map((f) => f.path), order, 'each path answers, in the order asked');
      const reason = new Map(result.failed.map((f) => [f.path, f.reason]));
      assert.equal(reason.get(gone), 'it is no longer there', `the path that is gone reads as gone (${order.map((p) => path.basename(p)).join(', ')})`);
      assert.match(reason.get(there) ?? '', /Windows would trim the dot or space/, `the path still there is refused (${order.map((p) => path.basename(p)).join(', ')})`);
    }
    assert.deepEqual(handed, [], 'no Trash step was handed either path, not even a stand-in');
  } finally {
    Object.defineProperty(process, 'platform', real);
    setTrashStepForTests(null);
  }
  assert.ok(fs.existsSync(there), 'the file is where it was');
});
