# NTFS MFT turbo engine v2: fix the real bottleneck, add the two-phase system

**Date:** 2026-07-24
**Status:** Design — awaiting spec review
**Goal:** Fix the confirmed, source-traced cause of `ntfs-mft`'s slowness (not the
cause the original research doc assumed), and extend the engine to the full
two-phase model the user chose (Option C): cold scan ≤10–15s, every later scan
of that volume ≤2–3s via a persisted, checkpointed index kept fresh by the USN
journal.

**Supersedes/extends:** `docs/superpowers/specs/2026-07-24-ntfs-mft-engine-design.md`
(v1 — shipped as Tasks 1–9, live in `main`/`feat/ntfs-mft-engine`). This is not a
rewrite of v1; it fixes a real bug in the read path v1 shipped with, and adds a
second phase v1 explicitly scoped out ("Journal API for incremental re-scan...
a second feature, not this PR"). That second feature is this PR.

---

## 1. Measured baseline — all numbers from this machine, same folder

Both runs: `C:\Users\nucle`, same session, close together in time (item counts
differ by ~9.7k between them — normal filesystem churn between two multi-minute
runs, not a correctness issue; a clean apples-to-apples parity test is tracked
in §7 but is not what these numbers are for).

| Engine | Time | Items |
|---|---|---|
| `turbo-walker` (existing, no Turbo NTFS) | **139.7s** | 2,574,749 |
| `ntfs-mft` (current, unoptimized) | **74.1s** | 2,565,050 |

**`ntfs-mft` is already 1.89× faster than the walker, before any fix in this
spec.** Phase breakdown of the 74.1s, from the helper's own instrumented
`eprintln`s plus the Node-side timing log:

| Phase | Duration | % of total |
|---|---|---|
| UAC/elevation + process spawn overhead | ~8.0s | 11% |
| Open volume | ~1ms | ~0% |
| **Raw `$MFT` read** (`Mft::new`) | **58.6s** | **79%** |
| Enumerate + parse attributes → edges (3.97M edges) | 1.6s | 2% |
| Build `edgesByParent` index, resolve target, BFS filter (→ 2.565M edges)¹ | 0.46s | 1% |
| Write NDJSON (2.565M edges, 291.9 MB) | 0.72s | 1% |
| Node-side: parse NDJSON + build `PackedScanStore` | 4.7s | 6% |

**This directly refutes the original research doc's diagnosis.** That doc
blamed "we walk every attribute into owned `String`s + NDJSON" — enumeration +
NDJSON writing combined are 2.3s, about 3% of total. The real cost, at 79%, is
the raw disk read, and it happens *before* a single attribute is parsed.

¹ This row is a blended bucket, not a pure "BFS" measurement — the helper
doesn't log building the `edgesByParent` index or the `resolve_target` path
walk separately from the BFS filter itself. Fine for prioritization (it's 1%
of total either way), but don't read it as an isolated BFS cost.

---

## 2. Root cause, confirmed against source — not a hypothesis

Traced directly through `ntfs-reader`'s actual code (already vendored as a
dependency; nothing here is guessed):

`aligned_reader.rs`'s `open_volume()`:
```rust
pub fn open_volume(path: &Path) -> std::io::Result<BufReader<AlignedReader<File>>> {
    let file = File::open(path)?;
    let sr = AlignedReader::new(file, 4096u64)?;  // hardcoded 4096
    ...
}
```

`AlignedReader::read()` caps every single call at the alignment size,
**regardless of how large the caller's destination buffer is**:
```rust
let to_read = buf.len().min(self.alignment as usize - start);  // never > ~4096 bytes
```

and re-issues a full OS `seek()` + `read_exact()` pair every time the requested
block isn't the one currently cached (there is no lookahead beyond a single
4096-byte block):
```rust
if aligned_position != self.buffer_pos || size > self.buffer_size {
    self.inner.seek(SeekFrom::Start(aligned_position))?;
    self.buffer.resize(size, 0u8);
    self.inner.read_exact(&mut self.buffer)?;
    ...
}
```

