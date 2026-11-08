import { type MapData, type MapTrack, sampleAt } from "./mapData.ts";

/**
 * Air-combat geometry between a primary object ("ownship", A) and a secondary one ("target", B),
 * as taught in BFM/ACM texts. Computed on the map's flat plane: x east, y north, altitude up (metres).
 *
 *  - Range: slant distance A→B (and its horizontal part).
 *  - Closure: rate the range is shrinking (positive = closing).
 *  - ATA (antenna train angle): angle between A's nose and the line of sight to B. 0° = B on A's nose.
 *  - Aspect angle: angle from B's tail to the line from B to A. 0° = A sits on B's tail, 180° = nose-on.
 *  - Angle off tail / heading crossing angle: angle between the two flight paths. 0° = same direction.
 *  - Target ATA: B's nose to A (is A in front of B's guns/missiles?).
 *  - Clock position: where B appears from A's cockpit (12 = nose), high/low by elevation.
 */

export interface Engagement {
  range: number;
  horizontalRange: number;
  /** B's altitude minus A's (m). */
  altDiff: number;
  /** m/s, positive when the range is shrinking. */
  closure: number;
  ataDeg: number;
  aspectDeg: number;
  angleOffTailDeg: number;
  targetAtaDeg: number;
  /** True bearing from A to B, degrees. */
  bearingDeg: number;
  /** 1–12 o'clock relative to A's heading. */
  clock: number;
  /** "high" / "low" / "level": B above or below A's horizon by more than 10°. */
  elevation: "high" | "low" | "level";
  speedA: number;
  speedB: number;
  /** Seconds until the range reaches zero at the current closure, if closing. */
  timeToMergeS: number | null;
}

type V3 = [number, number, number];
const DEG = Math.PI / 180;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const angle = (a: V3, b: V3) => {
  const l = len(a) * len(b);
  return l > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, dot(a, b) / l))) / DEG : Number.NaN;
};

/** Half-width of the time window used to estimate velocity (s). */
const VEL_H = 0.5;

function state(d: MapData, tr: MapTrack, t: number): { p: V3; v: V3; nose: V3 } | null {
  const s = sampleAt(d, tr, t);
  if (!s) return null;
  const alt = (q: { alt: number }) => (Number.isFinite(q.alt) ? q.alt : 0);
  const p: V3 = [s.x, s.y, alt(s)];
  // Velocity from positions slightly before and after t (clamped to the object's life).
  const t0 = Math.max(tr.t0, t - VEL_H);
  const t1 = Math.min(tr.t1, t + VEL_H);
  const a = sampleAt(d, tr, t0);
  const b = sampleAt(d, tr, t1);
  const v: V3 =
    a && b && t1 > t0
      ? [(b.x - a.x) / (t1 - t0), (b.y - a.y) / (t1 - t0), (alt(b) - alt(a)) / (t1 - t0)]
      : [0, 0, 0];
  // Nose from the recorded attitude (heading/pitch); falls back to the flight path.
  const h = s.hdg * DEG;
  const pitch = s.pitch * DEG;
  const nose: V3 = [Math.sin(h) * Math.cos(pitch), Math.cos(h) * Math.cos(pitch), Math.sin(pitch)];
  return { p, v, nose: len(nose) > 0 ? nose : v };
}

export function engagementAt(d: MapData, a: MapTrack, b: MapTrack, t: number): Engagement | null {
  const A = state(d, a, t);
  const B = state(d, b, t);
  if (!A || !B) return null;
  const los = sub(B.p, A.p);
  const range = len(los);
  if (range < 1e-6) return null;
  const relV = sub(B.v, A.v);
  const closure = -dot(relV, los) / range;
  const back: V3 = [-los[0], -los[1], -los[2]];
  const tailB: V3 = [-B.v[0], -B.v[1], -B.v[2]];
  const bearing = (((Math.atan2(los[0], los[1]) / DEG) % 360) + 360) % 360;
  const headingA = len(A.nose) > 0 ? Math.atan2(A.nose[0], A.nose[1]) / DEG : bearing;
  const rel = (((bearing - headingA) % 360) + 360) % 360;
  const clock = Math.round(rel / 30) % 12 || 12;
  const horizontalRange = Math.hypot(los[0], los[1]);
  const elevDeg = Math.atan2(los[2], horizontalRange) / DEG;
  return {
    range,
    horizontalRange,
    altDiff: los[2],
    closure,
    ataDeg: angle(A.nose, los),
    aspectDeg: len(B.v) > 1 ? angle(tailB, back) : Number.NaN,
    angleOffTailDeg: len(A.v) > 1 && len(B.v) > 1 ? angle(A.v, B.v) : Number.NaN,
    targetAtaDeg: angle(B.nose, back),
    bearingDeg: bearing,
    clock,
    elevation: elevDeg > 10 ? "high" : elevDeg < -10 ? "low" : "level",
    speedA: len(A.v),
    speedB: len(B.v),
    timeToMergeS: closure > 1 ? range / closure : null,
  };
}

/** Plain-language summary of the geometry, e.g. "on its tail", "head-on", "beam". */
export function aspectWords(aspectDeg: number): string {
  if (!Number.isFinite(aspectDeg)) return "";
  if (aspectDeg <= 30) return "on its tail";
  if (aspectDeg <= 60) return "rear quarter";
  if (aspectDeg < 120) return "beam";
  if (aspectDeg < 150) return "forward quarter";
  return "head-on";
}
