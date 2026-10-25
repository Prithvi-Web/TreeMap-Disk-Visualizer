import fs from 'fs';
import path from 'path';
import { foldName, realPlaceNow } from '../utils/pathSanitizer';
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
 * Names and locations compare as a file system may fold them (`foldName`), so another case or a
 * folded letter (ſ for s) of an advice-only folder's name is that folder (hunt HF-L5); the caller
 * also asks of every spelling of where the path lives. The sibling and child conditions read the
 * names in a folder lowercased, as the walk reads them.
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

/** A name as a file system may fold it (`foldName`, then upper and lower case once more): a fold only refuses more here. */
function folded(name: string): string {
  return foldName(name).toUpperCase().toLowerCase();
}

/**
 * A path's names, its root first, each as a file system may fold it — how two spellings of one place
 * compare (hunt HF-L3, HF-L5): `VMFOLDER` and `vmfolder` on a volume that folds case, `vmdiſk.bundle`
 * and `vmdisk.bundle` on one that folds ſ, as the scanned-root rule and the agent policy compare names.
 */
export function foldedNamesOf(p: string): string[] {
  const { root } = path.parse(p);
  return [root, ...p.slice(root.length).split(path.sep).filter((name) => name.length > 0)].map(folded);
}

/**
 * Where `p` really is, when it is no link itself: the native realpath (`realPlaceNow`) — every link
 * resolved and each name as the volume stores it, so a Windows short name (8.3: `LOCALS~1` for
 * `LocalState`), which no fold explains, is the long name it stands for (review F1.2). Null for a link,
 * which is judged as itself (removing a link removes the link, never what it leads to), for a path
 * that is not there, and for one that cannot be looked up.
 */
export function realPlaceUnlessLink(p: string): string | null {
  try {
    const entry = fs.lstatSync(p, { throwIfNoEntry: false });
    if (entry === undefined || entry.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return realPlaceNow(p);
}

/** Whether the folded names `outer` (`foldedNamesOf`) are `inner`'s or lead to them: the same place, or a folder above it. */
export function namesLeadTo(outer: readonly string[], inner: readonly string[]): boolean {
  return outer.length <= inner.length && outer.every((name, i) => name === inner[i]);
}

/** A run of folded names as one key: NUL is in no file name. */
const KEY_JOIN = '\u0000';

/** Each rule's names and paths, folded once per catalog: a batch of 500 paths judges every folder above each. */
interface FoldedRules {
  names: Map<Rule, string[]>;
  paths: Map<Rule, string[]>;
  /** How many names each location rule's paths have: a folder with another count is no location rule's. */
  depths: Set<number>;
}
const foldedRules = new WeakMap<RuleCatalog, FoldedRules>();

function foldedRulesOf(catalog: RuleCatalog): FoldedRules {
  const known = foldedRules.get(catalog);
  if (known) return known;
  const names = new Map<Rule, string[]>();
  for (const rule of [...catalog.projectDirectory, ...catalog.directory, ...catalog.file]) names.set(rule, rule.names.map(folded));
  const paths = new Map<Rule, string[]>();
  const depths = new Set<number>();
  for (const rule of catalog.location) {
    const each = rule.paths.map(foldedNamesOf);
    for (const ruleNames of each) depths.add(ruleNames.length);
    paths.set(rule, each.map((ruleNames) => ruleNames.join(KEY_JOIN)));
  }
  const made = { names, paths, depths };
  foldedRules.set(catalog, made);
  return made;
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

/**
 * The rule the walk would claim the folder `at` by, or undefined. The first `count` of `names` are
 * `at`'s folded names (`foldedNamesOf`): every folder above a path is a run of the path's own names,
 * so they are folded once per path, never again for each folder (review F1.1).
 */
function folderRule(catalog: RuleCatalog, at: string, names: readonly string[], count: number): Rule | undefined {
  const rules = foldedRulesOf(catalog);
  const base = path.basename(at);
  if (base !== '') {
    // Only a network share's root (`\\server\share\`) has a last name and no name past its root.
    const name = count > 1 ? names[count - 1] : folded(base);
    const project = catalog.projectDirectory.find((r) => rules.names.get(r)?.includes(name) && projectMatches(r, at));
    if (project) return project;
    const named = catalog.directory.find((r) => rules.names.get(r)?.includes(name));
    if (named) return named;
  }
  if (!rules.depths.has(count)) return undefined; // no location rule's folder has this many names
  const key = names.slice(0, count).join(KEY_JOIN);
  return catalog.location.find((r) => rules.paths.get(r)?.includes(key));
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
  // `p`, then every folder above it to its root: folder i's folded names are the first
  // (names.length - i) of `p`'s, and at least its root — a root spelled with more separators than its
  // own (`//a` on POSIX) reaches its root by one more step. (On Windows a `/`, which dirname reads as
  // a separator and foldedNamesOf as part of a name, never reaches here: every caller's path is
  // resolved, and Windows' resolve turns `/` into `\`.)
  const chain = [p];
  for (let at = p; path.dirname(at) !== at; ) chain.push((at = path.dirname(at)));
  const names = foldedNamesOf(p);
  const ruleAt = (i: number): Rule | undefined => folderRule(catalog, chain[i], names, Math.max(1, names.length - i));
  if (isFile(p)) {
    const name = folded(path.basename(p));
    const own = hit(catalog.file.find((r) => foldedRulesOf(catalog).names.get(r)?.includes(name)), p);
    if (own) return own;
  } else {
    const own = hit(ruleAt(0), p);
    if (own) return own;
  }
  for (let i = 1; i < chain.length; i++) {
    // A rule whose advice is about its folder itself (`adviceCovers: "folder"`) claims nothing in it (hunt HF-L1).
    const rule = ruleAt(i);
    const above = rule?.adviceCovers === 'folder' ? null : hit(rule, chain[i]);
    if (above) return above;
  }
  return null;
}
