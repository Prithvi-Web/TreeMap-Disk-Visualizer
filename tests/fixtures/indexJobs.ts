import assert from 'node:assert/strict';

import { resetRateLimiter } from '../../src/middleware/rateLimiter';
import { waitFor } from './waitFor';

/**
 * The index tests' two HTTP helpers, kept in one place so the copies in
 * tests/indexAutoPlan.test.ts and tests/indexCapAside.test.ts cannot drift
 * apart (review of 5 Oct 2026, L2).
 */

/** A status and a JSON body from the app's HTTP API. */
export interface ApiAnswer {
  status: number;
  json: Record<string, unknown>;
}

/**
 * One request to a TreeMap server at `base`, with `body` (if any) sent as
 * JSON and the answer read as JSON. The rate limiter is reset first, so a
 * test that polls never meets a 429 of its own making.
 */
export async function apiCall(base: string, method: string, url: string, body?: unknown): Promise<ApiAnswer> {
  resetRateLimiter();
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/**
 * Polls an index job's result every 20 ms until the answer is not 202, and
 * returns that answer. The only bound is waitFor's hang guard, which is
 * never a measurement. An error from a request fails the wait at once.
 */
export async function settleIndexJob(base: string, jobId: unknown): Promise<ApiAnswer> {
  let settled: ApiAnswer | undefined;
  await waitFor(async () => {
    const r = await apiCall(base, 'GET', `/api/index/${String(jobId)}/result`);
    if (r.status === 202) return false;
    settled = r;
    return true;
  }, `index job ${String(jobId)} settling`, 20);
  return settled ?? assert.fail(`index job ${String(jobId)} never settled`);
}
