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
import { type Rng, randNormal } from "../sim/rng.ts";
import { angleBetween, bearing, len, sub, wrap2Pi, wrapPi } from "../sim/vec.ts";
import { headOnRmaxNm, launchZone } from "../sim/wez.ts";
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
  /** Fires a posture shot near head-on Rmax when carrying plenty of missiles (even if the enemy cranks). */
  postureShot: boolean;
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
    postureShot: false,
  },
  normal: {
    label: "Normal",
    reactionS: 3,
    shotFrac: 0.75,
    crankDeg: 50,
    pumpAfterPitbull: true,
    pumpS: 15,
    defendHoldS: 6,
    postureShot: false,
  },
  hard: {
    label: "Hard",
    reactionS: 1,
    shotFrac: 0.65,
    crankDeg: 55,
    pumpAfterPitbull: true,
    pumpS: 20,
    defendHoldS: 8,
    postureShot: true,
  },
};

export const AI_SKILL_ORDER: AiSkillId[] = ["easy", "normal", "hard"];
export type AiSkillChoice = AiSkillId | "random";
export const AI_SKILL_CHOICES: readonly AiSkillChoice[] = [...AI_SKILL_ORDER, "random"];
export const skillChoiceLabel = (c: AiSkillChoice): string =>
  c === "random" ? "Random" : AI_SKILLS[c].label;

/** Each missile already used moves the next shot this much closer (fraction of the Rne..Rmax span). */
const SHOT_CLOSER_PER_MISSILE = 0.35;
/** How often (s) the NPC re-estimates its Rmax against its target (the flyouts cost a few ms). */
const ZONE_EVERY_S = 2;
/** Minimum missiles remaining to keep firing posture shots regardless of initial load. */
const POSTURE_MISSILES_MIN = 8;
/** Only fire a posture shot when the target is not already cold/running away (aspect <= 95 deg). */
const POSTURE_MAX_ASPECT_RAD = 95 * DEG;
/** Treat an enemy still facing within crank angles (<= 70 deg) as head-on-capable so cranks don't lock out follow-ups. */
const CRANK_ASPECT_RAD = 70 * DEG;
/** Fraction of Rne..Rmax span for the final missile so engagements resolve cleanly inside WEZ. */
const LAST_MISSILE_FRAC = 0.03;
/** A dead-reckoned track that should be inside our radar coverage but is not seen is dropped. */
const STALE_TRACK_S = 4;
/** Re-steer only when the wanted heading moved this much (avoids a command every step). */
const STEER_EPS = 2 * DEG;
/** Existing nose-to-threat offset above which turns keep that side instead of randomizing left/right. */
const OFFSET_DECISION_RAD = 12 * DEG;
/** Intermediate cold-turn offset (< 180°) while rotating past beam so head-on breaks actually go left or right. */
const COLD_COMMIT_OFFSET_DEG = 160;
const COLD_PAST_BEAM_RAD = 120 * DEG;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function sampleScale(rng: Rng, sigma: number, cap = 2): number {
  return 1 + sigma * randNormal(rng, cap);
}

export type AiState = "commit" | "support" | "pump" | "defend" | "egress";

export interface NpcStatus {
  skill: string;
  state: AiState;
  detail: string;
}

export class DoctrineBot implements Controller {
  readonly skill: AiSkill;
  state: AiState = "commit";
  private actionDetail = "Ready — committing hot";
  private readonly tracks = new Map<string, TargetTrack>();
  private readonly timers = new Map<string, MissileTimer>();
  private readonly rwrFirstSeen = new Map<string, number>();
  private readonly rwrReactionS = new Map<string, number>();
  private readonly pumpedFor = new Set<string>();
  private pumpUntil = Number.NEGATIVE_INFINITY;
  private defendUntil = Number.NEGATIVE_INFINITY;
  private defendFrom: string | null = null;
  private defendDir: 1 | -1 | null = null;
  private defendHoldS = 0;
  private pumpDir: 1 | -1 | null = null;
  private egressDir: 1 | -1 | null = null;
  private lastT: number | null = null;
  private zoneAt = Number.NEGATIVE_INFINITY;
  private zoneFor: string | null = null;
  private rmaxNm = 0;
  private rneNm = 0;
  private headOnRmaxNm = 0;
  /** Optional initial formation crank bias (wingmen split opposite ways on first merge). */
  private preferredCrankDir: 1 | -1 | null;
  private crankDir: 1 | -1 = 1;
  private supportTarget: string | null = null;
  /** This pilot's own spread around the skill (set on the first update from the world's seed). */
  private shotScale = 1;
  private postureScale = 1;
  private reactionScale = 1;
  private initialMissiles: number | null = null;
  private postureShotsFired = 0;

