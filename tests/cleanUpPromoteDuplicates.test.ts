import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Clean Up → "Make this an Autopilot policy" with the Duplicates rule ticked.
 *
 * The Custom Rules pane has four rows — Older than, Larger than, Extensions,
 * Duplicates only — and Find ANDs every ticked one. An Autopilot policy can
 * carry only three of them: `AutopilotMatch`'s custom kind has no duplicate
 * flag, and the query kind's `dupe:` field is not wired to anything yet (the
 * executor reports it degraded and it matches nothing). So there is no policy
 * that selects "a duplicate AND older than 180 days".
 *
 * Promotion used to build the policy from the three rows it understood and
 * drop the fourth without a word. The result was a standing, unattended
 * deleter WIDER than the rule set the person had just looked at: every file
 * older than 180 days, duplicate or not.
 *
 * The rule pinned here: a promoted policy selects exactly what the rules
 * selected, or promotion is refused — before the editor opens, with the reason
 * shown beside the button that was pressed. Everything is asserted by running
 * the real `promoteRuleToPolicy` out of the built page with its globals
 * stubbed (the harness pattern of tests/cleanRuleThresholds.test.ts), so these
 * are pins on behaviour, not on source text.
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

const HEADER = 'function promoteRuleToPolicy() {';

/** The body of the promote handler, statements only. */
function promoteBody(): string {
  const start = INDEX.indexOf(HEADER);
  assert.notEqual(start, -1, 'promoteRuleToPolicy is findable in the built page');
  assert.equal(INDEX.indexOf(HEADER, start + 1), -1, 'and there is only one of it');
  const open = start + HEADER.length - 1;
  return INDEX.slice(open + 1, matchingBrace(open));
}

interface Rules { age?: string; size?: string; exts?: string; dup?: boolean }
interface Shown { msg: string; kind?: string }
interface Draft { name: string; path: string; match: Record<string, unknown>; dryRunFirst: boolean; enabled: boolean }

/**
 * Press "Make this an Autopilot policy" with the simple rules in a given state
 * and report everything the press produced.
 *
 * Only the rows named in `rules` are ticked — each test states its whole rule
 * set, because "what was ticked" is the entire subject here. `requests`
 * collects any call to `api` or `fetch`; `editor` collects every draft handed
 * to the policy editor, which is the step that puts a policy one Save away.
 */
function pressPromote(rules: Rules, opts: {
  source?: 'simple' | 'query';
  view?: { id: string; name: string; q: string } | null;
  preset?: Record<string, Record<string, unknown>>;
} = {}) {
  const els: Record<string, any> = {};
  const $ = (id: string): any => (els[id] ||= {
    checked: false, value: '', innerHTML: '', textContent: '', disabled: false,
    // `hidden` starts true, as it does in the markup for the reason line.
    hidden: true, style: {}, classList: { add() {}, remove() {} },
  });
  Object.assign($('ruleAgeOn'), { checked: rules.age !== undefined });
  Object.assign($('ruleAgeDays'), { value: rules.age ?? '180' });
  Object.assign($('ruleSizeOn'), { checked: rules.size !== undefined });
  Object.assign($('ruleSizeMb'), { value: rules.size ?? '100' });
  Object.assign($('ruleExtOn'), { checked: rules.exts !== undefined });
  Object.assign($('ruleExts'), { value: rules.exts ?? '' });
  Object.assign($('ruleDupOn'), { checked: rules.dup === true });
  for (const [id, patch] of Object.entries(opts.preset ?? {})) Object.assign($(id), patch);

  const toasts: Shown[] = [];
  const requests: string[] = [];
  const editor: Draft[] = [];
  const closed: string[] = [];
  const switched: string[] = [];
  const deps: Record<string, unknown> = {
    $,
    state: { scanId: 's1', root: { path: '/home/u/proj' }, treemap: { rootPath: '/home/u/proj/sub' } },
    cleanRuleSource: opts.source ?? 'simple',
    selectedSavedView: () => opts.view ?? null,
    toast: (msg: string, kind?: string) => { toasts.push({ msg, kind }); },
    closeModal: (id: string) => { closed.push(id); },
    openPolicyEditor: (draft: Draft) => { editor.push(draft); },
    switchView: (v: string) => { switched.push(v); },
    api: async (url: string) => { requests.push(url); return {}; },
    fetch: async (url: string) => { requests.push(String(url)); return {}; },
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...keys, `return function () {${promoteBody()}\n};`)(...keys.map((k) => deps[k]));
  fn();
  return { toasts, requests, editor, closed, switched, els };
}

const DAY = 86_400_000;
const MB = 1_048_576;

