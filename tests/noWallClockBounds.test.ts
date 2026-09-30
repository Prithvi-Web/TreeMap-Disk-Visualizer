import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { HANG_GUARD_MS } from './fixtures/waitFor';

/**
 * Count, don't time: no test asserts a wall-clock bound (ULTRA-ROADMAP.md,
 * the owner's rules). A bound on how long something took measures the
 * machine the suite happens to run on, not the code: CI run 36680933726 was
 * green on macOS and both Linux legs and red on Windows for one line,
 * tests/benchCorpus.test.ts:317, "creating 3000 entries took 6576 ms" against
 * a 5 s bound, on code nobody had touched. What a bound like that protects is
 * asserted as a count instead — calls through a seam, work done, entries
 * seen — and a figure that only measured the machine is a `t.diagnostic`.
 * Speed is the bench harness's business (bench/).
 *
 * This reads every file under tests/ as a syntax tree and fails on any
 * assertion whose condition compares a value taken from the clock
 * (`Date.now()`, `performance.now()`, `process.hrtime()`,
 * `process.hrtime.bigint()`, `process.cpuUsage()`, `new Date()`) against a
 * bound: an `assert(…)`/`assert.ok(…)` condition, the compared values of
 * `assert.equal` and its kin, the condition of an `if` that throws, fails or
 * rejects, and the condition of a loop — a wait the clock ends. The value is
 * followed through variables (by symbol, so a name reused elsewhere is its
 * own), through arithmetic, `Math`/`Number`, arrays pushed to, destructuring,
 * a local function's return and a local function's parameters, a clock
 * function held in a variable (`const now = performance.now`), and a verdict
 * stored first (`const fast = ms < 5000; assert.ok(fast)`). A property whose
 * name says it is a measured duration (`elapsedMs`, `wallMs`, `cpuSeconds`,
 * `took`, …) counts as one wherever it came from, since a figure measured by
 * the code under test is the same bound.
 *
 * A count of sleeps is a deadline too: a loop that awaits a timer and gives
 * up after `n` turns while waiting for something else is `Date.now() + n·d`
 * written another way ("a fixed 100 looks 100 ms apart gave up after 10 s on
 * a loaded machine", commit 298d752). It is a bound unless n·d reaches the
 * hang guard; a count of sleeps with nothing else to wait for is a pause, and
 * a count of attempts with no sleep between them is a count.
 *
 * A clock can also end a test without being read: a race against a timer
 * (`Promise.race` or `Promise.any` over `[work, sleep(2000)]`, the array
 * written in place or held first, the timer a `setTimeout` promise, `sleep`,
 * `delay`, `node:timers/promises`' `setTimeout` or a local helper returning
 * one), a timer whose callback rejects, throws, aborts or kills
 * (`setTimeout(() => reject(…), 10_000)`, and a request's or a socket's own
 * `req.setTimeout(5000, () => reject(…))`), `AbortSignal.timeout(ms)`, a
 * `waitFor` or `withinHangGuard` handed a limit on the real clock, or a
 * `timeout:` option on a child process or a test, in place or held in a
 * variable. Each of those is a bound when its delay is shorter than the hang
 * guard (HANG_GUARD_MS), and is found by evaluating the delay: a literal, a
 * const, a parameter's default, arithmetic on them — and when the delay is a
 * local helper's parameter (`withTimeout(p, ms)`), at each call that hands it
 * one. A limit on a stepped clock of the test's own (the fifth argument to
 * `waitFor`) is a count, and is not a bound.
 *
 * What is NOT a bound: a reading reported (`t.diagnostic`, a message), a
 * reading handed to the code under test (`scanExpired(scan, Date.now())`),
 * a seed (`modifiedAt: Date.now()`), and two readings put in order
 * (`before <= stamp && stamp <= after`) — an ordering a slow machine keeps.
 * A span (a difference of readings) or a deadline (a reading moved by a
 * constant) compared with anything is a bound, in either direction: "at
 * least 60 ms passed" depends on the clock as much as "under 5 s" does.
 *
 * The one wait a test may end by the clock is the hang guard, and it is
 * named below with the other exceptions, each with its reason.
 */

const REPO = path.join(__dirname, '..');

/** How a value relates to the clock. `verdict` is the boolean a bound comparison produces. */
type Kind = 'reading' | 'shifted' | 'span' | 'verdict';
const RANK: Record<Kind, number> = { reading: 1, shifted: 2, span: 3, verdict: 4 };

function join(a: Kind | null, b: Kind | null): Kind | null {
  if (a === null) return b;
  if (b === null) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

/** The exceptions: `file#function` → why that wait may end by the clock. Stale entries fail. */
const EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ['tests/fixtures/waitFor.ts#waitFor',
    'The hang guard, and the one clock a test may give up by: HANG_GUARD_MS (minutes, never seconds) ends a wait for work that never finishes, so a hang is named instead of spending the file\'s 20-minute limit. It is not a measurement: waitFor.test.ts counts its polls on a clock of its own.'],
  ['tests/fixtures/watchReady.ts#awaitWatchLive',
    'A readiness handshake, never an assertion: it decides whether a live-watch test can run at all or skips with the measured reason (a watch that attaches and says nothing), and no test fails on its clock.'],
  ['tests/fixtures/dataDir.ts#cleanUpDataDir',
    'A cleanup, never a verdict: when the background saves outlast its limit it writes a note and removes the folder anyway, so no test passes or fails on its clock (dataDirFixture.test.ts drives the note on a 30 ms limit).'],
  ['tests/waitFor.test.ts#guardRunsOutOn',
    'The hang guard\'s own test: withinHangGuard run out on 5 ms against a promise that never settles, which can end no other way — no machine is slow enough to change the answer.'],
  ['tests/fixtures/edgeCases.ts#freezeTimes',
    'A precondition the platforms set on the fixture, not a bound on the code: a directory atime must stay ahead of the ctime a stamp sets (Linux relatime) and within the hour of a listing (NTFS), so a process past its 30-minute anchor cannot build a time-stable tree and refuses rather than build a wrong one. edgeCases.test.ts pins both sides with `nowSeconds`, not with the clock.'],
]);

