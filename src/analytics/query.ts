import { classifyAltitudeRelation } from "./extract.ts";
import {
  ALT_RELATION_ORDER,
  type AltitudeRelation,
  ASPECT_ORDER,
  type AspectCategory,
  type ClassificationThresholds,
  DEFAULT_THRESHOLDS,
  type EngagementDomain,
  type FileAnalytics,
  type MissileEngagement,
   type WeaponClass,
} from "./model.ts";

export interface AnalyticsQuery {
  /** Null means all loaded files are active; otherwise only fileIds in this list. */
  enabledFileIds: string[] | null;
  /** Domain filter: empty = all domains, or e.g. ["A2A"]. */
  domains: EngagementDomain[];
  /** Weapon class filter: empty = all classes. */
  weaponClasses: WeaponClass[];
  /** Specific weapon display names: empty = all weapons. */
  weaponNames: string[];
  /** Aspect categories: empty = all aspects. */
  aspects: AspectCategory[];
  /** Altitude relations: empty = all relations. */
  altitudeRelations: AltitudeRelation[];
  /** Shooter side/color: "" = all. */
  shooterSide: string;
  /** Shooter aircraft name: "" = all. */
  shooterAircraft: string;
  /** Target aircraft name: "" = all. */
  targetAircraft: string;
  /** Multi-word free text search. */
  searchText: string;
  /** Range filter in metres (null = unbounded). */
  minRangeM: number | null;
  maxRangeM: number | null;
  /** Altitude filter in metres (null = unbounded). */
  minShooterAltM: number | null;
  maxShooterAltM: number | null;
  minTargetAltM: number | null;
  maxTargetAltM: number | null;
  /** Include gun bursts (default false: focus on missiles/weapons). */
  includeGuns: boolean;
  /** Exclude friendly-fire incidents (default true). */
  excludeFriendlyFire: boolean;
  /** Require confirmed target (kill, hit, or explicit lock; exclude inferred miss targets). */
  confirmedTargetsOnly: boolean;
  /** Minimum attribution confidence. */
  minConfidence: "low" | "medium" | "high";
  /** Dynamic thresholds for Co-Altitude band and High/Low altitude floor. */
  thresholds: ClassificationThresholds;
}

export const DEFAULT_QUERY: AnalyticsQuery = {
  enabledFileIds: null,
  domains: ["A2A"],
  weaponClasses: [],
  weaponNames: [],
  aspects: [],
  altitudeRelations: [],
  shooterSide: "",
  shooterAircraft: "",
  targetAircraft: "",
  searchText: "",
  minRangeM: null,
  maxRangeM: null,
  minShooterAltM: null,
  maxShooterAltM: null,
  minTargetAltM: null,
  maxTargetAltM: null,
  includeGuns: false,
  excludeFriendlyFire: true,
  confirmedTargetsOnly: false,
  minConfidence: "low",
  thresholds: { ...DEFAULT_THRESHOLDS },
};

export interface ConditionCell {
  aspect: AspectCategory;
  altitudeRelation: AltitudeRelation;
  shots: number;
  hits: number;
  kills: number;
  /** Fraction of total matching kills (with known geometry) in this cell (0–1). */
  killShare: number;
  /** Fraction of total matching shots (with known geometry) in this cell (0–1). */
  shotShare: number;
  /** Kills / Shots in this cell, or null if shots === 0. */
  pk: number | null;
  meanKillRangeM: number | null;
  medianKillRangeM: number | null;
}

export interface CategorySummary<K extends string> {
  key: K;
  shots: number;
  hits: number;
  kills: number;
  killShare: number;
  shotShare: number;
  pk: number | null;
  meanKillRangeM: number | null;
  medianKillRangeM: number | null;
}

export interface RangeBin {
  index: number;
  minM: number;
  maxM: number;
  shots: number;
  hits: number;
  kills: number;
  pk: number | null;
  killsByAlt: Record<AltitudeRelation, number>;
  killsByAspect: Record<AspectCategory, number>;
  shotsByAlt: Record<AltitudeRelation, number>;
}

export interface WeaponSummary {
  weaponName: string;
  weaponClass: WeaponClass;
  shots: number;
  hits: number;
  kills: number;
  pk: number | null;
  meanKillRangeM: number | null;
  medianKillRangeM: number | null;
  minKillRangeM: number | null;
  maxKillRangeM: number | null;
}

