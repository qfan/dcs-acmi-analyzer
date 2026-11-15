/**
 * The game world: a deterministic fixed-step simulation. Everything that changes the world goes
 * through `command()` or `step()`, so the same seed, commands and step count always give the same
 * fight. Time control (real time, pause, auto-pause on events, turns) lives outside, in the UI.
 */
import { desiredHeading, type Jet, type Side, stepJet, velocity } from "./aircraft.ts";
import { DEG, NM } from "./atmosphere.ts";
import { chanceInStep, inNotch } from "./countermeasures.ts";
import { launchMissile, type Missile, type MissileEvent, stepMissile, type TargetTruth } from "./missile.ts";
import type { GameParams } from "./params.ts";
import { makeRng, type Rng } from "./rng.ts";
import { add, angleBetween, bearing, headingVec, len, scale, sub, type V3 } from "./vec.ts";

export const SIM_DT = 0.02;
/** How long a released chaff bundle or flare stays on the map (s). */
const DECOY_LIFE_S = 4;

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
  | "seeker-notched"
  | "seeker-chaffed"
  | "rwr-missile"
  | "chaff"
  | "flare"
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
  | { type: "fire"; jetId: string; targetId?: string }
  | { type: "chaff"; jetId: string }
  | { type: "flare"; jetId: string };

/** A released chaff bundle or flare, kept briefly for display (it does not affect missiles yet). */
export interface Decoy {
  kind: "chaff" | "flare";
  jetId: string;
  side: Side;
  t0: number;
  pos: V3;
  vel: V3;
  /** Its chance to pull radars and seekers has been rolled (once per bundle). */
  rolled: boolean;
}

/** Something that flies a jet: the scripted bot now, the NPC AI later. */
export interface Controller {
  update(world: World, jet: Jet): Command[];
}

/** How a fight ended. "trade": both sides destroyed. "draw": nobody destroyed (out of missiles or time). */
export type Outcome = { winner: Side | null; kind: "win" | "loss" | "trade" | "draw"; reason: string };

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
  decoys: Decoy[];
  /** "missileId>jetId" pairs already announced on that jet's RWR. */
  rwrSeen: Set<string>;
  /** "radarJetId>targetJetId" → sim time until which that radar cannot lock the target (notch, chaff). */
  radarBreak: Map<string, number>;
  outcome: Outcome | null;
  /** The fight ends as a draw after this long (s). */
  timeLimitS: number;
  /** "survive": the blue side wins by outliving every red missile. */
  objective: "kill" | "survive";
  /** When a settled result will be called (sim time), or null while the fight is still open. */
  callAt: number | null;
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
    decoys: [],
    rwrSeen: new Set(),
    radarBreak: new Map(),
    outcome: null,
    timeLimitS: 900,
    objective: "kill",
    callAt: null,
  };
}

export const jetById = (w: World | null | undefined, id: string | null | undefined): Jet | undefined =>
  w && id ? w.jets.find((j) => j.id === id) : undefined;

function radarCovers(w: World, shooter: Jet, target: Jet, rangeNm: number): boolean {
  if (!shooter.alive || !target.alive) return false;
  const los = sub(target.pos, shooter.pos);
  if (len(los) > rangeNm * NM) return false;
  return angleBetween(los, headingVec(shooter.hdg, shooter.gamma)) <= w.params.radar.gimbalDeg * DEG;
}

const detectRange = (w: World) => Math.max(w.params.radar.detectRangeNm, w.params.radar.rangeNm);

/** True when `shooter`'s radar scan covers `target` (what the target's RWR sees), notched or not. */
export function radarScans(w: World, shooter: Jet, target: Jet): boolean {
  return radarCovers(w, shooter, target, detectRange(w));
}

/** True while a notch or chaff break keeps `shooter`'s radar off `target`. */
export function radarBroken(w: World, shooter: Jet, target: Jet): boolean {
  return w.t < (w.radarBreak.get(`${shooter.id}>${target.id}`) ?? Number.NEGATIVE_INFINITY);
}

/** True when `shooter`'s radar sees `target` (detection range, gimbal, not broken). Missiles are never seen. */
export function radarCanDetect(w: World, shooter: Jet, target: Jet): boolean {
  return radarScans(w, shooter, target) && !radarBroken(w, shooter, target);
}

/** True when `shooter` can hold a TWS lock on `target`: needed to fire and for datalink support. */
export function radarCanTrack(w: World, shooter: Jet, target: Jet): boolean {
  return radarCovers(w, shooter, target, w.params.radar.rangeNm) && !radarBroken(w, shooter, target);
}

/**
 * Notch and chaff against radars, once per step. A target in a radar's notch has a small chance per
 * second of breaking its lock; while it stays in the notch the radar cannot get it back. A fresh
 * chaff bundle has a small chance to pull each radar scanning the jet off it for a moment.
 */
