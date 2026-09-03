# TreeMap — session handoff

## Session 9 — the seven number fixes, a CHANGELOG, and v5.0.0 (2 September 2026)

Shipped as **v5.0.0**, built, verified inside the asar, and installed at
`/Applications/TreeMap.app`. The previous build is parked at
`release/TreeMap-4.2.0-previous.app`. Gate: **2,412 tests · 0 fail · 3
skipped**, typecheck clean, `build-ui --check` matches (112 parts).

**v5.0.0 is not yet pushed and not yet published.** The owner pushes; the
GitHub release is theirs to publish and needs a `v5.0.0` tag before the
in-app updater can see it.

### The seven, and what each one was actually saying

Every one was the app stating something untrue. All seven are red-first and
mutation-proven; 47 mutants, 47 caught (7 needed a second attempt because the
first version of the test was not evidence).

1. **Fleet pairing was brute-forceable.** The doc comment claimed "a million
   possibilities against a three-minute window and a rate limiter"; there was
   no rate limiter, and an audit had measured 33,966 guesses in three seconds.
   Now five wrong codes per machine and fifty in total, checked BEFORE the
   offer is looked up so a sixth attempt is refused even when it is right.
   Addresses are normalised (`::ffff:` stripped) or a dual-stack socket buys a
   second allowance. A withdrawn offer raises a line in the Fleet panel.
2. **Offload said "need 0.0 GB"** about 30 MB. Both figures go through
   formatBytes now. The same line had a second untruth: the check refuses at
   bytesTotal × 1.02 but named the raw total, so inside that window it stated
   its own contradiction. The headroom is said out loud.
3. **The Trends dashed line and the date beside it were two different fits.**
   The chart ran its own unweighted linreg while the date came from the
   server's recency-weighted one — and with status 'ok' the server slope is
   guaranteed positive while linreg could still come back NEGATIVE, so the
   chart could draw a descending tail, clamped to zero, beside "disk full
   ~<date>". `forecastOk` (a boolean) became `forecastRate` (bytes/day, or
   null); the tail rises at exactly that rate.
4. **Sparse files claimed space the disk does not hold** and the gap was
   blamed on clones. See the two-sided note below — this one was shipped
   wrong first and repaired.
5. **Duplicates promised bytes trashing would not free.** The clone caveat is
   on screen on darwin, and after a trash the MEASURED delta is reported.
6. **"Used" meant two different things.** Half was already done in 9c14572;
   six UI/report/tray sites still derived `total − free`. They read the
   published `usedDisk` now, and the receipt says "Free to you" and draws the
   reserve as its own band.
7. **Two hard-link counts wore near-identical labels.** Relabelled, not
   recounted. A third row now reconciles them outright.

### What the adversarial pass found in work already committed

A 16-agent recon ran plan-then-verify on all seven. The verifiers were worth
more than the planners, because they audited SHIPPED code:

- **The sparse correction was one-sided and therefore wrong.** It subtracted
  only the shortfall and ignored block slack — a small file OCCUPIES more than
  it claims. Measured: `/usr/bin` claims 224.0 MB and holds 84.1 MB (slack
  0.3 MB, so it was nearly right), but 3,000 fifty-byte files claim 0.14 MB
  and hold 11.72 MB, where the scan UNDER-counts by 11.58 MB and the one-sided
  line said nothing — leaving the whole difference in Unaccounted under the
  clone explanation the fix exists to stop over-using. The error equalled the
  slack on every tree tested. Now a signed delta, and the receipt line is the
  NET, which is also what the allocation panel two clicks away has always
  reported.
- **The fleet alarm hid itself.** `renderFleet` early-returns for the disabled
  state and the alarm was only in the enabled branch — so turning the fleet
  off, the natural reaction, deleted the explanation.
- **The 429 named the wrong machine.** That text is read on the machine that
  TYPED the code.
- **A comment the fix made untrue.** `verifyPairingCode` still promised a
  wrong code never clears the window — true of one guess, false of fifty.
- **The duplicates measurement skipped the commonest roots** (`/`, `/Users`
  fail a one-directional `startsWith(home)`) and survived into a cloud scan.

### Verified in the INSTALLED app, not only in tests

Driven over CDP against `/Applications/TreeMap.app` (never the dev Electron
binary — Gatekeeper deletes it). A synthetic tree claiming 512.27 MB while
holding 1.81 MB, built in the scratchpad; the owner's real folders were never
scanned.

- `/api/capabilities` → 5.0.0; `/api/system` publishes `usedDisk`.
- A real scan on the **gdu-turbo** engine (the default) reported
  `sparseFiles 1 · sparseBytes 512.00 MB · slackBytes 1.55 MB` — matching
  `lstat` ground truth exactly, with the symlink correctly excluded.
- The receipt printed `sparseFiles −510.45 MB` against a `scanned` line of
  512.27 MB, so the statement now says the tree holds 1.8 MB — which is what
  `du -sh` says. `used + free + reserved === total` held.
- Dashboard: "1 file claims 512.0 MB more than it takes" (verb agreeing), and
  on a three-name inode "2 extra file names (8.0 MB)".
- Legend: "Free to you — 280.6 GB". No reserved band on APFS, correctly.
- Duplicates: the clone caveat rendered under "up to 4.0 MB reclaimable".
- Fleet alarm rendered in BOTH branches, in both themes, and vanished once a
  fresh code was on screen.
- Offload against a real 20 MB volume: "this needs 30.0 MB plus a little room
  to spare, and only 19.3 MB is free".
- No horizontal overflow at 640 / 900 / 1440, no `will-change` at rest, no
  backdrop-filter on the new surfaces, no console errors.

### Traps this round paid for

- **`asar extract-file` writes to the CURRENT DIRECTORY**, not stdout. A
  verification script that redirects its output silently overwrote the repo's
  `package.json` with the asar's stripped copy (no scripts — `npm test`
  became "Missing script: test") and littered eight extracted `.js` files into
  the repo root. Read an asar by parsing its header in Node instead — the
  format is a 8-byte pickle prefix, `readUInt32LE(12)` is the JSON directory
  size, that JSON follows immediately, and each entry's `offset` is relative
  to `16 + jsonSize`. Twenty lines, and it cannot write to your working tree.
- **Replacing every `"version": "4.2.0"` in package-lock.json bumps
  DEPENDENCIES.** Six third-party packages were moved to a version that does
  not exist. Only two nodes describe TreeMap: the lock root and
  `packages[""]`.
- **`shasum -a 256 $FILES` with an unquoted zsh variable is one bogus
  filename.** shasum errors, and the empty-string digest is compared to
  itself — a restore check that always passes. This is the same trap the
  prompt warned about, met in a new place.
- **A mutant that "passes" may not have been applied.** One gdu mutant
  reported green because its anchor did not match and the file was never
  changed. Assert the anchor count inside the mutation script.
- **`-0 !== 0` under `assert/strict`** (Object.is). A measured zero produced
  by negation must be normalised.
- **`renderFleet()` takes no arguments** — it reads `state.fleet.data`. And
  `switchView('fleet')` re-fetches, overwriting anything you just stubbed.

### Left undone, deliberately

- **A fast rescan under-counts the claimed-versus-held line.** Unchanged
  folders are read from the previous scan and not re-measured, and no
  per-node allocation is persisted. The line says it is a floor. Persisting
  allocation per node is the real fix.
- **`reclaimableCaveat` / `reclaimableIsUpperBound` are still dead.** The
  server computes them; `/api/duplicates` and the MCP tool both drop them.
  The clone line on screen is the client's own darwin check, so those two
  fields remain unreachable. Merging them would mean two mechanisms for one
  sentence.
- **Decimal vs binary bytes** and **Empty Folders listing `~/.Trash`** remain
  the owner's product decisions, per session 8.


## Session 8 — the polish round (2 September 2026)

Owner: "pushed it, check the ci. and polish anything you need to. Make this
application the best in the world." CI run 33592780731 was **green on macOS,
Windows and Linux** for the v4.1.3 work. What follows is the round after it.

Shipped as **v4.2.0**, installed at `/Applications/TreeMap.app`. Gate:
**2,373 tests · 0 fail · 4 skipped**, typecheck clean, `build-ui --check`
matches (112 parts — `app/237-tablists.js` is new).

### The one the owner could feel

TreeMap's main process sat at **20–60% CPU with the window closed**, eighteen
minutes after its last scan. `sample` put the time in `sqlite3_step` on a
`SUM(is_dir)` over 1.1M rows, and the index's own WAL ticked every second or
two. The app-data directory lives under the home folder, the home folder was
the indexed root, so **every flush wrote the WAL, the watcher reported the
WAL, and the next flush applied it and wrote the WAL again** — for ever, at
the 400 ms cadence, each turn re-counting the whole root.

Two changes: `startWatcher` drops events inside `appDataDir()` (case-folded
off Linux — Electron's userData is `treemap`, `appDataDir()` says `TreeMap`,
one directory on a case-insensitive volume), and `applyPendingChanges` keeps
the root counts **by delta** (subtree deletes use `RETURNING is_dir`) instead
of re-summing the table.

Verified in the INSTALLED app, not just in tests: an isolated data dir placed
inside the scanned root (the exact loop condition), index `ready`, watcher
`live` — **0.0% CPU across 40 s and a frozen WAL**, and a file created in the
watched tree still landed (31206 → 31207), so the fix silences the app's own
writes and nothing else.

### The one that was worst to say

On a Mac without Full Disk Access, scanning Desktop or Documents returned
nothing and the app reported "Scanned 0 files — 0 B", toasted "Scan
complete", and the first-run card **congratulated the user on a clean
folder**. The server now counts what it was refused; the page names those
folders and offers the Privacy settings button; an older server gets a
one-call probe (the picker's listing endpoint answers 403 for a protected
path) for a 0-byte root or a protected home folder the scan came back empty
from. A 404 is "not here", not a refusal. 0 B in 0 files is never toasted as
success, and the tour takes its "could not check" branch.

### The rest, by cluster

- **Security.** Scan-root confinement was TEXTUAL: a directory symlink inside
  a scanned folder walked every "inside the root" gate out to any file on the
  disk. It now judges where a path LIVES (parents resolved, leaf as spelled,
  so the link itself stays trashable). Plus a Host-header check, a runtime
  CSP, a per-launch API token for the desktop app, and a non-loopback bind
  that refuses to start without a token.
- **Keyboard and dialogs.** One net gives all thirty-two sheets focus,
  a Tab trap, inert underneath and focus restored. Two real bugs fell out:
  stacked sheets were ordered by DOM, so a confirmation opened FROM Settings
  painted behind it; and Escape read the FIRST open backdrop, so it closed
  Settings underneath the confirmation. The thirteen tablists are real tab
  lists now (role=tab, arrows, roving tabindex).
- **Desktop.** Window state restored, a real menu (DevTools and Reload
  dev-only, so ⌘R can never bin a running scan), dock progress, a scan queue
  for dropped folders, an updater that stops nagging.
- **Numbers and copy.** `formatBytes` never prints "1024.0 KB"; sparse files
  are not cloud placeholders; APFS clones are not reclaimable bytes; one date
  formatter; one dialect (color/center/folder); a welcome screen that
  explains a treemap instead of comparing itself to GrandPerspective.
- **Docs.** README, SECURITY, the issue templates, views.svg and the package
  metadata were checked against the code, line by line, and now agree with it.

### Traps this round paid for

- **`braced()` closes on a brace in the SIGNATURE.** `async function api(url,
  options, opts = {})` and `function cartDockToggle(open, { focus = false } =
  {})` both "closed" on their own parameter list, so three test files were
  asserting against the two characters `{}` — silently passing. Every copy of
  the helper now walks the parameter list first.
- **A new function name can collide with a slice anchor.** A helper called
  `baseNameOf` matched `function baseName`, an anchor three
  frontendContract slices depend on, and being EARLIER in the page collapsed
  all three regions to the empty string. Grep the anchors before naming.
- **A region anchor must be a single-line comment.** `slice('/* ── X ── */',
  …)` does not match `/* ── X ──\n   prose */`. Put the prose in a second
  comment.
- **`open -a` DOES pass an env var through.** A CPU measurement taken against
  `TREEMAP_DATA_DIR=… open -a TreeMap` was reading an EMPTY index with no
  watcher and would have "proved" the fix at 0% while proving nothing. Always
  confirm the watcher is `live` before believing an idle number.
- **A golden fixture holding a wall clock can never match.** `expiresAt` went
  into the byte-identity goldens; it is normalised like every other volatile
  number now, and the fixture was re-recorded only after a structural diff of
  all eleven endpoints showed exactly three added keys.

### Left undone, deliberately

- The audit's second wave (a 115-agent verification pass) raised items nobody
  has implemented: a brute-forceable 6-digit fleet pairing code with no rate
  limit on the peer server, "need 0.0 GB" in the offload space error, the
  Trends forecast line and its date coming from two different fits, and a
  sparse-file receipt that blames the gap on clones. All are written up in
  `scratchpad/polish-raised-2.json` reasoning, none are in this build.
