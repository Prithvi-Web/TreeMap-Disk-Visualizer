import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Polish round — keyboard and dialogs (a11y-keyboard-1, -2, -4, -6, -7, -8).
 *
 * Every dialog takes focus when it opens, traps Tab, and gives focus back
 * when it closes; while one is up, the views underneath are inert and the
 * global shortcuts do not reach them; Escape closes the topmost layer first.
 * Segmented controls are real tab lists: role=tab children, one Tab stop,
 * arrow keys to move. The cart drawer and the preview pane are keyboard
 * surfaces too. Behaviour is EXECUTED out of the built page against a small
 * fake DOM; the call-site pairings are containment checks on brace-matched
 * blocks — never on a comment.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function braced(openAnchor: string, from = 0): string {
  const start = INDEX.indexOf(openAnchor, from);
  assert.notEqual(start, -1, `block "${openAnchor}" exists in index.html`);
  // Walk past the parameter list first: a destructured default is a brace,
  // and `function cartDockToggle(open, { focus = false } = {})` otherwise
  // "closed" on its own signature and the body was never extracted.
  let p = INDEX.indexOf('(', start), paren = 0;
  for (; p < INDEX.length; p++) {
    if (INDEX[p] === '(') paren++;
    else if (INDEX[p] === ')' && --paren === 0) break;
  }
  let depth = 0;
  for (let i = INDEX.indexOf('{', p); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`block "${openAnchor}" never closes`);
}

function slice(a: string, b: string): string {
  const i = INDEX.indexOf(a);
  assert.notEqual(i, -1, `anchor "${a}" exists`);
  const j = INDEX.indexOf(b, i + a.length);
  assert.notEqual(j, -1, `anchor "${b}" follows`);
  return INDEX.slice(i, j);
}

/* ══════════════ A small DOM: enough selector engine for the dialog code ══════════════ */

type FEl = {
  id: string; tag: string; cls: Set<string>; attrs: Record<string, string>; children: FEl[]; parent: FEl | null;
  hidden: boolean; disabled: boolean; inert: boolean; tabIndex: number; shown: boolean;
  textContent: string; innerHTML: string; dataset: Record<string, string>; style: Record<string, string>;
  clicks: number; focused: number;
  classList: { contains(c: string): boolean; add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): boolean };
  contains(n: FEl | null): boolean; closest(sel: string): FEl | null; matches(sel: string): boolean;
  querySelector(sel: string): FEl | null; querySelectorAll(sel: string): FEl[];
  getAttribute(k: string): string | null; setAttribute(k: string, v: string): void; removeAttribute(k: string): void; hasAttribute(k: string): boolean;
  focus(): void; click(): void; getClientRects(): { length: number }; addEventListener(): void;
  /** Set false for an element removed from the page; unset reads as in the page, as the page's own `!== false` checks do. */
  isConnected?: boolean;
};

type FDoc = {
  activeElement: FEl | null; body: FEl; root: FEl;
  querySelectorAll(sel: string): FEl[]; querySelector(sel: string): FEl | null; getElementById(id: string): FEl | null;
  addEventListener(): void;
};

/**
 * An element's computed `visibility`: the nearest one set on it or a parent
 * (`style.visibility`), as CSS inherits it — `visible` when none is.
 */
function computedVisibility(el: FEl): string {
  for (let c: FEl | null = el; c; c = c.parent) if (c.style.visibility) return c.style.visibility;
  return 'visible';
}

function makeDoc(): FDoc {
  const doc: FDoc = {} as FDoc;
  const matchCompound = (el: FEl, comp: string): boolean => {
    const tokens = comp.match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|^[a-z]+/g) || [];
    return tokens.every((t) => {
      if (t.startsWith('#')) return el.id === t.slice(1);
      if (t.startsWith('.')) return el.cls.has(t.slice(1));
      if (t.startsWith('[')) {
        const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(t)!;
        if (m[1] === 'hidden') return el.hidden;
        if (m[1] === 'tabindex') return m[2] === undefined ? 'tabindex' in el.attrs : el.attrs.tabindex === m[2];
        return m[2] === undefined ? m[1] in el.attrs : el.attrs[m[1]] === m[2];
      }
      return el.tag === t;
    });
  };
  const matches = (el: FEl, selector: string): boolean => selector.split(',').some((sel) => {
    const parts = sel.trim().split(/\s+/);
    let cur: FEl | null = el;
    if (!matchCompound(cur, parts[parts.length - 1])) return false;
    for (let i = parts.length - 2; i >= 0; i--) {
      cur = cur!.parent;
      while (cur && !matchCompound(cur, parts[i])) cur = cur.parent;
      if (!cur) return false;
    }
    return true;
  });
  const walk = (n: FEl, out: FEl[]) => { for (const c of n.children) { out.push(c); walk(c, out); } return out; };
  const mk = (tag: string, id = '', cls: string[] = [], attrs: Record<string, string> = {}): FEl => {
    const el: FEl = {
      id, tag, cls: new Set(cls), attrs: { ...attrs }, children: [], parent: null,
      hidden: false, disabled: false, inert: false, tabIndex: /^(button|input|select|textarea|a)$/.test(tag) ? 0 : -1, shown: true,
      textContent: '', innerHTML: '', dataset: {}, style: {}, clicks: 0, focused: 0,
      classList: {
        contains: (c) => el.cls.has(c),
        add: (c) => { el.cls.add(c); },
        remove: (c) => { el.cls.delete(c); },
        toggle: (c, on) => { const next = on === undefined ? !el.cls.has(c) : on; if (next) el.cls.add(c); else el.cls.delete(c); return next; },
      },
      contains: (n) => { let c: FEl | null = n; while (c) { if (c === el) return true; c = c.parent; } return false; },
      closest: (sel) => { let c: FEl | null = el; while (c) { if (matches(c, sel)) return c; c = c.parent; } return null; },
      matches: (sel) => matches(el, sel),
      querySelector: (sel) => walk(el, []).find((c) => matches(c, sel)) || null,
      querySelectorAll: (sel) => walk(el, []).filter((c) => matches(c, sel)),
      getAttribute: (k) => (k === 'tabindex' && 'tabindex' in el.attrs ? el.attrs.tabindex : (k in el.attrs ? el.attrs[k] : null)),
      setAttribute: (k, v) => { el.attrs[k] = v; if (k === 'tabindex') el.tabIndex = Number(v); },
      removeAttribute: (k) => { delete el.attrs[k]; },
      hasAttribute: (k) => k in el.attrs,
      focus: () => {
        // A hidden or inert element cannot take focus — the browser's rule —
        // nor one hidden by visibility, though it keeps its box.
        if (computedVisibility(el) !== 'visible') return;
        let c: FEl | null = el;
        while (c) { if (c.hidden || !c.shown || c.inert) return; c = c.parent; }
        el.focused++; doc.activeElement = el;
      },
      click: () => { el.clicks++; },
      getClientRects: () => { let c: FEl | null = el; while (c) { if (c.hidden || !c.shown) return { length: 0 }; c = c.parent; } return { length: 1 }; },
      addEventListener: () => {},
    };
    if ('tabindex' in attrs) el.tabIndex = Number(attrs.tabindex);
    return el;
  };
  const root = mk('html');
  const body = mk('body');
  root.children.push(body); body.parent = root;
  doc.root = root; doc.body = body; doc.activeElement = body;
  doc.querySelectorAll = (sel) => walk(root, []).filter((c) => matches(c, sel));
  doc.querySelector = (sel) => walk(root, []).find((c) => matches(c, sel)) || null;
  doc.getElementById = (id) => walk(root, []).find((c) => c.id === id) || null;
  doc.addEventListener = () => {};
  (doc as unknown as { mk: typeof mk }).mk = mk;
  return doc;
}

function append(parent: FEl, child: FEl): FEl { parent.children.push(child); child.parent = parent; return child; }
function mkOf(doc: FDoc): (tag: string, id?: string, cls?: string[], attrs?: Record<string, string>) => FEl {
  return (doc as unknown as { mk: (t: string, i?: string, c?: string[], a?: Record<string, string>) => FEl }).mk;
}

/** The page: a main with a button, a sidebar, the cart dock, and two dialogs. */
function pageWith(doc: FDoc) {
  const mk = mkOf(doc);
  const main = append(doc.body, mk('main'));
  const pageBtn = append(main, mk('button', 'scanBtn'));
  const side = append(doc.body, mk('aside', 'sideNav'));
  const cart = append(doc.body, mk('div', 'cartDock'));
  const toasts = append(doc.body, mk('div', 'toasts'));
  const confirm = append(doc.body, mk('div', 'confirmModal', ['modal-backdrop']));
  const confirmDlg = append(confirm, mk('div', '', ['modal']));
  const confirmClose = append(append(confirmDlg, mk('div', '', ['modal-head'])), mk('button', 'confirmClose', ['close-x']));
  const confirmFoot = append(confirmDlg, mk('div', '', ['modal-foot']));
  const cancel = append(confirmFoot, mk('button', 'confirmCancel', ['btn'], { 'data-close': 'confirmModal' }));
  const ok = append(confirmFoot, mk('button', 'confirmOk', ['btn', 'btn-danger']));
  const settings = append(doc.body, mk('div', 'settingsModal', ['modal-backdrop']));
  const settingsDlg = append(settings, mk('div', '', ['modal']));
  const settingsInput = append(append(settingsDlg, mk('div', '', ['modal-body'])), mk('input', 'forecastDays'));
  const settingsSave = append(append(settingsDlg, mk('div', '', ['modal-foot'])), mk('button', 'settingsSaveBtn', ['btn', 'btn-primary']));
  // Closed backdrops do not paint.
  confirm.shown = false; settings.shown = false;
  return { main, pageBtn, side, cart, toasts, confirm, confirmDlg, confirmClose, cancel, ok, settings, settingsDlg, settingsInput, settingsSave };
}

type ModalApi = {
  openModals: () => FEl[]; topModal: () => FEl | null; modalFocusTarget: (b: FEl) => FEl;
  modalFocusables: (root: FEl) => FEl[]; syncModalLayers: () => void; modalOpened: (el: FEl) => void; modalClosed: (el: FEl) => void;
  modalTrapTab: (e: { shiftKey: boolean; preventDefault: () => void }, top: FEl) => void; noteFocus: (el: FEl) => void;
  inModalOverlay: (node: FEl | null) => boolean; modalFocusInto: (backdrop: FEl) => void;
  /** How many focus moves the net remembers (D05). */
  FOCUS_TRAIL_MAX: number;
};

function loadModalNet(doc: FDoc, toastsRetire: (sheet: string) => void = () => {}): ModalApi {
  const src = slice('/* ── Focus discipline for every dialog ── */', '/* ── end focus discipline ── */');
  const $ = (id: string) => doc.getElementById(id);
  // The net installs a MutationObserver so that adding `.open` at any of the
  // thirty-two call sites is enough. Node has no DOM, and these tests drive
  // the reactions directly (setOpen calls modalOpened/modalClosed), so the
  // observer only has to exist without throwing at eval time.
  class FakeObserver { observe() { /* the tests call the reactions themselves */ } disconnect() {} }
  // toastsRetire (the toast family's, in 015) is what a closing sheet asks to
  // retire the offers made in it; a test that cares records the calls.
  return new Function('document', '$', 'MutationObserver', 'toastsRetire', 'getComputedStyle',
    `'use strict'; ${src}
     return { openModals, topModal, modalFocusTarget, modalFocusables, syncModalLayers, modalOpened, modalClosed, modalTrapTab, noteFocus,
       inModalOverlay, modalFocusInto, FOCUS_TRAIL_MAX };`,
  )(doc, $, FakeObserver, toastsRetire, (el: FEl) => ({ visibility: computedVisibility(el) })) as ModalApi;
}

/** Open or close a backdrop the way every caller does — by class — then run the net's reaction. */
function setOpen(api: ModalApi, el: FEl, open: boolean) {
  el.classList.toggle('open', open); el.shown = open;
  if (open) api.modalOpened(el); else api.modalClosed(el);
  api.syncModalLayers();
}

/* ══════════════ a11y-keyboard-1 — every dialog takes, traps and returns focus ══════════════ */

test('opening a dialog moves focus into it: a confirmation lands on its Cancel, a form on its first field — never on the button that commits or destroys (C01)', () => {
  // QA re-check C01: focus used to land on the footer's primary or danger
  // button ("so Enter confirms a Trash sheet"), so an Enter pressed out of
  // habit saved the Autopilot policy the editor had just opened on. A sheet
  // opens on its first field or a safe control now.
  const doc = makeDoc();
  const p = pageWith(doc);
  const api = loadModalNet(doc);
  setOpen(api, p.settings, true);
  assert.equal(doc.activeElement, p.settingsInput, 'a sheet with a field opens on it, not on Save');
  doc.activeElement = doc.body;
  setOpen(api, p.settings, false);
  p.pageBtn.focus(); api.noteFocus(p.pageBtn);
  setOpen(api, p.confirm, true);
  assert.equal(doc.activeElement, p.cancel, 'a confirmation opens on Cancel, so Enter on arrival trashes nothing');
  assert.equal(p.main.inert, true, 'the page behind is inert');
  assert.equal(p.side.inert, true, 'the sidebar too');
  assert.equal(p.cart.inert, true, 'and the cart dock');
  assert.equal(p.toasts.inert, false, 'toasts stay live — they are how the app talks back');
  assert.equal(p.confirm.inert, false, 'the open dialog itself is not inert');
});

test('closing a dialog gives focus back to where it came from and lifts inert', () => {
  const doc = makeDoc();
  const p = pageWith(doc);
  const api = loadModalNet(doc);
  p.pageBtn.focus(); api.noteFocus(p.pageBtn);
  setOpen(api, p.confirm, true);
  assert.equal(doc.activeElement, p.cancel);
  // The browser drops focus to <body> when the focused button stops painting.
  doc.activeElement = doc.body;
  setOpen(api, p.confirm, false);
  assert.equal(doc.activeElement, p.pageBtn, 'focus returns to the control that opened the sheet');
  assert.equal(p.main.inert, false, 'inert is lifted with the last dialog');
  assert.equal(p.side.inert, false);
});

