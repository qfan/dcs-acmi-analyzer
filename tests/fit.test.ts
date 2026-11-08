import { describe, expect, it } from "vitest";
import type { AcmiObject } from "../src/acmi/model.ts";
import { parseAcmi } from "../src/acmi/parser.ts";
import { analyze } from "../src/analysis/analyze.ts";
import { fitAt, SELECTED_RADIUS_M } from "../src/map/fit.ts";
import { buildMapData, sampleAt } from "../src/map/mapData.ts";
import { fileChunks, sample } from "./helpers.ts";

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
