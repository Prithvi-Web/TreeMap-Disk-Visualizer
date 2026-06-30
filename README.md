# TreeMap 🟩🟨🟥

A GrandPerspective-style **disk space visualizer** for macOS, Linux and Windows.

Scan any folder and see exactly what's eating your disk:

- **Dashboard** — disk usage ring, live scan progress, file-type donut chart, top-10 largest files **and folders** (click a folder to jump into the treemap)
- **Treemap** — squarified treemap of every file, sized by bytes, colored teal → amber → red by size; click folders to drill in, breadcrumbs + zoom-out button to climb back up, a search box that highlights matches (`report`, `*.zip`), and one-click **PNG / SVG export**
- **Grid** — size-proportional icon grid with multi-select, sorting and virtual scrolling
- **Duplicates** — finds true duplicate files (size + streamed SHA-256 content hash), grouped with reclaimable space per group; auto-select keeps the newest copy of each
- **Trends** — every scan saves a lightweight snapshot, charted over time per folder, with a "what grew / shrank since last scan" breakdown
- **Compare** — pick any two scans of the same folder for a file-level diff: added, removed, grew, shrank
- **Clean Up** — three modes: custom rules (old / huge / by extension / duplicated), **Smart Suggestions**, and **Empty Folders**. Suggestions are grouped into **regenerable** (`node_modules`, Rust/Maven `target`, virtualenvs, framework build output — each gated on a sibling manifest and shown with the command that restores it, e.g. `npm install`), **cache** (browser & developer caches, with macOS/Windows/Linux-specific paths), and **junk** (OS metadata, old Downloads), each filterable by category. Everything goes to the system **Trash** (never hard-deleted — always recoverable)
- **Scheduled scans** — re-scan folders on a schedule with growth-threshold alerts (native notifications in the desktop app)
- **Ignore list** — "don't scan" and/or "don't suggest" patterns: full paths, names like `node_modules`, or globs like `*.iso` and `~/projects/**/dist`

Built with Node.js + Express 5 + TypeScript on the backend and a single zero-dependency
`index.html` on the frontend (hand-coded Canvas 2D — no React, no D3, no Chart.js).
Ships both as a web app and as a downloadable **desktop app** (Electron) for
macOS and Windows.

## Download the app (for users)

