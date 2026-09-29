import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-snapshotMount-data-');

import { unmountAndRemove } from '../src/platform/macos/tmutil';

/** Console errors written while `run` runs, returned; nothing reaches the test's output. */
async function capturingErrors(run: () => Promise<void>): Promise<string[]> {
  const said: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => { said.push(args.map(String).join(' ')); };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return said;
}

test('a snapshot mount point is removed without recursion: a mount that did not come off is never walked into', async () => {
  // A folder with a file in it stands in for a snapshot still mounted there
  // (busy, or mounted after its command timed out). `umount` fails on it, as
  // nothing is mounted, which is the case under test: the folder must not be
  // emptied. A read-only snapshot would refuse every unlink anyway; nothing
  // here may rely on that.
  const mountPoint = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-snap-test-'));
  const inside = path.join(mountPoint, 'a-file-in-the-snapshot.txt');
  await fsp.writeFile(inside, 'x');
  try {
    const said = await capturingErrors(() => unmountAndRemove(mountPoint));
    assert.ok(fs.existsSync(inside), 'nothing inside a mount point that is still there is deleted');
    assert.ok(fs.existsSync(mountPoint), 'and the folder stays, since it is not empty');
    assert.equal(said.length, 1, 'a mount that stays is said, not swallowed');
    assert.match(said[0] ?? '', new RegExp(`${path.basename(mountPoint)}.*pins the snapshot's storage`));
  } finally {
    await fsp.rm(mountPoint, { recursive: true, force: true });
  }
});

test('an empty mount point is removed, and nothing is said', async () => {
  const mountPoint = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-snap-test-'));
  const said = await capturingErrors(() => unmountAndRemove(mountPoint));
  assert.equal(fs.existsSync(mountPoint), false, 'the folder the snapshot was mounted on is gone');
  assert.deepEqual(said, []);
});

test('a mount point already gone is not an error', async () => {
  const mountPoint = path.join(os.tmpdir(), `treemap-snap-test-gone-${process.pid}`);
  const said = await capturingErrors(() => unmountAndRemove(mountPoint));
  assert.deepEqual(said, []);
});
