/**
 * The last recording the viewer opened, kept in this browser (IndexedDB) so a refresh reopens it,
 * and so the game can hand a fight over to the viewer. Nothing leaves the browser.
 *
 * IndexedDB rather than localStorage because recordings are often several megabytes. Every call is
 * best-effort: in a private window or with storage blocked it quietly does nothing.
 */

const DB_NAME = "tacview-web-viewer";
const STORE = "files";
const KEY = "last";
/** Larger files are not cached (they still open, just not after a refresh). */
export const MAX_CACHED_BYTES = 150 * 1024 * 1024;

export interface CachedFile {
  name: string;
  blob: Blob;
  savedAt: number;
  /** Where it came from: "viewer" (opened here) or "game" (sent by the BVR trainer). */
  source: "viewer" | "game";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Remembers a file as the last one opened. Returns false if it was not stored. */
export async function saveLastFile(blob: Blob, name: string, source: CachedFile["source"]): Promise<boolean> {
  if (blob.size > MAX_CACHED_BYTES) return false;
  try {
    const value: CachedFile = { name, blob, savedAt: Date.now(), source };
    await withStore("readwrite", (s) => s.put(value, KEY));
    return true;
  } catch {
    return false;
  }
}

export async function loadLastFile(): Promise<CachedFile | null> {
  try {
    const v = (await withStore("readonly", (s) => s.get(KEY))) as CachedFile | undefined;
    return v && v.blob instanceof Blob && typeof v.name === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function forgetLastFile(): Promise<void> {
  try {
    await withStore("readwrite", (s) => s.delete(KEY));
  } catch {
    // Nothing stored or storage blocked: nothing to forget.
  }
}
