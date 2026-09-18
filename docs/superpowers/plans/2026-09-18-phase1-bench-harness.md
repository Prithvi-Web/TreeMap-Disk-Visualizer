# Phase 1 — Benchmark harness, corpus generators, cache control, legacy baselines

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run bench` measures the scan, duplicate and near-duplicate engines on
deterministic synthetic corpora, records every number with the conditions it was
taken under, refuses to label what it cannot verify, and commits the legacy
engines' baselines under `bench/baselines/` so every later "Nx faster" has a
referent.

**Architecture:** a `bench/` directory of small TypeScript modules run by `tsx`
(the repo's existing script convention, see `scripts/bench-v4.ts`), with pure
helpers (stats, report schema, manifest checks) unit-tested under `tests/`, a
seeded generator that plans a corpus as typed arrays and creates it with
worker threads, and a runner that drives the *real* engines in-process
(`startScan`, `getDuplicateJob`, `getNearDupeJob`) under an isolated
`TREEMAP_DATA_DIR`. No new npm dependency: images come from `sharp`, which
ships already.

**Tech stack:** Node 20+/24, TypeScript strict, `node:test` via `tsx`, `sharp`,
one C probe compiled on demand on macOS.

**House rules that bind every task:** test first and watch it fail; every new
assertion gets one recorded mutant (assert the anchor count inside the mutation
step); never edit a source while any `npm test` is running; run only your own
test file (`npx tsx --test --test-reporter=tap tests/<file>.test.ts`), never
the whole suite, until the final gate; never scan or touch the owner's real
folders — every corpus lives under `os.tmpdir()`; no number is printed that
was not measured.

---

## File structure

| File | Responsibility |
| --- | --- |
| `bench/lib/prng.ts` | `mulberry32(seed)`, `hash32(a, b)` — the one source of determinism |
| `bench/lib/stats.ts` | `median`, `resolutionBand`, `spreadPct`, `formatMs` — pure arithmetic |
| `bench/lib/machine.ts` | `describeMachine()` — CPU, cores, memory, OS, Node, commit, load, `kern.maxvnodes`, tier label |
| `bench/lib/rusage.ts` | `snapshotUsage()` — CPU seconds, peak RSS, bytes read (or `{ unavailable, reason }`), children's CPU |
| `bench/probes/darwin-rusage.c` | `proc_pid_rusage` probe, compiled by `rusage.ts` on macOS |
| `bench/lib/cache.ts` | `cacheState()` — `'cold'` only after a successful purge; `'warm'`, `'mixed'`, `'unknown'` |
| `bench/lib/corpus.ts` | `planCorpus(params)` (typed arrays), `createCorpus(dir, plan)` (workers), manifest, `expectedTotals` |
| `bench/lib/corpusWorker.ts` | worker entry: creates one range of the plan |
| `bench/lib/images.ts` | `createImageCorpus(dir, params)` — originals + planted variants + manifest; `scoreClusters` |
| `bench/lib/report.ts` | `BenchResult` schema, `writeResult`, `compareToBaseline`, `printTable` |
| `bench/lib/verify.ts` | `checkScanAgainstManifest`, `checkDuplicatesAgainstManifest` (recall/precision + byte compare) |
| `bench/run.ts` | CLI: `enumerate`, `duplicates`, `neardup`, `all`, `compare` |
| `bench/README.md` | how to run, cache procedures, the honesty rules, tiers |
| `bench/baselines/*.json` | committed legacy results |
| `bench/results/` | gitignored |
| `tests/benchStats.test.ts`, `tests/benchCorpus.test.ts`, `tests/benchImages.test.ts`, `tests/benchReport.test.ts`, `tests/benchCache.test.ts`, `tests/benchRusage.test.ts` | one test file per module |
| `tests/rateLimiterLanes.test.ts` | the flood keeps ≤ 64 sockets open (Task 7) |
| `package.json` | `"bench": "tsx bench/run.ts"`; `.gitignore` gains `/bench/results/` |

Corpora live at `os.tmpdir()/treemap-bench/<name>-<8 hex of params hash>/` with a
`manifest.json`; an existing corpus whose manifest matches the params is reused.

---

### Task 1: PRNG and stats

**Files:** Create `bench/lib/prng.ts`, `bench/lib/stats.ts`; Test `tests/benchStats.test.ts`

- [ ] **Step 1: failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, hash32 } from '../bench/lib/prng';
import { median, resolutionBand, spreadPct } from '../bench/lib/stats';

test('the same seed yields the same sequence, a different seed a different one', () => {
  const a = mulberry32(7), b = mulberry32(7), c = mulberry32(8);
  const sa = [a(), a(), a()], sb = [b(), b(), b()], sc = [c(), c(), c()];
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  for (const x of sa) assert.ok(x >= 0 && x < 1);
});

test('hash32 mixes both inputs', () => {
  assert.notEqual(hash32(1, 2), hash32(2, 1));
  assert.equal(hash32(5, 9), hash32(5, 9));
});

test('median of odd and even counts', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('spread is (max - min) / median, in percent', () => {
  assert.equal(spreadPct([100, 110, 90]), 20);
});

test('the resolution band is the two-SE IQR estimate of the median, in percent', () => {
  // seven identical runs: zero band
  assert.equal(resolutionBand([5, 5, 5, 5, 5, 5, 5]), 0);
  // a wide spread produces a wider band than a narrow one
  assert.ok(resolutionBand([90, 95, 100, 105, 110, 115, 120]) > resolutionBand([99, 99.5, 100, 100.5, 101, 101.5, 102]));
});
```

- [ ] **Step 2: run** `npx tsx --test tests/benchStats.test.ts` → FAIL (module not found)
- [ ] **Step 3: implement**

```ts
// bench/lib/prng.ts
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hash32(a: number, b: number): number {
  let h = (a >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = (h ^ (b >>> 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
```

```ts
// bench/lib/stats.ts — median, IQR-based 2-SE band (the bench-v4 rule), spread
export function median(values: number[]): number { /* sort copy; middle or mean of two middles */ }
export function spreadPct(values: number[]): number { /* (max-min)/median*100 */ }
export function resolutionBand(values: number[]): number {
  // sigma ≈ IQR/1.349; SE of the median ≈ 1.2533·sigma/sqrt(n); band = 2·SE / median · 100
}
export const formatMs = (n: number): string => `${n.toFixed(1)} ms`;
```

- [ ] **Step 4: run → PASS. Step 5: mutant** — change `spreadPct` to divide by `min`; the spread test must go red; restore. **Step 6: commit** `bench: seeded PRNG and the measurement arithmetic`.

### Task 2: machine record and resource usage

**Files:** Create `bench/lib/machine.ts`, `bench/lib/rusage.ts`, `bench/probes/darwin-rusage.c`; Test `tests/benchRusage.test.ts`

- [ ] **Step 1: failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMachine } from '../bench/lib/machine';
import { snapshotUsage, diffUsage } from '../bench/lib/rusage';

test('the machine record names what every number depends on', async () => {
  const m = await describeMachine();
  assert.ok(m.cpuModel.length > 0);
  assert.ok(m.cores >= 1);
  assert.ok(m.memoryBytes > 0);
  assert.equal(typeof m.platform, 'string');
  assert.match(m.node, /^v\d+/);
  assert.match(m.commit, /^[0-9a-f]{7,40}$|^unknown$/);
  assert.ok(['A', 'B', 'C'].includes(m.tier));
  if (process.platform === 'darwin') assert.ok((m.maxVnodes ?? 0) > 0);
});

test('a usage snapshot carries CPU seconds and peak RSS, and either bytes read or a stated reason', async () => {
  const s = await snapshotUsage();
  assert.ok(s.cpuSeconds >= 0);
  assert.ok(s.peakRssBytes > 0);
  if (s.bytesRead === null) assert.ok(s.bytesReadReason.length > 10);
  else assert.ok(s.bytesRead >= 0);
});

test('diffUsage never reports a negative delta', async () => {
  const a = await snapshotUsage();
  const b = await snapshotUsage();
  const d = diffUsage(a, b);
  assert.ok(d.cpuSeconds >= 0);
  if (d.bytesRead !== null) assert.ok(d.bytesRead >= 0);
});
```

