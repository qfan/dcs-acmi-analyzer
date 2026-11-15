/**
 * Time control around the deterministic world: real time with pause and time compression, plus
 * automatic pauses at decision points (events) and an optional "turn every N seconds" mode. The
 * same world runs under any of these policies; only when time moves differs.
 */
import { type Jet, velocity } from "../sim/aircraft.ts";
import { type MissileTimer, startTimer, stepTimer, type TargetTrack, trackAt } from "../sim/estimate.ts";
import type { GameParams } from "../sim/params.ts";
import { scenarioById } from "../sim/scenarios.ts";
import { type LaunchZone, launchZone } from "../sim/wez.ts";
import {
  type GameEvent,
  jetById,
  radarCanDetect,
  radarCanTrack,
  SIM_DT,
  step,
  truthOf,
  type World,
} from "../sim/world.ts";

export const PLAYER_SIDE = "blue";

/**
 * Events about a missile's own state that the launching jet cannot observe: with fog of war on,
 * your jet only has its timers, so these stay out of the log.
 */
const MISSILE_INTERNAL = new Set<GameEvent["type"]>([
  "pitbull",
  "acquired",
  "seeker-lost",
  "seeker-notched",
  "seeker-chaffed",
  "miss",
  "spent",
]);

export interface AutoPause {
  /** A hostile missile is fired at one of your jets. */
  enemyLaunch: boolean;
  /** A missile involving you (yours, or one aimed at you) goes active. */
  pitbull: boolean;
  /** A hostile missile's active seeker shows on one of your jets' RWR. */
  seekerLock: boolean;
  /** One of your missiles loses its datalink before pitbull. */
  datalinkLost: boolean;
  /** Your radar loses (or regains) your target. */
  radarChange: boolean;
  /** A missile involving you hits, misses or runs out of energy. */
  missileEnd: boolean;
  /** Also pause every N simulated seconds (0 = off): a turn-based feel. */
  turnEveryS: number;
}

export const DEFAULT_AUTOPAUSE: AutoPause = {
  enemyLaunch: false,
  pitbull: false,
  seekerLock: false,
  datalinkLost: false,
  radarChange: false,
  missileEnd: false,
  turnEveryS: 0,
};

export const TIME_SCALES = [1, 2, 4, 8, 16] as const;
const TRAIL_EVERY_S = 1;
const JET_TRAIL_S = 120;
const ZONE_EVERY_MS = 700;
/** A missile timer stays on screen this long (s) after its predicted impact. */
const TIMER_LINGER_S = 4;

export interface TrailPoint {
  x: number;
  y: number;
}

export class GameSession {
  world: World;
  readonly scenarioId: string;
  readonly altFt: number;
  paused = false;
  timeScale = 1;
  pauseReason: string | null = null;
  autoPause: AutoPause;
  selected = new Set<string>();
  trails = new Map<string, TrailPoint[]>();
  zone: { jetId: string; targetId: string; zone: LaunchZone; at: number; simT: number } | null = null;
  /**
   * Fog of war: show only what your side knows. Enemy jets appear while one of your radars detects
   * them, otherwise as a ghost where they were last seen. Missiles never show on radar (as in DCS):
   * enemy missiles appear only as RWR strobes once their seekers go active.
   */
  fog = false;
  /** Enemy jets your side's radars detect right now. */
  known = new Set<string>();
  lastSeen = new Map<string, { x: number; y: number; hdg: number; t: number }>();
  /** Last TWS track of each enemy jet held by one of your radars (what your missiles' timers use). */
  lastTrack = new Map<string, TargetTrack>();
  /** Onboard time-to-pitbull / time-to-impact estimate for each of your missiles. */
  timers = new Map<string, MissileTimer>();
  private acc = 0;
  private seenEvents = 0;
  private nextTrailAt = 0;
  private nextTurnAt: number;

