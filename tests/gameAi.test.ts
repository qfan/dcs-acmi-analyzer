// Whole NPC fights take a few seconds each, hence the longer timeouts below.
import { describe, expect, it } from "vitest";
import { AI_SKILLS, type AiSkillId, DoctrineBot } from "../src/game/ai/doctrine.ts";
import { makeJet } from "../src/game/sim/aircraft.ts";
import { NM } from "../src/game/sim/atmosphere.ts";
import { cloneParams, DEFAULT_PARAMS } from "../src/game/sim/params.ts";
import { makeRng, randNormal } from "../src/game/sim/rng.ts";
import { DEFAULT_OPTIONS, scenarioById } from "../src/game/sim/scenarios.ts";
import { bearing, wrapPi } from "../src/game/sim/vec.ts";
import {
  awaitingCall,
  command,
  jetById,
  step,
  type World,
  waitingOnMissiles,
} from "../src/game/sim/world.ts";
import { DEFAULT_AUTOPAUSE, GameSession } from "../src/game/engine/session.ts";

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

  it("stops defending promptly once leaving the illumination cone of a missile tracking another jet", () => {
    const w = scenarioById("2v2").build(P(), 25000, 3, { redSkill: "hard", blueAi: null });
    const r1 = must(jetById(w, "R1"));
    const r2 = must(jetById(w, "R2"));
    r1.pos = { x: -20 * NM, y: 40 * NM, z: r1.pos.z };
    r2.pos = { x: 2 * NM, y: 20 * NM, z: r2.pos.z };
    expect(command(w, { type: "fire", jetId: "B1", targetId: "R1" })).toBeNull();
    const m = must(w.missiles[0]);

    // Step until R2 reacts to stray illumination from the missile while it is tracking R1.
    for (let i = 0; i < 600 && npcOf(w, "R2").state !== "defend"; i++) {
      m.phase = "tracking";
      m.targetId = "R1";
      m.tof = 5;
      m.pos = { x: r2.pos.x, y: r2.pos.y - 5 * NM, z: r2.pos.z };
      m.vel = { x: 0, y: 800, z: 0 };
      step(w);
    }
    expect(npcOf(w, "R2").state).toBe("defend");

    // Missile continues chasing R1 far outside R2's illumination cone.
    const leftConeAt = w.t;
    while (w.t < leftConeAt + 1.0) {
      m.phase = "tracking";
      m.targetId = "R1";
      m.tof = 5;
      m.pos = { x: r1.pos.x, y: r1.pos.y - 6 * NM, z: r1.pos.z };
      m.vel = { x: 0, y: 800, z: 0 };
      step(w);
    }
    expect(m.end).toBeNull();
    // Should exit defend promptly (< 1 s) instead of holding hard defendHoldS (~8 s) until the missile ends.
    expect(npcOf(w, "R2").state).not.toBe("defend");
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

  it("2v1 spawns two blue jets against one red jet and finishes cleanly", () => {
    const human = scenarioById("2v1").build(P(), 25000, 1, { redSkill: "normal", blueAi: null });
    expect(human.jets.filter((j) => j.side === "blue").map((j) => j.id)).toEqual(["B1", "B2"]);
    expect(human.jets.filter((j) => j.side === "red").map((j) => j.id)).toEqual(["R1"]);
    expect(must(jetById(human, "B1")).targetId).toBe("R1");
    expect(must(jetById(human, "B2")).targetId).toBe("R1");

    const w = fight("2v1", "normal", "normal", 1);
    expect(w.outcome?.reason).not.toMatch(/Time limit/);
  }, 60_000);

  it("4v2 spawns 2x2 blue (5 nm abreast, 20 nm trail) against 2 red (5 nm abreast) and finishes cleanly", () => {
    const p = P();
    p.aircraft.missiles = 8;
    const human = scenarioById("4v2").build(p, 25000, 1, { redSkill: "normal", blueAi: null });
    expect(human.jets.filter((j) => j.side === "blue").map((j) => j.id)).toEqual(["B1", "B2", "B3", "B4"]);
    expect(human.jets.filter((j) => j.side === "red").map((j) => j.id)).toEqual(["R1", "R2"]);
    expect(human.jets.every((j) => j.missiles === 8)).toBe(true);
    expect(must(jetById(human, "B1")).pos).toMatchObject({ x: -2.5 * NM, y: 0 });
    expect(must(jetById(human, "B2")).pos).toMatchObject({ x: 2.5 * NM, y: 0 });
    expect(must(jetById(human, "B3")).pos).toMatchObject({ x: -2.5 * NM, y: -20 * NM });
    expect(must(jetById(human, "B4")).pos).toMatchObject({ x: 2.5 * NM, y: -20 * NM });
    expect(must(jetById(human, "R1")).pos).toMatchObject({ x: -2.5 * NM, y: 60 * NM });
    expect(must(jetById(human, "R2")).pos).toMatchObject({ x: 2.5 * NM, y: 60 * NM });
    expect(must(jetById(human, "B1")).targetId).toBe("R1");
    expect(must(jetById(human, "B2")).targetId).toBe("R2");
    expect(must(jetById(human, "B3")).targetId).toBe("R1");
    expect(must(jetById(human, "B4")).targetId).toBe("R2");

    const w = fight("4v2", "normal", "normal", 1);
    expect(w.outcome?.reason).not.toMatch(/Time limit/);
  }, 60_000);

  it("2v2 NPC fights end in a result, not the time limit", () => {
    for (const seed of [1, 2]) {
      const w = fight("2v2", "normal", "normal", seed);
      expect(w.outcome?.reason).not.toMatch(/Time limit/);
      expect(w.events.filter((e) => e.type === "launch").length).toBeGreaterThan(1);
    }
  }, 60_000);

  it("Hard NPC employs posture shots only when abundant (full load or >=8) and target is not cold", () => {
    const setup = (skill: AiSkillId, missiles: number, redHdgDeg: number) => {
      const p = P();
      p.aircraft.missiles = missiles;
      const w = scenarioById("duel").build(p, 25000, 1, { redSkill: skill, blueAi: skill });
      w.controllers.delete("R1");
      const r1 = must(jetById(w, "R1"));
      r1.pos.y = 40 * NM;
      r1.hdg = (redHdgDeg * Math.PI) / 180;
      command(w, { type: "steer", jetId: "R1", steer: { mode: "heading", hdg: r1.hdg } });
      return w;
    };

    // Normal does not posture-shot a 50°-cranking enemy at 40 nm (collapsed Rmax ~18 nm).
    const wNorm = setup("normal", 4, 130);
    step(wNorm);
    expect(wNorm.missiles).toHaveLength(0);

    // Hard with last missile (1) does not posture-shot, nor against a cold enemy (hdg 0°).
    const wLast = setup("hard", 1, 130);
    step(wLast);
    expect(wLast.missiles).toHaveLength(0);

    const wCold = setup("hard", 4, 0);
    step(wCold);
    expect(wCold.missiles).toHaveLength(0);

    // Hard with full 4 missiles posture-shots shot #1 vs cranking enemy, then saves shot #2 (3 left).
    const wFull = setup("hard", 4, 130);
    step(wFull);
    expect(wFull.missiles).toHaveLength(1);
    const b1 = must(jetById(wFull, "B1"));
    const r1 = must(jetById(wFull, "R1"));
    const cooldown = (
      w: World,
      b: { pos: { x: number; y: number; z: number } },
      r: { pos: { y: number } },
    ) => {
      r.pos.y = b.pos.y + 68 * NM; // stay inside radar track range while holding outside WEZ during pump cooldown
      for (let i = 0; i < 900; i++) step(w);
    };

    must(wFull.missiles[0]).end = "spent";
    cooldown(wFull, b1, r1);
    r1.pos = { x: b1.pos.x, y: b1.pos.y + 45 * NM, z: b1.pos.z };
    b1.hdg = 0;
    for (let i = 0; i < 50; i++) step(wFull); // refresh zone cache (> ZONE_EVERY_S)
    expect(wFull.missiles).toHaveLength(1); // still 1: does not posture-shot with 3/4 left

    // Hard carrying >= 8 missiles keeps posture-shotting down to 8, then conserves from 7.
    const wHeavy = setup("hard", 9, 130);
    step(wHeavy);
    expect(must(jetById(wHeavy, "B1")).missiles).toBe(8);
    const hb = must(jetById(wHeavy, "B1"));
    const hr = must(jetById(wHeavy, "R1"));
    must(wHeavy.missiles[0]).end = "spent";
    cooldown(wHeavy, hb, hr);
    hr.pos = { x: hb.pos.x, y: hb.pos.y + 45 * NM, z: hb.pos.z };
    hb.hdg = 0;
    for (let i = 0; i < 50; i++) step(wHeavy);
    expect(hb.missiles).toBe(7); // fired posture shot #2 while 8 were onboard
    must(wHeavy.missiles[1]).end = "spent";
    cooldown(wHeavy, hb, hr);
    hr.pos = { x: hb.pos.x, y: hb.pos.y + 45 * NM, z: hb.pos.z };
    hb.hdg = 0;
    for (let i = 0; i < 50; i++) step(wHeavy);
    expect(hb.missiles).toBe(7); // stops posture-shooting once below 8
  });

  it("Hard NPC fires follow-up round inside WEZ even if opponent cranks after posture round", () => {
    const p = P();
    const w = scenarioById("duel").build(p, 25000, 1, { redSkill: "hard", blueAi: "hard" });
    w.controllers.delete("R1");
    const b1 = must(jetById(w, "B1"));
    const r1 = must(jetById(w, "R1"));
    r1.pos.y = 45 * NM;
    r1.hdg = (130 * Math.PI) / 180;
    command(w, { type: "steer", jetId: "R1", steer: { mode: "heading", hdg: r1.hdg } });
    step(w);
    expect(w.missiles).toHaveLength(1); // posture shot #1

    must(w.missiles[0]).end = "spent";
    r1.pos.y = b1.pos.y + 68 * NM;
    for (let i = 0; i < 900; i++) step(w);
    // Re-stage round 2 with cranking opponent at 28 nm: well within WEZ, should shoot promptly.
    r1.pos = { x: b1.pos.x, y: b1.pos.y + 28 * NM, z: b1.pos.z };
    r1.hdg = (130 * Math.PI) / 180;
    command(w, { type: "steer", jetId: "R1", steer: { mode: "heading", hdg: r1.hdg } });
    b1.hdg = 0;
    for (let i = 0; i < 50; i++) step(w);
    expect(w.missiles).toHaveLength(2);
  });

  it("both Hard NPCs fire on the opening merge instead of getting crank-locked out", () => {
    for (const seed of [1, 2, 3]) {
      const w = scenarioById("duel").build(P(), 25000, seed, { redSkill: "hard", blueAi: "hard" });
      let bShot = false;
      let rShot = false;
      for (let i = 0; i < 2000 && !w.outcome; i++) {
        step(w);
        for (const m of w.missiles) {
          if (m.shooterId === "B1") bShot = true;
          if (m.shooterId === "R1") rShot = true;
        }
        if (bShot && rShot) break;
      }
      expect(bShot && rShot).toBe(true);
    }
  }, 30_000);

  it("reports structured NPC behaviour state and action detail for watch-mode UI", () => {
    const w = scenarioById("duel").build(P(), 25000, 1, { redSkill: "hard", blueAi: "hard" });
    const bot = npcOf(w, "B1");
    expect(bot.status()).toMatchObject({ skill: "Hard", state: "commit" });
    step(w);
    expect(bot.status().detail).toMatch(/Closing to posture-shot range/);

    // Advance until B1 fires its posture shot and enters cranking support.
    for (let i = 0; i < 2000 && bot.state === "commit"; i++) step(w);
    expect(bot.state).toBe("support");
    const sup = bot.status();
    expect(sup.state).toBe("support");
    expect(sup.detail).toMatch(/Cranking 55° [LR]/);
  });
});

