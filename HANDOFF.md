# TreeMap — session handoff

## v4 — Phase 6 finished, and the CI red run explained (28 August 2026)

**The red macOS check was never Phase 6.** Phase 6's own tests have not failed
once, on any platform, in any run. The failures were pre-existing, and reading
them was the whole difficulty: job logs need admin rights
(`403 Must have admin rights to Repository`), step summaries are not in the
REST API, and the step that was supposed to publish annotations **could not
finish** — GitHub runs `shell: bash` as `bash -e -o pipefail`, so the step's
`grep '^# Error'`, which matches nothing on an ordinary failure, killed it
before it wrote the summary. Every red run published a test NAME and threw its
assertion away.

### What was actually failing

| Failing test | OS | Cause |
| --- | --- | --- |
| `agent summary: raw+formatted bytes…` | Windows | `diskUsage` spawned PowerShell with a 10 s ceiling; a loaded runner missed it, the forecast reported `freeBytes: 0` |
| `with no env vars, the API is open…` | Windows | same call, uncaught in `/api/system` → 500 |
| `an external create, resize and delete…` | macOS | **two** causes: a transient `lstat` read as a deletion, and a `fs.watch` that attaches and delivers nothing |
| `reading a tree stays sub-quadratic…` | macOS | a ratio of two single timings; reproduced at **25.6x** on linear code |

`diskUsage` now answers from `statfs` — one syscall, no subprocess — with the
OS tools kept as a bounded fallback. `tests/diskUsage.test.ts` cross-checks the
two on whatever platform CI is running, so the Windows question is answered on
the runner rather than in a comment.

### The bug that was worth the search

A bare `catch { stat = null /* gone */ }` around the watcher's `lstat`, where
`stat === null` runs `deleteSubtree`. Injecting ONE `EMFILE` deleted a live
50,000-byte file from the index while it sat on disk. Full account below under
"The long-standing intermittent". The same bug class was then found in twelve
other places; the ones that could destroy or misreport user data are fixed and
listed there.

### Phase 6 itself

Audited requirement by requirement against §6.1-§6.4. Three real defects, all
fixed and all verified in the running app on a 322 MB scan rather than by
reading:

- **The LOD texture was wrong in both directions.** `hatched` keyed off a
  single number for the whole layout, so it marked nothing in exactly the case
  the texture exists for. Measured after: 127 of 236 drawn folders marked,
  matching an independent recomputation exactly.
- **Switching Disk City's colour dropped the per-building jitter.** Type mode
  has only **5** base colours, so 731 buildings flattened into 5, with 334
  identical in one group. After: 293 distinct shades in that group.
- **Escape did nothing in Disk City** unless the canvas had been clicked.
  §6.1 asks for "Escape to climb out"; it now has exactly one owner.

`tests/isoProjection.test.ts` gained the LOD-threshold coverage §6.1's "Tests:"
paragraph asks for and that had never existed — which is what let the texture
bug ship.

### Verified

```
npm run build      clean
npm run typecheck  clean
npm test           1,378 tests · 1,376 pass · 0 fail · 2 skip
npm run bench:v4   7 pass / 3 not measurable in Node
```

Driven in the browser: all four renderers, Disk City with drill-in and Escape,
a real mouse-drag lasso (9 items staged, no accidental drill), the 4x
magnifier, all 15 views, zero console errors.


## v4 — Phase 6 complete: the visual core (27 August 2026)

**Five commits on `main`, on top of the two that were already there** (`25553a4`
6.0 subtreeCount, `81191ef` 6.1 Disk City). Suite **1326 (1324 pass, 2 skip, was
1275)**, typecheck clean, build clean, `npm run bench:v4` **7 pass / 3 not
measurable in Node** with scan throughput **7.5% FASTER** than baseline, golden
responses untouched — Phase 6 added **no endpoint and no field**, so there was
nothing for §2.1 to object to.

| Commit | What |
| --- | --- |
| `369b592` | 6.2 two more lenses on the same tree — circle packing and a Voronoi treemap |
| `7aa65bc` | 6.3/6.4 a lasso and a magnifier |
| `b00cd84` | 6.1 give the buildings a light to stand in |
| `eb7f556` | 6.2 the Voronoi solver had no bound on its own work |
| *(this one)* | 6.5 docs, the reduced-motion contract, and the highlight scrim |

### The four bugs the browser found and the tests could not have

Every one of these was invisible to reading and to unit tests, and each is now
pinned by an assertion that fails on the mutation.

**1. The circle packing's tangent placement was mirrored.** Nothing about the
picture said so: every circle was still tangent to exactly two neighbours, they
were simply tangent on the wrong side and lay on top of what was already there.
A ten-circle pack overlapped by 59 units inside a 200-unit radius. Found by
asserting sibling overlap directly rather than by looking at bubbles.

**2. Disk City's shadows fell in a direction where none of them could ever be
seen.** A treemap **tiles its ground completely** — there is no bare floor
anywhere. Shadows swept toward the viewer land on ground belonging to buildings
drawn later, and every one of those painted over its shadow. The light now
sweeps back and to the left, onto roofs drawn earlier, and the sign of `x + y`
is an asserted invariant rather than a constant somebody liked.

**3. The Voronoi solver had no bound on its own work.** A real `node_modules`
(386 children, wild spread) spent **2,715 ms** on one layout against §2.5's
250 ms first-paint budget, and still reported its worst cell 466% off. The
per-attempt iteration cap was doing exactly what it said; nothing bounded how
many attempts there could be. Now capped as WORK across the whole call — a pass
over ninety cells costs sixteen times one over twenty-two — with a descent that
gives up a quarter of the cells while a layout is still expensive. Worst first
paint measured after: **195.8 ms**.

**4. The magnifier culled the label of the tile it was pointing at.** At 4× one
cell often covers the whole lens, so its true centre is far outside the glass.
Labels are placed on the part of the tile that is ON the glass now.

### The Voronoi solver, and what it costs to make "area is bytes" true

Four things were measured into it, each replacing something that looked
reasonable:

| Looked reasonable | What it did | What it is now |
| --- | --- | --- |
| Cap each weight at its own distance to its nearest neighbour | Big cell cannot grow when a small sibling sits near it — worst cell stuck at **389%** | Cap `w_i` at `min_j (w_j + d_ij²)` — the condition that actually matters. Same input: **1.95%** |
| Reset a collapsed weight to the starting value | Throws the diagram back to the beginning — 56 cells stalled at **32%** | Floor it just above zero: **2%** |
| A fixed iteration cap | 240 starves six cells to **249%** and is a fifth of a second over ninety-six | Scale it: constant total work, `1.5e6 / n²` |
| Keep iterating until it converges | Cannot, on extreme dynamic range | Shrink the question and say how much: drop the smallest cell and ask again |

The last one is the product decision. What defeats this algorithm is dynamic
range, not size — one child at 98.9% of a real Desktop left the worst cell 125%
off after both starting points and 2,400 passes. Dropping the cells already
closest to the legibility floor turns "an approximate map of everything" into
"an exact map of what fits, and a count of what did not", which is the trade
this project makes everywhere else.

**The reported error is per cell against its OWN target, never the sum over the
diagram.** That gentler figure — the one every paper reports — reads under 1% on
a map whose smallest cell is twice the size it should be.

### §6.3's spec contradicts itself, and how it was resolved

§6.3 asks for "freehand (hold Alt)" and, one sentence later, "Alt subtracts".
Alt cannot do both. **Freehand won**, because a modifier that changes the SHAPE
of a gesture must be decided before the drag starts while add-or-subtract can be
decided at any point during it. Subtract moved to ⌘/Ctrl; Shift is accepted as a
synonym for add so the muscle memory still works.

**And no gesture empties the cart.** "Shift extends" reads as though a plain
lasso should replace the selection, and replace is the one behaviour that could
silently throw away staging done in four other views. A test asserts no code
path in `lassoApply` can clear it.

The sunburst is the one renderer with no lasso, and it says so rather than
offering a dead gesture: its rings are drawn nested, so "everything whose centre
is inside" would stage a folder and its contents twice and report a total the
disk does not have.

### Numbers, measured on this Mac

Real folder, 328,278 files, 16.7 GB, in the browser:

| | Measured | §2.5 budget |
| --- | --- | --- |
| Disk City first paint (4,108 blocks laid out) | 44.5 ms | 250 ms |
| Disk City frame, 351 blocks | 4.2 ms median · 7.6 ms p95 | 16 / 33 ms |
| Circle pack, worst first paint over four folders | 23.1 ms | 250 ms |
| Voronoi, worst first paint over four folders | 195.8 ms | 250 ms |
| Either, repaint during the level transition | 0.6 ms median · 1.5 ms p95 | 16 / 33 ms |
| Magnifier overlay, added to a present pass | +0.2 ms median · +1.3 ms p95 | 16 / 33 ms |

Lasso, driven live: a rubber band staged 194 items in one drag; ⌘ over the same
region took the cart from 194 to 31 and reported the 38 it caught that were not
in it; the Disk City lasso staged 74 buildings (15.5 GB) and did **not** drill
into whatever was under the release.

### What could NOT be verified in this session

- **The 250k-node payload §2.5 names.** The biggest tree reachable here is
  328,278 files, which the server prunes to a **3,867-node** payload at depth 6.
  Every first-paint figure above is against that, not against 250k. The number
  that IS at scale is Disk City's layout: 4,108 blocks sorted and projected in
  44.5 ms, and `isoProjection.test.ts` orders 4,000 synthetic blocks in a test
  that fails above 120 ms.
- **A folder whose Voronoi map needs more than 24 shrink attempts.** The
  synthetic 2,179:1 fixture is the only input in the suite that still comes back
  `converged: false`, and it is covered by a test that asserts the *reporting*
  is honest rather than that it converges. No real folder here reproduced it.
- **`prefers-reduced-motion` under a real OS setting.** This machine is not set
  to reduce motion and the preview browser cannot emulate it, so what runs here
  is the animated path. The guarantee is asserted structurally instead: a
  contract test requires every animation ENTRY POINT — `cityMorphHeights`,
  `cityEnter`, `cityAnimateZoom`, `altBeginZoom` — to consult `REDUCED` before
  it starts, and it fails when any one of them stops doing so.
- **Windows and Linux.** Nothing in Phase 6 is per-OS — it is all Canvas 2D over
  data the existing endpoints already return — but no non-Mac browser ran it.

### Two things worth knowing about the renderers

1. **The tree-based renderers see more than the treemap does.** Sunburst,
   Circles and Voronoi read the in-memory tree through `ensureSubtree`; the
   treemap draws the server's pruned payload with `minSize=4096`. On a folder of
   very small files the treemap can legitimately show "0 nodes · 0 drawn" while
   Circles shows seventeen. Pre-existing, and consistent between the three.
2. **Scanning `/Users/prithvivinay` hung twice** on
   `~/Library/Group Containers/BJ4HAAB9B3.ZoomClient3rd`, with the progress
   counter frozen for twenty minutes. `~/Desktop` (328k files, 5.4 s) was used
   instead. Not investigated and not obviously Phase 6's doing — it reproduced
   before any change in this session — but somebody should look.

## v4 — Phase 5 complete: The Missing Gigabytes (27 August 2026)

**Three commits on `main`.** Suite **1251 (1249 pass, 2 skip, was 1220 with one
failing)**, typecheck clean, build clean, `npm run bench:v4` **7 pass / 3 not
measurable in Node** with scan throughput **2.5% FASTER** than baseline, golden
responses still byte-identical.

| Commit | What |
| --- | --- |
| `a6c53c7` | 5.0 diskutil can answer "no disks" and mean "ask again" |
| `56125b4` | 5.1 one accounting statement, and it balances or names the gap |
| `6f254cf` | 5.2 the receipt, and the two ways it can be read wrong |

