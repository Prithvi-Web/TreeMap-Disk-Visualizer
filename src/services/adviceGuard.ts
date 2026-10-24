import fs from 'fs';
import path from 'path';
import { pathFold } from '../utils/osPaths';
import type { Rule, RuleCatalog, ProjectDirRule } from './rulePacks';

/**
 * adviceGuard — the advice-only rule a path lies in, judged from the path itself (review F1.2, F1.5,
 * the hunt C12 follow-up). MCP trash_paths refuses such a path. The cleanup walk (cleanupMemo's
 * adviceClaimsFor) finds what lies BELOW a scan's root only: it never examines the root, so a
 * completed scan rooted at an advice-only folder, or inside one — scanning Docker's VM folder to see
 * what is big there — claimed nothing, and the folder and its files went to the Trash.
 *
 * Here the path and every folder above it are each judged as the walk judges a folder it meets:
 * project rules first, then name rules, then location rules, the first that matches deciding, and
 * the path is advice only when a deciding rule is an advice rule. So a folder a trash rule claims
 * first is not refused for an advice rule that also names it, as the suggestions offer it. A project
 * rule's sibling and child conditions are read from the disk; one that cannot be read is taken as
 * met by an advice rule and as unmet by a trash rule, so an unreadable folder only ever refuses more.
 * The path itself, when it is a file, is judged by the file rules instead. A folder above it whose
 * deciding rule says its advice is about the folder itself (`adviceCovers: "folder"`: Windows' Temp
 * folder) refuses nothing in it — only that folder, and a folder holding it (hunt HF-L1).
 */

/** An advice-only rule's claim on a path: the folder or file it claims, and its words. */
export interface AdviceHit {
  path: string;
  title: string;
  adviceCommand?: string;
}

/** Lowercased names in `dir`, or null when it cannot be listed. */
function namesIn(dir: string): Set<string> | null {
  try {
    return new Set(fs.readdirSync(dir).map((n) => n.toLowerCase()));
  } catch {
    return null;
  }
}

/** True if any name in `names` matches a pattern (`foo.*` ⇒ any `foo.<ext>`), as the walk reads siblings. */
function present(names: Set<string>, patterns: string[]): boolean {
  return patterns.some((pat) => (pat.endsWith('.*') ? [...names].some((n) => n.startsWith(pat.slice(0, -1))) : names.has(pat)));
}

/** A project rule's conditions on the folder `at`, read from the disk; unreadable counts as the advice side. */
function projectMatches(rule: ProjectDirRule, at: string): boolean {
  const unknown = rule.action === 'advice';
  const check = (dir: string, patterns: string[] | undefined, want: boolean): boolean => {
    if (!patterns) return true;
    const names = namesIn(dir);
    return names === null ? unknown : present(names, patterns) === want;
  };
  return check(path.dirname(at), rule.requiresSibling, true) && check(at, rule.requiresChild, true) && check(at, rule.forbidsChild, false);
}

/** The rule the walk would claim the folder `at` by, or undefined. */
function folderRule(catalog: RuleCatalog, at: string): Rule | undefined {
  const lower = path.basename(at).toLowerCase();
  if (lower !== '') {
    const project = catalog.projectDirectory.find((r) => r.names.includes(lower) && projectMatches(r, at));
    if (project) return project;
    const named = catalog.directory.find((r) => r.names.includes(lower));
    if (named) return named;
  }
  const folded = pathFold(at);
  return catalog.location.find((r) => r.paths.some((p) => pathFold(p) === folded));
}

/** True when `p` is there and is not a folder: the walk judges a file by the file rules. */
function isFile(p: string): boolean {
  try {
    const entry = fs.lstatSync(p, { throwIfNoEntry: false });
    return entry !== undefined && !entry.isDirectory();
  } catch {
    return false; // unreadable: judged as a folder too, which only refuses more
  }
}

/**
 * The advice-only rule that claims `p` or a folder above it, whatever folder a scan started at, or
 * null. `p` is an absolute path as the caller spells it.
 */
export function adviceHitAlong(p: string, catalog: RuleCatalog): AdviceHit | null {
  const hit = (rule: Rule | undefined, at: string): AdviceHit | null =>
    rule?.action === 'advice' ? { path: at, title: rule.title, ...(rule.adviceCommand ? { adviceCommand: rule.adviceCommand } : {}) } : null;
  if (isFile(p)) {
    const own = hit(catalog.file.find((r) => r.names.includes(path.basename(p).toLowerCase())), p);
    if (own) return own;
  } else {
    const own = hit(folderRule(catalog, p), p);
    if (own) return own;
  }
  for (let at = path.dirname(p); ; at = path.dirname(at)) {
    // A rule whose advice is about its folder itself (`adviceCovers: "folder"`) claims nothing in it (hunt HF-L1).
    const rule = folderRule(catalog, at);
    const above = rule?.adviceCovers === 'folder' ? null : hit(rule, at);
    if (above) return above;
    if (path.dirname(at) === at) return null;
  }
}
