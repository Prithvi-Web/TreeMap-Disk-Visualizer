#!/usr/bin/env tsx
/**
 * bench — the performance harness for the scan engine work (docs/engine/DESIGN.md §17).
 *
 *   npm run bench -- enumerate [--corpus=enum200k|enum1m] [--engine=auto|gdu|walker] [--runs=3] [--cache=warm|cold] [--record] [--label=...]
 *   npm run bench -- duplicates [--corpus=dupes100k] [--runs=3] [--min-size=1024] [--record]
 *   npm run bench -- neardup [--originals=600] [--runs=1] [--threshold=10] [--record]
 *   npm run bench -- all [--record]
 *   npm run bench -- compare <result.json> <baseline.json>
 *
 * Every number printed was produced by this process on this machine, under the
 * load average and cache state printed beside it. `--record` copies a result
 * into bench/baselines/ as the referent every later "N× faster" claim cites.
 * See bench/README.md for the cache procedures and what each column means.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EngineChoice } from './lib/suites';
import type { BenchResult } from './lib/report';
import type { ImageCorpusParams } from './lib/images';

type CorpusName = 'enum200k' | 'enum1m' | 'dupes100k';

// Isolate app data BEFORE any service is imported: scans write caches and
// snapshots, and the owner's installed TreeMap writes to the real directory.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-data-'));
process.env.TREEMAP_DATA_DIR = DATA_DIR;

const REPO = path.join(__dirname, '..');
const RESULTS_DIR = path.join(REPO, 'bench', 'results');
const BASELINES_DIR = path.join(REPO, 'bench', 'baselines');

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function intArg(name: string, fallback: number, min: number, max: number): number {
  const n = Number(arg(name, String(fallback)));
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  return n;
}
function oneOf<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  const v = arg(name, fallback);
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`--${name} must be one of ${allowed.join(', ')}`);
  return v as T;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function main(): Promise<void> {
  const [, , command = 'help'] = process.argv;
  if (command === 'help' || command === '--help') {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('\n').filter((l) => l.includes('npm run bench')).map((l) => l.replace(/^\s*\*\s?/, '')).join('\n') + '\n');
    return;
  }

  // Imported after the data dir is set: the services resolve it on import.
  const suites = await import('./lib/suites');
  const report = await import('./lib/report');
  const corpus = await import('./lib/corpus');
  const images = await import('./lib/images');

  if (command === 'compare') {
    const [, , , current, baseline] = process.argv;
    if (!current || !baseline) throw new Error('compare needs <result.json> <baseline.json>');
    const v = report.compareToBaseline(report.readResult(current), report.readResult(baseline));
    process.stdout.write(`${v.verdict}: ${v.sentence}\n`);
    process.exitCode = v.verdict === 'FAIL' ? 1 : 0;
    return;
  }

  const record = flag('record');
  const label = arg('label', `${command} on ${os.hostname()}`);
  const results: BenchResult[] = [];

  const finish = (r: BenchResult): void => {
    results.push(r);
    const file = report.writeResult(r, RESULTS_DIR);
    process.stdout.write(`\n${report.printTable([r])}\n`);
    for (const note of r.correctness.notes) process.stdout.write(`  ${r.correctness.ok ? 'note' : 'CORRECTNESS'}: ${note}\n`);
    process.stdout.write(`  cache: ${r.cache.state} — ${r.cache.reason}\n`);
    process.stdout.write(`  scale: ${r.corpus.scale}\n`);
    process.stdout.write(`  written: ${path.relative(REPO, file)}\n`);
    if (record) {
      const name = `${r.suite}-${slug(r.engine)}-${slug(r.corpus.name)}-tier${r.machine.tier}.json`;
      const b = report.writeResult(r, BASELINES_DIR, name);
      process.stdout.write(`  baseline: ${path.relative(REPO, b)}\n`);
    }
    if (!r.correctness.ok) process.exitCode = 1;
  };

  const enumerate = async (corpusName: CorpusName, engine: EngineChoice, runs: number, cache: 'warm' | 'cold'): Promise<void> => {
    const params = corpus.CORPORA[corpusName];
    process.stdout.write(`\ncorpus ${corpusName}: ${params.entries.toLocaleString('en-US')} entries (building or reusing under ${os.tmpdir()})…\n`);
    const manifest = await corpus.ensureCorpus(corpusName, params);
    process.stdout.write(`engine ${engine}, ${runs} run(s), cache ${cache}, load ${os.loadavg().map((n) => n.toFixed(2)).join(' / ')}\n`);
    finish(await suites.runEnumerate({ manifest, corpusName, engine, runs, cache, label }));
  };

  switch (command) {
    case 'enumerate': {
      const corpusName = oneOf('corpus', 'enum200k', ['enum200k', 'enum1m', 'dupes100k'] as const);
      const engine = oneOf('engine', 'auto', ['auto', 'gdu', 'walker'] as const);
      await enumerate(corpusName, engine, intArg('runs', 3, 1, 50), oneOf('cache', 'warm', ['warm', 'cold'] as const));
      break;
    }
    case 'duplicates': {
      const corpusName = oneOf('corpus', 'dupes100k', ['dupes100k', 'enum200k'] as const);
      const manifest = await corpus.ensureCorpus(corpusName, corpus.CORPORA[corpusName]);
      finish(await suites.runDuplicates({ manifest, corpusName, runs: intArg('runs', 3, 1, 50), minSize: intArg('min-size', 1024, 1, 1 << 30), label }));
      break;
    }
    case 'neardup': {
      const originals = intArg('originals', 600, 1, 20_000);
      const params: ImageCorpusParams = { originals, seed: 5, transforms: [...images.ALL_TRANSFORMS] };
      const root = path.join(os.tmpdir(), 'treemap-bench', `images-${originals}-seed5`);
      const manifest = await images.ensureImageCorpus(root, params);
      finish(await suites.runNearDup({ manifest, corpusName: `images${originals}`, runs: intArg('runs', 1, 1, 20), threshold: intArg('threshold', 10, 0, 32), label }));
      break;
    }
    case 'all': {
      const runs = intArg('runs', 3, 1, 50);
      for (const corpusName of ['enum200k', 'enum1m'] as const) {
        for (const engine of ['gdu', 'walker'] as const) await enumerate(corpusName, engine, runs, 'warm');
      }
      const dupes = await corpus.ensureCorpus('dupes100k', corpus.CORPORA.dupes100k);
      finish(await suites.runDuplicates({ manifest: dupes, corpusName: 'dupes100k', runs, minSize: 1024, label }));
      const originals = intArg('originals', 600, 1, 20_000);
      const root = path.join(os.tmpdir(), 'treemap-bench', `images-${originals}-seed5`);
      const imgs = await images.ensureImageCorpus(root, { originals, seed: 5, transforms: [...images.ALL_TRANSFORMS] });
      finish(await suites.runNearDup({ manifest: imgs, corpusName: `images${originals}`, runs: 1, threshold: 10, label }));
      process.stdout.write(`\n${report.printTable(results)}\n`);
      break;
    }
    default:
      throw new Error(`unknown command "${command}"; run with --help`);
  }
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`bench: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });
