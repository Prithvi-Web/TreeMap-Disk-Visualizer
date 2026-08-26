import { parseQuery as parseBareQuery } from '../../utils/searchQuery';
import type { Ast, CompareOp, DateField, ParseError, ParseResult, Term } from './types';

/**
 * The query parser (v4 §2.1, §2.2).
 *
 * Tokenizer plus recursive descent, and **total by construction**: every path
 * returns either an AST or a structured error carrying an offset, a length and
 * the list of things that would have been valid there. Nothing throws. That is
 * not defensive style — this runs on every keystroke behind a 150 ms debounce,
 * and an exception in a search box is a search box that stops working.
 *
 * ── The rule that shapes the design ──
 *
 * **An unknown field is an error, never a substring.** `backupp:yes` must
 * underline itself and name the valid fields, not silently search for the text
 * "backupp:yes" and return nothing. Silently misinterpreting a query is worse
 * than a red underline: the user gets a plausible, wrong answer and no signal
 * that they were misunderstood.
 *
 * The cost of that rule is that a bare word containing a colon — `C:\Users`,
 * or a file literally named `notes:draft` — is an error too. The message says
 * so and tells the user to quote it, which is why the message text is treated
 * as part of the contract and asserted in tests.
 */

/* ------------------------------ the field table ------------------------------ */

type FieldKind = 'size' | 'ext' | 'text' | 'subtree' | 'date' | 'enum' | 'int' | 'bool' | 'score';

interface FieldSpec {
  kind: FieldKind;
  /** Operators this field accepts. `:` is written as '=' internally. */
  ops: CompareOp[];
  /** For enums: the accepted values, in the order the help lists them. */
  values?: readonly string[];
  /** One line of help, shown in autocomplete. */
  help: string;
}

const COMPARISONS: CompareOp[] = ['>', '<', '>=', '<=', '='];
const EQUALITY: CompareOp[] = ['='];

export const FIELDS: Record<string, FieldSpec> = {
  size: { kind: 'size', ops: COMPARISONS, help: 'File size, e.g. size>1gb or size<=500mb' },
  ext: { kind: 'ext', ops: EQUALITY, help: 'File extension, e.g. ext:mp4 or ext:mp4,mov,mkv' },
  name: { kind: 'text', ops: EQUALITY, help: 'Text in the file name, e.g. name:report' },
  path: { kind: 'text', ops: EQUALITY, help: 'Text anywhere in the full path, e.g. path:Downloads' },
  in: { kind: 'subtree', ops: EQUALITY, help: 'Inside this folder, e.g. in:~/Downloads' },
  modified: { kind: 'date', ops: COMPARISONS, help: 'When last changed, e.g. modified<2023-01-01 or modified>90d' },
  created: { kind: 'date', ops: COMPARISONS, help: 'When created, e.g. created<2y' },
  used: { kind: 'date', ops: COMPARISONS, values: ['never'], help: 'When last opened, e.g. used>1y or used:never' },
  dupe: { kind: 'bool', ops: EQUALITY, values: ['yes', 'no'], help: 'Has an identical twin: dupe:yes or dupe:no' },
  elsewhere: { kind: 'enum', ops: EQUALITY, values: ['proven', 'likely', 'none', 'unknown'], help: 'Whether a copy exists elsewhere' },
  git: { kind: 'enum', ops: EQUALITY, values: ['pushed', 'dirty', 'none'], help: 'Git state of the project it is in' },
  backup: { kind: 'enum', ops: EQUALITY, values: ['yes', 'no', 'unknown'], help: 'Whether a backup covers it' },
  cloud: { kind: 'enum', ops: EQUALITY, values: ['placeholder', 'synced', 'local-only'], help: 'Cloud sync state' },
  type: { kind: 'enum', ops: EQUALITY, values: ['file', 'dir'], help: 'type:file or type:dir' },
  depth: { kind: 'int', ops: COMPARISONS, help: 'Folder depth below the scan root, e.g. depth<=3' },
  empty: { kind: 'bool', ops: EQUALITY, values: ['yes', 'no'], help: 'Empty folders: empty:yes' },
  score: { kind: 'score', ops: COMPARISONS, help: 'Reclaim score 0-100, e.g. score>70' },
};

