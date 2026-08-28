import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The Trash sweep, and what it reports when it cannot read.
 *
 * **Every test here runs against a directory it owns**, via
 * `TREEMAP_TRASH_DIR`. That is not tidiness. The first version of this file
 * injected a `readdir` failure matched on the suffix `.Trash` — the macOS
 * layout — and called the real `emptyTrash()`. Two things followed:
 *
 *   - on Linux and Windows the injection could never fire, because their
 *     trash directories end in `Trash/files` and `$Recycle.Bin`, so two
 *     assertions would have failed on CI;
 *   - on macOS the injection DID fire, and that was worse. An unreadable
 *     Trash is exactly the state in which `emptyTrash` declines to
 *     short-circuit and runs `osascript … empty trash`. It emptied the
 *     maintainer's own Trash, on every full-suite run, for about eighteen
 *     runs before a review caught it.
 *
 * A test that can irreversibly delete a user's data must not be able to reach
 * the real location at all, so the boundary is in the source rather than in
 * this file's good intentions.
 */

const liveFs = require('fs').promises as typeof import('fs').promises;

/** A trash-shaped directory this test owns, with the app pointed at it. */
async function withTrash<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trash-fixture-'));
  const prior = process.env.TREEMAP_TRASH_DIR;
  process.env.TREEMAP_TRASH_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prior === undefined) delete process.env.TREEMAP_TRASH_DIR;
    else process.env.TREEMAP_TRASH_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Fail `readdir` for one exact directory with a given errno. */
function failReaddir(target: string, code: string): () => void {
  const original = liveFs.readdir;
  (liveFs as unknown as { readdir: unknown }).readdir = async (p: unknown, ...rest: unknown[]): Promise<unknown> => {
    if (String(p) === target) {
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

test('a readable Trash is measured, and says so', async () => {
  await withTrash(async (dir) => {
    const { getTrashInfo } = await import('../src/services/trash');
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(4096));
    await fsp.writeFile(path.join(dir, 'b.bin'), Buffer.alloc(2048));
    const info = await getTrashInfo();
    assert.equal(info.complete, true, 'the sweep finished');
    assert.equal(info.incompleteReason, undefined, 'so it carries no caveat — the caveat has to mean something');
    assert.equal(info.itemCount, 2);
    assert.equal(info.totalBytes, 6144);
  });
});

test('an unreadable Trash is reported as incomplete, not as empty', async () => {
  // The live case on the maintainer's Mac: `~/.Trash` is TCC-protected, so
  // `readdir` returns EPERM and every failure used to be swallowed. The app
  // reported zero bytes, rendered "The Trash is empty.", and disabled the
  // Empty Trash button — about a Trash that was not empty.
  await withTrash(async (dir) => {
    const { getTrashInfo } = await import('../src/services/trash');
    await fsp.writeFile(path.join(dir, 'unseen.bin'), Buffer.alloc(4096));
    const restore = failReaddir(dir, 'EPERM');
    try {
      const info = await getTrashInfo();
      assert.equal(info.complete, false, 'the sweep says it did not finish');
      assert.equal(info.itemCount, 0, 'and reports what it could see, which is nothing');
      assert.ok(info.incompleteReason, 'with a reason');
      assert.match(info.incompleteReason!, /Full Disk Access|permission/i, 'naming something the user can act on');
    } finally {
      restore();
    }
  });
});

test('a vanished Trash location is NOT a problem', async () => {
  // `trashDirs` synthesises a path per mounted volume, so most legitimately do
  // not exist. Treating ENOENT as a failure would put an "at least" caveat on
  // every complete measurement, which trains people to ignore it.
  await withTrash(async (dir) => {
    const { getTrashInfo } = await import('../src/services/trash');
    const restore = failReaddir(dir, 'ENOENT');
    try {
      const info = await getTrashInfo();
      assert.equal(info.complete, true, 'an absent location is not an unreadable one');
      assert.equal(info.incompleteReason, undefined);
    } finally {
      restore();
    }
  });
});

test('any unreadable errno counts, not just the one seen in the wild', async () => {
  // EPERM is what this Mac produces, but the rule is about the CLASS. Written
  // against EPERM alone, an EACCES or EIO Trash would go back to reporting a
  // confident zero.
  await withTrash(async (dir) => {
    const { getTrashInfo } = await import('../src/services/trash');
    for (const code of ['EACCES', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
      const restore = failReaddir(dir, code);
      try {
        const info = await getTrashInfo();
        assert.equal(info.complete, false, `${code} must mark the sweep incomplete`);
        assert.ok(info.incompleteReason, `${code} must carry a reason`);
      } finally {
        restore();
      }
    }
  });
});

test('emptying really empties, and says so', async () => {
  await withTrash(async (dir) => {
    const { emptyTrash } = await import('../src/services/trash');
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(4096));
    await fsp.mkdir(path.join(dir, 'folder'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'folder', 'b.bin'), Buffer.alloc(2048));

    const result = await emptyTrash();
    assert.equal(result.emptied, true, 'it ran, it finished, and it can see that it did');
    assert.deepEqual(result.failed, []);
    assert.deepEqual(await fsp.readdir(dir), [], 'the directory really is empty');
  });
});

test('emptying an unreadable Trash is never reported as a success', async () => {
  // `after.itemCount === 0` means "still nothing visible", not "it is empty
  // now". Every emptier could fail and the result was
  // `emptied: true, freedBytes: 0, failed: []` — which the UI toasts as
  // "Trash emptied".
  await withTrash(async (dir) => {
    const { emptyTrash } = await import('../src/services/trash');
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(4096));
    const restore = failReaddir(dir, 'EPERM');
    try {
      const result = await emptyTrash();
      assert.equal(result.emptied, false, 'nothing can be claimed about a Trash that could not be read');
    } finally {
      restore();
    }
  });
});

/*
 * Not tested here, deliberately: the platform emptiers themselves
 * (`osascript`, `Clear-RecycleBin`, `gio trash --empty`). They take no path
 * argument, so there is no way to exercise them without emptying the real
 * Trash of whoever is running the suite — which is precisely the mistake this
 * file was rewritten to make impossible. `emptyTrashCommands()` is a pure
 * function and its output is asserted in `tests/platformCrossOs.test.ts`.
 */
