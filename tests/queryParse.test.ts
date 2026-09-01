import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse, parseSize, parseDateValue, tokenize, FIELD_NAMES, factsNeeded, MAX_QUERY_TOKENS } from '../src/services/query/parse';
import { toSql } from '../src/services/query/toSql';
import { matchesDate } from '../src/services/query/evaluate';
import type { Ast, Term } from '../src/services/query/types';

/**
 * The query grammar's parser (v4 §2.1).
 *
 * Two properties are defended above all others.
 *
 * **Parsing is total.** `parse()` runs on every keystroke behind a 150 ms
 * debounce. A thrown exception there is a search box that stops working, so a
 * fuzz-ish corpus of malformed input asserts that nothing throws, ever.
 *
 * **An unknown field is an error, never a substring.** Silently searching for
 * the literal text `backupp:yes` would hand the user a plausible, wrong,
 * *empty* answer with no signal that they were misunderstood. §2.1 is explicit
 * that a red underline is the lesser evil, so the error text is treated as
 * part of the contract and asserted, not just the fact of failing.
 */

/* -------------------------------- helpers -------------------------------- */

function ok(q: string): Ast {
  const r = parse(q);
  assert.equal(r.ok, true, `expected "${q}" to parse` + (r.ok ? '' : `, got: ${r.error}`));
  return (r as { ok: true; ast: Ast }).ast;
}

function bad(q: string): { error: string; offset: number; length: number; expected: string[] } {
  const r = parse(q);
  assert.equal(r.ok, false, `expected "${q}" to be rejected`);
  return r as { ok: false; error: string; offset: number; length: number; expected: string[] };
}

/** The single term of a one-term query. */
function term(q: string): Term {
  const ast = ok(q);
  assert.equal(ast.kind, 'term', `"${q}" is not a single term`);
  return (ast as { kind: 'term'; term: Term }).term;
}

/* ============================ totality ============================ */

test('parse never throws, whatever it is given', () => {
  const hostile = [
    '', ' ', '   \t\n ', '-', '--', '---x', '"', '""', '"""', 'a"b"c',
    '(', ')', '((((', '))))', '()', '( )', '(()', '())',
    'or', 'or or', 'a or or b', 'or a', 'a or', '- or -',
    ':', '::', ':foo', 'foo:', 'foo::bar', '=', '>', '<', '>=', '<=',
    'size>', 'size<', '>1gb', 'size>>1gb', 'size>=>1gb',
    'ext:', 'ext:,,,', 'ext:,', 'name:', 'in:', 'depth:', 'depth>',
    'used>', 'used:', 'modified>', 'score>', 'score:',
    '🙂', 'naïve café', '\u0000', 'a\u0000b', '𝕏𝕐𝕫',
    'a'.repeat(5000),
    '('.repeat(500) + 'a' + ')'.repeat(500),
    '('.repeat(500),
    'a '.repeat(2000),
    'size>1gb '.repeat(500),
    '-'.repeat(200) + 'x',
    'in:C:\\Users\\me', 'path:/a/b/c', 'name:my-file', 'name:a-b-c',
  ];
  for (const q of hostile) {
    // The assertion is simply that this line completes.
    const r = parse(q);
    assert.equal(typeof r.ok, 'boolean', `"${q.slice(0, 30)}" produced no verdict`);
    if (!r.ok) {
      assert.ok(r.offset >= 0, 'an error always carries a non-negative offset');
      assert.ok(r.error.length > 0, 'an error always carries a message');
      assert.ok(Array.isArray(r.expected), 'an error always carries what was expected');
    }
  }
});

