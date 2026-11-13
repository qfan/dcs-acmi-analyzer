import { BVR_RANGE_M, type FileAnalytics, type MissileEngagement, TRACK_STRIDE } from "./model.ts";
import { speedOfSoundMs } from "./atmosphere.ts";
import { mean, percentile } from "./query.ts";

const DEG = Math.PI / 180;
/** Shooter crank beyond this (deg off the target) is treated as losing SARH radar support. */
const SARH_GIMBAL_LIMIT_DEG = 68;
/** Missiles slower than this at closest approach (~M1.25 at altitude) are out of energy. */
const MIN_ENDGAME_SPEED_MS = 420;

export type DefeatMode =
  | "kill"
  | "hit"
  | "kinematic"
  | "notch-decoy"
  | "maneuver"
  | "support-lost"
  | "active"
  | "unknown";

export const DEFEAT_MODE_ORDER: DefeatMode[] = [
  "kill",
  "kinematic",
  "notch-decoy",
  "maneuver",
  "support-lost",
  "hit",
  "active",
  "unknown",
];

export const DEFEAT_MODE_LABELS: Record<DefeatMode, string> = {
  kill: "Kill",
  hit: "Hit (Survived)",
  kinematic: "Kinematic (Out of Energy)",
  "notch-decoy": "Notched / Chaff / Lost Track",
  maneuver: "Terminal Maneuver Defeat",
  "support-lost": "Shooter Lost Lock / Died",
  active: "Still Flying (Recording Ended)",
  unknown: "Unclassified Miss",
};

export const DEFEAT_MODE_COLORS: Record<DefeatMode, string> = {
  kill: "#ef4444",
  hit: "#f97316",
  kinematic: "#3b82f6",
  "notch-decoy": "#eab308",
  maneuver: "#10b981",
  "support-lost": "#a855f7",
  active: "#64748b",
  unknown: "#94a3b8",
};

export type TargetDefenseType = "none" | "notch" | "cold" | "maneuver";

export const DEFENSE_TYPE_ORDER: TargetDefenseType[] = ["none", "notch", "cold", "maneuver"];

export const DEFENSE_TYPE_LABELS: Record<TargetDefenseType, string> = {
  none: "No Reaction (Steady / Unaware)",
  notch: "Beam / Notch (90° ± Gate)",
  cold: "Turned Cold / Drag (<35°)",
  maneuver: "Crank / Dive / Break Turn",
};

export interface ShotTacticalMetrics {
  engagementId: string;
  defeatMode: DefeatMode;
  defenseType: TargetDefenseType;
  /** Seconds after launch until target's first turn (>4 deg/s), dive, or countermeasure release. */
  reactionTimeS: number | null;
  /** Shooter-to-target slant range (m) when the target initiated its first defensive reaction. */
  reactionRangeM: number | null;
  /** Shooter-to-target slant range (m) when the target first achieved a Cold/Drag aspect (<=40°). */
  coldTurnRangeM: number | null;
  /** Shooter-to-target slant range (m) when the target first entered the Notch/Beam gate. */
  notchEntryRangeM: number | null;
  /** True if target was killed without any measurable turn or countermeasure release. */
  diedUnaware: boolean;
  /** Seconds target spent with missile aspect within 90° ± notchGateDeg. */
  timeInNotchS: number;
  /** Fraction (0–1) of tracked flyout time spent in the notch gate. */
  notchFraction: number;
  /** Closest target got to a pure 90° beam relative to the incoming missile (0° = exact beam). */
  minBeamOffsetDeg: number | null;
  /** Minimum |radial velocity of target along missile-to-target LOS| in m/s (Doppler notch speed). */
  minRadialVelMs: number | null;
  /** Minimum aspect angle to the missile (0° = pure tail-on cold, 180° = pure head-on). */
  minMissileAspectDeg: number | null;
  /** Target altitude change from launch to impact/end (m, negative = dove). */
  targetAltDeltaM: number | null;
  /** Maximum target turn rate observed during missile flight (deg/s). */
  maxTargetTurnRateDegS: number;
  /** Maximum shooter off-boresight crank angle to target during first 70% of missile flight (deg). */
  maxShooterCrankDeg: number | null;
  targetChaffCount: number;
  targetFlareCount: number;
}

/**
 * Analyze a single engagement's resampled `track` and `flight` to classify target defense,
 * reaction time, shooter crank, Doppler notch metrics, and missile defeat mode.
 */
