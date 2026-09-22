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

## Where things stand (verified 21 September 2026)

**Pushed.** `main` equals `origin/main` at `928257c`. The owner pushed on
19 September. Everything through the equivalence gate is on GitHub:
- the CI fix for the Node 20 worker (`daa1296`);
- Phase 2 complete (`2a9fa90` + `0bc3aa4`): the Rust governor
  (`crates/tm-governor`) held **22.6 / 47.0 / 89.2 %** against 25 / 50 / 90
  for 60 s each on this Mac; the napi module (`crates/tm-node`,
  `native/index.d.ts`, `scripts/build-native.js` → `native/prebuilt/<platform>-<arch>/treemap_core.node`,
  gitignored, built by CI on every leg); the budget in the app
  (`src/services/engineBudget.ts`, `src/api/engineRoutes.ts`,
  `GET /api/engine/capabilities`, `GET|PUT /api/engine/budget`,
  `POST /api/scan/:id/pause|resume`, the Settings row, `budget` in the scan
  stats with the golden fixture re-recorded); four ECC reviews and a Rust
  review, every finding fixed red-first;
- Phase 3, W1: the macOS `getattrlistbulk` walker crate (`crates/tm-walk`,
  `e984c34`) and the mount-point fix (`0a0ea2e`: a mount point carries the
  mounted root's attributes as `lstat` reports them — the gate's first real
  finding);
- Phase 3, W3: the equivalence gate (`928257c`): `tests/fixtures/canonicalTree.ts`
  (the digest), `tests/fixtures/edgeCases.ts` (13 of the prompt's §12.2
  cases built here, including two hdiutil mounts; the case-collision pair
  skipped on case-insensitive APFS with the reason), `tests/nativeEquivalence.test.ts`
  — the walker twice, gdu vs walker, native vs walker, and a forced load
  failure all digest identically on `smoke` (1,200 nodes), `ci20k` (20,000)
  and the 50-node edge fixture, apart from `accessedAt`, which gdu cannot
  record (DESIGN §16 amended).

**CI at `928257c` is red on all four legs, before the tests run.** The step
"Check the native core (format, lints, tests)" fails. Two causes, both
reproduced locally against the committed tree, both tiny, neither applied
yet — they are your first job:
1. `cargo fmt --all -- --check` fails on
   `native/treemap-core/crates/tm-walk/tests/walk.rs` (two hunks around
   lines 1249 and 1270: a test added in `0bc3aa4` without running fmt on that
   crate). Fix: `cd native/treemap-core && cargo fmt -p tm-walk`, then check
   that only `tests/walk.rs` changed.
2. `cargo clippy --workspace --all-targets -- -D warnings` fails on the Linux
   runners with `useless_conversion` at
   `native/treemap-core/crates/tm-governor/src/sample.rs:222` — `tv_usec` is
   already `i64` on linux-gnu (`i32` on macOS, so the host never sees it).
   Reproduce with `cargo clippy --offline -p tm-governor --target
   x86_64-unknown-linux-gnu -- -D warnings`; fix so both targets lint clean
   (e.g. `i64::from(st.tv_usec)` → a cast helper that is a no-op on i64, or a
   `#[allow]` with the reason; prefer a form that compiles on both without a
   lint).
Commit these as one `ci:` commit, then run the whole Rust gate on the host
and on both cross targets **with `--all-targets`**, exactly as CI does:
`cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`
(host), `cargo clippy --workspace --all-targets --target x86_64-unknown-linux-gnu -- -D warnings`,
the same for `x86_64-pc-windows-msvc`, `cargo test --workspace`.

**Uncommitted work on disk — finished by two implementer agents, reviewed by
nobody, verified only by their own reports.** 32 modified files (+1,271/−167)
and 9 new files (5,155 lines). `npm run typecheck`, `node scripts/build-ui.js
--check` and the host `cargo clippy --workspace --all-targets` are clean on
this tree. Treat it as two changes and commit them separately after you have
run their tests yourself:

