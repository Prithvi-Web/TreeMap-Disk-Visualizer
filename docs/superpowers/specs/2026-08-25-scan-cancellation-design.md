# Stopping a scan — design

**Date:** 25 August 2026
**Status:** shipped

## The problem

A scan of a whole drive could not be interrupted. `beginScanChrome` set
`$('scanBtn').disabled = true` for the duration, so the only ways out were
quitting the app or reloading the page — and neither of those stopped the walk
that was already running. On a 1.4M-item disk that is sixteen seconds of the UI
appearing to have taken the app hostage, and considerably longer on a slow
external drive.

## The shape of the fix

One button in two modes. Scan becomes a red Stop while a scan is in flight, and
pressing it ends the scan. Two separate buttons were rejected: the two actions
are never both available, and a permanently-greyed Stop is a slightly politer
version of the original problem.

## Why the backend settles the record itself

`ScanResult.cancelled` already existed, and every engine already checked it. The
trap is what they do next: **every one of them observes cancellation by a plain
`return` that never assigns a status.**

| path | file | what it did on cancel |
| --- | --- | --- |
| gdu, success | `diskScanner.ts:247` | `return` — status stays `running` |
| gdu, cancel-throw | `diskScanner.ts:259` | `return` — status stays `running` |
| walker | `diskScanner.ts:428` | `return` — status stays `running` |
| cloud, after `listTree` | `cloudScan.ts:39` | `return` — status stays `running` |

A record left at `running` is not merely untidy. The SSE timer in `scanRoutes`
only exits on `status !== 'running'`, so the stream keeps beating forever and
the UI keeps spinning — the exact symptom the feature exists to remove. And
`scanExpired` holds a running record for the six-hour wedge horizon rather than
the thirty-minute settled TTL, so the leak lasts.

So `cancelScan()` settles the record **synchronously**, and every one of those
returns becomes a no-op. This is race-free rather than merely lucky: each engine
runs from its `if (scan.cancelled) return` check to `status = 'complete'` with
no `await` in between, so a scan that beat us to the line really did complete —
and the `status !== 'running'` guard leaves it alone instead of rewriting a
finished scan as an error.

### `finishedAt` is load-bearing

`scanExpired` falls back to `createdAt` when `finishedAt` is missing. Cancelling
a walk that started more than thirty minutes ago would therefore be evicted by
the very next evictor tick — and the UI would get a 404 instead of the message
explaining what happened. It is stamped, and a test pins it.

## Killing the gdu subprocess

Cooperative cancellation in the gdu engine is checked at the top of the shard
loop, i.e. strictly *between* shards. `SHARD_TIMEOUT_MS` is five minutes, so a
scan cancelled one second into a shard kept reading the disk for up to five more
minutes after the UI said it had stopped.

`runGdu` now hands its `ChildProcess` back through an `onSpawn` callback, the
shard loop registers it for exactly the duration of that one subprocess, and
`abortGduScan(scanId)` kills it. Measured: one `gdu` process before the cancel,
zero after, and the shard's temp directory is removed by the existing `finally`.

`cancelAllScans()` (shutdown) reaps it too — otherwise quitting mid-scan orphaned
a subprocess with nothing left to clean up after it.

A kill and a timeout are indistinguishable at the `execFile` callback (both set
`err.killed`), so a cancel-kill reports the timeout message. That text never
reaches a user: `diskScanner` returns on `scan.cancelled` before it logs.

## Frontend ordering

The stream and the watchdog are severed **before** the cancel request goes out.
Both would otherwise land afterwards describing the cancellation we just asked
for — the server's `error` frame and the watchdog's 500 — and repaint the user's
own "Scan stopped by user" as a failure.

`followScanProgress` publishes `state.abortScan`, because `finished` and the
watchdog interval live only in its closure and Stop has to settle both.

### Which scan does Stop cancel?

`state.scanId` is assigned in exactly one place, inside `followScanProgress`. A
quiet background refresh therefore leaves the **previous** scan's id sitting
there until the new one arrives, so `state.scanId` alone cannot say what to
cancel. `state.abortScan` is set in the same breath as the new id, which makes
it the honest test for "this scan has a stream, and `state.scanId` is its id".

### The request that answers too late

There is no scanId until the scan request returns, so a Stop pressed before then
can only stop the chrome. Both entry points — `startScanRequest` and
`startCloudScan` — check `abandonIfStopped(resp.scanId, gen)` before opening a
stream. The generation token is what makes it correct rather than usually right:
`state.scanning` describes whichever scan is running *now*, so after
Stop-then-Scan-again a bare flag check would let the first request's reply be
followed, leaving two live EventSources and a `state.scanId` belonging to the
abandoned scan. Verified live: two scans created, one stream opened, one cancel
sent.

## Things that turned out to be adjacent bugs

- **Enter in the path field.** It synthesises `scanBtn.click()`, which was safe
  only because the button was disabled mid-scan. With the button now Stop, an
  unguarded Enter would cancel the running scan. Guarded on `!state.scanning`.
- **The dashboard kept its skeletons.** `beginScanChrome` replaces three panels
  with skeletons, and the dashboard's own `mount()` is deliberately a no-op
  ("painted by finishScan"), so `switchView` cannot repaint them. A stopped —
  or failed — scan left three skeleton panels on screen permanently, on top of
  data the app still held. `failScan` had this bug already; both now share
  `restoreDashboardPanels()`.

## What is deliberately not done

- **`state.scanId` is not rewound on stop.** After Stop it names a scan that is
  now an error, so scanId-keyed views will refuse. That is what a *failed* scan
  has always done, and inventing a "previous good scanId" to fall back to would
  mean tracking a second id whose tree may since have been evicted.
- **Cancellation reports as `status: 'error'`.** It is a settled-not-complete
  state, and `/api/scans` (history) correctly excludes it. The message says
  plainly that a person stopped it.
