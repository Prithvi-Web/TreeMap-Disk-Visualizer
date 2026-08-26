import type { ParsedQuery } from '../../utils/searchQuery';

/**
 * The query grammar's shapes (v4 §2).
 *
 * Why this is the highest-leverage feature in v4: every one of the fifteen
 * existing views is a hard-coded filter over the same tree. Given a real
 * grammar, a view becomes a saved query, a saved query becomes a Clean Up
 * rule, and a Clean Up rule becomes an Autopilot policy — with almost no new
 * plumbing. Fifteen views becomes an unbounded number.
 *
 * Two constraints shape everything here:
 *
 *  - **The zero-token case is the old parser, not a reimplementation of it.**
 *    A bare word carries `ParsedQuery` from `utils/searchQuery.ts` verbatim, so
 *    `*.zip` means exactly what it has always meant and the existing test that
 *    asserts frontend/backend agreement keeps passing unmodified. §7 forbids a
 *    second query language; this is how that is enforced rather than promised.
 *  - **Parsing is total.** `parse()` returns an AST or a structured error. It
 *    never throws, because it runs on every keystroke behind a 150 ms debounce
 *    and a thrown exception there is a broken search box.
 */

/* ------------------------------- operators ------------------------------- */

export type CompareOp = '>' | '<' | '>=' | '<=' | '=';

/* --------------------------------- terms --------------------------------- */

/**
 * A bare word — today's three rules, unchanged: `*.zip` and `.zip` are
 * extension matches, anything else is a case-insensitive substring of the
 * basename.
 */
export interface BareTerm {
  kind: 'bare';
  /** The raw text, kept for error spans and for rendering the term back. */
  raw: string;
  /** Parsed by utils/searchQuery.ts — the single implementation of this rule. */
  query: ParsedQuery;
}

export interface SizeTerm { kind: 'size'; op: CompareOp; bytes: number }
export interface ExtTerm { kind: 'ext'; values: string[] }
/** Case-insensitive substring of the basename. */
export interface NameTerm { kind: 'name'; needle: string }
/** Case-insensitive substring of the whole path. */
export interface PathTerm { kind: 'path'; needle: string }
/** Subtree containment — the common case, and not the same as `path:`. */
export interface InTerm { kind: 'in'; prefix: string }

export type DateField = 'modified' | 'created' | 'used';

/**
 * A date comparison, in one of two modes that read the same way to a user but
 * compare different things:
 *
 *  - `absolute` — `modified<2023-01-01` compares the **timestamp**, so `<`
 *    means "before that date".
 *  - `age` — `modified>90d` compares the **age**, so `>` means "older than
 *    90 days".
 *
 * Both spellings of "older" therefore work the way people reach for them, even
 * though the comparison flips. That asymmetry is deliberate and is spelled out
 * in the help text; getting it backwards would silently return the complement
 * of what was asked, which is the worst failure a query language can have.
 */
export interface DateTerm {
  kind: 'date';
  field: DateField;
  mode: 'absolute' | 'age';
  op: CompareOp;
  /** Epoch ms for `absolute`; a duration in ms for `age`. */
  value: number;
  /** The text the user typed, for the explain view and error spans. */
  raw: string;
}

/** `used:never` — no last-opened date exists at all. */
export interface UsedNeverTerm { kind: 'usedNever' }

export interface TypeTerm { kind: 'type'; value: 'file' | 'dir' }
export interface DepthTerm { kind: 'depth'; op: CompareOp; value: number }
export interface EmptyTerm { kind: 'empty'; value: boolean }
export interface DupeTerm { kind: 'dupe'; value: boolean }
export interface ScoreTerm { kind: 'score'; op: CompareOp; value: number }

export interface ElsewhereTerm { kind: 'elsewhere'; values: ('proven' | 'likely' | 'none' | 'unknown')[] }
export interface GitTerm { kind: 'git'; values: ('pushed' | 'dirty' | 'none')[] }
export interface BackupTerm { kind: 'backup'; values: ('yes' | 'no' | 'unknown')[] }
export interface CloudTerm { kind: 'cloud'; values: ('placeholder' | 'synced' | 'local-only')[] }

export type Term =
  | BareTerm | SizeTerm | ExtTerm | NameTerm | PathTerm | InTerm
  | DateTerm | UsedNeverTerm | TypeTerm | DepthTerm | EmptyTerm
  | DupeTerm | ScoreTerm | ElsewhereTerm | GitTerm | BackupTerm | CloudTerm;

/* ---------------------------------- AST ---------------------------------- */

export type Ast =
  | { kind: 'and'; left: Ast; right: Ast }
  | { kind: 'or'; left: Ast; right: Ast }
  | { kind: 'not'; operand: Ast }
  | { kind: 'term'; term: Term };

/* --------------------------------- errors --------------------------------- */

export interface ParseError {
  ok: false;
  /** One sentence, shown under the box. Names what was wrong and what is valid. */
  error: string;
  /** Character offset into the query where the problem starts. */
  offset: number;
  /** Length of the offending span, so the UI can underline exactly it. */
  length: number;
  /** What would have been valid here — field names, enum values, operators. */
  expected: string[];
}

export type ParseResult = { ok: true; ast: Ast } | ParseError;

/* --------------------------- which facts a query needs --------------------------- */

/**
 * Fact providers a parsed query depends on.
 *
 * Collected from the AST so the executor can fetch exactly what is needed and,
 * crucially, report what it could **not** fetch. §2.2 is explicit about why:
 * a query saying `backup:yes` on a machine with no backup capability must come
 * back visibly degraded, not as an empty list that looks like "nothing
 * matched".
 */
export type FactDependency = 'lastUsed' | 'recoverability' | 'reclaimScore' | 'duplicates';