### The baseline was not green, and it was not a flake

`A5: topology on this machine names real hardware and real mount points` failed
in the full suite and passed alone — which reads exactly like trap 5's watcher
family. It is not one.

Measured over 180 concurrent `diskutil list -plist` calls: **9 (5%)** exit
**0**, write nothing to stderr, and emit a complete, well-formed 335-byte plist
in which every array is empty — `WholeDisks`, `AllDisksAndPartitions`,
`AllDisks`, `VolumesFromDisks`. Nothing distinguishes it from a real answer
except content that cannot be true: a running Mac runs *from* a disk.

So `volumeTopology()` re-asks (bounded at three) and **throws** when it will
not clear. Every empty answer measured recovered on the immediate next call, 6
of 6, with no delay. Verified against the load that caused it: 180 concurrent
reads, 180 correct answers, zero empty successes. Before the fix the same load
gave 9 wrong ones.

**The lesson, and it is trap 5's inverse:** trap 5 says read the failing test
name before re-running. This adds — *and then check whether it is actually that
family.* A test that fails only under contention is not automatically a timing
flake; here it was a reader that returns a confidently wrong answer 5% of the
time under load, and the Drives panel has been showing "no drives" that often
for as long as it has existed.

### The two numbers that decide whether the statement is right

**The reference total is the container, not the volume.** `statfs('/')` and
`statfs('/System/Volumes/Data')` return byte-identical answers here, and both
agree with `diskutil info -plist`'s `APFSContainerSize`/`Free`. That is the
pool everything draws from and the figure the Finder shows. It also makes the
siblings a real line: Preboot, VM, Update and one unmounted volume hold ~12.5 GB
that no scan of `/` ever walks — measured live at exactly 12.49 GB.

**Which volume a scan is on is decided by `stat().dev`, never by path prefix.**
`/Users` is a firmlink onto the data volume, so `/Users/me` is under `/` by
string and on `/System/Volumes/Data` in fact. The first version of the file used
prefix matching and therefore attributed a home-folder scan to the sealed 12 GB
system volume while booking the 163 GB data volume as somebody else's — an error
the size of the disk. `/`, the Data volume and everything under them all report
device **16777233**; VM reports 16777232. The kernel presents the firmlinked
pair as one device, which is exactly the unit a scan of `/` walks, so device
grouping gets firmlinks right without naming one.

### Two honest unavailables, both checked rather than assumed

- **Purgeable cannot be read.** `diskutil info -plist`, `diskutil apfs list
  -plist` and `system_profiler -json SPStorageDataType` were each read on this
  machine and none carries the figure. It needs
  `NSURLVolumeAvailableCapacityForImportantUsageKey`, a native API, and §7
  forbids native modules. The line is unavailable with that reason, its bytes
  sit in `unaccounted`, and `unaccounted` names it. It never reads 0.
- **gdu cannot report what it was refused.** Pointed at a mode-000 directory,
  `gdu -o-` exits 0 and emits it as an ordinary *empty* directory — no error
  key, no annotation, indistinguishable from a directory that genuinely has
  nothing in it, and `gdu --help` offers no flag that changes it. So on a gdu
  scan the refusal count is unknown and says so. The walker now counts refusals
  exactly (`readdirWithDeadline` used to collapse EACCES, ENOENT and its own
  deadline into one `null`), and only the walker claims a zero.

### New traps, all paid for

- **A counter you added is not a counter that runs.** The refusal counting was
  written into `processDirectory` and verified by reading. It never fired: the
  default engine on this machine is **gdu**, not the walker, so the patched code
  path was not the one executing. Found by chmod-000-ing a fixture directory and
  watching `deniedDirs` stay at 0 — the mutation-before-believing rule, applied
  to a counter rather than a test.
- **`icon()` falls back to `file` for an unknown name, silently.** `pieChart` is
  not in `PATHS`; the tab would have shipped wearing the wrong glyph with no
  error anywhere. The registry has `pie`. **Check the name against `PATHS`
  before using it.**
- **`formatCount` already existed.** A second top-level `function formatCount`
  overrides the first and quietly changes every other caller. Grep before
  defining a helper in a 14,000-line file.
- **Smooth scrolling is a no-op in the shipped shell.** Measured:
  `main.scrollTo({ behavior: 'smooth' })` leaves `scrollTop` at 0 while the
  identical call with `'auto'` lands exactly, and `prefers-reduced-motion` is
  not set. Any control whose only feedback is a smooth scroll silently does
  nothing here.
- **A clipped caption looks exactly like a caption you forgot to write.** The
  used-mark's label sat inside the bar, which clips its own overflow: the mark
  drew, the label did not, and nothing errored. Only reading the DOM found it.

### A throw is the honest outcome; a 500 is not the honest presentation

Making `volumeTopology()` throw was right — an empty topology returned as a
success would be a zero. But the throw then reached the browser as a bare **500**
through both `GET /api/platform/topology` and the new statement route, and a 500
is not the unavailable-with-reason state §10 asks for. Both routes now map it to
`409 CAPABILITY_UNAVAILABLE` carrying the reader's own words, which is what the
tab already knows how to render.

Found by reading the browser's console after driving every view — the server log
had nothing, because `errorHandler` had handled it. **Check the client's network
results, not only the server log.**

### One place this deviates from §5.2, deliberately

§5.2 asks for the hardlink/clone delta "shown as its own line". It is shown —
as a note directly under the scanned line, carrying the exact figure (35 GB
here) — but **not as a row in the arithmetic**, because the scan already counts
each inode once and a second deduction would remove them twice. Making it a
non-arithmetic row instead would break the one invariant the feature rests on:
that every number in the value column sums to the total. On a receipt, a row
the reader must *not* add is worse than a note. The clone limitation §5.2 also
requires is stated in the same place, in the UI, in those words.

### What could not be verified on this machine

- **Snapshots with a size.** This Mac has zero local snapshots, and
  `tmutil listlocalsnapshots` names them without sizing them anyway. The
  zero-snapshot path ran live; the "N snapshots, size unknown" path and the
  Windows `vssadmin` byte figure are covered by fixture tests only, and creating
  a snapshot to test needs root.
- **The purge-snapshots remedy.** Its button hands off to the Dashboard's
  existing `snapPurgeBtn`, which is hidden when no snapshots exist — so the
  handoff itself was never exercised end to end here. The open-handles and
  scan-volume handoffs both were, live.
- **Windows and Linux.** The container-siblings line is APFS-only by
  construction and returns zero elsewhere, which is asserted by test but has
  never run on either OS.

## v4 — Phase 4 complete: the cart, made physical (27 August 2026)

**Five commits on `main`.** Suite **1200+ (was 1120)**, typecheck clean, build
clean, `npm run bench:v4` **7 pass / 3 not measurable in Node**, golden
responses still byte-identical. Every view driven in the real app; the isolated
dev server (`treemap-p4`, port 4292) and its fixture were removed afterwards.

| Commit | What |
| --- | --- |
| `ab79e52` | 4.1 a cleanup target, and the meter that fills toward it |
| `cf0e055` | 4.2 add-to-cart everywhere it belongs — and nowhere it does not |
| `a2f7998` | 4.3 the simulated "after", laid out client-side |
| `3f8f3a4` | 4.4 commit through the Time Capsule, as one undoable run |
| `25328b8` | 4.5 saved view → Clean Up rule → Autopilot policy |

### The one decision that shapes 4.3

**The freed space stays on the map, hatched, instead of the survivors growing
into it.** Those two cannot both happen, and the choice is not aesthetic: area
means bytes, so if the survivors expanded into the vacated space, the same
rectangle would silently be worth more bytes than it was a second earlier and
every size comparison against the live map would be wrong. §4.3's own words —
"freed regions rendered in a distinct hatched style" — settle it, because a
freed region that is still drawn is one the survivors did not take.

The re-layout is real all the same: inside each folder the staged children
collapse into ONE hatched block of exactly their combined size and the
survivors re-tile around it. A staged path is charged to the deepest drawn node
containing it, in four cases (it IS a drawn node / inside a drawn folder /
inside a drawn leaf, which shrinks / outside this view, which the banner says).
The invariant that follows — **every staged byte is either hatched somewhere or
reported as not in this view** — is asserted directly, because it is what makes
the picture honest. Measured live: freed area 1406.25 of 10000 = 14.0625%, and
18 MiB of 128 MiB is 14.0625% exactly.

### The rule 4.4 rests on, and how it was actually proven

**Anything too large for the Time Capsule to protect is left UNDELETED rather
than deleted unprotected.** A capsule that quietly lets a delete through when
it is full is worse than no capsule, because the user believes they are
covered.

Proven twice, both on the disk rather than in a mock. `tests/cartCommit.test.ts`
builds a **1 PiB sparse file** (`truncate` sets the logical size, which is what
`walkItem` measures and what the capsule would have to hold, while the volume
allocates nothing), commits it, and asserts the file is still there at its full
size. And live: staging it beside twelve real logs produced

> 1 will be left in place (1.0 PB) — not deleted:
> huge.sparse — Protecting it needs 1.0 PB, but the Time Capsule can only hold
> 28.4 GB. It will be left alone rather than deleted without a backup.

**before** the click, then deleted the twelve and left the sparse file untouched
(0 allocated blocks, still 1 PB logical) and still staged in the cart.

Skipped on Windows deliberately rather than "fixed": NTFS allocates
truncate-only files solid, so the fixture would really try to write a petabyte.
That is the handoff's own POSIX-shaped-but-different rule.

### The macOS CI failure after the push, and what it actually was

Two tests failed on the first push, both in `tests/indexEngine.test.ts`:
`an external create, resize and delete each land within 2 seconds` (451) and
`a path containing LIKE wildcards is deleted precisely` (453). Linux and
Windows were green.

Both are FSEvents-watcher timing assertions — the family trap 5 already names
as flaky, and whose own code comment records a miss "on a green codebase". So
the mechanism was not new. What was new is that Phase 4 added four test files,
two of which do real work (capsule copies with SHA-256 verification, real
scans), and Node runs test *files* in parallel: on a three-core runner that is
exactly the contention the comment blames.

**Do not widen the watcher budgets in response to this.** Three things were
done instead, and the suite ran green four times in CI mode afterwards:

1. `tests/cartCommit.test.ts` now starts **one** server for the file instead of
   one per test. Five server startups plus their scans were load nothing in
   that file needed.
2. Test 453 now asserts `startWatcher(dir) === true` and fails with *the
   removal never reached the index — the watcher delivered nothing*. It used to
   say "the wildcard-named folder was removed", which is a claim about the
   disk — and the disk had done its part. A failure that names the wrong
   subsystem costs a session.
3. The real bug underneath (below) — which is why 453 could not tell a watch
   that never attached from one that was merely slow.

### `startWatcher` could return true while watching nothing

`startWatcher` promises a boolean meaning "a watch attached", and
`POST /api/index/watch` and the Live toggle both render that answer. It was
incapable of saying no: `PlatformBase.subscribeToChanges` caught its own
`fs.watch` failure and returned a **no-op unsubscribe**, so a permission error,
an unsupported filesystem or a descriptor limit all came back as `true` with
nothing being watched. The only symptom was an index that quietly never
updated, under a control reading "Live".

The base implementation now rethrows, which `startWatcher`'s existing catch
turns into `false` exactly as its own comment always said it would. Linux also
watches the **root synchronously** before returning — `void seed(...)` meant
the subscription was handed back before any watch existed at all — while a
*subdirectory* failing stays a best-effort miss, because the tree is still
watched, just not exhaustively. Two tests pin both halves.

### New traps, all paid for

