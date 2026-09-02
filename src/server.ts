import './utils/ioThreads'; // must be first: sizes the fs threadpool before it exists
import './utils/portableBoot'; // must be second: redirects app-data before any writer resolves it
import express from 'express';
import path from 'path';
import http from 'http';
import { scanRouter, drainSseClients, activeSseCount } from './api/scanRoutes';
import { fileRouter } from './api/fileRoutes';
import { systemRouter } from './api/systemRoutes';
import { insightRouter } from './api/insightRoutes';
import { fleetRouter } from './api/fleetRoutes';
import { initFleet, fleetRuntime } from './services/fleet/fleetRuntime';
import { settingsRouter } from './api/settingsRoutes';
import { watchRouter, drainWatchClients } from './api/watchRoutes';
import { offloadRouter, drainOffloadClients } from './api/offloadRoutes';
import { cloudRouter } from './api/cloudRoutes';
import { metaRouter } from './api/metaRoutes';
import { journalRouter } from './api/journalRoutes';
import { platformRouter } from './api/platformRoutes';
import { indexRouter, drainIndexClients, cancelAllIndexJobs } from './api/indexRoutes';
import { timeCapsuleRouter, drainCapsuleClients } from './api/timeCapsuleRoutes';
import { autopilotRouter } from './api/autopilotRoutes';
import { zombieRouter } from './api/zombieRoutes';
import { factRouter } from './api/factRoutes';
import { queryRouter } from './api/queryRoutes';
import { cartRouter } from './api/cartRoutes';
import { noteRouter } from './api/noteRoutes';
import { closeIndex } from './services/indexEngine';
import { stopOAuth } from './services/cloud/oauth';
import { rateLimiter } from './middleware/rateLimiter';
import { corsMiddleware } from './middleware/cors';
import { hostGuard } from './middleware/hostGuard';
import { requireToken, uiAuthCookie } from './middleware/requireToken';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { cancelAllScans } from './services/diskScanner';
import { cancelAllDuplicateJobs } from './services/duplicateFinder';
import { cancelAllNearDupeJobs } from './services/perceptualDupes';
import { stopAllWatchers } from './services/watcher';
import { cancelAllOffloadJobs } from './services/offload';
import { cancelAllCapsuleJobs, startCapsuleMaintenance, stopCapsuleMaintenance } from './services/timeCapsule';
import { startScheduler, stopScheduler } from './services/scheduler';
import { cancelAllEncodeJobs, drainEncodeClients } from './services/compressionAdvisor';

/**
 * Builds the Express app. Kept separate from the listen() call so the same
 * app can be started by the standalone server (src/index.ts) and embedded
 * inside the Electron desktop app (electron/main.js), which serves the
 * frontend from a different on-disk location.
 *
 * @param publicDir Absolute path to the folder holding index.html.
 * @param opts.host The address the server binds (default 127.0.0.1). Decides
 *                  which Host headers are answered — see middleware/hostGuard.
 */
export interface AppOptions {
  host?: string;
}

/**
 * The page's Content-Security-Policy: the single-file, no-external-resources
 * contract, enforced by the browser on every load rather than only by a test.
 *
 * What the page needs: inline script and styles (it is one file), a Worker
 * built from a blob: URL (the GIF encoder — worker-src falls back to
 * script-src without this and the export dies silently), blob:/data: images
 * (favicon, exports, thumbnails), same-origin fetch and EventSource. Nothing
 * may reach another host: a future slip in one of the page's innerHTML sites
 * can no longer phone home.
 *
 * frame-ancestors is opt-in (TREEMAP_FRAME_ANCESTORS, e.g. 'none' for a
 * hardened server profile) because the VS Code extension frames this page from
 * its webview origin; sending 'none' by default would blank that panel.
 */
export function contentSecurityPolicy(): string {
  const base =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src blob:; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; " +
    "font-src 'self' data:; object-src 'none'; base-uri 'none'";
  const ancestors = process.env.TREEMAP_FRAME_ANCESTORS?.trim();
  return ancestors ? `${base}; frame-ancestors ${ancestors}` : base;
}

