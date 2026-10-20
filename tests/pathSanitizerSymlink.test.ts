import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-pathSanitizerSymlink-data-');

import { sanitizePath, PathRejectedError, systemFolderRefusal } from '../src/utils/pathSanitizer';
import { externalMountParents } from '../src/services/portableMode';

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

test('macOS /var symlink cannot smuggle a blocked directory past the blocklist', {
  skip: process.platform !== 'darwin' && '/var -> private/var is a macOS layout',
}, () => {
  // /private/var/db is blocked textually today; /var/db is the same inode.
  const viaPrivate = rejection(() => sanitizePath('/private/var/db'));
  assert.equal(viaPrivate.code, 'PATH_BLOCKED');
  const viaVar = rejection(() => sanitizePath('/var/db'));
  assert.equal(viaVar.code, 'PATH_BLOCKED');
});

test('a symlink in an allowed tree pointing at a blocked tree is rejected', {
  skip: process.platform === 'win32' && 'creating a symlink needs privilege on Windows',
}, async () => {
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

/*
 * BQL item 5: the refusal is the sanitizer's for every route that takes a path — GET /api/fs/list, which the
 * folder picker browses with, opening, deleting, a note — and it said `Scanning "/dev" is not allowed`, so
 * the picker toasted that over a folder nobody asked to scan. Its words are now true of all of them.
 */
const SYSTEM_FOLDER = process.platform === 'win32' ? 'C:\\Windows\\System32' : BLOCKED_TARGET;

test('an operating-system folder is refused in words true of every route that asks — never "Scanning … is not allowed" (BQL item 5)', () => {
  const folder = rejection(() => sanitizePath(SYSTEM_FOLDER));
  assert.equal(folder.code, 'PATH_BLOCKED', 'the code is unchanged');
  assert.doesNotMatch(folder.message, /Scanning|not allowed/, 'no route but a scan scans');
  assert.equal(folder.message, `TreeMap does not scan, list or act on "${SYSTEM_FOLDER}": it is one of the system folders TreeMap stays out of.`);
  const inside = path.join(SYSTEM_FOLDER, 'null');
  assert.equal(rejection(() => sanitizePath(inside)).message,
    `TreeMap does not scan, list or act on "${inside}": it is inside "${SYSTEM_FOLDER}", one of the system folders TreeMap stays out of.`,
    'a path inside one is refused naming the folder it is inside');
});

/*
 * The BQL-a review, F2.1 and F2.8: the blocklist refused /run whole, and udisks2 (Fedora, Arch, openSUSE, …)
 * mounts a person's own USB or backup drive at /run/media/<user>/<label> — a drive GET /api/volumes lists
 * (portableMode's externalMountParents), so the offload dock offered a drive whose every offload, scan and
 * picker visit was then refused as inside "/run". /run/media is the drives' folder and is not refused; /run
 * itself and the rest of it still are, and a link is judged where it leads by the same rule.
 */
test('a drive mounted under /run/media is not refused — /run itself and the rest of it are (BQL-a review F2.1, F2.8)', {
  skip: process.platform === 'win32' && 'the Unix blocklist',
}, async () => {
  assert.ok(externalMountParents('linux').includes('/run/media'), 'control: the app lists the drives mounted under /run/media');
  for (const p of ['/run/media', '/run/media/me', '/run/media/me/Backup', '/run/media/me/Backup/photos/a.jpg']) {
    assert.equal(sanitizePath(p), p, `${p} is a drive's folder, never refused`);
    assert.equal(systemFolderRefusal(p, 'linux'), null, `${p} has no blocklist sentence`);
  }
  for (const p of ['/run', '/run/user/1000', '/run/mediax', '/run/udev/data']) {
    const refused = rejection(() => sanitizePath(p));
    assert.equal(refused.code, 'PATH_BLOCKED', `${p} is still refused`);
  }
  assert.equal(systemFolderRefusal('/run/mediax/a', 'linux'),
    'TreeMap does not scan, list or act on "/run/mediax/a": it is inside "/run", one of the system folders TreeMap stays out of.',
    'name by name: /run/mediax is not /run/media');
  const dir = await mkTmp();
  try {
    const toDrive = path.join(dir, 'to-backup');
    await fsp.symlink('/run/media/me/Backup', toDrive);
    assert.equal(sanitizePath(toDrive), toDrive, 'a link to a drive under /run/media is not refused');
    const toRun = path.join(dir, 'to-user-run');
    await fsp.symlink('/run/user/1000', toRun);
    assert.equal(rejection(() => sanitizePath(toRun)).message,
      `TreeMap does not scan, list or act on "${toRun}": it leads into "/run", one of the system folders TreeMap stays out of.`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the refusal names the folder of the blocklist as the path spells it, by Windows\' rules too — its case, a trailing dot, behind \\\\?\\ (BQL-a review F1.5)', () => {
  assert.equal(systemFolderRefusal('/dev', 'linux'), 'TreeMap does not scan, list or act on "/dev": it is one of the system folders TreeMap stays out of.');
  assert.equal(systemFolderRefusal('/private/var/db/x.sqlite', 'darwin'),
    'TreeMap does not scan, list or act on "/private/var/db/x.sqlite": it is inside "/private/var/db", one of the system folders TreeMap stays out of.');
  assert.equal(systemFolderRefusal('C:\\WINDOWS\\system32\\drivers\\etc', 'win32'),
    'TreeMap does not scan, list or act on "C:\\WINDOWS\\system32\\drivers\\etc": it is inside "C:\\WINDOWS\\system32", one of the system folders TreeMap stays out of.');
  assert.equal(systemFolderRefusal('\\\\?\\C:\\Windows\\System32.\\x', 'win32'),
    'TreeMap does not scan, list or act on "\\\\?\\C:\\Windows\\System32.\\x": it is inside "\\\\?\\C:\\Windows\\System32.", one of the system folders TreeMap stays out of.');
  assert.equal(systemFolderRefusal('\\\\?\\C:\\$Recycle.Bin', 'win32'),
    'TreeMap does not scan, list or act on "\\\\?\\C:\\$Recycle.Bin": it is one of the system folders TreeMap stays out of.', 'the folder itself, behind the prefix');
  assert.equal(systemFolderRefusal('/Users/me/Documents', 'darwin'), null, 'a path in no folder of the blocklist has no such sentence');
});

test('a link to an operating-system folder is refused in words true of every route: it leads to one (BQL item 5)', {
  skip: process.platform === 'win32' && 'creating a symlink needs privilege on Windows',
}, async () => {
  const dir = await mkTmp();
  try {
    const link = path.join(dir, 'to-dev');
    await fsp.symlink(BLOCKED_TARGET, link);
    const refused = rejection(() => sanitizePath(link));
    assert.equal(refused.code, 'PATH_BLOCKED');
    assert.doesNotMatch(refused.message, /Scanning|not allowed/);
    assert.equal(refused.message, `TreeMap does not scan, list or act on "${link}": it leads into "${BLOCKED_TARGET}", one of the system folders TreeMap stays out of.`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/*
 * The BQL-a review, F1.1: a link is refused for where it leads in three ways, and the sentence said "it leads
 * to a path that belongs to the operating system" of all of them — false of a link to the person's own folder
 * spelled through a second name the system gives it (macOS's /.nofollow), and of a chain of links longer than
 * TreeMap follows to an ordinary folder. Each is said as what it is.
 */
test('a link to your own folder spelled through /.nofollow is refused as leading through a second name — never as leading to the operating system (BQL-a review F1.1)', {
  skip: process.platform !== 'darwin' && '/.nofollow is macOS\'s',
}, async () => {
  const dir = await mkTmp();
  try {
    const docs = path.join(dir, 'docs');
    await fsp.mkdir(docs);
    const link = path.join(dir, 'toMyDocs');
    await fsp.symlink(`/.nofollow${await fsp.realpath(docs)}`, link);
    const refused = rejection(() => sanitizePath(link));
    assert.equal(refused.code, 'PATH_BLOCKED');
    assert.equal(refused.message,
      `TreeMap does not scan, list or act on "${link}": it leads through /.nofollow, a second name the system gives a path, and TreeMap acts on a path only by its own name.`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a chain of more links than TreeMap follows, to an ordinary folder, is refused as one it cannot follow to its end — never as leading to the operating system (BQL-a review F1.1)', {
  skip: process.platform === 'win32' && 'creating a symlink needs privilege on Windows',
}, async () => {
  const dir = await mkTmp();
  try {
    await fsp.mkdir(path.join(dir, 'real'));
    await fsp.symlink(path.join(dir, 'real'), path.join(dir, 'c0'));
    for (let i = 1; i < 60; i++) await fsp.symlink(path.join(dir, `c${String(i - 1)}`), path.join(dir, `c${String(i)}`));
    const end = path.join(dir, 'c59');
    const refused = rejection(() => sanitizePath(end));
    assert.equal(refused.code, 'PATH_BLOCKED');
    assert.equal(refused.message,
      `TreeMap does not scan, list or act on "${end}": it leads through more links, or a longer path, than TreeMap follows, so where it ends cannot be checked.`);
    assert.equal(sanitizePath(path.join(dir, 'c9')), path.join(dir, 'c9'), 'control: a chain TreeMap follows to its end is accepted');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
