import { describe, expect, it } from "vitest";
import { parseAcmi } from "../src/acmi/parser.ts";
import {
  analyzeNotchGate,
  analyzeShotTactics,
  compareCohorts,
  holmAdjust,
  type ShotTacticalMetrics,
} from "../src/analytics/derive.ts";
import {
  anonymizeDataset,
  engagementsToCsv,
  namespaceFileIds,
  parseDatasetBundle,
  serializeDatasetBundle,
} from "../src/analytics/export.ts";
import {
  classifyAltitudeRelation,
  classifyAspect,
  classifyWeapon,
  extractFileAnalytics,
  parseDcsVersion,
} from "../src/analytics/extract.ts";
import {
  DEFAULT_THRESHOLDS,
  type FileAnalytics,
  type MissileEngagement,
  TRACK_STRIDE,
} from "../src/analytics/model.ts";
import { DEFAULT_QUERY, runAnalyticsQuery } from "../src/analytics/query.ts";
import { ANALYTICS_SAMPLES } from "../src/analytics/samples.ts";
import { DEFAULT_MILSIM_TIMELINE, evaluateBvrTimeline } from "../src/analytics/timeline.ts";
import { fileChunks, sample } from "./helpers.ts";

const DEG_M = 111_319.5;

interface Ship {
  x: number;
  y: number;
  alt: number;
  vx: number;
  vy: number;
  vz?: number;
  hdg: number;
}

/** Build a synthetic ACMI recording where aircraft "1" launches missile "10" that destroys aircraft "2". */
async function syntheticKillRecording(
  shooter: Ship,
  target: Ship,
  weaponName = "AIM_120C",
  flightSeconds = 20,
) {
  const posLine = (id: string, s: Ship, t: number) => {
    const lon = (s.x + s.vx * t) / DEG_M;
    const lat = (s.y + s.vy * t) / DEG_M;
    const alt = s.alt + (s.vz ?? 0) * t;
    return `${id},T=${lon}|${lat}|${alt}|0|0|${s.hdg}`;
  };
  const tLaunch = 1;
  const tHit = tLaunch + flightSeconds;
  let body = "FileType=text/acmi/tacview\nFileVersion=2.2\n0,Title=Synthetic Engagement\n";
  for (let t = 0; t <= tHit + 2; t += 1) {
    body += `#${t}\n`;
    body += `${posLine("1", shooter, t)}${t === 0 ? ",Type=Air+FixedWing,Name=F-16C_50,Pilot=Alpha,Coalition=Allies,Color=Blue" : ""}\n`;
    if (t <= tHit) {
      body += `${posLine("2", target, t)}${t === 0 ? ",Type=Air+FixedWing,Name=Su-27,Pilot=Bandit,Coalition=Enemies,Color=Red" : ""}\n`;
    }
    if (t >= tLaunch && t <= tHit) {
      const f = (t - tLaunch) / flightSeconds;
      const sx = shooter.x + shooter.vx * tLaunch;
      const sy = shooter.y + shooter.vy * tLaunch;
      const sa = shooter.alt + (shooter.vz ?? 0) * tLaunch;
      const tx = target.x + target.vx * tHit;
      const ty = target.y + target.vy * tHit;
      const ta = target.alt + (target.vz ?? 0) * tHit;
      const wx = (sx + (tx - sx) * f) / DEG_M;
      const wy = (sy + (ty - sy) * f) / DEG_M;
      const wa = sa + (ta - sa) * f;
      body += `10,T=${wx}|${wy}|${wa}${t === tLaunch ? `,Type=Weapon+Missile,Name=${weaponName},Coalition=Allies,Color=Blue` : ""}\n`;
    }
    if (t === tHit) {
      body += "-10\n-2\n";
    }
  }
  const rec = await parseAcmi(
    (async function* () {
      yield new TextEncoder().encode(body);
    })(),
  );
  return extractFileAnalytics(rec, "synthetic.acmi");
}

