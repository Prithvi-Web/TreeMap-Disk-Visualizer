# TreeMap — session handoff

## v4 — Phase 0 and Phase 1 complete (26 August 2026)

**Six commits on `main`, unpushed.** Suite **970 (968 pass, 2 skips)**, up from
906 at `2d47e98`. Typecheck clean, build clean, `npm run bench:v4` 6 pass /
3 not measurable in Node. Capabilities **12/16** (was 9/12).

| Commit | What |
| --- | --- |
| `6f3c9c4` | 0.2 the fact layer + `POST /api/facts` |
| `c3c7d6c` | 0.3 the performance gate, `npm run bench:v4` |
| `7717392` | 0.1 the recorded baseline |
| `f989f81` | 1.1 last-opened dates |
| `d6ee1bf` | 1.2 recoverability |

Spec: `/Users/prithvivinay/Desktop/TREEMAP-V4-MASTER-PROMPT.md`.
Baseline: `docs/superpowers/specs/2026-08-25-v4-baseline.md`.

### Corrections to the v4 brief, found by measuring

1. **The suite was 906, not the 828 the brief states** (and HANDOFF's own
   header said 899 while its "Start here" said 828). 906 is the floor.
2. **The golden lock covers nine surfaces, not eight** — `goldenHarness.ts`
   also captures the final SSE frame of `/api/scan/{id}/progress`.
3. **⌘K is already bound to global search** (A4), so Phase 9.1's command
   palette needs a different key. The user approved **⌘⇧P**.
4. **§4.1's 2,000-path cap collides with `guardBodyPaths`' 500** (same error
   code). Resolved with `guardBodyPathsMax(n)`; destructive routes keep 500,
   and a test asserts the separation.
5. **§2.5 budgets a sidecar at "400 ms for 5,000 paths" while §4.1 caps a
   request at 2,000.** Measured as three sequential batches against the one
   400 ms budget.

### New traps, all paid for

- **`kMDItemLastUsedDate` is dead on this macOS.** Spotlight indexing is ON,
  `mdimport -A` lists the attribute, and `mdfind` matches **zero files on the
  entire machine**. A capability probe based on `mdutil` alone would report the
  feature available and answer "unknown" forever. Availability is decided by
  whether Spotlight *answers*, probed against real paths.
- **`mdls` loses a whole batch to one missing path** — it abandons the plist,
  prints `could not find /x.` as text, and **exits 0**. Stat first; discard a
  result whose length does not match rather than mis-zipping.
- **`tmutil` exits 0 on failure too** (`destinationinfo`, `latestbackup`).
  Parse the text, never the exit code.
- **`tmutil isexcluded` says `[Included]` on a Mac with no backups at all.**
  It means "not on the exclusion list", not "backed up".
- **`git status --porcelain` omits ignored files**, so a repo full of
  `node_modules` reports clean and `fullyPushed` is true. Without
  `check-ignore`, the UI would say deleting it "costs one git clone".
- **tsx does not forward the outer process's V8 flags** to the child it
  spawns, so `node --expose-gc <tsx> bench-store.ts` measures an unsettled
  heap and reports ~123 B/node against a true 50.9. Flags go AFTER the tsx
  entry point.
- **Trap 2 below is real and I hit it.** Repeated 542-554 ms measurements of a
  provider I had just optimised turned out to be a **stale server still bound
  to the port** — the rebuilt one had died with EADDRINUSE, visible only in a
  log I had not read. The true figure was 75 ms. Verify the server you are
  measuring is the one you just built.

### What could NOT be verified on this machine

- **`useCount` has never returned a real value** — Spotlight supplies none here.
- **Time Machine's populated paths have never run**: this Mac has no backup
  destination, so only the not-configured branch has executed live.
- **Linux and Windows have never run at all** for 1.1 or 1.2. Both are covered
  through their parse seams against captured tool output.
- **No `noatime` volume and no cloud sync client** were available to exercise.

---

