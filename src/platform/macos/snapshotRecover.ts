import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import type { VolumeSnapshotRef, SnapshotRecoveryResult } from '../types';
import { relativeToVolume } from '../snapshotPaths';
import { destinationTakenReason } from '../snapshotCopy';
import { RealMachineRefusal, refuseUnderTestRunner } from '../../services/realMachineGuard';

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
 * folder it makes there itself (`mktemp -d`), and places the copy with a call
 * that fails whatever is at the name — then confirms, by the copy's own device
 * and inode, that the name holds it (FG4c: `mv -n -h` alone moved a copy inside
 * a folder that appeared at the name, and replaced a dangling link). The same
 * folder rule is checked here before the password is asked for (FG4c). Its
 * placement functions are exported and run in the tests as the user, against
 * folders made there; the whole script runs in tests/snapshotRootHelper.test.ts
 * with `mount_apfs` and `umount` stood in for.
 */

/**
 * The two steps of the root script that touch the destination (FG4, FG4c), run in the tests as
 * the user. `enter_destination <folder> <uid>` makes the folder the working folder by its
 * physical path and refuses it unless it belongs to <uid> or root and neither group nor others
 * can write it. `place_copy <source> <name> <uid> <gid>` copies into a folder it makes in the
 * working folder, hands the copy to <uid>:<gid>, checks the name again, and places the copy at
 * <name>: a file with `link`, which fails whatever is at the name (a dangling link or a folder
 * included) and follows nothing; a link with `ln -P -h`; a folder with `mv -n -h`. `mv` and `ln`
 * put the copy INSIDE a folder that appears at the name at the last moment, so the name must
 * then hold the copy itself — the same device and inode — or it is reported (FG4c, review #9,
 * #4). It removes its own folder again, and prints an ERROR line when it fails. A refusal exits
 * 0: under `do shell script` a non-zero exit is an AppleScript error, not output (review #3).
 */
export const PLACEMENT_FUNCTIONS = `
stage=''
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
}
place_copy() {
  if [ -e "./$2" ] || [ -L "./$2" ]; then
    echo "ERROR something already exists at the destination"; return 1
  fi
  stage=$(mktemp -d ./.treemap-restore.XXXXXX) || { stage=''; echo "ERROR could not make a folder to copy into"; return 1; }
  if ! cp -a "$1" "$stage/item" 2>/dev/null; then
    rm -rf -- "$stage"; stage=''
    echo "ERROR the copy out of the snapshot failed"; return 1
  fi
  chown -R "$3:$4" "$stage/item" 2>/dev/null || true
  copy_id=$(stat -f '%d:%i' "$stage/item") || { rm -rf -- "$stage"; stage=''; echo "ERROR the copy could not be checked"; return 1; }
  if [ -e "./$2" ] || [ -L "./$2" ]; then
    rm -rf -- "$stage"; stage=''
    echo "ERROR something appeared at the destination while copying, and nothing was written over it"; return 1
  fi
  if [ -d "$stage/item" ] && [ ! -L "$stage/item" ]; then
    mv -n -h "$stage/item" "./$2" 2>/dev/null
  elif [ -L "$stage/item" ]; then
    ln -P -h "$stage/item" "./$2" 2>/dev/null && rm -f -- "$stage/item"
  else
    link "$stage/item" "./$2" 2>/dev/null && rm -f -- "$stage/item"
  fi
  if [ -e "$stage/item" ] || [ -L "$stage/item" ]; then
    rm -rf -- "$stage"; stage=''
    echo "ERROR something appeared at the destination while copying, and nothing was written over it"; return 1
  fi
  rmdir -- "$stage" 2>/dev/null || true
  stage=''
  if [ "$(stat -f '%d:%i' "./$2" 2>/dev/null)" != "$copy_id" ]; then
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
# reach TreeMap as an answer.
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
  if [ -n "$stage" ] && [ -d "$stage" ]; then rm -rf -- "$stage"; fi
}
trap cleanup EXIT INT TERM

outside=0
for snapshot in "$@"; do
  if ! mount_apfs -s "$snapshot" "$volume" "$mount_point" 2>/dev/null; then
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

/** The helper's refusals of the destination folder itself (enter_destination). */
const FOLDER_REFUSED = /^(the destination folder .* (belongs to another user|could not be (opened|checked))|other users can change the destination folder)/;
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
  // for (FG4c, review #24). POSIX owners and modes: this module runs on a Mac; on Windows, where
  // the tests also call it, stat has no such bits to read.
  if (process.platform !== 'win32') {
    const refusal = destinationFolderRefusal(await fsp.stat(destinationDir), destinationDir, os.userInfo().uid);
    if (refusal) return { restored: false, destinationRefused: true, reason: refusal };
  }

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
