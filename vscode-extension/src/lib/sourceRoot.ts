/**
 * Deciding which TreeMap source tree to run, and validating it.
 *
 * Pure: no `vscode`, no filesystem. Callers hand in what they found on disk so
 * this stays unit-testable from the main repository's suite.
 */

/** The files that together mean "this directory really is TreeMap". */
export interface TreeTest {
  hasPackageJson: boolean;
  /** package.json's "name" field, if it parsed. */
  packageName?: string;
  hasPublicIndexHtml: boolean;
  hasSrcServer: boolean;
}

/**
 * True only when every marker is present.
 *
 * All four are checked because each rules out a different wrong answer: a
 * directory that merely shares the name, a half-deleted clone, and — the one
 * that matters most — a workspace that happens to sit where an abandoned
 * checkout used to be. The extension is about to run `npm install` in this
 * directory and execute the result, so "probably TreeMap" is not good enough.
 */
export function isTreeMapCheckout(t: TreeTest): boolean {
  return (
    t.hasPackageJson &&
    t.packageName === 'treemap' &&
    t.hasPublicIndexHtml &&
    t.hasSrcServer
  );
}

export type SourceChoice =
  | { kind: 'workspace'; path: string; reason: string }
  | { kind: 'clone'; path: string; reason: string };

/**
 * Prefer the open workspace when it IS the TreeMap repository.
 *
 * A TreeMap developer who opens their own repo and runs this extension should
 * see the code in front of them, not a month-old clone of `main` sitting in
 * extension storage — that divergence is a genuinely confusing bug to chase.
 * Everyone else gets the clone, which is the normal path.
 */
export function chooseSource(opts: {
  workspaceFolders: { path: string; tree: TreeTest }[];
  clonePath: string;
  useWorkspaceRepository: boolean;
}): SourceChoice {
  if (opts.useWorkspaceRepository) {
    for (const folder of opts.workspaceFolders) {
      if (isTreeMapCheckout(folder.tree)) {
        return {
          kind: 'workspace',
          path: folder.path,
          reason: 'this workspace is the TreeMap repository',
        };
      }
    }
  }
  return { kind: 'clone', path: opts.clonePath, reason: 'using the extension’s own copy' };
}

/**
 * Whitespace or an ASCII control character — never legitimate in a git URL.
 *
 * Written as an explicit code-point scan rather than a regular expression
 * character class: the class would have to contain a literal control-character
 * range, which is invisible in a diff and trivially mangled by an editor or a
 * line-ending filter. This says exactly what it means and survives review.
 */
function hasSpaceOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Only https:// and ssh git remotes, and only ones the user configured.
 *
 * The extension clones this URL and then EXECUTES what it downloads, so the
 * setting is a code-execution surface. A bad value is refused rather than
 * normalised: a silently-corrected dangerous setting is worse than a rejected
 * one, because the user never learns their setting was wrong.
 *
 * Note the hyphen rule is about the FIRST character only — git reads a leading
 * dash as an option. Hyphens elsewhere are ordinary; the real repository name
 * contains two of them.
 */
export function isAllowedRepositoryUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed !== url || !trimmed) return false;
  if (trimmed.startsWith('-') || hasSpaceOrControl(trimmed)) return false;
  if (/^https:\/\/[^/@]+(\/[^\s]*)?$/.test(trimmed)) return true;
  if (/^ssh:\/\/[^/]+\/.+$/.test(trimmed)) return true;
  if (/^git@[^:]+:.+$/.test(trimmed)) return true;
  return false;
}

/** A git ref the extension will check out. Same reasoning as the URL. */
export function isAllowedGitRef(ref: string): boolean {
  const trimmed = ref.trim();
  if (trimmed !== ref || !trimmed || trimmed.length > 250) return false;
  if (trimmed.startsWith('-') || trimmed.includes('..')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(trimmed);
}
