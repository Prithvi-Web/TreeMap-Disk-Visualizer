import fs from 'fs';
import { formatCount } from '../../utils/formatCount';
import os from 'os';
import { getScan } from '../diskScanner';
import { Flag, storeOf, type ScanStore } from '../scanStore';
import { computeFacts } from '../facts';
import { capabilityState } from '../../platform/capabilities';
import { evaluateMaybe, isEmptyQuery, type CloudState, type EvalFacts, type EvalNode } from './evaluate';
import { walkInSlices, type SliceOptions, type SlicedWalk } from '../slices';
import { factsNeeded } from './parse';
import type { Ast, Term } from './types';
import type { RecoverabilityFact } from '../recoverabilityTypes';
import type { LastUsedInfo } from '../../platform/types';
import type { ReclaimScoreFactValue } from '../facts';
import type { ScanResult } from '../../models/types';

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

/**
 * The fact providers pass two fetches file by file — the cost the cap above
 * bounds. Any other field the grammar has is answered from the tree itself.
 */
const FETCHED_PROVIDERS = new Set(['lastUsed', 'recoverability', 'reclaimScore']);

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
  /** How pass one's walk slices itself. Every field has a default; tests set them to count. */
  slices?: SliceOptions;
}

/* ------------------------------ fact plumbing ------------------------------ */

/** Map a recoverability fact onto the enum values the grammar exposes. */
export function gitStateOf(fact: RecoverabilityFact): 'pushed' | 'dirty' | 'none' | undefined {
  const git = fact.git;
  // A git call that failed leaves `git` null AND says so in `unavailable`:
  // unknown, as gitVerdict calls it — never "none", or `git:none` would match
  // files inside a repository nobody could read.
  if (!git && fact.unavailable.some((u) => u.signal === 'git')) return undefined;
  if (!git || !git.hasRemote) return 'none';
  if (git.fullyPushed && git.pathTracked) return 'pushed';
  return 'dirty';
}

export function cloudStateOf(fact: RecoverabilityFact): CloudState | null | undefined {
  const cloud = fact.cloud;
  // null is "outside every sync folder"; a client that could not be read, or
  // that calls the file's state unknown, is undefined: unknown, so neither
  // `cloud:local-only` nor `-cloud:local-only` matches it. One the platform
  // reads as here is 'resident': no placeholder, upload state unknown.
  if (!cloud) return fact.unavailable.some((u) => u.signal === 'cloud') ? undefined : null;
  switch (cloud.state) {
    case 'placeholder': return 'placeholder';
    case 'synced-local': return 'synced';
    case 'local-only': return 'local-only';
    default: return cloud.resident === true ? 'resident' : undefined;
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

  const providers = [...needed].filter((n) => FETCHED_PROVIDERS.has(n));
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
    // view would make this filter work, which it does not. "Neither" is now
    // true as well: `-dupe:yes` used to match every file.
    degraded.set('duplicates', 'TreeMap cannot filter by duplicates yet, so neither "dupe:" nor "-dupe:" matches any file. Use the Duplicates view for now.');
  }
  return degraded;
}

/**
 * Fields the grammar accepts that this build has no source for at all — on
 * any machine, for any file.
 *
 * Different in kind from a degraded provider, which some machines can answer.
 * Under three-valued logic a term on one of these fields is unknown for every
 * file, so it can never contribute a match: it sinks whatever it is ANDed
 * with, and beside an `or` it is dead weight. A query shown to a person says
 * so in `degraded`; an Autopilot policy reports no `degraded` on its runs, so
 * it refuses these at save time instead (autopilot.ts `normalizePolicy`).
 *
 * `used:never` is half of one: no reader records that a file was never
 * opened, so the term is unknown or false for every file and can never match
 * — while its negation, "has a last-opened date", is decided wherever one is
 * recorded. So it is refused only where it would have to be true.
 */
export interface Unanswerable {
  /** As a person would write it, quoted: `"dupe:"`. */
  named: string;
  /** Completes "uses <named>, which …". */
  which: string;
  instead: string;
  /** True when only a term that must be true is dead; its negation answers. */
  negationAnswers: boolean;
}

