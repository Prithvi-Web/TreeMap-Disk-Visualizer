import { escapeLike } from '../../utils/searchQuery';
import type { Ast, CompareOp, Term } from './types';

/**
 * AST → parameterised SQL for the live index (v4 §2.2).
 *
 * ── The correctness rule, and why it is not obvious ──
 *
 * Only some fields exist as columns. The index stores `name`, `ext`, `is_dir`,
 * `size` and `mtime`; it does **not** store a path (dropped in schema v3 and
 * rebuilt on read), a depth, a creation time, or any v4 fact. So most queries
 * are part SQL and part post-filter, and the SQL half must be a **sound
 * over-approximation**: it may return rows the query does not want, never
 * fewer. The post-filter then removes the extras.
 *
 * That constraint is what makes the algebra below non-trivial:
 *
 *  - **AND** — dropping an unpushable conjunct *widens* the result, which is
 *    safe. `size>1gb depth<=3` pushes `size>1gb` and post-filters the depth.
 *  - **OR** — dropping either branch *narrows* the result, which would lose
 *    real matches. So an OR is pushed only when **both** sides are pushable,
 *    and otherwise the whole OR is post-filtered.
 *  - **NOT** — negating an over-approximation is unsound: `NOT(widened)` is
 *    *narrower* than `NOT(exact)`, so it drops rows that should match. A NOT
 *    is pushed only when its operand is exactly expressible.
 *
 * Every pushed expression therefore carries an `exact` flag, and the three
 * rules above consume it. Getting this wrong does not produce an error — it
 * produces silently missing search results, which is the failure this file
 * exists to prevent.
 *
 * ── Injection ──
 *
 * **Nothing user-supplied is ever concatenated into SQL.** Every value is a
 * bound `?`. The `switch` over term kinds is exhaustive over the `Term` union,
 * so a field added to the grammar without a decision about its SQL mapping is
 * a **compile error**, not an injection and not a silently-wrong result.
 */

/** Columns the index actually has. Everything else is post-filtered. */
export const SQL_PUSHABLE_FIELDS = ['size', 'ext', 'name', 'type', 'modified', 'bare'] as const;

/**
 * Fields evaluated after the SQL, with the reason each cannot be pushed.
 *
 * Surfaced to the caller so `POST /api/query` can report `postFiltered` rather
 * than quietly being slower than it looks.
 */
export const POST_FILTER_REASONS: Record<string, string> = {
  name: 'the search text is not plain ASCII, and SQL text matching folds only ASCII letters',
  modified: 'an exact age is a moving target, so it is compared after the query',
  path: 'the index does not store paths — it rebuilds them on read',
  in: 'the index does not store paths — it rebuilds them on read',
  depth: 'the index does not store depth',
  created: 'no scan records a creation time, so it is read with a stat',
  used: 'last-opened dates come from the fact layer, not the index',
  elsewhere: 'recoverability comes from the fact layer, not the index',
  git: 'recoverability comes from the fact layer, not the index',
  backup: 'recoverability comes from the fact layer, not the index',
  cloud: 'recoverability comes from the fact layer, not the index',
  score: 'the reclaim score comes from the fact layer, not the index',
  dupe: 'duplicate detection is a separate background job',
  empty: 'the index does not store child counts',
};

export interface SqlFragment {
  sql: string;
  params: (string | number)[];
  /**
   * True when this fragment matches exactly the rows the AST wants. False when
   * it is a widened superset that the post-filter must narrow.
   */
  exact: boolean;
}

export interface SqlPlan {
  /** A WHERE fragment, or null when nothing at all could be pushed. */
  where: SqlFragment | null;
  /** Field names that will be evaluated after the query, deduplicated. */
  postFiltered: string[];
}

const SQL_OP: Record<CompareOp, string> = { '>': '>', '<': '<', '>=': '>=', '<=': '<=', '=': '=' };

/**
 * Can SQLite's `LIKE` be trusted to fold this needle the way JavaScript does?
 *
 * **No, for anything non-ASCII** — and this is a soundness bug, not a nicety.
 * SQLite's `LIKE` and its `COLLATE NOCASE` fold ASCII only, while JavaScript's
 * `toLowerCase()` folds Unicode. Measured against real SQLite: `name:ñoño`
 * returned nothing from SQL while the evaluator matched `ÑOÑO.jpg`, and
 * `name:café` missed `CAFÉ.txt`.
 *
 * That is a strict SUBSET, which the post-filter cannot repair — the row was
 * already gone. So a non-ASCII needle is not pushed at all and is evaluated in
 * full instead: slower, and correct.
 */
function likeIsFaithful(needle: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[^\x00-\x7f]/.test(needle);
}

/* ------------------------------ per-term SQL ------------------------------ */

/**
 * SQL for one term, or null when the index cannot express it.
 *
 * The `switch` is exhaustive over `Term`; the `never` check at the end is what
 * turns "someone added a field and forgot about SQL" into a compile error.
 */