  constructor(skill: AiSkill, preferredCrankDir: 1 | -1 | null = null) {
    this.skill = skill;
    this.preferredCrankDir = preferredCrankDir;
  }

  update(w: World, me: Jet): Command[] {
    const dt = this.lastT === null ? 0 : w.t - this.lastT;
    if (this.initialMissiles === null) {
      // Capped normal spread around the skill so mirrored pilots diverge without leaving their tier.
      this.initialMissiles = me.missiles;
      this.shotScale = clamp(sampleScale(w.rng, 0.075), 0.85, 1.15);
      this.postureScale = clamp(sampleScale(w.rng, 0.03), 0.94, 1.06);
      this.reactionScale = clamp(sampleScale(w.rng, 0.12), 0.76, 1.24);
    }
    this.lastT = w.t;
    this.updateTracks(w, me);
    this.updateTimers(w, me, dt);

    const out: Command[] = [];
    const s = this.skill;
    const t = w.t;

    // RWR: keep defending for as long as any active missile remains on RWR (after a capped normal reaction delay).
    const missiles = rwrContacts(w, me).filter((c) => c.kind === "missile");
    const liveMissileIds = new Set(w.missiles.filter((m) => !m.end).map((m) => m.id));
    for (const id of this.rwrFirstSeen.keys()) {
      if (!liveMissileIds.has(id)) {
        this.rwrFirstSeen.delete(id);
        this.rwrReactionS.delete(id);
      }
    }
    for (const c of missiles) {
      if (!this.rwrFirstSeen.has(c.sourceId)) {
        this.rwrFirstSeen.set(c.sourceId, t);
        const raw = s.reactionS * this.reactionScale * sampleScale(w.rng, 0.09);
        const delay = s.reactionS <= 0 ? 0 : clamp(raw, Math.max(0.2, s.reactionS * 0.7), s.reactionS * 1.3);
        this.rwrReactionS.set(c.sourceId, delay);
      }
    }
    const reacted = missiles.filter((c) => {
      const seenAt = this.rwrFirstSeen.get(c.sourceId) ?? t;
      const delay = this.rwrReactionS.get(c.sourceId) ?? s.reactionS;
      return t - seenAt >= delay;
    });
    const threat = reacted.find((c) => c.lock) ?? reacted[0];
    if (threat) {
      if (this.state !== "defend" || this.defendFrom !== threat.sourceId) {
        this.defendDir = this.chooseSide(w, me, threat.bearing);
        this.defendHoldS = s.defendHoldS * clamp(sampleScale(w.rng, 0.1), 0.8, 1.2);
      }
      this.defendFrom = threat.sourceId;
      this.defendUntil = t + this.defendHoldS;
    }

    const target = this.chooseTarget(w, me);
    const myInFlight = [...this.timers.values()].filter((tm) => this.timerActive(tm, t));

    if (t < this.defendUntil && this.defendFrom) {
      this.state = "defend";
      out.push(...this.fly(me, "ab", "max"));
      const rwrThreat = missiles.find((c) => c.sourceId === this.defendFrom);
      const offsetDeg = rwrThreat ? this.coldOffsetDeg(me, rwrThreat.bearing) : 180;
      this.actionDetail = rwrThreat
        ? `Turning cold from active missile (${rwrThreat.lock ? "locked" : "searching"})`
        : `Holding cold evasion (${Math.max(0, Math.ceil(this.defendUntil - t))} s left)`;
      // Cold from the missile: the RWR gives its bearing, which is all a heading needs.
      out.push(
        ...this.steerRelativeMissile(me, this.defendFrom, offsetDeg, this.defendDir ?? 1, "defending"),
      );
      return out;
    }
    this.defendFrom = null;
    this.defendDir = null;

    // Pump once per missile after it went active (if this skill does), then re-commit.
    if (s.pumpAfterPitbull)
      for (const tm of myInFlight)
        if (tm.pitbullAt !== null && t >= tm.pitbullAt && !this.pumpedFor.has(tm.missileId)) {
          this.pumpedFor.add(tm.missileId);
          const pumpDur = s.pumpS * clamp(sampleScale(w.rng, 0.1), 0.8, 1.2);
          this.pumpUntil = Math.max(this.pumpUntil, t + pumpDur);
        }
    if (t < this.pumpUntil && target) {
      const brg = this.trackBearing(me, target);
      if (this.state !== "pump") this.pumpDir = brg === null ? 1 : this.chooseSide(w, me, brg);
      this.state = "pump";
      this.actionDetail = `Pumping cold after pitbull (${Math.max(0, Math.ceil(this.pumpUntil - t))} s left)`;
      out.push(...this.fly(me, "ab", "normal"));
      const offsetDeg = brg === null ? 180 : this.coldOffsetDeg(me, brg);
      out.push(...this.steerVsTrack(me, target, offsetDeg, this.pumpDir ?? 1));
      return out;
    }
    this.pumpDir = null;

    if (me.missiles === 0 && myInFlight.length === 0) {
      const brg = target ? this.trackBearing(me, target) : null;
      if (this.state !== "egress") this.egressDir = brg === null ? 1 : this.chooseSide(w, me, brg);
      this.state = "egress";
      this.actionDetail = "Out of missiles — leaving cold";
      out.push(...this.fly(me, "mil", "normal"));
      if (target) {
        const offsetDeg = brg === null ? 180 : this.coldOffsetDeg(me, brg);
        out.push(...this.steerVsTrack(me, target, offsetDeg, this.egressDir ?? 1));
      }
      return out;
    }
    this.egressDir = null;

    out.push(...this.fly(me, "mil", "normal"));
    if (!target) {
      this.state = "commit";
      this.actionDetail = "Searching — no radar track";
      return out; // nothing known: hold heading until something shows up
    }
    if (me.targetId !== target) out.push({ type: "target", jetId: me.id, targetId: target });

    const supporting = myInFlight.filter(
      (tm) => tm.targetId === target && (tm.pitbullAt === null || t < tm.pitbullAt),
    );
    if (supporting.length > 0) {
      if (this.state !== "support" || this.supportTarget !== target) {
        const brg = this.trackBearing(me, target);
        this.crankDir =
          brg === null ? (this.preferredCrankDir ?? 1) : this.chooseSide(w, me, brg, this.preferredCrankDir);
        this.preferredCrankDir = null;
        this.supportTarget = target;
      }
      this.state = "support";
      this.actionDetail = `Cranking ${s.crankDeg}° ${this.crankDir > 0 ? "R" : "L"} — supporting ${supporting[0]?.missileId ?? "missile"} to pitbull`;
      out.push(...this.steerVsTrack(me, target, s.crankDeg, this.crankDir));
      return out;
    }
    this.supportTarget = null;

    this.state = "commit";
    out.splice(0, out.length, ...this.fly(me, s.pumpAfterPitbull ? "ab" : "mil", "normal"));
    if (me.targetId !== target) out.push({ type: "target", jetId: me.id, targetId: target });
    out.push(...this.steerVsTrack(me, target, 0, 1));
    const enemy = jetById(w, target);
    // Don't hold fire for 120 s on an already-pitbull missile whose onboard TTI predicts a miss.
    const onTarget = myInFlight.some(
      (tm) => tm.targetId === target && (!tm.ghost.pitbull || tm.impactAt !== null),
    );
    if (enemy && me.missiles > 0 && !onTarget && radarCanTrack(w, me, enemy)) {
      if (this.zoneFor !== target || t - this.zoneAt >= ZONE_EVERY_S) {
        this.zoneAt = t;
        this.zoneFor = target;
        const zone = launchZone(w.params.missile, me, enemy);
        this.rmaxNm = zone.rmaxNm;
        this.rneNm = zone.rneNm;
        this.headOnRmaxNm = this.skill.postureShot ? headOnRmaxNm(w.params.missile, me, enemy) : 0;
      }
      const rangeNm = len(sub(enemy.pos, me.pos)) / NM;
      const normalRange = this.rmaxNm > 0 ? this.shotRangeNm(me, enemy) : 0;
      const postureActive = this.headOnRmaxNm > 0 && this.canPostureShot(me, enemy);
      const postureRange = postureActive ? this.headOnRmaxNm * this.postureScale : 0;
      const fireRangeNm = Math.max(normalRange, postureRange);
      const usingPosture = postureActive && postureRange > normalRange;
      if (fireRangeNm > 0 && rangeNm <= fireRangeNm) {
        if (usingPosture) this.postureShotsFired++;
        this.actionDetail = usingPosture
          ? `Firing posture shot at ${rangeNm.toFixed(1)} nm`
          : `Firing at ${rangeNm.toFixed(1)} nm`;
        out.push({ type: "fire", jetId: me.id, targetId: target });
      } else if (fireRangeNm > 0) {
        this.actionDetail = usingPosture
          ? `Closing to posture-shot range (${fireRangeNm.toFixed(1)} nm)`
          : `Closing to shot range (${fireRangeNm.toFixed(1)} nm)`;
      } else {
        this.actionDetail = "Closing hot — target outside WEZ";
      }
    } else if (me.missiles === 0) {
      this.actionDetail = "Waiting on active missile in flight";
    } else if (onTarget) {
      this.actionDetail = "Tracking active missile — holding next shot";
    } else {
      this.actionDetail = "Turning hot — acquiring TWS lock";
    }
    return out;
  }

