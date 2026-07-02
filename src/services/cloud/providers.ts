import { FileNode, ScanResult } from '../../models/types';
import { getSettings } from '../settings';
import { freshAccessToken } from './oauth';
import { AppError } from '../../middleware/errorHandler';

/**
 * cloud/providers — Google Drive, Dropbox and OneDrive behind one interface.
 * Every provider lists the account's full file tree via its METADATA API
 * only — no file contents are ever downloaded — and maps deletes to the
 * provider's own trash/recycle bin, mirroring the local trash-only rule.
 *
 * Base URLs are env-overridable (TM_<ID>_API / _AUTH_URL / _TOKEN_URL) so
 * the whole pipeline can be exercised against a local mock in tests.
 */

export type CloudProviderId = 'gdrive' | 'dropbox' | 'onedrive';

export interface CloudQuota {
  used: number;
  total: number;
}

export interface CloudProvider {
  id: CloudProviderId;
  name: string;
  authUrl: string;
  tokenUrl: string;
  scope: string;
  /** Google's desktop-client tokens also want the (non-confidential) secret. */
  needsClientSecret: boolean;
  extraAuthParams?: Record<string, string>;
  trashLabel: string;
  account(token: string): Promise<string>;
  quota(token: string): Promise<CloudQuota>;
  listTree(token: string, scan: ScanResult): Promise<FileNode>;
  trash(token: string, cloudId: string): Promise<void>;
}

const env = (key: string, fallback: string): string => process.env[key] || fallback;

/** No single provider call may hang the scan — hard timeout per request. */
const FETCH_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;

/**
 * When (and how long) to wait before retrying a failed provider call.
 * Returns null for "don't retry". Honors Retry-After; treats 429, 5xx and
 * Google's rate-limit-flavored 403s as transient. Pure — tested.
 */
export function retryDelayMs(status: number, attempt: number, retryAfter: string | null, bodyText: string): number | null {
  if (attempt >= MAX_ATTEMPTS) return null;
  const rateLimited403 = status === 403 && /rate.?limit(ed)?|userratelimit|quotaexceeded/i.test(bodyText);
  if (status !== 429 && status < 500 && !rateLimited403) return null;
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra > 0) return Math.min(30_000, ra * 1000);
  return Math.min(20_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function apiJson(url: string, token: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let lastNetworkError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      });
    } catch (err) {
      // Network blip or timeout — transient by definition.
      lastNetworkError = err instanceof Error ? (err.name === 'TimeoutError' ? 'timed out' : err.message) : String(err);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw new AppError(502, 'CLOUD_NETWORK', `Couldn't reach the provider (${lastNetworkError.slice(0, 120)}) — check your connection and try again`);
    }
    if (resp.status === 401) throw new AppError(401, 'CLOUD_AUTH', 'The provider rejected the sign-in — reconnect in Settings');
    if (!resp.ok && resp.status !== 204) {
      const text = (await resp.text().catch(() => '')).slice(0, 300);
      const delay = retryDelayMs(resp.status, attempt, resp.headers.get('retry-after'), text);
      if (delay !== null) {
        await sleep(delay);
        continue;
      }
      throw new AppError(502, 'CLOUD_API', `The provider returned ${resp.status}: ${text.slice(0, 200)}`);
    }
    if (resp.status === 204) return {};
    return (await resp.json()) as Record<string, unknown>;
  }
  throw new AppError(502, 'CLOUD_API', 'The provider kept rate-limiting — try again in a minute');
}

export function cloudRootPath(id: CloudProviderId): string {
  return `cloud://${id}`;
}

const node = (name: string, path: string, size: number, dir: boolean, cloudId?: string): FileNode => ({
  name,
  path,
  size: dir ? 0 : size,
  type: dir ? 'dir' : 'file',
  modifiedAt: 0,
  isHidden: name.startsWith('.'),
  ...(dir ? { children: [] as FileNode[] } : {}),
  ...(cloudId ? { cloudId } : {}),
  ...(dir ? {} : (() => {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? { extension: name.slice(dot + 1).toLowerCase() } : {};
  })()),
});