/** A press that was refused because of the Duplicates rule, and did nothing else. */
function assertRefusedForDuplicates(r: ReturnType<typeof pressPromote>): string {
  // Nothing moved: no draft exists for anyone to save, and the person is left
  // where they pressed the button, looking at the reason.
  assert.equal(r.editor.length, 0, `no policy editor may open with a wider rule: ${JSON.stringify(r.editor)}`);
  assert.deepEqual(r.requests, [], 'no request is made');
  assert.deepEqual(r.closed, [], 'the Clean Up modal stays open');
  assert.deepEqual(r.switched, [], 'and the view does not move to Autopilot');

  const note = r.els.cleanPromoteWhy;
  assert.ok(note, 'the reason line beside the button is written');
  assert.equal(note.hidden, false, 'and shown');
  const msg: string = note.textContent;
  assert.match(msg, /Duplicates only/, `the sentence names the rule that cannot be carried: ${msg}`);
  assert.match(msg, /cannot be carried into an Autopilot policy/, `and says it cannot become a policy: ${msg}`);
  assert.match(msg, /duplicate or not/, `and why — the policy would match more than the rules did: ${msg}`);
  assert.match(msg, /Untick Duplicates only/, `and what to do instead: ${msg}`);

  // The same sentence is announced the way every other refusal in this modal
  // is, and there is no "Pre-filled" success toast claiming otherwise.
  assert.deepEqual(r.toasts.map((t) => t.kind), ['error'], `exactly one refusal: ${JSON.stringify(r.toasts)}`);
  assert.equal(r.toasts[0].msg, msg);
  return msg;
}

/** A press that promoted, handing the editor exactly `match`. */
function assertPromoted(r: ReturnType<typeof pressPromote>, match: Record<string, unknown>): Draft {
  assert.equal(r.editor.length, 1, `the editor opens once: ${JSON.stringify(r.toasts)}`);
  const draft = r.editor[0];
  assert.deepEqual(draft.match, match);
  assert.equal(draft.path, '/home/u/proj/sub', 'the folder in view');
  assert.equal(draft.dryRunFirst, true);
  assert.equal(draft.enabled, false);
  assert.deepEqual(r.closed, ['cleanModal']);
  assert.deepEqual(r.switched, ['autopilot']);
  assert.deepEqual(r.requests, [], 'promotion itself sends nothing');
  assert.deepEqual(r.toasts.map((t) => t.kind), ['success']);
  const note = r.els.cleanPromoteWhy;
  assert.ok(!note || note.hidden !== false, 'no refusal is left showing');
  return draft;
}

/* ══════════ Duplicates combined with another rule: refused, never dropped ══════════ */

test('duplicates + age is refused — never promoted as "every file older than N days"', () => {
  assertRefusedForDuplicates(pressPromote({ age: '180', dup: true }));
});

test('duplicates + size is refused — never promoted as "every file larger than N MB"', () => {
  assertRefusedForDuplicates(pressPromote({ size: '100', dup: true }));
});

test('duplicates + extension is refused — never promoted as "every .log file"', () => {
  assertRefusedForDuplicates(pressPromote({ exts: 'log', dup: true }));
});

test('duplicates + all three other rules is refused too', () => {
  assertRefusedForDuplicates(pressPromote({ age: '30', size: '5', exts: 'mov, mp4', dup: true }));
});

test('a later press that promotes clears a refusal still showing from an earlier one', () => {
  const r = pressPromote({ age: '180' }, {
    preset: { cleanPromoteWhy: { hidden: false, textContent: 'an earlier refusal' } },
  });
  assertPromoted(r, { kind: 'custom', maxAgeMs: 180 * DAY });
  assert.equal(r.els.cleanPromoteWhy.hidden, true, 'the stale reason does not linger');
});

/* ══════════ Duplicates alone: today's refusal, pinned as it is ══════════ */

test('duplicates-only is refused exactly as before — one red toast, no editor', () => {
  const r = pressPromote({ dup: true });
  assert.equal(r.editor.length, 0);
  assert.deepEqual(r.requests, []);
  assert.deepEqual(r.closed, []);
  assert.deepEqual(r.switched, []);
  assert.deepEqual(r.toasts.map((t) => t.kind), ['error']);
  assert.match(r.toasts[0].msg, /duplicates-only rule cannot run unattended/);
});

/* ══════════ Without the Duplicates rule: unchanged ══════════ */

test('age only promotes to exactly that age rule', () => {
  assertPromoted(pressPromote({ age: '180' }), { kind: 'custom', maxAgeMs: 180 * DAY });
});

test('size only promotes to exactly that size rule', () => {
  assertPromoted(pressPromote({ size: '100' }), { kind: 'custom', minBytes: 100 * MB });
});

test('extensions only promotes to exactly those extensions, normalised', () => {
  assertPromoted(pressPromote({ exts: 'log, .TMP' }), { kind: 'custom', exts: ['log', 'tmp'] });
});

test('age + size + extensions promotes to all three, ANDed as Find ANDs them', () => {
  assertPromoted(pressPromote({ age: '30', size: '5', exts: 'mov' }),
    { kind: 'custom', maxAgeMs: 30 * DAY, minBytes: 5 * MB, exts: ['mov'] });
});

test('a saved view promotes as its query, whatever the hidden Duplicates box holds', () => {
  // The Duplicates row belongs to the simple-rules pane, which is hidden while
  // a saved view is the rule source. A tick left in it is not part of the
  // rule being promoted and must not block it.
  const r = pressPromote({ age: '180', dup: true }, {
    source: 'query',
    view: { id: 'v1', name: 'Old logs', q: 'ext:log modified>90d' },
  });
  const draft = assertPromoted(r, { kind: 'query', q: 'ext:log modified>90d' });
  assert.equal(draft.name, 'Old logs');
});
