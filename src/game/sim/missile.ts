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
 * Midcourse steers with unified biased proportional navigation ("pn", ramping up to full gain and
 * G limit near pitbull), or optionally predicted-intercept ("lead") or pure pursuit ("pursuit"),
 * with a range-scaled, gravity-assisted loft for long shots. Energy: motor thrust, drag
 * cd(M)·ρ·v², and induced drag that grows with the square of the lateral acceleration, so hard
 * manoeuvring costs speed.
 */

import type { Side } from "./aircraft.ts";
import { airDensity, DEG, FT, G, interp, KT, NM, speedOfSoundMs } from "./atmosphere.ts";
import { chanceInStep, notchEffectRaw } from "./countermeasures.ts";
import type { CountermeasureParams, MissileParams } from "./params.ts";
import type { Rng } from "./rng.ts";
import { len, segmentClosestDist, sub, type V3 } from "./vec.ts";

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
  /** Flight time before which the seeker cannot lock (just after a notch or chaff break). */
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
  | "seeker-notched"
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

/** Flat clone of a missile (copies position/velocity vectors without structuredClone overhead). */
export function cloneMissile(m: Missile): Missile {
  return {
    id: m.id,
    side: m.side,
    shooterId: m.shooterId,
    targetId: m.targetId,
    pos: { x: m.pos.x, y: m.pos.y, z: m.pos.z },
    vel: { x: m.vel.x, y: m.vel.y, z: m.vel.z },
    tof: m.tof,
    launchAlt: m.launchAlt,
    loftGainM: m.loftGainM,
    lofting: m.lofting,
    estPos: { x: m.estPos.x, y: m.estPos.y, z: m.estPos.z },
    estVel: { x: m.estVel.x, y: m.estVel.y, z: m.estVel.z },
    phase: m.phase,
    pitbull: m.pitbull,
    closestM: m.closestM,
    prevRangeM: m.prevRangeM,
    latAccel: m.latAccel,
    lostAt: m.lostAt,
    blindUntil: m.blindUntil,
    ...(m.shooterCallsign !== undefined ? { shooterCallsign: m.shooterCallsign } : {}),
    end: m.end,
  };
}

export const missileMach = (m: Missile): number =>
  Math.sqrt(m.vel.x * m.vel.x + m.vel.y * m.vel.y + m.vel.z * m.vel.z) / speedOfSoundMs(m.pos.z);

export function dragCoef(p: MissileParams, machNo: number): number {
  return interp(p.dragMach, p.dragCd, machNo) * p.dragScale;
}

export function motorAccel(p: MissileParams, tof: number): number {
  if (tof < p.boostTimeS) return p.boostAccel;
  if (tof < p.boostTimeS + p.sustainTimeS) return p.sustainAccel;
  return 0;
}

/** Notch and chaff inputs for one missile step (see CountermeasureParams). */
export interface SeekerEcm {
  rng: Rng;
  cm: CountermeasureParams;
  /** A chaff bundle the target released this step, if any. */
  chaff: { pos: V3; vel: V3 } | null;
}

/** Base seeker acquisition rate (1/s) during partial notch (scales with 1 - notchEff). */
const PARTIAL_NOTCH_ACQ_BASE_PER_S = 1.5;
/** Brief coast floor (s) after a 100% notch break to prevent boundary thrashing. */
const FULL_NOTCH_COAST_FLOOR_S = 0.4;

