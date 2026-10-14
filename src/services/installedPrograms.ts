/**
 * Which installed program a path is a part of (fifth browser pass F01).
 *
 * "Move to Trash" on a file INSIDE an installed app — Chrome's framework,
 * WhatsApp.app/Contents/MacOS/WhatsApp, an app.asar — is two clicks from
 * breaking that app, and the sheet said nothing of it. This is the one
 * detector every place that needs the answer asks: the Trash sheets (through
 * POST /api/files/installed-programs), the dry-run manifests of
 * DELETE /api/files, trash_paths and the cart, Autopilot (which never selects
 * such a file), and the Security panel's "belongs to an installed program"
 * rule. A second copy anywhere would be a second answer.
 *
 * It reads the path only — nothing on the disk — so it costs nothing to ask
 * about a whole selection. Three shapes count, each strictly INSIDE the
 * program, never the program itself (trashing a whole Mac app is how a Mac
 * uninstalls it):
 *
 *   - a Mac app bundle: a folder named `<Name>.app`. The outermost one wins —
 *     Xcode.app's Simulator.app is part of Xcode, and removing it means
 *     removing Xcode. By the path's shape, on any system, as the Security
 *     panel has always judged it.
 *   - a Windows program's own folder under `X:\Program Files` or
 *     `X:\Program Files (x86)`, at the drive's top. A copy of that folder
 *     somewhere else is no installed program.
 *   - on Linux, `/usr` outside `/usr/local`: the package manager's. Which
 *     package only the package manager knows, so it has no name here.
 */

export type InstalledProgramKind = 'app' | 'program' | 'package';

export interface InstalledProgram {
  /** `app` a Mac app bundle; `program` a Windows program under Program Files; `package` Linux's /usr. */
  kind: InstalledProgramKind;
  /** As a person names it — "Google Chrome" for …/Google Chrome.app, the program's folder under Program Files — or null for /usr, where only the package manager knows which package. */
  name: string | null;
  /** The whole program, spelled as the path spells it: the .app bundle, the program's folder, or /usr. */
  root: string;
}

/**
 * A manifest entry with the program it is a part of beside it, when it is one
 * (`installedProgram`); unchanged otherwise, so a manifest of ordinary files
 * reads exactly as it always did.
 */
export function withInstalledProgram<T extends { path: string }>(entry: T): T & { installedProgram?: InstalledProgram } {
  const program = installedProgramOf(entry.path);
  return program ? { ...entry, installedProgram: program } : entry;
}

/** The program as the server's sentences name it: the app “Google Chrome”, the program “Steam” in Program Files, or /usr's packages. */
export function programPhrase(p: InstalledProgram): string {
  if (p.kind === 'app') return `the app “${p.name}”`;
  if (p.kind === 'program') return `the program “${p.name}” in Program Files`;
  return 'the software your package manager installed in /usr';
}

/** A Mac app bundle's folder name: at least one character before ".app", in any case. */
const APP_BUNDLE = /^(.+)\.app$/i;
const PROGRAM_FILES = new Set(['program files', 'program files (x86)']);

/** The path's names, each with where it ends in the path — so a root is a slice of the path as spelled. */
function namesOf(p: string): { name: string; end: number }[] {
  return [...p.matchAll(/[^\\/]+/g)].map((m) => ({ name: m[0], end: (m.index ?? 0) + m[0].length }));
}

/**
 * The installed program `filePath` is a part of, or null. `platform` decides
 * only whether /usr is a package manager's (Linux); the other two shapes are
 * read from the path itself.
 */
export function installedProgramOf(filePath: string, platform: NodeJS.Platform = process.platform): InstalledProgram | null {
  const names = namesOf(filePath);
  // Every name but the last: the program must hold the path, not be it.
  for (let i = 0; i < names.length - 1; i++) {
    const app = APP_BUNDLE.exec(names[i].name);
    if (app) return { kind: 'app', name: app[1], root: filePath.slice(0, names[i].end) };
  }
  if (/^[A-Za-z]:$/.test(names[0]?.name ?? '') && names.length > 3 && PROGRAM_FILES.has(names[1].name.toLowerCase())) {
    return { kind: 'program', name: names[2].name, root: filePath.slice(0, names[2].end) };
  }
  if (platform === 'linux' && filePath.startsWith('/') && names.length > 1 && names[0].name === 'usr' && names[1].name !== 'local') {
    return { kind: 'package', name: null, root: '/usr' };
  }
  return null;
}