  /** Current state, for display. */
  describe(): string {
    return this.state;
  }

  /** Structured behaviour state and action summary for read-only UI inspection. */
  status(): NpcStatus {
    return { skill: this.skill.label, state: this.state, detail: this.actionDetail };
  }

  private canPostureShot(me: Jet, enemy: Jet): boolean {
    if (!this.skill.postureShot || me.missiles <= 1) return false;
    const initial = this.initialMissiles ?? me.missiles;
    if (me.missiles < POSTURE_MISSILES_MIN && me.missiles < initial) return false;
    // Only posture-shot enemies that are hot/cranking/beaming, not already running away cold.
    return angleBetween(velocity(enemy), sub(me.pos, enemy.pos)) <= POSTURE_MAX_ASPECT_RAD;
  }

  /**
   * Range to shoot at: between Rne and Rmax, and closer with every non-posture missile used.
   * Opening posture shots don't prematurely shrink the combat timeline; the final missile holds
   * until near Rne so fights resolve cleanly instead of stalemating.
   */
  private shotRangeNm(me: Jet, enemy: Jet): number {
    const totalUsed = Math.max(0, (this.initialMissiles ?? me.missiles) - me.missiles);
    const combatUsed = Math.max(0, totalUsed - this.postureShotsFired);
    let frac = Math.min(1, this.skill.shotFrac * this.shotScale) * SHOT_CLOSER_PER_MISSILE ** combatUsed;
    if (me.missiles === 1) frac = Math.min(frac, LAST_MISSILE_FRAC);
    const aspect = angleBetween(velocity(enemy), sub(me.pos, enemy.pos));
    // Cranking keeps the enemy inside our threat envelope; don't let their temporary crank lock out follow-ups.
    const rmax =
      this.headOnRmaxNm > 0 && aspect <= CRANK_ASPECT_RAD
        ? Math.max(this.rmaxNm, this.headOnRmaxNm)
        : this.rmaxNm;
    const rne = Math.min(this.rneNm, rmax);
    return rne + frac * (rmax - rne);
  }

