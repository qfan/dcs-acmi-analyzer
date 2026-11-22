/**
 * Launch zone ("WEZ" / DLZ) by fast-forwarding the same missile model the game flies: no separate
 * lookup table, so editing the missile parameters changes the zone too.
 *
 *  rmax  longest range that still arrives "likely lethal" (at or above lethalMach) if the target
 *        holds its current heading and speed
 *  rne   "no escape": the same if the target turns straight away at launch
 *
 * The missile itself flies further than this (until maxTofS or minSpeedKt), it just rarely kills there.
 *
 * Both keep the current geometry (shooter speed and heading, target aspect and speed) and only slide
 * the target along the current line of sight. The flyouts assume the shooter keeps supporting.
 */
import { type Jet, velocity } from "./aircraft.ts";
import { NM, speedOfSoundMs } from "./atmosphere.ts";
import { loftGainM, type Missile, missileMach, stepMissileFast } from "./missile.ts";
import type { MissileParams } from "./params.ts";
import { len, norm, sub, type V3 } from "./vec.ts";

const DT = 0.1;
/** Coarse steps can step over a 15 m fuze; count anything this close as a hit. */
const WEZ_FUZE_M = 120;

export interface FlyoutOutcome {
  hit: boolean;
  tofS: number;
  arrivalMach: number;
}

export interface ZoneHints {
  rmaxNm?: number;
  rneNm?: number;
}

/** Module-level scratch missile for WEZ flyout integrations (avoids per-flyout allocations). */
const WEZ_MISSILE: Missile = {
  id: "wez",
  side: "blue",
  shooterId: "s",
  targetId: "t",
  pos: { x: 0, y: 0, z: 0 },
  vel: { x: 0, y: 0, z: 0 },
  tof: 0,
  launchAlt: 0,
  loftGainM: 0,
  lofting: false,
  estPos: { x: 0, y: 0, z: 0 },
  estVel: { x: 0, y: 0, z: 0 },
  phase: "datalink",
  pitbull: false,
  closestM: 0,
  prevRangeM: 0,
  latAccel: 0,
  lostAt: null,
  blindUntil: 0,
  end: null,
};

function runFlyout(p: MissileParams, shooterPos: V3, shooterVel: V3, targetPos: V3, targetVel: V3): Missile {
  const dx = targetPos.x - shooterPos.x;
  const dy = targetPos.y - shooterPos.y;
  const dz = targetPos.z - shooterPos.z;
  const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const gain = loftGainM(p, range);
  const m = WEZ_MISSILE;
  m.pos.x = shooterPos.x;
  m.pos.y = shooterPos.y;
  m.pos.z = shooterPos.z;
  m.vel.x = shooterVel.x;
  m.vel.y = shooterVel.y;
  m.vel.z = shooterVel.z;
  m.tof = 0;
  m.launchAlt = shooterPos.z;
  m.loftGainM = gain;
  m.lofting = gain > 100;
  m.estPos.x = targetPos.x;
  m.estPos.y = targetPos.y;
  m.estPos.z = targetPos.z;
  m.estVel.x = targetVel.x;
  m.estVel.y = targetVel.y;
  m.estVel.z = targetVel.z;
  m.phase = "datalink";
  m.pitbull = false;
  m.closestM = range;
  m.prevRangeM = range;
  m.latAccel = 0;
  m.lostAt = null;
  m.blindUntil = 0;
  m.end = null;

  let tx = targetPos.x;
  let ty = targetPos.y;
  let tz = targetPos.z;
  const tvx = targetVel.x;
  const tvy = targetVel.y;
  const tvz = targetVel.z;
  const tMax = p.maxTofS;
  const motorEnd = p.boostTimeS + p.sustainTimeS;
  while (m.tof < tMax) {
    tx += tvx * DT;
    ty += tvy * DT;
    tz += tvz * DT;
    stepMissileFast(p, m, tx, ty, tz, tvx, tvy, tvz, true, true, DT, WEZ_FUZE_M, undefined, null);
    if (m.end || (m.phase as Missile["phase"]) === "lost") break;
    // Once the motor is out and it is below the lethal speed it will not count, so stop early.
    if (m.tof > motorEnd) {
      const v2 = m.vel.x * m.vel.x + m.vel.y * m.vel.y + m.vel.z * m.vel.z;
      const minV = p.lethalMach * speedOfSoundMs(m.pos.z);
      if (minV > 0 && v2 < minV * minV) break;
    }
  }
  return m;
}