describe("game: 6v6 infinite demo mode", () => {
  it("spawns 6v6 in 3x2 formation at 120 nm with all NPCs and disables outcome/recording", () => {
    const p = P();
    const session = new GameSession("infinite", 25000, p, DEFAULT_AUTOPAUSE, 7, DEFAULT_OPTIONS);
    expect(session.watch).toBe(true);
    expect(session.recorder).toBeNull();

    const w = session.world;
    expect(w.infinite).toBe(true);
    expect(w.jets).toHaveLength(12);
    for (const j of w.jets) expect(npcOf(w, j.id)).toBeInstanceOf(DoctrineBot);

    const blue = w.jets
      .filter((j) => j.side === "blue")
      .map((j) => [Math.round(j.pos.x / NM), Math.round(j.pos.y / NM), Math.round((j.hdg * 180) / Math.PI)]);
    const red = w.jets
      .filter((j) => j.side === "red")
      .map((j) => [Math.round(j.pos.x / NM), Math.round(j.pos.y / NM), Math.round((j.hdg * 180) / Math.PI)]);
    expect(blue).toEqual([
      [-5, 0, 0],
      [0, 0, 0],
      [5, 0, 0],
      [-5, -20, 0],
      [0, -20, 0],
      [5, -20, 0],
    ]);
    expect(red).toEqual([
      [-5, 120, 180],
      [0, 120, 180],
      [5, 120, 180],
      [-5, 140, 180],
      [0, 140, 180],
      [5, 140, 180],
    ]);

    w.t = w.timeLimitS + 60;
    step(w);
    expect(w.outcome).toBeNull();
    expect(waitingOnMissiles(w)).toBe(false);
    expect(awaitingCall(w)).toBe(false);
  });

  it("respawns destroyed jets at their initial slot and prunes dead jets and ended missiles", () => {
    const p = P();
    const w = scenarioById("infinite").build(p, 25000, 3, { redSkill: "normal", blueAi: "hard" });
    const r5 = must(jetById(w, "R5")); // Red back center: x = 0, y = 140 nm, hdg = 180°
    const startX = r5.pos.x;
    const startY = r5.pos.y;
    const startHdg = r5.hdg;

    // Move R5 away and mark it destroyed, along with an ended missile to verify pruning.
    r5.pos.x = 18 * NM;
    r5.pos.y = 60 * NM;
    r5.alive = false;
    step(w);

    expect(jetById(w, "R5")).toBeUndefined();
    expect(w.controllers.has("R5")).toBe(false);
    expect(w.jets).toHaveLength(12);
    const reds = w.jets.filter((j) => j.side === "red");
    expect(reds).toHaveLength(6);

    const replacement = must(reds.find((j) => j.id === "R7"));
    expect(replacement.alive).toBe(true);
    expect(replacement.pos.x).toBeCloseTo(startX, 3);
    expect(replacement.pos.y).toBeCloseTo(startY, 3);
    expect(replacement.hdg).toBeCloseTo(startHdg, 5);
    expect(replacement.missiles).toBe(p.aircraft.missiles);
    expect(npcOf(w, "R7")).toBeInstanceOf(DoctrineBot);

    // If the newly spawned R7 also gets shot down, its replacement also uses the original slot.
    replacement.pos.x = -12 * NM;
    replacement.pos.y = 55 * NM;
    replacement.alive = false;
    step(w);
    const replacement2 = must(jetById(w, "R8"));
    expect(replacement2.pos.x).toBeCloseTo(startX, 3);
    expect(replacement2.pos.y).toBeCloseTo(startY, 3);
    expect(replacement2.hdg).toBeCloseTo(startHdg, 5);
    expect(w.jets).toHaveLength(12);

    // Departing 500 nm from startPos also counts as a loss and respawns at the original slot.
    replacement2.pos.y = replacement2.startPos.y - 500 * NM;
    step(w);
    expect(jetById(w, "R8")).toBeUndefined();
    const replacement3 = must(jetById(w, "R9"));
    expect(replacement3.pos.x).toBeCloseTo(startX, 3);
    expect(replacement3.pos.y).toBeCloseTo(startY, 3);
    expect(replacement3.hdg).toBeCloseTo(startHdg, 5);
  });

  it("retires and replaces winchester egressing jets after staying >=50 nm clear for over 10 seconds", () => {
    const p = P();
    const w = scenarioById("infinite").build(p, 25000, 5, { redSkill: "normal", blueAi: "normal" });
    w.controllers.clear(); // hold positions stationary to test timing precisely
    const b1 = must(jetById(w, "B1"));
    const startX = b1.pos.x;
    const startY = b1.pos.y;
    const startHdg = b1.hdg;

    // Winchester B1 inside 50 nm (< 50 nm from Red): must stay alive past 10 s.
    b1.missiles = 0;
    b1.pos = { x: 0, y: 75 * NM, z: b1.pos.z }; // 45 nm south of Red front at y = 120 nm
    for (let i = 0; i < 600; i++) step(w); // 12 s
    expect(jetById(w, "B1")?.alive).toBe(true);

    // Move B1 to >= 50 nm clear from nearest Red (60 nm south so closing Red stays > 50 nm over 10 s).
    b1.pos = { x: 0, y: 60 * NM, z: b1.pos.z };
    // Step 5 s (250 steps): still flying, timer resets if closer than 50 nm.
    for (let i = 0; i < 250; i++) {
      b1.pos.y = 60 * NM;
      step(w);
    }
    expect(jetById(w, "B1")?.alive).toBe(true);

    // Bring nearest enemy briefly inside 50 nm to reset the safe-egress timer.
    b1.pos.y = 75 * NM;
    step(w);
    b1.pos.y = 60 * NM;

    // For full 10.0 s (500 steps at 0.02s), timer has not exceeded 10 s yet; once > 10 s elapses, B1 retires.
    for (let i = 0; i < 499; i++) {
      b1.pos.y = 60 * NM;
      step(w);
    }
    expect(jetById(w, "B1")?.alive).toBe(true);

    for (let i = 0; i < 3; i++) {
      b1.pos.y = 60 * NM;
      step(w);
    }
    expect(jetById(w, "B1")).toBeUndefined();
    expect(w.jets).toHaveLength(12);
    const replacement = must(jetById(w, "B7"));
    expect(replacement.missiles).toBe(p.aircraft.missiles);
    expect(replacement.pos.x).toBeCloseTo(startX, 3);
    expect(replacement.pos.y).toBeCloseTo(startY, 3);
    expect(replacement.hdg).toBeCloseTo(startHdg, 5);
    expect(w.events.some((e) => e.type === "rtb" && e.jetId === "B1")).toBe(true);
  });

  it("assigns mixed NPC difficulties per spawn and re-rolls on respawn when random is chosen", () => {
    const p = P();
    const w = scenarioById("infinite").build(p, 25000, 11, { redSkill: "random", blueAi: "random" });
    const initialLabels = w.jets.map((j) => npcOf(w, j.id).skill.label);
    expect(initialLabels.every((l) => l === "Easy" || l === "Normal" || l === "Hard")).toBe(true);
    expect(new Set(initialLabels).size).toBeGreaterThan(1);

    // Repeatedly kill R1's slot replacement and confirm newly spawned NPCs can differ from their predecessor.
    const respawnLabels = new Set<string>();
    let currentId = "R1";
    for (let i = 0; i < 10; i++) {
      must(jetById(w, currentId)).alive = false;
      step(w);
      const next = must(w.jets.find((j) => j.side === "red" && j.id === `R${7 + i}`));
      respawnLabels.add(npcOf(w, next.id).skill.label);
      currentId = next.id;
    }
    expect(respawnLabels.size).toBeGreaterThan(1);

    // Also works in standard NPC scenarios (e.g., 2v2 across both sides).
    const w2 = scenarioById("2v2").build(p, 25000, 7, { redSkill: "random", blueAi: "random" });
    const labels2 = w2.jets.map((j) => npcOf(w2, j.id).skill.label);
    expect(labels2.every((l) => l === "Easy" || l === "Normal" || l === "Hard")).toBe(true);
    expect(new Set(labels2).size).toBeGreaterThan(1);
  });
});