export function createApp(publicDir: string, opts: AppOptions = {}): express.Express {
  const app = express();

  // This is a local tool; trust no proxies (req.ip = socket address) — unless
  // the operator says there is exactly one in front (TREEMAP_TRUST_PROXY=1),
  // so the rate limiter buckets by the client and not by the proxy.
  app.set('trust proxy', process.env.TREEMAP_TRUST_PROXY === '1' ? 1 : false);
  app.disable('x-powered-by');

  // First, before the body is even parsed: a request that names another host
  // (DNS rebinding) gets nothing — no page, no cookie, no API.
  app.use(hostGuard(opts.host ?? '127.0.0.1'));

  app.use(express.json({ limit: '1mb' }));
  // Restore the express-4 body invariant: `req.body` is always an object.
  //
  // express@5 ships body-parser@2, which changed this. Where express 4 left
  // `req.body = {}` for a request the parser skipped, body-parser 2 leaves it
  // `undefined` — and it skips every request whose Content-Type isn't JSON:
  // no header at all (`curl -X POST /api/trash/empty`), text/plain, a form
  // post, a bare probe. Every handler here was written against the old
  // invariant and destructures the body on its first line
  // (`const { confirm } = req.body as ...`), so `undefined` throws a
  // TypeError the error handler can't recognise and the caller gets a 500
  // INTERNAL where the API documents a 400 with a specific code.
  //
  // This is NOT dead code and must not be deleted: without it the validation
  // branch in every body-taking route is unreachable for exactly the clients
  // most likely to get the request wrong. It only ever fills in a body the
  // parser declined to produce — a parsed body is left untouched — and it
  // allocates a fresh object per request so nothing a handler writes back
  // into `req.body` (pathGuard rewrites `body.path` in place) can leak into
  // the next caller's request.
  app.use((req, _res, next) => {
    if (req.body === undefined) req.body = {};
    next();
  });
  // Both are no-ops until their env vars are set (TREEMAP_ALLOWED_ORIGINS /
  // TREEMAP_TOKEN) — with them unset the app behaves exactly as before.
  app.use('/api', corsMiddleware);
  app.use('/api', rateLimiter);
  app.use('/api', requireToken);

  app.use('/api', scanRouter);
  app.use('/api', fileRouter);
  app.use('/api', systemRouter);
  app.use('/api', insightRouter);
  app.use('/api', fleetRouter);
  app.use('/api', settingsRouter);
  app.use('/api', watchRouter);
  app.use('/api', offloadRouter);
  app.use('/api', cloudRouter);
  app.use('/api', metaRouter);
  app.use('/api', journalRouter);
  app.use('/api', platformRouter);
  app.use('/api', indexRouter);
  app.use('/api', timeCapsuleRouter);
  app.use('/api', autopilotRouter);
  app.use('/api', zombieRouter);
  app.use('/api', factRouter);
  app.use('/api', queryRouter);
  app.use('/api', cartRouter);
  app.use('/api', noteRouter);

  // Frontend: the single-file UI. When token auth is enabled, serving the
  // page also hands the browser its session cookie (R2 — the frozen UI keeps
  // calling its own backend without modification).
  app.use(uiAuthCookie);
  app.use(
    express.static(publicDir, {
      index: 'index.html',
      setHeaders: (res, filePath) => {
        // Only a document can carry a CSP; JSON, images and the like need none.
        if (filePath.endsWith('.html')) res.setHeader('Content-Security-Policy', contentSecurityPolicy());
      },
    }),
  );

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
  const app = createApp(opts.publicDir, { host });
  const server = http.createServer(app);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopScheduler(); // no new scheduled scans
    cancelAllScans(); // stop walkers cooperatively
    cancelAllDuplicateJobs(); // stop background hashing
    cancelAllNearDupeJobs(); // stop background image fingerprinting
    stopAllWatchers(); // close live-activity watchers ('paused' to clients)
    cancelAllOffloadJobs(); // in-flight copies roll back cooperatively
    cancelAllIndexJobs(); // half-built indexes roll back; startup discards them
    cancelAllCapsuleJobs(); // in-flight restores roll back what they wrote
    cancelAllEncodeJobs(); // stop ffmpeg re-encodes; a half-written output is discarded
    stopCapsuleMaintenance(); // stop the retention sweep
    stopOAuth(); // close any pending sign-in listener
    void fleetRuntime().stop(); // close the LAN listener and stop advertising
    drainSseClients(); // send 'shutdown' event, then end each stream
    drainWatchClients(); // end live-activity streams
    drainOffloadClients(); // end offload progress streams
    drainIndexClients(); // end index-build progress streams
    drainCapsuleClients(); // end Time Capsule restore streams
    drainEncodeClients(); // end compression progress streams
    // Closes the index database and detaches its live watchers. Roots left
    // 'ready' are marked stale on next open, since nothing was watching them
    // while the app was down.
    closeIndex();
    server.close();
    // Don't process.exit here — the caller (CLI or Electron) decides that.
  };

  // Recurring scans (and their growth alerts) live for the server's lifetime.
  startScheduler();
  // Sweeps Time Capsule entries past their retention window, and reconciles
  // the capsule against its index once at startup (B3).
  startCapsuleMaintenance();
  // D1: bring the fleet listener up ONLY if the user had already turned it on.
  // Fire-and-forget and never fatal — the fleet view is an extra, and a taken
  // port or an unreachable multicast group must not stop TreeMap starting.
  void initFleet();

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
