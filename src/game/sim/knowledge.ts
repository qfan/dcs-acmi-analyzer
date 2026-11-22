/**
 * What one side knows: which enemy jets its radars detect, where each was last seen, the last TWS
 * track of each (what its missiles' timers use), and an onboard time-to-pitbull/impact estimate for
 * each of its own missiles. The sim keeps one per side; a player's view is built from their side's.
 */
import { type Side, velocity } from "./aircraft.ts";
import { type MissileTimer, startTimer, stepTimer, type TargetTrack, trackAt } from "./estimate.ts";
import type { V3 } from "./vec.ts";
import {
  type GameEvent,
  jetById,
  radarBroken,
  radarCanDetect,
  radarCanTrack,
  radarCoversPos,
  truthOf,
  type World,
} from "./world.ts";

export interface LastSeen {
  x: number;
  y: number;
  z: number;
  hdg: number;
  t: number;
}

/** A missile timer as the UI needs it (no ghost missile). */
export interface TimerView {
  missileId: string;
  shooterId: string;
  targetId: string;
  launchT: number;
  pitbullAt: number | null;
  impactAt: number | null;
  firstImpactAt: number | null;
  /** The onboard estimate thinks the missile has gone active. */
  pitbull: boolean;
}

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

/** A missile timer stays on screen this long (s) after its predicted impact. */
const TIMER_LINGER_S = 4;

export class SideKnowledge {
  readonly side: Side;
  /** Enemy jets this side's radars detect right now. */
  known = new Set<string>();
  lastSeen = new Map<string, LastSeen>();
  /** Last TWS track of each enemy jet held by one of this side's radars. */
  lastTrack = new Map<string, TargetTrack>();
  /** Onboard estimate for each of this side's missiles. */
  timers = new Map<string, MissileTimer>();

  constructor(side: Side) {
    this.side = side;
  }

  /** Refreshes detections, last-seen positions and tracks from the world. */
  update(w: World): void {
    const side = this.side;
    this.known.clear();
    if (w.infinite) {
      const liveEnemies = new Set(w.jets.filter((j) => j.alive && j.side !== side).map((j) => j.id));
      for (const id of this.lastSeen.keys()) if (!liveEnemies.has(id)) this.lastSeen.delete(id);
      for (const id of this.lastTrack.keys()) if (!liveEnemies.has(id)) this.lastTrack.delete(id);
    }
    const mine = w.jets.filter((j) => j.side === side && j.alive);
    const detectRange = Math.max(w.params.radar.detectRangeNm, w.params.radar.rangeNm);
    for (const e of w.jets) {
      if (e.side === side) continue;
      if (!e.alive) {
        this.lastSeen.delete(e.id);
        continue;
      }
      if (mine.some((j) => radarCanDetect(w, j, e))) {
        this.known.add(e.id);
        this.lastSeen.set(e.id, { x: e.pos.x, y: e.pos.y, z: e.pos.z, hdg: e.hdg, t: w.t });
      } else {
        const g = this.lastSeen.get(e.id);
        if (g && w.t - g.t >= 0.5) {
          const seenPos = { x: g.x, y: g.y, z: g.z };
          const scannedEmpty = mine.some(
            (j) => radarCoversPos(w, j, seenPos, detectRange * 0.95) && !radarBroken(w, j, e),
          );
          if (scannedEmpty) this.lastSeen.delete(e.id);
        }
      }
      if (mine.some((j) => radarCanTrack(w, j, e)))
        this.lastTrack.set(e.id, { pos: { ...e.pos }, vel: velocity(e), t: w.t });
    }
  }

  /**
   * Keeps the onboard estimate of each of this side's missiles: a copy of the missile model flown
   * against the side's own track of the target. The real missile is only read once, at launch.
   */
  updateTimers(w: World, dt: number): void {
    if (w.missiles.length === 0 && this.timers.size === 0) return;
    let newlyAdded: Set<string> | null = null;
    for (const m of w.missiles) {
      if (m.side === this.side && !this.timers.has(m.id)) {
        this.timers.set(m.id, startTimer(m, w.t));
        if (!newlyAdded) newlyAdded = new Set();
        newlyAdded.add(m.id);
      }
    }
    for (const tm of this.timers.values()) {
      const shooter = jetById(w, tm.shooterId);
      const target = jetById(w, tm.targetId);
      const datalink = !!shooter && !!target && radarCanTrack(w, shooter, target);
      const track = this.lastTrack.get(tm.targetId);
      const known = datalink && target ? truthOf(target) : track ? trackAt(track, w.t) : null;
      const stepDt = newlyAdded?.has(tm.missileId) ? 0 : dt;
      if (known) stepTimer(w.params.missile, tm, known, datalink, w.t, stepDt);
    }
    if (w.infinite && this.timers.size > 0) {
      let liveMissiles: Set<string> | null = null;
      for (const [id, tm] of this.timers) {
        if (!timerActive(w, tm)) {
          this.timers.delete(id);
          continue;
        }
        if (!jetById(w, tm.targetId)) {
          if (w.missiles.length === 0) {
            this.timers.delete(id);
            continue;
          }
          if (!liveMissiles) {
            liveMissiles = new Set();
            for (const m of w.missiles) if (!m.end) liveMissiles.add(m.id);
          }
          if (!liveMissiles.has(tm.missileId)) this.timers.delete(id);
        }
      }
    }
  }

  /** Timers still worth showing: until a little after the predicted impact, or the missile is spent. */
  activeTimers(w: World): MissileTimer[] {
    return [...this.timers.values()].filter((tm) => timerActive(w, tm));
  }

  /**
   * Best known position of an alive enemy jet: live position when visible (or without fog), else
   * the extrapolated last track or last-seen position (null if cleared or never seen).
   */
  knownEnemyPos(w: World, enemyId: string, fog: boolean): V3 | null {
    const e = jetById(w, enemyId);
    if (!e?.alive || e.side === this.side) return null;
    if (!fog || this.known.has(enemyId)) return { ...e.pos };
    const g = this.lastSeen.get(enemyId);
    if (!g) return null;
    const tr = this.lastTrack.get(enemyId);
    return tr ? trackAt(tr, w.t).pos : { x: g.x, y: g.y, z: g.z };
  }

  /** Whether this side may see the jet (or its decoys) right now. */
  sees(w: World, jetId: string, fog: boolean): boolean {
    if (!fog) return true;
    const j = jetById(w, jetId);
    return !j || j.side === this.side || !j.alive || this.known.has(jetId);
  }

  /** Whether this side may see the event in its log. */
  showsEvent(w: World, e: GameEvent, fog: boolean): boolean {
    if (!fog || e.type === "end") return true;
    if (e.side === this.side) return !MISSILE_INTERNAL.has(e.type);
    // Hits on your own jets are obvious; the rest of the enemy's side is hidden.
    return (e.type === "kill" || e.type === "survived-hit") && jetById(w, e.targetId)?.side === this.side;
  }
}

export function timerActive(w: World, tm: MissileTimer): boolean {
  if (tm.impactAt !== null) return w.t < tm.impactAt + TIMER_LINGER_S;
  return !tm.ghost.end && tm.ghost.phase !== "lost" && w.t - tm.launchT < w.params.missile.maxTofS;
}

export function timerView(tm: MissileTimer): TimerView {
  return {
    missileId: tm.missileId,
    shooterId: tm.shooterId,
    targetId: tm.targetId,
    launchT: tm.launchT,
    pitbullAt: tm.pitbullAt,
    impactAt: tm.impactAt,
    firstImpactAt: tm.firstImpactAt,
    pitbull: tm.ghost.pitbull,
  };
}
