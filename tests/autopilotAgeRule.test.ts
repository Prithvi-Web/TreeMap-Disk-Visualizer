import { test } from 'node:test';
import assert from 'node:assert/strict';

// The reason test below loads the Autopilot service; keep it off the real app data.
import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-autopilot-age-test-');
process.env.TREEMAP_NO_GDU = '1';

import { INDEX, lift } from './fixtures/liftFrontend';
import { selectCandidates } from '../src/services/autopilot';

/**
 * An Autopilot rule's age opens as exactly what the policy stored, and Save — nothing touched —
 * sends it back to the millisecond (the LEFT brief, item 6).
 *
 * The policy API takes any `maxAgeMs` over 0, and a figure typed into Clean Up's "Older than … days"
 * box, an agent's policy or a promoted query can be a part of a day: 36 hours, 2 years of 365.25
 * days. The editor opened it as `Math.round(maxAgeMs / 86,400,000)` days, and Save read that box
 * back, so opening the policy and pressing Save rewrote the rule an unattended deleter runs —
 * 36 hours became 48, 12 hours a whole day. The size boxes were fixed the same way by QA-4u
 * (dab3d5b, 8f54072): the box shows the exact figure, and a figure nobody typed keeps its bytes.
 *
 * The policy card and the reason each picked item carries state that same age, exactly, too
 * (review F1.1, F1.2, F1.5): the matcher compares milliseconds, so "older than 2d" on a 36-hour
 * rule describes a rule nobody wrote.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** The `{ … }` block that starts at the first `{` after `anchor`, anchor included. */
