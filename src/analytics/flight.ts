import type { AcmiObject, Recording } from "../acmi/model.ts";
import { indexAt } from "../acmi/tracks.ts";
import { dist, type Geo } from "../analysis/geo.ts";
import { speedOfSoundMs } from "./atmosphere.ts";
import { type MissileFlight, type ShotTrack, TRACK_DT_S, TRACK_MAX_S, TRACK_STRIDE } from "./model.ts";

/**
 * Post-launch measurements for a single missile shot:
 * - `measureMissileFlight`: flyout facts on the raw track (speed, burnout, loft, closest approach).
 * - `buildShotTrack`: shooter / target / missile resampled on a fixed grid for later analyses
 *   (defensive reaction, notch, crank, F-pole…), small enough to cache thousands of shots.
 */

const EARTH_R = 6371008.8;
const DEG = Math.PI / 180;
/** Speeds are measured over at least this long so sample jitter does not create fake peaks. */
const SPEED_WINDOW_S = 0.3;
/** A decoy spawned within this distance of an aircraft is attributed to it. */
const DECOY_ATTRIBUTION_M = 500;
/** How long after the missile disappears the track keeps recording shooter and target. */
const TRACK_TAIL_S = 3;

/** Lon/lat/alt of an object at t (linear interpolation), or null outside its life or without data. */
function llaAt(rec: Recording, o: AcmiObject, t: number): [number, number, number] | null {
  const tf = o.transform;
  if (!tf || tf.times.length === 0) return null;
  if (t < o.createdAt - 0.05 || t > (o.removedAt ?? rec.timeEnd) + 0.05) return null;
  const n = tf.times.length;
  let i = indexAt(tf.times, t);
  if (i < 0) i = 0;
  const j = i + 1 < n ? i + 1 : i;
  const t0 = tf.times[i] as number;
  const t1 = tf.times[j] as number;
  const f = j > i && t > t0 ? Math.min(1, (t - t0) / (t1 - t0)) : 0;
  const lon0 = tf.lon[i] as number;
  const lat0 = tf.lat[i] as number;
  if (!Number.isFinite(lon0 + lat0)) return null;
  const lon1 = tf.lon[j] as number;
  const lat1 = tf.lat[j] as number;
  const a0r = tf.rest[i * 7] as number;
  const a1r = tf.rest[j * 7] as number;
  const a0 = Number.isFinite(a0r) ? a0r : 0;
  const a1 = Number.isFinite(a1r) ? a1r : a0;
  return [
    (Number.isFinite(lon1) ? lon0 + (lon1 - lon0) * f : lon0) + rec.refLon,
    (Number.isFinite(lat1) ? lat0 + (lat1 - lat0) * f : lat0) + rec.refLat,
    a0 + (a1 - a0) * f,
  ];
}

/** Decoys (chaff / flares) sorted by release time, with their release position. */
export class DecoyIndex {
  private readonly items: { t: number; uid: number; flare: boolean }[] = [];
  private readonly geo: Geo;

  constructor(rec: Recording, geo: Geo) {
    this.geo = geo;
    for (const o of rec.objects) {
      if (!o.tags.includes("Decoy")) continue;
      this.items.push({ t: o.createdAt, uid: o.uid, flare: o.tags.includes("Flare") });
    }
    this.items.sort((a, b) => a.t - b.t);
  }

  /** Releases in [t0, t1] by `owner`: times relative to `tRef`, split into chaff and flares. */
  releasesBy(
    owner: AcmiObject | null,
    t0: number,
    t1: number,
    tRef: number,
  ): { chaff: number[]; flare: number[] } {
    const out = { chaff: [] as number[], flare: [] as number[] };
    if (!owner) return out;
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.items[mid] as { t: number }).t < t0) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < this.items.length; k++) {
      const d = this.items[k] as { t: number; uid: number; flare: boolean };
      if (d.t > t1) break;
      if (!this.geo.alive(owner, d.t, 0.5)) continue;
      const decoy = this.geo.rec.objects[d.uid] as AcmiObject;
      const pd = this.geo.pos(decoy, d.t);
      const po = this.geo.pos(owner, d.t);
      if (!pd || !po || dist(pd, po) > DECOY_ATTRIBUTION_M) continue;
      (d.flare ? out.flare : out.chaff).push(Math.round((d.t - tRef) * 10) / 10);
    }
    return out;
  }
}