export interface AircraftSummary {
  name: string;
  killsAsShooter: number;
  shotsAsShooter: number;
  lossesAsTarget: number;
}

export interface DatasetFacets {
  weapons: string[];
  shooterAircraft: string[];
  targetAircraft: string[];
  sides: string[];
}

export interface QueryResult {
  /** All engagements matching the query (with dynamic altitudeRelation applied). */
  engagements: MissileEngagement[];
  /** Subset of matching engagements where `isKill === true`. */
  kills: MissileEngagement[];
  kpis: {
    totalShots: number;
    shotsWithTarget: number;
    totalHits: number;
    totalKills: number;
    pk: number | null;
    medianKillRangeM: number | null;
    meanKillRangeM: number | null;
    p25KillRangeM: number | null;
    p75KillRangeM: number | null;
    minKillRangeM: number | null;
    maxKillRangeM: number | null;
    medianShotRangeM: number | null;
    medianFlightTimeS: number | null;
    dominantCondition: {
      aspect: AspectCategory;
      altitudeRelation: AltitudeRelation;
      kills: number;
      share: number;
    } | null;
  };
  /** 5x4 matrix of AspectCategory x AltitudeRelation. */
  matrix: ConditionCell[][];
  maxCellKills: number;
  maxCellShots: number;
  aspectBreakdown: CategorySummary<AspectCategory>[];
  altitudeBreakdown: CategorySummary<AltitudeRelation>[];
  rangeHistogram: RangeBin[];
  weaponBreakdown: WeaponSummary[];
  aircraftBreakdown: AircraftSummary[];
  facets: DatasetFacets;
}

