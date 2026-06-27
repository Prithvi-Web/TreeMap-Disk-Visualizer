Contributing · MD
# Contributing to TreeMap
 
Thanks for taking the time to contribute! TreeMap is a solo-built, open source project and every bug report, fix, and feature idea makes it better.
 
---
 
## Table of Contents
 
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [How to Contribute](#how-to-contribute)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)
- [Code Style](#code-style)
- [Good First Issues](#good-first-issues)
---
 
## Getting Started
 
**Prerequisites:**
- Node.js 20+
- npm (comes with Node)
- macOS, Windows, or Linux
**Clone and run locally:**
 
```bash
git clone https://github.com/Prithvi-Web/Treemap.git
cd Treemap
npm install
npm run dev       # starts the server with auto-reload
```
 
Then open **http://127.0.0.1:4280** in your browser.
 
To run the desktop (Electron) version locally:
 
```bash
npm run app
```
 
---
 
## Project Structure
 
```
src/
  api/          Express routes (scan, files, system, insights, settings)
  services/     Core logic — DiskScanner, DuplicateFinder, Snapshots,
                CleanupRules, Scheduler, Settings, Storage, DiskUsage
  models/       Shared TypeScript interfaces
  utils/        formatBytes, squarified treemap, path sanitizer, glob matcher
  middleware/   errorHandler, rateLimiter, pathGuard
  index.ts      App entrypoint + graceful shutdown
 
electron/
  main.js       Desktop shell: window, tray, drag-drop, notifications, auto-update
  preload.js    Context-isolated bridge
 
public/
  index.html    Entire frontend — inline CSS + JS, zero external dependencies
 
scripts/
  gen-tray-icon.js  One-time tray icon generator
```
 
> **Frontend note:** The frontend is a single `index.html` with hand-coded Canvas 2D — no React, no D3, no Chart.js. Keep it that way. New UI changes should be vanilla JS/CSS inside that file.
 
---
 
## Development Workflow
 
| Command | What it does |
|---|---|
| `npm run dev` | Start server with auto-reload (development) |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled build |
| `npm run app` | Build + launch desktop app |
| `npm run dist:mac` | Build macOS `.dmg` (run on Mac) |
| `npm run dist:win` | Build Windows installer (run on Windows) |
 
---
 
## How to Contribute
 
### 1. Pick something to work on
 
- Check the [Issues](https://github.com/Prithvi-Web/Treemap/issues) tab for open bugs and feature requests
- Look for issues tagged `good first issue` if you're new
- If you want to work on something not listed, open an issue first so we can discuss it before you invest time
### 2. Create a branch
 
```bash
git checkout -b fix/duplicate-crash
# or
git checkout -b feature/dark-mode-toggle
```
 
Use a short, descriptive name prefixed with `fix/`, `feature/`, or `docs/`.
 
### 3. Make your changes
 
- Keep changes focused — one fix or feature per PR
- If you're touching the backend, make sure existing API endpoints still work
- If you're touching the frontend (`index.html`), test in both browser and desktop modes
- Add comments to non-obvious logic, especially in `services/` and `utils/`
### 4. Test manually
 
TreeMap has no automated test suite yet (contributions welcome!). Before submitting:
 
- [ ] Run `npm run build` with no TypeScript errors
- [ ] Test your specific change end-to-end in the browser (`npm run dev`)
- [ ] If it touches the desktop app, test with `npm run app`
- [ ] Test on the OS your change targets (especially for trash/cleanup — behavior differs by OS)
---
 
## Submitting a Pull Request
 
1. Push your branch and open a PR against `main`
2. Fill in the PR description:
   - **What** changed
   - **Why** (link the issue if there is one)
   - **How to test** it manually
3. Screenshots or a short video are very welcome for UI changes
4. Keep PRs small — a 200-line change gets reviewed faster than a 2,000-line one
PRs are reviewed by the maintainer (@Prithvi-Web). Response time is typically within a few days.
 
---
 
## Reporting Bugs
 
Open an [Issue](https://github.com/Prithvi-Web/Treemap/issues/new) and include:
 
- **OS and version** (e.g. macOS 14.5, Windows 11)
- **TreeMap version** (from the app or the Releases page)
- **What you did** — steps to reproduce
- **What you expected** vs **what actually happened**
- **Any error messages** from the console (open DevTools with `Cmd+Option+I` / `F12`)
> Safety note: never paste real file paths that reveal personal information in bug reports.
 
---
 
## Requesting Features
 
Open an [Issue](https://github.com/Prithvi-Web/Treemap/issues/new) with:
 
- The problem you're trying to solve (not just the solution you have in mind)
- How you'd expect it to work
- Whether you'd be willing to implement it yourself
Features that align with the core goal — **see what's eating your disk, safely clean it up, no tracking** — are most likely to be accepted.
 
---
 
## Code Style
 
- **TypeScript** for all backend code in `src/`
- **No new dependencies** without discussion — the frontend is intentionally zero-dependency, and the backend aims to stay lean
- Use `const` over `let` where possible
- Keep functions small and single-purpose
- Sanitize and validate all file paths — see `src/middleware/pathGuard.ts` for the existing pattern
- All file deletions must go through the OS trash — never `fs.unlink` or `fs.rm`
---
 
## Good First Issues
 
Not sure where to start? These areas are well-contained and beginner-friendly:
 
- **Typos or grammar** in the UI or README
- **`formatBytes` edge cases** — values under 1 KB, very large values
- **Accessibility** — keyboard navigation, ARIA labels in `index.html`
- **Error messages** — make them more descriptive when a scan fails
- **Cross-platform testing** — trying a feature on Windows or Linux and reporting back
---
 
Thanks again for contributing. Even a small fix or a well-written bug report is genuinely helpful. ⭐
