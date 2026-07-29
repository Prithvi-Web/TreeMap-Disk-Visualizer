# TreeMap — 21-feature master prompt, session handoff

**Date:** 28 July 2026 (Phase 3: C8, C6, C7 done)
**Status:** Phase 0 ✅ · Phase 1 ✅ (A1–A5) · Phase 2 ✅ (B2, B3, B1, B4, B5) ·
**Phase 3: C8 ✅ C6 ✅ C7 ✅** · index schema v3 ✅ · liquid-glass sidebar ✅ ·
CI green on macOS+Windows+Linux ✅ · v2.6.1 released and installed
**Suite:** 699 (698 pass, 1 linux-only skip) · typecheck clean · zero console errors
**Pushed:** near-dupe performance + C8 rule packs (origin/main = `518d83c`).
**3 commits on main still LOCAL — the user must click Push origin in GitHub
Desktop:** `c512038` C6 orphans · `1a5168c` C7 games · this handoff update.
**⏭️ NEXT: C1–C5 in any order** (C1 cost intelligence · C2 compression advisor ·
C3 download provenance · C4 SMART health · C5 secrets hygiene), then Phase 4
(D2 → D3 → D1), then Phase 5.

Spec: `/Users/prithvivinay/Desktop/TreeMap-Master-Implementation-Prompt.md`

---

## Start here

```bash
cd "/Users/prithvivinay/Desktop/Claude Code/Treemap"
npm run build && npm test          # expect 699 (698 pass, 1 skip)
npm run capabilities:report        # expect 9/12 available on this Mac
```

**`npm run build` is now `tsc && node scripts/copy-assets.js`** — tsc emits .js
only, so without that second step a built app ships with no rule packs and
Smart Suggestions reports itself broken. If you add another non-.ts runtime
asset, add its directory to `ASSET_DIRS` there.