- Decimal-vs-binary bytes (data-truth-6) is the owner's call, not a defect:
  the app is internally consistent and disagrees with Finder by ~7%.
- v4.2.0 is built and installed but **not published as a GitHub release**.

## Session 7 — "blazing fast in all areas" (2 September 2026)

Owner, after trying v4.1.1: "hover still feels slow, do the sidebar and card
beam too … when I scroll in settings up and down it gets slow and glitchy …
near duplicated images … glitchy. I want this to be insanely fast." Suite
**2,190 · 0 fail · 3 skips**; typecheck clean; `build-ui --check` matches;
every change red-first and mutation-proven (six mutants, six caught). Shipped
as **v4.1.2**.

### The four design removals the owner authorised

All four keep their frost and lose only the part that cost frames:

- **`#sideNav` → `plain: 1`** (no displacement lens; `::before` keeps
  `blur(26px)`). Its collapse/expand crossed ~21 size buckets, each a
  displacement-map build on the main thread.
- **`.modal` → `plain: 1`** (keeps `blur(30px)`). It was the strongest lens in
  the file (scale 44) over up to 660×84vh.
- **`.modal-backdrop` loses `backdrop-filter: blur(8px)`.** This was the
  Settings glitch. The scrim is a full-screen fixed surface with the modal
  inside it, and Chromium expands damage to the WHOLE of a backdrop-filtered
  surface — so every scroll frame inside Settings re-blurred the entire
  screen at 2× DPR, on top of re-running the modal's own lens. The tint
  carries the focus alone; `--scrim` deepened 0.52→0.60 dark, 0.34→0.42
  light to compensate.
- **The card-hover `md` beam is gone** (`fxHoverSync`, its two document
  listeners, its takeover doors in `fxStateBeam`, and `fxStateBeamLit`, which
  only hover read). A custom-property animation recomputing style every frame
  for the whole hover. The `.card.glass:hover` lift is the whole affordance
  now; state beams (scan, hunt, compare) keep the envelope to themselves.
  `tests/fxBeamStates.test.ts`'s six hover tests became two — and the harness
  now records what the wiring registers on `document`, so "hover lights
  nothing" bites on source, not only on the harness's return list.

Verified on the rebuilt page: sidebar, all 13 modals and the tooltip report
`__lg.key === 'plain'`; the scrim's computed backdrop-filter is `none`.

### Settings: the content was never the problem

Measured with Settings open: **179 nodes, zero** will-change / goo / roll /
beam / filter / backdrop-filter / sticky elements inside the modal, and
**0.66 ms** of layout per scroll step. The whole cost was the compositing
stack above — the scrim blur and the lens — both now gone.

### Near-duplicates: thumbnails were fine; the first look at a cluster was not

Measured against a 240-image synthetic corpus (sharp-generated, so no real
photo was touched): a thumbnail is a **256×192 WebP of ~1.1 KB**; the strip
is already windowed (12 clusters × 24 images, delegated handlers,
`content-visibility: auto` on rows); the main scroller costs **0.12 ms** of
layout per step. What a scroll into a fresh cluster actually triggered was
**24 cold renders at ~46 ms median** (sharp decode, four at a time) — the
images popped in over a few hundred ms. Now `GET /api/near-duplicates`, the
first time it returns a completed job, renders every clustered file's
thumbnail in the background (`warmThumbnails` in `services/thumbnailCache`,
`THUMB_DIM`/`THUMB_MAX_INPUT` moved there so route and warm can never
disagree; each file is stat'ed so the cache key is the route's key; tracked
with `trackWrite` so tests `settled()` it). Measured after: **5 ms median,
9 ms wall for 24**. `tests/nearDupeThumbWarm.test.ts` (fixtures must clear
the job's 4 KB `MIN_IMAGE_BYTES` floor — noise, not a pattern).

Honest limit, again: scroll *feel* is compositor work and the pane cannot
show it (`document.hidden`; lazy images never even start there). Layout,
DOM and server costs above are measured; the paint side is code-verified.

### Traps this round

- **Never edit sources while `npm test` is running.** A background gate sat
  at 0% CPU for ten minutes on `compressionProgressStream.test.ts` after the
  server files under it were rewritten mid-run; alone, that test passes in
  1.0 s. Kill the runner (`pgrep -f run-tests.js`), rerun clean.
- **macOS has no `timeout`.** `timeout 150 npx …` is "command not found",
  and a `| grep` after it turns that into silence. Enforce wall clocks from
  Python (`subprocess.run(..., timeout=)`), or `node --test-timeout`.
- A backgrounded `cmd | grep | tail` reports exit 0 even when `cmd` failed.
- `api()` in the page throws on a 202 ("Still working on that") — poll with
  a try/catch, not a status check.

### Second pass: what the 37-agent audit added (same day)

31 findings raised, 28 survived their verifiers, and they reduce to one
structural fact plus a damage story. Everything below is red-first and
mutation-proven (eleven mutants, eleven caught), verified on the rebuilt
page in the pane, and shipped as **v4.1.3**.

**The structural fact.** Every Liquid Glass host was `isolation: isolate`
with a `mix-blend-mode: screen` ring on `::after`. In the dark theme that
made the WHOLE host — sidebar, sheet, panel, toast — an isolated offscreen
compositor group redrawn on every damaged frame, and the frost then read
its backdrop from that group's own empty framebuffer, so the glass was very
likely blurring nothing. One line: the blend is gone, `--ring-a` 0.50→0.58
so the ring reads the same. (The light theme had already opted out.)

**The lens is now opt-in nowhere.** Every TARGETS entry is `plain: 1`; the
engine's displacement-filter machinery stays for a surface that drops the
flag. The preview pane and cart panel sat fixed over the map and were
re-filtered on every frame damage touched them; the live feed's spark
canvas repaints every rAF inside its own lens; toasts paid a map build per
width bucket mid-fade; the reclaim popover ran a blur under an OPAQUE base
(`--lg-backdrop: none` there too). Verified: `svg filter[id^=lg-f-]` count
in the DOM is **0**.

**Hover: damage, not JavaScript.** A hover change blitted the whole treemap
canvas, so compositor damage spanned the map and every frosted overlay on it
re-blurred. `presentTreemap(clip)` now takes the union of the old and new
hover rects (padded 3px) from `tmHoverUnion`, clips, and blits only that
region from the buffers; the lens and the non-rectangle renderers keep the
full present. Every overlay below the blit iterates all rects and paints
nothing outside the clip; what is outside was on screen from the last full
present. Also: `#cartTab:hover` no longer lifts (a moving frosted surface
re-blurs per frame); `.gcell:hover` no longer lifts (a lifted cell stays
promoted through its leave transition after z-index snapped back, squashing
every overlapping sibling into new layers); `.card.glass` transitions only
`transform` — the 80px shadow steps instead of repainting the card for ~9
frames each way.

**Modals.** `.modal` is a near-opaque pane (`--lg-backdrop: none`, the
global-search 94% recipe): its scroller lived inside its own backdrop
surface and every scroll frame re-blurred ~2M device pixels. Effects behind
an open sheet are paused, scoped with `:not(.modal-backdrop.open *)` so the
offload strip and the Settings orb inside a dialog keep running.

**Near-duplicates.** Clusters wrap (`flex-wrap`, `overflow: visible`)
instead of scrolling sideways: a horizontal scroller nested in the vertical
one latched two-finger gestures that drifted sideways (the page stuck, then
jumped) and gave each overflowing cluster its own composited scroll layer.
The render lock moved from tile to cluster. A mid-scroll append inserts 4
clusters × 12 images (was 12 × 24) 1000px ahead, stamps cart state at build
time so `refreshCartButtons` has nothing to rewrite, and syncs only the
nodes it inserted (`refreshCartButtons(roots = [document])`). Verified in
the pane: 0 strips with horizontal overflow, 0 unstamped cart buttons.

**Permanent layers.** `will-change` removed from `.fx-roll-col` (~40
compositor layers on the dashboard at rest), `.fxgoo-sil` and `.fxgoo-thumb`.

### Deferred from the audit, with reasons

- **Static pill beams** (Live / Lens / Loop / Diff / Hide-cloud spin a
  registered custom property at 60fps while a mode is on, plus a bloom
  child): needs a `spin: false` knob threaded through `normalizeOpts`, the
  sheet cache key and `buildRotateCSS` in the beam engine, and a rewrite of
  the pill tests. Engine surgery; a round of its own.
- **Sidebar frost static above 900px**, the shimmer's `steps(16)`, collapsing
  rolled digit strips back to text after the glide: low, polish.

### Still open, small


- The `viewIn` entrance animation (`transform: translateY(8px)` + opacity,
  350 ms) makes the whole view a moving layer while it plays; a scroll
  started inside that window is not composited. Cosmetic; untested.

## Session 6 — the scrubber glitch and the hover cost (1 September 2026, later the same day)

Owner's report, verbatim: "the slider is very glitchy and the ui breaks", and
"the reaction/animations to my mouse hover is slow. I need the app to be
blazing fast." Both were reproduced against the built page and **measured
before anything was changed**; every number below is from the browser, not
from reading code. Two commits, eight source files, one new test file
(`tests/scrubberAndHoverCost.test.ts`, seven tests, each red first and
mutation-proven to bite — fifteen mutants, fifteen caught). Suite
**2,192 · 0 fail · 3 skips**; typecheck clean; `build-ui --check` matches.
Shipped as **v4.1.1** to `/Applications/TreeMap.app`.

### The scrubber: one cause, three symptoms

`#tmTimeLabel` reads "Live" until the first `input` event of a drag, when it
becomes "Sep 30, 10:31 PM · 1023.9 GB". Measured: **23px → 174px**. The bar
is a wrapping flex row and the range is `flex: 1 1 140px`, so on the first
pixel of a drag the TRACK went **558px → 407px** at a 977px bar (−27%): the
same pointer x mapped to a different value and the thumb jumped. At a 640px
bar the row wrapped (**46px → 84px** tall) and shoved the map down mid-drag.
The Liquid Goo trail's ResizeObserver saw the input resize and reset its
simulation, so the trail teleported too. One cause, three symptoms.

Fix: `.tm-timebar .tm-timelabel { min-width: 25ch; flex: 0 0 auto }`. Sized
by measurement — the app font gives 7.6px per ch, so the label is 22.9ch;
**23ch was still unstable at 640, 24ch and up held at every width tried**;
25ch (189px) leaves two characters for a wider locale. Verified on the rebuilt
page: track width and bar height are identical for "Live" and the longest
label at 640, 760, 900, 977 and 1100px. The old comment said "no reservation
is needed — a 170px reservation crushed the slider in narrow windows": true
when the bar could not wrap, false now that it does; a floor costs a second
row at narrow widths instead of a shorter scrubber. `motionWidth.test.ts`
still forbids a **px** floor (ch scales with the font); the new test requires
the ch floor to be at least ceil(28 × 0.85).

Also on the scrubber: the `input` handler called `lapseStop()` unconditionally
→ `lapseReflect()` → `fxTmPillBeamsSync()` = five `FxBeam.attach` calls (each
a config normalise + sheet `rebuild`) and four `aria-selected` writes that
wake the speed seg's goo observer — per input event, at pointer rate, when
nothing was playing. Measured at **half the handler's cost** (0.128 of
0.273ms). Now `if (L.playing || L.onDone) lapseStop()`; `onDone` keeps the
export contract, so a scrub still ends a take honestly. Per event after:
0.03–0.14ms.

### Hover: the JavaScript was cheap; the compositor was the cost

Measured on the built page: `showTooltip` **0.13–0.18ms**, `presentView`
(the hover highlight, a buffer blit) **0.008ms**, a full `drawTreemap`
0.75ms for 145 rects. Hover JS is not where the time goes — so do not
optimise it further expecting a feel change.

`#tooltip` was a full Liquid Glass lens: `position: fixed`, and its
`::before` carried `backdrop-filter: url(#lg-f-N) blur(18px) …` — an SVG
displacement-map **reference** filter — while following the pointer every
frame; and each new 8px size bucket rebuilt the displacement map (**4.6ms**
measured for 376×104, plus ~20 SVG primitives). A reference filter inside
backdrop-filter is rasterised against the moving backdrop on every frame;
plain `blur()` is the accelerated path. Fix: the engine's TARGETS entry for
`#tooltip` now carries `plain: 1`. `attach` still adds `.lg` — **the
`::before` is the tooltip's only fill; dropping it from TARGETS would leave a
transparent text box** (an adversarial verifier reached the same conclusion
independently) — but builds no filter, registers no ResizeObserver, pre-sets
`key: 'plain'` so `scheduleUnbuilt` never queues it, and `refresh` returns
early. Verified: `__lg.key === 'plain'`, `--lg-backdrop` unset, `::before`
= `blur(18px) saturate(1.85)`; `#sideNav` still carries its `url(#lg-f-…)`
lens as the control.

**Honest limit:** the compositor saving is a code-verified mechanism, not a
trace. The Claude pane is `document.hidden` (rAF never fires) and Electron's
window cannot be profiled from here, so "feels fast" is the owner's call. The
revert is one token: remove `plain: 1`.

