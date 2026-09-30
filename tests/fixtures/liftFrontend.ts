import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/** The shipped frontend, read once. */
export const INDEX = readFileSync(
  path.join(__dirname, '..', '..', 'public', 'index.html'),
  'utf8',
);

/**
 * Lift named function declarations out of `public/index.html` and evaluate them.
 *
 * **There is no `src/` copy of the geometry these tests drive, deliberately.**
 * The squarify port that `cartPreview.test.ts` guards exists because the server
 * computes the treemap layout and the frontend needed the same function; a port
 * there is forced. Nothing on the server projects isometrically, packs circles
 * or solves a power diagram, so a second copy would be a drift hazard invented
 * for the sake of having one. Lifting the functions out and driving them
 * directly means what these tests exercise is the code that actually ships.
 *
 * `names` must list every function the ones under test call, in any order —
 * they are concatenated into one scope. A missing name fails here, naming
 * itself, rather than as an opaque ReferenceError inside an assertion.
 */
export function lift<T>(names: string[], returns: string): T {
  return new Function(`${liftedSource(names, [])}\nreturn ${returns};`)() as T;
}

/**
 * `lift`, with a call counter at the top of each function named in `counted`:
 * how many times the shipped code ran each one. Work counted, never timed —
 * a layout that must fit a first paint is held to the work that fits it, on
 * any machine. `calls` is live; zero an entry to count one run.
 */
export function liftCounting<T>(names: string[], returns: string, counted: string[]): { fn: T; calls: Record<string, number> } {
  for (const name of counted) assert.ok(names.includes(name), `${name} is counted, so it must be one of the lifted functions`);
  const calls: Record<string, number> = Object.fromEntries(counted.map((name) => [name, 0]));
  const fn = new Function('__calls', `${liftedSource(names, counted)}\nreturn ${returns};`)(calls) as T;
  return { fn, calls };
}

/** The lifted declarations, concatenated; each function in `counted` counts its own calls into `__calls`. */
function liftedSource(names: string[], counted: readonly string[]): string {
  const parts: string[] = [];
  for (const name of names) {
    const start = INDEX.indexOf(`function ${name}(`);
    if (start === -1) {
      assert.ok(!counted.includes(name), `${name} is counted, so it must be a function`);
      parts.push(liftConst(name));
      continue;
    }
    const open = INDEX.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let i = open; i < INDEX.length; i++) {
      if (INDEX[i] === '{') depth++;
      else if (INDEX[i] === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    assert.ok(end > open, `function ${name} has a balanced body`);
    parts.push(counted.includes(name)
      ? `${INDEX.slice(start, open + 1)} __calls[${JSON.stringify(name)}]++;${INDEX.slice(open + 1, end)}`
      : INDEX.slice(start, end));
  }
  return parts.join('\n');
}

/**
 * Lift a top-level `const NAME = …;` instead of a function.
 *
 * Some of what these tests need to pin is a constant rather than a routine —
 * Disk City's light vector is the clearest case, since both its signs and the
 * relative size of its components are load-bearing and a change to any of them
 * silently breaks the picture. Re-declaring the value in the test file would
 * make the test agree with itself rather than with the app.
 *
 * Deliberately narrow: a single statement ending at the first `;` that is not
 * inside a bracket or a string. Anything more elaborate than that should be a
 * function, and lifting it should look like one.
 */
function liftConst(name: string): string {
  const start = INDEX.indexOf(`const ${name} = `);
  assert.notEqual(start, -1, `function or const ${name} was located in public/index.html`);
  let depth = 0;
  for (let i = start; i < INDEX.length; i++) {
    const ch = INDEX[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ';' && depth === 0) return INDEX.slice(start, i + 1);
    else if (ch === '\n' && depth === 0 && i > start + 8) break;
  }
  assert.fail(`const ${name} is a single-statement declaration`);
}
