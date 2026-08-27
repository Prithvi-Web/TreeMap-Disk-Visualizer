import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const parts: string[] = [];
  for (const name of names) {
    const start = INDEX.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `function ${name} was located in public/index.html`);
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
    parts.push(INDEX.slice(start, end));
  }
  return new Function(`${parts.join('\n')}\nreturn ${returns};`)() as T;
}
