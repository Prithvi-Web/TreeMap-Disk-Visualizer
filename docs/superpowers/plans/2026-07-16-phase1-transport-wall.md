# Phase 1: Break the 2M Transport Wall — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TreeMap displays scans of 5,000,000 items instead of dying at ~2M, while making scan→paint **faster than stock v2.1.0**, not slower.

**Architecture:** The pruned-tree work already in the working tree fixes the transport (the tree never crosses to the UI as one >512MB JSON string). It was rolled back because it moved the headline paint *behind* four API round-trips, three of which walk the whole tree server-side. This plan commits that work as a baseline, then makes the paint instant by carrying the scan's already-computed counters on the SSE `complete` event — so `finishScan` needs zero awaits to show a number — and makes the Clean Up modal's tree walk lazy.

**Tech Stack:** TypeScript, Express 5, SSE, Electron, `tsx --test` (node:test), vanilla single-file frontend.

---

## Background: the measured diagnosis

Measured on this machine (Apple M3, 8 cores, 16 GB), tree = `/Applications` (458,193 objects):

| Work blocking the headline paint in the rolled-back build | 458k | projected 4M |
|---|---|---|
| `/api/large-files` (`collectLargestFiles`, full walk) | 17.5ms | |
| `/api/file-types` (`collectFileTypes`, full walk) | 48.2ms | |
| `/api/large-folders` (`collectLargestFolders`, full walk) | 27.2ms | |
| `pruneTree` on the `complete` event | 120.7ms | |
| **total awaited before any number appears** | **213.6ms** | **~1.9s** |

Plus `renderDiskNotes()` → `renderCloudSafe()` → `/api/cleanup/cloud-safe`, another
full server walk fired on **every scan completion** for a modal that is closed.

**Stock painted the headline *before* any of this**, by counting `state.pathIndex`
locally. The pruned tree cannot be counted locally (it would under-report), so
every number moved server-side — and the paint moved behind the round-trip.

**Key enabling fact:** `GET /api/scan/:scanId/stats` is **O(1)** — it reads
`scan.fileCount` / `scan.dirCount` counters the walker already maintains during
the walk. Those exact numbers can ride along on the `complete` event for free,
eliminating the round-trip entirely.

