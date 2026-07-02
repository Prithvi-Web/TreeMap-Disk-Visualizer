import os from 'os';
import path from 'path';

/**
 * osPaths — small shared helpers for OS-specific filesystem locations.
 * Used by CleanupRules (cache suggestion rules) and AppAttribution (Apps tab)
 * so the platform knowledge lives in one place.
 */

/** Path equality respecting the platform's case sensitivity (Linux only). */
export function samePath(a: string, b: string): boolean {
  return process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();
}

/** %LOCALAPPDATA%, with the standard fallback for odd environments. */
export function winLocalAppData(): string {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

/** %APPDATA% (Roaming), with the standard fallback. */
export function winRoamingAppData(): string {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

/** Program Files directories that exist in this environment (64- and 32-bit). */
export function winProgramFilesDirs(): string[] {
  const dirs = [
    process.env.ProgramFiles || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  ];
  return [...new Set(dirs)];
}
