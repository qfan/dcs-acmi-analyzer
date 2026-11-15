/**
 * The UI's picture of the fight: a mirror world rebuilt from engine snapshots, the viewer's side's
 * knowledge, and purely local state (selection, trails, launch zone, the .acmi recording). Drawing
 * and readouts read this; orders go back to the engine.
 */
import { AcmiRecorder } from "../acmi.ts";
import type { MatchMeta } from "../engine/protocol.ts";
import { applySnapshot, makeMirror, type NpcView, type Snapshot } from "../engine/snapshot.ts";
import type { Jet, Side } from "../sim/aircraft.ts";
import { type LastSeen, SideKnowledge, type TimerView } from "../sim/knowledge.ts";
import type { V3 } from "../sim/vec.ts";
import { type LaunchZone, launchZone } from "../sim/wez.ts";
import { type GameEvent, jetById, type World } from "../sim/world.ts";

const TRAIL_EVERY_S = 1;
const JET_TRAIL_S = 120;
const ZONE_EVERY_MS = 700;

export interface TrailPoint {
  x: number;
  y: number;
}

export class SessionView {
  meta: MatchMeta;
  readonly world: World;
  readonly side: Side;
  readonly owned: Set<string>;
  readonly scenarioId: string;
  readonly altFt: number;
  readonly startedAt: Date;
  readonly watch: boolean;
  paused = false;
  pauseReason: string | null = null;
  timeScale = 1;
  /** Fog of war as this viewer sees the map (single player: the toggle; multiplayer: room rule or own choice). */
  fog: boolean;
  readonly know: SideKnowledge;
  timers: TimerView[] = [];
  npc: Record<string, NpcView> = {};
  selected = new Set<string>();
  trails = new Map<string, TrailPoint[]>();
  zone: { jetId: string; targetId: string; zone: LaunchZone; at: number; simT: number } | null = null;
  readonly recorder: AcmiRecorder | null;
  private nextTrailAt = 0;

  constructor(meta: MatchMeta, first: Snapshot, fog: boolean) {
    this.meta = meta;
    this.world = makeMirror(meta.shape);
    this.side = meta.side;
    this.owned = new Set(meta.owned);
    this.scenarioId = meta.scenarioId;
    this.altFt = meta.altFt;
    this.startedAt = new Date(meta.startedAt);
    this.watch = meta.watch;
    this.fog = meta.roomFog ? true : fog;
    this.know = new SideKnowledge(meta.side);
    this.recorder = meta.noRecord
      ? null
      : new AcmiRecorder({
          title: `BVR Trainer: ${meta.title}, ${meta.altFt.toLocaleString("en-US")} ft`,
          startedAt: this.startedAt,
        });
    this.apply(first);
    const mine =
      this.world.jets.find((j) => this.owned.has(j.id)) ?? (this.watch ? this.world.jets[0] : undefined);
    if (mine) this.selected.add(mine.id);
  }

  get multiplayer(): boolean {
    return this.meta.mode !== "sp";
  }

  /** Applies a snapshot; returns the events new to this view. */
  apply(snap: Snapshot): GameEvent[] {
    const fresh = applySnapshot(this.world, snap);
    this.paused = snap.paused;
    this.pauseReason = snap.pauseReason;
    this.timeScale = snap.timeScale;
    this.npc = snap.npc;
    const k = snap.know[this.side];
    if (k) {
      this.know.known = new Set(k.known);
      this.know.lastSeen = new Map(k.lastSeen);
      this.know.lastTrack = new Map(k.lastTrack);
      this.timers = k.timers;
    }
    if (snap.full) this.nextTrailAt = 0;
    if (this.world.t >= this.nextTrailAt) this.recordTrails();
    this.recorder?.update(this.world);
    if (this.watch && !this.primary()) {
      this.selected.clear();
      const fallback =
        this.world.jets.find((j) => j.alive && j.side === this.side) ?? this.world.jets.find((j) => j.alive);
      if (fallback) this.selected.add(fallback.id);
    }
    return fresh;
  }

  get known(): Set<string> {
    return this.know.known;
  }

  get lastSeen(): Map<string, LastSeen> {
    return this.know.lastSeen;
  }

  ownsJet(id: string): boolean {
    return this.owned.has(id);
  }

  private recordTrails(): void {
    const w = this.world;
    this.nextTrailAt = w.t + TRAIL_EVERY_S;
    const maxJet = Math.ceil(JET_TRAIL_S / TRAIL_EVERY_S);
    for (const j of w.jets) {
      if (!j.alive) continue;
      const tr = this.trails.get(j.id) ?? [];
      tr.push({ x: j.pos.x, y: j.pos.y });
      if (tr.length > maxJet) tr.splice(0, tr.length - maxJet);
      this.trails.set(j.id, tr);
    }
    for (const m of w.missiles) {
      if (m.end) continue;
      const tr = this.trails.get(m.id) ?? [];
      tr.push({ x: m.pos.x, y: m.pos.y });
      if (w.infinite && tr.length > maxJet) tr.splice(0, tr.length - maxJet);
      this.trails.set(m.id, tr);
    }
    if (w.infinite) {
      const liveIds = new Set<string>();
      for (const j of w.jets) if (j.alive) liveIds.add(j.id);
      for (const m of w.missiles) if (!m.end) liveIds.add(m.id);
      for (const id of this.trails.keys()) if (!liveIds.has(id)) this.trails.delete(id);
    }
  }

  /** Best known position of an alive enemy jet for this viewer's steering and targeting. */
  knownEnemyPos(enemyId: string): V3 | null {
    return this.know.knownEnemyPos(this.world, enemyId, this.fog);
  }

  activeTimers(): TimerView[] {
    return this.timers;
  }

  /** Whether this viewer may see the jet (or its decoys) right now. */
  sees(jetId: string): boolean {
    return this.know.sees(this.world, jetId, this.fog);
  }

  /** Whether this viewer may see the event in the log. */
  showsEvent(e: GameEvent): boolean {
    return this.know.showsEvent(this.world, e, this.fog);
  }

  /** The first selected jet that is alive. */
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