test('a sheet that focuses itself as it opens still gives focus back to the control that opened it — the duplicate viewer\'s Compare button (QA third pass D05)', () => {
  // openDupeViewer adds `.open` and focuses its dialog in the same breath;
  // the net's observer runs modalOpened a microtask later, when the last
  // focus it knows of is already inside the sheet. It kept nothing to return
  // to, and Escape or × left focus on <body>.
  const doc = makeDoc();
  const p = pageWith(doc);
  const api = loadModalNet(doc);
  p.pageBtn.focus(); api.noteFocus(p.pageBtn); // the Compare button, pressed with Enter
  p.confirm.classList.add('open'); p.confirm.shown = true;
  p.confirmDlg.setAttribute('tabindex', '-1');
  p.confirmDlg.focus(); api.noteFocus(p.confirmDlg); // the sheet focuses itself: focusin fires at once
  api.modalOpened(p.confirm); api.syncModalLayers(); // then the observer
  assert.equal(doc.activeElement, p.confirmDlg, 'control: the net leaves alone the focus the sheet placed');
  doc.activeElement = doc.body; // Escape: the sheet stops painting
  setOpen(api, p.confirm, false);
  assert.equal(doc.activeElement, p.pageBtn, 'focus is back on the button that opened the sheet, not on <body>');

  // Stacked: a sheet opened from inside another, focusing itself, returns into the one below.
  setOpen(api, p.settings, true);
  p.settingsSave.focus(); api.noteFocus(p.settingsSave);
  p.confirm.classList.add('open'); p.confirm.shown = true;
  p.confirmDlg.focus(); api.noteFocus(p.confirmDlg);
  api.modalOpened(p.confirm); api.syncModalLayers();
  doc.activeElement = doc.body;
  setOpen(api, p.confirm, false);
  assert.equal(doc.activeElement, p.settingsSave, 'into the sheet it was opened from');
});

/** The confirmation sheet opening on itself, as the duplicate viewer does: `.open`, then its own focus, then the net's observer. */
function openFocusingItself(api: ModalApi, p: ReturnType<typeof pageWith>, insideMoves = 1) {
  p.confirm.classList.add('open'); p.confirm.shown = true;
  p.confirmDlg.setAttribute('tabindex', '-1');
  for (let i = 0; i < insideMoves; i++) { p.confirmDlg.focus(); api.noteFocus(p.confirmDlg); }
  api.modalOpened(p.confirm); api.syncModalLayers();
}

test('the focus trail skips a control removed from the page, and keeps a few moves, not every one (review F1.7 of QA third pass D05)', () => {
  // The newest focus outside the sheet was a row re-rendered away since: the
  // sheet gives focus back to the newest control still in the page.
  const doc = makeDoc();
  const p = pageWith(doc);
  const api = loadModalNet(doc);
  const row = append(p.main, mkOf(doc)('button', 'dupeRow'));
  p.pageBtn.focus(); api.noteFocus(p.pageBtn);
  row.focus(); api.noteFocus(row);
  p.main.children.splice(p.main.children.indexOf(row), 1); row.parent = null; row.isConnected = false;
  openFocusingItself(api, p);
  doc.activeElement = doc.body; // Escape: the sheet stops painting
  setOpen(api, p.confirm, false);
  assert.equal(doc.activeElement, p.pageBtn, 'focus is back on the newest control still in the page, not lost on the one removed');

  // Bounded: the trail holds the page's FOCUS_TRAIL_MAX moves. An opener with
  // fewer than that inside the sheet after it is still found…
  const max = api.FOCUS_TRAIL_MAX;
  /** A page of its own, so each trail starts empty. */
  const fresh = () => { const d = makeDoc(); const q = pageWith(d); return { d, q, a: loadModalNet(d) }; };
  const within = fresh();
  within.q.pageBtn.focus(); within.a.noteFocus(within.q.pageBtn);
  openFocusingItself(within.a, within.q, max - 1);
  within.d.activeElement = within.d.body;
  setOpen(within.a, within.q.confirm, false);
  assert.equal(within.d.activeElement, within.q.pageBtn, `${max - 1} moves inside the sheet: the opener is still remembered`);
  // …and one more pushes it out: the trail does not grow with every focus the page ever saw.
  const past = fresh();
  past.q.pageBtn.focus(); past.a.noteFocus(past.q.pageBtn);
  openFocusingItself(past.a, past.q, max);
  past.d.activeElement = past.d.body;
  setOpen(past.a, past.q.confirm, false);
  assert.notEqual(past.d.activeElement, past.q.pageBtn, `${max} moves inside the sheet: the opener has left the trail, which holds ${max} and no more`);
});

test('a dialog with no field and no Cancel focuses the sheet itself, and Tab cycles inside it', () => {
  const doc = makeDoc();
  const p = pageWith(doc);
  const api = loadModalNet(doc);
  p.settingsSave.disabled = true; // nothing to confirm yet
  p.settingsInput.shown = false; // and no field to land on: a progress sheet, the Trash, the shortcuts
  setOpen(api, p.settings, true);
  assert.equal(doc.activeElement, p.settingsDlg, 'the sheet takes focus when it has no field and no Cancel — never its Save');
  assert.equal(p.settingsDlg.getAttribute('tabindex'), '-1', 'and it was made focusable without joining the Tab order');
  p.settingsInput.shown = true;
  const f = api.modalFocusables(p.settings);
  assert.deepEqual(f.map((e) => e.id), ['forecastDays'], 'the disabled Save is not a Tab stop');
  // Tab from the last focusable wraps to the first; Shift+Tab from the first wraps to the last.
  p.settingsSave.disabled = false;
  const stops = api.modalFocusables(p.settings).map((e) => e.id);
  assert.deepEqual(stops, ['forecastDays', 'settingsSaveBtn']);
  p.settingsSave.focus();
  let prevented = 0;
  api.modalTrapTab({ shiftKey: false, preventDefault: () => { prevented++; } }, p.settings);
  assert.equal(doc.activeElement, p.settingsInput, 'Tab past the last stop wraps to the first');
  api.modalTrapTab({ shiftKey: true, preventDefault: () => { prevented++; } }, p.settings);
  assert.equal(doc.activeElement, p.settingsSave, 'Shift+Tab before the first wraps to the last');
  assert.equal(prevented, 2, 'both wraps were the trap, not the browser');
});

test('a control hidden by visibility is no Tab stop: the trap wraps past it to the last control a keyboard can land on (review F2.1)', () => {
  // modalFocusables counted every enabled control with a box. One hidden by
  // `visibility` keeps its box but cannot take focus — the selection bar's
  // buttons with nothing selected (QA D02) — so a wrap that chose one, or an
  // offer that handed focus to one, left focus where it was or on <body>.
  const doc = makeDoc();
  const p = pageWith(doc);
  const api = loadModalNet(doc);
  const extra = append(p.settingsSave.parent!, mkOf(doc)('span', 'settingsMore'));
  append(extra, mkOf(doc)('button', 'settingsMoreBtn'));
  extra.style.visibility = 'hidden'; // its button inherits it, as a browser computes it
  setOpen(api, p.settings, true);
  assert.deepEqual(api.modalFocusables(p.settings).map((e) => e.id), ['forecastDays', 'settingsSaveBtn'],
    'a control hidden by its parent\'s visibility is no stop');
  p.settingsInput.focus();
  let prevented = 0;
  api.modalTrapTab({ shiftKey: true, preventDefault: () => { prevented++; } }, p.settings);
  assert.equal(doc.activeElement, p.settingsSave, 'Shift+Tab before the first wraps to the last control a keyboard can land on');
  assert.equal(prevented, 1, 'control: the wrap was the trap\'s');
  extra.style.visibility = 'visible';
  assert.deepEqual(api.modalFocusables(p.settings).map((e) => e.id), ['forecastDays', 'settingsSaveBtn', 'settingsMoreBtn'],
    'control: shown, it is a stop again');
});

test('stacked dialogs: the lower sheet goes inert and focus returns to it, not the page', () => {
  const doc = makeDoc();
  const p = pageWith(doc);
  const api = loadModalNet(doc);
  p.pageBtn.focus(); api.noteFocus(p.pageBtn);
  setOpen(api, p.settings, true);
  assert.equal(doc.activeElement, p.settingsInput);
  p.settingsSave.focus(); api.noteFocus(p.settingsSave); // Save opens a confirmation
  setOpen(api, p.confirm, true);
  assert.equal(api.topModal(), p.confirm, 'the later sheet is on top');
  assert.equal(p.settings.inert, true, 'the sheet underneath cannot be tabbed into');
  assert.equal(doc.activeElement, p.cancel);
  doc.activeElement = doc.body;
  setOpen(api, p.confirm, false);
  assert.equal(p.settings.inert, false, 'the lower sheet is live again');
  assert.equal(doc.activeElement, p.settingsSave, 'and focus went back into it');
  assert.equal(p.main.inert, true, 'the page stays inert while any sheet is up');
});

test('a close that already placed focus elsewhere is left alone — the palette hands off to its action', () => {
  const doc = makeDoc();
  const p = pageWith(doc);
  const api = loadModalNet(doc);
  p.pageBtn.focus(); api.noteFocus(p.pageBtn);
  setOpen(api, p.confirm, true);
  // The action that closed the sheet moved focus itself (cmdkRun → summonGlobalSearch).
  const search = append(p.side, mkOf(doc)('input', 'gsearch'));
  p.confirm.classList.remove('open'); p.confirm.shown = false; p.confirm.inert = false;
  p.side.inert = false; search.focus();
  api.modalClosed(p.confirm); api.syncModalLayers();
  assert.equal(doc.activeElement, search, 'the net does not yank focus back from where the action put it');
});

test('closing a sheet whose offer holds focus gives focus back to where the sheet was opened from, and the offers made in it go with it (final review F2.2, F2.3)', () => {
  // An offer made in answer to a press in a sheet takes focus (offerMeant),
  // and #toasts is exempt from inert. Escape closed the sheet with focus on
  // the offer's button — neither <body> nor inside the sheet — so the net
  // treated focus as placed by the close and never gave it back.
  const doc = makeDoc();
  const p = pageWith(doc);
  const retired: string[] = [];
  const api = loadModalNet(doc, (sheet) => { retired.push(sheet); });
  const offer = append(p.toasts, mkOf(doc)('button', 'offerBtn'));
  p.pageBtn.focus(); api.noteFocus(p.pageBtn);
  setOpen(api, p.settings, true);
  assert.equal(doc.activeElement, p.settingsInput, 'control: the sheet took focus');
  p.settingsSave.focus(); api.noteFocus(p.settingsSave);
  offer.focus(); api.noteFocus(offer); // Save made an offer, which took focus
  assert.equal(doc.activeElement, offer, 'control: the offer holds focus with the sheet open');
  setOpen(api, p.settings, false); // Escape
  assert.equal(doc.activeElement, p.pageBtn, 'focus goes back to the control that opened the sheet, not left on an offer for a sheet that is gone');
  assert.deepEqual(retired, ['settingsModal'], 'and the offers made in the sheet go with it');

  // Stacked: the top sheet's offer holds focus as it closes — focus goes back
  // to the control in the sheet underneath that opened it (not merely into
  // that sheet's primary button), and only the closing sheet's offers go.
  setOpen(api, p.settings, true);
  p.settingsInput.focus(); api.noteFocus(p.settingsInput);
  setOpen(api, p.confirm, true);
  assert.equal(doc.activeElement, p.cancel, 'control: the top sheet took focus');
  offer.focus(); api.noteFocus(offer);
  setOpen(api, p.confirm, false);
  assert.equal(doc.activeElement, p.settingsInput, 'focus goes back to the control in the sheet underneath that opened the top sheet');
  assert.deepEqual(retired, ['settingsModal', 'confirmModal'], 'and only the top sheet\'s offers go');
});

test('a close that placed focus elsewhere still takes the offers made in the sheet with it, and leaves focus where the close put it (final review F3.2)', () => {
  // Only giving focus back depends on where the close left it; the offers go
  // on every close. Above, focus is on the offer as the sheet closes, so an
  // offer retired only when focus drifted could not be told apart. An action
  // that closes the sheet and puts focus elsewhere (the palette's search box)
  // would leave the sheet's offer live for 12 s, its choice acting for a
  // sheet that is gone (F2.3).
  const doc = makeDoc();
  const p = pageWith(doc);
  const retired: string[] = [];
  const api = loadModalNet(doc, (sheet) => { retired.push(sheet); });
  p.pageBtn.focus(); api.noteFocus(p.pageBtn);
  setOpen(api, p.confirm, true);
  // The action that closed the sheet moved focus itself (cmdkRun → summonGlobalSearch).
  const search = append(p.side, mkOf(doc)('input', 'gsearch'));
  p.confirm.classList.remove('open'); p.confirm.shown = false; p.confirm.inert = false;
  p.side.inert = false; search.focus();
  api.modalClosed(p.confirm); api.syncModalLayers();
  assert.equal(doc.activeElement, search, 'control: focus stays where the action put it — this close did not leave it adrift');
  assert.deepEqual(retired, ['confirmModal'], 'and the offers made in the sheet go with it all the same');
});