function braced(anchor: string): string {
  const start = INDEX.indexOf(anchor);
  assert.notEqual(start, -1, `"${anchor}" is in the built page`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', start + anchor.length - 1); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`"${anchor}" never closes`);
}

/** The page's own unit constants, whichever it declares, each as the page declares it. */
function unitDecls(): string {
  return ['KB', 'MB', 'GB', 'TB']
    .filter((u) => INDEX.includes(`const ${u} = `))
    .map((u) => { const at = INDEX.indexOf(`const ${u} = `); return INDEX.slice(at, INDEX.indexOf(';', at) + 1); })
    .join('\n');
}

type Box = { value: unknown; checked: boolean; defaultValue: string; defaultChecked: boolean; innerHTML: string; textContent: string; classList: { add(): void; remove(): void } };

/**
 * The editor's source, lifted from the 1.8 MB page once: none of it depends on the age under test,
 * and lifting it again for every editor cost the 2,000-age loop below ~10 ms a pass (review F1.3).
 */
let editorSource: string | undefined;
const liftEditorSource = (): string =>
  (editorSource ??= `${unitDecls()}\nlet apDraft = null;\n${braced('function openPolicyEditor(')}\n${braced('function policyFromEditor(')}`);

/** The page's policy editor — openPolicyEditor and policyFromEditor as they ship — over fake inputs, on "My own rules". */
function editor(): { open: (p: unknown) => void; read: () => Record<string, any>; $: (id: string) => Box } {
  const els: Record<string, Box> = {};
  const $ = (id: string): Box => (els[id] ??= {
    value: '', checked: false, defaultValue: '', defaultChecked: false, innerHTML: '', textContent: '',
    classList: { add() {}, remove() {} },
  });
  const seg = { dataset: { apmatch: 'custom' } };
  const source = liftEditorSource();
  const deps: Record<string, unknown> = {
    $, icon: () => '', state: { system: { homeDir: '/home/u' } },
    setApMatchKind() {}, validateApQuery() {}, renderApGroupList() {}, asPath: (p: string) => p,
    document: { querySelector: () => seg, querySelectorAll: () => [] },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const rt = new Function(...Object.keys(deps), `'use strict';\n${source}\nreturn { open: openPolicyEditor, read: policyFromEditor };`)(
    ...Object.values(deps),
  ) as { open: (p: unknown) => void; read: () => Record<string, any> };
  return { ...rt, $ };
}

const policy = (maxAgeMs: number) => ({ id: 'p', name: 'p', path: '/home/u', match: { kind: 'custom', maxAgeMs } });

/** Ages of every shape a stored rule can have: parts of a day, whole days, and a fixed spread of awkward ones. */
function storedAges(count = 2000): number[] {
  const out = [1, 3_600_000, DAY / 2, DAY, 1.5 * DAY, 7 * DAY, 30 * DAY + 1, 90 * DAY, 180 * DAY, 730.5 * DAY, 3653 * DAY - 1];
  let x = 0x5eed1234;
  const next = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0);
  while (out.length < count) out.push(1 + Math.floor((next() / 2 ** 32) * 10 * 365.25 * DAY));
  return out;
}

test('Autopilot: a stored age opens as its exact figure in days, and Save — nothing touched — keeps it to the millisecond (the LEFT brief, item 6)', () => {
  // 36 hours opened as "2" days, and an untouched Save rewrote the rule to 48 hours.
  const ed = editor();
  ed.open(policy(1.5 * DAY));
  assert.equal(String(ed.$('apRuleAgeDays').value), '1.5', 'a 36-hour rule opens as 1.5 days, not rounded to 2');
  assert.equal(ed.read().match.maxAgeMs, 1.5 * DAY, 'and Save, nothing touched, sends 36 hours back');

  // Under a day: opened as its part of a day, kept though the box's floor is 1 day (min="1").
  ed.open(policy(DAY / 2));
  assert.equal(String(ed.$('apRuleAgeDays').value), '0.5', 'a 12-hour rule opens as 0.5 days');
  assert.equal(ed.read().match.maxAgeMs, DAY / 2, 'and saves untouched as 12 hours, not the 1-day floor a typed figure meets');

  // Every age a rule can hold comes back as it was — one editor, opened on each stored rule in turn,
  // as a person opens one policy after another.
  const drifted: string[] = [];
  const e = editor();
  for (const ms of storedAges()) {
    e.open(policy(ms));
    const shown = String(e.$('apRuleAgeDays').value);
    const saved = e.read().match.maxAgeMs;
    if (shown !== String(ms / DAY) || saved !== ms) drifted.push(`${ms} ms opened as "${shown}" days, saved as ${saved}`);
  }
  assert.deepEqual(drifted.slice(0, 5), [], `${drifted.length} stored ages did not round-trip`);
});

test('Autopilot: a whole-day age still opens as its whole number, and a figure a person types is read as before', () => {
  const ed = editor();
  ed.open(policy(180 * DAY));
  assert.equal(String(ed.$('apRuleAgeDays').value), '180', 'a 180-day rule opens as 180');
  assert.equal(ed.read().match.maxAgeMs, 180 * DAY);

  ed.open(policy(1.5 * DAY));
  ed.$('apRuleAgeDays').value = '2';
  assert.equal(ed.read().match.maxAgeMs, 2 * DAY, 'a typed 2 is two days');
  ed.$('apRuleAgeDays').value = '2.5';
  assert.equal(ed.read().match.maxAgeMs, 2.5 * DAY, 'a typed 2.5 is sixty hours');
  ed.$('apRuleAgeDays').value = '0.25';
  assert.equal(ed.read().match.maxAgeMs, DAY, 'a typed figure under a day is held to the box\'s 1-day floor');
  ed.$('apRuleAgeDays').value = '1.5';
  assert.equal(ed.read().match.maxAgeMs, 1.5 * DAY, 'and typing the opened figure back is that figure');

  ed.open(policy(DAY / 2));
  ed.$('apRuleAgeOn').checked = false;
  assert.equal(ed.read().match.maxAgeMs, undefined, 'an age rule ticked off sends no age');
});

/**
 * The milliseconds a stated age adds up to, or why it is not one. Each part is a whole number over 0
 * of a smaller unit than the part before it, so nothing can be rounded away and nothing said twice;
 * `units` maps each unit's spelling (as the card or the sentence writes it) to its milliseconds.
 */
function addUp(text: string, units: Record<string, number>, spaced: boolean): number | string {
  const tokens = text.split(' ');
  const parts = spaced ? tokens.flatMap((t, i) => (i % 2 ? [] : [`${t} ${tokens[i + 1]}`])) : tokens;
  let total = 0;
  let previous = Infinity;
  for (const part of parts) {
    const m = /^([1-9]\d*) ?([a-z]+)$/.exec(part);
    if (!m) return `"${part}" in "${text}" is not a whole number over 0 and a unit`;
    const size = units[m[2]];
    if (size === undefined) return `"${m[2]}" in "${text}" is not a unit`;
    if (size >= previous) return `"${text}" does not go from larger units to smaller`;
    previous = size;
    total += Number(m[1]) * size;
  }
  return total;
}

const CARD_UNITS = { d: DAY, h: HOUR, min: MINUTE, s: 1_000, ms: 1 };
/** The sentence's units, singular for one and plural otherwise — "1 day", never "1 days". */
function sentenceUnits(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [word, ms] of Object.entries({ day: DAY, hour: HOUR, minute: MINUTE, second: 1_000, millisecond: 1 })) {
    out[word] = ms; out[`${word}s`] = ms;
  }
  return out;
}

