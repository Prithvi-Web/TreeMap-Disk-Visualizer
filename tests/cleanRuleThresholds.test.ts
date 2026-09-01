import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Clean Up → Find matching files: a ticked rule with no value in its box.
 *
 * `GET /api/cleanup/rules` decides what counts as a threshold with
 * `positiveRule`: both `maxAgeMs` and `minBytes` are FLOORS — "at least this
 * old", "at least this big" — so 0, blank, junk and Infinity rule nothing out
 * and are dropped rather than searched on. That guard is right; it is what
 * stops one typo in the age box from offering the whole disk for deletion.
 *
 * It landed without its caller. The panel ships BOTH threshold checkboxes
 * ticked and its number inputs declare `min="0"`, so 0 is a value the UI
 * presents as legal — and the client sent `maxAgeMs=0` anyway. The server
 * discarded it, found no rules left, and answered 400 "Enable at least one
 * rule" to a user sitting in front of a rule that is plainly enabled. The
 * sentence is false and it also misdirects: it sends them hunting for a
 * checkbox instead of to the empty field beside it.
 *
 * Two invariants are pinned here, and neither is a wording:
 *
 *   1. **What it SENDS.** A threshold the server would discard is never put on
 *      the query string. Whether the search then runs depends on what is left,
 *      not on how many boxes are ticked.
 *   2. **What it SAYS.** When the ticked rules reduce to nothing, the refusal
 *      names the box that needs a value. "Enable at least one rule" stays for
 *      the one case where it is true — nothing ticked at all.
 *
 * Both are asserted by running the real click handler out of the built page
 * with stubbed globals (the harness in tests/cleanUpModalHonesty.test.ts), so
 * they are pins on behaviour rather than on source text.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** Index of the `}` matching the `{` at `open`. */
function matchingBrace(open: number): number {
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return i;
  }
  return assert.fail(`the block opening at ${open} never closes`);
}

const FIND_HEADER = "$('cleanFindBtn').addEventListener('click', async () => {";

/** The body of the Find-matching-files click handler, statements only. */
function findBody(): string {
  const start = INDEX.indexOf(FIND_HEADER);
  assert.notEqual(start, -1, 'the Find matching files handler is findable');
  const open = start + FIND_HEADER.length - 1;
  return INDEX.slice(open + 1, matchingBrace(open));
}

/**
 * Run a slice of app source in Node with every global it touches passed in as
 * a parameter, which is what makes them stubbable at all — the app declares
 * these as top-level `function`s and `let`s in one shared scope.
 */
function runnable(body: string, deps: Record<string, unknown>, args = ''): (...a: any[]) => any {
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, `return async function (${args}) {${body}\n};`)(...keys.map((k) => deps[k]));
}

interface Box { checked?: boolean; value?: string }
interface Shown { msg: string; kind?: string }

/**
 * Press Find with the four rule rows in a given state and report everything
 * the press produced: the toasts, and the query string of the one request —
 * if any — that reached `/api/cleanup/rules`.
 *
 * Defaults mirror the shipped markup, where both threshold boxes arrive ticked
 * and the other two do not. Only the deviation is worth writing in each test.
 */
async function pressFind(boxes: Record<string, Box>) {
  const els: Record<string, any> = {};
  const $ = (id: string): any => (els[id] ||= {
    checked: false, value: '', innerHTML: '', textContent: '', disabled: false,
    style: {}, classList: { add() {}, remove() {} },
  });
  Object.assign($('ruleAgeOn'), { checked: true });
  Object.assign($('ruleSizeOn'), { checked: true });
  Object.assign($('ruleAgeDays'), { value: '180' });
  Object.assign($('ruleSizeMb'), { value: '100' });
  $('ruleExtOn'); $('ruleDupOn'); $('ruleExts');
  for (const [id, patch] of Object.entries(boxes)) Object.assign($(id), patch);

  const toasts: Shown[] = [];
  const urls: string[] = [];
  const fn = runnable(findBody(), {
    $,
    state: { scanId: 's1', root: { path: '/r' }, treemap: {} },
    cleanRuleSource: 'rules',
    toast: (msg: string, kind?: string) => { toasts.push({ msg, kind }); },
    // The fetcher `runCleanFind` is handed is where the URL is built, so the
    // stub has to actually invoke it rather than just record that it was
    // passed one.
    runCleanFind: async (fetcher: () => Promise<unknown>) => { await fetcher(); },
    api: async (url: string) => { urls.push(url); return { files: [], matched: 0 }; },
    findBySavedView: async () => ({ files: [], matched: 0 }),
  });
  await fn();
  const sent = urls.length ? new URLSearchParams(urls[0].split('?')[1]) : null;
  return { toasts, urls, sent };
}

const DAY = 86_400_000;
const MB = 1_048_576;

/** The single refusal a press produced, asserting there was exactly one. */
function refusal(toasts: Shown[]): string {
  const red = toasts.filter((t) => t.kind === 'error');
  assert.equal(red.length, 1, `exactly one refusal, got ${JSON.stringify(toasts)}`);
  return red[0].msg;
}

/* ══════════ 1. A ticked box with no value is not a rule, and is not sent ══════════ */

test('age ticked with 0 is not sent, and the refusal names the age box', async () => {
  // "Older than 0 days" excludes nothing, so the server drops it and its
  // NO_RULES guard fires. Sending it buys a 400 and a sentence that is false
  // about the very row the user is looking at.
  const { toasts, urls } = await pressFind({
    ruleAgeDays: { value: '0' },
    ruleSizeOn: { checked: false },
  });

  assert.equal(urls.length, 0, 'a request the server can only refuse is never made');
  const msg = refusal(toasts);
  assert.doesNotMatch(msg, /enable at least one rule/i,
    `the age rule IS enabled — that sentence is a lie here: ${msg}`);
  assert.match(msg, /older than/i, 'the box that needs a value is named');
});

