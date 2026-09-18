/**
 * corpusWorker — creates one contiguous range of a corpus plan.
 *
 * The main thread has already made every directory. This worker walks its
 * file range in index order: plain and duplicate files get their bytes from
 * `contentBytes`, sparse files are `ftruncate`d and never written, and hard
 * links are made with `link` when their target lies in this range — a target
 * always precedes its link in the same directory — and left to the main
 * thread otherwise. The plan's arrays arrive as SharedArrayBuffer views, so
 * nothing is copied per worker.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { Role, contentBytes, fileName } from './corpus';
import type { WorkerJob, WorkerReply } from './corpus';

function isJob(value: unknown): value is WorkerJob {
  if (typeof value !== 'object' || value === null) return false;
  const j = value as Record<string, unknown>;
  return Number.isInteger(j.start) && Number.isInteger(j.end) && Array.isArray(j.dirPaths)
    && j.fileDir instanceof Int32Array && j.fileSize instanceof Float64Array && j.fileContent instanceof Uint32Array
    && j.fileRole instanceof Uint8Array && j.fileHardlinkOf instanceof Int32Array;
}

function createRange(job: WorkerJob): WorkerReply {
  const pathOf = (i: number): string => path.join(job.dirPaths[job.fileDir[i]], fileName(i));
  let written = 0;
  let bytes = 0;
  let deferredLinks = 0;
  for (let i = job.start; i < job.end; i++) {
    const role = job.fileRole[i];
    const target = pathOf(i);
    if (role === Role.sparse) {
      const fd = fs.openSync(target, 'w');
      try {
        fs.ftruncateSync(fd, job.fileSize[i]);
      } finally {
        fs.closeSync(fd);
      }
    } else if (role === Role.hardlink) {
      const source = job.fileHardlinkOf[i];
      if (source < job.start || source >= job.end) {
        deferredLinks++;
        continue;
      }
      fs.linkSync(pathOf(source), target);
    } else {
      const data = contentBytes(job.fileContent[i], job.fileSize[i]);
      fs.writeFileSync(target, data);
      bytes += data.length;
    }
    written++;
  }
  return { ok: true, written, bytes, deferredLinks };
}

if (!parentPort) throw new Error('corpusWorker must be started as a worker thread');
const port = parentPort;
try {
  if (!isJob(workerData)) throw new Error('corpusWorker received something other than a WorkerJob');
  port.postMessage(createRange(workerData));
} catch (err) {
  const reply: WorkerReply = { ok: false, error: err instanceof Error ? err.message : String(err) };
  port.postMessage(reply);
}
