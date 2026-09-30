import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-snapshotRestorePlacement-data-');

import {
  PLACEMENT_FUNCTIONS, RECOVER_SCRIPT, buildRecoveryScript, destinationFolderRefusal, recoverFromSnapshots, restoreFolderRefusal, runAdminPrompt,
  setAdminPromptForTests,
} from '../src/platform/macos/snapshotRecover';
import { copyOutOfSnapshot } from '../src/platform/snapshotCopy';
import { LinuxProvider } from '../src/platform/linux';
import { WindowsProvider } from '../src/platform/windows';
import { setTrashStepForTests } from '../src/services/cleaner';
import { platform } from '../src/platform';
import { restoreFromSnapshot } from '../src/services/snapshotRecovery';
import { AppError } from '../src/middleware/errorHandler';
import { RealMachineRefusal, takeRealMachineRefusalsForTests } from '../src/services/realMachineGuard';
import type { VolumeSnapshotRef } from '../src/platform/types';

/**
 * FG4 #6 — a snapshot restore never writes through a name that is already at its destination.
 *
 * On macOS the copy runs as root (after the administrator prompt), and the destination was
 * checked once, before a prompt that can stay open for minutes; `cp -a` onto a link planted in
 * between wrote, as root, wherever the link led. Now the root script enters the destination
 * folder by its physical path, refuses one that another account could change, copies into a
 * folder it makes there, and places the copy with a call that fails whatever is at the name,
 * confirming by the copy's identity that the name holds it (FG4c).
 *
 * The script's placement functions are the text run as root, and they are run here as this user
 * against folders made here — no prompt, no mount, no root. The prompt itself is stood in for
 * (setAdminPromptForTests): under a test runner the real one refuses before anything is written
 * or asked, so no test can raise a password dialog. Linux and Windows copy as the user, with no
 * overwrite: a name that appears first fails the restore instead of being written through.
 */

const UID = process.getuid?.() ?? 0;
const GID = process.getgid?.() ?? 0;
const onMac = process.platform === 'darwin';

function tmp(prefix: string): string {
  return fs.realpathSync(fileTempDir(prefix));
}

/**
 * Runs the placement functions as this user: enter `destDir` as `owner`, then place `src` there as
 * `name`. A stand-in in `before` finds the destination folder as `$TM_DEST`: place_copy works from
 * inside the folder it made (FG4d, review #3), so `./` there is not the destination.
 */
function place(destDir: string, name: string, src: string, opts: { owner?: number; before?: string; env?: NodeJS.ProcessEnv } = {}) {
  const driver = `${PLACEMENT_FUNCTIONS}\n${opts.before ?? ''}\nset -u\nenter_destination "$1" "$2"\nplace_copy "$3" "$4" "$2" "$5" && echo PLACED\n`;
  // This process's environment, so the child carries the test runner's guard
  // (childEnvCarriesGuard.test.ts), with the system's own commands first on PATH as root's are.
  const run = spawnSync('/bin/sh', ['-c', driver, 'sh', destDir, String(opts.owner ?? UID), src, name, String(GID)], {
    encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TM_DEST: destDir, ...opts.env },
  });
  return { out: `${run.stdout}${run.stderr}`.trim(), status: run.status };
}

/** A source file standing in for the one a mounted snapshot holds. */
function source(content = 'recovered bytes'): string {
  const dir = tmp('treemap-place-src-');
  const file = path.join(dir, 'lost.txt');
  fs.writeFileSync(file, content);
  return file;
}

/** A file the restore must never write to, with what it held. */
function victim(): { file: string; content: string } {
  const dir = tmp('treemap-place-victim-');
  const file = path.join(dir, 'victim.txt');
  fs.writeFileSync(file, 'not yours to overwrite');
  return { file, content: 'not yours to overwrite' };
}

/* ══════════════════ The text run as root, run here as this user ══════════════════ */

test('the root script copies only through the placement functions tested here', () => {
  assert.ok(RECOVER_SCRIPT.includes(PLACEMENT_FUNCTIONS), 'the functions below are the ones the helper runs');
  assert.equal((RECOVER_SCRIPT.match(/cp -a/g) ?? []).length, 1, 'one copy, and it is place_copy\'s');
  assert.ok(PLACEMENT_FUNCTIONS.includes('cp -a'));
  const main = RECOVER_SCRIPT.slice(RECOVER_SCRIPT.indexOf(PLACEMENT_FUNCTIONS) + PLACEMENT_FUNCTIONS.length);
  assert.ok(main.indexOf('enter_destination') !== -1 && main.indexOf('enter_destination') < main.indexOf('mount_apfs'),
    'the destination is entered and checked before any snapshot is mounted');
  assert.match(main, /place_copy /);
});

test('a restore lands under its name, from a folder made for it, and leaves nothing else', { skip: !onMac }, () => {
  const dest = tmp('treemap-place-dest-');
  const src = source();
  const { out } = place(dest, 'lost (recovered).txt', src);
  assert.equal(out, 'PLACED');
  assert.equal(fs.readFileSync(path.join(dest, 'lost (recovered).txt'), 'utf8'), 'recovered bytes');
  assert.deepEqual(fs.readdirSync(dest), ['lost (recovered).txt'], 'the folder it was copied into is gone');
});

test('a folder is restored whole', { skip: !onMac }, () => {
  const dest = tmp('treemap-place-dest-');
  const srcDir = tmp('treemap-place-srcdir-');
  fs.mkdirSync(path.join(srcDir, 'album', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'album', 'inner', 'a.jpg'), 'jpeg');
  const { out } = place(dest, 'album', path.join(srcDir, 'album'));
  assert.equal(out, 'PLACED');
  assert.equal(fs.readFileSync(path.join(dest, 'album', 'inner', 'a.jpg'), 'utf8'), 'jpeg');
});

test('a link already at the destination is refused, and what it leads to is untouched', { skip: !onMac }, () => {
  const dest = tmp('treemap-place-dest-');
  const v = victim();
  fs.symlinkSync(v.file, path.join(dest, 'lost.txt'));
  const { out } = place(dest, 'lost.txt', source());
  assert.match(out, /^ERROR something already exists at the destination/);
  assert.equal(fs.readFileSync(v.file, 'utf8'), v.content);
  assert.equal(fs.lstatSync(path.join(dest, 'lost.txt')).isSymbolicLink(), true);
});

