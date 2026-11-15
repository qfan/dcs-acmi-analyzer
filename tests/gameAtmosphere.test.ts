import { describe, expect, it } from "vitest";
import {
  casFromMach,
  casFromTas,
  FT,
  isaTempK,
  KT,
  machFromCas,
  P0,
  pressurePa,
  speedOfSoundMs,
  tasFromCas,
} from "../src/game/sim/atmosphere.ts";

const kt = (ms: number) => ms / KT;

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
});