export function analyzeShotTactics(e: MissileEngagement, notchGateDeg = 15): ShotTacticalMetrics {
  const tr = e.track;
  const fl = e.flight;
  const targetChaffCount = tr?.targetChaffS.length ?? 0;
  const targetFlareCount = tr?.targetFlareS.length ?? 0;

  let reactionTimeS: number | null = null;
  if (tr) {
    const cmTimes = [...tr.targetChaffS, ...tr.targetFlareS].filter((t) => t >= 0);
    if (cmTimes.length > 0) {
      reactionTimeS = Math.min(...cmTimes);
    }
  }

  let timeInNotchS = 0;
  let validMissileTargetSteps = 0;
  let minBeamOffsetDeg: number | null = null;
  let minRadialVelMs: number | null = null;
  let minMissileAspectDeg: number | null = null;
  let targetAltDeltaM: number | null = null;
  let maxTargetTurnRateDegS = 0;
  let maxShooterCrankDeg: number | null = null;
  let reactionRangeM: number | null = null;
  let coldTurnRangeM: number | null = null;
  let notchEntryRangeM: number | null = null;
  /** Aspect to the missile per valid step, kept so defense type can be judged after the reaction. */
  const aspectSteps: { tRel: number; aspectDeg: number; beamOffsetDeg: number }[] = [];

  if (tr && tr.n >= 3) {
    const dt = tr.dt;
    const d = tr.data;
    // Analyze up to Closest Point of Approach (cpaAtS) so post-miss coasting doesn't pollute metrics
    const effectiveEndS =
      fl?.cpaAtS !== null && fl?.cpaAtS !== undefined && fl.cpaAtS > 1 ? fl.cpaAtS : (fl?.tofS ?? tr.n * dt);
    const tofSteps = Math.min(tr.n, Math.max(2, Math.ceil(effectiveEndS / dt)));
    // Seeker/notch endgame window: last 12 seconds before CPA (or second half of flight for short shots)
    const endgameStartStep = Math.max(1, Math.min(Math.floor(tofSteps * 0.4), tofSteps - Math.ceil(12 / dt)));

    let firstTargetAlt: number | null = null;
    let lastTargetAlt: number | null = null;
    let initTargetHeadingRad: number | null = null;
    let prevTargetHeadingRad: number | null = null;
    let initTargetVz: number | null = null;

    const beamOffsets: number[] = [];
    const radialVels: number[] = [];

    for (let k = 0; k < tofSteps; k++) {
      const b = k * TRACK_STRIDE;
      const tRel = k * dt;

      const mE = d[b] as number;
      const mN = d[b + 1] as number;
      const mAlt = d[b + 2] as number;
      const tE = d[b + 4] as number;
      const tN = d[b + 5] as number;
      const tAlt = d[b + 6] as number;
      const sE = d[b + 7] as number;
      const sN = d[b + 8] as number;
      const sAlt = d[b + 9] as number;

      // Instantaneous shooter-to-target slant range (fallback to missile-to-target if shooter despawned)
      const stRangeM = Number.isFinite(tE + tN + sE + sN)
        ? Math.hypot(tE - sE, tN - sN, Number.isFinite(tAlt + sAlt) ? tAlt - sAlt : 0)
        : Number.isFinite(tE + tN + mE + mN)
          ? Math.hypot(tE - mE, tN - mN, Number.isFinite(tAlt + mAlt) ? tAlt - mAlt : 0)
          : null;

      if (reactionTimeS !== null && reactionRangeM === null && tRel >= reactionTimeS && stRangeM !== null) {
        reactionRangeM = stRangeM;
      }

      if (Number.isFinite(tAlt)) {
        if (firstTargetAlt === null) firstTargetAlt = tAlt;
        lastTargetAlt = tAlt;
      }

      // Target velocity from neighboring step
      if (k > 0 && Number.isFinite(tE + tN + tAlt)) {
        const bp = (k - 1) * TRACK_STRIDE;
        const ptE = d[bp + 4] as number;
        const ptN = d[bp + 5] as number;
        const ptAlt = d[bp + 6] as number;
        if (Number.isFinite(ptE + ptN + ptAlt)) {
          const vx = (tE - ptE) / dt;
          const vy = (tN - ptN) / dt;
          const vz = (tAlt - ptAlt) / dt;
          const hSpeed = Math.hypot(vx, vy);

          if (initTargetVz === null) initTargetVz = vz;

          if (hSpeed > 25) {
            const hdg = Math.atan2(vx, vy);
            if (initTargetHeadingRad === null) initTargetHeadingRad = hdg;
            if (prevTargetHeadingRad !== null) {
              let dHdg = Math.abs(hdg - prevTargetHeadingRad);
              if (dHdg > Math.PI) dHdg = 2 * Math.PI - dHdg;
              const turnRate = dHdg / DEG / dt;
              if (turnRate < 60 && turnRate > maxTargetTurnRateDegS) {
                maxTargetTurnRateDegS = turnRate;
              }
              if (reactionTimeS === null || tRel < reactionTimeS) {
                let totalTurn = Math.abs(hdg - initTargetHeadingRad);
                if (totalTurn > Math.PI) totalTurn = 2 * Math.PI - totalTurn;
                const vzChange = Math.abs(vz - (initTargetVz ?? 0));
                if ((turnRate >= 4.5 && totalTurn / DEG >= 15) || vzChange >= 25) {
                  reactionTimeS = tRel;
                  if (stRangeM !== null) reactionRangeM = stRangeM;
                }
              }
            }
            prevTargetHeadingRad = hdg;

            // Geometry relative to incoming missile
            if (Number.isFinite(mE + mN + mAlt)) {
              const losE = tE - mE;
              const losN = tN - mN;
              const losU = tAlt - mAlt;
              const losHoriz = Math.hypot(losE, losN);
              const los3d = Math.hypot(losE, losN, losU);
              if (losHoriz > 50 && los3d > 50) {
                validMissileTargetSteps++;
                // Aspect to missile: 0° = target flying away from missile (cold), 90° = beaming missile, 180° = flying into missile
                const cosTail = (vx * losE + vy * losN) / (hSpeed * losHoriz);
                const clamped = Math.max(-1, Math.min(1, cosTail));
                // When target flies away from missile (same direction as m->t LOS), cosTail = +1 => aspect = 0° (cold)
                const missileAspectDeg = Math.acos(clamped) / DEG;
                const beamOffsetDeg = Math.abs(missileAspectDeg - 90);
                // Target 3D radial velocity along missile-to-target line of sight (Doppler shift seen by missile seeker)
                const vRadial = Math.abs((vx * losE + vy * losN + vz * losU) / los3d);
                aspectSteps.push({ tRel, aspectDeg: missileAspectDeg, beamOffsetDeg });
                if (k >= endgameStartStep) {
                  beamOffsets.push(beamOffsetDeg);
                  radialVels.push(vRadial);
                }
                if (minMissileAspectDeg === null || missileAspectDeg < minMissileAspectDeg) {
                  minMissileAspectDeg = missileAspectDeg;
                }
                if (missileAspectDeg <= 40 && coldTurnRangeM === null && stRangeM !== null) {
                  coldTurnRangeM = stRangeM;
                }
                if (beamOffsetDeg <= notchGateDeg) {
                  timeInNotchS += dt;
                  if (notchEntryRangeM === null && stRangeM !== null) {
                    notchEntryRangeM = stRangeM;
                  }
                }
              }
            }
          }

          // Shooter crank angle during the first 75% of flight
          if (k <= tofSteps * 0.75 && Number.isFinite(sE + sN)) {
            const spE = d[bp + 7] as number;
            const spN = d[bp + 8] as number;
            if (Number.isFinite(spE + spN)) {
              const svx = (sE - spE) / dt;
              const svy = (sN - spN) / dt;
              const sSpeed = Math.hypot(svx, svy);
              const stE = tE - sE;
              const stN = tN - sN;
              const stDist = Math.hypot(stE, stN);
              if (sSpeed > 25 && stDist > 500) {
                const cosAta = Math.max(-1, Math.min(1, (svx * stE + svy * stN) / (sSpeed * stDist)));
                const crankDeg = Math.acos(cosAta) / DEG;
                if (maxShooterCrankDeg === null || crankDeg > maxShooterCrankDeg) {
                  maxShooterCrankDeg = crankDeg;
                }
              }
            }
          }
        }
      }
    }

    // Compute sustained (3-sample = 1.5s sliding mean) minimum beam offset & radial velocity
    // so transiently passing through 90° during a fast turn to cold doesn't count as a sustained 0° notch.
    if (beamOffsets.length > 0) {
      const win = Math.min(3, beamOffsets.length);
      for (let i = 0; i <= beamOffsets.length - win; i++) {
        let bSum = 0;
        let rSum = 0;
        for (let j = 0; j < win; j++) {
          bSum += beamOffsets[i + j]!;
          rSum += radialVels[i + j]!;
        }
        const bAvg = bSum / win;
        const rAvg = rSum / win;
        if (minBeamOffsetDeg === null || bAvg < minBeamOffsetDeg) minBeamOffsetDeg = bAvg;
        if (minRadialVelMs === null || rAvg < minRadialVelMs) minRadialVelMs = rAvg;
      }
    }

    if (firstTargetAlt !== null && lastTargetAlt !== null) {
      targetAltDeltaM = lastTargetAlt - firstTargetAlt;
    }
  } else if (e.initial) {
    // Fallback to initial geometry if no resampled track is attached
    const initBeam = Math.abs(e.initial.aspectDeg - 90);
    minBeamOffsetDeg = initBeam;
    minMissileAspectDeg = e.initial.aspectDeg;
  }

  const notchFraction =
    validMissileTargetSteps > 0 ? timeInNotchS / (validMissileTargetSteps * (tr?.dt ?? 0.5)) : 0;

  // Classify target defense. A defense needs a measured reaction (turn, dive/climb or
  // countermeasures after launch); the geometry is then judged from the reaction onwards, so a
  // target that was already flying away, or crossing at 90°, and never reacted counts as "none".
  let defenseType: TargetDefenseType = "none";
  if (reactionTimeS !== null) {
    const rt = reactionTimeS;
    const after = aspectSteps.filter((s) => s.tRel >= rt);
    const minAspectAfter = after.reduce((m, s) => Math.min(m, s.aspectDeg), Number.POSITIVE_INFINITY);
    const notchTimeAfter = after.filter((s) => s.beamOffsetDeg <= notchGateDeg).length * (tr?.dt ?? 0.5);
    if (minAspectAfter <= 35) {
      defenseType = "cold";
    } else if (notchTimeAfter >= 1.5) {
      defenseType = "notch";
    } else {
      defenseType = "maneuver";
    }
  }

  // Classify missile outcome / defeat mode using kinematics AT CPA (not post-miss despawn)
  let defeatMode: DefeatMode = "unknown";
  if (e.isKill) {
    defeatMode = "kill";
  } else if (e.outcome === "hit-damaged" || e.outcome === "intercept") {
    defeatMode = "hit";
  } else if (e.outcome === "active") {
    defeatMode = "active";
  } else if (fl) {
    const cpa = fl.cpaM ?? e.missDistanceM ?? Number.POSITIVE_INFINITY;
    const cpaSpeedMs = fl.cpaMissileSpeedMs ?? fl.endSpeedMs;
    // Mach at CPA from the missile's altitude there (track sample nearest CPA); without a track,
    // fall back to the apex altitude, which underestimates the speed of sound the least badly.
    let cpaAltM: number | null = null;
    if (tr && fl.cpaAtS !== null) {
      const k = Math.min(tr.n - 1, Math.max(0, Math.round(fl.cpaAtS / tr.dt)));
      const a = tr.data[k * TRACK_STRIDE + 2] as number;
      if (Number.isFinite(a)) cpaAltM = a;
    }
    const cpaMach = cpaSpeedMs / speedOfSoundMs(cpaAltM ?? fl.apexAltM);
    const isRadar = e.weaponClass === "A2A-ARH" || e.weaponClass === "A2A-SARH" || e.weaponClass === "SAM";
    const isSarh = e.weaponClass === "A2A-SARH";

    if (isSarh && maxShooterCrankDeg !== null && maxShooterCrankDeg > SARH_GIMBAL_LIMIT_DEG && cpa > 300) {
      defeatMode = "support-lost";
    } else if (
      isRadar &&
      cpa <= 22000 &&
      (defenseType === "notch" ||
        (minBeamOffsetDeg !== null && minBeamOffsetDeg <= Math.max(notchGateDeg, 18)) ||
        (minRadialVelMs !== null && minRadialVelMs <= 55) ||
        (targetChaffCount > 0 && minBeamOffsetDeg !== null && minBeamOffsetDeg <= 30))
    ) {
      defeatMode = "notch-decoy";
    } else if (!isRadar && targetFlareCount > 0 && cpa <= 8000 && cpa > 30) {
      defeatMode = "notch-decoy";
    } else if (cpa <= 1500 && maxTargetTurnRateDegS >= 5.5 && cpaMach >= 1.2) {
      defeatMode = "maneuver";
    } else if (cpa > 5000 || cpaMach < 1.25 || fl.endMach < 1.25 || defenseType === "cold") {
      defeatMode = "kinematic";
    } else if (maxTargetTurnRateDegS >= 4.5) {
      defeatMode = "maneuver";
    }
  }

  const diedUnaware = e.isKill && reactionTimeS === null && targetChaffCount === 0 && targetFlareCount === 0;

  return {
    engagementId: e.id,
    defeatMode,
    defenseType,
    reactionTimeS,
    // Null when the target never reacted: falling back to the launch range would mix unaware
    // targets into reaction-range statistics.
    reactionRangeM,
    coldTurnRangeM,
    notchEntryRangeM,
    diedUnaware,
    timeInNotchS,
    notchFraction,
    minBeamOffsetDeg,
    minRadialVelMs,
    minMissileAspectDeg,
    targetAltDeltaM,
    maxTargetTurnRateDegS,
    maxShooterCrankDeg,
    targetChaffCount,
    targetFlareCount,
  };
}