function updateRadarBreaks(w: World, dt: number, freshChaff: Map<string, Decoy>): void {
  const cm = w.params.countermeasures;
  for (const radar of w.jets) {
    if (!radar.alive) continue;
    for (const tgt of w.jets) {
      if (tgt.side === radar.side || !tgt.alive || !radarScans(w, radar, tgt)) continue;
      const key = `${radar.id}>${tgt.id}`;
      const until = w.radarBreak.get(key) ?? Number.NEGATIVE_INFINITY;
      if (inNotch(radar.pos, truthOf(tgt), cm.notchGateKt)) {
        if (w.t < until) w.radarBreak.set(key, w.t + cm.notchReacquireS);
        else if (w.rng() < chanceInStep(cm.radarNotchPerS, dt))
          w.radarBreak.set(key, w.t + cm.notchReacquireS);
      }
      if (freshChaff.has(tgt.id) && w.rng() < cm.chaffPullChance)
        w.radarBreak.set(key, Math.max(w.radarBreak.get(key) ?? 0, w.t + cm.chaffPullS));
    }
  }
}

/**
 * What a jet's radar warning receiver shows: bearing only, no range.
 *  - "radar": an enemy jet's radar scan covers this jet (detection range and gimbal). A TWS lock
 *    and datalink support of a missile in flight
 *    looks the same as a normal scan, so there is no separate lock or launch warning.
 *  - "missile": an enemy missile's own seeker is active and this jet is inside its field of view.
 *    lock = the seeker is tracking this jet.
 */
export interface RwrContact {
  sourceId: string;
  kind: "radar" | "missile";
  /** Compass bearing from the jet to the emitter (rad). */
  bearing: number;
  lock: boolean;
}

export function rwrContacts(w: World, j: Jet): RwrContact[] {
  if (!j.alive) return [];
  const out: RwrContact[] = [];
  for (const e of w.jets) {
    if (e.side === j.side || !e.alive || !radarScans(w, e, j)) continue;
    out.push({ sourceId: e.id, kind: "radar", bearing: bearing(j.pos, e.pos), lock: false });
  }
  const mp = w.params.missile;
  for (const m of w.missiles) {
    if (m.end || m.side === j.side) continue;
    if (m.phase !== "search" && m.phase !== "tracking") continue;
    const los = sub(j.pos, m.pos);
    if (len(los) > mp.seekerRangeNm * NM || angleBetween(los, m.vel) > mp.seekerGimbalDeg * DEG) continue;
    out.push({
      sourceId: m.id,
      kind: "missile",
      bearing: bearing(j.pos, m.pos),
      lock: m.phase === "tracking" && m.targetId === j.id,
    });
  }
  return out;
}

/**
 * Position of what a "relative" steering order is flown against: a jet, or a missile (defending
 * against the missile itself). null when a missile is gone, and the jet then holds its heading.
 */
export function steerThreatPos(w: World, j: Jet): V3 | null {
  if (j.steer.mode !== "relative") return null;
  const id = j.steer.threatId;
  const jet = jetById(w, id);
  // A dead jet stays where it went down: "cold" still means away from where the threat was.
  if (jet) return jet.pos;
  const m = w.missiles.find((x) => x.id === id);
  return m && !m.end ? m.pos : null;
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
    case "chaff":
    case "flare": {
      const left = c.type === "chaff" ? j.chaff : j.flares;
      if (left <= 0) return c.type === "chaff" ? "No chaff left." : "No flares left.";
      if (c.type === "chaff") j.chaff--;
      else j.flares--;
      w.decoys.push({
        kind: c.type,
        jetId: j.id,
        side: j.side,
        t0: w.t,
        pos: { ...j.pos },
        vel: scale(velocity(j), 0.3),
        rolled: false,
      });
      emit(w, {
        type: c.type,
        side: j.side,
        jetId: j.id,
        text: `${j.callsign} ${c.type === "chaff" ? "chaff" : "flare"}`,
      });
      return null;
    }
    case "target":
      j.targetId = c.targetId;
      return null;
    case "fire": {
      const tgt = jetById(w, c.targetId ?? j.targetId);
      if (!tgt?.alive || tgt.side === j.side) return "No hostile target selected.";
      if (j.missiles <= 0) return "Winchester: no missiles left.";
      if (!radarCanTrack(w, j, tgt)) return "Target is outside TWS lock range or the radar gimbal.";
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
  "seeker-notched": ["seeker-notched", "seeker lost lock in the notch"],
  "seeker-chaffed": ["seeker-chaffed", "seeker pulled onto chaff"],
  miss: ["miss", "missed"],
  spent: ["spent", "self-destructed (flight time or speed limit)"],
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
    stepJet(w.params.aircraft, j, desiredHeading(j, steerThreatPos(w, j)), dt);
  }
  w.t += dt;

  // Chaff bundles released since the last step get their one roll against radars and seekers.
  const freshChaff = new Map<string, Decoy>();
  for (const d of w.decoys)
    if (d.kind === "chaff" && !d.rolled) {
      d.rolled = true;
      freshChaff.set(d.jetId, d);
    }
  updateRadarBreaks(w, dt, freshChaff);

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
    const evs = stepMissile(w.params.missile, m, truthOf(tgt), datalink, dt, w.params.missile.fuzeRadiusM, {
      rng: w.rng,
      cm: w.params.countermeasures,
      chaff: freshChaff.get(tgt.id) ?? null,
    });
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
  // Decoys drift and fade; they are only drawn for now.
  w.decoys = w.decoys.filter((d) => w.t - d.t0 < DECOY_LIFE_S);
  for (const d of w.decoys) d.pos = add(d.pos, scale(d.vel, dt));

  // Announce each active missile the first time it shows on a jet's RWR.
  for (const j of w.jets) {
    if (!j.alive) continue;
    for (const c of rwrContacts(w, j)) {
      if (c.kind !== "missile") continue;
      const key = `${c.sourceId}>${j.id}`;
      if (w.rwrSeen.has(key)) continue;
      w.rwrSeen.add(key);
      emit(w, {
        type: "rwr-missile",
        side: j.side,
        jetId: j.id,
        missileId: c.sourceId,
        targetId: j.id,
        text: `${j.callsign} RWR: missile active ${c.lock ? "and locked on" : "nearby"}`,
      });
    }
  }
  checkOutcome(w);
}

