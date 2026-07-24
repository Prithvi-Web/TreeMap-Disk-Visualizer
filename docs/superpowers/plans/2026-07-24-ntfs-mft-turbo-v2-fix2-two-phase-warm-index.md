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
fn query_usn_journal_info(volume_path: &str) -> std::io::Result<UsnJournalInfo> {
    use windows::core::PCSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{CreateFileA, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_SHARE_DELETE, OPEN_EXISTING, FILE_FLAG_OVERLAPPED};
    use windows::Win32::System::Ioctl::{FSCTL_QUERY_USN_JOURNAL, USN_JOURNAL_DATA_V2};
    use windows::Win32::System::IO::DeviceIoControl;
    use std::ffi::CString;
    use std::mem::size_of;

    let path = CString::new(volume_path).unwrap();
    let handle: HANDLE = unsafe {
        CreateFileA(
            PCSTR::from_raw(path.as_bytes_with_nul().as_ptr()),
            FILE_GENERIC_READ.0,
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
            Some(&mut journal as *mut _ as *mut _),
            size_of::<USN_JOURNAL_DATA_V2>() as u32,
            Some(&mut bytes_returned),
            None,
        )
    }.map_err(|e| std::io::Error::other(e.to_string()))?;

    // TODO(implementer): also fetch VolumeSerialNumber via
    // GetVolumeInformationByHandleW or FSCTL_GET_NTFS_VOLUME_DATA — not
    // shown here in full; check ntfs_reader::volume::Volume for whether it
    // already surfaces this (its BootSector parse may have it) before
    // adding a second Windows API call for something already available.

    Ok(UsnJournalInfo {
        usn_journal_id: journal.UsnJournalID,
        first_usn: journal.FirstUsn,
        next_usn: journal.NextUsn,
    })
}
```

**Verify while implementing:** the exact `windows` crate 0.62 type names/field
casing for `USN_JOURNAL_DATA_V2` and the `DeviceIoControl` signature — the
`windows` crate's generated bindings occasionally shift field/parameter
shapes between minor versions; the code above is written against the pattern
already confirmed working in `ntfs-reader`'s own `journal.rs` (read in full
during spec research), but confirm it compiles against whatever version Step
1 actually resolves before treating this as final.

**Check before adding a second API call:** whether `Volume` (from
`ntfs_reader::volume`) already exposes a volume serial number from its own
boot-sector parse — if so, reuse it instead of a second
`GetVolumeInformationByHandleW`/`FSCTL_GET_NTFS_VOLUME_DATA` call.

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

/**
 * On-disk shape: one JSON line for the checkpoint, then one JSON line per
 * record (NDJSON, same wire-format discipline as the cold-scan helper — no
 * single-string-size ceiling regardless of volume size). A real fixed-size
 * binary format is a reasonable future optimization; NDJSON is the simplest
 * thing that satisfies the invalidation logic's needs today, and the
 * checkpoint fields are what invalidation actually reads — the exact record
 * encoding underneath can change later behind formatVersion without touching
 * callers.
 */
export async function saveIndex(
  filePath: string,
  checkpoint: IndexCheckpoint,
  records: IndexRecord[],
): Promise<void> {
  const lines = [
    JSON.stringify({
      ...checkpoint,
      usnJournalId: checkpoint.usnJournalId.toString(),
      lastUsnProcessed: checkpoint.lastUsnProcessed.toString(),
    }),
    ...records.map((r) => JSON.stringify(r)),
  ];
  await fsp.writeFile(filePath, lines.join('\n') + '\n', 'utf8');
}

export async function loadIndex(
  filePath: string,
): Promise<{ checkpoint: IndexCheckpoint; records: IndexRecord[] }> {
  const text = await fsp.readFile(filePath, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  const [checkpointLine, ...recordLines] = lines;
  const raw = JSON.parse(checkpointLine);
  if (raw.formatVersion !== INDEX_FORMAT_VERSION) {
    throw new Error(
      `ntfs-mft index format version mismatch: file has ${raw.formatVersion}, expected ${INDEX_FORMAT_VERSION}`,
    );
  }
  const checkpoint: IndexCheckpoint = {
    volumeSerialNumber: raw.volumeSerialNumber,
    usnJournalId: BigInt(raw.usnJournalId),
    lastUsnProcessed: BigInt(raw.lastUsnProcessed),
    formatVersion: raw.formatVersion,
  };
  const records: IndexRecord[] = recordLines.map((l) => JSON.parse(l));
  return { checkpoint, records };
}
```

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
 * Applies USN journal events to an existing FRN-indexed record set, per
 * docs/superpowers/specs/2026-07-24-ntfs-mft-turbo-v2-design.md §6:
 * rename updates name/parent in place, delete removes, and a later create on
 * the SAME recordNo is a normal new file (NTFS reuses MFT records) — never
 * treated as corruption. Non-structural events (data-extend etc.) only
 * touch the fields the event actually reports.
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
      byRecordNo.set(event.recordNo, {
        recordNo: event.recordNo,
        parentRecordNo: event.parentRecordNo ?? existing?.parentRecordNo ?? 0,
        name: event.name ?? existing?.name ?? '',
        isDir: event.isDir ?? existing?.isDir ?? false,
        size: event.size ?? existing?.size ?? 0,
        mtimeMs: event.mtimeMs ?? existing?.mtimeMs ?? 0,
      });
      continue;
    }

    // Non-structural: only touch fields the event actually carries.
    if (existing) {
      byRecordNo.set(event.recordNo, {
        ...existing,
        size: event.size ?? existing.size,
        mtimeMs: event.mtimeMs ?? existing.mtimeMs,
      });
    }
  }

  return Array.from(byRecordNo.values());
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx tsx --test tests/ntfsMftJournalApply.test.ts`
Expected: PASS — all 3 tests green.

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
