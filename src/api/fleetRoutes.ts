import { Request, Response, Router } from 'express';
import http from 'http';
import { AppError } from '../middleware/errorHandler';
import {
  FleetPeer, PEER_STALE_MS, beginPairing, cancelPairing, lanAddresses,
  loadFleetConfig, pairingOffer, saveFleetConfig,
} from '../services/fleet/fleetSync';
import { fleetRuntime } from '../services/fleet/fleetRuntime';

export const fleetRouter = Router();

/**
 * fleetRoutes — the LOCAL control plane for §D1.
 *
 * These are on the ordinary API (127.0.0.1) and are how the person at this
 * machine turns the feature on, pairs a device and looks at what was found.
 * They are NOT what peers talk to: peers reach a separate server with three
 * routes, so nothing here is exposed to the network.
 */

function publicPeer(peer: FleetPeer, now = Date.now()): Record<string, unknown> {
  // The shared secret never leaves this process, not even to our own UI.
  return {
    instanceId: peer.instanceId,
    label: peer.label,
    address: peer.address,
    port: peer.port,
    pairedAt: peer.pairedAt,
    lastSeenAt: peer.lastSeenAt,
    online: peer.lastSeenAt !== null && now - peer.lastSeenAt < PEER_STALE_MS,
    summary: peer.summary,
  };
}

/** GET /api/fleet — the switch, and what turning it on would mean. */
fleetRouter.get('/fleet', async (_req: Request, res: Response) => {
  const cfg = await loadFleetConfig();
  const runtime = fleetRuntime();
  res.json({
    enabled: cfg.enabled,
    allowRemoteScan: cfg.allowRemoteScan,
    label: cfg.label,
    instanceId: cfg.instanceId,
    port: cfg.port,
    running: runtime.running,
    addresses: cfg.enabled ? lanAddresses() : [],
    pairing: pairingOffer(),
    /* A withdrawn offer is not silent: the panel polls this every five seconds
       and says what happened and which machine did it. */
    pairingStopped: runtime.pairingAbuse(),
    peers: (cfg.peers ?? []).map((p) => publicPeer(p)),
    discovered: runtime.discovered(),
    /**
     * Stated by the server rather than written into the UI, so the promise and
     * the implementation cannot drift apart.
     */
    shares: [
      'The name you give this machine, and its operating system',
      'How much space this disk has, and how much is free',
      'The folder you last scanned, when, and how big it was',
    ],
    neverShares: [
      'Any list of your files or folders',
      'Anything from the Security panel',
      'Where any file was downloaded from',
      'Nothing can be deleted from another machine — there is no way to ask',
    ],
  });
});

/** PUT /api/fleet { enabled?, allowRemoteScan?, label? } */
fleetRouter.put('/fleet', async (req: Request, res: Response) => {
  const body = req.body as { enabled?: unknown; allowRemoteScan?: unknown; label?: unknown };
  const cfg = await loadFleetConfig();
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new AppError(400, 'BAD_ENABLED', '"enabled" must be true or false');
    cfg.enabled = body.enabled;
  }
  if (body.allowRemoteScan !== undefined) {
    if (typeof body.allowRemoteScan !== 'boolean') throw new AppError(400, 'BAD_REMOTE_SCAN', '"allowRemoteScan" must be true or false');
    cfg.allowRemoteScan = body.allowRemoteScan;
  }
  if (body.label !== undefined) {
    if (typeof body.label !== 'string' || !body.label.trim()) throw new AppError(400, 'BAD_LABEL', '"label" must be a name');
    cfg.label = body.label.trim().slice(0, 60);
  }
  await saveFleetConfig(cfg);
  // Turning it off must actually stop the socket, not merely record a intent.
  await fleetRuntime().apply(cfg);
  res.json({ enabled: cfg.enabled, allowRemoteScan: cfg.allowRemoteScan, label: cfg.label, running: fleetRuntime().running });
});

/** POST /api/fleet/pairing — show a code for a few minutes. */
fleetRouter.post('/fleet/pairing', async (_req: Request, res: Response) => {
  const cfg = await loadFleetConfig();
  if (!cfg.enabled) throw new AppError(409, 'FLEET_DISABLED', 'Turn the fleet view on before pairing');
  // Asking for a new code is the answer to the warning, so it also clears it.
  fleetRuntime().clearPairingAbuse();
  res.json(beginPairing());
});

/** DELETE /api/fleet/pairing — stop offering it. */
fleetRouter.delete('/fleet/pairing', (_req: Request, res: Response) => {
  cancelPairing();
  res.json({ pairing: null });
});

/** GET /api/fleet/peers — paired machines, with their last summary. */
fleetRouter.get('/fleet/peers', async (_req: Request, res: Response) => {
  const cfg = await loadFleetConfig();
  res.json({ peers: (cfg.peers ?? []).map((p) => publicPeer(p)) });
});