/** Valid field names, sorted — the list every error message names. */
export const FIELD_NAMES: string[] = Object.keys(FIELDS).sort();

/* -------------------------------- tokenizer -------------------------------- */

type TokenType = 'atom' | 'lparen' | 'rparen' | 'or' | 'not' | 'eof';

interface Token {
  type: TokenType;
  /** Raw text, with surrounding quotes already removed for atoms. */
  text: string;
  offset: number;
  length: number;
  /**
   * Whether the atom **began** with a quote, meaning the quotes wrap the whole
   * thing rather than just a field's value.
   *
   * The distinction is the whole point:
   *
   *   `"C:\\Users"`            → quoted from the start: plain text, never
   *                            split on its colon. This is what makes the
   *                            unknown-field error's own advice work.
   *   `in:"~/My (old) files"` → quotes wrap only the VALUE, so this is still
   *                            an `in:` term. Treating it as text would make
   *                            any path containing a space unsearchable.
   */
  quotedFromStart: boolean;
  /**
   * Index within `text` where the first quote appeared, or -1.
   *
   * The operator split must not look past it. Without this, `name:"a>b"` is
   * split on the `>` inside the quotes and reports `Unknown field "name:a"` —
   * telling the user to quote something they had already quoted, with no
   * spelling of the query that works.
   */
  firstQuoteAt: number;
}

/**
 * Split the query into tokens.
 *
 * Quoting matters more than it looks: a path can contain spaces and
 * parentheses, and without `in:"~/My (old) files"` those queries are
 * unexpressible. Quotes may wrap a whole atom or just a field's value.
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch === '(') { tokens.push({ type: 'lparen', text: '(', offset: i, length: 1, quotedFromStart: false, firstQuoteAt: -1 }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen', text: ')', offset: i, length: 1, quotedFromStart: false, firstQuoteAt: -1 }); i++; continue; }

    // A leading '-' negates the term that follows. A '-' anywhere else is an
    // ordinary character: file names are full of them, and treating every
    // hyphen as an operator would break `name:my-file`.
    if (ch === '-' && i + 1 < input.length && !/[\s)]/.test(input[i + 1])) {
      tokens.push({ type: 'not', text: '-', offset: i, length: 1, quotedFromStart: false, firstQuoteAt: -1 });
      i++;
      continue;
    }

    const start = i;
    let text = '';
    let inQuote = false;
    // Whether a quote appeared ANYWHERE in this atom — not whether we are
    // still inside one. Tracking the latter and testing it after the loop was
    // a real bug: by then a balanced `"or"` reads as unquoted again.
    let sawQuote = false;
    let firstQuoteAt = -1;
    const startsQuoted = input[i] === '"';
    while (i < input.length) {
      const c = input[i];
      if (c === '"') {
        if (firstQuoteAt === -1) firstQuoteAt = text.length;
        inQuote = !inQuote; sawQuote = true; i++; continue;
      }
      if (!inQuote && (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '(' || c === ')')) break;
      text += c;
      i++;
    }

    const lower = text.toLowerCase();
    if (lower === 'or' && !sawQuote) tokens.push({ type: 'or', text, offset: start, length: i - start, quotedFromStart: false, firstQuoteAt: -1 });
    else tokens.push({ type: 'atom', text, offset: start, length: i - start, quotedFromStart: startsQuoted, firstQuoteAt });
  }

  tokens.push({ type: 'eof', text: '', offset: input.length, length: 0, quotedFromStart: false, firstQuoteAt: -1 });
  return tokens;
}

/* ------------------------------ value parsers ------------------------------ */

/**
 * Sizes: decimal by default (`1 kb` = 1000 bytes) with binary forms available
 * (`1 kib` = 1024). Which is which is stated in the help, because disk tools
 * disagree and a silent factor of 1.024 per order of magnitude is a bug people
 * only notice at terabyte scale.
 */
