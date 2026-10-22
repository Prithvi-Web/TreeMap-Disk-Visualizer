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
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; continue; }
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
  className = '';
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
  get textContent(): string { return this.text; }
  set textContent(v: string) { this.text = String(v ?? ''); this.html = escapeHtml(this.text); this.said.push(this.text); }
  get innerHTML(): string { return this.html; }
  set innerHTML(v: string) { this.html = String(v); this.text = decode(this.html.replace(/<[^>]+>/g, '')); }
  /** As a browser reads it: what is rendered, one block a line; an element not displayed reads as its text. */
  get innerText(): string { this.innerTextReads++; return this.hidden ? this.text : rendered(this.unrendered(this.html)); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  querySelector(): El { return new El(); }
  focus(): void {}
  select(): void {}
  contains(): boolean { return false; }
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
 * beyond the lifted ones; `none` are ids the page finds no element for.
 */
function page(decls: string[], given: Record<string, unknown> = {}, none: string[] = []) {
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
  const all = [...decls, 'function sayAloud('];
  const own = new Set(all.map(nameOf));
  const proxy = new Proxy(scope, {
    has: (t, k) => typeof k === 'string' && k in t && !own.has(k),
    get: (t, k) => (k === Symbol.unscopables ? undefined : t[k as string]),
    set: (t, k, v) => { t[k as string] = v; return true; },
  });
  const fns = new Function('scope', `with (scope) { ${aloudMapDecl()}\n${all.map(srcOf).join('\n')}\n return { ${[...own].join(', ')} }; }`)(proxy) as
    Record<string, (...a: unknown[]) => unknown>;
  const frame = () => { for (const fn of frames.splice(0)) fn(); };
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

test('a quiet rescan that fails takes "Up to date" off the index badge it turns amber: the badge says the refresh failed and what is shown may be older, and its region says that a frame later (BQT item 25)', () => {
  const noop = () => {};
  const st = { scanning: true, view: 'dashboard', heldBehindIndex: null };
  const p = page(['function renderIndexBadge(', 'function quietRescanFailed('], {
    formatDate: () => '21 Oct 2026', state: st, endScanChrome: noop, restoreDashboardPanels: noop, icon: () => '', toast: noop,
    withFocusKept: (f: () => void) => f(), switchView: noop, tourScanFailed: noop, liveScanEnded: noop, drainScanQueue: noop,
  });
  p.fns.renderIndexBadge({ indexed: true, path: '/r', root: { path: '/r', state: 'ready', live: true } });
  p.frame();
  assert.equal(p.$('indexBadgeSaid').textContent, 'Up to date — updates itself as files change', 'control: the index painted, its badge says it is up to date');
  p.fns.quietRescanFailed(new Error('That folder no longer exists.'));
  assert.equal(p.$('indexBadge').classList.contains('stale'), true, 'control: the badge turns amber');
  assert.equal(p.$('indexBadge').textContent, REFRESH_FAILED, 'and its words say what happened, never "Up to date" beside an amber dot');
  assert.doesNotMatch(p.$('indexBadge').title, /updates itself/, 'nor does its tooltip promise an index kept current');
  assert.equal(p.$('indexBadgeSaid').textContent, '', 'new words: the region is emptied at once');
  p.frame();
  assert.equal(p.$('indexBadgeSaid').textContent, REFRESH_FAILED, 'and a frame later says them');
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