function termToSql(term: Term, unpushable: Set<string>, now: number): SqlFragment | null {
  switch (term.kind) {
    case 'size':
      return { sql: `n.size ${SQL_OP[term.op]} ?`, params: [term.bytes], exact: true };

    case 'ext': {
      // Stored lower-cased without the dot, so this is an index seek.
      const placeholders = term.values.map(() => '?').join(',');
      return { sql: `(n.ext IN (${placeholders}) AND n.is_dir = 0)`, params: [...term.values], exact: true };
    }

    case 'name':
      if (!likeIsFaithful(term.needle)) { unpushable.add('name'); return null; }
      return {
        sql: "n.name LIKE ? ESCAPE '\\'",
        params: ['%' + escapeLike(term.needle) + '%'],
        exact: true,
      };

    case 'type':
      return { sql: `n.is_dir = ${term.value === 'dir' ? 1 : 0}`, params: [], exact: true };

    case 'date':
      if (term.field !== 'modified') { unpushable.add(term.field); return null; }
      // An age comparison flips: "older than 90 days" is mtime <= now - 90d.
      // The operator inversion is why this is not a shared code path with the
      // absolute case, and why both directions are tested.
      if (term.mode === 'absolute') {
        // Equality means the whole day, matching the evaluator. If only one of
        // the two engines desugars it, they disagree on every `modified:DATE`.
        if (term.op === '=') {
          return { sql: '(n.mtime >= ? AND n.mtime < ?)', params: [term.value, term.value + 86_400_000], exact: true };
        }
        return { sql: `n.mtime ${SQL_OP[term.op]} ?`, params: [term.value], exact: true };
      }
      // `now` is a PARAMETER, not `Date.now()` read here.
      //
      // Reading the clock inside the planner made the SQL half and the
      // post-filter half evaluate against two different instants — a real bug
      // caught by the superset test, which compares the two directly. In
      // production the gap is milliseconds and mostly harmless; at an age
      // boundary it is a row that SQL excludes and the evaluator would have
      // kept, which is precisely the silent-missing-result failure this
      // planner is written to avoid.
      switch (term.op) {
        case '>': return { sql: 'n.mtime < ?', params: [now - term.value], exact: true };
        case '>=': return { sql: 'n.mtime <= ?', params: [now - term.value], exact: true };
        case '<': return { sql: 'n.mtime > ?', params: [now - term.value], exact: true };
        case '<=': return { sql: 'n.mtime >= ?', params: [now - term.value], exact: true };
        case '=': unpushable.add('modified'); return null; // an exact age is a moving target
      }
      return null;

    case 'bare': {
      // The legacy three rules, mapped onto the same columns searchIndex uses.
      switch (term.query.kind) {
        case 'empty': return null;
        case 'extension':
          return { sql: '(n.ext = ? AND n.is_dir = 0)', params: [term.query.extension], exact: true };
        case 'substring':
          if (!likeIsFaithful(term.query.needle)) { unpushable.add('name'); return null; }
          return { sql: "n.name LIKE ? ESCAPE '\\'", params: ['%' + escapeLike(term.query.needle) + '%'], exact: true };
      }
      return null;
    }

    case 'path': unpushable.add('path'); return null;
    case 'in': unpushable.add('in'); return null;
    case 'depth': unpushable.add('depth'); return null;
    case 'empty': unpushable.add('empty'); return null;
    case 'usedNever': unpushable.add('used'); return null;
    case 'elsewhere': unpushable.add('elsewhere'); return null;
    case 'git': unpushable.add('git'); return null;
    case 'backup': unpushable.add('backup'); return null;
    case 'cloud': unpushable.add('cloud'); return null;
    case 'score': unpushable.add('score'); return null;
    case 'dupe': unpushable.add('dupe'); return null;

    default: {
      // Exhaustiveness guard: adding a Term variant without handling it here
      // fails to compile rather than silently becoming un-pushable.
      const never: never = term;
      void never;
      return null;
    }
  }
}

/* -------------------------------- the walk -------------------------------- */

function walk(ast: Ast, unpushable: Set<string>, now: number): SqlFragment | null {
  switch (ast.kind) {
    case 'term':
      return termToSql(ast.term, unpushable, now);

    case 'and': {
      const left = walk(ast.left, unpushable, now);
      const right = walk(ast.right, unpushable, now);
      // Dropping a conjunct widens, which is safe — but the result is then no
      // longer exact, and a NOT above must not push it.
      if (left && right) {
        return {
          sql: `(${left.sql} AND ${right.sql})`,
          params: [...left.params, ...right.params],
          exact: left.exact && right.exact,
        };
      }
      if (left) return { ...left, exact: false };
      if (right) return { ...right, exact: false };
      return null;
    }

    case 'or': {
      const left = walk(ast.left, unpushable, now);
      const right = walk(ast.right, unpushable, now);
      // Both or neither. Keeping one branch of an OR would NARROW the result
      // and silently lose rows the user asked for.
      if (!left || !right) return null;
      return {
        sql: `(${left.sql} OR ${right.sql})`,
        params: [...left.params, ...right.params],
        exact: left.exact && right.exact,
      };
    }

    case 'not': {
      const operand = walk(ast.operand, unpushable, now);
      // Negating a widened set gives a narrower one — rows that should match
      // would vanish. Only an exact operand may be negated in SQL.
      if (!operand || !operand.exact) return null;
      return { sql: `NOT (${operand.sql})`, params: operand.params, exact: true };
    }
  }
}

/**
 * Plan the SQL half of a query.
 *
 * `where` is a superset filter (or null); `postFiltered` names every field the
 * evaluator must still check, so the response can say so rather than leaving
 * the caller to wonder why a query was slow.
 */
export function toSql(ast: Ast, now: number = Date.now()): SqlPlan {
  const unpushable = new Set<string>();
  const where = walk(ast, unpushable, now);
  return { where, postFiltered: [...unpushable].sort() };
}
