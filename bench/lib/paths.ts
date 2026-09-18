/**
 * The one place the harness's temp locations are spelled. `corpus.ts`,
 * `images.ts`, `rusage.ts` and `run.ts` all build on these so the removal
 * guards and the documentation cannot drift apart.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Every corpus and probe lives under `<tmp>/treemap-bench`. */
export const BENCH_TMP_NAME = 'treemap-bench';
/** A corpus directory holds its tree in `tree/` and the truth beside it. */
export const MANIFEST_FILE = 'manifest.json';
export const TREE_DIR = 'tree';

export function benchTmpDir(): string {
  return path.join(os.tmpdir(), BENCH_TMP_NAME);
}

/** True when `candidate` is inside the harness's temp root, by either spelling of a symlinked tmpdir. */
export function isUnderBenchTmp(candidate: string): boolean {
  const roots = new Set([benchTmpDir()]);
  try {
    roots.add(path.join(fs.realpathSync(os.tmpdir()), BENCH_TMP_NAME));
  } catch {
    /* an unresolvable tmpdir keeps the literal spelling only */
  }
  const resolved = path.resolve(candidate);
  for (const root of roots) {
    const rel = path.relative(root, resolved);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}
