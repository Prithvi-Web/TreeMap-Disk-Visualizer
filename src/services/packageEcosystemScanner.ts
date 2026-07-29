import fs from 'fs';
import path from 'path';
import { ScanStore, TreeSource, asStore } from './scanStore';
import { CompiledIgnore, matchesAny } from '../utils/glob';
import { samePath } from '../utils/osPaths';
import { PackageCacheRule, ProjectDirRule, RuleCatalog, loadRuleCatalog } from './rulePacks';

/**
 * packageEcosystemScanner — package-manager-aware orphan detection (§C6).
 *
 * Structurally this is `gitScanner.findGitRepos` repeated per ecosystem: walk
 * the already-scanned tree once (no second fs walk), recognise a directory,
 * and read only what the tree cannot answer.
 *
 * **The rules are data, not code.** Every ecosystem, directory name, owning
 * manifest and restore command comes from the §C8 rule packs — a
 * `project-directory` rule tagged with `ecosystem`, or a `package-cache` rule.
 * Adding pnpm support is a JSON edit.
 *
 * Three classifications, and the difference matters:
 *
 *  - **orphan** — the owning project is gone (no `package.json` beside a
 *    `node_modules`, no `Cargo.toml` beside a `target`), or a virtualenv points
 *    at an interpreter that no longer exists. Nothing will ever rebuild it.
 *  - **active** — the owner is right there. Still deletable via Smart
 *    Suggestions, but listed here only as context, never with a checkbox: this
 *    panel's job is the stuff nobody is going to miss.
 *  - **cache** — a shared package cache. Never "orphaned"; calling it that
 *    would be a lie. Always reclaimable, with the command that clears it
 *    properly.
 *
 * When the owner manifest is missing, a directory is only claimed for an
 * ecosystem if one of the rule's `evidence` children is present. `target` is
 * both Rust and Maven, and a wrong label on a delete suggestion is worse than
 * no label — an unidentifiable orphan is simply not reported.
 */

export type PackageEntryKind = 'orphan' | 'active' | 'cache';

export interface PackageEntry {
  ecosystem: string;
  kind: PackageEntryKind;
  /** Directory basename, e.g. "node_modules". */
  name: string;
  path: string;
  size: number;
  /** Last time anything in it changed — the "last build date". */
  modifiedAt: number;
  /** The owning project directory, when it still exists. */
  projectPath?: string;
  projectName?: string;
  /** Plain-English statement of why it is classified this way. */
  reason: string;
  /** How to recreate it (orphan/active) or clear it (cache). */
  command?: string;
  /** True when the entry must not be offered for trashing (root-owned, etc.). */
  advisory?: boolean;
}

export interface EcosystemGroup {
  ecosystem: string;
  orphanCount: number;
  orphanBytes: number;
  activeCount: number;
  activeBytes: number;
  cacheCount: number;
  cacheBytes: number;
  entries: PackageEntry[];
}

export interface PackageOrphanReport {
  ecosystems: EcosystemGroup[];
  orphanBytes: number;
  cacheBytes: number;
  activeBytes: number;
  orphanCount: number;
}

/** Per-ecosystem cap so a pathological tree cannot produce a 100k-row panel. */
const ENTRIES_PER_ECOSYSTEM = 300;

/** True if any sibling matches a pattern (`foo.*` ⇒ any `foo.<ext>`), like C8. */
function siblingPresent(siblings: Set<string>, patterns: string[]): boolean {
  for (const pat of patterns) {
    if (pat.endsWith('.*')) {
      const prefix = pat.slice(0, -1);
      for (const s of siblings) if (s.startsWith(prefix)) return true;
    } else if (siblings.has(pat)) {
      return true;
    }
  }
  return false;
}

/** Children of `id` by lowercased name — the evidence check reads these. */
function childNames(store: ScanStore, id: number): Set<string> {
  const names = new Set<string>();
  store.forEachChild(id, (c) => names.add(store.name(c).toLowerCase()));
  return names;
}

/** The newest mtime anywhere under `id`, bounded so a huge tree stays cheap. */
function lastTouched(store: ScanStore, id: number): number {
  let newest = store.modifiedAt(id);
  let seen = 0;
  const stack = [id];
  while (stack.length && seen < 2000) {
    const cur = stack.pop()!;
    store.forEachChild(cur, (c) => {
      seen++;
      const m = store.modifiedAt(c);
      if (m > newest) newest = m;
      if (store.isDir(c) && seen < 2000) stack.push(c);
    });
  }
  return newest;
}