**Date:** 25 August 2026
**Status:** **v3.2.0 committed, AWAITING THE USER'S GITHUB DESKTOP PUSH + RELEASE.**
Three commits on `main` since the v3.1.0 release: `879eff7` scan cancellation,
`6a0debd` the VS Code extension, and the `Release v3.2.0` version bump.
Suite is **899 (897 pass, 2 platform skips)**; typecheck clean; build clean.

**Two features shipped this session, both from the user's own spec:**

1. **Stop a running scan.** The Scan button becomes a red Stop while a scan is
   in flight. `POST /api/scan/:scanId/cancel` settles the record, and a gdu
   subprocess is killed rather than left to finish its shard (measured: one
   process before, zero after). Design doc:
   `docs/superpowers/specs/2026-08-25-scan-cancellation-design.md`.
2. **A VS Code extension** in `vscode-extension/`. Clones or reuses a TreeMap
   checkout, builds it, runs its server as a child process, frames the
   visualizer in a webview. Design doc:
   `docs/superpowers/specs/2026-08-25-vscode-extension-design.md`.

**⚠️ THE RELEASE IS THE USER'S STEP AND IS WHAT THEY ACTUALLY WANT.** Their
stated goal is "people to be easily able to download the .dmg and .exe". That
happens through `.github/workflows/release.yml`, which builds BOTH on real
macOS and Windows runners when a `v*` tag is published. Do NOT try to build
Windows installers on the Mac — electron-builder needs Wine, which is not
installed, and CI does it properly anyway. Steps 6–7 of the release recipe
below are all that remain.

**New traps found this session (all paid for):**

- **A review subagent with write access edited the source mid-review.** One
  transiently mutated `gduScanner.ts` to test the new tests and restored it;
  another left a `clearTimeout` in `tests/scanCancel.test.ts` that got swept
  into a commit and made the file hang. **Use read-only agents (`agentType:
  'Explore'`) for review, and `git diff` the whole tree before committing.**
- **Never leave a non-unref'd `setTimeout` armed in a passing test.** The SSE
  cancellation test's 8s watchdog held the event loop for its full duration
  after the test passed — 8.8s per run of that file. Clear it on BOTH settle
  paths from inside the promise; clearing it from the outer `finally` instead
  made the test hang.
- **`npm` on Windows is `npm.cmd`.** libuv's PATH search only appends `.com`
  and `.exe` and never reads PATHEXT, so `spawn('npm', …, {shell:false})` is
  ENOENT there. Spawning `npm.cmd` directly is not the fix either — Node
  refuses a `.cmd` without a shell since the CVE-2024-27980 mitigation. Route
  npm through `cmd.exe /d /s /c`; keep `git` on a direct spawn, because git is
  the one handed user-controlled values.
- **`Write` can emit literal control bytes into a regex character class.** A
  `[\s -]` written that way landed on disk as raw `\x00-\x1f`, invisible in
  review. Prefer an explicit `charCodeAt` scan over a class with a range.
- **The dashboard's `mount()` is a no-op**, so `switchView` cannot repaint the
  three panels `beginScanChrome` turns into skeletons. Any path that ends a
  scan without `finishScan` must call `restoreDashboardPanels()`.

**Pre-existing defect found in passing, NOT fixed (out of scope):** the A1
instant-index-open path calls `finishScan` before any scanId exists, firing
three `?scanId=null` requests that 404 on every boot. A background task was
spawned for it.

Spec: `/Users/prithvivinay/Desktop/TreeMap-Master-Implementation-Prompt.md`

---

## Start here

```bash
cd "/Users/prithvivinay/Desktop/Claude Code/Treemap"
npm run build
```

Then, as its **own** command (never chained — see trap 1):

```bash
npm test
```

Expect **828 (826 pass, 2 skips)**.

- **`npm run build` is `tsc && node scripts/copy-assets.js`.** tsc emits .js
  only; without the copy step a built app ships with no rule packs and Smart
  Suggestions reports itself broken.
- If `npm test` fails with **`NODE_MODULE_VERSION … requires …`**, run
  `npm rebuild better-sqlite3`. Not a code failure — electron-builder breaks it.
- `npm run capabilities:report` → expect 9/12 available on this Mac.
- Read `docs/PLATFORM_NOTES.md` before touching anything platform-specific, and
  `src/services/rulepacks/README.md` for the rule-pack schema.