Same-node frames: the mousemove rAF callback rebuilt the card (`innerHTML`,
then a forced layout to measure it) on every frame the pointer moved inside
one tile. Now `moveTooltip(x, y)` (in `115-tooltip.js`) repositions only —
0.011ms, `innerHTML` untouched, `dataset.x/y` updated so a resolver repaint
that lands mid-glide draws at the current pointer — and `showTooltip` runs
only when the node changed.

### What was NOT the problem, so nobody chases it

- 52 `requestAnimationFrame` call sites are not 52 loops. Border-beam, orbs,
  charts and goo all gate on `document.hidden` / IntersectionObserver /
  REDUCED and sleep when idle — verified in source.
- `updateTimeLabel`'s Intl formatting: 0.003ms.
- The goo silhouette is `position: absolute` (not a flex child). Its 300×150
  box is the SVG intrinsic size with overflow visible — a cosmetic oddity.

### Second pass: what the adversarial audit added

A 42-agent workflow (five analysis lenses over the built page, every finding
attacked by a verifier whose default is "refuted") raised 36 findings; 26
survived, and they collapse into the causes above plus three more, all fixed
in the second commit with tests that were red first and mutation-proven
(seven mutants, seven caught):

- **The return-to-Live race** (the audit found a far commoner trigger than
  the one I had left open). Scrub to the end → `setHistoryIndex(max)` →
  `loadTreemap` (a fetch). Drag straight back. When that stale live fetch
  landed, `exitHistoryState()` parked the thumb at Live under the hand,
  bumped `h.seq` — discarding the NEWER scrub's fetch — and the map reverted.
  The plan's own `histSeqAtStart` guard has a hole: the stale load can land
  inside the 120ms input debounce, before the newer scrub has bumped
  anything. So the rule is a flag: `history.scrubbing` is raised on `input`,
  `loadTreemap` returns after its awaits while it is up (a scrub in flight
  owns the map), `refreshTimebar` parks the thumb only when it is down, and
  only the newest `setHistoryIndex` lowers it (in `finally`, so a failed
  fetch cannot leave it stuck); `exitHistoryState` lowers it too. Verified in
  the pane by running the race for real: live fetch started, `input`
  dispatched, fetch landed — `h.active` stayed true, the thumb stayed at 1,
  the label stayed dated. This also closes the 1.5s post-scan timer case.
- **The goo trail launched from a stale rest position.** Playback
  crossings, seeks and Escape write `slider.value` with no event, so the
  trail's parked simulation went stale and the next touch sprang the accent
  blob across the whole track. `FxGoo.slider` now re-seeds at the measured
  thumb on `pointerdown` (fires before a click moves the value) and `focus`
  (before the first arrow key); `input` still only wakes, so the first move
  still trails — from where the thumb actually is.
- **Disk City had the tooltip's defect one view over:** `cityShowCard` on
  every pointer frame. Now `cityMoveCard` on a same-block frame; the card is
  stamped with `dataset.k` (count/score known, height and colour modes) so a
  fact landing later still rebuilds it once.

### Left for the owner — two design decisions with the audit's evidence

**Both taken by the owner on 2 September — see Session 7.**

Both are real costs and both are visible signatures; neither was changed.

- **Card hover ignites a spinning border beam** (`fxHoverSync` →
  `FxBeam.attach(card, { type: 'md' })`): a CSS animation on a registered
  custom property drives two masked conic gradients with filters, recomputing
  style every frame for the whole hover plus a 0.5s fade. Bounded to one card
  at a time (the verifier corrected the analyst's "42 cards"). Option: a
  static ring, or the `.card.glass:hover` lift alone.
- **`#sideNav` carries the full displacement lens** over a 232×window-height
  surface plus a `mix-blend-mode: screen` ring. Its backdrop is static above
  900px (the page ambience is deliberately un-animated, `005-base-ambience`),
  so it re-filters only when damage overlaps it — tab hover, search typing,
  the collapse transition (which crosses ~21 size buckets, each a `makeMap`
  + `buildFilter` on the main thread). Makes the *sidebar* feel heavy; it
  does not slow treemap hover. Option: `plain: 1` like the tooltip (keeps the
  frost, drops the lens), keeping a real blur below 900px where it floats
  over the map.

### Left open, small, with evidence

- `cssVar('--accent'|'--danger'|'--warn')` → `getComputedStyle` per
  hover-change frame in `presentTreemap`; verifier: style-only recalc, LOW.
- Live mode's `livePulseLoop` repaints the whole canvas for 1.2s after each
  filesystem event (Live only).
- Playback's `lapseLerpNodes` allocates every node per frame (playback only).
- The welcome screen's CTA beam keeps a 30fps driver alive while shown.
- `FxGoo.slider` has no `onFail`, so a throw inside a frame would half-tear
  the trail down; nothing in the shipped frame throws.

### Traps this session

- **macOS TCC revoked Desktop, Documents and Downloads for the Claude process
  mid-session** (Pictures, Library and `~` stayed readable — that trio is the
  signature). Not Claude's sandbox: the denial persisted with it disabled.
  The fix is the owner's: System Settings → Privacy & Security → Files and
  Folders (or Full Disk Access), then relaunch. While blocked,
  `/Applications/TreeMap.app/Contents/Resources/app.asar` still held the
  whole built page — a 20-line asar-header parser extracts it — so diagnosis
  continued off the bundle. Do not route around TCC with the firmlink alias.
- **zsh does not word-split an unquoted variable.** `T="npx tsx --test"; $T
  file` runs a command literally named `npx tsx --test`, prints nothing, and
  an empty `grep` for failures then LOOKS like a clean run. A red run was
  lost to this; mutation testing recovered the evidence.
- The pane's clock is frozen (`document.hidden`; rAF never fires; setTimeout
  is throttled to ~1/min): call the app's globals directly (`switchView`,
  `loadTreemap`, `showTooltip`, `updateTimeLabel`, `lapseStop`) and wait with
  MessageChannel hops. `window.innerWidth` is 0 there, so anything clamped to
  it (the tooltip's left) goes negative — an artefact, not a bug.
- `startScan` completes in the pane (SSE works) but the view stays on the
  dashboard: `switchView('treemap')`, then `loadTreemap(state.root.path)`,
  then wait for `!$('tmTimebar').hidden` — it needs ≥2 snapshots of the root.
- **`node_modules/dmg-builder/templates/` was emptied by hand in Finder at
  13:57** (a `.DS_Store` appeared, nothing else survived) — the same window
  in which `demo/05-magnifier.jpg` vanished from the working tree. The next
  `electron-builder --mac` then died with `ENOENT … templates/background.tiff`
  AFTER writing the zip, so the zip and the unpacked app were fine and only
  the dmg was missing. Restored surgically: `npm pack dmg-builder@24.13.3`
  into scratch, `tar -xzf … package/templates`, copy the folder back. Do not
  `npm install` to fix it — that can re-link native modules. A background
  task's "exit code 0" was the trailing `grep | tail`, not electron-builder:
  read the log for `⨯`.

## Session 5 — the journeys, 37 defects, two Windows lessons, and three audit rounds (1 September 2026)

**Suite: 2,185 tests · 0 fail · 3–4 skips** (was 2,008). The skip count moves by
one because a `fs.watch` test skips itself when the platform does not deliver an
event inside its window; 3 is the steady state, 4 is documented and expected,
and neither is a failure. `npm run typecheck` clean;
`node scripts/build-ui.js --check` matches (111 parts).

**CLOSED. Twelve commits, `32d7ee0..196a369`, ALL PUSHED to `origin/main`, and
[CI run 33537258196](https://github.com/Prithvi-Web/TreeMap-Disk-Visualizer/actions/runs/33537258196)
is green on macOS, Linux AND Windows** — verified job-by-job through the API,
not inferred. Packaged and installed as **v4.1.0** (see *The build that ships*).

### Checking CI from this laptop

`gh` is **not installed** here, and `GET /actions/runs/<id>/logs` answers **403
Must have admin rights** for this repo, so per-test counts are not readable from
a run. What does work, unauthenticated, is the jobs endpoint — use it, because
a run's top-level `conclusion` hides which OS actually did what:

```bash
curl -s "https://api.github.com/repos/Prithvi-Web/TreeMap-Disk-Visualizer/actions/runs/<id>/jobs" \
  | python3 -c "import json,sys; [print(j['name'], j['conclusion'], [s['name'] for s in j['steps'] if s['conclusion']=='failure']) for j in json.load(sys.stdin)['jobs']]"
```

Two things that follow from reading it rather than trusting the badge:

- The workflow has **no `build-ui --check` step**, which looks like a hole and is
  not one: the check runs inside the suite
  (`tests/buildUi.test.ts` shells out to `--check`, and a sibling test rebuilds
  from `src/ui` and compares byte-for-byte). All three of the required gates are
  therefore enforced on all three OSes.
- `skip: !isWin && '<reason>'` evaluates to `false` on Windows, so **Windows
  green is proof those tests executed**, not that they were skipped. That is the
  whole reason the repo uses that idiom instead of a bare early `return`, which
  reports as a PASS.

Honest limit: the macOS runner may or may not present the firmlink layout, so
`tests/pathSanitizerFirmlink.test.ts` can pass trivially there via its
`aliasIsReal()` guard. It was proven against the real filesystem on the owner's
own machine, which is the one holding the files.

### The build that ships

**v4.1.0**, packaged 1 September 2026 from `196a369` and installed to
`/Applications/TreeMap.app`. The previous installed bundle was 4.0.0 built
31 Aug 00:34 — it predated both the premium-UI round and the whole of session 5,
so it was missing 37 defect fixes, twelve audit fixes and the firmlink fix.

Then **v4.1.1** the same evening — session 6's scrubber and hover fixes, same
recipe, previous bundle parked the same way.

Minor, not patch: since 4.0.0 the app gained the premium-UI round (user-visible)
on top of the fixes. The version lives in **`package.json` only** —
`src/api/openapi.ts:14` reads it at runtime and the capabilities report derives
from it, so bumping one line moves the OpenAPI doc, `/api/capabilities` and the
bundle together. Two tests in `tests/discoverability.test.ts` assert exactly that
coupling, so a hard-coded version anywhere fails the suite.

To rebuild and reinstall:

```bash
npm run build && node scripts/fetchGdu.js && npx electron-builder --mac --publish never
```

`--publish never` is not optional politeness: `build.publish` in `package.json`
points at this repo's GitHub releases, and electron-builder will push a release
on its own if a token happens to be in the environment. The gdu binaries are
cached under `build/gdu` (104 MB, all five platforms) and `fetchGdu.js` skips
what is already there, so the build needs no network.

**Packaging rebuilds native modules against Electron's ABI, and that breaks
`npm test` until you undo it.** electron-builder recompiles `better-sqlite3`
for Electron 31 (`NODE_MODULE_VERSION 125`); the local Node here is v24
(`137`), so the next `npm test` dies with `ERR_DLOPEN_FAILED` in every
`indexEngine` test and looks like a catastrophic regression. It is not. Fix:

```bash
npm rebuild better-sqlite3
```

Either package last, or rebuild straight afterwards. The packaged app keeps the
Electron-ABI copy it needs, so rebuilding for Node does not touch the installed
bundle.

**Do not "fix" the packed `better_sqlite3.node`.** `asarUnpack` names only
sharp/@img/@foliojs-fork, so `better_sqlite3.node` (1.9 MB) sits *inside*
`app.asar`, which normally means a native module cannot be `dlopen`ed. Electron
patches `process.dlopen` to extract it to a temp file first, so it works — and
this was verified against the shipped 4.1.0 bundle, not assumed: a scan plus
`POST /api/index/build` on a throwaway folder reached `state: "ready"`, which
is only reachable through SQLite.

Reminder from the Gatekeeper note: this app ships **un-notarized by choice**.
Do not document a right-click→Open workaround — Apple removed that path in
Sequoia. The route is System Settings → Privacy & Security → *Open Anyway*, and
that button expires about an hour after the blocked launch. Note this does NOT
apply to the copy installed here: a locally built bundle carries no
`com.apple.quarantine` attribute (checked), so it launches with no prompt at
all. Gatekeeper only meets someone who *downloads* the dmg or zip.

### The most useful thing this session learned

Green tests are not a reviewed diff. The 37 defects were adversarially verified
as FINDINGS; nobody reviewed the FIXES. An audit of the session's own diff then
found **9 regressions it had introduced itself**, none of which any of the 2,139
passing tests noticed — a trailing-space folder made unreachable through every
guarded route, a popover floating over modals, a drain that drained nothing, a
preflight that discarded the conflicts it had found. A second audit, of those
nine fixes, found **3 more**, two of them data-risk.

So: after a large fix round, review the diff as if someone else wrote it. Budget
for it. The rate here was roughly one regression per four fixes, and it did not
reach zero until the second pass.

A third, narrow pass over the blocklist alone — 78 adversarial spellings of a
blocked path — then found something older and worse than anything the session
had introduced: **`/System/Volumes/Data/private/var/db` was accepted.** A macOS
firmlink is a mount feature, not a symlink, so `realpath` collapses neither
spelling, and both the textual blocklist and the parent test miss it. Same
device, same inode, 129 identical entries, `dslocal` inside. It was reachable at
every commit this session started from, and an unprivileged user can also get
there through a symlink they plant. Closed by stripping the Data-volume prefix
from the canonical form, plus a device+inode backstop gated on a basename match
so no syscall is added to the common path.

### Read this before writing a test: two things only Windows catches

The first push went red twice, both Windows-only, both invisible on a Mac. They
are different bugs with the same root: something that is true on the developer's
machine and not on the runner. Each now has a guard that fails on the laptop.

1. **A POSIX path literal sent to a guarded route.** `guardQueryPath` resolves
   `?path=`, and `/root` is not absolute on Windows — it becomes `D:\root`, so a
   fixture keyed on the POSIX spelling is unreachable and the route answers 404.
   It had been matching by accident for as long as express 5 was discarding the
   guard's output; fixing that made the sanitisation real.
   Guard: `tests/windowsPathFixtures.test.ts`. Derive the path
   (`path.resolve('/root')` + an `R()` join, as `apiHardening.test.ts` does), or
   mark a deliberately-foreign path `windows-ok: <reason>`.

2. **A test racing a fire-and-forget write.** `POST /api/scan?wait=true` answers
   when the WALK ends; the snapshot write is fired unawaited afterwards, and
   `/api/agent/summary` reads that store — so two reads either side of it
   disagree (`snapshotCount` 0 then 1). Correct product behaviour, untestable
   without knowing when the writing stopped.
   Guard: `tests/backgroundWrites.test.ts` + `src/utils/backgroundWrites.ts`.
   `await settled()` instead of polling. Every `void call()` in `src/` must be
   tracked or listed in `NOT_A_RACE` with a reason, so the next one cannot be
   added silently.

Neither guard replaces the Windows runner. They move the two known shapes eight
minutes earlier, and CI stays the authority.

### The three things session 4 left open are closed

1. **Stage 3, the end-to-end journeys, ran in full** against the real UI and the
   real server, on a disposable sandbox tree (185 files, 12.5 GB) under
   `TREEMAP_DATA_DIR`. Everything below was checked against the API payload, not
   just eyeballed: dashboard file-types (bytes AND percentages) · largest files ·
   largest folders · quick stats · treemap drill three levels deep (UI nodes ==
   API nodes, zero missing, zero size mismatches, breadcrumbs correct at every
   level) · `size>1gb` (UI 9 == API total 9, same paths) · staging 4 files to the
   cart · the commit's **dry run only** (`bytesWouldFree` 8,493,465,600 == the
   four files' sum; the sorted file list's md5 was byte-identical afterwards and
   nothing reached the Trash) · duplicates (8 groups, every group's `reclaimable`
   == `size*(count-1)`, their sum == `totalReclaimable`, and the funnel's three
   numbers reconcile) · a folder budget · a suppressing folder note (which did
   remove that subtree from Smart Suggestions) · settings persistence across a
   reload · snapshot compare against a REAL change (+254,803,968 B attributed
   entirely to `Downloads`) · Trends with the forecast gate closed (no
   projection). **The console is clean in all 15 views, in both themes, at
   640/660/800/900/1440 px.**
2. **The boot-burst 429s are gone, measured.** The real 26-request boot +
   scan-completion burst, captured from the browser's own timeline and replayed
   at a fresh server all at once: **0 × 429**, lane split 14 meta / 12 api
   against a 20-token api burst. Re-measured after the whole fix round: still 0.
3. **The known-open items are settled.** `GET /api/cleanup/rules` never reached
   `data.files` as undefined — `api()` throws PENDING first — but it DID paint
   "still working" as a red error; that is fixed. The 12 caller-less routes are
   all on the published agent surface (`src/api/openapi.ts`, pinned by
   discoverability/safety-rails tests): **delete none**. The two wall-clock perf
   tests were re-measured and both claims refuted — `subtreeCount` runs 17–23 ms
   idle, not 40–80 ms, and `indexEngine`'s ratio metric was already written under
   16 spinners. Nothing was loosened.

### What was fixed (29 confirmed by the review fleet + 8 found driving the app, every one test-first)

Backend: express-5's re-parsing `req.query` getter silently discarded
`guardQueryPath`'s sanitisation (one trailing slash 404'd a subtree that existed)
· the path blocklist was textual, so `/var/db` was allowed while
`/private/var/db` — the same directory — was blocked · `?maxAgeMs=abc` and
`minBytes=0` matched every file on the disk instead of 400 NO_RULES ·
`?currency=constructor` passed the `in`-based currency guard · body-parser 2
leaves `req.body` undefined, so a POST with no Content-Type answered 500 instead
of its documented 400 · shutdown cancelled every job except compression · the
image preview leaked a file descriptor on an aborted download.

