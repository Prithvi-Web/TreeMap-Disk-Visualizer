import { FileNode, BrowserProfileGroup, BrowserCacheItem } from '../models/types';

/**
 * browserProfiles — Feature 16. Chrome/Edge/Brave/Chromium, Firefox and Safari
 * keep well-known internal layouts. This surfaces each detected profile in the
 * scan tree with its reclaimable cache/storage areas broken out individually.
 *
 * Detection is structural and works off the already-scanned tree (so sizes are
 * exact and everything stays inside a scanned root, deletable via the normal
 * trash path): a directory is a profile when its name looks like a profile,
 * an ancestor path identifies the browser, and at least one known cache
 * sub-area is present. The HTTP-cache style areas regenerate transparently;
 * the site-data areas (IndexedDB / Local Storage) are labelled honestly so the
 * user can choose — nothing is ever pre-selected.
 */

interface SubPath {
  /** Child directory name inside the profile. */
  name: string;
  label: string;
}

/** Chromium profile cache/storage areas, in the order shown. */
const CHROMIUM_SUBPATHS: SubPath[] = [
  { name: 'Cache', label: 'HTTP Cache' },
  { name: 'Code Cache', label: 'JS Code Cache' },
  { name: 'GPUCache', label: 'GPU Cache' },
  { name: 'Service Worker', label: 'Service Worker Cache' },
  { name: 'IndexedDB', label: 'IndexedDB (site data)' },
  { name: 'Local Storage', label: 'Local Storage (site data)' },
  { name: 'Session Storage', label: 'Session Storage' },
];

/** Firefox profile cache/storage areas. */
const FIREFOX_SUBPATHS: SubPath[] = [
  { name: 'cache2', label: 'HTTP Cache' },
  { name: 'startupCache', label: 'Startup Cache' },
  { name: 'storage', label: 'Site Storage (IndexedDB / Cache)' },
  { name: 'OfflineCache', label: 'Offline Cache' },
];

const CHROMIUM_PROFILE_RE = /^(Default|Profile \d+|Guest Profile|System Profile)$/;

/** Identify the browser from any ancestor path token; null = not a browser. */
function browserFromPath(p: string): string | null {
  const s = p.toLowerCase();
  if (s.includes('bravesoftware') || s.includes('brave-browser')) return 'Brave';
  if (s.includes('microsoft edge') || s.includes('microsoft/edge') || s.includes('microsoft\\edge') || s.includes('microsoft-edge')) {
    return 'Edge';
  }
  if (s.includes('google/chrome') || s.includes('google\\chrome') || s.includes('google-chrome')) return 'Chrome';
  if (s.includes('chromium')) return 'Chromium';
  if (s.includes('firefox') || s.includes('mozilla')) return 'Firefox';
  if (s.includes('com.apple.safari') || s.includes('/safari') || s.includes('\\safari')) return 'Safari';
  return null;
}

function dirChild(node: FileNode, name: string): FileNode | undefined {
  return node.children?.find((c) => c.type === 'dir' && c.name === name);
}

/** Build a group from a profile dir given its candidate sub-areas, or null if none exist. */
function buildGroup(browser: string, profileDir: FileNode, subPaths: SubPath[]): BrowserProfileGroup | null {
  const items: BrowserCacheItem[] = [];
  for (const sp of subPaths) {
    const child = dirChild(profileDir, sp.name);
    if (child && child.size > 0) {
      items.push({ path: child.path, bytes: child.size, label: sp.label });
    }
  }
  if (!items.length) return null;
  return {
    browser,
    profile: profileDir.name,
    path: profileDir.path,
    totalBytes: items.reduce((sum, i) => sum + i.bytes, 0),
    items,
  };
}

/**
 * Walk the scan tree and surface every browser profile with reclaimable areas.
 * A profile dir is reported once and not descended into.
 */
export function collectBrowserProfiles(root: FileNode): BrowserProfileGroup[] {
  const groups: BrowserProfileGroup[] = [];
  const stack: FileNode[] = [root];

  while (stack.length) {
    const node = stack.pop()!;
    if (node.type !== 'dir') continue;

    const browser = browserFromPath(node.path);

    // Chromium-family profile dir (Default / Profile N / …) under a chromium browser.
    if (browser && browser !== 'Firefox' && browser !== 'Safari' && CHROMIUM_PROFILE_RE.test(node.name)) {
      const group = buildGroup(browser, node, CHROMIUM_SUBPATHS);
      if (group) {
        groups.push(group);
        continue; // don't descend into a claimed profile
      }
    }

    // Firefox profile dir: under a firefox/mozilla path and holding a cache2/storage area.
    if (browser === 'Firefox' && (dirChild(node, 'cache2') || dirChild(node, 'storage') || dirChild(node, 'startupCache'))) {
      const group = buildGroup('Firefox', node, FIREFOX_SUBPATHS);
      if (group) {
        groups.push(group);
        continue;
      }
    }

    // Safari (macOS): the Caches bundle is a single reclaimable area.
    if (browser === 'Safari' && /com\.apple\.safari$/i.test(node.path) && node.size > 0) {
      groups.push({
        browser: 'Safari',
        profile: 'Default',
        path: node.path,
        totalBytes: node.size,
        items: [{ path: node.path, bytes: node.size, label: 'Website Cache' }],
      });
      continue;
    }

    if (node.children) for (const c of node.children) stack.push(c);
  }

  // Biggest profiles first; stable order of items is preserved from detection.
  groups.sort((a, b) => b.totalBytes - a.totalBytes);
  return groups;
}
