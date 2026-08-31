import { matches as bareMatches } from '../../utils/searchQuery';
import type { Ast, CompareOp, Term } from './types';

/**
 * The query evaluator (v4 §2.2).
 *
 * One predicate, three consumers: in-memory filtering over a scan store, the
 * post-filter over index rows that SQL could not express, and the frontend's
 * highlight box by way of `POST /api/query`. Writing it once is the whole
 * point — §7 forbids a second query language, and three evaluators that agree
 * today would disagree within a release.
 *
 * ── Absent is not false ──
 *
 * In the final answer, a term whose fact this machine cannot supply evaluates
 * to **false** — and the executor separately reports that provider as
 * degraded. Both halves are required by §2.2: a `backup:yes` query on a
 * machine with no backups must return an empty list *with a visible warning*,
 * not an empty list that reads as "nothing matched".
 *
 * But "not fetched yet" is a third state, and conflating it with false would
 * be a silent wrong answer rather than a slow one. `evaluateMaybe` at the
 * bottom of this file handles that with Kleene logic, which is what lets the
 * executor narrow to candidates first and pay for facts only on those.
 */

/** One node, as the evaluator sees it. */
export interface EvalNode {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  mtimeMs: number;
  /** Depth below the scan root; the root itself is 0. */
  depth: number;
  /** Live child count. Only needed by `empty:`; undefined means unknown. */
  childCount?: number;
}

export type GitState = 'pushed' | 'dirty' | 'none';
export type BackupState = 'yes' | 'no' | 'unknown';
export type CloudState = 'placeholder' | 'synced' | 'local-only';

/**
 * Facts for one node.
 *
 * `undefined` and `null` mean different things and the distinction is load
 * bearing: `undefined` is "not fetched", `null` is "fetched, and genuinely
 * unknown". `used:never` matches the second and not the first.
 */
export interface EvalFacts {
  lastUsedMs?: number | null;
  elsewhere?: 'proven' | 'likely' | 'none' | 'unknown';
  git?: GitState;
  backup?: BackupState;
  cloud?: CloudState | null;
  score?: number;
  dupe?: boolean;
  /**
   * Creation time, resolved lazily.
   *
   * Separate from the rest because **no scan records it**: neither `RawEntry`,
   * nor the packed store, nor the index has a creation-time column, so a
   * `created:` term costs one `stat` per node it actually reaches. The
   * executor supplies this as a bounded, counted callback so the cost is
   * visible and reportable rather than silent.
   */
  createdMs?: number | null;
}

export interface EvalContext {
  node: EvalNode;
  facts: EvalFacts;
  /** Evaluation time, passed in so a query is deterministic within one run. */
  now: number;
}

/* -------------------------------- helpers -------------------------------- */

function compare(actual: number, op: CompareOp, expected: number): boolean {
  switch (op) {
    case '>': return actual > expected;
    case '<': return actual < expected;
    case '>=': return actual >= expected;
    case '<=': return actual <= expected;
    case '=': return actual === expected;
  }
}

/** The extension rule, matching the scanner: not the first dot, not the last. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot >= name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Is `p` inside `prefix`?
 *
 * Two readings, chosen by whether the prefix looks like a path:
 *
 *  - **A path** (`~/Downloads`, `/Users/me/Docs`, `C:\\Users`) matches that
 *    exact subtree. `~` expands, because that is how people write it.
 *  - **A bare name** (`node_modules`, `Downloads`) matches wherever a folder
 *    of that name appears. This is the reading §2.1's own example needs:
 *    `-in:node_modules` means "not under any node_modules", not "not under a
 *    top-level folder literally called /node_modules", which would match
 *    nothing and silently make the exclusion a no-op.
 *
 * Both are anchored at separators, so `in:/Users/me/Doc` does not swallow
 * `/Users/me/Documents-old`, and a bare `in:src` does not match `src-old`.
 */
export function isInsidePrefix(p: string, prefix: string, home: string): boolean {
  const raw = prefix.replace(/[\\/]+$/, '');
  if (raw.length === 0) return true;

  const lowerPath = p.toLowerCase();
  const looksLikeAPath = /[\\/]/.test(raw) || raw.startsWith('~') || /^[a-zA-Z]:$/.test(raw);

  if (!looksLikeAPath) {
    // A bare folder name: match it as a whole path component, so `src` does
    // not also match `src-old` or `mysrc`.
    const needle = raw.toLowerCase();
    for (const segment of lowerPath.split(/[\\/]/)) {
      if (segment === needle) return true;
    }
    return false;
  }

  const target = (raw.startsWith('~') ? home + raw.slice(1) : raw).replace(/[\\/]+$/, '');
  const lowerTarget = target.toLowerCase();
  if (lowerPath === lowerTarget) return true;
  return lowerPath.startsWith(lowerTarget + '/') || lowerPath.startsWith(lowerTarget + '\\');
}

