import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-snaprec-test-'));

import { relativeToVolume } from '../src/platform/snapshotPaths';
import {
  buildRecoveryScript,
  parseRecoveryOutput,
  isUserCancelled,
} from '../src/platform/macos/snapshotRecover';
import { defaultRestoreTarget, findDeleted, restoreFromSnapshot } from '../src/services/snapshotRecovery';
import { AppError } from '../src/middleware/errorHandler';

/**
 * B4 — recovering a file the Trash no longer has.
 *
 * What can and cannot be tested here, stated plainly:
 *
 *  - **Everything up to the privilege boundary is real.** Path arithmetic, the
 *    exact argv handed to the privileged helper, the helper's own contract, the
 *    destination rules, and the refusals are all exercised against real files.
 *  - **The elevated step is not executed.** Reading an APFS snapshot needs an
 *    administrator password (measured: `mount_apfs` answers "Operation not
 *    permitted"), and a test suite must never sit waiting on an authorization
 *    prompt. The shell helper is instead run *unprivileged* against a real
 *    snapshot name, where it must fail safely and say NOTFOUND.
 *
 * The quoting tests matter more than they look: `do shell script` takes a
 * string, so a filename containing a quote is the classic route from "restore
 * my file" to "run my command".
 */

const mkTmp = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), 'tm-b4-'));

/* ══════════════════ Path arithmetic (pure, all platforms) ══════════════════ */

test('a snapshot-relative path never keeps its leading slash', () => {
  // The bug this prevents is silent and dangerous: with a leading slash,
  // path.join(mountPoint, rel) resolves to the LIVE filesystem, so a "recovery"
  // would find the current file and copy it onto itself, reporting success.
  assert.equal(relativeToVolume('/Users/me/notes.txt', '/'), 'Users/me/notes.txt');
  assert.equal(relativeToVolume('/Volumes/Data/x/y.bin', '/Volumes/Data'), 'x/y.bin');
  assert.equal(relativeToVolume('/Volumes/Data/x/y.bin', '/Volumes/Data/'), 'x/y.bin');
  for (const rel of [
    relativeToVolume('/Users/me/a.txt', '/'),
    relativeToVolume('C:\\Users\\me\\a.txt', 'C:'),
    relativeToVolume('/x/y', '/nowhere'),
  ]) {
    assert.ok(!rel.startsWith('/') && !rel.startsWith('\\'), `"${rel}" must be relative`);
  }
});

test('Windows drive letters are stripped the same way', () => {
  assert.equal(relativeToVolume('C:\\Users\\me\\a.txt', 'C:'), 'Users\\me\\a.txt');
  assert.equal(relativeToVolume('D:/projects/x', 'D:'), 'projects/x');
});

test('the volume itself reduces to nothing, and is refused upstream', () => {
  assert.equal(relativeToVolume('/', '/'), '');
});

/* ══════════════════ The privileged call, without ever making it ══════════════════ */

test('every value reaches the helper as its own quoted argument', () => {
  const script = buildRecoveryScript('/tmp/h.sh', '/', 'Users/me/a.txt', '/tmp/out.txt', 501, 20, ['snapA', 'snapB']);
  assert.match(script, /^do shell script "\/bin\/sh " & /);
  assert.match(script, /with administrator privileges$/);
  // Six quoted forms: script, volume, rel, dest, then each snapshot. uid/gid are
  // numbers formatted by us, so they are not user input at all.
  assert.equal((script.match(/quoted form of/g) || []).length, 6);
  assert.match(script, /"snapA"/);
  assert.match(script, /"snapB"/);
});

