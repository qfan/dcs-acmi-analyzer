import { describe, expect, it } from "vitest";
import type { AcmiObject } from "../src/acmi/model.ts";
import { parseAcmi } from "../src/acmi/parser.ts";
import { analyze } from "../src/analysis/analyze.ts";
import { dist, Geo } from "../src/analysis/geo.ts";
import { buildMapData, MIN_SAMPLE_GAP_S, mapKind, pilotAt, sampleAt } from "../src/map/mapData.ts";
import { fitView, niceStep, pick, toScreen, toWorld } from "../src/map/render.ts";
import { fileChunks, sample } from "./helpers.ts";

describe("map data (2v1 sample)", async () => {
  const rec = await parseAcmi(fileChunks(sample("dcs-2021-f16-2v1-acm.zip.acmi")));
  const analysis = analyze(rec);
  const d = buildMapData(rec, analysis);
  const track = (id: string) => {
    const o = rec.objects.find((x) => x.id === id) as AcmiObject;
    const tr = d.tracks.find((t) => t.uid === o.uid);
    if (!tr) throw new Error(`no track for ${id}`);
    return tr;
  };

  it("keeps aircraft, missiles, ejected pilots and bullseyes, not bullets or debris", () => {
    const kinds = d.tracks.reduce<Record<string, number>>((m, t) => {
      m[t.kind] = (m[t.kind] ?? 0) + 1;
      return m;
    }, {});
    expect(kinds).toEqual({ air: 9, weapon: 3, chute: 3, bullseye: 3 });
  });

  it("thins samples to at most one per MIN_SAMPLE_GAP_S, keeping the last", () => {
    const tr = track("1401");
    for (let i = 1; i < tr.count; i++) {
      const gap = (d.times[tr.start + i] as number) - (d.times[tr.start + i - 1] as number);
      if (i < tr.count - 1) expect(gap).toBeGreaterThanOrEqual(MIN_SAMPLE_GAP_S - 1e-9);
    }
    const o = rec.objects.find((x) => x.id === "1401") as AcmiObject;
    const times = o.transform?.times ?? new Float64Array();
    expect(d.times[tr.start + tr.count - 1]).toBe(times[times.length - 1]);
  });

  // Distance between the player's F-16 and the MiG: from the map vs from full-resolution ECEF geometry.
  const compare = (t: number) => {
    const g = new Geo(rec);
    const f16 = rec.objects.find((x) => x.id === "1401") as AcmiObject;
    const mig = rec.objects.find((x) => x.id === "101") as AcmiObject;
    const truth = dist(g.pos(f16, t) as [number, number, number], g.pos(mig, t) as [number, number, number]);
    const a = sampleAt(d, track("1401"), t);
    const b = sampleAt(d, track("101"), t);
    const flat = Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
    // The map is 2D; add the altitude difference back to compare with the 3D distance.
    return { truth, map: Math.hypot(flat, (a?.alt ?? 0) - (b?.alt ?? 0)) };
  };

  it("projects distances to within 0.5% of the true (ellipsoidal) distance", () => {
    const { truth, map } = compare(40); // steady flight, ~2.8 km apart
    expect(Math.abs(map - truth) / truth).toBeLessThan(0.005);
  });

  it("keeps thinning error to a few tens of metres even in hard manoeuvres", () => {
    // At the AIM-9X launch the MiG is manoeuvring hard; interpolating 0.25 s samples costs ~15 m.
    // (Kill analysis always uses the full-resolution data, never the map's.)
    const { truth, map } = compare(62.55);
    expect(Math.abs(map - truth)).toBeLessThan(30);
  });

  it("interpolates, gives heading and speed, and returns nothing outside an object's life", () => {
    const tr = track("101");
    expect(sampleAt(d, tr, 10)).toBeNull(); // the MiG appears at 13.1 s
    expect(sampleAt(d, tr, 70)).toBeNull(); // gone at 65.68 s
    const s = sampleAt(d, tr, 40);
    expect(s?.speed).toBeGreaterThan(100);
    expect(s?.hdg).toBeGreaterThanOrEqual(0);
    expect(s?.hdg).toBeLessThan(360);
    // Missiles have no attitude in the file; heading comes from the direction of motion.
    const m = sampleAt(d, track("1e01"), 64);
    expect(Number.isFinite(m?.hdg)).toBe(true);
  });

  it("places the kills where the victims went down, and knows the pilot at a time", () => {
    expect(d.kills.map((k) => k.time)).toEqual([65.68, 121.23, 121.53]);
    const mig = sampleAt(d, track("101"), 65.68);
    expect(d.kills[0]?.x).toBeCloseTo(mig?.x ?? Number.NaN, 0);
    expect(pilotAt(track("1401"), 50)).toBe("QFAN");
  });
});

describe("map helpers", () => {
  it("classifies object kinds", () => {
    const k = (type: string) => mapKind({ tags: type.split("+") } as AcmiObject);
    expect(k("Air+FixedWing")).toBe("air");
    expect(k("Air+Rotorcraft")).toBe("heli");
    expect(k("Weapon+Missile")).toBe("weapon");
    expect(k("Projectile+Shell")).toBeNull();
    expect(k("Misc+Shrapnel")).toBeNull();
    expect(k("Ground+Light+Human+Air+Parachutist")).toBe("chute");
    expect(k("Navaid+Static+Bullseye")).toBe("bullseye");
    expect(k("Sea+Watercraft+AircraftCarrier")).toBe("sea");
    expect(k("Ground+Static+Aerodrome")).toBeNull();
  });

  it("converts between screen and world, fits views, and picks the nearest object", () => {
    const v = fitView({ minX: -5000, minY: -2000, maxX: 5000, maxY: 2000 }, 1000, 500);
    const [sx, sy] = toScreen(v, 1234, -567);
    const [wx, wy] = toWorld(v, sx, sy);
    expect(wx).toBeCloseTo(1234, 6);
    expect(wy).toBeCloseTo(-567, 6);
    expect(toScreen(v, 0, 0)).toEqual([500, 250]);
    expect(niceStep(130)).toBe(200);
    expect(niceStep(4100)).toBe(5000);
    expect(
      pick(
        [
          { uid: 1, sx: 10, sy: 10 },
          { uid: 2, sx: 30, sy: 10 },
        ],
        26,
        12,
      ),
    ).toBe(2);
    expect(pick([{ uid: 1, sx: 10, sy: 10 }], 100, 100)).toBeNull();
  });
});
