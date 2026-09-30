# TreeMap Ultra Roadmap

**29-30 September 2026.** This is one plan. It combines the original fast-scanner roadmap (master prompt v3, Phases 0-8) with everything the owner asked for on 29-30 September 2026.

*How to read dates and sizes here.* Events of 29-30 September are dated in UTC. Your Mac's Pacific clock is 7 hours behind: events of 30 Sep UTC before 07:00 fall on 29 Sep in Pacific time, and early events of 29 Sep UTC fall on 28 Sep (E0, for example, was measured 29 Sep 06:53 UTC, which is 28 Sep 23:53 Pacific). Earlier dates are as the commits and plans record them. **Disk and bundle sizes** are decimal (1 MB = 1,000,000 bytes; 1 GB = 1,000,000,000 bytes), the way Finder shows them. **Memory figures** are copied as the records print them, and those records count 1 MB as 1,048,576 bytes (strictly MiB), so a memory "MB" is about 5 % larger than a disk "MB"; the gates' memory ceilings (700 MB, 1.5 GB, 400 MB) are compared with those figures as printed. Sizes written KiB, MiB or GiB are binary.

TreeMap is a private, local map of what fills a disk, plus safe ways to clear it. Deletes of your files go to the Trash, never a hard delete. It is becoming a lighter and faster desktop app. The Rust scan engine is being built to walk a whole disk, up to 100 million entries, without running out of memory or hogging the machine. A Tauri shell replaces Electron and moves the backend into its own program, so backend work can no longer block the window. Whether that also makes the app smaller and cures the lag you saw is measured, not promised. Over time the backend moves from TypeScript into Rust, until the bundled Node runtime can be dropped. The TypeScript user interface stays. Every safety rule TreeMap has today stays, and every speed figure it shows will come from a measured benchmark.

---

## In plain words

