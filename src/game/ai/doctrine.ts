/**
 * NPC pilot flying simple BVR doctrine from its own side's picture only:
 *  - contacts: enemy jets its own radar or a wingman's radar detects (a shared picture, like a
 *    datalink), remembered as tracks and dead-reckoned when lost;
 *  - its RWR: radar scans and active missiles, as bearings only (no launch warning, as for you);
 *  - its own shots: the same onboard TTP / TTI timers the player has, never the real missile.
 *
 * States, in priority order:
 *   DEFEND   an active missile shows on the RWR (after a reaction delay): turn cold from it, AB, max g
 *   PUMP     after its own missile went active: turn cold from the target for a while, then re-commit
 *   EGRESS   no missiles left and none of its own in flight: turn cold and leave
 *   SUPPORT  its own missile is still before pitbull: crank to keep the target inside the radar gimbal
 *   COMMIT   fly at the target and shoot when locked and inside a fraction of Rmax
 */
import { type Jet, type Steer, velocity } from "../sim/aircraft.ts";
import { DEG, NM } from "../sim/atmosphere.ts";
import { type MissileTimer, startTimer, stepTimer, type TargetTrack, trackAt } from "../sim/estimate.ts";
import { len, sub, wrap2Pi } from "../sim/vec.ts";
import { launchZone } from "../sim/wez.ts";
import {
  type Command,
  type Controller,
  jetById,
  radarCanDetect,
  radarCanTrack,
  rwrContacts,
  type World,
} from "../sim/world.ts";

export interface AiSkill {
  label: string;
  /** Seconds between an active missile showing on the RWR and the pilot reacting to it. */
  reactionS: number;
  /** First shot at Rne + this fraction of (Rmax − Rne); later shots closer (see shotRangeNm). */
  shotFrac: number;
  /** Off-nose angle while supporting a missile (keep it under the 60° radar gimbal). */
  crankDeg: number;
  /** Turns cold after its own missile goes active, to stay out of the enemy's missile. */
  pumpAfterPitbull: boolean;
  /** How long a pump lasts (s). */
  pumpS: number;
  /** Keeps defending this long (s) after the missile leaves the RWR. */
  defendHoldS: number;
  /**
   * Defends against one missile for at most this long (s), then judges it beaten and turns back in.
   * The RWR cannot tell how much energy a missile has left, so this can be wrong.
   */
  defendForS: number;
}

export type AiSkillId = "easy" | "normal" | "hard";

export const AI_SKILLS: Record<AiSkillId, AiSkill> = {
  easy: {
    label: "Easy",
    reactionS: 6,
    shotFrac: 0.9,
    crankDeg: 30,
    pumpAfterPitbull: false,
    pumpS: 0,
    defendHoldS: 3,
    defendForS: 15,
  },
  normal: {
    label: "Normal",
    reactionS: 3,
    shotFrac: 0.75,
    crankDeg: 50,
    pumpAfterPitbull: true,
    pumpS: 15,
    defendHoldS: 6,
    defendForS: 25,
  },
  hard: {
    label: "Hard",
    reactionS: 1,
    shotFrac: 0.65,
    crankDeg: 55,
    pumpAfterPitbull: true,
    pumpS: 20,
    defendHoldS: 8,
    defendForS: 35,
  },
};

export const AI_SKILL_ORDER: AiSkillId[] = ["easy", "normal", "hard"];

/** Each missile already used moves the next shot this much closer (fraction of the Rne..Rmax span). */
const SHOT_CLOSER_PER_MISSILE = 0.35;
/** How often (s) the NPC re-estimates its Rmax against its target (the flyouts cost a few ms). */
const ZONE_EVERY_S = 2;
/** A dead-reckoned track that should be inside our radar coverage but is not seen is dropped. */
const STALE_TRACK_S = 4;
/** Re-steer only when the wanted heading moved this much (avoids a command every step). */
const STEER_EPS = 2 * DEG;

export type AiState = "commit" | "support" | "pump" | "defend" | "egress";

export class DoctrineBot implements Controller {
  readonly skill: AiSkill;
  state: AiState = "commit";
  private readonly tracks = new Map<string, TargetTrack>();
  private readonly timers = new Map<string, MissileTimer>();
  private readonly rwrFirstSeen = new Map<string, number>();
  private readonly pumpedFor = new Set<string>();
  private pumpUntil = Number.NEGATIVE_INFINITY;
  private defendUntil = Number.NEGATIVE_INFINITY;
  private defendFrom: string | null = null;
  private lastT: number | null = null;
  private zoneAt = Number.NEGATIVE_INFINITY;
  private zoneFor: string | null = null;
  private rmaxNm = 0;
  private rneNm = 0;
  /** Crank direction: wingmen crank opposite ways. */
  private readonly crankDir: 1 | -1;
  /** This pilot's own spread around the skill (set on the first update from the world's seed). */
  private shotScale = 1;
  private reactionScale = 1;
  private initialMissiles: number | null = null;

