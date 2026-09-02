import crypto from 'crypto';
import http from 'http';
import os from 'os';
import { readJsonFile, writeJsonFile } from '../storage';
import { FleetSummary, serialiseSummary } from './fleetSummary';

/**
 * fleetSync — see the other machines on this network (§D1).
 *
 * This is the **only** feature in TreeMap that opens a network surface, so it
 * is built to the strictest reading of §D1:
 *
 *  - **Off by default.** Nothing listens, nothing advertises, nothing is
 *    discoverable until the user turns it on and is told what will leave.
 *  - **A separate listener.** Peers talk to a tiny server that serves exactly
 *    three routes. The main API — every scan, every file read, `/api/security/
 *    findings`, `/api/provenance` — is not mounted on it and stays bound to
 *    127.0.0.1. A peer cannot reach those endpoints because they are not
 *    listening on the network at all. That is a structural guarantee, not a
 *    check somebody has to remember to write.
 *  - **Pairing before anything.** An unpaired device gets nothing but a 401,
 *    including no summary and no confirmation that TreeMap is even here beyond
 *    the advertisement it opted into.
 *  - **Remote deletion does not exist.** There is no route for it. Not a
 *    guarded one, not a disabled one — none.
 *
 * The pairing code is shown on both machines and typed by a person, which is
 * what stops a device on a café network from enumerating you. It is valid for
 * one short window and buys a long random secret used for every later request.
 */

const FLEET_FILE = 'fleet.json';
/** How long a pairing code is accepted. Long enough to type, short enough to matter. */
export const PAIRING_WINDOW_MS = 3 * 60_000;
/** Peers unseen for this long are shown as offline rather than removed. */
export const PEER_STALE_MS = 2 * 60_000;

export interface FleetPeer {
  instanceId: string;
  label: string;
  address: string;
  port: number;
  /** Shared secret established at pairing. Never sent anywhere but to this peer. */
  secret: string;
  pairedAt: number;
  lastSeenAt: number | null;
  /** The last summary this peer gave us. */
  summary: FleetSummary | null;
}

export interface FleetConfig {
  /** Master switch. False means nothing listens and nothing advertises. */
  enabled: boolean;
  /** Separately opt-in, per §D1: visibility and scan-triggering are not the same. */
  allowRemoteScan: boolean;
  label: string;
  instanceId: string;
  port: number;
  peers: FleetPeer[];
}

export const DEFAULT_FLEET_PORT = 4290;

export function defaultConfig(): FleetConfig {
  return {
    enabled: false, // §D1: off by default, and this is where that is true
    allowRemoteScan: false,
    label: os.hostname(),
    instanceId: crypto.randomUUID(),
    port: DEFAULT_FLEET_PORT,
    peers: [],
  };
}

let config: FleetConfig | null = null;

export async function loadFleetConfig(): Promise<FleetConfig> {
  if (config) return config;
  const stored = await readJsonFile<Partial<FleetConfig>>(FLEET_FILE, {});
  const base = defaultConfig();
  config = {
    ...base,
    ...stored,
    // Never inherit `true` from a malformed file: the safe value must be the
    // one you get when anything is unclear.
    enabled: stored.enabled === true,
    allowRemoteScan: stored.allowRemoteScan === true,
    instanceId: typeof stored.instanceId === 'string' && stored.instanceId ? stored.instanceId : base.instanceId,
    peers: Array.isArray(stored.peers) ? stored.peers.filter(isPeer) : [],
  };
  return config;
}

function isPeer(value: unknown): value is FleetPeer {
  const p = value as FleetPeer;
  return Boolean(p && typeof p.instanceId === 'string' && typeof p.secret === 'string' && typeof p.address === 'string');
}

export async function saveFleetConfig(next: FleetConfig): Promise<FleetConfig> {
  config = next;
  await writeJsonFile(FLEET_FILE, next);
  return next;
}

/** Test-only: the config is memoised for the process. */
export function resetFleetConfig(): void {
  config = null;
}

/* ────────────────────────── pairing ────────────────────────── */

export interface PairingOffer {
  code: string;
  expiresAt: number;
}

let pairing: { code: string; expiresAt: number } | null = null;

/**
 * How many wrong codes one machine may offer before it is refused outright.
 *
 * Six digits is only safe against guessing if guessing is bounded, and until
 * now it was not: this listener is a bare `http.createServer` and the express
 * rate limiter is mounted on the main API, which no peer ever reaches. An
 * audit managed 33,966 attempts in three seconds. A million possibilities is
 * no defence at that rate.
 *
 * Five is far above what a person copying a code off another screen needs and
 * far below what guessing needs, and the way back is one press of Pair a
 * machine: a new offer clears every counter.
 */
const PAIR_ATTEMPT_LIMIT = 5;
/** And across every machine at once, before the offer is withdrawn entirely. */
const PAIR_TOTAL_LIMIT = 50;

