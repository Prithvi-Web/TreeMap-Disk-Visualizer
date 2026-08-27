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
const FORBIDDEN_SUBSTRINGS = [
  'finding', 'secret', 'credential', 'provenance', 'url', 'children', 'tree', 'path',
  // v4 §6 names these explicitly. None of them can reach here today — the
  // allow-list above is a fixed list and nothing adds to it — but that is
  // exactly the assumption this second check exists to stop depending on.
  // Every per-node fact v4 derives is a statement about the contents of this
  // machine's disks, which is the category §D1 bans outright, so each one is
  // named here as it is built rather than after something leaks.
  'reclaim', 'score', // §3 — the reclaim score and its components
  'recoverab', 'elsewhere', 'lastused', // §1 — recoverability and last-opened dates
  'journal', // §7.3 — the disk journal
  'note', // §9.5 — notes pinned to folders
];

/**
 * Copy exactly the allowed fields, and refuse anything that smells like the
 * three categories §D1 bans. `lastScanPath` is the one path that IS allowed —
 * §D1 lists "root path" among the summary fields — so it is exempted by name
 * rather than by loosening the rule.
 */
/**
 * Would this field name be refused by the second check?
 *
 * Exported so it can be tested directly, and that is not a convenience. The
 * allow-list above means a field like `reclaimScore` never reaches the loop
 * below — `serialiseSummary` copies only from `SUMMARY_FIELDS`, so a smuggled
 * field is dropped long before anything inspects its name. The second check
 * only ever fires if somebody *adds* a field to that list, which is precisely
 * the future mistake it exists to catch and precisely the one a test cannot
 * reach through the public function. So the predicate is testable on its own.
 */
export function isForbiddenSummaryField(key: string): boolean {
  if (key === 'lastScanPath') return false; // named in §D1's own list of summary fields
  const lower = key.toLowerCase();
  return FORBIDDEN_SUBSTRINGS.some((banned) => lower.includes(banned));
}

export function serialiseSummary(summary: FleetSummary): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SUMMARY_FIELDS) {
    out[key] = summary[key];
  }
  for (const key of Object.keys(out)) {
    if (isForbiddenSummaryField(key)) {
      throw new Error(`fleet summary would have sent a "${key}" field — refusing`);
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
