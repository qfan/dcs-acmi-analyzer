/**
 * What the launching jet knows about its own missile: nothing read from the missile itself.
 *
 * Like the cockpit timers in DCS (time to pitbull / time to impact, or the bar-and-triangle
 * display), the jet flies its own copy ("ghost") of the missile model from the launch state,
 * against its own picture of the target: the TWS track while it holds one, otherwise that track
 * carried forward. Every so often it fast-forwards the ghost to predict when it will go active and
 * when it will arrive. If the target manoeuvres unseen, or the real seeker does something else,
 * the estimate is simply wrong — as in the jet.
 */
import { NM } from "./atmosphere.ts";
import { cloneMissile, type Missile, stepMissileFast, type TargetTruth } from "./missile.ts";
import type { MissileParams } from "./params.ts";
import { add, scale } from "./vec.ts";

/** The jet's picture of a target: last tracked position and velocity, and when. */
export interface TargetTrack {
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  t: number;
}

/** Track carried forward to time t (dead reckoning). */
export function trackAt(tr: TargetTrack, t: number): TargetTruth {
  const pos = add(tr.pos, scale(tr.vel, t - tr.t));
  // Dead reckoning never puts a diving target underground.
  if (pos.z < 0) return { pos: { ...pos, z: 0 }, vel: { ...tr.vel, z: 0 }, alive: true };
  return { pos, vel: { ...tr.vel }, alive: true };
}

const PREDICT_DT = 0.1;
/** Prediction counts a pass this close (m) as an arrival (coarse steps). */
const PREDICT_FUZE_M = 120;
/** How often (s, simulated) the prediction is redone. */
export const PREDICT_EVERY_S = 0.5;

export interface MissileTimer {
  missileId: string;
  shooterId: string;
  targetId: string;
  launchT: number;
  ghost: Missile;
  /** Predicted absolute sim times of pitbull and impact; null if the prediction never gets there. */
  pitbullAt: number | null;
  impactAt: number | null;
  /** Impact time as first predicted, for the scale of the countdown bar. */
  firstImpactAt: number | null;
  predictedAt: number;
}

export function startTimer(m: Missile, t: number): MissileTimer {
  return {
    missileId: m.id,
    shooterId: m.shooterId,
    targetId: m.targetId,
    launchT: t - m.tof,
    ghost: cloneMissile(m),
    pitbullAt: null,
    impactAt: null,
    firstImpactAt: null,
    predictedAt: Number.NEGATIVE_INFINITY,
  };
}

/** Advances the ghost one step with what the jet knows; re-predicts every PREDICT_EVERY_S. */
export function stepTimer(
  p: MissileParams,
  timer: MissileTimer,
  known: TargetTruth,
  datalink: boolean,
  t: number,
  dt: number,
): void {
  const g = timer.ghost;
  if (!g.end && dt > 0) {
    stepMissileFast(
      p,
      g,
      known.pos.x,
      known.pos.y,
      known.pos.z,
      known.vel.x,
      known.vel.y,
      known.vel.z,
      known.alive,
      datalink,
      dt,
      PREDICT_FUZE_M,
      undefined,
      null,
    );
  }
  if (g.end || g.phase === "lost") {
    timer.pitbullAt = g.pitbull ? (timer.pitbullAt ?? t) : null;
    timer.impactAt = g.end === "hit" ? (timer.impactAt ?? t) : null;
    if (timer.firstImpactAt === null && timer.impactAt !== null) timer.firstImpactAt = timer.impactAt;
    return;
  }
  if (t - timer.predictedAt < PREDICT_EVERY_S) return;
  timer.predictedAt = t;
  const pred = predict(p, g, known, datalink, t);
  timer.pitbullAt = g.pitbull ? (timer.pitbullAt ?? t) : pred.pitbullAt;
  timer.impactAt = g.end === "hit" ? (timer.impactAt ?? t) : pred.impactAt;
  if (timer.firstImpactAt === null && timer.impactAt !== null) timer.firstImpactAt = timer.impactAt;
}

function predict(
  p: MissileParams,
  ghost: Missile,
  known: TargetTruth,
  datalink: boolean,
  t: number,
): { pitbullAt: number | null; impactAt: number | null } {
  if (ghost.end || ghost.phase === "lost") return { pitbullAt: null, impactAt: null };
  const m = cloneMissile(ghost);
  let tx = known.pos.x;
  let ty = known.pos.y;
  let tz = known.pos.z;
  const tvx = known.vel.x;
  const tvy = known.vel.y;
  const tvz = known.vel.z;
  const alive = known.alive;
  let pitbullAt: number | null = null;
  const tEnd = p.maxTofS;
  for (let k = 0; m.tof < tEnd && k < 4000; k++) {
    tx += tvx * PREDICT_DT;
    ty += tvy * PREDICT_DT;
    tz += tvz * PREDICT_DT;
    const wasPitbull = m.pitbull;
    stepMissileFast(
      p,
      m,
      tx,
      ty,
      tz,
      tvx,
      tvy,
      tvz,
      alive,
      datalink,
      PREDICT_DT,
      PREDICT_FUZE_M,
      undefined,
      null,
    );
    const now = t + (k + 1) * PREDICT_DT;
    if (!wasPitbull && m.pitbull) pitbullAt = now;
    if (m.end === "hit") return { pitbullAt, impactAt: now };
    if (m.end || m.phase === "lost") break;
  }
  return { pitbullAt, impactAt: null };
}

/** Distance (nm) from the ghost to where the jet thinks the target is, for display. */
export function ghostRangeNm(timer: MissileTimer, known: TargetTruth): number {
  const g = timer.ghost.pos;
  return Math.hypot(known.pos.x - g.x, known.pos.y - g.y, known.pos.z - g.z) / NM;
}
