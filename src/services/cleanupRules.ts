import path from 'path';
import { CleanupSuggestionGroup, CleanupSuggestionItem } from '../models/types';
import { TreeSource, asStore } from './scanStore';
import { CompiledIgnore, matchesAny } from '../utils/glob';
import { samePath } from '../utils/osPaths';
import { isUnderAny } from './notes';
import {
  loadRuleCatalog,
  matchReasonFor,
  ProjectDirRule,
  Rule,
  RuleCatalog,
} from './rulePacks';

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
 */

const ITEMS_PER_RULE = 200;

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
 * Suggestions for a scan. Throws `RulePackError` if the catalog is malformed —
 * the caller reports the feature as unavailable with that reason rather than
 * serving a silently incomplete list.
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
  const store = asStore(source);
  const now = Date.now();

  const groups = new Map<string, CleanupSuggestionGroup>();
  const add = (rule: Rule, node: number, nodePath: string): void => {
    observe?.(rule, nodePath);
    let group = groups.get(rule.id);
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
      groups.set(rule.id, group);
    }
    group.totalSize += store.size(node);
    if (group.items.length < ITEMS_PER_RULE) {
      group.items.push({
        name: store.name(node),
        path: nodePath,
        size: store.size(node),
        type: store.nodeType(node),
        modifiedAt: store.modifiedAt(node),
      } satisfies CleanupSuggestionItem);
    }
  };

  const visit = (node: number, nodePath: string): void => {
    const kids = store.childIds(node);
    if (kids.length === 0) return;
    // Sibling basenames in this directory — used to confirm regenerable dirs.
    const siblings = new Set(kids.map((c) => store.name(c).toLowerCase()));

    for (const child of kids) {
      const name = store.name(child);
      const childPath = store.childPath(child, nodePath);
      if (matchesAny(ignore, childPath, name)) continue; // user said hands off
      // A note that suppresses covers its whole subtree — skip, never descend.
      if (isUnderAny(childPath, suppressedRoots)) continue;

      if (store.isDir(child)) {
        const lower = name.toLowerCase();

        // 1. Project dirs (usually sibling-gated) — most specific, checked first.
        const project = catalog.projectDirectory.find(
          (r) => r.names.includes(lower) && (!r.requiresSibling || siblingPresent(siblings, r.requiresSibling)),
        );
        if (project && store.size(child) > 0) {
          add(project, child, childPath);
          continue; // claimed — don't descend
        }

        // 2. Generic name rules (build leftovers without a manifest, tool caches).
        const named = catalog.directory.find((r) => r.names.includes(lower));
        if (named && store.size(child) > 0) {
          add(named, child, childPath);
          continue;
        }

        // 3. Absolute OS cache locations.
        const located = catalog.location.find((r) => r.paths.some((p) => samePath(p, childPath)));
        if (located && store.size(child) > 0) {
          add(located, child, childPath);
          continue;
        }

        visit(child, childPath);
        continue;
      }

      const lower = name.toLowerCase();
      const fileRule = catalog.file.find((r) => r.names.includes(lower));
      if (fileRule) {
        add(fileRule, child, childPath);
        continue;
      }
      const stale = catalog.staleFiles.find(
        (r) =>
          store.size(child) >= r.minSizeBytes &&
          store.modifiedAt(child) < now - r.olderThanDays * 86_400_000 &&
          (childPath.startsWith(r.withinPath + path.sep) || samePath(path.dirname(childPath), r.withinPath)),
      );
      if (stale) add(stale, child, childPath);
    }
  };
  visit(store.rootId, store.rootPath);

  return [...groups.values()]
    .map((g) => ({ ...g, items: g.items.sort((a, b) => b.size - a.size) }))
    .sort((a, b) => b.totalSize - a.totalSize);
}
