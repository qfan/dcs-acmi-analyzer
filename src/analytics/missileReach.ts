/**
 * Flies a fitted missile model (see missileFit.ts) against a simple target to find how far it reaches
 * at a given altitude, and turns those reaches into altitude scale factors for the BVR timeline.
 *
 * The flyout is a 2-D side view: shooter and target co-altitude at M0.9, the missile steered by
 * proportional navigation with gravity compensation, lofting with the habit measured from the tracks.
 * It is kinematics only: no radar, notch or countermeasures.
 */
import { speedOfSoundMs } from "./atmosphere.ts";
import {
  airDensity,
  canonicalMissile,
  FIT_RULES,
  FT_TO_M,
  G,
  type MissileModel,
  machBand,
  NM_TO_M,
} from "./missileFit.ts";
import type { MissileEngagement } from "./model.ts";
import { type BvrThreatTier, classifyThreatTier, THREAT_TIER_ORDER } from "./timeline.ts";

export const LADDER_ALTS_FT = [5000, 15000, 25000, 35000, 45000] as const;
/** The circulated chart's baseline (its PUMP row reads ">M0.95 at 35,000'"). */
export const CHART_REFERENCE_ALT_FT = 35000;

export const SIM_RULES = {
  dtS: 0.1,
  shooterMach: 0.9,
  targetMach: 0.9,
  /** Proportional navigation constant. */
  navConstant: 4,
  /** Climb angle while lofting (deg) and the look-down angle (deg) at which the dive starts. */
  loftClimbDeg: 25,
  loftDiveLookDownDeg: 40,
  /** A hit is a pass this close (m). */
  hitM: 25,
  /** Minimum flight-time horizon (s); extended up to 180 s if kills occur later. */
  defaultMaxTofS: 120,
  /** Reach search upper bound (nm) and bisection steps. */
  maxRangeNm: 140,
  bisectSteps: 10,
} as const;

export interface FlyoutScenario {
  altM: number;
  rangeM: number;
  /** Target flying at the shooter (true) or straight away (false). */
  hot: boolean;
  loft: boolean;
  /** Minimum arrival Mach that counts as a hit; defaults to the model's reachMach. */
  needMach?: number;
}

export interface FlyoutResult {
  hit: boolean;
  missM: number;
  arrivalMach: number;
  tofS: number;
}

/** Median loft gain (m) for a launch range, interpolated between trusted bins; 0 if the missile does not loft. */
export function loftGainM(m: MissileModel, rangeNm: number): number {
  if (!m.lofts) return 0;
  const pts = m.loft
    .filter((b) => b.shots >= FIT_RULES.minLoftBinShots)
    .map((b) => [(b.fromNm + b.toNm) / 2, Math.max(0, b.medianGainFt * FT_TO_M)] as const);
  if (pts.length === 0) return 0;
  if (rangeNm <= pts[0]![0]) return pts[0]![1] * Math.max(0, rangeNm / pts[0]![0]);
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    if (rangeNm <= x1) return y0 + ((y1 - y0) * (rangeNm - x0)) / (x1 - x0);
  }
  return pts[pts.length - 1]![1];
}