/**
 * Compare a timestamp against a date term.
 *
 * The asymmetry that must not be got backwards:
 *
 *  - **absolute** compares the timestamp, so `modified<2023-01-01` is "before
 *    that date".
 *  - **age** compares `now - timestamp`, so `modified>90d` is "older than
 *    90 days".
 *
 * Both read as "older" to a person, even though the operator flips. Getting
 * this wrong returns the exact complement of what was asked, which is the
 * worst failure mode a query language has — so it is asserted in both
 * directions in `tests/queryParse.test.ts`.
 */
export function matchesDate(
  timestampMs: number | null | undefined,
  mode: 'absolute' | 'age',
  op: CompareOp,
  value: number,
  now: number,
): boolean {
  if (timestampMs === null || timestampMs === undefined) return false;
  if (mode === 'absolute') {
    // `modified:2023-01-01` means "on that day", not "at that exact
    // millisecond". Literal equality is technically defensible and practically
    // useless: it silently matches nothing, which looks identical to a folder
    // with nothing in it. The day's end is the NEXT LOCAL MIDNIGHT, not
    // value + 24h — DST makes two local days a year 23 or 25 hours long, and
    // a fixed window would drop the 25-hour day's last hour and steal the
    // 23-hour day's next morning (v4 §7.2's calendar buckets true local days
    // and hands its clicks to this operator; the two must agree).
    if (op === '=') {
      const d = new Date(value);
      const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      return timestampMs >= value && timestampMs < nextMidnight;
    }
    return compare(timestampMs, op, value);
  }
  return compare(now - timestampMs, op, value);
}

/** One day, for the "a date means the whole day" rule above. */
export const DAY_MS = 86_400_000;

/* ------------------------------ term matching ------------------------------ */

export function matchTerm(term: Term, ctx: EvalContext, home: string): boolean {
  const { node, facts, now } = ctx;

  switch (term.kind) {
    case 'bare':
      // The zero-token case, handed straight to the original implementation so
      // `*.zip` cannot drift from what it has always meant.
      return bareMatches(term.query, node.name, node.isDir);

    case 'size': return compare(node.size, term.op, term.bytes);
    case 'ext': return !node.isDir && term.values.includes(extensionOf(node.name));
    case 'name': return node.name.toLowerCase().includes(term.needle);
    case 'path': return node.path.toLowerCase().includes(term.needle);
    case 'in': return isInsidePrefix(node.path, term.prefix, home);
    case 'type': return term.value === (node.isDir ? 'dir' : 'file');
    case 'depth': return compare(node.depth, term.op, term.value);

    case 'empty': {
      // Only a directory can be empty: a zero-byte FILE is not an empty folder.
      if (!node.isDir) return false;
      // An unknown child count answers NEITHER way. Returning true for
      // `empty:no` was the bug — it asserted "this folder has contents" about
      // a directory nobody managed to list, and the mirror case would have
      // offered a permission-denied folder up as empty.
      if (node.childCount === undefined) return false;
      return (node.childCount === 0) === term.value;
    }

    case 'date': {
      const stamp = term.field === 'modified' ? node.mtimeMs
        : term.field === 'used' ? facts.lastUsedMs
        : facts.createdMs;
      return matchesDate(stamp, term.mode, term.op, term.value, now);
    }

    case 'usedNever':
      // Fetched and genuinely unknown. `undefined` — never fetched — is not a
      // match: we do not know that it was never opened, only that we did not ask.
      return facts.lastUsedMs === null;

    case 'elsewhere': return facts.elsewhere !== undefined && term.values.includes(facts.elsewhere);
    case 'git': return facts.git !== undefined && term.values.includes(facts.git);
    case 'backup': return facts.backup !== undefined && term.values.includes(facts.backup);
    case 'cloud': return facts.cloud !== undefined && facts.cloud !== null && term.values.includes(facts.cloud);
    case 'score': return facts.score !== undefined && compare(facts.score, term.op, term.value);
    case 'dupe': return facts.dupe !== undefined && facts.dupe === term.value;
  }
}

