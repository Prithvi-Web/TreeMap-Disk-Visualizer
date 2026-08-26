/**
 * bench-v4 — the performance gate for v4 (§2.5).
 *
 *   npm run bench:v4                  measure and print the pass/fail table
 *   npm run bench:v4 -- --record      record the current numbers as the baseline
 *   npm run bench:v4 -- --files=20000 smaller fixture (faster, noisier)
 *   npm run bench:v4 -- --runs=15     more repetitions, tighter resolution
 *
 * Every later phase runs this. Three things about it are deliberate, and each
 * exists because the alternative would produce a number that lies.
 *
 * **1. Load average is printed beside every figure.** The project's own design
 * note says it plainly: a throughput figure without the load it was taken
 * under is not a claim about anything. This machine has been observed running
 * the same test suite in 11 s and in 42 s.
 *
 * **2. There is a third verdict.** §2.5 budgets scan throughput at "no more
 * than 2% slower than baseline" — which on a working desktop is close to the
 * noise floor. Rather than report noise as a result, every scan figure carries
 * the resolution it was measured at (the median's 2-SE band, from a robust
 * IQR-based dispersion estimate), and a difference smaller than that band
 * prints INCONCLUSIVE with the band stated. An honest "I cannot tell at this
 * resolution" is worth more than a confident coin flip, and it is the same
 * rule the UI follows for an unavailable signal. Raise --runs to tighten it.
 *
 * **3. The browser budgets are not measured here, and are not pretended.**
 * Three of §2.5's six budgets — canvas first paint, interaction frame, and
 * main-thread block — are properties of a rendering engine, and this harness
 * runs in Node. They print as NOT MEASURED HERE with the reason and where the
 * real figure comes from. Inventing a plausible number for them would defeat
 * the entire point of having a gate.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

/* --------------------------------- args --------------------------------- */

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const REPO = path.join(__dirname, '..');
const FIXTURE_FILES = Number(arg('files', '50000'));
// Seven, not five: the resolution estimate is built from an interquartile
// range, and four points make a poor one. Seven runs of a 1.4 s scan costs ten
// seconds and roughly halves the width of the band.
const SCAN_RUNS = Number(arg('runs', '7'));
const RECORD = flag('record');
const BASELINE_FILE = path.join(REPO, 'scripts', 'bench-v4-baseline.json');

/**
 * The fixture lives in the OS temp dir, never in the repo: it is tens of
 * thousands of files, and a benchmark that dirties `git status` is one nobody
 * runs twice.
 */
const FIXTURE_DIR = path.join(os.tmpdir(), `treemap-bench-v4-${FIXTURE_FILES}`);

// Isolate app data before anything imports a service that resolves it. The
// user's installed TreeMap.app writes to the real directory continuously, and
// a benchmark must not share a scheduler, a snapshot store or a settings file
// with it.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-v4-data-'));
process.env.TREEMAP_DATA_DIR = DATA_DIR;

/* -------------------------------- helpers -------------------------------- */

