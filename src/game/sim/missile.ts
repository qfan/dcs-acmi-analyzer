/**
 * Active-radar missile, 3-D point mass. Phases, as in DCS:
 *
 *  datalink   the shooter's radar still tracks the target, so the missile gets the true target state
 *  inertial   no datalink: the missile flies to where it last knew the target, extrapolated
 *  search     pitbull: its own estimate of range to target fell to `pitbullRangeNm`, the seeker is
 *             on and looks in a cone around where the target is expected to be
 *  tracking   the seeker has the target: terminal proportional navigation, the shooter is no longer needed
 *  lost       the seeker never found the target, or lost it: the missile flies on, unguided
 *
 * Midcourse steers straight at the target estimate (pure pursuit) or at a predicted intercept point,
 * with a loft for long shots. Energy: motor thrust, drag cd(M)·ρ·v², and induced drag that grows with
 * the square of the lateral acceleration, so hard manoeuvring costs speed.
 */

import type { Side } from "./aircraft.ts";
import { airDensity, DEG, FT, G, interp, KT, NM, speedOfSoundMs } from "./atmosphere.ts";
import type { CountermeasureParams, MissileParams } from "./params.ts";
import type { Rng } from "./rng.ts";
import { add, angleBetween, dot, len, norm, perp, scale, segmentClosest, sub, type V3, v3 } from "./vec.ts";

export type MissilePhase = "datalink" | "inertial" | "search" | "tracking" | "lost";
export type MissileEnd = "hit" | "miss" | "spent" | "ground";

export interface Missile {
  id: string;
  side: Side;
  shooterId: string;
  targetId: string;
  pos: V3;
  vel: V3;
  tof: number;
  launchAlt: number;
  /** Loft apex gain (m) chosen at launch, and whether the missile is still climbing to it. */
  loftGainM: number;
  lofting: boolean;
  /** Where the missile believes the target is, and how it believes it moves. */
  estPos: V3;
  estVel: V3;
  phase: MissilePhase;
  pitbull: boolean;
  /** Closest approach so far to the true target (m) and range last step. */
  closestM: number;
  prevRangeM: number;
  /** Lateral acceleration commanded last step (m/s²), for display. */
  latAccel: number;
  /** Flight time at which the seeker gave up or the missile overshot (it then flies on unguided). */
  lostAt: number | null;
  /** Flight time before which the seeker cannot lock (just after a chaff break). */
  blindUntil: number;
  /** Callsign cached on launch so in-flight events keep it if the shooter is removed in infinite mode. */
  shooterCallsign?: string;
  end: MissileEnd | null;
}

export interface TargetTruth {
  pos: V3;
  vel: V3;
  alive: boolean;
}

export type MissileEvent =
  | "pitbull"
  | "acquired"
  | "datalink-lost"
  | "datalink-regained"
  | "seeker-lost"
  | "fuzed"
  | "miss"
  | "spent"
  | "ground"
  | "seeker-chaffed";

export function loftGainM(p: MissileParams, rangeM: number): number {
  if (!p.loft) return 0;
  return Math.max(0, interp(p.loftRangeNm, p.loftGainFt, rangeM / NM)) * FT;
}

export function launchMissile(
  p: MissileParams,
  init: {
    id: string;
    side: Side;
    shooterId: string;
    targetId: string;
    pos: V3;
    vel: V3;
    target: TargetTruth;
  },
): Missile {
  const range = len(sub(init.target.pos, init.pos));
  const gain = loftGainM(p, range);
  return {
    id: init.id,
    side: init.side,
    shooterId: init.shooterId,
    targetId: init.targetId,
    pos: { ...init.pos },
    vel: { ...init.vel },
    tof: 0,
    launchAlt: init.pos.z,
    loftGainM: gain,
    lofting: gain > 100,
    estPos: { ...init.target.pos },
    estVel: { ...init.target.vel },
    phase: "datalink",
    pitbull: false,
    closestM: range,
    prevRangeM: range,
    latAccel: 0,
    lostAt: null,
    blindUntil: 0,
    end: null,
  };
}

export const missileMach = (m: Missile): number => len(m.vel) / speedOfSoundMs(m.pos.z);

export function dragCoef(p: MissileParams, machNo: number): number {
  return interp(p.dragMach, p.dragCd, machNo) * p.dragScale;
}

export function motorAccel(p: MissileParams, tof: number): number {
  if (tof < p.boostTimeS) return p.boostAccel;
  if (tof < p.boostTimeS + p.sustainTimeS) return p.sustainAccel;
  return 0;
}

/** Chaff inputs for one missile step (see CountermeasureParams). */
export interface SeekerEcm {
  rng: Rng;
  cm: CountermeasureParams;
  /** A chaff bundle the target released this step, if any. */
  chaff: { pos: V3; vel: V3 } | null;
}

