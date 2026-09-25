# Cloud session, 25 Sep 2026 — what it did, and how to bring it home

**Read this before resuming on the Mac.** This session ran in a Claude Code
cloud container (Linux, 4 cores, Node 20 and 22, Rust 1.98.1), started from
the owner's resume prompt for the fast-scanner roadmap. The container is a
fresh clone of `origin/main` at `06fd687`; it cannot see the Mac.

## Why Phase 4 wave 1 is not here

The resume prompt's first task — commit Phase 4 wave 1 (T0, T1, T2, T3, T5,
the test-data isolation sweep), finish T2's repair pass, then carry on with
T4, T6, T7… — depends on work that exists only as **uncommitted files on the
Mac**, together with `docs/superpowers/plans/2026-09-25-phase4-wave1-status.md`,
the design with §S.9, and the "LATEST (25 Sep 2026, ~00:15 UTC)" block of
`NEXT_SESSION_PROMPT.md`. None of it was pushed, so none of it is in this
checkout. Re-implementing those tasks here would have produced a second,
unreviewed version of work already reviewed on the Mac and a merge conflict
for every file, so this session did **not** touch Phase 4's code or
`NEXT_SESSION_PROMPT.md`. Wave 1 is still the Mac's to commit, exactly as the
resume prompt says. Nothing here needs to be merged before it.

The two open questions in the Mac's LATEST block could not be read from here,
so they were not answered.

## What this session did instead (all local commits on `claude/happy-hopper-6f1ybp`, nothing pushed)

_Kept current after every commit; see the table below._

Every commit: test first (red watched), every new assertion reddened by a
recorded mutant restored byte-identical, then the Linux CI simulation green
on that exact commit before the branch moved to it. The commit messages
carry the detail.

The commits were signed after the simulations: re-creating them to add the
signatures changed every SHA and no tree. The SHAs below are the signed
ones; each was checked tree for tree against the commit that was
simulated.

| Commit | What | Evidence |
| --- | --- | --- |
| `b99f521` | fix(platform): a filesystem made on a whole Linux disk is a volume, so Missing Gigabytes can place it | 5 mutants; sim 3,020 pass / 0 fail; pt-BR 3,021 / 0 |
| `1bf6209` | fix(test): the 250k-node count test counts the pass instead of timing it | failed 573.6 ms > 400 ms at load 13.9; now counts visits; 1 mutant; sim 3,020 / 0 |
| `e745189` | fix(test): a test file that never returns costs the run one named failure, not six hours | Node 20 `assert.ok` hang reproduced; 4 mutants; sim 3,022 / 0 |
| `8ce6f5a` | fix(test): four read-only-folder tests say why they skip as root | red as root before; sim 3,022 / 0 |
| `c87520d` | fix(test): the portable tests decide in a folder they hand in, and nothing lands beside Node | 7 mutants; sim 3,024 / 0 |
| `90bccfe` | fix(ui): a recovered scan keeps the engine's reason, the budget, refused folders and expiry | 3 mutants; sim 3,025 / 0 |
| `2be50ed` | fix(autopilot): promoting Duplicates only with another rule is refused, never saved wider | 10 mutants; sim 3,038 / 0 |
| `c1ee1ba` | fix(dupes): the duplicate viewer and the near-duplicate pass never open a placeholder or a link | 33 mutants, 1 uncovered (ffmpeg); sim 3,050 / 0 |
| `ea6dee1` | fix(query): an unknown fact is never a match, negated or not | 14 mutants; sim 3,066 / 0 |
| `467cecc` | fix(query): a date nothing recorded is unknown, not a no — `-used<90d` and `used:never` matched every such file | 7 mutants, 1 equivalent; sim 3,069 / 0 |
| `4cbe4d7` | fix(thumbnails): the cache key's separators are written \0 | 2 mutants; sim 3,070 / 0 |
| `d605ea4` | fix(query): git and sync state that could not be read are unknown, never "none" | 9 mutants; sim 3,074 / 0 |
| `d3678d5` | fix(api): the published AppSettings schema describes the Time Capsule's two settings | 2 mutants; sim 3,075 / 0 |
| `d75a9af` | fix(test): the file-timeout test gives the file after the blocked one thirty seconds | 1 mutant; sim 3,075 / 0; pt-BR 3,076 / 0 |
| `22d5dc3` | fix(query): a file in a sync folder is "on this disk" only when its directory entry says so | 4 mutants; sim 3,075 / 0 |
| `466be02` | fix(dupes): an image deleted since the scan is not one nobody could vouch for | 3 mutants, run as a non-root user; sim 3,077 / 0 |
| `db0db03` | fix(autopilot): Preview judges a saved policy as Save does, one id per policy, and the spec names every refusal | 4 mutants; sim 3,079 / 0; pt-BR 3,080 / 0 |
| `fbb1e7d` | fix(test): the gdu temp-folder test watches a temp folder of its own, not the shared one | the race reproduced (3 of 6 runs red), 0 of 6 after; 1 mutant; sim 3,079 / 0 |
| `d7f98f1` | fix(query): -used:never is not warned about, is no policy alone, and a missing creation date is counted once | 5 mutants; sim 3,080 / 0 (first simulated as `aaa592d`, red only on the gdu race above); pt-BR 3,081 / 0 |

