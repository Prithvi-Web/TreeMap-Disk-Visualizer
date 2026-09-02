# Security policy

## Supported versions

TreeMap supports **the latest 5.x release only**. A fix ships as a new release; older releases receive no fixes, so if you are on anything else, update first.

To find your version: on macOS, **TreeMap → About TreeMap**. Anywhere TreeMap is running — desktop or web mode — open <http://127.0.0.1:4280/api/capabilities> and read `version`.

> One historical note: **v1.2.0 must not be used.** Its macOS build shipped with a broken signature ("TreeMap is damaged and can't be opened"), and the Windows build from the same release was affected too. Every later release is fine — [Releases](https://github.com/Prithvi-Web/TreeMap-Disk-Visualizer/releases).

## Reporting a vulnerability

If you find a security problem in TreeMap — a path-traversal issue, a way to delete or move something outside a scanned folder, a way to read file contents the app promises never to read, anything that could lose data — please **do not open a public issue**.

Report it privately:

**Email:** vinay.gopinath@gmail.com
**Subject line:** `[TreeMap Security] Brief description`

Please include what the problem is, the steps to reproduce it, the TreeMap version, and your OS and version. I aim to respond within 48 hours and will work with you to fix and disclose it responsibly.

## How TreeMap is built to be safe

- **Trash only.** Nothing is ever hard-deleted. Every delete goes to the system Trash (Finder's Trash, the Recycle Bin, `gio trash` on Linux) and can be put back. Automated deletes go through the Time Capsule first — copied, verified, and only then trashed — so a run can be undone even after the Trash is emptied.
- **Scoped operations.** The trash, open, move, offload and relocate endpoints accept only paths inside a folder you explicitly scanned. Nothing inside an archive can be trashed or opened — only the archive itself.
- **Path sanitization.** Every path is normalised, symlinks are resolved, and traversal is refused. System folders are blocked outright — `/proc`, `/sys`, `/dev`, `/run`, `/private/var/db` and `/System/Volumes/VM` on macOS and Linux, and `C:\Windows\System32` and its siblings on Windows — including through aliases and firmlinks.
- **The Security view reads no content.** It matches names and locations only; no file is opened, and no content is stored or shown.
- **No tracking.** No telemetry, no analytics, no crash reporting, no account.
- **An optional API token.** Set `TREEMAP_TOKEN` and every request to the API must carry it (`Authorization: Bearer …`, or the cookie the UI sets for itself). Off by default — the desktop app never exposes its port beyond this machine.
- **An audit log.** Every destructive request — executed, dry-run or refused — is appended to `audit.jsonl`.

## Network

**The API listens on `127.0.0.1` only.** The `HOST` variable overrides it for web mode; the Docker image listens on all interfaces inside its container and, by default, publishes the port only to `127.0.0.1` on the host.

TreeMap makes outbound connections in exactly three situations, each named here so none is a surprise:

1. **The update check.** The packaged desktop app asks GitHub Releases whether a newer version exists, at launch and every 6 hours. On macOS that is a check only: a **Download Update** dialog opens the Releases page, and the app downloads and installs nothing itself. On Windows the update is downloaded and installed when you next quit, after asking. The check sends nothing about you or your disk; it fetches a small `latest*.yml` file. There is no setting to turn it off in the desktop app; web mode (`npm start`) and the Docker image make no update check at all.
2. **Cloud accounts** (opt-in). Connect Google Drive, Dropbox or OneDrive and TreeMap talks to that provider — metadata only, never file contents. Tokens live in `cloud-tokens.json` in the app-data folder, and Disconnect wipes them. With no account connected, no cloud code runs.
3. **Fleet** (opt-in, off by default). Turn it on and TreeMap announces itself over multicast DNS (`224.0.0.251`) and serves an eleven-field summary — machine name, OS, volume totals, the last scanned folder — on a separate listener bound to your private LAN addresses only, never `0.0.0.0`. File trees, Security findings and download origins never cross the network, and there is no remote-delete route. Pairing is a six-digit code that lasts three minutes and pairs one machine; a machine that offers five wrong codes is refused outright, and fifty wrong codes in all withdraw the offer and raise a warning in the Fleet panel.

Nothing else. The natural-language search, the cloud-cost table and the cleanup rule packs are built in and work offline.

## What is written to disk

Scan results themselves are memory only: a scan expires 30 minutes after it settles. What reaches disk lives in the app-data folder — `~/Library/Application Support/TreeMap` on macOS, `%APPDATA%\TreeMap` on Windows, `~/.config/treemap` on Linux (`TREEMAP_DATA_DIR` overrides it) — and never leaves the machine:

| File | What it holds |
|---|---|
| `settings.json` | Settings, schedules, the ignore list, folder budgets, Reclaim weights |
| `snapshots.json` (plus one small file per scanned root) | Scan history — totals and top-level entries — and the shallow trees behind the time slider |
| `index.db` | The SQLite live index behind global search: names, sizes, dates and extensions, never file contents |
| `timecapsule` (a folder) and `timecapsule.json` | Full copies of files an automated delete removed, so a run can be undone. Capped at 10% of the disk by default, kept 30 days by default, oldest evicted first; both numbers are in Settings |
| `offload-manifest.json` | The catalog of what was offloaded where |
| `journal.jsonl` | The History journal — what grew and shrank, day by day |
| `audit.jsonl` | Every destructive request: executed, dry-run or refused |
| `notes.json` | Notes pinned to folders |
| `autopilot.json` | Autopilot policies and their run history |
| `fleet.json` | Fleet settings and paired machines |
| `cloud-tokens.json` | OAuth tokens for connected cloud accounts |
| `agent-policy.json` | The agent policy you write yourself — allowed roots, protected paths, byte caps. TreeMap reads it and never writes it |

Thumbnails for the near-duplicate strip are held in memory only. A portable build keeps all of the above beside the executable, and on a read-only medium keeps everything in memory and says so.

## Rate limiting

The local API is token-bucket rate limited per client IP, in three lanes chosen by what a request costs the server, never by who is asking:

- `api` — 10 requests a second, bursts of 20: everything that walks a tree, spawns a process or touches files.
- `preview` — 150 a second, bursts of 300: thumbnails only.
- `meta` — 60 a second, bursts of 120: cheap read-only metadata that is already in memory.

An empty bucket answers `429`.
