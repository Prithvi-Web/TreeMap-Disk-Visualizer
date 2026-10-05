import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-snapshotRootHelper-data-');

import { PROBE_FUNCTION, RECOVER_SCRIPT } from '../src/platform/macos/snapshotRecover';

/**
 * FG4c — the macOS root helper run whole (review #3, #7, #11).
 *
 * The helper is the text `do shell script … with administrator privileges` runs as root. Here it
 * runs as this user, with no prompt and no real mount: two commands are stood in for on PATH —
 * `mount_apfs`, which copies a fixture "snapshot" into the mount point (or fails, as a snapshot
 * that is not there does), and `umount`, which empties that mount point again. Everything else is
 * the system's own. So the found path, the name check, the exit status every answer carries and
 * the source's confinement to the mounted snapshot are each shown, end to end.
 *
 * The stand-in writes down the mount point it was handed, and a test checks that very folder is
 * gone afterwards (FG4d, review #11). Counting `/tmp/treemap-snap-*` instead read another test
 * file's helper, running at the same time, as this one's leak.
 */

const onMac = process.platform === 'darwin';
const UID = process.getuid?.() ?? 0;
const GID = process.getgid?.() ?? 0;

function tmp(prefix: string): string {
  return fs.realpathSync.native(fileTempDir(prefix));
}

/**
 * The two stand-ins, in a folder of their own that goes first on PATH. Only they read the TM_*
 * variables: the helper itself is handed nothing but its words.
 */
