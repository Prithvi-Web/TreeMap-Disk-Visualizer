'use strict';
/**
 * Development server with isolated app data.
 *
 * Why this exists rather than plain `npm start`: `startServer` calls
 * `startScheduler()`, which picks up the *user's real* recurring scans. A dev
 * server started from this repo therefore begins scanning the developer's home
 * directory, registers it as a legitimate scan root (which unlocks destructive
 * endpoints against it), and writes real entries into the real snapshots.json.
 * That has previously polluted a real user's scan history with test roots.
 *
 * Pointing TREEMAP_DATA_DIR somewhere disposable makes the dev server read and
 * write its own snapshots, settings, offload manifest, policy and audit log —
 * so nothing here can touch the installed app's state.
 *
 * Usage:  node scripts/dev-isolated.js [port]
 *         TREEMAP_DEV_DATA=/some/dir node scripts/dev-isolated.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const dataDir = process.env.TREEMAP_DEV_DATA || path.join(os.tmpdir(), 'treemap-dev-data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.TREEMAP_DATA_DIR = dataDir;

const port = Number(process.argv[2] || process.env.PORT || 4281);

const { startServer } = require(path.join(__dirname, '..', 'dist', 'server.js'));

startServer({ publicDir: path.join(__dirname, '..', 'public'), port, host: '127.0.0.1' })
  .then((running) => {
    console.log(`TreeMap dev server: http://127.0.0.1:${running.port}`);
    console.log(`Isolated app data:  ${dataDir}`);
    const stop = () => {
      running.shutdown();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  })
  .catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
