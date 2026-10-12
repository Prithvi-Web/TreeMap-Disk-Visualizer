import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INDEX } from './fixtures/liftFrontend';

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
 */

const DAY = 86_400_000;

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

/** The page's policy editor — openPolicyEditor and policyFromEditor as they ship — over fake inputs, on "My own rules". */
function editor(): { open: (p: unknown) => void; read: () => Record<string, any>; $: (id: string) => Box } {
  const els: Record<string, Box> = {};
  const $ = (id: string): Box => (els[id] ??= {
    value: '', checked: false, defaultValue: '', defaultChecked: false, innerHTML: '', textContent: '',
    classList: { add() {}, remove() {} },
  });
  const seg = { dataset: { apmatch: 'custom' } };
  const source = `${unitDecls()}\nlet apDraft = null;\n${braced('function openPolicyEditor(')}\n${braced('function policyFromEditor(')}`;
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

  // Every age a rule can hold comes back as it was.
  const drifted: string[] = [];
  for (const ms of storedAges()) {
    const e = editor();
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