If `npm test` fails with **`NODE_MODULE_VERSION … requires …`**, run
`npm rebuild better-sqlite3` (trap #1). Not a code failure.

Read `docs/PLATFORM_NOTES.md` before touching anything platform-specific.

---

## Working agreements (from the user — these override defaults)

- **No sub-agents, no workflows.** All work inline in the main session.
- **Plain English, copy-paste commands.** The user is not a coder.
- **Check in after each feature**, not each phase. The bar is flawless;
  verify by driving the real app, not only tests.
- **Never leave a dev server running un-announced** — a stopped server froze a
  page the user was reviewing and produced a false bug report; an announced
  running one is fine while they actively review UI.
- **No N-API addons** (MFT, getattrlistbulk, clone IDs, fanotify,
  RestartManager). Follow the spec's phase order.
- Push happens through **GitHub Desktop** (terminal git push has no creds).
  Commit for them, then tell them to click **Push origin**.

---

# ⏭️ THE NEXT TASK — C1 to C5, in any order

- **C1 · storage cost intelligence** — shipped pricing table with a visible
  "as of" date, `GET /api/cost/estimate`, what-if calculator. No live fetch.
- **C2 · media compression advisor** — ffprobe + HEVC estimates, hardware
  encode only, encode→verify→trash→promote, never overwrite in place.
  **Detect AV1 hardware encode at runtime; never silently substitute software.**
- **C3 · download provenance** — the platform layer already reads
  `com.apple.quarantine` (kMDItemDownloadedDate reads `(null)`, don't use it),
  Zone.Identifier and `user.xdg.origin.url`. Host prominently, full URL on
  demand, escaped, never auto-fetched.
- **C4 · SMART health** — `smartctl --json`; it is NOT installed on this Mac,
  so the honest-unavailable path is the one that gets exercised here.
  **Never editorialize about imminent failure.**
- **C5 · secrets hygiene** — filename/path patterns from the index, flagged
  only OUTSIDE expected locations. Never an automatic delete, never display
  contents, never leaves the machine.

Then Phase 4 (D2 → D3 → D1), then Phase 5 (full regression, §8 benchmark with
real numbers, D1 security review, README sweep — the README documents through
B4 plus the C8/C6/C7 additions; sidebar and B5 are still not in it).

Route changes must update the `ENDPOINTS` registry in `src/api/openapi.ts`
in the SAME commit (`tests/discoverability.test.ts` enforces it, including a
pinned destructive-endpoints list that is edited deliberately).

---

## C6 and C7 as built

- **C6** (`packageEcosystemScanner.ts`, `GET /api/packages/orphans`, "Package
  leftovers" panel in Clean Up ▸ Smart Suggestions). The rules are DATA: an
  ecosystem-tagged `project-directory` rule or the `package-cache` kind.
  Three classes — **orphan** (owner manifest gone), **active** (context only,
  no checkbox), **cache** (shared, never "orphaned"). **It refuses to guess:**
  with the manifest gone a directory is claimed only if one of the rule's
  `evidence` children is present, so an unidentifiable `target` is reported as
  nothing. The validator now REQUIRES `evidence` on any ecosystem-tagged rule.
  Extras: a venv whose `pyvenv.cfg` interpreter is gone is an orphan even with
  a live project; Homebrew Cellar reports superseded versions.
  **`activeCleanSelection()` is now keyed by path** — the same orphan is
  offered by both this panel and Smart Suggestions, and used to double-count.
- **C7** (`gameLibraryScanner.ts`, `GET /api/games`, Games tab). Steam / Epic /
  GOG / itch.io, per title split into base / shaderCache / workshop /
  compatPrefix / dlc. Detection is structural (`steamapps` anywhere; a
  `Manifests` dir holding `.item` files), not path-guessing. Includes a small
  total Valve KeyValues parser. **Shader caches are the ONLY component ever
  offered for removal** — a contract test pins that, and the dialog states the
  one-time stutter. DLC is only broken out when the game keeps its own folder;
  otherwise the UI says Steam does not separate it. Steam's `SizeOnDisk` is
  shown alongside ours ("matches Steam" within 2%, else Steam's number).
  **C7's "the game still launches and rebuilds" criterion cannot be automated**
  — it needs Steam and a real title; everything else was verified live.

## C8 as built — what a follow-up needs to know

- Packs live in `src/services/rulepacks/{common,macos,windows,linux}.json`;
  `README.md` beside them is the schema reference. Loader + validator:
  `src/services/rulePacks.ts`. `cleanupRules.ts` is now ONLY the matcher.
- **`common.json` is an addition to the spec's file list, on purpose** —
  fifteen rules are OS-independent and triplicating them is how a catalog
  drifts. Exactly two packs load: `common` + the current platform's.
- Five kinds: `project-directory` (manifest-gated, restore command),
  `directory`, `file`, `location` (token paths: `{home}`, `{localAppData}`,
  `{windir}`, `{systemDrive}`), `stale-files`. Order inside a pack is
  precedence — that is how `target` resolves Rust vs Maven.
- **Validation rejects unknown keys**, so `restoreComand` fails loudly. One bad
  pack fails the whole catalog; the route answers `available:false` + `reason`
  and the app is otherwise untouched.
- **`action: "advice"`** = listed for its size, no checkbox, no cart button, no
  select-all, and an `adviceCommand` instead. Use it for anything where the
  file IS the data (Docker/WSL vhdx) or the OS owns it (Windows.old, Windows
  Update cache, /var/cache/apt, the journal). **WinSxS is deliberately absent**
  — reason written in `rulepacks/README.md`; do not "complete" the seed list by
  adding it.
- `tests/cleanupRules.test.ts` is the behaviour lock (one test per shipped
  rule, written against the pre-refactor code). Treat a failure there as
  "behaviour changed", never as "update the expectation".
- Set `TREEMAP_RULEPACK_DIR` to test a pack directory without touching the repo.

---

## What is done

Phase 0 platform layer + frontend registry · A1 persistent live index (schema
v3) · A2 allocation accounting · A3 placeholders · A4 instant search · A5
topology · B2 open-file guard · B3 Time Capsule · B1 Autopilot · B4 snapshot
restore · B5 zombie handles ("Held-Up Space" Dashboard card) · **C8 rule
packs** · liquid-glass sidebar · 3-OS CI · v2.6.0/2.6.1 released.

### Near-duplicate performance (user-reported, fixed 28 Jul, `b8a0104`)

"TreeMap goes slow and glitchy after near-duplicates run" was five things, all
measured on a 1,820-image corpus that clustered into one group of 1,556:
thumbnails shared the 20-token API bucket (**60 concurrent → 20 OK, 40 × 429**,
and an `<img>` cannot retry, so they broke permanently); `Cache-Control:
no-store` with no server cache meant every re-render re-decoded ~20 ms per
image on the scanner's own libuv pool; the result rendered in one innerHTML
(**28,196 nodes, 7,830 listeners, a 224,052 px strip**); nothing was ever freed
because a hidden view is not an empty one; so `refreshCartButtons()` then cost
**30.5 ms of blocked main thread per cart click in every other view**.

Fixes: two rate-limiter lanes (preview 300/150, API unchanged at 20/10);
`services/thumbnailCache.ts` (LRU on path+mtime+size+dim, 4-way decode
semaphore, single-flight) + strong ETag and max-age; a windowed render (12
clusters, 24 images per cluster, explicit "show more" at both levels, with the
IntersectionObserver only as a convenience on top — it is skipped when
`document.hidden`); four delegated handlers instead of four per image; thumbs
retry twice before showing broken; `ndClearBody()` on unmount.
**After: 429s 0, DOM added 627, images in DOM 32, refreshCartButtons 0.5 ms, and
a re-render issues 0 requests and 0 bytes.**

### Measured on this Mac (state the machine's load with any number)

- Whole disk `/`: 20.1 s, 1,445,163 items (gdu-turbo). Home: 10.0 s / 524k.
- Index v3: **190 B/node** (was 486; 100M files ≈ 19 GB), readTree 553 ms
  for 225k nodes, substring search 47 ms over 500k, extension 1 ms.
- Zombie handles here: ~315 holders / ~2.1 GB (browser helpers).
- A2 clone fixture: naive 145.8 MB → real 34.3 MB.

---

## The release recipe (v2.6.x proven, do exactly this)

1. `npm version X.Y.Z --no-git-tag-version` + `npm install --package-lock-only`
   (the lock goes stale otherwise), commit "Release vX.Y.Z".
2. `npm run build && npx electron-builder --mac --dir` (local DMG step is
   broken — dmg-builder background.tiff — the CI builds real installers).
3. Verify bundle: PlistBuddy version, `Resources/gdu/gdu` present,
   `codesign --verify --deep --strict` ("0 valid identities" during build is
   normal — afterPack ad-hoc signs).
4. `osascript -e 'quit app "TreeMap"'` → `rm -rf /Applications/TreeMap.app` →
   `ditto release/mac-arm64/TreeMap.app /Applications/TreeMap.app` → open →
   find port via `lsof -nP -iTCP -sTCP:LISTEN -a -c TreeMap` → curl /api/system.
5. **`npm rebuild better-sqlite3`** immediately after any electron-builder run.
6. User pushes, then publishes via prefilled link
   `https://github.com/Prithvi-Web/TreeMap-Disk-Visualizer/releases/new?tag=vX.Y.Z&title=vX.Y.Z`
   (create-tag-on-publish fires Build & Release, which uploads all 8 assets).
7. Verify downloads: sha512+size of zip/dmg/exe against latest-mac.yml /
   latest.yml (the yml names the exe `TreeMap-Setup-…` while GitHub stores
   `TreeMap.Setup.…` — same file, updater handles it), mount the DMG, unzip +
   codesign, MZ header, and grep the shipped app.asar for the change itself.
8. **Every reinstall resets Full Disk Access** — user must toggle TreeMap
   off→on in System Settings → Privacy & Security → Full Disk Access and
   relaunch. (State unknown whether the user re-toggled after 2.6.1 — remind.)
   `open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"`

---

## CI: how it stays green, and how to diagnose it

- All three OSes are green as of `b5633ba`. **Job logs are login-gated even on
  public repos.** The workflow prints every failing TAP line and `# Error:`
  comment as PUBLIC annotations (cap 10/step) and the FULL list into the step
  summary — read them via
  `GET /repos/…/check-runs/<jobId>/annotations` (no auth). Never scroll the
  GitHub log viewer with scripts — it freezes the tab.
- **Wall-clock policy:** absolute latency asserts are sized for loaded shared
  runners (A4 benchmark ceilings; watcher budget is
  `process.env.CI ? 10s : 2s`). Machine-independent relationships are the real
  invariants; diagnostics print true figures.
- `.gitattributes` pins LF (CRLF checkout broke every source-grepping test).
  `scripts/run-tests.js` expands the test glob in JS (Windows shells don't).
- **Never `.unref()` a timer that is a promise's only path to resolution** —
  that stranded the whole suite ("event loop has already resolved").
- POSIX-shaped things that are DIFFERENT-not-broken on Windows (skip with the
  reason, don't "fix"): NTFS allocates truncate-only files solid; `blocks` is
  meaningless (index `allocated` NULL by design); fake-/proc fixtures can't
  exist (':' in symlink targets); `/proc` path guard resolves to `C:\proc`.
- Windows-host rules that ARE code rules: sanitizers `path.resolve()`
  requests, so fixtures live at `path.resolve('/root')`; appAttribution uses
  env locations only when `ctx.homeDir === os.homedir()`; test after()-hook
  `rmSync` needs `maxRetries/retryDelay` (WAL/watcher locks); async work must
  re-check `db === handle` after every await (`stillOpen` pattern in
  applyPendingChanges — closeIndex mid-burst was CI's last red and is a real
  SIGTERM race).

---

## Traps that will waste your time (all previously paid for)

1. **electron-builder silently breaks `npm test`** → `npm rebuild better-sqlite3`.
2. **Announce dev servers.** Launch config `treemap-a5` (port 4293, isolated
   TREEMAP_DATA_DIR) lives in the PARENT `Desktop/Claude Code/.claude/launch.json`.
   Never run one without TREEMAP_DATA_DIR (real scheduler + real snapshots).
3. **FDA resets on every reinstall** (see release recipe #8).
4. **Contract-test slices**: always `indexOf(end, startIdx)`, assert the slice
   non-empty; `appCode()` strips comments — never anchor on one. (Hit 4×.)
5. **Never assert absolute wall-clock in CI** — relationship + diagnostic.
6. **Don't phrase-match template-built text** — assert the claim.
7. **`git stash` mid-feature breaks the tree** — use `git show HEAD:path`.
8. **`/proc/*/fd` inside a TS block comment ends the comment at `*/`** — write
   `/proc/<pid>/fd`.
9. **The icon injector REPLACES `[data-icon]` elements** — classes/positioning
   on the same element are silently lost (put them on a wrapper), and
   `[data-icon]` CSS selectors are dead after boot (use `.ic`).
10. **body::after is the film-grain layer** — never reuse it (the nav scrim is
    `#navScrim`).
11. **Browser-pane testing:** rAF/transitions FREEZE when the pane is hidden —
    canvas verifies via `getImageData` grid (81/81), sidebar width via
    getBoundingClientRect after disabling transition; screenshots can be stale.
    Treemap folder cells are frames — center-clicks hit files (set `#tmDepth` 2).
    `window.TreeMap` exposes state/showTooltip/allocationTooltipLine.
12. Tests touching app data set `TREEMAP_DATA_DIR` before importing services.
    The A1 watcher test flakes only when a build runs in the same shell command
    — and on 28 Jul the B5 `lsof` test did the same thing once, in a
    `npm run build && npm test` one-liner. Both passed 3/3 in isolation
    afterwards. **Run the suite as its own command.**
13. **Thumbnails are not `api()` calls** — they are `<img src>`, so they get no
    429 backoff and no retry from the shared wrapper. That is why previews have
    their own rate-limit lane; do not merge the lanes back.
14. A test fixture that sets a key to `undefined` still has the KEY. The rule
    pack validator rejects unknown keys, so `{names: undefined}` fails with
    "unknown key names" rather than the assertion you meant — delete the key.

---

## Conventions that override the spec (§3.2: follow existing code)

- Error envelope FLAT `{ error, code }` (+ optional additive `details`);
  success bodies flat. Test runner `tsx --test` via `scripts/run-tests.js` —
  no Vitest. `GET /api/capabilities` is the agent manifest; platform caps at
  `GET /api/platform/capabilities`; `/api/snapshots` is scan history, OS
  snapshots under `/api/system/snapshots/*`.
- Frontend: one file, view registry via `registerView()` ONLY; `api()` wrapper
  (no raw fetch); `formatBytes` only; escapeHtml on every interpolation;
  all six §3.5 states per panel. Canvas reads CSS vars by name — never rename.
- **Sidebar** (`#sideNav`): search on top, ten views, Clean Up/Settings/Theme
  foot; ⌘B/chevron → 64px rail (`tm-sidenav` in localStorage); <900px expanded
  overlays `#navScrim`; <640px the page scrolls (body min-width 640 — the old
  1024 caused the dashboard sideways-scroll). `applySideNav` replays a window
  resize (transitionend + timer) because grid/treemap/trends re-layout on
  resize and main's width now changes at runtime; `main` has `width: 100%`
  (a grid item with auto margins otherwise SHRINK-WRAPS — the Grid view
  collapsed to 580px in a 1768px column). LG lens targets include `#sideNav`;
  the search results panel is a 94%-opaque frosted popover flying out at
  `left: calc(100% + 26px)` — keep it opaque, translucent was unreadable.

## Per-feature decisions worth keeping

- **A5**: Dashboard card; `usedBytes` is the only summable figure; booted Macs
  list the system volume twice (mapper collapses).
- **B2**: guard lives INSIDE `moveToTrash`; one enumeration intersected;
  all-or-nothing; ignores own pid (fixtures need a separate process).
- **B3**: `protectAndTrash` only deletes what it protected; `hasPayload` its
  own field; cap over usable space; symlinks recorded never followed.
- **B1**: no delete in autopilot.ts — one `protectAndTrash` call; first run
  always dry; normalizePolicy strips client approvedAt; cooldown block doesn't
  stamp lastRunAt; skips APPEND.
- **B4**: three states present/possible/absent; looking free, recovery
  elevates once; restores beside the original; privileged script inlined in
  the .ts (asar can't exec .sh); endpoints under `/api/system/snapshots/*`.
- **B5**: SIGTERM only, never escalated; identity via `ps -o comm=` (full path
  on macOS; prefix-match only ≥9 chars); `kill(pid,0)` EPERM = alive; relaunch
  only macOS .app via `open` after confirmed exit; restart endpoint is in the
  pinned destructive list; card folds past 8 rows.
- **Index v3**: identity `(parent_id, name)`; `findNodeIdByPath` /
  `pathResolver`; search ties order by `n.id`; subtree deletes are id-closure
  CTEs; builds take ids from lastInsertRowid (true inserts). Never re-add a
  stored path or a path_hash.
- **C8**: packs are data, `cleanupRules.ts` is only the matcher; one bad pack
  fails the whole catalog (never a partial load); unknown keys are rejected;
  `action: "advice"` means listed-but-never-deletable; WinSxS stays out.

## Known gaps and honest limitations (stated in the UI — don't "fix" the caveats)

1. Clone/reflink detection impossible without native code (aggregate delta).
2. **Index size cap still unbuilt** (v3 defers it; capsule's capFor/planEviction
   are the model). 3. Windows zombie detection absent (honest reason shown).
4. B4's elevated branch never executed with a real password.
5. Dashboard horizontal scroll fixed (was the body min-width) — gone.
6. better_sqlite3.node ships inside app.asar (works; unpack if it misbehaves).
7. README documents through B4 — full pass scheduled Phase 5.