  constructor(skill: AiSkill, crankDir: 1 | -1 = 1) {
    this.skill = skill;
    this.crankDir = crankDir;
  }

  update(w: World, me: Jet): Command[] {
    const dt = this.lastT === null ? 0 : w.t - this.lastT;
    if (this.initialMissiles === null) {
      // Two pilots of the same skill should not be mirror images: ±15% shot range, ±30% reaction.
      this.initialMissiles = me.missiles;
      this.shotScale = 0.85 + 0.3 * w.rng();
      this.reactionScale = 0.7 + 0.6 * w.rng();
    }
    this.lastT = w.t;
    this.updateTracks(w, me);
    this.updateTimers(w, me, dt);

    const out: Command[] = [];
    const s = this.skill;
    const t = w.t;

    // RWR: active missiles, with a reaction delay from when each first showed.
    const missiles = rwrContacts(w, me).filter((c) => c.kind === "missile");
    for (const c of missiles) if (!this.rwrFirstSeen.has(c.sourceId)) this.rwrFirstSeen.set(c.sourceId, t);
    const reactionS = s.reactionS * this.reactionScale;
    const reacted = missiles.filter((c) => {
      const age = t - (this.rwrFirstSeen.get(c.sourceId) ?? t);
      return age >= reactionS && age < reactionS + s.defendForS;
    });
    if (reacted.length > 0) {
      const locked = reacted.find((c) => c.lock) ?? reacted[0];
      this.defendFrom = locked?.sourceId ?? null;
      this.defendUntil = t + s.defendHoldS;
    }

    const target = this.chooseTarget(w, me);
    const myInFlight = [...this.timers.values()].filter((tm) => this.timerActive(tm, t));

    if (t < this.defendUntil && this.defendFrom) {
      this.state = "defend";
      out.push(...this.fly(me, "ab", "max"));
      // Cold from the missile: the RWR gives its bearing, which is all a heading needs.
      out.push(...this.steerRelativeMissile(me, this.defendFrom, 180, "defending"));
      return out;
    }

    // Pump once per missile after it went active (if this skill does), then re-commit.
    if (s.pumpAfterPitbull)
      for (const tm of myInFlight)
        if (tm.pitbullAt !== null && t >= tm.pitbullAt && !this.pumpedFor.has(tm.missileId)) {
          this.pumpedFor.add(tm.missileId);
          this.pumpUntil = Math.max(this.pumpUntil, t + s.pumpS);
        }
    if (t < this.pumpUntil && target) {
      this.state = "pump";
      out.push(...this.fly(me, "ab", "normal"));
      out.push(...this.steerVsTrack(me, target, 180, 1));
      return out;
    }

    if (me.missiles === 0 && myInFlight.length === 0) {
      this.state = "egress";
      out.push(...this.fly(me, "mil", "normal"));
      if (target) out.push(...this.steerVsTrack(me, target, 180, 1));
      return out;
    }

    out.push(...this.fly(me, "mil", "normal"));
    if (!target) {
      this.state = "commit";
      return out; // nothing known: hold heading until something shows up
    }
    if (me.targetId !== target) out.push({ type: "target", jetId: me.id, targetId: target });

    const supporting = myInFlight.filter(
      (tm) => tm.targetId === target && (tm.pitbullAt === null || t < tm.pitbullAt),
    );
    if (supporting.length > 0) {
      this.state = "support";
      out.push(...this.steerVsTrack(me, target, s.crankDeg, this.crankDir));
      return out;
    }

    this.state = "commit";
    out.push(...this.steerVsTrack(me, target, 0, 1));
    const enemy = jetById(w, target);
    const onTarget = myInFlight.some((tm) => tm.targetId === target);
    if (enemy && me.missiles > 0 && !onTarget && radarCanTrack(w, me, enemy)) {
      if (this.zoneFor !== target || t - this.zoneAt >= ZONE_EVERY_S) {
        this.zoneAt = t;
        this.zoneFor = target;
        const zone = launchZone(w.params.missile, me, enemy);
        this.rmaxNm = zone.rmaxNm;
        this.rneNm = zone.rneNm;
      }
      const rangeNm = len(sub(enemy.pos, me.pos)) / NM;
      if (this.rmaxNm > 0 && rangeNm <= this.shotRangeNm(me))
        out.push({ type: "fire", jetId: me.id, targetId: target });
    }
    return out;
  }

  /** Current state, for display. */
  describe(): string {
    return this.state;
  }

