import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * v4 §9.1 — the command palette (⌘K / Ctrl+K).
 *
 * Two halves. The fuzzy scorer is a pure function, so it is EXTRACTED from
 * index.html and executed here — determinism and ranking are behaviour, not
 * structure (the searchQuery frontend/backend agreement test set this
 * precedent). Everything else — every view reachable, focus restored, ⌘K
 * actually rebound from global search — is held structurally, in the
 * frontendContract style, because the failure mode is a refactor quietly
 * dropping an entry nobody decided to drop.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** Pull one top-level function out of the app script and instantiate it. */
function extractFunction(name: string): (...args: unknown[]) => unknown {
  const start = INDEX.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists in index.html`);
  const end = INDEX.indexOf('\nfunction ', start + 1);
  const src = INDEX.slice(start, end === -1 ? INDEX.length : end);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${src}; return ${name};`)() as (...args: unknown[]) => unknown;
}

/* ══════════════════════ The fuzzy scorer, as behaviour ══════════════════════ */

test('cmdkScore is deterministic and case-insensitive', () => {
  const score = extractFunction('cmdkScore') as (q: string, label: string) => number | null;
  const a = score('tre', 'Treemap');
  const b = score('tre', 'Treemap');
  assert.equal(a, b, 'same inputs, same score — twice');
  assert.equal(score('TRE', 'treemap'), score('tre', 'TREEMAP'), 'case never matters');
  assert.ok(a !== null && (a as number) > 0, 'a real match scores');
});

test('cmdkScore refuses non-matches rather than inventing a weak one', () => {
  const score = extractFunction('cmdkScore') as (q: string, label: string) => number | null;
  assert.equal(score('xyz', 'Treemap'), null, 'letters that never appear do not match');
  assert.equal(score('pamt', 'map'), null, 'a query longer than its target cannot match');
});

test('cmdkScore ranks word-start and consecutive matches above scattered ones', () => {
  const score = extractFunction('cmdkScore') as (q: string, label: string) => number | null;
  const prefix = score('tree', 'Treemap')!;
  const scattered = score('tree', 'The Reclaim Engine Editor')!;
  assert.ok(prefix > scattered, `a clean prefix (${prefix}) beats letters scattered across words (${scattered})`);
  const wordStart = score('dc', 'Disk City')!;
  const midWord = score('dc', 'wildcard')!;
  assert.ok(wordStart > midWord, 'initials at word starts beat letters buried mid-word');
});

test('an empty query matches everything neutrally, so the palette can list all', () => {
  const score = extractFunction('cmdkScore') as (q: string, label: string) => number | null;
  assert.notEqual(score('', 'Anything'), null);
});

/* ══════════════════════ The registry, structurally ══════════════════════ */