/**
 * Wilson score 95% confidence interval for a binomial proportion (k successes in n trials).
 */
export function wilsonInterval(k: number, n: number, z = 1.96): { lo: number; hi: number } | null {
  if (n <= 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    lo: Math.max(0, center - half),
    hi: Math.min(1, center + half),
  };
}

/**
 * Classical ML 1D & Multi-feature Logistic Regression for empirical Notch / Seeker Gate estimation.
 *
 * Fits `P(survive_by_notch | beamOffsetDeg, minRadialVelMs, lookDown, chaff)` using L2-regularized
 * Newton-Raphson (IRLS) and finds the empirical 50% survival boundary for beam angle and radial velocity.
 */
export interface NotchGateAnalysis {
  sampleSize: number;
  survivedCount: number;
  userGateDeg: number;
  /** Survival rate when target entered user's `±userGateDeg` beam window vs. when it did not. */
  inGateShots: number;
  inGateSurvived: number;
  inGateSurvivalRate: number | null;
  outGateShots: number;
  outGateSurvived: number;
  outGateSurvivalRate: number | null;
  /** How well the user's gate predicts non-kinematic survival (precision, recall, accuracy). */
  gatePrecision: number | null;
  gateRecall: number | null;
  gateAccuracy: number | null;
  /** Fitted logistic regression: P(survive) = sigmoid(b0 + b1 * beamOffsetDeg). */
  beamSlope: number;
  beamIntercept: number;
  /** Angle offset from 90° beam where fitted P(survive) = 50% (or null if model doesn't cross 50%). */
  empiricalBeamGateDeg: number | null;
  /** Radial velocity (m/s) where fitted P(survive) = 50%. */
  empiricalRadialGateMs: number | null;
  /** Binned survival curve by degrees off 90° beam (0–5°, 5–10°, 10–15°, 15–25°, 25–45°, >45°). */
  beamBins: {
    label: string;
    minDeg: number;
    maxDeg: number;
    shots: number;
    survived: number;
    survivalRate: number | null;
    fittedProb: number;
  }[];
}

