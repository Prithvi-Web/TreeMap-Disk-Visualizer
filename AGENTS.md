# TreeMap for agents

TreeMap is a local, privacy-preserving disk-space visualizer (Node 20 + Express).
This file documents how an automated agent should drive it — the workflows and,
above all, the safety model. Machine-readable equivalents:
`GET /api/capabilities` (compact manifest) and `GET /api/openapi.json` (full
OpenAPI 3 spec).

## Two ways in

- **HTTP API** — start the server (`npm start`, default `http://127.0.0.1:4280`)
  and call `/api/*`. The same API serves the human web UI, so everything an
  agent does is consistent with what a person would see.
- **MCP** — `npm run mcp` starts a stdio Model Context Protocol server
  (for Claude Desktop and similar clients) exposing: `scan_path`,
  `get_largest`, `find_duplicates`, `cleanup_suggestions`, `forecast`,
  `compare_scans`, `offload`, `trash_paths`. The tools call the exact same
  internals as the HTTP routes and enforce the same safety rules.

## The core workflow: scan → inspect → dry-run → act

1. **Scan.** `POST /api/scan` with `{ "path": "/absolute/dir" }` → `202 { scanId }`.
   Poll `GET /api/scan/{scanId}/stats` until `status` is `"complete"`
   (or stream `GET /api/scan/{scanId}/progress`, Server-Sent Events).
   Agents can skip the polling: `POST /api/scan?wait=true&waitMs=55000`
   blocks until the scan settles and answers `200` with the stats inline
   (`202 { status: "running" }` if it outlives `waitMs`). Scans live in
   memory for ~30 minutes after completion.
   For the whole picture in one call afterwards:
   `GET /api/agent/summary?scanId=` — top culprits, reclaimable-by-category,
   and the forecast, every number as raw bytes plus a formatted string, in
   deterministic order.
2. **Inspect.** With the `scanId`:
   - `GET /api/large-files` / `GET /api/large-folders` — the big things.
   - `GET /api/cleanup/suggestions` — known-reclaimable space: regenerable
     build dirs (with the command that rebuilds each), tool/browser caches,
     OS junk. Exact byte totals.
   - `GET /api/duplicates` — content-identical groups (background hashing;
     `202` with progress until done).
   - `GET /api/file-types`, `GET /api/empty-folders`, `GET /api/apps`,
     `GET /api/compare`, `GET /api/forecast` — further angles.
3. **Confirm with the user, then act.**
   - `DELETE /api/files` with `{ "paths": [...] }` moves files to the **OS
     Trash** — recoverable, never a hard delete.
   - `POST /api/offload` with `{ scanId, paths, dest }` moves data to another
     drive the safe way: copy → verify SHA-256 → only then trash originals;
     any failure rolls back and leaves local data untouched.

Never skip step 1: destructive endpoints refuse paths that are not inside a
root this server has actually scanned. Scanning is what grants (scoped,
read-what-you-saw) permission to act.

## The safety model (enforced server-side, not advisory)

- **Trash-only deletes.** Every delete is a move to the platform Trash /
  Recycle Bin. The only irreversible operations are explicitly labelled and
  double-gated: `POST /api/trash/empty` and `POST /api/system/snapshots/purge`
  both require `{ "confirm": true }`.
- **The scanned-root rule.** Endpoints that read, open, move or delete a path
  (`DELETE /api/files`, `/api/files/open`, `/api/files/terminal`,
  `/api/files/preview`, `/api/offload`, `/api/git/gc`,
  `/api/container/expand`) demand the path lie inside the root of a scan this
  server performed. Outside → `403 { code: "OUTSIDE_SCAN_ROOT" }`.
- **Path sanitization.** All user-supplied paths are validated: `..` traversal
  is resolved away, null bytes rejected, `~` expanded, and OS-internal
  directories (`/proc`, `/sys`, `C:\Windows\System32`, …) refused outright.
- **Cloud and archive paths.** `cloud://` paths never touch the local
  filesystem — their deletes go to the provider's own trash via
  `POST /api/cloud/trash`. Entries *inside* archives are listings, not files
  (`403 { code: "VIRTUAL_PATH" }`); act on the archive itself.
