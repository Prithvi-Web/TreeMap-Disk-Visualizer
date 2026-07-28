# TreeMap — 21-feature master prompt, session handoff

**Date:** 28 July 2026
**Status:** Phase 0 ✅ · Phase 1 ✅ (A1–A5) · Phase 2 four-fifths ✅ (B2, B3, B1, B4) — **B5 remains**
**Suite:** 587/587 on 3 consecutive runs · typecheck clean · zero console errors
**Everything is COMMITTED AND PUSHED** through `c26e309`. Working tree clean.
**v2.5.0 is built and installed** at `/Applications/TreeMap.app`.

Spec: `/Users/prithvivinay/Desktop/TreeMap-Master-Implementation-Prompt.md`

---

## Start here

```bash
cd "/Users/prithvivinay/Desktop/Claude Code/Treemap"
npm run build && npm test          # expect 587/587
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

# ⏭️ THE NEXT TASK — shrink the index (user-approved, NOT started)

The user asked for TreeMap to handle **100,000,000 files** and, shown the
options, chose *"drop the stored path — 3× smaller"*. The analysis below is
done and measured; **the change itself has not been started.** Do this before B5.

### The measurement that defines the job

Indexing a real `~/Library` (223,779 nodes) produced a 108.8 MB database.
`dbstat` breakdown, per node:

| Part | B/node | Share |
|---|---|---|
| `nodes` table (of which `path` text ≈ 143) | ~215 | 44% |
| `idx_nodes_path` — UNIQUE(root_id, path) | **177** | **36%** |
| `idx_nodes_name` | 34 | 7% |
| `idx_nodes_mtime` | 19 | 4% |
| `idx_nodes_ext` | 15 | 3% |
| `idx_nodes_parent` | 13 | 3% |
| `idx_nodes_size` | 13 | 3% |
| **TOTAL** | **486** | |

Average path length **143 chars**; average name length 21.

**The absolute path is stored twice — as a column and as a unique index on that
column — and together that is 66% of the whole database.** At 100M files,
486 B/node is **48.6 GB**. Removing it should reach ~195 B/node ≈ **17 GB**.

### Why this is the right target (do not re-litigate)

- **Scanning is not the bottleneck.** gdu does the user's whole disk
  (1,445,163 items) in **20 s** — 72k items/s. 100M items is ~23 minutes, once.
  A different open-source scanner buys percentages, not the 10× that would
  matter; the limit is macOS's own filesystem calls. This was investigated and
  rejected with numbers — **do not spend time swapping scanners.**
- **The in-memory tree is already fine.** `scanStore.ts` holds ~52 B/node, so
  100M ≈ 5.2 GB. Done in July.
- The index is the only structure that does not scale.

### The design (worked out, not yet written)

**Schema v3** — bump `SCHEMA_VERSION`. A1 already rebuilds on version mismatch,
so no migration code is needed; that is exactly why the version field exists.

1. **Drop the `path` column and `idx_nodes_path`.**
2. `CREATE UNIQUE INDEX idx_nodes_child ON nodes(parent_id, name)` — the same
   guarantee (a directory cannot hold two entries of one name) at ~29 B/node
   instead of 177.
3. Root nodes have `parent_id IS NULL`, so add the partial index
   `CREATE UNIQUE INDEX idx_nodes_root_node ON nodes(root_id) WHERE parent_id IS NULL`
   to find a root's top node without a scan.

**The call sites that genuinely need a path** (71 textual references collapse to
these six):

| Site | Today | After |
|---|---|---|
| `buildIndex` insert | `ON CONFLICT(root_id, path)` plus a per-batch read-back `SELECT id, path … WHERE path IN (…)` | Conflict on `(parent_id, name)`. Take ids from `info.lastInsertRowid` inside the transaction — `buildIndex` deletes the root's rows first, so every insert is a true insert and the rowid is reliable. **This also removes the read-back query, so builds get faster.** Keep the in-memory `idByPath` map: it is a build-time cache, not storage. |
| `readTree` nodes | reads `row.path` | Build paths **top-down during the descent** — the parent's path is already known, so it costs nothing. Give `toFileNode` a `parentPath` argument. |
| `readTree` start row | `WHERE root_id=? AND path=?` | Descend from the root node by path segments (`WHERE parent_id=? AND name=?`), ~10 queries once per call. |
| `searchIndex` | selects `n.path`, orders by it, and `scope` uses `n.path LIKE 'prefix%'` | Results are capped (≤ a few hundred), so rebuild each path by walking `parent_id` upward with a **memoised ancestor cache** — sibling results share nearly all ancestors. For `scope`, resolve the scope to a node id and filter results by walking their ancestors. |
| `applyPendingChanges` (live watcher) | subtree delete via `path LIKE 'prefix%'`; parent lookup by path | Subtree delete via recursive CTE: `WITH RECURSIVE sub(id) AS (SELECT id FROM nodes WHERE id=? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id=sub.id) DELETE FROM nodes WHERE id IN (SELECT id FROM sub)`. Parent lookup by the same segment descent. |
| size roll-up (~line 721) | `WHERE root_id=? AND path=?` | Key off the node id the caller already has. |

**Two helpers to add:** `findNodeIdByPath(rootId, absPath)` (segment descent)
and `pathOfNode(id)` (ancestor walk, memoised).

### How to know it worked

- `tests/goldenResponses.test.ts` must pass **byte-identical** — that is what
  those goldens are for, and the index feeds `/api/index/tree`.
- Re-run the measurement: index `~/Library`, divide DB+WAL bytes by
  `fileCount + dirCount`. **Target ≈195 B/node. Above ~250 means a path is
  still being stored somewhere.**
- `readTree` must not regress (currently ~590 ms for 224k nodes).
- The sub-quadratic scaling test in `tests/indexEngine.test.ts` must still pass.

### Do NOT

- Do not add a `path_hash` column as a shortcut. It keeps the 143-byte column
  and removes only the index — a 1.5× win where 2.5× is available, and it
  leaves two sources of truth for one path.
- Do not load every row of a root to assemble the tree in memory. Faster on a
  small root, impossible on a 100M-node one; the budgeted descent is what keeps
  memory bounded.

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
| **B5** | Zombie-handle reclaim detector | ⬜ **after the index work** |

### Measured on this Mac — throughput here is load-dominated, so state the machine's state with any number

- Whole disk `/`: **20.1 s**, 1,445,163 items, **72k items/s**, gdu-turbo
- Home dir: 10.0 s / 524,142 items *(with Full Disk Access)*
- Index build for home: **26.9 s**
- Reopen from index: **586 ms** in-process, 1,674 ms end-to-end over HTTP
  *(was 8,549 ms before the heap fix)*
- Search over 500,000 files: 1 ms extension, 58 ms substring
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
2. **The index has no size cap**, and now a measured cost of 486 B/node — the
   next task. §B3 mandates a capacity guard for the Time Capsule; the same
   reasoning applies here, and the capsule's `capFor`/`planEviction` are a
   ready-made model.
3. **Windows zombie-handle detection is absent** (B5). Both candidates need
   native code or a non-redistributable binary. Reported as unavailable with a
   reason — §B5 says pick one and do it completely.
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

## After the index work: B5, then Phases 3–5

**B5 · Zombie-handle reclaim** — the last of Phase 2. `getZombieHandles` already
exists on the provider for macOS and Linux from Phase 0 (lsof inode comparison /
`/proc/*/fd`). Windows stays unimplemented with an honest reason. What remains:
the panel listing "X GB held by processes that won't let go", and a per-process
restart action (graceful terminate + relaunch where supported, an explicit
unsaved-work warning otherwise).

Then **Phase 3** C8 (rule packs) → C6, C7 → C1–C5; **Phase 4** D2 → D3 → D1;
**Phase 5** full regression, the §8 benchmark with real recorded numbers, a
security review of D1's network surface, and the README sweep.

**README status:** documented through B4 (twelve views, all endpoints). §7
schedules the full README pass for Phase 5.

---

## New files this session

**Source:** `src/platform/` (types, exec, base, index, capabilities, portable,
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
