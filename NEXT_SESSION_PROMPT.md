# Prompt for the next session

Copy everything below the line into a fresh session started in
`/Users/prithvivinay/Desktop/Claude Code/Treemap`.

---

Work on TreeMap at `/Users/prithvivinay/Desktop/Claude Code/Treemap`.

**Read `HANDOFF.md` first — the top section ("Session 5") is the current state.**
Then read `src/ui/README.md`. Do not skip these; they contain the traps that
cost the last three sessions the most time.

## The one rule that will bite you immediately

`public/index.html` is **GENERATED**. It is ~30,000 lines and you must not edit
it. The frontend is written as 111 small files under `src/ui/` (shell, styles,
markup, app). Edit those, then run `npm run build:ui`. A new source file must
be added to `src/ui/manifest.json` or the build refuses. `tests/buildUi.test.ts`
fails the suite if the artifact is hand-edited or a source changed without a
rebuild.

## Where things stand

Everything through session 5 is **committed AND pushed** to `origin/main`
(`196a369`), and **CI run 33537258196 is green on macOS, Windows and Linux**.
Suite: **2,185 tests · 0 fail · 3–4 skips** (the 4th is a documented `fs.watch`
self-skip, not a failure); `npm run typecheck` clean;
`node scripts/build-ui.js --check` matches (111 parts).

Shipped as **v4.1.0** and installed at `/Applications/TreeMap.app`.

The app is a disk-space visualizer with an Apple-dark glass design language,
bklit-style charts in blue/black, and four inlined FX libraries (liquid-gooey,
border-beam, thinking-orbs, and a bklit-fidelity chart kit). The owner's
standard is explicit and non-negotiable: **flawless — zero errors, the frontend
should look and feel exceptional, and the frontend/backend integration must be
correct, not merely working.**

## Your job

**The previous prompt's three priorities are all CLOSED.** Do not redo them:

1. ~~The integration round's stage-3 end-to-end journeys~~ — done. Scan → drill →
   search → cart → dry-run commit, duplicates reconciliation, budgets, notes
   suppression, settings persistence, snapshot compare and Trends were all driven
   against the real UI and real server, in both themes.
2. ~~Verify the boot-burst 429s in a browser~~ — done and **measured at 0**, by
   replaying the real 26-request burst against a fresh server.
3. ~~The three known-open items~~ — `/api/cleanup/rules` 202 handling is fixed;
   the 12 caller-less routes are confirmed as the published agent/MCP surface
   (**delete none**); both perf-test claims were refuted by measurement, with no
   budget loosened.

What is actually left, smallest first:

- **`tests/zombieHandles.test.ts` is load-sensitive** — it spawns processes
  against a 30-second deadline and can go red on a slow or busy runner. It is
  not a regression. If you touch it, do not fix it by extending the deadline
  without evidence; and remember that one run each way is not evidence.
- **Known-deliberately-left** (see HANDOFF for the reasoning): the media-note
  tooltip is unreachable at root under single-child elision; a QA boot
  observation was never reproduced; the autopilot open-file-guard test flakes
  only under parallel-suite load.
- **v4.1.0 has not been published as a GitHub release.** The artifacts exist
  (`release/TreeMap-4.1.0-arm64.dmg` and `-mac.zip`). Publishing is the owner's
  call — ask, never push a release on your own.
- Otherwise the field is open. Ask the owner what they want before inventing
  scope.

**Never run a destructive operation.** Deletes, offloads and Autopilot runs are
dry-run only. Treat the owner's real files as untouchable.

## How to work

- **Test-first, and prove each test bites**: break the behaviour, watch the suite
  fail, restore by inverse edit, confirm green. Several tests shipped green while
  testing nothing; a whole stage was spent fixing that.
- **Green tests are not a reviewed diff.** This is the most expensive lesson the
  project has learned. Session 5 fixed 37 adversarially-verified defects, and an
  audit of its own fix diff found **9 regressions it had introduced**, which none
  of the 2,139 then-passing tests noticed. An audit of those nine fixes found
  **3 more**. Budget for a diff review after any large fix round, and expect the
  audit's own fixes to need one more pass.
- **Probe a security-ish gate adversarially against the real filesystem.** A
  third narrow pass — 78 spellings of a blocked path — found the worst defect of
  the session, and it was *pre-existing*: a macOS **firmlink is not a symlink**,
  so `realpath` collapses neither spelling and
  `/System/Volumes/Data/private/var/db` (same dev+ino as `/private/var/db`,
  holding `dslocal`) was an accepted scan root. No diff-shaped review would ever
  have found it, because no diff was to blame.
- **Never anchor a test to a comment or an exact line of code.** Assert the
  invariant. Brace-matching helpers (`braced()`, `decls()`) exist in
  `tests/premiumPolish.test.ts` and `tests/motionWidth.test.ts`.
- **Verify with real input, not synthetic `.click()`** — many handlers in this
  app ignore synthetic events, and you will report working features as broken.
- Both themes and every window width from 640px up must stay correct. Prefer
  container queries over viewport media queries.
- Finish with `npm test`, `npm run typecheck` and `node scripts/build-ui.js
  --check`. All three green, or you are not done.
- Agents and workflows are welcome and have paid off repeatedly here.

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
6. **`req.query` is a getter in express 5** — assigning to it mutates a throwaway
   and the sanitisation is silently discarded. `req.body` is a plain own property,
   so that assignment does stick.
7. **A brace inside a CSS *comment* desyncs every brace-matched slicer** in the
   suite and turns a correct rule red. There is a guard test for it now.
8. **A chart canvas with an explicit inline width becomes its card's min-content
   floor**, so the card can never shrink and the kit's ResizeObserver never fires.
   Only `max-width: 100%` fixes it — `min-width: 0` does not, and a stylesheet
   `width: 100%` never applies because the inline style outranks it.
9. **Windows CI is the only place two whole bug classes surface**: a POSIX path
   literal sent to a guarded route (`/root` is not absolute there), and a test
   racing a fire-and-forget write. Both now have laptop-side guards —
   `tests/windowsPathFixtures.test.ts` and `tests/backgroundWrites.test.ts` — but
   they are nets, not proofs. CI is the authority.
10. `gh` is **not installed** on this laptop and the Actions *logs* endpoint 403s
    without admin rights. Read CI through the unauthenticated **jobs** endpoint
    instead (the exact command is in `HANDOFF.md`), because a run's top-level
    conclusion hides which OS did what.