  constructor(scenarioId: string, altFt: number, params: GameParams, autoPause: AutoPause, seed = 1) {
    this.scenarioId = scenarioId;
    this.altFt = altFt;
    this.world = scenarioById(scenarioId).build(params, altFt, seed);
    this.autoPause = autoPause;
    this.nextTurnAt = autoPause.turnEveryS > 0 ? autoPause.turnEveryS : Number.POSITIVE_INFINITY;
    const mine = this.world.jets.find((j) => j.side === PLAYER_SIDE);
    if (mine) this.selected.add(mine.id);
    this.updateKnowledge();
    this.updateTimers(0);
    this.recordTrails();
  }

  setAutoPause(a: AutoPause): void {
    this.autoPause = a;
    this.nextTurnAt = a.turnEveryS > 0 ? this.world.t + a.turnEveryS : Number.POSITIVE_INFINITY;
  }

  play(): void {
    if (this.world.outcome) return;
    this.paused = false;
    this.pauseReason = null;
  }

  pause(reason: string | null = null): void {
    this.paused = true;
    this.pauseReason = reason;
    this.acc = 0;
  }

  /** Advances by a wall-clock interval (s). Stops exactly at the step that triggers an auto-pause. */
  advance(realDt: number): void {
    if (this.paused || this.world.outcome) return;
    this.acc += Math.min(realDt, 0.25) * this.timeScale;
    while (this.acc >= SIM_DT && !this.paused && !this.world.outcome) {
      this.acc -= SIM_DT;
      step(this.world);
      this.updateKnowledge();
      this.updateTimers(SIM_DT);
      if (this.world.t >= this.nextTrailAt) this.recordTrails();
      this.checkEvents();
      if (this.world.t >= this.nextTurnAt - 1e-9) {
        this.nextTurnAt += this.autoPause.turnEveryS;
        if (!this.paused)
          this.pause(`Turn: ${this.autoPause.turnEveryS} s elapsed. Give orders, then continue.`);
      }
    }
    if (this.world.outcome) this.pause(null);
  }

  private checkEvents(): void {
    const evs = this.world.events;
    for (; this.seenEvents < evs.length; this.seenEvents++) {
      const e = evs[this.seenEvents] as GameEvent;
      if (!this.paused && this.shouldPause(e)) this.pause(e.text);
    }
  }

  private shouldPause(e: GameEvent): boolean {
    const a = this.autoPause;
    const mineShot = e.side === PLAYER_SIDE;
    const atMe = !mineShot && !!e.targetId && jetById(this.world, e.targetId)?.side === PLAYER_SIDE;
    switch (e.type) {
      case "launch":
        // There is no launch warning on the RWR, so under fog of war the player cannot know.
        return a.enemyLaunch && atMe && !this.fog;
      case "pitbull":
        return a.pitbull && (mineShot || atMe);
      case "rwr-missile":
        return a.seekerLock && e.side === PLAYER_SIDE;
      case "datalink-lost":
        return a.datalinkLost && mineShot;
      case "radar-lost":
      case "radar-gained":
        return a.radarChange && mineShot;
      case "kill":
      case "survived-hit":
      case "miss":
      case "spent":
      case "seeker-lost":
        return a.missileEnd && (mineShot || atMe);
      default:
        return false;
    }
  }

  private recordTrails(): void {
    this.nextTrailAt = this.world.t + TRAIL_EVERY_S;
    const maxJet = Math.ceil(JET_TRAIL_S / TRAIL_EVERY_S);
    for (const j of this.world.jets) {
      if (!j.alive) continue;
      const tr = this.trails.get(j.id) ?? [];
      tr.push({ x: j.pos.x, y: j.pos.y });
      if (tr.length > maxJet) tr.splice(0, tr.length - maxJet);
      this.trails.set(j.id, tr);
    }
    for (const m of this.world.missiles) {
      if (m.end) continue;
      const tr = this.trails.get(m.id) ?? [];
      tr.push({ x: m.pos.x, y: m.pos.y });
      this.trails.set(m.id, tr);
    }
  }

