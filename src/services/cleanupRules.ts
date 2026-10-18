import path from 'path';
import { CleanupSuggestionGroup, CleanupSuggestionItem } from '../models/types';
import { TreeSource, ScanStore, PackedScanStore, asStore, joinPath } from './scanStore';
import { CompiledIgnore, matchesAny } from '../utils/glob';
import { pathFold, samePath } from '../utils/osPaths';
import { PreparedSuppression, prepareSuppressed, suppressedRootCovering, noteRootInside } from './notes';
import {
  loadRuleCatalog,
  matchReasonFor,
  LocationRule,
  ProjectDirRule,
  Rule,
  RuleCatalog,
  StaleFilesRule,
} from './rulePacks';
import { MAX_SLICE_ATTEMPTS, SlicedWalk, SliceOptions, walkInSlices } from './slices';

/**
 * cleanupRules — well-known reclaimable disk space, matched against a
 * completed scan tree (so suggestions always sit inside a scanned root and
 * flow through the same trash-only delete path as everything else).
 *
 * The rules themselves are DATA, in `rulepacks/*.json` (§C8) — this file is
 * only the matcher. It walks the scan once and applies, in order:
 *
 *  1. `project-directory` — dependency and build dirs, usually gated on a
 *     manifest beside them (so `target` is a Rust target only next to a
 *     Cargo.toml), each carrying the command that restores it.
 *  2. `directory` — basenames with nothing to confirm them (build leftovers,
 *     tool caches).
 *  3. `location` — absolute OS-specific paths (browser caches, Xcode, …).
 *
 * and for files: `file` basenames, then `stale-files` (old, large downloads).
 *
 * A directory claimed by any rule is reported once and not descended into, so
 * a nested node_modules never produces overlapping suggestions.
 *
 * Track U, U-16: the walk is an explicit stack in the order the recursive walk
 * had, so it can stop between any two children. `collectCleanupSuggestions`
 * drains it in one call; `collectCleanupSuggestionsAsync` runs it in slices
 * and hands the event loop back between them, because on a 9M-entry scan one
 * drained walk held the loop — the desktop app's window — for about 10 s.
 * Requests and timers reach it through `cleanupMemo.ts`, which walks once per
 * scan version.
 */

/** A group lists at most this many items; its totalSize counts every match. */
export const ITEMS_PER_RULE = 200;
const DAY_MS = 86_400_000;

/** Children examined per slice of the async walk: about 18 ms at the rate the diagnosis measured. */
export const CLEANUP_SLICE_NODES = 16_384;

/** U-D9's limit, kept by the shared driver (`slices.ts`): the last attempt runs in one turn. */
export const CLEANUP_MAX_ATTEMPTS = MAX_SLICE_ATTEMPTS;

/** True if any sibling basename matches a pattern (`foo.*` ⇒ any `foo.<ext>`). */
function siblingPresent(siblings: Set<string>, patterns: string[]): boolean {
  for (const pat of patterns) {
    if (pat.endsWith('.*')) {
      const prefix = pat.slice(0, -1); // keep trailing dot, e.g. "next.config."
      for (const s of siblings) if (s.startsWith(prefix)) return true;
    } else if (siblings.has(pat)) {
      return true;
    }
  }
  return false;
}

/**
 * Location rules by `samePath`'s fold of each path: the first rule in catalog
 * order wins a path two rules share, exactly as `find` over the list did. One
 * fold per folder and a lookup replace two folds per rule path per folder.
 */
function locationIndex(rules: LocationRule[]): Map<string, LocationRule> {
  const byFold = new Map<string, LocationRule>();
  for (const rule of rules) {
    for (const p of rule.paths) {
      const key = pathFold(p);
      if (!byFold.has(key)) byFold.set(key, rule);
    }
  }
  return byFold;
}

/** A folder being walked: its children, the next one to examine, and its lowercased child names once a rule asks. */
interface Frame {
  path: string;
  kids: number[];
  next: number;
  siblings: Set<string> | null;
}

