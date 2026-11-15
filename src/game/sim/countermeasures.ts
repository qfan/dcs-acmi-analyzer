/** Shared notch rule and probability helper (see CountermeasureParams for the game rules). */
import { KT } from "./atmosphere.ts";
import { dot, len, sub, type V3 } from "./vec.ts";

/**
 * Whether a target sits in an observer's notch: beaming it (own speed along the line of sight under
 * the gate) while the observer is level with or above it. Same altitude counts as look-down.
 */
export function inNotch(observer: V3, target: { pos: V3; vel: V3 }, gateKt: number): boolean {
  if (observer.z < target.pos.z - 1) return false; // looking up: no notch
  const los = sub(target.pos, observer);
  const l = len(los);
  if (l < 1) return false;
  return Math.abs(dot(target.vel, los) / l) < gateKt * KT;
}

/** Chance that a per-second rate fires within one step of dt seconds. */
export const chanceInStep = (ratePerS: number, dt: number): number =>
  1 - Math.exp(-Math.max(0, ratePerS) * dt);
