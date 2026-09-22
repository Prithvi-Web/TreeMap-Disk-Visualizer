# Prompt for the next session

Copy everything below the line into a fresh session started in
`/Users/prithvivinay/Desktop/Claude Code/Treemap`.

---

Work on TreeMap at `/Users/prithvivinay/Desktop/Claude Code/Treemap`
(GitHub: `Prithvi-Web/TreeMap-Disk-Visualizer`), an Electron + Express +
vanilla-JS disk-space visualizer, now gaining a native Rust scan engine under
`native/treemap-core`. You are continuing the **fast-scanner master prompt**
(`/Users/prithvivinay/Downloads/TREEMAP-FAST-SCANNER-MASTER-PROMPT.md`, v3):
read it in full first — its phase order is binding, and its three overriding
rules (no safety regression, no number that was not measured, never degrade
to a broken state) override everything else, including this prompt.

The owner's standing instruction for this work, verbatim: *"All features to
be made perfectly and tell me when every phase is completed do not stop untill
all phases are finished and all the CI checks are perfect."* Work through
Phases 3 → 8 in order, one committed and gated phase at a time, and check in
after each phase in plain English with the measured numbers.

## Who you are working for, and the house rules

- The owner is **not a programmer**. Every message in plain English; every
  command they might run as a copy-paste line that starts with
  `cd "/Users/prithvivinay/Desktop/Claude Code/Treemap" && …`. Never assume
  they know git or npm. **You commit; the owner pushes from GitHub Desktop.**
  Never `git push`. Never `git checkout`, `git stash` or `git clean` on the
  working tree without saying why first — there is uncommitted work on disk
  (below).
- "Flawless" means: 100 % honest coverage, zero known defects, every new
  assertion reddened once by a recorded mutant restored byte-identically,
  the full suite green, and every claim verified by running the thing. A
  green test is not evidence until you have watched it fail.
- Per-feature check-ins with a running preview. The preview is
  `preview_start` name `treemap` (http://127.0.0.1:4280; it runs `npm start`
  from `dist/`, so run `npm run build` first). The desktop alternative for
  the owner is `npm run app`. **Nothing was listening on 4280 when the last
  session ended — start it fresh.**
- Never edit sources while `npm test` runs; never let an implementer agent
  run the whole suite (only its own test files); never scan or touch the
  owner's real folders (every fixture under `os.tmpdir()`); deletes only ever
  to the Trash; no network during scanning or hashing; no Rust toolchain for
  end users (`npm install` never touches cargo); the frontend stays
  zero-dependency (`public/index.html` is generated from the parts in
  `src/ui/manifest.json` by `node scripts/build-ui.js`; edit the parts, never
  the output; `--check` must stay clean); never run electron-builder without
  `--publish never`; never build in or modify the sibling TreeMapMobile repo
  (decision D3: the desktop core is written fresh); a cold-cache purge only
  ever through `sudo -n purge`, never prompting for a password.
- ECC's GateGuard blocks the first Bash/Edit/Write of a session until you
  state the request in one sentence and what the command produces; state
  the facts and retry. It also blocks `git commit --amend` and `rm -rf`-shaped
  commands as destructive: use plain commits.
- **CI runs Node 20** (locally it is Node 24). Anything a worker thread or a
  child process loads must be plain JavaScript or a `.cjs` entry that does
  `require('tsx/cjs')` first (see `bench/lib/corpusWorkerEntry.cjs` and the
  commit `daa1296`). A local run does not reproduce this; a test that starts
  the entry with `execArgv: []` does.
- There is no `gh` CLI and no Homebrew on this Mac. Read CI through the
  public API: runs at
  `https://api.github.com/repos/Prithvi-Web/TreeMap-Disk-Visualizer/actions/runs?per_page=5`,
  jobs at `…/actions/runs/<id>/jobs`, and each job's failure text at
  `https://api.github.com/repos/Prithvi-Web/TreeMap-Disk-Visualizer/check-runs/<job id>/annotations`
  (job logs need admin rights; the test step annotates every failing test
  with its assertion).
