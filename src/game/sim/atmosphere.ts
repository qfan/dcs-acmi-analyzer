/** International Standard Atmosphere, shared with the analyzer so both use the same air. */
import { speedOfSoundMs } from "../../analytics/atmosphere.ts";
import { airDensity } from "../../analytics/missileFit.ts";

export { airDensity, speedOfSoundMs };

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

/** Gas constant of air (J/kg/K) and ratio of specific heats, as in the shared ISA functions. */
const R_AIR = 287.05;
const GAMMA_AIR = 1.4;
/** Sea-level speed of sound (m/s). */
export const A0 = speedOfSoundMs(0);

/** ISA temperature (K), recovered from the speed of sound so it always matches it. */
export const isaTempK = (altM: number): number => speedOfSoundMs(altM) ** 2 / (GAMMA_AIR * R_AIR);

/** ISA static pressure (Pa): p = ρRT, so it is consistent with airDensity and speedOfSoundMs. */
export const pressurePa = (altM: number): number => airDensity(altM) * R_AIR * isaTempK(altM);

/** Sea-level standard pressure (Pa), ≈ 101,325; taken from pressurePa so CAS = TAS exactly at sea level. */
export const P0 = pressurePa(0);

/**
 * Pitot impact pressure qc = p_total − p (Pa) at Mach `m` and static pressure `p`: isentropic below
 * Mach 1, Rayleigh pitot formula (normal shock ahead of the probe) above.
 */
function impactPressure(m: number, p: number): number {
  if (m <= 1) return p * ((1 + 0.2 * m * m) ** 3.5 - 1);
  return p * ((166.9216 * m ** 7) / (7 * m * m - 1) ** 2.5 - 1);
}

/** Mach that gives impact pressure qc at static pressure p (inverse of impactPressure). */
function machFromImpact(qc: number, p: number): number {
  const r = qc / p + 1;
  const sub = Math.sqrt(5 * (r ** (2 / 7) - 1));
  if (sub <= 1) return sub;
  // Supersonic: bisection on the Rayleigh formula (monotonic in Mach), exact to ~1e-12.
  let lo = 1;
  let hi = 10;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (impactPressure(mid, p) < qc) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Calibrated airspeed (m/s) for Mach `m` at `altM`: what the airspeed indicator reads. */
export function casFromMach(m: number, altM: number): number {
  return A0 * machFromImpact(impactPressure(Math.max(0, m), pressurePa(altM)), P0);
}

/** Mach for calibrated airspeed `casMs` (m/s) at `altM`. */
export function machFromCas(casMs: number, altM: number): number {
  return machFromImpact(impactPressure(Math.max(0, casMs) / A0, P0), pressurePa(altM));
}

/** Calibrated airspeed (m/s) for true airspeed `tasMs` at `altM`. */
export const casFromTas = (tasMs: number, altM: number): number =>
  casFromMach(tasMs / speedOfSoundMs(altM), altM);

/** True airspeed (m/s) for calibrated airspeed `casMs` at `altM`. */
export const tasFromCas = (casMs: number, altM: number): number =>
  machFromCas(casMs, altM) * speedOfSoundMs(altM);
