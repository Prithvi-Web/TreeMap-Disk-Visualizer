# Prompt for the next session

Copy everything below the line into a fresh session started in
`/Users/prithvivinay/Desktop/Claude Code/Treemap`.

---

Work on TreeMap at `/Users/prithvivinay/Desktop/Claude Code/Treemap`.

**Read `HANDOFF.md` first — the top section ("Session 4") is the current state.**
Then read `src/ui/README.md`. Do not skip these; they contain the traps that
cost the last two sessions the most time.

## The one rule that will bite you immediately

`public/index.html` is **GENERATED**. It is ~30,000 lines and you must not edit
it. The frontend is written as 110 small files under `src/ui/` (shell, styles,
markup, app). Edit those, then run `npm run build:ui`. A new source file must
be added to `src/ui/manifest.json` or the build refuses. `tests/buildUi.test.ts`
fails the suite if the artifact is hand-edited or a source changed without a
rebuild.

## Where things stand

Five sessions of work are committed **locally and unpushed** (the owner pushes
via GitHub Desktop). Suite: **2008 tests · 2006 pass · 0 fail · 2 pre-existing
skips**; `npm run typecheck` clean; `node scripts/build-ui.js --check` matches.

The app is a disk-space visualizer with an Apple-dark glass design language,
bklit-style charts in blue/black, and four inlined FX libraries (liquid-gooey,
border-beam, thinking-orbs, and a bklit-fidelity chart kit). The owner's
standard is explicit and non-negotiable: **flawless — zero errors, the frontend
should look and feel exceptional, and the frontend/backend integration must be
correct, not merely working.**

## Your job, in priority order

### 1. Finish the integration round's third stage (the main outstanding work)

Stages 1 and 2 (endpoint contract sweep; rate-limit headroom and error paths)
landed. Stage 3 — end-to-end journeys — stalled and was stopped, and **none of
it is committed**. Do it:

Drive the REAL UI against the real server and verify at each step that the
screen agrees with the API payload:

- scan → drill three levels → search (`size>1gb`) → stage files to the cart →
  run the commit's **DRY RUN ONLY**, then verify on disk that nothing was
  deleted;
- duplicates (summary, per-group reclaimable and the funnel's three numbers
  must reconcile with `/api/duplicates`);
- budgets, folder notes (a suppressing note must remove that subtree from Smart
  Suggestions), settings persistence across a reload;
- snapshot compare; Trends (no projection when the forecast gate is closed);
- **the console must be clean in every view, in both themes** — report the exact
  remaining set with a justification for each, or fix it.

**Never run a destructive operation.** Deletes, offloads and Autopilot runs are
dry-run only. Treat the owner's real files as untouchable.

### 2. Verify the backend fixes actually work in a browser

`scripts/dev-isolated.js` runs the compiled `dist/`, so the rate-limiter lane
split and the route changes are **not live** until you run `npm run build` and
restart the server. The specific thing to confirm: a page load concurrent with a
scan completing must produce **zero 429s** (it used to produce four). Nothing
about this has been checked in a browser yet.

### 3. Close the known-open items

- `GET /api/cleanup/rules` can answer 202 `{status:'running'}`; `runCleanFind`
  would then read `data.files` as undefined.
- 12 routes have no frontend caller (agent/MCP surface — confirm before touching).
- Two wall-clock perf tests are load-sensitive (`indexEngine` "sub-quadratic",
  `subtreeCount`'s 400ms budget). They fail on a busy machine, pass isolated.
  Investigate before believing a failure; **never loosen the budget to make them
  pass.**

## How to work

- **Test-first, and prove each test bites**: break the behaviour, watch the suite
  fail, restore by inverse edit, confirm green. Several tests shipped green while
  testing nothing; a whole stage was spent fixing that.
- **Never anchor a test to a comment or an exact line of code.** Assert the
  invariant. Brace-matching helpers (`braced()`, `decls()`) exist in
  `tests/premiumPolish.test.ts` and `tests/motionWidth.test.ts`.
- **Verify with real input, not synthetic `.click()`** — many handlers in this
  app ignore synthetic events, and you will report working features as broken.
- Both themes and every window width from 640px up must stay correct. Prefer
  container queries over viewport media queries.
- Finish with `npm test`, `npm run typecheck` and `node scripts/build-ui.js
  --check`. All three green, or you are not done.
- Agents and workflows are welcome and have paid off repeatedly here — an
  adversarial review fleet found 41 issues, 17 of which survived independent
  verification, including two regressions the session had introduced itself.

## Things that will waste your time if you don't know them

1. The preview pane reports `document.hidden === true` forever: charts refuse to
   paint, rAF is frozen, `element.focus()` fires no focus event, and rolling
   numerals take their plain-text path. Spoof visibility to inspect. Its console
   history also spans reloads — check in a fresh tab.
2. Editing a source while a suite run is in flight makes string-matching tests
   fail once and pass on retry. That is not a flake.
3. FX banner comments are extraction anchors for five test files and hard-fail if
   renamed. The CSS copies use shorter `═` runs than the JS ones, deliberately.
4. Never attach a border beam to a Liquid Glass host (`.modal`, `#cartTab`) — the
   beam overwrites the pseudo-elements the glass fill lives in and the panel goes
   see-through. Use a `.fx-beam-strip` child.
5. Rolling numerals inherit their host's neighbourhood: a `.host span` rule
   written for a caption will style digit strips, and `white-space: nowrap` blanks
   them. The reset uses longhands, never the `font:` shorthand.
