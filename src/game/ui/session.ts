/**
 * Time control around the deterministic world: real time with pause and time compression, plus
 * automatic pauses at decision points (events) and an optional "turn every N seconds" mode. The
 * same world runs under any of these policies; only when time moves differs.
 */
import type { Jet } from "../sim/aircraft.ts";
import type { GameParams } from "../sim/params.ts";
import { scenarioById } from "../sim/scenarios.ts";
import { type LaunchZone, launchZone } from "../sim/wez.ts";
import { type GameEvent, jetById, SIM_DT, step, type World } from "../sim/world.ts";

export const PLAYER_SIDE = "blue";

export interface AutoPause {
  /** A hostile missile is fired at one of your jets. */
  enemyLaunch: boolean;
  /** A missile involving you (yours, or one aimed at you) goes active. */
  pitbull: boolean;
  /** A hostile missile's seeker locks one of your jets. */
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
        return a.enemyLaunch && atMe;
      case "pitbull":
        return a.pitbull && (mineShot || atMe);
      case "acquired":
        return a.seekerLock && atMe;
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
    if (!j || !t?.alive || t.side === j.side) {
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
