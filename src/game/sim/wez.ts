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
import { NM } from "./atmosphere.ts";
import { launchMissile, missileMach, stepMissile } from "./missile.ts";
import type { MissileParams } from "./params.ts";
import { add, len, norm, scale, sub, type V3 } from "./vec.ts";

const DT = 0.1;
/** Coarse steps can step over a 15 m fuze; count anything this close as a hit. */
const WEZ_FUZE_M = 120;

export interface FlyoutOutcome {
  hit: boolean;
  tofS: number;
  arrivalMach: number;
}

export function flyout(
  p: MissileParams,
  shooterPos: V3,
  shooterVel: V3,
  targetPos: V3,
  targetVel: V3,
): FlyoutOutcome {
  let tPos = { ...targetPos };
  const m = launchMissile(p, {
    id: "wez",
    side: "blue",
    shooterId: "s",
    targetId: "t",
    pos: shooterPos,
    vel: shooterVel,
    target: { pos: tPos, vel: targetVel, alive: true },
  });
  const tMax = p.maxTofS;
  while (m.tof < tMax) {
    tPos = add(tPos, scale(targetVel, DT));
    stepMissile(p, m, { pos: tPos, vel: targetVel, alive: true }, true, DT, WEZ_FUZE_M);
    if (m.end || m.phase === "lost") break;
    // Once the motor is out and it is below the lethal speed it will not count, so stop early.
    if (m.tof > p.boostTimeS + p.sustainTimeS && missileMach(m) < p.lethalMach) break;
  }
  const arrivalMach = missileMach(m);
  return { hit: m.end === "hit" && arrivalMach >= p.lethalMach, tofS: m.tof, arrivalMach };
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

function bisect(hits: (rangeM: number) => boolean, hiNm: number): number {
  let lo = Number.NaN;
  let hi = hiNm;
  for (const r of PROBES_NM) {
    if (r >= hiNm) continue;
    if (hits(r * NM)) {
      lo = r;
      break;
    }
  }
  if (Number.isNaN(lo)) return 0;
  // Tighten the upper bound with the probes above the first hit.
  for (const r of [...PROBES_NM].sort((a, b) => a - b))
    if (r > lo && r < hi) {
      if (hits(r * NM)) lo = r;
      else {
        hi = r;
        break;
      }
    }
  if (hi === hiNm && hits(hi * NM)) return hi;
  for (let i = 0; i < 8; i++) {
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

export function launchZone(p: MissileParams, shooter: Jet, target: Jet, maxNm = 90): LaunchZone {
  const { sv, tv, los, u, tSpeed, at } = launchGeometry(shooter, target);
  const away = { x: u.x * tSpeed, y: u.y * tSpeed, z: 0 };
  return {
    rangeNm: len(los) / NM,
    rmaxNm: bisect((r) => flyout(p, shooter.pos, sv, at(r), tv).hit, maxNm),
    rneNm: bisect((r) => flyout(p, shooter.pos, sv, at(r), away).hit, maxNm),
    now: flyout(p, shooter.pos, sv, target.pos, tv),
    shooterAltM: shooter.pos.z,
    targetAltM: target.pos.z,
  };
}

/** Rmax (nm) assuming the target faces straight head-on along the line of sight at its current speed and altitude. */
export function headOnRmaxNm(p: MissileParams, shooter: Jet, target: Jet, maxNm = 90): number {
  const { sv, u, tSpeed, at } = launchGeometry(shooter, target);
  const headOn = { x: -u.x * tSpeed, y: -u.y * tSpeed, z: 0 };
  return bisect((r) => flyout(p, shooter.pos, sv, at(r), headOn).hit, maxNm);
}