test('size ticked with an empty box is not sent, and the refusal names the size box', async () => {
  // Clearing a number input is the ordinary way to start retyping it, and
  // `Number('')` is 0 — the same non-threshold, reached without typing a 0.
  const { toasts, urls } = await pressFind({
    ruleAgeOn: { checked: false },
    ruleSizeMb: { value: '' },
  });

  assert.equal(urls.length, 0, 'nothing to search on, so nothing is asked');
  const msg = refusal(toasts);
  assert.doesNotMatch(msg, /enable at least one rule/i, msg);
  assert.match(msg, /larger than/i, 'the box that needs a value is named');
});

test('both thresholds at 0 names both boxes, not a checkbox', async () => {
  // The shipped state of the panel: both ticked. Zero them and the refusal has
  // to account for both, or the user fixes one box and presses Find again into
  // the same wall.
  const { toasts, urls } = await pressFind({
    ruleAgeDays: { value: '0' },
    ruleSizeMb: { value: '0' },
  });

  assert.equal(urls.length, 0);
  const msg = refusal(toasts);
  assert.doesNotMatch(msg, /enable at least one rule/i, msg);
  assert.match(msg, /older than/i, 'the age box is named');
  assert.match(msg, /larger than/i, 'and so is the size box');
});

test('junk and Infinity are thresholds no more than 0 is', async () => {
  // `Number('1e999')` is Infinity, which `positiveRule` rejects for being
  // non-finite; a number input can also hand back text a spinner never
  // produced. Both must be judged here exactly as the server judges them,
  // otherwise the 400 comes back by a different door.
  for (const value of ['1e999', 'abc']) {
    const { toasts, urls } = await pressFind({ ruleAgeDays: { value }, ruleSizeOn: { checked: false } });
    assert.equal(urls.length, 0, `"${value}" is not a threshold, so no request is made`);
    assert.doesNotMatch(refusal(toasts), /enable at least one rule/i, `for value "${value}"`);
  }
});

/* ══════════ 2. What survives is still sent, and sent unchanged ══════════ */

test('ordinary positive values reach the server untouched', async () => {
  // The fix must not overcorrect into refusing work: the default 180 days and
  // 100 MB are real thresholds and go out exactly as they always did.
  const { toasts, sent } = await pressFind({});

  assert.ok(sent, 'the search runs');
  assert.equal(sent!.get('maxAgeMs'), String(180 * DAY));
  assert.equal(sent!.get('minBytes'), String(100 * MB));
  assert.equal(sent!.get('scanId'), 's1');
  assert.equal(sent!.get('limit'), '500');
  assert.equal(toasts.filter((t) => t.kind === 'error').length, 0, 'and says nothing red about it');
});

test('one dead box does not take the live rules down with it', async () => {
  // Age at 0 next to a real size rule: the server would have discarded the age
  // and answered on the size alone, so the request must carry the size alone.
  // Sending `maxAgeMs=0` describes a filter that is not being applied.
  const { sent } = await pressFind({ ruleAgeDays: { value: '0' } });

  assert.ok(sent, 'the size rule is still a rule, so the search still runs');
  assert.equal(sent!.get('minBytes'), String(100 * MB));
  assert.equal(sent!.has('maxAgeMs'), false,
    'a threshold the server will drop is not put on the wire as though it filtered something');
});

test('a rule that is not a threshold still carries the request on its own', async () => {
  // Extensions and duplicates are not floors — an empty extension list is
  // already no-rule server-side, and `dup` has no value to be zero.
  const { sent } = await pressFind({
    ruleAgeDays: { value: '0' },
    ruleSizeMb: { value: '0' },
    ruleExtOn: { checked: true },
    ruleExts: { value: '.LOG, tmp' },
    ruleDupOn: { checked: true },
  });

  assert.ok(sent, 'two live rules remain, so the search runs');
  assert.equal(sent!.get('exts'), 'log,tmp');
  assert.equal(sent!.get('dup'), '1');
  assert.equal(sent!.has('maxAgeMs'), false);
  assert.equal(sent!.has('minBytes'), false);
});

/* ══════════ 3. The checks that were already right stay right ══════════ */

test('nothing ticked is the one case that really is "enable a rule"', async () => {
  const { toasts, urls } = await pressFind({
    ruleAgeOn: { checked: false },
    ruleSizeOn: { checked: false },
  });
  assert.equal(urls.length, 0);
  assert.match(refusal(toasts), /enable at least one rule/i,
    'with every box unticked the original sentence is the true one');
});

test('extensions ticked with an empty list still asks for an extension', async () => {
  const { toasts, urls } = await pressFind({
    ruleAgeOn: { checked: false },
    ruleSizeOn: { checked: false },
    ruleExtOn: { checked: true },
  });
  assert.equal(urls.length, 0);
  assert.match(refusal(toasts), /extension/i, 'and names the field it wants filled');
});

test('a filled-but-unticked extension box cannot smuggle a rule-less request out', async () => {
  // `exts` is parsed whether or not the row is ticked, so any "is there a rule
  // left" test written over the parsed list rather than over the checkbox
  // would let this through — and a rule-less request matches the entire disk.
  const { urls } = await pressFind({
    ruleAgeDays: { value: '0' },
    ruleSizeMb: { value: '0' },
    ruleExtOn: { checked: false },
    ruleExts: { value: 'log' },
  });
  assert.equal(urls.length, 0, 'an unticked row is not a rule, however full its box is');
});