test('a query too big to parse safely is REFUSED, not crashed on', () => {
  // Recursive descent uses ~5 stack frames per nesting level, so about 1,875
  // open brackets overflows the stack — and express.json accepts a 1 MB body,
  // so that is four kilobytes of "(" away over HTTP. Unbounded, the endpoint
  // answered a generic 500 instead of the structured 400 it promises: exactly
  // the "search box stops working" failure totality is meant to prevent.
  const deepButFine = '('.repeat(20) + 'size>1gb' + ')'.repeat(20);
  assert.equal(parse(deepButFine).ok, true, 'ordinary nesting still works');

  for (const [label, q] of [
    ['1875 brackets — the measured overflow point', '('.repeat(1875) + 'a' + ')'.repeat(1875)],
    ['5000 brackets', '('.repeat(5000)],
    // parseAnd is ITERATIVE, so ten thousand juxtaposed words parse happily
    // into a ten-thousand-deep AST — and then toSql, evaluate and factsNeeded
    // overflow instead, one level up. Bounding tokens bounds all of them.
    ['10k juxtaposed terms', Array.from({ length: 10000 }, (_, i) => `w${i}`).join(' ')],
    ['a 100k-character word', 'a'.repeat(100_000)],
  ] as const) {
    const r = parse(q);
    assert.equal(r.ok, false, `${label} should be refused`);
    assert.ok((r as { error: string }).error.length > 0, `${label} gets a real message`);
    assert.match((r as { error: string }).error, /too (long|many|deeply)/, label);
  }

  // And every consumer survives whatever DOES parse, because the AST is bounded.
  const biggest = Array.from({ length: MAX_QUERY_TOKENS - 1 }, () => 'x').join(' ');
  const parsed = parse(biggest);
  assert.equal(parsed.ok, true);
  assert.doesNotThrow(() => toSql((parsed as { ok: true; ast: Ast }).ast));
  assert.doesNotThrow(() => factsNeeded((parsed as { ok: true; ast: Ast }).ast));
});

test('an operator inside a quoted value belongs to the value', () => {
  // The error message advises quoting; that advice has to work. Searching the
  // whole atom for operators made `name:"a>b"` report `Unknown field "name:a"`
  // and tell the user to quote something they had already quoted — with no
  // spelling of the query that works at all.
  assert.equal((term('name:"a>b"') as { needle: string }).needle, 'a>b');
  assert.equal((term('path:"a<b"') as { needle: string }).needle, 'a<b');
  assert.equal((term('name:"x>=y"') as { needle: string }).needle, 'x>=y');
  assert.equal((term('in:"~/a (b) c"') as { prefix: string }).prefix, '~/a (b) c');
  // An operator OUTSIDE the quotes still splits.
  assert.equal((term('size>"1gb"') as { bytes: number }).bytes, 1_000_000_000);
});

test('an absolute date means the whole DAY, not one millisecond', () => {
  // `modified:2023-01-01` at millisecond equality silently matches nothing,
  // which is indistinguishable from "there is nothing there".
  const day = Date.UTC(2026, 0, 15);
  const local = new Date(2026, 0, 15).getTime();
  void day;
  assert.equal(matchesDate(local, 'absolute', '=', local, local), true, 'midnight itself');
  assert.equal(matchesDate(local + 12 * 3600_000, 'absolute', '=', local, local), true, 'midday');
  assert.equal(matchesDate(local + 86_399_999, 'absolute', '=', local, local), true, 'the last millisecond');
  assert.equal(matchesDate(local + 86_400_000, 'absolute', '=', local, local), false, 'the next day is out');
  assert.equal(matchesDate(local - 1, 'absolute', '=', local, local), false, 'the previous day is out');
});

/* ============================ legacy compatibility ============================ */

test('bare words keep exactly today\'s three rules', () => {
  // §2.1: the zero-token case must not change. These carry the ORIGINAL
  // parser's output rather than a reimplementation, which is what stops
  // `*.zip` drifting from what it has always meant.
  const star = term('*.zip');
  assert.equal(star.kind, 'bare');
  assert.deepEqual((star as { query: unknown }).query, { kind: 'extension', extension: 'zip' });

  const dot = term('.zip');
  assert.deepEqual((dot as { query: unknown }).query, { kind: 'extension', extension: 'zip' });

  const word = term('holiday');
  assert.deepEqual((word as { query: unknown }).query, { kind: 'substring', needle: 'holiday' });

  // The edge cases the original parser has: a lone '.' is a substring, and
  // '*.' with nothing after it is the empty extension.
  assert.deepEqual((term('.') as { query: unknown }).query, { kind: 'substring', needle: '.' });
  assert.deepEqual((term('*.') as { query: unknown }).query, { kind: 'extension', extension: '' });

  // Case folding happens in the original parser, not here.
  assert.deepEqual((term('ZIP') as { query: unknown }).query, { kind: 'substring', needle: 'zip' });
});

