# Prompt for the next session

Copy everything below the line into a fresh session started in
`/Users/prithvivinay/Desktop/Claude Code/Treemap`.

---

Work on TreeMap at `/Users/prithvivinay/Desktop/Claude Code/Treemap`
(GitHub: `Prithvi-Web/TreeMap-Disk-Visualizer`). It is an Electron + Express +
vanilla-JS disk-space visualizer with an Apple-dark Liquid Glass design
language.

**Read `HANDOFF.md` first — the top section ("Session 8") is the current
state.** Then read `src/ui/README.md` if you will touch anything under
`src/ui/`. Do not skip these; they contain the traps that cost previous
sessions the most time.

## Your job, in one sentence

Fix seven defects that all state a wrong number or leave a hole, write a
CHANGELOG, and ship the result as **v5.0.0** — the first public release since
v3.2.1.

## Where things stand

- Working tree is clean, everything is pushed, and **CI run 33680373290 is
  green on macOS, Windows and Linux** at `0e6d0bb`.
- Gate: **2,373 tests · 0 fail · 3–4 skipped**; `npm run typecheck` clean;
  `node scripts/build-ui.js --check` matches (112 parts).
- `package.json` says **4.2.0**, and that build is installed at
  `/Applications/TreeMap.app`. The previous build is parked at
  `release/TreeMap-4.1.3-previous.app`.
- **The last PUBLISHED GitHub release is v3.2.1 (26 August).** Every v4.x
  release exists only in the repo — the public has never seen v4 at all. The
  owner dislikes the number 4, so the next release is **v5.0.0**, straight
  from v3.2.1. Nobody will see a gap.

## The owner

A non-coder. Explain in plain English, give copy-pasteable commands, and
never assume git or npm knowledge. **They push; you commit.** After they say
"pushed it", check CI per OS with the unauthenticated jobs endpoint (`gh` is
not installed and the logs endpoint 403s without admin rights):

```
curl -s "https://api.github.com/repos/Prithvi-Web/TreeMap-Disk-Visualizer/actions/runs?per_page=3"
curl -s "https://api.github.com/repos/Prithvi-Web/TreeMap-Disk-Visualizer/actions/runs/<id>/jobs"
```

A run's top-level conclusion hides which OS did what, so always list the jobs.
When a job fails, its per-test annotations are readable without admin rights:
`/check-runs/<job_id>/annotations`.

## Decided, do not reopen

- **No Apple Developer program.** The owner has now declined the $99/year
  twice (26 August and today). The macOS build stays un-notarized and the
  Windows build stays unsigned. Do not add notarization, do not add signing
  config, do not price it again, and do not treat Gatekeeper as a bug to fix.
- **Never document right-click → Open.** Apple removed that bypass in
  Sequoia. The only correct macOS instruction is: open it once, then
  **System Settings › Privacy & Security › Open Anyway**, and that button
  expires after about an hour. The README and INSTALL-NOTE already say this
  correctly — keep them that way.
- **Decimal vs binary bytes is NOT in scope.** The app is internally
  consistent and disagrees with Finder by ~7%. That is the owner's product
  decision, not a defect. Leave `formatBytes`'s base alone.
- **Empty Folders listing `~/.Trash` and `.git/objects/info` is NOT in
  scope.** Those folders really are empty; it is a documented product
  decision with a footgun the owner has been told about. Do not change the
  scanner unasked.

## The seven fixes

Every one of these is the app stating something untrue, which is the opposite
of what this app promises. All seven were found by an adversarial audit,
verified against the code, and re-confirmed as still present. File and line
references are from the audit — **grep for the quoted code rather than
trusting the line number**, the files have moved since.

### 1. Fleet pairing can be brute-forced (the only security one)

`src/services/fleet/fleetSync.ts` — `beginPairing` issues a 6-digit code
valid for `PAIRING_WINDOW_MS = 180 s`, and the doc comment claims "a million
possibilities against a three-minute window and a rate limiter". There is no
rate limiter: `startPeerServer` is a bare `http.createServer` going straight
to `handlePeerRequest`, and the express `rateLimiter` is mounted on the main
app only. The audit measured **33,966 attempts in 3 seconds** on loopback.