/**
 * A virtualenv records its base interpreter in `pyvenv.cfg`. If that
 * interpreter is gone the venv cannot run at all, however healthy its project
 * looks — the one "references a version no longer used" case that is cheap and
 * unambiguous to check. Returns the missing interpreter path, or null.
 */
export function brokenVenvInterpreter(venvPath: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(venvPath, 'pyvenv.cfg'), 'utf8');
  } catch {
    return null; // no config to read: say nothing rather than guess
  }
  const line = text.split(/\r?\n/).find((l) => /^\s*home\s*=/.test(l));
  if (!line) return null;
  const home = line.slice(line.indexOf('=') + 1).trim();
  if (!home) return null;
  try {
    fs.statSync(home);
    return null;
  } catch {
    return home;
  }
}

/**
 * Homebrew keeps every installed version of a formula side by side under
 * `Cellar/<formula>/<version>`. Only the newest is linked; the rest are exactly
 * what `brew cleanup` removes. Returns the superseded version directories.
 */
function supersededKegs(store: ScanStore, cellarId: number, cellarPath: string): PackageEntry[] {
  const out: PackageEntry[] = [];
  store.forEachChild(cellarId, (formula) => {
    if (!store.isDir(formula)) return;
    const versions: number[] = [];
    store.forEachChild(formula, (v) => {
      if (store.isDir(v)) versions.push(v);
    });
    if (versions.length < 2) return;
    // Newest by mtime is the one brew linked most recently.
    versions.sort((a, b) => store.modifiedAt(b) - store.modifiedAt(a));
    const formulaName = store.name(formula);
    const formulaPath = store.childPath(formula, cellarPath);
    for (const old of versions.slice(1)) {
      out.push({
        ecosystem: 'homebrew',
        kind: 'orphan',
        name: `${formulaName} ${store.name(old)}`,
        path: store.childPath(old, formulaPath),
        size: store.size(old),
        modifiedAt: store.modifiedAt(old),
        projectPath: formulaPath,
        projectName: formulaName,
        reason: `Superseded — ${formulaName} has ${versions.length} versions installed and only the newest is linked.`,
        command: `brew cleanup ${formulaName}`,
      });
    }
  });
  return out;
}

/**
 * Classify every package-manager artifact in a completed scan.
 *
 * Throws `RulePackError` if the catalog is malformed, exactly like Smart
 * Suggestions — the caller reports the feature unavailable with the reason.
 */