/** Bottom-up dir sizing + counters, shared by all mappers. */
function finalizeTree(root: FileNode, scan?: ScanResult): FileNode {
  let files = 0;
  let dirs = 0;
  const sum = (n: FileNode): number => {
    if (n.type === 'file') { files++; return n.size; }
    dirs++;
    let t = 0;
    for (const c of n.children ?? []) t += sum(c);
    n.size = t;
    return t;
  };
  sum(root);
  if (scan) {
    scan.fileCount = files;
    scan.dirCount = dirs - 1 + 1; // root included, matching disk scans
    scan.scanned = files + dirs;
  }
  return root;
}

/* ================= Google Drive ================= */

interface GDriveFile {
  id: string;
  name: string;
  size?: string;
  parents?: string[];
  mimeType: string;
}

/** Pure mapper: Drive file list → tree (exported for tests). */
export function gdriveFilesToTree(files: GDriveFile[], rootId: string | null): FileNode {
  const rootPath = cloudRootPath('gdrive');
  const root = node('Google Drive', rootPath, 0, true);
  const byId = new Map<string, FileNode>();
  const meta = new Map<string, GDriveFile>();
  for (const f of files) {
    const isDir = f.mimeType === 'application/vnd.google-apps.folder';
    byId.set(f.id, node(f.name, '', Number(f.size ?? 0), isDir, f.id));
    meta.set(f.id, f);
  }
  const orphans = node('Shared & orphaned', rootPath + '/Shared & orphaned', 0, true);
  for (const [id, n] of byId) {
    const parentId = meta.get(id)!.parents?.[0];
    const parent = parentId ? (parentId === rootId ? root : byId.get(parentId)) : null;
    const target = parent && parent.type === 'dir' ? parent : parent === root ? root : orphans;
    (target === root || target === orphans ? target : parent!).children!.push(n);
  }
  if (orphans.children!.length) root.children!.push(orphans);
  // Paths are assigned after linking (children know their parents now).
  const assign = (n: FileNode, base: string): void => {
    for (const c of n.children ?? []) {
      c.path = `${base}/${c.name.replace(/\//g, '∕')}`; // slashes in cloud names would break paths
      if (c.type === 'dir') assign(c, c.path);
    }
  };
  assign(root, rootPath);
  return finalizeTree(root);
}