export const sigmoid = (z: number): number =>
  z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));

export function fit1DLogistic(xs: number[], ys: number[]): { b0: number; b1: number } {
  if (xs.length < 4) return { b0: 0, b1: -0.05 };
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.max(1e-3, Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / xs.length));
  let w0 = 0;
  let w1 = 0;
  const lambda = 0.05; // light L2 regularization for small samples

  for (let iter = 0; iter < 30; iter++) {
    let g0 = 0;
    let g1 = 0;
    let h00 = lambda;
    let h01 = 0;
    let h11 = lambda;
    for (let i = 0; i < xs.length; i++) {
      const z = ((xs[i] as number) - mu) / sd;
      const p = sigmoid(w0 + w1 * z);
      const w = Math.max(1e-5, p * (1 - p));
      const err = (ys[i] as number) - p;
      g0 += err;
      g1 += err * z;
      h00 += w;
      h01 += w * z;
      h11 += w * z * z;
    }
    g0 -= lambda * w0;
    g1 -= lambda * w1;
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-9) break;
    const dw0 = (h11 * g0 - h01 * g1) / det;
    const dw1 = (-h01 * g0 + h00 * g1) / det;
    w0 += dw0;
    w1 += dw1;
    if (Math.hypot(dw0, dw1) < 1e-5) break;
  }

  const b1 = w1 / sd;
  const b0 = w0 - (w1 * mu) / sd;
  return { b0, b1 };
}

export function analyzeNotchGate(
  engagements: MissileEngagement[],
  tacticsById: Map<string, ShotTacticalMetrics>,
  userGateDeg = 15,
): NotchGateAnalysis {
  // Radar-guided shots only. Every exclusion below applies the same rule to kills and misses:
  // dropping only survivors (e.g. "missed far away" or "survived by running cold") would make
  // beaming look more effective than the data shows.
  const samples: {
    beamDeg: number;
    radialMs: number | null;
    survived: number;
  }[] = [];

  for (const e of engagements) {
    if (e.isGun) continue;
    if (e.weaponClass !== "A2A-ARH" && e.weaponClass !== "A2A-SARH" && e.weaponClass !== "SAM") {
      continue;
    }
    const tac = tacticsById.get(e.id);
    if (!tac || tac.minBeamOffsetDeg === null) continue;
    // Unresolved when the recording ended.
    if (tac.defeatMode === "active") continue;
    // SARH shots whose shooter cranked past the radar gimbal limit (support likely lost).
    if (
      e.weaponClass === "A2A-SARH" &&
      tac.maxShooterCrankDeg !== null &&
      tac.maxShooterCrankDeg > SARH_GIMBAL_LIMIT_DEG
    ) {
      continue;
    }
    // Targets that defended by turning cold are a different defense from notching.
    if (tac.defenseType === "cold") continue;
    // Missile had too little energy at closest approach (impact for kills) to test the seeker.
    const cpaSpeed = e.flight?.cpaMissileSpeedMs ?? e.flight?.endSpeedMs ?? null;
    if (cpaSpeed !== null && cpaSpeed < MIN_ENDGAME_SPEED_MS) continue;
    samples.push({
      beamDeg: tac.minBeamOffsetDeg,
      radialMs: tac.minRadialVelMs,
      survived: e.isKill ? 0 : 1,
    });
  }

  let inGateShots = 0;
  let inGateSurvived = 0;
  let outGateShots = 0;
  let outGateSurvived = 0;
  for (const s of samples) {
    if (s.beamDeg <= userGateDeg) {
      inGateShots++;
      inGateSurvived += s.survived;
    } else {
      outGateShots++;
      outGateSurvived += s.survived;
    }
  }

  const survivedCount = inGateSurvived + outGateSurvived;
  const tp = inGateSurvived;
  const fp = inGateShots - inGateSurvived;
  const fn = outGateSurvived;
  const tn = outGateShots - outGateSurvived;

  const { b0, b1 } = fit1DLogistic(
    samples.map((s) => s.beamDeg),
    samples.map((s) => s.survived),
  );
  // P(survive) = 0.5 when b0 + b1 * x = 0 => x = -b0 / b1
  let empiricalBeamGateDeg: number | null = null;
  if (b1 < -1e-4) {
    const cross = -b0 / b1;
    if (cross >= 1 && cross <= 60) empiricalBeamGateDeg = cross;
  }

  const radialSamples = samples.filter((s): s is typeof s & { radialMs: number } => s.radialMs !== null);
  let empiricalRadialGateMs: number | null = null;
  if (radialSamples.length >= 4) {
    const rFit = fit1DLogistic(
      radialSamples.map((s) => s.radialMs),
      radialSamples.map((s) => s.survived),
    );
    if (rFit.b1 < -1e-4) {
      const cross = -rFit.b0 / rFit.b1;
      if (cross >= 5 && cross <= 250) empiricalRadialGateMs = cross;
    }
  }

  const bracketDefs: [number, number, string][] = [
    [0, 5, "0°–5° (Dead Beam)"],
    [5, 10, "5°–10°"],
    [10, 15, "10°–15°"],
    [15, 25, "15°–25°"],
    [25, 45, "25°–45°"],
    [45, 90, "45°–90° (Hot/Tail)"],
  ];

  const beamBins = bracketDefs.map(([minDeg, maxDeg, label]) => {
    const matching = samples.filter((s) =>
      maxDeg === 90 ? s.beamDeg >= minDeg : s.beamDeg >= minDeg && s.beamDeg < maxDeg,
    );
    const shots = matching.length;
    const survived = matching.reduce((acc, s) => acc + s.survived, 0);
    const mid = 0.5 * (minDeg + maxDeg);
    return {
      label,
      minDeg,
      maxDeg,
      shots,
      survived,
      survivalRate: shots > 0 ? survived / shots : null,
      fittedProb: sigmoid(b0 + b1 * mid),
    };
  });

  return {
    sampleSize: samples.length,
    survivedCount,
    userGateDeg,
    inGateShots,
    inGateSurvived,
    inGateSurvivalRate: inGateShots > 0 ? inGateSurvived / inGateShots : null,
    outGateShots,
    outGateSurvived,
    outGateSurvivalRate: outGateShots > 0 ? outGateSurvived / outGateShots : null,
    gatePrecision: tp + fp > 0 ? tp / (tp + fp) : null,
    gateRecall: tp + fn > 0 ? tp / (tp + fn) : null,
    gateAccuracy: samples.length > 0 ? (tp + tn) / samples.length : null,
    beamSlope: b1,
    beamIntercept: b0,
    empiricalBeamGateDeg,
    empiricalRadialGateMs,
    beamBins,
  };
}

