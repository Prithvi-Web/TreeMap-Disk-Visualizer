import fs from 'fs';
import os from 'os';
import path from 'path';
import { SuggestionCategory } from '../models/types';
import { winLocalAppData } from '../utils/osPaths';

/**
 * rulePacks — the versioned, maintained known-offenders catalog (§C8).
 *
 * Smart suggestions used to be three hand-written arrays in cleanupRules.ts.
 * They now live in JSON packs beside this file, so a new offender is a data
 * edit rather than a code change. The catalog is loaded once, validated in
 * full, and either succeeds completely or fails with a reason — a partially
 * loaded catalog would silently stop suggesting things the user relies on,
 * which is worse than saying "suggestions are broken, here is why".
 *
 * Files:
 *   common.json   rules that apply on every OS (project dirs, tool caches, junk)
 *   macos.json | windows.json | linux.json   OS-specific cache locations
 *
 * `common.json` is not in §C8's file list, and exists deliberately: each of its
 * rules applies on more than one OS, and triplicating them across three packs
 * makes "add a rule" a three-file edit that drifts. The three named packs are still
 * exactly what the spec calls for; common.json only spares them the copy.
 */

export type RuleConfidence = 'high' | 'medium' | 'low';
/** What the app may do about a match. `advice` means "never offer to trash it". */
export type RuleAction = 'trash' | 'advice';

export type RuleKind = 'project-directory' | 'directory' | 'file' | 'location' | 'stale-files' | 'package-cache';

interface RuleBase {
  id: string;
  kind: RuleKind;
  title: string;
  description: string;
  category: SuggestionCategory;
  confidence: RuleConfidence;
  action: RuleAction;
  /** Which OSes the rule applies to. Absent in the JSON means all of them. */
  os?: NodeJS.Platform[];
  /** How the user gets the space back properly, when trashing is not the way. */
  adviceCommand?: string;
  /**
   * Which package ecosystem this belongs to (§C6). Read only by the orphan
   * scanner — Smart suggestions ignores it entirely, so tagging a rule cannot
   * change what the Clean Up list shows.
   */
  ecosystem?: string;
}

/** A build/dependency directory that can be deleted and rebuilt. */
export interface ProjectDirRule extends RuleBase {
  kind: 'project-directory';
  names: string[]; // lowercased at load
  /** The names as the pack writes them, for prose ("Pods", not "pods"). */
  labels?: string[];
  /** Lowercased sibling basenames; a `foo.*` entry matches any `foo.<ext>`. */
  requiresSibling?: string[];
  /** The siblings as the pack writes them, for prose ("Cargo.toml", not "cargo.toml"). */
  siblingLabels?: string[];
  /**
   * Lowercased basenames, matched as `requiresSibling` is, of which the folder
   * itself must hold one. For a rule whose folder name is also a person's word
   * — `env`, `coverage` — a manifest beside it is not enough: a folder of
   * settings named env sits beside requirements.txt as readily as a
   * virtualenv does (BQL-b1 review F1.4). Read by Smart suggestions and by the
   * orphan scanner's "has project" check alike.
   */
  requiresChild?: string[];
  /** The children as the pack writes them, for prose. */
  childLabels?: string[];
  /**
   * Lowercased basenames, matched as `requiresChild` is, of which the folder
   * must hold none: what only another folder of the same name holds. A
   * project's `.gradle` sits beside build.gradle, and so does the Gradle user
   * home when a project lives in the home folder, or when CI points
   * GRADLE_USER_HOME at the project's own `.gradle`; only the user home holds
   * gradle.properties, init scripts, caches, wrapper and daemon, and no build
   * writes the first two again (BQL-b1 review F2.2). Read by Smart
   * suggestions, and by the orphan scanner for a folder beside its manifest
   * and for an orphan alike.
   */
  forbidsChild?: string[];
  /** The refused children as the pack writes them, for prose. */
  forbiddenLabels?: string[];
  restoreCommand: string;
  /**
   * §C6: the manifest that OWNS this directory. Missing ⇒ the parent project is
   * gone and the directory is an orphan. Defaults to `requiresSibling`, which
   * is the same thing for every rule that has one; `node_modules` needs it
   * stated separately because Smart suggestions flags it with or without one.
   */
  ownerManifest?: string[];
  /** The owner manifest as the pack writes it, for prose ("Gemfile", not "gemfile"). */
  ownerManifestLabels?: string[];
  /**
   * §C6: child names that identify the directory when its owner manifest is
   * already gone — without one of these, an orphan is not claimed for this
   * ecosystem at all. `target` is both Rust and Maven, and guessing is worse
   * than saying nothing.
   */
  evidence?: string[];
}