/** Steering gain for pursuit-type guidance: lateral accel = gain · v · angle error (1/s). */
const PURSUIT_GAIN = 2.5;
/** A tracking missile that is opening on its target this close (m) has passed it. */
const PASSED_M = 2000;
/** Look angles (rad) over which terminal guidance blends from pure PN to added direct steering. */
const BLEND_FROM = 15 * DEG;
const BLEND_SPAN = 25 * DEG;

function steerToward(dir: V3, vel: V3): V3 {
  const v = len(vel);
  const u = norm(vel);
  const ang = angleBetween(dir, u);
  let side = perp(dir, u);
  if (len(side) < 1e-6) {
    if (ang < 0.1) return v3();
    side = perp(v3(0, 0, 1), u);
  }
  return scale(norm(side), PURSUIT_GAIN * v * ang);
}

/** Predicted intercept point for a missile at `pos` flying `speed` against a target at p/v. */
function interceptPoint(pos: V3, speed: number, tp: V3, tv: V3): V3 {
  const r = sub(tp, pos);
  const a = dot(tv, tv) - speed * speed;
  const b = 2 * dot(r, tv);
  const c = dot(r, r);
  let t: number;
  if (Math.abs(a) < 1e-6) t = b < 0 ? -c / b : Number.NaN;
  else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return tp;
    const s = Math.sqrt(disc);
    const t1 = (-b - s) / (2 * a);
    const t2 = (-b + s) / (2 * a);
    t = Math.min(...[t1, t2].filter((x) => x > 0));
  }
  return Number.isFinite(t) && t > 0 ? add(tp, scale(tv, t)) : tp;
}

/**
 * Advances a missile by dt. `datalink` says whether the shooter's radar is tracking the target this
 * step. `fuzeRadiusM` can be overridden (the launch-zone calculator uses coarse steps). `ecm`
 * turns on chaff (the real fight; predictions leave it out). Returns the events of this step.
 */
