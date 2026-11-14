import type { AcmiObject, Recording } from "../acmi/model.ts";
import { isAircraft } from "../analysis/analyze.ts";
import type { Geo } from "../analysis/geo.ts";
import {
  BVR_RANGE_M,
  type FileQuality,
  type MissileEngagement,
  type MotionTrouble,
  QUALITY_RULES,
  type QualityFlag,
  type UfoLevel,
} from "./model.ts";

/**
 * Recording quality: is this file worth putting into the statistics?
 *
 * Two kinds of problems are labelled here, never silently dropped:
 *
 * 1. Content: too short, no air-to-air missiles, no or few BVR shots.
 * 2. Motion ("UFO flying"): in laggy multiplayer sessions DCS writes positions that jump
 *    back and forth. One player's bad connection makes only their aircraft warp; a struggling
 *    server makes everyone warp at the same moments.
 *
 * Motion test, per aircraft sample i between neighbours i-1 and i+1: how far does p[i] sit from
 * the straight chord p[i-1]→p[i+1]? A real aircraft pulling `a` m/s² can only bend its path by
 * a·dt1·dt2/2 inside that interval (≈ 2 m at 9 g and 5 Hz sampling); warps are hundreds of metres.
 * Anything beyond `QUALITY_RULES.maxG` plus a small fixed slack is an "off-path" sample. On the
 * corpus clean recordings have zero such samples, so the test needs no per-file tuning.
 *
 * Cost: one pass over each aircraft's samples, using positions the extractor already built.
 */

export interface AircraftOffPath {
  obj: AcmiObject;
  /** Times of off-path samples, ascending. */
  times: number[];
  samples: number;
  flightS: number;
}

const G = 9.80665;

/** Times of samples that would need more than `maxG` to explain, for one object. */
export function offPathTimes(geo: Geo, o: AcmiObject): { times: number[]; samples: number } {
  const ts = geo.sampleTimes(o);
  const out: number[] = [];
  if (!ts || ts.length < 3) return { times: out, samples: ts?.length ?? 0 };
  const halfA = 0.5 * QUALITY_RULES.maxG * G;
  const slack = QUALITY_RULES.offPathSlackM;
  let a = geo.pos(o, ts[0] as number);
  let b = geo.pos(o, ts[1] as number);
  for (let i = 1; i < ts.length - 1; i++) {
    const ta = ts[i - 1] as number;
    const tb = ts[i] as number;
    const tc = ts[i + 1] as number;
    const c = geo.pos(o, tc);
    const d1 = tb - ta;
    const d2 = tc - tb;
    if (a && b && c && d1 > 0 && d2 > 0) {
      const f = d1 / (d1 + d2);
      const r = Math.hypot(
        b[0] - (a[0] + (c[0] - a[0]) * f),
        b[1] - (a[1] + (c[1] - a[1]) * f),
        b[2] - (a[2] + (c[2] - a[2]) * f),
      );
      if (r > slack + halfA * d1 * d2) out.push(tb);
    }
    a = b;
    b = c;
  }
  return { times: out, samples: ts.length };
}

/** Number of values in sorted `times` within [lo, hi]. */
export function countInWindow(times: readonly number[], lo: number, hi: number): number {
  let l = 0;
  let r = times.length;
  while (l < r) {
    const m = (l + r) >> 1;
    if ((times[m] as number) < lo) l = m + 1;
    else r = m;
  }
  let n = 0;
  for (let i = l; i < times.length && (times[i] as number) <= hi; i++) n++;
  return n;
}

/** Group off-path times into episodes (gaps ≤ `episodeGapS`); returns count and covered seconds. */
function episodes(times: readonly number[]): { count: number; seconds: number } {
  if (times.length === 0) return { count: 0, seconds: 0 };
  let count = 1;
  let seconds = 0;
  let start = times[0] as number;
  let prev = start;
  for (let i = 1; i < times.length; i++) {
    const t = times[i] as number;
    if (t - prev > QUALITY_RULES.episodeGapS) {
      seconds += prev - start + 1;
      count++;
      start = t;
    }
    prev = t;
  }
  seconds += prev - start + 1;
  return { count, seconds };
}

export function motionTrouble(p: AircraftOffPath): MotionTrouble {
  const ep = episodes(p.times);
  const minutes = Math.max(p.flightS / 60, 1 / 60);
  return {
    uid: p.obj.uid,
    name: p.obj.name || "(unnamed)",
    pilot: p.obj.pilot,
    side: p.obj.color || p.obj.coalition || "",
    flightS: p.flightS,
    samples: p.samples,
    offPathSamples: p.times.length,
    episodes: ep.count,
    ufoS: ep.seconds,
    perMin: p.times.length / minutes,
    // Repeated or sustained warping; a single short burst (spawn, one hiccup) is only minor.
    heavy:
      p.times.length >= QUALITY_RULES.heavyMinSamples &&
      (ep.count >= QUALITY_RULES.heavyMinEpisodes || ep.seconds >= QUALITY_RULES.heavyMinSeconds),
  };
}

/** Off-path sample times for every aircraft (scrambled tracks excluded: they are a different problem). */
export function scanAircraftMotion(rec: Recording, geo: Geo): Map<number, AircraftOffPath> {
  const out = new Map<number, AircraftOffPath>();
  for (const o of rec.objects) {
    if (!isAircraft(o) || geo.scrambled(o)) continue;
    const { times, samples } = offPathTimes(geo, o);
    const flightS = (o.removedAt ?? rec.timeEnd) - o.createdAt;
    out.set(o.uid, { obj: o, times, samples, flightS });
  }
  return out;
}

