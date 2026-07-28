# TreeMap — 21-feature master prompt, session handoff

**Date:** 28 July 2026 (third session of the day)
**Status:** Phase 0 ✅ · Phase 1 ✅ (A1–A5) · **Phase 2 ✅ COMPLETE** (B2, B3, B1, B4, B5) · index schema v3 ✅ · CI fixed ✅ · glass sidebar ✅
**Suite:** 600/600 · typecheck clean · zero console errors
**CI state after the user's push of run #7: macOS GREEN (first ever), Linux
and Windows red — their first real runs surfaced true platform findings, all
fixed in the commit after `aaef8ea`:** (1) base `getAllocatedSize` treated
`blocks === 0` as unknown and rounded a sparse file up to its logical size —
the same guard bug `blocksAreMeaningful` fixed in `toRawEntry` once before;
macOS never saw it because it overrides the method (Linux failure). (2) The
accountant reconstructed naive/dedup figures from the ZEROED duplicate rows,
whose `allocated` is NULL on Windows — now computed per family from the
unzeroed row (Windows failure). (3) Goldens are macOS-only BY CONSTRUCTION
(recorded against APFS readdir order; ext4 hash-orders, NTFS flips
separators) — skipped elsewhere with the reason. (4) Truncate-only files are
SOLID on NTFS unless FSCTL_SET_SPARSE — two sparse tests skip on win32 with
the recorded numbers. **Job logs are auth-gated even on public repos; the
workflow now prints every failing test as a PUBLIC annotation
(`::error::`, capped at 10/step) AND the full list into the step summary,
so future CI diagnosis never needs log access.**

**Run #8 findings (round two):** Linux went GREEN. macOS red on ONE test —
the A4 500k benchmark's absolute ceilings measured the loaded runner, not
the code (the project's own recorded lesson); ceilings loosened, the 4×
relationship assert unchanged. Windows red with ≥10 failures: SIX were the
contract suites breaking wholesale because a default Windows checkout
converts text to CRLF and every source-grepping regex anchors on \n —
fixed with `.gitattributes` (`* text=auto eol=lf`). Plus: sparse test in
the accountant suite gated on win32 (NTFS truncate-solid, same as the
others); autopilot's `/proc` refusal gated to POSIX (Windows resolves it
to `C:\proc`, an ordinary path). **Still expected red on Windows next
run:** `nodes accepts exactly 500` — mechanism CONFIRMED: withScan's
synthetic `/root` fixture meets the sanitizer, which path.resolve()s
requests to `C:\root\...` on a Windows host so store lookups miss; fixing
means resolve()-aware fixtures in apiHardening (and possibly siblings).
`windows: Program Files…` (appAttribution) — cause not yet pinned; pure
fixture passes on POSIX hosts, fails on a real Windows host. And possibly
more beyond the old annotation cap — the step summary will list them ALL
next run.
**v2.5.0 is built and installed** at `/Applications/TreeMap.app` — it predates
today's commits, so the installed app gains them at the next release build
(which will also rebuild its index once, v2 → v3).

**UI: the horizontal header is GONE.** Navigation is a collapsible liquid-glass
sidebar (`#sideNav`): search on top (glassmorphism), the ten views vertically,
Clean Up/Settings/Theme at the foot; ⌘B or the chevron collapses it to a 64px
icon rail (persisted in `localStorage['tm-sidenav']`); below 900px the expanded
panel overlays a scrim (`#navScrim` — body::after was already the film grain,
don't reuse it); below 640px the page scrolls (old floor was 1024 — that
`body min-width` was why the dashboard scrolled sideways at ~1286px).
`summonGlobalSearch()` opens the sidebar first when collapsed. The LG lens
target list swapped `header` → `#sideNav`. This also killed the zoom bug where
the search box clipped and overlapped its neighbours — a column has no row to
run out of.

Spec: `/Users/prithvivinay/Desktop/TreeMap-Master-Implementation-Prompt.md`

---

## Start here

```bash
cd "/Users/prithvivinay/Desktop/Claude Code/Treemap"
npm run build && npm test          # expect 599/599
npm run capabilities:report        # expect 9/12 available on this Mac
```

If `npm test` fails with **`NODE_MODULE_VERSION 125 … requires 137`**, run
`npm rebuild better-sqlite3` — see trap #1. It is not a code failure.

Read `docs/PLATFORM_NOTES.md` before touching anything platform-specific. It
records what was **measured** on real systems, including several behaviours that
contradict what the spec assumes.

---

## Working agreements (from the user — these override defaults)

