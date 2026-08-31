import path from 'path';
import { ScanStore, TreeSource, asStore } from './scanStore';
import { checkOpenHandles } from './openHandleGuard';

/**
 * mediaLibraryScanner — deep media-library awareness (§8.1).
 *
 * Photos, Final Cut Pro, iMovie, Lightroom and Capture One libraries are the
 * largest single objects on many Macs, and they are opaque bundles: a treemap
 * says "Photos Library: 300 GB" and nothing more. This splits each library
 * into the parts that mean different things to the user:
 *
 *   originals     the photos and clips themselves. The file IS the data —
 *                 deleting one loses it forever, so an originals component
 *                 never carries a removable flag, the same reasoning that
 *                 keeps a game's base install off the shader-cache list.
 *   derivatives   renders, proxies, thumbnails, previews, optimised media.
 *                 The app rebuilds every one of them from the originals, so
 *                 these are the ONLY parts ever offered — each with the cost
 *                 of regenerating it stated as prose.
 *   database      the catalog/library database. Small, and losing it loses
 *                 edits, albums and metadata; never offered.
 *
 * Detection is structural, against each app's own documented bundle layout —
 * never guessed directory names. Sizes come from the already-scanned tree;
 * nothing is read from disk at all. A bundle whose layout does not match the
 * versions documented below is reported with `recognised: false`, its total
 * size and a reason — an unknown is never a zero, and a library that cannot
 * be parsed is "unrecognised", never invisible.
 */

export type MediaApp = 'photos' | 'finalcut' | 'imovie' | 'lightroom' | 'captureone';

const APP_NAMES: Record<MediaApp, string> = {
  photos: 'Photos',
  finalcut: 'Final Cut Pro',
  imovie: 'iMovie',
  lightroom: 'Lightroom',
  captureone: 'Capture One',
};

export interface MediaComponent {
  kind: 'originals' | 'derivatives' | 'database';
  /** What this part is in the app's own vocabulary: renders, proxies, previews… */
  label: string;
  path: string;
  bytes: number;
  /**
   * Present (true) ONLY on derivative components, and withdrawn again when the
   * owning app holds the library. Originals and databases never carry it.
   */
  removable?: true;
  /** Derivatives only: what regenerating this costs, as prose. */
  regenerationCost?: string;
}

/** The open-handle probe's answer for one library, three-state like §B2. */
export interface MediaLibraryInUse {
  /** False when the probe could not run at all; `reason` then says why. */
  checked: boolean;
  /** False when the probe ran but could not cover the whole set. */
  complete: boolean;
  /**
   * Present only when checked. Deliberately absent otherwise: an unchecked
   * library must never read as "not running".
   */
  held?: boolean;
  processNames?: string[];
  reason?: string;
}

export interface MediaLibrary {
  app: MediaApp;
  appName: string;
  /** The bundle's basename (or the .lrcat file's, for Lightroom). */
  name: string;
  path: string;
  /**
   * The whole bundle for bundle apps — unclassified corners included, so the
   * number matches what the treemap shows. For Lightroom (not a bundle) it is
   * the sum of the catalog's own parts, never the photo folders beside it.
   */
  totalBytes: number;
  /** False when the layout matches no documented version; `reason` says why. */
  recognised: boolean;
  reason?: string;
  components: MediaComponent[];
  originalsBytes: number;
  derivativesBytes: number;
  databaseBytes: number;
  /** Lightroom: originals live OUTSIDE the catalog and are never claimed. */
  originalsOutside?: true;
  /** Set by guardMediaReport; absent from the raw structural scan. */
  inUse?: MediaLibraryInUse;
}

export interface MediaReport {
  libraries: MediaLibrary[];
  totalBytes: number;
  /** Regenerable derivatives across recognised libraries — all that is ever offered. */
  derivativesBytes: number;
  libraryCount: number;
  recognisedCount: number;
}

/* ────────────────────────── store helpers ────────────────────────── */