const UNANSWERABLE: Partial<Record<Term['kind'], Unanswerable>> = {
  dupe: {
    named: '"dupe:"',
    which: 'TreeMap cannot answer yet — it cannot tell which files are duplicates — so the condition never matches a file, and neither does its opposite',
    instead: 'Use the Duplicates view to clear duplicates by hand.',
    negationAnswers: false,
  },
  usedNever: {
    named: '"used:never"',
    which: 'nothing on this computer can confirm — a missing last-opened date means openings are not recorded, not that a file was never opened — so the condition never matches a file',
    instead: 'To find files not opened in a year, use "used>1y".',
    negationAnswers: true,
  },
};

/** The unanswerable fields a query uses where they would have to be true, each once, in the order they appear. */
export function unanswerableFields(ast: Ast): Unanswerable[] {
  const found = new Set<Unanswerable>();
  const walk = (node: Ast, negated: boolean): void => {
    switch (node.kind) {
      case 'term': {
        const entry = UNANSWERABLE[node.term.kind];
        if (entry && !(negated && entry.negationAnswers)) found.add(entry);
        return;
      }
      case 'not': walk(node.operand, !negated); return;
      case 'and':
      case 'or': walk(node.left, negated); walk(node.right, negated); return;
    }
  };
  walk(ast, false);
  return [...found];
}

/**
 * Is the whole query "has a last-opened date" and nothing else? Where access
 * times are kept that is nearly every file, so as a policy it is the "no
 * conditions" case, whatever it spells.
 */
export function isOnlyHasBeenOpened(ast: Ast): boolean {
  return ast.kind === 'not' && ast.operand.kind === 'term' && ast.operand.term.kind === 'usedNever';
}

/* ----------------------------- what empty: knows ----------------------------- */

/**
 * Why this scan cannot vouch that a folder it shows with no children is empty,
 * or null when it can (U-4b, the review of 5a0b905, M1). Every engine marks
 * the folders it knows it did not list in full (`Flag.Unlisted`); two cannot
 * name them all. gdu shows a folder it could not read as an empty one, and the
 * native engine counts the entries it could not look at without naming their
 * folders — and, on its memory path, the folders it could not read (a vanished
 * one is gone, and doubts nothing; the columns path marks each one, and says
 * so in `unreadableDirsNamed`) — so on those scans no childless folder is
 * known to be empty. The
 * walker marks the folder of every entry it could not look at, so its counts
 * are only a summary.
 */
export function childlessUnproven(scan: Pick<ScanResult, 'engine' | 'deniedEntries' | 'unreadableEntries' | 'unreadableDirs' | 'unreadableDirsNamed'>): string | null {
  const instead = 'Clean Up › Empty folders looks at each folder again on disk; an agent trashes these hits with onlyEmptyFolders: true, which does the same.';
  if (scan.engine === 'gdu-turbo') {
    return `This scan ran on gdu, which shows a folder it could not read as an empty one, so "empty:" cannot tell an empty folder from one it never read: folders with nothing listed in them are left undecided. ${instead}`;
  }
  // The columns path marks each folder it could not read (`unreadableDirsNamed`): those are decided by path (L-7).
  const unnamedDirs = scan.unreadableDirsNamed === true ? 0 : (scan.unreadableDirs ?? 0);
  const unnamed = scan.engine === 'native' ? (scan.deniedEntries ?? 0) + (scan.unreadableEntries ?? 0) + unnamedDirs : 0;
  if (unnamed > 0) {
    const one = unnamed === 1;
    return `This scan could not look at ${formatCount(unnamed)} item${one ? '' : 's'} inside the folders it listed, and does not record which folders, so "empty:" cannot tell an empty folder from one whose only ${one ? 'item' : 'items'} it could not see: folders with nothing listed in them are left undecided. ${instead}`;
  }
  return null;
}

/**
 * A folder's child count as `empty:` may read it, or undefined for unknown.
 * One listed child proves the folder is not empty, whatever else its listing
 * missed (L5); a folder with none is empty only when the tree holds its whole
 * listing (not `Flag.Unlisted`) and the scan can vouch for a childless folder.
 */
function knownChildCount(store: ScanStore, id: number, childlessKnown: boolean): number | undefined {
  if (!store.hasChildArray(id)) return undefined;
  const n = store.childCount(id);
  if (n > 0) return n;
  return childlessKnown && !store.flag(id, Flag.Unlisted) ? 0 : undefined;
}