  /** Known enemies: detected by our side's radars now, else dead-reckoned from the last detection. */
  private updateTracks(w: World, me: Jet): void {
    for (const id of this.tracks.keys()) if (!jetById(w, id)?.alive) this.tracks.delete(id);
    const friends = w.jets.filter((j) => j.side === me.side && j.alive);
    for (const e of w.jets) {
      if (e.side === me.side) continue;
      if (!e.alive) {
        this.tracks.delete(e.id);
        continue;
      }
      if (friends.some((f) => radarCanDetect(w, f, e))) {
        this.tracks.set(e.id, { pos: { ...e.pos }, vel: velocity(e), t: w.t });
        continue;
      }
      const tr = this.tracks.get(e.id);
      if (!tr || w.t - tr.t < STALE_TRACK_S) continue;
      // Should be in our radar coverage by now and is not seen: lost it for good.
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
    const newlyAdded = new Set<string>();
    const liveIds = new Set<string>();
    for (const m of w.missiles) {
      if (m.end) continue;
      liveIds.add(m.id);
      if (m.shooterId === me.id && !this.timers.has(m.id)) {
        this.timers.set(m.id, startTimer(m, w.t));
        newlyAdded.add(m.id);
      }
    }
    for (const id of this.timers.keys()) {
      if (!liveIds.has(id)) {
        this.timers.delete(id);
        this.pumpedFor.delete(id);
      }
    }
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
      const stepDt = newlyAdded.has(tm.missileId) ? 0 : dt;
      if (known && (stepDt > 0 || newlyAdded.has(tm.missileId)))
        stepTimer(w.params.missile, tm, known, datalink, w.t, stepDt);
    }
  }

