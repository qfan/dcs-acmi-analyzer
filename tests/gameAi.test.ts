// Whole NPC fights take a few seconds each, hence the longer timeouts below.
import { describe, expect, it } from "vitest";
import { type AiSkillId, DoctrineBot } from "../src/game/ai/doctrine.ts";
import { NM } from "../src/game/sim/atmosphere.ts";
import { cloneParams, DEFAULT_PARAMS } from "../src/game/sim/params.ts";
import { makeRng, randNormal } from "../src/game/sim/rng.ts";
import { scenarioById } from "../src/game/sim/scenarios.ts";
import { bearing, wrapPi } from "../src/game/sim/vec.ts";
import { command, jetById, step, type World } from "../src/game/sim/world.ts";

const P = () => cloneParams(DEFAULT_PARAMS);

function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("missing");
  return x;
}

function npcOf(w: World, id: string): DoctrineBot {
  const c = w.controllers.get(id);
  if (!(c instanceof DoctrineBot)) throw new Error(`${id} is not flown by the NPC`);
  return c;
}

function fight(scenario: string, blue: AiSkillId, red: AiSkillId, seed: number, altFt = 25000): World {
  const w = scenarioById(scenario).build(P(), altFt, seed, { redSkill: red, blueAi: blue });
  while (!w.outcome) step(w);
  return w;
}

