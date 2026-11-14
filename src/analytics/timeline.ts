import { fit1DLogistic, type ShotTacticalMetrics, wilsonInterval } from "./derive.ts";
import type { MissileEngagement } from "./model.ts";
import { percentile } from "./query.ts";

export const NM_TO_M = 1852;

export type BvrThreatTier = "IR/SAR-1" | "SAR-2" | "AR-1" | "AR-2";

export const THREAT_TIER_ORDER: BvrThreatTier[] = ["IR/SAR-1", "SAR-2", "AR-1", "AR-2"];

export const THREAT_TIER_META: Record<
  BvrThreatTier,
  {
    title: string;
    subtitle: string;
    chartAircraft: string;
    typicalWeapons: string;
  }
> = {
  "IR/SAR-1": {
    title: "IR/SAR-1",
    subtitle: "Gen-1 SARH / WVR IR",
    chartAircraft: "MiG-25, MiG-21, MiG-23, MiG-27",
    typicalWeapons: "R-23/24, R-40, R-60, R-73, AIM-9, AIM-7E",
  },
  "SAR-2": {
    title: "SAR-2",
    subtitle: "Long-Range Fox-1 SARH",
    chartAircraft: "MiG-29, Su-27, Su-30, Su-33, MiG-31",
    typicalWeapons: "R-27ER/ET/R, AIM-7M/MH, Super 530D",
  },
  "AR-1": {
    title: "AR-1",
    subtitle: "Early / Gen-1 Fox-3 ARH",
    chartAircraft: "MiG-29S, MiG-31, Su-30/34",
    typicalWeapons: "R-77 (RVV-AE), R-33",
  },
  "AR-2": {
    title: "AR-2",
    subtitle: "Modern High-Energy Fox-3",
    chartAircraft: "F-16, F-14, F-15, F/A-18, JF-17, J-11",
    typicalWeapons: "AIM-120C/B, AIM-54, SD-10 / PL-12, R-37",
  },
};

export interface BvrTimelineColumn {
  /** MAX AERO of threat (nm) */
  threatRangeNm: number;
  /** Offensive Factor Range (nm) */
  ofrNm: number;
  /** Defensive Factor Range (nm) */
  dfrNm: number;
  /** No Later Than Commit (nm) */
  nltCommitNm: number;
  /** Pump / Deploy Range (nm) */
  pumpNm: number;
  /** Tactical Range Call (nm) */
  tacRangeNm: number;
  /** Meld & Sort / TWS Targeting (nm) */
  meldSortNm: number;
  /** First Shot Range — Employ on timeline regardless (nm) */
  nltSrNm: number;
  /** Minimum Out Range — Drag defence - 10 Second drag (nm) */
  morNm: number;
  /** Minimum Reattack and Recommit (nm) */
  mrarNm: number;
  /** Minimum Defend Range — Notch Defense (nm) */
  drNm: number;
  /** Last Shot Range — 45 deg ATA shot to immediate Abort or Banzai (nm) */
  lsrNm: number;
  /** Minimum Abort Range — Inside BANZAI KILL KILL KILL (nm) */
  marNm: number;
  /** Minimum Stern WEZ — Employ Staggerback or Die (nm) */
  sternWezNm: number;
}

export type BvrTimelineTable = Record<BvrThreatTier, BvrTimelineColumn>;

export type BvrTimelineRowKey = keyof BvrTimelineColumn;

export interface BvrTimelineRowMeta {
  key: BvrTimelineRowKey;
  code: string;
  description: string;
  section: "factors" | "commit" | "combat";
  /** True if this row has a direct empirical weapon/defense hypothesis test in ACMI data */
  directlyTestable: boolean;
  hasStrikeFighterStar?: boolean;
}

export const BVR_TIMELINE_ROWS: BvrTimelineRowMeta[] = [
  {
    key: "threatRangeNm",
    code: "THREAT RANGE",
    description: "MAX AERO of threat — empirical 95th-pct / max lethal launch range",
    section: "factors",
    directlyTestable: true,
  },
  {
    key: "ofrNm",
    code: "OFR",
    description: "Offensive Factor Range — Commit to merge, destroy, and be on timeline for 2nd group",
    section: "factors",
    directlyTestable: false,
  },
  {
    key: "dfrNm",
    code: "DFR",
    description: "Defensive Factor Range — Commit to merge, destroy, and abort safely from 2nd group",
    section: "factors",
    directlyTestable: false,
  },
  {
    key: "nltCommitNm",
    code: "NLT COMMIT",
    description: "No Later Than Commit",
    section: "commit",
    directlyTestable: false,
  },
  {
    key: "pumpNm",
    code: "PUMP",
    description: "PUMP / Deploy Range (>M0.95 at 35,000')",
    section: "commit",
    directlyTestable: false,
  },
  {
    key: "tacRangeNm",
    code: "TAC RANGE",
    description: "Tactical Range Call — Ensures everyone is seeing the same thing",
    section: "commit",
    directlyTestable: false,
  },
  {
    key: "meldSortNm",
    code: "MELD & SORT",
    description: "TWS / Targeting / Sort Tree",
    section: "commit",
    directlyTestable: false,
  },
  {
    key: "nltSrNm",
    code: "NLT SR",
    description: "First Shot Range — Employ on timeline regardless (forces bandit defensive or kills)",
    section: "combat",
    directlyTestable: true,
    hasStrikeFighterStar: true,
  },
  {
    key: "morNm",
    code: "MOR",
    description: "Minimum Out Range — Drag defence (10s cold drag defeats missile kinematically)",
    section: "combat",
    directlyTestable: true,
    hasStrikeFighterStar: true,
  },
  {
    key: "mrarNm",
    code: "MRAR",
    description: "Minimum Reattack and Recommit — Configure radar for quick acquisition on recommit",
    section: "combat",
    directlyTestable: false,
  },
  {
    key: "drNm",
    code: "DR",
    description: "Minimum Defend Range — Notch Defense — Inside commit to Banzai or Abort",
    section: "combat",
    directlyTestable: true,
  },
  {
    key: "lsrNm",
    code: "LSR",
    description: "Last Shot Range — 45° ATA crank shot to immediate Abort mechanics or Banzai",
    section: "combat",
    directlyTestable: true,
  },
  {
    key: "marNm",
    code: "MAR",
    description: "Minimum Abort Range — Inside BANZAI! Below MAR, cold abort fails to outrun missile",
    section: "combat",
    directlyTestable: true,
  },
  {
    key: "sternWezNm",
    code: "STERN WEZ",
    description: "Minimum Stern WEZ — Tail-chase no-escape zone (Employ Staggerback or Die!)",
    section: "combat",
    directlyTestable: true,
  },
];