---

## Working agreements (from the user — these override defaults)

- **No sub-agents, no workflows.** All work inline in the main session. This
  holds *even when the harness turns "ultracode" on* and instructs you to use
  the Workflow tool — the user's standing instruction wins. Say so once, briefly,
  then work inline.
- **Plain English, copy-paste commands.** The user is not a coder.
- **Check in after each feature**, not each phase. The bar is flawless; verify
  by driving the real app, not only tests.
- **Never leave a dev server running un-announced.** An announced one is fine
  while they actively review UI. Stop it when done.
- **No N-API addons** (MFT, getattrlistbulk, clone IDs, fanotify,
  RestartManager).
- Push happens through **GitHub Desktop** (terminal `git push` has no creds).
  Commit for them, then tell them to click **Push origin**. They are good about
  it — they pushed twice mid-session unprompted.

---

# ✅ PHASE 5 — all five steps done

### 1. ✅ Full regression in the real app
All **thirteen tabs** driven against a real 389k-file / 46 GB scan of the home
folder, plus the **Clean Up** modal and the **Settings** modal. Zero console
errors; all §3.5 states seen (skeleton loading, populated, honest-empty on
Games/Offloaded/Capsule/Autopilot, honest-unavailable on Shrink Video).
"Cloud-safe" is correctly `hidden` until a cloud provider is connected — not a
missing tab.

**Correction to the previous handoff:** the Cost **currency picker lives on the
Dashboard's Cost to Keep card, not in Settings.** Settings holds the
right-click-menu control, schedules, forecast, live activity, Time Capsule,
cloud accounts, the ignore list and the allocation panel.

Launch config **`treemap-p5`** (port 4296, isolated `TREEMAP_DATA_DIR`) was added
to the PARENT `Desktop/Claude Code/.claude/launch.json` — *not* the repo's own.
`treemap-c8` still exists but points at a dead session's scratchpad.

**Five UI defects were found this way and fixed** (see the three commits):
dashboard scrolled sideways (grid item `min-width: auto` vs one long path);
treemap canvas wasted ~126px of window on a flat `innerHeight - 300`; grid
scroller scrolled internally against a `100vh - 256px` reserve while the window
had room; below 900px `main` rendered as a **64px sliver** because the fixed
sidebar leaves the body grid; treemap toolbar overhung the viewport with no
`flex-wrap`. Also: depth-1 folder tags printed straight through child labels.

### 2. ✅ §8 benchmark — measured, with load stated
Apple Silicon MacBook, normal desktop session (**not** a quiet box):

| Figure | Measured | Load at the time |
| --- | --- | --- |
| Whole disk `/` | 1,411,715 items in **16.4 s** = ~85,900 items/s (gdu-turbo) | 3.13 → 4.61 |
| Home folder | 458,661 items in **9.1 s** = ~50,300 items/s | 3.27 |
| Index density | **183.4 B/node** in use, 163.7 compacted | 3.28 |
| `readTree` | 250,000 nodes (its cap) in **~790 ms** = ~316k nodes/s | 4.63 |

The 190 B/node claim **holds**. These are now in the README's design notes.
Home reads *slower per item* than the whole disk because gdu-turbo parallelises
across top-level folders and `/` has far more of them — not a regression.

### 3. ✅ D1 security review — re-proven
`fleetSummary.ts` read and confirmed: an explicit **eleven-field allow-list** is
the only thing ever serialised, plus a forbidden-substring check that *throws*
rather than send anything smelling of a tree, a finding or a URL, and
`buildSummary` deliberately takes `SummaryInputs` rather than a `ScanResult` so a
scan store is never within reach. `npm run fleet:acceptance` → **ALL D1
ACCEPTANCE CHECKS PASSED** (11-key summary, 401 on every unpaired probe, peer
port refuses loopback, remote scan gated behind its separate opt-in).

