import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-snapshotRootHelper-data-');

import { RECOVER_SCRIPT } from '../src/platform/macos/snapshotRecover';

/**
 * FG4c — the macOS root helper run whole (review #3, #7, #11).
 *
 * The helper is the text `do shell script … with administrator privileges` runs as root. Here it
 * runs as this user, with no prompt and no real mount: two commands are stood in for on PATH —
 * `mount_apfs`, which copies a fixture "snapshot" into the mount point (or fails, as a snapshot
 * that is not there does), and `umount`, which empties that mount point again. Everything else is
 * the system's own. So the found path, the name check, the exit status every answer carries and
 * the source's confinement to the mounted snapshot are each shown, end to end.
 */

const onMac = process.platform === 'darwin';
const UID = process.getuid?.() ?? 0;
const GID = process.getgid?.() ?? 0;

function tmp(prefix: string): string {
  return fs.realpathSync.native(fileTempDir(prefix));
}

/** The two stand-ins, in a folder of their own that goes first on PATH. */
function standIns(): string {
  const dir = tmp('treemap-helper-bin-');
  fs.writeFileSync(path.join(dir, 'mount_apfs'), [
    '#!/bin/sh',
    '# Stands in for `mount_apfs -s <snapshot> <volume> <mount point>`: the fixture snapshot\'s files',
    '# copied into the mount point, or the failure of a snapshot that is not there.',
    '[ "$1" = "-s" ] || exit 64',
    '[ -d "$TM_SNAPSHOTS/$2" ] || exit 1',
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

/** snapB holds Users/me/a.txt, a dangling link, and Users/Shared/lnk: a link to a folder outside it. */
function fixtureSnapshots(outside: string): string {
  const root = tmp('treemap-helper-snaps-');
  const me = path.join(root, 'snapB', 'Users', 'me');
  fs.mkdirSync(me, { recursive: true });
  fs.writeFileSync(path.join(me, 'a.txt'), 'from snapB');
  fs.symlinkSync('nowhere', path.join(me, 'dangling'));
  const shared = path.join(root, 'snapB', 'Users', 'Shared');
  fs.mkdirSync(shared, { recursive: true });
  fs.symlinkSync(outside, path.join(shared, 'lnk'));
  return root;
}

function mountPoints(): number {
  return fs.readdirSync('/tmp').filter((n) => n.startsWith('treemap-snap-')).length;
}

/** Runs the helper as root would, but as this user: volume `/`, the path, the folder and name, then the snapshots. */
function runHelper(rel: string, destDir: string, name: string, snaps: string[], outside?: string) {
  const helper = path.join(tmp('treemap-helper-'), 'snapshot-recover.sh');
  fs.writeFileSync(helper, RECOVER_SCRIPT, { mode: 0o700 });
  const out = outside ?? tmp('treemap-helper-outside-');
  const run = spawnSync('/bin/sh', [helper, '/', rel, destDir, name, String(UID), String(GID), ...snaps], {
    encoding: 'utf8',
    // This process's environment (childEnvCarriesGuard.test.ts), with the stand-ins first on PATH.
    env: { ...process.env, PATH: `${standIns()}:/usr/bin:/bin:/usr/sbin:/sbin`, TM_SNAPSHOTS: fixtureSnapshots(out) },
  });
  return { stdout: run.stdout.trim(), status: run.status, stderr: run.stderr };
}

test('the newest snapshot holding the path is found, placed and named, and no mount point is left', { skip: !onMac }, () => {
  const dest = tmp('treemap-helper-dest-');
  const before = mountPoints();
  const { stdout, status } = runHelper('Users/me/a.txt', dest, 'a (recovered).txt', ['snapA', 'snapB']);
  assert.equal(stdout, 'FOUND snapB', 'snapA is not there (the stand-in fails as mount_apfs does); snapB holds it');
  assert.equal(status, 0);
  assert.equal(fs.readFileSync(path.join(dest, 'a (recovered).txt'), 'utf8'), 'from snapB');
  assert.deepEqual(fs.readdirSync(dest), ['a (recovered).txt'], 'nothing else left in the folder');
  assert.equal(mountPoints(), before, 'the mount point was removed');
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
  const { stdout, status } = runHelper('Users/Shared/lnk/secret.txt', dest, 'secret (recovered).txt', ['snapB'], outside);
  assert.match(stdout, /^ERROR .*leads out of the snapshot/);
  assert.equal(status, 0);
  assert.deepEqual(fs.readdirSync(dest), [], 'nothing was copied');
});
