import path from 'path';
import { getScan, onScanForgotten } from './diskScanner';
import { storeOf, ScanStore } from './scanStore';
import { collectCleanupSuggestions } from './cleanupRules';
import { ruleCatalogStatus, Rule, RuleConfidence, matchReasonFor, ProjectDirRule } from './rulePacks';
import { getIgnoreMatchers } from './settings';

/**
 * Scan-wide inputs the Reclaim Score needs, computed once and reused (§3.1).
 *
 * Two of the six components cannot be answered from one path alone:
 *
 *  - **size** is normalised against the scan's own distribution, so it needs
 *    that distribution;
 *  - **regenerable** is a rule-pack match, and the rules are matched by
 *    walking the tree rather than by testing a path in isolation.
 *
 * Both are O(nodes) and both are identical for every path in the same scan,
 * so computing either per request would make a 2,000-path batch two thousand
 * whole-tree walks. They are built on first use and cached per scan id, and
 * dropped when the scan they describe is forgotten — a cache outliving its
 * scan would answer for a tree that no longer exists.
 */

/* ────────────────────────── size distribution ────────────────────────── */

export interface SizeDistribution {
  /** Files considered (directories are excluded — they are sums, not items). */
  files: number;
  /** Median file size, bytes. The bottom of the score's range. */
  p50: number;
  /** 99th-percentile file size, bytes. The top of the score's range. */
  p99: number;
}

/**
 * Bucket count for the size histogram: 16 per octave across 64 octaves.
 *
 * A histogram rather than a sorted array of every size, because a scan can
 * hold millions of files and an exact median would cost an 8 MB array and a
 * sort per scan to place two numbers. Sixteen buckets per doubling puts each
 * percentile within ~4.4% of its true value, which is far finer than a
 * log-scaled score can express, at 4 KB of memory and one pass.
 */
const OCTAVES = 64;
const PER_OCTAVE = 16;
const BUCKETS = OCTAVES * PER_OCTAVE;

const bucketFor = (bytes: number): number => {
  if (bytes <= 0) return 0;
  const b = Math.floor(Math.log2(bytes) * PER_OCTAVE);
  return b < 0 ? 0 : b >= BUCKETS ? BUCKETS - 1 : b;
};

/** Representative size for a bucket — its geometric lower edge. */
const sizeForBucket = (bucket: number): number => Math.round(2 ** (bucket / PER_OCTAVE));

/** Percentiles of the file sizes in a scan. One pass, constant memory. */
export function computeSizeDistribution(store: ScanStore): SizeDistribution {
  const counts = new Int32Array(BUCKETS);
  let files = 0;
  store.eachFile(store.rootId, (id) => {
    counts[bucketFor(store.size(id))]++;
    files++;
  });
  if (files === 0) return { files: 0, p50: 0, p99: 0 };

  const at = (fraction: number): number => {
    // Math.ceil, so the 99th percentile of 100 files is the 99th file rather
    // than the 98th — an off-by-one here silently narrows the score's range.
    const target = Math.max(1, Math.ceil(files * fraction));
    let seen = 0;
    for (let b = 0; b < BUCKETS; b++) {
      seen += counts[b];
      if (seen >= target) return sizeForBucket(b);
    }
    return sizeForBucket(BUCKETS - 1);
  };
  return { files, p50: at(0.5), p99: at(0.99) };
}

/* ─────────────────────────── rule claims ─────────────────────────── */

/** What a rule pack says about a path — or about a folder containing it. */
export interface RuleClaim {
  ruleId: string;
  title: string;
  confidence: RuleConfidence;
  /** What matched, in the rule's own words. */
  why: string;
  /** The command that puts it back, where the rule names one. */
  restoreCommand?: string;
  /** The folder the rule actually claimed — may be an ancestor of the path. */
  claimedPath: string;
}

export interface RuleClaims {
  /** Absolute path → the rule that claimed it. Directories, mostly. */
  byPath: Map<string, RuleClaim>;
  /** False when the rule catalog would not load; then nothing was checked. */
  available: boolean;
  reason?: string;
}

/**
 * Which paths the rule packs claim as regenerable, for a whole scan.
 *
 * **Only `action: 'trash'` rules count.** An advisory rule marks something
 * shown for its size and never offered for deletion — a VM disk, a folder the
 * OS owns — and letting one raise a reclaim score would push the app toward
 * suggesting exactly what §C8 built the advisory category to refuse.
 */