  private updateKnowledge(): void {
    const w = this.world;
    this.known.clear();
    const mine = w.jets.filter((j) => j.side === PLAYER_SIDE && j.alive);
    for (const e of w.jets) {
      if (e.side === PLAYER_SIDE || !e.alive) continue;
      if (mine.some((j) => radarCanDetect(w, j, e))) {
        this.known.add(e.id);
        this.lastSeen.set(e.id, { x: e.pos.x, y: e.pos.y, hdg: e.hdg, t: w.t });
      }
      if (mine.some((j) => radarCanTrack(w, j, e)))
        this.lastTrack.set(e.id, { pos: { ...e.pos }, vel: velocity(e), t: w.t });
    }
  }

  /**
   * Keeps the onboard estimate of each of your missiles: a copy of the missile model flown against
   * your own track of the target. The real missile is only read once, at launch.
   */
  private updateTimers(dt: number): void {
    const w = this.world;
    for (const m of w.missiles)
      if (m.side === PLAYER_SIDE && !this.timers.has(m.id)) this.timers.set(m.id, startTimer(m, w.t));
    for (const tm of this.timers.values()) {
      const shooter = jetById(w, tm.shooterId);
      const target = jetById(w, tm.targetId);
      const datalink = !!shooter && !!target && radarCanTrack(w, shooter, target);
      const track = this.lastTrack.get(tm.targetId);
      const known = datalink && target ? truthOf(target) : track ? trackAt(track, w.t) : null;
      if (known) stepTimer(w.params.missile, tm, known, datalink, w.t, dt);
    }
  }

  /** Timers still worth showing: until a little after the predicted impact, or the missile is spent. */
  activeTimers(): MissileTimer[] {
    const t = this.world.t;
    return [...this.timers.values()].filter((tm) => {
      if (tm.impactAt !== null) return t < tm.impactAt + TIMER_LINGER_S;
      return !tm.ghost.end && tm.ghost.phase !== "lost" && t - tm.launchT < this.world.params.missile.maxTofS;
    });
  }

  /** Whether the player may see this jet (or its decoys) right now. */
  sees(jetId: string): boolean {
    if (!this.fog) return true;
    const j = jetById(this.world, jetId);
    return !j || j.side === PLAYER_SIDE || !j.alive || this.known.has(jetId);
  }

  /** Whether the player may see this event in the log. */
  showsEvent(e: GameEvent): boolean {
    if (!this.fog || e.type === "end") return true;
    if (e.side === PLAYER_SIDE) return !MISSILE_INTERNAL.has(e.type);
    // Hits on your own jets are obvious; the rest of the enemy's side is hidden.
    return (
      (e.type === "kill" || e.type === "survived-hit") &&
      jetById(this.world, e.targetId)?.side === PLAYER_SIDE
    );
  }

  /** The first selected own jet that is alive. */
  primary(): Jet | undefined {
    for (const id of this.selected) {
      const j = jetById(this.world, id);
      if (j?.alive) return j;
    }
    return undefined;
  }

  /** Launch zone of the primary jet against its target, refreshed a few times a second. */
  refreshZone(nowMs: number): void {
    const j = this.primary();
    const t = jetById(this.world, j?.targetId);
    if (!j || !t?.alive || t.side === j.side || !this.sees(t.id)) {
      this.zone = null;
      return;
    }
    const z = this.zone;
    if (
      z &&
      z.jetId === j.id &&
      z.targetId === t.id &&
      (z.simT === this.world.t || nowMs - z.at < ZONE_EVERY_MS)
    )
      return;
    const zone = launchZone(this.world.params.missile, j, t);
    this.zone = { jetId: j.id, targetId: t.id, zone, at: nowMs, simT: this.world.t };
  }
}
