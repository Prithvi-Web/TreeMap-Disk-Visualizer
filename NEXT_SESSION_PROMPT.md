# Prompt for the next session

Copy everything below the line into a fresh session started in
`/Users/prithvivinay/Desktop/Claude Code/Treemap`.

---

## RESUME HERE — the 10-hour run (started 23 September 2026, ~05:40 UTC)

**The owner's instruction, verbatim:** *"Do not stop at all for 10 hrs straight. And complete as much as possible in these 10 hrs. Follow the roadmap and keep testing and coding is a flawless workflow. Where everything is tested and the CI is also tested after each step. use the ECC and Gstack combo to code for 10 hrs straight. and then use the strategic compact and before compacting take note of everything so then after the compact is completed... no time is wasted. I need this to be done completly flawlessly."*
**Asked, not yet answered:** may I push to `main` myself during this run so CI runs after each step? Until the owner says yes: verify every step locally (full gate), commit, and ask the owner to push at check-ins. **Never `git push` without that yes.**

**This block is the live state. Update it after every task.** Everything below the next `---` is the older hand-over and is background.

### Done in this run (all committed; pushed up to `32d68ff`)
- `c390653` + `84ce030` CI: three Rust steps (fmt / clippy / `cargo test --no-fail-fast`, 20-min timeout), each teeing `cargo-output.log`; `scripts/cargo-annotate.js` turns it into annotations; the Node suite still runs after a Rust failure. Fixtures are `.txt` (`*.log` is git-ignored — the first commit silently lacked them).
- `4f47d5d` Rust pinned: `native/treemap-core/rust-toolchain.toml` = 1.98.1 (CI had floated on `stable` while this Mac had 1.97). Local cross targets for 1.98.1 installed.
- `32d68ff` governor hold test runs on `FakeSignals::default()` (the owner typing mid-hold scaled the target by 0.7 and failed it).
- CI run 35821154606 on `32d68ff`: **macOS fully green for the first time**. Linux 11 failures, Windows 18 (only 10 annotated each — the TAP annotator drops the rest unnamed).

