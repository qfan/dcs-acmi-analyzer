import { describe, expect, it } from "vitest";
import { DEFAULT_AUTOPAUSE, GameSession } from "../src/game/engine/session.ts";
import { buildSnapshot, SnapshotCursor, worldShape } from "../src/game/engine/snapshot.ts";
import { DEG, NM } from "../src/game/sim/atmosphere.ts";
import { cloneParams, DEFAULT_PARAMS } from "../src/game/sim/params.ts";
import { buildMultiplayer } from "../src/game/sim/scenarios.ts";
import { jetById } from "../src/game/sim/world.ts";
import {
  type GameView,
  initialMapRotation,
  panView,
  screenHeading,
  snapRotation,
  stepRotation,
  toggleNorthFlip,
  toScreen,
  toWorld,
  upHeadingDeg,
  zoomViewAt,
} from "../src/game/ui/camera.ts";
import { COLORS, drawScene, sideCol } from "../src/game/ui/draw.ts";
import { SessionView } from "../src/game/ui/view.ts";

function makeCanvasStub() {
  const noop = () => {};
  return {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    strokeText: noop,
    fillText: noop,
    setLineDash: noop,
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
  } as unknown as CanvasRenderingContext2D;
}

function makeDuelView(side: "blue" | "red"): SessionView {
  const params = cloneParams(DEFAULT_PARAMS);
  const world = buildMultiplayer("duel", params, 25000, 1, { B1: "human", R1: "human" });
  const session = new GameSession("duel", 25000, params, DEFAULT_AUTOPAUSE, 1, undefined, {
    world,
    record: false,
    sides: ["blue", "red"],
  });
  const snap = buildSnapshot(session, [side], new SnapshotCursor());
  return new SessionView(
    {
      mode: side === "blue" ? "host" : "guest",
      scenarioId: "duel",
      title: "Head-on duel",
      altFt: 25000,
      shape: worldShape(world),
      startedAt: session.startedAt.getTime(),
      side,
      owned: [side === "blue" ? "B1" : "R1"],
      watch: false,
      roomFog: true,
      canScale: false,
      pausesLeft: 5,
      noRecord: true,
    },
    snap,
    false,
  );
}

