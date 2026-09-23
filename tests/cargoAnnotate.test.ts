import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* eslint-disable */
interface Location { path: string; line: number; col: number }
interface TestFailure { name: string; binary: string | null; message: string; location: Location | null }
interface Crash { binary: string; cause: string }
interface Diagnostic { code: string | null; message: string; block: string; location: Location | null }
interface FmtFile { path: string; line: number; diff: string }
interface Hang { name: string; binary: string | null; seconds: number }
interface Parsed {
  tests: TestFailure[];
  crashes: Crash[];
  diagnostics: Diagnostic[];
  fmt: FmtFile[];
  hangs: Hang[];
  failedTargets: string[];
  results: string[];
}
const annotate = require('../scripts/cargo-annotate') as {
  stripAnsi: (t: string) => string;
  parseCargo: (t: string) => Parsed;
  repoPath: (p: string, workspace: string) => string | null;
  render: (t: string, workspace?: string) => { annotations: string[]; summary: string };
};

/**
 * The CI annotator for the native core's format, lint and test steps.
 *
 * It exists because CI's Rust step had never once passed, and nobody without
 * admin rights could read why: job logs need admin rights, and only the Node
 * suite was annotated. Three red runs in a row published nothing but "exit
 * code 101".
 *
 * The fixtures are `.txt`, not `.log`: `*.log` is git-ignored here, and the
 * first commit of this file shipped without them — green on this machine,
 * where they sat on disk, and bound to fail on every CI leg.
 *
 * Every fixture under tests/fixtures/cargo/ is REAL output from cargo 1.98.1
 * (the version CI was running), captured on macOS from a scratch workspace
 * with a deliberate format diff, a clippy error, failing tests in two
 * binaries, a binary that aborts, a compile error, and a test that runs past
 * a minute. The only edit is the scratch folder's absolute prefix, rewritten
 * to CI's checkout layout so the path-cutting rule is exercised the way CI
 * exercises it. `ci-env.log` was captured with the environment the Rust setup
 * action gives CI — CARGO_TERM_COLOR=always and RUST_BACKTRACE=short — so it
 * carries ANSI escapes and backtraces. Hand-written fixtures would have missed
 * the thread id Rust 1.98 prints in every panic line, that a failing binary is
 * only named after its failures (in the rerun hint), and that one failure
 * prints "1 target failed" where two print "2 targets failed".
 */
const FIXTURES = path.join(__dirname, 'fixtures', 'cargo');
const read = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const PLAIN = read('plain.txt');
const CI_ENV = read('ci-env.txt');
const CRASH = read('crash.txt');
const COMPILE_ERROR = read('compile-error.txt');
const HANG = read('hang.txt');
const CONTEXT = read('context.txt');
const WS = 'native/treemap-core';

const failure = (parsed: Parsed, name: string): TestFailure => {
  const found = parsed.tests.find((t) => t.name === name);
  assert.ok(found, `expected a failing test named "${name}", got ${JSON.stringify(parsed.tests.map((t) => t.name))}`);
  return found!;
};

/* ─────────────────────── a failing test carries its assertion ─────────────────────── */

test('every failing test is found, named, and tied to the binary cargo names in its rerun hint', () => {
  const parsed = annotate.parseCargo(PLAIN);

  assert.deepEqual(
    parsed.tests.map((t) => [t.name, t.binary]),
    [
      ['a_panic_with_a_message', '-p alpha --test walk'],
      ['an_equality_that_fails', '-p alpha --test walk'],
      ['a_bound_that_fails', '-p alpha --test walk'],
      ['tests::beta_fails_too', '-p beta --lib'],
    ],
  );
});

test('the assertion travels: left, right and the custom message, not only the test name', () => {
  const t = failure(annotate.parseCargo(PLAIN), 'an_equality_that_fails');

  assert.match(t.message, /assertion `left == right` failed: the sum is wrong: 2/);
  assert.match(t.message, /left: 2/);
  assert.match(t.message, /right: 3/);
  assert.doesNotMatch(t.message, /RUST_BACKTRACE/, 'the backtrace hint is not the assertion');
  assert.deepEqual(t.location, { path: 'crates/alpha/tests/walk.rs', line: 6, col: 5 });
});

