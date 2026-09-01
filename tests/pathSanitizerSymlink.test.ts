import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sanitizePath, PathRejectedError } from '../src/utils/pathSanitizer';

/**
 * The blocklist has to survive symlinks.
 *
 * A textual blocklist answers the question "does this string start with a
 * forbidden prefix?", which is not the question anyone cares about. The
 * question is "does this path land in a forbidden directory?", and on macOS
 * those two answers disagree by default: /var, /etc and /tmp are symlinks into
 * /private, so "/private/var/db" is rejected while "/var/db" — the very same
 * directory — sails straight through. Any user, or any caller building a path
 * from a symlinked ancestor, gets the unguarded spelling for free.
 *
 * These tests are written against real symlinks in a real temp directory
 * rather than a stubbed fs, because the bug was in the gap between what the
 * string says and what the kernel does, and only the kernel can close it.
 */

const BLOCKED_TARGET = '/dev'; // in UNIX_BLOCKLIST and exists on darwin + linux

/** mkdtemp fixture; the caller removes it (rm unlinks symlinks, never follows). */
async function mkTmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'tm-sanitize-'));
}

function rejection(fn: () => unknown): PathRejectedError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof PathRejectedError, `expected PathRejectedError, got ${String(err)}`);
    return err as PathRejectedError;
  }
  assert.fail('expected sanitizePath to throw, it returned normally');
}

test('macOS /var symlink cannot smuggle a blocked directory past the blocklist', () => {
  if (process.platform !== 'darwin') return; // /var -> private/var is a macOS layout
  // /private/var/db is blocked textually today; /var/db is the same inode.
  const viaPrivate = rejection(() => sanitizePath('/private/var/db'));
  assert.equal(viaPrivate.code, 'PATH_BLOCKED');
  const viaVar = rejection(() => sanitizePath('/var/db'));
  assert.equal(viaVar.code, 'PATH_BLOCKED');
});

test('a symlink in an allowed tree pointing at a blocked tree is rejected', async () => {
  if (process.platform === 'win32') return; // symlink creation needs privilege on Windows
  const dir = await mkTmp();
  try {
    const link = path.join(dir, 'innocent-looking');
    await fsp.symlink(BLOCKED_TARGET, link);

    // The link itself.
    assert.equal(rejection(() => sanitizePath(link)).code, 'PATH_BLOCKED');

    // And anything reached *through* it: the symlink is an ancestor here, so a
    // final-component-only check would miss this one.
    assert.equal(rejection(() => sanitizePath(path.join(link, 'null'))).code, 'PATH_BLOCKED');

    // Including a child that does not exist: the deepest existing ancestor is
    // still the blocked directory, so the answer must not change just because
    // the leaf is missing.
    assert.equal(
      rejection(() => sanitizePath(path.join(link, 'not-created-yet'))).code,
      'PATH_BLOCKED',
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('unresolvable paths degrade to the textual answer instead of erroring', async () => {
  const dir = await mkTmp();
  try {
    // ENOENT: a path the caller intends to create. Must sanitize, not throw.
    const future = path.join(dir, 'does-not-exist-yet', 'report.json');
    assert.equal(sanitizePath(future), future);

    if (process.platform !== 'win32') {
      // A dangling symlink cannot be canonicalised at all (ENOENT on the
      // target). It points at nothing, so it is not a blocklist bypass — it
      // must come back as an ordinary path rather than an error.
      const dangling = path.join(dir, 'dangling');
      await fsp.symlink(path.join(dir, 'no-such-target'), dangling);
      assert.equal(sanitizePath(dangling), dangling);

      // A symlink loop (ELOOP) is the other way realpath fails. Same rule.
      const a = path.join(dir, 'loop-a');
      const b = path.join(dir, 'loop-b');
      await fsp.symlink(b, a);
      await fsp.symlink(a, b);
      assert.equal(sanitizePath(a), a);
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the caller keeps its own spelling, and re-entry is stable', async () => {
  const dir = await mkTmp();
  try {
    const once = sanitizePath(dir);
    // What we return is what the caller passed in (resolved), NOT the
    // canonical form: the returned string becomes the scan root and the label
    // in the UI, and rewriting /tmp/x to /private/tmp/x there would be a
    // visible, unasked-for change. Canonicalisation is a *test*, not a rewrite.
    assert.equal(once, path.resolve(dir));
    if (process.platform === 'darwin' && dir.startsWith('/var/')) {
      assert.ok(!once.startsWith('/private/'), 'return value must not be canonicalised');
    }
    // Every caller in this codebase re-sanitizes (middleware, then service),
    // so the function has to be idempotent — same string, same verdict.
    assert.equal(sanitizePath(once), once);

    if (process.platform !== 'win32') {
      const link = path.join(dir, 'to-blocked');
      await fsp.symlink(BLOCKED_TARGET, link);
      // Re-entry on a blocked path stays blocked (it never returns a value to
      // feed back in, which is exactly the point).
      assert.equal(rejection(() => sanitizePath(link)).code, 'PATH_BLOCKED');
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('ordinary allowed paths and cloud identifiers are untouched by canonicalisation', () => {
  const home = os.homedir();
  assert.equal(sanitizePath('~'), home);
  assert.equal(sanitizePath(path.join(home, 'Documents')), path.join(home, 'Documents'));
  // cloud:// identifiers never reach the filesystem, so realpath must not be
  // consulted for them at all.
  assert.equal(sanitizePath('cloud://gdrive/root'), 'cloud://gdrive/root');
  // A real directory that exists still resolves to itself, symlinked ancestors
  // and all — canonicalisation must not leak into the return value.
  assert.equal(sanitizePath(process.cwd()), path.resolve(process.cwd()));
});