**Caveat to keep honest:** at 153k files the added latency is only ~0.2s, which
does *not* explain the reported "so much slower". Run-to-run variance on an
identical tree measured 4.74s / 5.15s / 6.60s (40% swing) from background
contention. Task 5's gate exists to settle this with numbers rather than
argument.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/models/types.ts` | `ScanEvent` union; `ScanStats` shape | Modify — add stats to `complete` |
| `src/api/scanRoutes.ts` | SSE stream, `/result`, `/subtree` | Modify — emit stats on `complete`; extract shared stats builder |
| `public/index.html` | `finishScan`, SSE handler, `renderDiskNotes` | Modify — paint before awaits; lazy cloud-safe |
| `tests/scanProgress.test.ts` | progress-stream failure modes | Modify — assert stats on `complete` |
| `tests/scanStatsPayload.test.ts` | stats-on-complete contract | Create |

---

## Task 1: Commit the pruned-tree baseline

The transport fix is already written and passing (118/118). Commit it **unchanged**
first, so any later regression is attributable to a specific commit rather than to
one undifferentiated blob. This is the discipline whose absence caused the rollback.

**Files:**
- Commit: `src/utils/pruneTree.ts`, `src/services/scanQueries.ts`, `src/api/scanRoutes.ts`, `src/api/settingsRoutes.ts`, `src/middleware/rateLimiter.ts`, `src/models/types.ts`, `src/services/offload.ts`, `src/services/perceptualDupes.ts`, `public/index.html`, `tests/*.test.ts`

- [ ] **Step 1: Confirm the suite is green before committing anything**

Run: `npm test 2>&1 | tail -8`
Expected: `pass 118`, `fail 0`

- [ ] **Step 2: Confirm typecheck is clean**

Run: `npm run typecheck`
Expected: no output, exit 0

- [ ] **Step 3: Commit the baseline**

```bash
git add src/utils/pruneTree.ts src/services/scanQueries.ts \
        src/api/scanRoutes.ts src/api/settingsRoutes.ts \
        src/middleware/rateLimiter.ts src/models/types.ts \
        src/services/offload.ts src/services/perceptualDupes.ts \
        public/index.html tests/
git commit -m "feat(scan): bound the tree crossing to the UI (prune + fetch on demand)

The SSE 'complete' event shipped the entire FileNode tree as one JSON string.
V8 caps a single string at 536,870,888 chars and the tree costs ~253 B/node,
so serialization threw RangeError at ~2.02M nodes -- matching the reported
'can only scan up to 2 million files' exactly.

pruneTree bounds the payload at PRUNE_MAX_NODES with whole-directory
granularity and exact sizes; withheld branches are fetched from
/api/scan/:id/subtree on drill-in. scanQueries answers the counts the browser
can no longer compute from a pruned tree.

Known defect, fixed in the next commit: finishScan now awaits four API calls
before painting the headline, three of which walk the whole tree server-side.
That is the regression behind the July 16 rollback."
```

- [ ] **Step 4: Verify the working tree is clean and history is right**

Run: `git status --short && git log --oneline -2`
Expected: no modified files; the new commit on top of `0c4bbfa`

---

## Task 2: Carry scan stats on the `complete` event (server)

`/stats` is O(1) counters. Put them on the `complete` frame so the client needs
no round-trip to paint.

**Files:**
- Modify: `src/models/types.ts` (the `ScanEvent` union)
- Modify: `src/api/scanRoutes.ts` (`finish()` and `/stats`, sharing one builder)
- Test: `tests/scanStatsPayload.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/scanStatsPayload.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';
import { FileNode, ScanEvent } from '../src/models/types';

/**
 * The 'complete' frame must carry the scan's counters.
 *
 * A pruned tree cannot be counted client-side (that under-reports), so every
 * headline number comes from the server. If those numbers need a round-trip,
 * the paint waits on three full server-side tree walks -- the regression that
 * caused the July 16 rollback. The counters are O(1) on ScanResult already,
 * so they ride along on the frame the client is already receiving.
 */

function tinyRoot(): FileNode {
  return {
    name: 'root', path: '/t', size: 3, type: 'dir', modifiedAt: 0, isHidden: false,
    children: [
      { name: 'a.txt', path: '/t/a.txt', size: 3, type: 'file', modifiedAt: 0, isHidden: false },
    ],
  };
}

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((r) => { server.close(() => r()); }) };
}

/** Read SSE frames until `complete` (or `error`) arrives. */
function readUntilComplete(port: number, scanId: string): Promise<ScanEvent> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/api/scan/${scanId}/progress` }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString();
        for (const chunk of buf.split('\n\n')) {
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6)) as ScanEvent;
          if (ev.type === 'complete' || ev.type === 'error') { req.destroy(); resolve(ev); return; }
        }
      });
      res.on('error', reject);
    });
    req.on('error', () => { /* destroyed on success */ });
  });
}

test("the 'complete' frame carries counters so the client can paint without a round-trip", async () => {
  const { port, close } = await listen();
  try {
    const scan = createScanRecord('/t');
    scan.status = 'complete';
    scan.root = tinyRoot();
    scan.fileCount = 1;
    scan.dirCount = 1;
    scan.scanned = 2;
    scan.finishedAt = scan.startedAt + 1234;

    const ev = await readUntilComplete(port, scan.scanId);
    assert.equal(ev.type, 'complete');
    const c = ev as Extract<ScanEvent, { type: 'complete' }>;
    assert.ok(c.stats, 'complete frame must carry stats');
    assert.equal(c.stats.fileCount, 1);
    assert.equal(c.stats.dirCount, 1);
    assert.equal(c.stats.durationMs, 1234);
    assert.equal(c.stats.engine, scan.engine ?? 'walker');
  } finally {
    await close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/scanStatsPayload.test.ts`