Frontend: instant-open painted the whole indexed root's file/dir counts against a
subfolder's tree · Empty Folders printed its 1,000-item cap as the real count ·
the open-file preflight checked 400 of N paths and reported it as all of them ·
Grid shift-click threw on a stale anchor after the list shortened · "Check
snapshots" threw when every candidate was absent · the Clean Up modal dropped the
`blocked` bucket and over-reported bytes recovered · the report export was a raw
`<a>` that unloaded the whole app on a 202 · the Cloud-safe tab hid itself on a
202 · Enter in the path box was silently ignored during the boot auto-scan · the
treemap footer read "1 nodes" · the query box blamed Depth for a match that is
the view root.

CSS: `--ok` had no light-theme value · `.sys-facts .fact span` dimmed the rolling
numerals · `.scan-status.error` was dark-only · `#navScrim` sat under the cart,
preview and selection bar · `#previewPane` still offset 58 px for a header the
sidebar replaced in a previous round · the cart dock slid off-screen at 640 px
with a preview open · the global-search fly-out ran off-screen at 660 px · the
plain-words popover was trapped by `container-type` on the toolbar · **the Trends
charts could never shrink** (see trap 1).

Tests: 17 slices in `frontendContract.test.ts` used comment text as their end
anchor, and `appCode()` strips comments — so each ran to end-of-file and matched
text from anywhere later (two of them provably passed with the behaviour deleted).
Six more tests across five files asserted nothing.

### Traps this session bought

1. **A canvas with an explicit inline width is its card's min-content floor.**
   `Canvas2D.setup` writes `canvas.style.width` every render, so a chart measured
   once at 1440 px pinned its wrap, its card and its grid track; the window then
   shrank, `host.clientWidth` never changed, the kit's ResizeObserver never fired
   and the chart was clipped for good. `min-width: 0` does not help. The cap is
   `max-width: 100%`, and it must be max-width — an inline style outranks any
   `width` in the sheet, which is why the `width: 100%` several of these canvases
   already carried had never once applied.
2. **A brace inside a CSS comment desyncs every brace-matched slicer.** Quoting
   `main { overflow-x: hidden }` in a comment moved the following rule's selector
   into the comment text and turned a green test red for a rule that was
   perfectly correct. `tests/chartWrapNoOverflow.test.ts` now fails on any braced
   CSS comment; one already existed in `040-grid.css`.
3. **`req.query` is a getter in express 5.** Assigning to it mutates a throwaway.
   The same is NOT true of `req.body`, which is a plain own property.
4. **The Claude Code browser pane freezes more than rAF.** `ResizeObserver` never
   fires at all — not even its initial callback — `setTimeout` is throttled to
   about one tick a minute, and `document.hidden` is permanently true. A
   `MessageChannel` is NOT throttled, so it can back both an rAF pump and a
   working `sleep()`; anything ResizeObserver-driven simply cannot be judged in
   the pane, and layout claims have to be proven with a pure-layout probe.
5. **`computer` click coordinates are in the last screenshot's frame**, not CSS
   pixels — multiply by `800 / innerWidth`. Take a screenshot first or the call
   is refused, and re-measure the target immediately before clicking: a view
   switch or a breadcrumb change moves the canvas by tens of pixels.
6. The treemap's parent folder frames are deliberately not click targets — the
   children fill them exactly and the deepest rect wins. The folder tag is "an
   overlay, not a reserved header row". Only the deepest drawn folders drill.

### Known and deliberately not changed

`svg.fxgoo-sil` (the liquid-goo silhouette) is 300 px wide and absolutely
positioned, so it extends past its `.seg` and adds ~105 px to `main`'s
scrollWidth on the dashboard. It is `pointer-events: none`, paints nothing
outside its defs, and `main` clips it, so nothing is visible or reachable — but
inside a container with `overflow-x: auto` it would raise a phantom scrollbar.


## Session 4 — integration hardening, the reclaim radar, and the numeral bug (31 August 2026)

**Commits `a825e80`, `b001b69` (plus session 3's `d1f892f`, `a738ff8`, `9179042`,
`4697394`, `12ca306`). All LOCAL — the owner pushes via GitHub Desktop.**
Suite at hand-off: **2008 tests · 2006 pass · 0 fail · 2 pre-existing skips**;
typecheck clean; `node scripts/build-ui.js --check` matches.

### THE ONE THING TO READ FIRST

`public/index.html` is **GENERATED**. Edit `src/ui/**` (110 files) and run
`npm run build:ui`. `tests/buildUi.test.ts` fails the suite if the artifact is
hand-edited or a source changed without a rebuild. `src/ui/README.md` orients.

### Unfinished — pick this up

1. **The integration round's third stage never ran.** Stages 1 (contract sweep)
   and 2 (headroom + error paths) landed and are in `b001b69`. Stage 3 — the
   end-to-end journeys — stalled after 44 minutes of silence and was stopped.
   Nothing from it is committed. It was to drive the REAL UI against the real
   server: scan → drill → search → stage to cart → **dry-run** commit (then
   verify the files still exist) → duplicates → budgets → notes → settings
   persistence → snapshot compare, checking at each step that the screen agrees
   with the API payload, and that the console is clean in every view in both
   themes. **This is the main outstanding work.**
2. **Backend fixes are not live on the dev server.** `scripts/dev-isolated.js`
   requires `dist/`, so the rate-limiter lanes and route changes need
   `npm run build` and a server restart before any console check means anything.
   The boot-burst 429 fix has NOT been verified in a browser yet.
3. **Known-open, deliberately not fixed** (from stage 1/2 reports):
   - `GET /api/cleanup/rules` can answer 202 `{status:'running'}`; `runCleanFind`
     would read `data.files` as undefined.
   - 12 routes have no frontend caller (agent/MCP surface — verify before deleting).
   - Two wall-clock perf tests are load-sensitive: `indexEngine` "sub-quadratic"
     (now CPU-time based) and `subtreeCount`'s 400ms budget. They fail on a busy
     machine and pass isolated. **Investigate before believing a failure; never
     "fix" them by loosening the budget.**

### Traps this session bought the hard way

1. **`justify-self` on a grid item defeats a `minmax(0,1fr)` track** — it sizes
   the item to its content. That is how the breadcrumb came to paint over the
   view switcher.
2. **Never beam a Liquid Glass host directly.** `.modal` and `#cartTab` get their
   fill from `.lg::before`, and FxBeam writes the same pseudo-elements at higher
   specificity — the panel goes see-through. Both carry beam-only
   `.fx-beam-strip` children, and a `[data-fxbeam].lg` guard catches the next one.
3. **The rolling numerals inherit their host's neighbourhood.** A `.host span`
   rule written for a caption will style digit strips too, and `white-space:
   nowrap` on a host lays all ten digits on one line and blanks the slot. The
   reset in `140-fx-numerals.css` uses **longhands, never `font:`** — the
   shorthand also resets line-height and outranks the layout rules.
4. **Synthetic `.click()` does not reach many handlers in this app.** Use real
   input when verifying, or you will report working features as broken (I did).
5. **The preview pane reports `document.hidden === true` forever**: charts refuse
   to paint, rAF is frozen, `element.focus()` fires no focus event, and numerals
   take the plain-text path. Spoof visibility to inspect; verify motion with the
   Node pumped-clock tests. Console history also spans reloads — use a fresh tab.
6. **Editing `public/index.html` (or a source) while a suite run is in flight**
   makes string-matching tests fail once and pass on retry. That is not a flake.
7. **`FACTORIES` in `fxChartsPrimitives.test.ts` is derived**: adding a canvas
   primitive updates the count and requires the exact guard
   `if (life.dead || document.hidden) return;`. That test caught the radar.
8. **A test pinned to an exact line of code fails for changes that cannot affect
   it.** Two such pins were rewritten this session to assert their invariant
   instead. Prefer brace-matched blocks (`braced()` helpers exist in
   `premiumPolish.test.ts` and `motionWidth.test.ts`).

## Premium round 2: the two layout collapses, the full build-out, a review fleet, and the file split (31 August 2026, third session)

**Read this first: `public/index.html` is now GENERATED.** The frontend is
written as 110 files under `src/ui/` (shell · styles · markup · app) and
`scripts/build-ui.js` concatenates them in `manifest.json` order. Edit the
sources, run `npm run build:ui`. The build is a pure concatenation, so the
artifact is byte-identical to its sources and `tests/buildUi.test.ts` fails the
suite if anyone hand-edits the artifact or forgets to rebuild. `src/ui/README.md`
is the orientation. Every other test still reads `public/index.html` — that is
what ships, and the shipping constraint (no external resources) is unchanged.

