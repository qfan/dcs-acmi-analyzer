import type { AltitudeUnit, DistanceUnit, Settings, SpeedUnit } from "./schema.ts";

/**
 * Formatting for the user's chosen units. Every number shown on screen goes through here.
 * Two-unit choices ("ft+m") show the first unit, then the second in brackets.
 */

const FT = 3.28084;
const KT = 1.943844;
const KMH = 3.6;
export const NM_M = 1852;

const int = (v: number) => Math.round(v).toLocaleString("en-US");
const both = (a: string, b: string) => `${a} (${b})`;

export function fmtAlt(m: number | null, u: AltitudeUnit): string {
  if (m === null || !Number.isFinite(m)) return "–";
  const ft = `${int(m * FT)} ft`;
  const me = `${int(m)} m`;
  return u === "ft" ? ft : u === "m" ? me : u === "ft+m" ? both(ft, me) : both(me, ft);
}

/** Compact altitude for map labels: "20.4k ft", "6,220 m". */
export function fmtAltShort(m: number, u: AltitudeUnit): string {
  if (!Number.isFinite(m)) return "";
  const ft = `${Math.round((m * FT) / 100) / 10}k ft`;
  const me = `${int(Math.round(m / 10) * 10)} m`;
  return u === "ft" ? ft : u === "m" ? me : u === "ft+m" ? `${ft} / ${me}` : `${me} / ${ft}`;
}

export function fmtSpeed(ms: number | null, u: SpeedUnit): string {
  if (ms === null || !Number.isFinite(ms)) return "–";
  const kt = `${int(ms * KT)} kt`;
  const kmh = `${int(ms * KMH)} km/h`;
  return u === "kt" ? kt : u === "kmh" ? kmh : u === "kt+kmh" ? both(kt, kmh) : both(kmh, kt);
}

export function fmtSpeedShort(ms: number, u: SpeedUnit): string {
  if (!Number.isFinite(ms)) return "";
  const kt = `${int(ms * KT)} kt`;
  const kmh = `${int(ms * KMH)} km/h`;
  return u === "kt" ? kt : u === "kmh" ? kmh : u === "kt+kmh" ? `${kt} / ${kmh}` : `${kmh} / ${kt}`;
}

export function fmtDist(m: number | null, u: DistanceUnit): string {
  if (m === null || !Number.isFinite(m)) return "–";
  const nm = m < 0.95 * NM_M ? `${(m / NM_M).toFixed(2)} nm` : `${(m / NM_M).toFixed(1)} nm`;
  const km = m < 1000 ? `${int(m)} m` : `${(m / 1000).toFixed(1)} km`;
  return u === "nm" ? nm : u === "km" ? km : u === "nm+km" ? both(nm, km) : both(km, nm);
}

/** Short distances (miss distance) follow the altitude unit: feet or metres. */
export function fmtShortDist(m: number, u: AltitudeUnit): string {
  const ft = `${int(m * FT)} ft`;
  const me = `${int(m)} m`;
  return u === "ft" ? ft : u === "m" ? me : u === "ft+m" ? both(ft, me) : both(me, ft);
}

/** Vertical speed follows the altitude unit: feet per minute, or metres per second. */
export function fmtVz(ms: number, u: AltitudeUnit): string {
  const fpm = `${int(Math.abs(ms) * FT * 60)} ft/min`;
  const mps = `${int(Math.abs(ms))} m/s`;
  return u === "ft" ? fpm : u === "m" ? mps : u === "ft+m" ? both(fpm, mps) : both(mps, fpm);
}

/** Metres in one unit of the (first) distance unit: grid lines and scale bars use it. */
export function distanceUnitM(u: DistanceUnit): number {
  return u.startsWith("nm") ? NM_M : 1000;
}
export function distanceUnitName(u: DistanceUnit): "nm" | "km" {
  return u.startsWith("nm") ? "nm" : "km";
}

/** Map label from the chosen fields, e.g. "QFAN F-16C_50 · 20.4k ft · 344 kt". */
export function labelText(
  pilot: string,
  name: string,
  altM: number,
  speedMs: number,
  s: Pick<Settings, "labels" | "units">,
): string {
  const who = [s.labels.pilot ? pilot : "", s.labels.aircraft || !pilot ? name : ""]
    .filter(Boolean)
    .join(" ");
  const parts = [who];
  if (s.labels.altitude && Number.isFinite(altM)) parts.push(fmtAltShort(altM, s.units.altitude));
  if (s.labels.speed && Number.isFinite(speedMs)) parts.push(fmtSpeedShort(speedMs, s.units.speed));
  return parts.filter(Boolean).join(" · ");
}
