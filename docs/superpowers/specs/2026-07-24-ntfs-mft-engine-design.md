# NTFS MFT turbo engine (`ntfs-mft`)

**Date:** 2026-07-24 (revision 3, after two spec reviews)
**Status:** Design — revised, pending third review
**Goal:** Wire up the already-reserved `'ntfs-mft'` engine so that an opted-in
Windows scan of an NTFS volume reads the Master File Table directly instead of
walking directories — WizTree-class scan speed, MIT-clean implementation, same
fallback-on-any-failure discipline as `gdu-turbo`.

---

## 1. Where this came from

`src/models/types.ts` already declares:

```ts
engine?: 'walker' | 'turbo-walker' | 'gdu-turbo' | 'ntfs-mft' | 'cloud';
```

`'ntfs-mft'` has been a reserved-but-unimplemented value since the gdu-turbo work
(`2026-07-16-turbo-scan-5m-design.md` calls it "out of scope, as the prompt
states"). The engine label already exists in `public/index.html`
(`'ntfs-mft': 'NTFS MFT reader'`). This spec implements that slot.

**Baseline check (2026-07-24):** `npm run build` is clean; `npm test` is 190
pass / 3 fail / 5 skipped. The 3 failures (`apiHardening` boundary test,
`appAttribution` Windows-path test, an API byte-identical baseline drift test)
are pre-existing on `main`, unrelated to scanning engines, and untouched by
this work.

**Revision note:** this is the third pass. Draft 1 was flagged **NEEDS
REVISION** (three blocking issues). Draft 2 fixed those but a second review
found the fix for one of them — hardlink handling — was internally
inconsistent with itself, plus two under-specified preconditions. While
correcting that, tracing the fix down to the actual NTFS attribute layer
surfaced a further, subtler bug neither review caught: DOS 8.3 short-name
aliases would have been misidentified as hardlink duplicates. All of the
above are addressed below; §7 records the full history.

---

## 2. Why not a native Node addon

Still rejected, same reasoning as the first draft: the MFT reader requires an
elevated process token (enforced by the crate itself, see §4.3). A native
addon would need the *whole Electron process* elevated to call it, every
launch — worse than today. Routing an addon call through a separate elevated
helper anyway reintroduces the same helper-process shape this spec uses,
minus the addon's added build complexity (Rust toolchain + N-API ABI pinning
+ per-Node-version prebuilds, none of which exist elsewhere in this repo).

**Decision (unchanged):** a standalone Rust CLI binary, spawned like `gdu`.

---

## 3. Architecture

### 3.1 `native/ntfs-mft-scan/` — new Rust binary crate

CLI shape: `ntfs-mft-scan.exe --volume C --root "C:\Users\foo\Documents" --out <tmpfile>`.

Depends directly on `ntfs-reader` (crates.io, MIT OR Apache-2.0, ~28k
downloads, last published 2026-03-28; deps: `thiserror`, `binread`, `time`,
`tracing`, `windows`). Same reasoning as before: reuse over reinvent, and this
is the same raw-MFT-parse technique WizTree itself uses per the RTTI recovered
from `WizTree64.exe` (`TDATA_RUN`, `TMFT_RECORD`) — but `ntfs-reader` is an
independent clean-room implementation from public NTFS documentation, and
nothing from the WizTree binary is reused.

**Output format — revised.** The first draft emitted one JSON array (one
object per file). **Changed to NDJSON** (one JSON object per line, streamed to
the temp file as records are produced), for two reasons a reviewer correctly
flagged:

1. A single JSON array for a full volume can plausibly exceed V8's ~512MB
   single-string ceiling — the same wall `2026-07-16-turbo-scan-5m-design.md`
   measured gdu hitting at ~2M nodes, and which that spec's *entire sharding
   design* exists to avoid. NDJSON sidesteps it structurally: the Node side
   never holds the whole payload as one string, it reads and parses line by
   line.
2. NDJSON gives natural progress checkpoints (see §3.4) where a single
   `JSON.parse` of one giant array gives none.

