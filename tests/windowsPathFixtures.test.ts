import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A POSIX path literal sent through a guarded route is a Windows-only failure.
 *
 * `guardQueryPath` runs `sanitizePath` — which is `path.resolve` plus the
 * blocklist — over the query parameters it owns, before the handler sees them.
 * On POSIX that leaves `/root/d0` alone. On Windows `/root` is not an absolute
 * path at all: it resolves to `D:\root`, against whatever drive the runner
 * happens to be on. So a test that asks a guarded route for `/root/d0` and
 * expects to get back a fixture keyed on `/root/d0` describes something the
 * handler cannot find, and answers 404 on Windows and 200 everywhere else.
 *
 * That is not hypothetical. It is CI run 33483328995: two failures in
 * scanSubtree.test.ts, Windows only, macOS and Linux green — and it only
 * surfaced at all because the express-5 fix in 32d7ee0 made the sanitisation
 * real. Before that, express was discarding the guard's output and handing the
 * handler the raw string, so the fixtures matched by accident.
 *
 * The whole class is invisible on this project's development machines. This
 * test is the substitute for the Windows runner: it fails on the laptop, at the
 * moment the fixture is written, instead of ten minutes later in CI.
 *
 * The rule: a guarded query parameter's value must be DERIVED at runtime
 * (`path.resolve('/root')`, an `R()` join, an `os.tmpdir()` fixture, a variable)
 * rather than written as a POSIX literal. The repo's own idiom, already used by
 * apiHardening.test.ts and scanSubtree.test.ts, is:
 *
 *     const ROOT = path.resolve('/root');
 *     const R = (...parts: string[]) => path.join(ROOT, ...parts);
 *
 * A deliberately foreign path — one the test WANTS the route to refuse, like
 * asking for `/etc` to prove it is out of scope — is exempted by putting
 * `windows-ok:` and a reason in a comment on the line, or in the comment block
 * immediately above it. The reason is the point: an exemption with no argument
 * behind it is just the check turned off.
 *
 * Two deliberate limits, so nobody mistakes this for a proof:
 *
 *  - It only looks at lines that actually SEND the URL, which in this suite
 *    means the line names a `port` or calls `fetch`. A URL built with a literal
 *    on one line and sent on another slips through. Widening it caught four
 *    `rateLimitLanes.laneName('GET', '/api/index/tree?path=/x')` calls — a pure
 *    classifier that never touches a server — and a lint that cries wolf is a
 *    lint someone deletes.
 *  - It is a net for the shape that reached CI, not a substitute for the
 *    Windows runner. CI is still the authority.
 */

const SRC_API = path.join(__dirname, '..', 'src', 'api');
const TESTS = __dirname;
const EXEMPT_MARKER = 'windows-ok:';

/**
 * The query parameters `guardQueryPath` resolves, read out of the routes
 * themselves so this cannot go stale. A parameter added to a route tomorrow is
 * covered the day it lands, and a rename empties the set — which the first test
 * below refuses to let pass silently.
 */
function guardedParams(): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(SRC_API).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(path.join(SRC_API, file), 'utf8');
    for (const m of src.matchAll(/guardQueryPath\(([^)]*)\)/g)) {
      for (const lit of m[1].matchAll(/['"]([A-Za-z_][\w-]*)['"]/g)) found.add(lit[1]);
    }
  }
  return [...found].sort();
}

/**
 * "This line actually issues the request." Every HTTP call in this suite goes
 * through a helper that takes the ephemeral port, or through `fetch`; a pure
 * function given a URL-shaped string does neither.
 */
const SENDS_A_REQUEST = /\bport\b|\bfetch\s*\(|http\.(get|request)\s*\(/;

/**
 * The marker on the line itself, or anywhere in the unbroken run of comment
 * lines directly above it — a two-line reason reads better above the code than
 * crammed onto the end of it.
 */
function exempted(lines: string[], i: number): boolean {
  if (lines[i].includes(EXEMPT_MARKER)) return true;
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (!t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')) return false;
    if (t.includes(EXEMPT_MARKER)) return true;
  }
  return false;
}

interface Offence { file: string; line: number; param: string; literal: string; text: string }

/**
 * Every place a test builds a URL that hands a guarded parameter a hard-coded
 * absolute POSIX path.
 *
 * Deliberately conservative about what counts as a literal: only a quoted
 * string starting with `/` and NOT starting with `/api` (that is a route, not a
 * filesystem path). Anything computed — an identifier, a call, a join — is
 * exactly what this test is asking for and is never flagged.
 */
function scanTests(params: string[]): Offence[] {
  const out: Offence[] = [];
  if (!params.length) return out;
  const group = params.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // `?path=` or `&path=`, then either ${encodeURIComponent('/x')} / ${'/x'}
  // or a bare `/x` written straight into the URL text.
  const wrapped = new RegExp(`[?&](${group})=\\$\\{\\s*(?:encodeURIComponent\\(\\s*)?(['"\`])(/[^'"\`]*)\\2`, 'g');
  const bare = new RegExp(`[?&](${group})=(/[A-Za-z][^'"\`&$\\s]*)`, 'g');

  for (const file of readdirSync(TESTS).filter((f) => f.endsWith('.test.ts'))) {
    if (file === path.basename(__filename)) continue;
    const lines = readFileSync(path.join(TESTS, file), 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (exempted(lines, i)) return;
      if (!SENDS_A_REQUEST.test(text)) return; // a pure classifier never reaches the guard
      for (const re of [wrapped, bare]) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
          const literal = re === wrapped ? m[3] : m[2];
          if (literal.startsWith('/api')) continue;
          out.push({ file, line: i + 1, param: m[1], literal, text: text.trim().slice(0, 120) });
        }
      }
    });
  }
  return out;
}

