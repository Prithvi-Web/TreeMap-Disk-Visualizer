import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { accessAdvice, type Grantee } from '../../utils/accessAdvice';
import type { FullDiskAccessCapability } from '../types';

/**
 * Does this process have Full Disk Access? (Track U, U-11)
 *
 * macOS has no API that answers this, so the probe asks the one place that
 * answers it without side effects: the TCC folder, which macOS opens only for
 * a process with Full Disk Access. It opens the folder and closes it, reading
 * no entry. The system folder is asked first: on the owner's macOS 27 the
 * per-user one does not exist (ENOENT), and the system one refuses with EPERM
 * until access is granted (both checked by the plan's critic).
 *
 * It never touches Desktop, Documents or Downloads. Opening those raises a
 * macOS prompt, and a capability check must not ask the person anything.
 */

export const TCC_SYSTEM_DIR = '/Library/Application Support/com.apple.TCC';

/** The per-user TCC folder, asked when the system one gives no answer. */
export function tccUserDir(home: string): string {
  return path.join(home, 'Library', 'Application Support', 'com.apple.TCC');
}

/** What the probe needs of the file system, so a test can answer for it. */
export interface FdaProbeDeps {
  platform: NodeJS.Platform;
  homedir: () => string;
  opendir: (p: string) => Promise<{ close(): Promise<void>; read(): Promise<unknown> }>;
}

/** The probe's finding. `unavailable` is another OS: there is no such setting. */
export type FdaProbe =
  | { state: 'granted' | 'not-granted'; answeredBy: string }
  | { state: 'unknown'; reason: string }
  | { state: 'unavailable'; reason: string };

const DEFAULT_DEPS: FdaProbeDeps = {
  platform: process.platform,
  homedir: () => os.homedir(),
  opendir: (p) => fsp.opendir(p),
};

/** Open one folder and close it again: `'opened'`, or the errno it answered (`'?'` when it carried none). */
async function openAndClose(deps: FdaProbeDeps, dir: string): Promise<'opened' | string> {
  let handle;
  try {
    handle = await deps.opendir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return typeof code === 'string' && code ? code : '?';
  }
  // Opened is the answer; a close that fails afterwards does not change it.
  await handle.close().catch(() => undefined);
  return 'opened';
}

/** Ask the system TCC folder, then the per-user one: the first yes or no wins. */
export async function probeFullDiskAccess(overrides: Partial<FdaProbeDeps> = {}): Promise<FdaProbe> {
  const deps: FdaProbeDeps = { ...DEFAULT_DEPS, ...overrides };
  if (deps.platform !== 'darwin') {
    return { state: 'unavailable', reason: 'Full Disk Access is a macOS setting.' };
  }
  const answers: string[] = [];
  for (const dir of [TCC_SYSTEM_DIR, tccUserDir(deps.homedir())]) {
    const answer = await openAndClose(deps, dir);
    if (answer === 'opened') return { state: 'granted', answeredBy: dir };
    if (answer === 'EPERM') return { state: 'not-granted', answeredBy: dir };
    answers.push(answer);
  }
  return {
    state: 'unknown',
    reason: `the two folders it checks answered ${answers.join(' and ')}, which says neither yes nor no`,
  };
}

const MECHANISM = "opening macOS's privacy (TCC) folder, reading nothing";

/**
 * The capability `GET /api/platform/capabilities` serves.
 *
 * `available` is true only when granted. `advice` is the sentence for a count
 * of refused folders under this state, from the one builder, so the page's
 * hint never words it on its own.
 */
export function fullDiskAccessCapability(probe: FdaProbe, grantee: Grantee): FullDiskAccessCapability {
  if (probe.state === 'unavailable') {
    return {
      available: false,
      mechanism: 'none',
      state: 'unknown',
      grantee: grantee.name,
      reason: 'Full Disk Access is a macOS setting, and this system has nothing like it to check.',
    };
  }
  const advice = accessAdvice({ code: null, state: probe.state, grantee, retry: 'scan again' });
  const who = grantee.desktop ? 'TreeMap' : grantee.name.charAt(0).toUpperCase() + grantee.name.slice(1);
  if (probe.state === 'unknown') {
    return {
      available: false,
      mechanism: MECHANISM,
      state: 'unknown',
      grantee: grantee.name,
      reason: `TreeMap could not tell whether Full Disk Access is on: ${probe.reason}.`,
      advice,
    };
  }
  if (probe.state === 'granted') {
    return { available: true, mechanism: MECHANISM, state: 'granted', grantee: grantee.name, advice };
  }
  return {
    available: false,
    mechanism: MECHANISM,
    state: 'not-granted',
    grantee: grantee.name,
    reason: `${who} does not have Full Disk Access, so macOS keeps TreeMap out of the folders it protects (Mail, Messages, Safari, the Trash) and a scan cannot count them.`,
    advice,
  };
}
