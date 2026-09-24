# Phase 4 S1 (`tm-store`) — six-lens review, as far as it ran (24 Sep 2026)

**Resolved 24 Sep 2026 (workflow `tm-store-s1-fixes`, run wf_1581a8ae-639):** every CONFIRMED finding below is fixed test-first, each with a mutant proven red (85 in the harness, 4 more after the fix round's own review, which confirmed 6 findings in the fixes and saw them repaired). The UNVERIFIED memory findings are S2's measurements (the plan's S2 task list); the REFUTED ones stand refuted, except that duplicate side-table rows are now refused as a by-product of the strict-order check.

The review workflow `review-tm-store-s1` (run wf_55558a5e-6e9) was interrupted when the session ended, after 93 of 99 agents. Each finding was to be judged by three skeptics; **CONFIRMED** = at least 2 of 3 said real, **REFUTED** = fewer than 2 of 3, **UNVERIFIED** = fewer than 3 votes came back (judge it yourself before acting). Lenses that reported: adversary, contract, equivalence, rust, scale, tests; lenses started: equivalence, rust, tests, contract, scale, adversary.

## CONFIRMED · high · tests: cloud_candidates can hold walk indices instead of store ids and all tests stay green
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:256
- claim: The only test of cloud_candidates (the_walk_s_placeholders_are_counted_and_its_guesses_left_to_node) uses a walk already in sorted order, so every store id equals its walk index. The mutation `cloud_candidates.push(sid)` -> `cloud_candidates.push(w)` survives: SURVIVED, 24/24 green.
- scenario: Walk: 1 `z-dataless` (dataless), 2 `a`, 3 `m-guess` (300 bytes claimed, 0 allocated). The store sorts these to a=1, m-guess=2, z-dataless=3, so the correct answer is [2,3]. The mutant emits [3,1]. Node's cloud pass would then call cloudProviderFor on `a` and flag or count the wrong node, and the real guess `m-guess` would never be decided. The JSON and the cloudFiles/sparseFiles counters diverge from ingestColumns.
- fix: Add a build test whose candidate nodes come in non-sorted walk order, for example k02 in scratch killers.rs.

## CONFIRMED · high · tests: text_candidates can hold walk indices; the only test has walk index == store id
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:316
- claim: The mutation `text_candidates.push(sid)` -> `text_candidates.push(w)` survives. In names_javascript_decides_are_listed_and_left_at_none, `café.zip` is walk index 1 and store id 1.
- scenario: Walk: 1 `zé.txt`, 2 `a`. The store gives a=1 and zé.txt=2, so the correct answer is [2]. The mutant emits [1]. Node's toLowerCase pass would give `a` an extension or container and leave `zé.txt` at none. The emitted JSON loses `extension: "txt"` on one node and gains a wrong field on another.
- fix: Put the non-ASCII dotted name before an ASCII sibling in the walk but after it in byte order.

## CONFIRMED · high · tests: Refusals looked up by store id instead of walk index survives
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:321
- claim: The mutation `refused.get(&w)` -> `refused.get(&sid)` survives. The refusal test has one vanished and one unreadable, and d1/d2 keep ids 1/2, so misattributed lookups still produce the same totals.
- scenario: Walk: v1 v2 u d a. Refusals: v1 and v2 Vanished, u Unreadable, d Denied. The store gives a=1, d=2, u=3, v1=4, v2=5. Correct: vanished 2, unreadable 1, denied [2]. Mutant: vanished 1, unreadable 1, denied [4], so the wrong folder is reported denied and a vanished folder is dropped. Node's noteRefused would record the path of v1 as a denied example.
- fix: Use a refusal fixture with unequal per-kind counts whose walk order differs from byte order (k01).

## CONFIRMED · high · tests: .git can flag the walk parent index as if it were a store id
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:280
- claim: Replacing the parent lookup `order.parent.get(id).and_then(|&p| usize::try_from(p).ok())` with `walk.parent.get(wi).map(|&p| p as usize)` survives. In a_git_folder_marks_the_folder_it_is_in, p has walk index 2 and store id 2.
- scenario: Walk: 1 `z`/, 2 `a`/, 3 `.git`/ inside z. The store gives a=1, z=2, .git=3. The correct result sets GitRepo on z (id 2). The mutant sets it on a (id 1): the wrong folder is shown as a repository and the real one is not.
- fix: Put the repository folder later in the walk than a sibling that sorts before it.

## CONFIRMED · medium · contract: No test crosses cloud candidates and placeholders with hard links; two plausible reorderings survive
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:255
- claim: The Store doc promises that the cloud post-pass reproduces the ingest (build.rs:127-135), and the code does. The order that makes it correct is untested, though. The guess must be judged on the walk's bytes before the hard-link dedup (the TS guess runs before dedup: nativeEngine.ts:315 vs 333-341). The walk's placeholder tally must use the bytes after the dedup (nativeEngine.ts:343-345 after 333-341). No build test has a hard-linked candidate or a hard-linked dataless file (tests/build.rs:344-393 has no links; 305-342 has no cloud).
- scenario: Mutant A (build.rs): move the candidate push after the dedup and require bytes > 0. A guessed later hard-link name under ~/Library/Mobile Documents (size 300, alloc 0, family shared with an earlier name) drops out of cloud_candidates. S2's Node pass never flags it: cloudFiles is 1 where the ingest says 2, and its JSON lacks cloudPlaceholder/cloudProvider. Mutant B: tally cloud_files/cloud_bytes before the dedup. A dataless later hard-link name adds its 500 bytes to cloudBytes, where the ingest adds 0. Both mutants compiled and passed all 12 tests in tests/build.rs (scratch copy, CARGO_TARGET_DIR inside it; the source was restored and diffed identical afterwards).
- fix: Add one build test with (a) a guessed family whose first and later names are both candidates, the later one with size 0 + HARDLINK_DUP and no sparse tally, and (b) a dataless family whose later name adds 1 to cloud_files and 0 to cloud_bytes.

## CONFIRMED · medium · tests: denied_dirs can hold walk indices
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:323
- claim: The mutation `counters.denied_dirs.push(sid)` -> `.push(w)` survives: d1 and d2 are walk 1,2 and store 1,2.
- scenario: Denied folder `d` at walk index 4 gets store id 2, and the mutant reports [4]. Node would build the path of store id 4 (another folder) as the denied example in deniedExamples.
- fix: The same fixture as the refusal-lookup finding.

## CONFIRMED · medium · tests: Vanished and unreadable counters can be swapped
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:324
- claim: Swapping the two match arms (Vanished -> unreadable_dirs, Unreadable -> vanished_dirs) survives, because the only fixture has exactly one of each.
- scenario: Two vanished folders and one unreadable one. Correct: vanishedDirs 2, unreadableDirs 1. Mutant: 1 and 2, and the scan stats misreport why folders are missing.
- fix: Use unequal counts per refusal kind.

## CONFIRMED · medium · tests: Cloud tally before vs after the hard-link zeroing is unpinned
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:266
- claim: Moving the `if placeholder { cloud_files += 1; cloud_bytes += bytes }` block above the family block survives. No test has a walk-flagged placeholder that is also a later hard-link name.
- scenario: Files a (100 B, family 7) and b (100 B, dataless, family 7). The ingest zeroes b's size before the cloud tally, so cloudBytes is 0. The mutant gives cloudBytes 100, double-counting bytes that hardlinkedBytes already holds.
- fix: Add a dataless later-hard-link-name case asserting cloud_bytes 0 and hardlinked_bytes 100.

## CONFIRMED · medium · tests: The `!placeholder` guard on sparse/slack is dead weight in every test
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:271
- claim: Dropping `&& !placeholder` from `if alloc_delta != 0.0 && !duplicate && !placeholder && !unallocated` survives. Every placeholder in the tests has alloc 0, so `!unallocated` already excludes it.
- scenario: A partly materialised dataless file (size 10000, alloc 4096) where blocks mean anything. The ingest skips it (it is a cloud placeholder), so sparseFiles is 0. The mutant counts sparseFiles 1 and sparseBytes 5904.
- fix: Add a dataless file with 0 < alloc < size.

## CONFIRMED · medium · tests: The `!is_root` guard on the .git rule is untested: a scanned folder named .git
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:279
- claim: The mutation `if is_dir && !is_root && name == b".git"` -> `if is_dir && name == b".git"` survives.
- scenario: The user scans /Users/me/proj/.git, so root_name is ".git". Correct: the build succeeds and the root row is DIR|HAS_CHILD_ARRAY|HIDDEN, as ingestColumns never applies the rule to the root. Mutant: build returns Malformed("node 0's parent is missing"), so the native engine would fail or fall back for a realistic scan.
- fix: Add a test with root_name ".git".

## CONFIRMED · medium · tests: A symlink's container kind is unpinned
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:314
- claim: The mutation `container.push(if kind == KIND_SYMLINK { 0 } else { container_kind(...) })` survives. No build test has a symlink whose name matches a container rule.
- scenario: A symlink `a.zip`: statToInput gives it container 'zip' (1). The mutant stores 0, so JSON `container` is missing on that node. The extension for a symlink is pinned (l.JPG), but its container kind is not.
- fix: Add a symlink named a.zip to a build test and assert container 1.

## CONFIRMED · medium · tests: The sort_children option is never exercised through build()
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:172
- claim: Passing `true` instead of `opts.sort_children` to breadth_first survives. Every build test uses sort_children: true; only finalize.rs tests the unsorted path, and they call breadth_first directly.
- scenario: On Windows (SORT_CHILDREN false), walk children b, a must keep ids b=1, a=2. The mutant sorts to a=1, b=2, so every id, the JSON order and the hard-link first-name choice change on Windows.
- fix: Add a build test with sort_children: false.

## CONFIRMED · low · contract: Doc claims contradicted by the crate's own dependencies or measurements
- votes: 2 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/derive.rs`:18
- claim: (a) derive.rs:18 says 'Exact: x − floor(x) is x's fraction, with no rounding'. That is false for x in (−0.5, 0): the difference x + 1 is rounded. The result is still Math.round's, because the true fraction there is above 0.5 and 0.5 is representable, but the stated reason is wrong. (b) column.rs:3-4 says 'Node sees either [Owned or a spill mapping] as one typed array'. RISKS R72 (measured 23 Sep 2026) says a memory-mapped spill 'cannot be exposed as typed arrays' in Electron 31, and Owned columns are copied there. (c) lib.rs:10-13 says Node runs 'passes over the few nodes the build names', and plan P4-3 says 'the candidates are rare'. Nothing measures that. On a volume listed through FindFirstFileExW (FAT32/exFAT: windows.rs:1225 `allocation: None`, then alloc 0.0 at 577-581), every non-empty file is a cloud candidate. On a macOS entry with a withheld ALLOCSIZE (darwin.rs:490-494), alloc is 0 as well. text_candidates is every file whose name has a non-ASCII byte and a dot, which on a non-English system can be most files.
- scenario: (a) −1e−300 − floor(−1e−300) evaluates to 1.0, and −0.1 − (−1) evaluates to 0.9 against an exact 0.8999999999999999944…; both were checked with exact fractions. (c) Scanning an exFAT USB drive of 1M non-empty files makes cloud_candidates 1M ids, and Node builds a path and runs the regex for each. The ingest does the same today, so this is not a regression, but the premise 'few' that P4-2/P4-3 rest on is unverified. The S5 synthetic gate, whose names are presumably ASCII with blocks allocated, will not exercise it.
- fix: (a) State the real reason: the difference is exact for x ≥ −0.5 or x ≤ −1 and rounds but stays ≥ 0.5 in (−0.5, 0). (b) Say 'in plain Node; Electron copies (R72)'. (c) Drop 'few', or say which volumes make every file a candidate, and give S2/S5 a measurement of both passes on such a tree.

## CONFIRMED · low · contract: The plan amendment leaves stale instructions beside it; one oracle count is wrong
- votes: 3 of 3 say real
- where: `docs/superpowers/plans/2026-09-18-phase4-storage.md`:114
- claim: The amendment (lines 77-81) corrects only the Rust interface and the rounding note. (1) The 'Pinned before S1' Extension bullet (line 114) still says 'Rust's `str::to_lowercase` implements the same rules; a differential test … must hold the two equal'. That contradicts the amendment (line 79) and derive.rs:48-53 ('no Rust port could agree'), and it is not struck through the way the rounding note was. (2) The tm-node fixed interface S2 will implement from (line 87) still takes `containerKinds: [string, number][]`, with no rootName/rootMtimeMs/sortChildren. StoreColumns (line 92) has no textCandidates, extOverflow or walkStats. Line 67 still describes counters as holding 'deniedDirs + examples … deniedEntries, unreadableEntries, dataless', which now live in walk_stats or are built by Node. (3) The Progress table (line 10) still says S1 'not started'. (4) tests/storeDeriveOracle.test.ts:8 says '~12,700 ASCII names'; the file has 12,535 lines, which derive.rs:188/229 state and assert.
- scenario: An S2 implementer working from the tm-node interface builds `storeBuild` with a (text, kind) pair table and no root name, sort flag or text-candidate list, then has to rediscover the amendment. A reader of the pinned bullet ports to_lowercase.
- fix: Strike or correct the pinned Extension bullet. Amend the tm-node storeBuild opts and StoreColumns (and the line-67 comment) to match what S1 built. Update the Progress row. Change '~12,700' to 12,535.

## CONFIRMED · low · rust: Four plausible defects survive the test suite (mutation run)
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/tests/build.rs`:580
- claim: Each of these one-line mutants of build.rs leaves `cargo test -p tm-store` green: (M1) dropping `.chain(refused.keys())` from the side-table range check; (M2) checking capacity with `u32::try_from(rows)` instead of `i32::try_from(rows)`; (M3) dropping `&& !placeholder` from the sparse/slack guard; (M4) dropping `!is_root` from the `.git` rule. The house rule is that every behaviour has a test a plausible defect would redden.
- scenario: M1: a refusal naming node 9 of a 1-node walk is silently ignored instead of Err(Malformed). M2: n+headroom between 2^31 and 2^32 is accepted, giving ids past Int32. M3: a dataless file with alloc 4096 < size 10000 is counted sparse (the ingest skips placeholders). M4: scanning a folder named `.git` as the root fails with Err(Malformed("node 0's parent is missing")); the unmutated code returns Ok (both measured).
- fix: Add four cheap tests: a refusal (9, Denied) on a 1-node walk gives Malformed; headroom_rows = i32::MAX as u32 on a 1-node walk gives TooManyRows (refused before any allocation); a dataless file with 0 < alloc < size, and one with alloc > size, adds no sparse or slack; root_name ".git" builds Ok.

## CONFIRMED · low · rust: Two SipHash HashMap probes per node reintroduce a cost the TypeScript ingest removed
- votes: 2 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:321
- claim: Once any refusal or hard link exists, which is typical for a home-folder scan, every node pays `refused.get(&w)` and every file pays `families.get(&w)`. The TypeScript ingest replaced exactly this Map lookup with an Int32Array because it cost 5 of 64 ms (nativeEngine.ts:280-283).
- scenario: A 5,000,000-node walk in a release build, 3 rounds: 246-263 ms with empty side tables vs 287-297 ms with one refusal and one hard link. That is about +15%, roughly 8 ns per node, and about 0.8 s at 100M nodes.
- fix: The tables are sorted by node (enforce that, per the duplicate-refusals finding). Use binary_search on the sorted slices, or a dense per-walk-index array like the ingest's linkOf.

## CONFIRMED · low · rust: js_round's comment claims x − floor(x) is always exact; it is not for x in (−0.5, 0)
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/derive.rs`:18
- claim: The comment says `Exact: x − floor(x) is x's fraction, with no rounding.` For small negative x, floor is −1 and x + 1 rounds. The result stays correct because 0.5 is representable and the true fraction is above 0.5, but the house rule says comments state only verifiable facts.
- scenario: x = −1e−20: floor = −1 and x − floor evaluates to 1.0, while the true fraction is 1 − 1e−20 (measured). js_round still returns −0, which is right.
- fix: Reword the comment: exact for x ≥ 0 and for x ≤ −0.5 (Sterbenz); for x in (−0.5, 0) the true fraction exceeds 0.5 and rounding cannot bring it below 0.5, so the comparison is still right.

## CONFIRMED · low · rust: Ambiguous intra-doc links in the crate docs (rustdoc warns 4 times)
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/lib.rs`:15
- claim: [`build`] names both a module and a function, [`derive`] both the module and the derive attribute macro, and [`column`] both the module and the column! macro. rustdoc warns that it cannot tell which item each link means, so the rendered links can point at the wrong one. CI runs clippy and test but not cargo doc, so nothing catches this.
- scenario: `cargo doc -p tm-store --no-deps` prints 4 warnings; with RUSTDOCFLAGS="-D warnings" it fails ('`derive` is both a module and an attribute macro').
- fix: Disambiguate the links, e.g. [`derive`](mod@derive), [`build`](fn@build) / (mod@build), [`column`](mod@column).

## CONFIRMED · low · equivalence: Guessed sparse and cloud bytes are added after the build's sum, so sparseBytes and cloudBytes stop matching the ingest once totals reach 2^53
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:266
- claim: The ingest keeps one running float sum in store-id order, and guessed files (size > 0, alloc == 0, not dataless) are mixed in with the walk-flagged placeholders and the ordinary sparse files. The build leaves the guesses out (build.rs:255-278). The documented S2 post-pass (build.rs:127-135) then adds `its size` to the finished Rust totals. Float addition is not associative, so the result is not the ingest's value whenever a partial sum passes 2^53 (8 PiB of claimed bytes). Nothing in the Counters contract lets S2 recover the ingest's order.
- scenario: Root with three files, sorted a, b, c; blocks meaningful; no cloud folder in the path. a has size 9007199254740992 and alloc 0 (one fully sparse file, e.g. `truncate -s 8P` on APFS/XFS/btrfs), so it is a guess. b and c each have size 1001 and alloc 1000. Ingest: 0 + 2^53 + 1 + 1 = 9007199254740992. Build: counters.sparse_bytes = 2, then the post-pass adds 2^53, giving 9007199254740994. cloudBytes goes wrong the same way when a guessed placeholder (alloc 0, path under OneDrive/Dropbox/iCloud) is mixed with dataless files of that size. The integer counters, every column and every flag still match.
- fix: Have S2 compute sparseBytes and cloudBytes in store-id order: the build returns the per-node contributions (or a sorted list of (id, delta) for sparse and cloud), and Node sums them in id order after deciding the guesses. Or state and test the limit (exact only while totals are below 2^53) in the Counters/cloud_candidates docs and the plan's equivalence claim.

## CONFIRMED · low · tests: ext_overflow can be keyed by walk index
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:311
- claim: The mutation `interner.intern(raw, sid)` -> `interner.intern(raw, w)` survives. The overflow test's names f000000.. and g.. are generated in sorted order, so walk index == store id.
- scenario: With 65,534 extensions filling the dictionary, walk-first `zz.over1` sorts last. Correct: ext_overflow ids point at the rows holding EXT_OVERFLOW. Mutant: (1, "over1") points at f000000.e000000, so extension() returns the wrong text for two nodes.
- fix: Add an overflowing name whose walk position differs from its sorted position.

## CONFIRMED · low · tests: The .git name match is not pinned as case-sensitive
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:279
- claim: The mutation `name == b".git"` -> `name.eq_ignore_ascii_case(b".git")` survives.
- scenario: A folder `.GIT` (possible on a case-insensitive APFS volume): the ingest's `name === '.git'` does not mark the parent, but the mutant does, so GitRepo is set and the JSON differs.
- fix: Add a `.GIT` folder case asserting no GIT_REPO.

## CONFIRMED · low · tests: Side-table range check off by one survives
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:179
- claim: The mutation `*node as usize >= n` -> `> n` survives. The only test names node 7 of 2.
- scenario: hardlinks [(2, 1)] with n=2 is accepted by the mutant and silently ignored, although the build's contract refuses a side table naming a node that is not there.
- fix: Test node == n exactly.

## CONFIRMED · low · tests: The refusal table's range check is untested
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:178
- claim: The mutation `families.keys().chain(refused.keys())` -> `families.keys()` survives. Only an out-of-range hard-link ref is tested.
- scenario: refusals [(7, Denied)] with n=2: the mutant builds Ok and drops the refusal instead of returning Malformed.
- fix: Add an out-of-range refusal case.

## CONFIRMED · low · tests: The atime column's headroom is unpinned
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:298
- claim: The mutation `Vec::with_capacity(reserve(n))` -> `Vec::new()` for the lazily created atime column survives. The column-capacity loop in every_column_has_a_row_per_node_and_room_for_the_headroom skips atime, because atime is None there.
- scenario: A scan where any node has an atime: the atime column's capacity is about n (Vec doubling), not n + headroom. The documented 'room for capacity' (build.rs:88-89) breaks for that column, so S2's adoption or a post-finalize addNode needs a reallocation.
- fix: Assert atime capacity >= store.capacity in a test with an atime.

## CONFIRMED · low · tests: TooManyRows is never tested
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:163
- claim: The mutation `i32::try_from(rows)` -> `u32::try_from(rows)` survives: rows between 2^31 and 2^32-1 are no longer refused. No test reaches any TooManyRows path.
- scenario: headroom_rows = i32::MAX with n=1 gives rows 2^31. Correct: Err(TooManyRows{rows: 2147483648}) before any allocation. Mutant: tries to allocate columns of 2^31 rows, beyond the store's signed 32-bit ids.
- fix: Add a test with headroom_rows = i32::MAX as u32.

## CONFIRMED · low · tests: An over-long atime_ms column is accepted without the length check
- votes: 2 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:387
- claim: Deleting the ("atime_ms", ...) entry from check_lengths survives. Only a short mtime and a long size are tested; a short column is caught later by column_at, but a long one is not.
- scenario: atime_ms with n+1 rows: the mutant builds Ok, although the walk broke its promise.
- fix: Test a long column for each of the six.

## CONFIRMED · low · tests: An over-long alloc_bytes column is accepted without the length check
- votes: 2 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:385
- claim: Deleting the ("alloc_bytes", ...) entry from check_lengths survives, for the same reason as atime_ms.
- scenario: alloc_bytes with n+1 rows: the mutant builds Ok instead of returning Malformed.
- fix: Loop the long-column case over every column.

## CONFIRMED · low · adversary: Split sparse/cloud byte tallies cannot reproduce Node's float sums once they pass 2^53
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:271
- claim: The build leaves out every guess (a file claiming bytes with none allocated) from sparse_bytes, and S2 is designed to add those sizes afterwards, in ascending candidate order. The Node ingest adds them in breadth-first order, mixed in with the other sparse deltas. Floating-point addition is not associative, so the two totals differ once a partial sum passes 2^53. Every realistic total below 2^53 is exact, because all the terms are integers. cloudBytes has the same problem: the build counts the dataless placeholders, and Node adds the guessed placeholders later.
- scenario: Walk: root dir 'r' with three files: a.img (size 4196, alloc 4096), b.img (size 2^60, alloc 0, no cloud provider for its path) and c.img (size 4196, alloc 4096). Blocks are meaningful and children are sorted. Node ingestColumns gives sparseBytes = (100 + 2^60) + 100 = 2^60 (bits 43b0000000000000). The build gives sparse_bytes = 100 + 100 = 200. The designed S2 pass then adds 2^60, which gives 2^60 + 256 (bits 43b0000000000001). APFS allows sparse files this large.
- fix: Either state the bound in the Counters doc and in S2's equality test (identical only while running totals stay below 2^53), or have the build emit what Node needs to add the terms in the ingest's order (for example the per-node sparse and cloud deltas in id order), so the total is computed in one pass after the guesses are decided.

## CONFIRMED · low · adversary: js_round's comment says the fraction is always exact, which is false for x in (-0.5, 0)
- votes: 3 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/derive.rs`:18
- claim: The comment says 'Exact: x − floor(x) is x's fraction, with no rounding.' For x in (-0.5, 0), floor is -1 and x + 1 can round. For example, -1e-300 - (-1.0) evaluates to exactly 1.0, while the true fraction is 1 - 1e-300. The result of js_round is still correct, because the rounded fraction is still at least 0.5 (so -0 is returned). The comment itself is not a verifiable fact, which breaks the house rule for comments.
- scenario: x = -1e-300. The comment says x - floor(x) is exact, but it evaluates to 1.0 and not the true fraction. Checked in Node 24.16: `(-1e-300) - Math.floor(-1e-300) === 1` is true, and Rust f64 subtraction gives the same result. js_round(-1e-300) still returns -0, matching Math.round.
- fix: Reword it along these lines: 'x − floor(x) is exact except for x in (−0.5, 0), where it can round up to 1.0; there the fraction is above a half either way, so the comparison is unaffected.'

## UNVERIFIED · high · scale: build() holds the whole WalkOutput until it returns and allocates every store column new, so it adds more than the store's own size to peak RSS (733 MB at 5M, over the 700 MB gate before Node is even loaded)
- votes: 0 of 2 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:147
- claim: Every walk column (42+L B/node; measured 56.8–63.7 B/node) stays alive until build returns. The loop at 206–342 reads them by walk_index. walk.parent is never read after breadth_first (line 173), and walk_index is also held to the end. Every store column is a new Vec whose capacity is n + headroom (186–195, 350), so each one is strictly larger than the walk's columns, which are exactly n long (tm-walk walk.rs:916–923). breadth_first's 12 B/node of scratch (start, cursor = start.clone(), kids; finalize.rs:66–83) is freed before the loop. On macOS 27, a freed large block stays resident and is reused only by a request no larger than itself. So nothing the walk or breadth_first frees can hold a store column, and the process sits at about the walk plus the store plus the transients. The heap peak is 92+2L B/node plus hash tables plus headroom. Measured: 129–142 B/node, against a finished store of 62–68 B/node.
- scenario: A synthetic WalkOutput of 5,000,000 nodes, 20-byte names, 709,999 hard-link refs, built with headroom 50,000. The heap peak of build() is 706 MB (141 B/node). The process maxRSS goes from 324 MB to 733 MB, and after build returns, with only the 336 MB store live, RSS is still 696 MB. A real tm-walk of /Library (1,519,189 nodes, mean name 18.6 B, 254,005 hard-link refs) raises maxRSS from 372 to 443 MB during build(), 47 B/node above the walk's own peak. The phase gate (plan line 151) is 700 MB in total for 5M in memory mode. This bare Rust process is already past it before Node's baseline (120 MB budgeted in DESIGN §7) and before the walk's real peak.
- fix: (1) The build owns the WalkOutput, so permute size, mtime_ms and atime_ms in place (cycle-following, n-bit visited bitmap) and reuse those allocations as the store's columns. Better still, have tm-walk's merge allocate its columns with the headroom already in the capacity, so no reserve (realloc) is needed afterwards. (2) std::mem::take and release walk.parent right after breadth_first. Gather names first and release walk.names and walk.name_off, then read each node's name from the store's pool. Release kind, flags, alloc_bytes, hardlinks and refusals after the flags pass, and walk_index after the last gather. (3) Pass the headroom into breadth_first so parent, child_start and child_cnt are allocated at their final size (this removes the three reserve_exact reallocs at 344–349). Drop the cursor copy by scattering into start and reading ranges as start[p-1]..start[p]. (4) Allocate cloud_prov as vec![0u8; n + headroom] and truncate it, instead of resize, which writes n bytes (line 351). Test first: an integration test binary with a counting global allocator asserts that the build's peak live bytes on a 100k-node walk stay below walk bytes + store bytes − 24 B/node. A mutant that allocates the f64 columns new turns it red.
- skeptics: The code facts in the claim are accurate. The conclusions drawn from them are not, and nothing in it is a wrong output.

What checks out on reading:
- build() takes `walk: WalkOutput` by value and drops no field early. `walk.stats` is moved out at the very end (native/treemap-core/crates/tm-store/sr / The claim does not hold as a defect. The code facts are right, but the conclusion is not. build() takes `walk: WalkOutput` by value (build.rs:147), so the walk columns live until it returns. It also allocates fresh Vecs sized n+headroom (build.rs:186-195, 350-351) and reserve_exact()s the parent, ch

## UNVERIFIED · high · scale: On this Mac, freed Vec memory never leaves RSS, so the gate's maxRSS is the sum of every large allocation along walk → build → hand-over; the 5M memory gate needs mmap-backed columns, not only a leaner build
- votes: 0 of 1 say real
- where: `native/treemap-core/crates/tm-store/src/column.rs`:6
- claim: Column::Owned(Vec<T>) and tm-walk's Vec columns use the system allocator. On macOS 27.0 (26A428) it keeps freed large blocks resident and counts them in both RSS and phys_footprint. Only requests of equal or smaller size reuse them, and munmap is the only thing that returns them. The phase's measure is peak RSS (P4-10, plan line 41; resourceUsage().maxRSS, line 121). So every transient the pipeline ever held stays counted: the walk's parts, the merge, breadth_first's scratch, the released WalkOutput, and in Electron the V8 copies made by a different allocator (RISKS R72). A leaner build lowers the heap peak but not the gate number unless its columns sit in their own mappings.
- scenario: (a) Six 40 MB Vecs touched, then dropped: RSS stays at 231 MB, and still 231 MB after 8 s idle. Six new 39.6 MB Vecs reuse the space (231 MB), while six 40.4 MB ones, the 1% headroom case, add 229 MB (307 → 536 MB). (b) 12×40 MB plus 3×400 MB dropped leaves 1,604 MB, and malloc_zone_pressure_relief(NULL, 0) frees 0. (c) Six 40 MB anonymous mmaps, touched then munmapped: 231 → 2 MB. Consequences: tm-walk alone peaks at 372–396 MB maxRSS on /Library (245–261 B/node, up from 195 B/node at 0.47M nodes), which is about 1.2–1.3 GB at 5M before build() runs. After build, the process holds about 2.07× the store (696 MB RSS for 336 MB live). In Electron the column copies cannot reuse those blocks, so the hand-over adds the store's 62–68 B/node, about +330 MB at 5M. Measured on real trees, the store is 62.2–68.0 B/node, because atime is always on (wantAtime: true at src/services/scan/nativeEngine.ts:500) and mean names are 13.1–20.9 B. That is above the plan's expected ~49.7 B/node (plan line 125) and DESIGN §7's 37.5.
- fix: Before S2: give Column an owned anonymous-mapping kind for memory mode (the Mapped variant S3 needs anyway, with MAP_ANON). Have the walk's merged columns and the store's columns allocated that way, so a column released mid-build leaves RSS at once. Then a column-at-a-time build gets its heap figure (~100 B/node) as its RSS peak and keeps only the store afterwards. S2 must measure maxRSS at 5M through walk + build + hand-over inside Electron before accepting the copy path, because the current numbers already exceed 700 MB in a bare Rust process.
- skeptics: The claim does not hold up as a defect in tm-store. It does not change emitted JSON, counters or any test outcome.

1. Nothing in S1 measures memory. native/treemap-core/crates/tm-store/src/column.rs:6-9 is a one-variant enum, `Column::Owned(Vec<T>)`. Its doc comment (line 3) already says the spill 

## UNVERIFIED · low · scale: Hash tables copy side tables that are already sorted, and hash every node and file
- votes: 0 of 0 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:176
- claim: families: HashMap<u32,u32> (176) and refused: HashMap<u32,Refusal> (177) are copies of walk.hardlinks and walk.refusals, and both of those are already sorted by node (tm-walk output.rs:120–122, links.rs:81, walk.rs:996). seen_families: HashSet<u32> (197, 259) tracks family numbers that are dense from 0 (links.rs:59–79). Whenever a table is non-empty, every file (249) and every node (321) goes through SipHash.
- scenario: /Library: 254,005 hard-link refs in 61,843 families. By hashbrown's bucket rule, the map is 524,288 × 9 B = 4.7 MB and the set 131,072 × 5 B = 0.66 MB (plus the old table while it grows), about 3.5 B/node. At the same ratios that is about 11 MB at 5M and about 344 MB at 100M (86% of the aggregate ceiling). A binary search over the existing vectors plus a family-indexed Vec<bool> costs 61,843 bytes (or 7.7 KB as a bitset).
- fix: Use binary_search_by_key on the two sorted slices, and check once, in O(h), that nodes strictly increase, so a malformed walk is still refused. Replace seen_families with a Vec<bool> or bitset sized to max family + 1. Test first: a walk whose hardlinks are out of node order is refused with Malformed.

## UNVERIFIED · low · scale: Past the 65,534-entry dictionary, the extension interner makes a new heap String for every node, even when the text repeats
- votes: 0 of 0 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:433
- claim: intern() turns the lower-cased bytes into a new String on every lookup miss (433). Past the limit, lookup never grows (434–443), so every node whose extension is not in the dictionary gets its own 32-byte (u32, String) entry plus a separate heap block, even when many nodes share the same text. The per-node mapping is required, because TypeScript keeps extOverflow as a Map<number,string> per node (src/services/scanStore.ts:763, 860). The per-node allocation of the text is not.
- scenario: A 5M-node synthetic with 100,000 distinct extensions gives 973,299 overflow entries and grows the store's heap from 335.5 to 376.9 MB (+41 MB, counted in requested bytes; the allocator's 16-byte minimum adds more). Trees where the text after the last dot varies per file hit this case, for example rotated logs such as app.log.123456.
- fix: Intern overflow texts in a second table (text → u32 index into one pooled buffer) and keep ext_overflow as (id, u32) pairs, 8 B per node. S2 turns them into JavaScript strings once per distinct text. Test first: 70,000 distinct extensions, each repeated on two files, keep the per-id extension() answers and store each overflow text once.

## REFUTED · high · scale: 100M: no post-pass over a WalkOutput can meet the spill (1.5 GB) or aggregate (400 MB) ceiling; S3/S4 must be fed during the walk
- votes: 0 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:147
- claim: build(walk: WalkOutput, opts), with StoreMode in BuildOptions (lines 24–32, 148–150), implies that spill and aggregate will later be built from a finished WalkOutput. At 100M nodes the input alone is far past both ceilings. WalkOutput is 62.4 B/node measured, about 6.2 GB. The build's heap peak is about 140 B/node, about 14 GB, and this Mac has 16 GB. The four Order vectors are 16 B/node, 1.6 GB, which is already above the whole 1.5 GB spill ceiling, and breadth_first needs 12 B/node more scratch (1.2 GB). The finished store is about 66 B/node, 6.6 GB. The spill ceiling allows 15 B/node for the whole process and the aggregate ceiling 4 B/node, and walk.parent alone is 4 B/node. The walk itself peaks at 245–261 B/node measured, about 25 GB at 100M. P4-4's 'a walk that crosses the threshold continues and converts at the end' has therefore already paid that peak by the time it converts. DESIGN §6.1 describes spill as 'written sequentially with write() during the walk' and aggregate as running totals. The S1 interface diverges from both.
- scenario: synthetic100m (S5, plan line 150) routed as walk → WalkOutput → build(mode: Spill or Aggregate). Before build() is even entered, the process holds more than 6 GB of walk columns, so spill ≤ 1.5 GB and aggregate ≤ 400 MB cannot pass whatever build() does. A second limit: name offsets are u32 (StoreError::NamesTooLong, lib.rs:71–76; the same 4 GiB check in tm-walk's merge). At 100M that allows a mean name of at most 42.9 B. The means measured here are 13.1–20.9 B, so the synthetic generator must stay under that limit.
- fix: Write down, before S3's first test, that build(WalkOutput) is memory-mode only (take Spill and Aggregate out of this entry point). For spill, the walk streams its columns to files as it goes, and the breadth-first renumbering is done out of core (sequential passes over the files, with the permutation in bounded segments), never as n-sized u32 arrays resident together. Aggregate is accumulated inside the walk: per-directory totals when a listing completes, and bounded top-64/top-10,000 heaps, with no per-node array.
- skeptics: The claim is refuted as a tm-store S1 defect. Nothing in the S1 code produces a wrong output, and the claim describes no input that does.

1. The code does not build Spill or Aggregate. build.rs:148-150 returns `StoreError::ModeNotBuilt(opts.mode)` for any mode other than Memory, before it touches t / Refuted as a defect in tm-store S1. I checked it against the question I was given: would it change emitted JSON, the counters or a test outcome? It would not.

1. S1 builds nothing for spill or aggregate. At native/treemap-core/crates/tm-store/src/build.rs:148-150, build() returns StoreError::ModeNo / This is a concern about how S3, S4 and S5 are planned. Nothing in the tm-store code under review can reach it.

1. **Spill and Aggregate are refused before any work is done.** `build()` returns `StoreError::ModeNotBuilt` for any mode other than Memory (native/treemap-core/crates/tm-store/src/build.r

## REFUTED · medium · contract: The headroom exists only as uninitialised spare Vec capacity, and the napi handover S2 will use throws it away
- votes: 1 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:186
- claim: Every column has len = n. Its headroom is Vec spare capacity (build.rs:186-195 with_capacity(reserve(n)), 344-351 reserve_exact), and the test locks that shape (tests/build.rs:194-208: len == n, capacity() >= capacity). Three things mean those rows can never reach PackedScanStore as built. (1) napi 3.4's `TypedArray::new(vec)` calls `data.shrink_to_fit()` first (~/.cargo/registry/src/*/napi-3.4.0/src/bindgen_runtime/js_values/arraybuffer.rs:556-565), and the JS typed array is created with `val.length` (arraybuffer.rs:729-731, 772-775). tm-node already hands columns over with exactly this call (tm-node/src/lib.rs:531-543). (2) Electron's copy fallback (R72) copies only `length` bytes (arraybuffer.rs:753-764). (3) The plan's S2 step, 'the views' lengths are `n`, the buffers `capacity`' (plan line 124), would need the spare region inside the ArrayBuffer, and that region is uninitialised memory. PackedScanStore grows only when `this.n === this.cap` (scanStore.ts:871), and it indexes its typed arrays without any length check. appendName compares against `this.nameBytes.length` (scanStore.ts:825-832).
- scenario: Case 1: S2 follows the house pattern `Float64Array::new(store.size.into_vec())` on a 100M-row store. shrink_to_fit drops the 1% headroom and JS sees length n, so cap = n. The first watcher event or container expansion runs grow() (scanStore.ts:794-821), which doubles and copies every column into JS memory. appendName's first post-build name doubles and copies the whole names pool (about 2 GB at 20 B/name). That is the copy P4-6 says the headroom prevents. Case 2: S2 sets cap = Store.capacity over views of length n. writeNode(id = n) writes parentArr[n], sizeArr[n] and nameOff[n+1] into length-n typed arrays, and JavaScript silently drops those writes. path(n) then reads parentArr[n] === undefined, and its `cur !== rootId` loop never ends (scanStore.ts:1072). The atime column's headroom is not tested either: mutating build.rs:298 to `Vec::with_capacity(n)` passes all 12 build tests (run in a scratch copy).
- fix: Make the headroom rows real. Build every column with len = capacity (rows n..capacity zeroed, name_off to capacity+1, names zero-padded to name bytes + headroom×64) and keep n and name_off[n] as the logical lengths. Test that the lengths survive `into_vec()` + shrink_to_fit, and pin the atime column too. Alternatively, document on Column and Store that S2 must `resize(capacity, 0)` before `TypedArray::new`, and correct the plan's 'views n, buffers capacity' step to match.
- skeptics: Most of the claim is refuted. One small part holds: the atime column's headroom has no test. That is a low-severity test gap.

What does not hold (the medium claim that S1's column shape is a defect):
- **S1 builds the shape the plan asks for.** The plan's S1 build test says "every column length `n` / Refuted: no real walk or real Node flow can reach this today. The only true part is a small test gap.

1. Nothing consumes tm-store yet. No crate or manifest outside crates/tm-store names tm_store or tm-store. tm-node does not depend on it. The plan's progress table lists S2 (`PackedScanStore.fromCo / The claim does not hold as a tm-store defect. Nothing it describes changes emitted JSON, the counters, or any test outcome today.

1. S1 is built the way the plan specifies. The plan's S1 test line asks for "every column length `n`, `capacity = n + headroom`" (docs/superpowers/plans/2026-09-18-phase

## REFUTED · medium · rust: A node whose parent is not a folder is accepted and kept; the ingest drops it
- votes: 1 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/finalize.rs`:67
- claim: breadth_first builds a child range for every parent whatever its kind, and build only checks that the root is a folder. So a malformed walk where a file or symlink has children produces a store the ingest would never build. The ingest (nativeEngine.ts:295-359) only visits children of nodes it has queued, and it queues only folders (line 359), so it drops those nodes and their subtrees. build.rs:279-287 also sets GIT_REPO on a file when a `.git` folder hangs under it.
- scenario: Walk: [0 dir `r`; 1 file `f.zip` (parent 0); 2 file `g` (parent 1); 3 dir `.git` (parent 1)]. Rust (measured in a scratch copy): Ok, n=4, counters.files=2, dirs=2, child_cnt=[1,2,0,0], flags[f.zip]=GIT_REPO (64). Ingest: 2 rows, fileCount=1, dirCount=1, no gitRepo. Effects: the pruned JSON gains `"gitRepo":true` on a file (scanStore.ts:231). Expanding the zip throws 'ingestSubtree: parent already has children' because childCount(f.zip) is 2 (scanStore.ts:1343-1345). This input can arrive from outside: the MFT columns file sits in a user-writable folder, and tm-mft's check_shape (crates/tm-mft/src/columns.rs:216-288) checks parent order but not parent kind.
- fix: Refuse it as Malformed: for every non-root node, require walk.kind[parent] == KIND_DIR. Either pass `kind` into breadth_first and check it in the counting loop, or check it in build's loop through order.parent/walk_index. Add a test with a file that has a child.
- skeptics: I could not refute it. The claim holds when I read both implementations and when I ran it.

**Rust accepts the walk.**
- finalize.rs:67-93 counts and scatters children for every parent `p` without checking its kind.
- The BFS loop at finalize.rs:100-125 gives every node a child range, files included / The mechanism is described correctly, but no real walk and no current Node flow can reach it.

**What holds.** `breadth_first` (tm-store/src/finalize.rs:67-93) gives any parent a child range without checking its kind. `build` checks kind only at the root (build.rs:212-213). The `.git` rule sets GIT_ / The mechanism is accurate, but the input can never reach tm-store, so it changes no emitted JSON, no counters and no test outcome.

**Mechanism (confirmed).** I reproduced it in a scratch copy, adding a test to crates/tm-store/tests/build.rs. The walk was `[dir r; file f.zip (0); file g (1); dir .gi

## REFUTED · low · rust: Duplicate refusal entries for one node are collapsed; the ingest counts every entry
- votes: 0 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:177
- claim: Refusals are collected into a HashMap<u32, Refusal>, so a second entry for the same node silently replaces the first. The ingest loops over every refusal entry, and also uses their count in walkedDirs = dirsListed + refusalNode.length. Duplicate hard-link entries are also accepted without complaint. Last-wins happens to match the ingest's linkOf there, but nothing refuses them.
- scenario: refusals [(1,Vanished),(1,Vanished)] gives Rust vanished_dirs=1; the ingest gives vanishedDirs=2. refusals [(1,Denied),(1,Vanished)] gives Rust vanished_dirs=1 and denied_dirs=[]; the ingest gives deniedDirs=1 and vanishedDirs=1 (both measured on the Rust side in a scratch copy). tm-mft's check_shape lets duplicates through: its `sorted` uses `<=` (columns.rs:270).
- fix: The walk promises side tables sorted by node, one entry per node. Refuse any table that is not strictly ascending by node as Malformed, and test it. That also lets the HashMaps be replaced (see the lookup-cost finding).
- skeptics: The claim's mechanics are correct, but the input it needs is one no producer emits, so it is not a real defect.

What checks out:
- build.rs:176-177 collects `walk.refusals` into a `HashMap<u32, Refusal>`, so a later entry for the same node wins.
- build.rs:321-327 counts each node once, when the bu / The claim is right about the mechanics, but no input that can actually reach the build triggers it. build.rs:176-177 collects refusals into a HashMap<u32, Refusal>, and nativeEngine.ts:366-376 counts each entry, including refusalNode.length in walkedDirs. So a table holding the same node twice would / Not reachable from a real walk. The HashMap collapse at tm-store/src/build.rs:176-177 is real as code, but every producer emits at most one refusal per node:
(1) tm-walk mints each id once (take_id, a checked atomic increment, walk.rs:714-718) and queues each directory job once: the root at walk.rs:

## REFUTED · low · rust: headroom_rows is bounded only by the i32 row count; up-front reservations are unbounded and can abort
- votes: 0 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:195
- claim: capacity checks only that n + headroom <= i32::MAX. The build then reserves (n+headroom) rows in every column, plus headroom × 64 name bytes, with Vec::with_capacity. A failed allocation aborts the process (handle_alloc_error) instead of returning StoreError. The names reservation is also never clamped to what the u32 offsets can address, so everything past u32::MAX bytes is unusable.
- scenario: A 1-node walk with headroom_rows = 2_000_000_000 (valid by the i32 check). Measured on this Mac: Ok, size capacity 2,000,000,001 rows (16 GB per f64 column) and names capacity 128,000,000,002 bytes, all granted lazily. On an allocator that refuses a request larger than RAM plus swap, the same call aborts the scanning process instead of failing the build. Node is meant to pass 1% (min 1,024) under P4-6, so this needs a caller bug, such as a unit mix-up in S2.
- fix: Clamp the names reservation to u32::MAX minus the bytes used. Use try_reserve / try_with_capacity and map failure to a StoreError. Optionally refuse a headroom far above P4-6's rule.
- skeptics: The reviewer read the code correctly, but what they describe is not a defect in S1. It is an optional hardening idea that only matters if a caller breaks the spec.

What the code does (confirmed in native/treemap-core/crates/tm-store/src/build.rs):
- Lines 161-165 check only that n + headroom fits a / The code does what the claim describes, but no real walk or real Node flow can reach the failure.

1. The mechanics are accurate. build.rs:161-165 checks only that n + headroom_rows fits i32. build.rs:186-195 then calls Vec::with_capacity(n + headroom) for each column, and reserves name_bytes + head / The facts in the claim are accurate, but they do not change emitted JSON, counters or any test outcome.

What is accurate: build.rs:162-166 checks only that n + headroom_rows fits i32. The columns are then reserved with that capacity (build.rs:186-195, 345-350). The names buffer is reserved as name_

## REFUTED · low · equivalence: build() accepts two malformed walk shapes that the ingest handles differently instead of refusing them
- votes: 0 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:177
- claim: StoreError::Malformed says the build refuses a walk that breaks the walk's promises, but two broken shapes pass through and produce a store the ingest would not. (1) A node whose parent is a file or symlink: the ingest only queues folders (nativeEngine.ts:359), so that subtree is never added or counted. finalize.rs:103-126 numbers every node's children whatever its kind, so the build keeps them: a file gets child_cnt > 0 without HAS_CHILD_ARRAY, and n, fileCount and dirCount grow. (2) The same refusal node listed twice: the ingest counts every row (nativeEngine.ts:368-374), while the HashMap at build.rs:177 keeps one.
- scenario: (1) Walk: 0 root (dir), 1 file "f" (parent 0), 2 file "g" (parent 1). Ingest: n = 2, fileCount = 1. Build: n = 3, files = 2, child_cnt[1] = 1. (2) refusals = [(3, Denied), (3, Denied)]: ingest deniedDirs = 2, build denied_dirs = [id] (1).
- fix: In check_lengths or breadth_first, refuse with Malformed a node whose parent's kind is not KIND_DIR, and refusal (and hard-link) rows whose node numbers are not strictly increasing. Add a test for each.
- skeptics: The mechanics the reviewer describes are accurate. The problem is that no input that can actually reach build() has either shape, and the suggested fix would not make the build agree with the ingest anyway.

1. **What the code does.** breadth_first (finalize.rs:95-126) counts children under any earl / The mechanics are described correctly, but neither shape can come from a real walk or the real Node flow.

1. **What the build does is described correctly.** `finalize.rs` `breadth_first` gives every node its children, whatever its kind. `build.rs` keeps every refusal in a HashMap (line 177), so a n / I refute this claim. The reviewer describes the code correctly, but no real input ever takes either path. So neither shape can change emitted JSON, counters or any test outcome.

1. What the code does, which I checked:
   - `breadth_first` (tm-store/src/finalize.rs:79-126) numbers the children of an

## REFUTED · low · adversary: Duplicate refusal rows for one folder are merged by the build and counted separately by Node
- votes: 0 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/build.rs`:177
- claim: The build turns walk.refusals into a HashMap keyed by node, so a later row for the same node overwrites the earlier one and each node counts at most once. Node counts every row, in deniedDirs, vanishedDirs or unreadableDirs, and in walkedDirs = dirsListed + refusalNode.length. The build refuses other broken walk promises as Malformed but accepts this one without error. tm-mft's check_shape also lets it through, because its sorted check uses <=.
- scenario: Walk: root 'r' and a dir 'x' (node 1), with refusals [(1, Denied), (1, Vanished)]. Node gives deniedDirs = 1 and vanishedDirs = 1. The build gives denied_dirs = [] and vanished_dirs = 1, so deniedDirs is lost, and S2's walkedDirs would also come out one lower. I confirmed both outputs with the harness.
- fix: Treat a repeated refusal node as StoreError::Malformed. walk.refusals is documented as sorted by node, so checking that the nodes strictly increase is enough. The alternative is to count per row, as Node does.
- skeptics: I read both implementations. The mechanics the reviewer describes are accurate, but the input their scenario needs cannot occur.

What is true:
- build.rs:177 collects walk.refusals into a HashMap<u32, Refusal>. If a node appeared twice, the last row would win.
- build.rs:321-327 counts one refusal  / The mechanics in the claim are accurate. build.rs:177 collects walk.refusals into a HashMap<u32, Refusal>, and build.rs:321-327 counts one refusal per node. But no real walk can reach that code with a repeated node, so this is not a defect in tm-store's job of matching the Node ingest for a real Wal / The code reading is correct but nothing reaches the output. build.rs:177 does collapse refusal rows into a HashMap, and nativeEngine.ts:366-376 does count every row. Those only disagree when one node has two refusal rows, and neither producer can emit that.

(1) tm-walk pushes a refusal in two place

## REFUTED · low · adversary: A node whose parent is not a folder is kept by the build and dropped by the Node ingest
- votes: 1 of 3 say real
- where: `native/treemap-core/crates/tm-store/src/finalize.rs`:84
- claim: breadth_first places every node under its parent, whatever the parent's kind, and build counts that node. Node's ingest only queues folders, so the children of a file or symlink are never visited. They get no row, and dirCount and fileCount do not include them. The build checks that each parent comes before its child, but not that the parent is a folder.
- scenario: Walk: root 'r'; node 1 is file 'f' (size 1) with parent 0; node 2 is file 'g' (size 2) with parent 1. Node gives 2 rows and fileCount 1, with child_cnt of 'f' = 0. The build gives 3 rows, 'g' at id 2 with parent 1, child_cnt of 'f' = 1 and files = 2. I confirmed both outputs with the harness.
- fix: In build, refuse as Malformed any non-root node whose parent's walk kind is not KIND_DIR. The kind column is already read per node, so the check can go next to the root-is-a-folder check.
- skeptics: The claim's premise is true: `breadth_first` (finalize.rs:64-126) places a child under any parent, and build.rs checks only that the root is a folder (build.rs:209-213). But neither real walker can produce the walk that exposes it, and the claim says so itself.

- tm-walk: a node gets children only  / The claim is refuted. The mechanism it describes is accurate, but no input that can actually reach the build triggers it, so the emitted JSON, the counters and every test outcome stay the same.

What the claim gets right:
- `breadth_first` (tm-store/src/finalize.rs:64-126) places every node under it / I could not refute the claim. Both implementations behave as described, and a probe run confirmed the Rust half.

**Rust keeps the node.**
- `breadth_first` (crates/tm-store/src/finalize.rs:64-93) counts and scatters every child under its parent. The only check is `p < i`; the parent's kind is never

## What each lens covered

- **contract**: I compared every rule of build.rs, derive.rs and finalize.rs line by line against ingestColumns, statToInput, detectContainerKind, PackedScanStore (writeNode, internExt, appendName, grow, finalize, setAccessedAt, setModifiedAt, setFlag, accessedAt, extension, path, toFileNode), rootName, the diskScanner root row, noteRefused/keepSmallest, resetCounters and tm-walk's output, platform alloc and refusal recording. I also checked the napi-3.4.0 typed-array source and R72.

What checks out:
- Node can reproduce every ingest counter from the Store. dirs, files, the hardlink/cloud/sparse/slack tallies (all zero-initialised by resetCounters, so no undefined-vs-0 gap) and vanished/unreadable come from Counters. scanned is n; deniedEntries, unreadableEntries and placeholdersSkipped come from walk_stats. walkedDirs = dirs_listed + denied_dirs.len() + vanished + unreadable; this holds because tm-walk emits at most one refusal per directory and never refuses the root in the table. deniedExamples comes from store.path(id), which equals columnPathOf(i), and keepSmallest is order-independent, so store-id order is fine.
- The cloud post-pass contract reproduces the ingest exactly, a hard-link duplicate included (store size is 0, so cloudBytes += 0, and HARDLINK_DUP blocks the sparse tally). Only the tests are missing for it.
- The atime column and HAS_ACCESSED agree with accessedAt() and toFileNode, including the root cleared by setAccessedAt(undefined).
- The ext dictionary and overflow order differ from the ingest's, but extension() output does not.
- The root's name, mtime fallback, container and hidden flag match the ingest.
- The .git flag, the stable byte sort and child_start for leaves all match.
- js_round is correct on every case, including (−0.5, 0).
- Node 24.16 reporting Unicode 17.0 was confirmed on this machine.

In a scratch copy (tm-store baseline green, 24/24), I ran three mutants. All survived and were restored:
- cloud guess judged after the dedup
- cloud tally before the dedup
- atime column without headroom

The repository was not modified.

- **rust**: Read all of tm-store (lib, build, derive, finalize, column) and its three test files. Compared them line by line with ingestColumns, statToInput, detectContainerKind, PackedScanStore (writeNode, internExt, appendName, finalize, setAccessedAt, accessedAt, extension, container, ingestSubtree), noteRefused/keepSmallest, rootName and diskScanner's root row. Also read tm-walk's output.rs and hard-link keying, and tm-mft's check_shape (the other WalkOutput producer).

All of this ran in a scratch copy (repository untouched), on the pinned toolchain 1.98.1: `cargo clippy -p tm-store --all-targets -- -D warnings` is clean, `cargo fmt --check` is clean, `cargo test -p tm-store` passes all 24 tests, and `cargo doc` gives 4 warnings. I also ran probe tests, four mutants plus a control, and a release-mode timing on 5M nodes. Probe tests and mutation scripts are parked in /private/tmp/claude-501/-Users-prithvivinay-Desktop-Claude-Code/2ae6ee28-e5aa-45ad-b898-349d19889320/scratchpad/ (review_probe.rs.parked, build.rs.orig).

Checked and found correct:
- **Integer limits:** rows vs i32/u32, name bytes vs u32 offsets, the u32 counters in breadth_first; nothing can overflow or panic.
- **Malformed input that is refused:** wrong column lengths, name_off length, offsets out of order or outside the names, parent[i] ≥ i, no root, a root that is not a folder, side tables naming absent nodes.
- **Numbering:** breadth-first ids equal ingest insertion order; child order is a stable byte sort matching byNameBytes, with no sort on Windows; child_start and child_cnt semantics match.
- **Rounding:** js_round against Math.round, including large half values and −0; mtime/atime withholding, the root's mtime fallback and the atime override.
- **Extensions:** interner limit and overflow match internExt (dictionary length 0xffff); extension and container rules for ASCII and dotless names.
- **Per-node facts:** hidden; `.git`; hard-link first-name-in-store-order and the tallies; symlinks excluded from links, guesses and deltas; dataless placeholders counted after dedup; guesses left to Node; sparse/slack gating.
- **Other:** refusal-to-counter mapping; no per-node heap allocation.

The walk records hard links only for KIND_FILE, so ignoring families on symlinks and folders matches the ingest. Invalid UTF-8 in names is not validated, but PackedScanStore.name() decodes to the same string either way, so the JSON is unaffected and I did not report it.

- **equivalence**: Rules checked one by one against the TypeScript:
- statToInput: size 0 for folders; Math.round, which js_round matches for -0, halves, 2^52+ and tiny negatives; mtime NaN/±Inf becomes 0; atime only when > 0; hidden; extension via lastIndexOf with dot > 0; ASCII-only lower-casing.
- detectContainerKind: the rule table, order, suffix pre-check equivalence, whole-name Docker rules, folders-only .photoslibrary, and ".zip" as a dotfile container.
- ingestColumns: symlink branch; dataless placeholders, including dataless symlinks and dataless folders; the unallocated guess; allocDelta gating on blocks and size > 0; hard-link dedupe by family in store-id order across folders, before the cloud tally; the cloud, sparse and slack tallies and their exclusions; .git setting GitRepo on the parent (root included, not for files); refusals; dirCount and fileCount.
- Root row from diskScanner: rootName, the statToInput root, setModifiedAt only when the walk's mtime is finite, and setAccessedAt override and clear.
- PackedScanStore: writeNode flag bits; internExt, including the 0xffff limit (dict length 0xffff, then per-node overflow, repeats included); appendName; finalize's breadth-first numbering, childStart for leaves, parent -1; atime zero-fill; noteRefused/keepSmallest.
- Windows: sort_children=false keeps column order.

Beyond reading, I ran a differential test in scratch copies (review-equivalence-copy/treemap-core and tsdiff/, with the SORT_CHILDREN and BLOCKS constants made switchable). It sent 11,000 random walks through both the real ingestColumns + finalize() and tm-store build() plus the post-pass that build.rs documents. The walks mixed kinds, dataless flags, sizes up to 2^63, allocations, awkward mtimes and atimes, and names: ASCII, non-ASCII, U+FFFD, duplicates, .git, cloud-folder names and container names. The root names included a non-ASCII *.photoslibrary. Hard-link families crossed folders; there were refusals and both platform modes. The comparison covered parent, size, mtime, flags, container, cloudProv, nameOff, names, childStart, childCnt, the extension text of every node, accessedAt, every counter and deniedExamples. All matched except the float-order case above.

I also checked that the harness can fail: a planted mutation (dropping 1-byte guesses from cloud_candidates) produced 544 mismatches.

cargo test -p tm-store passes in the copy. Not covered: clippy, and JSON serialization end to end (S2 has not landed).

- **tests**: Method: I copied native/treemap-core (without target/) to scratchpad/review-teststrength-copy, with CARGO_TARGET_DIR inside the copy. The harness is scratchpad/review-teststrength-harness/{mutate.py,mutants.py,mutants.json,mutants2.json}; logs are run1-run5 there. It applies exact-string mutants (each must match once), requires `Compiling tm-store` on every run so no survivor comes from a stale build, restores from pristine copies and re-checks the hashes. Baseline: 24/24 green. Controls C1 (sparse sign), C2 (a file named .git) and C3 (decided_here's no-dot escape) were all KILLED, so the harness can go red.

Batch 1: 19 plausible mutants in build.rs, all SURVIVED (M01-M19, reported above). To prove none is equivalent, I wrote scratchpad/review-teststrength-copy/crates/tm-store/tests/killers.rs (16 tests). All 16 pass on the unmodified source, and all 19 mutants were then KILLED (run4-with-killers.log). The file carries a clippy allow for unwrap/indexing and is not rustfmt'd, so it needs adapting to the house rules before adoption.

Batch 2: 13 mutants in derive.rs, finalize.rs and build.rs. 12 were KILLED: unstable sort (the 300-equal-names test really does redden), `>=`->`>` parent check, `>1`->`>2` sort gate, 'a.' giving an empty extension, folder/file rule confusion, a half rounding down, root mtime fallback, name headroom 64->32, dictionary limit `<`->`<=`, atime zero-fill one row late, root not hidden, symlinks without an extension. D1 (removing js_round's non-finite guard) SURVIVED but is equivalent: NaN, +inf and -inf pass through floor and `x - floor` (NaN >= 0.5 is false) unchanged. It is a redundant guard, not a gap.

Well pinned: js_round and the times (the Node-measured table), extension/container/hidden (30 cases plus the 12,535-line oracle), rule_problem branches, breadth_first ids/child_start/child_cnt (sorted, unsorted, stable ties, malformed inputs), hard-link first-name in store order (the only build fixture where walk order differs from store order), sparse/slack on and off, dataless dir/link/guess candidates, dirs/files counts, column lengths and capacities except atime, ModeNotBuilt, BadContainerRule.

Pattern behind 6 of the survivors: build.rs juggles two index spaces (w/wi = walk, sid/id = store). Apart from the hard-link test, every build fixture has walk order equal to store order for the nodes it asserts on, so any output keyed by the wrong index (cloud_candidates, text_candidates, denied_dirs, ext_overflow, the refusal lookup, the .git parent) passes.

Unpinned but not practical to test, so no finding: NamesTooLong (needs >4 GiB of names) and breadth_first's TooManyRows (needs 2^31 nodes).

I compared the TS side for each killing test's expected value: nativeEngine.ts:300-372, nodeInput.ts:20-47, scanStore.ts:855-995, diskScanner.ts:723. I found no correctness bug in build.rs/derive.rs/finalize.rs itself: every surviving mutant was a change away from correct code.

The repository was not modified: tm-store src hashes are unchanged, there is no new file under the repo, and I ran no git commands.

- **adversary**: I traced build() against ingestColumns + PackedScanStore.finalize() line by line. I then ran a differential harness on both implementations: the real TypeScript through tsx, and a dump example built in a scratch copy of the workspace. The walk files are identical for both sides.

Harness files, all in /private/tmp/claude-501/-Users-prithvivinay-Desktop-Claude-Code/2ae6ee28-e5aa-45ad-b898-349d19889320/scratchpad/:
- harness/gen.mjs and harness/gen2.mjs write the walk specs.
- harness/node-side.ts builds the root as diskScanner does, runs ingestColumns, calls finalize(), and dumps every column, the extension()/accessedAt() answers and the scan counters.
- review-adversary-copy/crates/tm-store/examples/dump.rs runs build() plus the documented S2 guess pass.

Every column, flag, extension answer, container, name byte, child range, parent, time bit pattern and counter was identical in these walks:
- lossy-equal sibling names (a� twice, plus a�b), and names differing only by case;
- a .git file next to a .git folder, and a .git symlink, .GIT and '.git ' (none set GitRepo);
- a scan root named .git that holds a .git folder;
- a hard-link family whose first member in walk order is deeper in breadth-first order;
- hard-link records on the root, on a folder, on a symlink and on a refused folder;
- a dataless symlink, a symlink claiming bytes with none allocated, a dataless folder, and a dataless file that is a later hard-link name;
- a guess that is a later hard-link name;
- sizes of NaN, -5 and Infinity (with Infinity allocated);
- mtimes of NaN, ±Infinity, -0, ±0.5, ±1.5, -2.5, 0.49999999999999994, 2^52+1, ±(2^51+0.5), ±1e-320, MAX and -1e-300;
- atimes of 0.3, -1, -0, 1e-320, Infinity and NaN;
- a root whose walk mtime is NaN, and a refused root;
- names made only of dots ('.', '...'), 'a.', ' .zip', '.zip', '.tar.gz', 'a.tar.gz.zip', Docker.RAW, EXT4.VHDX, a folder named Docker.qcow2, and c.Photoslibrary as a folder and as the root;
- a non-ASCII name without a dot (é);
- 65,542 distinct extensions past the dictionary limit.

Beyond the four findings, I found no disagreement for any walk that tm-walk or tm-mft can produce. Their shape checks guarantee valid UTF-8 names, a folder root, and children only under folders.

A contract note that is not a finding: BuildOptions.root_mtime_ms is used exactly as given and is documented as already rounded by Node. Applying js_round inside build would cost nothing, because it is idempotent, and would guard S2 against passing rootStat.mtimeMs unrounded (my first harness run showed -12.5 against Node's -12).

cargo test -p tm-store (24 tests) and clippy --all-targets -D warnings both pass in the scratch copy. I did not modify the repository.

- **scale**: Read the whole tm-store crate (lib, build, derive, finalize, column; Cargo.toml) and tm-walk's output.rs, links.rs and walk.rs (Part/merge). Read the Phase 4 plan (P4-1..P4-10, fixed interfaces, 'Amended in S1', 'Pinned before S1', S2–S5, the gate), DESIGN §6–§7, and the TypeScript it mirrors (PackedScanStore grow/internExt/finalize, and nativeEngine's wantAtime). I made no changes under the repo. All builds and runs were in the scratch copy with CARGO_TARGET_DIR inside it: /private/tmp/claude-501/-Users-prithvivinay-Desktop-Claude-Code/2ae6ee28-e5aa-45ad-b898-349d19889320/scratchpad/review-scale-copy. The harness is crates/tm-store/examples/peak.rs. The variants build_lean and build_inplace are appended to src/build.rs and both give output == build()'s on /System/Library, /Applications, /Library and a synthetic tree. The allocator tests are in scratchpad/freetest/main*.rs. The machine is macOS 27.0 with 16 GB RAM and 8 cores.

Per-node estimates, with L the mean name length (measured 13.1–20.9 B):
- WalkOutput is 42+L B/node (measured 56.8–63.7).
- breadth_first peaks at walk + 28 B/node.
- At the end of the build loop: walk (42+L) + Order (16) + new columns (33+L) + cloud_prov (1) = 92+2L, plus hash tables and about 1.1 B/node of headroom. Measured heap peak: 129–142 B/node.
- The finished store is 46+L plus headroom (measured 62.2–68.0 B/node).

At n = 5M:
- build() heap peak is about 650–710 MB (706 MB measured on the synthetic).
- A bare Rust process reaches 733 MB maxRSS and still holds 696 MB after return.
- The store alone is 310–340 MB.
- tm-walk's own peak extrapolates to about 1.2–1.3 GB.
- The gate is 700 MB for the whole process.

At n = 100M:
- WalkOutput is about 6.2 GB, the build's heap peak about 14 GB, the Order vectors 1.6 GB and the store about 6.6 GB.
- The ceilings are 1.5 GB (spill) and 400 MB (aggregate).
- The u32 name offsets cap the mean name at 42.9 B.

Checked and found no problem:
- 5M sits well inside the i32 and u32 id limits.
- A headroom near i32::MAX does not abort on macOS (it reserves virtual memory only). I could not test Windows.
- The name capacity reservation is virtual only.
- text_candidates and cloud_candidates are small Vec<u32>. /System/Library has 30,699 unallocated tiny files (6.6% of its nodes), 3 MB in total; /Library has 264.
- No build-time difference between the variants rose above run-to-run noise, so I make no timing claim.

