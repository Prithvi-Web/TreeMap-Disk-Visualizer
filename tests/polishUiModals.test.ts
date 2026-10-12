import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
};

type FDoc = {
  activeElement: FEl | null; body: FEl; root: FEl;
  querySelectorAll(sel: string): FEl[]; querySelector(sel: string): FEl | null; getElementById(id: string): FEl | null;
  addEventListener(): void;
};

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
        // A hidden or inert element cannot take focus — the browser's rule.
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
  const cancel = append(confirmFoot, mk('button', 'confirmCancel', ['btn']));
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
  return new Function('document', '$', 'MutationObserver', 'toastsRetire',
    `'use strict'; ${src}
     return { openModals, topModal, modalFocusTarget, modalFocusables, syncModalLayers, modalOpened, modalClosed, modalTrapTab, noteFocus,
       inModalOverlay, modalFocusInto };`,
  )(doc, $, FakeObserver, toastsRetire) as ModalApi;
}

/** Open or close a backdrop the way every caller does — by class — then run the net's reaction. */
function setOpen(api: ModalApi, el: FEl, open: boolean) {
  el.classList.toggle('open', open); el.shown = open;
  if (open) api.modalOpened(el); else api.modalClosed(el);
  api.syncModalLayers();
}

/* ══════════════ a11y-keyboard-1 — every dialog takes, traps and returns focus ══════════════ */

test('opening a dialog moves focus to its primary action — Enter confirms a Trash sheet', () => {
  const doc = makeDoc();
  const p = pageWith(doc);
  const api = loadModalNet(doc);
  p.pageBtn.focus(); api.noteFocus(p.pageBtn);
  setOpen(api, p.confirm, true);
  assert.equal(doc.activeElement, p.ok, 'focus lands on the danger button, so Enter confirms');
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
  assert.equal(doc.activeElement, p.ok);
  // The browser drops focus to <body> when the focused button stops painting.
  doc.activeElement = doc.body;
  setOpen(api, p.confirm, false);
  assert.equal(doc.activeElement, p.pageBtn, 'focus returns to the control that opened the sheet');
  assert.equal(p.main.inert, false, 'inert is lifted with the last dialog');
  assert.equal(p.side.inert, false);
});

test('a dialog with no primary focuses the sheet itself, and Tab cycles inside it', () => {
  const doc = makeDoc();
  const p = pageWith(doc);
  const api = loadModalNet(doc);
  p.settingsSave.disabled = true; // nothing to confirm yet
  setOpen(api, p.settings, true);
  assert.equal(doc.activeElement, p.settingsDlg, 'the sheet takes focus when it has no enabled primary');
  assert.equal(p.settingsDlg.getAttribute('tabindex'), '-1', 'and it was made focusable without joining the Tab order');
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

test('stacked dialogs: the lower sheet goes inert and focus returns to it, not the page', () => {
  const doc = makeDoc();
  const p = pageWith(doc);
  const api = loadModalNet(doc);
  p.pageBtn.focus(); api.noteFocus(p.pageBtn);
  setOpen(api, p.settings, true);
  assert.equal(doc.activeElement, p.settingsSave);
  api.noteFocus(p.settingsSave);
  setOpen(api, p.confirm, true);
  assert.equal(api.topModal(), p.confirm, 'the later sheet is on top');
  assert.equal(p.settings.inert, true, 'the sheet underneath cannot be tabbed into');
  assert.equal(doc.activeElement, p.ok);
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
  assert.equal(doc.activeElement, p.settingsSave, 'control: the sheet took focus');
  api.noteFocus(p.settingsSave);
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
  assert.equal(doc.activeElement, p.ok, 'control: the top sheet took focus');
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
function breakdownHarness() {
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
  };
  const fact = { score: 82, confidence: 'high', components: [], missing: [] };
  const panel = new Function('document', '$', 'window', 'CSS', 'scoreFor', 'scoreKnown', 'toast', 'escapeHtml', 'reclaimColor', 'icon',
    'reclaimWhyHtml', 'reclaimRadarAxes', 'RC_AXIS_ORDER', 'FxCharts', 'ctxTarget', 'topModal', 'inModalOverlay', 'modalFocusInto',
    `'use strict'; ${slice('/* ── the popover ── */', '/* ── sorting ──')}\nreturn { openReclaimWhy, closeReclaimWhy };`,
  )(document, (id: string) => doc.getElementById(id), { innerWidth: 1280, innerHeight: 800 }, { escape: (s: string) => s },
    () => fact, () => true, () => {}, (s: string) => s, () => '#3a3', () => '', () => '', () => [], [], { radar: () => ({ destroy() {} }) }, null,
    api.topModal, api.inModalOverlay, api.modalFocusInto,
  ) as { openReclaimWhy: (path: string, anchor: FEl) => void; closeReclaimWhy: () => void };
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
  const fn = braced('function cartDockToggle(');
  const doc = makeDoc();
  const mk = mkOf(doc);
  const dock = append(doc.body, mk('div', 'cartDock'));
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
