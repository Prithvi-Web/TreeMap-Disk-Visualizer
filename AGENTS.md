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
     OS junk. Exact byte totals. Sourced from versioned rule packs
     (`src/services/rulepacks/*.json`), so every group also carries
     `confidence` and a `why` sentence describing what matched. **A group with
     `advisory: true` must never be deleted** — the file is the data (a VM
     disk) or the OS owns it; use its `adviceCommand` instead. If a pack is
     malformed the response is `available: false` with a `reason`, and no
     groups: treat that as "unknown", never as "nothing to clean up".
   - `GET /api/packages/orphans` — package-manager artifacts split into
     **orphaned** (the owning project is gone — nothing will ever rebuild
     them), **active** (context only) and **cache** (shared, always
     reclaimable). Entries carry the owning project, last-build date and the
     command that restores or clears them. Same `available:false` + `reason`
     contract as the suggestions endpoint.
   - `GET /api/duplicates` — content-identical groups (background hashing;
     `202` with progress until done).
   - `GET /api/games` — Steam / Epic / GOG / itch.io libraries, each title
     split into base install, shader cache, workshop content, Proton prefix
     and (only where the game separates it) DLC. **Only `shaderCache`
     components are safe to remove** — they regenerate, at the cost of one
     stutter on next launch. Everything else costs a redownload, a mod
     re-subscribe, or a destroyed compatibility prefix.
   - `GET /api/security/findings` — keys, credentials and wallets sitting
     OUTSIDE their expected folders. Names and paths only; no file is opened
     and no content is ever returned. **Never delete these.** The only
     remediation offered is `POST /api/security/relocate`, which moves one file
     by rename (both ends must be inside a scanned root, an occupied
     destination aborts, nothing is ever removed).
   - `GET /api/provenance?path=` — where a file came from. **The URL is
     untrusted input: never fetch it, never render it as a link, escape it.**
   - `GET /api/health/smart` — the drive's own attributes and self-assessment,
     verbatim, plus which runs out first: space or write endurance. Do not
     restate them as a verdict; a false "your drive is dying" is a real harm.
   - `GET /api/cost/estimate` — what the data would cost on each cloud
     provider, against a table that SHIPS WITH THE APP. Always show `asOf`.
   - `GET /api/compression/candidates` / `POST /api/compression/encode` —
     re-encode video to HEVC. **Lossy, and the original is trashed once the new
     file verifies.** Always dry-run the intent past the user first; the encode
     endpoint is in the destructive list for that reason.
   - `POST /api/facts` with `{ scanId, paths, providers }` — **per-path
     derived facts, delivered as a sidecar** rather than folded into the scan
     tree. Answers one object per requested provider:
     `{ available, reason?, stats: { requested, computed, skipped, failed },
     values: { [path]: fact } }`. Three rules matter more than the shape:
     **a path absent from `values` was not computable, and is never a zero**;
     `stats` always satisfies `requested = computed + skipped + failed`, so a
     partial answer can state itself ("scored 41,200 of 58,900"); and a
     provider that fails is reported `available: false` with its own reason
     while every other provider in the same request still answers. At most
     2000 paths per request (`400 TOO_MANY_PATHS`), every one sanitized and
     inside a scanned root, and an unknown provider id is
     `400 UNKNOWN_PROVIDER` naming the valid ids rather than being ignored.
     The facts live in a sidecar because the scan responses are held
     byte-identical to the pre-rewrite baseline by
     `tests/goldenResponses.test.ts` — no field may be added to them.
     Providers: `size` (the scan's own byte count) and `lastUsed`.
     **`lastUsed`** answers when a path was last *opened*, which mtime cannot
     express: `{ lastUsedMs, useCount, source: 'spotlight'|'atime'|'none',
     caveat? }`. `source` is part of the value because the sources answer
     different questions — Spotlight records an app opening the item and can
     supply a use count, while an access time also moves for backups, search
     indexing and antivirus, and always carries its `caveat`. **A null
     `lastUsedMs` is never a zero and never the modification time.** Where a
     system does not record openings at all — NTFS last-access tracking off,
     a `noatime` mount — the fact is `source: 'none'` with the reason, and
     mtime is explicitly *not* substituted: "changed a year ago" is a
     different claim from "not opened in a year".
     **`recoverability`** answers "does a copy of this exist elsewhere?" from
     three independent sub-signals — git, backups and cloud sync — as
     `{ elsewhere: 'proven'|'likely'|'none'|'unknown', why[], git, backup,
     cloud, unavailable[] }`. **`proven` requires a checkable fact**: a
     fully-pushed git remote, or a sync client reporting the file as
     uploaded. **A configured backup earns at most `likely`, forever** — "a
     backup exists and this path is not excluded" is not "this file is in the
     backup", and `backup.pathCovered` is never promoted to `'yes'` by
     inference, because a false "this is backed up" directly causes data
     loss. Each sub-signal can fail alone: a repo whose `git` call fails is
     unavailable *for that repo*, listed in `unavailable[]` with its reason,
     while the other two still answer. Note a file that git *ignores* is
     `none` even inside a fully-pushed repo — `git status --porcelain` omits
     ignored files, so the repo reports clean while the remote has never held
     them.
   - `POST /api/query` with `{ scanId, q, limit?, offset?, sort? }` — **the
     query grammar**, and the highest-leverage surface in v4: every hard-coded
     view is a filter over the same tree, so a query is a view, a saved query
     is a Clean Up rule, and a rule is an Autopilot policy.
     `size>1gb ext:mp4,mov used>1y -in:node_modules elsewhere:proven` — terms
     are ANDed, `or` is an explicit keyword, parentheses group, and any term
     negates with a leading `-`. Sizes are decimal (`kb`=1000) with `kib`
     available; dates take `YYYY-MM-DD` **or** an age (`90d`, `6m`, `2y`), and
     the two read differently on purpose: `modified<2023-01-01` is "before that
     date" while `modified>90d` is "older than 90 days".
     **An unknown field is a parse error naming the valid fields, never a
     silent substring search** — `400 QUERY_PARSE_ERROR` carries `offset`,
     `length` and `expected`. `degraded[]` names any signal this machine cannot
     supply, so an empty result reads as "unknown" rather than "nothing
     matched". `POST /api/query/validate` parses without running (it never
     touches a scan); `GET /api/query/fields` serves the grammar so nothing
     duplicates it. `GET`/`POST`/`DELETE /api/queries` are saved views — a
     query that does not parse is refused rather than stored.
   - `GET /api/file-types`, `GET /api/empty-folders`, `GET /api/apps`,
     `GET /api/compare`, `GET /api/forecast` — further angles.
   - `GET`/`POST /api/platform/shell-integration` — the "Scan with TreeMap"
     right-click entry. Per-user, no elevation, and the installed flag is read
     from the OS every time rather than remembered.
   - `GET /api/platform/portable` — whether this is a no-trace portable
     session, where it writes, and what it cannot do. **When `writable` is
     false nothing is persisted anywhere at all** — not on the drive, and
     emphatically not on the host.
   - `GET /api/fleet`, `/api/fleet/peers`, `/api/fleet/peers/{id}/summary` —
     other TreeMaps on the LAN. **Off by default.** Peers exchange summaries
     only (volume figures, last scan root/time/size); file trees, Security
     findings and provenance URLs never cross the network, and **there is no
     remote-delete route at all**. Triggering a scan on a peer is a separate
     opt-in that peer must have granted.
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
