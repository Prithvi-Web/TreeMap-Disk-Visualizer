import path from 'node:path';
import { CleanupSuggestionGroup, CleanupSuggestionItem } from '../../src/models/types';
import { TreeSource, asStore } from '../../src/services/scanStore';
import { CompiledIgnore, matchesAny } from '../../src/utils/glob';
import { prepareSuppressed, suppressedRootCovering, noteRootInside } from '../../src/services/notes';
import { loadRuleCatalog, matchReasonFor, ProjectDirRule, Rule, RuleCatalog } from '../../src/services/rulePacks';

/**
 * The cleanup matcher as it was before Track U U-16 sliced it (main bc809a2,
 * `src/services/cleanupRules.ts`), copied verbatim so `tests/cleanupSlices.test.ts`
 * can hold the rewritten walk to it byte for byte, observer order included.
 *
 * Kept as code rather than as recorded answers because the differential runs on
 * fuzz trees made fresh each run; a stored golden would pin the trees too. The
 * one change: `samePath` is written out here instead of imported, so a later
 * edit to `src/utils/osPaths.ts` cannot quietly change the oracle along with the
 * code it judges. Never "fix" this file to match the new code — a difference is
 * the finding.
 */

/** `samePath` from src/utils/osPaths.ts at bc809a2. */
function samePath(a: string, b: string): boolean {
  return process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();
}

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

export function oracleCleanupSuggestions(
  source: TreeSource,
  ignore: CompiledIgnore[],
  catalog: RuleCatalog = loadRuleCatalog(),
  observe?: (rule: Rule, nodePath: string) => void,
  suppressedRoots: string[] = [],
  /** The one addition: the clock the original read as `Date.now()`, so a test can fix it. */
  now: number = Date.now(),
): CleanupSuggestionGroup[] {
  const store = asStore(source);
  // Folded once per call, not once per node — see prepareSuppressed.
  const suppressed = prepareSuppressed(suppressedRoots, store.rootPath);

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
      if (suppressedRootCovering(childPath, suppressed) !== null) continue;

      if (store.isDir(child)) {
        const lower = name.toLowerCase();

        const containsNote = noteRootInside(childPath, suppressed) !== null;

        // 1. Project dirs (usually sibling-gated) — most specific, checked first.
        const project = catalog.projectDirectory.find(
          (r) => r.names.includes(lower) && (!r.requiresSibling || siblingPresent(siblings, r.requiresSibling)),
        );
        if (project && store.size(child) > 0) {
          if (containsNote) { visit(child, childPath); continue; }
          add(project, child, childPath);
          continue; // claimed — don't descend
        }

        // 2. Generic name rules (build leftovers without a manifest, tool caches).
        const named = catalog.directory.find((r) => r.names.includes(lower));
        if (named && store.size(child) > 0) {
          if (containsNote) { visit(child, childPath); continue; }
          add(named, child, childPath);
          continue;
        }

        // 3. Absolute OS cache locations.
        const located = catalog.location.find((r) => r.paths.some((p) => samePath(p, childPath)));
        if (located && store.size(child) > 0) {
          if (containsNote) { visit(child, childPath); continue; }
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