Expected: FAIL — TypeScript error that `stats` does not exist on the `complete` variant, or `c.stats` is undefined.

- [ ] **Step 3: Add the `ScanStats` type and widen the event**

In `src/models/types.ts`, add above `ScanEvent`:

```ts
/**
 * The counters a client needs to paint headline numbers. All are O(1) reads off
 * ScanResult -- the walker maintains them during the walk -- so they ride along
 * on the 'complete' frame rather than costing a round-trip. This matters because
 * a pruned tree cannot be counted client-side without under-reporting.
 */
export interface ScanStats {
  scanned: number;
  fileCount: number;
  dirCount: number;
  engine: string;
  ioThreads: number;
  durationMs: number;
  incremental: boolean;
  cachedDirs: number;
  walkedDirs: number;
  hardlinkedFiles: number;
  hardlinkedBytes: number;
  cloudFiles: number;
  cloudBytes: number;
}
```

Then change the `complete` variant:

```ts
export type ScanEvent =
  | { type: 'progress'; scanned: number; currentPath: string }
  | { type: 'complete'; root: FileNode; stats: ScanStats }
  | { type: 'error'; message: string }
  | { type: 'shutdown' };
```

- [ ] **Step 4: Extract one stats builder and use it in both places**

In `src/api/scanRoutes.ts`, add near the top (after the imports):

```ts
/** The one place scan counters are shaped, shared by /stats and the SSE frame. */
export function buildScanStats(scan: ScanResult): ScanStats {
  return {
    scanned: scan.scanned,
    fileCount: scan.fileCount,
    dirCount: scan.dirCount,
    engine: scan.engine ?? 'walker',
    ioThreads: scan.ioThreads ?? 0,
    durationMs: scan.finishedAt ? scan.finishedAt - scan.startedAt : 0,
    incremental: scan.incremental === true,
    cachedDirs: scan.cachedDirs ?? 0,
    walkedDirs: scan.walkedDirs ?? 0,
    hardlinkedFiles: scan.hardlinkedFiles ?? 0,
    hardlinkedBytes: scan.hardlinkedBytes ?? 0,
    cloudFiles: scan.cloudFiles ?? 0,
    cloudBytes: scan.cloudBytes ?? 0,
  };
}
```

Add `ScanStats` to the `../models/types` import list.

In `finish()`, attach them:

```ts
  const finish = (): void => {
    if (scan.status === 'complete' && scan.root) {
      // Pruned: the full tree may be far larger than the UI can hold. The
      // sseSend guard below stays as a backstop — pruning should mean it never
      // trips, but a timer throw would take the app down, so we keep the net.
      const { root } = pruneTree(scan.root, { maxNodes: PRUNE_MAX_NODES });
      // Counters ride along: a pruned tree can't be counted client-side, and
      // making the client fetch them puts three full tree walks in front of
      // the headline paint.
      if (!sseSend(res, { type: 'complete', root, stats: buildScanStats(scan) })) {
        sseSend(res, { type: 'error', message: treeTooLargeMessage(scan) });
      }
    } else {
      sseSend(res, { type: 'error', message: scan.error ?? 'Scan failed' });
    }
    closeClient(client);
  };
```

Replace the body of the `/stats` route with the shared builder:

```ts
/** GET /api/scan/:scanId/stats — counters incl. incremental cache usage. */
scanRouter.get('/scan/:scanId/stats', (req: Request, res: Response) => {
  const scan = requireScan(req, req.params.scanId);
  res.json({ scanId: scan.scanId, status: scan.status, ...buildScanStats(scan) });
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test tests/scanStatsPayload.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full suite — the `complete` shape changed, so existing tests must still agree**

Run: `npm test 2>&1 | tail -8`
Expected: `fail 0`. If `tests/scanProgress.test.ts` constructs a `complete` event literal, add `stats: buildScanStats(scan)` to satisfy the widened type.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0

- [ ] **Step 8: Commit**

```bash
git add src/models/types.ts src/api/scanRoutes.ts tests/scanStatsPayload.test.ts tests/scanProgress.test.ts
git commit -m "feat(scan): carry scan counters on the SSE complete frame