/** Does this AST ask about `empty:` anywhere? */
function astUsesEmpty(ast: Ast): boolean {
  switch (ast.kind) {
    case 'term': return ast.term.kind === 'empty';
    case 'not': return astUsesEmpty(ast.operand);
    case 'and':
    case 'or': return astUsesEmpty(ast.left) || astUsesEmpty(ast.right);
  }
}

/* -------------------------------- execution -------------------------------- */

/**
 * The first `k` items of a stream in `cmp` order, never holding more than `k`.
 *
 * A heap with the kept item that sorts LAST at its root: a newcomer either
 * sorts before that one and takes its place, or is dropped. So a query can
 * count every match in a million-node scan and still keep only the page it
 * was asked for.
 */
function firstK<T>(k: number, cmp: (a: T, b: T) => number): { offer(item: T): void; sorted(): T[] } {
  const heap: T[] = [];
  const swap = (i: number, j: number): void => { const t = heap[i]; heap[i] = heap[j]; heap[j] = t; };
  const up = (i: number): void => {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (cmp(heap[i], heap[parent]) <= 0) return;
      swap(i, parent);
      i = parent;
    }
  };
  const down = (i: number): void => {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let last = i;
      if (l < heap.length && cmp(heap[l], heap[last]) > 0) last = l;
      if (r < heap.length && cmp(heap[r], heap[last]) > 0) last = r;
      if (last === i) return;
      swap(i, last);
      i = last;
    }
  };
  return {
    offer(item: T): void {
      if (k <= 0) return;
      if (heap.length < k) { heap.push(item); up(heap.length - 1); return; }
      if (cmp(item, heap[0]) >= 0) return;
      heap[0] = item;
      down(0);
    },
    sorted: (): T[] => [...heap].sort(cmp),
  };
}

/** What a sort reads: a hit, or a node the walk is still holding (QueryNode). */
type Sortable = Pick<QueryHit, 'path' | 'name' | 'size' | 'mtimeMs'>;

