import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * B09 — right-click › "Why this reclaim score?" opened nothing with a real click.
 *
 * The entry's listener asks for the score and opens the panel when the promise
 * settles. With the score already loaded the promise is settled, so the browser
 * runs that continuation at the microtask checkpoint right after the entry's
 * listener — the panel opens — and THEN the same click bubbles to the
 * document's outside-click closer, which saw a click outside the panel and
 * closed it. A scripted `button.click()` runs microtasks only after the whole
 * dispatch, which is why the bug hid from script.
 *
 * So this test dispatches the way a person's click does: the target's listener,
 * a microtask checkpoint, then the document's bubbling listener — both
 * listeners lifted out of the built page, not restated here.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** The arrow function that starts at `anchor` (its `(` … `}`), brace-matched. */
function arrowAt(anchor: string, offsetInAnchor: number): string {
  const at = INDEX.indexOf(anchor);
  assert.notEqual(at, -1, `anchor exists: ${anchor.slice(0, 60)}`);
  assert.equal(INDEX.indexOf(anchor, at + 1), -1, `anchor is unique: ${anchor.slice(0, 60)}`);
  const start = at + offsetInAnchor;
  let depth = 0;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail('arrow function closes');
}

/* A few elements with the one query the listeners make of them: closest(). */
type El = { id: string; attrs: Record<string, string>; parent: El | null; hidden?: boolean; closest(sel: string): El | null };
function el(id: string, attrs: Record<string, string> = {}, parent: El | null = null): El {
  const self: El = {
    id, attrs, parent,
    closest(sel: string) {
      // Selector lists, compound #id / [attr="v"] / [attr], and the descendant combinator.
      const one = (e: El, comp: string) => (comp.match(/#[\w-]+|\[[^\]]+\]/g) || []).every((t) => {
        if (t.startsWith('#')) return e.id === t.slice(1);
        const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(t)!;
        return m[2] === undefined ? m[1] in e.attrs : e.attrs[m[1]] === m[2];
      });
      const matches = (e: El, s: string) => {
        const parts = s.trim().split(/\s+/);
        if (!one(e, parts[parts.length - 1])) return false;
        let cur: El | null = e;
        for (let i = parts.length - 2; i >= 0; i--) {
          cur = cur!.parent;
          while (cur && !one(cur, parts[i])) cur = cur.parent;
          if (!cur) return false;
        }
        return true;
      };
      for (let c: El | null = self; c; c = c.parent) if (sel.split(',').some((s) => matches(c!, s))) return c;
      return null;
    },
  };
  return self;
}

const XCODE = '/Applications/Xcode.app/Contents/Developer/Toolchains';
const KOTLIN = '/Applications/IntelliJ IDEA.app/Contents/plugins/Kotlin';

/**
 * The menu, the panel and both listeners. `loaded` are the paths whose score
 * is already in hand; any other path's score lands when `settle(path)` says.
 * `rightClick(path)` points the menu at a cell, as a right-click does.
 */