/** Case-insensitive child lookup — bundle casing is Apple's, not the user's. */
function childCI(store: ScanStore, id: number, name: string): number {
  const wanted = name.toLowerCase();
  let hit = -1;
  store.forEachChild(id, (c) => {
    if (hit === -1 && store.name(c).toLowerCase() === wanted) hit = c;
  });
  return hit;
}

interface Builder {
  components: MediaComponent[];
  add(kind: MediaComponent['kind'], label: string, store: ScanStore, id: number, parentPath: string, cost?: string): void;
}

function builder(): Builder {
  const components: MediaComponent[] = [];
  return {
    components,
    add(kind, label, store, id, parentPath, cost) {
      if (id === -1) return;
      const bytes = store.size(id);
      if (bytes <= 0) return;
      components.push({
        kind,
        label,
        path: store.childPath(id, parentPath),
        bytes,
        // The removable flag exists only on derivatives, structurally: no code
        // path can put it on an originals or database component.
        ...(kind === 'derivatives' ? { removable: true as const, regenerationCost: cost } : {}),
      });
    },
  };
}

function finishLibrary(
  app: MediaApp,
  name: string,
  libPath: string,
  totalBytes: number,
  components: MediaComponent[],
  extra?: Partial<Pick<MediaLibrary, 'originalsOutside' | 'recognised' | 'reason'>>,
): MediaLibrary {
  const sum = (kind: MediaComponent['kind']): number =>
    components.filter((c) => c.kind === kind).reduce((s, c) => s + c.bytes, 0);
  const order: Record<MediaComponent['kind'], number> = { originals: 0, derivatives: 1, database: 2 };
  components.sort((a, b) => order[a.kind] - order[b.kind] || b.bytes - a.bytes || (a.path < b.path ? -1 : 1));
  return {
    app,
    appName: APP_NAMES[app],
    name,
    path: libPath,
    totalBytes,
    recognised: true,
    components,
    originalsBytes: sum('originals'),
    derivativesBytes: sum('derivatives'),
    databaseBytes: sum('database'),
    ...extra,
  };
}

/** A bundle whose version/layout matched nothing documented below. */
function unrecognised(app: MediaApp, store: ScanStore, id: number, libPath: string, detail: string): MediaLibrary {
  return finishLibrary(app, store.name(id), libPath, store.size(id), [], {
    recognised: false,
    reason: `This ${APP_NAMES[app]} library doesn't have the layout this version of TreeMap recognises (${detail}), so only its total size is reported and nothing is offered.`,
  });
}

/* ────────────────────────── Photos ────────────────────────── */

/**
 * Photos.app `.photoslibrary` — the documented layout, by app version:
 *
 *   Photos 5+ (macOS 10.15 Catalina onward):
 *     originals/               the imported photos and videos, sharded 0–f
 *     resources/derivatives/   thumbnails and rendered previews
 *     database/                Photos.sqlite and friends
 *   Photos 1–4 kept originals under Masters/ and derivatives under
 *     resources/renders and resources/proxies.
 *
 * Recognition requires BOTH the originals home (originals/ or Masters/) and
 * database/ — a bundle missing either is some other version and gets size-only
 * treatment rather than a guessed split.
 */
function readPhotosLibrary(store: ScanStore, id: number, libPath: string): MediaLibrary {
  const originalsId = childCI(store, id, 'originals');
  const mastersId = childCI(store, id, 'masters');
  const databaseId = childCI(store, id, 'database');
  if ((originalsId === -1 && mastersId === -1) || databaseId === -1) {
    return unrecognised('photos', store, id, libPath, 'no originals/ or database/ where this version keeps them');
  }

  const b = builder();
  b.add('originals', 'original photos & videos', store, originalsId === -1 ? mastersId : originalsId, libPath);
  b.add('database', 'library database', store, databaseId, libPath);

  const resourcesId = childCI(store, id, 'resources');
  if (resourcesId !== -1) {
    const resourcesPath = store.childPath(resourcesId, libPath);
    const cost = 'Photos will rebuild thumbnails and previews on next open; expect a slow first launch while it does.';
    b.add('derivatives', 'thumbnails & previews', store, childCI(store, resourcesId, 'derivatives'), resourcesPath, cost);
    b.add('derivatives', 'renders', store, childCI(store, resourcesId, 'renders'), resourcesPath, cost);
    b.add('derivatives', 'proxies', store, childCI(store, resourcesId, 'proxies'), resourcesPath, cost);
  }
  return finishLibrary('photos', store.name(id), libPath, store.size(id), b.components);
}