- **A ported algorithm needs a test that runs both copies.** §4.3 forbids a
  server call and the only squarify lives on the server, so the frontend now
  carries a port. `tests/cartPreview.test.ts` lifts it out of `index.html` with
  a balanced-brace scan, evaluates it, and demands rectangles identical to
  `src/utils/treemap.ts` over the same corpus — the technique
  `indexSearch.test.ts` already used for the query box. Without it the two
  drift silently and the preview stops being comparable to the live map.
- **`tmParentPath('/Users')` returned `''`, not `'/'`.** Harmless everywhere
  except the scan people actually run: rooted at `/`, every top-level folder
  reported a parent matching no node, the child map came out empty and the
  preview silently had nothing to show. Found by a test, not by reading.
- **Trap 6, in its third form.** The freed block's label, drawn in pass 1,
  introduced the first `ctx.textBaseline = 'middle'` in that pass — which is
  the end anchor `frontendContract.test.ts` slices the leaf-fill pass on. The
  slice quietly shrank and the cloud-placeholder assertions stopped looking at
  anything. The label now has its own pass. **Pass 1 must draw no text.**
- **`confirmOk` trashes `confirmPaths` whenever `onConfirmTrash` is null**, and
  that array holds whatever the previous dialog left in it. An informational
  dialog that merely leaves the callback unset arms its OK button with an
  unrelated set of files. Both new dialogs clear the set AND install a real
  no-op; a test pins it.
- **A colour picked for small type is not a colour for a texture.** The hatch
  started as `--text-3`; measured against the dark canvas it came out at RGB 15
  on a background of 7 — invisible. It is `--warn` now, the same amber as the
  block's dashed border and the banner, and reads at 241 luma of contrast in
  dark and 243 in light.
- **A preview map makes the query counter lie.** Staging exactly what a query
  matched, then previewing, produced "0 matches for ext:log modified>90d" under
  a map that had just hatched all twelve — a true sentence about the preview,
  read as a false one about the query. The status line now says what it is
  looking at while a preview is up.
- **A `position: fixed` dock cannot be seen by CSS inside the map.** The cart
  drawer is a fixed 366px layer, so at 860px it sat straight on top of the
  centred preview banner — the one width where that message matters most.
  `body.cart-open` is mirrored from one toggle function, and the banner
  left-anchors and narrows while the drawer is open.
- **Only the deletable paths are sent to the commit**, so the server has
  nothing to report as skipped. The dry run's refusals are carried into the
  summary explicitly, or a dialog saying "1 will be left in place (1.0 PB)" is
  followed by one that reads as "everything went".
- **Trap 26 again, first-hand:** a `for` loop with `await setTimeout` inside
  one `javascript_tool` call never resolves in a hidden pane and dies at 30 s.
  Drive multi-step UI sweeps as a `browser_batch` of alternating exec/wait
  steps instead.

### §4 acceptance, run end to end

"Stage items from four different views, preview the after-map, commit, undo —
and the disk returns to its prior state with the files back at their original
paths." Done exactly, on a 72 MB fixture, each item staged through its own real
cart button:

| View | Staged |
| --- | --- |
| Largest Files (Dashboard) | `holiday.mov` |
| Duplicates | `Dupes/original.bin` |
| Empty Folders (Clean Up) | `Empties/` |
| Clean Up custom rules | `app-1.log`, `app-2.log` |

The preview drew **three** hatched regions — Media 20 MB, Dupes 6 MB, Logs
3 MB — one per folder that lost bytes, with the top level still tiling exactly
10000/10000 of the canvas. The commit freed 29.0 MB, matching the manifest to
the byte (73,728 KB → 44,064 KB). The undo brought all of it back and
`shasum -a 256` over all twelve files was **identical to the pre-commit
listing**, with `Empties/a/b` and `Empties/c` restored as directories rather
than as nothing.

The goal meter's **Target met** state was captured live in the same run
(29.0 MB staged against a 20 MB target).

### One trap this cost

**`dev-isolated.js` writes to `os.tmpdir()`, which on macOS is
`/var/folders/…`, not `/tmp`.** Removing `/tmp/treemap-dev-data` cleans up
nothing, and a target set in an earlier session reappears in the next one
looking like a bug in the settings code. Resolve it with
`node -e "console.log(require('path').join(require('os').tmpdir(),'treemap-dev-data'))"`.

### Measured on this Mac

| Budget | Measured | Limit |
| --- | --- | --- |
| `npm run bench:v4` | 7 pass, 3 not measurable in Node | — |
| `tmBuildPreview` at the 20,000-node payload cap, 500 staged | **12.6 ms** | ≤ 50 ms (§2.5) |
| Scan throughput (50,102 items) | **1431.2 ms · 35,008 items/s**, −4.5% vs baseline | ≤ +2% |
| Per-node memory (1M / 5M) | **50.7 / 51.7 B/node** | ≤ 56 |
| Fact sidecars (5,000 paths) | size 96 ms · lastUsed 194 ms · recoverability 113 ms · reclaimScore 260 ms | ≤ 400 ms |
| Golden responses | byte-identical | unchanged |

Load average 4.23 / 3.29 / 2.97 at the start of the bench run. 12/16
capabilities available on this machine.

### Deliberate choices worth not "fixing"

- **The preview is read-only**, like the time slider: drilling into a
  hypothetical map would load a real folder under a banner saying nothing has
  been deleted. Clicks and the context menu are both refused, and a freed block
  gets no tooltip claiming a path that will not exist.
- **A query Autopilot policy never trashes a directory.** `type:dir` is a fair
  thing to ask a query, and a person can stage a folder by hand where they can
  see it — but an unattended policy doing it is a different blast radius. The
  resolver keeps files only.
- **The duplicates-only Clean Up rule refuses promotion** rather than being
  dropped: `matchCustomRules`' `dup` flag has no `AutopilotMatch` equivalent,
  and a promoted policy that quietly meant something narrower would be worse
  than no button.
- **Apps lost 251 cart buttons and that is the point.** Every location used to
  carry one, which quietly widened "Clear caches safely" — cache and log
  locations — into a one-click stage of the app itself or the user's documents.
  Verified live over `~/Library`: Data 251 rows / **0** buttons, Logs 12/12,
  Caches 129/129.

### What could NOT be verified on this machine

- **Games' shader-cache rows have never rendered against a real library.** No
  Steam, Epic, GOG or itch.io install exists on this Mac, so `loadGames`
  reports "no library found" here. The rendering rule is asserted from the
  source (`tests/cleanupCart.test.ts`), and the parser fixtures in
  `tests/gameLibraries.test.ts` are what prove the components; the honest
  no-library path is what runs live.
- **The Windows and Linux halves of everything above.** No Windows or Linux
  machine. The sparse-file over-cap test is skipped on Windows by design, and
  the preview's backslash path handling is covered only by unit fixtures.
- **A capsule eviction has never happened live.** The `evicts[]` line in the
  manifest is exercised by the plan's arithmetic and by
  `tests/timeCapsule.test.ts`'s `planEviction` cases, but this Mac's capsule cap
  is 28.4 GB and nothing in a fixture comes close.
- **`~/.Trash` remains unreadable from the shell (TCC)**, so trash-only is
  confirmed by the files leaving the fixture and by the undo bringing them back
  byte-for-byte, not by listing the Trash.

### The Time Capsule now restores timestamps — DONE, at the owner's request

It used to verify content byte for byte and write it back fresh, so a restored
file's *date modified* was the moment it came back. Phase 4 made that visible
to ordinary manual deletes, and it bit during verification: after an undo,
`modified>90d` stopped matching the very logs it had just been used to find.

`ManifestMember` now carries optional `mtimeMs`/`atimeMs`, and `EntryManifest`
carries `rootMtimeMs`/`rootAtimeMs` for a captured folder's own times. Four
things are worth knowing about the implementation:

1. **Directories are stamped last, deepest first.** Writing a child updates its
   parent's mtime, so a folder stamped before its contents were restored is
   immediately re-stamped with the time of the restore. Sorting by descending
   `rel.length` is sufficient — a child's path is always longer than its
   parent's.
2. **A folder's own times live on the manifest, not in `members`.** The walk
   never emits a member for the item's own root, and adding one would change
   `digestOf`'s input for every new entry while saying nothing about content.
3. **The times are absent from `digestOf` deliberately.** The digest
   fingerprints content; a file whose timestamps could not be read is still the
   same file.
4. **The per-directory `lstat` this needs is opt-in** — `walkItem(root,
   { withDirTimes: true })`, set only by `capture`. It measured 17 ms on a
   3,001-directory tree (~11% of the walk), and the dry run has no use for the
   answer. That walk is the one a person waits on with the confirmation dialog
   not yet open, so it does not pay for something only the capture needs.

Old manifests carry no times and restore exactly as they always did — a test
strips them back out and pins that. Verified live: after a commit and undo
through the UI, a folder kept its own Feb 2024 date even though its child was
written into it during the restore.

### The Linux CI failure: a test that assumed APFS

`an item bigger than the whole capsule is left UNDELETED` manufactured its own
precondition with a **1 PiB sparse file**. APFS took it happily; **ext4 caps a
file at 16 TiB**, so Linux CI failed with `EFBIG` before the test body ever
ran. macOS went green in the same run — the watcher work above had landed — so
this was a straight swap of one red platform for another.

The fixture is now sized from the capsule's **actual** cap (`planProtection([])`
→ `capBytes`, plus a page), which is 28.5 GiB here and smaller on a CI disk —
0.17% of ext4's ceiling. A test that manufactures its own precondition has to
ask the machine what that precondition is, rather than pick a number that
happened to work on the machine it was written on. A filesystem that still
refuses the sparse file now `t.skip()`s with the reason instead of failing for
something that is not the point.

**Now proven on all three.** The capsule's timestamp round-trip tests went
green on Linux, macOS and Windows on `f90496f` — including the folder-mtime
assertions, so Node's `utimes` on a directory holds on NTFS and ext4 as well as
APFS. This paragraph used to say they were unproven; they are not any more.

### The cart list is paged, because rebuilding it was a 44 ms block

Measured with a 1,000-item cart: rebuilding `#cartList` is **44.1 ms**, and it
is rebuilt on *every* cart click — right at §2.5's 50 ms main-thread budget and
past it above about 1,100 items. Staging a 1,000-hit query is one click away,
so that cart is not hypothetical.