/**
 * A missile that can still kill someone: flying, not given up (lost), and its target alive. Every
 * missile stops being one within maxTofS, so a fight waiting on missiles always ends.
 */
export function missileThreatens(w: World, m: Missile): boolean {
  if (m.end || m.phase === "lost") return false;
  return !!jetById(w, m.targetId)?.alive;
}

/**
 * A side is wiped out but missiles that can still kill are in the air: the fight goes on until
 * they hit or are defeated (you can still die after the last bandit falls, or trade with your last shot).
 */
export function waitingOnMissiles(w: World): boolean {
  if (w.outcome) return false;
  const alive = (s: Side) => w.jets.some((j) => j.side === s && j.alive);
  return (!alive("blue") || !alive("red")) && w.missiles.some((m) => missileThreatens(w, m));
}

/**
 * The fight is decided (or about to be) but not called yet: a side is wiped out, or a result is
 * waiting out its random delay. The UI shows a banner; with fog of war it must not say why.
 */
export function awaitingCall(w: World): boolean {
  if (w.outcome) return false;
  const alive = (s: Side) => w.jets.some((j) => j.side === s && j.alive);
  return !alive("blue") || !alive("red") || w.callAt !== null;
}

/** Random wait (s) between a result being settled and it being called, so the timing gives nothing away. */
const CALL_DELAY_MIN_S = 5;
const CALL_DELAY_SPAN_S = 5;

function checkOutcome(w: World): void {
  const alive = (s: Side) => w.jets.some((j) => j.side === s && j.alive);
  const inFlight = (s: Side) => w.missiles.some((m) => m.side === s && missileThreatens(w, m));
  const armed = (s: Side) => w.jets.some((j) => j.side === s && j.alive && j.missiles > 0) || inFlight(s);
  const blue = alive("blue");
  const red = alive("red");
  let o: Outcome | null = null;
  if (!blue || !red) {
    // Nobody wins while a missile that can still kill is in the air.
    if (!inFlight("blue") && !inFlight("red")) {
      if (!blue && !red) o = { winner: null, kind: "trade", reason: "Trade: both sides were destroyed." };
      else if (!red)
        o = {
          winner: "blue",
          kind: "win",
          reason: "All hostiles destroyed, and you survived every missile in the air.",
        };
      else o = { winner: "red", kind: "loss", reason: "You were shot down." };
    }
  } else if (w.objective === "survive" && !armed("red"))
    o = { winner: "blue", kind: "win", reason: "You defeated every missile fired at you." };
  else if (!armed("blue") && !armed("red"))
    o = { winner: null, kind: "draw", reason: "Both sides are out of missiles." };
  // A settled result is called only after a random 5–10 s, so the moment the game ends does not
  // reveal that the last missile just died (with fog of war you could not know that).
  if (o) {
    if (w.callAt === null) w.callAt = w.t + CALL_DELAY_MIN_S + w.rng() * CALL_DELAY_SPAN_S;
    if (w.t < w.callAt) o = null;
  } else w.callAt = null;
  if (!o && w.t >= w.timeLimitS) o = { winner: null, kind: "draw", reason: "Time limit reached." };
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
