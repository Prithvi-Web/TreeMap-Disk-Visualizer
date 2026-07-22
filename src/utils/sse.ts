import { Response } from 'express';

/**
 * Write one SSE frame. Returns false — leaving the stream untouched — when the
 * event is too large to serialize: V8 caps any single string at ~512 MB, which
 * a payload carrying millions of nodes exceeds. Callers must not let that
 * throw, because SSE writes run on timers and emitter callbacks where an
 * escaping exception is uncaught and takes the whole app down (issue #14 —
 * v2.1.0 stringified a full multi-million-node tree here and crashed the main
 * process with RangeError: Invalid string length, repeatedly).
 *
 * Every SSE endpoint must send through this one function; a raw
 * `res.write(JSON.stringify(...))` reintroduces the crash class.
 */
export function sseSend(res: Response, event: unknown): boolean {
  let frame: string;
  try {
    // JSON.stringify never emits raw newlines, so one data: line is enough.
    frame = `data: ${JSON.stringify(event)}\n\n`;
  } catch (err) {
    if (err instanceof RangeError) return false;
    throw err; // a real serialization bug, not a size limit
  }
  res.write(frame);
  return true;
}
