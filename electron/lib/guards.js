'use strict';
/*
 * Navigation and permission guards for the desktop window (Electron security
 * checklist items 5, 13, 14). Pure: no `electron` import, so the decisions
 * load under plain Node and tests/desktopPolish.test.ts drives them directly.
 *
 *  - windowOpenDecision: what `setWindowOpenHandler` should do with a URL the
 *    page wants opened. The app's own origin opens in-app; http/https/mailto
 *    go to the user's browser or mail client; every other scheme (file:,
 *    smb:, vnc:, x-apple-…, javascript:) is dropped on the floor — on macOS
 *    `shell.openExternal` would otherwise launch whatever app owns it.
 *  - navigationAllowed: the window may only ever navigate to its own server.
 *    An in-page navigation anywhere else would replace TreeMap with a page
 *    that has no back button.
 *  - permissionAllowed: the renderer gets exactly the permissions the page
 *    uses (notifications, and the sanitised clipboard write behind
 *    navigator.clipboard.writeText — "Path copied"). Electron's default is
 *    to grant everything.
 */

/** Permissions the page actually uses. Everything else is denied. */
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write']);

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function parse(url) {
  try {
    return new URL(String(url));
  } catch {
    return null;
  }
}

/**
 * @param {string} url the URL the page asked to open
 * @param {string} origin the app's own origin, e.g. "http://127.0.0.1:43210"
 * @returns {{ action: 'allow' } | { action: 'deny', openExternal?: string }}
 */
function windowOpenDecision(url, origin) {
  const u = parse(url);
  if (!u) return { action: 'deny' };
  if (u.origin === origin) return { action: 'allow' };
  if (EXTERNAL_SCHEMES.has(u.protocol)) return { action: 'deny', openExternal: u.href };
  return { action: 'deny' };
}

/** True only for the app's own origin (scheme, host AND port must match). */
function navigationAllowed(url, origin) {
  const u = parse(url);
  return !!u && u.origin === origin;
}

function permissionAllowed(permission) {
  return typeof permission === 'string' && ALLOWED_PERMISSIONS.has(permission);
}

module.exports = { ALLOWED_PERMISSIONS, windowOpenDecision, navigationAllowed, permissionAllowed };
