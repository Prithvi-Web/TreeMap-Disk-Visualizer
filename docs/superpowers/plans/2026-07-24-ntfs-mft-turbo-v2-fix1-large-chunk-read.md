# NTFS MFT Turbo v2 — Fix #1: Large-Chunk MFT Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the confirmed, source-traced cause of `ntfs-mft`'s slow raw
`$MFT` read (58.6s of a measured 74.1s run — 79%): `ntfs-reader`'s
`open_volume()` hardcodes a 4096-byte read block with no lookahead, forcing
roughly one OS seek+read syscall pair per 4KB of a multi-gigabyte file.

**Architecture:** Bypass `Mft::new(volume)`'s internal call to
`open_volume()` by constructing a large-buffer `AlignedReader` ourselves and
calling `ntfs-reader`'s own public `Mft::get_record_fs`/`Mft::read_data_fs`
directly — plus vendoring the one function those two rely on internally that
isn't public (`fixup_record`, ~35 lines, MIT-licensed, verified to touch only
`pub` items). `Mft`'s fields are all `pub`, so the result is a completely
normal `Mft` value — every existing method (`.files()`, etc.) works on it
unchanged. This is a workaround against the crate's existing public API, not
a fork.

**Tech Stack:** Rust (`native/ntfs-mft-scan`), `ntfs-reader` 0.4.5.

**Spec:** `docs/superpowers/specs/2026-07-24-ntfs-mft-turbo-v2-design.md` §2–3
— read this first for the full root-cause trace and why this approach was
chosen over reimplementing from scratch or switching dependencies.

---

## Before starting: pin the exact source being vendored

`fixup_record` is being copied verbatim from `ntfs-reader`, not reimplemented.
That copy must come from the **exact version actually resolved**, not
whatever `main` on GitHub currently shows (which can be ahead of the last
published release).

- [ ] **Step 1: Confirm the resolved version**

