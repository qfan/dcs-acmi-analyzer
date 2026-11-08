import type { AcmiObject, Recording } from "../acmi/model.ts";
import { indexAt } from "../acmi/tracks.ts";

/**
 * Geometry over a parsed recording: positions in Earth-centred metres (ECEF, WGS-84),
 * interpolation, velocities, closest approach, and a time-bucketed spatial index.
 *
 * Altitude that was never written is treated as 0 m (sea level). Ships in DCS recordings
 * leave the altitude component empty, and without this they would be invisible.
 */

export type Vec3 = [number, number, number];

const A = 6378137;
const E2 = 6.69437999014e-3;
const DEG = Math.PI / 180;

export function ecef(lonDeg: number, latDeg: number, alt: number): Vec3 {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  const sinLat = Math.sin(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const c = (n + alt) * Math.cos(lat);
  return [c * Math.cos(lon), c * Math.sin(lon), (n * (1 - E2) + alt) * sinLat];
}

export const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

interface Track {
  times: Float64Array;
  /** x,y,z per sample; NaN where lon/lat were unknown. */
  xyz: Float64Array;
  /** Altitude (MSL, m) per sample, for crash/despawn heuristics. */
  alt: Float32Array;
}

export class Geo {
  readonly rec: Recording;
  private readonly tracks: (Track | null)[];

  constructor(rec: Recording) {
    this.rec = rec;
    this.tracks = rec.objects.map((o) => buildTrack(rec, o));
  }

  /** End of an object's life: removal time, or the end of the recording. */
  lifeEnd(o: AcmiObject): number {
    return o.removedAt ?? this.rec.timeEnd;
  }

  alive(o: AcmiObject, t: number, slack = 1e-6): boolean {
    return t >= o.createdAt - slack && t <= this.lifeEnd(o) + slack;
  }

  hasTrack(o: AcmiObject): boolean {
    return this.tracks[o.uid] != null;
  }

  /**
   * True when the object's horizontal positions are scrambled: many sample-to-sample moves imply
   * impossible speeds while altitude stays smooth. Seen in protected multiplayer recordings
   * (header has PlaybackKey); such tracks cannot be used for geometry.
   */
  scrambled(o: AcmiObject): boolean {
    let s = this.scrambleCache.get(o.uid);
    if (s === undefined) {
      s = isScrambled(this.tracks[o.uid] ?? null);
      this.scrambleCache.set(o.uid, s);
    }
    return s;
  }
  private readonly scrambleCache = new Map<number, boolean>();

  sampleTimes(o: AcmiObject): Float64Array | null {
    return this.tracks[o.uid]?.times ?? null;
  }

  /** Position at time t: interpolated between samples, held before the first and after the last. */
  pos(o: AcmiObject, t: number): Vec3 | null {
    const tr = this.tracks[o.uid];
    if (!tr) return null;
    const n = tr.times.length;
    let i = indexAt(tr.times, t);
    if (i < 0) i = 0;
    const j = i + 1 < n ? i + 1 : i;
    const t0 = tr.times[i] as number;
    const t1 = tr.times[j] as number;
    const f = j > i && t > t0 ? Math.min(1, (t - t0) / (t1 - t0)) : 0;
    const p = tr.xyz;
    const x = (p[i * 3] as number) + ((p[j * 3] as number) - (p[i * 3] as number)) * f;
    const y = (p[i * 3 + 1] as number) + ((p[j * 3 + 1] as number) - (p[i * 3 + 1] as number)) * f;
    const z = (p[i * 3 + 2] as number) + ((p[j * 3 + 2] as number) - (p[i * 3 + 2] as number)) * f;
    return Number.isFinite(x + y + z) ? [x, y, z] : null;
  }

  /** Altitude MSL at time t (nearest sample at or before t). */
  altAt(o: AcmiObject, t: number): number | null {
    const tr = this.tracks[o.uid];
    if (!tr) return null;
    const i = Math.max(0, indexAt(tr.times, t));
    const a = tr.alt[i] as number;
    return Number.isFinite(a) ? a : null;
  }

  /** Velocity (m/s) around time t, from the samples bracketing t. */
  vel(o: AcmiObject, t: number): Vec3 {
    const tr = this.tracks[o.uid];
    if (!tr || tr.times.length < 2) return [0, 0, 0];
    let i = indexAt(tr.times, t);
    if (i < 0) i = 0;
    if (i >= tr.times.length - 1) i = tr.times.length - 2;
    return this.velBetween(tr, i, i + 1);
  }

  /** Velocity over the last two samples (for extrapolating a weapon past its last sample). */
  lastVel(o: AcmiObject): Vec3 {
    const tr = this.tracks[o.uid];
    if (!tr || tr.times.length < 2) return [0, 0, 0];
    const n = tr.times.length;
    return this.velBetween(tr, n - 2, n - 1);
  }

  lastSample(o: AcmiObject): { t: number; p: Vec3 } | null {
    const tr = this.tracks[o.uid];
    if (!tr) return null;
    const i = tr.times.length - 1;
    const p: Vec3 = [tr.xyz[i * 3] as number, tr.xyz[i * 3 + 1] as number, tr.xyz[i * 3 + 2] as number];
    return Number.isFinite(p[0] + p[1] + p[2]) ? { t: tr.times[i] as number, p } : null;
  }

  speed(o: AcmiObject, t: number): number {
    const v = this.vel(o, t);
    return Math.hypot(v[0], v[1], v[2]);
  }

  private velBetween(tr: Track, i: number, j: number): Vec3 {
    const dt = (tr.times[j] as number) - (tr.times[i] as number);
    if (!(dt > 0)) return [0, 0, 0];
    const v: Vec3 = [
      ((tr.xyz[j * 3] as number) - (tr.xyz[i * 3] as number)) / dt,
      ((tr.xyz[j * 3 + 1] as number) - (tr.xyz[i * 3 + 1] as number)) / dt,
      ((tr.xyz[j * 3 + 2] as number) - (tr.xyz[i * 3 + 2] as number)) / dt,
    ];
    return Number.isFinite(v[0] + v[1] + v[2]) ? v : [0, 0, 0];
  }

  /**
   * Closest approach between a weapon that vanished at `tEnd` and object `o`.
   * The weapon is extrapolated in a straight line from its last sample; the target moves with its
   * velocity at that time. Returns the minimum distance in [tLast, tEnd] and when it happens.
   */
  closestApproach(weapon: AcmiObject, o: AcmiObject, tEnd: number): { d: number; t: number } | null {
    const last = this.lastSample(weapon);
    if (!last) return null;
    const t0 = Math.min(last.t, tEnd);
    const window = Math.min(Math.max(0, tEnd - t0), MAX_EXTRAPOLATION_S);
    const vw = this.lastVel(weapon);
    // The target may have stopped being sampled too (e.g. both vanished in the same frame):
    // extend its path from its own last sample instead of holding it in place.
    const tl = this.lastSample(o);
    let pt: Vec3 | null;
    let vt: Vec3;
    if (tl && t0 > tl.t) {
      vt = this.lastVel(o);
      const dt = Math.min(t0 - tl.t, MAX_EXTRAPOLATION_S);
      pt = [tl.p[0] + vt[0] * dt, tl.p[1] + vt[1] * dt, tl.p[2] + vt[2] * dt];
    } else {
      pt = this.pos(o, t0);
      vt = this.vel(o, t0);
    }
    if (!pt) return null;
    const r: Vec3 = [pt[0] - last.p[0], pt[1] - last.p[1], pt[2] - last.p[2]];
    const rv: Vec3 = [vt[0] - vw[0], vt[1] - vw[1], vt[2] - vw[2]];
    const vv = rv[0] * rv[0] + rv[1] * rv[1] + rv[2] * rv[2];
    let s = vv > 0 ? -(r[0] * rv[0] + r[1] * rv[1] + r[2] * rv[2]) / vv : 0;
    s = Math.min(window, Math.max(0, s));
    const d = Math.hypot(r[0] + rv[0] * s, r[1] + rv[1] * s, r[2] + rv[2] * s);
    return { d, t: t0 + s };
  }
}

/** A weapon is never extrapolated more than this past its last sample. */
const MAX_EXTRAPOLATION_S = 1;

/** Faster than anything in these simulations (Mach ~9); a move this fast between samples is a jump. */
const IMPOSSIBLE_SPEED_MS = 3000;

function isScrambled(tr: Track | null): boolean {
  if (!tr || tr.times.length < 5) return false;
  let jumps = 0;
  let pairs = 0;
  const p = tr.xyz;
  for (let i = 1; i < tr.times.length; i++) {
    const dt = (tr.times[i] as number) - (tr.times[i - 1] as number);
    if (!(dt > 0)) continue;
    const d = Math.hypot(
      (p[i * 3] as number) - (p[i * 3 - 3] as number),
      (p[i * 3 + 1] as number) - (p[i * 3 - 2] as number),
      (p[i * 3 + 2] as number) - (p[i * 3 - 1] as number),
    );
    if (!Number.isFinite(d)) continue;
    pairs++;
    if (d / dt > IMPOSSIBLE_SPEED_MS) jumps++;
  }
  // Occasional jumps are respawns/teleports; scrambling makes most moves impossible.
  return jumps >= 3 && jumps > pairs * 0.2;
}

function buildTrack(rec: Recording, o: AcmiObject): Track | null {
  const tf = o.transform;
  if (!tf || tf.times.length === 0) return null;
  const n = tf.times.length;
  const xyz = new Float64Array(n * 3);
  const alt = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const lon = (tf.lon[i] as number) + rec.refLon;
    const lat = (tf.lat[i] as number) + rec.refLat;
    const a = tf.rest[i * 7] as number;
    const altM = Number.isNaN(a) ? 0 : a;
    alt[i] = Number.isNaN(a) ? Number.NaN : a;
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      const p = ecef(lon, lat, altM);
      xyz[i * 3] = p[0];
      xyz[i * 3 + 1] = p[1];
      xyz[i * 3 + 2] = p[2];
      any = true;
    } else {
      xyz[i * 3] = xyz[i * 3 + 1] = xyz[i * 3 + 2] = Number.NaN;
    }
  }
  return any ? { times: tf.times, xyz, alt } : null;
}

