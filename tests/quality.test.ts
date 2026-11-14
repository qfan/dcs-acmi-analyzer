import { describe, expect, it } from "vitest";
import { parseAcmi } from "../src/acmi/parser.ts";
import { Geo } from "../src/analysis/geo.ts";
import { extractFileAnalytics } from "../src/analytics/extract.ts";
import {
  assessFileQuality,
  countInWindow,
  engagementUfo,
  scanAircraftMotion,
} from "../src/analytics/quality.ts";
import { DEFAULT_QUERY, runAnalyticsQuery } from "../src/analytics/query.ts";
import { bytesChunks, fileChunks, sample } from "./helpers.ts";

const DEG_M = 111_320;
const DT = 0.2;

/**
 * `n` aircraft flying north at 250 m/s for `seconds`, sampled at 5 Hz. `warp(i, t)` returns a
 * sideways offset in metres for aircraft i at time t (0 = on its true path).
 */
async function flock(n: number, seconds: number, warp: (i: number, t: number) => number) {
  let body = "FileType=text/acmi/tacview\nFileVersion=2.2\n0,ReferenceTime=2026-01-01T00:00:00Z\n";
  const steps = Math.round(seconds / DT);
  for (let k = 0; k <= steps; k++) {
    const t = k * DT;
    body += `#${t.toFixed(2)}\n`;
    for (let i = 0; i < n; i++) {
      const lon = (i * 2000 + warp(i, t)) / DEG_M;
      const lat = (250 * t) / DEG_M;
      const props = k === 0 ? `,Type=Air+FixedWing,Name=F-16C_50,Pilot=P${i},Color=Blue` : "";
      body += `${(i + 1).toString(16)},T=${lon}|${lat}|8000${props}\n`;
    }
  }
  const rec = await parseAcmi(bytesChunks(new TextEncoder().encode(body), 4096));
  const geo = new Geo(rec);
  const motion = scanAircraftMotion(rec, geo);
  return { rec, geo, motion, quality: assessFileQuality(rec, geo, motion, [], 0) };
}

/** Every `period` seconds, one sample jumps `metres` sideways (lag zig-zag). */
const hiccups =
  (period: number, metres: number, from = 20) =>
  (t: number) => {
    const phase = (t - from) % period;
    return t >= from && Math.abs(phase) < 1e-6 ? metres : 0;
  };

describe("UFO detection", () => {
  it("smooth flight, including a hard 9 g turn, has no off-path samples", async () => {
    // Circle at 250 m/s with 9 g radial acceleration: radius = v²/a ≈ 708 m.
    const r = (250 * 250) / (9 * 9.80665);
    const { quality } = await flock(1, 120, (_i, t) => r * Math.sin((250 / r) * t));
    expect(quality.offPathSamples).toBe(0);
    expect(quality.ufoLevel).toBe("none");
    expect(quality.flags).not.toContain("ufo-some");
  });

  it("one warping aircraft is 'ufo-some', not mass", async () => {
    const hic = hiccups(15, 600);
    const { quality, motion } = await flock(6, 300, (i, t) => (i === 2 ? hic(t) : 0));
    expect(quality.ufoLevel).toBe("some");
    expect(quality.flags).toContain("ufo-some");
    expect(quality.heavyAircraft).toBe(1);
    expect(quality.aircraft[0]?.pilot).toBe("P2");
    expect([...motion.values()].filter((m) => m.times.length > 0)).toHaveLength(1);
  });

  it("everyone warping at the same moments is 'ufo-mass'", async () => {
    const hic = hiccups(20, 400);
    const { quality } = await flock(8, 300, (_i, t) => hic(t));
    expect(quality.ufoLevel).toBe("mass");
    expect(quality.flags).toContain("ufo-mass");
    expect(quality.massWindows).toBeGreaterThanOrEqual(3);
  });

  it("a single short blip is only minor", async () => {
    const { quality } = await flock(4, 300, (i, t) => (i === 0 && Math.abs(t - 100) < 1e-6 ? 300 : 0));
    expect(quality.ufoLevel).toBe("minor");
    expect(quality.flags.filter((f) => f.startsWith("ufo"))).toEqual([]);
  });

  it("counts off-path samples inside a shot window", async () => {
    const hic = hiccups(15, 600);
    const { motion } = await flock(2, 200, (i, t) => (i === 0 ? hic(t) : 0));
    const shooter = [...motion.values()][0];
    const target = [...motion.values()][1];
    const during = engagementUfo({ launchTime: 30, endTime: 60, killTime: null, flightTimeS: 30 }, shooter, [
      target,
    ]);
    expect(during.shooter).toBeGreaterThan(0);
    expect(during.target).toBe(0);
    const times = shooter?.times ?? [];
    expect(countInWindow(times, 0, 10)).toBe(0);
  });
});

describe("quality labels on a real sample", () => {
  it("labels content and the shot-level switch removes only UFO shots", async () => {
    const name = "dcs-2025-f18-vs-jf17-bvr-hi.zip.acmi";
    const rec = await parseAcmi(fileChunks(sample(name)));
    const fa = extractFileAnalytics(rec, name);
    expect(fa.quality).toBeDefined();
    expect(fa.quality?.ufoLevel).toBe("none");

    // Mark one A2A shot as UFO-affected and check the per-shot switch.
    const a2a = fa.engagements.filter((e) => e.domain === "A2A" && !e.isGun);
    expect(a2a.length).toBeGreaterThan(0);
    const victim = a2a[0];
    if (!victim) throw new Error("no shot");
    victim.ufo = { shooter: 3, target: 0 };
    const all = runAnalyticsQuery([fa], DEFAULT_QUERY);
    const clean = runAnalyticsQuery([fa], { ...DEFAULT_QUERY, excludeUfoShots: true });
    expect(clean.engagements.length).toBe(all.engagements.length - 1);
    expect(clean.ufoExcludedShots).toBe(1);

    // File-level label exclusion.
    const flag = fa.quality?.flags[0];
    if (flag) {
      const dropped = runAnalyticsQuery([fa], { ...DEFAULT_QUERY, excludeQualityFlags: [flag] });
      expect(dropped.engagements).toHaveLength(0);
      expect(dropped.qualityExcludedFileIds.has(fa.fileId)).toBe(true);
    }
  });
});