export function flyout(
  p: MissileParams,
  shooterPos: V3,
  shooterVel: V3,
  targetPos: V3,
  targetVel: V3,
): FlyoutOutcome {
  const m = runFlyout(p, shooterPos, shooterVel, targetPos, targetVel);
  const arrivalMach = missileMach(m);
  return { hit: m.end === "hit" && arrivalMach >= p.lethalMach, tofS: m.tof, arrivalMach };
}

function flyoutHits(p: MissileParams, shooterPos: V3, shooterVel: V3, targetPos: V3, targetVel: V3): boolean {
  const m = runFlyout(p, shooterPos, shooterVel, targetPos, targetVel);
  if (m.end !== "hit") return false;
  return missileMach(m) >= p.lethalMach;
}

export interface LaunchZone {
  rangeNm: number;
  rmaxNm: number;
  rneNm: number;
  /** Shot taken right now against a target holding course. */
  now: FlyoutOutcome;
  /** Altitudes (m) the zone was computed for: thin air up high stretches it a lot. */
  shooterAltM: number;
  targetAltM: number;
}

/** Probe ranges (nm) to find any hit first: very short shots can miss off-boresight (minimum range). */
const PROBES_NM = [15, 8, 25, 4, 40, 2, 60];
const PROBES_ASC = [...PROBES_NM].sort((a, b) => a - b);

function bisect(hits: (rangeM: number) => boolean, hiNm: number, hintNm?: number, initLoNm?: number): number {
  let lo = Number.NaN;
  let hi = hiNm;
  let skipProbe = -1;

  if (initLoNm !== undefined) {
    lo = Math.min(initLoNm, hiNm);
    if (lo >= hiNm) return hits(hiNm * NM) ? Math.round(hiNm * 10) / 10 : 0;
    for (const r of PROBES_ASC) {
      if (r > lo && r < hi) {
        if (hits(r * NM)) lo = r;
        else {
          hi = r;
          break;
        }
      }
    }
  } else if (hintNm !== undefined && hintNm > 0.5 && hintNm < hiNm) {
    const wLo = Math.max(0.5, hintNm - 3);
    const wHi = Math.min(hiNm, hintNm + 3);
    if (hits(wLo * NM)) {
      lo = wLo;
      if (wHi < hiNm && !hits(wHi * NM)) {
        hi = wHi;
      } else if (wHi >= hiNm && hits(hiNm * NM)) {
        return hiNm;
      } else {
        lo = Math.max(lo, wHi);
        for (const r of PROBES_ASC) {
          if (r > lo && r < hi) {
            if (hits(r * NM)) lo = r;
            else {
              hi = r;
              break;
            }
          }
        }
      }
    } else {
      // wLo missed: either outside Rmax, or (rarely) inside off-boresight minimum range.
      for (const r of PROBES_NM) {
        if (r >= hiNm) continue;
        if (hits(r * NM)) {
          lo = r;
          break;
        }
      }
      if (Number.isNaN(lo)) return 0;
      if (lo < wLo) hi = Math.min(hi, wLo);
      else skipProbe = lo;
      for (const r of PROBES_ASC) {
        if (r > lo && r < hi && r !== skipProbe) {
          if (hits(r * NM)) lo = r;
          else {
            hi = r;
            break;
          }
        }
      }
    }
  } else {
    for (const r of PROBES_NM) {
      if (r >= hiNm) continue;
      if (hits(r * NM)) {
        lo = r;
        break;
      }
    }
    if (Number.isNaN(lo)) return 0;
    // Tighten the upper bound with the probes above the first hit.
    for (const r of PROBES_ASC) {
      if (r > lo && r < hi) {
        if (hits(r * NM)) lo = r;
        else {
          hi = r;
          break;
        }
      }
    }
  }

  if (hi === hiNm && hits(hi * NM)) return hi;
  for (let i = 0; i < 8 && Math.round(lo * 10) !== Math.round(hi * 10); i++) {
    const mid = (lo + hi) / 2;
    if (hits(mid * NM)) lo = mid;
    else hi = mid;
  }
  return Math.round(lo * 10) / 10;
}

function launchGeometry(shooter: Jet, target: Jet) {
  const sv = velocity(shooter);
  // A climbing or diving target is assumed to level off: extrapolating its climb for a whole
  // flyout would send it to space or into the ground.
  const tv = { ...velocity(target), z: 0 };
  const los = sub(target.pos, shooter.pos);
  const u = norm({ x: los.x, y: los.y, z: 0 });
  const dz = target.pos.z - shooter.pos.z;
  const at = (r: number): V3 => ({
    x: shooter.pos.x + u.x * r,
    y: shooter.pos.y + u.y * r,
    z: shooter.pos.z + dz,
  });
  return { sv, tv, los, u, tSpeed: len(tv), at };
}

