/**
 * Statistical checks of the notch and chaff rules: over many seeds the measured break rates must
 * match the parameters, the rules must not fire when their conditions do not hold, and with the
 * default (deliberately weak) values a tracking missile must still usually hit.
 */
import { describe, expect, it } from "vitest";
import { FT, NM } from "../src/game/sim/atmosphere.ts";
import { launchMissile, type Missile, type MissileEvent, stepMissile } from "../src/game/sim/missile.ts";
import { cloneParams, DEFAULT_PARAMS, type GameParams } from "../src/game/sim/params.ts";
import { makeRng } from "../src/game/sim/rng.ts";
import { scenarioById } from "../src/game/sim/scenarios.ts";
import { add, len, norm, scale, sub, type V3 } from "../src/game/sim/vec.ts";
import { jetById, radarBroken, step } from "../src/game/sim/world.ts";

const DT = 0.02;
const ALT = 25000 * FT;
const TARGET_SPEED = 270;

interface Shot {
  m: Missile;
  tPos: V3;
  tVel: V3;
}

/** A missile already tracking a target `rangeM` ahead (north), `dz` above it. */
function trackingShot(p: GameParams, rangeM: number, dz = 0): Shot {
  const tPos = { x: 0, y: rangeM, z: ALT + dz };
  const tVel = { x: TARGET_SPEED, y: 0, z: 0 };
  const m = launchMissile(p.missile, {
    id: "m",
    side: "blue",
    shooterId: "s",
    targetId: "t",
    pos: { x: 0, y: 0, z: ALT },
    vel: { x: 0, y: 700, z: 0 },
    target: { pos: tPos, vel: tVel, alive: true },
  });
  m.tof = 20; // motor out, mid-flight
  m.pitbull = true;
  m.phase = "tracking";
  m.lofting = false;
  return { m, tPos, tVel };
}

type Manoeuvre = "beam" | "hot";

/**
 * Flies one shot for `seconds`. "beam" keeps the target exactly perpendicular to the missile's line
 * of sight (what the Notch button does); "hot" flies straight at the missile. `chaffEveryS` releases
 * a bundle that often (0 = never, -1 = once at the start). Returns the missile's events.
 */
function fly(
  p: GameParams,
  shot: Shot,
  seed: number,
  seconds: number,
  how: Manoeuvre,
  chaffEveryS = 0,
): MissileEvent[] {
  const rng = makeRng(seed);
  const out: MissileEvent[] = [];
  const { m } = shot;
  let lastChaff = Number.NEGATIVE_INFINITY;
  for (let t = 0; t < seconds && !m.end; t += DT) {
    const los = norm({ x: shot.tPos.x - m.pos.x, y: shot.tPos.y - m.pos.y, z: 0 });
    shot.tVel =
      how === "beam"
        ? { x: los.y * TARGET_SPEED, y: -los.x * TARGET_SPEED, z: 0 }
        : { x: -los.x * TARGET_SPEED, y: -los.y * TARGET_SPEED, z: 0 };
    shot.tPos = add(shot.tPos, scale(shot.tVel, DT));
    const release = chaffEveryS === -1 ? t === 0 : chaffEveryS > 0 && t - lastChaff >= chaffEveryS - 1e-9;
    if (release) lastChaff = t;
    const chaff = release ? { pos: { ...shot.tPos }, vel: scale(shot.tVel, 0.3) } : null;
    out.push(
      ...stepMissile(p.missile, m, { pos: shot.tPos, vel: shot.tVel, alive: true }, false, DT, undefined, {
        rng,
        cm: p.countermeasures,
        chaff,
      }),
    );
  }
  return out;
}

/** Fraction of seeds whose events include `event`. */
function rate(n: number, run: (seed: number) => MissileEvent[], event: MissileEvent): number {
  let k = 0;
  for (let seed = 1; seed <= n; seed++) if (run(seed).includes(event)) k++;
  return k / n;
}

/** Allowed deviation: four standard errors of a proportion, at least 0.02. */
const tolerance = (prob: number, n: number) => Math.max(0.02, 4 * Math.sqrt((prob * (1 - prob)) / n));

