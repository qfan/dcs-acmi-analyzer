import type { AcmiObject, Recording } from "../acmi/model.ts";
import { T_YAW } from "../acmi/tracks.ts";
import type { Analysis } from "../analysis/analyze.ts";

/**
 * Compact, transferable data for the 2D map, built in the worker.
 *
 * Positions are projected to flat metres around the centre of the action (equirectangular:
 * x east, y north). Over a theatre a few hundred km wide the distortion is well under 1%.
 * Samples are thinned to at most one per MIN_SAMPLE_GAP_S. All samples live in five shared
 * typed arrays so the whole thing transfers to the UI thread without copying.
 */

export type MapKind = "air" | "heli" | "ground" | "sea" | "weapon" | "chute" | "bullseye";

export interface MapTrack {
  uid: number;
  kind: MapKind;
  /** Tacview colour name (Red, Blue, …) or "". */
  side: string;
  name: string;
  /** Pilot names over time (most objects have one entry or none). */
  pilots: { t: number; name: string }[];
  t0: number;
  /** Removal time, or the end of the recording. */
  t1: number;
  removed: boolean;
  /** Index of the first sample in the shared arrays, and sample count. */
  start: number;
  count: number;
}

export interface MapKill {
  time: number;
  x: number;
  y: number;
  victimUid: number;
  cause: string;
}

export interface MapData {
  lon0: number;
  lat0: number;
  timeStart: number;
  timeEnd: number;
  tracks: MapTrack[];
  times: Float64Array;
  x: Float32Array;
  y: Float32Array;
  /** Altitude MSL in metres (NaN if unknown). */
  alt: Float32Array;
  /** Heading in degrees clockwise from north (NaN if unknown). */
  hdg: Float32Array;
  kills: MapKill[];
  /** Initial view: the area where aircraft and weapons were (falls back to everything). */
  focus: { minX: number; minY: number; maxX: number; maxY: number };
}

export const MIN_SAMPLE_GAP_S = 0.25;
const EARTH_R = 6371008.8;
const DEG = Math.PI / 180;

export function mapKind(o: AcmiObject): MapKind | null {
  const t = o.tags;
  const has = (x: string) => t.includes(x);
  if (has("Bullseye")) return "bullseye";
  if (has("Projectile") || has("Misc") || has("Decoy") || has("Shrapnel")) return null;
  if (has("Parachutist")) return "chute";
  if (has("Weapon")) return "weapon";
  if (has("Air")) return has("Rotorcraft") ? "heli" : "air";
  if (has("Sea")) return "sea";
  if (has("Ground") && !has("Aerodrome")) return "ground";
  return null;
}