describe("game camera & rotation", () => {
  it("starts north-up for blue and south-up for red without changing side colors", () => {
    expect(initialMapRotation("blue")).toBe(0);
    expect(initialMapRotation("red")).toBe(Math.PI);
    expect(sideCol("blue")).toBe(COLORS.blue);
    expect(sideCol("red")).toBe(COLORS.red);
    expect(COLORS.blue).toBe("#4f9dff");
    expect(COLORS.red).toBe("#ff5a5f");
  });

  it("orients a head-on duel for red south-up with red at bottom facing up and right-turn going right", () => {
    const v: GameView = {
      cx: 0,
      cy: 35 * NM,
      scale: 0.003,
      w: 800,
      h: 600,
      rot: initialMapRotation("red"),
    };
    const [redSx, redSy] = toScreen(v, 0, 70 * NM);
    const [blueSx, blueSy] = toScreen(v, 0, 0);
    expect(redSx).toBeCloseTo(400, 6);
    expect(redSy).toBeGreaterThan(v.h / 2);
    expect(blueSx).toBeCloseTo(400, 6);
    expect(blueSy).toBeLessThan(v.h / 2);
    expect(screenHeading(Math.PI, v.rot)).toBeCloseTo(0, 6);

    // Flying south (180°), turning right heads west (x < 0), which must appear to the right on screen.
    const [westSx] = toScreen(v, -10 * NM, 70 * NM);
    expect(westSx).toBeGreaterThan(v.w / 2);
  });

  it("round-trips toScreen and toWorld across arbitrary angles", () => {
    const anglesDeg = [0, 37, 90, 135, 180, 270, 315];
    const pts = [
      [0, 0],
      [12345, -67890],
      [-55000, 91000],
      [42.5 * NM, 18.25 * NM],
    ] as const;

    for (const deg of anglesDeg) {
      const v: GameView = { cx: -4000, cy: 52000, scale: 0.0045, w: 1024, h: 768, rot: deg * DEG };
      for (const [wx, wy] of pts) {
        const [sx, sy] = toScreen(v, wx, wy);
        const [rx, ry] = toWorld(v, sx, sy);
        expect(rx).toBeCloseTo(wx, 6);
        expect(ry).toBeCloseTo(wy, 6);
      }
    }
  });

  it("pans in screen space along (+dx, +dy) regardless of rotation", () => {
    for (const deg of [0, 48, 90, 180, 270, 312]) {
      const v: GameView = { cx: 10000, cy: 25000, scale: 0.005, w: 900, h: 700, rot: deg * DEG };
      const wx = 18500;
      const wy = -9200;
      const [sx0, sy0] = toScreen(v, wx, wy);
      panView(v, 73, -41);
      const [sx1, sy1] = toScreen(v, wx, wy);
      expect(sx1 - sx0).toBeCloseTo(73, 6);
      expect(sy1 - sy0).toBeCloseTo(-41, 6);
    }
  });

  it("zooms while keeping the anchor point under the cursor fixed across rotations", () => {
    for (const deg of [0, 37, 135, 180, 270]) {
      const v: GameView = { cx: -12000, cy: 40000, scale: 0.004, w: 1000, h: 600, rot: deg * DEG };
      const sx = 280;
      const sy = 430;
      const [wx0, wy0] = toWorld(v, sx, sy);
      zoomViewAt(v, sx, sy, 1.75, true);
      const [sx1, sy1] = toScreen(v, wx0, wy0);
      expect(sx1).toBeCloseTo(sx, 6);
      expect(sy1).toBeCloseTo(sy, 6);
    }
  });

  it("steps, snaps (including wraparound near 0/360 and 15° snap), toggles north, and formats up heading", () => {
    expect(upHeadingDeg(0)).toBe(0);
    expect(upHeadingDeg(Math.PI)).toBe(180);
    expect(upHeadingDeg(359.9 * DEG)).toBe(0);

    let rot = 0;
    for (let i = 0; i < 24; i++) rot = stepRotation(rot, 15);
    expect(rot).toBeCloseTo(0, 10);
    expect(stepRotation(0, -45)).toBeCloseTo(315 * DEG, 10);

    expect(snapRotation(358.2 * DEG, false)).toBe(0);
    expect(snapRotation(1.9 * DEG, false)).toBe(0);
    expect(snapRotation(92.5 * DEG, false)).toBe(Math.PI / 2);
    expect(snapRotation(178.1 * DEG, false)).toBe(Math.PI);
    expect(snapRotation(271.5 * DEG, false)).toBe((3 * Math.PI) / 2);
    expect(snapRotation(22 * DEG, false)).toBeCloseTo(22 * DEG, 10);

    expect(snapRotation(22 * DEG, true)).toBeCloseTo(15 * DEG, 10);
    expect(snapRotation(355 * DEG, true)).toBe(0);

    expect(toggleNorthFlip(0)).toBe(Math.PI);
    expect(toggleNorthFlip(Math.PI)).toBe(0);
    expect(toggleNorthFlip(45 * DEG)).toBe(0);
  });

  it("drawScene projects hits using GameView rotation and keeps side colors unchanged", () => {
    const blueView = makeDuelView("blue");
    const redView = makeDuelView("red");
    const ctx = makeCanvasStub();

    for (const [sv, rot] of [
      [blueView, 0],
      [blueView, Math.PI / 3],
      [redView, Math.PI],
    ] as const) {
      const v: GameView = { cx: 0, cy: 35 * NM, scale: 0.003, w: 800, h: 600, rot };
      const hits = drawScene(ctx, v, sv, true, true, false);
      expect(hits.length).toBe(2);
      for (const h of hits) {
        const jet = jetById(sv.world, h.id);
        expect(jet).toBeDefined();
        if (!jet) continue;
        const [esx, esy] = toScreen(v, jet.pos.x, jet.pos.y);
        expect(h.sx).toBeCloseTo(esx, 6);
        expect(h.sy).toBeCloseTo(esy, 6);
      }
      const b1 = hits.find((h) => h.id === "B1");
      const r1 = hits.find((h) => h.id === "R1");
      expect(b1 && r1).toBeTruthy();
      if (b1 && r1) {
        if (rot === 0) expect(r1.sy).toBeLessThan(b1.sy);
        if (rot === Math.PI) expect(b1.sy).toBeLessThan(r1.sy);
      }
    }
    expect(sideCol("blue")).toBe("#4f9dff");
    expect(sideCol("red")).toBe("#ff5a5f");
  });
});
