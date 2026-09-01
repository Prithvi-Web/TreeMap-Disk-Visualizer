import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PathRejectedError, sanitizePath } from '../src/utils/pathSanitizer';

/**
 * A macOS firmlink is not a symlink, and `realpath` does not collapse it.
 *
 * Since Catalina the system volume is sealed and read-only, and the writable
 * Data volume is mounted at `/System/Volumes/Data` and *firmlinked* into the
 * root: `/private`, `/Users`, `/Applications`, `/var`, `/opt` and the rest are
 * the same directories under both spellings. Firmlinks are a volume-level
 * mount feature, not links in the filesystem, so `realpath(3)` reports each
 * spelling as itself:
 *
 *   realpath('/System/Volumes/Data/private/var') -> '/System/Volumes/Data/private/var'
 *   stat('/private/var/db').ino === stat('/System/Volumes/Data/private/var/db').ino
 *
 * The blocklist was therefore reachable by its alias — `sanitizePath` accepted
 * `/System/Volumes/Data/private/var/db`, which is byte-for-byte the directory
 * holding `dslocal`, the local account database. Canonicalising harder does not
 * help: no amount of symlink resolution turns one spelling into the other.
 *
 * This is NOT a regression from the canonicalize refactor — the whole-path
 * realpath it replaced accepted the same input — which is exactly why it needed
 * finding on purpose rather than waiting for a diff to blame.
 *
 * Two defences, because the string one is complete for the documented layout
 * and the identity one is the backstop for anything undocumented:
 *  - the Data-volume prefix is stripped from the canonical form, which covers
 *    the whole tree beneath an aliased directory at zero syscall cost;
 *  - a candidate whose last component matches a blocked directory's name is
 *    compared by device+inode, which catches an alias no string rule predicts.
 */

const isDarwin = process.platform === 'darwin';

/** Is the firmlink layout actually present on this machine? */
function aliasIsReal(): boolean {
  if (!isDarwin) return false;
  try {
    const a = fs.statSync('/private/var/db');
    const b = fs.statSync('/System/Volumes/Data/private/var/db');
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function rejection(fn: () => unknown): PathRejectedError {
  try {
    fn();
  } catch (err) {
    if (err instanceof PathRejectedError) return err;
    throw err;
  }
  return assert.fail('expected sanitizePath to throw, it returned normally');
}

test('the Data-volume alias of a blocked directory is refused', {
  skip: !isDarwin && 'firmlinks are a macOS APFS feature',
}, () => {
  if (!aliasIsReal()) return assert.ok(true, 'this machine has no /System/Volumes/Data firmlink layout');
  for (const p of [
    '/System/Volumes/Data/private/var/db',
    '/System/Volumes/Data/private/var/db/dslocal',
    '/System/Volumes/Data/private/var/db/uuidtext',
    '/System/Volumes/Data/./private/var/db',
    '/system/volumes/data/private/var/db',
  ]) {
    assert.equal(
      rejection(() => sanitizePath(p)).code, 'PATH_BLOCKED',
      `${p} is the same inode as /private/var/db and must be refused under either name`,
    );
  }
});

test('a symlink pointing at the aliased spelling is refused too', {
  skip: !isDarwin && 'firmlinks are a macOS APFS feature',
}, () => {
  if (!aliasIsReal()) return assert.ok(true, 'no firmlink layout here');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-firm-'));
  try {
    // An unprivileged user can plant this, which is what makes the alias worth
    // closing rather than treating as an oddity only root could reach.
    const link = path.join(dir, 'looks-harmless');
    fs.symlinkSync('/System/Volumes/Data/private/var/db', link);
    assert.equal(rejection(() => sanitizePath(link)).code, 'PATH_BLOCKED', 'the link itself');
    assert.equal(rejection(() => sanitizePath(path.join(link, 'dslocal'))).code, 'PATH_BLOCKED', 'and through it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Data volume and its legitimate contents stay scannable', {
  skip: !isDarwin && 'firmlinks are a macOS APFS feature',
}, () => {
  // The fix must not turn the whole Data volume into a refusal: it holds every
  // user file on the machine.
  for (const p of ['/System/Volumes/Data', '/System/Volumes/Data/Users', '/System/Volumes/Data/Applications']) {
    if (!fs.existsSync(p)) continue;
    assert.equal(sanitizePath(p), p, `${p} is ordinary storage and must be accepted`);
  }
  assert.equal(sanitizePath(os.homedir()), os.homedir(), 'and the home directory is unaffected');
});

test('a leaf symlink out of a blocked tree cannot unblock the path it was reached by', () => {
  // canonicalize() returns the leaf's realpath when the leaf is a link. If the
  // candidate was already blocked, letting that realpath REPLACE it would drop
  // the block — the more restrictive of the two answers has to win. There is no
  // such link on a stock machine (the blocked trees are root-owned), so this
  // pins the rule rather than a reproduction.
  const blocked = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/private/var/db';
  assert.equal(rejection(() => sanitizePath(blocked)).code, 'PATH_BLOCKED', 'the plain case still holds');
  assert.equal(
    rejection(() => sanitizePath(path.join(blocked, 'anything'))).code, 'PATH_BLOCKED',
    'and a child of it, whether or not that child exists',
  );
});