describe("analytics: aspect & altitude classification rules", () => {
  it("classifies aspect angles into the 5 tactical buckets", () => {
    expect(classifyAspect(180)).toBe("head-on");
    expect(classifyAspect(155)).toBe("head-on");
    expect(classifyAspect(135)).toBe("forward-quarter");
    expect(classifyAspect(90)).toBe("beam");
    expect(classifyAspect(45)).toBe("rear-quarter");
    expect(classifyAspect(10)).toBe("tail-on");
    expect(classifyAspect(Number.NaN)).toBe("unknown");
  });

  it("classifies altitude relations for co-alt high, co-alt low, high-to-low, and low-to-high", () => {
    expect(classifyAltitudeRelation(10000, 10400, DEFAULT_THRESHOLDS)).toBe("co-alt-high");
    expect(classifyAltitudeRelation(1500, 2000, DEFAULT_THRESHOLDS)).toBe("co-alt-low");
    expect(classifyAltitudeRelation(9000, 3000, DEFAULT_THRESHOLDS)).toBe("high-to-low");
    expect(classifyAltitudeRelation(2000, 7500, DEFAULT_THRESHOLDS)).toBe("low-to-high");
  });

  it("computes initial conditions for synthetic head-on, high-to-low, and tail-chase kills", async () => {
    // 1. Head-on, Co-Altitude High (>30,000 ft / 9144 m), 20 km north at t=1
    const headOnHigh = await syntheticKillRecording(
      { x: 0, y: -250, alt: 10000, vx: 0, vy: 250, hdg: 0 },
      { x: 0, y: 20250, alt: 10200, vx: 0, vy: -250, hdg: 180 },
      "AIM_120C",
    );
    expect(headOnHigh.engagements.length).toBe(1);
    const e1 = headOnHigh.engagements[0]!;
    expect(e1.isKill).toBe(true);
    expect(e1.weaponClass).toBe("A2A-ARH");
    expect(e1.initial?.aspectCategory).toBe("head-on");
    expect(e1.initial?.altitudeRelation).toBe("co-alt-high");
    expect(e1.initial?.slantRangeM).toBeCloseTo(20000, -2);
    expect(e1.initial?.closureMs).toBeCloseTo(500, -1);

    // 2. Tail-on, High-to-Low, 5 km north at t=1
    const tailHighToLow = await syntheticKillRecording(
      { x: 0, y: -300, alt: 7000, vx: 0, vy: 300, hdg: 0 },
      { x: 0, y: 4800, alt: 2000, vx: 0, vy: 200, hdg: 0 },
      "AIM_9X",
      6,
    );
    const e2 = tailHighToLow.engagements[0]!;
    expect(e2.isKill).toBe(true);
    expect(e2.weaponClass).toBe("A2A-IR");
    expect(e2.initial?.aspectCategory).toBe("tail-on");
    expect(e2.initial?.altitudeRelation).toBe("high-to-low");
    expect(e2.initial?.altDiffM).toBeCloseTo(-5000, 0);
  });
});

