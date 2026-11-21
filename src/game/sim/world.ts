/**
 * The game world: a deterministic fixed-step simulation. Everything that changes the world goes
 * through `command()` or `step()`, so the same seed, commands and step count always give the same
 * fight. Time control (real time, pause, auto-pause on events, turns) lives outside, in the UI.
 */
import { clampAltCmd, desiredHeading, type Jet, type Side, stepJet, velocity } from "./aircraft.ts";
import { DEG, NM } from "./atmosphere.ts";
import { launchMissile, type Missile, type MissileEvent, stepMissile, type TargetTruth } from "./missile.ts";
import type { GameParams } from "./params.ts";
import { makeRng, type Rng } from "./rng.ts";
import { add, angleBetween, bearing, headingVec, len, scale, sub, type V3 } from "./vec.ts";

export const SIM_DT = 0.02;
/** Maximum distance (nm) a jet may travel from its initial position before counting as a loss. */
export const MAX_ROAM_NM = 500;
/** In infinite demo mode, winchester jets retire and respawn after staying this far clear (nm) for >10 s. */
export const EGRESS_RETIRE_NM = 50;
export const EGRESS_RETIRE_S = 10;
/** How long a released chaff bundle or flare stays on the map (s). */
export const DECOY_LIFE_S = 4;

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
  | "seeker-chaffed"
  | "rwr-missile"
  | "chaff"
  | "flare"
  | "rtb"
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
  /** Altitude (m) to climb or dive to and hold; clamped to the hard deck and ceiling. */
  | { type: "altitude"; jetId: string; altM: number }
  | { type: "target"; jetId: string; targetId: string | null }
  | { type: "fire"; jetId: string; targetId?: string }
  | { type: "chaff"; jetId: string }
  | { type: "flare"; jetId: string };

/** A released chaff bundle or flare, kept briefly for display (it does not affect missiles yet). */
export interface Decoy {
  /** Release order within the fight (snapshots send each decoy once, by this). */
  seq: number;
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

/** Builds a replacement jet (and optional controller) when a jet is destroyed in infinite mode. */
export type JetRespawner = (world: World, dead: Jet) => { jet: Jet; controller?: Controller } | null;

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
  /** Decoys released so far (the next decoy's `seq`). */
  decoySeq: number;
  /** Whether each jet's radar tracks its target, last step. */
  radarTrack: Map<string, boolean>;
  decoys: Decoy[];
  /** "missileId>jetId" pairs already announced on that jet's RWR. */
  rwrSeen: Set<string>;
  /** "radarJetId>targetJetId" → sim time until which that radar cannot lock the target (chaff). */
  radarBreak: Map<string, number>;
  outcome: Outcome | null;
  /** Number of early events trimmed from `events` in infinite mode, to keep HUD cursors aligned. */
  eventOffset: number;
  /** Infinite demo mode: skips outcome checks, respawns killed jets, and bounds retained history. */
  infinite: boolean;
  /** In infinite mode: sim time each winchester jet began staying >=50 nm clear of enemies. */
  egressSafeSince: Map<string, number>;
  /** Optional builder invoked when a jet is lost in infinite mode to spawn its replacement. */
  respawn?: JetRespawner;
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
    decoySeq: 0,
    radarTrack: new Map(),
    decoys: [],
    rwrSeen: new Set(),
    radarBreak: new Map(),
    outcome: null,
    eventOffset: 0,
    infinite: false,
    egressSafeSince: new Map(),
    timeLimitS: 1200,
    objective: "kill",
    callAt: null,
  };
}

export const jetById = (w: World | null | undefined, id: string | null | undefined): Jet | undefined =>
  w && id ? w.jets.find((j) => j.id === id) : undefined;

/** True when `shooter`'s radar cone covers `pos` out to `rangeNm`. */
export function radarCoversPos(w: World, shooter: Jet, pos: V3, rangeNm: number): boolean {
  if (!shooter.alive) return false;
  const los = sub(pos, shooter.pos);
  if (len(los) > rangeNm * NM) return false;
  // The antenna is stabilised to the horizon: climbing or diving does not tilt the scan.
  return angleBetween(los, headingVec(shooter.hdg, 0)) <= w.params.radar.gimbalDeg * DEG;
}