/**
 * One walk over a store. `step` examines up to `budget` children and says
 * whether the walk is done; the children are examined in exactly the order
 * the recursive matcher visited them, so groups, items, the per-rule cap and
 * the observer all see the same sequence.
 */
class SuggestionWalk implements SlicedWalk {
  /**
   * The answer holds for every clock reading from the walk's own `now` up to,
   * not including, this: the first moment a file this walk passed over would
   * become old enough for a stale-files rule. Infinity when none can.
   */
  validUntil = Infinity;

  private readonly groups = new Map<string, CleanupSuggestionGroup>();
  private readonly stack: Frame[] = [];
  private readonly suppressed: PreparedSuppression[];
  private readonly locations: Map<string, LocationRule>;
  /**
   * PackedScanStore.childPath is `joinPath(parentPath, sep, name(child))` for
   * every parent path the store spells, a parent stored as a byte-order mark
   * alone included (tests/packedStore.test.ts, CI4's byte-for-byte test);
   * joining the name this walk already read saves reading it twice. Any other
   * store, a subclass included, answers `childPath` itself.
   */
  private readonly joinsNames: boolean;

  constructor(
    private readonly store: ScanStore,
    private readonly ignore: CompiledIgnore[],
    private readonly catalog: RuleCatalog,
    private readonly observe: ((rule: Rule, nodePath: string) => void) | undefined,
    suppressedRoots: string[],
    private readonly now: number,
  ) {
    // Folded once per walk, not once per node — see prepareSuppressed.
    this.suppressed = prepareSuppressed(suppressedRoots, store.rootPath);
    this.locations = locationIndex(catalog.location);
    this.joinsNames = Object.getPrototypeOf(store) === PackedScanStore.prototype;
    this.enter(store.rootId, store.rootPath);
  }

