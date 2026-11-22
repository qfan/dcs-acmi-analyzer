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
import type { Missile, MissileEnd, MissilePhase } from "../sim/missile.ts";
import type { GameParams } from "../sim/params.ts";
import { add, scale } from "../sim/vec.ts";
import {
  DECOY_LIFE_S,
  type Decoy,
  type GameEvent,
  makeWorld,
  type Outcome,
  type RwrContact,
  rwrContacts,
  type World,
} from "../sim/world.ts";
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
  rwr: [string, RwrContact[]][];
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
  /** Next decoy `seq` to send: each decoy goes out once, and the mirror moves it from there. */
  decoySeq = 0;
  full = true;

  /** A copy to go back to when a snapshot that was built is not sent after all. */
  clone(): SnapshotCursor {
    const c = new SnapshotCursor();
    c.events = this.events;
    c.endedSent = new Set(this.endedSent);
    c.decoySeq = this.decoySeq;
    c.full = this.full;
    return c;
  }

  restore(from: SnapshotCursor): void {
    this.events = from.events;
    this.endedSent = from.endedSent;
    this.decoySeq = from.decoySeq;
    this.full = from.full;
  }
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
  const decoys = full ? [...w.decoys] : w.decoys.filter((d) => d.seq >= cur.decoySeq);
  cur.decoySeq = w.decoySeq;
  const know: Partial<Record<Side, KnowView>> = {};
  for (const side of sides) know[side] = knowView(w, s.knowledge[side]);
  const sideSet = new Set(sides);
  const rwr: [string, RwrContact[]][] = [];
  for (const j of w.jets) {
    if (j.alive && sideSet.has(j.side)) rwr.push([j.id, rwrContacts(w, j).map((c) => ({ ...c }))]);
  }
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
    decoys,
    radarTrack: [...w.radarTrack].filter(([, v]) => v).map(([k]) => k),
    radarBreak: w.radarBreak.size === 0 ? [] : [...w.radarBreak].filter(([, until]) => until > w.t),
    rwr,
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
  // Decoys come once, on release; between snapshots they drift on their own, as in the sim.
  const dt = Math.max(0, snap.t - w.t);
  if (snap.full) w.decoys = [...snap.decoys];
  else {
    for (const d of w.decoys) d.pos = add(d.pos, scale(d.vel, dt));
    const have = new Set(w.decoys.map((d) => d.seq));
    for (const d of snap.decoys) if (!have.has(d.seq)) w.decoys.push(d);
  }
  w.decoys = w.decoys.filter((d) => snap.t - d.t0 < DECOY_LIFE_S);
  w.t = snap.t;
  w.jets = snap.jets;
  if (snap.full) {
    w.missiles = [];
    w.events = [];
    w.eventOffset = snap.eventsFrom;
  }
  if (w.infinite) {
    // Infinite mode drops ended missiles from the sim world each step, so snap.missiles is the full live set.
    w.missiles = snap.missiles;
  } else {
    const byId = new Map(w.missiles.map((m, i) => [m.id, i]));
    for (const m of snap.missiles) {
      const i = byId.get(m.id);
      if (i === undefined) {
        byId.set(m.id, w.missiles.length);
        w.missiles.push(m);
      } else w.missiles[i] = m;
    }
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
  w.radarTrack = new Map(snap.radarTrack.map((id) => [id, true]));
  w.radarBreak = new Map(snap.radarBreak);
  w.rwr = new Map(snap.rwr ?? []);
  w.outcome = snap.outcome;
  w.callAt = snap.callAt;
  return snap.eventsFrom <= next ? fresh : [];
}

/** Rounds for the wire: coordinates and speeds to 0.1 (m, m/s), times and angles to 1e-4. */
const r1 = (v: number) => Math.round(v * 10) / 10;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const r4n = (v: number | null) => (v === null ? null : r4(v));

/** Position and velocity components: 0.1 m (or m/s) is far finer than anything drawn. */
const COARSE_KEYS = new Set(["x", "y", "z"]);

const round = (k: string, v: unknown) => {
  if (typeof v !== "number" || Number.isInteger(v)) return v;
  return COARSE_KEYS.has(k) ? r1(v) : r4(v);
};

const PHASES: MissilePhase[] = ["datalink", "inertial", "search", "tracking", "lost"];

/**
 * A missile on the wire, as an array (field names would be most of its size): id, side (0 blue,
 * 1 red), shooter, target, position, velocity, estimated target position, phase, pitbull (0/1),
 * end (or 0), time of flight. Only what guests use (drawing, readouts, recorder).
 */
type NetMissile = [
  string,
  0 | 1,
  string,
  string,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  0 | 1,
  MissileEnd | 0,
  number,
];

function packMissile(m: Missile): NetMissile {
  return [
    m.id,
    m.side === "blue" ? 0 : 1,
    m.shooterId,
    m.targetId,
    r1(m.pos.x),
    r1(m.pos.y),
    r1(m.pos.z),
    r1(m.vel.x),
    r1(m.vel.y),
    r1(m.vel.z),
    r1(m.estPos.x),
    r1(m.estPos.y),
    r1(m.estPos.z),
    Math.max(0, PHASES.indexOf(m.phase)),
    m.pitbull ? 1 : 0,
    m.end ?? 0,
    r4(m.tof),
  ];
}

