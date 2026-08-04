# Session restore — design

**Date:** 3 August 2026
**Status:** approved-by-delegation (user asked to be surprised with one genuinely
useful, error-free feature; the choice was delegated, so the interactive
approval gates were satisfied by that standing instruction).

## Problem

TreeMap forgets everything on every launch. A user who scans the same folder
daily — which the scan history shows is the normal pattern — re-picks and
re-scans it by hand every single time the app opens. The server already keeps
scan history (`GET /api/scans`), a live index that can paint a tree instantly,
and an incremental rescan path; none of that reaches the boot experience.

## Alternatives considered

1. **Session restore (chosen).** On boot, silently bring back the last scanned
   folder through the existing `startScan()` path. Frontend-only; every hard
   part (instant index paint, quiet background reconcile, progress chrome,
   error surfaces) already exists and is already tested.
2. **⌘K command palette.** Duplicates the sidebar's global search; wrong
   audience (the app's user is not keyboard-first); new focus-trap surface to
   get wrong.
3. **Report export.** Already exists server-side (`/api/scan/:id/export`);
   not a surprise.

## Behaviour

At boot, after the view registry mounts:

1. `GET /api/scans` → newest completed scan (the endpoint only returns
   completed scans and orders newest-first).
2. Skip restore entirely when: no history; a scan is already loaded or
   running; the last scan is `cloud://` (auth may be gone); or the folder no
   longer lists via `GET /api/fs/list?path=` (moved/deleted — the picker's
   own endpoint, so the check costs nothing new).
3. Otherwise call `startScan(rootPath)` — the same function the Scan button
   uses. If the live index knows the folder, the tree paints instantly and
   the reconciling rescan runs quietly underneath; if not, the standard scan
   progress chrome shows. Either way existing UI communicates state; no new
   banner is added.
4. Any failure is swallowed to a `console.warn` and the welcome screen stays —
   restore must never make boot worse than it was.

## Testing

- Frontend contract test pins: `restoreLastSession` exists, consults
  `/api/scans`, pre-flights with `/api/fs/list`, refuses `cloud://`, and is
  invoked at boot (all against comment-stripped app code, non-empty-slice
  asserted, per the repo's contract-test conventions).
- Manual verification in the running app: reload with history present →
  data returns with zero clicks; reload with empty data dir → welcome screen
  unchanged.
