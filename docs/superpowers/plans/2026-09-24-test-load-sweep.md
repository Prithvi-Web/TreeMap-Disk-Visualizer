# The Node suite under CPU load — the sweep, as far as it ran (24 Sep 2026)

Why: CI failed on busy shared runners three times in a day (governor timing tests; a sampled gdu pause test on the pt-BR leg). `npm test` was then run on this Mac with extra load (`yes > /dev/null` on 4, then 10, of 8 cores). With 4 busy loops, 6 older tests failed; with 10, 52 did (plus 5 `packedStoreAdopt` tests that are RED on purpose until S2's `adoptColumns` exists). Causes: fixed 5–30 s deadlines on real scans; tests draining the app's own rate limiter (`src/middleware/rateLimiter.ts`: the `api` lane allows 20 then 10/s; `/api/scan/:id/stats` is in that lane though AGENTS.md tells callers to poll it — a PRODUCT question two fixers raised); and native scans falling back to another engine under full-core load (bench + nativeEquivalence (c)) — a product question, not investigated yet.

The workflow `flakeproof-node-suite` (run wf_5be02143-325) gave each failing file one fixer (edit only that file; waits use `tests/fixtures/waitFor.ts` — `HANG_GUARD_MS` 120 s, `waitFor(done, what)`; never loosen an assertion; timing claims redesigned to count what the code does) and a skeptic per changed file. It was interrupted when the session ended.

## Finished by a fixer (skeptic check NOT run — review each diff before committing)

### facts.test.ts

- scannedFixture no longer polls /stats over HTTP. It still starts the scan through POST /api/scan and still asserts 202. It then waits on the scan record in this process: waitFor(() => peekScan(scanId)?.status !== 'running', 'the fixture scan settling') from tests/fixtures/waitFor.ts, with the default HANG_GUARD_MS limit. After that it asserts status === 'complete', and the message includes the scan's own error. peekScan is used because the wait is not a client use of the scan, so it should not reset the retention clock. The scan route's startScan sets `store` and `status = 'complete'` together, with no await between them, so a settled record really is complete.
- The fixture now uses no rate-limit tokens while waiting. Each HTTP test uses at most 4 'api' tokens after listen()'s reset: the scan POST plus up to 3 asserted requests. None depends on tokens left over from earlier tests or from its own polling.
- The fixture now fails with a named message if the scan errors or is still running after the hang guard. Before, it fell through silently after 200 polls.
- Strengthened the cache-expiry test. The first call now caches '/a' and '/b', and the size assertion is 2. After the 20 ms sleep, only '/a' is asked for again. The final factCacheSize() === 1 now proves that the sweep removed the expired '/b'. The calls === 2 and { calls: 2 } assertions and all messages are unchanged.
- Added imports for peekScan (src/services/diskScanner) and waitFor (tests/fixtures/waitFor). No assertion was loosened: every status, code, value and message is the same.
- product note: GET /api/scan/:id/stats is in the strict 'api' lane (20 burst, 10/s), but it is the endpoint callers are told to poll. AGENTS.md says 'Poll GET /api/scan/{scanId}/stats until status is complete', and the 202 from POST /api/scan?wait=true points callers there too. The handler only reads the in-memory record (requireScan + buildScanStats; deniedExamples is kept small by keepSmallest), with no filesystem I/O. An agent that polls it quickly uses up the same bucket its next real call needs, which is exactly what happened in this test. Adding /^\/scan\/[^/]+\/stats$/ to META_PATTERNS in src/middleware/rateLimiter.ts is worth considering. It is left for the owner to decide, because that allowlist is meant to be reviewed on purpose; not changed here.
- product note: Outside this file: `npx tsc -p tsconfig.tests.json --noEmit` currently fails with 10 errors, all in tests/packedStoreAdopt.test.ts (missing StoreColumns export and PackedScanStore.adoptColumns). That file was modified at 00:14 today and may be another agent's work in progress. tests/facts.test.ts type-checks clean.
- run: run 1: npx tsx --test tests/facts.test.ts -> tests 22, pass 22, fail 0 (797 ms)
- run: run 2: npx tsx --test tests/facts.test.ts -> tests 22, pass 22, fail 0 (891 ms)
- run: run 3: npx tsx --test tests/facts.test.ts -> tests 22, pass 22, fail 0 (816 ms)

### incrementalRescan.test.ts

- settle(scanId) now waits with waitFor(done, `scan ${scanId} settling`, 25) at the default HANG_GUARD_MS (120 s) and returns the record. It still asserts on every poll that the record exists (the same 'scan record must exist' message), and it still completes on the scan record's status. Only the 10 s wall-clock failure is gone.
- Added writesSettled(): it awaits backgroundWrites.settled(), the real completion of the tracked cache and snapshot writes, raced against a HANG_GUARD_MS timer whose error names the writes still running (via pending()). This follows the settleBackgroundWrites pattern in tests/agentErgonomics.test.ts.
- waitForCache(root) now awaits writesSettled() and then asserts that the cache file exists, with the same message ('cache file never appeared: <file>'). It no longer polls with a 5 s deadline.
- The two tests that called a bare `await settled()` ('the fast-rescan cache is the finished tree, byte for byte' and 'finishing a scan never builds the whole tree as objects') now call writesSettled(). Their dynamic imports of backgroundWrites were replaced by one static import, and HANG_GUARD_MS and waitFor are imported from tests/fixtures/waitFor.ts (not edited).
- No assertion about behaviour was changed: same values (fileCount 5/3, walkedDirs 1/0, cachedDirs >= 3/4, stale size, byte-identical cache, zero unbounded prunes), same statuses and same messages. The file made no genuine timing claim, so no timing claim needed redesigning.
- Checks run: (1) a scratch probe showed that at the moment a scan settles, pending() in the statically imported module lists saveMtimeCache and saveSnapshot, and settled() drains both. So it is the same ledger diskScanner writes to, and the wait is not vacuous. (2) Mutation runs on scratch copies of the file (repo file untouched, copies deleted afterwards): a record that never leaves 'running' failed 7 tests with 'scan <id> settling did not happen within 300 ms'; a tracked write that never finishes failed 7 tests naming 'never-finishes'; a wrong cache path failed the 5 cache-dependent tests with 'cache file never appeared'. (3) Removing the write wait did NOT fail anything on an idle Mac at a 25 ms status poll: the cache was already on disk by the time the poll noticed. With the poll tightened to 0 ms, the same no-wait mutant failed 3 tests in each of 2 runs, while the real file at a 0 ms poll passed 10/10 in 3 of 3 runs. So the file no longer depends on the gap between a scan finishing and the poll noticing it.
- product note: No defect found in the product code this file drives. The slow scans under load look like the engine budget yielding as designed, not a hang; I did not measure which mechanism dominated. A scan's completion is observable only by polling the record's status, because startScan returns before the walk finishes. A completion promise or event would let tests await it directly, but that is a design suggestion, not a fix this file needed.
- product note: Unrelated to this file, not touched: `npx tsc -p tsconfig.tests.json` reports 10 errors, all in tests/packedStoreAdopt.test.ts (modified 24 Sep 00:14). It imports StoreColumns and calls PackedScanStore.adoptColumns, and src/services/scanStore.ts (modified 23 Sep) has neither. `npm run typecheck` is red until that file and scanStore agree. It looks like another session's work in progress. tests/incrementalRescan.test.ts itself type-checks cleanly.
- run: run 1: `npx tsx --test tests/incrementalRescan.test.ts`: tests 10, pass 10, fail 0, duration_ms 520
- run: run 2: `npx tsx --test tests/incrementalRescan.test.ts`: tests 10, pass 10, fail 0, duration_ms 465
- run: run 3: `npx tsx --test tests/incrementalRescan.test.ts`: tests 10, pass 10, fail 0, duration_ms 624

### reclaimScoreProvider.test.ts

- scannedFixture(): replaced the 400 x 25 ms HTTP poll of /stats with `await waitFor(() => peekScan(scanId)?.status !== 'running', 'the fixture scan settling')`. This uses the shared tests/fixtures/waitFor.ts helper with its default HANG_GUARD_MS (120 s) as a hang guard only. It reads the in-process scan record: no HTTP, so no rate-limiter tokens are spent. diskScanner exposes no completion promise or event, so the record's status is the real completion signal. peekScan is used rather than getScan so the wait does not count as a 'use' of the scan.
- Added `assert.equal(settled?.status, 'complete', `fixture scan failed: ${settled?.error}`)` after the wait. The old loop never asserted completion: it only checked 'not error' on each round. A failed or unfinished fixture scan now fails in the fixture with the scan's own error, instead of later as a misleading score assertion.
- Imports added: waitFor from './fixtures/waitFor' and peekScan from '../src/services/diskScanner'. Neither has side effects. The waitFor import sits before the isolatedDataDir() call, and the peekScan import sits with the other src imports after TREEMAP_NO_GDU is set.
- Each test's api-lane spend is now POST /api/scan plus its own asserted requests (at most 5: scan, facts, and 3 locked GETs), against a bucket that listen() resets to 20. No test depends on tokens left over from polling or from earlier tests.
- No assertion was changed: same values, statuses and messages. The fixture's 202 on POST /api/scan is still asserted. The file makes no wall-clock timing claims (the zero-weight test already counts calls), so none needed redesigning.
- One added comment states the verified facts: the strict lane and its limits, the drain and the resulting 429, the fall-through after 400 rounds, and that the limit is a hang guard while the assertion proves completion.
- product note: None required a product change. For the parent's awareness: the score's inputs run subprocesses under product timeouts (git 10 s in gitRecoverability.ts GIT_TIMEOUT_MS, xattr 5 s single and 10 s batch in platform/macos/provenance.ts, tmutil 8-20 s in platform/macos/backup.ts). Under extreme load, one of them could time out in one computation but not the next, turning a component into 'missing'. The two tests that compare two computations ('editing a weight...' restored vs before, and 'skipping a component...') would then differ. This did not appear in either load run. It would be honest product behaviour (unknown, not zero), so I left it alone.
- product note: Checked, not a risk: those same two equality checks also read the wall clock through staleness, which is linear in Date.now() minus mtime. For the day-old video the staleness contribution is about 0.045 against the round1 edge at 0.05. Crossing that edge takes about 2.7 hours of drift, and the score drifts about 3e-5 per minute.
- product note: Outside my file: `npx tsc -p tsconfig.tests.json` reports 10 errors, all in tests/packedStoreAdopt.test.ts. It imports StoreColumns and calls PackedScanStore.adoptColumns, which src/services/scanStore.ts does not export or define. It may be a test written ahead of its product code, or another agent's in-progress work. reclaimScoreProvider.test.ts type-checks clean.
- run: Final text, run 1: `npx tsx --test tests/reclaimScoreProvider.test.ts`: exit 0, tests 27, pass 27, fail 0, 3591 ms
- run: Final text, run 2: exit 0, tests 27, pass 27, fail 0, 3297 ms
- run: Final text, run 3: exit 0, tests 27, pass 27, fail 0, 3669 ms

### safetyRails.test.ts

- scanFixture: after the unchanged POST /api/scan and its 202 assertion, the test now gets the live scan record with peekScan(scanId), asserts it is registered, and runs waitFor(() => scan.status !== 'running', 'the fixture scan settling'). This is the tests/fixtures/waitFor.ts hang guard (HANG_GUARD_MS = 120 s) and it checks in-process, so it spends no rate-limit tokens. peekScan returns the same object the scan updates as it runs (diskScanner puts that object in its scans map), and peekScan does not restart the scan's retention clock.
- scanFixture: once the scan has settled, one GET /api/scan/:id/stats keeps the check through the API: the unchanged assert.fail('scan failed') when status is 'error', and assert.equal(status, 'complete') with the body as the message. That makes 2 api-lane tokens per scanFixture (1 POST, 1 GET), down from 1 + up to 100.
- Teardown (the finally block of the last test): before the existing rmSync of the fixture and DATA_DIR, two new waits: waitFor(every scan in allScans() has settled) and waitFor(pending().length === 0, the trackWrite ledger in src/utils/backgroundWrites). The 'maxRetries' rmSync and its Windows comment are unchanged.
- New imports: allScans and peekScan from ../src/services/diskScanner, pending from ../src/utils/backgroundWrites, waitFor from ./fixtures/waitFor. No assertion was removed or loosened: same statuses, codes, values and messages. No src/ or fixture file was edited.
- Mutation check: with the scan wait replaced by () => true, 4 of 8 tests failed on assert.equal(status 'complete'), with the /stats body showing status 'running'. So the wait matters and the check after it catches a scan that has not finished. The file was restored byte-identical (shasum b37a04f... matched) before the final edits.
- tsc --noEmit -p tsconfig.tests.json: no errors.
- product note: GET /api/scan/:id/stats is in the strict 'api' rate-limit lane, even though it answers from the in-memory scan record (buildScanStats reads counters) in constant work. AGENTS.md tells agents to 'Poll GET /api/scan/{scanId}/stats until status is complete', so an agent that does what the docs say polls from the same 20-burst, 10/s bucket as its DELETE /api/files and offload calls. By rateLimiter.ts's own rule ('Progress polls belong here because a long job's caller hits them on a timer'), it may belong in META_PATTERNS. Not changed: that edit is in src/.
- product note: A 2-file API scan reports budget {preset:'auto', effective:'eco'}. That explains why a trivial scan went past 10 s under CPU load (the governor throttles and pauses its workers). This looks like intended behaviour. It is recorded here only so the slowness is not taken for a hang.
- product note: The audit test depends on the order of the tests in the file: it asserts on entries written by the earlier tests. Run on its own (--test-name-pattern) it fails. Left as it is, because the test is written to be about those earlier requests.
- product note: Two temp folders from an interrupted run on 23 Sep are still on disk (TMPDIR/treemap-rails-fixture-wufQh5 and TMPDIR/treemap-rails-test-A71lb9). They were left in place: removing them was not part of this task.
- run: run 1: npx tsx --test tests/safetyRails.test.ts, exit 0, tests 8, pass 8, fail 0, duration_ms 1271; nothing on stderr; no new treemap-rails-* temp folders
- run: run 2: npx tsx --test tests/safetyRails.test.ts, exit 0, tests 8, pass 8, fail 0, duration_ms 1232; nothing on stderr; no new temp folders
- run: run 3: npx tsx --test tests/safetyRails.test.ts, exit 0, tests 8, pass 8, fail 0, duration_ms 1137; nothing on stderr; no new temp folders