export function stepMissile(
  p: MissileParams,
  m: Missile,
  target: TargetTruth,
  datalink: boolean,
  dt: number,
  fuzeRadiusM = p.fuzeRadiusM,
  ecm?: SeekerEcm,
): MissileEvent[] {
  const ev: MissileEvent[] = [];
  if (m.end) return ev;
  const p0 = { ...m.pos };
  const t0 = sub(target.pos, scale(target.vel, dt));

  // 1. What the missile knows about the target.
  if (m.phase === "tracking") {
    m.estPos = { ...target.pos };
    m.estVel = { ...target.vel };
  } else if (datalink && target.alive && m.phase !== "lost") {
    if (m.phase === "inertial") ev.push("datalink-regained");
    if (m.phase === "inertial" || m.phase === "datalink") m.phase = "datalink";
    m.estPos = { ...target.pos };
    m.estVel = { ...target.vel };
  } else {
    if (m.phase === "datalink") {
      m.phase = "inertial";
      ev.push("datalink-lost");
    }
    m.estPos = add(m.estPos, scale(m.estVel, dt));
  }

  // 2. Pitbull, seeker acquisition and loss.
  const toEst = sub(m.estPos, m.pos);
  if (
    !m.pitbull &&
    (m.phase === "datalink" || m.phase === "inertial") &&
    len(toEst) <= p.pitbullRangeNm * NM
  ) {
    m.pitbull = true;
    m.phase = "search";
    m.lofting = false;
    ev.push("pitbull");
  }
  const toTrue = sub(target.pos, m.pos);
  if (m.phase === "search") {
    const seen =
      target.alive &&
      m.tof >= m.blindUntil &&
      len(toTrue) <= p.seekerRangeNm * NM &&
      angleBetween(toTrue, toEst) <= p.seekerSearchDeg * DEG &&
      angleBetween(toTrue, m.vel) <= p.seekerGimbalDeg * DEG;
    if (seen) {
      m.phase = "tracking";
      ev.push("acquired");
    } else if (dot(toEst, m.vel) < 0) {
      // Flew past where the target should have been without finding it.
      m.phase = "lost";
      m.lostAt = m.tof;
      ev.push("seeker-lost");
    }
  } else if (m.phase === "tracking") {
    if (!target.alive || angleBetween(toTrue, m.vel) > p.seekerGimbalDeg * DEG) {
      m.phase = "lost";
      m.lostAt = m.tof;
      ev.push("seeker-lost");
    } else if (ecm) {
      const cm = ecm.cm;
      if (ecm.chaff && ecm.rng() < cm.chaffPullChance) {
        // Pulled onto the chaff for a moment; then it searches again around the (thinning) chaff.
        m.phase = "search";
        m.estPos = { ...ecm.chaff.pos };
        m.estVel = { ...ecm.chaff.vel };
        m.blindUntil = m.tof + cm.chaffPullS;
        ev.push("seeker-chaffed");
      }
    }
  }

  // 3. Guidance: lateral acceleration command.
  const v = len(m.vel);
  const u = norm(m.vel);
  let aCmd: V3;
  if (m.phase === "tracking") {
    const r = toTrue;
    const vr = sub(target.vel, m.vel);
    const rr = Math.max(dot(r, r), 1);
    const rawClosing = -dot(r, vr) / Math.sqrt(rr);
    const closing = Math.max(rawClosing, 100);
    // N · Vc · (LOS rate × LOS unit) = N · Vc · (vr ⊥ r) / |r|
    const vrPerp = perp(vr, norm(r));
    aCmd = perp(scale(vrPerp, (p.navConstant * closing) / Math.sqrt(rr)), u);
    // Far off boresight (e.g. right after an off-axis launch, closing still small) PN alone turns
    // too gently and the target slides out of the gimbal: blend in direct steering at the target.
    // Only while barely closing: late in a crossing intercept a big lead angle is correct PN.
    const look = angleBetween(r, u);
    const slow = Math.max(0, Math.min(1, (0.5 * v - rawClosing) / (0.3 * v)));
    const blend = slow * Math.max(0, Math.min(1, (look - BLEND_FROM) / BLEND_SPAN));
    if (blend > 0) aCmd = add(aCmd, scale(steerToward(r, m.vel), blend));
  } else if (m.phase === "lost") {
    aCmd = v3();
  } else {
    const est = m.estPos;
    const horiz = { x: est.x - m.pos.x, y: est.y - m.pos.y, z: 0 };
    const lookDownDeg = (Math.atan2(m.pos.z - est.z, Math.max(1, len(horiz))) * 180) / Math.PI;
    if (m.lofting && (m.pos.z >= m.launchAlt + m.loftGainM || lookDownDeg >= p.loftDiveDeg))
      m.lofting = false;
    let dir: V3;
    if (m.lofting) {
      const c = p.loftClimbDeg * DEG;
      const h = norm(horiz);
      dir = { x: h.x * Math.cos(c), y: h.y * Math.cos(c), z: Math.sin(c) };
    } else if (p.midcourse === "lead" && m.phase !== "search") {
      dir = sub(interceptPoint(m.pos, Math.max(v, 500), est, m.estVel), m.pos);
    } else {
      dir = sub(est, m.pos);
    }
    aCmd = steerToward(dir, m.vel);
  }
  // Gravity compensation: hold the flight path when nothing is commanded.
  aCmd = add(aCmd, perp(v3(0, 0, G), u));
  const rho = airDensity(m.pos.z);
  const q = rho * v * v;
  const aMax = Math.min(p.maxG * G, p.liftK * q);
  const aMag = len(aCmd);
  if (aMag > aMax) aCmd = scale(aCmd, aMax / aMag);
  m.latAccel = Math.min(aMag, aMax);

  // 4. Energy: thrust − drag along the path, lateral acceleration across it, gravity down.
  const machNo = v / speedOfSoundMs(m.pos.z);
  const drag = dragCoef(p, machNo) * q + (p.inducedCi * m.latAccel * m.latAccel) / Math.max(q, 1);
  const along = motorAccel(p, m.tof) - drag;
  const acc = add(add(scale(u, along), aCmd), v3(0, 0, -G));
  m.vel = add(m.vel, scale(acc, dt));
  m.pos = add(m.pos, scale(m.vel, dt));
  m.tof += dt;

  // 5. Fuze, pass, and running out of energy.
  if (target.alive) {
    const cpa = segmentClosest(p0, m.pos, t0, target.pos);
    if (cpa.d < m.closestM) m.closestM = cpa.d;
    if (cpa.d <= fuzeRadiusM && m.phase === "tracking") {
      m.end = "hit";
      ev.push("fuzed");
      return ev;
    }
    const range = len(sub(target.pos, m.pos));
    if (m.phase === "tracking" && range > m.prevRangeM && range < PASSED_M) {
      // Overshot: it flies on unguided until it self-destructs.
      m.phase = "lost";
      m.lostAt = m.tof;
      ev.push("miss");
    }
    m.prevRangeM = range;
  }
  if (m.pos.z <= 0) {
    m.end = "ground";
    ev.push("ground");
  } else if (m.tof > p.maxTofS || (motorAccel(p, m.tof) === 0 && len(m.vel) < p.minSpeedKt * KT)) {
    // True airspeed, not indicated: at altitude a fast missile shows a low indicated speed.
    m.end = "spent";
    ev.push("spent");
  }
  return ev;
}
