# NTFS MFT turbo engine (`ntfs-mft`)

**Date:** 2026-07-24
**Status:** Design — awaiting spec review
**Goal:** Wire up the already-reserved `'ntfs-mft'` engine so that Windows scans of
an NTFS volume read the Master File Table directly instead of walking directories
— WizTree-class scan speed, MIT-clean implementation, same optional-engine-with-
fallback shape as `gdu-turbo`.

---

## 1. Where this came from

`src/models/types.ts` already declares:

```ts
engine?: 'walker' | 'turbo-walker' | 'gdu-turbo' | 'ntfs-mft' | 'cloud';
```

`'ntfs-mft'` has been a reserved-but-unimplemented value since the gdu-turbo work
(`2026-07-16-turbo-scan-5m-design.md` explicitly calls it "out of scope, as the
prompt states"). The engine label already exists in `public/index.html`
(`'ntfs-mft': 'NTFS MFT reader'`). This spec implements that slot.

**Baseline check (2026-07-24):** `npm run build` is clean; `npm test` is 190
pass / 3 fail / 5 skipped. The 3 failures (`apiHardening` boundary test,
`appAttribution` Windows-path test, an API byte-identical baseline drift test) are
pre-existing on `main`, unrelated to scanning engines, and untouched by this work
— noted here so they aren't mistakenly attributed to this PR.

---

## 2. Why not a native Node addon

The obvious-looking approach — a napi-rs N-API addon called in-process — is
wrong for this codebase and is **not** what this spec builds, despite being the
first idea floated for this project. Reasoning:

- The MFT reader requires an elevated process token (confirmed by the chosen
  crate's own runtime check, see §4). A native addon means the *whole Electron
  process* would need to run elevated to call it — every launch, whether or not
  the user ever touches this engine. That is a worse launch experience than the
  app has today.
- Avoiding that means routing the addon call through a separate elevated helper
  process anyway — at which point the addon added only build complexity (Rust
  toolchain, node-gyp-equivalent ABI/N-API version pinning, per-Node-version
  prebuilds) that this repo has nowhere else, for no benefit over calling a plain
  helper binary.
- `gduScanner.ts` already proves the alternative shape works to spec: spawn a
  separate binary, hand off via a temp file, parse, map into the store. That
  pattern is reused here unchanged.

**Decision:** a standalone Rust CLI binary, spawned like `gdu`, not a Node addon.

---

## 3. Architecture

### 3.1 `native/ntfs-mft-scan/` — new Rust binary crate

CLI shape: `ntfs-mft-scan.exe --volume C: --out <tmpfile>`.

Depends directly on the `ntfs-reader` crate (crates.io, MIT OR Apache-2.0,
single maintainer, ~28k downloads, last published 2026-03-28, small dependency
footprint: `thiserror`, `binread`, `time`, `tracing`, `windows`). **Decision:**
depend on it directly rather than vendoring or reimplementing — it already does
exactly this (opens the volume, reads the boot sector to locate the MFT, reads
the `$MFT`'s raw `Data`/`Bitmap` attributes, applies per-record fixups, exposes
`mft.files()`), it's tested and benchmarked, and re-deriving the same raw-MFT
parse logic ourselves would just be reinventing what a small, permissively
licensed crate already gets right. (Note for the record: this is the same
technique WizTree itself uses internally, per the RTTI recovered from
`WizTree64.exe` — `TDATA_RUN`, `TMFT_RECORD` — but `ntfs-reader` is an independent
clean-room implementation built from public NTFS on-disk documentation, not
derived from WizTree in any way. Nothing from the WizTree binary is reused.)

Output: a flat JSON array of `{recordNo, parentRecordNo, name, size, isDir,
mtimeMs, attrs}` — **record-id/parent-id links, not resolved path strings.**
This deliberately skips the crate's own path-resolution convenience API in
favor of raw record + parent-FRN fields, because the mapper lesson from
`2026-07-16-turbo-scan-5m-design.md` (787ms → 39ms, a 20× win) was specifically
about avoiding `path.join`/string work in the hot mapping path. The TS side
links children to parents by integer id, exactly the way the MFT already
represents parent-child relationships — no string splitting anywhere.

### 3.2 `src/services/ntfsMftScanner.ts`

Mirrors `gduScanner.ts`'s shape directly:

- `findNtfsMftBinary()` — bundled path (`extraResources`) → dev-relative path,
  same two-candidate lookup as `findGduBinary`.
- `runNtfsMftScan()` — `execFile` with an argv array (never `exec`/`shell:true`),
  same size-guard-before-`JSON.parse` pattern as the gdu shard guard.
- `ntfsMftScanIntoStore()` — builds directly into a `PackedScanStore`, same as
  `gduScanIntoStore`. A folder-level scan doesn't need a narrower native query:
  the MFT read is volume-wide by nature, so a "scan this folder" request builds
  the same store and then `store.prune()`s to the requested root, identical to
  how `gduScanIntoStore` already prunes to `scan.rootPath`.

### 3.3 Elevation

The helper binary requires an elevated process token — this is enforced by
`ntfs-reader`'s own `Volume::new()`, which checks `TokenElevation` via
`GetTokenInformation` and returns `NtfsReaderError::ElevationError` if the
calling process isn't elevated. There is no way around this; it isn't a
permissions setting we can loosen.

**Decision: on-demand elevation, not whole-app.** The main Electron process
never runs elevated. Only when the `ntfs-mft` engine is selected (or
auto-selected) does `ntfsMftScanner.ts` spawn the helper through **`sudo-prompt`**
(small, widely-used MIT package — used by VS Code and other Electron apps for
exactly this — wraps the Windows UAC `runas` verb). This was chosen over
hand-rolling a `powershell -Command Start-Process ... -Verb RunAs` invocation:
same result, but without owning PowerShell argument-quoting correctness
ourselves. One UAC prompt per scan session; the elevated helper writes its
result to the same temp-file-JSON channel gdu uses, so the unprivileged parent
process never needs elevated access to anything.

### 3.4 Gating and fallback

Exactly the same contract as `gdu-turbo`, non-negotiable:

- `process.platform === 'win32'`
- Target volume's filesystem is NTFS (checked via existing
  `GetVolumeInformationW`-based detection, same call the walker already uses to
  decide certain behaviors)
- Helper binary is present (bundled or dev-relative)
- User consents to the UAC prompt

**Any** failure at any point — binary missing, non-NTFS volume, non-Windows,
UAC declined, malformed output, size-guard trip — falls back to `walk()`
silently, exactly like every gdu failure mode today. Never surfaced as a scan
error to the user.

### 3.5 Build and bundling

`scripts/buildNtfsMftScan.js`, modeled on `fetchGdu.js` but **building** rather
than fetching (there's no upstream release to download): `cargo build --release
--target x86_64-pc-windows-msvc`, staged into `build/ntfs-mft-scan/win-x64/`,
wired into `electron-builder`'s `extraResources` under `win`, same shape as the
existing `gdu` entry. Windows-only, so a one-target build, not gdu's 5-platform
fetch matrix. A missing Rust toolchain in a dev/CI environment must be
non-fatal — same "continue without it, fall back to the walker" behavior
`fetchGdu.js` already has for network failures.

---

## 4. Scope

**In scope for this PR:**
- One-shot full-volume MFT read via the CLI helper
- On-demand elevation via `sudo-prompt`
- Fallback to `walk()` on any failure
- `engine: 'ntfs-mft'` tagging on `ScanResult` (label already exists)

**Explicitly out of scope (follow-up work):**
- The `ntfs-reader` crate's `Journal` API for incremental re-scan. This would be
  a genuinely useful future feed into `watcher.ts` (avoiding a full MFT re-read
  on every change), but it's a second feature with its own design questions
  (journal lifecycle, USN low/high watermarks, restart-from-checkpoint), not
  part of making the reserved engine slot work for the first time.
- ReFS support — `ntfs-reader` doesn't support it (no MFT on ReFS); ReFS volumes
  fall back to the walker like any non-NTFS volume.

---

## 5. Testing

Same shape as the existing gdu-turbo test suite:

- **Mapper test** (`tests/ntfsMftMapper.test.ts`) against a recorded fixture of
  real `ntfs-mft-scan` output — pure function, no elevated subprocess needed in
  CI (CI cannot answer a UAC prompt regardless).
- **Fallback-path tests**: binary missing, non-NTFS volume, non-`win32`
  platform, UAC declined/failed — each must fall back to `walk()` without
  surfacing an error.
- **Manual/opt-in parity test** on a real elevated Windows machine: `ntfs-mft`
  vs `walker` totals on the same real tree must match exactly, the same
  byte-for-byte gate the gdu hardlink-dedup parity test already enforces.

---

## 6. Risks

- **Third-party crate risk.** `ntfs-reader` has a single maintainer. Mitigated
  by it being a thin, auditable dependency (not a build-critical core of the
  app) with a permissive dual license; a future fork/vendor is always possible
  if it goes unmaintained, without touching anything on the TS side.
- **UAC fatigue.** A prompt on every scan session using this engine could
  annoy users who scan repeatedly. Out of scope to solve here (e.g. a
  "remember for this session" cache is a follow-up), but worth watching once
  this ships.
- **Antivirus/EDR flags.** Direct volume access + `sudo-prompt` elevation is
  the same shape real malware sometimes uses. Code-signing the helper binary
  (already planned for the app itself, per `afterPack.js`'s macOS signing)
  reduces false-positive risk; worth confirming Windows signing coverage
  extends to `ntfs-mft-scan.exe` when this ships.