  /** Examines up to `budget` children; true once every child has been examined. */
  step(budget: number): boolean {
    const stack = this.stack;
    let left = budget;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.next >= frame.kids.length) {
        stack.pop();
        continue;
      }
      if (left <= 0) return false;
      left--;
      this.examine(frame, frame.kids[frame.next++]);
    }
    return true;
  }

  /** Groups largest first, items largest first — the stable sorts keep walk order among equals. */
  result(): CleanupSuggestionGroup[] {
    return [...this.groups.values()]
      .map((g) => ({ ...g, items: g.items.sort((a, b) => b.size - a.size) }))
      .sort((a, b) => b.totalSize - a.totalSize);
  }

  /** Queue a folder's children; a folder with none is examined and left, as the recursive walk returned. */
  private enter(node: number, nodePath: string): void {
    const kids = this.store.childIds(node);
    if (kids.length === 0) return;
    this.stack.push({ path: nodePath, kids, next: 0, siblings: null });
  }

  /** Sibling basenames in this directory — used to confirm regenerable dirs. Built the first time a rule asks. */
  private siblingsOf(frame: Frame): Set<string> {
    if (frame.siblings === null) frame.siblings = new Set(frame.kids.map((c) => this.store.name(c).toLowerCase()));
    return frame.siblings;
  }

  private examine(frame: Frame, child: number): void {
    const store = this.store;
    const catalog = this.catalog;
    const name = store.name(child);
    const childPath = this.joinsNames ? joinPath(frame.path, store.sep, name) : store.childPath(child, frame.path);
    if (matchesAny(this.ignore, childPath, name)) return; // user said hands off
    // A note that suppresses covers its whole subtree — skip, never descend.
    if (suppressedRootCovering(childPath, this.suppressed) !== null) return;

    if (store.isDir(child)) {
      const lower = name.toLowerCase();

      // The REVERSE containment check (review round 1, finding 1): a rule
      // may claim this whole directory, but if a suppressing note sits
      // anywhere INSIDE it, offering the ancestor offers to delete the
      // very thing the note protects. The claim is withheld and the walk
      // descends instead, so an independent match deeper down — one that
      // does not contain the note — can still surface.
      const containsNote = noteRootInside(childPath, this.suppressed) !== null;

      // 1. Project dirs (usually sibling-gated) — most specific, checked first.
      const project = catalog.projectDirectory.find(
        (r) => r.names.includes(lower) && (!r.requiresSibling || siblingPresent(this.siblingsOf(frame), r.requiresSibling)),
      );
      if (project && store.size(child) > 0) {
        if (containsNote) { this.enter(child, childPath); return; }
        this.add(project, child, childPath, name);
        return; // claimed — don't descend
      }

      // 2. Generic name rules (build leftovers without a manifest, tool caches).
      const named = catalog.directory.find((r) => r.names.includes(lower));
      if (named && store.size(child) > 0) {
        if (containsNote) { this.enter(child, childPath); return; }
        this.add(named, child, childPath, name);
        return;
      }

      // 3. Absolute OS cache locations.
      const located = this.locations.size === 0 ? undefined : this.locations.get(pathFold(childPath));
      if (located && store.size(child) > 0) {
        if (containsNote) { this.enter(child, childPath); return; }
        this.add(located, child, childPath, name);
        return;
      }

      this.enter(child, childPath);
      return;
    }

    const lower = name.toLowerCase();
    const fileRule = catalog.file.find((r) => r.names.includes(lower));
    if (fileRule) {
      this.add(fileRule, child, childPath, name);
      return;
    }
    const stale = this.staleRuleFor(child, childPath);
    if (stale) this.add(stale, child, childPath, name);
  }

  /**
   * The first stale-files rule this file matches — the same three conditions,
   * in the same order, as before. A file under a rule's folder that is big
   * enough and not yet old enough also moves `validUntil` to the moment it
   * would be: an answer remembered past that moment would no longer be the
   * one a walk gives.
   */
  private staleRuleFor(child: number, childPath: string): StaleFilesRule | undefined {
    const rules = this.catalog.staleFiles;
    if (rules.length === 0) return undefined;
    const size = this.store.size(child);
    const modifiedAt = this.store.modifiedAt(child);
    for (const r of rules) {
      if (!(size >= r.minSizeBytes)) continue;
      const within = childPath.startsWith(r.withinPath + path.sep) || samePath(path.dirname(childPath), r.withinPath);
      if (modifiedAt < this.now - r.olderThanDays * DAY_MS) {
        if (within) return r;
        continue;
      }
      if (!within) continue;
      // Old enough once the clock passes modifiedAt + age; one millisecond
      // earlier, so no rounding of either sum can serve a stale answer.
      const turns = modifiedAt + r.olderThanDays * DAY_MS - 1;
      if (turns < this.validUntil) this.validUntil = turns;
    }
    return undefined;
  }

  private add(rule: Rule, node: number, nodePath: string, name: string): void {
    const store = this.store;
    this.observe?.(rule, nodePath);
    let group = this.groups.get(rule.id);
    if (!group) {
      group = {
        id: rule.id,
        title: rule.title,
        description: rule.description,
        items: [],
        totalSize: 0,
        category: rule.category,
        regenerateCmd: (rule as ProjectDirRule).restoreCommand,
        confidence: rule.confidence,
        why: matchReasonFor(rule),
        advisory: rule.action === 'advice' ? true : undefined,
        adviceCommand: rule.adviceCommand,
      };
      this.groups.set(rule.id, group);
    }
    const size = store.size(node);
    group.totalSize += size;
    if (group.items.length < ITEMS_PER_RULE) {
      group.items.push({
        name,
        path: nodePath,
        size,
        type: store.nodeType(node),
        modifiedAt: store.modifiedAt(node),
      } satisfies CleanupSuggestionItem);
    }
  }
}

/**
 * Suggestions for a scan, in one call. Throws `RulePackError` if the catalog
 * is malformed — the caller reports the feature as unavailable with that
 * reason rather than serving a silently incomplete list.
 *
 * Requests and timers use `collectCleanupSuggestionsAsync` through
 * `cleanupMemo.ts` instead: this form holds the event loop for the whole walk.
 */