test('an empty query parses to the empty bare term, not an error', () => {
  // The box starts empty on every load; an error there would be permanent.
  const t = term('');
  assert.equal(t.kind, 'bare');
  assert.equal((t as { raw: string }).raw, '');
});

/* ============================ sizes ============================ */

test('sizes accept decimal and binary units', () => {
  assert.equal(parseSize('1'), 1);
  assert.equal(parseSize('1b'), 1);
  assert.equal(parseSize('1kb'), 1_000);
  assert.equal(parseSize('1mb'), 1_000_000);
  assert.equal(parseSize('1gb'), 1_000_000_000);
  assert.equal(parseSize('1tb'), 1_000_000_000_000);
  // Binary forms exist because disk tools disagree, and a silent factor of
  // 1.024 per order of magnitude is a bug people only notice at TB scale.
  assert.equal(parseSize('1kib'), 1024);
  assert.equal(parseSize('1mib'), 1024 ** 2);
  assert.equal(parseSize('1gib'), 1024 ** 3);
  assert.equal(parseSize('1tib'), 1024 ** 4);
  assert.equal(parseSize('1.5gb'), 1_500_000_000);
  assert.equal(parseSize('500 MB'), 500_000_000, 'case and a space are both tolerated');
  assert.equal(parseSize('0'), 0);
});

test('a size that is not a size is rejected with a helpful message', () => {
  for (const junk of ['banana', '', 'gb', '1zb', '-5mb', '1.2.3gb', '1 2 gb']) {
    assert.equal(parseSize(junk), null, `"${junk}" must not parse as a size`);
  }
  const err = bad('size>banana');
  assert.match(err.error, /is not a size/);
  assert.match(err.error, /kb, mb, gb/, 'the message lists the units');
  assert.ok(err.expected.includes('1gb'));
});

test('every comparison operator works on size', () => {
  for (const [q, op] of [['size>1gb', '>'], ['size<1gb', '<'], ['size>=1gb', '>='], ['size<=1gb', '<='], ['size=1gb', '=']] as const) {
    const t = term(q);
    assert.equal(t.kind, 'size');
    assert.equal((t as { op: string }).op, op, q);
  }
  // ">=" must not be read as ">" followed by a stray "=".
  assert.equal((term('size>=1gb') as { bytes: number }).bytes, 1_000_000_000);
});

/* ============================ dates ============================ */

test('dates accept ISO and relative forms', () => {
  const iso = parseDateValue('2023-01-01');
  assert.equal(iso!.mode, 'absolute');
  // Local midnight, not UTC: a user typing 2023-01-01 means their own new
  // year, and UTC would shift the boundary by up to a day for most of world.
  const d = new Date(iso!.value);
  assert.equal(d.getFullYear(), 2023);
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 1);
  assert.equal(d.getHours(), 0);

  assert.deepEqual(parseDateValue('30d'), { mode: 'age', value: 30 * 86_400_000 });
  assert.deepEqual(parseDateValue('6m'), { mode: 'age', value: 6 * 30 * 86_400_000 });
  assert.deepEqual(parseDateValue('2y'), { mode: 'age', value: 2 * 365 * 86_400_000 });
});

test('impossible dates are rejected rather than rolled over', () => {
  // new Date(2023, 1, 31) silently becomes 3 March. Accepting that would make
  // `modified<2023-02-31` quietly mean something the user did not type.
  assert.equal(parseDateValue('2023-02-31'), null);
  assert.equal(parseDateValue('2023-13-01'), null);
  assert.equal(parseDateValue('2023-00-10'), null);
  assert.equal(parseDateValue('2023-01-32'), null);
  assert.equal(parseDateValue('23-01-01'), null);
  assert.equal(parseDateValue('2023/01/01'), null);
  assert.equal(parseDateValue('tomorrow'), null);
  assert.equal(parseDateValue('30w'), null, 'only d, m and y are units');
});

test('the two date modes are recorded distinctly', () => {
  // The asymmetry that must not be lost: absolute compares the timestamp
  // (`<` = before), age compares the age (`>` = older than). Both read as
  // "older" to a person; getting it backwards returns the exact complement of
  // what was asked.
  const absolute = term('modified<2023-01-01');
  assert.equal(absolute.kind, 'date');
  assert.equal((absolute as { mode: string }).mode, 'absolute');
  assert.equal((absolute as { op: string }).op, '<');

  const age = term('modified>90d');
  assert.equal((age as { mode: string }).mode, 'age');
  assert.equal((age as { op: string }).op, '>');

  assert.equal((term('created<2y') as { field: string }).field, 'created');
  assert.equal((term('used>1y') as { field: string }).field, 'used');
});