Backend also swept independently: **46 GET endpoints, zero 5xx**; the
scanned-root rule verified on a *clean* server (dry-run AND real deletes both
refused with `OUTSIDE_SCAN_ROOT`, `/api/files/open` too); `CONFIRM_REQUIRED` on
trash-empty; blocklist fires on `/dev`, `/private/var/db`, `/System/Volumes/VM`.
Note `/System/Library` is deliberately **scannable** — the blocklist targets
virtual/volatile filesystems, and SIP protects the rest.

### 4. ✅ README sweep
Games, Security and Fleet added as view entries (Fleet full-width, since it is
the one network surface); Cost to Keep, Drive Health and Held-Up Space folded
into Dashboard; Shrink Video and package orphans into Clean Up; provenance into
Treemap; right-click menu and portable mode into Desktop extras; the liquid-glass
sidebar into "How it's built"; the §8 figures into the design notes.
`views.svg` was redrawn — it had been showing **ten** chips while the prose
claimed twelve and reality was fifteen.

### 5. ✅ Release v3.0.0 — built and installed; publishing is the user's step
The user chose **v3.0.0** (major, not minor: the app grew from a treemap into a
fifteen-view workbench, and Phase 3/4 shipped without ever being released).
Recipe steps 1–5 done. Steps 6–7 (push, publish, verify downloads) are theirs.

### Two product fixes they also asked for, done in `764c18d`
Both were "TreeMap offering an action whose cost exceeds the problem":

- **Security.** Google Drive's own `roots.pem` was reported SERIOUS with a
  "Move to .ssh" button — and that relocate is a *rename*, so taking it would
  have broken Google Drive. Files inside an installed program's own files
  (`.app` bundles, `Library/Application Support`, `Containers`, `AppData`,
  `node_modules`, `site-packages`) now carry `appOwned: true`: still listed,
  never called serious, never offered a move. Verified in the running app —
  the badge reads MINOR and there is no move button.
- **Empty Folders.** `.git/refs/tags` and `.git/objects/info` are empty in
  nearly every repo, and a signed `.app` ships dozens of empty `.lproj` folders
  **inside the code signature's seal** — deleting one frees ~0 bytes and stops
  the app launching. Tool-owned, app-owned and OS-Trash directories are now
  excluded from the offered list *and* the nested count, so the two numbers
  still agree. On this repo the offered list went **70 → 1**, and a fixture in
  the shipped build offers 2 of 7 empty dirs — exactly the user's own two.

**If revisiting:** `ownsItsContents()` in `diskScanner.ts` and
`isApplicationOwned()` in `securityHygieneScanner.ts` are the two lists.
`tests/emptyFolders.test.ts` and the app-owned test in
`tests/securityHygiene.test.ts` are the behaviour locks — a failure there means
behaviour changed, never "update the expectation".

---

## What each phase built (so you need not rediscover it)

### Phase 0 — platform layer + frontend registry
`src/platform/` with a full `PlatformProvider` for all three OSes, runtime
capability detection with honest reasons, `GET /api/platform/capabilities`,
3-OS CI. Frontend: view registry (**`registerView()` is the ONLY supported way
to add a view**), pub/sub, the single `api()` fetch wrapper, `Canvas2D` toolkit,
`window.TreeMap` debug handle.

### Phase 1 — A1–A5
A1 persistent live index (better-sqlite3, schema v3, 190 B/node) · A2 allocation
accounting · A3 cloud placeholders · A4 instant search · A5 volume topology.

### Phase 2 — B1–B5
B2 open-file guard · B3 Time Capsule · B1 Autopilot · B4 snapshot restore ·
B5 zombie handles.

### Phase 3 — C1–C8
- **C8 rule packs** (`services/rulepacks/*.json` + `rulePacks.ts`).
  `cleanupRules.ts` is now only the matcher. `common.json` is an addition to the
  spec's file list, on purpose (triplicating shared rules is how a catalog
  drifts). **Validation rejects unknown keys**; one bad pack fails the WHOLE
  catalog and the route answers `available:false` + reason. **`action:
  "advice"`** = listed for its size, no checkbox, no cart button — for things
  where the file IS the data (Docker/WSL vhdx) or the OS owns it. **WinSxS is
  deliberately absent**; reason in `rulepacks/README.md` — do not "complete" the
  seed list by adding it. `tests/cleanupRules.test.ts` is the behaviour lock: a
  failure there means behaviour changed, never "update the expectation".