*W2 — the native engine in the app* (`src/services/scan/nativeEngine.ts`,
`src/services/scan/nodeInput.ts` (`statToInput` extracted so both engines
share it), `src/services/scan/native.ts` (`TREEMAP_NATIVE_MODULE` is now the
only candidate when set, plus a test seam `setNativeLoadOverrideForTests`),
`src/services/diskScanner.ts` (selection forced → native → gdu → walker;
`engineReason`, `fastPath`, `fallbackReason`, `cpuSeconds`, `bytesRead`,
`peakRssBytes`, `placeholdersSkipped` on every record), `src/api/scanRoutes.ts`
(`buildScanStats` gains, after `budget`, in this order: `engineReason`,
`fastPath`, `fallbackReason`, `entriesPerSecond`, `cpuSeconds`,
`peakRssBytes`, `bytesRead`, `cacheHitRate`, `storageMode`,
`placeholdersSkipped`), `src/api/openapi.ts`, `src/api/settingsRoutes.ts`,
`src/services/settings.ts`, `src/models/types.ts` (`engine: 'auto' | 'native'
| 'gdu' | 'walker'` setting), `src/services/engineBudget.ts`,
`src/utils/mountBoundaries.ts` (`neverDescendPaths`), the Settings "Scan
engine" row (`src/ui/markup/110-modal-settings.html`,
`src/ui/app/235-settings-modal.js`, `045-persistent-live-index.js` with the
reason on hover, `165-command-palette.js`, `src/ui/styles/110-settings.css`,
`public/index.html` regenerated), `bench/lib/measureWorker.ts` +
`bench/lib/suites.ts` + `bench/run.ts` + `bench/README.md` (the `native`
engine choice), `native/treemap-core/crates/tm-node/src/lib.rs` (+351 lines:
`scanProbe`, `scanStart`, `scanPoll`, `scanPause`, `scanResume`, `scanCancel`,
`scanTake`; typed arrays handed over without copying; every export
`#[napi(catch_unwind)]`), `crates/tm-node/Cargo.toml` (+ `tm-walk`),
`native/index.d.ts`, `native/README.md`, `tests/nativeEngine.test.ts` (31
tests), `tests/engineSettingUi.test.ts` (9), `tests/fixtures/nativeEngineChild.ts`,
`tests/nativeLoader.test.ts` (+1), `tests/fixtures/goldenHarness.ts` +
`tests/fixtures/golden/responses.json` (re-recorded: only `sseComplete.stats`
changed, by the ten added keys; every other endpoint byte-identical; the
harness pins `engine: 'walker'` so the golden keeps guarding the store).
Its report: 10 mutants red; the one real defect the byte-identity test caught
was **child order** — libuv sorts `readdir` listings with `strcmp` off
Windows while `getattrlistbulk` returns APFS's hash order, so the ingest
emits each directory's children byte-sorted by name (which also makes the
hard-link "first name seen" choice match the walker's within a directory);
a single-file root is not native-eligible; the poll loop starts at 1 ms and
doubles to 100 ms so tiny scans do not report absurd rates. **Measured on a
20,401-entry temp fixture, warm and busy machine, 5 runs after a warm-up:
walker median 275,689 entries/s, native median 850,042 entries/s (3.1×);
`cpuSeconds` 0.036–0.044 s for native, `null` for the walker.** This is the
app's end-to-end number (the ingest runs on the event loop), not the crate's.

