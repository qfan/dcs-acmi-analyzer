import { describe, expect, it } from "vitest";
import {
  BUILT_IN_PROFILES,
  DEFAULT_SETTINGS,
  migrate,
  SETTINGS_VERSION,
  sanitize,
} from "../src/settings/schema.ts";
import {
  createSettingsStore,
  exportJson,
  importJson,
  KEY_PREFIX,
  loadState,
  type StorageLike,
  saveState,
} from "../src/settings/store.ts";

class MemoryStorage implements StorageLike {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  keys() {
    return [...this.m.keys()];
  }
}

describe("settings schema", () => {
  it("fills defaults and drops junk", () => {
    expect(sanitize(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitize("garbage")).toEqual(DEFAULT_SETTINGS);
    const s = sanitize({
      units: { altitude: "m", speed: "warp", extra: 1 },
      labels: { speed: true, pilot: "yes" },
      map: { trailS: 17, playbackSpeed: 4 },
      unknownSection: { a: 1 },
    });
    expect(s.units).toEqual({ altitude: "m", speed: "kt", distance: "nm" });
    expect(s.labels.speed).toBe(true);
    expect(s.labels.pilot).toBe(true); // not a boolean: default
    expect(s.map.trailS).toBe(60); // not one of the choices: default
    expect(s.map.playbackSpeed).toBe(4);
    expect(Object.keys(s)).toEqual(["units", "labels", "map", "time"]);
  });

  it("migrates the pre-settings 2D/3D key (version 0)", () => {
    expect(sanitize(migrate({ mapMode: "3d" }, 0)).map.mode).toBe("3d");
    expect(sanitize(migrate({ mapMode: null }, 0)).map.mode).toBe("2d");
  });

  it("gives settings saved before a field existed its default (selection panel expanded)", () => {
    const old = { map: { mode: "3d", trailS: 15, groundUnits: false, playbackSpeed: 2 } };
    expect(sanitize(old).map).toEqual({ ...old.map, infoPanel: true });
    expect(sanitize({ map: { infoPanel: false } }).map.infoPanel).toBe(false);
  });
});

describe("versioned storage", () => {
  it("saves to its own version key and reads it back", () => {
    const st = new MemoryStorage();
    const s = { ...DEFAULT_SETTINGS, units: { ...DEFAULT_SETTINGS.units, altitude: "m" as const } };
    saveState(st, { settings: s, profiles: [] }, 1000);
    expect(st.keys()).toEqual([`${KEY_PREFIX}${SETTINGS_VERSION}`]);
    expect(loadState(st).settings.units.altitude).toBe("m");
  });

  it("ignores (and never overwrites) data written by a newer app version", () => {
    const st = new MemoryStorage();
    const newer = JSON.stringify({
      savedAt: 9e15,
      settings: { units: { altitude: "lightyears" } },
      profiles: [],
    });
    st.setItem(`${KEY_PREFIX}${SETTINGS_VERSION + 1}`, newer);
    saveState(st, { settings: { ...DEFAULT_SETTINGS, time: { clock: "timeOfDay" } }, profiles: [] }, 1000);
    expect(loadState(st).settings.time.clock).toBe("timeOfDay");
    expect(st.getItem(`${KEY_PREFIX}${SETTINGS_VERSION + 1}`)).toBe(newer);
  });

  it("picks up legacy keys when nothing is stored in the new format", () => {
    const st = new MemoryStorage();
    st.setItem("acmi-viewer.mapMode", "3d");
    expect(loadState(st).settings.map.mode).toBe("3d");
  });

  it("survives corrupt storage", () => {
    const st = new MemoryStorage();
    st.setItem(`${KEY_PREFIX}1`, "{not json");
    expect(loadState(st).settings).toEqual(DEFAULT_SETTINGS);
    expect(loadState(null).settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe("store and profiles", () => {
  it("updates, persists and notifies", () => {
    const st = new MemoryStorage();
    const store = createSettingsStore(st);
    let calls = 0;
    store.subscribe(() => calls++);
    store.update({ labels: { speed: true } });
    expect(store.get().settings.labels).toEqual({ ...DEFAULT_SETTINGS.labels, speed: true });
    expect(calls).toBe(1);
    expect(createSettingsStore(st).get().settings.labels.speed).toBe(true); // persisted
  });

  it("applies built-in profiles to units only, keeping other choices", () => {
    const store = createSettingsStore(new MemoryStorage());
    store.update({ map: { trailS: 15 } });
    const russian = BUILT_IN_PROFILES.find((p) => p.name.startsWith("Russian"));
    if (!russian) throw new Error("missing built-in");
    store.applyProfile(russian);
    expect(store.get().settings.units).toEqual({ altitude: "m", speed: "kmh", distance: "km" });
    expect(store.get().settings.map.trailS).toBe(15);
  });

  it("saves, loads and deletes user profiles; protects built-in names", () => {
    const st = new MemoryStorage();
    const store = createSettingsStore(st);
    store.update({ units: { altitude: "m+ft" }, map: { mode: "3d" } });
    expect(store.saveProfile("Su-27 sorties").ok).toBe(true);
    expect(store.saveProfile("NATO / Western").ok).toBe(false);
    expect(store.saveProfile("   ").ok).toBe(false);
    store.reset();
    expect(store.get().settings).toEqual(DEFAULT_SETTINGS);
    const mine = createSettingsStore(st).get().profiles;
    expect(mine.map((p) => p.name)).toEqual(["Su-27 sorties"]);
    store.applyProfile(mine[0] as (typeof mine)[number]);
    expect(store.get().settings.units.altitude).toBe("m+ft");
    expect(store.get().settings.map.mode).toBe("3d");
    store.deleteProfile("Su-27 sorties");
    expect(store.get().profiles).toEqual([]);
  });

  it("reload() re-reads storage without writing (no ping-pong between tabs)", () => {
    const st = new MemoryStorage();
    const a = createSettingsStore(st);
    const b = createSettingsStore(st);
    a.update({ time: { clock: "timeOfDay" } });
    const before = st.getItem(`${KEY_PREFIX}${SETTINGS_VERSION}`);
    b.reload();
    expect(b.get().settings.time.clock).toBe("timeOfDay");
    expect(st.getItem(`${KEY_PREFIX}${SETTINGS_VERSION}`)).toBe(before);
  });

  it("exports and imports settings files", () => {
    const store = createSettingsStore(new MemoryStorage());
    store.update({ units: { distance: "km" } });
    store.saveProfile("Mine");
    const json = exportJson(store.get());
    const back = importJson(json);
    expect(back.ok && back.state.settings.units.distance).toBe("km");
    expect(back.ok && back.state.profiles.map((p) => p.name)).toEqual(["Mine"]);
    expect(importJson("{}").ok).toBe(false);
    expect(importJson("nope").ok).toBe(false);
    const future = JSON.stringify({ format: "acmi-viewer-settings", version: SETTINGS_VERSION + 1 });
    const r = importJson(future);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/newer version/);
  });
});
