#!/usr/bin/env node
/*
 * Turn the native core's cargo output (format check, clippy, tests) into
 * GitHub annotations that carry the CAUSE: the assertion a test failed on,
 * the signal a test binary died of, the lint and its location, the file
 * rustfmt would change.
 *
 * Why this file exists: CI's "Check the native core" step had never once
 * passed, and nobody could read why. Job logs need admin rights to read
 * through the REST API, step summaries are not in the public API at all, and
 * only the Node suite was annotated (scripts/tap-annotate.js) — so three red
 * runs in a row published nothing but "Process completed with exit code 101".
 * Annotations are the only channel a failure reaches anyone through, so the
 * cause has to travel IN the annotation.
 *
 * Plain CommonJS, run by `node`, deliberately — the same reasons as its
 * sibling: this is a last-resort diagnostic step, and it must not depend on a
 * transpiler, a registry fetch or the Windows `.cmd` shim.
 *
 * Every parsing rule was written against REAL cargo 1.98.1 output — the
 * version CI was running — recorded in tests/fixtures/cargo/: a plain run, a
 * run in CI's environment (CARGO_TERM_COLOR=always, RUST_BACKTRACE=short, so
 * ANSI escapes and backtraces), a test binary that aborts, a compile error,
 * and a test that runs past a minute. Three of the rules below exist only
 * because the real output differed from what one would write by hand: Rust
 * 1.98 prints a thread id in every panic line; a failing binary is named only
 * AFTER its failures, in cargo's rerun hint; and one failure prints
 * "1 target failed" where two print "2 targets failed".
 */

'use strict';

const { escapeData, escapeProp } = require('./tap-annotate');

/** GitHub renders at most this many annotations of one level per step. */
const ANNOTATION_CAP = 10;
/** How much of one failure's text an annotation carries. */
const MESSAGE_CAP = 3000;
/** Where the Rust workspace sits in the repository. */
const DEFAULT_WORKSPACE = 'native/treemap-core';

/** CSI sequences (colour, style) and OSC hyperlinks, which a forced-colour cargo emits. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function stripAnsi(text) {
  return String(text).replace(ANSI, '');
}

/**
 * Cargo's own status lines. Written against their full shape, not just the
 * verb, because a rustfmt diff's context lines are source code indented by
 * spaces and a looser rule would end a diff at the first `Finished` in it.
 */
