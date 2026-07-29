import dgram from 'dgram';
import { EventEmitter } from 'events';

/**
 * mdns — just enough DNS-SD to find other TreeMaps on the LAN (§D1).
 *
 * Written directly on `dgram` rather than adding a Bonjour dependency, matching
 * how the rate limiter, the auth layer and the glob matcher are done here. The
 * subset needed is genuinely small: advertise one service, browse for the same
 * one. Everything below is the DNS wire format from RFC 1035 with the two
 * multicast twists from RFC 6762 — a zero transaction id, and the top bit of
 * the class field reused as "flush the cache".
 *
 * What it does NOT do, deliberately: no probing/conflict resolution, no
 * known-answer suppression, no negative responses. A duplicate name on the
 * network shows the user two entries with the same label, which is a cosmetic
 * problem; the alternative is several hundred more lines of protocol for a
 * feature that is off by default.
 *
 * Nothing here carries anything private. The advertisement is a service name,
 * a port, and the instance's own label and id — the same things the summary
 * carries, and no more. Discovery happens only while the feature is enabled.
 */

export const MDNS_ADDRESS = '224.0.0.251';
export const MDNS_PORT = 5353;
export const SERVICE_TYPE = '_treemap._tcp.local';

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const CLASS_IN = 1;
/** RFC 6762 §10.2 — the top class bit means "this record replaces the cache". */
const FLUSH = 0x8000;

/* ────────────────────────── encoding ────────────────────────── */

/** Encode a dotted name as length-prefixed labels. No compression pointers. */
export function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.');
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    if (bytes.length > 63) throw new Error(`DNS label too long: ${part}`);
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

/**
 * Decode a name, following compression pointers.
 *
 * Responders in the wild compress aggressively, so a browser that cannot follow
 * a pointer sees garbage. `guard` bounds the jumps: a malicious or broken packet
 * can point a name at itself, and without a limit that is an infinite loop in a
 * process listening on a network socket.
 */
export function decodeName(buf: Buffer, offset: number): { name: string; next: number } {
  const parts: string[] = [];
  let pos = offset;
  let next = -1;
  let guard = 0;
  while (pos < buf.length) {
    if (guard++ > 128) throw new Error('compression pointer loop');
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('truncated pointer');
      const target = ((len & 0x3f) << 8) | buf[pos + 1];
      if (next === -1) next = pos + 2;
      if (target >= buf.length || target >= pos) throw new Error('bad compression pointer');
      pos = target;
      continue;
    }
    if (pos + 1 + len > buf.length) throw new Error('truncated label');
    parts.push(buf.subarray(pos + 1, pos + 1 + len).toString('utf8'));
    pos += 1 + len;
  }
  return { name: parts.join('.'), next: next === -1 ? pos : next };
}

function record(name: string, type: number, ttl: number, data: Buffer, flush = false): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(flush ? CLASS_IN | FLUSH : CLASS_IN, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeName(name), head, data]);
}

/** TXT rdata: each key=value is one length-prefixed string. */
export function encodeTxt(pairs: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(pairs)) {
    const line = Buffer.from(`${key}=${value}`, 'utf8');
    if (line.length > 255) throw new Error(`TXT entry too long: ${key}`);
    chunks.push(Buffer.from([line.length]), line);
  }
  if (chunks.length === 0) chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

export function decodeTxt(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const len = data[pos];
    if (len === 0 || pos + 1 + len > data.length) break;
    const entry = data.subarray(pos + 1, pos + 1 + len).toString('utf8');
    const eq = entry.indexOf('=');
    if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
    pos += 1 + len;
  }
  return out;
}

export interface Advertisement {
  instanceName: string;
  port: number;
  address: string;
  txt: Record<string, string>;
}

/** A full announcement: PTR → SRV + TXT + A, which is what a browser needs. */
export function buildAnnouncement(ad: Advertisement): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // id — always 0 for multicast DNS
  header.writeUInt16BE(0x8400, 2); // response, authoritative
  header.writeUInt16BE(0, 4); // questions
  header.writeUInt16BE(4, 6); // answers
  const fqdn = `${ad.instanceName}.${SERVICE_TYPE}`;
  const host = `${ad.instanceName}.local`;

  const srv = Buffer.alloc(6);
  srv.writeUInt16BE(0, 0); // priority
  srv.writeUInt16BE(0, 2); // weight
  srv.writeUInt16BE(ad.port, 4);

  const a = Buffer.from(ad.address.split('.').map(Number));

  return Buffer.concat([
    header,
    record(SERVICE_TYPE, TYPE_PTR, 120, encodeName(fqdn)),
    record(fqdn, TYPE_SRV, 120, Buffer.concat([srv, encodeName(host)]), true),
    record(fqdn, TYPE_TXT, 120, encodeTxt(ad.txt), true),
    record(host, TYPE_A, 120, a, true),
  ]);
}