test('every view is reachable: palette items are built FROM the view registry', () => {
  // Completeness by construction: the palette iterates VIEWS rather than
  // keeping its own list, so a view added tomorrow is in the palette the
  // same day, and one removed cannot linger as a dead entry.
  const start = INDEX.indexOf('function cmdkItems');
  assert.notEqual(start, -1, 'cmdkItems exists');
  const fn = INDEX.slice(start, start + 4000);
  assert.match(fn, /for \(const v of cmdkViewOrder\(VIEWS, /, 'views come from the registry itself, in the sidebar\'s order (QA D68)');
  assert.match(fn, /viewBlockedReason/, 'a capability-blocked view shows its reason instead of vanishing');
});

test('the core actions exist by name', () => {
  const start = INDEX.indexOf('const CMDK_ACTIONS');
  assert.notEqual(start, -1, 'the action registry exists');
  const reg = INDEX.slice(start, INDEX.indexOf('function cmdkItems'));
  for (const label of [
    'Scan a folder', 'Rescan', 'Empty the cleanup cart', 'Export the map as PNG',
    'Search all indexed files', 'Open Settings', 'Keyboard shortcuts',
    'Switch light / dark', 'Ask in plain words',
  ]) {
    assert.ok(reg.includes(label), `action "${label}" is registered`);
  }
});

test('the Open Settings row promises only what Settings holds', () => {
  // Its hint said "schedules, weights, notes and more", and hints are scored
  // when a label misses — so typing "notes" offered Settings, which has no
  // notes (a folder's note is written from the map, with n). Every word of the
  // hint must be a Settings section or one of that section's own words, which
  // CMDK_SETTINGS_SECTIONS is already held to (the real headings).
  const reg = INDEX.slice(INDEX.indexOf('const CMDK_ACTIONS'), INDEX.indexOf('const CMDK_SETTINGS_SECTIONS'));
  const row = /\{ label: 'Open Settings', hint: '([^']+)'/.exec(reg);
  assert.ok(row, 'the action carries a hint');
  const at = INDEX.indexOf('const CMDK_SETTINGS_SECTIONS');
  const sections = INDEX.slice(at, INDEX.indexOf('];', at)).toLowerCase();
  const terms = row![1].replace(/\s+and more$/, '').split(/,\s*|\s+and\s+/).map((t) => t.trim()).filter(Boolean);
  assert.ok(terms.length >= 3, `the hint names what is there: ${row![1]}`);
  for (const term of terms) {
    const stem = term.toLowerCase().replace(/s$/, '');
    assert.ok(sections.includes(stem), `"${term}" is not a Settings section or one of its words`);
  }
});

test('saved views and recent scan roots join the palette when they exist', () => {
  const fn = INDEX.slice(INDEX.indexOf('function cmdkItems'), INDEX.indexOf('function cmdkItems') + 4000);
  assert.match(fn, /state\.savedViews/, 'saved views are listed');
  assert.match(fn, /cmdkRoots/, 'recent roots are listed');
});

test('free text that matches nothing still offers a file search, so no dead ends', () => {
  const render = INDEX.slice(INDEX.indexOf('function cmdkRender'), INDEX.indexOf('function cmdkRender') + 3000);
  assert.match(render, /Search files for/, 'the fallback row exists');
});

/* ══════════════════════ Keys, focus, accessibility ══════════════════════ */

test('⌘K opens the palette now — global search moved to its own key and a palette row', () => {
  // Anchored on the toggle pair, because the palette's modal-scoped key
  // handler earlier in the file legitimately maps ⌘K to close-while-open.
  const at = INDEX.indexOf('else cmdkOpen();');
  assert.notEqual(at, -1, '⌘K opens the palette (§9.1 assigns the key explicitly)');
  const branch = INDEX.slice(at - 300, at + 60);
  assert.match(branch, /cmdkClose\(\);/, 'and pressing it again toggles closed');
  assert.ok(!branch.includes('summonGlobalSearch'), 'and no longer summons global search directly');
  // The rail button must not keep advertising the old binding.
  assert.ok(!INDEX.includes('title="Search (⌘K)"'), 'the search button stopped claiming ⌘K');
});

test('the palette restores focus to where it was — §9.1 says so explicitly', () => {
  const open = INDEX.slice(INDEX.indexOf('function cmdkOpen()'), INDEX.indexOf('function cmdkOpen()') + 800);
  assert.match(open, /cmdkPrevFocus = document\.activeElement/, 'focus is remembered on open');
  const close = INDEX.slice(INDEX.indexOf('function cmdkClose'), INDEX.indexOf('function cmdkClose') + 800);
  assert.match(close, /cmdkPrevFocus[\s\S]{0,120}\.focus\(\)/, 'and restored on close');
});

test('arrow keys, Enter and Escape are handled on the palette input', () => {
  const keys = INDEX.slice(INDEX.indexOf("$('cmdkInput').addEventListener('keydown'"), INDEX.indexOf("$('cmdkInput').addEventListener('keydown'") + 1400);
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
    assert.ok(keys.includes(key), `${key} is handled`);
  }
});

