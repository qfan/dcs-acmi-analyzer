import { describe, expect, it } from "vitest";
import { speedOfSoundMs } from "../src/analytics/atmosphere.ts";
import {
  airDensity,
  canonicalMissile,
  FT_TO_M,
  fitMissileModels,
  G,
  MACH_BAND_COUNT,
  machBand,
} from "../src/analytics/missileFit.ts";
import {
  ALTITUDE_BANDS,
  buildFittedMissiles,
  LADDER_ALTS_FT,
  reachLadder,
  tierAltitudeScales,
} from "../src/analytics/missileReach.ts";
import { type MissileEngagement, TRACK_DT_S, TRACK_STRIDE } from "../src/analytics/model.ts";
import {
  COLD_REACH_ROWS,
  DEFAULT_MILSIM_TIMELINE,
  evaluateBvrTimeline,
  HOT_REACH_ROWS,
  scaleTimelineTable,
} from "../src/analytics/timeline.ts";

/** Ground truth used to generate the synthetic flyouts. */
const TRUTH = {
  cd: [6e-5, 9e-5, 9.5e-5, 8e-5, 7e-5, 6e-5],
  ci: 450,
  boostS: 7,
  boostAccel: 150,
  sustainEndS: 0,
  sustainAccel: 0,
};

/** Deterministic pseudo-random numbers so the test never flakes. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/**
 * Flies one missile in the vertical plane with the TRUTH physics: boost, then coast while easing from a
 * climb into a shallow dive, so samples cover many speeds, altitudes and lift levels.
 */
function syntheticShot(i: number, rand: () => number, truth = TRUTH): MissileEngagement {
  const alt0 = 2000 + rand() * 12000;
  const n = Math.round(70 / TRACK_DT_S);
  const data = new Float32Array(n * TRACK_STRIDE).fill(Number.NaN);
  const sub = 20;
  const dt = TRACK_DT_S / sub;
  let x = 0;
  let h = alt0;
  let v = speedOfSoundMs(h) * (0.8 + rand() * 0.2);
  let gam = ((rand() * 30 - 5) * Math.PI) / 180;
  const gamEnd = ((-5 - rand() * 10) * Math.PI) / 180;
  let maxV = 0;
  let maxAt = 0;
  let apex = h;
  for (let k = 0; k < n; k++) {
    const t = k * TRACK_DT_S;
    const b = k * TRACK_STRIDE;
    data[b] = x;
    data[b + 1] = 0;
    data[b + 2] = h;
    data[b + 3] = v;
    if (v > maxV) {
      maxV = v;
      maxAt = t;
    }
    apex = Math.max(apex, h);
    for (let j = 0; j < sub; j++) {
      const tt = t + j * dt;
      const rho = airDensity(h);
      const lift = 1.2 * (gamEnd - gam) * v + G * Math.cos(gam);
      const thrust = tt < truth.boostS ? truth.boostAccel : tt < truth.sustainEndS ? truth.sustainAccel : 0;
      const drag =
        truth.cd[machBand(v / speedOfSoundMs(h))]! * rho * v * v + (truth.ci * lift * lift) / (rho * v * v);
      v += (thrust - drag - G * Math.sin(gam)) * dt;
      gam += ((lift - G * Math.cos(gam)) / v) * dt;
      x += v * Math.cos(gam) * dt;
      h += v * Math.sin(gam) * dt;
    }
  }
  return {
    id: `s${i}`,
    domain: "A2A",
    isGun: false,
    weaponName: "AIM-120C",
    weaponClass: "A2A-ARH",
    isKill: false,
    dcsPatch: "2.9.10",
    shooter: { altM: alt0, name: "F-16C_50" },
    target: { altM: alt0 },
    initial: { slantRangeM: 40000, meanAltM: alt0 },
    flight: {
      tofS: (n - 1) * TRACK_DT_S,
      maxSpeedMs: maxV,
      maxMach: maxV / speedOfSoundMs(alt0),
      maxSpeedAtS: maxAt,
      apexGainM: apex - alt0,
      cpaMissileSpeedMs: null,
    },
    track: {
      dt: TRACK_DT_S,
      n,
      data,
      targetChaffS: [],
      targetFlareS: [],
      shooterChaffS: [],
      shooterFlareS: [],
    },
  } as unknown as MissileEngagement;
}

const shots = (count: number, seed: number, truth = TRUTH) => {
  const rand = rng(seed);
  return Array.from({ length: count }, (_, i) => syntheticShot(i, rand, truth));
};