### The two bugs the owner reported

- **File Types legend wrapped whenever the window left fullscreen.** Rows now
  hold one line at every width: `.fx-li-val`/`.fx-li-pct` are nowrap and a
  container query sheds the mini-bar at 360px and the file count at 260px —
  decoration before facts, never the value.
- **The treemap tabs sat unevenly.** The toolbar is two designed rows now
  (places: crumbs | centred switcher | search — settings: colour+depth left,
  modes and actions right), measured by container queries, with Disk City on
  the same system.

### What else shipped

A seven-stage build-out (rolling numerals, bklit loading choreography, the
remaining chart primitives — scatter/funnel/profitLine/barSquares/linear
gauges/brush/reference bands — every dashboard card and view wired to them,
liquid-goo round 2 incl. `FxGoo.detachPair` and bend, beams on every glass card
plus real activity states, entrance choreography and an every-width pass).
Then a four-lens adversarial review fleet (41 findings, 17 confirmed after
independent refutation) and a three-stage fix round.

### Traps for the next session

1. **Edit `src/ui/`, never `public/index.html`.** The suite will catch you, but
   you will have lost the edit.
2. **FX banner comments are extraction anchors** for fxCharts/fxBeam/fxOrbs/
   fxGoo/fxWiring, which HARD-FAIL if renamed. `buildUi.test.ts` also rejects a
   part boundary that lands inside a block comment. CSS banner copies use
   shorter `═` runs than the JS ones, on purpose.
3. **A new source file must be added to `manifest.json`** or `build-ui` refuses
   to build (an unlisted file would silently never ship).
4. **`justify-self` on a grid item defeats a `minmax(0, 1fr)` track** — it sizes
   the item to its content. That is how the breadcrumb came to paint over the
   view switcher; every nav-row group is `justify-self: stretch` now and aligns
   with `justify-content`.
5. **Never beam a Liquid Glass host directly.** `.modal` and `#cartTab` get
   their fill from `.lg::before`, and FxBeam writes the same pseudo-elements at
   higher specificity — the panel goes see-through. Both now carry beam-only
   `.fx-beam-strip` children, and a `[data-fxbeam].lg` guard catches the next one.
6. **Rolling numerals**: the digit strip must stay `aria-hidden` AND
   `user-select: none` AND `inline-block` — block boxes are paragraph breaks to
   the selection serializer, so a copy came out as "3\n4". Verify copy with
   `Selection.toString()`, never `innerText` (it ignores `user-select`).
7. **The preview pane reports `document.hidden === true` forever**, so charts
   refuse to paint, rAF is frozen and `element.focus()` fires no focus event.
   Spoof visibility to inspect, and verify motion with the Node pumped-clock
   tests. Console history also spans reloads — check in a fresh tab.
