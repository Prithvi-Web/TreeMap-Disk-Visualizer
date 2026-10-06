# Track U — the owner's three problems, fixed

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Base of this plan:** main `d1def61` (30 Sep 2026). Every design and every critique behind this plan was read against that commit; `648092e`, on top of it, changed documents only. The diagnosis is `docs/engine/TRACK-U-DIAGNOSIS.md` (the diagnosis helper's `REPORT.md`, byte-identical), with its raw data in the diagnosis folder (`run1`–`run4`, `e510`). Every measured figure below is quoted from it or from a named file in that folder. A figure that is arithmetic says so. Line numbers are at `d1def61`. Phase 4's next commits (T13d, T14, T15b–T17) touch `nativeEngine.ts`, `diskScanner.ts`, `storageMode.ts` and `scanRoutes.ts`, so re-read a line before relying on it. When committed, this file becomes `docs/superpowers/plans/2026-09-30-trackU-owner-issues.md`, the name `ULTRA-ROADMAP.md` gives it.

**How it was made:** five designs were written: the index rebuild, the memory ceiling, the completion burst, whole-disk accounting, and what the owner sees. A critic checked each one against the code. This plan applies every valid critique. Where a critique offered two fixes, the plan names its choice. The one critique point that is wrong is kept out, with the reason (§ Critique record).

## Progress (kept current so a context compaction loses nothing)

| Task | State | Evidence |
| --- | --- | --- |
| Plan written | 30 Sep 2026 | this file |
| U-0 The diagnosis's instruments committed (`bench/trackU/`) | done 30 Sep 2026; review fixes 30 Sep 2026 | `tests/trackUTools.test.ts` (5 tests); mutants: the sanitizer's regex dropped, query values logged, the stall window one sample late — each red. Review round: the sanitizer cuts every absolute path (POSIX, drive, UNC, `~/`) to its top-level folder whatever it is called and walks a saved body instead of cutting JSON text; gdu-shards records a failed run by its exit, not its command line; prof names code outside `dist/` by file name (3 more tests, 10 mutants, each red) |
| U-1 No automatic index build above the threshold; none for an index that is already current; the build visible while it runs | done 30 Sep 2026; review fixes 30 Sep 2026 | `tests/indexAutoPlan.test.ts` (19 tests); the plan's 8 mutants and 6 more, each red. Step 0: `ready` does not imply a watcher; every root already carries `live`, so none was added. Review round: a capped build is written aside and swapped in only when it finishes, so a stop, cancel, failure or crash leaves the saved index as it was; the stop is remembered (`stoppedAtCap` on `status?path=`) and the next scan offers; `/result` answers a stop `409 INDEX_CAP_REACHED`; a request never inherits a tighter cap; the badge is repainted however the plan ends (`tests/indexCapAside.test.ts`, 10 tests); `#indexLine` is cleared when another folder opens from the index and is spoken once per change through `#indexAnnounce`; search's stale note no longer promises a rescan refreshes an oversized index; finishScan's hand-off of the scan's stats, the ten-second background cadence and a superseded build are pinned (43 mutants in all, each red) |
| U-2 The scan watchdog: one poll in flight, `/stats` first, a grace for the complete frame, heartbeats the page can count | done 30 Sep 2026; review fixes 30 Sep 2026 | `tests/scanWatchdog.test.ts` (12 tests), `tests/scanProgress.test.ts` (+4); the plan's 8 mutants and 3 more, each red. One change to the plan: a `/result` in flight is abandoned after 40 ticks, not 5 (it carries the whole first frame; run 3 took up to 15.8 s to serialize it). Review round: a poll aborted while its body arrives rejects as an abort, and a poll answered with nothing readable counts toward the five; the aborts on Stop and on the complete frame, and the 40-tick `/result` allowance both ways, are tested (4 more tests, 12 mutants, each red) |
| U-3 The Full Disk Access button works in the desktop app (a named bridge call) | done 2 Oct 2026 | `tests/desktopPolish.test.ts` (2 new tests: `privacySettingsUrl`'s table, and the `treemap:open-privacy-settings` handler driven through the stub — one `shell.openExternal` per ask, none for an unknown pane, a URL from the page or Windows, a rejected open answered `opened: false`; the preload test and the `window.open` denial list extended, the exact pane URL included); `tests/polishUiScan.test.ts` (2 new tests: one bridge call by name, no `window.open`, no toast; one toast in words for no bridge, an older bridge, `opened: false`, an unusable answer, a rejection and a throw; the built page holds no `x-apple` URL); 12 mutants, each red: the guard's URL for any pane, the page's string to `openExternal`, `window.open` kept (two ways), a toast after success, the preload not exposing it, a rejection unhandled, the platform ignored, a failed open reported as opened, the pane coerced to a string, `opened: false` ignored, the URL written into the page. Whether macOS 27 honours the URL is the gate's yes/no on the packaged app |
| U-4 Empty Folders never offers a folder the scan did not or could not list | done 2 Oct 2026 | Three layers. (1) **The scan's record**: a store flag, `Flag.Unlisted` (1024, Node-only, never serialized), "the tree does not hold this folder's whole listing", set where each engine knows (U-D12): the walker on a refused, unreadable, timed-out or vanished listing, on a cached folder that vanished (fast rescan), on a listing a "don't scan" pattern left entries out of, and on a listing with an entry whose stat was refused or failed (not one that vanished); the native columns ingest (and the NTFS turbo mode) on every refusal; the native memory path on its denied ids (Step 0: it names no vanished or unreadable folder, only counts them, so those rely on layer 2); gdu's mapper on `read_error`; and `settleComplete`, the one place every engine settles, marks the never-descend paths (`markUnlistedPaths`: the node, or the folder that held it where an engine dropped the node, as gdu's `-x` drops a mount point). `findEmptyFolders` reads a flagged folder as content: never offered, never counted, and no folder above it is empty. The flag, not a per-scan path set, because ids taken before `finalize()` renumbers are not stable and a flag costs no memory; **U-24 marks its not-entered mounts through the same `markUnlistedPaths` call** (hand it the scan's own never-descend list). (2) **A second look** (`services/emptyFolders.ts`, `emptyFolderCheck.ts`): every folder the answer offers is walked again on disk — not one `readdir`, as the plan wrote, but recursively, other folders and (with the junk rule) OS junk allowed, else every nested-empty or junk-only folder would be withheld; 1,000 entries, 2 s a call, 4 at a time, and the first that does not answer stops the rest (a silent drive must not take the I/O pool). One that holds something, refuses or does not answer is left out and counted in the additive `withheld`, with its nested ones out of `totalCount`. A gdu scan offers none, with the additive `reason`; a cloud scan is not looked for on this disk. (3) **Beyond the plan, at the coordinator's ask: the delete-time look**. The route did not re-check: Empty Folders' Move to Trash is `DELETE /api/files`, which trashes whatever it is given. `onlyEmptyFolders: true` (the pane sends it) looks at each path again right before its own Trash step and leaves one that is not still an empty folder in `failed[]` with `code: 'FOLDER_NOT_EMPTY'`, `refused: true`; a dry run lists them in `notEmpty`; anything but a boolean is `400 ONLY_EMPTY_FOLDERS_INVALID`; without the flag the route is unchanged. The page shows `reason` and `withheld` instead of "tidy already" and reports "no longer empty" apart from failures. openapi: `EmptyFoldersResult.withheld` (required), `.reason`, the body field, `CleanResult.failed[].code`, `TrashDryRunManifest.notEmpty`; goldens untouched. Tests: `tests/emptyFolders.test.ts` (31: 26 new — walker and native both, every record above, the second look's rules, gdu, cloud, openapi), `tests/emptyFoldersDelete.test.ts` (12), `tests/emptyFoldersUi.test.ts` (9). 45 mutants on the final code, each red (47 runs): the plan's five (predicate ignored, refused set not recorded, every childless folder hidden, backstop removed, gdu rule removed) and 40 more. Each offered folder's nested count is worked out while the tree is walked, so nothing per node is held during the second look. Every test file that imports a changed module or reads the page or AGENTS.md (190) passed, one at a time. **Not done**: the cleanup cart is unchanged (its commit protects every item in the Time Capsule first); the query grammar's `empty:yes` reads a childless node and has the same blind spot (a follow-up); `findEmptyFolders` still walks and sorts the whole store in one turn (as before; not sliced) |
| U-4b Empty Folders follow-ups (U-4's review M1, L3–L7, INFO; the review of 5a0b905, M1 and L5) | done 5 Oct 2026 | Nine commits on 51d9ea7. **M1** the second look in sessions (`emptyCheckSession`): silence remembered per drive (the mount table names the drive, `driveFor`/`driveOn`; a drive per letter or share on Windows) until the call that went silent answers, a minute after one that fails; a drive's first look goes alone; 10 s of looking a request (npm test's per-test limit under a runner); GET, dry run and `moveToTrash` one session each. **L3** the fast-rescan cache marks `"unlisted":true` (streamTreeJson `markUnlisted`) and the walker reuses no marked and no empty listing. **L4** DELETE takes `ignoreJunk` with `onlyEmptyFolders` (400 `IGNORE_JUNK_INVALID` otherwise); codes FOLDER_NOT_EMPTY / FOLDER_UNREADABLE / FOLDER_NO_ANSWER / FOLDER_TOO_MANY_ENTRIES / NOT_A_FOLDER, a toast each; audited as refusals, an entry per code. **L5** `fs.opendir`, read an entry at a time. **L6** the look's deadline is a dependency: 2 s, the hang guard under a test runner; a test lets the real timer fire. **L7** gdu's reason names Built-in walker only. **INFO** `findEmptyFolders` on three Uint8Arrays, one sweep a pass (not sliced). **Query** `empty:` leaves every childless folder of a gdu scan, or of a native scan with unnamed per-entry refusals, undecided (`degraded.emptyUnproven`); a flagged folder with a listed child is decided (L5). Tests: emptyFolderCheck (new, 7), queryEmptyUnproven (new, 5), emptyFolders (+9), emptyFoldersDelete (+12), emptyFoldersUi (+2). 56 hand mutants red (treemap-work/u4b/mutants; one equivalent mutant led to simpler code, one that changed nothing was rewritten). **Not done**: the query runs no second look of its own (its hits are the scan tree's; AGENTS.md says to trash them with `onlyEmptyFolders`); MCP `trash_paths` has no `onlyEmptyFolders`; the cleanup cart's commit does not look again (it protects every item in the Time Capsule first) |
| U-4c fixes from the U-4b reviews (U-4b reviewer M-A, M-B, L-1..L-7, INFO; coordinator M1, L1-L4, INFO) | done 5 Oct 2026 | Twelve commits on 6ab7448. **L1 (safety)** `gone` only from the folder's own stat, or its opening failing ENOENT confirmed by a fresh stat; a read's ENOENT is unreadable; `moveToTrash` never hands a gone folder to the Trash step (a stat of its own fails it as gone, one there after all is refused FOLDER_UNREADABLE); a listing is read an entry at a time (`fs.Dir`) only on a file system the mount table names as giving entry types (apfs, hfs, ext2-4, btrfs, tmpfs, zfs, f2fs, every Windows drive), else whole by `readdir`, so no stat runs on the event loop (`openListing`). **M1 = M-A, L-2** a call that misses its deadline silences its folder until it answers; the root of the drive of the folder that hung is asked, and only a root that misses too silences the drive (until the root answers); only drive errnos (EIO, ESTALE, ETIMEDOUT, ENXIO, EHOSTDOWN, ENOTCONN, EHOSTUNREACH, ENETDOWN) keep a silence a minute; every call re-checks its folder's and drive's silence before it starts. **M-B** the two budget tests inject a deadline that never passes. **L2** the fast-rescan cache name carries its format (`mtime-cache-v2-`); an older cache is never read. **L3** the drive lookup and the wait for another look count in, and are cut by, the budget; the clock is performance.now (`lookClock`). **L4** Windows drive keys normalised (separators, case, `\\?\`, `\\.\`, `\\?\UNC\`). **L-4** `emptyUnproven` only where a childless folder's verdict is maybe. **L-5** the budget running out is `out-of-time` / FOLDER_NOT_CHECKED; GET adds `withheldBy`; the toasts no longer blame a drive for TreeMap's 10 s. **L-6** a path sent twice is audited both ways (the dry-run hang-up half was not a defect: pinned). **L-7** the native columns ingest says it names its unreadable folders (`unreadableDirsNamed`), and `empty:` decides by mark there. **INFO** `findEmptyFolders` fails closed on a child numbered at or below its folder; the mount table's failure tested through `driveOn`/`filesystemOn` (`setMountTableReaderForTests`). R1, R2, R3 are tests. Hand mutants red: treemap-work/u4c/mutants (results.txt, *-red.txt); equivalent mutant removed (the session's own folder check). **Review round (5 Oct 2026, F1.1-F1.9)**: a drive holds at most two calls that did not answer (`MAX_HELD_PER_DRIVE`): with two out it is silent until one answers, root or no root, and while one is out its looks go one at a time; its root is asked by one call at a time (F1.1, F1.3, F1.8). The FOLDER_NO_ANSWER toast promises no time (F1.4). The whole-listing path is run on real folders under a table naming them nfs, and its whole read is stated as its cost (F1.5, F1.9). The sessions' and the mount table's default clock pinned to performance.now (F1.6). A listing that hangs then fails with a drive's own error keeps its silence a minute (F1.7). Old-format caches are removed as a scan completes (`legacyMtimeCaches.ts`, F1.2). Mutants red: u4c/mutants/results.txt (R2-*). **Review round 2 (5 Oct 2026, F2.1-F2.6)**: the old-cache removal rides the cache's own tracked write, so settleComplete tracks two writes again (F2.1); a call counts against its folder and its drive from the moment it starts: a folder is asked by one call at a time (a second ask waits for its answer or deadline), and a drive has at most two calls out at once, a further one waiting its turn within its budget, so one stuck folder asked twice no longer silences its drive and the bound on held threads is the documented two (F2.2, F2.4; a healthy drive is asked two calls at a time, not four); a folder withheld by the held-call cap is told so, not that the drive did not answer (F2.3); the wait on another look's root probe is tested against the budget (F2.5), and a refused old-cache removal (F2.6). Mutants red: u4c/mutants/results.txt (R3-*). **Review round 3 (5 Oct 2026, F3.1-F3.5)**: a call its own request's budget cut short keeps its folder's turn for the rest of its 2 s, waited out apart from the request, and only a call that misses the whole 2 s silences its folder and counts as held (with no budget to ask the root: only a root that hung goes silent with it), so a request waiting on that folder waits within its own budget instead of being told it did not answer, and a slow drive is not "held" by TreeMap's own budget (F3.1); the page's FOLDER_NO_ANSWER toast and no-answer pane count, openapi and AGENTS.md cover the folder never asked because its drive held two calls ("No answer came in time for N folders ... or the drive was still waiting on earlier calls", F3.2); tests now pin the turn wait's length and a waited call's wait taken when its turn comes (F3.3), a nested mount's call counted on its own drive (F3.4), and the fresh stat's LATE, SPENT and silent-drive arms (F3.5). Mutants red: u4c/mutants/results.txt (R4-*). **Not done**: a time cap on a drive whose call never answers, by decision: asking again on a timer would hold one more pool thread each time, undoing the bound, so the toast no longer promises one; the dry run applies no "gone yet there" stat of its own (it acts on nothing) |
| U-5 Opening the app runs one `ps`, not one per process | done 2 Oct 2026 | `tests/zombieHandles.test.ts` (5 new tests, counted through the runner seam: 50 holders → 1 `ps` with every pid; `/Applications/My App.app/Contents/MacOS/My App` → `/Applications/My App.app`; an absent pid → null; 1,200 pids → 3 calls of 500/500/200; macOS's exit 1 and an unstartable `ps` → every bundle null and the report still answers; none asked off macOS; the real `ps` answers the batched form; `restartProcess` still asks about its one pid, fresh). `zombieReport(deps)` takes the handles, the runner and the OS as optional seams; `docs/PLATFORM_NOTES.md` item 8 and `missingGigabytes.ts`'s note say one `ps`. 7 mutants, each red: the per-pid loop restored, the line split on whitespace, the chunk size ignored, a rejection propagated, the restart's fresh identity check skipped, an absent pid answered with an empty path, the old one-column format |
| U-6 No report-export or MCP library loaded at start | done 2 Oct 2026 | New `tests/bootModules.test.ts` (3 tests): a fresh process (`tests/fixtures/bootModulesChild.cjs`, tsx's require hook installed first) holds none of `exceljs`, `pdfmake`, `@modelcontextprotocol`, `zod` after `createApp`; one XLSX export loads `exceljs` alone, two PDF exports load `pdfmake`, and each is required by name once (memoised); the source holds it — the report libraries load only inside `loadExcel`/`getPrinter`, only `src/mcp/toolNames` (which imports nothing) is imported from outside `src/mcp`, and the MCP SDK and zod are named only there. `tests/discoverability.test.ts` reads `toolNames` and pins `/api/capabilities`' `mcp` block byte for byte (checked against the base build first). Counted: 1,196 modules in `require.cache` after `createApp` before, 319 after (same probe). 6 mutants, each red: the top-level `exceljs` import restored, `metaRoutes` pointed back at `../mcp/server`, `toolNames.ts` importing `zod`, either loader not memoised, the top-level `pdfmake` import restored. The cost moves to the first PDF or XLSX export; it is not removed |
| U-7 Index readers never serve a root that is still building; A2 never states allocation it did not measure | done 2 Oct 2026 (U-Q5 answered yes, the Windows change included) | `tests/indexReaders.test.ts` (8 tests): search over a root seeded `building` and then `error` gives none of its hits and the ready root's exactly as before, the count of a full page included; a real explicit build held at its 560th cancel poll has rows written and gives no hit, no count and no `roots` entry; `/api/allocation` and `/api/allocation/file` answer a building root `202 { status: 'building' }` and nothing else, a failed one `500 INDEX_BUILD_FAILED` as `/api/index/tree` does (U-D5: readers serve only ready and stale roots), a stale one as before; with the provider's `blocksAreMeaningful` shadowed false (the Windows answer), and for a root marked `mechanism = 'scan'` on any platform, both answer `409 ALLOCATION_NOT_MEASURED` with the plan's sentence and no number; where blocks are measured every figure is pinned against the files' own `lstat` blocks (unchanged), and on Windows the same requests are the 409; the page: its real `api()` resolves the 202 and rejects the 409, the Settings panel reads a 202 as "still building" and a 409 as "Not measured for this index." + the sentence (the owner's U-Q5 words), printing no figure for either; the tooltip grafts nothing from a 202 or a 409 and asks once. `tests/allocationAccountant.test.ts`: its figure tests skip where blocks mean nothing, and the index-seek test asserts the refusal there (run on this Mac with a preload making the provider answer as Windows': 3 pass, 10 skip, 0 fail; `indexReaders` 8 of 8 the same way). 12 mutants, each red: the state filter removed; the count query without it; the unary `+` dropped (the 500,000-row plan test reddens: the ids drive `idx_nodes_size`); the 202 removed; the file route skipping the state check; a failed root read; blocks ignored (the logical-size fallback reachable on the Windows seam); a scan-built root read as measured; the file reader skipping the refusal; the panel's 202 branch, its not-measured lead, and the tooltip's guard removed. **One change to the plan:** the search filter is `+n.root_id IN (ids of the ready and stale roots the search reports)` in the clause both queries share, not a join predicate on `r.state` — the counting query has no join, and the `+` keeps both pinned plans unchanged. Found, not fixed: `readTree`'s per-node A2 fields still carry logical size as `sharedBytes` for a hard-linked file where `allocated` is NULL (every row on Windows); and the live watcher stores `allocated` NULL for a file with 0 blocks (`> 0`, where the build keeps 0), so on macOS the accountant's fallback can still state a live-added sparse or evicted file at its logical size |
| U-8 Missing GB: an honest "Shared by copy-on-write clones" line | not started | |
| U-9 The scan's phase and walks on the record; `GET /api/scan/:id/live` (first slice); progress frames while the path moves | not started | |
| U-10 The page says the phase in plain words beside the count | not started | |
| U-11 TreeMap knows whether Full Disk Access is on and says the true thing | not started | |
| U-12 The gdu engine counts the folders it was refused (from its own log) | not started | |
| U-13 Scans a person starts run at Turbo (OD16) | done 2 Oct 2026; the A/B gate pending measurement (the coordinator's) | Rust: `Budget.auto_base` (serde default Balanced; an unknown key is refused) and `effective_preset`'s table: serious-or-worse heat → Eco, battery → Balanced on a Turbo base and Eco otherwise, else the base; manual budgets unchanged. Native contract 0.6.0 (`NativeBudget.autoBase`, the snapshot's `budget.autoBase`). Node: one process-wide auto base, Turbo while a scan the window started (`interactive`) runs and no unattended scan does, recomputed at every begin and forget (finished, stopped, evicted, shut down); the governor is reconfigured only when it moves; no per-scan preset for a person's scan, so it follows setting changes (P8-5); `/budget`'s `effective` is the snapshot's own; the record's `budget.changes` (record only, `/stats` serves its three keys; the latest 20) says when an unattended scan lowered or held a person's scan and when it rose again, only when that moves what the scan runs at. **One change to the plan:** the overlap rule counts every unattended scan, not only native ones, because a walker or gdu scan without a held preset reads the governor's duty and workers too (`dutyFor`, `workerCap`), so a Turbo process would raise it. Settings' Automatic sentence, AGENTS.md, openapi and native/README say the new rule. Tests: 5 in tm-governor (a literal table, the manual table, configure at once, two counted ticks per signal, and on macOS a running worker re-applying Turbo's class when the base rises); `tests/engineBudget.test.ts` +16 (49); `tests/engineRoutes.test.ts` +1; `tests/nativeLoader.test.ts` +2 (a 0.5.0 module refused; a real interactive scan raises the real governor's base and its end lowers it) and the refusal of a bad or misspelled base. Mutants: 7 Rust (base ignored, battery rule swapped, battery before heat, manual runs the base, configure moving no generation, start ignoring the base, unknown keys accepted) and 19 TypeScript (the plan's six among them), each red. Review round: two readers (Rust, TypeScript), no critical or high finding; the quiet refresh behind an index-first paint is not `interactive`, so it runs at Balanced and holds the base — left as the plan keys it, raised with the coordinator |
| U-14 Every `dist` build builds and checks the native module for the target it packages | done 2 Oct 2026 | `tests/checkPrebuilt.test.ts` (8 tests, headers from `tests/fixtures/binaryHeaders.ts` and this machine's own node binary), `tests/packageScripts.test.ts` (5), `tests/afterPack.test.ts` (5); the plan's 6 mutants and 21 more, each red (one first survived — an unreadable command line read as "this machine" — and a stronger test made it red). Three choices beyond the plan: `dist:win` and `dist:portable-win` pin `--x64`, because with no architecture flag electron-builder packages the machine's own, so an Apple-silicon Mac made a win-arm64 build that nothing builds a module for and gdu has no binary for; `--target <platform>` and no `--target` mean this machine's architecture and this machine, exactly as electron-builder's flags leave them, and a test holds each script's check to its own builder flags; afterPack checks the packaged copy's header and VERSION as well as the file, with the platform and architecture electron-builder hands it. Verified on a real `electron-builder --mac --dir` (offline, unsigned, `npmRebuild=false`, never launched): app.asar's header lists `native/prebuilt/darwin-arm64/treemap_core.node` unpacked and byte-identical, the packed `package.json` keeps `nativeVersion`, gdu sits at `Resources/gdu/gdu`, and `codesign --verify --deep --strict` passes with the module inside; with the module moved aside the same build exits 1 in afterPack, naming the path, before any signing. Not done here: the gate's clean clone + `npm ci && npm run dist:mac` and the packaged app's `/api/engine/capabilities` (launching the app is the owner's) |
| U-15 The walk-based index build: no per-entry map, no roll-up pass, progress on every write, the event loop turns between writes | done 2 Oct 2026; the gate's heap, stall and poll figures pending measurement | `tests/indexBuildBounds.test.ts` (9 tests) against `tests/fixtures/indexBuildOracle.ts` (e73d328's `rebuild`, `rememberCapStop` and `rollUpSizes`, verbatim): the walk numbers every entry in the order it hands it over and names its folder's number (`RawEntry.ordinal`, `parentOrdinal`, −1 for the root); on the plan's fixture (40 folders × 130 files, nested folders, a hard-link pair, a symlink, an empty folder, a hidden file, fixed stamps, plus 1,100 top-level files and 560 folders so the counts hold at any walk concurrency): 0 paths set as Map keys (the oracle sets one per entry), 0 statements reading `nodes` and 0 `UPDATE`s of it (the oracle's roll-up does both), one slot a folder in the build's per-folder columns; ceil(files/500) + ceil(folders/500) = 15 write transactions, each ≤ 500 rows, every entry written once, a progress event after each with `processed` strictly increasing, and a setImmediate ticker showing the event loop turned between every two writes; every column of every row in id order, `readTree` and nine searches equal to the oracle's (no A2 field stripped: they are equal), and a walked path that is itself a file too; held after its first write, another root's live watcher writes 50 rows (AUTOINCREMENT) with no collision, outside the range the build set aside, search serves none of the building root, and both roots read back whole; a walk past a stride of 10 stops with the sentence, writes nothing past it, and is not served; a cancel between the folder writes discards the build; a build's range starts above every id before it and the next AUTOINCREMENT id is the first above it, on a database whose nodes never had a row and on one that has. 18 mutants, each red: the plan's nine (`parentOrdinal` off by one; a file's bytes not added to its folder; a nested total not carried up; a hard link's later name counted; progress only at a full batch; the yield removed — "turns 1464 then 1464"; a read-back reintroduced; 1,000-row transactions; the id reservation removed — the watcher test fails `SQLITE_CONSTRAINT_PRIMARYKEY`) and nine more (each branch of the reservation, the stride check, the folder-write cancel check, progress counting entries instead of rows, a walked file's own bytes, an error reporting rows instead of entries, folder stamps dropped with every count equal — the row-by-row comparison names the first row — and 1,000-row transactions against `indexCapAside`'s crash premise). `tests/indexCapAside.test.ts`: its two mid-walk tests relied on the old "parent not yet inserted" flush to have rows written by the 25th cancel poll; their `sub` now holds 600 files and they look at poll 560, and the crash test asserts the build had rows written when it crashed. **Changes to the plan:** the seam is `setBuildSeamsForTests` (`afterWrite`, `onReserve`, `stride`, `onFolders`); `fastEnumerate` queues folders in the order it yields them rather than as their listings finish, so a walk's order depends on the listings alone (the oracle and the build must see one order); during a build `processed` is the rows written so far (files as the walk finds them, phase `enumerating`; folders last with their totals, phase `summing`), and an error frame's is the entries found, as before; a cancel arriving between folder writes is honoured. Known, not changed: between writes the walk's folders are only kept, so a wave of folders with no file between them is handled in one turn — its length is not measured; the prior root's delete before an explicit rebuild, the aside swap's delete and a cancel's discard are still one statement each (U-22). Review round (5 Oct 2026; no critical or high finding): a cap sets aside at most 2^32 ids — the route accepts any whole number, and a cap of 2^53 − 1 failed at once while one of 10^15 spent a ninth of the id space; removing the whole index starts the ids again from 1, so the sentence a build with no room ends with ("remove the index, then build it again") names a remedy that works; an entry handed over without a whole, non-negative number fails the build instead of being written outside its ids (3 tests, 4 mutants, each red). Known, not changed: ids past 2^32 make every index entry a byte or two wider (the cost of 2^32 ids a build); `POST /api/index/watch` can attach a watcher to a root still building (before U-15 too). Review M-1 (5 Oct 2026): a folder given as a link (`sanitizePath` keeps the caller's spelling: `~/Projects` as a link, `/tmp`) failed every build — "the folder numbered 0 was never handed over": the walk listed the link's target while the root was recorded as a file, and an explicit build had already set the saved index aside. Decided as a scan decides: no walk follows a link, the root included, so the index of a link is the link itself, one file, exactly what a scan of the same path shows (`fastEnumerate` lists its root only when it is a folder); no watcher attaches to an index of one file, since a watch on a link reports the folder it points at. A build refuses a root the walk could not list — gone, or a folder TreeMap may not open — with a sentence, before it writes or sets anything aside, so an explicit build no longer trades the saved index for an error or for an index of nothing, nor a capped one swaps an empty index in. `tests/indexBuildRoot.test.ts` (4: against a scan of the same link, explicit and capped; no watcher on the link; a folder renamed away; a folder at mode 000), 6 mutants, each red |
| U-16 Cleanup suggestions in slices, same answer, one walk per scan version | done 2 Oct 2026; review fixes 2 Oct 2026 | `tests/cleanupSlices.test.ts` (22 tests) against `tests/fixtures/cleanupOracle.ts` (bc809a2's matcher, verbatim): the sliced and drained walks equal it byte for byte, observer order included, on fuzz trees under linux, darwin and win32 folding, both stores, with ignores and notes both ways, every rule kind fired (a U+0130 location too); the shipped packs; Autopilot's selection; turns counted (`ceil(examined/16,384)`, a queued turn runs first); U-D9 (a change → 2 attempts and the changed store's answer, the observer hearing only that walk; a change on every turn → 3, the last taking no turn); one walk per version for the route, the agent summary and MCP (3 answers reused), Autopilot and the Reclaim Score's claims through the memo (claims uncapped, advisory left out); names read once, a folder's again only for a sibling-gated rule; the cost card shows it is loading at once and asks only after the three lists answer. 33 mutants, each red (the plan's 7 and 26 more). Step 0: one stale-files rule (`old-downloads`, 90 days); the clock bucket became an exact window — the walk records when a stale-files answer would next turn, so a memo hit always equals a fresh walk. The catalog is keyed by identity (one per process). Found here, fixed by U-18 (068f88d): `ObjectScanStore.wrap` left `version` undefined (NaN after an edit), so a wrapped store read as changed on every check; it now starts at 0, and since 5 Oct 2026 the pin holds a wrapped store to the built stores' 2 attempts and to one walk per version through the memo, with a second wrap of an edited tree answered from its own walk (3 mutants, each red). `polishUiScan.test.ts`'s door check now reads `const lists = loadDashboardLists(); … await lists;`. Review round (no critical or high finding; the reviewer's own 8,100-comparison differential and 3,660 window probes agreed): requests that turn a shared answer down look again and share one fresh walk; `findGitRepos` sets a repo flag only when it is not set, so opening the Clean Up pane no longer bumps `store.version` and throws the memo away; a superseded cost card settles to its empty state instead of staying on its loading state (5 more mutants, each red) |
| U-17 File types, largest files and largest folders in slices | done 2 Oct 2026: the slicing (four optimisations not built, below); review fixes 2 Oct 2026 | `tests/collectorSlices.test.ts` (6 tests) against `tests/fixtures/collectorSlicesOracle.ts` (bc809a2's three collectors, verbatim): the sliced and drained forms equal them on fuzz pairs full of size ties, before and after watcher edits (tombstones, nodes added after finalize), both stores, at limits {1, 10, 20, 500} × minimums {0, 1, 1 MiB}; the sliced file walk keeps `eachFile`'s order; turns counted per collector (`ceil(steps/16,384)`, a queued turn runs first); U-D9 through the shared driver `src/services/slices.ts`, which the cleanup walk (U-16) now runs on too: a change → 2 walks and the changed store's answer, each tally started again with its walk; a change on every turn → 3, the last taking no turn; `/api/large-files`, `/api/file-types` and `/api/large-folders` answer from the sliced walks. 15 mutants, each red (the shared driver's 4 against both slice test files). **Not built**, each an optimisation beyond the slicing on endpoints the goldens lock, while the slices alone end the stalls: the memo per (store, version, params); the bounded top-limit for largest folders with paths built only for the winners; removing the per-node `Frame`; `PackedScanStore.eachFile`/`eachNode` pushing child ranges. The agent summary, MCP `get_largest` and the report export keep the drained forms. Review round (no critical, high or medium finding): a container's ingested listing, a file root and an empty root are now in the tests (2 more mutants, each red — before them, a walk into a listing stayed green). Known, not changed: `?minSize=0` over ~600k folders still ends in one sort of every folder (~0.2 s; the page's 1 MiB default 3–18 ms) — the bounded top-limit above would remove it; `PackedScanStore.removeNode` bumps `version` before its already-removed early return (harmless today) |
| U-18 The first frame: count pass in slices, small frames built once and shared, nothing kept after sending | done 2 Oct 2026 (code and tests). **Not run: T10's 700 MB `T_mem` gate at 5M in plain Node and Electron, which the plan says blocks this commit**: it needs the owner's Mac and the Electron window, which a helper may not launch | `tests/frameBuild.test.ts` (20 tests): the plan's numbers (4,096 nodes a slice, 32 MiB, 3 attempts); three readers that arrive during a small frame's count share it (1 build, 3 frames from its chunks, each its own head and tail) and nothing is held once the last is served; a reader after a send counts again; within the cap the count holds what it gathered and past it nothing, and each reader writes from the store; a tree of exactly the cap is buffered and one character longer streamed; a count that throws fails every waiting reader, holds nothing and leaves the next count to start afresh; a reader whose socket closes during the count gets nothing while the other gets its frame; a wrapped legacy tree (`ObjectScanStore.wrap`) now starts at version 0, so a change during its count is one recount, not an endless one; a stream that ends while a too-large frame is counted gets no error frame written after its end; yields = ceil(20,000 / 4,096) and a probe queued behind the count runs before the first byte; a change on the first yield gives 2 attempts and on every yield 3, none yielding in the last, each frame the store after the change; a reader that would write from the store after a change counts again, while readers of chunks get the instant counted; once counted, no turn between the first chunk and the last; the refusal at length − 1 and length on both paths and for shared readers; through HTTP, two `/result` and the stream at once share 1 count (and past the cap each streams), the stream then `/result` count twice, and heartbeats flow while the seam holds the count and stop at its first byte. `tests/treeFrame.test.ts`: the same-turn test now states what holds (nothing is written in the turn the send begins, and once counted the frame goes out in one turn), and T9b's socket tests (backpressure, close, failure, an ended socket, a stalled reader through HTTP) run both ways, from chunks and from the store. 23 mutants, each red: single-flight removed; the version check removed; the entry kept after the count (a linger cache); the yield removed; the last attempt still yielding; the head written before the refusal; the cap ignored; the last reader not letting go; chunks dropped at the cap not let go; the slice limit ignored; a turn between chunks (each path, twice: once after the write, where the turn also lost a `drain` and the HTTP tests hung to the hang guard, once before it); a stale count written from the store; the heartbeat flag flipped at the call instead of the first byte; the cap's `>` as `>=`; a failed count keeping its chunks; the wrap without a version; the too-large error written to an ended stream; chunks, and the store pass, written to a closed socket; the store pass ignoring backpressure. An independent review of both commits found nothing critical or high; its medium and low findings are fixed here, or stated below. Above the cap the second pass is T9b's, unchanged, so an 89 MB first frame (250,000 nodes) still writes in one turn while the socket keeps up; a real socket's backpressure breaks it at each `drain`. `prunedExpansion` stays one unsliced pass a count: indicatively 11–24 ms for a 250,000-node frame over a 1.5M-node store (load 17, not a gate figure). A stream opened after the scan ended can now carry progress frames before its complete frame (shapes unchanged, P8-1) |
| U-19 The first frame honours its node budget (U-Q6) | done 2 Oct 2026 (U-Q6: yes, strict, no tolerance; U-Q8 = 250,000, so U-20 is not built) | `tests/pruneBudget.test.ts` (6 tests): on storeFuzz seeds 1–12, both stores, before and after edits, at budgets {1, 2, 7, 20, 40, 250, 20k, 250k} the bound max(maxNodes, 1 + the root's children) holds (the root alone at 1), every expanded folder is whole, sizes exact, today's JSON byte for byte wherever it fits, `prunedExpansion('none')` names `pruneStore('none')`'s folders and `pruneTree('none')` equals `pruneStore('none')`; a 300-child folder at 40 stays closed and the smaller one popped after it opens; an exact fit opens; the root's own 300 children come at 40; through the routes (`setPruneMaxNodesForTests`) a 5,000-child folder at 1,000 leaves the SSE frame and `/result` at 512 nodes; and the window's own `ensureSubtree` (lifted from the page, against the real server) opens the folder the frame left closed from `/subtree` and grafts it, which no test had covered. `tests/treeFrame.test.ts`: the frame equals `pruneStore`'s JSON under both rules. The selection oracle's `prune` lines carry the rule (1,044 cases; claims: the exact budget leaves a folder closed at 5/50/20k/250k, opens one past it at 50/20k/250k, and answers as today's rule where that fits); tm-store's `select_prune` gained `Overshoot` (4 hand-made tests, a 300,000-row folder among them); `numberingIndependence` covers the strict prunes. 23 mutants, each red: `>`→`>=`, the root not exempt, `break` for `continue` and the flag ignored, in `pruneTree`, `pruneStore` and `prunedExpansion` each; `sendPrunedTree` dropping the rule; the stream and `/result` each without `'none'`; the seam ignored; the default budget other than `PRUNE_MAX_NODES`; in Rust `>=`, the root not exempt, `break`, the flag inverted; the page's graft keeping `pruned` and `ensureSubtree` trusting a pruned node. Step 0: `readTree` already withholds a folder past the room (its start folder too) and goes on, so the instant open needed nothing. Goldens byte-identical; DESIGN §16 item 17, RISKS R82 (retired for the first frame, open for the drill-in), Phase 4 Q11, AGENTS.md and openapi updated |
| U-20 The window asks for a smaller first frame (U-Q8) | not started | |
| U-21 The index build in a worker thread | not started | |
| U-22 Replacing, discarding or removing an index off the main thread; the Remove control | in part, 5 Oct 2026 (Track U review of the index, M1): replacing and discarding never delete in one statement; removing, the worker, delete-all's unlink, VACUUM off the thread and the Remove control not started | In-thread, not in a worker: a root that is no folder's index any more — the saved root a capped build is swapped in over, the saved root an explicit rebuild replaces, a build stopped at its cap, cancelled or failed, a root left building by a process that ended — is set aside in ONE statement (`path` → `building-aside:discard:<id>`, inside the range every reader already leaves out, and `state` 'building', so a crash leaves it for the next open), inside the swap's or the first transaction where there is one; its rows are then reclaimed behind the caller, `INDEX_RECLAIM_ROWS` (1,500, ≈26 ms at the measured 17 µs a row) a statement with a turn of the event loop before each, and its roots row goes last, so `ON DELETE CASCADE` deletes nothing. The open sets every building root aside and returns; a reclaim stops quietly when its index is closed and the next open reclaims the rest. Nothing waits on a reclaim (`trackWrite`-tracked; `reclaimsSettled()` for tests); seam `setReclaimSeamsForTests` (`rows`, `beforeSlice`, `afterSlice`). A capped build never deletes the saved index before it is swapped in (U-Q4). An explicit build — no cap, a person's request — replaces it up front, as it always has (U-D3): once its folder has been found listable (review M-1), its first transaction sets the saved root aside and its rows are reclaimed while the build walks, so an explicit build that is cancelled or fails leaves the folder with no index (wording corrected by review L-4; the message of b16a8c2 says this of every build, and is history). `tests/indexReclaim.test.ts` (5): the swap deletes none of the saved rows and every reader serves the new root while they wait (search, `listRoots`, `getRoot`, `rootFor`, `readTree`); slices `[1500, 1500, 201]` for 3,201 rows, a setImmediate ticker turning between every two, the root row last; an explicit rebuild runs to its end with the saved rows held; a cap, a cancel and a failure leave the build's rows out of sight, reclaimed, and the folder's path free (a build of it succeeds at once); the open after a crash deletes no row and a build of the folder succeeds meanwhile; a reclaim cut short by a close logs nothing and the next open finishes it in slices. 10 mutants, each red (each of the four one-statement deletes restored, unbounded slices, no turn before a slice, the root row never deleted, a closed index sliced anyway, a set-aside root keeping its state, the set-aside path outside the aside range). `indexCapAside` (5 places) and `indexAutoPlan` (1) now await `reclaimsSettled()` before asserting a leftover is gone. Not changed: `deleteIndex(path)`'s one-statement delete and VACUUM (an explicit removal the person waits for; the worker and the free-space check are the rest of this task). Review L1/L2/L7 (5 Oct 2026): the swap stops the saved root's watcher and forgets its stale reason only after its transaction has committed, and an explicit rebuild only after its first one, so a swap that fails, or a rebuild that cannot begin, leaves the saved root its rows, its watcher and its reason; a discard that fails is logged, the build still ends with its own answer, and the root it left is reclaimed by the next build, a delete or the next open — never one a running build is writing; once the swap has committed nothing undoes it (a throw from the caller's progress handler left the folder with no index); a capped build swapped in over a live root hands its OS watch over, no attached or closed report. 6 tests (`indexCapAside` +4, `indexReclaim` +1, `indexWatchSet` +1), 9 mutants, each red. Review L3/L6 (5 Oct 2026): removing an index stops every build of it — the route cancels the running and the waiting jobs first, and the engine stops a running build whoever removes the index, including at a look just before the swap, so a removed index never comes back; delete-all's `removed` counts the folders' indexes, never a build written aside; a request never joins a cancelled build; at most one job waits behind a running build of a folder, a request it does not cover widening its cap, and a job that has started is never widened (the join test's chain of two waiting jobs is now one). `indexCapAside` +4 (one updated), 7 mutants, each red. Review of 5 Oct 2026, L-1: only a root no build can still be writing is reclaimed outside an open. The open reclaims every building root, as it always did; a build start and a delete reclaim only a root already set aside, one this process could not discard, or a capped build whose process (named in its aside path) is this one or has ended — never another running process's build (a development server beside the app), which had its rows deleted under it by any build or delete there. `indexReclaim` +2 (a second handle on the index file writing as another process: a live process's capped build, an explicit build, one of a process this one may not signal, one of an ended process; an explicit build whose discard failed), 7 mutants, each red. L-2: one reclaim queue — a single pump runs one slice a turn of the event loop, of the oldest reclaim, whatever the number of roots (each reclaim looping on its own ran one slice each in the same turn: six roots, about 150 ms between two polls at the real slice). `indexReclaim` +1 (three leftovers reclaimed by one open: nine slices, a turn between every two, counted with a setImmediate ticker), 2 mutants, each red. L-3: a build whose index was closed under it — a quit: the server cancels every build, then closes the index — is discarded without a word (the root still reads building, and the next open reclaims it), where every quit during a build logged a stack trace. `indexReclaim` +1 (capped and explicit), 2 mutants, each red. L-5: each reclaim slice first checks that its root is still set aside under its own id (`SELECT 1 FROM roots WHERE id = ? AND path = ?`) and stops if not, so a reclaim held across a delete-all never touches the folder's next index — roots.id is AUTOINCREMENT, and the reclaim no longer rests on that alone. `indexReclaim` +1 (delete-all with a held reclaim and a new build of the folder; again with the roots sequence set back so the new root takes the held reclaim's id), 2 mutants, each red |
| U-23 Each scan's boundary list from the mount table | done 2 Oct 2026 | `tests/scanBoundary.test.ts` (17 tests, pure, every OS) over `tests/fixtures/mountTables.ts`: the diagnosis Mac's `mount` output redacted (`mounted by someone`, the `/private/var/folders` hash a placeholder), its firmlinks, and a Linux `/proc/mounts`. 15 mutants, each red: aliases dropped; no re-spelling; `startsWith` without the separator; at-or-under for strictly-under; the catch returning `[]`; a 30 s cache; mounts added under `cross`; file mounts kept; the first `" on "` split; the API token left in the `mount` child (T-7); mounts under the fixed folders looked at (a dead one there would stall the start); a twice-listed mount point keeping its first entry; Windows answered unknown; the root's real location ignored; fixed folders above the root counted. The plan's "or its device differs" mutant has nothing to act on here, since no U-23 code reads a device; U-24's detector test holds the device rule. One choice beyond the plan: the BSD mount point is the text after the last `" on "` that a `/` follows, so a volume named "Fun on Sunday" parses as well as a nullfs source holding `" on "`. Gate replay of this Mac's live `mount` output through `scanBoundary('/')`: the reachable mounts are exactly the Clocks nullfs, the SimRuntimeBundle, `iOS_22E238` and `iOS_23F77`, and the table names no firmlinked folder (`/Volumes` is in the fixed list, as before). Review fix (5 Oct, TS review R9): a mount point's bounded stat is shared while it is still out (`boundedIsDirectory`), so a dead hard-mounted share parks one I/O thread, not one per scan start; scanBoundary.test.ts, 3 mutants red |
| U-24 Stay on this drive: walker, native and gdu stop at mount points (default: U-Q9) | done 2 Oct 2026; default `stay` (the owner's U-Q9 answer, 2 Oct) | `tests/scanBoundaryEngines.test.ts` (24 tests, an injected mount table naming a plain folder, nothing mounted): the walker, native and gdu (a recording wrapper counts its shards) under `stay` and `cross`; the not-entered count from the list and the walk's records whatever the store holds (aggregate, a store with no row for the mount); nested mounts; mounts beneath a refused or a "don't scan" folder unreached; the three incremental cases; the detector counting and never gating; snapshots, the journal, the growth alert, the forecast and Compare across a change of boundary; Live mode; Empty Folders (route included); settings; gdu refused under `cross`; the CI step. `tests/nativeEquivalence.test.ts`: (e) walker and native agree under both rules on a table-named drive (run here), (f) on a real one — macOS's hdiutil volumes, the tmpfs `.github/workflows/test.yml` now mounts on the Linux legs — for CI. `tests/edgeCases.test.ts` split by rule; its mount cases need hdiutil and run on CI (here only with the new `TREEMAP_TEST_NO_DISK_IMAGES=1` switch). Regression: the 91 files importing a changed module, 1,215 tests, 0 fail. 28 mutants, each red: the plan's 8 (processDirectory reading only the fixed list; notEntered from childless nodes; native given `neverDescendPaths()`; the gdu filter on the fixed list; the cache not keyed by the rule; the journal across rules; the watcher filter removed; nested mounts summed twice) and 20 more (the detector gating or counting a listed crossing; refusals and skips not recorded; the forecast, snapshot, Compare and growth alert across a change; Empty Folders' predicate dropped or a not-entered folder read as empty; `notListedTest` exact-only or not limited to below the root (now `exclusionsOf`, after the merge below); gdu allowed under `cross`, at the rule and at scan time; the setting trusted from a file or unchecked at the API; mounts added under `cross`; the boundary not kept on the record; the CI step removed). Choices: what a scan never listed is U-4's `Flag.Unlisted` — merged onto U-4 (5 Oct), `settleComplete` hands `markUnlistedPaths` the scan's own never-descend list (`scan.boundary.neverDescend`: the fixed folders and every drive not entered), so a not-entered drive, and the folder holding one gdu left out, are marked on every engine's tree and never offered (the earlier `notListedTest` and `collectEmptyFolders`' `notListed` argument were dropped in the merge; U-4's `setNeverDescendForTests` reaches the boundary's fixed list); the mtime cache keeps its name under `stay` and gets a new one under `cross`; a snapshot carries `boundary` only when a drive was involved, and history compares within one key (the drives left out; '' for `cross` and every scan before U-24); gdu is refused under `cross` rather than run without `-x`, because T14 Step 0 needs a real mount; Compare answers `409 BOUNDARY_CHANGED`. The index build's own walk now takes the same list (U-24i, at the end of this row); not here: U-30's projection (now on the release branch) does not yet start a new baseline at a change of boundary. Follow-up commit: comparing two snapshots (Trends, Compare, and the what's-new banner after a scan, which then says nothing rather than call a drive left out "freed") is refused across a change of boundary too, `409 BOUNDARY_CHANGED` (test and mutant red). Review fixes (5 Oct, TS review R3a/R3b/R4): the time slider's overlay (`GET /api/snapshots/tree`, no `prev` across a change), the Trends net-change strip (no delta across a change; hidden under two) and the budget gauges (each point carries its drives, narrowed to the budget folder, so `computeForecast` starts its own baseline) never compare across a change of boundary; tests in scanBoundaryEngines, fxViewWiring and budgetGauges, 6 mutants red. R6 (5 Oct): a drive mounted beneath a folder the walker or the native ingest could not list (unreadable, timed out, vanished) is recorded unreached, as beneath a refused one (`noteUnlistedBelow`); gdu and the native memory path name no such folder; tests in scanBoundaryEngines and emptyFolders, 3 mutants red. R12 (5 Oct): AGENTS.md says gdu leaves a deeper mount point out of the tree (the holder is marked not listed) and that `drivesMountedInside` also speaks for an unreadable table. Merged onto U-35 (5 Oct): the native memory path's sliced adopt no longer calls `noteRefused`, so its denied pass (`Adoption.step`) records a drive beneath a refused folder as never reached itself (`noteUnlistedBelow`); adoptOracle.ts unchanged (it calls `noteRefused`, which records the same); emptyFolders, 1 mutant red. U-24i (5 Oct 2026, the index follow-up): the index build honours the setting. `POST /api/index/build` composes the list from the folder and the setting with `scanBoundary` — the one place a scan composes its own; a build needs no scan, and a table that cannot be read leaves the fixed list — and hands it to the build (`BuildOptions.neverDescend`), whose walk leaves every path on it out, as it always left the fixed folders out (a scan shows a not-entered mount point as a childless folder; the index leaves it out: files and bytes agree, folders by one a mount). The root's live watcher drops a change at or under a path its build left out, as Live mode does (`watcher.ts`); the list is kept by index (its root's id), and `POST /api/index/watch` on an index an earlier process built composes it again from the setting. `tests/indexBoundary.test.ts` (3: `stay` and `cross` through the route; the watcher after a build; the watch route after a restart — an injected table naming a plain folder, nothing mounted), 7 mutants, each red. Not done: the Linux provider's per-folder inotify seeding still walks into a not-entered drive (its changes are dropped at the engine) |
| U-25 The scanned-root rule reads what the scan listed | done 2 Oct 2026 | `insideAnyScanRoot` (the one gate of every route AGENTS.md lists under the scanned-root rule, and of the MCP tools) holds a path inside a scan only when it lies under the scan's root and not at or beneath `exclusionsOf(scan.boundary, scan.rootPath)` — the fixed never-descend folders below the root, and the drives not entered under `stay` — unless another scan covers it; names compared folded (`foldName`), so the drive's name in another case is the drive; a record without a boundary reads the fixed list. `tests/pathGuardBoundary.test.ts` (5): `DELETE /api/files` dry runs answer 403 `OUTSIDE_SCAN_ROOT` for a file on the drive, the mount point and a file not made yet, 200 for a listed file; the shouted spelling of the drive and of a file on it (macOS); a scan of the drive itself covers it; MCP `trash_paths` refuses alike; a record of a scan of `/` refuses `/Volumes/…` (`/run/…` on Linux). 5 mutants, each red: the never-descend set ignored; another scan's cover ignored (over-refusal); names not folded (first survived — a path beneath the drive is re-spelled by realpath anyway; the test now asks about the mount point itself, the leaf no realpath re-spells); the mount point itself allowed; no fixed list for a record without a boundary. Regression: the 40 files exercising the rule, 911 tests, 0 fail. AGENTS.md: one sentence. **Independent security review (2 Oct 2026, read-only, ecc:security-reviewer): no loosening; one HIGH regression, fixed in the follow-up commit** — under `stay`, a scan of `/` lists `/System/Volumes/Data` among its mounts, and `canonicalDirOf('/System/Volumes/Data')` is `/`, so every path was refused after a whole-disk scan (F1). The gate now spells each exclusion from the scan's canonical root plus its own relative path — no file system call for an exclusion (F5) — and keeps them per scan as a set of folded prefixes (F4); a word-final sigma folds as on Windows (F7); a mount the table spells on the Data side is listed as the walk of `/` meets it (F8, U-23's `mountPointsUnder`). A drive mounted after the scan started is not in its list (F3): stated in AGENTS.md, not redesigned. Pre-existing, reported to the coordinator, unchanged: a scan rooted at `/System/Volumes/Data` canonicalises to `/` and grants the whole namespace (F2); a name beginning `..` is refused by `isInside` (F6). Tests: `pathGuardBoundary` +2 (the diagnosis Mac's real table through the gate; sigma), `scanBoundary` +1; 3 mutants for the fixes and U-25's 5 again on the new code, each red; 45 files, 1,014 tests, 0 fail. Review fix (5 Oct, TS review R8): `POST /api/facts` skips a path under a scanned root that no scan listed (absent from `values`, counted in `skipped`) instead of 403ing the batch — the Grid sends a mount point among a folder's children; a path under no scanned root is still 403 (pathGuardBoundary, 4 mutants red). Security review F6 (pre-existing, 5 Oct): `isInside` read a name that only begins with two dots (`..data`) as outside its folder; now only `..` itself leaves, and pathSanitizer's private duplicate is gone (pathGuardBoundary, 3 mutants red). Security review F2 (pre-existing, 5 Oct): a scan of `/System/Volumes/Data` (canonical root `/`) covers a path only under one of the Data volume's firmlinked folders (`/usr/share/firmlinks`, read once; unreadable grants nothing), never the sealed system volume or another volume; a scan of `/` is unchanged (pathGuardBoundary, 4 mutants red) |
| U-26 `GET /api/scan/:id/boundary`, MCP and docs | done 2 Oct 2026 (built because U-27 depends on it) | `GET /api/scan/:scanId/boundary` answers `{ scanId, rule, source, reason, notEntered, entered, crossedUnlisted, mountsListed, mounts }` from the record (`boundaryResponse`, `src/services/boundaryReport.ts`); `mounts` (at most 50, sorted) separates `reached` from `entered`, so a mount under a folder no walk descends into is not "not entered"; unknown is `null` with the reason, never an empty list; `entered.bytes` is null with a reason outside memory mode or while the scan runs. One field beyond the plan's shape: `mountsListed`, the total behind the 50-cap. Follow-up commit: a table that was read keeps its own sentence in `reason` (Windows says why it has none), lists stay known and empty (test and mutant red). `storageMode.ts` classifies it (feature `boundary`, today in every mode); openapi `ScanBoundary`; MCP `scan_path` adds `drivesMountedInside`; AGENTS.md documents the setting and the route. `tests/scanBoundaryRoute.test.ts` (10): the stay and cross shapes, the cap, `reached` under a fixed folder, an old record, an unreadable table, spill, 404, the spec matching the answer key for key, the MCP sentence. 6 mutants, each red: `[]` for an old record; the cap removed; `reached` conflated with `entered`; examples unsorted; the bytes inside entered drives dropped; the MCP sentence dropped. Regression: 27 files, 380 tests, 0 fail (goldens, discoverability, storageModeTable among them). Review fix (5 Oct, TS review R10): each mount row adds `sourceListed` (the source is a folder the scan listed: under its root, not under an exclusion; the Data volume's spelling asked too), and the Dashboard note calls a nullfs view "a folder already counted" only then — an app run from a disk image is shown again from under /Volumes; scanBoundaryRoute and mountsNoteUi, 6 mutants red |
| U-27 The Dashboard names the drives not entered; Settings holds the boundary | done 2 Oct 2026 | `#mountsNote` beside `#accessRow` (same `access-row` look, text only) is filled from `GET /api/scan/:id/boundary` by `loadBoundary` on `TOPIC.scan` — after the paint, once per scan, a stale answer dropped; `mountsNoteText` writes the plan's sentences: separate disks; a nullfs or bind mount as "a second view of a folder already counted" (or "of another folder" when its source is outside the scan); both together on a Mac like the diagnosis one; `cross`; an unreadable table (no Settings button); at most five names, then how many more; a mount under a folder no walk descends into says nothing. Settings: "Drives mounted inside a folder" with the two radios and the help line, saved on pick as `PUT /api/settings { scanBoundary }`, joined to the ⌘K palette. `tests/mountsNoteUi.test.ts` (15). Regression: the 79 files that read the built page, 1,301 tests, 0 fail; `build-ui --check` clean. 13 mutants on the built page, each red: the row never shown; always shown; the sentence written as markup; the nullfs wording lost; asked twice; a stale answer painted; the wrong key saved; the opener not rendering the rule; Change in Settings not wired; an unreadable table offering a setting; the cross sentence lost; the request moved into the paint path; the palette entry missing. Not checked here: the gate's `/browse` capture after a scan of `/` (needs the owner's Mac and its mounts) |
| U-28 Missing GB: "Drives mounted inside the scanned folder" | done 2 Oct 2026 | `mountedInside` (`mountedInsideLine`, from `boundaryReport`): under `stay` a measured 0 with the drives' count and the plan's detail; under `cross` null, the reason stating the logical total counted inside and that the allocated share is already in the sparse-file line — never a subtraction; null with the reason for a record without a boundary, an unreadable table, or a crossing the table did not list (named); every null named in Unaccounted's `includes`, and every statement balances. openapi lists the id; the page renders it as a row like any line, and a 0 or null draws no bar segment, so `140-missing-gigabytes.js` is unchanged. `tests/missingGigabytes.test.ts` (+4, 40 in all; the fixture is a real walk whose mount holds a sparse 64 MiB image). 5 mutants, each red: a `cross` line subtracting the logical bytes; null coerced to 0; the detector ignored; the `stay` count dropped; the line left off the receipt. Regression: 12 files around the statement, 0 fail. Review fix (5 Oct, TS review R11): on Windows, where no table is read, the line keeps its measured 0 but says Windows' own sentence, with `count: null`, instead of "No drive is mounted inside"; missingGigabytes (41), 2 mutants red |
| U-29 Missing GB: "On this volume, out of the scan's reach" | not started | |
| U-30 A native scan's entries projected before it walks | done 2 Oct 2026; review fixes 2 Oct 2026 | `tests/entryProjection.test.ts` (19 tests); 26 mutants on the final code, each red: the plan's ten, with its cancel-check mutant replaced by the placement mutant below, and sixteen more (the folder's first record in the file, its last, a same-time tie to the earlier-written, a timeless record read as newest, each of the four failure nets, a failure with no string form, the sum past 2^53, the statfs bound, a deadline left set, a record that is not an object, the Windows drive rule, free inodes above inodes, every inode free read as 0). **One change to the plan:** the projection is made in `startScan`'s awaited prelude, before the record exists, not inside the fire-and-forget block, so `startScan` still returns with the native walk started (`nativeEngine.test.ts`'s real-module pause test pins that, and fails with the plan's placement). The plan's "a Stop during the projection" test is therefore "startScan answers only once the projection has, with the walk started", and no cancel check is needed after it. A statfs reporting every inode free is unknown, never 0 (some FUSE mounts). Built before U-24 (every snapshot of the root counts) and without U-9 (not built in this wave). `readSnapshotRecords` gives the unchecked records; diskUsage's `STATFS_TIMEOUT_MS` is exported for the hint's bound; `setProjectionForTests` takes a projection or a function that gives one. **Follow-up (2 Oct 2026, the coordinator's request):** the history is no longer parsed at every native scan start. snapshots.ts keeps each root's newest counts in memory with the stamp of the file they came from (its id, size and times): built by one read the first time it is asked for in a process, rebuilt with no read from each history `saveSnapshot` writes, and read again only when the file changed outside the process (the MCP server, a second app, a person) — a look that fails is said, never guessed; a no-trace portable session never looks at the disk. Saves now take turns, so two scans completing together both keep their snapshot (each rewrote the whole file, and the second could drop the first's). `tests/snapshotCountsIndex.test.ts` (7 tests, counted reads of snapshots.json): native scan starts 1, 2 and 3 read it 1, 0 and 0 times; 13 mutants, each red. Not built: skipping statfs on Windows, where libuv reports no inode counts. |
| U-31 The memory store's room sized from the projection (interim until T16; U-Q15) | done 2 Oct 2026 (U-Q15 answered yes); review fixes 2 Oct 2026 | `tests/nativeMemoryProjection.test.ts` (11 tests); the plan's eight mutants and ten more, each red (18: the room not handed over by `startScan` too, the retry at the default room skipped, the retry at the same refused room, a non-finite projection read as one, `sizedBy`, the room on the plan, both `engineReason` clauses, and the native core's own refusal sentence no longer matched — two tests drive the real module into refusing a room it cannot make, so a change to that Rust text turns them red). `engineReason` says the store "was sized for N rows because …" (the plan, before the module is asked) and then any refusal; `nativePlan.room` is the planned room. U-9 is not built, so the walks are counted through the real module's pass-through and a refusal is said in `engineReason`, not recorded as a walk. **Memory, by arithmetic from the row layout (DESIGN §6: 46 B of columns a row; 128 B of names reserved a row):** a room costs 174 MB of address space per million rows reserved, none of it resident until a row is written (P4-11). What a sized room adds over the default for the same tree is its larger headroom, 1 % of the room at 110 B a row (46 B + 64 B of names): 1.1 MB per million rows of room at most — committed on Windows at the seal, untouched on POSIX until used. At 5M rows (room 10M) that is +4.1 MB against the default room's headroom, so T10's 700 MB gate at 5M is unchanged by arithmetic; at the owner's 9.1M (room 18,230,188 rows) +13.2 MB, with 3.17 GB of address space reserved against 1.09 GB. The rows themselves cost what the columns path already holds for such a tree (64–73 B a row: 0.58–0.67 GB at 9.1M), not measured above 5M. |
| U-32 P4-14 now: no restart in the built-in walker above T_mem (U-Q16) | done 2 Oct 2026 (U-Q16 answered yes); review fixes 2 Oct 2026 | `tests/nativeNoFallbackAboveTmem.test.ts` (11 tests); the plan's seven mutants and eleven more, each red (18: `>=` for both comparisons, the stall's folder not attached, the rule weighed before a Stop, the ENOENT root check after the rule, a test's `tMem` ignored, the default room no larger than `T_mem`, a trailing period kept, a reason with no string form, the stall's remedy given to every failure, the last-seen folder claimed as the one that stopped). Step 0: a "Don't scan" pattern sends the whole scan to the built-in walker (`nativeRule`), whose per-folder deadline gets it past a folder that stopped answering, at the walker's speed. Three changes to the plan: (1) test (1) uses `tMem` 900, because the 40 × 60 tree's memory walk stops at its 2,048-row ceiling with 1,001 entries counted, not 1,024 — a listing that would cross the ceiling is not counted (tm-walk `reserve`); (2) the projection case gains the margin's boundary (900 fails the scan, 800 falls back), so "P compared without 1.25 ×" can redden; (3) **the message**: TreeMap does not restart the scan in the built-in walker *on its own*, and every refusal says how to scan anyway (Scan engine › Built-in walker; for a stall, or "Don't scan" on the folder, which also hands the scan to the walker). A stall names the folder where the walk was last seen, "which may not be the folder that stopped answering": the walk samples its path when a listing starts, at most every 50 ms (tm-walk `sample_path`), so at a stall the sample is often a folder another worker finished after the stuck one was entered. Naming the stuck folder needs tm-walk to report each worker's listing in flight, a Rust change not made here. A refusal that only the projection decides says "failed on a folder whose last scan counted N items", not "part-way". The ceiling clause is dropped as planned and the invariant pinned; its edge — the default room's ceiling met below `T_mem` by one listing of more than 1,187,500 entries, or by the names' ceiling — is recorded, not handled. AGENTS.md gains the P4-14 sentence. |
| U-33 `/stats` reads the scan's own storage mode | not started | |
| U-34 `GET /api/scan/:id/storage`, first cut, in §S.6.5's names | not started | |
| U-35 Native completion without one long stall | part 1 done 2 Oct 2026; part 2 not built | `tests/nativeCompletion.test.ts` (18 tests) against a forced permutation (`forceFinalizePermutationForTests`), the object store, the one-shot adopt copied verbatim (`tests/fixtures/adoptOracle.ts`: af1bfa9's, which is dafeab4's plus U-4's `markUnlisted` on each refused folder; every store comparison reads `Flag.Unlisted` too, and the oracle is checked to mark exactly the refused folders) and, on the real module, the columns path; rows, copies, slices and turns counted, nothing timed. **finalize:** `addNode` keeps whether every node came under a parent no smaller than the one before it; on such a build `finalize` reads the child ranges off the build lists and moves no row: 0 rows permuted on 12 fuzz trees, every column through the accessors and the pruned JSON at {1, 50, 250k} equal to the forced permutation's and the object store's, before and after the watcher's edits; a walker's or a depth-first build is permuted as before (8 trees × 2 orders, every row). **`reserve(rows, nameBytes)`:** room for that many more rows and name bytes at once, never shrinking, before or after finalize; `appendName` works out a name's own UTF-8 length only where 3 bytes a unit do not fit, so a pool reserved to the byte fills to the byte (a lone surrogate 3 bytes, an emoji 4: one byte short regrows, exactly enough does not); a build of exactly its reserve regrows nothing and finalize copies nothing. **The ingest** reserves what the walk holds: on fuzz columns from four interleaved workers (10 seeds; hard-link families across folders, cloud guesses, dataless files, sparse, slack, links, `.git`, refused folders), on the edge fixture and on a 20,000-entry synthetic walk from the real module: 0 regrowths, 0 rows permuted, 0 trims past the first 1,024 rows, and the old store and record. **The adopt in slices** (`adoptNativeStoreInSlices`; text candidates, cloud candidates and refused folders, `ADOPT_SLICE_ITEMS` = 16,384 a slice; driver `src/services/scan/completionSlices.ts`): turns = ceil(items/slice), none for none, a turn queued first runs first; the record written once, after the last slice; `cloudBytes` one sum from 0 across slices (0, 1, 1, 2^53 gives 2^53 + 2) and R91's merge (2^53 + 2); a cancel after slice 2 decides two slices and writes nothing (in the turn after the last one too); `runNativeWalk` adopts in slices (one turn an item at slices of one on the edge fixture, the columns path's tree and record) and a Stop between slices leaves the record unwritten and no CPU noted; the CPU noted is the slices', not the turns'. `tests/packedStoreRelease.test.ts`' inventory gains `reserve` and `buildCountsForTests` (each throws once released) and the new plumbing. 31 mutants, each red: the plan's six (`>=` → `>`; the fast path on a build not in order; the yield removed; the cancel check removed; counters written per slice, three forms; the trim copy not skipped) and 22 more (the walk's own child ranges not advanced; the slow path uncounted; reserve's name pool doubled, not exact; appendName back to the worst-case rule; `utf8Length` under- and over-counting a surrogate, twice; the ingest not reserving, over-reserving names, one row short; `runNativeWalk` adopting in one go, going on after a cancelled adopt, not handing it the cancel; a slice one item long; the sparse guesses forgotten each slice; done read before a cancel; reserve unchecked, making no row room; the name pool trimmed when exact; text candidates undecided; a refused folder dropped; two members answering after release). **Still one turn each, for the gate to report:** `storeTake`'s hand-over, `sumSizes`, the record's `sparseTotal` (a whole-tree walk only for sparse totals past 2^53) and, on the columns path (an under-projection, MFT), the ingest and the largest folder's sort: part 2 (`ingestColumnsAsync`) is not built. **Review of 5 Oct, LOW-1:** across its slices the adopt keeps a count and the five smallest refused paths (`keepSmallest`), never every path, and adds both to the record at the end as `noteRefused` would; a record that already holds refusals is added to (new test: counts summed, the five smallest of both, at slices of 1, 7 and all, and drained); 6 mutants red (not counted, count set not added, examples replaced not merged, written per slice, the first five seen not the smallest, written when nothing was refused) and one equivalent mutant survives, as it must: keeping every path uncapped gives the same record, the bound being memory, which no test counts. **LOW-2:** the CPU noted is held by count: a clock option (`cpuUsage`, default `process.cpuUsage()`) that `runInSlices`, the adopt and `runNativeWalk`'s sum all read; on a counted clock the adopt reports exactly its hand-over, its slices and its record and none of the turns between slices, and `runNativeWalk` notes the walk's own CPU plus exactly that and the sum (7 mutants red); the real-module Stop leg counts one turn, so the scan's own cancel is shown reaching the slices after the first (3 mutants red, the cancel seen a turn late caught by that count alone); `reserve`'s two upper bounds are refused on a finalized root-only store before any room is made (2^31 rows, 2^32 name bytes: 5 mutants red, run under a 1 GB watchdog). Every adopt comparison also reads the sliced store's own `Flag.Unlisted` marks directly, not only through the flags column (review of 5 Oct, LOW-A: a mutant dropping the mark from `Adoption.step` and `Flag.Unlisted` from the compared flags at once is red) |
| U-36 On request, an index built from the scan itself (no second walk) | not started | |
| U-37 A compact first frame (conditional on the gate) | not started | |
| U-38 The clones line from Phase 5's clone evidence | blocked on Phase 5 T8 | |
| U-39 A clone census during the native walk (U-Q11) | owner-gated | |
| U-40 Plans, DESIGN, RISKS and AGENTS reconciled | done 6 Oct 2026 for what landed in 5.2.0; the amendments for tasks not built are written as instructions to those tasks | **Phase 4 plan:** the fixed interface's `disabled[]` is on `/storage`, not `/stats` (the stats are the golden `complete` frame's); T10 names U-30/U-31 as the interim; T16's instructions (keep `projectEntries`; delete `memoryRoomFor`, `RESERVE_FACTOR` and T10b's second walk; "the room is 1.25 × T_mem whatever the projection"; U-32's test widened to spill and aggregate; conversions pass `scan.boundary`); T17 and T17a for U-33/U-34 and T18 for U-36, none built; Q11 already carried U-19. **Phase 8 plan:** P8-21 built (U-23/U-24) and Q5 corrected (the simulator volumes are mounts inside the data volume) and answered (U-Q9); P8-23's "it runs after every scan" amended (U-1); T1's `ScanLive` gains `scanned`, `currentPath` and `phase`, and `entriesPerSecond` uses `passEntries` during `walk-again` (U-9 not built); T8 (`#indexLine` exists; the worker's flag and the duty by message only if U-21 lands); T9 and the stats-key count (`disabled` on `/storage`; still 30 keys); T10 (U-10's and U-11's sentences, neither built); T14 absorbed; T18's first slice is U-14. **PLAN-TAURI:** §0 point 2 (true of the SDK and zod since U-6; the server imports only `toolNames.ts`); T-4 and T-24 (`native/prebuilt`; `indexWorker.cjs` only if U-21 lands); T-7 (`mount`, the batched `ps`); T-8 (D-2 done by U-3, the guard closed, U-D16); T-26 (U-2 re-verified in WebKit and WebView2). **DESIGN:** §6.1 (the sized room; the second walk said only in `engineReason`, U-9/U-10 not built); §10 item 1 (`getattrlist` does expose clone identity, `ATTR_CMNEXT_CLONEID` with `FSOPT_ATTR_CMN_EXTENDED`, checked against the SDK's `sys/attr.h`; U-8 and U-39 not built); §12 (U-19's non-additive change); §16 (U-12 and U-36 to be recorded when they land); §5 and §16 items 17–18 already carried U-24 and U-19. **RISKS:** R95 re-rated HIGH with the diagnosis's figures (96 s of 231.7 s; the counter still 65 s and about 16 min; 88+ `/result` polls), mitigated by U-31, closed by T16; R93 notes U-19 (U-20 not built, U-37 conditional); new R121, memory mode above `T_mem` in the interim (arithmetic only); R82 already carried U-19. **AGENTS.md:** the index readers (U-7: `202` while building, `409 ALLOCATION_NOT_MEASURED`) and Missing GB's `mountedInside` line (U-28) added; the P4-14 sentence, heartbeats, `/boundary`, `scanBoundary`, `autoBuild`/`maxEntries` and the hard first-frame budget were already there; `/live`, `/storage`, the index's `scanId` and `?maxNodes` wait for U-9, U-34, U-36 and U-20. Every changed sentence was checked against the code or record it names. **Corrected 6 Oct 2026 (review F1.6):** this row and the commits bc8ebb5 and 69b539e called nine tests (safetyRails, rateLimiterLanes, nlQuery, queryUnknown, queryEmptyUnproven, facts, capsuleCapacity, fleetSync, emptyFolders) the readers of AGENTS.md; each names AGENTS.md in a comment only, and no test read its text. `tests/docsTruth.test.ts` now holds the sentences this batch changed in AGENTS.md (the engine list, the fast-rescan request, `mountedInside`, the index readers), and those it changed in PLATFORM_NOTES, DESIGN §14, RISKS R95, the README's engine paragraph and ULTRA-ROADMAP, to the code; the plans' text is still pinned by no test. The review also found the OpenAPI document described `GET /api/index/tree` with the scan's `202` body and without its `500 INDEX_BUILD_FAILED`; both now match the route. polishDocs, apiContract and storageModeTable are green |
| Track U gate | not run | § The Track U gate: U1, U2 and U3 measured on the owner's Mac on the build that ships |

**Goal:** a whole-disk scan on the owner's Mac finishes and accounts for every gigabyte, either measured or named as not measurable with the reason. It walks the disk once, shows live, honest progress the whole time, and leaves the app responsive during the scan and after it. Every fix is proven by a test that counts and by a measurement on the owner's Mac. Nothing is claimed beyond what was measured.

### The three symptoms and their measured causes

| Symptom (the owner's words) | Cause | Measured (diagnosis) | Fixed by |
| --- | --- | --- | --- |
| 1 "It wasn't able to scan my entire disk." | The counter stands still during the silent second walk past the memory ceiling, so the scan looks hung and gets stopped | 65 s (run 1), about 16 min (run 3) | U-2, U-9, U-10; U-30–U-32 remove the second walk on rescans |
| | Folders macOS protects: refused without Full Disk Access; the desktop's button does nothing; 5.1.0's gdu reported them as empty | 981 refused (946 in the walker run); gdu `deniedDirs = 0` for every shard | U-3, U-11, U-12, U-4 |
| | Totals that do not add up: mounted volumes walked, clones counted at full size, Data-root folders never walked | scanned 428.7 GB against 313.2 GB used; Unaccounted −110.2 GB; simulator volumes 627,124 + 557,410 inodes, ~35 GiB | U-8, U-23–U-29, U-38, U-39 |
| | 5.1.0: an oversized gdu shard threw and the count restarted from zero in the walker | `/private` 592.7 MB against the 450 MiB cap | U-32; U-9 names any restart |
| 2 "Scanning for a super long time." | The automatic index rebuild after every scan | 1,853 s (31 min) at load p50 18; 9.46M rows; 2.63 GB database + 364 MB WAL | U-1 (then U-15, U-21, U-22, U-36) |
| | The memory ceiling and the re-walk | walk 1 took 96 s of run 1's 231.7 s (~41 %) to reach 6,187,499 entries | U-30, U-31 |
| | Balanced for a scan a person starts | run 1 and run 3: `auto → balanced` (`stats.json`) | U-13 |
| | Mount points crossed | ~1.18M extra entries | U-24 |
| 3 "It started glitching and lagging." | The index build on the server's event loop, which is Electron's main process (`electron/main.js:43`) | 598.6 s of 1,853 s blocked (32 %): 2,744 stalls, 14 over 5 s, 3 over 20 s; `rollUpSizes` 111.0 s; flushes 40.8 s and 29.8 s; heap 3,764 MB against 4,288 MB | U-1, U-15, U-21, U-22 |
| | The completion burst | ingest 7.4 s (run 1), 11.8 s (run 3), 40.8 s (run 2); first frame 238.6 MB, 671,545 nodes against a 250,000 budget; count pass 0.75 s (load 9) to 3.6 s (load 25); the tree serialized 4× (run 3) and 8× (run 2); SSE frame abandoned at 108.9 MB; a 13.4 s stall (76 % `collectCleanupSuggestions`, 15 % `sendPrunedTree`, `run3/prof-stalls.txt`); file types 1.8 s, largest folders 1.1 s | U-2, U-16–U-20, U-35, U-37 |
| | The page parses and indexes the whole frame | `JSON.parse` 1,885 ms; `finishScan` 1,352 ms synchronous (`indexTree` 395 ms); run 2's completion one 5,184 ms long task | U-19, U-20, U-37; the gate re-measures |
| | Opening the app | `/api/zombie-handles` 0.68–1.9 s; eager loads 0.56–1.65 s | U-5, U-6 |

What is **not** the cause: during the native walks the event loop was fine (worst stall 63–243 ms), and once the map is drawn it is smooth (drill-in 32–50 ms, hover under 0.1 ms).

**Architecture:** the fixes go where the causes are, and most causes are in TypeScript that already exists.
* **The index** stops rebuilding a whole disk automatically. A build that does run writes each folder once with its total and yields between writes. It then moves into a worker thread with its own connection. Deletes and discards leave the main thread too. Readers never see a half-built root.
* **The scan's completion** becomes a set of bounded slices: the first frame's count pass, cleanup suggestions, the dashboard's collectors, and the native ingest. Each slice runs under a version guard, and a frame is never cached after it is sent (Phase 4 T9b's memory design stands).
* **Progress** keeps the SSE frame's shape (P8-1). The server repeats the unchanged `progress` frame as a heartbeat. The scan's phase and a second pass's own count live on the record and are served by the first slice of Phase 8's `GET /api/scan/:id/live`.
* **The scan boundary** comes from the mount table, the same list for every engine. What a scan of `/` cannot reach, or did not enter, becomes a named line on the Missing Gigabytes receipt.
* **Phase 4's territory** gets interim changes that T16 and T17 absorb: the memory room sized from a projection, and P4-14 applied now.
* **Phase T step 1** later moves the backend out of the window's process. These fixes still matter then, because every API request queues behind a backend stall. In run 3, `/api/snapshots` was in flight for 17,604 ms across the 13,372 ms completion stall (`run3/prof-stalls.txt`).

**Tech stack:** TypeScript strict, node:test via tsx, the zero-dependency page in `src/ui/` parts, better-sqlite3 (already a dependency), `worker_threads` (the `containerScanner.ts` precedent), Rust only in `tm-governor` (U-13), `tm-store`'s `select.rs` (U-19) and, if the owner says yes, `tm-walk` (U-39). **No new npm dependency and no new crate.**

**House rules:** Phases 4 and 8's rules apply unchanged.
* Test first, and redden every new assertion once with a recorded mutant. Every new `assert.ok` carries a message.
* Count, don't time: a wait is a hang guard, never a measurement.
* Implementers run only their own test files.
* Tests use `isolatedDataDir`, `fileTempDir` and `setTrashStepForTests`, and never touch the owner's app data or Trash.
* The page is edited only through `src/ui/` parts, and `node scripts/build-ui.js --check` must be clean.
* Rust uses the strict lint set and the cross-target checks.
* Anything a worker or child process loads is plain JS, or a `.cjs` that requires `tsx/cjs` first.
* The native handshake: a commit that changes `native/index.d.ts` bumps `nativeVersion` by one minor.
* Hardware figures are taken only on the owner's Mac. Until then they read "pending measurement".
* The agent commits; the owner pushes.
* Each task lands alone, **gated green** (the roadmap's rule: typecheck, the full `npm test`, `build:ui --check`, the cargo checks when Rust changed, every mutant recorded, the review fleet over the diff).

---

## Decisions fixed by this plan

| # | Decision | Why |
| --- | --- | --- |
| U-D1 | **Order: quick, independent wins first** (U-0 to U-8), then visibility, access, budget and packaging (U-9 to U-14), then the lag after and during completion (U-15 to U-22), then whole-disk accounting (U-23 to U-29), then Phase 4's territory (U-30 to U-35), then the later or conditional pieces (U-36 to U-40). U-30 to U-35 are interim: their tests move into T16's and T17's lists when those land, and T16 deletes what it replaces. | Ordered by what the owner feels most and by what can land without waiting. The index rebuild is the largest cause of symptoms 2 and 3, and U-1 removes it for a whole disk on its own. The owner's disk counted about 5.8M entries under 5.1.0, below the 6,187,499 ceiling, so the memory-ceiling work may not change what the owner sees there. That is why it comes after the tasks that do. |
| U-D2 | **Track U fixes go where the defect is, mostly in TypeScript.** The Tauri plan's "new backend logic goes into Rust crates" governs Phases 5–8's features, not repairs to existing code. Track U changes Rust only in U-13 (the governor's auto base), U-19 (`select_prune`'s flag, which keeps the Rust port equal to the JavaScript) and U-39 (owner-gated). Phase R later ports the rest with its groups (PLAN-TAURI §2 Q3, W1–W9). | Critique of whole-disk accounting: record the decision. A repair in the language it lives in is the smallest change that can be proven. |
| U-D3 | **The automatic index build is bounded twice.** The page's plan builds only when the scan's own count is known and ≤ `INDEX_AUTO_MAX_ENTRIES`, the existing root for exactly that path is not over it, and that root is not already current. The server also stops a build that passes the `maxEntries` the automatic request sends. **An unknown count is never read as small.** An explicit build is unchanged. | The walk that builds the index ignores the "don't scan" patterns the scan honours (`diskScanner.ts:577`), and the disk can grow between check and build. So the page's count alone is not a bound. |
| U-D4 | **The index is a cache, but an upgrade never deletes it.** There is no `SCHEMA_VERSION` bump. A root built from the scan is marked by the existing `roots.mechanism` column (`'scan'`). | Critique of the index design: a v3→v4 bump would unlink the owner's existing index on first open, against U-Q4's "never delete automatically". Phase R W2 "reads existing DBs unchanged" (PLAN-TAURI §2 Q3). |
| U-D5 | **Index readers serve only `ready` and `stale` roots. A2 never states a number it did not measure.** A `building` root answers `202`. A root whose allocation was not measured answers `409 ALLOCATION_NOT_MEASURED` with a sentence: one built from the scan, or any root on a platform whose blocks are not meaningful (Windows, `windows/index.ts:80-82`). The fallback to logical size (`allocationAccountant.ts:219-225`, `:387`) is never reached for either. | Critique: `searchIndex`'s main `SELECT` has no state predicate, and the allocation routes never check the state. So today, during a build, `/api/allocation` reports partial sums as a complete account, and Windows reports logical size as allocated. |
| U-D6 | **Explicit row ids are reserved before they are written**: `sqlite_sequence` is raised in the same transaction that inserts the root's `building` row. The stride is the build's `maxEntries + 1` when it has a cap and 2^32 otherwise. An ordinal past the stride aborts the build with a sentence. | Critique: live watchers of other roots insert with AUTOINCREMENT on the main connection (`indexEngine.ts:1194-1197`, `1359-1374`), so an unreserved `base + ordinal` collides. The stride keeps ids below 2^53 for 2^21 uncapped builds (arithmetic). |
| U-D7 | **The SSE frames keep their shape (P8-1).** A heartbeat is a repeat of the unchanged `progress` frame. The phase, the walks and a second pass's own count are on the record and are served by `/live`. The memory-ceiling design's `pass` field in the progress frame is not built. | P8-1: `/stats` and the SSE frames do not change. `sseComplete` is byte-locked, and MP §4.3 keeps the frame. `/live` is Phase 8's route for exactly this. |
| U-D8 | **The headline count never goes back** (Phase 4 T10b). When a fallback restarts the count, the phase says so in words. | 5.1.0's zeroed counter is what the owner reported. |
| U-D9 | **Work that must stay on the main thread runs in slices under a version guard**, with at most 3 attempts; the last runs in one turn. | A mutation storm then degrades to today's single stall, never a livelock (critique of the completion burst). |
| U-D10 | **A first frame is never kept after it is sent.** Only a frame under 32 MiB is built into memory at all, and only readers that arrive while it is being built share it. | Phase 4 T9b measured holding a 5M-node frame as chunks at +186 MB (reader keeping up) and +282 MB (stalled reader), against +43 MB and +207 MB for two passes. T10's 700 MB `T_mem` gate stands. After U-2 the SSE stream is normally the only reader. |
| U-D11 | **The first frame's node budget becomes hard only on the owner's answer (U-Q6)**, reopening Phase 4 Q11. `/subtree` keeps today's rule. | It changes existing JSON for trees over the budget, which is not additive (DESIGN §12, D6). |
| U-D12 | **The scan boundary comes from the mount table.** P3-3 holds: no device id gates descent. The walker's `st_dev` check only counts a crossing the table missed. What was not entered is taken from the boundary list and the walk's own records, never from "a childless node". | Firmlinks share `/`'s device (16777234) and the simulator volumes do not (16777239, 16777247), but Linux bind mounts share a device and btrfs subvolumes do not. gdu's `-x` drops the mount-point node, spill looks nodes up asynchronously, and aggregate keeps no row for a small folder. So "no node" does not mean "not reached". |
| U-D13 | **Unknown is `null` with a reason, never 0 and never a partial sum.** This covers the projection, the mount lines, the out-of-reach line, the clones line, the Full Disk Access state and the index's allocation. | Honest numbers (AGENTS.md's Missing GB rule, generalised). |
| U-D14 | **No byte figure is printed for refused folders.** | The unaccounted remainder is net of clone over-counts (macOS `getCloneFamily` returns null today), so a positive remainder can be smaller than what the refused folders hold. It bounds nothing. |
| U-D15 | **Turbo for a scan a person starts comes through the governor's own auto mode**, via a new `autoBase` preset in `tm-governor`, not a fixed per-scan override. A person's scan follows live budget changes (P8-5). **Unattended work is never raised.** Until Phase 5 P5-14's per-job cap exists, an unattended native job running at the same time holds the process at today's rule. The interactive scan's `budget.changes` records that. | `effective_preset` ignores the preset whenever auto is on (`governor.rs:519-533`), so `governorConfigure({preset:'turbo'}, true)` gives Balanced. The owner's answer to OD16 keeps background scans gentle. |
| U-D16 | **The desktop's Full Disk Access door is one named IPC call with a fixed pane→URL table.** The `window.open` guard stays closed. | The renderer never supplies a URL. This departs from T-8's wording ("the guard allows that one URL"); recorded in PLAN-TAURI by U-40. |
| U-D17 | **gdu's refusals come from its own log** (`-l`). gdu runs with `--config-file /dev/null`, so a user's `~/.gdu.yaml` cannot change what TreeMap counts. | Critique, run on the bundled v5.36.1: the export carries no refusal flag, and gdu reads `~/.gdu.yaml` (no-cross, symlinks, ignore lists). |
| U-D18 | **The interim memory room and the interim P4-14 rule use T16's own comparison**: `1.25 × P` against `T_mem`, with a measured count as a fact and the used-inode hint never as one. | When T16 lands, the scans it would put in spill are exactly the ones that are refused a legacy fallback now. P4-4a never trusts the hint as a bound. |
| U-D19 | **The scanned-root rule reads what the scan listed.** A path at or under a scan's never-descend set (the fixed list, plus the mounts not entered under "Stay") is outside that scan unless another scan covers it. The answer is `403 OUTSIDE_SCAN_ROOT`, not a new code. | Critique of whole-disk accounting: the prefix test lets `DELETE`, offload and open reach files in mounts, and in `/Volumes/*`, that a `/` scan never listed. This tightens the rule and never loosens it. |

---

## Fixed interfaces (every change is additive unless marked)

* `GET /api/index/status` (with or without `?path=`) gains `autoBuild: { maxEntries: number }`. `POST /api/index/build` accepts an optional `maxEntries` (a positive integer; anything else is `400`) and an optional `scanId` (U-36). `/api/allocation` and `/api/allocation/file` answer `202 { status: 'building' }` for a building root and `409 { code: 'ALLOCATION_NOT_MEASURED', error: <sentence> }` where allocation was not measured. **Behaviour change on Windows**: a 200 that carried logical size as allocated becomes the 409 (U-Q5).
* SSE `/api/scan/:id/progress`: the unchanged `{type:'progress', scanned, currentPath}` frame is re-sent after 14 unchanged ticks of 150 ms, until the first byte of the complete frame. A frame is also sent when `currentPath` alone changes. Keys are unchanged.
* `GET /api/scan/:scanId/live` (Phase 8 T1's route and files, `src/services/scan/liveStatus.ts` served from `src/api/engineRoutes.ts`). This first slice answers `{ scanId, status: 'running'|'complete'|'error'|'cancelled', scanned, currentPath, phase }`. `phase = { name, pass, passEntries: number|null, atLeast: number|null, reason: string|null, shard?: { index, count, path } }`. `name` is an **open set**: `walk`, `walk-again`, `shard`, `arrange` and `done` today; Phase 4 T16 adds its conversion names; a client shows an unknown name as "working". T1 later extends the answer; it never rebuilds it.
* `GET /api/scan/:scanId/boundary`: `{ scanId, rule: 'stay'|'cross'|null, source, reason, notEntered: { count, examples ≤ 5 }, entered: { count, examples, bytes: number|null, reason? }, crossedUnlisted: { count, examples }, mounts: [{ path, filesystem, source, reached, entered, bytes|null }] ≤ 50 }`. The `notEntered` shape equals Phase 8 T1's `mountsNotEntered`.
* `GET /api/scan/:scanId/storage`, T17's route, in §S.6.5's names: `{ mode, reason, transitions[], disabled[], exactness, spill: null, aggregate: null }`. In this interim, `transitions` carries the walks, and `reason` carries the projection and the room as one sentence.
* `/stats.storageMode` is read from the record, and its openapi enum becomes `['memory','spill','aggregate']`.
* Settings gain `scanBoundary: 'stay' | 'cross'`: strict at the API (`400 BAD_SETTING`), forgiving in a hand-edited file, through Phase 5's settings checklist.
* Missing GB `StatementLineId` gains `clones`, `mountedInside` and `outsideReach` (openapi `:1370` lists them).
* `/api/scan/:id/progress` and `/api/scan/:id/result` accept `?maxNodes=` (U-20; clamped to `[1, PRUNE_MAX_NODES]`, the default unchanged) and, conditionally, `?paths=derived` (U-37).
* `/api/platform/capabilities` gains `fullDiskAccess: { available, state: 'granted'|'not-granted'|'unknown', grantee, reason? }`. `available` is `true` only when the state is `granted`.
* Electron's preload gains `window.treemapDesktop.openPrivacySettings(pane)`, which resolves to `{ opened: boolean, reason? }`.
* The internal record (`ScanResult`, never in a whitelisted response) gains `phase`, `walks: { storage: 'memory'|'columns', entries, ended: 'running'|'ceiling'|'complete'|'failed'|'cancelled'|'refused', reason? }[]`, `boundary` and `nativePlan: { projection, room }`.

---

## Tasks

### U-0: The diagnosis's instruments, committed so the gate reruns them (bench) — S
**Depends on:** nothing. **Overlaps:** Phase T T-2 (process-tree sampler) and T-3 (rAF recorder) measure the window; these measure the backend and the page. Phase 4 T21's event-loop-delay column can reuse `eld.cjs`. FG4: none.
**Files:**
* Create `bench/trackU/`, holding the diagnosis tools unchanged in behaviour: `eld.cjs`, `sampler.cjs`, `run-api.cjs`, `analyze.cjs`, `prof.cjs`, `gdu-shards.cjs` and `ui-instrument.js`. Add `index-poll.cjs`, the diagnosis's shell loop rewritten to take the port and job id as arguments (the scratch copy hard-coded both).
* Create `tests/trackUTools.test.ts`.

- [ ] Tests first:
  - `run-api's sanitizer writes no path deeper than its top-level folder`: a fixture of 12 paths, including `/Users/x/y`, `/private/tmp/a` and `/Volumes/Ext/z`, plus a JSON string containing a path.
  - `eld logs query keys, never their values`.
  - `prof attributes a sample inside a stall window and none outside it`: a synthetic three-sample profile.
  - `index-poll takes its port and job id from its arguments and stops on a status other than running`.
- [ ] Mutants: the sanitizer's regex dropped; query values logged; the stall window off by one sample.
- [ ] Commit `chore(bench): the Track U diagnosis's instruments, committed so the gate reruns them`.

**Proves:** the gate measures with the diagnosis's own tools, under its own privacy rule (paths cut to their top-level folder).

### U-1: No automatic index build above the threshold, none for an index that is already current, and the build visible while it runs (TypeScript + UI) — M
**Depends on:** nothing. **Owner:** U-Q2 and U-Q3. Built with the recommended answers; each is one constant.
**Overlaps:**
* Phase 8 T8 / P8-23: its premise, "it runs after every scan", is amended by U-40. `#indexLine` is created here, and T8 adds Pause and Resume to it.
* Phase 4 T21/T22: nothing. The critique is right that counting index builds in the bench's view pass proves nothing, because the page issues the build and the bench never runs the page.
* Phase T T-2 and T-3 are gate instruments. FG4: none.

**Files:**
* `src/services/indexEngine.ts`:
  * export `INDEX_AUTO_MAX_ENTRIES = 1_000_000`.
  * `buildIndex` honours an optional `maxEntries`. Once `processed` passes it, the walk stops, the job ends `cancelled` with the sentence "stopped at M items: more than TreeMap indexes on its own", and the root is discarded through today's cancel path.
* `src/api/indexRoutes.ts`:
  * `GET /api/index/status` gains `autoBuild: { maxEntries }`.
  * `POST /api/index/build` takes an optional `maxEntries`.
  * If Step 0 finds `ready` does not imply a live watcher, each listed root gains an additive `live`.
* `src/api/openapi.ts`: both additions.
* `src/ui/app/045-persistent-live-index.js`:
  * `finishScan` keeps calling `buildIndexInBackground(root.path, stats)`, the only index identifier it references (the `polishUiScan.test.ts:220-235` injection list).
  * Inside `buildIndexInBackground`: `GET /api/index/status?path=`, then a new pure `indexAutoPlan(stats, autoBuild, exactRoot)`, where `exactRoot` is `status.root` only when `root.path === path`. It returns `'build' | 'offer' | 'none'`.
  * `'build'` requires all of: `stats.scanned` is a finite number ≤ `maxEntries`; the scan is local; `engine !== 'index'`; there is no exact root that is current; there is no exact root over the threshold. A missing count or a missing `autoBuild` gives `'none'`.
  * `'build'` POSTs with `maxEntries`.
  * A new `renderIndexLine(state)` writes `#indexLine`:
    * while a build runs: "Indexing this folder for instant opening — N items so far";
    * on `'offer'`: "Not indexed automatically — N items is more than TreeMap indexes on its own (up to M).";
    * when a build outlives the page's 600 s poll (`045:123-132`): "Still indexing in the background" instead of vanishing;
    * cleared when the build settles.
  * `renderIndexBadge`: an exact root over the threshold reads "saved <date>; not refreshed automatically" instead of "Scan again to refresh it". No byte figure: `dbBytes` covers the whole database across every root and is carried only by the status without `?path=`; U-22 adds the honest label.
* `src/ui/app/230-allocation-diagnostic.js`: "still building" only when `status.running` lists a job for that root.
* `src/ui/app/225-global-search.js`: the empty-roots note names the limit.
* `src/ui/markup/010-view-dashboard.html`: `#indexLine` under `#indexBadge`.
* Tests: create `tests/indexAutoPlan.test.ts`. Extend the injection lists that lift `buildIndexInBackground` with `indexAutoPlan` and `renderIndexLine`: `frontendContract.test.ts:900-914`, `instantOpenCounts.test.ts:89`, `polishUiScan.test.ts:220-235`. `polishUiScan.test.ts:614-640` keeps its "Scan again to refresh it." expectation for stale roots under the threshold.

- [ ] Step 0: read whether `ready` means "watcher attached continuously since the build" (the engine's rule, `indexEngine.ts:40-45`), and whether status says so. Record the answer, and add `live` if needed.
- [ ] Tests first. The page is lifted out of the built page with a stub `api()` that records every call, the frontendContract/polishUiScan pattern. All counted:
  - `scanned = M makes exactly one build request, carrying maxEntries M`.
  - `scanned = M+1 makes none, and #indexLine shows the offer sentence with both numbers`.
  - `a null, absent or NaN count, or a missing autoBuild, makes none`.
  - `engine 'index' or a cloud root makes none`.
  - `an exact root over the threshold is not rebuilt across two consecutive completions`.
  - `a legacy '/' root over the threshold does not stop a 50,000-item ~/Projects from being indexed` (1 POST: the exact-path rule).
  - `an exact root that is current is not rebuilt; the same root stale is rebuilt once`.
  - `the threshold comes from the server`: a stub with `maxEntries` 10 and `scanned` 11 gives 0 POSTs.
  - Server: `status?path= carries autoBuild.maxEntries equal to the exported constant, and every key it had before, with the same value` (a key snapshot).
  - Server: `a build past its maxEntries stops, is cancelled with the sentence, and leaves no rows and no building root` (a 130-file fixture, `maxEntries` 50).
  - Server: `maxEntries of 0, -1 or 'x' is refused with 400`.
  - `the index line shows while a build runs, says "still indexing" after the poll window, and is cleared when the build settles` (fake timers).
  - `the allocation diagnostic says "still building" only while status lists a running job` (two renders).
- [ ] Implement; `build:ui --check` clean.
- [ ] Mutants (each must turn red): `<=` → `<`; null coerced to 0; the threshold hard-coded in the page; the exact-path compare replaced by `rootFor`'s containment; the current-root skip removed; the server cap not checked; the line vanishing at the poll window; "still building" shown unconditionally.
- [ ] Commit `fix(index): no automatic index build for a folder larger than TreeMap indexes on its own, and none for an index that is already current`.

**Proves:** for the owner's whole-disk scan, removes the 1,853 s build, its 598.6 s of blocked event loop (32 %), its 2,744 stalls (3 over 20 s), the 111.0, 40.8 and 29.8 s stalls, the 3,764 MB heap, and the 2.63 GB database plus the 364 MB WAL.
**Does not** bound the stalls of automatic builds of 1M items or fewer: a stall lasts one enumeration wave, and the 40.8 s stall is about 780k rows at the measured 52 µs a row (arithmetic). U-15 follows for that.
**Gate:** a whole-disk scan through the UI flow (Browse → `/` → Scan):
* `POST /api/index/build` requests after completion = 0;
* the index's roots and row counts, read after the first open, are unchanged;
* no root is `building`;
* the backend's blocked share over the 30 minutes after completion is within the idle baseline's plus 1 point (eld);
* the heap after completion is ≤ the scan's own peak.
Recorded, not asserted: the stall when the instant paint reads an existing oversized `/` root (`readTree`'s hard-link `GROUP BY`, `indexEngine.ts:1555-1560`, over up to 2,959,196 hard-linked names on run 3's disk). The diagnosis never measured it.

### U-2: The scan watchdog — one poll in flight, `/stats` first, a grace for the complete frame, heartbeats the page can count (UI + TypeScript) — S
**Depends on:** nothing. Lands first among the frame tasks.
**Overlaps:**
* U-9 extends `progressTick` (path changes); U-10 lets the quiet tick reuse `/live`'s answer.
* Phase T T-26: WebKit's 6-connections-per-host limit, which concurrent `/result` polls would exhaust, and its hidden-window timers at 1/s. Re-verify there.
* Phase 8 T1–T3: no shape change.
* FG4: none.

**Files:**
* `src/ui/app/045-persistent-live-index.js` (`followScanProgress`).
* `src/api/scanRoutes.ts`: the `/progress` timer body at `:280-299` becomes a pure exported `progressTick(state, { scanned, currentPath, firstByteWritten })`.
* `AGENTS.md` and `src/api/openapi.ts:961`: an unchanged `progress` frame repeats about every 2 s as a heartbeat.
* Create `tests/scanWatchdog.test.ts`; extend `tests/scanProgress.test.ts`.

The page:
* (a) A `polling` flag: a tick that finds a poll in flight returns. After `IN_FLIGHT_TICKS` (5 ticks, 15 s) the tick aborts that request (`AbortController`) and counts one toward `dead`.
* (b) While the stream is open (`state.es === es && es.readyState !== EventSource.CLOSED`), a quiet tick (6 s with no message, as today) asks `GET /stats`:
  * `running` resets the grace;
  * `complete` counts one of `FRAME_GRACE_TICKS` (10 × 3 s), and only after them fetches `/result` once;
  * `error` fetches `/result` for the message (the existing path to `failScan`);
  * status 0, `BAD_RESPONSE` and 502–504 feed `dead` (five end the scan as today);
  * 404 fails the scan as expired;
  * 429 is transient.
  * The `/stats` body is reused, not asked again, so apiContract's `scanStatsFor(` count stays 2.
* (c) A closed stream goes straight to `/result`, as today.

The server re-sends the unchanged `progress` frame after `HEARTBEAT_TICKS` (14 × 150 ms ≈ 2.1 s) without a change. It keeps doing so until the first byte of the complete frame is written, including while that frame is being built.

**The trade-off, stated:** for a stream that stalls silently behind a proxy (`045:221-222`), completion is noticed up to 10 grace ticks (about 30 s) after `/stats` first says complete. Today it is noticed within one tick.
- [ ] Tests first (counted; fake `setInterval` and `EventSource`, a stub `api`):
  - `a progress message before every tick makes no request in 20 ticks`.
  - `a /stats that never settles makes one request in 10 ticks, is aborted after 5 ticks in flight, and counts toward dead`.
  - `/stats running for 30 ticks never fetches /result`.
  - `/stats complete fetches /result once, at tick 11, and never again`.
  - `a complete message during the grace ends the scan with no /result`.
  - `a closed stream fetches /result at the first tick`.
  - `a stream stuck CONNECTING over a dead server ends after five dead ticks`: the existing "five unreachable polls" test (`polishUiScan.test.ts:381-409`) stays green.
  - `/stats 404 fails as expired; ten 429s count nothing toward dead`.
  - `progressTick: 13 unchanged ticks send nothing, the 14th a heartbeat, the 28th a second, a change resets`.
  - HTTP: `a record held running streams at least 3 identical progress frames and no comment frame`.
  - `heartbeats continue while the complete frame's build is held (seam) and stop at its first byte`.
  - `HEARTBEAT_TICKS × 150 ms is below the page's 6000 ms quiet threshold`: a static read of both constants.
  - Goldens unchanged.
- [ ] Implement; `build:ui --check` clean.
- [ ] Mutants: `if (polling) return` deleted; `/result` polled instead of `/stats` while the stream is open; the grace removed; no reset after a heartbeat (one heartbeat, then silence); the tick threshold off by one; the heartbeat written as a comment again; 404 treated as transient; ticks in flight not counted.
- [ ] Commit `fix(scan): one watchdog poll in flight, the complete frame given time to arrive, and heartbeats the page counts`.

**Proves:** removes the 4× (run 3) and 8× (run 2) serializations of the 238.6 MB tree, the 88+ `/result` polls (run 3) and the SSE frame abandoned at 108.9 MB.
**Gate:**
* `GET /result` per scan = 0 while the stream is healthy, and ≤ 1 if it closed;
* exactly one complete frame received whole;
* no `EventSource` closed before it;
* `/result` requests while a second walk runs = 0. Any after it, while the ingest or the frame blocks the server, are reported under U-18 and U-35.

### U-3: The Full Disk Access button works in the desktop app (Electron + UI) — S
**Depends on:** nothing.
**Overlaps:** Phase T T-8's D-2 half is pulled forward under T-8's name (`openPrivacySettings`). T-8 keeps D-1. T-17 ports the call to the Tauri bridge. T-16's shared guard vectors keep the `x-apple` denial. T-29 moves `electron/lib`. FG4: none.
**Files:**
* `electron/lib/guards.js`: a pure `privacySettingsUrl(pane, platform)`. It returns exactly `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles` for `'full-disk-access'` on darwin, and `null` otherwise. `windowOpenDecision` is unchanged.
* `electron/preload.js`: `openPrivacySettings(pane)` → `ipcRenderer.invoke('treemap:open-privacy-settings', pane)`, documented in the contract header.
* `electron/main.js`: `ipcMain.handle('treemap:open-privacy-settings')`. It calls `shell.openExternal` only when the lookup is non-null, and answers `{ opened, reason? }`.
* `src/ui/app/045-persistent-live-index.js` (`#accessOpenBtn`): calls the bridge when it is a function. The existing toast in words appears when the bridge is absent, answers `opened: false`, or **rejects**. No `window.open`.
* Tests: `tests/desktopPolish.test.ts`, `tests/polishUiScan.test.ts`.

- [ ] Tests first:
  - `privacySettingsUrl gives the one URL for full-disk-access on macOS and nothing for any other pane, any URL, a non-string or another OS`.
  - `the privacy IPC opens System Settings exactly once, and never for a pane it does not know` (`electronStub`, `shell.openExternal` counted).
  - The existing `x-apple` `window.open` denial is unchanged.
  - Page: bridge present → 1 bridge call, 0 `window.open`, 0 toasts; bridge absent → 1 toast; `{opened:false}` → 1 toast; **a rejected promise → 1 toast**.
- [ ] Mutants: the guard returns the URL for any pane; the handler passes the page's string to `openExternal`; the page keeps `window.open`; a toast after success; the preload does not expose it; a rejection unhandled.
- [ ] Commit `fix(desktop): the Full Disk Access button opens System Settings through one named bridge call`.

**Proves:** removes the button that does nothing (PLAN-TAURI D-2; diagnosis (1)).
**Gate:** in the packaged app, after a scan of `~`, record yes or no: did System Settings open at Privacy & Security › Full Disk Access? Whether macOS 27 honours this URL is still to verify there; if it does not, the toast is the fallback, and the answer is recorded.

### U-4: Empty Folders never offers a folder the scan did not or could not list (TypeScript) — M
**Depends on:** nothing. Extended by U-12 (gdu's refused paths) and U-24 (not-entered mounts). It must land before U-24's default flips.
**Overlaps:** Phase 4 T17a's spill skip lives in the same function (kept). FG4: none.
**Files:**
* `src/services/diskScanner.ts`: `collectEmptyFolders` (`:1370`) takes a `notListed` predicate. The predicate covers the scan's never-descend set (the fixed list: `/Volumes`, `/System/Volumes`, `/dev`, …) and the per-scan sets of refused and unreadable folders.
* The sets are recorded at every choke point:
  * `noteRefused` (`src/services/scanRefusals.ts:26`);
  * the walker's unreadable site (`diskScanner.ts:1125`);
  * the native engine's (`nativeEngine.ts:390`);
  * the native memory path: Step 0 reads whether it exposes denied or unreadable ids (`nativeMemory.ts:212` gives none). If it does not, native-memory scans rely on the backstop below.
* **A gdu-engine scan offers no empty folder until U-12 lands.** The response carries an additive `reason`, and the view shows it.
* **Backstop:** each item the response returns is listed again (`readdir`, bounded by the page size, 2 s a call). An item that lists entries, refuses, or does not answer is dropped and counted in an additive `withheld`.
* `src/api/insightRoutes.ts:238` passes the predicate. The view renders `reason` and `withheld`.
* Tests: `tests/emptyFolders.test.ts`.

- [ ] Tests first:
  - `a fixed never-descend folder is never offered, and totalCount excludes it`.
  - `a mode-000 folder the walk was refused is never offered` (as root, skipped with the reason as today).
  - `a folder the walk could not read (an injected EIO) is never offered`.
  - `a genuinely empty sibling is still offered`.
  - `a native scan's refusals go through the same predicate` (stubbed module).
  - `a gdu scan offers none and says why`.
  - `an offered folder that gained a file after the scan is withheld and counted`.
- [ ] Mutants: the predicate ignored; the refused set not recorded; every childless folder hidden; the backstop removed; the gdu rule removed.
- [ ] Commit `fix(safety): Empty Folders never offers a folder the scan could not or did not list`.

**Proves:** today a scan of `/` lists `/Volumes`, `/dev`, `/System/Volumes` and every refused folder (981 on the diagnosis Mac, `~/Library/Mail` among them) as empty and offers them for the Trash. A folder the user owns but the walk could not read is not empty, and offering it is a data-loss path, even though a delete goes to the Trash.
**Gate:** `GET /api/empty-folders` for a `/` scan contains no path from `/boundary`'s list, the fixed never-descend list, or `/stats`'s refused examples.

### U-5: Opening the app runs one `ps` for every held-space process (TypeScript) — S
**Depends on:** nothing. **Overlaps:** Phase R W5 later ports platform code; U-11's refresh must not undo this (it does not re-emit `TOPIC.capabilities`). FG4: none.
**Files:**
* `src/services/zombieHandles.ts`: `executablePathsOf(pids, run = runText)`. It runs `ps -ww -o pid=,comm= -p <pid,pid,…>` in chunks of at most 500 pids and parses each line with `/^\s*(\d+)\s(.*)$/`. A pid missing from the output gives `null`. A failed `ps` gives every path `null`, and the report still answers. macOS `ps` exits 1 only when no pid matches, and that case is handled the same way.
* `restartProcess` keeps its single-pid identity check.
* The runner parameter is the seam.
* Tests: `tests/zombieHandles.test.ts`.

- [ ] Tests first: 50 processes → exactly 1 `ps` call; `/Applications/My App.app/Contents/MacOS/My App` → `/Applications/My App.app`; an absent pid → null; 1,200 pids → 3 calls; a rejecting runner → all `appBundle` null, no throw; `restartProcess` still asks about its one pid.
- [ ] Mutants: the per-pid loop restored; the line split on whitespace; the chunk size ignored; a rejection propagated.
- [ ] Commit `perf(open): the held-space card runs one ps for every process`.

**Proves:** diagnosis (3).4: a 0.68–1.9 s stall on every app open (run 3's profile puts it in `child_process.spawn` called from `executablePathOf`).
**Gate:** 5 opens of the packaged app, before and after. The spawn count is the claim (1). The largest stall while `/api/zombie-handles` is in flight is recorded.

### U-6: No report-export or MCP library loaded when the server starts (TypeScript) — S
**Depends on:** nothing.
**Overlaps:** Phase T T-4: its manifest assumes "nothing in the server imports src/mcp", which is false on main (`metaRoutes.ts:18`); this task makes it true. PLAN-TAURI OQ15 (report writers in Rust) later replaces the loaders. FG4: none.
**Files:**
* New `src/mcp/toolNames.ts`: `MCP_TOOL_NAMES`, with no imports. `src/mcp/server.ts` re-exports it, so its drift check (`:856`) holds.
* `src/api/metaRoutes.ts:18` imports from `../mcp/toolNames`.
* `src/services/reportExport.ts`: `pdfmake/src/printer` and `exceljs` behind memoised loaders called inside `streamPdf` and `streamXlsx`. Type imports stay `import type`.
* `tests/discoverability.test.ts` imports `toolNames`.
* New `tests/bootModules.test.ts`.

- [ ] Tests first:
  - In a child process (`node --import tsx -e`): after `createApp(publicDir)`, `require.cache` holds 0 keys under `node_modules/(exceljs|pdfmake|@modelcontextprotocol|zod)/`. After one XLSX export, `exceljs` is present (the lazy path is live).
  - Static: no non-type import of `exceljs` or `pdfmake/src/printer` outside the loaders; nothing outside `src/mcp` imports `mcp/server`.
  - The CSV, PDF and XLSX export tests stay green; `mcp.tools` in `/api/capabilities` is byte-identical.
- [ ] Mutants: the top-level `exceljs` import restored; `metaRoutes` pointed back at `../mcp/server`; `toolNames.ts` importing `zod`; the loader not memoised (a counted second `require`).
- [ ] Commit `perf(boot): report writers and the MCP library load when first used, not at start`.

**Proves:** diagnosis (3).4, 0.56–1.65 s of eager loading at start. **The cost moves, it is not removed:** the first PDF or XLSX export pays it.
**Gate:** 5 boots of the packaged app with eld. The module count is the claim; the largest boot stall and the time to "desktop server ready" are recorded.

### U-7: Index readers never serve a root that is still building; A2 never states allocation it did not measure (TypeScript) — S
**Depends on:** nothing. It is a prerequisite of U-15, U-22 and U-36. **Owner:** U-Q5 covers the Windows change. **Overlaps:** Phase R W2 (the rusqlite port keeps the same rules). FG4: none.
**Files:**
* `src/services/indexEngine.ts`: `searchIndex`'s main `SELECT` joins `roots r` with `r.state IN ('ready','stale')`. The early return and the scope already filter (`:1740`); the main query did not.
* `src/api/indexRoutes.ts`: `/api/allocation` (`:418`) and `/api/allocation/file` (`:442`) answer `202 { status: 'building' }` for a building root, as `/api/index/tree` does.
* `src/services/allocationAccountant.ts`: a root whose mechanism is `'scan'` (U-36), or any root on a platform whose provider's `blocksAreMeaningful` is false, answers `409 ALLOCATION_NOT_MEASURED` with the sentence "This index was built from data that does not include the blocks files occupy on disk, so TreeMap cannot say what these files occupy." No numeric field is sent.
* `src/api/openapi.ts`.
* `src/ui/app/230-allocation-diagnostic.js` renders `202` as "still building" and `409` as its sentence. `115-tooltip.js` omits the shared/exclusive line on `409`.
* Tests: `tests/indexReaders.test.ts`.

- [ ] Tests first:
  - `search returns nothing from a building root and the same hits as before from a ready one`: a `building` root seeded through `buildInternalsForTests`.
  - `the allocation routes answer 202 for a building root`.
  - `on a platform whose blocks are not meaningful, allocation answers 409 with the sentence and no number` (provider seam).
  - `on macOS the fixture's allocation figures are unchanged`.
- [ ] Mutants: the state predicate removed; the 202 check removed; the logical-size fallback reachable on the Windows seam.
- [ ] Commit `fix(index): search and the allocation panel never read a half-built index, and allocation is never guessed`.

**Proves:** removes an honest-numbers defect the design missed. During the 31-minute whole-disk build, `/api/allocation` answered partial sums as a complete account, and Windows has always shown logical size as allocated.

### U-8: Missing GB — an honest "Shared by copy-on-write clones" line (TypeScript + UI) — S
**Depends on:** nothing. **Overlaps:** Phase 5 P5-9, T2 (the `RECLAIM_CAVEATS.clonesUnknown` wording can be shared) and T8. U-38 fills the line later. FG4: none.
**Files:**
* `src/services/missingGigabytes.ts` adds `clones` to `StatementLineId`, chosen by the volume's `filesystem` (topology):
  * `apfs`, `btrfs`, `xfs`, `zfs`, `refs`, `bcachefs` or unknown → `bytes: null`, `available: false`, with the reason "the file system keeps a cloned file's blocks once however many files share them, but a folder scan reads each file's full size; TreeMap does not yet read which files are clones during a scan, so how much this over-counts is unknown";
  * `ext2/3/4`, `hfs`, `ntfs`, `fat`, `exfat` → `0`, "this file system cannot share blocks between files, so nothing is counted twice".
* The clone clause in `unaccounted`'s `includes` (`:474`) is pushed only when the line is `null`. The scanned line's note (`:404`) says the file system records clone identity and the scan does not ask for it yet.
* `src/api/openapi.ts:1370` gains the id.
* `src/ui/app/140-missing-gigabytes.js` lists the line. It nets it into "scanned" only when `bytes` is a number (U-38).
* `docs/engine/DESIGN.md` §10 item 1: "no public API on APFS exposes clone identity" is corrected. `getattrlist` with `FSOPT_ATTR_CMN_EXTENDED` returned `fork=0x308`, ext flags `0x41` and a shared clone id for a `cp -c` pair (measured by the design and again by its critic).
* Tests: `tests/missingGigabytes.test.ts`, and a UI lift test.

- [ ] Tests first: ext4 → 0 and no clone clause; APFS → null, the reason, the clause; an unknown file system → null; `assertBalances` holds; a null line is not netted into the bar.
- [ ] Mutants: the clause always pushed; APFS given 0; a null line netted.
- [ ] Commit `fix(missing-gb): the clone over-count is named as unknown where clones exist, and nowhere else`.

**Proves:** run 1's Unaccounted −110.2 GB becomes attributable. It is not reduced by this task.

### U-9: The scan's phase and walks on the record, `GET /api/scan/:id/live` (first slice), progress frames while the path moves (TypeScript) — M
**Depends on:** U-2 (`progressTick`).
**Overlaps:**
* Phase 8 T1 builds `/live` in full with the same file and test names. Its fixed `ScanLive` interface gains `scanned`, `currentPath` and `phase` (U-40 amends T1's block). T1's `entriesPerSecond` must use `passEntries` during `walk-again`, or it reads 0/s.
* Phase 4 T16 replaces the second walk with conversions and adds their phase names. T10b's count rule stays.
* The memory-ceiling design's page half is U-10.
* FG4: none.

**Files:**
* `src/models/types.ts`: the record gains `phase` and `walks` (internal).
* Writers:
  * `src/services/diskScanner.ts`: the walker is `walk` pass 1; `resetCounters` advances `pass` with the fallback's reason ("the count restarted").
  * `src/services/scan/nativeEngine.ts` `runNativeWalk`:
    * a `walks[]` entry is appended at every `scanStart` attempt and updated at each poll (`entries = 1 + progress.entries`);
    * **a refused sink creation is recorded as `ended: 'refused'` with 0 entries and does not advance `pass`**;
    * at the ceiling the phase becomes `walk-again`, with `passEntries` from the new walk, `atLeast` the held count, and the ceiling sentence as `reason`;
    * before `ingestColumns` or `adoptNativeStore` the phase becomes `arrange`, followed by one `setImmediate` yield and then `if (scan.cancelled)`, which releases any store already taken and returns.
  * `src/services/gduScanner.ts`: `shard` i+1 of n, with its path.
  * `settleComplete`: `done`.
* New `src/services/scan/liveStatus.ts`, served from `src/api/engineRoutes.ts`: this slice of `/live`. Its status uses T1's union: `cancelled` for an `error` record with `scan.cancelled`.
* `src/middleware/rateLimiter.ts`: `META_PATTERNS` (the meta lane).
* `src/services/storageMode.ts`: classified with the record-only features (never off).
* `src/api/openapi.ts`: the `ScanLive` slice. `AGENTS.md`: one line.
* `src/api/scanRoutes.ts`: `progressTick` also sends when `currentPath` alone changed. The frame's keys are unchanged, and the 150 ms timer caps the rate, which is today's maximum.
* Tests: `tests/scanLive.test.ts` (T1's file); extend `tests/nativeMemoryDefault.test.ts` and `tests/scanProgress.test.ts`.

- [ ] Tests first (counted, never timed):
  - `a re-walked native scan passes through walk(1), walk-again(2) with its reason, arrange and done, in that order` (`setMemoryRoomForTests({capRows: 2048})`, the counted poll hook).
  - `pass 2's passEntries never decreases and ends at or above atLeast`; the existing "count never goes back" test stays.
  - `a native failure that falls back is pass 2 with the fallback's reason` (a fake module whose walk throws).
  - `a gdu scan of three top-level folders reports shard 1, 2 and 3 of 3, each with its path` (the fake-gdu seam).
  - `a refused scanStart is recorded as a refused walk and does not advance the pass`: with U-31's retry, walks are `[memory refused, memory, columns]` and passes 1 and 2.
  - `a cancel during the arrange yield ends cancelled, releases the taken store and never settles` (release counted).
  - `/live answers running, complete and cancelled, and 404 SCAN_NOT_FOUND for an unknown scan`; `/live is in the meta lane`; `25 back-to-back polls are all answered`; `the storage-mode table classifies /live` (the coverage test).
  - `a running record whose path changes 3 times while its count holds streams 3 progress frames; neither changing streams only heartbeats`.
  - `tests/goldenResponses.test.ts` unmodified.
- [ ] Mutants: the phase not advanced at the ceiling; `passEntries` set from `scan.scanned`; `atLeast` left null; a fallback not advancing `pass`; a refused attempt advancing `pass`; the cancel check after the yield removed; SSE ignoring the path; the route in the api lane; `cancelled` reported as `error`; `done` never set.
- [ ] Commit `feat(scan): the scan's phase and walks on its record, served by /live, and progress frames while the path moves`.

**Proves:** the silent freeze (65 s in run 1, about 16 min in run 3) becomes observable.
**Gate:** `/live` sampled at 1 Hz during a native whole-disk scan. The count of 10-second windows during `walk` and `walk-again` in which none of `scanned`, `passEntries` or `currentPath` changed must be 0. Windows during `arrange` are reported: until U-35 slices the ingest, the server cannot answer during it. gdu shards are reported, not asserted: in 5.1.0's reproduction, `/Users` ran 72.2 s as one shard.

### U-10: The page says the phase in plain words beside the count (UI) — S
**Depends on:** U-9.
**Overlaps:**
* Phase 8 T3's readout absorbs `#scanPhase` rather than adding a second line. T10's copy test gets these sentences.
* The memory-ceiling design's third owner question is U-Q17.
* FG4: none.

**Files:**
* `src/ui/markup/010-view-dashboard.html`: `#scanPhase`, outside `#scanStatus` (P8-1's rule: `#scanStatus` is rewritten every frame).
* `src/ui/app/045-persistent-live-index.js`:
  * `followScanProgress` polls `/live` once a second, one request in flight, cleared in `endScanChrome`. **The watchdog's quiet tick reads the latest `/live` answer instead of making its own `/stats` request**, falling back to `/stats` on a 404.
  * `phaseWords(phase, engine)` writes the line.
  * During `walk-again` the rate beside the count is the pass's own rate (`passEntries` over the time since the pass's first sample). During `shard` the rate is hidden.
  * Remove the dead first definition of `quietRescanFailed` (defined twice, around `:224` and `:370`; the second wins in the concatenated page).
* Tests: `tests/secondPassUi.test.ts`.

The sentences, with every number from the server; a `null` prints no number:
* `walk-again`: "Reading the disk again to hold this many items — 1,234,567 so far; the total is at least 6,187,499."
* `shard`: "Reading /Users with gdu (7 of 16) — gdu reports a folder's count when it finishes it."
* `arrange`: "Arranging 9,115,094 items into the map."
* a restart after a fallback: "The fast engine stopped, so <the engine that ran next, in P8-3's words from the record's `engine`: the built-in walker, or gdu> is counting again from the start." The technical reason goes behind `<details>`, never inline (P8-3).
* `walk` pass 1: nothing extra.

The live region (`#scanAnnounce`) speaks a phase change once.
- [ ] Tests first:
  - each phase gives its sentence with `formatCount`'s numbers, and a null prints no digit;
  - the rate during `walk-again` is computed from `passEntries`, and is hidden during `shard`;
  - the fallback sentence names the walker only when `engine` is `walker` or `turbo-walker`, and gdu only when `gdu`;
  - the technical reason appears only inside `<details>`;
  - one `/live` request is in flight when a response takes 3 ticks;
  - while `/live` answers, the watchdog makes 0 `/stats` requests;
  - `endScanChrome` clears the line, and 0 requests follow it;
  - `#scanAnnounce` is written once per phase change;
  - `build:ui --check` is clean.
- [ ] Mutants: `passEntries` shown as the total; the rate taken from `scanned` during `walk-again`; a second poll while one is in flight; the line written into `#scanStatus`; polling not stopped; a number printed for null; the raw reason inline.
- [ ] Commit `feat(ui): the scan card says what the scan is doing when the count holds`.

**Proves:** the owner no longer presses Stop on a scan that looks hung (diagnosis (1)).
**Gate:** during a whole-disk scan that passes the ceiling, the `walk-again` sentence is visible and its count rises (a screen observation, backed by U-9's `/live` record).

### U-11: TreeMap knows whether Full Disk Access is on, and says the true thing (TypeScript + UI) — M
**Depends on:** U-3. **Owner:** U-Q12 (notice or ask) and U-Q13 (no byte figure).
**Overlaps:**
* PLAN-TAURI §8 already answers the sidecar question: Full Disk Access granted to TreeMap.app covers the sidecar when it is launched via LaunchServices. The design's "T-13 still has to find out" is removed. This probe, run in the sidecar, confirms it on the owner's Mac under Tauri.
* Phase 8 T10 adopts `accessAdvice`.
* FG4: none.

**Files:**
* New `src/platform/macos/fullDiskAccess.ts`, `probeFullDiskAccess(deps)`:
  * `opendir` then `close`, reading no entry, on **`/Library/Application Support/com.apple.TCC` first** and then `~/Library/Application Support/com.apple.TCC`. On the owner's macOS 27 the per-user folder is ENOENT and the system one refuses with EPERM without Full Disk Access (the critic checked both).
  * EPERM → `not-granted`; opened → `granted`; anything else → `unknown`, with the errno.
  * It never touches Desktop, Documents or Downloads, which raise a macOS prompt.
* New `src/utils/fdaState.ts`, with no imports: holds the last cached state for `errno.ts` and `errorHandler.ts`. This avoids the import cycle errno → capabilities → platform → base → errno.
* `src/platform/types.ts` and `capabilities.ts`: `fullDiskAccess`, probed on darwin under the existing 30 s cache. `available` is `state === 'granted'`; `unknown` is `available: false` with its reason, so `capabilitySummary` (`platformRoutes.ts:147-153`) says what it means. Other OSes: `available: false`, "a macOS setting".
* `grantee`: "TreeMap" when `process.versions.electron` or `TREEMAP_SHELL` is set; otherwise "the app that started TreeMap's server (for npm start, your terminal app)".
* One builder, `accessAdvice({ code, state, grantee })`:
  * EPERM, or a count while `not-granted` → "Give <grantee> Full Disk Access in System Settings › Privacy & Security › Full Disk Access, then <restart clause> and scan again." The restart clause is "quit and reopen TreeMap" in the desktop app, and "quit and reopen <grantee>; quitting it stops TreeMap's server, so start it again after" in web mode. **The clause stays only if the gate shows macOS needs it.**
  * EACCES, or state `granted` → "macOS, another account, or the folder's own permissions refuse TreeMap here; Full Disk Access does not change that, and TreeMap does not ask for administrator rights to read them." This is true for the owner's own chmod-000 folder too.
  * `unknown` → both.
  * The callers use it instead of their own copies: `errorHandler.ts:40`, `errno.ts:117`, `trash.ts:201`, `mediaLibraryScanner.ts:367`, `missingGigabytes.ts:878`.
* Page (`045`):
  * `renderRefusedFolders` reads the state: the hint follows it, and the button is hidden when `granted`.
  * After the button is clicked, the next `focus` or `visibilitychange` POSTs `/api/platform/capabilities/refresh` once and repaints the row from its answer **without emitting `TOPIC.capabilities`**, so `loadZombies` (`030-held-up-space.js:174`) does not run again.
  * The row gains "What's missing?", which opens the Missing view. It prints no byte figure (U-D14).
  * New `preScanAccessNotice(path)`: for `/` or the home folder when `not-granted`, the access row shows during the scan without blocking it: "macOS keeps TreeMap out of the folders it protects (Mail, Messages, Safari, the Trash), so their size will not be in this total." The button goes with it.
* Tests: `tests/fullDiskAccess.test.ts`, plus UI lift tests. The sentence pins in `polishServerErrors.test.ts` and `polishUiScan.test.ts` are updated as an intended, documented copy change.

- [ ] Tests first:
  - Probe: EPERM → not-granted; ENOENT then EPERM → not-granted; open → granted, with `close` called once and `read` 0 times; ENOENT on both → unknown, naming the errno; win32/linux → unavailable.
  - `available is false for unknown, with a reason`.
  - Grantee: Electron → TreeMap; plain Node → the terminal sentence.
  - `every server sentence about Full Disk Access comes from accessAdvice`: a source scan of `src/` outside the builder finds no "Full Disk Access in System Settings".
  - `EACCES never tells anyone to grant Full Disk Access; granted never does; not-granted always names the grantee`.
  - `the web-mode sentence says quitting stops the server`.
  - UI: the three states; the button hidden exactly when granted; the notice shown for `/` and home when not-granted, and not for `~/Projects`, not when granted, not off macOS; one refresh after focus; `TOPIC.capabilities` emitted 0 times by the refresh; "What's missing?" present with no digit.
- [ ] Mutants: EPERM read as granted; ENOENT read as not-granted; the probe order reversed (ENOENT first → unknown); an entry read inside the probe; the grantee always "TreeMap"; the hint ignoring the state; the button shown when granted; the notice on every path; `errorHandler` keeping its own sentence; the refresh emitting the topic.
- [ ] Commit `feat(access): TreeMap knows whether it has Full Disk Access and says who to grant it to and what it will not open`.

**Proves:** removes the loop of false advice and the missing warning before a whole-disk scan (diagnosis (1): 981 refused, `~/Library/Mail`, `Messages`, `Safari`, `~/.Trash` among them).
**Gate:**
* (a) Before granting: the probe says `not-granted`, and a `~` scan refuses K1 folders.
* (b) Grant through the button without relaunching: record the probe's state and a `~` rescan's refused count. This settles the restart clause.
* (c) Quit and reopen: `granted`, a rescan refuses K2 < K1, and the row offers no button.
* (d) Install a rebuilt build over the old app: record the state. This is the ad-hoc-signature question; no copy about updates is written until it has been measured.

### U-12: The gdu engine counts the folders it was refused, from gdu's own log (TypeScript) — M
**Depends on:** nothing. It lifts U-4's gdu rule.
**Owner:** OD8 (dropping gdu from the Mac app) would make this web-mode and CI only; it is built either way.
**Overlaps:** Phase 8 T1's `engineWords` sentence that gdu "mentions folders it may not open" is revised. The scan-speed area owns 5.1.0's oversized shard. FG4: none.
**Files:**
* `src/services/gduScanner.ts`:
  * `gduArgs(outFile, dir, ignoreDirs, platform, logFile)` adds `['--config-file', '/dev/null', '-l', logFile]` (gdu is never run on win32, per `gduRuleFor`).
  * After each shard the log is read, parsed and deleted with the shard JSON.
  * A missing or unreadable log adds a clause to `engineReason` ("gdu's log could not be read, so folders it was refused are not counted"), never a stats key.
* New `src/services/gduLog.ts`, `parseGduLog(text)`:
  * It decodes logrus `msg="…"` with Go's `strconv.Quote` escapes.
  * It **matches only at the start of the decoded message**: `^(open|fdopendir|readdir|readdirent|lstat) <path>: <error>$`.
  * Permission denied or operation not permitted → denied: `deniedDirs` for the directory operations, `deniedEntries` for `lstat`.
  * No such file or directory → `vanishedDirs` for a directory. A vanished file is handled by the walker's own rule, which Step 0 reads at `diskScanner.ts:1123-1125`.
  * Other errors → `unreadableDirs` or `unreadableEntries`.
  * A matching line that will not decode is counted with no example. Everything else is ignored.
  * A path already reported through the mapper's `read_error` is counted once.
* Update `tests/gduRules.test.ts:19-21`, which pins `gduArgs` byte for byte, and DESIGN §16 item 1 ("gdu reports a refused directory as an empty one").
* Tests: `tests/gduLog.test.ts`.

- [ ] Tests first:
  - The recorded v5.36.1 line (captured on the owner's Mac from the bundled binary on a chmod-000 scratch folder, path rewritten) → 1 denied, with its path.
  - `operation not permitted` → denied; `fdopendir` and `readdir` lines → denied; `lstat … permission denied` → `deniedEntries` 1; `open … no such file or directory` → vanished, not unreadable.
  - `Error reading config file: open …/.gdu.yaml: no such file or directory` → 0 (anchored), and `gduArgs` carries `--config-file /dev/null`, so the line no longer appears.
  - Gdu's always-written info lines → 0; a path with a quote and one with `\xff` → counted; a path both in `read_error` and the log → counted once; `gduArgs` carries `-l` on darwin and linux.
  - Integration (skipped with the reason on win32, as root, or with no binary; `fileTempDir`; the engine forced to gdu): one chmod-000 folder gives `deniedDirs === 1`, its path in the examples, the folder still an empty directory in the tree, and `/stats` `refused.dirs === 1`.
- [ ] Mutants: `-l` dropped; `--config-file` dropped; the match unanchored; only "permission denied" matched; `fdopendir` missing; info lines counted; ENOENT counted as unreadable; per-shard counts not summed; examples not kept; an undecodable line throwing.
- [ ] Commit `fix(gdu): folders gdu was refused are counted and named from its own log, never shown silently empty`.

**Proves:** 5.1.0's "gdu reported `deniedDirs = 0` for every shard; refused folders became silently empty". main's gdu path runs the same mapper, and the critic confirmed with the bundled v5.36.1 that the export carries no flag.
**Gate:** with Settings → Scan engine set to gdu, a scan of `~` without Full Disk Access gives `refused.dirs > 0` with examples under `Library` (0 before). The same folder with the native engine is recorded beside it.

### U-13: Scans a person starts run at Turbo (Rust + TypeScript) — M
**Depends on:** nothing.
**Owner:** U-Q1, recorded as answered yes (`ULTRA-ROADMAP.md` OD16, 30 Sep 2026: "yes turbo by default").
**Overlaps:**
* Phase 5 P5-14/T5: its per-job cap (`budgetCap: 'eco'`, `lower_of`) lets an unattended job stay at Eco while the process runs Turbo. When it lands, U-D15's overlap rule is deleted.
* Phase 8 T1/T3 (the live budget readout), T12 (Eco on unattended paths), T13 (headroom; its `max-workers.json` fixture is unaffected).
* Phase T T-11 (sleep pauses).
* The handshake bump is coordinated with Phase 4's next native change (T13d, T14 and T16 each bump; one bump per landing).
* U-14's version check.
* FG4: none.

**Files:**
* `native/treemap-core/crates/tm-governor/src/governor.rs`:
  * `Budget` gains `auto_base: Preset` (default Balanced).
  * `effective_preset` with `auto`: serious-or-worse heat → Eco; else on battery → Balanced when `auto_base` is Turbo, Eco otherwise (today's rule); else → `auto_base`.
  * `auto = false` returns the preset, as today.
* `tm-node` and `native/index.d.ts`: `NativeBudget.autoBase`. `package.json` `nativeVersion` 0.5.0 → 0.6.0.
* `src/services/engineBudget.ts`:
  * `effectiveBudget(setting, { interactive })` mirrors the table in the Node shim, which governs the walker and gdu and applies when the governor is absent.
  * The process-wide `autoBase` is Turbo while at least one interactive scan runs and no unattended native job does, and Balanced otherwise. It is recomputed at every scan start and settle (a counted reconfigure).
  * An interactive scan has **no fixed per-scan override** (P8-5: it follows live changes). The held override stays for schedule, Autopilot and fleet scans.
  * The record keeps `{ preset: 'auto', effective: 'turbo', source }`, and `budget.changes` records the overlap rule lowering it.
  * `GET /api/engine/budget` reports the snapshot's `effective` beside its `targetShare`, so the two agree.
* `src/services/diskScanner.ts:629-631`: passes `opts.interactive`.
* Tests: `tm-governor` unit tests; `tests/engineBudget.test.ts`; `tests/nativeHandshake.test.ts` (or the existing version-refusal test).

- [ ] Tests first:
  - Rust table: `auto` × `auto_base` × battery × thermal, with `auto = false` returning the preset.
  - Node: interactive + mains + nominal → turbo; battery → balanced; serious heat → eco; not interactive → balanced (battery eco, unchanged); an explicit eco, balanced or turbo always wins.
  - **Real module** (CI builds it): after an interactive scan starts, the governor snapshot's preset is `turbo`; after it settles, `balanced`.
  - An unattended native scan starting mid-way → exactly one reconfigure to Balanced, recorded in the interactive scan's `budget.changes`; when it ends → Turbo again.
  - A setting change mid-scan is followed by the interactive scan (P8-5).
  - `/api/engine/budget`'s `effective` equals the snapshot's.
  - A 0.5.0 module is refused by the 0.6.0 app.
- [ ] Mutants: `auto_base` ignored in Rust; the battery rule swapped; interactive ignored; the overlap rule removed (unattended raised to Turbo); a fixed per-scan override reintroduced for interactive scans; `/budget`'s `effective` taken from the setting.
- [ ] Commit `feat(budget): a scan you start and watch runs at Turbo on mains power; unattended work never runs above the setting`.

**Proves:** diagnosis (2) cause 3 (run 1 and run 3: `auto → balanced`).
**Gate:** an interleaved A/B of an interactive `~` scan, Balanced against Turbo on mains power, 3 pairs, through the bench harness's runner. Walk seconds, the largest event-loop stall and the window's frame count are reported. The diagnosis never measured native at Balanced against Turbo, so there is no speed-up figure until this runs. **If Turbo is not faster, or the window's frame count gets worse, the result goes to the owner before the default ships.**

### U-14: Every `dist` build builds and checks the native module for the target it packages (build) — M
**Depends on:** nothing. U-13's version bump is what makes the version check bite. **Owner:** U-Q14.
**Overlaps:**
* Phase 8 T18: this is its first slice; T18 adds every target, SHA-256, `--locked` and the release jobs.
* Phase 8 T21 proves the load path from `app.asar.unpacked`.
* PLAN-TAURI T-24's `stage-backend.js` must carry `native/prebuilt`, and T-4's manifest must not exclude it.
* FG4: none.

**Files:**
* `package.json`: every `dist`, `dist:mac|win|linux` and `dist:portable-*` script runs `npm run build:native && node scripts/check-prebuilt.js --target <platform>-<arch>` after `npm run build` and before electron-builder, with the target read from that script's own builder flags. No install, preinstall, postinstall or prepare hook is added (R34).
* New `scripts/check-prebuilt.js`. It passes only when all three hold:
  * `native/prebuilt/<target>/treemap_core.node` exists;
  * its `VERSION` equals `nativeVersion`;
  * the file's header machine (Mach-O, PE or ELF) matches the target's architecture.
  Otherwise it exits 1 with the reason.
* **A `dist` for a target other than this machine's** (`dist:win`, `dist:linux`, `dist:portable-win` on the Mac) needs that target's module on disk, from CI's release job, and fails naming the target otherwise.
* `scripts/afterPack.js`: before signing and **before its darwin-only early return**, assert that `…/resources/app.asar.unpacked/native/prebuilt/<triple>/treemap_core.node` exists, and throw with the path if it does not.
* Tests: `tests/packageScripts.test.ts`, `tests/checkPrebuilt.test.ts` (with `tests/fixtures/binaryHeaders.ts`), `tests/afterPack.test.ts`.

- [ ] Tests first:
  - `every dist script builds the module and checks it before electron-builder` (index order);
  - `dist:win on a darwin host checks win32-x64, not darwin-arm64`;
  - missing file, other `VERSION`, other architecture → exit 1; the right header and version → 0;
  - afterPack with a context lacking the module → throws naming the path, with 0 codesign calls, **for darwin, win32 and linux contexts**.
- [ ] Mutants: one `dist` script without `build:native`; the version compare skipped; the architecture check skipped; the host's architecture read instead of the target's; the afterPack check placed after the darwin return; a postinstall added.
- [ ] Commit `build(dist): every dist builds the native module and refuses to package without the target's module`.

**Proves:** diagnosis F ("a clean checkout would not [ship the module], and would scan with gdu or the walker").
**Gate:**
* A clean `git clone` of main into a scratch folder, then `npm ci && npm run dist:mac`. The packaged app's `GET /api/engine/capabilities` reports native available at the current `nativeVersion`, and a scan of a scratch folder reports engine `native`.
* With cargo removed from `PATH`, the build exits non-zero and packages nothing.

### U-15: The walk-based index build — no per-entry map, no roll-up pass, progress on every write, the event loop turns between writes (TypeScript) — M
**Depends on:** U-7.
**Overlaps:**
* Phase 8 T8's pause gate goes at this task's yield.
* Phase 4's R60 (ino as a bigint) touches the same loop; sequence the two.
* U-24's boundary: until the walk takes `scan.boundary`'s never-descend list, the index still crosses mounts (`indexEngine.ts:437`; `base.ts:104`'s `singleDevice` is unused).
* U-21 follows.
* FG4: none.

**Files:**
* `src/platform/types.ts`: `RawEntry` gains `ordinal` and `parentOrdinal` (additive; the root's parent is −1).
* `src/platform/base.ts`: `fastEnumerate` assigns them. Its concurrency and its one-lstat-at-a-time loop are unchanged: the README records that raising concurrency slows scans, and nothing here measures that trade.
* `src/services/indexEngine.ts` `rebuild`:
  * Ids are reserved as U-D6 says, and each row's id is `base + ordinal`.
  * `idByPath` and the "parent not yet inserted" flush (`:442`) are deleted.
  * Files are inserted as they are enumerated, and each file's size (0 for a later name of a hard link, as today) is added to its parent folder's running total in typed arrays indexed by folder rank.
  * Folder rows are buffered and inserted last with their final totals after one reverse pass. The root stays `building` until the end, and U-7's filters hide the gap.
  * `rollUpSizes` (`:545-573`) is deleted.
  * `onProgress` fires on every insert transaction.
  * `await yieldToLoop()` (`setImmediate`) runs after every transaction.
  * **`INDEX_BATCH_ROWS = 500`**: about 26 ms a transaction at the measured 52 µs a row (arithmetic). Today's `BATCH = 5,000` (`:343`) gives about 260 ms. The effect on the build's wall time is unmeasured and is reported by the gate.
* Tests: `tests/indexBuildBounds.test.ts`.

A roll-up in SQL was considered and not chosen. A recursive CTE re-walks each subtree (the note at `:537-544`), and a correlated `UPDATE` per folder still rewrites the folder row and its three size indexes.
- [ ] Tests first. The fixture: 40 folders × 130 files, nested folders, a hard-link pair, a symlink, an empty folder and a hidden file, **with fixed `utimes`**. It is driven through `buildInternalsForTests` and a spy on `Database.prototype.prepare`:
  - path-map entries = 0; roll-up arrays hold as many entries as there are folders;
  - statements that read `nodes` during the build = 0; `UPDATE`s on `nodes` = 0;
  - write transactions = `ceil(files/500) + ceil(dirs/500)`, each ≤ 500 rows;
  - progress events ≥ transactions, with `processed` strictly increasing. Today's code emits 0 events before `summing` on this fixture, so the test is red first;
  - a `setImmediate` counter has ticked at least (transactions − 1) times when the build resolves;
  - **another root's watcher inserting during the build**: a count-triggered seam holds the build after transaction 1 while the live path flushes 50 rows for a second root. There are 0 UNIQUE errors, the watcher's ids fall outside the reserved range, and both roots read back correctly;
  - an ordinal past the stride aborts with the sentence;
  - **equivalence against today's builder, kept in the test file as the oracle** (not a stored golden): `readTree` JSON and `searchIndex` hits are equal, with the A2 fields stripped per platform;
  - search during the build returns nothing from the building root.
- [ ] Mutants: `parentOrdinal` off by one; a file's size not added to its parent; a nested folder's total not propagated; a hard link's later name counted; progress only at a full batch; the yield removed; a read-back reintroduced; transactions of 1,000 rows; the id reservation removed (the watcher test reddens).
- [ ] Commit `perf(index): the walk-based build writes each folder once with its total, keeps no per-entry map and lets the app breathe between writes`.

**Proves:**
* removes the 111.0 s `rollUpSizes` block (88 % inside it, `run3/prof-stalls.txt`);
* removes the heap growth of about 240 B an entry (2,396 MB at 9,372,987 entries);
* removes the frozen counter (150 ten-second polls gave 55 distinct values, `run3/index-progress.txt`);
* bounds a stall to one 500-row transaction wherever the build still runs on the main thread.

**Gate:** an explicit `POST /api/index/build` of the home folder and of `/`, with eld, `--cpu-prof` and `index-poll.cjs`:
* **heap peak ≤ the idle heap + 1 GB.** The plan's arithmetic for the retained state, none of it measured: folder arrays about 42 MB (run 3's 1,051,573 folders × about 40 B), the hard-link key set of at most 2,959,196 entries (run 3's `stats.json`), and one enumeration wave's `RawEntry` buffer (about 780k entries in the largest wave, `base.ts:87-117`), about 0.5 GB in all. Today's per-entry map alone was about 2.2 GB at the measured 240 B × 9,372,987;
* no stall attributed to `rollUpSizes`;
* every 10 s poll shows a new `processed`;
* the longest stall attributed to `indexEngine` ≤ 243 ms (the native walk's own worst in the diagnosis).

### U-16: Cleanup suggestions in slices, the same answer, walked once per scan version (TypeScript + UI) — M
**Depends on:** nothing.
**Overlaps:**
* Phase 4 T18: the matcher stays a pure function of (store, args), as R-S8 requires of a FullPassRunner consumer, so the memo lives outside it. T19's aggregate 409 is unchanged.
* The index rebuild competes with these slices until U-1 lands.
* FG4: none; `reclaimInputs`' git-based recoverability is untouched.

**Files:**
* `src/services/cleanupRules.ts`:
  * The recursive `visit` (`:121-190`) becomes an explicit-stack walk in the same order, shared by `collectCleanupSuggestions` (it drains the walk) and a new pure `collectCleanupSuggestionsAsync(…, { yieldTurn, sliceNodes: 16_384 })`. The async form runs under U-D9's version guard.
  * Location rules are looked up in a Map keyed by `samePath`'s fold. The folder path is folded once per folder, and there is **no raw-length prefilter**: `toLowerCase` does not preserve length (U+0130 becomes 2 code units).
  * Each child name is decoded once, and the sibling set is built only when a `requiresSibling` rule names that child.
* New `src/services/cleanupMemo.ts`:
  * single-flight, plus the last result per (store, `store.version`, ignore patterns, suppressing note roots, catalog `schemaVersion` + packs, **clock bucket**);
  * `observe` claims (`reclaimInputs.ts:130`: every claim, uncapped, advisory rules skipped) are memoised separately.
* The clock: **Step 0** reads the stale-files rules' units in the packs. The bucket is the coarsest of them. If any rule is finer than a minute, stale-files matches are recomputed per request. This matters because `cleanupRules.ts:84` reads `Date.now()` on every call.
* Callers on a request or timer use the async form through the memo: `/cleanup/suggestions`, the agent summary, MCP `cleanup_suggestions`, Autopilot's rule match and `reclaimInputs`.
* UI (`045` `finishScan`): `loadCostEstimate()` starts after `loadDashboardLists()` resolves.
* Tests: `tests/fixtures/cleanupOracle.ts` (the pre-change implementation, copied) and `tests/cleanupSlices.test.ts`.

- [ ] Tests first:
  - Differential: on fuzz trees with every rule kind, the async and sync forms equal the oracle byte for byte, including `observe` order. The rule kinds: project directories with and without a sibling; directory; location (case-differing, darwin/win32 against linux, **and a U+0130 path**); file; stale files. Ignores and suppressing notes are covered in both containment directions.
  - `a stale-files threshold crossed between two requests in different buckets gives the fresh answer; within a bucket the same answer`.
  - **Autopilot differential**: Autopilot's selection through the rewritten matcher equals the oracle's on fuzz trees.
  - yields = `ceil(visited/16,384)`; a queued probe runs before the walk resolves.
  - two concurrent requests → 1 walk; `setSize` → a second walk; a changed ignore list → a second walk.
  - a mutation during the walk → a restart, with the final store's answer.
  - UI: the suggestions and cost calls come after the three list calls.
  - The existing `cleanupRules`, `cleanupRulesQuery`, `cleanUpModalHonesty` and `apiContract` tests stay green.
- [ ] Mutants: the fold gate wrong (the U+0130 location missed); siblings never built; the memo key without version, or without the clock bucket; the yield removed; siblings visited before descending; the cost call moved back before the lists.
- [ ] Commit `perf(cleanup): suggestions are walked in slices, once per scan version, with the same answer`.

**Proves:** about 10 s of the 13.4 s stall (76 % inclusive in `run3/prof-stalls.txt`; the other 15 % was `sendPrunedTree` from concurrent `/result` frames, which U-2 removes), and the duplicate walks from the cost card and the tour.
**Gate:** the largest eld stall while the dashboard, the cost card and the tour load after a whole-disk scan ≤ 243 ms; suggestion walks per scan version = 1; time-to-answer reported.

### U-17: File types, largest files and largest folders in slices (TypeScript) — M
**Depends on:** nothing. **Overlaps:** Phase 4 T15's numbering-independence battery and T18's FullPassRunner (the async signatures are the ones it implements). FG4: none.
**Files:**
* `src/services/diskScanner.ts`: `collectFileTypesAsync`, `collectLargestFilesAsync` and `collectLargestFoldersAsync`, in today's traversal order, yielding every slice under U-D9's guard.
  * `collectLargestFoldersAsync` keeps a bounded top-`limit` ordered by (size descending, post-order index ascending), which is the stable sort's tie rule. It builds `store.path` only for the winners (today it builds one for every folder of 1 MiB or more, `:1312`).
  * **It walks child ranges directly, without the per-node `Frame` and `kids` array that `collectLargestFolders`' `frame()` allocates (`:1291`).**
  * A memo per (store, version, params).
* `src/services/scanStore.ts`: `PackedScanStore.eachFile`/`eachNode` push child ranges onto the stack, reversed with extras reversed first, instead of allocating a `childIds` array per folder. Same order.
* `scanRoutes` (`/large-files`, `/file-types`) and `insightRoutes` (`/large-folders`) use them.
* Tests: `tests/collectorSlices.test.ts`; `tests/numberingIndependence.test.ts` included in the run.

- [ ] Tests first:
  - differential against today's sync functions on fuzz trees with many size ties, at limits {1, 10, 20, 500} and `minSize` {0, 1, 1 MiB};
  - goldens `largeFiles` and `fileTypes` byte-identical;
  - `eachFile`/`eachNode` order equals `ObjectScanStore`'s with tombstones and post-finalize extras;
  - yields counted; a probe runs first; `store.path` calls ≤ limit; allocations per node = 0 in the folder walk (counter hook); a repeat request → 1 walk; `setSize` → 2;
  - numbering-independence green.
- [ ] Mutants: the tie-break reversed; a path built for every candidate; the extras order swapped; the memo key without `limit`/`minSize`; the yield removed; a `Frame` allocated per node.
- [ ] Commit `perf(dashboard): the file-type and largest-item lists are walked in slices`.

**Proves:** removes the 1.8 s file-types and 1.1 s largest-folders stalls after completion.
**Gate:** the largest eld stall during `loadDashboardLists` ≤ 243 ms; time-to-lists reported.

### U-18: The first frame — count pass in slices, small frames built once and shared, nothing kept after sending (TypeScript) — M
**Depends on:** U-2 (heartbeats during the build). U-19 may land before or after.
**Overlaps:**
* Phase 4: T9b's design (no pruned object tree, no whole-frame string, no whole-frame buffer) is kept above the cap. T10's 700 MB `T_mem` gate at 5M, re-run in plain Node and in Electron, **blocks this commit**. T22 re-measures.
* Phase T T-3/T-28 (responsiveness records). Phase R T-32 (a byte-exact Rust serializer) could later replace it off-thread.
* FG4: none.

**Files:**
* `src/services/treeFrame.ts`:
  * The count pass runs in slices (`FRAME_YIELD_NODES = 4,096`, an injectable `yieldTurn`) under a captured `store.version`. A version change before the first byte restarts it (U-D9).
  * A frame whose counted size is ≤ `FRAME_BUFFER_MAX` (32 MiB) is gathered as chunks during that same pass and written from them, with no second pass.
  * Above the cap, today's streaming write pass (T9b) runs unchanged, with its backpressure, close and version handling.
  * The refusal before any byte is kept.
  * **Single-flight only for a buffered frame, and only for readers that arrive while it is being built. Nothing is retained after the last waiting reader is served** (U-D10).
* Tests: `tests/treeFrame.test.ts`, and a new `tests/frameBuild.test.ts`.

- [ ] Tests first:
  - Every existing identity test still equals the reference: fuzz trees × 7 budgets × both stores, before and after watcher edits, the edge shapes, the 200- and 5,000-deep chains, the HTTP stream and `/result`.
  - Build counter: 2 concurrent `/result` + 1 `/progress` on a buffered frame → 1 build; the SSE frame, then a later `/result` → 2 builds (no cache); above the cap each reader streams.
  - Yields in the count = `ceil(nodes/4,096)` on a 20,000-node tree; a probe queued with `setImmediate` runs before the frame is written.
  - Version guard: a mutation on the first yield → attempts 2, and the frame equals the post-mutation reference; a mutation on every yield → attempts 3, the last yielding 0 times.
  - The refusal boundary: length − 1 is refused with 0 bytes written; the exact length is sent.
  - Retained frame bytes after the send = 0 (a counter).
  - Heartbeat frames flow while a count is held by a seam.
- [ ] Mutants: single-flight removed; the version check removed (a mixed frame equals neither reference); a linger cache added (the second-reader count reddens); the yield removed; the last attempt still yielding; the head written before the refusal check; the cap ignored (a large frame buffered).
- [ ] Commit `perf(frame): the first frame's count runs in slices and a small frame is built once, and none is kept after it is sent`.

**Proves:** the synchronous count pass (0.75 s at load 9, 3.6 s at load 25) becomes slices, and the second serialization of a small frame goes away. The repeated serializations for several readers were U-2's.
**Gate:** the largest eld stall while the complete frame is built ≤ 243 ms; frame builds per scan = 1; RSS at completion reported beside run 1's 3.2–3.5 GB (ArrayBuffers 2.1 GB of it).

### U-19: The first frame honours its node budget (TypeScript + Rust) — M
**Depends on:** nothing. **Owner:** U-Q6 (Phase 4 Q11 reopened). Without a yes, this task is not built.
**Overlaps:**
* Phase 4 T15a built `select.rs`; T15b's summary must pass the same flag. T19 aggregate: a skipped folder keeps its true count in `omitted`.
* Phase R T-32 inherits the rule.
* U-20 depends on it.
* FG4: none.

**Files:**
* `src/utils/pruneTree.ts`: `overshoot: 'lastFolder' | 'none'`, implemented **in `pruneTree` itself**, the object oracle behind `ObjectScanStore.prune` and `scanQueries.ts:220`, so the oracle and the store agree. The default is `'lastFolder'`, today's rule.
* `src/services/scanStore.ts`: in `pruneStore` and `prunedExpansion` under `'none'`, a popped folder other than the prune's root whose live child count would take `nodes` past `maxNodes` is skipped: it stays pruned and the loop continues. **Bound: nodes ≤ max(maxNodes, 1 + the root's children) for maxNodes ≥ 2. At maxNodes = 1 the frame is the root alone**, which the `subtreeSingle` golden depends on.
* `src/services/treeFrame.ts` `sendPrunedTree` takes the option. `scanRoutes.ts` `sendFinalEvent` and `GET /result` pass `'none'`. `/subtree` and the full prunes elsewhere keep `'lastFolder'`.
* `setPruneMaxNodesForTests` seam (`PRUNE_MAX_NODES = 250_000` is a const, `scanRoutes.ts:95`).
* `native/treemap-core/crates/tm-store/src/select.rs` `select_prune` gains the flag; `tests/fixtures/selectOracle.ts` gains the case.
* **Step 0:** read `readTree`'s own 25,000-node cap for the index preview. If it expands whole folders past it, it gets the same rule in this commit; otherwise that is recorded.
* Docs: DESIGN §16 (new item); RISKS R82 closed for the first frame; Phase 4 Q11's status; **AGENTS.md and openapi describe the hard budget as a non-additive change approved under U-Q6**.
* Tests: `tests/pruneBudget.test.ts`, `tests/treeFrame.test.ts`, `tests/numberingIndependence.test.ts`, and a Rust select test.

- [ ] Tests first:
  - Over storeFuzz `buildPair` seeds 1–12, both stores, budgets {1, 2, 7, 20, 40, 250, 20k, 250k}: the bound holds; every expanded folder carries every child; sizes are exact; wherever today's result fits the budget, the `'none'` JSON is byte-identical to today's; `prunedExpansion('none')` equals `pruneStore('none')`'s set; `pruneTree('none')` equals `pruneStore('none')`.
  - A 300-child folder at budget 40 stays pruned, and a smaller folder popped after it is expanded.
  - An exact fit is expanded; a root with 300 children at budget 40 is expanded.
  - The route, through the seam: a 5,000-child folder at budget 1,000 → ≤ 1,000 nodes in both the SSE frame and `/result`.
  - Rust `select_prune` with the flag equals the JavaScript at {1, 50, 250k} and on a giant-folder tree.
  - Numbering-independence green; goldens unchanged (the fixture is about 200 nodes).
- [ ] Mutants: `>` ↔ `>=` at the boundary; the root not exempt; `break` for `continue`; the flag honoured in `pruneStore` but not `prunedExpansion` (or not in `pruneTree`); the Rust flag inverted.
- [ ] Commit `fix(frame): the first tree sent to the window honours its node budget`.

**Proves:** removes the 671,545-node first frame against a 250,000 budget. At least 421,546 of those entries sit in one folder (arithmetic: 671,545 − 250,000 + 1).
**Gate:** the complete frame's nodes ≤ max(250,000, 1 + the root's children) (22 on `/` on the diagnosis Mac); `frameChars` reported. If the owner's disk has no folder that overshoots, the gate says so and the frame is unchanged.

### U-20: The window asks for a smaller first frame (TypeScript + UI) — S
**Depends on:** U-19. **Owner:** U-Q8. **Overlaps:** Phase 8 T10 (the frame-cost count; `bench uiframes`) measures the chosen number. FG4: none.
**Files:**
* `src/api/scanRoutes.ts`: an additive `?maxNodes=` on `GET /progress` and `GET /result`, clamped to `[1, PRUNE_MAX_NODES]`. A value that is not numeric gives the default. With no parameter, the default (250,000) is unchanged, so agents, the MCP server and the goldens still get it. U-18's single-flight key includes it.
* The page: `FIRST_FRAME_NODES`, the owner's number (recommended 100,000), on both requests. `ensureSubtree` already fetches pruned folders when they are opened.
* openapi.
* Tests: extend `tests/treeFrame.test.ts`; a UI lift test.

- [ ] Tests first: no parameter → golden bytes; the parameter honoured (nodes ≤ it under U-19's rule); 0, −5, 10M and `x` clamp; the page passes the constant; apiContract documents it.
- [ ] Mutants: the clamp removed; the page omitting the parameter.
- [ ] Commit `perf(frame): the window asks for a smaller first tree and opens deeper folders when it needs them`.

**Proves:** the parse (1,885 ms for 671,545 nodes) and `indexTree` (395 ms) scale with nodes. At 100,000 nodes and 355 chars a node, the frame is about 35.5M chars and parses in about 280 ms at run 3's measured rate (both arithmetic, not measured). **That is still over 32 ms.** See the gate and the risks.
**Gate:** nodes, `frameChars`, the page's parse in ms and `finishScan`'s synchronous ms.

### U-21: The index build in a worker thread with its own connection (TypeScript) — L
**Depends on:** U-15. It must land before U-22, because until U-22 the discard after a worker's death is still today's synchronous delete.
**Overlaps:**
* Phase 4 T18: its harness, R96 (an addon unloaded at worker teardown on Windows; tm-node now pins itself), its `resourceLimits` pattern, and its "addon loads in a worker inside the installed Electron" test are shared.
* Phase 8 T8: pause becomes a second value of the shared flag, and the duty is sent to the worker by message (amend T8's file list).
* Phase T: T-4's manifest and T-24's staging include the worker entry.
* Phase R W2 later replaces the worker with a Rust thread; keep the message protocol small.
* FG4: none.

**Files:**
* New `src/services/indexBuild.ts`: the build core, taking a row source and a database handle.
* New `src/services/indexWorker.cjs`: the worker entry. From `src/` it requires `tsx/cjs` first (tests); from `dist/` it loads the compiled core (the app), following `bench/lib/corpus.ts:462`. It throws when run on the main thread.
* `src/services/indexEngine.ts` `buildIndex` keeps on the main thread only `stopWatcher`/`holdWatchesOf` before the build, `startWatcher` after it (`watchRegistry` is main-thread), and the job record. It spawns `new Worker(entry, { workerData, resourceLimits })`.
* **Cancel and pause:** a `SharedArrayBuffer` Int32 flag, read with `Atomics.load` between batches (0 run, 1 cancel; T8 adds 2 pause). `cancelAllIndexJobs` (`indexRoutes.ts:112-114`) writes the flag, then terminates and joins after a bound. The worker is `unref`'d, so a CLI shutdown is not held open.
* **Connections:** the worker uses WAL, `synchronous = NORMAL`, a bounded `cache_size` and a `busy_timeout`. The main connection keeps reading throughout (WAL readers never block), and its `busy_timeout` is 1,000 ms. A main-thread write waits at most one 500-row batch (about 26 ms, arithmetic).
* **Errors:** a worker error, exit or `ERR_WORKER_OUT_OF_MEMORY` ends the job `error` with a sentence, and the building root is discarded (by the worker's cleanup, else by U-22's deferred discard).
* **Portable read-only mode** uses `':memory:'` (`indexEngine.ts:236-237`), which a worker cannot share. There the build stays in-thread, bounded by U-15's yields.
* Count-triggered pause seams in the core (tests only).
* The bundle ships the worker entry, as it ships `containerWorker.js`.
* Tests: `tests/indexWorker.test.ts`.

- [ ] Tests first:
  - one build constructs exactly 1 Worker (seam counter); the core throws on the main thread;
  - statements prepared on the main connection between start and `ready` = 0, apart from the test's own reads;
  - **with the build held by the seam after batch 2**, N `GET /api/index/tree` requests for another root get N 200s;
  - cancel mid-build: rows written after the flag ≤ one batch, the job `cancelled`, 0 building roots; `cancelAllIndexJobs` sets the flag and the worker exits (counted);
  - worker terminated mid-transaction: the job `error` with a sentence, 0 building roots after the next open, 0 process exits, and **a main-thread write afterwards succeeds within its busy timeout** (1 success, 0 `SQLITE_BUSY`), proving the lock was released;
  - a tiny `resourceLimits` on a fixture: out of memory → job `error`, root discarded;
  - portable mode: 0 Workers, and U-15's yield count still holds;
  - the installed Electron: the worker loads better-sqlite3 (T18's harness).
- [ ] Mutants: the flag check removed; discard-on-error removed; the build run in-thread; the portable fallback removed; `resourceLimits` dropped; `cancelAllIndexJobs` not writing the flag.
- [ ] Commit `perf(index): the index build runs in a worker thread with its own connection`.

**Proves:** moves the 598.6 s of blocking, the 2,744 stalls and the 40.8 and 29.8 s flush stalls off the server's event loop (Electron's main process) for every build that still runs: the small automatic ones and the explicit ones.
**Gate:** explicit builds of home and of `/`, with eld, `--cpu-prof` and the window's recorder:
* stalls attributed to `indexEngine` or `indexBuild` above 243 ms = 0;
* the p99 of eld's per-second loop delay during the build ≤ 2 × the idle baseline's p99 (this plan's threshold).

### U-22: Replacing, discarding or removing an index never runs a multi-million-row DELETE or a VACUUM on the main thread; the Remove control (TypeScript + UI) — M
**Depends on:** U-21. **Owner:** U-Q4.
**Overlaps:** U-1's badge. The structural alternative, one database per root, is deferred to Phase R W2. Phase T's packaged smoke should exercise Remove. FG4: none.
**Files:**
* `src/services/indexEngine.ts`:
  * **Delete-all:** cancel and join every worker that holds a connection (builds and batched deletes), close, unlink `index.db`, `-wal` and `-shm`, and reopen an empty database. **In `':memory:'` mode it never unlinks**: it deletes in batches in-thread with yields.
  * **One root:** used by `deleteIndex(path)`, the rebuild's prior-root delete (`:385-396`), cancel (`:508-510`) and `discardIncompleteBuilds` (`:298-308`).
    * First, one statement renames the root's `path` to a tombstone, `\u0000discard:<id>`, which no real path can equal. That frees `UNIQUE(path)` (`:139`) for a rebuild of the same folder.
    * Every reader excludes tombstones: `listRoots`, `rootFor`, search, allocation and status. The public `IndexState` stays `building|ready|stale|error`.
    * The rows are then deleted in the worker by id range, ≤ 500 a transaction.
    * The roots row goes last, so `ON DELETE CASCADE` (`:155`) then deletes nothing, instead of the whole root in one statement.
  * `openIndex` only turns building roots into tombstones and defers their deletion.
  * `VACUUM` runs only on explicit request, in the worker, after a free-space check. With too little space it is skipped, with a sentence.
* UI (the U-1 badge), with `dbBytes` from the status without `?path=`:
  * one root: "Remove index (frees <dbBytes>)";
  * several roots: a per-folder "Remove this folder's index", with "TreeMap's index takes <dbBytes> in all; removing one folder frees its space for later indexes, not on the disk", plus "Remove all indexes (frees <dbBytes>)". **"Frees" appears only where the files are unlinked.**
* Tests: `tests/indexDeletes.test.ts`.

- [ ] Tests first:
  - delete-all runs 0 `DELETE` and 0 `VACUUM` statements (prepare spy), leaves 0 index files, and a following build succeeds;
  - **delete-all during a build** joins the worker first; on POSIX that worker never reports `complete` afterwards; the Windows leg shows the unlink succeeds after the join;
  - `':memory:'` mode never unlinks (unlink spy 0);
  - a per-root delete issues `ceil(rows/500)` transactions, each ≤ 500 rows, 0 of them on the main connection;
  - **a rebuild of the same path while the old rows are being deleted succeeds** (no UNIQUE error);
  - tombstones never appear in `listRoots`, `rootFor`, search or status;
  - opening a database with a building root deletes 0 rows synchronously, and `GET /api/index/status` answers before the discard finishes;
  - `VACUUM` is skipped with too little free space (seam), with the sentence;
  - UI: Remove sends exactly 1 `DELETE`; "frees" is shown only for delete-all or a single root.
- [ ] Mutants: `VACUUM` restored on delete-all; the synchronous startup discard restored; unbounded delete batches; the free-space check removed; the tombstone rename skipped (the same-path rebuild reddens); the worker not joined before unlink; unlink in `':memory:'`.
- [ ] Commit `perf(index): removing or replacing an index never blocks the app, and its label says only what it frees`.

**Proves** costs predicted from the code, never measured: the synchronous delete of the prior rows (9.46M for a whole disk) at the start of every rebuild; the startup discard after quitting mid-build, which runs on the first Scan click; and DELETE plus VACUUM of a 2.63 GB database.
**Gate:** measured before and after with eld: a second explicit whole-disk build with the index present; quit mid-build and relaunch; Remove index. Each one's main-loop stall ≤ 243 ms, and the freed bytes equal `dbBytes` **for delete-all**.

### U-23: Each scan's boundary list from the mount table (TypeScript) — S
**Depends on:** nothing.
**Overlaps:**
* Phase 8 T14 (P8-21): its first half, pulled forward; its Step 0 on gdu and Windows still applies.
* Phase 4 T17: the Windows `<appData>\scan-spill` exclusion (RISKS R97) is composed in `scanBoundary`, whichever lands first.
* Phase T T-7: the `mount` child's environment carries no token.
* FG4: none.

**Files:**
* `src/utils/mountBoundaries.ts`: the fixed list (`:22-36`) is kept. Add:
  * `readMountTable(platform, deps)`: darwin runs `parseBsdMount` (`src/platform/atime.ts:164`) over `runText('mount', [], { timeoutMs: 5000 })`; linux runs `parseProcMounts` (`atime.ts:73`) over `/proc/mounts`; win32 gives `[]`, with the sentence T14 Step 0 verifies (a volume mounted in a folder is a reparse point, which both engines treat as a link). The table is read fresh for every scan; the 30 s cache at `src/platform/macos/lastUsed.ts:281` is not reused.
  * A pure `mountPointsUnder(root, realRoot, entries, aliases)`:
    * it keeps mounts strictly beneath the root, compared segment by segment, re-spelled in the root's own spelling;
    * the darwin aliases come from `/usr/share/firmlinks`, falling back to a copy of `stripDataVolume`'s prefix rule (`pathSanitizer.ts:171` is not exported and reads `process.platform`, so the copy is injected);
    * **only directory mount points are kept**, which drops Linux file bind mounts such as Docker's `/etc/hosts`.
  * `scanBoundary(root, rule, deps)`: the one place a scan's never-descend list is composed.
* `parseBsdMount`: the mount point is taken as the text between the last `" on "` before the final `" ("`, so a nullfs source path containing `" on "` parses (it split at the first `" on "`).
* The header comment (`:15-20`) is rewritten with the measurement (firmlinks share `st_dev` on macOS 15 and 27) and the real reasons for the table.
* Tests: `tests/scanBoundary.test.ts`, with **a redacted fixture of the diagnosis Mac's `mount` output**: no user name, and the `/private/var/folders` hash replaced by a placeholder.

- [ ] Tests first (pure, every OS, counts only):
  - the fixture at root `/` gives exactly the four crossed mounts (the SimRuntimeBundle cryptex, `iOS_22E238`, `iOS_23F77`, the nullfs under `/private/var/folders/…/X/`) plus the system mounts under never-descend folders;
  - `/Users`, `/Applications` and `/private` never appear, even when a fake device reader gives `/Users` another `st_dev`;
  - the aliases for a root of `/System/Volumes/Data`; re-spelling for `/var/folders/…` against `/private/var/folders/…`;
  - `/Volumes/Disk2` is not under `/Volumes/Disk`; a root that is itself a mount is not in its own list; `/mnt/my\040disk` reads as `/mnt/my disk`;
  - a failed `mount` gives `entries: null` with its reason, never `[]`;
  - two scans read the table twice;
  - `stay` composes the fixed list plus the mounts; `cross` gives the fixed list;
  - a file bind mount is dropped; a source containing `" on "` parses;
  - the fixture contains no user name.
- [ ] Mutants: "or its device differs" added; aliases dropped; no re-spelling; `startsWith` without the separator; "at or under" for "strictly under"; the catch returning `[]`; a 30 s cache; mounts added under `cross`; file mounts kept; the first `" on "` split.
- [ ] Commit `feat(scan): each scan's boundary list comes from the mount table`.

**Proves:** nothing on its own; it is the input to U-24. Gate: the owner's live `mount` output replayed through `mountPointsUnder('/')` names the two simulator volumes, the SimRuntimeBundle and the Clocks wrapper as the Mac then has them, and nothing firmlinked.

### U-24: Stay on this drive — walker, native and gdu stop at mount points (TypeScript + CI) — L
**Depends on:** U-23 and U-4. **Owner:** U-Q9 decides the default. The mechanism is built either way.
**Overlaps:**
* Phase 8 T14: its engine half is absorbed here, and its copy test uses the same sentences.
* Phase 4: T16's conversions and any re-walk pass the same list; T19 aggregate; T17's Windows spill exclusion joins the set.
* U-15's walk source takes the list.
* Phase T T-7.
* FG4: none.

**Files:**
* Settings: `settings.ts`, `settingsRoutes.ts` (`scanBoundary`).
* `diskScanner.ts` `startScan` calls `scanBoundary` once and keeps `scan.boundary` on the record. `ScanStats` and `buildScanStats` are untouched.
* The walker:
  * tests the scan's set at `:1241`;
  * checks it at the top of `processDirectory`, which closes `reuseCachedListing` (`:900`) and the revalidate fall-through (`:1105`);
  * **the detector:** a directory whose `lstat` `st_dev` differs from its parent's and that the table did not list is counted in `crossedUnlisted`, with examples. It counts; it never gates (P3-3).
* Native: `runNativeWalk` passes the list to `scanStart` (`nativeEngine.ts:692`, and the columns re-walk at `:785`). No Rust change.
* gdu: the shard filter (`gduScanner.ts:350`, `:364`) reads the set. Under `stay` gdu keeps `-x` (`:165`). Under `cross` it drops `-x` only if T14 Step 0 shows gdu then enters mounts as the walker does; otherwise `gduRuleFor` refuses gdu under `cross`, with that sentence.
* **`notEntered`** is the listed mounts under the root that are outside the fixed list and not beneath a refused, skipped or never-descend folder, taken from the list and the walk's own records (tm-walk's `ListingSink::skipped` where available), never from "a childless node". That makes it hold for gdu (whose `-x` drops the node), spill (asynchronous lookups) and aggregate (no row below β_d).
* **`entered`** (under `cross`) is the outermost listed mounts whose node has children.
* **Comparability:**
  * the mtime cache records the rule, and a rule change invalidates it. `MTIME_CACHE_MAX_NODES` is 300,000 (`:836`), so no cache exists for a real `/` scan; the defect matters for small trees;
  * snapshots record the rule (`snapshots.ts:163-171`);
  * the journal (`journal.ts:292`), compare, forecast, budget gauges, growth alerts and U-30's projection treat a rule change as a new baseline and diff nothing across it.
* **Live mode:** `watcher.ts` `applyToStore` (`:258-270`) drops events at or under `scan.boundary.neverDescend`, as it drops app-data events.
* `.github/workflows/test.yml`: the Linux leg mounts a tmpfs under the runner's temp folder and names it in `TREEMAP_TEST_NESTED_MOUNT`.
* `tests/nativeEquivalence.test.ts`: a new case, not a loosened one. `tests/edgeCases.test.ts:385-403` is split: under `cross` today's assertions hold; under `stay` the mount point is an empty folder and both its files are absent.
* DESIGN §5 amended: P3-3's rule stands, and the detector is recorded. DESIGN §16 records gdu's omission of the mount-point node.
* U-4's predicate gains the not-entered mounts.
* Tests: `tests/scanBoundary.test.ts`, `tests/nativeEquivalence.test.ts`, `tests/edgeCases.test.ts`, `tests/ciWorkflows.test.ts`.

- [ ] Tests first (an injected table names the temp folder `t/mnt`, which holds one file):
  - walker under `stay`: `t/mnt` is a childless folder, the file is absent, `walkedDirs = dirs − 1`, `notEntered.count = 1`;
  - walker under `cross`: walked, as today;
  - native, where the module is present: the same two cases;
  - **gdu under `stay`**: no shard is spawned for the listed mount (the shard seam counts), and `notEntered.count = 1` although gdu dropped the node;
  - **aggregate** (`setStorageModeForTests`): the same `notEntered`;
  - incremental: a listing cached under `cross`, then `stay` with `t/mnt`'s mtime touched → it stays childless; **and `stay`, then `cross` with the mtime unchanged → the drive is walked** (the cache records the rule);
  - `mountOutcome`: nested entered mounts count the outer subtree once;
  - the detector: a fake `lstat` with a differing device gives `crossedUnlisted = 1`;
  - a snapshot records the rule; the journal writes 0 lines across a rule change;
  - a watcher event under a not-entered mount is dropped (the store is unchanged, counted);
  - equivalence: walker and native digests and all 11 counters agree under both rules on the nested-mount fixture (macOS `hdiutil`; the Linux tmpfs; skipped elsewhere with the reason);
  - settings validation.
- [ ] Mutants: `processDirectory` reading only the fixed list; `notEntered` inferred from childless nodes (the gdu and aggregate cases redden); native given `neverDescendPaths()`; the gdu filter reading the fixed list; the cache not keyed by the rule; the journal diffing across rules; the watcher filter removed; nested entered mounts summed twice.
- [ ] Commit `feat(scan): Stay on this drive — no engine enters another filesystem unless the person asks`.

**Proves:** diagnosis (2) cause 4 (about 1.18M extra entries) and the mounted-volume part of (1)'s −110.2 GB over-count.
**Gate:** on the owner's Mac, a scan of `/` at the default:
* `/boundary` lists `iOS_22E238`, `iOS_23F77`, the SimRuntimeBundle and the Clocks nullfs as not entered (as the Mac then has them);
* `scanned` of a `stay` scan and a same-session `cross` scan differ by **the `cross` scan's own node count beneath those mounts**, compared as counts (not `df -i`, whose inode counts can include items no walk lists);
* no node exists below them in the `stay` scan.

### U-25: The scanned-root rule reads what the scan listed (TypeScript, safety) — S
**Depends on:** U-24. **Overlaps:** the FG1/FG2 guards (spill, app-data) are unchanged; Phase 8 T15 (same-origin) is independent. FG4: none.
**Files:**
* `src/utils/pathGuard.ts` (`insideAnyScanRoot`): a path counts as inside a scan only if it lies under that scan's root **and not at or under that scan's never-descend set**, unless another scan's root covers it. The refusal stays `403 OUTSIDE_SCAN_ROOT`. It applies to every route AGENTS.md lists under the scanned-root rule, and to the MCP tools.
* AGENTS.md's safety model: one sentence.
* Tests: `tests/pathGuardBoundary.test.ts`.

- [ ] Tests first:
  - after a scan of a temp root whose boundary lists `t/mnt`, `DELETE /api/files { paths: ['t/mnt/file'], dryRun: true }` → 403 `OUTSIDE_SCAN_ROOT`;
  - after a scan of `t/mnt` itself → allowed; `t/other` → still allowed;
  - with the fixed list, a `/` scan (root seam) does not permit `/Volumes/X/…`;
  - MCP `trash_paths` answers the same.
- [ ] Mutants: the never-descend set ignored; another scan's cover ignored (over-refusal).
- [ ] **An independent security review before landing** (the guard is touched; the change only tightens).
- [ ] Commit `fix(safety): a scan grants action only over what it listed, never inside a drive it did not enter`.

**Proves:** makes "scanning is what grants (read-what-you-saw) permission to act" literal for mounts and `/Volumes`.

### U-26: `GET /api/scan/:id/boundary`, MCP and docs (TypeScript) — S
**Depends on:** U-24. **Overlaps:** Phase 8 T1 (`/live`'s `mountsNotEntered` reads the same record field) and T14's `#mountsNote`; Phase T T-30 includes the route; Phase 4 T17a's storage-mode table. FG4: none.
**Files:**
* `src/api/scanRoutes.ts`: the route, with the shape in § Fixed interfaces.
  * `mounts[]` separates **`reached`** (the walk got to the mount point) from **`entered`**, so mounts under fixed or unreached folders (`/dev`, `/System/Volumes/*`, `/Volumes/*`) are not listed as "not entered".
  * A record made before U-24 answers `rule: null` with a reason, never an empty list.
* `storageMode.ts`: the list reads the record only (never off). `entered.bytes` is `null` with a reason in spill and aggregate until T15b's lookup.
* openapi `ScanBoundary`. MCP `scan_path` appends "N drives mounted inside were not entered: …". AGENTS.md: the setting and the route.
* Tests: `tests/scanBoundaryRoute.test.ts`.

- [ ] Tests first: the 200 shape under `stay`; 404 `SCAN_NOT_FOUND`; an old record → `rule: null` and a reason; examples capped at 5 and sorted; `reached` false for a mount under `/Volumes`; spill → bytes null with a reason. goldenResponses and apiContract coverage stay green.
- [ ] Mutants: `[]` for an old record; the cap removed; `reached` conflated with `entered`.
- [ ] Commit `feat(api): /api/scan/:id/boundary says which drives a scan did not enter`.

### U-27: The Dashboard names the drives not entered; Settings holds the boundary (UI) — M
**Depends on:** U-26. **Overlaps:** Phase 8 T14's ids are used (`#mountsNote`, `#scanBoundary`), and T10's copy test. FG4: none.
**Files:**
* `010-view-dashboard.html`: `#mountsNote` beside `#accessRow`.
* `110-modal-settings.html`: `#scanBoundary`, with two radios, "Stay on this drive" and "Include drives mounted inside it". Help line: "A disk image or drive mounted inside the folder you scan is a separate disk. Staying on this drive keeps the totals true to the disk you chose."
* `045`: `loadBoundary()` after the paint (as `loadBudgets`); `renderMountsNote()`. The copy depends on the mount's file system:
  * a separate volume: "2 drives mounted inside this folder were not scanned — iOS_23F77, iOS_22E238. They are separate disks, so their files are not part of this disk's total." with "Change in Settings";
  * **nullfs or a bind mount:** "… a second view of a folder already counted, so it was not counted again";
  * `cross`: "This scan includes 2 drives mounted inside it — … Their files are counted, though they are not on this disk.";
  * table unreadable: "TreeMap could not read the list of mounted drives (reason), so a drive mounted inside this folder may have been counted as part of it."
  * At most five names, then how many more.
* `235-settings-modal.js` saves it. `build:ui --check`.
* Tests: a UI lift test file.

- [ ] Tests first: count 2 → both names and the button; 0 → hidden; a name containing `<img>` is escaped; the `cross`, nullfs and unreadable sentences verbatim; the radio sends `PUT /api/settings {scanBoundary}`; `/boundary` is requested only after the first tree frame (request log).
- [ ] Mutants: the row never shown; always shown; `escapeHtml` removed; the nullfs wording lost.
- [ ] Commit `feat(ui): the Dashboard names drives a scan did not enter; Settings holds Stay on this drive`.

**Gate:** after a scan of `/`, `/browse` captures the note naming the simulator volumes. Switching the setting and rescanning shows the `cross` sentence.

### U-28: Missing GB — "Drives mounted inside the scanned folder" (TypeScript + UI) — M
**Depends on:** U-24. **Overlaps:** Phase 4 T17's "TreeMap's own scan files" line joins the same union (independent of order). FG4: none.
**Files:**
* `src/services/missingGigabytes.ts`: `mountedInside`, built from `scan.boundary`:
  * **`stay`:** `bytes: 0`, with `count = notEntered` and the detail "N separate drives are mounted inside <root>; by the mount table the scan did not enter them, so none of their files are counted above". If the walker's detector found `crossedUnlisted > 0`, the line is instead `null`, with the reason naming them.
  * **`cross`:** `bytes: null`, with the reason: "the scan counted <logical total> inside drives mounted in this folder; their allocated share is already inside the sparse-file line and is not tracked per drive, so TreeMap cannot say how much to take back off." It is **never** a subtraction of logical bytes: tree sizes are logical (`diskScanner.ts:1187-1188` keeps only a scan-level `allocDelta`), and `sparseLine` (`:840`) already nets every file's sparse and slack share, including files inside entered mounts.
  * No record, or an unreadable table: `null` with the reason, named in `unaccounted`'s `includes`.
* openapi `:1370`; `140-missing-gigabytes.js` lists the line (a 0 needs no netting).
* Tests: `tests/missingGigabytes.test.ts`, with **a sparse file inside the mount** in the fixture.

- [ ] Tests first: `stay` → 0 with count 2; `cross` → null with the reason and the logical total in the detail; `crossedUnlisted` 1 → null naming it; no record → null in `includes`; `assertBalances` holds in every case.
- [ ] Mutants: a `cross` line subtracting logical bytes (the sparse fixture reddens); null coerced to 0; the detector ignored.
- [ ] Commit `feat(missing-gb): drives mounted inside the scanned folder get their own line`.

**Proves:** the attribution of diagnosis (1)'s mounted-volume over-count.
**Gate:** a `stay` and a `cross` statement from the same session. Their Unaccounted lines and the `cross` scan's logical total inside the mounts are reported side by side. Nothing is asserted from their difference: the old "Unaccounted rises by exactly X" was true by construction (`unaccounted = used − known`, `:463-464`).

### U-29: Missing GB — "On this volume, out of the scan's reach" (TypeScript + UI) — M
**Depends on:** U-23 (the table). Independent of U-24's engine work. **Owner:** U-Q10.
**Overlaps:** Phase 8 T25 (AGENTS.md's Missing GB paragraph). FG4: none.
**Files:**
* New `src/services/outsideReach.ts`, `findOutOfReach(dataRoot = '/System/Volumes/Data', rootSpelling = '/')`, with injected fs deps. For each Data-side entry:
  * skip it if it is a mount (the table) or a symlink;
  * `lstat` its root-spelled twin. **It is reachable only when the twin has the same `dev:ino` and is not at or under a never-descend path.** So `/Volumes/X`, which shares identity through the firmlink but is never walked, is a candidate;
  * a twin with another identity that is a directory is descended into, to depth 8 (`System`, `usr`);
  * otherwise it is an item.
* **Sanity guard:** if `/Users` and `/System/Volumes/Data/Users` do not share an identity, the line is unknown with that reason.
* `measure(items, cap)`: `readdir` and `lstat`, adding `blocks × 512`. **Files with `nlink > 1` are deduplicated by inode.** EACCES or EPERM makes the item unknown ("only macOS may read inside it"). Past the entry cap the item is unknown ("more than N entries").
* The result is memoised by `scanId`, with the in-flight promise shared, and dropped on `onScanForgotten`.
* `missingGigabytes.ts` line `outsideReach`:
  * darwin, root `/`, with a Data volume: `bytes` is the measured floor, `count` the items, with a note per item. Unknown items are named in `includes`;
  * root `/System/Volumes/Data`: the item is the system volume, sized from topology `usedBytes`;
  * folder scans: `null` ("not measured: everything outside <root> is already in Unaccounted"), not duplicated in `includes`;
  * **other OSes' whole-volume scans: `null`**, with "NTFS or ext metadata and anything hidden under a mount point cannot be listed by a walk", never 0;
  * no remedy.
* The scanned line's detail (`:412`) stops saying "which is this whole volume" when items exist.
* **`140-missing-gigabytes.js` gains a bar segment for `outsideReach`** (today's fixed list at `:16-22` and `:91` would leave it out). openapi `:1370`.
* Tests: `tests/outsideReach.test.ts`, with fake fs deps shaped like the 20 Data-root names.

- [ ] Tests first:
  - the items are exactly `.DocumentRevisions-V100`, `.PreviousSystemInformation`, `.Spotlight-V100`, `.TemporaryItems`, `.com.apple.templatemigration.boot-install`, `.fseventsd`, `MobileSoftwareUpdate`, `mnt` and `sw`, **plus a non-mount folder in `Volumes`**. The mount and the symlink in `Volumes` are not items; `Users`, `Applications`, `Library`, `private`, `opt`, `cores` and `pkg` are not; `System` and `usr` are not items as a whole; `home` is not;
  - an identity mismatch → unknown; EACCES → unknown with the reason;
  - cap 10 over 12 entries → exactly 10 `lstat`s, unknown;
  - `blocks × 512`, not logical size; two hard links to one inode counted once;
  - two statements run one walk;
  - Linux or Windows whole-volume → null with the reason;
  - the statement balances; the bar draws the segment.
- [ ] Mutants: the identity check removed; the never-descend clause removed (the `/Volumes` folder is lost); same-name descent removed; the mount or symlink skip removed; the guard removed; EACCES counted as 0; the cap ignored; logical size; the memo removed; nlink not deduplicated; non-darwin 0; no bar segment.
- [ ] Commit `feat(missing-gb): what a scan of / cannot reach on this volume gets its own line`.

**Proves:** diagnosis (1)'s omission: the Data-root folders not firmlinked to `/` were never walked and were missing from Missing GB.
**Gate:** a `/` scan's Missing GB lists the nine names. The root-only folders read "only macOS may read inside it", the rest carry sizes, and a non-mount folder in `/Volumes` appears with its size.

### U-30: A native scan's entries projected before it walks (TypeScript) — M
**Depends on:** U-24 for the same-rule snapshot filter. Until then, every snapshot of the root is used.
**Overlaps:**
* Phase 4 T16: §S.1.1's inputs P and U. T16's chooser takes `projectEntries` unchanged, compares `1.25 × P` with `T_mem`, and never trusts U as a bound (P4-4a).
* The device-boundary fix moves the next scan's P, not U.
* Phase R W3 (scan orchestration, PLAN-TAURI §2 Q3) ports it as a pure function with these vectors.
* FG4: none.

**Files:**
* New `src/services/scan/projection.ts`: `projectEntries(rootPath, deps = LIVE) → { entries: number | null; source: 'previousScan' | 'usedInodes' | 'none'; reason }`.
  * **The previous scan comes first**: the newest snapshot whose `rootPath === rootPath` exactly and whose boundary rule matches, read as `fileCount + dirCount`. **Both must be `Number.isSafeInteger` and ≥ 0.** Anything else is unknown with a reason: a hand-edited or old `snapshots.json` can hold `NaN` or a string, and `Math.max(base, NaN)` is `NaN`, which napi refuses with an error that is not a sink refusal.
  * Only with no previous scan, and only for a whole-volume root, the used-inode hint applies. `wholeVolumeMounts(root)` gives `['/', '/System/Volumes/Data']` for `/` on darwin, `[root]` for a mount point, a Windows drive root or Linux `/`, and `null` otherwise.
  * `usedInodes(mount)` is `statfs` `files − ffree` under `diskUsage.ts`'s 2 s bound. It is null when `files ≤ 0`, `ffree > files`, on a timeout or on an error. If any mount is unknown, entries is null; there is never a partial sum and never 0.
  * The function never throws.
* It is called only in `startScan`'s native branch (`diskScanner.ts:754`), inside the fire-and-forget block. **`if (scan.cancelled) return` follows the await.** It is kept as `scan.nativePlan.projection`.
* Test seam: `setProjectionForTests(scanRoot, projection)`, needed by U-32 and U-34 because a temp folder is never a whole volume.
* **Not quite read-only:** a corrupt `snapshots.json` read through `readJsonFile` runs `preserveCorrupt`, which copies the file to `snapshots.json.corrupt` in app-data. That is stated, and unchanged.
* Tests: `tests/entryProjection.test.ts`.

- [ ] Tests first (deps injected, calls counted):
  - `{fileCount 8,000,000, dirCount 1,115,094}` → 9,115,094 from `previousScan`, with 1 snapshot read and 0 `statfs` calls even for `/`;
  - the newest exact-root snapshot is used, never a prefix match or the oldest;
  - **`fileCount: NaN`, `"123"`, −1 or 2^53 → unknown, with a reason**;
  - with no previous scan, darwin `/` sums its volume group: `{1,668,728,774 files, 1,668,244,760 free}` + `{1,673,488,924, 1,668,244,760}` → 5,728,178 from `usedInodes`, with 2 `statfs` calls;
  - Data reporting `files` 0 → null, and the reason names it;
  - `files < ffree` → unknown;
  - a subfolder (the same `dev` as its parent) → no hint;
  - mount points, `D:\` and linux `/` → `[root]`;
  - a snapshot read rejecting EMFILE falls through with its reason; an injected `statfs` that never answers resolves as unknown when the injected timeout fires;
  - a Stop during the projection starts no walk (counted).
- [ ] Mutants: the hint before the previous scan; a partial sum; `files` 0 read as 0 used; a subfolder given the volume's count; Data left out; a prefix match; the oldest snapshot; a dep's throw propagating; the integer check removed; the cancel check removed.
- [ ] Commit `feat(scan): a native scan projects its size from the last scan of the same folder before it walks`.

**Gate:** in a throwaway `TREEMAP_DATA_DIR`, the second scan of `/` states in `/storage`'s `reason` that it was sized from the previous scan's count, and gives that count. The first scan states the used-inode count, or unknown with its reason. The owner's own app data is never read.

### U-31: The memory store's room sized from the projection (interim until T16) (TypeScript) — M
**Depends on:** U-30 and U-9. **Owner:** U-Q15.
**Overlaps:**
* Phase 4 T16: its chooser replaces `memoryRoomFor`, and the room goes back to `1.25 × T_mem` as the conversion trigger. T10b's second walk is deleted. **U-40 adds to T16's tests: "the room is 1.25 × T_mem whatever the projection".**
* T21/T22: the bench's memory-path worker keeps the default room.
* Phase T: under the plain-Node sidecar the hand-over is a zero-copy `storeTake`; Electron's `storeTakeInto` copy at 9M+ rows is unmeasured until T-29 removes it.
* FG4: none.

**Files:**
* `src/services/scan/nativeMemory.ts`: `memoryRoomFor(projection)`.
  * The base is the test room, or `MEMORY_CAP_ROWS`. `rows = entries === null ? base : max(base, ceil(2 × entries))`, clamped to 2^31 − 1.
  * `nameBytes = min(rows × nameBytesPerRow, 2^32 − 1)`. **It honours the test room's `nameBytesPerRow`**, not a fixed 128.
  * The room carries `sizedBy: 'default' | 'projection'`.
  * `RESERVE_FACTOR = 2` is a stated policy, not a measurement: an over-reserved row costs only address space (P4-11), while an under-reserved one costs a whole second walk.
* `memoryStoreOptions(store, room = memoryRoom())`. `runNativeWalk` takes the room.
* **Refusals:** if `scanStart` throws "the memory sink cannot be made" for a projection-sized room, the walk retries once at the default room. **If the default room is refused too, it walks natively on the columns path**, which needs no sink, never the legacy walker. No other error is retried. Each refusal is a walk with `ended: 'refused'` (U-9).
* `diskScanner.ts` sets `scan.nativePlan = { projection, room }`. `engineReason` gains "the memory store was given room for N rows because <projection.reason>" only when the room was sized.
* T10b's ceiling followed by the columns walk stays as the safety net for an under-projection.
* If the owner answers no to U-Q15, a tree whose `1.25 × P` exceeds `T_mem` goes straight to the columns path, and the tests change with it.
* Tests: `tests/nativeMemoryProjection.test.ts`, using the counted pass-through extracted to `tests/fixtures/countedNative.ts`.

- [ ] Tests first (counts only; the default room is `setMemoryRoomForTests({capRows: 2048})`):
  - pure `memoryRoomFor`: null → {6,250,000; 62,500; 800,000,000}; 9,115,094 → {18,230,188; 182,302; 2,333,464,064}; 3,000,000 → the default; 40,000,000 → `nameBytes` 4,294,967,295; 2e9 → `capRows` 2,147,483,647; a test room with `nameBytesPerRow` 64 is honoured;
  - a folder that outgrew the room walks once on its next scan: a 40×60 tree (2,441 rows). Scan 1 starts `['memory','columns']`; after `backgroundWrites.settled()`, scan 2 starts `['memory']` with one take and `capRows` 4,882, has no "walked the tree again" in `engineReason`, and `prunedJson(scan2) === prunedJson(scan1)`;
  - a projection of 500 leaves `capRows` at 2,048;
  - the real module accepts `nameBytes` past 2^31 (a tiny tree with `memoryRoomFor(9,115,094)`);
  - a sized room refused → `[memory 4,882 refused, memory 2,048, columns]`, completing native with `fallbackReason` null;
  - **both rooms refused → `[memory refused, memory refused, columns]`**, native, never the walker;
  - any other throw → 1 memory attempt;
  - an under-projection (a snapshot of 100 for 2,441) still meets the ceiling.
- [ ] Mutants: the room ignored by `runNativeWalk`; factor 1; `nameBytes` or `rows` unclamped; `max(base, …)` dropped; no retry; a retry on any error; the second refusal falling to the walker; `nameBytesPerRow` ignored.
- [ ] Commit `perf(scan): a folder that outgrew the memory store's room is walked once on its next scan`.

**Proves:** removes the wasted first walk on rescans: 96 s of 231.7 s (~41 %) in run 1, about 430 s in run 3. Such a tree then takes the memory path, which also avoids the columns path's main-thread ingest (7.4–11.8 s). It **does not promise** to remove the 3.2–3.5 GB completion peak (run 1: 2.1 GB of it ArrayBuffers): the frame build and the suggestions also run at completion. The arithmetic expects about 0.67 GB of store for 9.1M rows (the measured 73 B a row), not measured above 5M.
**Gate:** in a throwaway data folder, scanning `/` twice (`run-api.cjs`, `sampler.cjs`, `eld.cjs`):
* counted: the second scan's `/storage` `transitions` is empty (was one walk-again), and `engineReason` has no "walked the tree again";
* reported: the main-thread block of `adoptNativeStore` + `sumSizes` at this size (unmeasured above 5M), wall time against run 1's 231.7 s at comparable load, and peak RSS;
* the first scan's walk count is reported.

### U-32: P4-14 now — no restart in the built-in walker above T_mem (TypeScript) — S
**Depends on:** U-9 (walks recorded) and U-30. **Owner:** U-Q16.
**Overlaps:** Phase 4 T16's "no legacy walker is started in the large modes" test: this is its memory-above-`T_mem` half; T16 widens it and moves `T_MEM_ENTRIES` into `storageSpillThreshold` (T17). R56's stall clock is unchanged. FG4: none.
**Files:**
* `src/services/scan/nativeMemory.ts`: exports `T_MEM_ENTRIES = 5_000_000`, and writes `MEMORY_CAP_ROWS` as 1.25 × it. `MemoryRoomForTests` gains `tMem`.
* `src/services/diskScanner.ts` native catch (`:766-781`), before `resetCounters`: **if the tree is known to be above `T_mem`, the scan fails with this error.**
  * Known above means `scan.scanned > T_mem`, or `1.25 × P > T_mem` for a projection from a previous scan (U-D18). The used-inode hint is not a fact. The ceiling clause is dropped: any room is ≥ 1.25 × `T_mem`, so a ceiling implies `scanned > T_mem`, and a test pins that invariant.
  * The error: "The native engine failed part-way past 5,000,000 items: <reason>. TreeMap does not restart a scan this large in the built-in walker, which would walk it again from zero at a fraction of the speed."
  * When the failure names a folder that stopped answering: "The folder that stopped answering was <path>. A failure like this repeats on every scan until that folder answers or is added to \"Don't scan\" in Settings." Step 0 records that a "don't scan" pattern currently routes the scan to the built-in walker.
  * Nothing is reset and no legacy engine runs. Below `T_mem`, nothing changes. **After a native failure the fallback is the built-in walker only, never gdu** (`diskScanner.ts:689`: gdu is wanted only when native is not eligible).
* Tests: `tests/nativeNoFallbackAboveTmem.test.ts`, with the counted pass-through and `TREEMAP_NO_GDU`.

- [ ] Tests first. The hooks **fake low `entries`**, so each clause is isolated by counts:
  - (1) `tMem` 1,000; a hook throws from the second walk's 5th poll while reporting its own count under 1,000, with `scanned` held at 1,024 → error, starts `['memory','columns']` only, engine stays native, `scanned` ≥ 1,024 (not reset);
  - (2) a previous-scan projection of 2,441 with `tMem` 1,000 (`1.25 × P` > `T_mem`) and a memory walk that throws at its 2nd poll with faked entries 10 → error, no fallback;
  - (3) `capRows` 4,096, no ceiling, no projection, a failure at `scanned` 1,500 > `tMem` 1,000 → error;
  - (4) `tMem` 1,000,000 and a failure at the first poll → today's fallback: engine `walker` or `turbo-walker` (`diskScanner.ts:47` labels it by `IO_THREADS`), status complete, `fallbackReason` naming the failure;
  - (5) a cancel above `T_mem` → cancelled, not an error;
  - (6) a `usedInodes` projection above `T_mem` is not a fact → today's fallback;
  - (7) invariant: `memoryRoom().capRows − headroom > T_MEM_ENTRIES` for the default and for every sized room;
  - (8) the message names the stalled path when the error carries one.
- [ ] Mutants: the rule removed; the projection ignored; `T_mem` read as `capRows`; `resetCounters` moved before the rule; the hint accepted as a fact; `P` compared without `1.25 ×`; the path clause dropped.
- [ ] Commit `fix(scan): a native failure past 5,000,000 items fails the scan instead of restarting it in the built-in walker (P4-14)`.

**Proves:** 5.1.0's failure mode cannot recur on main after a ceiling: a fallback that zeroes the count and walks again at the measured 21.5k entries/s (9,347,504 in 434.5 s), then the same index build.
**Gate:** every whole-disk run shows `fallbackReason` null and engine native. The failure branch is proven by the tests and is not provoked on the owner's Mac.

### U-33: `/stats` reads the scan's own storage mode (TypeScript) — S
**Depends on:** nothing. **Overlaps:** pulls forward Phase 4 T17's "a real storageMode" and T23's openapi enum. Phase 8 T9 depends on it. FG4: none.
**Files:**
* `src/api/scanRoutes.ts:78`: `storageModeOf(scan)`.
* `src/models/types.ts:315`: `StorageMode`. Correct the comment at `:211-215`.
* openapi: the enum `['memory','spill','aggregate']`, described as read from the record.
* **`tests/storageModeRefusal.test.ts:384`** (it pins `'memory'` for an aggregate-labelled scan) is rewritten, and the Phase 4 plan's T17a text ("/stats.storageMode stays the literal") is amended by U-40.
* Tests: `tests/storageModeStats.test.ts`.

- [ ] Tests first: a scan labelled spill or aggregate through `setStorageModeForTests` → `/stats` answers that label; a memory scan → `'memory'`; `sseComplete`'s golden is byte-identical; the served openapi lists the three.
- [ ] Mutants: the literal restored; the enum left as `['memory']`.
- [ ] Commit `fix(stats): storageMode is read from the scan's own record`.

**Proves:** diagnosis item 11, corrected: the value is right for every interim scan (the columns second walk also keeps every row in memory), but it is now derived from the record rather than hard-coded. The gate should not expect `/stats` to change for the whole-disk scan: `/stats.storageMode` equals `/storage`'s `mode`.

### U-34: `GET /api/scan/:id/storage`, first cut, in §S.6.5's names (TypeScript) — M
**Depends on:** U-9, U-30 and U-31. **Overlaps:** Phase 4 T17's route (Q15) extends it with spill figures, conversions and the notice. Phase 8 T9 reads it (its "disabled[] on /stats" wording is corrected by U-40). Phase T T-26 and T-30. FG4: none.
**Files:**
* `src/api/scanRoutes.ts`: `requireScan`, then `{ mode, reason, transitions, disabled, exactness, spill: null, aggregate: null }`:
  * `reason` is one sentence giving the projection's source and count and the room (for example, "memory: the previous scan of this folder counted 9,115,094 items, so the memory store was given room for 18,230,188 rows");
  * `transitions` carries the walks, `{ from: 'memory', to: 'memory', atEntries, reason }`;
  * `disabled` is the table's off features (`[]` in memory);
  * `exactness` is `'exact'`.
  * No `tMem`, `projection`, `room` or `sizedBy` field is published, so T16 and T17 remove no documented field.
* `storageMode.ts` classification; `rateLimiter.ts` `META_PATTERNS`; openapi; AGENTS.md.
* Tests: `tests/scanStorageRoute.test.ts`.

- [ ] Tests first:
  - after a scan that met the room: one transition at 1,024, the reason naming an unknown projection and the default room, `disabled []`;
  - after its rescan: no transitions, the reason naming the previous count and the sized room;
  - a spill-labelled scan lists the table's off features;
  - 404 `SCAN_NOT_FOUND`;
  - the storage-mode coverage, openapi route coverage and rate-limit lane tests pass.
- [ ] Mutants: walks not mapped to transitions; the projection missing from the reason; `disabled` non-empty in memory; the route unclassified.
- [ ] Commit `feat(api): /api/scan/:id/storage says how the scan was held and whether it walked twice`.

**Proves:** a counted measure of the wasted walk for the gate, with no log parsing. The diagnosis had to infer it from timing and a sentence.

### U-35: Native completion without one long stall (TypeScript) — M
**Depends on:** U-31. It is sequenced after the memory-ceiling work because, once U-31 lands, rescans skip the columns ingest.
**Overlaps:**
* Phase 4 T16/T17: after conversions during the walk (P4-4a), the columns ingest runs only for MFT and pre-0.3.0 modules. The finalize fast path and the adopt slices still apply.
* T20 (Windows MFT uses the same ingest). Phase R W3.
* FG4: none.

**Files:**
* Part 1, shipped first:
  * `PackedScanStore.reserve(rows, nameBytes)`.
  * **The breadth-first fast path in `finalize()`:** `addNode` records whether every node was appended under a parent no smaller than the previous node's parent. That is `ingestColumns`' order, in which the renumbering is the identity. In that order `finalize` builds `childStart`/`childCnt` from the build lists, and **skips the trim copy when capacity equals n**. Any other order (the walker's) keeps the permutation (`scanStore.ts:1044-1060`).
  * `adoptNativeStore` (`nativeMemory.ts:151-222`): the text-candidate, cloud-candidate (`:181-195`, `store.path` per candidate) and denied-folder loops yield every slice. This is the memory path, the likely one for the owner's disk.
* Part 2, **only if the columns re-walk survives U-31 for some scans** (MFT, an under-projection):
  * `ingestColumnsAsync(scan, store, cols, rootPath, { yieldTurn, sliceNodes: 32_768, isCancelled })`, the same breadth-first pass with counters accumulated in locals and written once at the end;
  * used by `runNativeWalk` (`:808-810`) and `runMftWalk` (`:1228-1230`);
  * `ingestColumns` stays as the oracle.
* Tests: `tests/nativeCompletion.test.ts`.

- [ ] Tests first:
  - Differential: the async ingest + finalize on the nativeEdge fixture, on fuzz column sets whose parents interleave as several walk workers give, on a hard-link family across folders and on cloud candidates. Every column (read through the accessors) and every counter equals `ingestColumns` + finalize; pruned JSON is equal at {1, 50, 250k}.
  - The fast path's permutation loop runs 0 times on a breadth-first build and equals the forced slow path; a walker-order build takes the slow path.
  - `reserve(n)` then n `addNode` → 0 grows; capacity equal to n → 0 trim copies.
  - Yields = `ceil(n/slice)`; a probe runs first; a cancel after slice 2 → 2 × slice `addNode` calls and no completion.
  - `adoptNativeStore` yields on more than a slice of cloud candidates, and its counters equal the sync version, including R91's 2^53 case.
  - `nativeEquivalence` leg (c) green.
- [ ] Mutants: fast-path `>=` → `>`; the fast path on a non-monotone build; the yield removed; the cancel check removed; counters written per slice; the trim copy not skipped.
- [ ] Commit `perf(scan): native completion arrives in slices, and finalize no longer permutes a store already in order`.

**Proves:** removes the single 7.4 s (run 1) and 11.8 s (run 3) main-thread stall of ingest, finalize and `sumSizes` where it still runs. finalize's 11 % of samples and grow/copy's 3 % go away.
**Gate, each step reported separately:**
* **These stay single-turn and are reported:** `scanTake`'s hand-over (in Electron, external buffers are refused (R92) and every column is copied on the JS thread; T9c fixed only `storeTake`), the largest per-folder `kids.sort(byNameBytes)` (6 % self in run 3, over a folder of ≥ 421,546 entries), `finalize`, and `sumSizes`;
* peak RSS at completion;
* the adopt's largest stall, reported for the first time (the diagnosis did not measure it).

### U-36: On request, an index built from the scan itself — no second walk (TypeScript + UI) — L
**Depends on:** U-21 and U-22 (a large existing root is replaced without a main-thread delete), and U-1's `#indexLine`. **Owner:** U-Q5.
**Overlaps:**
* Phase 4: §S.7 took the "persistent index hand-off" off the off-lists because it did not read the store; now it does. T17's table gains the row. T19's aggregate notice names it. T23's DESIGN §6.1 text changes.
* **For spill** (the owner's disk projects above `T_mem`, OD9), this is unavailable (409) until T18. Then the FullPassRunner **streams rows to the index worker**. A SQLite writer cannot itself be a runner consumer, because R-S8 requires a pure function of (store, args).
* Phase R W2 reads it unchanged (no schema change).
* Phase 8 T8's pause applies.
* FG4: none.

**Files:**
* `POST /api/index/build` accepts an optional `scanId`. The scan must be complete (else the existing codes), have `rootPath === path` (else `400 SCAN_ROOT_MISMATCH`), and be held in memory. The handler itself asserts memory mode; otherwise `409 STORAGE_MODE`.
* `storageMode.ts`: a new row, "index from a scan": memory yes; **spill and aggregate off** (not `FULL_PASS`: a cell that is not `off` keeps today's handler in every mode until T18, and in spill the main thread holds only the summary store).
* **Feeder (main thread):**
  * reads the `PackedScanStore` in id order in chunks of ≤ `CHUNK` rows into transferable arrays (parent, size, mtime, flags, ext id, name offsets, UTF-8 name bytes);
  * runs `setImmediate` between chunks, with ≤ 2 chunks in flight (acknowledged);
  * **skips a node when `dead[id] = Removed || Virtual || dead[parent[id]]`**. This is valid because `parent[id] < id` (`native/index.d.ts:420-423`), and `removeNode` flags only the node itself (`scanStore.ts:1416-1424`);
  * touches the scan's `lastUsedAt` and records `store.version` at the start.
* **Writer (U-21's worker):**
  * ids are reserved up front for exactly N rows (U-D6): `id = base + storeId`, `parent_id = base + parent`;
  * sizes are the store's, already summed with hard-link later names at 0, so there is no roll-up;
  * `mtime` is `Math.round`ed; flags are mapped (Symlink, HardlinkDup, CloudPlaceholder → PLACEHOLDER, Hidden); `ext` comes from the store; `allocated`, `ino` and `nlink` are `NULL`;
  * the roots row gets **`mechanism = 'scan'`**, which marks allocation as not measured (U-D4, U-7). No schema change.
* **Freshness:** the root finishes **`stale`**, with the reason "built from the scan of <time>; changes since then are not in it", unless the scan's live watch ran continuously since its walk. If `store.version` changed during the build, it is `stale` with "Files changed while the index was being built from the scan." `onScanForgotten` cancels the build and discards the root.
* **UI:** `#indexLine` gains "Index this folder", which POSTs `{path, scanId}`. The line follows the job, and afterwards shows the measured whole-index size in U-22's honest words.
* Tests: `tests/indexFromScan.test.ts`.

- [ ] Tests first:
  - the core, run in-thread with `fs.promises` and `platform().fastEnumerate` spied → 0 calls to either; a structural test shows the worker entry is given the feeder, never the enumerator, for a scan source;
  - rows = the store's live, non-virtual nodes, on a fixture with an expanded container and **a removed folder that has children** (0 of its descendants written);
  - equivalence with the walk-built index on the same fixture: `readTree` JSON with the A2 fields stripped, and search hits (paths, sizes, order), over hard links, a symlink, and empty and hidden folders;
  - **the fixture also holds a zero-block sparse file and an ignored folder, and the test states the known differences** instead of passing over them:
    * the walk flags a zero-block file as a placeholder (`indexEngine.ts:461`); the scan does not (`SF_DATALESS` or the cloud table);
    * the scan honours "don't scan"; the walk does not;
    * which name of a hard-link pair keeps the size follows each engine's order;
    Each is recorded in DESIGN §16;
  - `/api/allocation` and `/api/allocation/file` → 409 `ALLOCATION_NOT_MEASURED`;
  - chunks per turn ≤ `CHUNK`, and ≤ 2 in flight (counters);
  - the scan forgotten mid-build → cancelled, 0 building roots; a `store.version` bump mid-build → stale with its reason; a normal finish → stale naming the scan's time;
  - refusals: an unknown `scanId` → 404; a root mismatch → 400; spill and aggregate → 409 `STORAGE_MODE`; the coverage test classifies the new body field;
  - ids reserved: another root's watcher inserting during the build → 0 collisions;
  - UI: the button sends exactly 1 POST carrying `scanId`.
- [ ] Mutants: `Virtual` not skipped; removal not propagated to descendants; `parent` mapped without `base`; a logical-size fallback for allocation; the version check removed; the forget hook unregistered; the chunk bound removed; the availability row missing; the root finishing `ready`.
- [ ] Commit `feat(index): a scanned folder can be indexed from the scan itself, with no second walk`.

**Proves:** for anyone who indexes a large folder, removes the second walk (the 1,853 s `readdir` + `lstat` re-walk) and the roll-up.
**Gate:** a whole-disk scan, then "Index this folder":
* `readdir`/`lstat` calls by TreeMap's process during the build = 0, by the worker's reported counters (`fs_usage` as a cross-check);
* main-loop stalls ≤ 243 ms;
* wall time and `dbBytes` reported.

### U-37: A compact first frame (conditional) (TypeScript + UI) — M
**Depends on:** U-19 and U-18. **Built only if**, after U-2, U-18, U-19 and U-20, the gate still shows the page's parse of the complete frame above 300 ms or the frame above 50 MB.
**Overlaps:** Phase R T-32; the index preview could adopt the same variant. FG4: none.
**Files:**
* An opt-in `?paths=derived` on `/progress` and `/result`. A child's `path` is omitted exactly when it equals `joinPath(parent path, store.sep, name)`, so legacy and cloud trees keep the paths that do not derive. The opted-in frame carries an additive `pathSep`.
* U-18's key includes the variant.
* The page asks for it, and `indexTree`'s single walk (`015-state-change-notification.js:44-58`) fills a missing `path` from the parent's before anything reads the tree.
* Tests: `tests/compactFrame.test.ts`.

- [ ] Tests first:
  - the compact frame, inflated by the page's own function, equals the default frame node for node (JSON with sorted keys) on fuzz trees, `/`, `C:\`, `cloud://` and a legacy mixed-separator tree;
  - goldens unchanged;
  - a static test: no page code enumerates tree-node keys;
  - compact chars < default chars on every fuzz tree;
  - openapi documents it.
- [ ] Mutants: `path` omitted when not derivable; the join without the trailing-separator rule; the default made compact.
- [ ] Commit `perf(frame): an opt-in first frame whose paths the page derives`.

**Proves:** addresses R93 (every node carries its full path). The design estimated about 45 % of today's bytes a node; the ~200 path chars of 355 are inferred, not measured.

### U-38: The clones line from Phase 5's clone evidence (TypeScript) — S — blocked on Phase 5 T8 and the native finder
**Depends on:** U-8 and Phase 5 T8 (`CloneEvidence`), plus `duplicateNative.ts`.
**Files:** `missingGigabytes.ts`. When the scan's native duplicate job is complete, the clones line is:
* `bytes = −(Σ over SharesAll families present in the scan of alloc × (members − 1))`;
* `count` = families;
* notes: it is a floor that leaves out files below the check's minimum size and `maybeShared` members (their count and bytes are stated as an upper bound);
* before then, `null` with "clone families are found by the duplicate check, which has not run for this scan".
**Reading the statement never starts hashing.** The bar nets the line into "scanned".
- [ ] Tests first: families of 3 × 1 MB and 2 × 5 MB plus one `maybeShared` → exactly −(2 MB + 5 MB), with the `maybeShared` member in the notes only; the job not run → null, with 0 job starts; balance holds; the bar nets it.
- [ ] Mutants: `maybeShared` summed; the statement starting the job; the line not netted.
- [ ] Commit `feat(missing-gb): the clone over-count, measured from the duplicate check's evidence`.

**Proves:** diagnosis (1), "APFS clones counted at full size", as a measured floor.

### U-39: A clone census during the native walk on macOS (Rust + TypeScript) — L — owner-gated (U-Q11)
**Depends on:** U-8. Built only on the owner's yes and after U-24 to U-29. **Overlaps:** Phase 5 P5-9 (this reverses "the walker's attribute list is not touched") and T8's shared `CloneEvidence`; Phase 4's sinks carry the stats only; the native handshake. FG4: none.
**Files:**
* `tm-walk` darwin: `bulk_step` passes `FSOPT_ATTR_CMN_EXTENDED` with `forkattr = ATTR_CMNEXT_EXT_FLAGS | ATTR_CMNEXT_CLONEID` (`darwin.rs:316`). `parse.rs` reads the fork group after the file group. `Meta` gains `shares` and `clone_id`.
* Each worker keeps a map `clone_id → (count, alloc)` for SharesAll files only, **keyed per inode, so hard-link names of one inode are one member** (the ingest already zeroes them). The map is merged at take, and **capped**: past the cap the result is flagged as capped.
* `WalkStats` gains `clone_families`, `clone_overcount_bytes`, `may_share_files`, `may_share_bytes` and `capped`. tm-store and napi carry them, with a native contract bump.
* Node stores them on the record, and the clones line becomes exact for full clones on native scans. The legacy engines report unknown (DESIGN §16).
- [ ] Tests first:
  - Rust parse tests with synthetic buffers including the fork group;
  - macOS live: a `clonefile` pair plus a real copy → 1 family, over-count = alloc; a hard link to a cloned file adds no member;
  - the equivalence gate unchanged;
  - **calls per directory: equal with and without the census for directories that fit one buffer; the extra calls per entry for large ones are counted and reported** (about 16 B more a record in the 256 KiB buffer means more calls past roughly 1,800 entries; `.fseventsd` alone holds about 94k);
  - the cap flags the result.
- [ ] Mutants: the fork group parsed before the file group; a family from MAY_SHARE alone; the clone id ignored; hard-link names counted as members; the cap ignored.
- [ ] Commit `feat(walk): native macOS scans measure the clone over-count as they walk`.

**Gate:** an interleaved bench (entries/s with and without the census, same corpus, on the owner's Mac) within the gate's band, the calls per entry reported, and the clones line equal to U-38's figure on the same disk.

### U-40: Plans, DESIGN, RISKS and AGENTS reconciled (docs) — S
**Depends on:** each item lands with or after the task it describes. Each task already updates its own AGENTS.md and openapi text; this task makes the cross-plan edits.
**Files and edits:**
* **Phase 4 plan:**
  * T10's line "A projection … is T12's chooser, not T10's" names U-30/U-31 as the interim;
  * T16's entry: use `projectEntries` unchanged; delete `memoryRoomFor`, `RESERVE_FACTOR` and T10b's second walk; add "the room is 1.25 × T_mem whatever the projection"; widen U-32's test to spill and aggregate; conversions pass `scan.boundary`;
  * T17's entry: `/storage` exists (U-34) and `/stats` reads the record (U-33);
  * T17a's "/stats stays the literal" text;
  * **line 118 ("disabled features exposed at GET /api/scan/:id/stats … disabled: string[]") → `/storage`**;
  * Q11's status (U-19);
  * T18: the index-from-scan stream (U-36).
* **Phase 8 plan:**
  * P8-23 ("it runs after every scan") and T8 (`#indexLine` exists; pause by the worker's flag; the duty by message);
  * T1's `ScanLive` interface gains `scanned`, `currentPath` and `phase`, with its open phase names, and `entriesPerSecond` uses `passEntries` during `walk-again`;
  * T9 and **line 814 ("31 once Phase 4 S6 adds disabled")**: `disabled[]` is on `/storage`, not `/stats`;
  * T14 is absorbed by U-23/U-24;
  * **P8-21 and Q5's "On macOS a full-disk scan is unchanged" is corrected**: the simulator volumes are mounts inside the data volume;
  * T18's first slice is U-14;
  * T10's copy test includes U-10's and U-11's sentences.
* **PLAN-TAURI:**
  * §0 point 2's "nothing in the server imports src/mcp" is true only after U-6;
  * T-8's D-2 half is done by U-3 as a named IPC, and the guard stays closed (U-D16);
  * T-4 and T-24 include `indexWorker.cjs` and `native/prebuilt`;
  * T-7's list of children gains `mount` and the batched `ps`;
  * Q4/T-26 re-verify U-2 in WebKit and WebView2.
* **DESIGN:**
  * §5 (P3-3 kept; the detector);
  * §6.1 ("As built through T10" gains the sized room and the visible second pass);
  * §10 item 1 (clones, U-8);
  * §12 (U-19's non-additive change under U-Q6);
  * §16: gdu refusals (U-12), gdu's omitted mount-point node, the scan-built index's differences (U-36), the first frame's hard budget (U-19).
* **RISKS:**
  * R95 re-rated from MEDIUM "time only" to HIGH with the measurements (96 s of 231.7 s; counter frozen 65 s to about 16 min and read as a hang; 88+ `/result` polls), marked mitigated by U-9/U-10/U-31 and closed by T16;
  * a new risk: memory mode above `T_mem` in the interim (unmeasured above 5M);
  * R82 closed for the first frame; R93 addressed by U-19/U-20 (U-37 if built).
* **AGENTS.md:** the P4-14 sentence, heartbeats, `/live`, `/boundary`, `/storage`, the `scanBoundary` setting, the index's `autoBuild`/`maxEntries`/`scanId`, `ALLOCATION_NOT_MEASURED`, the hard first-frame budget, `?maxNodes`, and the new Missing GB lines.

- [x] The doc-pinning tests stay green: `polishDocs`, apiContract/openapi route coverage, `storageModeTable`. Every quoted number is the diagnosis's or labelled arithmetic. (6 Oct 2026, for what landed in 5.2.0; see the Progress row.)
- [x] Commit `docs(track-u): the plans, DESIGN, RISKS and AGENTS as Track U built them`.

---

## The Track U gate

The roadmap's gate for the owner's three problems (`ULTRA-ROADMAP.md`, "The Track U gate"). It is run on the owner's Mac, on **the build that ships**, and carried as rows U1–U3 in Phase 8 T26's Definition-of-Done audit. A row that misses reads **"not met"** with its figure, and the release waits for the owner's decision.

### Conditions, recorded with every run
* **Machine and runtime:** the owner's Mac (Tier B), never a container. The packaged app, in **the Electron window or the Tauri window as it then exists**, with the runtime named (Electron main process, or the Node sidecar under Tauri).
* **Data:** a throwaway `TREEMAP_DATA_DIR`, never the owner's app data. Full Disk Access state from U-11's probe.
* **Instruments** (U-0's `bench/trackU/`):
  * `eld.cjs` preloaded into the backend: loop delay, stalls > 50 ms with the requests in flight, RSS and heap, 1-min load every second;
  * `sampler.cjs`: RSS and CPU every 250 ms;
  * `run-api.cjs` for API-driven scans and `ui-instrument.js` for the page;
  * `--cpu-prof` with `prof.cjs` to attribute every stall ≥ 500 ms;
  * `index-poll.cjs`; `gdu-shards.cjs` for any gdu row;
  * **Phase T's T-3 rAF recorder and T-2 process-tree sampler for the window.** Until T-3 exists: `ui-instrument.js` in the window's devtools in a development build of the same commit, labelled so.
* **Load:** the 1-min load average is recorded throughout. **A timing is compared with the diagnosis only when the load p50 during the scan is ≤ 6.7** (run 1's walking range, 4.4–6.7). Otherwise it is reported with its load and not compared. Counts (walks, requests, builds, frames, spawns) are compared at any load.
* **Disk:** entries and the cache state (the first scan after a reboot is cold) are recorded. The disk is not the diagnosis's (9.1–9.35M entries there, with the scratch worktrees and simulator volumes), and no figure is carried from one disk to the other.

### Protocol
1. 60 s idle baseline after launch.
2. A whole-disk scan through the UI flow: Browse → `/` → Scan.
3. 30 min idle after completion.
4. A second scan of `/`.
5. Five app opens.
6. The Full Disk Access flow: not granted → the button → grant → relaunch.
7. U-13's A/B (3 pairs).
8. The explicit index builds for U-15, U-21 and U-22.

### What "fixed" means, per symptom

| # | Measure (condition) | Before (diagnosis) | Fixed means | Tasks |
| --- | --- | --- | --- | --- |
| **U1 — "wasn't able to scan my entire disk"** | | | | |
| 1 | Whole-disk scan outcome | run 1 completed, but the counter stood still; 5.1.0 restarted in the walker | status `complete`, engine `native`, `fallbackReason` null, no Stop needed | U-9–U-12, U-24, U-32 |
| 2 | Native scan: 10-second windows during `walk` and `walk-again` in which none of `scanned`, `passEntries` or `currentPath` changed (`/live` at 1 Hz) | 65 s still (run 1), about 16 min (run 3) | **0 windows** (gdu shards and `arrange` reported) | U-2, U-9, U-10 |
| 3 | Refused folders named; gdu path | 981 refused, named by main; 5.1.0's gdu: 0 reported | `refused.dirs` equals the count the row shows; a gdu scan of `~` without Full Disk Access gives `refused.dirs > 0` | U-11, U-12 |
| 4 | Full Disk Access path | the button does nothing | the pane opens (yes/no recorded); probe `not-granted` → K1; after grant and relaunch, `granted` and **K2 < K1** | U-3, U-11 |
| 5 | Missing GB lines | no line for mounts, out-of-reach folders or clones; Unaccounted −110.2 GB against 313.2 GB used | every line a number or `null` with a reason (0 lines null without one); `mountedInside` = 0 with count = `/boundary`'s not-entered mounts; `outsideReach` names the Data-root items, each with a size or a reason; `clones` null with its reason, or U-38's floor; **Unaccounted within the owner's bound (U-Q18)** | U-8, U-24, U-28, U-29, U-38 |
| 6 | Empty Folders | offers `/Volumes`, `/dev`, `/System/Volumes` and every refused folder | **0** paths from `/boundary`, the fixed list, or the refused examples | U-4, U-24 |
| **U2 — "scanning for a super long time"** | | | | |
| 7 | Automatic index builds after a whole-disk scan | 1 build, 1,853 s | **0** | U-1 |
| 8 | Walks per rescan of `/` (`/storage` transitions) | 2 (run 1: 96 s of 231.7 s wasted) | **1** on the rescan; the first scan reported | U-30, U-31 |
| 9 | Budget of the interactive scan on mains power | `auto → balanced` (run 1, run 3) | `turbo` (A/B reported, U-13) | U-13 |
| 10 | Entries under `stay` against `cross`, same session | about 1.18M extra | the difference equals the `cross` scan's node count beneath the listed mounts | U-24 |
| 11 | Wall time of the whole-disk scan (load p50 ≤ 6.7) | 231.7 s for 9,115,094 entries (Balanced, two walks, load 4.4–6.7) | **the owner's bar (U-Q19)**; always reported with load, cache state and entries | all |
| 12 | Backend busy after "complete" (eld's blocked share over 30 min) | 1,853 s index build; 598.6 s blocked | within the idle baseline's share + 1 point | U-1, U-15, U-21 |
| **U3 — "glitching and lagging"** | | | | |
| 13 | Window frames over 32 ms, from Scan to 5 min after completion (T-3's recorder, visible window) | not measured (pane hidden); run 2's completion was one 5,184 ms long task | **0** (the roadmap's U3 bar); P8-6's count of gaps > 25.0 ms recorded beside it | all |
| 14 | UI long tasks caused by backend work (a page long task overlapping a backend stall > 50 ms, from `ui-instrument.js`/T-3 and `eld.cjs` times) | not measured in the window | **0** | U-1, U-2, U-15–U-22, U-35; Phase T step 1 |
| 15 | Largest backend stall during the scan and 30 min after (eld, attributed by `prof.cjs`) | 111.0 s, 40.8 s, 29.8 s (index); 11.8 s ingest (run 3); 13.4 s (suggestions); 3.6 s count pass | **≤ 243 ms**, the native walk's own worst in the diagnosis ("fine") | U-1, U-15–U-18, U-21, U-35 |
| 16 | `/result` requests per scan; frame builds per scan | 4 (run 3) and 8 (run 2) serializations; 88+ polls | **0** while the stream is healthy (≤ 1 if it closed); **1** build | U-2, U-18 |
| 17 | Complete frame: nodes, chars, page parse | 671,545 nodes, 238.6M chars, parse 1,885 ms | nodes ≤ max(budget, 1 + root children); chars and parse ms recorded | U-19, U-20, U-37 |
| 18 | App open, 5 times: `ps` spawns per `/api/zombie-handles`; report and MCP modules at boot | stalls 0.68–1.9 s and 0.56–1.65 s | **1** spawn; **0** modules; stalls recorded | U-5, U-6 |
| 19 | Heap and RSS peaks | heap 3,764 MB against 4,288 MB (index), RSS 3.99 GB; 3.2–3.5 GB at completion | recorded; the heap never within 10 % of the runtime's limit | U-1, U-15, U-18, U-21, U-35 |

**U1 passes** when rows 1–6 meet. **U2 passes** when rows 7–10 and 12 meet and row 11 meets the owner's bar. **U3 passes** when rows 13 and 14 are 0. Rows 15–19 are the diagnosis behind U3: each is reported, and a miss there names the task to reopen.

**Nothing is claimed beyond the measurement.**
* The record names the disk (entries, Full Disk Access state), the load, the runtime, the window and the cache state.
* The result holds for that Mac and that disk, and no row is extrapolated to another.
* The plan's own arithmetic predicts that **row 13 can miss at the moment of completion**. At the recommended 100,000-node first frame the parse alone is about 280 ms (arithmetic from run 3's measured rate), well over 32 ms. If it misses, the gate says so with the figure, and the owner chooses:
  * a smaller first frame (U-Q8);
  * U-37;
  * a follow-up that parses and indexes the frame off the page's main thread, which is named here and not designed.
  It is never passed by exception.

---

## Owner questions (Track U ids; each with the recommended answer)

Asked on 30 Sep 2026 (session ee1e3eb5), one round, recommendation first: U-Q2, U-Q3, U-Q5, U-Q12, U-Q13, U-Q14 and U-Q17 were answered as recommended; U-Q1 was already answered (OD16). The rest are asked when their tasks start.

1. **U-Q1 — Should scans you start yourself run at full speed (Turbo) by default?**
   * **Recorded as answered: yes** (`ULTRA-ROADMAP.md` OD16, 30 Sep 2026, "yes turbo by default"). U-13 builds it.
   * The recommended detail: Turbo on mains power, Balanced on battery, Eco only under serious heat. Scheduled, Autopilot and agent scans never run above the setting.
   * The A/B on your Mac is still measured. If Turbo is not faster, or the window's frame count gets worse, you see the result before the default ships.
2. **U-Q2 — Should TreeMap index a whole disk automatically after a scan?**
   * **Answered 30 Sep 2026: yes, as recommended** (the owner chose "Stop above 1 million items").
   * Recommended: **no**. A folder larger than the threshold is indexed only when you ask ("Index this folder", U-36), with the item count shown first and the measured size afterwards.
   * Without an index, a large folder loses:
     * (a) the instant paint of its last tree while it is scanned again (every action still waits for the full scan anyway);
     * (b) the header search for that folder across restarts (the highlight box and the query grammar still search the current scan for its 30 minutes);
     * (c) the allocation panel and the tooltip's shared/exclusive line (Missing GB accounts for sparse and cloned space at volume level from the scan);
     * (d) the "Index live" badge.
   * Live mode does not depend on the index.
   * You gain back 2.63 GB of index plus a 364 MB WAL, and about 31 minutes of an app that froze for up to 111 s at a time.
3. **U-Q3 — What threshold turns off the automatic index?** Recommended: **1,000,000 items**. The largest index recorded in this repo's notes is a 1,013,072-node home folder at 209 MB (`indexEngine.ts:191-198`). Build time at 1M on your Mac is not measured; the gate measures it once.
   * **Answered 30 Sep 2026: 1,000,000 items, as recommended.**
4. **U-Q4 — What happens to an oversized index already on your disk** (for example from whole-disk scans with 5.1.0)? Recommended:
   * it is **never deleted automatically**, and an upgrade does not delete it either (no schema change, U-D4);
   * it shows its date and "not refreshed automatically";
   * once removal is instant (U-22), it gets a "Remove index" control with its measured size.
5. **U-Q5 — Is it acceptable that an index built from the scan cannot say what files occupy on disk** (allocated blocks, hard-link counts)?
   * **Answered 30 Sep 2026: yes, say "not measured", as recommended** (including the Windows change).
   * Recommended: **yes**, for large folders indexed on request. The allocation panel answers "not measured for this index" in a sentence and never shows logical size as allocated.
   * On Windows the index has never measured allocation. After U-7 it says so there too, instead of showing logical size as allocated. That changes a response Windows users see today.
6. **U-Q6 — Phase 4's Q11, reopened: should the first tree stop before a folder whose children would push it past its node budget**, leaving that folder closed until you open it?
   * On the diagnosis Mac, one folder of at least 421,546 entries turned a 250,000-node budget into 671,545 nodes and 238.6 MB.
   * Recommended: **yes, with no tolerance**. The budget is honoured exactly, except that the scanned folder's own children always come. The JSON changes only for trees larger than the budget; the golden responses stay byte-identical.
7. **U-Q7 — When you open a folder with more direct children than one drill-in may carry (20,000), should TreeMap keep sending all of them?**
   * Recommended: **keep today's behaviour for Track U**. It happens only when you open that folder.
   * Plan the "N smaller items" tile as separate work, because every view (map, grid, sunburst, cart) must learn a new kind of node.
8. **U-Q8 — How much of the tree should the window receive when a scan finishes?**
   * Option A is 250,000 nodes (today's budget; about 89 MB at 355 characters a node).
   * Option B is 100,000 nodes (about 35.5 MB; a parse of about 280 ms by arithmetic from run 3's rate), with deeper folders fetched when opened, as the instant-open preview already does at 25,000.
   * Recommended: **100,000 for the window**, keeping 250,000 as the API's default for agents and the MCP server.
   * Row 13 of the gate can still miss at completion at 100,000; a smaller number trades that against more fetches when you open folders.
9. **U-Q9 — Phase 8's Q5, pulled forward: at a drive mounted inside the scanned folder, what should a scan do by default?**
   * Recommended: **"Stay on this drive"**, with "Include drives mounted inside it" one click away in Settings. A whole-disk scan of `/` then leaves out the two iOS Simulator volumes (about 35 GiB, about 1.18M entries), the simulator runtime bundle and the Clocks app wrapper, and the Dashboard names them.
   * On Linux, a scan of `/` stops counting separately mounted partitions such as `/home`, and says so.
   * Phase 8's text "On macOS a full-disk scan is unchanged" was wrong on this Mac, and U-40 corrects it.
10. **U-Q10 — Should the folders a scan of `/` cannot reach** (Spotlight's index, the file-change log, document versions, and folders in `/Volumes` that are not drives) **appear in the map, or only on the Missing Gigabytes receipt?**
    * Recommended: **only on the receipt**, each with its size or the reason it cannot be read. Most belong to macOS and must never be offered for deletion, and adding them to the tree would change what both engines must agree on.
    * A large non-drive folder in `/Volumes` is named with its size, and you can scan it directly.
11. **U-Q11 — Should a macOS scan measure clones as it walks (U-39)?**
    * This asks the native walker's existing listing call for two more attributes. It reverses Phase 5's rule that the walker's attribute list is not touched, and only native scans would report the figure.
    * Recommended: **yes, but only after U-24 to U-29 land, and only if an interleaved bench on your Mac shows no measurable slowdown.** Otherwise wait for Phase 5's duplicate check (U-38), which measures clones only among the files it examines.
12. **U-Q12 — Before a whole-disk or home-folder scan without Full Disk Access, should TreeMap show a notice while it scans, or stop and ask first?** Recommended: **the notice**, which does not block. The scan still runs, and the row names what it could not read.
   * **Answered 30 Sep 2026: the notice, as recommended** (the scan runs; every refused folder is named).
13. **U-Q13 — You asked for a banner of the form "X of your disk is unknown."** macOS will not let TreeMap measure the folders it refuses, and today's accounting runs 110 GB negative. Recommended:
   * **Answered 30 Sep 2026: as recommended** (count and examples, no byte figure for refused folders).
    * always give the count and examples, with "What's missing?" opening the receipt;
    * **print no byte figure**: the unaccounted remainder is net of clone over-counts, so it bounds nothing about the refused folders.
14. **U-Q14 — When a `dist` build cannot build the Rust module (no cargo), or packages another OS from the Mac without that OS's module, should it fail or ship without the module?** Recommended: **fail loudly**. An app without the module scans with gdu or the walker, silently and more slowly. Phase 8's `npm run fetch:native` (T20) can later supply a released module.
   * **Answered 30 Sep 2026: fail loudly, as recommended.**
15. **U-Q15 — Until Phase 4's T16 gives large trees spill mode, may a scan be walked once in memory mode with its room sized to twice its projection?**
    * Sizing starts when twice the projection exceeds 6.25M rows, i.e. **a projection above about 3.1M**. Such trees can then hold up to twice their projection in memory, above the 5M `T_mem` you set (Phase 4 Q3). They are already held in memory today, via the columns path.
    * Recommended: **yes, as an interim that T16 removes.**
    * If no, such scans go straight to the columns path: that still saves the wasted walk (41 %) but keeps the columns path's main-thread ingest (7.4–11.8 s).
16. **U-Q16 — P4-14 (your Q10 answer, 28 Sep): should a native failure above `T_mem` fail the scan now, before spill exists, instead of restarting it in the built-in walker?**
    * Today such a failure restarts from zero with the count reset: about 7 minutes for 9.35M entries at the measured 21.5k/s, which is the 5.1.0 behaviour you reported.
    * Recommended: **yes, now (U-32).**
    * A failure caused by a folder that stops answering (a stuck network or cloud folder) **repeats on every scan** until that folder answers or is added to "Don't scan". The message names the folder.
17. **U-Q17 — During a second pass, should the headline count hold at the first pass's figure, with the second pass's own count beside it?** Recommended: **hold it** (U-10). A count that drops is what made 5.1.0 look like it had started over; restarting the count under a "reading again" label is the alternative.
   * **Answered 30 Sep 2026: hold it, as recommended** (the second pass's own count shown beside it).
18. **U-Q18 — U1's bound on the unaccounted remainder.** Recommended:
    * U1 meets when Unaccounted is ≥ 0, or negative by no more than the clone over-count the clones line bounds (U-38's floor plus its stated `maybeShared` upper bound);
    * any positive remainder is listed with the unknown lines it includes (refused folders, purgeable space);
    * until U-38 exists, the row reads "met except the clone over-count, which TreeMap cannot yet measure", with the figure.
19. **U-Q19 — U2's time bar.** Recommended: at load p50 ≤ 6.7, **the whole scan (Scan to complete) runs at ≥ 71,000 entries/s**. That is run 1's second walk (9,115,094 entries in 128 s, arithmetic), so the whole scan costs no more than the one walk it needed then. It is set or revised by you after the first post-fix measurement.

---

## Critique record

Every critique point was checked. All but one are applied in the tasks above.

**Not applied: the critique is wrong, and the design is kept.**
* *"The overlaps cite 'Phase R W3'; PLAN-TAURI has no W3."* It has one: `docs/superpowers/plans/2026-09-30-phaseT-tauri.md` §2 Q3 lists groups W1–W9, and W3 is "scan orchestration". The citation stays (U-30, U-35).

**Half right (applied in its correct half):**
* *"On macOS and Linux a native failure falls to gdu first"* (critique of what the owner sees). This holds only when the module is missing or refused. A native walk that fails part-way goes to the built-in walker only, because gdu is wanted only when native is not eligible (`diskScanner.ts:689`), as the memory-ceiling critique found. U-10 names whichever engine the record says ran; U-32 and U-Q16 say "the built-in walker".

**Where a critique offered two fixes, the choice:**

| Design point | Chosen | Why |
| --- | --- | --- |
| Ship U-1 together with the builder rewrite, or with a "skip when current" rule | U-1 ships with the rule; U-15 follows after U-7 | U-1 alone removes the whole-disk build behind the 111 s block; the rewrite needs U-7's reader filters first |
| A missing count or `autoBuild`: "none" or "not over" | "none" | An unknown count is never read as small; the test's injection concern is met by keeping the call site |
| Keep `finishScan`'s call site, or update the injection lists | both | The call site keeps `buildIndexInBackground`; the lists that lift it gain the two functions it now calls |
| Mark a scan-built index with `mechanism 'scan'` or `ADD COLUMN` | `mechanism 'scan'` | No schema change at all; Phase R W2 reads existing databases unchanged |
| The doomed roots row: renamed, or moved to a tombstone table | renamed to a NUL-prefixed tombstone path | One statement, no new table, `UNIQUE(path)` freed at once |
| The native completion's ingest: slice it now, or only if the re-walk survives | reserve, the finalize fast path and the adopt slices first; the async ingest only if the columns path survives U-31 | Phase 4 converts during the walk (P4-4a); the ingest then runs only for MFT and old modules |
| The default room refused too | the native columns walk | It needs no sink; the legacy walker would restart at 21.5k/s |
| The second pass's count: a `pass` field in the frame, or `/live` | `/live` | P8-1 fixes the frame's shape |
| P4-14's ceiling clause: drop it or pin the invariant | dropped, and the invariant pinned by a test | Any room ≥ 1.25 × `T_mem`, so a ceiling implies `scanned > T_mem` |
| `/storage`'s interim fields: fit §S.6.5's names, or mark them interim | fit the names | T16/T17 then remove no documented field |
| The first frame's `overshoot`: in `pruneTree`, or kept off `PruneOptions` | implemented in `pruneTree` | The oracle and the store stay equal |
| The first frame's memory: cache or not | no cache; buffer only ≤ 32 MiB; single-flight only during a build | T9b's measured +186/+282 MB; after U-2 there is one reader |
| Cleanup suggestions and time: a clock bucket, or recompute stale-files each time | the bucket of the coarsest rule unit; recompute if a rule is finer than a minute | The same answer as a fresh call at that granularity, with the walk still memoised |
| Mounts under `cross`: allocated bytes per mount, or `null` | `null` with the logical total in the detail | Tracking allocation per mount would touch both engines' sparse accounting; `stay` is the recommended default |
| Turbo: `auto = false` with Node re-checking, or a Rust auto base | the Rust `autoBase` + a handshake bump | The governor already owns battery and heat; no polling loop in Node; a real-module test proves it |
| The "X unknown" figure | dropped; the link kept (U-11) | It bounds nothing (U-D14) |
| Cross-OS `dist` from the Mac | fails unless the target's module is on disk (U-Q14) | A check of the host's module would pass and then ship the wrong binary |

**Added from the critiques beyond the designs:** U-7 (index readers and A2 honesty), U-25 (the scanned-root rule reads what the scan listed), the backstop in U-4, comparability across boundary rules in U-24, the Live-mode filter in U-24, the U-0 instruments, and the explicit statement that the gate's row 13 can miss at completion.

---

## Risks

**Unmeasured, or measured on a different machine:**
* **The Electron window was never measured**, nor Electron's heap limit. The diagnosis ran plain Node with the pane hidden, and rAF gaps were not reported. Every window claim waits for the gate (T-3's recorder).
* Node workers are expected to share Electron's ~4 GB V8 memory cage (not verified). So U-15 lands before U-21, and `resourceLimits` is set.
* **The diagnosis's disk is not the owner's.** 9.1–9.35M entries here, against the owner's ~5.8M under 5.1.0. If the owner's tree has no overshooting folder, U-19 changes nothing there; if it stays under the ceiling, U-30 and U-31 change nothing there. The gate records entries and never carries a figure across disks.
* **Not measured:**
  * the synchronous delete of 9.46M rows at rebuild, cancel and startup;
  * DELETE plus VACUUM of 2.63 GB;
  * build time at 1M entries;
  * `readTree`'s hard-link `GROUP BY` for an oversized `/` root on every Scan of `/` (U-1 keeps that paint);
  * the memory path's `adoptNativeStore` + `sumSizes` at 9M rows;
  * Electron's `storeTakeInto` copy at 9M+ rows;
  * about 950 ms of `finishScan`'s 1,352 ms synchronous part (GC after the parse is likely, not verified);
  * the whole-disk FSEvents watcher's idle CPU on an unloaded machine (6.4 % was measured at load ≥ 9).

**The window at completion:**
* **The page's parse of the first frame** stays proportional to its nodes. At 100,000 nodes it is about 280 ms by arithmetic, so the roadmap's "0 frames over 32 ms" can miss at the moment of completion (gate row 13). The only named remedies are U-Q8, U-37, or a follow-up off the page's main thread that is not designed here.

**The index:**
* **SQLite's single write lock:** a main-thread write waits for the worker's current batch, synchronously, in better-sqlite3's busy wait. Batches are ≤ 500 rows (counted), and the main connection's `busy_timeout` is 1,000 ms.
* **better-sqlite3 in a worker on Windows** belongs to R96's class. The main thread loads it first, and tm-node pins itself, but it is verified on the Windows leg and inside the installed Electron.
* Portable mode's `':memory:'` keeps builds in-thread, relying on U-15's yields.
* **Freshness:** changes made between listing a folder and attaching the watcher are missed without a word, today (a walk up to 31 minutes long) and from the scan (its duration). U-36 finishes a scan-built root `stale` for this reason. The walk-built "Index live — always current" badge still overclaims across its own walk.
* **Bulk-load cost remains:** seven full and two partial secondary indexes are updated on every insert (about 52 µs of blocked thread a row as measured). A worker hides the stall, not the wall time or the WAL growth (364 MB). One database per root is deferred to Phase R W2.
* U-1's server cap discards up to `maxEntries` rows through today's synchronous cancel path until U-22 lands.
* **Sequencing with Phase 4:** once T16 keeps the owner's disk in spill (OD9), U-36 answers 409 for it until T18's runner streams rows to the index worker.

**Progress and the watchdog:**
* **Heartbeats make an idle stream chattier:** about one small frame every 2 s. External SSE consumers see repeated counts; the shapes are unchanged (P8-1).
* **A proxy-stalled stream** is now noticed up to about 30 s after completion (U-2's grace).
* **WebKit and WebView2** differ in EventSource reconnects, the 6-connection limit and hidden-window timers (1/s). U-2 is re-verified in T-26.
* The `arrange` phase cannot be seen while ingest blocks the server. Until U-35, a single `setImmediate` yield lets only a request already in flight see it.

**The first frame and completion work:**
* **Slices keep the event loop responsive but do not reduce CPU.** The lists and suggestions finish later in wall time. The gate reports time-to-answer as well as the largest stall.
* **The version guard** can restart a build or a walk while a watcher is busy. At most 3 attempts; the last runs in one turn, which is today's stall once.
* **U-19 changes the first frame for trees over the budget.** A folder that is large in bytes but very wide stays closed until opened, and opening it still sends every child through `/subtree` (U-Q7), so R82 remains for drill-in.
* **The finalize fast path** is exact only for the ingest's breadth-first order. A mistake would reorder JSON children. It is covered by the oracle differential and `nativeEquivalence` leg (c) on all four CI legs.

**The memory-ceiling interim:**
* **The used-inode hint is not a bound.** It counts inodes, not names, in the root's volume group only. With the ×2 room (11.46M from today's 5.73M used inodes) a first scan of `/` may still walk twice. U-9 and U-10 keep that visible.
* **Memory above `T_mem` is unmeasured:** about 0.67 GB of store for 9.1M rows by arithmetic from the measured 73 B a row, above the 700 MB plan gate, beside the columns path's measured completion peak.
* `nameBytes` values above 2^31 cross napi for the first time (U-31's test 4 drives 2,333,464,064). Reservations can be refused under strict overcommit, and U-31 then falls back to the default room, then to the native columns walk, never to the legacy walker.
* ~~`snapshots.json` is parsed on the main thread once per native scan. If eld shows that parse stalling, cache the latest count per root, invalidated by `saveSnapshot`.~~ **Built 2 Oct 2026 (U-30 follow-up):** each root's newest counts are kept in memory (`newestSnapshotCounts`), read once a process and rebuilt with no read by each save; a native scan start parses no history after the first, and a history changed outside the process is read again once. Each completion's `saveSnapshot` still parses and rewrites the whole file, as it always has.
* **U-32 turns a slow success into a visible failure for large trees.** A folder that stops answering fails every scan until it is excluded, and a "don't scan" pattern then routes the scan to the built-in walker (Step 0 confirms).
* If T16 lands without deleting `memoryRoomFor`, memory mode keeps holding trees above `T_mem` after spill exists. U-40 adds T16's test against it.

**Whole-disk accounting:**
* **The mount table is matched by spelling.** A mount spelled in a way nothing predicts is crossed. The walker's `st_dev` detector counts it and makes `mountedInside` unknown rather than 0; native and gdu have no detector until tm-walk's `DIR_MNTSTATUS_MNTPOINT` is used (a Rust change, not planned).
* The table is read once, at scan start, so a drive attached during a long scan is entered.
* Not entering a mount does not avoid stat'ing it. A dead network mount inside the tree can still block until the readdir deadline (30 s) or the native stall net fires.
* The `mount` subprocess may be unavailable in a packaged, sandboxed or sidecar context. The boundary is then unknown and said so, and scans cross as today (to verify in the packaged app).
* **Making "stay" the default changes results people may rely on**: a Linux `/` without `/home`, or a folder containing a mounted DMG. Totals drop, and only the Dashboard note and a new baseline explain why. `edgeCases.test.ts`'s pinned crossing and DESIGN §5 are amended deliberately.
* gdu's `-x` omits the mount-point node, which the walker and native keep as an empty folder. That is recorded in DESIGN §16, not normalised.
* U-29's identity rule assumes firmlinked spellings share `dev:ino` (measured on macOS 15 and 27). On a macOS where they do not, the guard makes the line unknown. The bounded walk can hit its cap on a huge stale folder in `/Volumes`, which is then unknown.
* **Until U-38 or U-39, a clone-heavy disk still ends with a negative Unaccounted**; only its attribution improves. The engineering scratch folders on the diagnosis Mac (147.5 GB apparent, many clones) are not the owner's, so the residual after the mount fix is never quoted as the owner's clone figure.
* **U-25 tightens a safety guard.** It refuses actions on paths under a scan's never-descend set, including `/Volumes/<drive>` after a scan of `/`; the person scans that drive to act there. It needs its security review before landing.

**Access, gdu, budget and packaging:**
* **macOS 27 is unverified** on four points: that the Full Disk Access probe folder opens exactly when access is on; that the `x-apple.systempreferences` URL still lands on the pane; whether a grant needs a relaunch; whether TreeMap appears in the list without "+". U-11's copy is written from the gate's answers.
* **An ad-hoc signature changes with every build**, so an update may silently drop the grant. The probe detects it; no copy is written until U-11's gate (d) measures it.
* **gdu's log format is not a stable interface.** It is pinned by an integration test on the bundled v5.36.1 (`scripts/fetchGdu.js`), and a gdu upgrade must re-run that test.
* **Turbo on a fanless Mac** may raise heat. The governor still steps down, and U-13's A/B reports it.
* Until Phase 5 P5-14, an unattended native scan that overlaps a person's scan lowers that scan to Balanced (recorded in `budget.changes`). Today's scheduled native scans do not get Eco at all (the governor is process-wide), and Phase 5 P5-14 and Phase 8 T12 own that.
* **U-13's native version bump** must be coordinated with Phase 4's own bumps; a local prebuilt is refused until `build:native` runs, which U-14 enforces for `dist`.
* **U-14 makes a `dist` without the Rust toolchain fail**, and cross-OS dists from the Mac fail without the target's module. That changes the owner's local build habit. The afterPack path is inferred from electron-builder's `asarUnpack` layout, and the check turns the inference into a loud failure.
* **U-6 changes the module graph.** A boot path relying on the side effects of importing `mcp/server` or `reportExport` would change, so the whole export suite runs and `mcp.tools` is pinned byte for byte.

**Merge conflicts and fragile tests:**
* The `/progress` timer body (`scanRoutes.ts:280-299`) is edited by U-2 and U-9, `followScanProgress` by U-2 and U-10, and the scan card's status line by U-10 and Phase 8 T3. Land them in order, or have one builder do each pair.
* **Tests slice the page by function names** (`frontendContract.test.ts:900-914`, `instantOpenCounts.test.ts:89`, `polishUiScan.test.ts:231`). They also inject fixed name lists into `finishScan` (`polishUiScan.test.ts:220-235`) and `renderIndexBadge` (`:614-640`). Renaming `buildIndexInBackground`, `openFromIndex` or `startScan`, or referencing a new identifier from `finishScan`, breaks them; both are constraints on U-1, U-2 and U-10.