test('used:never is its own term, not a date', () => {
  assert.equal(term('used:never').kind, 'usedNever');
  // And only `used` has it.
  assert.match(bad('modified:never').error, /is not a date/);
});

/* ============================ the other fields ============================ */

test('ext accepts one or many, and normalises what people actually type', () => {
  assert.deepEqual((term('ext:mp4') as { values: string[] }).values, ['mp4']);
  assert.deepEqual((term('ext:mp4,mov,mkv') as { values: string[] }).values, ['mp4', 'mov', 'mkv']);
  assert.deepEqual((term('ext:MP4,Mov') as { values: string[] }).values, ['mp4', 'mov']);
  // People type the dot and the star out of habit; both are stripped.
  assert.deepEqual((term('ext:.mp4') as { values: string[] }).values, ['mp4']);
  assert.deepEqual((term('ext:*.mp4') as { values: string[] }).values, ['mp4']);
  // Spaces separate TERMS, so a spaced list has to be quoted to stay one term.
  assert.deepEqual((term('ext:"mp4, mov , mkv"') as { values: string[] }).values, ['mp4', 'mov', 'mkv']);
});

test('name and path are distinct, and both fold case', () => {
  assert.equal((term('name:Report') as { needle: string }).needle, 'report');
  assert.equal((term('path:Downloads') as { needle: string }).needle, 'downloads');
  assert.equal(term('name:x').kind, 'name');
  assert.equal(term('path:x').kind, 'path');
});

test('in: keeps its value verbatim, including ~ and spaces', () => {
  assert.equal((term('in:~/Downloads') as { prefix: string }).prefix, '~/Downloads');
  // Quoting is how a path with spaces or brackets is expressed at all.
  assert.equal((term('in:"~/My (old) files"') as { prefix: string }).prefix, '~/My (old) files');
  assert.equal((term('in:/Users/me/Docs') as { prefix: string }).prefix, '/Users/me/Docs');
});

test('enum fields accept their values and reject anything else', () => {
  assert.deepEqual((term('elsewhere:proven') as { values: string[] }).values, ['proven']);
  assert.deepEqual((term('elsewhere:proven,likely') as { values: string[] }).values, ['proven', 'likely']);
  assert.deepEqual((term('git:pushed') as { values: string[] }).values, ['pushed']);
  assert.deepEqual((term('backup:unknown') as { values: string[] }).values, ['unknown']);
  assert.deepEqual((term('cloud:local-only') as { values: string[] }).values, ['local-only']);
  assert.equal((term('type:dir') as { value: string }).value, 'dir');

  const err = bad('type:folder');
  assert.match(err.error, /file, dir/, 'the message lists what is valid');
  assert.match(err.error, /"folder" is not one of them/);
  assert.deepEqual(err.expected, ['file', 'dir']);

  assert.match(bad('elsewhere:maybe').error, /proven, likely, none, unknown/);
  assert.match(bad('git:clean').error, /pushed, dirty, none/);
  assert.match(bad('cloud:offline').error, /placeholder, synced, local-only/);
});

test('booleans, depth, empty and score', () => {
  assert.equal((term('dupe:yes') as { value: boolean }).value, true);
  assert.equal((term('dupe:no') as { value: boolean }).value, false);
  assert.equal((term('empty:yes') as { value: boolean }).value, true);
  assert.equal((term('depth<=3') as { value: number }).value, 3);
  assert.equal((term('depth<=3') as { op: string }).op, '<=');
  assert.equal((term('score>70') as { value: number }).value, 70);

  assert.match(bad('depth>x').error, /is not a whole number/);
  assert.match(bad('score>200').error, /0 to 100/);
  assert.match(bad('dupe:maybe').error, /yes, no/);
});

/* ============================ structure ============================ */

test('adjacent terms are ANDed', () => {
  const ast = ok('size>1gb ext:mp4');
  assert.equal(ast.kind, 'and');
});

