import express from 'express';
import path from 'path';
import http from 'http';
import { scanRouter, drainSseClients, activeSseCount } from './api/scanRoutes';
import { fileRouter } from './api/fileRoutes';
import { systemRouter } from './api/systemRoutes';
import { rateLimiter } from './middleware/rateLimiter';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { cancelAllScans } from './services/diskScanner';

const PORT = Number(process.env.PORT) || 4280;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();

// This is a local tool; trust no proxies (req.ip = socket address).
app.set('trust proxy', false);
app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));
app.use('/api', rateLimiter);

app.use('/api', scanRouter);
app.use('/api', fileRouter);
app.use('/api', systemRouter);

// Frontend: one static file, served from /public.
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

app.use('/api', notFoundHandler);
app.use(errorHandler);

const server = http.createServer(app);
server.listen(PORT, HOST, () => {
  console.log(`TreeMap running → http://${HOST}:${PORT}`);
});

/* ------------------------- Graceful shutdown ------------------------- */

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[treemap] ${signal} received — draining ${activeSseCount()} SSE stream(s)…`);

  cancelAllScans(); // stop walkers cooperatively
  drainSseClients(); // send 'shutdown' event, then end each stream

  server.close(() => {
    console.log('[treemap] all connections closed, bye');
    process.exit(0);
  });

  // Hard deadline in case a keep-alive socket refuses to die.
  setTimeout(() => {
    console.log('[treemap] forcing exit after timeout');
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
