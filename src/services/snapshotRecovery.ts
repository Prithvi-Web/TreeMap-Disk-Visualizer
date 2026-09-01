import { promises as fsp } from 'fs';
import path from 'path';
import { platform } from '../platform';
import { capabilityState } from '../platform/capabilities';
import { sanitizePath } from '../utils/pathSanitizer';
import { moveToTrash } from './cleaner';
import { AppError } from '../middleware/errorHandler';
import type { SnapshotCandidate, SnapshotSearchResult, SnapshotRestoreOutcome } from '../models/types';
import { meansAbsent } from '../utils/errno';

/**
 * Snapshot recovery — getting back a file the Trash no longer has (B4).
 *
 * The Trash covers "I deleted this and changed my mind". It does not cover "I
 * deleted this three weeks ago, emptied the Trash, and only now noticed". The
 * operating system, however, has probably been keeping filesystem snapshots
 * the whole time — APFS local snapshots, Btrfs subvolumes, Volume Shadow
 * Copies — and none of the three make it easy to get one file back out.
 *
 * ── Two questions, deliberately separated ──
 *
 * "Could this be recoverable?" and "recover it" are different questions with
 * very different costs, and merging them would make the cheap one expensive:
 *
 *   - **Which snapshots cover this file** is answerable for free on every
 *     platform, because listing snapshots needs no privileges anywhere.
 *   - **What is inside a snapshot** costs an administrator password on macOS
 *     and Windows (measured — see platform/macos/snapshotRecover.ts). Only
 *     Btrfs can be read as an ordinary user.
 *
 * So a search returns candidates in one of three honest states — `present`
 * (confirmed, Linux), `possible` (a snapshot from before the file vanished,
 * contents not yet readable), or `absent` (confirmed not there) — and the
 * password is asked for once, at restore, exactly as §3.8 requires.
 *
 * ── Where a restored file goes ──
 *
 * §B4: "Restores are always to a new location by default (never overwriting a
 * current file at the same path)." That is not a nicety. A file recovered from
 * a three-week-old snapshot is *older* than whatever occupies its path now, so
 * an overwrite-by-default would quietly replace newer work with older — the
 * precise failure a recovery feature exists to prevent.
 */

/** Where a recovered file lands when the caller does not say otherwise. */
export function defaultRestoreTarget(originalPath: string, now = new Date()): string {
  const dir = path.dirname(originalPath);
  const base = path.basename(originalPath);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const stamp =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return path.join(dir, `${stem} (recovered ${stamp})${ext}`);
}

/** The volume a path lives on, as the platform's snapshot list understands it. */
function volumeFor(target: string): string {
  if (process.platform === 'win32') {
    const root = path.parse(path.resolve(target)).root; // "C:\"
    return root.replace(/\\$/, '');
  }
  return '/';
}

/**
 * Which snapshots could still hold `targetPath`.
 *
 * Never throws for "nothing found" — an empty candidate list with a reason is
 * the answer to a perfectly reasonable question.
 */
