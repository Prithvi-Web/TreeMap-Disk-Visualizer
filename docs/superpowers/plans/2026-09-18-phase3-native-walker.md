# Phase 3 — The native walker: macOS first, then Windows, then Linux

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Progress (kept current so a context compaction loses nothing)

| Task | State | Evidence |
| --- | --- | --- |
| Plan written | 18 Sep 2026 | this file |
| W1 `tm-walk` on macOS (bulk listing, walk, refusals, governor hooks) | **done** — 56 tests (17 scripted on a fake lister, 9 live on a macOS fixture, 21 parser/probe, 9 climb), 22 mutants red, one guard recorded as shadowed; `libc` 0.2.189 lacks `ATTR_CMN_ERROR`/`SF_DATALESS`/vtype values (declared locally); APFS reports no link count for directories on the bulk path (the per-entry path now agrees); debug-build bulk 526–541k entries/s vs per-entry 801–919k on a flat 5,000-file directory — a debug artefact, the release number is W3's to measure | `crates/tm-walk/**` |
| W2 scan API in `tm-node`, `nativeEngine.ts`, selection, stats, settings, golden re-record | in flight | |
| W3 canonical digest, edge-case fixture, equivalence and fallback tests (the bench `native` engine choice moved to W2) | in flight | |
| W4 Windows listing (`FileIdExtdDirectoryInfo`, `FindFirstFileExW` fallback, long paths) | not started — live proof only on CI | |
| W5 Linux listing (`getdents64` + `statx`) | not started — live proof only on CI | |
| W6 Windows MFT turbo (D7, opt-in, elevated helper, cross-check) | not started — last; may ship disabled with the reason recorded | |
| Gate | not run | `npm run bench -- enumerate --engine=native` on ci20k / enum200k / enum1m; equivalence digests; governor bands |

**Goal:** a Rust walker that lists a directory in one system call per directory, feeds the existing store, and is selected automatically when it can be at least as correct as the legacy walker — with the legacy chain untouched behind it and every reason for a fallback visible in `GET /api/scan/:id/stats`.

**Architecture:** `tm-walk` (new crate) owns the platform listing and the walk; the walk runs on the crate's own std threads, obeys `tm-governor` (throttle, worker limit, pause) and produces columnar output. `tm-node` exposes `scanStart / scanPoll / scanPause / scanResume / scanCancel / scanTake / scanProbe`. On the Node side `src/services/scan/nativeEngine.ts` polls the handle at the SSE cadence, then ingests the columns into the same `PackedScanStore` every engine writes today, through the same `NodeInput` path, so the JSON the app emits is identical by construction. Everything downstream (finalize, sumSizes, prune, snapshots, the mtime cache, duplicates) is unchanged.

