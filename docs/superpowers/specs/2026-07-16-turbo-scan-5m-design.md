# Turbo scanning: 5,000,000 items at 100,000+ items/sec

**Date:** 2026-07-16
**Status:** Design — awaiting approval
**Goal:** TreeMap scans up to 5M files/folders at ≥100k items/sec, without breaking
any existing feature.

---

## 1. What the user asked for

> "I just want something that can scan up to 5 Million files/items and can scan at
> 100,000 files/items per second. Currently it is taking too long and can only scan
> up to 2 million files. Make this flawless."

The scanner is a means, not the goal. `gdu` was proposed by a master prompt
(`gdu-turbo-scanner-integration-prompt.md`), but the choice is ours to justify.

---

## 2. Measured baseline — all numbers from this machine

Apple M3, 8 cores, 16 GB RAM, APFS. Benchmark tree: `/Applications` =
**458,193 objects / 30.05 GB**. gdu v5.36.1 (darwin_arm64, official release).

| Engine | Walk | Read+parse+map | End-to-end | Throughput |
|---|---|---|---|---|
| Shipping `turbo-walker` | 4.74s / 5.15s / 6.60s | built inline | **4.74–6.60s** | **69k–97k/s** |
| gdu + naive mapper | 3.54s | 997ms | 4.54s | 101k/s |
| **gdu + tuned mapper** | **3.54s** | **249ms** | **~3.79s** | **~121k/s** |

**The 2M ceiling is arithmetic, not a scanner limit:**

- FileNode tree costs **382 bytes/node** of heap.
- `JSON.stringify` of that tree costs **253 bytes/node**.
- V8 caps any single string at 536,870,888 chars (~512 MB).
- 512 MB ÷ 253 B = **~2.02M nodes**. The user reports failure at ~2M. Exact match.

The scan *completes*; the app dies shipping the finished tree to the UI as one
JSON string on the SSE `complete` event. **This is engine-independent.** gdu hits
the identical wall at the identical 2M.

**Synthetic 5M-node validation** (gdu-format JSON, 376 MB, 79 B/node):

| Stage | Time |
|---|---|
| `readFileSync` 376 MB | 664ms |
| `JSON.parse` | 1,676ms |
| build 5M FileNodes | 539ms |
| **total** | **2,879ms** (RSS 1.7 GB) |
| `JSON.stringify(root)` | **throws `Invalid string length`** |

**5M budget with gdu:** ~40s walk + 2.9s map = **~43s → ~116k items/sec.** Clears
the target. The walker at 89k/s would take ~56s and miss it.

---

## 3. Where the master prompt is wrong

Verified against real gdu v5.36.1 output, not assumed. The prompt explicitly
invited this correction.

1. **Schema is wrong.** The prompt says a directory is a 2-element array
   `[meta, childrenArray]`. Real output is **`[meta, child1, child2, ...]`** — a
   flat array, element 0 is metadata, the rest are children. The prompt's sample
   had one child per directory, which hides the difference. Coding to their
   description breaks on every real directory.
2. **Requirement 4 (streaming parser) must be rejected.** `stream-json` is ~10–20×
   slower than V8's native parser; at 376 MB that is 8–20s and would make gdu
   *slower than the walker we already have*. Measured: `JSON.parse` does 5M nodes
   in 1.68s at 1.7 GB RSS. We use `JSON.parse` with a file-size guard.
3. **The "throughput problem" barely exists.** The prompt's premise is the Node
   walker is far below 100k/s. It measures 69–97k/s here. The prompt's 133k/s gdu
   figure came from a **2-core cloud VM on synthetic tiny files** — a weak-hardware
   floor, never compared against this walker. The real gain is ~1.3–1.9×, not 10×.
4. **The mapping tax is not inherent.** The prompt treats JSON→FileNode as
   expensive. It is 787ms/458k with `path.join`+`path.extname`, and **39ms without
   them** — a 20× win from raw string ops.
5. **Directories carry no size.** The prompt wonders; the answer is no. We sum.
6. **`mtime` is Unix seconds**, app wants milliseconds (×1000). `asize` is
   **omitted entirely when 0**. Undocumented **`notreg: true`** flags non-regular
   files (symlinks etc.).
7. **Requirement 7 ordering is backwards.** It files the `/result` + cache fixes as
   a side-quest. They are *the entire blocker* for 5M. gdu is the optimization on
   top.

---

## 4. Critical context: the July 16 rollback

The pruned-tree work (prune + fetch-on-demand) is **uncommitted in the working
tree right now** and was rolled back hours ago because scanning felt "so much
slower". Requirement 7 *is* that work.

**`src/services/diskScanner.ts` was never modified by it** — the walk in that
build was byte-identical to stock. So the perceived slowdown came from *after* the
walk. Unmeasured suspects, from memory:

- `pruneTree` runs on every `complete` **and** every `/result` call, uncached.
- `renderCloudSafe` forces a full server-side tree walk on every scan completion.
- `finishScan` awaits 4 API calls before painting anything.

**gdu speeds up the walk — the one stage that never got slower.** It would not
have fixed the complaint. This is why the wall is fixed and verified *first*.

---

## 5. Design

**Delivery order (user-chosen): Phase 1 ships and is verified on its own before
Phase 2 begins.** The two phases change different stages (paint path vs walk), so
keeping them apart is what makes a regression attributable — the absence of that
separation is how the last attempt got rolled back. Each phase gets its own
check-in.

### Phase 1 — Break the 2M wall (no new engine)

Goal: 5M items reach a usable UI, and **scan→paint is not slower than stock**.

