import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import type { VolumeSnapshotRef, SnapshotRecoveryResult } from '../types';
import { relativeToVolume } from '../snapshotPaths';

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
 */

/**
 * The privileged helper, held as text here and written to a temp file when it
 * is needed rather than shipped as a `.sh` beside this module.
 *
 * Not a style choice: the desktop build packs the app into `app.asar`, and
 * `/bin/sh` cannot execute a path inside an asar archive. A sibling script file
 * would work in development and fail only in the packaged app — the worst place
 * to find out.
 *
 * It interpolates nothing. Every value the caller supplies arrives as argv, so
 * a filename containing quotes, spaces, `$(…)` or a newline stays data.
 */
const RECOVER_SCRIPT = `#!/bin/sh
# Recover one path from the newest APFS local snapshot that holds it.
#
#   $1  volume the snapshots belong to        e.g. /
#   $2  path inside the snapshot, relative    e.g. Users/me/notes.txt
#   $3  destination to copy to
#   $4  uid to hand the recovered copy to
#   $5  gid to hand the recovered copy to
#   $6… snapshot names, newest first
#
# Prints "FOUND <snapshot>", "NOTFOUND", or "ERROR <detail>".
set -u

volume=$1
rel=$2
dest=$3
owner_uid=$4
owner_gid=$5
shift 5

mount_point=$(mktemp -d /tmp/treemap-snap-XXXXXX) || { echo "ERROR could not create a mount point"; exit 1; }

# However this exits — success, failure or a signal — the snapshot must not be
# left mounted. An orphaned snapshot mount is invisible in Finder yet pins the
# snapshot's storage, so leaking one turns recovery into a disk-space leak.
cleanup() {
  umount "$mount_point" 2>/dev/null || true
  rmdir "$mount_point" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for snapshot in "$@"; do
  if ! mount_apfs -s "$snapshot" "$volume" "$mount_point" 2>/dev/null; then
    continue
  fi
  if [ -e "$mount_point/$rel" ]; then
    # -a keeps mode, timestamps and symlinks: a "restored" file whose dates were
    # reset to now is not the file the user lost.
    if cp -a "$mount_point/$rel" "$dest" 2>/dev/null; then
      chown -R "$owner_uid:$owner_gid" "$dest" 2>/dev/null || true
      umount "$mount_point" 2>/dev/null || true
      echo "FOUND $snapshot"
      exit 0
    fi
    umount "$mount_point" 2>/dev/null || true
    echo "ERROR the copy out of $snapshot failed"
    exit 1
  fi
  umount "$mount_point" 2>/dev/null || true
done

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
  destination: string,
  uid: number,
  gid: number,
  snapshotIds: string[],
): string {
  const quoted = (value: string): string => `quoted form of "${appleScriptString(value)}"`;
  const args = [
    quoted(script),
    quoted(volume),
    quoted(relativePath),
    quoted(destination),
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

/** macOS reports a dismissed authorization prompt as error -128. */
export function isUserCancelled(message: string): boolean {
  return /-128|User cancell?ed/i.test(message);
}


function runOsascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 10 * 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').trim()));
      else resolve(stdout);
    });
  });
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

  // Newest first: the most recent copy of a file is the one the user wants back.
  const ordered = [...snapshots].sort((a, b) => (b.takenAt ?? 0) - (a.takenAt ?? 0));
  await fsp.mkdir(path.dirname(destination), { recursive: true });

  const helper = await writeHelper();
  let stdout: string;
  try {
    stdout = await runOsascript(
      buildRecoveryScript(helper.path, volume, relative, destination, os.userInfo().uid, os.userInfo().gid, ordered.map((s) => s.id)),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isUserCancelled(message)) {
      // Not a failure. The user was asked and said no.
      return { restored: false, cancelled: true, reason: 'Recovery needs an administrator password, and the prompt was dismissed.' };
    }
    return { restored: false, reason: `The snapshot could not be opened (${message}).` };
  } finally {
    await helper.cleanup().catch(() => {});
  }

  const { found, error } = parseRecoveryOutput(stdout);
  if (error) return { restored: false, reason: error };
  if (!found) {
    return {
      restored: false,
      reason: `None of the ${ordered.length} local snapshot${ordered.length === 1 ? '' : 's'} on this Mac contain that path.`,
    };
  }

  const stat = await fsp.stat(destination).catch(() => null);
  return {
    restored: true,
    fromSnapshotId: found,
    ...(stat ? { sizeBytes: stat.size } : {}),
  };
}
