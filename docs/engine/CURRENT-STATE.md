# The scan engine as it is today (Phase 0 record)

**Recorded:** 18 September 2026, against commit `716beb6` (v5.0.1, the current
`main`), before a line of the new engine exists.
**Machine:** Apple M3 (4 performance + 4 efficiency cores), 16 GB, APFS NVMe,
macOS 27.0, Node v24.16.0 locally (CI runs Node 20), Rust 1.97.0. By the
master prompt's Section 5.1 this is a **Tier B** machine: no Pro/Max chip, no
32 GB.
**Method:** every claim below was read from the source at the cited line or
measured here. Four read-only explorers mapped the walker and store, the gdu
engine and packaging, the duplicate pipelines, and the API surface; the
load-bearing claims were then re-read by hand. Where this document says
"measured", the number was produced by a command run today; where it quotes a
number from a code comment, it says so.

The master prompt (`TREEMAP-FAST-SCANNER-MASTER-PROMPT.md`, v3) describes
the current implementation from the README. Section 15 below lists where
that description turned out to be wrong or stale. Everything downstream
(`DESIGN.md`, `RISKS.md`, the phase plan) builds on this file.

---

## 1. Stack and runtime

| Item | Fact | Where |
| --- | --- | --- |
| Backend | TypeScript, `strict`, CommonJS, target ES2022 | `tsconfig.json` |
| Server | Express 5, bound to `127.0.0.1:4280` in web mode; in Electron it is started **in-process** on port 0 with a per-launch token | `src/index.ts:10-11`, `electron/main.js:234-236` |
| Desktop shell | Electron 31, electron-builder 24; macOS `dmg`+`zip`, Windows `nsis`+`portable`, Linux `AppImage` (built locally only, never released) | `package.json` `build`, `.github/workflows/release.yml:35-38` |
| Frontend | One generated file, `public/index.html` (~35,000 lines), concatenated from **113 parts** under `src/ui/` in `src/ui/manifest.json` order by `scripts/build-ui.js`. Byte identity is asserted by `tests/buildUi.test.ts`; external scripts, styles, fonts, frameworks and chart libraries are forbidden by `tests/frontendContract.test.ts:404-431` | `src/ui/README.md` |
| Native dependencies already shipped | `sharp` (prebuilt per platform through `optionalDependencies`, unpacked from the asar) and `better-sqlite3` (`prebuild-install`, falls back to `node-gyp`). The repo's own policy for OS mechanisms is: an npm package first, then "a small N-API addon, prebuilt in CI — never compiled on a user's machine", then a bundled binary; and it records that TreeMap ships **no native addon of its own** | `package.json`, `docs/PLATFORM_NOTES.md:12-20` |
| Bundled binary | `gdu` v5.36.1 (Go), fetched at packaging time with SHA-256 verification against the release's checksum file, shipped as an `extraResource` per `${os}-${arch}`, MIT licence vendored beside it | `scripts/fetchGdu.js:26-63`, `package.json` `extraResources` |
| Tests | `node:test` through `tsx`, run by `scripts/run-tests.js` (shell-independent glob). 174 files in `tests/`. The suite at this commit: see Section 13 | `scripts/run-tests.js` |
| CI | `test.yml`: macOS, Windows, Linux, and a Linux leg under `pt_BR.UTF-8`; Node 20; typecheck, suite (TAP), per-failure annotations, `npm run capabilities:report` as a record. `release.yml`: macOS (host arm64) and Windows x64 installers on a `v*` tag; no Rust, no compiler step anywhere | `.github/workflows/test.yml`, `release.yml:106-141` |
| App-data directory | `TREEMAP_DATA_DIR` if set, else `~/Library/Application Support/TreeMap` on macOS, `%APPDATA%/TreeMap`, `$XDG_CONFIG_HOME|~/.config/treemap` | `src/services/storage.ts:26-35` |

## 2. Engines that exist today

`ScanResult.engine` is typed `'walker' | 'turbo-walker' | 'gdu-turbo' | 'ntfs-mft' | 'cloud'` (`src/models/types.ts:120`). Only three of the five are ever assigned:

| Engine | What it is | Assigned at |
| --- | --- | --- |
| `gdu-turbo` | The **default fast path**: the bundled `gdu` binary, one subprocess per top-level directory, output parsed from a JSON file | `src/services/diskScanner.ts:441` |
| `turbo-walker` / `walker` | The pure-Node walker; the name is `turbo-walker` when the libuv pool was sized above 4 threads, `walker` otherwise. Same code either way | `diskScanner.ts:401`, `:490` |
| `cloud` | Provider-API scans (Google Drive, Dropbox, OneDrive) — not a filesystem engine | `src/services/cloud/cloudScan.ts:22` |
| `ntfs-mft` | **Never assigned.** Exists only in the type, in a UI label map, and in the July design that ruled it out of scope | `src/ui/app/045-persistent-live-index.js:641`, `docs/superpowers/specs/2026-07-16-turbo-scan-5m-design.md:214` |

