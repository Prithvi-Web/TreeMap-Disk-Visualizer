import { Router, Request, Response } from 'express';
import { listNotes, setNote, deleteNote, NOTE_MAX_CHARS } from '../services/notes';
import { sanitizePath } from '../utils/pathSanitizer';
import { AppError } from '../middleware/errorHandler';

/**
 * noteRoutes — notes pinned to folders (v4 §9.5).
 *
 * Notes follow the folder-budgets precedent, not the file-access one: they
 * are metadata ABOUT a path, they never read, open, move or delete anything
 * at it, so they take `sanitizePath` (traversal, null bytes, blocked roots)
 * but not the scanned-root guard — a note on a folder must survive server
 * restarts and outlive any scan, exactly as budgets do in settings.json.
 *
 * Note text travels verbatim in both directions. The frontend's half of the
 * XSS contract is textContent-only rendering; tests/notes.test.ts holds both.
 */

export const noteRouter = Router();

/** GET /api/notes — every folder note, for the detail panel and tile glyphs. */
noteRouter.get('/notes', async (_req: Request, res: Response) => {
  res.json({ notes: await listNotes() });
});

/**
 * PUT /api/notes  { path, text, suppress? } — create or update one note.
 * `suppress` omitted: defaults to true on create, keeps the choice on update.
 */
noteRouter.put('/notes', async (req: Request, res: Response) => {
  const body = req.body as { path?: unknown; text?: unknown; suppress?: unknown };
  const p = sanitizePath(body.path); // throws PATH_INVALID / PATH_BLOCKED
  if (typeof body.text !== 'string') {
    throw new AppError(400, 'NOTE_INVALID', `"text" must be a string of up to ${NOTE_MAX_CHARS} characters`);
  }
  if (body.suppress !== undefined && typeof body.suppress !== 'boolean') {
    throw new AppError(400, 'NOTE_INVALID', '"suppress" must be true or false when present');
  }
  res.json({ note: await setNote(p, body.text, body.suppress as boolean | undefined) });
});

/** DELETE /api/notes?path= — remove one note. */
noteRouter.delete('/notes', async (req: Request, res: Response) => {
  const p = sanitizePath(req.query.path); // throws PATH_INVALID on absence too
  res.json({ ok: true, existed: await deleteNote(p) });
});