test('a link planted just before the copy is never written through', { skip: !onMac }, () => {
  const dest = tmp('treemap-place-dest-');
  const v = victim();
  // After every check, as the copy starts: cp is wrapped so a link to another file is at the
  // destination name first. The copy goes into place_copy's own folder, never to that name.
  const before = 'cp() { ln -s "$TM_VICTIM" "$TM_DEST/$TM_NAME"; command cp "$@"; }';
  const { out } = place(dest, 'lost.txt', source(), { before, env: { TM_VICTIM: v.file, TM_NAME: 'lost.txt' } });
  assert.match(out, /^ERROR something appeared at the destination/);
  assert.equal(fs.readFileSync(v.file, 'utf8'), v.content, 'the file the link leads to is untouched');
  assert.equal(fs.readlinkSync(path.join(dest, 'lost.txt')), v.file, 'the link was not replaced either');
  assert.deepEqual(fs.readdirSync(dest), ['lost.txt'], 'and the copy made for the move is gone');
});

test('a link that appears while the copy is made is never written through', { skip: !onMac }, () => {
  const dest = tmp('treemap-place-dest-');
  const v = victim();
  // As the copy finishes, a link to another file appears at the destination name.
  const before = 'cp() { command cp "$@"; ln -s "$TM_VICTIM" "$TM_DEST/$TM_NAME"; }';
  const { out } = place(dest, 'lost.txt', source(), { before, env: { TM_VICTIM: v.file, TM_NAME: 'lost.txt' } });
  assert.match(out, /^ERROR something appeared at the destination/);
  assert.equal(fs.readFileSync(v.file, 'utf8'), v.content, 'the file the link leads to is untouched');
  assert.equal(fs.readlinkSync(path.join(dest, 'lost.txt')), v.file, 'the link was not replaced either');
  assert.deepEqual(fs.readdirSync(dest), ['lost.txt'], 'and the copy made for the move is gone');
});

test('a link to a folder that appears at the name is not moved into', { skip: !onMac }, () => {
  const dest = tmp('treemap-place-dest-');
  const elsewhere = tmp('treemap-place-elsewhere-');
  const before = 'cp() { command cp "$@"; ln -s "$TM_VICTIM" "$TM_DEST/$TM_NAME"; }';
  const { out } = place(dest, 'lost.txt', source(), { before, env: { TM_VICTIM: elsewhere, TM_NAME: 'lost.txt' } });
  assert.match(out, /^ERROR something appeared at the destination/);
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was moved into the folder the link leads to');
});

test('a folder other accounts can write to is refused before anything is copied', { skip: !onMac || UID === 0 }, () => {
  for (const mode of [0o775, 0o757, 0o777]) {
    const dest = tmp('treemap-place-dest-');
    fs.chmodSync(dest, mode);
    const { out } = place(dest, 'lost.txt', source());
    assert.match(out, /^ERROR other users can change the destination folder/, `mode ${mode.toString(8)}`);
    assert.deepEqual(fs.readdirSync(dest), [], `nothing written (mode ${mode.toString(8)})`);
    fs.chmodSync(dest, 0o700);
  }
});

test('a folder that belongs to another account is refused', { skip: !onMac }, () => {
  const dest = tmp('treemap-place-dest-');
  const { out } = place(dest, 'lost.txt', source(), { owner: UID + 1 });
  assert.match(out, /^ERROR the destination folder .* belongs to another user/);
  assert.deepEqual(fs.readdirSync(dest), []);
});

/* ══════════════════ A folder or a dangling link at the name (FG4c, review #9, #4) ══════════════════ */

/**
 * `mv -n -h` is not an exclusive rename: a real folder at the name makes it move the copy inside
 * it (and report nothing wrong), and a dangling link reads as absent and is replaced. So a file
 * is placed with `link`, which fails whatever is at the name, a symlink with `ln -P -h`, a folder
 * with `mv -n -h`; the name is checked again just before, and afterwards the name must hold the
 * copy itself (same device and inode).
 */
const beforePlacing = (command: 'link' | 'ln' | 'mv', plant: string): string =>
  `${command}() { ${plant}; command ${command} "$@"; }`;

test('a real folder that appears at a file\'s name just before it is placed receives nothing', { skip: !onMac }, () => {
  const dest = tmp('treemap-place-dest-');
  const { out } = place(dest, 'lost.txt', source(), { before: beforePlacing('link', 'mkdir "$TM_DEST/$TM_NAME"'), env: { TM_NAME: 'lost.txt' } });
  assert.match(out, /^ERROR something appeared at the destination/);
  assert.notEqual(out, 'PLACED');
  assert.deepEqual(fs.readdirSync(path.join(dest, 'lost.txt')), [], 'nothing was put inside the folder');
  assert.deepEqual(fs.readdirSync(dest), ['lost.txt'], 'and the copy made for the move is gone');
});

test('a dangling link that appears at a file\'s name just before it is placed is not replaced', { skip: !onMac }, () => {
  const dest = tmp('treemap-place-dest-');
  const { out } = place(dest, 'lost.txt', source(), { before: beforePlacing('link', 'ln -s ./gone "$TM_DEST/$TM_NAME"'), env: { TM_NAME: 'lost.txt' } });
  assert.match(out, /^ERROR something appeared at the destination/);
  assert.equal(fs.readlinkSync(path.join(dest, 'lost.txt')), './gone', 'the link is still there');
  assert.equal(fs.existsSync(path.join(dest, 'gone')), false, 'nothing made where it leads');
  assert.deepEqual(fs.readdirSync(dest), ['lost.txt']);
});

test('a real folder that appears at the name while a file or a folder is copied is found before anything is placed', { skip: !onMac }, () => {
  const plantAfterCopy = 'cp() { command cp "$@"; mkdir "$TM_DEST/$TM_NAME"; }';
  const file = tmp('treemap-place-dest-');
  const fromFile = place(file, 'lost.txt', source(), { before: plantAfterCopy, env: { TM_NAME: 'lost.txt' } });
  assert.match(fromFile.out, /^ERROR something appeared at the destination/);
  assert.deepEqual(fs.readdirSync(path.join(file, 'lost.txt')), []);

  const folder = tmp('treemap-place-dest-');
  const srcDir = tmp('treemap-place-srcdir-');
  fs.mkdirSync(path.join(srcDir, 'album'));
  fs.writeFileSync(path.join(srcDir, 'album', 'a.jpg'), 'jpeg');
  const fromFolder = place(folder, 'album', path.join(srcDir, 'album'), { before: plantAfterCopy, env: { TM_NAME: 'album' } });
  assert.match(fromFolder.out, /^ERROR something appeared at the destination/);
  assert.deepEqual(fs.readdirSync(path.join(folder, 'album')), [], 'the folder that appeared was not moved into');
  assert.deepEqual(fs.readdirSync(folder), ['album']);
});

