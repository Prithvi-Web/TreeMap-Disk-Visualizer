/* ───────────────────────────── Segmented controls ─────────────────────────────
   Thirteen controls in this app declare `role="tablist"` — the twelve segments
   (map layout, colour mode, duplicate mode, playback speed, Clean Up's tabs,
   the history panes, Disk City's two) plus the sidebar's own nav. Declaring
   the role is a promise about the keyboard: arrows move between the tabs,
   Home and End jump to the ends, and exactly one tab at a time is a Tab stop
   so the control is a single stop in the page's tab order rather than four.
   None of that was implemented, and a `role="tablist"` whose children answer
   nothing is worse than no role at all — a screen-reader user is told there
   is a tab list and then finds it inert.

   Nothing here changes how a tab is CHOSEN. All twelve writers keep setting
   `aria-selected` exactly as they do today; this file only reacts to it. */

/* ── Roving tabindex ── */
/* One Tab stop per list, on the selected tab — the pattern every native
   segmented control follows. A net watches `aria-selected` across the whole
   document rather than asking the twelve writers to call anything, so a list
   rendered later (Clean Up's tabs, the history panes) is covered the moment
   it appears, and a writer that forgets cannot desynchronise the keyboard. */
function tablistRovingSync(list) {
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  if (!tabs.length) return;
  const selected = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
  const stop = selected === -1 ? 0 : selected;
  tabs.forEach((t, i) => t.setAttribute('tabindex', i === stop ? '0' : '-1'));
}

const tablistNet = new MutationObserver((records) => {
  const done = new Set();
  for (const r of records) {
    const list = r.target.closest && r.target.closest('[role="tablist"]');
    if (list && !done.has(list)) { done.add(list); tablistRovingSync(list); }
  }
});
tablistNet.observe(document.body, { attributes: true, attributeFilter: ['aria-selected'], subtree: true });
document.querySelectorAll('[role="tablist"]').forEach((list) => tablistRovingSync(list));

/**
 * Arrow / Home / End inside a tab list. Returns true when it took the key.
 *
 * Selection follows focus, which is the native behaviour for a segmented
 * control (and what every writer here already does on click) — so the move
 * is `focus()` plus the element's own `click()`, and no call site changes.
 * A horizontal list ignores ↑/↓ and a vertical one ignores ←/→, so the axis
 * the list does not use still scrolls the page.
 */
function tablistKeydown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp'
      && e.key !== 'ArrowDown' && e.key !== 'Home' && e.key !== 'End') return false;
  const tab = e.target;
  if (!tab || !tab.getAttribute || tab.getAttribute('role') !== 'tab') return false;
  const list = tab.closest('[role="tablist"]');
  if (!list) return false;
  const vertical = list.getAttribute('aria-orientation') === 'vertical';
  const forward = vertical ? 'ArrowDown' : 'ArrowRight';
  const back = vertical ? 'ArrowUp' : 'ArrowLeft';
  if (e.key !== forward && e.key !== back && e.key !== 'Home' && e.key !== 'End') return false;
  // A hidden tab is not a destination: #cleanTabCloud is hidden until a cloud
  // placeholder exists, and arrowing onto it would focus nothing visible.
  const tabs = [...list.querySelectorAll('[role="tab"]')].filter((t) => !t.hidden && !t.disabled);
  if (!tabs.length) return false;
  const i = tabs.indexOf(tab);
  let next;
  if (e.key === 'Home') next = tabs[0];
  else if (e.key === 'End') next = tabs[tabs.length - 1];
  else if (i === -1) next = tabs[0];
  else if (e.key === forward) next = tabs[(i + 1) % tabs.length];
  else next = tabs[(i - 1 + tabs.length) % tabs.length];
  if (!next) return false;
  e.preventDefault();
  next.focus();
  next.click();
  return true;
}