/** A property whose name says it holds a measured duration, from wherever. */
const DURATION_PROPERTY = /^(?:elapsed|took|waited|spent|wall|cpu)(?:Ms|Us|Ns|S|Secs|Seconds)?$/i;
/** Calls whose result carries their arguments' relation to the clock. */
const CARRYING_CALLS = /^(?:Number|BigInt|parseInt|parseFloat|Math\.(?:floor|ceil|round|trunc|abs|min|max))$/;
/** Methods whose result carries their receiver's relation to the clock. */
const CARRYING_METHODS = new Set(['getTime', 'valueOf', 'reduce', 'at', 'pop', 'shift', 'sort', 'slice', 'filter', 'find', 'map', 'toFixed', 'toPrecision']);
/** Calls that fail the test they run in. */
const FAILING_CALL = /^(?:assert(?:\.\w+)?|t\.fail|t\.assert\.\w+|reject|fail)$/;
/** Assertions whose first argument is a condition. */
const CONDITION_ASSERT = /^(?:assert|assert\.ok|t\.assert\.ok|ok)$/;
/** Assertions whose first two arguments are compared values. */
const COMPARING_ASSERT = /^(?:t\.)?assert\.(?:equal|strictEqual|notEqual|notStrictEqual|deepEqual|deepStrictEqual|notDeepEqual|notDeepStrictEqual)$/;

const RELATIONAL = new Set([ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken]);
const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken]);
const LOGICAL = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);

/** Source text without whitespace, so `performance . now` and line breaks read the same. */
const squash = (node: ts.Node): string => node.getText().replace(/\s+/g, '');

/** `Date.now()`, `performance.now()`, `process.hrtime.bigint()`… as a reading; `hrtime(prev)`, `cpuUsage(prev)` as a span. */
function clockCall(call: ts.CallExpression): Kind | null {
  const callee = squash(call.expression);
  if (/^(?:Date\.now|(?:perf_hooks\.)?performance\.now|(?:process\.)?hrtime\.bigint|process\.uptime)$/.test(callee)) return 'reading';
  if (/^(?:process\.)?(?:hrtime|cpuUsage)$/.test(callee)) return call.arguments.length === 0 ? 'reading' : 'span';
  // A clock handed in as a seam (`timing.now()`, `clock.now()`) is still a clock.
  if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'now') return 'reading';
  return null;
}

/** A clock function held rather than called: `performance.now`, `Date.now.bind(Date)`, `() => Date.now()`. */
function isClockFunction(node: ts.Node): boolean {
  const text = squash(node);
  return /^(?:Date\.now|performance\.now|process\.hrtime(?:\.bigint)?|process\.cpuUsage)$/.test(text)
    || /^(?:Date\.now|performance\.now)\.bind\(/.test(text)
    || /^(?:async)?\(\)(?::\w+)?=>(?:Date\.now|performance\.now|process\.hrtime\.bigint)\(\)$/.test(text);
}

type FunctionNode = ts.FunctionLikeDeclaration;

/** The function a call calls, when it is declared in this file. */
function declaredFunction(checker: ts.TypeChecker, callee: ts.Expression): FunctionNode | null {
  const symbol = checker.getSymbolAtLocation(callee);
  const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!decl) return null;
  if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) return decl;
  if (ts.isVariableDeclaration(decl) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) return decl.initializer;
  return null;
}

/** The name of the nearest enclosing named function, for the exceptions list. */
function enclosingFunctionName(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name) return at.name.getText();
    if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isVariableDeclaration(at.parent) && ts.isIdentifier(at.parent.name)) return at.parent.name.text;
  }
  return '';
}

interface Bound { file: string; line: number; fn: string; text: string }