test('three terms nest left, so evaluation order is deterministic', () => {
  const ast = ok('a b c') as { kind: 'and'; left: Ast; right: Ast };
  assert.equal(ast.kind, 'and');
  assert.equal(ast.left.kind, 'and');
  assert.equal(ast.right.kind, 'term');
});

test('or is an explicit keyword and binds looser than adjacency', () => {
  // `a b or c` must be `(a AND b) OR c`, not `a AND (b OR c)`.
  const ast = ok('a b or c') as { kind: 'or'; left: Ast; right: Ast };
  assert.equal(ast.kind, 'or');
  assert.equal(ast.left.kind, 'and');
  assert.equal(ast.right.kind, 'term');
  // Case-insensitive, because people type both.
  assert.equal(ok('a OR b').kind, 'or');
  assert.equal(ok('a Or b').kind, 'or');
});

test('parentheses group', () => {
  const ast = ok('a (b or c)') as { kind: 'and'; left: Ast; right: Ast };
  assert.equal(ast.kind, 'and');
  assert.equal(ast.right.kind, 'or');
});

test('a quoted "or" is a search term, not the operator', () => {
  const ast = ok('"or"');
  assert.equal(ast.kind, 'term');
});

test('any term may be negated, including a group', () => {
  assert.equal(ok('-in:node_modules').kind, 'not');
  assert.equal(ok('-(a or b)').kind, 'not');
  assert.equal(ok('--a').kind, 'not', 'double negation parses rather than erroring');
  // A hyphen inside a word is an ordinary character — file names are full of
  // them, and treating every '-' as an operator would break name:my-file.
  const inner = term('name:my-file');
  assert.equal((inner as { needle: string }).needle, 'my-file');
});

/* ============================ malformed input ============================ */

test('an unknown field is an error that names the valid fields', () => {
  const err = bad('backupp:yes');
  assert.match(err.error, /Unknown field "backupp"/);
  for (const field of ['size', 'ext', 'name', 'in', 'used', 'backup']) {
    assert.match(err.error, new RegExp(`\\b${field}\\b`), `the message lists "${field}"`);
  }
  // And it tells the user how to search for the text instead — the escape
  // hatch that makes the strict rule tolerable.
  assert.match(err.error, /quotes/);
  assert.deepEqual(err.expected, FIELD_NAMES);
  assert.equal(err.offset, 0);
  assert.equal(err.length, 'backupp:yes'.length);
});

test('a Windows path typed bare is an error, not a silent substring search', () => {
  // The documented cost of the strict rule. `C:\Users` looks like field "C".
  const err = bad('C:\\Users');
  assert.match(err.error, /Unknown field "C"/);
  // The working forms:
  assert.equal((term('in:C:\\Users') as { prefix: string }).prefix, 'C:\\Users');
  // Quoting is the escape hatch the error message itself recommends, so it
  // has to actually work: a quoted atom is never split on its colon.
  const quoted = term('"C:\\Users"');
  assert.equal(quoted.kind, 'bare');
  assert.equal((quoted as { raw: string }).raw, 'C:\\Users');
});

test('every malformed input reports a usable offset and span', () => {
  const cases: [string, RegExp][] = [
    ['size>banana', /is not a size/],
    ['ext:', /needs a value/],
    ['name:', /needs a value/],
    ['(a', /never closed/],
    ['a)', /no opening one/],
    ['or x', /needs a search term before/],
    ['x or', /needs a search term after/],
    ['used>tomorrow', /is not a date/],
    ['type:folder', /file, dir/],
    ['score>200', /0 to 100/],
    ['depth>x', /whole number/],
    ['modified<2023-02-31', /is not a date/],
    ['zzz:1', /Unknown field/],
    ['ext>mp4', /does not accept/],
    ['name>x', /does not accept/],
    ['a (b', /never closed/],
  ];
  assert.ok(cases.length >= 15, 'at least fifteen malformed inputs are covered');
  for (const [q, pattern] of cases) {
    const err = bad(q);
    assert.match(err.error, pattern, q);
    assert.ok(err.offset >= 0 && err.offset <= q.length, `${q}: offset ${err.offset} is inside the query`);
    // `>= 0` was a tautology: `length` is built from tokenizer spans that are
    // non-negative by construction, so it could not fail for any input or any
    // change. The claim worth pinning is the one the highlight box relies on —
    // the span actually covers something, because a zero-width span underlines
    // nothing and leaves the reader hunting for the character being complained
    // about.
    assert.ok(err.length > 0, `${q}: the span must cover at least one character, got ${err.length}`);
    assert.ok(err.offset + err.length <= q.length + 1, `${q}: the span does not run past the end`);
  }
});