export function simulateFlyout(m: MissileModel, s: FlyoutScenario): FlyoutResult {
  const dt = SIM_RULES.dtS;
  const tMax = Math.min(180, Math.max(SIM_RULES.defaultMaxTofS, (m.maxKillTofS ?? 0) * 1.1));
  const needMach = s.needMach ?? m.reachMach;
  let x = 0;
  let h = s.altM;
  let v = speedOfSoundMs(h) * SIM_RULES.shooterMach;
  let gam = 0;
  const tv = speedOfSoundMs(s.altM) * SIM_RULES.targetMach * (s.hot ? -1 : 1);
  let tx = s.rangeM;
  const th = s.altM;
  const gain = s.loft ? loftGainM(m, s.rangeM / NM_TO_M) : 0;
  let lofting = gain > 100;
  const loftClimb = (SIM_RULES.loftClimbDeg * Math.PI) / 180;
  let best = Number.POSITIVE_INFINITY;
  let arrivalMach = 0;
  let tofS = 0;
  let prevR = s.rangeM;
  for (let t = 0; t < tMax; t += dt) {
    const dx = tx - x;
    const dh = th - h;
    const R = Math.hypot(dx, dh);
    const lookDownDeg = (-Math.atan2(dh, dx) * 180) / Math.PI;
    const rho = airDensity(h);
    const q = rho * v * v;
    const aMax = Math.min(40 * G, m.liftK * q);
    let a: number;
    if (lofting && h < s.altM + gain && lookDownDeg < SIM_RULES.loftDiveLookDownDeg) {
      a = 1.5 * (loftClimb - gam) * v + G * Math.cos(gam);
    } else {
      lofting = false;
      const rvx = tv - v * Math.cos(gam);
      const rvz = -v * Math.sin(gam);
      const losRate = (dx * rvz - dh * rvx) / (R * R);
      const closing = -(dx * rvx + dh * rvz) / R;
      a = SIM_RULES.navConstant * Math.max(closing, 100) * losRate + G * Math.cos(gam);
    }
    a = Math.max(-aMax, Math.min(aMax, a));
    const thrust = t < m.boostS ? m.boostAccel : t < m.motorEndS ? m.sustainAccel : 0;
    const drag = m.cd[machBand(v / speedOfSoundMs(h))]! * q + (m.ci * a * a) / q;
    v += (thrust - drag - G * Math.sin(gam)) * dt;
    gam += ((a - G * Math.cos(gam)) / v) * dt;
    x += v * Math.cos(gam) * dt;
    h += v * Math.sin(gam) * dt;
    tx += tv * dt;
    // Closest point of the step, not just its end: at ~1,500 m/s closing a step covers 150 m.
    const rx1 = tx - x;
    const rz1 = th - h;
    const ex = rx1 - dx;
    const ez = rz1 - dh;
    const ee = ex * ex + ez * ez;
    const f = ee > 0 ? Math.max(0, Math.min(1, -(dx * ex + dh * ez) / ee)) : 1;
    const stepMin = Math.hypot(dx + f * ex, dh + f * ez);
    if (stepMin < best) {
      best = stepMin;
      arrivalMach = v / speedOfSoundMs(h);
      tofS = t + f * dt;
    }
    const R2 = Math.hypot(rx1, rz1);
    if (h < 0 || (R2 > prevR && R2 < 2500) || v < speedOfSoundMs(h) * Math.min(0.8, needMach)) break;
    prevR = R2;
  }
  return { hit: best < SIM_RULES.hitM && arrivalMach >= needMach, missM: best, arrivalMach, tofS };
}

/** Longest launch range (nm) that still hits in this scenario. */
export function reachNm(m: MissileModel, s: Omit<FlyoutScenario, "rangeM">): number {
  let lo = 0;
  let hi: number = SIM_RULES.maxRangeNm;
  for (let i = 0; i < SIM_RULES.bisectSteps; i++) {
    const mid = (lo + hi) / 2;
    if (simulateFlyout(m, { ...s, rangeM: mid * NM_TO_M }).hit) lo = mid;
    else hi = mid;
  }
  return Math.round(lo * 10) / 10;
}

export interface ReachRung {
  altFt: number;
  /** Target flying at the shooter, arrival at reachMach or faster. */
  hotDirectNm: number;
  hotLoftNm: number;
  /** Target turns and runs at launch: the no-escape range. */
  coldNm: number;
  /** Same three, but arriving at FIT_RULES.dangerousMach or faster. */
  dangerousHotDirectNm: number;
  dangerousHotLoftNm: number;
  dangerousColdNm: number;
}

export function reachLadder(m: MissileModel, altsFt: readonly number[] = LADDER_ALTS_FT): ReachRung[] {
  const dm = FIT_RULES.dangerousMach;
  return altsFt.map((altFt) => {
    const altM = altFt * FT_TO_M;
    const hotDirectNm = reachNm(m, { altM, hot: true, loft: false });
    const hotLoftNm = m.lofts ? reachNm(m, { altM, hot: true, loft: true }) : hotDirectNm;
    const coldNm = Math.max(
      reachNm(m, { altM, hot: false, loft: false }),
      m.lofts ? reachNm(m, { altM, hot: false, loft: true }) : 0,
    );
    const dangerousHotDirectNm = reachNm(m, { altM, hot: true, loft: false, needMach: dm });
    const dangerousHotLoftNm = m.lofts
      ? reachNm(m, { altM, hot: true, loft: true, needMach: dm })
      : dangerousHotDirectNm;
    const dangerousColdNm = Math.max(
      reachNm(m, { altM, hot: false, loft: false, needMach: dm }),
      m.lofts ? reachNm(m, { altM, hot: false, loft: true, needMach: dm }) : 0,
    );
    return {
      altFt,
      hotDirectNm,
      hotLoftNm,
      coldNm,
      dangerousHotDirectNm,
      dangerousHotLoftNm,
      dangerousColdNm,
    };
  });
}

