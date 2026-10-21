import { CleanupSuggestionGroup } from '../models/types';
import { CompiledIgnore } from '../utils/glob';
import { ScanStore } from './scanStore';
import { Rule, RuleCatalog, withMatchedReasons } from './rulePacks';
import { CleanupWalk, CleanupWalkOptions, collectCleanupSuggestionsAsync, ITEMS_PER_RULE } from './cleanupRules';

/**
 * cleanupMemo — the cleanup rules walked once per scan version (Track U, U-16).
 *
 * After a scan the dashboard's cost card, the tour, the Clean Up modal, the
 * agent summary and MCP each asked for the same suggestions, and each request
 * walked the whole tree again; on a 9M-entry scan one walk held the event loop
 * for about 10 s. Here a request joins a walk already running for the same
 * question, or is answered from the last finished walk while that answer is
 * still the one a walk would give:
 *
 *  - the same store, at the same `store.version` (any watcher edit bumps it);
 *  - the same ignore patterns, the same suppressing note roots and the same
 *    rule catalog object (built once per process and never edited, so its
 *    identity is stricter than its schemaVersion and pack list);
 *  - a clock reading inside the walk's own window. The stale-files rules read
 *    the clock, and the walk records the first moment a file it passed over
 *    would become old enough for one of them, so an answer is never served
 *    past the point where a fresh walk would differ — a file that just turned
 *    90 days old is offered by the next request, not the next day. A clock set
 *    back before the walk's own reading is answered fresh too.
 *
 * The Reclaim Score's rule claims (`reclaimInputs.ts`) are memoised apart:
 * they are every match, uncapped, with advisory rules left out, and they never
 * honour notes. One slot per store per kind keeps only the last answer, and
 * the store is held weakly, so an answer dies with its scan.
 *
 * The matcher stays a pure function of (store, arguments) (Phase 4 R-S8): this
 * module only decides when to call it.
 */

/** One rule match as the Reclaim Score reads it. */
export interface CleanupClaim {
  rule: Rule;
  path: string;
}

interface Answer<T> {
  key: string;
  version: number;
  computedAt: number;
  validUntil: number;
  value: T;
}

type Kind = 'suggestions' | 'claims';

interface StoreMemo {
  /** The last finished walk's answer, per kind. */
  last: Map<Kind, Answer<unknown>>;
  /** Walks running now, by kind and key. A request for the same thing waits for the same walk. */
  running: Map<string, Promise<Answer<unknown>>>;
}

let memo = new WeakMap<ScanStore, StoreMemo>();
let walkOptions: CleanupWalkOptions = {};
/** Walks started per kind, and answers given without one (remembered or shared). */
const counts = { suggestions: 0, claims: 0, reused: 0 };

/** A small id per catalog object, for the key: two loads of the same packs are two catalogs. */
const catalogIds = new WeakMap<RuleCatalog, number>();
let nextCatalogId = 1;
function catalogId(catalog: RuleCatalog): number {
  let id = catalogIds.get(catalog);
  if (id === undefined) {
    id = nextCatalogId++;
    catalogIds.set(catalog, id);
  }
  return id;
}

function keyOf(catalog: RuleCatalog, ignore: CompiledIgnore[], suppressedRoots: string[]): string {
  return JSON.stringify([catalogId(catalog), ignore.map((m) => m.raw), suppressedRoots]);
}

function memoFor(store: ScanStore): StoreMemo {
  let entry = memo.get(store);
  if (!entry) {
    entry = { last: new Map(), running: new Map() };
    memo.set(store, entry);
  }
  return entry;
}

/** Whether an answer is the one a walk would give now. */
function holds(answer: Answer<unknown>, store: ScanStore, key: string, now: number): boolean {
  return answer.key === key && answer.version === store.version && answer.computedAt <= now && now < answer.validUntil;
}

/**
 * The answer to `key` for `store`: remembered, joined, or walked. A walk that
 * fails is not remembered — the next request walks again.
 */