  /**
   * Range to shoot at: between Rne and Rmax, and closer with every missile already used. The first
   * shot is long (it forces the enemy defensive); later ones get toward the no-escape range.
   */
  private shotRangeNm(me: Jet): number {
    const used = Math.max(0, (this.initialMissiles ?? me.missiles) - me.missiles);
    const frac = Math.min(1, this.skill.shotFrac * this.shotScale) * SHOT_CLOSER_PER_MISSILE ** used;
    const rne = Math.min(this.rneNm, this.rmaxNm);
    return rne + frac * (this.rmaxNm - rne);
  }

  /** Known enemies: detected by our side's radars now, else dead-reckoned from the last detection. */
  private updateTracks(w: World, me: Jet): void {
    const friends = w.jets.filter((j) => j.side === me.side && j.alive);
    for (const e of w.jets) {
      if (e.side === me.side) continue;
      if (e.alive && friends.some((f) => radarCanDetect(w, f, e))) {
        this.tracks.set(e.id, { pos: { ...e.pos }, vel: velocity(e), t: w.t });
        continue;
      }
      const tr = this.tracks.get(e.id);
      if (!tr || w.t - tr.t < STALE_TRACK_S) continue;
      // Should be in our radar coverage by now and is not seen: gone (dead, or we lost it for good).
      const guess = trackAt(tr, w.t).pos;
      const covered = friends.some((f) => {
        const d = len(sub(guess, f.pos)) / NM;
        const off = Math.abs(
          ((Math.atan2(guess.x - f.pos.x, guess.y - f.pos.y) - f.hdg + 3 * Math.PI) % (2 * Math.PI)) -
            Math.PI,
        );
        return d < w.params.radar.detectRangeNm * 0.9 && off < w.params.radar.gimbalDeg * DEG * 0.9;
      });
      if (covered) this.tracks.delete(e.id);
    }
  }

  private updateTimers(w: World, me: Jet, dt: number): void {
    for (const m of w.missiles)
      if (m.shooterId === me.id && !this.timers.has(m.id)) this.timers.set(m.id, startTimer(m, w.t));
    for (const tm of this.timers.values()) {
      const enemy = jetById(w, tm.targetId);
      const datalink = !!enemy && radarCanTrack(w, me, enemy);
      const tr = this.tracks.get(tm.targetId);
      const known =
        datalink && enemy
          ? { pos: { ...enemy.pos }, vel: velocity(enemy), alive: true }
          : tr
            ? trackAt(tr, w.t)
            : null;
      if (known && dt > 0) stepTimer(w.params.missile, tm, known, datalink, w.t, dt);
    }
  }

  private timerActive(tm: MissileTimer, t: number): boolean {
    if (tm.impactAt !== null) return t < tm.impactAt + 2;
    return !tm.ghost.end && tm.ghost.phase !== "lost";
  }

  /** Nearest known enemy, preferring one a wingman is not already targeting. */
  private chooseTarget(w: World, me: Jet): string | null {
    const taken = new Set(
      w.jets.filter((j) => j.side === me.side && j.alive && j.id !== me.id).map((j) => j.targetId),
    );
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [id, tr] of this.tracks) {
      const p = trackAt(tr, w.t).pos;
      const score = len(sub(p, me.pos)) + (taken.has(id) ? 30 * NM : 0);
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  private fly(me: Jet, throttle: Jet["throttle"], effort: Jet["effort"]): Command[] {
    const out: Command[] = [];
    if (me.throttle !== throttle) out.push({ type: "throttle", jetId: me.id, throttle });
    if (me.effort !== effort) out.push({ type: "effort", jetId: me.id, effort });
    return out;
  }

  /** Steer relative to where our track says the target is (never its true position). */
  private steerVsTrack(me: Jet, targetId: string, offsetDeg: number, dir: 1 | -1): Command[] {
    const tr = this.tracks.get(targetId);
    if (!tr) return [];
    const p = trackAt(tr, this.lastT ?? tr.t).pos;
    const hdg = wrap2Pi(Math.atan2(p.x - me.pos.x, p.y - me.pos.y) + dir * offsetDeg * DEG);
    return this.setHeading(me, hdg);
  }

  private setHeading(me: Jet, hdg: number): Command[] {
    const cur = me.steer.mode === "heading" ? me.steer.hdg : Number.NaN;
    const diff = Math.abs(((hdg - cur + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    if (Number.isFinite(cur) && diff < STEER_EPS) return [];
    const steer: Steer = { mode: "heading", hdg };
    return [{ type: "steer", jetId: me.id, steer }];
  }

  /** Relative to a missile the RWR shows: its bearing is known, which is all a heading needs. */
  private steerRelativeMissile(me: Jet, missileId: string, offsetDeg: number, label: string): Command[] {
    const s = me.steer;
    if (s.mode === "relative" && s.threatId === missileId && s.offsetDeg === offsetDeg) return [];
    return [
      {
        type: "steer",
        jetId: me.id,
        steer: { mode: "relative", threatId: missileId, offsetDeg, dir: 1, label },
      },
    ];
  }
}