`CART_PAGE = 200` draws a page and states the remainder ("799 more staged, not
listed here" + **Show all 999**), the same shape Duplicates already uses. Paged
it is **8.2 ms**. Every total — the tab count, "Reclaims", the goal meter, the
commit itself — is computed from the whole Set and is unaffected by what is
drawn; a test pins that, because a dock that under-reported what is staged
would be wrong in the one panel whose job is to say how much is about to go.

---

## Perf pass on the Phase 3 readers — and what "10x" actually costs (27 Aug 2026)

CI on `189a4e8` was **green on all three OSes**: type-check and the full suite
passed on macOS, Windows and Linux, zero annotations, and the "surface each
failing test" step *skipped* (it is `if: failure()`). That run was the first
time the Windows `Zone.Identifier` and Linux `getfattr` readers executed on
their real operating systems.

### What was measured, and what it changed

Profiling the cold `reclaimScore` batch at 5,000 paths put the time here:

| Component | Before | After |
| --- | --- | --- |
| `readDownloadOrigins` (macOS `xattr`) | 208.5 ms | **97.0 ms** |
| `readLastUsed`, steady state | 46.0 ms | **21.1 ms** |
| `recoverability` | 88.6 ms | 86.3 ms |
| `scanInputsFor` (first, then cached) | 26.6 / 0.0 ms | 24.2 / 0.0 ms |
| **`reclaimScore` cold, via the bench** | **319.9 ms** | **259.2 ms** |
| `reclaimScore` warm | 2.7 ms | 2.7 ms |

**The first hypothesis was wrong, and measuring is what caught it.** The
obvious read of "208 ms over ten `xattr` spawns" is that spawning is
expensive, so raise `XATTR_BATCH`. Measured, the batch-size axis is nearly
flat — 5,000 paths in **one** spawn took 155 ms against 167 ms in ten, so a
spawn is ~1.2 ms and the cost is the syscalls inside it. Raising the chunk
size would have bought ~7% while pushing argv toward `ARG_MAX` on deep trees.

The time was in **serialisation**, not spawning:

- `xattr` chunks now run **four at a time** (168 → 74 ms in isolation).
  Four, not eight: at eight the processes contend for the disk queue and for
  the cores Node needs, and 5,000 paths measured 136.9 ms — barely better than
  sequential. Four is the measured knee and matches the `HASH_CONCURRENCY`
  the duplicate finder already settled on.
- `readAtime` and the per-path mount lookups in `readLastUsedMac` were a
  sequential `await` per path against Node's four-wide filesystem threadpool.
  Now 32 in flight — higher than the subprocess ceiling on purpose, because
  threadpool `lstat` does not compete for cores the way a spawned process
  does.
- **A component whose weight is 0 is no longer computed at all.** The model
  already drops it, so computing it was work that could not change the
  answer; turning `redownloadable` off in Settings now stops `xattr` being
  spawned. A test counts the calls rather than timing them, and a second test
  asserts the remaining components' scores are byte-identical either way — an
  optimisation that changed the answer would be a defect, not a speed-up.

`src/utils/concurrency.ts` is new and carries these numbers in its header.
`mapConcurrent` already existed as **two private copies** (`duplicateFinder`,
`perceptualDupes`); a third was not worth writing, but those two were left
alone deliberately — consolidating them touches proven delete-path code for
no functional gain. Worth doing on a quiet day.

### Why there is no "10x" to give, stated with the measurements

| Operation | Measured now |
| --- | --- |
| Scan 18,933 files (gdu-turbo) | **252 ms** (~75,000 items/s) |
| Switch between all 13 views | **6.3 ms total**, slowest view 1.0 ms |
| Treemap repaint, 4,717 drawn cells | **10.2 ms median**, 23.2 ms p95 |
| Score an entire treemap, 4,722 cells, cold | **124 ms** |
| Reclaim score, warm | **2.7 ms** |

Nothing in that table has 10x in it, because nothing in it is slow. A view
switch cannot be made ten times faster than 0.5 ms in any sense a person
could perceive.

The one operation where a user genuinely waits is scanning a whole disk —
1.4M items in ~16 s. A 10x there is not an optimisation problem, it is a
mechanism problem, and **§7 rules out the only mechanisms that would do it**:
no MFT parsing, no `getattrlistbulk`, no N-API addons. Within the walkers the
project is allowed to ship, gdu-turbo is already at the filesystem's speed.

So the honest statement is: the readers this phase added got **2.1-2.2x** on
the paths that were actually costing time, the cold end-to-end batch got
**1.23x**, and everything else was already fast enough that the remaining
wins are noise. Do not let a future session quietly redefine "10x" to mean a
microbenchmark that was never on anyone's critical path.

---

## v4 — Phase 3 complete: the Reclaim Score (26 August 2026)

**Four commits on `main`, unpushed.** Suite **1118 (1116 pass, 2 skips)**, up
from 1047. Typecheck clean, build clean, `npm run bench:v4` **7 pass / 3 not
measurable in Node**. Every view driven in the real app; the isolated dev
server (`treemap-p3`, port 4289) was stopped afterwards.

| Commit | What |
| --- | --- |
| `062eb6e` | 3.1 the scoring model + user-editable weights |
| `fdc5944` | 3.1 the fact provider that gathers the six signals |
| `e55817c` | 3.1 `score:` in the query grammar + `reclaim_ranked` over MCP |
| `16f755f` | 3.3 the badge, breakdown, colour mode, sorts and settings |

### The one design rule everything else follows

**A component that could not be computed is left out of the score and named —
never counted as zero.** The obvious implementation multiplies every weight by
its value and sums, unknowns contributing nothing, which silently ranks a file
nobody can vouch for BELOW one positively known to be worthless. So the score
renormalises over the weight that actually answered, `missing[]` names the rest
with reasons, and `coverage` (the share of enabled weight that answered) is
what `confidence` bands. If you change one thing in this feature, do not change
that.

Three kinds of "no answer" are kept apart, because each has a different fix:
the mechanism cannot run here (no git, no backup) → missing with the
capability's reason; it ran and found nothing (no rule matched, no download
record) → a real zero; **it has not been asked** (duplicate hashing has never
run for this scan) → missing, because "no duplicate found" is only true once
something looked. Collapsing the last two turns "TreeMap has not checked" into
"TreeMap checked and there is nothing", in the number people delete by.

### New traps, all paid for

- **`xattr -p` batches, and exits 1 for the ordinary case.** Measured: batched
  `mdls` is ~0.36 ms/path — over §2.5's whole 400 ms budget alone — while one
  `xattr` call over 2,000 absolute paths returns in ~50–100 ms. Its traps are
  the ones this codebase already knows: exit 1 means "some file had no
  attribute" (the `lsof` shape — read stdout, never the exit code); a
  single-path call prints a **bare value with no path prefix** (the `mdls`
  shape); and lines are matched against the *requested* paths rather than split
  on the first colon, because a filename may contain `: `. Longest-first, so
  `/x/a.txt` cannot claim `/x/a.txt.download`'s line. Unlike `mdls`, a
  vanished path does **not** destroy the batch.
- **A fact derived from settings needs its own invalidation.** The fact cache
  is keyed on scan and path with a 30-minute TTL, which is right for a fact
  about a tree and wrong for one computed from weights. Changing a weight left
  every cached score untouched, with breakdowns listing components the user had
  just switched off. `updateSettings` now calls
  `clearFactCacheForProvider('reclaimScore')`, and **only when the weights
  actually changed** — an unrelated save must not re-run `mdls` and `git` over
  everything on screen.
- **`getDuplicateJob` starts a job; `peekDuplicateJob` does not.** Scoring a
  folder must not kick off a full-disk SHA-256 pass as a side effect. And
  `job.groups` is the top **500** by reclaimable bytes while `groupCount` is
  the real total — absence from that list proves nothing when it was
  truncated, so the score reports unknown rather than "no duplicate".
- **`collectCleanupSuggestions` caps `items` at 200 per rule.** Building a
  path→rule map from its groups would score the 201st `node_modules` in a scan
  as "no rule recognises this". It now takes an optional observer on the same
  walk — one matcher, two consumers, because two matchers over the same rule
  packs agree today and drift by the next rule anyone adds.
- **Clean Up's checkbox `data-i` indexes `g.items`, and it feeds the delete
  path.** `updateCleanSummary` reads it back as `smartGroups[g].items[i]`, so
  rendering a re-ordered list with positional indices ticks one row and deletes
  a different file. `smartItemsOf` pairs each item with its original index
  before sorting. Verified in the running app, not just in a test.
- **A repaint-driven callback can recurse.** `drawView` asks for the scores of
  what it drew; the fetch's callback repaints. `ensureScores` therefore fires
  its callback **only when new scores actually arrived** — "nothing fetched"
  and "nothing changed" are the same statement, and without that the two called
  each other forever once every visible cell was scored.
- **`--surface-1` is a 5%-alpha tint, not a background.** The breakdown panel
  used it and the donut legend read straight through the text. It joins the
  liquid-glass layer like `#ctxMenu` — over an **opaque `--bg-1` base**,
  because the shared 68% tint is fine for a small menu on a dimmed backdrop and
  not for a 460×600 panel on bare content.
- **Holding a DOM node across a repaint loses focus.** Every list carrying a
  badge is rebuilt by `innerHTML` when the scores land, so the button that
  opened the panel is gone by the time it closes and focus fell to `<body>`.
  The path survives the repaint; the badge is re-found by it.
- **`position: fixed` needs both axes clamped.** Its coordinates are
  viewport-relative while the anchor's rect is wherever that row sits. A badge
  below the fold put the panel at y=2227 in an 820px window: open, populated,
  focused, invisible.
- **A confidence letter beside a number in a disk tool reads as a unit.** The
  badge said "66.4M" — every other figure on that row is a byte count. A
  leading `~` for anything below high confidence cannot be misread.

### Measured on this Mac

| Budget | Measured | Limit |
| --- | --- | --- |
| `reclaimScore` sidecar, 5,000 paths cold, 3 batches | **319.9 ms** | ≤ 400 ms |
| Treemap repaint in Reclaim mode, 4,717 drawn cells | **10.2 ms median, 23.2 ms p95** | ≤ 16 ms median / 33 ms p95 |
| Switch to Reclaim (layout + repaint), 4,717 cells | **30.6 ms** | ≤ 50 ms |
| Open / close the breakdown panel | **12.7 / 0.6 ms** | ≤ 50 ms |
| Largest Files → Reclaim sort | **1.4 ms** | ≤ 50 ms |

Load average 3.22 / 2.86 / 2.80 at the start of the bench run. `reclaimScore`
is the tightest row in the gate and it is the **cold worst case** — in real use
the two providers it composes are already cached by the same screenful.

### Deliberate choices worth not "fixing"

- **The colour ramp is absolute, not per-scan.** On this repository every score
  lands between 3.7 and 44.8, so the map reads uniformly olive — which is the
  correct statement: nothing here is a slam-dunk delete. Rescaling green to
  mean "greenest in this folder" would make a folder of irreplaceable originals
  look full of safe deletions, which is the exact dishonesty the size component
  already refuses. The ramp does discriminate when scores do (a 3-year-old
  `node_modules` at 87.6 is plainly green beside a fresh one at 53.7).
- **Largest Files shows badges only under the Reclaim sort.** Scoring costs
  per-file work; the dashboard's first paint should not pay it for a list most
  people read by size. The toggle is right there.
- **The treemap scores at most `TM_SCORE_CAP` (6,000) drawn cells**, and says
  so: `reclaimCoverageNote()` renders "Scored N of M on screen" while batches
  land, names the cap when one is hit, and says nothing once everything drawn
  is scored. Silence there would read as "these are all fine" — 2,716 of 4,717
  cells were unscored grey in the run that prompted this.

### What could NOT be verified on this machine

- **Windows `Zone.Identifier` bulk reads and Linux batched `getfattr`** — no
  Windows or Linux machine. Both are covered by parser fixtures through the
  tool seam; the honest-unavailable and ENOENT-is-a-real-absence paths are what
  run here. The Linux batch parser in particular **has never executed against
  the real `getfattr`**: it is written from the documented dump format, and its
  octal-escape decoding is asserted only against hand-built fixtures.
- **No Time Machine is configured on this Mac**, so `elsewhere` answers
  `unknown` for everything outside a git repo. That is the honest path and the
  one the UI was verified against — but the `likely` and `pathCovered` branches
  have still never run live.
- **`useCount` is always null here**, because `kMDItemLastUsedDate` is dead on
  this macOS (see the Phase 1 notes). Staleness runs on access times, and the
  breakdown says "not read in …" rather than "not opened in …" accordingly.

---

## v4 — Phases 0–2 verified, reviewed, and INSTALLED (26 August 2026)

`/Applications/TreeMap.app` was rebuilt from `cd30b21` and now carries Phases
0–2. Verified live in the installed app: a 357,134-node scan, the grammar
(`size>5mb -in:node_modules` → 722 matches), and the fact layer returning a
real last-opened date plus an honest "no Time Machine configured".
**Full Disk Access resets on every reinstall** — the user must re-grant it.

**Two adversarial read-only reviews found nine defects** (`cd30b21`), five of
which made TreeMap state something false about recoverability. The most
valuable ones to remember:

