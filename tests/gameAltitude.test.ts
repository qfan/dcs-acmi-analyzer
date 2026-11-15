import { describe, expect, it } from "vitest";
import { AI_SKILLS, DoctrineBot } from "../src/game/ai/doctrine.ts";
import { DEFAULT_AUTOPAUSE, GameSession } from "../src/game/engine/session.ts";
import {
  energyHeightM,
  type Jet,
  mach,
  makeJet,
  minSpeedMs,
  stepJet,
  velocity,
} from "../src/game/sim/aircraft.ts";
import { FT, KT, NM, speedOfSoundMs } from "../src/game/sim/atmosphere.ts";
import { launchMissile, missileMach, stepMissile } from "../src/game/sim/missile.ts";
import { cloneParams, DEFAULT_PARAMS, type GameParams } from "../src/game/sim/params.ts";
import { scenarioById } from "../src/game/sim/scenarios.ts";
import { launchZone } from "../src/game/sim/wez.ts";
import { command, jetById, step } from "../src/game/sim/world.ts";

const P = () => cloneParams(DEFAULT_PARAMS);
const DT = 0.02;

function jetAt(p: GameParams, altFt: number, m: number, y = 0, hdgDeg = 0, side: "blue" | "red" = "blue") {
  return makeJet(p.aircraft, { id: side, side, callsign: side, x: 0, y, altM: altFt * FT, hdgDeg, mach: m });
}

/** Flies straight for `s` seconds, calling `each` after every step. */
function fly(p: GameParams, j: Jet, s: number, each?: (j: Jet) => void) {
  for (let i = 0; i < Math.round(s / DT); i++) {
    stepJet(p.aircraft, j, j.hdg, DT);
    each?.(j);
  }
}

