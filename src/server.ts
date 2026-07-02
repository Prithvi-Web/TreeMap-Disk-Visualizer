import './utils/ioThreads'; // must be first: sizes the fs threadpool before it exists
import express from 'express';
import path from 'path';
import http from 'http';
import { scanRouter, drainSseClients, activeSseCount } from './api/scanRoutes';
import { fileRouter } from './api/fileRoutes';
import { systemRouter } from './api/systemRoutes';
import { insightRouter } from './api/insightRoutes';
import { settingsRouter } from './api/settingsRoutes';
import { rateLimiter } from './middleware/rateLimiter';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { cancelAllScans } from './services/diskScanner';
import { cancelAllDuplicateJobs } from './services/duplicateFinder';
import { cancelAllNearDupeJobs } from './services/perceptualDupes';
import { startScheduler, stopScheduler } from './services/scheduler';

/**
 * Builds the Express app. Kept separate from the listen() call so the same
 * app can be started by the standalone server (src/index.ts) and embedded
 * inside the Electron desktop app (electron/main.js), which serves the
 * frontend from a different on-disk location.
 *
 * @param publicDir Absolute path to the folder holding index.html.
 */
export function createApp(publicDir: string): express.Express {
  const app = express();

  // This is a local tool; trust no proxies (req.ip = socket address).
  app.set('trust proxy', false);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '1mb' }));
  app.use('/api', rateLimiter);

  app.use('/api', scanRouter);
  app.use('/api', fileRouter);
  app.use('/api', systemRouter);
  app.use('/api', insightRouter);
  app.use('/api', settingsRouter);

  // Frontend: the single-file UI.
  app.use(express.static(publicDir, { index: 'index.html' }));

  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return app;
}

export interface RunningServer {
  server: http.Server;
  port: number;
  /** Drains SSE streams, cancels scans, and closes the server. */
  shutdown: () => void;
}

export interface StartOptions {
  publicDir: string;
  /** Port to bind. Use 0 to let the OS pick a free port (best for desktop). */
  port?: number;
  host?: string;
}

/** Start listening and resolve once the socket is bound. */
export function startServer(opts: StartOptions): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  const app = createApp(opts.publicDir);
  const server = http.createServer(app);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopScheduler(); // no new scheduled scans
    cancelAllScans(); // stop walkers cooperatively
    cancelAllDuplicateJobs(); // stop background hashing
    cancelAllNearDupeJobs(); // stop background image fingerprinting
    drainSseClients(); // send 'shutdown' event, then end each stream
    server.close();
    // Don't process.exit here — the caller (CLI or Electron) decides that.
  };

  // Recurring scans (and their growth alerts) live for the server's lifetime.
  startScheduler();

  return new Promise<RunningServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);
      resolve({ server, port, shutdown });
    });
  });
}

export { activeSseCount };
