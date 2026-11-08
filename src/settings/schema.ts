/**
 * User display settings: the single source for units, labels and map options.
 *
 * SETTINGS_VERSION is the stored format version. When the format changes:
 *   1. bump SETTINGS_VERSION,
 *   2. add a step to MIGRATIONS that turns the previous version's raw data into the new shape,
 *   3. update Settings, DEFAULT_SETTINGS and sanitize().
 * sanitize() always runs last, so a migration only needs to move or rename things; anything it
 * leaves out simply falls back to its default.
 */

export const SETTINGS_VERSION = 1;

export type AltitudeUnit = "ft" | "m" | "ft+m" | "m+ft";
export type SpeedUnit = "kt" | "kmh" | "kt+kmh" | "kmh+kt";
export type DistanceUnit = "nm" | "km" | "nm+km" | "km+nm";
export type MapMode = "2d" | "3d";
export type Clock = "elapsed" | "timeOfDay";

export interface Settings {
  units: { altitude: AltitudeUnit; speed: SpeedUnit; distance: DistanceUnit };
  labels: { show: boolean; pilot: boolean; aircraft: boolean; altitude: boolean; speed: boolean };
  map: {
    mode: MapMode;
    trailS: number;
    groundUnits: boolean;
    /**
     * The play button's speed (× real time, negative = backwards), set from the speed menu or by
     * latching the jog control. 0 = not set: plays in real time.
     */
    playbackSpeed: number;
    /** Selection panel expanded (object details and engagement) or collapsed to the camera controls. */
    infoPanel: boolean;
  };
  time: { clock: Clock };
}

export const DEFAULT_SETTINGS: Settings = {
  units: { altitude: "ft", speed: "kt", distance: "nm" },
  labels: { show: true, pilot: true, aircraft: true, altitude: true, speed: false },
  map: { mode: "2d", trailS: 60, groundUnits: true, playbackSpeed: 0, infoPanel: true },
  time: { clock: "elapsed" },
};

export const ALTITUDE_UNITS: readonly AltitudeUnit[] = ["ft", "m", "ft+m", "m+ft"];
export const SPEED_UNITS: readonly SpeedUnit[] = ["kt", "kmh", "kt+kmh", "kmh+kt"];
export const DISTANCE_UNITS: readonly DistanceUnit[] = ["nm", "km", "nm+km", "km+nm"];
export const TRAIL_CHOICES = [0, 15, 60, 300] as const;
/** Fastest play speed either way (the speed menu's top preset). */
export const MAX_PLAYBACK_SPEED = 64;
/** Play speed: 0 (not set), or a finite rate up to the maximum either way, to 0.01×. */
const playSpeed = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_PLAYBACK_SPEED
    ? Math.round(v * 100) / 100
    : fallback;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const pick = <T>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

/** Turn anything (stored, imported, migrated) into valid Settings. Unknown fields are dropped. */
export function sanitize(raw: unknown): Settings {
  const r = obj(raw);
  const u = obj(r.units);
  const l = obj(r.labels);
  const m = obj(r.map);
  const t = obj(r.time);
  const d = DEFAULT_SETTINGS;
  return {
    units: {
      altitude: pick(u.altitude, ALTITUDE_UNITS, d.units.altitude),
      speed: pick(u.speed, SPEED_UNITS, d.units.speed),
      distance: pick(u.distance, DISTANCE_UNITS, d.units.distance),
    },
    labels: {
      show: bool(l.show, d.labels.show),
      pilot: bool(l.pilot, d.labels.pilot),
      aircraft: bool(l.aircraft, d.labels.aircraft),
      altitude: bool(l.altitude, d.labels.altitude),
      speed: bool(l.speed, d.labels.speed),
    },
    map: {
      mode: pick(m.mode, ["2d", "3d"] as const, d.map.mode),
      trailS: pick(m.trailS, TRAIL_CHOICES, d.map.trailS as (typeof TRAIL_CHOICES)[number]),
      groundUnits: bool(m.groundUnits, d.map.groundUnits),
      playbackSpeed: playSpeed(m.playbackSpeed, d.map.playbackSpeed),
      // Added within version 1: older stored settings simply get the default.
      infoPanel: bool(m.infoPanel, d.map.infoPanel),
    },
    time: { clock: pick(t.clock, ["elapsed", "timeOfDay"] as const, d.time.clock) },
  };
}

/**
 * Migration steps: MIGRATIONS[n] turns version-n data into version n+1.
 * Version 0 is the state before this settings store existed (a few separate localStorage keys).
 */
export const MIGRATIONS: Record<number, (raw: unknown) => unknown> = {
  0: (raw) => {
    const legacy = obj(raw);
    return { map: { mode: legacy.mapMode } };
  },
};

export function migrate(raw: unknown, fromVersion: number): unknown {
  let data = raw;
  for (let v = fromVersion; v < SETTINGS_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (step) data = step(data);
  }
  return data;
}

// --- Profiles --------------------------------------------------------------------------------

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface Profile {
  name: string;
  /** Built-in profiles can't be deleted or overwritten. */
  builtIn?: boolean;
  description?: string;
  /** Only the parts a profile sets are changed when it is applied. */
  settings: DeepPartial<Settings>;
}

export const BUILT_IN_PROFILES: Profile[] = [
  {
    name: "NATO / Western",
    builtIn: true,
    description: "Feet, knots, nautical miles",
    settings: { units: { altitude: "ft", speed: "kt", distance: "nm" } },
  },
  {
    name: "Russian / Eastern",
    builtIn: true,
    description: "Metres, km/h, kilometres",
    settings: { units: { altitude: "m", speed: "kmh", distance: "km" } },
  },
  {
    name: "Mixed (both units)",
    builtIn: true,
    description: "Feet and metres, knots and km/h, nautical miles and km",
    settings: { units: { altitude: "ft+m", speed: "kt+kmh", distance: "nm+km" } },
  },
];

/** Apply a (partial) profile on top of the current settings. */
export function applyPartial(current: Settings, partial: DeepPartial<Settings>): Settings {
  const p = obj(partial);
  const merged: Raw = {};
  for (const section of Object.keys(current) as (keyof Settings)[])
    merged[section] = { ...current[section], ...obj(p[section]) };
  return sanitize(merged);
}
