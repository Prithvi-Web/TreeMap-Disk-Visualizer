# TreeMap for agents

TreeMap is a local, privacy-preserving disk-space visualizer (Node 20 + Express;
the desktop app is Electron, and scanning uses an optional Rust native module).
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
   Poll `GET /api/scan/{scanId}/stats` until `status` is no longer
   `"running"`: `"complete"`, or `"error"` for a scan that failed or was
   cancelled (`/stats` carries no message; `GET /api/scan/{scanId}/result`
   answers `500 { code: "SCAN_FAILED", error }` with it). Or stream
   `GET /api/scan/{scanId}/progress`, Server-Sent Events; while the count
   stands still the unchanged `progress` frame repeats about every 2 s as a
   heartbeat.
   Agents can skip the polling: `POST /api/scan?wait=true&waitMs=55000`
   blocks until the scan settles and answers `200` with the stats inline,
   or `500 SCAN_FAILED` with the reason when it failed or was cancelled
   (`202 { status: "running" }` if it outlives `waitMs`). Scans live in
   memory for ~30 minutes after completion. Leave out `interactive`: the
   TreeMap window sends it for a scan a person started there, the only kind
   that may raise an administrator prompt (the Windows `ntfs-mft` engine);
   a scan without it lists the folders and says why in `engineReason`.
   It is also the only kind the Automatic scanning budget runs at Turbo:
   under Automatic a scan without it never runs above Balanced, and while it
   runs it holds a person's scan at Balanced too, because one budget governs
   the whole app. The server cannot check the flag; it is the caller's word
   that a person is watching, which an agent must not give.
   `incremental: true` asks for a fast rescan, which only the built-in walker
   does (it reuses the last scan's listings of unchanged folders): where the
   native engine walks the folder the request is not used, and `engineReason`
   says so. The answer's `incremental` says whether saved listings were
   reused.
   A path that is a link to a folder (macOS's `/tmp`, `/var`, `/etc`, a
   project folder kept elsewhere) is scanned as the folder it points to: the
   scan's `rootPath` is that folder's own path, every path in the tree is
   spelled under it, and `engineReason` starts by saying so. Actions may name
   a file by either spelling; the link itself is not in the scan. Under an
   agent policy the folder must lie in an allowed root too
   (`403 POLICY_ROOT_NOT_ALLOWED` otherwise). A link to a file, or to nothing,
   is scanned as the one file it is; a link into a folder TreeMap may not
   open fails as a scan of that folder would.
   For the whole picture in one call afterwards:
   `GET /api/agent/summary?scanId=` — top culprits, reclaimable-by-category,
   and the forecast, every number as raw bytes plus a formatted string, in
   deterministic order.
   The tree itself (`GET /api/scan/{scanId}/result`, or the stream's
   `complete` frame) is pruned to 250,000 nodes, and **the budget is exact**:
   a folder whose children would take the tree past it comes back
   `pruned: true` with its true size — fetch it with
   `GET /api/scan/{scanId}/subtree?path=` — except the scanned folder's own
   children, which always come. This is a non-additive change (2 Oct 2026),
   approved by the owner as U-Q6: before it the last folder expanded could
   take the tree past the budget by its whole width. A tree that fitted the
   budget is byte for byte what it was.
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
   - `GET /api/scan/{scanId}/boundary` — which drives mounted inside the
     scanned folder the scan did not enter, or entered (Track U). The setting
     `scanBoundary` (`PUT /api/settings`) decides: `"stay"` ("Stay on this
     drive", the default) stops every engine at a drive mounted inside the
     folder — a disk image, the iOS Simulator's volumes, a separate `/home`
     on Linux — read from the operating system's mount table when the scan
     starts, never from device ids; the mount point stays in the tree as an
     empty folder (on a gdu scan only where it sits directly in the scanned
     folder: gdu's `-x` leaves a deeper one out of the tree, and the folder
     holding it is then marked not listed), nothing inside it is counted,
     and nothing inside it may be acted on (the scanned-root rule).
     `"cross"` ("Include drives mounted inside it") walks into them. Unknown
     is `null` with a `reason`, never an
     empty list; `entered.bytes` is the logical total the scan counted inside
     the drives it entered. Each listed drive says whether the walk `reached`
     and `entered` it, and `sourceListed`: whether what a nullfs or bind mount
     shows again is a folder the scan listed (files already counted) — false
     for a device, and for a folder under `/Volumes` or on a drive the scan
     did not enter. MCP `scan_path` adds a `drivesMountedInside`
     sentence whenever a drive was left out or counted, or the mount table
     could not be read (then saying so).
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
     `202` with progress until done: `phase` says which pass `hashed`/`toHash`
     count — `partial` reads the first 64 KiB of every same-size candidate,
     `full` then reads whole only the files that still match, counting again
     from zero).
   - `GET /api/games` — Steam / Epic / GOG / itch.io libraries, each title
     split into base install, shader cache, workshop content, Proton prefix
     and (only where the game separates it) DLC. **Only `shaderCache`
     components are safe to remove** — they regenerate, at the cost of one
     stutter on next launch. Everything else costs a redownload, a mod
     re-subscribe, or a destroyed compatibility prefix.
   - `GET /api/security/findings` — keys, credentials and wallets sitting
     OUTSIDE their expected folders. Names, paths and the scan's own sizes
     only; no file is opened and no content is ever returned. **Never delete
     these.** The only remediation offered is `POST /api/security/relocate`,
     which moves one file by rename (both ends must be inside a scanned root,
     an occupied destination aborts, nothing is ever removed), and only an SSH
     key carries a `suggestedPath` (`~/.ssh`). A `.key` file is listed as
     minor with no move, because on a Mac it is usually a Keynote document;
     files inside program bundles, frameworks and the operating system's own
     folders are `appOwned`, minor, and never offered a move. `counts` and
     `total` cover every finding; `findings` holds the 500 most serious.
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
     inside a scanned root (a path there that no scan listed — a drive a scan
     did not enter, a folder no walk descends into — is `skipped` for every
     provider rather than refusing the batch, and so is a path the sanitizer
     refuses only for where it leads — onto the blocklist or through a second
     name, such as a link the scan listed as itself to `/dev`, `/.vol` or
     `/.resolve` — while a path refused by its own spelling still refuses the
     batch, as either kind does on every route that acts on paths; a path
     beneath such a link, which no scan lists, lies under no scanned root,
     `403 OUTSIDE_SCAN_ROOT`), and an unknown provider id is
     `400 UNKNOWN_PROVIDER` naming the valid ids rather than being ignored.
     The facts live in a sidecar because the scan responses are held
     byte-identical to the pre-rewrite baseline by
     `tests/goldenResponses.test.ts` (for a tree within the first frame's
     node budget, step 1) — no field may be added to them.
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
     them. **Git is asked nothing about a repository before it is vetted**
     (see *Git runs hardened* below): a repository whose settings could start
     a program, or whose git data sits outside every scanned folder, is
     unavailable for that repo with the reason, and so is a clean repository
     holding a submodule, which TreeMap does not look inside.
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
     would select every file under the policy's folder, unattended. Nor can
     one that uses a field this build cannot answer at all — `dupe:` today,
     refused with `400 POLICY_QUERY_UNANSWERABLE` naming the policy and the
     field — because that term is unknown for every file and the policy would
     never do what its text says. (One an earlier build saved is not refused
     while it stays unchanged: it selects nothing, and refusing it would block
     every save of the list it rides in.) A query
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
     matched". A term whose signal is missing is **unknown, not false**, and
     stays unknown through `-`, `or` and parentheses (Kleene logic): only a
     definite match is returned, so `-dupe:yes` matches nothing rather than
     everything, and an unknown can shrink a result but never grow one —
     `degraded` then counts the files left undecided (`undecided`), so "could
     not tell" never reads as "did not match". `total` counts every match in
     the scan — except for a query that needs a fact looked up, or a creation
     date read, file by file: that one examines at most the first 20,000
     possible matches the walk meets, and when it stops there `degraded`
     carries `capped` and `total` is a floor, not the count. `used:never` is the case to
     know: no reader records that a file was never opened — a missing
     last-opened date means openings are not recorded there — so it matches
     no file, says so in `degraded`, and is refused in a policy where it
     would have to be true (`-used:never`, "has a last-opened date", is
     answered — though alone it is no condition, nearly every file having a
     date, and a policy of it alone is refused as `POLICY_MATCH_EMPTY`).
     `empty:` reads the scan's tree, and decides only what the scan can
     vouch for: a folder with a listed child is not empty; one with none is
     unknown when the scan did not list it in full, and on a gdu scan, or a
     native one that counted entries or folders it could not read without
     naming them, every such folder is unknown — `degraded` says why
     (`emptyUnproven`) beside `undecided`. It reads no disk: trash its hits
     with `onlyEmptyFolders: true`, which looks at each folder again first.
     `POST /api/query/validate` parses without running (it never
     touches a scan); `GET /api/query/fields` serves the grammar so nothing
     duplicates it. `GET`/`POST /api/queries` and `DELETE /api/queries/{id}`
     are saved views — a query that does not parse is refused rather than
     stored.
     `score>70` filters on the reclaim score above. It appears in
     `postFiltered`, because a score genuinely is computed per file after the
     tree is walked, but it is **not** reported degraded: the score is built
     from six signals and states per file which of them answered, so a
     machine with no git and no backup still scores everything on size,
     staleness and regenerability. A file that cannot be scored at all simply
     does not match.
   - `GET /api/empty-folders` — the topmost empty folders. **Never a folder
     the scan did not list in full**: one it was refused, could not read, saw
     vanish, never entered (`/Volumes`, `/dev`, …), or listed with entries left
     out (a "don't scan" pattern, a failed stat) is not empty, and neither is
     any folder above it. Each folder offered was also looked at again on disk
     just now; one that holds something, refuses or does not answer is left
     out and counted in `withheld`, and `withheldBy` counts them by reason
     (`content`, `unreadable`, `no-answer`, `out-of-time`, `too-many`,
     `not-a-folder`, `gone`). A folder that does not answer is not
     asked again until its call answers, and the root of the drive it is on
     is asked: a drive whose root does not answer either is asked once, and
     until the root answers every folder on it is withheld unasked — in later
     requests and in an `onlyEmptyFolders` delete too — while on a drive that
     answers only the slow folder is withheld. Each call holds a thread of the
     server's I/O pool while it runs, so a drive has at most two calls out at
     once, and a folder one; a further call waits its turn. With two slow
     folders' calls out unanswered the drive is asked nothing more until one
     answers, even though its root answers (its root is asked beside them, by
     one probe at a time), and while one is out its folders are looked at
     one at a time. A call that fails with the
     drive's own error (EIO, ESTALE, …) keeps its silence a minute; any other
     answer lifts it. The looks of one request stop after 10 s; a call
     those 10 s cut short is still given the rest of its 2 s, and only one
     that misses its whole 2 s counts as not answering — a request waiting
     on it meanwhile waits, within its own 10 s. A gdu scan offers none and says why in
     `reason` (gdu shows a folder it could not read as an empty one). To trash
     what it offers, send `onlyEmptyFolders: true` (below).
   - `GET /api/file-types`, `GET /api/apps`,
     `GET /api/compare`, `GET /api/forecast` — further angles.
   - `GET`/`POST /api/platform/shell-integration` — the "Scan with TreeMap"
     right-click entry. Per-user, no elevation, and the installed flag is read
     from the OS every time rather than remembered.
   - `GET /api/platform/portable` — whether this is a no-trace portable
     session, where it writes, and what it cannot do. **When `writable` is
     false nothing is persisted anywhere at all** — not on the drive, and
     emphatically not on the host. A `TreeMap-Data` folder beside the app
     that is a link, or holds a link, a hard-linked file or anything but a
     plain file or folder at its top level, is not used — someone else may
     have prepared the drive, and every writer uses fixed names there:
     `writable: false`, with the reason naming it (`writable: false` says
     nothing is saved, not that the drive is read-only; `reason` says why).
   - `GET /api/fleet`, `/api/fleet/peers`, `/api/fleet/peers/{id}/summary` —
     other TreeMaps on the LAN. **Off by default.** Peers exchange summaries
     only (volume figures, last scan root/time/size); file trees, Security
     findings and provenance URLs never cross the network, and **there is no
     remote-delete route at all**. Triggering a scan on a peer is a separate
     opt-in that peer must have granted, and the peer judges the folder by its
     own rules first: its sanitizer (`400 PATH_BLOCKED` / `PATH_INVALID`, in
     words for the asker — never the path as resolved there, `~` expanded) and
     its own `agent-policy.json` `allowedRoots` (`403 POLICY_ROOT_NOT_ALLOWED`),
     as for a scan asked for there — and on Windows only a folder on one of its
     drives: a network share (`\\server\share`) is refused `400 PATH_BLOCKED`
     before anything looks at it, so no peer can make it sign in to a server.
   - `GET /api/engine/budget` — the scanning budget: the setting
     (`auto|eco|balanced|turbo`, optional `cpuPercent`), what it resolves to
     now (`effective`), and who holds it (`source`: the native governor, or the
     Node shim when the native module is absent). Automatic is Balanced, a step
     lower on battery and Eco under serious heat — and Turbo while a scan sent
     with `interactive` runs (step 1). `PUT /api/engine/budget` changes it
     (`400 BAD_SETTING`). `POST /api/scan/{scanId}/pause` and `/resume` act on
     a running scan; an engine that cannot pause answers `paused: false` with
     the reason. `/stats.engine` names the engine that ran — `native`,
     `gdu-turbo`, `walker`/`turbo-walker`, `ntfs-mft`, or `cloud` for a
     connected cloud account — and `engineReason`
     says why; `fallbackReason` names what was wanted and could not run (a
     missing or refused native module, a walk that failed, a missing gdu). The
     native module is an accelerator: when it is missing or the wrong version,
     `GET /api/engine/capabilities` says why and the legacy engines scan.
   - `GET /api/index/status[?path=]`, `POST /api/index/build { path,
     maxEntries? }`, `GET /api/index/{jobId}/progress|result`,
     `GET /api/index/tree`, `GET /api/search` — the persistent index that opens
     a folder instantly and searches it. The status carries
     `autoBuild: { maxEntries }` (1,000,000): the most items a folder may hold
     for TreeMap to index it on its own after a scan. `maxEntries` must be a
     positive whole number (`400 MAX_ENTRIES_INVALID`); past it the build
     stops, the saved index is left as it was, the stop is remembered
     (`stoppedAtCap` on `status?path=`), and `/result` answers
     `409 INDEX_CAP_REACHED` — nothing failed. A folder that is gone, or that
     TreeMap may not list, is refused with a sentence before anything is
     written, and its saved index is kept (`/result` answers
     `500 INDEX_BUILD_FAILED` with that sentence). A path that is a link is
     indexed as the link itself, one file: no walk follows a link. (A scan of
     a link to a folder is of that folder, so build from the scan's
     `rootPath`, as the TreeMap window does.) A build without `maxEntries` replaces the folder's saved
     index at its start, so one that is cancelled or fails leaves the folder
     with no index; only a capped build keeps the saved one until it is
     swapped in. A build honours the "Stay on this drive" setting as a scan
     does: under `stay` it leaves out every drive mounted inside the folder
     (composed from the folder and the setting — no scan needed), and the
     index's live watcher drops changes there. The index progress stream keeps
     itself alive with an SSE comment; only the scan stream repeats its frame.
3. **Confirm with the user, then act.**
   - `DELETE /api/files` with `{ "paths": [...] }` moves files to the **OS
     Trash** — recoverable, never a hard delete. With `onlyEmptyFolders: true`
     each path is looked at again right before its own Trash step, and one
     that cannot be shown still an empty folder is left where it is, in
     `failed[]` with `refused: true` and a code saying why:
     `FOLDER_NOT_EMPTY` (it holds something), `FOLDER_UNREADABLE`,
     `FOLDER_NO_ANSWER` (it or its drive did not answer, or its drive
     still held two calls that had not answered, so it was not asked — its
     `reason` says which), `FOLDER_NOT_CHECKED`
     (the 10 s TreeMap gives to looking ran out first),
     `FOLDER_TOO_MANY_ENTRIES`, `NOT_A_FOLDER`; a dry run lists those in
     `notEmpty`. `ignoreJunk` (with it only; true when left out) is the
     junk rule the list was made with — off, a folder holding `.DS_Store` is
     not empty.
   - `POST /api/offload` with `{ scanId, paths, dest }` moves data to another
     drive the safe way: copy → verify SHA-256 → only then trash originals;
     any failure rolls back and leaves local data untouched. The record
     Restore reads (`offload-manifest.json`, app-data) is saved first; the
     drive's own copy of it is written after, one write of each drive's
     record at a time, and a drive that does not answer for 60 seconds is
     left to finish on its own while the job says so (the next write of that
     drive's record waits its turn, counted in its own 60 seconds). Within a
     process one save of the app-data record runs at a time; the MCP
     server is a second process with no share in that lock. Each save goes
     through a temp file of its own process and a rename, so the record is
     always one whole document, but an offload or restore finishing in the
     same instant in both keeps only the later save — the other's copies
     then stand at the destination, where the drive's own record lists them
     unless its two writes crossed the same way.
   - `POST /api/cart/commit` with `{ paths }` is the same delete **as one
     undoable run**: every item is copied into the Time Capsule and verified
     before anything is trashed, and the response carries a `runId` that
     `POST /api/cart/undo` restores in full — original paths, byte for byte,
     with their permissions and the dates they were last modified and opened
     (not their creation dates, which nothing sets back), even after the Trash
     has been emptied; a date or permission that could not be set back finishes
     the restore with a warning naming it. Each file is written beside its
     name (`.treemap-restore-…`) and put there only once it verifies; one a
     quit or a kill left is removed at the next start — only names TreeMap
     recorded, only while each is still the file it made, and never one
     another TreeMap still running recorded. On a volume without hard links
     the item's own name is held with an empty file for the rename; that is
     recorded too, removed at the next start only while it is still that
     empty file, and named when a failed restore cannot remove it.
     (Directory times are restored after their contents, so writing the
     children back does not re-stamp the folder.) It is a separate route from
     `DELETE /api/files`
     rather than a flag on it, because the two make different promises and
     `GET /api/capabilities` marks destructive endpoints one by one.
     **The refusal that matters:** anything the capsule cannot protect whole —
     too large for it, or a folder holding a file that could not be looked at —
     is **left undeleted** and named in `skipped[]` with its reason — never
     deleted unprotected. Each call the capsule makes on an item — its walk
     of the item (a dry run's too), each file it copies, and its look again
     right before the item's trash step — has a 60-second stall limit, past
     which that item is left undeleted; and while two such calls are still
     waiting on a volume that stopped answering, nothing more is started:
     an item not yet copied is left undeleted as `CAPSULE_COPY_FAILED` (and
     a dry run says so), and one whose turn comes at its look right before
     its trash step as `CAPSULE_UNREADABLE`. Four looks have no limit yet.
     Two come before anything is deleted — where each item of the batch is
     on the disk, taken before anything is copied, and what stands at each
     path, noted just before the Trash is asked: a path that never answers
     there holds the request, and nothing is deleted while it waits. Two
     come after the trash step has run — what stands at the place of an
     item whose trash step reported a failure, and at a path inside an item
     that went to the Trash: a path that never answers there holds the
     response though items are already in the Trash. Their copies are kept,
     and held from eviction until the request ends. Older copies are
     evicted to make room only once the new copy is whole and verified, so an
     item whose copy fails costs no older copy. A run's copies are never evicted to make room while
     a request of that run is under way — its own, or a later chunk of the
     same chunked commit — so a batch bigger than the capsule leaves its later
     items undeleted (`CAPSULE_FULL`) rather than dropping its own earlier
     copies. Between the requests of a chunked commit nothing holds the
     earlier chunks' copies: another deletion may evict them then, and an
     undo names those items in `unrestorable[]`. A copy a restore or an undo
     is reading is held for it the same way until that job ends — never
     evicted, forgotten or expired from under it — and a copy kept because
     its item's trash step could not be confirmed (it may be the only one) is
     never evicted; and right before each item's
     trash step its copy is looked at again — one that is gone or incomplete
     by then (a member missing, or a file not the size it was copied at)
     leaves the item in place (`CAPSULE_COPY_GONE`) — and the item's metadata (each
     file's size, modified time, change time and file id; no bytes are read)
     is walked again and compared with what was copied: a file added, removed,
     rewritten — even with its size and modified time put back — or replaced
     since leaves it in place, its copy discarded (`CAPSULE_CHANGED`, naming
     what changed). A change time that moved with nothing else (a new
     permission or attribute moves it too) is said as "may have changed": it
     does not show the copy differs, and the item stays in place all the
     same. A volume that keeps no change time of its own (FAT,
     exFAT) answers with what it has. `dryRun: true` returns that same verdict per
     path *before* anything happens, along with the older capsule copies that
     would be evicted to make room and B2's open-handle preflight. At most 500
     paths per commit. Nothing after the trash step can fail the request:
     should discarding the capsule copies of items the Trash refused not
     finish, the response still carries `trashed` and `runId`, adds a
     `cleanupError` sentence, and the undo puts back exactly what was trashed.
     A path inside another path of the same commit gets no copy of its own:
     the item holding it is copied and trashed whole, the inner path is listed
     in `trashed` with it — once the disk no longer shows it — and counted
     once, and one undo puts both back (or, when the item holding it is not
     confirmed moved, it is in `unverified` with it; when that item is not
     deleted, it is in `skipped`, saying so; when the Trash reports taking that
     item but the disk still shows the inner path in its place, the inner path
     is in `skipped` with code `NOT_DELETED`, and when its place cannot be
     looked at, it is in `unverified`). "Inside" is where each is on the
     disk, not how it is spelled: another spelling of a folder (an alias; on
     macOS and Windows, another case where the volume folds case — Linux's
     realpath keeps a name as it was typed, so there two cases of one folder
     stay two items) is that folder, while a path
     through a link out of a folder, a link itself, or anything on a volume
     mounted inside it is its own item, with its own copy.
     A failure the Trash reports is judged by the disk: an item gone from its
     place is `trashed`, with its copy kept; one still in place is
     `failedToTrash`, its copy dropped; and one the disk cannot show either way
     — a look that failed, or a trash command stopped before it answered,
     which may still finish — is in `unverified`, with its copy **kept**, and
     the undo puts it back only if its place is empty by then. An undo that
     passes over such a copy names it in `passedOver` with what the disk
     showed (the same file still in its place, something else there, or a
     place it could not look at — never "still in its place" otherwise), and a
     later undo can still put it back. An Autopilot run lists these items in
     `unverified` and stays undoable until they are put back. Each copy
     records where its item was on the disk (`realPath`, when the path it was
     deleted by reached it through a link or in another case), and an undo
     puts it back, and looks for it, there — never through a spelling that
     leads nowhere once another item is in the Trash.

Never skip step 1: destructive endpoints refuse paths that are not inside a
root this server has actually scanned. Scanning is what grants (scoped,
read-what-you-saw) permission to act.

## The safety model (enforced server-side, not advisory)

- **Trash-only deletes.** Every delete of your files is a move to the
  platform Trash / Recycle Bin. What cannot be undone is labelled and gated:
  `POST /api/trash/empty`, `POST /api/system/snapshots/purge` and
  `POST /api/git/gc` each require `{ "confirm": true }`. Two more cannot be
  taken back and take no confirm flag, so confirm with the user first:
  `DELETE /api/timecapsule/{id}` discards a Time Capsule copy for good
  (refused with `409 RESTORE_RUNNING` while a restore is reading it, and
  `409 DELETION_RUNNING` while the deletion that made it is still under way —
  its item may be on its way to the Trash with that copy as its only one), and
  `POST /api/zombie-handles/restart` quits a program, which can lose its
  unsaved work.
- **The scanned-root rule.** Endpoints that read, open, move or delete a path
  (`DELETE /api/files`, `/api/cart/commit`, `/api/files/open`,
  `/api/files/terminal`, `/api/files/preview`, `/api/offload`, `/api/git/gc`,
  `/api/container/expand`) demand the path lie inside the root of a scan this
  server performed. Outside → `403 { code: "OUTSIDE_SCAN_ROOT" }`. A scan
  grants only what it listed: a path at or beneath a folder it never descended
  into — a fixed never-descend folder such as `/Volumes` after a scan of `/`,
  or a drive mounted inside the folder that it did not enter under "Stay on
  this drive" — is outside that scan too, unless another scan covers it (scan
  the drive itself to act there). The drives are the ones the mount table
  listed when the scan started: a drive mounted inside the folder later is not
  known to that scan until it is scanned again (on macOS, `/Volumes`, where
  drives appear, is excluded whatever is mounted there). A scan of the Data
  volume itself (`/System/Volumes/Data`, however its root is typed: through a
  link in its parents such as `/Volumes/Macintosh HD/System/Volumes/Data`, or
  in another case, its own last name included) covers only what the root shows of that volume — its firmlinked folders (`/Users`, `/Applications`,
  `/private`, …) — never the sealed system volume or another volume, and
  never anything in that volume's own spelling of a fixed folder: its
  `/Volumes` is the root's, so no drive there is covered — one mounted after
  the scan began, or any at all when the mount table could not be read.
  The Data volume's spelling of a path is the root's own only under a
  firmlinked folder (`/System/Volumes/Data/Users/…` is `/Users/…`); the Data
  volume itself and its own folders (`/System/Volumes/Data/.Spotlight-V100`,
  `…/mnt`, `…/usr/bin`) are not `/`, `/.Spotlight-V100`, `/mnt` or
  `/usr/bin`, and lie under `/System/Volumes`, which a scan of `/` never lists.
  Where `/usr/share/firmlinks` cannot be read, or names nothing, the folders
  every macOS since 10.15 firmlinks stand in (`/Applications`, `/Library`,
  `/Users`, `/Volumes`, `/cores`, `/opt`, `/private`, `/usr/local`).
- **TreeMap's own spill folder.** `<appData>/scan-spill` is reserved for the
  working files of very large scans (Phase 4; no scan writes there yet). Every
  endpoint and MCP tool that takes a path
  to trash, open, move or write refuses that folder and anything under it with
  `403 { code: "SPILL_PATH" }` — before the scanned-root rule, so scanning a
  home folder is no licence there — however the path is spelled (`..`, trailing
  separators, another case, a name only the file system folds such as `ſ` for
  `s`, a link in its parents, Windows' trailing dots and spaces). A name that
  folds to the folder's is refused by that name even before the folder exists,
  since making the path would make the folder. A request's
  `path` and every element of its `paths` are judged, whichever of the two its
  route reads, and anything but a non-empty string is `400 PATH_INVALID`. That
  covers every route above (Open and Open Terminal check again where they
  start the program), `/api/files/open-handles`, `/api/security/relocate`
  (both ends, checked again by the move itself), the offload destination and
  every copy an offload plans under it, `/api/compression/encode` and
  `/api/system/snapshots/restore` (path and destination). Facts about it still answer, since answering touches nothing;
  the Empty Folders view never offers it; Autopilot leaves it out of every run
  and says so in `skipped`; and the Trash pathway itself (`moveToTrash`, the
  Time Capsule's `protectAndTrash`) refuses it whatever asked. An Autopilot run
  whose delete is refused there, or fails before anything is deleted, is
  recorded as a `failed` run with the reason, and the policy waits for its own
  schedule; a failure after the trash step is reported in the run's reason,
  its items being what it trashed. A leftover of a
  crash is removed by TreeMap itself at the next start, never through the
  Trash.
- **TreeMap's own app-data folder is never a write destination.** It holds
  the files TreeMap trusts — settings, the Autopilot policies and their
  approval, the offload manifest, the Time Capsule, the spill folder, the
  record of restores' temporary files — so no
  request names a place in it that a file is written, moved or copied to: a
  relocation's `to`, an offload's `dest` and every copy its plan makes, a
  snapshot restore's destination (given, or the default beside an original in
  app-data) and an encode's paths are refused with
  `403 { code: "APP_DATA_PATH" }`, over HTTP and MCP. However the path is
  spelled: a link in its parents, a link as its own last name (followed,
  since a write goes where a link leads; a loop is refused), another case, a
  name the file system folds (`ſ` for `s`, NTFS's `ı` for `i`), an 8.3 name —
  and before the file or the folder exists. Nor does a record read from a
  drive lead a write there: an offload restore refuses a recorded original in
  app-data (and any record not of the shape TreeMap writes), the offload's
  record on the destination is written under a fresh name and renamed into
  place — never through a name already there — and an encode writes in a
  private folder it made; nothing restores from that record on the drive or
  follows it, so every entry already in it is carried as it stands, and one
  that cannot be read whole is renamed aside, never replaced. Nor does a record TreeMap keeps lead anywhere it
  would not have written: a Time Capsule entry whose id is not one TreeMap
  gives is never made a path (forgetting it, or its expiry, removes nothing
  on disk), and a restore of it — or of an entry whose original place, or
  whose manifest's names, lead outside what capture records — answers
  `409 { code: "CAPSULE_RECORD_INVALID" }`; an Autopilot policy whose folder
  is not one TreeMap saved is a failed run (`POLICY_RECORD_INVALID`) before
  anything is scanned. What a request does write in app-data is TreeMap's own
  files under names it chose — settings, records, the Time Capsule's copies —
  and the one file a request can have put back there is an item TreeMap
  itself took from there, by an undo or a Time Capsule restore. Reading
  app-data, and deleting what a scan covers there, are unchanged. The offload reveal (`POST /api/offload/reveal`) opens a copy only
  inside the destination its manifest record names, both resolved; anything
  else, a record whose paths are not text included, is
  `403 { code: "OUTSIDE_DEST_ROOT" }`.
- **Storage modes (Phase 4).** A scan is kept in `memory` (every scan today),
  `spill` (rows in files on disk) or `aggregate` (a bounded summary, no row for
  every file). A feature that is off in the mode a scan is kept in answers
  `409 { error, code: "STORAGE_MODE", mode, feature }` before its handler runs;
  an MCP tool answers `Error (STORAGE_MODE): …`, and a fact provider that is
  off answers `available: false` with the same sentence while the others in
  the request still answer. Which features are off where is one table,
  `src/services/storageMode.ts`, and `GET /api/openapi.json` names the 409 on
  every endpoint that can give it. In memory mode nothing is refused.
- **Path sanitization.** All user-supplied paths are validated: `..` traversal
  is resolved away, null bytes rejected, `~` expanded, and OS-internal
  directories (`/proc`, `/sys`, `C:\Windows\System32`, …) refused outright.
  So is a path spelled through a **second name** the system gives it, on
  every route and MCP tool that takes a path: `400 { code: "PATH_BLOCKED" }`.
  On macOS that is `/.nofollow/…`, `/.resolve/…` and `/.vol/<dev>/<inode>/…`
  at the root, in any case — the kernel answers them for any file on any
  volume, and realpath cannot say where they land, so they walked past both
  the blocklist and the scanned-root rule. On Windows it is a device or
  object-manager spelling (`\\?\Volume{…}\`, `\\?\GLOBALROOT\…`,
  `\\.\PhysicalDrive0`, `\\.\C:`, `\??\…`); behind `\\?\` or `\\.\` only a
  drive-letter path (`\\?\C:\…`, the drive's root `\\?\C:\` included) or a
  UNC path (`\\?\UNC\server\share\…`) passes. This machine's own admin
  shares (`\\localhost\C$\…`, `\\127.0.0.1\c$`, `\\<its name>\ADMIN$`, `print$`, also
  behind `\\?\UNC\`, its address written any way Windows reads one —
  `\\127.1\`, `\\2130706433\`, `\\fe80--1s4.ipv6-literal.net\` — and the
  share with a trailing dot or space, `C$.`) are its drives again, and a name with a colon past the
  root is an NTFS stream (`System32::$INDEX_ALLOCATION` is the folder
  itself), as is a colon in a UNC path's share name or host
  (`\\localhost\C$::$INDEX_ALLOCATION\`): both are second names too. The scanned-root rule refuses such a spelling on its own as well
  (`OUTSIDE_SCAN_ROOT` to a caller that skipped the sanitizer), including
  through a link whose target is spelled that way — a link in the path's
  folders, or the path itself being such a link, which both rules refuse
  alike. A link realpath cannot follow (its target is missing, it loops, or
  its target is spelled through `/.resolve` or `/.vol`) is judged where its
  target says it leads, never as a folder of the scan it sits in — and read
  as the system reads it: on macOS and Linux a `..` in the target is the
  folder above where the names before it really lead (`sub/../x` with `sub`
  a link is beside `sub`'s target, not beside the link), so a link is not
  "in the scan" because its text cancels out. A chain too long to place —
  more links than macOS or Linux follows in one lookup (Windows follows 63),
  or targets that spell more names than one check walks (4096) — is placed
  nowhere and refused by both rules, never read as the link where the check
  stopped.
- **Cloud and archive paths.** `cloud://` paths never touch the local
  filesystem — their deletes go to the provider's own trash via
  `POST /api/cloud/trash`. Entries *inside* archives are listings, not files
  (`403 { code: "VIRTUAL_PATH" }`); act on the archive itself.
- **Snapshot restores never write through an existing name.**
  `POST /api/system/snapshots/restore` checks its destination before the
  administrator prompt — and, with `overwrite: true`, before the file there is
  moved to the Trash — and the copy checks again when it runs: on macOS the
  destination folder must belong to the user or root, and neither group nor
  others may change it, else `409 DESTINATION_FOLDER_REFUSED` (checked again by
  the root helper, which enters the folder by its physical path); a folder the
  helper could not open or check when it ran — moved, removed, or its drive
  disconnected while the prompt was open — is `409
  DESTINATION_FOLDER_UNAVAILABLE` instead, with the helper's words, and may
  succeed if tried again; so is a folder that could not be checked before the
  prompt, or made, with the reason (never a raw 500). The helper
  copies into a folder it makes there and works from inside it, so a folder
  swapped in under that folder's name is never written to. It places a file
  with `link`, which fails whatever is at the name (on a volume without hard
  links, with `mv -n -h`), a link with `ln -P -h` and a folder with
  `mv -n -h`; those two do not fail for a real folder that appears at the name
  at the last moment — they put the copy inside it — which is found
  afterwards by the copy's own device and inode and reported, not prevented
  (docs/engine/RISKS.md R102). A locked (Finder "Locked") item is restored
  unlocked. Linux and Windows claim the name exclusively (`symlink`, a
  non-recursive `mkdir`, an exclusive file copy). A name that appears in
  between fails the restore and nothing is written over it — answered
  `409 DESTINATION_OCCUPIED`, as when the name was there before. A restore
  that failed, or could not look in a snapshot, is `409 RESTORE_FAILED`,
  never `NOT_IN_ANY_SNAPSHOT`: on macOS a prompt that failed, a helper error
  (a copy that could not be made or put in place) or a snapshot that could
  not be mounted; on Linux a snapshot that could not be read or a copy that
  failed; on Windows a restore point that could not be opened (administrator
  rights, a link not made) or a copy that failed. A failed copy says what it
  left at the destination, and a restore with `overwrite` that stops after
  the file there went to the Trash says that too. A restore made from an
  older snapshot because a newer one could not be mounted or opened (on macOS,
  a stat failure other than "no such file" counts as not opened, never as
  absent) succeeds and says so: the 200 answer carries
  `newerUnread: { count, reason }`, and the panel says the copy may not be the
  newest. No test ever raises the
  password prompt: under a test runner it refuses (`setAdminPromptForTests`
  stands in).
- **Git runs hardened, and only in a vetted repository.** A repository found
  under a scanned folder is not trusted: its own `.git/config` can name
  programs for git to start (`core.fsmonitor`, `filter.<x>.clean`, hooks…).
  Every git call TreeMap makes carries `-c core.fsmonitor=false
  -c core.hooksPath=<nowhere> -c core.pager=cat -c core.untrackedCache=false
  -c credential.helper= -c protocol.allow=never` and an environment built
  from scratch (no inherited `GIT_*`, no system or global settings, no
  optional locks, no prompts, no lazy fetch; the user's own global ignore
  file is passed explicitly, or nowhere when it cannot be worked out). Before
  anything reads a work tree, the
  repository is vetted: git's own parser lists every setting without
  following includes, and anything not on an allow-list of settings that
  cannot start a program — any `include`, `filter`, `diff`/`merge` driver,
  `alias`, a non-boolean `core.fsmonitor`, a partial clone's promisor
  settings… — refuses it (`core.worktree` passes, since git's own answer
  must still place the work tree in the folder asked about). Where a `.git`
  file, a `.git` link or a `commondir` points, where a link at the top of
  the git folder leads, and the object folders the repository borrows
  (`objects/info/alternates`, followed as git follows them) are read by
  TreeMap itself before git is started, each resolved as the system
  resolves it (links first, then `..`): a network share (any text starting
  with two separators, of either kind), a folder outside every scan, or
  nothing at all refuses the repository and git never runs. One vetting reads
  at most 256 `alternates` entries in all, and stops at its next step once
  the request that asked is cancelled. Git resolves an `alternates` entry its
  own way — the objects folder's real path, then the entry, `..` removed by
  text — and on Windows TreeMap's own resolution removes `..` by text where
  git follows links, so for an entry holding a link followed by `..` the two
  can differ (docs/engine/RISKS.md R115).
  Each is read as git reads it — a pointer file whole, with only its
  trailing line ends removed (leading and trailing spaces and later lines
  are part of the path), a quoted `alternates` line by character — and
  byte for byte: a name that is not UTF-8 refuses the repository rather
  than be judged as a lookalike. An `alternates` file that is not a plain
  file is refused by what it is before it is opened, on every system
  (Windows has no `O_NOFOLLOW`). Git's own answer of where it keeps the
  data must then be the folders TreeMap read, or nothing more is run.
  A repository another account owns is unknown with that reason (a
  `safe.directory` exception cannot help: no call reads your git settings).
  `status` never recurses into submodules, and "pushed" is
  measured only against a remote-tracking upstream.
  `POST /api/git/gc` follows the path to where the repository really is,
  which must be inside a scanned folder, and runs only on a `.git` that is a
  real folder, with no `commondir`, no `objects/info/alternates` and no link
  or special file anywhere inside it, vetted, told its git dir (`--git-dir`), and prunes only what
  has been unreachable for two weeks (`--prune=2.weeks.ago`, git's own
  default); anything else answers `{ ok: false, error, refused: true }` with
  the reason, runs nothing, and is audited as `refused` (a gc git ran and
  failed is audited as `error`).
- **Uniform errors.** Every failure is `{ "error": string, "code": string }`
  with a stable code. Rate limit: 10 req/s sustained per client (bursts to
  20), then `429 { code: "RATE_LIMITED" }`. Status polls
  (`GET /api/scan/{scanId}/stats`, the `/progress` endpoints) and other cheap
  metadata reads have their own, larger allowance, so polling a scan does not
  spend the one your next delete or offload needs; `GET /api/capabilities`
  publishes every lane under `rateLimit.lanes`.

## Safety rails for agents: dry runs, policy, audit, idempotency

- **Dry runs.** `DELETE /api/files`, `POST /api/cart/commit`,
  `POST /api/offload` and `POST /api/offload/restore` accept `"dryRun": true`
  and return the **exact manifest** — affected paths and bytes — while acting
  on nothing. A dry run
  passes through every validation a real run would (path guards, policy,
  offload planning, and for an offload restore each record's shape — the
  records the real run would refuse are listed in `refused[]` with their
  reasons), so "dry run succeeded" genuinely means "the real run
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
  `allowedRoots` confines both scanning and destruction — every scan, whoever
  starts it: a scheduled one too (a new schedule outside the roots is refused
  when `PUT /api/settings` saves it; one saved earlier is refused each time it
  falls due) and one a paired peer asks for, and each by where its root really
  is, so a path spelled through a link (the root itself, or a folder above it)
  that leads outside every allowed root is refused before anything is walked;
  `protectedPaths` can
  never be trashed/offloaded (nor anything containing them); the byte cap
  refuses any single oversized operation. Violations are
  `403 { code: "POLICY_ROOT_NOT_ALLOWED" | "POLICY_PROTECTED_PATH" |
  "POLICY_BYTES_EXCEEDED" }`. An absent or empty file imposes nothing. The
  policy is deliberately not writable through the API. It governs local paths
  only: a connected cloud account's scan and `POST /api/cloud/trash` are not
  held to it. A policy file that is there but will not parse refuses every
  operation it governs (`500 POLICY_UNREADABLE`).
- **Audit.** Every destructive request that touches **files** and reaches
  its endpoint — executed, dry-run, or refused there — is appended to
  `audit.jsonl` (timestamp, action, source http/mcp, token id, paths, bytes,
  outcome). The refusals recorded are the ones the endpoint itself decides:
  the agent policy and its byte cap, an open file and the offload plan, each
  with its code, a folder an `onlyEmptyFolders` delete or dry run left where
  it is (one `refused` entry per code, apart from the paths that went), and
  a relocation whose move failed, as refused — except
  that `POST /api/security/relocate` and `POST /api/compression/encode` check
  the policy before their audited step, so their policy refusals are not
  recorded. A request refused before that is not recorded, because it never
  became an operation:
  by the path rules (`PATH_INVALID`, `PATH_BLOCKED`, `CLOUD_PATH`,
  `SPILL_PATH`, `APP_DATA_PATH`, `OUTSIDE_SCAN_ROOT`, `VIRTUAL_PATH`), a missing or malformed
  field (`CONFIRM_REQUIRED`, `DEST_REQUIRED`), the rate limiter, or the
  storage-mode gate (`STORAGE_MODE`). `SPILL_PATH` and `APP_DATA_PATH` fall
  on both sides of that line. On a path the request names — its `path` or
  `paths`, an offload's `dest`, a relocation's `to`, a snapshot restore's
  path and destination, an encode's paths — each is a path rule, and not
  recorded. On a copy the offload plan would make under an allowed
  destination (one holding a link, under a name the volume folds, into the
  spill folder or app-data) it is the plan's refusal, and recorded:
  `offload.start`, `refused`, with its code, over HTTP and MCP alike.
  A cart commit's line lists what was confirmed moved in `paths` and, apart,
  anything whose trash step was not confirmed either way in `unverified`.
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
  Like the forecast, it fits only the scans since the drives mounted inside
  the budget folder that a scan stopped at last changed (Track U, U-24).
- **Plain-words translation (v4 §9.6).** `POST /api/nl-query { text }`
  translates natural phrasing into the query grammar and **never executes**
  — no hits, no totals; run the returned `q` through `POST /api/query`
  yourself, after showing it. Sizes in words are decimal like the grammar
  ("over 500 MB" → `size>500mb`). It answers `ok: false` with a reason,
  rather than a query that cannot be what was asked, for a sentence using a
  field TreeMap can never answer (duplicates, "never opened": the query would
  match nothing, and dropping the word would widen it) and for one that comes
  to nothing but `type:` ("files" alone lists every file). The
  deterministic phrase table is the whole feature and it is entirely offline — tests/nlQuery.test.ts statically
  scans every file under src/services/query/ plus the route itself and
  asserts none contains network code. (An optional local
  Ollama passthrough shipped briefly and was removed at the owner's
  request.)
- **Idempotency.** Every endpoint that moves, trashes, restores or encodes
  files — and `POST /api/trash/empty`, `/api/system/snapshots/purge` and
  `/api/git/gc` — honors an `Idempotency-Key` header: repeating a successful
  request with the same key within ~10 minutes replays the stored response
  (`Idempotency-Replayed: true`) instead of executing again. Send one on every
  such call you might retry. The configuration writes (settings, notes, the
  scanning budget, Autopilot policies, cloud disconnect),
  `DELETE /api/timecapsule/{id}` and `POST /api/zombie-handles/restart` do not
  honor it.

## MCP specifics

- `scan_path` returns a `scanId` and waits (bounded) for completion; pass
  `scanId` back to keep waiting on a long scan.
- `trash_paths` and `offload` accept `dryRun: true`, which returns the exact
  manifest — affected paths and bytes — while acting on nothing. **Dry-run
  first, show the user, then act.**
- All sizes come back as raw bytes plus a human-formatted string.

## Server profile: auth, CORS and remote bind

All of this is **opt-in via environment variables; with none of them set,
`npm start` behaves exactly as it always has** (localhost bind, no auth, no
CORS). The desktop app runs this server on a random localhost port with a
fresh token each run, so drive your own `npm start` or `npm run mcp`, not the
window's.

| Variable | Default | Effect when set |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address for `npm start` (e.g. `0.0.0.0` for remote access) |
| `PORT` | `4280` | Listen port |
| `TREEMAP_TOKEN` | unset (no auth) | Every `/api` request must send `Authorization: Bearer <token>`; otherwise `401 { code: "UNAUTHORIZED" }` |
| `TREEMAP_ALLOWED_ORIGINS` | unset (no CORS) | Comma-separated origins allowed to call the API from browsers |
| `TREEMAP_DATA_DIR` | per-OS app-data dir | Where snapshots/settings/manifests persist |
| `TREEMAP_INSECURE_BIND` | unset | `1` lets a non-loopback `HOST` start without `TREEMAP_TOKEN`, with a warning; without it such a bind refuses to start |
| `TREEMAP_TRUST_PROXY` | unset | `1` trusts exactly one reverse proxy in front, so the rate limiter buckets by client |
| `TREEMAP_FRAME_ANCESTORS` | unset (the page may be framed) | A CSP `frame-ancestors` value, e.g. `'none'` for a hardened server (the VS Code extension frames the page) |
| `TREEMAP_NO_GDU` | unset | `1` never runs gdu; a scan that would have used it takes the built-in walker |
| `TREEMAP_NATIVE_MODULE` | unset | Load the native module from this path only |
| `TREEMAP_PORTABLE` | unset | `1` (or `true`) runs a portable, no-trace session (`GET /api/platform/portable`) |

A loopback-bound server answers only to loopback names (and the address it
was given): any other `Host` header is `403 { code: "BAD_HOST" }`.

How the human UI keeps working with a token set: serving the UI page also
sets an `HttpOnly`, `SameSite=Strict` session cookie, which same-origin
`fetch()` **and `EventSource`** (which cannot send headers) attach
automatically. The page needs no auth code of its own.

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

- Local-first: nothing reaches the internet except the optional cloud
  integrations the user connects and, in the packaged desktop app, its update
  check against GitHub Releases; the fleet, off by default, talks only to
  TreeMaps on the LAN.
- The server binds `127.0.0.1` by default. `PORT` and `HOST` env vars change
  that for server deployments.
- Scan results are in-memory (30-minute TTL); snapshots, settings and the
  offload manifest persist in the per-OS app-data directory
  (`TREEMAP_DATA_DIR` overrides — useful for tests and containers).
- A native scan that fails part-way through a tree known to be above
  5,000,000 items — it had counted more, or the folder's previous scan
  counted enough that 1.25 × that count is above it — ends with
  `status: "error"` and the reason, and is never restarted from zero in the
  built-in walker on its own (P4-14); the error says how to scan it anyway.
  Below that, a failed native walk falls back to the walker as before, and
  `fallbackReason` says why.
