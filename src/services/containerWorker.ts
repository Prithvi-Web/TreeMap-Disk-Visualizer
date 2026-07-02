import { parentPort, workerData } from 'worker_threads';
import { listZip, listTar, ArchiveListing } from '../utils/archive';

/**
 * containerWorker — archive directory parsing off the main thread. The
 * event loop keeps serving scans and SSE streams while a big central
 * directory or gzip stream is walked here.
 */

interface Job {
  kind: 'zip' | 'tar' | 'tgz';
  filePath: string;
}

const job = workerData as Job;

async function run(): Promise<ArchiveListing> {
  if (job.kind === 'zip') return listZip(job.filePath);
  return listTar(job.filePath, job.kind === 'tgz');
}

run()
  .then((listing) => parentPort!.postMessage({ ok: true, listing }))
  .catch((err: unknown) => parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }));
