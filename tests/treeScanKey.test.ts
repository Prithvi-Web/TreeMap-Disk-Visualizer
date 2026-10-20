import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INDEX } from './fixtures/liftFrontend';

/**
 * Every page request about the tree on screen names the scan that tree came
 * from — never the scan running behind it (the owner, 20 Oct 2026: "I want
 * all errors fixed"; BQJ-1b).
 *
 * While a scan runs, its id is on hand once its request answers
 * (followScanProgress), but the tree on screen is still the one before it:
 * an older scan's (settledScanId), or the saved index's (none). A scan still
 * walking answers nothing about a tree — 202, 409 SCAN_RUNNING, or every path
 * "unavailable" — so a view that asked it said a server error, or nothing,
 * over a tree it could have described, and after a Stop showed another
 * folder's data. Three review rounds of BQJ-1 each found more views asking
 * the running scan, each with its own copy of the rule. Here the rule has one
 * home, `treeScanId()`, and each view is held to it:
 *
 *  - during a rescan over an older scan's tree, the request names that scan;
 *  - once the rescan lands, the new scan;
 *  - after a Stop, the older tree's scan again;
 *  - over the saved index's tree, which no scan stands behind, nothing is
 *    asked: the view says it fills in once the scan finishes while one is
 *    coming, and that the tree is the saved index once nothing will land.
 *
 * Every function is EXECUTED out of the built page, with the server stubbed
 * under it and a stub DOM. The phases below are the (scanning, scanId,
 * settledScanId) triples the page's own lifecycle produces — coreScanFlow
 * drives the real startScan, followScanProgress, finishScan and stopScan
 * through them ("the scan the tree on screen came from, through a real
 * rescan").
 */

/** A page function by its declaration, brace-matched, out of the built page. */
function pageFn(decl: string): string {
  const start = INDEX.indexOf(decl);
  assert.notEqual(start, -1, `${decl} is in the page`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', INDEX.indexOf(')', start)); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`${decl} never closes`);
}

/** Every top-level function declaration in the page: its name and whole source. */
function pageFunctions(): Array<{ name: string; body: string; at: number }> {
  const out: Array<{ name: string; body: string; at: number }> = [];
  for (const m of INDEX.matchAll(/^(?:async )?function (\w+)\(/gm)) {
    out.push({ name: m[1], body: pageFn(m[0]), at: m.index! });
  }
  return out;
}

/** The top-level function a page offset sits in, or '(top level)'. */
function enclosing(fns: Array<{ name: string; body: string; at: number }>, at: number): string {
  const f = fns.find((x) => x.at <= at && at < x.at + x.body.length);
  return f ? f.name : '(top level)';
}

/* ───────────────────────────── the phases ───────────────────────────── */

type Phase = { scanning: boolean; scanId: string | null; settledScanId: string | null; indexScanDue: boolean };
/** A rescan over the older scan's tree, its request answered (followScanProgress). */
const HELD: Phase = { scanning: true, scanId: 'scan-new', settledScanId: 'scan-old', indexScanDue: false };
/** The rescan landed (finishScan). */
const LANDED: Phase = { scanning: false, scanId: 'scan-new', settledScanId: 'scan-new', indexScanDue: false };
/** A rescan over the older scan's tree, Stopped (stopScan): the older scan is back. */
const STOPPED: Phase = { scanning: false, scanId: 'scan-old', settledScanId: 'scan-old', indexScanDue: false };
/** The saved index's tree on screen, its scan running (openFromIndex, finishScan, followScanProgress). */
const INDEX_RUNNING: Phase = { scanning: true, scanId: 'scan-new', settledScanId: null, indexScanDue: true };
/** The saved index's tree on screen, its scan Stopped: nothing will land (endScanChrome). */
const INDEX_STOPPED: Phase = { scanning: false, scanId: null, settledScanId: null, indexScanDue: false };

/** The rule's own two functions, lifted with whatever is under test. */
const RULE = ['function treeScanId(', 'function treeScanComing('];

/* ───────────────────────────── the rule ───────────────────────────── */

test('the scan the tree on screen came from is decided in one place, treeScanId — no page code spells the rule itself', () => {
  const fns = pageFunctions();
  const spelled = [...INDEX.matchAll(/state\.scanning\s*\?\s*state\.settledScanId\s*:\s*state\.scanId/g)]
    .map((m) => enclosing(fns, m.index!));
  assert.deepEqual(spelled, ['treeScanId'], `the rule is spelled out in: ${spelled.join(', ')}`);
  // Nor under the name an earlier round gave it: one helper, not two (reclaimTreeScan was Reclaim's own).
  assert.ok(!/function reclaimTreeScan\(/.test(INDEX), 'a second helper for the same rule is back');
});

test('treeScanId names the scan behind the tree on screen through a rescan, a landing and a Stop, and none for the saved index\'s tree', () => {
  const state: Record<string, unknown> = {};
  const { treeScanId, treeScanComing } = new Function('state', `${RULE.map(pageFn).join('\n')}\nreturn { treeScanId, treeScanComing };`)(state) as
    { treeScanId: () => string | null; treeScanComing: () => boolean };
  const at = (p: Phase) => { Object.assign(state, p); return treeScanId(); };
  assert.equal(at(HELD), 'scan-old', 'during a rescan, the older scan whose tree is on screen — never the running one');
  assert.equal(at(LANDED), 'scan-new', 'once it lands, the new scan');
  assert.equal(at(STOPPED), 'scan-old', 'after a Stop, the older scan again');
  assert.equal(at(INDEX_RUNNING), null, 'the saved index\'s tree: no scan stands behind it, while its scan runs');
  assert.equal(treeScanComing(), true, 'and one is coming');
  assert.equal(at(INDEX_STOPPED), null, 'nor once that scan is stopped');
  assert.equal(treeScanComing(), false, 'and none is coming');
  Object.assign(state, { scanning: false, indexScanDue: true });
  assert.equal(treeScanComing(), true, 'the index paint, its scan due but not yet requested, has one coming too');
});
