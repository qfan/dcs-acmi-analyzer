/**
 * Snapshots: what the UI (and multiplayer guests) see of the authoritative fight. The engine builds
 * them; the UI applies them to a mirror `World`, so drawing and readouts use the same helpers as the
 * sim. They are plain data: structured-cloned to the UI, JSON over the relay.
 *
 * Incremental: events and ended missiles are sent once (per cursor); jets, live missiles and decoys
 * every time. A `full` snapshot carries everything, for a fresh start or a resync.
 */
import { DoctrineBot, type NpcStatus } from "../ai/doctrine.ts";
import type { Jet, Side } from "../sim/aircraft.ts";
import type { TargetTrack } from "../sim/estimate.ts";
import { type LastSeen, type SideKnowledge, type TimerView, timerView } from "../sim/knowledge.ts";
import type { Missile } from "../sim/missile.ts";
import type { GameParams } from "../sim/params.ts";
import { type Decoy, type GameEvent, makeWorld, type Outcome, type World } from "../sim/world.ts";
import type { GameSession } from "./session.ts";

export interface KnowView {
  known: string[];
  lastSeen: [string, LastSeen][];
  lastTrack: [string, TargetTrack][];
  timers: TimerView[];
}

export interface NpcView {
  /** "NPC Normal: support" style line. */
  line: string;
  status: NpcStatus;
}

export interface Snapshot {
  t: number;
  full: boolean;
  jets: Jet[];
  /** Live missiles, plus those that ended since the last snapshot on this cursor (all, when full). */
  missiles: Missile[];
  /** New events; `eventsFrom` is the absolute index of the first one. */
  events: GameEvent[];
  eventsFrom: number;
  decoys: Decoy[];
  radarTrack: string[];
  radarBreak: [string, number][];
  outcome: Outcome | null;
  callAt: number | null;
  paused: boolean;
  pauseReason: string | null;
  timeScale: number;
  know: Partial<Record<Side, KnowView>>;
  npc: Record<string, NpcView>;
}

/** What one consumer of snapshots has already been sent. */
export class SnapshotCursor {
  events = 0;
  endedSent = new Set<string>();
  full = true;
}

function knowView(w: World, k: SideKnowledge): KnowView {
  return {
    known: [...k.known],
    lastSeen: [...k.lastSeen],
    lastTrack: [...k.lastTrack],
    timers: k.activeTimers(w).map(timerView),
  };
}

export function buildSnapshot(s: GameSession, sides: Side[], cur: SnapshotCursor): Snapshot {
  const w = s.world;
  const full = cur.full;
  cur.full = false;
  if (full) {
    cur.events = 0;
    cur.endedSent.clear();
  }
  const missiles: Missile[] = [];
  for (const m of w.missiles) {
    if (!m.end) missiles.push(m);
    else if (!cur.endedSent.has(m.id)) {
      missiles.push(m);
      cur.endedSent.add(m.id);
    }
  }
  const from = Math.max(cur.events, w.eventOffset);
  const events = w.events.slice(from - w.eventOffset);
  cur.events = w.eventOffset + w.events.length;
  const know: Partial<Record<Side, KnowView>> = {};
  for (const side of sides) know[side] = knowView(w, s.knowledge[side]);
  const npc: Record<string, NpcView> = {};
  for (const [id, c] of w.controllers)
    if (c instanceof DoctrineBot)
      npc[id] = { line: `NPC ${c.skill.label}: ${c.describe()}`, status: c.status() };
  return {
    t: w.t,
    full,
    jets: w.jets,
    missiles,
    events,
    eventsFrom: from,
    decoys: w.decoys,
    radarTrack: [...w.radarTrack].filter(([, v]) => v).map(([k]) => k),
    radarBreak: [...w.radarBreak],
    outcome: w.outcome,
    callAt: w.callAt,
    paused: s.paused,
    pauseReason: s.pauseReason,
    timeScale: s.timeScale,
    know,
    npc,
  };
}

/** Fight settings a mirror world needs besides snapshots. */
export interface WorldShape {
  params: GameParams;
  infinite: boolean;
  timeLimitS: number;
  objective: World["objective"];
}

export const worldShape = (w: World): WorldShape => ({
  params: w.params,
  infinite: w.infinite,
  timeLimitS: w.timeLimitS,
  objective: w.objective,
});

/** An empty world to mirror snapshots into. */
export function makeMirror(shape: WorldShape): World {
  const w = makeWorld(shape.params, 1);
  w.infinite = shape.infinite;
  w.timeLimitS = shape.timeLimitS;
  w.objective = shape.objective;
  return w;
}

/** Most events a mirror keeps (older ones scroll out of the log anyway). */
const MIRROR_EVENTS = 400;

/** Applies a snapshot to a mirror world. Returns the events that were new to this mirror. */
export function applySnapshot(w: World, snap: Snapshot): GameEvent[] {
  w.t = snap.t;
  w.jets = snap.jets;
  if (snap.full) {
    w.missiles = [];
    w.events = [];
    w.eventOffset = snap.eventsFrom;
  }
  const byId = new Map(w.missiles.map((m, i) => [m.id, i]));
  for (const m of snap.missiles) {
    const i = byId.get(m.id);
    if (i === undefined) {
      byId.set(m.id, w.missiles.length);
      w.missiles.push(m);
    } else w.missiles[i] = m;
  }
  // Events arrive in order; skip any already applied (a resync can overlap the stream).
  const next = w.eventOffset + w.events.length;
  const fresh = snap.events.slice(Math.max(0, next - snap.eventsFrom));
  if (snap.eventsFrom <= next) w.events.push(...fresh);
  if (w.events.length > MIRROR_EVENTS) {
    const drop = w.events.length - MIRROR_EVENTS;
    w.events.splice(0, drop);
    w.eventOffset += drop;
  }
  w.decoys = snap.decoys;
  w.radarTrack = new Map(snap.radarTrack.map((id) => [id, true]));
  w.radarBreak = new Map(snap.radarBreak);
  w.outcome = snap.outcome;
  w.callAt = snap.callAt;
  return snap.eventsFrom <= next ? fresh : [];
}

/** Missile fields guests need (draw, readouts, recorder); the rest are filled in on arrival. */
const NET_MISSILE_KEYS = [
  "id",
  "side",
  "shooterId",
  "targetId",
  "pos",
  "vel",
  "estPos",
  "phase",
  "pitbull",
  "end",
  "tof",
] as const;

const round = (_k: string, v: unknown) =>
  typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v;

/** JSON for the relay: numbers rounded, missiles trimmed to what guests use. */
export function snapshotToJson(snap: Snapshot): string {
  const missiles = snap.missiles.map((m) => {
    const o: Record<string, unknown> = {};
    for (const k of NET_MISSILE_KEYS) o[k] = m[k];
    return o;
  });
  return JSON.stringify({ ...snap, missiles }, round);
}

/** Restores a snapshot that came over the relay (fills the missile fields that were left out). */
export function snapshotFromNet(raw: unknown): Snapshot {
  const snap = raw as Snapshot;
  snap.missiles = (snap.missiles as Partial<Missile>[]).map((m) => ({
    launchAlt: m.pos?.z ?? 0,
    loftGainM: 0,
    lofting: false,
    estVel: { x: 0, y: 0, z: 0 },
    closestM: Number.POSITIVE_INFINITY,
    prevRangeM: Number.POSITIVE_INFINITY,
    latAccel: 0,
    lostAt: null,
    blindUntil: 0,
    ...m,
  })) as Missile[];
  return snap;
}