test('the palette is announced properly to assistive tech', () => {
  assert.match(INDEX, /id="cmdkInput"[^>]*role="combobox"/s, 'the input is a combobox');
  const input = INDEX.slice(INDEX.indexOf('id="cmdkInput"') - 300, INDEX.indexOf('id="cmdkInput"') + 400);
  assert.match(input, /aria-controls="cmdkList"/);
  assert.match(INDEX, /id="cmdkList"[^>]*role="listbox"/s, 'results are a listbox');
  const modal = INDEX.slice(INDEX.indexOf('id="cmdkModal"') - 200, INDEX.indexOf('id="cmdkModal"') + 200);
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /aria-modal="true"/);
});

test('the shortcuts panel teaches the new keys', () => {
  assert.ok(/⌘K[\s\S]{0,160}[Cc]ommand palette|[Cc]ommand palette[\s\S]{0,160}⌘K/.test(INDEX)
    || INDEX.includes('<kbd>⌘K</kbd></div><div>Command palette'),
    'the shortcuts panel names the palette');
});

/* ═══════════ QA driver findings (round 1) ═══════════ */

test('recent roots read the field the API actually serves — no [object Object] rows', () => {
  const fn = INDEX.slice(INDEX.indexOf('async function cmdkLoadRoots'), INDEX.indexOf('async function cmdkLoadRoots') + 700);
  assert.match(fn, /r\.rootPath === 'string'/, 'listSnapshotRoots serves rootPath, and only a string is accepted');
  assert.ok(!fn.includes('String(r)'), 'nothing coerces an object into a label');
});

test('an empty palette browses everything; only typed queries trim to twelve', () => {
  const fn = INDEX.slice(INDEX.indexOf('function cmdkRender'), INDEX.indexOf('function cmdkRender') + 1600);
  assert.match(fn, /q \? 12 : scored\.length/, 'the cap applies to searches, not to browsing');
});

test('opening the palette clears any hovering tooltip first', () => {
  const fn = INDEX.slice(INDEX.indexOf('function cmdkOpen()'), INDEX.indexOf('function cmdkOpen()') + 400);
  assert.match(fn, /hideTooltip\(\)/, 'a stale hover card must not float above the palette');
});

/* ═══════════ Final-audit findings ═══════════ */

