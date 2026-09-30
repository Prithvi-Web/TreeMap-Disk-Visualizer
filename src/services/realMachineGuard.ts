import { AppError } from '../middleware/errorHandler';

/**
 * The guard at the doors to the machine's irreversible operations, and to the
 * Trash itself: the step that moves a path to the Trash (cleaner.ts — the
 * Finder, the Recycle Bin, gio), emptying the Trash and listing it
 * (trash.ts), deleting Time Machine's local snapshots (snapshotAccounting.ts),
 * moving a cloud file to its provider's trash (cloud/cloudScan.ts) and
 * `git gc --prune=now` (gitScanner.ts).
 *
 * Under a test runner each of them refuses — throws, before any call to the
 * operating system — unless the test put its stand-in in place of the real
 * operation (setTrashStepForTests, TREEMAP_TRASH_DIR,
 * setSnapshotPurgeStepForTests, TM_<PROVIDER>_API, setGitGcStepForTests). The
 * owner's rule is "never touch my real app data or my Trash", and it was not
 * enforced: tests put files into the owner's real Trash on every run — three
 * `holiday.mp4` from tests/compressionAdvisor.test.ts since 28 Jul 2026, six
 * `f*.bin` from tests/cartCommit.test.ts from 26 Aug to 29 Sep — one listed
 * it on every run (tests/rateLimiterLanes.test.ts, since 31 Aug) and one
 * emptied it (tests/trashInfo.test.ts, Aug 2026). Now a test that forgets its
 * stand-in fails, loudly, and the machine is not touched.
 *
 * "Under a test runner" is known two ways, either of which is enough:
 *  - FORBID_REAL_TRASH_VARIABLE, which scripts/run-tests.js sets for every
 *    `npm test` run (CI runs `npm test` too) and which every process of the
 *    run inherits, children started with `...process.env` included;
 *    tests/fixtures/nestedRun.ts puts it into every nested run's environment,
 *    and tests/fixtures/dataDir.ts into the environment of every test file
 *    that loads it, however the file was started;
 *  - NODE_TEST_CONTEXT, which node:test sets in the process it starts for a
 *    test file (`child-v8` on Node 20 and 24, through `npm test`, through
 *    `node --test <file>` and through `tsx --test <file>` alike).
 * Production sets neither, so there the doors behave exactly as before.
 *
 * A refusal is loud three ways, because a caller may swallow a throw: the
 * error itself; a line on stderr as it happens, naming the process's entry
 * file; and, when the process ends, its exit code set to 1 with the list
 * again, so the test file fails even if every one of its tests passed. A test
 * of the guard takes its own refusals (takeRealMachineRefusalsForTests) so
 * that its file does not fail for them.
 */

/** Set by scripts/run-tests.js in the environment of every `npm test` run. Production never sets it. */
export const FORBID_REAL_TRASH_VARIABLE = 'TREEMAP_FORBID_REAL_TRASH';

/** Whether `env` is a test runner's: the run's own variable, or node:test's context for a test file. */
export function underTestRunner(env: NodeJS.ProcessEnv = process.env): boolean {
  return nonEmpty(env[FORBID_REAL_TRASH_VARIABLE]) || nonEmpty(env.NODE_TEST_CONTEXT);
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

/** What a door throws when a test reached it without its stand-in. */
export class RealMachineRefusal extends AppError {
  constructor(message: string) {
    super(500, 'TEST_REACHED_REAL_MACHINE', message);
    this.name = 'RealMachineRefusal';
  }
}

/** Refusals this process made that no test of the guard has taken. */
const untaken: string[] = [];
let exitCheckInstalled = false;

/**
 * The guard itself: under a test runner, throws RealMachineRefusal with
 * `message` (and says so on stderr); otherwise returns and the door goes
 * ahead. Each door calls it first, before anything reaches the machine.
 */
export function refuseUnderTestRunner(message: string): void {
  if (!underTestRunner()) return;
  untaken.push(message);
  process.stderr.write(`[treemap] REFUSED under a test runner: ${message} (in ${entryFile()})\n`);
  installExitCheck();
  throw new RealMachineRefusal(message);
}

/** The file this process was started with, to say where a refusal happened. */
function entryFile(): string {
  return process.argv[1] ?? 'an unnamed process';
}

/** Fails the process at its end if a refusal was made and not taken, whatever caught the throw. */
function installExitCheck(): void {
  if (exitCheckInstalled) return;
  exitCheckInstalled = true;
  process.once('exit', () => {
    if (untaken.length === 0) return;
    const count = untaken.length;
    process.stderr.write(
      `[treemap] ${entryFile()} ends with exit code 1: under a test runner it refused ${String(count)} call${count === 1 ? '' : 's'} ` +
        `that would have reached the real machine — stand in for them:\n${untaken.map((m) => `  - ${m}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  });
}

/**
 * Test-only: the refusals this process has made since the last call, which
 * are then no longer held against it at exit. For the guard's own tests,
 * which make refusals on purpose.
 */
export function takeRealMachineRefusalsForTests(): string[] {
  return untaken.splice(0);
}
