# NTFS MFT Turbo v2 — Two-Phase Warm Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every scan of a volume after the first builds and persists a
checkpointed index, kept fresh by the USN journal, so a later scan with no
relevant changes answers in ≤2–3s instead of re-reading the whole `$MFT`.

**Architecture:** Two genuinely different halves. The **data model** (§6 of
the spec) — a persisted FRN-indexed store, a checkpoint file, and USN-based
invalidation/incremental-update logic — is well-understood and TDD-able now.
The **elevation-persistence mechanism** (§5 of the spec) is explicitly an
open judgment call the spec itself flags, not a confirmed design — Task 5
below is a validation spike, not a "write this exact code" task, and
Tasks 6–8 are gated on it succeeding.

**Tech Stack:** Rust (`native/ntfs-mft-scan`), TypeScript
(`src/services/`), Windows Task Scheduler, `windows` crate (new direct
dependency — currently only pulled in transitively via `ntfs-reader`).

**Depends on:** Plan #1 (`2026-07-24-ntfs-mft-turbo-v2-fix1-large-chunk-read.md`)
should land and have its real benchmark number confirmed first — this plan's
warm-path ROI reasoning assumes that fix is in, per that plan's own Task 3.

**Spec:** `docs/superpowers/specs/2026-07-24-ntfs-mft-turbo-v2-design.md` §5–6.

---

## Scope note for whoever picks this up

This is a materially bigger, less-certain body of work than Plan #1. Tasks 1–4
and 9 are conventional TDD — read them and build them with full confidence.
Task 5 is a **spike**: go validate the elevation mechanism actually works the
way the spec claims, on a real machine, before writing production code around
it. If Task 5's validation fails or comes back ambiguous, **stop and bring
that back for a design discussion** rather than pushing forward on Tasks 6–8
against an unconfirmed foundation — that mirrors exactly why Plan #1's Task 3
exists (measured, not assumed).

---

## Task 1: Query the USN journal directly (bypass `ntfs-reader`'s private fields)

`ntfs-reader`'s `Journal` struct stores `UsnJournalID`/`FirstUsn` (from
`FSCTL_QUERY_USN_JOURNAL`) as private fields with no public getter (confirmed
against source during spec review — only `get_next_usn()` is public). Rather
than fork the crate, duplicate that one `DeviceIoControl` call directly via
the `windows` crate (the exact call `Journal::new` itself makes internally).

**Files:**
- Modify: `native/ntfs-mft-scan/Cargo.toml`
- Modify: `native/ntfs-mft-scan/src/main.rs`

- [ ] **Step 1: Add the `windows` dependency**

Add to `native/ntfs-mft-scan/Cargo.toml`, matching the version `ntfs-reader`
itself already pulls in (check `cargo tree -p windows` after Plan #1's
`Cargo.lock` is committed to confirm the exact version, then pin the same one
here to avoid Cargo linking two incompatible `windows` versions):

```toml
[dependencies]
ntfs-reader = "0.4.5"
windows = { version = "0.62", features = [
    "Win32_Foundation",
    "Win32_Storage_FileSystem",
    "Win32_System_Ioctl",
    "Win32_System_IO",
] }
```

- [ ] **Step 2: Add a `--usn-info` CLI mode**

Add a new flag to `parse_args()` in `native/ntfs-mft-scan/src/main.rs`
(alongside the existing `--volume`/`--root`/`--out`/`--log` flags): a boolean
`usn_info: bool`, set when `--usn-info` is present. When set, `main()` takes
a separate, much shorter path: open the volume (same elevation requirement),
query `FSCTL_QUERY_USN_JOURNAL`, and write one JSON line to `--out` with
`{"volumeSerialNumber":..,"usnJournalId":..,"firstUsn":..,"nextUsn":..}`,
then exit — it does not read the MFT at all.