test('a message spanning several lines keeps every line', () => {
  const t = failure(annotate.parseCargo(PLAIN), 'tests::beta_fails_too');

  assert.equal(t.message, 'a multi-line message\nsecond line\nthird line');
  assert.deepEqual(t.location, { path: 'crates/beta/src/lib.rs', line: 7, col: 9 });
});

test('the thread id Rust 1.98 prints in a panic line does not break the location', () => {
  // `thread 'name' (5639602) panicked at crates/alpha/tests/walk.rs:11:5:`
  const t = failure(annotate.parseCargo(PLAIN), 'a_panic_with_a_message');

  assert.equal(t.message, 'take() did not return within 300ms');
  assert.deepEqual(t.location, { path: 'crates/alpha/tests/walk.rs', line: 11, col: 5 });
});

test('CI’s colour codes and short backtraces change nothing: the same failures, clean messages, no frames', () => {
  const plain = annotate.parseCargo(PLAIN);
  const ci = annotate.parseCargo(CI_ENV);

  assert.deepEqual(
    ci.tests.map((t) => JSON.stringify([t.name, t.binary, t.location])).sort(),
    plain.tests.map((t) => JSON.stringify([t.name, t.binary, t.location])).sort(),
  );
  for (const t of ci.tests) {
    assert.ok(!t.message.includes('\u001b'), `no escape code survives in ${t.name}`);
    assert.doesNotMatch(t.message, /stack backtrace|rust_begin_unwind|core::panicking/, `no backtrace frame in ${t.name}`);
  }
  assert.equal(failure(ci, 'a_bound_that_fails').message, '[balanced@19%] mean of the last half 0.3100 is outside ±0.05 of 0.19');
});

test('stripAnsi removes colour and style codes and leaves the text', () => {
  assert.equal(annotate.stripAnsi('\u001b[1m\u001b[91merror\u001b[0m\u001b[1m: boom\u001b[0m'), 'error: boom');
  assert.equal(annotate.stripAnsi('plain'), 'plain');
});

test('the test thread’s own panic is the assertion; a worker’s panic and a printed report before it are kept as context', () => {
  // The governor's hold tests print their per-second shares before asserting,
  // and a walk's worker panics before the test's own assertion fails — both
  // are often the answer, and both print BEFORE the assertion.
  const t = failure(annotate.parseCargo(CONTEXT), 'tests::a_report_then_a_worker_panic_then_the_assertion');

  assert.equal(t.message, 'the walk ended with a worker panic');
  assert.deepEqual(t.location, { path: 'crates/beta/src/lib.rs', line: 13, col: 9 });
  const context = (t as TestFailure & { context: string }).context;
  assert.match(context, /per-second means: 0\.30 0\.31 0\.31/);
  assert.match(context, /thread 'tm-walk-worker-0' panicked at crates\/beta\/src\/lib\.rs:10:23: fixture panic: directory 7/);
  assert.doesNotMatch(context, /RUST_BACKTRACE/);

  const body = annotate.render(CONTEXT, WS).annotations.find((a) => a.includes('a_report_then_a_worker_panic'));
  assert.match(body!, /::the walk ended with a worker panic%0A%0A/, 'the assertion leads; the context follows it');
});

/* ─────────────────────── a binary that crashes has no panic block ─────────────────────── */

test('a test binary killed by a signal is a finding of its own, with the signal', () => {
  const parsed = annotate.parseCargo(CRASH);

  assert.equal(parsed.crashes.length, 1);
  assert.equal(parsed.crashes[0].binary, '-p beta --lib');
  assert.match(parsed.crashes[0].cause, /signal: 6, SIGABRT/);
  assert.ok(!parsed.tests.some((t) => t.binary === '-p beta --lib'), 'a crash is not dressed up as a named test failure');
});