/**
 * Exact baseline numbers from the circulated F/A-18C BVR Timeline chart (in nautical miles).
 */
export const DEFAULT_MILSIM_TIMELINE: BvrTimelineTable = {
  "IR/SAR-1": {
    threatRangeNm: 15,
    ofrNm: 32,
    dfrNm: 18,
    nltCommitNm: 55,
    pumpNm: 50,
    tacRangeNm: 42,
    meldSortNm: 32,
    nltSrNm: 25,
    morNm: 13,
    mrarNm: 11,
    drNm: 10,
    lsrNm: 9,
    marNm: 8,
    sternWezNm: 4,
  },
  "SAR-2": {
    threatRangeNm: 25,
    ofrNm: 42,
    dfrNm: 28,
    nltCommitNm: 65,
    pumpNm: 60,
    tacRangeNm: 55,
    meldSortNm: 45,
    nltSrNm: 35,
    morNm: 23,
    mrarNm: 16,
    drNm: 15,
    lsrNm: 14,
    marNm: 12,
    sternWezNm: 7,
  },
  "AR-1": {
    threatRangeNm: 35,
    ofrNm: 47,
    dfrNm: 38,
    nltCommitNm: 70,
    pumpNm: 65,
    tacRangeNm: 60,
    meldSortNm: 45,
    nltSrNm: 38,
    morNm: 33,
    mrarNm: 21,
    drNm: 20,
    lsrNm: 17,
    marNm: 15,
    sternWezNm: 9,
  },
  "AR-2": {
    threatRangeNm: 38,
    ofrNm: 49,
    dfrNm: 40,
    nltCommitNm: 75,
    pumpNm: 65,
    tacRangeNm: 63,
    meldSortNm: 45,
    nltSrNm: 38,
    morNm: 37,
    mrarNm: 25,
    drNm: 23,
    lsrNm: 21,
    marNm: 18,
    sternWezNm: 11,
  },
};

/** Rows that move with the threat missile's head-on reach. */
export const HOT_REACH_ROWS: BvrTimelineRowKey[] = ["threatRangeNm", "nltSrNm"];
/** Rows that move with the threat missile's no-escape (tail-chase) reach. */
export const COLD_REACH_ROWS: BvrTimelineRowKey[] = [
  "morNm",
  "mrarNm",
  "drNm",
  "lsrNm",
  "marNm",
  "sternWezNm",
];

/**
 * Scales a table's kinematic gates by per-tier reach ratios (fitted reach at the band altitude ÷ reach at
 * the chart's altitude). Radar and decision gates (OFR, DFR, commit, pump, tac range, meld) stay as they
 * are. Values round to 0.5 nm.
 */
export function scaleTimelineTable(
  table: BvrTimelineTable,
  scales: Record<BvrThreatTier, { hot: number; cold: number } | null>,
): BvrTimelineTable {
  const out = cloneTimelineTable(table);
  const r = (v: number) => Math.max(0.5, Math.round(v * 2) / 2);
  for (const tier of THREAT_TIER_ORDER) {
    const s = scales[tier];
    if (!s) continue;
    for (const k of HOT_REACH_ROWS) out[tier][k] = r(table[tier][k] * s.hot);
    for (const k of COLD_REACH_ROWS) out[tier][k] = r(table[tier][k] * s.cold);
  }
  return out;
}

export function cloneTimelineTable(table: BvrTimelineTable): BvrTimelineTable {
  return {
    "IR/SAR-1": { ...table["IR/SAR-1"] },
    "SAR-2": { ...table["SAR-2"] },
    "AR-1": { ...table["AR-1"] },
    "AR-2": { ...table["AR-2"] },
  };
}

/**
 * Classify an engagement into one of the 4 mil-sim BVR Threat Tiers (`IR/SAR-1`, `SAR-2`, `AR-1`, `AR-2`)
 * using both the weapon fired and the shooter's aircraft type.
 */