test('deep settings are searchable, and every listed section is a real heading', () => {
  // §9.1's stated why includes "deep settings": typing "weights" must land
  // on the Reclaim sliders. The list is held to the ACTUAL headings so a
  // renamed section cannot leave a palette row scrolling to nothing.
  const at = INDEX.indexOf('const CMDK_SETTINGS_SECTIONS');
  assert.notEqual(at, -1, 'the settings sections are indexed');
  const src = INDEX.slice(at, INDEX.indexOf('];', at));
  const names = [...src.matchAll(/name: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 10, `a real list, not a token one (${names.length})`);
  for (const name of names) {
    const re = new RegExp(`class="set-h"[^>]*>(?:<span[^>]*></span>)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    assert.ok(re.test(INDEX), `"${name}" is a real Settings heading`);
  }
  const items = INDEX.slice(INDEX.indexOf('function cmdkItems'), INDEX.indexOf('function cmdkItems') + 4000);
  assert.match(items, /CMDK_SETTINGS_SECTIONS/, 'and they join the palette');
  const opener = INDEX.slice(INDEX.indexOf('function cmdkOpenSettingsSection'), INDEX.indexOf('function cmdkOpenSettingsSection') + 700);
  assert.match(opener, /scrollIntoView/, 'landing scrolls the section into view');
});

test('Clean Up is reachable from the palette — it is a surface, not a view, and was invisible', () => {
  const reg = INDEX.slice(INDEX.indexOf('const CMDK_ACTIONS'), INDEX.indexOf('function cmdkOpenSettingsSection'));
  assert.ok(reg.includes('Open Clean Up'), 'the Clean Up surface has a palette door');
  assert.ok(reg.includes("$('cleanupBtn').click()"), 'through its own real button');
});

test('typing a setting WORD finds its section — hints are a scoring fallback', () => {
  // Driven proof turned structural: "weights" has no subsequence in
  // "Settings: Reclaim Score", so labels alone left the audit's example
  // dead. Hints join the match at a discount.
  const render = INDEX.slice(INDEX.indexOf('function cmdkRender'), INDEX.indexOf('function cmdkRender') + 1800);
  assert.match(render, /cmdkScore\(q, item\.hint\)/, 'hints are scored when the label misses');
  assert.match(render, /hs - 8/, 'at a discount, so label matches always outrank them');
  const sections = INDEX.slice(INDEX.indexOf('const CMDK_SETTINGS_SECTIONS'), INDEX.indexOf('];', INDEX.indexOf('const CMDK_SETTINGS_SECTIONS')));
  assert.match(sections, /weights/, 'the Reclaim section is findable by its famous word');
  assert.match(sections, /schedule/, 'and schedules by theirs');
});

/* ═══════════ The Undo Vault rename (review F1.7) ═══════════ */

/** The page's cmdkScore and cmdkAliasMatch together, and the settings sections defined beside them. */
function aliasScoring(): {
  cmdkScore: (q: string, label: string) => number | null;
  cmdkAliasMatch: (q: string, aliases: unknown) => boolean;
  sections: { name: string; hint: string; aliases?: string[] }[];
} {
  const pick = (name: string): string => {
    const start = INDEX.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} exists in index.html`);
    const end = INDEX.indexOf('\nfunction ', start + 1);
    return INDEX.slice(start, end === -1 ? INDEX.length : end);
  };
  // cmdkAliasMatch's slice runs on through the action and settings registries, which are plain
  // data here (their run/when functions are never called).
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${pick('cmdkScore')}\n${pick('cmdkAliasMatch')}\n` +
    'return { cmdkScore, cmdkAliasMatch, sections: CMDK_SETTINGS_SECTIONS };')();
}

test('a returning user finds the Undo Vault by the name it had before 5.2.0, which the palette never shows', () => {
  const { cmdkScore, cmdkAliasMatch, sections } = aliasScoring();
  const settings = sections.find((s) => s.name === 'Undo Vault');
  assert.ok(settings, 'the Settings section is listed');
  const view = /registerView\(\{\s+id: 'capsule',\s+label: 'Undo Vault',(?:(?!registerView\(|mount\(\))[\s\S])*?paletteAliases: (\[[^\]]*\]),/.exec(INDEX);
  assert.ok(view, 'the view registers the words the palette finds it by');
  const viewAliases = JSON.parse(view![1].replace(/'/g, '"')) as string[];

  for (const [where, label, hint, aliases] of [
    ['the view', 'Undo Vault', 'view', viewAliases],
    ['the Settings section', 'Settings: Undo Vault', settings!.hint, settings!.aliases],
  ] as const) {
    // On screen it is the Undo Vault only: neither its label nor its hint answers the old word…
    assert.equal(cmdkScore('capsule', label), null, `${where}'s label never shows the old word`);
    assert.equal(cmdkScore('capsule', hint), null, `${where}'s hint never shows the old word`);
    // …but the old name still finds it: as one word or two, in any case, hyphenated, in the
    // plural, inside a longer phrase, or begun with three letters or more of either word — a
    // beginning typed with a hyphen or an underscore too.
    for (const typed of ['time capsule', 'Time Capsule', 'timecapsule', 'time-capsule', 'time_capsule', 'time capsules',
      'Time-Capsules', 'time capsule backup', 'capsule', 'capsules', 'caps', 'cap', 'time', 'tim', 'time-caps', 'Time_Cap']) {
      assert.equal(cmdkAliasMatch(typed, aliases), true, `typing "${typed}" finds ${where}`);
    }
    // Letters scattered through the old name, or too few to begin a word, find nothing (review F2.1, F2.5).
    for (const typed of ['map', 'tap', 'ape', 'mes', 'ps', 'ue', 'a p', 'mule', 'sul', 'ime', 'mec', 'tc', 'mc', 'ti', 'ca',
      'times', 'weights', '', '   ']) {
      assert.equal(cmdkAliasMatch(typed, aliases), false, `typing "${typed}" does not find ${where}`);
    }
  }
  assert.equal(cmdkAliasMatch('capsule', undefined), false, 'an entry with no aliases matches nothing through them');
});