/* ─────────────────────── compiler and clippy diagnostics ─────────────────────── */

test('a clippy error carries its message, its location and its help lines', () => {
  const parsed = annotate.parseCargo(PLAIN);

  assert.equal(parsed.diagnostics.length, 1, JSON.stringify(parsed.diagnostics.map((d) => d.message)));
  const d = parsed.diagnostics[0];
  assert.equal(d.message, 'useless conversion to the same type: `i64`');
  assert.equal(d.code, null);
  assert.deepEqual(d.location, { path: 'crates/alpha/src/lib.rs', line: 2, col: 31 });
  assert.match(d.block, /help: consider removing `i64::from\(\)`/);
  assert.match(d.block, /implied by `-D warnings`/);
});

test('a compile error carries its E-code', () => {
  const parsed = annotate.parseCargo(COMPILE_ERROR);

  assert.equal(parsed.diagnostics.length, 1);
  assert.equal(parsed.diagnostics[0].code, 'E0308');
  assert.equal(parsed.diagnostics[0].message, 'mismatched types');
  assert.deepEqual(parsed.diagnostics[0].location, { path: 'crates/beta/src/lib.rs', line: 6, col: 22 });
});

test('cargo’s own bookkeeping lines are not findings', () => {
  const all = [PLAIN, CI_ENV, CRASH, COMPILE_ERROR, HANG].map((t) => annotate.parseCargo(t));
  const messages = all.flatMap((p) => p.diagnostics.map((d) => d.message));

  for (const noise of [/could not compile/, /build failed, waiting/, /test failed, to rerun/, /targets? failed/, /For more information/]) {
    assert.ok(!messages.some((m) => noise.test(m)), `${noise} must not be reported as a diagnostic: ${JSON.stringify(messages)}`);
  }
});

/* ─────────────────────── rustfmt ─────────────────────── */

test('an unformatted file is one finding per file, at its first diff, with the path cut to the repository', () => {
  const parsed = annotate.parseCargo(PLAIN);

  assert.deepEqual(
    parsed.fmt.map((f) => [f.path, f.line]),
    [
      ['native/treemap-core/crates/alpha/src/lib.rs', 1],
      ['native/treemap-core/crates/alpha/tests/walk.rs', 8],
      ['native/treemap-core/crates/beta/src/lib.rs', 4],
    ],
  );
  assert.match(parsed.fmt[0].diff, /^-pub fn widen\(x: i64\) -> i64 \{ i64::from\(x\) \}$/m);
  assert.doesNotMatch(parsed.fmt[2].diff, /Checking/, 'the diff ends where cargo’s own status lines begin');
});

/* ─────────────────────── the summary ─────────────────────── */

test('the failed targets and every test-result line are collected for the summary', () => {
  const parsed = annotate.parseCargo(PLAIN);

  assert.deepEqual(parsed.failedTargets, ['-p alpha --test walk', '-p beta --lib']);
  assert.ok(parsed.results.some((r) => r.startsWith('test result: FAILED. 1 passed; 3 failed')), JSON.stringify(parsed.results));
  assert.deepEqual(annotate.parseCargo(HANG).failedTargets, ['-p beta --lib'], 'the singular "1 target failed" too');
});

/* ─────────────────────── a test that hangs ─────────────────────── */

test('a test that runs past a minute is reported, so a hang has a name before the job times out', () => {
  const parsed = annotate.parseCargo(HANG);

  assert.equal(parsed.hangs.length, 1, JSON.stringify(parsed.hangs));
  assert.equal(parsed.hangs[0].name, 'tests::beta_hangs_past_a_minute');
  assert.equal(parsed.hangs[0].seconds, 60);
  assert.equal(parsed.hangs[0].binary, '-p beta --lib');
});

/* ─────────────────────── Windows paths and line endings ─────────────────────── */

