/**
 * The authoritative fight: the deterministic world plus time control (real time with pause and
 * time compression, automatic pauses at decision points, an optional "turn every N seconds" mode)
 * and each side's knowledge. It runs in the engine worker (single player, or the multiplayer host);
 * the UI only ever sees snapshots of it. No UI state (selection, trails, view) lives here.
 */
import { AcmiRecorder } from "../acmi.ts";
import { desiredHeading, type Side } from "../sim/aircraft.ts";
import type { MissileTimer } from "../sim/estimate.ts";
import { type LastSeen, SideKnowledge } from "../sim/knowledge.ts";
import type { GameParams } from "../sim/params.ts";
import { DEFAULT_OPTIONS, type ScenarioOptions, scenarioById } from "../sim/scenarios.ts";
import type { V3 } from "../sim/vec.ts";
import {
  type Command,
  command,
  type GameEvent,
  jetById,
  rwrContacts,
  SIM_DT,
  step,
  type World,
} from "../sim/world.ts";

export const PLAYER_SIDE: Side = "blue";

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

export interface SessionInit {
  /** A world built elsewhere (multiplayer crews); otherwise the scenario builds one. */
  world?: World;
  /** Keep an .acmi recorder here (tests); the UI records from snapshots instead. */
  record?: boolean;
}

export class GameSession {
  world: World;
  readonly scenarioId: string;
  readonly altFt: number;
  paused = false;
  timeScale = 1;
  pauseReason: string | null = null;
  autoPause: AutoPause;
  /** The side single-player helpers (sees, auto-pause, fog) speak for. */
  side: Side = PLAYER_SIDE;
  /**
   * Single-player fog of war for `side`: show only what the side knows. Enemy jets appear while
   * one of its radars detects them, otherwise as a ghost where they were last seen. Missiles never
   * show on radar (as in DCS): enemy missiles appear only as RWR strobes once their seekers go active.
   */
  fog = false;
  /** Multiplayer: jets whose players fly with fog of war (their relative steering can't track unseen bandits). */
  fogJets = new Set<string>();
  readonly knowledge: Record<Side, SideKnowledge> = {
    blue: new SideKnowledge("blue"),
    red: new SideKnowledge("red"),
  };
  /** The fight so far, for .acmi export (only when asked for; null in infinite demo mode). */
  readonly recorder: AcmiRecorder | null;
  readonly startedAt = new Date();
  private acc = 0;
  private seenEvents = 0;
  private nextTurnAt: number;

  /** Who flies what (NPC skills; blue by you or by the NPC). */
  readonly options: ScenarioOptions;
  /** The NPC flies blue: you only watch (orders are ignored). */
  readonly watch: boolean;

  constructor(
    scenarioId: string,
    altFt: number,
    params: GameParams,
    autoPause: AutoPause,
    seed = 1,
    options: ScenarioOptions = DEFAULT_OPTIONS,
    init: SessionInit = {},
  ) {
    this.scenarioId = scenarioId;
    this.altFt = altFt;
    const scenario = scenarioById(scenarioId);
    const effectiveOptions: ScenarioOptions = scenario.allNpc
      ? { ...options, blueAi: options.blueAi ?? options.redSkill }
      : options;
    this.options = effectiveOptions;
    this.watch = !init.world && scenario.npc && (scenario.allNpc || effectiveOptions.blueAi !== null);
    this.world = init.world ?? scenario.build(params, altFt, seed, effectiveOptions);
    this.recorder =
      init.record === false || this.world.infinite
        ? null
        : new AcmiRecorder({
            title: `BVR Trainer: ${scenario.title}, ${altFt.toLocaleString("en-US")} ft`,
            startedAt: this.startedAt,
          });
    this.autoPause = autoPause;
    this.nextTurnAt = autoPause.turnEveryS > 0 ? autoPause.turnEveryS : Number.POSITIVE_INFINITY;
    this.updateKnowledge();
    this.updateTimers(0);
    this.recorder?.update(this.world);
  }

