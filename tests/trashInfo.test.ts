import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trash-data-'));

import { getTrashInfo } from '../src/services/trash';

/**
 * What `getTrashInfo` reports when it cannot read the Trash.
 *
 * This had no test of any kind, and the gap was not academic. On macOS
 * `~/.Trash` is TCC-protected: a build without Full Disk Access gets `EPERM`
 * from `readdir`, which was swallowed with `continue`. Measured on the
 * maintainer's own Mac, against a Trash that plainly was not empty:
 *
 *     { complete: false, totalBytes: 0, itemCount: 0 }   ← now
 *     { totalBytes: 0, itemCount: 0 }                    ← before, presented as fact
 *
 * and the UI turned that zero into "The Trash is empty.", a disabled Empty
 * Trash button, and an `emptyTrash()` that returned `emptied: true` without
 * running anything. A disk-space tool telling someone their full Trash is
 * empty is the worst shape this bug class takes.
 */

const liveFs = require('fs').promises as typeof import('fs').promises;

/** Fail `readdir` for one path suffix with a given errno. */
function failReaddir(match: string, code: string): () => void {
  const original = liveFs.readdir;
  (liveFs as unknown as { readdir: unknown }).readdir = async (p: unknown, ...rest: unknown[]): Promise<unknown> => {
    if (String(p).endsWith(match)) {
      const err: NodeJS.ErrnoException = new Error(`${code}: injected, readdir`);
      err.code = code;
      throw err;
    }
    return (original as unknown as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
  };
  return () => {
    (liveFs as unknown as { readdir: unknown }).readdir = original;
  };
}

test('a readable Trash reports a complete sweep', async () => {
  const info = await getTrashInfo();
  assert.equal(typeof info.complete, 'boolean', 'completeness is always stated');
  assert.ok(info.totalBytes >= 0);
  assert.ok(info.itemCount >= 0);
  // On a machine that CAN read it, the reason must be absent — an
  // "at least" caveat on a complete measurement is its own kind of dishonesty.
  if (info.complete) assert.equal(info.incompleteReason, undefined);
});

test('an unreadable Trash is reported as incomplete, not as empty', async () => {
  const restore = failReaddir('.Trash', 'EPERM');
  try {
    const info = await getTrashInfo();
    assert.equal(info.complete, false, 'the sweep says it did not finish');
    assert.ok(info.incompleteReason && info.incompleteReason.length > 0, 'and says why, in a sentence');
    assert.match(info.incompleteReason!, /Full Disk Access|permission/i, 'the reason names something the user can act on');
  } finally {
    restore();
  }
});

test('a vanished Trash location is NOT reported as a problem', async () => {
  // `trashDirs` synthesises a path per mounted volume, so most of them
  // legitimately do not exist. Treating ENOENT as a failure would put an
  // "at least" caveat on every complete measurement, which trains people to
  // ignore it — the caveat has to mean something.
  const restore = failReaddir('.Trash', 'ENOENT');
  try {
    const info = await getTrashInfo();
    assert.equal(info.complete, true, 'an absent location is not an unreadable one');
    assert.equal(info.incompleteReason, undefined);
  } finally {
    restore();
  }
});

test('any unreadable errno counts, not just the one that was seen in the wild', async () => {
  // EPERM is what this Mac produces, but the rule is about the CLASS. If the
  // check were written against EPERM alone, an EACCES or EIO Trash would go
  // back to reporting a confident zero.
  for (const code of ['EACCES', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
    const restore = failReaddir('.Trash', code);
    try {
      const info = await getTrashInfo();
      assert.equal(info.complete, false, `${code} must mark the sweep incomplete`);
      assert.ok(info.incompleteReason, `${code} must carry a reason`);
    } finally {
      restore();
    }
  }
});

/*
 * Not tested here, and deliberately: the sub-DIRECTORY failure path inside
 * `dirSize`, and the 200,000-entry budget. Both set the same flag through the
 * same helper as the cases above, and reaching them from outside the module
 * would need either a fixture inside the real Trash (which this machine
 * cannot read at all) or an export invented for the test. An assertion that
 * cannot fail is worse than an admitted gap.
 */

test('emptying an unreadable Trash is never reported as a success', async () => {
  // The short-circuit at the top of `emptyTrash` was fixed first, and the same
  // wrong conclusion survived at the bottom: `after.itemCount === 0` was read
  // as "it is empty now" when it actually meant "still nothing visible". Every
  // emptier could throw and the result was `emptied: true, freedBytes: 0,
  // failed: []` — the failures discarded — which the UI toasts as "Trash
  // emptied".
  const { emptyTrash } = await import('../src/services/trash');
  const restore = failReaddir('.Trash', 'EPERM');
  try {
    const result = await emptyTrash();
    assert.equal(result.emptied, false, 'nothing can be claimed about a Trash that could not be read');
  } finally {
    restore();
  }
});