export type CohortSplitMode = "dcsPatch" | "month" | "dateCutoff";

/**
 * Standard normal two-tailed p-value: P(|Z| >= |z|).
 */
export function normalTwoTailedP(z: number): number {
  const x = Math.abs(z);
  if (!Number.isFinite(x)) return 1;
  if (x === 0) return 1;
  if (x > 8) return 0;
  // Abramowitz & Stegun 7.1.26 rational approximation for erfc(x / sqrt(2))
  const t = 1 / (1 + 0.2316419 * x);
  const poly =
    t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  return Math.max(0, Math.min(1, 2 * pdf * poly));
}

/**
 * Non-parametric 95% confidence interval for the median of a sorted array using
 * binomial order statistics: indices floor(0.5*n - 0.98*sqrt(n)) to ceil(0.5*n + 0.98*sqrt(n)) - 1.
 */
export function medianConfidenceInterval(sorted: number[]): { lo: number; hi: number } | null {
  const n = sorted.length;
  if (n < 3) return null;
  const halfWidth = 0.98 * Math.sqrt(n);
  const loIdx = Math.max(0, Math.floor(0.5 * n - halfWidth));
  const hiIdx = Math.min(n - 1, Math.ceil(0.5 * n + halfWidth) - 1);
  return {
    lo: sorted[loIdx]!,
    hi: sorted[hiIdx]!,
  };
}

/**
 * Two-tailed p-value for a difference between two binomial proportions (k1/n1 vs k2/n2)
 * with Yates continuity correction so small sample sizes aren't over-reported as significant.
 */
export function twoProportionChanceP(k1: number, n1: number, k2: number, n2: number): number | null {
  if (n1 < 2 || n2 < 2) return null;
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const pooled = (k1 + k2) / (n1 + n2);
  if (pooled <= 0 || pooled >= 1) return 1;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se <= 1e-9) return 1;
  const diff = Math.max(0, Math.abs(p1 - p2) - 0.5 * (1 / n1 + 1 / n2));
  return normalTwoTailedP(diff / se);
}

/**
 * Non-parametric Mann-Whitney U (Wilcoxon rank-sum) two-tailed p-value testing whether two
 * continuous samples `xs` and `ys` could come from the same distribution by random chance.
 */
export function mannWhitneyChanceP(xs: number[], ys: number[]): number | null {
  const n1 = xs.length;
  const n2 = ys.length;
  if (n1 < 2 || n2 < 2) return null;
  const combined: { v: number; g: 0 | 1 }[] = [
    ...xs.map((v) => ({ v, g: 0 as const })),
    ...ys.map((v) => ({ v, g: 1 as const })),
  ].sort((a, b) => a.v - b.v);

  const N = n1 + n2;
  let r1 = 0;
  let tieCorrectionSum = 0;
  let i = 0;
  while (i < N) {
    let j = i + 1;
    while (j < N && Math.abs(combined[j]!.v - combined[i]!.v) <= 1e-6) j++;
    const count = j - i;
    const avgRank = 0.5 * (i + 1 + j);
    if (count > 1) {
      tieCorrectionSum += count ** 3 - count;
    }
    for (let k = i; k < j; k++) {
      if (combined[k]!.g === 0) r1 += avgRank;
    }
    i = j;
  }

  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const mu = (n1 * n2) / 2;
  const tieTerm = N > 1 ? tieCorrectionSum / (N * (N - 1)) : 0;
  const variance = ((n1 * n2) / 12) * (N + 1 - tieTerm);
  if (variance <= 1e-9) return 1;
  const z = Math.max(0, Math.abs(u1 - mu) - 0.5) / Math.sqrt(variance);
  return normalTwoTailedP(z);
}

/**
 * Exact combinatoric order-statistic test for whether the observed difference in sample maximums
 * (`max(xs)` vs `max(ys)`) could occur purely by chance / uneven sample sizes (`n1` vs `n2`).
 *
 * Counts how many observations `m >= 1` in the higher-max sample strictly exceed the other sample's max,
 * and computes the exact hypergeometric probability that all top `m` values out of `n1 + n2` fall in the
 * same group under the null hypothesis of identical distributions.
 */
export function extremeOrderChanceP(xs: number[], ys: number[]): number | null {
  const n1 = xs.length;
  const n2 = ys.length;
  if (n1 < 1 || n2 < 1) return null;
  const max1 = Math.max(...xs);
  const max2 = Math.max(...ys);
  if (Math.abs(max1 - max2) <= 1e-6) return 1;

  const winner = max1 > max2 ? xs : ys;
  const loserMax = max1 > max2 ? max2 : max1;
  const nWin = winner.length;
  const nLose = max1 > max2 ? n2 : n1;
  const N = nWin + nLose;

  const m = Math.max(1, winner.filter((v) => v > loserMax).length);
  let pWin = 1;
  for (let j = 0; j < m; j++) {
    pWin *= (nWin - j) / (N - j);
  }
  let pLose = 0;
  if (nLose >= m) {
    pLose = 1;
    for (let j = 0; j < m; j++) {
      pLose *= (nLose - j) / (N - j);
    }
  }
  return Math.max(0, Math.min(1, pWin + pLose));
}