test('a real folder that appears at a folder\'s name at the last moment is found by the copy\'s identity, not reported placed', { skip: !onMac }, () => {
  const dest = tmp('treemap-place-dest-');
  const srcDir = tmp('treemap-place-srcdir-');
  fs.mkdirSync(path.join(srcDir, 'album'));
  fs.writeFileSync(path.join(srcDir, 'album', 'a.jpg'), 'jpeg');
  // Between the last check and the rename: mv then moves the copy inside what appeared.
  const { out } = place(dest, 'album', path.join(srcDir, 'album'), { before: beforePlacing('mv', 'mkdir "$TM_DEST/$TM_NAME"'), env: { TM_NAME: 'album' } });
  assert.match(out, /^ERROR something appeared at the destination/);
  assert.match(out, /not in its place/);
  assert.equal(fs.readFileSync(path.join(dest, 'album', 'item', 'a.jpg'), 'utf8'), 'jpeg', 'the copy is where the message says, nothing was written over');
});

test('a link is restored as a link, and a real folder appearing at its name is found by the copy\'s identity', { skip: !onMac }, () => {
  const srcDir = tmp('treemap-place-srclink-');
  fs.symlinkSync('../somewhere/else', path.join(srcDir, 'lost.lnk'));
  const dest = tmp('treemap-place-dest-');
  assert.equal(place(dest, 'lost.lnk', path.join(srcDir, 'lost.lnk')).out, 'PLACED');
  assert.equal(fs.readlinkSync(path.join(dest, 'lost.lnk')), '../somewhere/else', 'the link itself, not what it leads to');
  assert.deepEqual(fs.readdirSync(dest), ['lost.lnk']);

  const raced = tmp('treemap-place-dest-');
  const { out } = place(raced, 'lost.lnk', path.join(srcDir, 'lost.lnk'), { before: beforePlacing('ln', 'mkdir "$TM_DEST/$TM_NAME"'), env: { TM_NAME: 'lost.lnk' } });
  assert.match(out, /^ERROR something appeared at the destination/);
  assert.notEqual(out, 'PLACED');
});

test('the copy is handed to the user, whole, before it is placed', { skip: !onMac }, () => {
  // As root the copy would otherwise stay root's; run here as the user, chown is recorded (review #11).
  const dest = tmp('treemap-place-dest-');
  const log = path.join(tmp('treemap-place-log-'), 'chown.log');
  const { out } = place(dest, 'lost.txt', source(), { before: 'chown() { echo "$@" >> "$TM_LOG"; command chown "$@"; }', env: { TM_LOG: log } });
  assert.equal(out, 'PLACED');
  assert.ok(fs.existsSync(log), 'chown was called for the copy');
  const [line, ...rest] = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(rest, [], 'once');
  // The copy by its name inside the folder place_copy made and works in (FG4d, review #3), or by its path from the destination before.
  assert.match(line, new RegExp(`^-R ${String(UID)}:${String(GID)} (\\./\\.treemap-restore\\.[A-Za-z0-9]+/|\\./)item$`), line);
});

/* ══════════════════ The folder the copy is made in (FG4d, review #3) ══════════════════ */

/**
 * place_copy's own folder, made with `mktemp -d` in a destination folder the user owns, used to be
 * named again at every step: renamed aside and replaced by the user's own folder holding
 * `item -> <any file>`, `cp -a` — as root — wrote through that link. Now it is entered by its
 * physical path once made, must be the running account's and nobody else's to write in, and the
 * copy is made and placed from inside it (`./item`, `../<name>`).
 */
test('a folder swapped in for the one the copy is made in is never written through', { skip: !onMac }, () => {
  const dest = tmp('treemap-place-dest-');
  const v = victim();
  // As the copy starts: the folder place_copy made is renamed aside, and one holding a link to
  // another file takes its name.
  const before = 'cp() { s="$TM_DEST/${stage##*/}"; mv "$s" "$s.aside"; mkdir "$s"; ln -s "$TM_VICTIM" "$s/item"; command cp "$@"; }';
  const { out } = place(dest, 'lost.txt', source(), { before, env: { TM_VICTIM: v.file } });
  assert.equal(fs.readFileSync(v.file, 'utf8'), v.content, 'the file the planted link leads to is untouched');
  assert.equal(out, 'PLACED', 'the copy went into the folder that was made for it, wherever that was moved');
  assert.equal(fs.readFileSync(path.join(dest, 'lost.txt'), 'utf8'), 'recovered bytes');
  assert.equal(fs.lstatSync(path.join(dest, 'lost.txt')).isFile(), true, 'a file, not the planted link');
});

test('a folder to copy into that is not the one mktemp made is refused before anything is copied', { skip: !onMac }, () => {
  // Swapped between mktemp and entering it: not 0700 (a folder anyone made with the default
  // umask), or not the running account's (root's, when the helper runs) — each is not ours.
  const cases: Array<[string, string]> = [
    ['open to others', 'mktemp() { d=$(command mktemp "$@") || return 1; chmod 755 "$d"; printf "%s\\n" "$d"; }'],
    ['another account\'s', 'id() { echo 4242; }'],
  ];
  for (const [what, before] of cases) {
    const dest = tmp('treemap-place-dest-');
    const { out } = place(dest, 'lost.txt', source(), { before });
    assert.match(out, /^ERROR the folder made to copy into was changed/, `${what}: ${out}`);
    assert.equal(fs.existsSync(path.join(dest, 'lost.txt')), false, what);
  }
});

/* ══════════════════ A copy that cannot be put in place, with its name still free (FG4d, review #7, #13, #18) ══════════════════ */