/* ────────────────────────── Final Cut Pro & iMovie ────────────────────────── */

/**
 * `.fcpbundle` / `.imovielibrary` — one family, documented as:
 *
 *   CurrentVersion.flexolibrary/   the library database (FCP 10.1+; iMovie
 *                                  writes CurrentVersion.imovielibrary)
 *   <Event>/Original Media/        the clips themselves
 *   <Event>/Render Files/          rendered timelines — re-rendered on demand
 *   <Event>/Transcoded Media/      proxy and optimised media — re-created via
 *                                  File ▸ Transcode Media…
 *
 * Recognition requires the version database or at least one event with the
 * documented folders; a bundle with neither is some other layout.
 */
function readFcpFamily(store: ScanStore, id: number, libPath: string, app: 'finalcut' | 'imovie'): MediaLibrary {
  const appName = APP_NAMES[app];
  const b = builder();
  let sawEvent = false;

  store.forEachChild(id, (child) => {
    const lower = store.name(child).toLowerCase();
    if (lower === 'currentversion.flexolibrary' || lower === 'currentversion.imovielibrary') {
      b.add('database', 'library database', store, child, libPath);
      return;
    }
    if (!store.isDir(child)) return;
    const eventPath = store.childPath(child, libPath);
    const originals = childCI(store, child, 'original media');
    const renders = childCI(store, child, 'render files');
    const transcoded = childCI(store, child, 'transcoded media');
    const marker = childCI(store, child, 'currentversion.fcpevent');
    if (originals === -1 && renders === -1 && transcoded === -1 && marker === -1) return; // not an event
    sawEvent = true;
    b.add('originals', `original media (${store.name(child)})`, store, originals, eventPath);
    b.add(
      'derivatives', `render files (${store.name(child)})`, store, renders, eventPath,
      `${appName} re-renders these on demand — playback stutters until each clip re-renders` +
        (app === 'finalcut' ? ' (File ▸ Delete Generated Library Files is the supported way to clear them).' : '.'),
    );
    b.add(
      'derivatives', `transcoded media (${store.name(child)})`, store, transcoded, eventPath,
      app === 'finalcut'
        ? 'Re-create proxies and optimised media via File ▸ Transcode Media…; until then editing falls back to the originals.'
        : `${appName} re-creates optimised media as it needs it.`,
    );
  });

  if (!sawEvent && !b.components.some((c) => c.kind === 'database')) {
    return unrecognised(app, store, id, libPath, 'no CurrentVersion database and no event with Original Media / Render Files');
  }
  return finishLibrary(app, store.name(id), libPath, store.size(id), b.components);
}

/* ────────────────────────── Lightroom ────────────────────────── */

/**
 * Lightroom Classic is NOT a bundle: a `.lrcat` SQLite catalog sits in an
 * ordinary folder next to derivative stores named after it —
 * `<catalog> Previews.lrdata` and `<catalog> Smart Previews.lrdata`. The
 * photos themselves live wherever the user imports to, OUTSIDE the catalog,
 * so this library never claims an originals component and never counts the
 * folders around it — claiming a byte nobody classified would risk offering
 * someone's photo folder.
 */