  /** The knowledge of the side single-player helpers speak for. */
  get mine(): SideKnowledge {
    return this.knowledge[this.side];
  }
  get known(): Set<string> {
    return this.mine.known;
  }
  get lastSeen(): Map<string, LastSeen> {
    return this.mine.lastSeen;
  }
  get timers(): Map<string, MissileTimer> {
    return this.mine.timers;
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
      this.freezeHiddenSteer();
      this.updateTimers(SIM_DT);
      this.recorder?.update(this.world);
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
    const offset = this.world.eventOffset;
    for (let idx = Math.max(0, this.seenEvents - offset); idx < evs.length; idx++) {
      const e = evs[idx] as GameEvent;
      if (!this.paused && this.shouldPause(e)) this.pause(e.text);
    }
    this.seenEvents = offset + evs.length;
  }

  private shouldPause(e: GameEvent): boolean {
    const a = this.autoPause;
    const mineShot = e.side === this.side;
    const atMe = !mineShot && !!e.targetId && jetById(this.world, e.targetId)?.side === this.side;
    switch (e.type) {
      case "launch":
        // There is no launch warning on the RWR, so under fog of war the player cannot know.
        return a.enemyLaunch && atMe && !this.fog;
      case "pitbull":
        return a.pitbull && (mineShot || atMe) && !this.fog;
      case "rwr-missile":
        return a.seekerLock && e.side === this.side;
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
        return (
          a.missileEnd && (mineShot || atMe) && (!this.fog || e.type === "kill" || e.type === "survived-hit")
        );
      default:
        return false;
    }
  }

  private updateKnowledge(): void {
    this.knowledge.blue.update(this.world);
    this.knowledge.red.update(this.world);
  }

  private updateTimers(dt: number): void {
    this.knowledge.blue.updateTimers(this.world, dt);
    this.knowledge.red.updateTimers(this.world, dt);
  }

  /** Whether this jet's pilot flies with fog of war on. */
  private fogged(jetId: string, side: Side): boolean {
    return this.fogJets.has(jetId) || (this.fog && side === this.side);
  }

  /**
   * Under fog of war, relative steering must not track an unseen bandit or a missile that has left
   * the jet's RWR. Freeze to the last-known heading when contact is lost.
   */
  private freezeHiddenSteer(): void {
    const w = this.world;
    for (const j of w.jets) {
      if (!j.alive || j.steer.mode !== "relative" || !this.fogged(j.id, j.side)) continue;
      const k = this.knowledge[j.side];
      const id = j.steer.threatId;
      const enemy = jetById(w, id);
      if (enemy) {
        if (!k.sees(w, enemy.id, true)) {
          const known = k.knownEnemyPos(w, enemy.id, true);
          j.steer = { mode: "heading", hdg: desiredHeading(j, known) };
        }
      } else {
        const onRwr = rwrContacts(w, j).some((c) => c.kind === "missile" && c.sourceId === id);
        if (!onRwr) j.steer = { mode: "heading", hdg: j.steer.lastHdg ?? j.hdg };
      }
    }
  }

  /** Applies a command and syncs onboard timers immediately (e.g. firing while paused). */
  applyCommand(c: Command): string | null {
    const err = command(this.world, c);
    if (!err && c.type === "fire") this.updateTimers(0);
    return err;
  }

  /** Best known position of an alive enemy jet for `side` (default: the single-player side). */
  knownEnemyPos(enemyId: string, side: Side = this.side): V3 | null {
    return this.knowledge[side].knownEnemyPos(this.world, enemyId, this.fog || side !== this.side);
  }

  /** Timers of `side` still worth showing. */
  activeTimers(side: Side = this.side): MissileTimer[] {
    return this.knowledge[side].activeTimers(this.world);
  }

  /** Whether the single-player side may see this jet (or its decoys) right now. */
  sees(jetId: string): boolean {
    return this.mine.sees(this.world, jetId, this.fog);
  }

  /** Whether the single-player side may see this event in the log. */
  showsEvent(e: GameEvent): boolean {
    return this.mine.showsEvent(this.world, e, this.fog);
  }
}
