import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Tail-first path boxes never reorder the path (QA D51 = D13).
 *
 * Seven boxes show a long path by its END — the file name is what tells two
 * rows apart, "/Users/me/Library/…" is not — and they do it with
 * `direction: rtl`, whose line overflows on the left and puts the ellipsis
 * there. But the path itself is left-to-right text inside a right-to-left
 * paragraph, so the bidi algorithm resolves its leading "/" (a neutral at the
 * paragraph's start) right-to-left and draws it at the far END:
 * "Users/…/holiday-4k.mov/". A folder name in Hebrew or Arabic goes further
 * and swaps whole path components around.
 *
 * The fix keeps the overflow side and takes the text out of the RTL
 * paragraph's hands: every such box opens its content with LEFT-TO-RIGHT
 * ISOLATE (U+2066) and closes it with POP DIRECTIONAL ISOLATE (U+2069), from
 * CSS generated content. Inside the isolate the path is laid out exactly as
 * it would be in a left-to-right box — no character moves — while the box as
 * a whole still clips on the left. And because the head of the path is cut
 * off, every one of these boxes carries the whole path as its tooltip.
 *
 * Both halves are checked for EVERY `direction: rtl` rule the page ships, so
 * a box added later is held to the same contract without editing this file.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const SHEET = (() => {
  const open = INDEX.indexOf('<style>');
  assert.notEqual(open, -1, 'the built page carries an inline stylesheet');
  const close = INDEX.indexOf('</style>', open);
  assert.notEqual(close, -1, 'that stylesheet closes');
  return INDEX.slice(open + '<style>'.length, close).replace(/\/\*[\s\S]*?\*\//g, ' ');
})();

/** The page's script: everything after the stylesheet (markup + app code). */
const PAGE = INDEX.slice(INDEX.indexOf('</style>'));

const RULES = [...SHEET.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .map((m) => ({ selectors: m[1].trim().split(',').map((s) => s.trim().replace(/\s+/g, ' ')), body: m[2] }))
  .filter((r) => r.selectors[0] && !r.selectors[0].startsWith('@'));

const RTL = RULES.filter((r) => /(^|[;\s])direction\s*:\s*rtl\b/.test(r.body));
const RTL_SELECTORS = [...new Set(RTL.flatMap((r) => r.selectors))];

/** The value of `content` for one exact selector, from whichever rule declares it. */
function contentOf(selector: string): string | null {
  let found: string | null = null;
  for (const r of RULES) {
    if (!r.selectors.includes(selector)) continue;
    const m = /(?:^|[;\s])content\s*:\s*([^;]+)/.exec(r.body);
    if (m) found = m[1].trim();
  }
  return found;
}

test('the page still has tail-first path boxes to hold to the contract', () => {
  // A vacuous pass is the failure mode of a test that loops over a query.
  assert.ok(RTL_SELECTORS.length >= 7, `found ${RTL_SELECTORS.length}: ${RTL_SELECTORS.join(' | ')}`);
  for (const sel of ['.bigfile .pth', '.dup-file .pth', '.cart-item .pth', '.clean-item .pth', '.gsearch-group']) {
    assert.ok(RTL_SELECTORS.includes(sel), `${sel} is one of them`);
  }
});

test('every direction:rtl box isolates its content left-to-right, so the leading "/" stays first (D51)', () => {
  for (const sel of RTL_SELECTORS) {
    assert.equal(contentOf(`${sel}::before`), '"\\2066"',
      `${sel}::before opens a LEFT-TO-RIGHT ISOLATE — without it the path's leading "/" is drawn at the end`);
    assert.equal(contentOf(`${sel}::after`), '"\\2069"',
      `${sel}::after closes the isolate it opened`);
  }
});

test('no rtl box overrides the bidi algorithm or resets the paragraph direction', () => {
  // bidi-override would draw the path backwards; plaintext resets the
  // paragraph to LTR and moves the overflow (and the ellipsis) to the tail.
  for (const r of RTL) {
    assert.doesNotMatch(r.body, /unicode-bidi\s*:\s*(bidi-override|plaintext|isolate-override)/,
      `${r.selectors.join(', ')} leaves bidi resolution to the isolate`);
  }
});

/**
 * Every place the app fills one of those boxes. A box's selector names an
 * optional container class and the box's own class; an emission is a
 * template `class="<container…>` followed, before the container is opened
 * again, by an element of the box's class — or, for a box that lives in the
 * static markup, the script line that writes its text by id.
 */
function emissionsFor(selector: string): { where: string; tag: string; titled: boolean }[] {
  const classes = selector.split(' ').map((c) => c.replace(/^\./, ''));
  const leaf = classes[classes.length - 1];
  const container = classes.length > 1 ? classes[classes.length - 2] : null;
  const leafTag = new RegExp(`<(\\w+)[^<>]*\\bclass="${leaf}(?:\\s[^"]*)?"[^<>]*>`, 'g');
  const out: { where: string; tag: string; titled: boolean }[] = [];
  const consider = (from: number, to: number) => {
    leafTag.lastIndex = from;
    for (let m = leafTag.exec(PAGE); m && m.index < to; m = leafTag.exec(PAGE)) {
      const tag = m[0];
      const idMatch = /\bid="([\w-]+)"/.exec(tag);
      if (idMatch) {
        // Static markup: the box is filled by script, by id.
        const id = idMatch[1];
        const writes = [...PAGE.matchAll(new RegExp(`\\$\\('${id}'\\)\\.textContent = ([^;]+);`, 'g'))];
        assert.ok(writes.length > 0, `#${id} (${selector}) is filled by script somewhere`);
        for (const w of writes) {
          out.push({ where: `#${id} ← ${w[1]}`, tag: w[0],
            titled: PAGE.includes(`$('${id}').title = ${w[1]};`) });
        }
      } else {
        out.push({ where: PAGE.slice(Math.max(0, m.index - 60), m.index).replace(/\s+/g, ' ').slice(-60), tag, titled: /\btitle="/.test(tag) });
      }
      if (container) return; // one box per container occurrence
    }
  };
  if (!container) {
    consider(0, PAGE.length);
    return out;
  }
  const opener = new RegExp(`class="${container}(?:[\\s"$])`, 'g');
  const starts = [...PAGE.matchAll(opener)].map((m) => m.index);
  starts.forEach((s, i) => {
    const before = out.length;
    consider(s, i + 1 < starts.length ? starts[i + 1] : Math.min(PAGE.length, s + 1600));
    // Every opener must yield its box: one this scan cannot see (another class
    // first, built with createElement, too far below) would otherwise be
    // skipped in silence rather than checked.
    assert.ok(out.length > before,
      `${selector}: the box under the container opened at "…${PAGE.slice(Math.max(0, s - 50), s + 30).replace(/\s+/g, ' ')}" is found`);
  });
  return out;
}

test('every tail-first box carries the whole path as its tooltip, since its head is cut off (D51)', () => {
  for (const sel of RTL_SELECTORS) {
    const sites = emissionsFor(sel);
    assert.ok(sites.length > 0, `${sel}: found where the app fills it`);
    for (const s of sites) {
      assert.ok(s.titled, `${sel} filled at "…${s.where}" has a title with the full path: ${s.tag}`);
    }
  }
});
