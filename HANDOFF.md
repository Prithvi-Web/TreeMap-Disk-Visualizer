# TreeMap — 21-feature master prompt, session handoff

**Date:** 27 July 2026 · **Status:** Phase 0 + **Phase 1 complete (A1–A5)**, Phase 2 in progress (**B2, B3, B1 done**)
**Suite:** 566/566 passing (3 consecutive runs) · typecheck clean · zero console errors
**Through B3 is COMMITTED and pushed** (239000b, 6357274). **B1 is uncommitted.**

Spec: `/Users/prithvivinay/Desktop/TreeMap-Master-Implementation-Prompt.md`

---

## Start here

```bash
cd "/Users/prithvivinay/Desktop/Claude Code/Treemap"
npm run build && npm test          # expect 566/566
npm run capabilities:report        # expect 9/12 available on this Mac
```

Read `docs/PLATFORM_NOTES.md` before touching anything platform-specific. It
records what was **measured** on real systems, including several behaviours that
contradict what the spec assumes.

## Working agreements (from the user)

- **No sub-agents, no workflows.** All work inline in the main session.
- **Plain English, copy-paste commands.** The user is not a coder.
- **Check in after each feature**, not after each phase.
- **Decisions already made:** macOS is verified for real; Windows/Linux are
  written against documented APIs and verified by CI. **Do not attempt N-API
  addons** (MFT parsing, `getattrlistbulk`, clone IDs, `fanotify`,
  RestartManager). Follow the spec's phase order.

---

## What is done

| | Feature | State |
|---|---|---|
| **Phase 0** | Platform layer, capability detection, frontend re-architecture, CI on 3 OSes | ✅ Complete |
| **A1** | Persistent live index (SQLite) | ✅ Complete |
| **A2** | Byte-accurate sizing (hard links, sparse, compressed) | ✅ Complete *(clones not detectable — see below)* |
| **A3** | Cloud placeholder + sparse accounting | ✅ Complete |
| **A4** | Instant global search | ✅ Complete |
| **A5** | RAID/LVM topology panel | ✅ Complete |
| **B2** | Open-file guard before every delete | ✅ Complete |
| **B3** | Time Capsule — recovery beyond the OS Trash | ✅ Complete |
| **B1** | Autopilot cleanup with policy engine | ✅ Complete |
| **B4** | Snapshot-aware restore beyond Trash | ⬜ **NEXT** (Phase 2 order: B4 → B5) |

### Measured results (real hardware, this Mac)

- Second open of an indexed folder: **20 ms** (target < 200 ms)
- External file change → visible in index: **652 ms** (target < 2 s)
- Search over 500,000 files: **1 ms** extension, **58 ms** substring (target < 100 ms)
- Index total matches the gdu scanner byte-for-byte: 58,322,430 = 58,322,430
- A2 on a clone/hardlink/sparse fixture: naive **145.8 MB** → real **34.3 MB**

---

## A5 — what was decided and why (27 Jul 2026)

- **It is a Dashboard card (`#topologyCard`), not a tab.** §A5 says "panel on
  Dashboard" and says "tab" elsewhere when it means one; its acceptance
  criteria require the panel visible-but-simple on plain machines, which a
  capability-gated tab cannot do. The card consumes the capability machinery
  directly: known-unavailable renders the reason + a "Check again" that POSTs
  `…/capabilities/refresh`; unknown capabilities fetch anyway and render the
  409 reason. `loadCapabilities` now **emits `TOPIC.capabilities` on its
  failure path too** so the card can't hang on its skeleton.
- **`LogicalVolumeInfo` gained `usedBytes`** (additive): the volume's own
  consumption, the only figure safe to sum across pool siblings. `sizeBytes`
  stays the shared ceiling — summing it books an APFS container once per
  volume. Sources: macOS `CapacityInUse` (+ statfs for non-APFS partitions,
  A2's bavail/bfree semantics), Linux `FSUSED` (never `fssize − fsavail` —
  root reserve), Windows `Size − SizeRemaining` (correct there), ZFS
  `allocated`. Details in `docs/PLATFORM_NOTES.md`.
- **A booted Mac lists "Macintosh HD" twice** (`disk3s1` + sealed boot
  snapshot `disk3s1s1`, same `CapacityInUse`); the mapper collapses the pair
  to the mounted view or per-disk sums count the OS twice. Fixture-tested.