**Tech stack:** Rust 1.97 (`libc` 0.2.189 for macOS/Linux, `windows-sys` 0.61.2 for Windows — both already in `native/treemap-core/Cargo.lock`; **no new crate** in this phase: the work queue is `std::sync::{Mutex, Condvar}`, hashing for the digest is Node's `crypto`), napi 3.4, TypeScript strict, node:test via tsx, the Phase 1 harness.

**House rules that bind every task** (unchanged from Phase 2): test first and watch it fail; one recorded mutant per new behaviour; `cargo fmt` clean and `cargo clippy --workspace --all-targets -- -D warnings` clean; every `unsafe` block carries a `// SAFETY:` comment; no `unwrap`/`expect`/`panic`/indexing in shipped code (the lint set denies them — use `get()`, `checked_*`, `?`); Windows and Linux paths compile-checked with `cargo check --target x86_64-pc-windows-msvc` and `--target x86_64-unknown-linux-gnu`; never run the whole Node suite — only your own test files; Rust workers use their own `CARGO_TARGET_DIR` under the session scratchpad; never touch the owner's real folders (every fixture lives under `os.tmpdir()`, every scan in a test targets a fixture); the app never prints a number it did not measure; nothing is downloaded.

---

## Decisions fixed by this plan (each is also recorded in `docs/engine/DESIGN.md` when the task lands)

| # | Decision | Why |
| --- | --- | --- |
| P3-1 | **Progress by polling, not a `ThreadsafeFunction`.** Node polls `scanPoll(handle)` at the SSE cadence (150 ms); atomics on the Rust side. | The SSE loop already polls; one fewer cross-thread mechanism to get wrong. DESIGN §4.2 is amended. |
| P3-2 | **Ingest into `PackedScanStore` in Node** for this phase; the zero-copy `NativeScanStore` over the arena is Phase 4's, with spill and aggregate modes. | Byte-identical JSON by construction; the per-entry Node cost is a typed-array read and one `addNode`, no syscall, no promise. |
| P3-3 | **Mount boundaries: the never-descend list only**, exactly as the legacy walker (`src/utils/mountBoundaries.ts`); device ids are recorded for hard-link keys but never gate descent. | The equivalence gate is absolute; a device rule would diverge on firmlinks and nested mounts. A device-boundary setting for both engines is a Phase 8 question. |
| P3-4 | **Not eligible for the native engine** (legacy walker with `engineReason`): an incremental scan (the mtime cache belongs to the walker until Phase 4's index), a non-empty ignore list (the glob dialect lives in `src/utils/glob.ts`; re-implementing it in Rust is a divergence risk), a root that is not a directory, a forced engine setting other than `auto`/`native`. | Never degrade to a broken state; every reason is a sentence in the stats. |
| P3-5 | **atime is collected** by the native walker on macOS (`ATTR_CMN_ACCTIME`, same buffer) and Linux (`STATX_ATIME`); Windows reports `LastAccessTime` from the same record. | The "last used" fact and the JSON depend on `accessedAt`; DESIGN §16 item 4 is withdrawn. |
| P3-6 | **mtime/atime arithmetic mirrors Node exactly:** `ms = (sec as f64) * 1e3 + (nsec as f64) / 1e6`, then the ingest does `Math.round` in JavaScript as `statToInput` does. Rust never rounds. | Identical doubles → identical `modifiedAt`. |
| P3-7 | **Sizes and allocation cross the boundary as `Float64Array`** (exact to 2^53), `dev` and `ino` as doubles too — Node's own `Stats` uses doubles, so the hard-link key `${dev}:${ino}` is the legacy key exactly. | Legacy-identical keys; no BigInt in the hot loop. |
| P3-8 | **The canonical digest sorts a directory's children by name bytes and assigns a hard-link family's bytes to the family's lexicographically smallest path** before hashing. Both are normalisations of order-dependent facts (listing order and "first path seen"), listed in DESIGN §16, and nothing else is normalised. | Two legacy runs are not byte-identical to each other on those two points; the assertion is not loosened, it is made well-defined. |
| P3-9 | **Windows and Linux are proven only on CI** (no such machine here): parsers are unit-tested on synthetic buffers everywhere; the live equivalence suite runs natively on each CI leg. Until W4/W5 land, the native engine on those platforms reports `fastPath: 'unavailable'` with the reason and the legacy chain runs. | The rule "one platform at a time, each behind the probe". |
| P3-10 | **MFT turbo mode (D7)** is built last as an opt-in setting with an elevated read-only helper and the 1,000-entry cross-check; if it cannot be verified end to end on CI it ships disabled with `engineReason` saying so — never enabled on a claim. | The prompt's own rule: cross-check or disable. |
| P3-11 | Progress counters cross as plain numbers; the sample path at most every 50 ms; the SSE frame shape does not change. | §11.1 backward compatibility. |

---

## Fixed interfaces

### `tm-walk` (Rust)

```rust
pub struct WalkOptions {
    pub root: PathBuf,
    /// Absolute paths the walk never descends into (the legacy list, passed from Node).
    pub never_descend: Vec<PathBuf>,
    pub want_atime: bool,
    /// 0 = let the hill-climber decide, bounded by the governor's worker limit.
    pub max_workers: usize,
    /// Bytes per worker listing buffer (default 256 KiB; the harness decides).
    pub buffer_bytes: usize,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FastPath { Bulk, ExtdDirInfo, Getdents, PerEntry, Unavailable }

pub struct Probe { pub fast_path: FastPath, pub reason: String }
pub fn probe(root: &Path) -> Probe;                 // opens and lists the root once; no side effects

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Refusal { Denied = 1, Vanished = 2, Unreadable = 3 }

pub const KIND_FILE: u8 = 0;    // regular file, socket, fifo, device: a leaf with its lstat size
pub const KIND_DIR: u8 = 1;
pub const KIND_SYMLINK: u8 = 2; // never followed; size = length of the target
pub const FLAG_DATALESS: u8 = 1;      // SF_DATALESS / RECALL_ON_DATA_ACCESS / OFFLINE / cloud reparse tag
pub const FLAG_REFUSED_DIR: u8 = 2;   // a directory that could not be listed (see refusals)

pub struct HardlinkRef { pub node: u32, pub dev: f64, pub ino: f64 }
pub struct DirRefusal { pub node: u32, pub why: Refusal }

pub struct WalkStats {
    pub dirs_listed: u64, pub entries: u64, pub wall_ms: f64,
    /// Sum of the walker threads' own CPU time (CLOCK_THREAD_CPUTIME_ID / GetThreadTimes), the engine's own measurement.
    pub cpu_seconds: f64,
    pub fast_path: FastPath, pub workers_peak: u32, pub climb_steps: u32,
    pub denied_entries: u64, pub unreadable_entries: u64, pub dataless: u64,
}

/// Columns in discovery order; index 0 is the root; parent[i] < i for every i > 0.
pub struct WalkOutput {
    pub parent: Vec<u32>, pub name_off: Vec<u32> /* len+1 */, pub names: Vec<u8>,
    pub kind: Vec<u8>, pub flags: Vec<u8>,
    pub size: Vec<f64>, pub alloc_bytes: Vec<f64>,
    pub mtime_ms: Vec<f64>, pub atime_ms: Vec<f64> /* NaN = not recorded */,
    pub hardlinks: Vec<HardlinkRef>, pub refusals: Vec<DirRefusal>,
    pub stats: WalkStats,
}

pub struct Progress { pub entries: u64, pub dirs: u64, pub files: u64, pub bytes: u64, pub current_path: Option<String>, pub done: bool }

pub struct WalkHandle;               // Send + Sync; cheap to clone the shared state through Arc
impl WalkHandle {
    pub fn progress(&self) -> Progress;
    pub fn pause(&self); pub fn resume(&self); pub fn cancel(&self);
    pub fn take(self) -> Result<WalkOutput, WalkError>;   // blocks until done; Err(Cancelled) after cancel
}
pub fn start(opts: WalkOptions, governor: Arc<tm_governor::Governor>) -> Result<WalkHandle, WalkError>;
pub enum WalkError { RootNotDirectory, RootRefused(Refusal), Unsupported(String), Cancelled, Internal(String) }
```

Behavioural contract (each line is a test): symlinks are never followed and are leaves with the link's own size; sockets/fifos/devices are leaves; a directory that cannot be listed is a node with `FLAG_REFUSED_DIR` and a `DirRefusal` (`EACCES`/`EPERM` → Denied, `ENOENT`/`ENOTDIR` → Vanished, everything else → Unreadable), the walk continues; an entry whose metadata cannot be read is counted in `denied_entries`/`unreadable_entries` and omitted; `never_descend` paths become childless directory nodes with their own metadata; names are the OS bytes decoded as Node decodes them (UTF-8 with U+FFFD per maximal subpart — `String::from_utf8_lossy`); the root vanishing after start is `WalkError::RootRefused(Vanished)`; cancel returns within 200 ms on a warm 20k-entry tree; pause stops `entries` from advancing within 200 ms and resume continues without re-listing; every worker calls `governor.throttle()` after each directory and re-reads `governor.worker_limit()` between directories; the hill-climber starts at 2 workers, re-evaluates every 250 ms against entries/s with a 5 % noise floor, never exceeds the governor's limit, and records `climb_steps`; `ATTR_CMN_RETURNED_ATTRS` is honoured per entry (an attribute the file system withheld leaves the column at its "unknown" value — size 0, alloc 0, mtime NaN — and increments `unreadable_entries` rather than parsing garbage); the bulk buffer is allocated once per worker and reused.

### `tm-node` (napi) — additions to the module surface, declared in `native/index.d.ts`

```ts
scanProbe(root: string): { fastPath: 'bulk' | 'extdDirInfo' | 'getdents' | 'perEntry' | 'unavailable'; reason: string };
scanStart(root: string, opts: { neverDescend: string[]; wantAtime: boolean; maxWorkers?: number; bufferBytes?: number }): number;   // handle
scanPoll(handle: number): { done: boolean; error: string | null; entries: number; dirs: number; files: number; bytes: number; currentPath: string | null };
scanPause(handle: number): void; scanResume(handle: number): void; scanCancel(handle: number): void;
scanTake(handle: number): WalkResult;   // throws with a plain-English message when the walk failed or was cancelled; frees the handle
interface WalkResult {
  parent: Uint32Array; nameOff: Uint32Array; names: Uint8Array; kind: Uint8Array; flags: Uint8Array;
  size: Float64Array; allocBytes: Float64Array; mtimeMs: Float64Array; atimeMs: Float64Array;
  hardlinkNode: Uint32Array; hardlinkDev: Float64Array; hardlinkIno: Float64Array;
  refusalNode: Uint32Array; refusalWhy: Uint8Array;
  stats: { dirsListed: number; entries: number; wallMs: number; cpuSeconds: number; fastPath: string; workersPeak: number; climbSteps: number; deniedEntries: number; unreadableEntries: number; dataless: number };
}
```

Typed arrays are created from the Rust `Vec`s without copying (napi external typed arrays, freed when JS drops them). A handle that is never taken is freed when the process exits; `scanTake` on an unknown handle throws.

### Node

* `src/services/scan/nativeEngine.ts`: `nativeEligibility(rootPath, opts: { incremental: boolean; ignoreCount: number; forced: EngineSetting }): { ok: true; fastPath: string } | { ok: false; reason: string }` (pure, unit-tested); `runNativeWalk(scan: ScanResult, store: ScanStore, rootPath: string): Promise<void>` (start → poll → ingest; honours `scan.cancelled`, the pause gate, and updates `scan.scanned`/`scan.currentPath`); `ingestColumns(scan, store, cols: WalkResult, rootPath): void` (pure over the columns: `statToInput` semantics for every node — hidden = dot prefix, extension from `path.extname`, container kind, cloud placeholder = `size > 0 && allocBytes === 0 && cloudProviderFor(path)` (the path built only for those entries), hard-link dedup in id order, sparse/slack tallies with the legacy signed delta, `gitRepo` when a child is named `.git`, refusals into `deniedDirs`/`deniedExamples`/`vanishedDirs`/`unreadableDirs`, `deniedEntries`/`unreadableEntries`, `cloudFiles/Bytes`, `fileCount`/`dirCount`).
* `src/services/diskScanner.ts` `startScan`: selection order **forced setting → native (eligible and probe ok) → gdu (as today) → walker**; `ScanResult` gains `engineReason: string`, `fastPath: string`, `fallbackReason: string | null`, `cpuSeconds: number | null`, `bytesRead: number | null`, `peakRssBytes: null`, `placeholdersSkipped: number`; `engine` union gains `'native'`.
* `buildScanStats` appends, after `budget` and in this order: `engineReason`, `fastPath`, `fallbackReason`, `entriesPerSecond` (scanned / seconds, `null` while running), `cpuSeconds`, `peakRssBytes` (`null`: "resident memory is a per-process figure and cannot be attributed to one scan"), `bytesRead` (`null` unless the platform counter exists and no other scan overlapped), `cacheHitRate` (`null` until Phase 4), `storageMode: 'memory'`, `placeholdersSkipped`. `openapi.ts` grows by the same keys with the same required-ness; `tests/fixtures/golden/responses.json` is re-recorded in the same commit (D6), with the normaliser mapping machine facts (`fastPath`, `entriesPerSecond`, `cpuSeconds`, `bytesRead`, `engineReason`) to placeholders exactly as it does for `budget`.
* Settings: `engine: 'auto' | 'native' | 'gdu' | 'walker'` (default `auto`), normalised, validated at `PUT /api/settings` (400 `BAD_SETTING`), shown in Settings as "Scan engine" with one plain line per choice; `tests/engineBudgetUi.test.ts` style tests for the row.
* Bench: `EngineChoice` gains `'native'`; the child forces it through the settings file it already writes; a run whose scan did not report `engine: 'native'` is refused as today.

### Canonical digest (`tests/fixtures/canonicalTree.ts`, also exported for `bench/`)

For a store: visit from the root; at each directory sort live children by `Buffer.from(name)` byte order; emit one line per node `depth \t name \t type \t size \t modifiedAt \t accessedAt \t flags(bits: hidden,symlink,hardlinkDup,cloudPlaceholder,gitRepo) \t extension \t container \t cloudProvider`; hard-link normalisation first: for each `${dev}:${ino}` family (the test knows the families from the fixture/manifest), the bytes belong to the smallest path and every other member has `size 0, hardlinkDup`. SHA-256 over the lines. Also compare the eleven stats counters (`fileCount, dirCount, hardlinkedFiles, hardlinkedBytes, sparseFiles, sparseBytes, slackBytes, cloudFiles, cloudBytes, deniedDirs, vanishedDirs`). On mismatch the test prints the first differing line of each side.

---

## Tasks

### W1: `tm-walk` on macOS (Rust)

**Files:** Create `native/treemap-core/crates/tm-walk/{Cargo.toml,src/lib.rs,src/output.rs,src/queue.rs,src/climb.rs,src/walk.rs,src/platform/mod.rs,src/platform/darwin.rs,src/platform/unsupported.rs,src/platform/per_entry.rs}`, `tests/{walk.rs,darwin.rs,climb.rs}`; Modify workspace `Cargo.toml` (`members += "crates/tm-walk"`), `crates/tm-node/Cargo.toml` (dependency, not yet used).

- [ ] Step 1: failing tests — `tests/walk.rs` builds a fixture under `std::env::temp_dir()` (directories, files of known sizes, a symlink to a file, a broken symlink, a symlink loop, a hard-linked pair, an `ftruncate`d sparse file, a zero-byte file, a name with a newline/tab/emoji, a `chmod 000` directory (skipped as root), a `never_descend` entry) and asserts every line of the behavioural contract; `tests/climb.rs` drives the hill-climber with a fake clock and a fake entries/s series; `tests/darwin.rs` (cfg darwin) asserts `probe()` reports `Bulk` on the temp dir, `PerEntry` with a reason on a directory whose `getattrlistbulk` is refused (simulate through the platform trait's fake), and that `ATTR_CMN_RETURNED_ATTRS` handling drops a withheld attribute (a fake bulk reply with a short attribute set).
- [ ] Step 2: run → fail (`E0432`).
- [ ] Step 3: implement. `darwin.rs`: `open(O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)`, `getattrlistbulk` loop with `ATTR_BIT_MAP_COUNT`, request set `RETURNED_ATTRS | ERROR | NAME | DEVID | OBJTYPE | MODTIME | ACCTIME(opt) | FLAGS | FILEID` + `FILE_LINKCOUNT | FILE_ALLOCSIZE | FILE_DATALENGTH`, parse each entry through `returned` masks, `SF_DATALESS` in flags → `FLAG_DATALESS`, `ENOTSUP`/`EINVAL` → the per-entry fallback (`fdopendir`/`readdir_r` → `fstatat(AT_SYMLINK_NOFOLLOW)`). `walk.rs`: shared `Mutex<VecDeque<DirJob>> + Condvar`, workers as `std::thread` with `tm_governor::apply_to_current_thread(preset)` at start, per-worker reusable buffer, per-worker name arena merged at the end in index order (ids assigned by an atomic counter at discovery: parent < child holds because a directory is listed only after it was assigned), `climb.rs` as a pure state machine, `governor.throttle()` after each directory, `worker_limit()` re-read between directories, pause/cancel atomics, per-thread CPU via `clock_gettime(CLOCK_THREAD_CPUTIME_ID)`. `unsupported.rs`: `probe` → `Unavailable` with "the native listing is not built for <os> yet"; `start` → `WalkError::Unsupported`. Every unsafe call carries `// SAFETY:`.
- [ ] Step 4: run → pass; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo check` on both cross targets (the crate compiles with the unsupported platform there).
- [ ] Step 5: mutants (each recorded, each restored): (a) a symlink is followed → red; (b) `RETURNED_ATTRS` ignored → red on the withheld-attribute test; (c) refusal classification `EACCES → Vanished` → red; (d) throttle call removed → red on a governor test that scripts a fake governor and counts calls; (e) the hill-climber ignores the governor limit → red.
- [ ] Step 6: commit `native(walk): the macOS bulk listing and the walk, behind the probe, with the legacy's refusal accounting`.

### W2: the scan API, the Node engine, selection and stats (Rust + TypeScript)

**Files:** Modify `crates/tm-node/src/lib.rs`, `native/index.d.ts`, `native/README.md`; Create `src/services/scan/nativeEngine.ts`, `tests/nativeEngine.test.ts`; Modify `src/services/diskScanner.ts`, `src/models/types.ts`, `src/api/scanRoutes.ts`, `src/api/openapi.ts`, `src/services/settings.ts`, `src/api/settingsRoutes.ts`, `src/ui/markup/110-modal-settings.html`, `src/ui/app/235-settings-modal.js`, `src/ui/app/045-persistent-live-index.js` (engine note gains the reason on hover), `tests/fixtures/golden/responses.json` (re-record), `tests/fixtures/goldenHarness.ts`, `tests/discoverability.test.ts` if a key list is pinned, `tests/engineBudgetUi.test.ts` (or a new `tests/engineSettingUi.test.ts`).

- [ ] Step 1: failing tests — `tests/nativeEngine.test.ts`: `nativeEligibility` table (incremental → reason; ignore list → reason; forced `gdu` → reason; forced `native` on an unsupported platform → the probe's reason; `auto` on macOS with the module → ok); `ingestColumns` on hand-built columns produces a store whose pruned JSON equals the store the legacy `startScan` produced on the same fixture (byte-identical `JSON.stringify`), including hard links, a sparse file, a cloud-placeholder path under a fake `~/Library/Mobile Documents` (the regex is what matters), `.git`, a refused directory; `startScan` on a fixture with the module present reports `engine: 'native'`, `fastPath: 'bulk'`, `engineReason`, `fallbackReason: null`, and the same `buildScanStats` counters as the walker; with `TREEMAP_NATIVE_MODULE=/nonexistent` the same scan reports `engine: 'walker'|'turbo-walker'` with a `fallbackReason` naming the path, and completes correctly (the prompt's "legacy fallback verified"); `POST /api/scan/:id/pause` on a native scan stops `scanned` within 200 ms; cancel releases the handle. Settings tests: `engine` normalised/validated; the Settings row renders and saves.
- [ ] Step 2: run → fail. Step 3: implement (the interfaces above). Step 4: run → pass; `npm run typecheck`; `node scripts/build-ui.js` and its `--check`; the golden re-record with the structural diff stated in the commit message.
- [ ] Step 5: mutants: the ingest skips `hardlinkDuplicate` → red on the byte-identity test; the selection ignores the forced setting → red; `fallbackReason` dropped → red; `entriesPerSecond` computed while running → red.
- [ ] Step 6: commit `feat(engine): the native walker is selected when it can be as correct as the legacy one, and every fallback names its reason`.

### W3: the correctness gate (TypeScript)

**Files:** Create `tests/fixtures/canonicalTree.ts`, `tests/fixtures/edgeCases.ts`, `tests/nativeEquivalence.test.ts`, `tests/edgeCases.test.ts`; Modify `bench/lib/measureWorker.ts`, `bench/lib/suites.ts`, `bench/run.ts`, `bench/README.md`, `docs/engine/DESIGN.md` (§4.2, §5, §16, the vendored-code sentence in §4 removed per D3).

- [ ] Step 1: failing tests — `canonicalTree` is order-independent (two stores with reversed child order digest equal; a one-byte size change does not); `edgeCases` builds every case from the prompt's §12.2 that this OS can build (each case is a named function; a case the OS cannot build is *skipped with its reason in the diagnostic*, never silently omitted): symlink to file / broken / circular, hard links (a family of three), sparse (`ftruncate`) and a sparse file over 4 GiB, zero-byte, names with newline, tab, emoji, an NFC/NFD pair (macOS: the file system may fold them — the test records what happened), a case-collision pair (only where the FS is case-sensitive), a 300-character path, a permission-denied directory (chmod 000; skipped as root), a nested mount (macOS: `hdiutil create … -type SPARSE` + `hdiutil attach -mountpoint <fixture>/mnt`, detached in cleanup; skipped when hdiutil is absent or refuses) and a read-only mount (`-readonly`); `nativeEquivalence` runs the legacy walker and the native engine on `smoke`, `ci20k` (from `bench/lib/corpus.ts`) and the edge fixture and asserts equal digests and equal counters; on a platform where the native probe is unavailable the test asserts the fallback reason and marks itself skipped with that reason; the fallback test from W2 is reused here for the "forced load failure" case.
- [ ] Step 2: run → fail. Step 3: implement (bench: `native` engine choice; the child forces `engine: 'native'`; refusal when `scan.engine !== 'native'`). Step 4: run → pass on macOS; on the cross platforms the skips carry reasons.
- [ ] Step 5: mutants: the digest ignores `hardlinkDup` → red; a planted difference in the native ingest (drop `isSymlink`) → red on equivalence.
- [ ] Step 6: commit `test(engine): the equivalence gate — every corpus and every edge case digests identically on both engines`.
- [ ] Step 7: **the measurement**: `npm run bench -- enumerate --corpus=ci20k --engine=native --runs=7 --cache=warm --record`, then `enum200k` (5 runs), then `enum1m` (5 runs, mixed cache as recorded for the legacy), on a quiet machine; `npm run bench -- compare` against the Phase 1 baselines; the numbers go into `docs/engine/CURRENT-STATE.md` §11 and the check-in exactly as printed, with the tier and cache state.

### W4: Windows listing (Rust; live proof on CI)

**Files:** Create `crates/tm-walk/src/platform/windows.rs`, `tests/windows_parse.rs` (runs everywhere: parses synthetic `FILE_ID_EXTD_DIR_INFO` buffers); Modify `platform/mod.rs`.

- [ ] Tests first: the synthetic-buffer parser (name, attributes, `EndOfFile`, `AllocationSize`, `FileId`, times as 100-ns FILETIME → `ms = (ft - 116444736000000000) / 10_000` in f64, the same formula Node uses; `ReparseTag` → symlink/junction leaf; `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | OFFLINE | RECALL_ON_OPEN` or a cloud reparse tag → `FLAG_DATALESS`). Implement `CreateFileW(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)` on a `\\?\` path, `GetFileInformationByHandleEx(FileIdExtdDirectoryInfo / FileIdExtdDirectoryRestartInfo)` with a 256 KiB buffer, `ERROR_NO_MORE_FILES` ends, `ERROR_ACCESS_DENIED` → Denied, `ERROR_FILE_NOT_FOUND`/`PATH_NOT_FOUND` → Vanished; fallback `FindFirstFileExW(FindExInfoBasic, FIND_FIRST_EX_LARGE_FETCH)`; hard-link key from `FileId` + volume serial (`GetFileInformationByHandle` on the directory handle, once per volume); `cargo check --target x86_64-pc-windows-msvc` clean; the native probe on Windows reports `extdDirInfo`.
- [ ] Commit `native(walk): the Windows listing behind the probe — proven by the equivalence suite on the Windows CI leg`.

### W5: Linux listing (Rust; live proof on CI)

**Files:** Create `crates/tm-walk/src/platform/linux.rs`, `tests/linux_parse.rs` (synthetic `linux_dirent64` buffers); Modify `platform/mod.rs`.

- [ ] Tests first: the dirent parser (`d_reclen` walking, `d_type` use, a name at the buffer end); `statx(AT_SYMLINK_NOFOLLOW | AT_STATX_DONT_SYNC, STATX_TYPE|MODE|SIZE|BLOCKS|MTIME|ATIME|INO|NLINK)` through `libc::syscall(SYS_statx)`, `stx_mask` honoured like `RETURNED_ATTRS`; `getdents64` with a 256 KiB buffer; `io_uring` is **not** built in this phase (recorded in DESIGN §5 as deferred with the reason: no Linux machine to measure on; the sync path first). `cargo check --target x86_64-unknown-linux-gnu` clean.
- [ ] Commit `native(walk): the Linux listing behind the probe — proven by the equivalence suite on the Linux CI legs`.

### W6: Windows MFT turbo mode (D7) — last

**Files:** Create `crates/tm-walk/src/mft/{mod.rs,record.rs,attribute.rs,runlist.rs}`, `tests/mft_parse.rs` (synthetic records), `crates/tm-mft-helper/` (a tiny read-only binary launched elevated), `electron/mft.js`; Modify settings (`engine: 'ntfs-mft'`), `nativeEngine.ts`.

- [ ] Parser tests on synthetic `FILE` records (fix-ups, `$STANDARD_INFORMATION`, `$FILE_NAME` with the parent reference, `$DATA` resident and non-resident with run lists, sparse/compressed flags), then the volume reader (`\\.\C:` opened `GENERIC_READ | FILE_SHARE_READ | FILE_SHARE_WRITE`, boot sector → MFT start, the `$MFT` run list, sequential 1 MiB reads); refusal on ReFS/FAT/exFAT/network; the elevation prompt is Electron's `shell`-level `runas` of the helper with a one-sentence explanation, the helper writes columns to a temp file the app reads; the cross-check samples 1,000 random entries against `GetFileInformationByHandleEx` and disables the mode on the first mismatch with the reason in `engineReason`; declined elevation is not an error. If the CI Windows leg cannot prove the live path, the mode stays behind the setting with `engineReason: 'not verified on this build'`.
- [ ] Commit `native(walk): NTFS MFT turbo mode, opt-in, read-only, cross-checked`.

### Phase gate

* Equivalence digests identical on every corpus and the edge fixture (macOS here; Windows/Linux on CI).
* `npm run bench -- enumerate --engine=native` recorded on ci20k / enum200k / enum1m with the honest cache state; the Tier B targets (warm Turbo 400–700k entries/s, warm Eco 150–250k, CPU-seconds per million ≤ 3.0 Turbo / ≤ 2.0 Eco) compared in `docs/engine/CURRENT-STATE.md` §11 with every miss stated with its measured figure and reason.
* `npm run bench -- governor` bands still held with the walker running (the three 60 s holds with a live scan as the load).
* Full gate: `npm run typecheck`, `npm test`, `node scripts/build-ui.js --check`, `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, both cross-target checks.
