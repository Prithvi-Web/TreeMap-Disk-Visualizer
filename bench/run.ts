#!/usr/bin/env tsx
/**
 * bench — the performance harness for the scan engine work (docs/engine/DESIGN.md §17).
 * Usage lines live in USAGE below; `--help` prints them. See bench/README.md.
 *
 * Every number printed was produced by a fresh child process on this machine
 * (the governor hold by the native module inside this one), under the load
 * average, cache state and budget printed beside it. `--record` copies
 * a result into bench/baselines/ as the referent every later "N× faster" claim
 * cites — and refuses when the result failed its correctness check, was not
 * reproducible, did not run under the budget it names, or was measured on a
 * dirty tree.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EngineChoice } from './lib/suites';
import type { GovernorPreset } from './lib/governorSuite';
import { SCAN_PRESETS, type BenchResult, type ScanPreset } from './lib/report';
import type { CorpusName } from './lib/corpus';
import type { RequestedCache } from './lib/cache';
import { benchTmpDir } from './lib/paths';

const REPO = path.join(__dirname, '..');
const RESULTS_DIR = process.env.TREEMAP_BENCH_OUT ?? path.join(REPO, 'bench', 'results');
/** Where `--record` writes; a test points it at a temp folder, since git tracks bench/baselines. */
const BASELINES_DIR = process.env.TREEMAP_BENCH_BASELINES ?? path.join(REPO, 'bench', 'baselines');

const USAGE = [
  'npm run bench -- enumerate [--corpus=enum200k|enum1m|ci20k|smoke|dupes100k] [--engine=auto|native|gdu|walker] [--preset=eco|balanced|turbo] [--runs=3] [--cache=warm|cold] [--record] [--label=...]',
  "      --preset defaults to turbo: the enumeration targets are set per budget and the headline one (warm 400–700k entries/s on Tier B) is Turbo's; the app's own default, Automatic, is Balanced or Eco by power and heat, so a number measured under it could not say which",
  'npm run bench -- duplicates [--corpus=dupes100k|smoke|ci20k|enum200k|enum1m] [--runs=3] [--min-size=1024] [--cache=warm|cold] [--record] [--label=...]',
  'npm run bench -- neardup [--originals=600] [--runs=1] [--threshold=10] [--cache=warm|cold] [--record] [--label=...]',
  'npm run bench -- all [--small] [--runs=3] [--originals=600] [--record] [--label=...]',
  'npm run bench -- governor [--preset=eco|balanced|turbo] [--seconds=60] [--record] [--label=...]',
  'npm run bench -- scanhold [--corpus=enum200k|enum1m|ci20k|smoke|dupes100k] [--preset=eco|balanced|turbo] [--seconds=60] [--record] [--label=...]',
  '      the governor with a live scan as its load: native scans of the corpus back to back, the budget held from below (at most the ceiling and its band)',
  'npm run bench -- memory-path [--runtime=node|electron|both] [--sizes=1m,2m,3m,5m] [--corpus=enum1m] [--candidates=1m,5m] [--record] [--label=...]',
  "      Phase 4 T9: the native memory path's peak memory, stage by stage, each measurement in a fresh process — this machine's Node or the installed app's binary run as Node",
  'npm run bench -- compare <result.json> <baseline.json>      exit 0 PASS · 1 FAIL · 2 INCONCLUSIVE · 3 NOT COMPARABLE',
  'npm run bench -- clean                                       removes every corpus and probe under the temp directory',
];

const CORPUS_NAMES: readonly CorpusName[] = ['smoke', 'ci20k', 'enum200k', 'enum1m', 'dupes100k'];
const ENGINES: readonly EngineChoice[] = ['auto', 'native', 'gdu', 'walker'];
const CACHES: readonly RequestedCache[] = ['warm', 'cold'];
/** The enumerate suite's budget when none is named: the headline target's condition (see the usage line). */
const DEFAULT_ENUMERATE_PRESET: ScanPreset = 'turbo';
const RUNS_RANGE = { min: 1, max: 50 };
const DEFAULT_RUNS = 3;
const DEFAULT_MIN_SIZE = 1024;
const DEFAULT_ORIGINALS = 600;
const SMALL_ORIGINALS = 2;
const DEFAULT_THRESHOLD = 10;
const IMAGE_SEED = 5;
/** The governor hold: the plan's gate is 60 s per preset; under a second is not a hold. */
const DEFAULT_PRESET: GovernorPreset = 'balanced';
const DEFAULT_HOLD_SECONDS = 60;
const HOLD_SECONDS_RANGE = { min: 1, max: 3600 };
const EXIT_BY_VERDICT: Record<string, number> = { PASS: 0, FAIL: 1, INCONCLUSIVE: 2, 'NOT COMPARABLE': 3 };