export function collectCleanupSuggestions(
  source: TreeSource,
  ignore: CompiledIgnore[],
  catalog: RuleCatalog = loadRuleCatalog(),
  /**
   * Called for every match, before the per-rule display cap applies.
   *
   * The Reclaim Score's `regenerable` component needs to know which rule
   * claims an arbitrary path, and the groups this function returns cannot
   * answer that: `items` stops at ITEMS_PER_RULE, so the 201st `node_modules`
   * in a scan is claimed by a rule and absent from the list. Reading the
   * capped list would have scored it as "no rule recognises this", which is a
   * different and wrong statement.
   *
   * An observer on the existing walk rather than a second matcher, because
   * two matchers over the same rule packs agree today and drift by the next
   * rule anyone adds.
   */
  observe?: (rule: Rule, nodePath: string) => void,
  /**
   * Folders whose notes pause suggestions (v4 §9.5). A matched node at or
   * under any of these is skipped, subtree and all — "client archive, keep
   * until 2027" covers the node_modules three levels down. Callers read the
   * list from `suppressedNoteRoots()`; it is a parameter rather than a read
   * here so this matcher stays pure and the tests can drive both directions.
   */
  suppressedRoots: string[] = [],
): CleanupSuggestionGroup[] {
  const walk = new SuggestionWalk(asStore(source), ignore, catalog, observe, suppressedRoots, Date.now());
  walk.step(Infinity);
  return walk.result();
}

/** How the async walk slices itself (children per slice, default CLEANUP_SLICE_NODES) and which clock it reads. */
export interface CleanupWalkOptions extends SliceOptions {
  /** The clock the stale-files rules read, once per attempt. Default `Date.now`. */
  now?: () => number;
}

/** A finished async walk: the answer and what it was an answer for. */
export interface CleanupWalk {
  groups: CleanupSuggestionGroup[];
  /** `store.version` the answer describes: the store was unchanged from the first slice to the last. */
  version: number;
  /** The clock reading the stale-files rules used. */
  computedAt: number;
  /** The answer holds for clock readings in [computedAt, validUntil). Infinity when no stale-files answer can change. */
  validUntil: number;
  /** 1, unless the store changed during a walk (U-D9). */
  attempts: number;
}

/**
 * The same answer as `collectCleanupSuggestions`, walked in slices of
 * `sliceNodes` children with the event loop handed back after each, under
 * U-D9's version guard (the shared driver in `slices.ts`): a store that
 * changed during a slice's turn is walked again from the start, and the third
 * attempt runs in one turn. The observer
 * hears only the attempt that finished, in walk order.
 *
 * Pure in (store, arguments): nothing is remembered here. `cleanupMemo.ts`
 * keeps the answers.
 */
export async function collectCleanupSuggestionsAsync(
  source: TreeSource,
  ignore: CompiledIgnore[],
  catalog: RuleCatalog,
  observe?: (rule: Rule, nodePath: string) => void,
  suppressedRoots: string[] = [],
  options: CleanupWalkOptions = {},
): Promise<CleanupWalk> {
  const store = asStore(source);
  const clock = options.now ?? Date.now;
  // Each attempt reads the clock and hears its own claims; only the last is kept.
  let computedAt = 0;
  let heard: Array<[Rule, string]> = [];
  const { walk, version, attempts } = await walkInSlices(store, () => {
    computedAt = clock();
    heard = [];
    return new SuggestionWalk(store, ignore, catalog, observe ? (rule, p) => { heard.push([rule, p]); } : undefined, suppressedRoots, computedAt);
  }, options, CLEANUP_SLICE_NODES);
  if (observe) for (const [rule, p] of heard) observe(rule, p);
  return { groups: walk.result(), version, computedAt, validUntil: walk.validUntil, attempts };
}
