import {
  applyPartial,
  BUILT_IN_PROFILES,
  DEFAULT_SETTINGS,
  type DeepPartial,
  migrate,
  type Profile,
  SETTINGS_VERSION,
  type Settings,
  sanitize,
} from "./schema.ts";

/**
 * Persistent settings store.
 *
 * Each stored format version has its own localStorage key ("acmi-viewer.settings.v1", ".v2", …),
 * holding { savedAt, settings, profiles }. On load the app takes the most recently saved key whose
 * version it understands and migrates it forward. It never touches keys from newer versions, so going
 * back to an older app version and forward again loses nothing.
 */

export const KEY_PREFIX = "acmi-viewer.settings.v";
/** Keys used before this store existed; read once by the version-0 migration. */
const LEGACY_KEYS = { mapMode: "acmi-viewer.mapMode" };

export interface StoredEnvelope {
  savedAt: number;
  settings: unknown;
  profiles: unknown;
}

export interface SettingsState {
  settings: Settings;
  /** User profiles (built-ins come from BUILT_IN_PROFILES). */
  profiles: Profile[];
}

/** Minimal Storage interface so tests can use an in-memory store. */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export function loadState(storage: StorageLike | null): SettingsState {
  const empty: SettingsState = { settings: DEFAULT_SETTINGS, profiles: [] };
  if (!storage) return empty;
  let best: { version: number; env: StoredEnvelope } | null = null;
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(KEY_PREFIX)) continue;
      const version = Number(key.slice(KEY_PREFIX.length));
      if (!Number.isInteger(version) || version < 1 || version > SETTINGS_VERSION) continue;
      const env = parseEnvelope(storage.getItem(key));
      if (!env) continue;
      if (
        !best ||
        env.savedAt > best.env.savedAt ||
        (env.savedAt === best.env.savedAt && version > best.version)
      )
        best = { version, env };
    }
    if (best) {
      return {
        settings: sanitize(migrate(best.env.settings, best.version)),
        profiles: sanitizeProfiles(best.env.profiles, best.version),
      };
    }
    // Nothing stored yet in the new format: pick up older separate keys.
    const legacy = { mapMode: storage.getItem(LEGACY_KEYS.mapMode) };
    return { settings: sanitize(migrate(legacy, 0)), profiles: [] };
  } catch {
    return empty;
  }
}

export function saveState(storage: StorageLike | null, state: SettingsState, now = Date.now()): boolean {
  if (!storage) return false;
  const env: StoredEnvelope = { savedAt: now, settings: state.settings, profiles: state.profiles };
  try {
    storage.setItem(`${KEY_PREFIX}${SETTINGS_VERSION}`, JSON.stringify(env));
    return true;
  } catch {
    return false; // quota or privacy mode: settings just aren't remembered
  }
}

function parseEnvelope(text: string | null): StoredEnvelope | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<StoredEnvelope>;
    if (!v || typeof v !== "object") return null;
    return {
      savedAt: typeof v.savedAt === "number" ? v.savedAt : 0,
      settings: v.settings,
      profiles: v.profiles,
    };
  } catch {
    return null;
  }
}

function sanitizeProfiles(raw: unknown, version: number): Profile[] {
  if (!Array.isArray(raw)) return [];
  const out: Profile[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const name = (p as { name?: unknown }).name;
    if (typeof name !== "string" || !name.trim() || name.length > 60) continue;
    if (BUILT_IN_PROFILES.some((b) => b.name === name) || out.some((o) => o.name === name)) continue;
    // User profiles are full snapshots: migrate and sanitize them like the current settings.
    out.push({
      name: name.trim(),
      settings: sanitize(migrate((p as { settings?: unknown }).settings, version)),
    });
    if (out.length >= 50) break;
  }
  return out;
}

// --- Export / import -----------------------------------------------------------------------------

export const EXPORT_FORMAT = "acmi-viewer-settings";

export function exportJson(state: SettingsState): string {
  return JSON.stringify(
    { format: EXPORT_FORMAT, version: SETTINGS_VERSION, settings: state.settings, profiles: state.profiles },
    null,
    2,
  );
}

export type SettingsErrorCode =
  | "invalidJson"
  | "notSettingsFile"
  | "newerVersion"
  | "emptyProfileName"
  | "profileNameTooLong"
  | "builtInProfileName";

export function importJson(
  text: string,
): { ok: true; state: SettingsState } | { ok: false; error: string; errorCode: SettingsErrorCode } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "This file is not valid JSON.", errorCode: "invalidJson" };
  }
  const r = raw as { format?: unknown; version?: unknown; settings?: unknown; profiles?: unknown };
  if (!r || typeof r !== "object" || r.format !== EXPORT_FORMAT)
    return { ok: false, error: "This is not an ACMI Viewer settings file.", errorCode: "notSettingsFile" };
  const version = typeof r.version === "number" ? r.version : 1;
  if (version > SETTINGS_VERSION)
    return {
      ok: false,
      error: "These settings come from a newer version of the viewer. Please update it first.",
      errorCode: "newerVersion",
    };
  return {
    ok: true,
    state: {
      settings: sanitize(migrate(r.settings, version)),
      profiles: sanitizeProfiles(r.profiles, version),
    },
  };
}

// --- Live store ------------------------------------------------------------------------------------

export interface SettingsStore {
  get(): SettingsState;
  subscribe(fn: () => void): () => void;
  update(partial: DeepPartial<Settings>): void;
  applyProfile(p: Profile): void;
  saveProfile(name: string): { ok: boolean; error?: string; errorCode?: SettingsErrorCode };
  deleteProfile(name: string): void;
  replace(state: SettingsState): void;
  reset(): void;
  /** Re-read storage without writing back (another tab changed it). */
  reload(): void;
}

export function createSettingsStore(storage: StorageLike | null): SettingsStore {
  let state = loadState(storage);
  const listeners = new Set<() => void>();
  const commit = (next: SettingsState) => {
    state = next;
    saveState(storage, state);
    for (const fn of listeners) fn();
  };
  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update(partial) {
      commit({ ...state, settings: applyPartial(state.settings, partial) });
    },
    applyProfile(p) {
      commit({ ...state, settings: applyPartial(state.settings, p.settings) });
    },
    saveProfile(name) {
      const n = name.trim();
      if (!n) return { ok: false, error: "Give the profile a name.", errorCode: "emptyProfileName" };
      if (n.length > 60)
        return { ok: false, error: "That name is too long.", errorCode: "profileNameTooLong" };
      if (BUILT_IN_PROFILES.some((b) => b.name === n))
        return {
          ok: false,
          error: "That name belongs to a built-in profile.",
          errorCode: "builtInProfileName",
        };
      const others = state.profiles.filter((p) => p.name !== n);
      commit({ ...state, profiles: [...others, { name: n, settings: state.settings }] });
      return { ok: true };
    },
    deleteProfile(name) {
      commit({ ...state, profiles: state.profiles.filter((p) => p.name !== name) });
    },
    replace(next) {
      commit(next);
    },
    reset() {
      commit({ ...state, settings: DEFAULT_SETTINGS });
    },
    reload() {
      // No save here: saving would fire a storage event in the other tab and loop forever.
      state = loadState(storage);
      for (const fn of listeners) fn();
    },
  };
}
