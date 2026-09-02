# Prompt for the next session

Copy everything below the line into a fresh session started in
`/Users/prithvivinay/Desktop/Claude Code/Treemap`.

---

Work on TreeMap at `/Users/prithvivinay/Desktop/Claude Code/Treemap`
(GitHub: `Prithvi-Web/TreeMap-Disk-Visualizer`). It is an Electron + Express +
vanilla-JS disk-space visualizer with an Apple-dark Liquid Glass design
language.

**Read `HANDOFF.md` first — the top section ("Session 9") is the current
state.** Then read `src/ui/README.md` if you will touch anything under
`src/ui/`. Do not skip these; they contain the traps that cost previous
sessions the most time.

## Where things stand

- **v5.0.0 is built, verified inside the asar, and installed** at
  `/Applications/TreeMap.app`. The previous build is parked at
  `release/TreeMap-4.2.0-previous.app`.
- Gate: **2,412 tests · 0 fail · 3 skipped**; `npm run typecheck` clean;
  `node scripts/build-ui.js --check` matches (112 parts).
- `package.json` and `package-lock.json` both say **5.0.0**.
- `CHANGELOG.md` exists for the first time and covers v3.2.1 → 5.0.0.
- The working tree is clean and **everything is committed**.

## The two things that are actually outstanding

**1. v5.0.0 is unpushed.** The owner pushes. After they say "pushed it",
check CI per OS with the unauthenticated jobs endpoint (`gh` is not installed
and the logs endpoint 403s without admin rights):

```
curl -s "https://api.github.com/repos/Prithvi-Web/TreeMap-Disk-Visualizer/actions/runs?per_page=3"
curl -s "https://api.github.com/repos/Prithvi-Web/TreeMap-Disk-Visualizer/actions/runs/<id>/jobs"
```

A run's top-level conclusion hides which OS did what, so always list the jobs.
When a job fails, its per-test annotations are readable without admin rights:
`/check-runs/<job_id>/annotations`.

**Windows CI is the one to watch this time.** Session 9 added a platform gate
(`blocksAreMeaningful`) that is false only on Windows, and two new scan
counters that are always 0 there. The golden fixture test skips on Windows, so
it will not catch a mistake in that gate — the live round-trips will.

**2. The GitHub release is the owner's step.** It needs a pushed `v5.0.0` tag
before the in-app updater can see it. Release notes are ready in
`CHANGELOG.md` under `## [5.0.0]` — hand them over; never publish a release
yourself, and never run electron-builder without `--publish never`
(`build.publish` points at this repo and it will push one on its own if a
token is in the environment).

## The owner

A non-coder. Explain in plain English, give copy-pasteable commands, and
never assume git or npm knowledge. **They push; you commit.**

## Decided, do not reopen

- **No Apple Developer program.** Declined three times now (26 August,
  2 September, and again this session by standing decision). The macOS build
  stays un-notarized and the Windows build unsigned. Do not add notarization,
  do not add signing config, do not price it again, and do not treat
  Gatekeeper as a bug.
- **Never document right-click → Open.** Apple removed that bypass in
  Sequoia. The only correct macOS instruction is: open it once, then
  **System Settings › Privacy & Security › Open Anyway**, and that button
  expires after about an hour. README, INSTALL-NOTE and now CHANGELOG.md all
  say this correctly, and `tests/polishDocs.test.ts` holds them to it.
- **Decimal vs binary bytes is NOT in scope.** Internally consistent,
  disagrees with Finder by ~7%. Owner's product decision. Leave
  `formatBytes`'s base alone.
- **Empty Folders listing `~/.Trash` and `.git/objects/info` is NOT in
  scope.** Those folders really are empty.

## Known gaps, if you are looking for work

These are written up honestly rather than hidden, and none is urgent.

1. **A fast rescan under-counts the claimed-versus-held line.** Unchanged
   folders are read from the previous scan and not re-measured, and no
   per-node allocation is persisted, so the figure is a floor. The line says
   so. The real fix is persisting allocation per node in the index — that is
   a proper piece of work, not a patch.
2. **`reclaimableCaveat` and `reclaimableIsUpperBound` are dead fields.** The
   duplicate finder computes them; `/api/duplicates` (`src/api/insightRoutes.ts`)
   and the MCP `find_duplicates` tool both drop them on the floor. The clone
   caveat the user sees is the client's own darwin check. Either surface the
   server's fields and delete the client check, or delete the server fields —
   but not both mechanisms.
3. **`f.basis` is read by the UI and sent by nothing.**
   `src/ui/app/210-trends-view.js` and `045-persistent-live-index.js` both
   branch on it; grep finds it in no `.ts` file at all. The folder branch is
   the only one that runs in production, and the 'volume' branch is pinned by
   a test with a stub that supplies a field the server never sends.