8. **Two wall-clock perf tests are load-sensitive** (`indexEngine`
   sub-quadratic — now CPU-time based — and `subtreeCount`'s 400 ms budget).
   They fail under a loaded machine and pass isolated; investigate before
   believing a failure, and do not "fix" them by loosening the budget.
9. **Editing `public/index.html` while a suite run is in flight** makes
   string-matching tests fail once and pass on retry. That is not a flake.

**Final: suite 1,945 · 1,943 pass · 0 fail · 2 pre-existing skips; typecheck
clean.** Commits `d1f892f`, `a738ff8`, `9179042`, `4697394` — all LOCAL, the
owner pushes via GitHub Desktop.

## Premium UI round: Apple-grade controls, FX libraries, bklit charts (31 August 2026, second session)

The ask was: polish the UI so it feels like Apple made it — fix the uneven
view-switcher tabs, port three GitHub libraries (border-beam, liquid-gooey,
thinking-orbs) into the app, and rebuild the graphs in bklit.com's visual
language, blue/black. Agents allowed, no time constraint, flawless bar.

### What shipped (4 commits, 838c04a → aac59e3, all local — NOT pushed)

- **2b0a609 — segmented controls + toolbar.** Every `.seg` is now a
  macOS-style segmented control: 30px recessed track, equal-width segments,
  hairline divider ticks, and a spring-animated **liquid goo thumb** (the
  liquid-gooey "Move" effect, ported to a vanilla `FxGoo` section — SVG
  silhouette + droplet trail, crisp DOM above, plain-CSS fallback on any
  throw). The `.tm-toolbar` became grouped rows (nav | view | find |
  appearance | modes | actions) that wrap as whole groups; every control
  normalized to 30px. Long-label segs opt out of equal width via `.seg-fit`.
- **aff550d — living surfaces.** `FxBeam` (border-beam port, re-tuned to a
  single blue palette) and `FxOrbs` (thinking-orbs port, all nine states,
  golden-parity tested against the upstream spec) spliced and wired to REAL
  states only: searching orb + traveling beam while scanning, solving on dup
  hashing, working on Autopilot, connecting on cloud, composing on export,
  shaping while Voronoi refines, weaving on plain-words; line beams on
  focused search fields, one-shot cart pulse on staging, halo on the
  first-run CTA. Every mount pairs with a destroy; structural tests pin it.
- **4cb9ea7 — bklit charts, blue/black.** `FxCharts` kit (area / rings /
  gauge / barList / liveLine + DOM-free math) on the Canvas2D toolkit:
  File Types donut → animated gradient ring with center total and
  [dot·type·count·bar·size·%] legend; Trends → dotted-grid area chart with
  crosshair tooltip and dashed forecast projection (date only when
  /api/forecast commits); budgets → 28-notch gauges; Largest lists → ramp
  gradient bars + percent column; Live mode → throttled spark of write
  activity; calendar heatmap recolored to the accent ramp.
- **aac59e3 — review-fleet round.** 4 adversarial reviewers (FX correctness,
  wiring/CSS fallout, test mutation-testing, idle-perf) produced 36 findings
  → 20 deduped fixes, all test-first. The big ones: crumbs collapsed to 0
  width in the new toolbar (`.tb-nav` needed a `min-width` floor; crumbs now
  clip the ROOT end, keeping the current folder visible); Disk City's
  toolbar silently lost its CSS (restructured to the tb-group system);
  goo rect width could go −0.2 (clamped + zero-size treated as hidden);
  theme toggle only repainted the donut (now refreshes every chart handle —
  test-pinned); liveLine ran 60fps for 2s-interval data (15fps gate); the
  fx tests' skip-if-banner-missing gates could silently disarm 46 tests
  (hard asserts now); favicon 404 (inline data-URI icon); plus orbs
  shared-observer/dpr/throw-isolation, beam attach memoization and
  lit-state-scoped host overflow, legend counts restored, separator
  ::before dividers, cloud orb killed on Settings close, 1-point series
  draws a dot, forecast label sequence guard.

**Final: suite 1,728 · 1,726 pass · 0 fail · 2 pre-existing skips;
typecheck clean.** Verified live in the browser (dark + light, theme
double-toggle, fresh-tab console clean, all fx states exercised).

### Traps for the next session

- The four FX sections live INSIDE the single app script between banner
  comments (`FX: Liquid Goo`, `FX: Border Beam`, `FX: Thinking Orbs`,
  `FX: Charts`) — the fx tests extract by those banners and now HARD-FAIL
  if a banner is renamed. The CSS copies use shorter ═-runs on purpose.
- FxCharts refuses to paint while `document.hidden` (repaints on
  visibilitychange) — in the embedded preview pane the page reports hidden,
  so charts look blank there until you spoof visibility; real windows fine.
- The preview pane also accumulates console history across reloads — old
  errors are NOT from the current page load; verify in a fresh tab.
- `read_console_messages` 429 noise is the app's own poll backoff testing
  the rate limiter; pre-existing, harmless.
- PERF-7 accepted as-is: the md beam's blurred layers raster ~60fps while
  a scan runs. If profiles ever complain, drop the bloom child during scans.

## v4 — Phase 9 complete: shell, discoverability and polish (31 August 2026)

The ask was: complete the final phase flawlessly, agents allowed, keep going
until done. Mid-session the owner made one scope call, confirmed explicitly:
**remove the Ollama integration entirely, keep the rest of Phase 9** — so
the plain-words box is deterministic-only, and that is recorded where a
future reader would wonder (queryRoutes, nlIntent header, AGENTS.md).

### What shipped

**9.1 — the command palette.** ⌘K/Ctrl+K (the key moved here from global
search because §9.1 assigns it explicitly; "/" keeps summoning search, the
shortcuts panel and PLATFORM_NOTES say so). One box over four sources: the
VIEW REGISTRY itself — every view reachable by construction, a
capability-blocked one shown with its own reason — a small action registry
(scan/rescan/empty cart/export PNG/global search/plain words/Settings/
shortcuts/theme), saved views, and recent scan roots. Free text always
offers "Search files for …", which is where the old ⌘K muscle memory lands.
An empty box BROWSES everything (QA caught the 12-row cap hiding three
views from the arrow keys); typed queries trim to the best dozen. Paints
above every other modal (z 130), scopes its keys to itself, restores focus
on every close path. The fuzzy scorer is pure and
tests/commandPalette.test.ts extracts it into Node: determinism, case
rules, word-start/consecutive bonuses and null-for-no-match are behaviour,
not structure.

**9.2 — the guided first run.** A coach card, deliberately NOT a modal: the
user drives the real UI while it narrates. Welcome (one-click "scan my home
folder" once /api/system answers; "pick my own" opens the folder browser —
the zero state hides the path box, and focusing a hidden input is a silent
no-op, found by driving) → the map → up to three quick wins, each a REAL
group from /api/cleanup/suggestions with size, description and why, never
an advisory group, staged only inside the user's click through the new
`cartAddMany` (one bulk door on the ONE cart, same pipeline as cartToggle,
run once) → the cart, staged and uncommitted. Non-answers never read as
"clean": a running scan is polled out, a broken catalog and transport
errors get a "couldn't check — <reason>" card. Skippable everywhere; skip
and finish both persist `tourDone` (only boolean true counts) so a
read-only portable session honestly forgets; Settings has the promised
"show it again", which now puts the map on screen first (QA). The Esc that
skips it is the LAST branch of the app-wide Escape chain — the first cut
was a separate listener and died on its own "press Esc to climb back out"
instruction (review round 1's sharpest frontend catch).

**9.3 — human-scale units.** The `humanScale` fact provider (built by a
worktree agent, test-first) averages a folder's OWN photos/videos/music —
ten of a kind minimum, never a constant — and the shared tooltip renders
"≈ 16 photos or ≈ 48 videos like the ones here · based on the 12 photos in
this folder, average 114.4 MB" on directories over ~1 GB. Nothing
comparable → nothing said. Deliberate deviation from the spec's "6 hours of
4K video": hours would need a bitrate constant, which the same sentence
forbids — recorded in the provider header. Settings toggle
(`humanScaleUnits`, default on) rides the cart-goal boot read. Walks are
capped per path (500k) AND per request (2M, review finding: 2,000 deep
dirs × per-path cap = a billion synchronous node visits) with the tail
skipped and counted, `capped: true` stated on truncated samples.

**9.4 — budget gauges.** `GET /api/scan/:id/budget-gauges` — a NEW endpoint
because /budgets is under byte-identity lock — pairs each in-scan budget
with a projection from src/services/budgetGauges.ts: `computeForecast`
reused VERBATIM with the budget's headroom standing in for free space, so
'insufficient'/'erratic'/'stable'/'shrinking' refuse with the disk-full
forecast's own sentences. One honesty policy, not two. The Dashboard rows
gain one line: the date when confident, the refusal in muted text when
not, "· from shallow history" (caveat on hover) when the series came from
ancestor snapshot trees. Already-over rows get no projection — the red
label is the fact. Series prefer the folder's own scan history outright;
gauge fetches carry a stale-response guard.

**9.5 — notes pinned to folders.** Verbatim text (XSS corpus round-trips
byte-exact; rendered via textContent/escapeHtml only), notes.json through
the storage layer so portable read-only sessions keep them in memory only.
The consequential half: a suppressing note (default, per-note toggleable)
excludes its subtree from Smart Suggestions, the agent summary, MCP
cleanup_suggestions and EVERY Autopilot match kind — in BOTH directions of
containment (review round 1: a suggested node_modules CONTAINING a noted
keep-me was deletable; now the claim is withheld and the walk descends
past it) — and Autopilot reports what it left alone, collapsed to one
entry per note root with a count. Suppression FAILS CLOSED: a corrupt
notes.json pauses automation with the reason instead of silently unpausing
everything (the agent-policy rule from storage.ts, applied). The
suggestions surface names what a pausing note hides instead of a silent
"nothing matches" (QA). Surfaces: right-click Add/Edit note, the `n` key,
a sticky-note glyph on tiles, a tooltip line with "suggestions paused
here". Both mutating routes sit in the pinned destructive list with their
rationale.

**9.6 — ask in plain words.** The ✨ button opens a popover: plain words →
the deterministic table (33 phrasings, from a worktree agent, mutation-
tested) → the translation in an EDITABLE field with understood/ignored
words listed → Run as its own act through the highlight box's own flow.
POST /api/nl-query translates and NOTHING else — no hits, ever — and
re-parses even its own output as a belt (durations clamp at a century of
days; `${1e21}` would otherwise emit exponent notation the grammar
rejects). The Ollama passthrough was built, hardened against a hostile
loopback squatter, and then REMOVED end-to-end at the owner's request; a
static test now asserts the query services contain zero network code —
"not present", which is stronger than "off by default".

### The fleet's score

Three build agents (worktrees; `cp -cR` the node_modules — the harness's
own worktree isolation cannot start at this workspace root, so create them
with `git worktree add` by hand), then two adversarial reviewers and one
app-driving QA agent on a green 1,6xx suite: **4 real backend defects**
(reverse containment; fail-open corrupt notes; the 1e21 invariant break;
unbounded Ollama body buffering) with mutation evidence that two
suppression wires had no test that could fail, **6 real frontend defects**
(the tour dying on its own Esc instruction; three paths reading a
non-answer as "clean"; the palette opening invisibly UNDER the Settings
scrim with keystrokes landing in it; the zero-state Scan action focusing a
hidden input; a stale plain-words popover surviving view switches; Esc
closing the palette without its focus-restore), and **5 QA finds** ("Scan
again: [object Object]" from reading r.path where the API serves rootPath;
the 12-row browse cap; a stale tooltip floating above the palette; the
tour restart narrating a map that wasn't on screen; note suppression
silent on the suggestions surface). Every fix landed behind a test that
failed first.

A FINAL four-auditor pass then signed the phase off: safety-locks CLEAN
(golden byte-identity intact, the budget-gauges diff purely additive, every
new route path-sanitized or path-free, zero new network code, fail-closed
notes proven end-to-end), clean-room CLEAN (pristine detached worktree at
HEAD: build, typecheck and 1,648/0 reproduced from scratch), and
spec-compliance + docs-truth reporting only precision items — a
mis-nested MCP test, the palette lacking §9.1's "deep settings" (both
fixed: eleven Settings sections and Clean Up are now palette rows, the
static zero-network test widened to sweep the whole query directory so
AGENTS.md's sentence is exactly as wide as its proof), and three doc
sentences tightened.

### Verified

```
npm run build            clean
npm run typecheck        clean
npm test                 1,648 tests · 1,646 pass · 0 fail · 2 skip   (was 1,538)
npm run bench:v4         6/7 measurable PASS + scan throughput: four session
                         runs 1391 / 1468 / 1548 / 1395 ms vs baseline 1497.9
                         — the single +3.3% row ran at load 4.6 and re-passed
                         at −6.8% under load 10.3; Phase 9 touches nothing in
                         the scan path. 3 rows are browser-measured by design;
                         no new rAF loops or per-node render work were added
                         (the note-glyph pass is O(drawn rects) with an early
                         continue), so Phase 6's measured numbers stand.
capabilities             12/16 available on this Mac (smartctl, ffmpeg-family,
                         snapshotRestore, backupMembership honestly absent)
app driven               every view mounted (zero new console errors; the 429
                         boot noise is the documented pre-existing item), plus
                         each 9.x feature end-to-end on the isolated dev
                         server: the full tour into a staged cart, notes with
                         suppression verified over live HTTP both ways, the
                         palette above open modals with one-Esc-one-layer,
                         plain words translate→edit→run and honest refusals,
                         budget meter + 'no projection yet' refusal,
                         human-scale line with exact arithmetic, dark/light,
                         500px narrow, sparse-file tooltips.
```

### What I could NOT verify on this machine, and why

- Windows and Linux behaviour of the new code — no such machines here. The
  new tests are platform-branched where case rules differ and avoid the
  documented Windows fixture-rewrite trap; CI's matrix is the proof, and
  the owner had not yet pushed when this entry was written.
- A REAL first launch (fresh machine, no dev-server data dir) — the
  isolated TREEMAP_DEV_DATA server approximates it and the tour fired
  correctly there; the Electron packaging path was not rebuilt this
  session.
- tests/autopilot.test.ts's "live run routes through the open-file guard"
  failed ONCE for a reviewer running three suites in parallel, passed
  isolated and in every quiet full run since — same family as the
  documented A1/B5 load flakes. The next failure there on a QUIET machine
  is real; treat it that way.

### Honest limitations now stated in the UI

- Human-scale equivalents: the basis sentence names the sample and average;
  truncated walks say "sampled"; no comparable files → no line at all.
- Budget projections: every refusal states the forecast's own reason;
  shallow-history series carry their caveat on hover.
- The tour: "couldn't check" card with the reason when suggestions cannot
  answer; "this folder looks clean" only on a real empty answer.
- Suggestions: "N folders are excluded by a note that pauses suggestions."
- Plain words: ignored words are listed; refusals name working phrasings.

### Known, deliberately left

- The media-note tooltip is unreachable by hover at scan root when a
  single-child chain elides the label strip (child rect == frame rect, and
  deepest-hit wins) — QA finding 7. The glyph still shows; the note is
  reachable via Sunburst, Grid, breadcrumbs and the context menu. Fixing it
  means changing v3 hit-test/elision geometry, out of Phase 9's blast
  radius.
- QA's unreproduced observation 9 (a boot-time stale highlight query + a
  possibly-stolen view during live-index rescan) — logged, not chased; a
  clean retry behaved. QA 10 (global-search jump copying the text into the
  view filter) is pre-existing A4 behaviour.
- reclaimInputs deliberately ignores notes (the score explains, never
  selects) — commented at the site; same for the custom Clean Up rules and
  browser/cloud lists (the user's own explicit filters).
- The palette does not trap Tab (no modal in the app does); Esc and
  aria-activedescendant are correct.

### Files changed

Backend: notes.ts + noteRoutes.ts (new), budgetGauges.ts (new),
facts/humanScaleProvider.ts (new), query/nlIntent.ts (new), cleanupRules /
autopilot / settings / settingsRoutes / metaRoutes / mcp/server /
scanRoutes / queryRoutes / openapi / models/types touched; nlOllama.ts
created then deleted. Frontend: one file, as ever. Tests: commandPalette,
firstRun, notes, nlQuery, budgetGauges, humanScale (new files) + surgical
updates to frontendContract, discoverability, mcp. Docs: README, AGENTS,
PLATFORM_NOTES, this file.

## v4 — Phase 8 complete: domain depth, adversarially reviewed (30 August 2026, night)

The ask was: run Phase 8 the same way as Phase 7 — parallel build agents,
inline frontend, drive everything, adversarial fleet before calling it done.
All three features shipped; the fleet then found and killed nine more real
defects a 1,532-test green suite had missed.

### What shipped

**8.1 — media libraries.** `src/services/mediaLibraryScanner.ts` mirrors the
games pattern: Photos (modern and legacy layouts), Final Cut, iMovie,
Lightroom (catalog + `.lrdata` siblings only — the photos live outside and
are never claimed), Capture One — split into originals / derivatives /
database from each app's documented bundle layout, sizes from the scanned
tree, zero disk reads. Only derivatives carry `removable`, each with a
regeneration-cost sentence; originals never do (asserted directly). A bundle
the walker could not read INTO (TCC without Full Disk Access — the default
consumer Mac) reports at its size, `recognised:false`, naming the cause —
the review's RD-1; it was invisible before. `guardMediaReport` probes every
component path in one `checkOpenHandles` batch; a held library names its
holder and offers nothing; a probe that cannot check says so (three states,
now also rendered). `GET /api/media` (route-tested), rulepack advisory
entries whose prose defers to the gated Media view (pinned by a test after
the review caught the two surfaces contradicting each other). The surface
lives in the Games tab, relabelled **Libraries**.

**8.2 — the duplicate compare viewer.** `GET /api/duplicates/detail`
(src/services/dupeViewer.ts): sizes/mtimes from the scan, dimensions + EXIF
capture date via sharp when present (a minimal, 200k-fuzz-clean TIFF/IFD
parser for DateTimeOriginal; every absence is null WITH a reason),
per-file dHash diff blocks against `diffReference` (bit order verified
against the hashing code), `recommendedKeep` with the rule stated — newest
unless a strictly >10% larger older file suggests the original. The viewer:
copies side by side with thumbnails (`/api/files/preview?thumb=1`), diff
blocks painted over near-duplicates, keyboard-first (←/→ groups, 1–9
keeper, Space stages the rest), the document listener named and taken back.
The fleet's RD1 mattered most: the EXIF date string crashed formatDate and
killed the viewer for every camera photo — fixed and re-driven.

**8.3 — the drive dock.** `GET /api/volumes` (external drives + free/total;
a stats-refused drive listed with nulls and a reason; Linux flattens the
udisks per-user directory; Windows states its discovery gap instead of
lying with an empty list). The dock sits under the Treemap and Disk City
canvases; the cart chip is the drag source (a lasso stages into the cart —
verified, so one gesture serves both). A drop, in contract-pinned order:
reset the shared confirm's panel, filter the cart to THIS scan's paths
(stale entries bricked the next drop — QA D1), re-verify the drive,
dryRun manifest, confirm, then the same runOffloadJob as every offload.
Proven on a real mounted APFS volume end to end (copy → byte-back verify →
trash → manifest on the drive), the detach-mid-drag abort, the
detach-after-manifest gap (fails safe server-side: DEST_NOT_A_FOLDER), and
the rollback promise now has its first end-to-end test — a forced verify
mismatch through the new `setOffloadVerifyForTests` seam cleans the
destination and leaves every original byte in place.

### The fleet's score

Two adversarial reviewers + one QA driver, on work with a fully green
suite: **9 real defects** (backend: the invisible unreadable library, the
rulepack/scanner contradiction, the Linux/Windows volumes dishonesty;
frontend: the EXIF crash, silent 4-of-N truncation, the stale open-handle
panel bleeding a "Delete anyway" button into the offload confirm, the
stale-failure dock race, stale cart entries bricking drops, foreign drags
triggering offload confirms) plus a dozen hardening items. Every fix
landed test-first; the QA driver also confirmed eleven attack paths hold.

### Verified

```
npm run build            clean
npm run typecheck        clean
npm test                 1,538 tests · 1,536 pass · 0 fail · 2 skip   (was 1,486)
app driven               all three surfaces + a real offload onto real mounted hardware
```

### What I could NOT verify on this machine, and why

- A genuinely held media library (Photos actually running against the
  fixture) — the guard's three states are unit-tested and the could-not-
  check state is rendered; a live hold needs a real Photos.app session.
- Real 300 GB libraries produced by the apps themselves — layouts follow
  each app's documentation and fixtures; CI's other platforms cover the
  path math.
- Windows drive discovery — deliberately absent and now SAYS so
  (`volumesUnavailableReason`); implementing it is future work.

### Known, deliberately left

- Cart chip count vs bytes can disagree while stale entries exist (QA D5) —
  pre-existing cart accounting, much rarer now that offloads clear their
  paths; fix belongs to a cart-focused pass.
- Backdrop-mousedown close leaks the viewer's keydown listener until the
  next keypress, where the self-heal removes it with no side effects
  (QA D9 verified benign); the generic modal closer doesn't know about
  per-modal teardown — an app-wide refactor if it ever matters.
- The dock's dragleave flickers between tile children; MEDIA_PART reuses
  the games palette classes; dock aria-labels sit on non-focusable tiles.

## v4 — Phase 7 complete, and the time dimension became one view (30 August 2026, later)

The ask was: pick up Phase 7 from the entry below and run it to done, with
agents, flawlessly — then (mid-phase, from the owner) merge Calendar,
Journal and Compare into one view. All of it shipped.

### What shipped

**7.1b — the transport.** Play/pause, ½×/1×/2×/4×, loop on the timebar. One
rAF loop advances a fractional position over segments (1 s per snapshot at
1×, dt clamped ≤100 ms); the rectangle renderer draws `lapseLerpNodes`
frames — matched rects travel linearly, arrivals bloom from their own
centre, departures shrink into theirs, gone at t=1. Sunburst and the solved
renderers step discretely at crossings through `lapseSeekTo` (slider +
label + setHistoryIndex — the slider's dispatch never writes the slider).
Sizes are NEVER interpolated: a matched rect morphs geometry but carries
the source snapshot's byte count, because labels and tooltips print that
field as fact. Stops at every door: scrub, Escape, renderer switch,
unmount; a renderer switch now re-dispatches your place in history instead
of silently snapping to Live.

**7.1c — history export.** GIF: sampled offscreen through the real
drawTreemap at 10 fps (≤480 px, capped ~150 frames, cap stated), encoded in
a Worker built from the four shipped GIF functions' own source
(Function.prototype.toString → Blob; gifLzwEncode wrapped in-worker for
per-frame progress). WebM: captureStream + MediaRecorder feature-detected,
one real playback run recorded via the lapse `onDone` hook; the toast says
"partial take" when the run was stopped early. Both live in the Export
menu, gated on two snapshots + rect map.

**7.2 — the calendar.** `GET /api/scan/:scanId/calendar`: per-LOCAL-day
bytes/counts from the tree's own mtimes (exact), `?channel=created` behind
the query engine's own STAT_CAP (shared constant, not a copy) with
`degraded[]` prose for capped/unreadable/unknown — and mtimes ≤ 0 skip into
a `modifiedUnknown` note, never a 1969 bucket. The heatmap view: weeks as
columns, years stacked, four opacity steps on a sqrt scale; day clicks and
drag-ranges become Phase 2 queries (`modified:2026-03-14`), which is why
`matchesDate`'s `=` now ends at the next LOCAL midnight — the old
value+24h window disagreed with the calendar twice a year at DST.

**7.3 — the journal.** `src/services/journal.ts` copies audit.ts's queue
whole, plus in-queue rotation (2000 → newest 1000 via tmp+rename; a failed
rotation unlinks its tmp file). Fed from the scheduler tick only —
deliberately NOT a watcher subscriber (would pin watch sessions open
forever; documented at both seams). Attribution never guesses: an app only
by containment, "you" only when a REMOVAL-action audit entry (files.trash,
cart.commit, offload.start, …) inside the window covers ≥ half the shrink —
approvals, policy saves and restores can no longer claim it — and otherwise
exactly "an unidentified process". A growth cancelling against a vanished
sibling reports the remainder coarsely at the parent rather than vanishing.
`GET /api/journal` reads newest-first; nothing writes it over HTTP.

**7.4 — the split-slider.** History pairs in Compare paint both snapshot
layouts into one canvas — newer in full, older clipped left of the divider
(unexpanded dirs paint; only expanded frames are skipped). The divider is a
native range (arrows/Home/End are the platform's), aria-valuetext narrates,
the pair is ordered by takenAt however it was picked, and the footer names
the stored trees the canvas actually shows.

**The History view (owner's mid-phase ask).** Calendar, Journal and Compare
are now ONE tab with an internal three-button segment. Panels kept their
ids, loaders and guards; the three registrations folded into one; sidebar
is fifteen tabs. README says seventeen views.

### The adversarial pass — run before calling any of this done

Two code reviewers and one app-driving QA agent, all instructed to refute.
They were right to exist: **3 real backend defects** (the "you" attribution
trusting non-removal audit actions; the vanishing residual; the DST
disagreement), **10 real frontend defects** (stale-tick races around the
crossing await, a backward blink at every crossing, the split view skipping
most of a real tree, interpolated sizes printed as fact, playback holding
the clock forever on a dead server, …) and **QA's D1** (discrete playback
never moved the slider — found only by driving) all survived a green
1,479-test suite. All fixed, each behind a test that failed first.

### Verified

```
npm run build            clean
npm run typecheck        clean
npm test                 1,486 tests · 1,484 pass · 0 fail · 2 skip   (was 1,432)
app driven               every 7.x surface + the merged History view, on the isolated dev server
```

### What I could NOT verify on this machine, and why

- A full-length WebM recording: the preview pane starves the page of
  animation frames, so only the interrupted-take path could run end-to-end
  (it delivered a real vp9 file). Needs one run in the real Electron window.
- Delivered frame rate (inherited pane limitation; per-slice work measured).
- The one-line scheduler → journal wiring under a genuinely due schedule
  (recordScanJournal itself is integration-tested against a real scan).

### Known, deliberately left

- audit.ts and journal.ts share the torn-tail flaw (a crash mid-append can
  cost the next line); fixing journal alone would fork the copied
  discipline — fix both together or not at all.
- The 429 console noise at boot (QA D8) predates Phase 7; the api wrapper
  retries and recovers.
- `views.svg` still draws the pre-merge tab strip (cosmetic; regenerate).
- The degraded "read for N files" prose counts failed stats in N —
  inherited verbatim from execute.ts; change both or neither.

## v4 — Phase 6 closed for real, Phase 7 opened (30 August 2026)

The ask was: confirm Phase 6 is complete, then run Phase 7 to done. Phase 6 is
now genuinely closed — the alternate-renderer budget failure recorded below is
fixed and re-measured — and Phase 7 shipped its first feature before the
session was consolidated. Everything not started is specified at the end of
this entry, precisely enough to pick up cold.

### What shipped

**6.13 — the coverage gate, and the clock at its real budget.** The trade the
previous entry left open ("pick a threshold, or say to leave it") is taken, at
0.9, plus one thing the prototype didn't have: an O(n) pre-filter above the
threshold. The estimate `r ≈ R·0.955·√(byte share)` can only over-state a
radius — a pack's hull is never denser than area-perfect — so a child
estimated under `ALT_MIN_LEAF_R` is provably undrawable and is dropped before
the pack instead of after it, bounding bead inflation at √(1/0.9) ≈ 5.4%.
That kills both measured pathologies AND the one the prototype missed: one
giant among 4,238 specks (coverage ~1.0, so no coverage threshold ever fires)
was 80 ms warm in Node to draw a single circle; the gate hands the pack
exactly one child. The R=63.8 / 0.842-coverage parent loses its 42 beads to a
hatched leaf — `tests/circlePack.test.ts` holds that trade by name.
`ALT_LAYOUT_BUDGET_MS` drops 150 → 45: the binding budget was §2.5's 50 ms
block rule, not the 250 ms first paint the 150 was set against.

**6.14 — the clock ends a slice, not the picture.** At 45 ms alone the
Voronoi map stopped at a handful of cells, permanently. Both solvers are now
resumable (peek-don't-shift, queue returned as `resume`), and `buildCells`
hands the queue back one animation frame later, repainting as the picture
fills in — every block under the clock, nothing lost, footnote saying "still
laying out — N shapes so far" until it settles to the layout's own last word.
Cancelled by the next `buildCells`, by `setTreemapView`, and by the view's
unmount; a mode check orphans a stale queue so a circles resume can never
feed the Voronoi solver.

Measured on `~/Library/Application Support/Claude` (the folder from the
28 Aug entry), via `window.TreeMap.state.treemap.altMs` in the browser pane:
circles **1.8–5.9 ms** first slice (was 986 ms cold / 145–165 warm), cell
count deterministic at 50 across three switches; Voronoi first slice
**45 ms by construction**, complete picture ~2 frames later, final footnote
carrying only the true omission counts. Screenshots of both renderers taken
and eyeballed; hatching, labels, nesting and both footnotes correct.

**7.1a — the GIF encoder.** Four pure functions in `public/index.html`
(`gifBuildPalette`, `gifIndexFrame`, `gifLzwEncode`, `encodeGif`):
GIF89a with hand-written variable-width LZW, exact global palette with
honest nearest-entry quantisation past 256 colours, NETSCAPE looping only
when asked. `tests/gifEncoder.test.ts` decodes the output with an
independent reader written against the spec — shared helpers: none — and
compares every pixel of every frame, including a 200×200 noise frame that
fills the dictionary and forces a mid-frame clear/reset. Deliberate
deviation from §7.1's suggested `src/utils/gifEncoder.ts`: the frontend has
no build step to import through, CI runs the suite without `dist/`, and
`liftFrontend.ts` documents why a second copy is a drift hazard. The worker
(7.1c, not started) is planned as `Function.prototype.toString` into a Blob,
so one implementation serves both threads.

Also landed mid-session from a parallel session: `f1d8e54` derives
`/api/capabilities`' advertised MCP tool list from `MCP_TOOL_NAMES` in
`src/mcp/server.ts` (it had drifted to nine tools, omitting
`missing_gigabytes`). If you add an MCP tool, update that constant or
`buildMcpServer` throws.

### Verified

```
npm run build            clean
npm run typecheck        clean
npm test                 1,432 tests · 1,430 pass · 0 fail · 2 skip   (was 1,411)
CI                       green 3/3 through 94ce36f (6.13); f05077c (6.14) + docs awaiting push
```

Real-app pass for the Phase 6 changes: scan of the pathological folder,
all four renderers driven, circle/Voronoi cold and warm timings above,
three-switch determinism check, refinement completion confirmed by watching
`state.treemap.altRaf` drain and the footnote settle.

**One Windows CI note (from the parallel session):** the run at 94ce36f went
red once because the `Get-CimInstance` subprocess in `tests/diskUsage.test.ts`
died on the runner; the re-run passed. That failure was external. If that
test fails on Windows CI again, treat it as real, not as a flake to re-run.

### What I could NOT verify on this machine

- Delivered frame rate (unchanged — the pane's rAF limitation from the
  28 Aug entry still applies; per-slice work is what was measured).
- The refinement loop under a genuinely slow machine: on this Mac the Voronoi
  queue drains in ~2 frames, so the "still laying out" footnote is visible
  only briefly. The cancellation paths are covered structurally by tests.

### Phase 7 — NOT started, specified for pickup

Read the four feature specs in `TREEMAP-V4-MASTER-PROMPT.md` §7 first. The
code-level seams below were mapped this session and are current at f05077c.

**7.1b transport + interpolation.** Pure fns `lapseLerpNodes(a, b, t)`
(match by path; matched lerp x/y/w/h/size; arrivals bloom from own centre —
same convention as `animateTreemapTo` ~6825; departures shrink into their
centre, gone at t=1; clamp t) and `lapseOrderedSnaps(snaps)` (filter
`hasTree`, sort by `takenAt` — a treeless snapshot is a gap, never a guess),
both lifted for `tests/timelapse.test.ts`. Controls go in `#tmTimebar`
(:2114): play/pause + speed 0.5/1/2/4 + loop pills, `aria-label`s, static
top-level bindings like the slider's (:6843). Extract the cache block of
`setHistoryIndex` (:6780-6786) into a shared `historyLayoutFor(snap)`.
Playback: rAF advancing pos over segments (~1 s per segment at 1×, dt
clamped ≤100 ms), rect mode draws `lapseLerpNodes` frames via
`state.treemap.nodes = …; drawTreemap()`, sun/cells step discretely at
crossings via the same dispatch `setHistoryIndex` uses; label/slider update
per crossed snapshot (interpolated byte totals would be invented numbers —
don't). Prefetch next 2 segments through the existing `h.cache`/`h.seq`.
REDUCED → discrete stepping, and the starter's name must join the REDUCED
list in `tests/frontendContract.test.ts` (~:307). Stop on scrub, Escape
(`exitHistoryState` :6723), renderer switch, and treemap unmount (~:3580 —
the same block that cancels altZoomRaf/altRefine).

**7.1c export.** Extend the existing `#tmExportBtn` menu (:10060), not a new
button: "GIF" + "WebM" entries gated on `h.snaps.length >= 2 && isRectMap()`.
GIF: sample playback offscreen (reuse the real `drawTreemap` into `tmBuffer`,
downscale to ≤480 px wide, cap frames ~150 at 10 fps, state the cap), encode
in a Worker built from the four gif functions' own source (toString → Blob),
frames transferred, per-frame progress; `downloadBlob` (:10112) delivers.
WebM: feature-detect `canvas.captureStream` + `MediaRecorder`, record the
visible canvas during one real playback run, say which format the user gets.

**7.2 calendar.** Requires a NEW endpoint — the client tree is pruned and
carries `modifiedAt` only, and the golden lock forbids adding per-node
fields. `GET /api/scan/:scanId/calendar`: bytes/count modified per local day
from `store.eachFile` + `store.modifiedAt` (free, exact); `created` as an
opt-in second channel via per-file `statSync().birthtimeMs` behind a
STAT_CAP with `degraded[]` prose exactly like `src/services/query/execute.ts`
:231-244 (birthtime 0 ⇒ unknown, never day zero; an unread day is never a
zero day). View id `calendar` (lowercase only — contract :82), tab button +
section + `registerView` + `TAB_VIEWS` (tab count assert :135). Click a day →
`switchView('treemap'); $('tmSearch').value = q; clearTimeout(tmQueryDeb);
tmApplyQuery('created:2026-03-14')` — the grammar already parses that and
`=` on a date means "that local day" (evaluate.ts :151-167). DST bucketing
tests with TZ pinned (`tests/calendarAggregate.test.ts`).

**7.3 journal.** `src/services/journal.ts` copying `audit.ts` whole
(serialised queue, memory ring under `isEphemeral()`, appendFile) PLUS
rotation, which audit lacks — cap by lines, rewrite tail via tmp+rename in
the same queue. Two meta-tests in `tests/portableMode.test.ts` (:136-170,
:245-267) will police it: appendFile + appDataDir ⇒ the literal string
`isEphemeral` must appear. Feed it from the scheduler tick (scheduler.ts
:130-154 already computes deltas and formats a sentence — §B1 says extend
the scheduler, never add a second timer); a live-watcher subscriber would
keep watch sessions alive forever (watcher.ts :349) — decide that
explicitly or don't subscribe. Attribution: `getAppAttribution` containment,
`openHandleGuard`-style sentences built in the service, literal
"an unidentified process" when unknown; TreeMap's own deletions can be
attributed to "you" via the audit log. Portable: add a `journal` entry to
`degradedCapabilities` (portableMode.ts :135; reason >40 chars, no
error/failed/broken/unsupported — test :185-214). Route file
`journalRoutes.ts` mounted in server.ts; `ENDPOINTS` + a schema + possibly a
new tag in openapi.ts (tags list :2566). Fleet: 'journal' is already in
`FORBIDDEN_SUBSTRINGS` (:66) and named in fleetSync tests (:309) — add the
`serialiseSummary(hostile)` style test for a smuggled `journalEntries`.
View id `journal`, no capabilityKey (gate by portable degraded note, not a
platform capability). MCP: if a journal read tool is added, update
`MCP_TOOL_NAMES` + the mcp.test.ts handshake list.

**7.4 split-slider Compare.** The compare view (:2313, registered in the
`VIEWS` literal :3666) renders text delta rows only — zero canvases. For
same-root snapshot pairs, render two percent-rect maps (layouts from
`/api/snapshots/tree?path=&at=` — same `TreemapNode` shape as
`/api/scan/:id/treemap`) into one canvas with a clip at the divider.
Keyboard: follow the reclaim-weight slider pattern (:18058 — native range +
live `aria-valuetext`); arrows move the handle, Home/End snap. The view has
no `unmount` today; it will need one for its listeners (named-listener rule,
contract :2355-2385).

**Cross-cutting for every 7.x:** README views list + AGENTS.md endpoints +
openapi in the same commit; PLATFORM_NOTES only if something goes per-OS;
golden endpoints untouched (the harness's fixed capture list makes new
endpoints safe); adversarial review before calling the phase done — the
28 Aug sessions found 4 and 7 real defects in "finished" work by driving
the app, and this session found the giant-among-specks case only by
benchmarking shapes the spec never named.

---

## v4 — CI green on all three OSes, and four Phase 6 defects (28 August 2026)

The ask was two things: CI reading green everywhere, and Phase 6 finished with
nothing left wrong in it. Both were still open, and for different reasons.

### The red CI check

One test, on Windows only, in every run since the `statfs` rewrite:
`a path that does not exist is refused, not answered with zero`. It was right
to fail. The two platforms answer a missing path differently and **both are
correct** — on Unix `statfs`/`df` need the path itself, so it is an error; on
Windows the question is about the VOLUME, and `D:\no\such\path` resolves to
`D:`, which exists. The test asserted the POSIX *mechanism* and so encoded
"reject" as the rule. The rule is narrower: never invent a number. It now
asserts the invariant — refuse, or answer about a real volume — and a
fabricated zero fails on every platform. A second test covers the case with no
honest answer anywhere: a path on a volume that is not there.

macOS and Linux were already green; the earlier failures on both are recorded
in the section below and were fixed before this session.

### Four Phase 6 defects, all found by driving the app rather than reading it

**1. Disk City leaked a listener on every visit.** `mount()` attached
`pointerleave` as an inline closure, which `removeEventListener` cannot take
back, so `unmount()` did not list it and the canvas — static markup that
outlives every mount — accumulated one more handler per visit. Measured going
1 → 4 across three visits. Now a named `cityOnPointerLeave`, removed with its
siblings. `tests/frontendContract.test.ts` gained the general rule rather than
a test for this one case: every listener a `mount()` adds must be a named
function and must be removed by the matching `unmount()`. It fails, naming the
event, when the closure is put back.

**2. The circle-pack layout had no clock, and the comment saying it did not
need one was wrong by 4x.** `buildCells` stated that "the Voronoi solver is the
only thing in this file that could plausibly spend" §2.5's 250 ms first-paint
budget. Measured on `~/Library/Application Support/Claude`:
`layoutCirclePack` spent **1,102 ms** in one synchronous block, against 55–198
ms for the capped solver on the same tree. Two nested packs were 1,089 ms of
it — one of them 740 ms packing 4,239 circles into an 18-pixel radius, where
13 came out large enough to draw. `ALT_CELL_BUDGET` could never catch it: it
bounds the shapes that come *out*, and the cost is spent before a cell exists.
§6.2 asks for a hard cap so "a pathological input cannot hang the frame", and a
cap only one of the two renderers honoured is not that. `ALT_VORONOI_BUDGET_MS`
is now `ALT_LAYOUT_BUDGET_MS` and both solvers check it, with the same footnote
under the map. **The budget is still not met — see "What is still wrong" below.**

**3. A stored channel mode this build does not have rendered as
`Height = undefined`.** Disk City persists both switchable channels by name and
`localStorage` outlives the build that wrote it. The only guard was
`|| 'staleness'`, which catches an *absent* value and not a *meaningless* one —
the same distinction `meansAbsent` and `meansGone` exist for elsewhere in this
repo. Seen on screen, and it survived every reload. The legend's wording maps
are now the list of modes that exist, `cityMode()` sanitises against them, and
both setters sanitise **before** they persist, so a poisoned value is repaired
rather than rewritten.

**4. A test claimed another test's temp directory as its own leak.**
`gduScan removes its temp files even when a shard fails` globbed
`treemap-gdu-*` over the shared `os.tmpdir()`, which also matches
`treemap-gdu-precision-XXXXXX` — created by `incrementalRescan.test.ts`, which
runs concurrently. It failed exactly that way once in this session. The filter
is now `/^treemap-gdu-[A-Za-z0-9]{6}$/`, which is precisely what `mkdtemp`
produces for this prefix. Proven by reproducing the race directly: the old
predicate goes 6 → 7 and fails, the new one stays 5 → 5. This never turned CI
red, but it could have, on any OS.

### The three canvas budgets, measured in a browser for the first time

`npm run bench:v4` has always printed these three as NOT MEASURED HERE, because
the harness runs in Node. They are now measured, on a real scan of `/Users/prithvivinay`
— 1,000,301 items scanned, pruned to **250,296 nodes**, which is the 250k the
budget is written against.

| Budget | Limit | Measured | Verdict |
| --- | --- | --- | --- |
| Disk City, first paint | ≤ 250 ms | **3.2 ms** | PASS |
| Disk City, interaction frame | ≤ 16 ms median, ≤ 33 ms p95 | **3.1 ms median, 17.1 ms p95**, max 21.7 ms, over 300 frames of a pan/zoom | PASS |
| Main-thread block, single UI action | ≤ 50 ms | Disk City colour 7.8–10.9 ms · height 3.7–16.3 ms · zoom 13.2 ms · treemap colour 20.9–23.7 ms · renderer switch 0.3–1.5 ms | PASS |
| Alternate-renderer layout (same 50 ms rule) | ≤ 50 ms | **145–986 ms** | **FAIL — see below** |

**How the frame figures were taken, and what they are not.** The browser pane in
this session is never visible, so `requestAnimationFrame` does not fire and true
rAF timings are not obtainable here — a 30-frame probe returned zero frames.
What is reported instead is the app's own per-frame WORK: the real pointer and
wheel handlers driven at 60 Hz-equivalent for a 5-second gesture, with the rAF
scheduler flushed synchronously and each `drawCity` timed. That is the dominant
term in a frame and the part this code controls; it is **not** a measurement of
delivered frame rate, and nobody has measured delivered frame rate on this
machine. §6.2's acceptance line — "Disk City renders a real home folder at
≥ 30 fps while panning" — therefore remains unverified by measurement, though
the per-frame work is 5x under the budget that would produce it.

### What is still wrong, and the trade I did not make on my own

**The alternate-renderer layout still breaks §2.5's budgets on a pathological
folder.** After the clock: 145 ms warm, **986 ms cold** on
`~/Library/Application Support/Claude`, against 250 ms for a first paint and
50 ms for a main-thread block. The clock cannot close it, and this is
structural rather than a tuning problem: it bounds when the *next* pack may
start, never how long one takes, so the worst case is the budget plus one pack —
and one pack here is 740 ms.

The cause is specific and measured. `layoutCirclePack` subdivides any parent
above `ALT_PARENT_MIN_R` (13 px). At R=18.8 with 4,239 children, only 23% of
that parent's bytes are in children big enough to draw; the other 77% is packed
at full cost and then discarded by the `r < ALT_MIN_LEAF_R` test.

The fix that works is a coverage guard: estimate each child's drawn radius from
its share of the parent (O(n), no packing), and if the children that could be
drawn do not account for enough of the parent's bytes, do not subdivide it at
all — draw it as a hatched leaf, which is already this app's language for
"there is more in here", and count the children in the note as it already does.
Measured on that folder: it removes 155.7 ms of 165.9 ms warm and both cold
pathologies.

**I did not ship it, because the threshold is a judgement about the picture and
not about correctness, and §2.5 says to propose the trade rather than ship past
it.** At a 0.9 threshold two parents stop subdividing: the R=18.8 one at 0.23
coverage, which is plainly right, and an R=63.8 one at 0.842, which currently
draws 42 legible beads and would lose them. Capping the pack instead of skipping
it is the other option and it is worse: it shrinks the hull, so the surviving
beads inflate to fill the parent — 21.7% in radius on that folder — and the
map would claim those few files are the whole folder. **The empty space in a
sparse bead is the honest part of that picture.** Pick a threshold, or say to
leave it, and it is a ten-line change either way.

### Verified

```
npm run build            clean
npm run typecheck        clean
npm test                 1,411 tests · 1,409 pass · 0 fail · 2 skip   (was 1,404)
npm run bench:v4         7 pass · 3 not measurable in Node (measured in the browser, above)
npm run capabilities:report   12/16 available on this Mac
```

Driven in the browser on a 250,296-node scan: all four renderers; Disk City
with drill-in, Escape from the document (not the canvas), the height and colour
segments, the LOD line and the text equivalent (89 rows); the lasso in all four
of its senses — plain and shift add, ⌘ and Ctrl remove, ⌥ freehand at 37 points
— staging and unstaging through the real cart; the magnifier by held Z and by
its pinned toggle; light and dark; a 760 px window with no horizontal overflow.
Zero console errors throughout. Every focusable control in the Disk City and
Treemap views carries a label, and the canvas carries its own description.

### What I could NOT verify on this machine

- **Windows and Linux.** The `diskUsage` fix is the honest-invariant form and
  passes on macOS; the Windows branch it was written for runs only on CI. The
  new assertion is satisfied by either outcome, so it cannot fail for a
  platform reason again — but that it *passes* on Windows is something only the
  runner can say.
- **Delivered frame rate.** See above: per-frame work, not fps.
- **The cold-path circle-pack figure on any machine but this one.** 986 ms is
  one Mac under a load average around 4, and the cold/warm gap is 6x.


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

### Two things the tests do to the REAL machine

**1. A test emptied the maintainer's Trash, about eighteen times.**
`tests/trashInfo.test.ts` called the real `emptyTrash()`, which on macOS runs
`osascript … empty trash`. Two commits opened it and neither was enough alone:
one stopped `emptyTrash` short-circuiting on an unreadable Trash (right — "I
cannot see it" is not "it is empty", and on this Mac it genuinely cannot see
it), which removed the early return that had been keeping the emptier from
running; the next added a test that calls it.

`TREEMAP_TRASH_DIR` now redirects `trashDirs()`, and under it `emptyTrash`
clears that directory directly rather than invoking a platform emptier — those
take no path argument, so running one empties the real Trash whatever
`trashDirs` was pointed at. **The boundary is in the source, deliberately, not
in the test's good intentions.** Verified by canary: an item placed in the real
Trash survives a full `npm test`.

**2. The suite still leaves about nine fixtures in the real Trash per run.**
Pre-existing, and correct in spirit — `moveToTrash` is trash-only by design and
the tests exercise it for real. But it accumulates, and it cannot clean up
after itself on a Mac where `~/.Trash` is unreadable. Forty runs in one session
put a hundred items there. Worth giving the same treatment as
`TREEMAP_TRASH_DIR` if anyone touches those tests.

### The bug class this session was really about

One shape, found thirteen times: **a failure read as a fact.** A `catch` that
turns "I could not find out" into "there is nothing there", and a caller that
then acts on it. Where the caller deletes or overwrites, the cost is the
user's data.

The place it hides is a SHARED helper. Every round of review found at least one
defect introduced while fixing the previous round's, and each was the same
mistake: reason correctly about one call site, then put the reasoning somewhere
several call sites share.

- `meansGone` was widened with `ELOOP`/`ENAMETOOLONG`/`EINVAL` for the
  watcher's `lstat`, where a path the kernel will never resolve may as well be
  gone. The same helper is used by `readJsonFile`, so an unresolvable
  `timecapsule.json` became "first run", an empty index, and every recovery
  payload deleted in one pass. Now two predicates: **`meansAbsent`** wherever
  the answer decides whether stored state may be discarded, **`meansGone`**
  for `stat`.
- `reconcileCapsule` was guarded against a corrupt index — and three other
  paths reached the same ending through `loadStore`'s fallback. The refusal
  now lives in `loadStore`.
- The first capsule guard *saved* the empty fallback, so the next launch
  deleted everything; renaming the index aside was measured to do the same,
  because an absent index is a decided "first run".

**If you change one of these predicates, walk every call site and ask what a
wrong answer costs THERE.** That question is the whole lesson.

### Verified

```
npm run build      clean
npm run typecheck  clean
npm test           1,403 tests · 1,401 pass · 0 fail · 2 skip
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
