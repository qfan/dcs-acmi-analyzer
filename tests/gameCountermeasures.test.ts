/**
 * Statistical checks of the chaff rule: over many seeds the measured pull rate must match the
 * parameter, and with the default (deliberately weak) value a tracking missile must still usually hit.
 * There is no notch rule in the game: beaming only changes the geometry.
 */
import { describe, expect, it } from "vitest";
import { FT, NM } from "../src/game/sim/atmosphere.ts";
import { launchMissile, type Missile, type MissileEvent, stepMissile } from "../src/game/sim/missile.ts";
import { cloneParams, DEFAULT_PARAMS, type GameParams } from "../src/game/sim/params.ts";
import { makeRng } from "../src/game/sim/rng.ts";
import { add, norm, scale, type V3 } from "../src/game/sim/vec.ts";

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
 * of sight (what the Notch button steers to); "hot" flies straight at the missile. `chaffEveryS` releases
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
      if (ev.includes("seeker-chaffed")) breaks++;
    }
    // Chaff does something, but is far from a sure defence.
    expect(breaks / n).toBeGreaterThan(0.1);
    expect(hits / n).toBeGreaterThan(0.6);
  });
});