- **A failed `git check-ignore` was read as "nothing is ignored"** — turning a
  clean pushed repo into "deleting this costs one `git clone`" for a
  node_modules the remote never held. Its own error path reintroduced the bug
  it was written to prevent.
- **`git()` treated exit code 1 as success for every command**, not just
  check-ignore, so a failing `git status` read as a clean worktree.
- **"does not skip this location" was claimed by readers that never check.**
  Only macOS has an exclusion list; Linux has none and Windows never matches
  paths against its own list. `BackupMembership.exclusionChecked` now exists
  and the type system forces every reader to answer it.
- **`tmutil isexcluded` echoes RESOLVED paths** (`/etc/hosts` →
  `/private/etc/hosts`), so lookups keyed on the original path miss.
- **A one-path `mdls` batch emits a bare dict, not an array** — and the
  Spotlight verdict is memoised for the process, so the first single-file
  request permanently disabled Spotlight.
- **Frontend regression on a shipped path:** the grammar/bare-word router
  triggered on any `-`, `:`, `(`, `)` or `or`, so `Screenshot (1).png` became a
  three-way AND and `-hidden.txt` highlighted everything EXCEPT the match.
  Global search's "go to" routes through it. It now requires a known field
  before the operator.

**Performance, measured in the real app.** All 13 tabs block 1–12 ms. The one
breach was pre-existing: **Duplicates froze ~400 ms on every visit** (one
3.4 MB innerHTML write, 26,675 elements, 1,484 cart buttons — the exact
population `refreshCartButtons` warns about). Rows now fill on expand and the
group list is windowed at 100: **400 ms → 14.8 ms, zero long tasks.**

**Browser-pane measurement traps** (both cost time here): the pane throttles
timers and auto-hides mid-call, so `setTimeout` stalls and results look like
app bugs — front the tab with `tabs_select` first. And `getComputedStyle`
returns STALE values there: an inline `border-color: #ff453a` read back as the
old colour while the screenshot showed it correctly. Verify CSS visually.

---

## v4 — Phases 0, 1 and 2 complete (26 August 2026)

**Phase 2 (`e57a93d`): the query grammar.** Suite **1045 (1043 pass, 2 skips)**.
`POST /api/query`, `/api/query/validate`, `/api/query/fields`,
`GET/POST/DELETE /api/queries`, and a treemap box that accepts the full
grammar with live parse feedback, autocomplete and a saved-views chip strip.

**Known gap, stated rather than implied:** `POST /api/query` takes `scanId`
only. The `root`/index path is NOT wired — so `src/services/query/toSql.ts`,
which is written and proven against real SQLite, has no route calling it yet.
Wire it when the index path is needed, and pass the executor's `now` into
`toSql(ast, now)` or the two halves disagree at an age boundary.

**Phase 2 traps:**

- **`treemapMatch` and `renderSearchOverlay` must stay adjacent.**
  `tests/indexSearch.test.ts` slices `public/index.html` between those two
  literal function names. Anything inserted between them, or a rename, breaks
  a test whose failure message will not mention what you did.
- **SQLite `LIKE` folds ASCII only; JS `toLowerCase()` folds Unicode.** Pushing
  `name:café` to SQL missed `CAFÉ.txt` — a strict subset, which a post-filter
  cannot repair. Non-ASCII needles are not pushed.
- **`store.childCount` returns 0 for a directory nobody could list**, not just
  for an empty one. Always pair it with `hasChildArray`.
- **The browser pane throttles timers and serves stale `getComputedStyle`.**
  An inline `border-color: #ff453a` read back as the old value; the screenshot
  showed the correct red. Verify CSS visually, not by computed style, and
  front the tab (`tabs_select`) before timing anything.

---

## v4 — Phase 0 and Phase 1 complete (26 August 2026)

**Six commits on `main`, unpushed.** Suite **970 (968 pass, 2 skips)**, up from
906 at `2d47e98`. Typecheck clean, build clean, `npm run bench:v4` 6 pass /
3 not measurable in Node. Capabilities **12/16** (was 9/12).

| Commit | What |
| --- | --- |
| `6f3c9c4` | 0.2 the fact layer + `POST /api/facts` |
| `c3c7d6c` | 0.3 the performance gate, `npm run bench:v4` |
| `7717392` | 0.1 the recorded baseline |
| `f989f81` | 1.1 last-opened dates |
| `d6ee1bf` | 1.2 recoverability |

Spec: `/Users/prithvivinay/Desktop/TREEMAP-V4-MASTER-PROMPT.md`.
Baseline: `docs/superpowers/specs/2026-08-25-v4-baseline.md`.

### Corrections to the v4 brief, found by measuring

1. **The suite was 906, not the 828 the brief states** (and HANDOFF's own
   header said 899 while its "Start here" said 828). 906 is the floor.
2. **The golden lock covers nine surfaces, not eight** — `goldenHarness.ts`
   also captures the final SSE frame of `/api/scan/{id}/progress`.
3. **⌘K is already bound to global search** (A4), so Phase 9.1's command
   palette needs a different key. The user approved **⌘⇧P**.
4. **§4.1's 2,000-path cap collides with `guardBodyPaths`' 500** (same error
   code). Resolved with `guardBodyPathsMax(n)`; destructive routes keep 500,
   and a test asserts the separation.
5. **§2.5 budgets a sidecar at "400 ms for 5,000 paths" while §4.1 caps a
   request at 2,000.** Measured as three sequential batches against the one
   400 ms budget.

### New traps, all paid for

- **`kMDItemLastUsedDate` is dead on this macOS.** Spotlight indexing is ON,
  `mdimport -A` lists the attribute, and `mdfind` matches **zero files on the
  entire machine**. A capability probe based on `mdutil` alone would report the
  feature available and answer "unknown" forever. Availability is decided by
  whether Spotlight *answers*, probed against real paths.
- **`mdls` loses a whole batch to one missing path** — it abandons the plist,
  prints `could not find /x.` as text, and **exits 0**. Stat first; discard a
  result whose length does not match rather than mis-zipping.
- **`tmutil` exits 0 on failure too** (`destinationinfo`, `latestbackup`).
  Parse the text, never the exit code.
- **`tmutil isexcluded` says `[Included]` on a Mac with no backups at all.**
  It means "not on the exclusion list", not "backed up".
- **`git status --porcelain` omits ignored files**, so a repo full of
  `node_modules` reports clean and `fullyPushed` is true. Without
  `check-ignore`, the UI would say deleting it "costs one git clone".
- **tsx does not forward the outer process's V8 flags** to the child it
  spawns, so `node --expose-gc <tsx> bench-store.ts` measures an unsettled
  heap and reports ~123 B/node against a true 50.9. Flags go AFTER the tsx
  entry point.
- **Trap 2 below is real and I hit it.** Repeated 542-554 ms measurements of a
  provider I had just optimised turned out to be a **stale server still bound
  to the port** — the rebuilt one had died with EADDRINUSE, visible only in a
  log I had not read. The true figure was 75 ms. Verify the server you are
  measuring is the one you just built.

### What could NOT be verified on this machine

- **`useCount` has never returned a real value** — Spotlight supplies none here.
- **Time Machine's populated paths have never run**: this Mac has no backup
  destination, so only the not-configured branch has executed live.
- **Linux and Windows have never run at all** for 1.1 or 1.2. Both are covered
  through their parse seams against captured tool output.
- **No `noatime` volume and no cloud sync client** were available to exercise.

---

**Date:** 25 August 2026
**Status:** **v3.2.0 committed, AWAITING THE USER'S GITHUB DESKTOP PUSH + RELEASE.**
Three commits on `main` since the v3.1.0 release: `879eff7` scan cancellation,
`6a0debd` the VS Code extension, and the `Release v3.2.0` version bump.
Suite is **899 (897 pass, 2 platform skips)**; typecheck clean; build clean.

**Two features shipped this session, both from the user's own spec:**

1. **Stop a running scan.** The Scan button becomes a red Stop while a scan is
   in flight. `POST /api/scan/:scanId/cancel` settles the record, and a gdu
   subprocess is killed rather than left to finish its shard (measured: one
   process before, zero after). Design doc:
   `docs/superpowers/specs/2026-08-25-scan-cancellation-design.md`.
2. **A VS Code extension** in `vscode-extension/`. Clones or reuses a TreeMap
   checkout, builds it, runs its server as a child process, frames the
   visualizer in a webview. Design doc:
   `docs/superpowers/specs/2026-08-25-vscode-extension-design.md`.

**⚠️ THE RELEASE IS THE USER'S STEP AND IS WHAT THEY ACTUALLY WANT.** Their
stated goal is "people to be easily able to download the .dmg and .exe". That
happens through `.github/workflows/release.yml`, which builds BOTH on real
macOS and Windows runners when a `v*` tag is published. Do NOT try to build
Windows installers on the Mac — electron-builder needs Wine, which is not
installed, and CI does it properly anyway. Steps 6–7 of the release recipe
below are all that remain.

**New traps found this session (all paid for):**

- **A review subagent with write access edited the source mid-review.** One
  transiently mutated `gduScanner.ts` to test the new tests and restored it;
  another left a `clearTimeout` in `tests/scanCancel.test.ts` that got swept
  into a commit and made the file hang. **Use read-only agents (`agentType:
  'Explore'`) for review, and `git diff` the whole tree before committing.**
- **Never leave a non-unref'd `setTimeout` armed in a passing test.** The SSE
  cancellation test's 8s watchdog held the event loop for its full duration
  after the test passed — 8.8s per run of that file. Clear it on BOTH settle
  paths from inside the promise; clearing it from the outer `finally` instead
  made the test hang.
- **`npm` on Windows is `npm.cmd`.** libuv's PATH search only appends `.com`
  and `.exe` and never reads PATHEXT, so `spawn('npm', …, {shell:false})` is
  ENOENT there. Spawning `npm.cmd` directly is not the fix either — Node
  refuses a `.cmd` without a shell since the CVE-2024-27980 mitigation. Route
  npm through `cmd.exe /d /s /c`; keep `git` on a direct spawn, because git is
  the one handed user-controlled values.
- **`Write` can emit literal control bytes into a regex character class.** A
  `[\s -]` written that way landed on disk as raw `\x00-\x1f`, invisible in
  review. Prefer an explicit `charCodeAt` scan over a class with a range.
- **The dashboard's `mount()` is a no-op**, so `switchView` cannot repaint the
  three panels `beginScanChrome` turns into skeletons. Any path that ends a
  scan without `finishScan` must call `restoreDashboardPanels()`.

**Pre-existing defect found in passing, NOT fixed (out of scope):** the A1
instant-index-open path calls `finishScan` before any scanId exists, firing
three `?scanId=null` requests that 404 on every boot. A background task was
spawned for it.

Spec: `/Users/prithvivinay/Desktop/TreeMap-Master-Implementation-Prompt.md`

---

## Start here

```bash
cd "/Users/prithvivinay/Desktop/Claude Code/Treemap"
npm run build
```

Then, as its **own** command (never chained — see trap 1):

```bash
npm test
```

Expect **828 (826 pass, 2 skips)**.

- **`npm run build` is `tsc && node scripts/copy-assets.js`.** tsc emits .js
  only; without the copy step a built app ships with no rule packs and Smart
  Suggestions reports itself broken.
- If `npm test` fails with **`NODE_MODULE_VERSION … requires …`**, run
  `npm rebuild better-sqlite3`. Not a code failure — electron-builder breaks it.
- `npm run capabilities:report` → expect 9/12 available on this Mac.
- Read `docs/PLATFORM_NOTES.md` before touching anything platform-specific, and
  `src/services/rulepacks/README.md` for the rule-pack schema.

---

## Working agreements (from the user — these override defaults)

