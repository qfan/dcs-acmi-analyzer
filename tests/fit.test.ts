import { describe, expect, it } from "vitest";
import type { AcmiObject } from "../src/acmi/model.ts";
import { parseAcmi } from "../src/acmi/parser.ts";
import { analyze } from "../src/analysis/analyze.ts";
import { AcmiRecorder } from "../src/game/acmi.ts";
import { DEFAULT_PARAMS } from "../src/game/sim/params.ts";
import { scenarioById } from "../src/game/sim/scenarios.ts";
import { fitAt, SELECTED_RADIUS_M } from "../src/map/fit.ts";
import {
  buildMapData,
  firstActivity,
  type MapData,
  type MapKind,
  type MapTrack,
  sampleAt,
} from "../src/map/mapData.ts";
import { bytesChunks, fileChunks, sample } from "./helpers.ts";

const NONE = { primary: null, secondary: null };

describe("Fit target (2v1 sample)", async () => {
  const rec = await parseAcmi(fileChunks(sample("dcs-2021-f16-2v1-acm.zip.acmi")));
  const d = buildMapData(rec, analyze(rec));
  const track = (id: string) => {
    const uid = (rec.objects.find((o) => o.id === id) as AcmiObject).uid;
    const tr = d.tracks.find((t) => t.uid === uid);
    if (!tr) throw new Error(id);
    return tr;
  };

  it("centres on the selected object when it exists at that time", () => {
    const mig = track("101");
    const f = fitAt(d, 40, { primary: mig.uid, secondary: null });
    const s = sampleAt(d, mig, 40);
    expect(f.basis).toBe("selected");
    expect(f.x).toBe(s?.x);
    expect(f.y).toBe(s?.y);
    expect(f.radius).toBe(SELECTED_RADIUS_M);
  });

  it("falls back to everything alive when the selected object isn't there yet / any more", () => {
    expect(fitAt(d, 5, { primary: track("101").uid, secondary: null }).basis).toBe("alive"); // MiG appears at 13.1 s
    expect(fitAt(d, 100, { primary: track("101").uid, secondary: null }).basis).toBe("alive"); // shot down at 65.68 s
  });

  it("frames the fight, not the far-off AWACS", () => {
    // At 64 s: E-3A (~100 km away), two F-16s, the MiG, and the AIM-9X in flight.
    const f = fitAt(d, 64, NONE);
    expect(f.basis).toBe("alive");
    expect(f.count).toBe(5);
    const awacs = sampleAt(d, track("1201"), 64);
    const mig = sampleAt(d, track("101"), 64);
    const distTo = (p: { x: number; y: number } | null) => Math.hypot((p?.x ?? 0) - f.x, (p?.y ?? 0) - f.y);
    expect(distTo(mig)).toBeLessThan(f.radius);
    expect(distTo(awacs)).toBeGreaterThan(f.radius);
    expect(f.radius).toBeLessThan(40_000);
    expect(f.alt).toBeGreaterThan(4000); // fight altitude, for the 3D camera
  });

  it("frames the two F-16s at the start, not the AWACS 100 km away", () => {
    const f = fitAt(d, 0.5, NONE); // E-3A + two F-16s alive
    expect(f.count).toBe(3);
    const awacs = sampleAt(d, track("1201"), 0.5);
    const f16 = sampleAt(d, track("1401"), 0.5);
    expect(Math.hypot((f16?.x ?? 0) - f.x, (f16?.y ?? 0) - f.y)).toBeLessThan(f.radius);
    expect(Math.hypot((awacs?.x ?? 0) - f.x, (awacs?.y ?? 0) - f.y)).toBeGreaterThan(f.radius);
  });

  it("frames the primary/secondary pair around their midpoint", () => {
    const f16 = track("1401");
    const mig = track("101");
    const f = fitAt(d, 60, { primary: f16.uid, secondary: mig.uid });
    const a = sampleAt(d, f16, 60);
    const b = sampleAt(d, mig, 60);
    expect(f.basis).toBe("pair");
    expect(f.x).toBeCloseTo(((a?.x ?? 0) + (b?.x ?? 0)) / 2, 3);
    expect(f.radius).toBeGreaterThan(Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0)) / 2);
    // Only one of the pair exists (MiG gone at 65.68 s): centre on the one that's left.
    expect(fitAt(d, 70, { primary: f16.uid, secondary: mig.uid }).basis).toBe("selected");
  });

  it("uses the whole recording's area when nothing exists at that time", () => {
    const f = fitAt(d, 10_000, NONE);
    expect(f.basis).toBe("recording");
    expect(f.radius).toBeGreaterThan(0);
  });
});

interface SyntheticUnit {
  kind?: MapKind;
  side: string;
  name: string;
  x: number;
  y: number;
  alt?: number;
}

function makeSyntheticMapData(units: SyntheticUnit[]): MapData {
  const n = units.length;
  const times = new Float64Array(n);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const alt = new Float32Array(n);
  const hdg = new Float32Array(n);
  const roll = new Float32Array(n);
  const pitch = new Float32Array(n);
  const tracks: MapTrack[] = units.map((u, i) => {
    times[i] = 0;
    x[i] = u.x;
    y[i] = u.y;
    alt[i] = u.alt ?? 7_500;
    return {
      uid: i + 1,
      kind: u.kind ?? "air",
      side: u.side,
      name: u.name,
      pilots: [],
      t0: 0,
      t1: 100,
      removed: false,
      start: i,
      count: 1,
    };
  });
  return {
    lon0: 0,
    lat0: 0,
    timeStart: 0,
    timeEnd: 100,
    tracks,
    times,
    x,
    y,
    alt,
    hdg,
    roll,
    pitch,
    kills: [],
    focus: { minX: -10_000, minY: -10_000, maxX: 10_000, maxY: 10_000 },
  };
}