/stats is O(1) counters the walker already maintains, so shipping them on the
frame the client is already receiving costs nothing and removes the round-trip
that finishScan was awaiting before it could paint a number."
```

---

## Task 3: Paint before the awaits, fill the lists in after

**Files:**
- Modify: `public/index.html` — `finishScan`, and its two call sites (SSE `complete` handler, `/result` watchdog fallback)

- [ ] **Step 1: Change `finishScan` to accept stats and paint immediately**

Replace the `finishScan` signature and the block from `state.dup = {...}` through the
`$('statLastScan')` line with the following. The key change: **the headline paints
before any `await`.** The three list endpoints each walk the whole tree, so they
move *after* the paint and fill in when they land.

```js
async function finishScan(root, durationMs, stats) {
  endScanChrome();
  state.root = root;
  indexTree(root);
  state.lastScan = { when: Date.now(), durationMs };
  state.treemap.rootPath = root.path;
  state.grid.path = root.path;
  state.grid.selection.clear();
  updateSelectionBar();

  state.dup = { loadedFor: null, status: 'idle', groups: [], groupCount: 0, totalReclaimable: 0, selection: new Set(), pollTimer: 0 };
  state.apps.loadedFor = null;

  // `root` is pruned to a node budget, so counting the tree we just indexed
  // would under-report any large scan. The counters come from the server, which
  // holds the whole thing — and they arrive ON the complete frame, so painting
  // costs no round-trip. root.size is exact even when pruned.
  //
  // Everything below this comment must stay synchronous: the three list
  // endpoints each walk the entire tree server-side, and awaiting them before
  // the paint is what made a 4M-item scan look frozen for ~2s.
  state.scanStats = stats || null;
  const files = stats ? stats.fileCount : null;
  const dirs = stats ? stats.dirCount : null;

  $('scanStatus').classList.remove('error');
  $('scanStatus').innerHTML = icon('checkCircle', 14) +
    `<span class="num">Scanned ${files === null ? '' : `<b>${formatCount(files)}</b> files `}` +
    `in ${(durationMs / 1000).toFixed(1)}s — ${formatBytes(root.size)} in ${escapeHtml(root.path)}</span>`;
  if (files !== null) countUp($('statFiles'), files);
  if (dirs !== null) countUp($('statDirs'), dirs);
  $('statLargest').textContent = '–';
  $('statLastScan').textContent = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  renderDiskNotes();
  toast(`Scan complete — ${formatBytes(root.size)}${files === null ? '' : ` across ${formatCount(files)} files`}`);

  // Painted. Now the expensive server-side walks, filling in as they land.
  state.largest = []; state.types = []; state.bigFolders = [];
  try {
    const [lf, ft, lfo] = await Promise.all([
      api(`/api/large-files?scanId=${state.scanId}&limit=10&minSize=1`),
      api(`/api/file-types?scanId=${state.scanId}`),
      api(`/api/large-folders?scanId=${state.scanId}&limit=10`),
    ]);
    state.largest = lf.files; state.types = ft.types; state.bigFolders = lfo.folders;
    seedNodes(lf.files); // right-click/cart on a big file must resolve even if pruned away
    const largest = state.largest[0] || null;
    $('statLargest').textContent = largest ? `${largest.name} · ${formatBytes(largest.size)}` : '–';
  } catch (e) { toast('Could not load stats: ' + e.message, 'error'); }

  renderBigFiles();
  renderBigFolders();
  state.donut.animated = false;
  renderDonut();
  if (state.view === 'treemap') loadTreemap(root.path);
  if (state.view === 'grid') renderGrid();
  switchView(state.view);
  renderGrowthProjection();
  loadBudgets();
  // The snapshot (and its time-slider tree) is saved asynchronously after the
  // scan completes — pick it up once it lands.
  setTimeout(() => { if (state.view === 'treemap') refreshTimebar(); }, 1500);
  if (state.live.wanted) enableLive(); // Live survives rescans
}
```

- [ ] **Step 2: Pass stats from the SSE `complete` handler**

In the `msg.type === 'complete'` branch, change the `finishScan` call:

```js
      finishScan(root, performance.now() - t0, msg.stats);
