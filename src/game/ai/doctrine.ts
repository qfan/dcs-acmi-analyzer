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
import { type Jet, mach, type Steer, velocity } from "../sim/aircraft.ts";
import { DEG, FT, NM } from "../sim/atmosphere.ts";
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
  /** Probability [0, 1] of defending an active missile with a notch instead of turning cold. */
  notchChance: number;
  /** Fires a posture shot near head-on Rmax when carrying plenty of missiles (even if the enemy cranks). */
  postureShot: boolean;
  /** Takes high-Pk opportunity shots at other TWS-tracked enemies in lethal range. */
  opportunityShot: boolean;
  /**
   * Altitude tactics. Off (null / 0) for every skill for now: in botmatch batches, climbing to
   * shoot from higher cost the NPC its speed and turn rate, and any defensive dive made missiles
   * miss so often that fights ran out the clock. Kept for tuning.
   *
   * commitAltFt: climbs (Hold Spd, so it keeps its speed) to at least this altitude while committing
   * and supporting. null holds the altitude it started at, returning to it after a dive.
   */
  commitAltFt: number | null;
  /** Dives this far (ft) when a defence starts ("cold and low": thick air drains the chasing missile). */
  defendDropFt: number;
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
    notchChance: 0.05,
    postureShot: false,
    opportunityShot: false,
    commitAltFt: null,
    defendDropFt: 0,
  },
  normal: {
    label: "Normal",
    reactionS: 3,
    shotFrac: 0.75,
    crankDeg: 50,
    pumpAfterPitbull: true,
    pumpS: 15,
    defendHoldS: 6,
    notchChance: 0.05,
    postureShot: false,
    opportunityShot: true,
    commitAltFt: null,
    defendDropFt: 0,
  },
  hard: {
    label: "Hard",
    reactionS: 1,
    shotFrac: 0.65,
    crankDeg: 55,
    pumpAfterPitbull: true,
    pumpS: 20,
    defendHoldS: 8,
    notchChance: 0.05,
    postureShot: true,
    opportunityShot: true,
    commitAltFt: null,
    defendDropFt: 0,
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
/** Probability that an eligible posture shot is taken (fire-and-forget). */
const POSTURE_CHANCE = 0.3;
/** Minimum missiles remaining to keep firing posture shots regardless of initial load. */
const POSTURE_MISSILES_MIN = 8;
/** Only fire a posture shot when the target is not already cold/running away (aspect <= 95 deg). */
const POSTURE_MAX_ASPECT_RAD = 95 * DEG;
/** Treat an enemy still facing within crank angles (<= 70 deg) as head-on-capable so cranks don't lock out follow-ups. */
const CRANK_ASPECT_RAD = 70 * DEG;
/** Uniform random range of final-missile Rne..Rmax fraction so endgames vary instead of mirroring. */
const LAST_MISSILE_FRAC_MIN = 0.03;
const LAST_MISSILE_FRAC_MAX = 0.2;
/** Max off-boresight angle for primary shots outside Rne / pitbull range. */
const PRIMARY_FIRE_MAX_OFF_RAD = 25 * DEG;
/** Hysteresis Mach thresholds for switching non-emergency turns to speed-preserving "sustain". */
const CONSERVE_ENTER_MACH = 0.82;
const CONSERVE_EXIT_MACH = 0.9;
/** Subsonic/transonic hysteresis for speed-preserving "sustain" cranks in SUPPORT; supersonic jets crank in MIL/normal instead. */
const SUPPORT_SUSTAIN_ENTER_MACH = 0.92;
const SUPPORT_SUSTAIN_EXIT_MACH = 0.96;
/** Fraction of Rne..Rmax span within which a secondary TWS target qualifies for an opportunity shot. */
const OPP_SHOT_FRAC = 0.45;
/** Deconfliction distance penalty per closer/peer friendly targeting the same enemy (m). */
const SORT_TAKEN_PENALTY_M = 18 * NM;
/** Peer proximity allowance so rear/respawned friendlies do not push frontline jets off closer targets. */
const SORT_PEER_MARGIN_M = 8 * NM;
/** Off-boresight penalty at full 60° gimbal edge so same-lane ahead bandits are preferred. */
const SORT_ANGLE_WEIGHT_M = 8 * NM;
/** Target hysteresis bonus for current target vs. a target with an active pre-pitbull missile. */
const SORT_KEEP_TARGET_M = 4 * NM;
const SORT_SUPPORT_BONUS_M = 22 * NM;
/** A dead-reckoned track that should be inside our radar coverage but is not seen is dropped. */
const STALE_TRACK_S = 4;
/** Re-steer only when the wanted heading moved this much (avoids a command every step). */
const STEER_EPS = 2 * DEG;
/** Existing nose-to-threat offset above which turns keep that side instead of randomizing left/right. */
const OFFSET_DECISION_RAD = 12 * DEG;
/** Intermediate cold-turn offset (< 180°) while rotating past beam so head-on breaks actually go left or right. */
const COLD_COMMIT_OFFSET_DEG = 160;
/** Sits between the 110° and 120° RWR bins so float rounding at 120° cannot toggle cold offsetDeg. */
const COLD_PAST_BEAM_RAD = 115 * DEG;
/** Brief hold (s) after leaving an unlocked missile's illumination cone (e.g. a missile chasing another jet). */
const UNLOCKED_ILLUM_HOLD_S = 0.5;
/** Altitude orders closer than this (m) to the current one are not re-issued. */
const ALT_EPS_M = 150;
/** Climbs only above this Mach; slower, it levels off to build speed first. */
const CLIMB_MIN_MACH = 0.85;
/** A defensive dive never goes below this (ft). */
const DEFEND_FLOOR_FT = 6000;
/** Below this Mach it dives UNLOAD_DROP_FT (not below UNLOAD_FLOOR_FT) to regain speed. */
const UNLOAD_MACH = 0.65;
const UNLOAD_DROP_FT = 6000;
const UNLOAD_FLOOR_FT = 12000;

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
  private readonly oppZones = new Map<string, { at: number; rmaxNm: number; rneNm: number }>();
  private readonly timers = new Map<string, MissileTimer>();
  private readonly rwrFirstSeen = new Map<string, number>();
  private readonly rwrReactionS = new Map<string, number>();
  private readonly pumpedFor = new Set<string>();
  private readonly postureMissileIds = new Set<string>();
  private pendingPostureTarget: string | null = null;
  private postureRolledForMissiles: number | null = null;
  private postureAllowed = false;
  private lastMissileFrac = LAST_MISSILE_FRAC_MIN;
  private conservingEnergy = false;
  private supportSustain = false;
  private pumpUntil = Number.NEGATIVE_INFINITY;
  private defendUntil = Number.NEGATIVE_INFINITY;
  private defendFrom: string | null = null;
  private defendDir: 1 | -1 | null = null;
  private defendHoldS = 0;
  private defendLocked = false;
  private defendTactic: "cold" | "notch" = "cold";
  private defendLastBearing: number | null = null;
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
  private startAltM: number | null = null;
  private defendAltM = 0;
  /** Altitude it is diving to for speed, while unloading. */
  private unloadAltM: number | null = null;

  constructor(skill: AiSkill, preferredCrankDir: 1 | -1 | null = null) {
    this.skill = skill;
    this.preferredCrankDir = preferredCrankDir;
  }

  update(w: World, me: Jet): Command[] {
    const before = this.state;
    if (this.startAltM === null) this.startAltM = me.pos.z;
    let out = this.decide(w, me);
    const alt = this.wantAltitude(me, before);
    if (alt !== null && Math.abs(alt - me.altCmd) > ALT_EPS_M)
      out.push({ type: "altitude", jetId: me.id, altM: alt });
    // Offensive climbs fly Hold Spd: they climb only on excess power, so the jet arrives high and
    // still fast instead of trading its speed (and its missiles' reach) for the height.
    const target = alt ?? me.altCmd;
    if ((this.state === "commit" || this.state === "support") && target - me.pos.z > ALT_EPS_M) {
      out = out.filter((c) => c.type !== "effort");
      if (me.effort !== "sustain") out.push({ type: "effort", jetId: me.id, effort: "sustain" });
    }
    return out;
  }

  /**
   * Altitude for the current state: climb while committing and supporting (only while fast enough,
   * so the climb never bleeds it slow), dive once when a defence starts, otherwise hold.
   */
  private wantAltitude(me: Jet, before: AiState): number | null {
    const s = this.skill;
    if (this.state === "defend") {
      if (before !== "defend")
        this.defendAltM = Math.max(DEFEND_FLOOR_FT * FT, me.pos.z - s.defendDropFt * FT);
      return s.defendDropFt > 0 ? this.defendAltM : null;
    }
    if (s.commitAltFt === null && s.defendDropFt <= 0) return null;
    // Slow and high, a turn in thin air can pin the jet near its minimum speed for minutes:
    // unload and dive to buy speed back, then climb again once fast.
    const m = mach(me);
    if (this.unloadAltM === null && m < UNLOAD_MACH && me.pos.z > UNLOAD_FLOOR_FT * FT + ALT_EPS_M)
      this.unloadAltM = Math.max(UNLOAD_FLOOR_FT * FT, me.pos.z - UNLOAD_DROP_FT * FT);
    else if (this.unloadAltM !== null && (m >= CLIMB_MIN_MACH || me.pos.z <= this.unloadAltM + ALT_EPS_M))
      this.unloadAltM = null;
    if (this.unloadAltM !== null) return this.unloadAltM;
    if (this.state !== "commit" && this.state !== "support") return null;
    const want = Math.max(this.startAltM ?? me.pos.z, (s.commitAltFt ?? 0) * FT);
    if (me.pos.z < want - ALT_EPS_M && mach(me) < CLIMB_MIN_MACH) {
      // Too slow to climb: level off and build speed first.
      return me.altCmd > me.pos.z ? me.pos.z : null;
    }
    return want;
  }

  private decide(w: World, me: Jet): Command[] {
    const dt = this.lastT === null ? 0 : w.t - this.lastT;
    if (this.initialMissiles === null) {
      // Capped normal spread around the skill so mirrored pilots diverge without leaving their tier.
      this.initialMissiles = me.missiles;
      this.shotScale = clamp(sampleScale(w.rng, 0.075), 0.85, 1.15);
      this.postureScale = clamp(sampleScale(w.rng, 0.03), 0.94, 1.06);
      this.reactionScale = clamp(sampleScale(w.rng, 0.12), 0.76, 1.24);
      this.lastMissileFrac =
        LAST_MISSILE_FRAC_MIN + w.rng() * (LAST_MISSILE_FRAC_MAX - LAST_MISSILE_FRAC_MIN);
    }
    this.lastT = w.t;
    this.updateTracks(w, me);
    this.updateTimers(w, me, dt);
    this.pendingPostureTarget = null;
    const curMach = mach(me);
    if (curMach < CONSERVE_ENTER_MACH) this.conservingEnergy = true;
    else if (curMach > CONSERVE_EXIT_MACH) this.conservingEnergy = false;
    if (curMach < SUPPORT_SUSTAIN_ENTER_MACH) this.supportSustain = true;
    else if (curMach > SUPPORT_SUSTAIN_EXIT_MACH) this.supportSustain = false;

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
      const sameThreat = this.state === "defend" && this.defendFrom === threat.sourceId;
      if (!sameThreat) {
        this.defendDir = this.chooseSide(w, me, threat.bearing);
        this.defendHoldS = s.defendHoldS * clamp(sampleScale(w.rng, 0.1), 0.8, 1.2);
        this.defendLocked = threat.lock;
        this.defendTactic = w.rng() < s.notchChance ? "notch" : "cold";
      } else if (threat.lock) {
        this.defendLocked = true;
      }
      this.defendFrom = threat.sourceId;
      this.defendLastBearing = threat.bearing;
      const holdS = this.defendLocked ? this.defendHoldS : Math.min(this.defendHoldS, UNLOCKED_ILLUM_HOLD_S);
      this.defendUntil = t + holdS;
    }

    const myInFlight = [...this.timers.values()].filter((tm) => this.timerActive(tm, t));
    const target = this.chooseTarget(w, me, myInFlight);

    if (t < this.defendUntil && this.defendFrom) {
      this.state = "defend";
      out.push(...this.fly(me, "ab", "max"));
      const rwrThreat = missiles.find((c) => c.sourceId === this.defendFrom);
      const dir = this.defendDir ?? 1;
      if (this.defendTactic === "notch") {
        if (rwrThreat) {
          this.actionDetail = `Notching active missile (${rwrThreat.lock ? "locked" : "searching"})`;
          if (me.steer.mode !== "notch" || me.steer.threatId !== this.defendFrom || me.steer.dir !== dir) {
            out.push({
              type: "steer",
              jetId: me.id,
              steer: {
                mode: "notch",
                threatId: this.defendFrom,
                dir,
                label: "notching",
                hdg: wrap2Pi(rwrThreat.bearing + dir * 90 * DEG),
                nextAlignAt: 0,
              },
            });
          }
        } else {
          this.actionDetail = `Holding notch evasion (${Math.max(0, Math.ceil(this.defendUntil - t))} s left)`;
          if (me.steer.mode !== "notch" && this.defendLastBearing !== null) {
            out.push(...this.setHeading(me, wrap2Pi(this.defendLastBearing + dir * 90 * DEG)));
          }
        }
      } else if (rwrThreat) {
        const offsetDeg = this.coldOffsetDeg(me, rwrThreat.bearing);
        this.actionDetail = `Turning cold from active missile (${rwrThreat.lock ? "locked" : "searching"})`;
        // Cold from the missile: the RWR gives its bearing, which is all a heading needs.
        out.push(...this.steerRelativeMissile(me, this.defendFrom, offsetDeg, dir, "defending"));
      } else {
        this.actionDetail = `Holding cold evasion (${Math.max(0, Math.ceil(this.defendUntil - t))} s left)`;
        const brg = this.defendLastBearing;
        const holdHdg = brg !== null ? wrap2Pi(brg + dir * this.coldOffsetDeg(me, brg) * DEG) : me.hdg;
        out.push(...this.setHeading(me, holdHdg));
      }
      return out;
    }
    this.defendFrom = null;
    this.defendDir = null;
    this.defendLocked = false;
    this.defendTactic = "cold";
    this.defendLastBearing = null;

    // Pump once per supported missile after it went active (posture shots are fire-and-forget).
    if (s.pumpAfterPitbull)
      for (const tm of myInFlight)
        if (
          !this.postureMissileIds.has(tm.missileId) &&
          tm.pitbullAt !== null &&
          t >= tm.pitbullAt &&
          !this.pumpedFor.has(tm.missileId)
        ) {
          this.pumpedFor.add(tm.missileId);
          const pumpDur = s.pumpS * clamp(sampleScale(w.rng, 0.1), 0.8, 1.2);
          this.pumpUntil = Math.max(this.pumpUntil, t + pumpDur);
        }
    if (t < this.pumpUntil && target) {
      const brg = this.trackBearing(me, target);
      if (this.state !== "pump") this.pumpDir = brg === null ? 1 : this.chooseSide(w, me, brg);
      this.state = "pump";
      this.actionDetail = `Pumping cold after pitbull (${Math.max(0, Math.ceil(this.pumpUntil - t))} s left)`;
      out.push(...this.flyCruise(me, "ab"));
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
      out.push(...this.flyCruise(me, "mil"));
      if (target) {
        const offsetDeg = brg === null ? 180 : this.coldOffsetDeg(me, brg);
        out.push(...this.steerVsTrack(me, target, offsetDeg, this.egressDir ?? 1));
      }
      return out;
    }
    this.egressDir = null;

    if (!target) {
      this.state = "commit";
      this.actionDetail = "Searching — no radar track";
      out.push(...this.flyCruise(me, "mil"));
      return out; // nothing known: hold heading until something shows up
    }

    const supporting = myInFlight.filter(
      (tm) =>
        !this.postureMissileIds.has(tm.missileId) &&
        tm.targetId === target &&
        (tm.pitbullAt === null || t < tm.pitbullAt),
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
      out.push(...this.flyCruise(me, "mil", true));
      if (me.targetId !== target) out.push({ type: "target", jetId: me.id, targetId: target });
      this.tryOpportunityShot(w, me, target, myInFlight, out);
      out.push(...this.steerVsTrack(me, target, s.crankDeg, this.crankDir));
      return out;
    }
    this.supportTarget = null;

    this.state = "commit";
    out.push(...this.flyCruise(me, s.pumpAfterPitbull ? "ab" : "mil"));
    if (me.targetId !== target) out.push({ type: "target", jetId: me.id, targetId: target });
    out.push(...this.steerVsTrack(me, target, 0, 1));
    const enemy = jetById(w, target);
    // Don't hold fire for 120 s on an already-pitbull missile (or a fire-and-forget posture shot).
    const onTarget = myInFlight.some(
      (tm) =>
        !this.postureMissileIds.has(tm.missileId) &&
        tm.targetId === target &&
        (!tm.ghost.pitbull || tm.impactAt !== null),
    );
    let firedPrimary = false;
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
      const postureActive = this.headOnRmaxNm > 0 && this.canPostureShot(w, me, enemy, myInFlight);
      const postureRange = postureActive ? this.headOnRmaxNm * this.postureScale : 0;
      const fireRangeNm = Math.max(normalRange, postureRange);
      const usingPosture = postureActive && postureRange > normalRange && rangeNm > normalRange;
      const offNoseRad = angleBetween(velocity(me), sub(enemy.pos, me.pos));
      const emergencyClose = rangeNm <= Math.max(this.rneNm, w.params.missile.pitbullRangeNm);
      const aligned = emergencyClose || offNoseRad <= PRIMARY_FIRE_MAX_OFF_RAD;
      if (fireRangeNm > 0 && rangeNm <= fireRangeNm && aligned) {
        if (usingPosture) {
          this.postureShotsFired++;
          this.pendingPostureTarget = target;
        }
        this.actionDetail = usingPosture
          ? `Firing fire-and-forget posture shot at ${rangeNm.toFixed(1)} nm`
          : `Firing at ${rangeNm.toFixed(1)} nm`;
        out.push({ type: "fire", jetId: me.id, targetId: target });
        firedPrimary = true;
      } else if (fireRangeNm > 0 && rangeNm <= fireRangeNm) {
        this.actionDetail = `Aligning nose for shot (${Math.round(offNoseRad / DEG)}° off)`;
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
    if (!firedPrimary) this.tryOpportunityShot(w, me, target, myInFlight, out);
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

  private postureEligibleAmmo(me: Jet): boolean {
    if (!this.skill.postureShot || me.missiles <= 1) return false;
    const initial = this.initialMissiles ?? me.missiles;
    return me.missiles >= POSTURE_MISSILES_MIN || me.missiles >= initial;
  }

  private canPostureShot(w: World, me: Jet, enemy: Jet, myInFlight: MissileTimer[]): boolean {
    if (!this.postureEligibleAmmo(me)) return false;
    if (myInFlight.some((tm) => this.postureMissileIds.has(tm.missileId) && tm.targetId === enemy.id))
      return false;
    if (this.postureRolledForMissiles !== me.missiles) {
      this.postureRolledForMissiles = me.missiles;
      this.postureAllowed = w.rng() < POSTURE_CHANCE;
    }
    if (!this.postureAllowed) return false;
    // Only posture-shot enemies that are hot/cranking/beaming, not already running away cold.
    return angleBetween(velocity(enemy), sub(me.pos, enemy.pos)) <= POSTURE_MAX_ASPECT_RAD;
  }

  /**
   * Range to shoot at: between Rne and Rmax, and closer with every non-posture missile used.
   * Opening posture shots don't prematurely shrink the combat timeline; the final missile picks
   * a uniform random fraction in [LAST_MISSILE_FRAC_MIN, LAST_MISSILE_FRAC_MAX].
   */
  private shotRangeNm(me: Jet, enemy: Jet): number {
    const totalUsed = Math.max(0, (this.initialMissiles ?? me.missiles) - me.missiles);
    const combatUsed = Math.max(0, totalUsed - this.postureShotsFired);
    let frac = Math.min(1, this.skill.shotFrac * this.shotScale) * SHOT_CLOSER_PER_MISSILE ** combatUsed;
    if (me.missiles === 1) frac = Math.min(frac, this.lastMissileFrac);
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
    for (const id of this.oppZones.keys()) if (!jetById(w, id)?.alive) this.oppZones.delete(id);
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
        if (this.pendingPostureTarget === m.targetId) {
          this.postureMissileIds.add(m.id);
          this.pendingPostureTarget = null;
        }
      }
    }
    for (const id of this.timers.keys()) {
      if (!liveIds.has(id)) {
        this.timers.delete(id);
        this.pumpedFor.delete(id);
        this.postureMissileIds.delete(id);
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

  /**
   * Fires an opportunistic Fox 3 at another TWS-locked enemy inside high-Pk range when carrying
   * spare missiles, without breaking primary target assignment or missile cranking support.
   */
  private tryOpportunityShot(
    w: World,
    me: Jet,
    primaryTarget: string,
    myInFlight: MissileTimer[],
    out: Command[],
  ): void {
    if (!this.skill.opportunityShot || me.missiles <= 1) return;
    const t = w.t;
    const preFilterM = w.params.radar.rangeNm * 0.65 * NM;
    let bestOther: Jet | null = null;
    let bestRangeNm = Number.POSITIVE_INFINITY;

    for (const other of w.jets) {
      if (other.side === me.side || !other.alive || other.id === primaryTarget) continue;
      if (!radarCanTrack(w, me, other)) continue;
      const distM = len(sub(other.pos, me.pos));
      if (distM > preFilterM) continue;
      const alreadyShot = myInFlight.some(
        (tm) => tm.targetId === other.id && (!tm.ghost.pitbull || tm.impactAt !== null),
      );
      if (alreadyShot) continue;

      let cached = this.oppZones.get(other.id);
      if (!cached || t - cached.at >= ZONE_EVERY_S) {
        const zone = launchZone(w.params.missile, me, other);
        cached = { at: t, rmaxNm: zone.rmaxNm, rneNm: zone.rneNm };
        this.oppZones.set(other.id, cached);
      }
      if (cached.rmaxNm <= 0) continue;
      const goodRangeNm = cached.rneNm + OPP_SHOT_FRAC * Math.max(0, cached.rmaxNm - cached.rneNm);
      const rangeNm = distM / NM;
      if (rangeNm <= goodRangeNm && rangeNm < bestRangeNm) {
        bestRangeNm = rangeNm;
        bestOther = other;
      }
    }

    if (bestOther) {
      out.push({ type: "fire", jetId: me.id, targetId: bestOther.id });
      // `command("fire")` sets `me.targetId = other.id`; restore the sorted primary target immediately.
      out.push({ type: "target", jetId: me.id, targetId: primaryTarget });
      this.actionDetail = `Opportunity Fox 3 on ${bestOther.callsign} at ${bestRangeNm.toFixed(1)} nm`;
    }
  }

  /**
   * Selects the best known enemy: favors closer & forward-lane bandits, keeps pre-pitbull missile
   * support stable, and only applies deconfliction when closer/peer friendlies already claim it.
   */
  private chooseTarget(w: World, me: Jet, myInFlight: MissileTimer[]): string | null {
    const friends = w.jets.filter(
      (j) => j.side === me.side && j.alive && j.id !== me.id && jetById(w, j.targetId)?.alive,
    );
    const gimbalRad = w.params.radar.gimbalDeg * DEG;
    const prePitbullTargets = new Set(
      myInFlight
        .filter(
          (tm) => !this.postureMissileIds.has(tm.missileId) && (tm.pitbullAt === null || w.t < tm.pitbullAt),
        )
        .map((tm) => tm.targetId),
    );
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [id, tr] of this.tracks) {
      const p = trackAt(tr, w.t).pos;
      const d = len(sub(p, me.pos));
      const off = Math.abs(wrapPi(bearing(me.pos, p) - me.hdg));
      const offPenalty = (off / gimbalRad) * SORT_ANGLE_WEIGHT_M;
      let takenCount = 0;
      for (const f of friends) {
        if (f.targetId !== id) continue;
        if (len(sub(p, f.pos)) <= d + SORT_PEER_MARGIN_M) takenCount++;
      }
      const takenPenalty = Math.min(takenCount, 2) * SORT_TAKEN_PENALTY_M;
      const keepBonus = prePitbullTargets.has(id)
        ? SORT_SUPPORT_BONUS_M
        : me.targetId === id
          ? SORT_KEEP_TARGET_M
          : 0;
      const score = d + offPenalty + takenPenalty - keepBonus;
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  private flyCruise(me: Jet, baseThrottle: Jet["throttle"], preferSustain = false): Command[] {
    const effort: Jet["effort"] =
      this.conservingEnergy || (preferSustain && this.supportSustain) ? "sustain" : "normal";
    const needAb = baseThrottle === "ab" || this.conservingEnergy;
    return this.fly(me, needAb ? "ab" : baseThrottle, effort);
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
