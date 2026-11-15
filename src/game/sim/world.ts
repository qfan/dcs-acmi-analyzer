/**
 * The game world: a deterministic fixed-step simulation. Everything that changes the world goes
 * through `command()` or `step()`, so the same seed, commands and step count always give the same
 * fight. Time control (real time, pause, auto-pause on events, turns) lives outside, in the UI.
 */
import { desiredHeading, type Jet, type Side, stepJet, velocity } from "./aircraft.ts";
import { DEG, NM } from "./atmosphere.ts";
import { launchMissile, type Missile, type MissileEvent, stepMissile, type TargetTruth } from "./missile.ts";
import type { GameParams } from "./params.ts";
import { makeRng, type Rng } from "./rng.ts";
import { angleBetween, headingVec, len, sub } from "./vec.ts";

export const SIM_DT = 0.02;

export type GameEventType =
  | "launch"
  | "pitbull"
  | "acquired"
  | "datalink-lost"
  | "datalink-regained"
  | "seeker-lost"
  | "kill"
  | "survived-hit"
  | "miss"
  | "spent"
  | "radar-lost"
  | "radar-gained"
  | "end";

export interface GameEvent {
  t: number;
  type: GameEventType;
  /** Side the event belongs to (the shooter's side for missile events). */
  side: Side;
  jetId?: string;
  missileId?: string;
  /** Who is threatened by it (the target of a missile event). */
  targetId?: string;
  text: string;
}

export type Command =
  | { type: "steer"; jetId: string; steer: Jet["steer"] }
  | { type: "throttle"; jetId: string; throttle: Jet["throttle"] }
  | { type: "effort"; jetId: string; effort: Jet["effort"] }
  | { type: "target"; jetId: string; targetId: string | null }
  | { type: "fire"; jetId: string; targetId?: string };

/** Something that flies a jet: the scripted bot now, the NPC AI later. */
export interface Controller {
  update(world: World, jet: Jet): Command[];
}

export type Outcome = { winner: Side | null; reason: string };

export interface World {
  t: number;
  params: GameParams;
  jets: Jet[];
  missiles: Missile[];
  events: GameEvent[];
  controllers: Map<string, Controller>;
  rng: Rng;
  nextId: number;
  /** Whether each jet's radar tracks its target, last step. */
  radarTrack: Map<string, boolean>;
  outcome: Outcome | null;
  /** The fight ends as a draw after this long (s). */
  timeLimitS: number;
  /** "survive": the blue side wins by outliving every red missile. */
  objective: "kill" | "survive";
}

export function makeWorld(params: GameParams, seed = 1): World {
  return {
    t: 0,
    params,
    jets: [],
    missiles: [],
    events: [],
    controllers: new Map(),
    rng: makeRng(seed),
    nextId: 1,
    radarTrack: new Map(),
    outcome: null,
    timeLimitS: 900,
    objective: "kill",
  };
}

export const jetById = (w: World | null | undefined, id: string | null | undefined): Jet | undefined =>
  w && id ? w.jets.find((j) => j.id === id) : undefined;

/** True when `shooter`'s radar can track `target`: alive, in range and inside the gimbal limits. */
export function radarCanTrack(w: World, shooter: Jet, target: Jet): boolean {
  if (!shooter.alive || !target.alive) return false;
  const los = sub(target.pos, shooter.pos);
  if (len(los) > w.params.radar.rangeNm * NM) return false;
  return angleBetween(los, headingVec(shooter.hdg, shooter.gamma)) <= w.params.radar.gimbalDeg * DEG;
}

export const truthOf = (j: Jet): TargetTruth => ({ pos: { ...j.pos }, vel: velocity(j), alive: j.alive });

function emit(w: World, e: Omit<GameEvent, "t">): void {
  w.events.push({ t: Math.round(w.t * 100) / 100, ...e });
}

/** Applies a command. Returns an error message when it cannot be done (e.g. no radar track). */
export function command(w: World, c: Command): string | null {
  const j = jetById(w, c.jetId);
  if (!j?.alive) return "That jet is not flying.";
  switch (c.type) {
    case "steer":
      j.steer = c.steer;
      return null;
    case "throttle":
      j.throttle = c.throttle;
      return null;
    case "effort":
      j.effort = c.effort;
      return null;
    case "target":
      j.targetId = c.targetId;
      return null;
    case "fire": {
      const tgt = jetById(w, c.targetId ?? j.targetId);
      if (!tgt?.alive || tgt.side === j.side) return "No hostile target selected.";
      if (j.missiles <= 0) return "Winchester: no missiles left.";
      if (!radarCanTrack(w, j, tgt)) return "Target is outside radar coverage (range or gimbal).";
      j.targetId = tgt.id;
      j.missiles--;
      const m = launchMissile(w.params.missile, {
        id: `M${w.nextId++}`,
        side: j.side,
        shooterId: j.id,
        targetId: tgt.id,
        pos: { ...j.pos, z: j.pos.z - 2 },
        vel: velocity(j),
        target: truthOf(tgt),
      });
      w.missiles.push(m);
      const rangeNm = len(sub(tgt.pos, j.pos)) / NM;
      emit(w, {
        type: "launch",
        side: j.side,
        jetId: j.id,
        missileId: m.id,
        targetId: tgt.id,
        text: `${j.callsign} Fox 3 on ${tgt.callsign} at ${rangeNm.toFixed(1)} nm`,
      });
      return null;
    }
  }
}