async function answer<T>(
  store: ScanStore,
  kind: Kind,
  key: string,
  walk: () => Promise<{ walk: CleanupWalk; value: T }>,
): Promise<T> {
  const entry = memoFor(store);
  const clock = walkOptions.now ?? Date.now;
  const asked = clock();
  const flight = `${kind}\n${key}`;
  // A request that turns a shared answer down looks again before it walks:
  // another request past the same threshold may already be walking, and
  // joining that walk beats starting one more (review of U-16, finding 1).
  // Every turn of this loop waits for a walk that began after the previous
  // one finished — after this request arrived — so the next answer serves it.
  for (;;) {
    const kept = entry.last.get(kind) as Answer<T> | undefined;
    if (kept && holds(kept, store, key, asked)) {
      counts.reused++;
      return kept.value;
    }
    const running = entry.running.get(flight) as Promise<Answer<T>> | undefined;
    if (!running) break;
    const shared = await running;
    // A walk that read the clock at or after this request's is an answer
    // inside its lifetime. One that read it earlier is this request's answer
    // too unless a stale-files threshold fell between the two readings; the
    // store did not change in between, or the walk would have started again.
    if (shared.computedAt >= asked || asked < shared.validUntil) {
      counts.reused++;
      return shared.value;
    }
  }

  counts[kind]++;
  const started = (async (): Promise<Answer<T>> => {
    const done = await walk();
    return { key, version: done.walk.version, computedAt: done.walk.computedAt, validUntil: done.walk.validUntil, value: done.value };
  })();
  entry.running.set(flight, started);
  try {
    const fresh = await started;
    entry.last.set(kind, fresh);
    return fresh.value;
  } finally {
    if (entry.running.get(flight) === started) entry.running.delete(flight);
  }
}

/** A copy each caller may edit without editing the memo's answer or another caller's. */
function copyGroups(groups: CleanupSuggestionGroup[]): CleanupSuggestionGroup[] {
  return groups.map((g) => ({ ...g, items: g.items.map((i) => ({ ...i })) }));
}

/**
 * Smart suggestions for a store: what `collectCleanupSuggestions(store,
 * ignore, catalog, undefined, suppressedRoots)` answers, walked in slices and
 * at most once per scan version for the same arguments.
 */
export async function cleanupSuggestionsFor(
  store: ScanStore,
  ignore: CompiledIgnore[],
  catalog: RuleCatalog,
  suppressedRoots: string[],
): Promise<CleanupSuggestionGroup[]> {
  const groups = await answer(store, 'suggestions', keyOf(catalog, ignore, suppressedRoots), async () => {
    const walk = await collectCleanupSuggestionsAsync(store, ignore, catalog, undefined, suppressedRoots, walkOptions);
    return { walk, value: walk.groups };
  });
  // The walk's sentence lists every name a rule knows; the served one names
  // what each group matched (QA D06), when its items list every match.
  return withMatchedReasons(copyGroups(groups), catalog, ITEMS_PER_RULE);
}

/**
 * Every path a `trash` rule claims, in walk order and uncapped (advisory rules
 * are shown for their size and never offered, so they claim nothing), with no
 * note suppression — the Reclaim Score explains and sorts, it never selects.
 */
export async function cleanupClaimsFor(
  store: ScanStore,
  ignore: CompiledIgnore[],
  catalog: RuleCatalog,
): Promise<CleanupClaim[]> {
  const claims = await answer(store, 'claims', keyOf(catalog, ignore, []), async () => {
    const found: CleanupClaim[] = [];
    const walk = await collectCleanupSuggestionsAsync(store, ignore, catalog, (rule, path) => {
      if (rule.action !== 'advice') found.push({ rule, path });
    }, [], walkOptions);
    return { walk, value: found };
  });
  return claims.map((c) => ({ ...c }));
}

/** Test seam: how the memo's walks slice themselves and which clock it reads; null restores the defaults. */
export function setCleanupMemoOptionsForTests(options: CleanupWalkOptions | null): void {
  walkOptions = options ?? {};
}

/** Test seam: walks started since the last reset, by kind, and answers reused without one — counted, never timed. */
export function cleanupMemoCountsForTests(): { suggestions: number; claims: number; reused: number } {
  return { ...counts };
}

/** Test seam: forget every answer and zero the counts. */
export function resetCleanupMemoForTests(): void {
  memo = new WeakMap();
  counts.suggestions = 0;
  counts.claims = 0;
  counts.reused = 0;
}
