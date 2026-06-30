import os from 'os';
import path from 'path';
import { promises as fsp } from 'fs';

/**
 * macClean — the catalog of well-known macOS junk locations behind the
 * "Clean the Mac" view.
 *
 * Every entry is:
 *  - user-owned (no sudo, lives under the home directory),
 *  - safe to clear (apps/tools regenerate it on demand), and
 *  - reversible — the frontend trashes contents through the normal
 *    DELETE /api/files path, so everything lands in the system Trash.
 *
 * Categories are deliberately non-overlapping subtrees so a folder is never
 * counted (or offered for deletion) under two categories at once.
 */

/**
 * Cache subfolder names whose contents are NOT cheaply regenerable — clearing
 * them costs the user a real re-download or rebuild, so they're never
 * auto-selected (a "Safety Database" analog, matching how CleanMyMac excludes
 * Spotify/Gradle by default). Matched case-insensitively against the basename
 * of each `~/Library/Caches` child.
 */
export const CACHE_EXCLUDE = new Set<string>([
  'com.spotify.client', // Spotify offline song cache — re-downloads gigabytes
  'com.apple.bird', // iCloud Drive local cache — re-syncs from the cloud
  'cloudkit', // CloudKit caches
]);

export interface MacCleanCategory {
  id: string;
  title: string;
  description: string;
  /** Absolute directory this category scans and offers to clear. */
  path: string;
}

function catalog(): MacCleanCategory[] {
  const home = os.homedir();
  const j = (...parts: string[]): string => path.join(home, ...parts);

  return [
    {
      id: 'app-caches',
      title: 'Application caches',
      description: 'Caches apps rebuild on demand — clearing them just slows the next launch a little',
      path: j('Library', 'Caches'),
    },
    {
      id: 'app-logs',
      title: 'Application logs',
      description: 'Diagnostic logs written by apps and the system',
      path: j('Library', 'Logs'),
    },
    {
      id: 'xcode-derived',
      title: 'Xcode DerivedData',
      description: 'Build intermediates Xcode regenerates on the next build',
      path: j('Library', 'Developer', 'Xcode', 'DerivedData'),
    },
    {
      id: 'ios-device-support',
      title: 'iOS DeviceSupport',
      description: 'Debug symbols cached for connected iOS devices — re-fetched when needed',
      path: j('Library', 'Developer', 'Xcode', 'iOS DeviceSupport'),
    },
    {
      id: 'simulator-caches',
      title: 'Simulator caches',
      description: 'Caches left by the iOS / iPadOS simulators',
      path: j('Library', 'Developer', 'CoreSimulator', 'Caches'),
    },
    {
      id: 'npm-cache',
      title: 'npm cache',
      description: 'Downloaded npm packages — re-fetched on the next install',
      path: j('.npm', '_cacache'),
    },
  ];
}

/** Catalog entries whose directory actually exists on this machine. */
export async function resolveMacCleanCategories(): Promise<MacCleanCategory[]> {
  const present: MacCleanCategory[] = [];
  for (const category of catalog()) {
    try {
      const stat = await fsp.stat(category.path);
      if (stat.isDirectory()) present.push(category);
    } catch {
      /* not installed on this machine — skip silently */
    }
  }
  return present;
}