export function classifyThreatTier(e: MissileEngagement): BvrThreatTier | null {
  if (e.domain !== "A2A" || e.isGun) return null;
  const w = e.weaponName.toUpperCase();
  const ac = (e.shooter?.name ?? "").toUpperCase();

  // 1. Active Radar Homing (Fox-3) splits into AR-1 (R-77 / R-33) vs AR-2 (AIM-120 / AIM-54 / SD-10 / PL-12 / R-37)
  if (e.weaponClass === "A2A-ARH") {
    if (
      w.includes("77") ||
      w.includes("RVV") ||
      w.includes("R-33") ||
      w.includes("R_33") ||
      w.includes("R33") ||
      w.includes("MICA")
    ) {
      return "AR-1";
    }
    return "AR-2";
  }

  // 2. Semi-Active Radar Homing (Fox-1) splits into SAR-1 (R-23/24/40, AIM-7E) vs SAR-2 (R-27ER/R, AIM-7M/MH, 530D)
  if (e.weaponClass === "A2A-SARH") {
    if (
      w.includes("R-23") ||
      w.includes("R_23") ||
      w.includes("R-24") ||
      w.includes("R_24") ||
      w.includes("R-40") ||
      w.includes("R_40") ||
      w.includes("AIM-7E") ||
      w.includes("AIM_7E") ||
      w.includes("R-3R") ||
      ac.includes("MIG-21") ||
      ac.includes("MIG-23") ||
      ac.includes("MIG-25")
    ) {
      return "IR/SAR-1";
    }
    return "SAR-2";
  }

  // 3. Long-range IR (R-27ET / R-27T) belongs to the SAR-2 Flanker/Fulcrum BVR stick
  if (e.weaponClass === "A2A-IR") {
    if (w.includes("27ET") || w.includes("27T")) {
      return "SAR-2";
    }
    return "IR/SAR-1";
  }

  return null;
}

export type GateVerdictStatus = "valid" | "optimistic" | "conservative" | "low-data";

export interface ThreatTierValidation {
  tier: BvrThreatTier;
  shots: number;
  bvrShots: number;
  kills: number;
  pk: number | null;

  /** 1. THREAT RANGE (MAX AERO) validation */
  p95KillRangeNm: number | null;
  maxKillRangeNm: number | null;
  killsBeyondThreatRange: number;
  beyondThreatKillShare: number | null;
  shotsBeyondThreatRange: number;
  beyondThreatPk: number | null;
  threatRangeVerdict: GateVerdictStatus;
  threatRangeNote: string;

  /** 2. NLT SR (First Shot Range) validation */
  nltSrWindowShots: number;
  nltSrWindowKills: number;
  nltSrWindowPk: number | null;
  /** Fraction of targets shot at around NLT SR (>= 0.85 * NLT SR) that either died or were forced to maneuver/defend */
  nltSrForcedDefenseRate: number | null;
  nltSrVerdict: GateVerdictStatus;
  nltSrNote: string;

  /** 3. MOR (Minimum Out Range — 10s Cold Drag Defense) validation */
  morOutsideShots: number;
  morOutsideSurvived: number;
  morOutsideSurvivalRate: number | null;
  morInsideShots: number;
  morInsideSurvived: number;
  morInsideSurvivalRate: number | null;
  morVerdict: GateVerdictStatus;
  morNote: string;

  /** 4. DR (Minimum Defend Range — Notch Defense) validation */
  drOutsideShots: number;
  drOutsideSurvived: number;
  drOutsideSurvivalRate: number | null;
  drInsideShots: number;
  drInsideSurvived: number;
  drInsideSurvivalRate: number | null;
  drVerdict: GateVerdictStatus;
  drNote: string;

  /** 5. LSR (Last Shot Range — Commit / Crank Follow-up Shot) validation */
  lsrBandShots: number;
  lsrBandKills: number;
  lsrBandPk: number | null;

  /** 6. MAR (Minimum Abort Range) validation */
  marOutsideShots: number;
  marOutsideSurvived: number;
  marOutsideSurvivalRate: number | null;
  marOutsideCi: { lo: number; hi: number } | null;
  marInsideShots: number;
  marInsideSurvived: number;
  marInsideSurvivalRate: number | null;
  marInsideCi: { lo: number; hi: number } | null;
  /** Survival drop when crossing inside MAR: P(survive | >= MAR) - P(survive | < MAR) */
  marSurvivalCliff: number | null;
  marVerdict: GateVerdictStatus;
  marNote: string;

  /** 7. STERN WEZ (Tail-Chase No-Escape Zone) validation */
  sternInsideShots: number;
  sternInsideKills: number;
  sternInsidePk: number | null;
  sternOutsideShots: number;
  sternOutsideKills: number;
  sternOutsidePk: number | null;
  sternVerdict: GateVerdictStatus;
  sternNote: string;

  /** Empirical MLE + Bayesian posterior estimates for this tier */
  mleColumn: BvrTimelineColumn;
  posteriorColumn: BvrTimelineColumn;
  /** Data weight n / (n + k0) in [0, 1] used for the posterior blend */
  dataWeight: number;
}

/**
 * Solve for x where sigmoid(b0 + b1 * x) = targetProb, clamped to [minVal, maxVal].
 */
function logisticThresholdAtProb(
  xs: number[],
  ys: number[],
  targetProb: number,
  minVal: number,
  maxVal: number,
  requirePositiveSlope = true,
): number | null {
  if (xs.length < 5) return null;
  const pos = ys.filter((y) => y > 0.5).length;
  if (pos === 0 || pos === ys.length) return null;
  const { b0, b1 } = fit1DLogistic(xs, ys);
  if (requirePositiveSlope && b1 <= 0.008) return null;
  if (!requirePositiveSlope && b1 >= -0.008) return null;
  const logit = Math.log(targetProb / (1 - targetProb));
  const xStar = (logit - b0) / b1;
  if (!Number.isFinite(xStar)) return null;
  return Math.max(minVal, Math.min(maxVal, xStar));
}

