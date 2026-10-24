import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * What an offload promises about a failure (hunt C91). The confirm sheet said "Any failure rolls back
 * completely", and the MCP tool, the README and AGENTS.md "any failure rolls back and leaves local data
 * untouched". True only before every copy verifies: after that the copies stand, and an original the
 * Trash refuses, one found open, one in a folder that gained a file or one that changed since its copy
 * was made stays where it is beside its verified copy, while the others go to the Trash. Every place
 * that states the promise now states it with that line drawn.
 */

const ROOT = path.join(__dirname, '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
/** "any failure rolls back", "failures roll back completely", … — the promise with no line drawn (review F1.16). */
const UNQUALIFIED = /\b(any\s+)?failures?\s+(all\s+)?rolls?\s+back/i;

test('the guard finds the promise however its words are spaced or wrapped, as in the hard-wrapped AGENTS.md (leftover HE-L12)', () => {
  for (const said of ['Any failure rolls back completely.', 'Any failure\n     rolls back completely.', 'failures\n  all  roll back', 'any  failure rolls\nback']) {
    assert.match(said, UNQUALIFIED, JSON.stringify(said));
  }
  assert.doesNotMatch('A failure before every copy verifies rolls back', UNQUALIFIED, 'the promise with its line drawn is not caught');
});

const PLACES: [string, string][] = [
  ['the confirm sheet', read('src/ui/app/125-offload.js')],
  ['the page as built', read('public/index.html')],
  ['the MCP offload tool', read('src/mcp/server.ts')],
  ['the OpenAPI document', read('src/api/openapi.ts')],
  ['AGENTS.md', read('AGENTS.md')],
  ['README.md', read('README.md')],
  ['the capabilities manifest (GET /api/capabilities)', read('src/api/metaRoutes.ts')],
];

for (const [where, text] of PLACES) {
  test(`${where} never promises that any failure of an offload rolls back`, () => {
    const hit = UNQUALIFIED.exec(text);
    assert.equal(hit, null, `${where} still says "${hit ? text.slice(Math.max(0, hit.index - 80), hit.index + 120) : ''}"`);
  });
}

test('the confirm sheet draws the line: a failure before every copy verifies rolls back, and an original that cannot go to the Trash afterwards stays beside its copy', () => {
  // Written as joined template literals: read as the one sentence it is.
  const sheet = read('src/ui/app/125-offload.js').replace(/`\s*\+\s*\n\s*`/g, '');
  assert.match(sheet, /A failure before every copy verifies rolls back completely — nothing local is touched until then\./);
  assert.match(sheet, /An original that cannot go to the Trash afterwards, or that changed after its copy was made, stays where it is beside its verified copy; one that changed while it was being copied stays too, and that copy, which may mix old and new, is removed\./);
});

test('the MCP offload tool says the same', () => {
  // Its description is written as joined string literals: read as the one sentence it is.
  const joined = read('src/mcp/server.ts').replace(/'\s*\+\s*\n\s*'/g, '');
  assert.match(joined, /A failure before every copy verifies rolls back and leaves local data untouched; after that, an original that cannot go to the Trash, or that changed after its copy was made, stays where it is beside its verified copy, and one that changed while it was being copied stays with that copy removed/);
});

test('the capabilities manifest, the agents\' machine-readable safety statement, draws the same line (review F1.10)', () => {
  const joined = read('src/api/metaRoutes.ts').replace(/'\s*\+\s*\n\s*'/g, '');
  assert.match(joined, /offload:\s*'Offload copies, verifies SHA-256, and only then trashes originals\. A failure before every copy verifies rolls back and leaves local data untouched; after that, an original that cannot go to the Trash, or that changed after its copy was made, stays where it is beside its verified copy, and one that changed while it was being copied stays with that copy removed'/);
});

test('the OpenAPI document says the same of the offload route (review F1.9)', () => {
  assert.match(read('src/api/openapi.ts'), /an original that cannot go to the Trash afterwards, or changed after its copy was made, stays beside its verified copy; one that changed while it was being copied stays, that copy removed/);
});
