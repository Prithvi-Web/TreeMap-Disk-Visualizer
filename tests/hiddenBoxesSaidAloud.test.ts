import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INDEX } from './fixtures/liftFrontend';

/**
 * The boxes hidden while they have nothing to say, whose words are now said aloud (BQS; the defect class of review
 * F2.1 and F2.2).
 *
 * Each of these boxes carried role="status" (or aria-live) and `hidden` in the markup, and its writer put the words
 * in it and showed it in one task: it went from not displayed to displayed with its words already in it, and a
 * screen reader announces a live region's text as it changes — seldom a region that appears filled. So the words of
 * a warning in the delete dialog, the preview banner over the map, a refused translation, a scan's caveats, went
 * unsaid. Each box is plain text now, and sayAloud (beside sayWorking, 040) says its words in an sr-only live region
 * of its own, beside it, a frame after the box shows them; the region is emptied when the box hides. Two boxes were
 * no status at all and are plain now: Disk City's hover card, a tooltip the pointer moves, and the Clean Up refusal
 * whose words the same task toasts. tests/workingSaidAloud.test.ts holds the whole page to it: no live region ships
 * hidden, and no script shows or hides one.
 */

/* ───────────────────────────── the page's source ───────────────────────────── */

/** A page function by its declaration, brace-matched. */
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

/** A declaration's source: a function brace-matched, or a top-level `const`/`let` up to the end of its statement. */
function srcOf(decl: string): string {
  if (/^(?:async )?function /.test(decl)) return pageFn(decl);
  const at = INDEX.indexOf(`\n${decl} = `);
  assert.notEqual(at, -1, `${decl} is in the page`);
  return INDEX.slice(at + 1, INDEX.indexOf(';', at) + 1);
}
const nameOf = (decl: string) => /(?:function|const|let)\s+(\w+)/.exec(decl)![1];

/** The opening tag of the element with this id in the markup. */
function tagOf(id: string): string {
  const at = INDEX.indexOf(` id="${id}"`);
  assert.notEqual(at, -1, `#${id} is in the markup`);
  return INDEX.slice(INDEX.lastIndexOf('<', at), INDEX.indexOf('>', at) + 1);
}

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'wbr', 'area', 'col', 'embed', 'track']);

/** The opening tags of the elements that hold the one with this id, outermost first, read from the markup. */
function ancestorsOf(id: string): string[] {
  const at = INDEX.indexOf(` id="${id}"`);
  assert.notEqual(at, -1, `#${id} is in the markup`);
  const start = INDEX.lastIndexOf('<body', at);
  assert.notEqual(start, -1, 'control: the markup has a body');
  const markup = INDEX.slice(start, INDEX.lastIndexOf('<', at)).replace(/<!--[\s\S]*?-->/g, '');
  const open: Array<{ name: string; tag: string }> = [];
  for (const m of markup.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    const name = m[2].toLowerCase();
    if (m[1]) assert.equal(open.pop()?.name, name, `the markup closes ${name} where it opened it`);
    else if (!VOID.has(name) && !m[0].endsWith('/>')) open.push({ name, tag: m[0] });
  }
  return open.map((o) => o.tag);
}

const isLive = (tag: string) => /\srole="(?:status|alert|log)"|\saria-live="/.test(tag);
const idIn = (tag: string) => / id="([^"]+)"/.exec(tag)?.[1] ?? tag;

/** The markup of an empty live region with this id, as the page writes one. */
const regionMarkup = (id: string) => `<div id="${id}" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>`;

/**
 * Each box said aloud: the region its words are said in, the parts of it its writers fill, and — where its writers
 * run only inside one function that says it — that function.
 */
const SAID: ReadonlyArray<{ box: string; region: string; parts?: string[]; sayer?: string }> = [
  { box: 'tmPreviewBanner', region: 'tmPreviewSaid', parts: ['tmPreviewText'] },
  { box: 'tmAltNote', region: 'tmAltNoteSaid' },
  { box: 'confirmOpenHandles', region: 'confirmOpenHandlesSaid' },
  { box: 'startLast', region: 'startLastSaid' },
  // The popover says one thing at a time — "Translating…", then why it could not — so both say it in one region.
  { box: 'nlPending', region: 'nlSaid' },
  { box: 'nlReason', region: 'nlSaid' },
  { box: 'cityLod', region: 'cityLodSaid' },
  { box: 'indexBadge', region: 'indexBadgeSaid' },
  { box: 'accessRow', region: 'accessSaid', parts: ['accessText', 'accessHint'], sayer: 'function keepAccessFocus(' },
  { box: 'mountsNote', region: 'mountsNoteSaid', parts: ['mountsNoteText'] },
  { box: 'calDegraded', region: 'calDegradedSaid' },
  { box: 'journalPortable', region: 'journalPortableSaid' },
  // Live regions of their own once, under a parent that hides them — a sheet, a pane, a sheet's own part, a view —
  // and written while it did, or in the task that showed it: plain now, said beside (BQT item 28).
  { box: 'apQueryStatus', region: 'apQuerySaid' },
  { box: 'engineBudgetNote', region: 'engineBudgetNoteSaid' },
  { box: 'dupeViewerSummary', region: 'dupeViewerSummarySaid' },
  { box: 'cmpInfo', region: 'cmpSaid' },
  // The index line was never a live region (its count changes on every poll); its news was written straight into
  // #indexAnnounce, in the Dashboard, by a build that runs on whatever view is up (BQT item 28).
  { box: 'indexLine', region: 'indexAnnounce' },
  // The note over a map with nothing to draw was a live region hidden while it had nothing to say, shown already filled
  // by tmSetEmpty (BQU item 24).
  { box: 'tmEmpty', region: 'tmEmptySaid' },
  // The Missing Gigabytes card was a live region in a view, written straight with its whole receipt: under an open
  // sheet the answer went unheard and the card came back already filled, and heard, a receipt was every line of it
  // (review F1.3, F1.4, F1.10).
  { box: 'missingBody', region: 'missingSaid' },
];

/** The boxes that were never a status a person needs to hear as it changes, with why. */
const NOT_LIVE: ReadonlyArray<{ box: string; why: string }> = [
  { box: 'cityCard', why: 'a hover card the pointer moves over Disk City, rebuilt as it crosses each building — a tooltip, as the map\'s #tooltip is; the list of buildings under the map says the same' },
  { box: 'cleanPromoteWhy', why: 'its words are toasted in the same task, as every refusal of the Clean Up sheet is; the box is the copy that stays beside the button' },
];

test('each box said aloud is plain text, and its region is in the page from the start, empty, after it and beside it — outside it, in the element that holds it, so nothing hides the region that does not hide the box too (BQS)', () => {
  for (const { box, region } of SAID) {
    assert.ok(!isLive(tagOf(box)), `#${box} is no live region of its own, so a reader that announces a box shown filled does not say its words twice: ${tagOf(box)}`);
    assert.equal(INDEX.split(regionMarkup(region)).length, 2, `#${region}: exactly one empty live region in the markup`);
    const boxHolders = ancestorsOf(box);
    const holders = ancestorsOf(region);
    assert.ok(!holders.some((t) => idIn(t) === box), `#${region} stands outside #${box}, which hides`);
    assert.equal(idIn(holders[holders.length - 1]), idIn(boxHolders[boxHolders.length - 1]), `#${region} stands beside #${box}, in the element that holds it`);
    assert.ok(INDEX.indexOf(` id="${region}"`) > INDEX.indexOf(` id="${box}"`), `#${region} comes after #${box}`);
  }
});

test('Disk City\'s coverage line, whose counts are not said as they change on every frame of a zoom, is the description of the city it describes, read with it (BQS)', () => {
  assert.match(tagOf('cityCanvas'), /\saria-describedby="cityLod"/, 'the city is described by the line under it');
});