/** Speed (m/s) between raw samples i and the first sample at least SPEED_WINDOW_S later. */
function rawSpeeds(geo: Geo, w: AcmiObject): { t: number; v: number; alt: number }[] {
  const times = geo.sampleTimes(w);
  if (!times || times.length < 2) return [];
  const out: { t: number; v: number; alt: number }[] = [];
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    const ti = times[i] as number;
    if (j <= i) j = i + 1;
    while (j < times.length && (times[j] as number) - ti < SPEED_WINDOW_S) j++;
    if (j >= times.length) break;
    const tj = times[j] as number;
    const pi = geo.pos(w, ti);
    const pj = geo.pos(w, tj);
    if (!pi || !pj) continue;
    const tm = 0.5 * (ti + tj);
    out.push({ t: tm, v: dist(pi, pj) / (tj - ti), alt: geo.altAt(w, tm) ?? 0 });
  }
  return out;
}

/** Closest approach between missile and target over the missile's life: coarse scan, then refine. */
function closestApproach(
  geo: Geo,
  w: AcmiObject,
  targets: AcmiObject[],
  tLaunch: number,
  tEnd: number,
): { d: number; t: number } | null {
  const distAt = (t: number): number => {
    const pw = geo.pos(w, t);
    if (!pw) return Number.POSITIVE_INFINITY;
    let best = Number.POSITIVE_INFINITY;
    for (const tg of targets) {
      if (!geo.alive(tg, t, 0.5)) continue;
      const pt = geo.pos(tg, t);
      if (pt) best = Math.min(best, dist(pw, pt));
    }
    return best;
  };
  let bestT = tLaunch;
  let bestD = Number.POSITIVE_INFINITY;
  const step = 0.25;
  for (let t = tLaunch; t <= tEnd + 1e-6; t += step) {
    const d = distAt(t);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  const dEnd = distAt(tEnd);
  if (dEnd < bestD) {
    bestD = dEnd;
    bestT = tEnd;
  }
  if (!Number.isFinite(bestD)) return null;
  for (let t = Math.max(tLaunch, bestT - step); t <= Math.min(tEnd, bestT + step); t += 0.01) {
    const d = distAt(t);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  // The missile may vanish between samples (proximity fuze): extrapolate its last leg too.
  for (const tg of targets) {
    const ca = geo.closestApproach(w, tg, tEnd);
    if (ca && ca.d < bestD) {
      bestD = ca.d;
      bestT = ca.t;
    }
  }
  return { d: bestD, t: bestT };
}

/**
 * Flyout facts for one missile. `targets` lists the target object(s) (the life alive at launch and,
 * after a remove/re-add glitch, the one alive at the end); empty when the target is unknown.
 */
export function measureMissileFlight(
  geo: Geo,
  w: AcmiObject,
  targets: AcmiObject[],
  tLaunch: number,
): MissileFlight | null {
  const speeds = rawSpeeds(geo, w);
  if (speeds.length === 0) return null;
  const tEnd = geo.lifeEnd(w);
  let maxV = 0;
  let maxAt = tLaunch;
  let maxMach = 0;
  let apex = Number.NEGATIVE_INFINITY;
  for (const s of speeds) {
    if (s.v > maxV) {
      maxV = s.v;
      maxAt = s.t;
    }
    const mach = s.v / speedOfSoundMs(s.alt);
    if (mach > maxMach) maxMach = mach;
    if (s.alt > apex) apex = s.alt;
  }
  const times = geo.sampleTimes(w) as Float64Array;
  let flown = 0;
  let prev = geo.pos(w, times[0] as number);
  for (let i = 1; i < times.length; i++) {
    const p = geo.pos(w, times[i] as number);
    if (p && prev) flown += dist(p, prev);
    if (p) prev = p;
  }
  const last = speeds[speeds.length - 1] as { t: number; v: number; alt: number };
  const launchAlt = geo.altAt(w, tLaunch) ?? (speeds[0] as { alt: number }).alt;

  let cpaM: number | null = null;
  let cpaAtS: number | null = null;
  let cpaMissileSpeedMs: number | null = null;
  let cpaRelSpeedMs: number | null = null;
  if (targets.length > 0) {
    const ca = closestApproach(geo, w, targets, tLaunch, tEnd);
    if (ca) {
      cpaM = ca.d;
      cpaAtS = ca.t - tLaunch;
      const vw = geo.vel(w, Math.min(ca.t, tEnd));
      cpaMissileSpeedMs = Math.hypot(vw[0], vw[1], vw[2]);
      const tg = targets.find((o) => geo.alive(o, ca.t, 0.5)) ?? (targets[0] as AcmiObject);
      const vt = geo.vel(tg, ca.t);
      cpaRelSpeedMs = Math.hypot(vw[0] - vt[0], vw[1] - vt[1], vw[2] - vt[2]);
    }
  }

  return {
    tofS: Math.max(0, tEnd - tLaunch),
    maxSpeedMs: maxV,
    maxMach,
    maxSpeedAtS: maxAt - tLaunch,
    apexAltM: apex,
    apexGainM: apex - launchAlt,
    distanceFlownM: flown,
    endSpeedMs: last.v,
    endMach: last.v / speedOfSoundMs(last.alt),
    cpaM,
    cpaAtS,
    cpaMissileSpeedMs,
    cpaRelSpeedMs,
  };
}

/**
 * Resample missile, target and shooter every TRACK_DT_S from launch until the missile has been gone
 * for TRACK_TAIL_S (capped at TRACK_MAX_S). Origin: shooter (or missile) position at launch.
 */
export function buildShotTrack(
  rec: Recording,
  geo: Geo,
  decoys: DecoyIndex,
  w: AcmiObject,
  shooter: AcmiObject | null,
  targets: AcmiObject[],
  tLaunch: number,
): ShotTrack | null {
  const origin = (shooter && llaAt(rec, shooter, tLaunch)) ?? llaAt(rec, w, Math.max(tLaunch, w.createdAt));
  if (!origin) return null;
  const [lonO, latO] = origin;
  const kx = EARTH_R * Math.cos(latO * DEG) * DEG;
  const ky = EARTH_R * DEG;
  const tStop = Math.min(geo.lifeEnd(w) + TRACK_TAIL_S, tLaunch + TRACK_MAX_S, rec.timeEnd);
  const n = Math.max(1, Math.floor((tStop - tLaunch) / TRACK_DT_S) + 1);
  const data = new Float32Array(n * TRACK_STRIDE).fill(Number.NaN);

  const put = (base: number, lla: [number, number, number] | null) => {
    if (!lla) return;
    data[base] = (lla[0] - lonO) * kx;
    data[base + 1] = (lla[1] - latO) * ky;
    data[base + 2] = lla[2];
  };
  for (let k = 0; k < n; k++) {
    const t = tLaunch + k * TRACK_DT_S;
    const b = k * TRACK_STRIDE;
    const pm = llaAt(rec, w, t);
    put(b, pm);
    if (pm) data[b + 3] = geo.speed(w, t);
    for (const tg of targets) {
      const pt = llaAt(rec, tg, t);
      if (pt) {
        put(b + 4, pt);
        break;
      }
    }
    if (shooter) put(b + 7, llaAt(rec, shooter, t));
  }

  const t0 = tLaunch - 2;
  const t1 = tStop;
  const tgtAtLaunch = targets.find((o) => geo.alive(o, tLaunch, 0.5)) ?? targets[0] ?? null;
  const tc = decoys.releasesBy(tgtAtLaunch, t0, t1, tLaunch);
  const sc = decoys.releasesBy(shooter, t0, t1, tLaunch);
  return {
    dt: TRACK_DT_S,
    n,
    data,
    targetChaffS: tc.chaff,
    targetFlareS: tc.flare,
    shooterChaffS: sc.chaff,
    shooterFlareS: sc.flare,
  };
}
