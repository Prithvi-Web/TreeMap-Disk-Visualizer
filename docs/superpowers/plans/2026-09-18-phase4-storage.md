# Phase 4 — The store: a Rust-built store the app reads without copying, spill to disk, aggregate-only mode, and the 100M-entry gate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Progress (kept current so a context compaction loses nothing)

| Task | State | Evidence |
| --- | --- | --- |
| Plan written | 18 Sep 2026 | this file |
| S1 `tm-store`: the finalized store built in Rust, in the packed store's own layout | not started | |
| S2 `PackedScanStore.fromColumns` + the native engine reads the Rust store through views (no ingest copy) | not started | |
| S3 spill mode: columns written with `write()` then mapped, the free-space and same-volume rules, cleanup | not started | |
| S4 aggregate-only mode: directory rows, running totals, top-K, the notice naming what is off | not started | |
| S5 the synthetic-source gate: 100M entries from a scripted lister through the walk and the store, peak RSS measured by the harness | not started | |
| S6 docs and API: `storageMode` real, `cacheHitRate` honest, §9.1 amended with the measurement | not started | |
| Gate | not run | 100M synthetic scan inside the ceilings (spill ≤ 1.5 GB, aggregate ≤ 400 MB); 5M real corpus in memory ≤ 700 MB at 10M projected; the treemap, dashboard and largest-files views answer against it; equivalence digests unchanged |

**Goal:** the native engine's scan lives in a store built by Rust — the same columns `PackedScanStore` keeps today, so every consumer and every byte of JSON is unchanged — that spills to disk above a threshold, degrades to aggregate-only when the machine cannot afford the spill, and completes a 100M-entry scan inside the memory ceilings of the master prompt's §5.3.

**Architecture:** `tm-store` (new crate) takes a `WalkOutput` and produces the finalized columns in `PackedScanStore`'s exact layout (breadth-first ids, contiguous child ranges, the same flag bits, the same extension interning, names contiguous) after computing the derived facts the Node ingest computes today. `tm-node` hands the columns to JavaScript as typed-array views over Rust memory (anonymous in `memory` mode, a private mapping of the spill files in `spill` mode) and `PackedScanStore.fromColumns()` wraps them: no copy, no new store class, every method as today. The cloud-placeholder rule stays in Node (its path regex is the single source of truth) as a post-pass over the few candidates Rust names. Aggregate-only mode is a second, smaller output: directory rows plus per-directory totals and a bounded set of largest children, wrapped by the same store so the treemap and dashboard work, with the features that need leaf rows switched off and named in the UI.

**Tech stack:** Rust (std only for the store; `libc` for `mmap`/`statfs`/`write`; no new crate), napi 3.4 external typed arrays, TypeScript strict, node:test via tsx, the Phase 1 harness (`bench/`) for every measurement.