- **C6 package orphans** (`packageEcosystemScanner.ts`). Rules are DATA
  (`ecosystem`-tagged rules + the `package-cache` kind). orphan / active /
  cache. **It refuses to guess**: with the owner manifest gone, a directory is
  claimed only if one of the rule's `evidence` children is present, so an
  unidentifiable `target` is reported as nothing.
- **C7 games** (`gameLibraryScanner.ts`). Steam/Epic/GOG/itch, per title split
  into base / shaderCache / workshop / compatPrefix / dlc. **Shader caches are
  the ONLY component ever offered for removal.** Hand-written Valve KeyValues
  parser. Steam's own `SizeOnDisk` is shown next to ours.
- **C5 secrets** (`securityHygieneScanner.ts`). Names and locations only, never
  opens a file. **No delete at all.** The relocate is a RENAME only — a
  copy-then-delete fallback would break the "nothing outside cleaner.ts removes
  a user file" guard. Both ends must be inside a scanned root.
- **C3 provenance** (`provenanceTracker.ts`). Host only, full URL behind a
  click, `textContent` never `innerHTML`, no anchor ever built, never fetched.
- **C4 drive health** (`driveHealthMonitor.ts`). **Report, never editorialise** —
  a test pins failure vocabulary out of both the service and the UI.
- **C1 cost** (`costIntelligence.ts`). The table SHIPS with the app; a test pins
  that nothing fetches. `asOf` is always on screen. A saving only exists when
  the TIER changes.
- **C2 compression** (`compressionAdvisor.ts`). Ordering is the guarantee:
  encode beside → probe → verify → trash → rename → utimes. Hardware encoders
  only. Tested through the `MediaTools` seam (`setMediaTools()`).

### Phase 4 — D1–D3
- **D2** (`GET`/`POST /api/platform/shell-integration` + a Settings control).
  `shellIntegrationInstalled()` reads the OS every time, never remembered — §D2's
  stated failure is an uninstall leaving a dead menu entry. The entry launches
  `<exe> <folder>` → `scanPathsFromArgv` → `requestScan`, the same path a dock
  drop uses.
- **D3** (`services/portableMode.ts`, `utils/portableBoot.ts`,
  `GET /api/platform/portable`, first-run screen, `dist:portable-*`). Signals:
  `TREEMAP_PORTABLE`, `PORTABLE_EXECUTABLE_DIR`, `treemap-portable.txt` marker.
  **Removable media is deliberately NOT a signal.** A read-only medium ⇒
  EPHEMERAL: memory-backed storage, SQLite `:memory:`, audit ring buffer, Time
  Capsule off with a reason. **Anything that resolves `appDataDir()` itself must
  consult `isEphemeral()`** — a test enforces it, because `diskScanner`'s mtime
  cache escaped the first fix and wrote to the host.
  *(Note: `src/platform/portable.ts` is NOT this — it is the fallback provider
  for unsupported OSes. An older handoff wrongly said it covered D3.)*
- **D1** (`services/fleet/*`, `/api/fleet*`, Fleet tab). **A SEPARATE LAN
  listener with three routes; the main API is not mounted on it and stays on
  127.0.0.1** — that isolation is the guarantee, not a check. One allow-list
  (`fleetSummary.ts`). Six-digit code, constant-time, spent once; a wrong guess
  does NOT close the window. Binds specific private IPv4s, never 0.0.0.0.
  **No remote-delete route exists.** mDNS hand-written on `dgram`, no dependency.

---

## The release recipe (v2.6.x proven — do exactly this)

1. `npm version X.Y.Z --no-git-tag-version` + `npm install --package-lock-only`
   (the lock goes stale otherwise), commit "Release vX.Y.Z".
2. `npm run build && npx electron-builder --mac --dir` (the local DMG step is
   broken — dmg-builder background.tiff — CI builds the real installers).
3. Verify the bundle: PlistBuddy version, `Resources/gdu/gdu` present,
   `codesign --verify --deep --strict` ("0 valid identities" during the build is
   normal — afterPack ad-hoc signs).