describe("notch against a missile seeker", () => {
  it("breaks lock at the configured rate per second while beaming at the same altitude", () => {
    const p = cloneParams(DEFAULT_PARAMS);
    const seconds = 5;
    const n = 600;
    const expected = 1 - Math.exp(-p.countermeasures.seekerNotchPerS * seconds);
    const got = rate(n, (seed) => fly(p, trackingShot(p, 15 * NM), seed, seconds, "beam"), "seeker-notched");
    expect(Math.abs(got - expected)).toBeLessThan(tolerance(expected, n));
  });

  it("follows the parameter (twice the rate, roughly twice the early breaks)", () => {
    const p = cloneParams(DEFAULT_PARAMS);
    p.countermeasures.seekerNotchPerS = 0.3;
    const seconds = 3;
    const n = 400;
    const expected = 1 - Math.exp(-0.3 * seconds);
    const got = rate(n, (seed) => fly(p, trackingShot(p, 15 * NM), seed, seconds, "beam"), "seeker-notched");
    expect(Math.abs(got - expected)).toBeLessThan(tolerance(expected, n));
  });

  it("never fires against a target above the missile (looking up) or flying hot", () => {
    const p = cloneParams(DEFAULT_PARAMS);
    p.countermeasures.seekerNotchPerS = 5; // would almost surely fire if the conditions held
    expect(rate(100, (s) => fly(p, trackingShot(p, 15 * NM, 1500), s, 5, "beam"), "seeker-notched")).toBe(0);
    expect(rate(100, (s) => fly(p, trackingShot(p, 15 * NM), s, 5, "hot"), "seeker-notched")).toBe(0);
  });
});

describe("chaff against a missile seeker", () => {
  it("pulls the lock with the configured chance per bundle", () => {
    const p = cloneParams(DEFAULT_PARAMS);
    const n = 2000;
    const expected = p.countermeasures.chaffPullChance;
    const got = rate(n, (seed) => fly(p, trackingShot(p, 15 * NM), seed, 0.1, "hot", -1), "seeker-chaffed");
    expect(Math.abs(got - expected)).toBeLessThan(tolerance(expected, n));
  });

  it("is only momentary: a pulled seeker usually finds the jet again", () => {
    const p = cloneParams(DEFAULT_PARAMS);
    p.countermeasures.chaffPullChance = 1; // force the pull to study what happens next
    let reacquired = 0;
    const n = 100;
    for (let seed = 1; seed <= n; seed++) {
      const ev = fly(p, trackingShot(p, 15 * NM), seed, 4, "hot", -1);
      if (ev[0] === "seeker-chaffed" && ev.includes("acquired")) reacquired++;
    }
    expect(reacquired / n).toBeGreaterThan(0.9);
  });
});

describe("with the default (weak) values", () => {
  it("a missile tracking a beaming, chaffing target from 10 nm still usually hits", () => {
    const p = cloneParams(DEFAULT_PARAMS);
    const n = 200;
    let hits = 0;
    let breaks = 0;
    for (let seed = 1; seed <= n; seed++) {
      const shot = trackingShot(p, 10 * NM);
      shot.m.vel = { x: 0, y: 800, z: 0 };
      const ev = fly(p, shot, seed, 60, "beam", 1);
      if (shot.m.end === "hit") hits++;
      if (ev.includes("seeker-notched") || ev.includes("seeker-chaffed")) breaks++;
    }
    // Notch and chaff do something, but are far from a sure defence.
    expect(breaks / n).toBeGreaterThan(0.1);
    expect(hits / n).toBeGreaterThan(0.6);
  });
});

describe("notch against a jet's radar", () => {
  it("breaks the lock at the configured rate while the bandit beams it at the same altitude", () => {
    const n = 300;
    const seconds = 10;
    let broken = 0;
    for (let seed = 1; seed <= n; seed++) {
      const w = scenarioById("duel").build(cloneParams(DEFAULT_PARAMS), 25000, seed);
      w.controllers.clear();
      const blue = jetById(w, "B1");
      const red = jetById(w, "R1");
      if (!blue || !red) throw new Error("missing jets");
      red.pos.y = blue.pos.y + 30 * NM;
      red.hdg = Math.PI / 2; // flying east: beam to the radar to its south
      red.steer = { mode: "heading", hdg: Math.PI / 2 };
      let hit = false;
      while (w.t < seconds) {
        step(w);
        if (radarBroken(w, blue, red)) hit = true;
      }
      if (hit) broken++;
      // Sanity: the geometry stays a beam for the whole run.
      expect(len(sub(red.pos, blue.pos))).toBeGreaterThan(25 * NM);
    }
    const expected = 1 - Math.exp(-DEFAULT_PARAMS.countermeasures.radarNotchPerS * seconds);
    expect(Math.abs(broken / n - expected)).toBeLessThan(tolerance(expected, n));
  });
});