function radarCovers(w: World, shooter: Jet, target: Jet, rangeNm: number): boolean {
  return target.alive && radarCoversPos(w, shooter, target.pos, rangeNm);
}

const detectRange = (w: World) => Math.max(w.params.radar.detectRangeNm, w.params.radar.rangeNm);

/** True when `shooter`'s radar scan covers `target` (what the target's RWR sees), even while chaff holds it off. */
export function radarScans(w: World, shooter: Jet, target: Jet): boolean {
  return radarCovers(w, shooter, target, detectRange(w));
}

/** True while a chaff break keeps `shooter`'s radar off `target`. */
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
 * Chaff against radars, once per step: a fresh chaff bundle has a small chance to pull each radar
 * scanning the jet off it for a moment.
 */
function updateRadarBreaks(w: World, freshChaff: Map<string, Decoy>): void {
  const cm = w.params.countermeasures;
  for (const radar of w.jets) {
    if (!radar.alive) continue;
    for (const tgt of w.jets) {
      if (tgt.side === radar.side || !tgt.alive || !radarScans(w, radar, tgt)) continue;
      const key = `${radar.id}>${tgt.id}`;
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
 * Position of what a "relative" steering order is flown against: a jet, or a threatening missile
 * (defending against the missile itself). null once the missile misses (lost) or ends, so the jet
 * holds its heading instead of reversing course behind a missile that flew past.
 */
export function steerThreatPos(w: World, j: Jet): V3 | null {
  if (j.steer.mode !== "relative") return null;
  const id = j.steer.threatId;
  const jet = jetById(w, id);
  // A dead jet stays where it went down: "cold" still means away from where the threat was.
  if (jet) return jet.pos;
  const m = w.missiles.find((x) => x.id === id);
  return m && !m.end && m.phase !== "lost" ? m.pos : null;
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
    case "altitude":
      j.altCmd = clampAltCmd(w.params.aircraft, c.altM);
      return null;
    case "chaff":
    case "flare": {
      const left = c.type === "chaff" ? j.chaff : j.flares;
      if (left <= 0) return c.type === "chaff" ? "No chaff left." : "No flares left.";
      if (c.type === "chaff") j.chaff--;
      else j.flares--;
      w.decoys.push({
        seq: w.decoySeq++,
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
      m.shooterCallsign = j.callsign;
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
    if (j.pos.z <= 0) {
      j.alive = false;
      j.g = 1;
      j.pos.z = 0;
      emit(w, {
        type: "kill",
        side: j.side === "blue" ? "red" : "blue",
        targetId: j.id,
        text: `${j.callsign} flew into the ground`,
      });
    }
  }
  w.t += dt;

  // Chaff bundles released since the last step get their one roll against radars and seekers.
  const freshChaff = new Map<string, Decoy>();
  for (const d of w.decoys)
    if (d.kind === "chaff" && !d.rolled) {
      d.rolled = true;
      freshChaff.set(d.jetId, d);
    }
  updateRadarBreaks(w, freshChaff);

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
    const who = `${shooter?.callsign ?? m.shooterCallsign ?? "?"} ${m.id}`;
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

  // Any jet 500 nm or further from its initial spawn location counts as a loss.
  const maxRoamM = MAX_ROAM_NM * NM;
  for (const j of w.jets) {
    if (!j.alive) continue;
    if (len(sub(j.pos, j.startPos)) >= maxRoamM) {
      j.alive = false;
      j.g = 1;
      emit(w, {
        type: "kill",
        side: j.side === "blue" ? "red" : "blue",
        targetId: j.id,
        text: `${j.callsign} lost (departed ${MAX_ROAM_NM} nm from initial position)`,
      });
    }
  }

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
  if (w.infinite) maintainInfiniteWorld(w);
  else checkOutcome(w);
}

const MAX_INFINITE_EVENTS = 150;

function retireSafeEgressJets(w: World): void {
  const safeM = EGRESS_RETIRE_NM * NM;
  const toRetire: Jet[] = [];
  for (const j of w.jets) {
    if (!j.alive) {
      w.egressSafeSince.delete(j.id);
      continue;
    }
    const winchester = j.missiles === 0 && !w.missiles.some((m) => !m.end && m.shooterId === j.id);
    if (!winchester) {
      w.egressSafeSince.delete(j.id);
      continue;
    }
    const threatened =
      rwrContacts(w, j).some((c) => c.kind === "missile") ||
      w.missiles.some((m) => !m.end && m.phase !== "lost" && m.targetId === j.id);
    if (threatened) {
      w.egressSafeSince.delete(j.id);
      continue;
    }
    let nearestM = Number.POSITIVE_INFINITY;
    for (const e of w.jets) {
      if (e.side !== j.side && e.alive) nearestM = Math.min(nearestM, len(sub(e.pos, j.pos)));
    }
    if (nearestM < safeM) {
      w.egressSafeSince.delete(j.id);
      continue;
    }
    const since = w.egressSafeSince.get(j.id);
    if (since === undefined) w.egressSafeSince.set(j.id, w.t);
    else if (w.t - since > EGRESS_RETIRE_S) toRetire.push(j);
  }
  for (const j of toRetire) {
    j.alive = false;
    j.g = 1;
    w.egressSafeSince.delete(j.id);
    emit(w, {
      type: "rtb",
      side: j.side,
      jetId: j.id,
      text: `${j.callsign} RTB (winchester, >${EGRESS_RETIRE_NM} nm clear) — replaced`,
    });
  }
}

function maintainInfiniteWorld(w: World): void {
  retireSafeEgressJets(w);
  const dead = w.jets.filter((j) => !j.alive);
  if (dead.length > 0) {
    const deadIds = new Set(dead.map((d) => d.id));
    for (const d of dead) {
      w.egressSafeSince.delete(d.id);
      w.controllers.delete(d.id);
      w.radarTrack.delete(d.id);
      const rep = w.respawn?.(w, d);
      if (rep) {
        w.jets.push(rep.jet);
        if (rep.controller) w.controllers.set(rep.jet.id, rep.controller);
        w.radarTrack.set(rep.jet.id, false);
      }
    }
    w.jets = w.jets.filter((j) => j.alive);
    for (const [key, until] of w.radarBreak) {
      if (until <= w.t) {
        w.radarBreak.delete(key);
        continue;
      }
      const sep = key.indexOf(">");
      if (sep >= 0 && (deadIds.has(key.slice(0, sep)) || deadIds.has(key.slice(sep + 1)))) {
        w.radarBreak.delete(key);
      }
    }
  }
  if (w.missiles.some((m) => m.end !== null)) {
    w.missiles = w.missiles.filter((m) => !m.end);
    const liveMissiles = new Set(w.missiles.map((m) => m.id));
    for (const key of w.rwrSeen) {
      const sep = key.indexOf(">");
      const mid = sep >= 0 ? key.slice(0, sep) : key;
      if (!liveMissiles.has(mid)) w.rwrSeen.delete(key);
    }
  }
  if (w.events.length > MAX_INFINITE_EVENTS) {
    const drop = w.events.length - MAX_INFINITE_EVENTS;
    w.events.splice(0, drop);
    w.eventOffset += drop;
  }
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
  if (w.infinite || w.outcome) return false;
  const alive = (s: Side) => w.jets.some((j) => j.side === s && j.alive);
  return (!alive("blue") || !alive("red")) && w.missiles.some((m) => missileThreatens(w, m));
}

/**
 * The fight is decided (or about to be) but not called yet: a side is wiped out, or a result is
 * waiting out its random delay. The UI shows a banner; with fog of war it must not say why.
 */
export function awaitingCall(w: World): boolean {
  if (w.infinite || w.outcome) return false;
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
