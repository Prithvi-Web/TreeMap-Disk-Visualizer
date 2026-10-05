import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import type { VolumeSnapshotRef, SnapshotRecoveryResult } from '../types';
import { relativeToVolume } from '../snapshotPaths';
import { destinationTakenReason } from '../snapshotCopy';
import { RealMachineRefusal, refuseUnderTestRunner } from '../../services/realMachineGuard';
import { meansAbsent } from '../../utils/errno';

/**
 * Recovering a deleted file from an APFS local snapshot (B4, macOS).
 *
 * ── What was measured on this Mac, and why the design follows from it ──
 *
 * `tmutil listlocalsnapshots /` works as an ordinary user. Reading a snapshot's
 * *contents* does not:
 *
 *     mount_apfs -s <snap> /                      → "Resource busy"
 *     mount_apfs -s <snap> /System/Volumes/Data   → "Operation not permitted"
 *
 * The first is the boot volume refusing to have its own snapshot mounted over
 * itself; the second is the honest answer — mounting needs root. There is no
 * unprivileged route: no `.snapshot` directory (that is ZFS and NetApp), and
 * nothing pre-mounted under `/Volumes`.
 *
 * So the feature splits exactly where the privilege boundary is:
 *
 *   - **Enumerating** snapshots, and saying which ones cover the period a file
 *     went missing, costs nothing and asks for nothing.
 *   - **Reading** one requires authorization, so it is requested once, at the
 *     moment the user clicks Restore, with an explanation shown first (§3.8).
 *
 * ── One prompt, not one per snapshot ──
 *
 * Searching six snapshots as six privileged calls would show six password
 * prompts. Instead the whole search runs inside a single elevated shell script
 * (`snapshotRecover.sh`): mount, look, copy, unmount, next. One prompt for the
 * entire operation.
 *
 * ── Why a script file rather than an inline command ──
 *
 * `do shell script … with administrator privileges` takes a *string*, which is
 * the classic place a path containing a quote or `$(…)` becomes executable
 * text. The script is therefore a fixed file that interpolates nothing, and
 * every user-supplied value is passed as its own argv word through
 * AppleScript's `quoted form of`. A malicious filename is data at every step.
 *
 * ── Never through a name already there (FG4) ──
 *
 * The destination is checked in Node before the prompt, and the prompt can
 * stay open for minutes; `cp -a` onto a link planted in between wrote, as root,
 * wherever the link led. So the root script enters the destination folder by
 * its physical path (`cd -P`) and works relative to it from then on, refuses a
 * folder another account could change (not owned by the user or root, or
 * writable by group or others — where names can be swapped), copies into a
 * folder it makes there itself (`mktemp -d`) and works from inside it (FG4d),
 * and places the copy: a file with `link`, which fails whatever is at the name;
 * a link with `ln -P -h` and a folder with `mv -n -h`, which do not fail for a
 * real folder that appears at the name at the last moment but put the copy
 * inside it — that is found afterwards, not prevented: the name must hold the
 * copy's own device and inode, or the restore is reported refused (FG4c: `mv -n
 * -h` alone moved a copy inside a folder that appeared at the name, and
 * replaced a dangling link; RISKS R102). The same folder rule is checked before
 * the password is asked for — and before anything is moved to the Trash
 * (restoreFolderRefusal, FG4c, FG4d). Its placement functions are exported and
 * run in the tests as the user, against folders made there; the whole script
 * runs in tests/snapshotRootHelper.test.ts with `mount_apfs` and `umount` stood
 * in for.
 */