- **No sub-agents, no workflows.** All work inline in the main session. This
  holds *even when the harness turns "ultracode" on* and instructs you to use
  the Workflow tool — the user's standing instruction wins. Say so once, briefly,
  then work inline.
- **Plain English, copy-paste commands.** The user is not a coder.
- **Check in after each feature**, not each phase. The bar is flawless; verify
  by driving the real app, not only tests.
- **Never leave a dev server running un-announced.** An announced one is fine
  while they actively review UI. Stop it when done.
- **No N-API addons** (MFT, getattrlistbulk, clone IDs, fanotify,
  RestartManager).
- Push happens through **GitHub Desktop** (terminal `git push` has no creds).
  Commit for them, then tell them to click **Push origin**. They are good about
  it — they pushed twice mid-session unprompted.

---

# ✅ PHASE 5 — all five steps done

### 1. ✅ Full regression in the real app
All **thirteen tabs** driven against a real 389k-file / 46 GB scan of the home
folder, plus the **Clean Up** modal and the **Settings** modal. Zero console
errors; all §3.5 states seen (skeleton loading, populated, honest-empty on
Games/Offloaded/Capsule/Autopilot, honest-unavailable on Shrink Video).
"Cloud-safe" is correctly `hidden` until a cloud provider is connected — not a
missing tab.

**Correction to the previous handoff:** the Cost **currency picker lives on the
Dashboard's Cost to Keep card, not in Settings.** Settings holds the
right-click-menu control, schedules, forecast, live activity, Time Capsule,
cloud accounts, the ignore list and the allocation panel.

Launch config **`treemap-p5`** (port 4296, isolated `TREEMAP_DATA_DIR`) was added
to the PARENT `Desktop/Claude Code/.claude/launch.json` — *not* the repo's own.
`treemap-c8` still exists but points at a dead session's scratchpad.

**Five UI defects were found this way and fixed** (see the three commits):
dashboard scrolled sideways (grid item `min-width: auto` vs one long path);
treemap canvas wasted ~126px of window on a flat `innerHeight - 300`; grid
scroller scrolled internally against a `100vh - 256px` reserve while the window
had room; below 900px `main` rendered as a **64px sliver** because the fixed
sidebar leaves the body grid; treemap toolbar overhung the viewport with no
`flex-wrap`. Also: depth-1 folder tags printed straight through child labels.

### 2. ✅ §8 benchmark — measured, with load stated
Apple Silicon MacBook, normal desktop session (**not** a quiet box):

| Figure | Measured | Load at the time |
| --- | --- | --- |
| Whole disk `/` | 1,411,715 items in **16.4 s** = ~85,900 items/s (gdu-turbo) | 3.13 → 4.61 |
| Home folder | 458,661 items in **9.1 s** = ~50,300 items/s | 3.27 |
| Index density | **183.4 B/node** in use, 163.7 compacted | 3.28 |
| `readTree` | 250,000 nodes (its cap) in **~790 ms** = ~316k nodes/s | 4.63 |

The 190 B/node claim **holds**. These are now in the README's design notes.
Home reads *slower per item* than the whole disk because gdu-turbo parallelises
across top-level folders and `/` has far more of them — not a regression.

### 3. ✅ D1 security review — re-proven
`fleetSummary.ts` read and confirmed: an explicit **eleven-field allow-list** is
the only thing ever serialised, plus a forbidden-substring check that *throws*
rather than send anything smelling of a tree, a finding or a URL, and
`buildSummary` deliberately takes `SummaryInputs` rather than a `ScanResult` so a
scan store is never within reach. `npm run fleet:acceptance` → **ALL D1
ACCEPTANCE CHECKS PASSED** (11-key summary, 401 on every unpaired probe, peer
port refuses loopback, remote scan gated behind its separate opt-in).

Backend also swept independently: **46 GET endpoints, zero 5xx**; the
scanned-root rule verified on a *clean* server (dry-run AND real deletes both
refused with `OUTSIDE_SCAN_ROOT`, `/api/files/open` too); `CONFIRM_REQUIRED` on
trash-empty; blocklist fires on `/dev`, `/private/var/db`, `/System/Volumes/VM`.
Note `/System/Library` is deliberately **scannable** — the blocklist targets
virtual/volatile filesystems, and SIP protects the rest.

### 4. ✅ README sweep
Games, Security and Fleet added as view entries (Fleet full-width, since it is
the one network surface); Cost to Keep, Drive Health and Held-Up Space folded
into Dashboard; Shrink Video and package orphans into Clean Up; provenance into
Treemap; right-click menu and portable mode into Desktop extras; the liquid-glass
sidebar into "How it's built"; the §8 figures into the design notes.
`views.svg` was redrawn — it had been showing **ten** chips while the prose
claimed twelve and reality was fifteen.

### 5. ✅ Release v3.0.0 — built and installed; publishing is the user's step
The user chose **v3.0.0** (major, not minor: the app grew from a treemap into a
fifteen-view workbench, and Phase 3/4 shipped without ever being released).
Recipe steps 1–5 done. Steps 6–7 (push, publish, verify downloads) are theirs.

### Two product fixes they also asked for, done in `764c18d`
Both were "TreeMap offering an action whose cost exceeds the problem":

- **Security.** Google Drive's own `roots.pem` was reported SERIOUS with a
  "Move to .ssh" button — and that relocate is a *rename*, so taking it would
  have broken Google Drive. Files inside an installed program's own files
  (`.app` bundles, `Library/Application Support`, `Containers`, `AppData`,
  `node_modules`, `site-packages`) now carry `appOwned: true`: still listed,
  never called serious, never offered a move. Verified in the running app —
  the badge reads MINOR and there is no move button.
- **Empty Folders.** `.git/refs/tags` and `.git/objects/info` are empty in
  nearly every repo, and a signed `.app` ships dozens of empty `.lproj` folders
  **inside the code signature's seal** — deleting one frees ~0 bytes and stops
  the app launching. Tool-owned, app-owned and OS-Trash directories are now
  excluded from the offered list *and* the nested count, so the two numbers
  still agree. On this repo the offered list went **70 → 1**, and a fixture in
  the shipped build offers 2 of 7 empty dirs — exactly the user's own two.

**If revisiting:** `ownsItsContents()` in `diskScanner.ts` and
`isApplicationOwned()` in `securityHygieneScanner.ts` are the two lists.
`tests/emptyFolders.test.ts` and the app-owned test in
`tests/securityHygiene.test.ts` are the behaviour locks — a failure there means
behaviour changed, never "update the expectation".

---

## What each phase built (so you need not rediscover it)

### Phase 0 — platform layer + frontend registry
`src/platform/` with a full `PlatformProvider` for all three OSes, runtime
capability detection with honest reasons, `GET /api/platform/capabilities`,
3-OS CI. Frontend: view registry (**`registerView()` is the ONLY supported way
to add a view**), pub/sub, the single `api()` fetch wrapper, `Canvas2D` toolkit,
`window.TreeMap` debug handle.

### Phase 1 — A1–A5
A1 persistent live index (better-sqlite3, schema v3, 190 B/node) · A2 allocation
accounting · A3 cloud placeholders · A4 instant search · A5 volume topology.

### Phase 2 — B1–B5
B2 open-file guard · B3 Time Capsule · B1 Autopilot · B4 snapshot restore ·
B5 zombie handles.

### Phase 3 — C1–C8
- **C8 rule packs** (`services/rulepacks/*.json` + `rulePacks.ts`).
  `cleanupRules.ts` is now only the matcher. `common.json` is an addition to the
  spec's file list, on purpose (triplicating shared rules is how a catalog
  drifts). **Validation rejects unknown keys**; one bad pack fails the WHOLE
  catalog and the route answers `available:false` + reason. **`action:
  "advice"`** = listed for its size, no checkbox, no cart button — for things
  where the file IS the data (Docker/WSL vhdx) or the OS owns it. **WinSxS is
  deliberately absent**; reason in `rulepacks/README.md` — do not "complete" the
  seed list by adding it. `tests/cleanupRules.test.ts` is the behaviour lock: a
  failure there means behaviour changed, never "update the expectation".
- **C6 package orphans** (`packageEcosystemScanner.ts`). Rules are DATA
  (`ecosystem`-tagged rules + the `package-cache` kind). orphan / active /
  cache. **It refuses to guess**: with the owner manifest gone, a directory is
  claimed only if one of the rule's `evidence` children is present, so an
  unidentifiable `target` is reported as nothing.
- **C7 games** (`gameLibraryScanner.ts`). Steam/Epic/GOG/itch, per title split
  into base / shaderCache / workshop / compatPrefix / dlc. **Shader caches are
  the ONLY component ever offered for removal.** Hand-written Valve KeyValues
  parser. Steam's own `SizeOnDisk` is shown next to ours.
- **C5 secrets** (`securityHygieneScanner.ts`). Names and locations only, never
  opens a file. **No delete at all.** The relocate is a RENAME only — a
  copy-then-delete fallback would break the "nothing outside cleaner.ts removes
  a user file" guard. Both ends must be inside a scanned root.
- **C3 provenance** (`provenanceTracker.ts`). Host only, full URL behind a
  click, `textContent` never `innerHTML`, no anchor ever built, never fetched.
- **C4 drive health** (`driveHealthMonitor.ts`). **Report, never editorialise** —
  a test pins failure vocabulary out of both the service and the UI.
- **C1 cost** (`costIntelligence.ts`). The table SHIPS with the app; a test pins
  that nothing fetches. `asOf` is always on screen. A saving only exists when
  the TIER changes.
- **C2 compression** (`compressionAdvisor.ts`). Ordering is the guarantee:
  encode beside → probe → verify → trash → rename → utimes. Hardware encoders
  only. Tested through the `MediaTools` seam (`setMediaTools()`).

### Phase 4 — D1–D3
- **D2** (`GET`/`POST /api/platform/shell-integration` + a Settings control).
  `shellIntegrationInstalled()` reads the OS every time, never remembered — §D2's
  stated failure is an uninstall leaving a dead menu entry. The entry launches
  `<exe> <folder>` → `scanPathsFromArgv` → `requestScan`, the same path a dock
  drop uses.
- **D3** (`services/portableMode.ts`, `utils/portableBoot.ts`,
  `GET /api/platform/portable`, first-run screen, `dist:portable-*`). Signals:
  `TREEMAP_PORTABLE`, `PORTABLE_EXECUTABLE_DIR`, `treemap-portable.txt` marker.
  **Removable media is deliberately NOT a signal.** A read-only medium ⇒
  EPHEMERAL: memory-backed storage, SQLite `:memory:`, audit ring buffer, Time
  Capsule off with a reason. **Anything that resolves `appDataDir()` itself must
  consult `isEphemeral()`** — a test enforces it, because `diskScanner`'s mtime
  cache escaped the first fix and wrote to the host.
  *(Note: `src/platform/portable.ts` is NOT this — it is the fallback provider
  for unsupported OSes. An older handoff wrongly said it covered D3.)*
- **D1** (`services/fleet/*`, `/api/fleet*`, Fleet tab). **A SEPARATE LAN
  listener with three routes; the main API is not mounted on it and stays on
  127.0.0.1** — that isolation is the guarantee, not a check. One allow-list
  (`fleetSummary.ts`). Six-digit code, constant-time, spent once; a wrong guess
  does NOT close the window. Binds specific private IPv4s, never 0.0.0.0.
  **No remote-delete route exists.** mDNS hand-written on `dgram`, no dependency.

---

## The release recipe (v2.6.x proven — do exactly this)

1. `npm version X.Y.Z --no-git-tag-version` + `npm install --package-lock-only`
   (the lock goes stale otherwise), commit "Release vX.Y.Z".
2. `npm run build && npx electron-builder --mac --dir` (the local DMG step is
   broken — dmg-builder background.tiff — CI builds the real installers).
