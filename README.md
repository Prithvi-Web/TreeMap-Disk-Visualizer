# TreeMap 🟩🟨🟥

A GrandPerspective-style **disk space visualizer** for macOS, Linux and Windows.

Scan any folder and see exactly what's eating your disk:

- **Dashboard** — disk usage ring, live scan progress, file-type donut chart, top-10 largest files
- **Treemap** — squarified treemap of every file, sized by bytes, colored teal → amber → red by size; click folders to drill in, right-click to open / copy path / trash
- **Grid** — size-proportional icon grid with multi-select, sorting and virtual scrolling
- **Clean Up** — find files that are old / huge / by extension / duplicated, preview them, and move them to the system **Trash** (never hard-deleted — always recoverable)

Built with Node.js + Express 5 + TypeScript on the backend and a single zero-dependency
`index.html` on the frontend (hand-coded Canvas 2D — no React, no D3, no Chart.js).

## Setup in 3 commands

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