/** The source of the page's top-level function that holds `at`, or the 2,000 characters from `at` where none does (a listener). */
function enclosingFn(at: number): string {
  for (const m of INDEX.matchAll(/\n(?:async )?function \w+\(/g)) {
    if (m.index > at) break;
    const open = INDEX.indexOf('{', INDEX.indexOf(')', m.index));
    let depth = 0;
    for (let i = open; i < INDEX.length; i++) {
      if (INDEX[i] === '{') depth++;
      else if (INDEX[i] === '}' && --depth === 0) { if (i > at) return INDEX.slice(m.index, i + 1); break; }
    }
  }
  return INDEX.slice(at, at + 2000);
}

/** Every function that writes the element with this id — its hidden, its text or its markup — through `$('id')` or a constant holding it. */
function writersOf(id: string): string[] {
  const write = String.raw`\.(?:hidden|textContent|innerHTML|innerText)\s*=(?!=)`;
  const found = new Set<string>();
  for (const m of INDEX.matchAll(new RegExp(String.raw`\$\('${id}'\)${write}`, 'g'))) found.add(enclosingFn(m.index));
  for (const m of INDEX.matchAll(new RegExp(String.raw`(?:const|let) (\w+) = \$\('${id}'\);`, 'g'))) {
    const fn = enclosingFn(m.index);
    if (new RegExp(String.raw`\b${m[1]}${write}`).test(fn)) found.add(fn);
  }
  return [...found];
}
const fnName = (src: string) => /function (\w+)\(/.exec(src)?.[1] ?? src.slice(0, 60);

test('every function that writes a box said aloud — showing it, hiding it, or filling it — says its words in the box\'s region, or runs only inside the one function that does (BQS)', () => {
  for (const { box, region, parts = [], sayer } of SAID) {
    const writers = [...new Set([box, ...parts].flatMap(writersOf))];
    assert.ok(writers.length > 0, `control: #${box} has writers`);
    const says = (src: string) => src.includes(`sayAloud('${region}', `);
    if (sayer) assert.ok(says(pageFn(sayer)), `${sayer} says #${box}'s words in #${region}`);
    for (const w of writers) {
      if (says(w)) continue;
      assert.ok(sayer, `${fnName(w)} writes #${box} and says nothing in #${region}`);
      // Run only inside the sayer: every reference to it is the sayer's own call of it, or one from another writer of the box.
      const name = fnName(w);
      const refs = [...INDEX.matchAll(new RegExp(String.raw`\b${name}\b(?=\(|\))`, 'g'))].filter((m) => !INDEX.startsWith(`function ${name}(`, m.index - 9));
      assert.ok(refs.length > 0, `control: ${name} is run somewhere`);
      for (const r of refs) {
        const inSayer = INDEX.slice(r.index - `${nameOf(sayer)}(`.length, r.index) === `${nameOf(sayer)}(`;
        assert.ok(inSayer || writers.includes(enclosingFn(r.index)), `${name} writes #${box} and is run outside ${nameOf(sayer)}: ${INDEX.slice(r.index - 60, r.index + 30)}`);
      }
    }
  }
});

/* ── each write, on its own branch (BQT item 32b) ──
   The check above asks whether a function that writes a box says the box's words anywhere in it, so a function
   with one branch that writes the box and leaves without a word passed as long as another branch spoke. Each write
   is now held to its own branch: walking out from it, block by block, a say must stand on the way — after it in the
   branch, before the branch leaves; or before it, with no wait (an await) since, at any level it passed through.
   A block a branch only passes beside — an else, a callback — is not on its way. A finally block's write is said
   when the try before it and its catch both say. */

/** Every `{…}` block of a function's source, by the offsets of its braces: strings, comments, regular expressions and template text skipped. */
function blocksOf(src: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const stack: Array<{ kind: 'block' | 'tpl'; start: number }> = [];
  let i = 0;
  let prev = '';
  const template = (): void => { // inside `…`, from i: up to its end, or into a ${ … }
    for (; i < src.length; i++) {
      if (src[i] === '\\') { i++; continue; }
      if (src[i] === '`') { i++; return; }
      if (src[i] === '$' && src[i + 1] === '{') { stack.push({ kind: 'tpl', start: i + 1 }); i += 2; return; }
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i === -1) break; i += 2; continue; } // a comment the source cuts short ends it
    if (c === '\'' || c === '"') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      i++; prev = 'x'; continue;
    }
    if (c === '/' && (prev === '' || /[(,=:[!&|?{};]/.test(prev))) { // a regular expression
      let inClass = false;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '[') inClass = true; else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
      }
      i++; prev = 'x'; continue;
    }
    if (c === '`') { i++; template(); prev = 'x'; continue; }
    if (c === '{') stack.push({ kind: 'block', start: i });
    else if (c === '}') {
      const top = stack.pop();
      if (top && top.kind === 'block') out.push({ start: top.start, end: i });
      else if (top && top.kind === 'tpl') { i++; template(); prev = 'x'; continue; }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** Whether a write at offset `at` of a function's source stands on a branch that says the words in `region`. */
function saidOnBranch(fn: string, at: number, region: string): boolean {
  const blocks = blocksOf(fn);
  // A guard around the say itself is part of the say: `if (typeof sayAloud === 'function') { sayAloud(…) }`.
  const guard = (b: { start: number }) => /typeof sayAloud === 'function'\)\s*$/.test(fn.slice(Math.max(0, b.start - 60), b.start));
  // A name the function gives its say: `const say = (words) => { … sayAloud('region', words) … }`.
  const aliases = [...fn.matchAll(new RegExp(String.raw`(?:const|let) (\w+) = \([^)]*\) => \{[^}]*sayAloud\('${region}', `, 'g'))].map((m) => m[1]);
  const says = (text: string) => text.includes(`sayAloud('${region}', `) || aliases.some((a) => new RegExp(String.raw`(?<![\w.])${a}\(`).test(text));
  /** The text of block `b` at its own level: the blocks inside it blanked, but a guard around a say. */
  const level = (b: { start: number; end: number }) => {
    let text = fn.slice(0, b.end);
    for (const inner of blocks) {
      if (inner.start > b.start && inner.end < b.end && !guard(inner)) text = text.slice(0, inner.start) + ' '.repeat(inner.end - inner.start + 1) + text.slice(inner.end + 1);
    }
    return text;
  };
  const chain = blocks.filter((b) => b.start < at && at < b.end).sort((a, b) => a.start - b.start);
  let lo = at;
  let hi = at;
  let left = false; // the branch has left a block it passed through: what stands after that block is not on its way
  let waited = false; // an await stands between a say before and the write
  for (let k = chain.length - 1; k >= 0; k--) {
    const b = chain[k];
    const text = level(b);
    if (k < chain.length - 1 && /finally\s*$/.test(fn.slice(0, lo))) {
      // A finally: said when the try before it and its catch both say.
      const before = blocks.filter((x) => x.end < lo && x.start > b.start).sort((x, y) => y.end - x.end).slice(0, 2);
      if (before.length === 2 && before.every((x) => says(fn.slice(x.start, x.end)))) return true;
    }
    const before = text.slice(b.start + 1, lo);
    const sayAt = Math.max(before.lastIndexOf(`sayAloud('${region}', `), ...aliases.map((a) => before.search(new RegExp(String.raw`(?<![\w.])${a}\(`))));
    if (!waited && sayAt !== -1 && !/\bawait\b/.test(fn.slice(b.start + 1 + sayAt, lo))) return true;
    if (/\bawait\b/.test(fn.slice(b.start + 1, lo))) waited = true;
    const rest = text.slice(hi, b.end);
    const leaves = /\b(?:return|throw)\b/.exec(rest);
    if (!left && says(leaves ? rest.slice(0, leaves.index) : rest)) return true;
    if (leaves) left = true;
    lo = b.start;
    hi = b.end + 1;
  }
  return false;
}

/** Each place the page writes the element with this id — its hidden, its text or its markup — and the function it is in. */
function writeSitesOf(id: string): Array<{ fn: string; at: number; line: string }> {
  const write = String.raw`\.(?:hidden|textContent|innerHTML|innerText)\s*=(?!=)`;
  const sites: Array<{ fn: string; at: number; line: string }> = [];
  const site = (at: number) => {
    const fn = enclosingFn(at);
    const start = INDEX.lastIndexOf(fn, at);
    sites.push({ fn, at: at - start, line: INDEX.slice(at, INDEX.indexOf('\n', at)).trim() });
  };
  for (const m of INDEX.matchAll(new RegExp(String.raw`\$\('${id}'\)${write}`, 'g'))) site(m.index);
  for (const m of INDEX.matchAll(new RegExp(String.raw`(?:const|let) (\w+) = \$\('${id}'\);`, 'g'))) {
    const fn = enclosingFn(m.index);
    const start = INDEX.lastIndexOf(fn, m.index);
    for (const w of fn.matchAll(new RegExp(String.raw`(?<![\w.])${m[1]}${write}`, 'g'))) site(start + w.index);
  }
  return sites;
}

test('the branch check reads branches: a write whose branch leaves without a word is caught though the function speaks elsewhere; a say before it counts unless the function waited since, and a block beside it does not (BQT item 32b)', () => {
  /** Where the n-th write of #b is in a function's source. */
  const at = (fn: string, n = 1) => { let i = -1; for (let k = 0; k < n; k++) i = fn.indexOf('$(\'b\').', i + 1); return i; };
  const r = 'r';
  const two = `function f(a) {\n  if (a) { $('b').hidden = true; return; }\n  $('b').hidden = false;\n  sayAloud('r', 'x');\n}`;
  assert.equal(saidOnBranch(two, at(two), r), false, 'a branch that writes and leaves with no say');
  assert.equal(saidOnBranch(two, at(two, 2), r), true, 'and the write after it, which the say follows');
  const first = `function f(a) {\n  sayAloud('r', a ? '' : 'x');\n  if (a) { $('b').hidden = true; return; }\n}`;
  assert.equal(saidOnBranch(first, at(first), r), true, 'a say before, on the way in');
  const waits = `async function f() {\n  sayAloud('r', 'Working…');\n  try { await go(); sayAloud('r', ''); } catch (e) { $('b').hidden = false; $('b').textContent = e.message; }\n}`;
  assert.equal(saidOnBranch(waits, at(waits), r), false, 'a say before an await does not say what is written after it');
  const beside = `function f(a) {\n  if (a) { sayAloud('r', 'x'); } else { $('b').hidden = true; }\n}`;
  assert.equal(saidOnBranch(beside, at(beside), r), false, 'a say in the block beside it is not on its way');
  const alias = `function f(a) {\n  const say = (w) => { if (typeof sayAloud === 'function') sayAloud('r', w); };\n  if (a) { $('b').hidden = true; say(''); return; }\n}`;
  assert.equal(saidOnBranch(alias, at(alias), r), true, 'a name the function gives its say counts');
  const fin = `async function f() {\n  try { await go(); sayAloud('r', ''); } catch (e) { sayAloud('r', e.message); } finally { $('b').hidden = true; }\n}`;
  assert.equal(saidOnBranch(fin, at(fin), r), true, 'a finally whose try and catch both say');
  const finNo = `async function f() {\n  try { await go(); sayAloud('r', ''); } catch (e) { log(e); } finally { $('b').hidden = true; }\n}`;
  assert.equal(saidOnBranch(finNo, at(finNo), r), false, 'and not one whose catch says nothing');
});

test('every write of a box said aloud is on a branch that says it — each place a function shows, hides or fills it, never only somewhere else in the function — or the function runs only inside the one that says it (BQT item 32b)', () => {
  for (const { box, region, parts = [], sayer } of SAID) {
    const sites = [box, ...parts].flatMap(writeSitesOf);
    assert.ok(sites.length > 0, `control: #${box} is written`);
    for (const s of sites) {
      // A painter that says nothing at all runs only inside the sayer (the test above holds it there).
      if (sayer && !s.fn.includes(`sayAloud('${region}', `)) continue;
      assert.ok(saidOnBranch(s.fn, s.at, region), `${fnName(s.fn)} writes #${box} — ${s.line} — on a branch that says nothing in #${region}`);
    }
  }
});

test('the two boxes that were never a status are plain: Disk City\'s hover card a tooltip, and the Clean Up refusal toasted, in the same task, every time it is shown (BQS)', () => {
  for (const { box, why } of NOT_LIVE) assert.ok(!isLive(tagOf(box)), `#${box} is no live region — ${why}: ${tagOf(box)}`);
  assert.match(tagOf('cityCard'), /\srole="tooltip"/, 'the hover card is a tooltip, as the map\'s is');
  const promote = pageFn('function promoteRuleToPolicy(');
  const shows = promote.split('why.hidden = false;').length - 1;
  assert.ok(shows > 0, 'control: the refusal is shown beside the button');
  assert.equal(promote.split(/why\.hidden = false;\s*toast\(why\.textContent, 'error'/).length - 1, shows, 'each time it is shown, its words are toasted');
  assert.match(tagOf('toasts'), /\saria-live="polite"/, 'control: the toasts are said aloud');
  assert.match(pageFn('function syncModalLayers('), /el\.id !== 'toasts'/, 'control: and stay out of inert while a sheet is open');
});

/* ───────────────────────────── the page's own code, run ───────────────────────────── */

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeHtml = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** What a browser renders of markup, as innerText reads it: tags gone, each block on a line of its own, runs of space as one. */
function rendered(html: string): string {
  return decode(html.replace(/<\/?(?:div|p|ul|li|br)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ''))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** An element as far as these writers reach. A region's text is recorded each time it is set. */
class El {
  hidden = false;
  /** The element that holds this one, where a test says: hidden, it hides this one too (BQT item 32a). */
  parent: El | null = null;
  /** Whether the element itself is displayed: not hidden, unless a test says otherwise (a sheet is displayed while open). */
  displayed: () => boolean = () => !this.hidden;
  /** Whether a browser renders it: displayed, and every element that holds it too. */
  rendered(): boolean { return this.displayed() && (!this.parent || this.parent.rendered()); }
  /** Made inert, as syncModalLayers makes the page under an open sheet (BQU item 33). */
  inert = false;
  hasAttribute(name: string): boolean { return name === 'inert' && this.inert; }
  /** As far as the page asks it: the nearest of it and its holders that is inert. */
  closest(sel: string): El | null {
    assert.equal(sel, '[inert]', 'control: the page asks the fake only for the inert element that holds it');
    for (let e: El | null = this; e; e = e.parent) if (e.inert) return e;
    return null;
  }
  /** As a browser answers: one box while it is rendered, none while it or anything holding it is not. */
  getClientRects(): Array<{ width: number; height: number }> { return this.rendered() ? [{ width: 1, height: 1 }] : []; }
  id = '';
  className = '';
  readonly children: El[] = [];
  title = '';
  value = '';
  readonly said: string[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style = { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => '' };
  /** What the stylesheet leaves out of this element's markup as it is rendered: nothing, unless a test says. */
  unrendered: (html: string) => string = (html) => html;
  /** How many times innerText was read: a read a browser answers only after laying the page out (BQT item 31). */
  innerTextReads = 0;
  private text = '';
  private html = '';
  private readonly classes = new Set<string>();
  private readonly attrs = new Map<string, string>();
  readonly classList = {
    add: (c: string) => { this.classes.add(c); },
    remove: (c: string) => { this.classes.delete(c); },
    toggle: (c: string, on?: boolean) => { if (on ?? !this.classes.has(c)) this.classes.add(c); else this.classes.delete(c); },
    contains: (c: string) => this.classes.has(c),
  };
  /** Its child nodes, as far as the writers reach: the text node a write of its text or markup leaves, and what is appended. */
  private nodes: unknown[] = [];
  get childNodes(): readonly unknown[] { return this.nodes; }
  get firstChild(): unknown { return this.nodes[0] ?? null; }
  /** Each MutationObserver watch of its children: of it, or of an element holding it where the watch asks for its subtree (review F1.1). */
  readonly childWatches: Array<{ opts: WatchOpts; hear: (target: El, added: unknown[], removed: unknown[]) => void }> = [];
  /**
   * Its children replaced, as the DOM's "replace all" does for a write of textContent or innerHTML: a record is queued
   * only where a node went or came — emptying an element that holds nothing queues none (review F1.1, F1.3, F1.10).
   */
  private replaceNodes(added: unknown[]): void {
    const removed = this.nodes.splice(0, this.nodes.length, ...added);
    this.told(added, removed);
  }
  private told(added: unknown[], removed: unknown[]): void {
    if (!added.length && !removed.length) return;
    for (let e: El | null = this; e; e = e.parent) for (const w of e.childWatches) if (e === this || w.opts.subtree) w.hear(this, added, removed);
  }
  get textContent(): string { return this.text; }
  set textContent(v: string) {
    this.text = String(v ?? ''); this.html = escapeHtml(this.text); this.said.push(this.text);
    this.replaceNodes(this.text ? [{ nodeType: 3, data: this.text }] : []);
  }
  get innerHTML(): string { return this.html; }
  set innerHTML(v: string) {
    this.html = String(v); this.text = decode(this.html.replace(/<[^>]+>/g, ''));
    this.replaceNodes(this.html ? [{ nodeType: 3, data: this.text }] : []);
  }
  /** As a browser reads it: what is rendered, one block a line; an element not rendered — hidden, or held by one that is — reads as its text. */
  get innerText(): string { this.innerTextReads++; return this.rendered() ? rendered(this.unrendered(this.html)) : this.text; }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  querySelector(): El { return new El(); }
  /** The elements it holds that match a selector: none, unless a test says (a view's live regions, BQX). */
  querySelectorAll: (sel: string) => El[] = () => [];
  /** An element, or a text node ({ nodeType: 3, data }), appended: a text node's words join its text. */
  appendChild<T>(child: T): T {
    if (child instanceof El) this.children.push(child);
    else { const data = String((child as { data?: unknown }).data ?? ''); this.text += data; this.html += escapeHtml(data); }
    this.nodes.push(child);
    this.told([child], []);
    return child;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  remove(): void { this.removed = true; }
  removed = false;
  focus(): void {}
  select(): void {}
  /** Whether `other` is this element or one it holds. */
  contains(other: El): boolean { for (let e: El | null = other; e; e = e.parent) if (e === this) return true; return false; }
}

/** Let the microtasks and a few turns pass: a count, never a time. */
async function turns(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** The map sayAloud keeps what each region says in, declared right above it in the page. */
function aloudMapDecl(): string {
  const m = /\nconst (\w+) = new Map\(\);[^\n]*\nfunction sayAloud\(/.exec(INDEX);
  assert.ok(m, 'control: sayAloud keeps what each region says in a map declared right above it');
  return `const ${m[1]} = new Map();`;
}

/**
 * Page declarations lifted and run over Els, with sayAloud — and frames run by hand. `given` is what they reach
 * beyond the lifted ones; `none` are ids the page finds no element for; `run` is page code run after the
 * declarations, as the page runs it as it loads. A frame runs each callback, then `after` (the microtasks).
 */
function page(decls: string[], given: Record<string, unknown> = {}, none: string[] = [], run: string[] = []) {
  const els = new Map<string, El>();
  const $ = (id: string) => {
    if (none.includes(id)) return null;
    let e = els.get(id);
    if (!e) { e = new El(); els.set(id, e); }
    return e;
  };
  const frames: Array<() => void> = [];
  const scope: Record<string, unknown> = {
    $, escapeHtml, formatCount: (n: number) => n.toLocaleString('en-US'), requestAnimationFrame: (fn: () => void) => frames.push(fn), ...given,
  };
  const all = [...decls, 'function sayAloud(', 'function asSentences('];
  const own = new Set(all.map(nameOf));
  const proxy = new Proxy(scope, {
    has: (t, k) => typeof k === 'string' && k in t && !own.has(k),
    get: (t, k) => (k === Symbol.unscopables ? undefined : t[k as string]),
    set: (t, k, v) => { t[k as string] = v; return true; },
  });
  const fns = new Function('scope', `with (scope) { ${aloudMapDecl()}\n${all.map(srcOf).join('\n')}\n${run.join('\n')}\n return { ${[...own].join(', ')} }; }`)(proxy) as
    Record<string, (...a: unknown[]) => unknown>;
  const frame = (after: () => void = () => {}) => { for (const fn of frames.splice(0)) { fn(); after(); } };
  return { $: (id: string) => $(id) as El, fns, frame, scope };
}

/* ── the preview banner ── */

const PREVIEW_SAID = 'Up to that much space comes back, but only when you empty the Trash. The Undo Vault also keeps a copy so you can undo this, and that copy takes up space until the Undo Vault removes it.';

/** syncCartPreviewChrome over a preview of 1.2 GB with two staged items outside the folder; the cart open or closed. */
function previewBanner(cartOpen: boolean) {
  const p = page(['function syncCartPreviewChrome(', 'function cartSpaceSaid('], {
    tmPreview: { on: true, saved: null, freedBytes: 1.2e9, stagedInView: 3, outsideView: 2, outsideBytes: 5e8, outsideUnsized: 0 },
    state: { capsuleOff: false },
    formatBytes: (n: number) => `${(n / 1e9).toFixed(1)} GB`,
    tmPreviewPadSync: () => false, tmPreviewWatch: () => {},
  });
  // The banner's message rendered as the page's stylesheet has it: while the cart is open, its .tm-pv-cart-said
  // sentence is not displayed (pinned below).
  p.$('tmPreviewText').unrendered = (html) => (cartOpen ? html.replace(/<span class="tm-pv-cart-said">[\s\S]*?<\/span>/g, '') : html);
  p.$('tmPreviewBanner').hidden = true;
  return p;
}

test('the preview banner\'s whole message is said in its own region a frame after the banner shows it — the cart open or closed, the sentence that space comes back only once the Trash is emptied included — and the region is emptied when the preview ends (BQS; BQT item 30)', () => {
  assert.match(INDEX, /body\.cart-open \.tm-preview-banner \.tm-pv-cart-said \{ display: none; \}/,
    'control: while the cart is open the stylesheet hides the banner\'s sentence the cart\'s footer shows beside it (H52)');
  // That footer is no live region: said nowhere else, the sentence must be said here, the cart open or not (BQS review L2).
  assert.doesNotMatch(INDEX.slice(INDEX.lastIndexOf('<', INDEX.indexOf(' id="cartFootTotal"')), INDEX.indexOf('>', INDEX.indexOf(' id="cartFootTotal"')) + 1),
    /\srole="(?:status|alert|log)"|\saria-live="/, 'control: the cart\'s footer, which shows it while the cart is open, says nothing aloud');
  const lead = 'Preview — nothing has been deleted. The hatched areas are the 1.2 GB this cart stages for the Trash.';
  const outside = '2 staged items (0.5 GB) are outside this folder and not shown.';
  const open = previewBanner(true);
  open.fns.syncCartPreviewChrome();
  assert.equal(open.$('tmPreviewBanner').hidden, false, 'control: the banner is shown');
  assert.ok(open.$('tmPreviewText').innerHTML.includes(`<span class="tm-pv-cart-said">${PREVIEW_SAID}</span>`), 'control: its markup holds the sentence the cart says');
  assert.equal(open.$('tmPreviewText').innerText, `${lead} ${outside}`, 'control: beside the open cart the banner shows the message without it');
  assert.equal(open.$('tmPreviewSaid').textContent, '', 'nothing is said before the frame: the banner comes on screen in this task');
  open.frame();
  assert.equal(open.$('tmPreviewSaid').textContent, `${lead} ${PREVIEW_SAID} ${outside}`,
    'a frame later the region says the whole message — with the cart open too, since nothing else says that space comes back only once the Trash is emptied');

  const closed = previewBanner(false);
  closed.fns.syncCartPreviewChrome();
  closed.frame();
  assert.equal(closed.$('tmPreviewSaid').textContent, `${lead} ${PREVIEW_SAID} ${outside}`, 'with the cart closed the banner shows that sentence, and the same message is said');
  (closed.scope.tmPreview as { on: boolean }).on = false;
  closed.fns.syncCartPreviewChrome();
  assert.deepEqual([closed.$('tmPreviewBanner').hidden, closed.$('tmPreviewSaid').textContent], [true, ''], 'the preview over, the banner goes and the region is emptied at once');
});

/* ── the alternate renderers' footnote ── */

test('the footnote under the map is said in its own region a frame after it shows, once; the words of a layout still being refined, a new count every frame, are not said, and the region is emptied when the note goes (BQS)', () => {
  const st = { treemap: { altNote: '', cells: [] as unknown[] } };
  const p = page(['function renderAltNote(', 'function altRefiningNote('], { state: st });
  const note = 'areas are approximate: the solver hit its iteration cap with the worst cell 9.1% off its true share';
  st.treemap.cells = Array.from({ length: 300 }, () => ({}));
  st.treemap.altNote = note;
  p.fns.renderAltNote();
  assert.deepEqual([p.$('tmAltNote').hidden, p.$('tmAltNote').textContent], [false, note], 'control: the note is shown');
  assert.equal(p.$('tmAltNoteSaid').textContent, '', 'nothing is said before the frame');
  p.frame();
  assert.equal(p.$('tmAltNoteSaid').textContent, note, 'a frame later the region says it');

  p.$('tmAltNoteSaid').said.length = 0;
  // A slice of a re-layout, as the page writes one: the shapes drawn so far, and the note counting them.
  st.treemap.cells = Array.from({ length: 120 }, () => ({}));
  st.treemap.altNote = p.fns.altRefiningNote(st.treemap.cells.length) as string;
  p.fns.renderAltNote();
  p.frame();
  assert.equal(p.$('tmAltNote').textContent, 'still laying out — 120 shapes so far', 'control: a re-layout shows its progress');
  assert.deepEqual(p.$('tmAltNoteSaid').said, [], 'a layout still being refined is not said: its count changes every frame');
  st.treemap.altNote = note;
  p.fns.renderAltNote();
  p.frame();
  assert.deepEqual(p.$('tmAltNoteSaid').said, [], 'and the note it settles on, the one already said, is not said again');

  st.treemap.altNote = '';
  p.fns.renderAltNote();
  assert.deepEqual([p.$('tmAltNote').hidden, p.$('tmAltNoteSaid').textContent], [true, ''], 'no note: the box hides and the region is emptied at once');
});

/* ── the delete dialog's open-file panel ── */

/** The open-file guard's writers over Els, each request to the server held until answered. */
function openHandles() {
  const held: Array<{ ok: (v: unknown) => void; no: (e: Error) => void }> = [];
  const p = page([
    'let openHandleSeq', 'let confirmIgnoreOpenHandles', 'const TRASH_CHUNK', 'const OPEN_HANDLE_PREFLIGHT_CHUNKS',
    'function resetOpenHandleWarning(', 'async function checkOpenHandlesFor(', 'function renderOpenHandleWarning(',
    'function baseName(', 'function setConfirmButton(', 'function confirmFooterReset(',
  ], {
    api: () => new Promise((ok, no) => held.push({ ok, no })),
    icon: () => '<svg aria-hidden="true"></svg>', nodeFor: () => null,
  });
  const answer = async (v: unknown) => { for (const h of held.splice(0)) h.ok(v); await turns(); };
  const refuse = async () => { for (const h of held.splice(0)) h.no(new Error('offline')); await turns(); };
  return { ...p, answer, refuse };
}

/** The warning as it is shown, a block a line — and as it is said, a sentence a line: the region is on one line. */
const IN_USE_SHOWN = 'This item is in use right now. Its space may not come back, even once you empty the Trash, until that program closes it.\nPreview — b.txt';
const IN_USE = IN_USE_SHOWN.replace('\n', ' ');

test('the delete dialog\'s open-file panel says what it shows in its own region, inside the dialog, a frame after it shows it — "Checking…", then the warning that changes what OK does — and the region is emptied when the panel goes (BQS)', async () => {
  const p = openHandles();
  void p.fns.checkOpenHandlesFor(['/a/b.txt']);
  assert.equal(p.$('confirmOpenHandles').textContent, 'Checking whether anything has these files open…', 'control: the panel says it is checking');
  assert.equal(p.$('confirmOpenHandlesSaid').textContent, '', 'nothing is said before the frame');
  p.frame();
  assert.equal(p.$('confirmOpenHandlesSaid').textContent, 'Checking whether anything has these files open…', 'a frame later the region says it');
  await p.answer({ checked: true, complete: true, conflicts: [{ processName: 'Preview', path: '/a/b.txt' }] });
  assert.match(p.$('confirmOk').innerHTML, /Move to Trash anyway/, 'control: the warning is up, and OK now moves the file anyway');
  assert.equal(p.$('confirmOpenHandles').innerText, IN_USE_SHOWN, 'control: the warning as it is shown, its programs a line each');
  assert.equal(p.$('confirmOpenHandlesSaid').textContent, '', 'new words: the region is emptied at once');
  p.frame();
  assert.equal(p.$('confirmOpenHandlesSaid').textContent, IN_USE, 'and a frame later says the warning as it is shown, a sentence a line');
  p.fns.confirmFooterReset();
  assert.deepEqual([p.$('confirmOpenHandles').hidden, p.$('confirmOpenHandlesSaid').textContent], [true, ''], 'the dialog closes: the panel goes and the region is emptied');

  void p.fns.checkOpenHandlesFor(['/a/c.txt']);
  p.frame();
  await p.answer({ checked: true, complete: true, conflicts: [] });
  assert.deepEqual([p.$('confirmOpenHandles').hidden, p.$('confirmOpenHandlesSaid').textContent], [true, ''], 'nothing open: the panel goes and nothing is left said');
  void p.fns.checkOpenHandlesFor(['/a/d.txt']);
  p.frame();
  await p.refuse();
  assert.deepEqual([p.$('confirmOpenHandles').hidden, p.$('confirmOpenHandlesSaid').textContent], [true, ''], 'no answer: the check gets out of the way, and so do its words');
});

test('the delete dialog put back with "Still in use" says its warning too: painted at once, with no check before it (BQS)', () => {
  // Something got opened between the check and the delete (reofferBlockedTrash): the panel is painted directly.
  const p = openHandles();
  p.fns.renderOpenHandleWarning({ conflicts: [{ processName: 'Preview', path: '/a/b.txt' }], checked: true }, 1, () => null);
  assert.equal(p.$('confirmOpenHandles').hidden, false, 'control: the warning is shown');
  p.frame();
  assert.equal(p.$('confirmOpenHandlesSaid').textContent, IN_USE, 'and said a frame later');
});

test('the open-file panel says a check that could not be made, and a check that reached only part of the set and found nothing, in its own region a frame after it shows them — the server\'s reason, or the panel\'s own words without one (BQT item 32c)', async () => {
  const lsof = 'lsof is not installed on this computer, so TreeMap cannot see which programs have files open.';
  // Through the check itself: the first chunk's answer is the machine saying it cannot look.
  const p = openHandles();
  void p.fns.checkOpenHandlesFor(['/a/b.txt']);
  p.frame();
  await p.answer({ checked: false, conflicts: [], reason: lsof });
  assert.deepEqual([p.$('confirmOpenHandles').hidden, p.$('confirmOpenHandles').textContent], [false, lsof], 'control: the panel says the check could not be made, in the server\'s words');
  assert.equal(p.$('confirmOpenHandlesSaid').textContent, '', 'new words: the region is emptied at once');
  p.frame();
  assert.equal(p.$('confirmOpenHandlesSaid').textContent, lsof, 'and a frame later says them');
  // Painted directly, with no reason: the panel's own words.
  const own = openHandles();
  own.fns.renderOpenHandleWarning({ checked: false, conflicts: [] }, 1, () => null);
  own.frame();
  assert.equal(own.$('confirmOpenHandlesSaid').textContent, 'TreeMap couldn’t check whether these files are in use.', 'a check that could not be made, with no reason given, says so in the panel\'s own words');

  const part = 'TreeMap checked 8,000 of 9,000 selected items, so anything open in the rest isn’t listed here.';
  const q = openHandles();
  q.fns.renderOpenHandleWarning({ checked: true, complete: false, conflicts: [], reason: part }, 9000, () => null);
  assert.deepEqual([q.$('confirmOpenHandles').hidden, q.$('confirmOpenHandles').textContent], [false, part], 'control: a partial check that found nothing says how far it reached');
  q.frame();
  assert.equal(q.$('confirmOpenHandlesSaid').textContent, part, 'and that is said a frame later');
  q.fns.renderOpenHandleWarning({ checked: true, complete: false, conflicts: [] }, 2, () => null);
  q.frame();
  assert.equal(q.$('confirmOpenHandlesSaid').textContent, 'TreeMap could not check every file in this set, so some open files may not be listed.',
    'with no reason given, the panel\'s own words for a partial check are said');
});

test('the open-file panel\'s one-line words — "Checking…", a check that could not be made, a partial check that found nothing — are said as they were set, with no layout read; only the warning, on lines of its own, is read as it is shown (BQT item 31)', async () => {
  const p = openHandles();
  void p.fns.checkOpenHandlesFor(['/a/b.txt']);
  p.frame();
  assert.equal(p.$('confirmOpenHandlesSaid').textContent, 'Checking whether anything has these files open…', 'control: "Checking…" is said');
  await p.answer({ checked: false, conflicts: [], reason: 'No way to look.' });
  p.frame();
  assert.equal(p.$('confirmOpenHandlesSaid').textContent, 'No way to look.', 'control: a check that could not be made is said');
  p.fns.renderOpenHandleWarning({ checked: true, complete: false, conflicts: [] }, 2, () => null);
  p.frame();
  assert.match(p.$('confirmOpenHandlesSaid').textContent, /^TreeMap could not check every file/, 'control: a partial check that found nothing is said');
  assert.equal(p.$('confirmOpenHandles').innerTextReads, 0, 'none of the three read the panel back: each says the one line it just set');
  p.fns.renderOpenHandleWarning({ conflicts: [{ processName: 'Preview', path: '/a/b.txt' }], checked: true }, 1, () => null);
  assert.ok(p.$('confirmOpenHandles').innerTextReads > 0, 'control: the warning, a block a line, is read as it is shown');
  p.frame();
  assert.equal(p.$('confirmOpenHandlesSaid').textContent, IN_USE, 'and said a sentence a line');
});

/* ── plain words ── */

/** The popover's translate and close over Els, the request held until answered. */
function plainWords() {
  const held: Array<(v: unknown) => void> = [];
  const p = page(['function nlClose(', 'async function nlTranslate('], {
    api: () => new Promise((ok) => held.push(ok)), fxOrbHide: () => {}, fxOrbShow: () => {}, document: { activeElement: null },
  });
  p.$('nlPop').hidden = false;
  p.$('nlPending').hidden = true;
  p.$('nlPending').innerHTML = '<span class="fx-orb-well"></span><span class="fx-shimmer-text">Translating…</span>';
  p.$('nlInput').value = 'big videos i never open';
  const answer = async (v: unknown) => { for (const h of held.splice(0)) h(v); await turns(); };
  return { ...p, answer };
}

test('the plain-words popover says "Translating…" in its own region a frame after it shows it, then why a sentence could not be translated; a translation, which takes focus, and a close leave nothing said (BQS)', async () => {
  assert.match(INDEX, /id="nlPending"[^>]*><span class="fx-orb-well"><\/span><span class="fx-shimmer-text">Translating…<\/span><\/div>/, 'control: the box\'s words, in the markup');
  const reason = 'Duplicates cannot be found by a query, so that sentence cannot become one.';
  const p = plainWords();
  void p.fns.nlTranslate();
  assert.equal(p.$('nlPending').hidden, false, 'control: the box is shown');
  assert.equal(p.$('nlSaid').textContent, '', 'nothing is said before the frame');
  p.frame();
  assert.equal(p.$('nlSaid').textContent, 'Translating…', 'a frame later the region says the box\'s words');
  await p.answer({ ok: false, reason });
  assert.deepEqual([p.$('nlPending').hidden, p.$('nlReason').hidden, p.$('nlReason').textContent], [true, false, reason], 'control: refused, and why');
  p.frame();
  assert.equal(p.$('nlSaid').textContent, reason, 'why is said');
  p.fns.nlClose();
  assert.equal(p.$('nlSaid').textContent, '', 'the popover closes: the region is emptied at once');

  const ok = plainWords();
  void ok.fns.nlTranslate();
  ok.frame();
  await ok.answer({ ok: true, q: 'type:video used>1y', matched: [], unmatched: [] });
  ok.frame();
  assert.equal(ok.$('nlResult').value, 'type:video used>1y', 'control: translated');
  assert.equal(ok.$('nlSaid').textContent, '', 'a translation takes focus to the query, which is read there: nothing is left said');
});

/* ── Disk City's line ── */

/** renderCityChrome over a city built (or not) from `nodes` nodes, of which it drew `drawn`. */
function cityLine() {
  const st = {
    scanning: false, scanId: 's1' as string | null, settledScanId: 's1', root: { path: '/r' }, indexScanDue: false, scanningPath: null,
    city: { drawn: 0, total: 0, unknownHeight: 0, unresolved: 0, height: 'size', colour: 'size', loadFailed: null as unknown, builtFrom: null as unknown },
    treemap: { history: { active: false } },
  };
  const p = page(['const UNITS', 'function formatBytes(', 'const TM_SERVER_NODE_CAP', 'function treeScanId(', 'function treeScanComing(', 'function baseName(', 'function renderCityChrome('],
    { state: st }, ['cityLegend', 'cityStatus']);
  const build = (nodes: number, drawn: number) => Object.assign(st.city, { builtFrom: { nodes: Array.from({ length: nodes }, () => ({})), minSize: 0, size: 1 }, drawn, total: nodes });
  return { ...p, st, build };
}

test('Disk City\'s line says its news in its own region — a city loading, a load that failed, the saved index\'s tree, the server\'s cap — and never the counts a zoom changes on every frame (BQS)', () => {
  const c = cityLine();
  c.fns.renderCityChrome();
  assert.equal(c.$('cityLod').textContent, 'loading this folder…', 'control: the line says the city is loading');
  assert.equal(c.$('cityLodSaid').textContent, '', 'nothing is said before the frame');
  c.frame();
  assert.equal(c.$('cityLodSaid').textContent, 'loading this folder…', 'a frame later the region says it');

  c.$('cityLodSaid').said.length = 0;
  c.build(20, 10);
  c.fns.renderCityChrome();
  c.frame();
  assert.equal(c.$('cityLod').textContent, 'showing 10 of 20 — zoom in for more', 'control: the city drew half of what it holds');
  c.st.city.drawn = 15;
  c.fns.renderCityChrome();
  c.frame();
  assert.equal(c.$('cityLod').textContent, 'showing 15 of 20 — zoom in for more', 'control: a zoom drew more');
  assert.deepEqual(c.$('cityLodSaid').said, [''], 'the city built, the loading words are taken back, and its counts are never said — not as it is built, nor as a zoom changes them');

  c.build(20000, 20000);
  c.fns.renderCityChrome();
  c.frame();
  assert.equal(c.$('cityLodSaid').textContent, 'the map holds at most 20,000 items, and this folder reached that — drill in for the rest', 'the server\'s cap is said');
  c.st.city.loadFailed = { path: '/r/d', message: 'The folder is gone.' };
  c.build(20, 20);
  c.fns.renderCityChrome();
  c.frame();
  assert.equal(c.$('cityLodSaid').textContent, 'd did not load: The folder is gone.', 'a load that failed is said, the city before it still standing');

  const idx = cityLine();
  Object.assign(idx.st, { scanId: null, settledScanId: null });
  idx.fns.renderCityChrome();
  idx.frame();
  assert.equal(idx.$('cityLodSaid').textContent, 'Opened from the saved index — scan this folder to see its city.', 'the saved index\'s tree, which gets no city, is said');
});

/* ── the Dashboard's index badge, refused folders and drives mounted inside ── */

test('the index badge says what it shows in its own region a frame after it shows it, and its region is emptied when it goes (BQS)', () => {
  const p = page(['function renderIndexBadge('], { formatDate: () => '21 Oct 2026' });
  const why = 'A change was missed while another folder\'s watch started.';
  p.fns.renderIndexBadge({ indexed: true, path: '/r', root: { path: '/r', state: 'stale', live: true, staleReason: why } });
  assert.equal(p.$('indexBadge').hidden, false, 'control: the badge is shown');
  assert.equal(p.$('indexBadgeSaid').textContent, '', 'nothing is said before the frame');
  p.frame();
  assert.equal(p.$('indexBadgeSaid').textContent, `Index may be out of date. ${why} Scan again to refresh it.`, 'a frame later the region says the badge\'s words');
  p.fns.renderIndexBadge(null);
  assert.deepEqual([p.$('indexBadge').hidden, p.$('indexBadgeSaid').textContent], [true, ''], 'no index: the badge goes and the region is emptied');
});

const REFRESH_FAILED = 'Index may be out of date — the refresh failed, so what is shown may be older.';

test('a quiet rescan that fails takes "Up to date" off the index badge it turns amber: the badge says the refresh failed and what is shown may be older — and the toast is what says it, all of it, the tree shown being the saved index\'s too: neither the badge\'s region nor the scan\'s says it again (BQT item 25, BQU item 35, review F1.2, F1.9)', () => {
  const noop = () => {};
  const st = { scanning: true, view: 'dashboard', heldBehindIndex: null };
  const toasted: string[] = [];
  const p = page(['function renderIndexBadge(', 'function quietRescanFailed('], {
    formatDate: () => '21 Oct 2026', state: st, endScanChrome: noop, restoreDashboardPanels: noop, icon: () => '', toast: (m: string) => { toasted.push(m); },
    withFocusKept: (f: () => void) => f(), switchView: noop, tourScanFailed: noop, liveScanEnded: noop, drainScanQueue: noop,
  });
  p.fns.renderIndexBadge({ indexed: true, path: '/r', root: { path: '/r', state: 'ready', live: true } });
  p.frame();
  assert.equal(p.$('indexBadgeSaid').textContent, 'Up to date — updates itself as files change', 'control: the index painted, its badge says it is up to date');
  p.fns.quietRescanFailed(new Error('That folder no longer exists.'));
  assert.equal(p.$('indexBadge').classList.contains('stale'), true, 'control: the badge turns amber');
  assert.equal(p.$('indexBadge').textContent, REFRESH_FAILED, 'and its words say what happened, never "Up to date" beside an amber dot');
  assert.doesNotMatch(p.$('indexBadge').title, /updates itself/, 'nor does its tooltip promise an index kept current');
  assert.deepEqual(toasted, ['Couldn’t refresh this folder: That folder no longer exists. What is shown comes from its saved index and may be older.'],
    'the toast, the one voice left, says the refresh failed, why, and that the tree on screen is the saved index\'s and may be older — which the badge and the status line show, and nothing else says (review F1.2, F1.9)');
  assert.equal(p.$('indexBadgeSaid').textContent, '', 'the badge\'s old words are taken back at once');
  p.frame();
  p.frame();
  const spoken = [...toasted, ...p.$('indexBadgeSaid').said, ...p.$('scanAnnounce').said];
  assert.equal(spoken.filter((s) => /saved index|may be older/.test(s)).length, 1, 'that what is shown may be older is said once, by the toast, and nowhere else');
  assert.equal(p.$('indexBadgeSaid').textContent, '', 'and its new words are not said there: the toast says the refresh failed, and on the Dashboard it was heard a third time');
  assert.deepEqual(p.$('scanAnnounce').said, [''], 'nor does the scan\'s region say it: it is emptied, its count over');
  p.fns.renderIndexBadge({ indexed: true, path: '/r', root: { path: '/r', state: 'stale', live: true, staleReason: 'A change was missed.' } });
  p.frame();
  assert.equal(p.$('indexBadgeSaid').textContent, 'Index may be out of date. A change was missed. Scan again to refresh it.', 'control: the badge\'s next news, which no toast says, is said in its region');
});

/** The refused-folder row's painters over Els, on a Mac without Full Disk Access. */
function accessRow() {
  const st = {
    system: { platform: 'darwin' }, scanId: 's1', scanning: false, accessNotice: null as string | null, scanAccessState: 'not-granted', scanRefused: null,
    capabilities: { fullDiskAccess: { state: 'not-granted', advice: 'Give TreeMap Full Disk Access in Privacy settings, then scan again.' } },
    scanStats: { refused: { dirs: 69, examples: ['/Users/x/Library/Mail', '/Users/x/Library/Safari'] } } as unknown,
  };
  const p = page(['function keepAccessFocus(', 'function paintAccessNotice(', 'function renderRefusedFolders(', 'function paintRefusedRow(',
    'function fullDiskAccessInfo(', 'function accessHintFor(', 'function lastPathSegment('], { state: st, document: { activeElement: null } });
  return { ...p, st };
}

test('the refused-folder row says its count and its hint in its own region a frame after it shows them, and the region is emptied when the row goes — every paint of it runs inside the function that says it (BQS)', () => {
  const hint = 'Give TreeMap Full Disk Access in Privacy settings, then scan again.';
  const p = accessRow();
  p.fns.renderRefusedFolders();
  assert.equal(p.$('accessRow').hidden, false, 'control: the row is shown');
  assert.equal(p.$('accessSaid').textContent, '', 'nothing is said before the frame');
  p.frame();
  assert.equal(p.$('accessSaid').textContent, `69 folders could not be read — Mail, Safari and 67 more. ${hint}`,
    'a frame later the region says the count and the hint, each a sentence of its own: the region is on one line, where a line break is only a space');
  p.st.scanStats = { refused: { dirs: 0, examples: [] } };
  p.fns.renderRefusedFolders();
  assert.deepEqual([p.$('accessRow').hidden, p.$('accessSaid').textContent], [true, ''], 'nothing refused: the row goes and the region is emptied');
});

test('the note on drives mounted inside the scanned folder says itself in its own region a frame after it shows, and its region is emptied when it goes (BQS)', () => {
  const p = page(['function renderMountsNote(', 'function mountsNoteText(', 'function lastPathSegment(']);
  p.fns.renderMountsNote({ rule: 'stay', notEntered: { count: 1 }, mounts: [{ path: '/Users/x/Sim', reached: true, entered: false, filesystem: 'apfs' }] });
  const words = '1 drive mounted inside this folder was not scanned — Sim. It is a separate disk, so its files are not part of this disk’s total.';
  assert.deepEqual([p.$('mountsNote').hidden, p.$('mountsNoteText').textContent], [false, words], 'control: the note is shown');
  assert.equal(p.$('mountsNoteSaid').textContent, '', 'nothing is said before the frame');
  p.frame();
  assert.equal(p.$('mountsNoteSaid').textContent, words, 'a frame later the region says it');
  p.fns.renderMountsNote(null);
  assert.deepEqual([p.$('mountsNote').hidden, p.$('mountsNoteSaid').textContent], [true, ''], 'nothing to say: the note goes and the region is emptied');
});

/* ── the map's empty-folder note ── */

test('the note over a map with nothing to draw says itself in its own region a frame after it shows, once however often the map is repainted, and its region is emptied when the note goes (BQU item 24)', () => {
  const p = page(['function tmSetEmpty(']);
  p.$('tmEmpty').hidden = true;
  p.fns.tmSetEmpty('This folder is empty.');
  assert.deepEqual([p.$('tmEmpty').hidden, p.$('tmEmpty').textContent], [false, 'This folder is empty.'], 'control: the note is shown');
  assert.equal(p.$('tmEmptySaid').textContent, '', 'nothing is said before the frame: the note comes on screen in this task');
  p.frame();
  assert.equal(p.$('tmEmptySaid').textContent, 'This folder is empty.', 'a frame later the region says it');
  p.$('tmEmptySaid').said.length = 0;
  p.fns.tmSetEmpty('This folder is empty.'); // a repaint of the same empty map: a resize, a theme change
  p.frame();
  assert.deepEqual(p.$('tmEmptySaid').said, [], 'the same note again is no news: a repaint says nothing');
  p.fns.tmSetEmpty('');
  assert.deepEqual([p.$('tmEmpty').hidden, p.$('tmEmptySaid').textContent], [true, ''], 'a map drawn: the note goes and the region is emptied at once');
});

/* The notes over and under the map are taken back as the Treemap view goes by the registry, as every view's regions
   are: tested with them under "every view's own regions", below (review F2.5, BQX). */

/* ── the Missing Gigabytes statement ── */

/**
 * A statement of the disk a home folder is on, as the server sends one: its lines sum to its used figure, and the scan
 * did not start at the volume, so everything else on it is in Unaccounted — which its caveat says, in the server's
 * words (missingGigabytes.ts).
 */
const MG_CAVEAT = 'This scan started at /Users/x, not at /, so everything else on the volume is inside Unaccounted. Scan the whole volume for a statement that accounts for every file.';
const MG_STATEMENT = {
  scanId: 's1', rootPath: '/Users/x',
  volume: { mountPoint: '/', totalBytes: 500e9, usedBytes: 245e9, freeBytes: 255e9, reservedBytes: 0, mechanism: 'statfs(/)', mechanismLabel: 'what macOS reports for Macintosh HD' },
  lines: [
    { id: 'scanned', label: 'Files TreeMap scanned', bytes: 233e9, available: true, detail: 'What the scan counted.', count: 1200, notes: [], remedy: null },
    { id: 'unaccounted', label: 'Unaccounted', bytes: 12e9, available: true, detail: 'The volume holds this much that no line above explained.', count: null, notes: [], remedy: null },
  ],
  unaccountedBytes: 12e9, coversWholeVolume: false,
  caveats: [MG_CAVEAT], generatedAt: 0,
};

/**
 * The Missing Gigabytes view's loader, painters and take-down over Els, with aloudWait: the view in the page's main
 * part, the statement asked of the scan `scan.id` names (null: none stands behind the tree), answered as the test says.
 */
function missingView() {
  const held: Array<{ ok: (v: unknown) => void; no: (e: Error) => void }> = [];
  const scan = { id: 's1' as string | null, coming: false };
  const p = waitingPage(['const MG_SEG', 'let missingData', 'const MISSING_CACHE_SCANS', 'const missingCache', 'let missingSeq', 'let missingUpdating', 'let missingAsking',
    'function mgRemember(', 'async function loadMissing(', 'function mgSegmentBytes(', 'function mgSegmentName(', 'function mgSegmentFigure(', 'function mgCountSaid(',
    'function mgSaid(', 'function renderMissing(', 'function missingTakeDown('], {
    state: { root: { path: '/Users/x' } }, treeScanId: () => scan.id, treeScanComing: () => scan.coming,
    api: () => new Promise((ok, no) => { held.push({ ok, no }); }),
    skeletonRows: (_n: number, _h: number, label: string) => `<div role="status" aria-label="${label}"></div>`,
    formatBytes: (n: number) => `${n / 1e9} GB`,
  });
  const view = p.$('view-missing');
  view.parent = p.main;
  const live = p.$('missingSaid');
  live.parent = view;
  p.$('missingBody').parent = view;
  p.fns.aloudKnow(live);
  p.frame();
  return { ...p, live, held, scan };
}

test('the Missing Gigabytes card is plain, and what it comes to is said in #missingSaid, in a sentence — the volume, its used and total figures and what is unaccounted, then the caveats that qualify them — held while a sheet is open over the view and said a frame after it goes; its waits, its update and its failure are said there too, and nothing is left said once the view goes (review F1.3, F1.4, F1.10, F2.1, F2.2)', async () => {
  assert.ok(!isLive(tagOf('missingBody')), `the card is no live region: written while a sheet was open its words went unheard, and heard they were the whole receipt: ${tagOf('missingBody')}`);
  const v = missingView();
  /** Each frame's rendering of the region: heard (on screen, not inert) or not, and its words. */
  const rendered: Array<{ heard: boolean; text: string }> = [];
  const frame = () => { v.frame(); rendered.push({ heard: v.live.getClientRects().length > 0 && !v.live.closest('[inert]'), text: v.live.textContent }); };
  void v.fns.loadMissing();
  assert.match(v.$('missingBody').innerHTML, /Reconciling this disk…/, 'control: the first visit shows its working rows (their sentence said in #missingWorking)');
  v.mo.inert(v.main, true); // a sheet opens over the view while the statement is worked out
  v.held.shift()!.ok(MG_STATEMENT);
  await turns();
  assert.match(v.$('missingBody').innerHTML, /mg-receipt/, 'control: the answer is painted under the sheet');
  frame();
  frame();
  assert.deepEqual(rendered.map((r) => r.text), ['', ''], 'under the sheet nothing is put in the region: inert, it would never be heard');
  v.mo.inert(v.main, false); // the sheet goes
  frame();
  frame();
  // What it comes to, and what qualifies it: most of a home folder's disk is Unaccounted only because the scan did
  // not cover it, and said bare that figure is heard as a mystery (review F2.1, F2.2).
  const said = `This disk: 245 GB used of 500 GB. Unaccounted: 12 GB. ${MG_CAVEAT}`;
  assert.deepEqual(rendered.slice(2), [{ heard: true, text: '' }, { heard: true, text: said }],
    'the frame the view comes out from under the sheet renders the region empty, and the next says what the statement comes to — in a sentence, never the whole receipt — with the caveat that qualifies its Unaccounted figure');

  // Asked again with its last statement kept: shown at once, being updated — and said so — then the answer, or why there is none.
  void v.fns.loadMissing();
  assert.match(v.$('missingBody').innerHTML, /Updating…/, 'control: the kept statement is shown, marked as being updated');
  v.frame();
  v.frame();
  assert.equal(v.live.textContent, 'Updating this statement…', 'and that it is being updated is said');
  v.held.shift()!.no(new Error('The disk layout could not be read.'));
  await turns();
  v.frame();
  assert.equal(v.live.textContent, 'The disk layout could not be read.', 'a statement that could not be read says why');

  // A scan of its own for another tree: its working rows, and nothing of the last scan's statement left said.
  void v.fns.loadMissing(); // asked again, nothing kept since the failure: its working rows, then the answer
  v.held.shift()!.ok(MG_STATEMENT);
  await turns();
  v.frame();
  assert.equal(v.live.textContent, said, 'control: the statement said again');
  v.scan.id = 's2';
  void v.fns.loadMissing();
  assert.equal(v.live.textContent, '', 'another scan\'s statement asked for, with none kept: what was said of the last one is taken back at once');
  // A scan that starts while the view is up: what the statement waits for.
  v.scan.id = null;
  v.scan.coming = true;
  void v.fns.loadMissing();
  v.frame();
  assert.equal(v.live.textContent, 'This statement is worked out from a finished scan — it fills in once the scan finishes.', 'what the card waits for is said');
  v.fns.missingTakeDown();
  assert.equal(v.live.textContent, '', 'the view gone, nothing of it is left said, so the next visit says it again');
  // Named and figured as the receipt prints them: a volume by where it is mounted, a residual below zero with its sign.
  // A scan of the whole volume has no caveat, and nothing is said after the figures.
  const other = { ...MG_STATEMENT, rootPath: '/Volumes/Data', coversWholeVolume: true, caveats: [], volume: { ...MG_STATEMENT.volume, mountPoint: '/Volumes/Data' }, lines: [MG_STATEMENT.lines[0], { ...MG_STATEMENT.lines[1], bytes: -1.5e9 }] };
  assert.equal(v.fns.mgSaid(other), '/Volumes/Data: 245 GB used of 500 GB. Unaccounted: −1.5 GB.', 'another volume, scanned whole, and a residual below zero, said as the receipt prints them');
  // Every caveat the card prints is said, each its own sentence, in the order the card prints them.
  const platform = 'TreeMap has no per-volume accounting for freebsd; only the filesystem\'s own totals are shown.';
  v.fns.sayAloud('missingSaid', v.fns.mgSaid({ ...MG_STATEMENT, caveats: [MG_CAVEAT, platform] }));
  v.frame();
  assert.equal(v.live.textContent, `This disk: 245 GB used of 500 GB. Unaccounted: 12 GB. ${MG_CAVEAT} ${platform}`, 'two caveats: both said, after the figures, as the card prints them');
});

/* ── the History view's calendar and journal ── */

test('the calendar\'s note on what it could not count says itself in its own region a frame after it shows, and its region is emptied whenever the note goes (BQS)', () => {
  const reason = 'Creation dates were read for the first 20,000 files; the days past that are not shown.';
  const st = { root: { path: '/r' }, scanning: false, scanId: null as string | null, settledScanId: null, indexScanDue: false, scanningPath: null, view: 'history' };
  const p = page(['function renderCalendar(', 'async function loadCalendar(', 'function treeScanId(', 'function treeScanComing('], {
    state: st, calChannel: 'created', calSeq: 0, calData: { modified: [], created: [], degraded: [{ reason }] },
  });
  p.fns.renderCalendar();
  assert.deepEqual([p.$('calDegraded').hidden, p.$('calDegraded').textContent], [false, reason], 'control: the note is shown');
  assert.equal(p.$('calDegradedSaid').textContent, '', 'nothing is said before the frame');
  p.frame();
  assert.equal(p.$('calDegradedSaid').textContent, reason, 'a frame later the region says it');
  (p.scope.calData as { degraded: unknown[] }).degraded = [];
  p.fns.renderCalendar();
  assert.deepEqual([p.$('calDegraded').hidden, p.$('calDegradedSaid').textContent], [true, ''], 'a channel counted whole: the note goes and the region is emptied');
  p.scope.calData = { modified: [], created: [], degraded: [{ reason }] };
  p.fns.renderCalendar();
  p.frame();
  void p.fns.loadCalendar(); // the saved index's tree, which no scan stands behind
  assert.deepEqual([p.$('calDegraded').hidden, p.$('calDegradedSaid').textContent], [true, ''], 'a calendar with nothing to count hides the note and empties the region too');
});

test('the journal\'s portable-session note says itself in its own region a frame after it shows, and its region is emptied when it goes (BQS)', async () => {
  const reason = 'This portable session writes nothing, so no journal is kept here.';
  let portable = true;
  const p = page(['async function loadJournal('], {
    state: { view: 'history' }, journalSeq: 0, skeletonRows: () => '', renderJournal: () => {},
    api: async (url: string) => (url.startsWith('/api/journal') ? { entries: [] } : { portable, degraded: portable ? [{ key: 'journal', reason }] : [] }),
  });
  await p.fns.loadJournal();
  assert.deepEqual([p.$('journalPortable').hidden, p.$('journalPortable').textContent], [false, reason], 'control: the note is shown');
  assert.equal(p.$('journalPortableSaid').textContent, '', 'nothing is said before the frame');
  p.frame();
  assert.equal(p.$('journalPortableSaid').textContent, reason, 'a frame later the region says it');
  portable = false;
  await p.fns.loadJournal();
  assert.deepEqual([p.$('journalPortable').hidden, p.$('journalPortableSaid').textContent], [true, ''], 'a session that keeps a journal: the note goes and the region is emptied');
});

/* ── who is heard while a sheet is open (BQT item 26; BQU items 33, 34, 36, 40, 41) ── */

test('every sheet is a modal dialog with a live region of its own for what is said outside it, empty in the page from the start, as its own child — inside the dialog (BQT item 26, BQU item 33)', () => {
  const sheets = [...INDEX.matchAll(/<div class="modal-backdrop" id="(\w+)"[^>]*>/g)].map((m) => ({ id: m[1], tag: m[0] }));
  assert.ok(sheets.length >= 15, `control: the page's sheets are found (${sheets.length})`);
  assert.equal(INDEX.split('class="modal-backdrop"').length - 1, sheets.length, 'control: each found once');
  for (const { id, tag } of sheets) {
    assert.match(tag, /\srole="dialog"[^>]*\saria-modal="true"/, `#${id} is a modal dialog`);
    assert.equal(INDEX.split(regionMarkup(`${id}OutsideSaid`)).length, 2, `#${id}OutsideSaid: exactly one empty live region in the markup`);
    const holders = ancestorsOf(`${id}OutsideSaid`);
    assert.equal(idIn(holders[holders.length - 1]), id, `#${id}OutsideSaid stands in #${id} itself, so it is inside the dialog whatever the dialog shows`);
  }
  assert.doesNotMatch(INDEX, /ToastSaid/, 'and no region is left under the name it had while it said only toasts');
});

/** What a sheet's region and the toasts are lifted with. */
const SHEET = ['const sheetSaid', 'function sheetStackLeftOut(', 'function sayInSheet(', 'function toastSayInSheet('];

/**
 * toast() and the sheets' voice lifted from the page, over Els: the sheet on top and where focus is are the test's to
 * say, timers run by hand — one toast's at a time, or every one up.
 */
function toasts() {
  let top: El | null = null;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const doc = { createElement: () => new El(), activeElement: null as El | null };
  const p = page(['const TOAST_MIN_MS', 'const TOAST_MS_PER_CHAR', ...SHEET, 'function toast('], {
    icon: () => '<svg aria-hidden="true"></svg>', topModal: () => top, document: doc,
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
  });
  /** A sheet opened on top, by its id, with focus moved into it as the page moves it. */
  const open = (id: string) => {
    const sheet = p.$(id);
    sheet.id = id;
    sheet.classList.add('open');
    sheet.setAttribute('aria-modal', 'true');
    const field = new El();
    field.parent = sheet;
    doc.activeElement = field;
    top = sheet;
    return sheet;
  };
  /** Every toast up runs out its time and goes. */
  const expire = () => { for (let i = 0; i < 4; i++) for (const t of timers.splice(0)) t.fn(); };
  /** The toast that would go first runs out its time and goes, and nothing else: its fade, then its removal. */
  const expireOne = () => {
    const soonest = timers.reduce((a, b) => (b.ms < a.ms ? b : a));
    timers.splice(timers.indexOf(soonest), 1);
    soonest.fn(); // the fade starts: its removal is the timer it sets
    const removal = timers.pop()!;
    removal.fn();
  };
  return { ...p, open, close: () => { top?.classList.remove('open'); top = null; doc.activeElement = null; }, expire, expireOne, doc };
}

test('a toast raised while focus is in a sheet is said in that sheet\'s own region too, a frame later — the stack outside every sheet is left out of what a screen reader reads then — and its region is emptied as the toast goes; with no sheet open the stack alone says it (BQT item 26)', () => {
  const t = toasts();
  t.fns.toast('Asked it to scan — its own screen will show the result');
  t.frame();
  assert.equal(t.$('toasts').children.length, 1, 'control: with no sheet open the toast is up in the stack, which says it');
  assert.deepEqual([...['settingsModal', 'cleanModal', 'confirmModal']].map((id) => t.$(`${id}OutsideSaid`).said), [[], [], []], 'and no sheet\'s region says it again');

  t.open('settingsModal');
  t.fns.toast('Could not save the scanning budget: offline', 'error');
  assert.equal(t.$('settingsModalOutsideSaid').textContent, '', 'nothing is said in the sheet before the frame: the region is emptied');
  t.frame();
  assert.equal(t.$('settingsModalOutsideSaid').textContent, 'Could not save the scanning budget: offline', 'a frame later the sheet\'s region says it');
  t.expire();
  assert.equal(t.$('settingsModalOutsideSaid').textContent, '', 'the toast gone, nothing of it is left said in the sheet');
  t.fns.toast('Could not save the scanning budget: offline', 'error');
  t.frame();
  assert.equal(t.$('settingsModalOutsideSaid').textContent, 'Could not save the scanning budget: offline', 'the same words again are a new toast, and are said again');
  t.expire();

  // Raised as its sheet closes — Save, then the sheet goes: the stack is no longer left out, and says it alone.
  t.fns.toast('Settings saved — ignore rules apply from the next scan');
  t.close();
  t.frame();
  assert.equal(t.$('settingsModalOutsideSaid').textContent, '', 'a sheet closed before the frame says nothing: its region is not on screen, and the stack is heard again');
});

test('toasts raised in one frame are said in the sheet each as a sentence of its own — a stop between them where one has none — never run together as one (BQU item 40)', () => {
  const t = toasts();
  t.open('settingsModal');
  t.fns.toast('Settings saved — ignore rules apply from the next scan');
  t.fns.toast('Could not save the scanning budget: offline', 'error');
  assert.equal(t.$('toasts').children.length, 2, 'control: both toasts are up in the stack');
  t.frame();
  assert.equal(t.$('settingsModalOutsideSaid').textContent, 'Settings saved — ignore rules apply from the next scan. Could not save the scanning budget: offline',
    'both, each its own sentence: "…from the next scan" and "Could not save…" are not heard as one');
  t.expire();
  t.fns.toast('The Trash is empty.');
  t.fns.toast('Could not read the Undo Vault: offline', 'error');
  t.frame();
  assert.equal(t.$('settingsModalOutsideSaid').textContent, 'The Trash is empty. Could not read the Undo Vault: offline', 'one that ends with its own stop is given no second');
});

test('a sheet\'s region is emptied only as the last of the toasts it says goes: toasts of different lengths, which stay up for different times, going one at a time (BQU item 41)', () => {
  const t = toasts();
  t.open('settingsModal');
  t.fns.toast('Saved.');
  t.fns.toast('Could not save the scanning budget: the server did not answer in time, so the budget you picked is not in use yet', 'error');
  t.frame();
  const both = 'Saved. Could not save the scanning budget: the server did not answer in time, so the budget you picked is not in use yet';
  assert.equal(t.$('settingsModalOutsideSaid').textContent, both, 'control: the sheet says both');
  t.expireOne();
  assert.equal(t.$('toasts').children.filter((c) => !c.removed).length, 1, 'control: the shorter toast has gone, the longer is still up');
  assert.equal(t.$('settingsModalOutsideSaid').textContent, both, 'with one of its toasts still up, the region still says them');
  t.expireOne();
  assert.equal(t.$('toasts').children.filter((c) => !c.removed).length, 0, 'control: the longer toast has gone too');
  assert.equal(t.$('settingsModalOutsideSaid').textContent, '', 'and only now, the last of them gone, the region is emptied');
});

test('a toast raised while focus is outside the open sheet — on another toast\'s button — is said in the stack alone: the stack is read then, and said in the sheet too it would be heard twice (BQU item 34)', () => {
  const t = toasts();
  t.open('cleanModal');
  const button = new El(); // a toast's own button: #toasts stands outside every sheet
  button.parent = t.$('toasts');
  t.doc.activeElement = button;
  t.fns.toast('Moved 3 items to the Trash');
  t.frame();
  assert.equal(t.$('toasts').children.length, 1, 'control: the toast is up in the stack, which is read with focus outside the sheet');
  assert.equal(t.$('cleanModalOutsideSaid').textContent, '', 'and the sheet does not say it again');
  t.expire();
  // Focus back in the sheet: the stack is left out again, and the sheet says the next toast.
  const field = new El();
  field.parent = t.$('cleanModal');
  t.doc.activeElement = field;
  t.fns.toast('Moved 2 items to the Trash');
  t.frame();
  assert.equal(t.$('cleanModalOutsideSaid').textContent, 'Moved 2 items to the Trash', 'control: with focus in the sheet, the sheet says it');
  // A sheet that is no modal dialog leaves the stack read wherever focus is.
  const u = toasts();
  const sheet = u.open('trashModal');
  sheet.setAttribute('aria-modal', 'false');
  u.fns.toast('Moved 3 items to the Trash');
  u.frame();
  assert.equal(u.$('trashModalOutsideSaid').textContent, '', 'a sheet that is not modal leaves nothing out, and says nothing again');
});

test('a toast raised with focus in the sheet, whose focus leaves the sheet for a button outside it before the frame — a toast that takes focus onto its own button — is said in the stack alone: where focus is is judged in the frame its words go in, not as it was raised (review F1.7, BQU item 34)', () => {
  const t = toasts();
  t.open('cleanModal');
  t.fns.toast('Moved 3 items to the Trash'); // focus in the sheet as it is raised
  const button = new El(); // a toast's own button, outside every sheet, which takes focus in the same frame
  button.parent = t.$('toasts');
  t.doc.activeElement = button;
  t.frame();
  assert.equal(t.$('toasts').children.length, 1, 'control: the toast is up in the stack, read with focus outside the sheet');
  assert.equal(t.$('cleanModalOutsideSaid').textContent, '', 'and the sheet does not say it too: heard in both it would be heard twice');
});

test('a toast with a button raised over an open sheet is said in the sheet too, unless it takes focus — which leaves the sheet for its button, read with the message it describes (BQT item 26)', () => {
  let top: El | null = null;
  const timers: Array<() => void> = [];
  const doc = { createElement: () => new El(), activeElement: null as El | null };
  const p = page(['let toastActionSeq', 'const sheetToasts', ...SHEET, 'function toastAction('], {
    icon: () => '<svg aria-hidden="true"></svg>', topModal: () => top, document: doc,
    modalFocusables: () => [], modalFocusInto: () => {}, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
  });
  const sheet = p.$('browseModal');
  sheet.id = 'browseModal';
  sheet.classList.add('open');
  sheet.setAttribute('aria-modal', 'true');
  const field = new El();
  field.parent = sheet;
  doc.activeElement = field;
  top = sheet;
  p.fns.toastAction('No folder is named Photo here. Did you mean “Photos”?', 'Open Photos', () => {}, 'error', 12000, { focus: true, sheet: 'browseModal' });
  p.frame();
  assert.deepEqual(p.$('browseModalOutsideSaid').said, [], 'one that takes focus is read where focus lands, and is not said in the sheet');
  p.fns.toastAction('These results expire in about 5 minutes — scan again to keep them fresh.', 'Scan again', () => {});
  assert.equal(p.$('browseModalOutsideSaid').textContent, '', 'one that leaves focus where it is: the sheet\'s region is emptied at once');
  p.frame();
  assert.equal(p.$('browseModalOutsideSaid').textContent, 'These results expire in about 5 minutes — scan again to keep them fresh.', 'and says its message a frame later');
  for (let i = 0; i < 4; i++) for (const fn of timers.splice(0)) fn();
  assert.equal(p.$('browseModalOutsideSaid').textContent, '', 'the toast gone, nothing of it is left said');
});

/* ───────────── live regions hidden by a parent (BQT item 28; the fake's hidden parents, item 32a) ─────────────
   BQS looked at live regions hidden by their own `hidden`. A region can be hidden by what holds it too: a view not up
   (the Dashboard while the map is), a sheet that is closed, a pane of the History view, the start screen, a sheet's
   own part (the policy editor's query row). Words put in it then are never heard, and when its parent comes back it is
   on screen already filled, which is seldom announced. sayAloud and sayWorking now hold such words until the region is
   on screen and say them a frame after; the regions written straight, whose writers ran while a parent hid them or in
   the task that showed it, say their words through sayAloud now; and the scan's own voice, #scanAnnounce, stands
   outside every view, beside #stopAnnounce. */

test('the fake element reads as a browser does under a hidden parent: innerText is its text, with no line a block, and it has no box; shown, it reads a block a line (BQT item 32a)', () => {
  const sheet = new El();
  sheet.hidden = true;
  const box = new El();
  box.parent = sheet;
  box.innerHTML = '<div>One line.</div><div>Another</div>';
  assert.equal(box.innerText, 'One line.Another', 'held by a hidden sheet, innerText is the text — no line a block');
  assert.deepEqual(box.getClientRects(), [], 'and it has no box');
  sheet.hidden = false;
  assert.equal(box.innerText, 'One line.\nAnother', 'shown, a block a line');
  assert.equal(box.getClientRects().length, 1, 'and it has its box');
});

test('the open-file warning, read back as it is shown, is read with its dialog open: every way to it opens the dialog first, and a warning read in a closed dialog would be said otherwise (BQT item 32a)', () => {
  // Read in a closed dialog, the warning's lines run together: the fake now sees that, as a browser would.
  const closed = openHandles();
  const modal = closed.$('confirmModal');
  modal.hidden = true;
  closed.$('confirmOpenHandles').parent = modal;
  closed.fns.renderOpenHandleWarning({ conflicts: [{ processName: 'Preview', path: '/a/b.txt' }], checked: true }, 1, () => null);
  closed.frame();
  assert.notEqual(closed.$('confirmOpenHandlesSaid').textContent, IN_USE, 'control: read in a closed dialog, the warning would not be said a sentence a line');
  // So every call that paints it, outside the guard's own functions, opens the dialog before it.
  const calls = [...INDEX.matchAll(/(?:checkOpenHandlesFor|renderOpenHandleWarning)\(/g)].filter((m) => !/function $/.test(INDEX.slice(m.index - 9, m.index)));
  const outside = calls.filter((m) => !['checkOpenHandlesFor', 'renderOpenHandleWarning'].includes(fnName(enclosingFn(m.index))));
  assert.ok(outside.length >= 2, `control: the dialog's openers are found (${outside.length})`);
  const opens = "$('confirmModal').classList.add('open');";
  for (const m of outside) {
    const fn = enclosingFn(m.index);
    const before = fn.slice(0, m.index - INDEX.lastIndexOf(fn, m.index));
    const at = before.lastIndexOf(opens);
    // On its way: the dialog opened before the call, in the same block — no other branch's open, which it left.
    assert.ok(at !== -1 && !before.slice(at + opens.length).includes('}'), `${fnName(fn)} opens the dialog, on the way to the call, before it paints the warning`);
  }
});

/**
 * A ResizeObserver as a browser runs one, as far as aloudWait reaches: at each layout the test runs, told of each
 * element it watches whose box came or went — and, as a browser does, of an element it has just been given that is
 * rendered, at the first layout after (its last reported box is none).
 */
class FakeResizeObserver {
  private readonly watched = new Map<El, number>();
  constructor(private readonly cb: (entries: Array<{ target: El }>) => void) {}
  observe(el: El): void { this.watched.set(el, 0); }
  unobserve(el: El): void { this.watched.delete(el); }
  layout(): void {
    const changed = [...this.watched].filter(([el, had]) => el.getClientRects().length !== had).map(([el]) => el);
    for (const el of changed) this.watched.set(el, el.getClientRects().length);
    if (changed.length) this.cb(changed.map((target) => ({ target })));
  }
}
/** The ResizeObserver a page gets, and a layout of every one it made. */
function resizeObservers() {
  const made: FakeResizeObserver[] = [];
  return { ResizeObserver: class extends FakeResizeObserver { constructor(cb: (entries: Array<{ target: El }>) => void) { super(cb); made.push(this); } }, layout: () => { for (const r of made) r.layout(); } };
}
/** What a page asks a MutationObserver to watch, as far as it reaches here. */
type WatchOpts = { attributes?: boolean; attributeFilter?: string[]; attributeOldValue?: boolean; subtree?: boolean; childList?: boolean; characterData?: boolean };
/**
 * Whether a watch hears `name` change on `el`, as a browser decides (DOM, MutationObserver.observe and "queue a
 * mutation record"): attributes watched — asked for, or implied by an attributeFilter or attributeOldValue — the name
 * in the filter where there is one, and `el` the watched element itself, or one it holds where the watch asks for its
 * subtree (review F1.4).
 */
function hearsAttribute(w: { target: El; opts: WatchOpts }, el: El, name: string): boolean {
  const attributes = w.opts.attributes ?? (w.opts.attributeFilter !== undefined || w.opts.attributeOldValue !== undefined);
  if (!attributes || (w.opts.attributeFilter && !w.opts.attributeFilter.includes(name))) return false;
  return w.target === el || (!!w.opts.subtree && w.target.contains(el));
}
/**
 * The MutationObserver a page gets, as far as it reaches here: what each watches, and `inert` — an element made inert
 * or no longer, told to each observer whose watch hears it, as a browser tells it (hearsAttribute), with the old value
 * only where that watch asks for it, a microtask later (the test calls it where the microtask would run). Taking away
 * an attribute that is not there changes nothing, and tells no one.
 * An element's children replaced or appended to (El) queue a record for each childList watch that hears it, which
 * `microtasks` hands on — each observer in the order it was made, as a browser notifies them — and takeRecords takes
 * back unheard (review F1.1).
 */
function mutationObservers() {
  const made: FakeMutationObserver[] = [];
  class FakeMutationObserver {
    readonly watches: Array<{ target: El; opts: WatchOpts }> = [];
    readonly queued: unknown[] = [];
    constructor(readonly cb: (records: unknown[]) => void) { made.push(this); }
    observe(target: El, opts: WatchOpts): void {
      this.watches.push({ target, opts });
      if (opts.childList && target instanceof El) { // a part's host, a plain object in these tests, is watched by sayWorking alone
        target.childWatches.push({ opts, hear: (t, addedNodes, removedNodes) => { if (this.watches.length) this.queued.push({ type: 'childList', target: t, addedNodes, removedNodes }); } });
      }
    }
    takeRecords(): unknown[] { return this.queued.splice(0); }
    disconnect(): void { this.watches.length = 0; this.queued.length = 0; }
  }
  /** The microtasks after a task: every record queued handed on, until none is left. */
  const microtasks = () => {
    for (let o = made.find((x) => x.queued.length); o; o = made.find((x) => x.queued.length)) o.cb(o.queued.splice(0));
  };
  const inert = (el: El, on: boolean) => {
    const oldValue = el.inert ? '' : null;
    el.inert = on;
    if (!on && oldValue === null) return;
    for (const o of made) {
      const w = o.watches.find((x) => hearsAttribute(x, el, 'inert'));
      if (w) o.cb([{ type: 'attributes', target: el, attributeName: 'inert', oldValue: w.opts.attributeOldValue ? oldValue : null }]);
    }
  };
  return { MutationObserver: FakeMutationObserver, inert, made, microtasks };
}

test('the fake MutationObserver tells of the inert attribute as a browser does: only a watch of attributes — asked for or implied — whose filter names it, on the element itself or one it holds under a subtree watch, with the old value only where asked for (review F1.4)', () => {
  const mo = mutationObservers();
  const body = new El();
  const main = new El();
  main.parent = body;
  const heard: Array<{ watch: string; oldValue: unknown }> = [];
  const watch = (name: string, target: El, opts: WatchOpts) => new mo.MutationObserver((records) => {
    for (const r of records as Array<{ oldValue: unknown }>) heard.push({ watch: name, oldValue: r.oldValue });
  }).observe(target, opts);
  watch('the page\'s', body, { attributes: true, attributeFilter: ['inert'], attributeOldValue: true, subtree: true });
  watch('no old value', body, { attributes: true, attributeFilter: ['inert'], subtree: true });
  watch('body alone', body, { attributes: true, attributeFilter: ['inert'], attributeOldValue: true });
  watch('another attribute', body, { attributes: true, attributeFilter: ['hidden'], subtree: true });
  watch('implied by the filter', body, { attributeFilter: ['inert'], subtree: true });
  watch('children only', body, { childList: true, subtree: true });
  watch('main itself', main, { attributes: true, attributeOldValue: true });
  mo.inert(main, true);
  mo.inert(main, false);
  mo.inert(main, false);
  assert.deepEqual(heard, [
    { watch: 'the page\'s', oldValue: null }, { watch: 'no old value', oldValue: null }, { watch: 'implied by the filter', oldValue: null }, { watch: 'main itself', oldValue: null },
    { watch: 'the page\'s', oldValue: '' }, { watch: 'no old value', oldValue: null }, { watch: 'implied by the filter', oldValue: null }, { watch: 'main itself', oldValue: '' },
  ], 'made inert, then no longer — and taking away an inert that is not there tells no one');
});
const WAIT = ['const aloudWaiting', 'const aloudShown', 'let aloudWatch', 'let aloudInertWatch', 'function aloudReachable(', 'function aloudKnow(', 'function aloudWait('];

/**
 * A page over Els with aloudWait, and a frame run as a browser runs one: the microtasks of the task before it, the
 * frame callbacks — the microtasks after each — then layout, which tells the ResizeObservers, and their microtasks.
 * `run` as page() takes it.
 */
function waitingPage(decls: string[], given: Record<string, unknown> = {}, run: string[] = []) {
  const ro = resizeObservers();
  const mo = mutationObservers();
  const body = new El();
  const main = new El();
  main.parent = body;
  const p = page([...WAIT, ...decls], { ResizeObserver: ro.ResizeObserver, MutationObserver: mo.MutationObserver, document: { body, activeElement: null }, ...given }, [], run);
  const frame = () => { mo.microtasks(); p.frame(mo.microtasks); ro.layout(); mo.microtasks(); };
  return { ...p, ro, mo, body, main, frame };
}

test('a box\'s words wait while a parent hides its region — another view up, its sheet or pane closed — and are said a frame after the region comes on screen; words changed meanwhile are said as they are then, and words taken back are never said (BQT item 28)', () => {
  const p = waitingPage([]);
  const view = p.$('view-dashboard');
  view.parent = p.main;
  const live = p.$('accessSaid');
  live.parent = view;
  p.fns.aloudKnow(live); // as the page loads: every region is shown to the watch
  p.frame();
  p.fns.sayAloud('accessSaid', 'On screen at once.');
  p.frame();
  assert.equal(live.textContent, 'On screen at once.', 'control: a region on screen a frame already says its words a frame later, as before');

  view.hidden = true; // the map is up, the Dashboard hidden
  p.fns.sayAloud('accessSaid', '69 folders could not be read.');
  p.frame();
  assert.equal(live.textContent, '', 'its view hidden, the region says nothing: words put in it now would never be heard');
  p.frame();
  assert.equal(live.textContent, '', 'nor on any later frame while it stays hidden');
  view.hidden = false;
  p.frame();
  assert.equal(live.textContent, '', 'the view back: nothing in the frame it comes on screen in');
  p.frame();
  assert.equal(live.textContent, '69 folders could not be read.', 'a frame later the region says the words: a change, which is heard');

  live.said.length = 0;
  view.hidden = true;
  p.fns.sayAloud('accessSaid', 'Words that go stale.');
  p.frame();
  p.fns.sayAloud('accessSaid', 'The words now.');
  p.frame();
  view.hidden = false;
  p.frame();
  p.frame();
  assert.deepEqual(live.said.filter(Boolean), ['The words now.'], 'words changed while it waited are said as they are when it comes back, once');

  live.said.length = 0;
  view.hidden = true;
  p.fns.sayAloud('accessSaid', 'Words taken back.');
  p.frame();
  p.fns.sayAloud('accessSaid', '');
  view.hidden = false;
  p.frame();
  p.frame();
  assert.deepEqual(live.said.filter(Boolean), [], 'words taken back while it waited are never said');
});

test('words given in the task that opens a sheet — before the sheet opens or after — go in a frame after the sheet\'s first: never in the frame it comes on screen, which renders the region already filled (BQU item 36)', () => {
  for (const order of ['the words, then the sheet', 'the sheet, then the words']) {
    const p = waitingPage([]);
    const sheet = p.$('dupeViewerModal');
    sheet.displayed = () => sheet.classList.contains('open');
    const live = p.$('dupeViewerSummarySaid');
    live.parent = sheet;
    p.fns.aloudKnow(live);
    /** Each frame's rendering of the region, as layout leaves it: on screen or not, and its words. */
    const rendered: Array<{ on: boolean; text: string }> = [];
    const frame = () => { p.frame(); rendered.push({ on: live.getClientRects().length > 0, text: live.textContent }); };
    frame(); // the page's first frame: the sheet closed
    if (order === 'the words, then the sheet') {
      p.fns.sayAloud('dupeViewerSummarySaid', 'Reading the copies…');
      sheet.classList.add('open');
    } else {
      sheet.classList.add('open');
      p.fns.sayAloud('dupeViewerSummarySaid', 'Reading the copies…');
    }
    for (let i = 0; i < 4; i++) frame();
    const first = rendered.findIndex((r) => r.on);
    assert.ok(first > 0, `${order}: control: the sheet comes on screen at a frame after the first`);
    assert.deepEqual(rendered[first], { on: true, text: '' }, `${order}: the frame the sheet comes on screen in renders its region empty`);
    assert.equal(rendered[first + 1].text, 'Reading the copies…', `${order}: the next gives it the words — a change, which is heard`);
  }
});

test('a part\'s working sentence waits the same way while a parent hides its region, and is said a frame after it comes on screen — unless the part has answered meanwhile (BQT item 28)', () => {
  // What sees a part's rows go: each watch of a host's children, told by the test as a browser would be.
  const watchers: Array<() => void> = [];
  const p = waitingPage(['const workingSaid', 'function sayWorking('], {
    MutationObserver: class {
      constructor(private readonly cb: () => void) {}
      observe(_t: unknown, opts: { childList?: boolean }) { if (opts.childList) watchers.push(this.cb); }
      disconnect() {}
    },
  });
  const rows = { isConnected: true, getAttribute: (k: string) => (k === 'aria-label' ? 'Reading disk layout…' : null) };
  const host = { firstElementChild: rows };
  const view = p.$('view-dashboard');
  view.hidden = true;
  const live = p.$('topologyWorking');
  live.parent = view;
  p.fns.sayWorking(host, 'topologyWorking');
  p.frame();
  assert.equal(live.textContent, '', 'its view hidden, the working sentence is not put where it would never be heard');
  view.hidden = false;
  p.frame();
  assert.equal(live.textContent, '', 'nor in the frame its view comes back in');
  p.frame();
  assert.equal(live.textContent, 'Reading disk layout…', 'and is said a frame after, the part still working');

  view.hidden = true;
  const again = { isConnected: true, getAttribute: () => 'Reading disk layout…' };
  p.fns.sayWorking({ firstElementChild: again }, 'topologyWorking');
  p.frame();
  again.isConnected = false; // the part answered: its rows are gone
  for (const w of watchers) w();
  view.hidden = false;
  p.frame();
  p.frame();
  assert.equal(live.textContent, '', 'a part that answered while hidden says nothing when its view comes back');
});

test('a region in the page under an open sheet — inert, so not heard wherever focus is — holds its words, and says them a frame after the sheet goes: never in the frame the page comes out from under it; words changed meanwhile are said as they are then, and words taken back never (BQU item 33)', () => {
  const p = waitingPage(['const workingSaid', 'function sayWorking(']);
  const view = p.$('view-dashboard');
  view.parent = p.main;
  const live = p.$('indexBadgeSaid');
  live.parent = view;
  p.fns.aloudKnow(live);
  p.frame();
  /** Each frame's rendering of the region: heard (on screen, not inert) or not, and its words. */
  const rendered: Array<{ heard: boolean; text: string }> = [];
  const frame = () => { p.frame(); rendered.push({ heard: live.getClientRects().length > 0 && !live.closest('[inert]'), text: live.textContent }); };

  p.mo.inert(p.main, true); // a sheet opens: syncModalLayers makes the page inert
  p.fns.sayAloud('indexBadgeSaid', 'Index may be out of date. A change was missed.');
  frame();
  frame();
  assert.deepEqual(rendered.map((r) => r.text), ['', ''], 'under the sheet nothing is put in the region: inert, it would never be heard');
  p.mo.inert(p.main, false); // the sheet goes
  frame();
  frame();
  assert.deepEqual(rendered.slice(2), [{ heard: true, text: '' }, { heard: true, text: 'Index may be out of date. A change was missed.' }],
    'the frame the page comes out from under the sheet renders the region empty, and the next says the words: a change, which is heard');

  // Words changed while it waited are said as they are; taken back, never.
  live.said.length = 0;
  p.mo.inert(p.main, true);
  p.fns.sayAloud('indexBadgeSaid', 'Words that go stale.');
  p.frame();
  p.fns.sayAloud('indexBadgeSaid', 'Up to date — updates itself as files change');
  p.mo.inert(p.main, false);
  p.frame();
  p.frame();
  assert.deepEqual(live.said.filter(Boolean), ['Up to date — updates itself as files change'], 'words changed under the sheet are said as they are once it goes, once');
  live.said.length = 0;
  p.mo.inert(p.main, true);
  p.fns.sayAloud('indexBadgeSaid', 'Words taken back.');
  p.fns.sayAloud('indexBadgeSaid', '');
  p.mo.inert(p.main, false);
  p.frame();
  p.frame();
  assert.deepEqual(live.said.filter(Boolean), [], 'words taken back under the sheet are never said');

  // Words given in the task the sheet goes in, once the page is out from under it: the page was not heard in the
  // last frame, so they wait for the next one too.
  rendered.length = 0;
  p.mo.inert(p.main, true);
  p.frame();
  p.mo.inert(p.main, false);
  p.fns.sayAloud('indexBadgeSaid', 'Index may be out of date. The watch stopped.');
  frame();
  frame();
  assert.deepEqual(rendered, [{ heard: true, text: '' }, { heard: true, text: 'Index may be out of date. The watch stopped.' }],
    'words given as the page comes out from under the sheet are not in the frame it comes out in, but the next');

  // A part's working sentence the same way.
  const rows = { isConnected: true, getAttribute: (k: string) => (k === 'aria-label' ? 'Reading disk layout…' : null) };
  const working = p.$('topologyWorking');
  working.parent = view;
  p.fns.aloudKnow(working);
  p.frame();
  p.mo.inert(p.main, true);
  p.fns.sayWorking({ firstElementChild: rows }, 'topologyWorking');
  p.frame();
  assert.equal(working.textContent, '', 'a working sentence given under the sheet waits too');
  p.mo.inert(p.main, false);
  p.frame();
  assert.equal(working.textContent, '', 'and is not put in as the page comes out');
  p.frame();
  assert.equal(working.textContent, 'Reading disk layout…', 'but a frame after');
});

/** The page's watch of the scan's two regions, as it sets it up as it loads (040), brace-matched. */
function scanVoiceWatchSrc(): string {
  const head = "if (typeof MutationObserver !== 'undefined') {\n  const voice = ['scanAnnounce', 'stopAnnounce'].map($);";
  const at = INDEX.indexOf(head);
  assert.notEqual(at, -1, 'control: the watch is set up as the page loads');
  let depth = 0;
  for (let i = INDEX.indexOf('{', at); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(at, i + 1);
  }
  return assert.fail('the watch never closes');
}

/**
 * The scan's voice and the sheets' lifted from the page, over Els, with toast() and the real aloudWait: the page under
 * its main part, the sheet on top the test's, and the page's own watch of the two regions (scanVoiceWatchSrc), told of
 * each write as a browser tells it.
 */
function scanVoice() {
  let top: El | null = null;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const doc = { body: null as unknown as El, activeElement: null as El | null, createTextNode: (data: string) => ({ nodeType: 3, data: String(data) }), createElement: () => new El() };
  const p = waitingPage(['const TOAST_MIN_MS', 'const TOAST_MS_PER_CHAR', ...SHEET, 'function toast(', 'const scanVoiceSheet', 'const scanVoiceHeld', 'let scanVoiceWatch', 'function scanVoiceHolding(', 'function scanVoiceSays(', 'function scanVoiceChanged('], {
    topModal: () => top, document: doc, icon: () => '<svg aria-hidden="true"></svg>',
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
  }, [scanVoiceWatchSrc()]);
  doc.body = p.body;
  const scan = p.$('scanAnnounce');
  scan.parent = p.main;
  const stop = p.$('stopAnnounce');
  stop.parent = p.main;
  const sheet = p.$('settingsModal');
  sheet.id = 'settingsModal';
  sheet.parent = p.body;
  sheet.displayed = () => sheet.classList.contains('open');
  sheet.setAttribute('aria-modal', 'true');
  const sheetLive = p.$('settingsModalOutsideSaid');
  sheetLive.parent = sheet;
  for (const r of [scan, stop, sheetLive]) p.fns.aloudKnow(r);
  p.frame();
  /** The scan's code writes the region straight, in a task of its own; the page's watch hears it in the microtasks after. */
  const write = (live: El, words: string) => { live.textContent = words; p.mo.microtasks(); };
  /** A sheet opens over the page, focus moved into it; or it goes. */
  const open = () => { sheet.classList.add('open'); top = sheet; p.mo.inert(p.main, true); const f = new El(); f.parent = sheet; doc.activeElement = f; };
  const close = () => { sheet.classList.remove('open'); top = null; doc.activeElement = null; };
  return { ...p, scan, stop, sheet, sheetLive, write, open, close, doc, timers, microtasks: p.mo.microtasks };
}

test('the scan\'s voice is heard whatever is open: what #scanAnnounce or #stopAnnounce is given while a sheet is open is said in the sheet on top a frame later, wherever focus is in the page, and taken back there as the scan\'s words change or as a toast of them would go; with no sheet open nothing touches it (BQU item 33)', () => {
  const v = scanVoice();
  v.write(v.scan, 'Scanning…');
  v.frame();
  assert.equal(v.scan.textContent, 'Scanning…', 'control: with no sheet open the scan\'s region says it, as it always has');
  assert.deepEqual(v.sheetLive.said, [], 'and no sheet says it again');

  v.open();
  v.frame();
  v.write(v.scan, '1,200 items scanned so far');
  assert.equal(v.sheetLive.textContent, '', 'a sheet open, the page under it inert: the sheet\'s region is emptied at once');
  v.frame();
  assert.equal(v.sheetLive.textContent, '1,200 items scanned so far', 'and says the scan\'s words a frame later, where they are heard');
  assert.equal(v.scan.textContent, '1,200 items scanned so far', 'the region keeps them: inert, it is not heard, and it comes back from under the sheet holding what it holds — no change');

  // Focus on a toast's button, outside the sheet: the page is inert all the same, and the sheet is heard.
  const button = new El();
  button.parent = v.$('toasts');
  v.doc.activeElement = button;
  v.write(v.scan, '2,400 items scanned so far');
  v.frame();
  assert.equal(v.sheetLive.textContent, '2,400 items scanned so far', 'with focus outside the sheet the scan is still said in it: the page stays inert wherever focus is');
  v.write(v.scan, '');
  assert.equal(v.sheetLive.textContent, '', 'the scan\'s words taken back: what the sheet said of them goes too');

  v.write(v.stop, 'You stopped the scan of /Users/x/Desktop.');
  v.frame();
  assert.equal(v.sheetLive.textContent, 'You stopped the scan of /Users/x/Desktop.', 'a Stop\'s words the same way');
  const life = v.timers.at(-1);
  assert.ok(life, 'the words said in the sheet are given a time to go');
  assert.equal(life.ms, Math.max(4200, 'You stopped the scan of /Users/x/Desktop.'.length * 60), 'control: they stay as long as a toast of them would');
  life.fn();
  assert.equal(v.sheetLive.textContent, '', 'and then go, so the sheet holds no news that is over');
});

test('what the scan\'s voice is given as a sheet goes, while the page is still inert, is held — the region empty — and said a frame after the page is heard again; with no sheet ever open it stands as written (BQU items 33, 36)', () => {
  const v = scanVoice();
  v.open();
  v.frame();
  /** Each frame's rendering of the scan's region: heard or not, and its words. */
  const rendered: Array<{ heard: boolean; text: string }> = [];
  const frame = () => { v.frame(); rendered.push({ heard: !v.scan.closest('[inert]'), text: v.scan.textContent }); };
  // "Scan this folder" in the folder picker: the sheet goes, and the scan starts, in one task — before the net lifts inert.
  v.close();
  v.write(v.scan, 'Scanning…');
  assert.equal(v.scan.textContent, '', 'the page still inert: the words are held back, the region empty');
  assert.equal(v.fns.scanVoiceSays(v.scan), 'Scanning…', 'what the region says, or holds back, is still the scan\'s words');
  v.mo.inert(v.main, false); // the net lifts inert
  frame();
  frame();
  assert.deepEqual(rendered, [{ heard: true, text: '' }, { heard: true, text: 'Scanning…' }],
    'the frame the page comes out from under the sheet renders the region empty, and the next says the words: a change, which is heard');
  assert.deepEqual(v.sheetLive.said.filter(Boolean), [], 'and the sheet, gone, says nothing of it');
  v.write(v.scan, '1 item scanned so far');
  assert.equal(v.scan.textContent, '1 item scanned so far', 'heard again, the region stands as written');
});

test('the fake element tells of its children as a browser does: emptying one that holds nothing tells no one, a write that replaces a node or appends one does (review F1.1)', () => {
  const el = new El();
  const told: Array<[number, number]> = [];
  el.childWatches.push({ opts: { childList: true }, hear: (_t, added, removed) => { told.push([added.length, removed.length]); } });
  el.textContent = '';
  assert.deepEqual(told, [], 'an element holding nothing, emptied: no node went or came, so no record (DOM "replace all")');
  el.textContent = 'Scanning…';
  el.textContent = '';
  el.textContent = '';
  el.appendChild({ nodeType: 3, data: '' });
  el.textContent = '';
  assert.deepEqual(told, [[1, 0], [0, 1], [1, 0], [0, 1]], 'words put in, taken out (once: then it holds nothing), a text node appended, and taken out');
});

test('words the scan\'s voice holds back as a sheet goes are taken back by whatever empties the region before they are said — a scan refused at once, a scan that finished — though a browser tells of no write that changes nothing: the region holds back with a node in it, which the emptying takes away (review F1.1, F1.3, F1.10)', () => {
  for (const when of ['before the page is heard again', 'after the page is heard again, before the frame that would say them']) {
    const v = scanVoice();
    v.open();
    v.frame();
    // "Scan this folder" in the folder picker, or "Scan again" in the command palette: the sheet goes and the scan
    // starts in one task — "Starting scan…", then "Scanning…" as the request goes — and the page's watch hears it in
    // the microtasks after, before the net lifts inert.
    v.close();
    v.scan.textContent = 'Starting scan…';
    v.scan.textContent = 'Scanning…';
    v.microtasks();
    assert.equal(v.fns.scanVoiceSays(v.scan), 'Scanning…', `${when}: control: the words are held back while the page is inert`);
    assert.equal(v.scan.textContent, '', `${when}: control: the region empty meanwhile`);
    v.scan.said.length = 0;
    if (when.startsWith('after')) v.mo.inert(v.main, false);
    v.scan.textContent = ''; // the request refused at once: failScan takes the scan's words back (finishScan's toasted finish the same)
    const saysAtOnce = v.fns.scanVoiceSays(v.scan); // in that task, before the watch hears of it
    v.microtasks();
    if (when.startsWith('before')) v.mo.inert(v.main, false);
    for (let i = 0; i < 3; i++) v.frame();
    assert.deepEqual(v.scan.said.filter(Boolean), [], `${when}: the words taken back are never said — "Scanning…" after the scan failed would be untrue`);
    assert.equal(v.scan.textContent, '', `${when}: and the region is left empty`);
    assert.equal(v.fns.scanVoiceSays(v.scan), '', `${when}: holding nothing back`);
    assert.equal(saysAtOnce, '', `${when}: and what the region says, or holds back, is nothing from the write on — in its own task too, before the watch hears of it (scanTheBox asks then)`);
    v.write(v.scan, 'Scanning…');
    v.frame();
    assert.equal(v.scan.textContent, 'Scanning…', `${when}: control: the next scan's words, the page heard, stand as written`);
  }
});

test('a sheet opened in the task its words come in says them a frame after its first, never in the frame it comes on screen in — the scan\'s words, and a toast raised as it opens (BQU item 36, review F1.8)', () => {
  for (const [what, words] of [['the scan\'s words', '1,200 items scanned so far'], ['a toast', 'Could not save the scanning budget: offline']] as const) {
    const v = scanVoice();
    /** Each frame's rendering of the sheet's region: on screen or not, and its words. */
    const rendered: Array<{ on: boolean; text: string }> = [];
    const frame = () => { v.frame(); rendered.push({ on: v.sheetLive.getClientRects().length > 0, text: v.sheetLive.textContent }); };
    v.open();
    if (what === 'a toast') v.fns.toast(words, 'error'); // through the page's own toast(), focus in the sheet
    else v.write(v.scan, words);
    frame();
    frame();
    assert.deepEqual(rendered, [{ on: true, text: '' }, { on: true, text: words }],
      `${what}: the frame the sheet comes on screen in renders its region empty, and the next says the words: a change, which is heard`);
  }
});

test('words the scan\'s voice gives the open sheet and takes back before its frame are never said there, though a toast raised in that frame keeps the region saying: the toast is said, alone or with the words that replaced them (review F1.5)', () => {
  for (const then of ['', '1 item scanned so far']) {
    const v = scanVoice();
    v.open();
    v.frame();
    v.fns.toast('Could not read the Undo Vault: offline', 'error'); // focus in the sheet: said there too
    v.write(v.scan, 'Scanning…');
    v.write(v.scan, then); // in the same frame: the scan refused at once (failScan empties the region), or its first count
    v.frame();
    assert.deepEqual(v.sheetLive.said.filter((w) => w.includes('Scanning…')), [], `${then || 'emptied'}: "Scanning…", taken back before its frame, is never said in the sheet`);
    assert.equal(v.sheetLive.textContent, then ? `Could not read the Undo Vault: offline. ${then}` : 'Could not read the Undo Vault: offline',
      `${then || 'emptied'}: the toast is said — with the words that replaced them, each its own sentence`);
  }
});

test('words that reach the open sheet in a later frame than a toast it has said, while that toast is still up — another toast, or the scan\'s next words — are said there in a frame of their own, and stay said as the first toast goes, whether it goes after their frame or before it (review F2.3)', () => {
  const first = 'Moved 3 items to the Trash';
  for (const [what, words] of [['a second toast', 'Could not save the scanning budget: offline'], ['the scan\'s words', '1,200 items scanned so far']] as const) {
    for (const goes of ['after their frame', 'before their frame'] as const) {
      const at = `${what}, the first toast going ${goes}`;
      const v = scanVoice();
      v.open();
      v.fns.toast(first); // focus in the sheet: said there too
      v.frame();
      v.frame();
      assert.equal(v.sheetLive.textContent, first, `${at}: control, the first toast is said in the sheet`);
      if (what === 'a second toast') v.fns.toast(words, 'error');
      else v.write(v.scan, words);
      assert.equal(v.sheetLive.textContent, '', `${at}: the region is emptied at once, so what comes next is a change, heard`);
      /** The first toast runs out its time and goes: its fade, then its removal, which takes back what the sheet said of it. */
      const firstGoes = () => { v.timers.shift()!.fn(); v.timers.pop()!.fn(); };
      if (goes === 'before their frame') firstGoes();
      v.frame();
      v.frame();
      assert.equal(v.sheetLive.textContent, words, `${at}: the new words are said in the sheet a frame later`);
      if (goes === 'after their frame') {
        firstGoes();
        assert.equal(v.sheetLive.textContent, words, `${at}: the first toast going takes back only its own words — the new ones stay said`);
      }
      if (what === 'a second toast') { v.timers.shift()!.fn(); v.timers.pop()!.fn(); } else v.write(v.scan, '');
      assert.equal(v.sheetLive.textContent, '', `${at}: and once they go too, nothing is left said`);
    }
  }
});

test('words the scan\'s voice holds back are its words only while the node it holds them with is all the region holds: other words written in the same task — a scan started another way as the folder check ends — are what it says from that write on, before the watch hears of it (review F1.6)', () => {
  const v = scanVoice();
  v.open();
  v.frame();
  v.close(); // the sheet goes, and the page is not heard again until the net lifts inert
  v.write(v.scan, 'Checking that the folder exists…');
  assert.equal(v.scan.textContent, '', 'control: the check\'s words are held back, the region empty but for the node it holds them with');
  assert.equal(v.fns.scanVoiceSays(v.scan), 'Checking that the folder exists…', 'control: and are what it says, or holds back');
  v.scan.textContent = 'Starting scan…'; // a scan started another way, in the task the check ends in
  assert.equal(v.fns.scanVoiceSays(v.scan), 'Starting scan…',
    'from that write on the region says the new words, in its own task too: the folder check, asking then whether its own words still stand (scanTheBox), leaves them in place');
  v.microtasks();
  v.mo.inert(v.main, false);
  for (let i = 0; i < 3; i++) v.frame();
  assert.equal(v.scan.textContent, 'Starting scan…', 'and once the page is heard they are said');
});

test('the scan\'s voice is watched as it is written: a change to #scanAnnounce or #stopAnnounce — its text replaced, or its text node\'s words — reaches scanVoiceChanged once for that region, and nothing else does (BQU item 33)', () => {
  const els = new Map<string, El>();
  const $ = (id: string) => { let e = els.get(id); if (!e) { e = new El(); els.set(id, e); } return e; };
  const watched: Array<{ target: El; opts: Record<string, boolean> }> = [];
  let deliver: (records: Array<{ target: El }>) => void = () => {};
  const changed: El[] = [];
  new Function('$', 'MutationObserver', 'scanVoiceChanged', `let scanVoiceWatch = null;\n${scanVoiceWatchSrc()}`)(
    $, class { constructor(cb: (records: Array<{ target: El }>) => void) { deliver = cb; } observe(target: El, opts: Record<string, boolean>) { watched.push({ target, opts }); } },
    (live: El) => { changed.push(live); });
  assert.deepEqual(watched.map((w) => [w.target, w.opts]), [[$('scanAnnounce'), { childList: true, characterData: true, subtree: true }], [$('stopAnnounce'), { childList: true, characterData: true, subtree: true }]],
    'each region is watched for its text replaced and for its text node changed');
  const words = new El(); // the text node a write leaves in #stopAnnounce
  words.parent = $('stopAnnounce');
  deliver([{ target: $('scanAnnounce') }, { target: $('scanAnnounce') }, { target: words }]);
  assert.deepEqual(changed, [$('scanAnnounce'), $('stopAnnounce')], 'two records of one region hand it on once, and a text node\'s change hands on the region that holds it');
  changed.length = 0;
  deliver([{ target: $('indexBadgeSaid') }]);
  assert.deepEqual(changed, [], 'a change anywhere else hands on nothing');
});

/* ── the audit ── */

const BODY = INDEX.slice(INDEX.indexOf('<body'), INDEX.indexOf('<script', INDEX.indexOf('<body'))).replace(/<!--[\s\S]*?-->/g, '');
/** Every live region in the page's markup, by id. */
const LIVE_IDS = [...BODY.matchAll(/<[a-z][a-z0-9]*\b[^<>]*>/gi)].map((m) => m[0]).filter(isLive).map(idIn);
/** Whether a holder hides what it holds at times: hidden in the markup, a view or a sheet, styled display:none, or one the script hides and shows. */
function hidesAtTimes(tag: string): boolean {
  const id = / id="([^"]+)"/.exec(tag)?.[1];
  return /\shidden(?:[\s>=])/.test(tag) || /\sclass="[^"]*\b(?:view|modal-backdrop)\b/.test(tag) || /\sstyle="[^"]*display:\s*none/.test(tag)
    || (!!id && new RegExp(String.raw`\$\('${id}'\)\.(?:hidden\s*=(?!=)|style\.display\s*=(?!=))`).test(INDEX));
}
/** The holders of a region that hide it at times, by id. */
const hidingHolders = (id: string) => ancestorsOf(id).filter(hidesAtTimes).map(idIn);
/** Each place the script puts words in the element with this id straight — its text or its markup — not through sayAloud or sayWorking. */
function wordsWritten(id: string): string[] {
  const write = String.raw`\.(?:textContent|innerHTML|innerText)\s*=(?!=)`;
  const out = [...INDEX.matchAll(new RegExp(String.raw`\$\('${id}'\)${write}[^\n]{0,40}`, 'g'))].map((m) => m[0]);
  for (const m of INDEX.matchAll(new RegExp(String.raw`(?:const|let) (\w+) = \$\('${id}'\);`, 'g'))) {
    for (const w of enclosingFn(m.index).matchAll(new RegExp(String.raw`(?<![\w.])${m[1]}${write}[^\n]{0,40}`, 'g'))) out.push(`${m[1]} = $('${id}') … ${w[0]}`);
  }
  return out;
}

/**
 * The live regions whose words are written straight, not through sayAloud or sayWorking, with why each is still heard:
 * none is written while what holds it hides it, or while a sheet makes the page under it inert.
 */
const WRITTEN_STRAIGHT: ReadonlyMap<string, string> = new Map([
  ['tmKbAnnounce', 'written only as j and k move the highlight on the map, which has focus: the map is on screen, and no sheet is open — a sheet takes focus'],
  ['scanAnnounce', 'the scan\'s voice: outside every view, always on screen, and what it is given while a sheet is open is said in the sheet on top, and held as a sheet goes until the page is heard again (scanVoiceChanged)'],
  ['stopAnnounce', 'the Stop\'s voice, beside the scan\'s, said in a sheet the same way (scanVoiceChanged)'],
]);

/** The children of <body> syncModalLayers never makes inert, by id: read from its own test of each child. */
function neverInert(): string[] {
  const sync = pageFn('function syncModalLayers(');
  const line = sync.split('\n').find((l) => /\} else if \(.*\) el\.inert = !!top;$/.test(l.trim()));
  assert.ok(line && line.includes('!MODAL_OVERLAYS.includes(el.id)'), 'control: syncModalLayers makes every other child of <body> inert while a sheet is open');
  const ids = [...line.matchAll(/el\.id !== '(\w+)'/g)].map((m) => m[1]);
  const overlays = /const MODAL_OVERLAYS = \[([^\]]*)\];/.exec(INDEX);
  assert.ok(overlays, 'control: the overlays a sheet leaves reachable are listed');
  return [...ids, ...[...overlays[1].matchAll(/'(\w+)'/g)].map((m) => m[1])];
}

test('every live region in the page is said through sayAloud or sayWorking, which hold its words until it is heard — on screen, and out from under any sheet — or is a sheet\'s own region, the toast stack, or one named with why; and every one but the toast stack is in a part of the page a sheet makes inert (BQT item 28, BQU item 33)', () => {
  const held = LIVE_IDS.filter((id) => hidingHolders(id).length > 0);
  for (const id of ['accessSaid', 'confirmOpenHandlesSaid', 'journalPortableSaid', 'startLastSaid', 'apQuerySaid', 'cleanWorking', 'nlSaid', 'settingsModalOutsideSaid']) {
    assert.ok(held.includes(id), `control: the audit finds #${id} under a parent that hides it (${hidingHolders(id).join(', ')})`);
  }
  assert.match(pageFn('function sayAloud('), /aloudWait\(live, /, 'sayAloud holds words while its region is not heard');
  assert.match(pageFn('function sayWorking('), /aloudWait\(live, /, 'and so does sayWorking');
  assert.match(pageFn('function aloudReachable('), /closest\('\[inert\]'\)/, 'and a region in the page a sheet makes inert is not heard');
  const own = (id: string) => id.endsWith('OutsideSaid') || id === 'toasts';
  const straight = LIVE_IDS.filter((id) => !own(id) && !WRITTEN_STRAIGHT.has(id)).flatMap((id) => wordsWritten(id).map((w) => `#${id}: ${w}`));
  assert.deepEqual(straight, [], 'no live region is written straight: its words would go unheard under a parent that hides it or a sheet, or come back already in it');
  for (const id of WRITTEN_STRAIGHT.keys()) assert.ok(LIVE_IDS.includes(id) && wordsWritten(id).length > 0, `control: #${id}, named here, is a live region still written straight`);
  // Every live region but the toast stack stands in a part of the page that is inert while a sheet is open: the page's
  // main part, the sidebar, or a sheet (inert under the one on top).
  const exempt = neverInert();
  assert.ok(exempt.includes('toasts'), 'control: the toast stack is never made inert');
  const outsideInert = LIVE_IDS.filter((id) => exempt.includes(id) || ancestorsOf(id).slice(1).some((t) => exempt.includes(idIn(t))));
  assert.deepEqual(outsideInert, ['toasts'], 'the toast stack alone stands where no sheet makes it inert: every other region is held, or said in the sheet');
  // A sheet's own region is written by sayInSheet alone, by a name it builds, and only while its sheet is still open.
  assert.ok(LIVE_IDS.filter((id) => id.endsWith('OutsideSaid')).every((id) => held.includes(id)), 'control: every sheet\'s region is under its sheet');
  assert.match(pageFn('function sayInSheet('), /if \(sheetSaid\.get\(live\) !== now \|\| !sheet\.classList\.contains\('open'\)\) \{ now\.waiting = false; return; \}/,
    'and is given its words only while its sheet is still open');
  for (const id of ['scanAnnounce', 'stopAnnounce']) assert.deepEqual(hidingHolders(id), [], `#${id} stands outside every view, every sheet and the start screen: a scan and a Stop are heard wherever a person is`);
  // The scan's voice is watched as it is written, and every region is shown to the watch as the page loads.
  assert.match(INDEX, /const voice = \['scanAnnounce', 'stopAnnounce'\]\.map\(\$\);/, 'the scan\'s two regions are the ones watched');
  assert.match(INDEX, /\ndocument\.querySelectorAll\('\[aria-live\]'\)\.forEach\(aloudKnow\);/, 'every live region is shown to the watch as the page loads, so its first words wait for no extra frame');
});

test('the live regions the script makes are two, each said where it is seen: a part\'s working rows (their sentence said by sayWorking) and a chart\'s walk (filled only as the arrow keys walk the focused chart) — no notice the script shows already filled is one, the Missing Gigabytes "Updating…" included, said in #missingSaid (BQT item 28, review F1.3)', () => {
  const script = INDEX.slice(INDEX.indexOf('<script', INDEX.indexOf('<body')));
  const made = [
    ...[...script.matchAll(/setAttribute\('(?:role', '(?:status|alert|log)'|aria-live')[^\n]{0,30}/g)].map((m) => ({ at: m.index, text: m[0] })),
    ...[...script.matchAll(/<[a-z][a-z0-9]*\b[^<>]*>/gi)].filter((m) => isLive(m[0])).map((m) => ({ at: m.index, text: m[0] })),
  ].sort((a, b) => a.at - b.at).map((m) => m.text);
  assert.deepEqual(made, [
    '<div role="status" aria-label="${escapeHtml(label)}">',
    'setAttribute(\'aria-live\', \'polite\');',
  ], 'skeletonRows\' template and the chart\'s walk, in the page\'s order, and nothing else');
});

/* ── each region converted, run ── */

test('the duplicate viewer says "Reading the copies…" a frame after its sheet opens on it — the sheet opened in the same task — then what it could not read; closed, it leaves nothing said, so the next open says it again (BQT item 28)', async () => {
  const held: Array<{ ok: (v: unknown) => void; no: (e: Error) => void }> = [];
  const st = { dup: { groups: [{ files: [{ path: '/a/x.jpg' }, { path: '/b/x.jpg' }] }] }, near: { clusters: [] } };
  const p = page(['async function openDupeViewer(', 'function closeDupeViewer('], {
    state: st, treeScanId: () => 's1', dupeViewer: { kind: null, at: 0, keeper: 0, data: null, seq: 0, totalCopies: 0 },
    api: () => new Promise((ok, no) => held.push({ ok, no })), document: { addEventListener: () => {}, removeEventListener: () => {} },
    dupeViewerKeys: () => {}, renderDupeViewer: () => {}, closeModal: (id: string) => { p.$(id).classList.remove('open'); },
  });
  const sheet = p.$('dupeViewerModal');
  sheet.displayed = () => sheet.classList.contains('open');
  p.$('dupeViewerSummarySaid').parent = sheet;
  void p.fns.openDupeViewer('exact', 0);
  assert.equal(p.$('dupeViewerSummary').textContent, 'Reading the copies…', 'control: the summary says it is reading');
  assert.equal(p.$('dupeViewerSummarySaid').textContent, '', 'nothing is said in the task the sheet opens');
  p.frame();
  assert.equal(p.$('dupeViewerSummarySaid').textContent, 'Reading the copies…', 'a frame later its region, in the open sheet, says it');
  for (const h of held.splice(0)) h.no(new Error('offline'));
  await turns();
  p.frame();
  assert.equal(p.$('dupeViewerSummarySaid').textContent, 'Could not read the copies: offline', 'what it could not read is said');
  p.fns.closeDupeViewer();
  assert.equal(p.$('dupeViewerSummarySaid').textContent, '', 'closed, nothing of it is left said');
  void p.fns.openDupeViewer('exact', 0);
  p.frame();
  assert.equal(p.$('dupeViewerSummarySaid').textContent, 'Reading the copies…', 'opened again, "Reading the copies…" is news again');
});

test('the policy editor\'s query line says whether the query is understood in its own region — held while the query row is hidden, said a frame after it shows (BQT item 28)', async () => {
  const ro = resizeObservers();
  const held: Array<{ ok: (v: unknown) => void; no: (e: Error) => void }> = [];
  const p = page([...WAIT, 'let apQuerySeq', 'async function validateApQuery('], {
    ResizeObserver: ro.ResizeObserver, api: () => new Promise((ok, no) => held.push({ ok, no })),
  });
  const row = p.$('apMatchQuery');
  p.$('apQuerySaid').parent = row;
  row.hidden = true; // the editor opens on another kind of rule
  p.$('apRuleQuery').value = '';
  await p.fns.validateApQuery();
  assert.equal(p.$('apQueryStatus').textContent, 'A policy needs a query to match on.', 'control: an empty query is refused');
  p.frame();
  assert.equal(p.$('apQuerySaid').textContent, '', 'its row hidden, nothing is said');
  row.hidden = false;
  ro.layout();
  p.frame();
  assert.equal(p.$('apQuerySaid').textContent, 'A policy needs a query to match on.', 'shown, it is said a frame later');
  p.$('apRuleQuery').value = 'size>1gb';
  void p.fns.validateApQuery();
  for (const h of held.splice(0)) h.ok({ ok: true });
  await turns();
  p.frame();
  assert.equal(p.$('apQuerySaid').textContent, 'That query is understood.', 'an understood query is said');
  p.$('apRuleQuery').value = 'colour:red';
  void p.fns.validateApQuery();
  for (const h of held.splice(0)) h.no(Object.assign(new Error('Unknown field "colour".'), { offset: 0 }));
  await turns();
  p.frame();
  assert.equal(p.$('apQuerySaid').textContent, 'Unknown field "colour". (at character 1)', 'and why one is not');
});

test('the scanning budget\'s line in Settings says what is running now in its own region — an answer that comes after the sheet closed is held, and said a frame after it opens again (BQT item 28)', () => {
  const ro = resizeObservers();
  const p = page([...WAIT, 'function renderEngineBudget(', 'function renderEngineBudgetUnavailable(', 'function engineBudgetStatusText(', 'function engineBudgetErrorText(', 'const ENGINE_BUDGET_PRESETS', 'const ENGINE_BUDGET_UNAVAILABLE'], {
    ResizeObserver: ro.ResizeObserver, engineBudgetInputs: () => [], budgetPresetLabel: (s: string) => s[0].toUpperCase() + s.slice(1), engineBudget: null,
  });
  const sheet = p.$('settingsModal');
  sheet.displayed = () => sheet.classList.contains('open');
  p.$('engineBudgetNoteSaid').parent = sheet; // closed before the answer came
  p.fns.renderEngineBudget({ setting: { preset: 'auto' }, effective: { preset: 'balanced', source: 'native' } });
  assert.equal(p.$('engineBudgetNote').textContent, 'Right now: Balanced.', 'control: the line says what is running');
  p.frame();
  assert.equal(p.$('engineBudgetNoteSaid').textContent, '', 'the sheet closed, nothing is said');
  sheet.classList.add('open');
  ro.layout();
  p.frame();
  assert.equal(p.$('engineBudgetNoteSaid').textContent, 'Right now: Balanced.', 'opened again, it is said a frame later');
  p.fns.renderEngineBudgetUnavailable({ status: 404 });
  p.frame();
  assert.equal(p.$('engineBudgetNoteSaid').textContent, 'Not available in this build', 'a build without the budget says so');
});

test('a view that is not available on this computer says so in its own region, a frame after its notice shows — the notice itself no live region shown already filled; and nothing is left said once it goes (BQT item 28)', () => {
  const main = new El();
  const made: El[] = [];
  const p = page(['let capabilityNoticeSays', 'function renderCapabilityNotice('], {
    document: { createElement: () => { const e = new El(); made.push(e); return e; }, querySelector: () => main, body: main },
    icon: () => '<svg aria-hidden="true"></svg>',
  }, ['capabilityNotice']);
  p.fns.renderCapabilityNotice({ label: 'Apps' }, 'Reading which applications own what needs macOS.');
  assert.equal(made.length, 1, 'control: the notice is made');
  assert.equal(made[0].getAttribute('role'), null, 'the notice is no live region of its own: it is shown already filled');
  assert.equal(p.$('capabilityNoticeSaid').textContent, '', 'nothing is said before the frame');
  p.frame();
  assert.equal(p.$('capabilityNoticeSaid').textContent, 'Apps isn’t available on this computer. Reading which applications own what needs macOS.', 'a frame later its region says it');
  p.fns.renderCapabilityNotice({ label: 'Apps' }, null);
  assert.equal(p.$('capabilityNoticeSaid').textContent, '', 'no notice: nothing is left said');
  assert.equal(INDEX.split(regionMarkup('capabilityNoticeSaid')).length, 2, 'its region is in the page from the start, empty');
  assert.deepEqual(hidingHolders('capabilityNoticeSaid'), [], 'and stands where the notice is put, in the page\'s main part, which nothing hides');
});

test('a view opened from its own tab, which gives the reason it is not available in its title — read as focus lands on it, selection following focus — says in its region only that it is not available: the reason is said once (BQU item 39)', () => {
  const reason = 'Reading which applications own what needs macOS.';
  const main = new El();
  const doc = { createElement: () => new El(), querySelector: () => main, body: main, activeElement: null as El | null };
  const p = page(['let capabilityNoticeSays', 'function renderCapabilityNotice('], { document: doc, icon: () => '<svg aria-hidden="true"></svg>' }, ['capabilityNotice']);
  const tab = (view: string, title: string) => { const t = new El(); t.setAttribute('role', 'tab'); t.dataset.view = view; t.title = title; return t; };
  doc.activeElement = tab('apps', reason); // arrowed onto in the sidebar, or clicked
  p.fns.renderCapabilityNotice({ id: 'apps', label: 'Apps' }, reason);
  p.frame();
  assert.equal(p.$('capabilityNoticeSaid').textContent, 'Apps isn’t available on this computer.', 'the tab, focused, reads the reason: the region says only that the view is not available');
  p.fns.renderCapabilityNotice({ id: 'apps', label: 'Apps' }, null);
  // Opened any other way — the command palette, a link — focus is not on its tab: the region says the reason too.
  doc.activeElement = tab('security', reason); // another view, not available for the same reason
  p.fns.renderCapabilityNotice({ id: 'apps', label: 'Apps' }, reason);
  p.frame();
  assert.equal(p.$('capabilityNoticeSaid').textContent, `Apps isn’t available on this computer. ${reason}`,
    'focus on another view\'s tab, though it gives the same reason, does not read it of this view: the reason is said in the region');
  p.fns.renderCapabilityNotice({ id: 'apps', label: 'Apps' }, null);
  doc.activeElement = tab('apps', 'Apps');
  p.fns.renderCapabilityNotice({ id: 'apps', label: 'Apps' }, reason);
  p.frame();
  assert.equal(p.$('capabilityNoticeSaid').textContent, `Apps isn’t available on this computer. ${reason}`, 'and a tab whose title is not the reason reads no reason: the region says it');
  assert.match(pageFn('function applyCapabilitiesToTabs('), /btn\.title = reason \|\| view\.label;/, 'control: an unavailable view\'s tab gives its reason as its title');
});

test('the notice rendered again for the view already up — a scan that lands, fails or is stopped re-enters it — keeps the words it said, wherever focus has gone since: chosen again by where focus was then, the reason was said a second time, or never (review F2.6, BQU item 39)', () => {
  const reason = 'Volume topology is not available on this computer.';
  const view = { id: 'missing', label: 'Missing GB' };
  const short = 'Missing GB isn’t available on this computer.';
  const main = new El();
  const doc = { createElement: () => new El(), querySelector: () => main, body: main, activeElement: null as El | null };
  const p = page(['let capabilityNoticeSays', 'function renderCapabilityNotice('], { document: doc, icon: () => '<svg aria-hidden="true"></svg>' }, ['capabilityNotice']);
  const tab = new El(); // its tab in the sidebar, whose title gives the reason
  tab.setAttribute('role', 'tab');
  tab.dataset.view = 'missing';
  tab.title = reason;
  const inPage = new El(); // a control in the page
  inPage.parent = main;
  const live = p.$('capabilityNoticeSaid');
  const where = (at: El) => (at === tab ? 'on its tab' : 'in the page');
  for (const [opened, words, then] of [[tab, short, inPage], [inPage, `${short} ${reason}`, tab]] as const) {
    doc.activeElement = opened;
    p.fns.renderCapabilityNotice(view, reason);
    p.frame();
    assert.equal(live.textContent, words, `control: the view opened with focus ${where(opened)} says what its tab does not`);
    live.said.length = 0;
    doc.activeElement = then; // focus moves on: a click into the page, or back onto the tab
    p.fns.renderCapabilityNotice(view, reason); // the view up, re-entered: switchView(state.view)
    p.frame();
    assert.deepEqual(live.said, [], `opened with focus ${where(opened)}, rendered again with focus ${where(then)}: nothing more is said`);
    assert.equal(live.textContent, words, `opened with focus ${where(opened)}: the region still says what it said`);
    p.fns.renderCapabilityNotice({ id: 'dashboard', label: 'Dashboard' }, null); // another view opened: the notice goes
    assert.equal(live.textContent, '', 'control: and nothing of it is left said');
  }
  // A new reason for the view up is news: its words are chosen again, by where focus is now.
  doc.activeElement = tab;
  p.fns.renderCapabilityNotice(view, reason);
  p.frame();
  const other = 'Reading the disk layout needs macOS 12 or later.';
  doc.activeElement = inPage;
  p.fns.renderCapabilityNotice(view, other);
  p.frame();
  assert.equal(live.textContent, `${short} ${other}`, 'a new reason for the view up is said, with the reason: no tab is focused that gives it');
  // So is another view not available for the same reason, opened straight from this one.
  p.fns.renderCapabilityNotice({ id: 'apps', label: 'Apps' }, other);
  p.frame();
  assert.equal(live.textContent, `Apps isn’t available on this computer. ${other}`, 'another view\'s notice says its own name, though its reason is the same');
});

/* ── every view's own regions, taken back as it goes (review F2.5, BQX) ──
   sayAloud says nothing when a region already says the same words. A view's notes left said as it went stayed said
   in the hidden view: the region came back on screen already filled, which is seldom announced, and the same words
   painted on the way back in were no news. The Treemap took back its two notes as it went (F2.5); every other view's
   notes were silent on every return. The registry now takes back, as any view goes, every live region inside it that
   sayAloud holds words for (viewUnsay) — and a view painted while it is away, whose mount paints none of its boxes
   (the Dashboard's, which the scan, the index and the access recheck paint whatever view is up), says them again as
   it comes back (viewSayAgain). */

/** Each view's live regions, read from the markup: view id → the ids of the live regions inside its section. */
const VIEW_REGIONS: ReadonlyMap<string, string[]> = (() => {
  const by = new Map<string, string[]>();
  for (const id of LIVE_IDS) {
    const section = ancestorsOf(id).find((t) => /^<section\b/.test(t) && /\sclass="view"/.test(t));
    if (!section) continue;
    const view = idIn(section).replace(/^view-/, '');
    by.set(view, [...(by.get(view) ?? []), id]);
  }
  return by;
})();
/** Whether the page's script says words in the region with this id through sayAloud. */
const saidBySayAloud = (id: string) => INDEX.includes(`sayAloud('${id}', `);

const SWITCH = ['const VIEW_BY_ID', 'let mountedView', 'function viewBlockedReason(', 'function switchView(', 'const viewSaidAsItWent', 'function viewUnsay(', 'function viewSayAgain('];

/** A view's registration in the page, as its source: the object that opens with `id: '<id>'`, brace-matched. */
function viewSrc(id: string): string {
  const opens = [...INDEX.matchAll(new RegExp(String.raw`\{\s*\n\s*id: '${id}',`, 'g'))];
  assert.equal(opens.length, 1, `control: the ${id} view is registered once, its object opening with its id`);
  let depth = 0;
  for (let i = opens[0].index; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(opens[0].index, i + 1);
  }
  return assert.fail(`the ${id} view's registration never closes`);
}

const noop = () => {};

/**
 * The registry's own switchView, with sayAloud and aloudWait, over views registered as the page registers them —
 * `real`, each one's own object lifted, its mount and unmount with it — and `standIns`, which mount nothing and have
 * no unmount. Each view's section holds its live regions as the markup has them; every other live region stands in
 * the page's main part, on screen. Every view starts hidden. `decls`, `given` and `missing` as page() takes them; a
 * frame as waitingPage runs one.
 */
function viewsPage(real: string[], standIns: string[], decls: string[] = [], given: Record<string, unknown> = {}, missing: string[] = []) {
  const ro = resizeObservers();
  const mo = mutationObservers();
  const body = new El();
  const main = new El();
  main.parent = body;
  const sections: El[] = [];
  const run = [
    ...real.map((id) => `VIEW_BY_ID.set('${id}', ${viewSrc(id)});`),
    ...standIns.map((id) => `VIEW_BY_ID.set('${id}', { id: '${id}', label: '${id}', icon: 'x', needsScan: false, mount() {} });`),
  ];
  const p = page([...WAIT, ...SWITCH, ...decls], {
    ResizeObserver: ro.ResizeObserver, MutationObserver: mo.MutationObserver,
    document: { body, activeElement: null, querySelectorAll: (sel: string) => (sel === '.view' ? sections : []) },
    tabs: [], hideTooltip: noop, hideCtxMenu: noop, selectionBarFollowView: noop, renderEmptyState: noop,
    fxEmptyCtaSync: noop, fxScanHeroSync: noop, renderCapabilityNotice: noop, fxViewEnter: noop, toast: noop, ...given,
  }, missing, run);
  for (const id of [...real, ...standIns]) {
    const section = p.$(`view-${id}`);
    section.id = `view-${id}`;
    section.parent = main;
    section.hidden = true;
    sections.push(section);
    const regions = (VIEW_REGIONS.get(id) ?? []).map((r) => Object.assign(p.$(r), { id: r, parent: section }));
    section.querySelectorAll = (sel) => (sel === '[aria-live]' ? regions : []);
  }
  // As the page loads, every live region is shown to the watch (aloudKnow); its first layout says where it is.
  for (const r of LIVE_IDS) {
    const live = p.$(r);
    if (!live.parent) Object.assign(live, { id: r, parent: main });
    p.fns.aloudKnow(live);
  }
  const frame = () => { mo.microtasks(); p.frame(mo.microtasks); ro.layout(); mo.microtasks(); };
  frame();
  return { ...p, frame };
}

test('every live region inside a view that sayAloud speaks in is taken back as that view goes — emptied, words about to go in with it, and forgotten, so the same words painted again are news, said a frame after the view is back; a region sayAloud never speaks in, and every region outside the views, is left as it is (BQX)', () => {
  // Control: the audit finds the regions each view's boxes are said in.
  for (const [view, id] of [['dashboard', 'accessSaid'], ['dashboard', 'mountsNoteSaid'], ['dashboard', 'indexBadgeSaid'], ['history', 'calDegradedSaid'],
    ['history', 'journalPortableSaid'], ['city', 'cityLodSaid'], ['treemap', 'tmEmptySaid'], ['treemap', 'tmAltNoteSaid'], ['missing', 'missingSaid']]) {
    assert.ok(VIEW_REGIONS.get(view)?.includes(id), `control: the audit finds #${id} inside the ${view} view`);
  }
  const views = [...VIEW_REGIONS.keys()];
  assert.ok(views.includes('apps') && VIEW_REGIONS.get('apps')!.every((id) => !saidBySayAloud(id)), 'control: a view whose only region is a part\'s working sentence is audited too');
  const inViews = new Set(views.flatMap((v) => VIEW_REGIONS.get(v)!));
  const outside = LIVE_IDS.filter((id) => !inViews.has(id));
  for (const id of ['scanAnnounce', 'stopAnnounce', 'toasts', 'capabilityNoticeSaid', 'startLastSaid', 'nlSaid', 'apQuerySaid', 'dupeViewerSummarySaid', 'cleanModalOutsideSaid']) {
    assert.ok(outside.includes(id), `control: #${id} stands outside every view`);
  }
  const p = viewsPage([], [...views, 'elsewhere'], [], { state: { view: null, root: null, scanning: false, capabilities: null } });
  for (const view of views) {
    const said = VIEW_REGIONS.get(view)!.filter(saidBySayAloud);
    const others = VIEW_REGIONS.get(view)!.filter((id) => !saidBySayAloud(id));
    p.fns.switchView(view);
    p.frame();
    for (const id of outside) {
      if (saidBySayAloud(id)) p.fns.sayAloud(id, `Outside, ${id}.`);
      else p.$(id).textContent = `Outside, ${id}.`; // the scan's voice, the toasts and the sheets' regions are written their own ways
    }
    for (const id of said) p.fns.sayAloud(id, `Said in ${id}.`);
    for (const id of others) p.$(id).textContent = `Working in ${id}…`; // a part's working sentence, which sayWorking writes
    p.frame();
    for (const id of said) assert.equal(p.$(id).textContent, `Said in ${id}.`, `control: #${id} says its words`);
    p.fns.switchView('elsewhere');
    for (const id of said) assert.equal(p.$(id).textContent, '', `#${id} is emptied as the ${view} view goes: nothing of it is left said in the hidden view`);
    for (const id of others) assert.equal(p.$(id).textContent, `Working in ${id}…`, `#${id}, which sayAloud never speaks in, is left as it is`);
    for (const id of outside) assert.equal(p.$(id).textContent, `Outside, ${id}.`, `#${id}, outside every view, is left saying what it says`);
    for (const id of said) { p.$(id).said.length = 0; p.fns.sayAloud(id, `Said in ${id}.`); } // the same words, painted again while it is away
    p.frame();
    p.frame();
    for (const id of said) assert.deepEqual(p.$(id).said.filter(Boolean), [], `#${id} says nothing while its view is away`);
    p.fns.switchView(view);
    p.frame();
    p.frame();
    for (const id of said) assert.deepEqual(p.$(id).said.filter(Boolean), [`Said in ${id}.`], `#${id}: the same words are news after the view went — said once, a frame after it is back`);
    for (const id of outside.filter(saidBySayAloud)) {
      p.$(id).said.length = 0;
      p.fns.sayAloud(id, `Outside, ${id}.`);
      p.frame();
      assert.deepEqual(p.$(id).said, [], `#${id}: still held as said, so its same words again are no news`);
    }
    for (const id of others) p.$(id).textContent = '';
    p.fns.switchView('elsewhere');
    p.frame();
    // Words given as the view goes, due in the next frame, go with it: a visit back that paints nothing says nothing.
    p.fns.switchView(view);
    p.frame();
    for (const id of said) p.fns.sayAloud(id, `About to go in ${id}.`);
    p.fns.switchView('elsewhere');
    for (const id of said) p.$(id).said.length = 0;
    p.frame();
    p.frame();
    p.fns.switchView(view);
    for (let i = 0; i < 3; i++) p.frame();
    for (const id of said) assert.deepEqual(p.$(id).said.filter(Boolean), [], `#${id}: words about to go in as the ${view} view went are never said`);
    p.fns.switchView('elsewhere');
    p.frame();
  }
});

/** The Dashboard as the page registers it, with its refused-folder row's painters, on a Mac without Full Disk Access. */
function dashboardPage() {
  const st = {
    view: null as string | null, root: { path: '/Users/x' }, scanning: false, types: [], driveHealth: null,
    system: { platform: 'darwin' }, scanId: 's1', accessNotice: null as string | null, scanAccessState: 'not-granted', scanRefused: null,
    capabilities: { fullDiskAccess: { state: 'not-granted', advice: 'Give TreeMap Full Disk Access in Privacy settings, then scan again.' } },
    scanStats: { refused: { dirs: 69, examples: ['/Users/x/Library/Mail', '/Users/x/Library/Safari'] } } as unknown,
  };
  const p = viewsPage(['dashboard'], ['elsewhere'], ['function keepAccessFocus(', 'function paintAccessNotice(', 'function renderRefusedFolders(',
    'function paintRefusedRow(', 'function fullDiskAccessInfo(', 'function accessHintFor(', 'function lastPathSegment('], {
    state: st, donutHandle: null, renderBudgetWidget: noop, fxBudgetGaugesDrop: noop, fxDriveGaugeDrop: noop,
    skeletonRows: () => '', fxDonutLoadingSync: noop, // its mount while a scan runs: the skeletons
  });
  return { ...p, st, live: p.$('accessSaid') };
}
const ACCESS_SAID = '69 folders could not be read — Mail, Safari and 67 more. Give TreeMap Full Disk Access in Privacy settings, then scan again.';

test('the Dashboard\'s refused-folder row is said again on every visit back: taken back as the view goes, and said a frame after its region is on screen again — the Dashboard\'s mount paints none of its boxes, which the scan paints whatever view is up (BQX)', () => {
  const d = dashboardPage();
  d.fns.switchView('dashboard');
  d.frame();
  d.fns.renderRefusedFolders(); // the scan's end paints the row
  d.frame();
  assert.equal(d.live.textContent, ACCESS_SAID, 'control: said a frame after the row is painted');
  d.fns.switchView('elsewhere');
  assert.equal(d.live.textContent, '', 'taken back as the Dashboard goes');
  d.live.said.length = 0;
  d.frame(); // the person on another view
  d.frame();
  d.fns.switchView('dashboard');
  d.frame();
  assert.equal(d.live.textContent, '', 'nothing in the frame the region comes on screen in: a region that appears filled is seldom announced');
  d.frame();
  assert.equal(d.live.textContent, ACCESS_SAID, 'said again a frame after: a change, which is heard');
  d.frame();
  d.frame();
  assert.deepEqual(d.live.said.filter(Boolean), [ACCESS_SAID], 'once');
});

test('with no visit back, the Dashboard\'s row is not said again: nothing however long the person is away; painted again while away with the same words, it is said once, as the Dashboard comes back; hidden while away, nothing of it is said on the way back (BQX)', () => {
  const d = dashboardPage();
  d.fns.switchView('dashboard');
  d.frame();
  d.fns.renderRefusedFolders();
  d.frame();
  assert.equal(d.live.textContent, ACCESS_SAID, 'control: said');
  d.fns.switchView('elsewhere');
  d.live.said.length = 0;
  for (let i = 0; i < 4; i++) d.frame();
  assert.deepEqual(d.live.said, [], 'nothing is said while the person is away');

  d.fns.renderRefusedFolders(); // a recheck paints the row again while the Dashboard is away, with the same words
  for (let i = 0; i < 3; i++) d.frame();
  assert.deepEqual(d.live.said.filter(Boolean), [], 'nor as the row is painted again away');
  d.fns.switchView('dashboard');
  for (let i = 0; i < 4; i++) d.frame();
  assert.deepEqual(d.live.said.filter(Boolean), [ACCESS_SAID], 'said once as the Dashboard comes back — the words painted while away, not those and the words it went with');

  d.fns.switchView('elsewhere');
  d.st.scanStats = { refused: { dirs: 0, examples: [] } };
  d.fns.renderRefusedFolders(); // a rescan that refused nothing hides the row while the Dashboard is away
  assert.equal(d.$('accessRow').hidden, true, 'control: the row is hidden');
  d.live.said.length = 0;
  d.fns.switchView('dashboard');
  for (let i = 0; i < 4; i++) d.frame();
  assert.deepEqual(d.live.said.filter(Boolean), [], 'the row hidden while away: nothing of what it said is said on the way back');

  // Kept as it went, then spoken for while the Dashboard stood in for nothing — its welcome up, no mount — and left
  // again: what was kept the first time is not what the row shows now, and is not said.
  const e = dashboardPage();
  e.fns.switchView('dashboard');
  e.frame();
  e.fns.renderRefusedFolders();
  e.frame();
  e.fns.switchView('elsewhere');
  e.frame();
  e.st.root = null as unknown as { path: string }; // nothing on screen: the Dashboard is opened onto its welcome, and not mounted
  e.fns.switchView('dashboard');
  e.st.scanStats = { refused: { dirs: 0, examples: [] } };
  e.fns.renderRefusedFolders(); // and the row is hidden meanwhile
  e.fns.switchView('elsewhere');
  e.frame();
  e.st.root = { path: '/Users/x' };
  e.live.said.length = 0;
  e.fns.switchView('dashboard');
  for (let i = 0; i < 4; i++) e.frame();
  assert.deepEqual(e.live.said.filter(Boolean), [], 'words kept from an earlier going are not said once the row has been hidden since');
});

const MOUNTS_SAID = 'A drive is mounted inside this folder (/Users/x/Simulator). The scan stayed on this drive, so nothing on it is counted.';

test('a scan that starts brings the Dashboard back saying nothing of what its boxes said of the last scan — its refused-folder row and its note on drives mounted inside stand for that scan while this one runs, whether the scan\'s own start brings the Dashboard back or the person does — and the scan\'s end says what it paints, once (review F1.1, F1.4)', () => {
  const d = dashboardPage();
  const mounts = d.$('mountsNoteSaid');
  d.fns.switchView('dashboard');
  d.frame();
  d.fns.renderRefusedFolders(); // scan A ends: its row
  d.fns.sayAloud('mountsNoteSaid', MOUNTS_SAID); // and its note on drives mounted inside
  d.frame();
  d.frame();
  assert.equal(d.live.textContent, ACCESS_SAID, 'control: the row said');
  assert.equal(mounts.textContent, MOUNTS_SAID, 'control: the note said');
  d.fns.switchView('elsewhere'); // the person goes to the Treemap
  for (const r of [d.live, mounts]) r.said.length = 0;
  d.frame();
  // A scan of another folder starts there: beginScanChrome sets `scanning`, and its full chrome brings the Dashboard
  // back (switchView('dashboard')) — as a tab back to it would while the scan runs.
  d.st.scanning = true;
  d.fns.switchView('dashboard');
  for (let i = 0; i < 4; i++) d.frame();
  assert.equal(d.$('accessRow').hidden, false, 'control: the last scan\'s row is on screen still, beside the skeletons');
  assert.deepEqual([d.live, mounts].map((r) => r.said.filter(Boolean)), [[], []],
    'neither the folders the last scan could not read ("then scan again", to a person who just did) nor the drives mounted inside its folder are said as another scan runs');
  // The scan ends: TOPIC.scan paints its row, then finishScan re-enters the view that is up.
  d.st.scanning = false;
  d.st.scanStats = { refused: { dirs: 12, examples: ['/Users/x/Library/Mail', '/Users/x/Library/Safari'] } };
  d.fns.renderRefusedFolders();
  d.fns.switchView('dashboard');
  for (let i = 0; i < 4; i++) d.frame();
  const said = d.live.said.filter(Boolean);
  assert.equal(said.length, 1, 'control: the row this scan painted is said, once');
  assert.match(said[0], /^12 folders could not be read/, 'control: in this scan\'s words');
  assert.deepEqual(mounts.said.filter(Boolean), [], 'and what the last scan\'s note said is not kept to be said at this scan\'s end: it was that scan\'s');
});

/** History as the page registers it, on its calendar, with the calendar's own loader; `api` answers the count. */
function historyPage(api: () => Promise<unknown>) {
  const st = { view: null as string | null, root: { path: '/r' }, scanning: false, scanId: 's1', settledScanId: 's1', indexScanDue: false, scanningPath: null, capabilities: null };
  const p = viewsPage(['history'], ['elsewhere'], ['function histShow(', 'async function loadCalendar(', 'function renderCalendar(', 'function treeScanId(', 'function treeScanComing('], {
    state: st, histPanel: 'calendar', calChannel: 'created', calSeq: 0, calData: null, skeletonRows: () => '', api,
    cmpCountsDrop: noop, fxHuntBeamSync: noop, loadJournal: noop, loadCompareOptions: noop,
  });
  return { ...p, live: p.$('calDegradedSaid') };
}
const CAL_CAPPED = 'Creation dates were read for the first 20,000 files; the days past that are not shown.';

test('History\'s note on what the calendar could not count is said again on every visit back: taken back as the view goes, and said a frame after the calendar paints it again as History comes back; with no visit back, nothing (BQX)', async () => {
  const h = historyPage(async () => ({ modified: [], created: [], degraded: [{ reason: CAL_CAPPED }] }));
  h.fns.switchView('history');
  await turns();
  h.frame();
  h.frame();
  assert.equal(h.live.textContent, CAL_CAPPED, 'control: the calendar counted, its note said');
  h.fns.switchView('elsewhere');
  assert.equal(h.live.textContent, '', 'taken back as History goes');
  h.live.said.length = 0;
  for (let i = 0; i < 4; i++) h.frame();
  assert.deepEqual(h.live.said, [], 'nothing while the person is away');
  h.fns.switchView('history'); // its mount counts the calendar again, to the same note
  await turns();
  h.frame();
  assert.equal(h.live.textContent, '', 'nothing in the frame History comes on screen in');
  h.frame();
  h.frame();
  assert.deepEqual(h.live.said.filter(Boolean), [CAL_CAPPED], 'said again, once, a frame after');
});

test('a view whose mount paints its boxes again says only what it paints as it comes back, never the words of its last visit while its answer is on the way: History back after another scan says that scan\'s note alone (BQX)', async () => {
  const later = 'Creation dates are not recorded on this drive, so its days are counted by when files last changed.';
  let answer: (v: unknown) => void = noop;
  let next: () => Promise<unknown> = async () => ({ modified: [], created: [], degraded: [{ reason: CAL_CAPPED }] });
  const h = historyPage(() => next());
  h.fns.switchView('history');
  await turns();
  h.frame();
  h.frame();
  assert.equal(h.live.textContent, CAL_CAPPED, 'control: said');
  h.fns.switchView('elsewhere');
  next = () => new Promise((resolve) => { answer = resolve; });
  h.live.said.length = 0;
  h.fns.switchView('history');
  await turns();
  for (let i = 0; i < 4; i++) h.frame();
  assert.deepEqual(h.live.said.filter(Boolean), [], 'while the count is on its way, nothing of the last visit is said');
  answer({ modified: [], created: [], degraded: [{ reason: later }] });
  await turns();
  h.frame();
  h.frame();
  assert.deepEqual(h.live.said.filter(Boolean), [later], 'control: the count lands, and its own note is said, alone');
});

/** Disk City as the page registers it, its line painted from a city built of `nodes` buildings as it loads. */
function cityPage(nodes: number) {
  const st = {
    view: null as string | null, root: { path: '/r' }, scanning: false, scanId: 's1', settledScanId: 's1', indexScanDue: false, scanningPath: null, capabilities: null,
    city: { drawn: nodes, total: nodes, unknownHeight: 0, unresolved: 0, height: 'size', colour: 'size', loadFailed: null as unknown,
      builtFrom: { nodes: Array.from({ length: nodes }, () => ({})), minSize: 0, size: 1 } as unknown, raf: 0, morphRaf: 0, zoomRaf: 0, zoomTimer: 0, blocks: [] as unknown[], hover: null, drag: null },
    treemap: { rootPath: '/r', history: { active: false } },
  };
  const paint: { city: () => void } = { city: noop };
  const p = viewsPage(['city'], ['elsewhere'], ['const UNITS', 'function formatBytes(', 'const TM_SERVER_NODE_CAP', 'function treeScanId(', 'function treeScanComing(', 'function baseName(', 'function renderCityChrome('], {
    state: st, cityLoadSeq: 0, refreshDock: noop, cityFitHeight: noop, citySetHeight: noop, citySetColour: noop, window: { addEventListener: noop, removeEventListener: noop },
    cityOnPointerDown: noop, cityOnPointerMove: noop, cityOnPointerUp: noop, cityOnPointerLeave: noop, cityOnWheel: noop, cityOnKey: noop, cityOnResize: noop,
    loadCity: () => paint.city(), // the city built again from the map's buildings, and its line painted
  }, ['cityLegend', 'cityStatus']);
  paint.city = () => p.fns.renderCityChrome();
  return { ...p, live: p.$('cityLodSaid') };
}

test('Disk City\'s news on its line is said again on every visit back: taken back as the view goes, and said a frame after the city paints its line again as it comes back; with no visit back, nothing (BQX)', () => {
  const cap = 'the map holds at most 20,000 items, and this folder reached that — drill in for the rest';
  const c = cityPage(20000);
  c.fns.switchView('city');
  c.frame();
  c.frame();
  assert.equal(c.live.textContent, cap, 'control: the city built, its line\'s news said');
  c.fns.switchView('elsewhere');
  assert.equal(c.live.textContent, '', 'taken back as Disk City goes');
  c.live.said.length = 0;
  for (let i = 0; i < 4; i++) c.frame();
  assert.deepEqual(c.live.said, [], 'nothing while the person is away');
  c.fns.switchView('city');
  c.frame();
  assert.equal(c.live.textContent, '', 'nothing in the frame the city comes on screen in');
  c.frame();
  c.frame();
  assert.deepEqual(c.live.said.filter(Boolean), [cap], 'said again, once, a frame after');
});

test('the notes over and under the map are taken back as the Treemap view goes — by the registry, as every view\'s regions are — so a visit back says them again: left said in the hidden view, the same words drawn on the way back in were no news, and the region came back on screen already filled (review F2.5, BQU item 24, BQX)', () => {
  const st = {
    view: null as string | null, root: { path: '/r' }, scanning: false, capabilities: null, live: { on: false }, lens: { held: false, at: null as unknown },
    treemap: { rootPath: '/r', altNote: '', altZoomRaf: 0, altZoom: null as unknown, cells: [] as unknown[] },
  };
  const map: { draw: () => void } = { draw: noop };
  const p = viewsPage(['treemap'], ['elsewhere'], ['function tmSetEmpty(', 'function renderAltNote(', 'function altRefiningNote('], {
    state: st, tmAnimFrame: 0, tmResizeDeb: 0, treeScanId: () => 's1',
    // Its unmount's teardown, and its mount's loads, the map's own landing (draw, below) among them.
    tmCancelQueries: noop, tmCloseHints: noop, tmClearHits: noop, nlClose: noop, exitCartPreview: noop, tmSetQueryMessage: noop, disableLive: noop,
    altRefineCancel: noop, lapseStop: noop, lassoCancel: noop, fxTmPillBeamsSync: noop, loadSavedViews: noop, refreshDock: noop, tmRejudgeQuery: noop,
    loadTreemap: () => map.draw(),
  });
  const empty = 'This folder is empty.';
  const cap = 'The map holds at most 250,000 items, and this folder reached that: 1.2 GB has no rectangle here — drill in, or open the Grid view, to see the rest.';
  // What drawTreemap gives the two notes: an empty folder's map, or one that reached the server's cap.
  const cases = [
    { what: 'the note over an empty map', region: 'tmEmptySaid', words: empty, draw: () => { st.treemap.altNote = ''; p.fns.renderAltNote(); p.fns.tmSetEmpty(empty); } },
    { what: 'the footnote under a map that reached the cap', region: 'tmAltNoteSaid', words: cap, draw: () => { st.treemap.altNote = cap; p.fns.renderAltNote(); p.fns.tmSetEmpty(''); } },
  ];
  for (const { what, region, words, draw } of cases) {
    map.draw = draw;
    p.fns.switchView('treemap');
    p.frame();
    p.frame();
    assert.equal(p.$(region).textContent, words, `${what}: control, said a frame after the map is drawn`);
    p.fns.switchView('elsewhere');
    assert.equal(p.$(region).textContent, '', `${what}: taken back as the view goes, so nothing of it is left said in the hidden view`);
    p.$(region).said.length = 0;
    p.frame(); // the person on another view
    p.frame();
    p.fns.switchView('treemap'); // back to the map: its mount draws it again, with the same words
    p.frame();
    p.frame();
    assert.deepEqual(p.$(region).said.filter(Boolean), [words], `${what}: said again, once, a frame after the map is drawn on the way back in`);
    p.fns.switchView('elsewhere');
  }
});