/** Options are `--name=value` or a bare flag from a per-command allow-list; anything else is refused, never ignored. */
interface Parsed { positionals: string[]; options: Map<string, string>; flags: Set<string> }
const FLAGS = new Set(['record', 'small', 'help']);
const OPTIONS_BY_COMMAND: Record<string, readonly string[]> = {
  enumerate: ['corpus', 'engine', 'preset', 'runs', 'cache', 'label'],
  duplicates: ['corpus', 'runs', 'min-size', 'cache', 'label'],
  neardup: ['originals', 'runs', 'threshold', 'cache', 'label'],
  all: ['runs', 'originals', 'label'],
  governor: ['preset', 'seconds', 'label'],
  scanhold: ['corpus', 'preset', 'seconds', 'label'],
  'memory-path': ['runtime', 'sizes', 'corpus', 'candidates', 'label'],
  compare: [],
  clean: [],
  help: [],
};

function parse(argv: string[], command: string): Parsed {
  const allowed = OPTIONS_BY_COMMAND[command];
  if (!allowed) throw new Error(`unknown command "${command}"; run with --help`);
  const parsed: Parsed = { positionals: [], options: new Map(), flags: new Set() };
  for (const arg of argv) {
    if (!arg.startsWith('--')) { parsed.positionals.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (eq === -1) {
      if (!FLAGS.has(name)) throw new Error(`unknown option --${name}`);
      parsed.flags.add(name);
      continue;
    }
    if (!allowed.includes(name)) throw new Error(`unknown option --${name} for ${command}`);
    parsed.options.set(name, arg.slice(eq + 1));
  }
  return parsed;
}

function intOption(p: Parsed, name: string, fallback: number, min: number, max: number): number {
  const raw = p.options.get(name);
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  return n;
}

function oneOf<T extends string>(p: Parsed, name: string, fallback: T, allowedValues: readonly T[]): T {
  const v = p.options.get(name) ?? fallback;
  if (!(allowedValues as readonly string[]).includes(v)) throw new Error(`--${name} must be one of ${allowedValues.join(', ')}`);
  return v as T;
}

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) { try { total += fs.statSync(full).blocks * 512; } catch { /* vanished */ } }
    }
  }
  return total;
}