export async function findDeleted(targetPath: string): Promise<SnapshotSearchResult> {
  const original = sanitizePath(targetPath);
  const capability = await capabilityState('snapshotRestore');
  const provider = platform();

  const volume = volumeFor(original);

  // Present on disk right now? Then this is not a recovery case, and saying so
  // is more useful than anything else this function can answer — so it is
  // answered BEFORE the snapshot list rather than after it. Computing it inside
  // the "we found snapshots" path left `stillPresent` undefined on every
  // machine with snapshots turned off, and the panel then answered someone
  // looking at a file that is right there with "there is nothing older to
  // recover from": a confusing non-answer, produced by an unrelated fact about
  // their backups, in place of the one sentence that settles the question.
  const live = await fsp.lstat(original).then(() => true).catch(() => false);

  let listFailed: string | null = null;
  const snapshots = await provider.listSnapshots(volume).catch((err: unknown) => {
    listFailed = err instanceof Error ? err.message : String(err);
    return [];
  });
  if (snapshots.length === 0) {
    return {
      path: original,
      candidates: [],
      // A listing that FAILED is not a confirmed absence. This file already
      // models the distinction one level down — a candidate is `'possible'`
      // rather than `'present'` when it has not been looked inside — and the
      // same honesty belongs here: "there is nothing older to recover from"
      // is the sentence that makes someone stop looking for a lost file, and
      // it must not be printed on the strength of a `tmutil` timeout.
      confirmed: listFailed === null && provider.canInspectSnapshotsUnprivileged(),
      capability,
      stillPresent: live,
      reason: listFailed !== null
        ? `The snapshots on ${volume} could not be listed (${String(listFailed)}). This does not mean there is nothing to recover — try again.`
        : capability.reason ?? `No filesystem snapshots were found on ${volume}, so there is nothing older to recover from.`,
    };
  }

  const canInspect = provider.canInspectSnapshotsUnprivileged();
  const candidates: SnapshotCandidate[] = [];
  for (const snapshot of snapshots) {
    if (!canInspect) {
      // Honest middle state: this snapshot predates now and *may* hold the
      // file, but saying "it is in here" would be a claim we have not checked.
      candidates.push({ snapshot, state: 'possible', sizeBytes: null, modifiedAt: null });
      continue;
    }
    const info = await provider.inspectSnapshot(snapshot, original).catch(() => null);
    candidates.push({
      snapshot,
      state: info ? 'present' : 'absent',
      sizeBytes: info ? info.sizeBytes : null,
      modifiedAt: info ? info.modifiedAt : null,
    });
  }

  // Newest first: the most recent copy is the one worth offering.
  candidates.sort((a, b) => (b.snapshot.takenAt ?? 0) - (a.snapshot.takenAt ?? 0));
  const usable = candidates.filter((c) => c.state !== 'absent');

  return {
    path: original,
    candidates,
    confirmed: canInspect,
    capability,
    stillPresent: live,
    ...(usable.length === 0
      ? { reason: `Checked ${candidates.length} snapshot${candidates.length === 1 ? '' : 's'} — none of them contain that path.` }
      : {}),
  };
}

export interface RestoreRequest {
  path: string;
  /** Where to put it. Defaults to a dated sibling of the original. */
  destination?: string;
  /**
   * Replace whatever is at `destination`. Off by default and never implied:
   * a snapshot copy is older than anything sitting there now.
   */
  overwrite?: boolean;
}

/**
 * Recover a path from the newest snapshot that holds it.
 *
 * The destination is checked *before* any privileged work, so a user is never
 * asked for a password only to be told afterwards that the target was taken.
 */