- **No sub-agents, no workflows.** All work inline in the main session.
- **Plain English, copy-paste commands.** The user is not a coder. Say what a
  thing does before naming the file it lives in.
- **Check in after each feature**, not after each phase.
- **The bar is flawless.** Verify by driving the real app, not only tests.
- **Never leave a dev server running for the user** — see trap #2. This cost a
  full round trip when reported "errors" turned out to be my dev server being
  restarted underneath their browser tab.
- **Decisions already made:** macOS is verified for real; Windows/Linux are
  written against documented APIs and verified by CI. **Do not attempt N-API
  addons** (MFT parsing, `getattrlistbulk`, clone IDs, `fanotify`,
  RestartManager). Follow the spec's phase order.
- Push happens through **GitHub Desktop** — terminal `git push` has no
  credentials. Commit for them, then tell them to click **Push origin**.

---

# ✅ DONE THIS SESSION — index schema v3 (commit `bf641a7`) and B5

## Index schema v3 — the stored path is gone

The user-approved "drop the stored path" plan was executed exactly as designed
and measured against the same real `~/Library`:

| | v2 (before) | v3 (after) |
|---|---|---|
| Bytes/node | 486 | **190** (2.6× smaller; alarm line was 250) |
| Whole DB, ~225k nodes | 108.8 MB | **42.9 MB** |
| 100M-file projection | ~49 GB | **~19 GB** |
| `readTree`, 225k nodes | ~590 ms | **553 ms** |
| Search substring, 500k | 58 ms | **47 ms** |

How it works now, in one paragraph: nodes carry `(parent_id, name)` and no
path; `idx_nodes_child UNIQUE(parent_id, name)` replaces both the path index
and the parent index; a partial unique index finds a root's top node.
`findNodeIdByPath` (segment descent) and `pathResolver`/`pathOfNode`
(memoised ancestor walk) translate in both directions. `readTree` rebuilds
paths top-down during the descent; search scopes via a recursive-CTE id
closure and orders ties by `n.id` (there is no stored path to order by);
watcher deletes are id-closure CTEs, so LIKE-escaping is structurally gone.
Builds got faster: ids come from `lastInsertRowid`, so the per-batch
read-back SELECT no longer exists. Two latent watcher bugs were fixed in
passing (a directory-self event zeroing its rolled-up size; a child event
arriving before its parent's writing an invisible orphan — the ancestor chain
is now materialised). Verified: goldens byte-identical, `dbstat` shows no
path stored anywhere, schema-mismatch rebuild covers v2 → v3 with no
migration code.

## B5 — zombie-handle reclaim detector (Phase 2 complete)

- `GET /api/zombie-handles` — per-process report of space held by files
  deleted while still open. `POST /api/zombie-handles/restart` — SIGTERM
  only, identity-checked against pid reuse (`ps -o comm=`), never TreeMap
  itself, **never escalated to SIGKILL**; relaunches only macOS `.app`
  bundles via `open` after the exit is confirmed. Registered in `ENDPOINTS`
  and added to the **pinned destructive list** in
  `tests/discoverability.test.ts` — both deliberate.
- Dashboard card **"Held-Up Space"** below Disk Topology: all six §3.5
  states; rows fold behind "Show N more · X GB" past 8 (measured: this Mac
  had **330 holders / 2.5 GB**, mostly Chrome helpers — an unfolded list was
  unusable); restart goes through the shared confirm dialog with the
  §B5-required unsaved-work warning, worded differently for a reopenable
  Mac app vs a bare process.
- Verified in the real dev app end-to-end: a spawned holder of a deleted
  3 MB file appeared with exactly 3,145,728 bytes, the restart endpoint
  terminated it gracefully, and it left the report. Windows stays honestly
  unavailable (§B5: the reason is on the card).
- Platform notes: `ps -o comm=` prints the full executable path on macOS
  (measured); `kill(pid, 0)` throws EPERM for a live foreign process (only
  ESRCH means gone); the `.app` test takes the outermost bundle.

---

# ⏭️ THE NEXT TASK — Phase 3, starting with C8

Spec §7: **C8 (rule packs) first**, then C6 and C7 expressed as rule packs,
then C1–C5 in any order. C8 refactors the existing `CleanupRules` Smart
Suggestions into versioned JSON rule packs with a schema check that fails
loudly at startup — §C8's acceptance requires an explicit regression test
that every existing suggestion still fires identically. Stop and report at
the phase boundary per §7.

---

## What is done

