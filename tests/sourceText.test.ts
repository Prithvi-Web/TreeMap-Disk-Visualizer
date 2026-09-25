import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every source file is text to every tool that reads it. git, grep and
 * GitHub's diff view call a file binary when it holds a NUL byte, and then
 * show and search nothing in it: src/services/thumbnailCache.ts once joined
 * its cache key with NUL characters typed straight into a template literal,
 * so a search for its one caller of makeThumbnail came back empty, and a
 * pull request touching it would have shown "Binary file not shown". A NUL
 * a string needs is written `\0`, which is the same string.
 */

const ROOT = path.join(__dirname, '..');
const SOURCE = /\.(?:ts|js|cjs|mjs|html|css|json|md|yml|rs|toml)$/;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Recorded fixtures are data, and may hold any byte on purpose.
      if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === 'fixtures') continue;
      sources(full, out);
    } else if (entry.isFile() && SOURCE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test('no source file holds a NUL byte, so git, grep and GitHub all read it as text', () => {
  const files = ['src', 'tests', 'scripts', 'bench', 'electron', 'public', 'native/treemap-core/crates']
    .map((d) => path.join(ROOT, d))
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => sources(d));
  assert.ok(files.length > 100, `the walk found the sources (${files.length} files)`);
  const withNul = files.filter((f) => fs.readFileSync(f).includes(0)).map((f) => path.relative(ROOT, f));
  assert.deepEqual(withNul, [], 'write a NUL a string needs as \\0');
});