describe("analytics: multi-file query across the 6 built-in sample recordings", async () => {
  const loaded = await Promise.all(
    ANALYTICS_SAMPLES.map(async (s) => {
      const fileName = s.file.replace(/^samples\//, "");
      const rec = await parseAcmi(fileChunks(sample(fileName)));
      return extractFileAnalytics(rec, s.originalName, 0, undefined, s.id);
    }),
  );

  it("extracts missile kills across all 4 altitude relations and all 5 aspect buckets", () => {
    const res = runAnalyticsQuery(loaded, DEFAULT_QUERY);
    expect(res.kpis.totalKills).toBeGreaterThanOrEqual(15);
    expect(res.kpis.totalShots).toBeGreaterThan(res.kpis.totalKills);

    // Matrix cell kills sum to total kills with known geometry
    const matrixKillSum = res.matrix.flat().reduce((sum, cell) => sum + cell.kills, 0);
    expect(matrixKillSum).toBe(res.kpis.totalKills);

    // Verify all 4 altitude relations are represented in the sample pack
    const altKills = Object.fromEntries(res.altitudeBreakdown.map((b) => [b.key, b.kills]));
    expect(altKills["co-alt-high"]).toBeGreaterThan(0);
    expect(altKills["co-alt-low"]).toBeGreaterThan(0);
    expect(altKills["high-to-low"]).toBeGreaterThan(0);
    expect(altKills["low-to-high"]).toBeGreaterThan(0);

    // Verify multiple aspect categories are represented
    const nonZeroAspects = res.aspectBreakdown.filter((b) => b.kills > 0);
    expect(nonZeroAspects.length).toBeGreaterThanOrEqual(4);
  });

  it("supports querying by initial condition (aspect, altitude relation, range, and weapon)", () => {
    const allRes = runAnalyticsQuery(loaded, DEFAULT_QUERY);

    // Filter to Head-on + Co-Alt High only
    const headOnHighRes = runAnalyticsQuery(loaded, {
      ...DEFAULT_QUERY,
      aspects: ["head-on"],
      altitudeRelations: ["co-alt-high"],
    });
    expect(headOnHighRes.kpis.totalKills).toBeGreaterThan(0);
    expect(headOnHighRes.kpis.totalKills).toBeLessThan(allRes.kpis.totalKills);
    expect(
      headOnHighRes.kills.every(
        (k) => k.initial?.aspectCategory === "head-on" && k.initial?.altitudeRelation === "co-alt-high",
      ),
    ).toBe(true);

    // Filter by minimum range >= 20 km (BVR kills)
    const bvrRes = runAnalyticsQuery(loaded, {
      ...DEFAULT_QUERY,
      minRangeM: 20000,
    });
    expect(bvrRes.kpis.totalKills).toBeGreaterThan(0);
    expect(bvrRes.kills.every((k) => (k.initial?.slantRangeM ?? 0) >= 20000)).toBe(true);

    // Filter by enabled subset of files
    const singleFileRes = runAnalyticsQuery(loaded, {
      ...DEFAULT_QUERY,
      enabledFileIds: ["f16-2v1-acm"],
    });
    expect(singleFileRes.kpis.totalKills).toBe(2); // 2 missile kills when includeGuns is false

    const singleFileWithGuns = runAnalyticsQuery(loaded, {
      ...DEFAULT_QUERY,
      enabledFileIds: ["f16-2v1-acm"],
      includeGuns: true,
    });
    expect(singleFileWithGuns.kpis.totalKills).toBe(3); // 2 missile kills + 1 gun kill
  });
});

describe("analytics: weapon taxonomy classifier", () => {
  const dummyObj = (name: string, tags: string[]) =>
    ({ name, tags }) as unknown as Parameters<typeof classifyWeapon>[0];
  const air = dummyObj("F-16C", ["Air", "FixedWing"]);
  const samSite = dummyObj("SA-15", ["Ground"]);

  it("identifies Fox-3, Fox-1, Fox-2, SAM, and A2G weapons", () => {
    expect(classifyWeapon(dummyObj("AIM_120C", ["Weapon", "Missile"]), air, air)).toBe("A2A-ARH");
    expect(classifyWeapon(dummyObj("SD-10", ["Weapon", "Missile"]), air, air)).toBe("A2A-ARH");
    expect(classifyWeapon(dummyObj("P_27PE", ["Weapon", "Missile"]), air, air)).toBe("A2A-SARH");
    expect(classifyWeapon(dummyObj("AIM_9X", ["Weapon", "Missile"]), air, air)).toBe("A2A-IR");
    expect(classifyWeapon(dummyObj("SA9M38M1", ["Weapon", "Missile"]), samSite, air)).toBe("SAM");
    expect(classifyWeapon(dummyObj("Mk_82", ["Weapon", "Bomb"]), air, samSite)).toBe("A2G");
  });

  it("extracts DCS patch versions, missile flyout kinematics, defeat modes, notch logistic fit, and CSV/JSON exports", async () => {
    expect(parseDcsVersion("DCS 2.9.15.9599")).toEqual({
      dcsVersion: "2.9.15.9599",
      dcsPatch: "2.9.15",
    });

    const loaded = await Promise.all(
      ANALYTICS_SAMPLES.map(async (s) => {
        const fileName = s.file.replace(/^samples\//, "");
        const rec = await parseAcmi(fileChunks(sample(fileName)));
        return extractFileAnalytics(rec, s.originalName, 0, undefined, s.id);
      }),
    );

    const res = runAnalyticsQuery(loaded, DEFAULT_QUERY);
    expect(res.facets.dcsPatches.length).toBeGreaterThanOrEqual(3);
    expect(res.engagements.some((e) => e.flight !== null && e.flight.maxMach > 1.5)).toBe(true);
    expect(res.engagements.some((e) => e.track !== null && e.track.n >= 5)).toBe(true);
    expect(res.defeatBreakdown.reduce((s, d) => s + d.count, 0)).toBe(res.engagements.length);
    expect(res.notchAnalysis.sampleSize).toBeGreaterThan(0);
    expect(res.pilotReports.length).toBeGreaterThan(0);

    const cohorts = compareCohorts(res.engagements, res.tacticsById, "dcsPatch");
    expect(cohorts.cohorts.length).toBeGreaterThanOrEqual(3);

    const csv = engagementsToCsv(res.engagements, res.tacticsById);
    expect(csv.split("\n").length).toBe(res.engagements.length + 1);

    const bundleJson = serializeDatasetBundle(loaded);
    const roundTrip = parseDatasetBundle(bundleJson);
    expect(roundTrip.length).toBe(loaded.length);
    expect(roundTrip[0]?.engagements.length).toBe(loaded[0]?.engagements.length);

    // Mil-Sim BVR Timeline statistical validation & Bayesian prior shrinkage
    const timelineEval = evaluateBvrTimeline(res.engagements, res.tacticsById, DEFAULT_MILSIM_TIMELINE, {
      priorWeight: 8,
    });
    expect(timelineEval["AR-2"].shots).toBeGreaterThan(0);
    expect(timelineEval["AR-2"].posteriorColumn.marNm).toBeGreaterThan(0);
    expect(timelineEval["AR-2"].posteriorColumn.morNm).toBeGreaterThan(
      timelineEval["AR-2"].posteriorColumn.marNm,
    );
    // When a tier has 0 engagements, posterior equals the Mil-Sim Chart prior
    const emptyEval = evaluateBvrTimeline([], new Map(), DEFAULT_MILSIM_TIMELINE, {
      priorWeight: 8,
    });
    expect(emptyEval["AR-2"].posteriorColumn).toEqual(DEFAULT_MILSIM_TIMELINE["AR-2"]);
  });
});

describe("analytics: dataset hygiene (dedup, anonymize, bundle IDs)", () => {
  const loadSample = async (): Promise<FileAnalytics> => {
    const s = ANALYTICS_SAMPLES[0]!;
    const rec = await parseAcmi(fileChunks(sample(s.file.replace(/^samples\//, ""))));
    return extractFileAnalytics(rec, s.originalName, 0, undefined, s.id);
  };
  const copyAs = (f: FileAnalytics, fileId: string): FileAnalytics => ({
    ...f,
    fileId,
    engagements: f.engagements.map((e) => ({ ...e, id: `${fileId}:${e.id}`, fileId })),
  });

  it("de-duplicates only among the files the user enabled", async () => {
    const base = await loadSample();
    const a = copyAs(base, "copy-a");
    const b = copyAs(base, "copy-b");
    const all = runAnalyticsQuery([a, b], DEFAULT_QUERY);
    expect(all.duplicateFileIds).toEqual(new Set(["copy-b"]));
    // Disabling the first copy must fall back to the second, not hide both.
    const onlyB = runAnalyticsQuery([a, b], { ...DEFAULT_QUERY, enabledFileIds: ["copy-b"] });
    expect(onlyB.duplicateFileIds.size).toBe(0);
    expect(onlyB.engagements.length).toBe(all.engagements.length);
    expect(onlyB.engagements.length).toBeGreaterThan(0);
  });

  it("anonymizes author and group names, is idempotent, and namespaces IDs", async () => {
    const base = await loadSample();
    const f: FileAnalytics = {
      ...base,
      meta: { ...base.meta, author: "123 TFS | SomeHandle" },
      engagements: base.engagements.map((e) => ({
        ...e,
        shooter: e.shooter ? { ...e.shooter, pilot: "RealPlayer", group: "123 TFS Flight" } : null,
      })),
    };
    const once = anonymizeDataset([f], { idPrefix: "r1:" });
    const twice = anonymizeDataset(once, { idPrefix: "r2:" });
    const json = serializeDatasetBundle(twice);
    expect(json).not.toContain("SomeHandle");
    expect(json).not.toContain("123 TFS");
    expect(json).not.toContain("RealPlayer");
    expect(once[0]?.fileId).toBe("r1:01");
    const pilots1 = once[0]?.engagements.map((e) => e.shooter?.pilot);
    const pilots2 = twice[0]?.engagements.map((e) => e.shooter?.pilot);
    expect(pilots2).toEqual(pilots1);

    const ns = namespaceFileIds(once, "sample");
    expect(ns[0]?.fileId).toBe("sample:r1:01");
    expect(ns[0]?.engagements.every((e) => e.fileId === "sample:r1:01" && e.id.startsWith("sample:"))).toBe(
      true,
    );
  });
});

describe("analytics: tactical statistics", () => {
  /** Missile from the origin flying north at 800 m/s; target 10 km north at 250 m/s on `targetHdg(t)`. */
  const syntheticShot = (targetHdg: (t: number) => number, isKill: boolean): MissileEngagement => {
    const dt = 0.5;
    const n = 12; // 5.5 s: the (non-homing) missile stays well short of the target
    const data = new Float32Array(n * TRACK_STRIDE).fill(Number.NaN);
    let tE = 0;
    let tN = 10_000;
    for (let k = 0; k < n; k++) {
      const t = k * dt;
      if (k > 0) {
        const h = (targetHdg(t) * Math.PI) / 180;
        tE += 250 * Math.sin(h) * dt;
        tN += 250 * Math.cos(h) * dt;
      }
      const b = k * TRACK_STRIDE;
      data[b] = 0;
      data[b + 1] = 800 * t;
      data[b + 2] = 8000;
      data[b + 3] = 800;
      data[b + 4] = tE;
      data[b + 5] = tN;
      data[b + 6] = 8000;
    }
    return {
      id: `syn:${isKill}`,
      isGun: false,
      isKill,
      outcome: isKill ? "kill" : "miss",
      weaponClass: "A2A-ARH",
      missDistanceM: null,
      initial: null,
      track: { dt, n, data, targetChaffS: [], targetFlareS: [], shooterChaffS: [], shooterFlareS: [] },
      flight: null,
    } as unknown as MissileEngagement;
  };

  it("does not count a target that was already running cold, without reacting, as a defense", () => {
    const tac = analyzeShotTactics(syntheticShot(() => 0, false));
    expect(tac.minMissileAspectDeg).toBeLessThan(5);
    expect(tac.reactionTimeS).toBeNull();
    expect(tac.defenseType).toBe("none");
    expect(tac.reactionRangeM).toBeNull();
  });

  it("classifies a turn to the beam after launch as a notch", () => {
    const tac = analyzeShotTactics(syntheticShot((t) => (t < 3 ? 0 : 90), false));
    expect(tac.reactionTimeS).not.toBeNull();
    expect(tac.defenseType).toBe("notch");
  });

  it("excludes kills and misses alike from the notch fit", () => {
    const kill = syntheticShot(() => 0, true);
    const miss = syntheticShot(() => 0, false);
    const coldTac = (id: string): ShotTacticalMetrics =>
      ({
        engagementId: id,
        defeatMode: "unknown",
        defenseType: "cold",
        minBeamOffsetDeg: 80,
        minRadialVelMs: 200,
        maxShooterCrankDeg: null,
      }) as ShotTacticalMetrics;
    const res = analyzeNotchGate(
      [kill, miss],
      new Map([
        [kill.id, coldTac(kill.id)],
        [miss.id, coldTac(miss.id)],
      ]),
    );
    expect(res.sampleSize).toBe(0);
  });

  it("Holm-adjusts p-values", () => {
    const adj = holmAdjust([0.01, 0.04, 0.03]);
    expect(adj[0]).toBeCloseTo(0.03, 10);
    expect(adj[1]).toBeCloseTo(0.06, 10);
    expect(adj[2]).toBeCloseTo(0.06, 10);
  });
});