`mft.rs`'s `read_attribute_data` calls `reader.read_exact(&mut data[start..])`
for each non-resident data run of the `$MFT`'s `Data` attribute. For a large
contiguous run, `read_exact` loops calling `.read()` until full — and since
`AlignedReader::read()` can never return more than ~4096 bytes per call, a
multi-gigabyte sequential read gets serviced **4096 bytes at a time, one
syscall pair per block**, independent of how fragmented the file actually is.

For a `$MFT` around 4GB (consistent with the ~4M-record volume measured):
**4GB ÷ 4KB ≈ 1,048,576 individual seek+read syscalls.** At a modest ~50µs of
overhead each, that alone is ~52s — matching the observed 58.6s closely enough
that this is treated as the confirmed cause, not one of several candidates.

This also cleanly explains the `uffs-mft` comparison from the earlier research
pass: their own disclosed phase breakdown was 87% I/O / 12% parse for a
similarly-sized (4.5GB) MFT, at ~1.87s for the I/O phase — they read in
1–4MB chunks specifically to avoid this exact failure mode. Same conceptual
cost (reading N gigabytes off disk), paid efficiently instead of one 4KB block
at a time.

---

## 3. Fix #1: read in large chunks — a workaround, not a fork

**Decision, confirmed with the user: match `uffs-mft`'s strategy (1–4MB
chunks), implemented as a workaround against `ntfs-reader`'s existing public
API, not a fork and not a dependency swap.**

`AlignedReader::new(inner, alignment)` already accepts `alignment` as a
parameter — the crate isn't structurally limited to 4KB, `open_volume()` just
never calls it with anything else. Two of the three functions `Mft::new` uses
internally are already `pub` and generic over `R: Seek + Read`: `get_record_fs`
and `read_data_fs` (confirmed in `mft.rs`).

