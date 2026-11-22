import { describe, expect, it } from "vitest";
import { minSpeedMs, thrustN } from "../src/game/sim/aircraft.ts";
import {
  airDensity,
  casFromMach,
  casFromTas,
  FT,
  G,
  interp,
  isaTempK,
  KT,
  machFromCas,
  P0,
  pressurePa,
  RHO0,
  speedOfSoundMs,
  tasFromCas,
} from "../src/game/sim/atmosphere.ts";
import { cloneParams, DEFAULT_PARAMS } from "../src/game/sim/params.ts";

const kt = (ms: number) => ms / KT;

function exactIsaDensity(altM: number): number {
  const h = Math.max(0, Math.min(30000, altM));
  return h <= 11000
    ? 1.225 * ((288.15 - 0.0065 * h) / 288.15) ** 4.2559
    : 0.36392 * Math.exp(-(h - 11000) / 6341.6);
}

describe("game: ISA pressure and airspeed conversions", () => {
  it("matches standard-atmosphere pressure and temperature", () => {
    expect(pressurePa(0)).toBeCloseTo(P0, -1);
    expect(isaTempK(0)).toBeCloseTo(288.15, 1);
    expect(pressurePa(11000)).toBeCloseTo(22632, -2);
    expect(isaTempK(36089 * FT)).toBeCloseTo(216.65, 1);
  });

  it("calibrated equals true airspeed at sea level, sub- and supersonic", () => {
    for (const m of [0.3, 0.9, 1.5]) expect(casFromMach(m, 0)).toBeCloseTo(m * speedOfSoundMs(0), 3);
  });

  it("gives textbook calibrated airspeeds at altitude", () => {
    // M0.9 at FL360 is about 303 KCAS; M0.8 at FL350 about 271 KCAS; 250 KCAS at 10,000 ft is ~290 KTAS.
    expect(kt(casFromMach(0.9, 36000 * FT))).toBeCloseTo(303, -1);
    expect(kt(casFromMach(0.8, 35000 * FT))).toBeCloseTo(271, -1);
    expect(kt(tasFromCas(250 * KT, 10000 * FT))).toBeCloseTo(290, -1);
  });

  it("round-trips through Mach and true airspeed, including supersonic", () => {
    for (const ft of [0, 15000, 30000, 45000, 60000])
      for (const m of [0.2, 0.8, 0.99, 1.01, 1.6, 2.2]) {
        const h = ft * FT;
        expect(machFromCas(casFromMach(m, h), h)).toBeCloseTo(m, 6);
        const tas = m * speedOfSoundMs(h);
        expect(tasFromCas(casFromTas(tas, h), h)).toBeCloseTo(tas, 3);
      }
  });

  it("calibrated airspeed rises with Mach without a jump at Mach 1", () => {
    const h = 30000 * FT;
    const below = casFromMach(0.9999, h);
    const above = casFromMach(1.0001, h);
    expect(above).toBeGreaterThan(below);
    expect(above - below).toBeLessThan(0.1);
  });

  it("airDensity LUT matches ISA across knots, off-grid altitudes, bounds, and NaN", () => {
    for (const h of [0, 11000, 30000]) {
      expect(airDensity(h)).toBeCloseTo(exactIsaDensity(h), 12);
    }
    for (const h of [25, 3712, 10987, 11023, 18456, 29975, 29999.999999]) {
      const ref = exactIsaDensity(h);
      expect(Math.abs(airDensity(h) - ref) / ref).toBeLessThan(1e-4);
    }
    expect(airDensity(-500)).toBe(airDensity(0));
    expect(airDensity(40000)).toBe(airDensity(30000));
    expect(airDensity(Number.NaN)).toBeNaN();
  });

  it("minSpeedMs and thrustN LUTs stay accurate across 0-30 km and invalidate on in-place param mutation", () => {
    const p = cloneParams(DEFAULT_PARAMS).aircraft;
    for (const h of [25, 4320, 11000, 14750, 29999.999999]) {
      const rho = Math.max(airDensity(h), 1e-4);
      const iasFloor = tasFromCas(p.minSpeedKt * KT, h);
      const m = iasFloor / speedOfSoundMs(h);
      const cl1g = Math.max(interp(p.tableMach, p.clMax, m), 0.1);
      const stall1g = Math.sqrt((2 * p.massKg * G) / (rho * Math.max(p.wingAreaM2, 1) * cl1g));
      const refMin = Math.max(1, iasFloor, stall1g);
      expect(Math.abs(minSpeedMs(p, h) - refMin) / refMin).toBeLessThan(1e-4);

      const refThrust =
        p.abThrustKn * 1000 * (airDensity(h) / RHO0) ** p.thrustDensityExp * (1 + p.thrustMachGain * 0.9);
      expect(Math.abs(thrustN(p, "ab", h, 0.9) - refThrust) / refThrust).toBeLessThan(1e-4);
    }

    const beforeMin = minSpeedMs(p, 5000);
    p.minSpeedKt += 60;
    expect(minSpeedMs(p, 5000)).toBeGreaterThan(beforeMin + 25);

    const beforeThrust = thrustN(p, "mil", 10000, 0.8);
    p.thrustDensityExp += 0.3;
    expect(thrustN(p, "mil", 10000, 0.8)).toBeLessThan(beforeThrust * 0.85);
  });
});
