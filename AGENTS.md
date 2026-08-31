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
  `get_largest`, `reclaim_ranked`, `find_duplicates`, `cleanup_suggestions`,
  `forecast`, `missing_gigabytes`, `compare_scans`, `offload`, `trash_paths`.
  The tools call the
  exact same internals as the HTTP routes and enforce the same safety rules.

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
   - `GET /api/media?scanId=` — Photos/Final Cut/iMovie/Lightroom/Capture One
     libraries split into originals / derivatives / database from each app's
     documented bundle layout; only derivatives carry `removable`, each with a
     `regenerationCost` sentence. Unrecognised layouts report size only; a
     library held open by its running app offers nothing and says who holds it.
   - `GET /api/duplicates/detail?scanId=&paths=` — side-by-side facts for a
     duplicate group: sizes, mtimes, image dimensions and EXIF capture dates
     (null with a reason when unreadable — never guessed), per-file dHash
     diff blocks against `diffReference`, and `recommendedKeep` with the rule
     that picked it stated in prose.
   - `GET /api/volumes` — attached external drives with free/total bytes; a
     drive whose stats cannot be read is listed with nulls and a reason.
   - `GET /api/scan/{scanId}/calendar` — bytes and file counts per local day
     (from the scan's own mtimes, exact). `?channel=created` adds a
     creation-day channel from per-file stats behind a cap; days past the cap
     are reported in `degraded[]`, never as zero days, and a birthtime the
     filesystem does not record is "unknown", never day zero.
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
   - `GET /api/missing-gigabytes?scanId=` — **one accounting statement for the
     volume the scan lives on**, and the only endpoint here whose output is an
     arithmetic claim. `{ volume, lines[], unaccountedBytes, coversWholeVolume,
     caveats[] }`. Every line carries `{ id, label, bytes, available, reason?,
     detail, count, notes[], remedy }`, and **the lines sum to
     `volume.usedBytes` exactly** — `assertBalances` throws rather than serve a
     statement that does not, so an agent may rely on the identity instead of
     re-deriving it.

     Two rules decide whether an agent reads this correctly.
     **`bytes: null` means UNKNOWN and always carries a `reason`; `bytes: 0` is
     a measurement.** Flattening them concludes a disk has no snapshots when
     the truth is that nothing would size them. And **whatever the lines do not
     explain is the `unaccounted` line**, which names every unknown line
     sitting inside it — so the residual is attributable rather than mysterious.
     `bytes` is signed: negative on a correction line, and negative on
     `unaccounted` when copy-on-write clones made TreeMap count more than the
     volume holds.

     `coversWholeVolume: false` means the scan started inside the volume rather
     than at it, so everything else on that volume is necessarily in the
     residual; `caveats` says so in words. Read-only, and the `remedy` on a line
     is a *description* of an existing, separately-gated endpoint — never a
     second path to one.

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
     Providers: `size` (the scan's own byte count), `subtreeCount`,
     `lastUsed`, `recoverability`, `reclaimScore` and `humanScale`
     (v4 §9.3 — "≈ N photos like the ones here", averaged from the folder's
     own media, at least ten of a kind, directories only; a walk is capped
     per path and per request, with `capped: true` stated on the value).
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
     **`reclaimScore`** answers "how safe and worthwhile is this to delete?"
     as `{ score: 0-100, components[], confidence, missing[], coverage }`.
     Nothing new is scanned: it composes the scan tree, `lastUsed`,
     `recoverability`, the rule packs, the duplicate finder and the download
     record into six weighted components, each carrying the plain-English
     `why` that produced it.
     **A component that could not be computed is listed in `missing[]` with
     its reason and left out of the score entirely — never counted as zero.**
     That is the whole design, and the reason is an ordering: a file with no
     download record is not *less* redownloadable than one that was
     downloaded, it is unknown, and scoring it zero would rank a file nobody
     can vouch for below one positively known to be worthless. The score is
     renormalised over the weight that actually answered, and `coverage` (the
     share of enabled weight that did) is what `confidence` bands.
     Three kinds of "no answer" are kept apart, because each has a different
     thing a caller could do about it: the mechanism cannot run here (no git,
     no backup system) → missing with the capability's reason; the mechanism
     ran and found nothing (no rule matched, no download record) → a real
     zero; the mechanism has not been asked (duplicate hashing has not run
     for this scan) → missing, because "no duplicate found" is only true once
     something looked. **Reading a score does not start a duplicate hash**,
     and a scan whose duplicate list was truncated at its top 500 groups
     reports absence from that list as unknown rather than as proof.
     Where last-opened dates are unavailable the last-*changed* date stands
     in — stated in the component's own `why` and costing the whole score a
     confidence step, so §1.1's caveat stays load-bearing.
     The weights are user-editable at `PUT /api/settings` under
     `reclaimWeights` (six keys, 0-1 each; send `null` to restore the
     defaults). **A weight of 0 removes that component from the score rather
     than scoring it as worthless**, and changing any weight invalidates the
     cached scores. A path the provider cannot score at all is absent from
     `values`, never present with `score: 0`.
     The score sorts and explains. **No code path anywhere selects, stages or
     deletes on its behalf**, and `reclaim_ranked` carries no field implying
     a choice.
   - `POST /api/query` with `{ scanId, q, limit?, offset?, sort? }` — **the
     query grammar**, and the highest-leverage surface in v4: every hard-coded
     view is a filter over the same tree, so a query is a view, a saved query
     is a Clean Up rule, and a rule is an Autopilot policy — that last rung is
     real, not aspirational: an Autopilot policy can carry
     `match: { kind: 'query', q }`, parsed by this same parser on save and
     resolved by this same evaluator on every run. A query that does not parse
     cannot be saved as a policy, and neither can one with no conditions: it
     would select every file under the policy's folder, unattended. A query
     policy also never trashes a directory — `type:dir` is a fair thing to ask
     a query, and a different blast radius for something running while nobody
     is watching.
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
     `score>70` filters on the reclaim score above. It appears in
     `postFiltered`, because a score genuinely is computed per file after the
     tree is walked, but it is **not** reported degraded: the score is built
     from six signals and states per file which of them answered, so a
     machine with no git and no backup still scores everything on size,
     staleness and regenerability. A file that cannot be scored at all simply
     does not match.
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
   - `POST /api/cart/commit` with `{ paths }` is the same delete **as one
     undoable run**: every item is copied into the Time Capsule and verified
     before anything is trashed, and the response carries a `runId` that
     `POST /api/cart/undo` restores in full — original paths, byte for byte,
     with their original timestamps, even after the Trash has been emptied.
     (Directory times are restored after their contents, so writing the
     children back does not re-stamp the folder.) It is a separate route from
     `DELETE /api/files`
     rather than a flag on it, because the two make different promises and
     `GET /api/capabilities` marks destructive endpoints one by one.
     **The refusal that matters:** anything too large for the capsule to
     protect is **left undeleted** and named in `skipped[]` with its reason —
     never deleted unprotected. `dryRun: true` returns that same verdict per
     path *before* anything happens, along with the older capsule copies that
     would be evicted to make room and B2's open-handle preflight. At most 500
     paths per commit.

Never skip step 1: destructive endpoints refuse paths that are not inside a
root this server has actually scanned. Scanning is what grants (scoped,
read-what-you-saw) permission to act.

## The safety model (enforced server-side, not advisory)

- **Trash-only deletes.** Every delete is a move to the platform Trash /
  Recycle Bin. The only irreversible operations are explicitly labelled and
  double-gated: `POST /api/trash/empty` and `POST /api/system/snapshots/purge`
  both require `{ "confirm": true }`.
- **The scanned-root rule.** Endpoints that read, open, move or delete a path
  (`DELETE /api/files`, `/api/cart/commit`, `/api/files/open`,
  `/api/files/terminal`, `/api/files/preview`, `/api/offload`, `/api/git/gc`,
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

- **Dry runs.** `DELETE /api/files`, `POST /api/cart/commit`,
  `POST /api/offload` and `POST /api/offload/restore` accept `"dryRun": true`
  and return the **exact manifest** — affected paths and bytes — while acting
  on nothing. A dry run
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
- **Audit.** Every destructive request that touches **files** — executed,
  dry-run, or refused — is appended to `audit.jsonl` (timestamp, action,
  source http/mcp, token id, paths, bytes, outcome).
  `GET /api/audit?limit=100` reads it back, newest first. The MCP tools
  write the same log. Config writes differ by consequence: Autopilot policy
  saves and approvals DO audit (a standing instruction to delete is worth a
  log line), while `PUT /api/settings`, `PUT /api/notes` and
  `DELETE /api/notes` — destructive-flagged for their consequences, not
  their mechanics — do not; they move no bytes, and their whole state is
  inspectable in the files they write.
- **Journal.** Significant disk changes noticed by scheduled scans are
  recorded to `journal.jsonl` (capped and rotated) as sentences with the
  structured fields beside them — path, date, signed byte delta, and an
  attribution that is an app name, `"you"` (a deletion made through TreeMap),
  or exactly `"an unidentified process"`, never a guess.
  `GET /api/journal?limit=100` reads it back, newest first; nothing writes it
  over HTTP.
- **Folder notes (v4 §9.5).** `GET /api/notes` lists them; `PUT /api/notes`
  with `{ path, text, suppress? }` creates or updates one;
  `DELETE /api/notes?path=` removes one. Paths are sanitized but — like
  budgets, and unlike file access — not held to the scanned-root rule: a note
  is metadata about a path, touches nothing at it, and must outlive any scan.
  Text is stored and returned **verbatim** (the UI renders it as plain text
  only). The consequential half: a note with `suppress: true` (the default)
  excludes its whole subtree from `GET /api/cleanup/suggestions`, from the
  agent summary, from MCP `cleanup_suggestions`, and from **every Autopilot
  match kind** — and Autopilot lists what it left alone in `skipped`, with
  the note as the stated reason, in previews and run records alike. Both
  mutating routes are in the pinned destructive list because writing or
  deleting a note arms or disarms automation over real files.
- **Budget gauges (v4 §9.4).** `GET /api/scan/{scanId}/budget-gauges` pairs
  each in-scan folder budget with a projected breach date — a NEW endpoint
  because `/budgets` is under byte-identity lock. The projection reuses
  `computeForecast` verbatim with the budget's headroom standing in for free
  space, so its refusals are the disk-full forecast's own: too little
  history, erratic growth and shrinking usage return their reasons instead
  of a date. A series read from shallow snapshot trees says so in `caveat`.
- **Plain-words translation (v4 §9.6).** `POST /api/nl-query { text }`
  translates natural phrasing into the query grammar and **never executes**
  — no hits, no totals; run the returned `q` through `POST /api/query`
  yourself, after showing it. The deterministic phrase table is the whole
  feature and it is entirely offline — tests/nlQuery.test.ts statically
  scans every file under src/services/query/ plus the route itself and
  asserts none contains network code. (An optional local
  Ollama passthrough shipped briefly and was removed at the owner's
  request.)
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
