# How TreeMap is built

> **How it's built**: Node.js + **Express 5** + **TypeScript** on the backend, with a Rust scan core (`native/treemap-core`) loaded as a Node module. The frontend ships as a single, **zero-dependency** `index.html`, generated from `src/ui/` (small source files stitched by `scripts/build-ui.js`), with hand-coded **Canvas 2D**, no React, no D3, no Chart.js. Navigation is a **liquid-glass sidebar** that collapses to a 64-px icon rail with ⌘B (and floats over the content, with a scrim, on narrow windows). Ships as a **web app** _and_ a downloadable **Electron desktop app** for macOS and Windows.

Contributing? [CONTRIBUTING.md](../CONTRIBUTING.md) has the three commands and the one rule.

## 🗂️ Project layout

```text
src/
  ui/           The frontend, as small editable parts, shell/ (the document's
                head and tail), styles/, markup/ (one file per view and modal),
                app/ (the behaviour). scripts/build-ui.js stitches them, in
                manifest.json order, into public/index.html. Run `npm run build:ui`
                after any edit; never edit the generated page (the suite fails
                if it drifts from its sources). See src/ui/README.md.
  api/          Express routes, scan, files, insights, facts, query, cart,
                offload, cloud, fleet, autopilot, the Undo Vault (timecapsule),
                notes, journal, platform, settings, and meta (capabilities +
                OpenAPI)
  services/     ScanStore (packed Structure-of-Arrays scan memory),
                DiskScanner (engine choice + the built-in walker), scan/ (the
                native engine's Node side: loader, eligibility, memory store,
                NTFS turbo check) and the gdu engine,
                indexEngine (the SQLite live index behind global search),
                DuplicateFinder (staged hashing), Snapshots (Trends history),
                CleanupRules + rulepacks/ (smart suggestions), AppAttribution,
                Forecast (disk-full projection), Watcher (live activity),
                ContainerScanner (archive drill-down), Offload (copy-verify-trash),
                TimeCapsule (the Undo Vault), Autopilot, facts/ (per-path
                providers incl. the Reclaim score), query/ (the search
                grammar), cloud/ (Google Drive, Dropbox, OneDrive), fleet/
                (LAN summaries + mDNS), Scheduler, Settings, Storage (app-data
                files), DiskUsage
  platform/     OS-specific mechanisms, trash, shell integration, snapshots,
                SMART, last-used, backups, under macos/, windows/, linux/
  mcp/          The stdio MCP server (`npm run mcp`)
  middleware/   errorHandler, rateLimiter, pathGuard, requireToken
  models/       Shared TypeScript interfaces
  utils/        formatBytes, squarified treemap, path sanitizer, glob matcher,
                copy-verify, SSE
  index.ts      App entrypoint + graceful shutdown
electron/
  main.js       Desktop shell: window, tray, drag-drop, notifications, auto-update
  preload.js    Context-isolated bridge for drag-drop paths & scan pushes
  mft.js        Windows: starts the NTFS turbo helper, after asking
native/
  index.d.ts    The contract between the app and the Rust module (nativeVersion)
  treemap-core/ Rust workspace: tm-walk (folder listing), tm-governor (the
                scanning budget), tm-store (the scan's store), tm-node (the
                Node module), tm-mft + tm-mft-helper (Windows NTFS turbo)
bench/          `npm run bench`, the harness and recorded baselines the
                native engine's speed figures come from
public/
  index.html    GENERATED from src/ui/, never edit it; run `npm run build:ui`
vscode-extension/
  src/lib/      Pure decision-making (which source tree to run, what may be
                cloned, what a webview may frame), no `vscode` import, so the
                main test suite covers it
  src/          The editor glue: progress notifications, the webview panel,
                and the child process that runs TreeMap's own server
scripts/
  build-ui.js       Stitches src/ui/ into public/index.html (`--check` verifies)
  build-native.js   Builds the Rust module into native/prebuilt/<platform-arch>/
  check-prebuilt.js Refuses a dist whose native module is missing or stale
  release-notes.js  Writes a release's notes from CHANGELOG.md + INSTALL-NOTE.md
  dev-isolated.js   Runs the server against a throwaway data folder
  fetchGdu.js       Downloads the gdu scan engine for packaging
  afterPack.js      Ad-hoc-signs the macOS bundle so it is not "damaged"
  mark-portable.js  Marks a mac zip or Linux AppImage build as portable
  run-tests.js      Cross-shell test runner (`npm test`)
  gen-tray-icon.js  One-time generator for the tray template icons
tests/          node:test suite: `npm test`, or one file with
                `npx tsx --test tests/<name>.test.ts`
```