test('Autopilot: the policy card states the age rule exactly — a 36-hour rule reads "1d 12h", never "2d" (review F1.1, F1.5)', () => {
  const describeMatch = lift<(m: unknown) => string>(['describeMatch', 'ruleAgeText'], 'describeMatch');
  const card = (maxAgeMs: number) => describeMatch({ kind: 'custom', maxAgeMs });

  assert.equal(card(1.5 * DAY), 'older than 1d 12h', 'a 36-hour rule — the editor opens it as 1.5 — is not "older than 2d"');
  assert.equal(card(DAY / 2), 'older than 12h', 'a 12-hour rule is not "older than 1d"');
  assert.equal(card(HOUR), 'older than 1h', 'an hour-old rule is not "older than 0d"');
  assert.equal(card(90 * MINUTE), 'older than 1h 30min', 'minutes are "min", never "m", which a query reads as months');
  assert.equal(card(180 * DAY), 'older than 180d', 'a whole-day rule reads as it always did');

  // Every age a rule can hold: the card adds up to it exactly, and a whole-day age is its days alone.
  const wrong: string[] = [];
  for (const ms of storedAges()) {
    const text = card(ms);
    const stated = text.startsWith('older than ') ? addUp(text.slice('older than '.length), CARD_UNITS, false) : `"${text}"`;
    if (stated !== ms || (ms % DAY === 0 && text !== `older than ${ms / DAY}d`)) wrong.push(`${ms} ms: card "${text}" states ${stated}`);
  }
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} stored ages are misstated on the card`);
});

test('Autopilot: the reason each picked item carries states the age rule exactly — 36 hours is "1 day 12 hours", never "2 days" (review F1.2)', () => {
  const reason = (maxAgeMs: number) =>
    selectCandidates([], [{ path: '/home/u/a.bin', name: 'a.bin', size: 1 }], { kind: 'custom', maxAgeMs })[0].reason;
  const rule = 'matched your rule: is older than ';

  assert.equal(reason(1.5 * DAY), `${rule}1 day 12 hours`, 'a 36-hour rule is not "older than 2 days" in the preview, the run record or the Time Capsule');
  assert.equal(reason(DAY / 2), `${rule}12 hours`, 'a 12-hour rule is not "older than 1 days"');
  assert.equal(reason(5 * HOUR), `${rule}5 hours`, 'a 5-hour rule is not "older than 0 days"');
  assert.equal(reason(DAY), `${rule}1 day`, 'one day is "1 day", not "1 days"');
  assert.equal(reason(90 * DAY), `${rule}90 days`, 'a whole-day rule reads as it always did');

  const words = sentenceUnits();
  const wrong: string[] = [];
  for (const ms of storedAges()) {
    const text = reason(ms);
    const age = text.startsWith(rule) ? text.slice(rule.length) : '';
    const stated = age ? addUp(age, words, true) : `"${text}"`;
    const plurals = age.split(' ').every((w, i, all) => i % 2 === 0 || (all[i - 1] === '1') === !w.endsWith('s'));
    if (stated !== ms || !plurals) wrong.push(`${ms} ms: "${text}" states ${stated}${plurals ? '' : ', mis-pluralised'}`);
  }
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} stored ages are misstated in the reason`);
});