export type AltitudeBand = "deck" | "low" | "medium" | "high";
export const ALTITUDE_BANDS: Record<
  AltitudeBand,
  { label: string; minFt: number; maxFt: number; refFt: number }
> = {
  high: { label: "High (30k ft and up)", minFt: 30000, maxFt: 99999, refFt: 35000 },
  medium: { label: "Medium (20–30k ft)", minFt: 20000, maxFt: 30000, refFt: 25000 },
  low: { label: "Low (10–20k ft)", minFt: 10000, maxFt: 20000, refFt: 15000 },
  deck: { label: "Deck (under 10k ft)", minFt: 0, maxFt: 10000, refFt: 5000 },
};
export const ALTITUDE_BAND_ORDER: AltitudeBand[] = ["high", "medium", "low", "deck"];

export interface FittedMissile {
  model: MissileModel;
  ladder: ReachRung[];
  /** Threat tier most of its shots classify into. */
  tier: BvrThreatTier | null;
}

export function buildFittedMissiles(
  models: MissileModel[],
  engagements: MissileEngagement[],
): FittedMissile[] {
  const tierVotes = new Map<string, Map<BvrThreatTier, number>>();
  for (const e of engagements) {
    const tier = classifyThreatTier(e);
    if (!tier) continue;
    const key = canonicalMissile(e.weaponName);
    let votes = tierVotes.get(key);
    if (!votes) {
      votes = new Map();
      tierVotes.set(key, votes);
    }
    votes.set(tier, (votes.get(tier) ?? 0) + 1);
  }
  return models.map((model) => {
    const votes = [...(tierVotes.get(model.weapon) ?? new Map<BvrThreatTier, number>())].sort(
      (a, b) => b[1] - a[1],
    );
    return { model, ladder: reachLadder(model), tier: votes[0]?.[0] ?? null };
  });
}

export interface TierAltitudeScale {
  /** Multiplier for THREAT RANGE and NLT SR (head-on reach). */
  hot: number;
  /** Multiplier for MOR, MRAR, DR, LSR, MAR and STERN WEZ (no-escape reach). */
  cold: number;
  /** Missiles behind the numbers; empty means the tier borrowed from every fitted missile. */
  weapons: string[];
  borrowed: boolean;
}

const rungAt = (f: FittedMissile, altFt: number) => f.ladder.find((r) => r.altFt === altFt);

/** Shot-weighted reach ratio (band altitude ÷ chart altitude) per tier, from the trustworthy fitted missiles. */
export function tierAltitudeScales(
  fitted: FittedMissile[],
  band: AltitudeBand,
): Record<BvrThreatTier, TierAltitudeScale | null> {
  const refFt = ALTITUDE_BANDS[band].refFt;
  const ratio = (list: FittedMissile[]) => {
    let w = 0;
    let hot = 0;
    let cold = 0;
    for (const f of list) {
      const at = rungAt(f, refFt);
      const ref = rungAt(f, CHART_REFERENCE_ALT_FT);
      if (!at || !ref || ref.hotDirectNm <= 0 || ref.coldNm <= 0) continue;
      w += f.model.shots;
      hot += (f.model.shots * at.hotDirectNm) / ref.hotDirectNm;
      cold += (f.model.shots * at.coldNm) / ref.coldNm;
    }
    return w > 0 ? { hot: hot / w, cold: cold / w } : null;
  };
  const good = fitted.filter((f) => f.model.quality === "good");
  const all = ratio(good);
  const out = {} as Record<BvrThreatTier, TierAltitudeScale | null>;
  for (const tier of THREAT_TIER_ORDER) {
    const mine = good.filter((f) => f.tier === tier);
    const r = ratio(mine);
    if (r) out[tier] = { ...r, weapons: mine.map((f) => f.model.weapon), borrowed: false };
    else out[tier] = all ? { ...all, weapons: [], borrowed: true } : null;
  }
  return out;
}