Run: `cd native/ntfs-mft-scan && cargo tree -p ntfs-reader --depth 0`
Expected: one line, `ntfs-reader v0.4.5`. (Without `--depth 0` this prints
the whole transitive dependency tree, not just the one line — still fine to
read, `--depth 0` just matches what's actually needed here.)

- [ ] **Step 2: Fetch that exact tag's source, not `main`**

```bash
gh api repos/kikijiki/ntfs-reader/contents/src/mft.rs?ref=v0.4.5 --jq '.content' | base64 -d
```

(Run this via the project's Bash tool, not native PowerShell — PowerShell has
no `base64 -d`. Confirmed against tag `v0.4.5` directly during plan review:
it exists exactly as named and matches `main` for every file this plan
touches, so no drift to reconcile as of this writing.)

If tag `v0.4.5` doesn't exist under that exact name, check
`gh api repos/kikijiki/ntfs-reader/tags --jq '.[].name'` for the right one, or
fall back to the crates.io source tarball for that exact version
(`https://crates.io/api/v1/crates/ntfs-reader/0.4.5/download`). Do not vendor
from `main` if it differs from the resolved version — confirm `fixup_record`'s
body byte-for-byte matches what Task 1 below expects before proceeding. (At
the time this plan was written, `main` and `0.4.5` were confirmed
consistent — this step exists so a future drift doesn't go unnoticed.)

---

## Task 1: Vendor `fixup_record`, with a real unit test

The one piece of new logic in this whole fix, and the one place a subtle bug
would silently corrupt every record read back — so it gets its own test
before it's ever wired into the real read path.

**Files:**
- Modify: `native/ntfs-mft-scan/src/main.rs`

- [ ] **Step 1: Write the failing test**

Add near the bottom of `native/ntfs-mft-scan/src/main.rs`, inside the existing
`#[cfg(test)] mod tests { ... }` block (alongside
`json_string_escapes_controls_not_rust_debug`):

```rust
#[test]
fn fixup_record_restores_sector_end_bytes_from_the_usa() {
    // A minimal synthetic record: header + a 2-sector (1024-byte) body.
    // update_sequence_offset points past the header; update_sequence_length
    // is 3 (1 USN + 2 sector-fixup entries, matching a 1024-byte/2-sector
    // record) per the real NTFS on-disk format.
    let mut data = vec![0u8; 1024];
    let usn_offset: u16 = 48; // arbitrary, past a real header's fixed fields
    let usn_length: u16 = 3;
    data[4..6].copy_from_slice(&usn_offset.to_le_bytes()); // update_sequence_offset
    data[6..8].copy_from_slice(&usn_length.to_le_bytes()); // update_sequence_length

    let usa_start = usn_offset as usize + 2;
    // The USN marker value at usa_start-2..usa_start (index 0 of the USA)
    let marker: [u8; 2] = [0xAB, 0xCD];
    data[usn_offset as usize..usa_start].copy_from_slice(&marker);
    // Two real sector-end bytes, saved in the USA, and the sector ends
    // themselves overwritten with the marker (as NTFS does on disk).
    let real_sector0: [u8; 2] = [0x11, 0x22];
    let real_sector1: [u8; 2] = [0x33, 0x44];
    data[usa_start..usa_start + 2].copy_from_slice(&real_sector0);
    data[usa_start + 2..usa_start + 4].copy_from_slice(&real_sector1);
    data[510..512].copy_from_slice(&marker); // sector 0 end, corrupted on-disk
    data[1022..1024].copy_from_slice(&marker); // sector 1 end, corrupted on-disk

    fixup_record(0, &mut data).expect("valid USA should fix up cleanly");

    assert_eq!(&data[510..512], &real_sector0, "sector 0 end must be restored");
    assert_eq!(&data[1022..1024], &real_sector1, "sector 1 end must be restored");
}

#[test]
fn fixup_record_rejects_a_sector_end_that_does_not_match_the_marker() {
    let mut data = vec![0u8; 1024];
    let usn_offset: u16 = 48;
    let usn_length: u16 = 3;
    data[4..6].copy_from_slice(&usn_offset.to_le_bytes());
    data[6..8].copy_from_slice(&usn_length.to_le_bytes());
    let usa_start = usn_offset as usize + 2;
    data[usn_offset as usize..usa_start].copy_from_slice(&[0xAB, 0xCD]);
    data[usa_start..usa_start + 4].copy_from_slice(&[0x11, 0x22, 0x33, 0x44]);
    // Sector 0's last 2 bytes DON'T match the marker — corrupt/torn write.
    data[510..512].copy_from_slice(&[0x00, 0x00]);

    let result = fixup_record(0, &mut data);
    assert!(result.is_err(), "a mismatched sector-end marker must be rejected, not silently accepted");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd native/ntfs-mft-scan && cargo test fixup_record`
Expected: FAIL — `fixup_record` is not defined in this crate yet.

- [ ] **Step 3: Vendor the function**

Add to `native/ntfs-mft-scan/src/main.rs`, near the top-level functions
(after `namespace_rank`, before `write_json_string` — anywhere at module
scope is fine):

```rust
/// Vendored verbatim from `ntfs-reader` 0.4.5's `src/mft.rs`
/// (`Mft::fixup_record`) — MIT OR Apache-2.0, Copyright (c) 2022 Matteo
/// Bernacchia (https://github.com/kikijiki/ntfs-reader). That function is
/// private to the crate (`fn fixup_record`, no `pub`), so it can't be called
/// from here directly. Copied rather than reimplemented from scratch: this
/// is NTFS's Update Sequence Array repair, and a subtly-wrong reimplementation
/// would silently corrupt every record read back rather than fail loudly.
/// See docs/superpowers/specs/2026-07-24-ntfs-mft-turbo-v2-design.md §3.
fn fixup_record(record_number: u64, data: &mut [u8]) -> ntfs_reader::errors::NtfsReaderResult<()> {
    use ntfs_reader::api::{NtfsFileRecordHeader, SECTOR_SIZE};
    use ntfs_reader::errors::NtfsReaderError;

    if data.len() < core::mem::size_of::<NtfsFileRecordHeader>() {
        return Err(NtfsReaderError::CorruptMftRecord { number: record_number });
    }
    let header =
        unsafe { core::ptr::read_unaligned(data.as_ptr() as *const NtfsFileRecordHeader) };

    let usn_start = header.update_sequence_offset as usize;
    if usn_start + 2 > data.len() {
        return Err(NtfsReaderError::CorruptMftRecord { number: record_number });
    }
    let usa_start = usn_start + 2;
    let usa_end =
        usn_start.saturating_add((header.update_sequence_length as usize).saturating_mul(2));
    if usa_end > data.len() {
        return Err(NtfsReaderError::CorruptMftRecord { number: record_number });
    }

    let usn0 = data[usn_start];
    let usn1 = data[usn_start + 1];

    let mut sector_off = SECTOR_SIZE - 2;
    for usa_off in (usa_start..usa_end).step_by(2) {
        if sector_off + 2 > data.len() {
            break;
        }

        let mut usa = [0u8; 2];
        usa.copy_from_slice(&data[usa_off..usa_off + 2]);

        let d0 = data[sector_off];
        let d1 = data[sector_off + 1];
        if d0 != usn0 || d1 != usn1 {
            return Err(NtfsReaderError::CorruptMftRecord { number: record_number });
        }

        data[sector_off..sector_off + 2].copy_from_slice(&usa);
        sector_off += SECTOR_SIZE;
    }
    Ok(())
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd native/ntfs-mft-scan && cargo test fixup_record`
Expected: PASS — both new tests green.

- [ ] **Step 5: Commit**

```bash
git add native/ntfs-mft-scan/src/main.rs
git commit -m "feat(native): vendor ntfs-reader's fixup_record, TDD against a synthetic USA"
```

---

## Task 2: `read_mft_fast` — the large-buffer read path

**Files:**
- Modify: `native/ntfs-mft-scan/src/main.rs`

- [ ] **Step 1: Add the imports and constant**

Add near the top of `native/ntfs-mft-scan/src/main.rs`, alongside the
existing `use ntfs_reader::...` lines (currently line 23):

```rust
use ntfs_reader::aligned_reader::AlignedReader;
use ntfs_reader::errors::NtfsReaderError;
```

(`Volume` is already imported at line 25 — this is exactly the two new
imports needed, nothing else; a spec-review pass caught an earlier draft of
this step redundantly re-importing `Volume` here too, which would just
produce an unused-import warning.)

Add near `const ROOT_RECORD_NO: u64 = 5;` (line 33):

```rust
/// 1MB, matching uffs-mft's disclosed NVMe chunk size (their README: "4MB for
/// NVMe, 2MB for SSD, 1MB for HDD"). A single fixed size rather than
/// per-drive-type tuning — that's a reasonable future refinement, not needed
/// to fix the ~1M-tiny-syscall problem this targets. Must be a power of two
/// (AlignedReader::new validates this) — 1_048_576 = 2^20.
const MFT_READ_CHUNK_BYTES: u64 = 1_048_576;
```

- [ ] **Step 2: Add `read_mft_fast`**

Add as a new top-level function, near `resolve_target`/`subtree_edge_indices`
(anywhere at module scope before `main()`):

```rust
/// Builds an `Mft` exactly like `Mft::new(volume)` does, except the $MFT's
/// Data/Bitmap attributes are read through a large-buffer reader instead of
/// `open_volume()`'s hardcoded 4096-byte one with no lookahead (spec §2: that
/// hardcoding costs ~1M syscall pairs on a ~4GB $MFT, measured at 58.6s of a
/// 74.1s run). `Mft`'s fields are public, so the result here is indistinguishable
/// from what `Mft::new` builds — every method on it (`.files()`, etc.) is
/// unchanged code, untouched by this fix.
fn read_mft_fast(volume: Volume, chunk_bytes: u64) -> ntfs_reader::errors::NtfsReaderResult<Mft> {
    let file = std::fs::File::open(&volume.path)?;
    let mut reader = AlignedReader::new(file, chunk_bytes)?;

    let mft_record =
        Mft::get_record_fs(&mut reader, volume.file_record_size, volume.mft_position)?;

    let mut data = Mft::read_data_fs(&volume, &mut reader, &mft_record, NtfsAttributeType::Data)?
        .ok_or_else(|| NtfsReaderError::MissingMftAttribute("Data".to_string()))?;
    let bitmap = Mft::read_data_fs(&volume, &mut reader, &mft_record, NtfsAttributeType::Bitmap)?
        .ok_or_else(|| NtfsReaderError::MissingMftAttribute("Bitmap".to_string()))?;

    let max_record = data.len() as u64 / volume.file_record_size;
    for number in 0..max_record {
        let start = (number * volume.file_record_size) as usize;
        let end = start + volume.file_record_size as usize;
        fixup_record(number, &mut data[start..end])?;
    }

    Ok(Mft { volume, data, bitmap, max_record })
}
```

**Verify while implementing, don't assume:** `Mft`'s struct fields
(`volume`, `data`, `bitmap`, `max_record`) and `Volume`'s fields (`path`,
`file_record_size`, `mft_position`) must all be `pub` for the final
`Ok(Mft { ... })` struct literal and the field accesses above to compile from
outside the crate — this was confirmed during spec review against
`ntfs-reader`'s source, but confirm it again against whatever
`cargo tree`/Step 2 above actually resolved, in case of drift.

- [ ] **Step 3: Wire it into `main()`**

In `native/ntfs-mft-scan/src/main.rs`, replace the `Mft::new(volume)` call
(currently lines 233–240):

```rust
    phase.log("loading MFT index…");
    let mft = match Mft::new(volume) {
        Ok(m) => m,
        Err(e) => {
            phase.log(&format!("failed to read MFT: {e}"));
            return ExitCode::FAILURE;
        }
    };
```

with:

```rust
    phase.log("loading MFT index…");
    let mft = match read_mft_fast(volume, MFT_READ_CHUNK_BYTES) {
        Ok(m) => m,
        Err(e) => {
            phase.log(&format!("failed to read MFT: {e}"));
            return ExitCode::FAILURE;
        }
    };
```

(Identical error-handling shape — only the function called changes. Nothing
else in `main()` needs to change: `mft.files()` and everything after it is
completely unaffected, since `read_mft_fast` returns a real `Mft`.)

- [ ] **Step 4: Build and confirm it compiles**

Run: `cd native/ntfs-mft-scan && cargo build --release`
Expected: compiles cleanly. If it doesn't — most likely cause is a field or
function turning out not to be `pub` in the actually-resolved version (see
Step 2's verification note) — fix the specific compile error, don't work
around it by reintroducing `open_volume()`.

- [ ] **Step 5: Run the existing unit tests**

Run: `cd native/ntfs-mft-scan && cargo test`
Expected: PASS — the two new `fixup_record` tests plus the existing
`json_string_escapes_controls_not_rust_debug` test, all green.

- [ ] **Step 6: Commit**

```bash
git add native/ntfs-mft-scan/src/main.rs
git commit -m "fix(native): read the \$MFT in 1MB chunks instead of 4KB, ~1M fewer syscalls"
```

---

## Task 3: Confirm the real number (manual, cannot be automated)

This cannot run in CI or without a real Windows machine and admin rights —
same reason v1's Task 10 was manual. The whole point of this fix is a
measured claim; it doesn't get to be "done" until it's actually measured.

- [ ] Build for real: `npm run build:ntfs-mft-scan:dev`
- [ ] `npm run dev`, check "Turbo NTFS scan", scan the **same folder** used
      for the baseline in the spec (`C:\Users\nucle`, or whatever the
      equivalent real path is on the machine doing this) so the comparison is
      apples-to-apples
- [ ] Read the real phase timings from `logs/scan-timings.jsonl` (same file
      the spec's §1 numbers came from) — specifically the "Raw `$MFT` read"
      phase duration, previously 58.6s
- [ ] **Update the spec with the real number, not the projected range.** In
      `docs/superpowers/specs/2026-07-24-ntfs-mft-turbo-v2-design.md`, §3's
      "Projected after fix" table currently says "~2–10s" for the read phase
      and "~17.5–25.5s" total, explicitly marked "Not yet confirmed." Replace
      both with the real measured numbers once you have them, and remove the
      "not yet confirmed" caveat — that's what makes this fix's story
      complete, matching the spec's own "measured, not assumed" standard.
- [ ] If the real number is *not* a dramatic improvement, stop and
      re-diagnose before touching Plan #2 — Plan #2's warm-path ROI
      calculus (§5/§6 of the spec) implicitly assumes this fix landed close
      to its projection. Don't build the two-phase system on top of an
      unconfirmed assumption.

---

## Task 4: Commit the lockfile

Flagged in spec review: no `Cargo.lock` was committed for
`native/ntfs-mft-scan`, meaning the exact resolved `ntfs-reader` version
(and therefore what's actually available to vendor `fixup_record` against)
isn't pinned.

- [ ] **Step 1: Check whether it's already gitignored**

Run: `cat .gitignore | grep -i cargo` (from the repo root)

If `Cargo.lock` or `**/Cargo.lock` is excluded, that exclusion needs removing
for this binary crate specifically — binaries should commit their lockfile
(only libraries conventionally don't). Libraries omit it so downstream
consumers can pick their own resolved versions; a binary like
`ntfs-mft-scan` has no downstream consumers of its own dependency graph, so
there's no reason to give up the reproducibility a committed lockfile buys.

- [ ] **Step 2: Commit it**

```bash
git add native/ntfs-mft-scan/Cargo.lock
git commit -m "chore(native): commit Cargo.lock, pinning the exact ntfs-reader version"
```