/**
 * Time-bucketed bounding-box index for "which objects could be near point P at time t".
 * Each object gets, per bucket it lives in, the bounding box of its samples in that bucket.
 */
export class SpatialIndex {
  private readonly bucket: number;
  private readonly t0: number;
  private readonly buckets: { objs: AcmiObject[]; boxes: number[] }[] = [];
  private readonly geo: Geo;

  constructor(geo: Geo, objects: AcmiObject[], bucketSeconds = 20) {
    this.geo = geo;
    this.bucket = bucketSeconds;
    this.t0 = geo.rec.timeStart;
    for (const o of objects) {
      const times = geo.sampleTimes(o);
      if (!times) continue;
      const start = Math.max(o.createdAt, this.t0);
      const end = geo.lifeEnd(o);
      const b0 = this.key(start);
      const b1 = this.key(end);
      for (let b = b0; b <= b1; b++) {
        const bs = this.t0 + b * this.bucket;
        const be = bs + this.bucket;
        // Samples bracketing the bucket cover every interpolated position inside it.
        const i0 = Math.max(0, indexAt(times, bs));
        const i1 = Math.min(times.length - 1, indexAt(times, be) + 1);
        const box = [
          Number.POSITIVE_INFINITY,
          Number.POSITIVE_INFINITY,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
        ];
        for (let i = i0; i <= i1; i++) {
          const p = geo.pos(o, times[i] as number);
          if (!p) continue;
          for (let k = 0; k < 3; k++) {
            const c = p[k] as number;
            if (c < (box[k] as number)) box[k] = c;
            if (c > (box[k + 3] as number)) box[k + 3] = c;
          }
        }
        if (!Number.isFinite(box[0] as number)) continue;
        let slot = this.buckets[b];
        if (!slot) {
          slot = { objs: [], boxes: [] };
          this.buckets[b] = slot;
        }
        slot.objs.push(o);
        slot.boxes.push(...box);
      }
    }
  }

  private key(t: number): number {
    return Math.max(0, Math.floor((t - this.t0) / this.bucket));
  }

  /** Objects alive at t whose bounding box (expanded by radius) contains p. */
  near(p: Vec3, t: number, radius: number): AcmiObject[] {
    const slot = this.buckets[this.key(t)];
    if (!slot) return [];
    const out: AcmiObject[] = [];
    const bx = slot.boxes;
    for (let i = 0; i < slot.objs.length; i++) {
      const o = i * 6;
      if (
        p[0] < (bx[o] as number) - radius ||
        p[1] < (bx[o + 1] as number) - radius ||
        p[2] < (bx[o + 2] as number) - radius ||
        p[0] > (bx[o + 3] as number) + radius ||
        p[1] > (bx[o + 4] as number) + radius ||
        p[2] > (bx[o + 5] as number) + radius
      )
        continue;
      const obj = slot.objs[i] as AcmiObject;
      if (this.geo.alive(obj, t, 0.5)) out.push(obj);
    }
    return out;
  }
}