describe("game: altitude and energy", () => {
  it("holds altitude in level flight and in a max-g turn when no climb is ordered", () => {
    const p = P();
    const j = jetAt(p, 20000, 0.9);
    j.effort = "max";
    j.throttle = "ab";
    let worst = 0;
    for (let i = 0; i < 1500; i++) {
      stepJet(p.aircraft, j, j.hdg + 1, DT);
      worst = Math.max(worst, Math.abs(j.pos.z - 20000 * FT));
    }
    expect(worst).toBeLessThan(30 * FT);
  });

  it("trades speed for height in a climb and buys it back in a dive", () => {
    const p = P();
    const j = jetAt(p, 15000, 0.9);
    j.altCmd = 30000 * FT;
    let minMach = mach(j);
    fly(p, j, 90, (x) => {
      minMach = Math.min(minMach, mach(x));
    });
    expect(j.pos.z / FT).toBeGreaterThan(29000);
    expect(minMach).toBeLessThan(0.78); // a Normal climb at MIL bleeds speed

    const k = jetAt(p, 30000, 0.9);
    k.altCmd = 10000 * FT;
    let maxMach = mach(k);
    fly(p, k, 90, (x) => {
      maxMach = Math.max(maxMach, mach(x));
    });
    expect(k.pos.z / FT).toBeLessThan(11000);
    expect(maxMach).toBeGreaterThan(1.1);
  });

  it("Hold Spd climbs only on excess power, holding Mach", () => {
    const p = P();
    const j = jetAt(p, 15000, 0.9);
    j.effort = "sustain";
    j.altCmd = 30000 * FT;
    const m0 = mach(j);
    let worst = 0;
    fly(p, j, 60, (x) => {
      worst = Math.max(worst, Math.abs(mach(x) - m0));
    });
    expect(j.pos.z / FT).toBeGreaterThan(20000);
    expect(worst).toBeLessThan(0.01);
    // Constant Mach in the troposphere: true airspeed falls with temperature, and that speed went into height.
    expect(j.speed).toBeLessThan(m0 * speedOfSoundMs(15000 * FT) - 5 * KT);
  });

  it("a zoom climb tops out instead of stalling", () => {
    const p = P();
    const j = jetAt(p, 15000, 0.9);
    j.effort = "max";
    j.altCmd = 45000 * FT;
    let peak = 0;
    let slowest = Number.POSITIVE_INFINITY;
    fly(p, j, 60, (x) => {
      peak = Math.max(peak, x.pos.z);
      slowest = Math.min(slowest, x.speed / minSpeedMs(p.aircraft, x.pos.z));
    });
    expect(peak / FT).toBeLessThan(40000);
    expect(peak / FT).toBeGreaterThan(25000);
    expect(slowest).toBeGreaterThan(1.05); // never pinned on the minimum-speed floor
  });

  it("at idle, energy height only falls: a climb cannot make energy", () => {
    const p = P();
    const j = jetAt(p, 15000, 0.9);
    j.effort = "max";
    j.throttle = "idle";
    j.altCmd = 40000 * FT;
    const es0 = energyHeightM(j);
    let most = es0;
    fly(p, j, 30, (x) => {
      most = Math.max(most, energyHeightM(x));
    });
    expect(most).toBeLessThan(es0 + 1);
    expect(energyHeightM(j)).toBeLessThan(es0 - 500 * FT);
  });

  it("levels off at the hard deck, and orders below it are clamped", () => {
    const p = P();
    const w = scenarioById("duel").build(p, 35000, 3);
    const b = jetById(w, "B1") as Jet;
    w.controllers.clear();
    command(w, { type: "throttle", jetId: "B1", throttle: "ab" });
    command(w, { type: "effort", jetId: "B1", effort: "max" });
    command(w, { type: "altitude", jetId: "B1", altM: -5000 });
    expect(b.altCmd).toBeCloseTo(p.aircraft.minAltFt * FT, 3);
    command(w, { type: "altitude", jetId: "B1", altM: 1e6 });
    expect(b.altCmd).toBeCloseTo(p.aircraft.ceilingFt * FT, 3);
    command(w, { type: "altitude", jetId: "B1", altM: 0 });
    let lowest = b.pos.z;
    for (let i = 0; i < 6000; i++) {
      step(w);
      lowest = Math.min(lowest, b.pos.z);
    }
    expect(b.alive).toBe(true);
    expect(lowest / FT).toBeGreaterThan(p.aircraft.minAltFt - 200);
  });

  it("a jet that reaches the ground is lost", () => {
    const p = P();
    const w = scenarioById("duel").build(p, 5000, 3);
    w.controllers.clear();
    const b = jetById(w, "B1") as Jet;
    b.altCmd = -3000 * FT; // bypasses the hard deck on purpose
    b.effort = "max";
    for (let i = 0; i < 3000 && b.alive; i++) step(w);
    expect(b.alive).toBe(false);
    expect(w.events.some((e) => e.type === "kill" && e.text.includes("ground"))).toBe(true);
  });

  it("altitude orders go through GameSession, and missiles inherit the climb", () => {
    const s = new GameSession("duel", 15000, P(), DEFAULT_AUTOPAUSE, 1);
    const j = jetById(s.world, "B1") as Jet;
    expect(s.applyCommand({ type: "altitude", jetId: j.id, altM: 25000 * FT })).toBeNull();
    for (let i = 0; i < 50; i++) s.advance(0.1);
    expect(j.gamma).toBeGreaterThan(0.05);
    expect(velocity(j).z).toBeGreaterThan(10);
  });
});

