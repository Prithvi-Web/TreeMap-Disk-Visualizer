import type {
  BackupRecoverability, CloudRecoverability, ElsewhereVerdict, GitRecoverability,
  RecoverabilityFact, RecoverabilityReason,
} from './recoverabilityTypes';

/**
 * The composite verdict (v4 §1.2).
 *
 * Pure, exhaustive, and separated from every reader on purpose: this is the
 * function that decides whether TreeMap tells someone their data exists
 * somewhere else, and it must be readable in one screen and testable without a
 * repository, a backup disk or a sync client.
 *
 * **The rule that outranks the others: `proven` requires a checkable fact.**
 * Only two things qualify — a git remote that provably holds this content, and
 * a sync client that reports the file as uploaded. A configured backup earns
 * at most `likely`, no matter how recent, because "a backup exists and this
 * path is not excluded" is not "this file is in the backup". §1.2b calls that
 * the highest-stakes honesty rule in v4, and it is enforced here as well as in
 * the readers, so no future reader can route around it.
 */

/** Ordering by strength of claim, most confident first. */
const RANK: Record<ElsewhereVerdict, number> = { proven: 3, likely: 2, none: 1, unknown: 0 };

const strongest = (a: ElsewhereVerdict, b: ElsewhereVerdict): ElsewhereVerdict => (RANK[a] >= RANK[b] ? a : b);

/** Plain-English duration, for reasons a person reads under a delete button. */
export function humanAge(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return months === 1 ? 'a month ago' : `${months} months ago`;
  return `${Math.floor(months / 12)} years ago`;
}

/* ------------------------------ per-signal verdicts ------------------------------ */

export function gitVerdict(git: GitRecoverability | null): { verdict: ElsewhereVerdict; reason: RecoverabilityReason | null } {
  if (!git) return { verdict: 'unknown', reason: null };

  // Ignored by git: the remote has never held this, however clean the repo
  // looks. Saying nothing would be safe; saying why is better, because the
  // user can otherwise see "inside a fully-pushed repo" and draw the wrong
  // conclusion themselves.
  if (!git.pathTracked) {
    return {
      verdict: 'none',
      reason: {
        signal: 'git',
        text: 'This is inside a Git project but Git ignores it, so it was never pushed to the remote. Deleting it is permanent as far as Git is concerned — though it may be something your tools can rebuild.',
      },
    };
  }

  if (git.fullyPushed) {
    return {
      verdict: 'proven',
      reason: {
        signal: 'git',
        text: 'Fully pushed to its Git remote, with nothing uncommitted or untracked — deleting this costs one `git clone`.',
      },
    };
  }

  if (!git.hasRemote) {
    return {
      verdict: 'none',
      reason: {
        signal: 'git',
        text: 'This Git project has no remote, so nothing has been pushed anywhere. Deleting it is permanent.',
      },
    };
  }

  const problems: string[] = [];
  if (git.ahead === null) problems.push('this branch is not tracking a remote branch');
  else if (git.ahead > 0) problems.push(`${git.ahead} commit${git.ahead === 1 ? '' : 's'} not pushed`);
  if (git.dirtyFiles > 0) problems.push(`${git.dirtyFiles} uncommitted change${git.dirtyFiles === 1 ? '' : 's'}`);
  if (git.untrackedFiles > 0) problems.push(`${git.untrackedFiles} untracked file${git.untrackedFiles === 1 ? '' : 's'}`);

  return {
    verdict: 'none',
    reason: {
      signal: 'git',
      text: `This Git project has a remote, but ${problems.join(', ')} — that work exists only here, so deleting it is permanent.`,
    },
  };
}

export function backupVerdict(backup: BackupRecoverability | null): { verdict: ElsewhereVerdict; reason: RecoverabilityReason | null } {
  if (!backup) return { verdict: 'unknown', reason: null };

  if (backup.pathCovered === 'no') {
    return {
      verdict: 'none',
      reason: { signal: 'backup', text: `${backup.mechanism} is set to skip this location, so it is not in any backup.` },
    };
  }

  if (!backup.configured) {
    return {
      verdict: 'unknown',
      reason: backup.reason ? { signal: 'backup', text: backup.reason } : null,
    };
  }

  // The ceiling. A configured backup that has run recently and does not
  // exclude this path is the strongest thing a membership check can say, and
  // it is still only 'likely' — the file may post-date the last run, or have
  // failed to copy. Promoting this to 'proven' is the inference that would let
  // TreeMap tell someone it is safe to delete their only copy.
  const when = backup.lastBackupMs !== null ? ` The last backup finished ${humanAge(Date.now() - backup.lastBackupMs)}.` : '';
  return {
    verdict: 'likely',
    reason: {
      signal: 'backup',
      text:
        `${backup.mechanism} is set up and does not skip this location, so there is probably a second copy — ` +
        `but TreeMap has not opened the backup to check, so it cannot promise this exact file is in it.${when}`,
    },
  };
}

export function cloudVerdict(cloud: CloudRecoverability | null): { verdict: ElsewhereVerdict; reason: RecoverabilityReason | null } {
  if (!cloud || cloud.state === 'unknown') return { verdict: 'unknown', reason: null };
  const provider = cloud.provider ?? 'The sync app';

  switch (cloud.state) {
    case 'synced-local':
      return {
        verdict: 'proven',
        reason: { signal: 'cloud', text: `${provider} reports this as uploaded, so a copy exists in your account as well as here.` },
      };
    case 'placeholder':
      // Already only in the cloud: deleting the stub frees almost nothing
      // locally, and the content is safe.
      return {
        verdict: 'proven',
        reason: { signal: 'cloud', text: `This is an online-only placeholder — the content lives in ${provider}, not on this disk.` },
      };
    case 'local-only':
      return {
        verdict: 'none',
        reason: {
          signal: 'cloud',
          text: `${provider} has not uploaded this yet, so it exists only on this computer despite sitting in a synced folder. Deleting it loses it.`,
        },
      };
  }
}

/* ------------------------------ the composite ------------------------------ */

/**
 * Combine the three sub-signals.
 *
 * Precedence is by strength of claim — proven, then likely, then none, then
 * unknown — because the question being answered is "how sure are we that you
 * could get this back". A `none` from one signal does not cancel a `proven`
 * from another: an ignored build folder inside a synced Dropbox directory
 * genuinely is retrievable, and it is the cloud that knows so.
 *
 * Every contributing signal appears in `why`, so the summary word is never the
 * whole story and a user can always see which signal said what.
 */
export function composeRecoverability(
  git: GitRecoverability | null,
  backup: BackupRecoverability | null,
  cloud: CloudRecoverability | null,
  unavailable: { signal: 'git' | 'backup' | 'cloud'; reason: string }[] = [],
): RecoverabilityFact {
  const parts = [gitVerdict(git), backupVerdict(backup), cloudVerdict(cloud)];

  let elsewhere: ElsewhereVerdict = 'unknown';
  const why: RecoverabilityReason[] = [];
  for (const part of parts) {
    elsewhere = strongest(elsewhere, part.verdict);
    if (part.reason) why.push(part.reason);
  }

  return { elsewhere, why, git, backup, cloud, unavailable };
}