After the last code commit come five documentation commits: the Phase 5, 6,
7 and 8 plans, then this note. That puts the branch 24 commits ahead of
`06fd687`: 19 of code and tests, 5 of documents. Each commit was simulated
green on Linux before the branch moved to it. Each run of commits then ended
with a pt-BR run on its tip; the last of those was on `d7f98f1`, 3,081
passed and 0 failed.

### The code review, and why seven of these commits were rebuilt

An independent reviewer read the first eleven candidates before they landed
and ran their tests. Nothing was a blocker, and two findings were serious
enough that the branch was moved back to `90bccfe` and the rest rebuilt
with the fixes folded in (none had been pushed):
* **An Autopilot `dupe:` policy saved by an earlier build blocked every
  save** of the policy list, including deleting or switching off a
  different, approved policy, because the page re-sends the whole list. The
  refusal now applies only to a policy that is new or whose folder or query
  changed, and it names the policy.
* **`used:never` matched every file where openings are not recorded** (a
  `noatime` mount, NTFS last-access tracking off). Every reader returns a
  missing last-opened date as "not recorded", never as "never opened", so
  `used:never` is now unknown there. A query that uses it says why it
  matched nothing, and a policy that needs it to be true is refused.
  `-used:never` ("has a last-opened date") still works. A test pinned the
  old answer; it was changed on purpose, and the commit says so.

Also folded in:
* The near-duplicate pass asks the disk in chunks of 256 with the server
  let through between them, and says when it could not confirm images were
  on the disk (unavailable when it could confirm none, a count when some)
  instead of reporting "none found".
* A file in a sync folder that is on this disk is no longer blanked for
  `-cloud:placeholder`. A new `resident` field on the cloud fact is
  additive to `/api/facts`, and a resolver that throws is recorded as
  unknown for that file.
* `degraded` counts the files an unknown left out (`undecided`).
* The spec lists every refusal the policy save gives.
* The file-timeout test has a 30 s limit.

A second reviewer then read the rebuilt commits and ran their tests. It
found one major issue: a sync-folder file was called "on this disk"
whenever the placeholder reader returned nothing, which it also does when
it could not look (a failed PowerShell call, a missing path, a folder). It
also found seven minor ones. Those commits had already landed green, so the
fixes are four new commits (`22d5dc3`, `466be02`, `db0db03`, `d7f98f1`),
each test-first with its mutants. `fbb1e7d` fixes a test race the
simulation hit on the way (another test file's gdu temp folder read as a
leak), reproduced before it was fixed.

## The Linux CI simulation