### Diagnosed from CI run 35821154606 (see the annotations)
1. Stale pre-W4/W5 tests: Rust `tm-walk/tests/walk.rs` `start_and_probe_report_the_platform_as_unsupported` (`#[cfg(not(target_os = "macos"))]`, expects Unavailable; Linux gives Getdents, Windows ExtdDirInfo); Node `real module: scanProbe…` expects `unavailable` off macOS; five `real module` tests skip off macOS "until W4/W5"; `tests/nativeEquivalence.test.ts:258` skips (instead of failing) a forced native run that fell back off macOS.
2. Linux relatime: a directory atime older than its ctime or than 24 h is bumped by the first listing; `freezeTimes` stamps 2023 atimes and `utimes` sets ctime = now, so every directory's atime moves on Linux. Fix: directories get ONE per-process anchor atime (now + 30 min) — stable under Linux relatime, APFS and NTFS's one-hour rule; mtimes stay 2023.
3. gdu stand-in (`fakeGdu` in `tests/engineBudget.test.ts`) is `sh` + one `sleep` child: SIGSTOP stops the shell, not the sleep, and a SIGKILL orphans the sleep holding the pipes. Real gdu is one process. Fix: a loop of `sleep 0.01`.
4. Windows `tests/nativeEngine.test.ts`: `62 !== 60` in five tests (hypothesis: `chmod 000` means nothing on Windows and CI is admin, so the "denied" subtree's 2 entries are listed); sparse expectation must follow `blocksAreMeaningful` (false on Windows); child order must follow `SORT_CHILDREN` (false on Windows).
5. **Real Windows product issue (suspected, not yet proven):** `tests/incrementalRescan.test.ts` (2 failures) — the first scan now runs NATIVE (the test predates the native engine), the rescan runs on the walker; on Windows the native listing's directory mtimes come from the PARENT's NTFS index entry (lazily updated), the walker's from the directory itself, so the mtime cache never matches. Expect the same in the hidden Windows equivalence failures. Candidate fix: when a Windows directory is listed, take its times from the listing handle (`GetFileInformationByHandleEx(FileBasicInfo)` on the handle already open) — no extra open. Do NOT change those two tests to hide it.
6. Nine failures not yet visible (1 Linux, 8 Windows): fix the TAP annotator to name everything past its cap.

### In flight (update when each lands)
- Agent "gate": items 2 + the time-stable floor + the `:258` escape → files `tests/fixtures/edgeCases.ts`, `tests/edgeCases.test.ts`, `tests/nativeEquivalence.test.ts`.
- Agent "native tests": item 4 + item 1's Node parts → `tests/nativeEngine.test.ts`.
- Me — DONE, uncommitted, verified: (A) the TAP annotator names every failure past its cap, before the counters (2 tests, 2 mutants red); (C) the gdu stand-in's work is a loop of 10 ms steps and the tests pause once the stand-in's work process exists (`whenWorking`) — both Linux failures reproduced on macOS first (466 ms held; evictor timeout), product mutant (no SIGSTOP) reddens both; (D) `start_and_probe_report_the_platform_as_unsupported` gated to `not(any(macos, linux, windows))`, and a live Linux/Windows probe-and-walk test added (clippy clean on all three targets; can only run on CI).

- Me — DONE, uncommitted, verified: **item 5 fixed** — `DirTimes` / `Listing::own_times`: the Windows listing reports the listed directory's own times from the `BY_HANDLE_FILE_INFORMATION` `open_dir` already fetched; the walk records `(id, times)` in `Part::time_patches` (never for the root, whose times already come from stat_dir) and `merge` applies them after placement. Test `a_directorys_own_times_from_its_listing_replace_its_parents_copy` + 3 mutants red. `stat_path` shares the `own_times` helper. DESIGN §5.2 item 5 and the fast-rescan test's comment updated. Full Rust gate green: 153 passed, clippy clean on host/linux/windows (1.98.1). **Only CI can prove the Windows half.**

- Me — DONE, uncommitted: `docs/superpowers/plans/2026-09-23-phase3-w6-mft.md` (the W6 plan: crate `tm-mft`, M1 parser → M2 run lists → M3 tree builder → M4 volume reader → M5 live proof on CI's admin Windows runner → M6 helper/cross-check/setting/prompt; W6-7 records the one intentional difference — the elevated reader sees what the unelevated walker is denied).

### Committed since the push of 32d68ff (not yet pushed; verify with `git log origin/main..main`)
`f7c433c` TAP annotator names what it drops · `1bc3a19` gdu stand-in pausable · `cc6a0e2` Windows directory times from the directory itself + stale unsupported test + live Linux/Windows probe test · `a129845` the W6 plan · `e3b6a2d` gate: relatime-stable directory atimes (one anchor per process, +30 min; `freezeTimes` refuses after 30 min), time-stable floor = the builder's inventory, the P3-9 escape removed, module-missing skips FAIL on CI (demonstrated both ways).
In flight: agent "gate" (edgeCases/nativeEquivalence), agent "native tests" (nativeEngine.test.ts), agent "mft" (new crate `native/treemap-core/crates/tm-mft/**`, W6 M1–M3; may make items in tm-walk's windows.rs/lib.rs `pub`).

### Uncommitted right now (verify with `git status`) and how to land it
Mine (all individually verified): `scripts/tap-annotate.js`, `tests/tapAnnotate.test.ts`, `tests/engineBudget.test.ts`, `native/treemap-core/crates/tm-walk/{src/walk.rs,src/platform/mod.rs,src/platform/windows.rs,tests/walk.rs}`, `tests/incrementalRescan.test.ts` (comment only), `docs/engine/DESIGN.md` (§5.2 item 5), `docs/superpowers/plans/2026-09-23-phase3-w6-mft.md`, this file.
The two agents' files: `tests/fixtures/edgeCases.ts`, `tests/edgeCases.test.ts`, `tests/nativeEquivalence.test.ts` (agent "gate"); `tests/nativeEngine.test.ts` (agent "native tests"). **Read each agent's report and verify its claims in the diff before committing** (the last Node agent died mid-report once; its work was on disk and correct, but every claim was re-proven by hand).
Landing order: when both agents are done → `npm run build:native` → `npm run typecheck` → `node scripts/build-ui.js --check` → `npm test` (full; nobody editing) → the Rust gate (already green: 153 passed) → commits, one per concern: (1) ci: TAP annotator names what it drops; (2) test(gdu): the stand-in's work is pausable; (3) fix(walk/windows): directory times from the directory itself; (4) test: stale pre-W4/W5 tests + the live Linux/Windows probe test; (5) test(gate): relatime-stable directory atimes + the P3-9 escape removed; (6) test(native): Windows expectations; (7) docs: the W6 plan. Then ask the owner to push (or push, if they said yes) and arm the watcher: `Monitor` on `scratchpad/watch-ci.sh` after writing the new HEAD sha to `scratchpad/head.sha`.

**Also committed:** `ea55633` native-engine tests run on Linux/Windows (the 62≠60 was a `path.join` backslash vs a `/` split; sparse and order follow the platform's own facts). **Full local gate at `ea55633`: npm test 2,806 / 2,800 pass / 0 fail / 6 skipped; Rust 153 passed; typecheck and UI check clean.** Ready to push — watch for: whether libuv leaves `blocks` at 0 on Windows (the forced-native test will say).

### In flight since the batch (update when each lands)
- DONE `9c301a9`: W6 M1–M3, crate `tm-mft` (72 tests, 122 mutants red, one re-run by me; Rust gate 225 passed). The W6 plan now carries 8 binding corrections for M4–M6 (512-byte fix-up stride; `$MFT` bootstrap; stop at initialized size; `FastPath::Mft` needed in M6; create M5's hard links after the last write; …).
- **Sequencing decision:** when the tests-typecheck agent lands, verify+commit it, then take the **Phase 3 measurement while nothing else runs** (no agent, no build), and only then dispatch W6 M4+M5. Commands: see "What remains of Phase 3" §3 below (`npm run bench -- enumerate --corpus=ci20k --engine=native --runs=7 --cache=warm --record`, then enum200k ×5, enum1m ×5, `npm run bench -- compare`, then `npm run bench -- governor --preset=eco|balanced|turbo --seconds=60 --record`); record in CURRENT-STATE §11.
- CI watcher (`scratchpad/watch-ci.sh`) now waits on `git ls-remote origin refs/heads/main` moving off `scratchpad/remote-base.sha` (no API budget while waiting), then reads the run on the new tip.
- DONE `5c72bcf`: the test suite is type-checked (`tsconfig.tests.json` in `npm run typecheck`; 38 errors, all harness looseness; bite proven). Full gate at `5c72bcf`: npm test 2,806 / 2,800 / 0 fail / 6 skipped; Rust 225 passed.
- Measurement attempt 1 (ci20k, native, 7 warm runs): NOT RECORDED — the corpus build had just pushed the load to 19.6 (spread 70.7%). Attempt 2 at load 3.8: NOT RECORDED, spread 5.2% (rule < 5%); 197,832 entries/s, 11 CPU-s/M, 132 MB peak. **Finding: `enumerate` never sets a budget, so it measured the app default (auto → Balanced, 50 %)**, while the targets are per budget (Turbo 400–700k, Eco 150–250k) and the Phase 1 baselines predate the governor. Results under `bench/results/` (gitignored).
- DONE `e013544` (was agent "bench-budget"): `enumerate --preset` (default turbo), budget recorded, moved series refused, `compare` budget-aware; the child must load settings BEFORE applying the preset (the first load re-applies the saved setting). 110 bench tests. Limit: heat-scaling of a named preset is invisible (the scan record holds only the name).
- (history) Agent "bench-budget" (owns `bench/**`, `tests/bench*.test.ts`): `enumerate --preset=eco|balanced|turbo` (default turbo), budget {requested, effective per run} recorded in every result, a series whose effective budget moved is refused, `compare` treats budget as a condition (pre-governor baselines = "none"). After it lands: commit, then re-measure — native AND walker, each at turbo and eco, on ci20k/enum200k/enum1m — with NOTHING else running, then the 3 governor holds.
- DONE `28b2830`: W6 M4+M5 — `read_volume` (portable planner/bootstrap + thin cfg(windows) layer, read-only, 5 unsafe) and `tests/live_windows.rs` (retries up to 120 s: a raw read sees `$MFT` as last flushed; FAILS on CI if unelevated). 124 tm-mft tests, 94 mutants; Rust gate 277 passed. Plan corrections 9–15 added (M6's cross-check must not trip on recently changed files). **M6 (helper + cross-check + setting + prompt) is next for W6.**
- **RECORDED `b327796` (run 2, the baselines of record):** enum200k native Turbo 245,368 e/s ±2.1% 9.29 CPU-s/M; walker Turbo 125,862 ±2.6% 21.72; ci20k walker Turbo 118,841; ci20k native Eco 75,502 ±1.4%; enum1m walker Turbo 83,065; governor Eco 24.1 / Balanced 49.9 / Turbo 90.0 %. NOT recorded (spread ≥5%): ci20k native Turbo ±27.8% (T1 suspect), enum1m native ±5.3%. Tier B targets MISSED (stated in the commit).
- DONE `52dafce` (agent "tune", every claim re-proven by me): T1 — a Turbo walk starts at the performance cores (`hw.perflevel0.logicalcpu` where `hw.nperflevels` ≥ 2) and probes down first; Eco/Balanced unchanged. Re-measured by me: enum200k native Turbo **279,889 e/s, 714.6 ms ±3.0%, "PASS: 12.3% faster than the baseline (815.1 ms → 714.6 ms)"**, CPU-s/M 9.29 → 10.26 (+10%, the 4th worker's cost); ci20k native Turbo 203,548 ±5.5% (not recordable; was ±28%). T2 — `examples/attr_cost.rs`: no attribute > ~1% of kernel time; open+close per directory ≈ 40%; so ≤ 3.0 CPU-s/M is unreachable with one open + one listing per directory. Six mutants on a scratch copy (`scratchpad/mut-tune.sh`), all red. Risk: M3-only measurement (Pro/Max start higher, capped by the governor).
- **NEXT (in order):** (a) re-record the enum200k native Turbo baseline from the clean tree after `52dafce` (and try ci20k native Turbo); then the app-level overhead — `NATIVE_POLL_MS=100` poll slack (the walk's end is noticed up to 100 ms late) and the ~190 ms of the app-level scan outside walk + ingest (`scratchpad/attribute-native.ts` measured walk ≈ 520 ms + ingest ≈ 90 ms of ≈ 815 ms); measure each change with `npm run bench -- compare`, test-first; (b) harness follow-ups (queued list below); (c) CURRENT-STATE §11 + DESIGN: the Phase 3 numbers and the attribution; README only with bench-recorded numbers and conditions; (d) W6 M6 (helper, cross-check that ignores entries newer than the read, `FastPath::Mft`, the setting, Electron's prompt) or ship W6 behind the setting labelled `not verified on this build`; (e) the Phase 3 check-in (plain English, the table of measured-vs-target); then Phase 4.
- (history, run 1) **MEASURED 23 Sep 2026** (Tier B, M3 4P+4E 16 GB, macOS 27, warm, load 3–4, this session's own app running; results JSON in `bench/results/`, gitignored):
  - ci20k: native Turbo 120,912 e/s (±20.0% — NOT reproducible); walker Turbo 118,650 (±3.3%); native Eco 75,231 (±2.2%).
  - enum200k: **native Turbo 278,135 e/s (±2.3%), 7.85 CPU-s/M, 263 MB; walker Turbo 125,139 (±3.8%), 21.44 CPU-s/M → native 2.2× faster, 2.7× less CPU per entry.**
  - enum1m (cache `mixed` — kern.maxvnodes): native Turbo 79,389 (±6.5%, not reproducible); walker 82,676 (±3.0%) — no gain at 1M on this Mac (metadata I/O bound).
  - Governor holds 60 s: Eco 24.1 % (last half 24.2) vs 25; Balanced 49.9 vs 50; Turbo 89.4 (last half 90.0) vs 90 — all inside ±5.
  - **Tier B targets MISSED, to be reported as such:** warm Turbo 400–700k (best reproducible 278k); warm Eco 150–250k (75k); CPU-s/M ≤ 3.0 Turbo (7.85). Likely cost centres to attribute before claiming a cause: the per-entry Node ingest (Phase 4's P4-2 removes it) and fixed per-scan overhead on small corpora.
  - Harness defects found BY this run (fix in flight, agent "bench2"): a budgeted `--record` OVERWROTE the committed pre-governor baseline of the same name (restored from git, blob-identical; the new walker ci20k Turbo recording kept at `scratchpad/new-walker-ci20k-turbo-baseline.json`), and the first recorded baseline dirtied the tree so every later `--record` in the batch was refused. After the fix: re-run `scratchpad/measure-phase3.sh` on a clean tree.
  - To investigate: walker Turbo ci20k 168.6 ms now vs 130.8 ms in Phase 1 (pre-governor) — the Node shim's cost at Turbo, or machine load?
  - **ATTRIBUTION (diagnostic `scratchpad/attribute-native.ts`, enum200k, Turbo, warm):** the Rust walk ≈ 520 ms (≈383k e/s alone), the Node ingest ≈ 90 ms (≈15 %). The walk's CPU is **96 % KERNEL** (≈1.28 s kernel vs 0.05 s user per 200k entries): the cost is `getattrlistbulk` computing the requested attributes on APFS, ≈6.4 CPU-s/M in the kernel alone — so the ≤ 3.0 CPU-s/M target is not reachable with this attribute set; removing the ingest (Phase 4) cannot fix it. **Workers peaked at 3 of 8 under Turbo**: the hill-climber adds one per 250 ms interval and a sub-second walk lasts ~2 intervals. Tuning tasks (measure each): (T1) the climber's start/ramp for Turbo; (T2) the kernel cost per requested attribute (ACCTIME, ALLOCSIZE, DATALENGTH, LINKCOUNT, DEVID, FILEID, FLAGS) on enum200k.
- (history) MEASUREMENT RUN 1 (started after `28b2830` + this block): a background script runs, each gated on load < 4: ci20k native turbo ×7, ci20k walker turbo ×7, ci20k native eco ×7, enum200k native/walker turbo ×5, enum1m native/walker turbo ×5, then governor eco/balanced/turbo 60 s. Log: `scratchpad/measure-phase3.log`. **Do not edit any tracked file until it finishes** (`--record` refuses a dirty tree).
- (history) Agent "tests-typecheck": test files were never type-checked (root tsconfig = `src/**` only; tsx strips types). 38 errors in ~20 test files. It adds `tsconfig.tests.json`, fixes each error as (a) harness looseness / (b) a real test bug (proved by making the assertion fail once) / (c) a product type bug (reported, not fixed), and wires `npm run typecheck` to include it. No `as any`/ts-ignore allowed.
- Watcher armed on `f9d523e` (8 commits await the owner's push).

### Found, queued (not yet done)
- Bench harness (from agent bench2, after `2c…` — see git log): (1) cache state is not in any baseline name — make `recordBaseline` refuse to replace a file that differs in ANY condition `compare` checks, and add the cache state to budgeted names; (2) the git dirty check fails OPEN (a `git status` error reads as clean; `status.showUntrackedFiles=no` hides untracked code) — fail closed, pass `--untracked-files=all`; (3) `compare` ignores duplicates' `--min-size` and neardup's `--threshold`.
- Rust review of `cc6a0e2` (ecc:rust-reviewer): no CRITICAL/HIGH. LOW nit: `walk.rs` merge converts id→index with `usize::try_from` in the new patch loop but `id as usize` in the placement loop above — harmonise to the existing idiom in the next Rust commit (re-run the Rust gate).
- DONE `219db7f`: CI fetches gdu (`npm run fetch:gdu:dev`, SHA-256 against the pinned release's sums) before the suite, so (b) now runs on every leg — read what it reveals on Linux/Windows.
- `tests/edgeCases.test.ts` "a skipped case is a real inability" skips entirely on Windows — review whether that is a true inability.

### Queue after that (roadmap order)
1. Full local gate → commit → ask for a push → read the CI legs (watcher: `scratchpad/watch-ci.sh`, 150 s wait / 75 s run cadence — anonymous API budget is 60/h).
2. Item 5 (Windows directory times) once CI shows it; the Windows/Linux equivalence gate green.
3. Phase 3 measurement on a quiet Mac (`npm run bench -- enumerate …`, governor baselines) — only when no agent or build is running.
4. W6 (Windows MFT): write its plan first (`docs/superpowers/plans/…-phase3-w6-mft.md`); GitHub's Windows runners are admin, so CI can prove the live read.
5. Phase 3 check-in (plain English, measured numbers) → Phase 4 (plan already written).

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