4. `osascript -e 'quit app "TreeMap"'` → `rm -rf /Applications/TreeMap.app` →
   `ditto release/mac-arm64/TreeMap.app /Applications/TreeMap.app` → open →
   find the port via `lsof -nP -iTCP -sTCP:LISTEN -a -c TreeMap` → curl
   `/api/system`.
5. **`npm rebuild better-sqlite3`** immediately after any electron-builder run.
6. The user pushes, then publishes via the prefilled link
   `https://github.com/Prithvi-Web/TreeMap-Disk-Visualizer/releases/new?tag=vX.Y.Z&title=vX.Y.Z`
   (create-tag-on-publish fires Build & Release, which uploads all 8 assets).
7. Verify downloads: sha512+size of zip/dmg/exe against latest-mac.yml /
   latest.yml (the yml names the exe `TreeMap-Setup-…` while GitHub stores
   `TreeMap.Setup.…` — same file), mount the DMG, unzip + codesign, MZ header,
   and grep the shipped app.asar for the change itself.
8. **Every reinstall resets Full Disk Access** — the user must toggle TreeMap
   off→on in System Settings → Privacy & Security → Full Disk Access and
   relaunch, or the trash features hide.
   `open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"`

---

## CI: how it stays green, and how to diagnose it

- **Job logs are login-gated even on public repos.** The workflow prints every
  failing TAP line as PUBLIC annotations (cap 10/step) and the full list into
  the step summary — read them via `GET /repos/…/check-runs/<jobId>/annotations`
  (no auth). Never scroll the GitHub log viewer with scripts; it freezes the tab.
- **Wall-clock policy:** absolute latency asserts are sized for loaded shared
  runners. Machine-independent relationships are the real invariants.
- `.gitattributes` pins LF. `scripts/run-tests.js` expands the test glob in JS.
- **Never `.unref()` a timer that is a promise's only path to resolution.**
- POSIX-shaped things that are DIFFERENT-not-broken on Windows — skip with the
  reason, don't "fix": NTFS allocates truncate-only files solid; `blocks` is
  meaningless; fake-`/proc` fixtures can't exist; **`chmod` cannot make a
  directory read-only** (which is why two D3 tests carry a `NO_CHMOD` skip).
- Windows-host rules that ARE code rules: sanitizers `path.resolve()` requests,
  so fixtures live at `path.resolve('/root')`; test after()-hook `rmSync` needs
  `maxRetries/retryDelay`; async work must re-check `db === handle` after every
  await. And **`path.join` always joins with the HOST's separator**, even when
  building another platform's folder names — assert path shapes with `[\\/]`,
  never a literal `/`. (This one broke Windows CI from the D3 commit until
  29 Jul: the previous session guarded two D3 tests but this third one only
  surfaced after its push, in a run nobody was left to read.)

---

## Traps that will waste your time (all previously paid for)

1. **Run `npm test` as its OWN command.** Chaining it after `npm run build` in
   one shell line has produced spurious `lsof` and watcher timeouts more than
   once. Also: **`npm test | grep … && git commit` does NOT gate the commit** —
   grep succeeds on a failure line too. Read the pass/fail counts before
   committing.
2. **Restart the dev server after `npm run build`.** A server started before a
   build runs the OLD dist. This caused the one real mistake of the last
   session: a security guard that was correct in source appeared not to fire,
   and a fixture file was moved into the user's real `~/.ssh` before it was
   caught and restored.
3. **electron-builder silently breaks `npm test`** → `npm rebuild better-sqlite3`.
4. **Announce dev servers**, and never run one without `TREEMAP_DATA_DIR` (real
   scheduler + real snapshots otherwise).
5. **FDA resets on every reinstall.**
6. **Contract-test slices**: always `indexOf(end, startIdx)` and assert the
   slice is non-empty. **`appCode()` strips comments — never anchor on one**,
   and never phrase-match template-built text that wraps across lines. This bit
   three more times last session.