/**
 * The two steps of the root script that touch the destination (FG4, FG4c, FG4d), run in the tests
 * as the user. `enter_destination <folder> <uid>` makes the folder the working folder by its
 * physical path and refuses it unless it belongs to <uid> or root and neither group nor others
 * can write it. `place_copy <source> <name> <uid> <gid>` makes a folder of its own there
 * (`mktemp -d`), enters it by its physical path and works from inside it — `./item` for the copy,
 * `../<name>` for where it goes — so a folder swapped in under that folder's name later is never
 * written to; the folder entered must be the running account's (root's, as the helper runs), 0700,
 * empty — no entry at all — and its parent the destination folder (FG4d, review #3), judged before
 * anything is changed in it, since a link swapped in for its name before `cd -P` leads elsewhere
 * (FG4e, review L1); only then is its access list, which it would inherit from a destination folder
 * the user owns, cleared, and it is judged again with no access-list entry allowed. It
 * copies, unlocks the copy (a Finder-locked item can be neither handed over nor put in place, by
 * root either: FG4d, review #18), hands it to <uid>:<gid>, checks the name again, and places it:
 * a file with `link`, which fails whatever is at the name; a link with `ln -P -h`, a folder with
 * `mv -n -h` — and a file with `mv -n -h` too where `link` fails with nothing at the name (a
 * volume without hard links, FAT or exFAT: FG4d, review #13). `mv` and `ln` put the copy INSIDE a
 * real folder that appears at the name at the last moment; that is not prevented but found
 * afterwards, since the name must then hold the copy itself — the same device and inode — or it
 * is reported (FG4c, review #9, #4; RISKS R102). A placement that failed with the name still free
 * says why, in its own words, rather than that something appeared (FG4d, review #7). It removes
 * its own folder again, and prints an ERROR line when it fails. A refusal exits 0: under `do
 * shell script` a non-zero exit is an AppleScript error, not output (review #3).
 */
export const PLACEMENT_FUNCTIONS = `
stage=''
in_stage=0
dest_id=''
enter_destination() {
  cd -P -- "$1" 2>/dev/null || { echo "ERROR the destination folder could not be opened"; exit 0; }
  here=$(pwd -P)
  dir_uid=$(stat -f '%u' .) || { echo "ERROR the destination folder $here could not be checked"; exit 0; }
  if [ "$dir_uid" != "$2" ] && [ "$dir_uid" != 0 ]; then
    echo "ERROR the destination folder $here belongs to another user"; exit 0
  fi
  if [ -n "$(find . -maxdepth 0 \\( -perm -020 -o -perm -002 \\) -print)" ]; then
    echo "ERROR other users can change the destination folder $here"; exit 0
  fi
  dest_id=$(stat -f '%d:%i' .) || { echo "ERROR the destination folder $here could not be checked"; exit 0; }
}
leave_stage() {
  if [ "$in_stage" = 1 ]; then
    chflags -R nouchg,nouappnd . 2>/dev/null
    rm -rf -- ./item 2>/dev/null
    cd .. 2>/dev/null
    in_stage=0
  fi
  if [ -n "$stage" ]; then rmdir -- "$stage" 2>/dev/null; fi
  stage=''
}
stage_is_ours() {
  [ "$(stat -f '%u:%Lp' . 2>/dev/null)" = "$(id -u):700" ] && [ "$(stat -f '%d:%i' .. 2>/dev/null)" = "$dest_id" ] && [ -z "$(ls -A . 2>&1)" ]
}
refuse_stage() {
  if cd .. 2>/dev/null && [ "$(stat -f '%d:%i' . 2>/dev/null)" = "$dest_id" ]; then rmdir -- "$stage" 2>/dev/null; fi
  stage=''
  echo "ERROR the folder made to copy into was changed before anything was copied into it, so nothing was copied"
}
place_copy() {
  if [ -e "./$2" ] || [ -L "./$2" ]; then
    echo "ERROR something already exists at the destination"; return 1
  fi
  stage=$(mktemp -d ./.treemap-restore.XXXXXX) || { stage=''; echo "ERROR could not make a folder to copy into"; return 1; }
  cd -P -- "$stage" 2>/dev/null || { leave_stage; echo "ERROR the folder made to copy into could not be opened"; return 1; }
  # Judged before anything is changed in it: its name could have been swapped for a link between
  # mktemp and cd, and then "." is wherever that link led (FG4e, review L1).
  if ! stage_is_ours; then refuse_stage; return 1; fi
  chmod -N . 2>/dev/null
  if ! stage_is_ours || [ -n "$(ls -led . 2>/dev/null | sed -n 2p)" ]; then refuse_stage; return 1; fi
  in_stage=1
  if ! cp -a "$1" ./item 2>/dev/null; then
    leave_stage; echo "ERROR the copy out of the snapshot failed"; return 1
  fi
  chflags -R nouchg,nouappnd ./item 2>/dev/null || true
  chown -R "$3:$4" ./item 2>/dev/null || true
  copy_id=$(stat -f '%d:%i' ./item) || { leave_stage; echo "ERROR the copy could not be checked"; return 1; }
  if [ "$(stat -f '%d:%i' ..)" != "$dest_id" ]; then
    leave_stage; echo "ERROR the folder made to copy into was moved while copying, so the copy was not placed"; return 1
  fi
  if [ -e "../$2" ] || [ -L "../$2" ]; then
    leave_stage; echo "ERROR something appeared at the destination while copying, and nothing was written over it"; return 1
  fi
  why=''
  if [ -d ./item ] && [ ! -L ./item ]; then
    why=$(mv -n -h ./item "../$2" 2>&1)
  elif [ -L ./item ]; then
    why=$(ln -P -h ./item "../$2" 2>&1) && rm -f -- ./item
  else
    why=$(link ./item "../$2" 2>&1) && rm -f -- ./item
    if [ -e ./item ] && [ ! -e "../$2" ] && [ ! -L "../$2" ]; then
      mv -n -h ./item "../$2" 2>/dev/null || true
    fi
  fi
  if [ -e ./item ] || [ -L ./item ]; then
    if [ -e "../$2" ] || [ -L "../$2" ]; then
      leave_stage; echo "ERROR something appeared at the destination while copying, and nothing was written over it"; return 1
    fi
    why=$(printf '%s\\n' "$why" | head -n 1)
    [ -n "$why" ] || why='no reason given'
    leave_stage; echo "ERROR the copy could not be put in place ($why), and nothing was written at the destination"; return 1
  fi
  placed_id=$(stat -f '%d:%i' "../$2" 2>/dev/null)
  leave_stage
  if [ "$placed_id" != "$copy_id" ]; then
    echo "ERROR something appeared at the destination while copying, and the copy is not in its place (it may be inside what appeared, as $2/item); nothing was written over it"; return 1
  fi
  return 0
}
`;

