/** BVR Trainer game recordings are tagged at extraction and kept apart from DCS data in analytics. */
import { describe, expect, it } from "vitest";
import { parseAcmi } from "../src/acmi/parser.ts";
import { BVR_TRAINER_VERSION, detectRecordingSource } from "../src/acmi/source.ts";
import { compareCohorts } from "../src/analytics/derive.ts";
import { extractFileAnalytics } from "../src/analytics/extract.ts";
import { versionCohortKey } from "../src/analytics/model.ts";
import { DEFAULT_QUERY, isBvrTrainerFile, runAnalyticsQuery } from "../src/analytics/query.ts";
import { ANALYTICS_SAMPLES } from "../src/analytics/samples.ts";
import { DEFAULT_AUTOPAUSE, GameSession } from "../src/game/engine/session.ts";
import { NM } from "../src/game/sim/atmosphere.ts";
import { cloneParams, DEFAULT_PARAMS } from "../src/game/sim/params.ts";
import { command, jetById } from "../src/game/sim/world.ts";
import { fileChunks, sample } from "./helpers.ts";

async function* bytes(text: string) {
  yield new TextEncoder().encode(text);
}

/** Support drill at 35k: one AIM-120 fired at 30 nm that kills the drone. */
function gameFightText(): string {
  const s = new GameSession("support", 35000, cloneParams(DEFAULT_PARAMS), DEFAULT_AUTOPAUSE, 3);
  let fired = false;
  while (!s.world.outcome && s.world.t < 300) {
    const b = jetById(s.world, "B1");
    const r = jetById(s.world, "R1");
    if (b && r && !fired && Math.hypot(b.pos.x - r.pos.x, b.pos.y - r.pos.y) <= 30 * NM) {
      fired = command(s.world, { type: "fire", jetId: "B1", targetId: "R1" }) === null;
    }
    s.advance(0.25);
  }
  if (!s.recorder) throw new Error("expected recorder");
  return s.recorder.text();
}

describe("recording source detection", () => {
  it("tells game recordings from DCS ones", () => {
    expect(detectRecordingSource({ DataSource: "DCS 2.9.15.9599", DataRecorder: "Tacview 1.9.4" })).toEqual({
      kind: "sim",
      version: null,
    });
    expect(detectRecordingSource({})).toEqual({ kind: "sim", version: null });
    expect(
      detectRecordingSource({ DataSource: "BVR Trainer 1.0.0", DataRecorder: "BVR Trainer 1.0.0" }),
    ).toEqual({ kind: "bvr-trainer", version: "1.0.0" });
    // Files exported before versioning carry the bare name.
    expect(detectRecordingSource({ DataSource: "BVR Trainer" })).toEqual({
      kind: "bvr-trainer",
      version: null,
    });
    expect(detectRecordingSource({ DataRecorder: "BVR Trainer 2.1" })).toEqual({
      kind: "bvr-trainer",
      version: "2.1",
    });
  });

  it("puts game shots in their own version cohort, never a DCS patch", () => {
    expect(versionCohortKey({ dcsPatch: "2.9.15", source: "sim", sourceVersion: null })).toBe("2.9.15");
    expect(versionCohortKey({ dcsPatch: null })).toBe("Unknown Version");
    expect(versionCohortKey({ dcsPatch: null, source: "bvr-trainer", sourceVersion: "1.0.0" })).toBe(
      "BVR Trainer 1.0.0",
    );
    expect(versionCohortKey({ dcsPatch: null, source: "bvr-trainer", sourceVersion: null })).toBe(
      "BVR Trainer (pre-1.0)",
    );
  });
});

describe("analytics: BVR Trainer recordings stay out of DCS data", async () => {
  const text = gameFightText();
  const game = extractFileAnalytics(await parseAcmi(bytes(text)), "game.txt.acmi", 0, undefined, "game");
  const s = ANALYTICS_SAMPLES[0]!;
  const dcsRec = await parseAcmi(fileChunks(sample(s.file.replace(/^samples\//, ""))));
  const dcs = extractFileAnalytics(dcsRec, s.originalName, 0, undefined, s.id);

  it("the game writes its version into the header", () => {
    expect(text).toContain(`\n0,DataSource=BVR Trainer ${BVR_TRAINER_VERSION}\n`);
    expect(text).toContain(`\n0,DataRecorder=BVR Trainer ${BVR_TRAINER_VERSION}\n`);
    expect(BVR_TRAINER_VERSION).toBe("1.0.0");
  });

  it("tags the file and its shots, with no DCS version", () => {
    expect(game.meta?.source).toBe("bvr-trainer");
    expect(game.meta?.sourceVersion).toBe("1.0.0");
    expect(game.meta?.dcsVersion).toBeNull();
    expect(game.meta?.dcsPatch).toBeNull();
    expect(game.engagements.length).toBeGreaterThan(0);
    for (const e of game.engagements) {
      expect(e.source).toBe("bvr-trainer");
      expect(e.dcsPatch).toBeNull();
    }
    expect(isBvrTrainerFile(game)).toBe(true);
    expect(dcs.meta?.source).toBe("sim");
    expect(isBvrTrainerFile(dcs)).toBe(false);
  });

  it("leaves game files out by default and reports them", () => {
    const dcsOnly = runAnalyticsQuery([dcs], DEFAULT_QUERY);
    const res = runAnalyticsQuery([dcs, game], DEFAULT_QUERY);
    expect([...res.gameExcludedFileIds]).toEqual(["game"]);
    expect(res.kpis.totalShots).toBe(dcsOnly.kpis.totalShots);
    expect(res.engagements.some((e) => e.fileId === "game")).toBe(false);
    expect(res.facets.dcsPatches.some((p) => p.startsWith("BVR Trainer"))).toBe(false);
  });

  it("when included, groups game shots as their own cohort and filters by it", () => {
    const q = { ...DEFAULT_QUERY, includeBvrTrainer: true };
    const res = runAnalyticsQuery([dcs, game], q);
    expect(res.gameExcludedFileIds.size).toBe(0);
    expect(res.engagements.some((e) => e.fileId === "game")).toBe(true);
    expect(res.facets.dcsPatches).toContain("BVR Trainer 1.0.0");

    const { cohorts } = compareCohorts(res.engagements, res.tacticsById, "dcsPatch");
    const gameCohort = cohorts.find((c) => c.cohortKey === "BVR Trainer 1.0.0");
    expect(gameCohort?.label).toBe("BVR Trainer 1.0.0");
    expect(gameCohort?.fileCount).toBe(1);
    for (const c of cohorts) {
      if (c !== gameCohort) expect(c.label.startsWith("DCS ") || c.label.startsWith("Unknown")).toBe(true);
    }

    const onlyGame = runAnalyticsQuery([dcs, game], { ...q, dcsPatches: ["BVR Trainer 1.0.0"] });
    expect(onlyGame.engagements.length).toBeGreaterThan(0);
    expect(onlyGame.engagements.every((e) => e.fileId === "game")).toBe(true);
  });
});
