import { setGitSpawnForTests, type GitInvocation } from '../../src/services/gitSafe';

/**
 * A stand-in for starting git (FG4): every call TreeMap would make is recorded — its argv, its
 * environment, its working folder and what it would have been sent on stdin — and answered from
 * a script. **Nothing is ever started.** Tests of what git is allowed to run, and of what is
 * refused before git is run at all, use this instead of a repository planted with a setting that
 * names a program: with the recorder in place, a missing check shows as a recorded argv, never as
 * an execution.
 */

export interface RecordedGit {
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin: string;
}

/** What the script answers for one call. */
export interface ScriptedAnswer {
  code?: number;
  stdout?: string;
  /** stdout in pieces, as a pipe may deliver it; used instead of `stdout`. */
  chunks?: string[];
  stderr?: string;
}

/**
 * The command a recorded argv runs, with every global option before it removed: `-c <k=v>`,
 * `-C <dir>`, `--git-dir=<dir>` and the like. `['status', '--porcelain=v1', …]`, `['config', …]`.
 */
/** git's global options that take the next word as their value. */
const WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']);
/** git's global options that stand alone. */
const ALONE = new Set(['-p', '-P', '--paginate', '--no-pager', '--bare', '--no-replace-objects', '--no-optional-locks',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-advice', '--no-lazy-fetch']);

export function subcommand(args: readonly string[]): string[] {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (WITH_VALUE.has(a)) { i += 2; continue; }
    if (ALONE.has(a) || (a.startsWith('--') && a.includes('='))) { i += 1; continue; }
    break;
  }
  return args.slice(i);
}

/** Installs the recorder; `answer` scripts each call from its subcommand. `restore()` puts real git back. */
export function recordGit(answer: (sub: string[], call: RecordedGit) => ScriptedAnswer): { calls: RecordedGit[]; restore(): void } {
  const calls: RecordedGit[] = [];
  setGitSpawnForTests(async (inv: GitInvocation, sink) => {
    const call: RecordedGit = { args: [...inv.args], env: { ...inv.env }, cwd: inv.cwd, stdin: inv.stdin };
    calls.push(call);
    const reply = answer(subcommand(inv.args), call);
    let stopped = false;
    for (const chunk of reply.chunks ?? (reply.stdout ? [reply.stdout] : [])) {
      if (stopped) break;
      stopped = sink(chunk);
    }
    return { code: reply.code ?? 0, stderr: reply.stderr ?? '', stopped };
  });
  return { calls, restore: () => setGitSpawnForTests(null) };
}

/** The subcommands of `calls`, in order: `['rev-parse', 'config', 'remote', 'status', …]`. */
export function commandsOf(calls: readonly RecordedGit[]): string[] {
  return calls.map((c) => subcommand(c.args)[0] ?? '');
}