| | Feature | State |
|---|---|---|
| **Phase 0** | Platform layer, capability detection, frontend re-architecture, CI on 3 OSes | ✅ |
| **A1** | Persistent live index (SQLite) | ✅ |
| **A2** | Byte-accurate sizing (hard links, sparse, compressed) | ✅ *(clones undetectable — gap #1)* |
| **A3** | Cloud placeholder + sparse accounting | ✅ |
| **A4** | Instant global search | ✅ |
| **A5** | RAID/LVM topology panel | ✅ |
| **B2** | Open-file guard before every delete | ✅ |
| **B3** | Time Capsule — recovery beyond the OS Trash | ✅ |
| **B1** | Autopilot cleanup with policy engine | ✅ |
| **B4** | Snapshot-aware restore beyond Trash | ✅ |
| **B5** | Zombie-handle reclaim detector | ✅ *(Windows honestly unavailable — gap #3)* |
| — | Index schema v3 (486 → 190 B/node) | ✅ |

### Measured on this Mac — throughput here is load-dominated, so state the machine's state with any number

- Whole disk `/`: **20.1 s**, 1,445,163 items, **72k items/s**, gdu-turbo
- Home dir: 10.0 s / 524,142 items *(with Full Disk Access)*
- Index build for home: **26.9 s** *(v2; v3 builds are faster — no read-back query)*
- Index density: **190 B/node** (v3) vs 486 (v2), measured on ~/Library, 225,596 nodes
- Reopen from index: **553 ms** in-process (v3; was 586 ms on v2, 8,549 ms before the heap fix)
- Search over 500,000 files: 1 ms extension, 47 ms substring (v3; was 58 ms)
- Zombie handles on this Mac: 330 processes holding 2.5 GB, almost all browser helpers
- A2 on a clone/hardlink/sparse fixture: naive 145.8 MB → real 34.3 MB
- Index total matches the gdu scanner byte-for-byte: 58,322,430 = 58,322,430

---

## Traps that will waste your time

**1. `electron-builder` silently breaks `npm test`.** Packaging rebuilds
`better-sqlite3` against **Electron's** ABI (NODE_MODULE_VERSION 125). The next
`npm test` under system Node (137) then fails **42 tests** with
`ERR_DLOPEN_FAILED`. It looks catastrophic and is not. Fix:
`npm rebuild better-sqlite3`. **Run this after any `electron-builder`
invocation.** The installed app is unaffected — it carries its own copy.

**2. Never leave a dev server running for the user.** They reported "80+ second
scans" and "multiple things failed to fetch". Neither was a bug: they had a
browser tab on my dev server (`localhost:4293`), which I stopped and started six
times while building. Every stop makes every panel say "failed to fetch". A
terminal-launched server also has **no Full Disk Access**, so it saw **91,000
fewer files** than the installed app and felt slower. Stop the preview server
when you finish, and point the user at `/Applications/TreeMap.app`.

**3. Every reinstall resets Full Disk Access.** An ad-hoc-signed rebuild gets a
new cdhash, so TCC silently stops honouring the still-visible toggle. Measured:
524,142 items before the v2.5.0 install, 466,868 after. **After any install,
tell the user to toggle TreeMap off→on in System Settings → Privacy & Security →
Full Disk Access and relaunch.**
`open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"`

**4. Contract-test slices anchored on a string that also occurs earlier slice
backwards to empty.** Hit three times now. `fn.indexOf('host.innerHTML')`
matched a loading branch *above* the target. Always pass the start index —
`fn.indexOf(end, startIdx)` — and assert the slice is non-empty. `appCode()`
also **strips comments**, so never anchor on a comment.

**5. Never assert absolute wall-clock latency.** It measures the CI runner.
Print the number with `t.diagnostic` and assert a machine-independent
*relationship* — the index scaling test asserts that 4× the directories costs
under 9× the time (quadratic would be ~16×).

**6. Don't phrase-match text built from a template.** A plural switch splits
`covers`/`cover` from `this period`, so a phrase regex breaks on a correct edit.
Assert the claim, not adjacency.

**7. `git stash` mid-feature is a trap.** It reverts tracked work while leaving
new untracked files, producing a hybrid that will not build. To compare against
a committed file use `git show HEAD:path`.

**Browser testing in the preview pane**

- `document.hidden` is `true`, so **`requestAnimationFrame` never fires**. The
  treemap presents inside rAF, so the canvas **screenshots blank while being
  perfectly fine**. Verify with `getImageData` across a grid, never a
  screenshot. Screenshots can also show stale compositor frames — assert against
  `textContent`/DOM, not pixels.
- Synthetic mouse events cannot test tooltips (same rAF cause). `window.TreeMap`
  exposes `showTooltip`, `allocationTooltipLine`, `resolveAllocation`.
- Treemap folder cells are **frames fully tiled by their children**, so clicking
  a folder's centre correctly hits a *file*. Set `#tmDepth` to 2 to test
  drill-in.

**Dev server**

- Launch config **`treemap-a5`** (port 4293, isolated `TREEMAP_DATA_DIR`) lives
  in the **parent** `Desktop/Claude Code/.claude/launch.json` — the repo-level
  `launch.json` is *not* what the preview tool reads.
- Never run one without `TREEMAP_DATA_DIR`: `startScheduler()` picks up the
  user's real recurring scans and writes their real snapshots, and Autopilot
  policies would run against their real files.

**Tests**

- Any suite touching app data must set `process.env.TREEMAP_DATA_DIR` **before
  importing the service** — `appDataDir()` reads the env at call time.
- The A1 watcher test (*an external create… within 2 seconds*) **flakes when a
  build runs concurrently in the same shell command**. Reproduced under exactly
  that condition; passes 3/3 in isolation and in clean full runs. Don't chase it
  as a new bug.

---

## Conventions that override the spec (§3.2 says follow the existing code)

- Error envelope is flat `{ error, code }` — **not** the spec's nested shape.
  `AppError` takes an optional `details` object, spread additively.
- Success bodies are flat objects — **not** `{ data: T }`.
- Test runner is `tsx --test` (node:test) — **do not add Vitest**.
- `GET /api/capabilities` was already the agent manifest; platform capabilities
  live at `GET /api/platform/capabilities`.
- `/api/snapshots` is **scan history**; OS filesystem snapshots live under
  `/api/system/snapshots/*` (B4 added `find-deleted` and `restore` there).
- **Any route change must update the `ENDPOINTS` registry in
  `src/api/openapi.ts` in the same commit** — `tests/discoverability.test.ts`
  enforces it, including a **pinned list of destructive endpoints** that must be
  edited deliberately.

---

## Per-feature decisions worth keeping

**A5 · Topology.** A Dashboard card, not a tab (§A5 requires it visible-but-
simple on plain machines). `LogicalVolumeInfo.usedBytes` is the volume's own
consumption — the only figure safe to sum across pool siblings; `sizeBytes` is a
shared ceiling. A booted Mac lists "Macintosh HD" twice (`disk3s1` plus sealed
boot snapshot `disk3s1s1`); the mapper collapses the pair or per-disk sums count
the OS twice.

**B2 · Open-file guard.** Lives **inside `moveToTrash`**, so every current and
future caller inherits it. Measured: `lsof <dir>` says **nothing** about files
open inside it, so the guard does one full enumeration intersected against the
delete set — flat in batch size (152 ms for 1 path, 378 ms for 1,000).
All-or-nothing: a batch containing one open file trashes nothing. It ignores
TreeMap's own pid, so a test fixture must hold the file from a **separate
process** or it proves nothing.

**B3 · Time Capsule.** `protectAndTrash()` passes only *protected* paths to
`moveToTrash`; anything it could not copy and verify is simply not deleted.
`hasPayload` is its own field — **never `heldBytes > 0`**, because an empty
folder and a zero-byte file hold nothing and must still restore. The cap is a
share of *usable* space (free + held), not free space, or it shrinks as the
capsule fills. An item larger than the whole cap is refused **without evicting
anything**. Symlinks are recorded as links, never followed.

**B1 · Autopilot.** `autopilot.ts` contains no delete at all — one call to
`protectAndTrash()`. First run of any policy is **always** a dry run;
`normalizePolicy` strips client-sent `approvedAt` so it cannot be skipped, and
editing a policy's scope revokes approval. `requireConfirmationAbove` **stops**
the run rather than trimming to the cap. A cooldown block must not stamp
`lastRunAt`. `agent-policy.json`'s `protectedPaths` bind Autopilot too. Bug
worth remembering: `run.skipped = skipped` once *overwrote* the policy-refusal
skips — both assignments now append.

**B4 · Snapshot restore.** Measured: `tmutil listlocalsnapshots` *and*
`tmutil localsnapshot` work unprivileged, but `mount_apfs` needs root
("Resource busy" on `/`, "Operation not permitted" on the Data volume). Btrfs is
the exception — an ordinary readable subvolume. Hence three states: `present`
(looked inside), `possible` (covers the period; confirming costs a password),
`absent`. Looking is free; only recovery elevates, once, for the whole search.
Restores write **beside** the original. The privileged helper is fixed text
written to a 0700 temp file with every value passed as argv — **inlined in the
.ts, not a sibling `.sh`**, because `/bin/sh` cannot execute a path inside
`app.asar`.

**Index heap fix (28 Jul).** `readTree` re-sorted the whole pending-directory
frontier on every iteration — ~10⁹ comparisons, **8,549 ms** for 224k nodes.
Replaced with a binary max-heap: **586 ms**, 14×, same order and same output.

---

## Known gaps and honest limitations

Stated **in the UI**, not hidden. Do not "fix" them by removing the caveats.

1. **Clone/reflink detection is impossible without native code.** An APFS clone
   gets its own inode, `nlink` stays 1, and `st.blocks` reports the full size.
   `du` gets this wrong identically. A2 reports the aggregate gap and labels
   totals `approximate`.
2. **The index still has no size cap.** Schema v3 cut the cost 2.6× (190
   B/node measured), which defers the problem but does not remove it. §B3
   mandates a capacity guard for the Time Capsule; the same reasoning applies
   here, and the capsule's `capFor`/`planEviction` are a ready-made model.
3. **Windows zombie-handle detection is absent** (B5 shipped without it).
   Both candidates need native code or a non-redistributable binary. The
   card shows the specific reason, and the restart endpoint answers the same
   409 — §B5's "pick one and do it completely" was resolved as: do the Unix
   mechanism completely, say why Windows cannot follow.
4. **B4's elevated branch was never executed** — it needs a real password.
   Verified unprivileged instead (every mount fails → NOTFOUND, exit 0, no
   leaked mount points, nothing written) plus unit-tested argv quoting against a
   hostile filename. **User-verifiable in one click.**
5. **Windows and Linux have never been executed.** CI runs the suite on
   `windows-latest` and `ubuntu-latest`. Read the Windows CI log for the
   `[platform record]` line — it prints what `stat.blocks` actually does there.
6. **`better_sqlite3.node` ships inside `app.asar` rather than `asarUnpack`ed.**
   Electron extracts it on load and it demonstrably works (a full index build
   ran in the installed app), but unpacking native modules is the conventional
   config. Worth tidying if native-module loading ever misbehaves.
7. **Dashboard scrolls horizontally at ~1286 px** viewport. Pre-existing —
   confirmed still present with the A5 topology card set to `display:none`.
   Not caused by this session's work.

---

## The road ahead: Phases 3–5

**Phase 3** C8 (rule packs) → C6, C7 → C1–C5; **Phase 4** D2 → D3 → D1;
**Phase 5** full regression, the §8 benchmark with real recorded numbers, a
security review of D1's network surface, and the README sweep.

**Per-feature decisions for B5** (worth keeping): the restart action is
SIGTERM-only and never escalates — a process that declines to quit is
*reported* as still running, because force-killing is exactly the unsaved-work
loss the confirmation warned about, done silently. Identity is verified via
`ps -o comm=` before any signal (pids are recycled); name matching tolerates a
prefix only at ≥ 9 chars, because old lsof truncates at 9 and Linux comm at 15,
while `node`/`nodemon` must not cross-match. `restartProcess` takes a `waitMs`
so the stubborn-process test doesn't cost five real seconds.

**README status:** documented through B4 (twelve views, all endpoints). B5 is
NOT yet in the README — §7 schedules the full README pass for Phase 5.

---

## New files this session

**This (second 28 Jul) session:** `src/services/zombieHandles.ts`,
`src/api/zombieRoutes.ts`, `tests/zombieHandles.test.ts` — plus schema v3
rewrites inside `indexEngine.ts`/`allocationAccountant.ts` and the B5 card in
`public/index.html`.

**Earlier sessions:** `src/platform/` (types, exec, base, index, capabilities, portable,
snapshotPaths + `macos/`, `linux/`, `windows/`),
`src/services/{indexEngine,allocationAccountant,placeholderResolver,timeCapsule,autopilot,snapshotRecovery}.ts`,
`src/api/{indexRoutes,platformRoutes,timeCapsuleRoutes,autopilotRoutes}.ts`,
`src/utils/{searchQuery,copyVerify}.ts`

**Tests:** `tests/{platform,platformCrossOs,frontendContract,indexEngine,allocationAccountant,placeholderResolver,indexSearch,openHandleGuard,timeCapsule,autopilot,snapshotRecovery}.test.ts`

**Other:** `.github/workflows/test.yml`, `docs/PLATFORM_NOTES.md`,
`scripts/{dev-isolated.js,report-capabilities.ts}`

**Dependencies added:** `better-sqlite3` (runtime, prebuilt), `@types/better-sqlite3`
(dev). `node:sqlite` was rejected: it needs Node ≥ 22.5 and Electron 31 bundles
Node 20.
