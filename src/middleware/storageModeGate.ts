import { Request, Response, NextFunction } from 'express';
import { peekScan, scanIdOf } from '../services/diskScanner';
import { ROUTE_FEATURES, storageModeOf, storageRefusal } from '../services/storageMode';
import { ScanResult } from '../models/types';

/**
 * storageModeGate — the availability table's refusal on HTTP (Phase 4 §S.7, P4-15).
 *
 * Placed in a route's chain right before its handler, after the path guards, on every route
 * whose feature can be `off` in some storage mode (`tests/storageModeTable.test.ts` holds
 * every such route to carrying it). It reads which feature the route serves from the table
 * by the route Express matched (`req.baseUrl` + `req.route.path`), so there is one source,
 * and answers 409 `{ error, code: 'STORAGE_MODE', mode, feature }` when a scan the request
 * names is kept in a mode where that feature is off.
 *
 * A request whose scans are all in memory mode (every scan, until T16's chooser) passes
 * before anything is looked up, so nothing the table says can change a memory-mode answer.
 * An unknown scan id passes too: the handler answers its 404 as it always has.
 */

/**
 * The scan ids a request can name, wherever the routes take them, each read as the handlers
 * read it (`scanIdOf`, which `requireScan` uses): a body `scanId` sent as `["<id>"]` finds its
 * scan in the handler, so it must find it here too.
 */
function scanIdsOf(req: Request): string[] {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const candidates: unknown[] = [
    req.params?.scanId,
    req.query.scanId,
    req.query.scanIdA,
    req.query.scanIdB,
    body.scanId,
  ];
  return [...new Set(candidates.map(scanIdOf).filter((id) => id.length > 0))];
}

/**
 * The route Express matched, in the table's spelling. HEAD is served by the GET route, and the
 * mount prefix is matched without regard to case (`/API/duplicates` reaches the `/api` router),
 * so it is read in lower case; the route's own path is its declaration, already the table's.
 */
function routeKeyOf(req: Request): string {
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  return `${method} ${req.baseUrl.toLowerCase()}${(req.route as { path: string }).path}`;
}

export function storageModeGate(req: Request, _res: Response, next: NextFunction): void {
  const scans = scanIdsOf(req)
    .map((id) => peekScan(id))
    .filter((scan): scan is ScanResult => scan !== undefined);
  if (scans.every((scan) => storageModeOf(scan) === 'memory')) {
    next();
    return;
  }
  const key = routeKeyOf(req);
  const entry = ROUTE_FEATURES[key];
  if (entry === undefined) {
    next(new Error(`the storage-mode gate guards ${key}, which the availability table does not classify`));
    return;
  }
  const refusal = storageRefusal(entry, {
    query: req.query as Record<string, unknown>,
    body: (req.body ?? {}) as Record<string, unknown>,
    scans,
  });
  if (refusal) next(refusal);
  else next();
}