test('the guarded-parameter list is derived and non-empty', () => {
  const params = guardedParams();
  assert.ok(
    params.length >= 2 && params.includes('path'),
    `guardQueryPath's parameters must be readable out of src/api — got ${JSON.stringify(params)}. ` +
      'If the middleware was renamed, re-point this test rather than deleting it: with an empty ' +
      'list the check below silently passes over every file.',
  );
});

test('no test hands a guarded route a hard-coded POSIX path', () => {
  const offences = scanTests(guardedParams());
  const report = offences.map((o) =>
    `${o.file}:${o.line}  ?${o.param}=${o.literal}\n      ${o.text}`,
  );
  assert.deepEqual(
    report,
    [],
    'these resolve to D:\\… on Windows and will 404 there while passing here.\n' +
      "Derive the path instead — `const ROOT = path.resolve('/root')` and join from it, as\n" +
      'apiHardening.test.ts does — or, if the route is MEANT to refuse this path, add a\n' +
      `\`${EXEMPT_MARKER} <reason>\` comment on the line.\n\n  ` + report.join('\n  '),
  );
});

test('the scanner actually recognises the shape it is looking for', () => {
  // Without this, a regex that matches nothing would make the test above pass
  // for every file forever — which is the failure mode it exists to prevent.
  // The two spellings below are the ones that reached CI and the one that is
  // easiest to write by hand; both must be caught.
  const probe = (line: string): number => {
    if (!SENDS_A_REQUEST.test(line)) return 0;
    const group = 'path';
    const wrapped = new RegExp(`[?&](${group})=\\$\\{\\s*(?:encodeURIComponent\\(\\s*)?(['"\`])(/[^'"\`]*)\\2`, 'g');
    const bare = new RegExp(`[?&](${group})=(/[A-Za-z][^'"\`&$\\s]*)`, 'g');
    return [...line.matchAll(wrapped)].length + [...line.matchAll(bare)].length;
  };
  assert.equal(
    probe("const r = await get(port, `/api/scan/${id}/subtree?path=${encodeURIComponent('/root/d0')}`);"),
    1, 'the CI failure’s exact shape');
  assert.equal(probe('await get(port, `/api/snapshots?path=/root/d0`);'), 1, 'a bare path written into the URL');
  assert.equal(
    probe("await get(port, `/api/scan/${id}/subtree?path=${encodeURIComponent(R('d0'))}`);"),
    0, 'a derived path is fine');
  assert.equal(probe('await get(port, `/api/snapshots?path=${encodeURIComponent(fixture)}`);'), 0, 'a variable is fine');
  assert.equal(
    probe("assert.equal(L.laneName('GET', '/api/index/tree?path=/x'), 'api');"),
    0, 'a pure classifier never reaches the guard, whatever string it is handed');

  // The exemption reaches back over a comment block, and stops at real code —
  // otherwise one `windows-ok:` near the top would silence a whole file.
  const offending = "await get(port, `/api/x?path=${encodeURIComponent('/etc')}`);";
  assert.equal(exempted([`// ${EXEMPT_MARKER} deliberate`, offending], 1), true, 'marker on the line above');
  assert.equal(exempted([`// ${EXEMPT_MARKER} deliberate`, '// still the same block', offending], 2), true,
    'marker anywhere in the block above');
  assert.equal(exempted([`// ${EXEMPT_MARKER} deliberate`, 'const x = 1;', offending], 2), false,
    'code between them ends the block — an exemption cannot leak down a file');
  assert.equal(exempted([offending], 0), false, 'and no marker means no exemption');
});
