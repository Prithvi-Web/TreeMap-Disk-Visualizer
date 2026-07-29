import { initPortableMode } from '../services/portableMode';

/**
 * Decide portable mode (§D3) at import time, before any service resolves its
 * app-data directory.
 *
 * Imported for its side effect, second only to `ioThreads`, for the same
 * reason: by the time a writer asks `appDataDir()` where to write, the answer
 * must already be final. Doing this later would let the first write land on the
 * host machine — the one thing a portable session promises never to do.
 *
 * With no portable signal present this changes nothing at all, so an ordinary
 * install and every test behave exactly as before.
 */
initPortableMode();