/** A question for the service type — what a browser sends. */
export function buildQuery(): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0, 2); // standard query
  header.writeUInt16BE(1, 4); // one question
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(TYPE_PTR, 0);
  tail.writeUInt16BE(CLASS_IN, 2);
  return Buffer.concat([header, encodeName(SERVICE_TYPE), tail]);
}

export interface DiscoveredPeer {
  instanceName: string;
  address: string;
  port: number;
  txt: Record<string, string>;
}

/**
 * Pull whatever a packet says about our service type.
 *
 * Tolerant by necessity: a LAN is full of other services, truncated packets and
 * responders that answer with only some of the records. Anything unreadable is
 * skipped rather than thrown, because one malformed neighbour must not stop
 * discovery — but a packet that cannot even be parsed at the header is dropped
 * whole.
 */
export function parseResponse(buf: Buffer): DiscoveredPeer | null {
  if (buf.length < 12) return null;
  let pos = 12;
  const counts = {
    questions: buf.readUInt16BE(4),
    answers: buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10),
  };
  try {
    for (let i = 0; i < counts.questions; i++) {
      pos = decodeName(buf, pos).next + 4;
    }
    let instanceName = '';
    let port = 0;
    let address = '';
    let txt: Record<string, string> = {};

    for (let i = 0; i < counts.answers && pos < buf.length; i++) {
      const { name, next } = decodeName(buf, pos);
      pos = next;
      if (pos + 10 > buf.length) break;
      const type = buf.readUInt16BE(pos);
      const len = buf.readUInt16BE(pos + 8);
      pos += 10;
      const data = buf.subarray(pos, pos + len);
      pos += len;

      if (type === TYPE_PTR && name === SERVICE_TYPE) {
        instanceName = decodeName(buf, pos - len).name.replace(`.${SERVICE_TYPE}`, '');
      } else if (type === TYPE_SRV && name.endsWith(SERVICE_TYPE)) {
        port = data.readUInt16BE(4);
        if (!instanceName) instanceName = name.replace(`.${SERVICE_TYPE}`, '');
      } else if (type === TYPE_TXT && name.endsWith(SERVICE_TYPE)) {
        txt = decodeTxt(data);
      } else if (type === TYPE_A && data.length === 4) {
        address = Array.from(data).join('.');
      }
    }
    if (!instanceName || !port) return null;
    return { instanceName, address, port, txt };
  } catch {
    return null; // a neighbour we cannot read is simply not discovered
  }
}

/* ────────────────────────── the socket ────────────────────────── */

export interface MdnsOptions {
  instanceName: string;
  port: number;
  address: string;
  txt: Record<string, string>;
}

/**
 * Advertise and browse. Emits `peer` for every TreeMap that answers.
 *
 * Only ever started when the fleet feature is enabled, and stopped the moment
 * it is turned off — the socket's lifetime IS the opt-in.
 */
export class MdnsResponder extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: MdnsOptions) {
    super();
  }

  async start(): Promise<void> {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('message', (msg, rinfo) => {
      const peer = parseResponse(msg);
      if (peer) {
        // Trust the sender's address over the advertised A record: the packet
        // demonstrably came from there, and the record is only a claim.
        this.emit('peer', { ...peer, address: peer.address || rinfo.address });
        return;
      }
      // A query for our type gets an answer, which is how the other side
      // finds us without waiting for our next periodic announcement.
      if (msg.length > 12 && msg.readUInt16BE(4) > 0) {
        try {
          const { name } = decodeName(msg, 12);
          if (name === SERVICE_TYPE) this.announce();
        } catch { /* not a question we can read */ }
      }
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(MDNS_PORT, () => {
        try {
          socket.addMembership(MDNS_ADDRESS);
          socket.setMulticastTTL(255); // RFC 6762: 255, and routers still won't forward it
        } catch (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    this.announce();
    this.query();
    // Re-announce well inside the 120s TTL so a peer that missed one still
    // sees us, and re-query so a peer that started later is found.
    this.timer = setInterval(() => {
      this.announce();
      this.query();
    }, 30_000);
    this.timer.unref();
  }

  announce(): void {
    const packet = buildAnnouncement({
      instanceName: this.options.instanceName,
      port: this.options.port,
      address: this.options.address,
      txt: this.options.txt,
    });
    this.socket?.send(packet, MDNS_PORT, MDNS_ADDRESS, () => undefined);
  }

  query(): void {
    this.socket?.send(buildQuery(), MDNS_PORT, MDNS_ADDRESS, () => undefined);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      try {
        socket.dropMembership(MDNS_ADDRESS);
      } catch { /* already gone */ }
      socket.close(() => resolve());
    });
  }
}