const loadAvg = (): string => os.loadavg().map((n) => n.toFixed(2)).join(' / ');
const ms = (n: number): string => `${n.toFixed(1)} ms`;
const pct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The resolution of this measurement, as a percentage of its own median.
 *
 * Not max-minus-min: over a handful of runs a single scheduler hiccup sets
 * that, and the noise floor then swallows real regressions. This is the
 * standard error of the *median* — the quantity that actually decides whether
 * two medians can be told apart — built from a robust dispersion estimate so
 * one outlier cannot dominate it:
 *
 *   sigma ≈ IQR / 1.349        (the normal-distribution relationship)
 *   SE    ≈ 1.2533 · sigma / √n   (the median's standard error)
 *
 * Reported at 2 SE, roughly a 95% band. On a quiet machine this lands near
 * 1%, which makes §2.5's 2% scan budget genuinely checkable; under load it
 * widens honestly and the verdict becomes INCONCLUSIVE rather than a guess.
 */
function resolutionPct(values: number[]): number {
  const m = median(values);
  if (m <= 0 || values.length < 2) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (q: number): number => {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };
  const iqr = quantile(0.75) - quantile(0.25);
  const sigma = iqr / 1.349;
  const se = (1.2533 * sigma) / Math.sqrt(values.length);
  return ((2 * se) / m) * 100;
}

/** Full observed range, printed alongside — the raw fact behind the estimate. */
function rangePct(values: number[]): number {
  const m = median(values);
  if (m <= 0) return 0;
  return ((Math.max(...values) - Math.min(...values)) / m) * 100;
}

type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NO BASELINE' | 'NOT MEASURED HERE';

interface Row {
  budget: string;
  measured: string;
  limit: string;
  verdict: Verdict;
  /** Printed under the row. Mandatory for anything that is not a plain PASS. */
  note?: string;
}

const rows: Row[] = [];

/* -------------------------------- fixture -------------------------------- */

const FIXTURE_DIRS = 100;
const perDir = Math.ceil(FIXTURE_FILES / FIXTURE_DIRS);

/** Deterministic path list — the same every run, so runs are comparable. */
function fixturePaths(count: number): string[] {
  const out: string[] = [];
  outer: for (let d = 0; d < FIXTURE_DIRS; d++) {
    for (let f = 0; f < perDir; f++) {
      out.push(path.join(FIXTURE_DIR, `d${String(d).padStart(3, '0')}`, `f${String(f).padStart(5, '0')}.dat`));
      if (out.length >= count) break outer;
    }
  }
  return out;
}

/**
 * Build the fixture, or reuse an intact one.
 *
 * Reuse matters: creating 50,000 files takes far longer than the measurement
 * itself, and rebuilding it every run would make the first scan of each
 * session a cold-cache outlier.
 */
async function ensureFixture(): Promise<{ built: boolean; files: number }> {
  const marker = path.join(FIXTURE_DIR, '.bench-complete');
  try {
    const stamp = await fsp.readFile(marker, 'utf8');
    if (Number(stamp) === FIXTURE_FILES) return { built: false, files: FIXTURE_FILES };
  } catch { /* absent or unreadable — rebuild */ }

  await fsp.rm(FIXTURE_DIR, { recursive: true, force: true });
  let written = 0;
  for (let d = 0; d < FIXTURE_DIRS && written < FIXTURE_FILES; d++) {
    const dir = path.join(FIXTURE_DIR, `d${String(d).padStart(3, '0')}`);
    await fsp.mkdir(dir, { recursive: true });
    for (let f = 0; f < perDir && written < FIXTURE_FILES; f++) {
      // Sizes vary deterministically so the tree is not uniform — a treemap
      // over identical files exercises none of the layout's real work.
      await fsp.writeFile(path.join(dir, `f${String(f).padStart(5, '0')}.dat`), Buffer.alloc(64 + ((d * 7 + f) % 512)));
      written++;
    }
  }
  await fsp.writeFile(marker, String(FIXTURE_FILES));
  return { built: true, files: written };
}

/* ------------------------------ 1. scan throughput ------------------------------ */

interface ScanMeasurement {
  medianMs: number;
  /** 2-SE resolution of the median, as a percentage of it. */
  resolution: number;
  /** Full observed max-min range, as a percentage of the median. */
  range: number;
  items: number;
  engine: string;
  runs: number[];
}

async function measureScan(): Promise<ScanMeasurement> {
  // Imported here rather than at module scope so TREEMAP_DATA_DIR is already
  // set when the service resolves it.
  const { startScan, getScan } = await import('../src/services/diskScanner');

  const runs: number[] = [];
  let items = 0;
  let engine = 'unknown';

  // One discarded warm-up: the first walk of a fresh fixture pays for a cold
  // directory cache, which is a property of the filesystem, not of this code.
  for (let i = 0; i < SCAN_RUNS + 1; i++) {
    const started = performance.now();
    const scan = await startScan(FIXTURE_DIR);
    for (;;) {
      const current = getScan(scan.scanId);
      if (!current || current.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const elapsed = performance.now() - started;
    const done = getScan(scan.scanId);
    if (i === 0) continue; // warm-up
    runs.push(elapsed);
    items = (done?.fileCount ?? 0) + (done?.dirCount ?? 0);
    engine = done?.engine ?? 'unknown';
  }

  return { medianMs: median(runs), resolution: resolutionPct(runs), range: rangePct(runs), items, engine, runs };
}

/* ------------------------------ 2. per-node memory ------------------------------ */

/**
 * Shell out to the existing store benchmark, exactly as §2.5 specifies.
 *
 * A separate process is required, not incidental: the figure is a settled-heap
 * delta and needs --expose-gc, and measuring it inside a process that has
 * already scanned 50,000 files would report this harness's own allocations.
 *
 * **The V8 flags go AFTER the tsx entry point, not before it.** tsx re-spawns
 * node for the script it runs, and flags given to the outer process are not
 * forwarded to that child — so `node --expose-gc <tsx> bench-store.ts` leaves
 * `global.gc` undefined in the benchmark. bench-store then measures an
 * unsettled heap and reports roughly 123 B/node against a true 50.9. It says
 * so in its own output, which is why `settled` below is checked rather than
 * trusted: a benchmark that reports an unsettled figure as a measurement
 * would have failed this budget for no reason today, and could hide a real
 * regression tomorrow.
 */
function measureStoreBytesPerNode(nodes: number): { bytes: number; settled: true } | { reason: string; settled: false } {
  const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
  const result = spawnSync(
    process.execPath,
    [tsxCli, '--expose-gc', '--max-old-space-size=8192', path.join(REPO, 'scripts', 'bench-store.ts'), '--mode=packed', `--nodes=${nodes}`],
    { cwd: REPO, encoding: 'utf8' },
  );
  const stdout = result.stdout ?? '';
  if (/run with --expose-gc/.test(stdout)) {
    return { settled: false, reason: 'bench-store ran without --expose-gc, so its bytes/item figure is unsettled heap, not a measurement. The flag must follow the tsx entry point.' };
  }
  const match = /bytes\/item\s+([\d.]+)/.exec(stdout);
  if (!match) {
    return { settled: false, reason: `bench-store reported no bytes/item figure (exit ${result.status}). Run it directly to see why.` };
  }
  return { settled: true, bytes: Number(match[1]) };
}

/* ------------------------------ 3. the fact sidecar ------------------------------ */

function request(port: number, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        host: '127.0.0.1', port, path: url, method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

interface FactMeasurement {
  provider: string;
  totalMs: number;
  batches: number;
  computed: number;
  requested: number;
}

/**
 * §2.5 budgets a sidecar endpoint at 400 ms for 5,000 paths, while §4.1 caps a
 * request at 2,000. Both cannot describe one request, so this measures what a
 * real caller must actually do: 5,000 paths as three sequential batches, timed
 * end to end against the single 400 ms budget. Sequential, not parallel —
 * parallel would measure the machine's core count rather than the endpoint.
 */
async function measureFacts(): Promise<FactMeasurement[] | null> {
  const { createApp } = await import('../src/server');
  const { resetRateLimiter } = await import('../src/middleware/rateLimiter');
  const { startScan, getScan } = await import('../src/services/diskScanner');
  const { clearFactCache } = await import('../src/services/facts');

  resetRateLimiter();
  const server = http.createServer(createApp(path.join(REPO, 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  try {
    const scan = await startScan(FIXTURE_DIR);
    for (;;) {
      const current = getScan(scan.scanId);
      if (!current || current.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 5));
    }

    const paths = fixturePaths(5000);
    if (paths.length < 5000) return null;

    // Cold: a cache hit would measure the Map, not the provider.
    clearFactCache();

    const batches = [paths.slice(0, 2000), paths.slice(2000, 4000), paths.slice(4000, 5000)];

    // One row per provider, because the endpoint's cost is the provider's
    // cost. Measuring only the cheapest one would let an expensive provider
    // blow the budget without the gate ever noticing — which is exactly what
    // a Spotlight-first `lastUsed` would have done at ~0.36 ms/path.
    const out: FactMeasurement[] = [];
    for (const provider of ['size', 'lastUsed']) {
      clearFactCache(); // cold: a cache hit would measure the Map, not the provider
      let computed = 0;
      let requested = 0;
      const started = performance.now();
      for (const batch of batches) {
        const r = await request(port, 'POST', '/api/facts', {
          scanId: scan.scanId, paths: batch, providers: [provider],
        });
        if (r.status !== 200) throw new Error(`/api/facts answered ${r.status}: ${JSON.stringify(r.body)}`);
        computed += r.body.providers[provider].stats.computed;
        requested += r.body.providers[provider].stats.requested;
      }
      out.push({ provider, totalMs: performance.now() - started, batches: batches.length, computed, requested });
    }
    return out;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/* -------------------------------- baseline -------------------------------- */

interface Baseline {
  recordedAt: string;
  platform: string;
  node: string;
  loadAvg: string;
  engine: string;
  fixtureFiles: number;
  scanMedianMs: number;
  /** The 2-SE resolution this baseline was measured at. */
  scanResolutionPct: number;
  scanItems: number;
}

function readBaseline(): Baseline | null {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) as Baseline;
  } catch {
    return null;
  }
}

/* ---------------------------------- main ---------------------------------- */

async function main(): Promise<void> {
  const startedLoad = loadAvg();
  process.stdout.write(`\nTreeMap v4 budget report\n`);
  process.stdout.write(`  ${new Date().toISOString()}  ·  ${process.platform}-${process.arch}  ·  node ${process.version}\n`);
  process.stdout.write(`  load average at start: ${startedLoad}\n\n`);

  const fixture = await ensureFixture();
  process.stdout.write(
    `  fixture: ${fixture.files.toLocaleString()} files in ${FIXTURE_DIRS} folders at ${FIXTURE_DIR}` +
    `${fixture.built ? ' (built now)' : ' (reused)'}\n\n`,
  );

  /* --- scan throughput --- */
  const scan = await measureScan();
  const base = readBaseline();
  const itemsPerSec = Math.round(scan.items / (scan.medianMs / 1000));
  const measured = `${ms(scan.medianMs)} · ${itemsPerSec.toLocaleString()} items/s · ±${scan.resolution.toFixed(1)}% (range ${scan.range.toFixed(1)}%)`;

  if (!base) {
    rows.push({
      budget: `Scan throughput (${scan.items.toLocaleString()} items, ${scan.engine})`,
      measured, limit: '≤ +2% vs baseline', verdict: 'NO BASELINE',
      note: `No baseline recorded yet. Run: npm run bench:v4 -- --record`,
    });
  } else if (base.platform !== `${process.platform}-${process.arch}` || base.engine !== scan.engine || base.fixtureFiles !== FIXTURE_FILES) {
    // A committed baseline is one machine's measurement, not a universal
    // constant. Comparing this Mac's figure against a Linux CI runner — or
    // against a different scan engine, or a different fixture — would produce
    // a percentage that means nothing. Say so and ask for a re-record rather
    // than printing a number nobody should act on.
    rows.push({
      budget: `Scan throughput (${scan.items.toLocaleString()} items, ${scan.engine})`,
      measured, limit: '≤ +2% vs baseline', verdict: 'NOT MEASURED HERE',
      note: `Baseline: ${base.platform}, engine "${base.engine}", ${base.fixtureFiles.toLocaleString()} files. ` +
            `This run: ${process.platform}-${process.arch}, engine "${scan.engine}", ${FIXTURE_FILES.toLocaleString()} files. ` +
            `Different machine, engine or fixture means a different measurement — re-record with --record on this machine.`,
    });
  } else {
    const delta = ((scan.medianMs - base.scanMedianMs) / base.scanMedianMs) * 100;
    // The noise floor is the larger of the two runs' own spreads. A regression
    // smaller than that is not something this measurement can see.
    const noise = Math.max(scan.resolution, base.scanResolutionPct);
    let verdict: Verdict;
    let note: string | undefined;
    if (delta <= 2) {
      verdict = 'PASS';
      note = `${pct(delta)} vs baseline ${ms(base.scanMedianMs)} (recorded ${base.recordedAt.slice(0, 10)}, load ${base.loadAvg}).`;
    } else if (delta <= noise) {
      verdict = 'INCONCLUSIVE';
      note = `${pct(delta)} vs baseline ${ms(base.scanMedianMs)}, but the two runs resolve to only ±${noise.toFixed(1)}% — ` +
             `the difference is inside the measurement's own error bars. Re-run on a quieter machine, or raise --runs, before treating it as real.`;
    } else {
      verdict = 'FAIL';
      note = `${pct(delta)} vs baseline ${ms(base.scanMedianMs)}, which exceeds both the 2% budget and the ±${noise.toFixed(1)}% resolution of the measurement.`;
    }
    rows.push({ budget: `Scan throughput (${scan.items.toLocaleString()} items, ${scan.engine})`, measured, limit: '≤ +2% vs baseline', verdict, note });
  }

  /* --- per-node memory --- */
  for (const nodes of [1_000_000, 5_000_000]) {
    const store = measureStoreBytesPerNode(nodes);
    if (!store.settled) {
      rows.push({
        budget: `Per-node memory (${(nodes / 1_000_000)}M nodes)`,
        measured: '—', limit: '≤ 56 B/node', verdict: 'NOT MEASURED HERE',
        note: store.reason,
      });
    } else {
      rows.push({
        budget: `Per-node memory (${(nodes / 1_000_000)}M nodes)`,
        measured: `${store.bytes.toFixed(1)} B/node`, limit: '≤ 56 B/node',
        verdict: store.bytes <= 56 ? 'PASS' : 'FAIL',
        note: store.bytes <= 56
          ? `${(56 - store.bytes).toFixed(1)} B/node of headroom.`
          : `${(store.bytes - 56).toFixed(1)} B/node over budget.`,
      });
    }
  }

  /* --- the fact sidecar --- */
  const facts = await measureFacts();
  if (!facts) {
    rows.push({
      budget: 'Fact sidecar (5,000 paths)', measured: '—', limit: '≤ 400 ms', verdict: 'NOT MEASURED HERE',
      note: `The fixture holds fewer than 5,000 files — re-run without --files, or with --files=5000 or more.`,
    });
  } else {
    for (const f of facts) {
      rows.push({
        budget: `Fact sidecar: ${f.provider} (${f.requested.toLocaleString()} paths, ${f.batches} batches)`,
        measured: ms(f.totalMs), limit: '≤ 400 ms',
        verdict: f.totalMs <= 400 ? 'PASS' : 'FAIL',
        note: `${f.computed.toLocaleString()} of ${f.requested.toLocaleString()} computed. ` +
              `Sent as ${f.batches} sequential requests because §4.1 caps one request at 2,000 paths.`,
      });
    }
  }

  /* --- the browser budgets --- */
  rows.push({
    budget: 'Canvas view, first paint (250k nodes)', measured: '—', limit: '≤ 250 ms', verdict: 'NOT MEASURED HERE',
    note: 'A rendering-engine property; this harness runs in Node. Measured in the browser with performance.now() around the render, behind the debug flag, and pasted into the phase check-in.',
  });
  rows.push({
    budget: 'Canvas view, interaction frame', measured: '—', limit: '≤ 16 ms median, ≤ 33 ms p95', verdict: 'NOT MEASURED HERE',
    note: 'Same reason. Measured from rAF timings over a 5-second pan/zoom in the real app.',
  });
  rows.push({
    budget: 'Main-thread block, single UI action', measured: '—', limit: '≤ 50 ms', verdict: 'NOT MEASURED HERE',
    note: 'Same reason. Measured in the browser; refreshCartButtons documents why it matters — a 30.5 ms block was worth fixing.',
  });

  /* --- the table --- */
  const w = Math.max(...rows.map((r) => r.budget.length), 40);
  const mw = Math.max(...rows.map((r) => r.measured.length), 10);
  const lw = Math.max(...rows.map((r) => r.limit.length), 8);
  process.stdout.write(`  ${'Budget'.padEnd(w)}  ${'Measured'.padEnd(mw)}  ${'Limit'.padEnd(lw)}  Verdict\n`);
  process.stdout.write(`  ${'─'.repeat(w + mw + lw + 24)}\n`);
  for (const r of rows) {
    process.stdout.write(`  ${r.budget.padEnd(w)}  ${r.measured.padEnd(mw)}  ${r.limit.padEnd(lw)}  ${r.verdict}\n`);
    if (r.note) process.stdout.write(`  ${' '.repeat(w)}  ${r.note}\n`);
  }

  const count = (v: Verdict): number => rows.filter((r) => r.verdict === v).length;
  const failed = rows.filter((r) => r.verdict === 'FAIL');

  process.stdout.write(`\n  load average at end:   ${loadAvg()}\n`);
  const tally = [
    `${count('PASS')} pass`,
    `${count('FAIL')} fail`,
    `${count('INCONCLUSIVE')} inconclusive`,
    `${count('NO BASELINE')} without a baseline`,
    `${count('NOT MEASURED HERE')} not measurable in Node`,
  ].filter((part) => !part.startsWith('0 '));
  process.stdout.write(`\n  ${tally.join(' · ')}\n`);
  if (count('NOT MEASURED HERE') > 0) {
    process.stdout.write(`  Rows that were not measured are deliberately not guessed at — see each note.\n`);
  }

  if (RECORD) {
    const baseline: Baseline = {
      recordedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      loadAvg: startedLoad,
      engine: scan.engine,
      fixtureFiles: FIXTURE_FILES,
      scanMedianMs: scan.medianMs,
      scanResolutionPct: scan.resolution,
      scanItems: scan.items,
    };
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
    process.stdout.write(`\n  Baseline written to ${path.relative(REPO, BASELINE_FILE)}\n`);
  }
  process.stdout.write('\n');

  await fsp.rm(DATA_DIR, { recursive: true, force: true });
  // A FAIL is a build failure; INCONCLUSIVE and NOT MEASURED HERE are not,
  // because neither is evidence that anything regressed.
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('bench-v4 failed:', err);
  process.exit(1);
});