- Disk product name + SSD/HDD come from `diskutil info -plist <disk>` (one
  call per *physical disk*). Verified vs `df` within ~1.5% on this Mac.
- Multi-disk volumes (RAID/pool/LVM) render one combined section — splitting
  their bytes per member disk would be a made-up number.

## B2 — what was decided and why (27 Jul 2026)

- **The guard lives inside `moveToTrash`**, not in the routes. Every deletion
  already funnels through it, so Clean Up, the cart, Grid, the MCP tool,
  Offload and the still-unbuilt B1/B3 inherit it with no per-caller wiring —
  and there is no second delete path to keep in sync (§B2, §10).
- **Measured, and the reason the feature has teeth: `lsof <dir>` says NOTHING
  about a file open inside that directory.** The targeted form silently passed
  a folder full of open files, which is most of what Clean Up deletes. So
  `getOpenHandlesBatch` now means "handles at these paths **or beneath them**",
  reached by ONE full enumeration intersected in memory (§B2's own words) —
  macOS full `lsof` dump, Linux the existing `/proc` walk, Windows registers
  folder contents with Restart Manager (capped at 2,000, reporting
  `complete: false` when capped). Prefix matching carries a trailing separator
  so `/a/logs` never claims `/a/logs-archive`.
- **Cost is flat in batch size**: measured 152 ms for one path, 378 ms for
  1,000 (§B2 budget: under a second). A per-path implementation would be ~1000×.
- **All-or-nothing**: a batch containing one open file trashes *nothing*.
  Half-applying a delete the user never agreed to is worse than refusing.
- **`AppError` gained an optional `details`**, spread additively into the flat
  `{error, code}` envelope, so the 409 can ship `conflicts` (process names +
  pids). No existing response shape changed. The frontend `api()` wrapper now
  carries any non-error/code envelope key onto the thrown error.
- **The guard ignores TreeMap's own pid** — its duplicate finder streams files
  constantly and "TreeMap has this file open" is noise. Consequence for tests:
  a fixture must hold the file from a **separate process** or it proves nothing
  (`holdOpenElsewhere` in tests/openHandleGuard.test.ts).
- **Unknown ≠ clear.** A failed probe returns `checked: false` and still lets
  the delete through; refusing every deletion because `lsof` is missing would
  be worse than the risk. The dialog says which of the two it was.
- **Offload pre-flights before copying** (so you aren't told after a 50 GB
  verified copy) and, if a conflict appears at its trash step anyway, keeps the
  copies and reports it rather than rolling back — matching what it already did
  for a failed trash.

## B3 — what was decided and why (27 Jul 2026)

- **`protectAndTrash()` is the single automated-deletion entry point**, and the
  invariant is structural rather than a rule someone must remember: it passes
  only *protected* paths to `moveToTrash`. Anything it could not copy and
  verify is simply not deleted, and says why. `protectItems()` is the capture
  half on its own (no delete in it at all) — used by the tests, and available
  to B1's simulate mode.
- **Payload presence is its own field (`hasPayload`), not `heldBytes > 0`.**
  Found by a test: an empty folder and a zero-byte file hold zero bytes and are
  both perfectly restorable, so reading emptiness as absence made them
  permanently unrestorable. Do not re-collapse these two facts.
- **The cap is a share of *usable* space** (free + already-held), not of free
  space. Over free space alone the ceiling shrinks as the capsule fills, so it
  would evict itself into an ever-smaller corner and "10%" would mean something
  different at every moment. `capFor()` is pure and tested.
- **An item bigger than the whole cap is refused without evicting anything** —
  otherwise the capsule clears itself to make room for something that was never
  going to fit, and fails anyway. Pinned by a test.
- **Eviction, expiry, refusal and loss are all surfaced in the panel**
  ("What the Time Capsule couldn't keep"), because §B3's "warn rather than
  silently skipping protection" is only satisfied if the warning reaches a
  person. An item that has *already vanished* (ENOENT) is deliberately NOT
  warned about — nothing was lost and nothing was deleted.
- **Symlinks are recorded as links, never followed**; empty directories are
  recorded too. Both matter because the folders this protects (node_modules,
  virtualenvs) are full of them, and following a link to a parent walks forever.
- **Restore refuses when the original path is occupied** rather than
  overwriting, mirroring Offload. On success the payload is dropped and the
  space returned — the bytes are home, a second copy is pure cost.
- **Copy/verify now lives in `src/utils/copyVerify.ts`**, shared by Offload and
  the capsule: one never-clobber `wx` copy, one read-back verify. The frontend
  got the same treatment — `watchJob()` drives the one progress dialog for both.
- The trash-bypass guard in `tests/openHandleGuard.test.ts` was **not** given a
  blanket allow for `timeCapsule.ts`. Instead the rollback variables are named
  `…ByThisRestore`, so a bare delete of a *user's* file added there later still
  fails that test.

## B1 — what was decided and why (27 Jul 2026)

- **`autopilot.ts` contains no delete at all.** A run resolves candidates
  through `CleanupRules`, then makes exactly one call — `protectAndTrash()` —
  which already routes through B2's open-file guard and B3's capsule. That is
  the whole reason B2 and B3 came first.
- **A policy carries a `path`.** §B1's field list omits one, but candidates
  come from `CleanupRules` matching a scanned tree, so a policy must say which
  tree. Pointing one at the filesystem root is refused outright
  (`POLICY_PATH_TOO_BROAD`) — the shared sanitizer allows `/` because scanning
  it is reasonable, and deleting from it unattended is not.
- **Approval is engine-owned.** `normalizePolicy` strips client-sent
  `approvedAt`/`lastRunAt`, so the mandatory first dry run cannot be skipped by
  a crafted request. Editing a policy's *scope* (path or match) revokes its
  approval — otherwise "approve a tiny dry run, then widen it" walks straight
  past the rail.
- **Approving clears `lastRunAt`**, or the user waits out a full cooldown right
  after saying yes.
- **`requireConfirmationAbove` stops the run**; it does not trim to the cap and
  proceed. The size itself is the signal the policy is wrong.
- **A cooldown block does not stamp `lastRunAt`** — a minute-by-minute tick
  would otherwise push the next real run away forever.
- **agent-policy.json's `protectedPaths` bind Autopilot too**, per candidate
  (skipped with the reason, not an aborted run). It was written for the API
  surface, but an unattended deleter is exactly what those paths guard against.
- **Bug worth remembering:** `run.skipped = skipped` from the cap step
  *overwrote* the policy-refusal skips recorded earlier. Both assignments now
  append. A skipped item that vanishes from the record is the one thing the
  user most needs to see.
- Run history is JSON, not the SQLite index §B1's "autopilot_runs table"
  implies — the index is explicitly rebuildable and wiped on schema change, and
  undo history that vanishes with a rebuild would not be history.
- `simulatePolicy()` is separate from `runPolicy()` so the editor's Preview
  writes nothing and never consumes the schedule.
- Autopilot rides the **existing Scheduler tick** rather than a second timer.

## B4 is next

Snapshot-aware restore (§B4): bridge the existing APFS/Btrfs/VSS snapshot
accounting into an active restore path, surfaced on Compare's "removed" rows.
`PlatformProvider` already has `listSnapshots` and `readFromSnapshot` for all
three OSes from Phase 0 — B4 is mostly the service + the Compare-row action.
Note §B4's rule: restores go to a *new* location by default, never overwriting
a current file at the same path.

---

## Known gaps and honest limitations

These are **stated in the UI**, not hidden. Do not "fix" them by removing the
caveats.

1. **Clone/reflink detection is impossible without native code.** Measured: an
   APFS clone gets its own inode, `nlink` stays 1, and `st.blocks` reports the
   full size — cloning a 50 MB file consumed **−4,096 bytes** of real disk while
   both files report ~50 MB. `du` gets this wrong identically. A2 reports the
   aggregate gap instead and labels every total `approximate`.

2. **⚠ The index has no size cap.** A 366k-file home scan produced a **192 MB**
   database (~550 B/file); a 5M-file drive would be ~2.7 GB. `GET
   /api/index/status` reports `dbBytes` so it is visible, and `DELETE
   /api/index` genuinely reclaims it — but no policy limits growth. §B3 mandates
   a capacity guard for the Time Capsule; **the same reasoning applies here and
   is not implemented.** Worth raising with the user.

3. **Windows zombie-handle detection is absent** (B5). Both candidate
   implementations need native code or a non-redistributable binary. Reported as
   unavailable with a reason.

4. **Windows and Linux have never been executed.** CI (`.github/workflows/test.yml`)
   runs the suite on `windows-latest` and `ubuntu-latest`. **The repo previously
   had no test CI at all** — only release builds. Read the Windows CI log for the
   `[platform record]` line: it prints what `stat.blocks` actually does there,
   which settles a question that could not be answered from a Mac.

---

## Traps that will waste your time if you don't know them

**Browser testing in the preview pane**

- `document.hidden` is `true`, so **`requestAnimationFrame` never fires**. The
  treemap presents inside a rAF callback, so after any resize the canvas
  **screenshots blank while being perfectly fine**. Verify with
  `getImageData` across a grid, not with a screenshot.
- For the same reason, **synthetic mouse events cannot test tooltips** — the
  mousemove handler's whole body is inside rAF. `window.TreeMap` exposes
  `showTooltip`, `allocationTooltipLine` and `resolveAllocation` so tooltip
  content can be asserted directly.
- Treemap folder cells are **frames fully tiled by their children**, so clicking
  a folder's centre correctly hits a *file*. To test drill-in, set `#tmDepth` to
  2 so some directory renders as a non-frame leaf.

**Dev server**

- Use the **`treemap-p0`** launch config (port 4291, isolated `TREEMAP_DATA_DIR`).
  It lives in the **parent** `Desktop/Claude Code/.claude/launch.json` — the
  repo-level `launch.json` is *not* what the preview tool reads.
- Never run a dev server without `TREEMAP_DATA_DIR` set: `startScheduler()`
  picks up the user's real recurring scans and writes to their real snapshots.

**Tests**

- **Never assert absolute wall-clock latency.** A4's benchmark did, and failed
  intermittently in CI — it measures the runner, not the code. Print the real
  number via `t.diagnostic` and assert only machine-independent relationships
  (e.g. "an indexed seek beats a full scan by 4×").
- `appCode()` in `frontendContract.test.ts` **strips comments**. Anchor test
  slices on real code, never on `// Pass 1`-style comments — an empty slice
  silently asserts nothing.
- Don't pin assertions to exact source text; a correct change then breaks them.

**Conventions that override the spec** (§3.2 says follow the existing code)

- Error envelope is flat `{ error, code }` — **not** the spec's nested shape.
- Success bodies are flat objects — **not** `{ data: T }`.
- Test runner is `tsx --test` (node:test) — **do not add Vitest**.
- `GET /api/capabilities` was already taken by the agent manifest; platform
  capabilities live at `GET /api/platform/capabilities`.
- **Any route change must update the `ENDPOINTS` registry in
  `src/api/openapi.ts` in the same commit** — `tests/discoverability.test.ts`
  enforces it.

---

## New files

**Source** (~7,200 lines): `src/platform/` (types, exec, base, index,
capabilities, portable + `macos/`, `linux/`, `windows/`),
`src/services/{indexEngine,allocationAccountant,placeholderResolver}.ts`,
`src/api/{indexRoutes,platformRoutes}.ts`, `src/utils/searchQuery.ts`

**Tests** (~3,200 lines, 212 new): `tests/{platform,platformCrossOs,frontendContract,indexEngine,allocationAccountant,placeholderResolver,indexSearch}.test.ts`

**Other:** `.github/workflows/test.yml`, `docs/PLATFORM_NOTES.md`,
`scripts/{dev-isolated.js,report-capabilities.ts}`

**Dependencies added:** `better-sqlite3` (runtime, prebuilt — no compilation),
`@types/better-sqlite3` (dev). `node:sqlite` was rejected: it needs Node ≥ 22.5
and Electron 31 bundles Node 20.

## Not yet done

- **Phase 2** B4 → B5, **Phase 3** C1–C8, **Phase 4** D1–D3, **Phase 5** regression + benchmarks
- README endpoint/view documentation for A1–A5 (deferred to Phase 5 by
  precedent — §7 lists the README pass there; §11.7 would prefer per-feature)
- **Nothing is committed.** The user pushes via **GitHub Desktop**, not the CLI.
- `npm run dist:mac` will fail locally at the DMG step (pre-existing
  `dmg-builder` issue) and `node_modules/electron` is currently a broken install.
  Neither affects the server or the tests.