**Correction from spec review:** the third, `fixup_record`, is **not**
`pub` — it's private to the crate's `mft` module, so it cannot be called from
an external dependent crate as written. A first draft of this spec claimed
otherwise; a review caught it. This does not block the fix, but changes how
it's characterized: `fixup_record` is a small (~35-line), fully deterministic
NTFS Update Sequence Array repair routine, and everything it touches —
`NtfsFileRecordHeader`'s `update_sequence_offset`/`update_sequence_length`
fields, and the `SECTOR_SIZE` constant — is `pub` (confirmed in `api.rs`).
Since the crate is dual MIT/Apache-2.0 licensed, the correct move is to
**vendor that one function verbatim into our own helper** (copied with a
source/license attribution comment), not to reimplement its logic from
scratch (a real correctness risk for a bug that would silently corrupt every
record read back) and not to fork the whole crate for one missing `pub`
keyword. So: the helper builds its own large-buffer reader, calls the crate's
own `get_record_fs`/`read_data_fs` directly, and applies the vendored
`fixup_record` copy to each record — reproducing `Mft::new`'s ~30 lines of
logic (already read in full during v1's research) against a
differently-configured reader, plus one small vendored function.

**One behavior to reproduce exactly, caught in second-pass review:** `Mft::
new` doesn't just call `read_data_fs` and trust the result — it converts a
`None` (Data/Bitmap attribute genuinely missing, however unlikely on a real
volume) into `NtfsReaderError::MissingMftAttribute` via `.ok_or_else(...)`
rather than unwrapping. The reproduction must do the same — an `.unwrap()`
here would turn a rare-but-real "attribute missing" case into a panic instead
of a clean, catchable error that falls back like everything else in this
engine does.

```rust
let file = std::fs::File::open(&volume.path)?;
let reader = AlignedReader::new(file, 1_048_576)?; // 1MB, matching uffs-mft's NVMe chunk size
let mut reader = BufReader::new(reader);
// then: get_record_fs, read_data_fs(Data), read_data_fs(Bitmap), fixup_record —
// identical sequence to Mft::new, just fed by this reader instead of open_volume()'s.
```

**Scope note:** only the `$MFT`-reading path needs this. `Volume::new()`'s own
boot-sector read (via the crate's default `open_volume()`) is a single small
read — not the bottleneck, and not touched by this fix.

**Not yet confirmed:** the exact resulting time. §7's first task is to build
this and re-run the same timed benchmark on the same machine/folder before
this number is treated as real, following the same "measured, not assumed"
discipline as everything else in this spec. The projection below is a range,
not a claim:

| Phase | Current | Projected after fix |
|---|---|---|
| UAC/elevation overhead | 8.0s | 8.0s (unaffected by this fix) |
| Raw `$MFT` read | 58.6s | ~2–10s |
| Enumerate/parse/write | 2.8s | 2.8s |
| Node-side parse + store build | 4.7s | 4.7s |
| **Total** | **74.1s** | **~17.5–25.5s** |

(8.0 + 58.6 + 2.8 + 4.7 = 74.1, reconciling with §1's total exactly — a second
review caught this row previously reading 2.3s, which didn't sum correctly
against either §1's own 1.6+0.46+0.72=2.78s breakdown or the stated 74.1s
total.)

That's close to the ≤10–15s cold target but likely not quite there on its own
— the elevation overhead (§5) and the Node-side parse (§4) are the remaining
levers, in that order of expected impact.

---

## 4. Secondary, smaller lever: Node-side parse cost

~4.7s to parse a 291.9MB NDJSON file and build the `PackedScanStore` for
2.565M edges. Real, but an order of magnitude smaller than the primary fix —
flagged as a stretch task (§7), not a blocking one. Once the two-phase warm
path (§6) exists, this cost only applies to cold scans and full reindexes
anyway, not to the ≤2–3s warm path the user actually cares about most.

---

## 5. Elevation-persistence architecture — the one big open design choice

**This is the single biggest open question in this spec**, bigger than the
read-path fix. Right now, elevation happens per scan request (`sudo-prompt`,
now replaced per a recent commit — see current `ntfsMftScanner.ts` for the
live mechanism). That ~8s overhead is tolerable once, but Option C's promise —
"every later scan ≤2–3s" — cannot hold if "later" still pays a UAC round-trip
each time. A user closing and reopening the app should not lose the "warm"
experience; that is the actual bar Option C sets, not merely "warm within one
session."

Three ways to make elevation a one-time cost instead of a per-scan cost,
already surveyed in prior discussion:

1. Elevate once per app session only — smallest change, but doesn't survive
   an app restart, so doesn't really deliver Option C's promise.
2. **A Scheduled Task registered once at install time, "Run with highest
   privileges"** (piggybacking on the NSIS installer's own one-time elevation
   consent) — the app talks to it over local IPC for "give me anything new
   since checkpoint X." No further UAC prompts after install, ever, without
   the footprint of a full service.

   **Invocation path matters and must be specified precisely — a second spec
   review flagged this as a real gap, not a nitpick.** "Highest privileges"
   only actually skips UAC when the task is triggered *through the Task
   Scheduler service itself* (a logon trigger that starts it as the daemon,
   `schtasks /run`, or the Scheduler COM API) — it does **not** skip UAC if
   invoked via a shortcut, `ShellExecute`, or a naive elevated `CreateProcess`
   from outside that service, a documented Windows behavior. The design here
   is: the task runs as a **long-lived background process from a logon
   trigger** (started once, elevated, without a prompt, when the user logs
   in), and the app's IPC channel talks to that already-running process — it
   never asks Task Scheduler to launch a fresh instance per query. Getting
   this wrong (e.g. having the app invoke `schtasks /run` synchronously per
   query instead of talking to a standing process) would silently reintroduce
   per-scan latency this design exists to eliminate, even though "no UAC
   prompt" would still technically hold.
3. A real Windows Service — closest to what serious prior art (Everything,
   and the UFFS project surveyed earlier) actually does, but the largest
   installation/security footprint: SCM registration, a service account,
   its own update/uninstall story.

**Recommendation: option 2.** It's the smallest thing that actually satisfies
Option C's real intent (fast forever, not just fast this session), reuses a
consent the installer already asks for once, and avoids the service-account/
SCM-lifecycle complexity of option 3. This is flagged explicitly as a
judgment call for review/user sign-off, not a settled fact the way §2/§3 are —
unlike the read-path fix, there's no measured evidence pointing at one answer
here, only a reasoned tradeoff.

**Mandatory fallback, no exceptions:** covers two distinct failure modes, not
just one — (a) the task **isn't registered** (declined at install, portable/
dev build, removed by the user or a policy), and (b) the task **is
registered but fails to reach/execute** (stale credentials, access denied,
the standing process crashed and the logon trigger hasn't fired again yet).
Both fall back to today's opt-in per-scan elevation — never a silent failure,
matching the fallback discipline everywhere else in this codebase. The
original draft only named case (a); a second review caught that (b) is a
distinct, equally-real, silent-failure-shaped gap.

---

## 6. Persisted, checkpointed index — the warm-path data model

Confirmed against documented Windows USN/journal behavior and cross-checked
against a real, shipping, actively-maintained implementation of exactly this
pattern (the UFFS project's `cmd_index_save`/`cmd_index_load`, surveyed during
this design pass — not something being adopted as a dependency, just validated
prior art for the model):

**Per volume, two persisted artifacts** (app data dir, matching the existing
`storage.ts` `appDataDir()` pattern already used elsewhere in this codebase):

- A binary, FRN-indexed record store (fixed-size records, MFT record number as
  the array index — matches how the mapper already thinks in FRNs from v1).
- A small metadata/checkpoint file: `VolumeSerialNumber`, `UsnJournalID`,
  `LastUsnProcessed`.

**Trivial case first:** no checkpoint file exists yet for this volume (first
ever run) → build fresh, same as any other full reindex, just without a
"stored value didn't match" reason attached.

**Invalidation logic on every warm attempt** (i.e., once a checkpoint exists),
in order:

1. Stored `VolumeSerialNumber` doesn't match the volume's current one → full
   reindex (different/reformatted volume under the same drive letter).
2. Stored `UsnJournalID` doesn't match the volume's current one → full
   reindex. The journal was deleted and recreated (`fsutil usn deletejournal`,
   or various other triggers) — old USN values are meaningless against a new
   journal instance, and silently resuming would miss changes rather than
   error loudly.
3. Stored `LastUsnProcessed` is older than the journal's current `FirstUsn` →
   full reindex. The journal is a bounded, rolling log; if the checkpoint is
   older than the oldest record still retained, some changes were already
   discarded before we could read them.
4. Otherwise → incremental: resume `FSCTL_READ_USN_JOURNAL` from
   `LastUsnProcessed`, apply changes to the FRN-indexed store, persist the new
   checkpoint.

**Confirmed gap in `ntfs-reader`'s public API:** its `Journal` struct stores
`UsnJournalID`/`FirstUsn` (queried via `FSCTL_QUERY_USN_JOURNAL` at
construction) as a **private field with no public getter** — only
`get_next_usn()` is exposed (confirmed directly in `journal.rs`). Rather than
fork the crate for a missing accessor, or depend on a patched copy, the plan
issues that same `FSCTL_QUERY_USN_JOURNAL` call directly via the `windows`
crate (already a transitive dependency, and the exact call `Journal::new`
itself makes internally, already read in full) — a small, self-contained
~15-line duplication, not a patch to someone else's crate.

**Applying journal events correctly** (per the invalidation research):
rename events change `Name`/`ParentFRN` and must update the FRN record in
place, not be treated as delete+create; delete marks a FRN as gone; a later
create with the *same* FRN is a normal, expected event (NTFS reuses MFT
records) — not a bug, not the same file. Hardlinks continue to use the
distinct-parent-FRN model from v1's own mapper design.

---

## 7. Scope

**In scope for this PR:**
- Fix #1 (§3): large-chunk `$MFT` read, workaround against `ntfs-reader`'s
  existing public API.
- The elevation-persistence mechanism from §5 (recommended: scheduled task),
  with the mandatory per-scan-elevation fallback.
- The persisted, checkpointed FRN-indexed store and USN-based incremental
  update from §6.
- A minimal "rebuild index" affordance in the UI — cheap to add, and matches
  the robustness bar the rest of this app holds (a user should never be stuck
  with a silently-stale index and no way out).
- Re-running the real timed benchmark after Fix #1, before treating its
  number as fact (§3's own discipline).

**Explicitly out of scope / follow-up:**
- Fix #2 (§4), the Node-side parse cost — real but an order of magnitude
  smaller; revisit only if it becomes the new bottleneck after §3/§5/§6 land.
- Full crash-recovery semantics for the scheduled-task/broker process beyond
  "if it's not there, fall back" — a genuinely robust update/health story for
  that component is a reasonable second iteration, not a blocker for this one.
- Cross-volume dedup in the persisted index.
- ReFS support (unchanged from v1 — no MFT on ReFS, falls back like any
  non-NTFS volume).

---

## 8. Testing

- **Benchmark task, gated on real measurement**: rebuild with Fix #1, rerun
  the exact same timed scan on the same folder, record the real number before
  writing it into any doc as fact.
- **Walker-vs-`ntfs-mft` parity test** (the thing §1 refers to but this list
  previously omitted — closing that gap): scan the same real folder with both
  engines back to back and assert file count, dir count, total bytes, and
  hardlink count match exactly, the same byte-for-byte gate v1's gdu-vs-walker
  and ntfs-mft-vs-walker parity tests already enforce. §1's two numbers
  (139.7s / 74.1s) differed by ~9.7k items purely from filesystem churn
  between two separate multi-minute runs — this test controls for that by
  running both close together and comparing the same snapshot's worth of
  ground truth, not just eyeballing similar totals.
- **Commit `native/ntfs-mft-scan/Cargo.lock`** if it isn't already (spec
  review found no lockfile pinning the resolved `ntfs-reader` version) — Fix
  #1 depends on the exact private/public shape of a specific version's
  source; an unpinned transitive bump could silently change what's available
  to vendor against.
- **Invalidation-logic tests** (pure, fixture-driven, no elevation needed):
  volume-serial mismatch → reindex; journal-ID mismatch → reindex; checkpoint
  older than `FirstUsn` → reindex; valid checkpoint → incremental path taken.
- **Journal event application tests**: rename updates name/parent in place;
  delete-then-recreate-same-FRN is treated as a new file, not corruption;
  hardlink-across-distinct-parents dedup still matches v1's rule.
- **Fallback tests**: scheduled task absent/removed → per-scan elevation path,
  never a silent failure or a scan error.
- **Manual/opt-in real-machine test** (same discipline as v1's Task 10):
  confirm the scheduled task survives an app restart and a machine reboot,
  and that a genuinely warm scan (no changes since last checkpoint) lands in
  the ≤2–3s target on real hardware.

---

## 9. Risks

- **This is a materially bigger PR than v1.** A background elevated
  component, a persisted binary index format (with its own versioning
  story), scheduled-task registration/uninstallation, and journal-invalidation
  edge cases are all new surface area v1 didn't have.
- **Antivirus/EDR scrutiny increases.** A scheduled task configured to run
  elevated without further prompting, reading raw volume data on a schedule,
  is a bigger flag than v1's already-noted per-scan elevation. Code-signing
  (already planned) matters more here, not less.
- **Index format versioning.** A future change to the on-disk record layout
  must be detected and trigger a full reindex rather than misreading old
  records — this needs an explicit format-version field from day one, not
  bolted on later.
- **The §5 recommendation is a judgment call, not a measured fact** — flagged
  explicitly so review and the user's own read-through can push back on it
  specifically, unlike §2/§3 which are source-confirmed.

---

## 10. Revision note (for the reviewer)

A first draft of §3 claimed `get_record_fs`, `read_data_fs`, *and*
`fixup_record` were all `pub` in `ntfs-reader`. Spec review caught that
`fixup_record` is actually private, and fetched its real implementation plus
the `NtfsFileRecordHeader`/`SECTOR_SIZE` definitions to confirm a fix: vendor
that one function verbatim (MIT-licensed, ~35 lines, touches only `pub`
fields) rather than reimplement it or fork the crate. §3 and this section
were updated accordingly; §1's phase table also had one bucket's description
tightened (§1 footnote 1) and a missing-lockfile gap added to §9's testing
list.