describe("game: missiles and air density", () => {
  it("reaches much further fired from high than from low at the same target", () => {
    const p = P();
    const zone = (shooterFt: number) =>
      launchZone(p.missile, jetAt(p, shooterFt, 0.9), jetAt(p, 25000, 0.9, 30 * NM, 180, "red"));
    const low = zone(10000);
    const high = zone(40000);
    expect(high.rmaxNm).toBeGreaterThan(low.rmaxNm * 2);
    expect(high.rneNm).toBeGreaterThan(low.rneNm);
    // Speed helps too, less than height.
    const fast = jetAt(p, 25000, 1.3);
    const slow = jetAt(p, 25000, 0.9);
    const tgt = jetAt(p, 25000, 0.9, 30 * NM, 180, "red");
    expect(launchZone(p.missile, fast, tgt).rmaxNm).toBeGreaterThan(launchZone(p.missile, slow, tgt).rmaxNm);
  });

  it("a target that dives into thick air makes the same shot arrive much slower", () => {
    const p = P();
    /** Shooter at 35k fires at a hot target 40 nm ahead; returns the missile's state at the end. */
    const run = (targetAltCmdFt: number) => {
      const shooter = jetAt(p, 35000, 0.9);
      const target = jetAt(p, 35000, 0.9, 40 * NM, 180, "red");
      target.throttle = "ab";
      target.effort = "max";
      target.altCmd = targetAltCmdFt * FT;
      const m = launchMissile(p.missile, {
        id: "M",
        side: "blue",
        shooterId: "blue",
        targetId: "red",
        pos: { ...shooter.pos },
        vel: velocity(shooter),
        target: { pos: { ...target.pos }, vel: velocity(target), alive: true },
      });
      for (let i = 0; i < p.missile.maxTofS / DT && !m.end; i++) {
        stepJet(p.aircraft, target, target.hdg, DT);
        stepMissile(p.missile, m, { pos: { ...target.pos }, vel: velocity(target), alive: true }, true, DT);
      }
      return { mach: missileMach(m), end: m.end };
    };
    const high = run(35000);
    const low = run(8000);
    expect(high.end).toBe("hit");
    expect(low.end).toBe("hit");
    expect(low.mach).toBeLessThan(high.mach - 0.2);
  });
});

describe("game: NPC altitude tactics (off by default, available per skill)", () => {
  const climber = { ...AI_SKILLS.hard, commitAltFt: 30000, defendDropFt: 8000 };

  it("default skills hold their altitude", () => {
    const w = scenarioById("duel").build(P(), 15000, 5, { redSkill: "hard", blueAi: "easy" });
    for (let i = 0; i < 60 / DT; i++) step(w);
    for (const id of ["B1", "R1"])
      expect(Math.abs((jetById(w, id) as Jet).pos.z / FT - 15000)).toBeLessThan(300);
  });

  it("with a commit altitude, climbs in Hold Spd and keeps its speed", () => {
    const w = scenarioById("duel").build(P(), 15000, 5, { redSkill: "easy", blueAi: "easy" });
    w.controllers.set("R1", new DoctrineBot(climber));
    const red = jetById(w, "R1") as Jet;
    const m0 = mach(red);
    let slowest = m0;
    for (let i = 0; i < 60 / DT; i++) {
      step(w);
      slowest = Math.min(slowest, mach(red));
    }
    expect(red.pos.z / FT).toBeGreaterThan(20000);
    expect(slowest).toBeGreaterThan(m0 - 0.05);
  });

  it("with a defensive dive, dives when an active missile shows", () => {
    const p = P();
    const w = scenarioById("duel").build(p, 30000, 9, { redSkill: "normal", blueAi: null });
    w.controllers.set("R1", new DoctrineBot(climber));
    const red = jetById(w, "R1") as Jet;
    red.pos.y = 18 * NM; // close enough that blue's shot reaches pitbull quickly
    const bot = w.controllers.get("R1") as DoctrineBot;
    let defendAlt: number | null = null;
    for (let i = 0; i < 400 / DT && !w.outcome && red.alive; i++) {
      const blue = jetById(w, "B1") as Jet;
      const rangeNm = Math.hypot(red.pos.x - blue.pos.x, red.pos.y - blue.pos.y) / NM;
      if (rangeNm < 25 && !w.missiles.some((m) => m.side === "blue"))
        command(w, { type: "fire", jetId: blue.id, targetId: red.id });
      step(w);
      if (bot.state === "defend" && defendAlt === null) defendAlt = red.altCmd;
    }
    expect(defendAlt).not.toBeNull();
    expect((defendAlt as number) / FT).toBeLessThan(25000);
  });
});