  private timerActive(tm: MissileTimer, t: number): boolean {
    if (tm.impactAt !== null) return t < tm.impactAt + 2;
    return !tm.ghost.end && tm.ghost.phase !== "lost";
  }

  /** Nearest known enemy, preferring one a wingman is not already targeting. */
  private chooseTarget(w: World, me: Jet): string | null {
    const taken = new Set(
      w.jets
        .filter((j) => j.side === me.side && j.alive && j.id !== me.id && jetById(w, j.targetId)?.alive)
        .map((j) => j.targetId),
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

  private chooseSide(w: World, me: Jet, threatBrg: number, preferred?: 1 | -1 | null): 1 | -1 {
    const rel = wrapPi(me.hdg - threatBrg);
    if (Math.abs(rel) > OFFSET_DECISION_RAD) return rel > 0 ? 1 : -1;
    if (preferred) return preferred;
    return w.rng() < 0.5 ? 1 : -1;
  }

  private coldOffsetDeg(me: Jet, threatBrg: number): number {
    return Math.abs(wrapPi(me.hdg - threatBrg)) < COLD_PAST_BEAM_RAD ? COLD_COMMIT_OFFSET_DEG : 180;
  }

  private trackBearing(me: Jet, targetId: string): number | null {
    const tr = this.tracks.get(targetId);
    if (!tr) return null;
    const p = trackAt(tr, this.lastT ?? tr.t).pos;
    return bearing(me.pos, p);
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
  private steerRelativeMissile(
    me: Jet,
    missileId: string,
    offsetDeg: number,
    dir: 1 | -1,
    label: string,
  ): Command[] {
    const s = me.steer;
    if (s.mode === "relative" && s.threatId === missileId && s.offsetDeg === offsetDeg && s.dir === dir)
      return [];
    return [
      {
        type: "steer",
        jetId: me.id,
        steer: { mode: "relative", threatId: missileId, offsetDeg, dir, label },
      },
    ];
  }
}