### 2.1 Selection logic (`diskScanner.ts:428-441`; the conditions as in the source, the reasons from the block comment above them)

```ts
const gduEligible =
  rootStat.isDirectory() &&
  !cache &&                 // reason: no usable mtime cache for this root
  !opts.incremental &&
  ignore.length === 0 &&    // reason: gdu's -i/-I cannot express the app's ignore globs
  process.env.TREEMAP_NO_GDU !== '1';
// ...
if (gduEligible) {
  const bin = await findGduBinary();   // bundled → dev path → $PATH; null if none
  if (bin) { scan.engine = 'gdu-turbo'; const store = await gduScanIntoStore(scan, bin, cloudProviderFor); ... }
}
```

Anything gdu throws (missing binary, non-zero exit, a shard over 450 MB, a
5-minute shard timeout) is caught at `:461-489`, logged as `gdu engine
unavailable, using walker`, every counter is zeroed, and the Node walker runs
the whole scan again from the start. Cancellation and a vanished root are the
two exceptions that stop the scan instead. There is no capability probe, no
user-facing reason, and no "which engine and why" field beyond the `engine`
string itself.

### 2.2 Threads

`src/utils/ioThreads.ts:18-24` sets `UV_THREADPOOL_SIZE` to `min(16, max(8,
cpus × 2))` before libuv's pool exists (16 on this machine); `electron/main.js:29-34`
does the same for the desktop. The comment records the measurement the master
prompt cites: 16 threads scan about 1.6× faster than 4 on APFS and 32 is
slower than 4. The walker's own concurrency is fixed at module load:
`CONCURRENCY = min(32, max(8, IO_THREADS))` (so 16 here) and `STAT_BATCH = IO_THREADS > 4 ? 64 : 32`
(so 64 here; `diskScanner.ts:40-41`). There is **no adaptive concurrency anywhere**.

## 3. The Node walker (`src/services/diskScanner.ts`)

### 3.1 Signatures

```ts
export interface ScanOptions { incremental?: boolean }                                   // :352-355
export async function startScan(rootPath: string, opts: ScanOptions = {}): Promise<ScanResult>   // :357
export function createScanRecord(rootPath: string): ScanResult                             // :329
export function getScan(scanId: string): ScanResult | undefined                            // :222
export function peekScan(scanId: string): ScanResult | undefined                           // :232
export function allScans(): ScanResult[]                                                   // :236
export function cancelScan(scanId: string): boolean                                        // :287
export function cancelAllScans(): void                                                     // :249
export function scanExpired(scan: ScanResult, now: number): boolean                        // :170
export function scanExpiresAt(scan: ScanResult): number | null                             // :176
export function onScanForgotten(fn: (scanId: string) => void): void                        // :190
export function mtimesMatch(cachedMs: number, freshMs: number): boolean                    // :533
export function collectLargestFiles(source: TreeSource, limit: number, minSize: number)    // :881
export function collectLargestFolders(source: TreeSource, limit: number, minSize: number): LargeFolder[]   // :907
export function collectEmptyFolders(source: TreeSource, ignoreJunk: boolean): EmptyFoldersResult           // :982
export function compareTrees(sourceA: TreeSource, sourceB: TreeSource): { entries: CompareEntry[]; truncated: boolean }  // :1070
export function collectFileTypes(source: TreeSource)                                       // :1120
export const SCAN_TTL_MS = 30 * 60 * 1000;                                                 // :142
```

`TreeSource = FileNode | ScanStore` (`src/services/scanStore.ts:1397`): every
consumer accepts either a legacy object tree or a store.

### 3.2 The walk

1. Preflight: `fsp.lstat(rootPath)`, then for a directory `(await fsp.opendir(rootPath)).close()` — an `lstat` alone passes for a folder macOS TCC has blocked, so opening is the honest test (`:361-366`).
2. `walk()` (`:624`): `lstat` the root, create `new PackedScanStore(rootPath, path.sep, …)`, drain a FIFO queue of directories with up to `CONCURRENCY` in flight (`drainQueue`, `:664-688`), re-check the root still exists, `finalize()` and `sumSizes()`.
3. Per directory (`processDirectory`, `:696`): one `fsp.readdir(p, { withFileTypes: true })` under a 30 s deadline (`READDIR_DEADLINE_MS`, `:59`), ignore-pattern filtering, then entries in batches of `STAT_BATCH` through `Promise.allSettled`, **one `fsp.lstat` per entry** (`:778`, `:783`). No `stat`, `fstat` or `readlink`. Subdirectories are pushed onto the shared queue. Every 2,000 entries the worker yields with `setImmediate` so SSE stays responsive (`:871-875`).
4. Every async `readdir`/`lstat` is a libuv threadpool job. The prompt's diagnosis — one syscall plus a pool hop plus a JS callback plus an allocated object per entry — is exactly what the code does.

### 3.3 What the walker does with each condition