/** `memory-path` (Phase 4 T9): the matrix, printed as it goes, written to the results folder, and recorded on --record when every measurement succeeded. */
async function memoryPath(p: Parsed): Promise<void> {
  const mp = await import('./lib/memoryPath');
  const { describeMachine } = await import('./lib/machine');
  const runtime = oneOf(p, 'runtime', 'both', ['node', 'electron', 'both'] as const);
  const sizes = mp.parseSizes(p.options.get('sizes') ?? '1m,2m,3m,5m', 'sizes');
  const candidates = mp.parseSizes(p.options.get('candidates') ?? '1m,5m', 'candidates');
  const corpusName = p.options.get('corpus');
  let corpusRoot: string | undefined;
  if (corpusName !== undefined) {
    const name = oneOf(p, 'corpus', 'enum1m', CORPUS_NAMES);
    const corpus = await import('./lib/corpus');
    corpusRoot = (await corpus.ensureCorpus(name, corpus.CORPORA[name])).root;
  }
  const module = process.env.TREEMAP_NATIVE_MODULE ?? path.join(REPO, 'native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node');
  process.stdout.write(`memory path: ${runtime}, sizes ${sizes.join(', ')}, candidates ${candidates.join(', ')}${corpusRoot ? `, corpus ${corpusName}` : ''}, load ${(os.loadavg()[0] ?? 0).toFixed(2)}\n`);
  const measurements = await mp.runMemoryPathMatrix({
    runtimes: runtime === 'both' ? ['node', 'electron'] : [runtime],
    sizes, seed: 7, corpusRoot, candidates, module,
    onMeasured: (m) => process.stdout.write(`${mp.formatMeasurement(m)}\n`),
  });
  const record: import('./lib/memoryPath').MemoryPathRecord = {
    kind: 'memory-path', recordedAt: new Date().toISOString(), label: p.options.get('label') ?? 'memory-path',
    machine: await describeMachine(), module, measurements,
  };
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `memory-path-${record.recordedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`  written: ${path.relative(REPO, file)}\n`);
  const failed = measurements.filter((m) => !m.result.ok).length;
  if (failed > 0) process.exitCode = 1;
  if (!p.flags.has('record')) return;
  if (failed > 0 || record.machine.dirty) {
    process.stdout.write(`  NOT RECORDED as a baseline: ${failed > 0 ? `${failed} measurement(s) failed` : 'the tree is dirty'}\n`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(BASELINES_DIR, { recursive: true });
  const baseline = path.join(BASELINES_DIR, `memory-path-${process.platform}-${process.arch}.json`);
  fs.writeFileSync(baseline, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`  baseline: ${path.relative(REPO, baseline)}\n`);
}

async function main(): Promise<void> {
  const [, , command = 'help', ...rest] = process.argv;
  if (command === 'help' || command === '--help') {
    process.stdout.write(USAGE.join('\n') + '\n');
    return;
  }
  const p = parse(rest, command);
  if (p.flags.has('help')) { process.stdout.write(USAGE.join('\n') + '\n'); return; }

  const report = await import('./lib/report');

  if (command === 'compare') {
    const [current, baseline] = p.positionals;
    if (!current || !baseline) throw new Error('compare needs <result.json> <baseline.json>');
    const v = report.compareToBaseline(report.readResult(current), report.readResult(baseline));
    process.stdout.write(`${v.verdict}: ${v.sentence}\n`);
    process.exitCode = EXIT_BY_VERDICT[v.verdict] ?? 1;
    return;
  }

  if (command === 'clean') {
    const targets = [benchTmpDir(), ...fs.readdirSync(os.tmpdir()).filter((n) => /^treemap-bench-(probe|data)-/.test(n)).map((n) => path.join(os.tmpdir(), n))];
    for (const t of targets) {
      if (!fs.existsSync(t)) continue;
      const size = dirSize(t);
      fs.rmSync(t, { recursive: true, force: true, maxRetries: 3 });
      process.stdout.write(`removed ${t} (${(size / 1024 / 1024 / 1024).toFixed(2)} GB on disk)\n`);
    }
    return;
  }

  if (command === 'memory-path') {
    await memoryPath(p);
    return;
  }

  const suites = await import('./lib/suites');
  const corpus = await import('./lib/corpus');
  const images = await import('./lib/images');

  const record = p.flags.has('record');
  const label = p.options.get('label') ?? command;
  const results: BenchResult[] = [];

  const finish = (r: BenchResult): void => {
    results.push(r);
    const file = report.writeResult(r, RESULTS_DIR);
    process.stdout.write(`\n${report.printTable([r])}\n`);
    for (const note of r.correctness.notes) process.stdout.write(`  ${r.correctness.ok ? 'note' : 'CORRECTNESS'}: ${note}\n`);
    process.stdout.write(`  cache: ${r.cache.state} — ${r.cache.reason}\n`);
    process.stdout.write(`  budget: ${report.describeBudget(r)}\n`);
    process.stdout.write(`  scale: ${r.corpus.scale}\n`);
    process.stdout.write(`  engine: ${r.engine} — ${r.engineDescription}\n`);
    process.stdout.write(`  written: ${path.relative(REPO, file)}\n`);
    if (!r.correctness.ok) process.exitCode = 1;
    if (record) {
      const outcome = report.recordOrRefuse(r, BASELINES_DIR);
      if ('refused' in outcome) {
        process.stdout.write(`  NOT RECORDED as a baseline: ${outcome.refused}\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write(`  baseline: ${path.relative(REPO, outcome.recorded)}\n`);
      }
    }
  };

  const enumerate = async (corpusName: CorpusName, engine: EngineChoice, preset: ScanPreset, runs: number, cache: RequestedCache): Promise<void> => {
    const params = corpus.CORPORA[corpusName];
    process.stdout.write(`\ncorpus ${corpusName}: ${params.entries.toLocaleString('en-US')} entries (building or reusing under ${benchTmpDir()})…\n`);
    const manifest = await corpus.ensureCorpus(corpusName, params);
    process.stdout.write(`engine ${engine}, budget ${preset}, ${runs} run(s), cache ${cache}, load ${(os.loadavg()[0] ?? 0).toFixed(2)}\n`);
    finish(await suites.runEnumerate({ manifest, corpusName, engine, preset, runs, cache, label }));
  };
  const duplicates = async (corpusName: CorpusName, runs: number, minSize: number, cache: RequestedCache): Promise<void> => {
    const manifest = await corpus.ensureCorpus(corpusName, corpus.CORPORA[corpusName]);
    finish(await suites.runDuplicates({ manifest, corpusName, runs, minSize, cache, label }));
  };
  const nearDup = async (originals: number, runs: number, threshold: number, cache: RequestedCache): Promise<void> => {
    const root = path.join(benchTmpDir(), `images-${originals}-seed${IMAGE_SEED}`);
    const manifest = await images.ensureImageCorpus(root, { originals, seed: IMAGE_SEED, transforms: [...images.ALL_TRANSFORMS] });
    finish(await suites.runNearDup({ manifest, corpusName: `images${originals}`, runs, threshold, cache, label }));
  };

  switch (command) {
    case 'enumerate':
      await enumerate(oneOf(p, 'corpus', 'enum200k', CORPUS_NAMES), oneOf(p, 'engine', 'auto', ENGINES), oneOf(p, 'preset', DEFAULT_ENUMERATE_PRESET, SCAN_PRESETS), intOption(p, 'runs', DEFAULT_RUNS, RUNS_RANGE.min, RUNS_RANGE.max), oneOf(p, 'cache', 'warm', CACHES));
      break;
    case 'duplicates':
      await duplicates(oneOf(p, 'corpus', 'dupes100k', CORPUS_NAMES), intOption(p, 'runs', DEFAULT_RUNS, RUNS_RANGE.min, RUNS_RANGE.max), intOption(p, 'min-size', DEFAULT_MIN_SIZE, 1, 1 << 30), oneOf(p, 'cache', 'warm', CACHES));
      break;
    case 'neardup':
      await nearDup(intOption(p, 'originals', DEFAULT_ORIGINALS, 1, 20_000), intOption(p, 'runs', 1, RUNS_RANGE.min, RUNS_RANGE.max), intOption(p, 'threshold', DEFAULT_THRESHOLD, 0, 32), oneOf(p, 'cache', 'warm', CACHES));
      break;
    case 'all': {
      const small = p.flags.has('small');
      const runs = intOption(p, 'runs', DEFAULT_RUNS, RUNS_RANGE.min, RUNS_RANGE.max);
      const corpora: CorpusName[] = small ? ['smoke'] : ['enum200k', 'enum1m'];
      for (const corpusName of corpora) for (const engine of ['gdu', 'walker'] as const) await enumerate(corpusName, engine, DEFAULT_ENUMERATE_PRESET, runs, 'warm');
      await duplicates(small ? 'smoke' : 'dupes100k', runs, DEFAULT_MIN_SIZE, 'warm');
      await nearDup(small ? SMALL_ORIGINALS : intOption(p, 'originals', DEFAULT_ORIGINALS, 1, 20_000), 1, DEFAULT_THRESHOLD, 'warm');
      process.stdout.write(`\n${report.printTable(results)}\n`);
      break;
    }
    case 'governor': {
      const governor = await import('./lib/governorSuite');
      const preset = oneOf(p, 'preset', DEFAULT_PRESET, governor.GOVERNOR_PRESETS);
      const seconds = intOption(p, 'seconds', DEFAULT_HOLD_SECONDS, HOLD_SECONDS_RANGE.min, HOLD_SECONDS_RANGE.max);
      process.stdout.write(`\ngovernor: holding the ${preset} ceiling for ${seconds} s on this machine, load ${(os.loadavg()[0] ?? 0).toFixed(2)}\n`);
      finish(await governor.runGovernor({ preset, seconds, label }));
      break;
    }
    case 'scanhold': {
      const governor = await import('./lib/governorSuite');
      const corpusName = oneOf(p, 'corpus', 'enum200k', CORPUS_NAMES);
      const preset = oneOf(p, 'preset', DEFAULT_PRESET, governor.GOVERNOR_PRESETS);
      const seconds = intOption(p, 'seconds', DEFAULT_HOLD_SECONDS, HOLD_SECONDS_RANGE.min, HOLD_SECONDS_RANGE.max);
      const manifest = await corpus.ensureCorpus(corpusName, corpus.CORPORA[corpusName]);
      process.stdout.write(`\nscanhold: native scans of ${corpusName} back to back under ${preset} for ${seconds} s on this machine, load ${(os.loadavg()[0] ?? 0).toFixed(2)}\n`);
      finish(await suites.runScanHold({ manifest, corpusName, preset, seconds, label }));
      break;
    }
    default:
      throw new Error(`unknown command "${command}"; run with --help`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`bench: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