test('repoPath: a workspace-relative path gains the workspace; an absolute one is cut at it; any other is not a repository file', () => {
  assert.equal(annotate.repoPath('crates/tm-walk/src/walk.rs', WS), 'native/treemap-core/crates/tm-walk/src/walk.rs');
  assert.equal(annotate.repoPath('crates\\tm-walk\\src\\walk.rs', WS), 'native/treemap-core/crates/tm-walk/src/walk.rs');
  assert.equal(
    annotate.repoPath('/home/runner/work/TreeMap-Disk-Visualizer/TreeMap-Disk-Visualizer/native/treemap-core/crates/tm-walk/tests/walk.rs', WS),
    'native/treemap-core/crates/tm-walk/tests/walk.rs',
  );
  assert.equal(
    annotate.repoPath('D:\\a\\TreeMap-Disk-Visualizer\\TreeMap-Disk-Visualizer\\native\\treemap-core\\crates\\tm-walk\\src\\walk.rs', WS),
    'native/treemap-core/crates/tm-walk/src/walk.rs',
  );
  assert.equal(annotate.repoPath('/rustc/48a229cea/library/core/src/panicking.rs', WS), null, 'the standard library is not in the repository');
  assert.equal(annotate.repoPath('/home/runner/.cargo/registry/src/index.crates.io-1/napi-3.4.0/src/lib.rs', WS), null, 'nor is a dependency');
});