/** Wrong codes per address, and in total, for the offer being made right now. */
const pairFailures = new Map<string, number>();
let pairFailureTotal = 0;

/**
 * Both counters, emptied.
 *
 * Called wherever the offer changes, so a count only ever describes the code
 * being offered at this moment. It also bounds the map: nothing is counted
 * without adding to the total, and the total is capped, so at most
 * PAIR_TOTAL_LIMIT addresses are ever held and no sweeper is needed.
 */
function resetPairFailures(): void {
  pairFailures.clear();
  pairFailureTotal = 0;
}

/**
 * A six-digit code, from a cryptographic source.
 *
 * Six digits is a million possibilities against a three-minute window, five
 * wrong guesses per machine and fifty in all — after which the offer is
 * withdrawn and the person at this machine is told. That bound is what makes
 * a code short enough to read aloud safe; the window alone never was. It is
 * not a password and never becomes one: it buys a 256-bit secret and is then
 * discarded.
 */
export function beginPairing(now = Date.now()): PairingOffer {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  pairing = { code, expiresAt: now + PAIRING_WINDOW_MS };
  // A fresh code is a fresh allowance — including for the machine whose owner
  // mistyped the last one five times.
  resetPairFailures();
  return { ...pairing };
}

export function cancelPairing(): void {
  pairing = null;
  resetPairFailures();
}

export function pairingOffer(now = Date.now()): PairingOffer | null {
  if (!pairing) return null;
  if (now >= pairing.expiresAt) {
    pairing = null;
    return null;
  }
  return { ...pairing };
}

/**
 * Check a code offered by a would-be peer.
 *
 * Compared in constant time, and consumed on success so one code pairs one
 * device. A single wrong code does NOT clear the window: that would let anyone
 * on the network cancel a pairing in progress by guessing once.
 *
 * Fifty wrong codes DO withdraw it (see the pair route). That is a deliberate
 * trade and it is worth naming: a device on this LAN can end a pairing that is
 * in progress, and can do it again after each new code. It is the smaller
 * harm. The alternative is unlimited guessing against six digits, which is a
 * stranger pairing themselves to this machine — and the withdrawal is at least
 * visible, because it tells the person here what happened and which address
 * did it.
 */
export function verifyPairingCode(offered: unknown, now = Date.now()): boolean {
  const current = pairingOffer(now);
  if (!current) return false;
  if (typeof offered !== 'string' || offered.length !== current.code.length) return false;
  const a = Buffer.from(offered);
  const b = Buffer.from(current.code);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  pairing = null; // one code, one device
  return true;
}

export function newPeerSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Constant-time bearer check against a peer's own secret. */
export function secretMatches(offered: string | undefined, expected: string): boolean {
  if (!offered) return false;
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ────────────────────────── LAN addresses ────────────────────────── */

/**
 * The private addresses this machine can be reached on.
 *
 * §D1 says bind to LAN interfaces only. Loopback is excluded (a peer reaching
 * us over loopback is us), and so is anything that is not in a private range —
 * a public address means this machine is directly on the internet, and TreeMap
 * will not advertise itself there.
 */
export function lanAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (isPrivateIPv4(iface.address)) out.push(iface.address);
    }
  }
  return out;
}

export function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, i.e. a direct cable
  return false;
}

/* ────────────────────────── the peer-facing server ────────────────────────── */

export interface PeerServerHooks {
  /** Build the summary. Called per request so figures are current. */
  summary(): Promise<FleetSummary>;
  /** Start a scan on this machine. Only reached when allowRemoteScan is true. */
  startScan(path: string): Promise<{ scanId: string }>;
  /**
   * Optional. Something on this network has been guessing pairing codes, so
   * the offer has just been withdrawn. Given the address it came from, because
   * the one thing worse than a stopped pairing is a stopped pairing nobody
   * explains.
   */
  onPairingAbuse?(address: string): void;
}

export interface RunningPeerServer {
  port: number;
  addresses: string[];
  close(): Promise<void>;
}

/** Requests larger than this are refused unread — no peer needs to send more. */
const MAX_BODY_BYTES = 4096;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    // Nothing here is for a browser, and this refuses to be embedded in one.
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/**
 * One caller, named the same way twice.
 *
 * A dual-stack socket reports `::ffff:192.168.1.9` where an IPv4 one reports
 * `192.168.1.9`. Counting those as two machines would silently double every
 * allowance below.
 */
function peerAddress(req: http.IncomingMessage): string {
  const raw = req.socket.remoteAddress || '';
  return raw.replace(/^::ffff:/i, '') || 'unknown';
}

/**
 * Start the peer listener.
 *
 * Exactly three routes exist. There is no route that reads a file, lists a
 * directory, returns a security finding or deletes anything — and because this
 * is a separate server from the main app, there is no way to reach one either.
 */