Fleet is opt-in and LAN-only, which caps the blast radius, but while the Pair
sheet is showing a code any device on the same Wi-Fi can pair itself unnoticed.

Fix: in the `/fleet/pair` branch of `handlePeerRequest`, keep a module-level
`pairFailures` map keyed by `req.socket.remoteAddress` plus a `totalFailures`
counter reset in `beginPairing()`. Refuse with 429 after 5 wrong guesses from
one address; after 50 total, `cancelPairing()` and fire a new optional
`hooks.onPairingAbuse?.(ip)` that the runtime turns into a notification.
Clear both in `beginPairing()` and `cancelPairing()`. Five per address and 50
total leave a human typing a code completely unaffected.

Tests in `tests/fleetSync.test.ts`: six wrong codes from one address — the
sixth is 429 **even when it is the right code**; 50 wrong across addresses
cancels the offer.

### 2. Offload says "need 0.0 GB"

`src/services/offload.ts` — the destination-full error hand-rolls
`(bytes / 1073741824).toFixed(1) + ' GB'`, so a 30 MB offload to a drive with
20 MB free reads `need 0.0 GB, only 0.0 GB free`. `offload.ts` does not import
`formatBytes`.

Fix: import `formatBytes` and use it for both numbers. Add a test that a
`dryRun` prepare against a stubbed usage of `{ total: 1e9, free: 20e6 }` with
a 30 MB payload produces a message naming both real sizes. No test currently
asserts this string at all.

### 3. Trends' forecast line disagrees with its own date

`src/ui/app/210-trends-view.js` — `trendProjection` slopes the dashed tail
with `FxCharts.math.linreg`, a plain least-squares over all points, while the
"disk full ~date" beside it and the dashboard's "+X/day" come from
`forecast.ts`'s **recency-weighted** fit (7-day half-life). Only the gate is
shared, not the rate. `/api/forecast` already returns `bytesPerDay` and the
chart ignores it.

Fix: store the server's rate (`state.trends.forecastRate`, initialised null
beside `forecastOk`), change `trendProjection(pts, rate)` to project
`last.v + rate * (horizon - last.t) / 864e5`, and have `drawTrendChart` pass
it. Update `tests/fxViewWiring.test.ts`: drop the linreg stub, assert
`trendProjection(pts, null)` is null, and assert the tail's end value equals
`last.v + rate × horizon-days` for a known rate.

### 4. Sparse files are counted at claimed size, and the gap is blamed on clones

`src/services/diskScanner.ts` — the walker has `stat.blocks` in hand but uses
it only to detect cloud placeholders. Docker Desktop's `Docker.raw` (64 GB
logical, perhaps 12 GB occupied) draws as a 64 GB tile, adds 64 GB to the
scanned total, and the Missing GB receipt reports "Unaccounted −52 GB" whose
explanation names copy-on-write clones — the wrong explanation for the single
most common macOS case of the numbers not adding up.

Fix: where blocks are meaningful (`blocksAreMeaningful` in
`src/platform/base.ts`) and `stat.blocks * 512 < stat.size` and the entry is
not a cloud placeholder, tally `sparseFiles` and `sparseBytes` exactly the way
hard links are tallied. Add both to `src/models/types.ts` beside
`hardlinkedFiles`/`hardlinkedBytes`, carry them onto the stats frame, add a
dashboard row beside `hardlinkRow`, and add a **correction line** to the
receipt (`missingGigabytes.ts`; `StatementLine` already documents negative
bytes as a correction) labelled for space claimed but not occupied, naming VM
disks and `Docker.raw`. Report `available: false` with a reason on engines
that cannot tally it (gdu, index) and on Windows.

This is the largest of the seven. If it grows beyond a clean change, do the
tally plus the receipt line and say what you left.

### 5. Duplicates promises bytes that trashing will not free

`src/services/duplicateFinder.ts` computes `reclaimable = size × (count − 1)`
and the view prints it as "up to X reclaimable". On APFS a Finder ⌘D
duplicate is a copy-on-write clone: same hash, same size, own inode, shared
blocks. Trash the copies and the Free tile does not move, and nothing explains
why the app's own number did not come true.