const MISSILE_TEXT: Partial<Record<MissileEvent, [GameEventType, string]>> = {
  pitbull: ["pitbull", "pitbull (seeker active)"],
  acquired: ["acquired", "seeker has the target"],
  "datalink-lost": ["datalink-lost", "datalink lost: flying to last known position"],
  "datalink-regained": ["datalink-regained", "datalink regained"],
  "seeker-lost": ["seeker-lost", "seeker lost the target"],
  miss: ["miss", "missed"],
  spent: ["spent", "out of energy"],
  ground: ["spent", "hit the ground"],
};

export function step(w: World, dt = SIM_DT): void {
  if (w.outcome) return;
  for (const j of w.jets) {
    if (!j.alive) continue;
    const ctl = w.controllers.get(j.id);
    if (ctl) for (const c of ctl.update(w, j)) command(w, c);
  }
  for (const j of w.jets) {
    if (!j.alive) continue;
    const threat = j.steer.mode === "relative" ? jetById(w, j.steer.threatId) : undefined;
    stepJet(w.params.aircraft, j, desiredHeading(j, threat?.alive ? threat.pos : null), dt);
  }
  w.t += dt;

  for (const j of w.jets) {
    const tgt = jetById(w, j.targetId);
    const now = !!tgt && radarCanTrack(w, j, tgt);
    const before = w.radarTrack.get(j.id) ?? false;
    if (tgt && j.alive && tgt.alive && now !== before)
      emit(w, {
        type: now ? "radar-gained" : "radar-lost",
        side: j.side,
        jetId: j.id,
        targetId: tgt.id,
        text: `${j.callsign} radar ${now ? "tracking" : "lost track of"} ${tgt.callsign}`,
      });
    w.radarTrack.set(j.id, now);
  }

  for (const m of w.missiles) {
    if (m.end) continue;
    const tgt = jetById(w, m.targetId);
    const shooter = jetById(w, m.shooterId);
    if (!tgt) {
      m.end = "spent";
      continue;
    }
    const datalink = !!shooter && radarCanTrack(w, shooter, tgt);
    const evs = stepMissile(w.params.missile, m, truthOf(tgt), datalink, dt);
    const who = `${shooter?.callsign ?? "?"} ${m.id}`;
    for (const e of evs) {
      if (e === "fuzed") {
        if (w.rng() < w.params.missile.pk) {
          tgt.alive = false;
          tgt.g = 1;
          emit(w, {
            type: "kill",
            side: m.side,
            jetId: m.shooterId,
            missileId: m.id,
            targetId: tgt.id,
            text: `${who} killed ${tgt.callsign}`,
          });
        } else
          emit(w, {
            type: "survived-hit",
            side: m.side,
            missileId: m.id,
            targetId: tgt.id,
            text: `${who} fuzed but ${tgt.callsign} survived`,
          });
        continue;
      }
      const map = MISSILE_TEXT[e];
      if (map)
        emit(w, {
          type: map[0],
          side: m.side,
          jetId: m.shooterId,
          missileId: m.id,
          targetId: m.targetId,
          text: `${who} ${map[1]}`,
        });
    }
  }
  checkOutcome(w);
}

function checkOutcome(w: World): void {
  const alive = (s: Side) => w.jets.some((j) => j.side === s && j.alive);
  const armed = (s: Side) =>
    w.jets.some((j) => j.side === s && j.alive && j.missiles > 0) ||
    w.missiles.some((m) => m.side === s && !m.end);
  let o: Outcome | null = null;
  if (!alive("blue") && !alive("red")) o = { winner: null, reason: "Both sides destroyed." };
  else if (!alive("red")) o = { winner: "blue", reason: "All hostiles destroyed." };
  else if (!alive("blue")) o = { winner: "red", reason: "You were shot down." };
  else if (w.objective === "survive" && !armed("red"))
    o = { winner: "blue", reason: "You defeated every missile fired at you." };
  else if (!armed("blue") && !armed("red")) o = { winner: null, reason: "Both sides are out of missiles." };
  else if (w.t >= w.timeLimitS) o = { winner: null, reason: "Time limit reached." };
  if (o) {
    w.outcome = o;
    emit(w, { type: "end", side: o.winner ?? "blue", text: o.reason });
  }
}

/** Runs the world headless until it ends or `maxS` seconds pass. */
export function runFor(w: World, maxS: number, dt = SIM_DT): void {
  const end = w.t + maxS;
  while (!w.outcome && w.t < end - 1e-9) step(w, dt);
}
