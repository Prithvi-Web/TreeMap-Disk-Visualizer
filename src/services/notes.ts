import path from 'path';
import { readJsonFile, writeJsonFile } from './storage';
import { sanitizePath } from '../utils/pathSanitizer';
import { AppError } from '../middleware/errorHandler';

/**
 * Notes pinned to folders (v4 §9.5), persisted to notes.json in the app-data
 * directory — which means a read-only portable session keeps them in memory
 * only, through the same storage layer everything else uses.
 *
 * A note is more than a label. "Client archive, keep until 2027" should mean
 * something to the machine, not just to the human reading it later — so a
 * noted folder (and everything under it) is excluded from Smart Suggestions
 * and from Autopilot matching by default. The exclusion is per note and
 * toggleable: `suppress: false` keeps the words and lifts the guard.
 *
 * Two rules the tests hold directly:
 *
 *  - **Text is stored verbatim.** The frontend renders notes with
 *    `textContent`, never as HTML, so the server must not rewrite, escape or
 *    "sanitise" what the user typed — any transformation here would silently
 *    change their words.
 *  - **Suppression is subtree-wide.** A note on `projects/` covers the
 *    `node_modules` three levels down, because "keep this folder" means the
 *    folder's contents, not just its top-level entry.
 */

export interface FolderNote {
  /** Sanitized absolute path of the noted folder. */
  path: string;
  /** The user's own words, verbatim. Rendered with textContent only. */
  text: string;
  /** When true (the default), Smart Suggestions and Autopilot skip this subtree. */
  suppress: boolean;
  createdMs: number;
  updatedMs: number;
}

const NOTES_FILE = 'notes.json';
export const NOTE_MAX_CHARS = 2000;
export const MAX_NOTES = 500;

interface NoteStore {
  notes: FolderNote[];
}

/**
 * All mutations are serialized through this queue. The store is
 * read-modify-write over one small file, and two concurrent saves would
 * otherwise take turns overwriting each other's note.
 */
let writeChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

/** Path equality respecting the platform's case sensitivity (Linux only). */
function foldCase(p: string): string {
  return process.platform === 'linux' ? p : p.toLowerCase();
}

async function load(): Promise<NoteStore> {
  const store = await readJsonFile<NoteStore>(NOTES_FILE, { notes: [] });
  if (!Array.isArray(store.notes)) return { notes: [] };
  // Drop entries a hand-edit or an older version left malformed, rather than
  // letting one bad row break every consumer of the list.
  const notes = store.notes.filter(
    (n): n is FolderNote =>
      !!n && typeof n.path === 'string' && typeof n.text === 'string' && n.text.length > 0,
  );
  return {
    notes: notes.map((n) => ({
      path: n.path,
      text: n.text,
      suppress: n.suppress !== false,
      createdMs: typeof n.createdMs === 'number' ? n.createdMs : 0,
      updatedMs: typeof n.updatedMs === 'number' ? n.updatedMs : 0,
    })),
  };
}

export async function listNotes(): Promise<FolderNote[]> {
  return (await load()).notes;
}

export async function getNote(rawPath: string): Promise<FolderNote | null> {
  const p = foldCase(sanitizePath(rawPath));
  const { notes } = await load();
  return notes.find((n) => foldCase(n.path) === p) ?? null;
}

/**
 * Create or update the note on a folder.
 *
 * `suppress` omitted means: default to true on create, keep the existing
 * choice on update. Silence is "leave my setting alone", never "reset".
 */
export async function setNote(rawPath: string, text: string, suppress?: boolean): Promise<FolderNote> {
  const p = sanitizePath(rawPath);
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new AppError(400, 'NOTE_EMPTY', 'A note needs some text — to remove one, delete it instead.');
  }
  if (text.length > NOTE_MAX_CHARS) {
    throw new AppError(400, 'NOTE_TOO_LONG', `A note can hold up to ${NOTE_MAX_CHARS} characters; this one is ${text.length}.`);
  }
  return serialized(async () => {
    const store = await load();
    const now = Date.now();
    const existing = store.notes.find((n) => foldCase(n.path) === foldCase(p));
    if (existing) {
      existing.text = text;
      if (suppress !== undefined) existing.suppress = suppress;
      existing.updatedMs = now;
      await writeJsonFile(NOTES_FILE, store);
      return { ...existing };
    }
    if (store.notes.length >= MAX_NOTES) {
      throw new AppError(400, 'NOTES_FULL', `The note store holds up to ${MAX_NOTES} notes. Delete one you no longer need first.`);
    }
    const note: FolderNote = { path: p, text, suppress: suppress ?? true, createdMs: now, updatedMs: now };
    store.notes.push(note);
    await writeJsonFile(NOTES_FILE, store);
    return { ...note };
  });
}

/** Remove a folder's note. Returns whether one existed. */
export async function deleteNote(rawPath: string): Promise<boolean> {
  const p = foldCase(sanitizePath(rawPath));
  return serialized(async () => {
    const store = await load();
    const before = store.notes.length;
    store.notes = store.notes.filter((n) => foldCase(n.path) !== p);
    if (store.notes.length === before) return false;
    await writeJsonFile(NOTES_FILE, store);
    return true;
  });
}

/** The paths whose notes suppress suggestions — the list every matcher checks. */
export async function suppressedNoteRoots(): Promise<string[]> {
  const { notes } = await load();
  return notes.filter((n) => n.suppress).map((n) => path.resolve(n.path));
}

/**
 * Is `p` at or under any of `roots`? Boundary-safe: `/a/bc` is not under
 * `/a/b`. Case rules follow the platform, like `samePath` in osPaths.
 */
export function isUnderAny(p: string, roots: string[]): boolean {
  if (roots.length === 0) return false;
  const target = foldCase(path.resolve(p));
  for (const root of roots) {
    const r = foldCase(path.resolve(root));
    if (target === r) return true;
    const withSep = r.endsWith(path.sep) ? r : r + path.sep;
    if (target.startsWith(withSep)) return true;
  }
  return false;
}
