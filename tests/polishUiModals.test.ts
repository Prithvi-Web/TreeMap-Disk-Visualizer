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
};

function loadModalNet(doc: FDoc): ModalApi {
  const src = slice('/* ── Focus discipline for every dialog ── */', '/* ── end focus discipline ── */');
  const $ = (id: string) => doc.getElementById(id);
  // The net installs a MutationObserver so that adding `.open` at any of the
  // thirty-two call sites is enough. Node has no DOM, and these tests drive
  // the reactions directly (setOpen calls modalOpened/modalClosed), so the
  // observer only has to exist without throwing at eval time.
  class FakeObserver { observe() { /* the tests call the reactions themselves */ } disconnect() {} }
  return new Function('document', '$', 'MutationObserver',
    `'use strict'; ${src}
     return { openModals, topModal, modalFocusTarget, modalFocusables, syncModalLayers, modalOpened, modalClosed, modalTrapTab, noteFocus };`,
  )(doc, $, FakeObserver) as ModalApi;
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

test('every backdrop is wired into the net, and the close funnel is untouched', () => {
  const net = slice('/* ── Focus discipline for every dialog ── */', '/* ── end focus discipline ── */');
  assert.match(net, /new MutationObserver\(/, 'the net observes class flips, so no caller has to change');
  assert.match(net, /querySelectorAll\('\.modal-backdrop'\)\.forEach\(\(el\) =>\s*\n?\s*\w+\.observe\(el, \{ attributes: true, attributeFilter: \['class'\]/,
    'every .modal-backdrop is observed for its class attribute');
  assert.match(net, /\.inert = /, 'inert is the mechanism, not a focusin loop alone');
  assert.match(braced('function closeModal('), /classList\.remove\('open'\)/, 'closeModal still just removes the class — the net does the rest');
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