export type SampleConfidenceLevel = "high" | "moderate" | "low";

export interface CohortStats {
  cohortKey: string;
  label: string;
  fileCount: number;
  shots: number;
  kills: number;
  sampleConfidence: SampleConfidenceLevel;
  pk: number | null;
  pkCi: { lo: number; hi: number } | null;
  bvrShots: number;
  bvrKills: number;
  bvrPk: number | null;
  bvrPkCi: { lo: number; hi: number } | null;
  medianShotRangeM: number | null;
  medianShotRangeCi: { lo: number; hi: number } | null;
  medianKillRangeM: number | null;
  medianKillRangeCi: { lo: number; hi: number } | null;
  p90KillRangeM: number | null;
  maxKillRangeM: number | null;
  headOnShots: number;
  headOnKills: number;
  headOnMaxKillRangeM: number | null;
  medianMaxMach: number | null;
  medianMaxMachCi: { lo: number; hi: number } | null;
  empiricalNotchDeg: number | null;
  /**
   * Smallest Holm-adjusted two-tailed p-value vs. the preceding cohort across Pk, kill range,
   * head-on kill range and missile Mach (adjusted over every test in the comparison).
   */
  vsPrevChanceP: number | null;
}

/**
 * Holm–Bonferroni step-down adjustment: returns adjusted p-values (same order as the input) that
 * control the family-wise error rate across all the tests.
 */
export function holmAdjust(ps: number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const out = new Array<number>(m);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    out[i] = running;
  });
  return out;
}

export interface PatchShiftAlert {
  fromCohort: string;
  toCohort: string;
  severity: "info" | "notable" | "major";
  summary: string;
  /**
   * Holm-adjusted two-tailed p-value: how often a shift at least this large would appear if the
   * cohorts did not really differ (not the probability that the shift is due to chance).
   */
  chanceProb: number;
  /** True when the adjusted p-value is below 0.10. */
  isStatisticallySignificant: boolean;
  /** Human-readable explanation of sample size & random-chance likelihood. */
  chanceNote: string;
}