export function launchZone(
  p: MissileParams,
  shooter: Jet,
  target: Jet,
  maxNm = 90,
  hints?: ZoneHints,
): LaunchZone {
  const { sv, tv, los, u, tSpeed, at } = launchGeometry(shooter, target);
  const away = { x: u.x * tSpeed, y: u.y * tSpeed, z: 0 };
  return {
    rangeNm: len(los) / NM,
    rmaxNm: bisect((r) => flyoutHits(p, shooter.pos, sv, at(r), tv), maxNm, hints?.rmaxNm),
    rneNm: bisect((r) => flyoutHits(p, shooter.pos, sv, at(r), away), maxNm, hints?.rneNm),
    now: flyout(p, shooter.pos, sv, target.pos, tv),
    shooterAltM: shooter.pos.z,
    targetAltM: target.pos.z,
  };
}

/** Rmax and Rne only (skips the extra `now` flyout when callers don't need it). */
export function launchBounds(
  p: MissileParams,
  shooter: Jet,
  target: Jet,
  maxNm = 90,
  hints?: ZoneHints,
): { rmaxNm: number; rneNm: number } {
  const { sv, tv, u, tSpeed, at } = launchGeometry(shooter, target);
  const away = { x: u.x * tSpeed, y: u.y * tSpeed, z: 0 };
  return {
    rmaxNm: bisect((r) => flyoutHits(p, shooter.pos, sv, at(r), tv), maxNm, hints?.rmaxNm),
    rneNm: bisect((r) => flyoutHits(p, shooter.pos, sv, at(r), away), maxNm, hints?.rneNm),
  };
}

/** Rmax only against the target's current velocity vector. */
export function launchRmaxNm(
  p: MissileParams,
  shooter: Jet,
  target: Jet,
  maxNm = 90,
  hintNm?: number,
): number {
  const { sv, tv, at } = launchGeometry(shooter, target);
  return bisect((r) => flyoutHits(p, shooter.pos, sv, at(r), tv), maxNm, hintNm);
}

/**
 * Fast opportunity-shot zone check: rejects targets beyond Rmax with 1 flyout (>= 8 nm),
 * and otherwise computes exact Rmax/Rne bounds (using the current range as a lower bound for Rmax).
 */
export function inOpportunityZone(
  p: MissileParams,
  shooter: Jet,
  target: Jet,
  frac: number,
  maxNm = 90,
  hints?: ZoneHints,
): { inZone: boolean; rmaxNm: number; rneNm: number } {
  const { sv, tv, los, u, tSpeed, at } = launchGeometry(shooter, target);
  const rangeNm = len(los) / NM;
  if (rangeNm >= 8 && rangeNm <= maxNm) {
    if (!flyoutHits(p, shooter.pos, sv, at(rangeNm * NM), tv)) {
      return { inZone: false, rmaxNm: 0, rneNm: 0 };
    }
    const away = { x: u.x * tSpeed, y: u.y * tSpeed, z: 0 };
    const rmaxNm = bisect((r) => flyoutHits(p, shooter.pos, sv, at(r), tv), maxNm, hints?.rmaxNm, rangeNm);
    const rneNm = bisect((r) => flyoutHits(p, shooter.pos, sv, at(r), away), maxNm, hints?.rneNm);
    const goodRangeNm = rneNm + frac * Math.max(0, rmaxNm - rneNm);
    return { inZone: rmaxNm > 0 && rangeNm <= goodRangeNm, rmaxNm, rneNm };
  }
  const rmaxNm = bisect((r) => flyoutHits(p, shooter.pos, sv, at(r), tv), maxNm, hints?.rmaxNm);
  const away = { x: u.x * tSpeed, y: u.y * tSpeed, z: 0 };
  const rneNm = bisect((r) => flyoutHits(p, shooter.pos, sv, at(r), away), maxNm, hints?.rneNm);
  const goodRangeNm = rneNm + frac * Math.max(0, rmaxNm - rneNm);
  return { inZone: rmaxNm > 0 && rangeNm <= goodRangeNm, rmaxNm, rneNm };
}

/** Rmax (nm) assuming the target faces straight head-on along the line of sight at its current speed and altitude. */
export function headOnRmaxNm(
  p: MissileParams,
  shooter: Jet,
  target: Jet,
  maxNm = 90,
  hintNm?: number,
): number {
  const { sv, u, tSpeed, at } = launchGeometry(shooter, target);
  const headOn = { x: -u.x * tSpeed, y: -u.y * tSpeed, z: 0 };
  return bisect((r) => flyoutHits(p, shooter.pos, sv, at(r), headOn), maxNm, hintNm);
}
