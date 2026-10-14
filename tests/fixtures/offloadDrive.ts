import { after } from 'node:test';
import { setOffloadDeviceForTests } from '../../src/services/offload';

/** The stand-in: every destination on drive 2, every selected item on drive 1. */
const anotherDrive = async (_p: string, end: 'source' | 'destination'): Promise<bigint | null> => (end === 'destination' ? 2n : 1n);

/**
 * Every offload destination in the calling test file sits on a drive of its own (fourth browser pass,
 * E01). An offload into the drive its files are on frees nothing, so the server refuses it
 * (DEST_SAME_VOLUME) — and every folder a test can make is on the runner's one drive. A file whose
 * offloads mean "to another drive" says so here, once, at its top; the refusal itself is driven
 * against the real disk in tests/offloadSameVolume.test.ts. Removed when the file's tests end.
 *
 * Import it after `isolatedDataDir(...)`, like any module that loads app code.
 */
export function destinationsOnAnotherDrive(): void {
  const restore = setOffloadDeviceForTests(anotherDrive);
  after(restore);
}

/** Runs `fn` with the real drives answering — the runner's one drive at both ends — then puts the stand-in back. */
export async function withRealDrives<T>(fn: () => Promise<T>): Promise<T> {
  setOffloadDeviceForTests(null);
  try {
    return await fn();
  } finally {
    setOffloadDeviceForTests(anotherDrive);
  }
}
