# The scan engine design (Phase 0)

**Status:** Phase 0 design, 18 September 2026. Built on
[`CURRENT-STATE.md`](CURRENT-STATE.md); risks are in [`RISKS.md`](RISKS.md).
Every number here is either measured (with the source named) or a **budget**
(marked as such). Nothing in this file is a performance claim until
`bench/` reproduces it.

## 0. Decisions in one screen

| # | Decision | Why (short) | Owner's say |
| --- | --- | --- | --- |
| D1 | Build a **native Rust core**, exposed through **napi-rs**, as a new first engine in front of the existing chain | The existing engines both pay one `lstat` per entry (Node through libuv; gdu inside Go) and top out at ~97k and ~129k entries/s here. Listing a directory in one call measured ~683k entries/s on this Mac (§1) | Yes — this is what the prompt asks for; the repo's own platform policy already ranks "a small N-API addon, prebuilt in CI" above a bundled binary |
| D2 | **Keep every existing engine**, unchanged, as the fallback chain (`gdu-turbo` → `walker`) and as the correctness oracle | Prompt rules 3 and 13; the equivalence test needs an oracle | — |
| D3 | **Write the desktop core fresh**, with the TreeMapMobile crates as prior art only (their approach to `getattrlistbulk`, the arena layout and the refusal rules are read, not copied) | The owner decided on 18 September 2026 to keep TreeMap Desktop and TreeMap Mobile separate for now; the desktop core therefore has no shared source with the phone's and each repository stands on its own. The cost is re-implementing what the mobile core proved; the benefit is two codebases that can be reviewed, released and fixed independently | **Decided: separate** (§3) |
| D4 | The **resource governor lands before the walker** (Phase 2), in Rust, with a Node-side shim so the legacy engines obey the preset as far as they can | Prompt Section 8; retrofitting never holds a budget | — |
| D5 | Offload and Time Capsule **keep SHA-256**; BLAKE3 is used only for duplicate detection | The on-disk catalogs record no algorithm name; changing them is a migration this project does not need | — |
| D6 | The stats response gains additive keys, the golden fixture is re-recorded once, and the OpenAPI schema grows with it | Prompt Section 11.2 asks for exactly this; the lock exists to make such a change deliberate | **Approved** 18 Sep 2026 (§12) |
| D7 | Windows **MFT turbo mode** may be built, strictly opt-in behind an elevation prompt that explains why | Prompt Section 15: ask before anything that needs elevated privileges | **Approved** 18 Sep 2026, for Phase 3's Windows leg (§9.2) |
| D8 | The deep image tier may add its two backend npm dependencies and download its model on explicit consent; it stays off and invisible until a user opts in | Prompt Section 15: ask before adding a runtime dependency; Section 3.4 consent | **Approved** 18 Sep 2026, for Phase 7 (§11.1) |
| D9 | Work lands on `main` in small commits, one phase at a time, as every TreeMap session has; the owner pushes | The owner's standing workflow; the prompt's "branch per phase" was offered as the alternative | **Decided: `main`**, 18 Sep 2026; since 23 Sep 2026 the agent pushes each fully gated step itself (the owner’s word), and the owner alone publishes a release |
| D10 | Rust crates from crates.io may be added for Phases 5–8 (BLAKE3 for the duplicate digests, an image decoder and DCT for the fast near-duplicate tier, an embedded key–value store for the digest and signature caches), each pinned in `Cargo.lock`, built by CI only, never needed by an end user | The owner's word on 21 September 2026: "Rust crates is a part of coding"; the prompt's §15 ask-before rule for dependencies is therefore answered for the Rust side; a frontend dependency remains forbidden and a runtime npm dependency still needs its own ask (D8 covers the deep tier's two) | **Approved** 21 Sep 2026, for Phases 5–8 |

## 1. Why a native core, with the numbers that force it

The whole speed-up is one idea: **stop paying a system call per entry.**

| Path | How it lists a directory | Measured on this Mac | Ceiling and why |
| --- | --- | --- | --- |
| Node walker | `readdir` + one `lstat` per entry, each a libuv job + a JS callback + an object | 69k–97k entries/s (`gduScanner.ts:17-19`) | Threadpool and kernel metadata-lock contention; 16 threads measured 1.6× four, 32 slower than four. Already tuned to its limit |
| gdu (default today) | `readdir` + one `lstat` per entry inside Go, parallel goroutines, then a JSON file the Node side parses whole | 112k–129k entries/s (`gduScanner.ts:17-30`); 27k/s end to end on a 50k tree today (bench-v4, fixed overhead) | Per-entry `lstat` again, plus a JSON round trip at 79 B/node and a 450 MB shard ceiling |
| `getattrlistbulk(2)` in Rust (TreeMapMobile `tm-scan`, release profile) | One call per directory returns every entry's name, type, size, allocation, mtime, flags, inode, device and link count | **200,000 files in 292.7 ms ≈ 683k entries/s** warm; 1,000,000 files in 25.7 s ≈ 39k/s once the tree exceeds the vnode cache; the same 200k tree cold: 8.76 s (`TreeMapMobile/docs/audits/phase-b/perf-before-after-table.md`) | The APFS catalog. `kern.maxvnodes = 251,127` here, so beyond ~250k entries every scan reads catalog B-tree nodes from disk |

Three honest consequences:

1. **Tier B warm-cache target (400k–700k entries/s) is reachable on this Mac for trees that fit the vnode cache**, on the evidence of the sibling crate. Nothing above that has been measured on the desktop yet; Phase 1 measures it before Phase 3 claims it.
2. **"Warm cache at 1M entries" is not a state a default macOS install can be in.** The prompt's 1M-per-second headline is a warm-cache number; on macOS the warm set is ~250k entries. Above that, throughput is bounded by catalog I/O and the honest figure is the cold or mixed one. The README will say so in plain words, as the prompt itself demands (Section 5.2).
3. **Pure Node cannot get there.** Node has no `getattrlistbulk`, no `NtQueryDirectoryFile`, no `getdents64`, no `statx`; `fs.readdir({ withFileTypes })` gives types but no sizes. Every size costs a syscall through libuv. The July design already measured that ceiling at ~97k/s. Section 4.4 of the prompt asks for a truthful ceiling if native is rejected: it is **about 100k entries/s on this hardware**, and it is why native is accepted.

## 2. Hugging Face, stated plainly

Hugging Face hosts models, not filesystem walkers. No part of the enumeration,
storage, governor or exact-duplicate work comes from Hugging Face, and none
will be described as if it did. The prior art for the walk is native code and
platform syscalls (`jwalk`, `walkdir`, `rayon`, `dust`, `dua-cli`, `fd`,
`gdu`, `diskus`, and the documented MFT technique behind WizTree). Hugging
Face is the right source for exactly one thing: the **optional deep tier of
near-duplicate image detection** (§11.1), where the candidate models are
`apple/MobileCLIP-S0`, `facebook/dinov2-small`, SSCD, and
`Xenova/clip-vit-base-patch16`. That tier is off by default and downloads
nothing without consent.

## 3. The TreeMapMobile core as prior art (D3)

What exists there is inventoried in `CURRENT-STATE.md` §14. The owner's
decision (18 September 2026) is to keep the two apps separate for now, so:

* **No source is copied.** The desktop core lives in `native/treemap-core/`
  with its own crates, tests and lint set; nothing in it depends on, or is
  copied from, the mobile workspace, and the mobile repository is never
  built or modified from here.
* **The mobile core's findings are used as findings.** Its host measurements
  (`CURRENT-STATE.md` §14), its refusal rule ("a refused folder is never an
  empty one"), its two-numbers rule (claimed vs allocated bytes), its
  `getattrlistbulk` attribute list and the review defects it recorded
  (a symlink swapped in mid-walk must never be followed; a throttle must cap
  a scan that asks for the default worker count) are requirements here,
  proven by this repository's own tests.
* **Re-joining later stays possible.** The desktop crates keep the same
  conceptual boundaries (walk, store, hash, image hash, governor, bindings),
  so a future decision to share code is a refactor, not a rewrite.

## 4. Architecture

```
native/
  treemap-core/                 Rust workspace (edition 2024, rust-version 1.97, the mobile lint set)
    crates/
      tm-walk/                  platform listing (darwin bulk, windows ex-dir-info, linux getdents+statx),
                                work-stealing walk, refusal accounting, placeholder flags
      tm-store/                 columnar arena, name interner, mmap spill, BFS finalize, aggregation,
                                aggregate-only mode
      tm-hash/                  BLAKE3 sample + full digests, per-device read scheduling, byte compare
      tm-imghash/               EXIF thumbnail parse, tiny-decode input, pHash/dHash/colour hash, MIH index
      tm-governor/              presets, closed loop, QoS/io-policy/nice per platform, thermal, battery
      tm-node/                  napi-rs bindings — the only crate Node touches
    (no VENDORED.md: nothing is copied from TreeMapMobile — D3, §3; the mobile crates are prior art only.
     Corrected 18 September 2026: this tree once listed a provenance file for vendored crates)
  prebuilt/<platform>-<arch>/treemap_core.node    built by CI, never committed, shipped in the bundle

tests/fixtures/canonicalTree.ts the canonical digest of a store (§5.1, P3-8), pure over ScanStore, shared with bench/

src/services/scan/
  ScanEngine.ts                 the Engine interface, selection order, capability probe, forced-engine setting
  NativeEngine.ts               wraps the napi module; a NativeScanStore implements ScanStore over the arena
  LegacyEngine.ts               the existing diskScanner chain (gdu → walker), untouched, behind the interface
  EngineTelemetry.ts            local-only counters that feed /api/scan/:id/stats
```

### 4.1 Engine selection, in order

1. `settings.engine` forced by the user (`auto` | `native` | `gdu` | `walker`; default `auto`).
2. Try to load `treemap_core.node` for `process.platform`-`process.arch`. Any failure (missing file, wrong architecture, dlopen error, version handshake mismatch) records `fallbackReason` in plain words and moves on.
3. Probe: can the fast listing path open and list the scan root? (`getattrlistbulk` returning `ENOTSUP` on a network or FUSE volume; on Windows a volume that refuses `FileIdExtdDirectoryInfo`; on Linux `getdents64` always works.) A refused probe records `fastPath: 'unavailable'` with the reason and still allows the native walker in its per-entry fallback mode, which is at worst as fast as the legacy walker and keeps refusal accounting.
4. Otherwise `LegacyEngine`, which is today's selection unchanged (gdu if eligible, else the walker).

`GET /api/scan/:id/stats` reports `engine`, `engineReason`, `fastPath`,
`fallbackReason`, `budget`, and the counters of §12. The dashboard's engine
badge reads those and nothing else, so "why was my scan slow" is always
answerable from the UI.

### 4.2 Threading

* The core owns a thread pool sized by the governor (§8), never libuv's. Every napi entry point that can take longer than a millisecond is an `AsyncTask` or returns a promise resolved from the core's threads.
* Progress crosses the boundary through **shared atomic counters** read by a synchronous, sub-microsecond napi getter; the existing SSE endpoint keeps polling at 150 ms and keeps its frame shape. No per-file callback exists. **Amended 18 September 2026 (P3-1):** there is no `ThreadsafeFunction` at all — the SSE loop already polls, so Node polls `scanPoll(handle)` at its 150 ms cadence for the counters, the current path (sampled at most every 50 ms on the Rust side) and completion; one fewer cross-thread mechanism to get wrong. **Amended 23 September 2026:** still polling, never a callback, but every 10 ms after a 1, 2, 4, 8 ms ramp (`NATIVE_POLL_MS`), not at the stream's cadence — the same poll notices completion, and at 100 ms a finished walk sat unnoticed 20–40 ms on a 200,000-entry scan and ~28 ms on a 100 ms one (measured on the M3). The SSE endpoint still reads the record every 150 ms.
* `NativeScanStore` reads the arena through typed-array views over napi external buffers — zero copy — so every existing consumer (`collectLargestFiles`, the treemap routes, missing gigabytes, duplicates) runs unchanged against `ScanStore`.

## 5. The walker (Phase 3)

Platform listing, one call per directory, nothing per file:

| Platform | Call | Buffer | Attributes | Fallback |
| --- | --- | --- | --- | --- |
| macOS | `getattrlistbulk` on an `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` descriptor (written fresh in `tm-walk`, D3 — nothing vendored) | 256 KiB per worker (`DEFAULT_BUFFER_BYTES`); the one-shot probe uses 64 KiB | `RETURNED_ATTRS, ERROR, NAME, DEVID, OBJTYPE, MODTIME, ACCTIME, FLAGS, FILEID` + `LINKCOUNT, ALLOCSIZE, DATALENGTH`, in one buffer (P3-5, 18 September 2026: atime is collected, not optional — the "last used" fact and the JSON depend on `accessedAt`). `ATTR_CMN_RETURNED_ATTRS` is honoured for every entry | `fdopendir` + `fstatat(AT_SYMLINK_NOFOLLOW)` on `ENOTSUP` |
| Windows | `GetFileInformationByHandleEx(FileIdExtdDirectoryInfo)` on a handle opened with `FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT`, `\\?\` prefix, long paths on | 256 KiB | name, attributes, times (`LastAccessTime` included, P3-5), `EndOfFile`, `AllocationSize`, file id, `ReparseTag`; cloud tags and `RECALL_ON_DATA_ACCESS`/`OFFLINE` set the placeholder flag; reparse points are leaves | `FindFirstFileExW(FindExInfoBasic, FIND_FIRST_EX_LARGE_FETCH)` |
| Linux | raw `getdents64` (256 KiB) for names and `d_type`, then `statx(AT_SYMLINK_NOFOLLOW|AT_STATX_DONT_SYNC)` with the minimal mask; `io_uring` batched `statx` behind runtime detection (kernel ≥ 5.6, not blocked by seccomp — design only, not built: §5.2) | 256 KiB | `TYPE, MODE, SIZE, BLOCKS, MTIME, ATIME, INO, NLINK` (`STATX_ATIME` added by P3-5) | synchronous `statx`; FUSE and network mounts are enumerated but flagged read-hostile |

Parallelism: a shared queue of **directories** (as built: a
`std::sync::{Mutex, Condvar}` queue with in-flight accounting, no crate — §5.2),
one worker owns a whole directory batch; per-device queues keyed on the
device id the listing returns (not built — §5.2); **hill-climbing** worker count re-evaluated
every 250 ms against entries/s with a noise floor, capped by the governor at
all times; zero allocation in the hot loop — names go into a per-worker byte
arena and paths are rebuilt from parent indices on demand. Firmlinks and
mount points are recognised by **the existing never-descend list only**
(`src/utils/mountBoundaries.ts`), exactly as the legacy walker does; device
ids are recorded for the hard-link key but never gate descent (**P3-3,
18 September 2026**: the equivalence gate is absolute, and a device rule
would diverge from the walker on firmlinks and nested mounts — the edge
fixture's two `hdiutil` volumes prove the walker descends into both; a
device-boundary setting for every engine is a Phase 8 question). Symlinks
are never followed. `(dev, ino)` for `nlink > 1` goes to a side table, and the first
name seen owns the bytes exactly as today. The key is exact: the walk groups
names by each file's whole id (`u128`, Windows' 128-bit file id included) and
hands the ingest a family number, because a double cannot hold a file id — a
reused NTFS record keeps its sequence number in bits 48..64, so its id passes
2^53, where doubles round neighbours together (P3-7, amended by the
pre-landing review of 23 Sep 2026; `tm_walk::links`). Windows' listing reports no link
count, so there a hard-link family is found by its file ids colliding, and —
because NTFS refreshes each name's copy of a file's size and times only when
the file is opened through that name (CreateHardLink's documentation) — each
family is read once from the file itself, through its first member, and
every member takes that size and those times, as the legacy walker's
`lstat` of each name would read them (`refresh_families`, the CI dry run of
23 September 2026).

**Not eligible for the native engine (P3-4, 18 September 2026)** — the
legacy walker runs instead, with the reason in `engineReason`: an incremental
scan (the mtime cache belongs to the walker until Phase 4's index), a
non-empty ignore list (the glob dialect lives in `src/utils/glob.ts`, and a
Rust re-implementation is a divergence risk), a root that is not a
directory, and a forced engine setting other than `auto` or `native`. Never
degrade to a broken state; every reason is a sentence in the stats.

### 5.1 The correctness gate

For every corpus in `bench/`, the native engine's tree and the legacy
engine's tree must serialise to the **same canonical digest**: same entries,
same parents, same logical sizes, same allocated sizes, same totals, same
exclusions, same flags. `tm-store` exports the canonical serialisation;
`LegacyEngine` produces it from `PackedScanStore`; the test compares
digests and, on mismatch, prints the first differing path. Any difference is
a bug in the new engine until proven otherwise; the intentional ones are
listed in §16 and nowhere else.

**As built (18 September 2026, P3-8):** the digest lives in
`tests/fixtures/canonicalTree.ts`, not in `tm-store` — it is a pure function
over the `ScanStore` every engine writes, hashed with Node's `crypto`, so
the same code digests a walker, gdu or native store. It normalises exactly
two order-dependent facts and nothing else: a directory's children are
sorted by the bytes of their names, and a hard-link family's bytes are
assigned to the member with the smallest path (the family list comes from
the corpus manifest or the edge fixture). Every other fact — sizes, mtimes,
atimes, the five flags, extension, container, provider — is compared as
recorded. `tests/nativeEquivalence.test.ts` is the gate; `tests/edgeCases.test.ts`
pins the walker's behaviour on every §15 case the OS can build, and skips
the rest with the reason.

### 5.2 As built (Phase 3, 22 September 2026) — where the design above was wrong

Recorded the way §8.1 records the governor, so the table and the paragraph
above read as design and this reads as fact:

1. **The queue is `std`, not `crossbeam-deque`.** `crates/tm-walk/src/queue.rs`
   is a `Mutex<VecDeque<DirJob>>` with a `Condvar` and in-flight accounting;
   the Phase 3 plan added no crate, and a work-stealing deque bought nothing
   the hill-climber (`climb.rs`) does not already decide.
2. **One queue, not one per device.** Device ids are recorded for the
   hard-link key (P3-3) and never key a queue. Per-device scheduling matters
   where bytes are read, not where names are listed; it belongs to Phase 5's
   read scheduler (§10.3), and the walk will not grow a second queue on a
   claim.
3. **Linux `io_uring` is not built.** `platform/linux.rs` issues synchronous
   `statx` through the directory descriptor; runtime detection of `io_uring`
   is deferred until the Linux CI leg has proven the synchronous path and a
   measurement shows the syscall overhead is the bottleneck.
4. **Buffers:** every listing uses `DEFAULT_BUFFER_BYTES` (256 KiB) per worker
   on every platform; the one-shot capability probe lists with 64 KiB.
5. **Windows directory times come from the directory itself** (23 September
   2026). NTFS keeps a copy of each directory's times in its PARENT's index
   and updates that copy lazily, so the times `FileIdExtdDirectoryInfo`
   reports for a subdirectory can be older than the directory's own — the
   ones libuv's `lstat`, and so the legacy walker, reads. When the walk lists
   a directory, the handle it opened already carries the directory's own
   `BY_HANDLE_FILE_INFORMATION`; the listing reports those times
   (`Listing::own_times`, `DirTimes`) and the merge puts them on the
   directory's node. No extra call. A directory that is never listed (refused,
   or on the never-descend list) keeps its parent's copy. Found because the
   fast-rescan tests failed only on Windows: the first scan now runs natively,
   the rescan on the walker, and no directory's mtime ever matched.

## 6. The store (Phase 4)

The desktop `PackedScanStore` already proves the shape; the native arena
keeps it and tightens it.

```
per node (28 bytes):
  parent     u32     index of the parent (root = 0)
  size       u64     logical bytes; directories hold the recursive sum after finalize
  alloc_4k   u32     allocated blocks in 4 KiB units (16 TiB per file)
  mtime      u32     seconds since 1970 (good to 2106); sub-second and pre-1970 mtimes go to a side table
  name_off   u32     offset into the interned name blob; length is in the blob's varint header
  ext        u16     interned extension id
  flags      u16     dir | symlink | sparse | hardlink_dup | dataless | cloud_provider(2 bits) | git_root | container(3 bits) | refused | vanished | withheld
per directory (8 bytes, ~15% of nodes on a developer disk → ~1.2 B/node amortised):
  child_start u32, child_count u32     breadth-first child range, as PackedScanStore.finalize() lays out today
side tables (entries only where needed):
  hardlink   node → (dev u32, ino u64)     nlink > 1 only, typically ≤ 1% of entries
  accessed   node → atime i64              only when the atime feature is on
  exact_time node → (mtime_ns i64)         only when the second-granular column is not exact
names:       one blob, components deduplicated through a hash-set interner during the walk
             (node_modules, src, index.js, .DS_Store repeat constantly; the mobile crate measured
              its own blob, and Phase 1 measures the dedup ratio on this Mac's home folder)
```

**Budgeted** at 28 + 1.2 (child ranges) + 8 (names after dedup, upper bound)
+ 0.3 (hard-link table) ≈ **37.5 bytes per entry**, against 49.7 measured for
`PackedScanStore` today (which stores names without dedup and sizes as
`Float64`).

### 6.1 Three storage modes

| Mode | When | What is kept | What it disables |
| --- | --- | --- | --- |
| `memory` | projected entries ≤ 5M (setting) | everything, anonymous memory | nothing |
| `spill` | > 5M and free disk ≥ 3× the projected spill size | every column, written **sequentially with `write()`** into app-data files during the walk, then memory-mapped read-only for queries | nothing; queries touch pages on demand |
| `aggregate` | RAM or disk cannot afford `spill`, or the owner selects it | directory rows only, plus per-directory running totals (bytes, allocated, count, size histogram, extension histogram) and a bounded top-K of largest children stored in the directory row; the global largest-N files heap | duplicates, compare, CSV export of leaf rows, `/nodes` lookups of files, the persistent index hand-off — each named in the UI notice |

Spill files are scan artefacts: removed on scan expiry, on quit, and by a
startup sweep that deletes any spill older than the scan TTL. Before
spilling, the engine checks the app-data volume is not the volume being
measured or, if it is, excludes its own files from the totals, and refuses to
spill when free space is under 3× the projection — switching to `aggregate`
and saying so.

### 6.2 Why `write()` then `mmap`, not `mmap` while writing

Resident-set size counts file-backed pages **mapped into the process**. A
column written through a mapping stays resident until the kernel needs the
memory, so a 3.7 GB index on a 16 GB machine would sit in RSS and fail the
gate while doing no harm. Appending with `write()` keeps only the write
buffers in RSS (the page cache holds the rest, outside the process), and the
read-only mapping afterwards is resident only where a query touched it.

## 7. The memory budget at 100M entries (the Phase 0 gate)

All figures are **budgets** to be measured in Phases 1 and 4, not measurements.

| Component | 10M, `memory` | 100M, `spill` | 100M, `aggregate` |
| --- | --- | --- | --- |
| Columns + child ranges + names, anonymous | 375 MB (37.5 B × 10M) | 0 (file-backed, written with `write()`) | 0 |
| Name interner (hash set of unique components; capped, past the cap names are stored raw and not deduplicated) | 48 MB (2M unique × 24 B) | 128 MB cap | 64 MB cap |
| Worker write buffers + blob writer | 24 MB | 24 MB | 24 MB |
| Aggregation pass (reverse sequential stream over parent/size/alloc) | in place | 64 MB window | 64 MB window |
| Mapped pages touched by interactive queries (top levels, largest-N, per-directory rows the treemap asks for) | — | ≤ 256 MB (page-touch budget enforced by precomputing the top-level views at finalize) | ≤ 64 MB |
| Transport: the pruned 250k-node `FileNode` tree plus its JSON string, transient | 150 MB | 150 MB | 60 MB (aggregate views are smaller) |
| Node process baseline (server, sharp, sqlite, index engine loaded) — **to be measured in Phase 1**; budgeted | 120 MB | 120 MB | 120 MB |
| **Total** | **≈ 717 MB** | **≈ 742 MB** | **≈ 396 MB** |
| Prompt ceiling (Section 5.3) | 700 MB | 1,500 MB | 400 MB |

Two of the three arrive under the ceiling with margin. The 10M `memory` row
does not: it lands 17 MB over, which is why the **spill threshold defaults to
5M and not 10M** — at 10M the columns are file-backed, the interner is the
48 MB of the first column, and the resident budget is 48 + 24 + 64 + 256 +
150 + 120 ≈ **662 MB**, under the 700 MB line. The `aggregate` row is inside its ceiling by 4 MB on paper,
which is too thin: the interner cap and the transport prune are the two knobs,
and Phase 4 measures before choosing their defaults. On-disk footprint at
100M in `spill`: 100M × 37.5 B ≈ **3.75 GB**, so the 3× free-space check asks
for ~11 GB.

## 8. The governor (Phase 2, built first)

Presets and the machinery, as the prompt's Section 8 specifies, with the
platform mechanisms below and one closed loop:

| Preset | CPU ceiling (share of all cores) | I/O priority | Workers | Notes |
| --- | --- | --- | --- | --- |
| Eco | 25% | macOS `IOPOL_THROTTLE`, Windows `THREAD_MODE_BACKGROUND_BEGIN`, Linux `IOPRIO_CLASS_IDLE` | 1–2, `QOS_CLASS_BACKGROUND` (efficiency cores on Apple silicon), `ThreadPowerThrottling` on Windows hybrids, `SCHED_BATCH` on Linux | pauses on `.critical` thermal state; halves on `.serious`; the default on battery |
| Balanced | 50% | `IOPOL_UTILITY` / background-mode / `IOPRIO_CLASS_BE` low level | up to half the cores, `QOS_CLASS_UTILITY` | backs off 30% while the user is interacting |
| Turbo | 90% | normal | all cores, `QOS_CLASS_USER_INITIATED` at most | still yields to the UI thread and to thermal limits |

Closed loop every 100 ms: own CPU delta from `getrusage` /
`GetProcessTimes`, divided by the interval × core count, is the share; the
error against the preset's target adjusts the inter-batch sleep (fine knob,
what lets Eco hold 25% on a two-core machine that cannot go below one
worker) and the worker count (coarse knob, clamped to the preset's range).
Machine-wide load (`host_statistics64`, `GetSystemTimes`, `/proc/stat`)
and input activity (`CGEventSourceSecondsSinceLastEventType`,
`GetLastInputInfo`, `/dev/input` timestamps) feed the "user is interacting"
rule. Thermal state comes from `NSProcessInfo.thermalState` through
`objc2-foundation` on macOS, `/sys/class/thermal` on Linux, and the
power-throttling notifications on Windows; battery from
`IOPSCopyPowerSourcesInfo`, `GetSystemPowerStatus`,
`/sys/class/power_supply`. Sleep notifications pause the scan; wake resumes
it from its checkpoint. Scheduled scans always run Eco.

The **legacy engines obey the preset approximately**: the Node walker's
concurrency and yield cadence become governor-controlled, and gdu is
launched at a lower `nice` and with fewer parallel shards under Eco. They
cannot set QoS or I/O policy from Node, and the stats say `budget:
'eco (best effort)'` for them so the number is never overstated.

### 8.1 As built (Phase 2, 18 September 2026) — where the design above was wrong

Measured on this Mac (Apple M3, 8 cores, macOS 27) while building
`native/treemap-core/crates/tm-governor` and the Node side
(`src/services/engineBudget.ts`); each item is pinned by a test named in the
Phase 2 plan.

* **QoS and `setiopolicy_np(IOPOL_SCOPE_THREAD)` are mutually exclusive on
  macOS.** After a thread-scope I/O policy call, `pthread_get_qos_class_np`
  reports `QOS_CLASS_UNSPECIFIED` and every later
  `pthread_set_qos_class_self_np` returns `EPERM`, in either order. XNU derives
  the disk I/O tier from the QoS class (Background → the throttled tier,
  Utility → the utility tier), so the governor sets QoS only and reports the
  I/O mechanism as carried by QoS. The table's `IOPOL_THROTTLE` /
  `IOPOL_UTILITY` cells describe the tiers reached, not calls made.
* **`host_statistics64` publishes new CPU counters about once a second**, so a
  100 ms tick usually sees no new machine-wide reading; the loop keeps the
  last published share (`machineBusyShare` in the snapshot, `null` until the
  first) and never treats the gap as a fault. The process's own share
  (`getrusage`) is fine-grained and is what the loop controls on.
* **The inter-batch sleep alone cannot hold a duty at low QoS.** A 2.84 ms
  sleep costs ~4 ms at the default class, ~17 ms at Utility and ~155 ms at
  Background — the very classes Balanced and Eco apply. `throttle()` therefore
  keeps a per-thread sleep ledger (owe `(1 − duty) / duty × work`, capped at
  1 s; sleep once ≥ 1 ms is owed; subtract what was actually slept; credit
  bounded at 250 ms) rather than sleeping a computed amount each call.
  Windows' 15.6 ms timer would have broken Turbo the same way.
* **Conditional anti-windup was a defect** (the P term pins the duty at the
  floor before the integral gets there, then a shrinking error exposes the
  frozen integral as a jump from 0.05 to 0.31); the integral is clamped
  instead. The worker-drop threshold is a duty of 0.4, not 0.25, because Eco
  on two cores settles at exactly 0.25 and the plan's own two-core case could
  never fire.
* **The held bands, 60 s each, `cargo test --release --test hold -- --ignored`,
  load ≈ 2.7 before, nothing else building:** Eco target 0.25 → mean of the
  last half **0.2255**; Balanced 0.50 → **0.4702**; Turbo 0.90 → **0.8924**.
  All inside ±5 points; Tier A and Tier C are not available on this machine
  and are reported as such (R25). Eco and Balanced have **no headroom on
  8 cores** — `max_workers × 1.0 / cores` equals the ceiling exactly, so both
  sit at duty 1.0 and any competing process pulls the share below target with
  nothing the loop can add (Eco dipped to 0.16–0.19 for eight seconds while
  `syspolicyd` ran). They held, by 2.0–2.6 points; a third Eco worker on
  ≥ 8 cores is the obvious relief and is left for Phase 8's tuning pass with
  the measurement above as its reason.
* **The Node shim** (`source: 'node-shim'`) replaces the design's
  `'eco (best effort)'` wording: `GET /api/engine/budget`, every scan record's
  `budget` and every pause reply say who held the budget. A governor that
  loaded but is not in force — a snapshot that throws or arrives in the wrong
  shape, or a configure it refused — is `node-shim` too, with the fault in
  `native.reason` and retried (a refused configure after 5 s or at the next
  setting change); the review round found the first version reporting a
  table constant under `source: 'native'` in that state.
* **`governorHold`** runs on libuv's pool as an `AsyncTask`, acceptable for
  the test-only measurement; a scan never will (§4.2).

## 9. The rest of the walk plan

### 9.1 Incremental rescan (Phase 4)

With one listing call per directory, **a full walk already costs no
syscall per file**, so the only rescan that is faster than a walk is one
that skips whole directories. The exact rule is the prompt's: reuse a
directory's cached listing when its own `(dev, ino, mtime_ns)` is unchanged,
and revalidate each child directory the same way — one listing per
directory either way, since a child file edited in place changes the child's
mtime but not the parent's. The real skip comes from a change journal:
FSEvents with a stored event id on macOS, the USN journal on Windows, mtime
comparison on Linux. The per-root index replaces today's 300k-node JSON
tree with the arena's own spill format plus a directory index keyed on
`(dev, ino)`; invalidation gets its own test suite (grandchild changes,
renames, replaced directories, clock skew).

### 9.2 Windows MFT turbo mode (built in W6 — D7; the elevation prompt not verified on this build)

Strictly opt-in: the Scan engine setting `ntfs-mft` ("NTFS turbo"), offered
on Windows only — the Settings row is hidden elsewhere and the API refuses the
value (400 `BAD_SETTING`); a hand-edited settings file is read as Automatic.
The plan is `docs/superpowers/plans/2026-09-23-phase3-w6-mft.md`; what it
fixed, as built:

1. **The app never runs elevated (W6-1).** Electron's main process
   (`electron/mft.js`) shows one plain sentence, then launches
   `tm-mft-helper.exe` alone with the `runas` verb (`Start-Process -Verb
   RunAs`, i.e. `ShellExecuteExW`). Declining — the sentence or Windows'
   prompt — is a choice, not an error: the scan lists the folders and
   `engineReason` says elevation was declined; `fallbackReason` stays null.
   One prompt is open at a time: a scan that wants the mode while another
   waits on the prompt lists its folders instead. After a decline no scan
   asks for ten minutes — the reason says how many are left — and only time
   or a restart ends that: a prompt per scan was one anything that starts
   scans could raise until someone clicked yes (the security review of M6),
   and a reset through Settings would have been one anything that reaches
   the API could repeat (its second review). Both are rules, not failures
   (`src/services/scan/mftPrompt.ts`). What goes wrong once the helper was
   asked for — a launch that fails, a helper that exits non-zero, a result
   that will not read, a divergence — switches the drive off until TreeMap
   restarts, so a drive where the mode cannot work is not asked about again
   for nothing; and the app's temp folder is worked out the helper's way
   (TMP before TEMP, `helperTempRoot`), since a folder the helper does not
   call its own is one it refuses (the pre-landing review of 23 Sep 2026).
   Before any question, the app runs the helper's own checks that need no
   administrator (`mftPrecheck`: the root's drive is local, one Windows can
   type, formatted NTFS), so a network, unknown or non-NTFS drive is never
   the subject of a prompt the helper would only refuse; the root itself is
   not opened there, since it may be what only an administrator can open.
   Only a scan a person started in the window asks (`ScanOptions.interactive`,
   which the window's `POST /api/scan` sends; the scheduler, autopilot, a
   paired computer, MCP and API calls without it list the folders and say
   why), the question names the folder beside the drive, and a turbo scan is
   never written to the fast-rescan cache or the snapshot history
   (`keepsScan`): its tree holds what an unelevated listing is refused, and
   kept it would come back in later unelevated scans (the same review).
   Nothing a program running as the user
   could have changed is started as administrator (its third review):
   PowerShell by its full path under the system folder the kernel reports
   (`systemDirectory`, `GetSystemDirectoryW` — never by name, which Windows
   looks up in the app's own folder first, nor from `SystemRoot`/`windir`,
   which `HKCU\Environment` can shadow), started in that folder; the helper
   only where this user can neither add a file to its folder nor change it
   (`elevationRefusal`: tried, never inferred, before anyone is asked) — so an
   install for anyone who uses the computer (Program Files), not one "only for
   me" or a portable copy, which fall back with that reason; and, last thing
   before `Start-Process`, the script refuses a helper or folder whose owner is
   not Administrators, SYSTEM or TrustedInstaller, by security identifier.
2. **Read-only by construction (W6-2).** The helper
   (`crates/tm-mft-helper`) takes `<volume> <root> <output file>`; it checks
   that the volume is a drive letter, that the root is an absolute folder
   path on it (no `..`), and that the output is named as the app names it
   (`<uuid>.tmmft`) and sits directly inside this user's
   `%TEMP%\TreeMap-mft` — a folder it resolves itself, never from its
   arguments, and refuses unless it is a real folder: a link, a junction or
   any other reparse point there would have sent the elevated write wherever
   it points (the security review of M6). It holds that folder open, for
   listing and without `FILE_SHARE_DELETE`, from before the file is created
   until the file is found where the check said (the listing access is what
   makes the share mode count: Windows checks sharing only against handles
   that read, write, run or delete, and the first Windows CI run renamed the
   folder under the attribute-only handle it first had), so nothing can move it aside and plant a
   junction meanwhile, and resolves it again once held, so a folder *above*
   it swapped for a junction before the hold is caught too (the second
   review) — while it is held, Windows refuses to rename any folder above it,
   which the Windows CI leg asserts rather than assumes. It creates that file
   new (never an existing file, never through a link at its name) before one
   byte of the volume is read.
   It writes nothing else, anywhere. The app makes the same link check before
   it asks, so a planted junction costs no prompt. The volume is opened
   `GENERIC_READ` (M4).
3. **The columns file.** A 16-byte header (magic `TMMFT002`, entry count,
   flags) and `WalkOutput`'s columns little-endian (`tm_mft::columns`), the
   hard-link table as `node, family` pairs (version 1 carried `dev` and `ino`
   as doubles, which cannot hold a file id: the pre-landing review of 23 Sep
   2026; a file from another build is refused as that); a
   refusal is the magic `TMMFTERR` and the helper's sentence, because an
   elevated process's stderr never reaches the app. `mftTake` (tm-node)
   checks the whole file before trusting it (`check_shape`, which the
   encoder applies too, so the helper never writes a file the app would
   refuse): above all `parent[i] < i`, without which the ingest could loop;
   and — since the ingest joins every name onto its parent's path and the
   app acts on that path — every name but the root's one file name (not
   empty, `.` or `..`, no `/`, `\`, `:` or NUL), sizes and allocations
   finite and not negative, and stats a walk of those nodes could have
   counted, the omitted-entry counts within 2^53 − 1 (past it serde_json
   hands JavaScript a number the ingest cannot add). It hands over the same
   typed arrays `scanTake` does, so the ingest, the store and the JSON are
   the native engine's. The stats say `fastPath: "mft"`, `engine: "ntfs-mft"`.
   The app deletes the file once read, on every path. One an earlier run
   left behind — the app quit while the helper, which Windows starts outside
   its process tree, still ran — lists every name under the folder it read,
   so the next scan through the mode removes it before it asks, once it is
   an hour old and no scan of this app is reading it: regular files named as
   the helper names them, never a link or anything else
   (`sweepStaleOutputs`; the pre-landing review of 23 Sep 2026).
4. **The cross-check is the gate at run time (W6-8, correction 9).** Up to
   1,000 entries, drawn uniformly without replacement from those the table
   says were last written at least 120 s before the helper was launched, are
   opened by the app itself — unelevated, `FILE_READ_ATTRIBUTES`, the
   listing's own `stat_path` — and their kind, size and last-write time
   compared (`mftCrossCheck`). An entry that cannot be opened is replaced; a
   mismatch is re-read once; it is a divergence only if it still differs and
   its live last-write time is itself older than the margin (a file written
   since the table was flushed is replaced, not blamed). The first divergence
   discards the whole result, switches the mode off for that volume until the
   app restarts, and names the entry and both values in `fallbackReason`. A
   table the app could verify **too little** of is not trusted either: it
   needs matches for half its eligible entries, at most 1,000 and never none
   (`requiredMatches`), and the check opens at most 4,000 entries
   (`MFT_CROSS_CHECK_ATTEMPTS`) — so every entry written within the margin
   (exactly where a raw read may be missing unflushed creates), or a root
   the app can barely open, lists the folders instead, the reason counts
   what was opened, and the volume stays on offer. Each batch of 250 opens
   is one native call, with a turn of the event loop between two, so the app
   answers while the check runs (the pre-landing review of 23 Sep 2026; the
   check once took a single match as enough, drew without limit and never
   yielded).
5. **Proven on CI or shipped labelled (W6-9).** M5 proves the reader on the
   Windows runner's own volume, as administrator; no CI can answer a UAC
   prompt, so every scan the setting asks for carries `not verified on this
   build` in its `engineReason` until something proves the prompt end to end.

It is the only route to multi-million entries per second on Windows; no
number for it is recorded here, because none has been measured.

## 10. Exact duplicates (Phase 5)

1. **Before any read:** group by size from the arena (ids only, no paths); drop unique sizes; drop files under the minimum size (the API default stays 1,024 bytes so today's results do not shift; the prompt's 4 KiB is the UI's new default and the setting is exposed), files in ignored paths, **files with the `dataless` flag, files on read-hostile mounts**; collapse hard links through the side table and report the family as sharing storage; clones: no public API on APFS exposes clone identity, so the response says the reclaimable figure is an upper bound on that platform — exactly the sentence the finder already composes and the route drops.
2. **Sample digest:** BLAKE3 over `size || first 4 KiB || middle 4 KiB || last 4 KiB` — three small reads, and the tail catches same-header media that a head-only sample cannot.
3. **Full digest:** BLAKE3, large sequential reads with `F_RDAHEAD` / `posix_fadvise(SEQUENTIAL)` / `FILE_FLAG_SEQUENTIAL_SCAN`, opened `O_NOFOLLOW` through a verified descriptor (the mobile crate's discipline); a large file is hashed in parallel by BLAKE3's tree structure.
4. **Byte comparison** for groups over a size threshold (default on above 1 GiB, always on in the test suite so zero false positives is *proven*, not assumed).
5. **Read scheduling:** per-device queues, concurrency per device from rotational detection (IOKit / `IOCTL_STORAGE_QUERY_PROPERTY` / `queue/rotational`), candidates sorted by inode before issuing.
6. **Digest cache:** in the existing app-data SQLite through `better-sqlite3` (already shipped), keyed `(dev, ino, size, mtime_ns, algo_version)`, looked up and written in batches across the boundary; the core hashes, Node owns the cache. A cache hit costs no read.
7. **The last-copy rule moves server-side** as well: the cart refuses a commit that names every path of a reported duplicate group, and a test proves it — today it is a client toast and untested.

The first commit of this phase is the safety fix the current-state record
found: the legacy finder stops hashing cloud placeholders.

## 11. Near-duplicate images (Phase 6)

* **Decode cheaply, in order:** the embedded EXIF/APP1 thumbnail parsed in Rust and decoded at its own size; otherwise sharp with `sequentialRead: true`, `limitInputPixels` capped, `failOn: 'none'`, and a tiny resize target so libjpeg's DCT scaling decodes at ⅛; otherwise `CGImageSourceCreateThumbnailAtIndex` where the platform offers it. Every hash works from a ≤ 32×32 grey buffer. `decodePath` is reported per image.
* **Composite signature:** pHash 64 (DCT), dHash 64, colour-moment 48, aspect bucket and pixel dimensions; weights tuned on the Phase 1 labelled corpus.
* **Search:** multi-index hashing — four 16-bit bands per 64-bit code, one table per band, candidates verified exactly, union-find over verified pairs. Near-linear; the 8,000-image cap goes away.
* **Representative:** highest resolution, then largest file, then oldest mtime (the prompt's rule; today's "newest" rule is an intentional difference, §16). The UI's auto-select keeps the representative.
* **Cache:** signatures in the same SQLite, keyed `(dev, ino, size, mtime_ns, sig_version)`; a rescan of an unchanged library is a cache read.

### 11.1 Deep tier (Phase 7, off by default — D8)

Runs a small vision embedding over cluster representatives and near-miss
candidates only. First implementation: `Xenova/clip-vit-base-patch16` (ONNX)
through `transformers.js` + `onnxruntime-node`, int8, 1–2 threads inside the
governor budget; later Core ML with `cpuAndNeuralEngine` on Apple silicon and
the NPU/DirectML providers on Windows. Index: `usearch` or `hnswlib` with
int8 vectors. Weights are downloaded once, on explicit consent, over a visible
progress bar with cancel, verified against a pinned SHA-256, cached locally;
the feature is invisible until opted in and every other feature works
without it. Adds two backend npm dependencies, which is why it waits for D8.

## 12. API contract (Phase 3 onward, additive only — D6)

* `GET /api/scan/:id/stats` and the SSE `complete` frame gain: `engineReason`, `fastPath`, `fallbackReason`, `budget`, `entriesPerSecond`, `cpuSeconds`, `peakRssBytes`, `bytesRead`, `cacheHitRate`, `storageMode`, `placeholdersSkipped`. Every existing key keeps its name, type and position. `cpuSeconds`, `peakRssBytes` and `bytesRead` are **per-scan deltas measured by the engine itself** (the native core's own counters around the walk), never the process's lifetime figures — the harness learned in Phase 1 that a process-lifetime peak or a self-only counter is a wrong number the moment two scans share a process; a value the platform cannot measure is `null` with the reason in `engineReason`. `openapi.ts`'s `ScanStats` grows by the same keys; `tests/fixtures/golden/responses.json` is re-recorded in the same commit with the reason in the commit message.
* `GET /api/duplicates` gains per group `hashAlgo`, `stagesUsed`, `bytesRead`, `verifiedByteCompare`, `sharesStorage`, and a top-level `notHashed` list; it also starts carrying the `reclaimableIsUpperBound`/`reclaimableCaveat` pair the finder already computes.
* `GET /api/near-duplicates` gains `tier`, per-image `signature` and `decodePath`, `clusterRepresentative`, `confidence`.
* New: `GET /api/engine/capabilities`, `GET|PUT /api/engine/budget` (live effect), `POST /api/scan/:id/pause`, `POST /api/scan/:id/resume`. All go through the same guards and the `meta`/`api` lanes as their neighbours.
* Nothing is removed or renamed. The MCP tools gain the same fields.

## 13. UI (Phase 8, `src/ui/` parts, zero dependencies)

Budget selector (Settings and the scan progress area), engine badge with the
reason on hover, live efficiency readout (entries/s, CPU share, memory),
placeholder notice in Duplicates, aggregate-mode notice naming the disabled
features, a pause button on every long operation. Every new part is added to
`manifest.json`; no new script, style or font.

## 14. Build and distribution

* The Rust workspace is built by `npm run build:native` (needs cargo — developers only). `npm ci` and `npm install` **never** touch it: the crate is not in any install script.
* The release job builds `treemap_core.node` natively on each of its two legs — the macOS runner (`aarch64-apple-darwin` only: no Intel module is built, and the desktop app is released for Apple silicon) and the Windows runner (`x86_64-pc-windows-msvc`); Linux has no desktop release, so its module is built only by `test.yml`. (Corrected 23 September 2026: this sentence used to promise an Intel cross-build and two Linux release legs that were never added.) The compiler is the version pinned in `native/treemap-core/rust-toolchain.toml` — 1.98.1 as of 23 September 2026 — which rustup reads for every cargo command in that folder, so CI, the release job and a developer's machine build with the same Rust; `dtolnay/rust-toolchain@stable` only provides rustup. Before the pin, CI's `stable` was 1.98.1 while the developer's machine had 1.97.0. The `.node` files land in `native/prebuilt/<platform>-<arch>/` before `electron-builder` runs and are listed in `build.files` + `asarUnpack`. `test.yml` builds the module on every OS and runs the equivalence suite natively, so a target that fails to build fails the run.
* Web-mode users (`git clone` + `npm ci` + `npm start`) get the legacy chain unless they run `npm run build:native` or `node scripts/fetchNative.js`, which downloads the matching prebuild from the GitHub release with SHA-256 verification, mirroring `fetchGdu.js`. A missing prebuild for a supported target fails the release job.
* The Electron packaging step already rebuilds native modules for Electron's ABI; a N-API module needs no rebuild, and the loader checks a version handshake before trusting the binary.
* `README.md`'s sentence "TreeMap ships no native code" and `docs/PLATFORM_NOTES.md`'s "no native addons" were meant to change in the commit that shipped the module (`f64c287`); they changed one commit later, on 22 September 2026, together with the "Fast scanning" capability probes and the Missing GB sentences that had printed the same claim.

## 15. Testing

* The **equivalence test** (§5.1) on every `bench/` corpus and on the edge-case fixture generator: symlinks (broken, circular), hard links, sparse files, zero-byte files, a > 4 GiB file (sparse), names with newlines, tabs, emoji, invalid UTF-8 on Linux, NFC/NFD pairs on macOS, case-insensitive collisions, paths over 260 characters on Windows, junctions and reparse points, a permission-denied directory, a directory that vanishes mid-walk, a file that grows mid-hash, mount points, firmlinks, a read-only volume.
* **Placeholders provably never read:** the core records every path it opens for hashing; the test asserts the set is disjoint from every `dataless` node, on a fixture arena with the flag set and, opt-in, on a live evicted file (`TREEMAP_LIVE_DATALESS_FILE`), because user space cannot set `SF_DATALESS` itself.
* Governor: sustained-load tests per preset asserting the band (±5 points over 60 s); synthetic thermal "serious" state; synthetic battery; the UI frame budget through the existing browser test setup.
* Duplicates: recall 1.0 and zero false positives by byte comparison on the planted corpus; hard links and clones never reclaimable.
* Every new assertion is reddened once by a recorded mutant before it counts, the house rule.
* CI: correctness on all three OSes. The performance gate is an **in-job relative A/B**: the same runner scans the fixed `ci20k` corpus with the legacy engine and with the native engine in the same job, median of 5 each, and fails when native is slower than legacy or slower than its own committed ratio by more than a CI-specific band (hosted runners are Tier C-class and noisy; a Tier B laptop baseline says nothing about them, and `bench compare` refuses to compare across tiers or platforms by design). The absolute Tier B baselines under `bench/baselines/` are for the README's numbers, not for CI.

## 16. Intentional differences from the legacy engines

Listed here and nowhere else; each one is justified and each must be
reflected in the equivalence test as a normalisation, never as a loosened
assertion.

1. **Refusals are counted on every engine.** gdu reports a refused directory as an empty one; the native walker counts it, like the Node walker. The equivalence test therefore compares against the Node walker's tree, not gdu's, for refusal fields. Two more gdu limits (CURRENT-STATE §4) shape the gdu leg of the gate, and only that leg: gdu records **no `accessedAt`** and **whole-second mtimes**, so `tests/nativeEquivalence.test.ts` stamps the corpora to whole seconds before the gdu run and sets the `accessedAt` column aside — every other column and every counter must agree, and on this Mac they do (18 September 2026). On Windows gdu can match neither: v5.36.1's `pkg/analyze/dir_other.go` gives every file an inode of 0, so it keys no hard link and counts every name of a family, and it dates a file from its directory entry — the per-name copy NTFS refreshes lazily. Every corpus has hard links, so the gdu leg (b) is skipped on Windows with that reason (read from gdu's source, 23 September 2026); the native gate (c) is not, and RISKS R59 records what it means for a Windows scan that falls back to gdu.
2. **Hard links are keyed on `(dev, ino)`** on every engine; gdu's inode-only key is a documented limit the native path does not inherit. The key is exact in the native engine and the NTFS turbo mode (a family number from the whole id) and in the walker (an id at or past 2^53 is read again as a bigint, `hardlinkKey` in `diskScanner.ts`); the persistent index is not yet (RISKS R60).
3. **Near-duplicate representative** becomes highest resolution → largest → oldest, from "newest".
4. **Withdrawn 18 September 2026 (P3-5).** `accessedAt` was to be off by default in the native path; it is collected on every platform (`ATTR_CMN_ACCTIME`, `STATX_ATIME`, `LastAccessTime`) and compared by the digest, because the "last used" fact and the JSON depend on it.
5. **The mtime cache** (a 300k-node JSON tree) is superseded by the arena index for native scans; the legacy walker keeps its own.
6. **Two order-dependent facts are normalised by the digest, not by the engines (P3-8, 18 September 2026):** the order a listing returns children in, and which name of a hard-link family was seen first. Two legacy walks are not byte-identical to each other on those two points, so the digest sorts a directory's children by name bytes and gives a family's bytes to its lexicographically smallest path before hashing. Nothing else is normalised; the assertion is not loosened, it is made well-defined.
7. **The NTFS turbo mode sees what the unelevated walker is refused (W6-7).** Its helper reads the master file table as administrator, so a folder the listing reports as denied is, in an `ntfs-mft` scan, a folder like any other, with its contents. That is the point of an administrator's metadata view, and hiding it would be a lie of omission, so it is named here rather than smoothed over. The equivalence proof on CI (M5) runs both engines as administrator, where the two agree.
8. **A folder that is no longer a folder when it is opened** — replaced by a file between its parent's listing and its own — is counted as vanished by the native walker (`ENOTDIR` → `REFUSAL_VANISHED`, "gone, or no longer a directory, by the time it was listed") and as unreadable by the legacy walker, whose `classifyFsError` treats only `ENOENT` as a race. Only the `vanishedDirs` and `unreadableDirs` counters differ, and only in that race; the equivalence corpora are static, so the gate never meets it and no normalisation is needed. Per entry the two agree: both count an `ENOTDIR` from an entry's stat as unreadable (the pre-CI review of `linux.rs`, 23 September 2026, checked against `diskScanner.ts`). Aligning the legacy walker would move `classifyFsError`, which serves both levels, and with it the per-entry count on every native platform path, so it is left as a choice for a phase that touches the walker.
9. **On Windows, a file whose other names are all outside the scan keeps its listing's copy of its size and times.** NTFS refreshes a name's copy only when the file is opened through that name, and the listing reports no link count, so a file hard-linked from outside the scanned root and written through that other name since is listed with the older values under the name inside it, where the legacy walker's `lstat` opens the file and reads the new ones. A family whose names are inside the scan is found by its file ids and read from the file (`refresh_families`); a lone name cannot be told from an ordinary file without opening every file, which is what the listing exists to avoid. The equivalence corpora make every link inside the scan, so the gate does not meet it.
10. **The native engine marks every entry whose data is not on the disk a cloud placeholder** — the walk's own flag: macOS `SF_DATALESS`; Windows' recall attributes and cloud reparse tags, on a file both engines record as a link — wherever it lives, with a provider only when the path names one. The walker cannot read that flag and still guesses: a file with a size, nothing allocated and a path under a known cloud folder. So a native scan shows more placeholders (with the badge, on the cloud line of Missing Gigabytes, and never opened by the duplicate pass — RISKS R1) than a walker scan of the same tree, never fewer; the equivalence corpora hold no dataless file, and a test builds one by hand (`nativeEngine.test.ts`, 23 Sep 2026).

## 17. Phase plan → commits

| Phase | Commits (each small, each reviewable) | Gate |
| --- | --- | --- |
| 0 | `docs(engine): current state, design, risks` | this file's §7 arrives under the ceiling |
| 1 | `bench: seeded PRNG, arithmetic, cache refusal`, `bench: machine record + rusage`, `bench: corpus generator`, `bench: image corpus`, `bench: runner, report, checks`, `bench: the review round (child processes, refusals, sound checks)`, `bench: baselines for the legacy engines`, `test: the lane-drain flood keeps ≤ 64 sockets` | `npm run bench` reproducible (spread under 5% over three runs, each in a fresh process), correctness proven beside every timing, baselines committed only from runs that passed both |
| 2 | `native: workspace + governor crate`, `feat(engine): budget presets, /api/engine/budget` | 25/50/90% held ±5 points for 60 s on this tier (Tier A and C reported as not available here) |
| 3 | macOS walker, then Windows, then Linux, each behind the probe | equivalence digest identical; targets met on the available tier; budgets held |
| 4 | store: spill, aggregate-only, incremental index | 100M synthetic scan inside the ceiling; views responsive |
| 5 | duplicates | Section 5.4 targets on the scaled corpus, 0/0 by byte compare, placeholders untouched |
| 6 | near-duplicate fast tier | Section 5.5 fast-tier targets, cache hit rate on rescan |
| 7 | deep tier (after D8) | off by default; consent; crop recall |
| 8 | UI, settings, README numbers from `bench/`, CI regression gate | badge visible; README matches `bench/` exactly; CI fails on > 10% |

## 18. What this session delivers, and what waits for the owner

Delivered: Phase 0 (this file and its two siblings) and Phase 1 (the harness,
the corpora, the baselines of the legacy engines on this Tier B machine, and
the test fix that makes the local gate trustworthy again). The measured suite
figure at the starting commit is in `CURRENT-STATE.md` §13; the baselines are
in `CURRENT-STATE.md` §11.1 and `bench/baselines/`.

Three things the baselines change in this document:

1. **The legacy near-duplicate engine has no recordable baseline.** Its
   precision at the default threshold is 0.18 on the labelled corpus, so the
   Phase 6 target is not "≥ 100× faster on rescan" against a working
   baseline but "precision ≥ 0.98 with the recall targets, then speed". The
   labelled corpus is synthetic (gradients, shapes, noise) and gradient-heavy
   images are exactly where a 64-bit dHash collides; Phase 6 validates the
   composite signature on it and, opt-in and locally, on a real photo
   library with only aggregate numbers recorded (`RISKS.md` R50).
2. **The gdu binary alone runs at ≈330k–420k entries/s on the 200k tree; the
   app's gdu path at ≈195k.** Half of the legacy fast path's wall clock is
   transport, not enumeration. A native in-process walker removes that half
   before it removes a single syscall, which is why Phase 3's first gate on
   macOS compares against both the app's gdu path and the bare binary.
3. **A 1M-entry warm run does not exist on this machine** (`mixed`, 2.66 GB
   of catalog per pass); the honest Phase 3 target at that size is the cold
   NVMe row of Section 5.2, 100k–250k entries/s on Tier B, measured under the
   same label.

Answered by the owner on 18 September 2026: D3 separate (fresh core), D6
approved, D7 approved for Phase 3's Windows leg, D8 approved for Phase 7,
D9 `main`, and the one-time crates.io download for the first `cargo build`
approved. Phase 2 (the governor) starts from that answer.