test('a field that rejects an operator says which ones it takes', () => {
  const err = bad('ext>mp4');
  assert.match(err.error, /does not accept/);
  assert.match(err.error, /ext:mp4/, 'the help shows a working example');
  assert.deepEqual(err.expected, [':'], 'and names the operator it does take');
});

test('":" is equality, so size:1gb means exactly one gigabyte', () => {
  // Not an error: `:` is the equality spelling for every field that has one,
  // and a size field genuinely accepts equality. Worth pinning so nobody
  // "fixes" it into a rejection later.
  const t = term('size:1gb');
  assert.equal(t.kind, 'size');
  assert.equal((t as { op: string }).op, '=');
  assert.equal((t as { bytes: number }).bytes, 1_000_000_000);
});

/* ============================ tokenizer ============================ */

test('the tokenizer keeps offsets that point at the real text', () => {
  const tokens = tokenize('size>1gb  -ext:mp4');
  assert.equal(tokens[0].offset, 0);
  assert.equal(tokens[0].text, 'size>1gb');
  assert.equal(tokens[1].type, 'not');
  assert.equal(tokens[1].offset, 10);
  assert.equal(tokens[2].text, 'ext:mp4');
  assert.equal(tokens[2].offset, 11);
  assert.equal(tokens[tokens.length - 1].type, 'eof');
});

test('an unterminated quote does not swallow the parser', () => {
  // It consumes to the end, which is the forgiving reading — a user mid-type
  // has an unbalanced quote most of the time.
  const r = parse('name:"unterminated');
  assert.equal(r.ok, true);
});

/* ============================ fact dependencies ============================ */

test('a query declares which fact providers it needs', () => {
  // Drives both the fetch and — the part that matters — the `degraded` report:
  // a query needing a signal this machine lacks must say so rather than
  // returning an empty list that reads as "nothing matched".
  assert.deepEqual([...factsNeeded(ok('size>1gb'))], []);
  assert.deepEqual([...factsNeeded(ok('used>1y'))], ['lastUsed']);
  assert.deepEqual([...factsNeeded(ok('used:never'))], ['lastUsed']);
  assert.deepEqual([...factsNeeded(ok('elsewhere:proven'))], ['recoverability']);
  assert.deepEqual([...factsNeeded(ok('git:pushed'))], ['recoverability']);
  assert.deepEqual([...factsNeeded(ok('backup:yes'))], ['recoverability']);
  assert.deepEqual([...factsNeeded(ok('cloud:synced'))], ['recoverability']);
  assert.deepEqual([...factsNeeded(ok('score>70'))], ['reclaimScore']);
  assert.deepEqual([...factsNeeded(ok('dupe:yes'))], ['duplicates']);
  // Collected through negation and grouping too, or a `-used:never` query
  // would silently skip its fetch.
  assert.deepEqual([...factsNeeded(ok('-used:never'))], ['lastUsed']);
  assert.deepEqual([...factsNeeded(ok('(size>1gb or git:dirty)'))], ['recoverability']);
  assert.deepEqual([...factsNeeded(ok('used>1y git:pushed'))].sort(), ['lastUsed', 'recoverability']);
  // `modified` is in the tree, not the fact layer.
  assert.deepEqual([...factsNeeded(ok('modified>90d'))], []);
});

/* ============================ the acceptance query ============================ */

test('the §2 acceptance query parses to exactly what it says', () => {
  const ast = ok('size>100mb ext:mp4 used>1y -in:node_modules');
  const found: string[] = [];
  const walk = (n: Ast): void => {
    if (n.kind === 'term') { found.push(n.term.kind); return; }
    if (n.kind === 'not') { found.push('not'); walk(n.operand); return; }
    walk(n.left); walk(n.right);
  };
  walk(ast);
  assert.deepEqual(found, ['size', 'ext', 'date', 'not', 'in']);
});