describe("Fit target (full-picture opposing sides)", () => {
  it("frames both blue and red jets in the BVR Trainer 2v1 recording", async () => {
    const w = scenarioById("2v1").build(DEFAULT_PARAMS, 25_000, 1);
    const recorder = new AcmiRecorder({ title: "2v1", startedAt: new Date("2026-01-01T00:00:00Z") });
    recorder.update(w);
    const bytes = new TextEncoder().encode(recorder.text());
    const rec = await parseAcmi(bytesChunks(bytes, 4096));
    const d = buildMapData(rec, analyze(rec));

    const t0 = firstActivity(d);
    const f = fitAt(d, t0, NONE);
    expect(f.basis).toBe("alive");
    expect(f.count).toBe(3);

    const bluePts = d.tracks.filter((tr) => tr.side === "Blue").map((tr) => sampleAt(d, tr, t0));
    const redPts = d.tracks.filter((tr) => tr.side === "Red").map((tr) => sampleAt(d, tr, t0));
    expect(bluePts).toHaveLength(2);
    expect(redPts).toHaveLength(1);
    for (const pt of [...bluePts, ...redPts]) {
      expect(pt).not.toBeNull();
      expect(Math.hypot((pt?.x ?? 0) - f.x, (pt?.y ?? 0) - f.y)).toBeLessThan(f.radius);
    }
    const blueMidY = ((bluePts[0]?.y ?? 0) + (bluePts[1]?.y ?? 0)) / 2;
    const redY = redPts[0]?.y ?? 0;
    expect(f.y).toBeCloseTo((blueMidY + redY) / 2, -1);
  });

  it("centres asymmetric 5v3 BVR flights between both sides", async () => {
    const rec = await parseAcmi(fileChunks(sample("dcs-2025-bvr-mission1-prep.zip.acmi")));
    const d = buildMapData(rec, analyze(rec));
    const t0 = firstActivity(d);
    const f = fitAt(d, t0, NONE);

    expect(f.basis).toBe("alive");
    expect(f.count).toBe(8);
    expect(f.radius).toBeLessThan(120_000);
    for (const tr of d.tracks) {
      if (tr.kind !== "air") continue;
      const pt = sampleAt(d, tr, t0);
      expect(pt).not.toBeNull();
      expect(Math.hypot((pt?.x ?? 0) - f.x, (pt?.y ?? 0) - f.y)).toBeLessThan(f.radius);
    }
  });

  it("frames blue and red fighters while leaving out a distant friendly AWACS", () => {
    const d = makeSyntheticMapData([
      { side: "Blue", name: "F-16C_50", x: -3_000, y: 0 },
      { side: "Blue", name: "F-16C_50", x: 3_000, y: 0 },
      { side: "Red", name: "MiG-29S", x: 0, y: 100_000 },
      { side: "Blue", name: "E-3A", x: 0, y: -120_000 },
    ]);
    const f = fitAt(d, 0, NONE);
    const distOf = (uid: number) => {
      const tr = d.tracks.find((t) => t.uid === uid) as MapTrack;
      const s = sampleAt(d, tr, 0);
      return Math.hypot((s?.x ?? 0) - f.x, (s?.y ?? 0) - f.y);
    };
    expect(distOf(1)).toBeLessThan(f.radius);
    expect(distOf(2)).toBeLessThan(f.radius);
    expect(distOf(3)).toBeLessThan(f.radius);
    expect(distOf(4)).toBeGreaterThan(f.radius);
  });

  it("keeps a support-only opposing side (HVAA) in view", () => {
    const d = makeSyntheticMapData([
      { side: "Red", name: "MiG-29S", x: -2_000, y: 0 },
      { side: "Red", name: "MiG-29S", x: 2_000, y: 0 },
      { side: "Blue", name: "E-3A", x: 0, y: 100_000 },
    ]);
    const f = fitAt(d, 0, NONE);
    for (const tr of d.tracks) {
      const s = sampleAt(d, tr, 0);
      expect(Math.hypot((s?.x ?? 0) - f.x, (s?.y ?? 0) - f.y)).toBeLessThan(f.radius);
    }
  });

  it("trims distant strays within a large group on one side without dropping the other side", () => {
    const blues: SyntheticUnit[] = Array.from({ length: 12 }, (_, i) => ({
      side: "Blue",
      name: "FA-18C_hornet",
      x: (i - 5.5) * 1_000,
      y: 0,
    }));
    const stray: SyntheticUnit = { side: "Blue", name: "FA-18C_hornet", x: 400_000, y: 0 };
    const red: SyntheticUnit = { side: "Red", name: "FA-18C_hornet", x: 0, y: 100_000 };
    const d = makeSyntheticMapData([...blues, stray, red]);
    const f = fitAt(d, 0, NONE);

    const distOf = (uid: number) => {
      const tr = d.tracks.find((t) => t.uid === uid) as MapTrack;
      const s = sampleAt(d, tr, 0);
      return Math.hypot((s?.x ?? 0) - f.x, (s?.y ?? 0) - f.y);
    };
    for (let uid = 1; uid <= 12; uid++) expect(distOf(uid)).toBeLessThan(f.radius);
    expect(distOf(13)).toBeGreaterThan(f.radius); // 400 km stray Blue jet
    expect(distOf(14)).toBeLessThan(f.radius); // opposing Red jet
  });
});
