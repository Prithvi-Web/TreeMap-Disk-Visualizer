import fs from 'fs';
import os from 'os';
import path from 'path';
import { SuggestionCategory } from '../models/types';
import { winLocalAppData } from '../utils/osPaths';

/**
 * rulePacks — the versioned, maintained known-offenders catalog (§C8).
 *
 * Smart Suggestions used to be three hand-written arrays in cleanupRules.ts.
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
 * `common.json` is not in §C8's file list, and exists deliberately: fifteen of
 * the rules are OS-independent, and triplicating them across three packs makes
 * "add a rule" a three-file edit that drifts. The three named packs are still
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
   * scanner — Smart Suggestions ignores it entirely, so tagging a rule cannot
   * change what the Clean Up list shows.
   */
  ecosystem?: string;
}

/** A build/dependency directory that can be deleted and rebuilt. */
export interface ProjectDirRule extends RuleBase {
  kind: 'project-directory';
  names: string[]; // lowercased at load
  /** Lowercased sibling basenames; a `foo.*` entry matches any `foo.<ext>`. */
  requiresSibling?: string[];
  restoreCommand: string;
  /**
   * §C6: the manifest that OWNS this directory. Missing ⇒ the parent project is
   * gone and the directory is an orphan. Defaults to `requiresSibling`, which
   * is the same thing for every rule that has one; `node_modules` needs it
   * stated separately because Smart Suggestions flags it with or without one.
   */
  ownerManifest?: string[];
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
}

export interface FileRule extends RuleBase {
  kind: 'file';
  names: string[];
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
  /** §C6 only. cleanupRules never reads this, so Smart Suggestions is unchanged. */
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
  'project-directory': ['names', 'requiresSibling', 'restoreCommand', 'ownerManifest', 'evidence'],
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
        const names = requireStringArray(packName, `${at}.names`, entry.names).map((n) => n.toLowerCase());
        const restoreCommand = requireString(packName, `${at}.restoreCommand`, entry.restoreCommand);
        const requiresSibling =
          entry.requiresSibling === undefined
            ? undefined
            : requireStringArray(packName, `${at}.requiresSibling`, entry.requiresSibling).map((s) => s.toLowerCase());
        const ownerManifest =
          entry.ownerManifest === undefined
            ? undefined
            : requireStringArray(packName, `${at}.ownerManifest`, entry.ownerManifest).map((s) => s.toLowerCase());
        const evidence =
          entry.evidence === undefined
            ? undefined
            : requireStringArray(packName, `${at}.evidence`, entry.evidence).map((s) => s.toLowerCase());
        // Orphan detection needs a way to recognise the directory once its
        // owner is gone; without one, an ecosystem-tagged rule would guess.
        if (base.ecosystem && !evidence) {
          fail(packName, `${at} is tagged with an ecosystem but has no evidence[] to identify it once its owner manifest is gone`);
        }
        rule = { ...base, kind, names, restoreCommand, requiresSibling, ownerManifest, evidence };
        break;
      }
      case 'directory':
      case 'file': {
        const names = requireStringArray(packName, `${at}.names`, entry.names).map((n) => n.toLowerCase());
        rule = { ...base, kind, names } as DirRule | FileRule;
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

/**
 * The plain-English "why is this suggested" sentence, derived from what the
 * rule actually matches so it can never drift from the matching itself.
 */
export function matchReasonFor(rule: Rule): string {
  const list = (items: string[]): string =>
    items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;

  switch (rule.kind) {
    case 'project-directory':
      return rule.requiresSibling
        ? `A folder named ${list(rule.names)} sitting next to ${list(rule.requiresSibling)}.`
        : `A folder named ${list(rule.names)}.`;
    case 'directory':
      return `A folder named ${list(rule.names)}, with no project manifest beside it to say what rebuilds it.`;
    case 'file':
      return `A file named ${list(rule.names)}.`;
    case 'location':
      return rule.paths.length === 1
        ? `The known location ${rule.paths[0]}.`
        : `One of ${rule.paths.length} known locations, such as ${rule.paths[0]}.`;
    case 'package-cache':
      return `The ${rule.ecosystem} package cache at ${rule.paths[0]}.`;
    case 'stale-files':
      return `Files under ${rule.withinPath} of at least ${Math.round(rule.minSizeBytes / 1_048_576)} MB, untouched for ${rule.olderThanDays}+ days.`;
  }
}
