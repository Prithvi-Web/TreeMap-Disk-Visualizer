import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-snapshotRestorePlacement-data-');

import {
  PLACEMENT_FUNCTIONS, RECOVER_SCRIPT, buildRecoveryScript, recoverFromSnapshots, runAdminPrompt, setAdminPromptForTests,
} from '../src/platform/macos/snapshotRecover';
import { copyOutOfSnapshot } from '../src/platform/snapshotCopy';
import { LinuxProvider } from '../src/platform/linux';
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
 * folder it makes there, and renames the copy into place with `mv -n -h`, confirming it moved.
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

/** Runs the placement functions as this user: enter `destDir` as `owner`, then place `src` there as `name`. */
function place(destDir: string, name: string, src: string, opts: { owner?: number; before?: string; env?: NodeJS.ProcessEnv } = {}) {
  const driver = `${PLACEMENT_FUNCTIONS}\n${opts.before ?? ''}\nset -u\nenter_destination "$1" "$2"\nplace_copy "$3" "$4" "$2" "$5" && echo PLACED\n`;
  // This process's environment, so the child carries the test runner's guard
  // (childEnvCarriesGuard.test.ts), with the system's own commands first on PATH as root's are.
  const run = spawnSync('/bin/sh', ['-c', driver, 'sh', destDir, String(opts.owner ?? UID), src, name, String(GID)], {
    encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...opts.env },
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
  const before = 'cp() { ln -s "$TM_VICTIM" "./$TM_NAME"; command cp "$@"; }';
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
  const before = 'cp() { command cp "$@"; ln -s "$TM_VICTIM" "./$TM_NAME"; }';
  const { out } = place(dest, 'lost.txt', source(), { before, env: { TM_VICTIM: v.file, TM_NAME: 'lost.txt' } });
  assert.match(out, /^ERROR something appeared at the destination/);
  assert.equal(fs.readFileSync(v.file, 'utf8'), v.content, 'the file the link leads to is untouched');
  assert.equal(fs.readlinkSync(path.join(dest, 'lost.txt')), v.file, 'the link was not replaced either');
  assert.deepEqual(fs.readdirSync(dest), ['lost.txt'], 'and the copy made for the move is gone');
});

test('a link to a folder that appears at the name is not moved into', { skip: !onMac }, () => {
  const dest = tmp('treemap-place-dest-');
  const elsewhere = tmp('treemap-place-elsewhere-');
  const before = 'cp() { command cp "$@"; ln -s "$TM_VICTIM" "./$TM_NAME"; }';
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

test('the macOS helper refusing a name at the destination is reported as the destination taken', async () => {
  const dest = path.join(tmp('treemap-place-prompt-'), 'a (recovered).txt');
  setAdminPromptForTests(async () => 'ERROR something appeared at the destination while copying, and nothing was written over it\n');
  try {
    const result = await recoverFromSnapshots(SNAPSHOTS, '/Users/me/a.txt', dest);
    assert.equal(result.restored, false);
    assert.equal(result.destinationTaken, true);
    assert.match(result.reason ?? '', /nothing was restored over it/);
  } finally {
    setAdminPromptForTests(null);
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