/**
 * Server-wide lag shows as many aircraft going off-path in the same time window. Counts windows
 * where at least `massMinAircraft` aircraft, and at least `massMinShare` of the aircraft alive in
 * that window, have off-path samples.
 */
function massWindows(
  rec: Recording,
  geo: Geo,
  motion: Map<number, AircraftOffPath>,
): { windows: number; peakShare: number; peakAircraft: number } {
  const w = QUALITY_RULES.massWindowS;
  const nWin = Math.max(1, Math.ceil((rec.timeEnd - rec.timeStart) / w));
  const alive = new Uint16Array(nWin);
  const bad = new Uint16Array(nWin);
  for (const p of motion.values()) {
    const ts = geo.sampleTimes(p.obj);
    if (!ts || ts.length < 3) continue;
    const first = Math.max(0, Math.floor(((ts[0] as number) - rec.timeStart) / w));
    const last = Math.min(nWin - 1, Math.floor(((ts[ts.length - 1] as number) - rec.timeStart) / w));
    for (let k = first; k <= last; k++) alive[k] = (alive[k] as number) + 1;
    let prevK = -1;
    for (const t of p.times) {
      const k = Math.min(nWin - 1, Math.floor((t - rec.timeStart) / w));
      if (k !== prevK) bad[k] = (bad[k] as number) + 1;
      prevK = k;
    }
  }
  let windows = 0;
  let peakShare = 0;
  let peakAircraft = 0;
  for (let k = 0; k < nWin; k++) {
    const b = bad[k] as number;
    const a = alive[k] as number;
    if (b > peakAircraft) peakAircraft = b;
    if (a > 0 && b >= QUALITY_RULES.massMinAircraft) peakShare = Math.max(peakShare, b / a);
    if (b >= QUALITY_RULES.massMinAircraft && b / Math.max(a, 1) >= QUALITY_RULES.massMinShare) windows++;
  }
  return { windows, peakShare, peakAircraft };
}

/** Off-path samples of shooter and target around one shot: launch − pre to end + post. */
export function engagementUfo(
  e: Pick<MissileEngagement, "launchTime" | "endTime" | "killTime" | "flightTimeS">,
  shooter: AircraftOffPath | undefined,
  targets: (AircraftOffPath | undefined)[],
): { shooter: number; target: number } {
  const end =
    e.killTime ?? (e.flightTimeS !== null ? e.launchTime + e.flightTimeS : null) ?? e.endTime ?? e.launchTime;
  const lo = e.launchTime - QUALITY_RULES.shotWindowPreS;
  const hi = Math.max(end, e.launchTime) + QUALITY_RULES.shotWindowPostS;
  let target = 0;
  const seen = new Set<number>();
  for (const t of targets) {
    if (!t || seen.has(t.obj.uid)) continue;
    seen.add(t.obj.uid);
    target += countInWindow(t.times, lo, hi);
  }
  return { shooter: shooter ? countInWindow(shooter.times, lo, hi) : 0, target };
}

/** File labels from content and motion. Engagement-level UFO counts must already be filled in. */
export function assessFileQuality(
  rec: Recording,
  geo: Geo,
  motion: Map<number, AircraftOffPath>,
  engagements: MissileEngagement[],
  scrambledAircraft: number,
): FileQuality {
  const durationS = Math.max(0, rec.timeEnd - rec.timeStart);
  const a2a = engagements.filter((e) => e.domain === "A2A" && !e.isGun);
  const bvr = a2a.filter((e) => (e.initial?.slantRangeM ?? 0) >= BVR_RANGE_M);

  const trouble = [...motion.values()]
    .filter((p) => p.times.length > 0 && p.samples >= 3)
    .map(motionTrouble)
    .sort((a, b) => b.offPathSamples - a.offPathSamples);
  const tracked = [...motion.values()].filter((p) => p.samples >= QUALITY_RULES.minTrackedSamples).length;
  const heavy = trouble.filter((t) => t.heavy).length;
  const mass = massWindows(rec, geo, motion);
  const offPathTotal = trouble.reduce((s, t) => s + t.offPathSamples, 0);

  let ufoLevel: UfoLevel = "none";
  if (offPathTotal > 0) ufoLevel = "minor";
  if (heavy > 0) ufoLevel = "some";
  if (
    mass.windows >= QUALITY_RULES.massMinWindows ||
    (heavy >= QUALITY_RULES.massMinAircraft && heavy / Math.max(tracked, 1) >= QUALITY_RULES.massMinShare)
  ) {
    ufoLevel = "mass";
  }

  const ufoShots = a2a.filter(
    (e) => (e.ufo?.shooter ?? 0) + (e.ufo?.target ?? 0) >= QUALITY_RULES.shotUfoMinSamples,
  ).length;

  const flags: QualityFlag[] = [];
  if (durationS < QUALITY_RULES.shortS) flags.push("short");
  if (a2a.length === 0) flags.push("no-a2a");
  else if (bvr.length === 0) flags.push("no-bvr");
  else if (bvr.length < QUALITY_RULES.fewBvrShots) flags.push("few-bvr");
  if (ufoLevel === "mass") flags.push("ufo-mass");
  else if (ufoLevel === "some") flags.push("ufo-some");
  if (scrambledAircraft > 0) flags.push("scrambled");

  return {
    flags,
    ufoLevel,
    trackedAircraft: tracked,
    heavyAircraft: heavy,
    offPathSamples: offPathTotal,
    massWindows: mass.windows,
    massPeakShare: mass.peakShare,
    ufoShots,
    aircraft: trouble.slice(0, QUALITY_RULES.keepAircraft),
  };
}