const STATUS = [
  /^\s+Compiling \S+ v\d/,
  /^\s+Checking \S+ v\d/,
  /^\s+Finished `/,
  /^\s+Running (?:unittests )?\S+ \(/,
  /^\s+Doc-tests \S+$/,
  /^\s+(?:Blocking|Updating|Downloading|Downloaded|Locking|Adding|Fresh) /,
];
const isStatus = (line) => STATUS.some((re) => re.test(line));

const PANIC = /^thread '(.*?)'(?: \(\d+\))? panicked at (.+):(\d+):(\d+):$/;
const RERUN = /^error: test failed, to rerun pass `(.+)`$/;
const TARGETS_FAILED = /^error: \d+ targets? failed:$/;
const DIAGNOSTIC = /^error(?:\[(E\d{4})\])?: (.+)$/;
const LOCATION = /^\s*--> (.+):(\d+):(\d+)$/;
const HANG = /^test (.+) has been running for over (\d+) seconds$/;
const RESULT = /^test result: /;
const RUNNING_N = /^running (\d+) tests?$/;
const REPORTED = /^test .+ \.\.\. (?:ok|FAILED|ignored)/;

/** `error:` lines that are cargo's bookkeeping about a failure, never the failure itself. */
const NOISE = [/^could not compile /, /^aborting due to /, /^build failed/];

/**
 * A path as the repository knows it, or null when it is not a repository
 * file (the standard library, a dependency in the registry). Rustc prints
 * workspace-relative paths; rustfmt prints absolute ones; Windows prints
 * either with backslashes.
 */
function repoPath(raw, workspace = DEFAULT_WORKSPACE) {
  if (!raw) return null;
  const p = String(raw).replace(/\\/g, '/');
  const ws = String(workspace).replace(/\\/g, '/').replace(/\/+$/, '');
  const absolute = p.startsWith('/') || /^[A-Za-z]:\//.test(p);
  if (!absolute) {
    const rel = p.replace(/^\.\//, '');
    return rel.startsWith('../') ? null : `${ws}/${rel}`;
  }
  const at = p.indexOf(`/${ws}/`);
  return at === -1 ? null : p.slice(at + 1);
}

const trimBlankEdges = (lines) => {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === '') a++;
  while (b > a && lines[b - 1].trim() === '') b--;
  return lines.slice(a, b);
};

/** A backtrace line, or the notes that frame one: never part of an assertion. */
const isBacktraceNoise = (line) =>
  line === 'stack backtrace:' ||
  /^\s+\d+: /.test(line) ||
  /^\s+at \S/.test(line) ||
  /^note: run with `RUST_BACKTRACE/.test(line) ||
  /^note: Some details are omitted/.test(line);

/**
 * One `---- name stdout ----` block: the test thread's own panic is the
 * assertion; anything else it printed (another thread's panic, a report the
 * test wrote before asserting) is context, kept because it is often the
 * answer — the governor's hold tests print their per-second shares first.
 */
function parseFailureBody(name, body) {
  const panics = [];
  const other = [];
  for (let k = 0; k < body.length; k++) {
    const line = body[k];
    const p = PANIC.exec(line);
    if (!p) {
      if (!isBacktraceNoise(line)) other.push(line);
      continue;
    }
    const msg = [];
    let q = k + 1;
    for (; q < body.length; q++) {
      if (PANIC.test(body[q]) || isBacktraceNoise(body[q])) break;
      msg.push(body[q]);
    }
    panics.push({
      thread: p[1],
      location: { path: p[2], line: Number(p[3]), col: Number(p[4]) },
      message: trimBlankEdges(msg).join('\n'),
    });
    k = q - 1;
  }
  const primary = panics.find((x) => x.thread === name) || panics[panics.length - 1] || null;
  const context = [
    ...panics.filter((x) => x !== primary).map((x) => `thread '${x.thread}' panicked at ${x.location.path}:${x.location.line}:${x.location.col}: ${x.message}`),
    ...trimBlankEdges(other),
  ];
  return {
    name,
    binary: null,
    message: primary ? primary.message : '(the test printed no panic message)',
    location: primary ? primary.location : null,
    context: context.join('\n').trim(),
  };
}

/** Everything a failed cargo run says, in the order it said it. */
function parseCargo(text, workspace = DEFAULT_WORKSPACE) {
  const lines = stripAnsi(text).split(/\r?\n/);
  const out = { tests: [], crashes: [], diagnostics: [], fmt: [], hangs: [], failedTargets: [], results: [] };
  const fmtSeen = new Set();
  // The binary being run: its failures wait here for the rerun hint that names it.
  let current = { label: null, tests: [], hangs: [], total: 0, reported: 0 };
  const settle = (binary) => {
    for (const t of current.tests) out.tests.push({ ...t, binary });
    for (const h of current.hangs) out.hangs.push({ ...h, binary });
    current = { label: null, tests: [], hangs: [], total: 0, reported: 0 };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;

    // rustfmt: `Diff in <absolute path>:<line>:` — one finding per file, at its first diff.
    if ((m = /^Diff in (.+):(\d+):$/.exec(line))) {
      const diff = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (/^Diff in /.test(l) || isStatus(l) || /^(?:error|warning)[:[]/.test(l)) break;
        if (l !== '' && !/^[ +-]/.test(l)) break;
        diff.push(l);
      }
      i = j - 1;
      const file = repoPath(m[1], workspace) || m[1].replace(/\\/g, '/');
      if (!fmtSeen.has(file)) {
        fmtSeen.add(file);
        out.fmt.push({ path: file, line: Number(m[2]), diff: trimBlankEdges(diff).join('\n') });
      }
      continue;
    }

    if ((m = /^\s+Running (?:unittests )?(\S+) \(/.exec(line)) || (m = /^\s+Doc-tests (\S+)$/.exec(line))) {
      // A binary whose failures never got a rerun hint keeps the label it ran under.
      if (current.tests.length || current.hangs.length) settle(current.label);
      current.label = m[1];
      continue;
    }
    if ((m = RUNNING_N.exec(line))) {
      current.total = Number(m[1]);
      continue;
    }
    if (REPORTED.test(line)) {
      current.reported++;
      continue;
    }
    if ((m = HANG.exec(line))) {
      current.hangs.push({ name: m[1], binary: null, seconds: Number(m[2]) });
      continue;
    }

    // libtest: one block per failing test.
    if ((m = /^---- (.+) stdout ----$/.exec(line))) {
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (/^---- .+ stdout ----$/.test(l) || l === 'failures:' || RESULT.test(l) || RERUN.test(l) || isStatus(l)) break;
        body.push(l);
      }
      i = j - 1;
      current.tests.push(parseFailureBody(m[1], body));
      continue;
    }

    if (RESULT.test(line)) {
      out.results.push(line.trim());
      continue;
    }

    // The rerun hint names the binary; a `Caused by` after it means the binary itself died.
    if ((m = RERUN.exec(line))) {
      const binary = m[1];
      const { total, reported } = current;
      settle(binary);
      for (let k = i + 1; k < Math.min(lines.length, i + 4); k++) {
        if (lines[k].trim() !== 'Caused by:') continue;
        const cause = (lines[k + 1] || '').trim();
        const status = /\(([^()]*)\)\s*$/.exec(cause);
        out.crashes.push({ binary, cause: status ? status[1] : cause, total, reported });
        i = k + 1;
        break;
      }
      continue;
    }

    if (TARGETS_FAILED.test(line)) {
      let j = i + 1;
      for (; j < lines.length && (m = /^\s+`(.+)`$/.exec(lines[j])); j++) out.failedTargets.push(m[1]);
      i = j - 1;
      continue;
    }

    // A compiler or clippy error: the block runs to the first blank line.
    if ((m = DIAGNOSTIC.exec(line))) {
      if (NOISE.some((re) => re.test(m[2]))) continue;
      const block = [line];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === '' || isStatus(l) || /^(?:error|warning)[:[]/.test(l)) break;
        block.push(l);
      }
      i = j - 1;
      const at = block.map((l) => LOCATION.exec(l)).find(Boolean);
      out.diagnostics.push({
        code: m[1] || null,
        message: m[2],
        block: block.join('\n'),
        location: at ? { path: at[1], line: Number(at[2]), col: Number(at[3]) } : null,
      });
    }
  }
  if (current.tests.length || current.hangs.length) settle(current.label);
  return out;
}

