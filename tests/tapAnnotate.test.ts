import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* eslint-disable */
const annotate = require('../scripts/tap-annotate') as {
  parseTap: (t: string) => { line: number; name: string; fields: Record<string, string> }[];
  parseCounts: (t: string) => string[];
  parseAsyncErrors: (t: string) => { line: number; text: string }[];
  looksLikeTap: (t: string) => boolean;
  escapeData: (s: string) => string;
  escapeProp: (s: string) => string;
  describe: (f: { fields: Record<string, string> }) => string;
  splitDirective: (rest: string) => { name: string; directive: string };
  unescapeName: (raw: string) => string;
  render: (t: string) => { annotations: string[]; summary: string };
};

/**
 * The CI annotator.
 *
 * Tested rather than trusted, because the inline bash it replaces was neither
 * and never worked: the step aborted on its first empty `grep` and threw away
 * the step summary, so three red runs in a row published a test name with no
 * assertion attached.
 *
 * The fixture is the point. An earlier version of this file was written
 * entirely from HAND-WRITTEN TAP, it passed, and four separate defects
 * survived it — a bare `...` inside a deep-equal diff truncating the message,
 * `expected:`/`actual:` rendering blank for every object comparison, a
 * failing `todo` spending one of the ten capped slots, and an apostrophe in a
 * message leaking its quotes. Every one of them is visible in the FIRST real
 * `node --test --test-reporter=tap` output anybody generates. So the fixture
 * below is a recording of exactly that, checked in verbatim, and the tests
 * read it rather than a convenient invention.
 */
/**
 * Recorded from `node --test --test-reporter=tap` on Node 24. CI runs Node 20,
 * and that mismatch is deliberate rather than overlooked: this file tests the
 * PARSER against a real artifact, not the runner that produced it. If node's
 * TAP shape ever changes, the parser is format-tolerant and the annotator only
 * runs on an already-failing job, so the cost of a drift is a poorer
 * annotation rather than a red build. Re-record it if node's output changes.
 */
const REAL = fs.readFileSync(path.join(__dirname, 'fixtures', 'real-node.tap'), 'utf8');
const byName = (name: string): { line: number; name: string; fields: Record<string, string> } => {
  const found = annotate.parseTap(REAL).find((f) => f.name === name);
  assert.ok(found, `the fixture should contain a failure named "${name}"`);
  return found!;
};

/* ----------------------- the assertion must travel ----------------------- */

test('a failure carries its assertion, not only its name', () => {
  const f = byName('object comparison');
  assert.match(f.fields.error, /Expected values to be strictly deep-equal/);
  assert.equal(f.fields.code, 'ERR_ASSERTION');
  assert.equal(f.fields.operator, 'deepStrictEqual');
  assert.equal(f.fields.location, '/repo/tests/sample.test.js:12:1');
});

test('a bare "..." inside a deep-equal diff does not truncate the failure', () => {
  // Node prints a lone `...` INSIDE a long diff to elide identical rows. The
  // first version of this parser read it as the YAML document terminator, so
  // the message stopped mid-array and `code`, `operator`, `expected`,
  // `actual` and `stack` were never read at all — a name without its
  // assertion, reintroduced by the very code written to prevent it.
  const f = byName('long deep-equal that elides rows');
  assert.match(f.fields.error, /\n\.\.\.\n/, 'the elision marker is kept as content');
  assert.match(f.fields.error, /-\s+999/, 'and the message continues past it to the actual difference');
  assert.equal(f.fields.code, 'ERR_ASSERTION', 'the fields after the block scalar survive');
  assert.equal(f.fields.operator, 'deepStrictEqual');
  assert.ok(f.fields.stack && f.fields.stack.length > 0, 'including the stack, which comes last');
});

test('expected and actual are read when node writes them as nested maps', () => {
  // A non-scalar `expected:` has nothing after the colon — the value is the
  // indented block beneath it. Reading the text after the colon gave '', and
  // `describe` then printed the literal `expected:   actual: `, showing the
  // reader blanks where the two numbers should be.
  const f = byName('object comparison');
  assert.equal(f.fields.expected, 'a: 2');
  assert.equal(f.fields.actual, 'a: 1');
  const text = annotate.describe(f);
  assert.match(text, /expected: a: 2/);
  assert.match(text, /actual: a: 1/);
});

test('a double-quoted value is unwrapped, not shown with its quotes', () => {
  // node serialises with `util.inspect`, which switches to double quotes the
  // moment a string contains an apostrophe — and this codebase's messages are
  // full of them.
  const f = byName('an apostrophe in the message');
  assert.equal(f.fields.error, "could not read the volume's free space");
});

test('a nested subtest failure is reported, and outranks its parent wrapper', () => {
  const all = annotate.parseTap(REAL);
  const child = all.findIndex((f) => f.name === 'the nested child');
  const parent = all.findIndex((f) => f.name === 'parent with a nested failure');
  assert.ok(child >= 0, 'the indented `not ok` is parsed');
  assert.ok(parent >= 0, 'so is the wrapper');
  assert.ok(child < parent, 'the one carrying a real assertion comes first');
  assert.match(all[child].fields.error, /5 !== 6/);
});

