import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import type { AcmiObject } from "../src/acmi/model.ts";
import { parseAcmi } from "../src/acmi/parser.ts";
import { analyze } from "../src/analysis/analyze.ts";
import { buildMapData } from "../src/map/mapData.ts";
import {
  attitude,
  buildFrame,
  fogRange,
  framingCamera,
  GRID_FADE_TO_PX,
  snapGridCentre,
  toWorld,
  visibleGridCells,
} from "../src/scene/frame.ts";
import { fileChunks, sample } from "./helpers.ts";

/** Nose and right-wing directions after applying an attitude. Model: nose −Z, right wing +X, up +Y. */
const axes = (hdg: number, pitch: number, roll: number) => {
  const q = attitude(hdg, pitch, roll);
  const r = (v: Vector3) =>
    v
      .applyQuaternion(q)
      .toArray()
      .map((c) => Math.round(c * 1000) / 1000 + 0);
  return { nose: r(new Vector3(0, 0, -1)), right: r(new Vector3(1, 0, 0)), up: r(new Vector3(0, 1, 0)) };
};

describe("3D orientation (X east, Y up, Z south)", () => {
  it("points the nose along the heading", () => {
    expect(axes(0, 0, 0).nose).toEqual([0, 0, -1]); // north
    expect(axes(90, 0, 0).nose).toEqual([1, 0, 0]); // east
    expect(axes(180, 0, 0).nose).toEqual([0, 0, 1]); // south
    expect(axes(270, 0, 0).nose).toEqual([-1, 0, 0]); // west
  });

  it("pitches the nose up for positive pitch", () => {
    const s = Math.round(Math.SQRT1_2 * 1000) / 1000;
    expect(axes(90, 45, 0).nose).toEqual([s, s, 0]);
  });

  it("drops the right wing for positive roll (the spec's convention)", () => {
    const a = axes(0, 0, 30);
    expect(a.right[1]).toBeLessThan(0); // right wing below the horizon
    expect(a.nose).toEqual([0, 0, -1]); // rolling does not move the nose
    expect(axes(0, 0, 180).up).toEqual([0, -1, 0]); // inverted
  });

  it("maps map coordinates to world coordinates", () => {
    expect(toWorld(100, 200, 300).toArray()).toEqual([100, 300, -200]);
    expect(toWorld(1, 2, Number.NaN).y).toBe(0); // ships have no altitude in DCS files
  });

  it("lists the grids clearly visible at the focus point, finer ones dropping out with distance", () => {
    // Metres per CSS pixel at the focus point: ~10 m in a dogfight, ~200 m over an engagement area,
    // ~2 km for the whole theatre.
    expect(visibleGridCells(10)).toEqual([1_000, 10_000, 50_000]);
    expect(visibleGridCells(200)).toEqual([10_000, 50_000]);
    expect(visibleGridCells(2_000)).toEqual([50_000]);
    expect(visibleGridCells(50_000)).toEqual([50_000]); // the coarsest is always listed
    // Nautical miles: 1, 10 and 50 nm cells.
    expect(visibleGridCells(10, 1852)).toEqual([1852, 18520, 92600]);
    expect(visibleGridCells(2_000, 1852)).toEqual([92600]);
    // Each grid is fully visible once its cells reach GRID_FADE_TO_PX on screen.
    expect(visibleGridCells(1_000 / GRID_FADE_TO_PX)[0]).toBe(1_000);
    expect(visibleGridCells(1_000 / GRID_FADE_TO_PX + 1)[0]).toBe(10_000);
    expect(snapGridCentre(12_345, 10_000)).toBe(10_000);
    expect(snapGridCentre(-26_000, 50_000)).toBe(-50_000);
    const near = fogRange(10_000);
    const far = fogRange(100_000);
    expect(far.near).toBeGreaterThan(near.near);
    expect(near.far).toBeGreaterThan(near.near);
  });

  it("frames a box from above and to the south", () => {
    const { target, position } = framingCamera(
      { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 },
      3000,
      50,
    );
    expect(target.toArray()).toEqual([0, 3000, -0]);
    expect(position.y).toBeGreaterThan(target.y);
    expect(position.z).toBeGreaterThan(0); // south of the target
  });
});

describe("3D frame building (2v1 sample)", async () => {
  const rec = await parseAcmi(fileChunks(sample("dcs-2021-f16-2v1-acm.zip.acmi")));
  const d = buildMapData(rec, analyze(rec));
  const white = (): [number, number, number] => [1, 1, 1];
  const uidOf = (id: string) => (rec.objects.find((o) => o.id === id) as AcmiObject).uid;

  it("places the live objects at time t, with altitude and the player's pilot name", () => {
    const f = buildFrame(d, 64, { trailS: 60, ground: true, primary: null, secondary: null }, white);
    const f16 = f.objects.find((o) => o.uid === uidOf("1401"));
    expect(f16?.kind).toBe("air");
    expect(f16?.alt).toBeGreaterThan(5000);
    expect(f16?.pos.y).toBe(f16?.alt);
    expect(f16?.label).toBe("QFAN F-16C_50");
    // The AIM-9X is in flight at 64 s.
    expect(f.objects.some((o) => o.uid === uidOf("1e01") && o.kind === "weapon")).toBe(true);
    // The MiG is gone after its kill.
    expect(
      buildFrame(d, 70, { trailS: 0, ground: true, primary: null, secondary: null }, white).objects.some(
        (o) => o.uid === uidOf("101"),
      ),
    ).toBe(false);
  });

  it("limits selected trails to the setting and drops the rest once a pair is selected", () => {
    const f16 = uidOf("1401");
    const mig = uidOf("101");
    const at = (primary: number | null, secondary: number | null) =>
      buildFrame(d, 64, { trailS: 15, ground: true, primary, secondary }, white).trail.count;
    // One selection: nothing changes, the selected aircraft is held to 15 s like the rest.
    expect(at(f16, null)).toBe(at(null, null));
    // A pair: fewer segments (only the two trails remain), but not none.
    const pair = at(f16, mig);
    expect(pair).toBeGreaterThan(0);
    expect(pair).toBeLessThan(at(null, null));
  });

  it("builds trail and drop-line segments as GPU-ready arrays", () => {
    const f = buildFrame(d, 64, { trailS: 15, ground: true, primary: null, secondary: null }, white);
    expect(f.trail.count % 2).toBe(0);
    expect(f.trail.positions.length).toBe(f.trail.count * 3);
    expect(f.trail.colors.length).toBe(f.trail.positions.length);
    // One drop line (2 vertices) per aircraft alive at 64 s, ending on the ground plane.
    const aircraft = f.objects.filter((o) => o.kind === "air" || o.kind === "heli").length;
    expect(f.drops.count).toBe(aircraft * 2);
    expect(f.drops.positions[4]).toBe(0);
    // Longer trails mean more segments.
    expect(
      buildFrame(d, 64, { trailS: 60, ground: true, primary: null, secondary: null }, white).trail.count,
    ).toBeGreaterThan(f.trail.count);
  });
});
