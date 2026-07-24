# Implementation notes — agent-native upgrade

Decisions, dependencies and deviations from the agent-upgrade master prompt.
Everything else is documented user-facing in `AGENTS.md`, `GET
/api/capabilities` and `GET /api/openapi.json`.

## The R2 decision: how the browser UI stays authorized under TREEMAP_TOKEN

**Approach: server-side session cookie, set when the UI page is served.**
When `TREEMAP_TOKEN` is set, `GET /` (or `/index.html`) responds with an
`HttpOnly; SameSite=Strict` cookie carrying the token, and the `/api` auth
middleware accepts either `Authorization: Bearer <token>` or that cookie.

Why this and not the alternatives:

- The frontend is frozen (R1): its literal `fetch('/api/…')` calls and
  `new EventSource('/api/…')` cannot be taught to send headers — and
  `EventSource` *cannot* send custom headers at all, so header-only auth
  would silently kill every SSE stream the UI depends on. Cookies ride along
  on both automatically.
- A "same-origin requests are exempt" rule would trust `Origin`/`Referer`
  headers, which any non-browser client can forge — that's an auth bypass,
  not an exemption.

Threat model (stated plainly, also in AGENTS.md): the token gates API access
for non-browser clients, and `SameSite=Strict` + CORS-off blocks cross-site
browser attacks; anyone who can load the UI page itself gets a session. If
the port is exposed beyond localhost, front it with a reverse proxy that
authenticates page loads and terminates TLS.

## New dependencies (and why so few)

- `@modelcontextprotocol/sdk` — the official MCP implementation; hand-rolling
  the protocol would be invented risk. Runtime dep (the MCP server runs from
  `dist/` with production deps only).
- `zod` — peer dependency of the SDK and the input-validation layer for the
  MCP tools' schemas.
- **CORS is implemented in-tree** (`src/middleware/cors.ts`): the policy is a
  handful of headers; the MIT `cors` package would add a dependency for no
  behavior we need.
- **Zero frontend dependencies added**; `public/index.html` is untouched.

## Design choices worth knowing

- `prepareOffload` was extracted from `startOffload` (same file, byte-same
  checks) so dry-run and real-run share one source of truth; `startOffload`
  accepts the prepared plan back to avoid planning twice.
- The agent policy (`agent-policy.json`) is **deliberately not writable via
  the API** — a policy an agent could rewrite for itself would be theatre.
  `GET /api/policy` shows the resolved policy and the file path; the human
  edits the file.
- MCP `scan_path` accepts either `path` (start) or `scanId` (keep waiting) —
  the polling pattern for scans that outlive one tool-call timeout. The same
  pattern applies to `find_duplicates` and `offload` (via `jobId`).
- MCP tool responses skip MCP `outputSchema`: the structured payloads are
  typed against `src/models/types.ts` at compile time, which keeps one source
  of truth instead of a second, silently-driftable schema layer.
- Audit entries record refusals too (`outcome: "refused"`, with the policy
  code) — an agent probing the rails leaves a trace.
- In the container the server binds `0.0.0.0` (a 127.0.0.1 bind is
  unreachable through a published port); `docker-compose.yml` restores the
  localhost-only posture by publishing on `127.0.0.1:4280` — widen the
  mapping and set `TREEMAP_TOKEN` deliberately for remote use. Containers
  have no OS Trash, so the container profile is scan-and-analyze; the compose
  file suggests read-only data mounts.

## Deviations from the prompt

- **Phase 6 gate (`docker build`) could not be executed on this machine:
  Docker is not installed.** Everything Docker would validate short of the
  image layer itself was proven directly: the exact runtime recipe
  (`package.json` + `npm ci --omit=dev` + `dist/` + `public/` +
  `node dist/index.js`) was staged in a clean directory and served
  `/api/system`, `/api/capabilities` and the UI correctly with production
  dependencies only. Run `docker build .` on a Docker-equipped machine (or
  CI) to close the loop.
- No other deviations: every existing endpoint's response shape is unchanged
  (golden + contract suites), and with all new env vars unset the server's
  behavior is byte-identical to before (explicit tests assert the historical
  shapes and header-free responses).