export function scanPackageEcosystems(
  source: TreeSource,
  ignore: CompiledIgnore[],
  catalog: RuleCatalog = loadRuleCatalog(),
): PackageOrphanReport {
  const store = asStore(source);
  const byEcosystem = new Map<string, PackageEntry[]>();
  const push = (entry: PackageEntry): void => {
    let list = byEcosystem.get(entry.ecosystem);
    if (!list) {
      list = [];
      byEcosystem.set(entry.ecosystem, list);
    }
    if (list.length < ENTRIES_PER_ECOSYSTEM) list.push(entry);
  };

  const projectRules = catalog.projectDirectory.filter((r): r is ProjectDirRule & { ecosystem: string; evidence: string[] } =>
    Boolean(r.ecosystem && r.evidence),
  );
  const cacheRules: PackageCacheRule[] = catalog.packageCache;

  /** The cache rule whose paths cover this directory, if any. */
  const cacheRuleFor = (dirPath: string): PackageCacheRule | undefined =>
    cacheRules.find((r) => r.paths.some((p) => samePath(p, dirPath)));

  const visit = (node: number, nodePath: string): void => {
    const kids = store.childIds(node);
    if (kids.length === 0) return;
    const siblings = new Set(kids.map((c) => store.name(c).toLowerCase()));

    for (const child of kids) {
      if (!store.isDir(child)) continue;
      const name = store.name(child);
      const childPath = store.childPath(child, nodePath);
      if (matchesAny(ignore, childPath, name)) continue;
      const lower = name.toLowerCase();

      // 1. A shared package cache. Claimed whole; nothing inside it is a
      //    separate finding, and its contents are not projects.
      const cache = cacheRuleFor(childPath);
      if (cache) {
        push({
          ecosystem: cache.ecosystem,
          kind: 'cache',
          name,
          path: childPath,
          size: store.size(child),
          modifiedAt: store.modifiedAt(child),
          reason: cache.description,
          command: cache.clearCommand,
          advisory: cache.action === 'advice' ? true : undefined,
        });
        continue;
      }

      // 2. Homebrew's Cellar: superseded versions of installed formulae.
      if (lower === 'cellar') {
        for (const keg of supersededKegs(store, child, childPath)) push(keg);
        continue;
      }

      // 3. A project artifact. The owner manifest is the rule's explicit
      //    ownerManifest, or its requiresSibling when that is the same thing.
      const candidates = projectRules.filter((r) => r.names.includes(lower));
      if (candidates.length) {
        const owned = candidates.find((r) => {
          const owner = r.ownerManifest ?? r.requiresSibling;
          return owner ? siblingPresent(siblings, owner) : true;
        });
        if (owned) {
          const projectName = path.basename(nodePath) || nodePath;
          // A venv whose interpreter is gone cannot run, however alive its
          // project looks. That is an orphan with a different reason.
          const broken = owned.ecosystem === 'python' ? brokenVenvInterpreter(childPath) : null;
          push({
            ecosystem: owned.ecosystem,
            kind: broken ? 'orphan' : 'active',
            name,
            path: childPath,
            size: store.size(child),
            modifiedAt: lastTouched(store, child),
            projectPath: nodePath,
            projectName,
            reason: broken
              ? `Its Python interpreter is gone (${broken}) — this environment cannot run.`
              : `In use by ${projectName}.`,
            command: owned.restoreCommand,
          });
          continue; // claimed — never descend into a dependency tree
        }

        // Owner gone. Only claim it for an ecosystem we can actually recognise.
        const kidNames = childNames(store, child);
        const identified = candidates.find((r) => r.evidence.some((e) => kidNames.has(e)));
        if (identified) {
          push({
            ecosystem: identified.ecosystem,
            kind: 'orphan',
            name,
            path: childPath,
            size: store.size(child),
            modifiedAt: lastTouched(store, child),
            reason: `No ${(identified.ownerManifest ?? identified.requiresSibling ?? [])[0] || 'project manifest'} beside it — the project that owned this is gone.`,
            command: identified.restoreCommand,
          });
          continue;
        }
        // Unidentifiable: say nothing. A mislabelled delete suggestion is
        // worse than a missed one.
        continue;
      }

      visit(child, childPath);
    }
  };
  visit(store.rootId, store.rootPath);

  const ecosystems: EcosystemGroup[] = [];
  for (const [ecosystem, entries] of byEcosystem) {
    const sum = (kind: PackageEntryKind): number =>
      entries.filter((e) => e.kind === kind).reduce((s, e) => s + e.size, 0);
    const count = (kind: PackageEntryKind): number => entries.filter((e) => e.kind === kind).length;
    // Orphans first (what the panel exists for), then caches, then context.
    const rank: Record<PackageEntryKind, number> = { orphan: 0, cache: 1, active: 2 };
    entries.sort((a, b) => rank[a.kind] - rank[b.kind] || b.size - a.size);
    ecosystems.push({
      ecosystem,
      orphanCount: count('orphan'),
      orphanBytes: sum('orphan'),
      activeCount: count('active'),
      activeBytes: sum('active'),
      cacheCount: count('cache'),
      cacheBytes: sum('cache'),
      entries,
    });
  }
  // Most reclaimable first: orphans are the point, caches are the runner-up.
  ecosystems.sort((a, b) => b.orphanBytes + b.cacheBytes - (a.orphanBytes + a.cacheBytes));

  return {
    ecosystems,
    orphanBytes: ecosystems.reduce((s, e) => s + e.orphanBytes, 0),
    cacheBytes: ecosystems.reduce((s, e) => s + e.cacheBytes, 0),
    activeBytes: ecosystems.reduce((s, e) => s + e.activeBytes, 0),
    orphanCount: ecosystems.reduce((s, e) => s + e.orphanCount, 0),
  };
}