- [ ] **Step 2: run → FAIL. Step 3: implement**

`machine.ts`: `os.cpus()[0].model`, `os.cpus().length`, `os.totalmem()`, `os.release()`, `process.version`, `git rev-parse HEAD` via `spawnSync` (`'unknown'` on failure), `os.loadavg()`, on darwin `sysctl -n kern.maxvnodes hw.perflevel0.logicalcpu hw.perflevel1.logicalcpu`. Tier: A if (cores ≥ 8 and memory ≥ 32 GB) or the CPU model contains `Pro`/`Max`/`Ultra`; C if cores ≤ 4 or memory ≤ 8 GB; else B.

`rusage.ts`: `process.resourceUsage()` gives `userCPUTime + systemCPUTime` (µs) and `maxRSS` (KiB on macOS/Linux, bytes on Windows — normalise with `process.platform`). Bytes read: Linux reads `/proc/self/io` `read_bytes`; macOS compiles `bench/probes/darwin-rusage.c` once into `os.tmpdir()/treemap-bench/probes/` with `xcrun --sdk macosx clang -O2 -isysroot $(xcrun --sdk macosx --show-sdk-path)` (this machine's plain `cc` cannot link — `CURRENT-STATE.md` §12) and runs it with the PID, parsing `diskBytesRead`, `childUserNs`, `childSystemNs`, `peakFootprint`; on Windows returns `null` with reason `'bytes read are not exposed to Node on Windows; GetProcessIoCounters needs native code'`; when the probe fails to compile, `null` with the compiler's message. The C probe prints one JSON line from `rusage_info_v4`: `ri_diskio_bytesread`, `ri_diskio_byteswritten`, `ri_user_time`, `ri_system_time`, `ri_child_user_time`, `ri_child_system_time`, `ri_lifetime_max_phys_footprint`.

- [ ] **Step 4: run → PASS. Step 5: mutant** — make `diffUsage` return `b - a` without clamping and feed it a fake `a` larger than `b` in a fourth test (`diffUsage({...a, cpuSeconds: 9}, {...a, cpuSeconds: 1})` must throw `'usage went backwards'`, not return −8); watch it go red, then implement the throw. **Step 6: commit** `bench: machine record and resource usage, with bytes read on macOS and Linux`.

### Task 3: cache state

**Files:** Create `bench/lib/cache.ts`; Test `tests/benchCache.test.ts`

- [ ] **Step 1: failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheState } from '../bench/lib/cache';

