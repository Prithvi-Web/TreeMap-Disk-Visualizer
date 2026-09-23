import { test, after, type TestContext } from 'node:test';
import { skipOrFailOnCi } from './fixtures/ciSkip';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CORPORA, ensureCorpus, type CorpusManifest } from '../bench/lib/corpus';
import { buildEdgeCases, freezeTimes, type EdgeCaseFixture } from './fixtures/edgeCases';
import { COUNTER_NAMES, describeMismatch, digestOfLines, firstDifference, type Counters } from './fixtures/canonicalTree';
import type { ChildEngine, ChildJob, ChildResult, ChildSuccess } from './fixtures/equivalenceChild';

/**
 * The correctness gate of Phase 3 (DESIGN.md §5.1, decisions P3-3, P3-5, P3-8):
 * on the `smoke` and `ci20k` corpora and on the edge-case fixture, every
 * engine's store must produce the same canonical digest and the same eleven
 * counters as the legacy walker, the oracle.
 *
 *  (a) the walker twice — the digest is a function of the tree, not of timing;
 *  (b) gdu against the walker — the proof that the digest's normalisations
 *      are exactly the documented ones: the two engines' lines may differ in
 *      the one column gdu cannot fill (accessedAt) and nowhere else, and their
 *      counters must agree; mtimes are stamped to whole seconds first because
 *      gdu records seconds (CURRENT-STATE.md §4);
 *  (c) the native engine against the walker, through the `engine: 'native'`
 *      setting W2 adds — detected at run time, skipped with the reason until it
 *      lands, and run unchanged the moment it does;
 *  (d) a forced load failure (`TREEMAP_NATIVE_MODULE=/nonexistent/…`, and the
 *      loader pinned to that path, because the variable alone is only the first
 *      of several candidates and a prebuilt would answer next) runs the walker,
 *      names the path in `fallbackReason`, and still digests the same.
 *
 * Every scan runs in a CHILD process (tests/fixtures/equivalenceChild.ts) with
 * its own data directory, the engine forced through the settings file and
 * the environment before a service is imported — the only way one test file
 * can drive three engines, and the same way the bench harness does it. This
 * parent process imports no service. On a mismatch the failure message
 * carries the first differing line of each side and the counters side by side.
 */

const CHILD = path.join(__dirname, 'fixtures', 'equivalenceChild.ts');
const CHILD_TIMEOUT_MS = 5 * 60_000;
const MISSING_MODULE = '/nonexistent/treemap_core.node';
const ACCESSED_AT_COLUMN = 5;
const NOT_YET = 'the native engine is not in this build yet (W2)';

/** W2 has landed when the settings module knows `engine` AND the scan record reports why an engine ran; either alone is a build mid-landing. */
function w2Missing(probe: ChildSuccess['probe']): string | null {
  if (probe.settingsAcceptEngine && probe.scanReportsEngineReason) return null;
  if (!probe.settingsAcceptEngine && !probe.scanReportsEngineReason) return NOT_YET;
  return `${NOT_YET}: ${probe.settingsAcceptEngine ? 'the settings module knows `engine` but the scan record carries no engineReason/fallbackReason' : 'the scan record reports engineReason but the settings module has no `engine`'}`;
}
const NATIVE_ENGINES = new Set(['native']);
const WALKER_ENGINES = new Set(['walker', 'turbo-walker']);

const tsxCli = (): string => path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');

interface Tree {
  name: string;
  root: string;
  hardlinkFamilies: string[][];
  /** Re-stamps every entry's times: sub-second fractions, or whole seconds for gdu. */
  freeze(fractions: boolean): void;
}

/* ------------------------------ the trees ------------------------------ */

// The corpora are built once through `ensureCorpus`, under their own names so
// their timestamps (stamped here) never touch the bench's own trees, and are
// kept where every `ensureCorpus` corpus lives — os.tmpdir()/treemap-bench —
// for the next run to reuse; the edge fixture is built here and removed.
const corpusBuilds = new Map<string, Promise<CorpusManifest>>();
function corpus(name: 'smoke' | 'ci20k'): Promise<CorpusManifest> {
  let build = corpusBuilds.get(name);
  if (!build) {
    build = ensureCorpus(`equivalence-${name}`, CORPORA[name]);
    corpusBuilds.set(name, build);
  }
  return build;
}