/**
 * Validate a BVR Timeline Table against observed ACMI engagements and compute both:
 * 1. Statistical hypothesis test results for each range gate (`THREAT RANGE`, `NLT SR`, `MOR`, `DR`, `LSR`, `MAR`, `STERN WEZ`), and
 * 2. Classical ML / Empirical Bayes optimized timeline numbers (`posteriorColumn`), using `priorTable` (defaulting to the
 *    circulated F/A-18C chart) as the Bayesian prior when sample size is small.
 */
export function evaluateBvrTimeline(
  engagements: MissileEngagement[],
  tacticsById: Map<string, ShotTacticalMetrics>,
  activeTable: BvrTimelineTable,
  options: {
    strikeFighterAdd2Nm?: boolean;
    priorWeight?: number;
    highAltOnly?: boolean;
    /** Keep only shots whose mean shooter/target launch altitude falls in [minFt, maxFt). */
    altBandFt?: { minFt: number; maxFt: number };
    priorTable?: BvrTimelineTable;
  } = {},
): Record<BvrThreatTier, ThreatTierValidation> {
  const strikeBonus = options.strikeFighterAdd2Nm ? 2 : 0;
  const k0 = Math.max(0, options.priorWeight ?? 8);
  const priorTable = options.priorTable ?? DEFAULT_MILSIM_TIMELINE;

  const byTier: Record<BvrThreatTier, MissileEngagement[]> = {
    "IR/SAR-1": [],
    "SAR-2": [],
    "AR-1": [],
    "AR-2": [],
  };

  for (const e of engagements) {
    if (!e.initial) continue;
    if (options.altBandFt) {
      const meanFt = e.initial.meanAltM / 0.3048;
      if (meanFt < options.altBandFt.minFt || meanFt >= options.altBandFt.maxFt) continue;
    }
    if (options.highAltOnly) {
      const sAlt = e.shooter?.altM ?? 0;
      const tAlt = e.target?.altM ?? 0;
      // Filter to BVR medium/high altitude envelope (>= 18,000 ft / 5486 m) when requested
      if (Math.max(sAlt, tAlt) < 5486) continue;
    }
    const tier = classifyThreatTier(e);
    if (tier) byTier[tier].push(e);
  }

  const out = {} as Record<BvrThreatTier, ThreatTierValidation>;

  for (const tier of THREAT_TIER_ORDER) {
    const list = byTier[tier];
    const baseCol = activeTable[tier];
    const priorCol = priorTable[tier];

    const effNltSrNm = baseCol.nltSrNm + strikeBonus;
    const effMorNm = baseCol.morNm + strikeBonus;

    const shots = list.length;
    const bvrShots = list.filter((e) => (e.initial?.slantRangeM ?? 0) >= 10 * NM_TO_M).length;
    const killsList = list.filter((e) => e.isKill);
    const kills = killsList.length;
    const pk = shots > 0 ? kills / shots : null;

    // 1. THREAT RANGE (MAX AERO)
    const killRangesNm = killsList
      .map((e) => (e.initial?.slantRangeM ?? 0) / NM_TO_M)
      .filter((r) => r > 0)
      .sort((a, b) => a - b);
    const p95KillRangeNm = percentile(killRangesNm, 0.95);
    const maxKillRangeNm = killRangesNm.length > 0 ? killRangesNm[killRangesNm.length - 1]! : null;
    const killsBeyondThreatRange = killRangesNm.filter((r) => r > baseCol.threatRangeNm).length;
    const beyondThreatKillShare = kills > 0 ? killsBeyondThreatRange / kills : null;
    const shotsBeyondList = list.filter(
      (e) => (e.initial?.slantRangeM ?? 0) / NM_TO_M > baseCol.threatRangeNm,
    );
    const shotsBeyondThreatRange = shotsBeyondList.length;
    const beyondThreatPk =
      shotsBeyondThreatRange > 0
        ? shotsBeyondList.filter((e) => e.isKill).length / shotsBeyondThreatRange
        : null;

    let threatRangeVerdict: GateVerdictStatus = "low-data";
    let threatRangeNote = "Need >= 4 kills to test Max Aero range";
    if (kills >= 4 && p95KillRangeNm !== null && maxKillRangeNm !== null) {
      if (maxKillRangeNm > baseCol.threatRangeNm + 2 && (beyondThreatKillShare ?? 0) >= 0.1) {
        threatRangeVerdict = "optimistic";
        threatRangeNote = `Underestimates threat! ${killsBeyondThreatRange} kill(s) (${Math.round((beyondThreatKillShare ?? 0) * 100)}%) occurred beyond ${baseCol.threatRangeNm} nm (95th-pct ${p95KillRangeNm.toFixed(1)} nm, max ${maxKillRangeNm.toFixed(1)} nm).`;
      } else if (p95KillRangeNm < baseCol.threatRangeNm - 6 && shots >= 12) {
        threatRangeVerdict = "conservative";
        threatRangeNote = `Conservative by ~${(baseCol.threatRangeNm - p95KillRangeNm).toFixed(1)} nm: 95% of observed kills were <= ${p95KillRangeNm.toFixed(1)} nm (max ${maxKillRangeNm.toFixed(1)} nm).`;
      } else {
        threatRangeVerdict = "valid";
        threatRangeNote = `Matches empirical envelope: 95th-pct kill range is ${p95KillRangeNm.toFixed(1)} nm (max ${maxKillRangeNm.toFixed(1)} nm).`;
      }
    }

    // 2. NLT SR (First Shot Range) — test shots fired >= 0.85 * effNltSrNm
    const nltSrWindowList = list.filter((e) => {
      const rNm = (e.initial?.slantRangeM ?? 0) / NM_TO_M;
      return rNm >= effNltSrNm * 0.85 && rNm <= effNltSrNm * 1.25;
    });
    const nltSrWindowShots = nltSrWindowList.length;
    const nltSrWindowKills = nltSrWindowList.filter((e) => e.isKill).length;
    const nltSrWindowPk = nltSrWindowShots > 0 ? nltSrWindowKills / nltSrWindowShots : null;
    const nltSrForcedCount = nltSrWindowList.filter((e) => {
      const tac = tacticsById.get(e.id);
      return e.isKill || (tac !== undefined && tac.defenseType !== "none");
    }).length;
    const nltSrForcedDefenseRate = nltSrWindowShots > 0 ? nltSrForcedCount / nltSrWindowShots : null;

    let nltSrVerdict: GateVerdictStatus = "low-data";
    let nltSrNote = "No shots observed near NLT SR window";
    if (nltSrWindowShots >= 4 && nltSrForcedDefenseRate !== null && nltSrWindowPk !== null) {
      if (nltSrForcedDefenseRate >= 0.55 || nltSrWindowPk >= 0.15) {
        nltSrVerdict = "valid";
        nltSrNote = `Effective timeline shot: ${Math.round(nltSrWindowPk * 100)}% Pk and ${Math.round(nltSrForcedDefenseRate * 100)}% forced bandit defense/kill (n=${nltSrWindowShots}).`;
      } else {
        nltSrVerdict = "optimistic";
        nltSrNote = `Low impact at ${effNltSrNm} nm: only ${Math.round(nltSrWindowPk * 100)}% Pk and ${Math.round(nltSrForcedDefenseRate * 100)}% forced reaction (n=${nltSrWindowShots}).`;
      }
    }

    // 3. MOR (Minimum Out Range — Cold / Drag Defense)
    const coldList: { rangeNm: number; survived: number }[] = [];
    for (const e of list) {
      const tac = tacticsById.get(e.id);
      if (!tac) continue;
      if (tac.defenseType === "cold" || tac.coldTurnRangeM !== null) {
        const rM = tac.coldTurnRangeM ?? tac.reactionRangeM ?? e.initial?.slantRangeM ?? null;
        if (rM !== null && rM > 0) {
          coldList.push({ rangeNm: rM / NM_TO_M, survived: e.isKill ? 0 : 1 });
        }
      }
    }
    const morOutside = coldList.filter((x) => x.rangeNm >= effMorNm);
    const morInside = coldList.filter((x) => x.rangeNm < effMorNm);
    const morOutsideShots = morOutside.length;
    const morOutsideSurvived = morOutside.reduce((s, x) => s + x.survived, 0);
    const morOutsideSurvivalRate = morOutsideShots > 0 ? morOutsideSurvived / morOutsideShots : null;
    const morInsideShots = morInside.length;
    const morInsideSurvived = morInside.reduce((s, x) => s + x.survived, 0);
    const morInsideSurvivalRate = morInsideShots > 0 ? morInsideSurvived / morInsideShots : null;

    let morVerdict: GateVerdictStatus = "low-data";
    let morNote = "Need >= 4 cold/drag defenses to validate MOR";
    if (coldList.length >= 4) {
      if (morOutsideShots >= 3 && morOutsideSurvivalRate !== null) {
        if (morOutsideSurvivalRate >= 0.85) {
          morVerdict = "valid";
          morNote = `Safe drag outside ${effMorNm} nm: ${Math.round(morOutsideSurvivalRate * 100)}% survival (${morOutsideSurvived}/${morOutsideShots})${morInsideSurvivalRate !== null ? ` vs ${Math.round(morInsideSurvivalRate * 100)}% inside MOR` : ""}.`;
        } else {
          morVerdict = "optimistic";
          morNote = `Dragging at ${effMorNm} nm is risky: only ${Math.round(morOutsideSurvivalRate * 100)}% survived outside MOR (${morOutsideSurvived}/${morOutsideShots}). Increase MOR!`;
        }
      } else if (morInsideShots >= 4 && morInsideSurvivalRate !== null) {
        if (morInsideSurvivalRate >= 0.88) {
          morVerdict = "conservative";
          morNote = `MOR (${effMorNm} nm) may be conservative: defenders dragging inside MOR still survived ${Math.round(morInsideSurvivalRate * 100)}% (${morInsideSurvived}/${morInsideShots}).`;
        } else {
          morVerdict = "valid";
          morNote = `Dragging inside ${effMorNm} nm had ${Math.round(morInsideSurvivalRate * 100)}% survival (${morInsideSurvived}/${morInsideShots}).`;
        }
      }
    }

    // 4. DR (Minimum Defend Range — Notch Defense)
    const notchList: { rangeNm: number; survived: number }[] = [];
    for (const e of list) {
      const tac = tacticsById.get(e.id);
      if (!tac) continue;
      if (tac.defenseType === "notch" || tac.notchEntryRangeM !== null || tac.timeInNotchS >= 1.0) {
        const rM = tac.notchEntryRangeM ?? tac.reactionRangeM ?? e.initial?.slantRangeM ?? null;
        if (rM !== null && rM > 0) {
          notchList.push({ rangeNm: rM / NM_TO_M, survived: e.isKill ? 0 : 1 });
        }
      }
    }
    const drOutside = notchList.filter((x) => x.rangeNm >= baseCol.drNm);
    const drInside = notchList.filter((x) => x.rangeNm < baseCol.drNm);
    const drOutsideShots = drOutside.length;
    const drOutsideSurvived = drOutside.reduce((s, x) => s + x.survived, 0);
    const drOutsideSurvivalRate = drOutsideShots > 0 ? drOutsideSurvived / drOutsideShots : null;
    const drInsideShots = drInside.length;
    const drInsideSurvived = drInside.reduce((s, x) => s + x.survived, 0);
    const drInsideSurvivalRate = drInsideShots > 0 ? drInsideSurvived / drInsideShots : null;

    let drVerdict: GateVerdictStatus = "low-data";
    let drNote = "Need >= 4 notch defenses to validate DR";
    if (notchList.length >= 4) {
      if (drOutsideShots >= 3 && drOutsideSurvivalRate !== null) {
        if (drOutsideSurvivalRate >= 0.75) {
          drVerdict = "valid";
          drNote = `Notching >= ${baseCol.drNm} nm yielded ${Math.round(drOutsideSurvivalRate * 100)}% survival (${drOutsideSurvived}/${drOutsideShots})${drInsideSurvivalRate !== null ? ` vs ${Math.round(drInsideSurvivalRate * 100)}% inside DR` : ""}.`;
        } else {
          drVerdict = "optimistic";
          drNote = `Notching >= ${baseCol.drNm} nm only yielded ${Math.round(drOutsideSurvivalRate * 100)}% survival (${drOutsideSurvived}/${drOutsideShots}).`;
        }
      } else if (drInsideShots >= 4 && drInsideSurvivalRate !== null) {
        drVerdict = drInsideSurvivalRate < 0.7 ? "valid" : "conservative";
        drNote = `Notching inside ${baseCol.drNm} nm yielded ${Math.round(drInsideSurvivalRate * 100)}% survival (${drInsideSurvived}/${drInsideShots}).`;
      }
    }

    // 5. LSR (Last Shot Range — offensive shots in [MAR, DR * 1.1])
    const lsrLo = Math.min(baseCol.marNm, baseCol.lsrNm - 2);
    const lsrHi = Math.max(baseCol.drNm, baseCol.lsrNm + 2);
    const lsrList = list.filter((e) => {
      const rNm = (e.initial?.slantRangeM ?? 0) / NM_TO_M;
      return rNm >= lsrLo && rNm <= lsrHi;
    });
    const lsrBandShots = lsrList.length;
    const lsrBandKills = lsrList.filter((e) => e.isKill).length;
    const lsrBandPk = lsrBandShots > 0 ? lsrBandKills / lsrBandShots : null;

    // 6. MAR (Minimum Abort Range — all active defenses: cold, notch, or break/dive maneuver)
    const activeDefList: { rangeNm: number; survived: number }[] = [];
    for (const e of list) {
      const tac = tacticsById.get(e.id);
      if (!tac) continue;
      if (tac.defenseType !== "none") {
        const rM = tac.coldTurnRangeM ?? reactionRangeFallback(tac, e) ?? e.initial?.slantRangeM ?? null;
        if (rM !== null && rM > 0) {
          activeDefList.push({ rangeNm: rM / NM_TO_M, survived: e.isKill ? 0 : 1 });
        }
      }
    }
    const marOutside = activeDefList.filter((x) => x.rangeNm >= baseCol.marNm);
    const marInside = activeDefList.filter((x) => x.rangeNm < baseCol.marNm);
    const marOutsideShots = marOutside.length;
    const marOutsideSurvived = marOutside.reduce((s, x) => s + x.survived, 0);
    const marOutsideSurvivalRate = marOutsideShots > 0 ? marOutsideSurvived / marOutsideShots : null;
    const marOutsideCi = wilsonInterval(marOutsideSurvived, marOutsideShots);

    const marInsideShots = marInside.length;
    const marInsideSurvived = marInside.reduce((s, x) => s + x.survived, 0);
    const marInsideSurvivalRate = marInsideShots > 0 ? marInsideSurvived / marInsideShots : null;
    const marInsideCi = wilsonInterval(marInsideSurvived, marInsideShots);

    const marSurvivalCliff =
      marOutsideSurvivalRate !== null && marInsideSurvivalRate !== null
        ? marOutsideSurvivalRate - marInsideSurvivalRate
        : null;

    let marVerdict: GateVerdictStatus = "low-data";
    let marNote = "Need >= 5 defended shots to test MAR boundary";
    if (activeDefList.length >= 5) {
      if (marOutsideShots >= 3 && marOutsideSurvivalRate !== null && marOutsideSurvivalRate < 0.72) {
        marVerdict = "optimistic";
        marNote = `Danger! Defending outside ${baseCol.marNm} nm only survived ${Math.round(marOutsideSurvivalRate * 100)}% (${marOutsideSurvived}/${marOutsideShots}). True MAR is farther out!`;
      } else if (
        marInsideShots >= 4 &&
        marInsideSurvivalRate !== null &&
        marInsideSurvivalRate > 0.82 &&
        (marSurvivalCliff ?? 0) < 0.08
      ) {
        marVerdict = "conservative";
        marNote = `Defenders inside ${baseCol.marNm} nm still survived ${Math.round(marInsideSurvivalRate * 100)}% (${marInsideSurvived}/${marInsideShots}); MAR could be pushed closer.`;
      } else {
        marVerdict = "valid";
        marNote = `Outside ${baseCol.marNm} nm: ${marOutsideSurvivalRate !== null ? `${Math.round(marOutsideSurvivalRate * 100)}%` : "–"} survival (${marOutsideSurvived}/${marOutsideShots}) vs Inside: ${marInsideSurvivalRate !== null ? `${Math.round(marInsideSurvivalRate * 100)}%` : "–"} (${marInsideSurvived}/${marInsideShots}).`;
      }
    }

    // 7. STERN WEZ (Tail-chase / Cold-target aspect < 60°)
    const sternList = list.filter((e) => {
      const tac = tacticsById.get(e.id);
      const initAspect = e.initial?.aspectDeg ?? 180;
      const minAspect = tac?.minMissileAspectDeg ?? initAspect;
      return initAspect <= 60 || minAspect <= 35;
    });
    const sternInside = sternList.filter(
      (e) => (e.initial?.slantRangeM ?? 0) / NM_TO_M <= baseCol.sternWezNm,
    );
    const sternOutside = sternList.filter(
      (e) => (e.initial?.slantRangeM ?? 0) / NM_TO_M > baseCol.sternWezNm,
    );
    const sternInsideShots = sternInside.length;
    const sternInsideKills = sternInside.filter((e) => e.isKill).length;
    const sternInsidePk = sternInsideShots > 0 ? sternInsideKills / sternInsideShots : null;
    const sternOutsideShots = sternOutside.length;
    const sternOutsideKills = sternOutside.filter((e) => e.isKill).length;
    const sternOutsidePk = sternOutsideShots > 0 ? sternOutsideKills / sternOutsideShots : null;

    let sternVerdict: GateVerdictStatus = "low-data";
    let sternNote = "Need >= 3 tail-chase shots to test Stern WEZ";
    if (sternList.length >= 3) {
      if (sternInsideShots >= 2 && sternInsidePk !== null) {
        sternVerdict = sternInsidePk >= 0.35 ? "valid" : "conservative";
        sternNote = `Tail-chase <= ${baseCol.sternWezNm} nm: ${Math.round(sternInsidePk * 100)}% Pk (${sternInsideKills}/${sternInsideShots})${sternOutsidePk !== null ? ` vs ${Math.round(sternOutsidePk * 100)}% outside` : ""}.`;
      } else {
        sternVerdict = "valid";
        sternNote = `Outside ${baseCol.sternWezNm} nm tail-chase Pk: ${sternOutsidePk !== null ? `${Math.round(sternOutsidePk * 100)}%` : "0%"} (${sternOutsideKills}/${sternOutsideShots}).`;
      }
    }

    // -------------------------------------------------------------------------
    // Classical ML + Empirical Bayes Auto-Derivation of Timeline Numbers
    // -------------------------------------------------------------------------
    const allLaunchRanges = list
      .map((e) => (e.initial?.slantRangeM ?? 0) / NM_TO_M)
      .filter((r) => r > 0)
      .sort((a, b) => a - b);

    // 1. Empirical Threat Range (Max Aero): 95th-percentile kill range (or 90th-pct launch range if few kills)
    const mleThreatRange =
      p95KillRangeNm !== null && kills >= 3
        ? p95KillRangeNm
        : (percentile(allLaunchRanges, 0.92) ?? priorCol.threatRangeNm);

    // 2. Empirical MAR: range where active-defense survival reaches ~80% (and inside which ~78% of defended deaths occur)
    const marLogistic = logisticThresholdAtProb(
      activeDefList.map((x) => x.rangeNm),
      activeDefList.map((x) => x.survived),
      0.8,
      4,
      45,
      true,
    );
    const killedDefendedRanges = activeDefList
      .filter((x) => x.survived === 0)
      .map((x) => x.rangeNm)
      .sort((a, b) => a - b);
    const marQuantile = percentile(killedDefendedRanges, 0.78);
    const mleMar =
      marLogistic !== null && marQuantile !== null
        ? 0.5 * marLogistic + 0.5 * marQuantile
        : (marQuantile ?? marLogistic ?? priorCol.marNm);

    // 3. Empirical MOR: range where cold/drag survival reaches ~92% (safe 10s drag without losing timeline)
    const morLogistic = logisticThresholdAtProb(
      coldList.map((x) => x.rangeNm),
      coldList.map((x) => x.survived),
      0.92,
      6,
      55,
      true,
    );
    const coldKilledRanges = coldList
      .filter((x) => x.survived === 0)
      .map((x) => x.rangeNm)
      .sort((a, b) => a - b);
    const morQuantile = percentile(coldKilledRanges, 0.92) ?? percentile(killedDefendedRanges, 0.92);
    const mleMor =
      morLogistic !== null && morQuantile !== null
        ? Math.max(mleMar + 5, 0.5 * morLogistic + 0.5 * morQuantile)
        : morQuantile !== null
          ? Math.max(mleMar + 5, morQuantile, mleThreatRange * 0.85)
          : priorCol.morNm;

    // 4. Empirical DR (Notch Defense Range): 85% notch survival / 85th-pct defended death boundary
    const drLogistic = logisticThresholdAtProb(
      notchList.map((x) => x.rangeNm),
      notchList.map((x) => x.survived),
      0.85,
      5,
      48,
      true,
    );
    const drQuantile = percentile(killedDefendedRanges, 0.85);
    const mleDr = drLogistic ?? drQuantile ?? Math.max(mleMar + 2, priorCol.drNm + (mleMar - priorCol.marNm));

    // 5. Empirical NLT SR (First Shot Range): 85th-percentile BVR launch range / forced-defense boundary
    const bvrLaunchRanges = allLaunchRanges.filter((r) => r >= 10);
    const mleNltSr =
      bvrLaunchRanges.length >= 4
        ? Math.max(mleThreatRange * 0.95, percentile(bvrLaunchRanges, 0.85) ?? priorCol.nltSrNm)
        : priorCol.nltSrNm;

    // 6. Empirical Stern WEZ: logistic 45% kill probability on tail-aspect shots
    const sternLogistic = logisticThresholdAtProb(
      sternList.map((e) => (e.initial?.slantRangeM ?? 0) / NM_TO_M),
      sternList.map((e) => (e.isKill ? 1 : 0)),
      0.45,
      2,
      25,
      false,
    );
    const sternKillRanges = sternList
      .filter((e) => e.isKill)
      .map((e) => (e.initial?.slantRangeM ?? 0) / NM_TO_M)
      .sort((a, b) => a - b);
    const mleStern =
      sternLogistic ??
      percentile(sternKillRanges, 0.85) ??
      Math.max(2, mleMar * (priorCol.sternWezNm / Math.max(1, priorCol.marNm)));

    const mleLsr = Math.round((mleMar * 0.55 + mleDr * 0.45) * 10) / 10;

    // Blending helper: posterior = (n * mle + k0 * prior) / (n + k0)
    const blend = (mleVal: number, priorVal: number, nEff: number): number => {
      const w = nEff / Math.max(1e-6, nEff + k0);
      return Math.round((w * mleVal + (1 - w) * priorVal) * 10) / 10;
    };

    const postThreatRange = blend(mleThreatRange, priorCol.threatRangeNm, kills * 2 + bvrShots * 0.25);
    const postMar = blend(mleMar, priorCol.marNm, activeDefList.length);
    const postDr = Math.max(
      postMar + 1.5,
      blend(mleDr, priorCol.drNm, notchList.length + activeDefList.length * 0.3),
    );
    const postLsr = Math.max(
      postMar + 0.8,
      Math.min(postDr - 0.5, blend(mleLsr, priorCol.lsrNm, activeDefList.length * 0.5)),
    );
    const postMor = Math.max(postDr + 2, blend(mleMor, priorCol.morNm, coldList.length + bvrShots * 0.25));
    const postNltSr = Math.max(postMor + 1, blend(mleNltSr, priorCol.nltSrNm, bvrShots));
    const postStern = Math.min(
      postMar - 1.5,
      Math.max(2, blend(mleStern, priorCol.sternWezNm, sternList.length)),
    );

    // Derived non-weapon planning rows preserve the mil-sim chart's structural spacing
    const threatDelta = postThreatRange - priorCol.threatRangeNm;
    const morDelta = postMor - priorCol.morNm;
    const drDelta = postDr - priorCol.drNm;

    const round1 = (v: number) => Math.round(v * 10) / 10;

    const posteriorColumn: BvrTimelineColumn = {
      threatRangeNm: round1(postThreatRange),
      ofrNm: round1(priorCol.ofrNm + threatDelta),
      dfrNm: round1(priorCol.dfrNm + threatDelta),
      nltCommitNm: round1(priorCol.nltCommitNm + threatDelta),
      pumpNm: round1(priorCol.pumpNm + threatDelta),
      tacRangeNm: round1(priorCol.tacRangeNm + threatDelta),
      meldSortNm: round1(Math.max(postNltSr + 4, priorCol.meldSortNm + threatDelta * 0.7)),
      nltSrNm: round1(postNltSr),
      morNm: round1(postMor),
      mrarNm: round1(Math.max(postDr + 1, priorCol.mrarNm + (drDelta + morDelta) * 0.5)),
      drNm: round1(postDr),
      lsrNm: round1(postLsr),
      marNm: round1(postMar),
      sternWezNm: round1(postStern),
    };

    const mleColumn: BvrTimelineColumn = {
      ...posteriorColumn,
      threatRangeNm: round1(mleThreatRange),
      nltSrNm: round1(mleNltSr),
      morNm: round1(mleMor),
      drNm: round1(mleDr),
      lsrNm: round1(mleLsr),
      marNm: round1(mleMar),
      sternWezNm: round1(mleStern),
    };

    const dataWeight = shots / Math.max(1e-6, shots + k0);

    out[tier] = {
      tier,
      shots,
      bvrShots,
      kills,
      pk,
      p95KillRangeNm,
      maxKillRangeNm,
      killsBeyondThreatRange,
      beyondThreatKillShare,
      shotsBeyondThreatRange,
      beyondThreatPk,
      threatRangeVerdict,
      threatRangeNote,
      nltSrWindowShots,
      nltSrWindowKills,
      nltSrWindowPk,
      nltSrForcedDefenseRate,
      nltSrVerdict,
      nltSrNote,
      morOutsideShots,
      morOutsideSurvived,
      morOutsideSurvivalRate,
      morInsideShots,
      morInsideSurvived,
      morInsideSurvivalRate,
      morVerdict,
      morNote,
      drOutsideShots,
      drOutsideSurvived,
      drOutsideSurvivalRate,
      drInsideShots,
      drInsideSurvived,
      drInsideSurvivalRate,
      drVerdict,
      drNote,
      lsrBandShots,
      lsrBandKills,
      lsrBandPk,
      marOutsideShots,
      marOutsideSurvived,
      marOutsideSurvivalRate,
      marOutsideCi,
      marInsideShots,
      marInsideSurvived,
      marInsideSurvivalRate,
      marInsideCi,
      marSurvivalCliff,
      marVerdict,
      marNote,
      sternInsideShots,
      sternInsideKills,
      sternInsidePk,
      sternOutsideShots,
      sternOutsideKills,
      sternOutsidePk,
      sternVerdict,
      sternNote,
      mleColumn,
      posteriorColumn,
      dataWeight,
    };
  }

  return out;
}

function reactionRangeFallback(tac: ShotTacticalMetrics, e: MissileEngagement): number | null {
  return tac.reactionRangeM ?? tac.notchEntryRangeM ?? e.initial?.slantRangeM ?? null;
}
