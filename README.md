# TreeMap 🟩🟨🟥

A GrandPerspective-style **disk space visualizer** for macOS, Linux and Windows.

Scan any folder and see exactly what's eating your disk:

- **Dashboard** — disk usage ring, live scan progress, file-type donut chart, top-10 largest files
- **Treemap** — squarified treemap of every file, sized by bytes, colored teal → amber → red by size; click folders to drill in, right-click to open / copy path / trash
- **Grid** — size-proportional icon grid with multi-select, sorting and virtual scrolling
- **Clean Up** — find files that are old / huge / by extension / duplicated, preview them, and move them to the system **Trash** (never hard-deleted — always recoverable)

Built with Node.js + Express 5 + TypeScript on the backend and a single zero-dependency
`index.html` on the frontend (hand-coded Canvas 2D — no React, no D3, no Chart.js).
Ships both as a web app and as a downloadable **desktop app** (Electron) for
macOS and Windows.

## Download the app (for users)

Grab the latest installer from the [**Releases page**](https://github.com/Prithvi-Web/Treemap/releases):

- **macOS** — `TreeMap-x.y.z-arm64.dmg`. Open it, drag TreeMap to Applications, launch it.
- **Windows** — `TreeMap Setup x.y.z.exe`. Run it and follow the installer.

> **First-launch security prompt:** because the app isn't signed with a paid
> developer certificate, your OS shows a one-time warning.
> **macOS:** right-click the app → **Open** → **Open**. **Windows:** click
> **More info** → **Run anyway**. After the first launch it opens normally.

No Node.js or setup required — the desktop app is self-contained and scans the
disk of the computer it runs on.

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
**and** Windows installers on GitHub's servers and attaches them to a Release.

To cut a release:

1. Bump the `version` in `package.json` (e.g. `1.0.1`).
2. Create a **tag** that matches, prefixed with `v` (e.g. `v1.0.1`), and push it.
   In GitHub Desktop: **Repository → Push**, then on github.com go to
   **Releases → Draft a new release → Choose a tag →** type `v1.0.1` → **Publish**.
3. The workflow runs automatically, builds both installers, and uploads them to
   that Release. After a few minutes the download links appear on the Releases page.

You can also trigger a test build anytime from the repo's **Actions** tab →
**Build & Release → Run workflow** (installers are saved as downloadable
artifacts instead of a Release).

## API overview

| Endpoint | Description |
|---|---|
| `POST /api/scan` | Start scanning a folder → `{ scanId }` |
| `GET /api/scan/:id/progress` | Live scan progress (Server-Sent Events) |
| `GET /api/scan/:id/result` | Full file tree (202 while running) |
| `GET /api/scan/:id/treemap` | Pre-computed squarified treemap layout |
| `GET /api/large-files?scanId=` | Top N largest files |
| `GET /api/file-types?scanId=` | Size breakdown by extension |
| `GET /api/system` | Disk totals, platform, suggested folders |
| `GET /api/fs/list?path=` | Folder browser (powers the path picker) |
| `DELETE /api/files` | Move files to the system trash |
| `POST /api/files/open` | Open / reveal a path in Finder & co. |

## Safety

- Paths are sanitized and traversal-proofed; system dirs (`/proc`, `/sys`, `/dev`,
  `/run`, `C:\Windows\System32`, …) are blocked outright
- Trash/open endpoints only accept paths **inside a folder you scanned**
- Deletes always go through the OS trash — undo from Finder/Explorer any time
- Token-bucket rate limiting (10 req/s per IP), graceful SIGTERM shutdown that
  drains live SSE streams
- Scan results live in memory only and auto-expire after 30 minutes

## Project layout

```
src/
  api/          Express routes (scan, files, system)
  services/     DiskScanner (8-way concurrent walker), Cleaner (trash/open)
  models/       Shared TypeScript interfaces
  utils/        formatBytes, squarified treemap, path sanitizer
  middleware/   errorHandler, rateLimiter, pathGuard
  index.ts      App entrypoint + graceful shutdown
public/
  index.html    The entire frontend (inline CSS + JS, zero dependencies)
```
