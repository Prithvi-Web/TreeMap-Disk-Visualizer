import fs from 'fs';
import os from 'os';
import { getScan } from '../diskScanner';
import { storeOf } from '../scanStore';
import { computeFacts } from '../facts';
import { capabilityState } from '../../platform/capabilities';
import { evaluate, evaluateMaybe, isEmptyQuery, type EvalFacts, type EvalNode } from './evaluate';
import { factsNeeded } from './parse';
import type { Ast } from './types';
import type { RecoverabilityFact } from '../recoverabilityTypes';
import type { LastUsedInfo } from '../../platform/types';
import type { ReclaimScoreFactValue } from '../facts';

/**
 * Running a parsed query against a scan (v4 §2.2).
 *
 * ── Two passes, and why ──
 *
 * Facts cost subprocesses. Fetching `lastUsed` and `recoverability` for every
 * node in a million-node scan to answer `size>1gb used>1y` would take minutes
 * to answer a question that `size>1gb` alone narrows to a handful.
 *
 * So: pass one evaluates the query with **no facts at all**, in Kleene logic,
 * and keeps everything not *definitely* false. Pass two fetches facts for
 * those candidates only, then evaluates properly. The three-valued step is
 * what makes this safe — running the ordinary evaluator with facts missing
 * would read every unfetched fact as false and discard exactly the rows the
 * query is about.
 *
 * ── What it refuses to hide ──
 *
 * `degraded` names every provider the query needed and this machine could not
 * supply. Without it, `backup:yes` on a Mac with no Time Machine returns an
 * empty list indistinguishable from "nothing matched" — §2.2 calls that out
 * specifically, and it is the difference between a tool that says "I don't
 * know" and one that quietly says "no".
 */

/** Candidates whose facts we are willing to fetch for one query. */
const CANDIDATE_CAP = 20_000;

/** Facts are requested in batches this size — the route's own per-request cap. */
const FACT_BATCH = 2000;

/** `created` costs a stat; this bounds how many a single query may spend. */
/** Exported so v4 §7.2's calendar shares the budget rather than copying it. */
export const STAT_CAP = 20_000;

export interface QueryHit {
  path: string;
  name: string;
  size: number;
  isDir: boolean;
  mtimeMs: number;
}

export interface QueryOutcome {
  total: number;
  truncated: boolean;
  hits: QueryHit[];
  degraded: { provider: string; reason: string }[];
  /** Candidates examined — lets a caller state coverage rather than imply it. */
  examined: number;
}

export type SortKey = 'size' | 'name' | 'modified' | 'path';

export interface ExecuteOptions {
  limit: number;
  offset: number;
  sort: SortKey;
  signal: AbortSignal;
}

/* ------------------------------ fact plumbing ------------------------------ */

/** Map a recoverability fact onto the enum values the grammar exposes. */
export function gitStateOf(fact: RecoverabilityFact): 'pushed' | 'dirty' | 'none' {
  const git = fact.git;
  if (!git || !git.hasRemote) return 'none';
  if (git.fullyPushed && git.pathTracked) return 'pushed';
  return 'dirty';
}

export function cloudStateOf(fact: RecoverabilityFact): 'placeholder' | 'synced' | 'local-only' | null {
  const cloud = fact.cloud;
  if (!cloud) return null;
  switch (cloud.state) {
    case 'placeholder': return 'placeholder';
    case 'synced-local': return 'synced';
    case 'local-only': return 'local-only';
    default: return null;
  }
}

/**
 * Fetch the facts a query needs, for one batch of paths.
 *
 * Providers that report themselves unavailable are collected into `degraded`
 * rather than silently yielding nothing.
 */
async function fetchFacts(
  scanId: string,
  paths: string[],
  needed: Set<string>,
  signal: AbortSignal,
  degraded: Map<string, string>,
): Promise<Map<string, EvalFacts>> {
  const out = new Map<string, EvalFacts>();
  for (const p of paths) out.set(p, {});

  const providers = [...needed].filter((n) => n === 'lastUsed' || n === 'recoverability' || n === 'reclaimScore');
  if (providers.length === 0) return out;

  for (let i = 0; i < paths.length; i += FACT_BATCH) {
    if (signal.aborted) break;
    const batch = paths.slice(i, i + FACT_BATCH);
    const result = await computeFacts(scanId, batch, providers, signal);

    for (const id of providers) {
      const provider = result[id];
      if (!provider) continue;
      if (!provider.available) {
        degraded.set(id, provider.reason ?? `${id} is not available on this computer.`);
        continue;
      }
      for (const [path, raw] of Object.entries(provider.values)) {
        const facts = out.get(path);
        if (!facts) continue;
        if (id === 'lastUsed') {
          const info = raw as LastUsedInfo;
          facts.lastUsedMs = info.lastUsedMs;
        } else if (id === 'reclaimScore') {
          facts.score = (raw as ReclaimScoreFactValue).score;
        } else {
          const fact = raw as RecoverabilityFact;
          facts.elsewhere = fact.elsewhere;
          facts.git = gitStateOf(fact);
          facts.backup = fact.backup ? fact.backup.pathCovered : undefined;
          facts.cloud = cloudStateOf(fact);
        }
      }
    }
  }
  return out;
}