export async function restoreFromSnapshot(request: RestoreRequest): Promise<SnapshotRestoreOutcome> {
  const original = sanitizePath(request.path);
  const destination = request.destination
    ? sanitizePath(request.destination)
    : defaultRestoreTarget(original);

  // ENOENT is the only answer that means "nothing is there". Any other errno
  // — EACCES on the parent, ELOOP, EIO — means the question was not answered,
  // and `false` here is not a harmless default: unlike the Time Capsule and
  // offload paths, snapshot recovery does NOT go through `copyWithHash`'s
  // `wx` flag. It ends in `cp -a` running as root on macOS, and `fsp.cp` with
  // force on Linux and Windows. A wrong "nothing is there" is a privileged
  // overwrite of a live file.
  const occupied = await fsp.lstat(destination).then(() => true).catch((err: NodeJS.ErrnoException) => {
    // `meansAbsent`, not the wider stat predicate: a wrong "nothing is there"
    // ends in a root-privileged `cp -a` over a live file.
    if (meansAbsent(err)) return false;
    throw new AppError(409, 'DESTINATION_UNVERIFIABLE',
      `TreeMap could not check what is at ${destination} (${err.code ?? 'unknown error'}), so it did not restore over it. ` +
      'Try again, or choose another destination.');
  });
  if (occupied && !request.overwrite) {
    throw new AppError(409, 'DESTINATION_OCCUPIED',
      `Something already exists at ${destination}. Recovered files are written beside the original rather than over it — ` +
      'choose another name, or move that file aside first.');
  }
  if (occupied && request.overwrite) {
    // Explicitly asked for — but still not a licence to delete a folder. "Yes,
    // replace that file" and "yes, delete that directory tree" are different
    // consents, and only the first was given.
    const existing = await fsp.lstat(destination);
    if (existing.isDirectory()) {
      throw new AppError(409, 'DESTINATION_IS_FOLDER',
        `${destination} is a folder. Remove it yourself if you really mean to replace it.`);
    }
  }

  // Everything that can refuse this restore is settled BEFORE the existing
  // file is touched.
  //
  // The trash step used to run first, so a `listSnapshots` that came back
  // empty left the user's file in the Trash and handed them `NO_SNAPSHOTS`
  // as the explanation — for a restore that never started. The same window
  // covered a declined password prompt below.
  const provider = platform();
  const volume = volumeFor(original);
  let listFailed: string | null = null;
  const snapshots = await provider.listSnapshots(volume).catch((err: unknown) => {
    listFailed = err instanceof Error ? err.message : String(err);
    return [];
  });
  if (snapshots.length === 0) {
    const capability = await capabilityState('snapshotRestore');
    // Three different facts, three different sentences. The old code had one:
    // "This system has no filesystem snapshots to recover from" — asserted
    // whenever the list came back empty, including when it came back empty
    // because the listing FAILED. And `capability.reason` is undefined
    // precisely on a machine that does have snapshots, so the false sentence
    // appeared exactly where it was wrong.
    throw new AppError(
      409,
      listFailed === null ? 'NO_SNAPSHOTS' : 'SNAPSHOTS_UNREADABLE',
      listFailed !== null
        ? `The snapshots on ${volume} could not be listed (${String(listFailed)}), so nothing was recovered. This does not mean there is nothing to recover — try again.`
        : capability.reason ?? `No filesystem snapshots were found on ${volume}.`,
    );
  }

  if (occupied && request.overwrite) {
    // The replaced file goes to the Trash rather than being unlinked. Nothing
    // in TreeMap hard-deletes, and this is the one spot in a *recovery*
    // feature where a careless `rm` would destroy the newer copy while
    // restoring an older one. B2's open-file guard applies here too, so
    // replacing a file something else is using is refused rather than done
    // behind its back.
    //
    // The RESULT is checked. `moveToTrash` reports failures rather than
    // throwing, so ignoring it meant a file that could not be trashed was
    // treated as cleared — and then handed to a recovery path that overwrites
    // it as root.
    const trashed = await moveToTrash([destination]);
    if (trashed.failed.length > 0) {
      throw new AppError(409, 'DESTINATION_NOT_CLEARED',
        `${destination} could not be moved to the Trash (${trashed.failed[0].reason}), so nothing was restored over it.`);
    }
  }

  const result = await provider.recoverFromSnapshots(snapshots, original, destination);
  if (!result.restored) {
    // A dismissed password prompt is an answer, not a fault — 409, and the UI
    // renders it neutrally.
    throw new AppError(409, result.cancelled ? 'AUTHORIZATION_DECLINED' : 'NOT_IN_ANY_SNAPSHOT',
      result.reason ?? 'That path could not be recovered from any snapshot.');
  }

  const stat = await fsp.lstat(destination).catch(() => null);
  return {
    restored: true,
    originalPath: original,
    restoredTo: destination,
    fromSnapshotId: result.fromSnapshotId ?? null,
    sizeBytes: stat ? stat.size : (result.sizeBytes ?? 0),
  };
}
