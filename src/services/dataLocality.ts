import { loadNative } from './scan/native';

/**
 * dataLocality — is a scanned file's data on this disk right now?
 *
 * Opening an online-only file makes iCloud Drive or OneDrive download it (the
 * master prompt §3.2, RISKS R1), and a sync client can evict a file after its
 * scan (RISKS R71), so the scan's placeholder flag is not the last word.
 * Every reader of file contents — the exact duplicate finder, the
 * near-duplicate pass, the duplicate viewer — asks here just before it reads,
 * and each asks the same way: of the file's directory entry, never by opening
 * it. One rule in one place, so no reader can drift into a looser one.
 */

/**
 * The ids of `bucket` whose data is on this disk right now, asked of each
 * file's directory entry through the native module; `gone` hears of each
 * whose data has left since the scan. One that cannot be asked about is left
 * out (no answer is not a yes). Without a module that can ask, the scan's
 * flags alone decide, as before.
 */
/**
 * Is one path's data on this disk right now? `true` or `false` as the file's
 * directory entry answers, asked the same way `stillLocal` asks; `null` when
 * nothing could answer (no module that can ask, the ask failed, the entry is
 * gone or unreadable). Never by opening the file.
 */
export function isLocalNow(filePath: string): boolean | null {
  const outcome = loadNative();
  const ask = outcome.available ? outcome.module.dataIsLocal : undefined;
  if (typeof ask !== 'function') return null;
  try {
    const answer = (ask as (paths: string[]) => Uint8Array)([filePath])[0];
    return answer === 1 ? true : answer === 0 ? false : null;
  } catch {
    return null;
  }
}

export function stillLocal(bucket: number[], pathOf: (id: number) => string, gone?: (id: number) => void): number[] {
  const outcome = loadNative();
  const ask = outcome.available ? outcome.module.dataIsLocal : undefined;
  if (typeof ask !== 'function') return bucket;
  let answers: Uint8Array;
  try {
    answers = (ask as (paths: string[]) => Uint8Array)(bucket.map(pathOf));
  } catch {
    return [];
  }
  return bucket.filter((id, i) => {
    if (answers[i] === 0) gone?.(id);
    return answers[i] === 1;
  });
}