describe("game: NPC knows only what its side can see", () => {
  it("does not react to a bandit beyond radar detection range", () => {
    const w = scenarioById("duel").build(P(), 25000, 1, { redSkill: "normal", blueAi: null });
    const red = must(jetById(w, "R1"));
    red.pos.y = 120 * NM; // well beyond the 80 nm detection range
    red.pos.x = 30 * NM;
    for (let i = 0; i < 500; i++) step(w);
    expect(red.targetId === "B1" && npcOf(w, "R1").state !== "commit").toBe(false);
    expect(Math.abs(red.hdg - Math.PI)).toBeLessThan(0.01); // still on its initial heading
  });

  it("turns cold when an active missile shows on its RWR", () => {
    const w = scenarioById("duel").build(P(), 25000, 2, { redSkill: "normal", blueAi: null });
    must(jetById(w, "R1")).pos.y = 25 * NM;
    expect(command(w, { type: "fire", jetId: "B1", targetId: "R1" })).toBeNull();
    let rwrAt: number | null = null;
    let defendAt: number | null = null;
    for (let i = 0; i < 6000 && defendAt === null && !w.outcome; i++) {
      step(w);
      if (rwrAt === null)
        rwrAt = w.events.find((e) => e.type === "rwr-missile" && e.targetId === "R1")?.t ?? null;
      if (npcOf(w, "R1").state === "defend") defendAt = w.t;
    }
    expect(rwrAt).not.toBeNull();
    expect(defendAt).not.toBeNull();
    // Reacts after its RWR showed the missile, within its (scaled) reaction time.
    expect(must(defendAt) - must(rwrAt)).toBeGreaterThanOrEqual(0);
    expect(must(defendAt) - must(rwrAt)).toBeLessThan(3 * 1.3 + 0.1);
  });

  it("keeps defending while an active missile remains on RWR instead of turning hot after a fixed timer", () => {
    const w = scenarioById("duel").build(P(), 25000, 3, { redSkill: "normal", blueAi: null });
    const red = must(jetById(w, "R1"));
    red.pos.y = 20 * NM;
    expect(command(w, { type: "fire", jetId: "B1", targetId: "R1" })).toBeNull();
    // Advance until R1 sees the active missile and enters defend.
    for (let i = 0; i < 3000 && npcOf(w, "R1").state !== "defend"; i++) step(w);
    expect(npcOf(w, "R1").state).toBe("defend");
    const m = must(w.missiles[0]);
    // Keep the missile active on R1's RWR for > 30 s (past the old 25 s defendForS cutoff).
    const holdUntil = w.t + 32;
    while (w.t < holdUntil) {
      m.phase = "tracking";
      m.targetId = red.id;
      m.tof = 5;
      m.pos = { x: red.pos.x, y: red.pos.y - 6 * NM, z: red.pos.z };
      m.vel = { x: 0, y: 800, z: 0 };
      step(w);
      expect(npcOf(w, "R1").state).toBe("defend");
    }
    // Never turned hot into the active missile (heading stays cold away from missile bearing).
    expect(Math.abs(wrapPi(red.hdg - bearing(m.pos, red.pos)))).toBeLessThan(0.25);
  });

  it("uses capped normal timing variation and breaks mirror symmetry in same-skill duels", () => {
    const rng = makeRng(42);
    const samples = Array.from({ length: 500 }, () => randNormal(rng, 2));
    expect(samples.every((x) => x >= -2 && x <= 2)).toBe(true);
    expect(samples.some((x) => x > 1)).toBe(true);
    expect(samples.some((x) => x < -1)).toBe(true);

    const crankXSigns = new Set<number>();
    const firstLaunchTimes = new Set<number>();
    for (let seed = 1; seed <= 8; seed++) {
      const w = scenarioById("duel").build(P(), 25000, seed, { redSkill: "normal", blueAi: "normal" });
      for (let i = 0; i < 4500 && !w.outcome; i++) {
        step(w);
        const b1 = must(jetById(w, "B1"));
        if (npcOf(w, "B1").state === "support" && Math.abs(b1.pos.x) > 500) {
          crankXSigns.add(Math.sign(b1.pos.x));
          break;
        }
      }
      const first = w.events.find((e) => e.type === "launch");
      if (first) firstLaunchTimes.add(Math.round(first.t));
    }
    expect(crankXSigns.size).toBe(2); // Blue cranks both East and West across seeds
    expect(firstLaunchTimes.size).toBeGreaterThan(2); // shot timing varies across seeds
  }, 60_000);

  it("drops a dead enemy from target selection immediately instead of chasing its ghost", () => {
    const w = scenarioById("2v2").build(P(), 25000, 1, { redSkill: "normal", blueAi: "normal" });
    for (let i = 0; i < 50; i++) step(w);
    const b1 = must(jetById(w, "B1"));
    const first = must(b1.targetId);
    must(jetById(w, first)).alive = false;
    // Even if B1 is turned away so its radar is not looking at the dead jet, it switches to the survivor.
    b1.hdg = Math.PI;
    step(w);
    expect(b1.targetId).not.toBe(first);
    expect(jetById(w, b1.targetId)?.alive).toBe(true);
  });
});

describe("game: NPC vs NPC", () => {
  it("wingmen take different bandits in a 2v2", () => {
    const w = scenarioById("2v2").build(P(), 25000, 4, { redSkill: "normal", blueAi: "normal" });
    for (let i = 0; i < 1500; i++) step(w); // 30 s: everyone detected at 60 nm
    const b1 = must(jetById(w, "B1")).targetId;
    const b2 = must(jetById(w, "B2")).targetId;
    expect(b1).not.toBeNull();
    expect(b2).not.toBeNull();
    expect(b1).not.toBe(b2);
  });

  it("a Hard NPC beats an Easy one most of the time", () => {
    let blueWins = 0;
    const n = 6;
    for (let seed = 1; seed <= n; seed++)
      if (fight("duel", "hard", "easy", seed).outcome?.kind === "win") blueWins++;
    expect(blueWins).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it("2v2 NPC fights end in a result, not the time limit", () => {
    for (const seed of [1, 2]) {
      const w = fight("2v2", "normal", "normal", seed);
      expect(w.outcome?.reason).not.toMatch(/Time limit/);
      expect(w.events.filter((e) => e.type === "launch").length).toBeGreaterThan(1);
    }
  }, 60_000);
});