/** A directory matched on basename alone, with no manifest to confirm it. */
export interface DirRule extends RuleBase {
  kind: 'directory';
  names: string[];
  /** The names as the pack writes them, for prose. */
  labels?: string[];
}

export interface FileRule extends RuleBase {
  kind: 'file';
  names: string[];
  /** The names as the pack writes them, for prose. */
  labels?: string[];
}

/** An absolute, OS-specific location. Paths are token-expanded at load. */
export interface LocationRule extends RuleBase {
  kind: 'location';
  paths: string[];
}

/** Files under a location that are both old enough and big enough. */
export interface StaleFilesRule extends RuleBase {
  kind: 'stale-files';
  withinPath: string;
  olderThanDays: number;
  minSizeBytes: number;
}

/** A shared package-manager cache (§C6). Never "orphaned" — always reclaimable. */
export interface PackageCacheRule extends RuleBase {
  kind: 'package-cache';
  ecosystem: string;
  paths: string[];
  /** The supported way to empty it. */
  clearCommand: string;
}

export type Rule = ProjectDirRule | DirRule | FileRule | LocationRule | StaleFilesRule | PackageCacheRule;

export interface PackSummary {
  name: string;
  updated: string;
  ruleCount: number;
}

export interface RuleCatalog {
  schemaVersion: number;
  packs: PackSummary[];
  /** Evaluation order for a directory: project rules, then generic, then locations. */
  projectDirectory: ProjectDirRule[];
  directory: DirRule[];
  file: FileRule[];
  location: LocationRule[];
  staleFiles: StaleFilesRule[];
  /** §C6 only. cleanupRules never reads this, so Smart suggestions is unchanged. */
  packageCache: PackageCacheRule[];
}

/** Thrown for any malformed pack. The message names the pack and the field. */
export class RulePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulePackError';
  }
}

export const RULEPACK_SCHEMA_VERSION = 1;
const CATEGORIES: SuggestionCategory[] = ['regenerable', 'cache', 'junk'];
const CONFIDENCES: RuleConfidence[] = ['high', 'medium', 'low'];
const ACTIONS: RuleAction[] = ['trash', 'advice'];
const KINDS: RuleKind[] = ['project-directory', 'directory', 'file', 'location', 'stale-files', 'package-cache'];
const PLATFORMS = ['darwin', 'win32', 'linux'];

/** Every key a rule may carry, per kind. Anything else is a typo, and rejected. */
const COMMON_KEYS = ['id', 'kind', 'title', 'description', 'category', 'confidence', 'action', 'os', 'adviceCommand', 'ecosystem'];
const KIND_KEYS: Record<RuleKind, string[]> = {
  'project-directory': ['names', 'requiresSibling', 'requiresChild', 'forbidsChild', 'restoreCommand', 'ownerManifest', 'evidence'],
  directory: ['names'],
  file: ['names'],
  location: ['paths'],
  'stale-files': ['withinPath', 'olderThanDays', 'minSizeBytes'],
  'package-cache': ['paths', 'clearCommand'],
};

export const PACK_NAMES = ['common', 'macos', 'windows', 'linux'] as const;
export type PackName = (typeof PACK_NAMES)[number];

