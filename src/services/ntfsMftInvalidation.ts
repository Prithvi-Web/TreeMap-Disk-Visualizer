import { IndexCheckpoint } from './ntfsMftIndexStore';

export interface VolumeUsnState {
  volumeSerialNumber: number;
  usnJournalId: bigint;
  firstUsn: bigint;
  nextUsn: bigint;
}

export type RefreshStrategy =
  | { strategy: 'full-reindex'; reason: 'no-checkpoint' | 'volume-serial-mismatch' | 'journal-id-mismatch' | 'checkpoint-gap' }
  | { strategy: 'incremental'; resumeFromUsn: bigint };

/**
 * Decides whether a volume's persisted index can be updated incrementally
 * or must be rebuilt from scratch, per the invalidation model in
 * docs/superpowers/specs/2026-07-24-ntfs-mft-turbo-v2-design.md §6.
 */
export function decideRefreshStrategy(
  checkpoint: IndexCheckpoint | null,
  current: VolumeUsnState,
): RefreshStrategy {
  if (!checkpoint) return { strategy: 'full-reindex', reason: 'no-checkpoint' };
  if (checkpoint.volumeSerialNumber !== current.volumeSerialNumber) {
    return { strategy: 'full-reindex', reason: 'volume-serial-mismatch' };
  }
  if (checkpoint.usnJournalId !== current.usnJournalId) {
    return { strategy: 'full-reindex', reason: 'journal-id-mismatch' };
  }
  if (checkpoint.lastUsnProcessed < current.firstUsn) {
    return { strategy: 'full-reindex', reason: 'checkpoint-gap' };
  }
  return { strategy: 'incremental', resumeFromUsn: checkpoint.lastUsnProcessed };
}