*W4 + W5 — the Windows and Linux listings in `crates/tm-walk`*
(`src/platform/windows.rs` 1,209 lines, `src/platform/linux.rs` 571,
`tests/windows_parse.rs` 16 tests, `tests/linux_parse.rs` 13, `src/platform/mod.rs`
(the `cfg` dispatch), `src/lib.rs` + `src/platform/unsupported.rs` (doc
wording), `crates/tm-walk/Cargo.toml` (`[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.61", features = [Win32_Foundation, Win32_Security,
Win32_Storage_FileSystem, Win32_System_IO, Win32_System_Ioctl,
Win32_System_SystemServices, Win32_System_Threading] }`, resolving to the
locked 0.61.2, nothing downloaded), `Cargo.lock` (+1 edge), and — outside its
ownership, flagged — `src/walk.rs` (+42: the Windows hard-link
**file-id collision rule**, which must live in the walk because a family
spans directories and workers). Its report: 88/88 crate tests on the host,
both cross targets `cargo check --all-targets` and clippy clean, 22 mutants
(20 red, two survivors resolved: one dead rewrite deleted, one guard recorded
as shadowed). Rules as implemented, mirroring libuv: every reparse point is a
symlink-kind leaf whose size is the UTF-8 length of the substitute name with
`\??\X:` (4 units) or `\??\UNC\` (6 units) stripped; a volume mount point is
a size-0 symlink-kind leaf, never descended; WSL links and `AF_UNIX` sockets
are denied like `lstat`; cloud tags and `RECALL_ON_DATA_ACCESS | RECALL_ON_OPEN
| OFFLINE` set the dataless flag; FILETIME goes through libuv's exact
`sec`/`nsec` split (a FILETIME of 0 lands in April 2009 and 2038 wraps —
mirrored, not corrected, because the gate compares against Node); Linux uses
raw `getdents64` + `statx` with `stx_mask` honoured like `RETURNED_ATTRS`,
`ENOSYS` → `fstatat`, `makedev` as glibc. **Eight things only the CI runners
can prove**, listed in the W4+W5 report and to be read against the first
Windows/Linux CI run with the native engine: libuv typing every reparse point
as a link; the `lstat` size of a cloud placeholder and of a volume mount
point; `ino` on ReFS; `nlink` versus the collision rule (the equivalence
digest is the proof); the `FindFirstFileExW` fallback on a volume without
file ids (every leaf would be `withheld` — an owner decision for exFAT/SD
cards); `statx` masks on FUSE/NFS/overlayfs; `prefixed_path` on a root with
forward slashes or a bare `C:`; `GetThreadTimes`, the `FILE_SHARE_*` sharing,
and `ERROR_DIRECTORY` → Vanished. The collision map costs ~28 B per candidate
file for the walk's duration (a Phase 4 item).

To land them: rebuild the module (`node scripts/build-native.js`), run
`npx tsx --test tests/nativeEngine.test.ts tests/engineSettingUi.test.ts
tests/nativeLoader.test.ts tests/goldenResponses.test.ts
tests/discoverability.test.ts tests/apiContract.test.ts
tests/polishServerStats.test.ts tests/scanCancel.test.ts tests/benchSuites.test.ts
tests/benchCli.test.ts tests/nativeEquivalence.test.ts tests/edgeCases.test.ts`,
the Rust gate above, then commit W2 (`feat(engine): the native walker is
selected when it can be as correct as the legacy one, and every fallback
names its reason`) and W4+W5 (`native(walk): the Windows and Linux listings
behind the probe — proven by the equivalence suite on the CI legs`), then
the full `npm test` (last full run: **2,682 passed, 0 failed, 5 skipped**, at
the Phase 2 commit, with the module loaded; expect ~2,760 now).

## What remains of Phase 3, in order

1. The two CI fixes and the two commits above; `npm test`; ask the owner to
   push; read the four CI legs (the Rust step, then the test step's
   annotations) and fix what the Windows and Linux runners reveal about the
   listings — this is the first live proof of `windows.rs` and `linux.rs`.
2. A **Rust review** (`ecc:rust-reviewer`, read-only) over `crates/tm-walk`
   (all of it, including `windows.rs`/`linux.rs`) and the scan bindings in
   `crates/tm-node/src/lib.rs`, then the fix round with red-first tests and
   mutants, as Phase 2's review was done (its two liveness findings are the
   pattern: a worker parked in a paused governor; a load without `Drop`).
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
- **Phase 5** (duplicates: size buckets → BLAKE3 sample of head/middle/tail →
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

- **A crates.io download for Phase 5+** (blake3, an image decoder, an
  LMDB/SQLite binding). The owner approved one download for Phase 2; Phases 3
  and 4 need none. Ask before adding any crate; say what it is for and that
  it is built in CI only.
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