Fix: on darwin add one muted line under `#dupSummary` saying that files
duplicated in the Finder share their storage until one is edited, so trashing
such a copy frees nothing. After a duplicates trash completes, re-read
`/api/system` and report the **measured** delta rather than the promise —
"Freed X" when the change is ≥ 1 MB, otherwise a line saying the copies shared
storage so nothing was freed yet.

### 6. "Used" means two different things on Linux

Dashboard: `used = totalDisk - freeDisk`, where `freeDisk` is statfs
`bavail`, which deliberately excludes root-reserved blocks. Receipt:
`usedBytes = (blocks - bfree) * blockSize`, true used. On APFS `bfree ==
bavail` so the Mac agrees with itself; ext4's default 5% reserve does not, so
on a 1 TB volume the dashboard reads ~50 GB more used than the receipt — in
the one view that exists to settle "the numbers do not add up".

Fix: have `diskUsage()` return `{ total, free, used }` (statfs
`(blocks − bfree) × bsize`; the `df` Used column × 1024 on the unix fallback;
`Size − FreeSpace` on Windows), expose `usedDisk` on `/api/system`, and use it
for the dashboard tile. In the receipt, label the free legend as free **to
you** and add a reserved line so the lines plus free reach the capacity bar.
Assert `used + free <= total` always, and `used === total − free` on darwin.

### 7. Two hard-link counts under near-identical labels

The dashboard prints `N hard-linked files` counting **names after the first**
(an inode with three names counts 2). The Settings allocation diagnostic
prints "Files with more than one name" counting **inodes** (the same case
counts 1). Both are truthful; neither label says which it is, so on a pnpm
store or Time Machine-style tree the two screens disagree and a user concludes
one is broken.

Fix: relabel rather than recount. The dashboard row says how many **extra
names** there are and that the bytes are already counted once; the diagnostic
says hard-linked files, each counted once. Assert the new wording in the
existing dashboard wiring test.

## Then: the CHANGELOG

Create `CHANGELOG.md` (Keep a Changelog format, newest first). The repo has
never had one.

The **5.0.0** entry is not just this session's work: the public's last release
is v3.2.1, so it must cover everything since — all of v4.0 → v4.2.0 plus these
seven fixes. Read `HANDOFF.md`'s session sections and `git log v3.2.1..HEAD`
for the material. Write it for a user, not a committer: what changed for them,
grouped (Added / Changed / Fixed / Security), with the honest limitations
named (un-notarized macOS build, no Linux desktop download, decimal-vs-binary).
Do not invent entries; every line must trace to a real commit.

Add a test pinning what matters: the top entry's version equals
`package.json`'s version, and the file lists a `## [5.0.0]` section.

## Then: ship it

1. Bump `package.json` and `package-lock.json` to **5.0.0**.
2. Full gate: `npm test`, `npm run typecheck`, `node scripts/build-ui.js --check`.
   All three green, or you are not done.
3. `npm run dist:mac`, then **`npm rebuild better-sqlite3`** — electron-builder
   recompiles it for Electron's ABI and leaves `npm test` broken until you do.
4. Verify the shipped `app.asar` actually contains the changes before you
   believe the build (read `public/index.html` and the relevant `dist/*.js` out
   of it; there is a worked example in the session-8 history).
5. Install to `/Applications`, parking the current build as
   `release/TreeMap-4.2.0-previous.app`. Only when no TreeMap is running —
   `app.requestSingleInstanceLock()` means a second launch quits and hands its
   argv to the running instance.
6. Tell the owner to push, then check CI per OS.
7. **Publishing the GitHub release is the owner's step.** It needs a pushed
   `v5.0.0` tag before the in-app updater can see it. Prepare the release
   notes from the CHANGELOG and hand them over — never publish a release
   yourself.

## How to work — non-negotiable

- **`public/index.html` is GENERATED.** ~30,000 lines, built by concatenating
  112 files under `src/ui/` in `src/ui/manifest.json` order. Never edit it.
  Edit the sources and run `node scripts/build-ui.js`. A new source file must
  be added to the manifest or the build refuses.
