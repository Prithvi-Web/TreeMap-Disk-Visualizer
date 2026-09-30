import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every child a test or a bench run starts is guarded too
 * (src/services/realMachineGuard.ts): it knows it runs under a test runner by
 * TREEMAP_FORBID_REAL_TRASH, which `npm test` sets, or by NODE_TEST_CONTEXT,
 * which `--test` sets — and a child inherits both only when its environment is
 * built from this process's. A hand-built `env` (`{ PATH: process.env.PATH,
 * TREEMAP_DATA_DIR: dir }`) drops them both, and a server started with it
 * would move files to the machine's real Trash. So every child_process call in
 * tests/ and bench/ that passes an `env` is read here, and its environment must
 * spread `process.env`, come from `nestedRunEnv()`, or be what remains of
 * `process.env` after naming a few variables out — or be one of the named
 * exceptions below, each with the reason it still carries the variables.
 *
 * It reads source, not a syntax tree: a name is followed to every definition
 * of it in the same file (not by scope), a parameter cannot be followed, and
 * options passed as a variable are not opened. What it cannot read as
 * carrying fails here until it is named below with its reason.
 */

const REPO = path.join(__dirname, '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { FORBID_REAL_TRASH } = require('../scripts/run-tests.js') as { FORBID_REAL_TRASH: string };

/**
 * Calls whose `env` is not read here as carrying the variables, each named by
 * `<file>: <call>` (the call's opening, whitespace folded) and with the reason
 * it carries them after all. One that is no longer in the code must leave the
 * list too.
 */
const CARRIED_ELSEWHERE: Readonly<Record<string, string>> = {
  'tests/benchRusage.test.ts: spawnSync(process.execPath, [TSX_CLI, script]':
    "snapshotInFreshProcess's parameter; every caller passes standaloneEnv(), this process's environment less the probe hand-off",
  'tests/buildNative.test.ts: spawnSync(process.execPath, [SCRIPT]':
    "this process's environment copied entry by entry, less PATH",
  'tests/realMachineGuard.test.ts: spawnSync(process.execPath, [TSX_CLI, script, missing, answered]':
    "childAsksTheTrash's parameter; the guard's own test hands each child the test's environment, or it with one or both of the two signals taken out on purpose, and checks the child still refuses — or, with neither and without the data-folder fixture, that it is production and goes ahead to a path that does not exist",
  "tests/releasePipeline.test.ts: spawnSync('/bin/bash', [file]":
    "the sandbox's environment, which sandbox() builds from ...process.env; the child is a release script, not the app",
  "tests/testFileWatchdog.test.ts: spawnSync(process.execPath, ['--require', runner.WATCHDOG":
    "runScript's parameter; every caller passes asTestFile() or notATestFile(), both built on nestedRunEnv()",
};

/**
 * A child_process call: `spawn(`, `cp.spawnSync(`, `fork(`, `execFile(`…, and `exec(` / `execSync(`
 * only by name, never as a method (`re.exec(`, `db.exec(` are not child processes).
 */
const CHILD_CALL = /(?:(?<![\w$])(?:spawn|spawnSync|fork|execFile|execFileSync)|(?<![\w.$])(?:exec|execSync))\s*\(/g;

/** A `/` after one of these (or a keyword like `return`) starts a regular expression, not a division. */
const BEFORE_REGEX = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|void|in|of|delete|throw|new|else|do|yield|await))\s*$/;

/**
 * `src` with the contents of every string, template and regular expression
 * literal and every comment blanked, the same length and lines, so nothing
 * inside one is read as code. (A regular expression holding an apostrophe —
 * `/Eco's ceiling/` — once read as a string that ran on for thirty lines.)
 */
function maskStringsAndComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && BEFORE_REGEX.test(out.slice(Math.max(0, i - 40), i).join(''))) {
      // A regular expression: to its closing `/`, outside a character class, on this line.
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n' && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j++;
      }
      if (src[j] !== '/') {
        i++; // no closing slash on the line: a division after all
        continue;
      }
      blank(i + 1, j);
      i = j + 1;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** The index just past the bracket that closes the one at `open` (masked text). */
function closing(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return masked.length;
}

/** The expression that starts at `from` and ends before the first `,` `;` `}` or `)` outside brackets. */
function expressionAt(masked: string, from: number): string {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      if (depth === 0) return masked.slice(from, i);
      depth--;
    } else if ((c === ',' || c === ';') && depth === 0) return masked.slice(from, i);
  }
  return masked.slice(from);
}

type Verdict = 'carries' | 'drops' | 'unresolved';

/** Whether `expr`, an environment in `masked` (one file), is built from this process's. */
function verdictOf(expr: string, masked: string, seen: Set<string> = new Set()): Verdict {
  const e = expr.trim();
  if (e === 'process.env') return 'carries';
  if (/^nestedRunEnv\s*\(/.test(e)) return 'carries';
  if (e.startsWith('{')) {
    // An object: it carries when one of its spreads does.
    const inner = e.slice(1, closing(e, 0) - 1);
    let unresolved = false;
    for (const spread of inner.matchAll(/\.\.\.\s*/g)) {
      const v = verdictOf(expressionAt(inner, (spread.index ?? 0) + spread[0].length), masked, seen);
      if (v === 'carries') return 'carries';
      if (v === 'unresolved') unresolved = true;
    }
    return unresolved ? 'unresolved' : 'drops';
  }
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    if (seen.has(e)) return 'unresolved';
    seen.add(e);
    // What remains of process.env after naming some variables out: `const { A: _a, ...rest } = process.env`.
    if (new RegExp(`\\.\\.\\.\\s*${e}\\s*\\}\\s*=\\s*process\\.env\\b`).test(masked)) return 'carries';
    const definitions = [...masked.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${e}\\s*(?::[^=;]+)?=(?!=)\\s*`, 'g'))];
    if (definitions.length === 0) return 'unresolved';
    const verdicts = definitions.map((d) => verdictOf(expressionAt(masked, (d.index ?? 0) + d[0].length), masked, seen));
    if (verdicts.every((v) => v === 'carries')) return 'carries';
    return verdicts.includes('drops') ? 'drops' : 'unresolved';
  }
  return 'unresolved';
}

/** Every child_process call in `src` (one file's text) that passes an `env`, with how its environment was read. */
function childEnvs(rel: string, src: string): Array<{ key: string; verdict: Verdict }> {
  const masked = maskStringsAndComments(src);
  const found: Array<{ key: string; verdict: Verdict }> = [];
  for (const call of masked.matchAll(CHILD_CALL)) {
    const open = (call.index ?? 0) + call[0].length - 1;
    const args = masked.slice(open, closing(masked, open));
    const key = `${rel}: ${src.slice(call.index, (call.index ?? 0) + (args.length + call[0].length - 1)).replace(/\s+/g, ' ')}`;
    // `env: <expression>`, or the shorthand `env` inside an object.
    const named = /[{,]\s*env\s*:\s*/.exec(args);
    const shorthand = /[{,]\s*env\s*(?=[,}])/.exec(args);
    if (named === null && shorthand === null) continue;
    const expr = named !== null ? expressionAt(args, named.index + named[0].length) : 'env';
    found.push({ key, verdict: verdictOf(expr, masked) });
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...sourceFiles(full));
    } else if (/\.(ts|js|cjs|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file: string): string => path.relative(REPO, file).split(path.sep).join('/');
const FILES = [...sourceFiles(path.join(REPO, 'tests')), ...sourceFiles(path.join(REPO, 'bench'))]
  .filter((file) => /child_process/.test(fs.readFileSync(file, 'utf8')));

test('the scan reads a hand-built environment as dropping the guard, and one built from this process as carrying it', () => {
  const verdicts = (code: string): Verdict[] => childEnvs('x.ts', code).map((c) => c.verdict);
  assert.deepEqual(verdicts("spawn(process.execPath, [a], { env: { PATH: process.env.PATH, TREEMAP_DATA_DIR: dir } });"), ['drops'], 'a hand-built environment');
  assert.deepEqual(verdicts("const env = { PATH: '/bin' };\nspawnSync(process.execPath, [a], { env, encoding: 'utf8' });"), ['drops'], 'a hand-built one by name');
  assert.deepEqual(verdicts("spawn(process.execPath, [a], { env: { ...process.env, X: '1' } });"), ['carries'], 'a spread of process.env');
  assert.deepEqual(verdicts("const env = nestedRunEnv();\nspawn(x, [], { env: { ...env, Y: '1' } });"), ['carries'], 'nestedRunEnv(), through a name and a spread');
  assert.deepEqual(verdicts("const { A: _a, ...inherited } = process.env;\nconst env: NodeJS.ProcessEnv = { ...inherited, B: '1' };\nspawn(x, [], { env });"), ['carries'], 'what remains of process.env');
  assert.deepEqual(verdicts('function run(env: NodeJS.ProcessEnv) { return spawn(x, [], { env }); }'), ['unresolved'], 'a parameter cannot be read here');
  assert.deepEqual(verdicts("spawn(x, ['{ env: { PATH } }']); /* spawn(x, [], { env: {} }) */ re.exec(s); db.exec('x');"), [], 'strings, comments and other exec methods are not calls with an env');
  assert.deepEqual(verdicts("assert.match(note, /under Eco: the ceiling is Eco's 25%/);\nconst half = a / b / c;\nspawn(process.execPath, [a], { env: { PATH: '/bin' } });"), ['drops'], "a regular expression holding an apostrophe, and a division, are read past");
});

test('every child a test or bench file starts with an explicit environment builds it from this process\'s, so it carries the guard', () => {
  const calls = FILES.flatMap((file) => childEnvs(rel(file), fs.readFileSync(file, 'utf8')));
  assert.ok(calls.length >= 20, `the scan sees the suite's children: ${String(calls.length)}`);
  for (const known of ['tests/localeIndependence.test.ts', 'tests/dataDirFixture.test.ts', 'bench/lib/suites.ts', 'tests/nativeEquivalence.test.ts', 'tests/benchScanHold.test.ts']) {
    assert.ok(calls.some((c) => c.key.startsWith(`${known}: `) && c.verdict === 'carries'), `${known}'s child is read as carrying the guard`);
  }
  const seen = new Set<string>();
  const handBuilt = calls.filter((c) => {
    if (c.verdict === 'carries') return false;
    const exception = Object.keys(CARRIED_ELSEWHERE).find((k) => c.key.startsWith(k));
    if (exception === undefined) return true;
    seen.add(exception);
    return false;
  });
  assert.deepEqual(handBuilt.map((c) => `${c.key.slice(0, 140)} (${c.verdict})`), [],
    "a child started with an environment not built from this process's escapes the guard: spread ...process.env or use nestedRunEnv()");
  assert.deepEqual(Object.keys(CARRIED_ELSEWHERE).filter((k) => !seen.has(k)), [], 'every named exception is still in the code; one that is gone must leave the list too');
});

test("no test or bench file takes the guard's variable out of an environment", () => {
  assert.equal(FORBID_REAL_TRASH, 'TREEMAP_FORBID_REAL_TRASH');
  // Deleted, destructured away, or set to nothing, by its name or by a constant holding it.
  const REMOVES = /\bdelete\b.*FORBID_REAL_TRASH|FORBID_REAL_TRASH\w*['"`]?\]?\s*:\s*(?:_|undefined\b|''|""|``)/;
  const out: string[] = [];
  for (const file of [...sourceFiles(path.join(REPO, 'tests')), ...sourceFiles(path.join(REPO, 'bench'))]) {
    // The guard's own test takes it out on purpose, to prove node:test's context alone still refuses,
    // and this file spells the patterns out.
    if (['tests/realMachineGuard.test.ts', 'tests/childEnvCarriesGuard.test.ts'].includes(rel(file))) continue;
    const src = fs.readFileSync(file, 'utf8');
    const code = maskStringsAndComments(src).split('\n');
    src.split('\n').forEach((line, i) => {
      if (code[i].trim() === '') return; // a comment, or the inside of a string
      if (REMOVES.test(line)) out.push(`${rel(file)}: ${line.trim()}`);
    });
  }
  assert.deepEqual(out, [], "a child started without the guard's variable is unguarded when node:test's context is stripped too (nestedRunEnv strips that one)");
});