/**
 * The privileged helper, held as text here and written to a temp file when it
 * is needed rather than shipped as a `.sh` beside this module.
 *
 * Not a style choice: the desktop build packs the app into `app.asar`, and
 * `/bin/sh` cannot execute a path inside an asar archive. A sibling script file
 * would work in development and fail only in the packaged app — the worst place
 * to find out.
 *
 * It interpolates nothing at run time. Every value the caller supplies arrives
 * as argv, so a filename containing quotes, spaces, `$(…)` or a newline stays
 * data.
 */
export const RECOVER_SCRIPT = `#!/bin/sh
# Recover one path from the newest APFS local snapshot that holds it.
#
#   $1  volume the snapshots belong to        e.g. /
#   $2  path inside the snapshot, relative    e.g. Users/me/notes.txt
#   $3  folder to restore into
#   $4  name to restore as, in that folder
#   $5  uid to hand the recovered copy to (the folder must be theirs or root's)
#   $6  gid to hand the recovered copy to
#   $7… snapshot names, newest first
#
# Prints "FOUND <snapshot>", "NOTFOUND", or "ERROR <detail>", and exits 0 with any of them:
# under do shell script a non-zero exit is an AppleScript error, and the line would never
# reach TreeMap as an answer. NOTFOUND means every snapshot was mounted and looked in.
set -u

volume=$1
rel=$2
dest_dir=$3
dest_name=$4
owner_uid=$5
owner_gid=$6
shift 6
${PLACEMENT_FUNCTIONS}
case $dest_name in
  ''|.|..|*/*) echo "ERROR the destination name is not a plain name"; exit 0 ;;
esac

# Checked here, as root, just before anything is copied — not only in TreeMap
# before the password prompt, which can stay open for minutes.
enter_destination "$dest_dir" "$owner_uid"
if [ -e "./$dest_name" ] || [ -L "./$dest_name" ]; then
  echo "ERROR something already exists at the destination"; exit 0
fi

mount_point=$(mktemp -d /tmp/treemap-snap-XXXXXX) || { echo "ERROR could not create a mount point"; exit 0; }

# However this exits — success, failure or a signal — the snapshot must not be
# left mounted. An orphaned snapshot mount is invisible in Finder yet pins the
# snapshot's storage, so leaking one turns recovery into a disk-space leak. A
# copy half made in place_copy's own folder goes too.
cleanup() {
  umount "$mount_point" 2>/dev/null || true
  rmdir "$mount_point" 2>/dev/null || true
  leave_stage
}
trap cleanup EXIT INT TERM

# A snapshot that could not be mounted was not looked in: it is counted, with the
# first reason, and never read as one that lacks the path (FG4d, review #5).
total=$#
unmounted=0
first_failure=''
outside=0
for snapshot in "$@"; do
  if ! failure=$(mount_apfs -s "$snapshot" "$volume" "$mount_point" 2>&1 >/dev/null); then
    unmounted=$((unmounted + 1))
    if [ -z "$first_failure" ]; then first_failure=$(printf '%s\\n' "$failure" | head -n 1); fi
    continue
  fi
  if [ -e "$mount_point/$rel" ] || [ -L "$mount_point/$rel" ]; then
    # The path must lie inside the mounted snapshot where the system resolves it: a
    # folder in the snapshot that is a link with an absolute target leads to the live
    # disk, which this copy, as root, would read (FG4c, review #7). A link as the last
    # name is copied as the link itself, so only the folder above it is resolved.
    mount_real=$(cd -P -- "$mount_point" 2>/dev/null && pwd -P) || mount_real=''
    source_dir=$(cd -P -- "$(dirname -- "$mount_point/$rel")" 2>/dev/null && pwd -P) || source_dir=''
    case "$source_dir/" in
      "$mount_real"/*) inside=1 ;;
      *) inside=0 ;;
    esac
    if [ -z "$mount_real" ] || [ -z "$source_dir" ] || [ "$inside" != 1 ]; then
      outside=1
      umount "$mount_point" 2>/dev/null || true
      continue
    fi
    # -a keeps mode, timestamps and symlinks: a "restored" file whose dates were
    # reset to now is not the file the user lost.
    if place_copy "$mount_point/$rel" "$dest_name" "$owner_uid" "$owner_gid"; then
      umount "$mount_point" 2>/dev/null || true
      echo "FOUND $snapshot"
      exit 0
    fi
    umount "$mount_point" 2>/dev/null || true
    exit 0
  fi
  umount "$mount_point" 2>/dev/null || true
done

if [ "$unmounted" != 0 ]; then
  if [ -z "$first_failure" ]; then first_failure='mount_apfs gave no reason'; fi
  if [ "$unmounted" = "$total" ]; then
    echo "ERROR no snapshot could be mounted ($first_failure), so whether the snapshots hold that path is not known"
  else
    echo "ERROR $unmounted of the $total snapshots could not be mounted ($first_failure), and none of the others holds that path, so whether it can be recovered is not known"
  fi
  exit 0
fi
if [ "$outside" = 1 ]; then
  echo "ERROR that path leads out of the snapshot through a link in it, so it was not copied"
  exit 0
fi
echo "NOTFOUND"
exit 0
`;

