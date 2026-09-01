import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PathRejectedError, sanitizePath } from '../src/utils/pathSanitizer';

/**
 * The blocklist must judge the leaf by its ON-DISK name, not the caller's.
 *
 * `canonicalize()` was split for cost: the directory chain goes through a memo
 * (one realpath per folder instead of one per file, which matters because
 * `guardBodyPathsMax` maps sanitizePath over batches of up to 2,000), and the
 * leaf gets an `lstat` that asks only "is this a symlink?".
 *
 * That question is too narrow. A symlink is not the only way the name a caller
 * types differs from the name the kernel uses:
 *
 *  - **macOS** mounts its boot volume case-INSENSITIVE but case-PRESERVING, so
 *    `/DEV` is not a symlink, is not a separate directory, and opens `/dev`.
 *    `lstat('/DEV')` reports an ordinary directory; only realpath says `/dev`.
 *  - **Windows** strips trailing spaces and dots from the last component inside
 *    the OS, so `C:\Windows\System32 ` and `C:\Windows\System32` are the same
 *    directory to every file API — and since this session stopped trimming the
 *    tail (correctly: a trailing space is legal filename data on POSIX), the
 *    string reaching the blocklist keeps a space the filesystem will ignore.
 *
 * Either way the textual test misses and a blocked directory becomes a legal
 * scan root. The whole-path realpath this replaced could not miss it.
 *
 * The fix must not give back the cost, so it cannot simply realpath every leaf.
 * The narrow question is: could this leaf, spelled differently, LAND in the
 * blocklist? That is only possible when the canonical parent is at or above a
 * blocked directory — a string test — so the extra syscall is paid on `/`,
 * `/private/var` and `C:\Windows`, and never on the 2,000 files in someone's
 * Downloads folder.
 */

const isDarwin = process.platform === 'darwin';
const isWin = process.platform === 'win32';

function rejection(fn: () => unknown): PathRejectedError {
  try {
    fn();
  } catch (err) {
    if (err instanceof PathRejectedError) return err;
    throw err;
  }
  return assert.fail('expected sanitizePath to throw, it returned normally');
}

test('a case-variant spelling of a blocked directory is still blocked', {
  skip: !isDarwin && 'the default macOS boot volume is case-insensitive; /DEV is a distinct name elsewhere',
}, () => {
  // Guard the premise: if this machine's volume is case-SENSITIVE then /DEV is
  // genuinely a different (absent) path and there is nothing to block, so the
  // test would be asserting nothing. Prove the alias is real before using it.
  const aliased = fs.existsSync('/DEV') && fs.realpathSync.native('/DEV') === '/dev';
  if (!aliased) return assert.ok(true, 'case-sensitive volume: /DEV is not an alias for /dev here');

  assert.equal(rejection(() => sanitizePath('/dev')).code, 'PATH_BLOCKED', 'the canonical spelling');
  assert.equal(rejection(() => sanitizePath('/DEV')).code, 'PATH_BLOCKED', 'and the alias the kernel accepts');
  assert.equal(rejection(() => sanitizePath('/Dev/null')).code, 'PATH_BLOCKED', 'including a child through it');
});

test('a trailing space or dot cannot smuggle a blocked Windows directory', {
  skip: !isWin && 'trailing spaces and dots are only normalised away by Win32',
}, () => {
  for (const spelling of ['C:\\Windows\\System32 ', 'C:\\Windows\\System32.', 'C:\\Windows\\SYSTEM32 ']) {
    assert.equal(
      rejection(() => sanitizePath(spelling)).code, 'PATH_BLOCKED',
      `${JSON.stringify(spelling)} is the same directory as C:\\Windows\\System32 to every Win32 file API`,
    );
  }
});

test('the ordinary case still pays no extra syscall', () => {
  // The cost fix is the reason the leaf is not realpathed unconditionally, so
  // it has to keep holding: a batch of files in a folder nowhere near the
  // blocklist must not add a realpath per file.
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tm-leaf-'));
  try {
    const real = fs.realpathSync.native;
    let calls = 0;
    (fs.realpathSync as unknown as { native: typeof real }).native = ((p: string) => {
      calls++;
      return real(p);
    }) as typeof real;
    try {
      for (let i = 0; i < 200; i++) sanitizePath(path.join(dir, `f${i}.bin`));
    } finally {
      (fs.realpathSync as unknown as { native: typeof real }).native = real;
    }
    assert.ok(calls <= 4, `200 paths in one ordinary folder must not realpath per file, got ${calls}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a path whose parent sits above the blocklist still resolves normally when it is not blocked', () => {
  // The extra check must not become a refusal. `/Users` and `/System` are above
  // blocked entries on macOS and must stay perfectly legal.
  for (const p of [require('node:os').homedir(), require('node:os').tmpdir()]) {
    assert.equal(sanitizePath(p), path.resolve(p), `${p} is not blocked and must come back unchanged`);
  }
});
