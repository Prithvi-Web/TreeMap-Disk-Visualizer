# TreeMap — 21-feature master prompt, session handoff

**Date:** 28 July 2026 (end of the v2.6.1 session)
**Status:** Phase 0 ✅ · Phase 1 ✅ (A1–A5) · **Phase 2 ✅** (B2, B3, B1, B4, B5) ·
index schema v3 ✅ · liquid-glass sidebar ✅ · CI green on macOS+Windows+Linux ✅ ·
**v2.6.1 RELEASED and INSTALLED** (all assets byte-verified against the update feeds)
**Suite:** 600/600 · typecheck clean · zero console errors
**Everything is committed AND pushed.** Working tree clean. No open threads.
**⏭️ NEXT: Phase 3, starting with C8 (rule packs) — the user has said "start Phase 3";
check in after each feature.**

Spec: `/Users/prithvivinay/Desktop/TreeMap-Master-Implementation-Prompt.md`

---

## Start here

```bash
cd "/Users/prithvivinay/Desktop/Claude Code/Treemap"
npm run build && npm test          # expect 600/600
npm run capabilities:report        # expect 9/12 available on this Mac
```

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

# ⏭️ THE NEXT TASK — C8: rule packs (Phase 3 opener)

§C8: refactor the existing `CleanupRules` Smart Suggestions
(`src/services/cleanupRules.ts`) into versioned JSON rule packs at
`src/services/rulepacks/{windows,macos,linux}.json` — each rule: pattern,
category (regenerable / cache / junk), OS applicability, confidence, human
description, restore command. Schema-validate at load; a malformed pack fails
loudly, never partially loads (reconcile with §6 failure isolation: the
suggestions feature reports itself broken with the reason — the app still
boots). Frontend: existing Smart Suggestions UI unchanged in behavior, plus a
"why is this suggested" affordance showing description + confidence.

**Acceptance (§C8):** every existing suggestion fires IDENTICALLY after the
refactor — write an explicit regression test per existing rule BEFORE moving
logic — and adding a rule to a pack JSON with no code change produces a new
suggestion on the next scan.

**Order after C8:** C6 (package-manager orphans) and C7 (game libraries)
expressed as rule packs → C1–C5 in any order → Phase 4 (D2 → D3 → D1) →
Phase 5 (full regression, §8 benchmark with real numbers, D1 security review,
README sweep — the README still documents only through B4; sidebar + B5 are
deliberately not in it yet).

Route changes must update the `ENDPOINTS` registry in `src/api/openapi.ts`
in the SAME commit (`tests/discoverability.test.ts` enforces it, including a
pinned destructive-endpoints list that is edited deliberately).

---

## What is done

Phase 0 platform layer + frontend registry · A1 persistent live index (schema
v3) · A2 allocation accounting · A3 placeholders · A4 instant search · A5
topology · B2 open-file guard · B3 Time Capsule · B1 Autopilot · B4 snapshot
restore · B5 zombie handles ("Held-Up Space" Dashboard card) · liquid-glass
sidebar · 3-OS CI · v2.6.0/2.6.1 released.

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
    The A1 watcher test flakes only when a build runs in the same shell command.

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

## Known gaps and honest limitations (stated in the UI — don't "fix" the caveats)

1. Clone/reflink detection impossible without native code (aggregate delta).
2. **Index size cap still unbuilt** (v3 defers it; capsule's capFor/planEviction
   are the model). 3. Windows zombie detection absent (honest reason shown).
4. B4's elevated branch never executed with a real password.
5. Dashboard horizontal scroll fixed (was the body min-width) — gone.
6. better_sqlite3.node ships inside app.asar (works; unpack if it misbehaves).
7. README documents through B4 — full pass scheduled Phase 5.