**Record shape — revised for hardlinks, then revised again for DOS aliases.**
The first draft's `{recordNo, parentRecordNo, name, ...}` assumed one name per
MFT record. Confirmed wrong: `ntfs-reader`'s `NtfsFile::attributes()` iterates
every attribute in a record, and a record can carry **multiple `FileName`
attributes** — one per hardlink, each with its own parent FRN.

**A second, subtler issue surfaced while fixing the first:** every
`FileName` attribute carries a `namespace` field (`NtfsFileNameHeader.
namespace`, values `Posix`/`Win32`/`Dos`/`Win32AndDos` — see
`ntfs-reader`'s `attribute.rs`). A file whose long name isn't already a valid
8.3 name gets **two** `FileName` attributes for the *same single link*: one
`Win32` (the real name) and one `Dos` (an auto-generated short alias like
`REPORT~1.DOC`) — not two hardlinks. `ntfs-reader` itself has a
`get_best_file_name()` helper specifically to pick the real one over the
alias, which is independent confirmation this is a real, known issue with
this exact API, not a hypothetical: naively emitting one row per `FileName`
attribute would misidentify most long-named files as hardlinked to their own
throwaway short-name alias, corrupting size/count totals for nearly every
file with a name longer than 8.3.

**Fix:** the helper skips any `FileName` attribute whose `namespace` is pure
`Dos` — keeping `Posix`, `Win32`, and `Win32AndDos`.

**A third review caught a variant this doesn't fully cover on its own:** a
`Posix`-namespace name can coexist with a `Win32` name for the *same single
link at the same parent* (the historical case-sensitive-POSIX-subsystem
counterpart to the DOS-alias case, not a second hardlink). Filtering by
namespace alone isn't enough to catch this, because both `Posix` and `Win32`
survive the Dos-only filter. The actual distinguishing signal is **parent**,
not namespace: two genuine hardlinks always have different `parentRecordNo`
values (you can't link a name to itself twice in the same directory), so
edges are first grouped by `(recordNo, parentRecordNo)` and collapsed to one
representative per group (preferring `Win32AndDos` > `Win32` > `Posix` when
more than one namespace survives for the same parent) — *then* the
remaining distinct-parent groups for a given `recordNo` are the genuine
hardlink count. What survives is exactly a record's genuine set of names:
one for an ordinary file, more than one only when it's actually linked from
more than one parent. One line per surviving `(record, FileName attribute)`
pair:

```json
{"recordNo": 123456, "parentRecordNo": 5, "name": "report.docx", "size": 40960, "isDir": false, "mtimeMs": 1732000000000, "attrs": 0}
```

A real hardlink emits two lines sharing `recordNo` but with different
`parentRecordNo`/`name`; an ordinary file (including one with a DOS-alias-
eligible short name) emits exactly one. Deduping on `recordNo` (§3.2) now
correctly identifies only genuine hardlinks, matching the same
"first occurrence wins the tree placement, the rest are `hardlinkDuplicate`
with size zeroed" rule `gduMapper.ts` already applies via its `seenInodes`
set.

### 3.2 Building only the requested subtree (not "scan wide then prune")

The first draft said "build a volume-wide store, then `store.prune()` to the
subtree." A reviewer correctly identified this doesn't work: `ScanStore`/
`PackedScanStore` fix `rootId`/`rootPath` at construction (`scanStore.ts`
`constructor(rootPath, sep, rootFields)`), and `prune()` returns a bounded
`PruneResult`/`FileNode` for UI materialization, not a re-rooted `ScanStore`.
There is no "rebuild a `ScanStore` around a different root" primitive, and
`scan.store` must be a real `ScanStore` for `collectLargestFiles`,
`collectEmptyFolders`, `compareTrees`, and the SSE stats to work.

**Revised construction, matching `gduScanIntoStore`'s own shape** (build
directly into a store rooted at `scan.rootPath` from the start, never a
wider one).

**Correction from the second review:** an earlier version of this section
collapsed the incoming lines into `Map<recordNo, single record>` — one slot
per record. That's wrong the moment a real hardlink exists: two lines can
share a `recordNo` with genuinely different `name`/`parentRecordNo` (per
§3.1's fix), and a single-slot map lets the second line silently overwrite
the first, corrupting one of the two tree placements. The structure has to
keep every surviving edge, not collapse them:

1. Stream the NDJSON output into an in-memory `edgesByParent: Map<
   parentRecordNo, Edge[]>`, where `Edge = {recordNo, name, size, isDir,
   mtimeMs, attrs}` is exactly one line, unmodified — grouped by parent, not
   collapsed by record. This is the MFT's entire edge set, held transiently
   as plain numbers/short strings — cheap compared to one giant JSON string,
   and never serialized as one blob.
2. Resolve the target root's own record number. NTFS's root directory is
   always record **5** (`ROOT_RECORD` in `ntfs-reader`), so a whole-volume
   scan (`C:\`) needs no lookup at all. A subfolder scan (`C:\Users\foo\
   Documents`) walks the path's components from record 5 down, at each step
   scanning `edgesByParent.get(currentRecordNo)` for a directory edge whose
   `name` matches the next component — matched case-insensitively (NTFS is
   case-insensitive-preserving by default; a literal `===` would fail to
   resolve a real subfolder whenever the requested path's casing differs
   from the on-disk name). If a component fails to resolve at all (e.g. the
   folder was deleted between the initial `rootStat` check and the MFT
   read), that's just another case covered by §3.6's "any failure falls
   back" rule — no special handling needed beyond that.
3. BFS/DFS from the target root's record number, following `edgesByParent.
   get(recordNo)` to enumerate children — parent-before-child, so every
   `store.addNode(parentId, ...)` call already has its parent inserted.
   Track `recordNo -> storeNodeId` for directories (to parent their
   children) and a `seenRecordNos: Set<number>` for non-directory edges: the
   first time a `recordNo` is encountered it's inserted with its real size;
   any later edge sharing that `recordNo` (a genuine hardlink, per §3.1's
   DOS-alias filter) is inserted with size zeroed and `hardlinkDuplicate:
   true`, contributing to `scan.hardlinkedFiles`/`hardlinkedBytes` — the same
   rule `gduMapper.ts` applies via its own `seenInodes` set, now actually
   reachable because each edge keeps its own name/parent instead of being
   overwritten.

The full-volume edge map (step 1) is discarded once the target subtree is
built; only the constructed store is kept, same memory-release shape as
gdu's per-shard JSON release.

**Two edge cases raised in the third review, both accepted as documented
limitations rather than engineered around:**

- **Unallocated records are already excluded, no action needed.**
  `ntfs-reader`'s `Mft::files()` already filters to in-use records via the
  volume's own `$Bitmap` attribute (`record_exists()`) *and* each record's
  own in-use flag (`is_used()`) — deleted-but-not-yet-overwritten records
  never reach our NDJSON output in the first place.
- **Reused record numbers mid-scan.** This is a single raw point-in-time
  read, not a journal-consistent snapshot. If a file is deleted and its MFT
  slot reallocated to an unrelated new file *during* the read window, that
  slot's `recordNo` could — in principle — briefly appear to belong to two
  things across the read. The practical effect would be a rare, benign
  miscount (an unrelated file misread as a hardlink duplicate, self-correcting
  on the next scan). Not engineered around for v1; noted so it isn't a
  surprise if ever observed.

### 3.3 `src/services/ntfsMftScanner.ts`

Mirrors `gduScanner.ts`: `findNtfsMftBinary()` (bundled → dev-relative, same
two-candidate lookup as `findGduBinary`), then `ntfsMftScanIntoStore()`
implementing §3.2. NDJSON lines are consumed via a line reader over the temp
file (or the child's stdout), not `fs.readFile` + `JSON.parse`.

### 3.4 Progress and cancellation — revised, previously unaddressed

The first draft didn't account for `diskScanner.ts`'s progress/cancellation
contract at all. Fixed:

- **Progress:** `scan.scanned`/`scan.currentPath` update as NDJSON lines are
  read and inserted (step 3 of §3.2), giving a live counter during tree
  construction — the bulk of the wall-clock. The elevation-plus-raw-$MFT-read
  phase before the first line appears is a genuine blind window, but it's a
  single bulk sequential read (not gdu's per-shard-of-a-slow-walk problem);
  its actual duration on this project's target hardware is **not yet
  measured** and is called out as a task for the implementation plan, not
  assumed.
- **Cancellation — accepted limitation, not solved.** `sudo-prompt` launches
  the elevated child via the Windows `runas` verb and returns only a
  completion callback, not a killable process handle — so `scan.cancelled`
  cannot terminate an in-flight elevated read. On cancellation, the Node side
  immediately stops consuming output and discards the result (matching "never
  block the UI on the orphaned process"); the helper finishes in its own
  per-attempt-unique temp directory and exits harmlessly, its output simply
  never consumed. A hard wait timeout (mirroring gdu's `SHARD_TIMEOUT_MS`)
  backstops a wedged helper so a stuck child can't hang the scan record
  itself, even though it can't be force-killed early.

### 3.5 Elevation trigger — revised: explicit opt-in, not automatic

The first draft didn't decide whether this engine auto-triggers like gdu.
**Decided: explicit opt-in only.** Unlike every other engine, this one
produces a real UAC prompt — auto-triggering it on an ordinary "scan my C:
drive" action would surface an unexplained admin prompt with no prior user
signal. So:

- New `ntfsMft?: boolean` field on `ScanOptions` (`diskScanner.ts`) and the
  scan request body (`scanRoutes.ts`), alongside the existing `incremental`
  field.
- New checkbox in `public/index.html`, placed and modeled directly on the
  existing `#fastRescan` ("Fast rescan — reuse cache for unchanged folders")
  toggle — e.g. "Turbo NTFS scan (requires admin)" — shown only when the
  scan target resolves to a Windows NTFS volume.
- The helper is only ever spawned when this flag is set. No silent
  auto-elevation path exists anywhere in this design.

Invocation mechanics: `sudo-prompt`'s API takes a **shell command string**,
not an argv array (the first draft incorrectly claimed `execFile` + argv,
which doesn't apply once elevation is routed through `sudo-prompt`). Since a
shell string reintroduces the quoting risk `execFile` normally avoids, the
interpolated values are strictly constrained: the volume argument is
validated against `/^[A-Za-z]$/` (a single drive letter, never raw user
input) before being placed in the command string, and the output path is
always one generated internally via `fsp.mkdtemp` — never a user-supplied
path. No user-controlled string reaches the shell command.

### 3.6 Gating, precedence, and fallback — revised, previously unaddressed

The first draft never defined eligibility preconditions or fallback-counter
handling, both of which `diskScanner.ts`'s real gdu wiring has. Mirrored
here:

```
ntfsMftEligible =
  process.platform === 'win32' &&
  opts.ntfsMft === true &&               // explicit opt-in, §3.5
  rootStat.isDirectory() &&
  !cache && !opts.incremental &&
  ignore.length === 0 &&                 // same reason as gdu, see below
  targetVolumeIsNtfs &&                  // see below for how this is computed
  process.env.TREEMAP_NO_NTFS_MFT !== '1'
```

Two of these conditions were missing or hand-waved in the prior revision;
both are corrected here:

- **`ignore.length === 0`** — dropped by mistake in the prior revision.
  `gduEligible`'s existing comment explains why: gdu (and, even more so, raw
  MFT record enumeration) has no way to honor this app's glob-based ignore
  patterns. A user with an active ignore list who opts into `ntfs-mft` must
  not silently get totals that include excluded paths — same reasoning,
  same gate, reused verbatim rather than re-derived.
- **`targetVolumeIsNtfs`** — the prior revision asserted this as a bare
  boolean with no implementation path (there's no existing NTFS-detection
  helper anywhere in `src/`). Concretely: `execFile('fsutil', ['fsinfo',
  'volumeinfo', `${driveLetter}:`])` and check the `File System Name` line
  for `NTFS` — an unprivileged, always-available Windows tool, so this check
  runs before any elevation is attempted and costs nothing new to depend on.

**Precedence:** if `ntfsMftEligible`, try `ntfs-mft` first (it's faster than
gdu on NTFS); on any failure, fall through to the existing `gduEligible`
check; on that failure, the walker — the same cascade shape already in
`diskScanner.ts`, one more link added at the front.

**Fallback counter reset** — copied verbatim from gdu's existing catch block,
because it is exactly as necessary here: on `ntfs-mft` failure, `scan.
fileCount`, `dirCount`, `scanned`, `hardlinkedFiles`, `hardlinkedBytes`,
`cloudFiles`, `cloudBytes` are all zeroed before falling through, so the next
engine attempt doesn't double-count on top of a partial one. Any failure —
binary missing, non-NTFS, UAC declined, malformed NDJSON, timeout — is
logged and never surfaced as a scan error, identical to gdu's discipline.

### 3.7 Build and bundling

Unchanged from the first draft: `scripts/buildNtfsMftScan.js`, modeled on
`fetchGdu.js` but **building** (`cargo build --release --target
x86_64-pc-windows-msvc`) rather than fetching, staged into
`build/ntfs-mft-scan/win-x64/`, wired into `electron-builder`'s
`extraResources` under `win`. A missing Rust toolchain is non-fatal, same
"continue without it" behavior `fetchGdu.js` has for network failures.

---

## 4. Scope

**In scope:** opt-in single-shot MFT read via the CLI helper (whole-volume or
a resolved subtree per §3.2), on-demand UAC elevation via `sudo-prompt`,
NDJSON streaming with progress checkpoints, hardlink-safe dedup, fallback
cascade (`ntfs-mft` → `gdu-turbo` → walker) with counter reset, `engine:
'ntfs-mft'` tagging, the opt-in UI checkbox.

**Explicitly out of scope (follow-up work):**
- `ntfs-reader`'s `Journal` API for incremental re-scan feeding `watcher.ts`
  — a genuinely useful second feature with its own design questions (journal
  lifecycle, USN watermarks, restart checkpoints), not part of making this
  engine slot work for the first time.
- ReFS support — `ntfs-reader` doesn't support it (no MFT on ReFS); ReFS
  volumes are excluded by `targetVolumeIsNtfs` and fall back like any
  non-NTFS volume.
- True mid-read cancellation of the elevated helper — accepted as a
  documented limitation (§3.4), not solved in this PR.

---

## 5. Testing

- **Mapper test** against a recorded NDJSON fixture, including a
  multi-hardlink case, asserting dedup matches the `gduMapper.ts` pattern
  byte-for-byte on a shared fixture tree.
- **DOS-alias regression test**: a fixture record carrying both a `Win32`
  long name and a `Dos` 8.3 alias for the same single link must produce
  exactly one tree entry, not a false hardlink duplicate. This is the case
  §3.1's namespace filter exists for — the test is what keeps a future
  helper-side refactor from silently reintroducing it.
- **Store-construction test**: a subfolder-scan request resolves the correct
  target record number via the `edgesByParent` walk and builds a store
  containing only that subtree, not the whole volume's records.
- **Fallback-path tests**: binary missing, non-NTFS volume (via a mocked
  `fsutil` response), non-`win32`, `opts.ntfsMft` unset (never attempted),
  active ignore list, UAC declined, malformed NDJSON line, timeout — each
  falls back with counters zeroed, never a scan error.
- **Manual/opt-in parity test** on a real elevated Windows machine: `ntfs-mft`
  vs `walker` totals on the same real tree, including a directory with actual
  hardlinks, must match exactly — the same byte-for-byte gate the gdu
  hardlink-dedup parity test already enforces.

---

## 6. Risks

- **Third-party crate risk.** Single maintainer; mitigated by it being a
  thin, auditable, permissively dual-licensed dependency — forkable without
  touching the TS side if it goes unmaintained.
- **UAC fatigue.** Mitigated relative to the first draft by opt-in-only
  (§3.5) — a user who never checks the box never sees a prompt. Repeated
  prompts for a user who *does* opt in every session is a real but smaller
  follow-up concern (e.g. a "remember for this session" cache).
- **Antivirus/EDR flags.** Direct volume access + elevation is a shape real
  malware sometimes uses; code-signing the helper binary (already planned
  for the app itself per `afterPack.js`) reduces false-positive risk.
- **Unmeasured blind-window duration** (§3.4) — flagged as a measurement
  task for the implementation plan rather than assumed short.

---

## 7. Revision history (for the reviewer)

### Draft 1 → 2

| Draft 1 claim | Problem found | Fix in draft 2 |
|---|---|---|
| `execFile` + argv array | Contradicted by `sudo-prompt`'s shell-string API | §3.5: shell string with strictly validated inputs |
| Build wide, `store.prune()` to subtree | No such re-rooting primitive exists; `prune()` returns a `FileNode`, not a `ScanStore` | §3.2: resolve target record, build store directly at the correct root via `addNode` |
| One JSON array over the wire | Same V8 single-string ceiling gdu's sharding exists to avoid | §3.1: NDJSON streaming |
| One name/parent per record | MFT records can carry multiple `FileName` attributes (hardlinks) | §3.1: one line per (record, FileName attr); dedup on `recordNo` like gdu dedupes on `ino` |
| No progress/cancellation story | Silent through the whole read, unlike every other engine | §3.4: streaming progress + accepted cancellation limitation with timeout backstop |
| No eligibility/precedence/counter-reset | `diskScanner.ts`'s real gdu wiring has all three | §3.6: mirrored |
| Auto vs. opt-in elevation undecided | A real UX fork the spec punted on | §3.5: explicit opt-in, confirmed with the project owner |

### Draft 2 → 3

A second review found draft 2's hardlink fix didn't actually hold together,
plus two preconditions in §3.6 were asserted rather than implementable.
Tracing the hardlink fix down to the NTFS attribute layer to correct it
surfaced a further bug neither review had caught.

| Draft 2 claim | Problem found | Fix in draft 3 |
|---|---|---|
| `Map<recordNo, single record>` holds the NDJSON stream | Can't represent two lines sharing a `recordNo` with different names/parents — a real hardlink's second occurrence silently overwrites the first | §3.2: `edgesByParent: Map<parentRecordNo, Edge[]>`, every edge kept, none collapsed |
| "Dedupes on `recordNo` like `gduMapper.ts` dedupes on `ino`" | Asserted, but unreachable given the map bug above | Now actually reachable: §3.2's `seenRecordNos` set operates over genuine, uncorrupted edges |
| "Mirrored verbatim" from gdu's eligibility list | `ignore.length === 0` was dropped; MFT enumeration has even less ability to honor ignore patterns than gdu does | §3.6: gate restored |
| `targetVolumeIsNtfs` | Asserted as a bare boolean, no implementation, no existing helper in the codebase | §3.6: concrete `fsutil fsinfo volumeinfo` check |
| One row per `FileName` attribute | **Not caught by either review** — found while fixing the row above. A DOS 8.3 short-name alias attribute (`namespace: Dos`) shares a record with its real `Win32` name for the *same single link*, not a second hardlink. `ntfs-reader` itself has a `get_best_file_name()` helper specifically because of this, confirming it's a real, known issue with this API rather than a hypothetical. Left unfixed, most long-named files would register a false hardlink duplicate against their own throwaway short-name alias | §3.1: skip `namespace: Dos`-only attributes at emission; §5: regression test for it |

### Draft 3 review (third pass): APPROVED WITH SUGGESTIONS

No architectural flaw found this time. Remaining gaps, folded into this
version directly rather than triggering a fourth full review cycle:

| Gap found | Fix applied |
|---|---|
| DOS-alias filter didn't cover the analogous `Posix`+`Win32` same-link-same-parent case | §3.1/§3.2: dedup key changed from namespace-based filtering alone to grouping by `(recordNo, parentRecordNo)` first — genuine hardlinks are identified by *distinct parents*, which the namespace value alone can't distinguish |
| Path-resolution name matching's case-sensitivity was unstated | §3.2 step 2: explicit case-insensitive match, matching NTFS's default case-insensitive-preserving behavior |
| Reused MFT record numbers mid-scan; whether unallocated records are filtered | §3.2: both addressed directly — unallocated records are already excluded by `ntfs-reader`'s own bitmap/is-used checks (confirmed in its source, no action needed); reused-record races are accepted as a rare, benign, self-correcting limitation of a point-in-time raw read |
| `fsutil` invocation style | Reviewed and confirmed consistent with the existing argv-array-only discipline — no change needed |
