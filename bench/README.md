# bench — measuring the scan engine honestly

`npm run bench` drives the **real** engines (`startScan`, the duplicate job,
the near-duplicate job) over deterministic synthetic corpora and records every
number with the conditions it was taken under. It is the referent for every
performance claim in the engine work (`docs/engine/DESIGN.md`): a figure that
is not in `bench/baselines/` or a `bench/results/` file does not go in the
README, the UI or a release note.

## Commands

```
npm run bench -- enumerate [--corpus=enum200k|enum1m|ci20k|smoke|dupes100k] [--engine=auto|native|gdu|walker] [--preset=eco|balanced|turbo] [--runs=3] [--cache=warm|cold] [--record] [--label=...]
npm run bench -- duplicates [--corpus=dupes100k|smoke|ci20k|enum200k|enum1m] [--runs=3] [--min-size=1024] [--cache=warm|cold] [--record] [--label=...]
npm run bench -- neardup [--originals=600] [--runs=1] [--threshold=10] [--cache=warm|cold] [--record] [--label=...]
npm run bench -- all [--small] [--runs=3] [--originals=600] [--record] [--label=...]
npm run bench -- governor [--preset=eco|balanced|turbo] [--seconds=60] [--record] [--label=...]
npm run bench -- compare <result.json> <baseline.json>
npm run bench -- clean
```

An option that is misspelled or does not belong to the command is refused,
never ignored: `--run=3` is an error, not a silent default.

`compare` exits **0** on PASS, **1** on FAIL, **2** on INCONCLUSIVE and **3**
on NOT COMPARABLE, so a script can tell "no regression" from "could not
tell" from "these two files do not describe the same thing".

`all --small` runs every suite on the smoke corpus and two images: the
end-to-end check the test suite itself runs.

## How a number is taken

**Every measured pass is a fresh child process.** The harness starts
`bench/lib/measureWorker.ts` once per run with an isolated app-data
directory and the engine gate in that child's environment. That is what
makes the columns comparable:

* peak RSS is the pass's own (no scans retained from earlier passes, no
  corpus builder in the same heap);
* CPU seconds and bytes read cannot include the previous scan's persistence;
* the engine variable is set before a single service is imported, so nothing
  depends on import order.

The scan is timed to the instant its status leaves `running`. The app then
writes its rescan cache and a snapshot in the background; the harness waits
for those through the app's own write ledger and reports them separately as
`persistMs` / `persistCpuSeconds` in every run record — never inside the
scan's numbers, never lost. For trees of 300,000 nodes or fewer the app also
materialises the cache tree synchronously before completion is observable;
that cost is inside the scan's wall clock by the app's design, and the record
says so.

Corpora are built once under the OS temp directory
(`<tmp>/treemap-bench/<name>-<hash of the parameters>/tree`, the manifest
beside the tree) and reused while their `manifest.json` still matches the
parameters, still points at that tree, and a sample of the paths it lists
still exists. Nothing is written inside the repository except
`bench/results/` (ignored by git) and, with `--record`, `bench/baselines/`.
`TREEMAP_BENCH_OUT=<dir>` redirects the results directory.

## What a row means

