import { describe, expect, it } from "vitest";
import { mach, makeJet, stepJet } from "../src/game/sim/aircraft.ts";
import { DEG, FT, NM } from "../src/game/sim/atmosphere.ts";
import { cloneParams, DEFAULT_PARAMS, type GameParams, mergeParams } from "../src/game/sim/params.ts";
import { scenarioById } from "../src/game/sim/scenarios.ts";
import { launchZone } from "../src/game/sim/wez.ts";
import { command, jetById, step, type World } from "../src/game/sim/world.ts";

const P = () => cloneParams(DEFAULT_PARAMS);

function jetAt(p: GameParams, altFt: number, m: number, side: "blue" | "red" = "blue", y = 0, hdgDeg = 0) {
  return makeJet(p.aircraft, { id: side, side, callsign: side, x: 0, y, altM: altFt * FT, hdgDeg, mach: m });
}

/** Turn rate (deg/s) after `seconds` of a max-performance afterburner turn. */
function turnRate(p: GameParams, altFt: number, m: number, seconds: number) {
  const j = jetAt(p, altFt, m);
  j.effort = "max";
  j.throttle = "ab";
  const n = Math.round(seconds / 0.02);
  for (let i = 0; i < n; i++) stepJet(p.aircraft, j, j.hdg + 1, 0.02);
  const h0 = j.hdg;
  stepJet(p.aircraft, j, j.hdg + 1, 0.02);
  return { rate: ((j.hdg - h0) / 0.02) * (180 / Math.PI), mach: mach(j) };
}

const cold = { mode: "relative", threatId: "R1", offsetDeg: 180, dir: 1, label: "cold" } as const;
const crank = { mode: "relative", threatId: "R1", offsetDeg: 40, dir: 1, label: "crank" } as const;

/** Plays a scenario; blue fires at `fireNm` (if given) and switches to `after` steering. */
function play(
  id: string,
  altFt: number,
  opts: { fireNm?: number; after?: typeof cold | typeof crank; at0?: typeof cold },
) {
  const w: World = scenarioById(id).build(P(), altFt, 7);
  if (opts.at0) command(w, { type: "steer", jetId: "B1", steer: opts.at0 });
  let fired = false;
  while (!w.outcome && w.t < 400) {
    const b = jetById(w, "B1");
    const r = jetById(w, "R1");
    if (
      b &&
      r &&
      opts.fireNm !== undefined &&
      !fired &&
      Math.hypot(b.pos.x - r.pos.x, b.pos.y - r.pos.y) <= opts.fireNm * NM
    ) {
      fired = command(w, { type: "fire", jetId: "B1", targetId: "R1" }) === null;
      if (fired && opts.after) command(w, { type: "steer", jetId: "B1", steer: opts.after });
    }
    if (id === "support" && w.missiles[0]?.end) break;
    step(w);
  }
  return w;
}

describe("game: jet energy model", () => {
  it("turns hardest near corner speed down low and bleeds speed doing it", () => {
    const p = P();
    const low = turnRate(p, 5000, 0.5, 1);
    expect(low.rate).toBeGreaterThan(18);
    expect(low.rate).toBeLessThan(32);
    expect(turnRate(p, 5000, 0.6, 20).mach).toBeLessThan(0.5);
  });

  it("turns less in thin air", () => {
    const p = P();
    expect(turnRate(p, 35000, 0.9, 1).rate).toBeLessThan(turnRate(p, 15000, 0.9, 1).rate * 0.75);
  });
});

describe("game: missile and launch zone", () => {
  it("reaches much further high than low, and much less against a fleeing target", () => {
    const p = P();
    const zone = (altFt: number) =>
      launchZone(p.missile, jetAt(p, altFt, 0.9), jetAt(p, altFt, 0.9, "red", 30 * NM, 180));
    const lo = zone(5000);
    const hi = zone(35000);
    expect(lo.rmaxNm).toBeGreaterThan(12);
    expect(hi.rmaxNm).toBeGreaterThan(lo.rmaxNm * 1.8);
    expect(hi.rneNm).toBeLessThan(hi.rmaxNm * 0.5);
  });

  it("still finds the zone while cranking (short shots off-boresight miss)", () => {
    const p = P();
    const z = launchZone(
      p.missile,
      jetAt(p, 25000, 0.9, "blue", 0, 50),
      jetAt(p, 25000, 0.9, "red", 30 * NM, 180),
    );
    expect(z.rmaxNm).toBeGreaterThan(20);
    expect(z.rneNm).toBeGreaterThan(5);
  });

  it("follows the editable parameters", () => {
    const p = P();
    const shooter = jetAt(p, 25000, 0.9);
    const target = jetAt(p, 25000, 0.9, "red", 30 * NM, 180);
    const base = launchZone(p.missile, shooter, target).rmaxNm;
    p.missile.dragScale = 1.5;
    expect(launchZone(p.missile, shooter, target).rmaxNm).toBeLessThan(base * 0.9);
  });
});

describe("game: Phase 1 drills", () => {
  it("defend: staying hot gets you killed, turning cold early defeats the long shot", () => {
    expect(play("defend", 25000, {}).outcome?.winner).toBe("red");
    expect(play("defend", 25000, { at0: cold }).outcome?.winner).toBe("blue");
  });

  it("support: a supported 30 nm shot kills; turning cold right after the shot loses the target", () => {
    const supported = play("support", 35000, { fireNm: 30, after: crank });
    expect(supported.events.some((e) => e.type === "kill")).toBe(true);
    const dropped = play("support", 35000, { fireNm: 30, after: cold });
    expect(dropped.events.some((e) => e.type === "datalink-lost")).toBe(true);
    expect(dropped.events.some((e) => e.type === "acquired")).toBe(false);
    expect(dropped.events.some((e) => e.type === "kill")).toBe(false);
  });

  it("duel: a passive player is shot by the bandit", () => {
    expect(play("duel", 25000, {}).outcome?.winner).toBe("red");
  });

  it("is deterministic", () => {
    const a = play("duel", 15000, { fireNm: 25, after: crank });
    const b = play("duel", 15000, { fireNm: 25, after: crank });
    expect(a.events).toEqual(b.events);
  });
});

describe("game: rules", () => {
  it("cannot fire at a target outside the radar gimbal", () => {
    const w = scenarioById("duel").build(P(), 25000, 1);
    const b = jetById(w, "B1");
    if (!b) throw new Error("no blue jet");
    b.hdg = 120 * DEG;
    expect(command(w, { type: "fire", jetId: "B1", targetId: "R1" })).toMatch(/radar/);
  });

  it("merges saved parameters defensively", () => {
    const m = mergeParams({ missile: { boostTimeS: 9, dragCd: [1, 2], bogus: 3, pk: "x" }, radar: null });
    expect(m.missile.boostTimeS).toBe(9);
    expect(m.missile.dragCd).toEqual(DEFAULT_PARAMS.missile.dragCd);
    expect(m.missile.pk).toBe(DEFAULT_PARAMS.missile.pk);
    expect(m.radar).toEqual(DEFAULT_PARAMS.radar);
  });
});