/**
 * Providers a query needs that this machine cannot supply at all.
 *
 * Checked up front from the capability registry so a query can be reported
 * degraded even when it matched nothing and no fact batch ever ran.
 */
async function degradedProviders(needed: Set<string>): Promise<Map<string, string>> {
  const degraded = new Map<string, string>();

  if (needed.has('lastUsed')) {
    const cap = await capabilityState('lastUsed');
    if (!cap.available) degraded.set('lastUsed', cap.reason ?? 'Last-opened dates are not available on this computer.');
  }
  if (needed.has('recoverability')) {
    const [git, backup] = await Promise.all([capabilityState('gitStatus'), capabilityState('backupMembership')]);
    // Recoverability composes three signals and degrades to whichever work, so
    // it is only reported degraded when a signal is genuinely missing — and the
    // reason names which one, not the whole feature.
    if (!git.available) degraded.set('gitStatus', git.reason ?? 'Git status is not available on this computer.');
    if (!backup.available) degraded.set('backupMembership', backup.reason ?? 'No backup system was found on this computer.');
  }
  // `reclaimScore` is no longer reported degraded up front: as of §3 it is a
  // real provider, and unlike the others it is never wholly unavailable —
  // it is built from six signals and states per file which of them answered.
  // A machine with no git and no backup still scores every file on size,
  // staleness and regenerability, so declaring the whole field degraded here
  // would hide four working components behind two missing ones. When a file
  // genuinely cannot be scored at all it is simply absent from the fact
  // batch, and `score:` does not match it — which is the correct answer, not
  // a degradation of the query.
  if (needed.has('duplicates')) {
    // Truthful: there is no wiring from the duplicate job into the query
    // evaluator yet. The earlier wording promised that running the Duplicates
    // view would make this filter work, which it does not.
    degraded.set('duplicates', 'TreeMap cannot filter by duplicates yet, so "dupe:" matches nothing. Use the Duplicates view for now.');
  }
  return degraded;
}

/* -------------------------------- execution -------------------------------- */