async function corpusTree(name: 'smoke' | 'ci20k'): Promise<Tree> {
  const manifest = await corpus(name);
  return {
    name,
    root: manifest.root,
    hardlinkFamilies: manifest.hardlinkFamilies.map((f) => [f.target, ...f.links]),
    freeze: (fractions) => { freezeTimes(manifest.root, { fractions }); },
  };
}

let edgeBuild: Promise<EdgeCaseFixture> | null = null;
function edge(): Promise<EdgeCaseFixture> {
  if (!edgeBuild) edgeBuild = buildEdgeCases(fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-equivalence-edge-')));
  return edgeBuild;
}

async function edgeTree(): Promise<Tree> {
  const fixture = await edge();
  return {
    name: 'edge fixture',
    root: fixture.root,
    hardlinkFamilies: fixture.hardlinkFamilies,
    // Stamped by its builder (with fractions); a read-only volume cannot be re-stamped, so it never is.
    freeze: (fractions) => { freezeTimes(fixture.root, { fractions }); },
  };
}

after(async () => {
  if (edgeBuild) await (await edgeBuild).cleanup();
});

/* ---------------------------- the child runs ---------------------------- */

interface RunOptions {
  engine: ChildEngine;
  tree: Tree;
  env?: Record<string, string>;
  /** The loader considers only this path (see the child). */
  pinNativeModule?: string;
}

/** One scan in a fresh process with its own app-data directory; the directory is removed once the child has exited. */
async function runChild(opts: RunOptions): Promise<ChildSuccess> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-equivalence-data-'));
  const jobFile = path.join(dataDir, 'job.json');
  const outFile = path.join(dataDir, 'result.json');
  const job: ChildJob = { engine: opts.engine, root: opts.tree.root, dataDir, hardlinkFamilies: opts.tree.hardlinkFamilies, outFile, ...(opts.pinNativeModule ? { pinNativeModule: opts.pinNativeModule } : {}) };
  const env: NodeJS.ProcessEnv = { ...process.env, TREEMAP_DATA_DIR: dataDir, ...opts.env };
  if (opts.engine === 'gdu') delete env.TREEMAP_NO_GDU;
  else env.TREEMAP_NO_GDU = '1';
  fs.writeFileSync(jobFile, JSON.stringify(job));
  try {
    const stderr = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [tsxCli(), CHILD, jobFile], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      const timer = setTimeout(() => {
        err += `\nthe scanning process was killed after ${CHILD_TIMEOUT_MS / 1000} s`;
        child.kill('SIGKILL');
      }, CHILD_TIMEOUT_MS);
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', () => { clearTimeout(timer); resolve(err); });
    });
    let result: ChildResult;
    try {
      result = JSON.parse(fs.readFileSync(outFile, 'utf8')) as ChildResult;
    } catch {
      throw new Error(`the scanning process (${opts.engine} on ${opts.tree.name}) left no result${stderr ? `:\n${stderr.trim().split('\n').slice(-8).join('\n')}` : ''}`);
    }
    if (!result.ok) throw new Error(`${opts.engine} on ${opts.tree.name}: ${result.error}`);
    return result;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * The oracle: one un-compared warm-up walk, then the walker run everything
 * is compared against, once per tree — taken on the tree's reference
 * stamping (sub-second fractions). Every comparison re-applies that stamping
 * first: it is deterministic, so a tree the gdu leg re-stamped to whole
 * seconds comes back to exactly the reference's times.
 */
const references = new Map<string, Promise<ChildSuccess>>();
function referenceWalk(tree: Tree): Promise<ChildSuccess> {
  let ref = references.get(tree.name);
  if (!ref) {
    ref = (async () => {
      tree.freeze(true);
      const warmUp = await runChild({ engine: 'walker', tree });
      assertWalker(warmUp, tree);
      const run = await runChild({ engine: 'walker', tree });
      assertWalker(run, tree);
      return run;
    })();
    references.set(tree.name, ref);
  }
  return ref;
}

function assertWalker(run: ChildSuccess, tree: Tree): void {
  assert.ok(WALKER_ENGINES.has(run.engine), `the walker was forced on ${tree.name} but the scan ran on ${run.engine}`);
}