/** Every wall-clock bound in one parsed file. */
function boundsInFile(source: ts.SourceFile, checker: ts.TypeChecker, file: string): Bound[] {
  const kinds = new Map<ts.Symbol, Kind>();
  const clockFunctions = new Set<ts.Symbol>();
  const returns = new Map<FunctionNode, Kind>();
  const bindings: Array<{ symbol: ts.Symbol; value: ts.Expression }> = [];
  const calls: ts.CallExpression[] = [];
  const functions: FunctionNode[] = [];

  const symbolOf = (node: ts.Node): ts.Symbol | undefined => checker.getSymbolAtLocation(node);
  const bind = (name: ts.Node, value: ts.Expression): void => {
    const symbol = symbolOf(name);
    if (symbol) bindings.push({ symbol, value });
  };
  const bindPattern = (name: ts.BindingName, value: ts.Expression): void => {
    if (ts.isIdentifier(name)) { bind(name, value); return; }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) bindPattern(element.name, value);
    }
  };

  const collect = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && 'body' in node && node.body) functions.push(node as FunctionNode);
    if (ts.isVariableDeclaration(node) && node.initializer) bindPattern(node.name, node.initializer);
    if (ts.isParameter(node) && node.initializer) bindPattern(node.name, node.initializer);
    // `for (const ms of samples)`: each name holds what the array holds.
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && ts.isVariableDeclarationList(node.initializer)) {
      for (const decl of node.initializer.declarations) bindPattern(decl.name, node.expression);
    }
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      bind(node.left, node.right);
    }
    if (ts.isCallExpression(node)) {
      calls.push(node);
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'push' && ts.isIdentifier(callee.expression)) {
        for (const arg of node.arguments) bind(callee.expression, arg);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  for (const { symbol, value } of bindings) if (isClockFunction(value)) clockFunctions.add(symbol);

  const returnExpressions = (fn: FunctionNode): ts.Expression[] => {
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const out: ts.Expression[] = [];
    const walk = (node: ts.Node): void => {
      if (node !== fn.body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
      ts.forEachChild(node, walk);
    };
    walk(fn.body);
    return out;
  };

  const kindOf = (node: ts.Node): Kind | null => {
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isNonNullExpression(node)
      || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
      return kindOf(node.expression);
    }
    if (ts.isIdentifier(node)) {
      const symbol = symbolOf(node);
      return symbol ? kinds.get(symbol) ?? null : null;
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      const symbol = checker.getShorthandAssignmentValueSymbol(node);
      return symbol ? kinds.get(symbol) ?? null : null;
    }
    if (ts.isNewExpression(node)) {
      if (squash(node.expression) !== 'Date') return null;
      return !node.arguments || node.arguments.length === 0 ? 'reading' : node.arguments.map(kindOf).reduce(join, null);
    }
    if (ts.isCallExpression(node)) {
      const clock = clockCall(node);
      if (clock) return clock;
      const callee = node.expression;
      const calleeSymbol = symbolOf(callee);
      if (calleeSymbol && clockFunctions.has(calleeSymbol)) return 'reading';
      const fn = declaredFunction(checker, callee);
      if (fn) return returns.get(fn) ?? null;
      if (CARRYING_CALLS.test(squash(callee))) return node.arguments.map(kindOf).reduce(join, null);
      if (ts.isPropertyAccessExpression(callee) && CARRYING_METHODS.has(callee.name.text)) {
        // `samples.map(() => { …; return Date.now() - t0; })` carries what its callback returns.
        const callbacks = node.arguments.filter((arg): arg is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
        return callbacks.map((fn) => returns.get(fn) ?? null).reduce(join, kindOf(callee.expression));
      }
      return null;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (name === 'length' || name === 'size') return null;
      return kindOf(node.expression) ?? (DURATION_PROPERTY.test(name) ? 'span' : null);
    }
    if (ts.isElementAccessExpression(node)) return kindOf(node.expression);
    if (ts.isSpreadElement(node)) return kindOf(node.expression);
    if (ts.isPrefixUnaryExpression(node)) {
      const inner = kindOf(node.operand);
      if (node.operator === ts.SyntaxKind.ExclamationToken) return inner === 'verdict' ? 'verdict' : null;
      return inner;
    }
    if (ts.isConditionalExpression(node)) {
      if (kindOf(node.condition) === 'verdict') return 'verdict';
      return join(kindOf(node.whenTrue), kindOf(node.whenFalse));
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(kindOf).reduce(join, null);
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.CommaToken) return kindOf(node.right);
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) return kindOf(node.right);
      const left = kindOf(node.left);
      const right = kindOf(node.right);
      if (RELATIONAL.has(op)) {
        if (isSignCheck(node)) return null;
        return isBound(left, right) || left === 'verdict' || right === 'verdict' ? 'verdict' : null;
      }
      if (EQUALITY.has(op) || LOGICAL.has(op)) {
        if (left === 'verdict' || right === 'verdict') return 'verdict';
        return LOGICAL.has(op) ? join(left, right) : null;
      }
      if (left === null && right === null) return null;
      if (left === 'span' || right === 'span') return 'span';
      if (op === ts.SyntaxKind.MinusToken) {
        if (right === null) return 'shifted';            // a reading moved back by a constant: "an hour ago"
        return 'span';                                   // a difference of readings, or a constant minus one
      }
      if (op === ts.SyntaxKind.PlusToken) return left !== null && right !== null ? 'span' : 'shifted';
      // * / % on a reading converts its unit (`Date.now() / 1000`); on anything else it is a span.
      if (left === 'reading' && right === null) return 'reading';
      return join(join(left, right), 'span');
    }
    return null;
  };

  /**
   * `span >= 0`: a duration is never negative, so no machine is fast or slow
   * enough to fail the check. `> 0` is not this: a fast walk on a coarse
   * clock measures zero.
   */
  function isSignCheck(node: ts.BinaryExpression): boolean {
    const zero = (side: ts.Expression): boolean => ts.isNumericLiteral(side) && Number(side.text) === 0;
    const op = node.operatorToken.kind;
    return (op === ts.SyntaxKind.GreaterThanEqualsToken && zero(node.right)) || (op === ts.SyntaxKind.LessThanEqualsToken && zero(node.left));
  }

  /** A span or a deadline, compared with anything. Two plain readings in order are not a bound. */
  function isBound(left: Kind | null, right: Kind | null): boolean {
    return left === 'span' || right === 'span' || left === 'shifted' || right === 'shifted';
  }

  // Follow every binding, return and parameter to a fixed point.
  for (let grew = true; grew;) {
    grew = false;
    const raise = (symbol: ts.Symbol, kind: Kind | null): void => {
      if (kind === null || clockFunctions.has(symbol)) return;
      const now = kinds.get(symbol) ?? null;
      const next = join(now, kind);
      if (next !== now) { kinds.set(symbol, next!); grew = true; }
    };
    for (const { symbol, value } of bindings) raise(symbol, kindOf(value));
    for (const fn of functions) {
      const now = returns.get(fn) ?? null;
      const next = join(now, returnExpressions(fn).map(kindOf).reduce(join, null));
      if (next !== now) { returns.set(fn, next!); grew = true; }
    }
    for (const call of calls) {
      const fn = declaredFunction(checker, call.expression);
      if (!fn) continue;
      call.arguments.forEach((arg, i) => {
        const param = fn.parameters[i];
        if (!param) return;
        const kind = kindOf(arg);
        const names: ts.Identifier[] = [];
        const gather = (name: ts.BindingName): void => {
          if (ts.isIdentifier(name)) names.push(name);
          else for (const element of name.elements) if (ts.isBindingElement(element)) gather(element.name);
        };
        gather(param.name);
        for (const name of names) {
          const symbol = symbolOf(name);
          if (symbol) raise(symbol, kind);
        }
      });
    }
  }

  /** The value of a delay this file fixes — a literal, a const, a parameter's default, arithmetic on them — or null. */
  const numericValue = (node: ts.Expression, depth = 0): number | null => {
    if (depth > 8) return null;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return numericValue(node.expression, depth + 1);
    if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ''));
    if (ts.isIdentifier(node)) {
      if (node.text === 'HANG_GUARD_MS') return HANG_GUARD_MS;
      const decl = symbolOf(node)?.valueDeclaration;
      if (decl && (ts.isVariableDeclaration(decl) || ts.isParameter(decl)) && decl.initializer) return numericValue(decl.initializer, depth + 1);
      return null;
    }
    if (ts.isBinaryExpression(node)) {
      const left = numericValue(node.left, depth + 1);
      const right = numericValue(node.right, depth + 1);
      if (left === null || right === null) return null;
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
      if (node.operatorToken.kind === ts.SyntaxKind.MinusToken) return left - right;
      if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right;
      if (node.operatorToken.kind === ts.SyntaxKind.SlashToken) return left / right;
    }
    return null;
  };
  /** A delay shorter than the hang guard: a clock that fails a test on a machine slow enough. */
  const shortOfGuard = (node: ts.Expression | null | undefined): boolean => {
    if (!node) return false;
    const value = numericValue(node);
    return value !== null && value < HANG_GUARD_MS;
  };
  /** `expr`'s declaration when it names a parameter of a function declared in this file. */
  const parameterOf = (expr: ts.Expression): { fn: FunctionNode; index: number; decl: ts.ParameterDeclaration } | null => {
    const decl = ts.isIdentifier(expr) ? symbolOf(expr)?.valueDeclaration : undefined;
    if (!decl || !ts.isParameter(decl) || !ts.isFunctionLike(decl.parent) || !('body' in decl.parent)) return null;
    const fn = decl.parent as FunctionNode;
    return { fn, index: fn.parameters.indexOf(decl), decl };
  };
  /**
   * Where a delay shorter than the hang guard is chosen: `site`, when the
   * file fixes the delay there (a literal, a const, a parameter's default),
   * and — when the delay is a parameter of a local helper
   * (`withTimeout(p, ms)`) — every call that hands it a shorter one.
   */
  const shortSites = (delay: ts.Expression | null | undefined, site: ts.Node): ts.Node[] => {
    if (!delay) return [];
    const param = parameterOf(delay);
    if (!param) return shortOfGuard(delay) ? [site] : [];
    const out: ts.Node[] = shortOfGuard(param.decl.initializer) ? [site] : [];
    for (const call of calls) {
      if (declaredFunction(checker, call.expression) === param.fn && shortOfGuard(call.arguments[param.index])) out.push(call);
    }
    return out;
  };
  /** Names this file imports `setTimeout` from `node:timers/promises` by: a call is a sleep of its first argument. */
  const promiseTimers = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !/^(?:node:)?timers\/promises$/.test(statement.moduleSpecifier.text)) continue;
    const named = statement.importClause?.namedBindings;
    for (const element of named && ts.isNamedImports(named) ? named.elements : []) {
      if ((element.propertyName ?? element.name).text === 'setTimeout') promiseTimers.add(element.name.text);
    }
  }
  /** `expr`, or — when it is one of `fn`'s parameters — what `call` passes for it (its default when nothing is passed). */
  const argumentFor = (fn: FunctionNode, call: ts.CallExpression, expr: ts.Expression): ts.Expression => {
    const decl = ts.isIdentifier(expr) ? symbolOf(expr)?.valueDeclaration : undefined;
    const index = decl && ts.isParameter(decl) ? fn.parameters.indexOf(decl) : -1;
    if (index < 0) return expr;
    return call.arguments[index] ?? fn.parameters[index].initializer ?? expr;
  };
  /**
   * The delay of a timer promise — `new Promise(… setTimeout(…, d) …)`, `sleep(d)`, or a local
   * helper that returns one (`const tick = () => new Promise(…)`, its delay a parameter or not) —
   * through `.then`/`.catch`/`.finally` and a variable, or null.
   */
  const timerDelayOf = (node: ts.Expression, depth = 0): ts.Expression | null => {
    if (depth > 8) return null;
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node)) return timerDelayOf(node.expression, depth + 1);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['then', 'catch', 'finally'].includes(node.expression.name.text)) {
      return timerDelayOf(node.expression.expression, depth + 1);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && (/^(?:sleep|delay)$/i.test(node.expression.text) || promiseTimers.has(node.expression.text))) return node.arguments[0] ?? null;
    if (ts.isCallExpression(node)) {
      const fn = declaredFunction(checker, node.expression);
      for (const returned of fn ? returnExpressions(fn) : []) {
        const delay = timerDelayOf(returned, depth + 1);
        if (delay) return argumentFor(fn!, node, delay);
      }
    }
    if (ts.isNewExpression(node) && squash(node.expression) === 'Promise') {
      let delay: ts.Expression | null = null;
      const find = (at: ts.Node): void => {
        if (delay) return;
        if (ts.isCallExpression(at) && /^(?:globalThis\.)?setTimeout$/.test(squash(at.expression)) && at.arguments[1]) {
          delay = at.arguments[1];
          return;
        }
        ts.forEachChild(at, find);
      };
      for (const arg of node.arguments ?? []) find(arg);
      return delay;
    }
    if (ts.isIdentifier(node)) {
      const decl = symbolOf(node)?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return timerDelayOf(decl.initializer, depth + 1);
    }
    return null;
  };
  /** The names this file calls the hang guard's own waits by (`import { waitFor as waitUntil } …`). */
  const guardWaits = new Map<string, 'waitFor' | 'withinHangGuard'>();
  if (file.endsWith('fixtures/waitFor.ts')) {
    guardWaits.set('waitFor', 'waitFor');
    guardWaits.set('withinHangGuard', 'withinHangGuard');
  }
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !/(?:^|\/)waitFor$/.test(statement.moduleSpecifier.text)) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === 'waitFor' || imported === 'withinHangGuard') guardWaits.set(element.name.text, imported);
    }
  }

  const unwrap = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);
  /** The parts of a condition joined by `&&` and `||`. */
  const partsOf = (node: ts.Expression): ts.Expression[] => {
    const at = unwrap(node);
    if (ts.isBinaryExpression(at) && (at.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || at.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return [...partsOf(at.left), ...partsOf(at.right)];
    }
    return [at];
  };
  /** Walks `root` without entering the functions it defines; `visitNode` answers false to stop descending. */
  const walkOwn = (root: ts.Node, visitNode: (node: ts.Node) => boolean | void): void => {
    const walk = (node: ts.Node): void => {
      if (node !== root && ts.isFunctionLike(node)) return;
      if (visitNode(node) !== false) ts.forEachChild(node, walk);
    };
    walk(root);
  };
  /** The names a loop steps by one — `i++`, `--left`, `writes += 1` — anywhere in it. */
  const countersOf = (loop: ts.IterationStatement): Set<ts.Symbol> => {
    const out = new Set<ts.Symbol>();
    const step = (target: ts.Expression): void => {
      const symbol = ts.isIdentifier(unwrap(target)) ? symbolOf(unwrap(target)) : undefined;
      if (symbol) out.add(symbol);
    };
    walkOwn(loop, (node) => {
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) step(node.operand);
      if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken || node.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken)
        && numericValue(node.right) !== null) step(node.left);
    });
    return out;
  };
  /** `i < 200`, `++tries > 50`, `200 > i`: one of `counters` compared with the count it runs to — or null. */
  const countIn = (part: ts.Expression, counters: Set<ts.Symbol>): { counter: ts.Expression; limit: ts.Expression } | null => {
    if (!ts.isBinaryExpression(part) || !RELATIONAL.has(part.operatorToken.kind)) return null;
    const counterOf = (side: ts.Expression): ts.Expression | null => {
      let at = unwrap(side);
      if (ts.isPrefixUnaryExpression(at) || ts.isPostfixUnaryExpression(at)) at = unwrap(at.operand);
      const symbol = ts.isIdentifier(at) ? symbolOf(at) : undefined;
      return symbol && counters.has(symbol) ? at : null;
    };
    const left = counterOf(part.left);
    if (left) return { counter: left, limit: part.right };
    const right = counterOf(part.right);
    return right ? { counter: right, limit: part.left } : null;
  };
  /** Each way out of `loop`'s body — a break of this loop, a return, a throw — with the `if` condition guarding it (null when none does). */
  const exitsOf = (loop: ts.IterationStatement): Array<ts.Expression | null> => {
    const label = ts.isLabeledStatement(loop.parent) ? loop.parent.label.text : null;
    const out: Array<ts.Expression | null> = [];
    const walk = (node: ts.Node, guard: ts.Expression | null, nested: boolean): void => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isBreakStatement(node) && (node.label ? node.label.text === label : !nested)) out.push(guard);
      if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) out.push(guard);
      if (ts.isIfStatement(node)) {
        walk(node.thenStatement, node.expression, nested);
        if (node.elseStatement) walk(node.elseStatement, node.expression, nested);
        return;
      }
      const inner = nested || ts.isIterationStatement(node, false) || ts.isSwitchStatement(node);
      ts.forEachChild(node, (child) => walk(child, guard, inner));
    };
    walk(loop.statement, null, false);
    return out;
  };
  /**
   * A loop that sleeps on a timer and gives up after a count, while waiting
   * for something else (its other way out): `n` sleeps of `d` ms is a
   * deadline of n·d ms, the same bound as `Date.now() + n·d` — "a fixed 100
   * looks 100 ms apart gave up after 10 s on a loaded machine" (commit
   * 298d752). A bound when n·d is shorter than the hang guard, or when the
   * file does not fix n or d. A count of sleeps with no other way out is a
   * pause, and a count of attempts with no sleep between them is a count.
   */
  const isCountedWait = (loop: ts.IterationStatement): boolean => {
    if (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) return false;
    const sleeps: ts.Expression[] = [];
    walkOwn(loop, (node) => {
      const delay = ts.isAwaitExpression(node) ? timerDelayOf(node.expression) : null;
      if (delay) sleeps.push(delay);
    });
    const counters = countersOf(loop);
    if (sleeps.length === 0 || counters.size === 0) return false;
    const condition = ts.isForStatement(loop) ? loop.condition : (loop as ts.WhileStatement | ts.DoStatement).expression;
    const counts: Array<{ counter: ts.Expression; limit: ts.Expression }> = [];
    let waitsForMore = false;
    for (const guard of [...(condition ? partsOf(condition) : []), ...exitsOf(loop)]) {
      if (guard === null) { waitsForMore = true; continue; }
      for (const part of partsOf(guard)) {
        if (part.kind === ts.SyntaxKind.TrueKeyword) continue;
        const count = countIn(part, counters);
        if (count) counts.push(count);
        else waitsForMore = true;
      }
    }
    if (counts.length === 0 || !waitsForMore) return false;
    const steps = counts.map(({ counter, limit }) => {
      const to = numericValue(limit);
      return to === null ? null : Math.abs(to - (numericValue(counter) ?? 0));
    });
    const delays = sleeps.map((delay) => numericValue(delay));
    if (steps.includes(null) || delays.includes(null)) return true;
    const perStep = (delays as number[]).reduce((sum, d) => sum + d, 0);
    return Math.min(...(steps as number[])) * perStep < HANG_GUARD_MS;
  };

  const found: Bound[] = [];
  const reported = new Set<ts.Node>();
  const report = (node: ts.Node): void => {
    if (reported.has(node)) return; // one helper call can be the site of two rules' short delay
    reported.add(node);
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    found.push({ file, line, fn: enclosingFunctionName(node), text: node.getText(source).replace(/\s+/g, ' ').slice(0, 140) });
  };
  const fails = (node: ts.Node): boolean => {
    let hit = false;
    const walk = (at: ts.Node): void => {
      if (hit || (at !== node && ts.isFunctionLike(at))) return;
      if (ts.isThrowStatement(at) || (ts.isCallExpression(at) && FAILING_CALL.test(squash(at.expression)))) hit = true;
      else ts.forEachChild(at, walk);
    };
    walk(node);
    return hit;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = squash(node.expression);
      if (CONDITION_ASSERT.test(callee) && node.arguments[0] && kindOf(node.arguments[0]) === 'verdict') report(node);
      else if (COMPARING_ASSERT.test(callee) && node.arguments.slice(0, 2).some((arg) => kindOf(arg) === 'verdict')) report(node);
    }
    if (ts.isIfStatement(node) && kindOf(node.expression) === 'verdict'
      && (fails(node.thenStatement) || (node.elseStatement !== undefined && fails(node.elseStatement)))) {
      report(node.expression);
    }
    if ((ts.isWhileStatement(node) || ts.isDoStatement(node)) && kindOf(node.expression) === 'verdict') report(node.expression);
    // A race against a timer shorter than the hang guard — its array written in place or held first.
    if (ts.isCallExpression(node) && /^Promise\.(?:race|any)$/.test(squash(node.expression)) && node.arguments[0]) {
      const held = ts.isIdentifier(node.arguments[0]) ? symbolOf(node.arguments[0])?.valueDeclaration : undefined;
      const array = held && ts.isVariableDeclaration(held) && held.initializer ? held.initializer : node.arguments[0];
      if (ts.isArrayLiteralExpression(array)) for (const element of array.elements) shortSites(timerDelayOf(element), node).forEach(report);
    }
    // A timer whose callback fails the test — it rejects or throws — or ends the work under test —
    // it aborts or kills — sooner than the hang guard: `setTimeout(cb, ms)`, or a request's or a
    // socket's own `x.setTimeout(ms, cb)`.
    if (ts.isCallExpression(node) && (/^(?:globalThis\.)?setTimeout$/.test(squash(node.expression))
      || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setTimeout'))) {
      // `timers.setTimeout(cb, ms)` keeps the global's order; a request's or a socket's takes the delay first.
      const first = node.arguments[0];
      const callbackFirst = /^(?:globalThis\.)?setTimeout$/.test(squash(node.expression)) || (first !== undefined && (ts.isArrowFunction(first) || ts.isFunctionExpression(first)));
      const [callback, delay] = callbackFirst ? [node.arguments[0], node.arguments[1]] : [node.arguments[1], node.arguments[0]];
      let endsTest = false;
      const look = (at: ts.Node): void => {
        if (endsTest) return;
        if (ts.isThrowStatement(at) || (ts.isCallExpression(at) && /^(?:reject|fail|assert\.fail|t\.fail|.+\.(?:abort|kill))$/.test(squash(at.expression)))) endsTest = true;
        else ts.forEachChild(at, look);
      };
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) look(callback.body);
      if (endsTest) shortSites(delay, node).forEach(report);
    }
    // A signal that aborts the work on its own clock.
    if (ts.isCallExpression(node) && squash(node.expression) === 'AbortSignal.timeout') shortSites(node.arguments[0], node).forEach(report);
    // The hang guard's waits handed a shorter limit on the real clock (a fifth argument to waitFor is a stepped clock: a count).
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const guard = guardWaits.get(node.expression.text);
      if (guard === 'waitFor' && node.arguments.length === 4 && shortOfGuard(node.arguments[3])) report(node);
      if (guard === 'withinHangGuard' && shortOfGuard(node.arguments[2])) report(node);
    }
    // A count of sleeps that gives up: n sleeps of d ms is a deadline of n·d ms.
    if (ts.isIterationStatement(node, false) && isCountedWait(node)) report(node);
    // A `timeout:` option — on a call, a child process, a test, or held in a variable first — shorter than the hang guard.
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ts.isIdentifier(node.name) && node.name.text === 'timeout'
      && ts.isObjectLiteralExpression(node.parent)
      && (ts.isCallExpression(node.parent.parent) || ts.isNewExpression(node.parent.parent) || ts.isVariableDeclaration(node.parent.parent))) {
      const held = ts.isShorthandPropertyAssignment(node) ? checker.getShorthandAssignmentValueSymbol(node)?.valueDeclaration : undefined;
      const value = ts.isPropertyAssignment(node) ? node.initializer : held && ts.isVariableDeclaration(held) ? held.initializer : undefined;
      shortSites(value, node).forEach(report);
    }
    if (ts.isForStatement(node) && node.condition && kindOf(node.condition) === 'verdict') report(node.condition);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every wall-clock bound in `files` (repo-relative name → source text). */
