import type { BackupMembership } from '../platform/types';

/**
 * Recoverability (v4 §1.2) — "does a copy of this exist somewhere else?"
 *
 * The strongest predictor of "safe to delete" is "you can get it back", and no
 * disk tool asks. Three independent sub-signals answer it, each of which can be
 * individually unavailable without costing the other two their answers.
 */

/* ------------------------------ (a) git ------------------------------ */

export interface GitRecoverability {
  kind: 'git';
  repoRoot: string;
  hasRemote: boolean;
  /** Commits on this branch not on its upstream. null = no upstream configured. */
  ahead: number | null;
  dirtyFiles: number;
  untrackedFiles: number;
  /** Bytes of untracked content, where the scan supplied them. 0 when not measured. */
  untrackedBytes: number;
  /** True only when: a remote exists, ahead === 0, nothing dirty, nothing untracked. */
  fullyPushed: boolean;
  /**
   * False when git *ignores* this path.
   *
   * Load-bearing, and the reason is subtle: `git status --porcelain` does not
   * list ignored files, so a repo full of `node_modules` reports clean and
   * `fullyPushed` comes back true. Without this flag the UI would tell someone
   * that deleting 4 GB of ignored build output "costs one git clone" — content
   * the remote has never held.
   */
  pathTracked: boolean;
}

/* ------------------------------ (b) backup ------------------------------ */

export interface BackupRecoverability extends BackupMembership {
  kind: 'backup';
}

/* ------------------------------ (c) cloud ------------------------------ */

/**
 * `synced-local` is the only state that proves a remote copy: the sync client
 * itself reports the file as uploaded and also present here.
 *
 * `local-only` is its opposite and equally load-bearing — the client says this
 * has **not** been uploaded yet, so deleting it loses it. A file sitting in a
 * Dropbox folder looks backed up to a person; when the client has not finished
 * syncing, it is not.
 */
export interface CloudRecoverability {
  kind: 'cloud';
  syncRoot: string | null;
  provider: string | null;
  state: 'placeholder' | 'synced-local' | 'local-only' | 'unknown';
}

/* ------------------------------ composite ------------------------------ */

/**
 * How confident TreeMap is that a copy exists elsewhere.
 *
 *  - `proven`  — a checkable fact says so: a fully-pushed git remote, or a sync
 *                client reporting the file as uploaded. Nothing else qualifies.
 *  - `likely`  — evidence points that way without proving it. A configured
 *                backup gets at most this, forever.
 *  - `none`    — positive evidence that no copy exists: the sync client says it
 *                has not uploaded this, or the backup excludes it.
 *  - `unknown` — nothing knew anything. Common, and correct.
 */
export type ElsewhereVerdict = 'proven' | 'likely' | 'none' | 'unknown';

/** One reason, naming the sub-signal that produced it, in plain English. */
export interface RecoverabilityReason {
  signal: 'git' | 'backup' | 'cloud';
  /** Shown verbatim. Must be a sentence a non-technical person can act on. */
  text: string;
}

export interface RecoverabilityFact {
  elsewhere: ElsewhereVerdict;
  /** Every sub-signal that had something to say, and what it said. */
  why: RecoverabilityReason[];
  git: GitRecoverability | null;
  backup: BackupRecoverability | null;
  cloud: CloudRecoverability | null;
  /** Sub-signals that could not run, with their reasons. Never silently absent. */
  unavailable: { signal: 'git' | 'backup' | 'cloud'; reason: string }[];
}