/** Steering gain for pursuit-type guidance: lateral accel = gain · v · angle error (1/s). */
const PURSUIT_GAIN = 2.5;
/** A tracking missile that is opening on its target this close (m) has passed it. */
const PASSED_M = 2000;
/** Look angles (rad) over which terminal guidance blends from pure PN to added direct steering. */
const BLEND_FROM = 15 * DEG;
const BLEND_SPAN = 25 * DEG;
/** Midcourse PN scale factor, ramping smoothly to 1× navConstant approaching pitbull. */
const MIDCOURSE_PN_SCALE = 0.75;
/** Range multiplier (of pitbullRangeNm) where guidance begins blending smoothly to terminal gain/G. */
const TERM_BLEND_MULT = 1.4;
/** Net downward acceleration (g) assumed for predicting coast apex and rounding out the loft. */
const LOFT_PUSHOVER_NET_G = 1.5;
/** Gentle downward aerodynamic lift cap (g) during midcourse/post-loft pushover. */
const LOFT_PUSHOVER_AERO_G = 0.5;
/** Gentle upward aerodynamic lift cap (g) during loft climb. */
const LOFT_CLIMB_MAX_G = 4;
/** Gentle vertical pitch-tracking gain (1/s) during loft climb. */
const LOFT_PITCH_GAIN = 1.2;
/** Soft aerodynamic lift caps (g) during boost and midcourse coast before ramping to maxG near pitbull. */
const MIDCOURSE_BOOST_G = 8;
const MIDCOURSE_COAST_G = 5;
/** Gentle midcourse off-boresight alignment toward predicted intercept when launched far off-axis. */
const ALIGN_FROM = 15 * DEG;
const ALIGN_SPAN = 25 * DEG;
const ALIGN_GAIN = 1.0;

const COS_BLEND_FROM = Math.cos(BLEND_FROM);
const COS_BLEND_FROM_SQ = COS_BLEND_FROM * COS_BLEND_FROM;
const COS_ALIGN_FROM = Math.cos(ALIGN_FROM);
const COS_ALIGN_FROM_SQ = COS_ALIGN_FROM * COS_ALIGN_FROM;

const _steer: V3 = { x: 0, y: 0, z: 0 };
const _pn: V3 = { x: 0, y: 0, z: 0 };
const _ip: V3 = { x: 0, y: 0, z: 0 };

function angleBetweenRaw(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const la2 = ax * ax + ay * ay + az * az;
  const lb2 = bx * bx + by * by + bz * bz;
  if (la2 < 1e-18 || lb2 < 1e-18) return 0;
  const d = ax * bx + ay * by + az * bz;
  return Math.acos(Math.max(-1, Math.min(1, d / Math.sqrt(la2 * lb2))));
}

function withinAngle(
  ax: number,
  ay: number,
  az: number,
  la2: number,
  bx: number,
  by: number,
  bz: number,
  lb2: number,
  deg: number,
): boolean {
  if (deg >= 180) return true;
  if (deg < 0) return false;
  if (la2 < 1e-18 || lb2 < 1e-18) return true;
  const d = ax * bx + ay * by + az * bz;
  const cosLimit = Math.cos(deg * DEG);
  return d >= cosLimit * Math.sqrt(la2 * lb2);
}

function steerTowardRaw(
  dx: number,
  dy: number,
  dz: number,
  v: number,
  ux: number,
  uy: number,
  uz: number,
  gain: number,
  out: V3,
): void {
  const ang = angleBetweenRaw(dx, dy, dz, ux, uy, uz);
  const dDotU = dx * ux + dy * uy + dz * uz;
  let sx = dx - ux * dDotU;
  let sy = dy - uy * dDotU;
  let sz = dz - uz * dDotU;
  let sLen = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (sLen < 1e-6) {
    if (ang < 0.1) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      return;
    }
    // perp((0, 0, 1), u)
    sx = -uz * ux;
    sy = -uz * uy;
    sz = 1 - uz * uz;
    sLen = Math.sqrt(sx * sx + sy * sy + sz * sz);
  }
  const k = gain * v * ang;
  if (sLen > 1e-9) {
    const inv = k / sLen;
    out.x = sx * inv;
    out.y = sy * inv;
    out.z = sz * inv;
  } else {
    out.x = 0;
    out.y = k;
    out.z = 0;
  }
}