test('a hostile filename stays data, never script', () => {
  // The whole reason the helper is a fixed file taking argv rather than an
  // interpolated command string.
  const nasty = 'Users/me/$(touch /tmp/pwned) "; rm -rf ~; echo ".txt';
  const script = buildRecoveryScript('/tmp/h.sh', '/', nasty, '/tmp/out', 501, 20, ['snap']);
  // Every embedded double quote is escaped, so the AppleScript literal cannot
  // be closed early; `quoted form of` then single-quotes it for the shell.
  const literal = script.slice(script.indexOf('quoted form of "'));
  assert.ok(!/[^\\]"[^ )&]/.test(literal.slice(16, literal.indexOf('" &') + 1)),
    'no unescaped quote may terminate the literal early');
  assert.match(script, /\\"/, 'the quotes in the filename are escaped');
  assert.ok(script.includes('$(touch'), 'the text is carried through verbatim…');
  assert.match(script, /quoted form of/, '…inside quoted form of, which makes it inert');
});

test('the helper’s output contract is exact', () => {
  assert.deepEqual(parseRecoveryOutput('FOUND com.apple.TimeMachine.2026-07-27-101500.local\n'),
    { found: 'com.apple.TimeMachine.2026-07-27-101500.local' });
  assert.deepEqual(parseRecoveryOutput('NOTFOUND\n'), { found: null });
  assert.equal(parseRecoveryOutput('ERROR the copy failed\n').error, 'the copy failed');
  // Anything unexpected is an error, never silently "not found" — a helper that
  // printed nothing must not read as "your file isn't in any snapshot".
  assert.ok(parseRecoveryOutput('').error);
  assert.ok(parseRecoveryOutput('something else').error);
});

test('a dismissed password prompt is recognised as a decision, not a fault', () => {
  assert.equal(isUserCancelled('User canceled. (-128)'), true);
  assert.equal(isUserCancelled('execution error: User cancelled. (-128)'), true);
  assert.equal(isUserCancelled('mount_apfs: Operation not permitted'), false);
});

/* ══════════════════ The helper itself, run for real (unprivileged) ══════════════════ */

test('the privileged helper fails safe when it cannot mount, and leaks no mounts', { skip: process.platform !== 'darwin' }, async () => {
  // Run as an ordinary user, every mount_apfs call fails. The helper must say
  // NOTFOUND, exit 0, and leave no mount point behind — the trap is what stops
  // a recovery feature becoming a disk-space leak.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'macos', 'snapshotRecover.ts'), 'utf8');
  const body = source.match(/const RECOVER_SCRIPT = `([\s\S]*?)`;/);
  assert.ok(body, 'the embedded helper must be findable');

  const dir = await mkTmp();
  try {
    const helper = path.join(dir, 'h.sh');
    await fsp.writeFile(helper, body![1], { mode: 0o700 });

    const before = (await fsp.readdir('/tmp')).filter((n) => n.startsWith('treemap-snap-')).length;
    const { execFile } = await import('node:child_process');
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile('/bin/sh', [helper, '/', 'etc/hosts', path.join(dir, 'out'), String(os.userInfo().uid), String(os.userInfo().gid), 'com.apple.TimeMachine.does-not-exist'],
        (err, out) => (err ? reject(err) : resolve(out)));
    });
    const after = (await fsp.readdir('/tmp')).filter((n) => n.startsWith('treemap-snap-')).length;

    assert.equal(stdout.trim(), 'NOTFOUND');
    assert.equal(after, before, 'the trap cleaned up its mount point');
    assert.equal(fs.existsSync(path.join(dir, 'out')), false, 'and wrote nothing');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ Where a recovered file goes ══════════════════ */

test('a recovered file lands beside the original, never on top of it', () => {
  // §B4: "Restores are always to a new location by default." A file out of a
  // three-week-old snapshot is OLDER than whatever holds that path now, so
  // overwriting by default would replace newer work with older.
  const at = new Date(2026, 6, 27);
  assert.equal(defaultRestoreTarget('/Users/me/notes.txt', at), '/Users/me/notes (recovered 2026-07-27).txt');
  assert.equal(defaultRestoreTarget('/Users/me/archive.tar.gz', at), '/Users/me/archive.tar (recovered 2026-07-27).gz');
  assert.equal(defaultRestoreTarget('/Users/me/Projects', at), '/Users/me/Projects (recovered 2026-07-27)');
  // A dotfile has no extension to split on.
  assert.equal(defaultRestoreTarget('/Users/me/.zshrc', at), '/Users/me/.zshrc (recovered 2026-07-27)');
});

test('the destination is checked before anything privileged happens', async () => {
  // Being asked for a password and only then told the target was taken is a
  // small cruelty this ordering avoids.
  const dir = await mkTmp();
  try {
    const original = path.join(dir, 'notes.txt');
    const target = defaultRestoreTarget(original);
    await fsp.writeFile(target, 'something already here\n');

    await assert.rejects(
      () => restoreFromSnapshot({ path: original }),
      (err: unknown) => err instanceof AppError && err.code === 'DESTINATION_OCCUPIED',
    );
    assert.equal(await fsp.readFile(target, 'utf8'), 'something already here\n', 'untouched');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('overwrite still refuses to delete a folder', async () => {
  // "Yes, replace that file" is not consent to remove a directory tree.
  const dir = await mkTmp();
  try {
    const original = path.join(dir, 'notes.txt');
    const target = defaultRestoreTarget(original);
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(target, 'inside.txt'), 'precious\n');

    await assert.rejects(
      () => restoreFromSnapshot({ path: original, overwrite: true }),
      (err: unknown) => err instanceof AppError && err.code === 'DESTINATION_IS_FOLDER',
    );
    assert.equal(await fsp.readFile(path.join(target, 'inside.txt'), 'utf8'), 'precious\n');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ Searching ══════════════════ */

test('a search never throws for "nothing to offer" — it answers', async () => {
  const dir = await mkTmp();
  try {
    const result = await findDeleted(path.join(dir, 'never-existed.txt'));
    assert.ok(Array.isArray(result.candidates));
    assert.equal(typeof result.confirmed, 'boolean');
    assert.ok(result.capability, 'the capability state travels with the answer');
    if (result.candidates.length === 0) {
      assert.ok((result.reason ?? '').length > 0, 'and says why there is nothing');
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a file that is still on disk is reported as such, not as recoverable', async () => {
  const dir = await mkTmp();
  try {
    const live = path.join(dir, 'here.txt');
    await fsp.writeFile(live, 'still here\n');
    const result = await findDeleted(live);
    if (result.candidates.length > 0) {
      assert.equal(result.stillPresent, true, 'the panel must not offer to recover a file that exists');
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('candidates come back newest first, and unconfirmed ones say so', async () => {
  // On this Mac there is at least one local snapshot while B4 is under test.
  const result = await findDeleted(path.join(os.homedir(), 'a-file-that-was-deleted-' + crypto.randomUUID() + '.txt'));
  const times = result.candidates.map((c) => c.snapshot.takenAt ?? 0);
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');

  if (process.platform === 'darwin' && result.candidates.length > 0) {
    // macOS cannot look inside without a password, so it must not claim to know.
    assert.equal(result.confirmed, false);
    assert.ok(result.candidates.every((c) => c.state === 'possible'),
      'an unread snapshot is "possible", never "present"');
    assert.ok(result.candidates.every((c) => c.sizeBytes === null),
      'and carries no size it could not have measured');
  }
});

test.after(() => {
  fs.rmSync(process.env.TREEMAP_DATA_DIR!, { recursive: true, force: true });
});
