import path from 'path';

/**
 * The program "Scan with TreeMap" starts (D2; hunt C11).
 *
 * The right-click entry launches `<program> <folder>`, which only the
 * installed desktop app understands: electron/main.js reads the folder from
 * its arguments and scans it. The server used to register `process.execPath`
 * whatever it ran under — `node` under `npm start`, so the entry ran
 * `node <folder>`, which executes that folder's index.js or package.json
 * `main`; Electron itself from source, which loads the folder as an app; or
 * a Linux AppImage's temporary mount, gone once TreeMap quits. Now the
 * packaged desktop app names itself in this variable before its in-process
 * server starts (the AppImage file, not its mount), and the entry is offered
 * only where one is named.
 */
export const DESKTOP_EXEC_ENV = 'TREEMAP_DESKTOP_EXEC';

/** Why the entry is not offered anywhere else, in words for the Settings panel. */
export const NOT_IN_DESKTOP_APP =
  'Only the installed TreeMap app can add the right-click entry, since the entry it adds starts that app; this TreeMap runs in a browser tab or from source.';

/** The installed app's own program, as it named itself, or null when this server does not run inside it. */
export function desktopLauncher(env: NodeJS.ProcessEnv = process.env): string | null {
  const exec = env[DESKTOP_EXEC_ENV];
  return typeof exec === 'string' && exec.length > 0 && path.isAbsolute(exec) ? exec : null;
}