export async function computeRuleClaims(store: ScanStore): Promise<RuleClaims> {
  const catalog = ruleCatalogStatus();
  if (!catalog.ok) {
    // A half-loaded catalog is never used: rules people rely on going missing
    // silently is worse than the feature saying it is unavailable.
    return { byPath: new Map(), available: false, reason: catalog.reason };
  }
  const ignore = await getIgnoreMatchers('suggest');
  const byPath = new Map<string, RuleClaim>();

  // Note-suppression (v4 §9.5) is DELIBERATELY not applied here: this feeds
  // the Reclaim Score's `regenerable` component, and the score explains and
  // sorts — it never selects anything for deletion (§3.2). A noted folder
  // still deserves a truthful "this rebuilds itself" in its breakdown; what
  // the note pauses is the surfaces that SUGGEST — Smart Suggestions, the
  // agent summary, MCP cleanup_suggestions and every Autopilot match.
  collectCleanupSuggestions(store, ignore, catalog.catalog, (rule: Rule, nodePath: string) => {
    if (rule.action === 'advice') return;
    byPath.set(nodePath, {
      ruleId: rule.id,
      title: rule.title,
      confidence: rule.confidence,
      why: matchReasonFor(rule),
      restoreCommand: (rule as ProjectDirRule).restoreCommand,
      claimedPath: nodePath,
    });
  });

  return { byPath, available: true };
}

/**
 * The claim covering a path — its own, or the nearest claimed ancestor's.
 *
 * Ancestors matter because the matcher claims a directory and stops
 * descending: `node_modules` is in the map and `node_modules/react/index.js`
 * is not. Both are regenerable by the same `npm install`, and a per-file
 * lookup that only checked exact paths would score every file inside a
 * claimed folder as "no rule recognises this".
 */
export function claimFor(claims: RuleClaims, target: string): RuleClaim | null {
  const exact = claims.byPath.get(target);
  if (exact) return exact;

  let dir = path.dirname(target);
  // Walk up to the filesystem root. `path.dirname('/')` is `/`, and on
  // Windows `path.dirname('C:\\')` is `C:\\`, so the fixed point ends it.
  for (;;) {
    const hit = claims.byPath.get(dir);
    if (hit) return { ...hit, claimedPath: dir };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/* ─────────────────────────────── the cache ─────────────────────────────── */

interface ScanInputs {
  sizes: SizeDistribution;
  claims: RuleClaims;
}

const cache = new Map<string, Promise<ScanInputs>>();

/**
 * Scan-wide inputs for one scan, built once.
 *
 * The **promise** is cached rather than the value, so two fact batches
 * arriving together share one tree walk instead of racing to do it twice —
 * which is the normal case, since the UI asks for facts for whatever is on
 * screen the moment a scan lands.
 */
export function scanInputsFor(scanId: string): Promise<ScanInputs> {
  const existing = cache.get(scanId);
  if (existing) return existing;

  const built = (async (): Promise<ScanInputs> => {
    const scan = getScan(scanId);
    if (!scan || (!scan.store && !scan.root)) {
      return {
        sizes: { files: 0, p50: 0, p99: 0 },
        claims: { byPath: new Map(), available: false, reason: 'That scan is no longer available.' },
      };
    }
    const store = storeOf(scan);
    return { sizes: computeSizeDistribution(store), claims: await computeRuleClaims(store) };
  })().catch((err: unknown) => {
    // A failure must not be cached as a permanent one, and must not reject
    // every future caller — the score reports the affected components as
    // unavailable and carries on with the four that still work.
    cache.delete(scanId);
    const reason = err instanceof Error ? err.message : String(err);
    return {
      sizes: { files: 0, p50: 0, p99: 0 },
      claims: { byPath: new Map(), available: false, reason: `The cleanup rules could not be read (${reason}).` },
    };
  });

  cache.set(scanId, built);
  return built;
}

/** Drop cached inputs — all of them, or one scan's. */
export function clearScanInputs(scanId?: string): void {
  if (scanId === undefined) cache.clear();
  else cache.delete(scanId);
}

// The tree these describe is gone; a distribution and a claim map that outlive
// it would answer confidently about paths that no longer exist.
onScanForgotten((scanId) => clearScanInputs(scanId));
