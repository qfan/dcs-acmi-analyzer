import { EXTRACTOR_VERSION, type FileAnalytics } from "./model.ts";

const DB_NAME = "tacview-analytics-cache";
const DB_VERSION = 1;
const STORE_NAME = "files";

export function fileCacheKey(file: { name: string; size: number; lastModified?: number }): string {
  return `v${EXTRACTOR_VERSION}:${file.name}:${file.size}:${file.lastModified ?? 0}`;
}

function openCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function getCachedAnalytics(cacheKey: string): Promise<FileAnalytics | null> {
  const db = await openCacheDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(cacheKey);
      req.onsuccess = () => {
        const row = req.result as { cacheKey: string; analytics: FileAnalytics } | undefined;
        if (row?.analytics && row.analytics.extractorVersion === EXTRACTOR_VERSION) {
          resolve(row.analytics);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function putCachedAnalytics(cacheKey: string, analytics: FileAnalytics): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ cacheKey, savedAt: Date.now(), analytics });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearAnalyticsCache(): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
