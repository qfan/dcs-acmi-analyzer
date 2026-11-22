/** Shared notch effectiveness and probability helpers (see CountermeasureParams for the game rules). */
import { DEG, KT } from "./atmosphere.ts";
import type { CountermeasureParams } from "./params.ts";
import type { V3 } from "./vec.ts";

/** Zero-allocation scalar notch effectiveness in [0, 1] for target (tx,ty,tz, tvx,tvy,tvz) observed from (ox,oy,oz). */
export function notchEffectRaw(
  ox: number,
  oy: number,
  oz: number,
  tx: number,
  ty: number,
  tz: number,
  tvx: number,
  tvy: number,
  tvz: number,
  cm: CountermeasureParams,
): number {
  if (cm.notchMaxKt <= 0) return 0;
  const dz = oz - tz;
  if (cm.notchLookDownDeg <= 0) {
    if (dz < -1) return 0;
  } else if (dz <= 0) {
    return 0;
  }

  const lx = tx - ox;
  const ly = ty - oy;
  const lz = tz - oz;
  const l = Math.sqrt(lx * lx + ly * ly + lz * lz);
  if (l < 1) return 0;

  let lookDownFactor: number;
  if (cm.notchLookDownDeg <= 0) {
    lookDownFactor = 1;
  } else {
    const horiz = Math.sqrt(lx * lx + ly * ly);
    const depressionDeg = Math.atan2(dz, Math.max(horiz, 1e-6)) / DEG;
    lookDownFactor = Math.max(0, Math.min(1, depressionDeg / cm.notchLookDownDeg));
  }

  const radialKt = Math.abs((tvx * lx + tvy * ly + tvz * lz) / l) / KT;
  const minKt = Math.max(0, cm.notchMinKt);
  const maxKt = Math.max(minKt, cm.notchMaxKt);
  let speedFactor: number;
  if (radialKt <= minKt) speedFactor = 1;
  else if (radialKt >= maxKt) speedFactor = 0;
  else speedFactor = (maxKt - radialKt) / (maxKt - minKt);

  return speedFactor * lookDownFactor;
}

/**
 * Notch effectiveness in [0, 1] for `target` observed from `observer`:
 *  - 0 when disabled (`notchMaxKt <= 0`) or looking up (`observer` below `target`);
 *  - ramps with look-down depression angle up to `notchLookDownDeg`;
 *  - ramps linearly with target 3D radial speed from 1 at `<= notchMinKt` to 0 at `>= notchMaxKt`.
 */
export function notchEffect(observer: V3, target: { pos: V3; vel: V3 }, cm: CountermeasureParams): number {
  return notchEffectRaw(
    observer.x,
    observer.y,
    observer.z,
    target.pos.x,
    target.pos.y,
    target.pos.z,
    target.vel.x,
    target.vel.y,
    target.vel.z,
    cm,
  );
}

/** Chance that a per-second rate fires within one step of dt seconds. */
export const chanceInStep = (ratePerS: number, dt: number): number =>
  1 - Math.exp(-Math.max(0, ratePerS) * dt);
