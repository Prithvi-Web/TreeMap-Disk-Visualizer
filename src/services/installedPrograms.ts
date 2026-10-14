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
 * `installedProgramOf` reads the path's names only — nothing on the disk — so
 * it costs nothing to ask about a whole selection; `installedProgramAt` also
 * asks where the path really is, a link in its folders followed. Three shapes
 * count, each strictly INSIDE the program, never the program itself (trashing
 * a whole Mac app is how a Mac uninstalls it):
 *
 *   - a Mac app bundle: a folder named `<Name>.app` that holds a bundle's own
 *     folder next in the path — `Contents` (a Mac app), or `Wrapper` and
 *     `WrappedBundle` (an iPhone or iPad app installed on a Mac). A folder
 *     merely named like one — a project named after its `.app` domain,
 *     `acme.app/node_modules/…` — is no app (review F1.3). The outermost
 *     bundle wins: Xcode.app's Simulator.app is part of Xcode, and removing
 *     it means removing Xcode. By the path's shape, on any system.
 *   - a Windows program's own folder under `X:\Program Files` or
 *     `X:\Program Files (x86)`, at the drive's top. A copy of that folder
 *     somewhere else is no installed program.
 *   - on Linux, `/usr` outside `/usr/local` and `/usr/src` (source code, a
 *     project's as often as a package's — Docker's `/usr/src/app`): the
 *     package manager's. Which package only the package manager knows, so it
 *     has no name here.
 *
 * What a program makes again on its own is no part of it: a Steam library's
 * shader caches (`steamapps/shadercache`), which the Games view offers to
 * clear, regenerate at the cost of one stutter.
 */

import { livesAt } from '../utils/pathSanitizer';

export type InstalledProgramKind = 'app' | 'program' | 'package';

export interface InstalledProgram {
  /** `app` a Mac app bundle; `program` a Windows program under Program Files; `package` Linux's /usr. */
  kind: InstalledProgramKind;
  /**
   * A Mac app as a person names it — "Google Chrome" for …/Google Chrome.app;
   * for a program under Program Files, the name of its folder there, which is
   * often its maker's ("Google" for Chrome), never to be said as the
   * program's name (review F1.11); null for /usr, where only the package
   * manager knows which package.
   */
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
  const program = installedProgramAt(entry.path);
  return program ? { ...entry, installedProgram: program } : entry;
}

/**
 * The program as the server's sentences name it: the app “Google Chrome”, a
 * program installed in “C:\Program Files\Google” (by its folder: Settings ›
 * Apps lists Google Chrome, not Google), or /usr's packages.
 */
export function programPhrase(p: InstalledProgram): string {
  if (p.kind === 'app') return `the app “${p.name}”`;
  if (p.kind === 'program') return `a program installed in “${p.root}”`;
  return 'the software your package manager installed in /usr';
}

/** A Mac app bundle's folder name: at least one character before ".app", in any case. */
const APP_BUNDLE = /^(.+)\.app$/i;
/** What a Mac app bundle holds directly, folded: `Contents` (a Mac app), `Wrapper` and `WrappedBundle` (an iPhone or iPad app on a Mac). */
const BUNDLE_HOLDS = new Set(['contents', 'wrapper', 'wrappedbundle']);
const PROGRAM_FILES = new Set(['program files', 'program files (x86)']);
/** Folders, one inside the other, whose files a program makes again on its own: a Steam library's shader caches. */
const REGENERABLE: ReadonlyArray<readonly [string, string]> = [['steamapps', 'shadercache']];

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
  const folded = names.map((n) => n.name.toLowerCase());
  // A shader cache is made again by the program that uses it: no part of it to keep.
  if (REGENERABLE.some(([outer, inner]) => folded.some((n, i) => n === outer && folded[i + 1] === inner))) return null;
  // Every name but the last: the program must hold the path, not be it — and
  // a bundle's own folder must come next, or the name is all it has of an app.
  for (let i = 0; i < names.length - 1; i++) {
    const app = APP_BUNDLE.exec(names[i].name);
    if (app && BUNDLE_HOLDS.has(folded[i + 1])) return { kind: 'app', name: app[1], root: filePath.slice(0, names[i].end) };
  }
  if (/^[A-Za-z]:$/.test(names[0]?.name ?? '') && names.length > 3 && PROGRAM_FILES.has(folded[1])) {
    return { kind: 'program', name: names[2].name, root: filePath.slice(0, names[2].end) };
  }
  if (platform === 'linux' && filePath.startsWith('/') && names.length > 1 && names[0].name === 'usr' && names[1].name !== 'local' && names[1].name !== 'src') {
    return { kind: 'package', name: null, root: '/usr' };
  }
  return null;
}

/**
 * The installed program `filePath` is a part of — by its spelling, and where
 * that names none, by where it really is: every link in its folders followed
 * (review F1.5). A folder reached through a link into an app
 * (`~/L/Resources`, `~/L` a link to `/Applications/Foo.app/Contents`) is that
 * app's, as every other rule that acts on a path judges it where it really
 * is; its `root` is then the app where it really is. This one reads the disk
 * (the folders' real paths, through the scanned-root rule's own memo).
 */
export function installedProgramAt(filePath: string, platform: NodeJS.Platform = process.platform): InstalledProgram | null {
  return installedProgramOf(filePath, platform) ?? installedProgramOf(livesAt(filePath), platform);
}
