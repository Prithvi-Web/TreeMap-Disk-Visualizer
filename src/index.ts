import path from 'path';
import { startServer, activeSseCount, RunningServer } from './server';

/**
 * Standalone web-server entry point (`npm start`).
 * The Electron desktop build uses electron/main.js instead, which calls
 * startServer() directly.
 */

const PORT = Number(process.env.PORT) || 4280;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

let running: RunningServer | null = null;

startServer({ port: PORT, host: HOST, publicDir: PUBLIC_DIR })
  .then((r) => {
    running = r;
    console.log(`TreeMap running → http://${HOST}:${r.port}`);
  })
  .catch((err: unknown) => {
    console.error('[treemap] failed to start:', err);
    process.exit(1);
  });

/* ------------------------- Graceful shutdown ------------------------- */

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[treemap] ${signal} received — draining ${activeSseCount()} SSE stream(s)…`);
  running?.shutdown();

  const done = (): void => {
    console.log('[treemap] all connections closed, bye');
    process.exit(0);
  };
  if (running) running.server.close(done);
  else done();

  // Hard deadline in case a keep-alive socket refuses to die.
  setTimeout(() => {
    console.log('[treemap] forcing exit after timeout');
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