const SORTERS: Record<SortKey, (a: QueryHit, b: QueryHit) => number> = {
  // Ties broken by path so paging is stable — without it, two equal-sized
  // files can swap places between page 1 and page 2 and one is never seen.
  size: (a, b) => b.size - a.size || a.path.localeCompare(b.path),
  name: (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  modified: (a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path),
  path: (a, b) => a.path.localeCompare(b.path),
};

/**
 * Run a query over one completed scan.
 *
 * Walks the packed store directly rather than materialising a tree: a scan can
 * hold millions of nodes and the point of the store is that nothing has to be
 * turned into objects to be read.
 */
export async function executeAgainstScan(
  scanId: string,
  ast: Ast,
  opts: ExecuteOptions,
): Promise<QueryOutcome | { error: string; code: string }> {
  const scan = getScan(scanId);
  if (!scan) return { error: 'Unknown or expired scanId', code: 'SCAN_NOT_FOUND' };
  if (scan.status === 'running') return { error: 'Scan is still running — try again when it completes', code: 'SCAN_RUNNING' };
  if (!scan.store && !scan.root) return { error: scan.error ?? 'Scan failed', code: 'SCAN_FAILED' };

  const store = storeOf(scan);
  const home = os.homedir();
  const now = Date.now();
  const needed = factsNeeded(ast);
  const degraded = await degradedProviders(needed);

  // An empty box means "no filter", not "match nothing" — the original parser
  // reports the empty query as matching nothing, which is right for a
  // highlight overlay and wrong for a filter.
  if (isEmptyQuery(ast)) {
    return { total: 0, truncated: false, hits: [], degraded: [...degraded].map(([provider, reason]) => ({ provider, reason })), examined: 0 };
  }

  const wantsCreated = astUsesCreated(ast);
  let statsSpent = 0;
  let statsCapped = 0;
  let statsFailed = 0;
  const createdOf = (p: string): number | null => {
    if (statsSpent >= STAT_CAP) { statsCapped++; return null; }
    statsSpent++;
    try {
      const st = fs.statSync(p);
      // birthtimeMs is 0 on filesystems that do not record a creation time.
      return st.birthtimeMs > 0 ? st.birthtimeMs : null;
    } catch {
      // Unreadable — a permission the process lacks. Counted, and reported, so
      // it does not become a silent "this file does not match your query".
      statsFailed++;
      return null;
    }
  };

  /* ---- pass one: everything not definitely false, facts unknown ---- */

  const candidates: EvalNode[] = [];
  let examined = 0;
  let capped = false;

  let aborted = false;
  const stack: { id: number; path: string; depth: number }[] = [
    { id: store.rootId, path: store.rootPath, depth: 0 },
  ];
  while (stack.length > 0) {
    if (opts.signal.aborted) { aborted = true; break; }
    const frame = stack.pop()!;
    const { id, path: nodePath, depth } = frame;
    examined++;

    const isDir = store.isDir(id);
    const node: EvalNode = {
      name: store.name(id),
      path: nodePath,
      size: store.size(id),
      isDir,
      mtimeMs: store.modifiedAt(id),
      depth,
      // `childCount` is 0 both for a genuinely empty directory and for one
      // whose children were never listed (permission denied, excluded,
      // pruned). Conflating them would offer permission-denied folders up to
      // an `empty:yes` query — and those are exactly what gets bulk-trashed.
      childCount: isDir && store.hasChildArray(id) ? store.childCount(id) : undefined,
    };

    // Deliberately NO facts here, and deliberately no stat. `created:` is left
    // undecided so the term evaluates to 'maybe' and the node survives to pass
    // two. Statting in pass one walked the WHOLE tree — inverting the design —
    // and then pass two re-statted every candidate, halving the cap and
    // returning a total of zero on a large scan.
    const verdict = evaluateMaybe(ast, { node, facts: {}, now }, home);
    if (verdict !== false && candidates.length < CANDIDATE_CAP) candidates.push(node);
    else if (verdict !== false) capped = true;

    if (isDir) {
      store.forEachChild(id, (child) => {
        stack.push({ id: child, path: store.childPath(child, nodePath), depth: depth + 1 });
      });
    }
  }

  /* ---- pass two: facts for the candidates only ---- */

  let factsByPath = new Map<string, EvalFacts>();
  if (needed.size > 0 && candidates.length > 0) {
    factsByPath = await fetchFacts(scanId, candidates.map((c) => c.path), needed, opts.signal, degraded);
  }

  const hits: QueryHit[] = [];
  for (const node of candidates) {
    if (opts.signal.aborted) { aborted = true; break; }
    const facts = factsByPath.get(node.path) ?? {};
    // The only place a stat happens: candidates, once each.
    if (wantsCreated) facts.createdMs = createdOf(node.path);
    if (!evaluate(ast, { node, facts, now }, home)) continue;
    hits.push({ path: node.path, name: node.name, size: node.size, isDir: node.isDir, mtimeMs: node.mtimeMs });
  }

  hits.sort(SORTERS[opts.sort]);
  const page = hits.slice(opts.offset, opts.offset + opts.limit);

  if (statsCapped > 0) {
    degraded.set('created', `Creation dates were read for ${statsSpent.toLocaleString()} items; ${statsCapped.toLocaleString()} more were skipped. No scan records creation times, so each one costs a separate read.`);
  }
  if (statsFailed > 0) {
    degraded.set('createdUnreadable', `${statsFailed.toLocaleString()} item${statsFailed === 1 ? '' : 's'} could not be read to find a creation date, so they are not in these results.`);
  }
  if (aborted) {
    // A half-finished walk must never be handed back as a confident total.
    degraded.set('cancelled', 'The search was stopped before it finished, so these results are incomplete.');
  }

  return {
    total: hits.length,
    truncated: aborted || capped || opts.offset + page.length < hits.length,
    hits: page,
    degraded: [...degraded].map(([provider, reason]) => ({ provider, reason })),
    examined,
  };
}

/** Does this AST reference `created:` anywhere? Decides whether stats are needed. */
function astUsesCreated(ast: Ast): boolean {
  switch (ast.kind) {
    case 'term': return ast.term.kind === 'date' && ast.term.field === 'created';
    case 'not': return astUsesCreated(ast.operand);
    case 'and':
    case 'or': return astUsesCreated(ast.left) || astUsesCreated(ast.right);
  }
}