| Condition | Behaviour | Where |
| --- | --- | --- |
| Symbolic links | Never followed; recorded as a leaf with `isSymlink`; excluded from the sparse check because a link's size against zero blocks looks like a fully sparse file | `:777`, `:785-791` |
| Hard links | Keyed on `dev:ino` only when `nlink > 1`; the second name seen gets `size = 0` and `hardlinkedFiles/Bytes` are tallied; the dedup runs sequentially so parallel batches cannot race the set | `:815`, `:830-839` |
| Sparse and slack | `allocDelta = blocks × 512 − size`, signed: negative → `sparseFiles/sparseBytes`, positive → `slackBytes`; gated on `platform().blocksAreMeaningful`, which is false on Windows | `:812-813`, `:849-856` |
| Cloud placeholders | `size > 0 && blocks === 0` **and** the path matches an iCloud/OneDrive/Dropbox folder regex; the file gets `cloudPlaceholder` and a provider | `:795-801`, `src/services/cloudFolders.ts:15-20` |
| Mount points, firmlinks | A hard-coded never-descend list — darwin `/System/Volumes`, `/Volumes`, `/dev`, `/home`, `/net`, `/Network`; linux `/proc`, `/sys`, `/dev`, `/run`. **No device-id check**, on purpose: firmlinks put `/Users` on a different device than `/` | `:865`, `src/utils/mountBoundaries.ts:16-21` |
| Permission denied | Listed directory → `deniedDirs` and the five smallest paths as examples; an entry's `lstat` → `deniedEntries`. The scan continues | `:755`, `:824`, `src/services/scanRefusals.ts:13-30` |
| Vanished mid-walk | Directory → `vanishedDirs`; entry → skipped; only the **root** vanishing fails the scan | `:756`, `:825`, `:133-139` |
| NFC/NFD names | **No normalisation anywhere in `src/`**; names are stored as returned | `grep -a` (a stray byte makes `file(1)` classify `src/services/thumbnailCache.ts` as data, and plain `grep` skips it silently — every absence claim over `src/` in this document was re-run with `-a`) |
| Hidden | Dot-prefix only, on every platform | `:606` |
| Git repositories | A `.git` child sets `Flag.GitRepo` on the parent | `:857` |
| Containers | `.photoslibrary`, disk images, archives are tagged, never expanded here | `src/utils/containerKind.ts:12-25` |
| Deadline | Only the per-`readdir` 30 s; no whole-scan budget | `:59` |

### 3.4 Progress, cancellation, retention

* `scan.scanned` increments per accepted entry; `currentPath` is set once per directory listed (`:762`, `:859`). The SSE endpoint polls those fields every **150 ms** and sends a `progress` frame only when the count changed, a keep-alive comment after 10 s of silence, and one frame on connect (`src/api/scanRoutes.ts:234-255`).
* Cancellation is a cooperative flag checked per directory and between gdu shards; `abortGduScan` SIGKILLs the shard's child (`src/services/gduScanner.ts:133-139`).
* Results live in a `Map` for `SCAN_TTL_MS` (30 min) from the later of completion and last use, swept every 60 s; a scan still running after 6 h is cancelled (`:142-213`).
* On completion two files are written fire-and-forget through the `trackWrite` ledger: the **mtime cache** and a **snapshot** (`:652-657`).

### 3.5 The incremental ("fast rescan") cache

* File: `<appData>/mtime-cache-<sha1(rootPath)[0:16]>.json` — **the whole scan tree as a `FileNode` JSON**, written only when the scan has at most **300,000 nodes** (`MTIME_CACHE_MAX_NODES`, `:504`, `:576-597`). Above that, no cache is written and every rescan is a full scan.
* Key: the directory's **own mtime only** — no size, no inode, no device. A cached value is accepted at exact-millisecond equality or, because gdu records whole seconds, when the cached value equals the fresh one floored to the second (`mtimesMatch`, `:533-537`).
* Reuse rule: a directory whose mtime matches has its **direct listing** substituted from the cache, and each cached subdirectory is enqueued for its own revalidating `lstat`. Nothing is reused on an ancestor's mtime, because "a dir's mtime lives in its own inode and never propagates upward" (`:708-716`). The documented trade-off: in-place edits of a file (same name, new bytes) go unnoticed, which is why the mode is opt-in.
* Only the walker honours the cache; a scan with a cache is not gdu-eligible. Cloud and hard-link tallies are not re-derived from cached files (`:556-559`). A fast rescan therefore under-counts the allocation line (recorded as known gap 1 in `NEXT_SESSION_PROMPT.md`).

## 4. The gdu engine (`src/services/gduScanner.ts`, `src/services/gduMapper.ts`)