function harness({ loaded }: { loaded: string[] }) {
  const body = el('body');
  const ctxMenu = el('ctxMenu', {}, body);
  const list = el('', { class: 'ctx-list' }, ctxMenu);
  const scoreItem = el('', { 'data-act': 'score' }, list);
  const copyItem = el('', { 'data-act': 'copy' }, list);
  const pop = el('rcPopover', {}, body);
  pop.hidden = true;
  const elsewhere = el('tmCanvas', {}, body);
  const log: string[] = [];
  const pending = new Map<string, () => void>();
  const ensureScores = (paths: string[]) => (loaded.includes(paths[0])
    ? Promise.resolve()
    : new Promise<void>((r) => { pending.set(paths[0], r); }));
  const $ = (id: string) => (id === 'rcPopover' ? pop : id === 'ctxMenu' ? ctxMenu : null);
  const noop = () => {};
  // ctxTarget is the 115 part's `let`, reassigned by every right-click; one live object stands for it.
  let target = { path: XCODE };
  const ctxTarget = { get path() { return target.path; } };
  // The document's click listener in the reclaim-score part (the badge opener and outside-click closer),
  // with the panel's own `rcPopoverPath` and stand-ins for its open and close.
  const docSrc = arrowAt("document.addEventListener('click', (e) => {\n  const badge = e.target.closest('[data-rc-why]');", "document.addEventListener('click', ".length);
  const panel = new Function('$', 'ctxTarget', 'log', `'use strict';
    let rcPopoverPath = null;
    function openReclaimWhy(p) { $('rcPopover').hidden = false; rcPopoverPath = p; log.push('open ' + p); }
    function closeReclaimWhy() { if (!$('rcPopover').hidden) { $('rcPopover').hidden = true; rcPopoverPath = null; log.push('close'); } }
    return { onDocClick: (${docSrc}), openReclaimWhy };`)($, ctxTarget, log) as { onDocClick: (e: unknown) => void; openReclaimWhy: (p: string) => void };
  // The menu entry's listener, with `b` the entry it was bound to.
  const entryAnchor = "menu.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {\n    const act = b.dataset.act;";
  const entrySrc = arrowAt(entryAnchor, "menu.querySelectorAll('button').forEach(b => b.addEventListener('click', ".length);
  const entryFor = (b: El) => new Function('b', 'ctxTarget', 'x', 'y', 'hideCtxMenu', 'ctxMenuFocusOpener', 'ensureScores', 'openReclaimWhy',
    'openInOS', 'openPreview', 'copyPath', 'openTerminal', 'cartToggle', 'startOffloadFlow', 'openBudgetDialog', 'removeBudget', 'openNoteDialog', 'confirmTrash',
    `return (${entrySrc});`)(
    { dataset: { act: b.attrs['data-act'] } }, ctxTarget, 300, 200,
    () => null, noop, ensureScores, panel.openReclaimWhy, noop, noop, (p: string) => log.push(`copy ${p}`), noop, noop, noop, noop, noop, noop, noop,
  ) as () => void;
  /** A trusted click: the target's listener, the microtask checkpoint, then the bubble to the document. */
  async function realClick(t: El, ownListener: (() => void) | null) {
    const e = { target: t, preventDefault: noop, stopPropagation: noop };
    if (ownListener) ownListener();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    panel.onDocClick(e);
  }
  async function settle(path: string) {
    pending.get(path)!();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
  return { pop, log, scoreItem, copyItem, elsewhere, entryFor, realClick, settle, rightClick: (path: string) => { target = { path }; } };
}

test('a real click on "Why this reclaim score?" opens the breakdown and leaves it open (score already loaded)', async () => {
  const h = harness({ loaded: [XCODE] });
  await h.realClick(h.scoreItem, h.entryFor(h.scoreItem));
  assert.deepEqual(h.log, [`open ${XCODE}`], 'the panel opened once and nothing closed it');
  assert.equal(h.pop.hidden, false, 'the breakdown is showing after the click has finished');
});

test('the same, when the score lands after the click', async () => {
  const h = harness({ loaded: [] });
  await h.realClick(h.scoreItem, h.entryFor(h.scoreItem));
  assert.equal(h.pop.hidden, true, 'nothing to show until the score lands');
  await h.settle(XCODE);
  assert.equal(h.pop.hidden, false, 'the breakdown opens when the score lands');
});

test('a click anywhere else — another menu entry included — still closes the breakdown', async () => {
  const h = harness({ loaded: [XCODE] });
  await h.realClick(h.scoreItem, h.entryFor(h.scoreItem));
  assert.equal(h.pop.hidden, false);
  await h.realClick(h.elsewhere, null);
  assert.equal(h.pop.hidden, true, 'a click outside the panel closes it');
  await h.realClick(h.scoreItem, h.entryFor(h.scoreItem));
  assert.equal(h.pop.hidden, false);
  await h.realClick(h.copyItem, h.entryFor(h.copyItem));
  assert.equal(h.pop.hidden, true, 'a different menu entry is a click outside the panel');
  assert.equal(h.log.filter((l) => l === 'close').length, 2);
});

test('asking about another cell closes the breakdown still showing the last one, and opens the new one when its score lands', async () => {
  // Kept open only when the panel shows the cell the menu was opened on: a
  // panel still showing another path is a click outside it, as before.
  const h = harness({ loaded: [XCODE] });
  await h.realClick(h.scoreItem, h.entryFor(h.scoreItem));
  assert.deepEqual(h.log, [`open ${XCODE}`]);
  h.rightClick(KOTLIN);
  await h.realClick(h.scoreItem, h.entryFor(h.scoreItem));
  assert.deepEqual(h.log, [`open ${XCODE}`, 'close'], 'Xcode\'s breakdown does not stand while Kotlin\'s is asked for');
  await h.settle(KOTLIN);
  assert.deepEqual(h.log, [`open ${XCODE}`, 'close', `open ${KOTLIN}`], 'and Kotlin\'s opens when its score lands');
});