function unpackMissile(a: NetMissile): Missile {
  const [id, side, shooterId, targetId, px, py, pz, vx, vy, vz, ex, ey, ez, ph, pb, end, tof] = a;
  return {
    id,
    side: side === 0 ? "blue" : "red",
    shooterId,
    targetId,
    pos: { x: px, y: py, z: pz },
    vel: { x: vx, y: vy, z: vz },
    estPos: { x: ex, y: ey, z: ez },
    estVel: { x: 0, y: 0, z: 0 },
    phase: PHASES[ph] ?? "datalink",
    pitbull: pb === 1,
    end: end === 0 ? null : end,
    tof,
    launchAlt: pz,
    loftGainM: 0,
    lofting: false,
    closestM: Number.POSITIVE_INFINITY,
    prevRangeM: Number.POSITIVE_INFINITY,
    latAccel: 0,
    lostAt: null,
    blindUntil: 0,
  };
}

/** A missile timer on the wire: missile, shooter, target, launch, pitbull, impact, first impact, pitbull flag. */
type NetTimer = [string, string, string, number, number | null, number | null, number | null, 0 | 1];

const packTimer = (t: TimerView): NetTimer => [
  t.missileId,
  t.shooterId,
  t.targetId,
  r4(t.launchT),
  r4n(t.pitbullAt),
  r4n(t.impactAt),
  r4n(t.firstImpactAt),
  t.pitbull ? 1 : 0,
];

const unpackTimer = ([
  missileId,
  shooterId,
  targetId,
  launchT,
  pitbullAt,
  impactAt,
  firstImpactAt,
  pb,
]: NetTimer): TimerView => ({
  missileId,
  shooterId,
  targetId,
  launchT,
  pitbullAt,
  impactAt,
  firstImpactAt,
  pitbull: pb === 1,
});

/** A decoy on the wire: seq, kind (0 chaff, 1 flare), jet, side (0/1), release time, position, velocity. */
type NetDecoy = [number, 0 | 1, string, 0 | 1, number, number, number, number, number, number, number];

const packDecoy = (d: Decoy): NetDecoy => [
  d.seq,
  d.kind === "chaff" ? 0 : 1,
  d.jetId,
  d.side === "blue" ? 0 : 1,
  r4(d.t0),
  r1(d.pos.x),
  r1(d.pos.y),
  r1(d.pos.z),
  r1(d.vel.x),
  r1(d.vel.y),
  r1(d.vel.z),
];

const unpackDecoy = ([seq, kind, jetId, side, t0, px, py, pz, vx, vy, vz]: NetDecoy): Decoy => ({
  seq,
  kind: kind === 0 ? "chaff" : "flare",
  jetId,
  side: side === 0 ? "blue" : "red",
  t0,
  pos: { x: px, y: py, z: pz },
  vel: { x: vx, y: vy, z: vz },
  rolled: true,
});

/** An RWR contact on the wire: sourceId, kind (0 radar, 1 missile), bearing, lock (0/1), lastSeenAt, held (0/1). */
type NetRwrContact = [string, 0 | 1, number, 0 | 1, number, 0 | 1];

const packRwr = (c: RwrContact): NetRwrContact => [
  c.sourceId,
  c.kind === "radar" ? 0 : 1,
  r4(c.bearing),
  c.lock ? 1 : 0,
  r4(c.lastSeenAt),
  c.held ? 1 : 0,
];

const unpackRwr = ([sourceId, kind, bearing, lock, lastSeenAt, held]: NetRwrContact): RwrContact => ({
  sourceId,
  kind: kind === 0 ? "radar" : "missile",
  bearing,
  lock: lock === 1,
  lastSeenAt,
  held: held === 1,
});

/** A smaller snapshot for when the full one is too big: no NPC panels, no track extrapolation. */
export function slimSnapshot(snap: Snapshot): Snapshot {
  const know: Snapshot["know"] = {};
  for (const [side, k] of Object.entries(snap.know) as [Side, KnowView][])
    know[side] = { ...k, lastTrack: [] };
  return { ...snap, npc: {}, know };
}

/** JSON for the relay: numbers rounded, missiles, decoys and timers packed as arrays. */
export function snapshotToJson(snap: Snapshot): string {
  const know: Record<string, unknown> = {};
  for (const [side, k] of Object.entries(snap.know) as [Side, KnowView][])
    know[side] = { ...k, timers: k.timers.map(packTimer) };
  const rwr = snap.rwr.map(([id, list]) => [id, list.map(packRwr)] as const);
  return JSON.stringify(
    { ...snap, missiles: snap.missiles.map(packMissile), decoys: snap.decoys.map(packDecoy), rwr, know },
    round,
  );
}

/** Restores a snapshot that came over the relay. */
export function snapshotFromNet(raw: unknown): Snapshot {
  const snap = raw as Snapshot;
  snap.missiles = (snap.missiles as unknown as NetMissile[]).map(unpackMissile);
  snap.decoys = (snap.decoys as unknown as NetDecoy[]).map(unpackDecoy);
  snap.rwr = ((snap.rwr as unknown as [string, NetRwrContact[]][] | undefined) ?? []).map(([id, list]) => [
    id,
    list.map(unpackRwr),
  ]);
  for (const k of Object.values(snap.know) as KnowView[])
    k.timers = (k.timers as unknown as NetTimer[]).map(unpackTimer);
  return snap;
}
