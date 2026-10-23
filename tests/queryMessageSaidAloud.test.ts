import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INDEX } from './fixtures/liftFrontend';

/**
 * What the map's match bar says, said aloud (review F2.2).
 *
 * The bar under the highlight box and the message box in it (#tmQueryErr) are hidden while there is nothing to
 * say, and `[hidden]` is `display: none`: tmSetQueryMessage put the words in the box and showed the box and the
 * bar in one task, so the box, a live region, appeared already filled — which a screen reader seldom announces
 * (sayWorking's own comment). The K03 sentence ("The search runs on a finished scan — it runs once the scan
 * finishes.") and a first parse error were then said only where an earlier message had left the box on screen.
 * The words are now said in #tmQuerySaid, an sr-only live region outside the bar, held by nothing hidden but the
 * Treemap view, a frame after the box shows them; the box itself is plain text, so where a reader does announce a box that appears filled the words
 * are not said twice, and the highlight box names it as its description.
 */

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

/** The opening tag of the element with this id in the markup. */
function tagOf(id: string): string {
  const at = INDEX.indexOf(` id="${id}"`);
  assert.notEqual(at, -1, `#${id} is in the markup`);
  const open = INDEX.lastIndexOf('<', at);
  return INDEX.slice(open, INDEX.indexOf('>', at) + 1);
}

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'wbr', 'area', 'col', 'embed', 'track']);

/** The opening tags of the elements that hold the one with this id, outermost first, read from the markup. */
function ancestorsOf(id: string): string[] {
  const at = INDEX.indexOf(` id="${id}"`);
  const start = INDEX.lastIndexOf('<body', at);
  assert.notEqual(start, -1, 'control: the markup has a body');
  const markup = INDEX.slice(start, INDEX.lastIndexOf('<', at)).replace(/<!--[\s\S]*?-->/g, '');
  const open: Array<{ name: string; tag: string }> = [];
  for (const m of markup.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    const name = m[2].toLowerCase();
    if (m[1]) {
      assert.equal(open.pop()?.name, name, `the markup closes ${name} where it opened it`);
    } else if (!VOID.has(name) && !m[0].endsWith('/>')) {
      open.push({ name, tag: m[0] });
    }
  }
  return open.map((o) => o.tag);
}

const SAID = '<div id="tmQuerySaid" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>';

test('the match bar\'s words have a live region of their own, empty in the page from the start, held by nothing that is hidden but the Treemap view itself — never in the bar, which is hidden while it has nothing to say (review F2.2)', () => {
  assert.equal(INDEX.split(SAID).length, 2, 'exactly one empty #tmQuerySaid region in the markup');
  const holders = ancestorsOf('tmQuerySaid');
  assert.ok(holders.some((t) => / id="treemapWrap"/.test(t)), `control: it stands in the map's frame, beside the bar: ${holders.join(' ')}`);
  assert.deepEqual(holders.filter((t) => /\shidden(?:[\s>=])/.test(t)).map((t) => / id="([^"]+)"/.exec(t)?.[1] ?? t), ['view-treemap'],
    'nothing that holds it is hidden apart from the Treemap view, so it is on screen whenever the map is');
  assert.ok(ancestorsOf('tmQueryErr').some((t) => / id="tmQueryBar"/.test(t)), 'control: the message box is in the bar, which comes and goes');
});

test('the message box is plain text, so its words are said once, and the highlight box names it as its description (review F2.2)', () => {
  const box = tagOf('tmQueryErr');
  assert.doesNotMatch(box, /\srole="|\saria-live="/, `the box is no live region of its own: ${box}`);
  assert.match(tagOf('tmSearch'), /\saria-describedby="tmQueryErr"/, 'the highlight box is described by the message about its query');
});

/* ───────────────────────────── the page's own code, run ───────────────────────────── */