```rust
struct UsnJournalInfo {
    volume_serial_number: u32,
    usn_journal_id: u64,
    first_usn: i64,
    next_usn: i64,
}

fn query_usn_journal_info(volume_path: &str) -> std::io::Result<UsnJournalInfo> {
    use windows::core::PCSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        CreateFileA, GetVolumeInformationByHandleW, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_SHARE_DELETE, OPEN_EXISTING, FILE_FLAG_OVERLAPPED,
    };
    use windows::Win32::System::Ioctl::{FSCTL_QUERY_USN_JOURNAL, USN_JOURNAL_DATA_V2};
    use windows::Win32::System::IO::DeviceIoControl;
    use std::ffi::CString;
    use std::mem::size_of;
    use std::os::raw::c_void;

    let path = CString::new(volume_path).unwrap();
    let handle: HANDLE = unsafe {
        CreateFileA(
            PCSTR::from_raw(path.as_bytes_with_nul().as_ptr()),
            // Spec/plan review caught this: a first draft used
            // FILE_GENERIC_READ only, but ntfs-reader's own Journal::new
            // (the thing this function's docstring claims to mirror) opens
            // with READ | WRITE — matching that exactly, not partially.
            (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED,
            None,
        )
    }.map_err(|e| std::io::Error::other(e.to_string()))?;

    let mut journal = USN_JOURNAL_DATA_V2::default();
    let mut bytes_returned = 0u32;
    unsafe {
        DeviceIoControl(
            handle,
            FSCTL_QUERY_USN_JOURNAL,
            None,
            0,
            Some(&mut journal as *mut _ as *mut c_void),
            size_of::<USN_JOURNAL_DATA_V2>() as u32,
            Some(&mut bytes_returned),
            None,
        )
    }.map_err(|e| std::io::Error::other(e.to_string()))?;

    // Confirmed during plan review: ntfs_reader::volume::Volume has no
    // serial-number field, so this second Win32 call is not optional —
    // volumeSerialNumber is the first, most load-bearing field in Task 3's
    // invalidation precedence and can't be left as a TODO. Reuses the same
    // handle already open above rather than opening the volume twice.
    let mut volume_serial: u32 = 0;
    unsafe {
        GetVolumeInformationByHandleW(
            handle,
            None,                      // lpVolumeNameBuffer — not needed
            0,                         // nVolumeNameSize
            Some(&mut volume_serial),  // lpVolumeSerialNumber — the one we want
            None,                      // lpMaximumComponentLength — not needed
            None,                      // lpFileSystemFlags — not needed
            None,                      // lpFileSystemNameBuffer — not needed
            0,                         // nFileSystemNameSize
        )
    }.map_err(|e| std::io::Error::other(e.to_string()))?;

    Ok(UsnJournalInfo {
        volume_serial_number: volume_serial,
        usn_journal_id: journal.UsnJournalID,
        first_usn: journal.FirstUsn,
        next_usn: journal.NextUsn,
    })
}
```

**Verify while implementing:** the exact `windows` crate 0.62 type names,
field casing, and `GetVolumeInformationByHandleW`'s exact parameter list
(some `windows`-crate versions group the out-params differently, or return
them via a struct rather than individual `Option<&mut _>` args) — the code
above is written against the pattern already confirmed working in
`ntfs-reader`'s own `journal.rs` for the `DeviceIoControl` call, but
`GetVolumeInformationByHandleW`'s exact shape wasn't independently verified
against this specific `windows` version and needs a real compile check, not
just a read-through.

- [ ] **Step 3: Manual test** (no unit-testable path without a real elevated
      volume — this is a thin wrapper around one Windows API call)

Build and run: `cargo build --release && ./target/release/ntfs-mft-scan.exe --volume C --usn-info --out usn-info.json` (elevated)
Expected: a JSON file with plausible-looking `usnJournalId`/`firstUsn`/`nextUsn` values, matching what `fsutil usn queryjournal C:` reports independently — cross-check against that command's output as the correctness gate here, since there's no other oracle.

- [ ] **Step 4: Commit**

```bash
git add native/ntfs-mft-scan/Cargo.toml native/ntfs-mft-scan/src/main.rs
git commit -m "feat(native): add --usn-info mode, querying the journal directly"
```

---

## Task 2: Persisted index format + checkpoint file (pure, TDD)