export function compareCohorts(
  engagements: MissileEngagement[],
  tacticsById: Map<string, ShotTacticalMetrics>,
  mode: CohortSplitMode,
  cutoffDateIso = "2025-03-01",
): { cohorts: CohortStats[]; alerts: PatchShiftAlert[] } {
  const groups = new Map<string, MissileEngagement[]>();

  for (const e of engagements) {
    let key = "Unknown";
    if (mode === "dcsPatch") {
      key = e.dcsPatch || "Unknown Version";
    } else if (mode === "month") {
      key = e.recordedAt ? e.recordedAt.slice(0, 7) : "Unknown Date";
    } else {
      const day = e.recordedAt ? e.recordedAt.slice(0, 10) : "";
      key = !day ? "Unknown Date" : day < cutoffDateIso ? `Before ${cutoffDateIso}` : `From ${cutoffDateIso}`;
    }
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(e);
  }

  const sortCohortKeys = (a: string, b: string): number => {
    if (a.startsWith("Unknown")) return 1;
    if (b.startsWith("Unknown")) return -1;
    if (a.startsWith("Before ")) return -1;
    if (b.startsWith("Before ")) return 1;
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    if (pa.length >= 2 && pb.length >= 2 && pa.every(Number.isFinite) && pb.every(Number.isFinite)) {
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    }
    return a.localeCompare(b);
  };

  const rawByCohort = new Map<
    string,
    {
      shotRanges: number[];
      killRanges: number[];
      headOnKillRanges: number[];
      machs: number[];
    }
  >();

  const cohorts: CohortStats[] = [...groups.entries()]
    .sort((a, b) => sortCohortKeys(a[0], b[0]))
    .map(([cohortKey, list]) => {
      const fileCount = new Set(list.map((e) => e.fileId)).size;
      const kills = list.filter((e) => e.isKill);
      const bvrList = list.filter((e) => (e.initial?.slantRangeM ?? 0) >= BVR_RANGE_M);
      const bvrKills = bvrList.filter((e) => e.isKill);
      const headOnList = list.filter((e) => e.initial?.aspectCategory === "head-on");
      const headOnKills = headOnList.filter((e) => e.isKill);

      const shotRanges = list
        .map((e) => e.initial?.slantRangeM)
        .filter((v): v is number => v !== undefined && Number.isFinite(v))
        .sort((a, b) => a - b);
      const killRanges = kills
        .map((e) => e.initial?.slantRangeM)
        .filter((v): v is number => v !== undefined && Number.isFinite(v))
        .sort((a, b) => a - b);
      const headOnKillRanges = headOnKills
        .map((e) => e.initial?.slantRangeM)
        .filter((v): v is number => v !== undefined && Number.isFinite(v))
        .sort((a, b) => a - b);
      const machs = list
        .map((e) => e.flight?.maxMach)
        .filter((v): v is number => v !== undefined && v !== null && Number.isFinite(v))
        .sort((a, b) => a - b);

      rawByCohort.set(cohortKey, {
        shotRanges,
        killRanges,
        headOnKillRanges,
        machs,
      });

      const notch = analyzeNotchGate(list, tacticsById);
      const sampleConfidence: SampleConfidenceLevel =
        list.length >= 40 && kills.length >= 10 && fileCount >= 2
          ? "high"
          : list.length >= 15 && kills.length >= 4
            ? "moderate"
            : "low";

      return {
        cohortKey,
        label: mode === "dcsPatch" && !cohortKey.startsWith("Unknown") ? `DCS ${cohortKey}` : cohortKey,
        fileCount,
        shots: list.length,
        kills: kills.length,
        sampleConfidence,
        pk: list.length > 0 ? kills.length / list.length : null,
        pkCi: wilsonInterval(kills.length, list.length),
        bvrShots: bvrList.length,
        bvrKills: bvrKills.length,
        bvrPk: bvrList.length > 0 ? bvrKills.length / bvrList.length : null,
        bvrPkCi: wilsonInterval(bvrKills.length, bvrList.length),
        medianShotRangeM: percentile(shotRanges, 0.5),
        medianShotRangeCi: medianConfidenceInterval(shotRanges),
        medianKillRangeM: percentile(killRanges, 0.5),
        medianKillRangeCi: medianConfidenceInterval(killRanges),
        p90KillRangeM: percentile(killRanges, 0.9),
        maxKillRangeM: killRanges[killRanges.length - 1] ?? null,
        headOnShots: headOnList.length,
        headOnKills: headOnKills.length,
        headOnMaxKillRangeM: headOnKillRanges[headOnKillRanges.length - 1] ?? null,
        medianMaxMach: percentile(machs, 0.5),
        medianMaxMachCi: medianConfidenceInterval(machs),
        empiricalNotchDeg: notch.empiricalBeamGateDeg,
        vsPrevChanceP: null,
      };
    });

  // Generate automatic shift alerts between consecutive cohorts with statistical significance / chance estimates
  const alerts: PatchShiftAlert[] = [];
  const valid = cohorts.filter((c) => !c.cohortKey.startsWith("Unknown") && c.shots >= 3);
  const NM = 1852;

  // Pass 1: every test run between consecutive cohorts. All of them form one family, so the
  // p-values are Holm-adjusted together: with several metrics x several patch pairs, some raw
  // p < 0.1 results are expected from noise alone.
  type PairTests = {
    pk: number | null;
    killRangeMw: number | null;
    killRangeMax: number | null;
    hoRangeMax: number | null;
    machMw: number | null;
  };
  const pairTests: PairTests[] = [];
  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1] as CohortStats;
    const curr = valid[i] as CohortStats;
    const prevRaw = rawByCohort.get(prev.cohortKey);
    const currRaw = rawByCohort.get(curr.cohortKey);
    const both = prevRaw && currRaw;
    pairTests.push({
      pk: twoProportionChanceP(prev.kills, prev.shots, curr.kills, curr.shots),
      killRangeMw: both ? mannWhitneyChanceP(prevRaw.killRanges, currRaw.killRanges) : null,
      killRangeMax: both ? extremeOrderChanceP(prevRaw.killRanges, currRaw.killRanges) : null,
      hoRangeMax: both ? extremeOrderChanceP(prevRaw.headOnKillRanges, currRaw.headOnKillRanges) : null,
      machMw: both ? mannWhitneyChanceP(prevRaw.machs, currRaw.machs) : null,
    });
  }
  const testKeys = ["pk", "killRangeMw", "killRangeMax", "hoRangeMax", "machMw"] as const;
  const flat: { pair: number; key: (typeof testKeys)[number]; p: number }[] = [];
  pairTests.forEach((t, pair) => {
    for (const key of testKeys) {
      const p = t[key];
      if (p !== null && Number.isFinite(p)) flat.push({ pair, key, p });
    }
  });
  const adjustedPs = holmAdjust(flat.map((f) => f.p));
  const adjusted: PairTests[] = pairTests.map(() => ({
    pk: null,
    killRangeMw: null,
    killRangeMax: null,
    hoRangeMax: null,
    machMw: null,
  }));
  flat.forEach((f, idx) => {
    (adjusted[f.pair] as PairTests)[f.key] = adjustedPs[idx] as number;
  });
  const familySize = flat.length;

  const formatChanceNote = (p: number, n1: number, n2: number, unitLabel: string): string => {
    const base = `adjusted p=${p < 0.05 ? p.toFixed(3) : p.toFixed(2)} over ${familySize} test${familySize === 1 ? "" : "s"}, n=${n1} vs ${n2} ${unitLabel}`;
    if (p < 0.05) return `${base} — Statistically significant`;
    if (p < 0.15) return `${base} — Borderline / trend`;
    return `${base} — Consistent with noise`;
  };

  // Pass 2: alerts from the adjusted p-values.
  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1] as CohortStats;
    const curr = valid[i] as CohortStats;
    const adj = adjusted[i - 1] as PairTests;
    const pPk = adj.pk;
    const pKillRangeMax = adj.killRangeMax;
    const pHoRangeMax = adj.hoRangeMax;
    const pMachMw = adj.machMw;

    const candidatePs = testKeys
      .map((k) => adj[k])
      .filter((p): p is number => p !== null && Number.isFinite(p));
    curr.vsPrevChanceP = candidatePs.length > 0 ? Math.min(...candidatePs) : null;

    if (prev.maxKillRangeM !== null && curr.maxKillRangeM !== null) {
      const deltaNm = (curr.maxKillRangeM - prev.maxKillRangeM) / NM;
      if (Math.abs(deltaNm) >= 5) {
        const chanceProb = pKillRangeMax ?? 1;
        const isSig = chanceProb < 0.1;
        alerts.push({
          fromCohort: prev.label,
          toCohort: curr.label,
          severity: !isSig ? "info" : Math.abs(deltaNm) >= 10 ? "major" : "notable",
          summary: `Max kill range shifted ${deltaNm > 0 ? "+" : ""}${deltaNm.toFixed(1)} nm (${(prev.maxKillRangeM / NM).toFixed(1)} nm → ${(curr.maxKillRangeM / NM).toFixed(1)} nm)`,
          chanceProb,
          isStatisticallySignificant: isSig,
          chanceNote: formatChanceNote(chanceProb, prev.kills, curr.kills, "kills"),
        });
      }
    }

    if (prev.headOnMaxKillRangeM !== null && curr.headOnMaxKillRangeM !== null) {
      const deltaHoNm = (curr.headOnMaxKillRangeM - prev.headOnMaxKillRangeM) / NM;
      if (Math.abs(deltaHoNm) >= 4) {
        const chanceProb = pHoRangeMax ?? 1;
        const isSig = chanceProb < 0.1;
        alerts.push({
          fromCohort: prev.label,
          toCohort: curr.label,
          severity: !isSig ? "info" : Math.abs(deltaHoNm) >= 8 ? "major" : "notable",
          summary: `Head-on max kill range shifted ${deltaHoNm > 0 ? "+" : ""}${deltaHoNm.toFixed(1)} nm (${(prev.headOnMaxKillRangeM / NM).toFixed(1)} nm → ${(curr.headOnMaxKillRangeM / NM).toFixed(1)} nm)`,
          chanceProb,
          isStatisticallySignificant: isSig,
          chanceNote: formatChanceNote(chanceProb, prev.headOnKills, curr.headOnKills, "head-on kills"),
        });
      }
    }

    if (prev.pk !== null && curr.pk !== null && prev.shots >= 5 && curr.shots >= 5) {
      const deltaPk = (curr.pk - prev.pk) * 100;
      if (Math.abs(deltaPk) >= 15) {
        const chanceProb = pPk ?? 1;
        const isSig = chanceProb < 0.1;
        alerts.push({
          fromCohort: prev.label,
          toCohort: curr.label,
          severity: !isSig ? "info" : Math.abs(deltaPk) >= 25 ? "major" : "notable",
          summary: `Overall Pk shifted ${deltaPk > 0 ? "+" : ""}${Math.round(deltaPk)} percentage points (${Math.round(prev.pk * 100)}% → ${Math.round(curr.pk * 100)}%)`,
          chanceProb,
          isStatisticallySignificant: isSig,
          chanceNote: formatChanceNote(chanceProb, prev.shots, curr.shots, "shots"),
        });
      }
    }

    if (prev.medianMaxMach !== null && curr.medianMaxMach !== null) {
      const deltaMach = curr.medianMaxMach - prev.medianMaxMach;
      if (Math.abs(deltaMach) >= 0.25) {
        const chanceProb = pMachMw ?? 1;
        const isSig = chanceProb < 0.1;
        alerts.push({
          fromCohort: prev.label,
          toCohort: curr.label,
          severity: !isSig ? "info" : "notable",
          summary: `Median peak missile speed shifted ${deltaMach > 0 ? "+" : ""}${deltaMach.toFixed(2)} Mach (M${prev.medianMaxMach.toFixed(2)} → M${curr.medianMaxMach.toFixed(2)})`,
          chanceProb,
          isStatisticallySignificant: isSig,
          chanceNote: formatChanceNote(chanceProb, prev.shots, curr.shots, "shots"),
        });
      }
    }
  }

  return { cohorts, alerts };
}