function readLightroomCatalog(store: ScanStore, dirId: number, dirPath: string, catId: number): MediaLibrary {
  const catName = store.name(catId);
  const base = catName.slice(0, -'.lrcat'.length).toLowerCase();

  const components: MediaComponent[] = [
    { kind: 'database', label: 'catalog (edits, albums, metadata)', path: store.childPath(catId, dirPath), bytes: store.size(catId) },
  ];
  const claim = (suffix: string, label: string, cost: string): void => {
    const id = childCI(store, dirId, `${base} ${suffix}`);
    if (id === -1 || store.size(id) <= 0) return;
    components.push({
      kind: 'derivatives', label, path: store.childPath(id, dirPath), bytes: store.size(id),
      removable: true, regenerationCost: cost,
    });
  };
  claim('previews.lrdata', 'previews',
    'Lightroom re-renders previews as you browse; the first scroll through each folder is slower.');
  claim('smart previews.lrdata', 'smart previews',
    'Rebuild via Library ▸ Previews ▸ Build Smart Previews — until then, editing with originals offline is unavailable.');

  return finishLibrary(
    'lightroom', catName, store.childPath(catId, dirPath),
    components.reduce((s, c) => s + c.bytes, 0),
    components,
    { originalsOutside: true },
  );
}

/* ────────────────────────── Capture One ────────────────────────── */

/**
 * `.cocatalog` — documented as:
 *
 *   <name>.cocatalogdb   the catalog database (SQLite)
 *   Originals/           originals MANAGED by the catalog. Referenced
 *                        originals live outside and are never claimed.
 *   Cache/               Proxies/ and Thumbnails/ — rebuilt as images are
 *                        browsed
 *
 * Recognition requires the .cocatalogdb; a bundle without one is some other
 * layout (or a session, which has no derivative story worth guessing at).
 */
function readCaptureOneCatalog(store: ScanStore, id: number, libPath: string): MediaLibrary {
  let dbId = -1;
  store.forEachChild(id, (child) => {
    if (dbId === -1 && !store.isDir(child) && /\.cocatalogdb$/i.test(store.name(child))) dbId = child;
  });
  if (dbId === -1) {
    return unrecognised('captureone', store, id, libPath, 'no .cocatalogdb database file');
  }
  const b = builder();
  b.add('database', 'catalog database', store, dbId, libPath);
  b.add('originals', 'managed originals', store, childCI(store, id, 'originals'), libPath);
  b.add('derivatives', 'cache (thumbnails & proxies)', store, childCI(store, id, 'cache'), libPath,
    'Capture One re-creates thumbnails and proxies as images are browsed; the first pass through each folder is slower.');
  return finishLibrary('captureone', store.name(id), libPath, store.size(id), b.components);
}

/* ────────────────────────── entry point ────────────────────────── */

/** Every media library inside a completed scan, split into its documented parts. */
export function scanMediaLibraries(source: TreeSource): MediaReport {
  const store = asStore(source);
  const libraries: MediaLibrary[] = [];

  const visit = (id: number, nodePath: string): void => {
    const kids = store.childIds(id);
    const lower = store.name(id).toLowerCase();

    // Bundles are matched on their own extension — the one thing that IS the
    // bundle, wherever the user keeps it — and matched BEFORE the empty-dir
    // shortcut below: a bundle the walker could not read into (TCC denying
    // readdir inside ~/Pictures is the default macOS state without Full Disk
    // Access) arrives as a childless dir, and it must be reported at its size
    // rather than silently not exist. A matched bundle is not searched for
    // more libraries: nothing nests one inside another.
    const bundleApp = lower.endsWith('.photoslibrary') ? 'photos' as const
      : lower.endsWith('.fcpbundle') ? 'finalcut' as const
      : lower.endsWith('.imovielibrary') ? 'imovie' as const
      : lower.endsWith('.cocatalog') ? 'captureone' as const
      : null;
    if (bundleApp && !kids.length) {
      libraries.push(finishLibrary(bundleApp, store.name(id), nodePath, store.size(id), [], {
        recognised: false,
        reason: `This ${APP_NAMES[bundleApp]} library could not be read into — the scan saw the bundle but not its contents (on macOS this usually means TreeMap lacks Full Disk Access) — so only its total size is reported and nothing is offered.`,
      }));
      return;
    }
    if (!kids.length) return;
    if (bundleApp === 'photos') { libraries.push(readPhotosLibrary(store, id, nodePath)); return; }
    if (bundleApp === 'finalcut') { libraries.push(readFcpFamily(store, id, nodePath, 'finalcut')); return; }
    if (bundleApp === 'imovie') { libraries.push(readFcpFamily(store, id, nodePath, 'imovie')); return; }
    if (bundleApp === 'captureone') { libraries.push(readCaptureOneCatalog(store, id, nodePath)); return; }

    // Lightroom: any .lrcat file makes this directory host a catalog. The
    // catalog claims only its own .lrdata siblings; everything else in the
    // folder — typically the user's photos — is left alone and still visited.
    const claimed = new Set<string>();
    for (const child of kids) {
      if (store.isDir(child) || !/\.lrcat$/i.test(store.name(child))) continue;
      const lib = readLightroomCatalog(store, id, nodePath, child);
      libraries.push(lib);
      for (const c of lib.components) claimed.add(path.basename(c.path).toLowerCase());
    }

    for (const child of kids) {
      if (store.isDir(child) && !claimed.has(store.name(child).toLowerCase())) {
        visit(child, store.childPath(child, nodePath));
      }
    }
  };
  visit(store.rootId, store.rootPath);

  libraries.sort((a, b) => b.totalBytes - a.totalBytes || (a.path < b.path ? -1 : 1));
  return {
    libraries,
    totalBytes: libraries.reduce((s, l) => s + l.totalBytes, 0),
    derivativesBytes: libraries.reduce((s, l) => s + l.derivativesBytes, 0),
    libraryCount: libraries.length,
    recognisedCount: libraries.filter((l) => l.recognised).length,
  };
}