The Mac's `ci-sim.sh` is not reachable from here, so the session wrote a
Linux equivalent (scratchpad, not committed): a clean worktree of the
commit, Node 20, every step of `.github/workflows/test.yml` (fmt, clippy
`-D warnings`, `cargo test --workspace --no-fail-fast`, `build:native`,
typecheck, `fetch:gdu:dev`, `npm test -- --test-reporter=tap` with its own
`TREEMAP_DATA_DIR`), the Node suite run as a **non-root user** as on CI's
runners. Every commit above was simulated before the branch moved to it.

Found while setting it up:
* Run as root, four tests failed their own guard "the fixture really is
  read-only" (root ignores a folder's mode bits) — fixed, see the commits.
* The portable-mode test "TREEMAP_DATA_DIR is left unset…" asserted nothing
  on CI and most developer machines, and created `TreeMap-Data` beside the
  Node binary wherever that folder was writable (an nvm or Homebrew Node on
  the Mac, the runner's tool cache on CI) — fixed. **On the Mac, check for
  and move to the Trash an empty `TreeMap-Data` folder beside `node`**
  (`ls "$(dirname "$(which node)")"`).

## One thing that went wrong, stated plainly

A research agent writing the Phase 5 plan looked up crate licences on
crates.io and, in one request, put the owner's email address in the
User-Agent header (crates.io asks callers for a contact there). No other
personal data was sent, and later requests used a generic string. It
cannot be recalled. Every agent since works under a written rule: no
personal detail in any web request, ever.

## Found and deliberately left for the owner or a later phase

Each was verified in the code; none is fixed here, because each is a
product decision or belongs to a planned phase.
* `/api/files/preview?thumb=1` (`makeThumbnail`) can open an online-only
  macOS file when asked to, and so download it. It refuses links. A preview
  is a person's explicit request, so whether to refuse, warn or allow it is
  the owner's call (recommended: refuse with the same "opening it would
  download it" sentence the duplicate viewer now gives).
* An Autopilot policy that used `dupe:` (or a positive `used:never`) and
  was saved before these fixes is not refused while it stays unchanged: it
  selects nothing and its runs say "Nothing matched this time". Refusing it
  would block every save of the list. Whether to flag such a policy in the
  Autopilot tab is a UI decision. The plain-words translator still produces
  `dupe:yes` / `dupe:no` and `used:never`; the query it produces then says
  in `degraded` why it matched nothing.
* The exact duplicate finder drops a size bucket whose locality check could
  not be asked (the native call threw) without saying so. The near pass now
  reports this case; the finder is rewritten in Phase 5, whose plan covers it.
* Scheduled scans force Eco for the built-in walker and gdu, but the forced
  Eco does not reach the native walk (`nativeEngine.ts`), and Autopilot and
  fleet-triggered scans are not forced to Eco at all. Written into the
  Phase 5 and Phase 8 plans.
* README "Design decisions" prints figures that `bench/` never produced,
  and says the built-in walker runs when the native module cannot load
  (on macOS and Linux gdu runs first). Written into the Phase 8 plan.

## Decisions waiting for the owner (from the Phase 5–8 plans)

Each is argued in full in its plan's "Open questions for the owner"; the
recommendation is given in brackets. None blocks the work before its phase.

Phase 5 (duplicates):
1. The file's change time in the content cache key (yes).
2. The Duplicates view's minimum size (keep 100 KB, add a 4 KB option).
3. A folder holding the last copies of a group (never refused by the
   last-copy rule).
4. A request naming every copy of a group trashes none (keep; add
   `dupe:extra` later for Autopilot).
5. Offloading every copy (allowed: each has a verified copy at the
   destination).
6. Hashing on network and FUSE mounts (no opt-in in Phase 5).
7. Gate rows that may be missed. The bytes-read row cannot beat ≈ 3.26× on
   this corpus by arithmetic (decide once the figures exist).
8. The cache cap (min(256 MiB, 1 % of the volume), and no writes below
   max(2 GiB, 5 %) free).
9. The last-copy rule's reach across every route that trashes (every route,
   with dry runs saying so).