const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
};

export function parseSize(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(raw.trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = m[2].toLowerCase();
  if (unit === '') return Math.round(value); // a bare number is bytes
  const multiplier = SIZE_UNITS[unit];
  if (multiplier === undefined) return null;
  return Math.round(value * multiplier);
}

const DURATION_UNITS: Record<string, number> = {
  d: 86_400_000,
  m: 30 * 86_400_000,
  y: 365 * 86_400_000,
};

export interface DateValue { mode: 'absolute' | 'age'; value: number }

/**
 * Dates accept `YYYY-MM-DD` or a relative `30d` / `6m` / `2y`.
 *
 * An absolute date is parsed as **local midnight**, not UTC: a user typing
 * `modified<2023-01-01` means their own new year, and using UTC would shift
 * the boundary by up to a day for most of the world.
 */
export function parseDateValue(raw: string): DateValue | null {
  const text = raw.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) {
    const [, y, mo, d] = iso;
    const year = Number(y); const month = Number(mo); const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const when = new Date(year, month - 1, day);
    // Reject impossible dates that Date silently rolls over (2023-02-31).
    if (when.getFullYear() !== year || when.getMonth() !== month - 1 || when.getDate() !== day) return null;
    return { mode: 'absolute', value: when.getTime() };
  }

  const rel = /^(\d+(?:\.\d+)?)([dmy])$/i.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    return { mode: 'age', value: n * DURATION_UNITS[rel[2].toLowerCase()] };
  }

  return null;
}

/* --------------------------------- helpers --------------------------------- */

const fail = (error: string, token: Token, expected: string[]): ParseError => ({
  ok: false, error, offset: token.offset, length: token.length, expected,
});

const listOf = (values: readonly string[]): string => values.join(', ');

/* ------------------------------ atom → term ------------------------------ */

/**
 * Split `field:value`, `size>1gb`, `depth<=3` into parts. Null when there is
 * no operator.
 *
 * `limit` is where the atom's first quote began: an operator inside a quoted
 * value is part of the value, not a field separator. Searching the whole atom
 * made `name:"a>b"` report `Unknown field "name:a"` and advise quoting — which
 * the user had already done, with no working alternative.
 */
function splitAtom(text: string, limit: number): { field: string; op: CompareOp; value: string } | null {
  const region = limit === -1 ? text : text.slice(0, limit);
  // Two-character operators first, so `>=` is never read as `>` followed by `=`.
  for (const op of ['>=', '<='] as const) {
    const at = region.indexOf(op);
    if (at > 0) return { field: text.slice(0, at), op, value: text.slice(at + 2) };
  }
  for (const op of ['>', '<', ':', '='] as const) {
    const at = region.indexOf(op);
    if (at > 0) {
      return { field: text.slice(0, at), op: op === ':' ? '=' : op, value: text.slice(at + 1) };
    }
  }
  return null;
}

