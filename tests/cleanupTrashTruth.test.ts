import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Hunt group C (24 Oct 2026): what Clean Up, the cart, the Trash sheet and
 * the Undo Vault say is true. Every test runs the shipped page's own code out
 * of public/index.html against stubs, or reads the sentence it ships.
 */

const ROOT = path.join(__dirname, '..');
const INDEX = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/** A slice of the built page between two exact anchors. */
function slice(startAnchor: string, endAnchor: string): string {
  const start = INDEX.indexOf(startAnchor);
  assert.notEqual(start, -1, `anchor "${startAnchor}" exists in index.html`);
  const end = INDEX.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `anchor "${endAnchor}" follows it`);
  return INDEX.slice(start, end);
}

/** The block of a function or listener whose header is `anchor` (it ends at the `{` that opens it). */
function blockAt(anchor: string): string {
  const at = INDEX.indexOf(anchor);
  assert.notEqual(at, -1, `"${anchor}" is in the built page`);
  const open = at + anchor.length - 1;
  assert.equal(INDEX[open], '{', `"${anchor}" ends at its block's {`);
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(at, i + 1);
  }
  throw new Error(`unbalanced block at ${anchor}`);
}

type El = { hidden: boolean; innerHTML: string; textContent: string; style: Record<string, string>; classes: Set<string>; classList: { add(c: string): void; remove(c: string): void } };
function makeEls(): { $: (id: string) => El; els: Record<string, El> } {
  const els: Record<string, El> = {};
  const $ = (id: string): El => (els[id] ||= (() => {
    const classes = new Set<string>();
    return { hidden: false, innerHTML: '', textContent: '', style: {}, classes,
      classList: { add: (c: string) => { classes.add(c); }, remove: (c: string) => { classes.delete(c); } } };
  })());
  return { $, els };
}

/** Plain text of a fragment of page HTML. */
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/* ═════════ C03/C13 — online-only files: no "safe", and what deleting one does ═════════ */

async function cloudSafeSaid(groups: Array<{ provider: string; count: number; totalSize: number; files: unknown[] }>): Promise<string> {
  const src = `${slice('function treeScanId(', '\n}\n')}\n}\n` + slice('async function renderCloudSafe', 'async function renderGrowthProjection');
  const { $, els } = makeEls();
  const noop = (): void => {};
  const fn = new Function(
    '$', 'state', 'api', 'seedNodes', 'formatCount', 'formatBytes', 'escapeHtml', 'chipFor',
    'formatDate', 'icon', 'refreshCartButtons', 'cartButtonHtml',
    `'use strict'; ${src} return renderCloudSafe;`,
  )(
    $, { scanId: 's1' },
    async () => ({ scanId: 's1', totalCount: groups.reduce((s, g) => s + g.count, 0), totalSize: groups.reduce((s, g) => s + g.totalSize, 0), groups }),
    noop, (n: number) => String(n), (n: number) => `${n} B`, (s: string) => String(s),
    () => '', () => '', () => '', noop, () => '<button>cart</button>',
  ) as () => Promise<void>;
  await fn();
  return text(els.cloudResults.innerHTML);
}

const FILE = { name: 'a.mov', path: '/u/iCloud/a.mov', size: 1000, modifiedAt: 1 };

test('the Cloud-safe tab never calls removing an online-only file safe, and says deleting one deletes it from its cloud too (C03/C13)', async () => {
  const one = await cloudSafeSaid([{ provider: 'icloud', count: 1, totalSize: 1000, files: [FILE] }]);
  assert.match(one, /a\.mov/, 'control: the rows are painted');
  assert.doesNotMatch(one, /\bsafe\b/i, `no safety claim: ${one}`);
  assert.doesNotMatch(one, /keeps the original|local copy/i, 'there is no local copy of an online-only file to remove');
  assert.match(one, /removes it from iCloud Drive too/, 'what moving one to the Trash does, said as the tooltip says it');
  assert.match(one, /almost no space on this disk/, 'and that it frees almost nothing here');
  assert.match(one, /Undo Vault/, 'and that keeping its Undo Vault copy downloads it first');

  const two = await cloudSafeSaid([
    { provider: 'icloud', count: 1, totalSize: 1000, files: [FILE] },
    { provider: 'dropbox', count: 1, totalSize: 1000, files: [{ ...FILE, path: '/u/Dropbox/b.mov', name: 'b.mov' }] },
  ]);
  assert.match(two, /removes it from the cloud service it syncs with too/, 'more than one provider: the sentence names none wrongly');
  const generic = await cloudSafeSaid([{ provider: 'cloud', count: 1, totalSize: 1000, files: [FILE] }]);
  assert.match(generic, /removes it from the cloud service it syncs with too/, 'an unnamed provider is not called "Cloud"');
});

test('the Dashboard\'s cloud row claims nothing about safety (C13)', () => {
  const row = slice('id="cloudRow"', '</div>\n          </div>');
  assert.doesNotMatch(row, /\bsafe\b/i, `the row: ${row}`);
  assert.match(text(row), /deleting one removes it from the cloud too/i);
  const openapi = readFileSync(path.join(ROOT, 'src', 'api', 'openapi.ts'), 'utf8');
  assert.doesNotMatch(openapi, /safe to remove locally/, 'nor does the API description of the same list');
});

/* ═════════ C15 — a snapshot purge is for good, and the row and the sheet say so ═════════ */

test('the Dashboard\'s snapshot row says a purge deletes them for good, and its sheet says it cannot be undone (C15)', () => {
  const load = blockAt('async function loadSnapshots() {');
  const darwin = /\$\('snapHint'\)\.textContent = platformWord\(\{\s*darwin: '([^']+)'/.exec(load)?.[1] ?? '';
  assert.notEqual(darwin, '', 'control: the Mac sentence is read');
  assert.doesNotMatch(darwin, /\bsafe\b|recreates/i, `no safety claim, and Time Machine recreates nothing it deleted: ${darwin}`);
  assert.match(darwin, /deletes them for good/);
  assert.match(darwin, /files only they still hold/, 'and what goes with them');

  const { $, els } = makeEls();
  const block = blockAt("$('snapPurgeBtn').addEventListener('click', () => {");
  const body = block.slice(block.indexOf('{') + 1, -1);
  new Function('$', 'state', 'icon', 'formatCount', 'setConfirmButton', 'purgeSnapshotsAction', 'onConfirmTrash',
    `${body}`)($, { snapshots: { snapshots: [{}, {}] } }, () => '', String, () => {}, () => {}, null);
  const sheet = text(els.confirmText.innerHTML);
  assert.match(sheet, /Delete 2 local snapshots/, `control: the sheet was drawn: ${sheet}`);
  assert.match(sheet, /This cannot be undone\./, 'the purge is permanent, and the sheet says so as Empty the Trash does');
  assert.doesNotMatch(sheet, /create fresh ones on the next backup/, 'fresh ones are not the ones deleted');
});
