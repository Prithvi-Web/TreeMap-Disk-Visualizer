# Contributing to TreeMap

Three commands and one rule.

```bash
npm install
npm run build:ui && npm run typecheck
npm test
```

**The rule: never edit `public/index.html`.** It is generated. The frontend lives in `src/ui/` as small source files — `shell/` (the document's head and tail), `styles/`, `markup/` (one file per view and modal) and `app/` (the behaviour) — and `scripts/build-ui.js` stitches them, in `src/ui/manifest.json` order, into that one page. Edit the source, run `npm run build:ui`, and commit both. `tests/buildUi.test.ts` fails the suite if the page drifts from its sources, and a new source file must be added to the manifest or it never ships. `src/ui/README.md` explains the layout.

## Working on it

- `npm run dev` runs the server with reload; `node scripts/dev-isolated.js` runs it against a throwaway data folder, so the scheduler cannot start scanning your real folders.
- One test file at a time: `npx tsx --test tests/<name>.test.ts`. The whole suite takes minutes; `npm test` runs it on every OS in CI, so use `path.join` and `os.tmpdir()` in tests rather than POSIX literals, and never touch a real home folder — synthetic fixtures only.
- Every change to behaviour comes with a test that failed before the change. A test that never went red is not evidence.
- What a person reads is written in English on every machine, because the interface is English and `formatBytes` always prints an English decimal point. A count goes through `formatCount` (`src/utils/formatCount.ts` on the server, the page's own in `src/ui/app/000-prelude.js`) and comes out "1,234" everywhere. A date names `UI_LOCALE`, and a clock also passes the machine's hour cycle (`HOUR_CYCLE` on the page, `machineHourCycle()` on the server), so it reads "Sep 6, 2026" but keeps the machine's 12- or 24-hour clock and its time zone. Never a locale-less `toLocaleString()`, `toLocaleDateString([])` or `Intl.DateTimeFormat(undefined, …)`: those follow the machine's locale, and once printed "1.234 shapes" beside "1.2 GB" and Arabic-Indic digits inside English sentences. `tests/localeIndependence.test.ts` bans the locale-less forms in the app, comments included (describe the call without its leading dot), and CI runs the whole suite under a Portuguese locale, so a test that hard-codes locale output, or a stub that follows the machine, goes red there.
- Deletes go to the Trash, never a hard delete; nothing outside a scanned folder is ever touched. Those two rules are the product.

## Voice

Everything the user reads is calm, plain English in sentence case: "folder", not "directory"; "Trash", not "unlink"; a reason, never an error code.

## Where things go

- A bug: the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) asks for what a TreeMap report needs.
- A security problem: privately, as [SECURITY.md](SECURITY.md) says — not a public issue.
- Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