/** Proportional navigation command toward (ap, av), with off-boresight low-closing safeguard. */
function pnCommandRaw(
  px: number,
  py: number,
  pz: number,
  vx: number,
  vy: number,
  vz: number,
  v: number,
  ux: number,
  uy: number,
  uz: number,
  apx: number,
  apy: number,
  apz: number,
  avx: number,
  avy: number,
  avz: number,
  navN: number,
  out: V3,
): void {
  const rx = apx - px;
  const ry = apy - py;
  const rz = apz - pz;
  const vrx = avx - vx;
  const vry = avy - vy;
  const vrz = avz - vz;
  const rRaw = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const rLen = Math.max(rRaw, 1);
  const invR = 1 / rLen;
  const rHatX = rx * invR;
  const rHatY = ry * invR;
  const rHatZ = rz * invR;
  const rawClosing = -(rx * vrx + ry * vry + rz * vrz) * invR;
  const closing = Math.max(rawClosing, 100);
  // N · Vc · (LOS rate × LOS unit) = N · Vc · (vr ⊥ r) / |r|
  const vrDotRHat = vrx * rHatX + vry * rHatY + vrz * rHatZ;
  const vrpX = vrx - rHatX * vrDotRHat;
  const vrpY = vry - rHatY * vrDotRHat;
  const vrpZ = vrz - rHatZ * vrDotRHat;
  const scaleK = navN * closing * invR;
  const sx = vrpX * scaleK;
  const sy = vrpY * scaleK;
  const sz = vrpZ * scaleK;
  const sDotU = sx * ux + sy * uy + sz * uz;
  let cx = sx - ux * sDotU;
  let cy = sy - uy * sDotU;
  let cz = sz - uz * sDotU;

  // Far off boresight (e.g. right after an off-axis launch, closing still small) PN alone turns
  // too gently and the target slides out of the gimbal: blend in direct steering at the target.
  // Only while barely closing: late in a crossing intercept a big lead angle is correct PN.
  if (rawClosing < 0.5 * v) {
    const r2 = rx * rx + ry * ry + rz * rz;
    const rDotU = rx * ux + ry * uy + rz * uz;
    if (r2 >= 1e-18 && !(rDotU > 0 && rDotU * rDotU >= COS_BLEND_FROM_SQ * r2)) {
      const look = Math.acos(Math.max(-1, Math.min(1, rDotU / Math.sqrt(r2))));
      const slow = Math.max(0, Math.min(1, (0.5 * v - rawClosing) / (0.3 * v)));
      const blend = slow * Math.max(0, Math.min(1, (look - BLEND_FROM) / BLEND_SPAN));
      if (blend > 0) {
        steerTowardRaw(rx, ry, rz, v, ux, uy, uz, PURSUIT_GAIN, _steer);
        cx += _steer.x * blend;
        cy += _steer.y * blend;
        cz += _steer.z * blend;
      }
    }
  }
  out.x = cx;
  out.y = cy;
  out.z = cz;
}

/** Predicted intercept point for a missile at (px,py,pz) flying `speed` against (tp, tv). */
function interceptPointRaw(
  px: number,
  py: number,
  pz: number,
  speed: number,
  tpx: number,
  tpy: number,
  tpz: number,
  tvx: number,
  tvy: number,
  tvz: number,
  out: V3,
): void {
  const rx = tpx - px;
  const ry = tpy - py;
  const rz = tpz - pz;
  const tv2 = tvx * tvx + tvy * tvy + tvz * tvz;
  const a = tv2 - speed * speed;
  const b = 2 * (rx * tvx + ry * tvy + rz * tvz);
  const c = rx * rx + ry * ry + rz * rz;
  let t = Number.NaN;
  if (Math.abs(a) < 1e-6) {
    if (b < 0) t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) {
      out.x = tpx;
      out.y = tpy;
      out.z = tpz;
      return;
    }
    const s = Math.sqrt(disc);
    const inv2a = 1 / (2 * a);
    const t1 = (-b - s) * inv2a;
    const t2 = (-b + s) * inv2a;
    if (t1 > 0 && t2 > 0) t = Math.min(t1, t2);
    else if (t1 > 0) t = t1;
    else if (t2 > 0) t = t2;
  }
  if (Number.isFinite(t) && t > 0) {
    out.x = tpx + tvx * t;
    out.y = tpy + tvy * t;
    out.z = tpz + tvz * t;
  } else {
    out.x = tpx;
    out.y = tpy;
    out.z = tpz;
  }
}

/**
 * Zero-allocation scalar missile step. Pass `evOut = null` when callers don't inspect events (flyout/WEZ).
 */
