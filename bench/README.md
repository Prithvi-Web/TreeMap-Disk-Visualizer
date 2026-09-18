# bench — measuring the scan engine honestly

`npm run bench` drives the **real** engines (`startScan`, the duplicate job,
the near-duplicate job) over deterministic synthetic corpora and records every
number with the conditions it was taken under. It is the referent for every
performance claim in the engine work (`docs/engine/DESIGN.md`): a figure that
is not in `bench/baselines/` or a `bench/results/` file does not go in the
README, the UI or a release note.

## Commands

```
npm run bench -- enumerate [--corpus=enum200k|enum1m] [--engine=auto|gdu|walker] [--runs=3] [--cache=warm|cold] [--record] [--label=...]
npm run bench -- duplicates [--corpus=dupes100k] [--runs=3] [--min-size=1024] [--record]
npm run bench -- neardup [--originals=600] [--runs=1] [--threshold=10] [--record]
npm run bench -- all [--record]
npm run bench -- compare <result.json> <baseline.json>
```

Corpora are built once under the OS temp directory
(`<tmp>/treemap-bench/<name>-<hash of the parameters>/`) and reused while
their `manifest.json` still matches the parameters. Nothing is ever written
inside the repository except `bench/results/` (ignored by git) and, with
`--record`, `bench/baselines/`.

Every run isolates `TREEMAP_DATA_DIR` in a fresh temp directory, so the
harness never shares a cache, a snapshot store or a settings file with an
installed TreeMap.

## What a row means

| Column | Meaning |
| --- | --- |
| `entries/s` | files + directories (the root included) divided by the median wall clock of the runs |
| `wall (median)` | median of `--runs` measured passes; a warm-up pass is never counted |
| `spread` | (max − min) / median across the runs; over 5% the row is marked `(>5%)` and is not reproducible — rerun on a quieter machine before believing it |
| `CPU s/M` | CPU seconds (user + system, this process only) per million entries — the efficiency figure the design gates on, not wall clock |
| `peak RSS` | the process's peak resident set (`process.resourceUsage().maxRSS`) |
| `bytes read` | bytes the process read from disk: `proc_pid_rusage` on macOS, `/proc/self/io` on Linux; `n/a` on Windows and for engines that read in a child process (gdu) — the harness says so rather than guessing |
| `load` | the 1-minute load average at the end of each run, one figure per run |
| `correct` | the engine's counts and bytes agree with the corpus manifest; for duplicates, recall 1 and zero false positives **by byte comparison**; for near-duplicates, the job completed without truncation |

A correctness failure is printed beside the timing and makes the command exit
non-zero. An engine that is fast and wrong has measured nothing.

## Cache state, and why a run is not "cold" just because you said so

The state printed beside each result is one of:

* **warm** — a full un-measured pass ran first, and the tree fits this
  machine's vnode cache. On macOS `kern.maxvnodes` (251,127 on the Tier B
  machine the baselines come from) caps how many entries can be warm at once.
* **mixed** — a warm-up pass ran but the tree is larger than 80% of
  `kern.maxvnodes`, so the metadata cache cannot hold it. This is the honest
  label for a 1M-entry scan on a default macOS install: every scan past the
  cache size pays catalog reads, whatever the enumeration API.
* **cold** — the purge procedure ran **and exited 0** immediately before the
  measured pass. The harness will not call a run cold on any other evidence.
* **unknown** — the purge was requested and failed, or no warm-up pass ran.

Procedures the harness runs for `--cache=cold`:

| Platform | Command | Needs |
| --- | --- | --- |
| macOS | `sudo -n purge` | a cached sudo credential: run `sudo -v` in the same terminal first, then `npm run bench -- enumerate --cache=cold` |
| Linux | `sync` then `sudo -n sh -c 'echo 3 > /proc/sys/vm/drop_caches'` | the same |
| Windows | none unattended: RAMMap → Empty → Empty Standby List by hand | a cold run on Windows is recorded as `unknown` with that reason |

## Machine tiers

Results name the machine (CPU, cores, memory, OS, Node, commit) and a tier from
`docs/engine/DESIGN.md` §5.1: **A** 8+ cores and 32 GB or a Pro/Max/Ultra
part; **C** 4 cores or fewer, or 8 GB or less; **B** everything else. The
baselines committed here were taken on a Tier B Apple M3 (4P+4E, 16 GB). A
number from one tier says nothing about another; the tier is in the file name.

## Corpora

| Name | Entries | Notes |
| --- | --- | --- |
| `enum200k` | 200,000 | log-normal sizes (median 1 KiB), one flat directory of 10,000 children, 1% hard links, 0.1% sparse; fits the vnode cache |
| `enum1m` | 1,000,000 | the same shape at the prompt's full enumeration size; **cannot be warm on a default macOS install** |
| `dupes100k` | ~112,000 (≈100k files) | median 8 KiB, sizes quantised so the size-bucket stage has real work, **12% planted byte-identical duplicates**, hard-link families, sparse files; about 5 GB — one tenth of the prompt's file count and one hundredth of its bytes, and labelled so in every result |
| `images<N>` | N originals × 13 (original + 12 transforms) | synthetic photos with planted resize, re-encode at two qualities, crops of 5/10/20%, rotation, watermark, screenshot-of-image, PNG and WebP conversion, colour shift; the manifest is the labelled truth for recall and precision |

The plan behind every corpus is a pure function of its parameters and seed:
`planDigest` in the manifest is the proof, and `tests/benchCorpus.test.ts`
holds it.

## Reading a comparison

`npm run bench -- compare current.json baseline.json` prints one of:

* `PASS` — faster, or slower by less than the 10% gate;
* `FAIL` — slower by more than 10% (and more than the measurement's own
  resolution) — the CI gate;
* `INCONCLUSIVE` — the difference is inside the resolution band of the two
  measurements. That is not a pass and not a fail; it is "cannot tell at this
  resolution", and the fix is `--runs=15`, not a verdict.

## Plain words for the README

A first scan of a large drive is bound by the disk and the filesystem, not by
TreeMap: the catalog has to be read once. The headline throughput figures are
warm-cache, local-SSD numbers on a named machine, and this directory is where
they come from.