/** Write the helper to a private temp file, executable, and hand back its path. */
async function writeHelper(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-recover-'));
  const file = path.join(dir, 'snapshot-recover.sh');
  // 0700: only this user can read or run it, so nothing else on the machine can
  // swap the script out between it being written and being run as root.
  await fsp.writeFile(file, RECOVER_SCRIPT, { mode: 0o700 });
  return { path: file, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function appleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * The AppleScript that runs the recovery script as root.
 *
 * Pure and exported so tests can assert the quoting without ever triggering an
 * authorization prompt: every value goes through `quoted form of`, which is
 * what makes a filename containing `"; rm -rf ~` inert.
 */
export function buildRecoveryScript(
  script: string,
  volume: string,
  relativePath: string,
  destinationDir: string,
  destinationName: string,
  uid: number,
  gid: number,
  snapshotIds: string[],
): string {
  const quoted = (value: string): string => `quoted form of "${appleScriptString(value)}"`;
  const args = [
    quoted(script),
    quoted(volume),
    quoted(relativePath),
    quoted(destinationDir),
    quoted(destinationName),
    `"${String(uid)}"`,
    `"${String(gid)}"`,
    ...snapshotIds.map(quoted),
  ].join(' & " " & ');
  return `do shell script "/bin/sh " & ${args} with administrator privileges`;
}

/** Parse the script's single-line answer. Exported: this is the whole contract. */
export function parseRecoveryOutput(stdout: string): { found: string | null; error?: string } {
  const line = stdout.trim().split('\n').pop() ?? '';
  if (line.startsWith('FOUND ')) return { found: line.slice(6).trim() };
  if (line === 'NOTFOUND') return { found: null };
  if (line.startsWith('ERROR ')) return { found: null, error: line.slice(6).trim() };
  return { found: null, error: line || 'the recovery helper returned nothing' };
}

/**
 * macOS reports a dismissed authorization prompt as error -128: AppleScript's error number, in
 * parentheses at the end of osascript's message, whatever language the words are in. Anchored
 * there, so a path the message quotes (`/Volumes/USB-128GB`) is never read as a dismissal
 * (FG4c, review #3).
 */
export function isUserCancelled(message: string): boolean {
  return /\(-128\)\s*$/.test(message);
}

/**
 * The helper's own answer inside osascript's error text, `… execution error: ERROR <detail> (<n>)`
 * — the form a non-zero exit of the helper takes — or null. The helper exits 0 with every answer
 * (RECOVER_SCRIPT), so this is the backstop, not the contract (FG4c, review #3).
 */
function helperLineIn(message: string): string | null {
  const m = /execution error: (ERROR .+?) \(-?\d+\)\s*$/s.exec(message);
  return m ? m[1] : null;
}

/**
 * Why the copy may not be made as root in the folder `dir`, from its `stat`, or null: the rule
 * the root helper applies again when it runs (enter_destination) — the folder must belong to the
 * user (`uid`) or to root, and neither its group nor others may change it — checked here first,
 * before the administrator password is asked for (FG4c, review #24).
 */
export function destinationFolderRefusal(st: { uid: number; mode: number }, dir: string, uid: number): string | null {
  if (st.uid !== uid && st.uid !== 0) {
    return `The folder ${dir} belongs to another account, so TreeMap will not copy a file into it as administrator. Choose another destination, such as a folder in your home folder.`;
  }
  if ((st.mode & 0o022) !== 0) {
    return `Other accounts on this Mac can change the folder ${dir}, so TreeMap will not copy a file into it as administrator. Choose another destination, such as a folder in your home folder.`;
  }
  return null;
}

/**
 * The destination folder rule for `dir`, read from the folder itself, or null: null too when the
 * folder is not there yet (the restore makes it, and checks it again once made). The restore
 * service asks this before anything is moved to the Trash or a password asked for (FG4d, review
 * #4, #14); `recoverFromSnapshots` asks again after making the folder. POSIX owners and modes:
 * this module runs on a Mac; on Windows, where the tests also call it, stat has no such bits.
 */
export async function restoreFolderRefusal(dir: string): Promise<string | null> {
  if (process.platform === 'win32') return null;
  const st = await fsp.stat(dir).catch((err: NodeJS.ErrnoException) => {
    if (meansAbsent(err)) return null;
    throw err;
  });
  return st ? destinationFolderRefusal(st, dir, os.userInfo().uid) : null;
}

/** The helper's refusals of the destination folder itself (enter_destination). */
const FOLDER_REFUSED = /^(the destination folder( .*)? (belongs to another user|could not be (opened|checked))|other users can change the destination folder)/;
/** The helper's refusal of a name at the destination (place_copy, and the check before it). */
const NAME_TAKEN = /^something (already exists|appeared) at the destination/;
/** The helper found the path only through a link out of the snapshot. */
const LEADS_OUT = /leads out of the snapshot/;


/** What the real prompt refuses with under a test runner. */
const PROMPT_REFUSAL = 'a test reached the administrator password prompt (snapshot restore) — use setAdminPromptForTests';

/**
 * Runs `script` through osascript: the administrator password prompt, then the helper as root.
 * Exported for the test that proves it refuses under a test runner.
 */
export async function runAdminPrompt(script: string): Promise<string> {
  // No test may ever put a password prompt on the owner's screen (FG4).
  refuseUnderTestRunner(PROMPT_REFUSAL);
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 10 * 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').trim()));
      else resolve(stdout);
    });
  });
}