| Column | Meaning |
| --- | --- |
| `rate` | what the suite counts per second: `entries/s` (files + directories, the root included) for enumerate, `files/s` for duplicates, `images/s` for near-duplicates, `samples/s` for the governor (its row is explained below) |
| `wall (median)` | median of `--runs` measured passes; a warm-up pass is never counted |
| `spread` | (max − min) / median across the runs; over 5% the row is marked `(>5%)` and is not reproducible — rerun on a quieter machine before believing it; one run has no spread |
| `CPU s/M` | CPU seconds per million entries **including child processes** (gdu's shards count), the efficiency figure the design gates on |
| `peak RSS` | the measuring process's peak resident set — its own lifetime, which is this one pass plus the Node runtime it needed |
| `bytes read` | physical bytes the measuring process read: `proc_pid_rusage` on macOS, `/proc/self/io` on Linux; `n/a` on Windows and for gdu, which reads in child processes the probe cannot see. A warm pass legitimately reads 0 |
| `budget` | the budget preset asked for, then the preset each measured run ran under, one per run (`turbo: turbo/turbo/turbo`); `(moved)` when a run ran under another (see "The budget" below); `none (recorded before the governor)` on a result written before the budget existed |
| `load` | the 1-minute load average at the end of each run, one figure per run; `n/a` on Windows, which has none |
| `correct` | every run's counts and bytes agree with the corpus manifest and with each other; for duplicates, every planted group the finder could report was reported whole and every reported group is byte-identical **by reading the files**, with hard-link families never counted as reclaimable; for near-duplicates, the decoder ran, nothing was cut off, something was clustered, and precision reached the 0.98 bar the design sets |

A correctness failure is printed beside the timing and makes the command exit
non-zero. A result that failed correctness or is not reproducible is never
recorded as a baseline and is refused by `compare`. An engine that is fast
and wrong has measured nothing.

## The budget

The app scans under a resource budget — Eco, Balanced or Turbo, or Automatic
(Balanced on mains, Eco on battery or under serious heat) — and the master
prompt's enumeration targets are set per budget: warm Turbo 400–700k
entries/s, warm Eco 150–250k on Tier B. A number measured under an unnamed
budget cannot be held to either, so every result names its budget.

* **enumerate** scans under `--preset`, **Turbo when none is given**: the
  headline target is Turbo's, and the app's own default (Automatic) resolves
  differently by power and heat, so a number measured under it could not say
  which. Each measuring process sets the preset with the app's own setter,
  `applyEngineBudgetSetting({ preset, cpuPercent: null })`, after loading the
  settings file — the settings' first load hands the budget module the
  persisted setting, and would otherwise undo the preset inside `startScan`,
  silently. The native governor, when loaded, is reconfigured by that call
  with Automatic off.
* **duplicates** and **neardup** name no preset: their scans run under the
  app's default, and the result records what it resolved to. **governor**
  records the preset it held (auto mode is off, and a hold of another target
  is refused), or `none` for a hold that never ran.
* The record is the product's, not the harness's: `budget.requested` is what
  was asked for, and `budget.effective` holds, per measured run, the
  `effective` preset of that scan's own `budget` record — the one
  `GET /api/scan/:id/stats` serves, captured when the scan starts. A scan
  whose record names a setting other than the one asked for is refused outright
  (the preset did not take). A series whose runs ran under another preset
  (for Automatic, under more than one) is marked `(moved)`, is never recorded
  as a baseline, and cannot pass a comparison. Two product rules are worth
  knowing when that happens: the governor scales Eco and Balanced back while
  someone is using the computer (Turbo it does not), and any preset under
  thermal pressure; the scan's record names the preset, not that scaling.

## The governor row

`npm run bench -- governor` is the Phase 2 gate for the native resource
governor (`docs/superpowers/plans/2026-09-18-phase2-governor.md`, Task 7).
It configures the governor for one preset with auto mode off, asks the native
module to hold its own synthetic load at that preset's ceiling — Eco 25%,
Balanced 50%, Turbo 90% of machine CPU — for `--seconds` (60 by default,
the gate's length), and records the share the hold's independent sampler saw.
The evidence is in the lines under the table, not the timing columns:

* `rate` is samples per second (the sampler's cadence, about 10/s), not a
  throughput; `wall (median)` is the hold's measured length, which is the
  length asked for;
* `spread` is the hold's own p95 |error| in percentage points of machine
  CPU — one run is the whole series, so there is no spread across runs;
* `correct` is the band verdict the native hold returns: the mean of the
  **last half** of the run held within ±5 points of the preset's ceiling. The
  notes print the target, the mean, the mean of the last half, the p95 error,
  the final worker count and duty, and the series compacted to every 10th
  sample. The harness never recomputes or smooths any of them;
* a governor result is reproducible when the band held, and a single run is
  enough — the hold is itself a series of several hundred samples — so
  `--record` accepts it (on a clean tree, as for every suite);
* `CPU s/M`, `peak RSS`, `load` and the persist fields are the measuring
  process's own: CPU seconds are its `process.cpuUsage()` delta and include
  the synthetic load, which runs on the process's threads; `bytes read` and
  persistence do not apply and the run record says so.

When the native module cannot load (no prebuilt for this platform, a version
mismatch), the row is `FAIL` with the loader's reason as its only note and a
single zero-sample run — `n/a` in the timing columns, zeros in the record,
never a series that no governor produced. The command exits 1.

`compare` between two governor results of the same preset and length is
INCONCLUSIVE by construction: their wall clocks are the prescribed hold
length, and a single hold has no resolution across runs. Different presets
or lengths are NOT COMPARABLE (the corpus is `hold-<preset>` with the seconds
in its parameters). Read the two CORRECTNESS lines and series instead.

## Refusals, never guesses

* `--engine=gdu` without a gdu binary is an error, and a run that asked for
  gdu but whose scan fell back to the walker (the app does that on any gdu
  failure) is an error too — the number would describe the wrong engine.
* `--engine=native` (Phase 3) forces the native walker through the app's own
  `engine` setting, written into the child's private data directory; a build
  without the module, or a scan that did not report `engine: 'native'` (the
  app falls back to the legacy chain on any native failure, saying why in
  `fallbackReason`), is an error for the same reason. `--engine=walker` and
  `--engine=gdu` are forced the same way, so `auto` is the only pass that
  measures the app's own selection.
* A cold series is `cold` only when the purge procedure succeeded before
  **every** measured run; one failure and the result says `unknown` with the
  runs it could not purge.
* A requested budget preset that the scan's own record does not name is an
  error: the number would describe another budget.
* `--record` refuses a result that failed correctness, is not reproducible,
  ran a run under a budget other than the one it names (the refusal names
  the runs and presets), or was measured on a working tree with uncommitted
  changes (the commit it cites would not be the code measured).
* `compare` refuses two results that differ in suite, corpus, corpus
  parameters, engine, unit, machine tier, platform, architecture, cache
  state or budget, and a result whose budget moved. A result written before
  the budget existed — every Phase 1 baseline in `bench/baselines/` — reads
  as `none (recorded before the governor)`, so it is NOT COMPARABLE with any
  result that names a budget; the baselines are not rewritten.

## Cache state, and why a run is not "cold" just because you said so

* **warm** — a full un-measured pass ran first, and (on macOS) the tree fits
  80% of this machine's vnode cache, `kern.maxvnodes` (251,127 on the Tier B
  machine the baselines come from). Off macOS there is no fixed limit to
  check, and the label says residency was not verified beyond the warm-up.
  For the duplicate and near-duplicate suites the warm-up is one un-measured
  job run, and the label says whether the file data stayed in the page cache
  is not verified.
* **mixed** — a warm-up pass ran but the tree is larger than 80% of
  `kern.maxvnodes`. This is the honest label for a 1M-entry scan on a default
  macOS install: every scan past the cache size pays catalog reads, whatever
  the enumeration API.
* **cold** — the purge procedure ran **and exited 0** before every measured
  pass.
* **unknown** — a purge failed, or no warm-up pass ran.

Procedures the harness runs for `--cache=cold` (no shell, fixed arguments):

| Platform | Command | Needs |
| --- | --- | --- |
| macOS | `sudo -n purge` | a way to run that one command without a prompt. The narrow option is a sudoers rule limited to it — `<you> ALL=(root) NOPASSWD: /usr/sbin/purge` — so nothing else in the process can use it; the broad option is `sudo -v` in the same terminal first, which leaves a root ticket every process of yours can use for a few minutes, and `sudo -k` afterwards |
| Linux | `sync` then `sudo -n sh -c 'echo 3 > /proc/sys/vm/drop_caches'` | the same, for that command. On a distribution whose `/tmp` is tmpfs the corpora live in RAM and cannot be evicted, so a cold run there is not cold whatever the label says; keep `TMPDIR` on a disk |
| Windows | none unattended: RAMMap → Empty → Empty Standby List by hand | a cold run on Windows is recorded as `unknown` with that reason |

## Machine tiers

Results name the machine (CPU, cores split by performance level, memory, OS,
architecture, Node, commit) and a tier by the rule in `bench/lib/machine.ts`,
which follows the master prompt's Section 5.1: **C** when the machine has 4
cores or fewer or 8 GiB or less (decided first — a small machine is small
whatever its name says); **A** when it has 8+ cores and 32 GiB, or is an
Apple Pro/Max/Ultra part; **B** everything between. The baselines committed
here were taken on a Tier B Apple M3 (4P+4E, 16 GB). A number from one tier
says nothing about another, and the tier, platform and architecture are in
the baseline's file name and checked by `compare`.

## Corpora

| Name | Entries | Notes |
| --- | --- | --- |
| `smoke` | 1,200 | 12% planted duplicates, hard links, sparse files; seconds to build and scan — the CLI's own tests |
| `ci20k` | 20,000 | 5% duplicates, one flat directory of 1,000; the fixed small corpus a CI runner can afford |
| `enum200k` | 200,000 | log-normal sizes (median 1 KiB), one flat directory of 10,000 children, 1% hard links, 0.1% sparse; fits the vnode cache |
| `enum1m` | 1,000,000 | the same shape at the prompt's full enumeration size; **cannot be warm on a default macOS install** |
| `dupes100k` | ~112,000 (≈100k files) | median 8 KiB, sizes quantised so the size-bucket stage has real work, **12% planted byte-identical duplicates**, hard-link families, sparse files — one tenth of the prompt's file count and one hundredth of its bytes, and labelled so in every result |
| `images<N>` | N originals × 13 (original + 12 transforms) | synthetic photos with planted resize, re-encode at two qualities, crops of 5/10/20%, rotation, watermark, screenshot-of-image, PNG and WebP conversion, colour shift; the manifest is the labelled truth for recall and precision |

Measured on this Mac: the five corpora plus 600 originals of images take
about **11 GB** of temp space (`enum1m` alone about 3.5 GB on disk; sparse
files count for nothing there). `npm run bench -- clean` removes them all and
prints what it freed. On Windows the presets plant no sparse files, because
an extended file allocates in full there; every manifest carries the
parameters it was built with, so the difference is recorded, not hidden.

The plan behind every corpus is a pure function of its parameters and seed:
`planDigest` in the manifest is the proof, and `tests/benchCorpus.test.ts`
holds it.

## Reading a comparison

`npm run bench -- compare current.json baseline.json` prints one of:

* `PASS` — faster, or slower by less than the 10% gate;
* `FAIL` — slower by more than 10% (and more than the combined resolution of
  the two measurements, √(a² + b²));
* `INCONCLUSIVE` — the difference is inside that combined band. That is not
  a pass and not a fail; it is "cannot tell at this resolution", and the fix
  is `--runs=15`, not a verdict. A result with fewer than three runs has no
  resolution at all;
* `NOT COMPARABLE` — the two files describe different things (a different
  budget included), or one of them failed correctness, is not reproducible,
  or did not run under the budget it names.

## Plain words for the README

A first scan of a large drive is bound by the disk and the filesystem, not by
TreeMap: the catalog has to be read once. The headline throughput figures are
warm-cache, local-SSD numbers on a named machine, and this directory is where
they come from.