test('a volume that holds no hard links still receives the file, moved into place and confirmed', { skip: !onMac }, () => {
  // FAT and exFAT refuse link(2) with "Operation not supported", and nothing is at the name.
  const dest = tmp('treemap-place-dest-');
  const before = 'link() { echo "link: $2: Operation not supported" >&2; return 1; }';
  const { out } = place(dest, 'lost.txt', source(), { before });
  assert.equal(out, 'PLACED');
  assert.equal(fs.readFileSync(path.join(dest, 'lost.txt'), 'utf8'), 'recovered bytes');
  assert.deepEqual(fs.readdirSync(dest), ['lost.txt'], 'nothing left behind');
});

test('a copy that cannot be put in place is reported as that, not as a name that appeared', { skip: !onMac }, () => {
  const dest = tmp('treemap-place-dest-');
  const before = [
    'link() { echo "link: $2: Operation not supported" >&2; return 1; }',
    'mv() { echo "mv: rename $1 to $2: Operation not permitted" >&2; return 1; }',
  ].join('\n');
  const { out } = place(dest, 'lost.txt', source(), { before });
  assert.doesNotMatch(out, /something appeared/);
  assert.match(out, /^ERROR the copy could not be put in place \(link: .*Operation not supported\)/);
  assert.deepEqual(fs.readdirSync(dest), [], 'nothing at the destination, and the folder made for the copy is gone');
});

test('a locked file (Finder\'s Locked, uchg) is restored, unlocked, and nothing is left behind', { skip: !onMac }, () => {
  // cp -a keeps the lock, and a locked file can be neither linked, moved nor handed over — not by
  // root either. The copy is unlocked before it is handed to the user and put in place.
  const src = source();
  const flags = (file: string): string => spawnSync('/usr/bin/stat', ['-f', '%Sf', file], { encoding: 'utf8', env: process.env }).stdout.trim();
  const dest = tmp('treemap-place-dest-');
  spawnSync('/usr/bin/chflags', ['uchg', src], { env: process.env });
  try {
    assert.match(flags(src), /uchg/, 'the source is locked');
    const { out } = place(dest, 'lost.txt', src);
    assert.equal(out, 'PLACED');
    assert.equal(fs.readFileSync(path.join(dest, 'lost.txt'), 'utf8'), 'recovered bytes');
    assert.doesNotMatch(flags(path.join(dest, 'lost.txt')), /uchg/, 'the restored copy is not locked');
    assert.deepEqual(fs.readdirSync(dest), ['lost.txt'], 'the folder made for the copy is gone');
  } finally {
    // Whatever happened, nothing locked is left for the temp folders' removal to trip on.
    spawnSync('/usr/bin/chflags', ['-R', 'nouchg', src, dest], { env: process.env });
  }
});

/* ══════════════════ The prompt: stood in for, and refused under a test runner ══════════════════ */

const SNAPSHOTS: VolumeSnapshotRef[] = [
  { id: 'com.apple.TimeMachine.2026-09-01-000000.local', name: 'a', takenAt: 1, volume: '/', accessPath: null },
  { id: 'com.apple.TimeMachine.2026-09-02-000000.local', name: 'b', takenAt: 2, volume: '/', accessPath: null },
];