describe("missile flyout fit", () => {
  const models = fitMissileModels(shots(60, 7));
  const m = models[0]!;

  it("groups Tacview names into one model per variant", () => {
    expect(canonicalMissile("P-77")).toBe("R-77");
    expect(canonicalMissile("AIM-120")).toBe("AIM-120B");
    expect(canonicalMissile("P-27PE")).toBe("R-27ER");
    expect(canonicalMissile("AIM-54C-Mk60")).toBe("AIM-54C-Mk60");
    expect(canonicalMissile("AIM-7")).toBe("AIM-7M");
  });

  it("recovers the drag table and motor it was generated with", () => {
    expect(models).toHaveLength(1);
    expect(m.weapon).toBe("AIM-120C");
    expect(m.quality).toBe("good");
    // Bands the flyouts spend most of their coast in: within 10%.
    for (const band of [2, 3, 4]) {
      expect(Math.abs(m.cd[band]! - TRUTH.cd[band]!) / TRUTH.cd[band]!).toBeLessThan(0.1);
    }
    expect(m.cd).toHaveLength(MACH_BAND_COUNT);
    expect(m.boostS).toBeCloseTo(TRUTH.boostS, 0);
    expect(Math.abs(m.boostAccel - TRUTH.boostAccel) / TRUTH.boostAccel).toBeLessThan(0.15);
    expect(m.replay.medianMach).toBeLessThan(0.05);
  });

  it("finds a sustain motor that keeps pushing after peak speed", () => {
    const sustain = { ...TRUTH, boostAccel: 40, boostS: 4.5, sustainEndS: 15, sustainAccel: 30 };
    const [s] = fitMissileModels(shots(60, 11, sustain));
    expect(s!.motorEndS).toBeGreaterThan(12);
    expect(s!.motorEndS).toBeLessThan(18);
  });

  it("needs enough shots before it fits anything", () => {
    expect(fitMissileModels(shots(10, 3))).toHaveLength(0);
  });

  it("reaches further the higher it is launched, and no-escape is shorter than head-on", () => {
    const ladder = reachLadder(m);
    expect(ladder.map((r) => r.altFt)).toEqual([...LADDER_ALTS_FT]);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]!.hotDirectNm).toBeGreaterThan(ladder[i - 1]!.hotDirectNm);
      expect(ladder[i]!.coldNm).toBeGreaterThan(ladder[i - 1]!.coldNm);
    }
    for (const r of ladder) {
      expect(r.coldNm).toBeLessThan(r.hotDirectNm);
      expect(r.dangerousColdNm).toBeLessThanOrEqual(r.coldNm);
    }
  });

  it("does not truncate reach ladders when observed kills only occurred at short TOF", () => {
    const base = shots(40, 23);
    const withShortKills = base.map((e, i) =>
      i < 5
        ? ({
            ...e,
            isKill: true,
            flight: { ...e.flight!, tofS: 15, cpaMissileSpeedMs: 320 },
          } as unknown as MissileEngagement)
        : e,
    );
    const [fittedShortKills] = fitMissileModels(withShortKills);
    expect(fittedShortKills!.maxKillTofS).toBe(15);
    const ladder = reachLadder(fittedShortKills!);
    expect(ladder).toEqual(reachLadder({ ...fittedShortKills!, maxKillTofS: null }));
    const rung35k = ladder.find((r) => r.altFt === 35000)!;
    expect(rung35k.hotDirectNm).toBeGreaterThan(30);
    expect(rung35k.coldNm).toBeGreaterThan(15);
  });

  it("recovers finite positive boost acceleration and non-zero reach for short-burn missiles", () => {
    const shortBurn = { ...TRUTH, boostS: 2.5, boostAccel: 400 };
    const [sb] = fitMissileModels(shots(40, 29, shortBurn));
    expect(sb).toBeDefined();
    expect(sb!.boostS).toBeCloseTo(2.5, 0);
    expect(Number.isFinite(sb!.boostAccel)).toBe(true);
    expect(sb!.boostAccel).toBeGreaterThan(250);
    const ladder = reachLadder(sb!);
    for (const r of ladder) {
      expect(r.hotDirectNm).toBeGreaterThan(0);
      expect(r.coldNm).toBeGreaterThan(0);
    }
  });
});

describe("altitude-scaled BVR timeline", () => {
  const engs = shots(60, 7);
  const fitted = buildFittedMissiles(fitMissileModels(engs), engs);

  it("leaves the chart unchanged at its own altitude and shrinks it lower down", () => {
    expect(fitted[0]!.tier).toBe("AR-2");
    const high = tierAltitudeScales(fitted, "high");
    expect(high["AR-2"]!.hot).toBe(1);
    expect(high["AR-2"]!.cold).toBe(1);
    const deck = tierAltitudeScales(fitted, "deck");
    expect(deck["AR-2"]!.cold).toBeLessThan(0.6);
    expect(deck["AR-2"]!.borrowed).toBe(false);
    // Tiers with no fitted missile borrow the average of all fitted missiles.
    expect(deck["AR-1"]!.borrowed).toBe(true);
  });

  it("scales only the kinematic gates and keeps their order", () => {
    const scaled = scaleTimelineTable(DEFAULT_MILSIM_TIMELINE, tierAltitudeScales(fitted, "low"));
    const base = DEFAULT_MILSIM_TIMELINE["AR-2"];
    const col = scaled["AR-2"];
    for (const k of HOT_REACH_ROWS) expect(col[k]).toBeLessThan(base[k]);
    for (const k of COLD_REACH_ROWS) expect(col[k]).toBeLessThan(base[k]);
    for (const k of ["ofrNm", "dfrNm", "nltCommitNm", "pumpNm", "tacRangeNm", "meldSortNm"] as const)
      expect(col[k]).toBe(base[k]);
    expect(col.morNm).toBeGreaterThanOrEqual(col.drNm);
    expect(col.drNm).toBeGreaterThanOrEqual(col.marNm);
    expect(col.marNm).toBeGreaterThanOrEqual(col.sternWezNm);
  });

  it("keeps only shots launched in the chosen band", () => {
    const deck = ALTITUDE_BANDS.deck;
    const inBand = engs.filter((e) => e.initial!.meanAltM / FT_TO_M < deck.maxFt).length;
    const ev = evaluateBvrTimeline(engs, new Map(), DEFAULT_MILSIM_TIMELINE, {
      altBandFt: { minFt: deck.minFt, maxFt: deck.maxFt },
    });
    expect(ev["AR-2"].shots).toBe(inBand);
    expect(inBand).toBeGreaterThan(0);
    expect(inBand).toBeLessThan(engs.length);
  });
});