test('Windows output — backslash paths and CRLF line endings — parses exactly like the macOS capture', () => {
  // Derived from the real capture, not recorded on Windows (no Windows machine
  // here): cargo on Windows passes rustc backslash paths, so they come back in
  // `-->` lines and in `panicked at`; and a log can carry CRLF.
  const windows = PLAIN
    .replace(/crates\/(alpha|beta)\/(src|tests)\/(\w+)\.rs/g, 'crates\\$1\\$2\\$3.rs')
    .replace(/\/home\/runner\/work\/TreeMap-Disk-Visualizer\/TreeMap-Disk-Visualizer\/native\/treemap-core\//g, 'D:\\a\\TreeMap-Disk-Visualizer\\TreeMap-Disk-Visualizer\\native\\treemap-core\\')
    .replace(/\n/g, '\r\n');
  assert.notEqual(windows, PLAIN, 'the derivation changed something');

  const w = annotate.parseCargo(windows);
  const p = annotate.parseCargo(PLAIN);
  const repo = (t: TestFailure): string | null => (t.location ? annotate.repoPath(t.location.path, WS) : null);

  assert.deepEqual(
    w.tests.map((t) => [t.name, t.binary, repo(t), t.location?.line, t.message]),
    p.tests.map((t) => [t.name, t.binary, repo(t), t.location?.line, t.message]),
  );
  assert.deepEqual(w.fmt.map((f) => [f.path, f.line]), p.fmt.map((f) => [f.path, f.line]));
  assert.deepEqual(w.diagnostics.map((d) => d.location && annotate.repoPath(d.location.path, WS)), ['native/treemap-core/crates/alpha/src/lib.rs']);
});

/* ─────────────────────── rendering ─────────────────────── */

test('render: a failing test becomes an ::error with the repository file, line and column, and the assertion in the body', () => {
  const { annotations } = annotate.render(PLAIN, WS);
  const a = annotations.find((x) => x.includes('an_equality_that_fails'));

  assert.ok(a, JSON.stringify(annotations));
  assert.match(a!, /^::error file=native\/treemap-core\/crates\/alpha\/tests\/walk\.rs,line=6,col=5,title=/);
  assert.match(a!, /title=Failing Rust test%3A an_equality_that_fails \(-p alpha --test walk\)::/, 'the title escapes its colon');
  assert.match(a!, /::assertion `left == right` failed: the sum is wrong: 2%0A  left: 2%0A right: 3/, 'the body keeps its lines, escaped');
});

test('render: tests and crashes come first, then diagnostics, then formatting — and every one fits here', () => {
  const { annotations } = annotate.render(PLAIN, WS);
  const errors = annotations.filter((a) => a.startsWith('::error'));

  assert.equal(errors.length, 4 + 1 + 3, JSON.stringify(errors.map((e) => e.slice(0, 90))));
  const kinds = errors.map((e) => (e.includes('Failing Rust test') ? 't' : e.includes('title=Not formatted') ? 'f' : 'd'));
  assert.equal(kinds.join(''), 'ttttdfff');
});

test('render: an unformatted file is annotated at its own repository path, not the workspace prefixed twice', () => {
  // Found by running CI's steps on this repository: the fmt finding's path is
  // already the repository's, and resolving it again against the workspace
  // produced native/treemap-core/native/treemap-core/… — a file GitHub cannot
  // attach the annotation to.
  const { annotations } = annotate.render(PLAIN, WS);
  const fmt = annotations.filter((a) => a.includes('title=Not formatted'));

  assert.equal(fmt.length, 3);
  assert.match(fmt[0], /^::error file=native\/treemap-core\/crates\/alpha\/src\/lib\.rs,line=1,title=/);
  for (const a of annotations) assert.doesNotMatch(a, /native\/treemap-core\/native\/treemap-core/, a.slice(0, 120));
});

test('render: past the ten-error cap, the omitted findings are named in a warning — nothing is dropped silently', () => {
  // Twelve failing tests: the real block from the fixture, repeated under new names.
  const block = PLAIN.slice(PLAIN.indexOf('---- an_equality_that_fails stdout ----'), PLAIN.indexOf('---- a_bound_that_fails stdout ----'));
  const many = Array.from({ length: 12 }, (_, i) => block.replace(/an_equality_that_fails/g, `generated_${String(i).padStart(2, '0')}`)).join('');
  const text = `     Running tests/walk.rs (target/debug/deps/walk-0)\n\nrunning 12 tests\n\nfailures:\n\n${many}\nfailures:\n\ntest result: FAILED. 0 passed; 12 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\nerror: test failed, to rerun pass \`-p alpha --test walk\`\n`;

  const { annotations } = annotate.render(text, WS);
  const errors = annotations.filter((a) => a.startsWith('::error'));
  const omitted = annotations.find((a) => a.includes('title=Not annotated'));

  assert.equal(errors.length, 10);
  assert.ok(omitted, 'a warning names what did not fit');
  assert.match(omitted!, /generated_10/);
  assert.match(omitted!, /generated_11/);
});

test('render: a crash, a hang and the failed-targets list each reach an annotation', () => {
  const crash = annotate.render(CRASH, WS).annotations;
  assert.ok(crash.some((a) => a.startsWith('::error') && a.includes('crashed') && a.includes('SIGABRT')), JSON.stringify(crash));

  const hang = annotate.render(HANG, WS).annotations;
  assert.ok(hang.some((a) => a.startsWith('::warning') && a.includes('tests::beta_hangs_past_a_minute') && a.includes('60')), JSON.stringify(hang));

  const plain = annotate.render(PLAIN, WS).annotations;
  assert.ok(plain.some((a) => a.startsWith('::warning') && a.includes('-p alpha --test walk') && a.includes('-p beta --lib')), JSON.stringify(plain));
});

test('render: a log with no failure it can read says so, rather than printing nothing', () => {
  const { annotations } = annotate.render('    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.21s\n', WS);

  assert.ok(annotations.some((a) => a.startsWith('::warning') && /no .*failure/i.test(a)), JSON.stringify(annotations));
});

/* ─────────────────────── the workflow feeds it ─────────────────────── */

/** One step of test.yml, by its exact name: its lines up to the next step. */
function step(workflow: string, name: string): string {
  const parts = workflow.split('\n      - name: ');
  const found = parts.find((p) => p.split('\n')[0] === name);
  assert.ok(found, `test.yml has a step named "${name}"`);
  return found!;
}

test('the workflow: three Rust steps each append to the log, run whatever failed before them, and the tests do not stop at the first failure', () => {
  const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'test.yml'), 'utf8');

  for (const [name, command] of [
    ["Check the native core's format", 'cargo fmt --all -- --check'],
    ['Lint the native core', 'cargo clippy --workspace --all-targets -- -D warnings'],
    ['Test the native core', 'cargo test --workspace --no-fail-fast'],
  ] as const) {
    const s = step(ci, name);
    assert.match(s, /\n {8}if: \$\{\{ !cancelled\(\) \}\}\n/, `${name} runs even when an earlier step failed`);
    assert.match(s, /\n {8}working-directory: native\/treemap-core\n/, `${name} runs in the workspace, where the toolchain file is`);
    assert.match(s, /set -o pipefail/, `${name}: a failing cargo is not masked by tee`);
    assert.ok(s.includes(`${command} 2>&1 | tee -a ../../cargo-output.log`), `${name} appends its output, stderr included, to the log`);
  }
  assert.match(step(ci, 'Test the native core'), /\n {8}timeout-minutes: \d+\n/, 'a hang is a failure with a name, not a six-hour job');
});

