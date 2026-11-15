/**
 * Scripted opponent for Phase 1 drills: a few fixed rules, not an AI. It "knows" when missiles at
 * it are launched / go active (as a DCS RWR would tell it for an active missile). The real NPC with
 * doctrine and its own sensor picture comes in Phase 3, behind the same Controller interface.
 */
import type { Jet, Steer, Throttle } from "./aircraft.ts";
import { len, sub } from "./vec.ts";
import { launchZone } from "./wez.ts";
import { type Command, type Controller, jetById, radarCanTrack, type World } from "./world.ts";

export interface BotConfig {
  /** Fire when the range is within this fraction of the current Rmax; null never fires. */
  fireFracRmax: number | null;
  /** Off-nose angle (deg) to hold while its own missile is in flight, to keep supporting; null stays hot. */
  crankDeg: number | null;
  /** When to defend against a missile aimed at it; null never defends. */
  defendOn: "launch" | "pitbull" | "acquired" | null;
  /** Defensive heading relative to the threat: 180 cold, 90 notch/beam. */
  defendOffsetDeg: number;
  /** Target drone: this many seconds after the first missile at it, turn by beamTurnDeg and hold that heading. */
  beamAfterLaunchS: number | null;
  /** How far (deg) the drone turns then; positive is right. */
  beamTurnDeg: number;
  throttle: Throttle;
}

export const DEFAULT_BOT: BotConfig = {
  fireFracRmax: 0.7,
  crankDeg: 50,
  defendOn: "acquired",
  defendOffsetDeg: 180,
  beamAfterLaunchS: null,
  beamTurnDeg: 90,
  throttle: "mil",
};

const ZONE_EVERY_S = 2;

export class ScriptedBot implements Controller {
  readonly cfg: BotConfig;
  private zoneAt = -1e9;
  private rmaxNm = 0;
  private firstShotAtMe: number | null = null;
  private beamed = false;

  constructor(cfg: Partial<BotConfig> = {}) {
    this.cfg = { ...DEFAULT_BOT, ...cfg };
  }

  update(w: World, me: Jet): Command[] {
    const out: Command[] = [];
    if (me.throttle !== this.cfg.throttle)
      out.push({ type: "throttle", jetId: me.id, throttle: this.cfg.throttle });
    const enemies = w.jets.filter((j) => j.side !== me.side && j.alive);
    if (enemies.length === 0) return out;
    const tgt = enemies.reduce((a, b) => (len(sub(a.pos, me.pos)) <= len(sub(b.pos, me.pos)) ? a : b));
    if (me.targetId !== tgt.id) out.push({ type: "target", jetId: me.id, targetId: tgt.id });

    const atMe = w.missiles.filter((m) => !m.end && m.targetId === me.id);
    if (atMe.length > 0 && this.firstShotAtMe === null) this.firstShotAtMe = w.t;
    const mine = w.missiles.filter((m) => !m.end && m.shooterId === me.id);

    let steer: Steer = { mode: "relative", threatId: tgt.id, offsetDeg: 0, dir: 1, label: "hot" };
    const c = this.cfg;
    const threatened = atMe.find((m) =>
      c.defendOn === "launch"
        ? true
        : c.defendOn === "pitbull"
          ? m.pitbull
          : c.defendOn === "acquired" && m.phase === "tracking",
    );
    if (
      c.beamAfterLaunchS !== null &&
      this.firstShotAtMe !== null &&
      w.t - this.firstShotAtMe >= c.beamAfterLaunchS
    ) {
      if (!this.beamed) {
        this.beamed = true;
        out.push({
          type: "steer",
          jetId: me.id,
          steer: { mode: "heading", hdg: me.hdg + (c.beamTurnDeg * Math.PI) / 180 },
        });
      }
      return out;
    }
    if (threatened) {
      const shooter = jetById(w, threatened.shooterId);
      steer = {
        mode: "relative",
        threatId: shooter?.alive ? shooter.id : tgt.id,
        offsetDeg: c.defendOffsetDeg,
        dir: 1,
        label: "defending",
      };
    } else if (mine.length > 0 && c.crankDeg !== null) {
      steer = { mode: "relative", threatId: tgt.id, offsetDeg: c.crankDeg, dir: 1, label: "crank" };
    } else if (c.fireFracRmax !== null && me.missiles > 0 && radarCanTrack(w, me, tgt)) {
      if (w.t - this.zoneAt >= ZONE_EVERY_S) {
        this.zoneAt = w.t;
        this.rmaxNm = launchZone(w.params.missile, me, tgt).rmaxNm;
      }
      const rangeNm = len(sub(tgt.pos, me.pos)) / 1852;
      if (this.rmaxNm > 0 && rangeNm <= c.fireFracRmax * this.rmaxNm)
        out.push({ type: "fire", jetId: me.id, targetId: tgt.id });
    }
    if (!this.beamed && !sameSteer(me.steer, steer)) out.push({ type: "steer", jetId: me.id, steer });
    return out;
  }
}

function sameSteer(a: Steer, b: Steer): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === "heading" && b.mode === "heading") return a.hdg === b.hdg;
  if (a.mode === "relative" && b.mode === "relative")
    return a.threatId === b.threatId && a.offsetDeg === b.offsetDeg && a.dir === b.dir;
  return false;
}