* Invocation: `execFile(bin, ['-n', '-x', '-o', outFile, ...(ignoreDirs ? ['-i', ignoreDirs.join(',')] : []), dir], { maxBuffer: 1 MiB, timeout, killSignal: 'SIGKILL' })` — argv array, never a shell (`:144-167`). `-x` keeps gdu on one filesystem; the `-i` branch exists in `runGdu` but is unreachable from a scan, because gdu is only eligible with an empty ignore list.
* Sharding: one subprocess per top-level directory of the root, each writing `shard-N.json` into a `treemap-gdu-` temp directory that is removed in `finally` (`:270`, `:335-386`). Files directly under the root are `lstat`ed by Node (`statLeaf`, `:198-256`).
* Guard: a shard over **450 MB** of JSON throws, which restarts the whole scan under the walker — the limit exists because the file is read whole and `JSON.parse`d (`:40`, `:357`); V8 caps a string near 512 MB. A shard that runs longer than **5 minutes** is killed the same way (`:50`).
* Mapper: gdu's document is `[1, 2, {header}, dirNode]` and a directory is the **flat** array `[meta, child1, child2, …]` (`gduMapper.ts:6-31`); `asize` is the logical size and is omitted when zero; `dsize` is disk usage; `mtime` is whole seconds; `notreg` marks non-regular files; `hlnkc` plus `ino` mark hard links, deduplicated on **inode alone because gdu emits no `dev`** (`:77-82`). Cloud placeholders are `size > 0 && !dsize` inside a known cloud folder. Directory sizes are summed by the store.
* What gdu cannot report: **refusals** (a mode-000 directory is emitted as an ordinary empty one and gdu exits 0 — measured, `src/services/missingGigabytes.ts:754-767`; hence `ENGINES_THAT_COUNT_REFUSALS = {walker, turbo-walker}`), **access times**, and **device ids**. Allocated bytes it does report.
* Binary lookup at runtime: `process.resourcesPath/gdu/gdu`, then `<repo>/gdu/gdu` for `electron .` in development, then `$PATH` (`:69-111`). A missing binary is an ordinary condition, never an error.

## 5. The store (`src/services/scanStore.ts`)

`ScanStore` (`:75-182`) is the interface every consumer reads. Two
implementations: `ObjectScanStore` wraps a legacy `FileNode` tree and is the
oracle the packed store is differentially fuzzed against (`:371-377`);
`PackedScanStore` (`:721-1389`) is the one every engine writes.

```ts
// PackedScanStore columns (:731-740)
parentArr: Int32Array; sizeArr: Float64Array; mtimeArr: Float64Array;
flagsArr: Uint16Array; extArr: Uint16Array; containerArr: Uint8Array; cloudProvArr: Uint8Array;
nameOff: Uint32Array /* cap+1 */; nameBytes: Uint8Array /* one UTF-8 pool, no dedup */;
// lazy side tables: atimeArr, logicalMap, cloudIdMap, extOverflow
```

* Paths are **never stored**; they are rebuilt by walking `parent` (`:1050-1064`).
* `finalize()` renumbers breadth-first so a directory's children are one consecutive id range and `parent[id] < id`, which makes `sumSizes()` a single reverse pass (`:907-1019`).
* `emitFileNode` builds objects with a fixed property order so the JSON is byte-identical to the legacy tree (`:208-233`). `pruneStore` is the transport limiter: the SSE `complete` frame and `/result` carry at most `PRUNE_MAX_NODES = 250,000` nodes; deeper levels are fetched through `/subtree` (`src/api/scanRoutes.ts:61`).
* Measured today with `scripts/bench-v4.ts`: **49.7 bytes per node at 1M nodes, 51.8 at 5M** (comments say 40–60; a plain `FileNode` tree measured ~330 bytes per node, `:13-14`). A 5M-node scan is therefore ~260 MB of store, and the July design measured `JSON.stringify` of a 5M-node tree throwing `Invalid string length`, which the 250k prune fixed.
* Both the mtime cache (a full tree, JSON) and `scan.root` (a getter that prunes the store with `maxNodes: MAX_SAFE_INTEGER`, `diskScanner.ts:307-322`) still materialise object trees; the cache is capped at 300k nodes for that reason.

## 6. Exact duplicates (`src/services/duplicateFinder.ts`)

