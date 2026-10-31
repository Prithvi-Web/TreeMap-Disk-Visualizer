# TreeMap HTTP API

Start the server (`npm start`, web mode answers at `http://127.0.0.1:4280`) and call `/api/*`. The same API serves the web UI. The machine-readable spec is at `/api/openapi.json`, a compact manifest at `/api/capabilities`, and [AGENTS.md](../AGENTS.md) is the full guide for automated agents.

| Endpoint | Description |
|---|---|
| `POST /api/scan` | Start scanning a folder → `{ scanId }` |
| `GET /api/scan/:id/progress` | Live scan progress (Server-Sent Events) |
| `POST /api/scan/:id/cancel` | Stop a running scan: a native walk is cancelled, the walker halts, a gdu subprocess is killed; `cancelled: false` means it had already finished |
| `POST /api/scan/:id/pause` · `…/resume` | Pause and resume a running scan; one whose engine cannot pause says why |
| `GET /api/scan/:id/result` | Full file tree (202 while running) |
| `GET /api/scan/:id/treemap` | Pre-computed squarified treemap layout |
| `GET /api/scan/:id/stats` | Scan counters incl. engine and why it was chosen (`engineReason`, `fallbackReason`), the budget it ran under, duration & fast-rescan cache usage |
| `GET /api/scan/:id/budgets` | Saved folder budgets cross-referenced against this scan |
| `GET /api/scan/:id/export?format=csv\|pdf` | Download the scan as CSV (files / folders) or a PDF report |
| `GET /api/missing-gigabytes?scanId=` | The accounting statement for the volume: the lines sum to used space exactly, and the residual is its own `unaccounted` line. A line that could not be measured reports `bytes: null` with a reason, never `0` |
| `GET /api/scans` | Completed scans currently in memory, except a dry run's: the scan an Autopilot Preview or a preview-only policy run makes is held but not listed |
| `POST /api/facts` | Per-path derived facts as a sidecar (`size`, `lastUsed`, `recoverability`, `reclaimScore`). A path absent from `values` was **not computable**, never a zero |
| `GET /api/large-files?scanId=` | Top N largest files |
| `GET /api/large-folders?scanId=` | Top N largest folders (recursive sizes) |
| `GET /api/file-types?scanId=` | Size breakdown by extension |
| `GET /api/apps?scanId=` | Per-app storage attribution: totals, app / cache / data / logs breakdown, safe-to-clear bytes |
| `GET /api/duplicates?scanId=` | Duplicate groups (starts hashing; poll until complete); `notHashed` counts the online-only files it left unread |
| `GET /api/near-duplicates?scanId=&threshold=` | Perceptual (dHash) near-duplicate image clusters |
| `GET /api/empty-folders?scanId=` | Recursively empty folders (`ignoreJunk` configurable) |
| `GET /api/compare?scanIdA=&scanIdB=` | File-level diff of two scans of the same root |
| `GET /api/snapshots` | Scan history: roots, per-root snapshots (`?path=`), or all (`?all=true`) |
| `GET /api/snapshots/compare?a=&b=` | Top-level deltas between two snapshots |
| `GET /api/snapshots/tree?path=&at=` | Historical treemap closest to a timestamp (time slider), with grew/shrank data |
| `GET /api/forecast?path=` | Disk-full projection: days until full, confidence, top growers, honest when history is thin |
| `GET /api/watch/:scanId` | Live disk activity (Server-Sent Events): per-second batches of `{ path, delta, kind }` |
| `POST /api/container/expand` | List a container's contents (zip/jar/tar/tgz/iso/docker) as virtual treemap children, never extracts |
| `POST /api/offload` · `GET /api/offload/:id/progress` | Copy → SHA-256 verify → trash originals, to another drive (SSE progress, cancellable with rollback) |
| `GET /api/offload/index` · `POST /api/offload/restore` | Searchable offload catalog (mount-aware) and verified restore |
| `GET /api/cloud/status` · `POST /api/cloud/connect` · `…/disconnect` | Cloud accounts: local-only status, PKCE OAuth (loopback + paste fallback), token wipe |
| `POST /api/cloud/scan` · `POST /api/cloud/trash` | Metadata-only cloud scan (registers like a disk scan) and provider-trash deletes, the documented pathGuard exemption |
| `GET /api/cleanup/suggestions?scanId=` | Smart cleanup suggestions (regenerable / cache / junk) |
| `GET /api/packages/orphans?scanId=` | Package-manager leftovers: orphaned / active / shared cache |
| `GET /api/games?scanId=` | Game libraries per title: base, shader cache, workshop, Proton prefix, DLC |
| `GET /api/security/findings?scanId=` | Keys and credentials sitting outside their expected folders |
| `GET /api/provenance?path=` | Where a file came from, and when it was last opened |
| `GET /api/health/smart?device=` | Drive SMART attributes next to the growth forecast |
| `GET /api/cost/estimate?scanId=` | What the data would cost to keep on each cloud provider |
| `GET /api/compression/candidates?scanId=` | Video worth re-encoding to HEVC, with estimated savings |
| `GET /api/platform/shell-integration` | The "Scan with TreeMap" right-click entry (add / remove) |
| `GET /api/platform/portable` | Whether this is a no-trace portable session |
| `GET /api/fleet` | Other TreeMaps on your network, off by default, summaries only |
| `GET /api/cleanup/browser-profiles?scanId=` | Per-browser-profile cache breakdown |
| `GET /api/git/repos?scanId=` · `POST /api/git/gc` | Git pack/loose/LFS breakdown, and `git gc` a scanned repo |
| `GET /api/system/snapshots` · `POST …/purge` | OS snapshot accounting (APFS / Btrfs / VSS) |
| `GET /api/system/snapshots/find-deleted?path=` | Which filesystem snapshots could still hold a lost path, needs no privileges |
| `POST /api/system/snapshots/restore` | Recover it, written beside the original (asks for admin on macOS/Windows) |
| `GET /api/autopilot/policies` · `PUT …` | Standing cleanup policies (re-validated on save; editing a policy's scope revokes its approval) |
| `POST /api/autopilot/simulate` | Exactly what a policy would delete, writes nothing, touches no schedule |
| `POST /api/autopilot/policies/:id/approve` | Approve a policy's mandatory first preview so it runs on its own; it deletes only while it is enabled and not set to "Only ever preview" |
| `GET /api/autopilot/runs` · `POST …/runs/:id/undo` | Run history, and a verified one-click undo from the Undo Vault |
| `GET /api/timecapsule` | The Undo Vault: what the Clean Up cart and Autopilot copied aside before trashing it, with capacity + history |
| `POST /api/timecapsule/:id/restore` · `DELETE /api/timecapsule/:id` | Verified restore to the original path (202 + SSE job), or forget one copy |
| `GET /api/timecapsule/jobs/:jobId/progress` | Restore progress (Server-Sent Events), cancellable |
| `GET /api/settings` · `PUT /api/settings` | Ignore list, scheduled scans, folder budgets, the Scan engine and the scanning budget |
| `GET /api/engine/budget` · `PUT …` | The scanning budget (Automatic / Eco / Balanced / Turbo, optional CPU %) and what is in force now |
| `GET /api/engine/capabilities` | Whether the native core loaded, and which of its mechanisms this machine uses |
| `GET /api/notifications` | Growth alerts from scheduled scans |
| `GET /api/system` · `GET /api/trash/size` | Disk totals & platform; system Trash size |
| `GET /api/fs/list?path=` | Folder browser (powers the path picker) |
| `GET /api/files/preview?path=` | Quick-look preview (image / text / thumbnail) |
| `DELETE /api/files` | Move files to the system trash |
| `POST /api/files/open` | Open / reveal a path in Finder & co. |
