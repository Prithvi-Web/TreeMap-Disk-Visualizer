'use strict';
/*
 * corpusWorkerEntry — the file a corpus worker thread is started from.
 *
 * A worker's entry file is resolved by Node's own module loader, and on
 * Node 20 that loader knows nothing about TypeScript: tsx installs its hook
 * through `--import`, which Node 22 and later pass on to worker threads and
 * Node 20 does not. A `.ts` entry therefore ran on the Node 24 that builds
 * this project and failed every CI leg, which runs Node 20, with
 * ERR_UNKNOWN_FILE_EXTENSION. This CommonJS file loads on every Node version,
 * installs tsx's require hook in the worker itself, and only then requires
 * the TypeScript worker through it. When bench/ has been compiled to
 * JavaScript there is no hook to install and the compiled file is required
 * directly.
 */
const fs = require('node:fs');
const path = require('node:path');

const source = path.join(__dirname, 'corpusWorker.ts');
if (fs.existsSync(source)) {
  require('tsx/cjs');
  require(source);
} else {
  require(path.join(__dirname, 'corpusWorker.js'));
}