* Stages (`:7-17`, `:94-143`): bucket by exact size over `store.eachFile`; buckets of one are dropped; **SHA-256 of the first 64 KiB** (`PARTIAL_BYTES`, `:19`); **full-file SHA-256**; grouped on `size:hash`. **No byte comparison** after the full hash.
* `HASH_CONCURRENCY = 4` (`:23`), `fs.createReadStream` with the default buffer, one bucket at a time.
* Minimum size is a job parameter: HTTP default 1,024 bytes (`src/api/insightRoutes.ts:80`), MCP default 1,024 (`src/mcp/server.ts:514`).
* **Nothing is filtered by flag.** Hard-link duplicates fall out only because the scanner zeroed their size. Symlinks are hashed (the walker records their size). **Cloud placeholders are not excluded** — contrast the near-duplicate job, which excludes `HardlinkDup | Symlink | CloudPlaceholder` (`src/services/perceptualDupes.ts:116`). A same-size evicted iCloud/OneDrive file reaching the partial-hash stage is opened and read, which makes the OS download it. This is the master prompt's Section 3.2 trap, present today. (Recorded in `RISKS.md` R1.)
* Groups: `files` newest-first, groups by `reclaimable = size × (count − 1)` descending, the first `REPORTED_GROUPS = 500` reported while `groupCount` and `totalReclaimable` count all (`:155-172`).
* `reclaimableIsUpperBound = process.platform === 'darwin'` with a fixed APFS-clone sentence (`:176-181`); no per-file clone detection. **Both fields are computed and then dropped** by `/api/duplicates` and by the MCP tool (known gap 2 in `NEXT_SESSION_PROMPT.md`).
* Jobs are in-process per `scanId`+`minSize`, cancelled cooperatively once per bucket; **no digest is ever persisted**, so a rescan re-hashes everything.
* Response, 200: `{ status:'complete', scanId, minSize, groups, groupCount, totalReclaimable, tookMs }`; per group `{ hash, size, count, reclaimable, files:[{ name, path, modifiedAt }] }`; 202: `{ status:'running', hashed, toHash }` (`insightRoutes.ts:78-99`).
* **The last-copy rule is client-only and untested**: `src/ui/app/200-duplicates-view.js:254-258` and `205-duplicate-viewer.js:315-321` refuse to stage every copy of a group with a toast; `POST /api/cart/commit` and `DELETE /api/files` have no duplicate-group awareness (`src/services/cartCommit.ts:117-124`); no test in `tests/` exercises the guard.

## 7. Near-duplicate images (`src/services/perceptualDupes.ts`)

* Candidates: `IMAGE_EXT` = jpg, jpeg, png, gif, webp, bmp, tiff, tif, heic, heif, avif; at least 4 KiB; hard links, symlinks and cloud placeholders excluded; sorted largest-first and **capped at `MAX_IMAGES = 8,000`** with `truncated: true` beyond (`:34-40`, `:116-125`).
* Decode: `sharp(file, { failOn: 'none', animated: false }).greyscale().resize(9, 8, { fit: 'fill' }).raw()` (`:317-321`) — **no `sequentialRead`, no `limitInputPixels`, no EXIF-thumbnail shortcut, no DCT-scaled decode request beyond what libvips picks for the target**; `ffmpeg` frame-1 fallback; `'none'` → `available: false` with a reason. Concurrency 4 (sharp) or 2 (ffmpeg).
* Hash: 64-bit **dHash** over the 9×8 grey buffer, stored as two 32-bit halves (`:221-248`).
* Search: **full pairwise O(n²)** with union-find, cancellation checked every 512 rows (`:150-167`) — the reason for the 8,000 cap. Threshold default 10, clamped 0–32.
* Keeper: newest file in each cluster; distances are measured against its hash; `reclaimableBytes` is the sum of the others (`:181-193`).
* Thumbnails: 256 px WebP, in-memory LRU of 48 MiB keyed on `sha1(path mtime size dim)`, warmed once per completed job for up to 5,000 files (`src/services/thumbnailCache.ts`). Measured (comments): ~20 ms per sharp decode, ~46 ms cold vs ~6 ms warm in the browser.
* Response, 200: `{ status:'complete', scanId, threshold, available, decoder, reason, clusters, clusterCount, totalReclaimable, truncated, tookMs }`; per cluster `{ files:[{ name, path, size, modifiedAt, distance }], count, reclaimableBytes }` (`insightRoutes.ts:132-144`).

## 8. Digests used for safety (offload, Time Capsule)

`src/utils/copyVerify.ts:44-73`: `copyWithHash` hashes the bytes as they are
copied and `hashFile` re-reads the destination — both **SHA-256**. Offload
trashes an original only after the read-back digest matches (`src/services/offload.ts:398-416`);
restore refuses an occupied path and re-verifies. The offload manifest entry
is `{ id, name, originalPath, destPath, destRoot, size, hash, offloadedAt,
restoredAt? }` (`src/models/types.ts:609-623`) and the Time Capsule member is
`{ rel, kind, size, hash, target?, mtimeMs?, atimeMs? }` — **neither records
the algorithm's name or a schema version**. Any future algorithm change here
must add that field first; the new engine does not touch these paths.

## 9. API surface and what pins it

* `buildScanStats` (`src/api/scanRoutes.ts:25-47`) is an explicit 19-key
  literal shared by `GET /api/scan/:id/stats`, the SSE `complete` frame and
  `POST /api/scan?wait=true`: `scanned, fileCount, dirCount, engine, ioThreads,
  durationMs, incremental, cachedDirs, walkedDirs, hardlinkedFiles,
  hardlinkedBytes, sparseFiles, sparseBytes, slackBytes, cloudFiles, cloudBytes,
  refused{dirs, examples}, vanishedDirs, expiresAt`.