/**
 * Pilot Report Card across all matching engagements.
 */
export interface PilotReport {
  pilot: string;
  aircraft: string;
  shots: number;
  bvrShots: number;
  kills: number;
  pk: number | null;
  medianLaunchRangeM: number | null;
  medianFPoleM: number | null;
  medianCrankDeg: number | null;
  timesTargeted: number;
  deaths: number;
  diedUnawareCount: number;
  survivalRate: number | null;
  medianReactionTimeS: number | null;
}

export function buildPilotReports(
  engagements: MissileEngagement[],
  tacticsById: Map<string, ShotTacticalMetrics>,
): PilotReport[] {
  interface Acc {
    aircraftCounts: Map<string, number>;
    shots: number;
    bvrShots: number;
    kills: number;
    launchRanges: number[];
    fPoles: number[];
    cranks: number[];
    timesTargeted: number;
    deaths: number;
    diedUnawareCount: number;
    reactionTimes: number[];
  }
  const map = new Map<string, Acc>();
  const get = (pilot: string): Acc => {
    let a = map.get(pilot);
    if (!a) {
      a = {
        aircraftCounts: new Map(),
        shots: 0,
        bvrShots: 0,
        kills: 0,
        launchRanges: [],
        fPoles: [],
        cranks: [],
        timesTargeted: 0,
        deaths: 0,
        diedUnawareCount: 0,
        reactionTimes: [],
      };
      map.set(pilot, a);
    }
    return a;
  };

  for (const e of engagements) {
    const tac = tacticsById.get(e.id);
    if (e.shooter?.pilot) {
      const s = get(e.shooter.pilot);
      s.shots++;
      if (e.shooter.name) {
        s.aircraftCounts.set(e.shooter.name, (s.aircraftCounts.get(e.shooter.name) ?? 0) + 1);
      }
      if ((e.initial?.slantRangeM ?? 0) >= BVR_RANGE_M) s.bvrShots++;
      if (e.isKill) s.kills++;
      if (e.initial) s.launchRanges.push(e.initial.slantRangeM);
      if (e.fPoleRangeM !== null) s.fPoles.push(e.fPoleRangeM);
      if (tac?.maxShooterCrankDeg !== null && tac?.maxShooterCrankDeg !== undefined) {
        s.cranks.push(tac.maxShooterCrankDeg);
      }
    }
    if (e.target?.pilot) {
      const t = get(e.target.pilot);
      t.timesTargeted++;
      if (e.target.name) {
        t.aircraftCounts.set(e.target.name, (t.aircraftCounts.get(e.target.name) ?? 0) + 1);
      }
      if (e.isKill) t.deaths++;
      if (tac?.diedUnaware) t.diedUnawareCount++;
      if (tac?.reactionTimeS !== null && tac?.reactionTimeS !== undefined) {
        t.reactionTimes.push(tac.reactionTimeS);
      }
    }
  }

  return [...map.entries()]
    .map(([pilot, a]) => {
      a.launchRanges.sort((x, y) => x - y);
      a.fPoles.sort((x, y) => x - y);
      a.cranks.sort((x, y) => x - y);
      a.reactionTimes.sort((x, y) => x - y);
      let topAc = "";
      let topCnt = 0;
      for (const [ac, c] of a.aircraftCounts) {
        if (c > topCnt) {
          topAc = ac;
          topCnt = c;
        }
      }
      return {
        pilot,
        aircraft: topAc,
        shots: a.shots,
        bvrShots: a.bvrShots,
        kills: a.kills,
        pk: a.shots > 0 ? a.kills / a.shots : null,
        medianLaunchRangeM: percentile(a.launchRanges, 0.5),
        medianFPoleM: percentile(a.fPoles, 0.5),
        medianCrankDeg: percentile(a.cranks, 0.5),
        timesTargeted: a.timesTargeted,
        deaths: a.deaths,
        diedUnawareCount: a.diedUnawareCount,
        survivalRate: a.timesTargeted > 0 ? (a.timesTargeted - a.deaths) / a.timesTargeted : null,
        medianReactionTimeS: percentile(a.reactionTimes, 0.5),
      };
    })
    .filter((p) => p.shots + p.timesTargeted > 0)
    .sort((a, b) => b.kills - a.kills || b.shots - a.shots || b.timesTargeted - a.timesTargeted);
}

/** Deduplicate loaded files by `meta.sessionKey`, keeping the first occurrence. */
export function deduplicateFiles(files: FileAnalytics[]): {
  unique: FileAnalytics[];
  duplicateIds: Set<string>;
} {
  const seen = new Set<string>();
  const unique: FileAnalytics[] = [];
  const duplicateIds = new Set<string>();
  for (const f of files) {
    const key = f.meta?.sessionKey || f.fileId;
    if (seen.has(key)) {
      duplicateIds.add(f.fileId);
    } else {
      seen.add(key);
      unique.push(f);
    }
  }
  return { unique, duplicateIds };
}

export { mean };