7. **Adding a tab means adding it to `TAB_VIEWS`** in
   `tests/frontendContract.test.ts`. It caught Games, Security AND Fleet — that
   is its job, not a nuisance.
8. **A feature that starts something at boot needs its `init*()` CALLED.**
   `initFleet()` existed and was never wired into `startServer`, so an enabled
   fleet stayed dead until toggled. Grep for the init AND the shutdown when
   adding anything with a socket or a timer.
9. **`/api/scans` returns only completed scans and carries NO `status` field.**
   Filtering on one matches nothing, forever.
10. **`git stash` mid-feature breaks the tree** — use `git show HEAD:path`.
11. **`/proc/*/fd` inside a TS block comment ends the comment at `*/`** — write
    `/proc/<pid>/fd`.
12. **The icon injector REPLACES `[data-icon]` elements** — classes on the same
    element are silently lost (put them on a wrapper), and `[data-icon]` CSS
    selectors are dead after boot (use `.ic`).
13. **`body::after` is the film-grain layer** — never reuse it (the nav scrim is
    `#navScrim`).
14. **Browser-pane testing:** rAF and transitions FREEZE when the pane is
    hidden. Canvas verifies via a `getImageData` grid; screenshots can be stale.
    Treemap folder cells are frames — centre-clicks hit files (set `#tmDepth` 2).
    Lazy `<img>` never loads in an occluded pane — force `loading="eager"`.
    `window.TreeMap` exposes state / showTooltip / allocationTooltipLine /
    resolveAllocation / openPreview.
15. **Tests touching app data set `TREEMAP_DATA_DIR` before importing services.**
16. **Thumbnails are `<img src>`, not `api()` calls** — no 429 backoff and no
    retry from the shared wrapper. That is why previews have their own
    rate-limit lane; do not merge the lanes back.
17. **A test fixture that sets a key to `undefined` still HAS the key** — the
    rule-pack validator then fails on "unknown key" instead of your assertion.
18. **`String.replace` with a string pattern replaces only the FIRST match.**
19. **Do not machine-dump the rule pack JSON** — `json.dumps` escapes the em
    dashes and explodes every inline array. They are hand-formatted because
    people edit them.
20. **`sseSend(res, event)` takes TWO arguments**; the event carries its own
    `type` field.
21. **`getPolicy()` is async**; `capabilityState` is exported from
    `platform/capabilities`, not `platform/index`.
22. **The user's installed TreeMap.app runs and writes to the real app-data dir
    continuously.** Any before/after check against
    `~/Library/Application Support/TreeMap` is worthless — isolate with a fake
    `HOME` instead. That is how D3's remaining leak was finally attributed.
23. **Never open the live index from a second process while a server is using
    it.** `openIndex()` ends in `discardIncompleteBuilds()`, which DELETES every
    root still in `state = 'building'`. That is correct for the shipping app —
    one process, and a half-built root whose builder died is garbage — but an
    out-of-process benchmark that calls `readTree()` will silently wipe an index
    the server is still building, and then report `readTree -> null`. Build the
    index to `state = 'ready'` first (`POST /api/index/build`, poll
    `/api/index/:jobId/result` for 200), and for read-only measurement open the
    file with plain `better-sqlite3` rather than anything that reaches
    `openIndex()`.
24. **`index.db`'s file size is NOT bytes-per-node.** SQLite never returns pages
    to the OS, so a discarded whole-disk build leaves the file inflated — it read
    342 B/node that way against a true 183. Measure with `VACUUM INTO` a copy, or
    `(page_count - freelist_count) × page_size`. Do the `VACUUM INTO` from a
    `readonly: true` connection so the live database is never rewritten.
25. **Browser-pane refs go stale the moment the pane resizes**, and the pane
    resizes on its own. A `left_click` on a stale `ref_N` lands on whatever now
    occupies those coordinates. In this session that silently pressed **"Turn on
    for this network"** and opened a real LAN listener on the user's Wi-Fi. After
    ANY resize, re-run `read_page` before clicking — and after touching the Fleet
    view at all, verify with
    `curl -s .../api/fleet` **and** `lsof -nP -iTCP -sTCP:LISTEN | grep 4290`,
    because the on-screen state and the socket are two different facts.