4. **The openapi `/api/missing-gigabytes` volume schema** was behind the
   server until this session and is only spot-checked —
   `assertMatchesSpec` runs on `/api/system` and `/api/scan` only, and walks
   top-level keys. Other nested response schemas may have drifted the same way.

## How to work — non-negotiable

- **`public/index.html` is GENERATED.** ~35,000 lines, built by concatenating
  112 files under `src/ui/` in `src/ui/manifest.json` order. Never edit it.
  Edit the sources and run `node scripts/build-ui.js`. A new source file must
  be added to the manifest or the build refuses.
- **Never run a destructive operation.** Deletes, offloads and Autopilot runs
  are dry-run only. Treat the owner's real files as untouchable. Never scan or
  touch their real folders in a test — build a synthetic tree in the
  scratchpad. (Session 9 verified the whole sparse-file feature against a
  512 MB synthetic tree and a 20 MB disk image, both cleaned up afterwards.)
- **Test-first, and prove each test bites.** Write the test, watch it fail,
  implement, watch it pass, then mutate the implementation, watch the test
  fail, restore by inverse edit, and confirm the file is byte-identical.
  Report the mutants. A test that never went red is not evidence — and
  neither is a mutant whose anchor did not match, so assert the anchor count
  inside the mutation script. Session 9 ran 47 mutants for 47 behaviours and
  had to rewrite 7 tests that did not bite.
- **Never anchor a test to a comment or an exact line.** Assert the invariant.
  Region slicing between anchors is the house style, but the anchor must be a
  **single-line** comment, and it must be UNIQUE in the built page — `:root {`
  is not, because the tokens sheet defines it first.
- **Verify with real input, not synthetic `.click()`.**
- Both themes and every window width from 640px up must stay correct. Prefer
  container queries over viewport media queries.
- Design invariants: every Liquid Glass target stays `plain: 1`; never attach
  a border beam to a glass host; no backdrop-filter on a full-screen scrim; no
  `will-change` at rest; no external scripts, styles or fonts; no new npm
  dependencies.
- The app's voice: calm, plain English, sentence case, "folder" not
  "directory", "Trash" for the OS trash, and never jargon a user did not ask
  for — no errno, no status codes, no hashes, no pids.

## Traps that will cost you hours

1. **`asar extract-file` writes to the CURRENT DIRECTORY, not stdout.** A
   verification script that redirects its output overwrote this repo's
   `package.json` with the asar's stripped copy — `npm test` became "Missing
   script: test" — and dropped eight extracted `.js` files in the repo root.
   Parse the asar header in Node instead and read files out of it.
2. **Never bulk-replace a version string in `package-lock.json`.** Six
   third-party packages sit at whatever version TreeMap happens to be on. Only
   two nodes describe TreeMap: the lock root and `packages[""]`.
3. **zsh does not word-split an unquoted `$VAR`.** `shasum -a 256 $FILES` is
   one bogus filename; shasum errors and the empty-string digest compares
   equal to itself, so a restore check passes while proving nothing. Use
   explicit filenames, or `git diff`.
4. **`braced()` closes on a brace in the SIGNATURE.** `async function api(url,
   options, opts = {})` "closes" on its own parameter list. Fixed copies walk
   the parameter list first; if you write a new helper, do the same. And
   `appFn` cuts at the first `\n}`, so a function body must never have a `}`
   at column 0.
5. **A new function name can collide with a slice anchor.** Grep the anchors
   before you name anything.
6. **`open -a` DOES pass an env var through.** Confirm the watcher is `live`
   before believing an idle-CPU number.
7. **Linux has no recursive `fs.watch`.** Never write a test that depends on
   watching a directory it just made.
8. **Never edit sources while `npm test` is running.**
9. **macOS has no `timeout`.** Enforce wall clocks from Python
   `subprocess.run(..., timeout=)`.
10. **A golden fixture holding a filesystem-dependent number can never
    match.** `slackBytes` is normalised in `tests/fixtures/goldenHarness.ts`
    for exactly this reason — it is what the fixture's small files round up
    to, which depends on the block size. Normalise, do not re-record.
11. **electron-builder breaks `npm test`** until `npm rebuild better-sqlite3`.
12. **`req.query` is a getter in Express 5** — assigning to it is discarded.
13. **`-0 !== 0` under `assert/strict`.** Normalise a negated zero.
14. **Driving the installed app:** never extract or launch the bare dev
    Electron binary — Gatekeeper flags it as malware and deletes it. Launch
    `/Applications/TreeMap.app` with `--remote-debugging-port=9222` and drive
    it over CDP, and only when no TreeMap is already running
    (`app.requestSingleInstanceLock()`). `renderFleet()` takes no arguments —
    it reads `state.fleet.data` — and `switchView` re-fetches, overwriting
    anything you just stubbed.
