import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * No module under src/ imports itself back, however far round (found by T17a's review,
 * 29 Sep 2026). A cycle is harmless only while every use across it happens inside a function
 * body: the first module-level use of an import that is still loading reads `undefined`, and
 * which one that is depends on which module a process loaded first. The code has been free of
 * them — diskScanner keeps a callback list rather than import the fact layer for exactly this
 * reason — and this holds it so. Only imports that load code count: `import type` and
 * `export type` are erased, and a dynamic `import()` runs when called, not when loaded.
 *
 * Reads the files; loads no app code.
 */

const SRC = path.join(__dirname, '..', 'src');
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"](\.[^'"]+)['"]/gm;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Every import cycle among `files`: Tarjan's strongly connected components of two or more. */
function cycles(files: string[]): string[][] {
  const known = new Set(files);
  const resolve = (from: string, spec: string): string | null => {
    const base = path.join(path.dirname(from), spec);
    for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) if (known.has(candidate)) return candidate;
    return null;
  };
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const deps = [...text.matchAll(STATIC_IMPORT)].map((m) => resolve(file, m[1])).filter((d): d is string => d !== null);
    graph.set(file, [...new Set(deps)]);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  let next = 0;
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(path.relative(SRC, w));
      } while (w !== v);
      if (component.length > 1) found.push(component.sort());
    }
  };
  for (const file of files) if (!index.has(file)) visit(file);
  return found;
}

test('no module under src/ imports itself back', () => {
  const files = sourceFiles(SRC);
  assert.ok(files.length > 150, `read the source tree (${files.length} files)`);
  assert.deepEqual(cycles(files).map((c) => c.join(' <-> ')), []);
});

test('the check sees a cycle when there is one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-importCycles-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.ts'), "import { b } from './b';\nexport const a = 1;\n");
    fs.writeFileSync(path.join(dir, 'b.ts'), "import { a } from './a';\nexport const b = 2;\n");
    fs.writeFileSync(path.join(dir, 'c.ts'), "import type { a } from './a';\nexport const c = 3;\n");
    assert.deepEqual(cycles(['a.ts', 'b.ts', 'c.ts'].map((f) => path.join(dir, f))).map((c) => c.length), [2], 'a <-> b, and a type import is no edge');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