- **Never run a destructive operation.** Deletes, offloads and Autopilot runs
  are dry-run only. Treat the owner's real files as untouchable. Never scan or
  touch their real folders in a test — build a synthetic tree in the
  scratchpad.
- **Test-first, and prove each test bites.** Write the test, watch it fail,
  implement, watch it pass, then mutate the implementation, watch the test
  fail, restore by inverse edit, and confirm the file is byte-identical
  (hash it). Report the mutants. A test that never went red is not evidence.
  Session 8 ran 18 mutants for 18 behaviours; hold that bar.
- **Never anchor a test to a comment or an exact line.** Assert the invariant.
  Region slicing between anchors is the house style, but the anchor must be a
  **single-line** comment (`/* ── X ── */`) — `slice()` will not match
  `/* ── X ──\n prose */`.
- **Verify with real input, not synthetic `.click()`** — many handlers ignore
  synthetic events, and you will report broken features as working.
- Both themes and every window width from 640px up must stay correct. Prefer
  container queries over viewport media queries.
- Design invariants: every Liquid Glass target stays `plain: 1` (no
  displacement lens); never attach a border beam to a glass host (use a
  `.fx-beam-strip` child); no backdrop-filter on a full-screen scrim; no
  `will-change` at rest; no external scripts, styles or fonts; no new npm
  dependencies.
- The app's voice: calm, plain English, sentence case, "folder" not
  "directory", "Trash" for the OS trash, and never jargon a user did not ask
  for — no errno, no status codes, no hashes, no pids.

## Traps that will cost you hours

1. **`braced()` closes on a brace in the SIGNATURE.** `async function api(url,
   options, opts = {})` and `function cartDockToggle(open, { focus = false } =
   {})` both "closed" on their own parameter list, so three test files spent a
   session asserting against the two characters `{}` — silently passing. Fixed
   copies walk the parameter list first; if you write a new helper, do the same.
2. **A new function name can collide with a slice anchor.** A helper named
   `baseNameOf` matched the anchor `function baseName`, and being earlier in
   the page collapsed three `frontendContract` regions to the empty string.
   Grep the anchors before you name anything.
3. **`open -a` DOES pass an env var through.** An idle-CPU measurement taken
   against `TREEMAP_DATA_DIR=… open -a TreeMap` was reading an empty index
   with no watcher and would have "proved" a fix while proving nothing. Before
   believing an idle number, confirm the watcher is `live`.
4. **Linux has no recursive `fs.watch`.** The provider walks the tree and adds
   an inotify watch per directory, attaching one to a NEW directory only after
   an lstat resolves — a file written into a just-created folder beats it.
   Never write a test that depends on watching a directory it just made;
   create the skeleton before the index is built.
5. **Never edit sources while `npm test` is running.** A background gate sat
   at 0% CPU for ten minutes on a test whose sources were rewritten under it.
6. **macOS has no `timeout`**, and zsh does not word-split an unquoted `$VAR`
   (`T="npx tsx --test"; $T f` runs nothing and an empty grep looks like a
   clean run). Enforce wall clocks from Python `subprocess.run(..., timeout=)`.
7. **A golden fixture holding a wall clock can never match.** If you add a
   field to a response covered by `tests/goldenResponses.test.ts`, normalise
   any volatile value in the harness and re-record only after proving by
   structural diff that nothing else drifted.
8. **electron-builder breaks `npm test`** until `npm rebuild better-sqlite3`.
9. **`req.query` is a getter in Express 5** — assigning to it is discarded.
   `req.body` is assignable.
10. Windows CI is the only place two bug classes surface: a POSIX path literal
    sent to a guarded route, and a test racing a fire-and-forget write.

## Definition of done

- Seven fixes in, each red-first and mutation-proven, each with the number it
  corrects stated in the commit message.
- `CHANGELOG.md` exists, covers v3.2.1 → 5.0.0 honestly, and is pinned by a test.
- `npm test`, `npm run typecheck` and `build-ui --check` all green.
- v5.0.0 built, verified inside the asar, and installed.
- CI green on macOS, Windows and Linux after the owner pushes.
- `HANDOFF.md` updated with a session-9 section, and this file rewritten for
  whoever comes next.