1. **Diagnose the rollback with real measurement.** Scan→paint on a real
   multi-million-item tree, stock vs pruned build, nothing else running. Isolate
   the actual regression before touching anything. (Memory notes a 2.8s vs 21.7s
   swing on the same folder that was never chased — background build contention is
   a plausible confound and must be excluded.)
2. **Fix what the measurement blames.** Likely: cache the pruned tree, drop the
   full-tree cloud-safe walk off the completion path, paint before the 4 awaits.
3. **Land the transport fix** so the tree never crosses as one JSON string.
4. **Gate:** scan→paint on a real folder must be **≤ stock**, measured, or it does
   not ship. This is the bar the last attempt failed.

### Phase 2 — gdu turbo engine

- `src/services/gduScanner.ts`: locate binary (bundled → `$PATH` for dev), spawn
  with `execFile` + argv array (never `exec`, never `shell:true`), `-n -o <tmpfile>`.
- Parse: `readFileSync` + `JSON.parse` + the **tuned mapper** (no `path.join`, no
  `path.extname`). **Guard:** if the temp file exceeds 450 MB (~5.7M nodes at the
  measured 79 B/node, leaving headroom under V8's 512 MB string cap), abandon the
  gdu result and fall back to `walk()` rather than risk a `RangeError`. The walker
  is slower but has no string-cap ceiling.
- Map: `asize`→`size` (default 0), `mtime`×1000→`modifiedAt`, dir = flat
  `[meta, ...children]`, sum sizes. Preserve cheap enrichments: `isHidden`,
  `extension`, `container`, `gitRepo`.
- **Preserved via gdu fields:** cloud-placeholder detection via `dsize`≈0 while
  `asize`>0; symlink flagging via `notreg`.
- **Hardlink dedup is PRESERVED — the prompt (and §3 of this spec's first draft)
  were wrong.** gdu emits `ino` (inode) plus `hlnkc: true`, and only when the link
  count exceeds 1 — the same optimization the walker uses (`stat.nlink > 1`).
  Verified against real output on `/Applications`: deduping on `ino` reproduces the
  walker's total **byte-for-byte** (30,070,595,907 == 30,070,595,907) and the exact
  same hardlink count (21,499 == 21,499). Naive counting overcounts by 592,938,708
  bytes (1.972%) — so this must be implemented, not waived.
  **Known limit:** gdu emits `ino` but no `dev`, so the key is inode-only. Within a
  single volume (the overwhelming case — a home dir, `/Applications`) that is exact.
  A scan spanning volumes could in principle collide two inodes across devices and
  under-count. Documented rather than silently risked; revisit only if it shows up.
- **Nothing is lost.** With dedup recovered, gdu mode reaches full parity with the
  walker: `isHidden`, `extension`, `container`, `gitRepo` are all computable from
  the name; `notreg` → `isSymlink`; `dsize` → `cloudPlaceholder`.
- `engine: 'gdu-turbo'` on `ScanResult`, following the existing `'ntfs-mft'` pattern.
- **Fallback is mandatory:** binary missing / spawn fails / non-zero exit → fall
  back to `walk()` transparently, log it, never surface as a scan error.
- Cancellation: `scan.cancelled` kills the subprocess. Temp file deleted on success
  *and* failure.

### Phase 3 — Honesty about accuracy (SUPERSEDED — no badge needed)

Originally: show a badge because gdu was believed to overcount hardlinks by 2%.
**That premise was false** (see Phase 2 above) — gdu exposes `ino`/`hlnkc` and
dedups byte-for-byte identically to the walker. There is no inaccuracy to
disclose, so no badge ships. The user approved the badge on the false premise;
the honest resolution is to make the number right rather than to caption a wrong
one.

What replaces it: a **regression test asserting gdu and walker totals agree
exactly** on the same tree, so any future drift is caught rather than captioned.

### Phase 4 — Bundling

Per-platform gdu binary fetched at build time (mirroring `scripts/afterPack.js`'s
`sharp` pattern), wired into `electron-builder` `extraResources`, with gdu's MIT
`LICENSE` vendored alongside. `$PATH` fallback so `npm run dev` works without the
bundling step.

---

## 6. Testing

- gdu-JSON → FileNode mapper against a **recorded fixture** of real v5.36.1 output
  (flat-array dirs, missing `asize`, `notreg`, seconds→ms). No subprocess needed.
- Fallback path when the binary is absent / exits non-zero.
- Cancellation kills the subprocess and removes the temp file.
- Hardlink-overcount badge appears for `gdu-turbo`, absent for `walker`.
- Opt-in (env-gated) scale test: synthetic large tree, asserts completion and sane
  throughput.
- Full suite green: `npm run typecheck`, `npm test`, `npm run build`.
- **Regression gate:** scan→paint ≤ stock on a real folder.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Re-introducing the rollback slowdown | Phase 1 gate: measured scan→paint ≤ stock, or don't ship |
| 376 MB string near V8's 512 MB cap | File-size guard; approach ceilings ~6.8M nodes vs 5M target |
| gdu's 2% hardlink overcount | Badge; walker stays default for exact numbers |
| Two engines diverge in behavior | Shared FileNode contract + mapper fixture tests |
| Bundling 3 platform binaries (~8MB each) | Follows the proven `sharp` asarUnpack/afterPack pattern |

---

## 8. Explicit non-goals

- `'ntfs-mft'` engine (raw NTFS/admin access) — out of scope, as the prompt states.
- 100% gdu/walker feature parity — degrade explicitly, never fake data.