```

- [ ] **Step 3: Pass stats from the `/result` watchdog fallback**

`/result` already returns `fileCount`, `dirCount`, `engine`, `hardlinkedFiles`,
`cloudFiles` and friends at the top level, so the fallback path can build the same
shape. In the watchdog's `r.status === 'complete'` branch:

```js
        finishScan(r.root, performance.now() - t0, {
          scanned: r.scanned, fileCount: r.fileCount, dirCount: r.dirCount,
          engine: r.engine, ioThreads: r.ioThreads,
          durationMs: r.finishedAt && r.startedAt ? r.finishedAt - r.startedAt : 0,
          incremental: !!r.incremental, cachedDirs: r.cachedDirs || 0, walkedDirs: r.walkedDirs || 0,
          hardlinkedFiles: r.hardlinkedFiles || 0, hardlinkedBytes: r.hardlinkedBytes || 0,
          cloudFiles: r.cloudFiles || 0, cloudBytes: r.cloudBytes || 0,
        });
```

There is a second `/result` call in the same file (the non-SSE path around line
2177) — apply the identical change there.

- [ ] **Step 4: Verify no `finishScan` call site was missed**

Run: `grep -n "finishScan(" public/index.html`
Expected: the definition plus exactly the call sites you edited — every call passes three arguments.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "perf(ui): paint the scan headline before the tree-walking fetches

finishScan awaited four API calls before showing any number; three of them walk
the whole tree server-side, so a 4M-item scan showed nothing for ~2s after the
scan had actually finished. The counters now arrive on the complete frame, so
the headline paints synchronously and the list endpoints fill in behind it."
```

---

## Task 4: Make the Clean Up modal's tree walk lazy

`renderDiskNotes()` ends by calling `renderCloudSafe()`, which fetches
`/api/cleanup/cloud-safe` — a full server-side tree walk — on **every scan
completion**, to populate a modal that is closed.

**Files:**
- Modify: `public/index.html` — `renderDiskNotes`, and the Clean Up modal's open handler

- [ ] **Step 1: Drop the eager call**

At the end of `renderDiskNotes()`, remove the `renderCloudSafe();` line and replace
it with a comment recording why:

```js
  // renderCloudSafe() walks the whole tree server-side. It populates the Clean
  // Up modal, so it runs when that modal opens — not on every scan completion.
```

- [ ] **Step 2: Call it from the Clean Up button instead**

The opener is `$('cleanupBtn')`'s click handler (`public/index.html`, ~line 5598).
Its last statement is `$('cleanModal').classList.add('open');`. Add the call right
after it, so the list builds when the modal is actually about to be seen:

```js
  setCleanPane('rules', true);
  $('cleanModal').classList.add('open');
  // Walks the whole tree server-side, so it runs on open rather than on every
  // scan completion. It also un-hides the Cloud-safe tab, which lives inside
  // this modal — so gating it on open costs no visible affordance.
  renderCloudSafe();
});
```

- [ ] **Step 3: Confirm nothing else depended on the eager call**

`renderCloudSafe()` sets `$('cleanTabCloud').hidden` and fills `$('cloudResults')`.
Both live inside `#cleanModal`, so neither is observable until the modal opens.
The treemap's cloud toggle (`tmCloudToggle`) is set by `renderDiskNotes` from
`stats.cloudFiles` — an O(1) counter, unaffected by this change.

