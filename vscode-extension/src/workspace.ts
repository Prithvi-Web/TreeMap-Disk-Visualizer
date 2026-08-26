import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { run, Cancelled, isMissingProgram } from './exec';
import { commandsFor, planSteps, Step, StepId } from './lib/steps';
import {
  chooseSource,
  isAllowedGitRef,
  isAllowedRepositoryUrl,
  SourceChoice,
  TreeTest,
} from './lib/sourceRoot';

/**
 * Getting a TreeMap checkout that can actually be started.
 *
 * The VS Code layer above supplies the settings and a progress reporter; this
 * decides what work is needed and does it. Nothing here imports `vscode`
 * either — it takes callbacks — which keeps the whole thing runnable from a
 * plain Node test if it ever needs to be.
 */

export interface PrepareOptions {
  repositoryUrl: string;
  gitRef: string;
  useWorkspaceRepository: boolean;
  /** False freezes the extension-owned clone at whatever commit is on disk. */
  autoUpdate: boolean;
  workspaceFolders: string[];
  /** Where a clone lives: the extension's own global storage. */
  clonePath: string;
  onStep: (step: Step) => void;
  onLog: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface Prepared {
  dir: string;
  source: SourceChoice;
}

/** Read the four markers that say a directory is a TreeMap checkout. */
export async function inspectTree(dir: string): Promise<TreeTest> {
  const read = async (rel: string): Promise<boolean> => {
    try {
      await fsp.access(path.join(dir, rel));
      return true;
    } catch {
      return false;
    }
  };
  let packageName: string | undefined;
  try {
    const raw = await fsp.readFile(path.join(dir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    if (typeof parsed.name === 'string') packageName = parsed.name;
  } catch {
    /* absent or unparseable — hasPackageJson below reports it honestly */
  }
  return {
    hasPackageJson: await read('package.json'),
    packageName,
    hasPublicIndexHtml: await read(path.join('public', 'index.html')),
    hasSrcServer: await read(path.join('src', 'server.ts')),
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when dist/ is missing, or older than the newest file in src/.
 *
 * Cheap and shallow on purpose: a full recursive mtime walk of src/ would cost
 * more than the build it is trying to avoid on a warm start. dist/index.js
 * against the newest top-level src entry catches the case that matters — a
 * freshly-pulled update whose sources moved.
 */
async function needsBuild(dir: string): Promise<boolean> {
  const entry = path.join(dir, 'dist', 'index.js');
  if (!(await exists(entry))) return true;
  try {
    const built = (await fsp.stat(entry)).mtimeMs;
    const srcDir = path.join(dir, 'src');
    const names = await fsp.readdir(srcDir);
    for (const name of names) {
      const st = await fsp.stat(path.join(srcDir, name));
      if (st.mtimeMs > built) return true;
    }
    // The rule packs are copied by the build, not emitted by tsc — a dist
    // without them starts fine and then reports Smart Suggestions as broken.
    return !(await exists(path.join(dir, 'dist', 'services', 'rulepacks')));
  } catch {
    return true; // unreadable is a reason to rebuild, not to guess
  }
}

export async function prepare(opts: PrepareOptions): Promise<Prepared> {
  if (!isAllowedRepositoryUrl(opts.repositoryUrl)) {
    throw new Error(
      `The configured treemap.repositoryUrl is not a git URL this extension will clone: ` +
        `"${opts.repositoryUrl}". Use an https:// or ssh git remote.`,
    );
  }
  if (!isAllowedGitRef(opts.gitRef)) {
    throw new Error(`The configured treemap.gitRef is not a valid branch or tag: "${opts.gitRef}".`);
  }

  const folders = await Promise.all(
    opts.workspaceFolders.map(async (p) => ({ path: p, tree: await inspectTree(p) })),
  );
  const source = chooseSource({
    workspaceFolders: folders,
    clonePath: opts.clonePath,
    useWorkspaceRepository: opts.useWorkspaceRepository,
  });
  const dir = source.path;

  const cloned = source.kind === 'clone';
  const present = await exists(path.join(dir, 'package.json'));
  const willClone = cloned && !present;
  // Only a clone is ever updated, and only when the user wants it kept current.
  const willUpdate = cloned && present && opts.autoUpdate;
  const willInstall = willClone || !(await exists(path.join(dir, 'node_modules')));
  // Decided BEFORE planning, not inside the loop. A step that is planned and
  // then skipped still owns its slice of the progress bar, so a warm start
  // would jump 72% in one tick — which reads as the bar being wrong. Source
  // that is not on disk yet obviously needs building; an update can move the
  // sources under us, so that forces one too.
  const willBuild = willClone || willUpdate || (await needsBuild(dir));

  const plan = planSteps({
    needsClone: willClone,
    // Only ever update a clone. Fetching and hard-resetting a developer's own
    // working tree would throw away uncommitted work — the single most
    // destructive thing this extension could do.
    needsUpdate: willUpdate,
    needsInstall: willInstall,
    needsBuild: willBuild,
  });

  const ctx = { repositoryUrl: opts.repositoryUrl, gitRef: opts.gitRef, dir };

  for (const step of plan) {
    if (opts.signal?.aborted) throw new Cancelled();
    opts.onStep(step);
    if (step.id === 'locate' || step.id === 'start') continue;
    if (step.id === 'clone') await fsp.mkdir(path.dirname(dir), { recursive: true });

    for (const cmd of commandsFor(step.id, ctx)) {
      const cwd = cmd.cwd === '.' ? path.dirname(dir) : dir;
      opts.onLog(`\n$ ${cmd.command} ${cmd.args.join(' ')}\n`);
      let result;
      try {
        result = await run(cmd.command, cmd.args, { cwd, onOutput: opts.onLog, signal: opts.signal });
      } catch (err) {
        if (err instanceof Cancelled) throw err;
        if (isMissingProgram(err)) {
          throw new Error(
            `${cmd.command} is not installed, or not on the PATH this editor sees. ` +
              `TreeMap needs git and Node 20+ to set itself up.`,
          );
        }
        throw err;
      }
      if (result.code !== 0) {
        // An update that fails is survivable — the existing clone still runs —
        // but a clone, install or build that fails is not.
        if (step.id === 'update') {
          opts.onLog('[treemap] could not update; continuing with the copy already here\n');
          break;
        }
        const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-6).join('\n');
        throw new Error(`${cmd.command} ${cmd.args[0]} failed (exit ${result.code}).\n${tail}`);
      }
    }
  }

  if (!fs.existsSync(path.join(dir, 'dist', 'index.js'))) {
    throw new Error(`TreeMap was set up in ${dir} but dist/index.js is still missing.`);
  }
  return { dir, source };
}

export type { Step, StepId };