const cap = (s) => (s.length > MESSAGE_CAP ? `${s.slice(0, MESSAGE_CAP)}\n… (truncated)` : s);

/**
 * One workflow command. `at` is already a repository path — the caller
 * resolves it, because a rustfmt path arrives resolved and a rustc one does
 * not, and resolving twice doubles the workspace prefix.
 */
function annotation(level, title, body, at) {
  const props = [];
  if (at && at.file) {
    props.push(`file=${escapeProp(at.file)}`, `line=${at.line}`);
    if (at.col) props.push(`col=${at.col}`);
  }
  props.push(`title=${escapeProp(title)}`);
  return `::${level} ${props.join(',')}::${escapeData(cap(body))}`;
}

/** A rustc or panic location, resolved to the repository; null when it is not a repository file. */
const resolved = (location, workspace) => {
  const file = location ? repoPath(location.path, workspace) : null;
  return file ? { file, line: location.line, col: location.col } : null;
};

/** The annotations and the step summary for one cargo log. */
function render(text, workspace = DEFAULT_WORKSPACE) {
  const parsed = parseCargo(text, workspace);
  const findings = [
    ...parsed.tests.map((t) => ({
      label: `test ${t.name}`,
      line: annotation('error', `Failing Rust test: ${t.name} (${t.binary || 'unknown binary'})`, t.context ? `${t.message}\n\n${t.context}` : t.message, resolved(t.location, workspace)),
    })),
    ...parsed.crashes.map((c) => ({
      label: `crash of ${c.binary}`,
      line: annotation(
        'error',
        `Rust test binary crashed: ${c.binary}`,
        `The test binary crashed (${c.cause}) after ${c.reported} of ${c.total} tests had reported. libtest names a test only when it finishes, so the one that crashed is among the ${Math.max(0, c.total - c.reported)} that never reported.`,
        null,
      ),
    })),
    ...parsed.diagnostics.map((d) => ({
      label: `${d.code ? `error[${d.code}]` : 'error'}: ${d.message}`,
      line: annotation('error', `${d.code ? `error[${d.code}]` : 'error'}: ${d.message}`, d.block, resolved(d.location, workspace)),
    })),
    ...parsed.fmt.map((f) => ({
      label: `not formatted: ${f.path}`,
      line: annotation('error', `Not formatted: ${f.path}`, `rustfmt would change this file; run \`cargo fmt --all\` in ${workspace}. Its first difference:\n${f.diff}`, { file: f.path, line: f.line, col: 0 }),
    })),
  ];

  const annotations = findings.slice(0, ANNOTATION_CAP).map((f) => f.line);
  const omitted = findings.slice(ANNOTATION_CAP);
  for (const h of parsed.hangs.slice(0, 5)) {
    annotations.push(`::warning title=${escapeProp(`Slow Rust test: ${h.name}`)}::${escapeData(`${h.name} (${h.binary || 'unknown binary'}) was still running after ${h.seconds} seconds — if the step then timed out, this is the test that hung.`)}`);
  }
  if (parsed.failedTargets.length) {
    annotations.push(`::warning title=Rust test binaries that failed::${escapeData(parsed.failedTargets.join('\n'))}`);
  }
  if (omitted.length) {
    annotations.push(
      `::warning title=${escapeProp(`Not annotated: ${omitted.length} more findings (GitHub shows ${ANNOTATION_CAP} errors per step)`)}::${escapeData(omitted.map((f) => f.label).join('\n'))}`,
    );
  }
  if (findings.length === 0 && parsed.hangs.length === 0 && parsed.failedTargets.length === 0) {
    annotations.push('::warning title=Rust annotator::no failure could be read from this cargo log — if a Rust step failed, the cause is in the raw log');
  }

  const lines = ['## Native core (Rust)', ''];
  const section = (heading, items) => {
    if (!items.length) return;
    lines.push(`### ${heading}`, '');
    for (const it of items) lines.push('```', it, '```', '');
  };
  section('Failing tests', parsed.tests.map((t) => `${t.name} (${t.binary || 'unknown binary'})${t.location ? ` at ${t.location.path}:${t.location.line}:${t.location.col}` : ''}\n${t.message}${t.context ? `\n\n${t.context}` : ''}`));
  section('Crashed test binaries', parsed.crashes.map((c) => `${c.binary}: ${c.cause} (${c.reported} of ${c.total} tests had reported)`));
  section('Compiler and clippy errors', parsed.diagnostics.map((d) => d.block));
  section('Not formatted', parsed.fmt.map((f) => `${f.path}:${f.line}\n${f.diff}`));
  section('Slow tests', parsed.hangs.map((h) => `${h.name} (${h.binary || 'unknown binary'}): over ${h.seconds} s`));
  section('Results', parsed.results.length ? [parsed.results.join('\n')] : []);
  return { annotations, summary: lines.join('\n') };
}

module.exports = { stripAnsi, parseCargo, repoPath, render };

if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2] || 'cargo-output.log';
  const workspace = process.argv[3] || DEFAULT_WORKSPACE;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Reporting must never be what fails the job: it has already failed, and
    // `if: failure()` also fires when the job died before any Rust step ran.
    console.log(`::warning title=Rust annotator::no ${file} to read (${err.message}) — the job failed before a Rust step produced output`);
    process.exitCode = 0;
  }
  if (text) {
    try {
      const { annotations, summary } = render(text, workspace);
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
      console.log(`::warning title=Rust annotator::could not parse ${file} (${err && err.message}) — see the raw log`);
    }
    process.exitCode = 0;
  }
}