Run: `grep -n "cloudResults\|cleanTabCloud" public/index.html`
Expected: every reference is inside the Clean Up modal markup or `renderCloudSafe`
itself — nothing outside the modal reads them.

- [ ] **Step 4: Verify the Clean Up modal still populates**

This is checked live in Task 6, Step 4 — the modal must still list cloud-safe
files after a scan, and the Cloud-safe tab must still appear when the scan found
placeholders.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "perf(ui): build the cloud-safe list when the Clean Up modal opens

renderDiskNotes fired a full server-side tree walk on every scan completion to
fill a modal that was closed."
```

---

## Task 5: The gate — scan→paint must beat stock

This is the bar the previous attempt failed. **If this task's measurement is not
faster than stock, stop and report — do not proceed to Phase 2.**

**Files:**
- Uses: `/private/tmp/claude-501/-Users-prithvivinay-Desktop-Claude-Code/5eeae7de-cd40-43d2-9e27-977c8df1780a/scratchpad/benchPaint.ts` (already written; throwaway, not committed)

- [ ] **Step 1: Measure the server-side post-scan work on the new code**

Re-run the existing harness against a real tree:

Run: `npx tsx /private/tmp/claude-501/-Users-prithvivinay-Desktop-Claude-Code/5eeae7de-cd40-43d2-9e27-977c8df1780a/scratchpad/benchPaint.ts /Applications`
Expected: `blockingBeforePaintMs` is now only `pruneTree` (~120ms at 458k) — the
three `collect*` walks no longer sit in front of the paint.

- [ ] **Step 2: Measure scan→paint end-to-end in the real app, stock vs new**

Launch the app (`npm run app`), scan `/Applications`, and record the wall-clock
from pressing Scan to the headline number appearing. Do this **with nothing else
running** — background build contention produced a 40% swing (4.74s / 5.15s /
6.60s) on identical trees and is the most likely explanation for the original
"21.7s" report.

Repeat 3× on each build. Compare medians:
- stock = `git stash` the Phase 1 commits, or check out `089a7dc` in a worktree
- new = current HEAD

- [ ] **Step 3: Record the result in the plan**

Write the six numbers and the two medians into this file under a `## Results`
heading, and state plainly whether the gate passed.

- [ ] **Step 4: Gate decision**

- New median ≤ stock median → proceed.
- New median > stock median → **stop.** Report the numbers and diagnose before
  going near Phase 2. Shipping a second scan engine on top of an unexplained
  slowdown is exactly how the last rollback happened.

---

## Task 6: Full verification

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0

- [ ] **Step 2: Full test suite**

Run: `npm test 2>&1 | tail -8`
Expected: `fail 0`, and the count is ≥ 119 (118 baseline + the new stats test)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exit 0, `dist/` refreshed

- [ ] **Step 4: Drive the real app**

Launch (`npm run app`) and confirm on a real scan:
- the headline number appears essentially at scan completion, not seconds later
- file/dir counts are **exact** (cross-check against `find <path> | wc -l`)
- largest-file tile fills in shortly after the headline
- the treemap renders and drill-in works into a pruned folder
- the Clean Up modal still lists cloud-safe files (Task 4 moved this)
- cancel still works mid-scan

- [ ] **Step 5: Commit any fixes, then report**

Report to the user: the gate numbers from Task 5, the suite result, and what was
verified live — before starting Phase 2.

---

## Out of scope for this plan

- The gdu engine (Phase 2) — its own plan, written only after this gate passes.
- Caching `pruneTree` per scan. It runs once on `complete`; `/result` is only the
  watchdog fallback, so the two rarely both fire. YAGNI until measured.
- `MTIME_CACHE_MAX_NODES` (300k incremental-rescan cap). It silently no-ops above
  the cap rather than breaking anything, and it is orthogonal to the 2M wall.
  Revisit after the gate.
