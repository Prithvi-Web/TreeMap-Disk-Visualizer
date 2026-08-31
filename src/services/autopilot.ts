import crypto from 'crypto';
import {
  AutopilotMatch,
  AutopilotPolicy,
  AutopilotRun,
  AutopilotRunItem,
  CleanupSuggestionGroup,
} from '../models/types';
import { readJsonFile, writeJsonFile } from './storage';
import { collectCleanupSuggestions } from './cleanupRules';
import { matchCustomRules } from './scanQueries';
import { parse } from './query/parse';
import { isEmptyQuery } from './query/evaluate';
import { executeAgainstScan } from './query/execute';
import { getIgnoreMatchers } from './settings';
import { startScan, getScan } from './diskScanner';
import { storeOf } from './scanStore';
import { protectAndTrash, listCapsuleEntriesForRun, startCapsuleRestore } from './timeCapsule';
import nodePath from 'path';
import { sanitizePath } from '../utils/pathSanitizer';
import { getPolicy as getAgentPolicy, assertScanAllowed, assertPathsAllowed } from './policy';
import { suppressedNoteRoots, isUnderAny } from './notes';
import { formatBytes } from '../utils/formatBytes';
import { AppError } from '../middleware/errorHandler';

/**
 * Autopilot — scheduled cleanup with safety rails (B1).
 *
 * This is the feature B2 and B3 were built for, and it deliberately owns none
 * of the machinery that does the dangerous part. A run resolves candidates
 * through the existing `CleanupRules`, then hands them to **one** call —
 * `protectAndTrash` — which copies each item into the Time Capsule, verifies
 * it, checks the open-file guard, and only then moves the original to the
 * Trash. There is no delete in this file at all (§B1: "No new deletion pathway
 * is created").
 *
 * ── The rails, and why each exists ──
 *
 * A policy is a standing instruction to delete things while nobody is
 * watching, which makes a mis-written one uniquely dangerous: the user finds
 * out afterwards. So:
 *
 *  - **The first run of a new policy is always a dry run**, whatever
 *    `dryRunFirst` says, and it deletes nothing until the user has seen what it
 *    matched and approved it. §B1 is explicit, and it is the rail that catches
 *    the "I meant *.log, I typed *" class of mistake.
 *  - **`requireConfirmationAbove`** stops a run whose match is unexpectedly
 *    large *before* it starts deleting, rather than discovering it afterwards.
 *  - **Byte caps** bound a single run and a rolling week, so even a correct
 *    policy pointed at the wrong folder cannot empty it overnight.
 *  - **Cooldown** keeps a policy from running again immediately, and doubles as
 *    the schedule — one knob instead of two that can disagree.
 *  - **Undo** puts a whole run back from the Time Capsule, which is why every
 *    run stamps its own id onto the capsule entries it creates.
 *
 * Every one of these refuses *loudly*: a run that did not delete still writes a
 * run record saying what it would have done and why it stopped.
 *
 * ── Storage ──
 *
 * §B1 says "an `autopilot_runs` table". Run history lives in a JSON file
 * alongside the other app-data records instead, because the only database here
 * is the search index — which is explicitly rebuildable and gets wiped on a
 * schema change. Undo history that vanishes when an index is rebuilt would not
 * be history.
 */

const STORE_FILE = 'autopilot.json';
const SCHEMA_VERSION = 1;

/** Run records kept; well beyond the 30-day undo window §B1 requires. */
const MAX_RUNS = 200;
/** Ceiling on items considered in one run — bounds both memory and blast radius. */
const MAX_ITEMS_PER_RUN = 2_000;
const SCAN_TIMEOUT_MS = 30 * 60_000;
const WEEK_MS = 7 * 86_400_000;

interface AutopilotStore {
  version: number;
  policies: AutopilotPolicy[];
  runs: AutopilotRun[];
}

async function loadStore(): Promise<AutopilotStore> {
  const raw = await readJsonFile<Partial<AutopilotStore>>(STORE_FILE, {});
  return {
    version: typeof raw.version === 'number' ? raw.version : SCHEMA_VERSION,
    policies: Array.isArray(raw.policies) ? raw.policies : [],
    runs: Array.isArray(raw.runs) ? raw.runs : [],
  };
}

