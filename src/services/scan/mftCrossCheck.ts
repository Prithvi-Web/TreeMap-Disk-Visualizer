import type { MftExpected, MftLiveCheck, WalkResult } from '../../../native/index';

/**
 * The run-time gate of the Windows MFT turbo mode (W6-8, with correction 9
 * of docs/superpowers/plans/2026-09-23-phase3-w6-mft.md).
 *
 * The elevated helper read the master file table; before one byte of it is
 * trusted, the app — unelevated — opens entries of the result itself and
 * compares kind, size and last-write time. The first entry that still
 * differs after a second live read, and that has not itself been written
 * since the table was read, is a divergence: the whole result is discarded.
 *
 * Correction 9 is why the draw and the verdict both look at time: a raw read
 * sees `$MFT` as NTFS last flushed it, which can lag the live file system by
 * seconds, so an entry the table says was written just before the read is
 * never drawn, and a mismatch whose live last-write time is recent is the
 * file changing under the read, not the reader being wrong.
 */

/** W6-8: how many entries the app opens itself before it trusts the table. */
export const MFT_CROSS_CHECK_SAMPLE = 1_000;
/**
 * Correction 9: how long before the read an entry must have been last
 * written to be drawn — and how long before the read a mismatching entry's
 * live last-write time must be for the mismatch to be a divergence. M5 gives
 * the table 120 s to catch up with the live file system; so does this.
 */
export const MFT_FLUSH_MARGIN_MS = 120_000;
/** Entries opened per native call; the event loop gets a turn between two. */
const BATCH = 250;
/**
 * The most entries the check opens for a first read. A root the app can
 * barely open (another account's profile, say) once cost an open of every
 * eligible entry, one batch after another on the app's main thread (the
 * pre-landing review of 23 Sep 2026); four samples' worth is enough to find
 * a thousand matches where even a quarter of the entries open.
 */
export const MFT_CROSS_CHECK_ATTEMPTS = 4 * MFT_CROSS_CHECK_SAMPLE;

/** Hands the event loop a turn between two batches. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * The matches a table needs before it is trusted: half its eligible
 * entries, at most the sample, and never none — a table the app could
 * verify little of is not evidence that the reader is right, however few
 * entries disagreed (the pre-landing review of 23 Sep 2026; it once took a
 * single match).
 */
export function requiredMatches(eligible: number): number {
  return Math.max(1, Math.min(MFT_CROSS_CHECK_SAMPLE, Math.ceil(eligible / 2)));
}

/** `mftCrossCheck` as the gate calls it: one live check per path, in order. */
export type LiveChecker = (paths: string[], expected: MftExpected[]) => MftLiveCheck[];

export type CrossCheckVerdict =
  /**
   * No entry checked disagreed. `checked` entries matched, `skipped` could
   * not be opened (each replaced by another draw), `recent` had been written
   * since the read (each replaced too), out of `eligible` entries last
   * written before the margin; `attempts` were drawn for a first read, and
   * the table is trusted only when `checked` reaches `required`.
   */
  | { ok: true; checked: number; skipped: number; recent: number; eligible: number; attempts: number; required: number }
  /** A divergence: the entry, and a sentence naming it and both values. */
  | { ok: false; path: string; reason: string };

const KIND_WORDS: readonly string[] = ['a file', 'a folder', 'a link'];
const FIELD_NOUNS: Record<MftLiveCheck['differs'][number], string> = { kind: 'kind', size: 'size', mtime: 'last-write time' };
/** The largest time `Date` can show (±100,000,000 days). */
const MAX_DATE_MS = 8.64e15;

function describeValue(field: MftLiveCheck['differs'][number], value: number | null): string {
  if (value === null) return 'nothing';
  if (field === 'kind') return KIND_WORDS[value] ?? `kind ${value}`;
  if (field === 'size') return `${value} bytes`;
  const when = Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MS ? new Date(value).toISOString() : 'no valid date';
  return `${value} ms (${when})`;
}