- **Done:** the new fast scanner (written in Rust, a fast programming language) and the "speed limiter" that stops it hogging your computer. These are Phases 0 to 3. They are finished, with **three targets missed and recorded**: one speed target and two about how much processor time a scan uses. Two of the three are in Eco (the gentlest speed setting, which runs only on the Mac's power-saving cores); you chose on 23 Sep to keep Eco that way, which accepts those two. The third, processor time in Turbo (the fastest setting), is recorded as not met. The bigger and smaller reference machines the plan names cannot be tested here, so those rows read "not available on this machine".
- **Part-way:** Phase 4, which teaches TreeMap to handle very large disks without running out of memory. 12 pieces remain, and some are already partly built.
- **Your installed TreeMap is old.** It was built on 2 September and is 334 changes behind today's code. It does not contain the new scanner, so what you saw came from the old engine. Its label says "5.1.0", which looks newer than the published 5.0.1 release, but it is actually an older local build. The next release number must therefore be above 5.1.0.
- **Your three problems are diagnosed** (30 Sep, on today's code on your Mac): the biggest cause of the slowness and the lag is an automatic whole-disk index rebuild TreeMap starts after every scan (31 minutes here, with freezes of up to 111 seconds); big disks are also walked twice; the result sent to the window is far bigger than intended; and folders macOS protects were shown as empty by your installed version. See Track U. The fix plan is being written, each fix test-first.
- **Being landed in two pushes:** push 1 (30 Sep) carries the Trash guard (FG2, with its review fixes FG2b), the Windows test fix, and this roadmap with the Tauri plan and the diagnosis. Push 2 carries FG3's security fixes with their review fixes (FG3b); FG4, a separate security fix for an older problem the review found (a booby-trapped git project on a scanned disk could make git run a command as you; see "The order of work"); and T13d. two Phase 4 pieces (T13d's review fixes; T14, with its first three parts committed in its working copy); the detailed Tauri plan (a draft is written); the first Tauri preparation step (T-6: the backend asks where the app is instead of assuming Electron; committed in its working copy as `f021e8c`, with two review fixes after it); and a throwaway Tauri test app (the T-13 "spike", kept outside the repo), which checks what Tauri can really do before any Tauri code enters TreeMap.
- **Tauri: yes, we are switching, in two steps.** Tauri is a lighter wrapper that uses the web view already built into your computer, instead of carrying its own copy of the Chrome browser as Electron does. Electron is 234 MB of today's 369 MB app.
- **Step 1** replaces Electron with Tauri and moves the whole backend (the part that scans and deletes) into its own separate program. Heavy backend work then can no longer block the window. The window could still stutter from its own drawing, or from receiving a huge tree; that is measured (U3 below, the lag problem), not promised.
- **Step 2** rewrites the rest of the "engine room" (the backend) in Rust, so the app no longer needs Node, the JavaScript engine it carries. That is the big size cut.
- **An honest caveat:** after step 1 the app still carries Node. The `node` file on this Mac (Node v24) holds two versions, one per chip type (243.5 MB); its Apple-silicon part is 120.6 MB before any trimming. Which Node the sidecar will ship, and its size, are still to measure (TreeMap supports Node 20 and later, and the automatic checks run Node 20). Electron's 234 MB already includes its own Node. How much smaller step 1 makes the app has to be measured, not promised.
- **Your settings and history stay where they are.** What TreeMap keeps in its app-data folder carries over to Tauri; that is a rule of the move. The page's own saved settings in the browser's storage (the theme, the view choices, the sidebar, sort and city-view settings, the Clean Up list and the list of folders you scanned: nine in all) are already lost at every launch today, because the app picks a new address each time. The move will fix that or say plainly that it does not.
- **The automatic checks** ("CI": GitHub runs every test on a Mac, on Windows, on Linux, and on Linux set to Brazilian Portuguese) pass on three of the four. On Windows three tests fail because they were written wrongly; the app itself behaved safely and deleted nothing. The fix is in the next safety batch. The same run showed one wording defect in the app: the sentence it recorded blamed "the Trash" for a delete that the open-file safety check had stopped. That sentence gets its own test-first fix.
- **Two things you should know about your own folders.**
  - *Your Trash.* Some TreeMap tests reached your real Trash every time the full test suite ran on this Mac. `tests/compressionAdvisor.test.ts` put three 1,000-byte `holiday.mp4` files there on every run since 28 Jul, and still does on main until FG2 lands. `tests/cartCommit.test.ts` put six 1 KiB (1,024-byte) files, `f0.bin` to `f5.bin`, there on every run from 26 Aug until FG1 fixed it on 29 Sep. `tests/rateLimiterLanes.test.ts` read the list of what is in your Trash (names and sizes) on every run since 31 Aug; it moved nothing. Three more tests reached the Trash step with nothing to move: `openHandleGuard` and `polishServerErrors` used paths that did not exist, and `trashRefusal` used a Windows-only name that is refused before any system call. Two others (`openHandleGuard`'s whole-batch refusal and `timeCapsule`'s held-open log) relied on the open-file check to stop a real delete, and that check can miss under heavy load. FG2 found all of these in a full test run with its guard in place, and it makes each test use a stand-in Trash. FG2 is designed to block every test, and every program a test starts, from moving files to your Trash, emptying it or listing it; its own tests prove that before it lands. It is committed in its working copy (`fbbbc75`), not on main, and not yet passing every check: in its last full run, one timing-bound test (`benchScanHold`) failed while the Mac was heavily loaded (it passes alone). What to do with the files is your call (see "Open decisions", OD5).
  - *Your Downloads folder.* On 29 Sep at 22:19 Pacific (30 Sep 05:19 UTC), the throwaway Tauri test app had no download handler, and its web view saved two files of test data (`report.csv`, `blob-export.csv`) into your real `~/Downloads`. They were checked (test data only) and moved out, not deleted; `~/Downloads` is as it was. Every later test-app run installs a download handler, and "a download handler before any web-view run" is now a rule for every Phase T measurement build.
- **Your part:** when a batch passes every check, I tell you. You push it from GitHub Desktop (open GitHub Desktop, choose TreeMap, click "Push origin"). I never push.
- **Release:** none until every phase is finished, including Phase T step 2, and all four check machines are green. That is your rule, and it stands unless you change it in OD1. I cannot honestly give a date yet.

---

## What you asked for (29-30 Sep)

| # | You said | What it means | Where it lives here | Status |
| --- | --- | --- | --- | --- |
| 1 | "It wasn't able to scan my entire disk." | A scan of the whole Mac must finish. Every gigabyte is either measured or named as not measurable, with the reason. Where macOS refuses a folder, the scan must say exactly which one and why. | Track U, **U1**, plus Phase 4's large-disk modes | **Diagnosed 30 Sep** (see Track U); fix plan being written |
| 2 | "Secondly it was scanning for a super long time." | A whole-disk scan must meet a speed bar you accept, set from measurements on your Mac. It must show honest progress, and it must never do the same work twice. | Track U, **U2** | **Diagnosed 30 Sep** (see Track U); fix plan being written |
| 3 | "Thirdly it started glitching and lagging. I want every single one of these issues to be fixed." | The window must stay smooth during any scan. All three problems get fixed, and each fix needs proof: a test plus a measurement. None of the three counts as fixed until it passes the Track U gate, and the release waits for that gate. | Track U, **U1-U3** and the **Track U gate**; Phase T step 1; Phase 8 (frame measurements) | **Diagnosed 30 Sep** (see Track U); fix plan being written |
| 4 | "should the backend be converted to rust instead of electron since it is very heavy on the computers?" · "I meant Rust + Tauri" · "I want to convert from electron to tauri so please add it to the roadmap. With typescript and rust and the usual app" · "i wanted to switch to tauri so that treemap takes lesser storage" · "Just switch to tauri because it is faster and light weight thats the reason so do it" | Replace Electron with Tauri with the same features. TypeScript stays for the interface and Rust grows. The goal is less storage, less memory and a faster app, all measured. | **Phase T** (step 1 and step 2) | **Decided: GO (30 Sep, UTC).** My reading of "so do it" is to start now, alongside Phase 4; OD14 asks you to confirm that overlap. The draft plan is written, the first preparation step is committed in a working copy, and the throwaway test app is running. |
| 5 | "keep going until there is absolutely 0 errors. I need this entire app to be blazing fast" | "0 errors" means every test passing on all four CI machines after every phase, independent reviewer agents ("the review fleet") run over every change, and U1-U3 fixed with proof. "Blazing fast" means the measured targets below, never claimed until measured. Where the disk itself is the limit (see U2), the bar is one you accept from the measurements. | The whole roadmap; "Targets"; "Safety rules" | Standing rule |
| 6 | "make the doc called ultra roadmap.md which combines what i told you and the previous roadmap" · "i want this so i can share this roadmap to the next sessions with the prompt" · "make sure to include ultra-roadmap.md" | This document, committed at the repo root, and the prompt that starts the next session from it | `ULTRA-ROADMAP.md` at the repo root, committed in the same push as the FG2/FG3 safety batch; the next session's prompt is under "Starting the next session" below, and `NEXT_SESSION_PROMPT.md` points here | This file |

### What we know about 1-3

**Diagnosed on 30 Sep** by a helper that reproduced all three on main's code on your Mac; the findings, with their numbers and conditions, are under Track U below. In one line: the biggest cause of both the long scans and the lag is an automatic whole-disk index rebuild that TreeMap starts after every scan (31 minutes here, with freezes of up to 111 s); big disks are also walked twice, and the result sent to the window is far bigger than intended and was rebuilt up to 8 times. The facts gathered before the diagnosis:

- **Measured or read on your Mac on 30 Sep (UTC)** (Apple M3, 8 cores (4 performance + 4 efficiency), 16 GB, macOS 27):
  - The installed `/Applications/TreeMap.app` says v5.1.0. It is a local build of 2 Sep 2026 from commit `73abc4c`, 334 commits behind main. `73abc4c` is older than the v5.0.1 release (7 Sep), whose code says 5.0.1, as main's does.
  - It contains **no Rust scan module**. It scans with a bundled program called `gdu` ("gdu-turbo"). When gdu fails, the JavaScript walker re-runs the whole scan from zero. The installed code's own comments rate gdu at about 112k-129k items/s and the walker at 69k-97k. Those figures were measured by TreeMap on `/Applications` and do not carry over to other trees (CURRENT-STATE §11). TreeMap's Phase 1 benchmark measured both engines on this Mac at 1M entries: gdu 97,666 and the walker 81,953 entries/s (CURRENT-STATE §11.1; that version of the harness may read slow by up to 13 %).
  - The file system's own tally (`df -i`) is about **5.8 million** files and folders: 484,014 on the system volume and 5,333,841 on the data volume. A scan may count a different number. That tally is about 16 % above Phase 4's memory-mode limit, `T_mem` = 5M entries.
  - The data volume had 269 GB used, on a 494 GB disk. Across all its volumes, the disk had 314.6 GB in use when read on 30 Sep at about 05:00 UTC (the figure moves by several GB between readings). About 30 GB of that sat in volumes a TreeMap scan of `/` does not walk: Preboot 21.7 GB, Recovery 3.1 GB and VM 5.4 GB. VM holds swap and changes by the hour (4.3 GB at 05:38 UTC). The disk also holds three macOS-update snapshots.
  - Read from the code: in the desktop app, `electron/main.js:43` loads `dist/server.js`. The whole backend therefore runs inside Electron's main process, the same process that runs the window.
  - Read from the code, not clicked in the app: the "Open Full Disk Access" button does nothing. The window's link guard (`electron/lib/guards.js`) drops the System Settings link it opens, and a unit test (`tests/desktopPolish.test.ts`) asserts that drop, in the installed build and on main alike.
  - No TreeMap crash reports exist on this Mac since 22 Sep, the oldest report this Mac keeps.
- **Leading hypotheses (unconfirmed):** see U1, U2 and U3 below.

---

## Starting the next session

**For you:** open a new Claude Code session in the TreeMap folder (`/Users/prithvivinay/Desktop/Claude Code/Treemap`) and paste this:

```text
Continue building TreeMap. Read ULTRA-ROADMAP.md at the repo root first: it is the single roadmap. Then read NEXT_SESSION_PROMPT.md (its LATEST block says what was in flight when the last session ended), then the memory notes treemap-project.md (newest entries at the top) and treemap-owner-grants.md. Before starting anything new, check every piece of work the LATEST block lists as in flight. Then continue the roadmap's "order of work" exactly, keeping every rule under "Safety rules that never bend". I push from GitHub Desktop: tell me exactly when to click Push origin, and never push yourself.
```

**For the session that reads this:**
- This file is the roadmap. The detailed plan of every phase is in `docs/superpowers/plans/` (Phase T: `2026-09-30-phaseT-tauri.md`). The live state is `NEXT_SESSION_PROMPT.md`'s LATEST block and the memory note `treemap-project.md`, both updated after every landed piece.
- Work in flight lives in git worktrees under a scratch folder in `/private/tmp`, which macOS may clear on a restart. Every commit that matters is pinned as `refs/cands/*` in the main repository, which survives a restart; uncommitted work in a worktree does not. Each helper keeps a `STATUS.md` beside its worktree, and the helpers' briefs and standing rules (`RULES-COMMON.md`) have durable copies in `~/.claude/projects/-Users-prithvivinay-Desktop-Claude-Code/treemap-scratch-tools/session-f4f5ece4/`.
- Landing works one way: a helper commits in its own worktree; the coordinator replays it onto main's tip, pins it, runs the full gate (`ci-sim`: fmt, clippy on three targets, cargo test, the native build, typecheck, `build-ui --check`, the full `npm test`), and fast-forwards main only when every step is green; the owner pushes; the coordinator reads every CI leg.
- Never run the full `npm test` while another full run or a heavy build is going: load-bound tests (the governor's hold band) fail under a busy machine and pass alone.

---

## The order of work

**The rule for every step:** a piece of work lands only when it is **gated green**. That means `npm run typecheck`, the full `npm test` with 0 failures, `node scripts/build-ui.js --check`, `cargo fmt`, `cargo clippy -D warnings`, `cargo test`, and the cross-target checks all pass. Every new assertion must be proven by a mutant, and the review fleet must have run over the diff (RISKS R48). **After each phase, CI must be green on all four legs (macOS, Windows, Linux, Linux pt-BR) before the next phase starts.** After each phase you also get a short report: what was built, the measured numbers against the targets, what surprised us, and what we now believe is wrong in the master prompt (MP §15). Work lands on main in small commits and you push; that replaces the master prompt's branch and pull request per phase (DESIGN D9, decided 18 Sep 2026). The assistant commits and never pushes.

1. **Land the fixes in flight** (state at about 06:50 UTC, 30 Sep).
   - **FG2** is the guard that stops any test from reaching the machine's real Trash (moving to it, emptying it, listing it), deleting Time Machine snapshots, trashing a cloud file, or running a real `git gc --prune=now`. Commit `fbbbc75` (pinned `refs/cands/FG2`). **Gated:** the full `npm test` passed (3,404 tests, 0 failures); the one Rust failure is `tm-governor`'s `holds_nineteen_percent_of_this_machine_for_ten_seconds`, which cannot hold its band while other builds load the Mac (load 57-108) and is re-run alone when the machine is quiet. An independent review (four lenses, each finding checked by a skeptic) confirmed five LOW findings; **FG2b** fixes them, including `tests/queryToPolicy.test.ts`, which created and hard-deleted a folder `~/q2p-fixture` in your real home on every full run (it does not exist now), and 18 test files that are guarded only when run the normal way.
   - **FG3** holds the security fixes (writers that follow planted links, capsule id checks, the offload restore rule, keeping undo copies of trashed items) and the Windows CI fix. Its root cause is confirmed by a reproduction on the Mac: the Autopilot variants never set the open-file check, which could not answer on the Windows runner, so the unattended run was refused before trashing. Four commits, replayed onto FG2 as `a60ad4a`, `331cf66`, `80cf3f6`, `293fbfe` (pinned `refs/cands/FG3-*`); **gated:** 3,425 tests, 0 failures (the same load-bound Rust test aside). Its review confirmed 18 findings in FG3's own changes (one regression: a folder and an item inside it in one delete gave two undo entries; one slow synchronous check; 16 LOW); **FG3b** fixes them before the batch lands. The wrong sentence the Windows run showed is fixed in FG3 (`blockedReason` now gives the real reason).
   - **FG4 (security, older than this work):** the FG3 review also found that TreeMap runs `git status` (and other git commands) inside any repository under a scanned folder with no hardening, so a booby-trapped repository (a second-hand drive, an unpacked archive) can make git run a command as you, reached by read-only scoring (the reclaim score, `elsewhere:` queries, the facts API). Reproduced by the reviewer; present since 25 Aug (`d6ee1bf`, `cd30b21`), so in the installed build too. Also: `git gc --prune=now` can be redirected by a planted `.git` file to a repository outside every scanned root; the macOS snapshot restore checks its destination once before a privileged `cp -a` (a time-of-check gap); a portable data folder prepared by someone else is trusted. FG4 fixes all four, test-first, and lands in the push after this one if it is not ready in time.
   - **Push 1 (30 Sep):** FG2 `fbbbc75` → FG2b `ce7294a` → FG3's Windows CI fix `703b98d` → the docs commit (this roadmap at the repo root; the Tauri plan `docs/superpowers/plans/2026-09-30-phaseT-tauri.md`; the spike's facts `docs/desktop/TAURI-FACTS.md`; the diagnosis `docs/engine/TRACK-U-DIAGNOSIS.md`; `NEXT_SESSION_PROMPT.md`'s new LATEST block). Each commit gated green (the governor hold test, which fails only under load, passed on the identical Rust tree). Then you push, and CI must be green on all four legs.
   - **Push 2 (next):** FG3's three security commits (offload, compression, capsule; gated green as `847d096`, `3fd247b`, `c78a0bf` on the pre-docs base) with **FG3b** (their review fixes, including the one regression), **FG4** (git hardening) and **T13d** (the hard-link log), each replayed onto push 1, gated and reviewed.
   - **T13d** finishes its review-fix round (the hard-link log) and lands in a later push.
2. **Track U fixes, from the diagnosis (done 30 Sep; `docs/engine/TRACK-U-DIAGNOSIS.md`).** The fix plan (`docs/superpowers/plans/2026-09-30-trackU-owner-issues.md`, being written) orders the tasks; each starts with a failing test and lands gated green. The quick, independent ones (the automatic index rebuild, the result watchdog, the Full Disk Access button, the startup stalls) go first, alongside Phase 4; the ones inside Phase 4's territory (the memory ceiling, the store) merge into T16/T17.
3. **Phase 4's remaining tasks, in plan order:**
   - T14 (T14a-c committed in a worktree, T14d to come), then T15b, T16, T17 (the rest after T17a), T18, T19 and T20.
   - Then T21 (bench plumbing), **T22 (the Phase 4 gate)** and T23 (docs).
   - The owner confirms T0's open items (Q2, Q4, Q7; OD2) before T22. OD9 (what your own disk loses in spill mode) is answered before T22 too.
4. **Track U fixes.** Each lands gated green, either inside Phase 4 where the cause lives there or as its own task. U1's large-disk part is Phase 4 itself (T14, T16, T17, T19). Phase T step 1 moves every remaining backend stall out of the window's process; the Track U gate measures whether the lag is gone.
5. **Phase T step 1 (the draft plan's Phase S and Phase T), started alongside Phase 4.** That is my reading of your "so do it", not your words; OD14 asks you to confirm the overlap. Step 1 swaps in the Tauri shell, runs the TypeScript backend as a separate sidecar process, and trims dead weight.
   - Until OD7 (the new Rust crates and tools) is answered, only work that adds nothing new to the repo goes ahead: the plan, the throwaway spike (outside the repo), Phase S (T-1 to T-5) and the backend preparation (T-6 to T-12). The shell itself (T-14 onwards) waits for OD7.
   - Dropping the bundled gdu from the macOS app waits for OD8. The Windows build's gdu, which never runs, goes in T-5 with no API change.
   - Each piece lands only gated green, one at a time, from its own worktree. After every push, CI must be green on all four legs before the next push. Phase 4 closes with T22 and CI green; step 1 closes with its own gate and CI green, whichever comes first.
   - If step 1 lands before T22, the Phase 4 gate measures the sidecar runtime in place of Electron (see Phase 4).
6. **Phase 4 closes.** T22 must pass and CI must be green on all four legs.
7. **Phase 5: exact duplicates.** Then its gate, then CI green on four legs.
8. **Phase 6: near-duplicate images, fast tier.** Then its gate, then CI green on four legs.
9. **Phase 7: near-duplicate deep tier (opt-in).** Then its gate, then CI green on four legs.
10. **Phase 8:** UI, docs and the CI performance gate. Its frame, packaging and performance measurements are taken **on the step-1 Tauri build**. Its gate must pass and CI must be green on four legs.
11. **Phase T step 2 (the draft plan's Phase R), by default here.** Your rule says no release until every phase is complete, and Phase T is a phase of this roadmap. So by default step 2 runs before the release. OD1 asks whether you want to change that. Step 2 ends with its own gate and CI green on four legs.
12. **On the final build:** Phase 8's frame, packaging and performance measurements and its Definition-of-Done audit (T26) run again, so the release is judged on what ships.
13. **The Track U gate** (below): U1, U2 and U3 each pass on your Mac, on the build that ships.
14. **Release.**
    - First the Definition-of-Done audit (Phase 8 T26), which includes U1-U3 and Phase T as rows, with the owner running `scripts/verify-dod.js`.
    - Then the assistant prepares the version bump and a plain-English CHANGELOG, committed. The version must be above 5.1.0, so that no installed copy looks newer than the release. The release notes stay discreet about exploit detail (the standing practice recorded on 23 Sep).
    - The bridge for existing installs ships with it (OD12): the same release carries what today's Electron installs need to find the Tauri version, so it counts as part of this one release. If one release cannot carry both, it becomes an exception you approve in OD12.
    - The owner pushes, tags and publishes. The assistant never pushes a `v*` tag.
    - Phase 8 T26's text says the owner bumps the version and writes the CHANGELOG. It is amended to match your 24 Sep grant: I prepare both, you publish.
15. **Only if you change your rule in OD1:** the first release comes after steps 10 and 13 on the step-1 build, and step 2 follows it. The backend moves into Rust route by route, and each route lands gated green and byte-identical. Node is dropped at the end. Each later release is your call.
16. **End of roadmap:** every test corpus is deleted (really removed, not Trashed), per the owner's rule. Test corpora stay at most 40 GB at any time (your 24 Sep grant; see OD11 for the one plan that asks for more).

Step 2 starts after Phase 8's gate. Phases 5-8 all add or change routes (Phase 8, for example, adds `GET /api/scan/:scanId/live` and a same-origin guard on `/api`), and they build on Node-only pieces: the napi modules, better-sqlite3, sharp and onnxruntime-node. Porting a moving target is wasted work. The draft Tauri plan orders it the same way (Phase R after Phases 5-8).

---

## Phase by phase

### Phases 0-3: done on this machine (Tier B)

| Phase | What it delivered | Evidence |
| --- | --- | --- |
| 0 | Verification and design: `docs/engine/CURRENT-STATE.md`, `DESIGN.md`, `RISKS.md` | CURRENT-STATE recorded 18 Sep 2026 against `716beb6`. RISKS carries R1-R97. **The gate** (a 100M-entry memory budget under the §5.3 ceilings) is DESIGN §7: ≈742 MB in spill and ≈396 MB aggregate-only at Phase 0 (`HANDOFF.md`), since amended by Phase 4's plan §S.3. |
| 1 | Benchmark harness (`npm run bench`), seeded corpora, legacy baselines | Baselines `aa4f9f4` (18 Sep). Gate at `95df765`: 2,601 tests, 2,596 pass, 0 fail, 5 skipped (`HANDOFF.md`). **The gate's 5 % rule:** the harness refuses to record a series whose spread exceeds 5 % (the enum1m baselines: gdu ±1.0 %, walker ±3.1 %). The gdu path's warm figure (≈195k entries/s) never came under that rule (R51) and is not a recorded baseline. |
| 2 | Resource governor (Rust `tm-governor` + `tm-node`), Eco/Balanced/Turbo budgets | `2a9fa90` (18 Sep). The 60 s holds recorded at `b327796` (23 Sep): Eco 24.1 %, Balanced 49.9 %, Turbo 90.0 % against 25/50/90. **Tier B only.** The master prompt's gate asks for all three tiers; Tier A and Tier C are not available on this machine (R25), and Phase 8 T26 records a hosted Tier C run, labelled as such. |
| 3 | Native walker `tm-walk` (macOS bulk listing, Windows, Linux); opt-in Windows MFT mode (W6) | Gate passed 24 Sep 2026 on the available tier. CI run 35947322361 on `abc5c2c` green on all four legs. enum200k warm Turbo 412,291 entries/s at `17eb13d`. Three targets missed and recorded (below). |

Left open from Phase 3:
- **Three targets missed** (measured; see Targets). Warm Eco throughput and CPU-seconds per million at Eco: owner-accepted 23 Sep 2026, with the decision to keep Eco at Background QoS (the decision named the Eco CPU row; the throughput miss follows from it). CPU-seconds per million at Turbo: not met, and not owner-accepted.
- Windows and Linux throughput unmeasured on a tier machine.
- Linux io_uring deferred.
- One scan queue, not one per device: an intentional departure from MP §7.4 (DESIGN §5.2). Device ids are recorded for the hard-link key and never key a queue; per-device read queues now live in Phase 5 T9.
- The Windows MFT mode's UAC prompt is "not verified on this build".
- The W6 plan's own gate row still reads "not run", which is possibly stale.

### Phase 4: storage and the 100M path (in progress)

**Goal:** the Rust store builds every scan in the packed store's exact layout, so the JSON stays byte-identical. There are three modes, chosen before the walk: `memory` (up to `T_mem` = 5M entries), `spill` (columns in unlinked files under `<appData>/scan-spill`) and `aggregate` (a bounded summary). Features a mode cannot serve answer `409 STORAGE_MODE`.

**What this means for your own disk.** On main today, nothing enforces `T_mem` yet: every native scan uses the memory store, whose room is 6,187,500 rows, above your disk's 5.8M. After Phase 4, the chooser projects a rescan at 1.25 × the previous scan's count. For your disk that is about 7.25M, which is above 5M, so your whole-disk rescans will likely run in **spill mode**. In spill mode, by `src/services/storageMode.ts`'s table: Duplicates, near-duplicates, Compare, Empty Folders, the custom rule for names and sizes that occur more than once, per-file export (CSV or XLSX) and whole-folder offload stay off until they are ported to native code (Q6; RISKS R81). Live mode, opening an archive or Photos library inside the scan, and moving cloud files to the provider's trash are off because a spill scan is read-only after the walk (Q5 and P4-6a). T18's FullPassRunner keeps the full-pass views working in spill (cleanup suggestions, custom rules without the duplicate option, queries, the calendar and others); it restores none of the features above. Under Q10 (decided, not built: P4-14), a native failure above `T_mem` fails the scan with its reason instead of falling back, which is the shape of your U1 complaint. OD9 asks you to choose before T22.

**Done:** S1 (`2415d6c`) · S2 with T10 (`9f59e5c`, `5945a96`) · T1-T12 (including T6b, T6c, T7a/b, T8a-c, T9, T9b, T9c, T11, T12a-f) · T13a-c · T15a · T17a · FG1 (on main as `2ab551b`, `d1def61`).

| Task | What | State (30 Sep, UTC) |
| --- | --- | --- |
| T0 | Design documents. The gate is the owner's answers. | Q1, Q3, Q5, Q6, Q10, Q13 and Q16 decided (Q10 and P4-14 are decided but not built). **Q2, Q4, Q7 await confirmation** (OD2); T0's gate names Q1-Q5 and Q7. Q8, Q9, Q11, Q12, Q14, Q15 and Q17 are also engineering decisions you may overrule; none gates T0. |
| T13d | Link-log 32 MiB resident cap and sorted disk runs | Built; review-fix round in its worktree; not on main |
| T14 | SpillSink: external sort, patch/block logs, seal passes, load-back | T14a (`074cc7f`), T14b (`9b6e2e1`) and T14c (`264f2d2`) committed in a worktree, not on main; T14d not yet committed |
| T15b | Summary, `spillLookup`/`spillSelect`, sync-call counter, forced-spill golden leg, spill RowSource | Not started (needs T14) |
| T16 | Chooser and in-walk conversions, including the switch to aggregate when free space falls (R3). **Tauri-affected:** the chooser's table has a runtime dimension (plain Node or Electron, each with its own `T_mem`, set by T10). After Phase T step 1 that becomes the Node sidecar, and `T_mem` is measured again there. | Not started |
| T17 | Node wiring for S3: `/api/scan/:id/storage`, real `storageMode` and `disabled[]`, chooser settings (the planned `storageSpillThreshold`) and openapi, the notice, the missing-gigabytes line, release on forget/evict/quit, the Windows walk kept out of `scan-spill` (R97), nativeEquivalence leg (c'), full `npm test` under busy loops | Not started (T17a done) |
| T18 | FullPassRunner and NativeScanStore, worker-only (commit S3b). **Tauri-affected:** its test loads the addon in a worker "inside the installed Electron". | Not started. R96 is fixed and proven: the fix `9a8d76f` is on main, and the Windows leg's worker-only probe passed in CI run 36534635490 (on `3670f98`) and again in 36663542819. |
| T19 | Aggregate end to end (commit S4). It includes T17a's review item: reclaim score, `reclaim_ranked` and the journal must degrade in aggregate. | Not started |
| T20 | Windows large mode: OpenFileById refresh, CI fixture, fix for finding F1 (the beta file heap when a hard-link family lists different sizes) | Not started |
| T21 | Bench plumbing: presets and variants, `--storage`, `--runtime=electron`, the footprint column, the view pass including the dashboard's automatic requests, and the event-loop delay p99 (the gate needs it, and so does U3). **Tauri-affected:** the second runtime becomes the sidecar once Phase T step 1 lands. | Not started |
| T22 | **Phase 4 gate (§S.8)**. **Tauri-affected:** its Electron-as-Node leg becomes the sidecar leg. | Not run |
| T23 | S6 docs: DESIGN, CURRENT-STATE §11, the openapi `storageMode` enum, README; RISKS updates (R96 proven; R4, R73, R86 below) | Not started |

**Measured since the last hand-over:** E0, Electron's main process at idle, is **199 MB resident** in the installed app (footprint 78 MB, peak 101 MB), within memory mode's E0 ≤ 227 MB. It was measured on 29 Sep 06:53-06:55 UTC (28 Sep, Pacific) with a throwaway profile, and the real app-data folder was checked unchanged afterwards (`8d3344e`, plan §S.11 Q16). **Caveat from the record itself:** it was measured on the installed 2 Sep build, and what main's server adds is not in the figure, so the 23 MB margin is still to measure for main (T-2, T22). The plan's Q16 record calls the installed app "v5.0.1"; it is the 5.1.0-labelled local build, and the record's label is corrected in the next docs commit.

**Still owed from earlier tasks:**
- T10's full `npm test` under 10 busy loops on mains power.
- The `rustdoc -D warnings` failure at `tm-store/src/memory.rs:77`. It is fixed in the T13d batch (currently `f75e7b2` in its worktree; the id changes when the batch lands), not yet on main.
- The boot sweep would keep a Docker PID-1 leftover forever.
- Three live-disk tests still hold wall-clock bounds, which breaks "count, don't time".

**Gate (T22):** the 100M synthetic scan peaks at ≤ 1.5 GB in spill and ≤ 400 MB in aggregate (every variant, plus the auto leg), and at ≤ 700 MB in spill at 10M. Memory mode stays ≤ 700 MB at 5M "in both runtimes". Every view answers with no main-thread native call over 1 ms, with the event-loop p99 recorded. Phase 3's digests are unchanged and the native golden legs are equal. Throughput is within 10 % of the Phase 3 baselines. The full `npm test` passes under 4 and 10 busy loops. CI is green on all four legs. "A miss is fixed before the commit, never relabelled."

**Tauri note:** "both runtimes" today means plain Node and Electron. T10 recorded 5M peaks of 533 MB in Node and 547 MB in Electron (record `c910f6a`, with the harness at `8047340`, whose own message first gives the 547 MB). After Phase T step 1 the backend runs in a plain-Node sidecar. The Electron-specific copy path (R72, R92, T9c) then no longer applies there, which may lower memory. That is **to measure**.

### Track U: the owner's three problems

**Diagnosed 30 Sep 2026 on your Mac, on main's code (`d1def61`).** All three problems reproduce on main. The full record, with every figure and its conditions, is `docs/engine/TRACK-U-DIAGNOSIS.md` (committed with this roadmap). The fix plan (tasks U-1…U-n, each test-first, each critiqued before it is built) is being written from it as `docs/superpowers/plans/2026-09-30-trackU-owner-issues.md`.

**Conditions that limit the numbers.** Main walked 9.1-9.35M entries here, not the ~5.8M `df -i` counts: the engineering scratch folders in `/private/tmp` (147.5 GB apparent, many APFS clones) and two iOS Simulator volumes mounted inside the data volume (about 1.18M entries, ~35 GiB) were walked too. Only one run (run 1) had a low load (4.4-6.7); the rest ran at load 9-395 because of other builds, including a runaway test that reached 43 GB. The server ran in plain Node 24, and **the Electron window itself was not measured** (a copy of Electron was blocked by macOS; see "Safety rules"): the window side is measured as the server's event-loop stalls, which are what freeze Electron's window, since the server runs in its main process (`electron/main.js:43`), plus the page's own main-thread work. The owner's disk as it was when 5.1.0 was used cannot be re-measured.

**The single largest cause, in both main and 5.1.0: the automatic whole-disk index rebuild after every scan.** The page starts `buildIndexInBackground` when a scan completes. It walks the whole disk a second time with a JavaScript `readdir` + `lstat` enumerator and writes every entry into SQLite. Here: **31 minutes** (1,853 s at load p50 18), a 2.63 GB database plus a 364 MB write-ahead log, the event loop **blocked for 32 % of that time** (2,744 stalls; 14 over 5 s; one `rollUpSizes` block of **111 s**), and a heap of **3,764 MB** against Node's 4,288 MB limit, which under Electron's ~4 GB limit is an out-of-memory risk (not verified).

#### U1: "It wasn't able to scan my entire disk."
- **Folders macOS protects (high confidence).** Without Full Disk Access, 981 folders were refused here (`~/Library/Mail`, `Messages`, `Safari`, and others). Main names them and carries their bytes as unknown. **5.1.0 did not:** its gdu engine reported 0 refused folders for every shard, so refused folders showed as silently empty and the total fell short. And the desktop app's "Open Full Disk Access" button does nothing (the window's guard drops the link; Phase T T-8 fixes it).
- **Totals that do not add up (high).** Against the volume's own figure (313.2 GB used), main's scan counted 428.7 GB: the missing-gigabytes statement ends at **−110.2 GB unaccounted** (TreeMap counted more than the volume holds). Causes: APFS clones counted at full size, and the walkers crossing into volumes mounted inside the scanned tree (the Simulator volumes, which have their own device id, while firmlinks share `/`'s). On the omission side, data-volume root folders that are not firmlinked to `/` are never walked (`.Spotlight-V100`, `.DocumentRevisions-V100`, `.fseventsd`, `.TemporaryItems`, `MobileSoftwareUpdate`, `sw`). Firmlinked folders are not double-counted.
- **A counter that freezes (high, as what a user experiences).** On main, past the memory store's room (6,187,499 entries) the scan walks again silently: the counter stood still for 65 s (run 1) and about 16 minutes (run 3), which looks like a hung scan. On 5.1.0, the gdu output for `/private` (592.7 MB) was over the 450 MiB shard cap: 5.1.0 threw, **reset every counter to zero**, and started again with the slower walker. Whether the owner's own 5.1.0 scan hit that cap depends on what was on the disk then and cannot be known.
- **Fix path:** the Full Disk Access button and a clear on-screen count of what could not be read (Track U plan; Phase T T-8); a device boundary for both engines together (the equivalence rule) and the missing-gigabytes lines for what a scan of `/` cannot walk; clones reported honestly until Phase 5 detects them; no silent second walk (U2); gdu's silent-empty mode removed with gdu (OD8) or fixed.

#### U2: "it was scanning for a super long time."
- **Main, run 1 (low load): 231.7 s for 9,115,094 entries** (native engine, bulk listing, budget Automatic → Balanced): walk 1 took 96 s to reach the memory store's ceiling, walk 2 (the columns path) 128 s, the ingest 7.4 s. **About 41 % of the scan was the wasted first walk.** Then the index rebuild above: **31 more minutes** of disk work.
- **5.1.0 (its own gdu v5.36.1 and mapper, re-run here):** the five shards took 166 s in all, one after another (`/Users` 72.2 s, `/private` 78 s), the counter moving only between shards; `/private` failed the size cap, so all of that was thrown away and the JavaScript walker started over (measured proxy: 9,347,504 entries in 434.5 s, 21.5k entries/s, at load 15.5); then the same index rebuild.
- **Causes, ranked:** (1) the index rebuild after every scan; (2) the memory ceiling and the re-walk; (3) Balanced as the budget for a scan you start and watch (Automatic becomes Eco on battery or when hot); (4) the mounted volumes crossed (~1.18M extra entries).
- **Fix path:** stop the automatic whole-disk rebuild or build the index from the scan's own store off the main thread; size the store before walking (or convert without re-walking) with progress always visible; the device boundary; and Turbo by default for scans you start (OD16, answered yes on 30 Sep).

#### U3: "it started glitching and lagging."
- **Measured as main-thread stalls** (in Electron these freeze the window: beachball, no response), attributed with CPU profiles:
  1. **The index rebuild** (above): stalls of 111 s, 40.8 s and 29.8 s.
  2. **The completion burst.** The columns ingest runs on the main thread (7.4 s at low load). The first tree sent to the window is **238.6 MB, 671,545 nodes, against a 250,000-node budget** (the prune expands whole folders and every node carries its full path); the server's count pass takes 0.75-3.6 s. The page's watchdog asks for the result every 3 s after 6 s without progress events, with nothing stopping a second request while one is in flight, so the server **built that 238 MB tree 4 times (run 3) and 8 times (run 2)**. `collectCleanupSuggestions` blocked 13.4 s. In the page, `JSON.parse` of the tree took 1.9 s and `finishScan` 1.35 s; with the pane visible, the completion was one 5.2 s long task.
  3. **Opening the app:** `/api/zombie-handles` starts one `ps` per process (0.68-1.9 s stall), and startup loads the Excel, PDF and MCP libraries eagerly (0.56-1.65 s).
- **What is not the cause:** during the native walks the event loop was fine (worst stall 63-243 ms), and once the map is drawn it is smooth (drill-in 32-50 ms, hover under 0.1 ms).
- **Fix path:** the index fix (U2); the ingest off the main thread; a first tree that honours its budget; one result request in flight with real heartbeats and a cached serialized result; cleanup suggestions off the main thread; the startup fixes. Phase T step 1 separately moves every remaining backend stall out of the window's process.
- **Not measured:** the Electron window's own frames and Electron's heap limit; rAF gaps (the browser pane was hidden). T-3 and the Track U gate measure them.

#### The Track U gate (before the release)

Your three problems are a condition of the release, not only a measurement. All three rows run on your Mac with a temporary `TREEMAP_DATA_DIR`, on the build that ships, and the Definition-of-Done audit (Phase 8 T26) carries them as rows.
- **U1 passes** when a whole-disk scan completes, every refused folder is named, and every gigabyte is either measured or named as not measurable, with the unaccounted remainder inside the bound you set from the diagnosis.
- **U2 passes** against a bar you accept, with the cache state stated, no double walk, and the progress readout live.
- **U3 passes** when, during a whole-disk scan, there are 0 frames over 32 ms and no UI long task caused by backend work.
- A row that misses reads "not met" with its figure, and the release waits for your decision, the same as any phase gate.

### Phase T: Electron to Tauri (GO; started alongside Phase 4)

**Why:** the owner wants TreeMap to take less storage and be lighter and faster. Measured on 30 Sep 2026 (UTC) on the installed v5.1.0 (`/Applications/TreeMap.app`), the bundle is **369 MB on disk** (`du`: 360,028 KiB, which `du -h` shows as 352M):
- Electron Framework 234 MB (Apple silicon only). It includes Electron's own copy of Node.
- `app.asar` 87.0 MB + `app.asar.unpacked` 25.0 MB. Inside, by the sizes the archive records: better-sqlite3 22.0 MB (of which the binary is 1.9 MB), exceljs 21.6 MB, sharp/libvips 17.8 MB, pdfmake 13.6 MB, fontkit+pdfkit ~5.3 MB, zod 4.2 MB, the MCP SDK 3.8 MB, TreeMap's own compiled code 3.1 MB and the UI 1.6 MB.
- gdu 20.9 MB

This build has no Rust module, so a build from main will differ; its size is **to measure**.

**Signing today:** the macOS app is ad-hoc signed and never notarized, which is your standing decision of 26 Aug. The Windows build is unsigned (`release.yml` configures no certificate). Tauri builds ship the same way: the app, the sidecar and the helpers are ad-hoc signed inside the bundle. Notarization is not re-proposed.

**Step 1 (the draft plan's Phase S and Phase T): Tauri shell, TypeScript backend as a sidecar.** Tauri replaces Electron. The existing TypeScript backend runs as a **separate sidecar process**, so heavy backend work can no longer block the window. Libraries are trimmed of what never runs (Phase S, which can ship with Electron too), and every feature is kept. **Dropping the bundled gdu is part of the step-1 plan recorded on 30 Sep.** It is still asked (OD8) for two reasons: it changes a public setting and the API's list of engines, which your ask-first rule covers (MP §15); and gdu measured faster than the native engine at 1M entries on this Mac, so dropping it could slow first scans. The Windows build's gdu, which never runs (R59), goes without that question (T-5). The sidecar carries a Node runtime. The Apple-silicon part of this Mac's Node v24 is 120.6 MB before any trimming (the file is 243.5 MB because it holds two architectures). Which Node the sidecar ships (the draft recommends Node 24; the project supports Node 20 and later, and CI runs Node 20) and its size are **to measure**. Compared like with like, the saving is Electron's 234 MB (browser plus its Node) against the system web view plus the sidecar's Node.

**Step 2 (the draft plan's Phase R): the backend moves into Rust, route by route,** until the Node runtime is dropped. This is the biggest size cut. TypeScript stays for the UI, and Rust grows. The safety net needs building first. Today `tests/goldenResponses.test.ts` holds 11 captured responses byte-identical, and only on macOS. So T-30 first records byte-level captures of every route, including error bodies and refusals, on all three operating systems (with T-31 and T-32 below). Only then can a route be called "held byte-identical".

**Known desktop defects (read from the code; to confirm in the running app).** The page never calls most of its desktop bridge (`window.treemapDesktop`): it uses only `getPathForFile`, `resolveScanPath` and `onScanPath`. So today, in the Electron app:
- Dock and taskbar progress never shows, and the finish notice for a scan that ended while you were elsewhere (bounce, flash, notification) never fires: the page never calls `scanProgress` or `scanFinished`.
- The menu's commands do nothing (Settings, Command Palette, Toggle Sidebar, Keyboard Shortcuts, ⌘R Rescan): the page never listens with `onCommand`.
- The scan queue deadlocks. After the first folder the shell hands the page (a folder dropped on the dock, "Scan with TreeMap", the tray or File menu, a second launch), every later folder waits forever: the queue goes busy on its first hand-over (`electron/lib/desktop.js`, `next()`) and is released only by the progress and finished messages the page never sends (`electron/main.js`, `treemap:scan-progress` and `treemap:scan-finished`).
- The Full Disk Access button does nothing (U1), and the page's nine saved settings are lost at every launch (T-10).

Each gets a test-first fix in Electron first (T-8), then in the rebuilt bridge (T-17). They are not "working duties to port unchanged".

**Task list, numbered as the draft Tauri plan numbers it.** The plan (`docs/superpowers/plans/2026-09-30-phaseT-tauri.md`, written 30 Sep from main `d1def61`, committed with this roadmap) is the source, and work already committed uses its numbers (T-6), so this table follows them. If the final plan renumbers, this table follows it. States as of 30 Sep, about 05:40 UTC.

| Task | Step | What | State |
| --- | --- | --- | --- |
| Plan | — | The detailed migration plan, which replaces this table when it lands. It inventories 28 Electron duties (its §1.1), each mapped to a task that ports or retires it with a test, including: the per-launch API token, the tray with live free-disk figures, window placement, growth alerts, the application menu, update checks, single instance, power events (the sleep pause), dialogs (the folder picker, the MFT elevation question), the Windows notification identity (AUMID), macOS open-file and Open With, folder arguments on first and second launch, the About panel, Linux quitting with its last window, and every `ipcMain` channel. It also lists every in-process call from `electron/main.js` into `dist/` (the server, `scheduler`, `diskUsage`, `storage`, `portableMode`, `diskScanner`, `engineBudget`). | Written 30 Sep; committed with this roadmap as `docs/superpowers/plans/2026-09-30-phaseT-tauri.md` |
| T-1 | S | `scripts/measure-bundle.js`: size on disk per part, with the Electron "before" **from a build from main** (not v5.1.0) under `bench/baselines/app/`. | Not started |
| T-2 | S | Memory of every process (the app and its web-view processes), idle and during a 5M-entry scan, with a throwaway `TREEMAP_DATA_DIR` and a separate bundle identifier or web-view store; your real app-data and WebKit folders are checked unchanged before and after. **Launching any Electron build needs your OK first** (the standing rule of 30 Sep: no helper launches Electron or TreeMap.app; Q16's OK covered one opening of the installed app). | Not started |
| T-3 | S | Phase 8's frame probe (`bench uiframes`) brought forward, for the Electron "before": frames over 32 ms, UI long tasks and backend event-loop p99 during a whole-disk scan. | Not started |
| T-4 | S | Ship only what runs: one runtime manifest, used by electron-builder now and Tauri later. It leaves out the MCP SDK and zod (only `npm run mcp` uses them), exceljs's and pdfmake's prebuilt bundles, better-sqlite3's build files (its 22.0 MB holds a 1.9 MB binary), source maps and docs. A static test and a smoke run of every export prove nothing needed is left out. Every feature is kept. | Not started |
| T-5 | S | The Windows build ships no gdu (it never runs there, R59). No API change. | Not started |
| T-6 | T | `appExecutable()` and `resourcesDir()`: "Scan with TreeMap" on all three OSes, portable mode, and the native-module, gdu and NTFS-helper paths ask where the app is, instead of assuming Electron's `process.execPath` and `process.resourcesPath` (RT12). A concrete case of that hazard: under plain Node, portable mode would put its `TreeMap-Data` folder beside the `node` binary. The hand-over's "check `/usr/local/bin/TreeMap-Data`" is closed: checked 30 Sep, it does not exist. | **Done in a worktree, not on main:** `f021e8c`, plus two review-fix commits (`9e6b6b7`, `757278c`) |
| T-7 | T | The per-launch API token held in memory, so no child process (gdu, osascript, PowerShell) inherits it; a test proves a spawned child's environment carries no `TREEMAP_TOKEN`. | Not started |
| T-8 | T | The page keeps its bridge contract, fixing the known desktop defects above **in Electron first**: progress and the finish notice on every way a scan ends, menu commands (exactly one rescan on ⌘R), the scan queue released, and the Full Disk Access link through a named bridge call that the guard allows. | Not started |
| T-9 | T | Desktop protocol v1 between shell and sidecar: a ready line, the token over stdin, shutdown on a message or when the shell's pipe closes, and a data-folder lock so two backends never share one app-data folder. | Not started |
| T-10 | T | Sidecar requests and events: preferences and window placement, tray figures, notices, growth alerts, crash report. **The same app-data folder and file names** carry over (settings, snapshots, Autopilot policies, the Time Capsule, the offload manifest), proven on a synthetic fixture folder, never a copy of your real folder. **The page's nine browser-storage keys** (`tm-theme`, `tm-viewmode`, `tm-colormode`, `tm-sidenav`, `tm-bigfiles-sort`, `tm-cityheight`, `tm-citycolour`, `tm-cart`, `tm-scanned-roots`) are already lost at every launch because the port changes (the draft's D-3); each is migrated, kept by reusing the last port (the draft's OQ12), or its loss stated. | Not started |
| T-11 | T | Sleep and wake pause exactly the running scans; the NTFS turbo question goes to the shell. | Not started |
| T-12 | T | The page's security policy (CSP) byte-identical by default; the shell adds only its own IPC source. | Not started |
| T-13 | T | Throwaway verification spike, outside the repo: pinned versions, the shell's size, and whether macOS credits Full Disk Access granted to TreeMap.app to the sidecar (RT11). | **Done 30 Sep** (`docs/desktop/TAURI-FACTS.md`, committed with this roadmap; the plan's §8 lists what it changes). No blocker. Measured: the Tauri shell is **3-5 MB** (3,068,464 B minimal, 4,707,392 B with plugins, release profile "s") against Electron's 228,592 KB. Full Disk Access granted to TreeMap.app covers the sidecar. Plan changes: register only the single-instance and updater plugins (the dialog plugin turns `confirm()` into an always-true Promise, dangerous in a delete tool); `window.prompt()` returns null in WKWebView (three flows need in-page dialogs); permission and download handlers are mandatory; native file drop hides in-page drags (the cart); 6 connections per host; `hardenedRuntime` off for the Node sidecar. One incident each: two test files in `~/Downloads` (moved out) and one macOS refusal of a hand-assembled test bundle (the helper stopped). |
| T-14 | T | Workspace skeleton, `tauri.conf.json` (identifier `com.prithviweb.treemap`), least-privilege capabilities (denied by default), fmt/clippy/test in CI. Waits for OD7. | Not started |
| T-15 | T | Sidecar supervisor: start, ready, timeout, clean shutdown on quit, crash dialog and restart, never orphaned. | Not started |
| T-16 | T | Window: placement, navigation and new-window guards matching `electron/lib/guards.js` (the window loads only its own server; only http, https and mailto links go to the system; only notifications and the sanitized clipboard write are allowed), and a portable-aware web-view data folder. `tests/desktopPolish.test.ts`'s guard cases are ported (RT9). | Not started |
| T-17 | T | The page's bridge (`window.treemapDesktop`, same names, the defects above fixed; Phase 7's consent later), injected as an initialization script only on the app's own origin, never an npm frontend package (RT13); the scan queue; a download handler. `frontendContract.test.ts` stays unchanged. | Not started |
| T-18 | T | Native drag and drop, macOS "Opened" (a folder dropped on the dock icon, Open With), folder arguments on first and second launch, single instance. | Not started |
| T-19 | T | Menu, About panel, Scan Folder…, Show Data Folder. | Not started |
| T-20 | T | Tray and lifecycle (macOS stays alive, Linux quits with its last window, Windows keeps the tray), notifications with the Windows notification identity (AUMID), attention, progress bar. | Not started |
| T-21 | T | `tm-power` crate: sleep and wake on each OS, feeding T-11. | Not started |
| T-22 | T | Crash net: one dialog per run. | Not started |
| T-23 | T | Updater: Tauri's own, with a signing key you hold (OD12). | Not started |
| T-24 | T | Packaging and the packaged smoke test: the pinned Node staged and SHA-256-checked, ad-hoc signing innermost first, and a smoke run (sidecar ready, native module loads, better-sqlite3 and sharp load, the API reached with the token, quitting leaves no orphan). It replaces Phase 8 T21's Electron smoke. The current installer targets stay (macOS arm64, Windows x64); `release.yml` is updated, and the owner triggers it. | Not started |
| T-25 | T | Migrating installs (RT10): the Electron install replaced, not left beside the new one, app data unchanged byte for byte; "Scan with TreeMap" re-registered; the portable builds given a Tauri equivalent or retired by your decision. | Not started |
| T-26 | T | Equivalence: the API tests against the staged sidecar, the served UI byte-identical, web-view self-tests on WKWebView (macOS), WebView2 (Windows) and WebKitGTK (Linux) for fetch, EventSource, the HttpOnly SameSite=Strict cookie on 127.0.0.1 and canvas drawing. | Not started |
| T-27 | T | CI and release switch: the shell builds on all four legs, the full `npm test` runs unchanged against the backend, golden responses stay byte-identical, and `release.yml` produces Tauri's update feed. | Not started |
| T-28 | T | After-measurements: T-1 to T-3's list on the same Mac, under the same conditions and the same isolation, as an honest before/after table. Then the **step 1 gate**. | Not started |
| T-29 | T | Electron removed from the repo, with a test that nothing requires it; four legs green. | Not started |
| R plan | R | Inventory: every `/api` route (141 registered at T17a, 29 Sep; 58 or more of them state-changing), every MCP tool (10), every fact provider (6), every background job (Autopilot, scheduled scans, fleet, journal), and every consumer of the Node backend (web mode, the VS Code extension, Docker), ordered by dependency. The baseline count comes from `src/services/storageMode.ts`'s coverage table. Phase R is planned in detail when it starts. | Not started |
| T-30 | R | All-route reference: byte-level captures of every route on fixtures, including error bodies and refusals, compared live against another backend on all four legs; the harness goes red on a planted difference. | Not started |
| T-31 | R | `startTestServer()`, so every API test file can target either backend | Not started |
| T-32 | R | Byte-exact JSON in Rust: key order, number formatting, and lone surrogates and non-UTF-8 names written as Node writes them | Not started |
| W1-W9 | R | Route groups ported one at a time: read-only metadata first, destructive routes last, with a security review for those. Every path guard, audit and idempotency rule is ported with its tests. Each group lands gated green and byte-identical. Node-only libraries are replaced or re-homed along the way: better-sqlite3 (settings, index, content cache), sharp/libvips (thumbnails, Phase 6 decode), exceljs and pdfmake/pdfkit (exports), zod, the MCP SDK (`npm run mcp`), onnxruntime-node (Phase 7). Last, the Node runtime is dropped, after OD3 and OD4 are settled; size and memory are measured. **Step 2 gate.** | Not started |

**Open between this roadmap and the draft (to settle in the Tauri plan):**
- *Windows install scope.* The draft recommends a per-user installer (its OQ6). The NTFS turbo mode works only in an install for everyone on the computer (per-machine; R58), so a per-user-only installer loses that mode. Either offer both, or accept the loss with you.
- *The API token.* This roadmap earlier said the shell passes the token only in the sidecar's environment. The draft sends it over stdin and holds it in memory (T-7, T-9), because an environment variable is inherited by every child the backend starts. This roadmap now follows the draft.

**Measurements, before and after** (a figure is written only when measured; conditions are stated with it):

| Measure | Electron today | After step 1 | After step 2 |
| --- | --- | --- | --- |
| App size on disk | 369 MB (v5.1.0, 30 Sep UTC); main's build: to measure (T-1) | to measure | to measure |
| Browser/runtime part | Electron Framework 234 MB (includes Node) | system web view + Node sidecar: to measure | system web view only |
| Idle memory | Main process 199 MB resident, idle, installed 2 Sep build (`8d3344e`, 29 Sep UTC; main's server adds memory not in this figure); renderer and GPU processes: to measure | to measure | to measure |
| Launch to first paint | to measure | to measure | to measure |
| Frames over 32 ms / UI long tasks during a whole-disk scan | to measure (T-3; the diagnosis measured the server's stalls and the page's work, not the Electron window's frames) | to measure | to measure |
| Scan throughput (enum200k, enum1m) | Phase 3 baselines | within 10 % (proposed, the Phase 4 T22 rule) | within 10 % (proposed) |

**Step 1 gate (proposed):**
- CI green on all four legs.
- Golden responses byte-identical.
- The packaged smoke green on both installer legs (T-24).
- The app-data carry-over test green, on a synthetic fixture folder (T-10).
- The desktop token and guards at parity, tested (T-7, T-12, T-16).
- The known desktop defects fixed, tested (T-8, T-17).
- The U3 check for step 1: no UI long task caused by backend work during a whole-disk scan on your Mac, with the count of frames over 32 ms recorded. The full bar (0 frames over 32 ms) is the Track U gate's; a frontend fix the diagnosis calls for is pulled forward into step 1.
- The update bridge and install migration tested (T-23, T-25), and Full Disk Access coverage tested (T-13, T-24).
- The before/after table recorded on your Mac, with measurement builds isolated, a download handler installed, and your real folders checked unchanged.
- No figure claimed beyond it.

**Step 2 gate (proposed):**
- Every route byte-identical against T-30's captures on all three operating systems.
- Every refusal test green against the Rust backend.
- No Node runtime in the bundle.
- Measurements recorded.
- CI green on all four legs (macOS, Windows, Linux, Linux pt-BR).

**What Phase T touches elsewhere:**
- Phase 4 T16 (the chooser's runtime dimension and `T_mem`), T18 (its worker test runs "inside the installed Electron"), T21 and T22 (the Electron-as-Node leg): the second runtime becomes the sidecar.
- Phase 5 T13: running duplicate jobs pause on Electron's sleep events. The sleep hooks are re-planned as Tauri shell → sidecar (T-11, T-21).
- Phase 6 T9c: its sleep hooks are wired through `electron/main.js` (`wirePowerEvents`). Re-planned the same way.
- Phase 7: T1 (its test names `electron/main.js` as the only desktop loader of the deep tier), T2 (unpacking onnxruntime from asar), T4a/T4b (desktop-versus-web consent detects the desktop through `process.versions.electron`; it becomes a flag the shell sets), T4c (consent over Electron IPC), T6 (the inference child's environment sets `ELECTRON_RUN_AS_NODE` under Electron; under a Node sidecar that changes, and in step 2 the child itself), T9 (desktop consent through the rebuilt bridge, T-17), and the deep pass's sleep pause (P7-6, through `wirePowerEvents`): re-plan all for Tauri.
- Phase 8: the tasks flagged below.
- RISKS R26, R28, R33, R35, R51, R57, R58, R64 and R72 describe Electron or gdu behaviour and need re-reading after step 1.

### Phase 5: exact duplicates (planned, not started)

The aim is faster and safer duplicate detection. BLAKE3 hashing moves into a new governed Rust crate, `tm-hash`, with a 12 KiB sample stage. `content-cache.db` makes an unchanged rescan read nothing. The server-side **last-copy rule** (`LAST_COPY`) refuses to trash the last copy. Cloud placeholders are provably never opened. The SHA-256 finder stays as the fallback and the correctness oracle.

| Task | What |
| --- | --- |
| T0 | bench: the duplicates suite takes `--finder` and `--preset`; record the pre-rewrite legacy baseline (owner's Mac) |
| T1a | Last-copy rule in `moveToTrash`: registry, identity matching, the Trash never a survivor, DELETE and MCP (waits on the owner's Phase 5 Q9) |
| T1b | Last-copy rule for cart commits, the Time Capsule and Autopilot, with one lock across check, capture and trash |
| T1c | Last-copy rule for offload, compression and snapshot restore |
| T1d | The Clean Up name+size rule leaves one copy of each set out |
| T2 | The legacy SHA-256 finder becomes the oracle: every group kept, every drop counted, every read re-stated, allocated bytes |
| T2b | The fallback held to the same rules where Node can hold it (no links or FIFOs, read-hostile mounts, paced, pausable) |
| T3 | Placeholders provably never read: re-ask before every full read, the flagged fixture, the live evicted-file tests |
| T4 | bench: re-record the legacy finder after T1a-T3 as `sha256-oracle` |
| T5 | governor: a per-job Eco cap for scheduled native walks, Autopilot and fleet scans (a native version bump) |
| T6 | ci: cargo runs `--locked`; the Rust licence notices ship with the module |
| T7a | `tm-hash`: BLAKE3 sample and full digests, and the throughput probe |
| T7b | The verified open beneath the scan root, with identity and change detection |
| T8 | The pre-open probe: dataless files, read-hostile mounts, stable ids, links, clones |
| T9 | The governed hash job: per-device queues, rotational detection, inode order, pause and cancel |
| T10 | The hash exports in the start/poll/take shape (a native version bump; the plan's 0.1.0→0.3.0 numbering predates Phase 4's contract 0.5.0, so the next minors apply) |
| T11 | `content-cache.db` |
| T12 | The native finder equals the oracle on every corpus; a lying cache row can never trash a unique file |
| T13 | API, MCP and OpenAPI additions; pause/resume/cancel; sleep; aggregate-mode and cloud-provider scans refused. **Tauri-affected:** the sleep pause rides on Electron's power events today. |
| T14 | The reclaim score's duplicate component knows what it did not look at |
| T15 | `dupe:` in queries: interactive first, and for Autopilot only behind T1b |
| T16 | The Duplicates view shows what the server says, with Pause, Resume and Cancel on the job |
| T17a | bench: two-engine ratio, cached rescan, shared-header corpus, hashspeed, pause/cancel latency, Eco share |
| T17b | bench: the §5.4 measurements (owner's Mac only) |
| T18 | (Conditional on T17b) hash one large file across the governor's threads |
| T19 | docs: DESIGN, RISKS, CURRENT-STATE §6, README, SECURITY, AGENTS |

**Gate:** the §5.4 rows run on dupes100k, warm, Turbo, 5 runs, on the owner's Mac. Each row is MET or MISSED with its figure; INCONCLUSIVE is not MET. The plan's gate section is authoritative; this is its summary.
- Wall time ≥ 4× and CPU seconds ≥ 5× against T0's baseline.
- Bytes read ≥ 10× on the first run is **expected MISSED**: by arithmetic from the corpus plan, the ceiling is ≈ 3.26×.
- 0 false positives and recall 1.0, with every one of the corpus plan's 10,466 groups (a planned count, arithmetic from the corpus plan) byte-compared.
- Rescan ≥ 50× with `bytesRequested` exactly 0.
- Placeholders never read (four CI legs plus two live evicted-file tests the owner runs).
- `tests/lastCopyRule.test.ts` green.
- Eco ≤ 25 % and Balanced ≤ 50 %.
- Pause ≤ 200 ms and cancel ≤ 500 ms.
- The SHA-256/BLAKE3 measurement recorded (MP §10.2).
- T18 built, "not built" or "not decided", with its figure.
- The aggregate-mode 409 live, or "blocked on Phase 4 S4".
- CI green on every leg with `--locked` and the licence-notices check.
- Tier A and Tier C rows read "not available on this machine", never passed.
- Any MISSED row makes the gate "not passed: owner decision pending" (Phase 5 Q7), and Phase 6 waits.

### Phase 6: near-duplicate images, fast tier (planned, not started)

This phase replaces the legacy O(n²) dHash pass, whose precision is 0.18 at its default threshold. The replacement is `tm-imghash`: a head probe, a cheapest-first decode ladder, one composite signature (pHash, dHash, colour moments, aspect) and multi-index Hamming search. No decoder ever receives a path. Every image is read once through Phase 5's verified open. Signatures are cached, and quality figures stay labelled "synthetic corpus v2" until the owner's real-library run (R50 stays open at HIGH).

| Task | What |
| --- | --- |
| T1 | Measurement base: recall gated beside precision, ≥ 3 runs, pre-registered gate seeds, legacy per-transform quality recorded |
| T2 | Image corpus v2: textured backgrounds (R50), EXIF orientation and thumbnails labelled apart, HEIC where `sips` makes it |
| T3 | `tm-imghash` crate and head probe (JPEG markers, EXIF orientation and thumbnail, dimensions); HEIC EXIF-thumbnail evidence step first |
| T4 | Composite signature from one oriented 32×32 grid, with identical bits on every platform (golden vectors) |
| T5a | Verified read and EXIF rung: one open per image via Phase 5's `open_verified`; bytes, never a path, to sharp |
| T5b | macOS platform rung: ImageIO over the verified descriptor (HEIC's only route), off on Intel Macs, GPU counter |
| T6 | Multi-index search, exact verification, union-find, clusters split at τ, near misses kept for Phase 7 |
| T7a | Rust image job: governed threads, per-device queues, no wait between probe and open, bytes-in-flight budget, pause, cancel, Eco cap |
| T7b | napi surface: job exports, sliced takes, `imgReadVerified` for Node's own decoders |
| T8 | A signatures table in `content-cache.db` (48-byte identity + `sig_version`, no paths) |
| T9a | Node verified reader, and the legacy tier fixed: per-image locality check, bytes to sharp/ffmpeg, counted failures |
| T9b | Candidates in slices from the store; the sharp stage on bytes under the job's own budget key |
| T9c | Fast-tier orchestration: probe first, cache before any read, pause/resume/cancel, legacy tier on any runtime failure. **Tauri-affected:** its sleep hooks are wired in `electron/main.js` (`wirePowerEvents`). |
| T9d | Answer assembled in slices: storage units (hard links, clones), strip wording, near misses kept |
| T10 | Bench for the fast tier: `--rescan`, decode-path mix, `notDecoded`, pause/cancel per stage, per-decode peak RSS |
| T11 | Tuning by recorded search on seed 17, with every §5.5 bar as a constraint |
| T12 | API: tier, signature/decodePath, representative, confidence, `notDecoded`, paging; `409 STORAGE_MODE`; pause/resume/cancel |
| T13 | Never read, never silent: one observer for every decoder, a UI notice, HEIC thumbnails on Apple silicon |
| T14 | One keep rule (resolution > size > oldest > path) for the job, the strip, auto-select and the Compare viewer |
| T14b | The last image of a near-duplicate cluster refused server-side (owner's Phase 6 Q9) |
| T15 | The Compare viewer paints each differing region correctly |
| T16 | Opt-in real-library measurement (R50), aggregates only |
| T17 | MCP `find_similar_images` (only on the owner's yes, Phase 6 Q2) |
| T18 | Docs, with a docs-honesty test |

**Gate:** owner's Mac, corpus v2, held-out seed 23. The plan's gate section is authoritative; this is its summary.
- Pooled recall ≥ 0.97 on resize/re-encode/format and ≥ 0.70 on crops ≤ 10 %.
- Precision ≥ 0.98.
- Zero auto-selected files farther than τ(10) from their representative.
- 200,010 images in ≤ 90,000 ms median at Turbo, spread < 5 %, peak RSS ≤ 500 MB.
- The event loop's max ≤ 32 ms while the strip's pages are served.
- Rescan ≥ 100× with cache hit rate ≥ 0.99.
- Eco ≤ 25 % and Balanced ≤ 50 % CPU share in every window; pause ≤ 200 ms and cancel ≤ 500 ms.
- Strictly cheaper than legacy in CPU and bytes.
- Placeholders never opened on four legs.
- HEIC answers `formatNotDecodableHere` on Windows, Linux and Intel Macs.
- By the plan's own arithmetic, the 90 s row is reachable only if the sharp path gets about 3× cheaper. A NOT MET row goes to the owner.
- **The 200k-image corpus conflicts with your 40 GB test-data cap.** The Phase 6 plan (Q4) estimates it at about 84 GB, by extrapolation. Either you raise the cap for this one run, or the gate runs at 1/N scale and says so (R41). OD11 asks.

### Phase 7: near-duplicate deep tier, opt-in (planned, not started)

The deep tier is off by default. After the person consents, TreeMap downloads one pinned ONNX vision model once and then runs it offline in a governed child process, only over the ambiguous cases the fast tier leaves. Its results are shown as unselected suggestions and never enter clusters, auto-select or reclaimable figures. With the tier off, everything stays byte-identical and works air-gapped. The added dependency is `onnxruntime-node` 1.30.0, whose macOS Apple-silicon runtime library alone is about 44.6 MB.

| Task | What |
| --- | --- |
| T1 | Air-gap guard: every default feature runs with network refused and the tier absent (**Tauri-affected:** its test names `electron/main.js` as the only desktop loader of the deep tier's index) |
| T2 | One runtime dependency, `onnxruntime-node` 1.30.0 pinned exact, no CUDA download, unpacked from asar, notices shipped (**Tauri-affected**) |
| T3a | Model manifest types, validators and the pin script |
| T3b | The pins (revision, bytes, SHA-256) per candidate model: CLIP ViT-B/16 and DINOv2-small (owner's Mac only) |
| T4a | Consent: state record and rules; a terminal code only on a controlling terminal (**Tauri-affected:** desktop detection uses `process.versions.electron` today) |
| T4b | Consent routes, the Settings refusal (`403 CONSENT_REQUIRED`), portable sessions, audit shape (**Tauri-affected:** the same desktop-versus-web rule) |
| T4c | Desktop consent over Electron IPC and the app's own native question, never HTTP (**Tauri-affected:** becomes Tauri IPC through the rebuilt bridge, T-17) |
| T5 | The download: one pinned HTTPS file, SHA-256-verified before it is kept, with progress and cancel |
| T6 | Inference child: model-free until asked, reads no user file, telemetry off, governed, pausable (**Tauri-affected, step 1:** its environment sets `ELECTRON_RUN_AS_NODE` under Electron, which changes under a Node sidecar; **step 2:** a Node child today) |
| T7 | Int8 embeddings compared in exact integer arithmetic, plus an `embeddings` table in `content-cache.db` |
| T8a | Targeting and the deep pass: the parent reads each image through Phase 6's verified reader; the deep pass pauses on sleep through `wirePowerEvents` (P7-6; **Tauri-affected**) |
| T8b | Additive API: deep results beside the fast answer, never inside it; deep start/pause/resume/cancel |
| T9 | UI: Settings opt-in, consent screen, download progress (Cancel only), deep suggestions shown unselected (**Tauri-affected:** in the desktop app the page asks through `window.treemapDesktop`, which the rebuilt bridge carries, T-17) |
| T10 | Bench: tune on seed 17, held-out gate on seed 7, rescan, pause, batch, 200k, real library |
| T11 | Choose the default model on the held-out corpus by the stated rule |
| T12 | Core ML on the Neural Engine (Apple silicon), measured against 15 % of one core |
| T13 | Windows: NPU unreachable via `onnxruntime-node` 1.30.0; DirectML only if the owner's Phase 7 Q4 allows |
| T14 | Docs |

**Gate:** owner's Mac, held-out seed 7.
- Disabled by default, and no download without consent (four legs).
- Crop-5 and crop-10 recall ≥ 0.95 each, precision ≥ 0.98.
- int8 within 2 points of fp32.
- Neural Engine pass ≤ 0.15 CPU-seconds per second.
- Eco ≤ 25 %; pause ≤ 200 ms and cancel ≤ 500 ms.
- App + child peak RSS ≤ 500 MB.
- Rescan ≥ 100× with hit rate ≥ 0.99.
- No telemetry, offline after download.
- The fast answer untouched, and full function when the tier is off.

### Phase 8: UI, docs, CI performance gate (planned, not started)

A person can see and steer the engine: a `GET /api/scan/:scanId/live` readout, an engine badge that states each fallback in words, Pause on every long job, and the budget control with live effect. The phase also adds the scan-boundary rule, the same-origin guard (R52), governor headroom (R52a), a calibrated CI performance gate, prebuilt modules for every target, and README figures generated from `bench/`. It ends with the Definition-of-Done audit. **Its measurements are taken on the step-1 Tauri build, and run again on the final build before the release** (Order of work, step 12). "T" in the last column marks a task built on Electron or gdu today, or blocked on one that is, which must be re-planned for Tauri.

| Task | What | Tauri |
| --- | --- | --- |
| T1 | `GET /api/scan/:scanId/live`: rate, CPU share, memory, who paused, budget now, every fallback in words (edits `electron/main.js` `wirePowerEvents`) | **T** |
| T2 | Engine badge: fast path named, each fallback in visible words (the chain changes if gdu leaves the bundle) | **T** (possible) |
| T3 | Scan card: Pause/Resume, compact budget control, advanced CPU ceiling in Settings, live readout, ⌘K entry. Its tests cover "on a gdu scan the change applies from the next helper" and a pause by sleep (Electron's power events, through T1). | **T** (possible: gdu and sleep) |
| T4 | Duplicates: Phase 5's controls verified; shared storage in words | **T** (via Phase 5 T13's sleep pause) |
| T5 | Similar photos: Pause, Resume, Cancel on the job | |
| T6 | Deep check: Phase 7's controls verified; the model download stays Cancel-only | **T** (via Phase 7 T9 and T4c) |
| T7 | A resumed job never reads a file whose data left during the pause | |
| T8 | Persistent index build pausable and inside the budget (edits `wirePowerEvents`) | **T** |
| T9 | Storage mode in the UI: the aggregate notice, a Settings storage row | |
| T10 | Honest UI copy, the cold-scan sentence beside every rate, frame-cost counts, `bench uiframes` in an Electron window (brought forward to Phase T T-3 and built for the Tauri window) | **T** |
| T11 | `scripts/busy-load.js`, the one self-stopping busy-loop tool | |
| T12 | Unattended work runs at Eco; `heldBy` recorded | |
| T13 | Governor headroom above the Eco and Balanced ceilings (R52a), kept only if measured better | |
| T14 | Scan boundary (MP §3.3): one mount-table rule for every engine; stay/cross setting | **T** (possible: gdu) |
| T15 | R52: one same-origin guard on `/api` and the fleet listener (the Electron window's origin, desktop token and cookie) | **T** |
| T16 | P4-9 closed: the change-journal rescan is not built, and the docs say so (see U2: decided with you after the diagnosis) | |
| T17 | `bench ab`: walker, native and gdu-bare interleaved; four paired ratios; planted slowdowns | **T** (possible: gdu-bare) |
| T18 | Prebuilds for every target, checked by architecture and SHA-256; `dist:*` builds the module (electron-builder scripts) | **T** |
| T19 | CI performance gate (job `perf`) and its calibration on hosted runners. It fetches gdu for the gdu-bare leg. | **T** (possible: gdu-bare) |
| T20 | `npm run fetch:native`: SHA-256-verified, redirects checked | |
| T21 | Loader's dead candidates removed; packaged app proven to load from `app.asar.unpacked` (`--treemap-smoke-native`) | **T** (replaced by Phase T T-24) |
| T22 | Third-party notices for every release target (the bundle entry) | **T** (possible) |
| T23 | Equivalence on every corpus on three platforms (`equivalence-full.yml`). It fetches gdu. | **T** (possible: gdu) |
| T24 | README and CHANGELOG held to `bench/` (cites `electron/main.js:33`) | **T** |
| T25 | DESIGN, RISKS, CURRENT-STATE, SECURITY, AGENTS as built (docsDrift test). SECURITY.md describes the Electron hardening. | **T** |
| T26 | Definition-of-Done audit plus `scripts/verify-dod.js`, the owner's release precondition (relies on T18/T19/T21). Its text is amended so that I prepare the version bump and CHANGELOG and you publish (your 24 Sep grant). It gains the U1-U3 rows and the Phase T rows (PT-1 to PT-3 below), and it runs again on the final build. | **T** |

**Gate (MP §6):**
- The budget selector works and is discoverable. The plan's row "during a gdu scan it applies from the next helper" is reworded for a build without gdu if OD8 is yes; gdu then stays only as a CI reference.
- Engine status is visible, including after a forced load failure.
- README claims match `bench/` output exactly (`npm run bench -- readme --check`).
- CI fails on a > 10 % regression, proven by planted slowdowns in a held-out validation. A band wider than 10 % is stated and accepted by the owner.
- A release test build with every target is SHA-256-checked, and the packaged smoke is green on both installer legs.
- `bench uiframes` and R52a are recorded on the owner's Mac. (Passing U3 is the Track U gate's job.)
- The DoD audit is green.

### Definition of Done: the release checklist

Each row is proven by the task named and gets one verdict: **done**, **not met** (with its figure), **not available on this machine**, or **owner-accepted** (with the date). Nothing is "passed" that was not run. Phase 8 T26 audits every row, and runs again on the final build.

| # | Item (MP §14, shortened, plus this roadmap's own rows) | Proven by | Where it stands |
| --- | --- | --- | --- |
| 1 | CURRENT-STATE, DESIGN, RISKS exist and are accurate | Phase 0; kept accurate by T25's drift test | Exist; RISKS needs R96, R4, R73, R86 updates (T23) |
| 2 | Every target reproduced by `npm run bench`, or DESIGN records each miss with its figure | DESIGN §19 (Phase 8 T25/T26) | Misses so far (Phase 3): warm Eco and CPU-s per million at Eco, owner-accepted 23 Sep 2026 (keeping Eco at Background QoS); CPU-s per million at Turbo, not met |
| 3 | Baselines and post-change results committed under `bench/` | Phase 1 onward, each gate's `--record` | In progress |
| 4 | Equivalence on all corpora on all three platforms | Phase 8 T23 (`equivalence-full.yml`) | Not run |
| 5 | Every §12.2 edge case has a test | T26, case by case against `tests/fixtures/edgeCases.ts` and the Rust tests | Not audited |
| 6 | Governor holds every budget on every tier | Tier B (Phase 2, done); Tier C on a hosted VM, labelled; Tier A not available | Tier B done |
| 7 | 100M-entry scan inside the memory ceiling on Tier C | Phase 4 S5 (T19/T22) plus a hosted run recorded at ≤ 8 GiB, else "not available" | Not run |
| 8 | Duplicates: 0 false positives, 0 false negatives, targets met, placeholders untouched | Phase 5 gate | Not started |
| 9 | Near-duplicate fast tier targets met; deep tier opt-in, offline after download, targets met | Phase 6 and Phase 7 gates | Not started |
| 10 | Legacy fallback verified by forcing a native load failure, with an honest badge | Phase 8 T2's forced-failure test; OD3 and OD8 affect what "legacy" means | Not run |
| 11 | All existing API endpoints unchanged in shape; all existing tests pass | `goldenResponses`, `discoverability`; CI | Held so far |
| 12 | README updated with real numbers and the cold-scan sentence | Phase 8 T24 | Not started |
| 13 | CI green on all three platforms with prebuilds for every target | Phase 8 T18, T19, T21 (Phase T T-24 under Tauri) | Not started |
| 14 | No new frontend dependencies | `frontendContract.test.ts`; Phase T T-17 keeps it | Held so far |
| §3.3 | Accounting correctness (scan boundary, sparse files, firmlinks) | Phase 8 T14 and its Q5; Phase 5 P5-9 | Not started |
| §3.5 | Installs with no toolchain on every web-mode target | Phase 8 T18 and its Q1; OD4 after step 2 | Not started |
| §8.1 | Eco pauses while another app does heavy I/O | Phase 8 P8-26 and Q6 | Not built: owner decision (OD10) |
| §9.5 | A rescan that skips unchanged folders (change journal) | U2's decision; Phase 8 T16 | Not built: owner decision (U2) |
| U1-U3 | Your three problems | The Track U gate | Diagnosed 30 Sep; fixes planned (Track U plan) |
| PT-1 | Phase T step 1 gate | T-28 and the step 1 gate | Not run |
| PT-2 | Phase T step 2 gate, with no Node runtime in the bundle | Phase R's last step (W1-W9) and the step 2 gate | Not started |
| PT-3 | Size on disk and idle memory, before and after, recorded (the bar you set in OD1) | T-1 and T-2 (before), T-28 (after), and again after step 2 | Not measured |

---

## Targets and how they are measured

**The rule:** no number is claimed until the committed benchmark harness has measured it on a **named machine under named conditions** (MP §13, RISKS R39). Estimates are labelled as arithmetic. A miss is recorded with its figure, never relabelled. The only machine here is the owner's Mac, which is **Tier B**. Tier A and Tier C rows read "not available on this machine" and are never "passed". Cold-cache rows read "not measured on this Mac" (no `sudo purge` without a password).

**Reference machines (MP §5.1):**
- Tier A: Apple Silicon M-series Pro/Max or an 8+ core x64 desktop, NVMe, 32 GB RAM.
- Tier B: a 4 to 8 core laptop, NVMe or good SATA SSD, 16 GB RAM.
- Tier C, "the one that matters most": 2 to 4 cores, 8 GB RAM, SATA SSD or 5400 rpm HDD, thermally constrained, possibly on battery.

**Enumeration throughput (MP §5.2)**

| Condition | Tier A | Tier B | Tier C | Tier B, measured on the owner's Mac |
| --- | --- | --- | --- | --- |
| Warm page cache, local SSD, Turbo | 800k to 1.2M entries/sec | 400k to 700k | 120k to 250k | **Met at its floor:** 412,291 entries/s, enum200k native, `17eb13d` (a tree that fits the kernel's cache) |
| Mixed cache (a tree past `kern.maxvnodes` ≈ 251k), Turbo | No master-prompt target | | | enum1m: native 91,308 and walker 82,497 entries/s (`3848b8e`, the fixed harness); gdu 97,666 and walker 81,953 (Phase 1, a harness that may read slow by up to 13 %). The walker and native engines read 2.3-2.66 GB of catalog per pass (R15); gdu's reads happen in child processes and were not measured. This is the regime a whole-disk scan is in. |
| Warm cache, Eco | 250k to 400k | 150k to 250k | 60k to 120k | **Missed:** 67k-87k, not reproducible to 5 %. Owner-accepted 23 Sep 2026, with the decision to keep Eco at Background QoS (the decision named the Eco CPU row; this miss follows from it) |
| Cold cache, local NVMe, Turbo | 150k to 400k | 100k to 250k | 40k to 120k | Not measured on this Mac |
| Cold cache, spinning HDD | Bounded by seek time: report the measured number, set no target | | | n/a |
| Network mount (SMB/NFS) | Bounded by round trips: set no throughput target | | | n/a |

"The headline number is a warm-cache local-SSD figure." A cold first scan is bounded by the filesystem and the hardware, and the UI and README must say so (MP §5.2).

**Efficiency (MP §5.3)**

| Metric | Target | Where it stands |
| --- | --- | --- |
| CPU-seconds per million entries, Turbo | <= 3.0 | **Missed, not owner-accepted:** 8.06 on enum200k at `17eb13d` (CURRENT-STATE quotes 8.31, from the `54425de` run); 12.88 at 1M entries, mixed cache (`3848b8e`). Kernel floor about 4.6. |
| CPU-seconds per million entries, Eco | <= 2.0 | **Missed, owner-accepted 23 Sep 2026:** "out of reach at Background QoS on Apple silicon" |
| Peak RSS, 10M entries, full index in memory | <= 700 MB | To be met in spill mode (owner's Q3, 25 Sep); measured at T22 |
| Peak RSS, 100M entries, spill mode | <= 1.5 GB | T22, not run |
| Peak RSS, 100M entries, aggregate-only mode | <= 400 MB | T22, not run |
| Foreground CPU share, Eco | <= 25% of total machine CPU, sustained | Synthetic load 24.1 % (`b327796`); live scan 22.2 %, p95 25.1 % (`77152a5`) |
| Foreground CPU share, Balanced | <= 50% | Synthetic 49.9 %; live scan 26.7 %, p95 38.7 % |
| UI frame budget during any scan | 60 fps maintained, no frame over 32 ms | Not measured (Phase T T-3 and T-28, Phase 8 T10; U3) |

Phase 4 adds its own figures:
- `T_mem` = 5M in both runtimes; 5M peaks were 533 MB (Node) and 547 MB (Electron) at T10 (record `c910f6a`).
- Memory ≤ 700 MB at 5M.
- Throughput within 10 % of Phase 3's baselines.
- Governor presets (MP §8.1): Eco 25 %, Balanced 50 %, Turbo 90 %, pause within 200 ms, cancel within 500 ms (MP §8.5).
- **Eco "pauses while another app is doing heavy I/O" (MP §8.1): not built.** Phase 5 deferred it and Phase 8 does not build it either; it reads "not met — owner decision" (Phase 8 Q6, OD10).

**Duplicate detection (MP §5.4; corpus: 1M files, 500 GB, planted 12 % duplicate rate)**

| Metric | Target | Notes |
| --- | --- | --- |
| Wall time to full duplicate report | >= 4x faster | Baseline "measure it first" (Phase 5 T0) |
| Bytes read from disk | >= 10x less | Expected MISSED on a first run: ≈ 3.26× ceiling by arithmetic |
| CPU seconds | >= 5x less | Phase 5 T0 baseline |
| False positives | 0 required, verified by byte comparison in the test | |
| False negatives | 0 required | |
| Second run on unchanged corpus (warm cache) | >= 50x faster, near zero bytes read | |

Phase 5 measures on dupes100k: about 1/10 of the files and about 1/175 of the hashed bytes, labelled so (R41). The legacy reference is dupes100k at 28,701 files/s (`aa4f9f4`), with recall 1 and precision 1 over the 500 groups the finder reports, out of the corpus plan's 10,466 planned groups.

**Near-duplicate images (MP §5.5; corpus: 200k images with planted transformations)**

| Metric | Target |
| --- | --- |
| Wall time, fast tier only, 200k images, Tier B | <= 90 seconds |
| Recall on resize + re-encode + format conversion | >= 0.97 |
| Recall on <= 10% crop, fast tier | >= 0.70 |
| Recall on <= 10% crop, deep tier enabled | >= 0.95 |
| Precision at the default threshold | >= 0.98 |
| Peak RSS, 200k images | <= 500 MB |
| Rescan of unchanged library | >= 100x faster, cache hit rate >= 0.99 |
| Deep tier CPU share when ANE/NPU is available | <= 15% of one core |

Every quality figure is labelled "synthetic corpus" until the owner's real-library run (R50). The deep tier's int8 model may not lose more than 2 recall points against fp32 (MP §10.4). The 200k corpus is about 84 GB by the Phase 6 plan's extrapolation, over your 40 GB cap (OD11).

**CI performance gate (MP §12.5):** "use a fixed small corpus, take the median of 5 runs, and set the threshold high enough to avoid flakes", failing on a regression over 10 %. Phase 8's recommendation (its Q3, pending your answer) makes that concrete: the threshold is max(10 %, the band fitted over 20 clean gate runs + 2 points), a failure needs a confirmation run, and INCONCLUSIVE never fails. The separate "spread under 5 %" rule is the Phase 1 harness's reproducibility gate (MP §6): the harness refuses to record a series whose spread exceeds 5 %.

**Tauri (Phase T):** no numeric target is promised. The goal is "smaller and lighter than the Electron build, measured before and after on the owner's Mac", with scan throughput held within 10 % (proposed). The size bar for OD1 is yours to set.

---

## Safety rules that never bend

**Enforced today, in main's code and tests:**
- **Trash only for your files.** Every delete of a user's file goes to the platform Trash or Recycle Bin, never a hard delete. The only irreversible user actions are the explicit, double-confirmed Empty Trash and snapshot purge (`POST /api/trash/empty`, `POST /api/system/snapshots/purge`, both requiring `{ "confirm": true }`). TreeMap removes only its own temporary files: spill files inside `<appData>/scan-spill` (owner's Q1), scan scratch (gdu shard outputs, the MFT helper's outputs) and Time Capsule copies it discards.
- **Path guards.** Destructive and file-opening routes act only inside a root this server scanned. System directories stay blocked. The spill folder is never a target, and app-data is never a write destination, however the path is spelled.
- **No telemetry, ever, and no network during scanning, hashing or near-duplicate work (MP §3.4).** TreeMap's only outbound connections are the ones `SECURITY.md` names: the desktop app's update check (GitHub Releases, at launch and every 6 hours; the desktop app has no setting to turn it off), cloud accounts you connect, and the opt-in LAN Fleet (summaries only). Planned additions: the Phase 7 model download, once, only after consent (Phase 7 T1 adds the air-gap test), and Tauri's updater (OD12, T-23), which replaces today's update check; the Tauri plan names exactly what it contacts.
- **The owner pushes.** The assistant never pushes and never pushes a `v*` tag.
- **The frontend stays zero-dependency,** with no framework, bundler or chart library.

**Stated rules whose server-side proof lands later:**
- **Duplicates never lose the last copy.** Today the Duplicates view refuses to trash a whole group. Phase 5 (T1a-T1d) makes it server-side on every route (OD6), which retires R5's "a cache causes a delete".
- **Hard links and clones count once and are never reported reclaimable.** R6 is open until Phase 5. Symlinks are never followed by default.
- **Sparse files carry both sizes.** Logical size and allocated blocks are both reported, and anything labelled "space you will get back" uses allocated blocks (MP §3.3). Today the scan counts sparse files (`sparseFiles` and `sparseBytes` in its stats, and a `sparseFiles` line in the missing-gigabytes statement). Phase 5 (P5-9: `reclaimable` in allocated bytes) and Phase 8 T14 (the §3.3 row of the release checklist) prove it everywhere.
- **Firmlinks and bind mounts never double-count** (MP §3.3): visited `(dev, ino)` for directories, alongside the never-descend list and the device check (RISKS R21, open; bears on U1). Phase 8 T14's one mount-table rule for every engine proves it.
- **Spill files never outlive their scan** (MP §13): unlinked at creation (Q1, built in T13) and swept at the next start (T17a, `3bdc588`), with the Docker PID-1 leftover still owed (Phase 4, "still owed"; RISKS R4). T22 proves it at scale.
- **Cloud placeholders are never read or downloaded.** They are shown with a badge and counted as "not hashed". Today the native duplicate pass asks each file's directory entry before reading it (R71), while a copy without the module and the walker still rely on the scan's flags (R2, R71's remainder). Phase 5 T3 and Phase 6 T13 make it provable.
- **Caches never cause a delete.** Every destructive action re-validates against the live filesystem (MP §3.1; Phase 5).
- **No test can reach your real Trash.** FG2 (committed in its worktree as `fbbbc75`, not on main, not yet gated green) is designed to make this so, including for the programs a test starts; its own tests prove it before it lands.
- **Offload copies, verifies a full digest read back from the destination, and only then trashes originals, with rollback on any failure.** The on-disk catalog does not yet record which algorithm verified each entry (R7).

**How the work is done (every change is held to these):**
- **Honest numbers.** A figure is shown only if the committed harness measured it on a named machine. Unknown is `null` with a reason, never zero.
- **The owner's data stays untouched.** Nothing touches `~/Library/Application Support/TreeMap`, the Trash or your other personal folders (such as `~/Downloads`). Tests use a temporary `TREEMAP_DATA_DIR`. Measurement builds of the Tauri app use a throwaway data folder, a separate bundle identifier or web-view store and a download handler, and your real folders are checked unchanged before and after.
- **No helper launches Electron, TreeMap.app or any downloaded app, or works around Gatekeeper.** This standing rule was added on 30 Sep, after macOS showed you a malware warning for a helper's extracted developer copy of Electron. If macOS blocks something, the helper stops and reports it.
- **Settings survive the move to Tauri.** The app-data folder and its files stay the same.
- **The built-in walker stays** as the fallback and the correctness oracle. Dropping gdu from the macOS app is part of the recorded step-1 plan and waits for OD8; it departs from MP §13 and DESIGN D2, which count gdu as part of the legacy engine. If Node leaves the app, OD3 decides how this rule is kept.
- **File contents are read only for hashing and image signatures,** and never written to any cache, log or snapshot.
- **No discrete GPU without consent;** the default path uses zero GPU.
- **Spotlight and Windows Search are never a source of sizes.**
- **No writes to the volume being scanned** during a scan, except the app-data cache, whose own size is excluded when it sits on the measured volume.
- **Any native call over 1 ms is async.** Progress crosses into JavaScript at most 10 times a second, and the SSE progress shape stays unchanged.
- **A correctness test is never "fixed" by loosening its assertion.** Every new assertion is proven by a mutant.
- **Count, don't time.** Tests assert counts, never wall-clock bounds.
- **End users never need a Rust toolchain.**
- **No release until every phase is complete,** including Phase T step 2, with CI green on all four legs after each phase, unless you change this rule in OD1.
- **Ask first** before anything outward-facing: a tag, a release, a new crate or package, a public API shape change, a change to the offload verification algorithm, or anything that needs elevated privileges.

**Exceptions you approved:**
- TreeMap may `unlink` its own spill files inside `<appData>/scan-spill` (Q1, 28 Sep), an exception to MP §3.1.
- No legacy fallback in spill or aggregate or above `T_mem` (Q10, P4-14, 28 Sep): a native failure there fails the scan with its reason. Decided, not built. This sits beside "the built-in walker stays" and bears on U1 (OD9).

---

## Open decisions for the owner

These are numbered **OD1-OD16** so they cannot be confused with the older decision numbers in `DESIGN.md` (D1-D10, your approvals of 18-21 Sep) or in the phase plans; those keep their meaning and are written here as, for example, "DESIGN D10".

| # | Decision | Recommended answer |
| --- | --- | --- |
| **OD1** | **In plain words: may the first release come out before the backend is rewritten in Rust?** Your rule, verbatim (23 Sep): "Do not make a release until all of the phases in the roadmap is complete." Phase T step 2 is a phase of this roadmap, so by default the release waits for it. Answering "No, don't wait" changes that rule: the first release would come after Phase 8 and the Track U gate, on the step-1 build, and step 2 would follow it. Until you say so in your own words, the release stays after step 2. | **Don't wait, on one condition,** if you are willing to change the rule. The condition: the step-1 app, built with Phases 4-8 included (onnxruntime-node too), is smaller than T-1's Electron build from main by at least a figure you set (in MB or %). Both are measured on this Mac under the same conditions. Why: step 2 is likely the longest piece of work here, by route count (141 routes, 58 or more of them state-changing), and the last tagged release (v5.0.1, 7 Sep) lacks security fixes made since. The draft Tauri plan recommends the same (its OQ1). If the measured step-1 app misses your figure, I will say so plainly and ask again. |
| **OD2** | **In plain words: three technical choices inside Phase 4 were made by me and need your OK.** Q2: the Phase 4 gate judges memory by the most the system says the scan held at any moment ("maxRSS"), with a second reading shown beside it. Q4: in the huge-disk summary mode, a folder says how much it left out (`omitted`), and a question about a file the summary did not keep answers "not kept" (`notKept`) instead of guessing; these add two fields to the public API and change nothing existing, which is why your ask-first rule applies. Q7: one shared list decides which folders belong to a cloud-sync service, used by both the TypeScript and the Rust code, so the two never disagree. Q7 is already built on (T11); Q2 and Q4 shape work not yet built (T22, T19). Technical note: T0's gate names Q1-Q5 and Q7. Q8, Q9, Q11, Q12, Q14, Q15 and Q17 are also engineering decisions you may overrule (plan §S.11), but none gates T0. | Confirm all three as written. |
| **OD3** | *(Needed before step 2 starts.)* **In plain words: when Node leaves the app, TreeMap's older TypeScript scanner and duplicate finder can no longer ship as the backup. What checks the new code then?** Technical note: the master prompt says never to remove the legacy engine, the safety net and correctness oracle. | Keep both as **referees in the tests and CI**. Ship a plain Rust fallback walker, proven equal to them by the same equivalence digests (a fingerprint of the whole scan result, compared between engines). |
| **OD4** | *(Needed before step 2 starts.)* **In plain words: TreeMap also runs as a web page, inside VS Code, in Docker, and as a tool for AI assistants. After step 2, what runs those?** Technical note: web mode (`npm start`), the MCP server (`npm run mcp`), the VS Code extension (it builds TreeMap and starts `dist/index.js`) and the Dockerfile all run the TypeScript backend today. MP §3.5 requires web mode with no toolchain on macOS arm64, macOS x64, Windows x64 and Linux x64/arm64 (R34). | **One backend:** the Rust server serves web mode and MCP too, shipped as prebuilt programs for every web-mode target, each download checked against a known fingerprint (SHA-256) as the native-module download (`fetch:native`) is, and used by `npm start`, Docker and the VS Code extension. Otherwise keep the TypeScript backend for those channels. You chose Apple-silicon-only for the desktop app (26 Aug); whether web mode keeps macOS x64 is part of this decision. |
| **OD5** | **In plain words: leftovers on your Mac from test incidents.** We never touch these; each is your call. | (a) Small test files in your Trash: three 1,000-byte `holiday.mp4` files per full test run since 28 Jul (`tests/compressionAdvisor.test.ts`, still so on main until FG2 lands) and six 1 KiB files `f0.bin`-`f5.bin` per full run from 26 Aug to 29 Sep (`tests/cartCommit.test.ts`, fixed by FG1): possibly many copies, one set per run. Nothing else was put there: `rateLimiterLanes` only read the Trash's list (names and sizes), and the three other tests FG2 caught had nothing to move. Nothing is required; empty them with your Trash whenever you like. (b) About 720 test snapshots in your real History: clean them after backing up `snapshots.json` (the earlier recommendation). (c) Chromium files that changed in your TreeMap app-data folder on 27 Sep: leave them. (d) The 8 KB item a test sent to the Trash earlier: leave it. (The two CSV files in `~/Downloads` were already moved out; nothing to do.) |
| **OD6** | *(Asked when Phase 5 starts; it blocks Phase 5 T1a.)* **In plain words: should TreeMap refuse to delete the last copy of a duplicate, no matter which button or tool asks?** Technical note: Phase 5 Q9. It changes the documented behaviour of `DELETE /api/files` and `/api/cart/commit`. | Every route |
| **OD7** | *(Needed before any Tauri code enters the repo: T-14 onwards.)* **In plain words: Tauri brings new building blocks from outside, and your rule is to ask before any new crate or package.** Technical note: the `tauri` crates and their dependency tree, its plugins (notification, dialog, opener, single-instance, updater), the `tauri-cli` tool (installed through cargo, not npm, per the draft's OQ8), and the Node runtime the sidecar ships. Your "Just switch to tauri" approves Tauri itself; the exact list has not been shown to you. The earlier crate approval (DESIGN D10, 21 Sep: "Rust crates from crates.io may be added for Phases 5–8") covers Phases 5-8 only. The throwaway spike (T-13) already builds with tauri 2.12.0 and these plugins in a scratch folder outside the repo; nothing is added to the repo before your answer. | Yes, as the Tauri plan lists them (names and versions), each reviewed for licence and advisories before it is added (R38). |
| **OD8** | **In plain words: the step-1 plan recorded on 30 Sep drops gdu, the second, borrowed scanner TreeMap carries (20.9 MB). Before it goes from the Mac app, two things need your say.** First, "gdu" is a choice in the Scan engine setting and in the public API, so removing it changes both, and your ask-first rule covers that. Second, new evidence: at 1M entries on this Mac, gdu measured faster than the new engine (97,666 against 91,308 entries/s, from two harness versions, so not like for like), so dropping it could make first scans slower. Technical note: removing it is a public API shape change (MP §11.1, §15), and saved settings holding `'gdu'` are migrated. On macOS and Linux the fallback chain becomes native → walker. CURRENT-STATE counts gdu as part of the legacy engine that MP §13 says not to remove, and DESIGN D2 keeps every existing engine. The Phase 1 gdu baselines and Phase 8's gdu-bare reference depend on it. Against it: gdu reports refused folders as empty (U1). The Windows build's gdu never runs and goes without this question (T-5). | Keep the step-1 decision, but remove gdu from the Mac app only after a same-run measurement of native against gdu on this Mac, on a whole-disk scan (the U2 diagnosis, or Phase 8's `bench ab` brought forward), shows native is not slower, or you accept the difference. Then keep gdu only as a CI-side reference clock (gdu-bare), keep its baselines as history, and migrate saved `'gdu'` settings to `'auto'`. |
| **OD9** | *(Answered before Phase 4's gate.)* **In plain words: after Phase 4, rescanning your whole disk will likely run in "spill" mode (the scan keeps its list on disk instead of in memory), and for that scan these features switch off: Duplicates, near-duplicates, Compare, Empty Folders, the custom rule for names and sizes that occur more than once, per-file export (CSV or XLSX), offloading a whole folder, Live mode, opening an archive or Photos library inside the scan, and moving cloud files to the provider's trash. Is that acceptable?** Technical note: your disk projects to about 7.25M entries (1.25 × 5.8M), above `T_mem` = 5M, so it runs in spill mode (R81; the list is `src/services/storageMode.ts`'s). The first seven stay off until they are ported to native code (Q6); the last three are off because a spill scan is read-only after the walk (Q5, P4-6a). T18's FullPassRunner, already required inside Phase 4 (your Q6 answer, 28 Sep), keeps the cleanup suggestions, custom rules without the duplicate option, queries, the calendar and the other full-pass views working in spill; it restores none of the ten above. Under Q10, a native failure there fails the scan. `T_mem` = 5M rests on your own Q3 answer (25 Sep: "memory mode up to 5M"), so raising it changes that answer; its engineering half (Q17) you may also overrule. | Measure memory at 6-7M entries against the 700 MB ceiling first (a T22 addition). Then choose between: (a) accept these losses on whole-disk scans until later phases port them; or (b) change your Q3 answer and raise `T_mem`, if the measurement allows it. |
| **OD10** | **In plain words: should Eco also pause while another app is using the disk heavily?** The master prompt asks for it (MP §8.1); nothing builds it yet (Phase 8 Q6). | Phase 8's recommendation: a plan of its own after Phase 8, built and measured on your Mac first, adopted only if an interactive app's reads get faster with it. Until then the audit row reads "not met — owner decision". |
| **OD11** | **In plain words: one test for Phase 6 needs about 84 GB of test pictures, over your 40 GB cap.** Technical note: Phase 6 Q4's 200,010-image corpus, sized by extrapolation. | Raise the cap for this one run (the corpus is deleted after the gate). If you say no, the gate runs at 1/N scale, labelled (R41), and the 90 s row reads "at 1/N scale", never met. |
| **OD12** | **In plain words: how do people who already have TreeMap get the Tauri version, and when?** Technical note: today's installs update through electron-updater, which reads `latest.yml` and `latest-mac.yml`; a Tauri release produces neither. The Windows installer would otherwise sit beside the old install. The Windows portable exe and the portable zip/AppImage builds need a Tauri equivalent or a decision to retire them. Tauri's own updater needs a signing key that you would hold. The bridge needs one more Electron-readable release, and your rule allows no release until every phase is complete. | The bridge ships **with** the first Tauri release: the same release publishes the `latest.yml` / `latest-mac.yml` that point today's Electron installs to the Tauri installer, so it is part of that one release, not an earlier one. Whether one release can carry both is to verify in the plan (T-23, T-25); if it cannot, the bridge becomes an exception to your release rule that you approve here. After that, Tauri's updater with a key you hold. The old install is replaced, not duplicated. Portable builds are kept where Tauri can produce an equivalent (checked in the plan); any retirement is your call. The version goes above 5.1.0. |
| **OD13** | **In plain words: when you ask TreeMap for a small preview picture of a photo that is stored only online (in iCloud or OneDrive, not on the disk), making that picture would make the Mac download the photo. Should TreeMap refuse?** (asked 25 Sep, still open). Technical note: `/api/files/preview?thumb=1` (`makeThumbnail`) can open an online-only macOS file when asked; it already refuses links. Phase 6's plan (T13) already tests that `?thumb=1` never opens a flagged or evicted file. | Refuse, with the same sentence the duplicate viewer gives ("opening it would download it"), as recommended then. |
| **OD14** | **In plain words: Tauri work has started while Phase 4 is still open. Is that overlap OK?** Your words were "so do it"; I read them as "start now". Your rule is that a phase starts only after the one before it is finished with CI green. Technical note: already started: the draft plan, the throwaway spike, and T-6 (committed in a worktree, not on main). Nothing lands on main without its gate, CI must be green on four legs after every push, and Phase 4 and step 1 each close with their own gate. | Yes, as long as each piece lands gated green, one at a time. If you say no, Phase T work stops at what is committed in worktrees until Phase 4 closes. |
| **OD15** | **In plain words: a help line in Settings says Eco turns on by itself "when the Mac runs hot". On Windows and Linux that should say something else.** (Parked in the hand-over.) | "when the computer runs hot" on every platform, or the platform's own word, fixed with a test in Phase 8 T10 (honest UI copy). |
| **OD16** | **In plain words: should scans you start yourself run at full speed ("Turbo") by default?** Today a scan you start runs at "Balanced" (about half the machine), and Automatic switches to the gentle "Eco" on battery or when the Mac is hot. Turbo finishes sooner and still gives way to the window; it uses more of the Mac while it runs. Scheduled and background scans stay gentle whatever you choose. Technical note: MP §8.1 makes Balanced the default; the diagnosis ranks the Balanced budget third among U2's causes. | **ANSWERED 30 Sep 2026: yes** (your words: "yes turbo by default"). Scans you start and watch run at Turbo by default; scheduled and background scans stay Eco; Balanced and Eco remain choices in Settings. Built as a Track U task, test-first. |

Phases 5-8 carry their own questions (Phase 5 Q1-Q11, Phase 6 Q1-Q10, Phase 7 Q1-Q6, Phase 8 Q1-Q6), each with a recommendation in its plan. Per the standing rule, each is asked when its phase starts. Questions already answered are not asked again.

---

## Risks still open

These come from `docs/engine/RISKS.md`: every row not marked retired or fixed there, corrected where RISKS.md is out of date. Severity is the cost to a user if the risk lands. (T) marks a risk whose wording assumes Electron or gdu, which needs re-reading after Phase T step 1.

| Id | Risk | Severity |
| --- | --- | --- |
| R5 | A cache causes a delete (Phase 5 makes the last-copy rule server-side) | CRITICAL |
| R8 | The native tree silently differs from the legacy tree | CRITICAL |
| R39 | A number printed that no run produced | CRITICAL |
| R44 | Native code opens files (path escape, symlink swap) | CRITICAL |
| R2 | The walker still guesses which files are placeholders; FUSE not yet read-hostile | HIGH |
| R3 | Spill files fill the disk the user is cleaning (T16's conversion owed) | HIGH |
| R6 | Deleting one hard link or clone reported as reclaimable (Phase 5) | HIGH |
| R9 | `ATTR_CMN_RETURNED_ATTRS` ignored gives garbage sizes | HIGH |
| R12 | Vanished and permission-denied handling regresses (a refused folder shown as empty) | HIGH |
| R15 | macOS warm-cache targets above ~250k entries unmeetable on a default install (`kern.maxvnodes`) (bears on U2) | HIGH |
| R18 | TCC: a folder macOS refuses to the app (bears on U1) | HIGH |
| R21 | Firmlinks and bind mounts (bears on U1) | HIGH |
| R33 | A missing or wrong-arch prebuild ships (T) | HIGH |
| R34 | An end user is asked for a Rust toolchain | HIGH |
| R40 | Noise read as a result | HIGH |
| R43 | Equivalent mutants and tautological tests | HIGH |
| R45 | Unsafe Rust | HIGH |
| R46 | A panic or crash in the core takes the app down (its mitigation re-runs the scan on the legacy chain: bears on U1 and U2) | HIGH |
| R48 | A phase claimed done on green tests without a reviewed diff | HIGH |
| R50 | The labelled image corpus may be unfair to hash signatures | HIGH (Phase 6's claims) |
| R56 | A cancelled walk wedged in a kernel call cannot be joined (mitigated) | HIGH |
| R73 | The equivalence proof rests on one list of id comparisons. Its retirement evidence, T2's batteries, is built (25 Sep); RISKS.md is to be updated. | HIGH |
| R71 (remainder) | A copy without the native module keeps the scan's flags alone, so a file evicted after its scan could be read (bears on a sidecar that fails to load the module) | HIGH |
| R93 (remainder) | The renderer's memory while it parses the first tree is still not measured (bears on U3) | HIGH |
| R4 | Spill files outlive a crash (unlinked at creation; the boot sweep is wired, T17a `3bdc588`) | MEDIUM |
| R10 | NFC/NFD twins double-count on macOS | MEDIUM |
| R11 | Windows allocation accounting appears for the first time | MEDIUM |
| R14 | Sub-second mtimes lost break the incremental rule | MEDIUM |
| R62 | NTFS turbo cross-check counts a missing entry as a skip | MEDIUM |
| R16 | A run cannot be labelled cold without root | MEDIUM |
| R17 | `getattrlistbulk` returns `ENOTSUP` on SMB/FUSE | MEDIUM |
| R19 | Windows long paths, junctions, `MAX_PATH` | MEDIUM |
| R20 | Linux io_uring blocked by seccomp; cgroup limits | MEDIUM |
| R25 | Only Tier B exists here | MEDIUM |
| R26 | The legacy engines cannot hold Eco exactly (`nice` on gdu shards) (T) | MEDIUM |
| R28 | Sleep/wake keeps a drive awake or resumes into a vanished mount (the pause runs on Electron's power events) (T) | MEDIUM |
| R29 | RSS counts mapped file pages | MEDIUM |
| R30 | Aggregate-mode budget margin | MEDIUM |
| R36 | Contributor friction: Rust in a TypeScript repo | MEDIUM |
| R37 | Vendored code drifts or inherits defects | MEDIUM |
| R41 | The 500 GB duplicate and 200k-image corpora cannot be built here (scaled) | MEDIUM |
| R43b | Corpora on a tmpfs `/tmp` make a "cold" label false | MEDIUM |
| R43c | Windows allocates `ftruncate`d files in full | MEDIUM |
| R47 | Building the walker before the governor (moot in practice: Phase 2 came first) | MEDIUM |
| R51 | A first process launch after a pause is 15-27 % slower (measured on gdu) (T) | MEDIUM |
| R58 | NTFS turbo starts one program as administrator (prompt not provable on CI; the app's own question is an Electron dialog; works only in a per-machine install, which bears on the Tauri installer's scope) (T) | MEDIUM |
| R60 | The persistent index keys hard links by a file id held as a double | MEDIUM |
| R67 | tm-mft holds every record in the elevated helper's memory | MEDIUM |
| R72 | Electron forbids JavaScript views of Rust memory (T) | MEDIUM |
| R74 | Aggregate's worst-case memory margin is 36 MB at 100M | MEDIUM |
| R75 | One folder of more than ~1.2M entries breaks aggregate's worst case | MEDIUM |
| R78 | Windows large scans need the hard-link key log on disk (T20) | MEDIUM |
| R80 | The FullPassRunner's cost is not measured (T18) | MEDIUM |
| R81 | Features lost above `T_mem` (bears on U1 and OD9: your own disk) | MEDIUM |
| R82 | `pruneStore` emits every child of a popped folder (bears on U3) | MEDIUM |
| R83 | Spill disk space is invisible (unlinked files) | MEDIUM |
| R95 | A tree past the memory store's room (6.19M rows, or 800,000,000 bytes of names) is walked twice (bears on U2 on main; your 5.8M is below the row room, and the name room is out of reach by arithmetic) | MEDIUM |
| R97 | Windows: running spill files have names a walk could count (T17) | MEDIUM |
| R7 | Offload verification drift: no algorithm field on disk | LOW |
| R13 | A file growing while hashed | LOW |
| R22 | The developer Mac's C toolchain | LOW |
| R23 | macOS 27 resets loopback connections beyond the backlog (test only) | LOW |
| R27 | Thermal and battery signals need IOKit from Rust | LOW |
| R31 | Name interning at 100M | LOW |
| R32 | The Node side still materialises object trees | LOW |
| R35 | Electron packaging rebuild trap with a second native module (T) | LOW |
| R38 | Crate downloads (bears on OD7) | LOW |
| R42 | Bytes read is hard to measure on macOS without root | LOW |
| R49 | Windows MFT and the deep tier need the owner's decisions (answered; Phase 7 remains) | LOW |
| R52 | A body-less POST is a CORS-simple request (Phase 8 T15) | LOW |
| R52a | Eco and Balanced sit at duty 1.0 on 8 cores | LOW |
| R53 | A volume mount point walked when it is the scan root | LOW |
| R54 | Lone UTF-16 surrogate handling varies with libuv | LOW |
| R57 | The prebuilt module's only integrity check is its version string (Phase 8's plan leans on Electron fuses) (T) | LOW |
| R63 | A `subst` or session-mapped drive passes the check and fails in the helper | LOW |
| R64 | Cancelling a scan does not close its elevation question (planned fix uses Electron's dialog) (T) | LOW |
| R65 | `mftTake` decodes on Node's main thread | LOW |
| R66 | `refresh_families` re-reads hard-link families on one thread | LOW |
| R68 | The pre-`Start-Process` check reads the owner, not the ACL | LOW |
| R69 | Nothing holds the helper open between the checks and `Start-Process` | LOW |
| R70 | The unelevated PowerShell inherits the user's environment | LOW |
| R76 | The hybrid FIFO→LIFO queue changes walk order | LOW |
| R77 | Commit-lock contention | LOW |
| R79 | Aggregate lists may carry `exact: false` | LOW |
| R84 | Cold spill reads on slow media | LOW |
| R85 | MFT scans stay memory-only, refused above `T_mem` | LOW |
| R86 | Moving S1's per-row rules into a per-listing kernel. Its retirement evidence, T7's column check, is built (26 Sep); RISKS.md is to be updated. | LOW |
| R87 | Measurement caveats (design timings taken under load) | LOW |

**Found on 30 Sep by the FG3 review, older than this work, being fixed in FG4** (ids assigned in RISKS.md when FG4 lands):

| Id | Risk | Severity |
| --- | --- | --- |
| FG4-a | A git repository planted under a scanned folder runs its own configured commands (`core.fsmonitor`, a clean filter via `.gitattributes`, hooks) when TreeMap runs `git status` there for the recoverability fact, reached by read-only scoring (reclaim score, `elsewhere:` queries, the facts API, the MCP `reclaim_ranked` tool). Reproduced by the reviewer; disabling fsmonitor alone is not enough (a clean filter still ran). | HIGH |
| FG4-b | `git gc --aggressive --prune=now` follows a planted `.git` file (`gitdir: …`) to a repository outside every scanned root and permanently prunes its unreachable objects. | MEDIUM |
| FG4-c | The macOS snapshot restore checks its destination once, before the password prompt, then copies as root (`cp -a`): a time-of-check gap. | LOW |
| FG4-d | A portable data folder prepared by someone else is trusted by every app-data writer. | LOW |

**Fixed since RISKS.md was last updated:** R96 (Windows: a worker thread that loads the addon crashed at teardown). The fix `9a8d76f` is on main, and its proof, the Windows leg's worker-only probe, passed in CI run 36534635490 (on `3670f98`) and again in run 36663542819. RISKS.md still reads "proof pending" and is updated in T23 or the next docs commit.

**New risks from the move to Tauri** (proposed ids and severities, to be entered in RISKS.md by the Tauri plan):

| Id | Risk | Severity |
| --- | --- | --- |
| RT1 | Settings and history lost if the app-data folder or its file names change. Tauri's default folder is named after the bundle identifier, not "TreeMap", so the backend must keep choosing the folder itself. The page's nine browser-storage keys move with the web view and must be migrated, or their loss stated (T-10). | HIGH |
| RT2 | Porting the backend re-opens every hard-won guard: scanned-root, spill folder, app-data, name folding, links, audit, idempotency. Golden tests prove response bytes, not refusals, and today they cover 11 responses on macOS only, so every refusal test must also run against the Rust backend (T-30, T-31). | HIGH |
| RT3 | Signing: the sidecar and helper executables must be ad-hoc signed inside the bundle with the app, per your standing decision (no notarization; Windows unsigned as today). The Electron fuse plan behind R57 does not carry over. Recorded fact, 30 Sep: macOS 27 refused to open a helper's extracted, ad-hoc-signed developer copy of Electron with the dialog "“Electron” was not opened because it contains malware" (the download matched Electron's published SHA-256; the rule that fired is not visible in the logs). The spike (T-13) records whether a locally built ad-hoc Tauri app opens without a dialog, and the install instructions are re-checked on macOS 27 before any release. | HIGH |
| RT4 | Web-view differences (WKWebView, WebView2, WebKitGTK versus Electron's Chromium): rendering, canvas speed, EventSource, cookies on 127.0.0.1, downloads (the spike's web view saved files straight into `~/Downloads` until a handler was installed); WebKitGTK libraries on Linux CI; the WebView2 runtime on Windows | MEDIUM |
| RT5 | Node runtime size: step 1's sidecar carries Node. The Apple-silicon part of this Mac's Node v24 is 120.6 MB before trimming (the file holds two architectures, 243.5 MB), set against Electron's 234 MB, which already includes Node. Which Node the sidecar ships, and its size, are to measure, so step 1 may save less disk space than hoped. Only step 2 is sure to remove Node. | MEDIUM |
| RT6 | Sidecar lifecycle: an orphaned backend after a crash, two backends on one app-data folder, a port conflict. The spill boot sweep's pid rule must see the sidecar's pid. | MEDIUM |
| RT7 | Later phases assume Node or Electron: napi modules, better-sqlite3, sharp, onnxruntime-node; Phase 4 T16 (the chooser's runtime dimension), T18, T21 and T22's Electron leg; Phase 5 T13 and Phase 6 T9c (sleep hooks); Phase 7 T1 (the desktop loader), T2, T4a/T4b (desktop detection), T4c (Electron IPC), T6 (the child's environment), T8a's sleep pause (P7-6) and T9 (desktop consent through the bridge); Phase 8 T1/T2/T3/T4/T6/T8/T10/T14/T15/T17/T18/T19/T21/T22/T23/T24/T25/T26. Each needs re-planning. | MEDIUM |
| RT8 | Dropping Node removes the shipped TypeScript fallback and oracle the master prompt says never to remove (OD3) | MEDIUM |
| RT9 | The shell's security duties are dropped: the per-launch API token (without it the server is an open local API), the navigation guard, the new-window rule (only http, https and mailto leave the app) and the permission rule (notifications and clipboard write only). T-7, T-12 and T-16 port them with their tests. | HIGH |
| RT10 | Existing installs are stranded on Electron builds without later security fixes, because electron-updater cannot fetch a Tauri release; a Tauri installer could sit beside the old install; portable users lose their build; version ordering (the installed 5.1.0 against main's 5.0.1). T-23, T-25 and OD12. | HIGH |
| RT11 | Full Disk Access and code identity: with ad-hoc signing each build has a new identity, and a grant may not carry over to a new build or cover a separate sidecar executable. Scans would then miss folders (bears on U1). T-13 checks it; T-24 tests it. | MEDIUM |
| RT12 | Backend code that assumes Electron: `process.execPath` (shell integration, portable mode) and `process.resourcesPath`/`app.asar.unpacked` (native loader, gdu, MFT helper) point elsewhere in a sidecar, so "Scan with TreeMap", portable mode or the native module (U1, U2) could break; under plain Node, portable mode would write its `TreeMap-Data` folder beside the `node` binary. T-6 (done in a worktree, `f021e8c`). | MEDIUM |
| RT13 | The page's desktop bridge (`window.treemapDesktop`) has no Tauri counterpart yet. Tauri's usual route, `@tauri-apps/api`, would be a frontend dependency (MP §13, DoD 14), and a page served from 127.0.0.1 needs its IPC granted explicitly (to confirm in the plan). T-17. | MEDIUM |

---

## Sources

The original roadmap and its plans (repo-relative unless noted):
- `~/Downloads/TREEMAP-FAST-SCANNER-MASTER-PROMPT.md` (outside the repo): "MASTER PROMPT: TreeMap High-Performance Scan Engine (v3)", Phases 0-8, §3.3 accounting rules, §3.4 privacy, §5 targets, §9.5 rescans, §13 "do not do" list, §14 Definition of Done, §15 working style
- `docs/superpowers/plans/2026-09-18-phase1-bench-harness.md`
- `docs/superpowers/plans/2026-09-18-phase2-governor.md`
- `docs/superpowers/plans/2026-09-18-phase3-native-walker.md`
- `docs/superpowers/plans/2026-09-23-phase3-w6-mft.md`
- `docs/superpowers/plans/2026-09-18-phase4-storage.md`
- `docs/superpowers/plans/2026-09-24-phase4-s1-review-findings.md`
- `docs/superpowers/plans/2026-09-25-phase4-wave1-status.md` (historical snapshot)
- `docs/superpowers/plans/2026-09-25-cloud-session-handoff.md` (the online-only thumbnail question, OD13)
- `docs/superpowers/plans/2026-09-25-phase5-duplicates.md`
- `docs/superpowers/plans/2026-09-25-phase6-near-duplicates.md`
- `docs/superpowers/plans/2026-09-25-phase7-deep-tier.md`
- `docs/superpowers/plans/2026-09-25-phase8-ui-docs-ci.md`

State and risks:
- `docs/engine/CURRENT-STATE.md` (recorded 18 Sep 2026 against `716beb6`; §11.1 and §11.2 carry the benchmark tables)
- `docs/engine/DESIGN.md` (D1-D10; §5.2 as built; §7 the 100M budget)
- `docs/engine/RISKS.md` (R1-R97)
- `HANDOFF.md` (the Phase 0 and Phase 1 gate figures, the gate at `95df765`)
- `NEXT_SESSION_PROMPT.md` (hand-over; its LATEST block of 29 Sep ~06:40 UTC predates main's `8d3344e`, `7da2afa` and `3bdc588`…`d1def61`, and still lists Q16 as owed)
- `AGENTS.md` (the safety model as built); `SECURITY.md` (the three outbound connections)
- `bench/baselines/` (the recorded baselines); `bench/lib/report.ts` (memory printed in MiB as "MB")
- `electron/main.js` (line 43 loads `dist/server.js`; the header lists the shell's duties; the update check), `electron/preload.js` (the page's bridge), `electron/lib/guards.js` (navigation, window-open and permission rules), `electron/lib/desktop.js` (the scan queue)
- `src/services/missingGigabytes.ts` (gdu reports a refused folder as empty; the statement's lines), `src/services/scan/nativeMemory.ts` (the memory store's room), `src/services/storageMode.ts` (what each mode switches off), `src/services/diskScanner.ts` (main's fallback chain), `src/services/settings.ts` and `src/api/openapi.ts` (the `'gdu'` engine setting), `src/ui/` (the bridge calls and the nine storage keys)
- The installed build's code at `73abc4c`: `src/services/gduScanner.ts` (shard caps, rate comments), `src/services/diskScanner.ts` (when gdu runs, the walker re-run), `public/index.html` (the "Fast rescan" rule)
- `tests/goldenResponses.test.ts`, `tests/capsuleAfterTrash.test.ts`, `tests/desktopPolish.test.ts`
- Owner grants and standing rules: the TreeMap memory notes `treemap-owner-grants.md` and `treemap-macos-gatekeeper.md` (outside the repo)

Work in flight (outside the repo, in session `129272e7`'s scratch folder; durable copies of briefs and rules in `~/.claude/projects/-Users-prithvivinay-Desktop-Claude-Code/treemap-scratch-tools/session-f4f5ece4/`):
- The Tauri plan, committed with this roadmap as `docs/superpowers/plans/2026-09-30-phaseT-tauri.md` (working copy `tprep/PLAN-TAURI.md`, written 30 Sep from `d1def61`), with `tprep/STATUS.md` (T-6) and `tauri-spike/STATUS.md` and `tauri-spike/TAURI-FACTS.md` (T-13, the `~/Downloads` incident)
- FG2b, FG3b and FG4: worktrees `wt-fg2`, `wt-fg3b`, `wt-fg4`; the review findings they fix are `t17a/fg3-review-findings.json` and `t17a/fg4-findings.json`
- FG2: commit `fbbbc75` in worktree `wt-fg2` (its message names every offending test) and `fg2/STATUS.md`
- T13d and T14: worktrees `wt-t13d` and `wt-t14`, with `t13d/STATUS.md` and `t14/STATUS.md`
- The helpers' standing rules, `RULES-COMMON.md` (30 Sep, including the no-launch rule)

Owner input and measurements, 29-30 Sep 2026 (UTC):
- The owner's requests, quoted above.
- Measurements on the owner's Mac (Apple M3, 8 cores 4P+4E, 16 GB, macOS 27): the installed bundle's sizes (`du`), the disk's file tally (`df -i`) and space (`df -k`, `diskutil apfs list`, `tmutil listlocalsnapshots`), the Node binary's size and architectures (`lipo`), the app's signature (`codesign`), the crash-report folder, and `/usr/local/bin/TreeMap-Data` (absent).
- CI: run 36663542819 on `d1def61` (macOS, Linux, Linux pt-BR green; Windows red with 3 test failures, the worker-only probe green) and run 36534635490 on `3670f98` (green on all four legs, the worker-only probe green on Windows).
- Main at `d1def61`.