function termFromAtom(token: Token): { ok: true; term: Term } | ParseError {
  // An atom that BEGINS with a quote is text, full stop — the escape hatch the
  // unknown-field error points people at, and it has to actually work for
  // `"C:\\Users"` and for a file genuinely named `notes:draft`. Quotes that
  // appear later wrap only a field's value (`in:"~/My files"`) and must not
  // turn the whole term into a substring search.
  const split = token.quotedFromStart ? null : splitAtom(token.text, token.firstQuoteAt);

  // No operator: a bare word, which keeps today's exact behaviour by handing
  // the text to the original parser rather than reimplementing its three rules.
  if (!split) {
    return { ok: true, term: { kind: 'bare', raw: token.text, query: parseBareQuery(token.text) } };
  }

  const fieldName = split.field.toLowerCase();
  const spec = FIELDS[fieldName];
  if (!spec) {
    return fail(
      `Unknown field "${split.field}". Valid fields: ${FIELD_NAMES.join(', ')}. ` +
      'To search for text containing a colon, put it in quotes.',
      token,
      FIELD_NAMES,
    );
  }

  if (!spec.ops.includes(split.op)) {
    return fail(
      `"${fieldName}" does not accept ${split.op === '=' ? ':' : split.op}. ${spec.help}`,
      token,
      spec.ops.map((o) => (o === '=' ? ':' : o)),
    );
  }

  const value = split.value;
  if (value.length === 0) {
    return fail(`"${fieldName}" needs a value. ${spec.help}`, token, spec.values ? [...spec.values] : []);
  }

  switch (spec.kind) {
    case 'size': {
      const bytes = parseSize(value);
      if (bytes === null) {
        return fail(
          `"${value}" is not a size. Use a number with b, kb, mb, gb or tb (or kib, mib, gib for the 1024-based units).`,
          token, ['1gb', '500mb', '100kb'],
        );
      }
      return { ok: true, term: { kind: 'size', op: split.op, bytes } };
    }

    case 'ext': {
      const values = value.split(',').map((v) => v.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean);
      if (values.length === 0) return fail('List at least one extension, e.g. ext:mp4,mov', token, ['mp4', 'jpg', 'zip']);
      return { ok: true, term: { kind: 'ext', values } };
    }

    case 'text':
      return fieldName === 'name'
        ? { ok: true, term: { kind: 'name', needle: value.toLowerCase() } }
        : { ok: true, term: { kind: 'path', needle: value.toLowerCase() } };

    case 'subtree':
      return { ok: true, term: { kind: 'in', prefix: value } };

    case 'date': {
      // `used:never` is the one enum value a date field takes.
      if (fieldName === 'used' && split.op === '=' && value.toLowerCase() === 'never') {
        return { ok: true, term: { kind: 'usedNever' } };
      }
      const parsed = parseDateValue(value);
      if (!parsed) {
        const extra = fieldName === 'used' ? ', or used:never' : '';
        return fail(
          `"${value}" is not a date. Use YYYY-MM-DD, or an age like 30d, 6m or 2y${extra}.`,
          token, ['2023-01-01', '90d', '6m', '2y'],
        );
      }
      return {
        ok: true,
        term: {
          kind: 'date', field: fieldName as DateField, mode: parsed.mode,
          op: split.op, value: parsed.value, raw: value,
        },
      };
    }

    case 'int': {
      if (!/^\d+$/.test(value)) return fail(`"${value}" is not a whole number. ${spec.help}`, token, ['0', '1', '3']);
      return { ok: true, term: { kind: 'depth', op: split.op, value: Number(value) } };
    }

    case 'score': {
      if (!/^\d+(?:\.\d+)?$/.test(value)) return fail(`"${value}" is not a number. ${spec.help}`, token, ['70', '90']);
      const n = Number(value);
      if (n < 0 || n > 100) return fail('Reclaim score runs from 0 to 100.', token, ['0', '50', '100']);
      return { ok: true, term: { kind: 'score', op: split.op, value: n } };
    }

    case 'bool': {
      const v = value.toLowerCase();
      if (v !== 'yes' && v !== 'no') {
        return fail(`"${fieldName}" takes ${listOf(spec.values!)}.`, token, [...spec.values!]);
      }
      if (fieldName === 'dupe') return { ok: true, term: { kind: 'dupe', value: v === 'yes' } };
      return { ok: true, term: { kind: 'empty', value: v === 'yes' } };
    }

    case 'enum': {
      const parts = value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
      const allowed = spec.values!;
      const bad = parts.filter((p) => !allowed.includes(p));
      if (parts.length === 0 || bad.length > 0) {
        return fail(
          `"${fieldName}" takes ${listOf(allowed)}${bad.length ? ` — "${bad[0]}" is not one of them` : ''}.`,
          token, [...allowed],
        );
      }
      switch (fieldName) {
        case 'type': return { ok: true, term: { kind: 'type', value: parts[0] as 'file' | 'dir' } };
        case 'elsewhere': return { ok: true, term: { kind: 'elsewhere', values: parts as ('proven' | 'likely' | 'none' | 'unknown')[] } };
        case 'git': return { ok: true, term: { kind: 'git', values: parts as ('pushed' | 'dirty' | 'none')[] } };
        case 'backup': return { ok: true, term: { kind: 'backup', values: parts as ('yes' | 'no' | 'unknown')[] } };
        default: return { ok: true, term: { kind: 'cloud', values: parts as ('placeholder' | 'synced' | 'local-only')[] } };
      }
    }
  }
}