- Rust: use `--offline` on every cargo command (every crate is in
  `Cargo.lock`; a new crate means asking the owner first — see "decisions
  owed"), and give every agent its own
  `CARGO_TARGET_DIR` under the session scratchpad so parallel builds never
  share a target directory. The workspace lint set denies `unwrap`, `expect`,
  `panic`, `todo`, `unimplemented`, `unreachable`, `indexing_slicing`; every
  `unsafe` block carries a true `// SAFETY:` comment. Windows and Linux are
  compile-checked here with `cargo check --all-targets --target
  x86_64-pc-windows-msvc` and `--target x86_64-unknown-linux-gnu` (both
  installed; no linker needed; `cargo clippy` works cross-target too) and
  proven live only by the CI runners. A release build takes about 11 s.
- Machine: Apple M3 (4P+4E), 16 GB, macOS 27.0, APFS, `kern.maxvnodes` ≈
  251k (a warm cache above ~250k entries is not a state this Mac can be in),
  Tier B in the prompt's terms; Tier A and C bands are reported as "not
  available on this machine", never as passed.

## Read these first, in this order

1. `HANDOFF.md` — the "Session 16" block and its two "Later" addenda are the
   narrative of how everything below came to be.
2. `docs/superpowers/plans/2026-09-18-phase3-native-walker.md` — the progress
   table at the top is the live state of Phase 3; the interfaces in it are
   fixed.
3. `docs/superpowers/plans/2026-09-18-phase4-storage.md` — Phase 4's plan,
   written and committed, not started.
4. `docs/superpowers/plans/2026-09-18-phase2-governor.md` (done; its progress
   table records what was measured and the review outcomes) and
   `2026-09-18-phase1-bench-harness.md` (done).
5. `docs/engine/DESIGN.md` (§0 decisions, §8.1 the governor as built, §5 the
   walker as built, §16 the intentional engine differences), `RISKS.md`
   (R52, R52a are the latest), `CURRENT-STATE.md` (§11 holds the Phase 1
   baselines; §11 has **not** yet received the Phase 3 numbers).
6. `src/ui/README.md` before touching anything under `src/ui/`.

## Where things stand (verified 21 September 2026, end of the session)

**The working tree is clean and every piece of finished work is committed.**
`main` is 5 commits ahead of `origin/main` (`928257c`, which the owner
pushed on 19 September); the owner pushes from GitHub Desktop. On GitHub
already: the CI fix for the Node 20 worker (`daa1296`); Phase 2 complete
(`2a9fa90` + `0bc3aa4`: the Rust governor held **22.6 / 47.0 / 89.2 %**
against 25 / 50 / 90 for 60 s each on this Mac; the napi module; the budget
in the app with its routes, Settings row and `budget` in the scan stats;
four ECC reviews and a Rust review, every finding fixed red-first); Phase 3
W1, the macOS `getattrlistbulk` walker crate (`e984c34`) with the
mount-point fix (`0a0ea2e`); Phase 3 W3, the equivalence gate (`928257c`).

Committed locally since, not yet pushed (ask the owner to push first thing):
- `f64c287` **W2 — the native engine in the app.** `crates/tm-node` gained
  `scanProbe/scanStart/scanPoll/scanPause/scanResume/scanCancel/scanTake`
  (typed arrays handed over without copying, every export
  `#[napi(catch_unwind)]`, the walk governed by the same governor the budget
  drives); `src/services/scan/nativeEngine.ts` (eligibility, polling,
  ingest through the shared `statToInput` in `src/services/scan/nodeInput.ts`);
  selection in `startScan` is forced setting → native → gdu → walker and every
  record states `engineReason` and `fastPath`; `GET /api/scan/:id/stats`
  appends, after `budget`, in this order: `engineReason`, `fastPath`,
  `fallbackReason`, `entriesPerSecond` (null while running), `cpuSeconds`,
  `peakRssBytes` (always null, a per-process figure), `bytesRead`,
  `cacheHitRate` (null until Phase 4), `storageMode`, `placeholdersSkipped`;
  the golden fixture re-recorded with exactly those ten keys; the `engine`
  setting (`auto | native | gdu | walker`) with its "Scan engine" Settings
  row and the reason on hover in the Dashboard note; the bench's `native`
  engine choice; `TREEMAP_NATIVE_MODULE` exclusive when set. The one real
  defect its byte-identity test caught: libuv sorts `readdir` listings while
  `getattrlistbulk` returns APFS's hash order, so the ingest emits children
  byte-sorted by name. **Measured on a 20,401-entry temp fixture, warm and
  busy Mac, 5 runs after a warm-up: walker 275,689 entries/s, native 850,042
  (3.1×), end to end through the app.** 31 + 9 + 1 tests, 10 mutants red.
- `5367ee0` the macOS mount test detaches its image on a failing run (a
  guard with `Drop`; two images had been left mounted by a red mutant run).
- `82289c1` **W4 + W5 — the Windows and Linux listings**
  (`crates/tm-walk/src/platform/windows.rs` 1,209 lines, `linux.rs` 571,
  `tests/windows_parse.rs` 16 tests, `tests/linux_parse.rs` 13, the `cfg`
  dispatch in `platform/mod.rs`, `windows-sys` 0.61.2 with seven feature
  gates, and the Windows hard-link **file-id collision rule** in `walk.rs`
  because a family spans directories and workers). Rules, mirroring libuv:
  every reparse point is a symlink-kind leaf whose size is the UTF-8 length
  of the substitute name with `\??\X:` (4 units) or `\??\UNC\` (6 units)
  stripped; a volume mount point is a size-0 leaf never descended; WSL links
  and `AF_UNIX` sockets are denied like `lstat`; cloud tags and
  `RECALL_ON_DATA_ACCESS | RECALL_ON_OPEN | OFFLINE` set the dataless flag;
  FILETIME goes through libuv's exact `sec`/`nsec` split (a FILETIME of 0
  lands in April 2009 as in Node — mirrored, not corrected, because the gate
  compares against Node); Linux uses raw `getdents64` + `statx` with
  `stx_mask` honoured like `RETURNED_ATTRS`, `ENOSYS` → `fstatat`, `makedev`
  as glibc. Proven here only by synthetic-buffer tests and both cross
  targets' `cargo check --all-targets` and clippy. **Eight things only the CI
  runners can prove — read the first Windows/Linux run against them:** libuv
  typing every reparse point as a link (if the legacy side shows them
  `isSymlink: false`, change `stage_record`'s `LinkClass::Followed` arm to
  the attribute kind); the `lstat` size of a cloud placeholder and of a
  volume mount point; `ino` on ReFS (the runner is NTFS); `nlink` versus the
  collision rule (the equivalence digest is the proof); the `FindFirstFileExW`
  fallback on a volume without file ids (every leaf would be `withheld`,
  `unreadableEntries = fileCount` — an owner decision for exFAT/SD cards);
  `statx` masks on FUSE/NFS/overlayfs and the `ENOSYS` switch;
  `prefixed_path` on a root with forward slashes or a bare `C:`;
  `GetThreadTimes`, the `FILE_SHARE_*` sharing on locked system directories,
  `ERROR_DIRECTORY` → Vanished. The collision map costs ~28 B per candidate
  file for the walk's duration (a Phase 4 item).
- `85fc7c7` decision **D10** in `DESIGN.md` §0: the owner approved Rust
  crates from crates.io for Phases 5–8 (BLAKE3, an image decoder and DCT, an
  embedded key–value store), pinned in `Cargo.lock`, built by CI only.

The last full run on this tree: `npm test` **2,758 passed, 0 failed, 6
skipped** with the module built and loaded; `npm run typecheck` clean; `node
scripts/build-ui.js --check` clean; the host `cargo test --workspace` 126
tests green; host clippy clean; both cross targets `cargo check --all-targets`
clean.

**CI's two Rust-step failures are fixed (`6983dae`), and the whole Rust gate
was run here exactly as CI runs it.** `cargo fmt --all -- --check`, `cargo
clippy --workspace --all-targets -- -D warnings` on the host and against both
cross targets, and `cargo test --workspace` (152 passed, 3 ignored) are clean.
The fmt failure was `tests/walk.rs`; the Linux-only `useless_conversion` was
`tv_usec`, now widened through `i128` so both targets lint clean with no
suppression. **CI has not run on this since - the owner's push is what proves
it**, and that push is also the first live run of `windows.rs` and `linux.rs`.

The preview server is running (`npm run build` then `preview_start` name
`treemap`, http://127.0.0.1:4280); a real scan of a 106-entry temp fixture
through the app reported `engine: native`, `fastPath: bulk`, no fallback.

## What remains of Phase 3, in order

1. **Ask the owner to push**, then read the four CI legs (the Rust step, then
   the test step's annotations) and fix what the Windows and Linux runners
   reveal about the listings - this is the first live proof of `windows.rs`
   and `linux.rs`, and the eight questions below are the reading guide. A red
   leg there is information about the platform, not a reason to loosen the
   equivalence gate.
2. ~~A Rust review~~ **done 22 September 2026** (`3b3c18e`, `95d5a0e`): four
   read-only reviewers over `tm-walk`, both cross-platform listings, the scan
   bindings and the fallback path; nine defects fixed red-first with a mutant
   each, five risks recorded (R53-R57) for what was deliberately not changed.
   The two that mattered most: a worker panic wedged the walk forever, and
   `scanTake` joined the driver on Node's main thread, so one wedged network
   mount would have frozen the whole app. **R55 is an open question for the
   owner** (a Windows volume without file ids reports every leaf unreadable).
3. The **measurement** (Phase 3 plan, W3 step 7, and the phase gate): on a
   quiet machine, `npm run bench -- enumerate --corpus=ci20k --engine=native
   --runs=7 --cache=warm --record`, then `enum200k` (5 runs) and `enum1m`
   (5 runs; its cache state is `mixed` on this Mac and the harness says so);
   `npm run bench -- compare` against the Phase 1 baselines under
   `bench/baselines/` (walker 153k–167k entries/s warm, 82k at 1M; the app's
   gdu path ≈ 195k warm, 98k at 1M). The harness refuses `--record` on a dirty
   tree and refuses a series whose runs spread more than 5 %, and it prints
   `NOT COMPARABLE` when conditions differ — report exactly what it prints.
   Then the three **governor baselines**: `npm run bench -- governor
   --preset=eco|balanced|turbo --seconds=60 --record` (each on a quiet
   machine; the bench refuses a report whose target was scaled by
   interaction or heat, so do not touch the Mac during a run). The Tier B
   targets to compare against, and to state honestly if missed: warm Turbo
   400–700k entries/s, warm Eco 150–250k, CPU-seconds per million ≤ 3.0
   Turbo / ≤ 2.0 Eco. Record the numbers in `docs/engine/CURRENT-STATE.md`
   §11 and in the check-in.
4. **W6, Windows MFT turbo mode (D7, approved)** — the plan's last task:
   opt-in setting, an elevated read-only helper, the 1,000-entry cross-check
   that disables the mode on the first mismatch, declined elevation is not an
   error. It cannot be run here; parsers on synthetic records are the local
   proof. If the CI Windows leg cannot prove the live path, it ships behind
   the setting with `engineReason: 'not verified on this build'`.
5. Documentation that must move with the engine: `README.md:174` ("TreeMap
   ships no native code") and `docs/PLATFORM_NOTES.md:18` ("ships no native
   addons") are now false and must be rewritten in the commit that ships the
   engine — the prompt forbids any performance number in the README that did
   not come from `bench/` on a named machine under named conditions;
   `docs/engine/DESIGN.md:127` still names `crossbeam-deque` although the walk
   uses a std queue (fix the sentence); `SECURITY.md` already names
   `treemap_core.node` (a test requires it). Then the Phase 3 check-in and a
   HANDOFF.md addendum.

## Phases 4 to 8

- **Phase 4** — `docs/superpowers/plans/2026-09-18-phase4-storage.md` is
  written: `tm-store` builds the finalized columns in `PackedScanStore`'s own
  layout in Rust (P4-1), the app reads them through views with no ingest copy
  (`PackedScanStore.fromColumns`), spill mode (`write()` then a private
  `mmap`, the 3× free-space and same-volume rules, cleanup on forget/quit/
  startup), aggregate-only mode with its UI notice naming what is off, and
  a synthetic 100M-entry gate through a scripted `Lister` measured by the
  bench child (labelled `source: synthetic`, never a throughput baseline).
  Decision P4-9 records why an mtime-keyed incremental rescan cannot be
  faster than the bulk walk and defers change-journal rescan (FSEvents/USN)
  to a Phase 8 decision. Ceilings: 100M ≤ 1.5 GB spill, ≤ 400 MB aggregate;
  5M-projected in memory ≤ 700 MB.
- **Phase 5** — write its plan first (`docs/superpowers/plans/…-phase5-duplicates.md`,
  the same format: fixed interfaces, a progress table, bite-sized test-first
  tasks, the crates it adds named with their licences). Then: (duplicates: size buckets → BLAKE3 sample of head/middle/tail →
  full digest → optional byte compare; per-device read scheduling; persisted
  digests; hard links and clones never reclaimable; **cloud placeholders
  provably never read** — the legacy finder can download evicted iCloud files
  today, RISKS R1, and the first commit of Phase 5 fixes that), **Phase 6**
  (near-duplicate fast tier: EXIF thumbnail / shrink-on-load decode, pHash +
  dHash + colour hash, multi-index hashing, union-find, a cache; the legacy
  dHash scored precision 0.18 on the labelled corpus and R50 warns the
  corpus may be unfair to hash signatures), **Phase 7** (the opt-in deep
  tier, D8 approved: consent, pinned-checksum download, ANE on Apple
  silicon, off by default), **Phase 8** (UI badge and live readout, README
  numbers from `bench/`, the CI perf regression gate as an in-job A/B, the
  same-origin decision from R52, the Eco headroom tuning from R52a) — each
  needs its plan written in the same format (`docs/superpowers/plans/…`,
  fixed interfaces, a progress table at the top kept current, bite-sized
  test-first tasks) before its first line of code, and its own review fleet
  and gate before its check-in.

## Decisions the owner still owes — ask in a check-in, keep working on what needs none

- **Rust crates are approved (D10, 21 September 2026)** for Phases 5–8:
  BLAKE3 for the duplicate digests, an image decoder and DCT for the fast
  near-duplicate tier, an embedded key–value store for the digest and
  signature caches. Pin each in `Cargo.lock`, build in CI only, name each one
  and its licence in the phase's plan, and keep `npm install` free of cargo.
  A frontend dependency is still forbidden; a runtime npm dependency beyond
  D8's two for the deep tier still needs its own ask.
- Anything the master prompt's §15 lists: a public API shape change (only
  additive changes so far, D6 approved), the offload digest algorithm (do not
  change it), a frontend runtime dependency (never), elevated privileges (D7
  approved for MFT only).
- Two smaller ones, flagged and parked: the Dashboard note's wording for the
  thermal case ("when the Mac runs hot" is macOS-specific; a platform word is
  needed for Windows and Linux), and whether a volume without file ids on
  Windows should report every leaf as `withheld` (the crate's contract) or
  something friendlier.

## How the last session worked, so you can work the same way

- Parallel implementer agents on disjoint files, each with a fixed interface
  from the plan, test-first with a mutant per behaviour, forbidden from
  `npm test`, committing nothing; you review their reports, run the gates,
  and commit. A review fleet (ECC typescript/security/silent-failure/
  type-design reviewers, plus `ecc:rust-reviewer` for Rust) reads the diff
  read-only and reports at file:line; you verify each finding in the code
  before fixing it red-first.
- Agents die on usage limits mid-task. Their files stay on disk. Resume one
  with `SendMessage` telling it to re-read its own files before editing; keep
  the plan's progress table current so a compaction or a limit loses nothing.
- The equivalence gate (`tests/nativeEquivalence.test.ts`) is the oracle for
  any change to an engine or the store: if it goes red, the engine is wrong
  until proven otherwise; never loosen it — the only normalisations are the
  ones DESIGN §16 lists.
- `npm run bench -- clean` removes the corpora (~11 GB under
  `os.tmpdir()/treemap-bench`); `bench/results/` is gitignored; give the
  owner the `cd … && npm run bench -- clean` line if they ask about disk
  space.
- Verification traps this repo has already paid for are in the memory notes
  and in `HANDOFF.md`'s earlier sessions: a check that passes for the wrong
  reason, a mutant never applied, a stub that agrees with itself, a
  background harness that outlived its agent. Watch each test fail first.
