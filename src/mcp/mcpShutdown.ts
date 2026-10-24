import { trashCallsInFlight } from './server';
import { cancelAllScans } from '../services/diskScanner';
import { cancelAllDuplicateJobs } from '../services/duplicateFinder';
import { anyOffloadJobRunning, cancelAllOffloadJobs } from '../services/offload';
import { shutdownWhenSettled, type ShutdownSteps } from './shutdown';

/**
 * The MCP process's shutdown (hunt C58): what it cancels — scans, duplicate hashing and offloads,
 * which then roll back — and what it waits on before it exits: an offload still running (a cancelled
 * one until it has rolled back and saved its record) and a trash_paths call still in flight. It runs
 * once however many signals arrive: SIGINT, SIGTERM and stdin closing each call it, and a second
 * call answers the first one's promise rather than starting a second shutdown.
 *
 * Built here rather than in index.ts, which starts the server when it is loaded, so a test drives
 * the very steps the process runs (review F1.11).
 */
export function createMcpShutdown(options: Pick<ShutdownSteps, 'exit' | 'now' | 'sleep' | 'log'>): () => Promise<void> {
  let running: Promise<void> | null = null;
  return () => {
    running ??= shutdownWhenSettled({
      ...options,
      cancel: () => {
        cancelAllScans();
        cancelAllDuplicateJobs();
        cancelAllOffloadJobs();
      },
      busy: () => anyOffloadJobRunning() || trashCallsInFlight() > 0,
    });
    return running;
  };
}
