/**
 * Fail closed on a LAN bind.
 *
 * `requireToken` passes everything when TREEMAP_TOKEN is unset, so
 * `HOST=0.0.0.0 npm start` — or `docker run -p 4280:4280`, the form every
 * tutorial teaches — used to start silently wide open: anyone on the network
 * could list any folder, scan it, and trash whatever was under it. A
 * non-loopback bind now needs a token, or an explicit TREEMAP_INSECURE_BIND=1
 * that says the operator knows what it costs.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface BindDecision {
  ok: boolean;
  /** Why the server will not start (ok === false). */
  reason?: string;
  /** Printed at startup when it starts open on purpose. */
  warning?: string;
}

export function bindDecision(input: { host: string; token: string | undefined; insecure: string | undefined }): BindDecision {
  const host = input.host.trim();
  if (LOOPBACK.has(host.toLowerCase())) return { ok: true };
  if (input.token !== undefined && input.token.trim().length > 0) return { ok: true };
  if (input.insecure === '1') {
    return { ok: true, warning: `bound to ${host} with no TREEMAP_TOKEN — anyone on the network can scan and trash files` };
  }
  return {
    ok: false,
    reason: `refusing to bind ${host} without TREEMAP_TOKEN (set it, or TREEMAP_INSECURE_BIND=1 to run open on purpose)`,
  };
}
