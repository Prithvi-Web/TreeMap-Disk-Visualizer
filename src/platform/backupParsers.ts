/**
 * Pure parsers for the backup-membership readers (v4 §1.2b).
 *
 * Separated from the per-OS readers for the usual reason: the interesting
 * states — a configured Time Machine, an excluded folder, a File History
 * config — cannot be produced on the machine running the tests, and the
 * parse seam is the only place they can be covered honestly. This Mac has
 * **no Time Machine destination configured**, so the populated paths below
 * have never run live here; see the phase check-in.
 *
 * One rule governs everything in this file: **nothing here may ever conclude
 * `pathCovered: 'yes'`.** A false "this is backed up" is the one error in
 * TreeMap that directly destroys data — someone reads it, deletes their only
 * copy, and the backup never had the file. Every mechanism available without
 * mounting and traversing the backup destination (which §1.2b forbids) can
 * establish only two things: that a backup exists, and that a path is not on
 * the exclusion list. Neither is proof of coverage.
 */

/* ------------------------------ macOS: tmutil ------------------------------ */

/**
 * Parse `tmutil destinationinfo`.
 *
 * With no destination it prints exactly `tmutil: No destinations configured.`
 * — **and exits 0**, which is why the text is parsed rather than the exit code
 * trusted. (`tmutil latestbackup` likewise exits 0 while printing a mount
 * failure; both were observed directly on this Mac.)
 *
 * With one configured, it prints a block of `Key : Value` lines:
 *
 *     ====================================================
 *     Name          : Time Machine
 *     Kind          : Local
 *     Mount Point   : /Volumes/Backup
 *     ID            : 1E2D...
 */
export function parseDestinationInfo(text: string): { configured: boolean; name: string | null } {
  if (/no destinations configured/i.test(text)) return { configured: false, name: null };
  const name = /^\s*Name\s*:\s*(.+)$/m.exec(text);
  const hasFields = /^\s*(Kind|ID|Mount Point|URL)\s*:/m.test(text);
  if (!name && !hasFields) return { configured: false, name: null };
  return { configured: true, name: name ? name[1].trim() : null };
}

/**
 * Parse `tmutil latestbackup`, which prints a backup path whose final
 * component is a timestamp:
 *
 *     /Volumes/Backup/Backups.backupdb/Mac/2026-08-20-134501
 *
 * Returns null for anything else — including the `Failed to mount destination`
 * error it emits **with exit code 0** when the drive is not attached. A
 * configured-but-unreachable backup is a real state, and it reports a null
 * date rather than a fabricated one.
 */
export function parseLatestBackup(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed || /error|failed/i.test(trimmed)) return null;
  const stamp = /(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(trimmed);
  if (!stamp) return null;
  const [, y, mo, d, h, mi, sec] = stamp;
  // Time Machine names snapshots in local time; constructing a local Date is
  // what makes "last backup 3 hours ago" read correctly for the user.
  const when = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
  const ms = when.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse `tmutil isexcluded <path>...`, which is batchable and, unlike `mdls`,
 * **echoes each path back** — so answers are matched by name rather than by
 * array position:
 *
 *     [Included]  /Users/me/Desktop
 *     [Excluded]  /Users/me/Downloads/big
 *
 * Returns path → excluded. A path missing from the output is absent from the
 * map, and the caller treats that as unknown rather than as included.
 */
export function parseIsExcluded(text: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const line of text.split('\n')) {
    const m = /^\s*\[(Included|Excluded)\]\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    out.set(m[2], m[1] === 'Excluded');
  }
  return out;
}

/**
 * Turn what tmutil could establish into a membership verdict.
 *
 * The whole point of this function is the branch it does **not** have. An
 * included path, on a machine with a configured destination and a recent
 * completed backup, is still `'unknown'` — because "not on the exclusion list"
 * is not "present in the backup". A file created since the last backup, or one
 * that failed to copy, is included and absent. Promoting that to `'yes'` is
 * the one inference that would let TreeMap tell someone it is safe to delete
 * their only copy.
 */
export function membershipFromTmutil(
  configured: boolean,
  lastBackupMs: number | null,
  excluded: boolean | undefined,
): { configured: boolean; lastBackupMs: number | null; pathCovered: 'yes' | 'no' | 'unknown'; mechanism: string } {
  if (!configured) {
    return { configured: false, lastBackupMs: null, pathCovered: 'unknown', mechanism: 'Time Machine' };
  }
  // Excluded is the one thing tmutil can prove: this path will never be in a
  // backup, so deletion is permanent as far as Time Machine is concerned.
  if (excluded === true) {
    return { configured: true, lastBackupMs, pathCovered: 'no', mechanism: 'Time Machine' };
  }
  return { configured: true, lastBackupMs, pathCovered: 'unknown', mechanism: 'Time Machine' };
}

/* ------------------------------ Linux: restic / borg ------------------------------ */

/**
 * Which backup tools appear to be configured, from the presence of their
 * config in the standard locations.
 *
 * §1.2b is explicit that **presence of a repository is not proof a given file
 * is in it** — and that TreeMap must say exactly that. So this reports only
 * "a backup tool is set up here", the verdict is always `'unknown'`, and the
 * reason string carries the caveat to the user verbatim.
 */
export function backupToolsFromPaths(present: Record<string, boolean>): string[] {
  const found: string[] = [];
  if (present.restic) found.push('restic');
  if (present.borg) found.push('borg');
  if (present.borgmatic) found.push('borgmatic');
  if (present.timeshift) found.push('Timeshift');
  return found;
}

/** The sentence a Linux user sees. It states the limit rather than implying coverage. */
export function linuxBackupReason(tools: string[]): string {
  if (tools.length === 0) {
    return 'No backup tool (restic, borg, borgmatic or Timeshift) appears to be set up on this computer, so TreeMap cannot tell whether anything here has a second copy.';
  }
  return (
    `${tools.join(' and ')} ${tools.length === 1 ? 'is' : 'are'} set up on this computer, but that only means a backup repository exists — ` +
    'it is not proof that this particular file is inside it. TreeMap will not claim a file is backed up when it has not checked.'
  );
}

/* ------------------------------ Windows: File History ------------------------------ */

/**
 * Parse a File History `Config1.xml` far enough to learn whether it is on and
 * which folders it protects.
 *
 * Deliberately shallow: enough to answer "is this configured", never enough to
 * answer "is this file in the backup", which would require reading the backup
 * volume itself. A protected folder still yields `'unknown'` for the same
 * reason `[Included]` does on macOS.
 */
export function parseFileHistoryConfig(xml: string): { enabled: boolean; includedFolders: string[] } {
  const enabled = /<(?:Target|FileHistory)[^>]*\bstate\s*=\s*"?1"?/i.test(xml) || /<ProtectedUpToTime>/i.test(xml);
  const includedFolders: string[] = [];
  for (const m of xml.matchAll(/<Folder[^>]*>\s*<Path[^>]*>([^<]+)<\/Path>/gi)) {
    const value = m[1].trim();
    if (value) includedFolders.push(value);
  }
  return { enabled, includedFolders };
}
