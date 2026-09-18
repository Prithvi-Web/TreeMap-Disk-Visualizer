# Risks (Phase 0)

What could break, what is hard to test, what is platform-specific, and what
could cost a user data, disk space or bandwidth. Each risk names the phase
that retires it and how. Severity is the cost to a user if it lands, not the
likelihood. Companion to [`CURRENT-STATE.md`](CURRENT-STATE.md) and
[`DESIGN.md`](DESIGN.md).

## A. Data, disk and bandwidth (the ones that matter most)

| # | Risk | Severity | Where it stands | Retired by |
| --- | --- | --- | --- | --- |
| R1 | **The legacy duplicate finder hashes cloud placeholders today.** `duplicateFinder.ts` filters nothing by flag; an evicted iCloud Drive or OneDrive file of a bucketed size is opened and read, which makes the OS download it. The near-duplicate job already excludes the flag; the exact finder does not (`CURRENT-STATE.md` §6) | CRITICAL — bandwidth, a metered connection, and the disk the user is trying to empty | Present in v5.0.1 | The first commit of Phase 5, test-first: every `Flag.CloudPlaceholder` and `dataless` node is excluded before bucketing, reported in the `notHashed` list, and a test asserts the finder never opens one |
| R2 | **The native path could read a placeholder it failed to flag.** Detection by path regex (today's rule) misses a dataless file outside the three known folders; detection by flag (`SF_DATALESS`, `RECALL_ON_DATA_ACCESS`, cloud reparse tags) is exact but platform-specific | CRITICAL | Design uses the flag on macOS and Windows and the path rule only as a second source; FUSE mounts are never hashed by default | Phase 3 (flags recorded by the walk), Phase 5 (the "never opened" assertion on a fixture arena and an opt-in live evicted file) |
| R3 | **Spill files fill the disk the user is cleaning.** A 100M-entry index is ~3.75 GB on disk | HIGH | Design: 3× free-space check before spilling, automatic switch to aggregate mode with a notice, app-data volume excluded from its own totals | Phase 4, with a test that fakes a nearly full volume |
| R4 | **Spill files outlive the scan** after a crash | MEDIUM | Design: startup sweep by age, removal on expiry and quit | Phase 4; a test plants an orphan and starts the app |
| R5 | **A cache causes a delete.** The digest cache or the arena index could feed a stale path to the cart | CRITICAL | Rule: caches accelerate; every destructive endpoint re-validates against the live filesystem immediately before acting, as `requireInsideScanRoot` already does for roots | Phase 5; the last-copy rule also becomes server-side with a test |
| R6 | **Deleting one hard link or clone reported as reclaimable** | HIGH | Hard links: `(dev, ino)` side table, family reported as sharing storage. Clones: no public API reports clone identity on APFS (`docs/PLATFORM_NOTES.md:80-88`); the response says the figure is an upper bound rather than pretending | Phase 5; a test plants links and clones |
| R7 | **Offload verification drift.** Two digests in two places (`copyWithHash`, the catalogs) with no algorithm field on disk | LOW (nothing changes) | Design D5: offload and Time Capsule keep SHA-256; if that ever changes, the catalog gets an `algo` field first | — |

## B. Correctness of accounting

| # | Risk | Severity | Where it stands | Retired by |
| --- | --- | --- | --- | --- |
| R8 | **The native tree silently differs from the legacy tree** (a size off by a block, a missed entry, a firmlink descended twice) | CRITICAL — the app's whole reputation | The prompt's absolute gate | Phase 3's equivalence digest on every corpus and every edge-case fixture; any difference is a bug until listed in `DESIGN.md` §16 |
| R9 | **`ATTR_CMN_RETURNED_ATTRS` ignored** → garbage sizes on a filesystem that returns fewer attributes | HIGH | The vendored `bulk.rs` honours it and falls back to `lstat` for an entry the kernel would not describe; the mobile review found one path where a malformed size became a measured zero | Phase 3 re-fixes it here with a test that feeds a truncated attribute buffer |
| R10 | **NFC/NFD twins on macOS double-count.** Today nothing normalises; HFS+ normalised names on disk and APFS does not | MEDIUM | Both engines store names as returned, so the equivalence test agrees on the wrong answer | Phase 3 fixture generator creates both spellings; the decision (count once, report the pair) is recorded in `DESIGN.md` §16 when taken |
| R11 | **Windows has no allocation accounting today** (`blocksAreMeaningful` false) and the native path will report `AllocationSize` for the first time | MEDIUM — a number that used to be absent appears | Additive: fields that were 0 become measured; the missing-gigabytes statement already treats Windows separately | Phase 3 Windows; CI's Windows leg |
| R12 | **Vanished-mid-walk and permission-denied handling regresses** (a refused folder rendered as empty) | HIGH | The mobile walker was built around the opposite rule; the desktop counts them | Phase 3 tests plant a mode-000 directory and remove one mid-walk |
| R13 | **A file that grows while being hashed** produces a wrong digest | LOW | Sample digest includes the size; full digest re-checks size after reading | Phase 5 test |
| R14 | **Sub-second mtimes lost** in a `u32` seconds column break the incremental rule | MEDIUM | Side table for exact nanoseconds; the reuse key uses the exact value | Phase 4 invalidation suite |

## C. Platform and environment

| # | Risk | Severity | Where it stands | Retired by |
| --- | --- | --- | --- | --- |
| R15 | **macOS warm-cache targets above ~250k entries cannot be met on a default install** (`kern.maxvnodes = 251,127` here). The prompt's headline 1M/s is a warm-cache figure | HIGH — a target that would be reported as missed, or worse, faked | Stated in `DESIGN.md` §1; the harness labels cache state per run and reports the measured number | Phase 1 measures; README says cold and large scans are hardware-bound |
| R16 | **A cold-cache run cannot be labelled cold without root.** `purge` needs `sudo` on this macOS; the harness may not have it | MEDIUM | The runner refuses to label a run "cold" unless the purge procedure ran and exited 0; otherwise the run is "unknown cache state" and excluded from cold targets | Phase 1 |
| R17 | **`getattrlistbulk` returns `ENOTSUP`** on SMB, some FUSE and some third-party volumes | MEDIUM | Capability probe + per-directory fallback to `fdopendir`/`fstatat` | Phase 3, tested against a mounted disk image and a synthetic `ENOTSUP` |
| R18 | **TCC: a folder macOS refuses to the app.** An `lstat` passes, `open` fails; the legacy preflight opens the directory to be honest | HIGH | The native walker keeps the "a refused root is a failed scan, never an empty one" rule | Phase 3 |
| R19 | **Windows long paths, junctions, reparse points, `MAX_PATH`** | MEDIUM | `\\?\` prefix internally, `FILE_FLAG_OPEN_REPARSE_POINT`, reparse points as leaves | Phase 3 Windows; the edge-case generator; CI's Windows leg is the only place it runs for real |
| R20 | **Linux `io_uring` blocked by seccomp or absent in containers**; cgroup limits ignored | MEDIUM | Runtime detection with synchronous `statx` fallback; `cpu.max` read for the concurrency ceiling | Phase 3 Linux |
| R21 | **Firmlinks and bind mounts.** `/System/Volumes/Data` is the same tree as `/`; a device-id rule alone is wrong on macOS | HIGH | Keep the never-descend list *and* the device check, and visited `(dev, ino)` for directories | Phase 3; the firmlink fixture already exists in `pathSanitizer` tests |
| R22 | **The developer machine's C toolchain**: `cc` alone cannot link (command-line-tools SDK newer than Xcode 26.6's linker). `cargo` links fine | LOW (developer only) | The harness compiles its one C probe with `xcrun --sdk macosx clang -isysroot …` | Phase 1 |
| R23 | **macOS 27 resets loopback connections beyond the listen backlog**, which is why one existing test is red locally | LOW (test only) | Recorded in `CURRENT-STATE.md` §13 | Phase 1's test fix (≤ 64 sockets, same 200 requests) |

## D. Resource governor

| # | Risk | Severity | Where it stands | Retired by |
| --- | --- | --- | --- | --- |
| R24 | **The budget is a thread count, not a ceiling.** Without QoS, I/O policy and duty cycling, "Eco" is a label | HIGH — the user's primary ask | Built first (Phase 2), with the OS primitives per platform and a closed loop | Phase 2's held-band test, 60 s at 25/50/90 ± 5 points |
| R25 | **Only Tier B exists here.** Tier A and Tier C bands cannot be verified on this Mac | MEDIUM | Reported as "not available on this machine", never as passed; CI runners (2–4 vCPU) stand in for Tier C with their noise stated | Phase 2 |
| R26 | **The legacy engines cannot hold Eco exactly** (Node cannot set QoS or I/O policy; gdu is a child process) | MEDIUM | Best-effort control (concurrency, yields, `nice`, fewer shards) and the stats say `best effort` | Phase 2 |
| R27 | **Thermal and battery signals need Objective-C/IOKit calls from Rust** | LOW | `objc2-foundation` and IOKit through the `core-foundation` crates; a synthetic thermal state drives the tests | Phase 2 |
| R28 | **Sleep/wake**: a scan that keeps a drive awake, or resumes into a vanished mount | MEDIUM | Pause on will-sleep, resume from checkpoint on wake, re-probe the root | Phase 2/3 |

## E. Memory and the 100M path

| # | Risk | Severity | Where it stands | Retired by |
| --- | --- | --- | --- | --- |
| R29 | **RSS counts mapped file pages.** A column written through `mmap` stays resident on a machine with free RAM and fails the gate while harmless | MEDIUM | `write()` during the walk, read-only `mmap` afterwards, page-touch budget for queries (`DESIGN.md` §6.2) | Phase 4 measurement |
| R30 | **The aggregate-mode budget is 4 MB under its 400 MB ceiling on paper** | MEDIUM | Two knobs (interner cap, transport prune) reserved; defaults chosen after measurement | Phase 4 |
| R31 | **Name interning at 100M entries** needs a hash set that itself grows | LOW | Capped; beyond the cap names are stored raw | Phase 4 |
| R32 | **The Node side still materialises object trees** (`scan.root` getter, the 300k-node mtime cache) | LOW (bounded) | Native scans do not write the JSON cache; the getter stays behind the 250k prune | Phase 4 |

## F. Build, distribution and maintenance

| # | Risk | Severity | Where it stands | Retired by |
| --- | --- | --- | --- | --- |
| R33 | **A missing or wrong-arch prebuild ships.** Five targets, two of which (macOS x64, Linux arm64) have no CI leg today | HIGH | Each release leg builds its own; new legs added; a target that does not build fails the release, never silently falls back in the installer | Phase 3 per platform, Phase 8 CI |
| R34 | **An end user is asked for a Rust toolchain.** | HIGH | The crate is in no install script; `npm ci` never compiles it; web mode falls back to the legacy chain with a stated reason | Phase 3; a test greps `package.json` scripts for the invariant |
| R35 | **Electron's packaging rebuild trap** (`npm rebuild better-sqlite3` after `electron-builder`) now has a second native module | LOW | N-API modules need no rebuild; the loader's version handshake refuses a mismatched binary with a reason | Phase 3 |
| R36 | **Contributor friction**: Rust in a TypeScript repo | MEDIUM | The native path is optional for development (legacy chain runs without it); `native/README.md` documents the one command; CI builds everything | Phase 3 |
| R37 | **Vendored code drifts from its source** or inherits its open defects | MEDIUM | `VENDORED.md` records the source commit and every change; the review's confirmed findings are re-fixed here with tests before wiring | Phase 3 |
| R38 | **Crate downloads.** The first build fetches `napi`, `napi-derive`, `napi-build`, `crossbeam-deque`, `objc2-foundation`, `windows-sys`, `rustix` and their trees from crates.io; the lockfile pins them | LOW | Recorded in `DESIGN.md` §18 for the owner; `Cargo.lock` is committed; `cargo audit`-style review of the tree before the first commit | Phase 2 |

## G. Measurement honesty

| # | Risk | Severity | Where it stands | Retired by |
| --- | --- | --- | --- | --- |
| R39 | **A number printed that no run produced** | CRITICAL to the product's identity | Every UI or README figure must cite a `bench/` run on a named machine under a named cache state; the CI perf gate reads the same files | Phase 8 test that greps README figures against `bench/` output |
| R40 | **Noise read as a result.** The desktop bench today swung +22.5% against its August baseline under load 3.3 | HIGH | The runner prints load average and a resolution band, refuses to call a difference inside the band a change (the existing `bench-v4` rule), takes the median of ≥ 5, and CI uses a fixed small corpus with a 10% threshold | Phase 1 |
| R41 | **The 500 GB duplicate corpus and the 200k-image corpus cannot be built here** (249 GB free; image generation time) | MEDIUM | Scaled corpora with the same distributions, labelled with their scale; ratios (4×, 10× less I/O) are measured, absolute wall-clock targets are reported as "at 1/10 scale" | Phase 1 |
| R42 | **Bytes read is hard to measure on macOS without root.** `fs_usage` needs root | LOW | `proc_pid_rusage(RUSAGE_INFO_V4).ri_diskio_bytesread` works for the same user (verified today); Linux `/proc/self/io`; Windows `GetProcessIoCounters` | Phase 1 |
| R43 | **Equivalent mutants and tautological tests** — the house's recurring trap (`verification-tooling-traps`) | HIGH | Every new assertion is reddened by a recorded mutant whose anchor count is asserted inside the mutation script | every phase |

## H. Security surface of native code

| # | Risk | Severity | Where it stands | Retired by |
| --- | --- | --- | --- | --- |
| R44 | **Native code opens files.** A path that escapes the scan root, or a symlink swapped in mid-walk, opened by Rust | CRITICAL | `O_NOFOLLOW` + `O_DIRECTORY` descriptors, `openat` relative to the parent descriptor, never a full-path `open` from a stale listing (the mobile review's CRITICAL, re-fixed here); the core never writes to any volume except app-data; the same `pathGuard` rules apply before a path reaches napi | Phase 3 with a swap-in test |
| R45 | **Unsafe Rust.** `getattrlistbulk` buffer parsing is inherently `unsafe` | HIGH | The workspace lint set (`unsafe_op_in_unsafe_fn = deny`, no `unwrap`/`panic`/`indexing_slicing`), fuzz-style tests over truncated buffers, `panic = unwind` with `catch_unwind` at the napi boundary so a Rust panic becomes a stated engine failure and the legacy engine takes over | Phase 3 |
| R46 | **A panic or crash in the core takes the app down** | HIGH | Every napi entry is wrapped; a crash in the native engine marks it unavailable for the session with the reason and re-runs the scan on the legacy chain | Phase 3 |

## I. Scope and sequencing

| # | Risk | Severity | Where it stands | Retired by |
| --- | --- | --- | --- | --- |
| R47 | **Building the walker before the governor** | MEDIUM | Phase order is fixed: governor first | — |
| R48 | **A phase claimed done on green tests without a reviewed diff** — the pattern every TreeMap session has recorded | HIGH | Each phase ends with an adversarial review fleet over the diff (`/ultra-review` plus purpose-built adversaries) before its check-in | every phase |
| R49 | **Windows MFT and the deep tier need the owner's decisions** (D7, D8) | LOW | Designed, not built, until answered | — |