3. Verify the bundle: PlistBuddy version, `Resources/gdu/gdu` present,
   `codesign --verify --deep --strict` ("0 valid identities" during the build is
   normal — afterPack ad-hoc signs).
4. `osascript -e 'quit app "TreeMap"'` → `rm -rf /Applications/TreeMap.app` →
   `ditto release/mac-arm64/TreeMap.app /Applications/TreeMap.app` → open →
   find the port via `lsof -nP -iTCP -sTCP:LISTEN -a -c TreeMap` → curl
   `/api/system`.
5. **`npm rebuild better-sqlite3`** immediately after any electron-builder run.
6. The user pushes, then publishes via the prefilled link
   `https://github.com/Prithvi-Web/TreeMap-Disk-Visualizer/releases/new?tag=vX.Y.Z&title=vX.Y.Z`
   (create-tag-on-publish fires Build & Release, which uploads all 8 assets).
7. Verify downloads: sha512+size of zip/dmg/exe against latest-mac.yml /
   latest.yml (the yml names the exe `TreeMap-Setup-…` while GitHub stores
   `TreeMap.Setup.…` — same file), mount the DMG, unzip + codesign, MZ header,
   and grep the shipped app.asar for the change itself.
8. **Every reinstall resets Full Disk Access** — the user must toggle TreeMap
   off→on in System Settings → Privacy & Security → Full Disk Access and
   relaunch, or the trash features hide.
   `open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"`

---

## CI: how it stays green, and how to diagnose it

- **Job logs are login-gated even on public repos** — `GET
  /repos/…/actions/jobs/<id>/logs` answers `403 Must have admin rights`, and
  step summaries are not in the REST API at all. **Annotations are the only
  public channel**, so the workflow puts the ASSERTION in the annotation, not
  just the test name: read them with
  `GET /repos/…/check-runs/<jobId>/annotations` (no auth needed). Informative
  failures are sorted ahead of `error: 'test failed'` wrappers so the 10-per-
  step cap keeps the useful ones, and async `# Error` lines share that budget
  rather than being appended past it. Never scroll the GitHub log viewer with
  scripts; it freezes the tab.
- **The annotator is `scripts/tap-annotate.js`,** plain CommonJS run by `node`
  — not `npx tsx`. It is the last-resort diagnostic step: when the job died in
  `npm ci`, a transpiler is not there to explain it. It is unit-tested against
  a RECORDED real `node --test` TAP file (`tests/fixtures/real-node.tap`),
  because four assertion-dropping defects survived hand-written fixtures.
- **The reporter is pinned** (`npm test -- --test-reporter=tap`). Node's
  default depends on the version and on whether stdout is a TTY, and the
  annotator reads TAP.
- **Wall-clock policy:** absolute latency asserts are sized for loaded shared
  runners. Machine-independent relationships are the real invariants.
- `.gitattributes` pins LF. `scripts/run-tests.js` expands the test glob in JS.
- **Never `.unref()` a timer that is a promise's only path to resolution.**
- POSIX-shaped things that are DIFFERENT-not-broken on Windows — skip with the
  reason, don't "fix": NTFS allocates truncate-only files solid; `blocks` is
  meaningless; fake-`/proc` fixtures can't exist; **`chmod` cannot make a
  directory read-only** (which is why two D3 tests carry a `NO_CHMOD` skip).
- Windows-host rules that ARE code rules: sanitizers `path.resolve()` requests,
  so fixtures live at `path.resolve('/root')`; test after()-hook `rmSync` needs
  `maxRetries/retryDelay`; async work must re-check `db === handle` after every
  await. And **`path.join` always joins with the HOST's separator**, even when
  building another platform's folder names — assert path shapes with `[\\/]`,
  never a literal `/`. (This one broke Windows CI from the D3 commit until
  29 Jul: the previous session guarded two D3 tests but this third one only
  surfaced after its push, in a run nobody was left to read.)

---

## Traps that will waste your time (all previously paid for)

1. **Run `npm test` as its OWN command.** Chaining it after `npm run build` in
   one shell line has produced spurious `lsof` and watcher timeouts more than
   once. Also: **`npm test | grep … && git commit` does NOT gate the commit** —
   grep succeeds on a failure line too. Read the pass/fail counts before
   committing.
2. **Restart the dev server after `npm run build`.** A server started before a
   build runs the OLD dist. This caused the one real mistake of the last
   session: a security guard that was correct in source appeared not to fire,
   and a fixture file was moved into the user's real `~/.ssh` before it was
   caught and restored.
3. **electron-builder silently breaks `npm test`** → `npm rebuild better-sqlite3`.
4. **Announce dev servers**, and never run one without `TREEMAP_DATA_DIR` (real
   scheduler + real snapshots otherwise).
5. **FDA resets on every reinstall.**
6. **Contract-test slices**: always `indexOf(end, startIdx)` and assert the
   slice is non-empty. **`appCode()` strips comments — never anchor on one**,
   and never phrase-match template-built text that wraps across lines. This bit
   three more times last session.
7. **Adding a tab means adding it to `TAB_VIEWS`** in
   `tests/frontendContract.test.ts`. It caught Games, Security AND Fleet — that
   is its job, not a nuisance.
8. **A feature that starts something at boot needs its `init*()` CALLED.**
   `initFleet()` existed and was never wired into `startServer`, so an enabled
   fleet stayed dead until toggled. Grep for the init AND the shutdown when
   adding anything with a socket or a timer.
9. **`/api/scans` returns only completed scans and carries NO `status` field.**
   Filtering on one matches nothing, forever.
10. **`git stash` mid-feature breaks the tree** — use `git show HEAD:path`.
11. **`/proc/*/fd` inside a TS block comment ends the comment at `*/`** — write
    `/proc/<pid>/fd`.
12. **The icon injector REPLACES `[data-icon]` elements** — classes on the same
    element are silently lost (put them on a wrapper), and `[data-icon]` CSS
    selectors are dead after boot (use `.ic`).
13. **`body::after` is the film-grain layer** — never reuse it (the nav scrim is
    `#navScrim`).
14. **Browser-pane testing:** rAF and transitions FREEZE when the pane is
    hidden. Canvas verifies via a `getImageData` grid; screenshots can be stale.
    Treemap folder cells are frames — centre-clicks hit files (set `#tmDepth` 2).
    Lazy `<img>` never loads in an occluded pane — force `loading="eager"`.
    `window.TreeMap` exposes state / showTooltip / allocationTooltipLine /
    resolveAllocation / openPreview.
15. **Tests touching app data set `TREEMAP_DATA_DIR` before importing services.**
16. **Thumbnails are `<img src>`, not `api()` calls** — no 429 backoff and no
    retry from the shared wrapper. That is why previews have their own
    rate-limit lane; do not merge the lanes back.
17. **A test fixture that sets a key to `undefined` still HAS the key** — the
    rule-pack validator then fails on "unknown key" instead of your assertion.
18. **`String.replace` with a string pattern replaces only the FIRST match.**
19. **Do not machine-dump the rule pack JSON** — `json.dumps` escapes the em
    dashes and explodes every inline array. They are hand-formatted because
    people edit them.
20. **`sseSend(res, event)` takes TWO arguments**; the event carries its own
    `type` field.
21. **`getPolicy()` is async**; `capabilityState` is exported from
    `platform/capabilities`, not `platform/index`.
22. **The user's installed TreeMap.app runs and writes to the real app-data dir
    continuously.** Any before/after check against
    `~/Library/Application Support/TreeMap` is worthless — isolate with a fake
    `HOME` instead. That is how D3's remaining leak was finally attributed.
23. **Never open the live index from a second process while a server is using
    it.** `openIndex()` ends in `discardIncompleteBuilds()`, which DELETES every
    root still in `state = 'building'`. That is correct for the shipping app —
    one process, and a half-built root whose builder died is garbage — but an
    out-of-process benchmark that calls `readTree()` will silently wipe an index
    the server is still building, and then report `readTree -> null`. Build the
    index to `state = 'ready'` first (`POST /api/index/build`, poll
    `/api/index/:jobId/result` for 200), and for read-only measurement open the
    file with plain `better-sqlite3` rather than anything that reaches
    `openIndex()`.
24. **`index.db`'s file size is NOT bytes-per-node.** SQLite never returns pages
    to the OS, so a discarded whole-disk build leaves the file inflated — it read
    342 B/node that way against a true 183. Measure with `VACUUM INTO` a copy, or
    `(page_count - freelist_count) × page_size`. Do the `VACUUM INTO` from a
    `readonly: true` connection so the live database is never rewritten.
25. **Browser-pane refs go stale the moment the pane resizes**, and the pane
    resizes on its own. A `left_click` on a stale `ref_N` lands on whatever now
    occupies those coordinates. In this session that silently pressed **"Turn on
    for this network"** and opened a real LAN listener on the user's Wi-Fi. After
    ANY resize, re-run `read_page` before clicking — and after touching the Fleet
    view at all, verify with
    `curl -s .../api/fleet` **and** `lsof -nP -iTCP -sTCP:LISTEN | grep 4290`,
    because the on-screen state and the socket are two different facts.
26. **A hidden browser pane freezes timers, not just rAF.** `await new
    Promise(r => setTimeout(r, 60))` inside `javascript_tool` never resolves and
    the call times out at 30 s. Measure synchronously (read `scrollWidth` after
    forcing layout) — but remember canvases sized in JS will then be **stale from
    the previous width**, which reads exactly like an overflow bug. Trends and
    the treemap both looked broken at 860px for this reason; only the treemap
    toolbar was real. Confirm any canvas-view finding on a fresh load at the
    target width.

---

## Conventions that override the spec (§3.2: follow existing code)

- Error envelope FLAT `{ error, code }` (+ optional additive `details`); success
  bodies flat. Test runner `tsx --test` via `scripts/run-tests.js` — no Vitest.
- `GET /api/capabilities` is the agent manifest; platform capabilities live at
  `GET /api/platform/capabilities`; `/api/snapshots` is scan history, OS
  snapshots under `/api/system/snapshots/*`.
- **Route changes must update the `ENDPOINTS` registry in `src/api/openapi.ts`
  in the SAME commit** — `tests/discoverability.test.ts` enforces it, including
  a **sorted** pinned destructive-endpoints list that is edited deliberately.
- **`tests/openHandleGuard.test.ts` pins which files may remove anything**:
  `cleaner.ts`, `offload.ts`, `trash.ts`, `compressionAdvisor.ts`. Adding to it
  requires the same argument those four make, written down.
- Frontend: one file, `registerView()` only, the `api()` wrapper (no raw fetch),
  `formatBytes` only, `escapeHtml` on every interpolation, all six §3.5 states
  per panel. Canvas reads CSS vars by name — never rename them.
- Sidebar (`#sideNav`): ⌘B / chevron → 64px rail; `main` has `width: 100%` (a
  grid item with auto margins otherwise shrink-wraps).

---

## Open work a next session could pick up (verified, not guessed)

Ordered by what would actually cost someone something. Everything below was
checked against the code on `f90496f`, with all three CI platforms green.

**A. ~~`attachWatchers` can end with zero watchers~~ — FIXED.** The `init` SSE
frame now carries `watchers` (how many actually attached) and, at zero, a
`reason`; the client refuses Live rather than sitting there looking attentive
over a disk it cannot see. Same class as the `startWatcher` bug in `21dbbca`,
same fix. `topLevelDirs` always including the root is what made the zero case
rare rather than routine, and that is now pinned by a test.

**B. ~~A chunked cart dry run is optimistic about the Time Capsule~~ — FIXED.**
`planProtection` returns `carryOver`, the capsule index as that plan would leave
it, and accepts it back to continue; `cartDryRun` threads it between batches.
The arithmetic is cumulative now, so the manifest no longer promises room an
earlier batch would already have used — and the caveat that admitted this is
gone from `cartManifestHtml`, because the thing it admitted is gone. A test
drives a chained plan beside an unchained one and asserts they differ.