function assertSameTree(labelA: string, labelB: string, a: ChildSuccess, b: ChildSuccess): void {
  const message = describeMismatch(labelA, labelB, a.lines, b.lines, a.counters, b.counters);
  assert.equal(b.digest, a.digest, `${labelB} and ${labelA} digest differently\n${message}`);
  assert.deepEqual(b.lines, a.lines, `${labelB} and ${labelA} differ line by line\n${message}`);
  assert.deepEqual(b.counters, a.counters, `${labelB} and ${labelA} count differently\n${message}`);
}

/** Every column index at which any pair of lines differs; -1 when the lines cannot even be paired. */
function columnsDiffering(a: readonly string[], b: readonly string[]): { columns: Set<number>; lines: number } {
  const columns = new Set<number>();
  let lines = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    lines++;
    if (a[i] === undefined || b[i] === undefined) { columns.add(-1); continue; }
    const ca = a[i].split('\t');
    const cb = b[i].split('\t');
    if (ca.length !== cb.length) { columns.add(-1); continue; }
    for (let c = 0; c < ca.length; c++) if (ca[c] !== cb[c]) columns.add(c);
  }
  return { columns, lines };
}

function withoutAccessedAt(lines: readonly string[]): string[] {
  return lines.map((line) => {
    const cols = line.split('\t');
    cols[ACCESSED_AT_COLUMN] = '-';
    return cols.join('\t');
  });
}

function countersLine(c: Counters): string {
  return COUNTER_NAMES.map((n) => `${n} ${c[n]}`).join(', ');
}

/* -------------------------------- (a), (c) -------------------------------- */

const TREES: Array<{ label: string; load: () => Promise<Tree> }> = [
  { label: 'smoke', load: () => corpusTree('smoke') },
  { label: 'ci20k', load: () => corpusTree('ci20k') },
  { label: 'edge fixture', load: edgeTree },
];

for (const { label, load } of TREES) {
  test(`(a) ${label}: the walker twice → identical digest and counters`, async (t) => {
    const tree = await load();
    const first = await referenceWalk(tree);
    tree.freeze(true);
    const second = await runChild({ engine: 'walker', tree });
    assertWalker(second, tree);
    assertSameTree('walker run 1', 'walker run 2', first, second);
    t.diagnostic(`${tree.name}: ${first.engine}, ${first.lines.length} nodes, digest ${first.digest}; ${countersLine(first.counters)}`);
  });

  test(`(c) ${label}: the native engine vs the walker`, async (t) => {
    const tree = await load();
    const ref = await referenceWalk(tree);
    const missing = w2Missing(ref.probe);
    if (missing) {
      skipOrFailOnCi(t, `${tree.name}: ${missing}`);
      return;
    }
    tree.freeze(true);
    const native = await runChild({ engine: 'native', tree });
    if (!ref.probe.moduleHasScanStart) {
      // W2 is in, the module on disk is not the walker's: the forced engine must fall back and say why.
      assert.ok(typeof native.fallbackReason === 'string' && native.fallbackReason.length > 0, `a native run without a walking module names the reason; got ${JSON.stringify(native.fallbackReason)} (loader: ${ref.probe.moduleReason})`);
      assert.ok(WALKER_ENGINES.has(native.engine), `the fallback is the walker, not ${native.engine}`);
      skipOrFailOnCi(t, `${tree.name}: the native module cannot walk here — ${native.fallbackReason}`);
      return;
    }
    if (!NATIVE_ENGINES.has(native.engine)) {
      // A failure on every platform. Until W4 (Windows) and W5 (Linux) landed,
      // P3-9 let a forced run off macOS that fell back with a reason skip here;
      // with both in, that escape would let the gate pass on Linux and Windows
      // without the native engine ever running, so a fallback is a failure
      // that names the engine that ran and why.
      const reason = native.fallbackReason ?? native.engineReason ?? 'no reason recorded';
      assert.fail(`the native engine was forced on ${process.platform} and the module exports scanStart, but the scan ran on ${native.engine}: ${reason}`);
    }
    assertSameTree('walker', 'native', ref, native);
    t.diagnostic(`${tree.name}: native (fastPath ${native.fastPath ?? 'unreported'}) and the walker agree: ${ref.lines.length} nodes, digest ${ref.digest}; ${countersLine(native.counters)}`);
  });
}

