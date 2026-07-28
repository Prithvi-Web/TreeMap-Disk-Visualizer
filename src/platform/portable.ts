import { BaseProvider } from './base';
import type { PlatformName } from './types';

/**
 * PortableProvider — the base implementation, concrete.
 *
 * Used on platforms outside the supported three (FreeBSD, AIX, …). TreeMap's
 * core still works there: the portable enumerator, fs.watch, trash-by-`gio`.
 * Everything native reports itself unavailable with a reason. Booting with
 * reduced capabilities beats refusing to boot.
 *
 * `platform` reports 'linux' because that is the closest POSIX behaviour the
 * rest of the app should assume; the capability manifest carries the real
 * `process.platform` for anyone who needs the truth.
 */
export class PortableProvider extends BaseProvider {
  readonly platform: PlatformName = 'linux';
}