/** Which OS pack belongs to a platform. */
export function packForPlatform(platform: NodeJS.Platform): PackName {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

export function rulePackDir(): string {
  return process.env.TREEMAP_RULEPACK_DIR || path.join(__dirname, 'rulepacks');
}

/* ────────────────────────────── validation ────────────────────────────── */

function fail(pack: string, detail: string): never {
  throw new RulePackError(`Rule pack "${pack}" is invalid: ${detail}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(pack: string, where: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') fail(pack, `${where} must be a non-empty string`);
  return value;
}

function requireStringArray(pack: string, where: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(pack, `${where} must be a non-empty array`);
  return value.map((entry, i) => requireString(pack, `${where}[${i}]`, entry));
}

function requireEnum<T extends string>(pack: string, where: string, value: unknown, allowed: T[]): T {
  if (typeof value !== 'string' || !(allowed as string[]).includes(value)) {
    fail(pack, `${where} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function requireNumber(pack: string, where: string, value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    fail(pack, `${where} must be a number >= ${min}`);
  }
  return value;
}

/**
 * Validate one parsed pack and return its rules, OS-agnostically — no path
 * token is resolved here, so a macOS machine can still prove windows.json is
 * well formed (and CI does exactly that on all three).
 */
export function validateRulePack(packName: string, raw: unknown): { rules: Rule[]; updated: string } {
  if (!isPlainObject(raw)) fail(packName, 'the file must contain a JSON object');
  const allowedTop = ['schemaVersion', 'pack', 'updated', 'rules'];
  for (const key of Object.keys(raw)) {
    if (!allowedTop.includes(key)) fail(packName, `unknown top-level key "${key}"`);
  }
  if (raw.schemaVersion !== RULEPACK_SCHEMA_VERSION) {
    fail(packName, `schemaVersion must be ${RULEPACK_SCHEMA_VERSION}, got ${JSON.stringify(raw.schemaVersion)}`);
  }
  const declared = requireString(packName, 'pack', raw.pack);
  if (declared !== packName) fail(packName, `pack is declared as "${declared}" but lives in ${packName}.json`);
  const updated = requireString(packName, 'updated', raw.updated);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(updated)) fail(packName, 'updated must be an ISO date (YYYY-MM-DD)');
  if (!Array.isArray(raw.rules)) fail(packName, 'rules must be an array');

  const rules: Rule[] = [];
  const seen = new Map<string, Rule>();

  raw.rules.forEach((entry: unknown, index: number) => {
    const at = `rules[${index}]`;
    if (!isPlainObject(entry)) fail(packName, `${at} must be an object`);

    const kind = requireEnum(packName, `${at}.kind`, entry.kind, KINDS);
    const allowed = [...COMMON_KEYS, ...KIND_KEYS[kind]];
    for (const key of Object.keys(entry)) {
      if (!allowed.includes(key)) fail(packName, `${at} has unknown key "${key}" for kind "${kind}"`);
    }

    const base: RuleBase = {
      id: requireString(packName, `${at}.id`, entry.id),
      kind,
      title: requireString(packName, `${at}.title`, entry.title),
      description: requireString(packName, `${at}.description`, entry.description),
      category: requireEnum(packName, `${at}.category`, entry.category, CATEGORIES),
      confidence: requireEnum(packName, `${at}.confidence`, entry.confidence, CONFIDENCES),
      action: entry.action === undefined ? 'trash' : requireEnum(packName, `${at}.action`, entry.action, ACTIONS),
    };
    if (entry.os !== undefined) {
      const list = requireStringArray(packName, `${at}.os`, entry.os);
      for (const p of list) {
        if (!PLATFORMS.includes(p)) fail(packName, `${at}.os contains "${p}"; expected ${PLATFORMS.join(', ')}`);
      }
      base.os = list as NodeJS.Platform[];
    }
    if (entry.adviceCommand !== undefined) {
      base.adviceCommand = requireString(packName, `${at}.adviceCommand`, entry.adviceCommand);
    }
    if (entry.ecosystem !== undefined) {
      base.ecosystem = requireString(packName, `${at}.ecosystem`, entry.ecosystem);
    }
    // An advisory rule exists to say "don't trash this, do that instead" — with
    // no `that`, it is just an unactionable warning.
    if (base.action === 'advice' && !base.adviceCommand) {
      fail(packName, `${at} has action "advice" but no adviceCommand to offer instead`);
    }

    let rule: Rule;
    switch (kind) {
      case 'project-directory': {
        // Matched lowercased; said as written (QA D06: "cargo.toml" in prose).
        const labels = requireStringArray(packName, `${at}.names`, entry.names);
        const names = labels.map((n) => n.toLowerCase());
        const restoreCommand = requireString(packName, `${at}.restoreCommand`, entry.restoreCommand);
        const siblingLabels =
          entry.requiresSibling === undefined
            ? undefined
            : requireStringArray(packName, `${at}.requiresSibling`, entry.requiresSibling);
        const requiresSibling = siblingLabels?.map((s) => s.toLowerCase());
        const childLabels =
          entry.requiresChild === undefined
            ? undefined
            : requireStringArray(packName, `${at}.requiresChild`, entry.requiresChild);
        const requiresChild = childLabels?.map((s) => s.toLowerCase());
        const forbiddenLabels =
          entry.forbidsChild === undefined
            ? undefined
            : requireStringArray(packName, `${at}.forbidsChild`, entry.forbidsChild);
        const forbidsChild = forbiddenLabels?.map((s) => s.toLowerCase());
        const ownerManifestLabels =
          entry.ownerManifest === undefined
            ? undefined
            : requireStringArray(packName, `${at}.ownerManifest`, entry.ownerManifest);
        const ownerManifest = ownerManifestLabels?.map((s) => s.toLowerCase());
        const evidence =
          entry.evidence === undefined
            ? undefined
            : requireStringArray(packName, `${at}.evidence`, entry.evidence).map((s) => s.toLowerCase());
        // Orphan detection needs a way to recognise the directory once its
        // owner is gone; without one, an ecosystem-tagged rule would guess.
        if (base.ecosystem && !evidence) {
          fail(packName, `${at} is tagged with an ecosystem but has no evidence[] to identify it once its owner manifest is gone`);
        }
        rule = { ...base, kind, names, labels, restoreCommand, requiresSibling, siblingLabels, requiresChild, childLabels, forbidsChild, forbiddenLabels, ownerManifest, ownerManifestLabels, evidence };
        break;
      }
      case 'directory':
      case 'file': {
        const labels = requireStringArray(packName, `${at}.names`, entry.names);
        const names = labels.map((n) => n.toLowerCase());
        rule = { ...base, kind, names, labels } as DirRule | FileRule;
        break;
      }
      case 'location': {
        rule = { ...base, kind, paths: requireStringArray(packName, `${at}.paths`, entry.paths) };
        break;
      }
      case 'package-cache': {
        if (!base.ecosystem) fail(packName, `${at} is a package-cache and must name its ecosystem`);
        rule = {
          ...base,
          ecosystem: base.ecosystem,
          kind,
          paths: requireStringArray(packName, `${at}.paths`, entry.paths),
          clearCommand: requireString(packName, `${at}.clearCommand`, entry.clearCommand),
        };
        break;
      }
      case 'stale-files': {
        rule = {
          ...base,
          kind,
          withinPath: requireString(packName, `${at}.withinPath`, entry.withinPath),
          olderThanDays: requireNumber(packName, `${at}.olderThanDays`, entry.olderThanDays, 1),
          minSizeBytes: requireNumber(packName, `${at}.minSizeBytes`, entry.minSizeBytes, 0),
        };
        break;
      }
    }

    // Rules may share an id to merge into one group (several `dist` shapes are
    // one "Web framework build" suggestion) — but only if they agree about what
    // that group IS. Disagreeing copies would make the group's own text depend
    // on which rule happened to match first.
    const twin = seen.get(base.id);
    if (twin) {
      const same =
        twin.title === base.title &&
        twin.description === base.description &&
        twin.category === base.category &&
        twin.action === base.action &&
        (twin as ProjectDirRule).restoreCommand === (rule as ProjectDirRule).restoreCommand;
      if (!same) fail(packName, `${at} reuses id "${base.id}" with different text — merged rules must agree`);
    } else {
      seen.set(base.id, rule);
    }

    rules.push(rule);
  });

  return { rules, updated };
}

/* ────────────────────────────── loading ────────────────────────────── */

/** Expand `{home}`, `{localAppData}`, `{windir}`, `{systemDrive}` in a pack path. */
function expandPath(raw: string): string | null {
  const segments = raw.split('/').filter((s) => s !== '');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '{home}') out.push(os.homedir());
    else if (segment === '{localAppData}') {
      const local = winLocalAppData();
      if (!local) return null;
      out.push(local);
    } else if (segment === '{windir}') {
      out.push(process.env.windir || process.env.SystemRoot || 'C:\\Windows');
    } else if (segment === '{systemDrive}') {
      out.push((process.env.SystemDrive || 'C:') + path.sep);
    } else if (/^\{[a-zA-Z]+\}$/.test(segment)) {
      return null; // an unknown token cannot be honestly resolved
    } else {
      out.push(segment);
    }
  }
  if (out.length === 0) return null;
  // A pack path that starts with a plain segment is absolute POSIX ("/var/...").
  const first = out[0];
  if (!path.isAbsolute(first) && !/^\{/.test(segments[0])) return path.posix.sep + out.join(path.posix.sep);
  return path.join(...out);
}

