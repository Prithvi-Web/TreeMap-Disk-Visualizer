# TreeMap — session handoff

**Date:** 28 July 2026
**Status:** **ALL 21 FEATURES OF THE MASTER PROMPT ARE SHIPPED.**
Phase 0 ✅ · Phase 1 ✅ (A1–A5) · Phase 2 ✅ (B1–B5) · Phase 3 ✅ (C1–C8) ·
Phase 4 ✅ (D1, D2, D3)
**Suite:** 822 (820 pass, 2 platform-skips) · typecheck clean · zero console errors
**Everything is committed AND pushed.** `origin/main` = `931aeb0` plus the
Windows-CI guard commit on top. Working tree clean, no dev server running,
nothing of mine left on the user's machine (checked: `~/Library/Services` empty,
no `fleet.json` in the real app-data, no stray node processes).

**⏭️ NEXT: PHASE 5 — the closing phase.** Details below.

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

Expect **822 (820 pass, 2 skips)**.

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

# ⏭️ PHASE 5 — the closing phase

The spec's §11 definition of done. Five pieces, in this order:

### 1. Full regression in the real app
The suite is green, but §5 asks for the app to be driven. There are now
**thirteen tabs**: dashboard, treemap, grid, apps, **games**, duplicates,
**security**, **fleet**, trends, compare, offloaded, capsule, autopilot — plus
the **Clean Up** modal (Custom Rules / Smart Suggestions / **Shrink Video** /
Empty Folders / Cloud-safe) and the **Settings** modal (which now also holds the
right-click-menu control and the Cost currency picker). Open each once against a
real scan, watch the console, confirm the §3.5 states.

Launch config **`treemap-c8`** (port 4295, isolated `TREEMAP_DATA_DIR`) lives in
the PARENT `Desktop/Claude Code/.claude/launch.json` — *not* the repo's own.

### 2. §8 benchmark with real numbers
Prove the speed claim. **State the machine's load with every figure** — a
standing rule here, because the same code on the same tree measured 116,793
items/s on a quiet machine and ~47,000/s on a busy one. Prior figures to
reproduce against: whole disk `/` 20.1 s / 1,445,163 items (gdu-turbo); home
10.0 s / 524k; index v3 190 B/node; readTree 553 ms for 225k nodes.

### 3. D1 security review
The only feature that opens a network surface. Start by reading
`src/services/fleet/fleetSummary.ts` — the eleven-field allow-list **is** the
disclosure guarantee. Then re-run the end-to-end proof:

```bash
npm run fleet:acceptance
```

It spawns three real servers and checks: off by default ×3 · two pair in
seconds · the summary is exactly the allowed fields · the unpaired third gets
401 unauthenticated, 401 with a guessed key, 401 on a guessed pairing code, and
401 reaching for `/api/security/findings` · the peer port refuses loopback
entirely · remote scan refused before its separate opt-in and accepted after ·
the triggered scan really ran on the other machine.

### 4. README sweep — the biggest single gap
`README.md` describes the app **through B4**, plus API-table rows for C1–C8 and
D1–D3. Not described anywhere: the liquid-glass sidebar, B5 Held-Up Space, and
most of Phase 3/4's UI — Games, Security, Fleet, Cost to Keep, Drive Health,
Shrink Video, portable mode, the right-click menu.

### 5. Release
Follow the recipe below. **Suggest v2.7.0, not a patch** — this is 21 features.
Ask the user first; version numbers are their call.

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
  await.

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
6. **README documents through B4** — the Phase 5 sweep fixes this.

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
