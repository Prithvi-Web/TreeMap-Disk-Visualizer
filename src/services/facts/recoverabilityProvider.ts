import { platform } from '../../platform';
import { capabilityState } from '../../platform/capabilities';
import { getScan } from '../diskScanner';
import { storeOf } from '../scanStore';
import { cloudResidency } from '../placeholderResolver';
import { ignoredPaths, readRepoState, repoRootFor } from '../gitRecoverability';
import { composeRecoverability } from '../recoverability';
import type {
  BackupRecoverability, CloudRecoverability, GitRecoverability, RecoverabilityFact,
} from '../recoverabilityTypes';
import { FactBatch, FactProvider } from './types';

/**
 * The `recoverability` fact provider (v4 §1.2).
 *
 * Three independent sub-signals — git, backups, cloud — composed into one
 * verdict plus the reasons behind it. **Each can fail alone.** A machine with
 * no git installed still gets backup and cloud answers; a repository whose
 * `git` invocation fails is unavailable *for that repository* and not for the
 * batch. The `unavailable` array carries every signal that could not run,
 * with its reason, so the UI can say what it does not know instead of quietly
 * showing less.
 *
 * Git is read **once per repository**, not once per path: a batch of 2,000
 * paths from one project is one `git status` and one `git check-ignore`, not
 * four thousand subprocesses. That grouping is the difference between this
 * provider fitting §2.5's 400 ms budget and being unusable.
 */

const MAX_REPOS_PER_BATCH = 64;

export const recoverabilityProvider: FactProvider<RecoverabilityFact> = {
  id: 'recoverability',
  label: 'Copies elsewhere',
  // Deliberately null: this provider composes three capabilities and degrades
  // to whichever still work. Gating the whole thing on one of them would blank
  // two working signals whenever the third is missing.
  capabilityKey: null,

  async compute(scanId: string, paths: string[], signal: AbortSignal): Promise<FactBatch<RecoverabilityFact>> {
    const [gitCap, backupCap] = await Promise.all([
      capabilityState('gitStatus'),
      capabilityState('backupMembership'),
    ]);

    const unavailableBase: { signal: 'git' | 'backup' | 'cloud'; reason: string }[] = [];
    if (!gitCap.available) unavailableBase.push({ signal: 'git', reason: gitCap.reason ?? 'Git status is not available on this computer.' });
    if (!backupCap.available) unavailableBase.push({ signal: 'backup', reason: backupCap.reason ?? 'No backup system was found on this computer.' });

    /* ---------------- (b) backups — one machine-wide read ---------------- */

    let backupByPath = new Map<string, BackupRecoverability>();
    if (backupCap.available) {
      try {
        const membership = await platform().readBackupMembership(paths);
        backupByPath = new Map(
          [...membership].map(([p, m]) => [p, { kind: 'backup' as const, ...m }]),
        );
      } catch (err) {
        // One signal down, two to go — never the whole provider.
        unavailableBase.push({
          signal: 'backup',
          reason: `Backup status could not be read (${err instanceof Error ? err.message : String(err)}).`,
        });
      }
    }

    /* ---------------- (a) git — grouped by repository ---------------- */

    const gitByPath = new Map<string, GitRecoverability>();
    const gitUnavailableByPath = new Map<string, string>();

    if (gitCap.available && !signal.aborted) {
      // Resolve each path's repo root by walking up for a `.git` entry, with
      // one shared memo for the batch — no subprocess at all. See
      // gitRecoverability.repoRootFor for the measurement that forced this.
      const rootByDir = new Map<string, string | null>();
      const pathsByRepo = new Map<string, string[]>();

      for (const p of paths) {
        if (signal.aborted) break;
        // One shared cache for the whole batch: the walk memoises every
        // ancestor it passes, so siblings and sibling folders are free.
        const root = await repoRootFor(p, rootByDir);
        if (root === null) continue;
        const bucket = pathsByRepo.get(root);
        if (bucket) bucket.push(p);
        else if (pathsByRepo.size < MAX_REPOS_PER_BATCH) pathsByRepo.set(root, [p]);
      }

      for (const [root, repoPaths] of pathsByRepo) {
        if (signal.aborted) break;
        const state = await readRepoState(root);
        if ('error' in state) {
          // Unavailable for THIS repository only. §1.2a is explicit that a
          // broken repo must not blank the signal for every other one.
          for (const p of repoPaths) {
            gitUnavailableByPath.set(p, `Git could not read the project at ${root} (${state.error}).`);
          }
          continue;
        }
        // The hole this closes: `git status --porcelain` omits ignored files,
        // so a repo full of node_modules reports clean and `fullyPushed` comes
        // back true. Without this, the UI would say deleting 4 GB of ignored
        // build output "costs one git clone".
        const ignored = await ignoredPaths(root, repoPaths);
        for (const p of repoPaths) {
          gitByPath.set(p, { ...state, pathTracked: !ignored.has(p) });
        }
      }
    }

    /* ---------------- (c) cloud — per path, local state only ---------------- */

    const cloudByPath = new Map<string, CloudRecoverability>();
    const scan = getScan(scanId);
    const store = scan && (scan.store || scan.root) ? storeOf(scan) : null;

    for (const p of paths) {
      if (signal.aborted) break;
      try {
        const id = store ? store.findByPath(p) : -1;
        const logicalSize = id === -1 ? 0 : store!.size(id);
        const residency = await cloudResidency(p, logicalSize);
        if (residency.provider !== null) {
          cloudByPath.set(p, { kind: 'cloud', syncRoot: residency.syncRoot, provider: residency.provider, state: residency.state });
        }
      } catch {
        // Not in a sync folder, or the client's state was unreadable. Absent
        // rather than guessed — the composite treats that as unknown.
      }
    }

    /* ---------------- compose ---------------- */

    const values = new Map<string, RecoverabilityFact>();
    let skipped = 0;

    for (const p of paths) {
      const git = gitByPath.get(p) ?? null;
      const backup = backupByPath.get(p) ?? null;
      const cloud = cloudByPath.get(p) ?? null;

      const unavailable = [...unavailableBase];
      const repoProblem = gitUnavailableByPath.get(p);
      if (repoProblem) unavailable.push({ signal: 'git', reason: repoProblem });

      // Nothing at all to say about this path, and nothing prevented us from
      // saying it — that is a genuine "no information", counted as skipped so
      // coverage can be stated rather than implied.
      if (!git && !backup && !cloud && unavailable.length === 0) {
        skipped++;
        continue;
      }
      values.set(p, composeRecoverability(git, backup, cloud, unavailable));
    }

    return {
      available: true,
      values,
      stats: { requested: paths.length, computed: values.size, skipped, failed: 0 },
    };
  },
};