10. Whether "hide from cleanup suggestions" binds Autopilot's query and
    custom policies (yes, as its own fix first).
11. Materialisation off for the whole process on macOS (yes, if the
    thread-scope belt fails T8).

Phase 6 (similar photos):
1. HEIC on Windows and Linux (not decodable there, counted and named).
2. An MCP `find_similar_images` tool (yes).
3. The budget for the 90 s row (Turbo, with Balanced recorded beside it).
4. Building the 200k-image corpus on the Mac (about 84 GB by
   extrapolation).
5. What `threshold` means (keep 0–32, default 10, scaled onto the tuned
   threshold).
6. Recall pooled or per transform (pooled, every transform printed).
7. Recording your library's aggregates (yes, counts and rates only).
8. `/api/files/preview?thumb=1` for a photo whose data is not on the disk
   (refuse, with the viewer's sentence). This is the item this session left
   to you.
9. The last image of a similar-photo cluster (refused server-side).
10. ImageIO and the GPU on Apple silicon (off if the counter moves; not
    proof if it stays still).

Phase 7 (deep tier, opt-in model):
1. An approximate-nearest-neighbour index, a third dependency (none: exact
   brute force over the targeted set).
2. The model where a licence blocks one (whichever of CLIP ViT-B/16 and
   DINOv2-small wins T11, DINOv2 on a tie; MobileCLIP cannot ship).
3. Only `onnxruntime-node`, not transformers.js (confirm; T2 measures the
   installers).
4. Windows and ONNX Runtime's telemetry ("not available in this version" on
   Windows in this phase).
5. Web-mode consent through the controlling terminal (accept, with AGENTS.md
   forbidding an agent to relay the code, every step audited, the code
   single-use for 5 minutes).
6. The 200k-image deep run (yes, once, after the 600-original gate).
The plan also pins the DINOv2 comparison runs to batch 1, to match CLIP's
runs; revert that if you'd rather compare at the best batch.

Phase 8 (UI, docs, CI):
1. Release targets (installers stay macOS arm64 + Windows x64; five native
   modules for web mode; an arm64 Linux runner; darwin-x64 shipped marked
   untested).
2. The cross-site request guard on every `/api` method (yes).
3. The performance gate's band and flake rate (20 clean runs; 60 to prove
   5 %).
4. The native module's integrity (keep R57 open this release; in the first
   signed release, turn on Electron's asar-integrity fuses and add a pin).
5. The scan boundary's default ("Stay on this drive").
6. Eco pausing while another app does heavy disk I/O (MP §8.1): not built
   by any plan yet; needs a per-platform disk-busy signal measured first.

## How to bring this home

The owner pushes; the agent never does. Once the owner allows this session to
push `claude/happy-hopper-6f1ybp`, fetch it in GitHub Desktop and merge it
into `main` after wave 1 is committed on the Mac. Merge rather than rebase,
then run the Mac's `ci-sim.sh` on the result.

The branch changes 45 files (`git diff --name-only 06fd687..claude/happy-hopper-6f1ybp`),
none of them a Phase 4 storage module. Wave 1 was never visible from here,
so overlap cannot be ruled out. The likeliest shared files are:
* `AGENTS.md`, `package.json` (this branch changes only the `test` script's
  `--test-timeout`), `src/api/openapi.ts` and `src/models/types.ts`, where
  both sides' additions are kept.
* `public/index.html`, which is regenerated with `node scripts/build-ui.js`
  after its parts merge, never edited by hand.
* If wave 1's test-data isolation sweep touched their headers:
  `tests/journal.test.ts`, `tests/notes.test.ts`,
  `tests/portableMode.test.ts` and `tests/storageChunked.test.ts`. This
  branch adds only a root skip reason to each, plus the portable-mode seam
  in the third.
