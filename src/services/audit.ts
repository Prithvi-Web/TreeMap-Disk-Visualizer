import { promises as fsp } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { AuditEntry } from '../models/types';
import { appDataDir } from './storage';

/**
 * audit — an append-only JSONL record of every destructive request (real,
 * dry-run, or refused), under the app-data directory. One JSON object per
 * line; GET /api/audit reads it back. Append failures are logged and
 * swallowed: auditing must never turn a working delete into an error.
 */

const AUDIT_FILE = 'audit.jsonl';
/** Read-back guard: never parse more than this many trailing lines. */
const MAX_READ_LINES = 1000;

/** Serialize appends so concurrent requests can't interleave partial lines. */
let queue: Promise<void> = Promise.resolve();

export function auditFilePath(): string {
  return path.join(appDataDir(), AUDIT_FILE);
}

/** Short digest identifying the presented credential; 'local' when auth is off. */
export function tokenIdFor(source: 'http' | 'mcp'): string {
  const token = process.env.TREEMAP_TOKEN;
  if (!token) return source === 'mcp' ? 'local-mcp' : 'local';
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);
}

/** Append one entry. Resolves when written; never rejects. */
export function appendAudit(entry: Omit<AuditEntry, 'at'>): Promise<void> {
  const full: AuditEntry = { at: Date.now(), ...entry };
  queue = queue
    .catch(() => {
      /* an earlier failed append must not poison the queue */
    })
    .then(async () => {
      const dir = appDataDir();
      await fsp.mkdir(dir, { recursive: true });
      await fsp.appendFile(auditFilePath(), JSON.stringify(full) + '\n', 'utf8');
    })
    .catch((err: unknown) => {
      console.error('[treemap] audit append failed:', err);
    });
  return queue;
}

/** The most recent `limit` entries, newest first. Unparseable lines are skipped. */
export async function readAudit(limit: number): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(auditFilePath(), 'utf8');
  } catch {
    return []; // no log yet
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const tail = lines.slice(-Math.min(Math.max(limit, 1), MAX_READ_LINES));
  const entries: AuditEntry[] = [];
  for (const line of tail) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      /* torn or corrupt line — skip it, keep the rest honest */
    }
  }
  return entries.reverse();
}
