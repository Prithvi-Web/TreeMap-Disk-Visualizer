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
  assert.match(fn, /for \(const v of VIEWS\)/, 'views come from the registry itself');
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
  const open = INDEX.slice(INDEX.indexOf('function cmdkOpen'), INDEX.indexOf('function cmdkOpen') + 800);
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