/**
 * The text of the declaration that starts at `at` in the page, through the bracket that closes
 * the first `open` after it. Only that one kind of bracket is counted, so a ( or [ inside a string
 * or a comment of a function body cannot end it early.
 */
function declarationAt(at: number, open: string, close: string): string {
  assert.notEqual(at, -1, 'the declaration is in the page');
  let depth = 0;
  for (let i = INDEX.indexOf(open, at); i < INDEX.length; i++) {
    if (INDEX[i] === open) depth++;
    else if (INDEX[i] === close && --depth === 0) return INDEX.slice(at, i + 1);
  }
  return assert.fail(`the declaration at ${at} closes its ${open}`);
}

/** Every place `head` starts in the page. */
function everyIndexOf(head: string): number[] {
  const out: number[] = [];
  for (let at = INDEX.indexOf(head); at !== -1; at = INDEX.indexOf(head, at + 1)) out.push(at);
  return out;
}

/**
 * The palette as shipped, driven rather than read: the page's own view registry (the built-in
 * views and every registerView call, so a view's aliases arrive the way the page gives them), its
 * action and settings registries, and cmdkItems, cmdkRender, the scorers and escapeHtml as they
 * are, over a stub input box and list. No scan is open, so actions that need one are left out, as
 * on a fresh start. Typing returns the labels of the rows listed, in order, their hints, and each
 * row's HTML.
 */
function paletteAsShipped(): (typed: string) => { rows: string[]; hints: string[]; html: string[] } {
  const views = declarationAt(INDEX.indexOf('const VIEWS = ['), '[', ']');
  const registrations = everyIndexOf('registerView({').map((at) => `${declarationAt(at, '{', '}')})`);
  assert.ok(registrations.some((r) => r.includes("id: 'capsule'")), 'the Undo Vault view is registered with registerView');
  const registries = ['CMDK_ACTIONS', 'CMDK_SETTINGS_SECTIONS'].map((name) => `${declarationAt(INDEX.indexOf(`const ${name} = [`), '[', ']')};`);
  const functions = ['escapeHtml', 'cmdkScore', 'cmdkAliasMatch', 'cmdkViewOrder', 'cmdkItems', 'cmdkRender']
    .map((name) => declarationAt(INDEX.indexOf(`function ${name}(`), '{', '}'));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`'use strict';
    ${views};
    function registerView(view) { VIEWS.push(view); }
    ${registrations.join(';\n')};
    const state = { cart: new Set(), root: null, scanning: false, view: 'dashboard', savedViews: [] };
    const tabs = [];
    const cmdkRoots = [];
    let cmdkSel = 0;
    let cmdkShown = [];
    const input = { value: '', setAttribute() {}, removeAttribute() {} };
    const list = { innerHTML: '', querySelectorAll() { return []; } };
    function $(id) { return id === 'cmdkInput' ? input : id === 'cmdkList' ? list : null; }
    function viewBlockedReason() { return null; }
    ${registries.join('\n')}
    ${functions.join('\n')}
    return (typed) => {
      input.value = typed;
      cmdkRender();
      return { rows: cmdkShown.map((item) => item.label), hints: cmdkShown.map((item) => item.hint || ''),
        html: list.innerHTML.split('</button>').filter(Boolean) };
    };`)();
}