function standIns(): string {
  const dir = tmp('treemap-helper-bin-');
  fs.writeFileSync(path.join(dir, 'mount_apfs'), [
    '#!/bin/sh',
    '# Stands in for `mount_apfs [-o <options>] -s <snapshot> <volume> <mount point>`: the fixture',
    '# snapshot\'s files copied into the mount point, or the failure of a snapshot that is not there.',
    '# The mount point is written down first; another run\'s mount point can be made or removed',
    '# meanwhile. With TM_MOUNT_SEEN, the options and the owner and mode of the folder the mount point',
    '# is in are written down too.',
    'opts=""',
    'if [ "$1" = "-o" ]; then opts=$2; shift 2; fi',
    '[ "$1" = "-s" ] || exit 64',
    'printf \'%s\\n\' "$4" >> "$TM_MOUNT_LOG"',
    '[ -z "${TM_MOUNT_SEEN:-}" ] || printf \'%s %s\\n\' "$opts" "$(stat -f \'%u:%Lp\' "$(dirname "$4")")" >> "$TM_MOUNT_SEEN"',
    '[ -z "${TM_FOREIGN_MAKE:-}" ] || mkdir -p "$TM_FOREIGN_MAKE"',
    '[ -z "${TM_FOREIGN_REMOVE:-}" ] || rmdir "$TM_FOREIGN_REMOVE" 2>/dev/null',
    'if [ -n "${TM_MOUNT_FAILS:-}" ]; then echo "mount_apfs: volume could not be mounted: Operation not permitted" >&2; exit 1; fi',
    'if [ ! -d "$TM_SNAPSHOTS/$2" ]; then echo "mount_apfs: $2: No such snapshot" >&2; exit 1; fi',
    'cp -R "$TM_SNAPSHOTS/$2/." "$4/"',
    '',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'umount'), [
    '#!/bin/sh',
    '# Stands in for `umount <mount point>`: the helper\'s own mount point emptied, nothing else.',
    'case "$1" in /tmp/treemap-snap-*) find "$1" -mindepth 1 -delete ;; esac',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  return dir;
}

/**
 * snapB holds Users/me/a.txt, a dangling link, and Users/Shared/lnk: a link to a folder outside it.
 * snapLoop holds Users/me as a link to itself, so looking for anything under it fails with ELOOP —
 * a snapshot that mounts but cannot be looked in at that path (FG4e, review L4).
 */
function fixtureSnapshots(outside: string): string {
  const root = tmp('treemap-helper-snaps-');
  fs.mkdirSync(path.join(root, 'snapLoop', 'Users'), { recursive: true });
  fs.symlinkSync('me', path.join(root, 'snapLoop', 'Users', 'me'));
  const me = path.join(root, 'snapB', 'Users', 'me');
  fs.mkdirSync(me, { recursive: true });
  fs.writeFileSync(path.join(me, 'a.txt'), 'from snapB');
  fs.symlinkSync('nowhere', path.join(me, 'dangling'));
  const shared = path.join(root, 'snapB', 'Users', 'Shared');
  fs.mkdirSync(shared, { recursive: true });
  fs.symlinkSync(outside, path.join(shared, 'lnk'));
  return root;
}

/** Runs the helper as root would, but as this user: volume `/`, the path, the folder and name, then the snapshots. */
function runHelper(rel: string, destDir: string, name: string, snaps: string[], opts: { outside?: string; env?: NodeJS.ProcessEnv } = {}) {
  const helper = path.join(tmp('treemap-helper-'), 'snapshot-recover.sh');
  fs.writeFileSync(helper, RECOVER_SCRIPT, { mode: 0o700 });
  const out = opts.outside ?? tmp('treemap-helper-outside-');
  const log = path.join(tmp('treemap-helper-mounts-'), 'mounts.log');
  fs.writeFileSync(log, '');
  const run = spawnSync('/bin/sh', [helper, '/', rel, destDir, name, String(UID), String(GID), ...snaps], {
    encoding: 'utf8',
    // This process's environment (childEnvCarriesGuard.test.ts), with the stand-ins first on PATH.
    env: { ...process.env, PATH: `${standIns()}:/usr/bin:/bin:/usr/sbin:/sbin`, TM_SNAPSHOTS: fixtureSnapshots(out), TM_MOUNT_LOG: log, ...opts.env },
  });
  const mounts = [...new Set(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean))];
  return { stdout: run.stdout.trim(), status: run.status, stderr: run.stderr, mounts };
}

/** The mount points a run was handed: exactly one, the helper's own, in a folder of its own, and both are gone. */
function assertOwnMountPointGone(mounts: string[]): void {
  assert.equal(mounts.length, 1, `one mount point for the whole run: ${JSON.stringify(mounts)}`);
  assert.match(mounts[0], /^\/tmp\/treemap-snap-[^/]+\/[^/]+$/, 'the mount point is inside a folder of its own (FG4e, review L7)');
  assert.equal(fs.existsSync(mounts[0]), false, `the trap removed its mount point ${mounts[0]}`);
  assert.equal(fs.existsSync(path.dirname(mounts[0])), false, `and the folder it was in, ${path.dirname(mounts[0])}`);
}

/** A name another run's helper could have made, unique to this test. */
function foreignMountPoint(): string {
  return `/tmp/treemap-snap-foreign-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}`;
}

test('the newest snapshot holding the path is found, placed and named, and no mount point is left', { skip: !onMac }, () => {
  const dest = tmp('treemap-helper-dest-');
  const { stdout, status, mounts } = runHelper('Users/me/a.txt', dest, 'a (recovered).txt', ['snapB']);
  assert.equal(stdout, 'FOUND snapB');
  assert.equal(status, 0);
  assert.equal(fs.readFileSync(path.join(dest, 'a (recovered).txt'), 'utf8'), 'from snapB');
  assert.deepEqual(fs.readdirSync(dest), ['a (recovered).txt'], 'nothing else left in the folder');
  assertOwnMountPointGone(mounts);
});

test('restored from an older snapshot because a newer one could not be mounted, the answer says so', { skip: !onMac }, () => {
  // FG4e, review L4: a plain FOUND here let the panel present the older copy as the newest. The
  // answer names how many newer snapshots were not looked in, where the copy came from (its place
  // in the list the helper was given) and the first reason.
  const dest = tmp('treemap-helper-dest-');
  const { stdout, status, mounts } = runHelper('Users/me/a.txt', dest, 'a (recovered).txt', ['snapA', 'snapB']);
  assert.equal(stdout, 'FOUNDOLDER 1 2 mount_apfs: snapA: No such snapshot', 'snapA is not there (the stand-in fails as mount_apfs does); snapB holds it');
  assert.equal(status, 0);
  assert.equal(fs.readFileSync(path.join(dest, 'a (recovered).txt'), 'utf8'), 'from snapB');
  assert.deepEqual(fs.readdirSync(dest), ['a (recovered).txt'], 'nothing else left in the folder');
  assertOwnMountPointGone(mounts);
});

test('a snapshot is mounted read-only, with no set-id or device files, unseen by Finder, in a folder only the helper can enter', { skip: !onMac }, () => {
  // FG4e, review L7: a mounted snapshot takes the mount point's place, and with it its permissions;
  // the folder around it (0700, the running account's — root's, as the helper runs) is what keeps
  // every other account out of the snapshot while it is mounted. The options are mount(8)'s, which
  // mount_apfs's own manual lists for its `-s snapshot` form.
  const seen = path.join(tmp('treemap-helper-seen-'), 'seen.log');
  fs.writeFileSync(seen, '');
  const { stdout, mounts } = runHelper('Users/me/a.txt', tmp('treemap-helper-dest-'), 'a.txt', ['snapB'], { env: { TM_MOUNT_SEEN: seen } });
  assert.equal(stdout, 'FOUND snapB');
  assert.deepEqual(fs.readFileSync(seen, 'utf8').trim().split('\n'), [`rdonly,nosuid,nodev,nobrowse ${String(UID)}:700`]);
  assertOwnMountPointGone(mounts);
});

test('another run\'s mount point, made or removed while this one runs, changes nothing this run is judged by', { skip: !onMac }, () => {
  // What `npm test` does when two files run the helper at once (FG4d, review #11): a
  // /tmp/treemap-snap-* appears, or another disappears, while this helper runs. A count of them
  // would read either as this run's doing; the mount point this run was handed is what is checked.
  for (const direction of ['appears', 'disappears'] as const) {
    const foreign = foreignMountPoint();
    if (direction === 'disappears') fs.mkdirSync(foreign);
    try {
      const dest = tmp('treemap-helper-dest-');
      const env = direction === 'appears' ? { TM_FOREIGN_MAKE: foreign } : { TM_FOREIGN_REMOVE: foreign };
      const { stdout, mounts } = runHelper('Users/me/a.txt', dest, 'a.txt', ['snapB'], { env });
      assert.equal(stdout, 'FOUND snapB', direction);
      assert.equal(fs.existsSync(foreign), direction === 'appears', `the other run's mount point ${direction}, and the helper left it so`);
      assert.ok(!mounts.includes(foreign), direction);
      assertOwnMountPointGone(mounts);
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  }
});

test('when no snapshot could be mounted, the answer says so — never that the path is in none of them', { skip: !onMac }, () => {
  // Every mount failing is the likeliest failure as root (the header records "Resource busy" and
  // "Operation not permitted"); NOTFOUND there told the user their file is gone (FG4d, review #5).
  const dest = tmp('treemap-helper-dest-');
  const { stdout, status, mounts } = runHelper('Users/me/a.txt', dest, 'a.txt', ['snapA', 'snapB'], { env: { TM_MOUNT_FAILS: '1' } });
  assert.notEqual(stdout, 'NOTFOUND');
  assert.match(stdout, /^ERROR no snapshot could be mounted or read \(mount_apfs: volume could not be mounted: Operation not permitted\)/);
  assert.match(stdout, /not known/);
  assert.equal(status, 0, 'exit 0, so osascript hands the line over as output');
  assert.deepEqual(fs.readdirSync(dest), [], 'nothing written');
  assertOwnMountPointGone(mounts);
});

test('when some snapshots could not be mounted and the rest lack the path, the answer is not NOTFOUND', { skip: !onMac }, () => {
  const dest = tmp('treemap-helper-dest-');
  // snapA is not there (its mount fails); snapB mounts and does not hold the path.
  const { stdout, status, mounts } = runHelper('Users/me/missing.txt', dest, 'missing.txt', ['snapA', 'snapB']);
  assert.match(stdout, /^ERROR 1 of the 2 snapshots could not be mounted or read \(mount_apfs: snapA: No such snapshot\)/);
  assert.equal(status, 0);
  assertOwnMountPointGone(mounts);

  // Every snapshot mounted and none holds it: that, and only that, is NOTFOUND.
  const all = runHelper('Users/me/missing.txt', tmp('treemap-helper-dest-'), 'missing.txt', ['snapB']);
  assert.equal(all.stdout, 'NOTFOUND');
});

test('a link the snapshot holds, dangling or not, is restored as that link', { skip: !onMac }, () => {
  const dest = tmp('treemap-helper-dest-');
  const { stdout, status } = runHelper('Users/me/dangling', dest, 'dangling (recovered)', ['snapB']);
  assert.equal(stdout, 'FOUND snapB');
  assert.equal(status, 0);
  assert.equal(fs.readlinkSync(path.join(dest, 'dangling (recovered)')), 'nowhere');
});

test('a destination name that is not a plain name is refused, and nothing is written', { skip: !onMac }, () => {
  for (const name of ['..', '.', 'a/b', '']) {
    const dest = tmp('treemap-helper-dest-');
    const { stdout, status } = runHelper('Users/me/a.txt', dest, name, ['snapB']);
    assert.equal(stdout, 'ERROR the destination name is not a plain name', JSON.stringify(name));
    assert.equal(status, 0, `${JSON.stringify(name)}: exit 0, so osascript hands the line over as output`);
    assert.deepEqual(fs.readdirSync(dest), [], JSON.stringify(name));
  }
});

test('every refusal exits 0, so its line reaches TreeMap as output and not as an AppleScript error', { skip: !onMac || UID === 0 }, () => {
  // Under `do shell script` a non-zero exit is an AppleScript error, not output: every refusal
  // once read as "the snapshot could not be opened" (review #3).
  const shared = tmp('treemap-helper-dest-');
  fs.chmodSync(shared, 0o777);
  try {
    const refused = runHelper('Users/me/a.txt', shared, 'a.txt', ['snapB']);
    assert.match(refused.stdout, /^ERROR other users can change the destination folder /);
    assert.equal(refused.status, 0);
  } finally {
    fs.chmodSync(shared, 0o700);
  }
  const taken = tmp('treemap-helper-dest-');
  fs.writeFileSync(path.join(taken, 'a.txt'), 'newer work');
  const there = runHelper('Users/me/a.txt', taken, 'a.txt', ['snapB']);
  assert.equal(there.stdout, 'ERROR something already exists at the destination');
  assert.equal(there.status, 0);
  assert.equal(fs.readFileSync(path.join(taken, 'a.txt'), 'utf8'), 'newer work');
});

test('a path that leads out of the mounted snapshot through a link in it is not copied', { skip: !onMac }, () => {
  // A folder in the snapshot that is a link with an absolute target resolves against the live
  // disk, and the copy runs as root: the source must lie inside the mount point where the system
  // resolves it (review #7). A link as the last name is copied as the link (above).
  const outside = tmp('treemap-helper-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'live, not the snapshot\'s');
  const dest = tmp('treemap-helper-dest-');
  const { stdout, status } = runHelper('Users/Shared/lnk/secret.txt', dest, 'secret (recovered).txt', ['snapB'], { outside });
  assert.match(stdout, /^ERROR .*leads out of the snapshot/);
  assert.equal(status, 0);
  assert.deepEqual(fs.readdirSync(dest), [], 'nothing was copied');
});

/* ══════════════════ A snapshot that mounts but cannot be looked in (FG4e, review L4) ══════════════════ */

/**
 * Whether the path is in a mounted snapshot was `[ -e … ] || [ -L … ]`, which reads every failure
 * to look — not only "no such file" — as "not in this snapshot", and so as NOTFOUND. The probe the
 * helper runs answers 0 (there), 1 (absent: ENOENT or ENOTDIR, as meansAbsent reads them) or 2
 * (not known, with the reason in $why). Run here as this user, against paths made here.
 */
function probe(target: string): { code: number | null; why: string } {
  const driver = `${PROBE_FUNCTION}\nset -u\nprobe "$1"\ncode=$?\nprintf '%s\\n' "$why"\nexit $code\n`;
  const run = spawnSync('/bin/sh', ['-c', driver, 'sh', target], {
    encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  return { code: run.status, why: run.stdout.trim() };
}

test('the probe tells a path that is there, one that is not, and one that could not be looked at apart', { skip: !onMac || UID === 0 }, () => {
  const dir = tmp('treemap-helper-probe-');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
  fs.symlinkSync('nowhere', path.join(dir, 'dangling'));
  fs.symlinkSync('loop', path.join(dir, 'loop'));
  fs.mkdirSync(path.join(dir, 'locked'));
  fs.writeFileSync(path.join(dir, 'locked', 'inside.txt'), 'x');
  fs.chmodSync(path.join(dir, 'locked'), 0o000);
  try {
    assert.equal(probe(path.join(dir, 'file.txt')).code, 0, 'a file is there');
    assert.equal(probe(path.join(dir, 'dangling')).code, 0, 'a dangling link is there: it is the link that is restored');
    assert.equal(probe(path.join(dir, 'missing.txt')).code, 1, 'ENOENT is absent');
    assert.equal(probe(path.join(dir, 'file.txt', 'below')).code, 1, 'ENOTDIR is absent');
    const denied = probe(path.join(dir, 'locked', 'inside.txt'));
    assert.equal(denied.code, 2, `EACCES is not known: ${denied.why}`);
    assert.match(denied.why, /Permission denied/);
    const looped = probe(path.join(dir, 'loop', 'a.txt'));
    assert.equal(looped.code, 2, `ELOOP is not known: ${looped.why}`);
    assert.match(looped.why, /Too many levels of symbolic links/);
  } finally {
    fs.chmodSync(path.join(dir, 'locked'), 0o700);
  }
});

test('a snapshot that mounts but cannot be looked in at that path is never read as one that lacks it', { skip: !onMac }, () => {
  const alone = runHelper('Users/me/a.txt', tmp('treemap-helper-dest-'), 'a.txt', ['snapLoop']);
  assert.notEqual(alone.stdout, 'NOTFOUND');
  assert.match(alone.stdout, /^ERROR no snapshot could be mounted or read \(Users\/me\/a\.txt: Too many levels of symbolic links\)/);
  assert.equal(alone.status, 0);
  assertOwnMountPointGone(alone.mounts);

  const dest = tmp('treemap-helper-dest-');
  const older = runHelper('Users/me/a.txt', dest, 'a.txt', ['snapLoop', 'snapB']);
  assert.equal(older.stdout, 'FOUNDOLDER 1 2 Users/me/a.txt: Too many levels of symbolic links');
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'from snapB');
  assertOwnMountPointGone(older.mounts);
});
