/**
 * The work of getting a runnable TreeMap, expressed as data.
 *
 * Pure: no `vscode`, no child processes. The extension turns these into
 * progress increments and command invocations; the tests turn them into
 * assertions. Keeping the plan separate from the running is what lets the
 * ordering, the weighting and the exact argv be checked at all.
 */

export type StepId = 'locate' | 'clone' | 'update' | 'install' | 'build' | 'start';

export interface Step {
  id: StepId;
  /** Shown in the progress notification, present tense. */
  title: string;
  /** Share of the progress bar. The whole plan always sums to 100. */
  weight: number;
}

export interface PlanInput {
  /** True when the source directory does not exist yet. */
  needsClone: boolean;
  /** True when a clone exists and the user wants it kept current. */
  needsUpdate: boolean;
  /** True when node_modules is missing. */
  needsInstall: boolean;
  /** True when dist/ is missing or older than src/. */
  needsBuild: boolean;
}

/**
 * Which steps actually have to run, weighted by how long they really take.
 *
 * The weights are not decoration. A first run is dominated by `npm install`
 * (tens of seconds) and the clone; a warm run is just `start` and finishes
 * instantly. Weighting every step equally would park the bar at 20% through
 * the install and then jump to 100%, which reads as a hang — the specific
 * thing a progress notification exists to prevent.
 *
 * The returned weights always total exactly 100, so the caller can report each
 * step's weight as a percentage increment without tracking a running total.
 */
export function planSteps(input: PlanInput): Step[] {
  const steps: Step[] = [{ id: 'locate', title: 'Looking for TreeMap', weight: 2 }];
  if (input.needsClone) steps.push({ id: 'clone', title: 'Downloading TreeMap', weight: 30 });
  else if (input.needsUpdate) steps.push({ id: 'update', title: 'Checking for updates', weight: 8 });
  if (input.needsInstall) steps.push({ id: 'install', title: 'Installing dependencies', weight: 45 });
  if (input.needsBuild) steps.push({ id: 'build', title: 'Building TreeMap', weight: 18 });
  steps.push({ id: 'start', title: 'Starting the local server', weight: 5 });
  return normalise(steps);
}

/** Scale weights so they sum to exactly 100, giving any rounding to the last. */
function normalise(steps: Step[]): Step[] {
  const total = steps.reduce((sum, s) => sum + s.weight, 0);
  if (total === 0) return steps;
  let used = 0;
  return steps.map((s, i) => {
    if (i === steps.length - 1) return { ...s, weight: 100 - used };
    const weight = Math.round((s.weight / total) * 100);
    used += weight;
    return { ...s, weight };
  });
}

export interface Command {
  command: string;
  args: string[];
  /** Where to run it. Absent means "the source directory". */
  cwd?: string;
}

/**
 * The exact commands each step runs, in order.
 *
 * Returned as data rather than executed here so the tests can pin them: these
 * are the commands that fetch and execute code on the user's machine, and "it
 * probably runs git clone correctly" is not worth taking on trust.
 *
 * Every one is spawned with an argv array and no shell, and `--` separates
 * options from user-controlled values.
 */
export function commandsFor(
  step: StepId,
  ctx: { repositoryUrl: string; gitRef: string; dir: string },
): Command[] {
  switch (step) {
    case 'clone':
      return [
        {
          command: 'git',
          // The parent directory is the cwd; the clone creates `dir` itself.
          args: ['clone', '--depth', '1', '--branch', ctx.gitRef, '--', ctx.repositoryUrl, ctx.dir],
          cwd: '.',
        },
      ];
    case 'update':
      // Fetch then hard-reset rather than pull. The clone is a cache the
      // extension owns and nobody edits, so a divergence is not a merge to
      // resolve — and `git pull` stopping to ask about one would hang the
      // progress bar behind a prompt no one can see.
      return [
        { command: 'git', args: ['-C', ctx.dir, 'fetch', '--depth', '1', 'origin', '--', ctx.gitRef] },
        { command: 'git', args: ['-C', ctx.dir, 'reset', '--hard', 'FETCH_HEAD'] },
      ];
    case 'install':
      // `npm ci` deletes node_modules and installs exactly the lockfile, which
      // is right for a directory nobody edits by hand.
      //
      // Dev dependencies are NOT omitted: `npm run build` is `tsc`, and
      // typescript is a devDependency — `--omit=dev` would install a tree that
      // cannot build itself. Scripts are not disabled either: better-sqlite3
      // and sharp need their install scripts to produce working binaries.
      return [{ command: 'npm', args: ['ci', '--no-audit', '--no-fund'] }];
    case 'build':
      return [{ command: 'npm', args: ['run', 'build'] }];
    default:
      return [];
  }
}