/** The words `buildRecoveryScript` hands the shell, in order, as AppleScript literals decode them. */
function quotedWords(appleScript: string): string[] {
  return [...appleScript.matchAll(/quoted form of "((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
}

test('the helper is handed the destination folder and its name as separate words', () => {
  const script = buildRecoveryScript('/tmp/h.sh', '/', 'Users/me/a.txt', '/Users/me', 'a (recovered).txt', 501, 20, ['s1']);
  assert.deepEqual(quotedWords(script), ['/tmp/h.sh', '/', 'Users/me/a.txt', '/Users/me', 'a (recovered).txt', 's1']);
  assert.match(script, / & "501" & " " & "20" & /);
});

test('under a test runner the real prompt refuses before anything is written or asked', async () => {
  const made: string[] = [];
  const promises = fs.promises as unknown as { mkdtemp: (...args: unknown[]) => Promise<string> };
  const mkdtemp = promises.mkdtemp;
  promises.mkdtemp = async (...args: unknown[]) => {
    made.push(String(args[0]));
    return mkdtemp.apply(fs.promises, args);
  };
  const dest = path.join(tmp('treemap-place-prompt-'), 'a (recovered).txt');
  try {
    await assert.rejects(recoverFromSnapshots(SNAPSHOTS, '/Users/me/a.txt', dest), (err: unknown) => err instanceof RealMachineRefusal);
  } finally {
    promises.mkdtemp = mkdtemp;
  }
  assert.equal(takeRealMachineRefusalsForTests().length, 1, 'refused once, and taken so the file does not fail at exit');
  assert.deepEqual(made.filter((p) => p.includes('treemap-recover-')), [], 'no helper script was written for a prompt that was never shown');
});

test('the prompt runner itself refuses under a test runner, whatever called it', async () => {
  // A harmless script: were the refusal missing, osascript would only answer "treemap-test".
  await assert.rejects(runAdminPrompt('return "treemap-test"'), (err: unknown) => err instanceof RealMachineRefusal);
  assert.equal(takeRealMachineRefusalsForTests().length, 1);
});

test('a refusal from the prompt step is thrown on, never turned into "could not be opened"', async () => {
  setAdminPromptForTests(async () => runAdminPrompt('return "treemap-test"'));
  try {
    await assert.rejects(recoverFromSnapshots(SNAPSHOTS, '/Users/me/a.txt', path.join(tmp('treemap-place-prompt-'), 'a.txt')),
      (err: unknown) => err instanceof RealMachineRefusal);
  } finally {
    setAdminPromptForTests(null);
  }
  assert.equal(takeRealMachineRefusalsForTests().length, 1);
});

test('with the prompt stood in for, the helper gets its words and its answer is read', async () => {
  const destDir = tmp('treemap-place-prompt-');
  const dest = path.join(destDir, 'a (recovered).txt');
  const asked: { words: string[]; helper: string; mode: number }[] = [];
  setAdminPromptForTests(async (appleScript) => {
    const words = quotedWords(appleScript);
    const st = fs.statSync(words[0]);
    asked.push({ words, helper: fs.readFileSync(words[0], 'utf8'), mode: st.mode & 0o777 });
    fs.writeFileSync(dest, 'restored');
    return `FOUND ${SNAPSHOTS[1].id}\n`;
  });
  try {
    const result = await recoverFromSnapshots(SNAPSHOTS, '/Users/me/a.txt', dest);
    assert.deepEqual(result, { restored: true, fromSnapshotId: SNAPSHOTS[1].id, sizeBytes: 8 });
  } finally {
    setAdminPromptForTests(null);
  }
  assert.equal(asked.length, 1);
  const [call] = asked;
  assert.deepEqual(call.words.slice(1), ['/', 'Users/me/a.txt', destDir, 'a (recovered).txt', SNAPSHOTS[1].id, SNAPSHOTS[0].id],
    'volume, path, destination folder, name, then the snapshots newest first');
  assert.equal(call.helper, RECOVER_SCRIPT, 'the helper is the script whose placement is tested above');
  // Windows reports no POSIX mode bits (a writable file reads 0o666); the helper only ever runs on a Mac.
  if (process.platform !== 'win32') assert.equal(call.mode, 0o700, 'only this user can read or change the script run as root');
});

/* ══════════════════ Linux and Windows: a copy that never overwrites ══════════════════ */

test('the no-overwrite copy refuses a file, a link and a dangling link at its destination', async () => {
  const src = source('from the snapshot');
  const dir = tmp('treemap-copy-dest-');

  const existing = path.join(dir, 'existing.txt');
  fs.writeFileSync(existing, 'newer work');
  assert.equal(await copyOutOfSnapshot(src, existing), false);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'newer work');

  const v = victim();
  const link = path.join(dir, 'link.txt');
  fs.symlinkSync(v.file, link);
  assert.equal(await copyOutOfSnapshot(src, link), false);
  assert.equal(fs.readFileSync(v.file, 'utf8'), v.content, 'nothing written through the link');

  const nowhere = path.join(dir, 'not-yet.txt');
  const dangling = path.join(dir, 'dangling.txt');
  fs.symlinkSync(nowhere, dangling);
  assert.equal(await copyOutOfSnapshot(src, dangling), false);
  assert.equal(fs.existsSync(nowhere), false, 'nothing created where a dangling link leads');

  const fresh = path.join(dir, 'fresh.txt');
  assert.equal(await copyOutOfSnapshot(src, fresh), true);
  assert.equal(fs.readFileSync(fresh, 'utf8'), 'from the snapshot');
});

/**
 * A folder, a link, and a name of the other kind (FG4c, review #5, #19). `fs.cp`'s flags decide
 * none of these the same way on every Node: Node 20 — CI's, Electron 31's, the Docker image's —
 * merges a folder into one already there, `onLink` replaces a link at the destination whatever
 * the flags say, and a folder onto a file throws rather than answering "taken".
 */
function snapshotFolder(): string {
  const dir = tmp('treemap-copy-srcdir-');
  const album = path.join(dir, 'album');
  fs.mkdirSync(path.join(album, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(album, 'same.txt'), 'from the snapshot');
  fs.writeFileSync(path.join(album, 'extra.txt'), 'only in the snapshot');
  fs.writeFileSync(path.join(album, 'inner', 'deep.txt'), 'deep');
  return album;
}

test('a folder is never merged into one already at its destination, on any Node', async () => {
  const album = snapshotFolder();
  const dir = tmp('treemap-copy-dest-');

  const empty = path.join(dir, 'empty');
  fs.mkdirSync(empty);
  assert.equal(await copyOutOfSnapshot(album, empty), false, 'an empty folder there is taken');
  assert.deepEqual(fs.readdirSync(empty), [], 'and nothing was put in it');

  const busy = path.join(dir, 'busy');
  fs.mkdirSync(busy);
  fs.writeFileSync(path.join(busy, 'same.txt'), 'newer work');
  assert.equal(await copyOutOfSnapshot(album, busy), false);
  assert.deepEqual(fs.readdirSync(busy), ['same.txt'], 'nothing added beside it');
  assert.equal(fs.readFileSync(path.join(busy, 'same.txt'), 'utf8'), 'newer work');

  const fresh = path.join(dir, 'fresh');
  assert.equal(await copyOutOfSnapshot(album, fresh), true);
  assert.deepEqual(fs.readdirSync(fresh).sort(), ['extra.txt', 'inner', 'same.txt']);
  assert.equal(fs.readFileSync(path.join(fresh, 'inner', 'deep.txt'), 'utf8'), 'deep');
});

test('a name of the other kind at the destination is "taken", not a failure', async () => {
  const album = snapshotFolder();
  const dir = tmp('treemap-copy-dest-');
  const file = path.join(dir, 'a-file');
  fs.writeFileSync(file, 'newer work');
  assert.equal(await copyOutOfSnapshot(album, file), false, 'a folder onto a file');
  assert.equal(fs.readFileSync(file, 'utf8'), 'newer work');

  const folder = path.join(dir, 'a-folder');
  fs.mkdirSync(folder);
  assert.equal(await copyOutOfSnapshot(path.join(album, 'same.txt'), folder), false, 'a file onto a folder');
  assert.deepEqual(fs.readdirSync(folder), []);
});

test('a link is copied as a link, and never over a link already there', async (t) => {
  const dir = tmp('treemap-copy-links-');
  const snap = path.join(dir, 'snap');
  fs.mkdirSync(snap);
  fs.writeFileSync(path.join(snap, 'older-target'), 'what the older link led to');
  try {
    fs.symlinkSync('older-target', path.join(snap, 'lost.lnk'), 'file');
    fs.symlinkSync('gone-target', path.join(snap, 'dangling.lnk'), 'file');
  } catch {
    t.skip('this system cannot make a link here');
    return;
  }
  const newer = path.join(dir, 'newer.lnk');
  fs.symlinkSync('newer-target', newer, 'file');
  assert.equal(await copyOutOfSnapshot(path.join(snap, 'lost.lnk'), newer, { verbatimSymlinks: true }), false,
    'a link already there is taken (fs.cp would unlink it and make the older one)');
  assert.equal(fs.readlinkSync(newer), 'newer-target', 'the newer link is still the newer one');
  assert.equal(await copyOutOfSnapshot(path.join(snap, 'dangling.lnk'), newer, { verbatimSymlinks: true }), false,
    'a dangling link from the snapshot too, answered rather than thrown');

  const fresh = path.join(dir, 'fresh.lnk');
  assert.equal(await copyOutOfSnapshot(path.join(snap, 'lost.lnk'), fresh, { verbatimSymlinks: true }), true);
  assert.equal(fs.readlinkSync(fresh), 'older-target', 'the link as the snapshot holds it');
  const freshDangling = path.join(dir, 'fresh-dangling.lnk');
  assert.equal(await copyOutOfSnapshot(path.join(snap, 'dangling.lnk'), freshDangling, { verbatimSymlinks: true }), true);
  assert.equal(fs.readlinkSync(freshDangling), 'gone-target');
});

test('a Linux restore onto a name that is already there fails with the reason, and writes nothing', async () => {
  const snap = tmp('treemap-btrfs-snap-');
  fs.mkdirSync(path.join(snap, 'home', 'me'), { recursive: true });
  fs.writeFileSync(path.join(snap, 'home', 'me', 'notes.txt'), 'old notes');
  const ref: VolumeSnapshotRef = { id: 'snap-1', name: 'snap-1', takenAt: 1, volume: '/', accessPath: snap };
  const v = victim();
  const dir = tmp('treemap-btrfs-dest-');
  const dest = path.join(dir, 'notes (recovered).txt');
  fs.symlinkSync(v.file, dest);
  const refusedRestore = await new LinuxProvider().recoverFromSnapshots([ref], '/home/me/notes.txt', dest);
  assert.equal(refusedRestore.restored, false);
  assert.equal(refusedRestore.destinationTaken, true);
  assert.match(refusedRestore.reason ?? '', /already/);
  assert.equal(fs.readFileSync(v.file, 'utf8'), v.content);

  const fresh = path.join(dir, 'notes (recovered 2).txt');
  const restored = await new LinuxProvider().recoverFromSnapshots([ref], '/home/me/notes.txt', fresh);
  assert.equal(restored.restored, true);
  assert.equal(fs.readFileSync(fresh, 'utf8'), 'old notes');
});

test('the Windows restore copies through the same no-overwrite copy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'windows', 'index.ts'), 'utf8');
  const body = src.slice(src.indexOf('override async recoverFromSnapshots'), src.indexOf('private async deviceObjectFor'));
  assert.ok(body.includes('copyOutOfSnapshot('), 'Windows uses the shared copy');
  assert.ok(!body.includes('fsp.cp('), 'and never a copy that overwrites');
});

test('the macOS helper refusing a name at the destination is reported as the destination taken, however osascript hands it over', async () => {
  // The helper prints its ERROR line and exits 0, so osascript passes it on as output
  // (snapshotRootHelper.test.ts runs the helper whole). Were it to exit non-zero, osascript
  // raises "execution error: <line> (<status>)" instead — the form every refusal took until
  // FG4c (review #3) — and that is read as the same refusal, never as "could not be opened".
  const line = 'ERROR something appeared at the destination while copying, and nothing was written over it';
  const forms: Array<[string, () => Promise<string>]> = [
    ['printed', async () => `${line}\n`],
    ['raised', async () => { throw new Error(`0:121: execution error: ${line} (1)`); }],
  ];
  for (const [form, answer] of forms) {
    const dest = path.join(tmp('treemap-place-prompt-'), 'a (recovered).txt');
    setAdminPromptForTests(answer);
    try {
      const result = await recoverFromSnapshots(SNAPSHOTS, '/Users/me/a.txt', dest);
      assert.equal(result.restored, false, form);
      assert.equal(result.destinationTaken, true, `${form}: ${JSON.stringify(result)}`);
      assert.match(result.reason ?? '', /nothing was restored over it/, form);
    } finally {
      setAdminPromptForTests(null);
    }
  }
});

/* ══════════════════ The destination folder, checked before the password (FG4c, review #24) ══════════════════ */

test('the destination folder rule: the user\'s or root\'s, and neither group nor others can change it', () => {
  const dir = '/Users/me/Documents';
  assert.equal(destinationFolderRefusal({ uid: 501, mode: 0o40700 }, dir, 501), null, 'the user\'s own');
  assert.equal(destinationFolderRefusal({ uid: 0, mode: 0o40755 }, dir, 501), null, 'root\'s, not writable by others');
  assert.match(destinationFolderRefusal({ uid: 502, mode: 0o40700 }, dir, 501) ?? '', /belongs to another account/);
  for (const mode of [0o40775, 0o40757, 0o40777, 0o41777]) {
    assert.match(destinationFolderRefusal({ uid: 501, mode }, dir, 501) ?? '', /Other accounts on this Mac can change/, mode.toString(8));
  }
  assert.match(destinationFolderRefusal({ uid: 0, mode: 0o41777 }, '/Users/Shared', 501) ?? '', /Choose another destination/,
    'a shared folder such as /Users/Shared, with the way forward');
});

test('a destination folder other accounts can change is refused before the password is asked for', { skip: process.platform === 'win32' || UID === 0 }, async () => {
  const destDir = tmp('treemap-place-shared-');
  fs.chmodSync(destDir, 0o777);
  let asked = 0;
  setAdminPromptForTests(async () => { asked++; return 'NOTFOUND\n'; });
  try {
    const result = await recoverFromSnapshots(SNAPSHOTS, '/Users/me/a.txt', path.join(destDir, 'a (recovered).txt'));
    assert.equal(asked, 0, 'no password was asked for, only to be refused after it');
    assert.equal(result.restored, false);
    assert.equal(result.destinationRefused, true, JSON.stringify(result));
    assert.match(result.reason ?? '', /Other accounts on this Mac can change/);
  } finally {
    setAdminPromptForTests(null);
    fs.chmodSync(destDir, 0o700);
  }
});

test('each answer of the helper, and of the prompt, is its own 409 code', async () => {
  const provider = platform() as unknown as Record<'listSnapshots' | 'recoverFromSnapshots', unknown>;
  const saved = { list: provider.listSnapshots, recover: provider.recoverFromSnapshots };
  provider.listSnapshots = async () => SNAPSHOTS;
  // The macOS answers, whatever this machine is: the helper's words go through the module that reads them.
  provider.recoverFromSnapshots = (s: VolumeSnapshotRef[], o: string, d: string) => recoverFromSnapshots(s, o, d);
  const cases: Array<[string, () => Promise<string>, string]> = [
    ['a name there', async () => 'ERROR something appeared at the destination while copying, and nothing was written over it\n', 'DESTINATION_OCCUPIED'],
    ['a shared folder', async () => 'ERROR other users can change the destination folder /Users/Shared\n', 'DESTINATION_FOLDER_REFUSED'],
    ['another account\'s folder', async () => 'ERROR the destination folder /Users/other belongs to another user\n', 'DESTINATION_FOLDER_REFUSED'],
    ['a failed copy', async () => 'ERROR the copy out of the snapshot failed\n', 'RESTORE_FAILED'],
    ['in no snapshot', async () => 'NOTFOUND\n', 'NOT_IN_ANY_SNAPSHOT'],
    ['a dismissed prompt', async () => { throw new Error('0:12: execution error: User canceled. (-128)'); }, 'AUTHORIZATION_DECLINED'],
    ['a prompt that failed', async () => { throw new Error('0:5: execution error: The operation couldn\'t be completed. (1)'); }, 'RESTORE_FAILED'],
    ['a path with -128 in it', async () => { throw new Error('0:108: execution error: ERROR other users can change the destination folder /Volumes/USB-128GB/Photos (1)'); }, 'DESTINATION_FOLDER_REFUSED'],
    // The helper's one folder refusal that names no folder: `cd -P` into it failed (FG4d, review #6, #16).
    ['a folder root could not open', async () => 'ERROR the destination folder could not be opened\n', 'DESTINATION_FOLDER_REFUSED'],
    // A snapshot that could not be mounted was not looked in (FG4d, review #5).
    ['no snapshot mounted', async () => 'ERROR no snapshot could be mounted (mount_apfs: volume could not be mounted: Operation not permitted), so whether the snapshots hold that path is not known\n', 'RESTORE_FAILED'],
    ['some snapshots not mounted', async () => 'ERROR 1 of the 2 snapshots could not be mounted (mount_apfs: Resource busy), and none of the others holds that path, so whether it can be recovered is not known\n', 'RESTORE_FAILED'],
    // A placement that failed with the name free is not a name taken (FG4d, review #7).
    ['a copy not put in place', async () => 'ERROR the copy could not be put in place (link: ../a.txt: Operation not supported), and nothing was written at the destination\n', 'RESTORE_FAILED'],
    // Found only through a link out of the snapshot: the snapshot does not hold it (FG4d, review #12).
    ['only through a link out', async () => 'ERROR that path leads out of the snapshot through a link in it, so it was not copied\n', 'NOT_IN_ANY_SNAPSHOT'],
  ];
  try {
    for (const [what, answer, code] of cases) {
      setAdminPromptForTests(answer);
      const original = path.join(tmp('treemap-place-codes-'), 'notes.txt');
      await assert.rejects(restoreFromSnapshot({ path: original }), (err: unknown) => {
        assert.ok(err instanceof AppError && err.status === 409, `${what}: ${String(err)}`);
        assert.equal(err.code, code, `${what} is ${code}: ${err.message}`);
        if (what === 'only through a link out') assert.match(err.message, /only through a link that leads out of them/);
        return true;
      });
    }
  } finally {
    setAdminPromptForTests(null);
    provider.listSnapshots = saved.list;
    provider.recoverFromSnapshots = saved.recover;
  }
});

test('a destination taken when the copy ran answers 409 DESTINATION_OCCUPIED, as one taken before', async () => {
  const provider = platform() as unknown as Record<'listSnapshots' | 'recoverFromSnapshots', unknown>;
  const saved = { list: provider.listSnapshots, recover: provider.recoverFromSnapshots };
  provider.listSnapshots = async () => SNAPSHOTS;
  provider.recoverFromSnapshots = async () => ({ restored: false, destinationTaken: true, reason: 'Something is already at the destination.' });
  try {
    const original = path.join(tmp('treemap-place-service-'), 'notes.txt');
    await assert.rejects(restoreFromSnapshot({ path: original }),
      (err: unknown) => err instanceof AppError && err.code === 'DESTINATION_OCCUPIED' && err.status === 409);
  } finally {
    provider.listSnapshots = saved.list;
    provider.recoverFromSnapshots = saved.recover;
  }
});

/* ══════════════════ With overwrite, every refusal comes before the Trash (FG4d, review #4, #14) ══════════════════ */

/** The provider answering as macOS does, whatever this machine is; `undo` puts it back. */
function macProvider(): { undo: () => void } {
  const provider = platform() as unknown as Record<'listSnapshots' | 'recoverFromSnapshots' | 'restoreFolderRefusal', unknown>;
  const saved = { list: provider.listSnapshots, recover: provider.recoverFromSnapshots, folder: provider.restoreFolderRefusal };
  provider.listSnapshots = async () => SNAPSHOTS;
  provider.recoverFromSnapshots = (s: VolumeSnapshotRef[], o: string, d: string) => recoverFromSnapshots(s, o, d);
  provider.restoreFolderRefusal = (dir: string) => restoreFolderRefusal(dir);
  return {
    undo: () => {
      provider.listSnapshots = saved.list;
      provider.recoverFromSnapshots = saved.recover;
      provider.restoreFolderRefusal = saved.folder;
    },
  };
}

test('with overwrite, a destination folder others can change is refused before the file there is moved to the Trash', { skip: process.platform === 'win32' || UID === 0 }, async () => {
  const dir = tmp('treemap-place-overwrite-');
  const existing = path.join(dir, 'notes.txt');
  fs.writeFileSync(existing, 'newer work');
  fs.chmodSync(dir, 0o777);
  const trashed: string[] = [];
  setTrashStepForTests(async (p) => { trashed.push(p); });
  let asked = 0;
  setAdminPromptForTests(async () => { asked++; return 'NOTFOUND\n'; });
  const mac = macProvider();
  try {
    await assert.rejects(restoreFromSnapshot({ path: path.join(dir, 'lost.txt'), destination: existing, overwrite: true }),
      (err: unknown) => err instanceof AppError && err.status === 409 && err.code === 'DESTINATION_FOLDER_REFUSED');
    assert.deepEqual(trashed, [], 'nothing was moved to the Trash for a restore that was refused');
    assert.equal(asked, 0, 'and no password was asked for');
    assert.equal(fs.readFileSync(existing, 'utf8'), 'newer work');
  } finally {
    mac.undo();
    setAdminPromptForTests(null);
    setTrashStepForTests(null);
    fs.chmodSync(dir, 0o700);
  }
});

test('with overwrite, a restore that stops after the Trash step says the replaced file is in the Trash', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp('treemap-place-overwrite-');
  const existing = path.join(dir, 'notes.txt');
  fs.writeFileSync(existing, 'newer work');
  const trashed: string[] = [];
  setTrashStepForTests(async (p) => { trashed.push(p); });
  setAdminPromptForTests(async () => { throw new Error('0:12: execution error: User canceled. (-128)'); });
  const mac = macProvider();
  try {
    await assert.rejects(restoreFromSnapshot({ path: path.join(dir, 'lost.txt'), destination: existing, overwrite: true }), (err: unknown) => {
      assert.ok(err instanceof AppError && err.code === 'AUTHORIZATION_DECLINED', String(err));
      assert.match(err.message, /had already been moved to the Trash/, err.message);
      return true;
    });
    assert.deepEqual(trashed, [existing]);
  } finally {
    mac.undo();
    setAdminPromptForTests(null);
    setTrashStepForTests(null);
  }
});