function readPack(dir: string, name: PackName): { rules: Rule[]; updated: string } {
  const file = path.join(dir, `${name}.json`);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new RulePackError(`Rule pack "${name}" could not be read from ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RulePackError(`Rule pack "${name}" is not valid JSON: ${(err as Error).message}`);
  }
  return validateRulePack(name, parsed);
}

function buildCatalog(dir: string, platform: NodeJS.Platform): RuleCatalog {
  const catalog: RuleCatalog = {
    schemaVersion: RULEPACK_SCHEMA_VERSION,
    packs: [],
    projectDirectory: [],
    directory: [],
    file: [],
    location: [],
    staleFiles: [],
    packageCache: [],
  };

  for (const name of ['common', packForPlatform(platform)] as PackName[]) {
    const { rules, updated } = readPack(dir, name);
    let applied = 0;
    for (const rule of rules) {
      if (rule.os && !rule.os.includes(platform)) continue;
      applied++;
      switch (rule.kind) {
        case 'project-directory': catalog.projectDirectory.push(rule); break;
        case 'directory': catalog.directory.push(rule); break;
        case 'file': catalog.file.push(rule); break;
        case 'stale-files': {
          const within = expandPath(rule.withinPath);
          if (within === null) { applied--; continue; }
          catalog.staleFiles.push({ ...rule, withinPath: within });
          break;
        }
        case 'location': {
          // Drop paths this machine cannot resolve rather than matching on a
          // half-expanded string, which would be a path nobody has.
          const paths = rule.paths.map(expandPath).filter((p): p is string => p !== null);
          if (paths.length === 0) { applied--; continue; }
          catalog.location.push({ ...rule, paths });
          break;
        }
        case 'package-cache': {
          const paths = rule.paths.map(expandPath).filter((p): p is string => p !== null);
          if (paths.length === 0) { applied--; continue; }
          catalog.packageCache.push({ ...rule, paths });
          break;
        }
      }
    }
    catalog.packs.push({ name, updated, ruleCount: applied });
  }

  return catalog;
}

let cached: { ok: true; catalog: RuleCatalog } | { ok: false; reason: string } | null = null;

/**
 * The catalog for this machine, loaded once. Throws `RulePackError` if any pack
 * is malformed — the caller turns that into the feature reporting itself broken
 * (§6 failure isolation: the app still boots, this one panel says why).
 */
export function loadRuleCatalog(): RuleCatalog {
  const status = ruleCatalogStatus();
  if (!status.ok) throw new RulePackError(status.reason);
  return status.catalog;
}

export function ruleCatalogStatus(): { ok: true; catalog: RuleCatalog } | { ok: false; reason: string } {
  if (cached) return cached;
  try {
    cached = { ok: true, catalog: buildCatalog(rulePackDir(), process.platform) };
  } catch (err) {
    cached = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return cached;
}

/** Test-only: the catalog is memoised, and suites swap TREEMAP_RULEPACK_DIR. */
export function resetRuleCatalog(): void {
  cached = null;
}

/** Load an arbitrary directory for a named platform, bypassing the cache. */
export function loadRuleCatalogFrom(dir: string, platform: NodeJS.Platform): RuleCatalog {
  return buildCatalog(dir, platform);
}

/* ─────────────────────── a restore command's <folder> ─────────────────────── */

/**
 * Where a restore command names the folder it makes, the pack writes this in
 * its place: one virtualenv rule matches .venv, venv and env, and the command
 * is "python3 -m venv <folder>, then …" for whichever it was. The API and MCP
 * serve the command as the pack writes it (openapi `regenerateCmd`); what a
 * person reads — the Clean Up card, an Autopilot candidate's run record — has
 * it filled in by `fillFolder`, because `<folder>` pasted into a shell is a
 * redirect from a file named "folder" (BQL item 7).
 */
export const FOLDER_PLACEHOLDER = '<folder>';

/** Every character a POSIX shell or zsh reads as itself in an unquoted word. */
const PLAIN_SHELL_WORD = /^[A-Za-z0-9_./+@%:,-]+$/;

/**
 * `name` as one word that sh and zsh read back as exactly that name: as it is
 * when every character is plain, else in single quotes (a `'` inside written
 * `'\''`). A name that begins with "-" is spelled `./-…`, so the program reads
 * a folder, not an option. The page keeps a copy (220-clean-up-modal.js);
 * tests/rulePacks.test.ts holds the two to one answer.
 */
export function shellWord(name: string): string {
  const word = name.startsWith('-') ? `./${name}` : name;
  return PLAIN_SHELL_WORD.test(word) ? word : `'${word.split("'").join("'\\''")}'`;
}

/**
 * `command` with each step holding `<folder>` written once per distinct name,
 * in the order met, as alternatives joined by " · ": "python3 -m venv .venv ·
 * python3 -m venv env, then reinstall the packages it held". Each name is a
 * `shellWord`. A command with no placeholder, or no name to put in it, comes
 * back as it is. Steps are split on ", then ", as the page's remedy markup
 * reads them. The page keeps a copy (220-clean-up-modal.js); tests/rulePacks.test.ts
 * holds the two to one answer.
 */
export function fillFolder(command: string, names: readonly string[]): string {
  if (!command.includes(FOLDER_PLACEHOLDER)) return command;
  const words = [...new Set(names)].map(shellWord);
  if (words.length === 0) return command;
  return command.split(/(,\s+then\s+)/).map((part, i) =>
    i % 2 === 0 && part.includes(FOLDER_PLACEHOLDER)
      ? words.map((word) => part.split(FOLDER_PLACEHOLDER).join(word)).join(' · ')
      : part).join('');
}

/**
 * Small words prose cannot do without and no command holds: the page's list
 * (220-clean-up-modal.js), word for word. Exported so tests/rulePacks.test.ts
 * can hold the two lists equal (BQL-b1 review F2.5).
 */
export const REMEDY_PROSE_WORDS: ReadonlySet<string> = new Set(['a', 'an', 'and', 'are', 'automatic', 'automatically', 'be', 'first', 'is', 'it', 'its', 'next', 'on', 'or', 'the', 'these', 'this', 'until', 'when', 'will']);

/**
 * Whether one part of a remedy — a restore or advice text split on " · " and
 * ", then " — is a command to run or words to read: "npm install" is one, "the
 * next test run with coverage writes it again" and "Final Cut Pro ▸ File ▸ …"
 * are not. A command starts the way a program name does — lower case, a digit
 * or a path — and holds none of REMEDY_PROSE_WORDS. The page's own judgment
 * (QA fourth pass E03), which sets a command in a code pill; the Reclaim
 * Score's reason sets one in backticks by the same rule (BQL-b1 review F1.2,
 * F1.5). tests/rulePacks.test.ts holds the two to one answer.
 */
export function remedyIsCommand(part: string): boolean {
  if (!/^[a-z0-9./~_-]/.test(part) || /[▸—]/.test(part)) return false;
  return !part.split(/\s+/).some((w) => REMEDY_PROSE_WORDS.has(w.toLowerCase().replace(/[.,;:]+$/, '')));
}

/**
 * The plain-English "why is this suggested" sentence, derived from what the
 * rule actually matches so it can never drift from the matching itself.
 *
 * `matched.names` narrows a name rule to the names a walk actually found
 * (QA D06: a group of `.next` folders said "A folder named .next, .nuxt,
 * .output, .svelte-kit or .angular"); without it the sentence lists every
 * name the rule knows. Names and siblings are said as the pack writes them.
 */
export function matchReasonFor(rule: Rule, matched?: { names?: readonly string[] }): string {
  const list = (items: readonly string[]): string =>
    items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
  const named = (r: ProjectDirRule | DirRule | FileRule): readonly string[] =>
    matched?.names?.length ? matched.names : (r.labels ?? r.names);

  switch (rule.kind) {
    case 'project-directory': {
      // "holding pyvenv.cfg, sitting next to requirements.txt": what the folder holds (and does not), then what is beside it.
      const holds = rule.requiresChild ? ` holding ${list(rule.childLabels ?? rule.requiresChild)}` : '';
      const lacks = rule.forbidsChild ? `${holds ? ' and' : ' holding'} no ${list(rule.forbiddenLabels ?? rule.forbidsChild)}` : '';
      const holding = holds + lacks;
      return rule.requiresSibling
        ? `A folder named ${list(named(rule))}${holding}${holding ? ',' : ''} sitting next to ${list(rule.siblingLabels ?? rule.requiresSibling)}.`
        : `A folder named ${list(named(rule))}${holding}.`;
    }
    case 'directory':
      return `A folder named ${list(named(rule))}, with no project manifest beside it to say what rebuilds it.`;
    case 'file':
      return `A file named ${list(named(rule))}.`;
    case 'location':
      return rule.paths.length === 1
        ? `The known location ${rule.paths[0]}.`
        : `One of ${rule.paths.length} known locations, such as ${rule.paths[0]}.`;
    case 'package-cache':
      return `The ${rule.ecosystem} package cache at ${rule.paths[0]}.`;
    case 'stale-files':
      return `Files under ${rule.withinPath} of at least ${Math.round(rule.minSizeBytes / 1_000_000)} MB, untouched for ${rule.olderThanDays}+ days.`;
  }
}

/**
 * Each suggestion group's "why", narrowed to the names its items carry (QA D06).
 *
 * The walk builds a group's sentence from its rule, which lists every name the
 * rule knows; a group holds what actually matched. Applied where groups are
 * served (cleanupMemo), so the walk itself — held byte for byte to the
 * pre-U-16 matcher — is untouched. Names come from the items the group lists,
 * on-disk spelling, each once whatever its case.
 *
 * A group several rules share (one id — regen-web-build is the framework
 * folders and dist beside a JS project file) is said rule by rule, each rule
 * naming the names it matched, in the catalog's order: the walk's sentence
 * came from whichever rule it met first, so it left the other rule's folders
 * unnamed, and which ones depended on walk order (review F2.2).
 *
 * Only a group with fewer than `itemCap` items is narrowed (review F1.2): the
 * walk lists the first `itemCap` matches it meets, in walk order, while its
 * totalSize counts every one, so a full list may leave out a name whose bytes
 * the total includes. Such a group, and one holding a name no rule of its id
 * names, is said in full: every rule of the id, every name. That may name
 * more than matched but never less. Returns new groups; the input is not edited.
 */
export function withMatchedReasons<G extends { id: string; why?: string; items: readonly { name: string }[] }>(
  groups: G[],
  catalog: RuleCatalog,
  itemCap: number,
): G[] {
  const byId = new Map<string, (ProjectDirRule | DirRule | FileRule)[]>();
  for (const r of [...catalog.projectDirectory, ...catalog.directory, ...catalog.file]) {
    byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  }
  return groups.map((g) => {
    const rules = byId.get(g.id);
    if (!rules || g.items.length === 0) return g;
    const why = groupReason(rules, g.items.length < itemCap ? g.items : null);
    return why === g.why ? g : { ...g, why };
  });
}

/**
 * The sentence for a group whose id `rules` share. `items` is every match the
 * group holds, or null when its list was cut and the rest are unknown: then
 * every rule says every name it knows.
 */
function groupReason(rules: readonly (ProjectDirRule | DirRule | FileRule)[], items: readonly { name: string }[] | null): string {
  const full = (): string => joinReasons(rules.map((r) => matchReasonFor(r)));
  if (!items) return full();
  const matched = new Map<ProjectDirRule | DirRule | FileRule, string[]>();
  const seen = new Set<string>();
  for (const item of items) {
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rule = rules.find((r) => r.names.includes(key));
    if (!rule) return full();
    matched.set(rule, [...(matched.get(rule) ?? []), item.name]);
  }
  return joinReasons(rules.filter((r) => matched.has(r)).map((r) => matchReasonFor(r, { names: matched.get(r) })));
}

/** Rule sentences as one: "A folder named .next; or a folder named dist sitting next to …". */
function joinReasons(sentences: readonly string[]): string {
  return sentences
    .map((s, i) => {
      const body = i < sentences.length - 1 ? s.replace(/\.$/, '') : s;
      return i === 0 ? body : `or ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
    })
    .join('; ');
}