export async function startPeerServer(
  cfg: FleetConfig,
  hooks: PeerServerHooks,
  bindAddresses: string[] = lanAddresses(),
): Promise<RunningPeerServer> {
  const server = http.createServer((req, res) => {
    void handlePeerRequest(req, res, cfg, hooks).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'fleet request failed' });
    });
  });

  // Binding to 0.0.0.0 would include any public interface. Binding to the
  // specific private addresses keeps the surface on the LAN, which is what
  // §D1 asks for. With no private address at all, nothing is started.
  if (bindAddresses.length === 0) {
    throw new Error('No private network address to bind to — fleet stays off');
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, bindAddresses[0], () => resolve());
  });

  return {
    port: (server.address() as { port: number }).port,
    addresses: bindAddresses,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function handlePeerRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: FleetConfig,
  hooks: PeerServerHooks,
): Promise<void> {
  const url = (req.url || '/').split('?')[0];
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  /* Pairing — the one route reachable without a secret, and only while the
     user is actively looking at a code on this machine. */
  if (req.method === 'POST' && url === '/fleet/pair') {
    const from = peerAddress(req);
    // Guessing is the only attack a six-digit code has, so it is the one thing
    // this route counts. Checked before anything else: if five wrong guesses
    // still left a sixth free, they would have cost the guesser nothing.
    if ((pairFailures.get(from) ?? 0) >= PAIR_ATTEMPT_LIMIT) {
      // Read on the machine that TYPED the code, not the one showing it, so it
      // must never say "this machine" about the other one.
      send(res, 429, { error: 'Too many wrong codes have been tried from this computer. Ask for a new code on the other machine and start again.' });
      return;
    }
    const offer = pairingOffer();
    if (!offer) {
      // Deliberately identical whether or not the code was right: a device that
      // is not being paired learns nothing except "not now".
      send(res, 401, { error: 'This machine is not accepting pairing right now' });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      send(res, 400, { error: 'Bad request' });
      return;
    }
    if (!verifyPairingCode(body.code)) {
      pairFailures.set(from, (pairFailures.get(from) ?? 0) + 1);
      pairFailureTotal += 1;
      // Five each is no defence against two hundred machines, or against one
      // machine willing to lie about its address, so the offer has a budget of
      // its own. Spent, it is withdrawn — and the person at this machine finds
      // out why here, rather than by wondering why their code stopped working.
      if (pairFailureTotal >= PAIR_TOTAL_LIMIT) {
        cancelPairing(); // which empties both counters
        try {
          hooks.onPairingAbuse?.(from);
        } catch {
          /* telling someone must never break the refusal */
        }
        send(res, 429, { error: 'Too many wrong codes have been tried, so the other machine has stopped offering a code. Ask for a new one there.' });
        return;
      }
      send(res, 401, { error: 'That code is not right' });
      return;
    }
    // The offer is spent, so nothing the counters were describing is true now.
    resetPairFailures();
    const secret = newPeerSecret();
    const peer: FleetPeer = {
      instanceId: String(body.instanceId || crypto.randomUUID()),
      label: String(body.label || 'Unknown machine').slice(0, 60),
      address: req.socket.remoteAddress || '',
      port: Number(body.port) || DEFAULT_FLEET_PORT,
      secret,
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
      summary: null,
    };
    cfg.peers = [...cfg.peers.filter((p) => p.instanceId !== peer.instanceId), peer];
    await saveFleetConfig(cfg);
    send(res, 200, { paired: true, secret, instanceId: cfg.instanceId, label: cfg.label });
    return;
  }

  /* Everything below requires a paired secret. */
  const peer = cfg.peers.find((p) => secretMatches(auth, p.secret));
  if (!peer) {
    send(res, 401, { error: 'Not paired' });
    return;
  }
  peer.lastSeenAt = Date.now();

  if (req.method === 'GET' && url === '/fleet/summary') {
    // serialiseSummary is the allow-list; nothing else is ever written here.
    send(res, 200, serialiseSummary(await hooks.summary()));
    return;
  }

  if (req.method === 'POST' && url === '/fleet/scan') {
    if (!cfg.allowRemoteScan) {
      send(res, 403, { error: 'This machine does not accept scans started from other machines' });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      send(res, 400, { error: 'Bad request' });
      return;
    }
    if (typeof body.path !== 'string' || !body.path) {
      send(res, 400, { error: 'A path is required' });
      return;
    }
    const started = await hooks.startScan(body.path);
    // The scanId only; the RESULT is never pushed anywhere. A peer sees the
    // outcome as a summary, exactly like any other, or not at all.
    send(res, 202, { scanId: started.scanId });
    return;
  }

  send(res, 404, { error: 'No such fleet route' });
}
