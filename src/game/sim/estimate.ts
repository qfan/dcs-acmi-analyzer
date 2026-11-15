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
import { type Missile, stepMissile, type TargetTruth } from "./missile.ts";
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
  return { pos: add(tr.pos, scale(tr.vel, t - tr.t)), vel: { ...tr.vel }, alive: true };
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
    ghost: structuredClone(m),
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
  if (!g.end) stepMissile(p, g, known, datalink, dt, PREDICT_FUZE_M);
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
  if (ghost.end) return { pitbullAt: null, impactAt: null };
  const m = structuredClone(ghost);
  let tgt = { ...known, pos: { ...known.pos } };
  let pitbullAt: number | null = null;
  const tEnd = p.maxTofS;
  for (let k = 0; m.tof < tEnd && k < 4000; k++) {
    tgt = { ...tgt, pos: add(tgt.pos, scale(tgt.vel, PREDICT_DT)) };
    const ev = stepMissile(p, m, tgt, datalink, PREDICT_DT, PREDICT_FUZE_M);
    const now = t + (k + 1) * PREDICT_DT;
    if (ev.includes("pitbull")) pitbullAt = now;
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
