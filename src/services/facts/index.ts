import { registerFactProvider } from './registry';
import { sizeProvider } from './sizeProvider';
import { lastUsedProvider } from './lastUsedProvider';

/**
 * The fact layer's entry point (§4.1).
 *
 * Importing this module registers every built-in provider, exactly once. The
 * route imports from here rather than from `registry` directly, so there is a
 * single place where "which facts does this build ship?" is answered — and no
 * way for a provider to exist but never be registered, which is the shape of
 * bug that left `initFleet()` written and never called.
 *
 * Registration happens at module scope on purpose: `registerFactProvider`
 * throws on a duplicate id, and Node caches modules, so a second import is a
 * no-op rather than a crash.
 */

registerFactProvider(sizeProvider);
registerFactProvider(lastUsedProvider);

export {
  computeFacts,
  clearFactCache,
  factCacheSize,
  factProviderIds,
  getFactProvider,
  registerFactProvider,
  unregisterFactProvider,
} from './registry';
export type { ProviderResult } from './registry';
export type { FactBatch, FactProvider, FactStats } from './types';
export { unavailableBatch } from './types';
export type { SizeFact } from './sizeProvider';
export type { LastUsedFact } from './lastUsedProvider';
