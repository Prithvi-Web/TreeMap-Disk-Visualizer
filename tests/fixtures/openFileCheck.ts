import { platform } from '../../src/platform';
import { invalidateCapabilities } from '../../src/platform/capabilities';

/**
 * Runs `fn` with the open-file check (B2) answering `answer`: 'clear' (checked, nothing open) or
 * 'fails' (the probe could not run). An Autopilot run is unattended, and an unattended delete moves
 * nothing when the check could not run — so a test that means to trash must say what the check
 * answers, or it depends on the machine (CI run 36663542819: the Windows runner's Restart Manager
 * answered "couldn't check"). The same stand-in as tests/capsuleAfterTrash.test.ts's own.
 */
export async function withOpenFileCheck<T>(answer: 'clear' | 'fails', fn: () => Promise<T>): Promise<T> {
  const provider = platform() as unknown as {
    getOpenHandlesBatch: (paths: string[]) => Promise<unknown>;
    probeOpenHandleGuard: () => Promise<unknown>;
  };
  const batch = provider.getOpenHandlesBatch.bind(provider);
  const probe = provider.probeOpenHandleGuard.bind(provider);
  provider.getOpenHandlesBatch = answer === 'fails'
    ? () => Promise.reject(new Error('the probe did not answer (a test)'))
    : () => Promise.resolve({ handles: [], complete: true });
  provider.probeOpenHandleGuard = () => Promise.resolve({ available: true, mechanism: 'test' });
  invalidateCapabilities();
  try {
    return await fn();
  } finally {
    provider.getOpenHandlesBatch = batch;
    provider.probeOpenHandleGuard = probe;
    invalidateCapabilities();
  }
}
