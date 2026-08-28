#!/usr/bin/env node
/*
 * Turn a TAP file into GitHub annotations that carry the ASSERTION, not just
 * the test name.
 *
 * Why this file exists, twice over:
 *
 * 1. The inline bash it replaces could not finish. GitHub runs `shell: bash`
 *    as `bash -e -o pipefail`, and the step's second pipeline was
 *    `grep '^# Error' … | head -5 | while …`. On any ordinary failure there
 *    are no `# Error` lines, so that grep exits 1, pipefail promotes it, and
 *    `-e` killed the step *before* it wrote the step summary. Every red run
 *    therefore published a test NAME and threw its assertion away — the exact
 *    loss the old step's own comment complained about, still happening.
 *
 * 2. Job logs need admin rights to read ("Must have admin rights to
 *    Repository" from the REST API), and step summaries are not in the public
 *    API at all. Annotations are the only channel a failure can reach anyone
 *    through — including a future session holding nothing but a repo URL — so
 *    the assertion has to travel IN the annotation.
 *
 * Plain CommonJS, run by `node`, deliberately: this is the LAST-RESORT
 * diagnostic step, and it must not depend on `npx`, on a transpiler, or on
 * the `.cmd` shim that `scripts/run-tests.js` exists to avoid. If `npm ci`
 * is what failed, `tsx` would not be there to explain it.
 *
 * Every parsing rule below was written against output from a real
 * `node --test --test-reporter=tap` run, not from hand-written fixtures.
 * Four defects survived the hand-written kind, and all four dropped the
 * assertion — see `tests/tapAnnotate.test.ts`, which now parses the recorded
 * article in `tests/fixtures/real-node.tap`.
 */

'use strict';

/** GitHub renders at most this many annotations of one level per step. */
const ANNOTATION_CAP = 10;

const indentOf = (line) => /^(\s*)/.exec(line)[1].length;

/** True when `line` is exactly `token` at exactly `indent` spaces. */
function isAt(line, indent, token) {
  return line !== undefined && indentOf(line) === indent && line.trim() === token;
}