* **Adding a key to it fails two tests today**: `tests/goldenResponses.test.ts`
  (byte-for-byte against `tests/fixtures/golden/responses.json`, macOS only)
  and `tests/discoverability.test.ts:88-96`, which requires every returned key
  to be described by `src/api/openapi.ts` (`ScanStats`, `:151-179`, all 19
  required). The repo treats these responses as byte-identity locked; the
  budget-gauges endpoint was created rather than add a key to `/budgets`
  (`scanRoutes.ts:400-404`). The master prompt's Section 11.2 asks for
  additive keys on the stats response; that is an intentional, listed change
  that re-records the golden and extends the spec in the same commit.
* Other scan routes: `POST /scan` (`guardBodyPath`, `wait`/`waitMs`), `/cancel`,
  `/progress` (SSE), `/result` (250k-node prune), `/subtree`
  (`guardQueryPath('path')`), `/nodes` (≤ 500 paths), `/stats`, `/budgets`,
  `/budget-gauges`, `/export`, `/treemap`, `/calendar`, plus `/large-files`
  and `/file-types` (`scanRoutes.ts:142-562`).
* Guards (`src/middleware/pathGuard.ts`, `src/utils/pathSanitizer.ts`):
  blocklists `/proc /sys /dev /run /private/var/db /System/Volumes/VM` and the
  Windows system directories; canonicalisation resolves the parent, keeps the
  leaf as spelled, strips the `/System/Volumes/Data` firmlink prefix, and adds
  a dev+inode identity check for blocked directories. `requireInsideScanRoot`
  refuses `cloud://`, out-of-root and archive-internal paths on every
  destructive or file-opening endpoint. Every new endpoint must use the same
  three guards.
* Settings: no schema library; per-field normalisers in
  `src/services/settings.ts:22-175`, assembled in `getSettings()`
  (`:177-201`), written through `PUT /api/settings` (`src/api/settingsRoutes.ts:32-74`),
  fetched by the UI inline in `src/ui/app/235-settings-modal.js:5-26`. A new
  enum setting is declared on `AppSettings`, normalised beside `SCOPES`, wired
  into the two object literals and the route's `NOTHING_TO_UPDATE` condition.
* Capabilities: `{ available, mechanism, reason?, degradedTo? }` per probe,
  every probe wrapped so a throw becomes an unavailable state with the reason
  (`src/platform/capabilities.ts:39-50`); cached 30 s; `409
  CAPABILITY_UNAVAILABLE` for gated endpoints. `npm run capabilities:report`
  prints the table in CI.
* Rate limiter lanes: `api` 20 burst / 10 per s, `meta` 120 / 60, `preview`
  300 / 150; progress endpoints are `meta`, result endpoints deliberately `api`
  (`src/middleware/rateLimiter.ts:60-105`).

## 10. Platform notes that bind the new engine

* macOS allocated bytes = `st_blocks × 512` from `lstat`; a 50 MB truncate-only sparse file reports `blocks = 0` (`src/platform/macos/allocation.ts:11-14`). `SEEK_DATA/SEEK_HOLE` is unreachable from Node. Clone families are recorded as **unavailable without native code** (`:23-37`); a measured `cp -c` clone consumed −4,096 bytes while `st_blocks` reported the full size (`docs/PLATFORM_NOTES.md:80-88`).
* `blocksAreMeaningful` is false on Windows (libuv leaves `blocks` at 0), so Windows scans have no sparse/slack/allocation accounting at all today (`src/platform/index.ts:44-53`).
* Both Windows and Linux platform code was written on macOS and is proven only by CI round-trips (`docs/PLATFORM_NOTES.md:22-33`).
* The persistent index (`src/services/indexEngine.ts`, SQLite) is a separate subsystem with its own watcher; it stores a node in 183 bytes on disk (README:760). It is not the scan engine and is out of this project's scope except where the new engine must not fight it for the app-data directory.

## 11. Measured numbers already on record

| Figure | Value | Source |
| --- | --- | --- |
| Node walker, `/Applications`, 458k entries | 69k–97k entries/s, run-to-run spread 39% | `gduScanner.ts:17-19`, July design §2 |
| gdu, same tree | 124k–129k entries/s unsharded; ~112k sharded (3.83 s vs 3.55 s) | `gduScanner.ts:17-30` |
| Whole-disk scan of `/` | 1,411,715 items in 16.4 s (~86k/s); a home folder of 458,661 items in 9.1 s | README:760 |
| gdu-turbo, 50,000-file synthetic tree, end to end through the HTTP API | **1,835 ms median today (27k items/s, ±1.5%, load 3.3)** against a recorded baseline of 1,498 ms (26 Aug) — fixed subprocess and JSON overhead dominates at this size | `npx tsx scripts/bench-v4.ts --files=50000 --runs=5`, run 18 Sep |
| Packed store | 49.7 B/node at 1M, 51.8 at 5M (measured today); legacy tree ~330 B/node | bench-v4; `scanStore.ts:13-14` |
| gdu JSON | 79 B/node; `JSON.parse` of 5M nodes 1.68 s at 1.7 GB RSS; `JSON.stringify` of the tree throws | July design §2 |
| Mapping cost | 787 ms → 39 ms per 458k nodes by dropping `path.join`/`path.extname` | `gduMapper.ts:29-30` |
| Hard links | gdu and walker agree byte for byte on `/Applications` (30,070,595,907 B, 21,499 links); naive counting is 1.972% high | `gduMapper.ts:23-26` |
| Thumbnails | ~20 ms per sharp decode; 46 ms cold vs 6 ms warm in the browser | `thumbnailCache.ts:8-22`, `:143-146` |
| Threadpool | 16 threads ≈ 1.6× faster than 4 on APFS; 32 slower than 4 | `ioThreads.ts:15-17` |