26. **A hidden browser pane freezes timers, not just rAF.** `await new
    Promise(r => setTimeout(r, 60))` inside `javascript_tool` never resolves and
    the call times out at 30 s. Measure synchronously (read `scrollWidth` after
    forcing layout) — but remember canvases sized in JS will then be **stale from
    the previous width**, which reads exactly like an overflow bug. Trends and
    the treemap both looked broken at 860px for this reason; only the treemap
    toolbar was real. Confirm any canvas-view finding on a fresh load at the
    target width.

---

## Conventions that override the spec (§3.2: follow existing code)

- Error envelope FLAT `{ error, code }` (+ optional additive `details`); success
  bodies flat. Test runner `tsx --test` via `scripts/run-tests.js` — no Vitest.
- `GET /api/capabilities` is the agent manifest; platform capabilities live at
  `GET /api/platform/capabilities`; `/api/snapshots` is scan history, OS
  snapshots under `/api/system/snapshots/*`.
- **Route changes must update the `ENDPOINTS` registry in `src/api/openapi.ts`
  in the SAME commit** — `tests/discoverability.test.ts` enforces it, including
  a **sorted** pinned destructive-endpoints list that is edited deliberately.
- **`tests/openHandleGuard.test.ts` pins which files may remove anything**:
  `cleaner.ts`, `offload.ts`, `trash.ts`, `compressionAdvisor.ts`. Adding to it
  requires the same argument those four make, written down.
- Frontend: one file, `registerView()` only, the `api()` wrapper (no raw fetch),
  `formatBytes` only, `escapeHtml` on every interpolation, all six §3.5 states
  per panel. Canvas reads CSS vars by name — never rename them.
- Sidebar (`#sideNav`): ⌘B / chevron → 64px rail; `main` has `width: 100%` (a
  grid item with auto margins otherwise shrink-wraps).

---

## Known gaps and honest limitations (stated in the UI — don't "fix" the caveats)

1. Clone/reflink detection is impossible without native code (aggregate delta).
2. The index size cap is still unbuilt (v3 defers it).
3. Windows zombie detection is absent (honest reason shown).
4. B4's elevated branch has never executed with a real password.
5. `better_sqlite3.node` ships inside app.asar (works; unpack if it misbehaves).
6. ~~README documents through B4~~ — **fixed** by the Phase 5 sweep (`c2fedaa`).
7. **Empty Folders lists structural directories** — `~/.Trash`, `~/.cache`, and
   `.git/objects/info` / `.git/refs/tags` inside every repo, because they really
   are empty. Trash-only and recoverable, and the ignore list is documented as
   applying to Smart Suggestions *only*, so this is consistent with the stated
   contract rather than a bug — but "Select all — 1000 top-level empty folders"
   makes it a footgun worth a product decision. Left alone deliberately; raise it
   with the user rather than changing the scanner unasked.

## What could NOT be verified on this Mac (state it; never fake it)

- **ffmpeg and Homebrew are both absent**, so C2's real encode never ran. Only
  the honest-unavailable path was verified live; the pipeline is covered by 14
  tests through the tool seam.
- **smartctl is absent**, so C4's can't-know path is what runs here.
- **C7's "the game relaunches and rebuilds its shaders"** needs Steam and a real
  title.
- **D3's "runs from a real USB stick on a clean machine"** needs hardware. The
  no-trace guarantee itself IS proven, with an isolated `HOME`.
- **D2's "the entry visibly appears in Finder/Explorer/Nautilus"** needs a human
  with a mouse on each OS. The install/remove round-trips are proven.
- **`~/.Trash` is unreadable from the Claude shell (macOS TCC)**, so trash-only
  guarantees are confirmed via the code path and files leaving the fixture, not
  by listing the Trash.

## One intermittent worth knowing

Across eight full-suite runs at the end of the last session, one run failed a
single test and seven were clean; the failing name was not captured. The two
known flake shapes here are the A1 live-index watcher test and the B5 `lsof`
tests, both of which have only failed when another command was running in the
same shell. If it recurs, **read the name before re-running** — and see trap 1.
