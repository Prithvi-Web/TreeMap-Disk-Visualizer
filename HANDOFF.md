# Handoff: NTFS MFT turbo engine

You're picking up work a prior session designed but did not implement. This
file is written for an agent with zero context on this conversation — read it
before touching any code.

## Read these first, in order

1. `docs/superpowers/specs/2026-07-24-ntfs-mft-engine-design.md` — the *why*.
   Went through three review rounds; §7 of that doc is its own revision
   history, worth reading to understand which decisions were load-bearing
   and which were close calls.
2. `docs/superpowers/plans/2026-07-24-ntfs-mft-engine.md` — the *how*. Ten
   TDD tasks, each with exact file paths, full code, and exact test/run
   commands. This went through two review rounds of its own (caught two real
   blocking bugs in the plan's own test code before any implementation
   started — see its commit history for what was wrong and why).

**Do not re-derive the design. Both documents already survived adversarial
review; second-guessing settled decisions from scratch wastes the review
work already paid for.** If something in the plan turns out to be wrong once
you're actually implementing it (the plan itself flags a few "verify before
assuming" spots — Rust API surface, an exact `rootPath` string shape), fix
that specific thing and note why in the commit, don't redesign around it.

## Where things stand right now

- Branch: `feat/ntfs-mft-engine`, branched off `main`, currently **5 commits
  ahead, all docs-only** (spec x3 revisions, plan, plan fixes). Zero
  implementation code exists yet. Task 1 of the plan is the first commit
  that should touch `src/` or `native/`.
- `main` is untouched and should stay that way until this branch is ready to
  become a PR.
- This repo (`Prithvi-Web/TreeMap-Disk-Visualizer`) is a clone at
  `J:\projects\cloned-projects\TreeMap-Disk-Visualizer`, not a repo this
  session has push/PR access set up for. **Do not push or open a PR without
  the user explicitly asking for it in that session** — that's a separate,
  visible-to-others action outside this plan's scope.
- Baseline test state (recorded in the spec, still true as of the plan being
  written): `npm run build` clean, `npm test` → **190 pass / 3 fail / 5
  skipped**. The 3 failures (`apiHardening` boundary test, `appAttribution`
  Windows-path test, an API byte-identical baseline drift test) are
  **pre-existing on `main`, unrelated to scanning engines** — don't chase
  them as part of this work, and don't let a fresh `npm test` run's "3
  failing" reading cause alarm; confirm it's still those same 3, not new
  ones, and move on.
- `package-lock.json` currently shows as locally modified (from an `npm
  install` run during baseline-checking) — not committed, not related to
  this feature. Leave it alone unless it becomes actually relevant to a task.

## Non-obvious context worth knowing

- **Where this came from:** the user reverse-engineered WizTree (a
  closed-source, EULA-protected disk-usage tool) purely to understand *why*
  it's fast — confirmed it reads the NTFS Master File Table directly instead
  of walking directories. **Nothing from WizTree's binary is used anywhere
  in this plan.** The actual implementation depends on `ntfs-reader`, an
  independent, MIT/Apache-2.0-licensed, clean-room Rust crate built from
  public NTFS documentation. If anyone asks "did we copy WizTree," the
  answer is no — same public technique, different, legally clean
  implementation. This is documented in spec §3.1 if you need to point to it.
- **Why a standalone Rust CLI, not a native Node addon:** a native addon
  would need the whole Electron process elevated to call it (worse launch
  UX than today). Spec §2 has the full reasoning if this gets questioned.
- **Why opt-in, not automatic like `gdu-turbo`:** this engine triggers a real
  UAC prompt; every other engine is silent. The user explicitly chose
  opt-in-only over auto-trigger during the design phase (spec §3.5) — this
  is a confirmed product decision, not an open question.
- **Explicitly out of scope for this plan** (don't scope-creep into these):
  the `ntfs-reader` crate's `Journal` API for incremental re-scan / feeding
  `watcher.ts`; ReFS support; true mid-read cancellation of the elevated
  helper (accepted as a documented limitation — a timeout backstop exists,
  real kill doesn't). All three are flagged as legitimate follow-up work in
  spec §4, not gaps in this plan.
- **Environment:** this was planned on a Windows machine (`win32`), Node
  v25.6.0 / npm 11.8.0 confirmed installed. A Rust toolchain's availability
  was **not** confirmed in the environment this was planned in — Task 7 and
  the build script in Task 8 explicitly handle "no Rust toolchain" as a
  non-fatal, fall-back-gracefully case, matching how a missing `gdu` binary
  already degrades. Task 10 (the manual elevated end-to-end pass) genuinely
  requires a real Windows machine with admin rights — it cannot be
  automated or run in CI, by design.

## Execution

The plan's own header names the two supported ways to run it:
**`superpowers:subagent-driven-development`** (fresh subagent per task, review
between tasks — recommended) or **`superpowers:executing-plans`** (inline,
batch execution with checkpoints). Ask the user which one before starting if
they haven't already said.

Thank you for picking this up — the design and plan were reviewed hard
specifically so the implementation phase should be able to move fast without
re-litigating architecture. Good luck.