**House rules:** unchanged from Phases 2–3 (test first, one recorded mutant per behaviour, the strict lint set, `// SAFETY:` on every unsafe block, cross-target checks, no full `npm test` from an implementer, nothing downloaded, never the owner's real folders, never a number that was not measured). CI is Node 20.

---

## Decisions fixed by this plan

| # | Decision | Why |
| --- | --- | --- |
| P4-1 | **The store's layout is `PackedScanStore`'s**, column for column: `parent: Int32Array` (−1 at the root), `size: Float64Array`, `mtime: Float64Array` (ms), `atime: Float64Array` (ms; present when any node has one, the `HasAccessed` flag set per node), `flags: Uint16Array` with the `Flag` bits of `src/services/scanStore.ts`, `ext: Uint16Array` (0 = none) plus the extension dictionary as `string[]`, `container: Uint8Array` and `cloudProv: Uint8Array` with today's numeric encodings, `nameOff: Uint32Array` (n + 1) over a contiguous `names: Uint8Array`, `childStart: Uint32Array`, `childCnt: Uint32Array`; ids breadth-first exactly as `finalize()` assigns them (children consecutive in insertion order). | Byte-identical JSON by construction and no second store implementation; `fromColumns` is a constructor, not a class. Name deduplication (DESIGN §6) is withdrawn for this phase: the contiguous layout is what the store reads, and the on-disk saving it would buy is a follow-up recorded in §6. |
| P4-2 | **Derived facts move to Rust**, each with a test against the Node rule it mirrors: hidden (dot prefix), extension (Node's `path.extname` rule, lower-cased, without the dot), symlink, hard-link dedup in id order (first occurrence keeps the bytes; later ones size 0 + `HardlinkDup`), the signed sparse/slack delta gated on `blocksAreMeaningful` (passed from Node), `gitRepo` (a child named `.git`), container kind from a table Node passes (`[ext or name, kindId]` from `src/utils/containerKind.ts`), refused directories and the counters. The equivalence digest and the golden byte lock are the proof. | The ingest cannot run per entry in JavaScript at 100M; the rules are small and pinned by tests on both sides. |
| P4-3 | **Cloud placeholders stay in Node.** Rust reports the candidates (leaf, `size > 0`, `allocBytes = 0`, not a symlink) as a `Uint32Array` of ids; Node applies `cloudProviderFor(path)` to each and sets the flag, the provider and the tallies through the store. | The regex in `src/services/cloudFolders.ts` is the single source of truth and the candidates are rare. |
| P4-4 | **Three modes, chosen before the walk from the projection and re-checked at the end:** `memory` when the projected entries ≤ 5,000,000 (the `storageSpillThreshold` setting), `spill` above it when the app-data volume has ≥ 3 × the projected bytes free and is not the volume being measured (or the store's own files are excluded from the totals when it is), `aggregate` otherwise or when the owner selects it. The projection is the previous scan of the same root when one is on record, else the walk's own count at 5M entries (a walk that crosses the threshold in `memory` mode continues and converts at the end: the columns are written out, mapped, and the anonymous copy freed). The mode in force is `storageMode` in the stats. | The prompt's ceilings; DESIGN §6.1. |
| P4-5 | **Spill = `write()` then `mmap(MAP_PRIVATE, PROT_READ \| PROT_WRITE)`.** Files under `<appData>/scan-spill/<scanId>/<column>.bin`; the mapping is private so the store's small mutations (watcher, container expansion, cloud flags) copy only the pages they touch; freed and deleted when the scan is forgotten, on quit, and by a startup sweep of anything older than the scan TTL. | DESIGN §6.2 (why not `mmap` while writing); the prompt's "spill files never outlive the scan". |
| P4-6 | **Growth after finalize is bounded, not free:** `fromColumns` receives 1 % headroom rows (min 1,024) Rust allocates; an addition past the headroom reallocates the affected columns into JavaScript memory as `PackedScanStore` does today — correct, and recorded in the stats as `storageMode: 'memory'` from then on. | Container expansion and the watcher add a handful of nodes; a copy of a 100M-row column is the failure the headroom prevents. |
| P4-7 | **Aggregate-only keeps:** every directory row (parent, name, mtime, flags, the recursive totals as `size`), per directory: entry count, allocated bytes, a 16-bucket size histogram and the top 32 extensions by bytes (packed side tables), and its **largest 64 children by size** as real leaf rows (so the treemap's top levels and the largest-files view have real files to show); the global largest-N (N = 10,000) files as rows under their true parents. Everything else is not a row. **Off and named in the UI notice:** duplicates, near-duplicates, compare, CSV export of leaf rows, `/nodes` lookups of files not kept, the persistent index hand-off, the Time Capsule and cleanup rules that need every file. | DESIGN §6.1; the treemap only ever renders the top levels and the largest entries. |
| P4-8 | **The 100M gate runs on a synthetic listing, not a disk.** `tm-walk`'s `Lister` trait gets a scripted implementation (`SyntheticLister`: fan-out, depth, size distribution, seed) reachable from the napi surface behind `scanStart(root, { synthetic: {...} })` for `root` under the app's own temp directory, and the bench harness's `enumerate --corpus=synthetic100m` measures it in a child process like any other run, labelled **`source: synthetic` in every report and refused as a throughput baseline** (it lists no file system). Peak RSS is the harness's measurement, not the app's. | 100M real entries do not fit on this Mac (the 1M corpus is 34 GB); the ceiling being gated is the store's, and a synthetic listing exercises exactly the store. |
| P4-9 | **Incremental rescan for the native engine is not built in this phase, with the measurement recorded:** with one listing call per directory, revalidating every directory's own `(dev, ino, mtime)` costs the same syscalls as listing it, so an mtime-keyed index cannot be faster than the walk (the prompt's premise was one `stat` per file). The legacy walker keeps its mtime cache. A change-journal rescan (FSEvents / USN) is the only faster path and is recorded in DESIGN §9.1 as deferred, with this reason, for Phase 8's decision. `cacheHitRate` in the stats stays `null` with the reason in `engineReason`. | Honest numbers; no feature that cannot be measured to help. |
| P4-10 | **Every memory number comes from `bench/`** (peak RSS of the scanning child process, the mode, the entry count, this machine's tier), recorded under `bench/baselines/` with `--record` only on a clean tree. | Phase 1's rules. |

---

## Fixed interfaces

### `tm-store` (Rust)

```rust
pub struct BuildOptions {
    pub blocks_are_meaningful: bool,
    /// [(extension without the dot | full name, kind id)], from src/utils/containerKind.ts.
    pub container_kinds: Vec<(String, u8)>,
    pub headroom_rows: u32,            // P4-6
    pub mode: StoreMode,               // Memory | Spill { dir: PathBuf } | Aggregate
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)] pub enum StoreMode { Memory, Spill, Aggregate }

/// The finalized store: PackedScanStore's columns (P4-1) plus what Node needs to wrap them.
pub struct Store {
    pub mode: StoreMode, pub n: u32, pub capacity: u32,
    pub parent: Column<i32>, pub size: Column<f64>, pub mtime: Column<f64>, pub atime: Option<Column<f64>>,
    pub flags: Column<u16>, pub ext: Column<u16>, pub container: Column<u8>, pub cloud_prov: Column<u8>,
    pub name_off: Column<u32>, pub names: Column<u8>, pub child_start: Column<u32>, pub child_cnt: Column<u32>,
    pub ext_dict: Vec<String>,
    pub cloud_candidates: Vec<u32>,     // P4-3
    pub counters: Counters,             // fileCount, dirCount, hardlinkedFiles/Bytes, sparseFiles/Bytes, slackBytes, deniedDirs + examples, vanishedDirs, unreadableDirs, deniedEntries, unreadableEntries, dataless
    pub aggregate: Option<AggregateTables>, // P4-7, Aggregate mode only
}
/// A column is a Vec (Memory/Aggregate) or a private mapping of a spill file (Spill); Node sees both as one typed array.
pub enum Column<T> { Owned(Vec<T>), Mapped(Mapping<T>) }
pub fn build(walk: WalkOutput, opts: &BuildOptions) -> Result<Store, StoreError>;
pub fn spill_plan(projected_entries: u64, app_data_dir: &Path, scanned_root: &Path) -> SpillPlan; // { bytes_needed, free_bytes, same_volume, allowed: bool, reason: String }
pub fn sweep_spill_dir(app_data_dir: &Path, older_than: Duration) -> SweepReport;
```

### `tm-node` additions (declared in `native/index.d.ts`)

```ts
scanTake(handle: number): WalkResult;                // unchanged (Phase 3)
storeBuild(handle: number, opts: { blocksAreMeaningful: boolean; containerKinds: [string, number][]; headroomRows: number; mode: 'memory' | 'spill' | 'aggregate'; spillDir?: string }): StoreHandle;
storeColumns(store: StoreHandle): StoreColumns;      // the typed-array views (external; the store stays alive while any view does)
storeRelease(store: StoreHandle): void;              // unmaps and deletes spill files
storeSpillPlan(projectedEntries: number, appDataDir: string, root: string): SpillPlan;
storeSweep(appDataDir: string, olderThanMs: number): { removed: number; bytes: number; kept: number };
interface StoreColumns { mode; n; capacity; parent: Int32Array; size: Float64Array; mtime: Float64Array; atime: Float64Array | null; flags: Uint16Array; ext: Uint16Array; container: Uint8Array; cloudProv: Uint8Array; nameOff: Uint32Array; names: Uint8Array; childStart: Uint32Array; childCnt: Uint32Array; extDict: string[]; cloudCandidates: Uint32Array; counters: Counters; aggregate: AggregateTables | null }
```

### Node

* `PackedScanStore.fromColumns(rootPath, sep, cols: StoreColumns): PackedScanStore` — adopts the views (no copy); `finalized = true`; growth per P4-6; `release()` calls `storeRelease` when the scan is forgotten (`onScanForgotten`).
* `src/services/scan/nativeEngine.ts`: `runNativeWalk` becomes start → poll → `storeBuild` → `fromColumns` → the cloud post-pass → counters onto the record; `ingestColumns` stays for tests and as the oracle the Rust build is checked against (the same fixture through both must produce byte-identical pruned JSON).
* `src/services/storageMode.ts`: `chooseStorageMode(projection, plan, setting)`, the setting `storage: { spillThreshold: number; mode: 'auto' | 'memory' | 'spill' | 'aggregate' }`, validated at `PUT /api/settings`; the startup sweep in `src/server.ts`'s boot; the aggregate notice text and the list of disabled features exposed at `GET /api/scan/:id/stats` as `storageMode` plus `disabled: string[]`.
* Stats: `storageMode` becomes the mode in force; `cacheHitRate: null` with the reason; `peakRssBytes` stays null (per process).
* UI: the aggregate-mode notice on the Dashboard naming the disabled features; the Settings row "Scan storage" (Automatic / Always in memory / Spill to disk above N / Aggregate only) with one plain line each.

---

## Tasks

### S1: `tm-store` builds the finalized store (Rust)
**Files:** Create `crates/tm-store/{Cargo.toml,src/lib.rs,src/build.rs,src/derive.rs,src/finalize.rs,src/column.rs,src/aggregate.rs,src/spill.rs}`, `tests/{build,derive,finalize}.rs`; the workspace glob includes it.
- [ ] Tests first: `derive` — Node's `extname` cases (`a.b.c` → `c`, `.bashrc` → none, `a.` → none? — **check Node's documented behaviour and pin it**: `path.extname('a.')` is `'.'` so the extension is empty after the dot is stripped; `..` → none; `index.HTML` → `html`), hidden, hard-link dedup in id order with the tallies, sparse/slack signed delta on and off, gitRepo, container kinds from a passed table, refusals into the counters with the five smallest example paths; `finalize` — a scripted tree's ids, `childStart`/`childCnt`, `parent` and names come out exactly as a hand-computed breadth-first numbering (the same numbering `PackedScanStore.finalize()` produces: write the expected arrays by hand for a 12-node tree); `build` — a `WalkOutput` fixture in, a `Store` out, every column length `n`, `capacity = n + headroom`.
- [ ] **The child order (noted 23 Sep 2026, after `e9b1abd`/`28f197b`):** the macOS and Linux listers now hand each folder over sorted by *raw* name bytes, and the ingest keeps a stable sort by the *lossy UTF-8* names on every platform but Windows (`SORT_CHILDREN` in `nativeEngine.ts`). The Rust build must give exactly the ingest's order: the same where names are valid UTF-8, but not where two names differ only in invalid bytes (Linux) — test that case against `ingestColumns`, and on Windows keep the listing's order untouched.
- [ ] Implement; `cargo test -p tm-store`; clippy; cross-target checks; mutants (a wrong extname rule, dedup by name instead of (dev, ino), a child order that sorts by name, a missing tally).
- **Pinned before S1 (read-only prep, 23 Sep 2026, while Phase 3 waited for its CI; no Phase 4 code yet).** The rules the Rust build must reproduce, read from the TypeScript it replaces (`statToInput` in `src/services/scan/nodeInput.ts`, `detectContainerKind` in `src/utils/containerKind.ts`, `ingestColumns` in `src/services/scan/nativeEngine.ts`, `PackedScanStore.finalize` in `src/services/scanStore.ts`):
  - **Times are `Math.round`**, which rounds a half toward +∞: `Math.round(-1.5)` is −1, `Math.round(-0.5)` is −0, `Math.round(2.5)` is 3 (measured, Node 24). Rust's `f64::round` rounds a half away from zero (−1.5 → −2), so the build uses `(x + 0.5).floor()` with −0 kept — test mtimes before 1970 that end in .5 ms. An atime that is not above zero is omitted.
  - **Extension:** the last `.` at an index above 0 (a dotfile has none; `a.` and `..` leave nothing), then JavaScript `toLowerCase()` — full Unicode, Final_Sigma included: `FILE.ΑΣ` → `ας`, `a.ΣΑΣ` → `σας`, `x.İ` → `i` + U+0307, `y.ẞ` → `ß`, `z.ǅ` → `ǆ` (measured). Rust's `str::to_lowercase` implements the same rules; a differential test over those names and a random sample must hold the two equal. Files only. **Hidden** = the name starts with `.`.
  - **Container kind:** the suffix set and the order of `detectContainerKind` (`.photoslibrary` for folders; the Docker data files, `.tar.gz`/`.tgz`, `.zip`/`.jar`, `.tar`, `.iso`, `.dmg` for files), lower-cased — passed in as the table P4-2 names.
  - **Order and ids:** the ingest adds each folder's children breadth-first, sorted by raw name bytes (`strcmp`) except on Windows; `finalize` renumbers breadth-first by insertion order, so the final id of every node is its insertion order — the Rust build can emit final ids directly.
  - **Per-node facts:** a symlink is a leaf with no sparse or cloud check; a dataless file is a placeholder wherever it is (its provider from the Node-side path rule, P4-3), and otherwise the walker's guess (size above 0, nothing allocated, a path under a known cloud folder) stays a Node post-pass over the candidates; the first name of a hard-link family (by the walk's family number) keeps the bytes, a later one is size 0 + `HardlinkDup` + the tallies; the allocation delta counts sparse (negative) or slack (positive) bytes only where blocks mean anything and never for a duplicate or a placeholder; a child folder named `.git` sets `GitRepo` on its parent; refusals become the denied (with the five smallest example paths, Node side), vanished and unreadable counters.
- [ ] Commit `native(store): the finalized store built in Rust, in the packed store's own layout`.

### S2: the native engine reads the Rust store without copying (Rust + TypeScript)
**First, before any S2 code (found 23 Sep 2026 in napi-rs 3.4.0's source; RISKS R72):** zero copy is plain Node's alone. Measured 23 September 2026 with a throwaway napi probe calling `napi_create_external_arraybuffer`: Node 24.16 answers `napi_ok` (0); the installed TreeMap app's Electron 31.7.7, run as Node (`ELECTRON_RUN_AS_NODE=1`; its RunAsNode fuse is on), answers `napi_no_external_buffers_allowed` (22). The same day, handing the walk's 9.7 MB of columns for enum200k to plain Node grew `process.memoryUsage().arrayBuffers` by 0 MB against a 50 MB control that it counted — zero copy, measured — while in Electron that counter saw neither the hand-over nor the control (Electron allocates ArrayBuffers outside Node's allocator), so Electron's copy must be measured another way (RSS, time). Its cost, measured the same day on enum1m (1,000,002 entries, 48.9 MB of columns, two runs each): `scanTake` took 0.1 ms in Node and 6.3–7.2 ms in Electron (the copy, about 7 GB/s), and the process's peak RSS (`resourceUsage().maxRSS`, the OS counter) did not rise in either — the walk's own peak was higher than the copy's transient. So memory mode can keep the plan in Electron at about 7 ms per million entries; spill mode is where the cage decides the design. In Electron 31 — the desktop app — V8's memory cage refuses external ArrayBuffers and napi-rs copies each column instead. Measure, inside Electron (`ELECTRON_RUN_AS_NODE=1` against the bundled binary), the peak memory and the time of handing a 5M-row store over; if the copy is acceptable, the plan stands with "no copy" read as "no copy in web mode, one per column in Electron"; if not, the store is read through native calls in Electron.
**Files:** Modify `crates/tm-node/src/lib.rs`, `native/index.d.ts`, `native/README.md`, `src/services/scanStore.ts` (`fromColumns`, `release`), `src/services/scan/nativeEngine.ts`, `src/services/diskScanner.ts` (release on forget), `tests/nativeEngine.test.ts`, `tests/scanStore*.test.ts`.
- [ ] Tests first: `fromColumns` over hand-built columns behaves as a built store for every `ScanStore` method (the existing differential fuzz against `ObjectScanStore` is reused with a `fromColumns` producer); the same fixture through `ingestColumns` and through `storeBuild` + `fromColumns` gives byte-identical pruned JSON and equal counters; growth past the headroom reallocates and keeps every value; `storeRelease` after forget (a second `storeColumns` throws); the cloud post-pass sets the provider on a candidate under a cloud-looking path and nothing else.
- [ ] Implement (napi external typed arrays over the `Column`s, the finalizer keeping the store alive; the views' lengths are `n`, the buffers `capacity`).
- [ ] Measurement: `npm run bench -- enumerate --engine=native` on ci20k / enum200k / enum1m with peak RSS per node recorded beside the throughput; the 1M figure against `PackedScanStore`'s 49.7 B/node (Phase 0) — expected to be about the same in memory, because the layout is the same, and lower in the transient ingest peak.
- [ ] Commit `feat(engine): the native scan is read through views of the Rust store — no ingest copy`.

### S3: spill mode (Rust + TypeScript)
**Electron (RISKS R72):** a memory-mapped spill cannot be viewed from JavaScript inside Electron's memory cage, so in the desktop app spill mode needs a `ScanStore` whose reads go through native calls (batched, never per node in a hot loop), or spill is web-mode only with aggregate-only as Electron's large-scan path. Decide with S2's measurements, and write the decision here before S3's first test.
**Files:** `crates/tm-store/src/spill.rs`, `tests/spill.rs`; `src/services/storageMode.ts` (new), `src/server.ts` (sweep at boot), `src/services/settings.ts`, `src/api/settingsRoutes.ts`, `src/api/openapi.ts`, `tests/storageMode.test.ts`.
- [ ] Tests first: columns written then mapped read back identically (a 1M-row synthetic store); the private mapping accepts a write without touching the file; `spill_plan` refuses under 3 × (a fake `statfs` in the tests), flags the same volume, and names the reason; a released store's files are gone; the sweep removes only directories older than the TTL and reports what it kept; the mode chooser's table (projection × plan × setting).
- [ ] Implement; `cargo test`; the Node tests; a mutant per rule.
- [ ] Commit `feat(store): spill — columns written to app-data and mapped privately, with the free-space and same-volume rules`.

### S4: aggregate-only mode (Rust + TypeScript + UI)
**Files:** `crates/tm-store/src/aggregate.rs`, `tests/aggregate.rs`; `src/services/scan/nativeEngine.ts`, `src/api/scanRoutes.ts`, `src/ui/markup/…dashboard…`, `src/ui/app/…`, `tests/aggregateMode.test.ts`, `tests/aggregateUi.test.ts`.
- [ ] Tests first: an aggregate build of a scripted tree keeps every directory, the largest 64 children per directory and the global largest 10,000, with `size` totals equal to the full build's; the treemap route, `/large-files`, `/stats` and the dashboard answer against it; every disabled route answers 409 `STORAGE_MODE` naming the feature; the notice renders the list.
- [ ] Implement; commit `feat(store): aggregate-only mode — directory rows and the largest entries, with what it switches off named`.

### S5: the synthetic-source gate (Rust + bench)
**Files:** `crates/tm-walk/src/platform/synthetic.rs` (a scripted `Lister` behind `WalkOptions.synthetic`), `crates/tm-node` (`scanStart` accepts `synthetic`), `bench/lib/corpus.ts` (`synthetic100m`, `synthetic10m` presets that create nothing on disk), `bench/lib/suites.ts`, `bench/lib/report.ts` (`source: synthetic`, refused as a throughput baseline), `tests/benchSynthetic.test.ts`.
- [ ] Tests first: the synthetic lister is deterministic for a seed, produces the requested count, and is refused for a root outside the app's temp directory; the report labels the source and `bench compare` refuses to compare it with a file-system run.
- [ ] Measure: `synthetic10m` in `memory` mode (peak RSS ≤ 700 MB expected only at 5M+headroom; the plan's own number for 10M in memory is over the ceiling — the spill threshold is why), `synthetic100m` in `spill` and in `aggregate`; record with `--record` on a clean tree; the numbers go into DESIGN §7 as measurements beside the budgets.
- [ ] Commit `bench: the synthetic listing source and the 100M-entry memory gate`.

### S6: docs and API
- [ ] `docs/engine/DESIGN.md` §6/§7/§9.1 amended with what was measured; `CURRENT-STATE.md` §11 gains the store numbers; `openapi.ts` `storageMode` enum and `disabled`; README's storage sentence updated only with harness numbers.

### Phase gate
* `synthetic100m`: peak RSS ≤ 1.5 GB in `spill`, ≤ 400 MB in `aggregate`; the treemap, dashboard and largest-files views answer within their existing budgets against it (measured through the API in the bench child, not the browser).
* A 5M-projected real scan (enum1m plus the corpus scaled, or the synthetic at 5M) stays under 700 MB in `memory`.
* Every equivalence digest of Phase 3 unchanged (the Rust build is the ingest's twin).
* Full gate as always.