/* ------------------------- what must NOT appear ------------------------- */

test('an assertion message containing TAP does not manufacture a failure', () => {
  // The parser used to rescan the YAML block it had just consumed, so a
  // message quoting TAP produced an annotation for a test that never ran.
  // This repo's own annotator fixtures are wall-to-wall `not ok`, so the
  // first time THIS file failed, CI would have published phantom failures
  // and crowded out the real one under the ten-annotation cap.
  const names = annotate.parseTap(REAL).map((f) => f.name);
  assert.ok(!names.includes('phantom failure'), 'no test by that name exists');
  assert.ok(names.includes('an assertion message containing TAP'), 'the real one is still reported');
});

test('a failing todo is not reported as a failure', () => {
  // node excludes it from `# fail`, so reporting it spends a capped slot on
  // something nobody has to fix — and puts "# TODO" in the title.
  const names = annotate.parseTap(REAL).map((f) => f.name);
  assert.ok(!names.some((n) => n.includes('a failing todo')), 'the todo is left out');
  assert.ok(!names.some((n) => n.includes('#')) || names.includes('a name with # hash and: colon'));
});

test('the reported count agrees with the suite\'s own counter', () => {
  // The strongest single check in this file: if the parser invents a failure
  // or drops one, these two numbers stop matching.
  const reported = annotate.parseTap(REAL).length;
  const counter = annotate.parseCounts(REAL).find((c) => c.startsWith('# fail '));
  assert.ok(counter, 'the fixture carries a fail counter');
  assert.equal(reported, Number(counter!.slice('# fail '.length)), `parsed ${reported}, suite said ${counter}`);
});

/* ----------------------------- names ----------------------------- */

test('a TAP-escaped name comes back as it was written', () => {
  const f = byName('a name with # hash and: colon');
  assert.ok(f, 'the \\# escape is undone and the colon survives');
  assert.equal(annotate.unescapeName('a\\\\b\\#c'), 'a\\b#c');
});

test('a directive is split off the name, not kept in it', () => {
  assert.deepEqual(annotate.splitDirective('a failing todo # TODO'), { name: 'a failing todo', directive: 'TODO' });
  assert.deepEqual(annotate.splitDirective('plain name'), { name: 'plain name', directive: '' });
  assert.deepEqual(
    annotate.splitDirective('a name with \\# hash'),
    { name: 'a name with \\# hash', directive: '' },
    'an ESCAPED hash is part of the name, not a directive',
  );
});

/* --------------------------- robustness --------------------------- */

test('an empty run is reported, not crashed on', () => {
  // The old step died here: with no failures every grep matched nothing, and
  // `bash -e -o pipefail` turned "nothing to report" into a failed step.
  assert.deepEqual(annotate.parseTap('TAP version 13\n1..0\n# pass 0\n'), []);
  const { annotations, summary } = annotate.render('TAP version 13\n1..0\n# pass 0\n# fail 0\n');
  assert.match(summary, /No `not ok` line was found in this TAP output/);
  assert.ok(annotations.some((a) => a.includes('# fail 0')), 'the counters still come through');
});

test('a file that is not TAP says so, instead of diagnosing the suite', () => {
  // `npm test` uses the SPEC reporter when node's default changes or when a
  // developer runs this locally. Announcing "the suite did not get far enough
  // to report one" would be a confident falsehood in the one artefact that
  // exists to be trusted when nothing else is readable.
  const spec = '✔ a passing one (0.3ms)\n✖ a failing one (1ms)\nℹ fail 1\n';
  assert.equal(annotate.looksLikeTap(spec), false);
  assert.equal(annotate.looksLikeTap(REAL), true);
  assert.match(annotate.render(spec).summary, /This file is not TAP/);
});

test('CRLF input parses the same as LF', () => {
  // The Windows job is the motivating case, and it was untested.
  const crlf = REAL.replace(/\n/g, '\r\n');
  assert.deepEqual(
    annotate.parseTap(crlf).map((f) => f.name),
    annotate.parseTap(REAL).map((f) => f.name),
  );
  assert.equal(annotate.parseTap(crlf)[0].fields.code, annotate.parseTap(REAL)[0].fields.code);
});

test('a truncated file yields what it has, without throwing', () => {
  const cut = REAL.slice(0, REAL.indexOf('code:') + 4);
  const { annotations } = annotate.render(cut);
  assert.ok(Array.isArray(annotations));
});

test('a failure with no YAML block at all is still named', () => {
  const tap = 'TAP version 13\nnot ok 1 - bare failure\n# fail 1\n';
  const parsed = annotate.parseTap(tap);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'bare failure');
  assert.ok(annotate.render(tap).annotations[0].includes('no assertion was recorded'));
});

/* ------------------------------ the cap ------------------------------ */