/** POST /api/fleet/peers { address, port, code } — pair WITH another machine. */
fleetRouter.post('/fleet/peers', async (req: Request, res: Response) => {
  const cfg = await loadFleetConfig();
  if (!cfg.enabled) throw new AppError(409, 'FLEET_DISABLED', 'Turn the fleet view on first');
  const { address, port, code } = req.body as { address?: unknown; port?: unknown; code?: unknown };
  if (typeof address !== 'string' || !address) throw new AppError(400, 'ADDRESS_REQUIRED', 'An address is required');
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new AppError(400, 'CODE_REQUIRED', 'A six-digit code is required');
  const result = await pairWith(String(address), Number(port) || cfg.port, String(code), cfg.instanceId, cfg.label, cfg.port);
  if (!result.ok) throw new AppError(400, 'PAIRING_FAILED', result.error);

  const peer: FleetPeer = {
    instanceId: result.instanceId,
    label: result.label,
    address: String(address),
    port: Number(port) || cfg.port,
    secret: result.secret,
    pairedAt: Date.now(),
    lastSeenAt: Date.now(),
    summary: null,
  };
  cfg.peers = [...cfg.peers.filter((p) => p.instanceId !== peer.instanceId), peer];
  await saveFleetConfig(cfg);
  res.json({ peer: publicPeer(peer) });
});

/** DELETE /api/fleet/peers/:id — forget a machine, both ways. */
fleetRouter.delete('/fleet/peers/:id', async (req: Request, res: Response) => {
  const cfg = await loadFleetConfig();
  const id = String(req.params.id);
  const before = cfg.peers.length;
  cfg.peers = cfg.peers.filter((p) => p.instanceId !== id);
  await saveFleetConfig(cfg);
  res.json({ removed: before !== cfg.peers.length });
});

/** GET /api/fleet/peers/:id/summary — ask that machine how it is doing. */
fleetRouter.get('/fleet/peers/:id/summary', async (req: Request, res: Response) => {
  const cfg = await loadFleetConfig();
  const peer = cfg.peers.find((p) => p.instanceId === String(req.params.id));
  if (!peer) throw new AppError(404, 'PEER_NOT_FOUND', 'That machine is not paired with this one');
  const summary = await askPeer(peer, 'GET', '/fleet/summary');
  if (!summary.ok) throw new AppError(502, 'PEER_UNREACHABLE', summary.error ?? 'That machine could not be reached');
  peer.summary = summary.body as never;
  peer.lastSeenAt = Date.now();
  await saveFleetConfig(cfg);
  res.json({ summary: peer.summary, peer: publicPeer(peer) });
});

/** POST /api/fleet/peers/:id/trigger-scan { path } — ask it to scan something. */
fleetRouter.post('/fleet/peers/:id/trigger-scan', async (req: Request, res: Response) => {
  const cfg = await loadFleetConfig();
  const peer = cfg.peers.find((p) => p.instanceId === String(req.params.id));
  if (!peer) throw new AppError(404, 'PEER_NOT_FOUND', 'That machine is not paired with this one');
  const { path: target } = req.body as { path?: unknown };
  if (typeof target !== 'string' || !target) throw new AppError(400, 'PATH_REQUIRED', 'A folder to scan is required');
  const result = await askPeer(peer, 'POST', '/fleet/scan', { path: target });
  if (!result.ok) throw new AppError(502, 'PEER_REFUSED', result.error ?? 'That machine refused the request');
  res.json(result.body);
});

/* ────────────────────────── talking to a peer ────────────────────────── */

interface PeerReply {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}

/** Bounded, so an unreachable machine cannot hold a request open. */
const PEER_TIMEOUT_MS = 8000;

function peerRequest(
  address: string, port: number, method: string, path: string,
  headers: Record<string, string>, body?: unknown,
): Promise<PeerReply> {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: address, port, path, method, timeout: PEER_TIMEOUT_MS, headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        // A peer that streams forever must not exhaust this process.
        res.on('data', (c: string) => { if (text.length < 64_000) text += c; });
        res.on('end', () => {
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* not JSON */ }
          const status = res.statusCode ?? 0;
          resolve(status >= 200 && status < 300
            ? { ok: true, status, body: parsed }
            : { ok: false, status, error: (parsed as { error?: string })?.error || `That machine answered ${status}` });
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'That machine did not answer in time' }); });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

function askPeer(peer: FleetPeer, method: string, path: string, body?: unknown): Promise<PeerReply> {
  return peerRequest(peer.address, peer.port, method, path, { Authorization: `Bearer ${peer.secret}` }, body);
}

async function pairWith(
  address: string, port: number, code: string,
  instanceId: string, label: string, ownPort: number,
): Promise<{ ok: true; secret: string; instanceId: string; label: string } | { ok: false; error: string }> {
  const reply = await peerRequest(address, port, 'POST', '/fleet/pair', {}, { code, instanceId, label, port: ownPort });
  if (!reply.ok) return { ok: false, error: reply.error || 'Pairing was refused' };
  const body = reply.body as { secret?: string; instanceId?: string; label?: string };
  if (!body?.secret) return { ok: false, error: 'That machine did not send a key back' };
  return { ok: true, secret: body.secret, instanceId: body.instanceId || address, label: body.label || address };
}