test('every backdrop is wired into the net, and the close funnel is untouched', () => {
  const net = slice('/* ── Focus discipline for every dialog ── */', '/* ── end focus discipline ── */');
  assert.match(net, /new MutationObserver\(/, 'the net observes class flips, so no caller has to change');
  assert.match(net, /querySelectorAll\('\.modal-backdrop'\)\.forEach\(\(el\) =>\s*\n?\s*\w+\.observe\(el, \{ attributes: true, attributeFilter: \['class'\]/,
    'every .modal-backdrop is observed for its class attribute');
  assert.match(net, /\.inert = /, 'inert is the mechanism, not a focusin loop alone');
  assert.match(braced('function closeModal('), /classList\.remove\('open'\)/, 'closeModal still just removes the class — the net does the rest');
});

/**
 * The shipped page's <body>, as a tree of fake elements: tag, id, classes,
 * attributes and nesting, read from the markup itself. Comments are skipped,
 * raw-text elements (script, style, textarea, title) are leaves, void and
 * self-closed elements take no children, and a close tag that does not match
 * the open one fails here rather than quietly re-parenting everything after it.
 */
function pageFromMarkup(doc: FDoc): FEl {
  const mk = mkOf(doc);
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const RAW = new Set(['script', 'style', 'textarea', 'title']);
  const at = INDEX.indexOf('<body');
  assert.notEqual(at, -1, 'the page has a <body>');
  let i = INDEX.indexOf('>', at) + 1;
  const stack: FEl[] = [doc.body];
  while (i < INDEX.length) {
    const lt = INDEX.indexOf('<', i);
    if (lt === -1) break;
    if (INDEX.startsWith('<!--', lt)) { i = INDEX.indexOf('-->', lt) + 3; continue; }
    if (INDEX[lt + 1] === '/') {
      const gt = INDEX.indexOf('>', lt);
      const name = INDEX.slice(lt + 2, gt).trim().toLowerCase();
      i = gt + 1;
      if (name === 'body') break;
      const top = stack.pop()!;
      assert.equal(top.tag, name, `</${name}> closes the <${top.tag}${top.id ? ` id=${top.id}` : ''}> it should`);
      continue;
    }
    const m = /^<([a-zA-Z][\w-]*)/.exec(INDEX.slice(lt, lt + 40));
    if (!m) { i = lt + 1; continue; }
    let j = lt + m[0].length;
    let q = '';
    for (; j < INDEX.length; j++) {
      const c = INDEX[j];
      if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break;
    }
    const tag = m[1].toLowerCase();
    const attrs: Record<string, string> = {};
    const re = /([\w:@.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    const rest = INDEX.slice(lt + m[0].length, j);
    for (let a = re.exec(rest); a; a = re.exec(rest)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    const { id = '', class: cls = '', ...others } = attrs;
    const el = append(stack[stack.length - 1], mk(tag, id, cls.split(/\s+/).filter(Boolean), others));
    if ('hidden' in attrs) el.hidden = true;
    if ('disabled' in attrs) el.disabled = true;
    if (el.cls.has('modal-backdrop')) el.shown = false; // a closed sheet does not paint
    i = j + 1;
    if (RAW.has(tag)) { i = INDEX.indexOf('>', INDEX.toLowerCase().indexOf(`</${tag}`, i)) + 1; continue; }
    if (!VOID.has(tag) && !INDEX.slice(lt, j + 1).endsWith('/>')) stack.push(el);
  }
  assert.deepEqual(stack.map((e) => e.tag), ['body'], 'every element the body opens, it closes');
  return doc.body;
}

/* B31 — the Autopilot policy sheet lived inside <main>, and the net makes
   every direct child of <body> that is not a sheet inert while one is open:
   so opening it made its own ancestor inert, and nothing in it could be
   clicked, typed into or focused. This drives the real net over the real
   markup, every sheet in turn. */
test('every dialog in the shipped page is live when it opens: no inert ancestor, and it takes focus', () => {
  const doc = makeDoc();
  pageFromMarkup(doc);
  const api = loadModalNet(doc);
  const sheets = doc.querySelectorAll('.modal-backdrop');
  const ids = sheets.map((s) => s.id);
  for (const id of ['apModal', 'cleanModal', 'confirmModal', 'settingsModal', 'budgetModal', 'offloadModal'])
    assert.ok(ids.includes(id), `#${id} is one of the sheets checked`);
  const page = doc.querySelector('main');
  assert.ok(page, 'the page has a <main> for the net to make inert');
  for (const sheet of sheets) {
    setOpen(api, sheet, true);
    assert.equal(page!.inert, true, `#${sheet.id} open: the page behind it is inert`);
    const deadAncestor = (() => { for (let c: FEl | null = sheet; c; c = c.parent) if (c.inert) return c; return null; })();
    assert.ok(!deadAncestor,
      `#${sheet.id} open: nothing it sits in is inert (it sits in <${deadAncestor?.tag}${deadAncestor?.id ? ` id=${deadAncestor.id}` : ''}>)`);
    assert.ok(sheet.contains(doc.activeElement), `#${sheet.id} open: focus moved into it (it is on <${doc.activeElement?.tag} id=${doc.activeElement?.id}>)`);
    doc.activeElement = doc.body;
    setOpen(api, sheet, false);
    assert.equal(page!.inert, false, `#${sheet.id} closed: the page is live again`);
  }
  // The fields the B31 report could not reach, by name.
  const ap = doc.getElementById('apModal')!;
  setOpen(api, ap, true);
  for (const id of ['apName', 'apPath', 'apPreviewBtn', 'apSaveBtn']) {
    const el = doc.getElementById(id)!;
    assert.ok(ap.contains(el), `#${id} is in the Autopilot sheet`);
    el.focus();
    assert.ok(doc.activeElement === el, `#${id} takes focus while the Autopilot sheet is open`);
  }
});

/**
 * Where an arrow key moves a choice, as the browser does it: on a radio, to
 * the next radio of its name — checking it, which fires its change — and on
 * anything else, nowhere. Native, so modelled (review F1.4).
 */
function arrowPicks(doc: FDoc, at: FEl): FEl | null {
  const radio = (el: FEl) => el.tag === 'input' && el.attrs.type === 'radio';
  if (!radio(at)) return null;
  const group = doc.querySelectorAll('input').filter((r) => radio(r) && r.attrs.name === at.attrs.name);
  return group[(group.indexOf(at) + 1) % group.length];
}

/** The radio groups the page says save the moment one is picked: the id of each group its "saves it straight away" line introduces. */
const SAVED_ON_PICK = [...INDEX.matchAll(/saves it straight away[^<]*<\/div>\s*<div id="([\w-]+)" role="radiogroup"/g)].map((m) => m[1]);

test('every sheet in the shipped page opens on its first field or a safe control — never on a button that commits or destroys (C01)', () => {
  // QA re-check C01: the Autopilot editor opened on "Save policy", so Enter
  // saved at once; the Trash sheet opened on "Empty Trash…". Every sheet is
  // opened here from the page's own markup and the net's own rules.
  // Nor on a choice that saves the moment it changes (review F1.4): Settings
  // opened on its Theme radios, and an arrow key — to scroll the long sheet —
  // moved the theme and saved it.
  assert.ok(SAVED_ON_PICK.includes('themeOptions') && SAVED_ON_PICK.length >= 4,
    `control: the page's own copy names the groups that save on a pick (${SAVED_ON_PICK.join(', ')})`);
  const doc = makeDoc();
  pageFromMarkup(doc);
  const api = loadModalNet(doc);
  const landed: Record<string, FEl> = {};
  for (const sheet of doc.querySelectorAll('.modal-backdrop')) {
    setOpen(api, sheet, true);
    const at = doc.activeElement!;
    assert.ok(sheet.contains(at), `#${sheet.id} open: focus is in it`);
    assert.ok(!at.cls.has('btn-primary') && !at.cls.has('btn-danger'),
      `#${sheet.id} opens on <${at.tag} id=${at.id} class="${[...at.cls].join(' ')}">, a button that commits or destroys`);
    const picked = arrowPicks(doc, at);
    assert.ok(!picked || !SAVED_ON_PICK.some((g) => picked.closest('#' + g)),
      `#${sheet.id} opens on #${at.id}: an arrow key there would pick #${picked?.id}, which saves the moment it is picked`);
    landed[sheet.id] = at;
    doc.activeElement = doc.body;
    setOpen(api, sheet, false);
  }
  assert.ok(Object.keys(landed).length >= 12, `every sheet was opened (${Object.keys(landed).join(', ')})`);
  assert.equal(landed.apModal.id, 'apName', 'the policy editor opens on its Name field');
  assert.ok(landed.trashModal.cls.has('modal'), 'the Trash sheet opens on itself — its only button empties the Trash');
  assert.equal(landed.confirmModal.id, 'confirmCancel', 'Move to Trash? opens on Cancel');
  assert.equal(landed.browseModal.id, 'browseCurrent', 'the folder picker opens on its path field, not "Scan this folder"');
  assert.equal(landed.askModal.id, 'askInput', 'and a field a sheet marks [autofocus] still wins');
  const settings = landed.settingsModal;
  assert.ok(settings.attrs['data-close'] === 'settingsModal' && settings.closest('.modal-foot'),
    `Settings opens on its footer's "Close without saving", not on a choice that saves the moment it is picked (it opens on #${settings.id})`);
});

test('a sheet whose first field is a radio group opens on the checked choice, as Tab enters it — so Space on arrival changes nothing (C01)', () => {
  // A form's radio group, saved by its sheet's own button. Focus on the
  // first, unchecked choice would make Space pick it; the group is entered at
  // its checked radio, as Tab enters it. (A group that saves the moment it is
  // picked is no place to land at all: see the shipped-sheet test above.)
  const doc = makeDoc();
  const mk = mkOf(doc);
  const sheet = append(doc.body, mk('div', 'formModal', ['modal-backdrop']));
  const dlg = append(sheet, mk('div', '', ['modal']));
  const group = append(append(dlg, mk('div', '', ['modal-body'])), mk('div', 'unitOptions'));
  const radios = ['kb', 'mb', 'gb'].map((v) => Object.assign(append(group, mk('input', 'unit-' + v)),
    { type: 'radio', name: 'unit', checked: v === 'gb' }));
  append(append(dlg, mk('div', '', ['modal-foot'])), mk('button', 'formSaveBtn', ['btn', 'btn-primary']));
  sheet.shown = false;
  const api = loadModalNet(doc);
  setOpen(api, sheet, true);
  assert.equal(doc.activeElement, radios[2], 'focus is on GB, the choice in force');
});

test('a sheet lands on its [autofocus] control wherever it sits, and passes over a field that is disabled or not painted (C01 review F1.5)', () => {
  // In the shipped page the one [autofocus] field is also its sheet's only
  // field, so that test held with the rule gone. Here it sits after another.
  const sheetWith = (build: (body: FEl, foot: FEl, mk: ReturnType<typeof mkOf>) => void) => {
    const doc = makeDoc();
    const mk = mkOf(doc);
    const sheet = append(doc.body, mk('div', 'formModal', ['modal-backdrop']));
    const dlg = append(sheet, mk('div', '', ['modal']));
    const body = append(dlg, mk('div', '', ['modal-body']));
    const foot = append(dlg, mk('div', '', ['modal-foot']));
    build(body, foot, mk);
    append(foot, mk('button', 'formSaveBtn', ['btn', 'btn-primary']));
    sheet.shown = false;
    const api = loadModalNet(doc);
    setOpen(api, sheet, true);
    return doc.activeElement!.id;
  };
  assert.equal(sheetWith((body, _f, mk) => { append(body, mk('input', 'first')); append(body, mk('input', 'chosen', [], { autofocus: '' })); }),
    'chosen', 'an [autofocus] field after another field wins');
  assert.equal(sheetWith((body, foot, mk) => { append(body, mk('input', 'first')); append(foot, mk('button', 'closeBtn', ['btn'], { 'data-close': 'formModal', autofocus: '' })); }),
    'closeBtn', 'so does an [autofocus] safe button, fields before it or not');
  assert.equal(sheetWith((body, _f, mk) => { append(body, Object.assign(mk('input', 'off'), { disabled: true })); append(body, mk('input', 'next')); }),
    'next', 'a disabled first field is passed over for the next one');
  assert.equal(sheetWith((body, _f, mk) => { append(body, Object.assign(mk('input', 'gone'), { hidden: true })); append(body, mk('input', 'next')); }),
    'next', 'as is one that is not painted');
  assert.equal(sheetWith((body, _f, mk) => { append(body, mk('input', 'first')); append(body, Object.assign(mk('input', 'chosen', [], { autofocus: '' }), { disabled: true })); }),
    'first', 'and a disabled [autofocus] field gives way to the first live field');
});

test('a sheet\'s footer buttons keep their label on one line — "Save policy" no longer wraps beside the note (C01)', () => {
  // The Autopilot editor's footer holds a note, Preview and Save policy; the
  // button shrank to its longest word and read "Save / policy".
  const sheet = INDEX.slice(INDEX.indexOf('<style>') + 7, INDEX.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const rule = /(?:^|\})\s*\.modal-foot \.btn \{([^}]*)\}/.exec(sheet);
  assert.ok(rule, 'the footer\'s buttons have a rule of their own');
  assert.match(rule![1], /white-space:\s*nowrap/, 'a footer button never wraps its label; the note beside it wraps instead');
});

/* B31's sibling (review F1.3): the net made every body-level element that is
   not a sheet inert while one is open, toasts and tooltip aside. #rcPopover —
   the reclaim-score breakdown Clean Up's badges open, painted above every
   sheet — is one of them, so it opened over Clean Up already inert: its close
   button refused focus, Tab and a screen reader could not reach it, and a
   click on it fell through to the sheet and closed it. */
test('a panel a sheet opens over itself — the reclaim-score breakdown from Clean Up — is live: it takes focus and keeps it', () => {
  const doc = makeDoc();
  pageFromMarkup(doc);
  const focusin: Array<(e: { target: FEl }) => void> = [];
  (doc as unknown as { addEventListener: (type: string, fn: (e: { target: FEl }) => void) => void }).addEventListener =
    (type, fn) => { if (type === 'focusin') focusin.push(fn); };
  const api = loadModalNet(doc);
  assert.equal(focusin.length, 1, 'the net watches where focus lands');
  const clean = doc.getElementById('cleanModal')!;
  const pop = doc.getElementById('rcPopover')!;
  assert.ok(pop && pop.parent === doc.body && !clean.contains(pop), '#rcPopover is a body-level panel, outside every sheet');
  setOpen(api, clean, true);
  // openReclaimWhy, as a badge click in Clean Up runs it: fill, unhide, focus the close button.
  const close = append(pop, mkOf(doc)('button', 'rcPopClose', ['icon-btn']));
  pop.hidden = false;
  assert.equal(pop.inert, false, 'open over Clean Up, the breakdown is not inert — clicks land on it, Tab and a screen reader reach it');
  // The exemption is the breakdown's alone (review F2.2). The right-click
  // menu, the plain-words popover and the preview pane are opened from the
  // page, which nobody can reach while a sheet is up: left live, they would be
  // reachable under its scrim.
  for (const id of ['ctxMenu', 'nlPop', 'previewPane']) {
    const panel = doc.getElementById(id)!;
    assert.ok(panel && panel.parent === doc.body, `#${id} is a body-level panel`);
    assert.equal(panel.inert, true, `#${id} stays inert under the sheet: what opens it lives in the page`);
  }
  const live = doc.body.children
    .filter((c) => !c.cls.has('modal-backdrop') && !c.cls.has('blob') && !c.inert)
    .map((c) => '#' + (c.id || c.tag)).sort();
  assert.deepEqual(live, ['#rcPopover', '#toasts', '#tooltip'],
    'beside the toasts and the tooltip, the breakdown is the only body-level panel the sheet leaves live');
  close.focus();
  for (const fn of focusin) fn({ target: close });
  assert.equal(doc.activeElement, close, 'its close button takes focus, and the net does not pull it back into the sheet');
  api.syncModalLayers(); // any later class flip on a backdrop runs the net again
  assert.equal(doc.activeElement, close, 'and keeps it when the net runs again');
  assert.equal(doc.querySelector('main')!.inert, true, 'the page behind the sheet is still inert');
  // Focus that lands in the page behind is still pulled back into the sheet.
  doc.activeElement = doc.getElementById('scanBtn') ?? doc.body;
  for (const fn of focusin) fn({ target: doc.activeElement! });
  assert.ok(clean.contains(doc.activeElement), 'focus landing anywhere else outside the sheet is pulled back in, as before');
});

/* Review F2.3, the other order: the breakdown opened from a page row with no
   sheet up holds focus on its close button, and then a sheet opens — `?`
   only flips `.open` and leaves focus to the net. The F1.3 exemption left
   focus in the breakdown, so the sheet opened with the keyboard and the
   screen reader outside it: Enter acted on the breakdown. This test pins
   focus only. The first Escape closing the breakdown instead of the sheet
   was the breakdown's own listener, which focus did not reach: the review
   F3.1 tests below pin where Escape goes. */
test('a sheet that opens while the breakdown holds focus takes focus itself, and gives it back when it closes (review F2.3)', () => {
  const doc = makeDoc();
  pageFromMarkup(doc);
  const focusin: Array<(e: { target: FEl }) => void> = [];
  (doc as unknown as { addEventListener: (type: string, fn: (e: { target: FEl }) => void) => void }).addEventListener =
    (type, fn) => { if (type === 'focusin') focusin.push(fn); };
  const api = loadModalNet(doc);
  // openReclaimWhy, as a badge in a page row runs it, with no sheet open.
  const pop = doc.getElementById('rcPopover')!;
  const close = append(pop, mkOf(doc)('button', 'rcPopClose', ['icon-btn']));
  pop.hidden = false;
  close.focus();
  for (const fn of focusin) fn({ target: close });
  assert.equal(doc.activeElement, close, 'opened from a page row, the breakdown has focus');
  const sheet = doc.getElementById('shortcutsModal')!;
  setOpen(api, sheet, true);
  const at = doc.activeElement;
  assert.ok(sheet.contains(at), `the sheet that just opened has focus (it is on <${at?.tag} id=${at?.id}>)`);
  api.syncModalLayers(); // a later class flip on a backdrop runs the net again
  assert.ok(sheet.contains(doc.activeElement), 'and the sheet keeps it when the net runs again, not the breakdown');
  setOpen(api, sheet, false);
  assert.equal(doc.activeElement, close, 'closed, the sheet gives focus back to the breakdown it was opened over');
});

/* Review F3.3: the mark a sheet's opening leaves is spent by the net's own
   pass, never by the pass a closing sheet runs first (moveFocus false). One
   observer batch can carry both — sheet B opening and sheet A closing, in
   that record order — and the closing pass runs between B's opening and the
   batch's final pass. Spent there, the final pass saw no sheet newly open
   and left focus in the breakdown: the F2.3 bug again. */
test('a sheet that opens in the same batch as another closes still takes focus from the breakdown (review F3.3)', () => {
  const doc = makeDoc();
  pageFromMarkup(doc);
  const focusin: Array<(e: { target: FEl }) => void> = [];
  (doc as unknown as { addEventListener: (type: string, fn: (e: { target: FEl }) => void) => void }).addEventListener =
    (type, fn) => { if (type === 'focusin') focusin.push(fn); };
  const api = loadModalNet(doc);
  const a = doc.getElementById('cleanModal')!;
  const b = doc.getElementById('shortcutsModal')!;
  setOpen(api, a, true);
  // The breakdown, opened from a badge in sheet A, holds focus.
  const pop = doc.getElementById('rcPopover')!;
  const close = append(pop, mkOf(doc)('button', 'rcPopClose', ['icon-btn']));
  pop.hidden = false;
  close.focus();
  for (const fn of focusin) fn({ target: close });
  assert.equal(doc.activeElement, close, 'the breakdown has focus over sheet A');
  // One MutationObserver batch, as the net's callback runs it: B's record
  // (opened), then A's (closed), then the one final pass.
  b.classList.add('open'); b.shown = true;
  a.classList.remove('open'); a.shown = false;
  api.modalOpened(b);
  api.modalClosed(a);
  api.syncModalLayers();
  const at = doc.activeElement;
  assert.ok(b.contains(at), `sheet B, opened in the batch that closed A, has focus (it is on <${at?.tag} id=${at?.id}>)`);
});

/**
 * The reclaim-score breakdown out of the built page — its open, its close and
 * its Escape listener — over the real markup and the real net, with the
 * app-wide handler's sheet branch for a key the breakdown lets through.
 * `escape()` dispatches as the browser does: the document's capture listeners
 * (the breakdown's) first, the bubble phase only if none stopped it. Focus
 * reports itself as the browser's does (focusin), so the net sees every move;
 * and the panel's innerHTML is modelled: cleared, its close button is gone,
 * and focus on it falls to <body>.
 */
function breakdownHarness(standIn: (el: FEl) => FEl | null = () => null) {
  const doc = makeDoc();
  pageFromMarkup(doc);
  const focusin: Array<(e: { target: FEl }) => void> = [];
  (doc as unknown as { addEventListener: (type: string, fn: (e: { target: FEl }) => void) => void }).addEventListener =
    (type, fn) => { if (type === 'focusin') focusin.push(fn); };
  let at: FEl | null = doc.activeElement;
  Object.defineProperty(doc, 'activeElement', {
    get: () => at,
    set: (el: FEl | null) => { const moved = el !== at; at = el; if (moved && el && el !== doc.body) for (const fn of focusin) fn({ target: el }); },
  });
  const api = loadModalNet(doc);
  const mk = mkOf(doc);
  const pop = doc.getElementById('rcPopover')!;
  Object.defineProperty(pop, 'innerHTML', {
    get: () => '',
    set: (html: string) => {
      for (const c of pop.children.splice(0)) {
        Object.assign(c, { parent: null, shown: false, isConnected: false });
        if (at === c) at = doc.body;
      }
      if (html.includes('id="rcPopClose"')) append(pop, mk('button', 'rcPopClose', ['icon-btn']));
    },
  });
  const keydown: Array<(e: unknown) => void> = [];
  const document = {
    addEventListener: (type: string, fn: (e: unknown) => void, capture?: boolean) => { if (type === 'keydown' && capture === true) keydown.push(fn); },
    contains: (n: FEl) => doc.root.contains(n),
    querySelector: (sel: string) => doc.querySelector(sel),
    get activeElement() { return doc.activeElement; },
    body: doc.body,
  };
  const fact = { score: 82, confidence: 'high', components: [], missing: [] };
  const panel = new Function('document', '$', 'window', 'CSS', 'scoreFor', 'scoreKnown', 'toast', 'escapeHtml', 'reclaimColor', 'reclaimInk', 'icon',
    'reclaimWhyHtml', 'reclaimRadarAxes', 'RC_AXIS_ORDER', 'FxCharts', 'ctxTarget', 'topModal', 'inModalOverlay', 'modalFocusInto', 'gridFocusStandIn',
    `'use strict'; ${slice('/* ── the popover ── */', '/* ── sorting ──')}\nreturn { openReclaimWhy, closeReclaimWhy };`,
  )(document, (id: string) => doc.getElementById(id), { innerWidth: 1280, innerHeight: 800 }, { escape: (s: string) => s },
    // reclaimInk is the badge's readable ink (B21): a colour, stood in for as reclaimColor is.
    () => fact, () => true, () => {}, (s: string) => s, () => '#3a3', () => '#3a3', () => '', () => '', () => [], [], { radar: () => ({ destroy() {} }) }, null,
    api.topModal, api.inModalOverlay, api.modalFocusInto, standIn,
  ) as { openReclaimWhy: (path: string, anchor: FEl | null, point?: unknown, returnTo?: FEl | null) => void; closeReclaimWhy: () => void };
  const branch = slice('const openModal = topModal();', '// Focus goes back to whatever opened the menu');
  const sheetEscape = new Function('topModal', 'closeModal', 'cmdkClose', `'use strict'; return () => { ${branch} };`)(
    api.topModal, (id: string) => setOpen(api, doc.getElementById(id)!, false), () => {},
  ) as () => void;
  const escape = () => {
    let stopped = false;
    const e = { key: 'Escape', target: doc.activeElement, stopPropagation: () => { stopped = true; }, preventDefault: () => {} };
    for (const fn of keydown) fn(e);
    if (!stopped) sheetEscape();
  };
  /** A score badge — the breakdown's opener — in `parent`. */
  const badgeIn = (parent: FEl, path: string) => Object.assign(append(parent, mk('button', '', ['rc-badge'], { 'data-rc-why': path })),
    { getBoundingClientRect: () => ({ left: 40, top: 300, bottom: 318 }) });
  assert.equal(keydown.length, 1, 'the breakdown listens for Escape on the document, in the capture phase');
  return { doc, api, pop, escape, badgeIn, ...panel };
}

/* Review F3.1: Escape goes to the layer the keyboard is in, latest first.
   F2.3 gave focus to a sheet opened over the breakdown, but the breakdown's
   Escape listener — on the document, in the capture phase — still took the
   first Escape whenever the breakdown showed, and stopped it before the
   sheet's handler saw it: `?` over a breakdown opened from a page row, then
   Escape, closed the breakdown and left the sheet up. */
test('Escape closes the layer that holds the keyboard: a sheet opened over the breakdown closes first (review F3.1)', () => {
  const h = breakdownHarness();
  const path = '/Users/me/Movies/render-final.mov';
  const badge = h.badgeIn(h.doc.querySelector('main')!, path);
  badge.focus();
  h.openReclaimWhy(path, badge);
  const close = h.doc.getElementById('rcPopClose')!;
  assert.equal(h.doc.activeElement, close, 'opened from a page row, the breakdown has focus');
  const sheet = h.doc.getElementById('shortcutsModal')!;
  setOpen(h.api, sheet, true); // `?`
  assert.ok(sheet.contains(h.doc.activeElement), 'the sheet opened over it has focus (F2.3)');
  h.escape();
  assert.equal(sheet.classList.contains('open'), false, 'the first Escape closes the sheet, the layer the keyboard is in');
  assert.equal(h.pop.hidden, false, 'and leaves the breakdown the sheet opened over');
  assert.equal(h.doc.activeElement, close, 'which has focus back');
  h.escape();
  assert.equal(h.pop.hidden, true, 'the second Escape closes the breakdown');
  assert.equal(h.doc.activeElement, badge, 'and focus is back on the badge that opened it');
});

test('a breakdown opened over a sheet still takes the first Escape, wherever focus is in that sheet (review F3.1)', () => {
  const h = breakdownHarness();
  const clean = h.doc.getElementById('cleanModal')!;
  setOpen(h.api, clean, true);
  const path = '/Users/me/Library/Caches/com.example.app';
  const badge = h.badgeIn(clean.querySelector('.modal')!, path);
  badge.focus();
  h.openReclaimWhy(path, badge);
  assert.equal(h.doc.activeElement, h.doc.getElementById('rcPopClose'), 'the breakdown takes focus over Clean Up (F1.3)');
  h.escape();
  assert.equal(h.pop.hidden, true, 'Escape closes the breakdown, the layer opened last');
  assert.equal(clean.classList.contains('open'), true, 'and leaves Clean Up open');
  assert.equal(h.doc.activeElement, badge, 'with focus back on the badge in it');
  // Tab out of the breakdown wraps into the sheet and leaves the breakdown up.
  h.openReclaimWhy(path, badge);
  badge.focus();
  h.escape();
  assert.equal(h.pop.hidden, true, 'focus in Clean Up: the first Escape is still the breakdown\'s, which opened after the sheet');
  assert.equal(clean.classList.contains('open'), true, 'and Clean Up stays');
  h.escape();
  assert.equal(clean.classList.contains('open'), false, 'the next Escape closes Clean Up');
  // The sheet closes under the breakdown, with focus outside both: no sheet is left to take the key.
  setOpen(h.api, clean, true);
  h.openReclaimWhy(path, badge);
  badge.focus();
  setOpen(h.api, clean, false);
  h.escape();
  assert.equal(h.pop.hidden, true, 'with no sheet up, Escape closes the breakdown');
});

test('a breakdown holding focus under a later sheet closes on Escape, and focus goes into the sheet, not <body> (review F3.1)', () => {
  const h = breakdownHarness();
  const path = '/Users/me/Movies/render-final.mov';
  const badge = h.badgeIn(h.doc.querySelector('main')!, path);
  badge.focus();
  h.openReclaimWhy(path, badge);
  const sheet = h.doc.getElementById('shortcutsModal')!;
  setOpen(h.api, sheet, true);
  const close = h.doc.getElementById('rcPopClose')!;
  close.focus(); // a click back in the breakdown, which paints above every sheet
  assert.equal(h.doc.activeElement, close, 'the breakdown stays live over the sheet: a click there gives it focus');
  h.escape();
  assert.equal(h.pop.hidden, true, 'Escape goes to the breakdown, which holds the keyboard');
  assert.equal(sheet.classList.contains('open'), true, 'and the sheet stays');
  const at = h.doc.activeElement;
  assert.ok(sheet.contains(at), `focus goes into the sheet — the badge behind it is inert — not to <body> (it is on <${at?.tag} id=${at?.id}>)`);
});

/* ══════════════ a11y-keyboard-2 — shortcuts stop at the scrim; Escape closes the top layer ══════════════ */

test('while a dialog is open, global shortcuts never reach the views underneath', () => {
  const handler = braced("document.addEventListener('keydown', (e) => {\n  const mod = e.metaKey || e.ctrlKey;");
  const guardAt = handler.search(/const sheet = topModal\(\);/);
  const featureSix = handler.indexOf("if (state.view === 'treemap' && !typing && !mod && state.treemap.rootPath");
  const questionMark = handler.indexOf("e.key === '?'");
  const rescanAt = handler.indexOf("e.key.toLowerCase() === 'r'");
  assert.ok(guardAt !== -1, 'the handler asks for the topmost sheet');
  assert.ok(guardAt < questionMark, "the guard precedes '?' — the shortcuts sheet cannot stack on Settings");
  assert.ok(guardAt < rescanAt, 'and ⌘R');
  assert.ok(guardAt < featureSix, 'and the treemap keys — Enter cannot drill behind a Trash sheet');
  const guard = handler.slice(guardAt, guardAt + 400);
  assert.match(guard, /e\.key !== 'Escape'/, 'Escape still passes, to close the sheet');
  assert.match(guard, /e\.key\.toLowerCase\(\) === 'k'/, 'and ⌘K keeps its toggle');
  assert.match(guard, /e\.key === 'Tab'/, 'Tab is trapped inside the sheet');
});

test('Escape closes the TOPMOST dialog — the one painted last, or the palette', () => {
  const chain = slice('const openModal = topModal();', 'hideCtxMenu()');
  assert.match(chain, /topModal\(\)/, 'the topmost sheet, not the first in DOM order');
  const top = braced('function topModal(');
  const opens = braced('function openModals(');
  assert.match(opens, /cmdkModal/, 'the palette paints above every other sheet whatever its DOM position');
  assert.match(top, /\[\w+\.length - 1\]|\.pop\(\)|at\(-1\)/, 'the last of the open sheets is the top');
});

test('the ? sheet refuses to stack on another dialog', () => {
  const fn = braced('function toggleShortcuts(');
  const doc = makeDoc();
  const p = pageWith(doc);
  const mk = mkOf(doc);
  const shortcuts = append(doc.body, mk('div', 'shortcutsModal', ['modal-backdrop']));
  const api = loadModalNet(doc);
  const toggle = new Function('$', 'topModal', `'use strict'; ${fn} return toggleShortcuts;`)(
    (id: string) => doc.getElementById(id), api.topModal) as () => void;
  toggle();
  assert.equal(shortcuts.classList.contains('open'), true, 'with nothing else open, ? opens the sheet');
  toggle();
  assert.equal(shortcuts.classList.contains('open'), false, 'and toggles it away');
  p.settings.classList.add('open'); p.settings.shown = true;
  toggle();
  assert.equal(shortcuts.classList.contains('open'), false, 'over Settings, ? does nothing — no second scrim');
});

/* ══════════════ the keys are named as this keyboard names them ══════════════ */

/** keyName/keyCombo/renderKeyNames out of the page, with `state` saying which OS this is (undefined: not answered yet). */
function keysFor(platform: string | undefined, els: { mod: Array<{ textContent: string }>; alt: Array<{ textContent: string }>; nav: { title: string }; collapsed: boolean }) {
  const src = [
    braced('function platformWord('), INDEX.slice(INDEX.indexOf('const KEY_NAMES = '), INDEX.indexOf(';', INDEX.indexOf('const KEY_NAMES = ')) + 1),
    braced('function keyName('), braced('function keyCombo('), braced('function sideNavTitle('), braced('function renderKeyNames('),
  ].join('\n');
  const document = { querySelectorAll: (sel: string) => (sel === '[data-key="mod"]' ? els.mod : sel === '[data-key="alt"]' ? els.alt : []) };
  const $ = (id: string) => (id === 'sideToggle' ? els.nav : id === 'sideNav' ? { classList: { contains: (c: string) => c === 'collapsed' && els.collapsed } } : null);
  const state = platform === undefined ? { system: null } : { system: { platform } };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('document', '$', 'state', `'use strict'; ${src}\nreturn { keyName, keyCombo, renderKeyNames };`)(document, $, state) as {
    keyName: (which: string) => string; keyCombo: (key: string) => string; renderKeyNames: () => void;
  };
}

test('modifier keys are named for this keyboard: ⌘ and ⌥ on a Mac, Ctrl and Alt everywhere else', () => {
  // Every shortcut listens for metaKey || ctrlKey, and the lasso's freehand
  // for altKey, so Ctrl and Alt work on every computer — the neutral names
  // before /api/system has answered.
  const els = () => ({ mod: [], alt: [], nav: { title: '' }, collapsed: false });
  const mac = keysFor('darwin', els());
  assert.deepEqual([mac.keyName('mod'), mac.keyName('alt'), mac.keyCombo('B')], ['⌘', '⌥', '⌘B']);
  for (const p of ['win32', 'linux', 'freebsd', undefined]) {
    const k = keysFor(p, els());
    assert.deepEqual([k.keyName('mod'), k.keyName('alt'), k.keyCombo('B')], ['Ctrl', 'Alt', 'Ctrl+B'], String(p));
  }
  assert.match(braced('function applySideNav('), /btn\.title = sideNavTitle\(collapsed\);/, 'the sidebar toggle\'s tooltip names the key the same way');
});

test('once the OS is known, the shortcuts sheet, the lasso hint and the sidebar tooltip are rewritten in its key names', () => {
  const made = (t: string) => ({ textContent: t });
  const win = { mod: [made('⌘'), made('⌘')], alt: [made('⌥')], nav: { title: 'Collapse navigation (⌘B)' }, collapsed: false };
  keysFor('win32', win).renderKeyNames();
  assert.deepEqual(win.mod.map((e) => e.textContent), ['Ctrl', 'Ctrl']);
  assert.deepEqual(win.alt.map((e) => e.textContent), ['Alt']);
  assert.equal(win.nav.title, 'Collapse navigation (Ctrl+B)');
  const mac = { mod: [made('Ctrl')], alt: [made('Alt')], nav: { title: 'Expand navigation (Ctrl+B)' }, collapsed: true };
  keysFor('darwin', mac).renderKeyNames();
  assert.deepEqual([mac.mod[0].textContent, mac.alt[0].textContent, mac.nav.title], ['⌘', '⌥', 'Expand navigation (⌘B)']);
  const sys = braced('async function loadSystem(');
  assert.ok(sys.indexOf('renderKeyNames();') > sys.indexOf('state.system = sys;'), 'loadSystem renames the keys once it knows the OS');
});

test('the page names no ⌘ or ⌥ that the renaming cannot reach', () => {
  // The markup and styles outside the script, HTML and CSS comments removed:
  // every ⌘ and ⌥ sits in an element renderKeyNames rewrites. In the script,
  // comments removed, the glyphs live only in the key-name table.
  const scriptAt = INDEX.indexOf("<script>\n'use strict';");
  const markup = (INDEX.slice(0, scriptAt) + INDEX.slice(INDEX.indexOf('</script>', scriptAt)))
    .replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const glyphs = [...markup.matchAll(/[⌘⌥]/g)];
  assert.ok(glyphs.length >= 6, `the sheet and the lasso hint still show the Mac glyphs by default (${glyphs.length})`);
  for (const m of glyphs) {
    const before = markup.slice(Math.max(0, m.index! - 40), m.index);
    assert.match(before, m[0] === '⌘' ? /data-key="mod">$/ : /data-key="alt">$/, `a ${m[0]} outside a renamed element: …${before}${m[0]}`);
  }
  const code = INDEX.slice(scriptAt, INDEX.indexOf('</script>', scriptAt))
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  const table = INDEX.slice(INDEX.indexOf('const KEY_NAMES = '), INDEX.indexOf(';', INDEX.indexOf('const KEY_NAMES = ')));
  assert.equal(code.split('⌘').length - 1, table.split('⌘').length - 1, 'no ⌘ in a script string outside KEY_NAMES');
  assert.equal(code.split('⌥').length - 1, table.split('⌥').length - 1, 'no ⌥ in a script string outside KEY_NAMES');
});

test('the hold-Z lens does not paint under a scrim', () => {
  const z = braced("document.addEventListener('keydown', (e) => {\n  if (e.key !== 'z' && e.key !== 'Z') return;");
  assert.match(z, /topModal\(\)/, 'the lens checks for an open sheet');
});

/* ══════════════ a11y-keyboard-4 — segmented controls are real tab lists ══════════════ */

test('every tablist in the page contains only role=tab children', () => {
  const lists = [...INDEX.matchAll(/<(div|nav) class="[^"]*" id="([\w-]+)" role="tablist"[^>]*>([\s\S]*?)<\/\1>/g)];
  assert.ok(lists.length >= 12, `the twelve segmented controls plus the sidebar are all declared (found ${lists.length})`);
  for (const [, , id, body] of lists) {
    const buttons = [...body.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(buttons.length >= 2, `#${id} has at least two tabs`);
    for (const b of buttons) {
      assert.match(b, /role="tab"/, `#${id}: "${b.slice(0, 60)}…" is a tab, so aria-selected is a supported state`);
      assert.match(b, /aria-selected="(true|false)"/, `#${id}: every tab states its selection`);
    }
  }
  assert.doesNotMatch(INDEX, /<div class="smart-filters" role="tablist"/, 'the Clean Up filter pills are a group of toggles, not a tab list they never were');
});

type TablistApi = { tablistKeydown: (e: Record<string, unknown>) => boolean; tablistRovingSync: (list: FEl) => void };

function loadTablist(doc: FDoc): TablistApi {
  const keys = braced('function tablistKeydown(');
  const rove = braced('function tablistRovingSync(');
  return new Function('document', `'use strict'; ${keys}\n${rove}\nreturn { tablistKeydown, tablistRovingSync };`)(doc) as TablistApi;
}

function segWith(doc: FDoc, orientation?: string) {
  const mk = mkOf(doc);
  const seg = append(doc.body, mk('div', 'tmViewSeg', ['seg'], { role: 'tablist', ...(orientation ? { 'aria-orientation': orientation } : {}) }));
  const tabs = ['treemap', 'sunburst', 'circles', 'voronoi'].map((vm, i) =>
    append(seg, mk('button', 'tab-' + vm, [], { role: 'tab', 'aria-selected': String(i === 0) })));
  return { seg, tabs };
}

test('arrow keys move between tabs and activate them; Home and End jump; the list wraps', () => {
  const doc = makeDoc();
  const { seg, tabs } = segWith(doc);
  const api = loadTablist(doc);
  tabs[0].focus();
  const press = (key: string, target = doc.activeElement!) => {
    let prevented = false;
    const handled = api.tablistKeydown({ key, target, preventDefault: () => { prevented = true; }, metaKey: false, ctrlKey: false, altKey: false });
    return { handled, prevented };
  };
  let r = press('ArrowRight');
  assert.equal(r.handled && r.prevented, true, 'a handled arrow is claimed, so the treemap keys never see it');
  assert.equal(doc.activeElement, tabs[1], '→ moves to the next tab');
  assert.equal(tabs[1].clicks, 1, 'and activates it — selection follows focus, like a native segmented control');
  press('End');
  assert.equal(doc.activeElement, tabs[3], 'End jumps to the last');
  press('ArrowRight');
  assert.equal(doc.activeElement, tabs[0], 'and the list wraps');
  press('ArrowLeft');
  assert.equal(doc.activeElement, tabs[3], 'in both directions');
  press('Home');
  assert.equal(doc.activeElement, tabs[0]);
  r = press('ArrowDown');
  assert.equal(r.handled, false, 'a horizontal list ignores ↑/↓, so page scrolling still works');
  assert.equal(press('a').handled, false, 'letters are not the tab list\'s business');
  assert.equal(press('ArrowRight', seg).handled, false, 'a key on the list itself, not a tab, is ignored');
});

test('a vertical tablist (the sidebar) answers ↑/↓ and skips hidden tabs', () => {
  const doc = makeDoc();
  const { tabs } = segWith(doc, 'vertical');
  const api = loadTablist(doc);
  tabs[1].hidden = true; // #cleanTabCloud is hidden until a cloud placeholder exists
  tabs[0].focus();
  api.tablistKeydown({ key: 'ArrowDown', target: tabs[0], preventDefault: () => {}, metaKey: false, ctrlKey: false, altKey: false });
  assert.equal(doc.activeElement, tabs[2], '↓ skips the hidden tab');
  const r = api.tablistKeydown({ key: 'ArrowRight', target: tabs[2], preventDefault: () => {}, metaKey: false, ctrlKey: false, altKey: false });
  assert.equal(r, false, 'a vertical list ignores ←/→');
});

test('roving tabindex: exactly one tab per list is a Tab stop, and it is the selected one', () => {
  const doc = makeDoc();
  const { seg, tabs } = segWith(doc);
  const api = loadTablist(doc);
  api.tablistRovingSync(seg);
  assert.deepEqual(tabs.map((t) => t.getAttribute('tabindex')), ['0', '-1', '-1', '-1']);
  tabs[0].setAttribute('aria-selected', 'false'); tabs[2].setAttribute('aria-selected', 'true');
  api.tablistRovingSync(seg);
  assert.deepEqual(tabs.map((t) => t.getAttribute('tabindex')), ['-1', '-1', '0', '-1'], 'the stop follows aria-selected');
  const net = slice('/* ── Roving tabindex ── */', 'function tablistKeydown(');
  assert.match(net, /attributeFilter: \['aria-selected'\]/, 'the twelve writers stay as they are — a net watches aria-selected');
  assert.match(net, /subtree: true/, 'over the whole document, so a tab list rendered later is covered too');
});

test('the keydown handler consults the tab list before anything else can claim an arrow', () => {
  const handler = braced("document.addEventListener('keydown', (e) => {\n  const mod = e.metaKey || e.ctrlKey;");
  const tabAt = handler.indexOf('if (tablistKeydown(e)) return;');
  const featureSix = handler.indexOf("if (state.view === 'treemap' && !typing && !mod && state.treemap.rootPath");
  assert.ok(tabAt !== -1 && tabAt < featureSix, 'ArrowRight on the Treemap/Sunburst seg switches the renderer, it does not drill the map');
});

/* ══════════════ a11y-keyboard-6 — the cart drawer and the preview pane ══════════════ */

test('Escape closes the cart drawer, ahead of the preview pane and the map', () => {
  const chain = slice('const openModal = topModal();', 'void tourFinish(');
  const cartAt = chain.indexOf("$('cartDock').classList.contains('open')");
  const previewAt = chain.indexOf('if (previewIsOpen())');
  const upAt = chain.indexOf('treemapUp()');
  assert.ok(cartAt !== -1, 'the chain has a cart branch');
  assert.ok(cartAt < previewAt && cartAt < upAt, 'the drawer over the map closes before the map climbs');
  assert.match(chain.slice(cartAt, cartAt + 160), /cartDockToggle\(false, \{ focus: true \}\)/, 'and hands focus back to the tab');
});

test('the drawer takes focus when opened from the keyboard and returns it on close', () => {
  // cartFocusReturn decides where focus goes on close (the tab while the cart
  // holds anything — QA B13 added the emptied-cart case, tested in layoutQa).
  const focusState = INDEX.slice(INDEX.indexOf('const cartFocus = '), INDEX.indexOf(';', INDEX.indexOf('const cartFocus = ')) + 1);
  assert.match(focusState, /^const cartFocus = /, 'the focus-origin note is in the page');
  const fn = `${braced('function cartDockToggle(')}\n${focusState}\n${braced('function cartFocusReturn(')}`;
  const doc = makeDoc();
  const mk = mkOf(doc);
  // The dock is shown (.show) whenever the cart holds anything.
  const dock = append(doc.body, mk('div', 'cartDock', ['show']));
  const panel = append(dock, mk('div', 'cartPanel'));
  const collapse = append(panel, mk('button', 'cartCollapse'));
  const tab = append(dock, mk('div', 'cartTab', [], { tabindex: '0' }));
  const rafs: Array<() => void> = [];
  const toggle = new Function('$', 'document', 'requestAnimationFrame', `'use strict'; ${fn} return cartDockToggle;`)(
    (id: string) => doc.getElementById(id), doc, (cb: () => void) => rafs.push(cb)) as (open?: boolean, opts?: { focus?: boolean }) => void;
  tab.focus();
  toggle(undefined, { focus: true });
  assert.equal(dock.classList.contains('open'), true);
  assert.equal(doc.body.classList.contains('cart-open'), true, 'the body mirror survives');
  rafs.splice(0).forEach((cb) => cb());
  assert.equal(doc.activeElement, collapse, 'a keyboard open lands on the first control in the drawer');
  toggle(false, { focus: true });
  assert.equal(doc.activeElement, tab, 'closing from inside the drawer returns focus to the tab');
  // A mouse open moves no focus — the pointer is where the user is.
  doc.activeElement = doc.body;
  toggle(true);
  rafs.splice(0).forEach((cb) => cb());
  assert.equal(doc.activeElement, doc.body, 'a click leaves focus alone');
});

test('the preview pane takes focus on open and gives it back on close', () => {
  const open = braced('function openPreview(');
  const close = braced('function closePreview(');
  assert.match(open, /pvPrevFocus = document\.activeElement/, 'where focus came from is remembered');
  assert.match(open, /\$\('pvClose'\)\.focus\(/, 'and the Close button takes it — the pane is the last block of markup, dozens of Tab stops away');
  assert.match(close, /pvPrevFocus[\s\S]{0,80}\.focus\(/, 'closing restores it');
  assert.match(close, /pvPrevFocus = null/, 'once');
  assert.match(INDEX, /<aside id="previewPane" role="complementary"/, 'the pane is a landmark');
});

/* ══════════════ a11y-keyboard-7 — keyboard selection is announced ══════════════ */

test('j/k selection speaks the cell: name, kind, size, share — and the map is described for the keyboard', () => {
  const fn = braced('function kbSelect(');
  const doc = makeDoc();
  const live = append(doc.body, mkOf(doc)('div', 'tmKbAnnounce'));
  const state = { treemap: { kbSel: null as unknown, rootSize: 1000 } };
  const calls: string[] = [];
  const kbSelect = new Function('$', 'state', 'presentView', 'kbShowTip', 'hideTooltip', 'formatBytes', 'cartHas',
    `'use strict'; ${fn} return kbSelect;`)(
    (id: string) => doc.getElementById(id), state, () => calls.push('present'), () => calls.push('tip'), () => calls.push('hide'),
    (n: number) => n + ' B', (p: string) => p === '/x/in-cart') as (n: unknown) => void;
  kbSelect({ name: 'Movies', type: 'dir', size: 250, path: '/x/Movies' });
  assert.match(live.textContent, /^Movies, folder, 250 B, 25(\.0)? percent/, 'name, kind, size and share of this view');
  kbSelect({ name: 'big.mov', type: 'file', size: 500, path: '/x/in-cart' });
  assert.match(live.textContent, /big\.mov, file, 500 B, 50(\.0)? percent.*in cart/, 'a staged cell says so');
  kbSelect(null);
  assert.equal(live.textContent, '', 'clearing the selection clears the announcement');
  assert.deepEqual(calls, ['present', 'tip', 'present', 'tip', 'present', 'hide'], 'the paint and tooltip behaviour is unchanged');
  const label = /<canvas id="treemapCanvas" tabindex="0" aria-label="([^"]+)"/.exec(INDEX);
  assert.ok(label, 'the canvas is labelled');
  assert.match(label![1], /j\/k|arrow/i, 'the label tells a keyboard user how to move');
  assert.doesNotMatch(label![1], /directory/, 'and says folder, like the rest of the app');
  assert.match(INDEX, /<div id="tmKbAnnounce"[^>]*role="status"[^>]*aria-live="polite"/, 'the live region exists');
});

/* ══════════════ a11y-keyboard-8 — ⌘R never falls through to Electron's reload ══════════════ */

test('⌘R is always claimed — during a first scan it must not reload the page', () => {
  const handler = braced("document.addEventListener('keydown', (e) => {\n  const mod = e.metaKey || e.ctrlKey;");
  const at = handler.indexOf("if (mod && e.key.toLowerCase() === 'r') {");
  assert.notEqual(at, -1, 'the ⌘R branch exists');
  let depth = 0, end = at;
  for (let i = handler.indexOf('{', at); i < handler.length; i++) {
    if (handler[i] === '{') depth++;
    else if (handler[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const branch = handler.slice(at, end);
  const prevent = branch.indexOf('e.preventDefault()');
  const gate = branch.indexOf('if (state.root');
  assert.ok(prevent !== -1, 'the default is prevented');
  assert.ok(gate === -1 || prevent < gate, 'unconditionally — before any check on state.root');
  assert.match(branch, /state\.scanning/, 'a running scan is named rather than silently ignored');
});

/* ══════════════ QA fourth pass E04 — cancelling "Empty the Trash?" goes back to the Trash sheet ══════════════ */

/**
 * The page over its own markup with the focus net observing class flips as
 * a browser delivers them: each flip on a backdrop is a record, and a batch
 * is handed to the net's own observer callback at `flush()` — the microtask
 * checkpoint. Focus on something that stopped painting falls to <body>:
 * before the batch when `focusDropsFirst`, and otherwise after it, the net
 * finding focus still nominally on the closed sheet's button — a browser
 * clears it at a later rendering step, not before the observer's microtask
 * (review F1.2 of QA fourth pass E04). Focus moves report themselves
 * (focusin), so the net's trail and its pull into the top sheet both run.
 */
function observedPage({ focusDropsFirst = true } = {}) {
  const doc = makeDoc();
  pageFromMarkup(doc);
  const focusin: Array<(e: { target: FEl }) => void> = [];
  (doc as unknown as { addEventListener: (type: string, fn: (e: { target: FEl }) => void) => void }).addEventListener =
    (type, fn) => { if (type === 'focusin') focusin.push(fn); };
  let at: FEl | null = doc.activeElement;
  Object.defineProperty(doc, 'activeElement', {
    get: () => at,
    set: (el: FEl | null) => { const moved = el !== at; at = el; if (moved && el && el !== doc.body) for (const fn of focusin) fn({ target: el }); },
  });
  const records: Array<{ target: FEl; oldValue: string }> = [];
  let deliver: ((batch: unknown[]) => void) | null = null;
  class Observer {
    constructor(cb: (batch: unknown[]) => void) { deliver = cb; }
    observe(el: FEl) {
      for (const verb of ['add', 'remove', 'toggle'] as const) {
        const plain = el.classList[verb].bind(el.classList) as (c: string, on?: boolean) => unknown;
        (el.classList as unknown as Record<string, unknown>)[verb] = (c: string, on?: boolean) => {
          const oldValue = [...el.cls].join(' ');
          const out = plain(c, on);
          if ([...el.cls].join(' ') !== oldValue) { records.push({ target: el, oldValue }); el.shown = el.cls.has('open'); }
          return out;
        };
      }
    }
    disconnect() {}
  }
  const src = slice('/* ── Focus discipline for every dialog ── */', '/* ── end focus discipline ── */');
  const api = new Function('document', '$', 'MutationObserver', 'toastsRetire', 'getComputedStyle',
    `'use strict'; ${src}
     return { topModal, noteFocus };`,
  )(doc, (id: string) => doc.getElementById(id), Observer, () => {}, (el: FEl) => ({ visibility: computedVisibility(el) })) as { topModal: () => FEl | null };
  assert.ok(deliver, 'the net observes the backdrops');
  const dropUnpainted = () => { if (at && at !== doc.body && !at.getClientRects().length) at = doc.body; }; // it stopped painting
  const flush = () => {
    if (focusDropsFirst) dropUnpainted();
    const batch = records.splice(0);
    if (batch.length) deliver!(batch);
    dropUnpainted();
  };
  return { doc, api, flush };
}

/** The two orders a browser may take: focus off a sheet that stopped painting before the net's batch runs, or after it. */
const NET_ORDERS = [['focus dropped to <body> first', true], ['focus still on the closed sheet', false]] as const;

/** The Trash sheet, its Empty button, the shared confirmation and closeModal — the page's own — on `observedPage`. */
function trashSheetHarness(net: { focusDropsFirst?: boolean } = {}) {
  const { doc, api, flush } = observedPage(net);
  const $ = (id: string) => doc.getElementById(id)!;
  const listeners = new Map<string, Array<() => unknown>>();
  for (const id of ['emptyTrashBtn', 'confirmOk']) $(id).addEventListener = ((type: string, fn: () => unknown) => {
    assert.equal(type, 'click'); listeners.set(id, [...(listeners.get(id) || []), fn]);
  }) as FEl['addEventListener'];
  const calls: string[] = [];
  const state = { trash: { itemCount: 3, totalBytes: 3_200_000_000, complete: true, items: [{ name: 'a.mov', size: 1 }, { name: 'b.mov', size: 2 }, { name: 'c.dmg', size: 3 }] } };
  const page = new Function('$', 'document', 'state', 'formatBytes', 'formatCount', 'escapeHtml', 'icon', 'chipFor', 'toast', 'api', 'loadTrash', 'topModal',
    `'use strict';
     let onConfirmTrash = null; let openHandleSeq = 0; let confirmIgnoreOpenHandles = false; let confirmPaths = [];
     ${braced('function openTrashModal(')}
     ${braced('function closeModal(')}
     ${braced('function confirmFooterReset(')}
     ${braced('function setConfirmButton(')}
     ${braced('async function emptyTrashAction(')}
     ${slice("$('emptyTrashBtn').addEventListener('click', () => {", 'async function emptyTrashAction(')}
     ${slice("$('confirmOk').addEventListener('click', async () => {", '/**\n * The API sanitizes')}
     return { openTrashModal, closeModal };`,
  )($, doc, state, (n: number) => `${n} B`, String, (s: unknown) => String(s), () => '', () => '', (m: string) => calls.push(`toast ${m}`),
    async (url: string) => { calls.push(`api ${url}`); return { emptied: true, freedBytes: 3_200_000_000 }; }, () => calls.push('loadTrash'), api.topModal,
  ) as { openTrashModal: () => void; closeModal: (id: string) => void };
  const press = async (id: string) => { for (const fn of listeners.get(id) || []) await fn(); flush(); };
  // The Dashboard's Trash row, on screen.
  const fact = $('trashFact');
  for (let p: FEl | null = fact; p; p = p.parent) p.hidden = false;
  return { doc, $, api, flush, press, calls, fact, ...page };
}

test('cancelling "Empty the Trash?" — Cancel or Escape — goes back to the Trash sheet, with focus on "Empty Trash…" (QA fourth pass E04)', async () => {
  // QA fourth pass E04: keyboard only, Dashboard › Trash › Empty Trash… ›
  // Escape (or Cancel): the confirmation went, and so had the Trash sheet —
  // the Empty button closed it before asking — and focus fell to <body>.
  for (const [order, focusDropsFirst] of NET_ORDERS) {
    const h = trashSheetHarness({ focusDropsFirst });
    h.fact.focus();
    h.openTrashModal(); h.flush(); // Enter on the Trash row
    const trash = h.$('trashModal'), confirm = h.$('confirmModal'), empty = h.$('emptyTrashBtn');
    assert.ok(trash.classList.contains('open') && trash.contains(h.doc.activeElement), `control (${order}): the Trash sheet is open and holds focus`);
    assert.equal(empty.disabled, false, 'control: there is something to empty');
    for (const way of ['Cancel', 'Escape']) {
      empty.focus(); // Tab to it
      await h.press('emptyTrashBtn'); // and Enter
      assert.ok(confirm.classList.contains('open'), `${way} (${order}): "Empty the Trash?" is asked`);
      assert.equal(h.api.topModal(), confirm, `${way} (${order}): over the Trash sheet`);
      assert.equal(h.doc.activeElement, h.$('confirmCancel'), `${way} (${order}): the question opens on Cancel`);
      assert.ok(trash.classList.contains('open'), `${way} (${order}): the Trash sheet stays open under the question`);
      if (way === 'Cancel') h.closeModal('confirmModal'); // [data-close] runs closeModal
      else h.closeModal(h.api.topModal()!.id); // the page's Escape closes the top sheet through closeModal
      h.flush();
      assert.equal(confirm.classList.contains('open'), false, `${way} (${order}): the question is gone`);
      assert.ok(trash.classList.contains('open'), `${way} (${order}): the Trash sheet is back`);
      assert.equal(trash.inert, false, `${way} (${order}): and live`);
      assert.ok(h.doc.activeElement === empty, `${way} (${order}): focus is on "Empty Trash…", never <body> (it is on <${h.doc.activeElement?.tag} id=${h.doc.activeElement?.id}>)`);
    }
    assert.deepEqual(h.calls, [], 'nothing was emptied');
  }
});

test('"Empty the Trash" confirmed empties it and closes both sheets, giving focus back to the Trash row (QA fourth pass E04)', async () => {
  // Both sheets close in one observer batch, the question first. Whether the
  // browser has dropped focus off the question's button to <body> by then is
  // its own business (review F1.2): the Trash row takes it either way.
  for (const [order, focusDropsFirst] of NET_ORDERS) {
    const h = trashSheetHarness({ focusDropsFirst });
    h.fact.focus();
    h.openTrashModal(); h.flush();
    const trash = h.$('trashModal'), confirm = h.$('confirmModal');
    h.$('emptyTrashBtn').focus();
    await h.press('emptyTrashBtn');
    assert.ok(confirm.classList.contains('open') && trash.classList.contains('open'), `control (${order}): asked, over the Trash sheet`);
    h.$('confirmOk').focus(); // Tab to "Empty the Trash"
    assert.equal(h.doc.activeElement, h.$('confirmOk'), `control (${order}): the question's button has focus`);
    await h.press('confirmOk'); // and Enter
    assert.ok(h.calls.includes('api /api/trash/empty'), `${order}: the Trash was emptied: ${h.calls.join(', ')}`);
    assert.equal(confirm.classList.contains('open'), false, `${order}: the question closed`);
    assert.equal(trash.classList.contains('open'), false, `${order}: and the Trash sheet, whose list is gone with the Trash`);
    assert.ok(h.doc.activeElement === h.fact, `${order}: focus is back on the Trash row the sheet was opened from (it is on <${h.doc.activeElement?.tag} id=${h.doc.activeElement?.id}>)`);
  }
});

/* ══════════════ QA fourth pass E05 — the right-click menu from the keyboard, and the breakdown it opens gives focus back ══════════════ */

/** The right-click menu's entry listener out of the built page, as a press of entry `act` runs it, its menu opened with focus on `back`. */
function menuEntry(act: string, deps: { path: string; back: FEl | null; openReclaimWhy: (...a: never[]) => void }): () => void {
  const head = "menu.querySelectorAll('button').forEach(b => b.addEventListener('click', ";
  const at = INDEX.indexOf(`${head}() => {\n    const act = b.dataset.act;`);
  assert.notEqual(at, -1, 'the right-click menu\'s entry listener is in the page');
  const start = at + head.length;
  let depth = 0, end = -1;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const noop = () => {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('b', 'ctxTarget', 'x', 'y', 'hideCtxMenu', 'ctxMenuFocusOpener', 'ensureScores', 'openReclaimWhy',
    'openInOS', 'openPreview', 'copyPath', 'openTerminal', 'cartToggle', 'startOffloadFlow', 'openBudgetDialog', 'removeBudget', 'openNoteDialog', 'confirmTrash',
    `'use strict'; return (${INDEX.slice(start, end)});`)(
    { dataset: { act } }, { path: deps.path }, 300, 200, () => deps.back, (el: FEl | null) => { if (el) el.focus(); }, async () => {}, deps.openReclaimWhy,
    noop, noop, noop, noop, noop, noop, noop, noop, noop, noop) as () => void;
}

test('"Why this reclaim score?" from a Grid tile\'s menu gives focus back to that tile on Escape — or to the tile now standing for its file (QA fourth pass E05)', async () => {
  // QA fourth pass E05: the tile had focus, its right-click menu's "Why this
  // reclaim score?" opened the breakdown, and Escape left focus on <body>.
  // The menu opens it at the pointer, with no anchor, and a Grid tile has no
  // [data-rc-why] badge for the breakdown to find again.
  const path = '/Users/me/Mail/Mailbox 23.mbox';
  let rebuilt: FEl | null = null;
  let tile: FEl | null = null;
  const h = breakdownHarness((el) => (el === tile ? rebuilt : null)); // the page's gridFocusStandIn: the tile now standing for that file
  const grid = append(h.doc.querySelector('main')!, mkOf(h.doc)('div', 'gridInner'));
  tile = append(grid, mkOf(h.doc)('div', '', ['gcell'], { role: 'button', tabindex: '0' }));
  for (const round of ['the tile', 'the rebuilt tile']) {
    tile.focus();
    assert.equal(h.doc.activeElement, tile, `control (${round}): the tile has focus as its menu opens`);
    menuEntry('score', { path, back: tile, openReclaimWhy: h.openReclaimWhy as (...a: never[]) => void })();
    for (let i = 0; i < 5; i++) await Promise.resolve(); // the score is in hand: the panel opens at the next checkpoint
    assert.equal(h.pop.hidden, false, `${round}: the breakdown opened`);
    assert.equal(h.doc.activeElement, h.doc.getElementById('rcPopClose'), `${round}: and holds focus`);
    if (round === 'the rebuilt tile') {
      // The Grid rebuilds its tiles while the breakdown is up: the one the menu came from is gone.
      grid.children.splice(grid.children.indexOf(tile), 1);
      tile.parent = null; tile.isConnected = false;
      rebuilt = append(grid, mkOf(h.doc)('div', '', ['gcell'], { role: 'button', tabindex: '0' }));
    }
    h.escape();
    assert.equal(h.pop.hidden, true, `${round}: Escape closed it`);
    const want: FEl | null = round === 'the tile' ? tile : rebuilt;
    assert.equal(h.doc.activeElement, want, `${round}: focus is on ${round}, not <body> (it is on <${h.doc.activeElement?.tag} id=${h.doc.activeElement?.id}>)`);
  }
});

test('"Why this reclaim score?" from a menu opened by a right-click on a Largest Files row gives focus to the row\'s score badge on Escape — <body> is not where focus came from (review F1.1 of QA fourth pass E05)', async () => {
  // Review F1.1: Dashboard › Largest Files sorted by Reclaim, a right-click
  // on the blank part of a row. A row is no Tab stop, so the mousedown left
  // focus on <body>, and the menu remembers that as where focus came from
  // (hideCtxMenu answers it). The breakdown took <body> for its opener,
  // "gave focus back" to it — a no-op — and never looked for the row's score
  // badge, which it did before E05 handed it the menu's answer.
  const path = '/Users/me/Videos/holiday-4k.mov';
  const h = breakdownHarness();
  const list = append(h.doc.querySelector('main')!, mkOf(h.doc)('div', 'bigFiles'));
  for (const round of ['the badge', 'the badge the scores repainted']) {
    const row = append(list, mkOf(h.doc)('div', '', ['bigfile'])); // no tabindex, no role: not focusable
    const badge = h.badgeIn(row, path);
    h.doc.activeElement = h.doc.body; // the right-click's mousedown on the row's blank space
    menuEntry('score', { path, back: h.doc.body, openReclaimWhy: h.openReclaimWhy as (...a: never[]) => void })();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(h.pop.hidden, false, `${round}: the breakdown opened`);
    assert.equal(h.doc.activeElement, h.doc.getElementById('rcPopClose'), `${round}: and holds focus`);
    let want = badge;
    if (round === 'the badge the scores repainted') {
      // The list is rebuilt by innerHTML when the scores land: the badge is a new one.
      list.children.splice(list.children.indexOf(row), 1);
      row.parent = null; row.isConnected = false;
      want = h.badgeIn(append(list, mkOf(h.doc)('div', '', ['bigfile'])), path);
    }
    h.escape();
    assert.equal(h.pop.hidden, true, `${round}: Escape closed it`);
    assert.ok(h.doc.activeElement === want, `${round}: focus is on the row's score badge, not <body> (it is on <${h.doc.activeElement?.tag} id=${h.doc.activeElement?.id}>)`);
    list.children.splice(0).forEach((c) => { c.parent = null; c.isConnected = false; });
  }
});

type KeyEv = { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; defaultPrevented: boolean; preventDefault(): void };
const keyOf = (key: string, mods: Partial<Pick<KeyEv, 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>> = {}): KeyEv => {
  const e: KeyEv = { key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; } };
  return e;
};

/**
 * The keyboard's way into the right-click menu, out of the built page — its
 * key listeners, the map's selected-cell menu and the menu's own show and
 * close — over the page's markup. Every element answers contextmenu events
 * as a browser dispatches them: at it, then up its parents. `showCtxMenu`
 * opens the page's menu for a node, as the page's does, with two entries.
 * The keys arrive as a browser delivers them: `keydown()` and `keyup()` run
 * whatever the page's own code registered on the document for that event
 * (review F1.3), and the map's renderer is the page's isSun and isCells
 * reading `state.treemap.mode` (review F1.6).
 */
function keyMenuHarness() {
  const doc = makeDoc();
  pageFromMarkup(doc);
  const mk = mkOf(doc);
  const $ = (id: string) => doc.getElementById(id)!;
  const listeners = new Map<FEl, Array<(e: unknown) => void>>();
  const rects = new Map<FEl, { left: number; top: number; width: number; height: number }>();
  const dom = (el: FEl, rect = { left: 300, top: 200, width: 160, height: 160 }) => {
    rects.set(el, rect);
    Object.assign(el, {
      tagName: el.tag.toUpperCase(), // as a browser names an element
      addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'contextmenu') listeners.set(el, [...(listeners.get(el) || []), fn]); },
      getBoundingClientRect: () => { const r = rects.get(el)!; return { ...r, right: r.left + r.width, bottom: r.top + r.height }; },
      dispatchEvent: (ev: { type: string; bubbles: boolean; defaultPrevented: boolean; target?: FEl }) => {
        ev.target = el;
        for (let n: FEl | null = el; n; n = ev.bubbles ? n.parent : null) for (const fn of (ev.type === 'contextmenu' && listeners.get(n)) || []) fn(ev);
        return !ev.defaultPrevented;
      },
    });
    return el;
  };
  class FakeMouseEvent {
    type: string; clientX: number; clientY: number; cancelable: boolean; bubbles: boolean; defaultPrevented = false;
    constructor(type: string, init: { clientX: number; clientY: number; cancelable?: boolean; bubbles?: boolean }) {
      this.type = type; this.clientX = init.clientX; this.clientY = init.clientY; this.cancelable = !!init.cancelable; this.bubbles = !!init.bubbles;
    }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  }
  const menu = $('ctxMenu');
  menu.style.display = 'none';
  const shown: Array<{ x: number; y: number; node: { path: string } }> = [];
  const trashSheets: number[] = [];
  const sheet: { up: FEl | null } = { up: null };
  const canvas = dom($('treemapCanvas'), { left: 280, top: 300, width: 700, height: 400 });
  for (let p: FEl | null = canvas; p; p = p.parent) p.hidden = false; // the Treemap view is on screen
  const state = { view: 'treemap', treemap: { mode: 'treemap', kbSel: null as unknown, pxRects: [] as unknown[], history: { active: false }, arcs: [] as unknown[], cells: [] as unknown[] } };
  const tmPreview = { on: false };
  const onDocument = new Map<string, Array<(e: KeyEv) => void>>();
  const document = {
    get activeElement() { return doc.activeElement; }, body: doc.body,
    addEventListener: (type: string, fn: (e: KeyEv) => void) => { onDocument.set(type, [...(onDocument.get(type) || []), fn]); },
  };
  type Page = { hideCtxMenu(): FEl | null; ctxMenuFocusOpener(el: FEl | null): void;
    ctxMenuShow(menu: FEl, o: { label: string; html: string; x: number; y: number }): void };
  const decl = (anchor: string) => { const at = INDEX.indexOf(anchor); assert.notEqual(at, -1, `"${anchor}" is in the page`); return INDEX.slice(at, INDEX.indexOf(';', at) + 1); };
  let page: Page;
  const showCtxMenu = (x: number, y: number, node: { path: string }) => {
    shown.push({ x, y, node });
    page.ctxMenuShow(menu, { label: `Actions for ${node.path}`, html: '', x, y });
    menu.children.splice(0);
    for (const act of ['open', 'copy']) append(menu, mk('button', '', [], { 'data-act': act }));
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  page = new Function('document', '$', 'window', 'MouseEvent', 'topModal', 'tmCanvas', 'state', 'tmPreview', 'showCtxMenu', 'openTrashModal',
    `'use strict';
     ${decl('let ctxMenuOpener = ')} ${decl('let ctxMenuReturn = ')} ${decl('const CTX_MENU_EDGE = ')}
     ${['ctxMenuShow', 'hideCtxMenu', 'ctxMenuFocusOpener', 'ctxMenuIsOpen', 'kbCellPoint', 'tmCanvasKeyMenu', 'isSun', 'isCells']
       .map((n) => braced(`function ${n}(`)).join('\n')}
     ${slice('/* ── The menu from the keyboard (QA fourth pass E05) ──', 'async function openInOS(')}
     return { hideCtxMenu, ctxMenuFocusOpener, ctxMenuShow };`,
  )(document, $, { innerWidth: 1440, innerHeight: 900 }, FakeMouseEvent, () => sheet.up, canvas, state, tmPreview, showCtxMenu,
    () => { trashSheets.push(1); }) as Page;
  /** A key pressed or released, delivered to the listeners the page registered on the document for it. */
  const keydown = (e: KeyEv) => { for (const fn of onDocument.get('keydown') || []) fn(e); };
  const keyup = (e: KeyEv) => { for (const fn of onDocument.get('keyup') || []) fn(e); };
  const main = doc.querySelector('main')!;
  /** A contextmenu listener on `el` that opens `node`'s menu where the event says, as each view's own does. */
  const onMenu = (el: FEl, node: { path: string }) => listeners.set(el, [...(listeners.get(el) || []),
    (e: unknown) => { const ev = e as { preventDefault(): void; clientX: number; clientY: number }; ev.preventDefault(); showCtxMenu(ev.clientX, ev.clientY, node); }]);
  return { doc, $, mk, main, dom, listeners, page, keydown, keyup, shown, trashSheets, sheet, canvas, state, tmPreview, menu, showCtxMenu, onMenu };
}

test('the ContextMenu key and Shift+F10 open the focused item\'s right-click menu, at the item, with focus on its first entry — and Escape gives focus back (QA fourth pass E05)', () => {
  // QA fourth pass E05: there was no keyboard way to the right-click menu at
  // all — no ContextMenu key, no Shift+F10 — in any view that has one.
  const h = keyMenuHarness();
  // A Grid tile: a focusable item with a contextmenu listener of its own, as gridCell puts one on every tile.
  assert.match(braced('function gridCell('), /cell\.tabIndex = 0;[\s\S]*cell\.addEventListener\('contextmenu', \(e\) => \{ e\.preventDefault\(\); showCtxMenu\(e\.clientX, e\.clientY, it\); \}\);/,
    'control: a Grid tile is a Tab stop that opens the menu for its file on contextmenu');
  const tileNode = { path: '/Users/me/Mail/Mailbox 23.mbox' };
  const tile = h.dom(append(h.main, h.mk('div', '', ['gcell'], { role: 'button', tabindex: '0' })), { left: 420, top: 260, width: 150, height: 150 });
  h.onMenu(tile, tileNode);
  for (const [name, ev] of [['ContextMenu', keyOf('ContextMenu')], ['Shift+F10', keyOf('F10', { shiftKey: true })]] as const) {
    tile.focus();
    assert.equal(h.doc.activeElement, tile, `control (${name}): the tile has focus`);
    h.keydown(ev);
    const last = h.shown[h.shown.length - 1];
    assert.equal(last?.node, tileNode, `${name} on a Grid tile opens that tile's menu`);
    assert.ok(last.x >= 420 && last.x <= 570 && last.y >= 260 && last.y <= 410, `${name}: at the tile (${last.x}, ${last.y})`);
    assert.equal(h.menu.style.display, 'block', `${name}: the menu shows`);
    assert.equal(h.doc.activeElement, h.menu.children[0], `${name}: focus is on its first entry`);
    assert.equal(ev.defaultPrevented, true, `${name}: and the key is the page's, not the platform's`);
    h.page.ctxMenuFocusOpener(h.page.hideCtxMenu()); // Escape, as the page's keydown handler closes the menu
    assert.equal(h.doc.activeElement, tile, `${name}: Escape gives focus back to the tile`);
  }
  // The ContextMenu key's release opens the platform's own menu on some systems: not after it opened the page's.
  tile.focus();
  h.keydown(keyOf('ContextMenu'));
  const up = keyOf('ContextMenu');
  h.keyup(up);
  assert.equal(up.defaultPrevented, true, 'the ContextMenu key\'s release after it opened the menu is the page\'s too');
  const again = keyOf('ContextMenu');
  h.keyup(again);
  assert.equal(again.defaultPrevented, false, 'and only that one');
  h.page.hideCtxMenu();

  // A row that is not itself a Tab stop opens from a control inside it — Largest Files' cart and reveal buttons — as a right-click on the button would.
  const fileNode = { path: '/Users/me/Videos/holiday-4k.mov' };
  const row = h.dom(append(h.main, h.mk('div', '', ['bigfile'])), { left: 300, top: 500, width: 600, height: 44 });
  h.onMenu(row, fileNode);
  const reveal = h.dom(append(row, h.mk('button', '', ['icon-btn'])), { left: 860, top: 507, width: 30, height: 30 });
  reveal.focus();
  assert.equal(h.doc.activeElement, reveal, 'control: the row\'s reveal button has focus');
  h.keydown(keyOf('F10', { shiftKey: true }));
  assert.equal(h.shown[h.shown.length - 1].node, fileNode, 'Shift+F10 on a button inside a Largest Files row opens the row\'s menu');
  assert.equal(h.doc.activeElement, h.menu.children[0], 'with focus on its first entry');
  h.page.ctxMenuFocusOpener(h.page.hideCtxMenu());
  assert.equal(h.doc.activeElement, reveal, 'and Escape gives focus back to the button');

  // The map: one canvas for every cell. The menu is for the cell the keyboard selected (j/k), at that cell.
  const cell = { path: '/Users/me/Archives', name: 'Archives', type: 'dir' };
  h.state.treemap.kbSel = cell;
  h.state.treemap.pxRects = [{ n: { path: '/Users/me/Other' }, x: 0, y: 0, w: 40, h: 40 }, { n: cell, x: 400, y: 20, w: 260, h: 180 }];
  h.canvas.focus();
  assert.equal(h.doc.activeElement, h.canvas, 'control: the map has focus');
  h.keydown(keyOf('ContextMenu'));
  const onMap = h.shown[h.shown.length - 1];
  assert.equal(onMap.node, cell, 'on the map, the menu is the selected cell\'s');
  assert.ok(onMap.x >= 280 + 400 && onMap.x <= 280 + 660 && onMap.y >= 300 + 20 && onMap.y <= 300 + 200, `at that cell (${onMap.x}, ${onMap.y})`);
  assert.equal(h.doc.activeElement, h.menu.children[0], 'with focus on its first entry');
  h.page.ctxMenuFocusOpener(h.page.hideCtxMenu());
  assert.equal(h.doc.activeElement, h.canvas, 'and Escape gives focus back to the map');
  // Where a right-click on the map opens nothing, neither does the key — and the key is left alone.
  const count = h.shown.length;
  for (const [why, set, unset] of [
    ['no cell is selected', () => { h.state.treemap.kbSel = null; }, () => { h.state.treemap.kbSel = cell; }],
    ['the map shows history', () => { h.state.treemap.history.active = true; }, () => { h.state.treemap.history.active = false; }],
    ['the map is a preview', () => { h.tmPreview.on = true; }, () => { h.tmPreview.on = false; }],
  ] as const) {
    set();
    const e = keyOf('ContextMenu');
    h.keydown(e);
    assert.equal(h.shown.length, count, `${why}: no menu`);
    assert.equal(e.defaultPrevented, false, `${why}: the key is the platform's`);
    unset();
  }
  // The selected cell is the Trash: a right-click opens the Trash sheet, and so does the key.
  h.state.treemap.kbSel = { ...cell, isTrash: true };
  h.state.treemap.pxRects = [{ n: h.state.treemap.kbSel, x: 400, y: 20, w: 260, h: 180 }];
  h.keydown(keyOf('F10', { shiftKey: true }));
  assert.deepEqual(h.trashSheets, [1], 'the Trash cell opens the Trash sheet, as its right-click does');
  // And the keyboard shortcuts sheet says so.
  assert.match(slice('id="shortcutsModal"', '</div>\n</div>'), /<kbd>Shift<\/kbd><kbd>F10<\/kbd><\/div><div>Open the focused item&rsquo;s menu, as a right-click does \(or the Menu key\)<\/div>/,
    'the Keyboard shortcuts sheet names the keys');
});

test('on the Sunburst, Circles and Voronoi too, the menu key opens the selected cell\'s menu inside that cell — at its arc or its own centre (review F1.6 of QA fourth pass E05)', () => {
  // Review F1.6: kbCellPoint places the keyboard's card and, since E05, its
  // menu, with one branch per renderer — and only the rectangles' was run.
  const h = keyMenuHarness();
  const CANVAS = { left: 280, top: 300 }; // the harness's canvas rect
  const big = { path: '/r/big', name: 'big', type: 'dir', size: 90 };
  const small = { path: '/r/small', name: 'small', type: 'dir', size: 10 };
  const root = { path: '/r', name: 'r', type: 'dir', size: 100, children: [big, small] };
  /** The ContextMenu key on the map with `node` selected: where its menu opened, focus then given back to the map. */
  const menuAt = (node: typeof big, why: string) => {
    h.state.treemap.kbSel = node;
    h.canvas.focus();
    const before = h.shown.length;
    h.keydown(keyOf('ContextMenu'));
    assert.equal(h.shown.length, before + 1, `${why}: the key opened a menu`);
    const at = h.shown[h.shown.length - 1];
    assert.equal(at.node, node, `${why}: the selected cell's`);
    h.page.ctxMenuFocusOpener(h.page.hideCtxMenu());
    assert.equal(h.doc.activeElement, h.canvas, `${why}: and Escape gives focus back to the map`);
    return { x: at.x - CANVAS.left, y: at.y - CANVAS.top };
  };

  // The Sunburst, its arcs as the page lays them out. "small" is a narrow arc off every diagonal, so a point read with x and y swapped falls outside it.
  type Arc = { n: unknown; a0: number; a1: number; cx: number; cy: number; rInner: number; rOuter: number };
  const arcs = (new Function('state', `'use strict'; ${braced('function layoutSunburstArcs(')} return layoutSunburstArcs;`)(
    { treemap: { hideCloud: false } }) as (r: unknown, g: unknown) => Arc[])(root, { cx: 350, cy: 200, rings: 3, innerR0: 40, ringT: 50 });
  assert.equal(arcs.length, 2, 'control: the page laid out an arc for each folder');
  Object.assign(h.state.treemap, { mode: 'sunburst', arcs, cells: [], pxRects: [] });
  for (const node of [small, big]) {
    const arc = arcs.find((a) => a.n === node)!;
    const p = menuAt(node, `Sunburst, ${node.name}`);
    const r = Math.hypot(p.x - arc.cx, p.y - arc.cy);
    const turn = 2 * Math.PI;
    const into = (((Math.atan2(p.y - arc.cy, p.x - arc.cx) - arc.a0) % turn) + turn) % turn;
    assert.ok(r >= arc.rInner && r <= arc.rOuter && into <= arc.a1 - arc.a0,
      `Sunburst, ${node.name}: the menu opens on its arc (${p.x.toFixed(0)}, ${p.y.toFixed(0)}: radius ${r.toFixed(0)} of ${arc.rInner}–${arc.rOuter}, ${into.toFixed(2)} rad into a ${(arc.a1 - arc.a0).toFixed(2)} rad arc)`);
  }

  // Circles: each cell a circle around its centre.
  const circles = [{ n: big, kind: 'circle', cx: 140, cy: 250, r: 110 }, { n: small, kind: 'circle', cx: 560, cy: 90, r: 40 }];
  Object.assign(h.state.treemap, { mode: 'circles', arcs: [], cells: circles });
  for (const cell of circles) {
    const p = menuAt(cell.n, `Circles, ${cell.n.name}`);
    assert.ok(Math.hypot(p.x - cell.cx, p.y - cell.cy) <= cell.r, `Circles, ${cell.n.name}: the menu opens inside its circle (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`);
  }

  // Voronoi: each cell a polygon, its centre the page's own centroid of it.
  const polyCentroid = new Function(`'use strict'; ${braced('function polyCentroid(')} return polyCentroid;`)() as (poly: Array<{ x: number; y: number }>) => { x: number; y: number };
  const polys = [
    { n: big, poly: [{ x: 10, y: 10 }, { x: 400, y: 10 }, { x: 380, y: 390 }, { x: 10, y: 390 }] },
    { n: small, poly: [{ x: 460, y: 30 }, { x: 640, y: 50 }, { x: 620, y: 170 }, { x: 470, y: 150 }] },
  ].map((c) => { const m = polyCentroid(c.poly); return { ...c, kind: 'poly', cx: m.x, cy: m.y }; });
  const inside = (pt: { x: number; y: number }, poly: Array<{ x: number; y: number }>) => {
    let odd = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if ((poly[i].y > pt.y) !== (poly[j].y > pt.y) && pt.x < ((poly[j].x - poly[i].x) * (pt.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) odd = !odd;
    }
    return odd;
  };
  Object.assign(h.state.treemap, { mode: 'voronoi', cells: polys });
  for (const cell of polys) {
    const p = menuAt(cell.n, `Voronoi, ${cell.n.name}`);
    assert.ok(inside(p, cell.poly), `Voronoi, ${cell.n.name}: the menu opens inside its cell (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`);
  }
});

test('the menu keys open nothing where nothing would — a field\'s own menu, a sheet over the page, an item with no menu, another key (QA fourth pass E05)', () => {
  const h = keyMenuHarness();
  const node = { path: '/r/a' };
  const tile = h.dom(append(h.main, h.mk('div', '', ['gcell'], { role: 'button', tabindex: '0' })));
  h.onMenu(tile, node);
  const cases: Array<[string, () => KeyEv]> = [
    ['F10 alone', () => { tile.focus(); return keyOf('F10'); }],
    ['Ctrl+Shift+F10', () => { tile.focus(); return keyOf('F10', { shiftKey: true, ctrlKey: true }); }],
    ['Shift+F9', () => { tile.focus(); return keyOf('F9', { shiftKey: true }); }],
    ['a sheet over the page', () => { tile.focus(); h.sheet.up = h.$('settingsModal'); return keyOf('ContextMenu'); }],
    // Inside an item that has a menu, so the key would otherwise reach that item's listener.
    ['a text field (its own Cut, Copy, Paste), even inside an item with a menu', () => {
      h.sheet.up = null;
      const box = h.dom(append(tile, h.mk('input', 'box', [], { type: 'text' })));
      box.focus();
      assert.equal(h.doc.activeElement, box, 'control: the field has focus');
      return keyOf('ContextMenu');
    }],
    ['an item with no menu (the sidebar\'s Scan button)', () => { const b = h.dom(h.$('scanBtn')); b.focus(); return keyOf('F10', { shiftKey: true }); }],
  ];
  for (const [why, arrange] of cases) {
    const e = arrange();
    h.keydown(e);
    assert.equal(h.shown.length, 0, `${why}: no menu`);
    assert.equal(e.defaultPrevented, false, `${why}: the key is left to the platform`);
  }
});

test('every right-click menu in the page has a keyboard way in: its item is a Tab stop, holds one, or is the map\'s selected cell (QA fourth pass E05)', () => {
  // The keys reach a contextmenu listener through the focused element and
  // its parents, so a listener on something no focus can reach would have
  // no keyboard way in. Each registration is named here with what makes it
  // reachable; a new one fails until it is. The page's scripts are parsed,
  // not pattern-matched, so a registration is found however it is written —
  // on any receiver ($('appsBody'), this.row), in either quotes — and every
  // other mention of the event is accounted for: an `oncontextmenu` handler
  // or attribute, or the event's name kept in a constant, is a menu this
  // sweep cannot name, and fails (review F1.7).
  const markup = INDEX.replace(/<script>[\s\S]*?<\/script>/g, '');
  assert.doesNotMatch(markup, /\soncontextmenu\s*=/i, 'no element in the markup carries an oncontextmenu attribute');
  const scripts = [...INDEX.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 2, 'control: the theme script and the app\'s');
  const found: string[] = [];
  const unplaced: string[] = [];
  for (const code of scripts) {
    const sf = ts.createSourceFile('page.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const fnOf = (n: ts.Node) => { for (let p = n.parent; p; p = p.parent) if (ts.isFunctionDeclaration(p) && p.name) return p.name.text; return '(top level)'; };
    const line = (n: ts.Node) => `${fnOf(n)}, line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${n.parent.getText(sf).slice(0, 80)}`;
    const visit = (n: ts.Node) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
        const call = n.parent;
        if (n.text === 'contextmenu' && ts.isCallExpression(call) && call.arguments[0] === n
          && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'addEventListener') {
          found.push(`${fnOf(n)}: ${call.expression.expression.getText(sf)}`);
        } else if (n.text === 'contextmenu' && ts.isNewExpression(call) && call.arguments?.[0] === n && call.expression.getText(sf) === 'MouseEvent'
          && fnOf(n) === 'ctxMenuFromKey') {
          // The menu keys' own delivery of the event, at the focused item (ctxMenuFromKey).
        } else if (n.text === 'contextmenu' || /\boncontextmenu\b/i.test(n.text)) unplaced.push(line(n));
      }
      if ((ts.isPropertyAccessExpression(n) || ts.isIdentifier(n)) && /^oncontextmenu$/i.test(ts.isPropertyAccessExpression(n) ? n.name.text : n.text)
        && !ts.isPropertyAccessExpression(n.parent)) unplaced.push(line(n));
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  assert.deepEqual(unplaced, [], 'every mention of the contextmenu event in the page is a registration this sweep names, or the menu keys\' own delivery');
  const reachable: Record<string, RegExp> = {
    'crumbsPaint: b': /<button data-p=/, // a crumb is a button (its menu is the folder's budget)
    'renderBigFiles: row': /cartButtonHtml\(f\.path, f\.name, 14\)[\s\S]*<button class="icon-btn" data-reveal=/, // holds the cart and reveal buttons
    'renderBigFolders: row': /<div class="bigfile" data-jump="[^"]*"[^>]*role="button" tabindex="0"/,
    'renderApps: row': /<div class="bp-item" role="button" tabindex="0" data-jump=/,
    'gridCell: cell': /cell\.tabIndex = 0;/,
  };
  assert.ok(found.includes('(top level): tmCanvas'), `the map's canvas has its right-click menu: ${found.join(' | ')}`);
  assert.match(INDEX, /<canvas id="treemapCanvas" tabindex="0"/, 'and the canvas is a Tab stop, whose key opens the selected cell\'s menu (tmCanvasKeyMenu)');
  for (const where of found) {
    if (where === '(top level): tmCanvas') continue;
    assert.ok(where in reachable, `${where}: a right-click menu with no keyboard way named — say what makes it reachable`);
    const fnName = where.split(':')[0];
    assert.match(braced(`function ${fnName}(`), reachable[where], `${where}: reachable from the keyboard`);
  }
  assert.equal(found.length, Object.keys(reachable).length + 1, `every registration is accounted for: ${found.join(' | ')}`);
});