/** An element as far as tmSetQueryMessage and sayAloud reach; a region's text is recorded as it is set. */
class El {
  hidden = true;
  readonly said: string[] = [];
  private text = '';
  private readonly attrs = new Map<string, string>();
  private readonly classes = new Set<string>();
  readonly classList = {
    toggle: (c: string, on?: boolean) => { if (on ?? !this.classes.has(c)) this.classes.add(c); else this.classes.delete(c); },
    contains: (c: string) => this.classes.has(c),
  };
  get textContent(): string { return this.text; }
  set textContent(v: string) { this.text = v; this.said.push(v); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
}

/** tmSetQueryMessage and sayAloud lifted from the page, over Els, with frames run by hand. */
function matchBar() {
  const els = new Map<string, El>();
  const $ = (id: string) => { let e = els.get(id); if (!e) { e = new El(); els.set(id, e); } return e; };
  const frames: Array<() => void> = [];
  let synced = 0;
  const lifted = ['function tmSetQueryMessage(', 'function sayAloud(', 'function asSentences('].map(pageFn).join('\n');
  const aloud = /\nconst (\w+) = new Map\(\);[^\n]*\nfunction sayAloud\(/.exec(INDEX);
  assert.ok(aloud, 'control: sayAloud keeps what each region says in a map declared right above it');
  const set = new Function('$', 'requestAnimationFrame', 'tmSyncQueryBar',
    `const ${aloud[1]} = new Map();\n${lifted}\nreturn tmSetQueryMessage;`)(
    $, (fn: () => void) => frames.push(fn), () => { synced++; }) as (text: string, isError: boolean) => void;
  const frame = () => { for (const fn of frames.splice(0)) fn(); };
  return { $, set, frame, synced: () => synced };
}

const K03 = 'The search runs on a finished scan — it runs once the scan finishes.';
const PARSE = 'Unknown field "colour". Valid fields: name, size, ext (at character 1)';

test('the bar\'s words are said in its region a frame after the box shows them, words it already says are not said again, and words taken away before their frame are never said (review F2.2)', () => {
  assert.ok(INDEX.includes(`'${K03}'`), 'control: these are the words the bar says while the saved index\'s tree is up and its scan is to come (K03)');
  const b = matchBar();
  b.set(K03, false);
  assert.deepEqual([b.$('tmQueryErr').textContent, b.$('tmQueryErr').hidden, b.synced()], [K03, false, 1], 'control: the box shows the words, and the bar is told');
  assert.equal(b.$('tmQuerySaid').textContent, '', 'nothing is said before the frame: the box and its bar come on screen in this task');
  b.frame();
  assert.equal(b.$('tmQuerySaid').textContent, K03, 'a frame later the region says the words, in its text');

  b.$('tmQuerySaid').said.length = 0;
  b.set(K03, false);
  b.frame();
  assert.deepEqual(b.$('tmQuerySaid').said, [], 'the same words again — a query run once more, to the same message — are no news, and are not said again');

  b.set(PARSE, true);
  assert.equal(b.$('tmQuerySaid').textContent, '', 'new words: the region is emptied at once');
  b.frame();
  assert.equal(b.$('tmQuerySaid').textContent, PARSE, 'and says them a frame later');

  b.$('tmQuerySaid').said.length = 0;
  b.set('', false);
  b.frame();
  b.set(PARSE, true);
  b.frame();
  assert.deepEqual(b.$('tmQuerySaid').said, ['', '', PARSE], 'once the bar has fallen silent, the same words as before are news again: emptied with the bar, then said');

  b.set(K03, false);
  b.set('', false);
  b.frame();
  assert.deepEqual([b.$('tmQueryErr').hidden, b.$('tmQuerySaid').textContent], [true, ''], 'words taken away before their frame are never said, and the region is left empty');
});

test('tmSetQueryMessage is the one place the box\'s words are set, so every word the bar shows is said aloud (review F2.2)', () => {
  assert.ok(pageFn('function tmSetQueryMessage(').includes("const box = $('tmQueryErr');"), 'control: tmSetQueryMessage holds the box');
  const uses = [...INDEX.matchAll(/\$\('tmQueryErr'\)(.{0,12})/g)].map((m) => m[0]);
  assert.equal(uses.filter((u) => u.startsWith("$('tmQueryErr');")).length, 1, 'only tmSetQueryMessage holds the box');
  assert.deepEqual(uses.filter((u) => !u.startsWith("$('tmQueryErr');") && !/^\$\('tmQueryErr'\)\.hidden(?!\s*=(?!=))/.test(u)), [],
    'every other use of the box reads whether it is hidden');
  assert.deepEqual([...INDEX.matchAll(/(?:getElementById\(\s*'tmQueryErr'|querySelector(?:All)?\(\s*'#tmQueryErr)[^\n]{0,40}/g)].map((m) => m[0]), [],
    'and nothing reaches the box another way');
});
