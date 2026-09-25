# Phase 8 — UI, settings, documentation, the CI performance gate, prebuilds, and the Definition-of-Done audit

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Base of this plan:** branch `claude/happy-hopper-6f1ybp` as it stood on 25 Sep 2026 — its code as read at `d75a9af`, each of the session's fixes simulated green on Linux CI before it landed (listed in `docs/superpowers/plans/2026-09-25-cloud-session-handoff.md`); the code this plan cites was read there. Five commits came after it (the second review's four fixes and a test-race fix, listed in the same note), so a line number this plan cites in `perceptualDupes.ts`, `dataLocality.ts`, `placeholderResolver.ts`, `recoverabilityProvider.ts`, `autopilot.ts`, `autopilotRoutes.ts` or `query/execute.ts` may have moved; re-read the line before relying on it. Phase 4 wave 1 exists only on the owner's Mac, uncommitted, so nothing here relies on its code: Phase 4 is read through its fixed interfaces (`docs/superpowers/plans/2026-09-18-phase4-storage.md`). The phases land in order — 4, 5, 6, 7, 8 — each after the gate before it (MP §6).

## Progress (kept current so a context compaction loses nothing)

| Task | State | Evidence |
| --- | --- | --- |
| Plan written | 25 Sep 2026 | this file |
| Plans reconciled with Phases 5, 6 and 7 | 25 Sep 2026 | `## Reconciliation (25 Sep 2026)` at the end |
| T1 `GET /api/scan/:id/live`: rate, CPU share and memory of the scanning process, who paused it, the budget now and whether a change applies, every fallback in plain words | not started | |
| T2 The engine badge: fast path named, each fallback said in visible words, the technical reason one keyboard stop away, the budget as it changed | not started | |
| T3 The scan card: Pause/Resume, the compact budget control (live effect), the advanced CPU ceiling in Settings, the live readout | not started | |
| T4 Duplicates: Phase 5's Pause, Resume and Cancel verified; each copy's shared storage in words (Phase 5's surfaces) | not started | |
| T5 Similar photos: Pause, Resume and Cancel on the job (Phase 6's surfaces) | not started | |
| T6 The deep check: Phase 7's controls verified; the model download stays Cancel-only | not started | |
| T7 A resumed job never reads a file whose data left during the pause — verified on every job; Phases 5–7 build the re-checks | not started | |
| T8 The persistent index build: pausable, and inside the budget | not started | |
| T9 Storage mode in the UI: the aggregate notice in every view it switches off, the Settings storage row | not started | |
| T10 Honest UI copy, the cold-scan sentence beside every rate, the frame-cost count, `bench uiframes` | not started | |
| T11 `scripts/busy-load.js`: the one named busy-loop tool | not started | |
| T12 Unattended work runs Eco: Phase 5's `budgetCap` verified on every unattended path, and who holds a scan recorded | not started | |
| T13 Governor headroom above the Eco and Balanced ceilings (R52a), measured on the owner's Mac | not started | |
| T14 The scan boundary (MP §3.3): no engine enters another filesystem unless asked; the default is the owner's (Q5) | not started | |
| T15 R52: one same-origin guard on `/api` and on the fleet listener; the VS Code remote origin passed in | not started | |
| T16 P4-9 closed: change-journal rescan not built; DESIGN §9.1 and `openapi.ts:187` say so | not started | |
| T17 bench `ab`: walker, native and a reference outside TreeMap, interleaved; wall, CPU and memory ratios; the gate policy; planted slowdowns; the tmpfs rule | not started | |
| T18 Prebuilds for every target in `native-targets.json`, checked by architecture and SHA-256; `dist:*` builds the module; Phase 5's `--locked` verified | not started | |
| T19 The CI performance gate and its calibration on the hosted runners (fit, then held-out validation) | not started | |
| T20 `scripts/fetchNative.js` (`npm run fetch:native`), SHA-256-verified, redirects checked, untested builds refused | not started | |
| T21 The loader's dead candidates removed; the packaged app proven to load from `app.asar.unpacked` | not started | |
| T22 Third-party notices: Phase 5's generator verified, every release target covered, the licence allow-list read as SPDX | not started | |
| T23 The equivalence test on every corpus, on three platforms | not started | |
| T24 README and CHANGELOG held to `bench/`: the generated block, the wide unit detector, the cold-scan sentence | not started | |
| T25 DESIGN, RISKS, CURRENT-STATE, SECURITY, AGENTS as built, every Phase 8 departure pinned | not started | |
| T26 The Definition-of-Done audit (`docs/engine/DEFINITION-OF-DONE.md`), the owner's release precondition | not started | |
| Gate | not run | The budget selector changes a running scan from Settings, the scan card and ⌘K, and `/live` says whether the change applies to this scan (counted, not timed); the Dashboard badge shows the fast path and one plain sentence per fallback without hover, none claiming sameness or speed; `npm run bench -- readme --check`, `tests/readmeBench.test.ts` and `tests/releaseNotesClaims.test.ts` green, no performance figure outside the generated block; in the held-out calibration dispatch every planted +15 % gate run (on native, and on both TreeMap engines through walker/gdu-bare) fails and no held-out clean gate run does, on each OS whose band is ≤ 10 %, with the +11 % detection count and the 3/N false-alarm bound recorded (a wider band only with the owner's answer to Q3, stated in DESIGN §15); the `perf` job blocking and green on the owner's push; a release test build attaches every target in `native-targets.json`, SHA-256-checked, untested ones marked, and the packaged smoke passes on both installer legs; the equivalence test green on every corpus that fits, on three platforms; every §14 row of the DoD audit evidenced and confirmed by the owner's `scripts/verify-dod.js`; `uiframes` and R52a recorded on the owner's Mac; Tier A and Tier C rows reported "not available on this machine" (hosted-VM rows labelled with their recorded cores and memory), never passed |

**Goal:** a person can see and steer what the engine is doing while it does it: the budget (and whether a change reaches this scan), a Pause that works on every long job without ever downloading a file that left the disk meanwhile, the rate, the CPU share and the memory of the process doing the scan, and in plain words why an engine ran or fell back. No engine crosses into another filesystem unless the person asks. Every number the README or a release note prints comes from a committed `bench/` file. CI fails on a real performance regression — in the native engine, in the walker, or in the code both share — and its false-alarm rate is measured on jobs it was not fitted to. Every release carries a native module for every supported target, proven to load, and one that never ran its equivalence test says so. The Definition of Done is audited item by item, against evidence the owner can re-check, before the owner publishes anything.

**Architecture:** One new read-only endpoint, `GET /api/scan/:scanId/live`, answers everything the scan card and the engine badge show. Nothing is added to `/stats` or the SSE frames: `sseComplete` is under the golden byte lock, and MP §4.3 keeps the SSE shape. The scan card gains three controls, each outside `#scanStatus` (rewritten every frame) and each cleared in `endScanChrome`: the compact budget control, which is the Settings control's second view; the readout; and a Pause button separate from `#scanBtn`. The long jobs Phases 5–7 build get their controls in the views those phases built, and every resumed job asks again whether a file's data is on the disk before it reads it. The CI gate is DESIGN §15's in-job A/B, reconciling MP §12.5: the built-in walker, the native engine and the bare gdu binary (a reference with no TreeMap code in its timed path) run interleaved on one runner, and four paired ratios — native/walker wall, CPU and peak memory, and walker/gdu-bare wall — are checked against per-platform ratio files whose bands were *fitted* on one set of hosted-runner jobs and *validated* on another, with planted slowdowns counted through the gate's own policy. Release legs build every target listed in one file, a smoke run of the packaged app proves its own loading path, and a module that never passed its equivalence test is marked. README figures live in one generated block, rendered from `bench/baselines/` by the harness's own formatters; the CHANGELOG is held to the same rule.

**Tech stack:** TypeScript strict, node:test via tsx, the zero-dependency frontend in `src/ui/` parts, Rust (tm-governor's preset table only: the resume re-checks are Phase 5's and Phase 6's, T7 verifies them), napi 3.4, the Phase 1 harness (`bench/`), GitHub Actions. The actions are the ones in use today, plus `actions/download-artifact@v4` in `perf-calibrate.yml` and in release.yml's `native` job (CI only, never shipped). Electron 31 is already a devDependency; `bench uiframes` and the packaged smoke use it. **No new npm dependency and no new crate**: the crates keep the dependencies they already have (serde, thiserror, libc, objc2, objc2-foundation, windows-sys, napi, and those Phases 5 and 6 add: blake3; zune-jpeg, zune-core; objc2-image-io, objc2-core-graphics, objc2-core-foundation), and the licence notices come from `cargo metadata`, which is built into cargo. **Needs the owner's approval:** the `ubuntu-24.04-arm` hosted runner for the linux-arm64 module (Q1). Without it, linux-arm64 is cross-built on `ubuntu-latest` with the `gcc-aarch64-linux-gnu` linker and attached marked untested (P8-14), or left out of the release; `npm run fetch:native` installs an untested module only when asked with `--untested`, and the badge says so.

**House rules:** unchanged from Phases 2–4.
* Test first. Every new assertion is reddened once by a recorded mutant and restored byte-identically.
* Every new `assert.ok` carries a message (fixed 25 Sep 2026: a bare one can hang a file under Node 20 + tsx; see the cloud-session handoff).
* Count, don't time. A wait is a hang guard, never a measurement. A competing busy-loop load goes only through the named tool (`scripts/busy-load.js`, T11), never ad hoc.
* Implementers run only their own test files, never the whole `npm test`.
* Tests use `isolatedDataDir`, `fileTempDir` and `setTrashStepForTests`, and never touch the owner's app-data or Trash.
* The frontend is edited only through `src/ui/` parts: every new part goes in `manifest.json`, then `npm run build:ui`, and `node scripts/build-ui.js --check` must be clean.
* Rust: the strict lint set (no unwrap, expect, panic, todo, unimplemented, unreachable or indexing_slicing; `// SAFETY:` on every unsafe block). Run `cargo check`/`clippy` for `x86_64-pc-windows-msvc` and `x86_64-unknown-linux-gnu` too. Every agent uses its own `CARGO_TARGET_DIR`.
* Anything a worker thread or child process loads is plain JS or a `.cjs` that requires `tsx/cjs` first. CI runs Node 20.
* Never print a number the bench did not measure. Never loosen a correctness assertion or the equivalence gate.
* **Measurements on hardware.** A step marked **owner's Mac only — pending measurement, never taken on a container** is run by the owner on the Tier B Mac (8 cores). Until then its Evidence cell reads "pending measurement" and no figure is written anywhere. The cloud session's container (4 cores, Tier C by the harness's rule) never stands in for it.
* **Sibling plans are adopted, not repeated.** Where Phase 5, 6 or 7 already plans a thing, Phase 8 uses that plan's names; its task opens with a Step 0 that verifies the thing on the tree and extends it, and never builds a second one. A missing piece is built to the sibling plan's interface and test names.
* **The native handshake.** Any commit that changes `native/index.d.ts` or the preset table the Node shim mirrors bumps `package.json` `nativeVersion` and the workspace version by one minor (Phase 5's convention), and a test shows the old version is refused.
* **The agent commits; the owner pushes, triggers workflows, bumps the app version, writes the CHANGELOG entry, tags `v*` and publishes (D9).** Nothing in this plan does any of those things.

---

## Decisions fixed by this plan

| # | Decision | Why |
| --- | --- | --- |
| P8-1 | **The scan card and the engine badge read one new endpoint, `GET /api/scan/:scanId/live`**, in the `meta` rate-limit lane (`src/middleware/rateLimiter.ts`, the id-path patterns beside the progress polls). `/stats`, the SSE `progress` frame and the `complete` frame do not change. It answers for a finished scan too, while the record lives (30 minutes); after that it is `404 SCAN_NOT_FOUND` and the page falls back to `/stats` (T2). | `sseComplete` carries `buildScanStats` and is byte-locked (`tests/fixtures/golden/responses.json`); MP §4.3 keeps the SSE frame's shape. A new GET is additive (D6) and costs no golden re-record. MP §1's "extend this field set rather than inventing a parallel one" is departed from for that reason, recorded in DESIGN §12 (T25). |
| P8-2 | **What each readout number is, and where it comes from.** **Entries/s:** the record's own count, sampled by each `/live` call (`sampleScan`) into a 32-entry ring and differenced over the newest window of at least 1 s; `null` with "measuring…" until 1 s of samples exists. Today the page computes this from SSE frames against a start time that includes the POST round trip (`045-persistent-live-index.js`, the progress painter), and `/stats.entriesPerSecond` is null while a scan runs. **CPU share:** the governor's `snapshot.share1s` (`source: 'governor'`) only once `snapshot.ticks ≥ SHARE_WINDOW_TICKS` (10, a full second): before that `share1s` is a 0 that measured nothing (`native/index.d.ts`: "0 before the first tick"). Otherwise `process.cpuUsage()` over the same window ÷ (wall × `os.availableParallelism()`) (`source: 'process'`). **Memory:** `process.memoryUsage.rss()`. **Scope:** both are the figures of **TreeMap's scanning process**, the server process (Electron's main process in the desktop app), where the native engine and the built-in walker work. The page says "TreeMap's scanning process", never "this scan's" and never "TreeMap's" alone. **A scan whose work runs in a separate helper**, `gdu-turbo` (child processes, `gduScanner.ts` `execFile`) or `ntfs-mft` (an elevated helper), reports CPU and memory as `null` with the reason "this scan runs in a separate helper program, whose CPU and memory are not counted here". Neither sampler counts children (`sample.rs` `getrusage(RUSAGE_SELF)`; `process.cpuUsage()`). Summing helpers by pid is not built (DESIGN §13). A figure that cannot be had is `null` with a reason, never 0. **Status:** `cancelled` when the record is `error` with `scan.cancelled` set (`cancelScan` settles a cancel as `error`). | MP §11.4's readout, without a number no counter produced and without a label that overstates what was counted. `openapi.ts`'s `peakRssBytes` reason ("a per-process figure and cannot be attributed to one scan") stands. |
| P8-3 | **The engine badge's words come from the server, one sentence per fallback.** `noteFallback(scan, kind, reason)` (`diskScanner.ts`) takes a `FallbackKind` beside the sentence and appends `{ kind, reason }` to `scan.fallbacks`, in order, as it appends to `fallbackReason` today. A scan that falls back twice (native missing, then gdu failed) carries two kinds. The loader's failure outcome carries its own `kind` (`native.ts` `tryLoad`: missing, wrong version, load failed; `nativeScanModule`: a module without the scan functions is wrong-version), and `nativeEligibility` passes it on, so no kind is ever parsed from a sentence. `src/services/scan/engineWords.ts` maps each kind to a sentence a non-expert understands, with no path, errno, function or crate name, saying what went wrong. A kind alone does not say which engine ran next (after a native failure it is gdu on macOS and Linux, the walker on Windows or without gdu), so one more sentence, `ranInsteadWords(engine)`, names the engine that did run and the DESIGN §16 differences that apply to it: item 10 for the walker and gdu (cloud-only files are recognised only inside the usual cloud folders), and item 1 as well for gdu (a folder it may not open is shown as empty rather than counted). **No sentence claims the results are the same, and none makes a speed claim** (nothing in `bench/` measures a fallback's speed off macOS). The technical sentence stays one keyboard stop away (`<details>`), not in a `title` on a `<b>`. | MP §11.4 ("if the app fell back, the badge says so … in a sentence a non-expert understands"); §0 rule 3; DESIGN §16 items 1, 7 and 10. `noteFallback` appends (`diskScanner.ts:402-404`) and has six callers plus one direct write, which one kind could not represent. Today the reason is only in `engineText.title` (`045`, `renderDiskNotes`), which keyboards and screen readers cannot reach. |
| P8-4 | **Pause is a separate control, `#scanPauseBtn`,** beside `#scanBtn`, outside `#scanStatus`, disabled until the scan request has answered with a `scanId`, cleared in `endScanChrome`. Pause covers **scans, duplicates, near-duplicates, the deep pass and the persistent index build** (P8-23). Cancel only: offload, the Time Capsule, cart commits and compression (transactional: copy → verify → trash, with rollback), and **the deep tier's model download** (Phase 7's P7-3: a cancelled download is discarded and a retry is a new consent, so a paused download resumed later would be a second network request nobody consented to). Recorded in DESIGN §13. **A resumed job asks again before it reads** (T7 verifies; each job's own phase builds it): after every resume and at every stage boundary a Node reader asks `stillLocal` about exactly the files it is about to open, before opening them (Phase 5 T2b, the legacy finder; Phase 6 T9a, `readImageVerified`); Phase 6's image job probes each image afresh immediately before its open, with no wait between (its P6-14, T7a); Phase 5's native digest job checks each file's descriptor at every open and closes an evicted one unread as `leftDisk` (its P5-7). A read paused part-way through a file is re-checked on its open descriptor before the next chunk — Phase 5's `HashFile::still_local()` (macOS `fstat` `st_flags & SF_DATALESS`; Windows `FileAttributeTagInfo` recall attributes), called before every chunk after the first (its P5-13, T7b, T9) — and abandoned as `leftDisk` if the data left. | `frontendContract.test.ts:2122-2175` pins exactly one `#scanBtn`, owned by `setScanButtonMode`. `#scanStatus`'s innerHTML is rewritten on every frame. A pause turns seconds between the locality check and the read into hours, and a sync client can evict meanwhile (MP §3.2). Pausing only between files would miss MP §8.5's 200 ms on a large file, so the descriptor re-check is what makes a mid-file pause safe. |
| P8-5 | **The scan card's budget control is the Settings control's second view:** one implementation (`budgetControl()`), the same `PUT /api/engine/budget`, and both views repaint from that PUT's response. Automatic is included. The Settings view also carries MP §8.1's **advanced numeric override**, "Advanced: CPU ceiling (%)": 1–100 or empty, saved as `cpuPercent` with the preset, with a `400 BAD_SETTING` shown in the server's words. The compact view shows an override in force and does not edit it. The live effect is shown from `/live`, never painted optimistically. `budget.now.applies` says what a change does to *this* scan: `now` (the native engine and the walker read the budget between batches), `next-helper` (a running gdu shard keeps the priority it started with, because `applyChildBudget` sets it once at spawn and only lowers; the next shard starts at the new budget), `held` (a scan started by a schedule, Autopilot or another computer stays at Eco whatever the setting; `heldBy` names which) or `finished`. A change is never shown as applied to a held or finished scan. | MP §8.1 ("three presets in Settings, plus an advanced numeric override"), §11.4 ("takes effect immediately and visibly"). Today the row has no `cpuPercent` control (`235-settings-modal.js`, `saveEngineBudget`), and the Dashboard's "budget: X" is the start preset. |
| P8-6 | **The frame budget is counted in tests and measured by `bench`.** node:test has no layout, paint, compositor or display. `tests/scanFrameCost.test.ts` counts, per progress frame and per readout paint, DOM writes, layout reads, canvas ops and timers, and the counts must not grow with `scanned`. MP §5.3's "60 fps maintained, no frame over 32 ms" is **measured** by `npm run bench -- uiframes`: a visible Electron window running the real page records rAF gaps through a real scan. **The verdict, fixed before any measurement:** per run, zero frames that miss a 60 Hz vsync (a gap over 1.5 × 1000/60 ≈ 25.0 ms, whatever the display's own rate) and a longest gap ≤ 32 ms, on the native engine at Turbo and on the walker at Turbo. A miss is reported with its count and longest gap, never passed by a median. MP §12.4 asks for this check "automated through the existing test setup in `tests/`". node:test cannot show frames, so the tests count and the bench times. That departure is recorded in DESIGN §15. | Count, don't time (house rule). An honest frame number needs a real renderer, and Electron is already a devDependency. The precedent for counting render work is `tests/fxChartsPerf.test.ts`. |
| P8-7 | **UI copy makes no speed or equivalence claim that `bench/` or DESIGN §16 contradicts, and says "this computer", never "the Mac" on every OS.** The copy test reads `src/ui` **and** every sentence `engineWords.ts` returns. These change: the gdu hint's "measurably faster" (`045`, `renderDiskNotes`; `CURRENT-STATE.md` §11.1 has the turbo-walker ahead of gdu on ci20k), "every engine counts the same files the same way" and "the fastest engine that is exactly as correct" (`110-modal-settings.html:51,56`, against DESIGN §16 items 1, 7 and 10), "when the Mac runs hot" (`:24`), and Eco's "A quarter of the machine" (`:29`), which becomes a ceiling ("at most a quarter of this computer's processor"). It is a ceiling and not a promise: T13 measures only 8 cores, so DESIGN §8.1 records "> 8 cores: the formula only, not measured". **MP §5.2's cold-scan sentence is said in the UI as well as the README**: one line beside every rate the page prints (the engine row and the live readout), word for word from `bench/README.md`'s "Plain words for the README". | MP §5.2 ("say this clearly in the UI and the README"), §13; R39. |
| P8-8 | **R52a: Eco and Balanced get one worker of headroom above their ceiling.** `max_workers(preset, cores) = min(cores, max(phase2_cap, ceil(ceiling × cores) + 1))` for Eco and Balanced; Turbo is unchanged. Eco goes 8 cores → 3 and 16 → 5; Balanced goes 8 → 5 and 4 → 3; Eco is unchanged up to 4 cores. The ceiling is still held by the duty ledger. **Kept only if measured better** on the owner's Mac (Tier B, 8 cores), before and after, with `scripts/busy-load.js` as the competitor: **owner's Mac only — pending measurement, never taken on a container**. Otherwise it is reverted, R52a closes as "copy fixed, cap kept", and the measurement is recorded. The existing pins move with it as a spec change recorded in DESIGN §8.1: `tm-governor/tests/controller.rs` (Eco ≤ 2 and Balanced ≤ 4 on 8 cores), `tests/governor.rs` (Balanced 4 workers, Eco `workers == 2`), `tests/engineBudget.test.ts` (the shim cap), and Phase 5's `tests/capped.rs` (`capped_duty(Eco, 8)` becomes 0.25 × 8 / 3). The ceiling assertions (`assert_held`) do not move. Rust and the Node shim are held to one committed table, `crates/tm-governor/tests/fixtures/max-workers.json` (cores 1–256 × three presets), which a Rust test and a Node test each check, so no napi export is needed. The change bumps the handshake. Background QoS for Eco is unchanged (the owner's decision, `CURRENT-STATE.md` §11.2). The departure from MP §8.1's "1 to 2 workers" on 5+ cores is recorded in DESIGN §8.1. | `preset.rs:24,114`: `ECO_MAX_WORKERS.min(cores)`. That is zero headroom at 8 cores, and above 8 cores the 25 % ceiling cannot be reached at all (16 cores: 2/16 = 12.5 %). Balanced has zero headroom on every even core count. R52a: "to be measured, not assumed". |
| P8-9 | **Unattended work runs Eco: Phase 5 builds it, Phase 8 verifies it.** Phase 5's P5-14 and T5 give tm-governor `lower_of`, `capped_duty`, `throttle_capped` and `worker_limit_capped`, tm-walk `CappedPacer`, and `scanStart` `budgetCap: 'eco'`. Node passes the cap for scheduled, Autopilot and fleet-triggered scans and for every unattended hash job. `throttle_capped` applies `lower_of(effective, cap)`'s profile to the calling thread and re-applies it whenever either changes, so the governor's process profile never overwrites the cap. A cap living only in the pacer would have been overwritten: `Governor::throttle_unless` re-applies the process profile on every generation change (`governor.rs:315-318`) and sleeps at the process duty. Phase 8 adds no second mechanism. T12 verifies each path and adds only the record of *who* holds a scan (`budgetHeldBy`), which `/live`'s words need (P8-5). | MP §8.5 ("scheduled scans always run in Eco … because nobody is watching"); `docs/superpowers/plans/2026-09-25-phase5-duplicates.md` P5-14, T5. |
| P8-10 | **R52: one guard, `sameOriginGuard`, on `/api`,** mounted after `hostGuard` and before the body parser. It **refuses a present cross-origin signal**: an `Origin` that is neither the server's own origin (scheme, host *and* port) nor listed in `TREEMAP_ALLOWED_ORIGINS`, `Origin: null`, or `Sec-Fetch-Site: cross-site` or `same-site` without such an `Origin`. It **allows an absent one** (agents, MCP, curl). The refusal is `403 { code: 'CROSS_ORIGIN' }`. The default scope is every method (Q2). **The fleet peer listener** (`fleetSync.ts` `handlePeerRequest`, a bare `http.createServer` outside the Express stack) applies the same `originVerdict` before anything else. Peers are Node clients that send neither header, and a browser page on the LAN could otherwise spend the pairing attempts (5 per address, 50 in total). **VS Code remote windows:** the extension resolves the forwarded origin (`asExternalUri`) for the port it chose *before* spawning the server, and passes it in `TREEMAP_ALLOWED_ORIGINS` after its `TREEMAP_*` strip. A retry on another port asks again. The environment is built in `vscode-extension/src/lib/serverEnv.ts` so the main suite can test it. **Limits, stated in SECURITY.md:** (1) a browser without Fetch Metadata (Safari before 16.4) sends neither header on a cross-site `<img>` GET, so such a GET is not refused there; (2) under a wildcard bind `hostGuard` steps aside and the Host is the network's (the token is then required, AGENTS.md). In the default loopback bind `hostGuard` has already refused any Host that is not a loopback name or the bind address, so comparing Origin with Host compares it with those. | R52 says the check "must land on all of them at once". A route-by-route guard would miss routes: a grep counts 57, and `factRoutes.ts:51` (`factRouter.post(` split across lines) is one it misses. Non-browser clients send neither header (AGENTS.md). Desktop mode already has its token and a `SameSite=Strict` cookie; web mode without a token is the exposure. As structured today, `vscode-extension/src/server.ts` strips `TREEMAP_*` and spawns before `extension.ts` calls `asExternalUri`, so the forwarded origin could never reach the child. |
| P8-11 | **P4-9 closed: a change-journal rescan (FSEvents or USN) is not built.** (1) P4-9's measurement: with one listing per directory, revalidating a directory costs what listing it costs. (2) USN: the documented privileged read needs a volume handle, which is administrator-only, and MP §15 says ask before elevation (D7 covers the MFT mode alone). An unprivileged read (`FSCTL_READ_UNPRIVILEGED_USN_JOURNAL`, Windows 10 1709 and later) is reported by a third-party source and **not verified here**, so this reason is recorded as unverified and the decision does not rest on it. (3) FSEvents history can be purged, wrapped or disabled per volume, so a correct rescan must detect every gap and fall back, and it needs a persisted tree of the last scan. That tree is a second on-disk copy of the scan: at DESIGN §6's as-built 38 B per node plus the name bytes (8 more with access times), at least 3.8 GB at 100M before names (an estimate from that arithmetic, not a measurement). That is R3's disk-fill risk, while MP §9.3 makes spill files scan artifacts that never outlive their scan. (4) MP §9.5: stale sizes are worse than slow. What would reopen it: a measured need, plus the owner's disk budget for a persisted index. | Honest numbers. P4-9 left the decision to Phase 8. `openapi.ts:187` still promises "Phase 4's index". |
| P8-12 | **The CI perf gate is DESIGN §15's in-job A/B, reconciling MP §12.5, with a reference outside TreeMap's code.** Read literally, MP §12.5 ("fail … on a regression over 10 % against the committed baselines") cannot be done. All 19 baselines are `darwin-arm64-tierB`, the hosted runners are Tier C by `bench/lib/machine.ts`'s rule, and `compare` refuses a different tier, platform or architecture by design (`report.ts` `comparabilityDifferences`). Absolute times on shared runners also move between jobs by more than 10 %. One job runs three legs on `ci20k` at **Turbo**, one fresh child per run, after one warm-up each, in rounds whose order rotates so each leg takes each position equally often: the **walker** (`turbo-walker`), **native**, and **`gdu-bare`**, the pinned gdu binary run directly over the corpus with no TreeMap code in its timed path. **Four paired ratios**, each the median of five with its resolution: native/walker **wall**, native/walker **CPU seconds** (process and children, `BenchRun.cpuSeconds`), native/walker **peak RSS** (MP §5.3: "gate on CPU seconds per million entries and peak resident memory"), and walker/gdu-bare **wall**. The last one catches a regression in the walker or in the code both TreeMap engines share (`PackedScanStore`, `settleComplete`). native/walker alone cannot: a slower walker lowers it, and a shared slowdown cancels in it. **Still not seen, stated in DESIGN §15:** a slowdown that also hits gdu-bare (the runner, not TreeMap), and a regression in a path with no row of its own. Committed ratio files are per suite and platform (`bench/ci/<suite>-<platform>-<arch>.json`, with the corpus and run count inside). The gate **FAILs** when (a) native is slower than the walker beyond the in-job resolution, or (b) a gated ratio exceeds its committed median by more than `max(10 %, its measured band)` beyond the in-job resolution, **and a confirmation run agrees**. INCONCLUSIVE never fails: it retries at the file's `retryRuns` (9 when no file exists) and, if still unresolved, passes with a "not perf-gated this push" annotation. **One function, `gatePolicy`, runs this sequence** for the CI gate and for calibration alike. The job lands **advisory** (`continue-on-error: true`, annotated) and becomes blocking in the commit that adds its ratio files. **Duplicates** get their own row once Phase 5's native finder (its T12) and its re-recorded legacy finder, `sha256-oracle` (its T4; the suite's `--finder` itself is its T0), exist: `sha256-oracle` against `blake3-staged` on ci20k (`sha256-staged` is refused after Phase 5 T4 — it names the pre-rewrite finder, which lives on only as a committed baseline), calibrated the same way, with no outside reference (a regression shared by both finders is not seen, stated). Near-duplicates are not gated in CI: the legacy engine fails correctness (precision 0.18, `CURRENT-STATE.md` §11.1), so no in-job reference exists. Phase 6's committed Tier B baseline is compared by hand at each gate. The trigger is push to `main` and PRs (D9). | The walker is the A leg, not gdu. gdu launches processes (R51's first-launch noise) and is not Windows' fallback (R59). The equivalence gate already pairs native with the walker. gdu-bare is only a clock that TreeMap's code cannot move. Interleaving cancels drift, and paired ratios cancel most runner-to-runner speed. ci20k native ran 58.4 ms at ±22 % on the owner's quiet Mac (`CURRENT-STATE.md` §11.2), which is why the band is measured, not assumed. |
| P8-13 | **The noise band is measured on the hosted runners: fitted on one set of jobs, validated on another.** `perf-calibrate.yml` (workflow_dispatch only) runs two dispatches per OS. **Fit:** 20 clean gate runs. Each gated ratio's band is its largest clean deviation from the clean median plus a 2-point margin, and its threshold is `max(10 %, band)`. **Validate (held out, a second dispatch):** at least 20 clean gate runs, and 5 planted gate runs at each of +11 % (or 10 % plus the fit's median resolution, whichever is larger), +15 % and +25 % on native, plus 5 at +15 % on both TreeMap engines (walker and native; gdu-bare untouched). Every gate run executes `gatePolicy` in full (first A/B, the INCONCLUSIVE retry, the confirmation run), and **only a final FAIL counts as detected**; a planted run that ends INCONCLUSIVE is missed. `ab-calibrate` writes a ratio file only when every +15 % native run fails, every +15 % shared run fails (through walker/gdu-bare), and no held-out clean run fails. The +11 % detection count is recorded as the gate's measured floor. **False alarms are reported from the held-out set only.** 0 in N gives ≤ 3/N at 95 % confidence for the whole two-stage policy (rule of three: ≤ 15 % at N = 20, ≤ 5 % at N = 60; Q3). No figure is derived by squaring a single run's rate: the confirmation run shares the job's VM and is not independent. If a band exceeds 10 % at 5 runs, calibration repeats at 9 runs, then on `enum200k`, and the file records the cheapest configuration that separates clean from planted. If none gets under 10 %, the threshold is the band, subject to Q3. **The plant spins** (CPU work on the measured thread, not a sleep) for `pct × the run's own measured wall` inside the timed window, so wall and CPU both see it, and marks the run. It adds no variance of its own, so detecting a plant is an upper bound on detecting a real regression of the same size; DESIGN §15 says so. | "The gate must not flake", and "high enough to avoid flakes while still catching real regressions" (MP §12.5), shown by measurement rather than by a constant. A band fitted on the same jobs it is checked against passes them by construction. Calibration counts what the gate would do, not what a ratio looks like. |
| P8-14 | **Release targets, reconciled.** MP §3.5 names macOS arm64, macOS x64, Windows x64 and Linux x64/arm64 (web mode), with prebuilds "in the npm package and the Electron bundle". DESIGN §14 builds modules on two release legs only. (1) **Installers** stay macOS arm64 and Windows x64, as released today (README: Apple Silicon only; Linux is not released, release.yml's header). A macOS x64 installer or a Linux AppImage needs the owner (Q1). (2) TreeMap is not published to npm; web mode is a git clone, so **MP's "npm package" is read as web mode**. Every release attaches the modules of **`scripts/native-targets.json`** (five targets, each `{ triple, platform, arch, runner, tested }`), which release.yml's `native` job and the tests both read. An answer to Q1 edits one file. It also attaches `SHA256SUMS`, `native-manifest.json` and the notices, and `npm run fetch:native` installs the right module. (3) **A module that did not pass its equivalence test on its own target is marked, never passed off as tested**: `tested: false` in `native-targets.json` and in `native-manifest.json`. `fetch:native` refuses it without `--untested`, and a loaded untested module adds "an untested build for this platform" to the native `engineReason` and to the badge's words. (4) **A missing or wrong-architecture module fails the release.** The publish job needs the native job, whose last step re-downloads every attached module and compares its SHA-256 with `SHA256SUMS` (byte for byte, not by size), and `check-prebuilt.js` reads each binary's header. (5) **Old tags stay repairable.** release.yml runs at the tag being rebuilt, and old tags have no `scripts/` (its own "Inline on purpose" comment). So every new step is gated on its script existing at that ref (`if: hashFiles('scripts/check-prebuilt.js') != ''`), and `publish` accepts a skipped native job. | MP §12.5 and §14; MP §12 ("correctness gates are absolute"); R33. What needs the owner is in Q1. |
| P8-15 | **`fetchNative.js` verifies like `fetchGdu.js` and follows redirects more strictly.** It checks a `SHA256SUMS` from the same release. The asset name carries `nativeVersion`, so a module the checked-out app would refuse is refused before download. The tag is `v<package.json version>` unless `--tag=` names another. Requests go only to `https://github.com/<repo>/releases/download/…`. Redirects are followed by hand (`redirect: 'manual'`), at most 5, each `https:` to `github.com` or a host under `.githubusercontent.com`. The check is **against corruption, not against a replaced release**: `SHA256SUMS` comes from the same release as the module, and SECURITY.md says so (R57's reach). It refuses `tested: false` without `--untested`. It runs only when a person types `npm run fetch:native`: never from an install script, never at run time. On failure it writes nothing and exits 1. `fetchGdu.js`'s `redirect: 'follow'` is recorded in RISKS as a follow-up, not changed here. | DESIGN §14 promises it. SECURITY.md's "never downloaded at run time" stays true. R34. |
| P8-16 | **The loader looks only where a build ships the module**, and the packaged app proves it. The `resourcesPath/native` candidates (`native.ts` `nativeCandidates`, `nativeEngine.ts` `mftHelperCandidates`) are deleted: no `extraResources` entry ships them (package.json `build.extraResources` is gdu alone). The proof is `electron/main.js --treemap-smoke-native`, run on the packaged binary by the release job. The real Electron main process loads the module through the real loader, prints the verdict and exits. It deliberately does not use `ELECTRON_RUN_AS_NODE`, so the proof survives the owner ever turning the RunAsNode fuse off. The smoke step is gated for old tags (P8-14 (5)). | "That the packaged app loads from `app.asar.unpacked` is unverified" (phase8-release map §12). A dlopen cannot read inside an archive, so a successful load through the in-asar path proves Electron's redirect. |
| P8-17 | **Third-party notices: Phase 5 builds the generator, Phase 8 extends it.** Phase 5's P5-25 and T6 create `scripts/rust-notices.js` (from `cargo metadata --locked --filter-platform`, per each of MP §3.5's five triples, unioned: one definition, every normal dependency reachable from `tm-node` or `tm-mft-helper`), `native/THIRD-PARTY-NOTICES.md` with each crate's `LICENSE*`/`COPYING*`/`NOTICE*` texts, `native/cargo-lock-kinds.json`, the bundle entry, and the `--check` step in CI. Phase 8 adds: the triples read from `native-targets.json` instead of the script's own list (one list for the release and the notices); the notice attached beside the modules on the release; and a licence allow-list evaluated as SPDX expressions. An `OR` passes when one alternative is allowed, an `AND` needs every part, and `Apache-2.0 WITH LLVM-exception` is one allowed term. No expression passes whose only alternatives are GPL, LGPL or AGPL. | MIT and BSD-2-Clause require the notice with binary distributions. None exists today (rust-deps map §1.7). No new tool. |
| P8-18 | **Every README performance figure lives in one generated block**, rendered from `bench/baselines/` (and `bench/ci/hosted/` for hosted-runner rows) by `npm run bench -- readme` from `bench/readme-block.md`, with the harness's own formatters: `fmtCount` and `fmtBytes` (made exports of `report.ts`) and `formatMs` (already exported from `stats.ts`). `fmtBytes` divides by 1024, so it now prints `KiB`/`MiB`/`GiB`, the units it always measured: 2,499,268,608 B is "2.33 GiB", never "2.3 GB". The test re-renders and compares byte for byte. **Outside the block, the detector is wide:** a number followed by `ms`, `s`, `sec`, `min`, `h`, `B`, `KB`/`MB`/`GB`/`TB` or their `i` forms, `bytes`, `%`, `fps`, `×`/`x`, `/s` or `items/s` fails, unless it is on the reviewed allow-list. Every allow-list entry cites a code `file:line` or a bench file and field, and the test checks the value there. **Headline throughput figures come from warm-cache files only.** A figure from a `mixed` file carries the word "mixed" beside it, and `bench/README.md`'s plain sentence says so in the same commit. **The CHANGELOG too:** MP §13 names release notes, and `scripts/release-notes.js` builds them from the CHANGELOG entry. Every entry newer than 5.0.1 is held to the same detector by a test. Entries up to 5.0.1 were published before the rule and are listed as such. The notes job is not changed, so an old tag can still be repaired. | R39; MP §13 ("UI, README, or release notes"). "Exactly" means the harness's own rendering. |
| P8-19 | **The Definition of Done is a committed, mechanically checked audit.** `docs/engine/DEFINITION-OF-DONE.md` has one row per MP §14 item, with a verdict and evidence (file:line, bench file and field, CI run, commit), checked by `tests/definitionOfDone.test.ts`. A short second table covers the constraints outside §14 that Phase 8 leaves to the owner (MP §3.3, P8-21; MP §3.5, P8-14; MP §8.1's Eco I/O yield, P8-26). **Evidence is checkable.** A CI run is recorded as its URL, head SHA and conclusion. `scripts/verify-dod.js`, run by the owner (`gh run view --json conclusion,headSha`), confirms each before release. An `owner-accepted` row cites the owner's own commit or message (a commit without the agent's `Co-Authored-By: Claude` trailer), and only the owner writes that verdict. It is the precondition for the owner's release; the owner alone publishes. | MP §14; D9. No agent message is the owner's consent. |
| P8-20 | **Hosted runners are labelled with what was recorded, not promoted.** A result from a hosted VM carries its **recorded** cores and memory (`MachineRecord.cores`, `memoryBytes`) and `hostedRunner` (from `RUNNER_ENVIRONMENT` and `ImageOS`: a new optional `MachineRecord` field that also enters the file name). It reads "Tier C by the harness's rule (≤ 4 cores or ≤ 8 GiB; storage and heat are a hosted VM's)" and is never reported as a physical Tier C machine. The harness classes a 4-core 16 GB runner as C by its cores alone, so **DoD item 7 (100M inside the ceiling on Tier C) counts only a run whose recorded memory is ≤ 8 GiB**; otherwise it is "not available". The governor holds and (after Phase 4 S5) `synthetic100m` run in the calibration workflow as extra evidence for DoD items 6 and 7. Their results go to an uploaded folder (`TREEMAP_BENCH_OUT`, `TREEMAP_BENCH_BASELINES`), which the owner downloads and the agent commits under `bench/ci/hosted/`. | R25. `machine.ts` `classifyTier`: ≤ 4 cores **or** ≤ 8 GiB is C. A `--record` on a runner writes to that runner's disk, which is thrown away. |
| P8-21 | **The scan boundary: MP §3.3 ("do not cross filesystem boundaries unless explicitly asked") is not met today by two of three engines, and the default is the owner's.** gdu runs with `--no-cross`. The walker and the native engine descend into any mount below the root except the never-descend list (`src/utils/mountBoundaries.ts`; on Linux only `/proc`, `/sys`, `/dev` and `/run`). P3-3 kept device ids out of descent so the equivalence gate would stay absolute, and left "a device-boundary setting for every engine" to Phase 8 (DESIGN §5). T14 builds one rule for all three. With **Stay on this drive**, a directory that the OS's mount table lists as the mount point of another filesystem is recorded as not entered (counted, with examples, on `/live` and in the Dashboard note) and not descended. The list is computed in Node and handed to both engines through the never-descend mechanism they already share. A mount-table rule, not a device comparison, keeps macOS firmlinks (which are not mounts) inside the drive. With **Include drives mounted inside it**, the rule is today's. T14's first step reads gdu's pinned `--no-cross` rule and records where it differs. The equivalence gate runs both settings on a fixture with a nested mount. Q5 decides the default. Until then the default stays today's, and the audit's §3.3 row reads "not met by default: Q5". | MP §3.3 is a non-negotiable constraint, and Phase 8 is the last phase. A rule the engines apply differently would itself be an unlisted DESIGN §16 difference. |
| P8-22 | **The walker's Turbo mapping stays as Phase 2 left it**: `workerCap()` caps its in-flight folder reads at the governor's `workers`, and `throttleBatch` rests about 10 % at Turbo's 0.9 duty (CURRENT-STATE's "why the built-in walker is ~20 % slower under Turbo", parked as "a design decision, not done"). It is the CI gate's A leg and the fallback's pacing. Changing it would move every committed ratio file and the walker's Tier B baselines at once. Each ratio file records a digest of the mapping (`shimWorkerCap` and `SHIM_DUTY` at Turbo), and `ab-check` answers NOT COMPARABLE when it differs, so a later change forces a recalibration instead of a silent shift. Decided before T19's calibration. | The session notes park it for Phase 8; a reference engine must not move under the gate. |
| P8-23 | **The persistent index build is a long job, and gets a Pause and the budget like a scan.** It runs after every scan (`045` `buildIndexInBackground`, waited on for up to 600 s) with build, progress, result and cancel routes (`indexRoutes.ts`) and no budget (`indexEngine.ts` never reads it). T8 adds `POST /api/index/:jobId/pause` and `/resume` (JSON body, R52), checked between write batches. It runs the build under the budget shim keyed by its job, `index:<jobId>` (the job-key pattern of Phases 5 and 6: `dupes:<scanId>:<minSize>`, `neardup:<scanId>`), begun with `beginScanBudget(key, forced)` and forgotten when the build settles (`throttleBatch(key)`, `workerCap(key)`), at Eco when the scan it follows was held at Eco (P8-9), and pauses it with the scans on system sleep. While it runs, one line beside the index badge the Dashboard already paints says so, with Pause and Resume. | MP §11.4 ("Pause button on every long-running operation"), §8.5 ("every phase must be pausable"; scheduled work in Eco). |
| P8-24 | **The equivalence test runs on every corpus, on three platforms, in a workflow of its own.** MP §12.1 ("for every corpus in `bench/`") and §14 item 4; `tests/nativeEquivalence.test.ts` covers smoke, ci20k and the edge fixture only. T23 adds `equivalence-full.yml` (workflow_dispatch only; the owner runs it before a release). It builds enum200k, enum1m and dupes100k on macOS, Windows and Linux and runs the same digest comparison through the same child, and it records each leg's job time and free disk. A corpus that does not fit a runner is "not available on this runner" with the measured reason, never skipped silently. | The audit cannot pass item 4 on three corpora out of six, and extending it inside the audit row hid the work. |
| P8-25 | **Hashing read-hostile mounts gets no opt-in in Phase 8.** Phase 5's Q6 deferred it to "Phase 8's settings". P5-10 stands: such files are counted and named in `notHashed` and never read. A setting would need its own safety review (a FUSE mount can be a cloud drive), and nobody has asked. Recorded in DESIGN §10. | MP §3.2 ("enumerate them but do not hash by default"). |
| P8-26 | **Eco's "pauses while another app is doing heavy I/O" (MP §8.1) is not built in Phase 8 either, and goes to the owner (Q6).** Phase 5 made hashing the first I/O-bound governed workload and did not build it (its P5-14: tm-governor reads no machine-wide I/O signal). Phase 8 does not build it in this plan: it needs a disk-busy signal per platform with TreeMap's own I/O subtracted (Linux `/proc/diskstats` time-in-I/O against `/proc/self/io`; macOS IOKit `IOBlockStorageDriver` statistics against `proc_pid_rusage`; Windows `IOCTL_DISK_PERFORMANCE` idle time against `GetProcessIoCounters`), a threshold and hysteresis that only a measured competing I/O load could set, and a named I/O competitor beside T11's CPU one — each a design of its own, none of which this plan has measured. So it is recorded, not hidden: DESIGN §8.1 states the departure from MP §8.1 with this reason, RISKS gains a row, and the DoD audit's table of constraints outside §14 carries "MP §8.1, Eco yields to another app's heavy I/O: not met — owner decision (Q6)". Eco's CPU ceiling, background QoS and I/O class (the lowest the platform gives) are unaffected. | MP §8.1 (Eco "pauses while another app is doing heavy I/O"); MP §15 (say a gap out loud, never redefine it); Phase 5 deferred it here, and without this row neither plan owned it. |

---

## Fixed interfaces

### `GET /api/scan/:scanId/live` (new; `src/services/scan/liveStatus.ts`, served from `src/api/engineRoutes.ts`)

```ts
export type FallbackKind =
  | 'native-missing' | 'native-wrong-version' | 'native-load-failed' | 'native-probe-refused'
  | 'native-walk-failed' | 'native-walk-stalled' | 'mft-failed'
  | 'gdu-refused-by-rule' | 'gdu-missing' | 'gdu-failed';
  // T1 Step 0 confirms one kind per call site: diskScanner.ts's six noteFallback calls and its one direct write.
export type PauseBy = 'you' | 'sleep';
export type HeldBy = 'schedule' | 'autopilot' | 'fleet';
export type BudgetApplies = 'now' | 'next-helper' | 'held' | 'finished';

export interface ScanLive {
  scanId: string;
  status: 'running' | 'complete' | 'error' | 'cancelled';   // 'cancelled': the record's status 'error' with scan.cancelled set
  engine: string;                        // as /stats
  fastPath: string;                      // as /stats
  fastPathWords: string;                 // engineWords.fastPathWords(fastPath)
  fellBack: boolean;                     // fallbacks.length > 0
  fallbacks: { kind: FallbackKind; words: string }[];   // one per noteFallback call, in order
  ranInsteadWords: string | null;        // engineWords.ranInsteadWords(engine) when fellBack; null otherwise
  fallbackDetail: string | null;         // the technical fallbackReason, verbatim (escaped by the page)
  untestedBuild: boolean;                // T20: the loaded module's manifest says tested: false
  paused: boolean;
  pausedBy: 'you' | 'sleep' | 'heat' | null;   // the record's pausedBy wins; 'heat' only when none is recorded and the governor snapshot is paused with thermal 'critical'
  pausedWords: string | null;
  pausable: { supported: boolean; reason?: string };   // engineBudget.pauseRefusal(scan, deps), asked without pausing
  budget: {
    atStart: ScanBudget;                 // the record's, as /stats
    now: { preset: BudgetPreset; effective: EffectiveBudgetPreset; source: BudgetSource; cpuPercent: number | null;
           applies: BudgetApplies; appliesWords: string; heldBy: HeldBy | null };   // src/models/types.ts BudgetPreset, EffectiveBudgetPreset, BudgetSource
    changes: { atMs: number; from: EffectiveBudgetPreset; to: EffectiveBudgetPreset }[];
  };
  entriesPerSecond: { value: number | null; windowMs: number | null; reason?: string };
  cpuShare: { value: number | null; source: 'governor' | 'process' | null; scope: 'scanning-process'; reason?: string }; // 0..1 of the machine
  memory: { rssBytes: number | null; scope: 'scanning-process'; reason?: string };
  mountsNotEntered: { count: number; examples: string[] } | null;   // T14; null when the scan was set to cross
}
export const LIVE_WINDOW_MS = 1000;
export const LIVE_RING = 32;
export interface LiveDeps { now?: () => number; snapshot?: () => GovernorSnapshot | null; platformName?: PlatformName;
  cpuUsage?: () => NodeJS.CpuUsage; rss?: () => number; parallelism?: () => number }
export function sampleScan(scan: ScanResult, deps?: LiveDeps): void;
export function liveStatus(scan: ScanResult, deps?: LiveDeps): ScanLive;
```

`src/services/scan/engineWords.ts`: `FALLBACK_KINDS: readonly FallbackKind[]`, `fallbackWords(kind: FallbackKind): string` (what went wrong, plainly), `ranInsteadWords(engine: string): string | null` (the engine that ran and its DESIGN §16 differences; null for the native engine), `fastPathWords(fastPath: string): string`, `pausedWords(by: 'you' | 'sleep' | 'heat'): string`, `appliesWords(a: BudgetApplies, heldBy: HeldBy | null, engine: string): string`, `untestedWords(): string`, `allEngineSentences(): string[]` (every sentence above, for T10's copy test).

`src/services/scan/native.ts`, amended:
```ts
export type NativeFailKind = 'missing' | 'wrong-version' | 'load-failed';
export type NativeOutcome =
  | { available: true; module: NativeModule; version: string; path: string; tested: boolean }   // tested: T20, from PROVENANCE.json beside the module; true when absent (a local build)
  | { available: false; reason: string; kind: NativeFailKind };                                  // the first candidate's kind
```
`nativeEngine.ts`'s `Eligibility` failure gains `kind: FallbackKind`. `diskScanner.ts`: `noteFallback(scan: ScanResult, kind: FallbackKind, reason: string): void` and `resetFallbacks(scan, keep?: { kind; reason }[])`, the only writers of `fallbackReason` and `fallbacks`. `ScanOptions` gains `heldBy?: HeldBy`.

`src/services/engineBudget.ts`, additive (the existing `deps` test seam is kept):
* `pauseScan(scan: ScanResult, deps: PauseDeps & { by?: PauseBy } = {}): PauseOutcome` (`by` defaults to `'you'`; `electron/main.js` `wirePowerEvents` passes `{ by: 'sleep' }`)
* `pauseRefusal(scan: ScanResult, deps: PauseDeps = {}): string | null`: the rules `pauseScan` refuses by today, now shared by both
* `beginScanBudget(scanId, forced?, heldBy?)`: the third argument is recorded for `/live`
* `noteBudgetSample(scanId: string, effective: EffectiveBudgetPreset, atMs: number): void`: called by `sampleScan` and by `PUT /api/engine/budget`. A switch Automatic makes between polls (battery, heat) is recorded at the next poll, late by up to one poll interval.
* `budgetChangesFor(scanId: string): { atMs; from; to }[]`

`ScanResult` (internal, `src/models/types.ts`) gains `fallbacks?: { kind: FallbackKind; reason: string }[]`, `pausedBy?: PauseBy` and `budgetHeldBy?: HeldBy`. No response under the golden lock changes. P8-11's native `engineReason` sentence changes only native scans' `engineReason`, which the golden scrubs (`<REASON>`). The golden scan is pinned to the walker (`goldenHarness.ts:254-263`).

### The same-origin guard (`src/middleware/sameOrigin.ts`, new)

```ts
export type OriginScope = 'all' | 'state-changing';           // Q2; default 'all'
export type OriginVerdict = { ok: true } | { ok: false; reason: string };
export function originVerdict(
  req: { method: string; origin?: string; secFetchSite?: string; host?: string; protocol: 'http' | 'https' },
  allowed: readonly string[], scope: OriginScope,
): OriginVerdict;
export function sameOriginGuard(opts?: { allowed?: readonly string[]; scope?: OriginScope }): RequestHandler; // 403 { error, code: 'CROSS_ORIGIN' }
```
`src/middleware/cors.ts` exports its parser of `TREEMAP_ALLOWED_ORIGINS` so both read one list. `fleetSync.ts` `handlePeerRequest` calls `originVerdict` first.

`vscode-extension/src/lib/serverEnv.ts` (new): `export function serverEnv(base: NodeJS.ProcessEnv, o: { port: number; host: string; allowedOrigins: readonly string[] }): NodeJS.ProcessEnv` (strips `TREEMAP_*`, then sets `PORT`, `HOST` and `TREEMAP_ALLOWED_ORIGINS`). `vscode-extension/src/server.ts` `StartOptions` gains `originFor?: (port: number) => Promise<string | null>`, which `extension.ts` fills with `asExternalUri`.

### Rust

```rust
// tm-governor/src/preset.rs (T13)
/// The most workers `preset` may run on `cores` cores: one worker of headroom above the
/// ceiling wherever the machine has a core to spare (R52a), never below Phase 2's caps.
pub fn max_workers(preset: Preset, cores: u32) -> u32;   // profile() uses it, and through profile() Phase 5's capped_duty and worker_limit_capped
```
Adopted from Phase 5 unchanged (P8-9): `lower_of`, `capped_duty`, `Governor::throttle_capped`, `Governor::worker_limit_capped`, `tm_walk::CappedPacer`, `ScanStartOptions.budgetCap`. Phase 8 adds no walk option and no napi export. Also adopted, and verified by T7 rather than built: Phase 5's `HashFile::still_local(&mut self) -> Result<(), Skip>` (its T7b: macOS `fstat` `st_flags & SF_DATALESS`; Windows `FileAttributeTagInfo` recall attributes; Linux `Ok`), which its digest job calls before every chunk after the first (its T9).

### bench (`bench/lib/ab.ts`, new; `bench/lib/readme.ts`, new; `bench/lib/uiFramesSuite.ts`, new)

```ts
export type AbLeg = 'a' | 'b' | 'ref';
export interface RatioStat { paired: number[]; median: number; resolutionPct: number }   // resolution: stats.resolutionBand(paired)
export type GatedRatio = 'wall' | 'cpu' | 'rss' | 'walkerWall';
export interface AbResult {
  kind: 'ab'; suite: 'enumerate' | 'duplicates';
  engines: { a: string; b: string; ref: string | null };  // enumerate: turbo-walker, native, gdu-bare; duplicates: sha256-oracle, blake3-staged, null
  a: BenchResult; b: BenchResult; ref: BenchResult | null; // same conditions but the engine (Phase 5's comparability)
  order: AbLeg[];                        // one warm-up each, then rounds whose order rotates
  ratios: { wall: RatioStat; cpu: RatioStat; rss: RatioStat; walkerWall: RatioStat | null };  // b/a, b/a, b/a, a/ref
  planted: { pct: number; target: 'native' | 'treemap' } | null;
  walkerMapping: string;                 // P8-22's digest
  correctness: { ok: boolean; notes: string[] };
  recordedAt: string; commit: string; label: string;
}
export interface GateRun { results: AbResult[]; verdict: Verdict; sentences: string[] }   // the whole policy: first run, retries, confirmation
export interface RatioFile {
  kind: 'ci-ab-ratio'; suite: 'enumerate' | 'duplicates'; corpus: { name: string; params: unknown };
  engines: { a: string; b: string; ref: string | null }; preset: ScanPreset; runsPerEngine: number; retryRuns: number;
  platform: string; arch: string; runnerLabel: string; machines: MachineRecord[]; walkerMapping: string;
  fit: { runId: string; gateRuns: number;
         perRatio: Record<GatedRatio, { ratios: number[]; median: number; maxDeviationPct: number; bandPct: number; thresholdPct: number } | null> };
  validate: { runId: string; cleanGateRuns: number; falseAlarms: number; falseAlarmBound95: number /* 3/N when 0 */; inconclusive: number;
              planted: { pct: number; target: 'native' | 'treemap'; gateRuns: number; failed: number; inconclusive: number }[] };
  marginPct: number; measuredFloorPct: number;   // the smallest planted level every run of which failed
  recordedAt: string; commit: string;
}
export interface AbDeps { runChild?: RunChild; now?: () => number }       // runChild is suites.ts's, exported as the seam
export async function runAb(opts: { suite: 'enumerate' | 'duplicates'; corpusName: CorpusName; a: EngineChoice; b: EngineChoice;
  ref: EngineChoice | null; preset: ScanPreset; runs: number; plant?: { pct: number; target: 'native' | 'treemap' }; label: string },
  deps?: AbDeps): Promise<AbResult>;
export function abVerdict(r: AbResult, file: RatioFile | null): { verdict: Verdict; sentences: string[] };   // compare's four verdicts and exit codes
export async function gatePolicy(run: (runs: number) => Promise<AbResult>, file: RatioFile | null): Promise<GateRun>;
export function calibrate(fit: GateRun[], validate: GateRun[], o: { runnerLabel: string; fitRunId: string; validateRunId: string; marginPct: number }): RatioFile | { refused: string };
// bench/lib/readme.ts
export function renderReadmeBlock(template: string, dirs: { baselines: string; hosted: string }): string;  // {{<file>#<json.path>|<format>}}
export function readmeBlockOf(readme: string): string;   // between <!-- bench:begin … --> and <!-- bench:end -->
export function perfFiguresOutside(text: string, allow: readonly AllowEntry[]): { figure: string; line: number }[];  // the wide detector, shared with the CHANGELOG test
// bench/lib/uiFramesSuite.ts — its own result kind, not a BenchResult (no entry count, no wall-clock median)
export interface UiFramesResult { kind: 'uiframes'; engine: 'native' | 'walker'; preset: ScanPreset; corpus: string;
  displayHz: number; runs: { frames: number; missed60: number; over32: number; longestMs: number; p99Ms: number; completed: boolean }[];
  verdict: 'PASS' | 'FAIL'; reproducible: boolean /* every run gave the same verdict */; machine: MachineRecord; recordedAt: string; commit: string }
```
`report.ts`: export `fmtCount` and `fmtBytes` (IEC units). `BenchResult` gains `planted?: { pct; target }`, and `recordRefusal` refuses any planted result. `MachineRecord` gains `hostedRunner?: string`, which `baselineFileName` adds to the name. Where a verdict compares two results, `ab` uses **Phase 5's T17a comparability** — `comparabilityDifferences(a, b, { except: 'engine' })`, exported by that task for its two-result `ratio` command ("same conditions but one") — and its combined band, never a second one. CLI:
```
npm run bench -- ab [--suite=enumerate|duplicates] [--corpus=ci20k] [--a=walker] [--b=native] [--ref=gdu-bare|none] [--preset=turbo] [--runs=5] [--plant=0|11|15|25] [--plant-target=native|treemap] [--label=…]
npm run bench -- ab-check <ab.json> [<ratio.json>]          exit 0 PASS · 1 FAIL · 2 INCONCLUSIVE · 3 NOT COMPARABLE
npm run bench -- ab-calibrate --runner=<label> --fit-run=<id> --validate-run=<id> --out=<file> <gate-run-*.json>…
npm run bench -- readme [--check|--write]
npm run bench -- uiframes [--corpus=enum200k] [--engine=native|walker] [--preset=turbo] [--runs=3] [--record]
```
The seam is `TREEMAP_BENCH_PLANT_SLOWDOWN_PCT` with `TREEMAP_BENCH_PLANT_TARGET` (`native` | `treemap`), read only by `bench/lib/measureWorker.ts`. It spins on the measured thread for `pct × the run's measured wall` inside the timed window, on its target's legs only (never `gdu-bare`), and marks the run. The product never reads it, and a test says so.

### Scripts, workflows and the Electron smoke flag

* `scripts/native-targets.json`: `[{ "triple", "platform", "arch", "runner", "tested" }]` for the five targets; read by release.yml, `build-native.js`, `rust-notices.js`, `fetchNative.js` and the tests.
* `scripts/build-native.js`: `--target=<rust triple>` writes to `native/prebuilt/<platform>-<arch>/`. Every cargo call carries `--locked`: Phase 5's T6, verified in T18.
* `scripts/check-prebuilt.js` exports `machineOf(bytes: Uint8Array): { format: 'mach-o' | 'pe' | 'elf' | 'unknown'; arch: 'arm64' | 'x64' | 'unknown' }`. It reads the first 4 KiB: for PE it follows `e_lfanew` at 0x3C to the COFF machine field at `e_lfanew + 4`, and a header whose `e_lfanew + 6` lies past the buffer is `unknown`. It also exports `checkPrebuilt(root, platform, arch, nativeVersion): { ok: true } | { ok: false; reason: string }`.
* `scripts/fetchNative.js` exports `assetName(nativeVersion, platform, arch)` → `treemap_core-native<ver>-<platform>-<arch>.node`, `sumsName(nativeVersion)` → `treemap_core-native<ver>-SHA256SUMS.txt`, `manifestName(nativeVersion)`, `parseSums(text)`, `verify(buf, sums, name)`, `defaultTag(pkg)` → `v<version>`, `allowedRedirectHost(host)`, `releaseUrl(tag, name)` and `main(argv, deps)`. The npm script is `"fetch:native": "node scripts/fetchNative.js"`.
* `scripts/smoke-packaged.js <releaseDir>` runs the packaged binary with `--treemap-smoke-native`. It exits 1 unless the verdict is available, the loaded path is the app's own in-asar path, and the file exists under `app.asar.unpacked` (plus `tm-mft-helper.exe` on Windows, plus `codesign --verify --strict` on the unpacked module on macOS).
* `scripts/rust-notices.js [--check]`: Phase 5's, extended (P8-17).
* `scripts/busy-load.js --cores=<n> --seconds=<s>` (T11).
* `scripts/verify-dod.js` (T26; run by the owner).
* `electron/main.js --treemap-smoke-native`: before any window, server or tray, it requires `dist/services/scan/native.js`, prints `{ available, path, version, tested, reason }` as one JSON line and exits 0 or 1.
* Workflows:
  * `test.yml` gains a job `perf`: macOS, Windows and Linux (not pt-BR); builds with `--locked`; `npm run fetch:gdu:dev`; `node bench/ci/gate.cjs`; no plant variable; `continue-on-error: true` until its ratio files exist (P8-12). The Linux leg of the `test` job mounts a tmpfs under the runner's temp folder before the suite, for T14's nested-mount case (`TREEMAP_TEST_NESTED_MOUNT`).
  * `.github/workflows/perf-calibrate.yml` is new and workflow_dispatch only (`mode=fit|validate`).
  * `.github/workflows/equivalence-full.yml` is new and workflow_dispatch only (T23).
  * `release.yml` gains a job `native` after `build`, covering every target in `native-targets.json`. Test legs run `npm run fetch:gdu:dev`. darwin-x64 is tested in its own job with `setup-node` `architecture: x64` before `npm ci`. Cross targets are added to the pinned toolchain with `rustup target add --toolchain <pin> <triple>`. The job writes `SHA256SUMS`, `native-manifest.json` and the notices, and a SHA-256 asset check re-downloads every module. `publish` needs `[notes, build, native]` and accepts a skipped native job. Both installer legs run `smoke-packaged.js`. Every new step is gated on its script existing at the ref.

### UI parts

* `src/ui/app/046-scan-live.js` (new, listed after `045` in `manifest.json`) holds `budgetControl(host, { compact })`, `startLiveReadout(scanId)`, `stopLiveReadout()`, `paintLive(live)`, `setPauseButton(mode)` and `togglePause()`. `beginScanChrome` (in `040-scanning-sse.js`) calls `startLiveReadout` and `setPauseButton('waiting')`. `endScanChrome` (in `045-persistent-live-index.js`) calls `stopLiveReadout` and `setPauseButton('hidden')`. Its rules go in `styles/030-dashboard.css`.
* New markup ids in `010-view-dashboard.html`'s scan card, all outside `#scanStatus`: `#scanPauseBtn`, `#scanBudget` (radiogroup), `#scanBudgetLine`, `#scanLive`, `#scanLiveRate`, `#scanLiveCpu`, `#scanLiveMem`, `#scanLiveCold`, `#scanPausedNote`. Beside the index badge: `#indexLine`, `#indexPauseBtn` (T8). On the Dashboard: `#mountsNote` (T14).
* `#engineRow` gains `#engineFastPath`, `#engineFallback` (one line per fallback), `#engineBudgetChanges` and `<details id="engineWhy"><summary>Why this engine</summary><p id="engineWhyText"></p></details>`.
* `235-settings-modal.js`'s budget rows are rendered by `budgetControl`, with `#budgetCpuPercent` (the advanced ceiling) in the Settings view only. The scan boundary row is `#scanBoundary` (T14).
* `165-command-palette.js` gains a "Scanning budget" entry that opens the same control.

---

## Tasks

### T1: `GET /api/scan/:scanId/live`, the engine's words, who paused, the budget now (TypeScript)
**Files:**
* Create `src/services/scan/liveStatus.ts`, `src/services/scan/engineWords.ts`, `tests/scanLive.test.ts`, `tests/engineWords.test.ts` and `tests/powerEvents.test.ts` (a structural slice of `electron/main.js` `wirePowerEvents`).
* Modify `src/services/diskScanner.ts` (`noteFallback(scan, kind, reason)` and `resetFallbacks`; the direct `scan.fallbackReason = mftFallback` write in the native branch becomes a reset; `ScanOptions.heldBy`), `src/services/scan/native.ts` (`NativeOutcome.kind`), `src/services/scan/nativeEngine.ts` (`Eligibility.kind`; the stall error is a typed error, so its kind is `native-walk-stalled`), `src/services/scheduler.ts` (`heldBy: 'schedule'` beside `budget: 'eco'`), `src/services/engineBudget.ts`, `src/models/types.ts`, `src/api/engineRoutes.ts` (the route; the budget PUT calls `noteBudgetSample`), `electron/main.js` (`wirePowerEvents` passes `{ by: 'sleep' }`), `src/middleware/rateLimiter.ts` (the meta pattern), `src/api/openapi.ts` (`ScanLive` and the path) and `AGENTS.md` (one line).

- [ ] Step 0: list every writer with `rg -n "noteFallback\(|fallbackReason\s*[:=]" src` (six `noteFallback` calls and one direct write at 25 Sep 2026), give each a `FallbackKind`, and put the list in this row's Evidence.
- [ ] Tests first, `tests/engineWords.test.ts`:
  - `every fallback kind has a plain sentence with no path, errno, function or crate name` (checks for `/`, `\`, `E[A-Z]{3,}`, `()`, `napi`, `.node`).
  - `the engine that ran instead is named with the DESIGN §16 differences that apply to it, and no sentence claims sameness or speed` (`ranInsteadWords`: the walker's and gdu's both mention cloud-only files, and gdu's also mentions folders it may not open; no sentence from `fallbackWords` or `ranInsteadWords` holds "same", "identical", "exactly", "faster", "slower" or "speed").
  - `every call to noteFallback passes a kind, and nothing else writes fallbackReason or fallbacks` (a source scan of `src/`).
  - `every fastPath value has words`.
  - `the loader says which failure it met without a sentence being parsed` (`tryLoad` over a missing file, a require that throws, a version mismatch and a module without the scan functions).
- [ ] Tests first, `tests/scanLive.test.ts` (`isolatedDataDir`, a fake clock, a fake governor snapshot through `LiveDeps`):
  - `entries per second is null until a second of samples exists, then the count delta over the newest window of at least a second`.
  - `cpu share comes from the governor only after a full second of ticks, from the process sampler otherwise, and says which` (ticks 0 and 9 → process; 10 → governor).
  - `cpu share and memory are the scanning process's, labelled so`.
  - `a scan whose work runs in a helper reports CPU and memory as null with the reason` (`gdu-turbo` and `ntfs-mft` records).
  - `each fallback path records its own kind, and two fallbacks record two, in order`. It forces each path through the seams the engine tests already use: `setNativeLoadOverrideForTests` with a path that is not there, a forced gdu refused by an ignore list, a forced gdu with no binary, a stand-in gdu that exits 1, and a fake module whose walk throws. The pair case is native missing, then gdu failed.
  - `a paused scan says who paused it: you, sleep, or heat, and a recorded pause wins over heat`.
  - `pausable asks the refusal rules without pausing` (`pauseRefusal(scan, { platformName: 'windows' })` on gdu; cloud; ntfs-mft; finished).
  - `a budget changed mid-scan shows the start preset, the preset now, the change, and whether it applies to this scan` (walker → `now`; gdu → `next-helper`; a scan begun with `heldBy: 'schedule'` → `held`; finished → `finished`).
  - `a switch Automatic makes between polls is recorded at the next poll` (the fake snapshot's `effective` flips between two `sampleScan` calls).
  - `a cancelled scan answers status cancelled`.
  - `a finished scan answers with its final rate and null live CPU and memory, each with a reason`.
  - `an unknown scan is 404 SCAN_NOT_FOUND`.
  - `the route is in the meta lane` (`rateLimitLanes.laneName('GET', '/scan/x/live') === 'meta'`, and 25 back-to-back polls are all answered).
  - `/stats and the SSE frames are unchanged`: `tests/goldenResponses.test.ts` runs unmodified.
- [ ] Tests first, `tests/powerEvents.test.ts`: `system sleep pauses each running scan as 'sleep'`.
- [ ] Implement. `untestedBuild` answers false and `mountsNotEntered` null until T20 and T14 fill them. Run only `npx tsx --test tests/scanLive.test.ts tests/engineWords.test.ts tests/powerEvents.test.ts tests/engineBudget.test.ts tests/engineRoutes.test.ts tests/discoverability.test.ts tests/goldenResponses.test.ts`.
- [ ] Mutants:
  - the rate taken over the whole scan since start;
  - a window under 1 s;
  - `source` always `'governor'`;
  - the ticks rule dropped (the governor answers at 0 ticks);
  - `null` → `0`;
  - a helper scan answered with the process figure;
  - `pausedBy` always `'you'`;
  - heat winning over a recorded pause;
  - `budget.now` = `atStart`;
  - `applies` always `'now'`;
  - one call site's kind swapped for another;
  - `wirePowerEvents` passing no `by`;
  - `'cancelled'` answered as `'error'`;
  - the route moved to the `api` lane.
- [ ] Commit `feat(engine): GET /api/scan/:id/live — rate, CPU share and memory of the scanning process, who paused, the budget now and whether it applies, each fallback in plain words`.

### T2: The engine badge (UI)
**Depends on:** T1, and the stats-recovery fix of 25 Sep 2026 (`scanStatsFor` no longer drops `engineReason`, `fallbackReason` and `budget`; see the cloud-session handoff).
**Files:**
* Modify `src/ui/markup/010-view-dashboard.html` (`#engineRow`) and `src/ui/app/045-persistent-live-index.js` (`renderDiskNotes` reads `/live` once after completion; `engineBudgetNote` paints the changes).
* Create `tests/engineBadgeUi.test.ts`; update `tests/engineSettingUi.test.ts` (the hover pin).
* Rebuild `public/index.html`.

- [ ] Tests first (lifted functions plus a fake DOM):
  - `a scan that fell back says so in visible text: one server sentence per fallback, then the engine that ran instead in the server's words`.
  - `the fast path is named in words beside the engine`.
  - `the technical reason is one keyboard stop away (details/summary), not a title on a <b>`.
  - `the fallback detail is escaped (it can carry a path)`.
  - `a recovered scan paints the same badge as a streamed one`.
  - `a scan past its 30 minutes (/live answers 404) paints from /stats: the engine and the technical reason, and no plain sentence it cannot know`.
  - `a budget changed during the scan is painted as it happened ("budget: Turbo, then Eco from 0:12")`.
  - `a forced native load failure paints "fell back" with the native-missing sentence`. The server half comes from a real walker scan in a child with `TREEMAP_NATIVE_MODULE=/nonexistent/treemap_core.node` **and `TREEMAP_NO_GDU=1`**, case (d)'s forcing in `nativeEquivalence.test.ts` (`tests/fixtures/equivalenceChild.ts`). Without the second variable, CI's fetched gdu would answer. This is DoD item 10's "honest badge".
- [ ] Implement; `npm run build:ui`; `node scripts/build-ui.js --check`.
- [ ] Mutants: sentence only in `title`; `fastPath` omitted; `textContent` → `innerHTML` for the detail; the recovered path skips `/live`; the 404 path paints nothing; the changes not painted.
- [ ] Commit `feat(ui): the engine badge names the fast path, says in plain words when and why a scan fell back, and shows the budget as it changed`.

### T3: The scan card — Pause, the compact budget control, the advanced ceiling, the live readout (UI)
**Depends on:** T1.
**Files:**
* Modify `src/ui/markup/010-view-dashboard.html` (scan card), `src/ui/app/040-scanning-sse.js` (`beginScanChrome` calls `startLiveReadout` and `setPauseButton('waiting')`), `src/ui/app/045-persistent-live-index.js` (`endScanChrome` stops and clears), `src/ui/app/235-settings-modal.js` (rows through `budgetControl`, with the advanced ceiling), `src/ui/markup/110-modal-settings.html`, `src/ui/app/165-command-palette.js` (the ⌘K entry) and `src/ui/styles/030-dashboard.css`.
* Create `src/ui/app/046-scan-live.js` (+ `manifest.json`); `togglePause` lives there, beside `setPauseButton`.
* Tests: create `tests/scanPauseUi.test.ts`, `tests/scanBudgetControlUi.test.ts` and `tests/scanLiveUi.test.ts`; extend `tests/frontendContract.test.ts` and `tests/engineBudgetUi.test.ts`.

- [ ] Tests first:
  - `pause: a separate control, never a second #scanBtn, outside #scanStatus`.
  - `pause: endScanChrome hides it and resets aria-pressed`.
  - `pause: disabled until the scan request has answered with a scanId`.
  - `pause: a refusal (paused:false, supported:false) shows the server's reason and disables the button`.
  - `pause: Resume sends /resume, restores the label, and aria-pressed follows`.
  - `budget control: Settings and the scan card are one implementation, and a change in one repaints the other from the PUT's response`.
  - `budget control: a change during a scan shows "now: Eco (was Turbo)" from /live, never from the click`.
  - `budget control: on a gdu scan the change is said to apply from the next helper, and on a held or finished scan it is said not to apply to this scan`.
  - `budget control: the Settings view's advanced CPU ceiling saves cpuPercent with the preset and shows a 400 BAD_SETTING in the server's words; the compact view shows an override in force and does not edit it`.
  - `budget control: one plain line per preset, the four sentences Settings pins`.
  - `readout: rate, CPU share and memory each show the server's value, or "measuring…" / "not measured here" with its reason — never 0 for null`.
  - `readout: says "TreeMap's scanning process" and never "this scan's", and a helper scan shows why its CPU and memory are not counted`.
  - `readout: polls /live at most once a second and stops in endScanChrome` (fake timers, counted).
  - `readout: a pause by sleep or heat is shown with its reason`.
  - `the ⌘K palette's budget entry opens the same control` (discoverability, MP §6).
- [ ] Implement; `npm run build:ui`; `--check` clean.
- [ ] Mutants: Pause inside `#scanStatus`; the reset line removed from `endScanChrome`; enabled at begin; optimistic paint; poll at 250 ms; the interval never cleared; null painted as `0`; `cpuPercent` dropped from the PUT; a held scan painted as changed.
- [ ] Commit `feat(ui): the scan card — Pause, the budget in reach while a scan runs, the advanced CPU ceiling, and the scanning process's rate, CPU share and memory`.

### T4: Duplicates — Phase 5's Pause, Resume and Cancel verified; each copy's shared storage in words (UI; Phase 5's surfaces)
**Depends on (blocked until committed):** Phase 5 T13 and T16 (`docs/superpowers/plans/2026-09-25-phase5-duplicates.md`). It consumes, by Phase 5's names:
* `POST /api/duplicates/pause|resume|cancel` with body `{ scanId, minSize? }` → `{ scanId, minSize, status, paused }`, and `404 DUPLICATES_NOT_RUNNING`;
* the 202's `stage`, `bytesRead` and `paused`;
* per group: `hashAlgo`, `stagesUsed`, `bytesRead`, `verifiedByteCompare`, `sharesStorage { hardlinks[], clones[], maybeShared[] }` and `reclaimableIsUpperBound`;
* at the top level: `engine`, `engineReason`, `reclaimableCaveat`, `available`, `reason`, `notHashed.reasons[]` and `notHashed.largest[].reason`;
* `code: 'LAST_COPY'` in `failed[]` and `refused[]`, and `409 CLOUD_SCAN_UNSUPPORTED`.
**The job's controls are Phase 5's** (its T16 builds Pause, Resume and Cancel on the Duplicates progress row, with their tests); this task verifies them and adds only the per-copy wording, Auto-select's storage rule and the cross-job unmount rule.
**Files:** `src/ui/markup/055-view-duplicates.html`, `src/ui/app/200-duplicates-view.js`, `src/ui/app/205-duplicate-viewer.js`, `tests/duplicatesJobUi.test.ts`, `public/index.html` (built).

- [ ] Step 0: read Phase 5's Progress table. Phase 5 T16 pins these tests: `pause, resume and cancel sit on the job's progress row: Pause while it runs, Resume while it is paused, Cancel in both`, `pause and cancel call the JSON-body routes and stop polling`, `resume calls its route and polling restarts`, `a paused job keeps its stage, files and bytes on screen and says it is paused`, `linked and cloned copies are shown and never counted as freed space`, `a LAST_COPY refusal from the server is shown with its reason`, `each not-hashed reason is one plain line` and `an answer that could not check some files says so, and one that checked none never reads as "no duplicates"`. Cite each in Evidence and do not write it again. One that is missing on the tree is built to Phase 5's name, in Phase 5's test file, not here under another.
- [ ] Tests first (only what Phase 5 lacks):
  - `duplicates: each member's storage line follows its evidence`. A hard-link name reads "another name of the same file: trashing it frees nothing while the other stays". A clone family reads "shares every block with …: one copy's worth of space". A `maybeShared` member reads "may share some blocks; the space shown is at most this". No group is ever labelled "deleting frees nothing" as a whole.
  - `duplicates: a group of two names of one file and one real copy counts one copy reclaimable, and Auto-select never selects every name of the one real copy` (the totals are the server's `reclaimable`; Auto-select skips hard-link names and every clone-family member after the first).
  - `duplicates: a member edited during a pause is not a survivor — the server's LAST_COPY refusal is shown` (Phase 5's P5-1 guard re-states each survivor's identity against the live disk; a stand-in server answers the refusal).
  - `every job's poll and pause control stop when its view unmounts` (the existing `frontendContract.test.ts` unmount rule, extended).
- [ ] Implement; `build:ui --check` clean.
- [ ] Mutants: a group-level "frees nothing" label; Auto-select selecting a hard-link name; the pause poll not stopped on unmount.
- [ ] Commit `feat(ui): Duplicates — each copy's shared storage said as its evidence says it, and every job's controls stop with its view`.

### T5: Similar photos — Pause, Resume and Cancel on the job (UI; Phase 6's surfaces)
**Depends on (blocked until committed):** Phase 6 T12, T13 and T14 (`docs/superpowers/plans/2026-09-25-phase6-near-duplicates.md`). It consumes, by Phase 6's names:
* `POST /api/near-duplicates/pause|resume|cancel` with body `{ scanId }` → `200 { scanId, status, paused }`, `400 SCAN_ID_REQUIRED` for a missing or non-JSON body, and `404 NEAR_DUPLICATES_NOT_RUNNING`;
* the 202's `phase` and `paused`;
* `tier` and `tierReason`;
* per file: `decodePath`, `confidence` and `compositeDistance`;
* per cluster: `clusterRepresentative`;
* `notDecoded { files, bytes, largest[{ path, size, reason }], reasons[{ reason, sentence, files, bytes }] }` (Phase 5's `notHashed` shape) and `skipped`;
* `ndNoteLines` (Phase 6 T13) and `ndAutoSelection` (Phase 6 T14).
Phase 6 builds the routes and the notice but no Pause control in the view, and its plan says this task owns that control (its "Deferred, with their owners" line).
**Files:** `src/ui/markup/055-view-duplicates.html`, `src/ui/app/200-duplicates-view.js`, `tests/nearDupesJobUi.test.ts`, `public/index.html` (built).

- [ ] Step 0: cite Phase 6's tests that exist: `ndNoteLines states the count per reason in plain words … and shows with zero clusters` (Phase 6 T13), and the auto-select test that keeps `clusterRepresentative.path` (Phase 6 T14). Write here only what is missing.
- [ ] Tests first:
  - `near-duplicates: Pause, Resume and Cancel on the job's progress row call its routes with a JSON body, and a paused job keeps its counts`.
  - `near-duplicates: the tier and each image's decode path are shown in words` (only if Phase 6 T13/T14 do not already).
  - `near-duplicates: skipped cloud placeholders and images that cannot be decoded here are counted and named, never silently missing` (only if Phase 6 T13 does not already).
  - `near-duplicates: Auto-select keeps the cluster representative` (only if Phase 6 T14 does not already).
  - `every job's poll and pause control stop when its view unmounts`.
- [ ] Implement; `build:ui --check` clean.
- [ ] Mutants: a pause call without a JSON body; the pause poll not stopped on unmount; placeholders dropped from the notice (if written here); Auto-select keeping `files[0]` (if written here).
- [ ] Commit `feat(ui): Similar photos — Pause, Resume and Cancel on the job, and how each photo was read`.

### T6: The deep check — Phase 7's controls verified; the model download stays Cancel-only (UI; Phase 7's surfaces)
**Depends on (blocked until committed):** Phase 7 T5, T8b and T9 (`docs/superpowers/plans/2026-09-25-phase7-deep-tier.md`). Phase 7's T9 builds the Settings opt-in, the consent screen, the download bar (`watchJob` with `cancelUrl`), the deep status line, the `notEmbedded` line, the suggestions shown unselected, and Pause/Resume/Cancel for the deep pass, which call Phase 7 T8b's routes: `POST /api/near-duplicates/deep/pause|resume|cancel` (and `/deep/start` for Run again) with body `{ scanId }` → `200 { scanId, status, paused }`, `400 SCAN_ID_REQUIRED` for a missing or non-JSON body, `404 DEEP_PASS_NOT_RUNNING` (pause, resume, cancel) and `409 DEEP_PASS_NOT_ELIGIBLE` (start).
**Files (only if something is missing):** `src/ui/app/200-duplicates-view.js`, `src/ui/app/236-deep-tier.js`, `tests/deepTierUi.test.ts` (Phase 7's; extended).

- [ ] Step 0: cite Phase 7 T9's tests: `the Duplicates view shows nothing of the deep tier while it is off`, `the download uses the shared job progress, with a working cancel`, `the model download has Cancel and no Pause` and `the deep pass has Pause, Resume and Cancel`.
- [ ] Tests first (only what is missing; a Phase 7 test missing on the tree is written under Phase 7's name in `tests/deepTierUi.test.ts`, never a second one here):
  - `the model download has Cancel and no Pause` (Phase 7 T9's name; P8-4; Phase 7's P7-3).
  - `the deep pass has Pause, Resume and Cancel` (Phase 7 T9's name).
  - `every job's poll and pause control stop when its view unmounts`.
- [ ] Mutants: a Pause control added to the download bar; the deep poll not stopped on unmount.
- [ ] Commit (only if something was added) `test(ui): the deep check — Pause on the pass, Cancel only on the download`.

### T7: A resumed job never reads a file whose data left during the pause (verification; builds only what a sibling plan lacks)
**Depends on:** Phase 5 T2b, T7b and T9 (the legacy finder's re-ask after resume; `HashFile::still_local`; the digest job's re-check before every chunk after the first), Phase 6 T7a and T9a (the image job's fresh probe right before each open; `readImageVerified`'s per-file ask after any wait), and Phase 7 T6–T8a (the deep pass: T6's child, T7's embedding cache, and T8a's pass, whose parent reads every image through `readImageVerified`).
**Where each re-check is built.** Each phase builds the re-check for the jobs it builds, in the task that builds the job, with its own test (P8-4); this task verifies them and builds nothing in `tm-hash` or in Phase 5's or Phase 6's modules. What the verification expects follows each job's design: **zero reads** of the evicted file after resume everywhere; **zero opens** wherever the check is made without a descriptor (Node's `stillLocal` in the legacy finder and in `readImageVerified`; Phase 6's metadata-only fresh probe); Phase 5's native digest job may open a file the probe saw local and then close it unread on its descriptor as `leftDisk` (its P5-7 and P5-8 — the open is recorded in its open log, never followed by a read).
**Files (only for a job whose own plan lacks the re-check, built to that plan's names in that plan's files):** `tests/resumeLocality.test.ts` (the cross-job check below); for the deep pass, if Phase 7 lacks it, Phase 7's `tests/deepTierPass.test.ts` (its T8a).

- [ ] Step 0: cite, in Evidence, each job's own test and confirm it is green on the tree:
  - Phase 5, legacy finder: `a file evicted during a pause is never opened after resume, and is counted as having left the disk` (its T2b);
  - Phase 5, native digest job: `a_read_paused_mid_file_is_rechecked_on_its_descriptor_before_the_next_chunk`, `still_local_is_asked_before_every_chunk_after_the_first` and `a_file_evicted_during_a_pause_is_closed_unread_after_resume` (its T9), and `still_local_reads_the_descriptor_again` (its T7b);
  - Phase 6, image job: `a_file_evicted_during_a_pause_is_not_opened` and `a_file_evicted_during_a_throttle_is_not_opened` (its T7a);
  - Phase 6, Node reader (the legacy tier, the warm, the thumbnail route, the viewer): `nearDupeVerifiedRead`'s case in which `stillLocal` answers 1 at the first ask and 0 after a scripted `throttleBatch` wait (its T9a);
  - Phase 7, the deep pass: `a file evicted during a pause is never read after resume, and is counted as having left the disk` and `a file evicted during a rest is never read` (its T8a).

  A job with no such test is recorded "missing" with the plan that owns it, and its test is written to that plan's names in that plan's file — never a second mechanism here.
- [ ] Tests first (`tests/resumeLocality.test.ts`, the cross-job view no single phase has):
  - `a file evicted during a pause is never read after resume, and is counted as having left the disk`, for the exact finders (legacy, native), the near-duplicate passes (fast, legacy) and the deep pass. A `dataIsLocal` stand-in (and, for the native jobs, the scripted prober or opener their own tests use) answers local before the pause and gone after. Opens are observed through each job's own log: `observeHashOpensForTests` (Phase 5's seam, fed the native `opened` log from its T12), `observeImageOpensForTests` and `imgSigTakeOpens`. The deep pass has no log of its own: its child opens no file, and the parent reads every image through Phase 6's `readImageVerified`, so its opens are heard by Phase 6's one open observer, `observeImageOpensForTests` (Phase 7 P7-15, T8a). Expected per job as stated above; `notHashed` / `notDecoded` / `notEmbedded` counts it as left the disk.
  - `every stage boundary asks about exactly the files it is about to open` (the stand-in's calls name those paths and no others; counted).
- [ ] Implement only what Step 0 found missing, per P8-4; `cargo test -p tm-hash --locked` and clippy on three targets only if a sibling plan's Rust was missing and had to be built to its names.
- [ ] Mutants (each on the tree Step 0 verified; a job's own mutants stay its phase's): the legacy finder's re-ask after resume removed; the digest job's `still_local` call removed; Phase 6's fresh probe moved before the checkpoint's wait; the evicted file counted nowhere.
- [ ] Commit `test(dupes): a resumed job never reads a file that left the disk during a pause — verified across every job, counted, never downloaded` (and, only if something was built, name the plan whose gap it filled).

### T8: The persistent index build — pausable, and inside the budget (TypeScript + UI)
**Files:**
* Modify `src/services/indexEngine.ts` (a pause gate between write batches; `throttleBatch`/`workerCap` keyed `index:<jobId>`, begun with the held scan's Eco and forgotten when the build settles; Eco when the scan it follows was held), `src/api/indexRoutes.ts` (`POST /api/index/:jobId/pause|resume`, JSON body), `src/api/openapi.ts`, `electron/main.js` (`wirePowerEvents` pauses and resumes index jobs), `src/ui/app/045-persistent-live-index.js` (`buildIndexInBackground` shows `#indexLine` with Pause and Resume) and `src/ui/markup/010-view-dashboard.html`.
* Create `tests/indexPause.test.ts` and `tests/indexPauseUi.test.ts`; extend `tests/powerEvents.test.ts`.

- [ ] Tests first:
  - `pause stops the build's writes within one batch, and resume continues from the same row` (rows written: at most one batch after the pause, then constant over 20 polls; hang guard 10 s).
  - `cancel while paused ends the job and releases the database`.
  - `the build rests between batches at the budget's duty` (throttle calls counted per batch; fake clock).
  - `a build after a held scan runs at Eco`.
  - `the build's budget key holds no state after it settles` (completed, cancelled and failed builds: `engineBudget`'s test seam shows nothing under `index:<jobId>`).
  - `system sleep pauses a running build and wake resumes it` (structural).
  - `pause and resume refuse a request without a JSON body` (R52).
  - UI: `the index line shows while the build runs, with Pause and Resume, and is cleared when it settles`.
- [ ] Implement; `build:ui --check` clean.
- [ ] Mutants: the gate check removed; the throttle not called; Eco not forced after a held scan; the key never forgotten (`the build's budget key …`); the UI line never cleared.
- [ ] Commit `feat(index): the index build after a scan can be paused and runs inside the budget`.

### T9: Storage mode in the UI (UI)
**Depends on:** Phase 4 S4 and S6 (`storageMode` real, `disabled[]` on `/stats`, `409 STORAGE_MODE` naming the feature). Where S4 already built the Dashboard notice and the Settings row, this task only extends them.
**Files:** the Dashboard notice part, `src/ui/markup/110-modal-settings.html`, `src/ui/app/235-settings-modal.js`, `src/ui/app/200-duplicates-view.js`, `tests/aggregateUi.test.ts` (Phase 4's; extend) and `tests/storageSettingUi.test.ts`.
- [ ] Tests first:
  - `aggregate: the Dashboard notice names every feature in the scan's disabled[] in words`.
  - `aggregate: Duplicates and Similar photos show the notice instead of an error on 409 STORAGE_MODE`.
  - `storage row: four choices with one plain line each, saved through PUT /api/settings; a 400 BAD_SETTING is shown`.
- [ ] Implement; `--check`.
- [ ] Mutants: one disabled feature not named; the 409 shown as a generic error.
- [ ] Commit `feat(ui): aggregate-only scans say what they switch off, where it is switched off`.

### T10: Honest copy, the cold-scan sentence, the frame-cost count, `bench uiframes` (UI + bench)
**Files:**
* Modify `src/ui/markup/110-modal-settings.html` (`:24`, `:29`, `:51`, `:56`), `src/ui/app/045-persistent-live-index.js` (the native and gdu hints; the cold line beside the engine row's rate) and `src/ui/app/046-scan-live.js` (`#scanLiveCold`).
* Update `tests/engineBudgetUi.test.ts` (`SENTENCES`) and `tests/engineSettingUi.test.ts`.
* Create `tests/uiEngineClaims.test.ts`, `tests/scanFrameCost.test.ts`, `bench/lib/uiFramesSuite.ts`, `bench/probes/ui-frames-main.cjs` and `tests/benchUiFrames.test.ts`. `ui-frames-main.cjs` is plain JS for Electron main; it loads `dist/server.js` as `electron/main.js` does, and refuses when `dist/` is missing or older than `src/`.
* Modify `bench/run.ts`.

- [ ] Tests first:
  - `copy: nothing in src/ui or engineWords claims "faster", "fastest", "measurably", "exactly as correct" or "the same" without a bench source, and no copy says "the Mac" on every OS`.
  - `copy: the Settings engine line agrees with DESIGN §16` (it names that engines can differ on refused folders and placeholders).
  - `copy: Eco's line states a ceiling, never "a quarter of the machine"`.
  - `cold: every rate the page prints has the cold-scan line beside it, word for word from bench/README.md` (the engine row and the live readout).
  - `frame cost: one progress frame writes at most N elements and reads no layout (getBoundingClientRect, offset*/client*/scroll*, getComputedStyle)`. N is today's count, taken first, plus the readout's.
  - `frame cost: no progress frame draws on a canvas or re-renders a list`.
  - `frame cost: paintLive writes only its own text nodes (rate, CPU, memory, the paused note and the budget line), never markup`.
  - `frame cost: the counts per frame are the same over 10 and 10,000 frames`.
  - `uiframes: refused without a display, naming the reason`.
  - `uiframes: refused when dist/ is older than src/`.
  - `uiframes: the verdict is zero frames missing a 60 Hz vsync and a longest gap ≤ 32 ms in every run; the result names the engine, the preset and the display's refresh rate, and is refused as a baseline when a scan did not complete or the runs disagree on the verdict`.
- [ ] Implement.
  - `ui-frames-main.cjs` starts the server in-process on a free port with `TREEMAP_DATA_DIR` isolated.
  - It opens a visible, focused window with `backgroundThrottling: false`.
  - It records rAF timestamps through `executeJavaScript`.
  - It sets the Scan engine and budget for the run, then presses the page's own Scan button on the corpus.
  - It returns frames, frames missing a 60 Hz vsync (gap > 25.0 ms), frames over 32 ms, the longest gap, the p99 gap and `screen.getPrimaryDisplay().displayFrequency`.
- [ ] Measurement — **owner's Mac only — pending measurement, never taken on a container** (the desktop session, Tier B): `npm run bench -- uiframes --corpus=enum200k --engine=native --preset=turbo --runs=3 --record`, and the same with `--engine=walker`. The verdict is P8-6's, stated above; a miss is recorded with its counts. Tier A and Tier C: not available on this machine.
- [ ] Mutants: a `getBoundingClientRect` in the frame path; `renderBigFiles()` per frame; "measurably faster" restored; a "the results are the same" sentence added to `engineWords`; the cold line removed from the readout; the verdict judged by the median gap.
- [ ] Commits `feat(ui): engine copy says only what bench and DESIGN §16 back, the cold-scan sentence sits beside every rate, and the scan's frame cost is counted` and `bench: uiframes — rAF gaps through a real scan in a real window, judged against 60 fps and 32 ms`.

### T11: `scripts/busy-load.js`, the named busy-loop tool (script)
No such tool exists at `06fd687` (searched `scripts/`, `bench/` and `tests/`; tm-governor's `loadgen` is the *governed* load a hold measures, not a competitor, and the load sweep used ad-hoc `yes` loops). Phases 5–7 use none.
**Files:** create `scripts/busy-load.js` (plain JS, one `worker_threads` spinner per core, exits by itself) and `tests/busyLoad.test.ts`.
- [ ] Tests first: `it stops by itself at --seconds`; `it refuses more cores than the machine has`; `it refuses to start without --seconds` (never unbounded).
- [ ] Implement.
- [ ] Mutants: the self-stop timer removed; the cores check removed; `--seconds` defaulted to forever.
- [ ] Commit `bench: scripts/busy-load.js — the one named busy-loop tool for a competing load, which always stops by itself`.

### T12: Unattended work runs Eco — Phase 5's `budgetCap` verified, and who holds a scan recorded (verify + extend)
**Depends on:** Phase 5 T5.
**Files (extension only):** `src/services/autopilot.ts` (`startScan(policy.path, …)`) and `src/services/fleet/fleetRuntime.ts` (`startScan(path, …)`), each adding `heldBy` beside Phase 5's `budget: 'eco'`; `tests/scheduledEco.test.ts` (Phase 5's; extend); `native/treemap-core/crates/tm-walk/tests/capped_pacer.rs` (Phase 5's; extend only if needed).

- [ ] Step 0: read Phase 5's Progress row T5 and confirm on the tree:
  - `lower_of`, `capped_duty`, `throttle_capped` and `worker_limit_capped` in tm-governor;
  - `CappedPacer` in tm-walk;
  - `budgetCap` in `ScanStartOptions` and in tm-node's `START_SHAPE`;
  - `nativeEngine.ts` passing it from `scanBudgetCap(scanId)`;
  - the Autopilot and fleet `startScan` calls passing `{ budget: 'eco' }`;
  - the handshake bump;
  - these Phase 5 tests green: `throttle_capped_applies_the_lower_profile_and_reapplies_on_change`, `a_capped_thread_runs_background_qos_under_a_balanced_governor` (macOS), `capped_pacer_is_what_the_walk_reads`, `a scheduled scan starts the native walk with budgetCap eco`, `an Autopilot run's scan is Eco` and `a fleet-triggered scan is Eco`.

  Record each in Evidence. Anything missing is built to Phase 5's interface and test names, never under another name.
- [ ] Tests first (extension):
  - `a held scan's /live says who holds it and that a budget change does not apply to it` (schedule, Autopilot, fleet).
  - Rust, only if Phase 5's tests do not already pin the reconfigure case: `a_capped_walk_keeps_the_cap_after_the_governor_is_reconfigured`. It uses a real `Governor` configured Turbo, a `CappedPacer` at Eco and a walk over `tm-walk/tests/walk.rs`'s `FakeTree`. After at least two throttles, and again after `configure(Turbo)`, the worker thread's `EnforceReport` shows Eco's class and `throttle_totals()` shows Eco's duty, and `workers_peak` stays at or below Eco's `max_workers`.
- [ ] Implement; `cargo test -p tm-walk` and clippy on three targets if Rust changed.
- [ ] Mutants: `heldBy` dropped for fleet; `CappedPacer::throttle` calling `throttle_unless` (the reconfigure test reddens).
- [ ] Commit (only if something was added) `test(governor): unattended scans keep Eco through a reconfigure, and say who holds them`.

### T13: Governor headroom (R52a), measured (Rust + TypeScript)
**Depends on:** T11 (the competitor) and T12 (Phase 5's capped functions exist; their tests are re-pinned here).
**Files:**
* Rust:
  * `crates/tm-governor/src/preset.rs` (`max_workers`; `profile()` uses it) with its tests;
  * `crates/tm-governor/tests/controller.rs` (`eco_holds_a_quarter_on_eight_cores`, `balanced_holds_half_on_eight_cores`);
  * `crates/tm-governor/tests/governor.rs` (Balanced 4 → 5 workers and Eco 2 → 3 on 8 cores);
  * Phase 5's `crates/tm-governor/tests/capped.rs` (`capped_duty_holds_eco_on_two_four_and_eight_cores`);
  * create `crates/tm-governor/tests/fixtures/max-workers.json` and `crates/tm-governor/tests/max_workers_table.rs`.
* TypeScript: `src/services/engineBudget.ts` (`shimWorkerCap` from the same rule), `tests/engineBudget.test.ts` (the shim-cap pins) and `tests/maxWorkersTable.test.ts` (new).
* The handshake: `package.json` `nativeVersion` and the workspace `Cargo.toml` version.

- [ ] Tests first (Rust):
  - `every_yielding_preset_keeps_one_worker_of_headroom_where_the_machine_has_a_core_to_spare` (cores 1..=256).
  - `eco_keeps_phase_2_caps_up_to_four_cores`.
  - `turbo_is_unchanged`.
  - `the_committed_table_is_max_workers` (the JSON fixture equals `max_workers` for cores 1..=256 × three presets).
  - Re-pinned as a spec change, with their ceiling assertions untouched: Eco ≤ 3 and Balanced ≤ 5 workers on 8 cores (controller); Balanced 5 and Eco 3 on 8 cores (governor); `capped_duty(Eco, 8) = 0.25 × 8 / 3` (Phase 5's).
- [ ] Tests first (Node): `the shim's worker cap equals the committed table for cores 1..256` (no module needed); `a module of the previous nativeVersion is refused by the handshake`.
- [ ] Implement. Run `cargo test -p tm-governor -p tm-walk`, clippy on three targets, and the Node files.
- [ ] Measurement — **owner's Mac only — pending measurement, never taken on a container** (Tier B, 8 cores). On a clean tree, before and after:
  - `npm run bench -- governor --preset=eco --seconds=60` and `--preset=balanced`;
  - `npm run bench -- scanhold --corpus=enum200k --preset=eco --seconds=60`;
  - each alone, and again with `node scripts/busy-load.js --cores=2 --seconds=70` running.

  Keep the change only if the last-half mean is at least as close to the ceiling and the p95 |error| no worse. Otherwise revert the table, the re-pins and the bump together, and record "R52a closed: copy fixed, cap kept" with the measurement. Record DESIGN §8.1's R52a paragraph, including "> 8 cores: the formula only, not measured", and `--record` the new holds on a clean tree. Above 8 cores (Tier A): not available on this machine.
- [ ] Mutants: `+ 1` removed; `ceil` → `floor`; the `min(cores)` dropped; the Node shim reading its own constant instead of the rule (the table test reddens); the handshake left at the old version.
- [ ] Commit `native(governor): one worker of headroom above the Eco and Balanced ceilings, measured` (on a revert: `docs(engine): R52a closed — the copy fixed, the cap kept, measured`).

### T14: The scan boundary (MP §3.3) — one rule for every engine, its default the owner's (TypeScript + UI + CI)
**Depends on:** Q5 for the default. The mechanism is built either way.
**Files:**
* `src/utils/mountBoundaries.ts`: `mountPointsUnder(root, platform, deps)`, read from the OS mount table. The source is the platform layer's existing mount listing (the one `GET /api/volumes` answers from) or `/proc/self/mountinfo` on Linux; the one used is named in Evidence.
* `src/services/diskScanner.ts`: the per-scan never-descend list is the fixed list plus, with `stay`, the mount points under the root. gdu keeps `--no-cross` for `stay` and drops it for `cross`.
* `src/services/scan/nativeEngine.ts`: the same list in `neverDescend`. No Rust change and no handshake bump: both engines already honour the list.
* `src/services/settings.ts` and `src/api/settingsRoutes.ts`: `scanBoundary: 'stay' | 'cross'`, through Phase 5's 11-step settings checklist; `400 BAD_SETTING`.
* `src/services/scan/liveStatus.ts` (`mountsNotEntered`), `src/ui/markup/110-modal-settings.html` and `src/ui/app/235-settings-modal.js` (the row), `src/ui/app/045-persistent-live-index.js` (`#mountsNote`) and `src/api/openapi.ts`.
* `.github/workflows/test.yml` (Linux: a tmpfs mounted under the runner's temp folder before the suite, its path in `TREEMAP_TEST_NESTED_MOUNT`), `tests/scanBoundary.test.ts`, `tests/nativeEquivalence.test.ts` (a new case, not a loosened one), `tests/ciWorkflows.test.ts`, and `docs/engine/DESIGN.md` §5 and §16.

- [ ] Step 0: record what each engine does today at a nested mount on each OS:
  - the walker and native descend (the edge fixture's two `hdiutil` volumes, DESIGN §5);
  - gdu's pinned `--no-cross` rule, read from its source (a mount-table list or a device comparison), and whether it skips firmlinked folders such as `/Users` on a macOS scan of `/`;
  - whether any engine follows a Windows volume mount point (a reparse point; none is expected to).

  If gdu's rule differs from the mount-table rule, DESIGN §16 records the difference. gdu then runs under `stay` only where the two agree, and nothing is normalised.
- [ ] Tests first:
  - `the mount points under a root come from the mount table, never from a device comparison, so a firmlinked folder is not a boundary` (fake tables for Linux and macOS, including `/System/Volumes/Data` and `/Users`).
  - `with stay, no engine enters a mount below the root, and each counts it as not entered`. It covers the walker and native on the nested-mount fixture (macOS `hdiutil`; Linux, CI's tmpfs; skipped with the reason elsewhere), and gdu where Step 0 found it agrees.
  - `with cross, every engine enters it, as today`.
  - `the equivalence digest of walker and native agrees under both settings on the nested-mount fixture`.
  - `the setting is validated strictly at the API and forgiven in a hand-edited file`.
  - `the Dashboard names the mounts not entered and where to change it`.
  - `the Linux test leg mounts the nested fixture before the suite` (workflow shape).
- [ ] Implement; `build:ui --check` clean.
- [ ] Mutants: the mount list computed by device comparison (the firmlink case reddens); native not given the list (the equivalence case reddens); `--no-cross` kept under `cross`; the not-entered count dropped.
- [ ] Commit `feat(scan): Stay on this drive — no engine enters another filesystem unless the person asks (MP §3.3)`.

### T15: R52 — the same-origin guard (TypeScript)
**Files:**
* Create `src/middleware/sameOrigin.ts`, `tests/sameOrigin.test.ts` and `vscode-extension/src/lib/serverEnv.ts`.
* Modify `src/server.ts` (mount after `hostGuard`), `src/middleware/cors.ts` (shared list), `src/middleware/requireToken.ts:6-8` (a stale comment: the desktop sets a token), `src/api/openapi.ts` (the `CROSS_ORIGIN` code) and `src/services/fleet/fleetSync.ts` (`handlePeerRequest` calls `originVerdict` first).
* Modify `vscode-extension/src/server.ts` (`spawnOnce` builds its environment with `serverEnv`; `StartOptions.originFor`), `vscode-extension/src/extension.ts` (`asExternalUri` of `http://127.0.0.1:<port>` for the chosen port, before spawning) and `tests/vscodeExtension.test.ts`.
* Modify `AGENTS.md` (Uniform errors) and `SECURITY.md` (the guard and its two limits, P8-10).

- [ ] Tests first:
  - `no Origin and no Sec-Fetch-Site passes on every method (agents, curl, MCP)`.
  - `the page's own origin passes: the Electron window, the web UI, the VS Code panel's iframe`.
  - `a foreign Origin is refused on POST, PUT, PATCH and DELETE`.
  - `Origin null is refused`.
  - `Sec-Fetch-Site cross-site or same-site without an allowed Origin is refused (a form post, an <img>)`.
  - `an origin in TREEMAP_ALLOWED_ORIGINS passes`.
  - `localhost:3000 is not localhost:4280`.
  - `every state-changing route the app registers refuses a cross-site request before its handler runs`: it enumerates the Express router stack (not a grep), asserts at least 58 routes with a message, and counts handler calls at 0.
  - With scope `all`: `a cross-site GET that starts work (/api/duplicates) is refused`.
  - `fleet: a peer's request (no Origin) passes, and a browser's cross-site pairing attempt is refused before it is counted`.
  - `extension: the child's environment carries the forwarded origin after the TREEMAP_ strip, and a retry on another port asks for that port's origin` (`serverEnv` and a stand-in `originFor`, from `vscode-extension/src/lib/`).
- [ ] Implement. Run only these files plus `tests/apiContract.test.ts`, `tests/discoverability.test.ts`, `tests/mcp.test.ts` and `tests/fleet*.test.ts`.
- [ ] Mutants: host compared without port; an absent Origin with a cross-site Sec-Fetch-Site passes; `null` treated as absent; DELETE skipped; the guard mounted after the routers; the fleet check after the attempt counter; the allowed origin set before the strip.
- [ ] Commit `feat(security): one same-origin guard on the API and the fleet listener — a cross-site request is refused, an agent's is not (R52)`.

### T16: P4-9 closed (docs + one sentence)
**Depends on:** Phase 4 S6. If S6 already amended §9.1 and `openapi.ts:187`, verify its text and add only the change-journal decision.
**Files:** `docs/engine/DESIGN.md` §9.1, `src/api/openapi.ts:187`, `src/services/scan/nativeEngine.ts` (the native `engineReason` gains "a rescan lists every folder again"), `tests/nativeEngine.test.ts`, and create `tests/openapiText.test.ts`.
- [ ] Tests first:
  - `cacheHitRate is null on every engine, and the spec says why without promising an index`.
  - `a native scan's engineReason says a rescan lists every folder`.
- [ ] Implement. Rewrite §9.1 with P8-11's four reasons (reason 2 marked unverified) and what would reopen it. The golden is untouched (the walker is pinned and `<REASON>` is scrubbed).
- [ ] Mutants: the promise of an index restored in the spec; the engineReason clause dropped.
- [ ] Commit `docs(engine): change-journal rescan is not built, and the API stops promising it (P4-9)`.

### T17: bench — `ab`, the gate policy, planted slowdowns, the tmpfs rule (bench)
**Files:**
* Create `bench/lib/ab.ts`, `tests/benchAb.test.ts` and `tests/plantSeam.test.ts`.
* Modify `bench/run.ts` (the three commands and their usage), `bench/lib/suites.ts` (the `gdu-bare` engine; the rotating order over `runChild`, exported as the `deps` seam), `bench/lib/measureWorker.ts` (the plant spin and its target), `bench/lib/report.ts` (exports, IEC units in `fmtBytes`, `planted`, the refusal, `hostedRunner` in names), `bench/lib/machine.ts` (`hostedRunner`), `bench/lib/cache.ts` (R43b), `tests/benchCache.test.ts`, `tests/benchReport.test.ts` and `bench/README.md`.

- [ ] Step 0: Phase 5's T17a builds the two-result `ratio` command and exports its comparability ("same conditions but one"), `comparabilityDifferences(a, b, { except })`, from `report.ts`; its T0 gives the duplicates suite `--finder`, and its T4 the `sha256-oracle` finder that is the duplicates row's A leg. `ab` uses that comparability for NOT COMPARABLE and its combined band where two results are compared. Phase 5 lands before this phase; if its T17a were somehow absent, `comparabilityDifferences(a, b, { except })` is built here to Phase 5's contract, in the file Phase 5 names.
- [ ] Tests first (a fake `runChild` through `AbDeps`):
  - `ab: three legs, one warm-up each, then rounds whose order rotates so each leg takes each position equally often, one fresh child per run`.
  - `ab: each ratio is the median of its paired ratios with a resolution from their spread — native/walker wall, CPU and peak RSS, and walker/gdu-bare wall`.
  - `ab: a failed correctness check on any leg fails the whole A/B`.
  - `ab: legs that differ in anything but the engine are NOT COMPARABLE`.
  - `gatePolicy: FAIL then PASS on the confirmation passes with a warning; FAIL twice fails with both sentences; INCONCLUSIVE retries at retryRuns (9 without a file) and, still unresolved, passes annotated; NOT COMPARABLE fails and names the difference`.
  - `ab-check: native slower than the walker beyond the resolution FAILS whatever the ratio file says`.
  - `ab-check: a gated ratio above its committed median by more than max(10 %, its band) beyond the resolution FAILS; inside the resolution is INCONCLUSIVE`.
  - `ab-check: a ratio file for another platform, architecture, corpus, preset, run count or walker mapping is NOT COMPARABLE` (P8-22).
  - `ab-calibrate: refuses fewer than 20 fit runs or 20 held-out clean runs, a failed or planted run among the clean ones, or an AbResult whose own machine.dirty is true` (dirtiness is each result's own; downloading artifacts into the checkout does not count).
  - `ab-calibrate: detection is gatePolicy's final FAIL — a planted run that ends INCONCLUSIVE is missed, and the file is refused while any +15 % planted run is missed`.
  - `ab-calibrate: the band is fitted on the fit runs, false alarms are counted on the held-out runs only, and the file records both sets and 3/N`.
  - `planted: the spin lengthens the timed window and the CPU time by the stated share on its target's legs only (native, or both TreeMap engines; never gdu-bare), marks the result, and --record refuses it`.
  - `plant seam: nothing under src/ reads TREEMAP_BENCH_PLANT_SLOWDOWN_PCT or TREEMAP_BENCH_PLANT_TARGET` (a source scan).
  - `cache: on Linux a corpus on tmpfs is never labelled cold` (`fs.statfsSync(dir).type === 0x01021994`; R43b).
  - `fmtBytes prints binary units with binary names` (2,499,268,608 B → "2.33 GiB").
  - `a hosted runner's result carries hostedRunner in its record and its file name`.
- [ ] Implement.
- [ ] Measurement — **owner's Mac only — pending measurement, never taken on a container**: `npm run bench -- ab --corpus=ci20k --runs=5`, three times. Record the three sets of ratios and resolutions in CURRENT-STATE §11.3 as Tier B context, not as a CI baseline.
- [ ] Mutants: sequential AAAAA BBBBB; the ratio of medians; the engine not excepted; the band ignored; planted not refused; detection counted by ratio instead of `gatePolicy`; the band fitted on the held-out runs; the plant applied to gdu-bare; the tmpfs check removed; `fmtBytes` back to "GB".
- [ ] Commit `bench: ab — walker, native and a bare gdu reference interleaved in one job, four paired ratios, and a gate policy calibration must pass through`.

### T18: Prebuilds for every target, checked by architecture and SHA-256; `dist:*` builds the module; `--locked` (build + CI)
**Files:**
* Modify `scripts/build-native.js` (`--target`).
* Create `scripts/native-targets.json`, `scripts/check-prebuilt.js`, `tests/checkPrebuilt.test.ts`, `tests/packageScripts.test.ts` and `tests/fixtures/binaryHeaders.ts`. The fixtures are 64-byte Mach-O and ELF headers for arm64 and x64, PE files of 0x200 bytes with `e_lfanew` pointing past the DOS stub, and a truncated PE.
* Modify `tests/buildNative.test.ts`, `.github/workflows/release.yml` (job `native`, placed after `build`), `tests/releasePipeline.test.ts`, `tests/polishDocs.test.ts` (only if the header text moves), `tests/ciWorkflows.test.ts` and `package.json` (every `dist:*` and `dist:portable-*`).

| Target | Runner | Build | Tested there |
| --- | --- | --- | --- |
| darwin-arm64 | macos-latest | native | `cargo test --locked`, `tests/nativeLoader.test.ts` and `tests/nativeEquivalence.test.ts` with the built module, after `npm run fetch:gdu:dev` |
| darwin-x64 | macos-latest | `--target=x86_64-apple-darwin`, the target added to the pinned toolchain with `rustup target add --toolchain <pin> x86_64-apple-darwin` in the workspace (`dtolnay/rust-toolchain@stable` adds targets to stable, not to the pin) | the same two files under Rosetta, in their own job with `setup-node` `architecture: x64` **before** `npm ci` (an arm64 `npm ci` installs esbuild for arm64, and tsx aborts under x64 Node); checked on the first run. If the image has no Rosetta: `tested: false` (Q1) |
| win32-x64 | windows-latest | native | as darwin-arm64 |
| linux-x64 | ubuntu-latest | native | as darwin-arm64 |
| linux-arm64 | `ubuntu-24.04-arm` (Q1) | native | as darwin-arm64. Without Q1: cross-built on ubuntu-latest with `gcc-aarch64-linux-gnu` and `CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc`, `tested: false` |

- [ ] Step 0: Phase 5's P5-25 and T6 add `--locked` to test.yml's clippy and test lines, to `scripts/build-native.js` (`runCargo`, both builds) and to `test:native`, updating the pinned command strings. Confirm each on the tree, together with its test (`every cargo build, clippy and test in CI and build-native passes --locked`, `tests/rustSupplyChain.test.ts`). If Phase 5 T6 has not landed, build it here to Phase 5's interface and test names, including `tests/cargoAnnotate.test.ts`'s pinned command strings, in one commit before anything else in this task.
- [ ] Tests first:
  - `machineOf reads Mach-O, PE and ELF headers for arm64 and x64, and a truncated PE reads as unknown`.
  - `checkPrebuilt fails, with the reason, on another architecture, a missing VERSION, or a VERSION other than nativeVersion`.
  - `build-native: --target maps the triple to its prebuilt folder, and every cargo call carries --locked`.
  - `package scripts: no install, preinstall, postinstall or prepare script runs cargo, build-native or fetch-native` (R34).
  - `package scripts: every dist and dist:portable script builds the module and checks it before electron-builder, and test:native carries --locked`.
  - `release: the native job builds every target in native-targets.json with --locked, runs after build, and publish needs it`.
  - `release: SHA256SUMS lists exactly the targets in native-targets.json, and the asset check re-downloads each module and compares its SHA-256, so a same-size corrupted upload fails`.
  - `release: each new step is skipped at a tag with no scripts/ for it, and publish accepts a skipped native job` (a repair of v5.0.1).
  - `release: the matrix polishDocs reads is still the installer matrix, and the header still says Linux is not released`.
  - `release: the darwin-x64 test job sets up x64 Node before npm ci; every tested leg fetches gdu; each cross target is added to the pinned toolchain`.
  - `release: an untested target is attached with tested: false in native-manifest.json`.
  - `workflows: every cargo clippy, test and build line carries --locked`.
- [ ] Implement.
- [ ] Measurement: none on hardware. The evidence is the owner's test build (Actions → Build & Release, empty tag): its URL, head SHA and conclusion, with every target's module checked.
- [ ] R57 stays open: Q4.
- [ ] Mutants: `--locked` dropped from one call; the arch check skipped; one target missing from the asset check; the asset check comparing sizes; a `postinstall` added; the old-tag guard removed; x64 Node set up after `npm ci`.
- [ ] Commit `feat(release): a native module for every release target, checked by architecture and by SHA-256, with untested builds marked`.

### T19: The CI performance gate and its calibration (CI + measurement on the hosted runners)
**Depends on:** T17, T18 (`--locked` in `build-native.js`) and P8-22.
**Files:**
* Create `bench/ci/gate.cjs` (plain JS; requires `tsx/cjs`; `module.exports = { main }`, `main(argv, deps)`), `.github/workflows/perf-calibrate.yml` and `tests/perfGate.test.ts`.
* Modify `.github/workflows/test.yml` (job `perf`) and `tests/ciWorkflows.test.ts`.
* Later: `bench/ci/enumerate-{darwin-arm64,win32-x64,linux-x64}.json`; with Phase 5's native finder, `bench/ci/duplicates-….json`; and `bench/ci/hosted/` (the hosted-runner evidence).

- [ ] Tests first:
  - `the perf job runs on push and pull requests on macOS, Windows and Linux, never on the pt-BR leg`.
  - `it builds the module with --locked, fetches gdu for the gdu-bare leg, and runs the gate with its platform's ratio file, reading the corpus and runs from it`.
  - `the perf job is advisory until its ratio files exist, and blocking from the commit that adds them` (`continue-on-error` pinned against the presence of the platform's file).
  - `no workflow but perf-calibrate sets TREEMAP_BENCH_PLANT_SLOWDOWN_PCT or its target`.
  - `perf-calibrate is workflow_dispatch only, takes mode=fit|validate, uploads every AbResult and gate run, and writes hosted results through TREEMAP_BENCH_OUT and TREEMAP_BENCH_BASELINES into the uploaded folder`.
  - gate (a fake `runAb`):
    - `each gatePolicy outcome surfaces as its annotation`;
    - `with no ratio file only the native-slower-than-walker rule gates, and the annotation says so`;
    - `the duplicates row runs only when the duplicates suite has --finder=blake3-staged`.
- [ ] Implement the gate and the job. **Commit 1** lands advisory, with no ratio files; only the native-slower rule gates, and the job summary says so.
- [ ] **Measurement** (the owner pushes and triggers; the agent never does):
  1. Fit: Actions → Perf calibration → Run workflow, `mode=fit jobs=20 runs=5 corpus=ci20k`, on all three OSes.
  2. Validate (held out): `mode=validate jobs=20 plant=11,15,25 plant-shared=15 plant-jobs=5`, where +11 means `max(11 %, 10 % + the fit's median resolution)`.
  3. The same dispatches' Tier C evidence jobs (P8-20): `npm run bench -- governor --preset={eco,balanced,turbo} --seconds=60 --record`, and, once Phase 4 S5 exists, `enumerate --corpus=synthetic100m` in spill and aggregate where the runner's free disk allows 3× the projected spill (Phase 4's own rule). Results go to the uploaded folder, the owner downloads them (`gh run download <id>`), and the agent commits them under `bench/ci/hosted/`.
  4. `npm run bench -- ab-calibrate --runner=<label> --fit-run=<id> --validate-run=<id> --out=bench/ci/enumerate-<platform>-<arch>.json …` per OS. Record in DESIGN §15 and the file, per OS:
     - the fit ratios, band and threshold of each gated ratio;
     - the held-out false alarms and 3/N;
     - the detection counts at +11, +15 and +25 % on native and +15 % shared;
     - the INCONCLUSIVE counts.

     Escalation per P8-13: 9 runs, then `enum200k`; if still over 10 %, Q3.
  5. Duplicates: once Phase 5 T12 and T4 have landed, the same two dispatches with `suite=duplicates a=sha256-oracle b=blake3-staged ref=none`. Until then DESIGN §15 says duplicates are not gated in CI, and why.
- [ ] Mutants: the confirmation run skipped; INCONCLUSIVE → FAIL; the pt-BR leg included; the advisory flag never removed (the pinned switch reddens); walker/gdu-bare not gated.
- [ ] Commits `feat(ci): the performance gate — native against the walker and the walker against a bare gdu, in one job, advisory until calibrated` and `bench(ci): ratio files from calibration runs <fit id> and <validate id> — bands fitted on one set, false alarms and planted slowdowns counted on another; the gate becomes blocking`.

### T20: `npm run fetch:native` (script)
**Files:** create `scripts/fetchNative.js` and `tests/fetchNative.test.ts` (a local HTTP stand-in that can redirect; no real network); modify `package.json`, `src/services/scan/native.ts` (reads `native/prebuilt/<platform>-<arch>/PROVENANCE.json` `{ tested, runUrl }` when present), `src/services/scan/nativeEngine.ts` (an untested module's clause in `engineReason`), `src/services/scan/engineWords.ts` (`untestedWords`), `src/services/scan/liveStatus.ts` (`untestedBuild`), `src/ui/app/045-persistent-live-index.js` (the badge line), `tests/engineBadgeUi.test.ts`, and `SECURITY.md` (layered on Phase 7's network edit: what `fetch:native` verifies, and that it is a corruption check, not an authenticity check).
- [ ] Tests first:
  - `a verified module lands at native/prebuilt/<platform>-<arch>/treemap_core.node with VERSION and PROVENANCE, by rename`.
  - `a checksum mismatch writes nothing and names the file`.
  - `a release whose module is for another nativeVersion is refused before download`.
  - `a platform without a prebuild says so and writes nothing`.
  - `requests go only to https github.com release URLs, and redirects only to https hosts under .githubusercontent.com, at most five` (the stand-in redirects to an allowed host: followed; to another host, to `http:`, or a sixth hop: refused).
  - `the tag defaults to v<package.json version>`.
  - `a module marked untested is refused without --untested, and installed with it`.
  - `a loaded untested module says so in the engine's reason and on the badge`.
  - `failure exits 1 with one sentence`.
- [ ] Implement (temp file, then rename: the macOS code-signature lesson of 23 Sep).
- [ ] Mutants: verification skipped; write before verify; the version check skipped; the redirect host unchecked; untested accepted without the flag.
- [ ] Commit `feat(native): npm run fetch:native — the release's module for this platform, SHA-256-verified, redirects checked, untested builds only on request`.

### T21: Only shipped paths; the packaged app proven (TypeScript + Electron + release)
**Files:**
* Modify `src/services/scan/native.ts` (`nativeCandidates`), `src/services/scan/nativeEngine.ts` (`mftHelperCandidates`), `tests/nativeLoader.test.ts`, `tests/mftHelperPath.test.ts` (the test "in a packaged app the helper is looked for under app.asar.unpacked, where Windows can start it" pins the dead second candidate), `electron/main.js`, `.github/workflows/release.yml` (after "Build the installer", gated for old tags) and `native/README.md`.
* Create `scripts/smoke-packaged.js` and `tests/smokePackaged.test.ts`.

- [ ] Tests first:
  - `loader: the candidates are the prebuilt path alone, or TREEMAP_NATIVE_MODULE alone`.
  - `mftHelperCandidates: one candidate, under app.asar.unpacked`.
  - `main.js: --treemap-smoke-native prints one JSON line and exits before any window, server or tray` (a structural slice of main.js).
  - `smoke: finds the macOS and Windows layouts under release/; fails when the module is not under app.asar.unpacked, when the verdict is unavailable, or when the loaded path is not the app's own`.
  - `smoke: macOS runs codesign --verify --strict on the unpacked module`.
  - `smoke: the release step is skipped at a tag without scripts/smoke-packaged.js`.
- [ ] Implement.
- [ ] Measurement: the owner's test-build run (URL, head SHA, conclusion) on both installer legs.
- [ ] Mutants: the resources candidate re-added; the smoke accepting a repo-checkout path; the old-tag guard removed.
- [ ] Commit `fix(native): the loader looks only where a build ships the module, and the release proves the packaged app loads it from app.asar.unpacked`.

### T22: Third-party notices — Phase 5's generator verified and extended (script + docs)
**Depends on:** Phase 5 T6 and T18 here (`native-targets.json`).
**Files:** `scripts/rust-notices.js` and `native/THIRD-PARTY-NOTICES.md` (Phase 5's; extended), `tests/rustSupplyChain.test.ts` (Phase 5's; extended) or `tests/rustNotices.test.ts`, release.yml's `native` job (attach the notice) and `native/README.md`.
- [ ] Step 0: confirm Phase 5 T6's generator, the licence texts it copies (`LICENSE*`, `COPYING*`, `NOTICE*`), the bundle entry, and CI's `node scripts/rust-notices.js --check` step. The committed file's licences are then checked against `cargo metadata` in CI, so the static allow-list test below reads a file CI has verified. Anything missing is built to Phase 5's names.
- [ ] Tests first:
  - `every licence expression passes as SPDX: an OR passes when one alternative is allowed, an AND when every part is` (memchr's `Unlicense OR MIT`, unicode-ident's `(MIT OR Apache-2.0) AND Unicode-3.0`, blake3's `CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception`). The allow-list is MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Zlib, CC0-1.0, Unicode-3.0, MIT-0 and `Apache-2.0 WITH LLVM-exception`.
  - `nothing whose every alternative is GPL, LGPL or AGPL passes`.
  - `the notice covers every triple in native-targets.json` (Phase 5's `--filter-platform` per triple, unioned, now reading its triples from `native-targets.json` instead of its own list: a crate only Windows links is in it, and a sixth target added to the file is covered without touching the script).
  - `the notice is attached beside the modules on the release`.
- [ ] Implement.
- [ ] Mutants: OR evaluated as AND; `GPL-3.0` accepted; one triple dropped.
- [ ] Commit `docs(native): the Rust notices cover every release target and pass a licence allow-list read as SPDX`.

### T23: The equivalence test on every corpus, on three platforms (test + CI)
**Files:** create `.github/workflows/equivalence-full.yml` (workflow_dispatch only); modify `tests/nativeEquivalence.test.ts` (`TREEMAP_EQUIVALENCE_CORPORA` names extra corpora; the default stays smoke, ci20k and the edge fixture) and `tests/ciWorkflows.test.ts`.
- [ ] Tests first:
  - `the equivalence test runs exactly the corpora it is given, and names each it could not run with the measured reason` (a corpus whose build needs more free disk than the runner has is "not available on this runner (N GB free, needs M)", never a silent skip). The per-corpus hang guard scales with the corpus; it is a hang guard, never a measurement, and no assertion is loosened.
  - `equivalence-full is workflow_dispatch only, runs on macOS, Windows and Linux, builds the module with --locked, fetches gdu, asks for enum200k, enum1m and dupes100k, and records each leg's job time and free disk`.
- [ ] Implement.
- [ ] Measurement: the owner dispatches it once before release. Its URL, head SHA and conclusion, per-leg job minutes and per-corpus result go into DoD row 4.
- [ ] Mutants: the corpora variable ignored; a skip without a reason; dupes100k dropped from the workflow.
- [ ] Commit `test(engine): the equivalence test on every corpus, on three platforms, in a workflow of its own`.

### T24: README and CHANGELOG held to `bench/` (docs + bench + test)
**Depends on:** T17 (the formatter exports and IEC units), plus the recorded baselines of Phase 4 S5 (memory), Phase 5 (duplicates) and Phases 6–7 (near-duplicates). A phase with no recorded baseline gets no number in the README.
**Files:** create `bench/readme-block.md`, `bench/lib/readme.ts`, `tests/readmeBench.test.ts`, `tests/releaseNotesClaims.test.ts` and `tests/fixtures/readmeNumbersOutsideBench.json` (each entry cites a code `file:line` or a bench file and field); modify `bench/run.ts` (`readme`), `bench/README.md` (the plain sentence names warm and mixed) and `README.md`.
- [ ] Tests first:
  - `the README's bench block equals npm run bench -- readme's rendering, byte for byte`.
  - `every placeholder names a committed bench/baselines or bench/ci/hosted file and field`.
  - `the conditions beside each figure are the file's`: the machine as recorded (osRelease is the kernel version), the cache state per figure, the budget, the load range from `runs[].loadAvg[0]`, the date, and for a hosted row its recorded cores and memory.
  - `no performance figure outside the block: any number followed by ms, s, sec, min, h, B, KB/MB/GB/TB (and KiB…), bytes, %, fps, ×/x, /s or items/s, unless allow-listed; each allow-list entry cites a code file:line or a bench file and field, and the value there is checked`.
  - `the headline figures come from warm files only, and a mixed file's figure carries the word "mixed"`.
  - `the cold-scan sentence is present, word for word from bench/README.md's "Plain words for the README", and names both warm and mixed`.
  - `every CHANGELOG entry newer than 5.0.1 passes the same detector; entries up to 5.0.1 are listed as published before the rule`.
  - `the API table lists the engine routes, pause and resume, /live and the index pause`.
- [ ] Rewrite (verified against the files on 25 Sep 2026):
  - README:762: load "2.2" is in no cited file (the 1-minute loads are 2.7–3.6, and 7.05 on walker enum1m). The enum1m figures are `mixed`, not warm. "macOS 27" is not a recorded field. "2.3 GB" is the harness's "2.33 GiB". The "±17 %" is in no committed file, so it is dropped. "The built-in walker runs" becomes gdu where bundled (macOS, Linux) and the walker on Windows or without gdu (`diskScanner.ts`, `gduRuleFor`).
  - README:760: drop the ~52 B/file, 28 ms vs 2.2 s, ~150/~170 ms, "~2 GB", "~5 GB" and "~330 bytes each" figures, which have no bench file. Take the memory figures from Phase 4 S5's baselines, or none. Replace "pure JS + TypedArrays — no native modules".
  - README:761: drop the 1.6× and 32-thread figures and state the real rule, `min(16, max(8, 2 × cores))` (`ioThreads.ts`, `electron/main.js:33`).
  - README:763: drop every figure ("16.4 s", "9.1 s", "183 bytes on disk" included).
  - README:766, 184, 504 and 665: from the Phase 5 and 6 baselines, with SHA-256 kept only where it still runs (offload and the capsule, D5).
  - Web mode (426-437): `fetch:native` and `build:native`. Project layout (704-757): `native/`, `bench/` and the scripts.
  - Add the cold sentence.
- [ ] Mutants: 412,291 → 412,290 in the block; a map entry to the wrong field; "116,793 items/s" restored outside the block; "16.4 s" restored at README:763; "~2 GB" restored at README:760; an allow-list entry without a citation; a next-version CHANGELOG entry saying "400 ms"; the cold sentence deleted.
- [ ] Commit `docs(readme): every performance figure rendered from bench/baselines by the harness, with its machine and conditions, the cold-scan sentence, and the CHANGELOG held to the same rule`.

### T25: The engine documents as built (docs)
**Files:** `docs/engine/DESIGN.md`, `docs/engine/RISKS.md`, `docs/engine/CURRENT-STATE.md`, `SECURITY.md`, `AGENTS.md`, `native/README.md`, and create `tests/docsDrift.test.ts`.

DESIGN:
* §4's tree names real files (not `ScanEngine.ts`; `tm-hash`/`tm-imghash` only once they exist).
* The rust-version: the workspace says 1.85, and the pin is 1.98.1 (DESIGN §4 says 1.97 today).
* §5: the scan boundary (P8-21, T14). §8.1: R52a per T13, "> 8 cores: the formula only, not measured"; Eco's heavy-I/O pause not built, with P8-26's reason and Q6. §10: P8-25.
* §12: `/live` beside `/stats` (P8-1, the departure from MP §1's "extend this field set").
* §13: the badge's `<details>` instead of hover (P8-3); Cancel-only jobs and the model download (P8-4); the scanning process's figures and the helper's null (P8-2); the advanced ceiling (P8-5); the index build's Pause (P8-23).
* §14: the release legs, `native-targets.json`, untested modules (P8-14).
* §15: the gate's metric, its blind spots, the plant's nature, the calibration numbers (P8-12, P8-13); frames counted in tests and timed in bench (P8-6, the departure from MP §12.4); equivalence on every corpus (P8-24).
* §16: gdu's `--no-cross` difference, if T14's Step 0 found one.
* §17's Phase 8 row.
* A new **§19, targets against measurements**: every MP §5 row, with the measured figure and its bench file, or "not reached" with the reason (DoD item 2).

RISKS:
* R33, R34, R39 (only once T24's README and CHANGELOG tests are green), R43b, R52 (with P8-10's two limits) and R52a retired or updated, with evidence.
* R57 left open with its reason (Q4).
* New LOW rows: `fetchGdu.js` follows redirects to any host (`redirect: 'follow'`); the helper engines' CPU and memory are not counted in the readout. A new row for P8-26: Eco does not pause for another app's heavy I/O (MP §8.1), so an unattended hash or scan competes with it at Eco's lowest I/O class — open until the owner answers Q6.

CURRENT-STATE:
* §9's stats key count is derived from `buildScanStats` (30 at 25 Sep 2026; 31 once Phase 4 S6 adds `disabled`), and its citation is by symbol, not `scanRoutes.ts:25-47`.
* A new §11.3 with the Phase 8 measurements.

SECURITY: the same-origin guard and its limits, `fetch:native` (a corruption check, not an authenticity check). AGENTS: `CROSS_ORIGIN`, `/live`, the index pause and the scan boundary setting.

- [ ] Tests first:
  - `DESIGN §4 names only paths that exist`.
  - `DESIGN's rust-version is the workspace's`.
  - `every Phase 8 departure is recorded, with its id` (each sentence above carries its P8 id in its section).
  - `CURRENT-STATE's stats key count is buildScanStats's`.
- [ ] Mutants: a missing path added; 1.97 restored; one departure sentence removed; the key count typed by hand as 30 after Phase 4 S6.
- [ ] Commit `docs(engine): DESIGN, RISKS and CURRENT-STATE as Phase 8 built them — the gate and its blind spots, the targets, the release legs, the UI, every departure named`.

### T26: The Definition-of-Done audit (docs + test) — the owner's release precondition
**Depends on:** every task above, and the Phase 4–7 gates.
**Files:** create `docs/engine/DEFINITION-OF-DONE.md`, `tests/definitionOfDone.test.ts`, `scripts/verify-dod.js` (run by the owner: `gh run view <id> --json conclusion,headSha` for every run the audit names) and `tests/verifyDod.test.ts` (a stand-in `gh`).
- [ ] Tests first:
  - `the fourteen §14 items, verbatim, one row each`.
  - `each verdict is done, not met (with the measured figure), not available on this machine, or owner-accepted (with a date)`.
  - `every evidence path exists, every file:line is inside its file, every bench file is under bench/baselines or bench/ci, and every CI run is recorded as its URL, head SHA and conclusion`.
  - `an owner-accepted row cites a commit or message of the owner's own` (its commit carries no `Co-Authored-By: Claude` trailer).
  - `no row reports Tier A or Tier C as passed; hosted rows carry their recorded cores and memory; item 7 counts only a run recorded at ≤ 8 GiB`.
  - `the Phase 5–7 rows name their features`.
  - `the constraints outside §14 (MP §3.3, §3.5, §8.1's Eco I/O yield) have their own rows`.
  - `verify-dod: a run whose conclusion is not success, or whose head SHA differs from the audit's, fails with the row named`.
- [ ] Walk MP §14 item by item, with evidence for each:
  1. The three documents (T25's drift test).
  2. DESIGN §19.
  3. The baselines and results under `bench/`.
  4. The equivalence test on all corpora and three platforms: T23's dispatch, with any corpus "not available on this runner" named with its reason.
  5. §12.2 case by case against `tests/fixtures/edgeCases.ts` and the Rust tests.
  6. The governor per tier: Tier B baselines, Tier C (hosted VM, labelled), Tier A not available.
  7. 100M inside the ceiling on Tier C: Phase 4 S5 plus the hosted run recorded at ≤ 8 GiB, else not available.
  8. Duplicates: 0 FP / 0 FN over every group, the targets, placeholders provably untouched, per Phase 5's gate; tm-hash BLAKE3, the last-copy rule, `content-cache.db`.
  9. The near-duplicate fast tier (tm-imghash pHash, dHash and colour; MIH; the signature cache) and the deep tier (off by default, consent, pinned SHA-256, offline after download, crop recall, the ANE/NPU CPU budget), per the Phase 6 and 7 gates.
  10. The legacy fallback with an honest badge (T2's forced-failure test; `nativeEquivalence.test.ts` case (d)).
  11. Endpoints unchanged in shape (`goldenResponses`, `discoverability`) and all tests pass (the owner's CI run).
  12. README (T24).
  13. CI green on all three platforms with prebuilds for every target (T18, T19 and T21 runs; untested targets named).
  14. No new frontend dependencies (`frontendContract.test.ts:402-429`).

  Outside §14: MP §3.3 (T14 and Q5), MP §3.5 (T18 and Q1) and MP §8.1's "pauses while another app is doing heavy I/O" (P8-26 and Q6: "not met — owner decision" until answered).
- [ ] The file's last line states, with the commit and CI run, that every row is done or owner-accepted, or names what is not. **The owner runs `node scripts/verify-dod.js`, then bumps the version, writes the CHANGELOG entry, tags `v*` and publishes. The agent does none of these.**
- [ ] Mutants: a row removed; "passed" on a Tier C row; an evidence path that does not exist; an owner-accepted row citing an agent commit; a run URL whose SHA does not match.
- [ ] Commit `docs(engine): the Definition-of-Done audit — every §14 item with evidence the owner can re-check`.

### Phase gate
MP §6's Phase 8 gate, measured:
* **"Budget selector works and is discoverable":**
  * the control exists in Settings (with the advanced CPU ceiling), in the scan card and under ⌘K;
  * a `PUT /api/engine/budget` during a native scan changes `/live`'s `budget.now`, appends to `budget.changes`, and the walk's governor snapshot reports the new `effective` (counted in `tests/scanLive.test.ts` and `tests/engineBudget.test.ts`);
  * during a gdu scan it applies from the next helper, and on a held scan it is said not to apply, both in words.
* **"Engine status is visible":** the badge shows the fast path in words. After a forced load failure (`TREEMAP_NATIVE_MODULE=/nonexistent/…` with `TREEMAP_NO_GDU=1`) it shows a visible fallback sentence with no sameness or speed claim (`tests/engineBadgeUi.test.ts`).
* **"README claims match `bench/` output exactly":**
  * `npm run bench -- readme --check` exits 0;
  * `tests/readmeBench.test.ts` is green, with no performance figure outside the block;
  * `tests/releaseNotesClaims.test.ts` is green.
* **"CI fails on a > 10 % regression":**
  * in the held-out validation dispatch, on each OS whose band is ≤ 10 %, every planted +15 % gate run on native and every +15 % run on both TreeMap engines fails, and no held-out clean gate run does;
  * the +11 % detection count and the 3/N false-alarm bound are recorded in DESIGN §15. "> 10 %" is claimed only if every +11 % run failed; otherwise DESIGN §15 states the smallest level caught in every run;
  * where a band is wider than 10 %, the smallest planted slowdown caught in every run is stated in DESIGN §15 and accepted by the owner (Q3);
  * what the gate cannot see is stated in DESIGN §15;
  * the `perf` job is blocking and green on the owner's push.
* **Also required:**
  * a release test build that attaches every target in `native-targets.json`, SHA-256-checked, untested ones marked, with the packaged smoke green on both installer legs;
  * `node scripts/build-ui.js --check` clean;
  * the equivalence digests unchanged, and `equivalence-full` green on every corpus that fits, each one that does not named with its reason;
  * the scan boundary built, with its default as Q5 decides (or "not met by default: Q5");
  * the DoD audit committed and green, and `scripts/verify-dod.js` run by the owner;
  * `bench uiframes` and R52a recorded on the owner's Mac (owner's Mac only; "pending measurement" until then, never passed).
* **Tiers:** Tier A and Tier C are "not available on this machine". Hosted-VM results carry P8-20's label, with their recorded cores and memory, and are never passed as a physical Tier C.
* The full gate as always, including a review fleet over the diff before check-in (R48).

## Open questions for the owner

1. **Release targets (P8-14).** Recommended:
   * Keep installers at macOS arm64 and Windows x64.
   * Attach all five native modules to every release for web mode (`npm run fetch:native`), listed in `scripts/native-targets.json`.
   * Approve the `ubuntu-24.04-arm` hosted runner so linux-arm64 is built *and tested* natively.
   * Accept darwin-x64 cross-built on the arm64 runner and load-tested under Rosetta. If the image lacks Rosetta, ship it marked untested (`fetch:native --untested`, and the badge says so) or drop it; I recommend shipping it marked.
   * No Intel-Mac installer and no Linux AppImage release until someone asks.

   Without an answer, linux-arm64 is cross-built and attached marked untested, and the audit's item 13 names it.
2. **R52's scope (P8-10).** Recommended: **every method** on `/api`. It refuses only a *present* cross-site signal, so agents, MCP and curl are untouched. It also closes cross-site GETs that start work (`/api/duplicates`, `/api/near-duplicates`) in every browser that sends Fetch Metadata. A browser without it (Safari before 16.4) still gets through with an `<img>` GET, which SECURITY.md states. The narrower alternative is state-changing methods only, as R52 was written.
3. **The gate's band and its flake rate (P8-12, P8-13).** Recommended: threshold = max(10 %, the band fitted over 20 clean gate runs + 2 points), a confirmation run, and INCONCLUSIVE never failing. 20 held-out clean runs bound the false-alarm rate at ≤ 15 % per push (95 % confidence). If you want ≤ 5 %, the validate dispatch runs 60 clean gate runs, about three times the runner minutes. If a runner's band stays above 10 % after 9 runs and `enum200k`, accept that runner's gate catching only regressions above its band, stated in DESIGN §15, rather than a gate that flakes. The alternative is to run that OS's gate as advisory.
4. **R57, the native module's integrity (T18).** A SHA-256 pinned beside the module is within the same reach as the module. A pin in `package.json`, checked by the loader before `dlopen`, is tamper-evident only while `package.json` itself is. That needs Electron's `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` fuses, whose check covers `app.asar` and not `app.asar.unpacked`, which is why the pin, not the module, is what the fuse protects. Both fuses change how the app is signed and packaged. **Recommended:** keep R57 open in this release. In the first signed release, turn both fuses on and add the loader's pin, after checking the fuses against Electron 31's documentation on both platforms. Web mode has no asar and keeps R57's posture.
5. **The scan boundary's default (P8-21, T14).** MP §3.3 says no engine crosses into another filesystem unless asked. Today gdu does not, and the walker and the native engine do (outside a short never-descend list). **Recommended: "Stay on this drive" by default**, with "Include drives mounted inside it" one click away in Settings and named in the Dashboard note whenever a mount was not entered. On macOS a full-disk scan is unchanged (firmlinks are not mounts, and `/Volumes` is already skipped). On Linux a scan of `/` stops counting drives mounted under it, which is the prompt's rule. Without an answer the default stays today's, and the audit's §3.3 row reads "not met by default".
6. **Eco pausing while another app does heavy I/O (P8-26).** MP §8.1 lists it among Eco's behaviours. Phase 5 did not build it and deferred it here; this plan does not build it either, because it needs a disk-busy signal per platform with TreeMap's own reads subtracted, a threshold only a measured competing I/O load can set, and a named I/O competitor — none measured yet. **Recommended:** a plan of its own after this phase, built and measured on your Mac first (Linux `/proc/diskstats`, macOS IOKit block-storage statistics, Windows disk-performance counters), adopted only if a measurement shows an interactive app's reads get faster with it; until then the audit's row reads "not met — owner decision" and DESIGN §8.1 says so. The alternative is to accept Eco's lowest I/O class as the whole of Eco's I/O behaviour, stated as a departure from MP §8.1.

## Review record (25 Sep 2026)

Four adversarial reviewers read the plan as first written. Their findings were verified against the repo at `1bf6209` plus the working tree, against the master prompt, and against the sibling plans for Phases 5, 6 and 7, all three now on disk. Each finding that held was applied in the plan above.

| Lens | Findings (blocker / major / minor) | Applied | Rejected in part | Rejected |
| --- | --- | --- | --- | --- |
| Code truth | 26 (2 / 8 / 16) | 26 | 0 | 0 |
| Prompt coverage | 17 (0 / 12 / 5) | 17 | 1 | 0 |
| Safety and honesty | 29 (4 / 13 / 12) | 29 | 3 | 0 |
| Executability | 29 (1 / 16 / 12) | 29 | 0 | 0 |

Several findings appeared in more than one lens and were fixed once. These were:
* the helper processes' CPU and memory not counted (P8-2);
* the fallback words' "the results are the same" (P8-3);
* one `fallbackKind` against accumulated reasons (P8-3);
* `pauseScan`'s `deps` parameter (T1);
* the governor re-applying the process profile over a per-walk override, resolved by adopting Phase 5's `throttle_capped` (P8-9, T12);
* the band fitted and validated on the same jobs (P8-13);
* detection counted by ratio rather than by the gate's verdict (P8-13);
* the native/walker ratio's blind spot (P8-12);
* the hosted-runner label (P8-20);
* the VS Code origin (P8-10);
* the PE header (T18);
* `formatMs`'s home (P8-18);
* `SyntheticLister` and `workers_peak` (T12);
* T4 depending on plans that did not exist, now split per phase against the plans as written (T4–T7).

Task numbers changed. Old → new:
* T1–T3 keep their numbers.
* T4 → T4, T5, T6 and T7.
* T5 → T9; T6 → T10.
* T7 → T11, T12 and T13.
* T8 → T15; T9 → T16; T10 → T17; T11 → T19; T12 → T18; T13 → T20; T14 → T21; T15 → T22; T16 → T24; T17 → T25; T18 → T26.
* New: T8 (the index build), T14 (the scan boundary) and T23 (equivalence on every corpus).

Rejected findings, and the rejected parts of findings otherwise applied:
* **Safety and honesty, blocker, "Pause widens the `stillLocal` gap": the part "pause only between files" is rejected.** MP §8.5 requires a pause within 200 ms, which a large file cannot meet if a pause must wait for the file to end. The plan keeps a mid-file pause and re-checks the file's data on its open descriptor before the next chunk (P8-4, T7). The re-check after every resume and at every stage boundary is applied.
* **Safety and honesty, major, "hashing records no size or mtime; a member edited during a pause": the part "re-stat and rehash on resume" is rejected.** Phase 5's P5-6 records each file's identity (size, `mtime_ns`, `ctime_ns`) at the hasher's own stat. Its P5-1 guard re-states every survivor against the live disk immediately before any trash, so a member edited during a pause is never counted as a copy, and the other member is refused as the last copy. A second rehash mechanism would duplicate that. The plan verifies the guard for this case instead (T4's `a member edited during a pause is not a survivor`).
* **Safety and honesty, minor, "compare Origin with the bind address and loopback names, not the raw Host": this part is rejected.** In the default loopback bind, `hostGuard` runs first and has already refused any Host that is not a loopback name or the bind address, so the two comparisons are the same. Under a wildcard bind the token is required and the limit is documented. The finding's other half, stating both limits in SECURITY.md, is applied (P8-10).
* **Prompt coverage, major, "release notes": the part "fail the notes job on an unbenched figure" is rejected.** `scripts/release-notes.js` also runs to repair old tags, whose CHANGELOG entries predate the rule (5.0.0 and 5.0.1 print ms figures). The check runs as a test in `test.yml` over every entry newer than 5.0.1, which the owner's push to `main` passes before a tag exists (P8-18, T24). R39 stays open until that test is green.

## Reconciliation (25 Sep 2026)

The Phase 5, 6 and 8 plans were read side by side against the code at `d75a9af` and made to agree; the Phase 7 plan was read but not edited here (it was being revised at the same time), and what it must change was handed to its reviser. This plan's references to Phase 7 (T6: its T5 and T9; T7: its T6–T8) are to Phase 7's task numbers as they stood on 25 Sep 2026. No gate row or target moved. Changes to this plan:

* **Base.** The "Base of this plan" paragraph shared by the Phase 5, 6 and 8 plans was added.
* **The re-check after a resume is built where each job is built (P8-4, T7).** T7 would have built the mid-file descriptor re-check in `tm-hash` itself. It now belongs to Phase 5 (`HashFile::still_local()` before every chunk after the first, its P5-13, T7b and T9; the legacy finder's re-ask after resume, its T2b) and to Phase 6 (a fresh probe right before every open, its T7a; `readImageVerified`'s per-file ask, its T9a), each with its own test. T7 now cites those tests by name, adds only the cross-job test file, and builds only what a sibling plan turns out to lack, to that plan's names. What it expects follows each design: no read of an evicted file anywhere; no open where the check has no descriptor; Phase 5's native digest job may open a file and close it unread on its descriptor (its P5-7). The observer is `observeHashOpensForTests`, Phase 5's name (the plan said `observeDuplicateOpensForTests`). The tech stack and the Rust interface no longer hold a conditional `tm-hash` change.
* **Pause, Resume and Cancel for Duplicates are Phase 5's (T4).** Phase 5 T16 builds all three and pins them; T4's Step 0 cites its tests (the list was out of date: it said Phase 5 had no Resume) and T4 no longer writes a Resume test. For Similar photos the control is this plan's T5, which Phase 6 now names; T5's route details were aligned with Phase 6's (`404 NEAR_DUPLICATES_NOT_RUNNING`, `{ scanId, status, paused }`, `notDecoded`'s `largest`/`reasons`).
* **The duplicates CI row (P8-12, T17, T19).** Its A leg is `sha256-oracle`: Phase 5 T4 refuses `--finder=sha256-staged` once the pre-rewrite finder is a committed baseline. `--finder` itself is Phase 5 T0; the two-result comparability is Phase 5 T17a's exported `comparabilityDifferences(a, b, { except })`.
* **Notices (P8-17, T22).** Phase 5's generator already filters per target and unions; this plan now only makes it read its triples from `native-targets.json`, attaches the notice and adds the SPDX allow-list.
* **One job-key pattern.** The index build's budget key is `index:<jobId>`, begun and forgotten like Phase 5's `dupes:<scanId>:<minSize>` and Phase 6's `neardup:<scanId>` (P8-23, T8, with a test and a mutant).
* **A gap made visible (new P8-26, question 6).** Phase 5 deferred Eco's "pauses while another app is doing heavy I/O" (MP §8.1) to this phase, which had nothing for it. It is not built here either — it needs a measured per-platform disk-busy signal this plan does not have — and is now recorded in DESIGN §8.1, RISKS and the DoD audit's table of constraints outside §14 as "not met — owner decision", with question 6 asking the owner. The target is not redefined.
* **The crate list** in the tech stack names the crates Phases 5 and 6 add.
* **T6's deep-pass routes (from Phase 7's revision).** `POST /api/near-duplicates/{scanId}/deep/pause|resume|cancel` → `POST /api/near-duplicates/deep/pause|resume|cancel` (and `/deep/start`) with a JSON `{ scanId }` body, `200 { scanId, status, paused }`, `400 SCAN_ID_REQUIRED`, `404 DEEP_PASS_NOT_RUNNING`, `409 DEEP_PASS_NOT_ELIGIBLE` for start (Phase 7 P7-12 and its HTTP interface).
* **T6's dependencies and surfaces.** "Phase 7 T5 and T9" → "Phase 7 T5, T8b and T9" (T8b builds the routes T9's controls call); "the deep status line and badge" → "the deep status line, the `notEmbedded` line, the suggestions shown unselected", which is what Phase 7 T9 builds (it builds no badge).
* **T6's test names.** Step 0 now cites all four Phase 7 T9 tests by name, and the two "Tests first" entries drop their `deep tier: ` prefix to carry Phase 7 T9's exact names (`the model download has Cancel and no Pause`, `the deep pass has Pause, Resume and Cancel`), written in Phase 7's `tests/deepTierUi.test.ts` only if missing.
* **T7's Phase 7 task numbers.** Phase 7 split its T8 (old → new map in its review record: T8 → T8a + T8b; T3 → T3a/T3b and T4 → T4a/T4b/T4c are not cited here). "Phase 7 T6–T8 (the deep pass)" → "Phase 7 T6–T8a", since the pass and its re-check are T8a and T8b is the API. T6's citations of T5 and T9 are unchanged by the split. (This section's opening sentence records the numbers as they stood before the split.)
* **T7's file for a missing deep-pass test.** "the file Phase 7 names" → Phase 7's `tests/deepTierPass.test.ts` (its T8a).
* **T7's Step 0 citation.** "Phase 7, the deep pass: whatever test its plan names" → its T8a tests `a file evicted during a pause is never read after resume, and is counted as having left the disk` and `a file evicted during a rest is never read`.
* **T7's observer for the deep pass.** "the deep child's `opening` messages" → Phase 6's one open observer, `observeImageOpensForTests`: the revised Phase 7 child opens no file, and the parent reads every image through Phase 6's `readImageVerified` and posts the bytes (P7-15). Phase 6's plan names that observer (P6-21, its interface table and T13); Phase 5's plan does not name it (its own seam is `observeHashOpensForTests`).