const gdrive: CloudProvider = {
  id: 'gdrive',
  name: 'Google Drive',
  authUrl: env('TM_GDRIVE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
  tokenUrl: env('TM_GDRIVE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
  scope: 'https://www.googleapis.com/auth/drive',
  needsClientSecret: true,
  extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  trashLabel: 'Google Drive trash',
  async account(token) {
    const about = await apiJson(env('TM_GDRIVE_API', 'https://www.googleapis.com/drive/v3') + '/about?fields=user(emailAddress)', token);
    return String((about.user as Record<string, unknown> | undefined)?.emailAddress ?? 'Google account');
  },
  async quota(token) {
    const about = await apiJson(env('TM_GDRIVE_API', 'https://www.googleapis.com/drive/v3') + '/about?fields=storageQuota', token);
    const q = (about.storageQuota ?? {}) as Record<string, string>;
    return { used: Number(q.usage ?? 0), total: Number(q.limit ?? 0) };
  },
  async listTree(token, scan) {
    const base = env('TM_GDRIVE_API', 'https://www.googleapis.com/drive/v3');
    const rootMeta = await apiJson(`${base}/files/root?fields=id`, token);
    const files: GDriveFile[] = [];
    let pageToken = '';
    do {
      const url = new URL(`${base}/files`);
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('q', 'trashed=false');
      url.searchParams.set('spaces', 'drive');
      url.searchParams.set('fields', 'nextPageToken,files(id,name,size,parents,mimeType)');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await apiJson(url.toString(), token);
      files.push(...((page.files ?? []) as GDriveFile[]));
      scan.scanned = files.length;
      scan.currentPath = `Google Drive — ${files.length.toLocaleString()} items listed`;
      pageToken = String(page.nextPageToken ?? '');
      if (scan.cancelled) throw new AppError(499, 'CANCELLED', 'Scan cancelled');
    } while (pageToken);
    return finalizeTree(gdriveFilesToTree(files, String(rootMeta.id ?? '') || null), scan);
  },
  async trash(token, cloudId) {
    await apiJson(`${env('TM_GDRIVE_API', 'https://www.googleapis.com/drive/v3')}/files/${encodeURIComponent(cloudId)}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ trashed: true }),
    });
  },
};

/* ================= Dropbox ================= */

interface DropboxEntry {
  '.tag': 'file' | 'folder' | 'deleted';
  id?: string;
  path_display?: string;
  size?: number;
}

/** Pure mapper: Dropbox entries (path-based) → tree (exported for tests). */
export function dropboxEntriesToTree(entries: DropboxEntry[]): FileNode {
  const rootPath = cloudRootPath('dropbox');
  const root = node('Dropbox', rootPath, 0, true);
  const dirs = new Map<string, FileNode>([['', root]]);
  const dirFor = (rel: string): FileNode => {
    const hit = dirs.get(rel);
    if (hit) return hit;
    const parent = dirFor(rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const d = node(name, `${rootPath}/${rel}`, 0, true);
    parent.children!.push(d);
    dirs.set(rel, d);
    return d;
  };
  for (const e of entries) {
    if (!e.path_display || e['.tag'] === 'deleted') continue;
    const rel = e.path_display.replace(/^\/+/, '');
    if (!rel) continue;
    if (e['.tag'] === 'folder') {
      dirFor(rel);
    } else {
      const parent = dirFor(rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      const f = node(name, `${rootPath}/${rel}`, e.size ?? 0, false, e.id);
      parent.children!.push(f);
    }
  }
  return finalizeTree(root);
}

const dropbox: CloudProvider = {
  id: 'dropbox',
  name: 'Dropbox',
  authUrl: env('TM_DROPBOX_AUTH_URL', 'https://www.dropbox.com/oauth2/authorize'),
  tokenUrl: env('TM_DROPBOX_TOKEN_URL', 'https://api.dropboxapi.com/oauth2/token'),
  scope: 'files.metadata.read files.content.write account_info.read',
  needsClientSecret: false,
  extraAuthParams: { token_access_type: 'offline' },
  trashLabel: 'Dropbox deleted files (recoverable on dropbox.com)',
  async account(token) {
    const me = await apiJson(env('TM_DROPBOX_API', 'https://api.dropboxapi.com/2') + '/users/get_current_account', token, { method: 'POST', body: 'null' });
    return String((me.email as string | undefined) ?? 'Dropbox account');
  },
  async quota(token) {
    const u = await apiJson(env('TM_DROPBOX_API', 'https://api.dropboxapi.com/2') + '/users/get_space_usage', token, { method: 'POST', body: 'null' });
    const alloc = (u.allocation ?? {}) as Record<string, unknown>;
    return { used: Number(u.used ?? 0), total: Number(alloc.allocated ?? 0) };
  },
  async listTree(token, scan) {
    const base = env('TM_DROPBOX_API', 'https://api.dropboxapi.com/2');
    const entries: DropboxEntry[] = [];
    let resp = await apiJson(`${base}/files/list_folder`, token, {
      method: 'POST',
      body: JSON.stringify({ path: '', recursive: true, limit: 2000 }),
    });
    for (;;) {
      entries.push(...((resp.entries ?? []) as DropboxEntry[]));
      scan.scanned = entries.length;
      scan.currentPath = `Dropbox — ${entries.length.toLocaleString()} items listed`;
      if (scan.cancelled) throw new AppError(499, 'CANCELLED', 'Scan cancelled');
      if (!resp.has_more) break;
      resp = await apiJson(`${base}/files/list_folder/continue`, token, {
        method: 'POST',
        body: JSON.stringify({ cursor: resp.cursor }),
      });
    }
    return finalizeTree(dropboxEntriesToTree(entries), scan);
  },
  async trash(token, cloudId) {
    await apiJson(env('TM_DROPBOX_API', 'https://api.dropboxapi.com/2') + '/files/delete_v2', token, {
      method: 'POST',
      body: JSON.stringify({ path: cloudId }),
    });
  },
};

/* ================= OneDrive ================= */

interface OneDriveItem {
  id: string;
  name: string;
  size?: number;
  folder?: unknown;
  parentReference?: { id?: string };
  root?: unknown;
  deleted?: unknown;
}

/** Pure mapper: OneDrive delta items → tree (exported for tests). */
export function onedriveItemsToTree(items: OneDriveItem[]): FileNode {
  const rootPath = cloudRootPath('onedrive');
  const root = node('OneDrive', rootPath, 0, true);
  const byId = new Map<string, FileNode>();
  let rootId: string | null = null;
  for (const it of items) {
    if (it.deleted) continue;
    if (it.root !== undefined) { rootId = it.id; continue; }
    byId.set(it.id, node(it.name, '', it.size ?? 0, it.folder !== undefined, it.id));
  }
  for (const it of items) {
    if (it.deleted || it.root !== undefined) continue;
    const n = byId.get(it.id);
    if (!n) continue;
    const parentId = it.parentReference?.id;
    const parent = parentId && parentId !== rootId ? byId.get(parentId) : root;
    (parent && parent.type === 'dir' ? parent : root).children!.push(n);
  }
  const assign = (n: FileNode, base: string): void => {
    for (const c of n.children ?? []) {
      c.path = `${base}/${c.name.replace(/\//g, '∕')}`;
      if (c.type === 'dir') assign(c, c.path);
    }
  };
  assign(root, rootPath);
  return finalizeTree(root);
}

const onedrive: CloudProvider = {
  id: 'onedrive',
  name: 'OneDrive',
  authUrl: env('TM_ONEDRIVE_AUTH_URL', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'),
  tokenUrl: env('TM_ONEDRIVE_TOKEN_URL', 'https://login.microsoftonline.com/common/oauth2/v2.0/token'),
  scope: 'Files.ReadWrite offline_access User.Read',
  needsClientSecret: false,
  trashLabel: 'OneDrive recycle bin',
  async account(token) {
    const me = await apiJson(env('TM_ONEDRIVE_API', 'https://graph.microsoft.com/v1.0') + '/me?$select=userPrincipalName', token);
    return String((me.userPrincipalName as string | undefined) ?? 'Microsoft account');
  },
  async quota(token) {
    const d = await apiJson(env('TM_ONEDRIVE_API', 'https://graph.microsoft.com/v1.0') + '/me/drive?$select=quota', token);
    const q = (d.quota ?? {}) as Record<string, number>;
    return { used: Number(q.used ?? 0), total: Number(q.total ?? 0) };
  },
  async listTree(token, scan) {
    const base = env('TM_ONEDRIVE_API', 'https://graph.microsoft.com/v1.0');
    const items: OneDriveItem[] = [];
    let url = `${base}/me/drive/root/delta?$select=id,name,size,folder,parentReference,root,deleted&$top=1000`;
    for (;;) {
      const page = await apiJson(url, token);
      items.push(...((page.value ?? []) as OneDriveItem[]));
      scan.scanned = items.length;
      scan.currentPath = `OneDrive — ${items.length.toLocaleString()} items listed`;
      if (scan.cancelled) throw new AppError(499, 'CANCELLED', 'Scan cancelled');
      const next = page['@odata.nextLink'];
      if (typeof next !== 'string') break;
      url = next;
    }
    return finalizeTree(onedriveItemsToTree(items), scan);
  },
  async trash(token, cloudId) {
    const base = env('TM_ONEDRIVE_API', 'https://graph.microsoft.com/v1.0');
    await apiJson(`${base}/me/drive/items/${encodeURIComponent(cloudId)}`, token, { method: 'DELETE' });
  },
};

/* ================= registry ================= */

export const PROVIDERS: Record<CloudProviderId, CloudProvider> = { gdrive, dropbox, onedrive };

export function providerById(id: string): CloudProvider {
  const p = PROVIDERS[id as CloudProviderId];
  if (!p) throw new AppError(400, 'UNKNOWN_PROVIDER', `Unknown cloud provider "${id}"`);
  return p;
}

/** Client credentials the user saved in Settings (bring-your-own app keys). */
export async function credentialsFor(provider: CloudProvider): Promise<{ clientId: string; clientSecret?: string }> {
  const settings = await getSettings();
  const creds = settings.cloud?.[provider.id];
  if (!creds?.clientId) {
    throw new AppError(400, 'NO_CLIENT_ID', `Add your ${provider.name} app's client ID in Settings first`);
  }
  return { clientId: creds.clientId, clientSecret: creds.clientSecret || undefined };
}

/** Access token, refreshed if needed — the one gateway every call goes through. */
export async function tokenFor(provider: CloudProvider, force = false): Promise<string> {
  const { clientId, clientSecret } = await credentialsFor(provider);
  return freshAccessToken(provider.id, provider.tokenUrl, clientId, clientSecret, force);
}
