import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A preflight that lost the race must not touch the panel — on ANY exit.
 *
 * `#confirmOpenHandles` is one element shared by every confirm dialog, and
 * `checkOpenHandlesFor` is async, so two dialogs can have checks in flight at
 * once. `openHandleSeq` exists to let the loser get out of the way silently.
 *
 * The in-loop guard runs after a chunk SUCCEEDS. The chunked rewrite added a
 * `catch { continue; }`, which skips it — so a run whose first chunk succeeded
 * and whose later chunk died falls out of the loop and reaches the post-loop
 * renders with no check at all. That is worse than a cosmetic repaint:
 * `renderOpenHandleWarning` also arms `confirmIgnoreOpenHandles` and relabels
 * the confirm button "Delete anyway", so a stale run can leave a NEWER dialog
 * holding an override the user never saw the warning for, and the next confirm
 * sends `ignoreOpenHandles: true` for an unrelated selection.
 *
 * The invariant is therefore structural and worth pinning as such: between the
 * end of the chunk loop and the first statement that can touch the panel, the
 * sequence must be re-checked, and no exit after that point may be reachable
 * without it.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** The body of `checkOpenHandlesFor`, brace-matched. */
function checkFn(): string {
  const start = INDEX.indexOf('async function checkOpenHandlesFor(paths) {');
  assert.notEqual(start, -1, 'checkOpenHandlesFor exists in the built page');
  const open = INDEX.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(open + 1, i);
  }
  return assert.fail('checkOpenHandlesFor never closes');
}

test('the chunk loop still swallows a failed chunk rather than losing the answers that arrived', () => {
  // The premise of the whole test: if the catch/continue ever goes away, the
  // race below stops existing and this file should be revisited, not deleted.
  assert.match(checkFn(), /catch\s*\{[^}]*continue;/, 'a dropped chunk is skipped, not fatal');
});

test('every panel-touching exit after the loop is behind a sequence check', () => {
  const body = checkFn();
  // Everything from the end of the for-loop onward. The loop's closing brace is
  // the one at depth 1 that follows the `for (`.
  const forAt = body.indexOf('for (let i = 0; i < chunks; i++)');
  assert.notEqual(forAt, -1, 'the chunk loop is where it is expected');
  const loopOpen = body.indexOf('{', forAt);
  let depth = 0, loopEnd = -1;
  for (let i = loopOpen; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) { loopEnd = i; break; }
  }
  assert.notEqual(loopEnd, -1, 'the chunk loop closes');
  const after = body.slice(loopEnd + 1);

  const guardAt = after.search(/if\s*\(\s*seq\s*!==\s*openHandleSeq\s*\)\s*return;/);
  assert.notEqual(guardAt, -1, 'the post-loop block re-checks the sequence');

  // Nothing that touches the shared panel may appear before that guard.
  const touches = [...after.slice(0, guardAt).matchAll(/renderOpenHandleWarning\(|host\.hidden|host\.textContent|host\.className/g)];
  assert.deepEqual(
    touches.map((m) => m[0]), [],
    'a panel write reachable before the post-loop sequence check: a stale run would repaint, and ' +
      'renderOpenHandleWarning also arms confirmIgnoreOpenHandles for whichever dialog owns the panel now',
  );

  // And every render after it is genuinely after it.
  const renders = [...after.matchAll(/renderOpenHandleWarning\(/g)].map((m) => m.index as number);
  assert.ok(renders.length >= 2, `expected the unavailable and final renders, found ${renders.length}`);
  assert.ok(renders.every((i) => i > guardAt), 'every render sits after the guard');
});

test('the guard is not defeated by an early return that skips it', () => {
  const body = checkFn();
  const forAt = body.indexOf('for (let i = 0; i < chunks; i++)');
  const loopOpen = body.indexOf('{', forAt);
  let depth = 0, loopEnd = -1;
  for (let i = loopOpen; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) { loopEnd = i; break; }
  }
  const after = body.slice(loopEnd + 1);
  const guardAt = after.search(/if\s*\(\s*seq\s*!==\s*openHandleSeq\s*\)\s*return;/);
  // A bare `return;` before the guard would be fine (it touches nothing), but a
  // `return` that follows a panel write would not — covered above. What this
  // adds: the guard must be at the very top, so future edits inherit it.
  const before = after.slice(0, guardAt).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  assert.equal(before, '', `the sequence check must be the first statement after the loop, found: ${before.slice(0, 120)}`);
});