test('a run is labelled cold only when the purge procedure itself succeeded', async () => {
  const ok = await cacheState({ requested: 'cold', purge: async () => ({ ok: true, command: 'sudo -n purge' }), entries: 1000, maxVnodes: 250000, warmedUp: false });
  assert.equal(ok.state, 'cold');
  const failed = await cacheState({ requested: 'cold', purge: async () => ({ ok: false, command: 'sudo -n purge', error: 'a password is required' }), entries: 1000, maxVnodes: 250000, warmedUp: false });
  assert.equal(failed.state, 'unknown');
  assert.match(failed.reason, /password/);
});

test('warm needs a warm-up pass and a tree that fits the vnode cache', async () => {
  const warm = await cacheState({ requested: 'warm', purge: async () => ({ ok: false, command: '' }), entries: 200_000, maxVnodes: 251_127, warmedUp: true });
  assert.equal(warm.state, 'warm');
  const mixed = await cacheState({ requested: 'warm', purge: async () => ({ ok: false, command: '' }), entries: 1_000_000, maxVnodes: 251_127, warmedUp: true });
  assert.equal(mixed.state, 'mixed');
  assert.match(mixed.reason, /1,000,000.*251,127/);
  const notWarmed = await cacheState({ requested: 'warm', purge: async () => ({ ok: false, command: '' }), entries: 10, maxVnodes: 251_127, warmedUp: false });
  assert.equal(notWarmed.state, 'unknown');
});
```

- [ ] **Step 2: run → FAIL. Step 3: implement** `cacheState(opts): Promise<{ state: 'cold'|'warm'|'mixed'|'unknown'; reason: string; procedure?: string }>`; the default `purge` runs `sudo -n purge` on darwin, `sync && sudo -n sh -c 'echo 3 > /proc/sys/vm/drop_caches'` on linux, and on win32 returns `{ ok: false, error: 'no unattended procedure; run RAMMap → Empty Standby List and pass --cache=cold-manual, which is recorded as unverified' }`. `maxVnodes` is `undefined` off macOS and the vnode rule is skipped there (warm = warmed up).
- [ ] **Step 4 → PASS. Step 5: mutant** — make a failed purge return `'cold'`; red; restore. **Step 6: commit** `bench: a run is cold only when the purge ran`.

### Task 4: the corpus generator

**Files:** Create `bench/lib/corpus.ts`, `bench/lib/corpusWorker.ts`; Test `tests/benchCorpus.test.ts`

```ts
// bench/lib/corpus.ts — public surface
export interface CorpusParams {
  entries: number;          // files + directories
  fanout: number;           // max subdirectories per directory
  depth: number;            // max depth below the root
  flat: number;             // one directory with this many direct children (0 = none)
  sizeMedian: number;       // bytes, log-normal median
  sizeSigma: number;        // log-normal sigma (natural log)
  sizeMax: number;          // cap in bytes
  duplicateRate: number;    // fraction of files whose bytes equal an earlier file's
  hardlinkRate: number;     // fraction of files that are an extra name for an earlier file in the same directory
  sparseRate: number;       // fraction of files created with ftruncate only (no blocks)
  seed: number;
}
export interface CorpusPlan {
  params: CorpusParams;
  dirParent: Int32Array;    // per directory (0 = root)
  dirNameId: Uint32Array;   // name = `d${id}`
  fileDir: Int32Array;      // per file
  fileSize: Float64Array;
  fileContent: Uint32Array; // content id; equal ids ⇒ identical bytes
  fileRole: Uint8Array;     // 0 plain, 1 duplicate, 2 hardlink (target = fileHardlinkOf), 3 sparse
  fileHardlinkOf: Int32Array;
}
export interface CorpusManifest {
  name: string; params: CorpusParams; createdAt: string; root: string;
  dirs: number; files: number; logicalBytes: number;         // hard-link extra names count 0 bytes, sparse count their logical size
  duplicateGroups: Array<{ content: number; size: number; paths: string[] }>;   // groups with ≥ 2 members
  hardlinkFamilies: Array<{ target: string; links: string[] }>;
  sparseFiles: Array<{ path: string; logicalSize: number }>;
  flatDir: string | null;
  planDigest: string;   // sha256 of the typed arrays — the reproducibility proof
}
export function planCorpus(params: CorpusParams): CorpusPlan;
export function manifestFor(plan: CorpusPlan, root: string, name: string): CorpusManifest;
export async function createCorpus(root: string, plan: CorpusPlan, opts?: { workers?: number }): Promise<CorpusManifest>;
export function contentBytes(content: number, size: number): Buffer;   // deterministic; used by workers and by the tests
export function corpusDir(name: string, params: CorpusParams): string;  // os.tmpdir()/treemap-bench/<name>-<hash8>
export async function ensureCorpus(name: string, params: CorpusParams): Promise<CorpusManifest>;  // reuse if manifest matches
export const CORPORA: Record<'enum200k' | 'enum1m' | 'dupes100k', CorpusParams>;
```

- [ ] **Step 1: failing tests** (a 3,000-entry corpus in a temp dir, removed in `after`)

```ts
test('planning is deterministic: same params, same digest; a different seed, a different digest', ...)  // sha256 of arrays
test('the plan has exactly the requested number of entries and honours fanout, depth and flat', ...)
test('planted rates are within half a percent of the request', ...)  // duplicateRate 0.12 → count of role-1 files / files
test('files that share a content id are byte-identical and files that differ do not', ...)  // contentBytes(7, 4096) equal; (7,4096) vs (8,4096) differ
test('same-size non-duplicates exist so the size bucket stage has work to do', ...)  // ≥ 10% of plain files share a size with another plain file (sizes are quantised to 1 KiB under 64 KiB)
test('createCorpus writes what the plan says and the manifest states the truth', ...)  // stat every path in a 3,000-entry corpus: sizes match, hard links share an inode (nlink 2), sparse files have blocks 0, the manifest's logicalBytes equals the sum
test('ensureCorpus reuses a corpus whose manifest matches and rebuilds one whose params changed', ...)
```

- [ ] **Step 2: run → FAIL. Step 3: implement**
  * `planCorpus`: directories first — a breadth-first tree, each directory getting `1 + floor(rng()·fanout)` children while depth allows, stopping when `dirs ≈ entries × 0.12` (or the flat directory is added as the root's first child); then files assigned to directories by a Zipf-like draw (`dir = floor(dirs · rng()^2)`) so a few directories are large and most are small; the flat directory receives exactly `flat` files. Sizes: `exp(ln(median) + sigma·gauss())`, capped, quantised to 1 KiB below 64 KiB. Roles by `rng()` against the rates; a duplicate copies the content id of a uniformly chosen earlier plain file and its size; a hard link targets the most recent plain file in the same directory (falls back to plain if none); a sparse file gets `8–64 MiB` logical and content id 0.
  * `contentBytes(content, size)`: `mulberry32(hash32(content, size))` filling a `Buffer` in 4-byte words — identical for identical ids, distinct otherwise.
  * `createCorpus`: `mkdir -p` every directory in the main thread, then split the file index range into `workers` (default `min(8, cores)`) contiguous chunks — hard links inside a chunk are ordered after their target because the target is always earlier in the same directory, so chunks are cut only on directory boundaries; workers receive the typed arrays as `SharedArrayBuffer` views; each worker writes files with `fs.writeFileSync` (`fs.linkSync` for role 2, `fs.truncateSync` for role 3).
  * `manifestFor` walks the arrays once to build the groups and totals; `planDigest` = sha256 over the concatenated array buffers.
  * `CORPORA`: `enum200k` `{ entries: 200_000, fanout: 12, depth: 8, flat: 10_000, sizeMedian: 1024, sizeSigma: 1.2, sizeMax: 2 * 1024 * 1024, duplicateRate: 0, hardlinkRate: 0.01, sparseRate: 0.001, seed: 2 }`; `enum1m` the same with `entries: 1_000_000, seed: 4`; `dupes100k` `{ entries: 112_000, fanout: 10, depth: 6, flat: 0, sizeMedian: 8192, sizeSigma: 1.6, sizeMax: 64 * 1024 * 1024, duplicateRate: 0.12, hardlinkRate: 0.005, sparseRate: 0.001, seed: 3 }` (~100k files, about 5 GB — one tenth of the prompt's file count and one hundredth of its bytes, and labelled so).
- [ ] **Step 4 → PASS (the 3,000-entry create must finish under 5 s). Step 5: mutant** — make `contentBytes` ignore `content`; the byte-identity test must go red; restore. **Step 6: commit** `bench: a deterministic corpus with planted duplicates, hard links and sparse files`.

### Task 5: the image corpus

**Files:** Create `bench/lib/images.ts`; Test `tests/benchImages.test.ts` (skips with a stated reason if `sharp` will not load)

```ts
export type Transform = 'resize' | 'reencode-q40' | 'reencode-q70' | 'crop-5' | 'crop-10' | 'crop-20' | 'rotate-90' | 'watermark' | 'screenshot' | 'png' | 'webp' | 'colour-shift';
export interface ImageCorpusParams { originals: number; seed: number; transforms: Transform[] }
export interface ImageManifest { params: ImageCorpusParams; root: string; images: Array<{ path: string; original: number; transform: Transform | 'original' }>; }
export async function createImageCorpus(root: string, params: ImageCorpusParams): Promise<ImageManifest>;
export function scoreClusters(manifest: ImageManifest, clusters: string[][]): { recall: Record<Transform, number>; precision: number; pairs: number };
```

- [ ] **Step 1: failing tests** — a 4-original corpus: every original has one file per transform in the manifest; files exist and decode with sharp to sane dimensions (crop-10 is 90% of the original's width); `scoreClusters` on a hand-built perfect clustering returns recall 1 for every transform and precision 1, and on a clustering that joins two different originals returns precision < 1.
- [ ] **Step 2: run → FAIL. Step 3: implement** — originals: 1600×1200 (every third one 1200×1600) built as a raw RGB buffer from the seeded PRNG: a two-colour vertical gradient, 6–12 filled rectangles and circles at seeded positions and colours, plus 3% noise, encoded JPEG q92. Variants with sharp: `resize` to 50%; `reencode-q40/q70` JPEG; `crop-N` extract the central `(100−N)%`; `rotate-90`; `watermark` composite a 25%-opacity grey rectangle over the lower-right sixth; `screenshot` composite the image at 70% inside a 1920×1080 grey frame with a dark 40 px bar; `png`, `webp`; `colour-shift` `modulate({ hue: 25, brightness: 1.1 })`. Concurrency 4. `scoreClusters`: a variant is recalled when it shares a cluster with its original; precision = pairs in the same cluster that share an original / all same-cluster pairs.
- [ ] **Step 4 → PASS. Step 5: mutant** — make `scoreClusters` count a variant as recalled when it is in *any* cluster; the perfect-vs-broken test must go red; restore. **Step 6: commit** `bench: a labelled image corpus with planted transformations`.

### Task 6: report schema, verification and the runner

**Files:** Create `bench/lib/report.ts`, `bench/lib/verify.ts`, `bench/run.ts`, `bench/README.md`; Modify `package.json` (scripts), `.gitignore`; Test `tests/benchReport.test.ts`

```ts
// bench/lib/report.ts
export interface BenchResult {
  suite: 'enumerate' | 'duplicates' | 'neardup';
  corpus: { name: string; params: unknown; dirs?: number; files?: number; images?: number; scale: string };
  engine: string;                       // 'gdu-turbo' | 'turbo-walker' | 'walker' | 'sha256-staged' | 'dhash-pairwise' | later 'native'
  machine: MachineRecord;
  cache: { state: 'cold' | 'warm' | 'mixed' | 'unknown'; reason: string };
  runs: Array<{ wallMs: number; entries: number; cpuSeconds: number; childCpuSeconds: number | null; peakRssBytes: number; bytesRead: number | null; loadAvg: number[] }>;
  summary: { wallMsMedian: number; entriesPerSecond: number; cpuSecondsPerMillion: number; peakRssBytes: number; bytesReadMedian: number | null; spreadPct: number; resolutionPct: number; reproducible: boolean /* spreadPct < 5 */ };
  correctness: { ok: boolean; notes: string[] };   // counts against the manifest; duplicates recall/precision + byte compare; near-dup recall per transform
  recordedAt: string; commit: string; label: string;
}
export function summarize(runs: BenchResult['runs']): BenchResult['summary'];
export function compareToBaseline(current: BenchResult, baseline: BenchResult): { verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE'; deltaPct: number; band: number; sentence: string };  // FAIL when slower by more than max(10, band)%; INCONCLUSIVE inside the band
export function printTable(results: BenchResult[]): string;
export function writeResult(r: BenchResult, dir: string): string;
```

- [ ] **Step 1: failing tests** — `summarize` computes entries/s from the median wall and cpuSecondsPerMillion from the median CPU; `reproducible` is false at 6% spread and true at 4%; `compareToBaseline` says FAIL at +15% with a 2% band, INCONCLUSIVE at +1% with a 2% band, PASS at −20%; `checkScanAgainstManifest` fails when `fileCount` is off by one and lists the differing field; `checkDuplicatesAgainstManifest` reports recall 1/precision 1 for the planted groups and byte-compares every reported group (a fixture with two files of equal size but different bytes reported as a group → precision < 1 and a note naming the pair).
- [ ] **Step 2: run → FAIL. Step 3: implement** the modules above and the runner:

```
npm run bench -- enumerate [--corpus=enum200k|enum1m] [--engine=auto|gdu|walker] [--runs=3] [--cache=warm|cold] [--record] [--label=...]
npm run bench -- duplicates [--corpus=dupes100k] [--runs=3] [--record]
npm run bench -- neardup [--originals=600] [--runs=1] [--record]
npm run bench -- all
npm run bench -- compare <result.json> <baseline.json>
```

The runner: sets `process.env.TREEMAP_DATA_DIR` to a fresh temp dir **before** importing any service; sets `TREEMAP_NO_GDU=1` for `--engine=walker`; imports `startScan`/`getScan`/`cancelAllScans` from `../src/services/diskScanner`, `getDuplicateJob` from `../src/services/duplicateFinder`, `getNearDupeJob` from `../src/services/perceptualDupes`; for each run: warm-up pass when `--cache=warm` (one un-measured scan), or the purge procedure when `--cache=cold`; snapshot usage, `performance.now()`, `await startScan(root)` then poll `scan.status` every 50 ms, snapshot again, record; verifies counts against the manifest after the first run; prints the table with load average beside every row; writes `bench/results/<suite>-<engine>-<corpus>-<timestamp>.json`; `--record` also writes `bench/baselines/<suite>-<engine>-<corpus>-tier<X>.json`. Duplicates: `getDuplicateJob(scan, 1024)` polled to completion, then `checkDuplicatesAgainstManifest` (byte compare via `fs.readFileSync` pairs within each reported group — the corpus is small enough). Near-dup: `getNearDupeJob(scan, 10)`, then `scoreClusters`; the result notes when the legacy cap truncated the corpus. `all` runs `enumerate` on both corpora with both engines, `duplicates`, `neardup`, and prints one table.

- [ ] **Step 4 → PASS. Step 5: mutant** — make `compareToBaseline` treat a +15% delta as PASS; red; restore. **Step 6:** `bench/README.md` (run commands, what each column means, the cache procedures — `sudo -v && npm run bench -- enumerate --cache=cold` on macOS, why a run without a successful purge is never called cold, the vnode-cache rule and `kern.maxvnodes`, the tier table, and the sentence that a first cold scan of a large drive is bound by the hardware). **Step 7: commit** `bench: the runner, the report, and the checks that make a number honest`.

### Task 7: the lane-drain test keeps at most 64 sockets open

**Files:** Modify `tests/rateLimiterLanes.test.ts:162-177` and its `req` helper

- [ ] **Step 1:** run `npx tsx --test --test-reporter=tap tests/rateLimiterLanes.test.ts` → 1 fail with `ECONNRESET` (recorded in `CURRENT-STATE.md` §13: 200 simultaneous connects against a backlog macOS clamps to 128).
- [ ] **Step 2:** give the flood an `http.Agent({ keepAlive: false, maxSockets: 64 })` (a module-level `FLOOD_AGENT`) and pass it in `req`'s options for that test only, with a comment naming the cause; the request count stays 200 and both assertions stay as they are.
- [ ] **Step 3:** run → 6 pass. **Step 4: prove the fix is the cause** — set `maxSockets: 512` temporarily, run → red again; restore to 64. **Step 5: commit** `test: the lane-drain flood keeps 64 sockets open, so macOS 27's backlog reset cannot fail it`.

### Task 8: baselines

- [ ] **Step 1:** `npm run bench -- enumerate --corpus=enum200k --engine=gdu --runs=3 --cache=warm --record` then the same with `--engine=walker`; then `--corpus=enum1m` for both (cache will report `mixed`); `npm run bench -- duplicates --record`; `npm run bench -- neardup --record`. Every run's load average must be under the core count; rerun any run whose spread is over 5%.
- [ ] **Step 2:** commit `bench: baselines of the legacy engines on this Tier B machine` with the summary table in the message.
- [ ] **Step 3:** final gate — `npm run typecheck`, `npm test` (whole suite, now with the lane fix: expect 0 failures), `node scripts/build-ui.js --check`.

## Self-review

* Spec coverage: generator parameters (entry count, fanout, depth, size distribution, duplicate/hardlink/sparse rates, image transformations) — Tasks 4, 5. Runner fields (wall, entries/s, CPU user+sys, peak RSS, bytes read, cache state; syscall count is reported as `not obtainable without root` on macOS) — Tasks 2, 6. Cache control with refusal — Task 3. Baselines committed — Task 8. Variance < 5% — `reproducible` in Task 6.
* Types: `BenchResult.summary` fields are the ones `compareToBaseline` and `printTable` read; `CorpusManifest.logicalBytes` is what `checkScanAgainstManifest` compares to the scan's root size; `scoreClusters` returns `recall` keyed by `Transform`.
