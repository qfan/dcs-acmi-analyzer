import { useSyncExternalStore } from "react";
import { createSettingsStore, KEY_PREFIX, type SettingsState, type StorageLike } from "./store.ts";

function browserStorage(): StorageLike | null {
  try {
    const s = window.localStorage;
    const probe = "acmi-viewer.probe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null; // private mode or blocked storage: settings work but aren't remembered
  }
}

/** The app-wide settings store, backed by localStorage. */
export const settingsStore = createSettingsStore(typeof window === "undefined" ? null : browserStorage());

// Another tab changed the settings: re-read them (without writing back).
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key?.startsWith(KEY_PREFIX)) settingsStore.reload();
  });

export function useSettings(): SettingsState {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get);
}