/** Evaluate a whole AST against one node. */
export function evaluate(ast: Ast, ctx: EvalContext, home: string): boolean {
  switch (ast.kind) {
    case 'term': return matchTerm(ast.term, ctx, home);
    case 'not': return !evaluate(ast.operand, ctx, home);
    case 'and': return evaluate(ast.left, ctx, home) && evaluate(ast.right, ctx, home);
    case 'or': return evaluate(ast.left, ctx, home) || evaluate(ast.right, ctx, home);
  }
}

/**
 * Is this the empty query?
 *
 * An empty box means "no filter", not "match nothing" — and the original
 * parser reports the empty query as matching nothing, which is right for a
 * *highlight* box and wrong for a *filter*. The executor checks this before
 * evaluating rather than making `matches()` behave two ways.
 */
export function isEmptyQuery(ast: Ast): boolean {
  return ast.kind === 'term' && ast.term.kind === 'bare' && ast.term.raw.trim() === '';
}

/* --------------------------- three-valued evaluation --------------------------- */

/** Kleene truth: a fact that has not been fetched yet is `'maybe'`, not false. */
export type Maybe = true | false | 'maybe';

/**
 * Can this term be decided right now, with what the context holds?
 *
 * Takes the whole context rather than only the facts, because `empty:` depends
 * on the **node's** child count and that can be unknown too — a directory the
 * walker could not list has no count, and treating that as "not empty" made
 * `evaluateMaybe` return a definite false for rows the full evaluation would
 * have matched. That is the one thing the two-pass executor cannot survive.
 *
 * `createdMs` is here because it costs a `stat` — no scan records a creation
 * time — so it is resolved for candidates rather than for the whole tree.
 */
function termDecidable(term: Term, ctx: EvalContext): boolean {
  switch (term.kind) {
    case 'usedNever': return ctx.facts.lastUsedMs !== undefined;
    case 'date':
      if (term.field === 'modified') return true;
      return term.field === 'used' ? ctx.facts.lastUsedMs !== undefined : ctx.facts.createdMs !== undefined;
    case 'elsewhere': return ctx.facts.elsewhere !== undefined;
    case 'git': return ctx.facts.git !== undefined;
    case 'backup': return ctx.facts.backup !== undefined;
    case 'cloud': return ctx.facts.cloud !== undefined;
    case 'score': return ctx.facts.score !== undefined;
    case 'dupe': return ctx.facts.dupe !== undefined;
    // A non-directory is decidable (never empty); a directory needs its count.
    case 'empty': return !ctx.node.isDir || ctx.node.childCount !== undefined;
    default: return true;
  }
}

/**
 * Evaluate with unknown facts as `'maybe'`.
 *
 * This is what makes a two-pass executor possible, and correct. Pass one runs
 * with no facts at all and keeps everything that is not definitely false; only
 * those candidates pay for a fact lookup; pass two evaluates them properly.
 *
 * The alternative — running the ordinary evaluator with facts absent — would
 * read every unfetched fact as false and discard the very rows the query is
 * about, which is a silent wrong answer rather than a slow one.
 *
 * Kleene's rules, and each matters here:
 *   AND  false if either is false, true only if both are true
 *   OR   true if either is true, false only if both are false
 *   NOT  flips true/false, and leaves maybe alone
 */
export function evaluateMaybe(ast: Ast, ctx: EvalContext, home: string): Maybe {
  switch (ast.kind) {
    case 'term':
      if (!termDecidable(ast.term, ctx)) return 'maybe';
      return matchTerm(ast.term, ctx, home);

    case 'not': {
      const inner = evaluateMaybe(ast.operand, ctx, home);
      return inner === 'maybe' ? 'maybe' : !inner;
    }

    case 'and': {
      const left = evaluateMaybe(ast.left, ctx, home);
      if (left === false) return false;
      const right = evaluateMaybe(ast.right, ctx, home);
      if (right === false) return false;
      return left === true && right === true ? true : 'maybe';
    }

    case 'or': {
      const left = evaluateMaybe(ast.left, ctx, home);
      if (left === true) return true;
      const right = evaluateMaybe(ast.right, ctx, home);
      if (right === true) return true;
      return left === false && right === false ? false : 'maybe';
    }
  }
}
