import { IndexRecord } from './ntfsMftIndexStore';

export interface JournalEvent {
  recordNo: number;
  parentRecordNo?: number;
  name?: string;
  isDir?: boolean;
  size?: number;
  mtimeMs?: number;
  reason: 'create' | 'rename' | 'delete' | 'data-extend' | 'data-overwrite' | 'data-truncation' | 'basic-info-change';
}

/**
 * Thrown when a journal event can't be applied safely — an unknown recordNo
 * on a non-structural event, or a create/rename missing required fields with
 * nothing existing to fall back to.
 */
export class JournalApplyGapError extends Error {
  constructor(message: string) {
    super(`JournalApplyGapError: ${message}`);
    this.name = 'JournalApplyGapError';
  }
}

/**
 * Applies USN journal events to an existing FRN-indexed record set, per
 * spec §6: rename updates name/parent in place, delete removes, and a later
 * create on the SAME recordNo is a normal new file (NTFS reuses MFT
 * records) — never treated as corruption.
 */
export function applyJournalEvents(
  records: IndexRecord[],
  events: JournalEvent[],
): IndexRecord[] {
  const byRecordNo = new Map(records.map((r) => [r.recordNo, { ...r }]));

  for (const event of events) {
    if (event.reason === 'delete') {
      byRecordNo.delete(event.recordNo);
      continue;
    }

    const existing = byRecordNo.get(event.recordNo);
    if (event.reason === 'create' || event.reason === 'rename') {
      const parentRecordNo = event.parentRecordNo ?? existing?.parentRecordNo;
      const name = event.name ?? existing?.name;
      if (parentRecordNo === undefined || name === undefined) {
        throw new JournalApplyGapError(
          `${event.reason} event for record ${event.recordNo} has no parent/name and no existing record to fall back to`,
        );
      }
      byRecordNo.set(event.recordNo, {
        recordNo: event.recordNo,
        parentRecordNo,
        name,
        isDir: event.isDir ?? existing?.isDir ?? false,
        size: event.size ?? existing?.size ?? 0,
        mtimeMs: event.mtimeMs ?? existing?.mtimeMs ?? 0,
      });
      continue;
    }

    // Non-structural: only touch fields the event actually carries.
    if (!existing) {
      throw new JournalApplyGapError(
        `${event.reason} event for unknown record ${event.recordNo} — index and journal have drifted`,
      );
    }
    byRecordNo.set(event.recordNo, {
      ...existing,
      size: event.size ?? existing.size,
      mtimeMs: event.mtimeMs ?? existing.mtimeMs,
    });
  }

  return Array.from(byRecordNo.values());
}