/** The step that asks for the password and runs the helper as root; a test replaces it. */
let adminPrompt: (script: string) => Promise<string> = runAdminPrompt;

/**
 * Test-only: answer the prompt with `step` instead, which is handed the AppleScript that would
 * have run; null restores the real prompt, which refuses under a test runner.
 */
export function setAdminPromptForTests(step: ((script: string) => Promise<string>) | null): void {
  adminPrompt = step ?? runAdminPrompt;
}

export async function recoverFromSnapshots(
  snapshots: VolumeSnapshotRef[],
  originalPath: string,
  destination: string,
): Promise<SnapshotRecoveryResult> {
  if (snapshots.length === 0) {
    return { restored: false, reason: 'There are no local snapshots on this Mac to look in.' };
  }
  const volume = snapshots[0].volume || '/';
  const relative = relativeToVolume(originalPath, volume);
  if (!relative) {
    return { restored: false, reason: 'That path is the volume itself, which cannot be recovered from a snapshot.' };
  }

  // Under a test runner the real prompt refuses before anything is written for it.
  if (adminPrompt === runAdminPrompt) refuseUnderTestRunner(PROMPT_REFUSAL);

  // Newest first: the most recent copy of a file is the one the user wants back.
  const ordered = [...snapshots].sort((a, b) => (b.takenAt ?? 0) - (a.takenAt ?? 0));
  const destinationDir = path.dirname(destination);
  await fsp.mkdir(destinationDir, { recursive: true });

  // The folder rule the root helper applies when it runs, checked before the password is asked
  // for (FG4c, review #24) — again, now that the folder is there: the service asked before it
  // made it or moved anything to the Trash (FG4d).
  const refusal = await restoreFolderRefusal(destinationDir);
  if (refusal) return { restored: false, destinationRefused: true, reason: refusal };

  const helper = await writeHelper();
  let stdout: string;
  try {
    stdout = await adminPrompt(
      buildRecoveryScript(
        helper.path, volume, relative, destinationDir, path.basename(destination),
        os.userInfo().uid, os.userInfo().gid, ordered.map((s) => s.id),
      ),
    );
  } catch (err) {
    // A test that reached the real prompt is a failure of the test, never the prompt's answer.
    if (err instanceof RealMachineRefusal) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const line = helperLineIn(message);
    if (line !== null) {
      stdout = line;
    } else if (isUserCancelled(message)) {
      // Not a failure. The user was asked and said no.
      return { restored: false, cancelled: true, reason: 'Recovery needs an administrator password, and the prompt was dismissed.' };
    } else {
      return { restored: false, failed: true, reason: `The snapshot could not be opened (${message}).` };
    }
  } finally {
    await helper.cleanup().catch(() => {});
  }

  const { found, error } = parseRecoveryOutput(stdout);
  // The helper refused a name at the destination, found when it ran (FG4).
  if (error && NAME_TAKEN.test(error)) {
    return { restored: false, destinationTaken: true, reason: `${destinationTakenReason(destination)} (${error})` };
  }
  // The folder changed after the check above, while the prompt was open (FG4c).
  if (error && FOLDER_REFUSED.test(error)) {
    return { restored: false, destinationRefused: true, reason: `The destination folder was refused when the copy ran (${error}). Choose another destination, such as a folder in your home folder.` };
  }
  if (error && LEADS_OUT.test(error)) {
    return { restored: false, reason: `The snapshots hold ${originalPath} only through a link that leads out of them, so nothing was copied.` };
  }
  if (error) return { restored: false, failed: true, reason: `The restore did not finish (${error}).` };
  if (!found) {
    return {
      restored: false,
      reason: `None of the ${ordered.length} local snapshot${ordered.length === 1 ? '' : 's'} on this Mac contain that path.`,
    };
  }

  const stat = await fsp.lstat(destination).catch(() => null);
  return {
    restored: true,
    fromSnapshotId: found,
    ...(stat ? { sizeBytes: stat.size } : {}),
  };
}