- **Uniform errors.** Every failure is `{ "error": string, "code": string }`
  with a stable code. Rate limit: 10 req/s sustained per client (bursts to
  20), then `429 { code: "RATE_LIMITED" }`.

## Safety rails for agents: dry runs, policy, audit, idempotency

- **Dry runs.** `DELETE /api/files`, `POST /api/offload` and
  `POST /api/offload/restore` accept `"dryRun": true` and return the **exact
  manifest** — affected paths and bytes — while acting on nothing. A dry run
  passes through every validation a real run would (path guards, policy,
  offload planning), so "dry run succeeded" genuinely means "the real run
  would act". **Always dry-run, show the user, then act.**
- **Policy.** The human can create `agent-policy.json` in the app-data
  directory (`GET /api/policy` shows the resolved policy and the file path):
  ```json
  {
    "allowedRoots": ["/Users/me/Downloads"],
    "protectedPaths": ["/Users/me/Documents/taxes"],
    "maxBytesPerOperation": 10737418240
  }
  ```
  `allowedRoots` confines both scanning and destruction; `protectedPaths` can
  never be trashed/offloaded (nor anything containing them); the byte cap
  refuses any single oversized operation. Violations are
  `403 { code: "POLICY_ROOT_NOT_ALLOWED" | "POLICY_PROTECTED_PATH" |
  "POLICY_BYTES_EXCEEDED" }`. An absent or empty file imposes nothing. The
  policy is deliberately not writable through the API.
- **Audit.** Every destructive request — executed, dry-run, or refused — is
  appended to `audit.jsonl` (timestamp, action, source http/mcp, token id,
  paths, bytes, outcome). `GET /api/audit?limit=100` reads it back, newest
  first. The MCP tools write the same log.
- **Idempotency.** Destructive endpoints honor an `Idempotency-Key` header:
  repeating a successful request with the same key within ~10 minutes replays
  the stored response (`Idempotency-Replayed: true`) instead of executing
  again. Send one on every destructive call you might retry.

## MCP specifics

- `scan_path` returns a `scanId` and waits (bounded) for completion; pass
  `scanId` back to keep waiting on a long scan.
- `trash_paths` and `offload` accept `dryRun: true`, which returns the exact
  manifest — affected paths and bytes — while acting on nothing. **Dry-run
  first, show the user, then act.**
- All sizes come back as raw bytes plus a human-formatted string.

## Server profile: auth, CORS and remote bind

All of this is **opt-in via environment variables; with none of them set the
app behaves exactly as it always has** (localhost bind, no auth, no CORS).

| Variable | Default | Effect when set |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address for `npm start` (e.g. `0.0.0.0` for remote access) |
| `PORT` | `4280` | Listen port |
| `TREEMAP_TOKEN` | unset (no auth) | Every `/api` request must send `Authorization: Bearer <token>`; otherwise `401 { code: "UNAUTHORIZED" }` |
| `TREEMAP_ALLOWED_ORIGINS` | unset (no CORS) | Comma-separated origins allowed to call the API from browsers |
| `TREEMAP_DATA_DIR` | per-OS app-data dir | Where snapshots/settings/manifests persist |

How the human UI keeps working with a token set: serving the UI page also
sets an `HttpOnly`, `SameSite=Strict` session cookie, which same-origin
`fetch()` **and `EventSource`** (which cannot send headers) attach
automatically. The frozen frontend needs no changes.

Threat model, stated plainly: the token gates API access for non-browser
clients, and `SameSite=Strict` + CORS-off blocks cross-site browser attacks —
but anyone who can load the UI page itself gets a session. If you bind beyond
localhost, front the server with a reverse proxy that authenticates page
loads (and adds TLS).

A typical remote profile:

```
HOST=0.0.0.0 PORT=4280 TREEMAP_TOKEN=<long-random-secret> npm start
```

## Operational notes

- Local-first: nothing talks to the network except the optional cloud
  integrations the user explicitly connects.
- The server binds `127.0.0.1` by default. `PORT` and `HOST` env vars change
  that for server deployments.
- Scan results are in-memory (30-minute TTL); snapshots, settings and the
  offload manifest persist in the per-OS app-data directory
  (`TREEMAP_DATA_DIR` overrides — useful for tests and containers).
