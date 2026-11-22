/** Shared notch effectiveness and probability helpers (see CountermeasureParams for the game rules). */
import { DEG, KT } from "./atmosphere.ts";
import type { CountermeasureParams } from "./params.ts";
import { dot, len, sub, type V3 } from "./vec.ts";

/**
 * Notch effectiveness in [0, 1] for `target` observed from `observer`:
 *  - 0 when disabled (`notchMaxKt <= 0`) or looking up (`observer` below `target`);
 *  - ramps with look-down depression angle up to `notchLookDownDeg`;
 *  - ramps linearly with target 3D radial speed from 1 at `<= notchMinKt` to 0 at `>= notchMaxKt`.
 */
export function notchEffect(observer: V3, target: { pos: V3; vel: V3 }, cm: CountermeasureParams): number {
  if (cm.notchMaxKt <= 0) return 0;
  const los = sub(target.pos, observer);
  const l = len(los);
  if (l < 1) return 0;

  const dz = observer.z - target.pos.z;
  let lookDownFactor: number;
  if (cm.notchLookDownDeg <= 0) {
    if (dz < -1) return 0;
    lookDownFactor = 1;
  } else {
    if (dz <= 0) return 0;
    const horiz = Math.hypot(los.x, los.y);
    const depressionDeg = Math.atan2(dz, Math.max(horiz, 1e-6)) / DEG;
    lookDownFactor = Math.max(0, Math.min(1, depressionDeg / cm.notchLookDownDeg));
  }

  const radialKt = Math.abs(dot(target.vel, los) / l) / KT;
  const minKt = Math.max(0, cm.notchMinKt);
  const maxKt = Math.max(minKt, cm.notchMaxKt);
  let speedFactor: number;
  if (radialKt <= minKt) speedFactor = 1;
  else if (radialKt >= maxKt) speedFactor = 0;
  else speedFactor = (maxKt - radialKt) / (maxKt - minKt);

  return speedFactor * lookDownFactor;
}

/** Chance that a per-second rate fires within one step of dt seconds. */
export const chanceInStep = (ratePerS: number, dt: number): number =>
  1 - Math.exp(-Math.max(0, ratePerS) * dt);