/* ══════════════════ Linux and Windows: a restore that failed says so (FG4d, review #8, #17) ══════════════════ */

test('a Linux restore whose copy fails is a failed restore, saying what was left at the destination', { skip: process.platform === 'win32' || UID === 0 }, async () => {
  const snap = tmp('treemap-btrfs-snap-');
  const album = path.join(snap, 'home', 'me', 'album');
  fs.mkdirSync(album, { recursive: true });
  fs.writeFileSync(path.join(album, 'a.jpg'), 'readable');
  fs.writeFileSync(path.join(album, 'b.jpg'), 'unreadable');
  fs.writeFileSync(path.join(snap, 'home', 'me', 'locked.txt'), 'unreadable');
  fs.chmodSync(path.join(album, 'b.jpg'), 0o000);
  fs.chmodSync(path.join(snap, 'home', 'me', 'locked.txt'), 0o000);
  const ref: VolumeSnapshotRef = { id: 'snap-1', name: 'snap-1', takenAt: 1, volume: '/', accessPath: snap };
  const dir = tmp('treemap-btrfs-dest-');
  try {
    const folder = await new LinuxProvider().recoverFromSnapshots([ref], '/home/me/album', path.join(dir, 'album (recovered)'));
    assert.equal(folder.restored, false);
    assert.equal(folder.failed, true, JSON.stringify(folder));
    assert.match(folder.reason ?? '', /EACCES/);
    assert.match(folder.reason ?? '', /What was copied before it failed is at/, 'the half-made folder is named, not passed off as a restore');

    const file = await new LinuxProvider().recoverFromSnapshots([ref], '/home/me/locked.txt', path.join(dir, 'locked (recovered).txt'));
    assert.equal(file.failed, true, JSON.stringify(file));
    assert.match(file.reason ?? '', /Nothing was left at the destination/);
    assert.equal(fs.existsSync(path.join(dir, 'locked (recovered).txt')), false);

    // Through the service: 409 RESTORE_FAILED, never a raw errno read as "not allowed to read".
    const provider = platform() as unknown as Record<'listSnapshots' | 'recoverFromSnapshots', unknown>;
    const saved = { list: provider.listSnapshots, recover: provider.recoverFromSnapshots };
    provider.listSnapshots = async () => [ref];
    provider.recoverFromSnapshots = (s: VolumeSnapshotRef[], o: string, d: string) => new LinuxProvider().recoverFromSnapshots(s, o, d);
    try {
      await assert.rejects(restoreFromSnapshot({ path: '/home/me/locked.txt', destination: path.join(dir, 'again.txt') }),
        (err: unknown) => err instanceof AppError && err.status === 409 && err.code === 'RESTORE_FAILED');
    } finally {
      provider.listSnapshots = saved.list;
      provider.recoverFromSnapshots = saved.recover;
    }
  } finally {
    fs.chmodSync(path.join(album, 'b.jpg'), 0o644);
    fs.chmodSync(path.join(snap, 'home', 'me', 'locked.txt'), 0o644);
  }
});