/* ----------------------------------- (b) ----------------------------------- */

for (const name of ['smoke', 'ci20k'] as const) {
  // gdu on Windows keys no hard link — v5.36.1's pkg/analyze/dir_other.go
  // returns an inode of 0 there, so every name of a family counts its bytes —
  // and dates a file from its directory entry, which NTFS refreshes per name
  // (read from gdu's source, 23 Sep 2026). Every corpus here has hard links,
  // so (b) differs by construction on Windows: DESIGN §16 item 1 and RISKS
  // R59 name it. (c), the native engine's gate, stays strict everywhere.
  const gduCannot = process.platform === 'win32'
    && 'gdu on Windows keys no hard links (pkg/analyze/dir_other.go returns inode 0) and dates files from their directory entries: DESIGN §16 item 1';
  test(`(b) ${name}: gdu vs the walker → identical apart from the one fact gdu cannot record`, { skip: gduCannot }, async (t) => {
    const tree = await corpusTree(name);
    // Whole seconds: gdu records st_mtime, so a sub-second stamp could never agree.
    tree.freeze(false);
    const walker = await runChild({ engine: 'walker', tree });
    assertWalker(walker, tree);
    const gdu = await runChild({ engine: 'gdu', tree });
    if (gdu.unavailable) {
      skipOrFailOnCi(t, `${name}: ${gdu.unavailable}`);
      return;
    }
    assert.equal(gdu.engine, 'gdu-turbo', `gdu was forced on ${name} but the scan ran on ${gdu.engine}`);
    const raw = firstDifference(walker.lines, gdu.lines);
    const { columns, lines } = columnsDiffering(walker.lines, gdu.lines);
    const message = describeMismatch('walker', 'gdu', walker.lines, gdu.lines, walker.counters, gdu.counters);
    assert.equal(gdu.lines.length, walker.lines.length, `the same number of nodes\n${message}`);
    assert.deepEqual([...columns].sort((x, y) => x - y), columns.size === 0 ? [] : [ACCESSED_AT_COLUMN], `only accessedAt, which gdu does not record, may differ (columns ${[...columns].join(', ')})\n${message}`);
    assert.equal(digestOfLines(withoutAccessedAt(gdu.lines)), digestOfLines(withoutAccessedAt(walker.lines)), `with accessedAt set aside the digests agree\n${message}`);
    assert.deepEqual(gdu.counters, walker.counters, `the eleven counters agree\n${message}`);
    t.diagnostic(`${name}: gdu and the walker agree on ${walker.lines.length} nodes and every counter (${countersLine(gdu.counters)}); ${lines} lines differ, all in accessedAt only${raw ? ` — first raw difference at line ${raw.index}: walker ${JSON.stringify(raw.a)} | gdu ${JSON.stringify(raw.b)}` : ''}`);
  });
}

/* ----------------------------------- (d) ----------------------------------- */

test(`(d) a forced load failure: TREEMAP_NATIVE_MODULE=${MISSING_MODULE} runs the walker, names the path in fallbackReason, and digests the same`, async (t) => {
  const tree = await corpusTree('smoke');
  const ref = await referenceWalk(tree);
  const missing = w2Missing(ref.probe);
  if (missing) {
    skipOrFailOnCi(t, missing);
    return;
  }
  tree.freeze(true);
  const run = await runChild({ engine: 'auto', tree, env: { TREEMAP_NATIVE_MODULE: MISSING_MODULE }, pinNativeModule: MISSING_MODULE });
  assert.ok(WALKER_ENGINES.has(run.engine), `the legacy walker ran, not ${run.engine}`);
  assert.equal(typeof run.fallbackReason, 'string', 'the scan records why the native engine did not run');
  assert.ok((run.fallbackReason as string).includes(MISSING_MODULE), `the reason names the module path: ${run.fallbackReason}`);
  assertSameTree('walker', 'walker after the forced load failure', ref, run);
  t.diagnostic(`fallbackReason: ${run.fallbackReason}`);
});