/* ────────────────────────── the running-app guard ────────────────────────── */

/**
 * Is the owning app holding any of these libraries right now?
 *
 * One §B2 batch probe over every library's classified parts (the parts, not
 * just the bundle root: a Lightroom catalog's previews are SIBLINGS of the
 * .lrcat, so probing only the library path would miss a hold on them). A held
 * library says who holds it and withdraws every removable offer — clearing
 * renders out from under a running app corrupts its view of its own library.
 *
 * Best-effort, honestly: when the probe cannot check, `checked: false` with
 * the probe's own reason, and `held` stays ABSENT so nothing reads it as "not
 * running". Offers stand in that case, mirroring the delete path's own rule —
 * refusing everything because lsof is missing would be worse — and any actual
 * delete re-runs this same guard inside Cleaner at delete time.
 */
export async function guardMediaReport(report: MediaReport): Promise<MediaReport> {
  if (report.libraries.length === 0) return report;

  const owner = new Map<string, MediaLibrary>();
  for (const lib of report.libraries) {
    owner.set(lib.path, lib);
    for (const c of lib.components) owner.set(c.path, lib);
  }
  const probe = await checkOpenHandles([...owner.keys()]);

  const heldBy = new Map<MediaLibrary, Set<string>>();
  for (const conflict of probe.conflicts) {
    const lib = owner.get(conflict.path);
    if (!lib) continue;
    let names = heldBy.get(lib);
    if (!names) { names = new Set(); heldBy.set(lib, names); }
    names.add(conflict.processName);
  }

  for (const lib of report.libraries) {
    if (!probe.checked) {
      lib.inUse = { checked: false, complete: false, reason: probe.reason };
      continue;
    }
    const names = heldBy.get(lib);
    if (!names) {
      lib.inUse = { checked: true, complete: probe.complete, held: false, ...(probe.reason ? { reason: probe.reason } : {}) };
      continue;
    }
    const list = [...names];
    const who = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
    lib.inUse = {
      checked: true,
      complete: probe.complete,
      held: true,
      processNames: list,
      reason: `${who} ${list.length === 1 ? 'has' : 'have'} this library open right now, so nothing in it is offered — quit ${list.length === 1 ? 'it' : 'them'} first.`,
    };
    for (const c of lib.components) {
      // Withdraw the offer, keep the facts: bytes and cost stay reported.
      delete c.removable;
    }
  }
  return report;
}