**C. A capsule eviction has never run live.** The `evicts[]` line in the commit
manifest is covered by `planEviction`'s unit tests and by the plan's arithmetic,
but this Mac's cap is 28.5 GiB and no fixture has come close. Someone with a
smaller disk, or a deliberately lowered `timeCapsuleMaxPercent`, could prove it
end to end.

**D. Games' shader-cache rows have never rendered against a real library.**
No Steam, Epic, GOG or itch.io install exists here, so `loadGames` reports "no
library found". The rendering rule is asserted from source and the parsers have
fixtures; the honest no-library path is what runs live.

## Known gaps and honest limitations (stated in the UI — don't "fix" the caveats)

1. Clone/reflink detection is impossible without native code (aggregate delta).
2. The index size cap is still unbuilt (v3 defers it).
3. Windows zombie detection is absent (honest reason shown).
4. B4's elevated branch has never executed with a real password.
5. `better_sqlite3.node` ships inside app.asar (works; unpack if it misbehaves).
6. ~~README documents through B4~~ — **fixed** by the Phase 5 sweep (`c2fedaa`).
7. **Empty Folders lists structural directories** — `~/.Trash`, `~/.cache`, and
   `.git/objects/info` / `.git/refs/tags` inside every repo, because they really
   are empty. Trash-only and recoverable, and the ignore list is documented as
   applying to Smart Suggestions *only*, so this is consistent with the stated
   contract rather than a bug — but "Select all — 1000 top-level empty folders"
   makes it a footgun worth a product decision. Left alone deliberately; raise it
   with the user rather than changing the scanner unasked.

## What could NOT be verified on this Mac (state it; never fake it)

- **ffmpeg and Homebrew are both absent**, so C2's real encode never ran. Only
  the honest-unavailable path was verified live; the pipeline is covered by 14
  tests through the tool seam.
- **smartctl is absent**, so C4's can't-know path is what runs here.
- **C7's "the game relaunches and rebuilds its shaders"** needs Steam and a real
  title.
- **D3's "runs from a real USB stick on a clean machine"** needs hardware. The
  no-trace guarantee itself IS proven, with an isolated `HOME`.
- **D2's "the entry visibly appears in Finder/Explorer/Nautilus"** needs a human
  with a mouse on each OS. The install/remove round-trips are proven.
- **`~/.Trash` is unreadable from the Claude shell (macOS TCC)**, so trash-only
  guarantees are confirmed via the code path and files leaving the fixture, not
  by listing the Trash.

## A watch that attaches and says nothing

**macOS `fs.watch(recursive)` can attach without error and then deliver
nothing at all.** Not a theory — captured from a traced full-suite run on this
Mac, with a per-callback trace on the raw `fs.watch` handler:

```
1787883135353 attach  …/T/tm-index-SZcWM7
1787883150385 detach  …/T/tm-index-SZcWM7      ← 15,032 ms later
```

Zero callbacks in between. The process wrote a file into that directory nine
milliseconds after attaching and polled for fifteen seconds. The very next
root in the same process got its first callback in **eleven milliseconds**, so
this is not the machine being slow — that one watch was simply dead. Roughly
one full-suite run in fifteen, only under load; never once standalone across
70+ isolated runs.

Nothing in `indexEngine` can make a silent watch speak, and the app has no way
to tell a dead watcher from a quiet directory, so `getRoot().live` still reads
`true`. That limit is stated rather than hidden.

**What was done instead: make the two causes distinguishable.**
`indexEngine` counts the events the OS actually delivers per root
(`watcherEventCount`), and the three live-update tests triage a miss:

| what happened | what the test does |
| --- | --- |
| the OS delivered **no** events at all | **skips**, saying so and naming this section |
| the OS delivered events and the change still did not land | **fails**, saying `this IS a bug here: the OS delivered N event(s)` |

Both halves are verified by mutation: a `fs.watch` stubbed to swallow every
callback produces the skip; reverting the `meansGone` fix so events arrive and
are dropped produces the failure. **Do not "simplify" that triage into a plain
assertion.** The single message it replaces — `never landed in the index at
all` — was printed for both causes, and three sessions of this project were
spent chasing the wrong one.

## The long-standing intermittent: FOUND, and it was not a flaky test

**Root cause: a bare `catch` that read every `lstat` failure as "this file no
longer exists".** `src/services/indexEngine.ts` and `src/platform/base.ts`
both wrapped the watcher's `lstat` in `catch { stat = null /* gone */ }`, and
`stat === null` runs `deleteSubtree`. `ENOENT` means gone; `EMFILE`, `ENFILE`,
`EACCES`, `EIO` and friends mean *could not find out* — and `EMFILE` is
routine in a process that opens thousands of files to scan a disk, which is
why CI saw this and an idle laptop did not.

It was found by INJECTING one errno rather than by reasoning about it. Two
measurements, on a machine where nothing had been deleted:

| Injected | Before | After |
| --- | --- | --- |
| One `EMFILE` on an indexed 50,000-byte file | index dropped it — **total went 60000 → 10000 while the file sat on disk** | 60000, unchanged |
| One `EMFILE` on a newly created file | never indexed, and never re-examined — `never landed in the index at all` | lands 400 ms later, via the retry |

The second row is the CI failure verbatim: `an external create, resize and
delete each land within 2 seconds`, macOS, `actual: -1`. Reproduced locally at
about 1 run in 40 under load, and it is the same defect as the first row —
only milder, because there was no row to delete yet.

**The rule now lives in `src/utils/errno.ts` (`meansGone`)** and is applied in
the base watcher, the Linux watcher, `applyPendingChanges`, `ensureParents`,
`storage.readJsonFile` and `timeCapsule.reconcileCapsule`. An undecidable
answer leaves the index exactly as it was and re-asks on the next flush, up to
`MAX_CHANGE_ATTEMPTS`; past that the root is marked **stale**, which is the
word this codebase already uses for "a change may have been missed".

`tests/watcherTransientErrors.test.ts` pins it. Reverting `meansGone` fails
four of its five tests; removing only the retry fails two; and *a real deletion
is still applied* passes throughout, so the suite is not merely detecting
change.

### Where else the same bug class was found

Same audit, same shape — a failure read as a fact — all fixed:

- **`storage.readJsonFile` returned "empty" for any read error**, and twelve
  callers are read-modify-write, so "start fresh" quietly meant "overwrite what
  was there". Now only `ENOENT` (absent) and unparseable JSON return the
  fallback; anything else throws.
- **`timeCapsule.reconcileCapsule`** reads that store, concludes every payload
  directory is an orphan, and `rm -rf`s it — from an unattended timer. One
  transient errno would have destroyed the protected copy of every file the
  user had ever deleted through TreeMap. Fixed at the source, plus a guard
  that refuses the orphan sweep when the index lists nothing while payloads
  exist on disk.
- **`policy.getPolicy`** returned no allowedRoots, no protectedPaths and no
  byte cap — the exact shape that disables every guard rail on agent deletion.
  A security boundary failing open, fixed by the same `readJsonFile` change.
- **`timeCapsule`'s `hasPayload` downgrade** is one-way and was triggered by
  any `stat` error, permanently retiring an intact payload.
- **`offload`'s `diskUsage(...).catch(() => ({ free: 0 }))`** re-invented the
  "0.0 GB free" bug that `diskUsage` had just been changed to prevent. It now
  refuses with `DEST_SPACE_UNKNOWN` rather than printing a false number.

### Still open, and deliberately not fixed here

The **open-handle delete guard** documents a three-state contract — checked /
checked-but-incomplete / not-checked — that no code path can currently
produce: all three platform backends return `[]` on failure, so a probe that
never ran reports "nothing is open" and the delete proceeds. `complete` has no
consumers and is hardcoded `true`. Fixing it means widening the platform
contract across three backends, which is a larger change than this session's
scope; the honesty machinery is already written and merely disconnected.
`src/services/trash.ts` silently under-counts unreadable trash locations, and
`snapshotRecovery` reports "this system has no snapshots" when the probe
merely failed. All three are worth a session of their own.

## One intermittent worth knowing — now narrowed to three candidates (SUPERSEDED — kept for the record)

It recurred on 27 Aug: **one failure in nine full-suite runs** that day (the
other eight clean, five plain and three with build chained in front). The name
was lost again — `npm test | tail -6` shows the assertion but not the test — but
this time the assertion detail survived:

```
code: 'ERR_ASSERTION', actual: 1, expected: 0, operator: 'strictEqual'
```

`expected 0, actual 1` narrows it to the three assertions in the suite that can
produce that shape:

| Candidate | Why it could see 1 |
| --- | --- |
| `openHandleGuard.test.ts:376` — `report.conflicts.length === 0` | **Most likely.** `lsof` sees a handle another process holds. This is trap 5's named flake shape, exactly. |
| `cartCommit.test.ts:131` — `index.entries.length === 0` | A capsule entry surviving into the first test. Its DATA_DIR is a fresh mkdtemp per process, so this needs an explanation nobody has yet. |
| `packageEcosystems.test.ts:136` — `entries.length === 0` | Least likely; no timing or cross-process input. |

The run that failed had `npm run build && npm test` **chained**, which is trap 1
— though three deliberate attempts to reproduce it that way were all clean, so
chaining is a suspicion rather than the cause.

**To catch it, keep the whole run and grep for the right marker.** Locally
`npm test` uses the **spec** reporter even when piped — verified: 1,214 lines
start with `✔` and none with `ok `. So `grep '^not ok'` finds nothing here and
the name is lost, which is how this got away twice in one session, the second
time following an earlier version of this very recipe. CI's workflow *does*
read TAP. Grep for both:

```bash
npm test 2>&1 > /tmp/suite.log; grep -E '^ℹ (pass|fail)' /tmp/suite.log
grep -nE '^(✖|not ok)' /tmp/suite.log        # the name
grep -A 12 -E '^(✖|not ok)' /tmp/suite.log   # the assertion under it
```

It is rare: **one failure in about twenty full-suite runs** on 27 Aug. One more
sighting with a name attached should settle which of the three it is.

### A SECOND shape, seen 27 Aug at the start of Phase 6

```
code: 'ERR_ASSERTION', actual: true, expected: false, operator: 'strictEqual'
```

**This is not the same intermittent.** `true/false` cannot come from any of the
three `expected 0, actual 1` candidates above, so the suite has two rare
failures, not one. Seen once in **ten** full-suite runs that session; the name
was lost again because `tail` caught the assertion after the summary had
scrolled past.

153 assertions in the suite have the `assert.equal(x, false)` shape. Only a
handful take timing, a subprocess or the filesystem as input, and the two
`scanCancel.test.ts` ones that look like candidates are **ruled out** — both
build their scan record synchronously and set `status` by hand, so neither can
race. What is left:

| Candidate | Why it could see `true` |
| --- | --- |
| `openHandleGuard.test.ts:356` — `report.checked === false` | **Most likely.** Asserts `lsof` could NOT answer; if a contended `lsof` succeeds after all, `checked` is `true`. Trap 5 names the B5 `lsof` tests by name. |
| `openHandleGuard.test.ts:172` — `complete === false` | A capped walk that did not get capped. |
| `indexEngine.test.ts:723/735/738` — `startWatcher(gone) === false` | The watcher family, also trap 5's. `startWatcher` gained the ability to answer `false` honestly in Phase 4, so a watch that unexpectedly attaches is now visible here. |

Same recipe as above to catch it, and **do not use `tail`** — the assertion
prints after the summary, so a short tail shows the failure with no name and no
count. Keep the whole log.