export function stepMissileFast(
  p: MissileParams,
  m: Missile,
  tpx: number,
  tpy: number,
  tpz: number,
  tvx: number,
  tvy: number,
  tvz: number,
  tAlive: boolean,
  datalink: boolean,
  dt: number,
  fuzeRadiusM = p.fuzeRadiusM,
  ecm?: SeekerEcm,
  evOut: MissileEvent[] | null = null,
): void {
  if (m.end) return;
  const p0x = m.pos.x;
  const p0y = m.pos.y;
  const p0z = m.pos.z;
  const t0x = tpx - tvx * dt;
  const t0y = tpy - tvy * dt;
  const t0z = tpz - tvz * dt;

  // 1. What the missile knows about the target.
  if (m.phase === "tracking") {
    m.estPos.x = tpx;
    m.estPos.y = tpy;
    m.estPos.z = tpz;
    m.estVel.x = tvx;
    m.estVel.y = tvy;
    m.estVel.z = tvz;
  } else if (datalink && tAlive && m.phase !== "lost") {
    if (m.phase === "inertial" && evOut) evOut.push("datalink-regained");
    if (m.phase === "inertial" || m.phase === "datalink") m.phase = "datalink";
    m.estPos.x = tpx;
    m.estPos.y = tpy;
    m.estPos.z = tpz;
    m.estVel.x = tvx;
    m.estVel.y = tvy;
    m.estVel.z = tvz;
  } else {
    if (m.phase === "datalink") {
      m.phase = "inertial";
      if (evOut) evOut.push("datalink-lost");
    }
    m.estPos.x += m.estVel.x * dt;
    m.estPos.y += m.estVel.y * dt;
    m.estPos.z += m.estVel.z * dt;
    if (m.estPos.z < 0) {
      m.estPos.z = 0;
      m.estVel.z = 0;
    }
  }

  // 2. Pitbull, seeker acquisition and loss.
  let ex = m.estPos.x;
  let ey = m.estPos.y;
  let ez = m.estPos.z;
  let evx = m.estVel.x;
  let evy = m.estVel.y;
  let evz = m.estVel.z;
  const px = p0x;
  const py = p0y;
  const pz = p0z;
  const vx = m.vel.x;
  const vy = m.vel.y;
  const vz = m.vel.z;
  const toEstX = ex - px;
  const toEstY = ey - py;
  const toEstZ = ez - pz;
  const toEst2 = toEstX * toEstX + toEstY * toEstY + toEstZ * toEstZ;
  const toEstLen = Math.sqrt(toEst2);
  if (!m.pitbull && (m.phase === "datalink" || m.phase === "inertial") && toEstLen <= p.pitbullRangeNm * NM) {
    m.pitbull = true;
    m.phase = "search";
    m.lofting = false;
    if (evOut) evOut.push("pitbull");
  }
  const toTrueX = tpx - px;
  const toTrueY = tpy - py;
  const toTrueZ = tpz - pz;
  const notchEff = ecm ? notchEffectRaw(px, py, pz, tpx, tpy, tpz, tvx, tvy, tvz, ecm.cm) : 0;
  const v2 = vx * vx + vy * vy + vz * vz;
  if (m.phase === "search") {
    const sr = p.seekerRangeNm * NM;
    const toTrue2 = toTrueX * toTrueX + toTrueY * toTrueY + toTrueZ * toTrueZ;
    const inCone =
      tAlive &&
      m.tof >= m.blindUntil &&
      toTrue2 <= sr * sr &&
      withinAngle(toTrueX, toTrueY, toTrueZ, toTrue2, toEstX, toEstY, toEstZ, toEst2, p.seekerSearchDeg) &&
      withinAngle(toTrueX, toTrueY, toTrueZ, toTrue2, vx, vy, vz, v2, p.seekerGimbalDeg);
    const seen =
      inCone &&
      (notchEff <= 0 ||
        (notchEff < 1 &&
          !!ecm &&
          ecm.rng() < chanceInStep(PARTIAL_NOTCH_ACQ_BASE_PER_S * (1 - notchEff), dt)));
    if (seen) {
      m.phase = "tracking";
      if (evOut) evOut.push("acquired");
    } else if (toEstX * vx + toEstY * vy + toEstZ * vz < 0) {
      // Flew past where the target should have been without finding it.
      m.phase = "lost";
      m.lostAt = m.tof;
      if (evOut) evOut.push("seeker-lost");
    }
  } else if (m.phase === "tracking") {
    const toTrue2 = toTrueX * toTrueX + toTrueY * toTrueY + toTrueZ * toTrueZ;
    if (!tAlive || !withinAngle(toTrueX, toTrueY, toTrueZ, toTrue2, vx, vy, vz, v2, p.seekerGimbalDeg)) {
      m.phase = "lost";
      m.lostAt = m.tof;
      if (evOut) evOut.push("seeker-lost");
    } else if (ecm) {
      const cm = ecm.cm;
      if (ecm.chaff && ecm.rng() < cm.chaffPullChance) {
        // Pulled onto the chaff for a moment; then it searches again around the (thinning) chaff.
        m.phase = "search";
        ex = m.estPos.x = ecm.chaff.pos.x;
        ey = m.estPos.y = ecm.chaff.pos.y;
        ez = m.estPos.z = ecm.chaff.pos.z;
        evx = m.estVel.x = ecm.chaff.vel.x;
        evy = m.estVel.y = ecm.chaff.vel.y;
        evz = m.estVel.z = ecm.chaff.vel.z;
        m.blindUntil = m.tof + cm.chaffPullS;
        if (evOut) evOut.push("seeker-chaffed");
      } else if (notchEff >= 1) {
        // 100% notched: drop into inertial coast and require re-acquisition after a brief floor.
        m.phase = "search";
        m.blindUntil = m.tof + Math.min(FULL_NOTCH_COAST_FLOOR_S, cm.notchReacquireS);
        if (evOut) evOut.push("seeker-notched");
      } else if (notchEff > 0 && ecm.rng() < chanceInStep(cm.seekerNotchPerS * notchEff, dt)) {
        // Partial notch break: keep flying toward extrapolated track and search again after blindUntil.
        m.phase = "search";
        m.blindUntil = m.tof + cm.notchReacquireS;
        if (evOut) evOut.push("seeker-notched");
      }
    }
  }

  // 3. Guidance: aerodynamic lateral acceleration command (including gravity compensation).
  const v = Math.sqrt(v2);
  let ux = 0;
  let uy = 1;
  let uz = 0;
  if (v > 1e-9) {
    const invV = 1 / v;
    ux = vx * invV;
    uy = vy * invV;
    uz = vz * invV;
  }
  // gravComp = perp((0, 0, G), u)
  const gDotU = G * uz;
  const gcx = -gDotU * ux;
  const gcy = -gDotU * uy;
  const gcz = G - gDotU * uz;
  let aax: number;
  let aay: number;
  let aaz: number;
  if (m.phase === "lost") {
    aax = gcx;
    aay = gcy;
    aaz = gcz;
  } else if (m.phase === "tracking") {
    pnCommandRaw(px, py, pz, vx, vy, vz, v, ux, uy, uz, tpx, tpy, tpz, tvx, tvy, tvz, p.navConstant, _pn);
    aax = _pn.x + gcx;
    aay = _pn.y + gcy;
    aaz = _pn.z + gcz;
  } else {
    const horizDist = Math.max(1, Math.sqrt((ex - px) * (ex - px) + (ey - py) * (ey - py)));
    const rangeToEst = toEstLen;
    const lookDownDeg = (Math.atan2(pz - ez, horizDist) * 180) / Math.PI;
    const losPitch = Math.atan2(ez - pz, horizDist);

    const pitM = p.pitbullRangeNm * NM;
    const termBlend =
      pitM > 0
        ? Math.max(0, Math.min(1, (pitM * TERM_BLEND_MULT - rangeToEst) / (pitM * (TERM_BLEND_MULT - 1))))
        : 1;

    // End active climb once coasting at ~1.5 G net downward curvature reaches target loft apex.
    const apexZ = m.launchAlt + m.loftGainM;
    const predApexZ = pz + (vz > 0 ? (vz * vz) / (2 * LOFT_PUSHOVER_NET_G * G) : 0);
    if (m.lofting && (predApexZ >= apexZ || pz >= apexZ || lookDownDeg >= p.loftDiveDeg)) m.lofting = false;

    let abx: number;
    let aby: number;
    let abz: number;
    if (p.midcourse === "pn") {
      const navN = p.navConstant * (MIDCOURSE_PN_SCALE + (1 - MIDCOURSE_PN_SCALE) * termBlend);
      pnCommandRaw(px, py, pz, vx, vy, vz, v, ux, uy, uz, ex, ey, ez, evx, evy, evz, navN, _pn);
      abx = _pn.x;
      aby = _pn.y;
      abz = _pn.z;
      if (termBlend < 1) {
        interceptPointRaw(px, py, pz, Math.max(v, 500), ex, ey, ez, evx, evy, evz, _ip);
        const ipdx = _ip.x - px;
        const ipdy = _ip.y - py;
        const ipdz = _ip.z - pz;
        const ip2 = ipdx * ipdx + ipdy * ipdy + ipdz * ipdz;
        const ipDotU = ipdx * ux + ipdy * uy + ipdz * uz;
        if (ip2 >= 1e-18 && !(ipDotU > 0 && ipDotU * ipDotU >= COS_ALIGN_FROM_SQ * ip2)) {
          const ipErr = Math.acos(Math.max(-1, Math.min(1, ipDotU / Math.sqrt(ip2))));
          const alignBlend = (1 - termBlend) * Math.max(0, Math.min(1, (ipErr - ALIGN_FROM) / ALIGN_SPAN));
          if (alignBlend > 0) {
            steerTowardRaw(ipdx, ipdy, ipdz, v, ux, uy, uz, ALIGN_GAIN, _steer);
            abx += _steer.x * alignBlend;
            aby += _steer.y * alignBlend;
            abz += _steer.z * alignBlend;
          }
        }
      }
    } else if (p.midcourse === "lead") {
      interceptPointRaw(px, py, pz, Math.max(v, 500), ex, ey, ez, evx, evy, evz, _ip);
      steerTowardRaw(_ip.x - px, _ip.y - py, _ip.z - pz, v, ux, uy, uz, PURSUIT_GAIN, _steer);
      abx = _steer.x;
      aby = _steer.y;
      abz = _steer.z;
    } else {
      steerTowardRaw(toEstX, toEstY, toEstZ, v, ux, uy, uz, PURSUIT_GAIN, _steer);
      abx = _steer.x;
      aby = _steer.y;
      abz = _steer.z;
    }

    // upRaw = perp((0, 0, 1), u)
    const upRx = -uz * ux;
    const upRy = -uz * uy;
    const upRz = 1 - uz * uz;
    const upRLen = Math.sqrt(upRx * upRx + upRy * upRy + upRz * upRz);
    let upx = 0;
    let upy = 0;
    let upz = 1;
    if (upRLen > 1e-6) {
      const invU = 1 / upRLen;
      upx = upRx * invU;
      upy = upRy * invU;
      upz = upRz * invU;
    }
    const aVertCmd = abx * upx + aby * upy + abz * upz;
    const ahx = abx - upx * aVertCmd;
    const ahy = aby - upy * aVertCmd;
    const ahz = abz - upz * aVertCmd;
    const gravPerpMag = gcx * upx + gcy * upy + gcz * upz;

    let aAeroVert: number;
    if (m.lofting && m.loftGainM > 100) {
      let maxTableGain = 1;
      for (let i = 0; i < p.loftGainFt.length; i++) {
        const gFt = (p.loftGainFt[i] as number) * FT;
        if (gFt > maxTableGain) maxTableGain = gFt;
      }
      const loftScale = Math.max(0, Math.min(1, m.loftGainM / maxTableGain));
      const climbRad = p.loftClimbDeg * DEG * (0.35 + 0.65 * Math.sqrt(loftScale));
      const desiredPitch = Math.max(losPitch, climbRad);
      const pitch = Math.asin(Math.max(-1, Math.min(1, uz)));
      const aVertNet = LOFT_PITCH_GAIN * v * (desiredPitch - pitch);
      aAeroVert = Math.max(-LOFT_PUSHOVER_AERO_G * G, Math.min(LOFT_CLIMB_MAX_G * G, aVertNet + gravPerpMag));
    } else {
      aAeroVert = aVertCmd + gravPerpMag;
      const minDownAero =
        -(LOFT_PUSHOVER_AERO_G + Math.max(0, p.maxG - LOFT_PUSHOVER_AERO_G) * termBlend) * G;
      if (aAeroVert < minDownAero) aAeroVert = minDownAero;
    }

    aax = ahx + upx * aAeroVert;
    aay = ahy + upy * aAeroVert;
    aaz = ahz + upz * aAeroVert;

    const midCapG =
      motorAccel(p, m.tof) > 0
        ? MIDCOURSE_BOOST_G
        : MIDCOURSE_COAST_G + Math.max(0, p.maxG - MIDCOURSE_COAST_G) * termBlend;
    const midCap = Math.min(p.maxG, midCapG) * G;
    const aAeroMag = Math.sqrt(aax * aax + aay * aay + aaz * aaz);
    if (aAeroMag > midCap) {
      const k = midCap / aAeroMag;
      aax *= k;
      aay *= k;
      aaz *= k;
    }
  }

  const rho = airDensity(pz);
  const q = rho * v * v;
  const aMax = Math.min(p.maxG * G, p.liftK * q);
  const aMag = Math.sqrt(aax * aax + aay * aay + aaz * aaz);
  if (aMag > aMax) {
    const k = aMax / aMag;
    aax *= k;
    aay *= k;
    aaz *= k;
  }
  m.latAccel = Math.min(aMag, aMax);

  // 4. Energy: thrust − drag along the path, lateral acceleration across it, gravity down.
  const machNo = v / speedOfSoundMs(pz);
  const drag = dragCoef(p, machNo) * q + (p.inducedCi * m.latAccel * m.latAccel) / Math.max(q, 1);
  const along = motorAccel(p, m.tof) - drag;
  const nvx = vx + (ux * along + aax) * dt;
  const nvy = vy + (uy * along + aay) * dt;
  const nvz = vz + (uz * along + aaz - G) * dt;
  m.vel.x = nvx;
  m.vel.y = nvy;
  m.vel.z = nvz;
  const npx = px + nvx * dt;
  const npy = py + nvy * dt;
  const npz = pz + nvz * dt;
  m.pos.x = npx;
  m.pos.y = npy;
  m.pos.z = npz;
  m.tof += dt;

  // 5. Fuze, pass, and running out of energy.
  if (tAlive) {
    if (evOut !== null || m.phase === "tracking") {
      const cpaD = segmentClosestDist(p0x, p0y, p0z, npx, npy, npz, t0x, t0y, t0z, tpx, tpy, tpz);
      if (cpaD < m.closestM) m.closestM = cpaD;
      if (cpaD <= fuzeRadiusM && m.phase === "tracking") {
        m.end = "hit";
        if (evOut) evOut.push("fuzed");
        return;
      }
    }
    if (evOut !== null || m.phase === "tracking" || m.phase === "search") {
      const rdx = tpx - npx;
      const rdy = tpy - npy;
      const rdz = tpz - npz;
      const range = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz);
      if (m.phase === "tracking" && range > m.prevRangeM && range < PASSED_M) {
        // Overshot: it flies on unguided until it self-destructs.
        m.phase = "lost";
        m.lostAt = m.tof;
        if (evOut) evOut.push("miss");
      }
      m.prevRangeM = range;
    }
  }
  const minSpd = p.minSpeedKt * KT;
  if (npz <= 0) {
    m.end = "ground";
    if (evOut) evOut.push("ground");
  } else if (
    m.tof > p.maxTofS ||
    (motorAccel(p, m.tof) === 0 && minSpd > 0 && nvx * nvx + nvy * nvy + nvz * nvz < minSpd * minSpd)
  ) {
    // True airspeed, not indicated: at altitude a fast missile shows a low indicated speed.
    m.end = "spent";
    if (evOut) evOut.push("spent");
  }
}

/**
 * Advances a missile by dt. `datalink` says whether the shooter's radar is tracking the target this
 * step. `fuzeRadiusM` can be overridden (the launch-zone calculator uses coarse steps). `ecm`
 * turns on notch and chaff (the real fight; predictions leave it out). Returns the events of this step.
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
  stepMissileFast(
    p,
    m,
    target.pos.x,
    target.pos.y,
    target.pos.z,
    target.vel.x,
    target.vel.y,
    target.vel.z,
    target.alive,
    datalink,
    dt,
    fuzeRadiusM,
    ecm,
    ev,
  );
  return ev;
}