test('when the cap bites, the failures carrying an assertion are the survivors', () => {
  const wrappers = Array.from(
    { length: 12 },
    (_, i) => `not ok ${String(i + 1)} - wrapper ${String(i)}\n  ---\n  error: 'test failed'\n  code: 'ERR_TEST_FAILURE'\n  ...`,
  ).join('\n');
  const real = "not ok 13 - the one that matters\n  ---\n  error: 'a real assertion'\n  code: 'ERR_ASSERTION'\n  ...";
  const { annotations } = annotate.render(`TAP version 13\n${wrappers}\n${real}\n# fail 13\n`);
  const errors = annotations.filter((a) => a.startsWith('::error'));
  assert.equal(errors.length, 10, 'capped at what GitHub will render');
  assert.ok(errors[0].includes('the one that matters'), 'the informative failure is first, not truncated away');
});

test('an async error is reported even when ten tests already failed', () => {
  // Appending async errors AFTER the ten failures meant they were dropped in
  // exactly the runs that had one — and an unhandled rejection is usually the
  // most informative line in the file.
  const many = Array.from({ length: 12 }, (_, i) => `not ok ${String(i + 1)} - t${String(i)}\n  ---\n  error: 'e'\n  ...`).join('\n');
  const { annotations } = annotate.render(`TAP version 13\n${many}\n# Error: connection closed after the test ended\n# fail 12\n`);
  const errors = annotations.filter((a) => a.startsWith('::error'));
  assert.equal(errors.length, 10);
  assert.ok(errors[0].includes('Async error after a test'), 'it goes first, inside the same budget');
});

/* ---------------------------- encoding ---------------------------- */

test('a name with a colon or comma survives the annotation encoding', () => {
  const title = annotate.escapeProp('Failing test: agent summary: raw+formatted bytes, stable ids');
  assert.ok(!title.includes(':'), 'colons are encoded');
  assert.ok(!title.includes(','), 'commas are encoded');
  assert.match(title, /agent summary%3A raw\+formatted bytes%2C stable ids/);
});

test('a percent sign and a newline survive the annotation body', () => {
  // A `%` encoded after the newlines would corrupt every `%0A` around it, so
  // the order of those two replacements is load-bearing.
  assert.equal(annotate.escapeData('100% sure\nreally'), '100%25 sure%0Areally');
});

test('every annotation is a single line', () => {
  // A literal newline in a workflow command truncates it and the rest is
  // printed as ordinary log text, which is how a multi-line assertion would
  // silently stop being an annotation.
  for (const a of annotate.render(REAL).annotations) {
    assert.ok(!a.includes('\n'), `annotation contains a raw newline: ${a.slice(0, 60)}`);
  }
});

test('consecutive failures with no YAML block are all reported', () => {
  // The parser used to advance past the line after every block-less failure,
  // so the loop's own `i++` skipped it: three consecutive bare `not ok`
  // lines came back as two. That is the fifth assertion-dropping defect this
  // file has had, and the rewrite was supposed to end them.
  const tap = 'TAP version 13\nnot ok 1 - first bare\nnot ok 2 - second bare\nnot ok 3 - third bare\n# fail 3\n';
  assert.deepEqual(
    annotate.parseTap(tap).map((f) => f.name),
    ['first bare', 'second bare', 'third bare'],
  );
});

test('an unterminated YAML block does not swallow the next failure', () => {
  // The key/value scan only stopped at the `...` terminator, so a stream that
  // lost one walked through the following `not ok` and consumed ITS fields
  // into the previous record — the earlier test vanished and the one before
  // it was published with someone else's assertion. The workflow merges
  // stderr into the TAP (`2>&1 | tee`), so an interleaved line is possible.
  const tap =
    "TAP version 13\nnot ok 1 - alpha\n  ---\n  error: 'first assertion'\nnot ok 2 - beta\n  ---\n  error: 'second assertion'\n  ...\n# fail 2\n";
  const parsed = annotate.parseTap(tap);
  assert.deepEqual(parsed.map((f) => f.name), ['alpha', 'beta'], 'both are reported');
  assert.equal(parsed[0].fields.error, 'first assertion', 'and each keeps its own assertion');
  assert.equal(parsed[1].fields.error, 'second assertion');
});

test('the reported line number points at the failure, not at its YAML terminator', () => {
  // `line` is printed as `TAP line N` in the step summary. It was read after
  // the parser had already moved past the block, so it pointed tens of lines
  // below the failure it names — a diagnostic aiming at the wrong place.
  const lines = REAL.split('\n');
  for (const f of annotate.parseTap(REAL)) {
    assert.match(
      lines[f.line - 1],
      /not ok /,
      `line ${String(f.line)} should be the "not ok" for "${f.name}", but is: ${lines[f.line - 1]}`,
    );
    assert.ok(lines[f.line - 1].includes(f.name.replace(/#/g, '\\#')), 'and it should be THIS failure’s line');
  }
});