function wallClockBounds(files: ReadonlyMap<string, string>): Bound[] {
  const sources = new Map<string, ts.SourceFile>();
  for (const [name, code] of files) {
    const kind = /\.(?:c|m)?js$/.test(name) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    sources.set(name, ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, kind));
  }
  const options: ts.CompilerOptions = { noResolve: true, noLib: true, allowJs: true, types: [], noEmit: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => sources.get(name);
  host.fileExists = (name) => sources.has(name);
  host.readFile = (name) => files.get(name);
  const program = ts.createProgram([...sources.keys()], options, host);
  const checker = program.getTypeChecker();
  return [...sources].flatMap(([name, source]) => boundsInFile(source, checker, name));
}

const describe = (b: Bound): string => `${b.file}:${String(b.line)} ${b.text}`;
const boundsIn = (code: string): string[] => wallClockBounds(new Map([['x.ts', code]])).map((b) => `${String(b.line)}: ${b.text}`);

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (/\.(?:ts|js|cjs|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

test('a wall-clock bound is seen however the time was taken, and wherever the bound hides', () => {
  for (const code of [
    // tests/benchCorpus.test.ts:317 until 30 Sep 2026: red on Windows CI at 6576 ms.
    'const t0 = performance.now();\nawait createCorpus(root);\nconst elapsedMs = performance.now() - t0;\nassert.ok(elapsedMs < 5000, `took ${elapsedMs} ms`);',
    'const started = Date.now();\nwork();\nassert.ok(Date.now() - started < 200);',
    'const deadline = Date.now() + 20_000;\nfor (;;) {\n  if (done()) break;\n  assert.ok(Date.now() < deadline, "timed out");\n}',
    'const started = process.hrtime.bigint();\nwork();\nconst ms = Number(process.hrtime.bigint() - started) / 1e6;\nassert.ok(ms < 120);',
    'const t = process.hrtime();\nwork();\nconst [s, ns] = process.hrtime(t);\nassert.ok(s * 1e3 + ns / 1e6 < 50);',
    'const before = process.cpuUsage();\nwork();\nconst spent = process.cpuUsage(before);\nassert.ok((spent.user + spent.system) / 1000 < 30);',
    'const a = new Date();\nwork();\nassert.ok(new Date().getTime() - a.getTime() < 100);',
    // Hidden behind a variable: the verdict stored first, the limit named, the clock held.
    'const t0 = performance.now();\nwork();\nconst fast = performance.now() - t0 < 5000;\nassert.ok(fast);',
    'const LIMIT = 5000;\nconst t0 = Date.now();\nwork();\nconst took = Date.now() - t0;\nassert.ok(took <= LIMIT);',
    'const now = performance.now;\nconst t0 = now();\nwork();\nassert.ok(now() - t0 < 10);',
    'const clock = () => Date.now();\nconst t0 = clock();\nwork();\nassert(clock() - t0 < 10);',
    'async function waitOn(done: () => boolean, clock: { now(): number } = { now: () => Date.now() }): Promise<void> {\n  const started = clock.now();\n  while (!done()) if (clock.now() - started > 1000) throw new Error("hung");\n}',
    // Through a local helper's return, and through its parameter.
    'function timed(fn: () => void): number {\n  const t0 = Date.now();\n  fn();\n  return Date.now() - t0;\n}\nassert.ok(timed(work) < 100);',
    'function within(ms: number, budget: number): void {\n  assert.ok(ms < budget, "over budget");\n}\nconst t0 = Date.now();\nwork();\nwithin(Date.now() - t0, 2000);',
    // Failing by throw, by assert.fail, by reject, and by a loop the clock ends.
    'const deadline = Date.now() + 20_000;\nwhile (scan.status === "running") {\n  if (Date.now() > deadline) throw new Error("did not settle");\n  await sleep(5);\n}',
    'const deadline = Date.now() + 20_000;\nwhile (running()) {\n  if (Date.now() > deadline) assert.fail("the scan did not settle");\n}',
    'const t0 = Date.now();\nwhile (scan.status === "running" && Date.now() - t0 < 10_000) await sleep(10);\nassert.notEqual(scan.status, "running");',
    // A lower bound depends on the clock as much as an upper one.
    'const started = Date.now();\nawait wait(60);\nassert.ok(Date.now() - started >= 60, "not before the limit");',
    // A recency window is a deadline too.
    'assert.ok(fact.lastUsedMs > Date.now() - 60_000, "recent");',
    // Samples pushed to an array, then the best one; and a verdict compared with equal.
    'const ratios: number[] = [];\nfor (let i = 0; i < 3; i++) { const t0 = performance.now(); work(); ratios.push(performance.now() - t0); }\nassert.ok(Math.min(...ratios) < 30);',
    'const t0 = Date.now();\nwork();\nassert.equal(Date.now() - t0 < 500, true);',
    // A duration the code under test measured, by its name.
    'const report = await checkOpenHandles(paths);\nassert.ok(report.elapsedMs < 3000);',
    'const run = runChild("eco");\nassert.ok(run.wallMs >= 100);',
    // Positive is not a sign check: a coarse clock reads a short walk as zero.
    'const stats = take();\nassert.ok((stats.cpuSeconds ?? 0) >= 0.001);',
    'const samples = [1, 2].map(() => { const t0 = Date.now(); work(); return Date.now() - t0; });\nconst each: number[] = [];\nfor (const s of samples) each.push(s);\nfor (const ms of each) assert.ok(ms < 50);',
    // A clock that ends a test without being read. tests/engineBudget.test.ts:696 until 30 Sep 2026: a slow eviction failed it.
    'const outcome = await Promise.race([shard, sleep(2000).then(() => "still stopped")]);\nassert.ok(outcome instanceof Error);',
    'let timer;\nconst late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), 20_000); });\nassert.notEqual(await Promise.race([settled(), late]), "late");',
    'async function bounded(walk: Promise<void>, ms = 10_000) {\n  const timedOut = new Promise((resolve) => { setTimeout(() => resolve("timed out"), ms); });\n  return Promise.race([walk, timedOut]);\n}',
    "import { waitFor } from './fixtures/waitFor';\nawait waitFor(() => done(), 'the scan', 10, 5_000);",
    "import { withinHangGuard as guard } from './fixtures/waitFor';\nawait guard(shard, 'the shard', 2_000);",
    'const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 30_000 });',
    'const LIMIT = 20 * 1000;\nexecFile(cmd, args, { timeout: LIMIT }, done);',
    "test('x', { timeout: 5_000 }, () => {});",
    // tests/autopilot.test.ts:558 and timeCapsule.test.ts:302 until 30 Sep 2026: no race, the timer rejects on its own.
    "await new Promise<void>((resolve, reject) => {\n  child.stdout.once('data', () => resolve());\n  setTimeout(() => reject(new Error('child never signalled')), 10_000).unref();\n});",
    // A count of sleeps is a deadline: 100 looks 100 ms apart is ten seconds (tests/discoverability.test.ts:186 until 30 Sep 2026).
    'let stats: any;\nfor (let i = 0; i < 100; i++) {\n  stats = await req(port, "GET", "/stats");\n  if (stats.body.status !== "running") break;\n  await new Promise((r) => setTimeout(r, 100));\n}\nassert.equal(stats.body.status, "complete");',
    'for (let i = 0; i < 200 && getJob(id).status === "running"; i++) {\n  await new Promise((r) => setTimeout(r, 25));\n}\nassert.equal(getJob(id).status, "error");',
    'async function settled(): Promise<Body> {\n  for (let i = 0; i < 200; i++) {\n    const r = await get("/job");\n    if (r.status === 200) return r.body;\n    await sleep(25);\n  }\n  return assert.fail("the job never completed");\n}',
    'let i = 0;\nwhile (i++ < 100 && !done()) await sleep(20);\nassert.ok(done());',
    'let tries = 0;\nwhile (!done()) {\n  if (++tries > 50) throw new Error("never settled");\n  await sleep(10);\n}',
    'const tick = () => new Promise((r) => setTimeout(r, 25));\nlet n = 0;\ndo { await tick(); } while (!ready() && ++n < 40);',
    // A timer's method form: an idle timeout on a request or a socket (tests/scanProgress.test.ts:88 until 30 Sep 2026).
    'await new Promise((resolve, reject) => {\n  const req = http.get(url, (res) => res.on("end", resolve));\n  req.setTimeout(5000, () => reject(new Error("progress stream never closed")));\n});',
    'await new Promise((resolve, reject) => {\n  const r = http.request(url, () => resolve(null));\n  r.setTimeout(5000, () => { r.destroy(); reject(new Error("preview request timed out")); });\n});',
    // A clock that ends the work rather than the test: an abort, a kill, a signal that times out.
    'const ac = new AbortController();\nsetTimeout(() => ac.abort(), 2000);\nawait scanAll({ signal: ac.signal });',
    'const child = spawn(cmd);\nsetTimeout(() => child.kill(), 2000);\nassert.equal(await exitOf(child), 0);',
    'await scanAll({ signal: AbortSignal.timeout(2000) });',
    // A timer by another name, an array held first, Promise.any, and a delay handed to a helper.
    'import { setTimeout as wait } from "node:timers/promises";\nassert.notEqual(await Promise.race([work(), wait(2000, "late")]), "late");',
    'const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));\nassert.notEqual(await Promise.race([work(), pause(2000).then(() => "late")]), "late");',
    'const contenders = [work(), sleep(2000).then(() => "late")];\nassert.notEqual(await Promise.race(contenders), "late");',
    'assert.notEqual(await Promise.any([work(), sleep(2000).then(() => "late")]), "late");',
    'function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {\n  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("hung")), ms))]);\n}\nawait withTimeout(work(), 2000);',
    // A timeout option held in a variable, or written as a shorthand.
    'const opts = { encoding: "utf8" as const, timeout: 5000 };\nspawnSync(cmd, [], opts);',
    'const timeout = 5000;\nexecFileSync(cmd, [], { timeout });',
  ]) assert.equal(boundsIn(code).length, 1, code);
});

test('a clock reading that is only reported, seeded, handed to the code or put in order is not a bound', () => {
  for (const code of [
    'const t0 = performance.now();\nwork();\nconst ms = performance.now() - t0;\nt.diagnostic(`work took ${ms.toFixed(0)} ms`);\nassert.equal(result, 42, `after ${ms} ms`);',
    'const node = { name: "a", modifiedAt: Date.now(), size: 1 };\nassert.equal(node.size, 1);',
    'assert.equal(scanExpired(scan, Date.now()), false);\nassert.deepEqual(await runDuePolicies(Date.now() + 60_000), []);',
    'const before = Date.now();\ntouch(scan);\nconst after = Date.now();\nassert.ok(scan.lastUsedAt >= before && scan.lastUsedAt <= after);',
    'const start = Math.floor(Date.now() / 1000);\nwhile (Math.floor(Date.now() / 1000) === start) await sleep(10);',
    'const samples: number[] = [];\nconst t0 = Date.now();\nsamples.push(Date.now() - t0);\nassert.equal(samples.length, 1);',
    'const sim = simulate(SPRING);\nassert.ok(sim.duration * 1000 <= 350);',
    // A sign check: a measured duration is never negative, on any machine.
    'const d = diffUsage(a, b);\nassert.ok(d.cpuSeconds >= 0);\nassert.ok(run.childCpuSeconds === null || 0 <= run.childCpuSeconds);',
    '// assert.ok(Date.now() - t0 < 5000);\nconst note = "assert.ok(elapsed < 5000)";',
    // The hang guard itself, and waits that only it ends.
    "await Promise.race([settled(), new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), HANG_GUARD_MS))]);",
    'async function guard<T>(p: Promise<T>, limitMs = HANG_GUARD_MS) {\n  let t;\n  const expired = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error("hung")), limitMs); });\n  return Promise.race([p, expired]);\n}',
    "import { waitFor } from './fixtures/waitFor';\nawait waitFor(() => done(), 'the scan', 10);\nawait waitFor(() => false, 'x', 5, 60, clock);",
    'spawnSync(cmd, [], { timeout: HANG_GUARD_MS });\nspawnSync(cmd, [], { timeout: 600_000 });',
    "await new Promise<void>((resolve, reject) => {\n  child.stdout.once('data', () => resolve());\n  setTimeout(() => reject(new Error('hung')), HANG_GUARD_MS).unref();\n});",
    // A plain wait, and a timeout the code under test is handed.
    'await new Promise((r) => setTimeout(r, 200));\nconst out = await runText("x", [], { timeoutMs: 50 });',
    // The same name, bound to the clock in one function and to a response in another.
    'function a() { const started = Date.now(); return started; }\nfunction b() { const started = { status: 202 }; assert.ok(started.status < 300); }',
    // A count that is not a wait: a fixed pause, attempts with no sleep between, turns of the event loop,
    // and a count of sleeps as long as the hang guard.
    'for (let i = 0; i < 3; i++) await sleep(10);',
    'for (let i = 0; i < 100; i++) {\n  if (await probe()) break;\n}',
    'for (let i = 0; i < 5 && !done(); i++) await new Promise((r) => setImmediate(r));',
    'for (let i = 0; i < HANG_GUARD_MS / 10 && !done(); i++) await sleep(10);',
    // The same shapes at the hang guard, and a plain wait by another name.
    'await new Promise((resolve, reject) => {\n  const req = http.get(url, (res) => res.on("end", resolve));\n  req.setTimeout(HANG_GUARD_MS, () => reject(new Error("hung")));\n});',
    'const ac = new AbortController();\nsetTimeout(() => ac.abort(), HANG_GUARD_MS).unref();\nawait scanAll({ signal: AbortSignal.timeout(HANG_GUARD_MS) });',
    'function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {\n  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("hung")), ms))]);\n}\nawait withTimeout(work(), HANG_GUARD_MS);',
    'import { setTimeout as wait } from "node:timers/promises";\nawait wait(20);',
  ]) assert.deepEqual(boundsIn(code), [], code);
});

test('no test or fixture holds a wall-clock bound, except the named few', () => {
  const files = testFiles(path.join(REPO, 'tests'));
  assert.ok(files.length > 250, `the scan sees the suite: ${String(files.length)} files`);
  const sources = new Map(files.map((file) => [path.relative(REPO, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')]));
  const found = wallClockBounds(sources);
  const excepted = new Set<string>();
  const bounds = found.filter((b) => {
    const key = `${b.file}#${b.fn}`;
    if (!EXCEPTIONS.has(key)) return true;
    excepted.add(key);
    return false;
  }).map(describe);
  assert.deepEqual(bounds, [], 'a test asserts counts, never how long something took: assert what the bound protected as a count (calls through a seam, work done), or report the figure with t.diagnostic; a wait for work to finish is waitFor (tests/fixtures/waitFor.ts)');
  assert.deepEqual([...EXCEPTIONS.keys()].filter((key) => !excepted.has(key)), [], 'an exception that no longer matches anything is stale: remove it');
});
