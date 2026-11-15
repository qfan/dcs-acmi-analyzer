/** International Standard Atmosphere, shared with the analyzer so both use the same air. */
export { speedOfSoundMs } from "../../analytics/atmosphere.ts";
export { airDensity } from "../../analytics/missileFit.ts";

export const G = 9.80665;
export const RHO0 = 1.225;
export const NM = 1852;
export const FT = 0.3048;
export const KT = 1852 / 3600;
export const DEG = Math.PI / 180;

/** Linear interpolation in a breakpoint table, clamped at both ends. */
export function interp(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return Number.NaN;
  if (x <= (xs[0] as number)) return ys[0] as number;
  for (let i = 1; i < n; i++) {
    const x1 = xs[i] as number;
    if (x <= x1) {
      const x0 = xs[i - 1] as number;
      const y0 = ys[i - 1] as number;
      const y1 = ys[i] as number;
      return x1 > x0 ? y0 + ((y1 - y0) * (x - x0)) / (x1 - x0) : y1;
    }
  }
  return ys[n - 1] as number;
}