/** TAP escapes `#` and `\` inside a description; undo that. */
function unescapeName(raw) {
  return raw.replace(/\\([\\#])/g, '$1');
}

/**
 * Split a TAP description from its trailing directive.
 *
 * `not ok 5 - a failing todo # TODO` is a todo that failed, which node
 * excludes from `# fail`. Taking everything after the separator as the name
 * put "# TODO" in the annotation title AND spent one of the ten slots on a
 * test that did not fail — crowding out one that did.
 */
function splitDirective(rest) {
  const m = /(^|[^\\])\s#\s*(.*)$/.exec(rest);
  if (!m) return { name: rest.trim(), directive: '' };
  return { name: rest.slice(0, m.index + m[1].length).trim(), directive: m[2].trim() };
}

/** Unwrap a single- or double-quoted YAML scalar. */
function unquote(value) {
  if (/^'.*'$/s.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  // Node serialises with `util.inspect`, which switches to double quotes as
  // soon as the string contains an apostrophe — and this codebase's messages
  // are full of them ("could not read the volume's free space").
  if (/^".*"$/s.test(value)) return value.slice(1, -1).replace(/\\"/g, '"');
  return value;
}

/**
 * Pull the failures out of a TAP stream.
 *
 * `not ok` is matched at any indentation, because a whole test FILE that dies
 * on import reports as a top-level `not ok <file>` whose real cause is a
 * nested one; taking only `^not ok` would report the wrapper and drop the
 * reason.
 */
function parseTap(text) {
  const lines = text.split(/\r?\n/);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)not ok\s+\d+\s*-?\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    // Captured BEFORE anything moves `i`. Reading it afterwards reported the
    // YAML terminator's line instead of the failure's — a diagnostic tool
    // pointing at the wrong line.
    const atLine = i + 1;
    const indent = m[1].length;
    const yamlIndent = indent + 2;
    const contentIndent = yamlIndent + 2;
    const { name, directive } = splitDirective(m[2]);
    const fields = {};

    if (isAt(lines[i + 1], yamlIndent, '---')) {
      let j = i + 2;
      let terminated = false;
      for (; j < lines.length; j++) {
        // ONLY a `...` at the block's own indent closes it. Node prints a
        // bare `...` INSIDE a long deep-equal diff to elide identical rows,
        // and treating that as the terminator truncated the message and lost
        // every field after it.
        if (isAt(lines[j], yamlIndent, '...')) { terminated = true; break; }
        // A line no more indented than the `not ok` itself cannot belong to
        // this block. Without this, a stream whose terminator was lost — the
        // workflow merges stderr into the TAP, so interleaving is possible —
        // ran straight through the NEXT `not ok`, swallowed that test and
        // attached its assertion to this one's name. A confidently wrong
        // annotation is worse than a missing one.
        if (lines[j].trim() !== '' && indentOf(lines[j]) <= indent) break;
        const kv = /^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(lines[j]);
        if (!kv || kv[1].length !== yamlIndent) continue;
        const key = kv[2];
        let value = kv[3];

        // Two shapes put the value on the FOLLOWING lines: a block scalar
        // (`error: |-`, `stack: |-`) and a nested map, which is how node
        // serialises a non-scalar `expected:`/`actual:`. Reading only the
        // text after the colon yields "|-" for the first and "" for the
        // second — an assertion that renders blank.
        if (value === '' || value === '|-' || value === '|' || value === '>-' || value === '>') {
          const block = [];
          let k = j + 1;
          for (; k < lines.length; k++) {
            if (isAt(lines[k], yamlIndent, '...')) break;
            if (lines[k].trim() !== '' && indentOf(lines[k]) <= yamlIndent) break;
            block.push(lines[k].slice(Math.min(indentOf(lines[k]), contentIndent)));
          }
          j = k - 1;
          value = block.join('\n').replace(/\s+$/, '');
        } else {
          value = unquote(value).trim();
        }
        fields[key] = value;
      }
      // Resume after the terminator when there was one, and BEFORE the line
      // that ended an unterminated block — that line is the next failure, and
      // skipping it is how the previous version dropped every other one of
      // several consecutive bare `not ok` lines.
      // `j` is always at least `i + 2` when a block was opened, so the
      // "resume before" case can never land on or behind the `not ok` itself.
      i = terminated ? j : j - 1;
    }
    // With no YAML block at all, `i` is untouched, so the loop's own `i++`
    // moves to the very next line rather than jumping over it.

    // A failing `todo` is not a failure the suite counts; reporting it spends
    // a capped slot on something nobody has to fix.
    if (/^todo\b/i.test(directive) || /^skip\b/i.test(directive)) continue;

    out.push({ line: atLine, name: unescapeName(name), fields });
  }

  // Drop `describe` SUITE wrappers whose only content is "N subtests failed".
  // Node prints one for every failing suite but excludes it from `# fail N` —
  // measured: two nested `describe` levels give 4 real failures, 2 wrappers,
  // and `# fail 4`. Reporting them double-counts against that figure and
  // spends capped annotation slots on lines that name no cause.
  //
  // `type` ALONE is not the test, and getting that wrong was worse than the
  // problem it fixed. Node uses `type: 'suite'` for two different things, and
  // the other one is `failureType: 'hookFailed'` — a `before`/`after` that
  // threw. There, the suite line is the ONLY record of the cause: the child
  // tests all pass, `# fail` reads 0, node exits 1, and dropping it left the
  // annotator emitting no error at all and printing "No `not ok` line was
  // found in this TAP output", which is false. A red build with nothing to
  // read is exactly what this file exists to prevent.
  //
  // A `test()` parent with a failing subtest carries the same
  // `'N subtests failed'` message and IS counted, so the message alone is not
  // the test either. Both fields together are.
  const kept = out.filter((f) => !(f.fields.type === 'suite' && f.fields.failureType === 'subtestsFailed'));

  // A failure carrying a real assertion outranks one that only says "test
  // failed": when the cap bites, the informative ones must be the survivors.
  return kept
    .map((f, idx) => ({ f, idx, informative: f.fields.error && f.fields.error !== 'test failed' ? 0 : 1 }))
    .sort((a, b) => a.informative - b.informative || a.idx - b.idx)
    .map((x) => x.f);
}

/** The suite's own counters — `# pass 1330`, `# fail 1`, and so on. */
function parseCounts(text) {
  return text.split(/\r?\n/).filter((l) => /^# (tests|suites|pass|fail|cancelled|skipped|todo) /.test(l));
}

/** Post-test async failures, which print as `# Error:` rather than `not ok`. */
function parseAsyncErrors(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^# Error/.test(lines[i])) out.push({ line: i + 1, text: lines[i] });
  }
  return out;
}

/** Does this file look like TAP at all? */
function looksLikeTap(text) {
  return /^TAP version/m.test(text) || /^\s*(not )?ok \d+/m.test(text);
}

/** Escape a value for the body of a `::error::` workflow command. */
function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escape a value used as a `title=` property of a workflow command. */
function escapeProp(s) {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** A nested map or a long array, flattened to one readable line. */
function oneLine(value, max = 160) {
  const flat = String(value).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * The one-line summary a person reads first: the assertion if there is one,
 * then the numbers that produced it.
 */
function describe(f) {
  const parts = [];
  if (f.fields.error) parts.push(f.fields.error);
  const shown = ['code', 'operator', 'expected', 'actual', 'failureType']
    .filter((k) => f.fields[k] !== undefined && f.fields[k] !== '')
    .map((k) => `${k}: ${oneLine(f.fields[k])}`);
  if (shown.length) parts.push(shown.join('  '));
  if (f.fields.location) parts.push(`at ${f.fields.location}`);
  return parts.join('\n');
}

function render(text) {
  const failures = parseTap(text);
  const asyncErrors = parseAsyncErrors(text);
  const counts = parseCounts(text);
  const isTap = looksLikeTap(text);

  const annotations = [];
  // Async errors first, and inside the SAME budget. They are usually the most
  // informative line in the file, and appending them after ten failures meant
  // they were silently dropped in exactly the runs that had one.
  for (const e of asyncErrors.slice(0, 5)) {
    annotations.push(`::error title=Async error after a test::${escapeData(`${e.line}: ${e.text}`)}`);
  }
  for (const f of failures.slice(0, Math.max(0, ANNOTATION_CAP - annotations.length))) {
    const body = describe(f);
    annotations.push(
      `::error title=${escapeProp(`Failing test: ${f.name}`)}::${escapeData(body || 'no assertion was recorded for this failure')}`,
    );
  }
  for (const c of counts) annotations.push(`::warning title=Suite summary::${escapeData(c)}`);

  const lines = ['## Failing tests', ''];
  if (failures.length === 0) {
    lines.push(
      isTap
        ? '_No `not ok` line was found in this TAP output — the suite did not get far enough to report one. See the raw log._'
        : '_This file is not TAP, so no test result could be read from it. The suite may have been run with a different reporter, or the job failed before the tests ran._',
      '',
    );
  }
  for (const f of failures) {
    lines.push(`### ${f.name}`, '', '```', `TAP line ${f.line}`, describe(f) || '(no assertion recorded)', '```', '');
    const others = Object.keys(f.fields)
      .filter((k) => !['error', 'code', 'operator', 'expected', 'actual', 'failureType', 'location', 'stack'].includes(k))
      .map((k) => `${k}: ${oneLine(f.fields[k])}`);
    if (others.length) lines.push('```', ...others, '```', '');
    if (f.fields.stack) lines.push('<details><summary>stack</summary>', '', '```', f.fields.stack, '```', '</details>', '');
  }
  if (asyncErrors.length) {
    lines.push('## Async errors after a test', '', '```', ...asyncErrors.map((e) => `${e.line}: ${e.text}`), '```', '');
  }
  lines.push('## Suite counters', '', '```', ...(counts.length ? counts : ['(none found)']), '```', '');
  return { annotations, summary: lines.join('\n') };
}

module.exports = {
  parseTap,
  parseCounts,
  parseAsyncErrors,
  looksLikeTap,
  escapeData,
  escapeProp,
  describe,
  splitDirective,
  unescapeName,
  render,
};

if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2] || 'test-output.tap';
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Reporting must never be what fails the job: the job has already failed,
    // and hiding the real cause behind "cannot open test-output.tap" makes a
    // red run unreadable. `if: failure()` also fires when the job never
    // reached the tests at all, so say which of the two this is.
    console.log(`::warning title=Annotator::no ${file} to read (${err.message}) — the job failed before the test step produced output`);
    process.exitCode = 0;
  }
  if (text) {
    try {
      const { annotations, summary } = render(text);
      for (const a of annotations) console.log(a);
      if (process.env.GITHUB_STEP_SUMMARY) {
        try {
          fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
        } catch {
          /* the annotations above already carry the failure */
        }
      } else {
        console.log(summary);
      }
    } catch (err) {
      // The last channel out of the run must not close because parsing
      // surprised us.
      console.log(`::warning title=Annotator::could not parse ${file} (${err && err.message}) — see the raw log`);
    }
    process.exitCode = 0;
  }
}