test('typed into the palette as shipped, the old name lists the Undo Vault and its Settings section, and no row spells it', () => {
  // Driven, not read (review F2.2): a source check of cmdkRender stayed green when the alias line
  // was moved below the line that skips a row with no match, which made the alias dead.
  const type = paletteAsShipped();
  assert.ok(type('').rows.includes('Undo Vault') && type('').rows.includes('Settings: Undo Vault'), 'an empty box lists both, by their names');
  for (const typed of ['time capsule', 'Time Capsule', 'timecapsule', 'capsule']) {
    const { rows, html } = type(typed);
    assert.ok(rows.includes('Undo Vault'), `typing "${typed}" lists the Undo Vault view: ${JSON.stringify(rows)}`);
    assert.ok(rows.includes('Settings: Undo Vault'), `typing "${typed}" lists its Settings section: ${JSON.stringify(rows)}`);
    assert.equal(rows[rows.length - 1], `Search files for “${typed}”`, 'and the free-text row still closes the list');
    for (const row of html.slice(0, -1)) {
      assert.doesNotMatch(row, /capsule/i, `no row the palette found spells the old word, typed or not: ${row}`);
    }
  }
  assert.ok(!type('weights').rows.some((label) => label === 'Undo Vault'), 'the view answers only to its own words');
});

test('a word the palette never shows is held to more than scattered letters, and the rows it finds come after every row whose own words matched', () => {
  // Review F2.1 and F2.5: matched as a subsequence, the hidden "timecapsule" listed both Undo Vault
  // rows for "map" (m-a-p sits in t-i-m-e-c-a-p-s-u-l-e), "tap" or "mes", with nothing on the row to
  // say why, and ranked them above rows whose own label matched; while "time-capsule" and
  // "time capsules" found nothing.
  const type = paletteAsShipped();
  const score = extractFunction('cmdkScore') as (q: string, label: string) => number | null;
  const vault = ['Undo Vault', 'Settings: Undo Vault'];
  /** The rows listed for `typed` that nothing on screen explains: neither label nor hint matches. */
  const unexplained = (typed: string): string[] => {
    const { rows, hints } = type(typed);
    return rows.slice(0, -1).filter((label, i) => score(typed, label) === null && score(typed, hints[i]) === null);
  };

  assert.deepEqual(type('map').rows.filter((label) => vault.includes(label)), [], 'typing "map" lists no Undo Vault row');
  for (const typed of ['map', 'tap', 'ape', 'mes', 'ps', 'ue', 'a p', 'mule', 'sul', 'ime', 'mec', 'tc', 'mc', 'ti', 'ca', 'times']) {
    assert.deepEqual(unexplained(typed), [], `typing "${typed}" lists only rows whose own label or hint matched`);
  }

  for (const typed of ['time capsule', 'Time Capsule', 'timecapsule', 'TimeCapsule', 'time-capsule', 'Time-Capsule', 'time_capsule',
    'time capsules', 'Time-Capsules', 'capsules', 'capsule', 'caps', 'cap', 'time', 'time capsule backup', 'my time capsule']) {
    const { rows } = type(typed);
    for (const label of vault) assert.ok(rows.includes(label), `typing "${typed}" lists ${label}: ${JSON.stringify(rows)}`);
  }

  for (const typed of ['time', 'cap']) {
    const { rows, hints } = type(typed);
    const hidden = unexplained(typed);
    assert.deepEqual(hidden, vault, `typing "${typed}" finds both Undo Vault rows only by the old name`);
    const explained = rows.slice(0, -1).map((label, i) => ({ label, i })).filter(({ label, i }) => score(typed, label) !== null || score(typed, hints[i]) !== null);
    assert.ok(explained.length > 0, `typing "${typed}" also matches rows by their own words`);
    for (const { label, i } of explained) {
      assert.ok(i < rows.indexOf(hidden[0]), `typing "${typed}": "${label}", which matched by its own words, comes before the Undo Vault rows: ${JSON.stringify(rows)}`);
    }
  }
});