/* --------------------------------- limits --------------------------------- */

/**
 * Bounds that keep "parsing is total" true in practice as well as in intent.
 *
 * Recursive descent uses about five stack frames per nesting level, so around
 * 1,875 open brackets overflows the stack — and `express.json` accepts a 1 MB
 * body, so that is four kilobytes of `(` away over HTTP. The result was a
 * generic 500 rather than the structured 400 this endpoint promises: precisely
 * the "search box stops working" failure the header claims to prevent.
 *
 * The token cap matters for the same reason one level up. `parseAnd` is
 * iterative, so ten thousand juxtaposed words parse happily into a
 * ten-thousand-deep left-nested AST — and then every consumer that walks it
 * recursively (`toSql`, `evaluate`, `factsNeeded`) overflows instead. Bounding
 * the token count bounds the AST, which bounds all of them.
 *
 * All three are far above any query a person types and far below the limits
 * that break.
 */
export const MAX_QUERY_LENGTH = 4000;
export const MAX_QUERY_TOKENS = 512;
export const MAX_QUERY_DEPTH = 32;

/* -------------------------------- the parser -------------------------------- */

/**
 * Parse a query string.
 *
 * Grammar, smallest to largest:
 *
 *   query   := orExpr
 *   orExpr  := andExpr ( 'or' andExpr )*
 *   andExpr := unary+                  -- juxtaposition means AND
 *   unary   := '-' unary | primary
 *   primary := '(' orExpr ')' | atom
 *
 * Terms are ANDed by adjacency because that is what people already type into
 * search boxes; `or` is the explicit exception.
 */
