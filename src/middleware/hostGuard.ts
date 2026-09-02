import { Request, Response, NextFunction } from 'express';

/**
 * hostGuard — the Host header must name this server.
 *
 * A DNS-rebinding page (evil.example, re-resolved to 127.0.0.1 after the
 * first load) makes requests the browser considers same-origin, so CORS never
 * runs and the JSON parser is satisfied; the only thing that betrays it is the
 * Host header, which still says evil.example. A loopback-bound server answers
 * only to loopback names (and to the address it was told to bind), and refuses
 * everything else before a single route — the page included, because serving
 * the page is what hands out the session cookie when a token is set.
 *
 * A wildcard bind (0.0.0.0, ::) is reached under whatever name the network
 * gives the machine — Docker behind a reverse proxy sets Host to the public
 * name — and the check cannot know it, so it steps aside there. That profile
 * is the one src/index.ts refuses to start without TREEMAP_TOKEN.
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const WILDCARD = new Set(['0.0.0.0', '::', '[::]', '']);

/** The name part of a Host header: port dropped, IPv6 brackets kept, lower-cased. */
function hostName(header: string): string {
  const h = header.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.indexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

/** Pure: does this Host header belong to a server bound at `bindHost`? */
export function hostAllowed(hostHeader: string | undefined, bindHost: string): boolean {
  const bind = bindHost.trim().toLowerCase();
  if (WILDCARD.has(bind)) return true;
  const name = hostName(hostHeader ?? '');
  if (name === '') return false;
  if (LOOPBACK.has(name)) return true;
  return name === bind || name === `[${bind}]`;
}

export function hostGuard(bindHost: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (hostAllowed(req.headers.host, bindHost)) {
      next();
      return;
    }
    res.status(403).json({ error: 'TreeMap only answers to its own address', code: 'BAD_HOST' });
  };
}