test('a Linux snapshot that could not be looked in is not one that lacks the path', { skip: process.platform === 'win32' || UID === 0 }, async () => {
  const snap = tmp('treemap-btrfs-snap-');
  const home = path.join(snap, 'home');
  fs.mkdirSync(path.join(home, 'me'), { recursive: true });
  fs.writeFileSync(path.join(home, 'me', 'notes.txt'), 'old notes');
  fs.chmodSync(home, 0o000);
  const ref: VolumeSnapshotRef = { id: 'snap-1', name: 'snap-1', takenAt: 1, volume: '/', accessPath: snap };
  try {
    const result = await new LinuxProvider().recoverFromSnapshots([ref], '/home/me/notes.txt', path.join(tmp('treemap-btrfs-dest-'), 'notes.txt'));
    assert.equal(result.restored, false);
    assert.equal(result.failed, true, JSON.stringify(result));
    assert.match(result.reason ?? '', /None of the 1 btrfs snapshot could be opened \(EACCES/);
  } finally {
    fs.chmodSync(home, 0o755);
  }
});

test('a Windows restore point that could not be opened is a failed restore, never "in no restore point"', async () => {
  const snaps: VolumeSnapshotRef[] = [
    { id: '{shadow-2}', name: 'b', takenAt: 2, volume: 'C:', accessPath: null },
    { id: '{shadow-1}', name: 'a', takenAt: 1, volume: 'C:', accessPath: null },
  ];
  const dest = path.join(tmp('treemap-vss-dest-'), 'notes (recovered).txt');
  // Nothing is started here: the two steps that would run PowerShell are stood in for.
  const unfound = new WindowsProvider() as unknown as { deviceObjectFor: unknown; linkShadow: unknown; recoverFromSnapshots: WindowsProvider['recoverFromSnapshots'] };
  unfound.deviceObjectFor = async () => null;
  unfound.linkShadow = async () => { throw new Error('the stand-in: no link was expected'); };
  const none = await unfound.recoverFromSnapshots(snaps, 'C:\\Users\\me\\notes.txt', dest);
  assert.equal(none.failed, true, JSON.stringify(none));
  assert.match(none.reason ?? '', /None of the 2 restore points could be opened/);

  const denied = new WindowsProvider() as unknown as typeof unfound;
  denied.deviceObjectFor = async () => '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1';
  denied.linkShadow = async () => { throw new Error('You do not have sufficient privilege to perform this operation.'); };
  const refused = await denied.recoverFromSnapshots(snaps, 'C:\\Users\\me\\notes.txt', dest);
  assert.equal(refused.failed, true, JSON.stringify(refused));
  assert.match(refused.reason ?? '', /administrator rights/);
  assert.equal(fs.existsSync(dest), false);
});