export function parse(input: string): ParseResult {
  if (input.length > MAX_QUERY_LENGTH) {
    return {
      ok: false,
      error: `That query is too long (${input.length.toLocaleString()} characters; the limit is ${MAX_QUERY_LENGTH.toLocaleString()}).`,
      offset: MAX_QUERY_LENGTH, length: input.length - MAX_QUERY_LENGTH, expected: ['a shorter query'],
    };
  }

  const tokens = tokenize(input);
  if (tokens.length - 1 > MAX_QUERY_TOKENS) {
    return {
      ok: false,
      error: `That query has too many terms (${tokens.length - 1}; the limit is ${MAX_QUERY_TOKENS}).`,
      offset: tokens[MAX_QUERY_TOKENS].offset, length: 0, expected: ['fewer terms'],
    };
  }

  let pos = 0;
  let depth = 0;

  const peek = (): Token => tokens[pos];
  const next = (): Token => tokens[pos++];

  function parsePrimary(): { ok: true; ast: Ast } | ParseError {
    const token = peek();

    if (token.type === 'lparen') {
      if (depth >= MAX_QUERY_DEPTH) {
        return fail(`Brackets are nested too deeply (the limit is ${MAX_QUERY_DEPTH}).`, token, ['fewer brackets']);
      }
      next();
      depth++;
      const inner = parseOr();
      depth--;
      if (!('ok' in inner) || inner.ok !== true) return inner as ParseError;
      const close = peek();
      if (close.type !== 'rparen') {
        return fail('This bracket is never closed.', token, [')']);
      }
      next();
      return inner;
    }

    if (token.type === 'rparen') {
      return fail('This closing bracket has no opening one.', token, ['a search term']);
    }

    if (token.type === 'or') {
      return fail('"or" needs a search term before it.', token, ['a search term']);
    }

    if (token.type === 'eof') {
      return fail('The query ends before this term is finished.', token, ['a search term']);
    }

    const term = termFromAtom(next());
    if (!('ok' in term) || term.ok !== true) return term as ParseError;
    return { ok: true, ast: { kind: 'term', term: term.term } };
  }

  function parseUnary(): { ok: true; ast: Ast } | ParseError {
    if (peek().type === 'not') {
      const minus = next();
      const operand = parseUnary();
      if (!('ok' in operand) || operand.ok !== true) return operand as ParseError;
      // A stray '-' with nothing after it is caught by parsePrimary's eof case,
      // but the caret should point at the '-' the user typed.
      if (operand.ast.kind === 'term' && operand.ast.term.kind === 'bare' && operand.ast.term.raw === '') {
        return fail('"-" needs a search term after it, e.g. -in:node_modules.', minus, ['a search term']);
      }
      return { ok: true, ast: { kind: 'not', operand: operand.ast } };
    }
    return parsePrimary();
  }

  function parseAnd(): { ok: true; ast: Ast } | ParseError {
    const first = parseUnary();
    if (!('ok' in first) || first.ok !== true) return first as ParseError;
    let left = first.ast;
    for (;;) {
      const t = peek();
      if (t.type === 'eof' || t.type === 'rparen' || t.type === 'or') break;
      const right = parseUnary();
      if (!('ok' in right) || right.ok !== true) return right as ParseError;
      left = { kind: 'and', left, right: right.ast };
    }
    return { ok: true, ast: left };
  }

  function parseOr(): { ok: true; ast: Ast } | ParseError {
    const first = parseAnd();
    if (!('ok' in first) || first.ok !== true) return first as ParseError;
    let left = first.ast;
    while (peek().type === 'or') {
      const orToken = next();
      if (peek().type === 'eof' || peek().type === 'rparen') {
        return fail('"or" needs a search term after it.', orToken, ['a search term']);
      }
      const right = parseAnd();
      if (!('ok' in right) || right.ok !== true) return right as ParseError;
      left = { kind: 'or', left, right: right.ast };
    }
    return { ok: true, ast: left };
  }

  // An empty query is not an error — it is the "no filter" case, and the box
  // starts empty on every load.
  if (tokens.length === 1) {
    return { ok: true, ast: { kind: 'term', term: { kind: 'bare', raw: '', query: parseBareQuery('') } } };
  }

  const result = parseOr();
  if (!('ok' in result) || result.ok !== true) return result as ParseError;

  const trailing = peek();
  if (trailing.type !== 'eof') {
    return fail(
      trailing.type === 'rparen' ? 'This closing bracket has no opening one.' : 'Unexpected text after the query.',
      trailing, ['end of query'],
    );
  }
  return { ok: true, ast: result.ast };
}

/* ------------------------------ introspection ------------------------------ */

/** Walk an AST, visiting every term. */
export function eachTerm(ast: Ast, visit: (term: Term) => void): void {
  switch (ast.kind) {
    case 'term': visit(ast.term); return;
    case 'not': eachTerm(ast.operand, visit); return;
    case 'and':
    case 'or': eachTerm(ast.left, visit); eachTerm(ast.right, visit); return;
  }
}

/**
 * Which fact providers this query needs.
 *
 * The executor uses this to fetch exactly what is required and — the part that
 * matters — to report what it could not fetch. A `backup:yes` query on a
 * machine with no backups must come back visibly degraded rather than as an
 * empty list that reads as "nothing matched" (§2.2).
 */
export function factsNeeded(ast: Ast): Set<string> {
  const needed = new Set<string>();
  eachTerm(ast, (term) => {
    switch (term.kind) {
      case 'date': if (term.field === 'used') needed.add('lastUsed'); break;
      case 'usedNever': needed.add('lastUsed'); break;
      case 'elsewhere': case 'git': case 'backup': case 'cloud': needed.add('recoverability'); break;
      case 'score': needed.add('reclaimScore'); break;
      case 'dupe': needed.add('duplicates'); break;
      default: break;
    }
  });
  return needed;
}
