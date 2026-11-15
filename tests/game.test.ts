import { describe, expect, it } from "vitest";
import { mach, makeJet, stepJet } from "../src/game/sim/aircraft.ts";
import { DEG, FT, NM } from "../src/game/sim/atmosphere.ts";
import { launchMissile, stepMissile } from "../src/game/sim/missile.ts";
import { cloneParams, DEFAULT_PARAMS, type GameParams, mergeParams } from "../src/game/sim/params.ts";
import { scenarioById } from "../src/game/sim/scenarios.ts";
import { launchZone } from "../src/game/sim/wez.ts";
import { command, jetById, rwrContacts, step, type World, waitingOnMissiles } from "../src/game/sim/world.ts";
import { DEFAULT_AUTOPAUSE, GameSession } from "../src/game/ui/session.ts";

const P = () => cloneParams(DEFAULT_PARAMS);

function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("missing");
  return x;
}

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

  it("shrinks Rmax as the target turns off a hot aspect, while Rne ignores its heading", () => {
    const p = P();
    const shooter = jetAt(p, 25000, 0.9);
    // Target 37 nm north; 180° = flying straight at the shooter, then cranking further away.
    const zoneAt = (hdgDeg: number) =>
      launchZone(p.missile, shooter, jetAt(p, 25000, 0.9, "red", 37 * NM, hdgDeg));
    const hot = zoneAt(180);
    const crank = zoneAt(230);
    const beam = zoneAt(270);
    expect(hot.rmaxNm).toBeGreaterThan(crank.rmaxNm);
    expect(crank.rmaxNm).toBeGreaterThan(beam.rmaxNm);
    // Rne already assumes the target turns straight away, so where it points now does not matter.
    expect(crank.rneNm).toBeCloseTo(hot.rneNm, 0);
    expect(beam.rneNm).toBeCloseTo(hot.rneNm, 0);
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

describe("game: missile end and lethal range", () => {
  it("keeps flying below the lethal speed until the true-airspeed or time limit", () => {
    const p = P();
    const m = launchMissile(p.missile, {
      id: "m",
      side: "blue",
      shooterId: "s",
      targetId: "t",
      pos: { x: 0, y: 0, z: 40000 * FT },
      vel: { x: 0, y: 130, z: 0 },
      target: { pos: { x: 0, y: 90 * NM, z: 40000 * FT }, vel: { x: 0, y: 0, z: 0 }, alive: true },
    });
    p.missile.boostTimeS = 0;
    // 130 m/s true (≈253 kt) at 40,000 ft is only ≈ 140 kt indicated: it must still be flying.
    stepMissile(
      p.missile,
      m,
      { pos: { x: 0, y: 90 * NM, z: 40000 * FT }, vel: { x: 0, y: 0, z: 0 }, alive: true },
      true,
      0.02,
    );
    expect(m.end).toBeNull();
    m.vel = { x: 0, y: 95, z: 0 };
    stepMissile(
      p.missile,
      m,
      { pos: { x: 0, y: 90 * NM, z: 40000 * FT }, vel: { x: 0, y: 0, z: 0 }, alive: true },
      true,
      0.02,
    );
    expect(m.end).toBe("spent");
  });

  it("shows a shorter Rmax when the lethal speed is raised", () => {
    const p = P();
    const s = jetAt(p, 25000, 0.9);
    const t = jetAt(p, 25000, 0.9, "red", 30 * NM, 180);
    const base = launchZone(p.missile, s, t).rmaxNm;
    p.missile.lethalMach = 1.3;
    expect(launchZone(p.missile, s, t).rmaxNm).toBeLessThan(base);
  });
});

describe("game: RWR, decoys and fog of war", () => {
  it("shows the enemy radar scan but no launch warning while the missile is on datalink", () => {
    const w = scenarioById("duel").build(P(), 25000, 3);
    w.controllers.clear();
    const blue = jetById(w, "B1");
    if (!blue) throw new Error("no blue jet");
    must(jetById(w, "R1")).pos.y = 30 * NM;
    expect(rwrContacts(w, blue).map((c) => c.kind)).toEqual(["radar"]);
    command(w, { type: "fire", jetId: "R1", targetId: "B1" });
    for (let i = 0; i < 100; i++) step(w);
    expect(rwrContacts(w, blue).some((c) => c.kind === "missile")).toBe(false);
    expect(w.events.some((e) => e.type === "rwr-missile")).toBe(false);
  });

  it("warns once the missile goes active and its seeker sees you", () => {
    const w = play("defend", 25000, {});
    const rwr = w.events.find((e) => e.type === "rwr-missile" && e.targetId === "B1");
    const pit = w.events.find((e) => e.type === "pitbull");
    expect(rwr).toBeDefined();
    expect(pit).toBeDefined();
    expect(must(rwr).t).toBeGreaterThanOrEqual(must(pit).t);
  });

  it("releases chaff and flares from the jet's load", () => {
    const w = scenarioById("duel").build(P(), 25000, 1);
    const b = must(jetById(w, "B1"));
    const c0 = b.chaff;
    const f0 = b.flares;
    expect(command(w, { type: "chaff", jetId: "B1" })).toBeNull();
    expect(command(w, { type: "flare", jetId: "B1" })).toBeNull();
    expect([b.chaff, b.flares]).toEqual([c0 - 1, f0 - 1]);
    expect(w.decoys).toHaveLength(2);
    b.chaff = 0;
    expect(command(w, { type: "chaff", jetId: "B1" })).toMatch(/chaff/);
  });

  it("fog of war: detect at 80 nm, TWS lock at 70 nm, last-seen position when lost", () => {
    const s = new GameSession("duel", 25000, P(), DEFAULT_AUTOPAUSE, 1);
    s.world.controllers.clear();
    s.fog = true;
    const b = must(jetById(s.world, "B1"));
    const r = must(jetById(s.world, "R1"));
    const placeRed = (nm: number) => {
      r.pos.y = b.pos.y + nm * NM;
      r.pos.x = b.pos.x;
      s.advance(0.02);
    };
    placeRed(85);
    expect(s.sees("R1")).toBe(false);
    placeRed(75);
    expect(s.sees("R1")).toBe(true);
    expect(command(s.world, { type: "fire", jetId: "B1", targetId: "R1" })).toMatch(/TWS/);
    placeRed(65);
    expect(command(s.world, { type: "fire", jetId: "B1", targetId: "R1" })).toBeNull();
    b.hdg = Math.PI; // turn the radar away
    s.advance(0.02);
    expect(s.sees("R1")).toBe(false);
    expect(s.lastSeen.has("R1")).toBe(true);
    s.fog = false;
    expect(s.sees("R1")).toBe(true);
  });

  it("fog of war never shows enemy missiles or launches, even inside your radar", () => {
    const s = new GameSession("defend", 25000, P(), DEFAULT_AUTOPAUSE, 1);
    s.fog = true;
    while (s.world.t < 5) s.advance(0.25);
    expect(s.sees("R1")).toBe(true);
    const launch = must(s.world.events.find((e) => e.type === "launch"));
    expect(s.showsEvent(launch)).toBe(false);
    expect(s.world.missiles.some((m) => m.side === "red" && !m.end)).toBe(true);
  });
});

describe("game: onboard missile timers", () => {
  /** Support drill at 35k: fire at 30 nm, then hold `steer` (crank keeps the TWS lock, cold drops it). */
  function supportShot(steer: typeof crank | typeof cold) {
    const s = new GameSession("support", 35000, P(), DEFAULT_AUTOPAUSE, 3);
    let fired = false;
    let predictedPitbull: number | null = null;
    let predictedImpact: number | null = null;
    while (s.world.t < 160 && !s.world.outcome) {
      const b = must(jetById(s.world, "B1"));
      const r = must(jetById(s.world, "R1"));
      if (!fired && Math.hypot(b.pos.x - r.pos.x, b.pos.y - r.pos.y) <= 30 * NM) {
        fired = command(s.world, { type: "fire", jetId: "B1", targetId: "R1" }) === null;
        command(s.world, { type: "steer", jetId: "B1", steer });
      }
      s.advance(0.5);
      const tm = s.timers.get("M1");
      // Remember the estimate made 25 s after launch, once the drone's turn is in your track.
      if (tm && predictedPitbull === null && s.world.t - tm.launchT >= 25) {
        predictedPitbull = tm.pitbullAt;
        predictedImpact = tm.impactAt;
      }
    }
    return { s, predictedPitbull, predictedImpact };
  }

  it("predicts pitbull and impact of a supported shot from the jet's own track", () => {
    const { s, predictedPitbull, predictedImpact } = supportShot(crank);
    const pit = must(s.world.events.find((e) => e.type === "pitbull" && e.missileId === "M1"));
    const kill = must(s.world.events.find((e) => e.type === "kill" && e.missileId === "M1"));
    expect(Math.abs(must(predictedPitbull) - pit.t)).toBeLessThan(3);
    expect(Math.abs(must(predictedImpact) - kill.t)).toBeLessThan(4);
  });

  it("keeps counting on dead reckoning after the lock is dropped, like the cockpit timer", () => {
    const { s, predictedImpact } = supportShot(cold);
    expect(s.world.events.some((e) => e.type === "kill")).toBe(false);
    expect(predictedImpact).not.toBeNull();
  });

  it("with fog of war, hides what the jet cannot know about its own missile", () => {
    const { s } = supportShot(crank);
    s.fog = true;
    const own = (type: string) => must(s.world.events.find((e) => e.type === type && e.side === "blue"));
    expect(s.showsEvent(own("launch"))).toBe(true);
    expect(s.showsEvent(own("acquired"))).toBe(false);
    expect(s.showsEvent(own("pitbull"))).toBe(false);
    expect(s.showsEvent(own("kill"))).toBe(true);
  });
});

describe("game: the fight ends only when no missile can still kill", () => {
  /** Duel at 25k with the bandit `rangeNm` out (30 by default), no scripts; `shooter` fires, then is removed. */
  function lastShot(shooter: "B1" | "R1", rangeNm = 30) {
    const w = scenarioById("duel").build(P(), 25000, 2);
    w.controllers.clear();
    const r = must(jetById(w, "R1"));
    r.pos.y = must(jetById(w, "B1")).pos.y + rangeNm * NM;
    const target = shooter === "B1" ? "R1" : "B1";
    expect(command(w, { type: "fire", jetId: shooter, targetId: target })).toBeNull();
    must(jetById(w, shooter)).alive = false;
    return w;
  }
  const finish = (w: World) => {
    for (let i = 0; i < 20000 && !w.outcome; i++) step(w);
    return must(w.outcome);
  };

  it("keeps running after the last bandit dies while its missile is still in the air", () => {
    const w = lastShot("R1");
    step(w);
    expect(w.outcome).toBeNull();
    expect(waitingOnMissiles(w)).toBe(true);
  });

  it("you can still be killed after every bandit is down: a trade", () => {
    const o = finish(lastShot("R1")); // Viper stays hot
    expect(o.kind).toBe("trade");
  });

  it("defeating the last missile after the bandits are down is the victory", () => {
    const w = lastShot("R1", 45); // long enough to turn cold and outrun it
    command(w, { type: "steer", jetId: "B1", steer: cold });
    const o = finish(w);
    expect(o.kind).toBe("win");
    expect(w.t).toBeGreaterThan(20); // decided when the missile gave up, not when the bandit died
  });

  it("your last missile can still score a trade after you are down", () => {
    expect(finish(lastShot("B1")).kind).toBe("trade");
  });
});

describe("game: the result is called after a random 5–10 s", () => {
  it("waits 5–10 s after the bandit dies with nothing in the air, and the wait varies", () => {
    const delays = [1, 2, 3, 4, 5].map((seed) => {
      const w = scenarioById("duel").build(P(), 25000, seed);
      w.controllers.clear();
      must(jetById(w, "R1")).alive = false;
      const t0 = w.t;
      for (let i = 0; i < 2000 && !w.outcome; i++) step(w);
      expect(must(w.outcome).kind).toBe("win");
      return w.t - t0;
    });
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(5);
      expect(d).toBeLessThanOrEqual(10.05);
    }
    expect(new Set(delays.map((d) => d.toFixed(1))).size).toBeGreaterThan(1);
  });

  it("after the last missile is defeated, still waits 5–10 s before the victory", () => {
    const w = scenarioById("defend").build(P(), 25000, 4);
    command(w, { type: "steer", jetId: "B1", steer: cold });
    for (let i = 0; i < 50000 && !w.outcome; i++) step(w);
    expect(must(w.outcome).kind).toBe("win");
    // The moment the missile stopped being a threat: lost its target, missed, or self-destructed.
    const settled = must(
      w.events.find((e) => e.missileId && ["seeker-lost", "miss", "spent"].includes(e.type)),
    ).t;
    expect(w.t - settled).toBeGreaterThanOrEqual(4.9);
    expect(w.t - settled).toBeLessThanOrEqual(10.1);
  });
});
