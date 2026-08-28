import { randomUUID } from 'crypto';
import { readJsonFile, writeJsonFile } from '../storage';
import { parse } from './parse';

/**
 * Saved queries (v4 §2.3).
 *
 * The pivot the whole grammar exists for: a saved query becomes a pinned chip
 * above the treemap, then a Clean Up rule, then an Autopilot policy — so
 * fifteen hard-coded views become an unbounded number without new plumbing.
 *
 * Persistence goes through `storage.ts`, which redirects to memory when a
 * portable session is read-only. That is not incidental: §6 requires that
 * **nothing new persists anywhere** in portable mode — not on the drive and
 * emphatically not on the host — and routing through the shared helper is how
 * that guarantee is inherited rather than re-implemented and got wrong.
 */

const FILE = 'saved-queries.json';

/**
 * A ceiling, so a script cannot grow this file without bound. Generous: the
 * chip strip stops being usable long before anyone reaches it.
 */
export const MAX_SAVED_QUERIES = 200;

export interface SavedQuery {
  id: string;
  name: string;
  q: string;
  createdMs: number;
  pinned: boolean;
  /** A CSS colour for the chip, or null to use the default accent. */
  colour: string | null;
}

interface SavedQueryFile {
  queries: SavedQuery[];
}

/** Only these are accepted for `colour` — an arbitrary string would reach CSS. */
const COLOUR_PATTERN = /^#[0-9a-f]{6}$/i;

function sanitize(entry: unknown): SavedQuery | null {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry as Partial<SavedQuery>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.q !== 'string') return null;
  return {
    id: raw.id,
    name: raw.name,
    q: raw.q,
    createdMs: typeof raw.createdMs === 'number' ? raw.createdMs : 0,
    pinned: raw.pinned === true,
    colour: typeof raw.colour === 'string' && COLOUR_PATTERN.test(raw.colour) ? raw.colour : null,
  };
}

/**
 * Serialises read-modify-write.
 *
 * `writeJsonFile` already queues its writes, but that does not make
 * read-then-write atomic: two concurrent saves both read the same list and the
 * second write loses the first entry. One promise chain closes the window.
 */
let mutation: Promise<unknown> = Promise.resolve();
function exclusively<T>(work: () => Promise<T>): Promise<T> {
  const next = mutation.then(work, work);
  mutation = next.then(() => undefined, () => undefined);
  return next;
}

/** The file as stored, unsanitised — what a write must preserve. */
async function readRaw(): Promise<unknown[]> {
  const file = await readJsonFile<SavedQueryFile>(FILE, { queries: [] });
  return Array.isArray(file.queries) ? file.queries : [];
}

export async function listSavedQueries(): Promise<SavedQuery[]> {
  const queries = await readRaw();
  // Sanitised on read as well as write: the file is user-editable, and a
  // hand-edited entry must not be able to put an arbitrary string where the
  // frontend expects a colour.
  const clean = queries.map(sanitize).filter((q): q is SavedQuery => q !== null);
  // Pinned first, then newest — the order the chip strip renders in.
  //
  // The `id` tie-break is not decoration: `createdMs` is `Date.now()`, so two
  // queries saved inside the same millisecond compared EQUAL and the order
  // fell through to whatever the sort happened to do with them, making the
  // chip strip's order undefined for the one case a user can actually produce
  // — saving two views in quick succession.
  //
  // Honest about what this does and does not fix: ids are random UUIDs, so
  // the resulting order is STABLE but arbitrary. Two queries saved in the
  // same millisecond will always come back the same way round; that way
  // round is not necessarily newest-first. Making it genuinely newest-first
  // needs a monotonic sequence stamped at save time, which changes the stored
  // shape — worth doing, and deliberately not smuggled into this change.
  return clean.sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.createdMs - a.createdMs || a.id.localeCompare(b.id),
  );
}

export type SaveResult =
  | { ok: true; query: SavedQuery }
  | { ok: false; code: string; error: string; offset?: number; expected?: string[] };

/**
 * Save a query, refusing anything that does not parse.
 *
 * §2.3 requires the validation, and the reason is worth stating: a saved query
 * is not just a bookmark. It becomes a Clean Up rule and then an Autopilot
 * policy, and a policy whose query never parsed would either match nothing
 * forever or fail at the least convenient moment. Rejecting it at save time is
 * the only place a person is present to fix it.
 */
export function saveQuery(input: { name?: unknown; q?: unknown; pinned?: unknown; colour?: unknown }): Promise<SaveResult> {
  return exclusively(() => saveQueryLocked(input));
}

async function saveQueryLocked(input: { name?: unknown; q?: unknown; pinned?: unknown; colour?: unknown }): Promise<SaveResult> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const q = typeof input.q === 'string' ? input.q.trim() : '';

  if (name.length === 0) return { ok: false, code: 'NAME_REQUIRED', error: 'A saved view needs a name.' };
  if (name.length > 80) return { ok: false, code: 'NAME_TOO_LONG', error: 'A saved view name can be at most 80 characters.' };
  if (q.length === 0) return { ok: false, code: 'QUERY_REQUIRED', error: 'A saved view needs a query.' };

  const parsed = parse(q);
  if (!parsed.ok) {
    return { ok: false, code: 'QUERY_PARSE_ERROR', error: parsed.error, offset: parsed.offset, expected: parsed.expected };
  }

  // The RAW list, not the sanitised one. Writing back the sanitised list would
  // silently and permanently delete any hand-edited row that failed to
  // validate — the file is user-editable, and a typo in it should not cost
  // someone their saved view without a word.
  const existing = await readRaw();
  if (existing.length >= MAX_SAVED_QUERIES) {
    return {
      ok: false,
      code: 'TOO_MANY_SAVED_QUERIES',
      error: `You already have ${MAX_SAVED_QUERIES} saved views — delete one before adding another.`,
    };
  }

  const colour = typeof input.colour === 'string' && COLOUR_PATTERN.test(input.colour) ? input.colour : null;
  const query: SavedQuery = {
    id: randomUUID(),
    name,
    q,
    createdMs: Date.now(),
    pinned: input.pinned === true,
    colour,
  };

  await writeJsonFile(FILE, { queries: [...existing, query] });
  return { ok: true, query };
}

/** Remove one saved query. Returns whether it was there. */
export function deleteSavedQuery(id: string): Promise<boolean> {
  return exclusively(async () => {
    const existing = await readRaw();
    const remaining = existing.filter((q) => (q as { id?: unknown } | null)?.id !== id);
    if (remaining.length === existing.length) return false;
    await writeJsonFile(FILE, { queries: remaining });
    return true;
  });
}
