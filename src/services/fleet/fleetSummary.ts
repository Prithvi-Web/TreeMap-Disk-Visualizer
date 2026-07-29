import os from 'os';

/**
 * fleetSummary — the ONLY shape that ever leaves this machine (§D1).
 *
 * §D1 names three things that must never cross the network: full file trees,
 * security findings (§C5), and provenance URLs (§C3). Rather than trusting
 * every future caller to remember that, the summary is built by an explicit
 * allow-list here — a field that is not named below cannot be sent, because
 * nothing else is ever serialised.
 *
 * The rule for adding a field: it must be something you would be comfortable
 * printing on a screen in a shared office, because that is effectively what a
 * LAN broadcast is. "This machine has 400 GB free" is fine. "This machine has
 * a file called tax-return-2025.pdf" is not, and "there is a private key in
 * ~/Downloads" is emphatically not.
 */

export interface FleetSummary {
  /** A name the user chose, or the hostname. Never a username or a path. */
  label: string;
  /** Opaque, stable id for this instance. Not derived from anything personal. */
  instanceId: string;
  version: string;
  platform: string;
  /** The volume figures — the whole point of the feature. */
  totalBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  /** The root of the most recent scan, and when. */
  lastScanPath: string | null;
  lastScanAt: number | null;
  lastScanBytes: number | null;
  /** Whether this peer will accept a remote scan request at all. */
  acceptsRemoteScan: boolean;
}

/**
 * Every key `FleetSummary` may contain. The serialiser below copies these and
 * nothing else, so an object handed in with extra fields cannot leak them.
 */
export const SUMMARY_FIELDS = [
  'label', 'instanceId', 'version', 'platform',
  'totalBytes', 'usedBytes', 'freeBytes',
  'lastScanPath', 'lastScanAt', 'lastScanBytes',
  'acceptsRemoteScan',
] as const;

/**
 * Fields that must NEVER appear, checked at the boundary.
 *
 * Belt and braces on top of the allow-list: if a future change makes the
 * builder emit one of these, `serialiseSummary` throws rather than sending it.
 * A crash here is enormously preferable to a quiet disclosure.
 */
const FORBIDDEN_SUBSTRINGS = ['finding', 'secret', 'credential', 'provenance', 'url', 'children', 'tree', 'path'];

/**
 * Copy exactly the allowed fields, and refuse anything that smells like the
 * three categories §D1 bans. `lastScanPath` is the one path that IS allowed —
 * §D1 lists "root path" among the summary fields — so it is exempted by name
 * rather than by loosening the rule.
 */
export function serialiseSummary(summary: FleetSummary): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SUMMARY_FIELDS) {
    out[key] = summary[key];
  }
  for (const key of Object.keys(out)) {
    if (key === 'lastScanPath') continue; // named in §D1's own list of summary fields
    const lower = key.toLowerCase();
    for (const banned of FORBIDDEN_SUBSTRINGS) {
      if (lower.includes(banned)) {
        throw new Error(`fleet summary would have sent a "${key}" field — refusing`);
      }
    }
  }
  return out;
}

export interface SummaryInputs {
  label: string;
  instanceId: string;
  version: string;
  acceptsRemoteScan: boolean;
  usage: { total: number; used: number; free: number } | null;
  /**
   * Deliberately NOT a ScanResult: passing one in would put a whole scan store
   * within reach of this builder. Only the three facts §D1 allows are accepted.
   */
  lastScan: { rootPath: string; finishedAt?: number; totalBytes: number } | null;
}

/** Build the summary from local state. Nothing here reads a file tree. */
export function buildSummary(inputs: SummaryInputs): FleetSummary {
  const { usage, lastScan } = inputs;
  return {
    label: inputs.label || os.hostname(),
    instanceId: inputs.instanceId,
    version: inputs.version,
    platform: process.platform,
    totalBytes: usage ? usage.total : null,
    usedBytes: usage ? usage.used : null,
    freeBytes: usage ? usage.free : null,
    lastScanPath: lastScan ? lastScan.rootPath : null,
    lastScanAt: lastScan?.finishedAt ?? null,
    // The scanned size, not the tree. One number, not a structure.
    lastScanBytes: lastScan?.totalBytes ?? null,
    acceptsRemoteScan: inputs.acceptsRemoteScan,
  };
}
