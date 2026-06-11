import { Request, Response, NextFunction } from 'express';
import { PathRejectedError } from '../utils/pathSanitizer';

/** Throw anywhere in a route; the handler below turns it into clean JSON. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

/** Map common Node fs error codes to HTTP semantics. */
function fromNodeError(err: NodeJS.ErrnoException): AppError | null {
  switch (err.code) {
    case 'ENOENT':
      return new AppError(404, 'PATH_NOT_FOUND', 'Path does not exist');
    case 'EACCES':
    case 'EPERM':
      return new AppError(403, 'PERMISSION_DENIED', 'Permission denied');
    case 'ENOTDIR':
      return new AppError(400, 'NOT_A_DIRECTORY', 'Path is not a directory');
    default:
      return null;
  }
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' });
}

/** Final Express error handler: every error becomes { error, code } JSON. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    // Mid-stream (e.g. SSE) — nothing sane to send; just end the response.
    res.end();
    return;
  }

  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof PathRejectedError) {
    res.status(400).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string') {
    const mapped = fromNodeError(err as NodeJS.ErrnoException);
    if (mapped) {
      res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
      return;
    }
  }
  if (err instanceof SyntaxError && 'body' in (err as object)) {
    res.status(400).json({ error: 'Malformed JSON body', code: 'BAD_JSON' });
    return;
  }

  // Unknown failure: log it, hide internals from the client.
  console.error('[treemap] unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
}