/** The divergence as a sentence: the entry, the first field that differs, the table's value and the live one. */
function divergence(entry: string, want: MftExpected, live: MftLiveCheck): string {
  const field = live.differs[0] ?? 'size';
  const table = field === 'kind' ? want.kind : field === 'size' ? want.size : want.mtimeMs;
  const now = field === 'kind' ? live.kind : field === 'size' ? live.size : live.mtimeMs;
  return `the cross-check found ${entry} different: the master file table says its ${FIELD_NOUNS[field]} is ${describeValue(field, table)}, but opening it now reports ${describeValue(field, now)} (read twice to be sure)`;
}

/**
 * Checks up to MFT_CROSS_CHECK_SAMPLE entries of `cols`, drawn uniformly at
 * random without replacement from those last written more than
 * MFT_FLUSH_MARGIN_MS before `readStartedMs` (all of them when there are
 * fewer), through `check` — `mftCrossCheck` in the app. An entry that cannot
 * be opened is replaced by another draw, up to MFT_CROSS_CHECK_ATTEMPTS
 * draws in all. A mismatch is re-read once: a match then is a transient; a
 * live last-write time inside the margin, or none, is a file written since
 * the read, replaced by another draw; anything else fails the whole check at
 * once. Each batch of opens is one native call, and `pause` hands the event
 * loop a turn before every batch but the first, so the app answers while the
 * check runs.
 */
export async function crossCheckMft(
  cols: WalkResult,
  pathOf: (i: number) => string,
  readStartedMs: number,
  check: LiveChecker,
  random: () => number = Math.random,
  pause: () => Promise<void> = nextTurn,
): Promise<CrossCheckVerdict> {
  const cutoff = readStartedMs - MFT_FLUSH_MARGIN_MS;
  const pool = new Uint32Array(cols.parent.length);
  let eligible = 0;
  for (let i = 0; i < cols.parent.length; i++) {
    const written = cols.mtimeMs[i];
    if (Number.isFinite(written) && written < cutoff) pool[eligible++] = i;
  }
  const required = requiredMatches(eligible);
  const limit = Math.min(eligible, MFT_CROSS_CHECK_ATTEMPTS);
  // A partial Fisher–Yates shuffle: pool[0 .. drawn) are the draws so far.
  let drawn = 0;
  const draw = (): number | null => {
    if (drawn >= limit) return null;
    const j = drawn + Math.floor(random() * (eligible - drawn));
    const pick = pool[j];
    pool[j] = pool[drawn];
    pool[drawn] = pick;
    drawn++;
    return pick;
  };
  const expectedOf = (i: number): MftExpected => ({ kind: cols.kind[i], size: cols.size[i], mtimeMs: cols.mtimeMs[i] });

  let checked = 0;
  let skipped = 0;
  let recent = 0;
  let batches = 0;
  while (checked < MFT_CROSS_CHECK_SAMPLE) {
    const batch: number[] = [];
    const want = Math.min(BATCH, MFT_CROSS_CHECK_SAMPLE - checked);
    while (batch.length < want) {
      const next = draw();
      if (next === null) break;
      batch.push(next);
    }
    if (batch.length === 0) break;
    if (batches++ > 0) await pause();
    const first = check(batch.map(pathOf), batch.map(expectedOf));
    const suspects: number[] = [];
    batch.forEach((i, k) => {
      const result = first[k];
      if (!result || result.outcome === 'unopenable') skipped++;
      else if (result.outcome === 'match') checked++;
      else suspects.push(i);
    });
    if (suspects.length === 0) continue;
    const again = check(suspects.map(pathOf), suspects.map(expectedOf));
    for (let k = 0; k < suspects.length; k++) {
      const i = suspects[k];
      const result = again[k];
      if (!result || result.outcome === 'unopenable') {
        skipped++;
      } else if (result.outcome === 'match') {
        checked++;
      } else if (result.mtimeMs === null || !(result.mtimeMs < cutoff)) {
        recent++;
      } else {
        const entry = pathOf(i);
        return { ok: false, path: entry, reason: divergence(entry, expectedOf(i), result) };
      }
    }
  }
  return { ok: true, checked, skipped, recent, eligible, attempts: drawn, required };
}