describe("game: target sorting and opportunity shots in line-abreast & trailing formations", () => {
  it("keeps lane sorting in line-abreast and prevents rear/trailing jets from pushing frontline jets to distant targets", () => {
    const p = P();
    const w = scenarioById("infinite").build(p, 25000, 1, { redSkill: "normal", blueAi: "normal" });
    // Stage 3v3 line-abreast front (68 nm: inside 80 nm detection, outside Rmax) + trailing friendly row + far bandits.
    // Even if trailing friendlies claim front bandits, frontline B1..B3 must stay on their own lanes R1..R3.
    const r1 = must(jetById(w, "R1"));
    const r2 = must(jetById(w, "R2"));
    const r3 = must(jetById(w, "R3"));
    r1.pos.y = 68 * NM;
    r2.pos.y = 68 * NM;
    r3.pos.y = 68 * NM;
    must(jetById(w, "R4")).pos = { x: -30 * NM, y: 110 * NM, z: r1.pos.z };
    must(jetById(w, "R5")).pos = { x: 0, y: 110 * NM, z: r1.pos.z };
    must(jetById(w, "R6")).pos = { x: 30 * NM, y: 110 * NM, z: r1.pos.z };

    for (let i = 0; i < 10; i++) step(w);
    expect(w.missiles).toHaveLength(0);

    expect(must(jetById(w, "B1")).targetId).toBe("R1");
    expect(must(jetById(w, "B2")).targetId).toBe("R2");
    expect(must(jetById(w, "B3")).targetId).toBe("R3");

    // Trailing Blue jets B4..B6 at y = -20 nm see frontline R1..R3 (~88 nm) vs distant R4..R6 (~130 nm):
    // even with frontline claimed (+18 nm), none of B4..B6 should pick a distant 130 nm flanking target.
    for (const bid of ["B4", "B5", "B6"]) {
      const tgt = must(jetById(w, bid)).targetId;
      expect(["R1", "R2", "R3"]).toContain(tgt);
    }
  });

  it("takes an opportunity shot on a second line-abreast bandit inside lethal range while supporting primary", () => {
    const p = P();
    const w = scenarioById("2v2").build(p, 25000, 1, { redSkill: "normal", blueAi: "normal" });
    w.controllers.delete("B2");
    must(jetById(w, "B2")).alive = false;
    w.controllers.delete("R1");
    w.controllers.delete("R2");

    const b1 = must(jetById(w, "B1"));
    const r1 = must(jetById(w, "R1"));
    const r2 = must(jetById(w, "R2"));
    // Place R1 on B1's lane just inside shot range so B1 fires M1 and enters cranking support.
    b1.pos.x = 0;
    b1.pos.y = 0;
    r1.pos = { x: 0, y: 32 * NM, z: b1.pos.z };
    r2.pos = { x: 5 * NM, y: 65 * NM, z: b1.pos.z };

    for (let i = 0; i < 30 && w.missiles.length === 0; i++) step(w);
    step(w); // transition to support on next bot tick
    expect(w.missiles).toHaveLength(1);
    expect(w.missiles[0]?.targetId).toBe("R1");
    expect(npcOf(w, "B1").state).toBe("support");

    // Let B1 establish its crank (~3 s), then bring line-abreast R2 into lethal range inside the cranked gimbal.
    for (let i = 0; i < 150; i++) step(w);
    const crankSide = b1.hdg < Math.PI ? 1 : -1;
    r2.pos = { x: b1.pos.x + crankSide * 5 * NM, y: b1.pos.y + 18 * NM, z: b1.pos.z };
    for (let i = 0; i < 120 && w.missiles.length < 2; i++) step(w);

    expect(w.missiles).toHaveLength(2);
    expect(w.missiles[1]?.shooterId).toBe("B1");
    expect(w.missiles[1]?.targetId).toBe("R2");
    expect(b1.targetId).toBe("R1"); // keeps supporting original target
    expect(npcOf(w, "B1").state).toBe("support");
  });

  it("takes an opportunity shot on a trailing bandit closing into lethal range while supporting lead missile", () => {
    const p = P();
    const w = scenarioById("duel").build(p, 25000, 2, { redSkill: "hard", blueAi: "hard" });
    w.controllers.delete("R1");
    const b1 = must(jetById(w, "B1"));
    const r1 = must(jetById(w, "R1"));
    r1.pos = { x: 0, y: 36 * NM, z: b1.pos.z };

    // Add a trailing bandit R2 in the same lane behind R1, initially farther back.
    const r2 = makeJet(p.aircraft, {
      id: "R2",
      side: "red",
      callsign: "Bandit 2",
      x: 1 * NM,
      y: 62 * NM,
      altM: b1.pos.z,
      hdgDeg: 180,
      mach: 0.9,
    });
    w.jets.push(r2);

    // B1 shoots R1 and enters cranking support.
    for (let i = 0; i < 30 && w.missiles.length === 0; i++) step(w);
    step(w); // transition to support on next bot tick
    expect(w.missiles).toHaveLength(1);
    expect(w.missiles[0]?.targetId).toBe("R1");
    expect(npcOf(w, "B1").state).toBe("support");

    // Let B1 crank briefly, then advance trailing R2 into lethal range along the lane (inside cranked gimbal).
    for (let i = 0; i < 150; i++) step(w);
    r2.pos = { x: b1.pos.x + (b1.hdg < Math.PI ? 1 : -1) * 4 * NM, y: b1.pos.y + 18 * NM, z: b1.pos.z };
    for (let i = 0; i < 120 && w.missiles.length < 2; i++) step(w);

    expect(w.missiles).toHaveLength(2);
    expect(w.missiles[1]?.shooterId).toBe("B1");
    expect(w.missiles[1]?.targetId).toBe("R2");
    expect(b1.targetId).toBe("R1");
    expect(npcOf(w, "B1").state).toBe("support");
    expect(AI_SKILLS.hard.opportunityShot).toBe(true);
  });
});