## Started but not finished (check `git diff` — `humanScale.test.ts` was left with partial edits)

- humanScale.test.ts
- savedQueries.test.ts
- nativeEngine.test.ts
- notes.test.ts
- polishServerScanRootSymlink.test.ts

## Never started

- polishServerStats.test.ts
- cartCommit.test.ts
- gduScanner.test.ts
- mcp.test.ts
- sparseFiles.test.ts
- the product agent (why a native scan falls back under full-core load: benchScanHold.test.ts, nativeEquivalence.test.ts (c)) started and did not report

## Every failure seen with 10 busy loops (and the 4-loop ones marked)

```
57 distinct failing tests
--- reclaimScoreProvider.test.ts (12)
     11.8s reclaimScoreProvider.test.ts:162 :: an un-backed-up original reports "elsewhere" as UNKNOWN, never as zero :: AssertionError [ERR_ASSERTION]: reclaimScore unavailable: That scan is still running — nothing can be scored until it fi
     11.9s reclaimScoreProvider.test.ts:162 :: every breakdown reads as English, and no component is a bare number :: AssertionError [ERR_ASSERTION]: reclaimScore unavailable: That scan is still running — nothing can be scored until it fi
     11.6s reclaimScoreProvider.test.ts:162 :: a file deep inside a claimed folder inherits the rule, and says where  :: AssertionError [ERR_ASSERTION]: reclaimScore unavailable: That scan is still running — nothing can be scored until it fi
     11.1s reclaimScoreProvider.test.ts:162 :: a stale file scores higher on staleness than a fresh one of the same s :: AssertionError [ERR_ASSERTION]: reclaimScore unavailable: That scan is still running — nothing can be scored until it fi
     11.7s reclaimScoreProvider.test.ts:322 :: a path the scan does not contain is skipped, never scored :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | false !== true
     11.4s reclaimScoreProvider.test.ts:355 :: POST /api/facts serves the score, and adds nothing to the byte-locked  :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | false !== true
     11.2s reclaimScoreProvider.test.ts:389 :: unknown provider ids are still refused now that a fourth exists :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | 429 !== 400
     11.8s reclaimScoreProvider.test.ts:162 :: the score never selects, stages or trashes anything :: AssertionError [ERR_ASSERTION]: reclaimScore unavailable: That scan is still running — nothing can be scored until it fi
     11.5s reclaimScoreProvider.test.ts:162 :: editing a weight drops the cached scores rather than serving stale one :: AssertionError [ERR_ASSERTION]: reclaimScore unavailable: That scan is still running — nothing can be scored until it fi
     11.3s reclaimScoreProvider.test.ts:162 :: saving an unrelated setting keeps the cached scores :: AssertionError [ERR_ASSERTION]: reclaimScore unavailable: That scan is still running — nothing can be scored until it fi
     11.1s reclaimScoreProvider.test.ts:162 :: a zero-weight component is skipped, not computed and discarded :: AssertionError [ERR_ASSERTION]: reclaimScore unavailable: That scan is still running — nothing can be scored until it fi
     11.2s reclaimScoreProvider.test.ts:162 :: skipping a component does not change the scores of the others :: AssertionError [ERR_ASSERTION]: reclaimScore unavailable: That scan is still running — nothing can be scored until it fi
--- facts.test.ts (7)
      5.6s facts.test.ts:250 :: the batch cap is enforced at 2000 paths :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | 429 !== 400
      5.8s facts.test.ts:273 :: the destructive routes keep their own, smaller cap :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | 429 !== 400
      5.5s facts.test.ts:313 :: an unknown provider id is refused, and the error names the valid ids :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | 429 !== 400
      5.5s facts.test.ts:336 :: a missing or empty providers array is refused :: AssertionError [ERR_ASSERTION]: providers=undefined | 429 !== 400
      5.5s facts.test.ts:350 :: an empty paths array and an unknown scanId are each refused :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | 429 !== 400
      5.6s facts.test.ts:380 :: one provider throwing leaves the others intact :: AssertionError [ERR_ASSERTION]: a failing provider is not a failed request | 429 !== 200
      3.0s facts.test.ts:606 :: the fact route adds nothing to the byte-locked scan responses :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | 429 !== 200
--- humanScale.test.ts (7)
     11.1s humanScale.test.ts:238 :: nine photos are below the floor: the kind is absent, not zeroed :: TypeError: Cannot read properties of undefined (reading 'equivalents')
     11.0s humanScale.test.ts:259 :: no comparable files means an empty equivalents array — never a generic :: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
     11.0s humanScale.test.ts:287 :: a file path is skipped and absent from values — directories only :: AssertionError [ERR_ASSERTION]: the directory in the same batch still answered
     10.8s humanScale.test.ts:349 :: the provider resolves through the registry like every other fact :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | false !== true
     13.0s humanScale.test.ts:407 :: an abort discovered mid-walk skips that path entirely — never a partia :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | false !== true
     12.0s humanScale.test.ts:433 :: a walk that hits the node cap reports what it counted, marked capped :: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
     11.0s humanScale.test.ts:517 :: one request cannot walk forever: the batch budget skips the tail hones :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | false !== true
--- packedStoreAdopt.test.ts (5)
      0.0s packedStoreAdopt.test.ts:111 :: an adopted store answers as the oracle does, on 96 random trees (cloud :: TypeError: adopted.adoptColumns is not a function
      0.0s packedStoreAdopt.test.ts:129 :: an adopted store takes the watcher's changes as the oracle does, growi :: TypeError: adopted.adoptColumns is not a function
      0.0s packedStoreAdopt.test.ts:148 :: an extension past the dictionary is read from the overflow list :: TypeError: adopted.adoptColumns is not a function
      0.0s packedStoreAdopt.test.ts:157 :: adoptColumns refuses a store that is not fresh, and columns that do no :: AssertionError [ERR_ASSERTION]: The input did not match the regular expression /only a store holding just its root/. Inp
      0.0s packedStoreAdopt.test.ts:187 :: adopting keeps the columns it was given: no copy of any array :: TypeError: adopted.adoptColumns is not a function
--- incrementalRescan.test.ts (4)
     10.0s incrementalRescan.test.ts:42 :: in-place edits stay unseen — the documented trade-off that makes fast  :: AssertionError [ERR_ASSERTION]: scan timed out
     10.0s incrementalRescan.test.ts:42 :: a second-precision cache (as written after a gdu scan) still gets full :: AssertionError [ERR_ASSERTION]: scan timed out
     10.0s incrementalRescan.test.ts:42 :: the fast-rescan cache is the finished tree, byte for byte :: AssertionError [ERR_ASSERTION]: scan timed out
     10.0s incrementalRescan.test.ts:42 :: finishing a scan never builds the whole tree as objects :: AssertionError [ERR_ASSERTION]: scan timed out
--- safetyRails.test.ts (4)
     10.2s safetyRails.test.ts:86 :: POST /api/offload dryRun returns the exact plan and writes nothing at  :: AssertionError [ERR_ASSERTION]: scan did not complete in time
     10.4s safetyRails.test.ts:86 :: agent-policy.json blocks out-of-allowlist scans and destructive calls  :: AssertionError [ERR_ASSERTION]: scan did not complete in time
      0.0s safetyRails.test.ts:190 :: the audit log recorded the dry runs and the policy refusals, newest fi :: AssertionError [ERR_ASSERTION]: expected several entries, got 1
     10.2s safetyRails.test.ts:86 :: idempotency works end-to-end on the real DELETE /api/files route :: AssertionError [ERR_ASSERTION]: scan did not complete in time
--- savedQueries.test.ts (4)
      5.5s savedQueries.test.ts:187 :: results are sorted and paged deterministically :: TypeError: Cannot read properties of undefined (reading 'map')
      5.6s savedQueries.test.ts:217 :: a query needing an unavailable signal is DEGRADED, not silently empty :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | 429 !== 200
      6.0s savedQueries.test.ts:243 :: score: is a real filter now, not a stated dead end :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | 429 !== 200
      5.7s savedQueries.test.ts:277 :: the query route refuses bad input rather than guessing :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | 429 !== 400
--- nativeEngine.test.ts (2)
     36.2s nativeEngine.test.ts:1539 :: real module: pausing a native scan stops `scanned` within 200 ms, and  :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
     22.3s nativeEngine.test.ts:1606 :: real module: scanTake never blocks — a walk still running is refused a :: AssertionError [ERR_ASSERTION]: the child did not finish (status 1, signal null): a take of a running walk blocked inste
--- notes.test.ts (2)
     24.1s notes.test.ts:579 :: a corrupt notes.json fails CLOSED — automation refuses rather than run :: AssertionError [ERR_ASSERTION]: fixture scan never completed
     10.0s notes.test.ts:612 :: the agent summary respects notes — teeth for a wire the review found u :: AssertionError [ERR_ASSERTION]: fixture scan never completed
--- polishServerScanRootSymlink.test.ts (2)
     15.0s polishServerScanRootSymlink.test.ts:88 :: an alias spelling of a scanned file is the same file, and is accepted :: AssertionError [ERR_ASSERTION]: the fixture scan must complete
     15.0s polishServerScanRootSymlink.test.ts:88 :: the MCP tools share the verdict: insideAnyScanRoot is the one gate :: AssertionError [ERR_ASSERTION]: the fixture scan must complete
--- polishServerStats.test.ts (2)
     15.0s polishServerStats.test.ts:109 :: folders the OS refused are counted and up to five are named, sorted :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
     15.0s polishServerStats.test.ts:194 :: /stats publishes expiresAt about thirty minutes out, and reading keeps :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | 'object' !== 'number'
--- benchScanHold.test.ts (1)
     32.9s benchScanHold.test.ts:125 :: the scanhold command runs end to end on the smoke corpus and writes it :: AssertionError [ERR_ASSERTION]: the command ran to a result, not a crash: bench: requested native but the scan ran on tu
--- cartCommit.test.ts (1)
      2.1s cartCommit.test.ts:470 :: a retried commit with the same Idempotency-Key cannot run twice :: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | 429 !== 200
--- gduScanner.test.ts (1)
     30.4s gduScanner.test.ts:37 :: gdu and the walker report identical bytes and hardlinks on the same tr :: AssertionError [ERR_ASSERTION]: scan a84e7c9e-69ef-4a0e-809d-83d01626b19d never settled — timed out after 30s
--- mcp.test.ts (1)
     30.1s mcp.test.ts:180 :: compare_scans of two identical scans reports zero drift :: AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
--- nativeEquivalence.test.ts (1)
     34.7s nativeEquivalence.test.ts:264 :: (c) ci20k: the native engine vs the walker :: AssertionError [ERR_ASSERTION]: the native engine was forced on darwin and the module exports scanStart, but the scan ra
--- sparseFiles.test.ts (1)
     10.6s sparseFiles.test.ts:55 :: a hard-link duplicate never has its shortfall taken off twice :: Error: scan did not finish
```

With 4 busy loops: cartCommit.test.ts:470 (429 !== 200), facts.test.ts:295 (429 !== 403), reclaimScoreProvider.test.ts:353 and :389 (429), safetyRails.test.ts:86 (scan did not complete in time), sparseFiles.test.ts:55 (scan did not finish).