**Revised after plan review.** A first draft of this task used NDJSON (one
JSON line per record) for the persisted index, "the simplest thing that
satisfies today's needs." Review caught a real problem with that: the
spec's own §1 measured `JSON.parse`-ing 2.565M NDJSON edges at **~4.7s** —
and that's for one subtree scan's worth of edges. A *whole-volume* persisted
index (which is what this task actually builds — it has to cover every
record, not just one folder's subtree) is at least that large and plausibly
larger. Loading it via `JSON.parse` on every warm scan could eat most or all
of the ≤2–3s budget this entire plan exists to hit, before a single journal
event is even applied. That's not a future optimization to defer — it directly
contradicts this task's own purpose, so the format is binary from the start,
matching what spec §6 originally specified ("a binary, FRN-indexed record
store (fixed-size records...)").

**Files:**
- Create: `src/services/ntfsMftIndexStore.ts`
- Create: `tests/ntfsMftIndexStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/ntfsMftIndexStore.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveIndex, loadIndex, IndexCheckpoint } from '../src/services/ntfsMftIndexStore';

test('saveIndex then loadIndex round-trips records and checkpoint exactly', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ntfs-mft-index-'));
  const file = path.join(dir, 'C.idx');
  const checkpoint: IndexCheckpoint = {
    volumeSerialNumber: 123456789,
    usnJournalId: 0x1122334455667788n,
    lastUsnProcessed: 999n,
    formatVersion: 1,
  };
  const records = [
    { recordNo: 100, parentRecordNo: 5, name: 'fx', size: 0, isDir: true, mtimeMs: 1732000000000 },
    { recordNo: 101, parentRecordNo: 100, name: 'a.txt', size: 5, isDir: false, mtimeMs: 1732000000000 },
  ];

  await saveIndex(file, checkpoint, records);
  const loaded = await loadIndex(file);

  assert.deepEqual(loaded.checkpoint, checkpoint);
  assert.deepEqual(loaded.records, records);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('loadIndex rejects a file with a mismatched format version', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ntfs-mft-index-'));
  const file = path.join(dir, 'C.idx');
  await saveIndex(file, {
    volumeSerialNumber: 1, usnJournalId: 1n, lastUsnProcessed: 1n, formatVersion: 999,
  }, []);

  await assert.rejects(() => loadIndex(file), /format version/i);
  await fsp.rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/ntfsMftIndexStore.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/services/ntfsMftIndexStore.ts`:

```ts
import fsp from 'node:fs/promises';

/** Bump this if the on-disk record shape ever changes — loadIndex rejects
 *  anything else rather than silently misreading old records. */
export const INDEX_FORMAT_VERSION = 1;

export interface IndexCheckpoint {
  volumeSerialNumber: number;
  usnJournalId: bigint;
  lastUsnProcessed: bigint;
  formatVersion: number;
}

export interface IndexRecord {
  recordNo: number;
  parentRecordNo: number;
  name: string;
  size: number;
  isDir: boolean;
  mtimeMs: number;
}

const MAGIC = 0x4e4d4649; // "NMFI" as a little-endian u32
// checkpoint header: magic(4) + formatVersion(4) + volumeSerialNumber(4)
// + usnJournalId(8) + lastUsnProcessed(8) + recordCount(4) + namesBlobLength(4)
const HEADER_SIZE = 36;
// per-record fixed fields: recordNo(8) + parentRecordNo(8) + size(8)
// + mtimeMs(8) + isDir(1, padded to 4) + nameOffset(4) + nameLength(2, padded to 4)
const RECORD_SIZE = 48;

/**
 * Binary format, not NDJSON/JSON — a fixed-size header, a fixed-size record
 * array (no per-record parsing/allocation), and a separate names blob that
 * records point into by (offset, length). Chosen specifically because this
 * plan's own predecessor draft used NDJSON and a review caught that
 * `JSON.parse`-ing a whole-volume-sized index on every warm scan could burn
 * through the ≤2–3s warm budget by itself — see the note above this task.
 * Same "avoid a JSON.parse per record at scale" lesson this project already
 * learned twice (the Rust read path, and gdu's own mapper).
 */
export async function saveIndex(
  filePath: string,
  checkpoint: IndexCheckpoint,
  records: IndexRecord[],
): Promise<void> {
  const nameBuffers = records.map((r) => Buffer.from(r.name, 'utf8'));
  const namesBlobLength = nameBuffers.reduce((sum, b) => sum + b.length, 0);
  const buf = Buffer.alloc(HEADER_SIZE + records.length * RECORD_SIZE + namesBlobLength);

  let off = 0;
  buf.writeUInt32LE(MAGIC, off); off += 4;
  buf.writeUInt32LE(checkpoint.formatVersion, off); off += 4;
  buf.writeUInt32LE(checkpoint.volumeSerialNumber, off); off += 4;
  buf.writeBigUInt64LE(checkpoint.usnJournalId, off); off += 8;
  buf.writeBigInt64LE(checkpoint.lastUsnProcessed, off); off += 8;
  buf.writeUInt32LE(records.length, off); off += 4;
  buf.writeUInt32LE(namesBlobLength, off); off += 4;

  let nameOffset = HEADER_SIZE + records.length * RECORD_SIZE;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const nameBuf = nameBuffers[i];
    const recordStart = HEADER_SIZE + i * RECORD_SIZE;
    buf.writeBigUInt64LE(BigInt(r.recordNo), recordStart);
    buf.writeBigUInt64LE(BigInt(r.parentRecordNo), recordStart + 8);
    buf.writeBigUInt64LE(BigInt(r.size), recordStart + 16);
    buf.writeBigInt64LE(BigInt(r.mtimeMs), recordStart + 24);
    buf.writeUInt8(r.isDir ? 1 : 0, recordStart + 32);
    buf.writeUInt32LE(nameOffset, recordStart + 36);
    buf.writeUInt16LE(nameBuf.length, recordStart + 40);
    nameBuf.copy(buf, nameOffset);
    nameOffset += nameBuf.length;
  }

  await fsp.writeFile(filePath, buf);
}

export async function loadIndex(
  filePath: string,
): Promise<{ checkpoint: IndexCheckpoint; records: IndexRecord[] }> {
  const buf = await fsp.readFile(filePath);

  const magic = buf.readUInt32LE(0);
  const formatVersion = buf.readUInt32LE(4);
  if (magic !== MAGIC || formatVersion !== INDEX_FORMAT_VERSION) {
    throw new Error(
      `ntfs-mft index format version mismatch: file has ${formatVersion} (magic ${magic.toString(16)}), expected ${INDEX_FORMAT_VERSION}`,
    );
  }
  const checkpoint: IndexCheckpoint = {
    volumeSerialNumber: buf.readUInt32LE(8),
    usnJournalId: buf.readBigUInt64LE(12),
    lastUsnProcessed: buf.readBigInt64LE(20),
    formatVersion,
  };
  const recordCount = buf.readUInt32LE(28);

  const records: IndexRecord[] = new Array(recordCount);
  const namesStart = HEADER_SIZE + recordCount * RECORD_SIZE;
  for (let i = 0; i < recordCount; i++) {
    const recordStart = HEADER_SIZE + i * RECORD_SIZE;
    const nameOffset = buf.readUInt32LE(recordStart + 36);
    const nameLength = buf.readUInt16LE(recordStart + 40);
    records[i] = {
      recordNo: Number(buf.readBigUInt64LE(recordStart)),
      parentRecordNo: Number(buf.readBigUInt64LE(recordStart + 8)),
      size: Number(buf.readBigUInt64LE(recordStart + 16)),
      mtimeMs: Number(buf.readBigInt64LE(recordStart + 24)),
      isDir: buf.readUInt8(recordStart + 32) !== 0,
      name: buf.toString('utf8', nameOffset, nameOffset + nameLength),
    };
  }
  void namesStart; // kept for clarity/future validation, not otherwise used

  return { checkpoint, records };
}
```

**Verify while implementing:** `Number(bigUint64)` for `recordNo`/
`parentRecordNo`/`size` loses precision above 2^53 — fine for `recordNo`/
`parentRecordNo` (MFT record numbers on any real volume are far below that),
but double-check `size` can't legitimately exceed 2^53 bytes (~9 petabytes)
on any volume this app will ever see before assuming `Number` is safe there
too; if it ever needs to be exact past that range, keep it as `bigint` in
`IndexRecord` instead; the round-trip test in Step 1 covers only realistic
sizes and won't catch this by itself.

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test tests/ntfsMftIndexStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ntfsMftIndexStore.ts tests/ntfsMftIndexStore.test.ts
git commit -m "feat(scan): add persisted NTFS MFT index format with checkpoint"
```

---

## Task 3: Invalidation logic (pure, TDD)

**Files:**
- Create: `src/services/ntfsMftInvalidation.ts`
- Create: `tests/ntfsMftInvalidation.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/ntfsMftInvalidation.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRefreshStrategy } from '../src/services/ntfsMftInvalidation';

const baseCheckpoint = {
  volumeSerialNumber: 111,
  usnJournalId: 999n,
  lastUsnProcessed: 500n,
  formatVersion: 1,
};

test('no stored checkpoint -> full reindex, no reason needed beyond "first run"', () => {
  const result = decideRefreshStrategy(null, {
    volumeSerialNumber: 111, usnJournalId: 999n, firstUsn: 0n, nextUsn: 600n,
  });
  assert.equal(result.strategy, 'full-reindex');
  assert.equal(result.reason, 'no-checkpoint');
});

test('volume serial mismatch -> full reindex', () => {
  const result = decideRefreshStrategy(baseCheckpoint, {
    volumeSerialNumber: 222, usnJournalId: 999n, firstUsn: 0n, nextUsn: 600n,
  });
  assert.equal(result.strategy, 'full-reindex');
  assert.equal(result.reason, 'volume-serial-mismatch');
});

test('USN journal ID mismatch -> full reindex (journal was recreated)', () => {
  const result = decideRefreshStrategy(baseCheckpoint, {
    volumeSerialNumber: 111, usnJournalId: 12345n, firstUsn: 0n, nextUsn: 600n,
  });
  assert.equal(result.strategy, 'full-reindex');
  assert.equal(result.reason, 'journal-id-mismatch');
});

test('checkpoint older than FirstUsn -> full reindex (journal truncated past our checkpoint)', () => {
  const result = decideRefreshStrategy(baseCheckpoint, {
    volumeSerialNumber: 111, usnJournalId: 999n, firstUsn: 600n, nextUsn: 700n,
  });
  assert.equal(result.strategy, 'full-reindex');
  assert.equal(result.reason, 'checkpoint-gap');
});

test('valid checkpoint within range -> incremental, resuming from lastUsnProcessed', () => {
  const result = decideRefreshStrategy(baseCheckpoint, {
    volumeSerialNumber: 111, usnJournalId: 999n, firstUsn: 100n, nextUsn: 700n,
  });
  assert.equal(result.strategy, 'incremental');
  assert.equal(result.resumeFromUsn, 500n);
});

test('checkpoint exactly equal to nextUsn -> incremental with nothing to apply', () => {
  const result = decideRefreshStrategy(baseCheckpoint, {
    volumeSerialNumber: 111, usnJournalId: 999n, firstUsn: 100n, nextUsn: 500n,
  });
  assert.equal(result.strategy, 'incremental');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/ntfsMftInvalidation.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/services/ntfsMftInvalidation.ts`:

```ts
import { IndexCheckpoint } from './ntfsMftIndexStore';

export interface VolumeUsnState {
  volumeSerialNumber: number;
  usnJournalId: bigint;
  firstUsn: bigint;
  nextUsn: bigint;
}

export type RefreshStrategy =
  | { strategy: 'full-reindex'; reason: 'no-checkpoint' | 'volume-serial-mismatch' | 'journal-id-mismatch' | 'checkpoint-gap' }
  | { strategy: 'incremental'; resumeFromUsn: bigint };

/**
 * Decides whether a volume's persisted index can be updated incrementally
 * or must be rebuilt from scratch, per the invalidation model in
 * docs/superpowers/specs/2026-07-24-ntfs-mft-turbo-v2-design.md §6:
 * volume identity, then journal identity, then journal retention window —
 * any mismatch means silently resuming would miss changes rather than error
 * loudly, so it isn't attempted.
 */
export function decideRefreshStrategy(
  checkpoint: IndexCheckpoint | null,
  current: VolumeUsnState,
): RefreshStrategy {
  if (!checkpoint) return { strategy: 'full-reindex', reason: 'no-checkpoint' };
  if (checkpoint.volumeSerialNumber !== current.volumeSerialNumber) {
    return { strategy: 'full-reindex', reason: 'volume-serial-mismatch' };
  }
  if (checkpoint.usnJournalId !== current.usnJournalId) {
    return { strategy: 'full-reindex', reason: 'journal-id-mismatch' };
  }
  if (checkpoint.lastUsnProcessed < current.firstUsn) {
    return { strategy: 'full-reindex', reason: 'checkpoint-gap' };
  }
  return { strategy: 'incremental', resumeFromUsn: checkpoint.lastUsnProcessed };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test tests/ntfsMftInvalidation.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/ntfsMftInvalidation.ts tests/ntfsMftInvalidation.test.ts
git commit -m "feat(scan): add USN-checkpoint invalidation logic, TDD against 6 scenarios"
```

---

## Task 4: Read and apply USN journal events

**Files:**
- Modify: `native/ntfs-mft-scan/src/main.rs`
- Create: `src/services/ntfsMftJournalApply.ts`
- Create: `tests/ntfsMftJournalApply.test.ts`

- [ ] **Step 1: Add a `--usn-read <startUsn>` CLI mode (Rust)**

Add to `native/ntfs-mft-scan/src/main.rs`: a mode that constructs
`ntfs_reader::journal::Journal::new(volume, JournalOptions { next_usn:
NextUsn::Custom(start_usn), ..Default::default() })` and calls `.read()` in a
loop until no more records, writing one NDJSON line per `UsnRecord` (`usn`,
`fileId`, `parentId`, `reason`, `path`, `timestamp`) to `--out`, then the
final `next_usn` to a `_meta` line — mirroring the existing `_meta` pattern
already used for `targetRecordNo` in the cold-scan mode.

**Reason classification, flagged by plan review as a real gap in a first
draft:** a real `USN_RECORD`'s `Reason` field is a bitmask — a brand-new file
routinely arrives as `FILE_CREATE | DATA_EXTEND | CLOSE` all set on one
record, not just one bit. This step must collapse that bitmask into exactly
one of `JournalEvent`'s `reason` strings (Task 4 Step 4 below) using a fixed
priority order, **structural bits before data bits**, since a structural
change carries information a data-only event can't (name, parent, existence)
and must never be shadowed by a co-occurring data bit:

```
if reason & USN_REASON_FILE_DELETE != 0        -> "delete"
else if reason & USN_REASON_FILE_CREATE != 0   -> "create"
else if reason & (RENAME_NEW_NAME) != 0         -> "rename"
else if reason & USN_REASON_DATA_EXTEND != 0    -> "data-extend"
else if reason & USN_REASON_DATA_OVERWRITE != 0 -> "data-overwrite"
else if reason & USN_REASON_DATA_TRUNCATION != 0 -> "data-truncation"
else                                             -> "basic-info-change"
```

(`RENAME_OLD_NAME`-only records, with no `RENAME_NEW_NAME` bit, carry no new
name/parent and should be skipped rather than classified as `"rename"` — the
crate's own `Journal::match_rename` history buffer exists for correlating
these; that correlation is out of scope for a first cut of this task and can
be a follow-up if it proves necessary.)

- [ ] **Step 2: Write the failing tests for event application (TS, pure)**

Create `tests/ntfsMftJournalApply.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyJournalEvents } from '../src/services/ntfsMftJournalApply';
import { IndexRecord } from '../src/services/ntfsMftIndexStore';

function baseRecords(): IndexRecord[] {
  return [
    { recordNo: 100, parentRecordNo: 5, name: 'fx', size: 0, isDir: true, mtimeMs: 0 },
    { recordNo: 101, parentRecordNo: 100, name: 'old-name.txt', size: 5, isDir: false, mtimeMs: 0 },
  ];
}

test('a rename event updates name and parent in place, not delete+create', () => {
  const records = applyJournalEvents(baseRecords(), [
    { recordNo: 101, parentRecordNo: 100, name: 'new-name.txt', reason: 'rename', isDir: false, size: 5, mtimeMs: 1 },
  ]);
  const renamed = records.find((r) => r.recordNo === 101)!;
  assert.equal(renamed.name, 'new-name.txt');
  assert.equal(records.length, 2, 'rename must not add a new record');
});

test('delete then a later create with the SAME recordNo is a new file, not corruption', () => {
  let records = applyJournalEvents(baseRecords(), [
    { recordNo: 101, reason: 'delete' },
  ]);
  assert.equal(records.find((r) => r.recordNo === 101), undefined);

  records = applyJournalEvents(records, [
    { recordNo: 101, parentRecordNo: 100, name: 'reused-slot.bin', reason: 'create', isDir: false, size: 9, mtimeMs: 2 },
  ]);
  const reused = records.find((r) => r.recordNo === 101)!;
  assert.equal(reused.name, 'reused-slot.bin', 'a create on a reused FRN is a normal new file');
});

test('an unrelated data-change event updates size/mtime without touching name/parent', () => {
  const records = applyJournalEvents(baseRecords(), [
    { recordNo: 101, reason: 'data-extend', size: 999, mtimeMs: 3 },
  ]);
  const updated = records.find((r) => r.recordNo === 101)!;
  assert.equal(updated.size, 999);
  assert.equal(updated.name, 'old-name.txt', 'name must survive a data-only event');
});

test('a data-only event for an unknown recordNo throws JournalApplyGapError, never a silent no-op', () => {
  // Real cause: the Rust side picked a data bit over a co-occurring CREATE
  // bit when classifying a combined Reason (should not happen per Task 4
  // Step 1's priority order, but must be treated as a detected gap, not
  // silently swallowed, if it ever does) — surfaces as "must full-reindex",
  // matching the invalidation philosophy in ntfsMftInvalidation.ts.
  assert.throws(
    () => applyJournalEvents(baseRecords(), [
      { recordNo: 9999, reason: 'data-extend', size: 1, mtimeMs: 1 },
    ]),
    /JournalApplyGapError/,
  );
});

test('a create/rename event with no existing record and no parent/name throws rather than defaulting silently', () => {
  // The wire contract from Rust always includes parentRecordNo/name on
  // create/rename events — a missing field here means something upstream is
  // broken, and defaulting to parent 0 ($MFT itself) would silently orphan
  // the file from the visible tree instead of surfacing the bug.
  assert.throws(
    () => applyJournalEvents(baseRecords(), [
      { recordNo: 202, reason: 'create' },
    ]),
    /JournalApplyGapError/,
  );
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx tsx --test tests/ntfsMftJournalApply.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement**

Create `src/services/ntfsMftJournalApply.ts`:

```ts
import { IndexRecord } from './ntfsMftIndexStore';

export interface JournalEvent {
  recordNo: number;
  parentRecordNo?: number;
  name?: string;
  isDir?: boolean;
  size?: number;
  mtimeMs?: number;
  reason: 'create' | 'rename' | 'delete' | 'data-extend' | 'data-overwrite' | 'data-truncation' | 'basic-info-change';
}

/**
 * Thrown when a journal event can't be applied safely — an unknown recordNo
 * on a non-structural event, or a create/rename missing required fields with
 * nothing existing to fall back to. Both mean something is inconsistent
 * between the persisted index and the journal stream; per
 * docs/superpowers/specs/2026-07-24-ntfs-mft-turbo-v2-design.md §6's own
 * philosophy ("silently resuming would miss changes rather than error
 * loudly, so it isn't attempted"), the caller catches this and falls back to
 * a full reindex — never silently drops or misparents a file.
 */
export class JournalApplyGapError extends Error {
  constructor(message: string) {
    super(`JournalApplyGapError: ${message}`);
    this.name = 'JournalApplyGapError';
  }
}

/**
 * Applies USN journal events to an existing FRN-indexed record set, per
 * spec §6: rename updates name/parent in place, delete removes, and a later
 * create on the SAME recordNo is a normal new file (NTFS reuses MFT
 * records) — never treated as corruption. Non-structural events (data-extend
 * etc.) only touch the fields the event actually reports.
 */
export function applyJournalEvents(
  records: IndexRecord[],
  events: JournalEvent[],
): IndexRecord[] {
  const byRecordNo = new Map(records.map((r) => [r.recordNo, { ...r }]));

  for (const event of events) {
    if (event.reason === 'delete') {
      byRecordNo.delete(event.recordNo);
      continue;
    }

    const existing = byRecordNo.get(event.recordNo);
    if (event.reason === 'create' || event.reason === 'rename') {
      const parentRecordNo = event.parentRecordNo ?? existing?.parentRecordNo;
      const name = event.name ?? existing?.name;
      if (parentRecordNo === undefined || name === undefined) {
        throw new JournalApplyGapError(
          `${event.reason} event for record ${event.recordNo} has no parent/name and no existing record to fall back to`,
        );
      }
      byRecordNo.set(event.recordNo, {
        recordNo: event.recordNo,
        parentRecordNo,
        name,
        isDir: event.isDir ?? existing?.isDir ?? false,
        size: event.size ?? existing?.size ?? 0,
        mtimeMs: event.mtimeMs ?? existing?.mtimeMs ?? 0,
      });
      continue;
    }

    // Non-structural: only touch fields the event actually carries. An
    // unknown recordNo here means the journal stream and the persisted
    // index have drifted (e.g. a combined-Reason record misclassified
    // upstream) — surface it rather than silently doing nothing.
    if (!existing) {
      throw new JournalApplyGapError(
        `${event.reason} event for unknown record ${event.recordNo} — index and journal have drifted`,
      );
    }
    byRecordNo.set(event.recordNo, {
      ...existing,
      size: event.size ?? existing.size,
      mtimeMs: event.mtimeMs ?? existing.mtimeMs,
    });
  }

  return Array.from(byRecordNo.values());
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx tsx --test tests/ntfsMftJournalApply.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add native/ntfs-mft-scan/src/main.rs src/services/ntfsMftJournalApply.ts tests/ntfsMftJournalApply.test.ts
git commit -m "feat(scan): add --usn-read mode and journal event application, TDD"
```

---

## Task 5 (SPIKE — validate before building further): elevation persistence

**This is not a conventional implementation task.** Its job is to find out
whether the mechanism the spec recommends actually works the way the spec
claims, on a real machine, before any production code depends on it.

- [ ] Register a test Scheduled Task manually (not via the app yet):
      `schtasks /create /tn "TreeMapNtfsMftTest" /tr "<path to a trivial
      elevated test exe>" /sc onlogon /rl highest /f` from an elevated
      prompt.
- [ ] Confirm it actually runs elevated **without a UAC prompt** when
      triggered via `schtasks /run /tn "TreeMapNtfsMftTest"` from a
      *non-elevated* shell — this is the whole premise §5 rests on.
- [ ] Confirm the same is true after a real logoff/logon cycle (not just
      within the current session) and, if practical, after a reboot.
- [ ] Prototype a minimal named-pipe or localhost-socket IPC round-trip
      between a non-elevated Node process and the scheduled-task process —
      confirm it works without its own elevation friction.
- [ ] **Decision gate:** if all of the above holds, proceed to Task 6. If
      any of it doesn't hold (e.g. UAC still fires in some path, or the
      logon-trigger process doesn't stay alive reliably), **stop here** and
      bring the specific failure back for a design discussion — don't
      silently substitute a different mechanism without updating the spec's
      §5 first, since the whole warm-path ROI story depends on which
      mechanism actually works.
- [ ] Clean up the test task: `schtasks /delete /tn "TreeMapNtfsMftTest" /f`

---

## Task 6: Register the real Scheduled Task at install time

**Gated on Task 5 passing.** Depends on what Task 5 actually confirms about
invocation path — do not write this from the spec's description alone
without Task 5's empirical result in hand.

**Files:**
- Modify: `package.json` (NSIS installer config — likely an `nsis-web`/custom
  install script hook; check what electron-builder's NSIS customization
  points actually support before assuming a specific mechanism)

- [ ] Register the Scheduled Task during NSIS install (the specific
      electron-builder hook — `include`/custom `.nsh` script — depends on
      what electron-builder's NSIS target supports; check its docs during
      implementation rather than assuming a specific API here)
- [ ] Unregister it during uninstall — a leftover elevated Scheduled Task
      after uninstall is a real, avoidable security smell
- [ ] Manual test: full install → confirm task exists and runs per Task 5's
      confirmed invocation path → full uninstall → confirm task is gone

---

## Task 7: Standing process + IPC wiring

**Gated on Task 6.** The scheduled-task process holds the elevated
volume/journal access; the main (unprivileged) app process talks to it.

- [ ] Define the IPC protocol (request: volume + last-known checkpoint;
      response: refresh strategy from Task 3's logic, or streamed journal
      events from Task 4's format)
- [ ] Wire `ntfsMftScanIntoStore` (or a new warm-path sibling function) to
      use this IPC channel instead of `runElevatedViaUac` when a fresh
      per-scan elevation isn't needed
- [ ] Fallback tests (Task 9) must cover this channel being unreachable

---

## Task 8: UI — index freshness + manual rebuild

**Files:**
- Modify: `public/index.html`

- [ ] Show when a scan answered from the persisted index vs. did a fresh
      MFT read (mirrors the existing engine-label pattern —
      `'ntfs-mft'`/`'gdu-turbo'`/`'walker'` labels already shown today)
- [ ] Add a "Rebuild index" action — cheap to add, and means a user is never
      stuck with a silently-stale index and no way out (spec §7's explicit
      minimum bar for this PR)

---

## Task 9: Fallback tests

**Files:**
- Modify: `tests/ntfsMftScanner.test.ts` (or a new
  `tests/ntfsMftWarmPath.test.ts`, whichever keeps the file focused —
  check the existing file's size before deciding)

- [ ] Scheduled task not registered → per-scan elevation path, not a scan
      error
- [ ] Scheduled task registered but unreachable (IPC connection refused) →
      same fallback, not a silent hang
- [ ] Corrupted/unreadable persisted index file → treated as "no checkpoint"
      (full reindex), not a crash
- [ ] `JournalApplyGapError` from Task 4's `applyJournalEvents` (index and
      journal stream drifted) → caught and treated as a full-reindex trigger,
      same as the invalidation-logic reasons in Task 3 — not a scan error
- [ ] Every fallback path logs why, matching the discipline every other
      engine fallback in this codebase already has

---

## Task 10: Manual end-to-end verification (real machine)

- [ ] Fresh volume, no prior index: confirm cold path builds one and saves
      a checkpoint
- [ ] Immediate second scan, no changes made: confirm it lands in the ≤2–3s
      target and used the incremental/no-op path, not a full reindex
- [ ] Make a real change (create/rename/delete a file) between two scans:
      confirm the second scan's totals reflect it correctly
- [ ] Restart the app: confirm the index survives and the next scan is
      still warm
- [ ] Reboot the machine: confirm the Scheduled Task's logon trigger fires
      and the next scan is still warm without a fresh UAC prompt
- [ ] Force a journal reset (`fsutil usn deletejournal /n C:` from an
      elevated prompt): confirm the next scan detects the journal-ID
      mismatch and does a full reindex rather than silently missing changes