test('the workflow: the annotator runs when a Rust step failed or timed out, and the Node suite still runs after a Rust failure', () => {
  const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'test.yml'), 'utf8');

  const a = step(ci, 'Surface each failing Rust check as an annotation');
  for (const id of ['fmt', 'clippy', 'cargotest']) assert.ok(a.includes(`steps.${id}.outcome == 'failure'`), `the annotator runs when ${id} failed`);
  assert.ok(a.includes("steps.cargotest.outcome == 'cancelled'"), 'and when the test step was stopped by its timeout');
  assert.match(a, /run: node scripts\/cargo-annotate\.js cargo-output\.log native\/treemap-core\n/);

  for (const name of ['Build the native module for this platform', 'Type-check', 'Run the test suite']) {
    assert.match(step(ci, name), /\n {8}if: \$\{\{ !cancelled\(\) && steps\.install\.outcome == 'success' \}\}\n/, `${name} runs after a Rust failure (the equivalence gate lives in the Node suite)`);
  }
  assert.match(step(ci, 'Install dependencies'), /\n {8}id: install\n/);
});

test('the workflow fetches gdu before the suite, so the gate’s gdu comparison runs instead of skipping', () => {
  const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'test.yml'), 'utf8');
  const fetchAt = ci.indexOf('\n      - name: Fetch gdu for this platform\n');
  const suiteAt = ci.indexOf('\n      - name: Run the test suite\n');

  assert.ok(fetchAt > 0, 'a step fetches gdu');
  assert.ok(fetchAt < suiteAt, 'before the suite runs');
  assert.match(step(ci, 'Fetch gdu for this platform'), /\n {8}run: npm run fetch:gdu:dev\n/, 'into ./gdu/, where the app looks from source');
});

test('the toolchain is pinned to one exact version with the components the gate needs', () => {
  const pin = fs.readFileSync(path.join(__dirname, '..', 'native', 'treemap-core', 'rust-toolchain.toml'), 'utf8');

  assert.match(pin, /^channel = "\d+\.\d+\.\d+"$/m, 'an exact version: `stable` is what let CI and a developer’s machine drift apart');
  assert.match(pin, /^components = \["clippy", "rustfmt"\]$/m);
});

/* ─────────────────────── the command line never fails the job ─────────────────────── */

test('the command line: a missing log is a warning and exit 0; a real log prints its annotations and exits 0', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = path.join(__dirname, '..', 'scripts', 'cargo-annotate.js');

  const missing = spawnSync(process.execPath, [script, path.join(FIXTURES, 'no-such.log'), WS], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  assert.equal(missing.status, 0);
  assert.match(missing.stdout, /^::warning title=Rust annotator::no .*no-such\.log/m);

  const real = spawnSync(process.execPath, [script, path.join(FIXTURES, 'plain.txt'), WS], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  assert.equal(real.status, 0);
  assert.match(real.stdout, /^::error file=native\/treemap-core\/crates\/alpha\/tests\/walk\.rs,line=6/m);
});
