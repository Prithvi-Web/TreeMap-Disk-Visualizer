/**
 * Sentences saved before the Undo Vault had its name.
 *
 * Until 5.2.0 the Undo Vault was called by another name (renamed by the owner's decision of
 * 20 Oct 2026, the old one being an Apple product's). Sentences TreeMap saved before then still say
 * the old name on disk — an Undo Vault event's `detail`, an Autopilot run's `blockedReason` and its
 * `skipped[].reason` — and the page shows them as they are served. So they are served in today's
 * words, rewritten as they are read. The saved files are never changed: what was recorded stays
 * the record.
 *
 * Only whole phrases TreeMap itself wrote are rewritten, each exactly as an earlier build wrote it,
 * into the phrase TreeMap writes now. Nothing else in a sentence is touched, because it can be the
 * user's own: a file or folder named after Apple's backup drive, a path on one, a policy's name, a
 * query, a note's folder, or an error the system wrote. Renaming those would make a true sentence
 * false. A sentence TreeMap no longer writes in any form keeps its wording, as does one an earlier
 * build worded some other way; it reads as it did, under the old name.
 *
 * This is the one file in src/ that spells the old name, and only on the left of each pair below
 * (tests/undoVaultName.test.ts holds it to that, and tests/undoVaultSavedWording.test.ts holds the
 * right of each pair to a sentence TreeMap writes today).
 */

/** [as an earlier build wrote it, as TreeMap writes it now]. */
export const LEGACY_PHRASES: ReadonlyArray<readonly [before: string, now: string]> = [
  // An Undo Vault event's detail.
  ['It could not be copied into the Time Capsule (', 'It could not be copied into the Undo Vault ('],
  ['Removed from the Time Capsule to make room for ', 'Removed from the Undo Vault to make room for '],
  [', then removed from the Time Capsule.', ', then removed from the Undo Vault.'],
  ['Its copy is missing from the Time Capsule folder, so', 'Its copy is missing from the Undo Vault’s folder, so'],
  ['That Time Capsule record is not one TreeMap made', 'That Undo Vault record is not one TreeMap made'],
  // A skipped item's reason: the copy did not fit, was gone, or was kept.
  [', but the Time Capsule can only hold ', ', but the Undo Vault can only hold '],
  ['its Time Capsule copy is no longer there, and nothing is deleted', 'its Undo Vault copy is no longer there, and nothing is deleted'],
  ['its Time Capsule copy could not be looked at (', 'its Undo Vault copy could not be looked at ('],
  ['its Time Capsule copy\'s record is not one TreeMap wrote', 'its Undo Vault copy\'s record is not one TreeMap wrote'],
  ['its Time Capsule copy is incomplete (', 'its Undo Vault copy is incomplete ('],
  ['so its Time Capsule copy was kept — an undo puts it back', 'so its Undo Vault copy was kept — an undo puts it back'],
  ['The Time Capsule folder can’t be created (', 'The Undo Vault’s folder can’t be created ('],
  // A run's blockedReason: discarding copies did not finish, or the index could not be read.
  ['Discarding its copy did not finish, so the Time Capsule may still list it.', 'Discarding its copy did not finish, so the Undo Vault may still list it.'],
  ['Discarding the Time Capsule copies of the ', 'Discarding the Undo Vault copies of the '],
  [', so the Time Capsule may still list them.', ', so the Undo Vault may still list them.'],
  ['can be put back until the Time Capsule removes its copies', 'can be put back until the Undo Vault removes its copies'],
  ['The Time Capsule index (', 'The Undo Vault index ('],
  ['TreeMap will not change the capsule until it is repaired', 'TreeMap will not change the Undo Vault until it is repaired'],
];

/**
 * `text` in today's words: each phrase an earlier build wrote, replaced by today's. Anything that is
 * not a string (a hand-edited record) is returned as it is.
 */
export function inTodaysWords<T>(text: T): T {
  if (typeof text !== 'string') return text;
  let out: string = text;
  for (const [before, now] of LEGACY_PHRASES) {
    if (out.includes(before)) out = out.split(before).join(now);
  }
  return out as T;
}