## 🧠 Design decisions worth knowing

- **A scan lives in a packed Structure-of-Arrays store, not a tree of objects.** Every scan used to be millions of JavaScript objects (~330 bytes each, measured), which put a hard ceiling of a few million files on what fit in RAM. The tree now lives in a handful of typed arrays (`src/services/scanStore.ts`): names in one UTF-8 pool, children as contiguous id ranges laid out breadth-first, paths reconstructed on demand instead of stored. Measured cost: **~52 bytes per file** at 1M, 5M, 20M and 40M synthetic nodes, a 40M-item scan is ~2 GB of arrays, and a 100M-item scan projects to ~5 GB, on hardware where the object tree could not have held 20M. Summing every directory size is one reverse linear pass (28 ms for 5M nodes vs 2.2 s recursive), nothing recurses on pathological depth, and the browser notices nothing: the pruned JSON the API emits is byte-identical to the old tree, a golden test replays a fixture scan against responses recorded from the pre-rewrite server and compares the raw bytes. The store's columns are plain typed arrays. For a native scan they are built by the Rust core (`tm-store`) while the walk runs and adopted without a copy; the built-in walker and gdu fill the same columns from JavaScript. (A spill mode that keeps a very large scan in files on disk is being built; until it ships, every scan is held in memory.) The one deliberate trade: handing 250k pruned nodes to the UI rebuilds path strings the old tree kept around, ~150 ms per handover on an operation that already spends ~170 ms serializing.
- **For the built-in walker, scan speed is a threadpool problem.** Every async `lstat`/`readdir` runs on libuv's threadpool, which defaults to 4 threads, that, not the walker's concurrency, was its bottleneck. TreeMap sizes the pool to 2× cores (≤ 16) before it spins up; measured on APFS this scans ~1.6× faster, while 32 threads is *slower* than 4 (kernel metadata-lock contention). The dashboard shows which engine ran and how long the scan took.
- **The native scan engine lists a whole folder in one system call.** On macOS it asks `getattrlistbulk` for every entry's name, type, sizes, times and flags at once, on its own worker threads (Linux: `getdents64` + `statx`; Windows: `FileIdExtdDirectoryInfo`), and builds the scan's store itself while it walks (`tm-store`, in the layout of the app's own store), which TreeMap then takes over, so the JSON is the same, and the equivalence tests hold it byte-identical to the built-in walker's (verified on macOS; Linux and Windows run on CI). The store's room is sized before the walk, from the last scan of the same folder or, for a whole volume, from the volume's count of inodes in use, so a big disk is walked once; a tree that outgrows the room it was given is walked a second time, and the scan says so. Recorded by `npm run bench` on an Apple M3 (4 performance + 4 efficiency cores, 16 GB, macOS 27), warm cache, Turbo budget, load 2.2–3.6 (up to 7.0 during the built-in walker’s runs on the 1,000,000-entry tree), 23 September 2026: **412,291 entries/s on a 200,000-entry tree** (the built-in walker: 131,203), and **91,308 entries/s on a 1,000,000-entry tree** too big for the kernel's metadata cache, which reads 2.3 GB per scan (the walker: 82,497). At the Eco budget it runs on the efficiency cores and its speed varied too much run to run to record (±17%). These figures predate 26 September 2026, when the engine began building the scan's store as it walks, and have not been re-measured since. Where the native module cannot load, gdu runs on macOS and Linux (where one is bundled, fetched or on the PATH) for a full scan with no "Don't scan" patterns that does not include the drives mounted inside the folder, and the built-in walker otherwise. If a native walk fails part-way, the built-in walker scans again from the start, and the Dashboard's engine line says why, unless the walk had already counted more than 5,000,000 items, or the folder's last scan counted more than 4,000,000: then the scan ends instead, with a message that gives the reason and how to scan it anyway, rather than start again at a fraction of the speed.
- **The numbers, measured, with the machine's load next to them.** A throughput figure without the load it was taken under is not a claim about anything, the same code on the same tree has measured 116,793 items/s on an idle machine and ~47,000/s on a busy one. Measured with the engines of the 5.0 releases, before the native engine, on an Apple Silicon MacBook running a normal desktop session (`load average 3.1–4.6`, i.e. *not* a quiet benchmark box): a **whole-disk scan of `/` covered 1,411,715 items in 16.4 s (~86,000 items/s)**, and a home folder of **458,661 items took 9.1 s**. The persistent index stores a node in **183 bytes on disk** (164 after compaction), and `readTree` hands the UI its 250,000-node cap in **~790 ms**. Expect better on an idle machine and worse under load; the relationships between these numbers are the stable part, not the absolute values.
- **Snapshots are automatic**, one is saved after every successful scan, so Trends needs zero setup. Totals + top-level entries live in `snapshots.json` (a few KB each, capped at 200 per folder); the time slider's shallow trees (≤ 3 levels, ~100 KB budget each) sit in separate per-root files so the main history file stays tiny.
- **The scheduler is a 60-second `setInterval`**, not `node-cron`, hour-level granularity doesn't justify a dependency. Schedules fire while the app runs (the desktop app keeps running in the tray).
- **Duplicate detection is staged** (size → first 64 KB hash → full SHA-256) so scans with hundreds of thousands of files finish hashing in seconds, and only true content matches are reported.
- **Compare collapses subtrees**, a deleted or added folder shows as one row, not thousands of file rows.

## 📜 Third-party licences

TreeMap is MIT-licensed, see [LICENSE](../LICENSE). The desktop app also bundles code by others. Two parts of it carry their licences in the app's resources folder: **gdu** (MIT), as `gdu/LICENSE.md`, and **TreeMap's native scan core**, whose Rust crates and standard library are listed with their licence texts in `THIRD_PARTY_NOTICES.txt`, the same file as [`native/THIRD_PARTY_NOTICES.txt`](../native/THIRD_PARTY_NOTICES.txt) here, generated from `Cargo.lock` and the pinned Rust toolchain by `scripts/rust-notices.js` (see [native/README.md](../native/README.md#third-party-notices)).

gdu is a Go program, and the Go modules and Go standard library linked into it ship their licence texts beside it as `gdu/THIRD_PARTY_NOTICES.txt`, the same file as [`build/gdu/THIRD_PARTY_NOTICES.txt`](../build/gdu/THIRD_PARTY_NOTICES.txt) here, written from gdu's own build information by `scripts/gdu-notices.js`.

The desktop app is built on **Electron** (MIT) and **Chromium**, and ships their licences as `LICENSE.electron.txt` and `LICENSES.chromium.html`: Chromium's credits page, with the licence of every component Chromium is built from. On macOS they are in the resources folder (`TreeMap.app/Contents/Resources`): electron-builder leaves both out of a Mac bundle, so `scripts/afterPack.js` puts them there from the Electron release zip, checked against the Electron inside the app, and refuses to finish a build without them. On Windows and Linux they sit beside the TreeMap executable, where electron-builder keeps them.