const CONF_RANK: Record<"low" | "medium" | "high", number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0]!;
  const idx = (sortedValues.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return (sortedValues[lo] as number) * (1 - frac) + (sortedValues[hi] as number) * frac;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Apply dynamic thresholds to an engagement's initial condition. */
export function withThresholds(
  e: MissileEngagement,
  thresholds: ClassificationThresholds,
): MissileEngagement {
  if (!e.initial) return e;
  const altRel = classifyAltitudeRelation(
    e.shooter?.altM ?? null,
    e.target?.altM ?? null,
    thresholds,
  );
  if (altRel === e.initial.altitudeRelation) return e;
  return {
    ...e,
    initial: {
      ...e.initial,
      altitudeRelation: altRel,
    },
  };
}

function matchesSearch(e: MissileEngagement, q: string): boolean {
  if (!q.trim()) return true;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = [
    e.fileName,
    e.missionTitle,
    e.weaponName,
    e.weaponRawName,
    e.weaponClass,
    e.shooter?.pilot ?? "",
    e.shooter?.name ?? "",
    e.shooter?.side ?? "",
    e.target?.pilot ?? "",
    e.target?.name ?? "",
    e.target?.side ?? "",
    e.initial?.aspectCategory ?? "",
    e.initial?.altitudeRelation ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * Execute a multi-dimensional analytical query over a collection of `FileAnalytics`.
 *
 * `binStepM` controls the step size of the initial distance histogram (e.g., 5000 m for 5 km bins,
 * or `2 * 1852` for 2 nm bins).
 */
export function runAnalyticsQuery(
  files: FileAnalytics[],
  query: AnalyticsQuery,
  binStepM = 5000,
  binCount = 16,
): QueryResult {
  const enabledSet = query.enabledFileIds ? new Set(query.enabledFileIds) : null;
  const activeFiles = enabledSet ? files.filter((f) => enabledSet.has(f.fileId)) : files;

  // Collect facet options from active files (respecting only domain and gun toggles so dropdowns stay useful)
  const facetWeapons = new Set<string>();
  const facetShooters = new Set<string>();
  const facetTargets = new Set<string>();
  const facetSides = new Set<string>();

  const matching: MissileEngagement[] = [];
  const minConfRank = CONF_RANK[query.minConfidence];

  for (const f of activeFiles) {
    for (const rawEng of f.engagements) {
      if (!query.includeGuns && rawEng.isGun) continue;
      if (query.excludeFriendlyFire && rawEng.friendlyFire) continue;
      if (query.domains.length > 0 && !query.domains.includes(rawEng.domain)) continue;

      facetWeapons.add(rawEng.weaponName);
      if (rawEng.shooter?.name) facetShooters.add(rawEng.shooter.name);
      if (rawEng.target?.name) facetTargets.add(rawEng.target.name);
      if (rawEng.shooter?.side) facetSides.add(rawEng.shooter.side);
      if (rawEng.target?.side) facetSides.add(rawEng.target.side);

      const e = withThresholds(rawEng, query.thresholds);

      if (CONF_RANK[e.confidence] < minConfRank) continue;
      if (query.confirmedTargetsOnly && (e.targetSource === "inferred" || e.targetSource === "none")) {
        continue;
      }
      if (query.weaponClasses.length > 0 && !query.weaponClasses.includes(e.weaponClass)) continue;
      if (query.weaponNames.length > 0 && !query.weaponNames.includes(e.weaponName)) continue;
      if (query.shooterSide && e.shooter?.side !== query.shooterSide) continue;
      if (query.shooterAircraft && e.shooter?.name !== query.shooterAircraft) continue;
      if (query.targetAircraft && e.target?.name !== query.targetAircraft) continue;

      if (query.aspects.length > 0) {
        const a = e.initial?.aspectCategory ?? "unknown";
        if (!query.aspects.includes(a)) continue;
      }
      if (query.altitudeRelations.length > 0) {
        const ar = e.initial?.altitudeRelation ?? "unknown";
        if (!query.altitudeRelations.includes(ar)) continue;
      }

      if (query.minRangeM !== null) {
        if (!e.initial || e.initial.slantRangeM < query.minRangeM) continue;
      }
      if (query.maxRangeM !== null) {
        if (!e.initial || e.initial.slantRangeM > query.maxRangeM) continue;
      }
      if (query.minShooterAltM !== null) {
        if (e.shooter?.altM === null || e.shooter?.altM === undefined || e.shooter.altM < query.minShooterAltM)
          continue;
      }
      if (query.maxShooterAltM !== null) {
        if (e.shooter?.altM === null || e.shooter?.altM === undefined || e.shooter.altM > query.maxShooterAltM)
          continue;
      }
      if (query.minTargetAltM !== null) {
        if (e.target?.altM === null || e.target?.altM === undefined || e.target.altM < query.minTargetAltM)
          continue;
      }
      if (query.maxTargetAltM !== null) {
        if (e.target?.altM === null || e.target?.altM === undefined || e.target.altM > query.maxTargetAltM)
          continue;
      }

      if (!matchesSearch(e, query.searchText)) continue;

      matching.push(e);
    }
  }

  const kills = matching.filter((e) => e.isKill);
  const hits = matching.filter((e) => e.isHit);
  const shotsWithGeom = matching.filter((e) => e.initial !== null);
  const killsWithGeom = kills.filter((e) => e.initial !== null);

  const killRanges = killsWithGeom
    .map((e) => e.initial!.slantRangeM)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  const shotRanges = shotsWithGeom
    .map((e) => e.initial!.slantRangeM)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  const killFlightTimes = kills
    .map((e) => e.flightTimeS)
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);

  // Build 5 x 4 Matrix: ASPECT_ORDER x ALT_RELATION_ORDER
  const cellData = new Map<
    string,
    { shots: number; hits: number; kills: number; killRanges: number[] }
  >();
  for (const asp of ASPECT_ORDER) {
    for (const alt of ALT_RELATION_ORDER) {
      cellData.set(`${asp}|${alt}`, { shots: 0, hits: 0, kills: 0, killRanges: [] });
    }
  }

  for (const e of shotsWithGeom) {
    const ic = e.initial!;
    const key = `${ic.aspectCategory}|${ic.altitudeRelation}`;
    const slot = cellData.get(key);
    if (!slot) continue;
    slot.shots++;
    if (e.isHit) slot.hits++;
    if (e.isKill) {
      slot.kills++;
      slot.killRanges.push(ic.slantRangeM);
    }
  }

  const totalGeomKills = killsWithGeom.length;
  const totalGeomShots = shotsWithGeom.length;
  let maxCellKills = 0;
  let maxCellShots = 0;
  let dominantCondition: QueryResult["kpis"]["dominantCondition"] = null;

  const matrix: ConditionCell[][] = ASPECT_ORDER.map((aspect) =>
    ALT_RELATION_ORDER.map((altitudeRelation) => {
      const slot = cellData.get(`${aspect}|${altitudeRelation}`)!;
      slot.killRanges.sort((a, b) => a - b);
      if (slot.kills > maxCellKills) maxCellKills = slot.kills;
      if (slot.shots > maxCellShots) maxCellShots = slot.shots;
      const killShare = totalGeomKills > 0 ? slot.kills / totalGeomKills : 0;
      const shotShare = totalGeomShots > 0 ? slot.shots / totalGeomShots : 0;
      if (slot.kills > 0 && (!dominantCondition || slot.kills > dominantCondition.kills)) {
        dominantCondition = {
          aspect,
          altitudeRelation,
          kills: slot.kills,
          share: killShare,
        };
      }
      return {
        aspect,
        altitudeRelation,
        shots: slot.shots,
        hits: slot.hits,
        kills: slot.kills,
        killShare,
        shotShare,
        pk: slot.shots > 0 ? slot.kills / slot.shots : null,
        meanKillRangeM: mean(slot.killRanges),
        medianKillRangeM: percentile(slot.killRanges, 0.5),
      };
    }),
  );

  // Aspect breakdown
  const aspectBreakdown: CategorySummary<AspectCategory>[] = ASPECT_ORDER.map((aspect) => {
    let sCount = 0;
    let hCount = 0;
    let kCount = 0;
    const kRanges: number[] = [];
    for (const e of shotsWithGeom) {
      if (e.initial!.aspectCategory !== aspect) continue;
      sCount++;
      if (e.isHit) hCount++;
      if (e.isKill) {
        kCount++;
        kRanges.push(e.initial!.slantRangeM);
      }
    }
    kRanges.sort((a, b) => a - b);
    return {
      key: aspect,
      shots: sCount,
      hits: hCount,
      kills: kCount,
      killShare: totalGeomKills > 0 ? kCount / totalGeomKills : 0,
      shotShare: totalGeomShots > 0 ? sCount / totalGeomShots : 0,
      pk: sCount > 0 ? kCount / sCount : null,
      meanKillRangeM: mean(kRanges),
      medianKillRangeM: percentile(kRanges, 0.5),
    };
  });

  // Altitude relation breakdown
  const altitudeBreakdown: CategorySummary<AltitudeRelation>[] = ALT_RELATION_ORDER.map((alt) => {
    let sCount = 0;
    let hCount = 0;
    let kCount = 0;
    const kRanges: number[] = [];
    for (const e of shotsWithGeom) {
      if (e.initial!.altitudeRelation !== alt) continue;
      sCount++;
      if (e.isHit) hCount++;
      if (e.isKill) {
        kCount++;
        kRanges.push(e.initial!.slantRangeM);
      }
    }
    kRanges.sort((a, b) => a - b);
    return {
      key: alt,
      shots: sCount,
      hits: hCount,
      kills: kCount,
      killShare: totalGeomKills > 0 ? kCount / totalGeomKills : 0,
      shotShare: totalGeomShots > 0 ? sCount / totalGeomShots : 0,
      pk: sCount > 0 ? kCount / sCount : null,
      meanKillRangeM: mean(kRanges),
      medianKillRangeM: percentile(kRanges, 0.5),
    };
  });

  // Range Histogram
  const emptyAltMap = (): Record<AltitudeRelation, number> => ({
    "co-alt-high": 0,
    "co-alt-low": 0,
    "high-to-low": 0,
    "low-to-high": 0,
    unknown: 0,
  });
  const emptyAspMap = (): Record<AspectCategory, number> => ({
    "head-on": 0,
    "forward-quarter": 0,
    beam: 0,
    "rear-quarter": 0,
    "tail-on": 0,
    unknown: 0,
  });

  const rangeHistogram: RangeBin[] = Array.from({ length: binCount }, (_, index) => ({
    index,
    minM: index * binStepM,
    maxM: (index + 1) * binStepM,
    shots: 0,
    hits: 0,
    kills: 0,
    pk: null,
    killsByAlt: emptyAltMap(),
    killsByAspect: emptyAspMap(),
    shotsByAlt: emptyAltMap(),
  }));

  for (const e of shotsWithGeom) {
    const r = e.initial!.slantRangeM;
    if (!Number.isFinite(r) || r < 0) continue;
    const idx = Math.min(binCount - 1, Math.floor(r / binStepM));
    const bin = rangeHistogram[idx];
    if (!bin) continue;
    bin.shots++;
    bin.shotsByAlt[e.initial!.altitudeRelation]++;
    if (e.isHit) bin.hits++;
    if (e.isKill) {
      bin.kills++;
      bin.killsByAlt[e.initial!.altitudeRelation]++;
      bin.killsByAspect[e.initial!.aspectCategory]++;
    }
  }
  for (const bin of rangeHistogram) {
    bin.pk = bin.shots > 0 ? bin.kills / bin.shots : null;
  }

  // Weapon Breakdown
  const byWeapon = new Map<
    string,
    { weaponClass: WeaponClass; shots: number; hits: number; kills: number; killRanges: number[] }
  >();
  for (const e of matching) {
    let w = byWeapon.get(e.weaponName);
    if (!w) {
      w = { weaponClass: e.weaponClass, shots: 0, hits: 0, kills: 0, killRanges: [] };
      byWeapon.set(e.weaponName, w);
    }
    w.shots++;
    if (e.isHit) w.hits++;
    if (e.isKill) {
      w.kills++;
      if (e.initial) w.killRanges.push(e.initial.slantRangeM);
    }
  }
  const weaponBreakdown: WeaponSummary[] = [...byWeapon.entries()]
    .map(([weaponName, d]) => {
      d.killRanges.sort((a, b) => a - b);
      return {
        weaponName,
        weaponClass: d.weaponClass,
        shots: d.shots,
        hits: d.hits,
        kills: d.kills,
        pk: d.shots > 0 ? d.kills / d.shots : null,
        meanKillRangeM: mean(d.killRanges),
        medianKillRangeM: percentile(d.killRanges, 0.5),
        minKillRangeM: d.killRanges[0] ?? null,
        maxKillRangeM: d.killRanges[d.killRanges.length - 1] ?? null,
      };
    })
    .sort((a, b) => b.kills - a.kills || b.shots - a.shots || a.weaponName.localeCompare(b.weaponName));

  // Aircraft Breakdown
  const byAircraft = new Map<string, AircraftSummary>();
  const getAc = (name: string): AircraftSummary => {
    let a = byAircraft.get(name);
    if (!a) {
      a = { name, killsAsShooter: 0, shotsAsShooter: 0, lossesAsTarget: 0 };
      byAircraft.set(name, a);
    }
    return a;
  };
  for (const e of matching) {
    if (e.shooter?.name) {
      const ac = getAc(e.shooter.name);
      ac.shotsAsShooter++;
      if (e.isKill) ac.killsAsShooter++;
    }
    if (e.isKill && e.target?.name) {
      getAc(e.target.name).lossesAsTarget++;
    }
  }
  const aircraftBreakdown = [...byAircraft.values()].sort(
    (a, b) =>
      b.killsAsShooter - a.killsAsShooter ||
      b.shotsAsShooter - a.shotsAsShooter ||
      b.lossesAsTarget - a.lossesAsTarget,
  );

  return {
    engagements: matching,
    kills,
    kpis: {
      totalShots: matching.length,
      shotsWithTarget: shotsWithGeom.length,
      totalHits: hits.length,
      totalKills: kills.length,
      pk: matching.length > 0 ? kills.length / matching.length : null,
      medianKillRangeM: percentile(killRanges, 0.5),
      meanKillRangeM: mean(killRanges),
      p25KillRangeM: percentile(killRanges, 0.25),
      p75KillRangeM: percentile(killRanges, 0.75),
      minKillRangeM: killRanges[0] ?? null,
      maxKillRangeM: killRanges[killRanges.length - 1] ?? null,
      medianShotRangeM: percentile(shotRanges, 0.5),
      medianFlightTimeS: percentile(killFlightTimes, 0.5),
      dominantCondition,
    },
    matrix,
    maxCellKills,
    maxCellShots,
    aspectBreakdown,
    altitudeBreakdown,
    rangeHistogram,
    weaponBreakdown,
    aircraftBreakdown,
    facets: {
      weapons: [...facetWeapons].sort(),
      shooterAircraft: [...facetShooters].sort(),
      targetAircraft: [...facetTargets].sort(),
      sides: [...facetSides].sort(),
    },
  };
}