## 12. This machine's ceilings (measured today)

* `kern.maxvnodes = 251,127`. macOS keeps at most that many vnodes cached, so
  a warm metadata cache can cover **roughly a quarter of a million entries**
  and no more; every scan larger than that pays catalog reads for the rest,
  whatever the enumeration API. "Warm cache, 1M entries" is therefore not a
  state this machine can be in without changing a kernel setting.
* `hw.pagesize = 16,384`. Memory-mapped columns page in 16 KiB at a time.
* Free space on the data volume: 249 GiB of 460 GiB. The prompt's 500 GB
  duplicate corpus cannot be built here at full scale.
* `cc` alone fails to link on this machine (the command-line-tools SDK is
  newer than Xcode 26.6's linker: `arm64e.x1-macos` unknown); `xcrun --sdk
  macosx clang -isysroot $(xcrun --sdk macosx --show-sdk-path)` links, and
  `cargo build` links with no help. Any C probe the harness compiles must use
  the `xcrun` form.
* `proc_pid_rusage(RUSAGE_INFO_V4)` returns `ri_diskio_bytesread` for any
  process of the same user without root (verified against Finder: 85,602,304
  bytes read). That is the bytes-read counter the harness uses on macOS, with
  two limits measured while building it: the counter is **physical** reads
  only (a warm-cache pass legitimately reports 0) and it **excludes child
  processes**, so a gdu scan's reads are invisible to it and the harness says
  `n/a` for that engine. Also: `ri_user_time` and `ri_system_time` are **mach
  absolute-time ticks on Apple silicon** (timebase 125/3, 24 MHz), not
  nanoseconds — read raw they are 41.7× too small; the probe converts through
  `mach_timebase_info`.

## 13. The suite at this commit (measured today)

`npm test` at `716beb6` under an isolated `TREEMAP_DATA_DIR`, on this Mac:

| Figure | Value |
| --- | --- |
| Tests | 2,516 |
| Pass | 2,510 |
| Fail | **1** — `tests/rateLimiterLanes.test.ts` "draining the strict lane leaves the metadata lane untouched, and the reverse" |
| Skipped | 5 (3 platform, the CI locale self-proof, the Windows-only live topology test) |
| Wall clock | 36.2 s (load 2.9 → 6.8) |

The one failure is **not a flake and not a regression from this work**: it
fails 3 of 3 runs alone, before any file in this repository was touched, with
`connect ECONNRESET 127.0.0.1:<port>`. The test opens **200 connections at
once** against a server whose listen backlog macOS clamps to
`kern.ipc.somaxconn = 128`; on macOS 27.0 (this machine was upgraded after the
last recorded green run on 7 September) the kernel resets the overflow instead
of queueing it. GitHub's macOS runners do not do this, which is why CI is
green. It is an environment-specific weakness of the test's flood, not of the
limiter; Phase 1 fixes the test to keep at most 64 sockets open while still
sending 200 requests, so the local gate can be trusted again. Until then the
honest local floor is **2,510 passing, 1 environment-specific failure**.
`npm run typecheck` is clean and `node scripts/build-ui.js --check` matches
113 parts.

## 14. The sibling Rust core (TreeMapMobile)

`Desktop/Claude Code/TreeMapMobile/rust` is the same owner's MIT-licensed Rust
workspace for TreeMap for iPhone (edition 2024, `rust-version = 1.97`,
clippy pedantic with `unwrap`/`panic`/`indexing_slicing`/`arithmetic_side_effects` denied, `panic = "unwind"`).
Four of its crates implement, on Apple platforms, most of what the master
prompt's Section 4.2 asks for:

| Crate | Lines | What it already does | Host numbers on this Mac (its own reports) |
| --- | --- | --- | --- |
| `tm-scan` | 4,640 | `getattrlistbulk(2)` listing with a 64 KiB per-worker buffer, requesting `RETURNED_ATTRS | ERROR | NAME | DEVID | OBJTYPE | MODTIME | ACCTIME | FLAGS | FILEID` and `LINKCOUNT | ALLOCSIZE | DATALENGTH`; honours `ATTR_CMN_RETURNED_ATTRS`; `O_DIRECTORY|O_NOFOLLOW` + `fdopendir` fallback; refusal accounting (a refused folder is never an empty one); dataless (`SF_DATALESS`) and cloud-provider detection; deterministic output; rayon workers capped at 8 | 200k files: **292.7 ms** (≈683k entries/s) warm; 1M files: **25.7 s** (≈39k/s), the tree no longer fitting the vnode cache; the same 200k tree cold: 8.76 s |
| `tm-model` | 3,078 | Memory-mapped struct-of-arrays arena: `parent, first_child, next_sibling: u32; size, alloc: u64; modified, accessed: i64; name_off: u32; ext: u16; flags: u16` (52 B/node) plus an interned name blob; `F_PREALLOCATE` so a full volume fails the push instead of returning zeros | 1M-node arena reopen 47 ms cold, 11 ms resident |
| `tm-hash` | 906 | BLAKE3 in three stages (size, first 4 KiB, full), `O_NOFOLLOW` descriptor opens, thermal throttle, ≤ 4 workers, `#![forbid(unsafe_code)]` | duplicate pass over 200k files 1.7 s warm / 6.8 s cold — bound by `open()`, not hashing |
| `tm-photos` | 1,420 | dHash, exact/near/burst clustering with a one-copy-always-survives invariant, arena-agnostic | — |

Its state matters: on 14 September a nine-reviewer landing review confirmed
**17 defects, two CRITICAL**, one of them in `tm-scan` — a directory swapped
for a symlink mid-walk was followed by the `read_dir` fallback
(`walker.rs:1086`); the fix is half-done on branch `phase-b-landing-fixes-wip`
and is not gated. The working tree there is dirty on that branch. Nothing in
this project may build in or modify that repository; vendoring takes `main`'s
audited sources and re-fixes what the review found, with its own tests, in
this repository. Its perf report also states the finding that shapes
`DESIGN.md`: "the walk is not CPU-bound; it is bound by one `lstat` per file"
and, at 1M files, by the catalog once the tree exceeds the vnode cache.

## 15. Where the master prompt is wrong or stale about this repo

1. **The default engine is not the Node walker.** Every eligible scan runs the bundled `gdu` binary in sharded subprocesses; the walker is the fallback and the incremental/ignore-list path. The prompt never mentions gdu, and "LegacyEngine = the existing DiskScanner" must mean the whole existing chain (gdu → walker), not one module.
2. **A columnar store already exists.** `PackedScanStore` is a struct-of-arrays store at ~50 B/node with a name pool and parent-index paths; the prompt's Section 9.2 describes it as new work. What is missing is name deduplication, an allocation column, memory-mapped spill, and aggregate-only mode.
3. **The 250k transport prune already exists**, along with `/subtree` for drilling; "remain interactive" at 100M is a store problem, not a transport problem.
4. **`/api/scan/:id/stats` is under a byte-identity golden lock** and an OpenAPI key check. Extending it is allowed by the prompt but is a listed, deliberate change, not a free addition.
5. **The threadpool finding is the walker's ceiling, not the app's.** gdu already sidesteps libuv entirely; its ceiling (~112–129k/s here) is per-entry `lstat` inside Go plus the JSON round trip.
6. **Hard links are keyed on inode alone in the default engine**, a documented limit; the walker keys on `dev:ino`. The prompt's "track `(dev, ino)`" is only true of the fallback.
7. **The near-duplicate feature is capped at 8,000 images**, not slow at 200k — it never reaches 200k. The prompt's 200k target implies removing the cap, which the O(n²) search forbids today.
8. **The legacy duplicate finder can download cloud placeholders today.** Not a prompt error, but a present violation of its Section 3.2, and it is fixed before any new hashing code lands.
9. **`SECURITY.md` and `middleware/pathGuard`** are real; the path rules also live in `src/utils/pathSanitizer.ts`, and the "inside a scanned root" rule is what the prompt's "pathGuard still governs every path" refers to.
10. **Frontend is generated from 113 parts.** The zero-dependency constraint holds; the editing surface is `src/ui/`, not `public/index.html`.
11. **"Warm page cache at 1M entries" is not reachable on macOS by default** (`kern.maxvnodes ≈ 251k`). Targets above that size are catalog-bound on this platform; the harness labels them as such.
12. **`ntfs-mft` is a type-only placeholder.** No Windows MFT code exists.
13. **CI has no Rust and releases only macOS arm64 and Windows x64 installers.** Prebuilds for five targets mean adding three build legs (macOS x64, Linux x64, Linux arm64) or cross-compiling, and the Linux AppImage is not published at all today.
14. **The prompt's `DiskScanner`/`DuplicateFinder` casing is not the file naming**: `src/services/diskScanner.ts`, `duplicateFinder.ts`, `perceptualDupes.ts`.
15. **The mobile Rust core exists and covers most of Section 7.1, 9.2, 10.2 on macOS.** The prompt does not know about it; `DESIGN.md` §3 decides how it is reused.
