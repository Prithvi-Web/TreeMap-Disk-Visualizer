import { Router, Request, Response } from 'express';
import { clampInt } from './scanRoutes';
import { AppError } from '../middleware/errorHandler';
import { parse, factsNeeded, FIELD_NAMES, FIELDS } from '../services/query/parse';
import { toSql } from '../services/query/toSql';
import { executeAgainstScan, type SortKey } from '../services/query/execute';
import { deleteSavedQuery, listSavedQueries, saveQuery } from '../services/query/savedQueries';

/**
 * queryRoutes — the query grammar's HTTP surface (v4 §2.2, §2.3).
 *
 * `POST /api/query/validate` exists separately from `POST /api/query` for one
 * reason: the frontend calls it on a 150 ms debounce while the user types, and
 * parse-only must not be able to start a tree walk. It is the cheapest
 * endpoint in the app by design.
 */

export const queryRouter = Router();

const SORTS: SortKey[] = ['size', 'name', 'modified', 'path'];

/**
 * Why a field needed work beyond the scan tree.
 *
 * Deliberately about the in-memory path, because that is the one
 * `POST /api/query` currently takes. The SQL planner in `toSql.ts` has its own
 * reasons, for the index path — which is built and tested but not yet wired to
 * a route.
 */
const BEYOND_TREE_REASONS: Record<string, string> = {
  lastUsed: 'last-opened dates are read per file after the scan is walked',
  recoverability: 'git, backup and cloud status are read per file after the scan is walked',
  reclaimScore: 'reclaim scores are computed per file after the scan is walked, from six signals that each cost something',
  duplicates: 'duplicate detection is a separate job and is not wired into queries yet',
};

/** The parse-error envelope §2.2 specifies: flat, plus the span and the fix. */
function parseErrorBody(error: string, offset: number, length: number, expected: string[]): Record<string, unknown> {
  return { ok: false, code: 'QUERY_PARSE_ERROR', error, offset, length, expected };
}

/**
 * POST /api/query/validate  { q } -> 200 { ok, fields } | 400 { ok:false, ... }
 *
 * Parse only. Never touches a scan, never walks a tree.
 */
queryRouter.post('/query/validate', (req: Request, res: Response) => {
  const { q } = req.body as { q?: unknown };
  if (typeof q !== 'string') throw new AppError(400, 'QUERY_REQUIRED', 'Request body must include a "q" string');

  const parsed = parse(q);
  if (!parsed.ok) {
    res.status(400).json(parseErrorBody(parsed.error, parsed.offset, parsed.length, parsed.expected));
    return;
  }
  const plan = toSql(parsed.ast);
  res.json({
    ok: true,
    // What a query against a scan would need beyond the tree itself...
    postFiltered: [...factsNeeded(parsed.ast)].sort(),
    // ...and, separately, what the SQLite index could not answer. Kept apart
    // because they are answers about two different engines, and merging them
    // would let a caller attribute one path's cost to the other.
    indexPostFiltered: plan.postFiltered,
    fields: FIELD_NAMES,
  });
});

/**
 * GET /api/query/fields -> the grammar, for autocomplete and the help panel.
 *
 * Served rather than duplicated in the frontend: §7 forbids a second query
 * language, and a hand-maintained copy of the field list in `index.html` is
 * exactly how one starts.
 */
queryRouter.get('/query/fields', (_req: Request, res: Response) => {
  res.json({
    fields: FIELD_NAMES.map((name) => ({
      name,
      help: FIELDS[name].help,
      values: FIELDS[name].values ? [...FIELDS[name].values!] : [],
      operators: FIELDS[name].ops.map((o) => (o === '=' ? ':' : o)),
    })),
  });
});

/**
 * POST /api/query  { scanId, q, limit?, offset?, sort? }
 *
 * `degraded` is the field that matters: a query needing a signal this machine
 * cannot supply comes back with an explicit warning rather than an empty list
 * that reads as "nothing matched" (§2.2).
 */
queryRouter.post('/query', async (req: Request, res: Response) => {
  const body = req.body as { scanId?: unknown; q?: unknown; limit?: unknown; offset?: unknown; sort?: unknown };

  if (typeof body.q !== 'string') throw new AppError(400, 'QUERY_REQUIRED', 'Request body must include a "q" string');
  if (typeof body.scanId !== 'string' || body.scanId.length === 0) {
    throw new AppError(400, 'SCAN_REQUIRED', 'Request body must include a "scanId" — scan a folder first');
  }

  const parsed = parse(body.q);
  if (!parsed.ok) {
    res.status(400).json(parseErrorBody(parsed.error, parsed.offset, parsed.length, parsed.expected));
    return;
  }

  const sort = SORTS.includes(body.sort as SortKey) ? (body.sort as SortKey) : 'size';
  const limit = clampInt(body.limit, 200, 1, 1000);
  const offset = clampInt(body.offset, 0, 0, 100_000);

  // A client that navigates away should stop the walk, not just stop reading
  // it — a query over a million-node scan is real work.
  const controller = new AbortController();
  const onClose = (): void => controller.abort();
  res.on('close', onClose);

  try {
    const outcome = await executeAgainstScan(body.scanId, parsed.ast, { limit, offset, sort, signal: controller.signal });
    if ('error' in outcome) throw new AppError(outcome.code === 'SCAN_NOT_FOUND' ? 404 : 409, outcome.code, outcome.error);

    // `postFiltered` describes THIS run, which walked the scan in memory.
    //
    // It used to be taken from `toSql`, whose answer is about the SQLite index
    // — a query that did not happen here. Reporting "the index does not store
    // depth" after an in-memory walk is a true sentence about the wrong thing,
    // and for `size>1gb` it implied a pushdown that never occurred. What is
    // reported now is what the scan tree itself could not answer.
    const beyondTheTree = [...factsNeeded(parsed.ast)].sort();
    res.json({
      ok: true,
      total: outcome.total,
      truncated: outcome.truncated,
      examined: outcome.examined,
      postFiltered: beyondTheTree,
      postFilterReasons: beyondTheTree.map((f) => ({ field: f, reason: BEYOND_TREE_REASONS[f] ?? 'read from the fact layer after the scan was walked' })),
      degraded: outcome.degraded,
      hits: outcome.hits,
    });
  } finally {
    res.off('close', onClose);
  }
});

/* ------------------------------ saved queries ------------------------------ */

queryRouter.get('/queries', async (_req: Request, res: Response) => {
  res.json({ queries: await listSavedQueries() });
});

queryRouter.post('/queries', async (req: Request, res: Response) => {
  const body = req.body as { name?: unknown; q?: unknown; pinned?: unknown; colour?: unknown };
  const result = await saveQuery(body);
  if (!result.ok) {
    // A query that does not parse is refused here rather than at first use:
    // a saved query becomes a Clean Up rule and then an Autopilot policy, and
    // save time is the only moment a person is present to fix it.
    res.status(400).json({
      ok: false, code: result.code, error: result.error,
      ...(result.offset !== undefined ? { offset: result.offset } : {}),
      ...(result.expected !== undefined ? { expected: result.expected } : {}),
    });
    return;
  }
  res.status(201).json({ query: result.query });
});

queryRouter.delete('/queries/:id', async (req: Request, res: Response) => {
  const removed = await deleteSavedQuery(String(req.params.id));
  if (!removed) throw new AppError(404, 'SAVED_QUERY_NOT_FOUND', 'No saved view with that id');
  res.json({ deleted: true });
});