export function buildMapData(rec: Recording, analysis: Analysis | null): MapData {
  const skip = new Set(analysis?.scrambled.uids ?? []);
  const picked: { o: AcmiObject; kind: MapKind }[] = [];
  for (const o of rec.objects) {
    if (!o.transform || o.transform.times.length === 0 || skip.has(o.uid)) continue;
    const kind = mapKind(o);
    if (kind) picked.push({ o, kind });
  }

  // Centre of the action: bounds of aircraft and weapons, else of everything.
  const bounds = (filter: (k: MapKind) => boolean) => {
    let minLon = Number.POSITIVE_INFINITY;
    let maxLon = Number.NEGATIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    for (const { o, kind } of picked) {
      if (!filter(kind)) continue;
      const tf = o.transform;
      if (!tf) continue;
      for (let i = 0; i < tf.times.length; i++) {
        const lon = tf.lon[i] as number;
        const lat = tf.lat[i] as number;
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    return Number.isFinite(minLon) ? { minLon, maxLon, minLat, maxLat } : null;
  };
  const action = bounds((k) => k === "air" || k === "heli" || k === "weapon") ?? bounds(() => true);
  const cLonRel = action ? (action.minLon + action.maxLon) / 2 : 0;
  const cLatRel = action ? (action.minLat + action.maxLat) / 2 : 0;
  const lon0 = rec.refLon + cLonRel;
  const lat0 = rec.refLat + cLatRel;
  const kx = EARTH_R * Math.cos(lat0 * DEG) * DEG;
  const ky = EARTH_R * DEG;
  const projX = (lonRel: number) => (lonRel - cLonRel) * kx;
  const projY = (latRel: number) => (latRel - cLatRel) * ky;

  // Thin samples and count them so the shared arrays can be allocated once.
  const keep: number[][] = [];
  let total = 0;
  for (const { o } of picked) {
    const tf = o.transform;
    const idx: number[] = [];
    if (tf) {
      let last = Number.NEGATIVE_INFINITY;
      const n = tf.times.length;
      for (let i = 0; i < n; i++) {
        const t = tf.times[i] as number;
        if (!Number.isFinite(tf.lon[i] as number) || !Number.isFinite(tf.lat[i] as number)) continue;
        if (t - last >= MIN_SAMPLE_GAP_S || i === n - 1) {
          idx.push(i);
          last = t;
        }
      }
    }
    keep.push(idx);
    total += idx.length;
  }

  const times = new Float64Array(total);
  const x = new Float32Array(total);
  const y = new Float32Array(total);
  const alt = new Float32Array(total);
  const hdg = new Float32Array(total);
  const tracks: MapTrack[] = [];
  let at = 0;
  picked.forEach(({ o, kind }, k) => {
    const tf = o.transform;
    const idx = keep[k] ?? [];
    if (!tf || idx.length === 0) return;
    const start = at;
    for (const i of idx) {
      times[at] = tf.times[i] as number;
      x[at] = projX(tf.lon[i] as number);
      y[at] = projY(tf.lat[i] as number);
      alt[at] = tf.rest[i * 7] as number;
      hdg[at] = tf.rest[i * 7 + (T_YAW - 2)] as number;
      at++;
    }
    const p = o.text.Pilot;
    tracks.push({
      uid: o.uid,
      kind,
      side: o.color || o.coalition,
      name: o.name,
      pilots: p ? p.times.map((t, i) => ({ t, name: p.values[i] ?? "" })) : [],
      t0: o.createdAt,
      t1: o.removedAt ?? rec.timeEnd,
      removed: o.removedAt !== null,
      start,
      count: idx.length,
    });
  });

  const byUid = new Map(tracks.map((t) => [t.uid, t]));
  const data: MapData = {
    lon0,
    lat0,
    timeStart: rec.timeStart,
    timeEnd: rec.timeEnd,
    tracks,
    times,
    x,
    y,
    alt,
    hdg,
    kills: [],
    focus: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  };
  for (const k of analysis?.kills ?? []) {
    const tr = byUid.get(k.victimUid);
    const s = tr ? sampleAt(data, tr, k.time) : null;
    if (s) data.kills.push({ time: k.time, x: s.x, y: s.y, victimUid: k.victimUid, cause: k.cause });
  }
  // Initial framing: where weapons flew and kills happened (the fight), else all aircraft.
  const fight = bounds((k) => k === "weapon");
  const frame = fight ?? action;
  if (frame) {
    const f = {
      minX: projX(frame.minLon),
      maxX: projX(frame.maxLon),
      minY: projY(frame.minLat),
      maxY: projY(frame.maxLat),
    };
    if (fight)
      for (const k of data.kills) {
        f.minX = Math.min(f.minX, k.x);
        f.maxX = Math.max(f.maxX, k.x);
        f.minY = Math.min(f.minY, k.y);
        f.maxY = Math.max(f.maxY, k.y);
      }
    data.focus = padTo(f, MIN_FOCUS_SPAN_M);
  }
  return data;
}

/** Smallest span of the initial view, so a single close-range fight isn't zoomed in absurdly. */
const MIN_FOCUS_SPAN_M = 15000;

function padTo(b: MapData["focus"], span: number): MapData["focus"] {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const hx = Math.max(b.maxX - b.minX, span) / 2;
  const hy = Math.max(b.maxY - b.minY, span) / 2;
  return { minX: cx - hx, maxX: cx + hx, minY: cy - hy, maxY: cy + hy };
}

/** When the first aircraft (or anything) appears: a sensible starting time for the map. */
export function firstActivity(d: MapData): number {
  let t = Number.POSITIVE_INFINITY;
  for (const tr of d.tracks) if ((tr.kind === "air" || tr.kind === "heli") && tr.t0 < t) t = tr.t0;
  if (!Number.isFinite(t)) for (const tr of d.tracks) if (tr.t0 < t) t = tr.t0;
  return Number.isFinite(t) ? Math.max(t, d.timeStart) : d.timeStart;
}

export interface MapSample {
  x: number;
  y: number;
  alt: number;
  /** Degrees clockwise from north; from the recording, or from the direction of motion. */
  hdg: number;
  /** Ground speed in m/s (2D) from neighbouring samples. */
  speed: number;
}

/** Interpolated state of a track at time t, or null if it does not exist at t. */
export function sampleAt(d: MapData, tr: MapTrack, t: number): MapSample | null {
  if (t < tr.t0 - 1e-6 || t > tr.t1 + 1e-6 || tr.count === 0) return null;
  const s = tr.start;
  const n = tr.count;
  // Last sample at or before t.
  let lo = 0;
  let hi = n - 1;
  let i = 0;
  if ((d.times[s] as number) > t) i = 0;
  else {
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((d.times[s + mid] as number) <= t) {
        i = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
  }
  const j = i + 1 < n ? i + 1 : i;
  const a = s + i;
  const b = s + j;
  const ta = d.times[a] as number;
  const tb = d.times[b] as number;
  const f = b > a && t > ta ? Math.min(1, (t - ta) / (tb - ta)) : 0;
  const lerp = (arr: Float32Array) => (arr[a] as number) + ((arr[b] as number) - (arr[a] as number)) * f;
  // Motion from the bracketing samples (or the previous pair at the end of the track).
  const m0 = b > a ? a : Math.max(s, a - 1);
  const m1 = Math.max(a, b);
  const dt = (d.times[m1] as number) - (d.times[m0] as number);
  const dx = (d.x[m1] as number) - (d.x[m0] as number);
  const dy = (d.y[m1] as number) - (d.y[m0] as number);
  const speed = dt > 0 ? Math.hypot(dx, dy) / dt : 0;
  let hdg = d.hdg[a] as number;
  if (!Number.isFinite(hdg)) hdg = speed > 1 ? (Math.atan2(dx, dy) / DEG + 360) % 360 : 0;
  return { x: lerp(d.x), y: lerp(d.y), alt: lerp(d.alt), hdg, speed };
}

export function pilotAt(tr: MapTrack, t: number): string {
  let name = "";
  for (const p of tr.pilots) {
    if (p.t <= t || name === "") name = p.name;
    if (p.t > t) break;
  }
  return name;
}

/** The buffers to list as transferables when posting MapData. */
export function mapTransferables(d: MapData): ArrayBuffer[] {
  return [d.times.buffer, d.x.buffer, d.y.buffer, d.alt.buffer, d.hdg.buffer] as ArrayBuffer[];
}