const SORTERS: Record<SortKey, (a: Sortable, b: Sortable) => number> = {
  // Ties broken by path so paging is stable — without it, two equal-sized
  // files can swap places between page 1 and page 2 and one is never seen.
  size: (a, b) => b.size - a.size || a.path.localeCompare(b.path),
  name: (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  modified: (a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path),
  path: (a, b) => a.path.localeCompare(b.path),
};

/** Nodes pass one walks between turns of the event loop. */
const QUERY_SLICE_NODES = 16_384;

/**
 * One node as the walk holds it: its numbers read when it is met, its name and
 * path when something reads them (design pass G07).
 *
 * The walk used to decode every name twice — once to build the node's path as
 * its folder pushed it, once more as it was judged — and to build a path for
 * every node, though only a path term, a fact lookup, a sort tie and the page's
 * hits read one. On a 304k-file scan that was most of the time a Highlight
 * query took. Each is read once at most, and a path is built from its folder's
 * (`childPath`, byte-exact on every store), so a folder's path is built once
 * for everything beneath it that needs one.
 */
class QueryNode implements EvalNode {
  readonly isDir: boolean;
  readonly size: number;
  readonly mtimeMs: number;
  // `childCount` is 0 both for a genuinely empty directory and for one whose
  // children were never listed (permission denied, excluded, pruned).
  // Conflating them would offer permission-denied folders up to an
  // `empty:yes` query — and those are exactly what gets bulk-trashed. A folder
  // whose listing the tree does not hold in full (Flag.Unlisted: refused,
  // unreadable, a mount not entered) can still carry an empty child array, so
  // it is unknown too — and so is every childless folder of a scan that cannot
  // name all such folders (`childlessUnproven`).
  readonly childCount: number | undefined;
  private nameRead: string | undefined;
  private pathRead: string | undefined;
  /** What this folder's children join their paths onto: made as they are pushed. */
  private within: FolderPath | null = null;

  constructor(
    private readonly store: ScanStore,
    readonly id: number,
    /**
     * The path of the folder this node is in, as its nodes join theirs onto
     * it — never the folder's node (CI4 review F1.2). A node waiting on the
     * walk's stack holds this; holding the folder's node instead held the
     * folder's own path, which a path term had read whole, so a file listed
     * before its subfolder kept that copy alive while the walk went down —
     * the square of the depth down a chain where every folder holds one.
     * Null for the root.
     */
    private readonly folder: FolderPath | null,
    readonly depth: number,
    childlessKnown: boolean,
    private readonly walk: WalkProgress,
  ) {
    this.isDir = store.isDir(id);
    this.size = store.size(id);
    this.mtimeMs = store.modifiedAt(id);
    this.childCount = this.isDir ? knownChildCount(store, id, childlessKnown) : undefined;
  }

  get name(): string {
    return (this.nameRead ??= this.store.name(this.id));
  }

  /**
   * Built from its folder's path, which is built down from the nearest
   * folder whose path is known, never by asking a folder's own getter: a
   * query that reads no path while it walks leaves every folder's unbuilt,
   * and a stack frame per level of a 30k-deep chain overflows (review F1.2;
   * the store's own rule, tests/packedStore.test.ts).
   *
   * While the walk runs, a folder's path and the one its children join onto
   * are two strings, though they spell the same path: whatever reads this one
   * copies it whole, and that copy must not be what the nodes waiting in the
   * folder hold. Once the walk is over nothing waits, and a folder's path is
   * the one its children join onto, so a folder among the hits shares one
   * string with the hits beneath it and each folder's path is still built
   * once for the page (G07 review F2.3, F3.1).
   */
  get path(): string {
    if (this.pathRead !== undefined) return this.pathRead;
    if (this.walk.over && this.within !== null) return (this.pathRead = this.within.path(this.store));
    return (this.pathRead = this.folder === null ? this.store.rootPath : this.store.childPath(this.id, this.folder.path(this.store)));
  }

  /** The folder its children's paths join onto — made once, as the walk pushes them. */
  folderForChildren(): FolderPath {
    return (this.within ??= this.folder === null
      ? new FolderPath(this.id, null, this.store.rootPath)
      : new FolderPath(this.id, this.folder, undefined));
  }
}

/** Shared by every node of one walk: whether it is over, so nothing waits on its stack any more. */
interface WalkProgress {
  over: boolean;
}

/**
 * A folder's path as the paths of the nodes in it are joined onto it (CI4
 * review F1.2). While the walk runs it is handed only to `childPath`, which
 * reads none of it, so it stays the pieces it was joined from — its folder's,
 * shared, and its own name with a separator — and a chain of them costs a few
 * bytes a folder however deep it goes. Nothing that reads a path is handed
 * it until the walk is over, because reading copies a path whole, and every
 * node waiting on the walk's stack holds its folder's: a folder's path read
 * whole there would stay whole as long as anything in that folder waited.
 */
class FolderPath {
  constructor(
    private readonly id: number,
    /** The folder this one is in, until this one's path is joined. */
    private folder: FolderPath | null,
    private joined: string | undefined,
  ) {}

  /** Joined down from the nearest folder whose path is, without a stack frame per folder (review F1.2). */
  path(store: ScanStore): string {
    if (this.joined !== undefined) return this.joined;
    const unjoined: FolderPath[] = [];
    let known: FolderPath = this;
    while (known.joined === undefined) {
      unjoined.push(known);
      known = known.folder as FolderPath; // the root's is joined from the start
    }
    let path = known.joined;
    for (let i = unjoined.length - 1; i >= 0; i--) {
      const folder = unjoined[i];
      path = folder.joined = store.childPath(folder.id, path);
      folder.folder = null;
    }
    return path;
  }
}

interface PassOneContext {
  ast: Ast;
  now: number;
  home: string;
  costly: boolean;
  asksEmpty: boolean;
  childlessKnown: boolean;
  signal: AbortSignal;
  keep: number;
  sort: (a: Sortable, b: Sortable) => number;
}

/**
 * Pass one: every node judged with no facts, as a walk that can stop between
 * any two nodes (walkInSlices). Whatever it gathers belongs to one attempt; a
 * tree that changed under it is walked again by a new one.
 */
class PassOneWalk implements SlicedWalk {
  matched = 0;
  undecided = 0;
  childlessUndecided = 0;
  examined = 0;
  capped = false;
  aborted = false;
  readonly candidates: QueryNode[] = [];
  readonly doubted = new WeakSet<EvalNode>();
  readonly kept: { offer(item: QueryNode): void; sorted(): QueryNode[] };
  private readonly stack: QueryNode[];
  private readonly progress: WalkProgress = { over: false };

  constructor(private readonly store: ScanStore, private readonly ctx: PassOneContext) {
    this.kept = firstK<QueryNode>(ctx.keep, ctx.sort);
    this.stack = [new QueryNode(store, store.rootId, null, 0, ctx.childlessKnown, this.progress)];
  }

  step(budget: number): boolean {
    const { store, stack, ctx, progress } = this;
    for (let left = budget; stack.length > 0; left--) {
      if (left <= 0) return false;
      if (ctx.signal.aborted) { this.aborted = true; return true; }
      const node = stack.pop() as QueryNode;
      this.examined++;
      if (ctx.asksEmpty && node.isDir && store.hasChildArray(node.id) && store.childCount(node.id) === 0) this.doubted.add(node);

      // Deliberately NO facts here, and deliberately no stat. `created:` is left
      // undecided so the term evaluates to 'maybe' and the node survives to pass
      // two. Statting in pass one walked the WHOLE tree — inverting the design —
      // and then pass two re-statted every candidate, halving the cap and
      // returning a total of zero on a large scan.
      const verdict = evaluateMaybe(ctx.ast, { node, facts: {}, now: ctx.now }, ctx.home);
      if (!ctx.costly) {
        if (verdict === true) { this.matched++; this.kept.offer(node); }
        else if (verdict === 'maybe') {
          this.undecided++;
          if (this.doubted.has(node)) this.childlessUndecided++;
        }
      } else if (verdict !== false && this.candidates.length < CANDIDATE_CAP) this.candidates.push(node);
      else if (verdict !== false) this.capped = true;

      if (node.isDir) {
        const depth = node.depth + 1;
        store.forEachChild(node.id, (child) => {
          stack.push(new QueryNode(store, child, node.folderForChildren(), depth, ctx.childlessKnown, progress));
        });
      }
    }
    return true;
  }

  /** Called once the walk is over, finished or stopped: nothing waits on its stack any more. */
  end(): void {
    this.progress.over = true;
  }
}

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
  if (unanswerableFields(ast).some((u) => u === UNANSWERABLE.usedNever)) {
    degraded.set('usedNever', 'Nothing on this computer records that a file was never opened — a missing last-opened date means openings are not recorded there — so "used:never" matches no file. "-used:never" matches files that have a last-opened date, and "used>1y" finds files not opened in a year.');
  }

  // An empty box means "no filter", not "match nothing" — the original parser
  // reports the empty query as matching nothing, which is right for a
  // highlight overlay and wrong for a filter.
  if (isEmptyQuery(ast)) {
    return { total: 0, truncated: false, hits: [], degraded: [...degraded].map(([provider, reason]) => ({ provider, reason })), examined: 0 };
  }

  const wantsCreated = astUsesCreated(ast);
  const childlessDoubt = childlessUnproven(scan);
  // Said only when it applies: the query asks about empty:, and a childless folder it cannot vouch
  // for was left undecided — not merely met: one another term decides (size>1gb) is no doubt (L-4).
  const asksEmpty = childlessDoubt !== null && astUsesEmpty(ast);
  // Pass two costs something only when the query needs a fact fetched, or a
  // creation date statted, file by file. Otherwise every pass-one verdict is
  // already final: the walk counts every match exactly and keeps only the page
  // asked for, with no cap — so the first 20,000 the walk happened to meet are
  // never passed off as the total, or as "the biggest" (D31).
  const costly = wantsCreated || [...needed].some((n) => FETCHED_PROVIDERS.has(n));
  const hitOf = (n: EvalNode): QueryHit => ({ path: n.path, name: n.name, size: n.size, isDir: n.isDir, mtimeMs: n.mtimeMs });
  let statsSpent = 0;
  let statsCapped = 0;
  let statsFailed = 0;
  // Set when the last createdOf call could not read a date (capped or
  // failed): that file is already counted in `created`/`createdUnreadable`.
  let statGap = false;
  const createdOf = (p: string): number | null => {
    statGap = false;
    if (statsSpent >= STAT_CAP) { statsCapped++; statGap = true; return null; }
    statsSpent++;
    try {
      const st = fs.statSync(p);
      // birthtimeMs is 0 on filesystems that do not record a creation time.
      return st.birthtimeMs > 0 ? st.birthtimeMs : null;
    } catch {
      // Unreadable — a permission the process lacks. Counted, and reported, so
      // it does not become a silent "this file does not match your query".
      statsFailed++;
      statGap = true;
      return null;
    }
  };

  /* ---- pass one: everything not definitely false, facts unknown ---- */

  // In slices, under the store's version guard (Track U, U-D9): the event loop
  // gets a turn between slices, so a request whose person has typed on can
  // close and stop this walk, and a tree changed during a turn (a delete, the
  // watcher) is walked again from the start rather than half old, half new.
  const { walk: pass } = await walkInSlices(
    store,
    () => new PassOneWalk(store, {
      ast, now, home, costly, asksEmpty, signal: opts.signal,
      childlessKnown: childlessDoubt === null,
      keep: opts.offset + opts.limit, sort: SORTERS[opts.sort],
    }),
    opts.slices ?? {},
    QUERY_SLICE_NODES,
  );
  pass.end();
  const { candidates, kept, doubted, examined, capped } = pass;
  let { matched, undecided, childlessUndecided, aborted } = pass;

  /* ---- pass two: facts for the candidates only ---- */

  let factsByPath = new Map<string, EvalFacts>();
  if (needed.size > 0 && candidates.length > 0) {
    factsByPath = await fetchFacts(scanId, candidates.map((c) => c.path), needed, opts.signal, degraded);
  }

  for (const node of candidates) {
    if (opts.signal.aborted) { aborted = true; break; }
    const facts = factsByPath.get(node.path) ?? {};
    // The only place a stat happens: candidates, once each.
    statGap = false;
    if (wantsCreated) facts.createdMs = createdOf(node.path);
    // Still three-valued: a fact the lookup could not supply is unknown, and
    // unknown is not a match — under `-` too, or `-dupe:yes` is every file.
    // Counted, so "could not tell" is never read as "did not match" — once:
    // a date the stat could not read is already counted with its reason.
    const verdict = evaluateMaybe(ast, { node, facts, now }, home);
    if (verdict === 'maybe' && !statGap) undecided++;
    if (verdict === 'maybe' && doubted.has(node)) childlessUndecided++;
    if (verdict !== true) continue;
    matched++;
    kept.offer(node);
  }

  // Names and paths are read here, for the page, as the hits are made.
  const page = kept.sorted().slice(opts.offset).map(hitOf);

  if (statsCapped > 0) {
    degraded.set('created', `Creation dates were read for ${formatCount(statsSpent)} items; ${formatCount(statsCapped)} more were skipped. No scan records creation times, so each one costs a separate read.`);
  }
  if (statsFailed > 0) {
    degraded.set('createdUnreadable', `${formatCount(statsFailed)} item${statsFailed === 1 ? '' : 's'} could not be read to find a creation date, so ${statsFailed === 1 ? 'it is' : 'they are'} not in these results.`);
  }
  if (capped) {
    degraded.set('capped', `This query needs facts TreeMap looks up file by file, so it checked only the first ${formatCount(CANDIDATE_CAP)} possible matches it came to, in folder order. There may be more matches than the ${formatCount(matched)} counted here, and "biggest" means the biggest of those.`);
  }
  if (asksEmpty && childlessUndecided > 0 && childlessDoubt !== null) degraded.set('emptyUnproven', childlessDoubt);
  if (undecided > 0) {
    const one = undecided === 1;
    // Past the cap, only the candidates kept were judged: a floor, said as one.
    degraded.set('undecided', `${capped ? 'At least ' : ''}${formatCount(undecided)} item${one ? '' : 's'} could not be decided — a fact this query needs was not available for ${one ? 'it' : 'them'} — so ${one ? 'it is' : 'they are'} not in these results.`);
  }
  if (aborted) {
    // A half-finished walk must never be handed back as a confident total.
    degraded.set('cancelled', 'The search was stopped before it finished, so these results are incomplete.');
  }

  return {
    total: matched,
    truncated: aborted || capped || opts.offset + page.length < matched,
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