Grab the latest installer from the [**Releases page**](https://github.com/Prithvi-Web/Treemap/releases):

- **macOS** — `TreeMap-x.y.z-arm64.dmg`. Open it, drag TreeMap to Applications, launch it.
- **Windows** — `TreeMap Setup x.y.z.exe`. Run it and follow the installer.

> **First-launch security prompt:** because the app isn't signed with a paid
> Apple/Microsoft developer certificate, your OS shows a one-time warning.
> **macOS:** right-click the app → **Open** → **Open**. **Windows:** click
> **More info** → **Run anyway**. After the first launch it opens normally.
>
> **macOS says "TreeMap is damaged and can't be opened"?** That happens when the
> download's quarantine flag is still set. Clear it once, then launch normally —
> open **Terminal** and paste:
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/TreeMap.app
> ```

No Node.js or setup required — the desktop app is self-contained and scans the
disk of the computer it runs on.

### Desktop extras

- **Menu bar / tray icon** with live free-disk stats and quick actions (open app, scan home folder, quit). Closing the window keeps TreeMap in the tray so scheduled scans keep running — quit from the tray menu.
- **Drag & drop** a folder onto the window or the dock icon to scan it instantly.
- **Auto-updates** from GitHub Releases (Windows; asks before restarting). On macOS, auto-update requires a code-signed build, so unsigned builds simply skip it — grab new versions from the Releases page.
- **Growth alerts** from scheduled scans arrive as native notifications.

## Run from source / web mode (3 commands)

```bash
npm install
npm run build
npm start
```

Then open **http://127.0.0.1:4280** in your browser.

> For development with auto-reload: `npm run dev`

Requires **Node.js 20+**. On Linux, trash support uses `gio` (preinstalled on
GNOME/KDE distros). On macOS it uses Finder via `osascript`; on Windows, the
Recycle Bin via PowerShell.

## Build the desktop app

```bash
npm install
npm run app          # build + launch the desktop app locally
npm run dist:mac     # produce a macOS .dmg in release/
npm run dist:win     # produce a Windows installer in release/
```

> You can only build the macOS app on a Mac and the Windows app on Windows.
> To get **both** without owning both machines, use the automated release
> below — GitHub builds them for you.

## Publish a new version (automated)

A GitHub Actions workflow (`.github/workflows/release.yml`) builds the macOS
**and** Windows installers on GitHub's servers and attaches them to a Release —
including the `latest*.yml` metadata files the in-app auto-updater checks.

To cut a release:

1. Bump the `version` in `package.json` (e.g. `1.2.1`).
2. Create a **tag** that matches, prefixed with `v` (e.g. `v1.2.1`), and push it.
   In GitHub Desktop: **Repository → Push**, then on github.com go to
   **Releases → Draft a new release → Choose a tag →** type `v1.2.1` → **Publish**.
3. The workflow runs automatically, builds both installers, and uploads them to
   that Release. After a few minutes the download links appear on the Releases page.

You can also trigger a test build anytime from the repo's **Actions** tab →
**Build & Release → Run workflow** (installers are saved as downloadable
artifacts instead of a Release).

## API overview

| Endpoint | Description |
|---|---|
| `POST /api/scan` | Start scanning a folder (`{ path, incremental? }`) → `{ scanId }` |
| `GET /api/scan/:id/progress` | Live scan progress (Server-Sent Events) |
| `GET /api/scan/:id/result` | Full file tree (202 while running) |
| `GET /api/scan/:id/treemap` | Pre-computed squarified treemap layout |
| `GET /api/scan/:id/stats` | Scan counters incl. fast-rescan cache usage (`cachedDirs`, `walkedDirs`) |
| `GET /api/scans` | Completed scans currently in memory |
| `GET /api/large-files?scanId=` | Top N largest files |
| `GET /api/large-folders?scanId=` | Top N largest folders (recursive sizes) |
| `GET /api/file-types?scanId=` | Size breakdown by extension |
| `GET /api/duplicates?scanId=` | Duplicate groups (starts hashing; poll until complete) |
| `GET /api/near-duplicates?scanId=&threshold=10` | Perceptual (dHash) near-duplicate image clusters; poll until complete |
| `GET /api/empty-folders?scanId=` | Recursively empty folders (`ignoreJunk` configurable) |
| `GET /api/compare?scanIdA=&scanIdB=` | File-level diff of two scans of the same root |
| `GET /api/snapshots` | Scan history: roots, per-root snapshots (`?path=`), or all (`?all=true`) |
| `GET /api/snapshots/compare?a=&b=` | Top-level deltas between two snapshots |
| `GET /api/cleanup/suggestions?scanId=` | Smart cleanup suggestions (OS-aware rules) |
| `GET /api/git/repos?scanId=` | Per-repo pack / loose-object / LFS breakdown of every .git |
| `POST /api/git/gc` | Run `git gc` in a scanned repo (`{path, confirm:true}`) |
| `GET /api/settings` / `PUT /api/settings` | Ignore list + scheduled scans |
| `GET /api/notifications` | Growth alerts from scheduled scans |
| `GET /api/system` | Disk totals, platform, suggested folders |
| `GET /api/trash/size` | System Trash / Recycle Bin size, item count, and contents |
| `GET /api/system/snapshots` | Local filesystem snapshots (APFS/Btrfs/VSS), best-effort |
| `POST /api/system/snapshots/purge` | Delete local snapshots (macOS; `{confirm:true}`) |
| `GET /api/fs/list?path=` | Folder browser (powers the path picker) |
| `DELETE /api/files` | Move files to the system trash |
| `POST /api/files/open` | Open / reveal a path in Finder & co. |
| `GET /api/files/preview?path=` | Quick-look preview: image stream, text head, or metadata |

## Safety

- Paths are sanitized and traversal-proofed; system dirs (`/proc`, `/sys`, `/dev`,
  `/run`, `C:\Windows\System32`, …) are blocked outright
- Trash/open endpoints only accept paths **inside a folder you scanned**
- Deletes always go through the OS trash — undo from Finder/Explorer any time
- The Duplicates view refuses to trash *every* copy in a group — at least one stays
- Token-bucket rate limiting (10 req/s per IP), graceful SIGTERM shutdown that
  drains live SSE streams and stops background hashing & scheduled scans
- Scan results live in memory only and auto-expire after 30 minutes; history
  snapshots and settings are small JSON files in the platform app-data folder
  (`~/Library/Application Support/TreeMap`, `%APPDATA%\TreeMap`, or `~/.config/treemap`)

## Project layout

```
src/
  api/          Express routes (scan, files, system, insights, settings)
  services/     DiskScanner (8-way concurrent walker), Cleaner (trash/open),
                DuplicateFinder (staged hashing), Snapshots (Trends history),
                CleanupRules (smart suggestions), Scheduler (recurring scans),
                Settings, Storage (app-data JSON), DiskUsage
  models/       Shared TypeScript interfaces
  utils/        formatBytes, squarified treemap, path sanitizer, glob matcher
  middleware/   errorHandler, rateLimiter, pathGuard
  index.ts      App entrypoint + graceful shutdown
electron/
  main.js       Desktop shell: window, tray, drag-drop, notifications, auto-update
  preload.js    Context-isolated bridge for drag-drop paths & scan pushes
public/
  index.html    The entire frontend (inline CSS + JS, zero dependencies)
scripts/
  gen-tray-icon.js  One-time generator for the tray template icons
```

## Design decisions worth knowing

- **Snapshots are automatic** — one is saved at the end of every successful scan,
  so Trends needs no setup. Only totals + top-level entry sizes are stored
  (a few KB each, capped at 200 per folder).
- **The scheduler is a 60-second `setInterval`**, not `node-cron` — hour-level
  granularity doesn't justify a dependency. Schedules fire while the app runs
  (the desktop app keeps running in the tray).
- **Duplicate detection is staged** (size → first 64 KB hash → full SHA-256) so
  scans with hundreds of thousands of files finish hashing in seconds, and only
  true content matches are reported.
- **Compare collapses subtrees**: a deleted or added folder shows as one row,
  not thousands of file rows.