async function saveStore(store: AutopilotStore): Promise<void> {
  store.version = SCHEMA_VERSION;
  if (store.runs.length > MAX_RUNS) store.runs = store.runs.slice(0, MAX_RUNS);
  await writeJsonFile(STORE_FILE, store);
}

/* ---------------- policy validation (pure — tested) ---------------- */

function clampPositive(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function optionalBytes(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/**
 * Validate one policy from untrusted input.
 *
 * Exported because the rails are only as good as what gets past this: a policy
 * with no match, or one pointed at a blocked system path, must be impossible to
 * save rather than merely unlikely to run.
 */
export function normalizePolicy(raw: unknown, existing?: AutopilotPolicy): AutopilotPolicy {
  const p = (raw ?? {}) as Partial<AutopilotPolicy>;

  if (typeof p.path !== 'string' || !p.path.trim()) {
    throw new AppError(400, 'POLICY_PATH_REQUIRED', 'Every policy needs a folder to work in');
  }
  // Same sanitizer as scan paths: traversal-proofed, virtual filesystems refused.
  const policyPath = sanitizePath(p.path);
  // That sanitizer is tuned for *scanning*, where the whole disk is a
  // reasonable target. A standing instruction to delete things unattended is
  // not: pointed at the filesystem root it would eventually consider every
  // file on the machine. Narrower roots stay the user's choice.
  if (nodePath.parse(policyPath).root === policyPath) {
    throw new AppError(400, 'POLICY_PATH_TOO_BROAD',
      'Pick a folder rather than the whole drive — an automatic cleanup pointed at the root of the disk would eventually consider every file on it');
  }

  const match = normalizeMatch(p.match);
  const name = typeof p.name === 'string' && p.name.trim()
    ? p.name.trim().slice(0, 120)
    : 'Untitled policy';

  return {
    id: typeof p.id === 'string' && p.id ? p.id : crypto.randomUUID(),
    name,
    path: policyPath,
    match,
    maxBytesPerRun: optionalBytes(p.maxBytesPerRun),
    maxBytesPerWeek: optionalBytes(p.maxBytesPerWeek),
    cooldownDays: clampPositive(p.cooldownDays, 7, 1, 365),
    dryRunFirst: p.dryRunFirst !== false,
    requireConfirmationAbove: optionalBytes(p.requireConfirmationAbove),
    enabled: p.enabled === true,
    // Approval and last-run are bookkeeping the engine owns; a client cannot
    // grant approval by sending a field, or the mandatory first dry run would
    // be one crafted request away from being skipped.
    ...(existing?.approvedAt ? { approvedAt: existing.approvedAt } : {}),
    ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
  };
}

function normalizeMatch(raw: unknown): AutopilotMatch {
  const m = (raw ?? {}) as Partial<AutopilotMatch> & Record<string, unknown>;
  if (m.kind === 'suggestion') {
    const groupIds = Array.isArray(m.groupIds)
      ? m.groupIds.filter((g): g is string => typeof g === 'string' && g.length > 0).slice(0, 50)
      : [];
    if (groupIds.length === 0) {
      throw new AppError(400, 'POLICY_MATCH_EMPTY', 'Pick at least one kind of file for this policy to clean up');
    }
    return { kind: 'suggestion', groupIds };
  }
  if (m.kind === 'custom') {
    const maxAgeMs = Number(m.maxAgeMs);
    const minBytes = Number(m.minBytes);
    const exts = Array.isArray(m.exts)
      ? m.exts.filter((e): e is string => typeof e === 'string').map((e) => e.trim().toLowerCase().replace(/^\./, '')).filter(Boolean).slice(0, 50)
      : [];
    const out: AutopilotMatch = { kind: 'custom' };
    if (Number.isFinite(maxAgeMs) && maxAgeMs > 0) out.maxAgeMs = Math.round(maxAgeMs);
    if (Number.isFinite(minBytes) && minBytes > 0) out.minBytes = Math.round(minBytes);
    if (exts.length) out.exts = exts;
    // A custom match with nothing set would select every file under the path.
    // That is never what someone meant, and unattended it would be a disaster.
    if (out.maxAgeMs === undefined && out.minBytes === undefined && !out.exts) {
      throw new AppError(400, 'POLICY_MATCH_EMPTY', 'Set at least one rule — an empty rule would match every file in the folder');
    }
    return out;
  }
  if (m.kind === 'query') {
    // The one parser, at save time. §2.3 refuses to save a query that does not
    // parse for exactly this reason: a policy whose query never parsed would
    // either match nothing forever or fail at the least convenient moment, and
    // save time is the only point at which a person is present to fix it.
    const q = typeof m.q === 'string' ? m.q.trim() : '';
    if (!q) throw new AppError(400, 'POLICY_MATCH_EMPTY', 'This policy needs a query to match on');
    const parsed = parse(q);
    if (!parsed.ok) {
      throw new AppError(400, 'POLICY_QUERY_INVALID', `That query could not be understood: ${parsed.error}`);
    }
    // The same refusal an empty custom rule gets, for the same reason: a query
    // with no terms selects every file under the policy's folder, which is
    // never what anyone meant and unattended would be a disaster.
    if (isEmptyQuery(parsed.ast)) {
      throw new AppError(400, 'POLICY_MATCH_EMPTY', 'That query has no conditions — it would match every file in the folder');
    }
    return { kind: 'query', q };
  }
  throw new AppError(400, 'POLICY_MATCH_INVALID', 'A policy must match cleanup suggestions, custom rules, or a query');
}

/* ---------------- policies ---------------- */

export async function listPolicies(): Promise<AutopilotPolicy[]> {
  return (await loadStore()).policies;
}

/** Replace the whole policy list (the shape the settings UI saves in). */
export async function savePolicies(raw: unknown): Promise<AutopilotPolicy[]> {
  if (!Array.isArray(raw)) throw new AppError(400, 'BAD_POLICIES', '"policies" must be an array');
  if (raw.length > 50) throw new AppError(400, 'TOO_MANY_POLICIES', 'At most 50 policies');

  const store = await loadStore();
  const byId = new Map(store.policies.map((p) => [p.id, p]));
  const next: AutopilotPolicy[] = [];
  for (const entry of raw) {
    const id = (entry as { id?: unknown })?.id;
    const existing = typeof id === 'string' ? byId.get(id) : undefined;
    const policy = normalizePolicy(entry, existing);

    // Changing what a policy matches, or where it runs, invalidates the
    // approval that was granted for the old one — otherwise "approve a tiny
    // dry run, then edit the policy to match everything" would walk straight
    // past the rail that exists to prevent exactly that.
    if (existing && !sameScope(existing, policy)) delete policy.approvedAt;
    next.push(policy);
  }
  store.policies = next;
  await saveStore(store);
  return next;
}

/** Do two versions of a policy select the same things in the same place? */
export function sameScope(a: AutopilotPolicy, b: AutopilotPolicy): boolean {
  return a.path === b.path && JSON.stringify(a.match) === JSON.stringify(b.match);
}

export async function getPolicy(id: string): Promise<AutopilotPolicy | undefined> {
  return (await loadStore()).policies.find((p) => p.id === id);
}

/* ---------------- candidate resolution ---------------- */

export interface Candidate {
  path: string;
  name: string;
  bytes: number;
  reason: string;
  regenerateCmd?: string;
}

/**
 * Turn a policy's match into concrete candidates, largest first.
 *
 * Pure over an already-scanned tree, and exported, so the selection logic —
 * the part that decides what gets deleted — is testable without a filesystem.
 */
export function selectCandidates(
  groups: CleanupSuggestionGroup[],
  customHits: { path: string; name: string; size: number }[],
  match: AutopilotMatch,
): Candidate[] {
  // A query match reuses the same hit list as a custom one — they differ in
  // how the hits were found, not in what is done with them. Handled first so
  // the `else` below keeps meaning "custom".
  if (match.kind === 'query') {
    return customHits
      .map((hit) => ({ path: hit.path, name: hit.name, bytes: hit.size, reason: `matched your query: ${match.q}` }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, MAX_ITEMS_PER_RUN);
  }
  const out: Candidate[] = [];
  if (match.kind === 'suggestion') {
    const wanted = new Set(match.groupIds);
    for (const group of groups) {
      if (!wanted.has(group.id)) continue;
      for (const item of group.items) {
        out.push({
          path: item.path,
          name: item.name,
          bytes: item.size,
          // The rule's own words, so the run record and the Time Capsule entry
          // can both say why this was chosen without inventing wording.
          reason: `matched “${group.title}” — ${group.description}`,
          ...(group.regenerateCmd ? { regenerateCmd: group.regenerateCmd } : {}),
        });
      }
    }
  } else {
    for (const hit of customHits) {
      out.push({ path: hit.path, name: hit.name, bytes: hit.size, reason: describeCustom(match) });
    }
  }
  return out.sort((a, b) => b.bytes - a.bytes).slice(0, MAX_ITEMS_PER_RUN);
}

function describeCustom(match: Extract<AutopilotMatch, { kind: 'custom' }>): string {
  const parts: string[] = [];
  if (match.minBytes) parts.push(`is at least ${formatBytes(match.minBytes)}`);
  if (match.maxAgeMs) parts.push(`is older than ${Math.round(match.maxAgeMs / 86_400_000)} days`);
  if (match.exts?.length) parts.push(`ends in ${match.exts.map((e) => `.${e}`).join(', ')}`);
  return `matched your rule: ${parts.join(' and ')}`;
}

/**
 * Apply the byte ceilings, largest-first.
 *
 * Returns what fits and what did not, so the run record can say "these three
 * were left for next time" rather than quietly stopping. An item larger than
 * the whole remaining budget is skipped rather than ending selection, because
 * one huge folder should not block every smaller thing behind it.
 */
export function applyCaps(
  candidates: Candidate[],
  capBytes: number | null,
): { selected: Candidate[]; skipped: { path: string; reason: string }[] } {
  if (capBytes === null) return { selected: candidates, skipped: [] };

  const selected: Candidate[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let used = 0;
  for (const candidate of candidates) {
    if (used + candidate.bytes <= capBytes) {
      selected.push(candidate);
      used += candidate.bytes;
    } else {
      skipped.push({
        path: candidate.path,
        reason: `left for a later run — this run's limit of ${formatBytes(capBytes)} was reached`,
      });
    }
  }
  return { selected, skipped };
}

/** Bytes this policy has already deleted in the trailing week. */
export function bytesDeletedSince(runs: AutopilotRun[], policyId: string, since: number): number {
  return runs
    .filter((r) => r.policyId === policyId && r.mode === 'live' && r.at >= since && !r.undoneAt)
    .reduce((sum, r) => sum + r.bytesDeleted, 0);
}

/**
 * The effective ceiling for one run: the tighter of the per-run cap and what
 * is left of the weekly budget. `null` only when neither is set.
 */
export function effectiveCap(policy: AutopilotPolicy, runs: AutopilotRun[], now: number): number | null {
  const weeklyRemaining = policy.maxBytesPerWeek === null
    ? null
    : Math.max(0, policy.maxBytesPerWeek - bytesDeletedSince(runs, policy.id, now - WEEK_MS));
  if (policy.maxBytesPerRun === null) return weeklyRemaining;
  if (weeklyRemaining === null) return policy.maxBytesPerRun;
  return Math.min(policy.maxBytesPerRun, weeklyRemaining);
}

/* ---------------- running ---------------- */

function waitForScan(scanId: string): Promise<void> {
  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  return new Promise((resolve) => {
    const check = (): void => {
      const scan = getScan(scanId);
      if (!scan || scan.status !== 'running' || Date.now() > deadline) {
        resolve();
        return;
      }
      // Deliberately ref'd — see scheduler.ts's waitForScan for the full
      // story: an unref'd poll here is the only path to resolution, so the
      // event loop could drain mid-wait and strand the await forever. That is
      // what failed CI on all three OSes. The deadline keeps it bounded.
      setTimeout(check, 1000);
    };
    check();
  });
}

/**
 * Scan the policy's folder and resolve its match into candidates, then apply
 * the one filter that binds every match kind: a folder with a suppressing
 * note (v4 §9.5) is excluded from Autopilot matching, and the exclusion is
 * REPORTED, never silent — an unattended deleter must say what it
 * deliberately left alone, or "your rule matched less today" is
 * indistinguishable from a bug.
 */
async function resolveCandidates(
  policy: AutopilotPolicy,
): Promise<{ candidates: Candidate[]; noteSkipped: { path: string; reason: string }[] }> {
  const matched = await matchCandidates(policy);
  const noted = await suppressedNoteRoots();
  if (noted.length === 0) return { candidates: matched, noteSkipped: [] };
  const candidates: Candidate[] = [];
  const noteSkipped: { path: string; reason: string }[] = [];
  for (const c of matched) {
    const root = noted.find((r) => isUnderAny(c.path, [r]));
    if (root === undefined) {
      candidates.push(c);
    } else {
      noteSkipped.push({
        path: c.path,
        reason: `Left alone — your note on ${root} pauses automatic cleanup there.`,
      });
    }
  }
  return { candidates, noteSkipped };
}

/** Scan the policy's folder and resolve its match into raw candidates. */
async function matchCandidates(policy: AutopilotPolicy): Promise<Candidate[]> {
  const scan = await startScan(policy.path);
  await waitForScan(scan.scanId);
  const done = getScan(scan.scanId);
  if (!done || done.status !== 'complete' || (!done.store && !done.root)) {
    throw new AppError(500, 'AUTOPILOT_SCAN_FAILED', `The folder ${policy.path} could not be scanned`);
  }
  const source = storeOf(done);

  if (policy.match.kind === 'suggestion') {
    const ignore = await getIgnoreMatchers('suggest');
    return selectCandidates(collectCleanupSuggestions(source, ignore), [], policy.match);
  }
  if (policy.match.kind === 'query') {
    // Through `executeAgainstScan` — the same evaluator the query box and
    // POST /api/query use. §7 forbids a second query language and this is
    // where a second one would otherwise start.
    const parsed = parse(policy.match.q);
    if (!parsed.ok) {
      // Unreachable via normalizePolicy, which parses on save. Reached only if
      // autopilot.json was hand-edited — and a policy that cannot be resolved
      // must refuse rather than quietly select nothing, which would read as
      // "your rule matched no files today".
      throw new AppError(400, 'POLICY_QUERY_INVALID', `That policy's query could not be understood: ${parsed.error}`);
    }
    const controller = new AbortController();
    const outcome = await executeAgainstScan(scan.scanId, parsed.ast, {
      limit: MAX_ITEMS_PER_RUN, offset: 0, sort: 'size', signal: controller.signal,
    });
    if ('error' in outcome) throw new AppError(500, outcome.code, outcome.error);
    // Directories are dropped: a query may legitimately ask for `type:dir`,
    // but an unattended policy that trashes a folder because a query said so
    // is a different blast radius from one that trashes the files in it. A
    // person can still stage a folder by hand, where they can see it.
    const files = outcome.hits.filter((h) => !h.isDir);
    return selectCandidates([], files.map((h) => ({ path: h.path, name: h.name, size: h.size })), policy.match);
  }
  const hits = matchCustomRules(
    source,
    { maxAgeMs: policy.match.maxAgeMs, minBytes: policy.match.minBytes, exts: policy.match.exts },
    MAX_ITEMS_PER_RUN,
    Date.now(),
  );
  return selectCandidates([], hits.files, policy.match);
}

export interface SimulationResult {
  policyName: string;
  path: string;
  /** Everything the policy matched that it would be permitted to delete. */
  items: AutopilotRunItem[];
  bytesMatched: number;
  /** What this run would actually remove, after the caps. */
  bytesWouldDelete: number;
  skipped: { path: string; reason: string }[];
  /** The ceiling in force, or null when uncapped. */
  capBytes: number | null;
  /** Set when a real run would refuse — the same reasons `runPolicy` gives. */
  wouldBlockReason?: string;
}

/**
 * Show exactly what a policy would do, changing nothing.
 *
 * Separate from `runPolicy` rather than a flag on it, because a preview must
 * not write a run record or stamp the cooldown: the UI calls this while the
 * user is still editing sliders, and a preview that quietly consumed the
 * policy's schedule would be a trap.
 */
export async function simulatePolicy(policy: AutopilotPolicy): Promise<SimulationResult> {
  const store = await loadStore();
  const agentPolicy = await getAgentPolicy();
  assertScanAllowed(agentPolicy, policy.path);

  const { candidates: resolved, noteSkipped } = await resolveCandidates(policy);
  const skipped: { path: string; reason: string }[] = [];
  const permitted: Candidate[] = [];
  for (const candidate of resolved) {
    try {
      assertPathsAllowed(agentPolicy, [candidate.path]);
      permitted.push(candidate);
    } catch (err) {
      skipped.push({ path: candidate.path, reason: err instanceof AppError ? err.message : 'Refused by agent-policy.json' });
    }
  }

  const bytesMatched = permitted.reduce((sum, c) => sum + c.bytes, 0);
  const cap = effectiveCap(policy, store.runs, Date.now());
  const capped = applyCaps(permitted, cap);

  let wouldBlockReason: string | undefined;
  if (!policy.approvedAt) {
    wouldBlockReason = 'This policy has never run for real. Approving it is what lets it start deleting.';
  } else if (policy.requireConfirmationAbove !== null && bytesMatched > policy.requireConfirmationAbove) {
    wouldBlockReason =
      `A real run would stop and ask: this matches ${formatBytes(bytesMatched)}, more than the ` +
      `${formatBytes(policy.requireConfirmationAbove)} you asked to be consulted about.`;
  } else if (policy.dryRunFirst) {
    wouldBlockReason = 'This policy is set to preview every run, so it never deletes.';
  }

  return {
    policyName: policy.name,
    path: policy.path,
    items: capped.selected.map(toRunItem),
    bytesMatched,
    bytesWouldDelete: capped.selected.reduce((sum, c) => sum + c.bytes, 0),
    skipped: [...noteSkipped, ...skipped, ...capped.skipped],
    capBytes: cap,
    ...(wouldBlockReason ? { wouldBlockReason } : {}),
  };
}

export interface RunOptions {
  /** Simulate only: resolve and report, delete nothing. */
  dryRun?: boolean;
  /** Ignore the cooldown (a run the user asked for explicitly). */
  ignoreCooldown?: boolean;
}

/**
 * Execute one policy.
 *
 * Always writes a run record, including when it decides not to delete — a
 * policy that silently does nothing is indistinguishable from one that is
 * broken, and the user needs to be able to tell those apart.
 */
export async function runPolicy(policy: AutopilotPolicy, opts: RunOptions = {}): Promise<AutopilotRun> {
  const store = await loadStore();
  const now = Date.now();

  const run: AutopilotRun = {
    id: crypto.randomUUID(),
    policyId: policy.id,
    policyName: policy.name,
    at: now,
    mode: 'dry-run',
    status: 'completed',
    items: [],
    bytesMatched: 0,
    bytesDeleted: 0,
    skipped: [],
  };

  const record = async (): Promise<AutopilotRun> => {
    const fresh = await loadStore();
    fresh.runs.unshift(run);
    const live = fresh.policies.find((p) => p.id === policy.id);
    if (live) live.lastRunAt = now;
    await saveStore(fresh);
    return run;
  };

  // Cooldown first: it is the cheapest check and the only one that should not
  // cost a full scan of the user's folder.
  if (!opts.ignoreCooldown && policy.lastRunAt && now - policy.lastRunAt < policy.cooldownDays * 86_400_000) {
    const daysLeft = Math.ceil((policy.cooldownDays * 86_400_000 - (now - policy.lastRunAt)) / 86_400_000);
    run.status = 'blocked';
    run.blockedReason = `Waiting out its cooldown — next run in about ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`;
    // A cooldown block is not a run: it must not restart the clock, or a
    // frequent tick would push the next real run away forever.
    const fresh = await loadStore();
    fresh.runs.unshift(run);
    await saveStore(fresh);
    return run;
  }

  let candidates: Candidate[];
  try {
    // agent-policy.json is the user's own "never touch these" list. It was
    // written for the API surface, but an unattended deleter is exactly what
    // those paths need protecting from, so it binds here too.
    const agentPolicy = await getAgentPolicy();
    assertScanAllowed(agentPolicy, policy.path);
    const resolvedRun = await resolveCandidates(policy);
    candidates = resolvedRun.candidates;
    // Noted-folder skips land in the run record for the same reason the
    // agent-policy ones below do: visible, never quietly dropped.
    run.skipped.push(...resolvedRun.noteSkipped);

    // Per candidate rather than all-or-nothing: one protected folder caught by
    // a broad rule should not cancel an otherwise legitimate cleanup, but it
    // must be visible in the run record rather than quietly dropped.
    const permitted: Candidate[] = [];
    for (const candidate of candidates) {
      try {
        assertPathsAllowed(agentPolicy, [candidate.path]);
        permitted.push(candidate);
      } catch (err) {
        run.skipped.push({
          path: candidate.path,
          reason: err instanceof AppError ? err.message : 'Refused by agent-policy.json',
        });
      }
    }
    candidates = permitted;
  } catch (err) {
    run.status = 'failed';
    run.blockedReason = err instanceof Error ? err.message : String(err);
    return record();
  }

  run.bytesMatched = candidates.reduce((sum, c) => sum + c.bytes, 0);
  run.items = candidates.map(toRunItem);

  // §B1's mandatory first dry run. Deliberately checked AFTER resolving, so the
  // approval request can show exactly what the policy matched — approving
  // blind would make the rail worthless.
  const neverApproved = !policy.approvedAt;
  if (neverApproved) {
    run.status = 'awaiting-approval';
    run.blockedReason =
      `This policy has never run. Here is exactly what it would delete — ${formatBytes(run.bytesMatched)} across ` +
      `${candidates.length} item${candidates.length === 1 ? '' : 's'}. Approve it to let it run for real.`;
    return record();
  }

  if (opts.dryRun || policy.dryRunFirst) {
    run.blockedReason = 'Simulated — this policy is set to preview every run rather than delete.';
    return record();
  }

  // An unexpectedly large match stops here rather than being trimmed by the
  // cap and executed: the size itself is the signal that something is wrong.
  if (policy.requireConfirmationAbove !== null && run.bytesMatched > policy.requireConfirmationAbove) {
    run.status = 'awaiting-approval';
    run.blockedReason =
      `This matched ${formatBytes(run.bytesMatched)}, which is more than the ${formatBytes(policy.requireConfirmationAbove)} ` +
      `you asked to be consulted about. Nothing was deleted.`;
    return record();
  }

  const cap = effectiveCap(policy, store.runs, now);
  if (cap !== null && cap <= 0) {
    run.status = 'blocked';
    run.blockedReason = `This policy has used its weekly allowance of ${formatBytes(policy.maxBytesPerWeek ?? 0)}. It will resume next week.`;
    return record();
  }
  const { selected, skipped } = applyCaps(candidates, cap);
  // Append, never assign: anything already skipped here was refused by
  // agent-policy.json, and overwriting the list would silently drop the one
  // refusal the user most needs to see.
  run.skipped = [...run.skipped, ...skipped];
  run.items = selected.map(toRunItem);

  if (selected.length === 0) {
    run.blockedReason = candidates.length > 0
      ? 'Everything it matched is larger than the remaining allowance, so nothing was deleted.'
      : 'Nothing matched this time.';
    return record();
  }

  // The only deletion in this file, and it is somebody else's: protectAndTrash
  // copies each item into the Time Capsule, verifies it, runs the open-file
  // guard and only then trashes. Whatever it could not protect, it did not
  // delete — and says so.
  run.mode = 'live';
  run.capsuleRunId = run.id;
  const result = await protectAndTrash(
    selected.map((c) => ({ path: c.path, reason: c.reason })),
    { runId: run.id, policyId: policy.id },
  );

  const trashed = new Set(result.trashed);
  run.items = selected.filter((c) => trashed.has(c.path)).map(toRunItem);
  run.bytesDeleted = selected.filter((c) => trashed.has(c.path)).reduce((sum, c) => sum + c.bytes, 0);
  run.skipped = [
    ...run.skipped,
    ...result.skipped.map((s) => ({ path: s.path, reason: s.detail ?? 'It could not be protected, so it was left alone.' })),
  ];
  if (run.items.length === 0) {
    run.status = 'blocked';
    run.blockedReason = 'Nothing could be safely protected, so nothing was deleted.';
  }
  return record();
}

function toRunItem(c: Candidate): AutopilotRunItem {
  return {
    path: c.path,
    name: c.name,
    bytes: c.bytes,
    reason: c.reason,
    ...(c.regenerateCmd ? { regenerateCmd: c.regenerateCmd } : {}),
  };
}

/* ---------------- approval, history, undo ---------------- */

/**
 * Approve a policy that has shown its first dry run.
 *
 * Approval is granted against the *run the user actually looked at*: if the
 * policy's scope changed since, the approval would be for something else.
 */
export async function approvePolicy(policyId: string): Promise<AutopilotPolicy> {
  const store = await loadStore();
  const policy = store.policies.find((p) => p.id === policyId);
  if (!policy) throw new AppError(404, 'POLICY_NOT_FOUND', 'No such policy');
  policy.approvedAt = Date.now();
  // The dry run that earned this approval stamped `lastRunAt`, which would
  // otherwise leave the user waiting out a full cooldown right after saying
  // "yes, do it". Clearing it lets the next tick pick the policy up.
  delete policy.lastRunAt;
  await saveStore(store);
  return policy;
}

export async function listRuns(limit = 50): Promise<AutopilotRun[]> {
  const store = await loadStore();
  return store.runs.slice(0, Math.min(Math.max(limit, 1), MAX_RUNS));
}

export async function getRun(id: string): Promise<AutopilotRun | undefined> {
  return (await loadStore()).runs.find((r) => r.id === id);
}

/**
 * Undo a run: put everything it deleted back, from the Time Capsule.
 *
 * Returns the restore job so the caller can follow it over SSE, exactly like
 * any other restore. Fails loudly when the capsule no longer holds the run —
 * past its retention window, or evicted — rather than reporting a partial
 * success that leaves the user unsure what came back.
 */
export async function undoRun(runId: string): Promise<{ jobId: string; entryCount: number }> {
  const store = await loadStore();
  const run = store.runs.find((r) => r.id === runId);
  if (!run) throw new AppError(404, 'RUN_NOT_FOUND', 'No such run');
  if (run.mode !== 'live' || run.bytesDeleted === 0) {
    throw new AppError(409, 'NOTHING_TO_UNDO', 'That run did not delete anything');
  }
  if (run.undoneAt) throw new AppError(409, 'ALREADY_UNDONE', 'That run has already been undone');

  const entries = (await listCapsuleEntriesForRun(run.capsuleRunId ?? run.id))
    .filter((e) => e.hasPayload && !e.restoredAt);
  if (entries.length === 0) {
    throw new AppError(409, 'CAPSULE_EMPTY',
      'The Time Capsule no longer holds the copies from that run, so it cannot be undone. ' +
      'Copies are kept for a limited time and can be evicted to make room.');
  }

  const job = await startCapsuleRestore(entries.map((e) => e.id));
  run.undoneAt = Date.now();
  await saveStore(store);
  return { jobId: job.jobId, entryCount: entries.length };
}

/* ---------------- the scheduled tick ---------------- */

/**
 * Run every policy that is due. Called by the existing Scheduler's tick rather
 * than a second timer of its own (§B1: extend the Scheduler, don't duplicate).
 */
export async function runDuePolicies(now = Date.now()): Promise<AutopilotRun[]> {
  const store = await loadStore();
  const out: AutopilotRun[] = [];
  for (const policy of store.policies) {
    if (!policy.enabled) continue;
    const due = !policy.lastRunAt || now - policy.lastRunAt >= policy.cooldownDays * 86_400_000;
    if (!due) continue;
    try {
      out.push(await runPolicy(policy));
    } catch (err) {
      console.error('[treemap] autopilot policy failed:', err);
    }
  }
  return out;
}
