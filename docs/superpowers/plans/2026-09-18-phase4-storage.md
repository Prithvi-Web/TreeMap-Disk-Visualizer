# Phase 4 — The store: a Rust-built store the app reads without copying, spill to disk, aggregate-only mode, and the 100M-entry gate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Progress (kept current so a context compaction loses nothing)

| Task | State | Evidence |
| --- | --- | --- |
| Plan written | 18 Sep 2026 | this file |
| S1 `tm-store`: the finalized store built in Rust, in the packed store's own layout | **done 24 Sep 2026**, commit `2415d6c`, committed after Phase 3's CI went green (run 36069755180): 41 tests, 89 mutants red, clippy on three targets, rustdoc `-D warnings`. The six-lens review's 29 CONFIRMED findings are all fixed (index mix-ups pinned with walks whose order differs from the store's; cloud × hard-link order; side tables refused unless strictly ascending, then binary-searched; `sparse_terms` so Node sums `sparseBytes` in the ingest's order past 2^53), and a second review of the fix round confirmed 6 more, repaired | `native/treemap-core/crates/tm-store/`; `docs/superpowers/plans/2026-09-24-phase4-s1-review-findings.md` |
| S2 `PackedScanStore.fromColumns` + the native engine reads the Rust store through views (no ingest copy) | **Node side done 24 Sep 2026**, commit `38469ee`: `PackedScanStore.adoptColumns` (the `fromColumns` above) adopts a finalized tree's columns in place, held to the object-store oracle on 96 random trees; 20 mutants, 19 red, the survivor explained in the code. The rest of S2 is T1–T10 (§S.9); T10 commits S2 | `src/services/scanStore.ts`; `tests/packedStoreAdopt.test.ts`; `tests/fixtures/storeFuzz.ts` |
| S3–S5 as designed (§S below) | **designed 24 Sep 2026.** T0 (documents only) is written; its gate (§S.9) is the owner's answers to Q1–Q5 and Q7 (§S.11): Q1, Q3 and Q5 wait for the owner, and Q2, Q4 and Q7 are engineering decisions awaiting the owner's confirmation. T1–T23 are not built | §S below |
| S3 spill mode: columns written with `write()` ~~then mapped~~ and read with `pread()` (P4-5a), the free-space and same-volume rules, cleanup | not started: T11–T17 (T17 commits S3); the FullPassRunner is S3b, T18 | |
| S4 aggregate-only mode: ~~directory rows~~ rows kept by the β rule (P4-7a), running totals, top-K, the notice naming what is off | not started: T12 (the AggregateState, which spill runs too), T19 (commits S4), T20 (Windows large mode) | |
| S5 the synthetic-source gate: 100M entries from a scripted lister through the walk and the store, peak RSS measured by the harness | not started: T3 (the `SyntheticLister`, moved forward), T21 (bench plumbing), T22 (the gate) | |
| S6 docs and API: `storageMode` real, `cacheHitRate` honest, §9.1 amended with the measurement | not started: T23 | |
| Gate | not run: T22 (§S.8's pass conditions) | 100M synthetic scan inside the ceilings (spill ≤ 1.5 GB, aggregate ≤ 400 MB); 5M real corpus in memory ≤ 700 MB at 10M projected; the treemap, dashboard and largest-files views answer against it; equivalence digests unchanged |

**Goal:** the native engine's scan lives in a store built by Rust — the same columns `PackedScanStore` keeps today, so every consumer and every byte of JSON is unchanged — that spills to disk above a threshold, degrades to aggregate-only when the machine cannot afford the spill, and completes a 100M-entry scan inside the memory ceilings of the master prompt's §5.3.

**Architecture:** `tm-store` (new crate) takes a `WalkOutput` and produces the finalized columns in `PackedScanStore`'s exact layout (breadth-first ids, contiguous child ranges, the same flag bits, the same extension interning, names contiguous) after computing the derived facts the Node ingest computes today. `tm-node` hands the columns to JavaScript as typed-array views over Rust memory (anonymous in `memory` mode, a private mapping of the spill files in `spill` mode) and `PackedScanStore.fromColumns()` wraps them: no copy, no new store class, every method as today. The cloud-placeholder rule stays in Node (its path regex is the single source of truth) as a post-pass over the candidates Rust names (not always few: see P4-3). Aggregate-only mode is a second, smaller output: directory rows plus per-directory totals and a bounded set of largest children, wrapped by the same store so the treemap and dashboard work, with the features that need leaf rows switched off and named in the UI. **Amended 24 Sep 2026 — see §S.0:** nothing is mapped (P4-5a); spill and aggregate are fed during the walk (§S.1); aggregate keeps rows by thresholds, not every directory (P4-7a); the large modes evaluate the cloud table in Rust (P4-3a).

**Tech stack:** Rust (std only for the store; `libc` for `mmap`/`statfs`/`write`; no new crate), napi 3.4 external typed arrays, TypeScript strict, node:test via tsx, the Phase 1 harness (`bench/`) for every measurement.

**House rules:** unchanged from Phases 2–3 (test first, one recorded mutant per behaviour, the strict lint set, `// SAFETY:` on every unsafe block, cross-target checks, no full `npm test` from an implementer, nothing downloaded, never the owner's real folders, never a number that was not measured). CI is Node 20.

---

## Decisions fixed by this plan

| # | Decision | Why |
| --- | --- | --- |
| P4-1 | **The store's layout is `PackedScanStore`'s**, column for column: `parent: Int32Array` (−1 at the root), `size: Float64Array`, `mtime: Float64Array` (ms), `atime: Float64Array` (ms; present when any node has one, the `HasAccessed` flag set per node), `flags: Uint16Array` with the `Flag` bits of `src/services/scanStore.ts`, `ext: Uint16Array` (0 = none) plus the extension dictionary as `string[]`, `container: Uint8Array` and `cloudProv: Uint8Array` with today's numeric encodings, `nameOff: Uint32Array` (n + 1) over a contiguous `names: Uint8Array`, `childStart: Uint32Array`, `childCnt: Uint32Array`; ~~ids breadth-first exactly as `finalize()` assigns them (children consecutive in insertion order)~~. **P4-1a (amended 24 Sep 2026 — see §S.0):** ids come in one block per listing. A worker lists and orders a whole folder, reserves one contiguous id range under a commit lock, then writes the rows. Invariants I1–I4 (§S.2) hold by construction; ids are no longer breadth-first. §S.2 argues that no output depends on the numbering, and T2's renumbering battery tests it. The column layout does not change. | Byte-identical JSON by construction and ~~no second store implementation~~ one store class on the main thread (P4-12, added 24 Sep 2026 — see §S.0: a `NativeScanStore` exists only inside worker threads); ~~`fromColumns` is a constructor, not a class.~~ `fromColumns` is not a class: it was built as the instance method `PackedScanStore.adoptColumns` on a root-only store (commit `38469ee`). Name deduplication (DESIGN §6) is withdrawn for this phase: the contiguous layout is what the store reads, and the on-disk saving it would buy is a follow-up recorded in §6. |
| P4-2 | **Derived facts move to Rust**, each with a test against the Node rule it mirrors: hidden (dot prefix), extension (Node's `path.extname` rule, lower-cased, without the dot), symlink, ~~hard-link dedup in id order (first occurrence keeps the bytes; later ones size 0 + `HardlinkDup`)~~ hard-link dedup (the winner keeps the bytes; the others are size 0 + `HardlinkDup`; P4-2a), the signed sparse/slack delta gated on `blocksAreMeaningful` (passed from Node), `gitRepo` (a child named `.git`), container kind from a table Node passes (`[ext or name, kindId]` from `src/utils/containerKind.ts`), refused directories and the counters. The equivalence digest and the golden byte lock are the proof. **P4-2a (amended 24 Sep 2026 — see §S.0):** the hard-link winner is the member of a family that comes first in breadth-first order, compared by position path (depth, then the child positions from the root). This is the same member as today, stated without ids (§S.2 Lemma 3), so native output does not change (Q9, §S.11). The digest cannot see the winner (it gives a family's bytes to its smallest path), so a dedicated cross-folder fixture pins it. | The ingest cannot run per entry in JavaScript at 100M; the rules are small and pinned by tests on both sides. |
| P4-3 | ~~**Cloud placeholders stay in Node.**~~ **In memory mode, cloud placeholders stay in Node.** Rust reports the candidates (leaf, `size > 0`, `allocBytes = 0`, not a symlink) as a `Uint32Array` of ids; Node applies `cloudProviderFor(path)` to each and sets the flag, the provider and the tallies through the store. **P4-3a (amended 24 Sep 2026 — see §S.0):** the cloud rule becomes one data table (`CLOUD_RULES`, T11), and the regexes in `cloudFolders.ts` are built from it. Memory mode keeps the Node pass above. Spill and aggregate evaluate the same table in Rust during the walk, pinned to the old regex by a differential test (Q7: an engineering decision the owner may overrule, §S.11). | ~~The regex in `src/services/cloudFolders.ts` is the single source of truth~~ The table the regexes are built from is the single source of truth (P4-3a) ~~and the candidates are rare~~. **Corrected 24 Sep 2026 (the S1 review):** nothing measured "rare", and on some volumes every file is a candidate. Where the walk has no allocation size it records 0 allocated: a Windows volume listed through `FindFirstFileExW` (tm-walk `platform/windows.rs`, whose sources name FAT32 and exFAT), and a macOS or Linux entry whose allocation was withheld (`platform/darwin.rs`, `platform/linux.rs`). There every file that claims bytes and is not a link is a candidate. The ingest does the same pass today, so this is no regression. S2 and S5 measure both Node passes on such a tree (see S2). |
| P4-4 | **Three modes, chosen before the walk from the projection ~~and re-checked at the end~~:** `memory` when the projected entries ≤ 5,000,000 (the `storageSpillThreshold` setting), `spill` above it when ~~the app-data volume has ≥ 3 × the projected bytes free and is not the volume being measured (or the store's own files are excluded from the totals when it is)~~ `spill_plan` allows it (§S.5.4: free ≥ 3 × the bytes needed + 1 GiB, a writable app-data, a local file system; the files have no names, so a walk can never count them, §S.5.3), `aggregate` otherwise or when the owner selects it. The projection is the previous scan of the same root when one is on record ~~else the walk's own count at 5M entries (a walk that crosses the threshold in `memory` mode continues and converts at the end: the columns are written out, mapped, and the anonymous copy freed — **24 Sep 2026:** only while the walk's output fits in memory; see the plan correction for S3–S5 under the fixed interfaces)~~. The mode in force is `storageMode` in the stats. **P4-4a (amended 24 Sep 2026 — see §S.0):** a previous scan of the same root sets the mode (its `fileCount + dirCount` × 1.25). The volume's used-inode count is only a hint. Every memory walk carries a byte guard and converts **during** the walk, to spill or to aggregate, before the peak would pass the target mode's ceiling (§S.1.1, §S.1.4). Nothing converts at the end. The threshold `T_mem` defaults to 5M, budget until measured: T9 sets it per runtime. | The prompt's ceilings; DESIGN §6.1. |
| P4-5 | ~~**Spill = `write()` then `mmap(MAP_PRIVATE, PROT_READ \| PROT_WRITE)`.** Files under `<appData>/scan-spill/<scanId>/<column>.bin`; the mapping is private so the store's small mutations (watcher, container expansion, cloud flags) copy only the pages they touch; freed and deleted when the scan is forgotten, on quit, and by a startup sweep of anything older than the scan TTL.~~ **P4-5a (amended 24 Sep 2026 — see §S.0):** spill uses `write()` and `pread()` only. Nothing is ever mapped (no `Column::Mapped`), and JavaScript never holds spill memory. One file per column in `<appData>/scan-spill/` (mode 0700), each unlinked the moment it is created (Linux `O_TMPFILE`; macOS `mkstemp`, then `unlink` only if the path's `(dev, ino)` still matches the open descriptor; Windows `FILE_FLAG_DELETE_ON_CLOSE`), so the kernel frees it when its last descriptor closes: on forget, eviction, cancel, fault or quit, and after a crash. A boot sweep removes what a crash inside the macOS create→unlink window leaves, through one confined remover (§S.5.3). Q1 is pending the owner (§S.11): the `unlink` needs the owner's exception to the master prompt's §3.1, and if the owner declines, the no-`unlink` fallback of §S.5.3 is built instead. | ~~DESIGN §6.2 (why not `mmap` while writing)~~ DESIGN §6.2 as amended 24 Sep 2026: a mapping stays in maxRSS until it is unmapped (a mapped 1 GB sweep added 1,024 MB, measured, §S.4), and Electron cannot view one (RISKS R72); the prompt's "spill files never outlive the scan". |
| P4-6 | **Growth after finalize is bounded, not free:** `fromColumns` receives 1 % headroom rows (min 1,024) Rust allocates; an addition past the headroom reallocates the affected columns into JavaScript memory as `PackedScanStore` does today — correct ~~and recorded in the stats as `storageMode: 'memory'` from then on~~. **P4-6a (amended 24 Sep 2026 — see §S.0):** this holds in memory mode only. Spill and aggregate stores are read-only after the walk: Live mode and container expansion are off there (409 `STORAGE_MODE`, named in the notice). Q5 is an engineering proposal pending the owner (§S.11). | Container expansion and the watcher add a handful of nodes; a copy of a 100M-row column is the failure the headroom prevents. |
| P4-7 | ~~**Aggregate-only keeps:** every directory row (parent, name, mtime, flags, the recursive totals as `size`), per directory: entry count, allocated bytes, a 16-bucket size histogram and the top 32 extensions by bytes (packed side tables), and its **largest 64 children by size** as real leaf rows (so the treemap's top levels and the largest-files view have real files to show); the global largest-N (N = 10,000) files as rows under their true parents. Everything else is not a row. **Off and named in the UI notice:** duplicates, near-duplicates, compare, CSV export of leaf rows, `/nodes` lookups of files not kept, the persistent index hand-off, the Time Capsule and cleanup rules that need every file.~~ **P4-7a (amended 24 Sep 2026 — see §S.0):** what aggregate keeps is set by thresholds (the β rule, §S.6.1): every folder whose total is above β_d, every file whose size is above max(β_d, β_f), and the root, a set that is ancestor-closed by construction. β_d and β_f are the smallest entries of full heaps of `R_dir + 1` = 150,001 folder totals and `R_file + 1` = 200,001 file sizes (−∞ when a heap is not full). Also kept: the top 32 children of every folder at depth ≤ D_s (at most 64k rows), and the dashboard answers (the top 2,000 files and folders, the extension table, the size histogram), each exact or flagged `exact: false` with the reason (P4-16). Each kept folder carries `omitted {count, bytes}` for the rows it lost. **Off and named in the UI notice** (the availability table, §S.7): cleanup suggestions, custom rules, query, calendar, security, cloud-safe, compression, git, packages, games, media, app attribution, browser profiles, humanScale, the folders CSV, duplicates, near-duplicates, compare, empty folders, per-file CSV/XLSX export, folder offload, Photos expansion, Live mode and container expansion; `/nodes` and the facts answer `notKept` for a path not kept. The persistent index hand-off and the Time Capsule are off the list: neither reads the store. | DESIGN §6.1; the treemap only ever renders the top levels and the largest entries. **Amended 24 Sep 2026:** a row per directory is not bounded: at 15% folders, 100M entries hold 15M folder rows, about 960 MB at 64 B each (budget arithmetic), above the 400 MB ceiling. |
| P4-8 | **The 100M gate runs on a synthetic listing, not a disk.** `tm-walk`'s `Lister` trait gets a scripted implementation (`SyntheticLister`: fan-out, depth, size distribution, seed) reachable from the napi surface behind `scanStart(root, { synthetic: {...} })` for `root` under the app's own temp directory, and the bench harness's `enumerate --corpus=synthetic100m` measures it in a child process like any other run, labelled **`source: synthetic` in every report and refused as a throughput baseline** (it lists no file system). Peak RSS is the harness's measurement, not the app's. | 100M real entries do not fit on this Mac (the 1M corpus is 34 GB); the ceiling being gated is the store's, and a synthetic listing exercises exactly the store. |
| P4-9 | **Incremental rescan for the native engine is not built in this phase, with the measurement recorded:** with one listing call per directory, revalidating every directory's own `(dev, ino, mtime)` costs the same syscalls as listing it, so an mtime-keyed index cannot be faster than the walk (the prompt's premise was one `stat` per file). The legacy walker keeps its mtime cache. A change-journal rescan (FSEvents / USN) is the only faster path and is recorded in DESIGN §9.1 as deferred, with this reason, for Phase 8's decision. `cacheHitRate` in the stats stays `null` with the reason in `engineReason`. | Honest numbers; no feature that cannot be measured to help. |
| P4-10 | **Every memory number comes from `bench/`** (peak RSS of the scanning child process, the mode, the entry count, this machine's tier), recorded under `bench/baselines/` with `--record` only on a clean tree. | Phase 1's rules. |

**Added 24 Sep 2026 — see §S.0:** P4-11 (every large Rust allocation is an anonymous mapping, freed with `munmap` (`VirtualFree` on Windows)), P4-12 (the main thread sees only `PackedScanStore`; `NativeScanStore` only in worker threads), P4-13 (the job queue is FIFO up to `Q_MAX`, LIFO beyond), P4-14 (no legacy fallback in spill or aggregate or above `T_mem`), P4-15 (one availability table) and P4-16 (exact, or flagged, or refused). None is built.

---

## Fixed interfaces

**Superseded in part on 24 Sep 2026 by §S (S3–S5 as designed; not built):** `Column::Mapped` is gone (P4-5a) and `Column::Anon` is added (P4-11); `spill_plan` becomes `spill_plan(projected, mode, platform)` and also refuses a network file system or an app-data that cannot be written (§S.5.4); `sweep_spill_dir` and `storeSweep` give way to the boot sweep in `src/server.ts`, through one confined remover (§S.5.3); `storeRelease` unmaps and closes, and deletes nothing; `storeTake` and `storeColumns` are `AsyncTask`s (§S.1.6); `fromColumns` was built as `PackedScanStore.adoptColumns` (commit `38469ee`), which gains `totalsFinal` (§S.1.6).

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
    pub sparse_terms: Vec<(u32, f64)>,  // added in S1: sparseBytes's terms, ascending ids (the "two byte totals are recomputed" bullet under "Amended in S1")
    pub counters: Counters,             // as S1 built it: dirs, files, hardlinked_files/bytes, cloud_files/bytes and sparse_files/bytes (before Node's guesses; the two byte fields are the build's partial sums, which Node recomputes and never adds to: the "two byte totals are recomputed" bullet below), slack_bytes, denied_dirs (store ids; Node adds the paths and keeps the five smallest), vanished_dirs, unreadable_dirs. deniedEntries, unreadableEntries and dataless are in walk_stats
    pub aggregate: Option<AggregateTables>, // P4-7, Aggregate mode only
}
/// A column is a Vec (Memory/Aggregate) or a private mapping of a spill file (Spill). Plain Node accepts external typed arrays (no copy); Electron 31 refuses them and napi-rs copies each column into V8's memory (RISKS R72).
pub enum Column<T> { Owned(Vec<T>), Mapped(Mapping<T>) }
pub fn build(walk: WalkOutput, opts: &BuildOptions) -> Result<Store, StoreError>;
pub fn spill_plan(projected_entries: u64, app_data_dir: &Path, scanned_root: &Path) -> SpillPlan; // { bytes_needed, free_bytes, same_volume, allowed: bool, reason: String }
pub fn sweep_spill_dir(app_data_dir: &Path, older_than: Duration) -> SweepReport;
```

**Amended in S1 (24 Sep 2026), as built — what the fixed interface above could not carry:**
* `BuildOptions` also takes `root_name` (Node's `rootName(rootPath)`: the walk names the root by its last component, the store by Node's rule), `root_mtime_ms` (Node's own rounded stat, kept when the walk withheld the root's — the ingest keeps the constructor's value then) and `sort_children` (false on Windows: the listing's order stands). `container_kinds: Vec<(String, u8)>` became `container_rules: Vec<ContainerRule { text, whole_name, folders, kind }>`, in `detectContainerKind`'s order: a (suffix-or-name, kind) pair cannot say "the whole name" (the Docker images) or "folders only" (`.photoslibrary`). S2 turns `containerKind.ts` into that table and derives its suffix set from it, so both sides read one source.
* `Store` also carries `text_candidates` (ids whose names hold a non-ASCII byte and a dot: Node sets their extension and container kind with `statToInput`'s own rules — `toLowerCase` is the rule, each JS engine carries its own Unicode tables (Node 24.16: Unicode 17.0; Electron 31 an older one), so no Rust port could agree with all of them), `ext_overflow` (`extOverflow`: extensions past the 65,534-entry dictionary, kept per node) and `walk_stats`. `Counters` holds `denied_dirs` as ids (Node records each with its path and keeps the five smallest).
* P4-3 extended: for a guess (a file claiming bytes with none allocated, not a link, not dataless) the ingest's sparse tally depends on the path rule too — a placeholder is not sparse — so the build counts neither and Node decides both: a provider makes it a placeholder (flag, provider, `cloudFiles` += 1), none makes it sparse where blocks mean anything and it is not a later hard-link name (`sparseFiles` += 1). The walk's own placeholders (dataless) are flagged and counted by the build; Node looks up only their provider.
* **The two byte totals are recomputed, never added to (24 Sep 2026, from the S1 review's two 2^53 findings, equivalence and adversary).** `ingestColumns` keeps `cloudBytes` and `sparseBytes` each as one running float sum in store-id order, with the guesses mixed in, and a float sum depends on its order once a partial sum reaches 2^53. So `counters.cloud_bytes` and `counters.sparse_bytes` are the build's partial sums, not a base for Node's pass to add the guesses onto. Node computes:
  - `cloudBytes`: from 0, in id order, the store size (0 for a later hard-link name) of each `cloud_candidates` entry that ends up a placeholder, the walk's own included.
  - `sparseBytes`: from 0, in id order, `Store::sparse_terms` (`(id, bytes)`, ascending ids) merged with the size of each guess Node counts sparse. The build folds the terms into one, `(0, sparse_bytes)`, or none when it counted no file, when every row's positive shortfall is a whole number and they total below 2^53: no order can show there.
  On the review's walk (blocks meaningful; a.img 4,196 B claimed and 4,096 allocated, b.img 2^60 B and 0 allocated with no provider, c.img 4,196 and 4,096) the ingest gives `sparseBytes` 2^60. The build gives `sparse_terms` [(1, 100), (3, 100)] and `counters.sparse_bytes` 200. The merged sum gives 2^60; adding the guess onto the counter gives 2^60 + 256. The same was measured by the fix round's re-review (not the S1 review) in its differential harness (random walks through `ingestColumns` and through `build` plus each pass): adding onto the counters gave 859 mismatch reports over 847 of 13,000 walks, and these sums none in 21,000. tm-store's `tests/build.rs` pins both sums (`sparse_bytes_can_be_summed_in_the_ingest_s_order_once_node_decides_its_guesses`, `cloud_bytes_can_be_summed_in_the_ingest_s_order_from_the_candidates_alone`).
* Time rounding: see the corrected S1 note below — `Math.round` is not `(x + 0.5).floor()`.

**Plan correction for S3–S5 (24 Sep 2026, from the S1 review):**
* **`build(WalkOutput)` serves memory mode only.** A `WalkOutput`'s fixed columns alone take 42 B per node (tm-walk `output.rs`: `parent` and `name_off` u32, `kind` and `flags` u8, `size`, `alloc_bytes`, `mtime_ms` and `atime_ms` f64). That is 4.2 GB at 100M before a single name byte. With names, the review measured 56.8–63.7 B/node on real trees, about 6 GB at 100M. So both ceilings (spill 1.5 GB, aggregate 400 MB) are passed before `build` starts, whatever it does. Spill and aggregate must therefore be fed **during the walk**: spill columns written with `write()` as listings complete (as DESIGN §6.1 already says), aggregate totals and the bounded top-K kept as running state with no per-node array. P4-4's "a walk that crosses the threshold in `memory` mode continues and converts at the end" holds only while the walk's output fits in memory. It cannot be how a 100M scan reaches spill: the mode is chosen before the walk, from the projection.
* **Store ids are internal**, so the breadth-first renumbering may not be needed. `FileNode` carries no id (`src/models/types.ts`), and no route or MCP tool takes one: a grep of `src/api` and `src/mcp` finds `POST /api/scan/:scanId/nodes` taking paths, and every other `id` there belongs to an offload entry, a capsule, a peer, a policy or a saved query. Numbering each listing as one block while the walk runs could replace the renumbering, provided each block keeps `breadth_first`'s child order and every child's id stays above its parent's. What depends on id order today (a grep of `src/` for sorts and passes over ids, 24 Sep 2026):
  - `notHashedReport` (`src/services/duplicateFinder.ts:257`) sorts placeholder ids by size, then by id, and keeps the first 20 (`NOT_HASHED_LISTED`) before re-sorting those by path. Which of several equal-size placeholders at the cut get listed depends on id order. That order is fixed by the tree under breadth-first ids, but under a parallel walk's listing order it could change from run to run. Break the tie by path before any renumbering.
  - `collectEmptyFolders` (`src/services/diskScanner.ts:1341`) sorts ids ascending and relies on a child's id being above its parent's. A walk numbering keeps that, because tm-walk promises `parent[i] < i`.
  - The other size-ordered lists break ties in visit order through `eachFile` / `childIds`, a pre-order over child ranges (`PackedScanStore.eachFile` in `src/services/scanStore.ts`): `collectLargestFiles` (`diskScanner.ts:1224`), `TopN` (`scanQueries.ts:55`), the treemap (`src/utils/treemap.ts:224`) and the snapshot trees (`snapshots.ts:72`). That order depends on each folder's child order, not on how folders are numbered against each other. The query sorts break ties by path (`src/services/query/execute.ts:190`).

### `tm-node` additions (declared in `native/index.d.ts`)

```ts
scanTake(handle: number): WalkResult;                // unchanged (Phase 3)
storeBuild(handle: number, opts: { rootName: string; rootMtimeMs: number; blocksAreMeaningful: boolean; sortChildren: boolean; containerRules: { text: string; wholeName: boolean; folders: boolean; kind: number }[]; headroomRows: number; mode: 'memory' }): StoreHandle;
                                                     // amended 24 Sep 2026 to S1's BuildOptions; S1 builds memory mode only (ModeNotBuilt otherwise), and spill and aggregate are fed during the walk (the S3–S5 correction above)
storeColumns(store: StoreHandle): StoreColumns;      // the typed-array views (external in plain Node, one copy per column in Electron: RISKS R72; the store stays alive while any view does)
storeRelease(store: StoreHandle): void;              // unmaps and deletes spill files
storeSpillPlan(projectedEntries: number, appDataDir: string, root: string): SpillPlan;
storeSweep(appDataDir: string, olderThanMs: number): { removed: number; bytes: number; kept: number };
interface StoreColumns { mode; n; capacity; parent: Int32Array; size: Float64Array; mtime: Float64Array; atime: Float64Array | null; flags: Uint16Array; ext: Uint16Array; container: Uint8Array; cloudProv: Uint8Array; nameOff: Uint32Array; names: Uint8Array; childStart: Uint32Array; childCnt: Uint32Array; extDict: string[]; extOverflow: [number, string][]; cloudCandidates: Uint32Array; textCandidates: Uint32Array; sparseTermIds: Uint32Array; sparseTermBytes: Float64Array; counters: Counters; walkStats: WalkStats }
// amended 24 Sep 2026 to S1's Store: Counters = { dirs; files; hardlinkedFiles; hardlinkedBytes; cloudFiles; cloudBytes; sparseFiles; sparseBytes; slackBytes; deniedDirs: Uint32Array; vanishedDirs; unreadableDirs }. cloudFiles and sparseFiles exclude the guesses: Node adds 1 for each guess it decides. cloudBytes and sparseBytes are the build's partial sums: Node recomputes both from 0 in id order, over cloudCandidates and over sparseTermIds/sparseTermBytes (Store::sparse_terms, split into two arrays), and never adds to them (the "two byte totals are recomputed" bullet under "Amended in S1"); WalkStats is scanTake's (native/index.d.ts). S1's Store has no aggregate tables (aggregate is fed during the walk: the S3–S5 correction above)
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
  - **Times are `Math.round`**, which rounds a half toward +∞: `Math.round(-1.5)` is −1, `Math.round(-0.5)` is −0, `Math.round(2.5)` is 3 (measured, Node 24). Rust's `f64::round` rounds a half away from zero (−1.5 → −2). ~~so the build uses `(x + 0.5).floor()` with −0 kept~~ **Corrected 24 Sep 2026, measured on Node 24.16:** `(x + 0.5).floor()` is not `Math.round` either — it gives 1 for `0.49999999999999994` (JS: 0), `4503599627370498` for `4503599627370497` (JS: unchanged; an integer is its own round), and +0 for everything in [−0.5, 0) (JS: −0). The build uses the spec's rule: an integer, NaN or ±∞ as it is; otherwise the floor, plus one when the fraction is at least a half; −0 when that is zero and x was negative. Test those values and mtimes before 1970 that end in .5 ms. An atime that is not above zero is omitted.
  - **Extension:** the last `.` at an index above 0 (a dotfile has none; `a.` and `..` leave nothing), then JavaScript `toLowerCase()` — full Unicode, Final_Sigma included: `FILE.ΑΣ` → `ας`, `a.ΣΑΣ` → `σας`, `x.İ` → `i` + U+0307, `y.ẞ` → `ß`, `z.ǅ` → `ǆ` (measured). ~~Rust's `str::to_lowercase` implements the same rules; a differential test over those names and a random sample must hold the two equal.~~ **Corrected 24 Sep 2026:** no Rust port is used. Each JavaScript engine carries its own Unicode tables (Node 24.16: Unicode 17.0; Electron 31 an older one), so no Rust port could agree with all of them. The build decides only names that are all ASCII or have no dot (`derive::decided_here`, pinned by the 12,535-name oracle `crates/tm-store/tests/fixtures/derive-oracle.tsv`) and lists the rest in `text_candidates` for Node's own `toLowerCase` (the S1 amendment above). Files only. **Hidden** = the name starts with `.`.
  - **Container kind:** the suffix set and the order of `detectContainerKind` (`.photoslibrary` for folders; the Docker data files, `.tar.gz`/`.tgz`, `.zip`/`.jar`, `.tar`, `.iso`, `.dmg` for files), lower-cased — passed in as the table P4-2 names.
  - **Order and ids:** the ingest adds each folder's children breadth-first, sorted by raw name bytes (`strcmp`) except on Windows; `finalize` renumbers breadth-first by insertion order, so the final id of every node is its insertion order — the Rust build can emit final ids directly.
  - **Per-node facts:** a symlink is a leaf with no sparse or cloud check; a dataless file is a placeholder wherever it is (its provider from the Node-side path rule, P4-3), and otherwise the walker's guess (size above 0, nothing allocated, a path under a known cloud folder) stays a Node post-pass over the candidates; the first name of a hard-link family (by the walk's family number) keeps the bytes, a later one is size 0 + `HardlinkDup` + the tallies; the allocation delta counts sparse (negative) or slack (positive) bytes only where blocks mean anything and never for a duplicate or a placeholder; a child folder named `.git` sets `GitRepo` on its parent; refusals become the denied (with the five smallest example paths, Node side), vanished and unreadable counters.
- [ ] Commit `native(store): the finalized store built in Rust, in the packed store's own layout`.

### S2: the native engine reads the Rust store without copying (Rust + TypeScript)
**First, before any S2 code (found 23 Sep 2026 in napi-rs 3.4.0's source; RISKS R72):** zero copy is plain Node's alone. Measured 23 September 2026 with a throwaway napi probe calling `napi_create_external_arraybuffer`: Node 24.16 answers `napi_ok` (0); the installed TreeMap app's Electron 31.7.7, run as Node (`ELECTRON_RUN_AS_NODE=1`; its RunAsNode fuse is on), answers `napi_no_external_buffers_allowed` (22). The same day, handing the walk's 9.7 MB of columns for enum200k to plain Node grew `process.memoryUsage().arrayBuffers` by 0 MB against a 50 MB control that it counted — zero copy, measured — while in Electron that counter saw neither the hand-over nor the control (Electron allocates ArrayBuffers outside Node's allocator), so Electron's copy must be measured another way (RSS, time). Its cost, measured the same day on enum1m (1,000,002 entries, 48.9 MB of columns, two runs each): `scanTake` took 0.1 ms in Node and 6.3–7.2 ms in Electron (the copy, about 7 GB/s), and the process's peak RSS (`resourceUsage().maxRSS`, the OS counter) did not rise in either — the walk's own peak was higher than the copy's transient. So memory mode can keep the plan in Electron at about 7 ms per million entries; spill mode is where the cage decides the design. In Electron 31 — the desktop app — V8's memory cage refuses external ArrayBuffers and napi-rs copies each column instead. Measure, inside Electron (`ELECTRON_RUN_AS_NODE=1` against the bundled binary), the peak memory and the time of handing a 5M-row store over; if the copy is acceptable, the plan stands with "no copy" read as "no copy in web mode, one per column in Electron"; if not, the store is read through native calls in Electron.
**Files:** Modify `crates/tm-node/src/lib.rs`, `native/index.d.ts`, `native/README.md`, `src/services/scanStore.ts` (`fromColumns`, `release`), `src/services/scan/nativeEngine.ts`, `src/services/diskScanner.ts` (release on forget), `tests/nativeEngine.test.ts`, `tests/scanStore*.test.ts`.
- [ ] Tests first: `fromColumns` over hand-built columns behaves as a built store for every `ScanStore` method (the existing differential fuzz against `ObjectScanStore` is reused with a `fromColumns` producer); the same fixture through `ingestColumns` and through `storeBuild` + `fromColumns` gives byte-identical pruned JSON and equal counters; growth past the headroom reallocates and keeps every value; `storeRelease` after forget (a second `storeColumns` throws); the cloud post-pass sets the provider on a candidate under a cloud-looking path and nothing else; byte totals past 2^53 match the ingest bit for bit (added 24 Sep 2026, the S1 review): the byte-totals bullet's 2^60 walk (above) gives `sparseBytes === 2 ** 60`, and a guessed 2^60 placeholder under a provider's path between two dataless 100-byte files gives `cloudBytes === 2 ** 60`, through `storeBuild` + `fromColumns` + the cloud pass as through `ingestColumns`. A pass that adds onto the counters gives 2^60 + 256 for both; below 2^53 it agrees with the ingest only where every partial sum stays exact (whole-number terms), so fractional sizes are no proof either.
- [ ] Implement (napi external typed arrays over the `Column`s, the finalizer keeping the store alive; the views' lengths are `n`, the buffers `capacity`).
- [ ] Measurement: `npm run bench -- enumerate --engine=native` on ci20k / enum200k / enum1m with peak RSS per node recorded beside the throughput; the 1M figure against `PackedScanStore`'s 49.7 B/node (Phase 0) — expected to be about the same in memory, because the layout is the same, and lower in the transient ingest peak.
- [ ] **Measurement (added 24 Sep 2026: the S1 review's two scale findings, left UNVERIFIED because too few of the review's skeptic judges returned a vote; recorded here as measurements, not as defects).** (1) `build` owns the whole `WalkOutput` until it returns and allocates every store column new. On a synthetic 5M-node walk the review measured `build`'s heap peak at 706 MB and the bare Rust process's maxRSS at 733 MB, against the 700 MB gate for the whole app. (2) Whether macOS keeps freed large blocks resident: in the review's probe, six dropped 40 MB `Vec`s left RSS at 231 MB, and anonymous mappings unmapped the same way returned it. So S2 measures maxRSS through walk → `build` → hand-over at 1M and 5M, in plain Node and inside Electron (whose copy uses V8's allocator). It then decides, before accepting the copy path, whether columns become anonymous mappings (a `Column` kind over `MAP_ANON`) and whether the build releases walk columns as it consumes them.
- [ ] **Measurement (added 24 Sep 2026):** time and peak memory of both Node passes, the cloud rule over `cloudCandidates` and `toLowerCase` over `textCandidates`, on a tree where every file is a candidate: 0 allocated everywhere (an exFAT volume, or a synthetic walk), with names holding a non-ASCII byte and a dot. S5's synthetic gate must include the same case, because a generator with ASCII names and allocated blocks would exercise neither pass.
- [ ] Commit `feat(engine): the native scan is read through views of the Rust store — no ingest copy`.

### S3: spill mode (Rust + TypeScript)
**Electron (RISKS R72):** a memory-mapped spill cannot be viewed from JavaScript inside Electron's memory cage, so in the desktop app spill mode needs a `ScanStore` whose reads go through native calls (batched, never per node in a hot loop), or spill is web-mode only with aggregate-only as Electron's large-scan path. Decide with S2's measurements, and write the decision here before S3's first test. **Designed 24 Sep 2026 (P4-12, §S.4; not built):** spill runs in both runtimes and nothing is mapped. The main thread holds only `PackedScanStore` over in-memory columns; every disk read is an `AsyncTask` that returns small JavaScript-owned arrays; a `NativeScanStore` exists only in worker threads (the FullPassRunner, §S.5.7). T9's measurements set each runtime's `T_mem`.
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

### S3–S5 as designed on 24 Sep 2026 (supersedes the S3–S5 tasks above where they differ)

> **Status: design; T1–T23 not built.** T0 (documents only) pasted it here on 24 Sep 2026, amended P4-1…P4-7 above, DESIGN §6, §6.1, §6.2, §7 and §16, and added its risks to RISKS as R73–R87. The design was written read-only from four code maps (walk output, consumers, store build, Electron memory) and three competing designs, each scored by three judges. It starts from the highest-scoring design ("memory-first": 7.5, 7.5 and 5.5) and removes every fatal flaw any judge found in any of the three. §S.12 lists each flaw and where it went. It also takes the best ideas from the other two.
>
> Every number is budget arithmetic unless it is marked **measured**. Measured figures come from the readers' probes on this Mac (M3, 8 cores, 16 KB pages, macOS 27.0, Node 24.16, Electron 31.7.7 run as Node) and from the committed baselines in `bench/baselines/`. Those probes ran at load average 6.5–7.4, so their times are upper bounds; their memory figures do not depend on load.
>
> **Preconditions, in the owner's order:**
> 1. Phase 3's CI is green on all four legs.
> 2. The Node test load sweep is committed.
> 3. S1's 29 fixes are committed.
>
> ~~tm-store is being edited right now.~~ No task below touches it before step 3.
>
> **24 Sep 2026 (T0):** the three steps are done. Step 1: the Progress table's S1 row records Phase 3's CI green (run 36069755180). Step 2: commit `298d752`. Step 3: commit `2415d6c`.

#### S.0 Decisions this section adds or amends

| # | Decision | What it replaces |
| --- | --- | --- |
| P4-1a | **Ids come in one block per listing.** A worker lists and orders a whole folder, then reserves one contiguous id range under a commit lock, then writes the rows. Invariants I1–I4 (§S.2) hold by construction. Ids are no longer breadth-first. §S.2 proves that no output depends on the numbering, and a test checks it on randomly renumbered stores. | P4-1's "ids breadth-first exactly as `finalize()` assigns them". The column layout itself does not change. |
| P4-2a | **Hard-link winner:** the member of a family that comes first in breadth-first order, compared by position path (depth, then the child positions from the root). This is the same member as today, stated without ids. | P4-2's "hard-link dedup in id order". |
| P4-3a | **The cloud rule becomes one data table.** Memory mode keeps Node's pass over the candidates. Spill and aggregate evaluate the same table in Rust during the walk, pinned to the old regex by a differential test (owner question Q7). | P4-3 for the large modes only. |
| P4-4a | **How the mode is chosen:** a previous scan of the same root sets the mode. The volume's used-inode count is only a hint. Every memory walk carries a byte guard and converts **during** the walk, to spill or to aggregate, before the peak would pass the target mode's ceiling. Nothing converts at the end. | P4-4's conversion at the end. |
| P4-5a | **Spill uses `write()` and `pread()` only. Nothing is ever mapped** (no `Column::Mapped`). Files are unlinked the moment they are created (owner question Q1). JavaScript never holds spill memory. | P4-5's `mmap(MAP_PRIVATE)`. |
| P4-6a | **Spill and aggregate stores are read-only after the walk.** Live mode and container expansion are off there. Memory mode keeps P4-6. | P4-6 for the large modes. |
| P4-7a | **What aggregate keeps is set by thresholds** (the β rule, §S.6). The dashboard answers are exact, or flagged when they cannot be proven exact. The list of features switched off is corrected. | P4-7. |
| P4-11 | **Every large Rust allocation is an anonymous mapping** (`Column::Anon`, `MAP_ANON`, or `VirtualAlloc` on Windows) and is freed with `munmap` (**corrected 24 Sep 2026, T0:** `VirtualFree` on Windows, which has no `munmap`). So a scan's peak RSS is the largest single stage, not the sum of the stages, in plain Node and in Electron alike. | A new decision. |
| P4-12 | **The main thread sees only one store class**, `PackedScanStore`, over in-memory columns. Every disk read is an `AsyncTask`. A `NativeScanStore` exists only inside worker threads (the FullPassRunner, §S.5.7). | The open Electron choice in S3's **Electron (RISKS R72)** paragraph above. |
| P4-13 | **The job queue is FIFO up to `Q_MAX`, LIFO beyond it.** `Q_MAX` is 65,536 in memory mode and 4,096 in spill and aggregate. | A new decision. |
| P4-14 | **No fallback to the legacy walker** in spill or aggregate, or above `T_mem`. A native failure there fails the scan and gives the reason. | A new decision. |
| P4-15 | **One availability table** (feature × mode) drives the 409 answers, the notice, the MCP tools and a coverage test. | A new decision. |
| P4-16 | **Exact, or flagged, or refused.** An aggregate answer the seal cannot prove exact carries `exact: false` and the reason. Hard-linked bytes are never approximated: when the key log cannot fit, the scan is refused and told how many bytes it needs. | A new decision. |

#### S.1 Data flow

```
choose (Node) ─► walk (tm-walk: list → order → derive ─► COMMIT LOCK ─► sinks) ─► seal (Rust, off-thread) ─► hand-over ─► serve ─► release
                                                          │
                     MemorySink (Column::Anon) ◄──────────┤  memory
                     SpillSink (unlinked files, write()) ◄┤  spill        (+ AggregateState always)
                     AggregateState (bounded, no rows) ◄──┤  aggregate    (and dual-fed in a guarded memory walk)
                     CollectSink (today's Part/merge) ◄───┘  oracle, and the MFT path
```

**S.1.1 Choose (Node, before the walk; new `src/services/storageMode.ts`).** The chooser reads:
- the runtime (`node` or `electron`);
- the setting (`auto`, `memory`, `spill` or `aggregate`, plus `spillThreshold`);
- a projection P: the last snapshot of the same root, `fileCount + dirCount` (`snapshots.ts:168-169`), × 1.25;
- the used-inode hint U: statfs `f_files − f_ffree` for the root's volume, where the platform reports it;
- `storeSpillPlan` (§S.5.4);
- the measured per-runtime constants `T_mem` and `M_agg` from T9.

In `auto` mode:

| Case | Mode | Guard |
| --- | --- | --- |
| P known and P ≤ `T_mem` | memory | overflow target is spill if the start plan allows it, else aggregate |
| P known and P > `T_mem` | spill if `plan(P)` allows it, else aggregate | spill's progressive free-space check (§S.5.4) |
| No P, and U ≤ `T_mem` | memory | as the first row |
| No P, and U > `T_mem` or unknown | memory | as the first row; U is never trusted as a bound |

Why U is only a hint:
- It counts inodes, not names, so hard links break the bound.
- It is the whole volume's count, so a subfolder is overstated. A small subfolder of a big volume therefore never lands in a large mode by projection alone; the guard decides.

Spill is allowed as the overflow target when `free ≥ 3 × (1.25 × T_mem × 68 B) + 1 GiB`. At `T_mem = 5M` that is about 2.3 GB. Past the start, the progressive check (§S.5.4) takes over.

**S.1.2 Walk.** tm-walk's listers do not change.
1. A worker lists one folder into its `ListBuffer` exactly as today (walk.rs:736-760).
2. Order: on POSIX the listing arrives sorted by raw bytes (platform/mod.rs:149-166). The walk stores names lossily (walk.rs:318-322). If the lossy conversion changed any name in this listing, the listing is stable-sorted again by its lossy bytes. That is exactly the order `finalize.rs:109-115` and `nativeEngine.ts:318` produce. On Windows the listing's own order stands.
3. Derive, in the worker, without a lock: S1's per-row rules (`derive.rs`, moved out of `build.rs:221-341` into a per-listing kernel once S1 is committed) and the facts that belong to the listing itself:
   - `GitRepo` on the listed folder when a child is named `.git`;
   - Windows own times (walk.rs:758-760);
   - refusals of separator-named children (walk.rs:792-799);
   - one link-key record per keyed file (walk.rs:811-825), carrying the file's **position path**. Every `DirJob` carries its own position path and its own row; a varint array costs about 2 B per level.
4. Commit, under one lock:
   - `first = next_id; next_id += k` (checked; an overflow is today's id-ceiling fault);
   - `name_base = next_name; next_name += bytes`;
   - in spill and aggregate only, append the block's rows to the sink's buffers.

   Child `DirJob`s get `first + i` and are pushed afterwards (walk.rs:828). In memory mode the lock only reserves; the worker then writes its rows into the anonymous columns at the reserved offsets, **outside the lock** and in parallel with other workers. The ranges are disjoint, and each is argued in a `// SAFETY:` note.
5. Listings of more than 16,384 entries go through a semaphore, one at a time. Such a listing reserves its whole id block at once, then derives and appends it in 4 MiB chunks. The worker's `ListBuffer` shrinks after it (platform/mod.rs:123-132 keeps its capacity today).
6. The queue is FIFO until it holds `Q_MAX` jobs, then LIFO (queue.rs:49-61, 74). This caps the backlog of queued folders, which was **measured** at about 200 B each and 218 MB for 1.05M queued. In the sink modes it also caps the set of open folders (§S.6.1).
7. The heartbeat is bumped while a worker waits on the lock, on a writer or on the big-listing semaphore. The seal bumps it too. Node's 30 s stall rule (nativeEngine.ts:657-671) never mistakes a slow disk for a stall.
8. Cancel, a fault or a refused root (walk.rs:527-547) calls `abort()` on every sink: anonymous columns are unmapped, and spill descriptors close, so their unlinked files vanish. A listing interrupted by a cancel is never committed.

**S.1.3 Sinks.** Each one consumes the same commit events.
- **MemorySink.** Columns in the P4-1 layout (`parent` i32, `size`, `mtime` and `atime` f64, `flags` and `ext` u16, `container` and `cloudProv` u8, `nameOff` u32 of length n+1, `names` u8, `childStart` and `childCnt` u32). They sit in `Column::Anon` mappings reserved for `capRows` (headroom included, zero-filled because the pages were never touched). The name pool is reserved as virtual memory, and only the pages written are resident.
  - At commit the listed folder's own row gets `childStart = first` and `childCnt = k`. Nobody else writes that row: its writer finished before the folder's job was queued.
  - `GitRepo` and the Windows times are written into the folder's own row the same way.
- **SpillSink.** One unlinked file per column (§S.5).
  - Rows are appended in id order through 1 MiB buffers, with at most 2 in flight per column, handed to one writer thread.
  - Facts that arrive after their row was written go to sorted side logs on disk:
    - the block table `(folder, first, k)`;
    - the patch log: folder totals and counts at close, `GitRepo`, Windows times, hard-link losers, Windows refreshes, and extension/container ids resolved by Node.
- **AggregateState.** Bounded, and it holds no rows (§S.6):
  - fold-on-close folder totals;
  - the β heaps and the shallow keep;
  - the exact dashboard answers;
  - the extension table and the histograms;
  - the link-key log.

  It runs in **both** spill and aggregate. So spill can fall back to aggregate at any moment without replaying anything, and the dashboard answers come from the same code in both modes.
- **CollectSink.** Today's `Part`+merge code (walk.rs:290-331, 914-1018), kept for the MFT path (tm-node lib.rs:707-730) and as the oracle.

**S.1.4 Conversions during the walk.** All are one-way and recorded in `/api/scan/:id/storage`.
- **memory → spill**, when the rows reach `capRows = 1.25 × T_mem` and the overflow target is spill.
  - The committed rows are replayed in commit order, from the anonymous columns, into a SpillSink and a fresh AggregateState. Commit order is the order of `childStart`: an 8 B-per-folder sort, about 8 MB at 6.25M rows.
  - Then the anonymous columns are unmapped.
- **memory → aggregate**, when the overflow target is aggregate (spill refused at the start). Such a walk is **dual-fed** from its first row: MemorySink plus AggregateState, with the sink-mode `Q_MAX`.
  - The guard is in bytes, not rows: `rows × 64 B + the big-listing reserve in use > M_agg`. `M_agg` is 400 MB − 20 MB margin − B0 − W − AggregateState − frontier − link log, from T9's measurements; the budget below gives about 153 MB, about 2.4M rows. A big listing that would pass the guard triggers the conversion **before** it is committed.
  - Conversion then only unmaps the anonymous columns. The peak stays under the aggregate ceiling even when the projection was wrong (the flaw a judge found in the base design; §S.12).
  - If the walk ends under the guard, the memory store is adopted, the AggregateState is dropped, and every feature is on.
- **spill → aggregate**, when the progressive free-space check trips, or on `ENOSPC` or `EIO`. The SpillSink closes, so its files vanish, and the AggregateState that ran all along continues.
- **Load-back.** A spill scan that ends with n ≤ `T_mem` is read back with `pread` into `Column::Anon`, adopted as memory mode with every feature on, and its files closed. This only happens after a previous scan overstated the size.

**S.1.5 Seal** (Rust, on the walk's driver thread, before `done`; it bumps the heartbeat and checks for cancel between windows).
- **P1, hard links.** Link-key records are sorted; past a 32 MiB resident run they go to disk as sorted runs, merged k-way. Families are grouped with `hardlink_families` (links.rs:55-83), with the member key widened to u64. The winner is the least `(depth, position path)` member.
  - Memory mode applies `HardlinkDup`, size 0 and the tallies in place.
  - Spill writes patch-log entries, and subtracts each loser's bytes from its ancestors' totals through the block table.
  - Aggregate corrects its heaps and tallies (§S.6.3).
  - On Windows the id families are refreshed as `refresh_families` does (walk.rs:583-634): each family gets one re-stat, and the deltas become patches.
- **Memory mode.** Counters, as S1 builds them, plus S1's `sparse_terms` fallback. Where the terms need breadth-first order, the finished store is walked breadth-first with a transient 4 B-per-node queue. Folder totals are left to Node's unchanged `sumSizes` (scanStore.ts:1128-1147).
- **Spill.** Each side log is sorted. Then one sequential `pread`/`pwrite` pass per affected column, in 4 MiB windows, merges in the patches. `childStart` and `childCnt` are written in full from the sorted block table. No page is ever written through a mapping.
- **Spill and aggregate.** The **summary** is built (§S.5.5 and §S.6.2), and the answers are checked for exactness (§S.6.4).

**S.1.6 Hand-over.**
- `storeTake` is an `AsyncTask`, and so is `storeColumns`.
- Plain Node gets external typed arrays over `Column::Anon`; their finalizer unmaps.
- Electron (RISKS R72) gets V8 ArrayBuffers allocated on the main thread and filled off-thread through the pointer from `napi_get_typedarray_info`. That write was **measured** to work in Electron. Each Rust column is unmapped right after its copy, so the transient is the store plus one column. This keeps §13's 1 ms rule (the plan's S2 synchronous copy costs about 6–7 ms per million rows, **measured**).
- `PackedScanStore.adoptColumns` (scanStore.ts:1057-1126) gains `totalsFinal`. In the large modes `sumSizes` then throws, because it would re-sum folders from only the kept children.
- `release()` sets a flag that every accessor checks. Reading a detached typed array does not throw; it returns `undefined`, so a stale store must fail loudly through this explicit check.

**S.1.7 Serve.**
- **Memory mode:** exactly today.
- **Spill and aggregate:** the main thread holds a small in-memory summary `PackedScanStore`, the answers and the side tables.
  - Anything beyond the summary goes through an `AsyncTask` reader that returns a small `StoreColumns`. It is adopted into a temporary `PackedScanStore`, over which the **unchanged** `pruneStore` or `buildTreemapFromStore` runs (§S.5.5).
  - Full-tree features in spill run in a worker thread (§S.5.7).
  - Features refused in a mode answer 409 `STORAGE_MODE` from the availability table (§S.7).

**S.1.8 Release.** Release happens on:
- `onScanForgotten` (diskScanner.ts:207) and on eviction (diskScanner.ts:218-236);
- cancel, fault or abort;
- after a load-back;
- quit: `before-quit` (electron/main.js:740), and in web mode SIGINT, SIGTERM and `beforeExit`.

Release unmaps and closes; it deletes nothing, because the files were unlinked when they were created. At server boot a sweep handles the one leftover case (§S.5.3).

#### S.2 Id numbering and the equivalence argument

**Invariants.** They hold by construction, and a debug-build O(n) checker runs in every test build, because `adoptColumns` trusts its producer (scanStore.ts:1053-1055):
- **I1.** The root is id 0 (parent −1).
- **I2.** Each folder's children occupy one consecutive range `[childStart, childStart + childCnt)`, in store child order.
- **I3.** `parent[id] < id`. A folder's own id was reserved in its parent's block, before its job was queued; its children's block is reserved after it is listed.
- **I4.** Names are laid out in id order, so `nameOff` is monotone. The pool offset is reserved under the same lock as the ids.

**The isomorphism.** Let T be the ordered tree, B(T) the breadth-first store (`build(take())`, finalize.rs:32-133) and S(T, σ) the block-numbered store under schedule σ. φ maps the k-th child of d in S to the k-th child of φ(d) in B, with φ(0) = 0. By I1–I3, φ is a bijection that preserves parents and child ranges.

- **Lemma 1 (fields).** Every per-row value comes from the same kernel on the same input, so `S.f(x) = B.f(φ(x))`. Child order is equal because of the lossy re-sort in §S.1.2 step 2. Where the lossy conversion changed nothing, raw order equals lossy order byte for byte.
- **Lemma 2 (totals).** `sumSizes` zeroes folders, then adds `size[id]` into `size[parent]` for id = n−1 down to 1. Under I2 and I3 each folder receives its children in reverse child order, each already final. That sequence is the same under every numbering that satisfies I2 and I3, so every total is **bit-identical**, float rounding included. Memory mode keeps `sumSizes`.
- **Lemma 3 (hard-link winner).** In a FIFO breadth-first walk of an ordered tree, u precedes v iff depth(u) < depth(v), or the depths are equal and u's position path is lexicographically smaller (induction on depth). So P1's least `(depth, position path)` is today's breadth-first-first member (build.rs:211, 274-286; nativeEngine.ts:351-360). The equivalence digest cannot see this, because it normalises winners to the smallest path (canonicalTree.ts:89-96). A dedicated fixture pins it.
- **Lemma 4 (reads).** FileNode carries no id, and every route and MCP tool resolves by path (scanRoutes.ts:366-369). These are all the places in `src/` that compare ids (the plan's grep under **Plan correction for S3–S5** above, re-checked by three readers):
  - `sumSizes` (Lemma 2);
  - `collectEmptyFolders` (diskScanner.ts:1330-1362), which needs only I3;
  - `subtreeCountProvider` (:74-76), whose table is internal;
  - the prune heap (scanStore.ts:284-324), which compares sizes, with ties falling to push order, which is child order;
  - the extension dictionary, whose ids differ but whose text is the same (scanStore.ts:1218-1227);
  - `notHashedReport`'s `a - b` (duplicateFinder.ts:257): the one real dependence, removed by T1 before anything else moves.
- **Lemma 5 (counters).** Counts and integer byte sums are order-free. S1's `sparse_terms` fallback keeps breadth-first order, as §S.1.5 says.

**Orders without breadth-first ids.** Every order-dependent answer in every mode is computed from **position paths**, never from ids:
- breadth-first order is (depth, then the path compared lexicographically);
- pre-order is the path compared lexicographically, with a prefix first;
- post-order puts a descendant before its ancestor and is otherwise lexicographic.

This is what lets the large modes reproduce the golden-locked tie rules exactly:
- `collectLargestFiles`: (size desc, pre-order) (diskScanner.ts:1224-1248);
- `collectFileTypes`: bytes desc, then first-seen pre-order (diskScanner.ts:1463-1476);
- `collectLargestFolders`: post-order fill (diskScanner.ts:1250-1285);
- `eachFile`'s pre-order over child ranges (scanStore.ts:1373-1388).

**The tests that make the proof empirical.** All of them run in CI, and each must be seen red once.
1. **The digest lock (T4).** A committed column digest of `build(take())` for the scripted and synthetic fixtures at 1 and 8 workers, recorded before tm-walk is touched.
2. **The CollectSink under φ.** `build(CollectSink output)` equals `build(take())` column for column, and the block store after φ equals it too.
3. **Determinism.** The same tree at 1, 2, 8 and 64 workers, under a test pacer that injects random yields, gives identical JSON for every golden key.
4. **The numbering-independence battery.** `renumberStore(store, seed)` builds random valid block renumberings of a finished store. The whole golden capture, plus a battery that exercises every consumer (collectors, prune, subtree, treemap, snapshot tree, facts, query, duplicates' not-hashed list, empty folders, compare, export, MCP tools), must be byte-identical. Planted mutants must turn it red: restoring `a - b`, and a collector iterating `0..count`.
5. **Native golden legs.** The golden lock is pinned to the walker today (goldenHarness.ts sets `engine: 'walker'`). New legs capture with the native engine in memory mode and in forced spill, and must equal `tests/fixtures/golden/responses.json` byte for byte. If the memory leg already fails on today's code (reader 3 suspects invalid-UTF-8 child order), that is recorded and fixed before T6.
6. **The cross-folder hard-link fixture.** Walk-order-first, breadth-first-first and smallest-path members all differ. The mutant "pick the walk-order-first member" must turn it red.
7. **Invalid UTF-8 child order.** `'a'+0xF8` against `'a😀'`, through the scripted lister, so it runs on every platform.
8. **The I1–I4 checker** on every produced store.

**Intentional differences** (to add to DESIGN §16):
- `notHashedReport` breaks ties by path, in every mode (T1).
- Spill and aggregate folder totals and tallies are exact integer sums (u128, rounded once). They equal memory mode's float fold whenever every partial sum is below 2^53 (9 PB).
- Aggregate tree views leave rows out and say so (`omitted`).
- The large modes evaluate the cloud table in Rust (if Q7 is accepted).

The spill folder is **not** added to `never_descend`, so there is no walker difference there (§S.5.3).

#### S.3 Memory budget

**Constants.**
- **B0 = 141 MB:** the bench child's baseline, **measured** as the maximum of the ci20k native runs (120–141 MB, `bench/baselines/enumerate-native-ci20k-darwin-arm64-tierB-budget-eco.json`).
- **E0**, Electron's main process: **not measured** (T9).
- **Name length L = 18 B:** 13.1–20.9 measured on real trees.
- **Store row = 46 + L = 64 B:** the S1 review measured 62.2–68.0 B/node.
- **Folders are 15% of entries** (DESIGN §6, the per-directory line of the Phase 0 layout).
- **Keyed files κ = 1%** on POSIX; every file on Windows.
- **Link-key record ≈ 40 B.**
- **8 workers.**
- **Transport** (the 250k-node pruned tree and its JSON) = 150 MB. This is DESIGN §7's budget, **not measured**.
- **The gate metric is maxRSS** (bench/lib/rusage.ts:134), with the peak physical footprint reported beside it (rusage.ts:295).

Because every large allocation is an anonymous mapping (P4-11), a stage's memory leaves RSS when it ends. That was **measured**: `munmap` returns memory at once, while libmalloc kept 1 GB of freed blocks for more than 23 s. So a scan's peak is the largest stage.

**Components (MB).**

| Component | Memory | Spill | Aggregate |
| --- | --- | --- | --- |
| Queue (`Q_MAX` × 200 B, **measured** per job) | 13 | 1 | 1 |
| Listing buffers: 8 × (256 KiB + ≤ 16,384 entries × 98 B) | 15 | 15 | 15 |
| Derive staging: 8 × 1 MiB | 8 | 8 | 8 |
| Big-listing reserve: one listing over 16,384 entries; the gate's 1M-entry folder is 98 MB of listing plus a 4 MiB chunk | 102 worst | 102 worst | 102 worst |
| Open frontier: accumulators of about 112 B, ≤ (`Q_MAX` + 8) × depth 20 | – | 2 (9 worst) | 2 (9 worst) |
| AggregateState: folder heap 19, file heap 19, shallow keep 6, extension table 8 | – | 52 | 52 |
| Link-key log, resident run (at most 32 MiB, then disk) | 2 (5M), 4 (10M) | 4 (10M), 32 (100M) | 4 (10M), 32 (100M) |
| Text-candidate ids or suffix queue | 4–8 | 4 | 4 |
| Spill write buffers (12 columns × 2 × 1 MiB) and log runs | – | 24 + 16 | – |
| Seal: external sort (64 MiB run + 16 MiB merge) and patch windows (12 × 4 MiB) | ≤ 32 | 80 + 48 | 80 (100M only) |
| Summary store (spill ≤ 600k rows, aggregate ≤ 414k rows, × 65 B) | – | 39 | 27 |
| Answers and side tables | – | 5 | 5 |
| Spill reader page cache (64 KiB pages, LRU) | – | 32 | – |
| FullPassRunner: worker isolate 40 (not measured) + heap limit 64 + JS block LRU 8 + Rust page cache 64 | – | 176 | – |

**Peak RSS by stage (MB; typical, with the worst case in brackets; Node bench child).**

| Stage | Memory 5M (plan gate) | Memory 10M (forced) | Spill 10M | Spill 100M | Aggregate 10M | Aggregate 100M |
| --- | --- | --- | --- | --- | --- | --- |
| Walk | 506 (608) | 835 (937) | 267 (376) | 295 (404) | 227 (336) | 255 (364) |
| Seal | 496 | 819 | 321 | 321 | 244 | 320 |
| Hand-over, Node | +0 | +0 | +0 | +0 | +0 | +0 |
| Serve: store/summary + SSE-complete transport | 614 | 937 | 367 | 367 | 323 | 323 |
| Serve + one full pass in the FullPassRunner | as today (a JS pass over the store) | — | 543 | 543 | off | off |
| **Peak** | **614** | **937** | **543** | **543** | **336** | **364** |
| Ceiling (§5.3) | 700 (plan gate) | 700 | 700 ("10M full index": every row kept, on disk) | 1,500 | no row (kept ≤ 400) | 400 |
| Margin | 86 | **−237: not offered** | 157 | 957 | 64 | 36 (worst), 77 (typical) |

**Reading the table.**
- **The 10M "full index" row.** It is met by spill (543 MB with every row on disk), not by memory mode. P4-1's 64 B/node layout alone is 646 MB at 10M (owner question Q3). The memory threshold `T_mem` defaults to 5M.
- **Electron.** Replace B0 with E0 in every column.
  - Memory mode at 5M also holds one column in transit (≤ 40 MB) during the hand-over, so `E0 + 473 ≤ 700` requires E0 ≤ 227 MB. T9 lowers Electron's `T_mem` by 1M rows for every 64 MB of excess.
  - Aggregate's 36 MB worst-case margin shrinks by `E0 − B0`. The knobs are `R_dir` and `R_file` (−19 MB per halving) and the extension overflow cap.
- **The guarded memory walk** (overflow to aggregate): it stays ≤ 400 by construction of `M_agg` (§S.1.4).
- **Windows.** The link-key log reaches its 32 MiB run at about 0.8M files. Beyond that it goes to disk, so the resident figures above hold. Windows memory mode at 5M has its own `T_mem` (T9).
- **What the gate can break.** The worst column assumes the big-listing semaphore and one 1M-entry folder. Two such folders listed at the same time cannot happen (the semaphore). A single folder of more than about 1.2M entries breaks aggregate's worst case and is a recorded risk.

**Disk (spill and aggregate; the 3× rule applies to the sum, plus a 1 GiB reserve).**

| | Spill 10M | Spill 100M | Aggregate 10M | Aggregate 100M |
| --- | --- | --- | --- | --- |
| Columns (64 B + 4 B for a u64 `nameOff` on disk) | 0.68 GB | 6.8 GB | 0 | 0 |
| Block table and patch log (about 32 B per folder) | 0.05 | 0.48 | 0 | 0 |
| Link-key log, POSIX, κ = 1% | resident | 0.04 | resident | 0.04 |
| Link-key log, Windows (every file), plus one sort copy | 0.8 | 8.0 | 0.8 | 8.0 |
| **3× asks, POSIX** | ≈ 2.3 GB | ≈ 23.4 GB | 0 | ≈ 0.24 GB |
| **3× asks, Windows** | ≈ 4.6 GB | ≈ 46 GB | ≈ 2.4 GB | ≈ 24 GB |

**T0 check (24 Sep 2026):** the POSIX "3× asks" do not follow from the rows above. Three times the rows is 2.19 GB for spill at 10M, 21.96 GB at 100M and 0.12 GB for aggregate at 100M (0.24 GB with one sort copy of the log, as the Windows row counts it); with the 1 GiB reserve, spill asks 3.26 GB and 23.03 GB. The Windows asks are 3 × the rows without the reserve (5.66 GB and 46.91 GB with it). The 2.3 GB of §S.1.1 is a different figure: the overflow target's ask at `T_mem` = 5M, 3 × (1.25 × 5M × 68 B) + 1 GiB = 2.35 GB. T13's `spill_plan` computes its ask from the rule, not from this table; DESIGN §7 quotes the arithmetic.

The files actually written for `synthetic100m` in the Windows shape come to about 15 GB, inside the owner's 40 GB test-data cap. This Mac has about 216 GB free.

#### S.4 Electron's path

These facts are **measured** (RISKS R72, reconfirmed 24 Sep):
- Electron 31.7.7 answers 22 (`napi_no_external_buffers_allowed`) for external ArrayBuffers and Buffers.
- napi-rs 3.4 then copies each column (arraybuffer.rs:753-766).
- The Express server runs inside Electron's main process (electron/main.js:43).
- Electron's PartitionAlloc zone returns freed native memory at once; plain Node's libmalloc keeps it.

The design:
1. **Web and desktop run the same code.** No mode is web-only. The runtimes differ only in the hand-over: external views against copies.
2. **Memory mode** copies off-thread with an unmap per column (§S.1.6). T9 measures E0 and the 1M/5M hand-over inside the installed app's binary (`ELECTRON_RUN_AS_NODE=1`, loading the freshly built `.node` by path; never a bare dev Electron binary) and sets Electron's `T_mem`.
3. **Spill and aggregate** hand JavaScript only small, JS-owned arrays:
   - the summary (≤ 40 MB);
   - reader results (≤ 2 × maxNodes rows);
   - FullPassRunner blocks, filled by one napi call per folder block. The copy was **measured** at 0.13 ns per element at batch 4,096, in Electron as in Node.

   No Rust memory is ever viewed from JavaScript, so the V8 cage never matters there.
4. **Nothing is mapped.** Reads go through `pread` into a bounded anonymous page cache. **Measured:** a mapped 1 GB sweep added 1,024 MB to maxRSS, and only `munmap` removed it; a `pread` sweep held maxRSS at 5.5 MB and ran 3.5× faster cold. So maxRSS, the footprint and Electron's own accounting all see the same bounded arena.
5. **The main thread stays under 1 ms per native call (§13).**
   - Walk, seal, `storeTake`, `storeColumns`, the readers and `storeRelease` are all `AsyncTask`s.
   - The summary's accessors are plain JavaScript.
   - `NativeScanStore` refuses to be constructed on the main thread (it checks `isMainThread`).
   - The gate records event-loop delay p99 during the view pass.
6. **Worker threads inside Electron's main process.** The FullPassRunner uses `worker_threads`; `src/services/containerWorker.ts` is the precedent in this repo. T18 proves on the installed app that the tm-node addon loads in a worker (napi-rs addons are context-aware) and that `resourceLimits` holds the worker's heap.
7. **The gate runs twice:** in the plain-Node bench child (the gate) and in Electron-as-Node (recorded beside it). With P4-11, both measure the same allocator behaviour for the big blocks.

#### S.5 Spill

**S.5.1 When.** Spill is used when the projection is above `T_mem` and the plan allows it, or as a memory walk's overflow target. Both runtimes can spill.

**S.5.2 Format.**
- One file per P4-1 column (`parent`, `size`, `mtime`, `atime`, `flags`, `ext`, `container`, `cloudProv`, `names`, `childStart`, `childCnt`), plus `nameOff` as **u64** on disk, so the 4 GiB name-pool limit (walk.rs:942-946) never caps spill.
- Rows are at their block ids, in `PackedScanStore`'s encodings. There are no headroom rows, because large modes are read-only (P4-6a).
- Side files: the block table, the patch log, link-key runs and extension overflow. All are unlinked the same way.

**S.5.3 Files that cannot outlive the scan.**
- They live in `<appData>/scan-spill/`, one persistent directory, mode 0700.
- Each file is created and immediately unlinked:
  - **Linux:** `O_TMPFILE`, so the file never has a name.
  - **macOS:** `mkstemp` of `<pid>-<startMs>-<scanId>-<column>`, then `fstat`, then `unlink` only if the path's `(dev, ino)` still matches the open descriptor.
  - **Windows:** `CreateFileW` with `FILE_FLAG_DELETE_ON_CLOSE` and `FILE_SHARE_DELETE`.
- After that the kernel frees them when the last descriptor closes, even after a crash or SIGKILL (a kill test proves it). Only a crash inside the macOS `mkstemp`→`unlink` window, or a power loss on Windows, can leave a file.
- The boot sweep in `src/server.ts` removes files in `scan-spill/` whose `<pid>` is not alive, through one confined remover. The remover refuses any path outside `scan-spill/`, never follows a link, and reports `{removed, bytes, kept}`. Rust deletes nothing. **24 Sep 2026 (T0):** this rule departs from the master prompt's §9.3, which asks for "a startup sweep with an age check": it has no age limit, so a leftover file whose `<pid>` a live process has reused is kept until that process exits (DESIGN §6.2).
- **This needs the owner's exception to §3.1** ("never an `unlink`", master prompt line 74) (Q1). If the owner declines, the fallback uses no `unlink` at all: a fixed pool of named spill files that are reused, whose bytes are freed with `ftruncate(0)` on release, quit and at boot. That meets "never outlive the scan" for the bytes, but a crash then leaves the bytes until the next launch. **24 Sep 2026 (T0):** Q1 is pending the owner (§S.11). Both paths stay designed until the owner answers, and T13 builds the one the answer picks.
- **Same volume.** The files have no names, so a walk cannot list them and the scan's totals can never include them. That holds even when app-data is inside the scanned root, which is the common case for a macOS home-folder scan. So `scan-spill` is **not** added to `never_descend`, and the app-data cache is excluded from the results structurally, as §13 asks.
  - The directory itself is empty. `pathGuard` and `pathSanitizer` (src/utils/pathSanitizer.ts:46) refuse any destructive request under it, and the Empty Folders view skips it, so it can never be offered for Trash.
  - `missingGigabytes.ts` gains the line "TreeMap's own scan files (open, removed when the scan closes)" with the ledger's bytes, so its lines still add up to the used bytes.

**S.5.4 Free space.** `spill_plan(projected, mode, platform)` works out `bytes_needed` from §S.3's disk table and reads free space from statvfs `f_bavail × f_frsize` (on Windows, `GetDiskFreeSpaceExW`), minus a process-wide ledger of the bytes other spills have reserved. Spill is allowed only when all of these hold:
- free ≥ 3 × `bytes_needed` + 1 GiB;
- app-data is writable, and not in a read-only portable session (portableMode.ts `probeWritable`);
- the file system is local. `smbfs`, `nfs`, `afpfs`, `webdav` and `fuse` are refused, because an unlinked open file there can leave a renamed leftover.

Otherwise the plan names the rule that refused it, and the scan runs in aggregate.

During the walk, after every 256 MiB written, spill needs free ≥ 2 × the projected remainder + max(1 GiB, 2% of the volume). `ENOSPC` or `EIO` has the same effect. Either converts to aggregate (§S.1.4), and the notice says why. The disk is never filled.

**S.5.5 The summary and the readers (main-thread views, exact).**
- **The selection ports.** `select_prune(root, maxNodes)` is a byte-exact Rust port of `pruneStore`'s discipline (scanStore.ts:361-398):
  - `StoreSizeHeap`'s own sift rules (scanStore.ts:284-324), which decide ties;
  - children pushed in child order;
  - pop while `nodes < maxNodes`;
  - **every** child of each popped folder emitted, as the JS does.

  `select_treemap(root, maxDepth, minSize, maxNodes)` ports `buildTreemapFromStore`'s expansion order (treemap.ts:198-275) the same way. Both read the spill through the page cache and return the exact set of rows the JavaScript will touch.
- **The summary.** It is `select_prune(root, PRUNE_MAX_NODES)` (scanRoutes.ts:93), plus `select_treemap` for the UI's default request (maxDepth 4, `010-fx-rolling-numerals.js:525`), plus the top three levels for snapshots. It gets fresh breadth-first ids, and each folder whose children were not selected keeps its **true** child count through an `omitted` side table. Then `isExpandableId` and the `pruned` flag behave exactly as on the full store.
- **The result.** The unchanged `pruneStore` on the summary gives byte-identical SSE-complete and `/result` JSON. That is tested for every golden key and for a grid of trees full of ties.
- **The async readers.** `spillSelect(kind, folder, params)` serves `/subtree` and `/treemap` for other parameters. `spillLookup(paths ≤ 2000)` serves `/nodes`, `/budgets`, facts and `knownSizeOf`, using `findByPath`'s own rules (scanStore.ts:1404-1447). Both are `AsyncTask`s. Their results are adopted into a temporary `PackedScanStore`, and the unchanged JS emitters run over it, so route handlers become `async`, with the same response shapes.

**S.5.6 The dashboard answers.** They come from the AggregateState's exact answers (§S.6.4). In spill, when the seal cannot prove an answer exact (a large hard-link correction), it recomputes that answer with one bounded `pread` pass. **Spill answers are always exact.**

**S.5.7 Full-tree features: the FullPassRunner (S3b).** Every consumer whose own JavaScript state is bounded runs as a named, pure function in a `worker_threads` worker, against a `NativeScanStore` that reads folder blocks into JS-owned arrays. The worker has `resourceLimits.maxOldGenerationSizeMb = 64`, so a consumer that grows fails loudly instead of growing RSS. Its result is posted back.
- **Runs in the runner:** cleanup suggestions (including the Reclaim Score's input and the dashboard's automatic `loadCostEstimate` → `/api/cleanup/suggestions`, `045-persistent-live-index.js:510`, `190-grid-view.js:267`), custom rules without the duplicate option, query, calendar, security, cloud-safe, compression candidates, the git pack breakdown, packages, games, media, app attribution, browser profiles, humanScale, and the folders CSV.
- **Answered from the seal instead:** `subtreeCount` (recursive counts from the fold).
- **Off in spill until ported to native code**, because their JS state grows per node: empty folders (**measured** 57.5 B/node), custom rules with the duplicate option (166.7 B/file), duplicates (97.2 B/file; Phase 5 ports it), near-duplicate candidates, compare, the per-file CSV/XLSX export, offloading a whole folder (no node limit, offload.ts:278), and expanding a Photos library.
- **Also off:** Live mode (the watcher writes, and large stores are read-only) and container expansion.

`NativeScanStore` is a second implementation of `ScanStore`. So:
- it is confined to workers (§S.4 item 5);
- it is checked by the existing storeFuzz differential against `ObjectScanStore`;
- the numbering battery (§S.2 test 4) runs through the runner.

#### S.6 Aggregate

**S.6.1 What runs during the walk.** No rows are written, and nothing is held per entry or per folder beyond the open frontier.

- **Fold-on-close.** A folder is open from the commit that listed it until its listing is committed and every child folder has closed. Its accumulator (about 112 B) holds:
  - its own row (name, mtime, atime, flags, depth, position path, true child count);
  - an exact u128 total;
  - recursive file and folder counts;
  - its keyed bytes (the most a hard-link correction can remove).

  On close it is offered to the heaps and folded into its parent. With the sink-mode `Q_MAX` of 4,096, the open set is at most (`Q_MAX` + 8) × depth (§S.3).
- **β heaps, the correctness-first rule.** They keep the top `R_dir + 1` = 150,001 folder totals and the top `R_file + 1` = 200,001 file sizes, as records with names and position paths.
  - At the seal, β_d is the smallest total held in a full folder heap, or −∞ when the heap is not full. β_f is the same for files.
  - **Kept:** every folder with total > β_d; every file with size > max(β_d, β_f); the root.
  - A kept file's ancestors have totals ≥ its size > β_d. A kept folder's ancestors have totals ≥ its own. So the set is **ancestor-closed** by construction.
  - The strict ">" drops rows tied at a boundary together, so the set does not depend on arrival order.
- **Shallow keep.** The top 32 children of every folder at depth ≤ D_s, where D_s falls as the depth histogram fills: at most 64k rows. This serves `saveSnapshot` (depth 3, top 30, snapshots.ts:25-31) and the MCP `scan_path` summary. A snapshot is saved only when D_s ≥ 2, and is otherwise skipped with the reason.
- **Exact answers.** They are self-contained records with the full path captured at commit or close, so no ancestor rows are needed:
  - the top 2,000 files by (size desc, pre-order);
  - the top 2,000 folders by (total desc, post-order), with recursive file counts;
  - the extension table: count, bytes, and the first-seen pre-order position path. It holds 65,535 dictionary entries plus overflow up to 200k distinct texts; past that, `/file-types` is flagged off with the reason;
  - the 1,024-bucket size histogram (reclaimInputs.ts:45-47).

  Files are visited with `eachFile`'s semantics: pre-order, every folder descended, nothing removed at scan time (scanStore.ts:1373-1388).
- **Hard links in the heaps.** A keyed file enters the file heap as one entry per `(dev, ino)`. That entry holds the least `(depth, position path)` member seen so far, which becomes the winner online, and it counts the size once. On POSIX this is exact, because every name of an inode reports the same size. An evicted family can never come back, because the threshold only rises.
- **Rules evaluated during the walk.**
  - The cloud table runs on the path (Q7).
  - Extensions of non-ASCII names go to Node **once per distinct raw suffix**, asynchronously and never blocking the walk. This is exact, because only `name.slice(dot + 1)` is lowercased (nodeInput.ts:40).
  - Names with a code point whose JavaScript lowercase contains ASCII go to Node individually. Example: U+212A KELVIN SIGN becomes `k`, which can complete the Docker name rule. A test enumerates every code point under Node 24 and Electron 31 and pins the set.
  - Refused folders' paths go to Node's `noteRefused` in batches, and it keeps the five smallest (scanRefusals.ts:16-29), so the rule stays in one place.

**S.6.2 The seal.** Resolve hard links (§S.6.3). Build the summary from the kept records:
- fresh breadth-first ids through `finalize.rs`, with children in their original position order;
- the `omitted {count, bytes}` side table for each kept folder, exactly its total minus the sum of its kept children;
- recursive counts;
- `totalsFinal`.

Summary rows ≤ 150k + 200k + 64k.

**S.6.3 Hard links, exact or refused.**
- The link log goes to disk as sorted runs past 32 MiB, in **every** tier. A POSIX 100M tree at κ = 1% needs about 0.24 GB free for it (3×).
- When even that is refused, the scan stops with "needs N MB free to count hard links exactly". **Hard-linked bytes are never approximated**, and there is no tier that silently skips deduplication.
- At the seal:
  - each loser's listed bytes are subtracted from the nearest kept ancestor's omitted tally, which is found by position-path prefix through a map over the kept folders;
  - they are also subtracted from each kept ancestor's total, from the extension bytes (losers stay in the counts at 0 bytes, as `collectFileTypes` counts every file) and from the tallies;
  - Windows refresh deltas are applied the same way.
- **Windows** reports no link count (windows.rs:22-23), so every file is keyed and the log is on disk (about 4 GB at 100M). Aggregate on Windows therefore needs the disk rule for the log (§S.3), or the scan is refused.
  - Re-stating one member per multi-member family uses `OpenFileById` with a handle on the volume, which needs no path. **This is not verified here; T20 verifies it on the Windows CI leg.**
  - If it cannot be used without privilege, the Windows record also carries the file's name, and a folder log keeps every folder's parent and name on disk (about 34 B per folder).

**S.6.4 Exact or flagged (P4-16).** Corrections can only lower totals: POSIX losers, and Windows refreshes in either direction. So the seal compares the exact correction mass Δ with the gap between the last listed entry and the best evicted bound.
- If the gap covers Δ, each answer is **proven exact**.
- Otherwise it carries `exact: false` with the reason ("hard links across N GB"): in aggregate the answer stands with the flag; in spill it is recomputed (§S.5.6).

What this means per list:
- **POSIX `/large-files`:** always exact.
- **`/file-types`:** always exact, ties included.
- **Folder totals in the tree views:** always exact, because they are corrected; only *which* folders were kept may differ from a post-correction choice.

**S.6.5 What the UI says.**
- `GET /api/scan/:id/storage` (a separate endpoint, so the `sseComplete` golden is unchanged) returns `{mode, reason, transitions, disabled[], exactness, spill: {bytes, sameVolume}, aggregate: {keptRows, omittedRows, D_s}}`.
- `/stats.storageMode` becomes real (today it is hard-coded at scanRoutes.ts:76).
- The dashboard notice lists `disabled[]` by name from the availability table.
- `FileNode.omitted?: {files, folders, bytes}` is an additive field, present only in aggregate (Q4). The treemap draws it as space labelled "N smaller items". A node with omitted children is not offered for drill-down.
- `/nodes` and the facts answer **`notKept`**, distinct from "not in this scan". `policy.knownSizeOf` falls back to `lstat` for a path the store did not keep, so agent byte caps still count it (policy.ts:127-149, fileRoutes.ts:56-57). This is safety-critical and tested.
- The cost estimate's what-if already tolerates a failed `/cleanup/suggestions` (190-grid-view.js:267-268). A test pins that it renders on a 409.

#### S.7 The availability table (one source; the coverage test fails on any route or MCP tool it does not classify)

| Feature | Memory | Spill | Aggregate |
| --- | --- | --- | --- |
| SSE complete, `/result`, `/subtree`, `/treemap`, snapshot, journal | as today | exact (summary + async selection) | kept rows + `omitted` |
| `/large-files`, `/file-types`, `/large-folders`, MCP `get_largest`, `reclaim_ranked` (≤ 2000) | as today | exact answers | exact, or flagged `exact:false` |
| `/nodes`, `/budgets`, facts lookups, `knownSizeOf`, `/duplicates/detail` | as today | async lookup | `notKept` + `lstat` |
| Cleanup suggestions, custom rules (no dup), query, calendar, security, cloud-safe, compression, git, packages, games, media, app attribution, browser profiles, humanScale, folders CSV | as today | FullPassRunner | off (409) |
| `subtreeCount` | as today | from the fold | from the fold (kept folders), else `notKept` |
| Duplicates, near-duplicates, compare, empty folders, custom-rule dup option, per-file CSV/XLSX, folder offload, Photos expansion | as today | off (409) until ported | off (409) |
| Live mode, container expansion | as today | off (409) | off (409) |
| `/cost/estimate`, `/scans`, missing-gigabytes, scheduler, fleet, `/stats` | as today | as today | as today |

Removed from P4-7's list, because neither reads the store:
- the "persistent index hand-off" (indexEngine.ts:325, 382);
- the Time Capsule (timeCapsule.ts:1-14, 349).

#### S.8 The synthetic gate (S5)

The `SyntheticLister` (P4-8) is a scripted `Lister`, deterministic from (seed, folder path), refused outside the app's temp root, and never registered as a scanned root, so destructive endpoints refuse its paths.

**Presets.** They create nothing on disk and are labelled `source: synthetic`; `bench compare` refuses them as a throughput baseline.

| Preset | Shape |
| --- | --- |
| `synthetic10m`, `synthetic100m` (the developer shape) | 15% folders, L ≈ 18, log-normal sizes, κ = 1% with families spread across folders |
| `-wide` | 1% folders |
| `-dirheavy` | 33% folders, plus one folder with 1M subfolders |
| `-biglisting` | one folder of 1M small files, whose total keeps it out of the prune (see risk R-S10) |
| `-links` | κ = 10% (pnpm, git and Time Machine shapes) |
| `-windows` | nlink 0, every file keyed, refresh deltas on multi-member families |
| `-candidates` | 0 allocated everywhere, 10% non-ASCII names with a dot, 1% invalid UTF-8, the Kelvin and İ look-alikes |

**Runs.** Each run is one scan per bench child, recording maxRSS **and** peak footprint, entries/s and CPU s per million. Runs happen in the plain-Node child and again in Electron-as-Node.
1. `synthetic10m` in forced memory (records the honest over-ceiling number) and in spill.
2. `synthetic100m` in spill and in aggregate, in every variant.
3. **The auto-mode legs** (the path no forced run exercises):
   - no projection, spill refused by a fake plan, `synthetic100m` → must convert and stay ≤ 400 MB;
   - no projection, spill allowed → ≤ 1.5 GB;
   - a projection 10× too low → converts during the walk.
4. **The view pass, through the API in the bench child:** SSE-complete prune, `/treemap` at the defaults and at maxDepth 4, `/large-files` 10 and 1000, `/file-types`, `/large-folders` 10, **plus the dashboard's own automatic requests after completion** (the cost estimate → cleanup suggestions through the FullPassRunner in spill, a 409 in aggregate). The pass records each view's time, event-loop delay p99, and maxRSS across the pass.
5. `enum200k`/`enum1m` throughput under the hybrid queue against the Phase 3 baselines.

**The gate passes when:**
- spill ≤ 1.5 GB (100M) and ≤ 700 MB (10M);
- aggregate ≤ 400 MB (100M, every variant, and the auto leg);
- memory ≤ 700 MB at 5M, in both runtimes;
- every view answers with no main-thread native call over 1 ms (event-loop p99 recorded);
- Phase 3's digests are unchanged, and the native golden legs are equal;
- throughput is within 10% of the Phase 3 baselines;
- the full `npm test` passes under 4 and 10 busy loops;
- CI is green on macOS, Windows, Linux and Linux pt-BR.

Record with `--record` on a clean tree. **A miss is fixed before the commit, never relabelled.**

#### S.9 Tasks: ordered, test first, one recorded mutant per behaviour, each with its green gate

House rules as in Phases 2–3. Tests count events; nothing times the wall clock. Every timing-sensitive test is stressed under 4 and 10 busy loops before the owner is asked to push. The owner pushes from GitHub Desktop; nothing here pushes.

- [ ] **T0. Documents only.**
  - Paste this section.
  - Amend P4-1…P4-7 as in §S.0 and DESIGN §6, §6.1, §6.2, §7 and §16, the budgets labelled "budget until measured".
  - Add §S.10's risks to RISKS.
  - **Green gate:** the owner answers Q1–Q5 and Q7; the rest can wait until the task that needs them.
  - **24 Sep 2026: the documents are written; the gate is open.** This section is pasted, P4-1…P4-7 are amended with the originals struck through, DESIGN §6, §6.1, §6.2, §7 and §16 are amended, RISKS has R73–R87, and §S.11 records each question's status. Of Q1–Q5 and Q7: Q1, Q3 and Q5 are pending the owner; Q2, Q4 and Q7 are engineering decisions awaiting the owner's confirmation.
- [ ] **T1. `notHashedReport` breaks ties by path.**
  - **Tests first:** more than 20 equal-size placeholders whose id order and path order disagree; the 20 listed must be the 20 smallest paths.
  - **Mutant:** restoring `a - b`.
  - **Green gate:** targeted tests and goldens; its own commit (duplicateFinder.ts:257).
- [ ] **T2. The guards, before anything moves.**
  - `tests/fixtures/renumber.ts`;
  - `tests/numberingIndependence.test.ts` (the battery);
  - the native golden leg in memory mode;
  - the 1-against-8-worker determinism leg.
  - **Mutants:** restoring `a - b` (red before T1 and green after); a collector iterating `0..count`.
  - **Green gate:** green on today's code, or a recorded pre-existing difference resolved first.
- [ ] **T3. `SyntheticLister`** (moved forward because everything after it measures with it).
  - **Tests first** (tm-walk `tests/synthetic.rs`, `tests/benchSynthetic.test.ts`):
    - the same seed gives the same listings at any worker count;
    - the exact count, counted;
    - each knob in §S.8 observable in the output;
    - refused outside the temp root;
    - the report labels the source; compare refuses it.
  - **Mutants:** seed ignored; count off by one; root check removed.
  - **Green gate:** cargo test; clippy on macOS, Windows and Linux; the Node test.
- [ ] **T4. The digest lock:** committed column digests of `build(take())` for the scripted and synthetic fixtures at 1 and 8 workers.
  - **Green gate:** recorded on a clean tree.
- [ ] **T5. `Column::Anon`** (mmap on POSIX, `VirtualAlloc` reserve and commit on Windows) and `PackedScanStore.release()`'s guard.
  - **Tests first:**
    - length n, capacity rows, and the headroom reads as zero;
    - `Drop` unmaps (an mmap counter);
    - a counting global allocator sees 0 heap bytes for column storage;
    - reading after release throws from the explicit check.
  - **Mutants:** back it with a `Vec` (the allocator test goes red); remove the released check.
  - **Green gate:** cargo test; clippy ×3; `// SAFETY:` on every unsafe block.
- [ ] **T6. tm-walk: the commit lock and block numbering**, behind `WalkOptions.numbering = Discovery | Blocks` (default `Discovery` until T10). Also: the lossy re-sort; the hybrid queue; the big-listing semaphore with chunked commit; `ListBuffer` shrinking; the `ListingSink` trait; `CollectSink`; the I1–I4 checker.
  - **Tests first,** with scripted listers × workers {1, 2, 8, 64}:
    - I1–I4 hold;
    - one block per listing;
    - `'a'+F8` against `'a😀'` ends in tm-store's order;
    - Windows order is untouched;
    - peak queue length ≤ `Q_MAX` on the dirheavy tree (counted);
    - a lowered id ceiling faults;
    - a cancel mid-listing commits nothing;
    - abort is called on cancel, fault and refused root;
    - a sink panic becomes the walk fault;
    - `CollectSink` under φ equals `take()`.
  - **Mutants:** per-entry ids (I2 red); the re-sort skipped; FIFO kept past `Q_MAX`; a commit before the loop ends.
  - **Green gate:** every tm-walk test under both numberings; the T4 lock unchanged; clippy ×3.
- [ ] **T7. MemorySink + P1 + counters.** Workers write outside the lock at reserved offsets. The link log uses disk runs past 32 MiB. The winner comes from `(depth, position path)`. S1's counters and the `sparse_terms` fallback in breadth-first order.
  - **Tests first:**
    - against `build(take())`, every column is equal after φ on scripted and synthetic trees up to 1M, counters included;
    - the cross-folder hard-link fixture;
    - Windows-shaped refresh;
    - a forced 64 KiB run size gives the same result as in memory.
  - **Mutants:** the walk-order-first winner; the link log's resident cap ignored.
  - **Green gate:** cargo test; clippy ×3.
- [ ] **T8. tm-node memory path:**
  - `scanStart` gains `storage`;
  - `storeTake` and `storeColumns` become `AsyncTask`s (external views, or off-thread copy then unmap);
  - `runNativeWalk` gets the new path behind a flag;
  - `adoptColumns` gets `totalsFinal`.
  - **Tests first:**
    - `tests/packedStoreAdopt.test.ts`'s fuzz with the native producer;
    - `ingestColumns` (the oracle) against the stream path: byte-identical JSON for every golden key on ci20k, enum200k and synthetic trees with hard links and invalid UTF-8;
    - the native golden leg;
    - determinism;
    - `nativeEquivalence` unchanged;
    - no main-thread native call copies more than one column (counted).
  - **Green gate:** targeted suites and goldens.
- [ ] **T9. S2 measurements** (no product code):
  - B0 and E0;
  - maxRSS and footprint for walk → seal → hand-over → first prune at synthetic 1M, 2M, 3M and 5M, and enum1m, in the bench child and in Electron-as-Node;
  - the Node passes on `-candidates`;
  - worker-thread addon loading in the installed app.
  - These set `T_mem` and `M_agg` per runtime.
  - **Green gate:** recorded with `--record`. If 5M > 700 MB in a runtime, that runtime's `T_mem` is lowered and the reason recorded.
- [ ] **T10. Switch production memory mode to the stream path** (`numbering = Blocks`). `ingestColumns`, `take()` and `build()` stay as oracles.
  - **Green gate:** full `npm test` under 4 and 10 busy loops; commit **S2**; the owner pushes; CI green on all four legs before T11.
- [ ] **T11. The cloud rule table.** The regexes in `cloudFolders.ts` (lines 15-20) become built from `CLOUD_RULES`, with a Rust matcher over the same table.
  - **Tests first:** the old regex against the table over a path corpus (case variants, a trailing `.icloud` against `.icloud` inside a name, Windows separators, U+212A, U+0130, U+017F); the same fixture file through the Rust matcher; the lowercase-to-ASCII code point set pinned in Node 24 and Electron 31.
  - **Mutants:** a case-sensitive match; the `$` anchor dropped.
  - **Green gate:** both suites; memory goldens unchanged.
- [ ] **T12. AggregateState:** fold-on-close, the β heaps, the shallow keep, the exact answers with position-path keys, family-deduplicated file entries, the Δ exactness check, the extension table, the histograms.
  - **Tests first,** against the memory store of the same tree (the oracle):
    - the answers equal `collectLargestFiles` (limits 1..2000 × a grid of minSize), `collectFileTypes` and `collectLargestFolders`, on tie-heavy trees, trees with zero-byte extensions and cross-folder families;
    - kept totals plus omitted equal the full totals;
    - the kept set equals the β rule and is ancestor-closed;
    - boundary ties are dropped together;
    - 5 runs × workers {1, 4, 8} give identical state;
    - peak live bytes stay ≤ the budget formula on a 2M synthetic (counted);
    - a planted large correction flips `exact` to false.
  - **Mutants:** an id tie-break; the ancestor not preferred; corrections skipped; a keyed file counted twice; the flag not set.
  - **Green gate:** cargo test; clippy ×3; `cargo mutants` on the module.
- [ ] **T13. Spill files:** `spill_plan` (3×, file-system type, ledger, read-only portable session), files unlinked at creation or the `ftruncate` fallback (per Q1), the sweep, the confined remover. **24 Sep 2026 (T0):** Q1 is pending the owner (§S.11), so both paths stay designed (§S.5.3); T13 builds the one the owner's answer picks.
  - **Tests first:**
    - a fake statvfs for every rule and its reason;
    - a same-volume flag;
    - the kill test: spawn a helper that spills, SIGKILL it, and assert no data file remains and the free bytes came back (counted, no sleeps);
    - the sweep removes only dead owners' files;
    - the remover refuses paths outside `scan-spill` and replaced inodes.
  - **Mutants:** one per rule.
  - **Green gate:** cargo and TS tests.
- [ ] **T14. SpillSink:** external sort, the patch and block logs, the seal passes, load-back.
  - **Tests first:**
    - the spill columns after the seal equal MemorySink's byte for byte (one worker, the same schedule) and after φ (8 workers);
    - resident buffers stay within the budget (counted);
    - an `ENOSPC` injected at k MiB converts to aggregate and leaves nothing open;
    - load-back equals memory mode.
  - **Mutants:** a patch window off by one; name offsets not a running sum.
  - **Green gate:** cargo test; clippy ×3.
- [ ] **T15. The selection ports, the summary and the async readers.**
  - **Tests first:**
    - `select_prune` and `select_treemap` equal the JS row sets on fuzz trees full of ties, at maxNodes {1, 50, 250k};
    - the summary plus the unchanged `pruneStore` gives memory mode's JSON for every golden key;
    - `spillLookup` equals `findByPath`, duplicate names and missing paths included;
    - no reader call runs on the main thread (a sync-call counter).
  - **Mutants:** a heap tie rule changed; an unfinished last folder.
  - **Green gate:** golden forced-spill leg equal.
- [ ] **T16. The chooser and the conversions.**
  - **Tests first:**
    - the chooser's table (projection × hint × plan × setting × runtime);
    - memory → spill at `capRows` (the columns are unmapped, counted);
    - a dual-fed memory → aggregate triggered by the byte guard, including before a big listing;
    - spill → aggregate on a falling free-space sequence;
    - no legacy walker is started in the large modes (diskScanner.ts:723-744).
  - **Mutants:** the `<` / `≤` boundary; the guard counted in rows.
  - **Green gate:** targeted suites.
- [ ] **T17. Node wiring for S3:**
  - `storageMode.ts` with the availability table and its coverage test;
  - 409 `STORAGE_MODE`;
  - `/api/scan/:id/storage`, a real `storageMode`, `disabled[]`;
  - settings and openapi;
  - `pathGuard` over `scan-spill`, and the Empty Folders skip;
  - the missing-gigabytes line;
  - release on forget, evict and quit, and the boot sweep;
  - the notice;
  - `nativeEquivalence` leg (c') in forced spill against the walker.
  - **Green gate:** full `npm test` under busy loops; commit **S3**; the owner pushes; CI on all four legs.
- [ ] **T18. The FullPassRunner and `NativeScanStore`, worker-only (S3b).**
  - **Tests first:**
    - storeFuzz with a `NativeScanStore` producer at a 2-page cache;
    - the numbering battery and each runner consumer's JSON equal memory mode's;
    - the constructor throws on the main thread;
    - `resourceLimits` stops a consumer that grows;
    - RSS during a cleanup pass on `synthetic10m` spill stays within the budget (counted bytes);
    - the addon loads in a worker inside the installed Electron.
  - **Green gate:** commit **S3b**; the owner pushes; CI.
- [ ] **T19. Aggregate end to end (S4):** the summary with `omitted`, `notKept`, `knownSizeOf`'s `lstat`, the aggregate UI notice, `exact` flags in the answers, the cost-estimate 409 rendering.
  - **Tests first:** `aggregateMode.test.ts`; `aggregateUi.test.ts`; a trash byte-cap test with a file aggregate did not keep; `omitted` absent in memory mode (the golden).
  - **Green gate:** commit **S4**; the owner pushes; CI.
- [ ] **T20. Windows large mode:** the log's record shape, refresh through `OpenFileById` (or names plus the folder log), a small Windows CI fixture with real hard links, refusal when 3× the log does not fit.
  - **Green gate:** the Windows leg is green.
- [ ] **T21. Bench plumbing:** the presets and variants, `--storage`, `--runtime=electron`, the footprint column, the view pass including the dashboard's automatic requests, event-loop delay.
  - **Tests first** in `benchSynthetic.test.ts`.
- [ ] **T22. The Phase 4 gate** (§S.8).
- [ ] **T23. S6:** DESIGN §6, §6.1, §7, §9.1 and §16 with the measured numbers; CURRENT-STATE §11; the openapi `storageMode` enum; the README storage sentence from harness numbers only; commit; the owner pushes; CI.

#### S.10 Risks

Recorded in `docs/engine/RISKS.md` §J as R73–R87, in this order (R-S1 is R73, R-S15 is R87).

- **R-S1 (RISKS R73) — the equivalence proof rests on Lemma 4's list.** A future consumer that breaks ties by id would differ between runs. The determinism and renumbering batteries in CI are the guard, and each is shown red once.
- **R-S2 (RISKS R74) — the aggregate worst-case margin is 36 MB**, on the bench child's B0 of 141 MB and a transport budget that has never been measured (150 MB). Electron's E0 is unknown. The knobs are `R_dir`, `R_file`, the shallow keep and the extension overflow cap.
- **R-S3 (RISKS R75) — one folder of more than about 1.2M entries breaks aggregate's worst case.** The `Listing`'s 80 B `Entry` is never compacted. The gate includes a 1M-entry folder; larger is recorded.
- **R-S4 (RISKS R76) — the hybrid queue changes walk order.** That may move Phase 3's throughput and the hill-climber's ramp. There is a 10% bench gate; `Q_MAX` is the knob.
- **R-S5 (RISKS R77) — lock contention.** One commit lock per listing, about 50 ns per row in the sink modes, with a 1M-entry listing about 10 ms. It is measured in T22. There is deliberately **no** gap-leaving per-worker fallback, which would break I2.
- **R-S6 (RISKS R78) — Windows.** A key per file on disk (about 8 GB with its sort copy at 100M). `OpenFileById` is unverified. Large scans are refused when the log does not fit.
- **R-S7 (RISKS R79) — aggregate flags.** Aggregate lists on Windows or hard-link-heavy trees may carry `exact:false`. That is visible and honest, but it is a degradation.
- **R-S8 (RISKS R80) — the FullPassRunner.** Worker isolate cost is not measured (budgeted at 40 MB). Each ported consumer must be a pure function of (store, args); one that imports server state fails the purity test in T18.
- **R-S9 (RISKS R81) — lost features.** Spill's off list (duplicates, empty folders, compare, per-file export, Live mode) is a visible loss against today for trees above `T_mem`, until those features are ported to native code (duplicates in Phase 5).
- **R-S10 (RISKS R82) — `pruneStore` emits every child of a popped folder** (the `while (heap.size > 0 && nodes < maxNodes)` loop in `pruneStore`, scanStore.ts:361-398). A popped 1M-entry folder makes the SSE payload O(listing) in **every** mode today, beyond the transport budget. This is not introduced here. It is recorded, the gate's big-listing variant keeps that folder small in bytes, and a fix is owner question Q11.
- **R-S11 (RISKS R83) — spill disk space is invisible.** Unlinked spill files do not show in `du` or Finder while a scan is open; the missing-gigabytes line and the notice explain them. A crash inside the macOS create→unlink window leaves one named file until the next launch.
- **R-S12 (RISKS R84) — cold spill reads on slow media.** A cold `pread` on an HDD app-data volume slows the async readers (they never block the main thread) and the runner.
- **R-S13 (RISKS R85) — MFT scans stay memory-only.** `mftTake` decodes a whole `WalkOutput`, so they are refused above `T_mem`.
- **R-S14 (RISKS R86) — collisions with S1.** ~~S1's crate is changing now.~~ S1 is committed (`2415d6c`). The kernel extraction (T6/T7) starts only after S1 is committed, and `build()` stays the oracle.
- **R-S15 (RISKS R87) — measurement caveats.** Reader timings were taken under load average 6.5–7.4. The memory figures reused here are deterministic, but every ms figure is an upper bound.

#### S.11 Open questions for the owner

Each question's status was recorded on 24 Sep 2026 (T0).

1. **Q1 — §3.1 and `unlink`.** §3.1 says "never an `unlink`, ever, anywhere in new code". Do you accept an exception confined to `<appData>/scan-spill` for TreeMap's own files (unlinked at creation, after an inode check, crash-proof)? Or do you prefer the no-`unlink` fallback: reused files, `ftruncate(0)` on release, bytes left after a crash until the next launch?
   - **Status: engineering reading, 24 Sep 2026, pending the owner.** Not decided: §3.1 is the owner's rule, and the master prompt's §3 says a pull request that breaks any §3 rule "is rejected regardless of benchmark numbers". The reading, which the owner may accept or refuse: §3.1's bullet begins "Deletes continue to go to the system Trash only", so its "never an `unlink`" can be read as about the user's files; and the codebase already removes its own temporary files, the gdu shards (`src/services/gduScanner.ts:442` and `:468`) and the MFT helper's outputs (`sweepStaleOutputs`, `src/services/scan/nativeEngine.ts:980`). §9.3's clean-up bullet (on scan expiry, on app quit, and at startup for an orphan from a crashed run) does not force an `unlink`: the no-`unlink` fallback frees the bytes at the same three points. The boot sweep as designed also departs from §9.3's "startup sweep with an age check" (§S.5.3, DESIGN §6.2). Until the owner answers, both paths stay designed (§S.5.3, T13). An earlier draft of this status, written the same day, called Q1 decided without naming who decided it; nobody had.
2. **Q2 — the gate metric.** Is maxRSS the gate, with peak footprint reported beside it? With no mappings they should agree.
   - **Status: engineering decision, 24 Sep 2026, the owner may overrule.** maxRSS is the gate, with the peak physical footprint reported beside it.
3. **Q3 — the 10M row.** §5.3's "10M, full index in memory ≤ 700 MB" cannot be met with P4-1's layout (about 937 MB). Do you accept it met by spill with every row on disk (about 543 MB), with memory mode's threshold at 5M?
   - **Status: reported to the owner on 24 Sep 2026; the owner's answer is pending.** §5.3's "10M entries, full index in memory ≤ 700 MB" is not reachable with P4-1's layout. The walk's merge alone was measured at 147–168 B/node (the runs behind that range are not recorded under `bench/baselines/`), which is 1,470–1,680 MB at 10M by arithmetic. P4-1's store row is 64 B, budget until measured: about 646 MB at 10M with 1% headroom, before the walk's working memory and the transport. Proposed: the row is met by spill, with every row kept on disk (543 MB, budget until measured, §S.3), and memory mode's threshold `T_mem` defaults to 5M. This is a proposal, not a decision.
4. **Q4 — additive API fields.** Is `FileNode.omitted` (aggregate only) plus a `notKept` answer on `/nodes` and the facts acceptable under §11.1, which allows additions only?
   - **Status: engineering decision, 24 Sep 2026, the owner may overrule.** As proposed: `FileNode.omitted` is added in aggregate only, and `/nodes` and the facts answer `notKept`. Both are additions; the memory-mode goldens do not change.
5. **Q5 — Live mode and container expansion.** Should they be off in spill and aggregate for Phase 4?
   - **Status: engineering proposal, pending the owner.** Live mode and container expansion are off in spill and aggregate, and the notice names them (P4-6a, §S.7).
6. **Q6 — the FullPassRunner.** Must it land inside Phase 4 (S3b, proposed)? And may the per-node-state features stay off in spill until they are ported to native code?
   - **Status: engineering proposal, pending the owner.** The FullPassRunner lands inside Phase 4 (T18, commit S3b). The features whose JavaScript state grows per node stay off in spill until they are ported to native code (§S.5.7).
7. **Q7 — the cloud rule.** Is one table shared by `cloudFolders.ts` and Rust acceptable, with memory mode keeping P4-3's Node pass?
   - **Status: engineering decision, 24 Sep 2026, the owner may overrule.** One table (`CLOUD_RULES`, T11) builds the regexes in `cloudFolders.ts` and feeds the Rust matcher; memory mode keeps P4-3's Node pass (P4-3a).
8. **Q8 — the queue.** Do you accept the hybrid FIFO→LIFO queue (`Q_MAX` 65,536 in memory mode, 4,096 in the large modes), with a re-bench?
   - **Status: engineering decision, 24 Sep 2026, the owner may overrule.** The hybrid FIFO→LIFO queue, `Q_MAX` 65,536 in memory mode and 4,096 in the large modes (P4-13), re-benched against the Phase 3 baselines (T22: within 10%).
9. **Q9 — the hard-link winner.** Keep today's breadth-first-first member (proposed, byte-identical)? Or adopt the digest's smallest-path rule, which changes native output for families that span folders?
   - **Status: engineering decision, 24 Sep 2026, the owner may overrule.** Today's breadth-first-first member stays the winner (P4-2a), so native output does not change. The digest's smallest-path normalisation (DESIGN §16 item 6) is untouched.
10. **Q10 — no legacy fallback above `T_mem`.** A native failure there fails the scan with its reason (P4-14). How does that interact with step 2's open question about the native scan falling back under full CPU load?
    - **Status: engineering proposal, pending the owner.** No legacy fallback in spill or aggregate or above `T_mem` (P4-14): a native failure there fails the scan with its reason. Step 2's question was answered by the owner on 24 Sep 2026 (commit `298d752`, RISKS R56): a native walk's 30 s stall clock counts only time in which the machine had CPU to spare. Under P4-14, a walk that rule cancels above `T_mem` fails the scan with that reason instead of falling back.
11. **Q11 — prune's giant-folder behaviour (R-S10).** Keep it, or stop before a folder whose children would pass `maxNodes` by more than X and mark it `pruned`? That second option is a JSON change only for such folders.
    - **Status: engineering decision, 24 Sep 2026, the owner may overrule.** Phase 4 keeps today's behaviour: `select_prune` reproduces `pruneStore` exactly, every child of a popped folder included (§S.5.5), so no JSON changes. R-S10 (RISKS R82) stays open, and the gate's big-listing variant keeps that folder small in bytes.
12. **Q12 — aggregate's weaker lists.** Is `exact:false` with a reason acceptable, rather than refusing the list?
    - **Status: engineering decision, 24 Sep 2026, the owner may overrule.** An aggregate answer the seal cannot prove exact carries `exact: false` with the reason instead of being refused (P4-16). In spill such an answer is recomputed (§S.5.6).
13. **Q13 — Windows timing.** Must Windows large mode (T20) land inside Phase 4? The DoD's "Tier C" wording implies it does.
    - **Status: engineering proposal, pending the owner.** Windows large mode (T20) lands inside Phase 4, proven at CI-fixture scale on the Windows leg.
14. **Q14 — which shapes gate.** Does the developer shape (15% folders) gate, with the wide, dirheavy, links, windows and candidates variants gated too? Or should some only be recorded?
    - **Status: engineering decision, 24 Sep 2026, the owner may overrule.** The developer shape gates, and so does every §S.8 variant.
15. **Q15 — the storage endpoint.** Is a separate `/api/scan/:id/storage` acceptable, so the `sseComplete` golden stays unchanged?
    - **Status: engineering decision, 24 Sep 2026, the owner may overrule.** A separate `GET /api/scan/:id/storage`, so the `sseComplete` golden stays unchanged (§S.6.5).

#### S.12 Where each judge's fatal flaw went

| Flaw (design it was found in) | Resolution here |
| --- | --- |
| Unknown projection fills about 400 MB of anonymous columns before converting to aggregate (memory-first) | Byte guard `M_agg` with a dual-fed AggregateState, so conversion is only an unmap; an auto-mode gate leg with spill refused (§S.1.4, §S.8) |
| Listings of 4k–256k entries are uncapped in the working set (memory-first) | Big-listing semaphore at 16,384 entries, chunked commit, counted in the budget (§S.1.2, §S.3) |
| The resident aggregate tier's 16 MiB link-log cap silently double-counts (memory-first) | No resident-only tier. The log goes to disk runs everywhere, or the scan is refused (§S.6.3) |
| Production memory path replaced in one move (memory-first) | T2's batteries and native golden legs first, T4's digest lock, numbering behind a flag, and the oracles kept (§S.2, T2–T10) |
| §3.1 `unlink` never raised (memory-first) | Q1, with a no-`unlink` fallback (§S.5.3). **24 Sep 2026 (T0):** Q1 is pending the owner, and the fallback stays designed until the owner answers |
| `never_descend` spill folder offered to Empty Folders (minimal, memory-first) | Not in `never_descend`; `pathGuard` and a view skip (§S.5.3) |
| Aggregate file-types ties alphabetical (memory-first) | First-seen pre-order from position paths, exact (§S.6.1) |
| Synchronous `pread` in `NativeScanStore` on Electron's main thread; a second store class (memory-first) | Main thread uses `PackedScanStore` and `AsyncTask`s only; `NativeScanStore` is worker-only and fuzz-checked (P4-12, §S.5.7) |
| Sequencer head-of-line blocking (memory-first) | No Sequencer; the commit lock, with memory-mode writes outside it (§S.1.2) |
| Aggregate budget rests on a 100k prune cap and an unmeasured B0 (minimal) | Budget at the measured B0 of 141 MB and the full 250k transport (§S.3) |
| Link log resident at κ = 1% (minimal) | Disk runs past 32 MiB, and a κ = 10% gate variant |
| Memory mode stays at about 234 B/node, `T_mem` ≈ 2.5M (minimal) | MemorySink at 64 B/node: 5M ≈ 614 MB |
| Hard-linked files held out of `/large-files` (minimal) | Family-deduplicated heap entries with an online winner (§S.6.1) |
| Heaps chosen before corrections (minimal) | The Δ exactness check; spill recomputes, aggregate flags (§S.6.4) |
| The 2·`T_mem` rerun stacks retained memory (minimal) | No reruns; anonymous memory and conversions during the walk |
| Spill turns most features off (minimal) | The FullPassRunner (§S.5.7) |
| Windows deferred (minimal) | T20 inside Phase 4, exact or refused |
| Inode projection overshoot (minimal) | The inode count is a hint only, plus load-back (§S.1.1, §S.1.4) |
| `MAP_PRIVATE` views swept by whole-index consumers; answers falling back to `eachFile` (correctness-first) | Nothing mapped; the large modes are read-only, so answers never go stale |
| No spill in the desktop app; the 10M row unmet (correctness-first) | Spill in both runtimes; 10M in spill ≈ 543 MB |
| u128 totals in memory mode (correctness-first) | Memory mode keeps `sumSizes`, bit-identical by Lemma 2 |
| A read after release returns `undefined` (correctness-first) | An explicit released flag in every accessor |
| Aggregate needs a disk scratch; the walk tied to Node's decisions; 6 ms copies on the main thread (correctness-first) | Aggregate needs disk only for the log; Node decisions are asynchronous and per distinct suffix; the copy runs as an `AsyncTask` |

### Phase gate
* `synthetic100m`: peak RSS ≤ 1.5 GB in `spill`, ≤ 400 MB in `aggregate`; the treemap, dashboard and largest-files views answer within their existing budgets against it (measured through the API in the bench child, not the browser).
* A 5M-projected real scan (enum1m plus the corpus scaled, or the synthetic at 5M) stays under 700 MB in `memory`.
* Every equivalence digest of Phase 3 unchanged (the Rust build is the ingest's twin).
* Full gate as always.
