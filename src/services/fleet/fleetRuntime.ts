import { diskUsage } from '../diskUsage';
import { allScans } from '../diskScanner';
import { storeOf } from '../scanStore';
import { FleetConfig, RunningPeerServer, lanAddresses, loadFleetConfig, startPeerServer } from './fleetSync';
import { ScanResult } from '../../models/types';
import { DiscoveredPeer, MdnsResponder } from './mdns';
import { buildSummary, FleetSummary } from './fleetSummary';

/**
 * fleetRuntime — owns the socket, and therefore owns the opt-in (§D1).
 *
 * The feature being "off" is not a flag consulted at request time; it is the
 * absence of a listener and the absence of an advertisement. `apply()` is the
 * only way either comes into existence, and turning the switch off tears both
 * down immediately rather than leaving something running until restart.
 */

export interface DiscoveredEntry {
  instanceId: string;
  label: string;
  address: string;
  port: number;
  version: string | null;
  seenAt: number;
}

/** Discovered peers are forgotten if they stop advertising. */
const DISCOVERY_TTL_MS = 5 * 60_000;

class FleetRuntime {
  private server: RunningPeerServer | null = null;
  private mdns: MdnsResponder | null = null;
  private seen = new Map<string, DiscoveredEntry>();

  /** The last machine on this network refused for guessing pairing codes. */
  private abuse: { address: string; at: number } | null = null;

  get running(): boolean {
    return this.server !== null;
  }

  /**
   * What to tell the person at this machine about a withdrawn pairing offer.
   *
   * Held here and not in fleetSync because it is not part of the peer
   * protocol: no peer is ever told this, and the local panel is its only
   * reader. It survives `stop()` deliberately — turning the fleet off is a
   * reasonable reaction to the warning, not a reason to lose it.
   */
  pairingAbuse(): { address: string; at: number } | null {
    return this.abuse;
  }

  /** Cleared when a fresh code is offered; by then the warning is history. */
  clearPairingAbuse(): void {
    this.abuse = null;
  }

  /** Everything the network can see about this machine, rebuilt per request. */
  async summary(cfg: FleetConfig): Promise<FleetSummary> {
    const scans: ScanResult[] = allScans().filter((s) => s.status === 'complete');
    const latest = scans.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
    let usage: { total: number; used: number; free: number } | null = null;
    try {
      const u = await diskUsage(latest?.rootPath || process.cwd());
      usage = { total: u.total, used: u.total - u.free, free: u.free };
    } catch {
      usage = null;
    }
    return buildSummary({
      label: cfg.label,
      instanceId: cfg.instanceId,
      version: process.env.npm_package_version || '',
      acceptsRemoteScan: cfg.allowRemoteScan,
      usage,
      // Three scalars, pulled out here so no scan object reaches the builder.
      lastScan: latest
        ? {
            rootPath: latest.rootPath,
            finishedAt: latest.finishedAt,
            totalBytes: (() => {
              try {
                const store = storeOf(latest);
                return store.size(store.rootId);
              } catch {
                return 0;
              }
            })(),
          }
        : null,
    });
  }

  /** Bring the socket and the advertisement in line with the config. */
  async apply(cfg: FleetConfig): Promise<void> {
    if (!cfg.enabled) {
      await this.stop();
      return;
    }
    if (this.server) return; // already running with this config

    const addresses = lanAddresses();
    if (addresses.length === 0) {
      // No private interface: refuse rather than binding to something public.
      throw new Error('This machine has no local-network address, so the fleet view cannot start.');
    }

    this.server = await startPeerServer(cfg, {
      summary: () => this.summary(cfg),
      // The peer server refuses the guesser; saying so out loud is this
      // machine's job, and the fleet panel is where the code was shown.
      onPairingAbuse: (address: string) => { this.abuse = { address, at: Date.now() }; },
      startScan: async (path: string) => {
        // Routed through the ordinary scan path, which applies every existing
        // guard. Imported lazily to keep the fleet module out of the boot path.
        const { startScan } = await import('../diskScanner');
        const scan = await startScan(path, {});
        return { scanId: scan.scanId };
      },
    }, addresses);

    this.mdns = new MdnsResponder({
      instanceName: cfg.instanceId.slice(0, 8),
      port: this.server.port,
      address: addresses[0],
      txt: { id: cfg.instanceId, label: cfg.label, v: process.env.npm_package_version || '' },
    });
    this.mdns.on('peer', (peer: DiscoveredPeer) => this.remember(peer));
    try {
      await this.mdns.start();
    } catch {
      // Discovery is a convenience: a machine that cannot join the multicast
      // group can still be paired by typing its address. Losing it must not
      // take the whole feature down.
      this.mdns = null;
    }
  }

  private remember(peer: DiscoveredPeer): void {
    const id = peer.txt.id || peer.instanceName;
    if (!id) return;
    this.seen.set(id, {
      instanceId: id,
      label: peer.txt.label || peer.instanceName,
      address: peer.address,
      port: peer.port,
      version: peer.txt.v || null,
      seenAt: Date.now(),
    });
  }

  /** Everything advertising right now, minus ourselves. */
  discovered(ownId?: string): DiscoveredEntry[] {
    const now = Date.now();
    const out: DiscoveredEntry[] = [];
    for (const [id, entry] of this.seen) {
      if (now - entry.seenAt > DISCOVERY_TTL_MS) {
        this.seen.delete(id);
        continue;
      }
      if (ownId && id === ownId) continue;
      out.push(entry);
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  async stop(): Promise<void> {
    const { server, mdns } = this;
    this.server = null;
    this.mdns = null;
    this.seen.clear();
    if (mdns) await mdns.stop().catch(() => undefined);
    if (server) await server.close().catch(() => undefined);
  }
}

let runtime: FleetRuntime | null = null;

export function fleetRuntime(): FleetRuntime {
  if (!runtime) runtime = new FleetRuntime();
  return runtime;
}

/**
 * Start the fleet at boot ONLY if it was already turned on.
 *
 * A failure here is logged and swallowed: the fleet view is an extra, and an
 * unreachable multicast group or a taken port must never stop TreeMap starting.
 */
export async function initFleet(): Promise<void> {
  try {
    const cfg = await loadFleetConfig();
    if (!cfg.enabled) return;
    await fleetRuntime().apply(cfg);
  } catch (err) {
    console.error('[treemap] fleet did not start:', err instanceof Error ? err.message : err);
  }
}
